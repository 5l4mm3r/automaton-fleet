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
import { startEconomyRegistry, autoCapabilityChecks, OWNER, econNext, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
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
  const delivery = async (status: string, minutesAgo: number) => R.q(`INSERT INTO fleet.fleet_order_deliveries (order_id, agent_id, idempotency_key, subject, body, status, created_at, sent_at)
    VALUES ($1, $2, $3, 'Your corrected tracker', 'Attached.', $4, now() - make_interval(mins => $5), CASE WHEN $4 = 'sent' THEN now() END) RETURNING delivery_id`,
    [orderId, F.id, `test:${crypto.randomUUID()}`, status, minutesAgo]);

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
    expect(ob).toMatchObject({ kind: "order", id: orderId, state: "unanswered", buyerMessages: 1 });
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
    expect((await obligations())[0]).toMatchObject({ state: "acknowledged", repliedAt: expect.any(String) });
    expect(await digest()).toBe(before);
    expect(await watchdog(new Date(Date.now() - 120 * 60_000).toISOString())).toBe(false);
    await buyer(0, "Any news?");                                     // after the answer (each statement its own now())
    expect((await obligations())[0]).toMatchObject({ state: "unanswered", buyerMessages: 2 });
    expect(await digest()).not.toBe(before);
    expect(await econNext(R, F, "order.message", { orderId, message: "Working on it.", resolved: "yes" })).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
  });

  it("resolved by a delivery made after the request once it is sent (in progress while queued), or by a resolving answer", async () => {
    const [d] = await delivery("queued", 0);
    expect((await obligations())[0]).toMatchObject({ state: "unanswered", delivering: true });
    await R.q(`UPDATE fleet.fleet_order_deliveries SET status = 'sent', sent_at = now() WHERE delivery_id = $1`, [d.delivery_id]);
    expect(await obligations()).toEqual([]);
    await buyer(0, "One more question: does it cover Wales?");
    expect((await obligations())[0]).toMatchObject({ state: "unanswered", buyerMessages: 1 });
    expect(await econNext(R, F, "order.message", { orderId, message: "It covers England only; Wales has different rules.", resolved: true }))
      .toMatchObject({ ok: true, resolves: true, obligation: null });
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
});
