/**
 * Schema v70 — AI provider credit by funding source (PostgreSQL; no model, no provider, no money moves):
 *  - owner-funded credit (recorded purchases, the opening balance) is owed to the owner as it is used (v69) — nothing else;
 *  - treasury-funded credit needs the treasury PayPal debit as evidence (one purchase per transaction, per receipt), and is a
 *    prepaid asset out of treasury cash;
 *  - consumption draws lots oldest first; the part drawn from a treasury lot leaves the owner payable (no false payable) and
 *    uses up the asset; a used-up lot's cost difference is settled explicitly; the expense is recognised once overall;
 *  - a negative adjustment on a treasury lot is expensed at cost; the ledger verifies throughout.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { liveRail, type ArmedCustody } from "./fixtures/custody-signer.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";

const PG_BIN = findPgBin();
const USD = 100_000_000; // microcents per dollar

describe.skipIf(!PG_BIN)("v70: AI provider credit by funding source (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let custody: pg.Pool;
  let rail: ArmedCustody;
  const W = "custody-executor";
  const cx = async (fn: string, args: unknown[]) => (await custody.query(`SELECT fleet.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) AS r`, args)).rows[0].r;
  const bal = async (a: string) => Number(await R.one(`fleet.fleet_ledger_balance($1)`, [a]));
  const charge = (usd: number) => R.one(`fleet.fleet_control_charge('knowledge_review_charge', $1, $2::jsonb)`,
    [crypto.randomUUID(), JSON.stringify([{ provider: "anthropic", requestId: crypto.randomUUID(), usdMicrocents: usd }])]);
  const settle = () => R.one<Record<string, any>>(`fleet.svc_ai_credit_settle(20)`);
  const debit = async (gbpMinor: number) => {
    const tid = `D${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
    const r = await cx("cx_paypal_txn_record", [W, rail.railId, JSON.stringify({ transactionId: tid, eventCode: "T0006", initiatedAt: new Date().toISOString(),
      status: "S", currency: "GBP", amountMinor: -gbpMinor, feeMinor: 0 })]);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return tid;
  };
  const buy = (usdCents: number, tid: string, receipt: string) => R.one<Record<string, any>>(`fleet.fleet_admin_ai_credit_treasury_purchase('anthropic', $1, $2, $3, 'T0006', $4, $5)`,
    [usdCents, rail.railId, tid, receipt, OWNER]);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, treasuryCents: 100_000, simulatedSettlement: false });
    await R.store.grantCustodyRole();
    custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 2, options: "-c search_path=fleet" });
    rail = await liveRail(R.owner, "fleet", OWNER);
    // Use up any credit the fixture recorded, so this test starts from known lots.
    const start = Number(await R.one(`(SELECT COALESCE(sum(usd_remaining), 0) FROM fleet.fleet_ai_credit_lots)`));
    // The fixture's large opening credit (owner-funded) is set aside for this test: no ledger effect.
    if (start > 0) await R.q(`UPDATE fleet.fleet_ai_credit_lots SET usd_remaining = 0`);
  }, 300_000);
  afterAll(async () => { await custody?.end(); await R?.close(); });

  it("migrates to v70 with a clean audit; the purchase routes to Fleet Command; the capability entry is version 2", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(70);
    const audit = (await R.store.auditPrivileges()).problems;
    expect(audit, JSON.stringify(audit)).toEqual([]);
    expect(await R.one(`fleet.fleet_event_route('ai_credit_treasury_purchase', '{}'::jsonb)`)).toBe("P3_SUMMARY");
    expect(Number(await R.one(`(SELECT version FROM fleet.fleet_knowledge_library WHERE entry_id = 'fleet-capability-status' AND current)`))).toBe(2);
  });

  it("owner-funded and treasury-funded credit: the right party is owed, the asset is used up, the expense is recognised once", async () => {
    const p0 = await bal("fleet:owner:payable"), e0 = await bal("fleet:expense"), u0 = await bal("fleet:treasury:unallocated");
    // The owner buys $5 (recorded as before); $3 is used: owed to the owner.
    await R.one(`fleet.fleet_provider_credits_record('anthropic', 'purchase', 500, 'rcpt-owner-1', $1)`, [OWNER]);
    await charge(3 * USD);
    expect(await bal("fleet:owner:payable")).toBe(p0 + 300);

    // The treasury buys $10 for £7.90 — evidenced by its own PayPal debit; refused twice, refused for a credit.
    const tid = await debit(790);
    const r = await buy(1_000, tid, "ANTH-INV-1");
    expect(r).toMatchObject({ ok: true, gbpMinor: 790, usdCents: 1_000 });
    expect(await bal("fleet:ai_credits")).toBe(790);
    expect(await bal("fleet:treasury:unallocated")).toBe(u0 - 300 - 790);   // the review's own cost + the purchase
    expect(await R.code(buy(1_000, tid, "ANTH-INV-2"))).toBe("FLEET_ALREADY_CLAIMED");
    expect(await R.code(buy(1_000, await debit(790), "ANTH-INV-1"))).toBe("FLEET_ALREADY_CLAIMED");
    const credit = `C${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
    await cx("cx_paypal_txn_record", [W, rail.railId, JSON.stringify({ transactionId: credit, eventCode: "T0006", initiatedAt: new Date().toISOString(), status: "S", currency: "GBP", amountMinor: 500, feeMinor: 0 })]);
    expect(await R.code(buy(500, credit, "ANTH-INV-3"))).toBe("FLEET_BAD_REQUEST");

    // $4 used: $2 left in the owner's lot (oldest first), $2 from the treasury's. Settlement takes the treasury part out
    // of the owner payable — what remains owed is exactly the owner-funded use ($5).
    await charge(4 * USD);
    expect((await settle()).reclassifiedMinor).toBe(200);
    expect(await bal("fleet:owner:payable")).toBe(p0 + 500);
    expect(await bal("fleet:ai_credits")).toBe(590);

    // $8 more uses up the treasury lot ($10 consumed at charge rates = £10.00 against a £7.90 cost): the difference is settled.
    await charge(8 * USD);
    const s = await settle();
    expect(s).toMatchObject({ reclassifiedMinor: 800, lotsSettled: 1 });
    expect(await bal("fleet:ai_credits")).toBe(0);
    expect(await bal("fleet:owner:payable")).toBe(p0 + 500);
    // Expense once: owner-funded use £5.00 at charge rates + the treasury lot at its cost £7.90.
    expect(await bal("fleet:expense")).toBe(e0 + 500 + 790);
    expect(await bal("fleet:treasury:owner_reimbursable")).toBe(await bal("fleet:owner:payable"));
    expect(await R.one(`fleet.fleet_ledger_verify() ->> 'ok'`)).toBe("true");
  });

  it("credit gone without a recorded call from a treasury lot is expensed at cost; beyond every lot the owner default applies", async () => {
    const e0 = await bal("fleet:expense");
    await buy(1_000, await debit(800), "ANTH-INV-4");                                    // $10 for £8.00
    await R.one(`fleet.fleet_provider_credits_record('anthropic', 'adjustment', -250, 'expired credit', $1)`, [OWNER]);   // $2.50 gone
    expect(await bal("fleet:expense")).toBe(e0 + 200);                                   // £8.00 × 2.5/10
    expect(await bal("fleet:ai_credits")).toBe(600);
    const st = await R.one<Record<string, any>>(`fleet.fleet_ai_credit_status()`);
    expect(Number(st.remainingBySourceUsdMicrocents.treasury)).toBe(7.5 * USD);
    expect(await R.one(`fleet.fleet_ledger_verify() ->> 'ok'`)).toBe("true");
  });
});
