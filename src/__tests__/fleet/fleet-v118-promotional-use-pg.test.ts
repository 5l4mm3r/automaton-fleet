/**
 * Schema v118 — the credit that pays is known before the charge is posted (PostgreSQL; the real charge paths: routed agent
 * inference and a Fleet Control settlement; no provider, no network).
 *
 * Proven here, with amounts, at the moment the call is recorded (no later pass needed):
 *  - a call wholly on promotional credit charges no one and owes no one: every balance is unchanged;
 *  - a call split across promotional and purchased credit charges, and owes the owner, the purchased part only;
 *  - a call on purchased credit alone keeps the v69 legs unchanged;
 *  - a Fleet Control call on promotional credit posts nothing; its hold is released whole;
 *  - the log keeps intended, promotional, purchased and posted amounts apart; the status keeps promotional consumed,
 *    purchased consumed and any internal agent charge (none approved) separate; the minutely pass does nothing for it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
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

describe.skipIf(!PG_BIN)("v118: the credit that pays is known before the charge (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let svc: PgFleetStore;
  let A: string;
  const books = async () => ({ payable: await R.balance(OWNER_PAYABLE_ACCOUNT), reimbursable: await R.balance(REIMBURSABLE_ACCOUNT),
    cash: await R.balance(`agent:${A}:cash`), agentExpense: await R.balance(`agent:${A}:expense`), unallocated: await R.balance("fleet:treasury:unallocated"),
    expense: await R.balance("fleet:expense"), reserved: await R.balance("fleet:treasury:control_reserved") });
  const infer = async () => {
    const a = await svc.cognitionRoutedAuthorize(A, 100, route, "c".repeat(64));
    expect(a, JSON.stringify(a)).toMatchObject({ ok: true });
    const r = await svc.cognitionRoutedRecord(A, String(a.requestId), rec(), {});
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    return { id: String(a.requestId), r };
  };
  const draws = async (id: string) => (await R.q(`SELECT l.source, d.usd FROM fleet.fleet_ai_credit_draws d JOIN fleet.fleet_ai_credit_lots l ON l.lot_id = d.lot_id
    WHERE d.request_id = $1 ORDER BY d.draw_id`, [id])).map((r) => `${r.source}:${Number(r.usd) / USD}`);
  const log = async (id: string) => (await R.q(`SELECT promotional_usd_microcents::text AS promo, charged_intended_microcents::text AS intended,
    charged_microcents::text AS purchased, charged_cents::text AS posted FROM fleet.fleet_cognition_log WHERE request_id = $1`, [id]))[0];
  const grant = (ref: string, cents: number) => R.one(`fleet.fleet_admin_ai_credit_promotional_grant('anthropic', $1, $2, $2, now() - interval '1 day', now() + interval '20 days',
    'assumed_cutoff', 'test display', 'test console', $3)`, [ref, cents, OWNER]);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, treasuryCents: 100_000 });
    A = R.founders[0].id;
    await R.store.grantServiceRole();
    svc = new PgFleetStore({ connectionString: R.pgc.serviceUrl });
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
  afterAll(async () => { await svc?.close(); await R?.close(); });

  it("migrates to v118 with a clean audit; the status keeps the three apart", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(118);
    const audit = (await R.store.auditPrivileges()).problems;
    expect(audit, JSON.stringify(audit)).toEqual([]);
    const st = await R.one<Record<string, any>>(`fleet.fleet_ai_credit_status()`);
    expect(st.consumed.internalChargeToAgentsForPromotional).toEqual({ policy: "none approved", postedMinor: 0 });
    expect(st.consumed.promotional).toMatchObject({ chargedMinor: 0, owedToOwnerMinor: 0 });
    expect(String(st.promotionalTreatment)).toMatch(/charged to no one and owed to no one/);
  });

  it("a call wholly on promotional credit charges no one and owes no one — at once", async () => {
    const b0 = await books();
    const c = await infer();
    expect(await draws(c.id)).toEqual(["promotional:0.6"]);
    expect(c.r).toMatchObject({ chargedCents: 0, chargedMicrocents: 0, promotionalUsdMicrocents: 0.6 * USD });
    expect(Number(c.r.chargedIntendedMicrocents)).toBeGreaterThan(0);
    expect(await books()).toEqual(b0);                                                    // nothing moved, no pass needed
    expect(await log(c.id)).toEqual({ promo: String(0.6 * USD), intended: String(c.r.chargedIntendedMicrocents), purchased: "0", posted: "0" });
  });

  it("a call split across promotional and purchased credit charges, and owes, the purchased part only", async () => {
    const b0 = await books();
    const carry0 = Number(await R.one(`(SELECT unposted_microcents FROM fleet.fleet_cognition_accrual WHERE agent_id = $1)`, [A]));
    const c = await infer();
    expect(await draws(c.id)).toEqual(["promotional:0.4", "owner:0.2"]);                  // $0.40 of the grant left, then purchased
    const intended = Number(c.r.chargedIntendedMicrocents);
    const purchased = Math.ceil(intended * 0.2 / 0.6);                                    // the intended charge × purchased ÷ total, rounded up
    expect(Number(c.r.chargedMicrocents)).toBe(purchased);
    const posted = Math.floor((carry0 + purchased) / 1_000_000);
    expect(Number(c.r.chargedCents)).toBe(posted);
    const b1 = await books();
    expect(b1.payable - b0.payable).toBe(posted);                                         // owed: the purchased part only
    expect(b1.reimbursable - b0.reimbursable).toBe(posted);
    expect(b0.cash - b1.cash).toBe(posted);
    expect(b1.agentExpense - b0.agentExpense).toBe(posted);
    expect(await log(c.id)).toEqual({ promo: String(0.4 * USD), intended: String(intended), purchased: String(purchased), posted: String(posted) });
  });

  it("a call on purchased credit alone keeps the v69 legs unchanged", async () => {
    const b0 = await books();
    const c = await infer();
    expect(await draws(c.id)).toEqual(["owner:0.6"]);
    expect(Number(c.r.chargedMicrocents)).toBe(Number(c.r.chargedIntendedMicrocents));
    const b1 = await books();
    expect(b1.payable - b0.payable).toBe(Number(c.r.chargedCents));
    expect(b0.cash - b1.cash).toBe(Number(c.r.chargedCents));
  });

  it("a Fleet Control call on promotional credit posts nothing; its hold is released whole", async () => {
    await grant("promo-b", 100);
    await R.one(`fleet.fleet_admin_fleet_control_ai_budget(100000, 'test budget', $1)`, [OWNER]);
    const b0 = await books();
    const req = crypto.randomUUID();
    const r = await R.one<Record<string, any>>(`fleet.svc_fleet_control_ai_reserve('message_check', 'check-x', 9000000, $1::uuid, 'anthropic')`, [req]);
    expect(r).toMatchObject({ ok: true });
    const s = await R.one<Record<string, any>>(`fleet.svc_fleet_control_ai_settle($1::uuid, 8000000)`, [r.reservationId]);   // $0.08
    expect(await draws(req)).toEqual(["promotional:0.08"]);
    expect(s).toMatchObject({ ok: true, postedMinor: 0, promotionalUsdMicrocents: 8_000_000, releasedMinor: Number(r.heldMinor) });
    expect(await books()).toEqual(b0);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_provider_credit_events WHERE request_id = $1)`, [req]))).toBe(1);
  });

  it("the minutely pass does nothing for promotional use; the status reports it apart; the books verify", async () => {
    const j0 = Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ledger_journal)`));
    const s = await R.one<Record<string, any>>(`fleet.svc_ai_credit_settle(20)`);
    expect(s.detection.promotionalUse).toBeUndefined();
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ledger_journal)`))).toBe(j0);
    const st = await R.one<Record<string, any>>(`fleet.fleet_ai_credit_status()`);
    expect(st.consumed.promotional).toMatchObject({ usdMicrocents: 0.6 * USD + 0.4 * USD + 0.08 * USD,
      agentCalls: { calls: 2, usdMicrocents: 1 * USD }, fleetControlCalls: { calls: 1, usdMicrocents: 0.08 * USD } });
    expect(st.consumed.purchased.usdMicrocents).toBe(0.2 * USD + 0.6 * USD);
    expect(await R.one(`fleet.fleet_ledger_verify() ->> 'ok'`)).toBe("true");
  });
});
