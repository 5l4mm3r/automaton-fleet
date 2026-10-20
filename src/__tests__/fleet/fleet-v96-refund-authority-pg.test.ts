/**
 * Schema v96 — custody enforces refund authority at dispatch (launch-readiness §1 row 22). PostgreSQL + the custody
 * PayPal worker against a fake Payments v2 refund API.
 *
 * Proven here: authorities are owner-only and fixed once granted; an order-scoped authority sends that order's refund and
 * no other; per-refund, 24-hour and total maxima hold, counting refunds waiting to be sent, sent, pending and completed
 * (a failed one frees its amount); an expired or ended authority sends nothing new and the owner is told once per
 * reason; two custody workers at once cannot exceed a limit; a refund already sent is re-checked with PayPal under the
 * same request id after its authority ends (never a second refund), while one bound but never sent waits for a live
 * authority and is bound again to it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { PgHubAdmin } from "../../fleet/hub/admin.js";
import { PgLedgerAdmin } from "../../fleet/treasury/ledger.js";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder, econNext, spendNext } from "./fixtures/economy-registry.js";
import { liveRail, type ArmedCustody } from "./fixtures/custody-signer.js";
import { PgCustodyGateway } from "../../fleet/custody/gateway.js";
import { PayPalTreasuryWorker } from "../../fleet/custody/paypal-treasury.js";
import type { HttpPort } from "../../fleet/custody/signers.js";
import { MemoryVault } from "../../fleet/payments/credential-broker.js";
import { EVENT_ROUTES_V96 } from "../../fleet/postgres/migrations-phase96.js";

const PG_BIN = findPgBin();

function fakeRefunds() {
  const byRequest = new Map<string, { id: string; value: string; currency: string }>();
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
      if (!r) { r = { id: `RF${crypto.randomBytes(5).toString("hex").toUpperCase()}`, value: body.amount.value, currency: body.amount.currency_code }; byRequest.set(rid, r); }
      return json(201, { id: r.id, status: "COMPLETED", amount: { value: r.value, currency_code: r.currency } });
    }
    if (u.pathname === "/v1/reporting/transactions") return json(200, { transaction_details: [], total_pages: 1 });
    if (u.pathname === "/v1/reporting/balances") return json(200, { balances: [] });
    return json(404, {});
  };
  return { http, calls, set: (m: "ok" | "refuse" | "error") => { mode = m; } };
}

describe.skipIf(!PG_BIN)("v96: custody enforces refund authority at dispatch", () => {
  let R: EconomyRegistry;
  let F: Founder;
  let custody: pg.Pool;
  let svc: pg.Pool;
  let rail: ArmedCustody;
  let gw: PgCustodyGateway;
  let pp: ReturnType<typeof fakeRefunds>;
  let gateOpen = true;
  let worker: PayPalTreasuryWorker;
  const W = "custody-executor";
  const cx = async (fn: string, args: unknown[], pool: pg.Pool = custody) => {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    return (await pool.query(`SELECT fleet.${fn}(${ph}) AS r`, args)).rows[0].r;
  };
  const id = (p: string) => `${p}${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
  const idem = () => `k-${crypto.randomUUID()}`;
  let asked = 0;
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
  const refund = async (orderId: string, amountMinor: number) => {
    // A distinct reason each time: the same order, amount and reason is the same operation (v95), answered from its record.
    const r = await econNext(R, F, "order.refund", { orderId, amountMinor, reason: `the buyer asked (${++asked})`, idempotencyKey: idem() });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return r.refund.refundRequestId as string;
  };
  const req = async (requestId: string) => (await R.q(`SELECT * FROM fleet.fleet_paypal_refund_requests WHERE request_id = $1`, [requestId]))[0];
  const grant = (scope: "standing" | string, max: number, daily: number, total: number | null, hours: number | null) =>
    R.one(`fleet.fleet_admin_refund_authority_grant($1, $2, $3, $4, $5, $6, 'test authority', $7)`,
      [scope === "standing" ? "standing" : "order", scope === "standing" ? null : scope, max, daily, total, hours, OWNER]);
  const waits = async (requestId: string) => (await R.q(`SELECT detail ->> 'reason' AS reason FROM fleet.fleet_events
      WHERE event_type = 'refund_awaiting_authority' AND detail ->> 'refundRequestId' = $1 ORDER BY created_at`, [requestId])).map((x: any) => x.reason as string);
  const sentFor = (captureId: string) => pp.calls.filter((c) => c.path.includes(captureId));

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 5_000, simulatedSettlement: false });
    [F] = R.founders;
    await R.store.grantServiceRole();
    await R.store.grantCustodyRole();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2, options: "-c search_path=fleet" });
    custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 4, options: "-c search_path=fleet" });
    expect((await R.econ(F, "venture.create", { key: "prints", model: "digital_product", offer: "prints", state: "selected" })).ok).toBe(true);
    rail = await liveRail(R.owner, "fleet", OWNER, { capabilities: ["payouts", "receive_payments", "refunds"] });
    gw = new PgCustodyGateway({ connectionString: R.pgc.custodyUrl });
    pp = fakeRefunds();
    worker = new PayPalTreasuryWorker(gw, new MemoryVault(new Map([[rail.vaultRef, "client-id:client-secret"]])), pp.http,
      { reconcileEveryMs: 1e12, balanceEveryMs: 1e12, spendGate: { allows: () => gateOpen } });
  }, 300_000);
  afterAll(async () => { await gw?.close(); await svc?.end(); await custody?.end(); await R?.close(); });

  it("v96 loads the capability entry agents read, rewritten from verified state (v14)", async () => {
    const e = (await R.q(`SELECT version, title, facts FROM fleet.fleet_knowledge_library WHERE entry_id = 'fleet-capability-status' AND current`))[0];
    expect(e).toMatchObject({ version: 14, title: expect.stringContaining("2026-10-19, v14") });
    const facts = JSON.stringify(e.facts);
    for (const t of ["Gumroad — DEFERRED", "Image generation — NOT CONNECTED", "Web search — CONNECTED (Brave", "within a live refund authority", "AS THE CUSTOMER SEES THEM"]) expect(facts).toContain(t);
  });

  it("owner-only, fixed grants; an order authority sends that order's refund only, within its per-refund and total maxima; the owner is told once", async () => {
    for (const [p, ts] of Object.entries(EVENT_ROUTES_V96)) for (const t of ts) expect(await R.one(`fleet.fleet_event_route($1, '{}'::jsonb)`, [t]), t).toBe(p);
    const a = await sale(1_000);
    const b = await sale(1_000);
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_refund_authority_grant('order', $1, 500, 500, 500, 2, 'proof', 'agent')`, [a.orderId]))).toBe("FLEET_APPROVAL_REQUIRED");
    expect(await R.code(grant(a.orderId, 500, 500, null, 2))).toBe("FLEET_BAD_REQUEST");          // an order authority states a total
    expect(await R.code(grant(a.orderId, 500, 500, 500, 500))).toBe("FLEET_BAD_REQUEST");         // ≤ 168 h
    const g = await grant(a.orderId, 500, 500, 500, 2);
    expect(g).toMatchObject({ ok: true, scope: "order", orderId: a.orderId, currency: "GBP" });
    expect(await R.code(R.q(`UPDATE fleet.fleet_refund_authorities SET max_total_minor = 5000 WHERE authority_id = $1`, [g.authorityId]))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await R.code(R.q(`DELETE FROM fleet.fleet_refund_authorities WHERE authority_id = $1`, [g.authorityId]))).toBe("FLEET_HISTORY_IMMUTABLE");

    const other = await refund(b.orderId, 300);          // another order: no authority covers it
    const tooBig = await refund(a.orderId, 600);         // the proof order, over its per-refund maximum
    await worker.tick(); await worker.tick();
    expect(sentFor(b.captureId)).toHaveLength(0);
    expect(sentFor(a.captureId)).toHaveLength(0);
    expect(await waits(other)).toEqual(["no live refund authority covers this order"]);          // told once, not per tick
    expect((await waits(tooBig))[0]).toMatch(/^over the per-refund maximum of the order refund authority \(500\)/);
    expect(await req(other)).toMatchObject({ status: "requested", authority_id: null });

    const ok = await refund(a.orderId, 400);             // within: bound and sent
    await worker.tick();
    expect(await req(ok)).toMatchObject({ status: "completed", authority_id: g.authorityId });
    expect(sentFor(a.captureId)).toHaveLength(1);
    const over = await econNext(R, F, "order.refund", { orderId: a.orderId, reason: "rest", idempotencyKey: idem() });
    expect(over).toMatchObject({ ok: false, code: "FLEET_REFUND_EXCEEDS_REFUNDABLE" });  // 1000 − 400 sent − 600 waiting
    // The waiting 600 is still over the per-refund maximum; it never leaves under this authority.
    await worker.tick();
    expect(await req(tooBig)).toMatchObject({ status: "requested", authority_id: null });
    expect((await R.one(`fleet.fleet_custody_status()`)).refundAuthorities).toEqual([expect.objectContaining({ authorityId: g.authorityId, scope: "order",
      used: { dailyMinor: 400, totalMinor: 400, refunds: 1 } })]);
    expect((await R.one(`fleet.fleet_admin_refund_authority_end($1, 'proof finished', $2)`, [g.authorityId, OWNER]))).toMatchObject({ ok: true });
    expect((await R.one(`fleet.fleet_custody_status()`)).refundAuthorities).toEqual([]);
  });

  it("a standing authority: 24-hour maximum counts waiting, sent, pending and completed refunds; a failed one frees its amount; an expired one sends nothing", async () => {
    const s = await sale(2_000);
    const g = await grant("standing", 500, 800, null, null);
    pp.set("refuse");
    const refused = await refund(s.orderId, 500);
    await worker.tick();
    expect(await req(refused)).toMatchObject({ status: "failed", authority_id: g.authorityId });    // nothing left: not counted
    pp.set("ok");
    const r1 = await refund(s.orderId, 500);
    await worker.tick();
    expect(await req(r1)).toMatchObject({ status: "completed" });
    // A pending one (PayPal has not finished it) counts too.
    const r2 = await refund(s.orderId, 300);
    gateOpen = false;                                    // bound, then held by the live spend gate: still counted
    await worker.tick();
    expect(await req(r2)).toMatchObject({ status: "requested", authority_id: g.authorityId });
    const r3 = await refund(s.orderId, 100);
    await worker.tick();
    expect(await req(r3)).toMatchObject({ status: "requested", authority_id: null });               // 500 + 300 + 100 > 800
    expect((await waits(r3))[0]).toMatch(/^over the 24-hour maximum of the standing refund authority \(800; 800 used\)/);
    gateOpen = true;
    await worker.tick();
    expect(await req(r2)).toMatchObject({ status: "completed" });
    expect(await req(r3)).toMatchObject({ status: "requested", authority_id: null });
    // Expired (the clock moved past it): nothing new leaves; the owner is told the new reason once.
    await R.q(`ALTER TABLE fleet.fleet_refund_authorities DISABLE TRIGGER fleet_refund_authorities_guard`);
    await R.q(`UPDATE fleet.fleet_refund_authorities SET granted_at = now() - interval '3 hours', expires_at = now() - interval '1 minute' WHERE authority_id = $1`, [g.authorityId]);
    await R.q(`ALTER TABLE fleet.fleet_refund_authorities ENABLE TRIGGER fleet_refund_authorities_guard`);
    await worker.tick(); await worker.tick();
    expect(await req(r3)).toMatchObject({ status: "requested", authority_id: null });
    expect(await waits(r3)).toHaveLength(2);
    expect((await waits(r3))[1]).toBe("no live refund authority covers this order");
    // A new standing grant (the expired one is superseded) sends it.
    const g2 = await grant("standing", 500, 800, null, null);
    await worker.tick();
    expect(await req(r3)).toMatchObject({ status: "completed", authority_id: g2.authorityId });
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_refund_authorities WHERE ended_at IS NULL)`))).toBe(1);
  });

  it("two custody workers at once cannot exceed a limit", async () => {
    const x = await sale(1_000);
    const y = await sale(1_000);
    const g = await grant("standing", 400, 400, null, null);
    const rx = await refund(x.orderId, 300);
    const ry = await refund(y.orderId, 300);
    const [w1, w2] = await Promise.all([cx("cx_paypal_refund_work", ["custody-a", 10]), cx("cx_paypal_refund_work", ["custody-b", 10])]);
    // Possibly handed to both workers (the same PayPal-Request-Id: one refund), never both refunds: the limit holds.
    const handed = new Set([...w1, ...w2].filter((w: any) => [rx, ry].includes(w.refundRequestId)).map((w: any) => w.refundRequestId));
    expect(handed.size).toBe(1);
    const bound = (await R.q(`SELECT request_id FROM fleet.fleet_paypal_refund_requests WHERE authority_id = $1`, [g.authorityId]));
    expect(bound).toHaveLength(1);
    expect(Number(await R.one(`(SELECT sum(amount_minor) FROM fleet.fleet_paypal_refund_requests WHERE authority_id = $1)`, [g.authorityId]))).toBe(300);
    // A repeated work call hands out the bound one again (the worker never sent it) and binds nothing more.
    const again = (await cx("cx_paypal_refund_work", ["custody-a", 10])).filter((w: any) => [rx, ry].includes(w.refundRequestId));
    expect(again.map((w: any) => w.refundRequestId)).toEqual([bound[0].request_id]);
    expect(again[0]).toMatchObject({ retry: false, authorityId: g.authorityId });
    await worker.tick();
    expect((await R.q(`SELECT status FROM fleet.fleet_paypal_refund_requests WHERE request_id = ANY ($1::uuid[]) ORDER BY status`, [[rx, ry]])).map((r: any) => r.status))
      .toEqual(["completed", "requested"]);
    await R.one(`fleet.fleet_admin_refund_authority_end($1, 'done', $2)`, [g.authorityId, OWNER]);
  });

  it("after its authority ends: a refund already sent is re-checked with the same request id (one refund); one bound but never sent waits and is bound again", async () => {
    const s = await sale(1_000);
    const g = await grant("standing", 500, 1_000, null, null);
    pp.set("error");
    const sent = await refund(s.orderId, 300);
    await worker.tick();
    expect(await req(sent)).toMatchObject({ status: "sent", authority_id: g.authorityId });
    pp.set("ok");
    gateOpen = false;
    const unsent = await refund(s.orderId, 200);
    await worker.tick();
    expect(await req(unsent)).toMatchObject({ status: "requested", authority_id: g.authorityId });
    await R.one(`fleet.fleet_admin_refund_authority_end($1, 'owner stopped refunds', $2)`, [g.authorityId, OWNER]);
    gateOpen = true;
    await R.q(`UPDATE fleet.fleet_paypal_refund_requests SET updated_at = now() - interval '11 minutes' WHERE request_id = $1`, [sent]);
    await worker.tick();
    expect(await req(sent)).toMatchObject({ status: "completed" });
    const tries = sentFor(s.captureId);
    expect(new Set(tries.filter((t) => t.body.amount.value === "3.00").map((t) => t.requestId)).size).toBe(1);
    expect(await req(unsent)).toMatchObject({ status: "requested", authority_id: g.authorityId });   // waits: its authority ended
    expect(tries.filter((t) => t.body.amount.value === "2.00")).toHaveLength(0);
    expect(await R.code(R.q(`UPDATE fleet.fleet_paypal_refund_requests SET authority_id = NULL, authorised_at = NULL WHERE request_id = $1`, [unsent]))).toBe("FLEET_IMMUTABLE");
    const g2 = await grant("standing", 500, 1_000, null, null);
    await worker.tick();
    expect(await req(unsent)).toMatchObject({ status: "completed", authority_id: g2.authorityId });
    expect(await R.code(R.q(`UPDATE fleet.fleet_paypal_refund_requests SET authority_id = $2 WHERE request_id = $1`, [sent, g2.authorityId]))).toBe("FLEET_IMMUTABLE");
    expect((await R.one(`fleet.fleet_ledger_verify()`)).ok).toBe(true);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });

  it("v103: PayPal's outcome for the agent's refund wakes it and is listed; its own request does not; the request's note is true", async () => {
    // Owner, 2026-10-20: the agent confirms a refund to the buyer only after PayPal verifies it — so PayPal's answer must reach it.
    const s = await sale(1_000);
    await grant(s.orderId, 1_000, 1_000, 1_000, 2);
    const attention = async () => (await R.one<any>(`fleet.fleet_agent_attention($1)`, [F.id])) as { eventsDigest: string; recentEvents: Array<Record<string, unknown>> };
    const d0 = (await attention()).eventsDigest;
    const r = await econNext(R, F, "order.refund", { orderId: s.orderId, amountMinor: 1_000, reason: "the buyer asked for a full refund", idempotencyKey: idem() });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.note).toMatch(/under a refund authority the owner grants.*You are woken when PayPal completes or fails it.*tell the buyer it is complete only then/s);
    expect(r.note).not.toMatch(/money-out is activated/);
    expect((await attention()).eventsDigest).toBe(d0);                       // its own request is not news
    await worker.tick();
    expect(await req(r.refund.refundRequestId)).toMatchObject({ status: "completed" });
    const after = await attention();
    expect(after.eventsDigest).not.toBe(d0);                                 // PayPal's outcome is
    expect(after.recentEvents).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "refund", id: r.refund.refundRequestId, status: "completed", tool: "wallet orders" })]));
  });

  it("2026-10-20 rerun combination: the spend circuit breaker tripped — a purchase is rejected before any reservation — while the order-only £5 refund is still sent and completed", async () => {
    const s = await sale(500);
    const g = await grant(s.orderId, 500, 500, 500, 2);                                    // the rerun's window: this order, £5, £5 total, 2 h
    const hub = new PgHubAdmin({ connectionString: R.pgc.ownerUrl });
    try {
      expect(await hub.spendBreaker(true, "purchase proof rerun: purchases are excluded from this run", OWNER)).toMatchObject({ tripped: true });
      const vendor = await R.econ(F, "vendor.register", { vendorName: "Print partner", category: "manufacturer", reference: "billing@printpartner.example", ventureKey: "prints" });
      expect(vendor.ok, JSON.stringify(vendor)).toBe(true);
      const cash0 = await R.one<number>(`fleet.fleet_ledger_balance(fleet.fleet_ledger_account($1, 'agent_cash'))::int`, [F.id]);
      const buy = await spendNext(R, F, { idempotencyKey: `s:${crypto.randomUUID()}`, amountCents: 100, category: "expense", destinationId: vendor.destinationId, purpose: "a purchase in an excluded run" });
      expect(buy).toMatchObject({ ok: false, code: "FLEET_INFRASTRUCTURE_CIRCUIT_BREAKER", order: { status: "rejected" } });
      expect(await R.one<number>(`fleet.fleet_ledger_balance(fleet.fleet_ledger_account($1, 'agent_cash'))::int`, [F.id])).toBe(cash0);   // nothing reserved
      // The agent's own refund of that order, under its order-only authority, while the breaker stays tripped.
      const r = await econNext(R, F, "order.refund", { orderId: s.orderId, amountMinor: 500, reason: "the buyer asked for a full refund", idempotencyKey: idem() });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      await worker.tick();
      expect(await req(r.refund.refundRequestId)).toMatchObject({ status: "completed", authority_id: g.authorityId, requested_by: "agent" });
      expect(sentFor(s.captureId)).toHaveLength(1);
      expect((await R.one<any>(`(SELECT to_jsonb(b) FROM fleet.fleet_spend_circuit_breaker b WHERE id = 1)`)).tripped).toBe(true);
    } finally {
      await hub.spendBreaker(false, null, OWNER);
      await hub.close();
    }
  });

  it("2026-10-20 test funding: a deposit on PayPal's own record is recorded as owner funding of exactly its net, then attributed (counted once)", async () => {
    const txn = id("DEP");
    await cx("cx_paypal_txn_record", [W, rail.railId, JSON.stringify({ transactionId: txn, eventCode: "T0300", initiatedAt: new Date().toISOString(), status: "S", currency: "GBP", amountMinor: 1100, feeMinor: -27 })]);
    const row = (await R.q(`SELECT amount_minor, fee_minor, status, attributed_at FROM fleet.fleet_paypal_transactions WHERE transaction_id = $1`, [txn]))[0];
    expect(row).toMatchObject({ status: "S", attributed_at: null });
    const net = Number(row.amount_minor) + Number(row.fee_minor);
    expect(net).toBe(1073);
    const capital0 = await R.one<number>(`fleet.fleet_ledger_balance('fleet:owner:capital')::int`);
    const ledger = new PgLedgerAdmin({ connectionString: R.pgc.ownerUrl });
    const hub = new PgHubAdmin({ connectionString: R.pgc.ownerUrl });
    try {
      await ledger.recordOwnerFunding(net, `paypal:deposit:${txn}`, OWNER);
      expect(await hub.paypalAttribute(rail.railId, txn, "T0300", "owner_funding", `paypal:deposit:${txn}`, OWNER)).toMatchObject({ ok: true, rows: 1 });
      expect(await R.one<number>(`fleet.fleet_ledger_balance('fleet:owner:capital')::int`)).toBe(capital0 + 1073);     // once, exactly the net
      await expect(ledger.recordOwnerFunding(net, `paypal:deposit:${txn}`, OWNER)).rejects.toThrow(/ALREADY_CLAIMED|duplicate key/i);   // never twice (the reference is unique)
      await expect(hub.paypalAttribute(rail.railId, txn, "T0300", "owner_funding", `paypal:deposit:${txn}`, OWNER)).rejects.toThrow(/NOT_FOUND/);
    } finally { await ledger.close?.(); await hub.close(); }
  });
});
