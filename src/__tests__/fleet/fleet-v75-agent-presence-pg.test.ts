/**
 * Schema v75 — the Virtual Command Centre's live presence (PostgreSQL, through the dashboard gateway's `agents` read).
 *
 * Proven here: the owner's pause and when it began (an operator pause only; re-applying it keeps the start; a resume
 * clears it); the agent's own last rest report — hibernating (its turn ended with a wake condition or review time) or
 * awake, with the report time and the start of the current hibernation — and nothing when it never reported (no
 * inference from the pause or from inactivity; the agent's own wording is not exposed); the death time; the active
 * mission's start; the operator hold's start. The read is read-only: nothing is written by it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";

const PG_BIN = findPgBin();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

describe.skipIf(!PG_BIN)("v75: the agents read carries the live presence (PostgreSQL)", { timeout: 240_000 }, () => {
  let R: EconomyRegistry;
  let su: pg.Pool;
  let A = "", B = "";
  const session = crypto.randomBytes(16).toString("hex");
  const asSuper = async (sql: string, params: unknown[] = []) => {
    const c = await su.connect();
    try { await c.query("SET session_replication_role = replica"); return (await c.query(sql, params)).rows; } finally { await c.query("RESET session_replication_role"); c.release(); }
  };
  const agents = async () => Object.fromEntries(((await R.one<Record<string, any>>(`fleet.dash_call($1, NULL, 'agents', '{}', NULL, 'test')`, [sha(session)])).result as Array<Record<string, any>>)
    .map((a) => [a.agentId, a]));
  const pause = (id: string, paused: boolean) => R.one(`fleet.fleet_founder_cognition_set($1, NULL, $2, NULL, NULL, 'owner', $3)`, [id, paused, OWNER]);
  const report = (id: string, at: string, o: { wakeOn?: string; reviewAt?: string } = {}) => asSuper(
    `INSERT INTO fleet.fleet_agent_mind_reports (agent_id, packet, outcome, wake_on, review_at, at) VALUES ($1, 'full', 'did things', $2, $3, $4)`,
    [id, o.wakeOn ?? null, o.reviewAt ?? null, at]);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000, treasuryCents: 100_000 });
    [A, B] = R.founders.map((f) => f.id);
    su = new pg.Pool({ connectionString: R.pgc.superUrl.replace(/\/postgres$/, `/${R.pgc.dbname}`), max: 1 });
    await R.q(`INSERT INTO fleet.fleet_admin_passkeys (credential_id, public_key, name) VALUES ('presence_test_credential', decode(repeat('00', 40), 'hex'), 'test')`);
    await R.q(`INSERT INTO fleet.fleet_admin_sessions (session_sha, csrf_sha, credential_id, method, totp_ok, expires_at) VALUES ($1, $2, 'presence_test_credential', 'passkey', true, now() + interval '1 hour')`,
      [sha(session), sha("csrf")]);
  }, 300_000);
  afterAll(async () => { await su?.end(); await R?.close(); });

  it("migrates to v75 with a clean audit; with nothing recorded, no presence field is invented", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(75);
    const audit = (await R.store.auditPrivileges()).problems;
    expect(audit, JSON.stringify(audit)).toEqual([]);
    const a = (await agents())[A];
    expect(a).toMatchObject({ agentId: A, status: expect.any(String), mode: "NORMAL" });
    for (const k of ["pausedSince", "hibernation", "deathTime", "modeSince", "heldSince"]) expect(a, k).not.toHaveProperty(k);
    expect(a.paused === undefined || a.paused === false).toBe(true);
  });

  it("the owner's pause and when it began; re-applying keeps the start; a resume clears it; never a hibernation", async () => {
    await pause(A, true);
    const first = (await agents())[A];
    expect(first.paused).toBe(true);
    const start = await R.one<Date>(`(SELECT min(created_at) FROM fleet.fleet_events WHERE agent_id = $1 AND event_type = 'founder_cognition_paused')`, [A]);
    expect(Date.parse(first.pausedSince)).toBe(new Date(start).getTime());
    await pause(A, true);                                        // re-applied: still the original start
    expect(Date.parse((await agents())[A].pausedSince)).toBe(new Date(start).getTime());
    expect((await agents())[A]).not.toHaveProperty("hibernation"); // a pause is not a hibernation
    await pause(A, false);
    const resumed = (await agents())[A];
    expect(resumed.paused).toBe(false); expect(resumed).not.toHaveProperty("pausedSince");
    await pause(A, true);                                        // a new pause starts anew
    expect(Date.parse((await agents())[A].pausedSince)).toBeGreaterThan(new Date(start).getTime());
  });

  it("the agent's own rest report: state, report time, and the current hibernation's start — no wording exposed", async () => {
    await report(B, "2026-10-01T10:00:00Z");                                         // awake
    const awake = (await agents())[B].hibernation;
    expect(Object.keys(awake).sort()).toEqual(["reportedAt", "state"]);
    expect(awake.state).toBe("awake"); expect(Date.parse(awake.reportedAt)).toBe(Date.parse("2026-10-01T10:00:00Z"));
    await report(B, "2026-10-01T12:00:00Z", { wakeOn: "a supplier replies (secret plans)" });  // hibernation begins
    await report(B, "2026-10-02T12:00:00Z", { reviewAt: "2026-10-09T00:00:00Z" });     // daily re-check, still hibernating
    const h = (await agents())[B].hibernation;
    expect(h.state).toBe("hibernating");
    expect(Date.parse(h.reportedAt)).toBe(Date.parse("2026-10-02T12:00:00Z"));
    expect(Date.parse(h.since)).toBe(Date.parse("2026-10-01T12:00:00Z"));
    expect(JSON.stringify(await agents())).not.toContain("secret plans");
    await report(B, "2026-10-03T08:00:00Z");                                          // woke
    const woke = (await agents())[B].hibernation;
    expect(woke.state).toBe("awake"); expect(woke).not.toHaveProperty("since"); expect(Date.parse(woke.reportedAt)).toBe(Date.parse("2026-10-03T08:00:00Z"));
  });

  it("the operator hold's start", async () => {
    await asSuper(`UPDATE fleet.fleet_agents SET operator_hold_at = '2026-10-04T08:00:00Z', operator_hold_by = 'operator:owner' WHERE agent_id = $1`, [A]);
    const a = (await agents())[A];
    expect(a.held).toBe(true); expect(Date.parse(a.heldSince)).toBe(Date.parse("2026-10-04T08:00:00Z"));
    await asSuper(`UPDATE fleet.fleet_agents SET operator_hold_at = NULL, operator_hold_by = NULL WHERE agent_id = $1`, [A]);
    expect((await agents())[A]).not.toHaveProperty("heldSince");
  });

  it("the active mission's start and the death time", async () => {
    await asSuper(`INSERT INTO fleet.fleet_agent_missions (mission_id, agent_id, kind, brief, beneficiaries, assigned_by, started_at, target_end_at, hard_end_at)
      VALUES ($1, $2, 'marketing', 'test mission brief', '["fleet"]', 'operator:owner', '2026-10-05T09:00:00Z', '2026-10-20T00:00:00Z', '2026-10-30T00:00:00Z')`, [crypto.randomUUID(), B]);
    const b = (await agents())[B];
    expect(b.mode).toBe("MARKETING"); expect(Date.parse(b.modeSince)).toBe(Date.parse("2026-10-05T09:00:00Z"));
    await asSuper(`UPDATE fleet.fleet_agents SET status = 'dead', death_time = '2026-10-06T00:00:00Z' WHERE agent_id = $1`, [B]);
    expect(Date.parse((await agents())[B].deathTime)).toBe(Date.parse("2026-10-06T00:00:00Z"));
  });
});
