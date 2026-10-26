/**
 * v120 — owner tasks (PostgreSQL; the real admin functions, attention and routed authorisation; no provider).
 *  - owner only: a non-owner actor and the agents' service role are refused;
 *  - a task is data: it leaves cognition settings, outward permissions, owner messages and conversation turns untouched — a
 *    paused agent stays paused (its model calls are still refused);
 *  - it is in the agent's attention (ownerTasks, oldest first) until the owner closes it, and its digest changes on a new
 *    or closed task; another agent's attention is unchanged;
 *  - the agent's work on it is its own: a model call reserves against the agent (payer agent), never the treasury;
 *  - bounded: at most 3 open, sizes, secrets, a dead agent; a task's words never change; closing is once.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { PgFleetStore } from "../../fleet/postgres/store.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";

const PG_BIN = findPgBin();
const route = { tier: "T2", provider: "anthropic", model: "claude-sonnet-5-5", taskClass: "founder_work", source: "class_minimum", scope: "task_step" };
const EMPTY_MD5 = "d41d8cd98f00b204e9800998ecf8427e";

describe.skipIf(!PG_BIN)("v120: owner tasks (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let svc: PgFleetStore;
  let svcPool: pg.Pool, su: pg.Pool;
  let A: string, B: string;
  const attention = async (a: string) => R.one<Record<string, any>>(`fleet.fleet_agent_attention($1)`, [a]);
  const send = (a: string, title: string, body: string, actor = OWNER) => R.one<Record<string, any>>(`fleet.fleet_admin_owner_task_send($1, $2, $3, $4)`, [a, title, body, actor]);
  const close = (t: string, reason = "done", actor = OWNER) => R.one<Record<string, any>>(`fleet.fleet_admin_owner_task_close($1::uuid, $2, $3)`, [t, reason, actor]);
  const err = (p: Promise<unknown>) => p.then(() => "no error", (e: Error) => e.message);
  /** Everything a task must leave alone, as one comparable snapshot. */
  const untouched = async (a: string) => R.one<string>(`(SELECT concat_ws('|',
      (SELECT md5(COALESCE(string_agg(c::text, ','), '')) FROM fleet.fleet_founder_cognition c WHERE c.agent_id = $1),
      (SELECT md5(COALESCE(string_agg(o::text, ',' ORDER BY o::text), '')) FROM fleet.fleet_outward_release o),
      (SELECT count(*) FROM fleet.fleet_agent_messages WHERE agent_id = $1),
      (SELECT count(*) FROM fleet.fleet_conversation_turns WHERE agent_id = $1),
      (SELECT count(*) FROM fleet.fleet_cognition_inflight WHERE agent_id = $1),
      (SELECT md5(COALESCE(string_agg(j::text, ','), '')) FROM fleet.fleet_ledger_journal j)))`, [a]);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 1_000, treasuryCents: 100_000 });
    [A, B] = R.founders.map((f) => f.id);
    await R.store.grantServiceRole();
    svc = new PgFleetStore({ connectionString: R.pgc.serviceUrl });
    svcPool = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 1 });
    su = new pg.Pool({ connectionString: R.pgc.superUrl.replace(/\/postgres$/, `/${R.pgc.dbname}`), max: 1 });
    await R.genesis.setCognitionPolicy({ enabled: true, provider: "anthropic", model: "claude-opus-5-5", maxOutputTokens: 4_000, actor: OWNER,
      inputMicrocents: 400, outputMicrocents: 2_000, cacheWriteMicrocents: 500, cacheReadMicrocents: 20 });
    for (const a of [A, B]) await R.genesis.setFounderCognition(a, { enabled: true, paused: true, maxTurnsPerHour: 120, dailyBudgetCents: 754, reason: "t: paused", actor: OWNER });
    await R.genesis.cognitionTierVerify("T2", "claude-sonnet-5-5", "test: models api 200", OWNER);
    await R.genesis.cognitionTierEnable("T2", true, OWNER);
    await R.genesis.cognitionRoutingSet(true, 2_000, OWNER);
    for (const a of [A, B]) await R.genesis.founderRoutingSet(a, true, OWNER);
  }, 300_000);
  afterAll(async () => { await svc?.close(); await svcPool?.end(); await su?.end(); await R?.close(); });

  it("migrates to v120 with a clean audit", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(120);
    const audit = (await R.store.auditPrivileges()).problems;
    expect(audit, JSON.stringify(audit)).toEqual([]);
  });

  it("owner only: a non-owner actor and the agents' service role are refused", async () => {
    expect(await err(send(A, "Replace files", "Adopt the corrected workbook.", "founder:x"))).toMatch(/FLEET_APPROVAL_REQUIRED/);
    expect(await err(svcPool.query(`SELECT fleet.fleet_admin_owner_task_send($1, 'x title', 'a task body here', $2)`, [A, OWNER]))).toMatch(/permission denied/);
    expect(await err(svcPool.query(`SELECT * FROM fleet.fleet_owner_tasks`))).toMatch(/permission denied/);
  });

  it("a task changes nothing else: the paused agent stays paused, no conversation turn, no permission; only its own attention shows it", async () => {
    const [a0, b0] = [await untouched(A), await untouched(B)];
    const bAtt0 = await attention(B);
    expect((await attention(A)).ownerTasks).toEqual([]);
    const t = await send(A, "Replace your tracker's files", "The corrected workbook is in from-owner/tracker-v6/. Remove tracker.zip, attach it, inspect, review exactly the two files.");
    expect(t).toMatchObject({ ok: true, agentId: A });
    expect(await untouched(A)).toBe(a0);                                                  // cognition row, outward, messages, turns, inflight, ledger
    expect(await untouched(B)).toBe(b0);
    expect(await svc.cognitionRoutedAuthorize(A, 5, route, "c".repeat(64))).toMatchObject({ ok: false, code: "FLEET_COGNITION_PAUSED" });
    const att = await attention(A);
    expect(att.ownerTasks).toEqual([expect.objectContaining({ id: t.taskId, title: "Replace your tracker's files" })]);
    expect(att.ownerTasksDigest).not.toBe(EMPTY_MD5);
    expect(att.ownerPending).toBe(0);                                                     // not an owner message
    expect(att.notices).toEqual([]);                                                     // not a Fleet Control notice
    const bAtt = await attention(B);
    expect([bAtt.ownerTasks, bAtt.ownerTasksDigest, bAtt.eventsDigest]).toEqual([[], EMPTY_MD5, bAtt0.eventsDigest]);
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_events WHERE event_type = 'owner_task_sent' AND agent_id = $1)`, [A])).toBe(1);
  });

  it("the agent's work on it is its own: once resumed, a model call reserves against the agent, never the treasury", async () => {
    await R.genesis.setFounderCognition(A, { paused: false, reason: "t: resume", actor: OWNER });
    const x = await svc.cognitionRoutedAuthorize(A, 5, route, "c".repeat(64));
    expect(x.ok, JSON.stringify(x)).toBe(true);
    expect(await R.one(`(SELECT payer FROM fleet.fleet_cognition_inflight WHERE request_id = $1)`, [x.requestId])).not.toBe("treasury");
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_conversation_turns WHERE agent_id = $1)`, [A])).toBe(0);
    await R.genesis.setFounderCognition(A, { paused: true, reason: "t: pause again", actor: OWNER });
  });

  it("durable until closed: oldest first, digest moves on each change, closing is once, the words never change", async () => {
    const first = (await attention(A)).ownerTasks[0].id as string;
    const d1 = (await attention(A)).ownerTasksDigest;
    const t2 = await send(A, "Second task", "Record what you changed in your field journal.");
    const att2 = await attention(A);
    expect(att2.ownerTasks.map((t: any) => t.id)).toEqual([first, t2.taskId]);
    expect(att2.ownerTasksDigest).not.toBe(d1);
    expect(await err(su.query(`UPDATE fleet.fleet_owner_tasks SET body = 'changed words here' WHERE task_id = $1`, [first]))).toMatch(/FLEET_HISTORY_IMMUTABLE/);
    expect(await err(su.query(`DELETE FROM fleet.fleet_owner_tasks WHERE task_id = $1`, [first]))).toMatch(/FLEET_HISTORY_IMMUTABLE/);
    expect(await close(first, "review recorded")).toMatchObject({ ok: true });
    expect(await close(first, "again")).toMatchObject({ ok: true, replay: true });
    const att3 = await attention(A);
    expect(att3.ownerTasks.map((t: any) => t.id)).toEqual([t2.taskId]);
    expect(att3.ownerTasksDigest).not.toBe(att2.ownerTasksDigest);
    await close(t2.taskId);
    expect((await attention(A)).ownerTasksDigest).toBe(EMPTY_MD5);
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_events WHERE event_type = 'owner_task_closed' AND agent_id = $1)`, [A])).toBe(2);
  });

  it("bounded: three open at most, sizes, hidden characters and secrets refused", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await send(B, `Task ${i}`, `Do the bounded thing number ${i}.`)).taskId);
    expect(await err(send(B, "Task 3", "One more than allowed."))).toMatch(/FLEET_OWNER_TASKS_FULL/);
    for (const id of ids) await close(id);
    expect(await err(send(B, "x", "Too short a title."))).toMatch(/FLEET_BAD_REQUEST/);
    expect(await err(send(B, "Fine title", "x".repeat(1_501)))).toMatch(/FLEET_BAD_REQUEST/);
    expect(await err(send(B, "Fine title", "Hidden \u0007 character inside."))).toMatch(/control characters/);
    expect(await err(send(B, "Fine title", "Use key sk-ant-api03-" + "A".repeat(40) + " for this."))).toMatch(/FLEET_SECRET_DETECTED/);
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_owner_tasks WHERE agent_id = $1 AND closed_at IS NULL)`, [B])).toBe(0);
  });
});
