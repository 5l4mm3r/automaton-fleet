/**
 * Schema v117 — every Fleet Control AI call is funded before it is made, and every completed call is recorded once
 * (PostgreSQL; no provider, no network).
 *
 * Proven here:
 *  - a reservation holds the call's maximum in GBP (unallocated → control_reserved, one journal) and in provider credit
 *    (counted as held); without room, money or credit it is refused and nothing is held;
 *  - settlement records the consumption once (by request id), posts the charge from the hold (owed to the owner, v69 legs),
 *    releases the rest — once, whichever path reports first (worker, record path, sweep, owner); replays change nothing;
 *  - an unknown cost keeps its hold and tells Fleet Command; a late result settles it; the owner can reconcile it;
 *  - a call above its bound, or reported without a reservation, is still posted in full (never dropped);
 *  - claims wait while Fleet Control cannot be funded (no attempt used); the books verify.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";
import { CONTROL_RESERVED_ACCOUNT } from "../../fleet/postgres/migrations-phase117.js";

const PG_BIN = findPgBin();
const UNALLOC = "fleet:treasury:unallocated";

describe.skipIf(!PG_BIN)("v117: Fleet Control calls are funded before they are made and recorded once (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  const reserve = (kind: string, ref: string, maxUsd: number, req = crypto.randomUUID()) =>
    R.one<Record<string, any>>(`fleet.svc_fleet_control_ai_reserve($1, $2, $3, $4::uuid, 'anthropic')`, [kind, ref, maxUsd, req]).then((r) => ({ ...r, req }));
  const settle = (res: string, usd: number | null) => R.one<Record<string, any>>(`fleet.svc_fleet_control_ai_settle($1::uuid, $2)`, [res, usd]);
  const res = async (id: string) => (await R.q(`SELECT * FROM fleet.fleet_control_ai_reservations WHERE reservation_id = $1`, [id]))[0];
  const held = async () => Number(await R.one(`fleet.fleet_provider_credit_held('anthropic')`));
  const consumption = async (req: string) => (await R.q(`SELECT usd_microcents FROM fleet.fleet_provider_credit_events WHERE request_id = $1`, [req])).map((r) => Number(r.usd_microcents));
  const journals = async (kind?: string) => Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ledger_journal WHERE $1::text IS NULL OR kind = $1)`, [kind ?? null]));
  const events = async (type: string) => Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE event_type = $1)`, [type]));
  const minor = async (usd: number) => Number(await R.one(`fleet.fleet_usd_microcents_minor($1)`, [usd]));
  const rate = async () => Number(await R.one(`COALESCE((SELECT rate_micro FROM fleet.fleet_fx_rates WHERE base = 'USD' ORDER BY observed_on DESC, rate_id DESC LIMIT 1), 1000000)`));
  /** What the settlement posts for this kind: (accrued + ceil(usd × rate)) in whole minor units. */
  const posted = async (chargeKind: string, usd: number) => Number(await R.one(
    `((SELECT unposted_microcents FROM fleet.fleet_control_accrual WHERE kind = $1)
      + CEIL($2::numeric * COALESCE((SELECT rate_micro FROM fleet.fleet_fx_rates WHERE base = 'USD' ORDER BY observed_on DESC, rate_id DESC LIMIT 1), 1000000) / 1000000)::bigint) / 1000000`,
    [chargeKind, usd]));

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, treasuryCents: 100_000, simulatedSettlement: false });
    await R.one(`fleet.fleet_provider_credits_record('anthropic', 'purchase', 2000, 'v117-test-credit', $1)`, [OWNER]);   // $20 of provider credit
  }, 300_000);
  afterAll(async () => { await R?.close(); });

  it("migrates to v117 with a clean audit; its notices route to Fleet Command", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(117);
    const audit = (await R.store.auditPrivileges()).problems;
    expect(audit, JSON.stringify(audit)).toEqual([]);
    for (const [t, p] of [["fleet_control_ai_unfunded", "P2_IMPORTANT"], ["fleet_control_ai_cost_unknown", "P2_IMPORTANT"],
      ["fleet_control_ai_unreserved_call", "P2_IMPORTANT"], ["fleet_control_ai_reconciled", "P3_SUMMARY"]]) {
      expect(await R.one(`fleet.fleet_event_route($1, '{}'::jsonb)`, [t]), t).toBe(p);
    }
  });

  it("refuses without room, money or credit — nothing is held; the old unfunded form no longer exists", async () => {
    expect(await reserve("spend_review", "unset", 1_000_000)).toMatchObject({ ok: false, code: "FLEET_CONTROL_AI_BUDGET_UNSET" });
    await R.one(`fleet.fleet_admin_fleet_control_ai_budget(1000000000000000, 'test: ceiling out of the way', $1)`, [OWNER]);
    const u0 = await R.balance(UNALLOC), j0 = await journals(), h0 = await held();
    const money = await reserve("spend_review", "too-big-for-the-treasury", Math.ceil((u0 + 1) * 1_000_000 * 1_000_000 / await rate()) + 1_000_000);   // more GBP than unallocated
    expect(money).toMatchObject({ ok: false, code: "FLEET_CONTROL_AI_BUDGET_UNFUNDED" });
    expect(String(money.reason)).toMatch(/unallocated money/);
    // Provider credit: an engineering hold leaves $0.01 free; a call whose maximum is $0.02 is refused.
    const free = Number(await R.one(`fleet.fleet_provider_credit_balance('anthropic')`)) - h0;
    await R.one(`fleet.fleet_admin_engineering_credit_hold('v117-test-run', 'anthropic', $1, 'test: leave one cent free', $2)`, [free - 1_000_000, OWNER]);
    const j1 = await journals(), h1 = await held();
    const credit = await reserve("spend_review", "too-big-for-the-credit", 2_000_000);
    expect(credit).toMatchObject({ ok: false, code: "FLEET_CONTROL_AI_BUDGET_UNFUNDED" });
    expect(String(credit.reason)).toMatch(/provider credit/);
    expect([await R.balance(UNALLOC), await journals(), await held()]).toEqual([u0, j1, h1]);
    await R.one(`fleet.fleet_admin_engineering_credit_release('v117-test-run', 'test done', $1)`, [OWNER]);
    expect([await journals(), await held()]).toEqual([j0, h0]);
    expect(await events("fleet_control_ai_unfunded")).toBe(1);                                                     // told once
    expect(await R.code(R.q(`SELECT fleet.svc_fleet_control_ai_reserve('spend_review', 'x', 1000)`))).toBeTruthy();  // the 3-argument form is gone
  });

  it("holds the maximum before the call and settles once: consumption by request id, the charge from the hold, the rest released", async () => {
    const u0 = await R.balance(UNALLOC), p0 = await R.balance("fleet:owner:payable"), h0 = await held();
    const r = await reserve("spend_review", "review-1", 2_000_000);                                                 // $0.02 maximum
    const max = await minor(2_000_000);
    expect(r).toMatchObject({ ok: true, maxMinor: max, heldMinor: max });
    expect(await R.balance(UNALLOC)).toBe(u0 - max);
    expect(await R.balance(CONTROL_RESERVED_ACCOUNT)).toBe(max);
    expect(await held()).toBe(h0 + 2_000_000);                                                                     // credit held too
    const replay = await reserve("spend_review", "review-1", 2_000_000, r.req);
    expect(replay).toMatchObject({ ok: true, replay: true, reservationId: r.reservationId });
    expect(await journals("fleet_control_ai_hold")).toBe(1);
    const expectPosted = await posted("spend_review_charge", 1_234_567);
    const s = await settle(r.reservationId, 1_234_567);
    expect(s).toMatchObject({ ok: true, status: "settled", actualUsdMicrocents: 1_234_567, postedMinor: expectPosted });
    expect(await consumption(r.req)).toEqual([-1_234_567]);
    expect(await R.balance(CONTROL_RESERVED_ACCOUNT)).toBe(0);
    expect(await R.balance(UNALLOC)).toBe(u0 - expectPosted);
    expect(await R.balance("fleet:owner:payable")).toBe(p0 + expectPosted);                                         // owed to the owner (v69)
    expect(await held()).toBe(h0);
    // Replays (worker retry, a late record of the same call) change nothing.
    const j1 = await journals();
    expect(await settle(r.reservationId, 1_234_567)).toMatchObject({ ok: true, replay: true });
    expect(Number(await R.one(`fleet.fleet_control_charge('knowledge_review_charge', 'review-1', $1::jsonb)`,
      [JSON.stringify([{ requestId: r.req, provider: "anthropic", usdMicrocents: 1_234_567 }])]))).toBe(1_234_567);   // counted toward its review once…
    expect(Number(await R.one(`fleet.fleet_control_charge('knowledge_review_charge', 'review-1', $1::jsonb)`,
      [JSON.stringify([{ requestId: r.req, provider: "anthropic", usdMicrocents: 1_234_567 }])]))).toBe(0);           // …and never again
    expect([await journals(), (await consumption(r.req)).length]).toEqual([j1, 1]);
  });

  it("an unknown cost keeps its hold and tells Fleet Command; a late result settles it once", async () => {
    const r = await reserve("message_check", "check-1", 1_500_000);
    const max = await minor(1_500_000), h0 = await held();
    expect(await settle(r.reservationId, null)).toMatchObject({ ok: true, status: "unknown", kept: "hold" });
    expect(await res(r.reservationId)).toMatchObject({ status: "unknown", held_minor: String(max) });
    expect(await R.balance(CONTROL_RESERVED_ACCOUNT)).toBe(max);
    expect(await held()).toBe(h0);                                                                                 // still held
    expect(await events("fleet_control_ai_cost_unknown")).toBe(1);
    expect((await R.one<Record<string, any>>(`fleet.fleet_control_ai_state()`)).funding.unknownCost).toHaveLength(1);
    // The late result arrives through the record path.
    const u0 = await R.balance(UNALLOC), expectPosted = await posted("message_check_charge", 900_000);
    expect(Number(await R.one(`fleet.fleet_control_charge('message_check_charge', 'check-1', $1::jsonb)`,
      [JSON.stringify([{ requestId: r.req, provider: "anthropic", usdMicrocents: 900_000 }])]))).toBe(900_000);
    expect(await res(r.reservationId)).toMatchObject({ status: "settled", actual_usd_microcents: "900000", posted_minor: String(expectPosted) });
    expect(await consumption(r.req)).toEqual([-900_000]);
    expect(await R.balance(CONTROL_RESERVED_ACCOUNT)).toBe(0);
    expect(await R.balance(UNALLOC)).toBe(u0 + max - expectPosted);
    expect(await events("fleet_control_ai_reconciled")).toBe(1);
    expect(await settle(r.reservationId, 900_000)).toMatchObject({ replay: true });
  });

  it("the sweep settles a stale reservation from its recorded consumption, or marks it unknown; the owner reconciles", async () => {
    const a = await reserve("evidence_relevance", "attempt-a", 3_000_000);
    const b = await reserve("evidence_relevance", "attempt-b", 3_000_000);
    await R.q(`UPDATE fleet.fleet_control_ai_reservations SET reserved_at = now() - interval '20 minutes' WHERE reservation_id IN ($1, $2)`, [a.reservationId, b.reservationId]);
    // The relevance record path wrote a's consumption (it never posts GBP itself); b has nothing.
    await R.q(`INSERT INTO fleet.fleet_provider_credit_events (provider, kind, usd_microcents, request_id, recorded_by) VALUES ('anthropic', 'consumption', -2100000, $1, 'controller:evidence_relevance')`, [a.req]);
    const before = await journals("evidence_relevance_charge");
    const s = await R.one<Record<string, any>>(`fleet.svc_ai_credit_settle(20)`);
    expect(s.detection.fleetControlSweep).toEqual({ settled: 1, unknown: 1 });
    expect(await res(a.reservationId)).toMatchObject({ status: "settled", actual_usd_microcents: "2100000" });
    expect(await consumption(a.req)).toEqual([-2_100_000]);                                                        // not written twice
    expect(await journals("evidence_relevance_charge")).toBe(before + 1);                                          // relevance is now posted in GBP
    expect(await res(b.reservationId)).toMatchObject({ status: "unknown" });
    // Owner reconciliation from the console (0: the provider billed nothing): settled, the whole hold released.
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_fleet_control_ai_reconcile($1, 0, 'console usage page', 'agent:x')`, [b.reservationId]))).toBe("FLEET_APPROVAL_REQUIRED");
    expect(await R.one(`fleet.fleet_admin_fleet_control_ai_reconcile($1, 0, 'console usage page: no charge for that request', $2)`, [b.reservationId, OWNER]))
      .toMatchObject({ ok: true, status: "settled", postedMinor: 0 });
    expect(await consumption(b.req)).toEqual([]);
    expect(await R.balance(CONTROL_RESERVED_ACCOUNT)).toBe(0);
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_fleet_control_ai_reconcile($1, 0, 'again', $2)`, [b.reservationId, OWNER]))).toBe("FLEET_NOT_FOUND");
    // An open call still in flight cannot be reconciled by the owner.
    const c = await reserve("evidence_relevance", "attempt-c", 1_000_000);
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_fleet_control_ai_reconcile($1, 0, 'too early', $2)`, [c.reservationId, OWNER]))).toBe("FLEET_INVALID_STATE");
    await settle(c.reservationId, 0);
  });

  it("a cost above its bound, or a call reported without a reservation, is still posted in full", async () => {
    // Hold almost all unallocated money in one open reservation, so a bound overrun outruns the cash.
    const u = await R.balance(UNALLOC);
    const big = await reserve("knowledge_review", "big", Math.floor((u - 2) * 1_000_000 * 1_000_000 / await rate()));
    expect(big.ok, JSON.stringify(big)).toBe(true);
    const small = await reserve("knowledge_review", "small", 1_000);                                               // 1p held at most
    const p0 = await R.balance("fleet:owner:payable"), x0 = await R.balance("fleet:expense");
    const expectPosted = await posted("knowledge_review_charge", 900_000_000);                                      // $9: far above its bound
    const s = await settle(small.reservationId, 900_000_000);
    expect(s).toMatchObject({ ok: true, postedMinor: expectPosted });
    expect(await R.balance("fleet:owner:payable")).toBe(p0 + expectPosted);
    expect(await R.balance("fleet:expense")).toBe(x0 + expectPosted);
    expect(await R.balance(UNALLOC)).toBe(0);                                                                      // what cash there was, then owed without cash
    const ev = (await R.q(`SELECT detail FROM fleet.fleet_events WHERE event_type = 'fleet_control_ai_bound_exceeded' ORDER BY created_at DESC LIMIT 1`))[0].detail;
    expect(ev.owedWithoutCashMinor).toBeGreaterThan(0);
    await settle(big.reservationId, 0);                                                                            // released
    // Reported without a reservation (never expected): recorded and posted in full, and Fleet Command is told.
    const req = crypto.randomUUID(), j0 = await journals("message_check_charge");
    expect(Number(await R.one(`fleet.fleet_control_charge('message_check_charge', 'orphan', $1::jsonb)`,
      [JSON.stringify([{ requestId: req, provider: "anthropic", usdMicrocents: 3_000_000 }])]))).toBe(3_000_000);
    expect(await consumption(req)).toEqual([-3_000_000]);
    expect(await journals("message_check_charge")).toBe(j0 + 1);
    expect(await events("fleet_control_ai_unreserved_call")).toBe(1);
  });

  it("claims wait while Fleet Control cannot be funded; the books verify; nothing is held at rest", async () => {
    expect(await R.one(`fleet.fleet_control_ai_fundable($1, 1, 'T2')`, [(await R.balance(UNALLOC)) + 1])).toBe(false);   // more than unallocated
    expect(await R.one(`fleet.fleet_control_ai_fundable(1, 1, 'T2')`)).toBe(true);
    expect(await events("fleet_control_ai_unfunded")).toBe(1);                                                     // still once a day
    expect(await R.balance(CONTROL_RESERVED_ACCOUNT)).toBe(0);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_control_ai_reservations WHERE status IN ('open','unknown'))`))).toBe(0);
    expect(Number(await R.one(`(SELECT count(*) FROM (SELECT request_id FROM fleet.fleet_provider_credit_events WHERE request_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1) d)`))).toBe(0);
    expect(await R.one(`fleet.fleet_ledger_verify() ->> 'ok'`)).toBe("true");
  });
});
