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
    await R.q(`UPDATE fleet.fleet_agents SET challenge_requested_at = now() WHERE agent_id = $1`, [id]);
    const c = await R.store.issueChallenge(id);
    expect(c, "a challenge is issued").not.toBeNull();
    const rt = await R.one<Record<string, any>>(`fleet.fleet_founder_runtime_current($1)`, [id]);
    const a = await agent(id);
    return R.store.answerChallenge(id, { challengeId: c!.challengeId, nonce: c!.nonce, commit: a.runtime_commit ?? null, buildId: rt?.buildId ?? null, policyOk: true });
  };
  const reinstate = (agents: string[], unwind: string[] = []) =>
    R.one<Record<string, any>>(`fleet.fleet_admin_incident_reinstate($1, $2::text[], $3::uuid[], $4)`, [INCIDENT, agents, unwind, OWNER]);

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
    // A paused, reinstated founder: model calls refused; active only after it passes the challenge due at its next heartbeat.
    expect(await R.one(`fleet.fleet_heartbeat($1, $1)`, [A])).toBe("unresponsive");
    for (const id of [A, B]) {
      expect(await passChallenge(id)).toMatchObject({ ok: true });
      expect((await agent(id)).status).toBe("active");
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
    // A non-owner actor.
    expect(await err(R.one(`fleet.fleet_admin_incident_reinstate($1, ARRAY[$2]::text[], '{}'::uuid[], 'founder:x')`, [INCIDENT, B]))).toMatch(/FLEET_APPROVAL_REQUIRED/);
    // An economic death (any cause other than a health / heartbeat timeout) is final.
    await asSuper(`UPDATE fleet.fleet_events SET detail = jsonb_set(detail, '{cause}', '"survival_exhausted"') WHERE id = (SELECT max(id) FROM fleet.fleet_events WHERE event_type = 'agent_died' AND agent_id = $1)`, [B]);
    expect(await err(reinstate([B]))).toMatch(/FLEET_REINSTATE_REFUSED: .* died of survival_exhausted/);
    expect(await R.one(`(fleet.fleet_ledger_verify() ->> 'ok')`)).toBe("true");
  });
});
