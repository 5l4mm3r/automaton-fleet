/**
 * v118 regression and edge verification (owner, 26 Oct). The first v118 draft reversed promotional charges a minute later;
 * these cases failed on it (evidence: docs/evaluations/launch-candidate/evidence-v118-edges-20261026/) and must hold now:
 *  1. promotional use cannot cause false exhaustion, death or an invented refund (protection live and on);
 *  2. genuine wallet-zero death is unchanged (purchased credit, protection live);
 *  3. the uncollectable case (the agent's cash moved between authorisation and record): only the purchased shortfall is an
 *     exception, nothing is refunded later;
 *  4. concurrent calls and settlement passes succeed with no duplicate charge and no aborted pass;
 *  5. sub-penny amounts stay exact; a late result, a replayed record and a grant expiring mid-call stay safe;
 *  6. reservations never rely on promotional credit (documented: an agent without cash is refused even with credit left).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { PgFleetStore, type CognitionRecord } from "../../fleet/postgres/store.js";
import { OWNER_PAYABLE_ACCOUNT } from "../../fleet/postgres/migrations-phase69.js";

const PG_BIN = findPgBin();
const USD = 100_000_000;
const route = { tier: "T2", provider: "anthropic", model: "claude-sonnet-5-5", taskClass: "founder_work", source: "class_minimum", scope: "task_step" };
const rec = (inputTokens: number, outputTokens = 0): CognitionRecord => ({ outcome: "ok", inputTokens, outputTokens, promptSha256: "a".repeat(64),
  responseSha256: "b".repeat(64), toolCalls: [], errorCode: null, usageSource: "provider", attempts: 1 });

describe.skipIf(!PG_BIN)("v118 edges: promotional credit is never charged, so it can never drain a wallet (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let svc: PgFleetStore;
  let su: pg.Pool;
  let A: string, B: string, C: string, D: string;
  let rate = 1_000_000;
  const asSuper = async (sql: string, params: unknown[] = []) => {
    const c = await su.connect();
    try { await c.query("SET session_replication_role = replica"); return (await c.query(sql, params)).rows; } finally { await c.query("RESET session_replication_role"); c.release(); }
  };
  const cash = (a: string) => R.balance(`agent:${a}:cash`);
  const status = async (a: string) => String(await R.one(`(SELECT status FROM fleet.fleet_agents WHERE agent_id = $1)`, [a]));
  const events = async (type: string, a: string) => Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE event_type = $1 AND agent_id = $2)`, [type, a]));
  const draws = async (id: string) => (await R.q(`SELECT l.source, d.usd FROM fleet.fleet_ai_credit_draws d JOIN fleet.fleet_ai_credit_lots l ON l.lot_id = d.lot_id
    WHERE d.request_id = $1 ORDER BY d.draw_id`, [id])).map((r) => `${r.source}:${Number(r.usd) / USD}`);
  const promoLeft = async () => Number(await R.one(`(SELECT COALESCE(sum(usd_remaining), 0) FROM fleet.fleet_ai_credit_lots WHERE source = 'promotional' AND expires_at > now())`));
  const grant = (ref: string, cents: number, expires = "now() + interval '20 days'") => R.one(`fleet.fleet_admin_ai_credit_promotional_grant('anthropic', $1, $2, $2,
    now() - interval '1 day', ${expires}, 'assumed_cutoff', 'test display', 'test console', $3)`, [ref, cents, OWNER]);
  /** Authorise and record one call whose intended charge takes exactly all of the agent's cash. */
  async function spendAll(a: string) {
    const c = await cash(a);
    let usdCents = Math.floor(c * 1_000_000 / rate);
    while (Math.ceil(usdCents * rate / 1_000_000) < c) usdCents++;
    const auth = await svc.cognitionRoutedAuthorize(a, usdCents, route, "c".repeat(64));
    expect(auth, JSON.stringify(auth)).toMatchObject({ ok: true });
    const est = Number(await R.one(`(SELECT estimate_cents FROM fleet.fleet_cognition_inflight WHERE request_id = $1)`, [auth.requestId]));
    const tokens = Math.ceil(Math.ceil(est * 1e12 / rate) / 200);
    const r = await svc.cognitionRoutedRecord(a, String(auth.requestId), rec(tokens), {});
    return { id: String(auth.requestId), r, before: c };
  }

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 4, allocationCents: 100, treasuryCents: 100_000 });
    [A, B, C, D] = R.founders.map((f) => f.id);
    await R.store.grantServiceRole();
    svc = new PgFleetStore({ connectionString: R.pgc.serviceUrl });
    su = new pg.Pool({ connectionString: R.pgc.superUrl.replace(/\/postgres$/, `/${R.pgc.dbname}`), max: 1 });
    await R.genesis.setCognitionPolicy({ enabled: true, provider: "anthropic", model: "claude-opus-5-5", maxOutputTokens: 4_000, actor: OWNER,
      inputMicrocents: 400, outputMicrocents: 2_000, cacheWriteMicrocents: 500, cacheReadMicrocents: 20 });
    for (const a of [A, B, C, D]) await R.genesis.setFounderCognition(a, { enabled: true, maxTurnsPerHour: 3_600, dailyBudgetCents: 10_000, reason: "t", actor: OWNER });
    for (const [t, m] of [["T2", "claude-sonnet-5-5"], ["T3", "claude-opus-5-5"]]) {
      await R.genesis.cognitionTierVerify(t, m, "test: models api 200", OWNER);
      await R.genesis.cognitionTierEnable(t, true, OWNER);
    }
    await R.genesis.cognitionRoutingSet(true, 2_000, OWNER);
    for (const a of [A, B, C, D]) await R.genesis.founderRoutingSet(a, true, OWNER);
    rate = Number(await R.one(`COALESCE((SELECT rate_micro FROM fleet.fleet_fx_rates WHERE base = 'USD' ORDER BY observed_on DESC, rate_id DESC LIMIT 1), 1000000)`));
  }, 300_000);
  afterAll(async () => { await svc?.close(); await su?.end(); await R?.close(); });

  it("genuine wallet-zero death is unchanged: purchased credit, protection live — the agent dies", async () => {
    await R.one(`fleet.fleet_admin_survival_protection_agent_set($1, 'live', 'test: the survival rule applies', $2)`, [C, OWNER]);
    const s = await spendAll(C);
    expect(await draws(s.id)).toEqual([expect.stringMatching(/^owner:/)]);
    expect(await cash(C)).toBe(0);
    const tick = await R.store.lifecycleTick();
    expect(tick.insolvency).toMatchObject({ died: 1 });
    expect(await status(C)).toBe("dead");
  });

  it("REGRESSION: protection live — an agent's last pence on promotional credit is never charged, so it is not killed", async () => {
    await grant("promo-edge", 500);
    await R.one(`fleet.fleet_admin_survival_protection_agent_set($1, 'live', 'test: the survival rule applies', $2)`, [A, OWNER]);
    const s = await spendAll(A);
    expect(await draws(s.id)).toEqual([expect.stringMatching(/^promotional:/)]);
    expect(s.r).toMatchObject({ chargedCents: 0, chargedMicrocents: 0 });
    expect(await cash(A)).toBe(s.before);                                                // nothing was taken, nothing to give back
    expect((await R.one<Record<string, any>>(`fleet.fleet_agent_wallet_measure($1)`, [A])).exhausted).toBe(false);
    const tick = await R.store.lifecycleTick();
    expect(tick.insolvency).toMatchObject({ died: 0 });
    expect(await status(A)).toBe("active");
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE agent_id = $1 AND event_type IN ('agent_wallet_exhausted','agent_died','estate_settled'))`, [A]))).toBe(0);
  });

  it("REGRESSION: protection on — no false exhaustion notice", async () => {
    const s = await spendAll(B);
    expect(s.r).toMatchObject({ chargedCents: 0 });
    await R.store.lifecycleTick();
    expect(await status(B)).toBe("active");
    expect(await events("agent_exhaustion_protected", B)).toBe(0);
  });

  it("REPRODUCED: the uncollectable case — cash moved between authorisation and record; only the purchased shortfall is an exception, nothing is refunded", async () => {
    // Use up the promotional credit so the call is mixed, then move the agent's cash away before the result is recorded.
    const left = await promoLeft();
    const auth = await svc.cognitionRoutedAuthorize(D, 90, route, "c".repeat(64));
    expect(auth.ok, JSON.stringify(auth)).toBe(true);
    const c0 = await cash(D);
    await R.one(`fleet.fleet_admin_agent_transfer($1, $2, $3, 'test: cash moved mid-call', $4, $5, true)`, [D, B, c0 - 10, OWNER, `t:${crypto.randomUUID()}`]);
    const usd = left + 0.5 * USD;                                                        // the rest of the grant, then $0.50 purchased
    const tokens = Math.ceil(usd / 200);
    const p0 = await R.balance(OWNER_PAYABLE_ACCOUNT);
    const r = await svc.cognitionRoutedRecord(D, String(auth.requestId), rec(tokens), {});
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const ds = await draws(String(auth.requestId));
    expect(ds[0]).toMatch(/^promotional:/);
    expect(ds[1]).toMatch(/^owner:/);
    const intended = Number(r.chargedIntendedMicrocents), purchased = Number(r.chargedMicrocents);
    const promoUsd = Number(r.promotionalUsdMicrocents), callUsd = Number(r.providerUsdMicrocents);
    expect(purchased).toBe(Math.ceil(intended * (callUsd - promoUsd) / callUsd));
    expect(Number(r.chargedCents)).toBe(10);                                             // all the cash it still had
    expect(Number(r.uncollectableMinor)).toBeGreaterThan(0);
    const ex = (await R.q(`SELECT kind, ledger_microcents::bigint AS m FROM fleet.fleet_cognition_cost_exceptions WHERE request_id = $1`, [auth.requestId]));
    expect(ex.map((e) => e.kind)).toContain("uncollectable");
    const unc = Number(ex.find((e) => e.kind === "uncollectable")!.m);
    expect(unc).toBe(Number(r.uncollectableMinor) * 1_000_000);
    expect(10 * 1_000_000 + unc).toBeLessThanOrEqual(purchased + 1_000_000);              // posted + shortfall never exceeds the purchased part
    expect(await R.balance(OWNER_PAYABLE_ACCOUNT)).toBe(p0 + 10);                          // owed: what was actually posted
    const j0 = Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ledger_journal)`));
    await R.one(`fleet.svc_ai_credit_settle(20)`);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ledger_journal)`))).toBe(j0);   // no refund, ever
    expect(await cash(D)).toBe(0);
  });

  it("concurrent calls and settlement passes: no duplicate charge, no aborted pass", async () => {
    await grant("promo-conc", 2);                                                         // $0.02: less than the calls below need in total
    const auths = [];
    for (const a of [A, B]) {
      const x = await svc.cognitionRoutedAuthorize(a, 5, route, "c".repeat(64));
      expect(x.ok, JSON.stringify(x)).toBe(true);
      auths.push({ a, id: String(x.requestId) });
    }
    await R.one(`fleet.fleet_admin_fleet_control_ai_budget(100000, 'test budget', $1)`, [OWNER]);
    const fcReq = crypto.randomUUID();
    const fc = await R.one<Record<string, any>>(`fleet.svc_fleet_control_ai_reserve('message_check', 'conc', 3000000, $1::uuid, 'anthropic')`, [fcReq]);
    expect(fc.ok, JSON.stringify(fc)).toBe(true);
    const pools = [0, 1, 2, 3, 4, 5].map(() => new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 1 }));
    const svcs = [0, 1].map(() => new PgFleetStore({ connectionString: R.pgc.serviceUrl }));
    const p0 = await R.balance(OWNER_PAYABLE_ACCOUNT);
    let out: PromiseSettledResult<unknown>[];
    try {
      out = await Promise.allSettled([
        svcs[0].cognitionRoutedRecord(auths[0].a, auths[0].id, rec(10_000), {}),          // $0.02 each
        svcs[1].cognitionRoutedRecord(auths[1].a, auths[1].id, rec(10_000), {}),
        pools[0].query(`SELECT fleet.svc_fleet_control_ai_settle($1::uuid, 2000000) AS r`, [fc.reservationId]),
        pools[1].query(`SELECT fleet.svc_fleet_control_ai_settle($1::uuid, 2000000) AS r`, [fc.reservationId]),
        pools[2].query(`SELECT fleet.svc_ai_credit_settle(20) AS r`),
        pools[3].query(`SELECT fleet.svc_ai_credit_settle(20) AS r`),
        pools[4].query(`SELECT fleet.svc_ai_credit_settle(20) AS r`),
      ]);
    } finally { await Promise.all([...pools.map((p) => p.end()), ...svcs.map((s) => s.close())]); }
    const failed = out.filter((o) => o.status === "rejected").map((o) => String((o as PromiseRejectedResult).reason).slice(0, 200));
    expect(failed).toEqual([]);                                                           // every pass and call completed
    const recs = (out.slice(0, 2) as PromiseFulfilledResult<Record<string, any>>[]).map((o) => o.value);
    for (const r of recs) expect(r.ok, JSON.stringify(r)).toBe(true);
    const settles = (out.slice(2, 4) as PromiseFulfilledResult<pg.QueryResult>[]).map((o) => o.value.rows[0].r);
    expect(settles.filter((x) => x.replay).length).toBe(1);                              // one settled, the other a replay
    for (const id of [...auths.map((x) => x.id), fcReq]) {
      expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_provider_credit_events WHERE request_id = $1)`, [id]))).toBe(1);
      expect(Number(await R.one(`(SELECT COALESCE(sum(usd), 0) FROM fleet.fleet_ai_credit_draws WHERE request_id = $1)`, [id]))).toBe(2_000_000);
    }
    // $0.02 of promotional credit served exactly one $0.02 call's worth in total; whatever was purchased is owed, nothing else.
    const promoTotal = Number(await R.one(`(SELECT COALESCE(sum(d.usd), 0) FROM fleet.fleet_ai_credit_draws d JOIN fleet.fleet_ai_credit_lots l ON l.lot_id = d.lot_id
      WHERE l.external_ref = 'grant:anthropic:promo-conc')`));
    expect(promoTotal).toBe(2_000_000);
    const posted = recs.reduce((n, r) => n + Number(r.chargedCents), 0) + Number(settles.find((x) => !x.replay).postedMinor);
    expect(await R.balance(OWNER_PAYABLE_ACCOUNT)).toBe(p0 + posted);
    expect(await R.one(`fleet.fleet_ledger_verify() ->> 'ok'`)).toBe("true");
  });

  it("sub-penny calls stay exact: the accrual carries exactly the purchased microcents", async () => {
    expect(await promoLeft()).toBe(0);
    await R.one(`fleet.fleet_admin_agent_transfer($1, $2, 50, 'test: fund for sub-penny calls', $3, $4, true)`, [B, A, OWNER, `t:${crypto.randomUUID()}`]);
    const carry0 = Number(await R.one(`(SELECT COALESCE(unposted_microcents, 0) FROM fleet.fleet_cognition_accrual WHERE agent_id = $1)`, [A]));
    const c0 = await cash(A);
    let micro = 0, cents = 0;
    for (let i = 0; i < 7; i++) {                                                         // 7 × 1,700 input tokens: well under a penny each
      const x = await svc.cognitionRoutedAuthorize(A, 1, route, "c".repeat(64));
      expect(x.ok, JSON.stringify(x)).toBe(true);
      const r = await svc.cognitionRoutedRecord(A, String(x.requestId), rec(1_700), {});
      micro += Number(r.chargedMicrocents); cents += Number(r.chargedCents);
    }
    const carry1 = Number(await R.one(`(SELECT unposted_microcents FROM fleet.fleet_cognition_accrual WHERE agent_id = $1)`, [A]));
    expect(carry1 + cents * 1_000_000).toBe(carry0 + micro);                              // nothing lost or invented
    expect(c0 - (await cash(A))).toBe(cents);
  });

  it("a late result, a replayed record and a grant expiring mid-call stay safe", async () => {
    // Expiring within the hour: not counted as available for a new reservation.
    const h0 = Number(await R.one(`fleet.fleet_provider_credit_held('anthropic')`));
    await grant("promo-soon", 50, "now() + interval '30 minutes'");
    expect(Number(await R.one(`fleet.fleet_provider_credit_held('anthropic')`))).toBe(h0 + 50 * 1_000_000);
    // A call authorised while the grant is live, recorded after it expired: drawn from purchased, charged in full (the
    // authorisation needed the agent's own cash for the full estimate).
    const x = await svc.cognitionRoutedAuthorize(A, 1, route, "c".repeat(64));
    expect(x.ok, JSON.stringify(x)).toBe(true);
    await asSuper(`UPDATE fleet.fleet_ai_credit_lots SET expires_at = now() - interval '1 second' WHERE external_ref = 'grant:anthropic:promo-soon'`);
    const r = await svc.cognitionRoutedRecord(A, String(x.requestId), rec(1_000), {});
    expect(await draws(String(x.requestId))).toEqual(["owner:0.002"]);
    expect(Number(r.chargedMicrocents)).toBe(Number(r.chargedIntendedMicrocents));
    // Replay: the same record again is refused, nothing doubles.
    expect(await svc.cognitionRoutedRecord(A, String(x.requestId), rec(1_000), {})).toMatchObject({ ok: false, code: "FLEET_COGNITION_ALREADY_RECORDED" });
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_provider_credit_events WHERE request_id = $1)`, [x.requestId]))).toBe(1);
    // A late result (its reservation expired; another call started) is charged by its own draws, once.
    await grant("promo-late", 100);
    const first = await svc.cognitionRoutedAuthorize(A, 1, route, "c".repeat(64));
    await asSuper(`UPDATE fleet.fleet_cognition_inflight SET started_at = now() - interval '6 minutes' WHERE request_id = $1`, [first.requestId]);
    const second = await svc.cognitionRoutedAuthorize(A, 1, route, "c".repeat(64));
    expect(second.ok, JSON.stringify(second)).toBe(true);
    const c0 = await cash(A);
    const late = await svc.cognitionRoutedRecord(A, String(first.requestId), rec(1_000), {});
    expect(late).toMatchObject({ ok: true, late: true, chargedMicrocents: 0 });
    await svc.cognitionRoutedRecord(A, String(second.requestId), rec(1_000), {});
    expect(await cash(A)).toBe(c0);                                                      // both on promotional credit: nothing charged
    expect(await R.one(`fleet.fleet_ledger_verify() ->> 'ok'`)).toBe("true");
  });

  it("reservations never rely on promotional credit (documented): no cash, no call — even with credit left", async () => {
    expect(await promoLeft()).toBeGreaterThan(0);
    const cb = await cash(B);
    if (cb > 0) await R.one(`fleet.fleet_admin_agent_transfer($1, $2, $3, 'test: empty the wallet', $4, $5, true)`, [B, A, cb, OWNER, `t:${crypto.randomUUID()}`]);
    expect(await cash(B)).toBe(0);
    const r = await svc.cognitionRoutedAuthorize(B, 1, route, "c".repeat(64));
    expect(r).toMatchObject({ ok: false, code: "FLEET_INSUFFICIENT_ALLOCATION" });
    console.log("EDGE documented: authorise with cash 0 and promotional credit left →", JSON.stringify(r));
  });
});
