/**
 * Schema v72 — the unrecoverable acquisition cost of AI credit (tax / fees from the receipt), allocated by consumption
 * (PostgreSQL; no provider, no money moves):
 *  - an agent's own work bears its share (agent expense / agent cash); owner conversations and Fleet Control reviews are
 *    treasury overhead; the funding side follows the lot (owner-funded → owed to the owner; treasury → the prepaid asset);
 *  - the rate comes from the lot's evidence (receipt total vs credit), never assumed: a lot without it adds nothing until the
 *    owner records it; the expense is recognised once; a treasury lot's settlement keeps only the FX difference;
 *  - the console reconciliation restores over-recorded usage to where it was drawn, never inventing a funding source.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { liveRail, type ArmedCustody } from "./fixtures/custody-signer.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";

const PG_BIN = findPgBin();
const USD = 100_000_000;

describe.skipIf(!PG_BIN)("v72: AI-credit acquisition cost allocated by consumption (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let F: Founder;
  let su: pg.Pool;
  let custody: pg.Pool;
  let rail: ArmedCustody;
  const W = "custody-executor";
  const cx = async (fn: string, args: unknown[]) => (await custody.query(`SELECT fleet.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) AS r`, args)).rows[0].r;
  const asSuper = async (sql: string, params: unknown[] = []) => {
    const c = await su.connect();
    try { await c.query("SET session_replication_role = replica"); return (await c.query(sql, params)).rows; } finally { await c.query("RESET session_replication_role"); c.release(); }
  };
  const bal = async (a: string) => Number(await R.one(`fleet.fleet_ledger_balance($1)`, [a]));
  const settle = () => R.one<Record<string, any>>(`fleet.svc_ai_credit_settle(20)`);
  /** An agent's own model call as the live path records it: its cognition record, then its provider consumption. */
  const agentCall = async (usd: number, payer = "agent") => {
    const req = crypto.randomUUID();
    await asSuper(`INSERT INTO fleet.fleet_cognition_log (request_id, agent_id, provider, model, outcome, input_tokens, output_tokens, cost_microcents, charged_cents,
        prompt_sha256, response_sha256, payer) VALUES ($1, $2, 'anthropic', 'claude-sonnet-5-5', 'ok', 1, 1, $3, 0, repeat('a', 64), repeat('b', 64), $4)`, [req, F.id, usd, payer]);
    // the pre-tax charge the live path posts (v69 legs; 1:1 test rate), then the provider consumption
    const pence = Math.round(usd / 1_000_000);
    const lines = payer === "agent"
      ? [[`agent:${F.id}:expense`, "D"], [`agent:${F.id}:cash`, "C"]]
      : [["fleet:expense", "D"], ["fleet:treasury:unallocated", "C"]];
    await R.one(`fleet.fleet_ledger_post($1, $2, 'controller', 'test charge', 'controller', $3, NULL, NULL, NULL, NULL, now(), $4::jsonb)`,
      [payer === "agent" ? "inference_charge" : "owner_conversation_charge", `test:${req}`, payer === "agent" ? F.id : null,
       JSON.stringify([...lines, ["fleet:treasury:owner_reimbursable", "D"], ["fleet:owner:payable", "C"]].map(([account, side]) => ({ account, side, amount: pence })))]);
    await R.q(`INSERT INTO fleet.fleet_provider_credit_events (provider, kind, usd_microcents, request_id, recorded_by) VALUES ('anthropic', 'consumption', $1, $2, 'controller')`, [-usd, req]);
  };
  const review = (usd: number) => R.one(`fleet.fleet_control_charge('knowledge_review_charge', $1, $2::jsonb)`,
    [crypto.randomUUID(), JSON.stringify([{ provider: "anthropic", requestId: crypto.randomUUID(), usdMicrocents: usd }])]);
  /** A confirmed owner-funded purchase from a receipt: $credit bought for $total charged (tax shown on the receipt). */
  const ownerPurchase = async (no: string, credit: number, total: number) => {
    const [{ receipt_id }] = await R.q(`INSERT INTO fleet.fleet_ai_credit_receipts (provider, receipt_no, usd_cents, tax_cents, total_cents) VALUES ('anthropic', $1, $2, $3, $4) RETURNING receipt_id`,
      [no, credit, total - credit, total]);
    expect((await R.one<Record<string, any>>(`fleet.fleet_admin_ai_credit_confirm($1, 'owner', NULL, NULL, NULL, $2)`, [receipt_id, OWNER])).ok).toBe(true);
    return receipt_id as string;
  };

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, treasuryCents: 100_000, simulatedSettlement: false });
    [F] = R.founders;
    await R.store.grantCustodyRole();
    su = new pg.Pool({ connectionString: R.pgc.superUrl.replace(/\/postgres$/, `/${R.pgc.dbname}`), max: 1 });
    custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 2, options: "-c search_path=fleet" });
    rail = await liveRail(R.owner, "fleet", OWNER);
    await R.q(`UPDATE fleet.fleet_ai_credit_lots SET usd_remaining = 0`);   // the fixture's opening credit is set aside (no ledger effect)
  }, 300_000);
  afterAll(async () => { await su?.end(); await custody?.end(); await R?.close(); });

  it("migrates to v72 with a clean audit", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(72);
    const audit = (await R.store.auditPrivileges()).problems;
    expect(audit, JSON.stringify(audit)).toEqual([]);
  });

  it("owner-funded credit: the agent bears the tax on its own work, the treasury on reviews; both are owed to the owner", async () => {
    await ownerPurchase("4001-0001", 2_500, 3_000);                              // $25 credit, $30 charged (receipt: 20 % tax)
    const cash0 = await bal(`agent:${F.id}:cash`), exp0 = await bal(`agent:${F.id}:expense`), fexp0 = await bal("fleet:expense");
    const pay0 = await bal("fleet:owner:payable");
    await agentCall(10 * USD);                                                   // $10 of the agent's own work
    await review(5 * USD);                                                       // $5 of Fleet Control review
    const s = await settle();
    expect(s.detection.acquisitionCost).toMatchObject({ priced: 2, postedMinor: 300 });
    expect(await bal(`agent:${F.id}:cash`)).toBe(cash0 - 1_000 - 200);           // its £10.00 call + the tax on it (receipt: 20 %)
    expect(await bal(`agent:${F.id}:expense`)).toBe(exp0 + 1_000 + 200);
    // the review: £5.00 charged (pre-tax) + £1.00 tax = £6.00 of treasury overhead, recognised once each
    expect(await bal("fleet:expense")).toBe(fexp0 + 500 + 100);
    // owed to the owner (owner-funded credit): the £10.00 + £5.00 used and the £3.00 tax on it
    expect(await bal("fleet:owner:payable")).toBe(pay0 + 1_000 + 500 + 300);
    expect((await settle()).detection.acquisitionCost).toMatchObject({ priced: 0, postedMinor: 0 });   // once
    expect(await R.one(`fleet.fleet_ledger_verify() ->> 'ok'`)).toBe("true");
    await R.q(`UPDATE fleet.fleet_ai_credit_lots SET usd_remaining = 0`);
  });

  it("an owner conversation's share goes to the treasury; a lot without evidence adds nothing until the owner records it", async () => {
    // a manually recorded purchase (no receipt): no rate is assumed
    await R.one(`fleet.fleet_provider_credits_record('anthropic', 'purchase', 1000, 'manual-no-receipt', $1)`, [OWNER]);
    const lot = String(await R.one(`(SELECT lot_id FROM fleet.fleet_ai_credit_lots WHERE external_ref = 'manual-no-receipt')`));
    const fexp0 = await bal("fleet:expense"), cash0 = await bal(`agent:${F.id}:cash`);
    await agentCall(5 * USD, "treasury");                                        // a treasury-paid owner conversation turn
    expect((await settle()).detection.acquisitionCost).toMatchObject({ priced: 0 });
    expect(await bal("fleet:expense")).toBe(fexp0 + 500);                        // only the pre-tax turn
    // the owner records the lot's cost from its receipts: $10 credit for $12 charged
    expect(await R.one(`fleet.fleet_admin_ai_credit_lot_cost($1, 1000, 1200, 'receipts 2741-0001', $2)`, [lot, OWNER])).toMatchObject({ ok: true });
    expect((await settle()).detection.acquisitionCost).toMatchObject({ priced: 1, postedMinor: 100 });
    expect(await bal("fleet:expense")).toBe(fexp0 + 500 + 100);                  // treasury overhead, not the agent
    expect(await bal(`agent:${F.id}:cash`)).toBe(cash0);
    expect(await R.code(R.one(`fleet.fleet_admin_ai_credit_lot_cost($1, 1000, 1200, 'again', $2)`, [lot, OWNER]))).toBe("FLEET_ALREADY_CLAIMED");
    await R.q(`UPDATE fleet.fleet_ai_credit_lots SET usd_remaining = 0`);
  });

  it("treasury-funded credit: the tax part of the asset is used up by consumption; the settlement keeps only the FX difference", async () => {
    // $10 credit, $12 charged; the treasury's debit was £11.40 (a different rate than the 1:1 charge rate → FX difference)
    const [{ receipt_id }] = await R.q(`INSERT INTO fleet.fleet_ai_credit_receipts (provider, receipt_no, usd_cents, tax_cents, total_cents) VALUES ('anthropic', '4003-0003', 1000, 200, 1200) RETURNING receipt_id`);
    const tid = `D${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
    await cx("cx_paypal_txn_record", [W, rail.railId, JSON.stringify({ transactionId: tid, eventCode: "T0006", initiatedAt: new Date().toISOString(), status: "S", currency: "GBP", amountMinor: -1_140, feeMinor: 0 })]);
    expect(await R.one(`fleet.fleet_admin_ai_credit_confirm($1, 'treasury', $2, $3, 'T0006', $4)`, [receipt_id, rail.railId, tid, OWNER])).toMatchObject({ ok: true, gbpMinor: 1_140 });
    const exp0 = await bal(`agent:${F.id}:expense`), fexp0 = await bal("fleet:expense");
    await agentCall(10 * USD);                                                   // uses the whole lot
    const s = await settle();
    expect(s.detection.acquisitionCost).toMatchObject({ postedMinor: 200 });
    expect(await bal(`agent:${F.id}:expense`)).toBe(exp0 + 1_000 + 200);         // its work + the tax on it
    await settle();
    expect(await bal("fleet:ai_credits")).toBe(0);                               // asset fully used: £10.00 + £2.00 tax − £0.60 FX
    expect(await bal("fleet:expense")).toBe(fexp0 - 60);                         // FX difference only (cost £11.40 vs £12.00 at charge rates)
    expect(await R.one(`fleet.fleet_ledger_verify() ->> 'ok'`)).toBe("true");
  });

  it("console reconciliation: more credit than recorded restores the lot it was drawn from — no lot of assumed funding", async () => {
    const lots0 = Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ai_credit_lots)`));
    const recorded = Number(await R.one(`fleet.fleet_provider_credit_balance('anthropic')`));
    const r = await R.one<Record<string, any>>(`fleet.fleet_admin_ai_credit_balance_reconcile('anthropic', $1, $2)`, [Math.round(recorded / 1_000_000) + 12, OWNER]);
    expect(r.ok).toBe(true);
    expect(Number(r.restoredToLots) + Number(r.restoredToOpening) + Number(r.unplaced)).toBe(Number(r.differenceUsdMicrocents));
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ai_credit_lots)`))).toBe(lots0);   // no new lot
    // a generic positive adjustment no longer creates an owner lot either
    await R.one(`fleet.fleet_provider_credits_record('anthropic', 'adjustment', 5, 'promo?', $1)`, [OWNER]);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ai_credit_lots)`))).toBe(lots0);
  });
});
