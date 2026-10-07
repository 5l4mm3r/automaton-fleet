/**
 * Schema v45 — Fleet history vs software plumbing (owner brief "final V2.4.4"). Targeted tests:
 *   - the one-time purge removes exactly the routine event copies (session_opened, ledger_journal_posted, role grants,
 *     notifications_deleted); the canonical history, ledger journals, balances, Treasury, Agents, ventures, knowledge,
 *     cap and the owner's sign-in state are unchanged (the production reconciliation scripts prove it, with exact counts);
 *   - the history stays append-only for everything canonical (UPDATE / DELETE refused, also for copies outside the pass);
 *   - retention expires copies after 7 days and routine auth diagnostics after 30, never serious incidents, writes no event
 *     and adds nothing to Fleet Command;
 *   - the dashboard's history (`events` without a type) is meaningful Fleet history only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";
import { PURGE_COPIES_SQL, EVENT_DIAGNOSTIC_TYPES, EVENT_COPY_TYPES, NOTIFICATION_ROUTES } from "../../fleet/postgres/migrations-phase45.js";

const PG_BIN = findPgBin();
const ROOT = path.resolve(__dirname, "../../..");
const ALL = "9223372036854775807";
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const V = FLEET_PG_SCHEMA_VERSION;

describe.skipIf(!PG_BIN)("Fleet history, purge and retention (PostgreSQL)", { timeout: 240_000 }, () => {
  let R: EconomyRegistry;
  let dir = "";
  const session = crypto.randomBytes(16).toString("hex");
  const count = async (where = "true") => Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE ${where})`));
  const dash = async (op: string, args: object = {}) => {
    const r = await R.one<Record<string, any>>(`fleet.dash_call($1, NULL, $2, $3, NULL, 'test')`, [sha(session), op, JSON.stringify(args)]);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return r.result;
  };
  const snap = (name: string, cut?: Record<string, number>) => {
    const v = (k: string) => ["-v", `${k}=${cut?.[k] ?? ALL}`];
    const out = execFileSync(path.join(PG_BIN!, "psql"), ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", ...v("cut_event"), ...v("cut_seq"), ...v("cut_posting"),
      "-d", R.pgc.ownerUrl, "-f", path.join(ROOT, "scripts/fleet-reconcile-snapshot.sql")], { encoding: "utf8" });
    const f = path.join(dir, `${name}.json`);
    fs.writeFileSync(f, out.trim());
    return { file: f, json: JSON.parse(out.trim()) };
  };
  const compare = (a: string, b: string) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/fleet-reconcile-compare.mjs"), a, b, String(V), String(V)], { encoding: "utf8" });
    return { code: r.status, report: JSON.parse(r.stdout) };
  };
  const cuts = (s: Record<string, any>) => ({ cut_event: s.events.maxId, cut_seq: s.ledger.maxSeq, cut_posting: s.ledger.maxPosting });
  /** A row as it would have been written `days` ago (owner connection; the insert path is the normal one). */
  const old = (type: string, days: number, detail: object = {}) =>
    R.q(`INSERT INTO fleet.fleet_events (event_type, agent_id, actor, detail, created_at) VALUES ($1, NULL, 'test', $2::jsonb, now() - make_interval(days => $3))`,
      [type, JSON.stringify(detail), days]);
  const ev = (type: string, detail: object = {}) => R.q(`SELECT fleet.fleet_event($1, NULL, 'test', $2::jsonb)`, [type, JSON.stringify(detail)]);

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-history-"));
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 50_000, treasuryCents: 1_000_000 });
    const [A] = R.founders;
    expect((await R.econ(A, "venture.create", { key: "shop", model: "software", offer: "a tool", state: "selected", channels: ["direct"] })).ok).toBe(true);
    await R.q(`INSERT INTO fleet.fleet_admin_passkeys (credential_id, public_key, name) VALUES ('history_test_credential', decode(repeat('00', 40), 'hex'), 'test')`);
    await R.q(`INSERT INTO fleet.fleet_admin_sessions (session_sha, csrf_sha, credential_id, method, totp_ok, expires_at) VALUES ($1, $2, 'history_test_credential', 'passkey', true, now() + interval '1 hour')`,
      [sha(session), sha("csrf")]);
  }, 300_000);
  afterAll(async () => { await R?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("the history stays append-only: UPDATE and DELETE of canonical events are refused, and so is deleting a copy outside the retention pass", async () => {
    await ev("treasury_sweep", { amountMinor: 1 });
    await ev("session_opened");
    expect(await R.code(R.q(`UPDATE fleet.fleet_events SET actor = 'x' WHERE event_type = 'treasury_sweep'`))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await R.code(R.q(`DELETE FROM fleet.fleet_events WHERE event_type = 'treasury_sweep'`))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await R.code(R.q(`DELETE FROM fleet.fleet_events WHERE event_type = 'session_opened'`))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await R.code(R.q(`TRUNCATE fleet.fleet_events`))).toBe("FLEET_HISTORY_IMMUTABLE");
    // Even inside the pass ('expire'), a canonical row or a fresh copy cannot go.
    const c = await R.owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('fleet.event_retention', 'expire', true)");
      await expect(c.query(`DELETE FROM fleet.fleet_events WHERE event_type = 'treasury_sweep'`)).rejects.toThrow(/FLEET_HISTORY_IMMUTABLE/);
      await c.query("ROLLBACK"); await c.query("BEGIN");
      await c.query("SELECT set_config('fleet.event_retention', 'purge', true)");
      await expect(c.query(`DELETE FROM fleet.fleet_events WHERE event_type = 'treasury_sweep'`)).rejects.toThrow(/FLEET_HISTORY_IMMUTABLE/);
      await c.query("ROLLBACK");
    } finally { c.release(); }
    // The 'purge' mode only ever matched the routine copies (diagnostics and canonical rows have no copy retention).
    const c2 = await R.owner.connect();
    try {
      await ev("api_auth_failed", { why: "x" });
      await c2.query("BEGIN");
      await c2.query("SELECT set_config('fleet.event_retention', 'purge', true)");
      await expect(c2.query(`DELETE FROM fleet.fleet_events WHERE event_type = 'api_auth_failed'`)).rejects.toThrow(/FLEET_HISTORY_IMMUTABLE/);
      await c2.query("ROLLBACK");
    } finally { c2.release(); }
  });

  it("the one-time purge removes exactly the routine copies; canonical history, ledger, Treasury, Agents, ventures, knowledge, cap and sign-in state are unchanged", async () => {
    // Routine copies of every kind, next to canonical history and diagnostics.
    await R.ledger.recordOwnerFunding(2_500, `bank:history-${Date.now()}`, OWNER);           // ledger_journal_posted (+ the journal itself)
    for (let i = 0; i < 3; i++) await ev("session_opened", { expiresAt: "x" });
    await ev("agent_role_granted", { role: "fleet_agent" });
    await ev("dashboard_role_granted", { role: "fleet_dashboard" });
    await ev("notifications_deleted", { count: 1 });
    await ev("api_auth_failed", { why: "bad token" });
    await ev("operator_replay_blocked", { code: "FLEET_OP_REPLAYED" });
    await ev("production_deployed", { commit: "abc" });
    // Routine process steps (canonical record elsewhere) next to their meaningful outcomes.
    for (const t of ["runtime_approved", "founder_runtime_upgrade_prepared", "founder_runtime_upgrade_committed", "operator_action", "fx_rate_recorded", "slot_reserved", "provisioning_started"]) await ev(t);
    for (const t of ["founder_runtime_upgrade_verified", "provisioning_failed", "provisioning_uncertain"]) await ev(t);
    await R.q(`SELECT fleet.fleet_notify('AMBER', 'ADMIN_PASSKEY_ADDED', NULL, 'passkey added', '{}'::jsonb, 'history:purge-notice')`);
    const copies = `fleet.fleet_event_retention_days(event_type, detail) = 7`;
    const byType = Object.fromEntries((await R.q(`SELECT event_type, count(*)::int AS n FROM fleet.fleet_events WHERE ${copies} GROUP BY 1`)).map((r) => [r.event_type, r.n]));
    expect(Object.keys(byType).sort()).toEqual(expect.arrayContaining(["agent_role_granted", "dashboard_role_granted", "ledger_journal_posted", "notifications_deleted", "session_opened",
      "runtime_approved", "founder_runtime_upgrade_prepared", "founder_runtime_upgrade_committed", "operator_action", "fx_rate_recorded", "slot_reserved", "provisioning_started", "notification"]));
    const fx = Number(await R.one(`(SELECT count(*) FROM fleet.fleet_fx_rates)`));
    const journals = await R.q(`SELECT count(*)::int AS n, md5(string_agg(journal_id::text, ',' ORDER BY journal_id)) AS d FROM fleet.fleet_ledger_journal`);
    const sessionsBefore = await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_agent_sessions`).catch(() => [{ n: -1 }]);

    const before = snap("purge-before");
    const total = before.json.events.count;
    // The migration's purge statement, exactly as v45 runs it.
    const c = await R.owner.connect();
    try { await c.query("BEGIN"); await c.query("SET LOCAL search_path TO fleet"); await c.query(PURGE_COPIES_SQL); await c.query("COMMIT"); }
    finally { c.release(); }
    const after = snap("purge-after", cuts(before.json));
    const { code, report } = compare(before.file, after.file);
    expect(report.failures).toEqual([]);
    expect(code).toBe(0);
    // Exact subtraction: before − purged = after, purged = the copies by type.
    expect(report.events.purged).toEqual(byType);
    const purged = Object.values(byType).reduce((s, n) => s + n, 0);
    expect(await count()).toBe(total - purged);
    expect(report.events.preserved).toBe(total - purged);
    expect(await count(copies)).toBe(0);
    // Diagnostics, serious incidents and canonical history stay.
    expect(await count(`event_type = 'api_auth_failed'`)).toBeGreaterThan(0);
    for (const t of ["operator_replay_blocked", "production_deployed", "treasury_sweep", "venture_created", "genesis_funded", "founder_runtime_upgrade_verified",
      "provisioning_failed", "provisioning_uncertain"]) expect(await count(`event_type = '${t}'`), t).toBeGreaterThan(0);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_fx_rates)`))).toBe(fx);   // the canonical FX record is its own table
    // No third class: every remaining row is meaningful history or temporary (with a retention).
    expect(await count(`NOT fleet.fleet_event_in_history(event_type, detail) AND fleet.fleet_event_retention_days(event_type, detail) IS NULL`)).toBe(0);
    // The real ledger journals and sessions were never touched.
    expect(await R.q(`SELECT count(*)::int AS n, md5(string_agg(journal_id::text, ',' ORDER BY journal_id)) AS d FROM fleet.fleet_ledger_journal`)).toEqual(journals);
    expect(await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_agent_sessions`).catch(() => [{ n: -1 }])).toEqual(sessionsBefore);
    // The reconciliation compared (and found unchanged): agents, population / cap / mode, replication, ledger head /
    // journals / postings / balances, economics and computed sweeps, Treasury ledger, ventures, missions, knowledge,
    // estates, credentials, owner passkeys / authenticator / password.
    expect(before.json.agents.length).toBe(1);
    expect(after.json.state).toEqual(before.json.state);
    expect(after.json.adminAuth).toEqual(before.json.adminAuth);
    expect(after.json.ledger.journals).toBe(before.json.ledger.journals);
    // Fail-closed: a canonical event removed (or changed) is a failure, not a purge.
    const base = snap("guard-base");
    const tampered = JSON.parse(JSON.stringify(base.json));
    tampered.events.canonical.digest = "0".repeat(32);
    fs.writeFileSync(path.join(dir, "tampered.json"), JSON.stringify(tampered));
    expect(compare(base.file, path.join(dir, "tampered.json")).report.failures.map((f: { check: string }) => f.check)).toContain("existing canonical events");
  });

  it("retention: copies expire after 7 days, routine auth diagnostics after 30; serious incidents never; no event, no Fleet Command entry", async () => {
    await old("session_opened", 8); await old("ledger_journal_posted", 8); await old("custody_role_granted", 8);
    await old("session_opened", 6);
    await old("runtime_approved", 8); await old("fx_rate_recorded", 8); await old("operator_action", 8); await old("provisioning_verifying", 8);
    await old("notification", 8, { class: "AMBER", code: "ADMIN_PASSKEY_ADDED" });
    await old("founder_runtime_upgrade_verified", 400); await old("provisioning_failed", 400); await old("production_deployed", 400);
    for (const t of EVENT_DIAGNOSTIC_TYPES) { await old(t, 31); await old(t, 29); }
    // Serious incidents and canonical history, a year old.
    await old("operator_replay_blocked", 400); await old("authorization_denied", 400); await old("treasury_sweep", 400);
    await old("operator_scope_denied", 400, { code: "FLEET_OP_SCOPE_DENIED" });
    await old("notification", 400, { class: "RED", code: "ADMIN_AUTH_LOCKOUT" }); await old("agent_died", 400);
    await R.q(`INSERT INTO fleet.fleet_notification_suppress (dedupe_key, until) VALUES ('history:expired', now() - interval '1 minute'), ('history:live', now() + interval '6 days')`);
    const maxId = Number(await R.one(`(SELECT max(id) FROM fleet.fleet_events)`));
    const feed = Number(await R.one(`(SELECT count(*) FROM fleet.fleet_command_feed)`));
    const yearOld = await count(`created_at < now() - interval '300 days'`);

    // Through the SERVICE role, as the controller runs it.
    const svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 1 });
    let r: Record<string, number>;
    try { r = (await svc.query("SELECT fleet.svc_event_retention() AS r")).rows[0].r; } finally { await svc.end(); }
    expect(r.eventsExpired).toBe(3 + 5 + EVENT_DIAGNOSTIC_TYPES.length);
    expect(r.suppressionExpired).toBe(1);
    expect(await count(`created_at < now() - interval '7 days' AND (event_type IN ('session_opened','ledger_journal_posted') OR event_type ~ '_role_granted$')`)).toBe(0);
    expect(await count(`event_type = 'session_opened' AND created_at < now() - interval '5 days'`)).toBe(1);   // the 6-day copy stays
    for (const t of EVENT_DIAGNOSTIC_TYPES) {
      expect(await count(`event_type = '${t}' AND created_at < now() - interval '30 days'`), t).toBe(0);
      expect(await count(`event_type = '${t}' AND created_at < now() - interval '28 days'`), t).toBe(1);
    }
    expect(await count(`created_at < now() - interval '300 days'`)).toBe(yearOld);   // replay, denials, sweep, lockout, death: all kept
    // A privilege (scope) denial is durable security history: no retention, in Fleet history, survives the pass;
    // the routine operator_auth_failed diagnostic next to it expired after 30 days.
    expect(EVENT_DIAGNOSTIC_TYPES).not.toContain("operator_scope_denied");
    expect(await R.one(`fleet.fleet_event_retention_days('operator_scope_denied', '{}'::jsonb)`)).toBeNull();
    expect(await R.one(`fleet.fleet_event_in_history('operator_scope_denied', '{}'::jsonb)`)).toBe(true);
    expect(await count(`event_type = 'operator_scope_denied' AND created_at < now() - interval '300 days'`)).toBe(1);
    expect(await count(`event_type = 'operator_auth_failed' AND created_at < now() - interval '30 days'`)).toBe(0);
    expect(Number(await R.one(`(SELECT max(id) FROM fleet.fleet_events)`))).toBe(maxId); // the pass wrote no event
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_command_feed)`))).toBe(feed);
    expect((await R.q(`SELECT dedupe_key FROM fleet.fleet_notification_suppress ORDER BY 1`)).map((x) => x.dedupe_key)).toEqual(["history:live"]);
    // A second pass finds nothing.
    expect(await R.store.eventRetention()).toEqual({ eventsExpired: 0, suppressionExpired: 0 });
    // The service role may run the pass, and the privilege surface is still exact.
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });

  it("the dashboard's history is meaningful Fleet history only; an explicit type still reaches a diagnostic during its window", async () => {
    await ev("session_opened"); await ev("ledger_journal_posted"); await ev("service_role_granted"); await ev("notifications_deleted");
    await ev("api_auth_failed", { why: "x" }); await ev("db_auth_failed"); await ev("runtime_approved"); await ev("provisioning_started");
    await ev("operator_action"); await ev("slot_reserved");
    await R.q(`SELECT fleet.fleet_notify('AMBER', 'ADMIN_PASSKEY_ADDED', NULL, 'passkey added', '{}'::jsonb, 'history:passkey')`);
    await R.q(`SELECT fleet.fleet_notify('RED', 'ADMIN_AUTH_LOCKOUT', NULL, 'lockout', '{}'::jsonb, 'history:lockout')`);
    await ev("agent_died"); await ev("knowledge_recorded"); await ev("production_rolled_back"); await ev("settlement_conflict");
    const history = (await dash("events", { limit: 1000 })) as Array<Record<string, any>>;
    const types = new Set(history.map((e) => e.type as string));
    for (const t of ["session_opened", "ledger_journal_posted", "service_role_granted", "notifications_deleted", "api_auth_failed", "db_auth_failed",
      "runtime_approved", "provisioning_started", "operator_action", "slot_reserved"]) expect(types.has(t), t).toBe(false);
    expect(history.filter((e) => e.type === "notification").map((e) => e.detail.code)).not.toContain("ADMIN_PASSKEY_ADDED");
    expect(history.filter((e) => e.type === "notification").map((e) => e.detail.code)).toContain("ADMIN_AUTH_LOCKOUT");
    for (const t of ["agent_died", "knowledge_recorded", "production_rolled_back", "settlement_conflict", "treasury_sweep", "venture_created",
      "operator_replay_blocked", "authorization_denied", "production_deployed", "genesis_funded"]) expect(types.has(t), t).toBe(true);
    // Diagnostics stay reachable for security work during their window (explicit type; and the Operator API listing).
    expect(((await dash("events", { type: "api_auth_failed", limit: 50 })) as unknown[]).length).toBeGreaterThan(0);
    // Agent memory is not plumbing: the Agent's own activity view still has its activity.
    const agentEvents = (await dash("agent_events", { agentId: R.founders[0].id })) as Array<Record<string, any>>;
    expect(agentEvents.map((e) => e.type)).toContain("venture_created");
  });
});

describe("the reconciliation's expiring classes match the migration's", () => {
  it("scripts/fleet-reconcile-snapshot.sql names exactly the expiring types, diagnostics and routed notification codes", () => {
    const sql = fs.readFileSync(path.join(ROOT, "scripts/fleet-reconcile-snapshot.sql"), "utf8");
    const lists = [...sql.matchAll(/event_type IN \(([^)]*)\)/g)].map((m) => m[1]).filter((x) => x.includes("operator_stale"));
    expect(lists).toHaveLength(2);
    for (const l of lists) expect(l.split(",").map((x) => x.trim().replace(/'/g, "")).sort()).toEqual([...EVENT_COPY_TYPES, ...EVENT_DIAGNOSTIC_TYPES].sort());
    const codes = [...sql.matchAll(/NOT IN \(([^)]*)\)/g)].map((m) => m[1]).filter((x) => x.includes("DAILY_REPORT")).map((x) => x.split(",").map((x) => x.trim().replace(/'/g, "")).sort());
    expect(codes).toHaveLength(2);
    for (const c of codes) expect(c).toEqual(Object.keys(NOTIFICATION_ROUTES).sort());
  });
});
