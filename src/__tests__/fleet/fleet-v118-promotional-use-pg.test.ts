/**
 * Schema v118 — promotional credit used by Fleet costs nothing and is owed to no one (PostgreSQL; the real charge paths:
 * routed agent inference and a Fleet Control reservation; no provider, no network).
 *
 * Proven here, with amounts:
 *  - a call fully covered by promotional credit leaves the owner payable, the agent's cash and expense exactly where they were;
 *  - a call split across promotional and purchased credit owes the owner only the purchased part (the evidenced reimbursement);
 *  - a call on purchased credit alone keeps the v69 legs unchanged;
 *  - a Fleet Control call on promotional credit costs the treasury nothing; settling again changes nothing (no double reversal);
 *  - a promotional draw whose charge cannot be found is recorded, reversed for no one, and reported;
 *  - the status keeps promotional consumed, purchased consumed and any internal agent charge (none approved) separate.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { PgFleetStore, type CognitionRecord } from "../../fleet/postgres/store.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";
import { OWNER_PAYABLE_ACCOUNT, REIMBURSABLE_ACCOUNT } from "../../fleet/postgres/migrations-phase69.js";

const PG_BIN = findPgBin();
const USD = 100_000_000;
const route = { tier: "T2", provider: "anthropic", model: "claude-sonnet-5-5", taskClass: "founder_work", source: "class_minimum", scope: "task_step" };
// 200,000 input + 20,000 output tokens at T2 (200 / 1,000 µ¢): $0.60 per call.
const rec = (): CognitionRecord => ({ outcome: "ok", inputTokens: 200_000, outputTokens: 20_000, promptSha256: "a".repeat(64), responseSha256: "b".repeat(64),
  toolCalls: [], errorCode: null, usageSource: "provider", attempts: 1 });

describe.skipIf(!PG_BIN)("v118: promotional use is owed to no one and charged to no one (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let svc: PgFleetStore;
  let A: string;
  let su: pg.Pool;
  const asSuper = async (sql: string, params: unknown[] = []) => {
    const c = await su.connect();
    try { await c.query("SET session_replication_role = replica"); return (await c.query(sql, params)).rows; } finally { await c.query("RESET session_replication_role"); c.release(); }
  };
  const books = async () => ({ payable: await R.balance(OWNER_PAYABLE_ACCOUNT), reimbursable: await R.balance(REIMBURSABLE_ACCOUNT),
    cash: await R.balance(`agent:${A}:cash`), agentExpense: await R.balance(`agent:${A}:expense`), unallocated: await R.balance("fleet:treasury:unallocated"),
    expense: await R.balance("fleet:expense") });
  const settle = () => R.one<Record<string, any>>(`fleet.svc_ai_credit_settle(20)`);
  const infer = async () => {
    const a = await svc.cognitionRoutedAuthorize(A, 100, route, "c".repeat(64));
    expect(a, JSON.stringify(a)).toMatchObject({ ok: true });
    const r = await svc.cognitionRoutedRecord(A, String(a.requestId), rec(), {});
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    return { id: String(a.requestId), chargedCents: Number(r.chargedCents) };
  };
  const draws = async (id: string) => (await R.q(`SELECT l.source, d.usd FROM fleet.fleet_ai_credit_draws d JOIN fleet.fleet_ai_credit_lots l ON l.lot_id = d.lot_id
    WHERE d.request_id = $1 ORDER BY d.draw_id`, [id])).map((r) => `${r.source}:${Number(r.usd) / USD}`);
  const charged = async (id: string) => Number((await R.q(`SELECT charged_microcents FROM fleet.fleet_cognition_log WHERE request_id = $1`, [id]))[0].charged_microcents);
  const grant = (ref: string, cents: number) => R.one(`fleet.fleet_admin_ai_credit_promotional_grant('anthropic', $1, $2, $2, now() - interval '1 day', now() + interval '20 days',
    'assumed_cutoff', 'test display', 'test console', $3)`, [ref, cents, OWNER]);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, treasuryCents: 100_000 });
    A = R.founders[0].id;
    await R.store.grantServiceRole();
    svc = new PgFleetStore({ connectionString: R.pgc.serviceUrl });
    su = new pg.Pool({ connectionString: R.pgc.superUrl.replace(/\/postgres$/, `/${R.pgc.dbname}`), max: 1 });
    await R.genesis.setCognitionPolicy({ enabled: true, provider: "anthropic", model: "claude-opus-5-5", maxOutputTokens: 4_000, actor: OWNER,
      inputMicrocents: 400, outputMicrocents: 2_000, cacheWriteMicrocents: 500, cacheReadMicrocents: 20 });
    await R.genesis.setFounderCognition(A, { enabled: true, maxTurnsPerHour: 3_600, dailyBudgetCents: 10_000, reason: "t", actor: OWNER });
    for (const [t, m] of [["T2", "claude-sonnet-5-5"], ["T3", "claude-opus-5-5"]]) {
      await R.genesis.cognitionTierVerify(t, m, "test: models api 200", OWNER);
      await R.genesis.cognitionTierEnable(t, true, OWNER);
    }
    await R.genesis.cognitionRoutingSet(true, 2_000, OWNER);
    await R.genesis.founderRoutingSet(A, true, OWNER);
    await grant("promo-a", 100);                                                          // $1.00 of promotional credit
  }, 300_000);
  afterAll(async () => { await svc?.close(); await su?.end(); await R?.close(); });

  it("migrates to v118 with a clean audit; the status keeps the three apart", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(118);
    const audit = (await R.store.auditPrivileges()).problems;
    expect(audit, JSON.stringify(audit)).toEqual([]);
    expect(await R.one(`fleet.fleet_event_route('ai_credit_promotional_unattributed', '{}'::jsonb)`)).toBe("P2_IMPORTANT");
    const st = await R.one<Record<string, any>>(`fleet.fleet_ai_credit_status()`);
    expect(st.consumed.internalChargeToAgentsForPromotional).toEqual({ policy: "none approved", postedMinor: 0 });
    expect(String(st.promotionalTreatment)).toMatch(/owed to no one and charged to no one/);
  });

  it("a call covered by promotional credit: no owner payable, the agent pays nothing, the use is recorded", async () => {
    const b0 = await books();
    const c = await infer();
    expect(await draws(c.id)).toEqual(["promotional:0.6"]);
    expect(c.chargedCents).toBeGreaterThan(0);
    const b1 = await books();
    expect(b1.payable - b0.payable).toBe(c.chargedCents);                                // the charge path posts the v69 legs first…
    const s = await settle();
    expect(s.detection.promotionalUse).toMatchObject({ attributed: 1, reversedMinor: c.chargedCents });
    expect(await books()).toEqual(b0);                                                    // …and the settlement takes them back exactly
    expect(await R.q(`SELECT payer, agent_id, usd::text, gbp_micro::text, basis FROM fleet.fleet_ai_credit_promotional_uses WHERE request_id = $1`, [c.id]))
      .toEqual([{ payer: "agent", agent_id: A, usd: String(0.6 * USD), gbp_micro: String(await charged(c.id)), basis: "charge" }]);
    expect((await settle()).detection.promotionalUse).toEqual({ attributed: 0, reversedMinor: 0, unattributed: 0 });   // no double reversal
    expect(await books()).toEqual(b0);
  });

  it("a call split across promotional and purchased credit owes the owner only the purchased part", async () => {
    const b0 = await books();
    const posted0 = Number(await R.one(`(SELECT COALESCE(sum(posted_minor), 0) FROM fleet.fleet_ai_credit_promotional_accrual)`));
    const micro0 = Number(await R.one(`(SELECT COALESCE(sum(micro), 0) FROM fleet.fleet_ai_credit_promotional_accrual)`));
    const c = await infer();
    expect(await draws(c.id)).toEqual(["promotional:0.4", "owner:0.2"]);                  // $0.40 of the grant left, then purchased
    await settle();
    const promoMicro = Number(await R.one(`(SELECT gbp_micro FROM fleet.fleet_ai_credit_promotional_uses WHERE request_id = $1)`, [c.id]));
    expect(promoMicro).toBe(Math.round(await charged(c.id) * 0.4 / 0.6));                 // the charge × promotional / the call's USD
    const reversed = Math.floor((micro0 + promoMicro) / 1_000_000) - posted0;
    const b1 = await books();
    expect(b1.payable - b0.payable).toBe(c.chargedCents - reversed);                     // owed: the purchased part only
    expect(b1.reimbursable - b0.reimbursable).toBe(c.chargedCents - reversed);
    expect(b0.cash - b1.cash).toBe(c.chargedCents - reversed);                           // the agent pays the purchased part (v69, unchanged)
    expect(b1.agentExpense - b0.agentExpense).toBe(c.chargedCents - reversed);
  });

  it("a call on purchased credit alone keeps the v69 legs unchanged", async () => {
    const b0 = await books();
    const c = await infer();
    expect(await draws(c.id)).toEqual(["owner:0.6"]);
    const s = await settle();
    expect(s.detection.promotionalUse.attributed).toBe(0);
    const b1 = await books();
    expect(b1.payable - b0.payable).toBe(c.chargedCents);
    expect(b0.cash - b1.cash).toBe(c.chargedCents);
  });

  it("a Fleet Control call on promotional credit costs the treasury nothing and is owed to no one; settling twice changes nothing", async () => {
    await grant("promo-b", 100);
    await R.one(`fleet.fleet_admin_fleet_control_ai_budget(100000, 'test budget', $1)`, [OWNER]);
    const b0 = await books();
    const req = crypto.randomUUID();
    const r = await R.one<Record<string, any>>(`fleet.svc_fleet_control_ai_reserve('message_check', 'check-x', 9000000, $1::uuid, 'anthropic')`, [req]);
    expect(r).toMatchObject({ ok: true });
    const s = await R.one<Record<string, any>>(`fleet.svc_fleet_control_ai_settle($1::uuid, 8000000)`, [r.reservationId]);   // $0.08
    expect(await draws(req)).toEqual(["promotional:0.08"]);
    const posted = Number(s.postedMinor);
    expect(posted).toBeGreaterThan(0);
    const before = await books();
    expect(before.payable - b0.payable).toBe(posted);
    const j0 = Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ledger_journal)`));
    await settle();
    const after = await books();
    // Reversed in whole pence per payer (the treasury's carry stays as accrued micro, never posted beyond what was charged).
    const acc = (await R.q(`SELECT micro::bigint AS m, posted_minor::bigint AS p FROM fleet.fleet_ai_credit_promotional_accrual WHERE cash_account = 'fleet:treasury:unallocated'`))[0];
    expect(Number(acc.p)).toBe(Math.floor(Number(acc.m) / 1_000_000));
    expect(after.payable).toBe(b0.payable + posted - (Number(acc.p)));
    expect(after.unallocated).toBe(b0.unallocated - posted + Number(acc.p));
    expect(after.expense).toBe(b0.expense + posted - Number(acc.p));
    expect(Number(acc.p)).toBe(posted);                                                   // here the whole charge came back
    expect(after).toEqual(b0);
    const j1 = Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ledger_journal)`));
    await settle();
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ledger_journal)`))).toBe(j1);   // no double reversal
    expect(j1).toBe(j0 + 1);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_provider_credit_events WHERE request_id = $1)`, [req]))).toBe(1);
  });

  it("a promotional draw whose charge cannot be found is recorded and reported, reversed for no one", async () => {
    const b0 = await books();
    const req = crypto.randomUUID();
    await R.q(`INSERT INTO fleet.fleet_provider_credit_events (provider, kind, usd_microcents, request_id, recorded_by) VALUES ('anthropic', 'consumption', -1000000, $1, 'controller')`, [req]);
    expect(await draws(req)).toEqual(["promotional:0.01"]);
    expect((await settle()).detection.promotionalUse.attributed).toBe(0);                // not yet: its charge may still be recorded
    await asSuper(`UPDATE fleet.fleet_ai_credit_draws SET at = now() - interval '61 minutes' WHERE request_id = $1`, [req]);
    expect((await settle()).detection.promotionalUse).toMatchObject({ attributed: 1, reversedMinor: 0, unattributed: 1 });
    expect(await R.q(`SELECT payer, gbp_micro::text, basis FROM fleet.fleet_ai_credit_promotional_uses WHERE request_id = $1`, [req]))
      .toEqual([{ payer: "none", gbp_micro: "0", basis: "unattributed" }]);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE event_type = 'ai_credit_promotional_unattributed')`))).toBe(1);
    expect(await books()).toEqual(b0);
  });

  it("reports the three separately; the books verify", async () => {
    const st = await R.one<Record<string, any>>(`fleet.fleet_ai_credit_status()`);
    expect(st.consumed.promotional).toMatchObject({ usdMicrocents: 0.6 * USD + 0.4 * USD + 0.08 * USD + 0.01 * USD, calls: 4, unattributedDraws: 1, pendingDraws: 0 });
    expect(Object.keys(st.consumed.promotional.byPayer).sort()).toEqual(["agent", "fleet_control", "none"]);
    expect(st.consumed.purchased.usdMicrocents).toBe(0.2 * USD + 0.6 * USD);
    expect(st.consumed.internalChargeToAgentsForPromotional.postedMinor).toBe(0);
    expect(await R.one(`fleet.fleet_ledger_verify() ->> 'ok'`)).toBe("true");
  });
});
