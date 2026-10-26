/**
 * Schema v119 — the daily AI limit counts usage whichever credit pays (PostgreSQL; the real routed paths; no provider).
 *  - promotional calls count toward the limit (and stay charged to no one, owed to no one);
 *  - purchased and mixed calls count at their full usage (not only the purchased part);
 *  - an expired, unrecorded reservation counts until it is recorded — and then once, not twice;
 *  - concurrent authorisations of one agent cannot both pass; a replayed record changes nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { PgFleetStore, type CognitionRecord } from "../../fleet/postgres/store.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";
import { OWNER_PAYABLE_ACCOUNT } from "../../fleet/postgres/migrations-phase69.js";

const PG_BIN = findPgBin();
const route = { tier: "T2", provider: "anthropic", model: "claude-sonnet-5-5", taskClass: "founder_work", source: "class_minimum", scope: "task_step" };
const rec = (inputTokens: number): CognitionRecord => ({ outcome: "ok", inputTokens, outputTokens: 0, promptSha256: "a".repeat(64), responseSha256: "b".repeat(64),
  toolCalls: [], errorCode: null, usageSource: "provider", attempts: 1 });

describe.skipIf(!PG_BIN)("v119: the daily AI limit counts usage whichever credit pays (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let svc: PgFleetStore;
  let su: pg.Pool;
  let A: string, B: string, C: string;
  const asSuper = async (sql: string, params: unknown[] = []) => {
    const c = await su.connect();
    try { await c.query("SET session_replication_role = replica"); return (await c.query(sql, params)).rows; } finally { await c.query("RESET session_replication_role"); c.release(); }
  };
  const state = async (a: string) => R.one<Record<string, any>>(`fleet.fleet_cognition_state($1)`, [a]);
  const auth = (a: string, usdCents: number) => svc.cognitionRoutedAuthorize(a, usdCents, route, "c".repeat(64));
  const promoLeft = async () => Number(await R.one(`(SELECT COALESCE(sum(usd_remaining), 0) FROM fleet.fleet_ai_credit_lots WHERE source = 'promotional')`));
  const grant = (ref: string, cents: number) => R.one(`fleet.fleet_admin_ai_credit_promotional_grant('anthropic', $1, $2, $2, now() - interval '1 day', now() + interval '20 days',
    'assumed_cutoff', 'test display', 'test console', $3)`, [ref, cents, OWNER]);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 3, allocationCents: 1_000, treasuryCents: 100_000 });
    [A, B, C] = R.founders.map((f) => f.id);
    await R.store.grantServiceRole();
    svc = new PgFleetStore({ connectionString: R.pgc.serviceUrl });
    su = new pg.Pool({ connectionString: R.pgc.superUrl.replace(/\/postgres$/, `/${R.pgc.dbname}`), max: 1 });
    await R.genesis.setCognitionPolicy({ enabled: true, provider: "anthropic", model: "claude-opus-5-5", maxOutputTokens: 4_000, actor: OWNER,
      inputMicrocents: 400, outputMicrocents: 2_000, cacheWriteMicrocents: 500, cacheReadMicrocents: 20 });
    for (const a of [A, B, C]) await R.genesis.setFounderCognition(a, { enabled: true, maxTurnsPerHour: 3_600, dailyBudgetCents: 100, reason: "t", actor: OWNER });
    for (const [t, m] of [["T2", "claude-sonnet-5-5"], ["T3", "claude-opus-5-5"]]) {
      await R.genesis.cognitionTierVerify(t, m, "test: models api 200", OWNER);
      await R.genesis.cognitionTierEnable(t, true, OWNER);
    }
    await R.genesis.cognitionRoutingSet(true, 2_000, OWNER);
    for (const a of [A, B, C]) await R.genesis.founderRoutingSet(a, true, OWNER);
    await grant("promo-v119", 500);                                                                          // $5.00 promotional, drawn first
  }, 300_000);
  afterAll(async () => { await svc?.close(); await su?.end(); await R?.close(); });

  it("migrates to v119 with a clean audit", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(119);
    const audit = (await R.store.auditPrivileges()).problems;
    expect(audit, JSON.stringify(audit)).toEqual([]);
  });

  it("promotional calls count toward the limit — charged nothing, owed nothing, but stopped at the limit", async () => {
    const p0 = await R.balance(OWNER_PAYABLE_ACCOUNT), c0 = await R.balance(`agent:${A}:cash`);
    let intended = 0;
    for (let i = 0; i < 4; i++) {                                                         // 4 × 100,000 input tokens at 200 µ¢: $0.20 each
      const x = await auth(A, 25);
      expect(x.ok, JSON.stringify(x)).toBe(true);
      const r = await svc.cognitionRoutedRecord(A, String(x.requestId), rec(100_000), {});
      expect(r).toMatchObject({ ok: true, chargedCents: 0, chargedMicrocents: 0 });
      intended += Number(r.chargedIntendedMicrocents);
    }
    const s = await state(A);
    expect(Number(s.usageTodayMicrocents)).toBe(intended);
    expect(Number(s.chargedTodayMicrocents)).toBe(0);
    expect(Number(s.spentTodayMicrocents)).toBe(intended);
    expect(intended).toBeGreaterThan(0);
    // The next call's reservation does not fit the 100p limit: refused although nothing was charged.
    const remaining = 100 * 1_000_000 - intended;
    const tooBig = Math.ceil((remaining + 1_000_000) / 1_000_000 * 1_000_000 / Number(await R.one(`COALESCE((SELECT rate_micro FROM fleet.fleet_fx_rates WHERE base = 'USD' ORDER BY observed_on DESC, rate_id DESC LIMIT 1), 1000000)`)));
    expect(await auth(A, tooBig)).toMatchObject({ ok: false, code: "FLEET_COGNITION_BUDGET_EXHAUSTED" });
    expect([await R.balance(OWNER_PAYABLE_ACCOUNT), await R.balance(`agent:${A}:cash`)]).toEqual([p0, c0]);   // no charge, nothing owed
  });

  it("an expired, unrecorded reservation counts until recorded — then once, not twice", async () => {
    const first = await auth(B, 30);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    await asSuper(`UPDATE fleet.fleet_cognition_inflight SET started_at = now() - interval '6 minutes' WHERE request_id = $1`, [first.requestId]);
    const second = await auth(B, 30);
    expect(second.ok, JSON.stringify(second)).toBe(true);                                   // the expired one no longer blocks…
    const est1 = Number(await R.one(`(SELECT estimate_cents FROM fleet.fleet_cognition_inflight WHERE request_id = $1)`, [first.requestId]));
    const s1 = await state(B);
    expect(Number(s1.reservedOpenMicrocents)).toBe((est1 + Number(second.estimateCents)) * 1_000_000);   // …but both still count
    const r2 = await svc.cognitionRoutedRecord(B, String(second.requestId), rec(100_000), {});
    const s2 = await state(B);
    expect(Number(s2.spentTodayMicrocents)).toBe(Number(r2.chargedIntendedMicrocents) + est1 * 1_000_000);
    // A call that would fit only if the expired reservation were forgotten is refused.
    // (a reservation just over the room left, but within it if the expired reservation's estimate were not counted)
    const rate = Number(await R.one(`COALESCE((SELECT rate_micro FROM fleet.fleet_fx_rates WHERE base = 'USD' ORDER BY observed_on DESC, rate_id DESC LIMIT 1), 1000000)`));
    expect(rate).toBe(1_000_000);                                                            // the fixture's FX: estimates in USD cents = ledger pence
    const room = 100 * 1_000_000 - Number(s2.spentTodayMicrocents);
    const over = Math.floor(room / 1_000_000) + 1;
    expect(over * 1_000_000).toBeLessThanOrEqual(room + est1 * 1_000_000);
    expect(await auth(B, over)).toMatchObject({ ok: false, code: "FLEET_COGNITION_BUDGET_EXHAUSTED" });
    // The late result: recorded once; the reservation leaves the count as its usage enters it.
    const r1 = await svc.cognitionRoutedRecord(B, String(first.requestId), rec(100_000), {});
    expect(r1).toMatchObject({ ok: true, late: true });
    const s3 = await state(B);
    expect(Number(s3.reservedOpenMicrocents)).toBe(0);
    expect(Number(s3.usageTodayMicrocents)).toBe(Number(r1.chargedIntendedMicrocents) + Number(r2.chargedIntendedMicrocents));
    // Replay: refused; nothing counted again.
    expect(await svc.cognitionRoutedRecord(B, String(first.requestId), rec(100_000), {})).toMatchObject({ ok: false, code: "FLEET_COGNITION_ALREADY_RECORDED" });
    expect(Number((await state(B)).usageTodayMicrocents)).toBe(Number(s3.usageTodayMicrocents));
  });

  it("concurrent authorisations of one agent cannot both pass", async () => {
    const pools = [0, 1].map(() => new PgFleetStore({ connectionString: R.pgc.serviceUrl }));
    try {
      const out = await Promise.all(pools.map((p) => p.cognitionRoutedAuthorize(C, 30, route, "c".repeat(64))));
      expect(out.filter((x) => x.ok).length).toBe(1);
      expect(out.find((x) => !x.ok)).toMatchObject({ code: "FLEET_COGNITION_BUSY" });
      const okOne = out.find((x) => x.ok)!;
      await svc.cognitionRoutedRecord(C, String(okOne.requestId), rec(100_000), {});
    } finally { await Promise.all(pools.map((p) => p.close())); }
  });

  it("purchased and mixed calls count their full usage, not only the purchased part", async () => {
    // Room for the calls below; the mixed call takes exactly the rest of the grant plus purchased credit.
    await R.genesis.setFounderCognition(C, { enabled: true, maxTurnsPerHour: 3_600, dailyBudgetCents: 10_000, reason: "t: room for the mixed call", actor: OWNER });
    const left = await promoLeft();
    expect(left).toBeGreaterThan(0);
    const mixedTokens = Math.ceil(left / 200) + 50_000;                                       // all that is left of the grant, then $0.10 purchased
    const before = await state(C);
    const x = await auth(C, Math.ceil((left + 10_000_000) / 1_000_000) + 1);
    expect(x.ok, JSON.stringify(x)).toBe(true);
    const r = await svc.cognitionRoutedRecord(C, String(x.requestId), rec(mixedTokens), {});
    expect(Number(r.promotionalUsdMicrocents)).toBe(left);                                  // mixed: the rest of the grant…
    expect(await promoLeft()).toBe(0);                                                       // …and none left
    expect(Number(r.chargedMicrocents)).toBeLessThan(Number(r.chargedIntendedMicrocents));
    const after = await state(C);
    expect(Number(after.usageTodayMicrocents) - Number(before.usageTodayMicrocents)).toBe(Number(r.chargedIntendedMicrocents));   // full usage counted
    expect(Number(after.chargedTodayMicrocents) - Number(before.chargedTodayMicrocents)).toBe(Number(r.chargedMicrocents));       // charge: purchased part
    const y = await auth(C, 25);
    const p = await svc.cognitionRoutedRecord(C, String(y.requestId), rec(100_000), {});
    expect(Number(p.promotionalUsdMicrocents)).toBe(0);                                      // purchased only
    expect(Number(p.chargedMicrocents)).toBe(Number(p.chargedIntendedMicrocents));
    expect(Number((await state(C)).usageTodayMicrocents) - Number(after.usageTodayMicrocents)).toBe(Number(p.chargedIntendedMicrocents));
    expect(await R.one(`fleet.fleet_ledger_verify() ->> 'ok'`)).toBe("true");
  });
});
