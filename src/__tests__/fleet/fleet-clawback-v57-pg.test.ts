/**
 * Schema v57 — PayPal refunds, reversals, chargebacks, dispute holds and fees reconciled from evidence; the card receipt's
 * swept share. PostgreSQL; custody is its database role, called directly.
 *
 * Proven here: the same refund reported by a webhook and by Transaction Search (under different ids) is posted once, and a
 * further one only Search shows is posted; a dispute holds the disputed amount back from what the agent can spend (survival
 * equity) while counting it as the agent's own money held (no death from a dispute alone); a lost dispute stays held until
 * the reversal posts, then the exposure ends without a second deduction; PayPal's dispute hold / release rows alone work the
 * same; an ambiguous outcome is the owner's to resolve; a chargeback won back and a fee reversed come back once; an
 * unclassified debit is held back until the owner classifies it; a returned card receipt's swept share stays in the
 * treasury unless the owner explicitly keeps it (an owner withdrawal), which is refused when the money only reduced the card.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { liveRail, type ArmedCustody } from "./fixtures/custody-signer.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";
import { EVENT_ROUTES_V57 } from "../../fleet/postgres/migrations-phase57.js";

const PG_BIN = findPgBin();

describe.skipIf(!PG_BIN)("v57: clawbacks reconciled from evidence; disputes held back; the card receipt's sweep (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let F: Founder;
  let svc: pg.Pool;
  let custody: pg.Pool;
  let rail: ArmedCustody;
  const W = "custody-executor";
  const cx = async (fn: string, args: unknown[]) => {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    return (await custody.query(`SELECT fleet.${fn}(${ph}) AS r`, args)).rows[0].r;
  };
  const id = (p: string) => `${p}${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
  const cash = () => R.balance(`agent:${F.id}:cash`);
  const eco = () => R.one(`fleet.fleet_agent_economics($1)`, [F.id]);
  const measure = () => R.one(`fleet.fleet_agent_wallet_measure($1)`, [F.id]);
  const events = async (type: string) => Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE event_type = $1)`, [type]));
  const posted = async (checkoutId: string, grp: string) => Number(await R.one(`(SELECT COALESCE(sum(amount_minor), 0) FROM fleet.fleet_paypal_clawback_posts WHERE checkout_id = $1 AND grp = $2)`, [checkoutId, grp]));
  const txn = (captureId: string, eventCode: string, amountMinor: number, tid = id("T")) => cx("cx_paypal_txn_record", [W, rail.railId, JSON.stringify({
    transactionId: tid, eventCode, initiatedAt: new Date().toISOString(), status: "S", currency: "GBP", amountMinor, feeMinor: 0, referenceId: captureId })]);
  /** A sale, captured and (PayPal shows it) available in the agent's cash. */
  const sale = async (amountMinor: number) => {
    const c = await R.econ(F, "paypal.checkout", { venture: "prints", amountMinor, description: "Art print", idempotencyKey: `k-${crypto.randomUUID()}` });
    const checkoutId = c.checkout.checkoutId as string;
    const order = id("ORD");
    await cx("cx_paypal_checkout_update", [W, checkoutId, "open", order, `https://www.paypal.com/checkoutnow?token=${order}`, null]);
    await cx("cx_paypal_checkout_update", [W, checkoutId, "approved", null, null, null]);
    const captureId = id("CAP");
    expect((await cx("cx_paypal_capture_record", [W, checkoutId, captureId, "COMPLETED", amountMinor, 0, "GBP", "webhook"])).ok).toBe(true);
    await cx("cx_paypal_txn_record", [W, rail.railId, JSON.stringify({ transactionId: captureId, eventCode: "T0006", initiatedAt: new Date().toISOString(),
      status: "S", currency: "GBP", amountMinor, feeMinor: 0, customField: checkoutId })]);
    await cx("cx_paypal_balance_record", [W, rail.railId, "GBP", 100_000_000, 100_000_000]);
    await svc.query(`SELECT fleet.svc_paypal_availability(100)`);
    return { checkoutId, captureId };
  };

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 5_000, simulatedSettlement: false });
    [F] = R.founders;
    await R.store.grantServiceRole();
    await R.store.grantCustodyRole();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2, options: "-c search_path=fleet" });
    custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 2, options: "-c search_path=fleet" });
    expect((await R.econ(F, "venture.create", { key: "prints", model: "digital_product", offer: "prints", state: "selected" })).ok).toBe(true);
    rail = await liveRail(R.owner, "fleet", OWNER);
  }, 300_000);
  afterAll(async () => { await svc?.end(); await custody?.end(); await R?.close(); });

  it("migrates to v57 with a clean audit; the new events are routed", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(57);
    expect(await R.one(`(SELECT max(version) FROM fleet.fleet_schema_migrations)`)).toBe(FLEET_PG_SCHEMA_VERSION);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    for (const [p, ts] of Object.entries(EVENT_ROUTES_V57)) for (const t of ts) expect(await R.one(`fleet.fleet_event_route($1, '{}'::jsonb)`, [t]), t).toBe(p === "P3_INFO" ? "P3_SUMMARY" : p); // v62: P3_INFO never reached Fleet Command
  });

  it("a refund reported by the webhook and by Transaction Search (different ids) is posted once; one only Search shows is posted", async () => {
    const s = await sale(2_000);
    const c0 = await cash();
    await cx("cx_paypal_clawback_evidence", [W, "webhook", "RFWEB00001", "refund", s.captureId, 500, "GBP"]);
    expect(await cash()).toBe(c0 - 500);
    await txn(s.captureId, "T1107", -500, "RFSEARCH0001"); // the same refund, as Search sees it
    expect(await cash()).toBe(c0 - 500);
    await txn(s.captureId, "T1107", -300, "RFSEARCH0002"); // a further refund no webhook reported
    expect(await cash()).toBe(c0 - 800);
    await cx("cx_paypal_clawback_evidence", [W, "webhook", "RFWEB00002", "refund", s.captureId, 300, "GBP"]); // its late webhook
    await cx("cx_paypal_clawback_evidence", [W, "webhook", "RFWEB00002", "refund", s.captureId, 300, "GBP"]); // redelivered
    expect(await cash()).toBe(c0 - 800);
    expect(await posted(s.checkoutId, "refund")).toBe(800);
    expect((await R.econ(F, "order.list", {})).orders.find((o: any) => o.checkoutId === s.checkoutId)).toMatchObject({ refundedMinor: 800, payment: "partially_refunded" });
  });

  it("a dispute holds the amount back from spending (not from survival); lost, it stays held until the reversal posts once", async () => {
    const s = await sale(1_000);
    const e0 = await eco();
    const sp0 = (await measure()).spendableMinor;
    expect((await cx("cx_paypal_dispute_record", [W, "PP-D-0001", s.captureId, "WAITING_FOR_SELLER_RESPONSE", null, 1_000, "GBP"])).exposureMinor).toBe(1_000);
    const e1 = await eco();
    expect(e1.paypalDisputeExposure).toBe(1_000);
    expect(Number(e1.survivalEquity)).toBe(Number(e0.survivalEquity) - 1_000);
    const m1 = await measure();
    expect(m1.spendableMinor).toBe(Math.max(0, sp0 - 1_000));
    expect(m1.ownHeldMinor.paypalDisputedMinor).toBe(1_000);
    expect(await events("paypal_dispute_opened")).toBe(1);
    // Lost: still held back until the reversal is posted from PayPal's evidence.
    await cx("cx_paypal_dispute_record", [W, "PP-D-0001", s.captureId, "RESOLVED", "RESOLVED_BUYER_FAVOUR", 1_000, "GBP"]);
    expect((await eco()).paypalDisputeExposure).toBe(1_000);
    const c1 = await cash();
    await txn(s.captureId, "T1201", -1_000); // the chargeback in Transaction Search
    expect(await cash()).toBe(c1 - 1_000);
    expect((await eco()).paypalDisputeExposure).toBe(0);
    await cx("cx_paypal_clawback_evidence", [W, "webhook", "RV0000000009", "reversal", s.captureId, 1_000, "GBP"]); // the REVERSED webhook
    expect(await cash()).toBe(c1 - 1_000);
    expect(await posted(s.checkoutId, "reversal")).toBe(1_000);
    // A final outcome is not reopened by a late update.
    expect(await cx("cx_paypal_dispute_record", [W, "PP-D-0001", s.captureId, "UNDER_REVIEW", null, 1_000, "GBP"])).toMatchObject({ unchanged: true, status: "lost" });
  });

  it("PayPal's own dispute hold and release; an ambiguous outcome waits for the owner; a won dispute releases", async () => {
    const s = await sale(700);
    await txn(s.captureId, "T1110", -700);
    expect((await eco()).paypalDisputeExposure).toBe(700);
    await txn(s.captureId, "T1111", 700);
    expect((await eco()).paypalDisputeExposure).toBe(0);
    await cx("cx_paypal_dispute_record", [W, "PP-D-0002", s.captureId, "OPEN", null, 700, "GBP"]);
    expect(await cx("cx_paypal_dispute_record", [W, "PP-D-0002", s.captureId, "RESOLVED", "SOMETHING_NEW", 700, "GBP"])).toMatchObject({ status: "unresolved", exposureMinor: 700 });
    expect(await events("paypal_dispute_unresolved")).toBeGreaterThanOrEqual(1);
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_paypal_dispute_resolve('PP-D-0002', 'won', NULL, 'agent')`))).toBe("FLEET_APPROVAL_REQUIRED");
    expect(await R.one(`fleet.fleet_admin_paypal_dispute_resolve('PP-D-0002', 'won', 'PayPal letter: seller protection', $1)`, [OWNER])).toMatchObject({ status: "won", exposureMinor: 0 });
    // Custody cannot overturn the owner's resolution.
    expect(await cx("cx_paypal_dispute_record", [W, "PP-D-0002", s.captureId, "OPEN", null, 700, "GBP"])).toMatchObject({ unchanged: true, status: "won" });
    expect((await eco()).paypalDisputeExposure).toBe(0);
  });

  it("a chargeback won back and a fee reversed come back once; an unclassified debit is held back until the owner classifies it", async () => {
    const s = await sale(1_200);
    const c0 = await cash();
    await txn(s.captureId, "T1201", -1_200, "CB0000000001");
    await txn(s.captureId, "T0106", -200, "CBFEE0000001");
    expect(await cash()).toBe(c0 - 1_400);
    await txn(s.captureId, "T1202", 1_200, "CBREV0000001");
    await txn(s.captureId, "T1108", 200, "FEEREV000001");
    await txn(s.captureId, "T1202", 1_200, "CBREV0000001"); // the same row read again
    expect(await cash()).toBe(c0);
    expect([await posted(s.checkoutId, "reversal"), await posted(s.checkoutId, "fee"), await posted(s.checkoutId, "reversal_return"), await posted(s.checkoutId, "fee_return")])
      .toEqual([1_200, 200, 1_200, 200]);
    expect((await R.econ(F, "order.list", {})).orders.find((o: any) => o.checkoutId === s.checkoutId)).toMatchObject({ payment: "paid" });
    // A debit under a code the Fleet does not classify: held back, raised, then classified by the owner (posted once).
    const x = await sale(900);
    await txn(x.captureId, "T9999", -150, "ODD000000001");
    expect((await eco()).paypalDisputeExposure).toBe(150);
    expect(await events("paypal_debit_unclassified")).toBe(1);
    const c1 = await cash();
    const d = await R.one(`fleet.fleet_paypal_disputes_json()`);
    expect(d.unclassified.map((u: any) => u.refId)).toEqual(["ODD000000001:T9999"]);
    expect(await R.one(`fleet.fleet_admin_paypal_debit_classify('ODD000000001:T9999', 'fee', 'PayPal currency fee', $1)`, [OWNER])).toMatchObject({ ok: true, posted: { fee: 150 } });
    expect(await cash()).toBe(c1 - 150);
    expect((await eco()).paypalDisputeExposure).toBe(0);
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_paypal_debit_classify('ODD000000001:T9999', 'fee', NULL, $1)`, [OWNER]))).toBe("FLEET_INVALID_STATE");
  });

  it("a returned card receipt's swept share stays in the treasury; the owner keeping it is explicit (an owner withdrawal) and never for card_balance", async () => {
    const tr0 = await R.balance("fleet:treasury:unallocated");
    const wd0 = await R.balance("fleet:owner:withdrawals");
    const a = await R.one(`fleet.fleet_admin_card_receipt_record($1, 2_000, 'revenue', 'card-in-v57-1', NULL, $2)`, [F.id, OWNER]);
    // v58: no default destination — the owner chooses each time.
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_card_receipt_settle($1, 'return', 'transfer', 100, 'pp-in-v57-1', $2)`, [a.receiptId, OWNER]))).toBe("FLEET_BAD_REQUEST");
    const ra = await R.one(`fleet.fleet_admin_card_receipt_settle($1, 'return', 'transfer', 100, 'pp-in-v57-1', $2, 'treasury')`, [a.receiptId, OWNER]);
    expect(ra).toMatchObject({ status: "returned", returnedMinor: 1_900, sweepMinor: 100, sweepTo: "treasury", ownerTransferMinor: 2_000 });
    expect(await R.balance("fleet:owner:withdrawals")).toBe(wd0);
    expect(await R.balance("fleet:treasury:unallocated")).toBe(tr0 + 100);
    const b = await R.one(`fleet.fleet_admin_card_receipt_record($1, 1_000, 'revenue', 'card-in-v57-2', NULL, $2)`, [F.id, OWNER]);
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_card_receipt_settle($1, 'return', 'card_balance', 100, NULL, $2, 'owner')`, [b.receiptId, OWNER]))).toBe("FLEET_BAD_REQUEST");
    const rb = await R.one(`fleet.fleet_admin_card_receipt_settle($1, 'return', 'transfer', 100, 'pp-in-v57-2', $2, 'owner')`, [b.receiptId, OWNER]);
    expect(rb).toMatchObject({ sweepTo: "owner", ownerTransferMinor: 900 });
    expect(await R.balance("fleet:owner:withdrawals")).toBe(wd0 + 100);
    const row = (await R.q(`SELECT sweep_to FROM fleet.fleet_card_receipts WHERE receipt_id IN ($1, $2) ORDER BY recorded_at`, [a.receiptId, b.receiptId])).map((r) => r.sweep_to);
    expect(row).toEqual(["treasury", "owner"]);
    expect((await R.one(`fleet.fleet_ledger_verify()`)).ok).toBe(true);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });
});
