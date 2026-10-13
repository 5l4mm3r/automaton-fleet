/**
 * Schema v74 — pre-launch test costs written off once (PostgreSQL; no provider, no money moves):
 *  - refused while any living agent is not paused (resuming is the launch);
 *  - each agent's AI cost so far (pre-tax charges + the v73 tax share) moves to the Fleet: the agent's cash is whole again,
 *    the expense is recognised once (now Fleet expense);
 *  - the owner payable for that credit becomes the owner's contribution; the cash held for it returns to the treasury;
 *  - carried sub-penny tax is waived; the capital to back does not change; once only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";

const PG_BIN = findPgBin();

describe.skipIf(!PG_BIN)("v74: pre-launch test costs written off (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let F: Founder;
  let su: pg.Pool;
  const asSuper = async (sql: string, params: unknown[] = []) => {
    const c = await su.connect();
    try { await c.query("SET session_replication_role = replica"); return (await c.query(sql, params)).rows; } finally { await c.query("RESET session_replication_role"); c.release(); }
  };
  const bal = async (a: string) => Number(await R.one(`fleet.fleet_ledger_balance($1)`, [a]));
  /** A pre-v69 charge journal (no owner legs), as the live path posted it then. */
  const charge = async (kind: string, pence: number, agent: string | null) => {
    const lines = agent ? [[`agent:${agent}:expense`, "D"], [`agent:${agent}:cash`, "C"]] : [["fleet:expense", "D"], ["fleet:treasury:unallocated", "C"]];
    return String(await R.one(`fleet.fleet_ledger_post($1, $2, 'controller', 'historical charge', 'controller', $3, NULL, NULL, NULL, NULL, now(), $4::jsonb)`,
      [kind, `hist:${crypto.randomUUID()}`, agent, JSON.stringify(lines.map(([account, side]) => ({ account, side, amount: pence })))]));
  };
  const cognition = (journal: string, provider = "anthropic", payer = "agent") => asSuper(
    `INSERT INTO fleet.fleet_cognition_log (request_id, agent_id, provider, model, outcome, input_tokens, output_tokens, cost_microcents, charged_cents,
       prompt_sha256, response_sha256, payer, journal_id) VALUES ($1, $2, $3, 'm', 'ok', 1, 1, 1, 0, repeat('a', 64), repeat('b', 64), $4, $5)`,
    [crypto.randomUUID(), F.id, provider, payer, journal]);
  const preview = (credit: number, total: number) => R.one<Record<string, any>>(`fleet.fleet_ai_credit_historical_preview('anthropic', $1, $2)`, [credit, total]);
  const apply = (credit: number, total: number) => R.one<Record<string, any>>(`fleet.fleet_admin_ai_credit_historical_cost('anthropic', $1, $2, 'receipts 20+4, 50+10', $3)`, [credit, total, OWNER]);
  let agentJ = "", reviewJ = "", otherProviderJ = "", noEvidenceJ = "";
  let lot = "";

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, treasuryCents: 100_000, simulatedSettlement: false });
    [F] = R.founders;
    su = new pg.Pool({ connectionString: R.pgc.superUrl.replace(/\/postgres$/, `/${R.pgc.dbname}`), max: 1 });
    // History (before the lots): the agent's own calls — one journal per call, and one penny reached by two accrued calls —
    agentJ = await charge("inference_charge", 1_000, F.id); await cognition(agentJ);
    const accrued = await charge("inference_charge", 7, F.id); await cognition(accrued); await cognition(accrued);
    // a Fleet Control review (no cognition record; the controller's own provider consumption is its evidence),
    await R.q(`INSERT INTO fleet.fleet_provider_credit_events (provider, kind, usd_microcents, request_id, recorded_by) VALUES ('anthropic', 'consumption', -400000, $1, 'controller:knowledge_review_charge')`, [crypto.randomUUID()]);
    reviewJ = await charge("knowledge_review_charge", 1, null);
    // and two that cannot be attributed reliably: another provider's call, and a treasury charge with no provider evidence.
    otherProviderJ = await charge("inference_charge", 50, F.id); await cognition(otherProviderJ, "openai");
    noEvidenceJ = await charge("owner_conversation_charge", 30, null);
    // v70's opening pool (created by the migration in production: the owner's remaining credit), after the history.
    await asSuper(`DELETE FROM fleet.fleet_ai_credit_lots WHERE external_ref = 'opening:v70:anthropic'`);
    lot = String((await asSuper(`INSERT INTO fleet.fleet_ai_credit_lots (provider, source, usd_purchased, usd_remaining, external_ref, recorded_by)
      VALUES ('anthropic', 'owner', 4129000000, 4129000000, 'opening:v70:anthropic', 'migration') RETURNING lot_id`))[0].lot_id);
  }, 300_000);
  afterAll(async () => { await su?.end(); await R?.close(); });

  const pausedAll = (paused: boolean) => R.one(`fleet.fleet_founder_cognition_set($1, true, $2, NULL, NULL, 'test', $3)`, [F.id, paused, OWNER]);
  const writeoff = () => R.one<Record<string, any>>(`fleet.fleet_admin_ai_credit_test_period_writeoff($1)`, [OWNER]);

  it("migrates to v74 with a clean audit; the pre-launch history is costed as in production (v69 opening, v73 tax share)", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(74);
    const audit = (await R.store.auditPrivileges()).problems;
    expect(audit, JSON.stringify(audit)).toEqual([]);
    expect(await R.one(`fleet.fleet_admin_ai_credit_lot_cost($1, 7000, 8400, 'receipts 20+4, 50+10', $2)`, [lot, OWNER])).toMatchObject({ ok: true });
    expect(await R.one(`fleet.fleet_admin_ai_credit_opening($1)`, [OWNER])).toMatchObject({ ok: true, amountMinor: 1_088 });
    expect(await apply(7_000, 8_400)).toMatchObject({ ok: true, journals: 3 });
    expect(await bal(`agent:${F.id}:expense`)).toBe(1_000 + 7 + 50 + 201);   // its pre-launch AI cost, incl. the other-provider call
    expect(await bal("fleet:owner:payable")).toBe(1_088 + 201);
  });

  it("is refused while an agent is not paused (resuming is the launch)", async () => {
    await pausedAll(false);
    const p = await R.one<Record<string, any>>(`fleet.fleet_ai_credit_test_period_preview()`);
    expect(p.refused).toMatch(/must still be paused/);
    expect(await R.code(writeoff())).toBe("FLEET_BAD_REQUEST");
    await pausedAll(true);
    expect((await R.one<Record<string, any>>(`fleet.fleet_ai_credit_test_period_preview()`)).refused).toBeNull();
  });

  it("moves the agents' pre-launch AI cost to the Fleet and writes the owner payable off as contribution — once", async () => {
    const cash0 = await bal(`agent:${F.id}:cash`), fexp0 = await bal("fleet:expense"), cap0 = await bal("fleet:owner:capital");
    const unalloc0 = await bal("fleet:treasury:unallocated"), back0 = await R.one<Record<string, any>>(`fleet.fleet_capital_backing()`);
    const r = await writeoff();
    expect(r).toMatchObject({ ok: true, agentsMinor: { [F.id]: 1_258 }, agentsTotalMinor: 1_258, ownerPayableWrittenOffMinor: 1_289, waivedCarriedMicro: 600_000 });
    expect(await bal(`agent:${F.id}:cash`)).toBe(cash0 + 1_258);
    expect(await bal(`agent:${F.id}:expense`)).toBe(0);
    expect(await bal("fleet:expense")).toBe(fexp0 + 1_258);                     // recognised once: moved, not added
    expect(await bal("fleet:owner:payable")).toBe(0);
    expect(await bal("fleet:treasury:owner_reimbursable")).toBe(0);
    expect(await bal("fleet:owner:capital")).toBe(cap0 + 1_289);
    expect(await bal("fleet:treasury:unallocated")).toBe(unalloc0 + 1_289 - 1_258);
    expect(Number(await R.one(`(SELECT COALESCE(sum(unposted_micro), 0) FROM fleet.fleet_ai_credit_cost_accrual)`))).toBe(0);
    const back1 = await R.one<Record<string, any>>(`fleet.fleet_capital_backing()`);
    expect([back1.unbackedMinor, back1.booksCashMinor]).toEqual([back0.unbackedMinor, back0.booksCashMinor]);
    expect(await R.one(`fleet.fleet_ledger_verify() ->> 'ok'`)).toBe("true");
    // once
    const again = await writeoff();
    expect(again).toMatchObject({ ok: true, already: true, agentsTotalMinor: 1_258 });
    expect(await bal(`agent:${F.id}:cash`)).toBe(cash0 + 1_258);
    expect((await R.one<Record<string, any>>(`fleet.fleet_ai_credit_test_period_preview()`)).refused).toBe("already written off");
    expect([reviewJ, agentJ, otherProviderJ, noEvidenceJ].every(Boolean)).toBe(true);
  });
});
