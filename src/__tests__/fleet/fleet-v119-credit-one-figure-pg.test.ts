/**
 * v119 — one figure of provider credit in use, for every consumer (PostgreSQL; real agent authorisation and Fleet Control
 * reservation; no provider). An engineering-style hold leaves an exact amount free (as the canary ceiling will):
 *  - an open agent reservation is counted once in fleet_provider_credit_held (not twice), and leaves it when recorded;
 *  - Fleet Control cannot reserve credit an agent's call in flight holds, and an agent cannot take what Fleet Control holds;
 *  - concurrent agent calls and Fleet Control calls never take more than is free, in total;
 *  - the engineering hold sees the same figure.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { PgFleetStore, type CognitionRecord } from "../../fleet/postgres/store.js";

const PG_BIN = findPgBin();
const route = { tier: "T2", provider: "anthropic", model: "claude-sonnet-5-5", taskClass: "founder_work", source: "class_minimum", scope: "task_step" };
const rec = (inputTokens: number): CognitionRecord => ({ outcome: "ok", inputTokens, outputTokens: 0, promptSha256: "a".repeat(64), responseSha256: "b".repeat(64),
  toolCalls: [], errorCode: null, usageSource: "provider", attempts: 1 });

describe.skipIf(!PG_BIN)("v119: one figure of provider credit in use (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let svc: PgFleetStore;
  let A: string, B: string, C: string;
  const held = async () => Number(await R.one(`fleet.fleet_provider_credit_held('anthropic')`));
  const free = async () => Number(await R.one(`fleet.fleet_provider_credit_balance('anthropic')`)) - await held();
  const auth = (a: string, usdCents: number, s = svc) => s.cognitionRoutedAuthorize(a, usdCents, route, "c".repeat(64));
  const fcReserve = (usdMicro: number) => R.one<Record<string, any>>(`fleet.svc_fleet_control_ai_reserve('message_check', 'x', $1, $2::uuid, 'anthropic')`, [usdMicro, crypto.randomUUID()]);
  /** Leave exactly `usdMicro` free: hold the rest, as the canary ceiling will. */
  const leaveFree = async (run: string, usdMicro: number) => {
    const f = await free();
    await R.one(`fleet.fleet_admin_engineering_credit_hold($1, 'anthropic', $2, 'test: leave an exact amount free', $3)`, [run, f - usdMicro, OWNER]);
    expect(await free()).toBe(usdMicro);
  };

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 3, allocationCents: 10_000, treasuryCents: 100_000 });
    [A, B, C] = R.founders.map((f) => f.id);
    await R.store.grantServiceRole();
    svc = new PgFleetStore({ connectionString: R.pgc.serviceUrl });
    await R.genesis.setCognitionPolicy({ enabled: true, provider: "anthropic", model: "claude-opus-5-5", maxOutputTokens: 4_000, actor: OWNER,
      inputMicrocents: 400, outputMicrocents: 2_000, cacheWriteMicrocents: 500, cacheReadMicrocents: 20 });
    for (const a of [A, B, C]) await R.genesis.setFounderCognition(a, { enabled: true, maxTurnsPerHour: 3_600, dailyBudgetCents: 100_000, reason: "t", actor: OWNER });
    for (const [t, m] of [["T2", "claude-sonnet-5-5"], ["T3", "claude-opus-5-5"]]) {
      await R.genesis.cognitionTierVerify(t, m, "test: models api 200", OWNER);
      await R.genesis.cognitionTierEnable(t, true, OWNER);
    }
    await R.genesis.cognitionRoutingSet(true, 2_000, OWNER);
    for (const a of [A, B, C]) await R.genesis.founderRoutingSet(a, true, OWNER);
    await R.one(`fleet.fleet_admin_fleet_control_ai_budget(100000, 'test budget', $1)`, [OWNER]);
  }, 300_000);
  afterAll(async () => { await svc?.close(); await R?.close(); });

  it("an open agent reservation is counted once, and leaves the figure when its result is recorded", async () => {
    const h0 = await held();
    const x = await auth(A, 30);
    expect(x.ok, JSON.stringify(x)).toBe(true);
    expect(await held()).toBe(h0 + 30 * 1_000_000);                                        // once, at its USD estimate
    await svc.cognitionRoutedRecord(A, String(x.requestId), rec(1_000), {});
    expect(await held()).toBe(h0);
  });

  it("Fleet Control cannot take credit an agent's call in flight holds — and an agent cannot take Fleet Control's", async () => {
    await leaveFree("one-figure-1", 30_000_000);                                            // $0.30 free
    const x = await auth(A, 25);                                                            // agent holds $0.25
    expect(x.ok, JSON.stringify(x)).toBe(true);
    expect(await free()).toBe(5_000_000);
    expect(await fcReserve(7_000_000)).toMatchObject({ ok: false, code: "FLEET_CONTROL_AI_BUDGET_UNFUNDED" });   // $0.07 > $0.05 left
    const fc = await fcReserve(5_000_000);                                                  // exactly what is left
    expect(fc).toMatchObject({ ok: true });
    expect(await free()).toBe(0);
    expect(await auth(B, 1)).toMatchObject({ ok: false, code: "FLEET_COGNITION_CREDITS_EXHAUSTED" });           // nothing left for another agent
    await svc.cognitionRoutedRecord(A, String(x.requestId), rec(1_000), {});
    await R.one(`fleet.svc_fleet_control_ai_settle($1::uuid, 0)`, [fc.reservationId]);
    await R.one(`fleet.fleet_admin_engineering_credit_release('one-figure-1', 'test done', $1)`, [OWNER]);
  });

  it("concurrent agent calls and Fleet Control calls never take more than is free, in total", async () => {
    await leaveFree("one-figure-2", 50_000_000);                                            // $0.50 free
    const stores = [0, 1, 2].map(() => new PgFleetStore({ connectionString: R.pgc.serviceUrl }));
    try {
      const results = await Promise.allSettled([
        auth(A, 20, stores[0]), auth(B, 20, stores[1]), auth(C, 20, stores[2]),            // $0.60 of agent reservations…
        fcReserve(7_000_000), fcReserve(7_000_000),                                         // …and $0.14 of Fleet Control, against $0.50
      ]);
      const ok = results.map((r) => r.status === "fulfilled" && (r.value as any).ok === true);
      const taken = [20_000_000, 20_000_000, 20_000_000, 7_000_000, 7_000_000].reduce((n, v, i) => n + (ok[i] ? v : 0), 0);
      expect(taken).toBeLessThanOrEqual(50_000_000);
      expect(taken).toBeGreaterThan(0);
      expect(await free()).toBe(50_000_000 - taken);                                        // each taken amount counted exactly once
      for (const r of results) if (r.status === "fulfilled" && (r.value as any).ok === false) {
        expect(["FLEET_COGNITION_CREDITS_EXHAUSTED", "FLEET_CONTROL_AI_BUDGET_UNFUNDED"]).toContain((r.value as any).code);
      }
    } finally { await Promise.all(stores.map((s) => s.close())); }
  });

  it("the engineering hold sees the same figure (open reservations not subtracted twice)", async () => {
    const f = await free();
    expect(f).toBeGreaterThanOrEqual(0);
    const r = await R.one<Record<string, any>>(`fleet.fleet_admin_engineering_credit_hold('one-figure-3', 'anthropic', $1, 'test: exactly what is free', $2)`, [f, OWNER]).catch((e: Error) => ({ error: e.message }));
    if (f > 0) expect(r).toMatchObject({ ok: true, freeAfterMicro: 0 });                    // all of the free figure can be held — no double count
    expect(await R.one(`fleet.fleet_ledger_verify() ->> 'ok'`)).toBe("true");
  });
});
