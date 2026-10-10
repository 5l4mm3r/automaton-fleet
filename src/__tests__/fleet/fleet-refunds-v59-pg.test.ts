/**
 * Schema v59 — refunds the Fleet initiates. PostgreSQL + the custody PayPal worker against a fake Payments v2 refund API.
 *
 * Proven here: an agent refunds only its own sale, within what is refundable (paid, less refunds / reversals posted or in
 * flight), once per idempotency key; the amount stops being spendable at once; nothing is sent while money-out is not
 * activated, nor on a live rail while the spend gate is closed; once sent (PayPal-Request-Id per request) the refund is
 * posted exactly once from PayPal's answer, and PayPal's own REFUNDED webhook and Transaction Search row for it post
 * nothing more; a refusal releases the reserve; an unknown outcome is retried with the same request id (one refund); the
 * owner can refund too.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { liveRail, type ArmedCustody } from "./fixtures/custody-signer.js";
import { PgCustodyGateway } from "../../fleet/custody/gateway.js";
import { PayPalTreasuryWorker } from "../../fleet/custody/paypal-treasury.js";
import type { HttpPort } from "../../fleet/custody/signers.js";
import { MemoryVault } from "../../fleet/payments/credential-broker.js";
import { EVENT_ROUTES_V59 } from "../../fleet/postgres/migrations-phase59.js";

const PG_BIN = findPgBin();

/** A fake PayPal: OAuth and the capture refund endpoint (idempotent by PayPal-Request-Id); everything else is empty. */
function fakeRefunds() {
  const byRequest = new Map<string, { id: string; status: string; value: string; currency: string }>();
  const calls: Array<{ path: string; requestId: string | undefined; body: any }> = [];
  let mode: "ok" | "refuse" | "error" = "ok";
  const http: HttpPort = async (url, init) => {
    const u = new URL(url);
    const json = (status: number, body: unknown) => ({ status, json: async () => body });
    if (u.pathname === "/v1/oauth2/token") return json(200, { access_token: "A21AAfake-token-0001", expires_in: 32400 });
    const m = /^\/v2\/payments\/captures\/([A-Z0-9]+)\/refund$/.exec(u.pathname);
    if (init.method === "POST" && m) {
      const rid = init.headers["PayPal-Request-Id"];
      const body = JSON.parse(init.body!);
      calls.push({ path: u.pathname, requestId: rid, body });
      if (mode === "error") return json(500, {});
      if (mode === "refuse") return json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "REFUND_AMOUNT_EXCEEDED" }] });
      let r = byRequest.get(rid);
      if (!r) { r = { id: `RF${crypto.randomBytes(5).toString("hex").toUpperCase()}`, status: "COMPLETED", value: body.amount.value, currency: body.amount.currency_code }; byRequest.set(rid, r); }
      return json(201, { id: r.id, status: r.status, amount: { value: r.value, currency_code: r.currency } });
    }
    if (u.pathname === "/v1/reporting/transactions") return json(200, { transaction_details: [], total_pages: 1 });
    if (u.pathname === "/v1/reporting/balances") return json(200, { balances: [] });
    return json(404, {});
  };
  return { http, calls, byRequest, set: (m: "ok" | "refuse" | "error") => { mode = m; } };
}

describe.skipIf(!PG_BIN)("v59: refunds initiated by the Fleet (PostgreSQL + custody worker)", () => {
  let R: EconomyRegistry;
  let F: Founder;
  let G: Founder;
  let custody: pg.Pool;
  let svc: pg.Pool;
  let rail: ArmedCustody;
  let gw: PgCustodyGateway;
  let pp: ReturnType<typeof fakeRefunds>;
  let gateOpen = true;
  let worker: PayPalTreasuryWorker;
  const W = "custody-executor";
  const cx = async (fn: string, args: unknown[]) => {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    return (await custody.query(`SELECT fleet.${fn}(${ph}) AS r`, args)).rows[0].r;
  };
  const id = (p: string) => `${p}${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
  const idem = () => `k-${crypto.randomUUID()}`;
  const cash = () => R.balance(`agent:${F.id}:cash`);
  const spendable = async () => Number((await R.one(`fleet.fleet_agent_wallet_measure($1)`, [F.id])).spendableMinor);
  const posted = async (checkoutId: string) => Number(await R.one(`(SELECT COALESCE(sum(amount_minor), 0) FROM fleet.fleet_paypal_clawback_posts WHERE checkout_id = $1 AND grp = 'refund')`, [checkoutId]));
  const sale = async (amountMinor: number) => {
    const c = await R.econ(F, "paypal.checkout", { venture: "prints", amountMinor, description: "Art print", fulfilment: "service", idempotencyKey: idem() });
    const checkoutId = c.checkout.checkoutId as string;
    const order = id("ORD");
    await cx("cx_paypal_checkout_update", [W, checkoutId, "open", order, `https://www.paypal.com/checkoutnow?token=${order}`, null]);
    await cx("cx_paypal_checkout_update", [W, checkoutId, "approved", null, null, null]);
    const captureId = id("CAP");
    await cx("cx_paypal_capture_record", [W, checkoutId, captureId, "COMPLETED", amountMinor, 0, "GBP", "webhook"]);
    await cx("cx_paypal_txn_record", [W, rail.railId, JSON.stringify({ transactionId: captureId, eventCode: "T0006", initiatedAt: new Date().toISOString(),
      status: "S", currency: "GBP", amountMinor, feeMinor: 0, customField: checkoutId })]);
    await cx("cx_paypal_balance_record", [W, rail.railId, "GBP", 100_000_000, 100_000_000]);
    await svc.query(`SELECT fleet.svc_paypal_availability(100)`);
    return { checkoutId, captureId, orderId: c.order.orderId as string };
  };
  const request = async (orderId: string) => (await R.q(`SELECT * FROM fleet.fleet_paypal_refund_requests WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`, [orderId]))[0];

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 5_000, simulatedSettlement: false });
    [F, G] = R.founders;
    await R.store.grantServiceRole();
    await R.store.grantCustodyRole();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2, options: "-c search_path=fleet" });
    custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 2, options: "-c search_path=fleet" });
    expect((await R.econ(F, "venture.create", { key: "prints", model: "digital_product", offer: "prints", state: "selected" })).ok).toBe(true);
    rail = await liveRail(R.owner, "fleet", OWNER, { capabilities: ["payouts", "receive_payments", "refunds"] });
    gw = new PgCustodyGateway({ connectionString: R.pgc.custodyUrl });
    pp = fakeRefunds();
    worker = new PayPalTreasuryWorker(gw, new MemoryVault(new Map([[rail.vaultRef, "client-id:client-secret"]])), pp.http,
      { reconcileEveryMs: 1e12, balanceEveryMs: 1e12, spendGate: { allows: () => gateOpen } });
  }, 300_000);
  afterAll(async () => { await gw?.close(); await svc?.end(); await custody?.end(); await R?.close(); });

  it("routes the refund events; only the seller refunds its sale, within what is refundable, once per key; the amount stops being spendable", async () => {
    for (const [p, ts] of Object.entries(EVENT_ROUTES_V59)) for (const t of ts) expect(await R.one(`fleet.fleet_event_route($1, '{}'::jsonb)`, [t]), t).toBe(p === "P3_INFO" ? "P3_SUMMARY" : p); // v62: P3_INFO never reached Fleet Command
    const s = await sale(1_000);
    expect(await R.econ(G, "order.refund", { orderId: s.orderId, reason: "not mine", idempotencyKey: idem() })).toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    expect(await R.econ(F, "order.refund", { orderId: s.orderId, amountMinor: 1_001, reason: "too much", idempotencyKey: idem() }))
      .toMatchObject({ ok: false, code: "FLEET_REFUND_EXCEEDS_REFUNDABLE", refundableMinor: 1_000 });
    const sp0 = await spendable();
    const key = idem();
    const r = await R.econ(F, "order.refund", { orderId: s.orderId, amountMinor: 400, reason: "arrived damaged", idempotencyKey: key });
    expect(r).toMatchObject({ ok: true, refund: { status: "requested", amountMinor: 400 }, refundableAfterMinor: 600 });
    expect(r.note).toMatch(/once money-out is activated/);
    expect(await R.econ(F, "order.refund", { orderId: s.orderId, amountMinor: 400, reason: "arrived damaged", idempotencyKey: key })).toMatchObject({ ok: true, replay: true });
    expect(await spendable()).toBe(sp0 - 400);
    expect(await R.econ(F, "order.refund", { orderId: s.orderId, amountMinor: 700, reason: "and the rest", idempotencyKey: idem() }))
      .toMatchObject({ ok: false, code: "FLEET_REFUND_EXCEEDS_REFUNDABLE", refundableMinor: 600 });
  });

  it("nothing is sent before money-out is activated, nor while the live spend gate is closed; then one refund, posted once", async () => {
    const s = (await R.q(`SELECT o.order_id, c.checkout_id FROM fleet.fleet_customer_orders o JOIN fleet.fleet_paypal_checkouts c USING (checkout_id) WHERE o.agent_id = $1`, [F.id]))[0];
    await worker.tick();
    expect(pp.calls).toHaveLength(0);
    await R.one(`fleet.fleet_admin_custody_activate(5_000, 20_000, NULL, 'refunds and payouts', $1)`, [OWNER]);
    gateOpen = false;
    await worker.tick();
    expect(pp.calls).toHaveLength(0);
    expect((await request(s.order_id)).status).toBe("requested");
    gateOpen = true;
    const c0 = await cash();
    await worker.tick();
    expect(pp.calls).toHaveLength(1);
    expect(pp.calls[0].body).toMatchObject({ amount: { value: "4.00", currency_code: "GBP" }, note_to_payer: "arrived damaged" });
    const done = await request(s.order_id);
    expect(done).toMatchObject({ status: "completed" });
    expect(await cash()).toBe(c0 - 400);
    expect(await posted(s.checkout_id)).toBe(400);
    // PayPal's own webhook and Transaction Search row for the same refund post nothing more.
    const captureId = (await R.q(`SELECT capture_id FROM fleet.fleet_paypal_checkouts WHERE checkout_id = $1`, [s.checkout_id]))[0].capture_id;
    await cx("cx_paypal_clawback_evidence", [W, "webhook", done.paypal_refund_id, "refund", captureId, 400, "GBP"]);
    await cx("cx_paypal_txn_record", [W, rail.railId, JSON.stringify({ transactionId: done.paypal_refund_id, eventCode: "T1107", initiatedAt: new Date().toISOString(),
      status: "S", currency: "GBP", amountMinor: -400, feeMinor: 0, referenceId: captureId })]);
    await worker.tick();
    expect(await cash()).toBe(c0 - 400);
    expect(await posted(s.checkout_id)).toBe(400);
    expect(pp.calls).toHaveLength(1);
    expect((await R.econ(F, "order.list", { orderId: s.order_id })).orders[0]).toMatchObject({ payment: "partially_refunded", refundedMinor: 400 });
  });

  it("a refusal releases the reserve; an unknown outcome is retried with the same request id — one refund; the owner can refund", async () => {
    const s = await sale(900);
    const sp0 = await spendable();
    pp.set("refuse");
    expect((await R.econ(F, "order.refund", { orderId: s.orderId, amountMinor: 300, reason: "late delivery", idempotencyKey: idem() })).ok).toBe(true);
    await worker.tick();
    expect(await request(s.orderId)).toMatchObject({ status: "failed", failure_code: "REFUND_AMOUNT_EXCEEDED" });
    expect(await spendable()).toBe(sp0);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE event_type = 'order_refund_failed')`))).toBe(1);
    // Unknown, then retried (after the 10-minute wait) with the same PayPal-Request-Id.
    pp.set("error");
    expect((await R.econ(F, "order.refund", { orderId: s.orderId, reason: "customer asked", idempotencyKey: idem() })).refund.amountMinor).toBe(900);
    await worker.tick();
    expect((await request(s.orderId)).status).toBe("sent");
    pp.set("ok");
    await worker.tick();
    expect((await request(s.orderId)).status).toBe("sent"); // not yet due again
    await R.q(`UPDATE fleet.fleet_paypal_refund_requests SET updated_at = now() - interval '11 minutes' WHERE order_id = $1 AND status = 'sent'`, [s.orderId]);
    const c0 = await cash();
    await worker.tick();
    const tries = pp.calls.filter((c) => c.path.includes(s.captureId));
    expect(new Set(tries.slice(-2).map((c) => c.requestId)).size, JSON.stringify(tries.map((c) => c.requestId))).toBe(1);
    expect((await request(s.orderId)).status).toBe("completed");
    expect(await cash()).toBe(c0 - 900);
    expect(await posted(s.checkoutId)).toBe(900);
    expect(await R.econ(F, "order.refund", { orderId: s.orderId, amountMinor: 1, reason: "again", idempotencyKey: idem() })).toMatchObject({ code: "FLEET_REFUND_EXCEEDS_REFUNDABLE" });
    // The owner refunds another sale; owner-only.
    const o = await sale(500);
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_order_refund($1, NULL, 'goodwill', 'agent')`, [o.orderId]))).toBe("FLEET_APPROVAL_REQUIRED");
    expect(await R.one(`fleet.fleet_admin_order_refund($1, NULL, 'goodwill refund', $2)`, [o.orderId, OWNER])).toMatchObject({ ok: true, refund: { amountMinor: 500, requestedBy: OWNER } });
    await worker.tick();
    expect(await posted(o.checkoutId)).toBe(500);
    expect((await R.one(`fleet.fleet_ledger_verify()`)).ok).toBe(true);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });
});
