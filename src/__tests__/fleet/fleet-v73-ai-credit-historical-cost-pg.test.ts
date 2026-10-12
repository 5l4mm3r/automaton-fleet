/**
 * Schema v73 — the one-time historical acquisition-cost correction (PostgreSQL; no provider, no money moves):
 *  - the AI charges made before the AI-credit lots (pre-tax, brought in by the v69 opening) get their tax share from the
 *    opening pool's evidenced ratio, allocated by the ORIGINAL attribution (agent inference → that agent; a Fleet Control
 *    review → the treasury), owner-funded → owed to the owner; the pre-tax expense is not recognised again;
 *  - what cannot be attributed reliably (another provider; no provider evidence) is reported, never posted;
 *  - refused without the opening, without the lot's evidence, or with figures that do not reproduce it; applied once.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";

const PG_BIN = findPgBin();

describe.skipIf(!PG_BIN)("v73: one-time historical AI-credit acquisition cost (PostgreSQL)", { timeout: 300_000 }, () => {
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

  it("migrates to v73 with a clean audit", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(73);
    const audit = (await R.store.auditPrivileges()).problems;
    expect(audit, JSON.stringify(audit)).toEqual([]);
  });

  it("is refused before the opening and before the pool's evidence; figures must reproduce the recorded cost", async () => {
    expect((await preview(7_000, 8_400)).refused).toMatch(/acquisition cost first/);
    expect(await R.code(apply(7_000, 8_400))).toBe("FLEET_BAD_REQUEST");
    expect(await R.one(`fleet.fleet_admin_ai_credit_lot_cost($1, 7000, 8400, 'receipts 20+4, 50+10', $2)`, [lot, OWNER])).toMatchObject({ ok: true, ratio: 1.2 });
    expect((await preview(7_000, 8_400)).refused).toMatch(/AI-credit opening first/);
    expect(await R.one(`fleet.fleet_admin_ai_credit_opening($1)`, [OWNER])).toMatchObject({ ok: true, amountMinor: 1_000 + 7 + 1 + 50 + 30 });
    expect((await preview(7_000, 8_500)).refused).toMatch(/do not reproduce/);
    expect((await preview(7_000, 8_400)).refused).toBeNull();
  });

  it("preview: by original payer, with the unattributable reported (read-only)", async () => {
    const p = await preview(7_000, 8_400);
    expect(p.byPayer).toEqual({
      [`agent:${F.id}`]: { journals: 2, baseMinor: 1_007, costMicro: 201_400_000 },     // 20 % of £10.07
      treasury: { journals: 1, baseMinor: 1, costMicro: 200_000 },                       // the review: 0.2p
    });
    expect(p.unattributed.map((u: any) => [u.journalId, u.reason]).sort()).toEqual([
      [noEvidenceJ, "treasury charge without provider evidence"],
      [otherProviderJ, "not a anthropic call"],
    ].sort());
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ai_credit_historical_costs)`))).toBe(0);
  });

  it("applies once: the agent bears the tax on its own work, owed to the owner; the pre-tax expense is not recognised again", async () => {
    const cash0 = await bal(`agent:${F.id}:cash`), exp0 = await bal(`agent:${F.id}:expense`), fexp0 = await bal("fleet:expense");
    const pay0 = await bal("fleet:owner:payable"), j0 = Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ledger_journal)`));
    const r = await apply(7_000, 8_400);
    expect(r).toMatchObject({ ok: true, journals: 3 });
    expect(r.posted).toEqual({ [`agent:${F.id}`]: { postedMinor: 201, carriedMicro: 400_000 }, treasury: { postedMinor: 0, carriedMicro: 200_000 } });
    expect(r.unattributed).toHaveLength(2);
    expect(await bal(`agent:${F.id}:cash`)).toBe(cash0 - 201);
    expect(await bal(`agent:${F.id}:expense`)).toBe(exp0 + 201);                  // only the tax share; the £10.07 stays as posted
    expect(await bal("fleet:expense")).toBe(fexp0);                                // 0.2p carried, nothing posted
    expect(await bal("fleet:owner:payable")).toBe(pay0 + 201);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ledger_journal)`))).toBe(j0 + 1);
    expect(await R.one(`fleet.fleet_ledger_verify() ->> 'ok'`)).toBe("true");
    const ev = await R.q(`SELECT event_type, detail FROM fleet.fleet_events WHERE event_type IN ('ai_credit_historical_cost_applied', 'ai_credit_reconcile') ORDER BY id`);
    expect(ev.map((e: any) => e.event_type)).toEqual(["ai_credit_historical_cost_applied", "ai_credit_reconcile"]);
    expect(ev[1].detail).toMatchObject({ reason: "historical_unattributed", journals: 2 });

    // never twice: the run is returned, nothing moves; the per-journal record holds each corrected charge once
    const again = await apply(7_000, 8_400);
    expect(again).toMatchObject({ ok: true, already: true, journals: 3 });
    expect(await bal("fleet:owner:payable")).toBe(pay0 + 201);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ledger_journal)`))).toBe(j0 + 1);
    expect((await preview(7_000, 8_400))).toMatchObject({ alreadyApplied: true, byPayer: {} });
    expect(await R.code(R.q(`UPDATE fleet.fleet_ai_credit_historical_costs SET cost_micro = 0`))).toMatch(/FLEET_/);
    // the minutely settlement does not price these again
    expect((await R.one<Record<string, any>>(`fleet.svc_ai_credit_settle(20)`)).detection.acquisitionCost).toMatchObject({ postedMinor: 0 });
    expect(await bal(`agent:${F.id}:cash`)).toBe(cash0 - 201);
    expect(reviewJ).toBeTruthy();
  });
});
