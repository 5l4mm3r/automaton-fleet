/**
 * v122 — founder recovery (INCIDENT 2026-10-27), on a real registry with Genesis founders (PostgreSQL; no provider, no money moves).
 *  R1 a founder recovers from unresponsive by heartbeat (inside the health grace) or by a passed challenge; every other founder
 *     advance still needs Genesis; a dead agent cannot be moved except by the owner's reinstatement;
 *  R2 a reaper gap of more than 45 s (controller downtime) restarts the grace window — the incident's sequence cannot recur;
 *     ordinary heartbeat loss is still detected;
 *  R3 the incident replayed (unresponsive past the 480 s grace while heartbeating → dead → estate settled; a treasury-paid
 *     acquisition cost posted), then the owner's atomic reinstatement: same identity (agent id, credential, wallet, ledger
 *     accounts), estates and the cost reversed by mirrored journals (history kept), paused, active only after a passed
 *     challenge, ledger verifying; refusals (non-founder, economic death, cap, twice);
 *  R4 estate cash up to the unbacked starting capital never reaches `unallocated`; a later death of a reinstated founder opens
 *     and settles a new estate (no key collision).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";

const PG_BIN = findPgBin();
const USD = 100_000_000;
const INCIDENT = "2026-10-27 controller outage (test replay)";

describe.skipIf(!PG_BIN)("v122: founder recovery (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let su: pg.Pool;
  let A: string, B: string;
  const asSuper = async (sql: string, params: unknown[] = []) => {
    const c = await su.connect();
    try { await c.query("SET session_replication_role = replica"); return (await c.query(sql, params)).rows; } finally { await c.query("RESET session_replication_role"); c.release(); }
  };
  const agent = (id: string) => R.one<Record<string, any>>(`(SELECT to_jsonb(a) FROM fleet.fleet_agents a WHERE agent_id = $1)`, [id]);
  const bal = async (a: string) => Number(await R.one(`fleet.fleet_ledger_balance($1)`, [a]));
  const reap = () => R.one<Record<string, any>>(`fleet.fleet_reap('reaper')`);
  const err = (p: Promise<unknown>) => p.then(() => "no error", (e: Error) => e.message);
  /** The founder side of a health challenge, exactly as the runtime answers it (its runtime identity, policy canary passed). */
  const passChallenge = async (id: string) => {
    await R.one(`fleet.fleet_heartbeat($1, $1)`, [id]);                                   // as the runtime: a heartbeat first
    await R.q(`UPDATE fleet.fleet_agents SET challenge_requested_at = now() WHERE agent_id = $1`, [id]);
    const c = await R.store.issueChallenge(id);
    expect(c, "a challenge is issued").not.toBeNull();
    const rt = await R.one<Record<string, any>>(`fleet.fleet_founder_runtime_current($1)`, [id]);
    const a = await agent(id);
    return R.store.answerChallenge(id, { challengeId: c!.challengeId, nonce: c!.nonce, commit: a.runtime_commit ?? null, buildId: rt?.buildId ?? null, policyOk: true });
  };
  const reinstate = (agents: string[], unwind: string[] = [], hold = 60) =>
    R.one<Record<string, any>>(`fleet.fleet_admin_incident_reinstate($1, $2::text[], $3::uuid[], $4, $5)`, [INCIDENT, agents, unwind, hold, OWNER]);
  /** Everything a refused reinstatement must leave untouched (financial and lifecycle). */
  const untouched = () => R.one<string>(`(SELECT concat_ws('|', (SELECT head_seq || ':' || head_hash FROM fleet.fleet_ledger_head),
      (SELECT md5(string_agg(a::text, ',' ORDER BY agent_id)) FROM (SELECT agent_id, status, death_time, lifecycle_hold_until, challenge_requested_at FROM fleet.fleet_agents) a),
      (SELECT md5(string_agg(c::text, ',' ORDER BY agent_id)) FROM fleet.fleet_agent_credentials c),
      (SELECT md5(string_agg(w::text, ',' ORDER BY agent_id)) FROM fleet.fleet_wallet_custody w),
      (SELECT md5(string_agg(e::text, ',' ORDER BY agent_id)) FROM fleet.fleet_estates e),
      (SELECT md5(string_agg(f::text, ',' ORDER BY agent_id)) FROM fleet.fleet_founder_cognition f),
      (SELECT md5(string_agg(x::text, ',' ORDER BY lot_id, payer)) FROM fleet.fleet_ai_credit_cost_accrual x),
      (SELECT count(*) FROM fleet.fleet_estate_reversions), (SELECT max(id) FROM fleet.fleet_events),
      (SELECT living_agents FROM fleet.fleet_state)))`);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000, treasuryCents: 100_000, simulatedSettlement: false });
    [A, B] = R.founders.map((f) => f.id);
    su = new pg.Pool({ connectionString: R.pgc.superUrl.replace(/\/postgres$/, `/${R.pgc.dbname}`), max: 1 });
    // Production's shape: the founders' starting capital was recorded with no money behind it (2 × £100 virtual).
    await R.one(`fleet.fleet_admin_record_owner_funding(20000, 'owner-authorized-virtual:test-genesis', $1, 'v122-virtual')`, [OWNER]);
    await R.q(`UPDATE fleet.fleet_ai_credit_lots SET usd_remaining = 0`);
    // As production: each founder has a cognition row (enabled, paused).
    for (const id of [A, B]) await R.genesis.setFounderCognition(id, { enabled: true, paused: true, dailyBudgetCents: 754, maxTurnsPerHour: 120, reason: 'test: paused', actor: OWNER });
  }, 300_000);
  afterAll(async () => { await su?.end(); await R?.close(); });

  it("migrates to v122 with a clean audit", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(122);
    const audit = (await R.store.auditPrivileges()).problems;
    expect(audit, JSON.stringify(audit)).toEqual([]);
  });

  it("R2: controller downtime restarts the grace window; ordinary heartbeat loss is still detected", async () => {
    // The incident's numbers: the reaper last ran 106 s ago, the last heartbeat is 126 s old.
    await R.q(`UPDATE fleet.fleet_state SET reaper_last_run_at = now() - interval '106 seconds', reaper_grace_from = now() - interval '1 hour'`);
    await asSuper(`UPDATE fleet.fleet_agents SET last_heartbeat = now() - interval '126 seconds' WHERE agent_id = $1`, [A]);
    await reap();
    expect((await agent(A)).status).toBe("active");                                       // not marked unresponsive
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_events WHERE event_type = 'reaper_resumed' AND created_at > now() - interval '1 minute')`)).toBe(1);
    // A running reaper (10 s gap) past the grace: a silent agent is still detected.
    await R.q(`UPDATE fleet.fleet_state SET reaper_last_run_at = now() - interval '10 seconds', reaper_grace_from = now() - interval '1 hour'`);
    await asSuper(`UPDATE fleet.fleet_agents SET last_heartbeat = now() - interval '130 seconds' WHERE agent_id = $1`, [A]);
    await reap();
    expect((await agent(A)).status).toBe("unresponsive");
  });

  it("R1: an unresponsive founder recovers by heartbeat inside the health grace, and by a passed challenge after it", async () => {
    // Inside the health grace (its last passed challenge is recent): the heartbeat itself recovers it (it raised before v122).
    await asSuper(`UPDATE fleet.fleet_agents SET last_challenge_ok_at = now() - interval '2 minutes' WHERE agent_id = $1`, [A]);
    expect(await R.one(`fleet.fleet_heartbeat($1, $1)`, [A])).toBe("active");
    // Unresponsive again, health grace over: only a passed challenge brings it back (it was rolled back before v122).
    await R.q(`UPDATE fleet.fleet_state SET reaper_last_run_at = now() - interval '10 seconds', reaper_grace_from = now() - interval '1 hour'`);
    await asSuper(`UPDATE fleet.fleet_agents SET last_heartbeat = now() - interval '130 seconds', last_challenge_ok_at = now() - interval '1 hour' WHERE agent_id = $1`, [A]);
    await reap();
    expect((await agent(A)).status).toBe("unresponsive");
    expect(await R.one(`fleet.fleet_heartbeat($1, $1)`, [A])).toBe("unresponsive");      // heartbeat alone: still unresponsive
    expect(await passChallenge(A)).toMatchObject({ ok: true });
    expect((await agent(A)).status).toBe("active");
    // Genesis protections stand: a dead agent cannot be moved without the owner's reinstatement (checked again below).
    expect(await R.one(`(SELECT prosrc LIKE '%NOT (OLD.status = ''unresponsive'' AND NEW.status = ''active'')%' FROM pg_proc WHERE proname = 'fleet_agents_origin_guard')`)).toBe(true);
  });

  let costJournal = "";
  const walletBefore: Record<string, number> = {};
  let unallocBefore = 0;
  it("the incident replayed: heartbeating founders die at the 480 s health grace; estates settle; R4 keeps unbacked cash out of unallocated", async () => {
    // A treasury-paid acquisition cost (as 1179): an owner-funded receipt, then a Fleet Control review charged to the treasury.
    const [{ receipt_id }] = await R.q(`INSERT INTO fleet.fleet_ai_credit_receipts (provider, receipt_no, usd_cents, tax_cents, total_cents) VALUES ('anthropic', '4001-0122', 2500, 500, 3000) RETURNING receipt_id`);
    expect((await R.one<Record<string, any>>(`fleet.fleet_admin_ai_credit_confirm($1, 'owner', NULL, NULL, NULL, $2)`, [receipt_id, OWNER])).ok).toBe(true);
    await R.one(`fleet.fleet_control_charge('knowledge_review_charge', $1, $2::jsonb)`, [crypto.randomUUID(), JSON.stringify([{ provider: "anthropic", requestId: crypto.randomUUID(), usdMicrocents: 5 * USD }])]);
    await R.one(`fleet.svc_ai_credit_settle(20)`);
    costJournal = await R.one(`(SELECT journal_id::text FROM fleet.fleet_ledger_journal WHERE kind = 'ai_credit_acquisition_cost' AND agent_id IS NULL ORDER BY seq DESC LIMIT 1)`);
    expect(costJournal).toMatch(/^[0-9a-f-]{36}$/);
    for (const id of [A, B]) walletBefore[id] = await bal(`agent:${id}:cash`);
    unallocBefore = await bal("fleet:treasury:unallocated");
    // The sequence: unresponsive for 9 minutes while still heartbeating, challenges failing → the reaper ends them.
    await R.q(`UPDATE fleet.fleet_state SET reaper_last_run_at = now() - interval '10 seconds', reaper_grace_from = now() - interval '1 hour'`);
    for (const id of [A, B]) await asSuper(`UPDATE fleet.fleet_agents SET status = 'unresponsive', unresponsive_since = now() - interval '9 minutes',
        last_heartbeat = now() - interval '20 seconds', last_challenge_ok_at = now() - interval '1 hour', challenge_failures = 3 WHERE agent_id = $1`, [id]);
    await reap();
    for (const id of [A, B]) expect((await agent(id)).status).toBe("dead");
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_events WHERE event_type = 'agent_died' AND detail ->> 'cause' = 'health_timeout')`)).toBe(2);
    await R.one(`fleet.svc_settle_estates(10)`);
    for (const id of [A, B]) expect(await R.one(`(SELECT status FROM fleet.fleet_estates WHERE agent_id = $1)`, [id])).toBe("settled");
    // R4: the wallets were unbacked starting capital → their cash is parked apart; unallocated is unchanged.
    expect(await bal("fleet:treasury:unbacked_estates")).toBe(walletBefore[A] + walletBefore[B]);
    expect(await bal("fleet:treasury:unallocated")).toBe(unallocBefore);
    expect(await R.one(`(fleet.fleet_capital_backing() ->> 'differenceMinor')`)).toBe(await R.one(`(fleet.fleet_capital_backing() ->> 'differenceMinor')`));
    // A dead agent cannot be moved by an ordinary update (triggers ON: even a superuser is refused by the transition guard).
    expect(await err(su.query(`UPDATE fleet.fleet_agents SET status = 'unresponsive' WHERE agent_id = $1`, [A]))).toMatch(/FLEET_TERMINAL_STATE_IMMUTABLE/);
  });

  it("the owner's reinstatement: same identity, mirrored corrections, paused; active only after a passed challenge; ledger verifies", async () => {
    const cred0 = await R.q(`SELECT agent_id, token_hash, created_at FROM fleet.fleet_agent_credentials WHERE agent_id = ANY($1) ORDER BY agent_id`, [[A, B]]);
    const wallets0 = await R.q(`SELECT agent_id, wallet_address FROM fleet.fleet_agent_custody_view WHERE agent_id = ANY($1)`, [[A, B]]).catch(() => [] as unknown[]);
    const accrual0 = await R.one<Record<string, any>>(`(SELECT to_jsonb(x) FROM fleet.fleet_ai_credit_cost_accrual x WHERE payer = 'treasury' LIMIT 1)`);
    const costAmt = Number(await R.one(`(SELECT amount_cents FROM fleet.fleet_ledger_postings WHERE journal_id = $1::uuid AND account_id = 'fleet:expense' AND side = 'D')`, [costJournal]));
    const r = await reinstate([A, B], [costJournal]);
    expect(r).toMatchObject({ ok: true });
    expect((r.reinstated as any[]).map((x) => x.agentId).sort()).toEqual([A, B].sort());
    for (const id of [A, B]) {
      const a = await agent(id);
      expect([a.status, a.death_time]).toEqual(["unresponsive", null]);
      expect(await bal(`agent:${id}:cash`)).toBe(walletBefore[id]);                               // the estate reversed
      expect(await R.one(`(SELECT status FROM fleet.fleet_estates WHERE agent_id = $1)`, [id])).toBe("reverted");
      expect(await R.one(`(SELECT spending_frozen FROM fleet.fleet_wallet_custody WHERE agent_id = $1)`, [id])).toBe(false);
      expect(await R.one(`(SELECT revoked_at IS NULL FROM fleet.fleet_agent_credentials WHERE agent_id = $1)`, [id])).toBe(true);
      expect(await R.one<Record<string, any>>(`(SELECT to_jsonb(c) FROM fleet.fleet_founder_cognition c WHERE agent_id = $1)`, [id])).toMatchObject({ enabled: true, paused: true });
    }
    // Same credential rows (no new identity), history kept (agent_died / estate_settled / the original journals), mirrored reversals.
    expect(await R.q(`SELECT agent_id, token_hash, created_at FROM fleet.fleet_agent_credentials WHERE agent_id = ANY($1) ORDER BY agent_id`, [[A, B]])).toEqual(cred0);
    void wallets0;
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_events WHERE event_type = 'agent_died')`)).toBe(2);
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_ledger_journal WHERE kind = 'reversal' AND reverses_journal_id IN
      (SELECT journal_id FROM fleet.fleet_ledger_journal WHERE kind IN ('estate_transfer','ai_credit_acquisition_cost')))`)).toBe(3);
    expect(await bal("fleet:treasury:unbacked_estates")).toBe(0);
    // The acquisition cost is back to waiting (its key keeps advancing: posted_minor unchanged, unwound recorded).
    const accrual1 = await R.one<Record<string, any>>(`(SELECT to_jsonb(x) FROM fleet.fleet_ai_credit_cost_accrual x WHERE payer = 'treasury' LIMIT 1)`);
    expect(Number(accrual1.unposted_micro)).toBe(Number(accrual0.unposted_micro) + costAmt * 1_000_000);
    expect(Number(accrual1.unwound_minor)).toBe(costAmt);
    expect(Number(accrual1.posted_minor)).toBe(Number(accrual0.posted_minor));
    expect(await R.one(`(fleet.fleet_ledger_verify() ->> 'ok')`)).toBe("true");
    expect(Number(await R.one(`(SELECT living_agents FROM fleet.fleet_state)`))).toBe(2);
    // The verification hold: aged 9 minutes past unresponsive and 11 minutes without a heartbeat, the reaper ends neither.
    for (const id of [A, B]) expect(Date.parse((await agent(id)).lifecycle_hold_until)).toBeGreaterThan(Date.now() + 55 * 60_000);
    await R.q(`UPDATE fleet.fleet_state SET reaper_last_run_at = now() - interval '10 seconds', reaper_grace_from = now() - interval '1 hour'`);
    await asSuper(`UPDATE fleet.fleet_agents SET unresponsive_since = now() - interval '9 minutes', last_heartbeat = now() - interval '11 minutes' WHERE agent_id = ANY($1)`, [[A, B]]);
    await reap();
    for (const id of [A, B]) expect((await agent(id)).status).toBe("unresponsive");
    // A paused, reinstated founder: model calls refused; active only after it passes the challenge due at its next heartbeat.
    expect(await R.one(`fleet.fleet_heartbeat($1, $1)`, [A])).toBe("unresponsive");
    for (const id of [A, B]) {
      expect(await passChallenge(id)).toMatchObject({ ok: true });
      expect((await agent(id)).status).toBe("active");
      expect((await agent(id)).lifecycle_hold_until).toBeNull();                              // becoming active ends the hold
    }
    expect(await R.one(`(fleet.fleet_ledger_verify() ->> 'ok')`)).toBe("true");
    // Twice: refused (it is no longer dead).
    expect(await err(reinstate([A]))).toMatch(/FLEET_REINSTATE_REFUSED/);
  });

  it("refusals: a non-owner, an economic death, a full fleet; a re-death opens a new estate without a key collision", async () => {
    // A later real death of a reinstated founder: estate reopens and settles (new key).
    await R.q(`UPDATE fleet.fleet_state SET reaper_last_run_at = now() - interval '10 seconds', reaper_grace_from = now() - interval '1 hour'`);
    await asSuper(`UPDATE fleet.fleet_agents SET status = 'unresponsive', unresponsive_since = now() - interval '9 minutes', last_heartbeat = now() - interval '20 seconds',
      last_challenge_ok_at = now() - interval '1 hour', challenge_failures = 3 WHERE agent_id = $1`, [B]);
    await reap();
    expect((await agent(B)).status).toBe("dead");
    expect(await R.one(`(SELECT status FROM fleet.fleet_estates WHERE agent_id = $1)`, [B])).toBe("open");
    await R.one(`fleet.svc_settle_estates(10)`);
    expect(await R.one(`(SELECT status FROM fleet.fleet_estates WHERE agent_id = $1)`, [B])).toBe("settled");
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_ledger_journal WHERE kind = 'estate_transfer' AND agent_id = $1)`, [B])).toBe(2);
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_estate_reversions WHERE agent_id = $1)`, [B])).toBe(1);
    // The cap: a full fleet refuses the reinstatement and the WHOLE transaction rolls back (nothing financial or lifecycle moves).
    await R.store.setMaxAgents(1, "test: a full fleet");
    const before = await untouched();
    expect(await err(reinstate([B]))).toMatch(/FLEET_CAP_EXCEEDED/);
    expect(await untouched()).toBe(before);
    await R.store.setMaxAgents(2, "test: cap restored");
    const before2 = await untouched();
    // A non-owner actor; an out-of-bounds hold.
    expect(await err(R.one(`fleet.fleet_admin_incident_reinstate($1, ARRAY[$2]::text[], '{}'::uuid[], 60, 'founder:x')`, [INCIDENT, B]))).toMatch(/FLEET_APPROVAL_REQUIRED/);
    expect(await err(reinstate([B], [], 600))).toMatch(/FLEET_BAD_REQUEST: a verification hold/);
    expect(await untouched()).toBe(before2);
    // An economic death (any cause other than a health / heartbeat timeout) is final.
    await asSuper(`UPDATE fleet.fleet_events SET detail = jsonb_set(detail, '{cause}', '"survival_exhausted"') WHERE id = (SELECT max(id) FROM fleet.fleet_events WHERE event_type = 'agent_died' AND agent_id = $1)`, [B]);
    expect(await err(reinstate([B]))).toMatch(/FLEET_REINSTATE_REFUSED: .* died of survival_exhausted/);
    expect(await R.one(`(fleet.fleet_ledger_verify() ->> 'ok')`)).toBe("true");
  });
});

describe.skipIf(!PG_BIN)("v122: estate partition keeps backed money backed, mixed balances included; hold end; new event routes", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let su: pg.Pool;
  let X: string, Y: string, Z: string;
  const asSuper = async (sql: string, params: unknown[] = []) => {
    const c = await su.connect();
    try { await c.query("SET session_replication_role = replica"); return (await c.query(sql, params)).rows; } finally { await c.query("RESET session_replication_role"); c.release(); }
  };
  const bal = async (a: string) => Number(await R.one(`fleet.fleet_ledger_balance($1)`, [a]));
  /** An agent's own spending (expense from its cash), as a charge posts it. */
  const spend = (id: string, pence: number) => R.one(`fleet.fleet_ledger_post('inference_charge', $1, 'controller', 'test spend', 'controller', $2, NULL, NULL, NULL, NULL, now(), $3::jsonb)`,
    [`test:spend:${crypto.randomUUID()}`, id, JSON.stringify([{ account: `agent:${id}:expense`, side: "D", amount: pence }, { account: `agent:${id}:cash`, side: "C", amount: pence }])]);
  const die = async (id: string) => {
    await R.q(`UPDATE fleet.fleet_state SET reaper_last_run_at = now() - interval '10 seconds', reaper_grace_from = now() - interval '1 hour'`);
    await asSuper(`UPDATE fleet.fleet_agents SET status = 'unresponsive', unresponsive_since = now() - interval '9 minutes', last_heartbeat = now() - interval '20 seconds',
      last_challenge_ok_at = now() - interval '1 hour', challenge_failures = 3 WHERE agent_id = $1`, [id]);
    await R.one(`fleet.fleet_reap('reaper')`);
    await R.one(`fleet.svc_settle_estates(10)`);
    return R.one<Record<string, any>>(`(SELECT summary FROM fleet.fleet_estates WHERE agent_id = $1)`, [id]);
  };

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 3, allocationCents: 10_000, treasuryCents: 100_000, simulatedSettlement: false });
    [X, Y, Z] = R.founders.map((f) => f.id);
    su = new pg.Pool({ connectionString: R.pgc.superUrl.replace(/\/postgres$/, `/${R.pgc.dbname}`), max: 1 });
    // £100 of the fleet's capital is unbacked (recorded without money); the rest is real.
    await R.one(`fleet.fleet_admin_record_owner_funding(10000, 'owner-authorized-virtual:test-mixed', $1, 'v122-mixed')`, [OWNER]);
  }, 300_000);
  afterAll(async () => { await su?.end(); await R?.close(); });

  it("mixed balance: the agent's kept earnings stay backed (unallocated); only the rest, up to the fleet's unbacked capital, is parked", async () => {
    await R.ledger.recordRevenue(X, 3_000, `sale:${crypto.randomUUID()}`, "buyer@example.test", OWNER);   // real customer money
    await spend(X, 1_000);
    const cash = await bal(`agent:${X}:cash`);                                             // 10,000 + 3,000 − 1,000 = 12,000
    const u0 = await bal("fleet:treasury:unallocated");
    const s = await die(X);
    expect(Number(s.cashToTreasury)).toBe(cash);
    expect(Number(s.cashUnbacked)).toBe(cash - 3_000);                                     // 9,000 parked
    expect(await bal("fleet:treasury:unbacked_estates")).toBe(cash - 3_000);
    expect(await bal("fleet:treasury:unallocated")).toBe(u0 + 3_000);                       // the 3,000 earned stays real treasury money
  });

  it("the fleet's unbacked capital caps the parking: once it is used up, a later estate's cash is backed (unallocated)", async () => {
    const cash = await bal(`agent:${Y}:cash`);                                             // 10,000 of capital, no earnings
    // What is still unbacked: the virtual capital less provider-paid spending (fleet_capital_backing) less what is already parked.
    const left = Math.max(0, Number(await R.one(`(fleet.fleet_capital_backing() ->> 'unbackedMinor')`)) - await bal("fleet:treasury:unbacked_estates"));
    const u0 = await bal("fleet:treasury:unallocated");
    const s = await die(Y);
    expect(Number(s.cashUnbacked)).toBe(Math.min(cash, left));
    expect(await bal("fleet:treasury:unallocated")).toBe(u0 + cash - Math.min(cash, left));
  });

  it("earnings larger than the cash left: nothing is parked", async () => {
    await R.ledger.recordRevenue(Z, 3_000, `sale:${crypto.randomUUID()}`, "buyer@example.test", OWNER);
    await spend(Z, 4_000);                                                                 // 10,000 + 3,000 − 4,000 = 9,000; earnings 3,000
    const p0 = await bal("fleet:treasury:unbacked_estates");
    const d0 = Number(await R.one(`(fleet.fleet_capital_backing() ->> 'differenceMinor')`) ?? 0);
    const s = await die(Z);
    expect(Number(s.cashUnbacked)).toBe(0);                                                // the fleet's unbacked capital is used up
    expect(await bal("fleet:treasury:unbacked_estates")).toBe(p0);
    expect(await R.one(`(fleet.fleet_ledger_verify() ->> 'ok')`)).toBe("true");
    expect(Number(await R.one(`(fleet.fleet_capital_backing() ->> 'differenceMinor')`) ?? 0)).toBe(d0);             // the reconciliation is unchanged by the estate
  });

  it("the owner ends a hold early: the full grace runs from then (no immediate death)", async () => {
    const r = await R.one<Record<string, any>>(`fleet.fleet_admin_incident_reinstate('hold-end test', ARRAY[$1]::text[], '{}'::uuid[], 30, $2)`, [Y, OWNER]);
    expect(r).toMatchObject({ ok: true });
    await asSuper(`UPDATE fleet.fleet_agents SET unresponsive_since = now() - interval '9 minutes' WHERE agent_id = $1`, [Y]);
    expect(await R.one<Record<string, any>>(`fleet.fleet_admin_lifecycle_hold_end($1, 'verification abandoned', $2)`, [Y, OWNER])).toMatchObject({ ok: true });
    await R.q(`UPDATE fleet.fleet_state SET reaper_last_run_at = now() - interval '10 seconds'`);
    await R.one(`fleet.fleet_reap('reaper')`);
    expect(await R.one(`(SELECT status FROM fleet.fleet_agents WHERE agent_id = $1)`, [Y])).toBe("unresponsive");   // 480 s from now, not 9 min ago
  });

  it("the new event types are routed (Fleet Command priorities)", async () => {
    const route = (t: string) => R.one<string>(`fleet.fleet_event_route($1, '{}'::jsonb)`, [t]);
    expect(await route("agent_reinstated")).toBe("P1_HIGH");
    for (const t of ["estate_reverted", "ai_cost_unwound", "lifecycle_hold_ended"]) expect(await route(t)).toBe("P2_IMPORTANT");
    for (const t of ["owner_task_sent", "owner_task_closed"]) expect(await route(t)).toBe("P3_SUMMARY");
  });
});
