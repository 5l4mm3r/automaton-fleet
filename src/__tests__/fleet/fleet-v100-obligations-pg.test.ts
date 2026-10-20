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
});
