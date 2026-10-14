/**
 * v77 — treasury integrity (PostgreSQL). Real outflows the Fleet starts — payout instructions and refunds — fit the PayPal cash
 * actually AVAILABLE (custody's latest Balances reading, at most 3 hours old), less what is already committed to leave (issued /
 * claimed payouts, refunds requested or sent, the card balance still to repay). Ledger wallets — which may hold unbacked owner
 * capital — never authorise real cash on their own; two agents cannot both spend the same cash; a payment short of cash WAITS
 * (still reserved: not a failure, not exhaustion) and is noted once; a stale balance is never relied on. The ongoing custody mode
 * (an activation with no maxima, O19) is what is exercised.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { attest, liveRail, type ArmedCustody } from "./fixtures/custody-signer.js";

const PG_BIN = findPgBin();
const W = "custody-executor";

describe.skipIf(!PG_BIN)("v77 treasury liquidity: real outflows fit available PayPal cash (PostgreSQL)", { timeout: 240_000 }, () => {
  let R: EconomyRegistry;
  let F: Founder;
  let G: Founder;
  let svc: pg.Pool;
  let custody: pg.Pool;
  let rail: ArmedCustody;
  const dest: Record<string, string> = {};
  const cx = async (fn: string, args: unknown[]) => {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    return (await custody.query(`SELECT fleet.${fn}(${ph}) AS r`, args)).rows[0].r;
  };
  const balance = (available: number) => cx("cx_paypal_balance_record", [W, rail.railId, "GBP", available, available]);
  const issueDue = async () => (await svc.query(`SELECT fleet.svc_issue_due_instructions(50) AS r`)).rows[0].r;
  const status = async (orderId: string) => (await R.q(`SELECT status FROM fleet.fleet_payment_orders WHERE order_id = $1`, [orderId]))[0].status;
  const liquidity = () => R.one<any>(`fleet.fleet_treasury_liquidity($1)`, [rail.railId]);
  const spend = async (who: Founder, amountCents: number) => {
    const r = await R.gw.spendRequest(who.id, who.token, { idempotencyKey: `s:${crypto.randomUUID()}`, amountCents, category: "expense", destinationId: dest[who.id], purpose: "venture cost" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return (r.order as { orderId: string }).orderId;
  };

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000, simulatedSettlement: false });
    // The review itself is proven in fleet-spend-review-v64-pg; here every order is routine.
    await R.q(`UPDATE fleet.fleet_spend_review_policy SET material_share_bp = 10000, material_aggregate_bp = 100000, low_runway_days = 0, new_payee_hours = 0, duplicate_window_h = 1`);
    [F, G] = R.founders;
    await R.store.grantServiceRole();
    await R.store.grantCustodyRole();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2, options: "-c search_path=fleet" });
    custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 2, options: "-c search_path=fleet" });
    for (const [who, key] of [[F, "prints"], [G, "cv-templates"]] as const) {
      expect((await R.econ(who, "venture.create", { key, model: "digital_product", offer: key, state: "selected" })).ok).toBe(true);
    }
    rail = await liveRail(R.owner, "fleet", OWNER, { capabilities: ["payouts", "receive_payments", "refunds"] });
    // The ongoing mode: an owner activation with NO maxima (v64 / O19) — liquidity, not a fixed cap, bounds real cash.
    expect((await R.q(`SELECT fleet.fleet_admin_custody_activate(NULL, NULL, 24, 'ongoing mode test', $1) AS r`, [OWNER]))[0].r).toMatchObject({ ok: true });
    expect((await attest(custody, "fleet", rail)).ok).toBe(true);
    for (const [who, key] of [[F, "prints"], [G, "cv-templates"]] as const) {
      dest[who.id] = (await R.econ(who, "vendor.register", { vendorName: `Supplier of ${key}`, category: "manufacturer", provider: "paypal",
        reference: `paypal:${key}@example.com`, ventureKey: key })).destinationId as string;
    }
  });
  afterAll(async () => { await svc?.end(); await custody?.end(); await R?.close(); });

  it("unbacked ledger money never pays out: with no PayPal balance read, a payment waits — still reserved, not exhaustion — and is noted once", async () => {
    const o = await spend(F, 3_000);
    expect(await issueDue()).toMatchObject({ issued: 0, waiting: { FLEET_TREASURY_LIQUIDITY: 1 } });
    expect(await issueDue()).toMatchObject({ issued: 0 });
    expect(await status(o)).toBe("reserved");
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE event_type = 'treasury_liquidity_wait' AND detail ->> 'ref' = $1)`, [o]))).toBe(1);
    expect(await R.one(`fleet.fleet_event_route('treasury_liquidity_wait', '{}'::jsonb)`)).toBe("P2_IMPORTANT");
    const m = await R.one<any>(`fleet.fleet_agent_wallet_measure($1)`, [F.id]);
    expect(m.exhausted).toBe(false);                              // a reservation is the agent's own money, never death
    expect((await liquidity()).stale).toBe(true);
  });

  it("available cash, less what is committed, bounds every payout; two agents cannot spend the same cash", async () => {
    await balance(5_000);                                          // £50 available
    expect(await issueDue()).toMatchObject({ issued: 1 });         // F's £30 now fits
    expect(await liquidity()).toMatchObject({ availableMinor: 5_000, stale: false, committed: { paymentsInFlightMinor: 3_000 }, freeMinor: 2_000 });
    const g = await spend(G, 3_000);                               // G's own wallet has £100 — but only £20 of real cash is free
    expect(await issueDue()).toMatchObject({ issued: 0, waiting: { FLEET_TREASURY_LIQUIDITY: 1 } });
    expect(await status(g)).toBe("reserved");
    await balance(10_000);                                         // more cash available
    expect(await issueDue()).toMatchObject({ issued: 1 });
    expect(await status(g)).toBe("executing");
    expect((await liquidity()).freeMinor).toBe(10_000 - 6_000);
  });

  it("a stale balance is not relied on; the card balance still to repay is committed cash", async () => {
    await R.q(`ALTER TABLE fleet.fleet_paypal_balance_observations DISABLE TRIGGER USER`);
    await R.q(`UPDATE fleet.fleet_paypal_balance_observations SET observed_at = now() - interval '4 hours'`);
    await R.q(`ALTER TABLE fleet.fleet_paypal_balance_observations ENABLE TRIGGER USER`);
    const o = await spend(F, 500);
    expect(await issueDue()).toMatchObject({ issued: 0, waiting: { FLEET_TREASURY_LIQUIDITY: 1 } });
    expect((await liquidity()).stale).toBe(true);
    await balance(6_600);                                          // fresh again: 6,600 − 6,000 in flight = 600 free
    expect((await liquidity()).freeMinor).toBe(600);
    // A card charge waiting to be repaid from the treasury is committed: it is not spendable cash.
    expect(Number(await R.one(`fleet.fleet_ledger_balance('fleet:card:payable')`))).toBe(0);
    const src = await R.one<string>(`(SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'fleet' AND p.proname = 'fleet_treasury_liquidity')`);
    expect(src).toContain("fleet_ledger_balance('fleet:card:payable')");
    expect(await issueDue()).toMatchObject({ issued: 1 });         // 500 ≤ 600
    expect(await status(o)).toBe("executing");
  });

  it("money owed to the owner (AI credit their card paid) is never agents' cash; the owner's reimbursement is recorded once, at most what is owed", async () => {
    // What v69 books when the owner's card pays for AI credit (the opening kind, as the owner's own posting).
    await R.q(`SELECT fleet.fleet_ledger_post('ai_credit_owner_payable_opening', 'test-owed', $1, 'test: owed to the owner', 'owner', NULL, NULL, NULL, NULL, NULL, now(),
      jsonb_build_array(jsonb_build_object('account', 'fleet:treasury:owner_reimbursable', 'side', 'D', 'amount', 400),
                        jsonb_build_object('account', 'fleet:owner:payable', 'side', 'C', 'amount', 400)))`, [OWNER]);
    const before = await liquidity();
    expect(before.committed.owedToOwnerMinor).toBe(400);
    const reimb = (amt: number, ref: string) => R.q(`SELECT fleet.fleet_admin_owner_payable_reimbursed($1, $2, $3) AS r`, [amt, ref, OWNER]).then((x) => x[0].r);
    await expect(reimb(401, "PAYTXN00001")).rejects.toThrow(/FLEET_BAD_REQUEST: at most what is owed/);
    await expect(svc.query(`SELECT fleet.fleet_admin_owner_payable_reimbursed(100, 'PAYTXN00002', $1)`, [OWNER])).rejects.toThrow(/permission denied/);
    expect(await reimb(300, "PAYTXN00001")).toMatchObject({ ok: true, reimbursedMinor: 300, stillOwedMinor: 100 });
    expect(await reimb(300, "PAYTXN00001")).toMatchObject({ ok: true, replay: true });         // the same PayPal payment, once
    expect((await liquidity()).committed.owedToOwnerMinor).toBe(100);
    expect(Number(await R.one(`fleet.fleet_ledger_balance('fleet:treasury:owner_reimbursable')`))).toBe(100);
  });

  it("refunds the Fleet sends wait for available cash too; the privilege audit stays clean", async () => {
    const c = await R.econ(F, "paypal.checkout", { venture: "prints", amountMinor: 2_000, description: "Art print", fulfilment: "service", idempotencyKey: `k-${crypto.randomUUID()}` });
    const checkoutId = c.checkout.checkoutId as string;
    const ord = `ORD${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
    await cx("cx_paypal_checkout_update", [W, checkoutId, "open", ord, `https://www.paypal.com/checkoutnow?token=${ord}`, null]);
    await cx("cx_paypal_checkout_update", [W, checkoutId, "approved", null, null, null]);
    expect((await cx("cx_paypal_capture_record", [W, checkoutId, `CAP${crypto.randomBytes(6).toString("hex").toUpperCase()}`, "COMPLETED", 2_000, 0, "GBP", "webhook"])).ok).toBe(true);
    const r = await R.econ(F, "order.refund", { orderId: c.order.orderId, amountMinor: 1_500, reason: "arrived damaged", idempotencyKey: `k-${crypto.randomUUID()}` });
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    // Free cash is 600 (see above) — the £15 refund waits, noted once.
    expect(await cx("cx_paypal_refund_work", [W, 10])).toEqual([]);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE event_type = 'treasury_liquidity_wait' AND detail ->> 'kind' = 'refund')`))).toBe(1);
    await balance(20_000);
    const work = await cx("cx_paypal_refund_work", [W, 10]);
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({ amountMinor: 1_500 });
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });
});

describe.skipIf(!PG_BIN)("v77 envelope spending: the same contextual Fleet Control review as own capital (PostgreSQL)", { timeout: 240_000 }, () => {
  let R: EconomyRegistry;
  let F: Founder;
  const ev = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "sales", observation: `evidence ${i}`, source: "https://example.test" }));
  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 20_000, treasuryCents: 1_000_000 });
    [F] = R.founders;
    await R.store.grantServiceRole();
    await R.econ(F, "venture.create", { key: "planners", model: "digital_product", offer: "planners", state: "selected", channels: ["direct"] });
    await R.econ(F, "rail.require", { ventureKey: "planners" });
  });
  afterAll(async () => { await R?.close(); });

  it("a new agent with no track record gets evidence-backed capital; a material envelope spend waits for the automated review, a routine one does not", async () => {
    const d = await R.econ(F, "capital.request", { idempotencyKey: `cr:${crypto.randomUUID()}`, ventureKey: "planners", purpose: "first print run for a validated product",
      amountMinor: 5_000, evidence: ev(3), expectedRevenueMinor: 15_000, expectedNetMinor: 5_000, expectedPaybackDays: 30, downsideMinor: 5_000, confidenceBp: 7000 });
    expect(d, JSON.stringify(d)).toMatchObject({ ok: true, outcome: expect.stringMatching(/^(APPROVE|APPROVE_WITH_LIMITS|PARTIAL_APPROVE)$/) });
    const env = (await R.econ(F, "envelope.list")).envelopes[0];
    const payee = (await R.econ(F, "vendor.register", { vendorName: "Printer", category: "supplier", reference: "printer@supplier.example" })).destinationId;
    const spend = (amount: number) => R.econ(F, "envelope.spend", { envelopeId: env.envelopeId, amountMinor: amount, category: "expense", destinationId: payee,
      purpose: "print run", idempotencyKey: `k:${crypto.randomUUID()}` });
    // Routine (review triggers off): reserved and payable, no review.
    await R.q(`UPDATE fleet.fleet_spend_review_policy SET material_share_bp = 10000, material_aggregate_bp = 100000, low_runway_days = 0, new_payee_hours = 0, duplicate_window_h = 1`);
    const routine = await spend(100);
    expect(routine, JSON.stringify(routine)).toMatchObject({ ok: true, order: { status: "reserved" } });
    expect(routine.order.reviewStatus ?? "not_required").toBe("not_required");
    // Material (everything counts as material): reserved, and Fleet Control reviews it before it can be paid.
    await R.q(`UPDATE fleet.fleet_spend_review_policy SET material_share_bp = 1`);
    const material = await spend(200);
    expect(material, JSON.stringify(material)).toMatchObject({ ok: true, order: { status: "reserved", reviewStatus: "pending" }, note: expect.stringContaining("Fleet Control is reviewing") });
    expect((await R.q(`SELECT review_status FROM fleet.fleet_payment_orders WHERE order_id = $1`, [material.order.orderId]))[0].review_status).toBe("pending");
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });
});
