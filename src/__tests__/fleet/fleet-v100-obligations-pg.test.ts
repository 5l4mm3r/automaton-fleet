/**
 * Schema v100 (PostgreSQL; the agent's own API through its credential): a buyer's request is an obligation until it is
 * resolved, and the agent's refusals carry their reasons.
 *
 *  - the proof's case: a buyer message on a paid, delivered order, no answer → UNANSWERED (the earlier delivery does not
 *    resolve a later request), in the attention view on every read;
 *  - the agent's answer → ACKNOWLEDGED, and it does not change eventsDigest (an answer never wakes the agent again); a new
 *    buyer message → UNANSWERED again and the digest changes;
 *  - resolved by a delivery made after the request and sent (in progress while queued), or by order_message
 *    {resolved: true}; `resolved` must be a boolean; a resolving message is the agent's on an order only;
 *  - an enquiry's buyer message is unanswered until the agent replies;
 *  - the purchase-proof watchdog's SQL (taken verbatim from scripts/fleet-purchase-proof.sh) stops on exactly this case,
 *    counts the quiet period from the resume, and agrees with the obligation's state;
 *  - mind.report keeps up to 10 refusals with scrubbed, bounded reasons; a FLEET_PLATFORM_FAULT raises ONE AMBER
 *    AGENT_TOOL_FAULT a day per agent, with the reason.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { PgIdentityGateway } from "../../fleet/identity/gateway.js";
import { IdentityBroker } from "../../fleet/identity/broker.js";
import { SimulatedSharedMailProvider } from "../../fleet/identity/providers.js";
import { initIdentityState, openIdentityState, openProviderVault } from "../../fleet/identity/main.js";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, autoCapabilityChecks, OWNER, econNext, READY_RUNTIME, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { liveRail } from "./fixtures/custody-signer.js";
import { moneyProblems } from "../../fleet/founder/money.js";

const PG_BIN = findPgBin();
const SCRIPT = fs.readFileSync(path.join(process.cwd(), "scripts/fleet-purchase-proof.sh"), "utf8");
const WATCHDOG_FN = SCRIPT.slice(SCRIPT.indexOf("unanswered_sql() {"), SCRIPT.indexOf("\n}\n", SCRIPT.indexOf("unanswered_sql() {")) + 3);

describe.skipIf(!PG_BIN)("v100 customer obligations and refusal reasons (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let F: Founder;
  let su: pg.Pool;
  let orderId = "", enquiryId = "", dir = "";
  let igw: PgIdentityGateway;
  let broker: IdentityBroker;
  const obligations = async () => (await R.one<any>(`fleet.fleet_agent_attention($1)`, [F.id])).customerObligations as Array<Record<string, any>>;
  const digest = async () => (await R.one<any>(`fleet.fleet_agent_attention($1)`, [F.id])).eventsDigest as string;
  const buyer = async (minutesAgo: number, body = "The renewal dates show as numbers") =>
    R.q(`INSERT INTO fleet.fleet_customer_messages (agent_id, order_id, author, body, created_at) VALUES ($1, $2, 'buyer', $3, now() - make_interval(mins => $4))`, [F.id, orderId, body, minutesAgo]);
  const watchdog = async (resumed: string) => {
    const sql = execFileSync("bash", ["-c", `${WATCHDOG_FN}\nQUIET_MIN=30\nunanswered_sql "$1" "$2"`, "watchdog", orderId, resumed], { encoding: "utf8" });
    expect(sql).toContain("GREATEST(b.created_at,");
    return (await su.query(sql)).rows[0].exists as boolean;
  };
  // v113: what a delivery carries — its files (by hash) and the review it went out on. A revision answers the buyer only when its
  // files changed and its review showed the required change on the page (a passing required_content check).
  const review = async (order: string, requiredContent: "pass" | "fail" | null, met: string[] = []) => (await R.q(`INSERT INTO fleet.fleet_artifact_reviews (agent_id, subject, order_id, files,
      files_digest, inspector, automated, automated_ok, criteria, verdict)
    VALUES ($1, 'order', $2, '[{"name":"tracker.pdf"}]', repeat('d', 64), 'fleet-qa-3', $3::jsonb, $4, $6::jsonb, $5) RETURNING review_id`,
    [F.id, order, JSON.stringify({ ok: requiredContent !== "fail", files: [{ path: "tracker.pdf", checks: requiredContent ? [{ id: "required_content", status: requiredContent }] : [] }] }),
      requiredContent !== "fail", requiredContent !== "fail" ? "pass" : "fail",
      JSON.stringify([...met.map((m) => ({ criterion: m, met: true, evidence: "checked on the delivered page" })), { c: 1 }, { c: 2 }, { c: 3 }])]))[0].review_id as string;
  // v115: the agent classifies a post-delivery buyer message; Fleet Control's verdict is recorded by the controller's worker.
  const classify = (order: string, messageId: string, classification: string, extra: Record<string, unknown> = {}) =>
    R.econ(F, "order.classify", { orderId: order, messageId, classification, reason: "test classification", ...extra });
  const checkVerdict = async (messageId: string, verdict: string, confidence: number, purpose = "conversation") => {
    const [k] = await R.q(`SELECT check_id FROM fleet.fleet_message_checks WHERE message_id = $1 AND purpose = $2`, [messageId, purpose]);
    return R.one(`fleet.svc_message_check_record($1, 'test-worker', $2::jsonb)`, [k.check_id, JSON.stringify({ verdict, confidence, evidence: "test", calls: [] })]);
  };
  const lastBuyerId = async (order: string) => (await R.q(`SELECT message_id FROM fleet.fleet_customer_messages WHERE order_id = $1 AND author = 'buyer' ORDER BY created_at DESC LIMIT 1`, [order]))[0].message_id as string;
  const delivery = async (status: string, minutesAgo: number, x: { order?: string; file?: string; reviewId?: string } = {}) => {
    const rows = await R.q(`INSERT INTO fleet.fleet_order_deliveries (order_id, agent_id, idempotency_key, subject, body, status, created_at, sent_at, review_id)
      VALUES ($1, $2, $3, 'Your corrected tracker', 'Attached.', $4, now() - make_interval(mins => $5), CASE WHEN $4 = 'sent' THEN now() END, $6) RETURNING delivery_id`,
      [x.order ?? orderId, F.id, `test:${crypto.randomUUID()}`, status, minutesAgo, x.reviewId ?? null]);
    if (x.file) await R.q(`INSERT INTO fleet.fleet_order_delivery_files (delivery_id, file_no, file_name, content_type, size_bytes, content_sha256)
      VALUES ($1, 1, 'tracker.pdf', 'application/pdf', 100, $2)`, [rows[0].delivery_id, crypto.createHash("sha256").update(x.file).digest("hex")]);
    return rows;
  };

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, simulatedSettlement: false });
    autoCapabilityChecks(R);
    [F] = R.founders;
    su = new pg.Pool({ connectionString: R.pgc.superUrl.replace(/\/postgres$/, `/${R.pgc.dbname}`), max: 1, options: "-c search_path=fleet -c default_transaction_read_only=on" });
    await liveRail(R.owner, "fleet", OWNER, { capabilities: ["payouts", "receive_payments", "refunds"] });
    expect((await R.econ(F, "venture.create", { key: "landlord", model: "digital_product", offer: "tracker", state: "selected" })).ok).toBe(true);
    // Fleet email (the shared mailbox, simulated) and the agent's routing address: what an answer to a buyer goes through.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v100-"));
    fs.chmodSync(dir, 0o700);
    initIdentityState(dir);
    igw = new PgIdentityGateway({ connectionString: R.pgc.identityUrl });
    const { vault, ownerVault } = openIdentityState(dir);
    broker = new IdentityBroker(igw, vault, { mail: new SimulatedSharedMailProvider("fleet@shared.fleet-mail.test"), ownerVault, providerVault: openProviderVault(dir),
      stateFile: path.join(dir, "pending.json") });
    await broker.tick();
    const mbx = await R.econ(F, "mailbox.provision", { ventureKey: "landlord", idempotencyKey: `mbx:${crypto.randomUUID()}` });
    expect(mbx.ok, JSON.stringify(mbx)).toBe(true);
    const o = await R.econ(F, "offer.create", { venture: "landlord", kind: "service", title: "Compliance tracker set-up", summary: "I set up your tracker.",
      description: "Tell me your properties; I build the tracker.", deliverables: ["A tracker"], priceMinor: 500, turnaroundDays: 3, terms: "Refunds if it is wrong." });
    const k = await R.one(`fleet.fleet_econ_paypal_checkout($1, $2::jsonb)`, [F.id, JSON.stringify({ venture: "landlord", amountMinor: 500, description: "Tracker",
      idempotencyKey: `t:${crypto.randomBytes(8).toString("hex")}` })]);
    orderId = (await R.q(`INSERT INTO fleet.fleet_customer_orders (agent_id, venture_id, checkout_id, item, amount_minor, currency, fulfilment, access_token, origin_hash, offer_id, buyer_email)
      SELECT agent_id, venture_id, checkout_id, description, amount_minor, currency, 'digital_file', $2, encode(sha256('buyer'::bytea), 'hex'), $3, 'owner@example.test'
        FROM fleet.fleet_paypal_checkouts WHERE checkout_id = $1 RETURNING order_id`, [k.checkout.checkoutId, crypto.randomBytes(32).toString("hex"), o.offer.offerId]))[0].order_id;
    enquiryId = (await R.q(`INSERT INTO fleet.fleet_offer_enquiries (offer_id, agent_id, access_token, buyer_name, buyer_email, brief)
      VALUES ($1, $2, $3, 'Ada', 'ada@example.test', 'Can it track EICR renewals?') RETURNING enquiry_id`, [o.offer.offerId, F.id, crypto.randomBytes(32).toString("hex")]))[0].enquiry_id;
  }, 300_000);
  afterAll(async () => {
    await su?.end(); await igw?.close(); await R?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the proof's case: delivered first, then the buyer's fault report — unanswered, on every read, and the watchdog stops on it", async () => {
    await delivery("sent", 60);                                     // the first delivery (18:39) …
    expect(await obligations()).toEqual([]);
    await buyer(50);                                                // … then the fault report (19:13)
    const [ob] = await obligations();
    expect(ob).toMatchObject({ kind: "order", id: orderId, state: "unanswered", buyerMessages: 1, revisionOwed: true });   // after the delivery
    expect(ob.repliedAt).toBeUndefined();
    expect((await obligations())[0]).toEqual(ob);                   // state, not news: the same on the next read
    // The watchdog: 50 minutes unanswered while running → stop; resumed 10 minutes ago (after an owner pause) → not yet.
    expect(await watchdog(new Date(Date.now() - 120 * 60_000).toISOString())).toBe(true);
    expect(await watchdog(new Date(Date.now() - 10 * 60_000).toISOString())).toBe(false);
    // Model calls are no answer (the old watchdog counted them).
    await R.q(`INSERT INTO fleet.fleet_cognition_log (request_id, agent_id, provider, model, outcome, input_tokens, output_tokens, cost_microcents, charged_cents, prompt_sha256, response_sha256, payer)
      VALUES ($1, $2, 'anthropic', 'claude-sonnet-5-5', 'ok', 1, 1, 1, 0, repeat('a', 64), repeat('b', 64), 'agent')`, [crypto.randomUUID(), F.id]).catch(() => undefined);
    expect(await watchdog(new Date(Date.now() - 120 * 60_000).toISOString())).toBe(true);
  });

  it("an answer acknowledges without changing the wake digest; a new buyer message is unanswered again and does change it", async () => {
    const before = await digest();
    const r = await econNext(R, F, "order.message", { orderId, message: "Thank you — I have your report and am correcting the dates now." });
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, resolves: false, obligation: { state: "acknowledged" } });
    expect((await obligations())[0]).toMatchObject({ state: "acknowledged", repliedAt: expect.any(String), revisionOwed: true });   // answered is not delivered
    expect(await digest()).toBe(before);
    expect(await watchdog(new Date(Date.now() - 120 * 60_000).toISOString())).toBe(false);
    await buyer(0, "Any news?");                                     // after the answer (each statement its own now())
    expect((await obligations())[0]).toMatchObject({ state: "unanswered", buyerMessages: 2 });
    expect(await digest()).not.toBe(before);
    expect(await econNext(R, F, "order.message", { orderId, message: "Working on it.", resolved: "yes" })).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
  });

  it("v115: a fault report becomes an established correction, fulfilled by a delivery whose review lists its outcome; a question completes once checked", async () => {
    // The fault report ("The renewal dates show as numbers") and "Any news?" (earlier tests) are unclassified: owed work.
    const [fault, news] = (await R.q(`SELECT message_id FROM fleet.fleet_customer_messages WHERE order_id = $1 AND author = 'buyer' ORDER BY created_at`, [orderId])).map((m) => m.message_id);
    expect((await obligations())[0]).toMatchObject({ revisionOwed: true, work: { classify: [fault, news] } });
    const OUTCOME = "The renewal dates show as dates, not numbers";
    expect(await classify(orderId, fault, "correction", { criteria: [{ outcome: OUTCOME, kind: "change" }] })).toMatchObject({ ok: true, classification: "correction" });
    expect(await classify(orderId, news, "conversation")).toMatchObject({ ok: true, classification: "conversation" });
    // The agent's own read (customers obligations) carries the same work: the runtime's revision review reads the correction
    // and its criteria from it at review time (owner, 24 Oct: phrases only where a correction declared them).
    expect((await R.econ(F, "customer.obligations", {})).obligations.find((x: any) => x.id === orderId))
      .toMatchObject({ work: { corrections: [expect.objectContaining({ sourceMessageId: fault, criteria: [{ outcome: OUTCOME, kind: "change" }] })] } });
    const [d] = await delivery("queued", 0, { file: "corrected tracker", reviewId: await review(orderId, "pass", [OUTCOME]) });
    expect((await obligations())[0]).toMatchObject({ delivering: true, work: { corrections: [expect.objectContaining({ criteria: [{ outcome: OUTCOME, kind: "change" }] })] } });
    await R.q(`UPDATE fleet.fleet_order_deliveries SET status = 'sent', sent_at = now() WHERE delivery_id = $1`, [d.delivery_id]);
    expect(await obligations()).toEqual([]);                                           // fulfilled; "Any news?" waits for its check (deferred, not owed)
    await checkVerdict(news, "no_change", 0.95);
    expect(await obligations()).toEqual([]);
    // A question: the agent classifies it a conversation and answers; resolved: true completes it once Fleet Control confirms.
    await buyer(0, "One more question: does it cover Wales?");
    const q = await lastBuyerId(orderId);
    expect((await obligations())[0]).toMatchObject({ state: "unanswered", revisionOwed: true, work: { classify: [q] } });
    await classify(orderId, q, "conversation");
    expect(await econNext(R, F, "order.message", { orderId, message: "It covers England only; Wales has different rules.", resolved: true }))
      .toMatchObject({ ok: true, resolves: true });
    expect(await obligations()).toEqual([]);                                           // check pending: deferred, nothing owed, nothing asked
    await checkVerdict(q, "no_change", 0.9);
    expect(await obligations()).toEqual([]);
    await expect(R.q(`INSERT INTO fleet.fleet_customer_messages (agent_id, order_id, author, body, resolves) VALUES ($1, $2, 'buyer', 'x', true)`, [F.id, orderId]))
      .rejects.toThrow(/fleet_customer_messages_resolves_agent/);
  });

  it("an enquiry's buyer message is unanswered until the agent replies", async () => {
    await R.q(`INSERT INTO fleet.fleet_customer_messages (agent_id, enquiry_id, author, body) VALUES ($1, $2, 'buyer', 'Does it handle HMOs?')`, [F.id, enquiryId]);
    expect(await obligations()).toEqual([expect.objectContaining({ kind: "enquiry", id: enquiryId, state: "unanswered" })]);
    expect((await econNext(R, F, "enquiry.reply", { enquiryId, message: "Yes: one row per room." })).ok).toBe(true);
    expect(await obligations()).toEqual([]);
  });

  it("v101: the e-mail carrying the agent's answer finishes sending without waking it; a send that fails does wake it", async () => {
    await buyer(0, "Is this the final version?");
    const before = await digest();                                   // the buyer's message is news: it changed the digest already
    const r = await econNext(R, F, "order.message", { orderId, message: "Yes — this is the final, corrected version." });
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    const job = async () => (await R.q(`SELECT j.job_id, j.status FROM fleet.fleet_identity_jobs j JOIN fleet.fleet_customer_messages c ON j.kind = 'mail.send'
      AND j.params ->> 'messageId' = c.mail_message_id::text WHERE c.message_id = $1`, [r.messageId]))[0] as { job_id: string; status: string } | undefined;
    for (let i = 0; i < 10 && (await job())?.status !== "succeeded"; i++) await broker.tick();
    expect((await job())?.status).toBe("succeeded");                 // the e-mail went out …
    expect(await digest()).toBe(before);                             // … and that is the agent's own action, not news
    await R.q(`UPDATE fleet.fleet_identity_jobs SET status = 'failed' WHERE job_id = $1`, [(await job())!.job_id]);
    expect(await digest()).not.toBe(before);                         // a message that did not go out is news
    const ev = (await R.one<any>(`fleet.fleet_agent_attention($1)`, [F.id])).recentEvents as Array<Record<string, unknown>>;
    expect(ev).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "job_finished", status: "failed", tool: "identity" })]));
  });

  it("mind.report keeps the turn's refusals with scrubbed, bounded reasons; a platform fault tells the owner once a day", async () => {
    const refusals = [
      { tool: "deliverable", code: "FLEET_PLATFORM_FAULT", reason: "the inspector stopped without a valid report (killed by signal 31 — a system call this host's sandbox does not allow)" },
      { tool: "sleep", code: "FLEET_CUSTOMER_UNANSWERED", reason: `a buyer is waiting: key 0x${"ab".repeat(32)} at https://user:hunter2@example.test/x ${"x".repeat(400)}` },
      ...Array.from({ length: 12 }, (_, i) => ({ tool: "exec", code: i === 0 ? "not a code" : "FLEET_TOOL_ERROR", reason: `r${i}` })),
    ];
    expect(await R.econ(F, "mind.report", { packet: "full", outcome: "answered the buyer", tools: ["deliverable", "sleep"], refusals })).toMatchObject({ ok: true });
    const [row] = await R.q(`SELECT refusals FROM fleet.fleet_agent_mind_reports WHERE agent_id = $1 ORDER BY at DESC LIMIT 1`, [F.id]);
    expect(row.refusals).toHaveLength(10);
    expect(row.refusals[0]).toEqual(refusals[0]);
    expect(row.refusals[1].reason.length).toBeLessThanOrEqual(300);
    expect(row.refusals[1].reason).not.toMatch(/hunter2|abababab/);   // fleet_scrub, again at the controller
    expect(row.refusals[2].code).toBe("FLEET_UNKNOWN");
    expect(await R.econ(F, "mind.report", { packet: "full", outcome: "again", tools: [], refusals: refusals.slice(0, 1) })).toMatchObject({ ok: true });
    const n = await R.q(`SELECT class, title, detail FROM fleet.fleet_notifications WHERE code = 'AGENT_TOOL_FAULT' AND agent_id = $1`, [F.id]);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ class: "AMBER", detail: { tool: "deliverable", reason: refusals[0].reason } });
    // A report without refusals is unchanged (an empty list).
    expect(await R.econ(F, "mind.report", { packet: "slim", outcome: "resting", tools: ["sleep"] })).toMatchObject({ ok: true });
    expect((await R.q(`SELECT refusals FROM fleet.fleet_agent_mind_reports WHERE agent_id = $1 ORDER BY at DESC LIMIT 1`, [F.id]))[0].refusals).toEqual([]);
  });

  // ── v105: platform-calculated pricing, quotes and invoices ────────────────────────────────────────────────────────
  const price = (items: unknown, fees: unknown = null, tax: unknown = null, ccy = "GBP") =>
    R.one<any>(`fleet.fleet_price_lines($1, $2::jsonb, $3::jsonb, $4::jsonb)`, [ccy, JSON.stringify(items), fees === null ? null : JSON.stringify(fees), tax === null ? null : JSON.stringify(tax)]);

  it("v105 pricing: quantities, discounts, fixed and percentage fees, exclusive and inclusive tax — one rounding rule (half-up to the minor unit)", async () => {
    // 500p + 101p = 601p, as two lines.
    expect(await price([{ description: "Usage", quantity: 1, unitMinor: 500 }, { description: "Tax and fees on the credit", quantity: 1, unitMinor: 101 }]))
      .toMatchObject({ currency: "GBP", exponent: 2, subtotalMinor: 601, totalMinor: 601 });
    // 3 × £2.50 less 10% = £6.75; 1.5 × £3.33 = 4.995 → £5.00 (half-up); a 2.9% fee of the subtotal (£11.75 → 34.075 → 34p) + 30p fixed.
    const p1 = await price([{ description: "Tracker set-up", quantity: 3, unitMinor: 250, discountBp: 1000 }, { description: "Extra hours", quantity: 1.5, unitMinor: 333 }],
      [{ label: "Card fee", bp: 290 }, { label: "Handling", minor: 30 }]);
    expect(p1.lines.map((l: any) => [l.grossMinor, l.discountMinor, l.lineMinor])).toEqual([[750, 75, 675], [500, 0, 500]]);
    expect(p1).toMatchObject({ subtotalMinor: 1175, feesMinor: 64, totalMinor: 1239 });
    expect(p1.fees.map((f: any) => f.minor)).toEqual([34, 30]);
    expect(p1.text).toBe(["- Tracker set-up: 3 × £2.50 = £7.50, less 10% discount (£0.75) = £6.75", "- Extra hours: 1.5 × £3.33 = £5.00", "Subtotal: £11.75",
      "Card fee (2.9% of the subtotal): £0.34", "Handling: £0.30", "Total: £12.39"].join("\n"));
    // The pre-send checker (money.ts) agrees with the platform's own rendering, line by line.
    expect(moneyProblems(p1.text, [p1.totalMinor])).toEqual([]);
    const taxed = await price([{ description: "Workbook", quantity: 2, unitMinor: 1999, discountBp: 1500 }], [{ label: "Card fee", bp: 290 }], { label: "VAT", bp: 2000 });
    expect(moneyProblems(taxed.text, [taxed.totalMinor]), taxed.text).toEqual([]);
    const incl = await price([{ description: "Workbook", quantity: 1, unitMinor: 1000 }], null, { label: "VAT", bp: 2000, inclusive: true });
    expect(moneyProblems(incl.text, [incl.totalMinor]), incl.text).toEqual([]);
    // VAT 20% added (exclusive), and included (shown, not added): £10.00 incl. VAT → £1.67.
    expect(await price([{ description: "Workbook", quantity: 1, unitMinor: 1000 }], null, { label: "VAT", bp: 2000 })).toMatchObject({ totalMinor: 1200, tax: { minor: 200, inclusive: false } });
    expect(await price([{ description: "Workbook", quantity: 1, unitMinor: 1000 }], null, { label: "VAT", bp: 2000, inclusive: true })).toMatchObject({ totalMinor: 1000, tax: { minor: 167, inclusive: true } });
    // Currencies: only those the records use (GBP accounting; USD from the exchange rates); USD has 2 decimals.
    const cur = (await R.one<any>(`fleet.fleet_supported_currencies()`)) as Array<{ code: string; exponent: number; payments: boolean }>;
    expect(cur).toEqual(expect.arrayContaining([{ code: "GBP", exponent: 2, payments: true }]));
    expect(await R.one(`fleet.fleet_currency_exponent('JPY')`)).toBe(0);
    expect(await R.one(`fleet.fleet_currency_exponent('KWD')`)).toBe(3);
    expect(await R.one(`fleet.fleet_money_text(123456, 'GBP')`)).toBe("£1,234.56");
    expect(await R.code(price([{ description: "x", quantity: 1, unitMinor: 1 }], null, null, "INR"))).toBe("FLEET_BAD_REQUEST");          // not a currency of the records
    // Malformed input fails closed.
    for (const bad of [[{ description: "x", unitMinor: 100 }], [{ description: "x", quantity: "2", unitMinor: 100 }], [{ description: "x", quantity: 1, unitMinor: 1.5 }],
      [{ description: "x", quantity: 1.2345, unitMinor: 100 }], [{ description: "", quantity: 1, unitMinor: 100 }], [{ description: "x", quantity: 1, unitMinor: 100, discountBp: 10001 }], []]) {
      expect(await R.code(price(bad)), JSON.stringify(bad)).toBe("FLEET_BAD_REQUEST");
    }
    expect(await R.code(price([{ description: "x", quantity: 1, unitMinor: 100 }], [{ label: "fee", minor: 10, bp: 100 }]))).toBe("FLEET_BAD_REQUEST");   // one of minor or bp
  });

  it("v105 quote: the platform calculates the price from the agent's line items, records it on the order and renders it to the buyer; a typed price that differs is refused", async () => {
    const enq = (await R.q(`INSERT INTO fleet.fleet_offer_enquiries (offer_id, agent_id, access_token, buyer_name, buyer_email, brief)
      SELECT offer_id, agent_id, $2, 'Ada', 'ada@example.test', 'Two trackers and an hour of set-up, please.' FROM fleet.fleet_offer_enquiries WHERE enquiry_id = $1 RETURNING enquiry_id`,
      [enquiryId, crypto.randomBytes(32).toString("hex")]))[0].enquiry_id as string;
    const items = [{ description: "Landlord tracker", quantity: 2, unitMinor: 250 }, { description: "Set-up call", quantity: 1, unitMinor: 300, discountBp: 5000 }];
    const wrong = await R.econ(F, "enquiry.quote", { enquiryId: enq, scope: "Two trackers and a set-up call", items, priceMinor: 700, turnaroundDays: 2 });
    expect(wrong).toMatchObject({ ok: false, code: "FLEET_PRICE_MISMATCH", computedMinor: 650 });
    expect(wrong.reason).toContain("the line items come to £6.50, not £7.00");
    const q = await R.econ(F, "enquiry.quote", { enquiryId: enq, scope: "Two trackers and a set-up call", items, turnaroundDays: 2 });
    expect(q, JSON.stringify(q)).toMatchObject({ ok: true, order: { amountMinor: 650 } });
    expect((await R.q(`SELECT pricing ->> 'totalMinor' AS t FROM fleet.fleet_customer_orders WHERE order_id = $1`, [q.order.orderId]))[0].t).toBe("650");
    const body = (await R.q(`SELECT body FROM fleet.fleet_customer_messages WHERE enquiry_id = $1 AND author = 'agent' ORDER BY created_at DESC LIMIT 1`, [enq]))[0].body as string;
    expect(body).toContain("- Landlord tracker: 2 × £2.50 = £5.00\n- Set-up call: 1 × £3.00 = £3.00, less 50% discount (£1.50) = £1.50\nSubtotal: £6.50\nTotal: £6.50");
    // The invoice is the record's: the same lines and total; nothing paid yet.
    const inv = await R.econ(F, "order.invoice", { orderId: q.order.orderId });
    expect(inv).toMatchObject({ ok: true, invoice: { amountMinor: 650, paidMinor: 0, refundedMinor: 0, currency: "GBP" } });
    expect(inv.invoice.text).toMatch(/^INVOICE INV-[0-9A-F]{10}\nIssued: .*\nSeller: .*\nBilled to: Ada\n/);
    expect(inv.invoice.text).toContain("Total: £6.50\n\nPaid: £0.00 (awaiting payment)");
    expect(moneyProblems(body, [650]), body).toEqual([]);
    expect(moneyProblems(inv.invoice.text, [650, 0]), inv.invoice.text).toEqual([]);
    // money.price: the same calculation without quoting.
    expect(await R.econ(F, "money.price", { items })).toMatchObject({ ok: true, pricing: { totalMinor: 650, subtotalMinor: 650 } });
    expect(await R.econ(F, "money.currencies", {})).toMatchObject({ ok: true, currencies: expect.arrayContaining([expect.objectContaining({ code: "GBP", payments: true })]) });
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });

  it("v111: none is hidden — 11 older unanswered enquiries and a paid order's newer message: the order comes first and all 12 are listed", async () => {
    for (let i = 0; i < 11; i++) {
      const e = (await R.q(`INSERT INTO fleet.fleet_offer_enquiries (offer_id, agent_id, access_token, buyer_name, buyer_email, brief)
        SELECT offer_id, agent_id, $2, 'Bo', 'bo@example.test', 'Is the tracker still available this month?' FROM fleet.fleet_offer_enquiries WHERE enquiry_id = $1 RETURNING enquiry_id`,
        [enquiryId, crypto.randomBytes(32).toString("hex")]))[0].enquiry_id;
      await R.q(`INSERT INTO fleet.fleet_customer_messages (agent_id, enquiry_id, author, body, created_at) VALUES ($1, $2, 'buyer', 'Is it still available?', now() - make_interval(hours => $3))`,
        [F.id, e, 30 + i]);
    }
    await buyer(0, "The PDF export is blank — please fix it");                       // the paid order's newest message (after every reply)
    const list = await obligations();
    const unanswered = list.filter((o) => o.state === "unanswered");
    expect(unanswered.length).toBeGreaterThanOrEqual(12);                              // v100 returned 10: the order was cut
    expect(list[0]).toMatchObject({ kind: "order", id: orderId, state: "unanswered" }); // most urgent first
    // Every open request is retrievable by the agent beyond any list: paged, each exactly once, in the same order.
    const seen: string[] = [];
    let offset: number | null = 0;
    for (let i = 0; i < 10 && offset !== null; i++) {
      const page = await R.econ(F, "customer.obligations", { offset, limit: 5 });
      expect(page.ok).toBe(true);
      seen.push(...(page.obligations as Array<{ kind: string; id: string }>).map((o) => `${o.kind}:${o.id}`));
      offset = page.next ?? null;
      if (i === 0) expect(page.total).toBe(list.length);
    }
    expect(seen).toEqual(list.map((o) => `${o.kind}:${o.id}`));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("v112: a PAID order awaiting delivery is an obligation with no buyer message (to_deliver), among the most urgent; it ends when the delivery is sent", async () => {
    // The first real local-model run (2026-10-23): a paid order the buyer never wrote about was in no packet.
    const k = await R.one(`fleet.fleet_econ_paypal_checkout($1, $2::jsonb)`, [F.id, JSON.stringify({ venture: "landlord", amountMinor: 700, description: "Gas checklist PDF",
      idempotencyKey: `t:${crypto.randomBytes(8).toString("hex")}` })]);
    const paid = (await R.q(`INSERT INTO fleet.fleet_customer_orders (agent_id, venture_id, checkout_id, item, amount_minor, currency, fulfilment, access_token, origin_hash, buyer_email, payment_status, status)
      SELECT agent_id, venture_id, checkout_id, description, amount_minor, currency, 'digital_file', $2, encode(sha256('buyer2'::bytea), 'hex'), 'rae@example.test', 'paid', 'to_fulfil'
        FROM fleet.fleet_paypal_checkouts WHERE checkout_id = $1 RETURNING order_id`, [k.checkout.checkoutId, crypto.randomBytes(32).toString("hex")]))[0].order_id;
    const ob = await obligations();
    const mine = ob.findIndex((x) => x.id === paid);
    expect(ob[mine]).toMatchObject({ kind: "order", id: paid, state: "to_deliver", buyerMessages: 0 });
    // Most urgent group (owed, no reply yet): only other owed requests — older first — may come before it.
    expect(ob.slice(0, mine).every((x) => x.state === "unanswered" || x.state === "to_deliver")).toBe(true);
    expect((await R.econ(F, "customer.obligations", {})).obligations.some((x: any) => x.id === paid && x.state === "to_deliver")).toBe(true);
    expect(ob[mine].deliveryOwed).toBe(true);
    // The first packet holds the requirement: what was bought, from the order record.
    expect(ob[mine].bought).toMatchObject({ item: "Gas checklist PDF", fulfilment: "digital_file", amountMinor: 700 });
    // Review 2026-10-23: the buyer writes — the conversation state changes, the owed delivery does not disappear; an answer
    // (even one marked resolved) without a delivery leaves it owed.
    await R.q(`INSERT INTO fleet.fleet_customer_messages (agent_id, order_id, author, body) VALUES ($1, $2, 'buyer', 'Any news on my PDF?')`, [F.id, paid]);
    expect((await obligations()).find((x) => x.id === paid)).toMatchObject({ state: "unanswered", buyerMessages: 1, deliveryOwed: true });
    await R.q(`INSERT INTO fleet.fleet_customer_messages (agent_id, order_id, author, body) VALUES ($1, $2, 'agent', 'Working on it today.')`, [F.id, paid]);
    expect((await obligations()).find((x) => x.id === paid)).toMatchObject({ state: "acknowledged", deliveryOwed: true });
    await R.q(`INSERT INTO fleet.fleet_customer_messages (agent_id, order_id, author, body, resolves) VALUES ($1, $2, 'agent', 'Closing this thread.', true)`, [F.id, paid]);
    expect((await obligations()).find((x) => x.id === paid)).toMatchObject({ state: "to_deliver", deliveryOwed: true });
    await delivery("sent", 0, { order: paid, file: "checklist v1" });
    await R.q(`UPDATE fleet.fleet_customer_orders SET status = 'delivered', fulfilled_at = now(), fulfilment_evidence = '{"delivery":"sent"}' WHERE order_id = $1`, [paid]);
    expect((await obligations()).some((x) => x.id === paid)).toBe(false);
    // Desktop run 2026-10-23 (9B, RTX 5080): delivered, then the buyer asked for a change; the agent answered and slept. The
    // revision is owed work until a later delivery is sent (or the request is resolved) — an answer alone does not end it.
    await R.q(`INSERT INTO fleet.fleet_customer_messages (agent_id, order_id, author, body) VALUES ($1, $2, 'buyer', 'Point 7 needs a date line. Could you add it?')`, [F.id, paid]);
    const asked = (await obligations()).find((x) => x.id === paid)!;
    expect(asked).toMatchObject({ state: "unanswered", revisionOwed: true });
    expect(asked.deliveryOwed).toBeUndefined();                                         // the first delivery was made
    await R.q(`INSERT INTO fleet.fleet_customer_messages (agent_id, order_id, author, body) VALUES ($1, $2, 'agent', 'Updated — see the revised PDF.')`, [F.id, paid]);
    expect((await obligations()).find((x) => x.id === paid)).toMatchObject({ state: "acknowledged", revisionOwed: true });
    // v115: the agent establishes the correction — its outcome, with the phrase that must be visible.
    const point7 = await lastBuyerId(paid);
    const OUTCOME7 = "Point 7 has a line for the date of the next annual check";
    expect(await classify(paid, point7, "correction", { criteria: [{ outcome: OUTCOME7, kind: "add", mustShow: ["next annual check"] }] })).toMatchObject({ ok: true });
    // Run 6 (v113): the same file again — even when the agent calls it an unchanged resend — goes to the buyer but answers
    // nothing: the request stays owed (and order.thread says so, for the runtime's checks).
    const thread = async () => (await R.econ(F, "order.thread", { orderId: paid })) as Record<string, any>;
    expect((await thread()).revisionOwed).toBe(true);
    await delivery("sent", 0, { order: paid, file: "checklist v1" });
    expect((await obligations()).find((x) => x.id === paid)).toMatchObject({ revisionOwed: true });
    expect((await thread()).revisionOwed).toBe(true);
    // Changed files whose review lists the outcome but did not show the declared phrase (no passing required_content): still owed.
    await delivery("sent", 0, { order: paid, file: "checklist v2", reviewId: await review(paid, null, [OUTCOME7]) });
    expect((await obligations()).find((x) => x.id === paid)).toMatchObject({ revisionOwed: true });
    // Changed files with the phrase visible but a review that does not list the outcome as met: still owed.
    await delivery("sent", 0, { order: paid, file: "checklist v2b", reviewId: await review(paid, "pass") });
    expect((await obligations()).find((x) => x.id === paid)).toMatchObject({ revisionOwed: true });
    // Changed files, the outcome met and the phrase visible: the correction is fulfilled.
    await delivery("sent", 0, { order: paid, file: "checklist v3", reviewId: await review(paid, "pass", [OUTCOME7]) });
    expect((await obligations()).some((x) => x.id === paid)).toBe(false);                // the revision was delivered
    expect((await thread()).revisionOwed).toBe(false);
    // v115 (owner 2026-10-24): a genuine "thanks" completes WITHOUT the owner: classified a conversation, answered, confirmed.
    const [thanks] = await R.q(`INSERT INTO fleet.fleet_customer_messages (agent_id, order_id, author, body) VALUES ($1, $2, 'buyer', 'Thanks, that is perfect.')
      RETURNING message_id`, [F.id, paid]);
    expect((await thread()).revisionOwed).toBe(true);                                 // unclassified: the agent must look at it
    await classify(paid, thanks.message_id, "conversation");
    await R.q(`INSERT INTO fleet.fleet_customer_messages (agent_id, order_id, author, body, resolves) VALUES ($1, $2, 'agent', 'Glad it helps.', true)`, [F.id, paid]);
    expect((await obligations()).some((x) => x.id === paid)).toBe(false);            // waiting for Fleet Control: deferred, not owed
    await checkVerdict(thanks.message_id, "no_change", 0.97);
    expect((await obligations()).some((x) => x.id === paid)).toBe(false);
    expect((await thread()).revisionOwed).toBe(false);
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_order_correction_withdrawals WHERE order_id = $1`, [paid]))[0].n).toBe(0);   // no owner action
  });

  it("v114: resolved: true acknowledges but cannot erase an owed correction; only fulfilment, refund/cancellation or the buyer's withdrawal (owner-recorded) end it", async () => {
    const k = await R.one(`fleet.fleet_econ_paypal_checkout($1, $2::jsonb)`, [F.id, JSON.stringify({ venture: "landlord", amountMinor: 900, description: "Fire safety checklist PDF",
      idempotencyKey: `t:${crypto.randomBytes(8).toString("hex")}` })]);
    const o = (await R.q(`INSERT INTO fleet.fleet_customer_orders (agent_id, venture_id, checkout_id, item, amount_minor, currency, fulfilment, access_token, origin_hash, buyer_email, payment_status, status,
        fulfilled_at, fulfilment_evidence)
      SELECT agent_id, venture_id, checkout_id, description, amount_minor, currency, 'digital_file', $2, encode(sha256('buyer3'::bytea), 'hex'), 'sam@example.test', 'paid', 'delivered',
        now() - interval '10 days', '{"delivery":"sent"}'::jsonb
        FROM fleet.fleet_paypal_checkouts WHERE checkout_id = $1 RETURNING order_id`, [k.checkout.checkoutId, crypto.randomBytes(32).toString("hex")]))[0].order_id;
    const msg = async (author: "buyer" | "agent", body: string, daysAgo: number, resolves = false) => (await R.q(`INSERT INTO fleet.fleet_customer_messages
      (agent_id, order_id, author, body, resolves, created_at) VALUES ($1, $2, $3, $4, $5, now() - make_interval(secs => $6 * 86400)) RETURNING message_id`,
      [F.id, o, author, body, resolves, daysAgo]))[0].message_id as string;
    const owed = async () => (await obligations()).find((x) => x.id === o);
    const conversation = async () => (await R.q(`SELECT fleet.fleet_order_conversation(o) AS c FROM fleet.fleet_customer_orders o WHERE o.order_id = $1`, [o]))[0].c;
    await delivery("sent", 10 * 1440, { order: o, file: "fire checklist v1" });                     // delivered 10 days ago
    const request = await msg("buyer", "Please add the alarm test dates to point 4.", 9);
    // THE BYPASS: the agent answers with resolved: true and delivers nothing. Before v114 the request vanished and the
    // conversation closed 7 days later. Now it is acknowledged, still owed, and the conversation stays open.
    await msg("agent", "Noted, all done.", 8, true);
    expect(await owed()).toMatchObject({ state: "acknowledged", revisionOwed: true });
    expect((await R.econ(F, "order.thread", { orderId: o })).revisionOwed).toBe(true);
    expect(await conversation()).toMatchObject({ open: true });
    // An agent cannot record a withdrawal: the function is the owner's (an operator actor; the agent role cannot run it).
    const agentDb = new pg.Pool({ connectionString: R.pgc.agentUrl, max: 1 });
    try {
      await expect(agentDb.query(`SELECT fleet.fleet_admin_order_correction_withdrawn($1, $2, 'x', 'operator:agent')`, [o, request])).rejects.toThrow(/permission denied/);
    } finally { await agentDb.end(); }
    await expect(R.one(`fleet.fleet_admin_order_correction_withdrawn($1, $2, $3, $4)`, [o, request, "agent says so", `agent:${F.id}`])).rejects.toThrow(/FLEET_APPROVAL_REQUIRED/);
    // Only the buyer's own message on this order, written since the request began, can be the withdrawal.
    const agentText = await msg("agent", "The buyer withdrew it.", 7);
    await expect(R.one(`fleet.fleet_admin_order_correction_withdrawn($1, $2, $3, $4)`, [o, agentText, "agent-quoted", OWNER])).rejects.toThrow(/buyer's own message/);
    expect(await owed()).toMatchObject({ revisionOwed: true });
    // A genuine withdrawal: the buyer's message, recorded by the owner, with a permanent event. The request is no longer owed.
    const withdrawal = await msg("buyer", "Actually, leave point 4 as it is.", 6);
    expect(await R.one(`fleet.fleet_admin_order_correction_withdrawn($1, $2, $3, $4)`, [o, withdrawal, "the buyer withdrew the change", OWNER])).toMatchObject({ ok: true, revisionOwed: false });
    const replyOwed = await owed();                                    // no correction owed; the buyer's message still deserves a reply
    expect(replyOwed).toMatchObject({ state: "unanswered" });
    expect(replyOwed!.revisionOwed).toBeUndefined();
    await msg("agent", "Understood, point 4 stays as it is.", 5, true);   // once nothing is owed, resolved: true closes the conversation
    expect(await owed()).toBeUndefined();
    expect((await R.q(`SELECT detail->>'buyerMessageId' AS m FROM fleet.fleet_events WHERE event_type = 'order_correction_withdrawn' AND detail->>'orderId' = $1`, [o]))
      .map((e) => e.m)).toEqual([withdrawal]);
    await expect(R.q(`DELETE FROM fleet.fleet_order_correction_withdrawals WHERE order_id = $1`, [o])).rejects.toThrow();   // history is immutable
    // A later buyer message is a new request; refund ends it (as does cancellation; fulfilment is v113's effective delivery).
    await msg("buyer", "Sorry — one more: add the fire door checks.", 0);
    expect(await owed()).toMatchObject({ revisionOwed: true });
    await R.q(`UPDATE fleet.fleet_customer_orders SET payment_status = 'refunded', refunded_minor = amount_minor WHERE order_id = $1`, [o]);
    expect((await owed())?.revisionOwed).toBeUndefined();                 // refunded: no correction owed (a reply may still be)
    expect((await R.econ(F, "order.thread", { orderId: o })).revisionOwed).toBe(false);
  });

  describe("v115: conversation and correction are separate (owner-approved design, 2026-10-24)", () => {
    const newDeliveredOrder = async (item: string) => {
      const k = await R.one(`fleet.fleet_econ_paypal_checkout($1, $2::jsonb)`, [F.id, JSON.stringify({ venture: "landlord", amountMinor: 800, description: item,
        idempotencyKey: `t:${crypto.randomBytes(8).toString("hex")}` })]);
      const o = (await R.q(`INSERT INTO fleet.fleet_customer_orders (agent_id, venture_id, checkout_id, item, amount_minor, currency, fulfilment, access_token, origin_hash, buyer_email,
          payment_status, status, fulfilled_at, fulfilment_evidence)
        SELECT agent_id, venture_id, checkout_id, description, amount_minor, currency, 'digital_file', $2, encode(sha256($3::bytea), 'hex'), 'kim@example.test', 'paid', 'delivered',
          now() - interval '1 hour', '{"delivery":"sent"}'::jsonb FROM fleet.fleet_paypal_checkouts WHERE checkout_id = $1 RETURNING order_id`,
        [k.checkout.checkoutId, crypto.randomBytes(32).toString("hex"), crypto.randomBytes(8).toString("hex")]))[0].order_id as string;
      await delivery("sent", 60, { order: o, file: `${item} v1` });
      return o;
    };
    const say = async (o: string, body: string) => (await R.q(`INSERT INTO fleet.fleet_customer_messages (agent_id, order_id, author, body) VALUES ($1, $2, 'buyer', $3) RETURNING message_id`,
      [F.id, o, body]))[0].message_id as string;
    const answer = (o: string, message: string, resolved = false) => econNext(R, F, "order.message", { orderId: o, message, ...(resolved ? { resolved: true } : {}) });
    const owed = async (o: string) => (await obligations()).find((x) => x.id === o);
    const checks = async (m: string) => R.q(`SELECT purpose, status, attempts, verdict, confidence, next_attempt_at > now() + interval '14 minutes' AS deferred15
      FROM fleet.fleet_message_checks WHERE message_id = $1`, [m]);
    const agentMessages = async (o: string) => (await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_customer_messages WHERE order_id = $1 AND author = 'agent'`, [o]))[0].n as number;

    it("thanks and a question complete without the owner; one paid check per message, never repeated", async () => {
      const o = await newDeliveredOrder("Thanks order");
      const thanks = await say(o, "Thanks, that's perfect!");
      expect(await owed(o)).toMatchObject({ revisionOwed: true, work: { classify: [thanks] } });
      await classify(o, thanks, "conversation");
      await answer(o, "Glad it helps!", true);
      expect(await owed(o)).toBeUndefined();                                            // deferred while Fleet Control checks
      expect(await classify(o, thanks, "conversation")).toMatchObject({ ok: false, code: "FLEET_ORDER_ALREADY_CLASSIFIED" });
      expect((await checks(thanks)).length).toBe(1);                                    // one check, not another paid review
      await checkVerdict(thanks, "no_change", 0.96);
      expect(await owed(o)).toBeUndefined();
      expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_order_correction_withdrawals WHERE order_id = $1`, [o]))[0].n).toBe(0);
      const question = await say(o, "Can I print it in A5?");
      await classify(o, question, "conversation");
      await answer(o, "Yes — choose 'fit to page' when printing.", true);
      await checkVerdict(question, "no_change", 0.88);
      expect(await owed(o)).toBeUndefined();
    });

    it("an explicit correction is established with outcome criteria (no phrase needed); resolved: true cannot close it; a delivery whose review lists the outcome does", async () => {
      const o = await newDeliveredOrder("Layout order");
      const ask = await say(o, "Could you put the checklist in two columns so it fits on one page?");
      const LAYOUT = "The checklist is laid out in two columns and fits on one page";
      expect(await classify(o, ask, "correction", { criteria: [{ outcome: LAYOUT, kind: "layout" }] })).toMatchObject({ ok: true, revisionOwed: true });
      await answer(o, "Noted — I will send it today.", true);
      expect(await owed(o)).toMatchObject({ state: "acknowledged", revisionOwed: true, work: { corrections: [expect.objectContaining({ sourceMessageId: ask })] } });
      expect(await classify(o, ask, "conversation")).toMatchObject({ ok: false, code: "FLEET_INVALID_STATE" });   // an established correction stands
      await delivery("sent", 0, { order: o, file: "Layout order v1" });                // the same file again: answers nothing
      expect(await owed(o)).toMatchObject({ revisionOwed: true });
      await delivery("sent", 0, { order: o, file: "Layout order v2", reviewId: await review(o, null, [LAYOUT]) });
      expect(await owed(o)).toBeUndefined();                                            // outcome met in a passing review of changed files
      await expect(classify(o, ask, "correction", { criteria: [] })).resolves.toMatchObject({ ok: false });
    });

    it("a delivery that fulfils a phrase-free correction also answers the buyer's request (no resolved: true needed) — the revision rehearsal's case", async () => {
      const o = await newDeliveredOrder("Dates order");
      const report = await say(o, "The renewal dates show as blank in my preview.");
      const OUT = "Every renewal date is a real date in the file, shown as a date";
      await classify(o, report, "correction", { criteria: [{ outcome: OUT, kind: "change" }] });
      await answer(o, "Thanks — I am fixing the saved dates now.");                    // acknowledged, NOT resolved
      expect(await owed(o)).toMatchObject({ state: "acknowledged", revisionOwed: true });
      await delivery("sent", 0, { order: o, file: "Dates order v2", reviewId: await review(o, null, [OUT]) });   // no phrase check at all
      expect(await owed(o)).toBeUndefined();                                            // correction fulfilled and the request answered
    });

    it("an ambiguous request: the agent asks one clarifying question; the buyer's reply is classified afresh — no redelivery, no owner", async () => {
      const o = await newDeliveredOrder("Ambiguous order");
      const vague = await say(o, "Could it be landscape? Not sure it matters.");
      await classify(o, vague, "unclear");
      const before = await agentMessages(o);
      await answer(o, "Would you like a landscape version, or keep portrait?");
      expect(await agentMessages(o)).toBe(before + 1);
      expect(await owed(o)).toMatchObject({ state: "acknowledged" });                  // answered with a question: a conversation, not work
      expect((await owed(o))!.revisionOwed).toBeUndefined();                           // no correction, nothing owed
      expect((await checks(vague)).length).toBe(0);                                     // no paid check for an unclear message
      const reply = await say(o, "Landscape please.");
      expect(await owed(o)).toMatchObject({ revisionOwed: true, work: { classify: [reply] } });
    });

    it("Fleet Control does not confirm 'conversation' (change requested, or uncertain): back to the agent, who establishes the correction", async () => {
      const o = await newDeliveredOrder("Disputed order");
      const msg = await say(o, "Thanks! Though the title should say England and Wales.");
      await classify(o, msg, "conversation");
      await answer(o, "Thank you!", true);
      await checkVerdict(msg, "change_requested", 0.86);
      expect(await owed(o)).toMatchObject({ revisionOwed: true, work: { classify: [msg], disputed: [msg] } });
      expect(await classify(o, msg, "correction", { criteria: [{ outcome: "The title says England and Wales", kind: "change", mustShow: ["England and Wales"] }] }))
        .toMatchObject({ ok: true });
      expect((await owed(o))?.work?.corrections?.[0]?.sourceMessageId).toBe(msg);
      const unsure = await say(o, "Also, maybe bigger text?");
      await classify(o, unsure, "conversation");
      await checkVerdict(unsure, "no_change", 0.55);                                   // low confidence is not confirmation
      expect((await owed(o))?.work?.disputed).toContain(unsure);
    });

    it("withdrawal: confirmed by Fleet Control from the buyer's later message (confidence ≥ 0.8); the agent's word alone never closes it", async () => {
      const o = await newDeliveredOrder("Withdrawal order");
      const ask = await say(o, "Please add the boiler service date to point 2.");
      const [c] = [(await classify(o, ask, "correction", { criteria: [{ outcome: "Point 2 has the boiler service date", kind: "add" }] })).correctionId as string];
      await expect(R.econ(F, "order.withdraw_correction", { orderId: o, correctionId: c, messageId: ask, reason: "x x" })).resolves.toMatchObject({ ok: false });   // not a LATER message
      const unsure = await say(o, "Hmm, maybe leave it.");
      expect(await R.econ(F, "order.withdraw_correction", { orderId: o, correctionId: c, messageId: unsure, reason: "the buyer may not want it" })).toMatchObject({ ok: true, status: "pending" });
      expect(await owed(o)).toMatchObject({ revisionOwed: true });                      // pending: still owed
      await checkVerdict(unsure, "withdrawn", 0.6, "withdrawal");
      expect((await owed(o))?.work?.corrections?.length).toBe(1);                       // low confidence: still owed
      const clear = await say(o, "No need for the boiler date after all — leave point 2 as it is.");
      await classify(o, unsure, "conversation");                                        // the agent answers the other messages as conversation
      await classify(o, clear, "conversation");
      await R.econ(F, "order.withdraw_correction", { orderId: o, correctionId: c, messageId: clear, reason: "the buyer withdrew it" });
      await checkVerdict(clear, "withdrawn", 0.93, "withdrawal");
      expect((await owed(o))?.work?.corrections).toBeUndefined();                       // the correction is closed
    });

    it("an unavailable review checkpoints and defers: no room in Fleet Control's budget is not an attempt; provider failures are bounded, then stalled — the buyer is never asked", async () => {
      const o = await newDeliveredOrder("Deferred order");
      const thanks = await say(o, "Great, thank you.");
      await classify(o, thanks, "conversation");
      await answer(o, "You're welcome!", true);
      const asked = await agentMessages(o);
      // Fleet Control's daily budget is unset in this registry: the claim hands out no job (deferred).
      expect((await R.one<any>(`fleet.svc_message_checks_claim(5, 'test-worker')`)).jobs).toEqual([]);
      const [k] = await R.q(`SELECT check_id FROM fleet.fleet_message_checks WHERE message_id = $1`, [thanks]);
      expect(await R.one(`fleet.svc_message_check_failed($1, 'test-worker', 'FLEET_CONTROL_AI_BUDGET: no room', '[]'::jsonb)`, [k.check_id])).toMatchObject({ status: "deferred" });
      expect((await checks(thanks))[0]).toMatchObject({ status: "pending", attempts: 0, deferred15: true });
      for (let i = 1; i <= 3; i++) await R.one(`fleet.svc_message_check_failed($1, 'test-worker', 'FLEET_REVIEW_PROVIDER_ERROR: overloaded', '[]'::jsonb)`, [k.check_id]);
      expect(await R.q(`SELECT 1 FROM fleet.fleet_notifications WHERE code = 'MESSAGE_CHECK_STALLED' AND detail ->> 'checkId' = $1`, [k.check_id])).toHaveLength(1); // v124: the owner hears it
      expect((await checks(thanks))[0]).toMatchObject({ status: "stalled", attempts: 3 });
      expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_events WHERE event_type = 'message_check_stalled' AND detail->>'checkId' = $1`, [k.check_id]))[0].n).toBe(1);
      expect(await owed(o)).toBeUndefined();                                            // deferred: not the agent's work
      expect(await agentMessages(o)).toBe(asked);                                       // and nothing was sent to the buyer
    });

    it("Fleet Control's check is treasury overhead with exactly a knowledge review's ledger legs, within its own reservation kind", async () => {
      const legs = async (kind: string) => (await R.q(`SELECT class, side FROM fleet.fleet_ledger_rules WHERE kind = $1 ORDER BY class, side`, [kind])).map((r) => `${r.class}:${r.side}`);
      expect(await legs("message_check_charge")).toEqual(await legs("knowledge_review_charge"));
      expect((await legs("message_check_charge")).length).toBeGreaterThan(0);
      expect((await R.q(`SELECT 1 FROM fleet.fleet_control_accrual WHERE kind = 'message_check_charge'`)).length).toBe(1);
      expect(await R.one(`fleet.svc_fleet_control_ai_reserve('message_check', 'x', 100, gen_random_uuid(), 'anthropic')`)).toMatchObject({ ok: false, code: "FLEET_CONTROL_AI_BUDGET_UNSET" });   // a known kind; no budget set
      expect(await R.one(`fleet.svc_fleet_control_ai_reserve('mystery', 'x', 100, gen_random_uuid(), 'anthropic')`)).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
      // A recorded check's provider consumption is booked as Fleet Control's, never the agent's.
      const o = await newDeliveredOrder("Charged order");
      const m = await say(o, "Thanks!");
      await classify(o, m, "conversation");
      const [k] = await R.q(`SELECT check_id FROM fleet.fleet_message_checks WHERE message_id = $1`, [m]);
      const requestId = crypto.randomUUID();
      await R.one(`fleet.svc_message_check_record($1, 'test-worker', $2::jsonb)`, [k.check_id, JSON.stringify({ verdict: "no_change", confidence: 0.9, evidence: "thanks only",
        calls: [{ requestId, provider: "anthropic", tier: "T2", model: "claude-sonnet-5-5", inputTokens: 300, outputTokens: 40, usdMicrocents: 2_500_000 }] })]);
      expect((await R.q(`SELECT recorded_by FROM fleet.fleet_provider_credit_events WHERE request_id = $1`, [requestId]))[0].recorded_by).toBe("controller:message_check_charge");
    });
  });

  it("v111: a listing, pin or storefront product that sells elsewhere names a published offer whose capability check still covers it", async () => {
    const offerId = String((await R.q(`SELECT offer_id FROM fleet.fleet_offer_enquiries WHERE enquiry_id = $1`, [enquiryId]))[0].offer_id);
    const listing = (extra: Record<string, unknown>) => R.econ(F, "channel.api", { channelId: crypto.randomUUID(), op: "etsy.listing.create", idempotencyKey: `l-${crypto.randomUUID()}`,
      args: { title: "Landlord compliance tracker", description: "A spreadsheet that tracks every renewal for UK landlords.", priceMinor: 900, taxonomyId: 1 }, ...extra })
      .catch((e: Error) => ({ ok: false, code: /FLEET_[A-Z_]+/.exec(e.message)?.[0] }));
    expect(await listing({})).toMatchObject({ ok: false, code: "FLEET_CAPABILITY_CHECK_REQUIRED" });              // no offer named
    const draft = (await R.q(`INSERT INTO fleet.fleet_offers (agent_id, venture_id, slug, kind, title, summary, description, deliverables, price_minor, currency, terms, turnaround_days)
      SELECT agent_id, venture_id, 'draft-' || substr(md5(random()::text), 1, 6) || '-abcdef', kind, title, summary, description, deliverables, price_minor, currency, terms, COALESCE(turnaround_days, 5)
        FROM fleet.fleet_offers WHERE offer_id = $1 RETURNING offer_id`, [offerId]))[0].offer_id;
    expect(await listing({ offerId: draft })).toMatchObject({ ok: false, code: "FLEET_CAPABILITY_CHECK_REQUIRED" });  // not published
    // A published offer (fixture: marked published in this throwaway database) without a check covering it: refused.
    const c = await su.connect();
    try { await c.query("SET default_transaction_read_only = off"); await c.query("SET session_replication_role = replica");
      await c.query(`UPDATE fleet.fleet_offers SET status = 'published', review_id = gen_random_uuid() WHERE offer_id = $1`, [offerId]); }
    finally { await c.query("RESET session_replication_role"); await c.query("RESET default_transaction_read_only"); c.release(); }
    expect(await listing({ offerId })).toMatchObject({ ok: false, code: "FLEET_CAPABILITY_CHECK_REQUIRED" });
    // Its capability check (through the agent's own API): the gate passes; the next refusal is the channel's own (none connected).
    await R.econ(F, "capabilities.check", { runtime: READY_RUNTIME, offerId, deliverables: [{ format: "pdf" }] });
    expect(await listing({ offerId })).toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });
});
