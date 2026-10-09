/**
 * Schema v56 — the selling loop closed. PostgreSQL + the identity broker (simulated shared mailbox) + custody's cx_* calls.
 *
 * Proven here: a checkout is also an order of its agent; it is paid only on PayPal's evidence; its buyer (from PayPal's
 * order record) is the agent's alone — another agent cannot see or act on it, events and shared knowledge never carry it;
 * a digital order is delivered by mail with its files through the broker's ordinary mail.send job and is "delivered" only
 * once the provider accepted the message; a failed send is retried by the reaper (back-off, attempts counted, never two at
 * once); duplicates are refused; a full refund cancels an undelivered order; a service order needs evidence; files larger
 * than the old 32 kB argument limit pass; account.create answers truthfully without a connector; an insolvent agent's payable
 * is repaid / written off at settlement and money reaching a settled estate goes to the treasury.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { liveRail, type ArmedCustody } from "./fixtures/custody-signer.js";
import { PgIdentityGateway } from "../../fleet/identity/gateway.js";
import { IdentityBroker } from "../../fleet/identity/broker.js";
import { SimulatedSharedMailProvider } from "../../fleet/identity/providers.js";
import { initIdentityState, openIdentityState, openProviderVault } from "../../fleet/identity/main.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";
import { EVENT_ROUTES_V56 } from "../../fleet/postgres/migrations-phase56.js";

const PG_BIN = findPgBin();

describe.skipIf(!PG_BIN)("v56: customer orders, delivery, truthful account creation, estates (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let F: Founder;
  let G: Founder;
  let svc: pg.Pool;
  let custody: pg.Pool;
  let rail: ArmedCustody;
  let dir: string;
  let igw: PgIdentityGateway;
  let broker: IdentityBroker;
  const shared = new SimulatedSharedMailProvider("fleet@shared.fleet-mail.test");
  const idem = () => `k-${crypto.randomUUID()}`;
  const cx = async (fn: string, args: unknown[]) => {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    return (await custody.query(`SELECT fleet.${fn}(${ph}) AS r`, args)).rows[0].r;
  };
  const sv = async (sql: string) => (await svc.query(sql)).rows[0].r;
  const capId = () => `CAP${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
  const events = async (type: string) => Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE event_type = $1)`, [type]));
  /** An agent sells: checkout → order; PayPal opens, the buyer approves, custody captures; custody reads the buyer. */
  const sell = async (who: Founder, venture: string, amountMinor: number, fulfilment: string, buyer = "Buyer.One@Example.test") => {
    const c = await R.econ(who, "paypal.checkout", { venture, amountMinor, description: "Printable planner pack", fulfilment, idempotencyKey: idem() });
    expect(c.ok, JSON.stringify(c)).toBe(true);
    expect(c.order).toMatchObject({ fulfilment, payment: "awaiting_payment", status: "awaiting_payment" });
    const checkoutId = c.checkout.checkoutId as string;
    const orderId = `ORD${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
    await cx("cx_paypal_checkout_update", ["custody-executor", checkoutId, "open", orderId, `https://www.paypal.com/checkoutnow?token=${orderId}`, null]);
    await cx("cx_paypal_checkout_update", ["custody-executor", checkoutId, "approved", null, null, null]);
    const captureId = capId();
    expect((await cx("cx_paypal_capture_record", ["custody-executor", checkoutId, captureId, "COMPLETED", amountMinor, 50, "GBP", "webhook"])).ok).toBe(true);
    const work = await cx("cx_paypal_buyer_work", ["custody-executor", 50]);
    expect(work.find((w: any) => w.checkoutId === checkoutId)).toMatchObject({ paypalOrderId: orderId, vaultRef: rail.vaultRef });
    expect((await cx("cx_paypal_buyer_record", ["custody-executor", checkoutId, JSON.stringify({ email_address: buyer, name: { given_name: "Ada", surname: "Buyer" },
      address: { country_code: "GB" }, payer_id: "PAYERADA0001" })])).recorded).toBe(true);
    return { order: c.order.orderId as string, checkoutId, captureId };
  };
  const order = async (who: Founder, orderId: string) => (await R.econ(who, "order.list", { orderId })).orders[0];

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000, simulatedSettlement: false });
    [F, G] = R.founders;
    await R.store.grantServiceRole();
    await R.store.grantCustodyRole();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2, options: "-c search_path=fleet" });
    custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 2, options: "-c search_path=fleet" });
    for (const [who, key] of [[F, "planners"], [G, "consulting"]] as const) {
      expect((await R.econ(who, "venture.create", { key, model: "digital_product", offer: key, state: "selected" })).ok).toBe(true);
    }
    rail = await liveRail(R.owner, "fleet", OWNER);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v56-"));
    fs.chmodSync(dir, 0o700);
    initIdentityState(dir);
    igw = new PgIdentityGateway({ connectionString: R.pgc.identityUrl });
    const { vault, ownerVault } = openIdentityState(dir);
    broker = new IdentityBroker(igw, vault, { mail: shared, ownerVault, providerVault: openProviderVault(dir), stateFile: path.join(dir, "pending.json") });
    await broker.tick();
    for (const who of [F, G]) expect((await R.econ(who, "mailbox.provision", { idempotencyKey: idem() })).ok).toBe(true);
  }, 300_000);
  afterAll(async () => {
    await igw?.close(); await svc?.end(); await custody?.end(); await R?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("migrates to v56 with a clean audit; the new events are routed", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(56);
    expect(await R.one(`(SELECT max(version) FROM fleet.fleet_schema_migrations)`)).toBe(FLEET_PG_SCHEMA_VERSION);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    for (const [p, ts] of Object.entries(EVENT_ROUTES_V56)) for (const t of ts) expect(await R.one(`fleet.fleet_event_route($1, '{}'::jsonb)`, [t]), t).toBe(p);
  });

  it("a paid digital order is delivered by mail with its file — delivered only once the provider accepted it; the buyer is the agent's alone", async () => {
    const s = await sell(F, "planners", 1_200, "digital_file");
    const o = await order(F, s.order);
    expect(o).toMatchObject({ payment: "paid", status: "to_fulfil", buyer: { email: "buyer.one@example.test", name: "Ada Buyer", country: "GB" } });
    // Another agent sees nothing and cannot act on it.
    expect((await R.econ(G, "order.list", {})).orders).toEqual([]);
    expect(await R.econ(G, "order.deliver", { orderId: s.order, files: [{ fileName: "x.pdf", contentB64: "JVBERg==" }], idempotencyKey: idem() }))
      .toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    // A 120 kB file: well beyond the general 32 kB argument limit.
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4 planner "), crypto.randomBytes(120_000)]);
    const key = idem();
    const d = await R.econ(F, "order.deliver", { orderId: s.order, files: [{ fileName: "planner-pack.pdf", contentType: "application/pdf", contentB64: pdf.toString("base64") }],
      message: "Thank you! Your planner pack is attached.", idempotencyKey: key });
    expect(d, JSON.stringify(d)).toMatchObject({ ok: true, order: { status: "delivering", delivery: { status: "queued", attempts: 1 } } });
    // Not delivered by payment, nor by queuing: only the provider's acceptance.
    expect((await order(F, s.order)).status).toBe("delivering");
    expect(await R.econ(F, "order.deliver", { orderId: s.order, files: [{ fileName: "x.pdf", contentB64: "JVBERg==" }], idempotencyKey: idem() }))
      .toMatchObject({ ok: false, code: "FLEET_DELIVERY_IN_PROGRESS" });
    expect(await R.econ(F, "order.deliver", { orderId: s.order, idempotencyKey: key })).toMatchObject({ ok: true, replay: true });
    await broker.tick();
    const sent = shared.outbox.at(-1)!;
    expect(sent).toMatchObject({ from: shared.address, to: ["buyer.one@example.test"], subject: "Your order: Printable planner pack", body: "Thank you! Your planner pack is attached." });
    expect(sent.attachments?.map((a) => [a.fileName, a.contentType, a.content.equals(pdf)])).toEqual([["planner-pack.pdf", "application/pdf", true]]);
    const done = await order(F, s.order);
    expect(done).toMatchObject({ status: "delivered", delivery: { status: "sent", files: [{ fileName: "planner-pack.pdf", sha256: crypto.createHash("sha256").update(pdf).digest("hex") }] },
      evidence: { kind: "mail" } });
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_order_delivery_files WHERE blob IS NOT NULL)`)).toBe(0); // bytes erased once sent
    expect(await R.econ(F, "order.deliver", { orderId: s.order, files: [{ fileName: "x.pdf", contentB64: "JVBERg==" }], idempotencyKey: idem() }))
      .toMatchObject({ ok: false, code: "FLEET_ALREADY_DELIVERED" });
    // The buyer's contact never reaches an event.
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_events WHERE detail::text ILIKE '%buyer.one%')`)).toBe(0);
    expect(await events("customer_order_paid")).toBeGreaterThanOrEqual(1);
    expect(await events("order_delivered")).toBe(1);
  });

  it("a failed send is retried by the reaper with back-off — one message at a time — then delivered", async () => {
    const s = await sell(F, "planners", 900, "digital_file", "second@example.test");
    shared.down = true;
    expect((await R.econ(F, "order.deliver", { orderId: s.order, files: [{ fileName: "pack.zip", contentType: "application/zip", contentB64: Buffer.from("PK zip").toString("base64") }],
      idempotencyKey: idem() })).ok).toBe(true);
    await broker.tick();
    let o = await order(F, s.order);
    expect(o).toMatchObject({ status: "delivering", delivery: { status: "failed", attempts: 1 } });
    expect(o.delivery.lastError).toMatch(/^FLEET_/);
    expect(new Date(o.delivery.nextAttemptAt).getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
    expect(await sv(`SELECT fleet.svc_order_deliveries_retry(20) AS r`)).toMatchObject({ resent: 0 }); // not yet due
    await R.q(`UPDATE fleet.fleet_order_deliveries SET next_attempt_at = now() - interval '1 second' WHERE order_id = $1`, [s.order]);
    shared.down = false;
    expect(await sv(`SELECT fleet.svc_order_deliveries_retry(20) AS r`)).toMatchObject({ resent: 1 });
    await broker.tick();
    o = await order(F, s.order);
    expect(o).toMatchObject({ status: "delivered", delivery: { status: "sent", attempts: 2 } });
    expect(shared.outbox.filter((m) => m.to[0] === "second@example.test").length).toBe(1);
  });

  it("nothing is delivered before payment or after a full refund; a service order needs evidence of fulfilment", async () => {
    // Unpaid.
    const c = await R.econ(F, "paypal.checkout", { venture: "planners", amountMinor: 700, description: "Unpaid planner", fulfilment: "digital_file", idempotencyKey: idem() });
    expect(await R.econ(F, "order.deliver", { orderId: c.order.orderId, files: [{ fileName: "x.pdf", contentB64: "JVBERg==" }], idempotencyKey: idem() }))
      .toMatchObject({ ok: false, code: "FLEET_ORDER_NOT_PAID" });
    // Fully refunded before delivery: cancelled.
    const s = await sell(F, "planners", 800, "digital_file");
    expect((await cx("cx_paypal_refund_record", ["custody-executor", s.captureId, "RFFULL000001", "refund", 800, "GBP"])).ok).toBe(true);
    expect(await order(F, s.order)).toMatchObject({ payment: "refunded", status: "cancelled", refundedMinor: 800 });
    expect(await R.econ(F, "order.deliver", { orderId: s.order, files: [{ fileName: "x.pdf", contentB64: "JVBERg==" }], idempotencyKey: idem() }))
      .toMatchObject({ ok: false, code: "FLEET_ORDER_NOT_PAID" });
    // A service order: payment alone never fulfils it; a note or a sent message to the buyer does.
    const v = await sell(G, "consulting", 5_000, "service", "client@example.test");
    expect(await order(G, v.order)).toMatchObject({ status: "to_fulfil" });
    expect(await R.econ(G, "order.fulfil", { orderId: v.order })).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
    const m = await R.econ(G, "mail.send", { to: "client@example.test", subject: "Your report", body: "Attached findings.", idempotencyKey: idem() });
    expect(await R.econ(G, "order.fulfil", { orderId: v.order, messageId: m.messageId })).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" }); // not sent yet
    await broker.tick();
    expect(await R.econ(G, "order.fulfil", { orderId: v.order, messageId: m.messageId })).toMatchObject({ ok: true, order: { status: "fulfilled", evidence: { kind: "mail" } } });
  });

  it("the owner's dashboard sees orders with the buyer masked; shared knowledge never keeps a buyer's contact", async () => {
    const d = await R.one(`fleet.fleet_customer_orders_json(NULL)`);
    expect(d.counts).toMatchObject({ delivered: 2, fulfilled: 1, cancelled: 1 });
    const delivered = d.orders.find((o: any) => o.status === "delivered");
    expect(delivered.buyer.email).toMatch(/^[a-z]…@example\.test$/);
    expect(delivered.buyer.name).toBeUndefined();
    const k = await R.econ(F, "knowledge.record", { topic: "channel", subject: "buyer 07700900123 repeat", claim: "Buyer Buyer.One@Example.test (sw1a 1aa, gb33bukb20201555555555) bought twice", confidenceBp: 6000 });
    expect(k.ok, JSON.stringify(k)).toBe(true);
    const row = (await R.q(`SELECT subject, claim FROM fleet.fleet_economic_knowledge WHERE agent_id = $1 ORDER BY observed_at DESC LIMIT 1`, [F.id]))[0];
    expect(row.claim).toBe("Buyer [email] ([postcode], [bank account]) bought twice");
    expect(row.subject).toBe("buyer num repeat");
  });

  it("account.create answers FLEET_NO_CONNECTOR at once (with the working path) until the broker publishes a connector", async () => {
    const r = await R.econ(F, "account.create", { platform: "etsy.com", kind: "marketplace", idempotencyKey: idem() });
    expect(r).toMatchObject({ ok: false, code: "FLEET_NO_CONNECTOR" });
    expect(r.reason).toMatch(/connectors: none\).*register_account/);
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_identity_jobs WHERE kind = 'account.create')`)).toBe(0);
    expect((await igw.connectorsPublish("identity-broker", ["examplemarket"])).ok).toBe(true);
    expect(await R.econ(F, "account.create", { platform: "examplemarket", kind: "marketplace", idempotencyKey: idem() })).toMatchObject({ ok: true });
    expect((await igw.connectorsPublish("identity-broker", [])).ok).toBe(true);
    expect((await R.one(`fleet.fleet_customer_orders_json(NULL)`)).connectors).toEqual([]);
  });

  it("estates: an insolvent agent's payable is repaid from its cash / written off; money reaching a settled estate goes to the treasury", async () => {
    // G's sale is available; G's cash is then drained; a refund arrives that its cash cannot cover → a payable (an advance).
    const s = await sell(G, "consulting", 2_000, "service");
    // PayPal shows all of G's captures available (Transaction Search S + a covering balance).
    for (const a of await R.q(`SELECT v.capture_id, v.checkout_id, c.amount_minor FROM fleet.fleet_paypal_availability v JOIN fleet.fleet_paypal_checkouts c USING (checkout_id) WHERE v.agent_id = $1 AND v.status = 'pending'`, [G.id])) {
      await cx("cx_paypal_txn_record", ["custody-executor", rail.railId, JSON.stringify({ transactionId: a.capture_id, eventCode: "T0006", initiatedAt: new Date().toISOString(),
        status: "S", currency: "GBP", amountMinor: Number(a.amount_minor), feeMinor: 0, customField: a.checkout_id })]);
    }
    await cx("cx_paypal_balance_record", ["custody-executor", rail.railId, "GBP", 10_000_000, 10_000_000]);
    await sv(`SELECT fleet.svc_paypal_availability(100) AS r`);
    await R.one(`fleet.fleet_admin_card_charge_record($1, $2, 'drain', 'stmt-drain-g', $3)`, [G.id, await R.balance(`agent:${G.id}:cash`), OWNER]);
    expect((await cx("cx_paypal_refund_record", ["custody-executor", s.captureId, "RFG000000001", "refund", 300, "GBP"])).advancedMinor).toBe(300);
    expect(await R.balance(`agent:${G.id}:provider_payable`)).toBe(300);
    // Live survival rule: G is exhausted and dies; its estate settles with the payable written off.
    await R.one(`fleet.fleet_admin_survival_protection_set(false, 'tests of the live survival rule', $1)`, [OWNER]);
    expect(await sv(`SELECT fleet.svc_insolvency_tick() AS r`)).toMatchObject({ died: 1 });
    expect(await sv(`SELECT fleet.svc_settle_estates(10) AS r`)).toBeGreaterThanOrEqual(1);
    const est = (await R.q(`SELECT status, summary FROM fleet.fleet_estates WHERE agent_id = $1`, [G.id]))[0];
    expect(est).toMatchObject({ status: "settled", summary: { payableWrittenOff: 300, payableRepaid: 0 } });
    expect(await R.balance(`agent:${G.id}:provider_payable`)).toBe(0);
    // A later refund of the same sale after settlement: advanced, then written off by the late pass.
    await cx("cx_paypal_refund_record", ["custody-executor", s.captureId, "RFG000000002", "refund", 100, "GBP"]);
    expect(await R.balance(`agent:${G.id}:provider_payable`)).toBe(100);
    await sv(`SELECT fleet.svc_settle_estates(10) AS r`);
    expect(await R.balance(`agent:${G.id}:provider_payable`)).toBe(0);
    expect(await events("estate_late_money")).toBe(1);
    await R.one(`fleet.fleet_admin_survival_protection_set(true, NULL, $1)`, [OWNER]);
    expect((await R.one(`fleet.fleet_ledger_verify()`)).ok).toBe(true);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });
});
