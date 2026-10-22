/**
 * v111: model-call costs are never lost. On v110 a result recorded after its reservation expired (5 min) was refused
 * (FLEET_COGNITION_NOT_AUTHORIZED: no log row, no charge, no provider-credit consumption), and a cost above its
 * reservation was charged only up to it with the excess booked to no one. Amounts are asserted, not only codes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { PgFleetStore, type CognitionRecord } from "../../fleet/postgres/store.js";
import { PgHubAdmin } from "../../fleet/hub/admin.js";
import { HUB_COMMANDS, runHubCommand } from "../../fleet/hub/cli.js";

const PG_BIN = findPgBin();
const route = { tier: "T2", provider: "anthropic", model: "claude-sonnet-5-5", taskClass: "founder_work", source: "class_minimum", scope: "task_step" };
const rec = (o: Partial<CognitionRecord> = {}): CognitionRecord => ({ outcome: "ok", inputTokens: 1_000, outputTokens: 200, promptSha256: "a".repeat(64), responseSha256: "b".repeat(64),
  toolCalls: [], errorCode: null, usageSource: "provider", attempts: 1, ...o });

describe.skipIf(!PG_BIN)("v111 cognition settlement integrity (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let svc: PgFleetStore;
  let A: string;
  let su: pg.Pool;
  const asSuper = async (sql: string, params: unknown[] = []) => {
    const c = await su.connect();
    try { await c.query("SET session_replication_role = replica"); return (await c.query(sql, params)).rows; } finally { await c.query("RESET session_replication_role"); c.release(); }
  };
  const authorize = (usdCents: number) => svc.cognitionRoutedAuthorize(A, usdCents, route, "c".repeat(64));
  const record = (id: string, r: Partial<CognitionRecord> = {}) => svc.cognitionRoutedRecord(A, id, rec(r), {});
  const expire = (id: string) => asSuper(`UPDATE fleet.fleet_cognition_inflight SET started_at = now() - interval '6 minutes' WHERE request_id = $1`, [id]);
  const cash = async () => R.balance(`agent:${A}:cash`);
  const consumption = async (id: string) => Number((await R.q(`SELECT COALESCE(-sum(usd_microcents), 0)::bigint AS n FROM fleet.fleet_provider_credit_events WHERE request_id = $1 AND kind = 'consumption'`, [id]))[0].n);
  /** What the record function computes, from the reservation's own price and FX snapshot (ledger microcents). */
  const costOf = async (id: string, inT: number, outT: number) => {
    const [i] = await R.q(`SELECT route_prices, fx_rate_micro, estimate_cents FROM fleet.fleet_cognition_inflight WHERE request_id = $1`, [id]);
    const usd = BigInt(inT) * BigInt(i.route_prices.in) + BigInt(outT) * BigInt(i.route_prices.out);
    const rate = BigInt(i.fx_rate_micro ?? 1_000_000);
    const ledger = (usd * rate + 999_999n) / 1_000_000n;                              // ceil, as the SQL
    return { usd, ledger, estimateMicro: BigInt(i.estimate_cents) * 1_000_000n };
  };

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, treasuryCents: 100_000 });
    A = R.founders[0].id;
    await R.store.grantServiceRole();
    svc = new PgFleetStore({ connectionString: R.pgc.serviceUrl });
    su = new pg.Pool({ connectionString: R.pgc.superUrl.replace(/\/postgres$/, `/${R.pgc.dbname}`), max: 1 });
    await R.q(`INSERT INTO fleet.fleet_provider_credit_events (provider, kind, usd_microcents, external_ref, recorded_by)
      SELECT 'anthropic', 'adjustment', 10000::bigint * 1000000 - fleet.fleet_provider_credit_balance('anthropic'), 'test: exact credit', 'operator:test'`);
    await R.genesis.setCognitionPolicy({ enabled: true, provider: "anthropic", model: "claude-opus-5-5", maxOutputTokens: 4_000, actor: OWNER,
      inputMicrocents: 400, outputMicrocents: 2_000, cacheWriteMicrocents: 500, cacheReadMicrocents: 20 });
    await R.genesis.setFounderCognition(A, { enabled: true, maxTurnsPerHour: 3_600, dailyBudgetCents: 10_000, reason: "t", actor: OWNER });
    for (const [t, m] of [["T2", "claude-sonnet-5-5"], ["T3", "claude-opus-5-5"]]) {
      await R.genesis.cognitionTierVerify(t, m, "test: models api 200", OWNER);
      await R.genesis.cognitionTierEnable(t, true, OWNER);
    }
    await R.genesis.cognitionRoutingSet(true, 2_000, OWNER);
    await R.genesis.founderRoutingSet(A, true, OWNER);
    await asSuper(`UPDATE fleet.fleet_cognition_tiers SET input_microcents_per_token = 200, output_microcents_per_token = 1000 WHERE tier = 'T2'`);
  });
  afterAll(async () => { await svc?.close(); await su?.end(); await R?.close(); });

  it("a result recorded after its reservation expired is charged exactly once; the expired hold does not block the next call", async () => {
    const first = await authorize(50);
    expect(first).toMatchObject({ ok: true });
    const id1 = String(first.requestId);
    expect(await authorize(50)).toMatchObject({ ok: false, code: "FLEET_COGNITION_BUSY" });     // one live call per agent
    await expire(id1);
    const second = await authorize(50);                                                         // v110 deleted id1 here
    expect(second).toMatchObject({ ok: true });
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_events WHERE event_type = 'cognition_reservation_unresolved' AND agent_id = $1`, [A]))[0].n).toBe(1);
    const state = await R.one<any>(`fleet.fleet_admin_cognition_settlement_state()`);
    expect(state.unresolved.map((u: any) => u.requestId)).toEqual([id1]);

    const { ledger } = await costOf(id1, 1_000, 200);
    const before = await cash();
    const late = await record(id1);
    expect(late).toMatchObject({ ok: true, late: true });
    const [log] = await R.q(`SELECT outcome, charged_microcents, provider_usd_microcents FROM fleet.fleet_cognition_log WHERE request_id = $1`, [id1]);
    expect(BigInt(log.charged_microcents)).toBe(ledger);                                        // the real cost, in the agent's currency
    expect(BigInt(await consumption(id1))).toBe(BigInt(log.provider_usd_microcents));            // provider credit consumed once
    expect(before - (await cash())).toBe(Number(late.chargedCents));
    expect(await record(id1)).toMatchObject({ ok: false, code: "FLEET_COGNITION_ALREADY_RECORDED" });   // exactly once
    // The live call's reservation survived the late record (v110 deleted every reservation of the agent).
    expect(await record(String(second.requestId))).toMatchObject({ ok: true, late: false });
  });

  it("a cost above the reservation is charged up to it; the excess is a cost exception that stops further calls until the owner allocates it", async () => {
    const r = await authorize(1);                                                              // a 1-cent reservation …
    const id = String(r.requestId);
    const { ledger, estimateMicro } = await costOf(id, 40_000, 8_000);                         // … for a far larger call
    expect(ledger).toBeGreaterThan(estimateMicro);
    const out = await record(id, { inputTokens: 40_000, outputTokens: 8_000 });
    expect(out).toMatchObject({ ok: true });
    expect(BigInt(out.overrunMicro as number)).toBe(ledger - estimateMicro);
    const [x] = await R.q(`SELECT exception_id, kind, status, ledger_microcents FROM fleet.fleet_cognition_cost_exceptions WHERE request_id = $1`, [id]);
    expect(x).toMatchObject({ kind: "overrun", status: "unallocated" });
    expect(BigInt(x.ledger_microcents)).toBe(ledger - estimateMicro);
    expect(await authorize(1)).toMatchObject({ ok: false, code: "FLEET_COGNITION_COST_EXCEPTION" });
    // The owner allocates it to the agent: one journal for the excess, rounded up to whole minor units.
    const before = await cash();
    const alloc = await R.one<any>(`fleet.fleet_admin_cognition_exception_allocate($1, 'agent', 'provider usage for the request confirms the excess', $2)`, [x.exception_id, OWNER]);
    const expectMinor = Number((ledger - estimateMicro + 999_999n) / 1_000_000n);
    expect(alloc).toMatchObject({ ok: true, allocatedTo: "agent", minor: expectMinor });
    expect(before - (await cash())).toBe(expectMinor);
    expect(await R.code(R.one(`fleet.fleet_admin_cognition_exception_allocate($1, 'treasury', 'again', $2)`, [x.exception_id, OWNER]))).toBe("FLEET_CONFLICT");
    expect(await R.code(R.one(`fleet.fleet_admin_cognition_exception_allocate($1, 'agent', 'not the owner', 'agent:x')`, [x.exception_id]))).toBe("FLEET_APPROVAL_REQUIRED");
    const next = await authorize(1);
    expect(next).toMatchObject({ ok: true });
    await record(String(next.requestId), { inputTokens: 1, outputTokens: 1 });
  });

  it("a call whose result never comes is resolved by the owner from provider evidence: billed (at its reservation, once) or not billed (released)", async () => {
    const a = await authorize(30);
    const idA = String(a.requestId);
    expect(await R.code(R.one(`fleet.fleet_admin_cognition_reservation_resolve($1, 'billed', 'too early', $2)`, [idA, OWNER]))).toBe("FLEET_CONFLICT");
    await expire(idA);
    const b = await authorize(30);
    const idB = String(b.requestId);
    await expire(idB);
    const before = await cash();
    const billed = await R.one<any>(`fleet.fleet_admin_cognition_reservation_resolve($1, 'billed', 'provider console shows the request billed', $2)`, [idA, OWNER]);
    expect(billed).toMatchObject({ ok: true, outcome: "billed", usageSource: "estimate" });
    const [log] = await R.q(`SELECT outcome, error_code, charged_microcents FROM fleet.fleet_cognition_log WHERE request_id = $1`, [idA]);
    expect(log).toMatchObject({ outcome: "error", error_code: "RESOLVED_BY_OWNER" });
    expect(Number(log.charged_microcents)).toBe(Number(a.estimateCents) * 1_000_000);
    expect(before - (await cash())).toBe(Number(billed.chargedCents));
    expect(await R.one<any>(`fleet.fleet_admin_cognition_reservation_resolve($1, 'not_billed', 'no usage at that time', $2)`, [idB, OWNER])).toMatchObject({ ok: true, released: true });
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_cognition_log WHERE request_id = $1`, [idB]))[0].n).toBe(0);
    expect((await R.one<any>(`fleet.fleet_admin_cognition_settlement_state()`)).unresolved).toEqual([]);
    expect(await R.code(R.one(`fleet.fleet_admin_cognition_reservation_resolve($1, 'billed', 'twice', $2)`, [idA, OWNER]))).toBe("FLEET_NOT_FOUND");
  });

  it("the owner's commands: view, resolve and allocate through the hub CLI (owner actor only)", async () => {
    for (const c of ["hub-cognition-settlement", "economy-cognition-resolve", "economy-cognition-exception-allocate"]) expect(HUB_COMMANDS.has(c)).toBe(true);
    const hub = new PgHubAdmin({ connectionString: R.pgc.ownerUrl });
    try {
      const st = (await runHubCommand("hub-cognition-settlement", [], hub, OWNER)) as Record<string, any>;
      expect(Array.isArray(st.unresolved) && Array.isArray(st.exceptions)).toBe(true);
      const a = await authorize(20); const id = String(a.requestId);
      await expire(id);
      expect(await R.code(runHubCommand("economy-cognition-resolve", [id, "not_billed", "no", "usage"], hub, "someone"))).toBe("FLEET_APPROVAL_REQUIRED");
      expect(await runHubCommand("economy-cognition-resolve", [id, "not_billed", "provider", "console", "shows", "no", "usage"], hub, OWNER)).toMatchObject({ ok: true, released: true });
    } finally { await hub.close(); }
  });

  const usdFor = async (minor: number) => {
    const rate = Number((await R.q(`SELECT rate_micro FROM fleet.fleet_fx_rates ORDER BY rate_id DESC LIMIT 1`))[0]?.rate_micro ?? 1_000_000);
    return Math.floor((minor * 1_000_000) / rate);                                          // a USD-cent estimate converting to at most `minor`
  };

  it("an unresolved hold is held against the agent's cash; releasing it frees exactly that amount and charges nothing", async () => {
    const c = await cash();
    const h = await authorize(await usdFor(c - 50));                                         // reserve nearly all of the cash …
    expect(h).toMatchObject({ ok: true });
    await expire(String(h.requestId));                                                       // … and its result never comes
    expect(await authorize(await usdFor(100))).toMatchObject({ ok: false, code: "FLEET_INSUFFICIENT_ALLOCATION" });   // held, not free
    await R.one(`fleet.fleet_admin_cognition_reservation_resolve($1, 'not_billed', 'provider usage shows no request then', $2)`, [String(h.requestId), OWNER]);
    expect(await cash()).toBe(c);                                                            // nothing charged
    const ok = await authorize(await usdFor(100));
    expect(ok).toMatchObject({ ok: true });                                                  // the hold is gone
    await record(String(ok.requestId), { inputTokens: 1, outputTokens: 1 });
  });

  it("concurrent settlements of one request (two late results and the owner's resolution) charge it exactly once", async () => {
    const a = await authorize(40); const id = String(a.requestId);
    await expire(id);
    const live = await authorize(10);                                                        // a newer call is active meanwhile
    const before = await cash();
    const [r1, r2, r3] = await Promise.allSettled([record(id), record(id),
      R.one(`fleet.fleet_admin_cognition_reservation_resolve($1, 'billed', 'provider shows it billed', $2)`, [id, OWNER])]);
    const oks = [r1, r2, r3].filter((r) => r.status === "fulfilled" && (r.value as any)?.ok === true);
    expect(oks).toHaveLength(1);
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_cognition_log WHERE request_id = $1`, [id]))[0].n).toBe(1);
    const [log] = await R.q(`SELECT charged_cents FROM fleet.fleet_cognition_log WHERE request_id = $1`, [id]);
    expect(before - (await cash())).toBe(Number(log.charged_cents));                         // one charge
    expect(await R.q(`SELECT 1 FROM fleet.fleet_cognition_inflight WHERE request_id = $1`, [String(live.requestId)])).toHaveLength(1);   // the newer call untouched
    expect(await authorize(10)).toMatchObject({ ok: false, code: "FLEET_COGNITION_BUSY" });   // and still the one live call
    await record(String(live.requestId), { inputTokens: 1, outputTokens: 1 });
  });

  it("exceptions are append-only and written only by their functions; the privilege audit is clean", async () => {
    expect(await R.code(R.q(`DELETE FROM fleet.fleet_cognition_cost_exceptions`))).toMatch(/FLEET_HISTORY_IMMUTABLE|permission denied/);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    expect(Number(await R.one(`(SELECT (fleet.fleet_ledger_verify() ->> 'ok')::boolean::int)`))).toBe(1);
  });

  it("engineering calls (the scenario harness's evidence) are imported once, as controller consumption of the owner's credit; no agent wallet is touched", async () => {
    const { CostMeter } = await import("../../fleet/eval/cost-meter.js");
    const m = new CostMeter({ runId: "eval-run-1", ceilingLedgerMicro: 300_000_000n, fxRateMicro: 747_613n, acquisition: { totalUsdCents: 8_400n, usdPurchasedMicro: 7_000_000_000n },
      prices: { "claude-opus-5-5": { inputMicrocentsPerToken: 400, outputMicrocentsPerToken: 2_000, cacheWriteMicrocentsPerToken: 500, cacheReadMicrocentsPerToken: 20 } } });
    m.scenario = "s1-interrupted";
    const p = m.wrap({ id: "anthropic", model: "claude-opus-5-5", chat: async () => ({ content: "", toolCalls: [], usage: { inputTokens: 9_000, outputTokens: 250 }, usageSource: "provider", attempts: 1, providerRequestId: "req_eng_1" }) });
    for (let i = 0; i < 3; i++) await p.chat({ agentId: "x", system: "s", messages: [{ role: "user", content: "hello" }], tools: [], maxTokens: 2_000 });
    const rows = JSON.parse(JSON.stringify(m.rows));
    const cash0 = await cash();
    const credit0 = Number(await R.one(`fleet.fleet_provider_credit_balance('anthropic')`));
    const r = await R.one<any>(`fleet.fleet_admin_engineering_calls_import('eval-run-1', 'anthropic', $1::jsonb, $2)`, [JSON.stringify(rows), OWNER]);
    const usd = rows.reduce((t: bigint, x: any) => t + BigInt(x.usdMicro), 0n);
    expect(r).toMatchObject({ ok: true, recorded: 3, alreadyRecorded: 0, usdMicro: Number(usd) });
    expect(BigInt(credit0) - BigInt(await R.one(`fleet.fleet_provider_credit_balance('anthropic')`))).toBe(usd);   // the provider credit, exactly
    expect(await cash()).toBe(cash0);                                                                                     // no agent pays
    const ev = await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_provider_credit_events WHERE recorded_by = 'controller:engineering:eval-run-1' AND kind = 'consumption'`);
    expect(ev[0].n).toBe(3);
    expect(await R.one<any>(`fleet.fleet_admin_engineering_calls_import('eval-run-1', 'anthropic', $1::jsonb, $2)`, [JSON.stringify(rows), OWNER])).toMatchObject({ recorded: 0, alreadyRecorded: 3 });
    expect(BigInt(credit0) - BigInt(await R.one(`fleet.fleet_provider_credit_balance('anthropic')`))).toBe(usd);   // a replay draws nothing more
    expect(await R.code(R.one(`fleet.fleet_admin_engineering_calls_import('other-run', 'anthropic', $1::jsonb, $2)`, [JSON.stringify(rows), OWNER]))).toBe("FLEET_BAD_REQUEST");
    expect(await R.code(R.one(`fleet.fleet_admin_engineering_calls_import('eval-run-1', 'anthropic', '[]'::jsonb, 'agent:x')`))).toBe("FLEET_APPROVAL_REQUIRED");
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });

  it("LAST (the agent dies): an unsettled call keeps the agent from counting as exhausted and its estate from settling; the late charge lands, then the estate settles", async () => {
    const a = await authorize(30); const id = String(a.requestId);
    await expire(id);
    const m = await R.one<any>(`fleet.fleet_agent_wallet_measure($1)`, [A]);
    expect(m.ownHeldMinor.modelCallsUnsettledMinor).toBe(Number(a.estimateCents));
    await R.one(`fleet.fleet_mark_dead($1, 'test: ended by the owner', $2, 'killed')`, [A, OWNER]).catch(async () =>
      R.one(`fleet.fleet_mark_dead($1, 'test: ended by the owner', $2)`, [A, OWNER]));
    expect(await R.code(R.one(`fleet.fleet_estate_settle($1, $2)`, [A, OWNER]))).toBe("FLEET_ESTATE_PENDING");
    const before = await cash();
    const late = await record(id);                                                           // the bill arrives after death
    expect(late).toMatchObject({ ok: true, late: true });
    expect(before - (await cash())).toBe(Number(late.chargedCents));                          // charged to the dead agent's estate cash
    expect(await R.code(R.one(`fleet.fleet_estate_settle($1, $2)`, [A, OWNER]))).not.toBe("FLEET_ESTATE_PENDING");
  });
});
