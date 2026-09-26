/**
 * Phase B2 Operator API — PostgreSQL tests (ephemeral cluster only).
 *
 * Schema v8 migration (production-shaped v7 registry, check/rollback, apply,
 * idempotence, atomic failure, v8 build refusing a v7 registry), role
 * isolation, the signature-termination invariant (incl. deliberate catalog
 * mutations), op_begin_request fail-closed paths and replay, Amendment 3
 * (an accepted request changes only operator bookkeeping), Amendment 1
 * (50/75/100% thresholds, fail closed, no automatic deletion, audited
 * archival), principal/key constraints, approver rule, nonce purge.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto, { type KeyObject } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { ulid } from "ulid";
import { PgFleetStore } from "../../fleet/postgres/store.js";
import { FLEET_PG_SCHEMA_VERSION, OPERATOR_API_FUNCTIONS, OPERATOR_READ_FUNCTIONS, OPERATOR_VOLATILE_FUNCTIONS, PG_MIGRATIONS } from "../../fleet/postgres/migrations.js";
import { OPERATOR_REQUEST_CAP } from "../../fleet/postgres/migrations-phase8.js";
import { PgOperatorGateway } from "../../fleet/operator/gateway.js";
import { PgOperatorAdmin } from "../../fleet/operator/admin.js";
import { EMPTY_BODY_SHA256, keyIdOf, newNonce, rawPublicKey } from "../../fleet/operator/canonical.js";
import { runDoctor } from "../../fleet/doctor.js";
import { operatorSurfaceProblems } from "../../fleet/postgres/privileges.js";
import { findPgBin, startEphemeralPg, type EphemeralPg } from "./fixtures/ephemeral-pg.js";

const PG_BIN = findPgBin();
const PIN = { repo: "https://github.com/5l4mm3r/automaton-fleet", commit: "c".repeat(40) };
const BUILD = { buildId: "d".repeat(64), lockfileSha256: "e".repeat(64) };
const ACTOR = "operator:test";
const norm = (sig: string) => sig.replace(/^.*?\.(?=[a-z_][a-z0-9_]*\()/i, "").replace(/"/g, "").replace(/\s+/g, "");

describe.skipIf(!PG_BIN)("B2 schema v8 and the operator database surface (PostgreSQL)", () => {
  let pgc: EphemeralPg;
  let owner: pg.Pool;
  let admin: PgFleetStore;
  let opAdmin: PgOperatorAdmin;
  let gw: PgOperatorGateway;
  let opRaw: pg.Pool;

  const keypair = () => {
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    const raw = rawPublicKey(privateKey);
    return { privateKey, publicKey: raw.toString("base64url"), keyId: keyIdOf(raw) };
  };

  async function toV7(schema: string): Promise<void> {
    const c = await owner.connect();
    try {
      await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await c.query(`CREATE SCHEMA ${schema}`);
      await c.query(`CREATE TABLE ${schema}.fleet_schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
      for (const m of PG_MIGRATIONS.filter((x) => x.version <= 7)) {
        await c.query("BEGIN");
        await c.query(`SET LOCAL search_path TO ${schema}`);
        await c.query(m.sql.replaceAll("@@SCHEMA@@", `"${schema}"`));
        await c.query(`INSERT INTO ${schema}.fleet_schema_migrations (version, name) VALUES ($1, $2)`, [m.version, m.name]);
        await c.query("COMMIT");
      }
      // Production-shaped empty registry (cap 2, DEVELOPMENT, approved runtime, replication off).
      await c.query(
        `UPDATE ${schema}.fleet_state SET max_agents = 2, operating_mode = 'DEVELOPMENT', runtime_repo = $1, runtime_commit = $2,
                runtime_build_id = $3, runtime_lockfile_sha256 = $4, replication_enabled = false WHERE id = 1`,
        [PIN.repo, PIN.commit, BUILD.buildId, BUILD.lockfileSha256],
      );
    } finally {
      c.release();
    }
  }

  const reg = (schema: string, name: string) => owner.query(`SELECT to_regclass($1) AS r`, [`${schema}.${name}`]).then((r) => r.rows[0].r as string | null);

  async function enroll(name: string, kind: "bridge_claude" | "bridge_chatgpt", scopes: string[]) {
    const k = keypair();
    const r = await opAdmin.enroll({ name, kind, scopes: scopes as never, publicKey: k.publicKey, expiresDays: 30, actor: ACTOR });
    return { ...r, ...k };
  }

  const begin = (p: { principalId: string; keyId: string }, route: string, over: Partial<{ ts: number; nonce: string }> = {}) =>
    gw.beginRequest({ principal: p.principalId, key: p.keyId, route, clientTsMs: over.ts ?? Date.now(), nonce: over.nonce ?? newNonce(), bodySha256: EMPTY_BODY_SHA256 });

  /** Row count + content digest of every base table in the schema. */
  async function snapshot(schema = "fleet"): Promise<Record<string, string>> {
    const t = await owner.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = $1 ORDER BY 1`, [schema]);
    const out: Record<string, string> = {};
    for (const { t: name } of t.rows) {
      const r = await owner.query<{ d: string }>(`SELECT count(*) || ':' || coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS d FROM ${schema}.${name} x`);
      out[name] = r.rows[0].d;
    }
    return out;
  }
  const changed = (a: Record<string, string>, b: Record<string, string>) => Object.keys(b).filter((k) => a[k] !== b[k]).sort();

  async function setCounter(n: number) {
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('fleet.operator_archive', 'on', true)");
      await c.query("UPDATE fleet.fleet_operator_state SET request_count = $1 WHERE id = 1", [n]);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
  }

  beforeAll(async () => {
    pgc = await startEphemeralPg(PG_BIN!);
    owner = new pg.Pool({ connectionString: pgc.ownerUrl, max: 6 });
    admin = new PgFleetStore({ connectionString: pgc.ownerUrl });
    await admin.migrate();
    await admin.setApprovedRuntime(PIN, "test", BUILD);
    await admin.setMaxAgents(2, "test");
    opAdmin = new PgOperatorAdmin({ connectionString: pgc.ownerUrl });
    gw = new PgOperatorGateway({ connectionString: pgc.operatorUrl });
    opRaw = new pg.Pool({ connectionString: pgc.operatorUrl, max: 2 });
  }, 90_000);

  afterAll(async () => {
    await opRaw?.end();
    await gw?.close();
    await opAdmin?.close();
    await admin?.close();
    await owner?.end();
    pgc?.stop();
  });

  // ── Migration ─────────────────────────────────────────────────

  it("v7 -> v8 -> v9 -> v10 on a production-shaped empty registry: exact check (rolled back), apply, idempotent; v10 code refuses v7", async () => {
    const schema = "mig_v8";
    await toV7(schema);
    const store = new PgFleetStore({ connectionString: pgc.ownerUrl, schema });
    try {
      const h7 = await store.health();
      expect(h7.ok).toBe(false); // a v9 build refuses a v7 registry (exact version check)
      expect(h7.schemaVersion).toBe(7);
      expect(await store.migrateCheck()).toEqual({ currentVersion: 7, resultingVersion: 15, wouldApply: [8, 9, 10, 11, 12, 13, 14, 15] });
      expect(await reg(schema, "fleet_operator_state")).toBeNull(); // rolled back
      const before = await owner.query(`SELECT max_agents, operating_mode, runtime_commit, runtime_build_id, replication_enabled FROM ${schema}.fleet_state`);
      expect(await store.migrate()).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
      expect(FLEET_PG_SCHEMA_VERSION).toBe(15);
      const h9 = await store.health();
      expect(h9).toMatchObject({ ok: true, schemaVersion: 15, countersConsistent: true });
      const rows = await owner.query(`SELECT version, name FROM ${schema}.fleet_schema_migrations ORDER BY version`);
      expect(rows.rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      expect(rows.rows[7].name).toBe("operator_api_read_only");
      expect(rows.rows[8].name).toBe("operator_actions_controlled");
      expect(rows.rows[9].name).toBe("treasury_ledger_custody_boundary");
      expect(rows.rows[10].name).toBe("genesis_pre_genesis_integration");
      expect(rows.rows[11].name).toBe("founder_runtime_attestation");
      const after = await owner.query(`SELECT max_agents, operating_mode, runtime_commit, runtime_build_id, replication_enabled FROM ${schema}.fleet_state`);
      expect(after.rows).toEqual(before.rows); // business state untouched
      const st = await owner.query(`SELECT operator_api_enabled, operator_actions_enabled, generation, request_count, request_cap FROM ${schema}.fleet_operator_state`);
      expect(st.rows[0]).toEqual({ operator_api_enabled: false, operator_actions_enabled: false, generation: "0", request_count: "0", request_cap: String(OPERATOR_REQUEST_CAP) });
      const routes = await owner.query(`SELECT fn FROM ${schema}.fleet_operator_routes WHERE route LIKE 'GET %' ORDER BY fn`);
      expect(routes.rows.map((r) => r.fn)).toEqual([...OPERATOR_READ_FUNCTIONS].sort());
      expect((await store.auditPrivileges()).problems).toEqual([]);
      expect(await store.migrate()).toEqual([]); // idempotent
    } finally {
      await store.close();
      await owner.query(`DROP SCHEMA ${schema} CASCADE`);
    }
  });

  it("a failing v8 migration is atomic: v7 stays intact with no partial operator objects", async () => {
    const schema = "mig_fail";
    await toV7(schema);
    await owner.query(`CREATE TABLE ${schema}.fleet_operator_nonces (x int)`); // conflicting object
    const store = new PgFleetStore({ connectionString: pgc.ownerUrl, schema });
    try {
      await expect(store.migrate()).rejects.toThrow();
      const v = await owner.query(`SELECT max(version) AS v FROM ${schema}.fleet_schema_migrations`);
      expect(v.rows[0].v).toBe(7);
      expect(await reg(schema, "fleet_operator_state")).toBeNull();
      expect(await reg(schema, "fleet_operator_principals")).toBeNull();
      await owner.query(`DROP TABLE ${schema}.fleet_operator_nonces`);
      expect(await store.migrate()).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
    } finally {
      await store.close();
      await owner.query(`DROP SCHEMA ${schema} CASCADE`);
    }
  });

  // ── Roles and privileges ──────────────────────────────────────

  it("the operator role executes exactly the op_* allow-list (read side STABLE), owns nothing, reads no table", async () => {
    const fns = await owner.query<{ sig: string; vol: string }>(
      `SELECT p.oid::regprocedure::text AS sig, p.provolatile AS vol FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'fleet' AND has_function_privilege('fleet_operator_login', p.oid, 'EXECUTE')`,
    );
    expect(fns.rows.map((r) => norm(r.sig)).sort()).toEqual(OPERATOR_API_FUNCTIONS.map(norm).sort());
    const volatile = new Set(OPERATOR_VOLATILE_FUNCTIONS.map(norm));
    for (const r of fns.rows) {
      if (!volatile.has(norm(r.sig))) expect(r.vol, r.sig).toBe("s");
    }
    const tables = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'fleet' AND c.relkind IN ('r','v','m','p','S')
          AND (has_table_privilege('fleet_operator_login', c.oid, 'SELECT') OR has_table_privilege('fleet_operator_login', c.oid, 'INSERT')
               OR has_table_privilege('fleet_operator_login', c.oid, 'UPDATE') OR has_table_privilege('fleet_operator_login', c.oid, 'DELETE'))`,
    );
    expect(tables.rows[0].n).toBe(0);
    for (const sql of [
      "SELECT * FROM fleet.fleet_agents",
      "SELECT * FROM fleet.fleet_operator_keys",
      "INSERT INTO fleet.fleet_operator_requests (request_id) VALUES (gen_random_uuid())",
      "SELECT fleet.svc_mark_dead('x','y','z','w')",
      "SELECT fleet.api_whoami('x','y')",
      "SELECT fleet.fleet_event('x', null, null, '{}'::jsonb)",
      "SELECT fleet.fleet_operator_archive_requests(now(), 0, repeat('a', 64), 'operator:x')",
      "SELECT fleet.fleet_operator_request_ok(gen_random_uuid(), 'op_whoami')",
    ]) {
      await expect(opRaw.query(sql), sql).rejects.toThrow(/permission denied/);
    }
    for (const url of [pgc.agentUrl, pgc.serviceUrl]) {
      const p = new pg.Pool({ connectionString: url, max: 1 });
      try {
        await expect(p.query("SELECT fleet.op_ping()")).rejects.toThrow(/permission denied/);
      } finally {
        await p.end();
      }
    }
    expect((await admin.auditPrivileges()).problems).toEqual([]);
  });

  it("signature-termination invariant: catalog mutations of the operator surface are detected or refused", async () => {
    const schema = "op_mut";
    await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    const store = new PgFleetStore({ connectionString: pgc.ownerUrl, schema });
    try {
      await store.migrate();
      expect((await store.auditPrivileges()).problems).toEqual([]);
      const problems = async () => (await store.auditPrivileges()).problems.join("\n");

      // Routes can only map to the five read functions, and are immutable.
      for (const fn of ["svc_mark_dead", "op_begin_request", "op_evil"]) {
        await expect(owner.query(`INSERT INTO ${schema}.fleet_operator_routes (route, scope, fn, kinds) VALUES ('GET /v1/operator/x', NULL, $1, ARRAY['bridge_claude'])`, [fn]), fn).rejects.toThrow(/check constraint/);
      }
      await expect(owner.query(`UPDATE ${schema}.fleet_operator_routes SET scope = NULL WHERE fn = 'op_list_events'`)).rejects.toThrow(/FLEET_HISTORY_IMMUTABLE/);

      // STABLE is enforced by PostgreSQL: a read function that tries to write fails when called.
      await owner.query(`CREATE OR REPLACE FUNCTION ${schema}.op_whoami(p_request uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
        SET search_path = ${schema}, pg_temp AS $$ BEGIN INSERT INTO fleet_events (event_type) VALUES ('x'); RETURN '{}'::jsonb; END $$`);
      await expect(owner.query(`SELECT ${schema}.op_whoami(gen_random_uuid())`)).rejects.toThrow(/non-volatile function/);
      expect(await problems()).toMatch(/op_whoami contains a write statement/);

      // Granting a mutating function to the operator role is reported.
      await owner.query(`GRANT EXECUTE ON FUNCTION ${schema}.svc_mark_dead(text, text, text, text) TO fleet_operator`);
      expect(await problems()).toMatch(/fleet_operator can EXECUTE op_mut\.svc_mark_dead/);
      await owner.query(`REVOKE EXECUTE ON FUNCTION ${schema}.svc_mark_dead(text, text, text, text) FROM fleet_operator`);

      // A new volatile op_* function (even ungranted) is reported; granted, doubly so.
      await owner.query(`CREATE FUNCTION ${schema}.op_evil() RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ${schema}, pg_temp AS $$ UPDATE fleet_state SET max_agents = 50 $$`);
      await owner.query(`REVOKE ALL ON FUNCTION ${schema}.op_evil() FROM PUBLIC`);
      expect(await problems()).toMatch(/unexpected function op_mut\.op_evil\(\)/);
      await owner.query(`GRANT EXECUTE ON FUNCTION ${schema}.op_evil() TO fleet_operator`);
      expect(await problems()).toMatch(/fleet_operator can EXECUTE op_mut\.op_evil\(\)/);

      // A read function made VOLATILE is reported.
      await owner.query(`ALTER FUNCTION ${schema}.op_fleet_status(uuid) VOLATILE`);
      const p = await problems();
      expect(p).toMatch(/op_fleet_status\(uuid\) is not STABLE/);
      expect(p).toMatch(/op_fleet_status is volatile/);

      // The admission logic (v9: fleet_operator_begin, called by op_begin_request / op_begin_action) writing business state is reported.
      const src = (await owner.query(`SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND proname = 'fleet_operator_begin'`, [schema])).rows[0].prosrc as string;
      const evil = src.replace("RETURN jsonb_build_object('ok', true,", "UPDATE fleet_state SET max_agents = 50;\n  RETURN jsonb_build_object('ok', true,");
      expect(evil).not.toBe(src);
      await owner.query(`CREATE OR REPLACE FUNCTION ${schema}.fleet_operator_begin(p_mode text, p_principal text, p_key text, p_route text, p_client_ts_ms bigint, p_nonce text, p_body_sha256 text)
        RETURNS jsonb LANGUAGE plpgsql SET search_path = ${schema}, pg_temp AS $body$${evil}$body$`);
      expect(await problems()).toMatch(/fleet_operator_begin writes fleet_state/);
      // ...and so is the wrapper itself writing business state.
      await owner.query(`CREATE OR REPLACE FUNCTION ${schema}.op_begin_request(p_principal text, p_key text, p_route text, p_client_ts_ms bigint, p_nonce text, p_body_sha256 text)
        RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ${schema}, pg_temp AS $w$ BEGIN UPDATE fleet_state SET max_agents = 50;
        RETURN fleet_operator_begin('read', p_principal, p_key, p_route, p_client_ts_ms, p_nonce, p_body_sha256); END $w$`);
      expect(await problems()).toMatch(/op_begin_request writes fleet_state/);
    } finally {
      await store.close();
      await owner.query(`DROP SCHEMA ${schema} CASCADE`);
    }
  });

  it("the static audit catches hidden writes (dynamic SQL, quoted names, side-effect builtins, indirect helpers, MERGE, other schemas)", async () => {
    const schema = "op_mut2";
    await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await owner.query(`DROP SCHEMA IF EXISTS zz_other CASCADE`);
    const store = new PgFleetStore({ connectionString: pgc.ownerUrl, schema });
    try {
      await store.migrate();
      expect(await operatorSurfaceProblems(owner, schema)).toEqual([]);
      const whoami = (body: string) =>
        `CREATE OR REPLACE FUNCTION ${schema}.op_whoami(p_request uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
         SET search_path = ${schema}, pg_temp AS $f$ BEGIN ${body}; RETURN '{}'::jsonb; END $f$`;
      const beginSrc = (await owner.query(`SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND proname = 'fleet_operator_begin'`, [schema])).rows[0].prosrc as string;
      const begin = (stmt: string) =>
        `CREATE OR REPLACE FUNCTION ${schema}.fleet_operator_begin(p_mode text, p_principal text, p_key text, p_route text, p_client_ts_ms bigint, p_nonce text, p_body_sha256 text)
         RETURNS jsonb LANGUAGE plpgsql SET search_path = ${schema}, pg_temp AS $body$${beginSrc.replace("RETURN jsonb_build_object('ok', true,", `${stmt};\n  RETURN jsonb_build_object('ok', true,`)}$body$`;
      const cases: Array<[string, string[], RegExp]> = [
        ["read side: dynamic SQL", [whoami(`EXECUTE 'SELECT fleet_' || 'event(''x'', NULL, NULL, ''{}''::jsonb)'`)], /op_whoami uses dynamic SQL/],
        ["read side: quoted call", [whoami(`PERFORM "fleet_event"('x', NULL, NULL, '{}'::jsonb)`)], /op_whoami uses a quoted identifier/],
        ["read side: nextval", [whoami(`PERFORM nextval('fleet_events_id_seq')`)], /op_whoami calls side-effecting nextval/],
        ["read side: advisory lock", [whoami(`PERFORM pg_advisory_lock(1)`)], /op_whoami calls side-effecting pg_advisory_lock/],
        ["read side: set_config", [whoami(`PERFORM set_config('fleet.operator_archive', 'on', false)`)], /op_whoami calls side-effecting set_config/],
        ["read side: pg_notify", [whoami(`PERFORM pg_notify('c', 'x')`)], /op_whoami calls side-effecting pg_notify/],
        [
          "read side: indirect helper",
          [
            `CREATE FUNCTION ${schema}.zz_helper() RETURNS void LANGUAGE plpgsql STABLE SET search_path = ${schema}, pg_temp AS $h$ BEGIN PERFORM fleet_event('x', NULL, NULL, '{}'::jsonb); END $h$`,
            whoami(`PERFORM zz_helper()`),
          ],
          /op_whoami calls zz_helper, which is not an operator read helper/,
        ],
        [
          "read side: function in another schema",
          [`CREATE SCHEMA zz_other`, `CREATE FUNCTION zz_other.zz_w() RETURNS void LANGUAGE sql AS $w$ SELECT 1 $w$`, whoami(`PERFORM zz_other.zz_w()`)],
          /op_whoami calls zz_w from another schema/,
        ],
        ["begin: quoted UPDATE target", [begin(`UPDATE "fleet_state" SET max_agents = 50`)], /fleet_operator_begin writes fleet_state/],
        ["begin: dynamic UPDATE", [begin(`EXECUTE format('UPDATE %I SET max_agents = 50', 'fleet_state')`)], /fleet_operator_begin uses dynamic SQL/],
        ["begin: MERGE", [begin(`MERGE INTO fleet_state t USING (SELECT 1 AS id) s ON t.id = s.id WHEN MATCHED THEN UPDATE SET max_agents = 50`)], /fleet_operator_begin writes fleet_state/],
        ["begin: volatile call", [begin(`PERFORM fleet_reap('x')`)], /fleet_operator_begin calls volatile fleet_reap/],
      ];
      for (const [label, stmts, re] of cases) {
        const c = await owner.connect();
        try {
          await c.query("BEGIN");
          for (const q of stmts) await c.query(q);
          expect((await operatorSurfaceProblems(c, schema)).join("\n"), label).toMatch(re);
        } finally {
          await c.query("ROLLBACK");
          c.release();
        }
      }
      expect(await operatorSurfaceProblems(owner, schema)).toEqual([]);
    } finally {
      await store.close();
      await owner.query(`DROP SCHEMA ${schema} CASCADE`);
      await owner.query(`DROP SCHEMA IF EXISTS zz_other CASCADE`);
    }
  });

  it("runtime barrier: reads run READ ONLY, so even a tampered read function cannot write", async () => {
    const c = await enroll("bridge-readonly", "bridge_claude", ["ops.read.status"]);
    await opAdmin.setEnabled({ enabled: true, reason: "test", actor: ACTOR });
    const original = (await owner.query(`SELECT pg_get_functiondef('fleet.op_whoami(uuid)'::regprocedure) AS d`)).rows[0].d as string;
    const events = async () => (await owner.query(`SELECT count(*)::int AS n FROM fleet.fleet_events`)).rows[0].n;
    try {
      // STABLE does not stop a write done through a volatile callee; the READ ONLY transaction does.
      await owner.query(`CREATE FUNCTION fleet.zz_writer() RETURNS void LANGUAGE sql VOLATILE SET search_path = fleet, pg_temp AS $w$ INSERT INTO fleet_events (event_type) VALUES ('zz_tampered') $w$`);
      await owner.query(`CREATE OR REPLACE FUNCTION fleet.op_whoami(p_request uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
        SET search_path = fleet, pg_temp AS $f$ BEGIN PERFORM zz_writer(); RETURN '{}'::jsonb; END $f$`);
      const b = await begin(c, "GET /v1/operator/whoami");
      expect(b.ok).toBe(true);
      const n = await events();
      await expect(gw.whoami((b as { requestId: string }).requestId)).rejects.toThrow(/read-only transaction/);
      expect(await events()).toBe(n);
      expect((await owner.query(`SELECT count(*)::int AS n FROM fleet.fleet_events WHERE event_type = 'zz_tampered'`)).rows[0].n).toBe(0);
    } finally {
      await owner.query(original);
      await owner.query(`DROP FUNCTION IF EXISTS fleet.zz_writer()`);
    }
    expect((await gw.auditOperator()).problems).toEqual([]);
  });

  // ── Principals, keys, lifecycle ───────────────────────────────

  it("principal and key constraints: fingerprint ids, 90-day cap, <= 2 active keys, immutability, final revocation, no deletion", async () => {
    const c = await enroll("bridge-claude-a", "bridge_claude", ["ops.read.status", "ops.read.agents", "ops.read.events"]);
    expect(c.principalId).toMatch(/^op_[0-9A-HJKMNP-TV-Z]{26}$/);
    const ev = await owner.query(`SELECT detail::text AS d FROM fleet.fleet_events WHERE event_type = 'operator_principal_enrolled' ORDER BY id DESC LIMIT 1`);
    expect(ev.rows[0].d).not.toContain(c.publicKey); // only the fingerprint is logged
    // ChatGPT can never hold events (or any D3 scope): refused by the CLI and, independently, by the database.
    await expect(enroll("bridge-chatgpt-x", "bridge_chatgpt", ["ops.read.events"])).rejects.toThrow(/bridge_chatgpt principal may only hold/);
    await expect(
      owner.query(`INSERT INTO fleet.fleet_operator_principals (principal_id, name, kind, scopes, created_by) VALUES ($1, 'bridge-chatgpt-y', 'bridge_chatgpt', ARRAY['ops.read.events'], 'x')`, [`op_${ulid()}`]),
    ).rejects.toThrow(/chatgpt_no_events|chatgpt_read_only/);
    await expect(enroll("bridge-claude-a", "bridge_claude", ["ops.read.status"])).rejects.toThrow(/duplicate key/);
    await expect(owner.query(`INSERT INTO fleet.fleet_operator_principals (principal_id, name, kind, scopes, created_by) VALUES ($1, 'dup-scopes', 'bridge_claude', ARRAY['ops.read.status','ops.read.status'], 'x')`, [`op_${ulid()}`])).rejects.toThrow(/duplicate scopes/);
    await expect(owner.query(`INSERT INTO fleet.fleet_operator_principals (principal_id, name, kind, scopes, created_by) VALUES ($1, 'treasury-x', 'bridge_claude', ARRAY['ops.read.treasury'], 'x')`, [`op_${ulid()}`])).rejects.toThrow(/check constraint/);
    // Key id must be the fingerprint of the key (checked while the principal has a free key slot).
    const k3 = keypair();
    await expect(owner.query(`INSERT INTO fleet.fleet_operator_keys (key_id, principal_id, public_key, expires_at, created_by) VALUES ($1, $2, $3, now() + interval '1 day', 'x')`, ["0".repeat(32), c.principalId, Buffer.from(k3.publicKey, "base64url")])).rejects.toThrow(/fleet_operator_keys_id_is_fingerprint/);
    await expect(owner.query(`INSERT INTO fleet.fleet_operator_keys (key_id, principal_id, public_key, not_before, expires_at, created_by) VALUES ($1, $2, $3, now(), now() + interval '91 days', 'x')`, [k3.keyId, c.principalId, Buffer.from(k3.publicKey, "base64url")])).rejects.toThrow(/fleet_operator_keys_validity/);
    const k2 = keypair();
    await opAdmin.addKey({ principalId: c.principalId, publicKey: k2.publicKey, expiresDays: 10, actor: ACTOR });
    await expect(opAdmin.addKey({ principalId: c.principalId, publicKey: keypair().publicKey, expiresDays: 10, actor: ACTOR })).rejects.toThrow(/2 active keys/);
    await expect(opAdmin.enroll({ name: "too-long", kind: "bridge_claude", scopes: ["ops.read.status"], publicKey: keypair().publicKey, expiresDays: 91, actor: ACTOR })).rejects.toThrow(/1\.\.90/);
    await expect(owner.query(`UPDATE fleet.fleet_operator_principals SET scopes = ARRAY['ops.read.status'] WHERE principal_id = $1`, [c.principalId])).rejects.toThrow(/FLEET_HISTORY_IMMUTABLE/);
    await expect(owner.query(`DELETE FROM fleet.fleet_operator_principals WHERE principal_id = $1`, [c.principalId])).rejects.toThrow(/FLEET_HISTORY_IMMUTABLE/);
    for (const t of ["fleet_operator_principals", "fleet_operator_keys", "fleet_operator_requests", "fleet_operator_nonces", "fleet_operator_state", "fleet_operator_routes"]) {
      await expect(owner.query(`TRUNCATE fleet.${t} CASCADE`), t).rejects.toThrow(/FLEET_HISTORY_IMMUTABLE/);
    }
    await opAdmin.revokeKey({ keyId: k2.keyId, reason: "rotated", actor: ACTOR });
    await expect(owner.query(`UPDATE fleet.fleet_operator_keys SET revoked_at = NULL, revoked_by = NULL WHERE key_id = $1`, [k2.keyId])).rejects.toThrow(/FLEET_HISTORY_IMMUTABLE/);
    const r = await enroll("bridge-revoked", "bridge_claude", ["ops.read.status"]);
    await opAdmin.revokePrincipal({ principalId: r.principalId, reason: "test", actor: ACTOR });
    await expect(opAdmin.addKey({ principalId: r.principalId, publicKey: keypair().publicKey, expiresDays: 5, actor: ACTOR })).rejects.toThrow(/revoked/);
    await expect(opAdmin.enroll({ name: "no-actor", kind: "bridge_claude", scopes: ["ops.read.status"], publicKey: keypair().publicKey, expiresDays: 5, actor: "op:x" })).rejects.toThrow(/operator:<user>/);
  });

  it("operator principals can never approve anything (approver rule)", async () => {
    const p = await enroll("bridge-approver", "bridge_claude", ["ops.read.status"]);
    for (const who of ["op:anything", p.principalId, "bridge-approver"]) {
      await expect(owner.query(`SELECT fleet.fleet_require_operator_approver($1, 'subject')`, [who]), who).rejects.toThrow(/FLEET_SELF_APPROVAL/);
    }
    await owner.query(`SELECT fleet.fleet_require_operator_approver('operator:ubuntu', 'subject')`);
  });

  // ── op_begin_request ──────────────────────────────────────────

  it("op_begin_request fails closed in every case and accepts exactly one use of a nonce", async () => {
    const c = await enroll("bridge-claude-b", "bridge_claude", ["ops.read.status", "ops.read.agents", "ops.read.events"]);
    const g = await enroll("bridge-chatgpt-b", "bridge_chatgpt", ["ops.read.status", "ops.read.agents"]);
    const lim = await enroll("bridge-status-only", "bridge_claude", ["ops.read.status"]);
    await opAdmin.setEnabled({ enabled: false, reason: "test", actor: ACTOR });
    expect(await begin(c, "GET /v1/operator/status")).toEqual({ ok: false, code: "FLEET_OP_DISABLED" });
    await opAdmin.setEnabled({ enabled: true, reason: "test", actor: ACTOR });

    const ok = await begin(c, "GET /v1/operator/status");
    expect(ok).toMatchObject({ ok: true, fn: "op_fleet_status" });
    const rid = (ok as { requestId: string }).requestId;
    expect(await gw.fleetStatus(rid)).toMatchObject({ fleet: { maxAgents: 2, mode: "DEVELOPMENT" }, schema: { version: 15 } });
    await expect(gw.whoami(rid)).rejects.toThrow(/FLEET_OP_REQUEST_INVALID/); // request id bound to its route's function
    await expect(gw.whoami(crypto.randomUUID())).rejects.toThrow(/FLEET_OP_REQUEST_INVALID/);

    expect(await begin({ principalId: `op_${ulid()}`, keyId: c.keyId }, "GET /v1/operator/status")).toEqual({ ok: false, code: "FLEET_OP_AUTH_FAILED" });
    expect(await begin({ principalId: c.principalId, keyId: g.keyId }, "GET /v1/operator/status")).toEqual({ ok: false, code: "FLEET_OP_AUTH_FAILED" });
    expect(await begin(c, "GET /v1/operator/nope")).toEqual({ ok: false, code: "FLEET_OP_NOT_FOUND" });
    expect(await begin(c, "GET /v1/operator/status", { nonce: "bad nonce!" })).toEqual({ ok: false, code: "FLEET_OP_BAD_REQUEST" });
    expect(await begin(lim, "GET /v1/operator/agents")).toEqual({ ok: false, code: "FLEET_OP_SCOPE_DENIED" });
    expect(await begin(g, "GET /v1/operator/events")).toEqual({ ok: false, code: "FLEET_OP_SCOPE_DENIED" });
    expect(await begin(c, "GET /v1/operator/status", { ts: Date.now() - 31_000 })).toEqual({ ok: false, code: "FLEET_OP_STALE" });
    expect(await begin(c, "GET /v1/operator/status", { ts: Date.now() + 31_000 })).toEqual({ ok: false, code: "FLEET_OP_STALE" });

    const nonce = newNonce();
    expect((await begin(c, "GET /v1/operator/status", { nonce })).ok).toBe(true);
    expect(await begin(c, "GET /v1/operator/status", { nonce })).toEqual({ ok: false, code: "FLEET_OP_REPLAYED" });
    const race = newNonce();
    const both = await Promise.all([begin(c, "GET /v1/operator/status", { nonce: race }), begin(c, "GET /v1/operator/status", { nonce: race })]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.filter((r) => !r.ok).map((r) => (r as { code: string }).code)).toEqual(["FLEET_OP_REPLAYED"]);
    const sameNonceOther = await begin(lim, "GET /v1/operator/status", { nonce });
    expect(sameNonceOther.ok).toBe(true); // nonces are namespaced per principal

    // Expired key (inserted directly with a past validity window).
    const ek = keypair();
    const e = await enroll("bridge-expiring", "bridge_claude", ["ops.read.status"]);
    await owner.query(
      `INSERT INTO fleet.fleet_operator_keys (key_id, principal_id, public_key, not_before, expires_at, created_by) VALUES ($1, $2, $3, now() - interval '10 days', now() - interval '1 day', 'x')`,
      [ek.keyId, e.principalId, Buffer.from(ek.publicKey, "base64url")],
    );
    expect(await begin({ principalId: e.principalId, keyId: ek.keyId }, "GET /v1/operator/status")).toEqual({ ok: false, code: "FLEET_OP_AUTH_FAILED" });

    // Revocation takes effect on the very next request, and invalidates outstanding request ids.
    const pending = await begin(c, "GET /v1/operator/agents");
    await opAdmin.revokeKey({ keyId: c.keyId, reason: "test", actor: ACTOR });
    expect(await begin(c, "GET /v1/operator/status")).toEqual({ ok: false, code: "FLEET_OP_AUTH_FAILED" });
    await expect(gw.listAgents((pending as { requestId: string }).requestId, null, 10)).rejects.toThrow(/FLEET_OP_REQUEST_INVALID/);

    const denials = await owner.query(`SELECT count(*)::int AS n FROM fleet.fleet_events WHERE event_type LIKE 'operator_%' AND detail->>'layer' = 'database'`);
    expect(denials.rows[0].n).toBeGreaterThanOrEqual(8);
  });

  it("Amendment 3: an accepted read changes only operator security/audit bookkeeping; a denial only adds an event", async () => {
    const c = await enroll("bridge-invariance", "bridge_claude", ["ops.read.status", "ops.read.agents", "ops.read.events"]);
    await opAdmin.setEnabled({ enabled: true, reason: "test", actor: ACTOR });
    const s0 = await snapshot();
    const st0 = (await owner.query(`SELECT generation, request_count, operator_api_enabled FROM fleet.fleet_operator_state`)).rows[0];
    for (const route of ["GET /v1/operator/status", "GET /v1/operator/agents", "GET /v1/operator/events", "GET /v1/operator/whoami"]) {
      const b = await begin(c, route);
      expect(b.ok, route).toBe(true);
      const rid = (b as { requestId: string }).requestId;
      if (route.endsWith("status")) await gw.fleetStatus(rid);
      if (route.endsWith("agents")) await gw.listAgents(rid, null, 10);
      if (route.endsWith("events")) await gw.listEvents(rid, null, 10, null);
      if (route.endsWith("whoami")) await gw.whoami(rid);
    }
    const s1 = await snapshot();
    expect(changed(s0, s1)).toEqual(["fleet_operator_nonces", "fleet_operator_requests", "fleet_operator_state"]);
    const st1 = (await owner.query(`SELECT generation, request_count, operator_api_enabled FROM fleet.fleet_operator_state`)).rows[0];
    expect(st1).toEqual({ ...st0, request_count: String(Number(st0.request_count) + 4) });
    const d = await begin(c, "GET /v1/operator/status", { ts: Date.now() - 60_000 });
    expect(d.ok).toBe(false);
    expect(changed(s1, await snapshot())).toEqual(["fleet_events"]);
  });

  it("Amendment 1: 50% / 75% warnings, fail closed at 100%, no automatic deletion, audited archival", async () => {
    const c = await enroll("bridge-capacity", "bridge_claude", ["ops.read.status"]);
    await opAdmin.setEnabled({ enabled: true, reason: "test", actor: ACTOR });
    const doctorCheck = async () => {
      const r = await runDoctor({ env: {}, store: admin, fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch, serviceActive: async () => null });
      return r.checks.find((x) => x.name === "operator audit capacity")!;
    };
    await setCounter(999_999);
    expect(await doctorCheck()).toMatchObject({ status: "pass" });
    await setCounter(1_000_000);
    expect(await doctorCheck()).toMatchObject({ status: "warn", detail: expect.stringMatching(/early warning/) });
    await setCounter(1_500_000);
    expect(await doctorCheck()).toMatchObject({ status: "warn", detail: expect.stringMatching(/ELEVATED/) });
    await setCounter(OPERATOR_REQUEST_CAP - 1);
    expect((await begin(c, "GET /v1/operator/status")).ok).toBe(true); // the last permitted request
    const rowsBefore = (await owner.query(`SELECT count(*)::int AS n FROM fleet.fleet_operator_requests`)).rows[0].n;
    expect(await begin(c, "GET /v1/operator/status")).toEqual({ ok: false, code: "FLEET_OP_AUDIT_FULL" });
    expect(await doctorCheck()).toMatchObject({ status: "fail", detail: expect.stringMatching(/FULL/) });
    // Nothing was deleted to make room, and history cannot be removed or rewound outside archival.
    expect((await owner.query(`SELECT count(*)::int AS n FROM fleet.fleet_operator_requests`)).rows[0].n).toBe(rowsBefore);
    expect((await owner.query(`SELECT request_count::int AS n FROM fleet.fleet_operator_state`)).rows[0].n).toBe(OPERATOR_REQUEST_CAP);
    await expect(owner.query(`DELETE FROM fleet.fleet_operator_requests`)).rejects.toThrow(/FLEET_HISTORY_IMMUTABLE/);
    await expect(owner.query(`UPDATE fleet.fleet_operator_requests SET scope = NULL`)).rejects.toThrow(/FLEET_HISTORY_IMMUTABLE/);
    await expect(owner.query(`UPDATE fleet.fleet_operator_state SET request_count = 0`)).rejects.toThrow(/FLEET_HISTORY_IMMUTABLE/);

    await setCounter(0);
  });

  it("archival is owner-only, verified before deletion and fail-closed on every error", async () => {
    const c = await enroll("bridge-archive", "bridge_claude", ["ops.read.status"]);
    const OLD = "now() - interval '2 hours'";
    const addOld = async (n: number, age = OLD) => {
      for (let i = 0; i < n; i++) {
        await owner.query(
          `INSERT INTO fleet.fleet_operator_requests (request_id, principal_id, key_id, route, scope, client_ts, nonce_sha256, body_sha256, received_at)
           VALUES (gen_random_uuid(), $1, $2, 'GET /v1/operator/status', 'ops.read.status', ${age}, $3, $4, ${age})`,
          [c.principalId, c.keyId, crypto.randomBytes(32).toString("hex"), EMPTY_BODY_SHA256],
        );
      }
    };
    const state = async () => {
      const r = await owner.query(
        `SELECT (SELECT count(*)::int FROM fleet.fleet_operator_requests) AS rows,
                (SELECT md5(string_agg(request_id::text, ',' ORDER BY request_id)) FROM fleet.fleet_operator_requests) AS ids,
                (SELECT request_count::int FROM fleet.fleet_operator_state) AS counter,
                (SELECT count(*)::int FROM fleet.fleet_events WHERE event_type = 'operator_requests_archived') AS archivedEvents`,
      );
      return r.rows[0];
    };
    const failedEvents = async () =>
      (await owner.query(`SELECT detail FROM fleet.fleet_events WHERE event_type = 'operator_requests_archive_failed' ORDER BY id`)).rows.map((r) => r.detail);
    const cutoff = () => new Date(Date.now() - 3_600_000);
    await addOld(5);
    await setCounter(40);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "op-archive-"));
    fs.chmodSync(dir, 0o700);
    let seq = 0;
    const out = () => path.join(dir, `archive-${++seq}.jsonl`);
    try {
      // 1. Owner-only: no other fleet role can export, archive, delete or rewind, even with the bypass flag set.
      for (const role of ["fleet_operator", "fleet_service", "fleet_agent"]) {
        for (const fn of [
          "fleet_operator_archive_requests(timestamptz, bigint, text, text)",
          "fleet_operator_archive_export(timestamptz, integer)",
          "fleet_operator_archive_check(timestamptz, bigint)",
        ]) {
          const r = await owner.query(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, `fleet.${fn}`]);
          expect(r.rows[0].ok, `${role} ${fn}`).toBe(false);
        }
        for (const [t, privs] of [["fleet_operator_requests", "DELETE,UPDATE,INSERT,TRUNCATE"], ["fleet_operator_state", "UPDATE,DELETE,TRUNCATE"]] as const) {
          const r = await owner.query(`SELECT has_table_privilege($1, $2, $3) AS ok`, [role, `fleet.${t}`, privs]);
          expect(r.rows[0].ok, `${role} ${t}`).toBe(false);
        }
      }
      const s0 = await state();
      for (const url of [pgc.operatorUrl, pgc.serviceUrl, pgc.agentUrl]) {
        const p = new pg.Pool({ connectionString: url, max: 1 });
        try {
          await expect(p.query(`SELECT fleet.fleet_operator_archive_requests(now() - interval '1 hour', 1, $1, 'operator:x')`, ["a".repeat(64)])).rejects.toThrow(/permission denied/);
          await expect(p.query(`SELECT * FROM fleet.fleet_operator_archive_export(now() - interval '1 hour', 10)`)).rejects.toThrow(/permission denied/);
          const cl = await p.connect();
          try {
            await cl.query("BEGIN");
            await cl.query("SELECT set_config('fleet.operator_archive', 'on', true)");
            await expect(cl.query(`DELETE FROM fleet.fleet_operator_requests`)).rejects.toThrow(/permission denied/);
          } finally {
            await cl.query("ROLLBACK").catch(() => {});
            cl.release();
          }
        } finally {
          await p.end();
        }
      }
      // No automatic deletion: plain DELETE/TRUNCATE by the owner are refused too.
      await expect(owner.query(`DELETE FROM fleet.fleet_operator_requests`)).rejects.toThrow(/FLEET_HISTORY_IMMUTABLE/);
      await expect(owner.query(`TRUNCATE fleet.fleet_operator_requests`)).rejects.toThrow(/FLEET_HISTORY_IMMUTABLE/);
      expect(await state()).toEqual(s0);

      // 2. Direct SQL misuse: every rejection leaves the rows intact.
      const lines = (await owner.query(`SELECT line FROM fleet.fleet_operator_archive_export(now() - interval '1 hour', 100000)`)).rows.map((r) => r.line as string);
      expect(lines).toHaveLength(5);
      const goodSha = crypto.createHash("sha256").update(lines.map((l) => `${l}\n`).join("")).digest("hex");
      const call = (before: string, n: number, sha: string, actor = ACTOR) =>
        owner.query(`SELECT fleet.fleet_operator_archive_requests(${before}, $1, $2, $3)`, [n, sha, actor]);
      const H = "now() - interval '1 hour'";
      await expect(call(H, 5, "b".repeat(64))).rejects.toThrow(/digest does not match/);
      await expect(call(H, 6, goodSha)).rejects.toThrow(/matched 5 rows, export had 6/);
      await expect(call(H, 4, goodSha)).rejects.toThrow(/digest does not match/); // a prefix is a different export
      await expect(call(H, 5, "B".repeat(64))).rejects.toThrow(/export digest required/);
      await expect(call(H, 5, goodSha, "fleet-service")).rejects.toThrow(/FLEET_APPROVAL_REQUIRED/);
      await expect(call(H, 5, goodSha, "op_01J9ZQ3V7X4K2M8N6P5R0S1T2W")).rejects.toThrow(/FLEET_APPROVAL_REQUIRED/);
      await expect(call("now()", 5, goodSha)).rejects.toThrow(/at least one minute in the past/);
      await expect(call(H, 0, goodSha)).rejects.toThrow(/1\.\.100000/);
      await expect(call(H, 100_001, goodSha)).rejects.toThrow(/1\.\.100000/);
      expect(await state()).toEqual(s0);

      // 3. CLI path: filesystem and verification failures leave the rows intact.
      const existing = out();
      fs.writeFileSync(existing, "x", { mode: 0o600 });
      await expect(opAdmin.archive({ before: cutoff(), outFile: existing, actor: ACTOR })).rejects.toThrow(/EEXIST/);
      await expect(opAdmin.archive({ before: cutoff(), outFile: path.join(dir, "missing", "a.jsonl"), actor: ACTOR })).rejects.toThrow(/ENOENT/);
      const loose = fs.mkdtempSync(path.join(dir, "loose-"));
      fs.chmodSync(loose, 0o770);
      await expect(opAdmin.archive({ before: cutoff(), outFile: path.join(loose, "a.jsonl"), actor: ACTOR })).rejects.toThrow(/group\/world-writable/);
      fs.symlinkSync(dir, path.join(dir, "link"));
      await expect(opAdmin.archive({ before: cutoff(), outFile: path.join(dir, "link", "a.jsonl"), actor: ACTOR })).rejects.toThrow(/real directory|symlink/);
      if (process.getuid?.() !== 0) {
        const ro = fs.mkdtempSync(path.join(dir, "ro-"));
        fs.chmodSync(ro, 0o500);
        await expect(opAdmin.archive({ before: cutoff(), outFile: path.join(ro, "a.jsonl"), actor: ACTOR })).rejects.toThrow(/EACCES/);
        fs.chmodSync(ro, 0o700);
      }
      await expect(opAdmin.archive({ before: new Date(Date.now() - 30_000), outFile: out(), actor: ACTOR })).rejects.toThrow(/one minute/);
      await expect(opAdmin.archive({ before: cutoff(), outFile: out(), actor: ACTOR, maxRows: 100_001 })).rejects.toThrow(/max-rows/);
      await expect(opAdmin.archive({ before: cutoff(), outFile: out(), actor: "fleet-service" })).rejects.toThrow(/operator:<user>/);
      expect(await state()).toEqual(s0);
      expect(await failedEvents()).toEqual([]); // nothing was exported, so nothing to record

      // Tampering between export and deletion (incomplete, corrupted, re-permissioned, hard-linked, removed).
      const tamper: Array<[string, (f: string) => void, RegExp]> = [
        ["truncated", (f) => fs.truncateSync(f, fs.statSync(f).size - 10), /size/],
        ["extended", (f) => fs.appendFileSync(f, "{}\n"), /size/],
        ["same-size corruption", (f) => { const b = fs.readFileSync(f); b[5] ^= 1; fs.writeFileSync(f, b); }, /digest mismatch/],
        ["line removed, padded", (f) => { const b = fs.readFileSync(f, "utf8"); const cut = b.indexOf("\n") + 1; fs.writeFileSync(f, b.slice(cut) + " ".repeat(cut)); }, /lines|digest/],
        ["mode 0644", (f) => fs.chmodSync(f, 0o644), /mode/],
        ["hard link", (f) => fs.linkSync(f, `${f}.link`), /hard links/],
        ["removed", (f) => fs.rmSync(f), /ENOENT/],
      ];
      for (const [label, fn, re] of tamper) {
        await expect(opAdmin.archive({ before: cutoff(), outFile: out(), actor: ACTOR, afterExport: fn }), label).rejects.toThrow(re);
        expect(await state(), label).toEqual(s0);
      }
      // A row that appears between export and deletion changes the database digest: nothing is deleted.
      await expect(opAdmin.archive({ before: cutoff(), outFile: out(), actor: ACTOR, afterExport: () => addOld(1, "now() - interval '3 hours'") })).rejects.toThrow(/digest does not match/);
      const s1 = await state();
      expect(s1.rows).toBe(s0.rows + 1);
      expect(s1.counter).toBe(s0.counter);
      expect(s1.archivedEvents).toBe(s0.archivedEvents);
      const failed = await failedEvents();
      expect(failed.map((d) => d.stage)).toEqual([...tamper.map(() => "verify"), "delete"]);
      for (const d of failed) expect(Object.keys(d).sort()).toEqual(["before", "rows", "stage"]);

      // 4. Success: bounded batches, the file is exactly what was deleted, the event carries no row data.
      const ids = new Set((await owner.query(`SELECT request_id FROM fleet.fleet_operator_requests WHERE received_at < now() - interval '1 hour'`)).rows.map((r) => r.request_id as string));
      expect(ids.size).toBe(6);
      const archived = new Set<string>();
      const results = [];
      for (const n of [4, 4]) {
        const f = out();
        const r = await opAdmin.archive({ before: cutoff(), outFile: f, actor: ACTOR, maxRows: n });
        results.push(r);
        expect((fs.statSync(f).mode & 0o777).toString(8)).toBe("600");
        expect(crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")).toBe(r.exportSha256);
        for (const l of fs.readFileSync(f, "utf8").trim().split("\n")) {
          const row = JSON.parse(l);
          expect(Object.keys(row).sort()).toEqual(["bodySha256", "clientTs", "keyId", "nonceSha256", "principalId", "receivedAt", "requestId", "route", "scope"]);
          archived.add(row.requestId);
        }
      }
      expect(results.map((r) => r.archived)).toEqual([4, 2]);
      expect(archived).toEqual(ids);
      expect(await opAdmin.archive({ before: cutoff(), outFile: out(), actor: ACTOR })).toEqual({ archived: 0, exportFile: null, exportSha256: null });
      const s2 = await state();
      expect(s2.rows).toBe(s1.rows - 6);
      expect(s2.counter).toBe(40 - 6);
      const ev = await owner.query(`SELECT actor, detail FROM fleet.fleet_events WHERE event_type = 'operator_requests_archived' ORDER BY id DESC LIMIT 2`);
      expect(ev.rows.map((r) => [r.actor, r.detail.rows, r.detail.remaining])).toEqual([[ACTOR, 2, 0], [ACTOR, 4, 2]]);
      expect(ev.rows[1].detail.exportSha256).toBe(results[0].exportSha256);
      const evText = JSON.stringify(ev.rows);
      for (const id of ids) expect(evText.includes(id)).toBe(false);
      expect(evText.includes(c.principalId)).toBe(false);
      expect(evText.includes(c.keyId)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      await setCounter(0);
    }
  });

  it("expired nonces are purged in bounded batches by accepted requests only", async () => {
    const c = await enroll("bridge-nonces", "bridge_claude", ["ops.read.status"]);
    await opAdmin.setEnabled({ enabled: true, reason: "test", actor: ACTOR });
    await owner.query(
      `INSERT INTO fleet.fleet_operator_nonces (principal_id, nonce_sha256, expires_at)
       SELECT $1, encode(sha256(convert_to(g::text || $2, 'UTF8')), 'hex'), now() - interval '1 hour' FROM generate_series(1, 1500) g`,
      [c.principalId, crypto.randomUUID()],
    );
    const count = async () => (await owner.query(`SELECT count(*)::int AS n FROM fleet.fleet_operator_nonces WHERE expires_at < now()`)).rows[0].n;
    const before = await count();
    expect((await begin(c, "GET /v1/operator/status", { ts: Date.now() - 60_000 })).ok).toBe(false);
    expect(await count()).toBe(before); // denials purge nothing
    expect((await begin(c, "GET /v1/operator/status")).ok).toBe(true);
    const after = await count();
    expect(before - after).toBeGreaterThan(0);
    expect(before - after).toBeLessThanOrEqual(1000);
  });

  it("the operator login's identity is exactly the restricted role (for startup refusal)", async () => {
    const who = await gw.identity();
    expect(who).toMatchObject({ user: "fleet_operator_login", isOwner: false, superuser: false });
    expect(who.memberOf).toEqual(["fleet_operator"]);
    expect((await gw.auditOperator()).problems).toEqual([]);
  });

  it("a key cannot be added to a principal whose revocation commits concurrently (lock, then check)", async () => {
    const p = await enroll("bridge-race", "bridge_claude", ["ops.read.status"]);
    const k2 = keypair();
    const t1 = await owner.connect();
    const t2 = await owner.connect();
    try {
      await t1.query("BEGIN");
      await t1.query(`UPDATE fleet.fleet_operator_principals SET revoked_at = now(), revoked_by = 'operator:test', revoke_reason = 'race' WHERE principal_id = $1`, [p.principalId]);
      await t2.query("BEGIN");
      const insert = t2.query(
        `INSERT INTO fleet.fleet_operator_keys (key_id, principal_id, public_key, expires_at, created_by) VALUES ($1, $2, decode($3, 'base64'), now() + interval '30 days', 'operator:test')`,
        [k2.keyId, p.principalId, Buffer.from(k2.publicKey, "base64url").toString("base64")],
      );
      const settled = insert.then(() => "inserted", (e: Error) => e.message);
      await new Promise((r) => setTimeout(r, 300));
      await t1.query("COMMIT");
      expect(await settled).toMatch(/principal .* is revoked/);
    } finally {
      await t2.query("ROLLBACK").catch(() => {});
      t1.release();
      t2.release();
    }
    expect((await owner.query(`SELECT count(*)::int AS n FROM fleet.fleet_operator_keys WHERE principal_id = $1 AND revoked_at IS NULL AND key_id = $2`, [p.principalId, k2.keyId])).rows[0].n).toBe(0);
  });

  it("database-layer denial events are bounded per minute; the denials themselves always stand", async () => {
    const count = async () => (await owner.query(`SELECT count(*)::int AS n FROM fleet.fleet_events WHERE actor LIKE 'op:%' AND created_at > now() - interval '1 minute'`)).rows[0].n;
    for (let i = 0; i < 90; i++) {
      const r = await gw.beginRequest({ principal: `op_${ulid()}`, key: "0".repeat(32), route: "GET /v1/operator/status", clientTsMs: Date.now(), nonce: newNonce(), bodySha256: EMPTY_BODY_SHA256 });
      expect(r.ok).toBe(false);
    }
    const n = await count();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(60);
  });
});

describe.skipIf(!PG_BIN)("B2 operator roles: not provisioned vs provisioned (own cluster)", () => {
  let pgc: EphemeralPg;
  let su: pg.Pool;
  let store: PgFleetStore;

  const dropOperatorRoles = async () => {
    for (const r of ["fleet_operator_login", "fleet_operator"]) {
      const exists = (await su.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [r])).rowCount;
      if (!exists) continue;
      await su.query(`DROP OWNED BY ${r} CASCADE`);
      await su.query(`DROP ROLE ${r}`);
    }
  };
  const audit = () => store.auditPrivileges();
  const doctor = () =>
    runDoctor({ env: {}, store, fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch, serviceActive: async () => null });

  beforeAll(async () => {
    pgc = await startEphemeralPg(PG_BIN!);
    const u = new URL(pgc.superUrl);
    u.pathname = `/${pgc.dbname}`;
    su = new pg.Pool({ connectionString: u.toString(), max: 2 }); // superuser, in the fleet database
    store = new PgFleetStore({ connectionString: pgc.ownerUrl });
    await dropOperatorRoles(); // the production state before B2-9: v8 schema, no operator roles
    await store.migrate();
    await store.setApprovedRuntime(PIN, "test", BUILD);
  }, 90_000);

  afterAll(async () => {
    await store?.close();
    await su?.end();
    pgc?.stop();
  });

  it("neither role exists: a valid not-provisioned state across audit, doctor and the 16-item checklist", async () => {
    const a = await audit();
    expect(a.problems).toEqual([]);
    expect(a.ok).toBe(true);
    expect(a.operatorRoles).toBe("not_provisioned");
    expect(a.roles.filter((r) => r.kind === "operator").map((r) => [r.role, r.exists])).toEqual([["fleet_operator", false], ["fleet_operator_login", false]]);
    // Agent/service checks are unchanged and still run.
    expect(a.roles.filter((r) => (r.kind === "agent" || r.kind === "service") && r.exists).map((r) => r.role).sort()).toEqual(["fleet_agent", "fleet_agent_login", "fleet_service", "fleet_service_login"]);
    const d = await doctor();
    expect(d.checks.find((c) => c.name === "database privileges")).toMatchObject({ status: "pass", detail: expect.stringMatching(/operator roles: not provisioned/) });
    expect(d.checklist.find((c) => c.item === "PostgreSQL roles correct")).toMatchObject({ ok: true, detail: expect.stringMatching(/operator roles: not provisioned/) });
    // The Operator API's own self-check still demands its roles.
    const strict = await store.auditPrivileges({ requireOperatorRoles: true });
    expect(strict.ok).toBe(false);
    expect(strict.operatorRoles).toBe("incomplete");
    expect(strict.problems.join("\n")).toMatch(/role fleet_operator does not exist/);
    // The operator function surface is still audited while the roles are absent.
    const c = await su.connect();
    try {
      await c.query("BEGIN");
      await c.query(`ALTER FUNCTION fleet.op_fleet_status(uuid) VOLATILE`);
      const { auditPrivileges } = await import("../../fleet/postgres/privileges.js");
      expect((await auditPrivileges(c, { schema: "fleet" })).problems.join("\n")).toMatch(/op_fleet_status is volatile/);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("only fleet_operator exists: FAIL", async () => {
    await su.query(`CREATE ROLE fleet_operator NOLOGIN`);
    try {
      const a = await audit();
      expect(a.ok).toBe(false);
      expect(a.operatorRoles).toBe("incomplete");
      expect(a.problems).toContain("role fleet_operator_login does not exist (run scripts/fleet-db-roles.sql)");
      expect((await doctor()).checklist.find((c) => c.item === "PostgreSQL roles correct")?.ok).toBe(false);
    } finally {
      await dropOperatorRoles();
    }
  });

  it("only fleet_operator_login exists: FAIL", async () => {
    await su.query(`CREATE ROLE fleet_operator_login LOGIN`);
    try {
      const a = await audit();
      expect(a.ok).toBe(false);
      expect(a.operatorRoles).toBe("incomplete");
      expect(a.problems).toContain("role fleet_operator does not exist (run scripts/fleet-db-roles.sql)");
    } finally {
      await dropOperatorRoles();
    }
  });

  it("both exist and are correct: PASS (provisioned); wrong privileges or attributes: FAIL", async () => {
    pgc.applyRoles();
    await store.migrate(); // grants the operator surface now that the role exists
    const ok = await audit();
    expect(ok.problems).toEqual([]);
    expect(ok.operatorRoles).toBe("provisioned");
    expect((await doctor()).checks.find((c) => c.name === "database privileges")?.detail).toMatch(/agent\/service\/operator roles least-privilege/);

    await su.query(`GRANT EXECUTE ON FUNCTION fleet.svc_mark_dead(text, text, text, text) TO fleet_operator`);
    expect((await audit()).problems.join("\n")).toMatch(/fleet_operator can EXECUTE fleet\.svc_mark_dead/);
    await su.query(`REVOKE EXECUTE ON FUNCTION fleet.svc_mark_dead(text, text, text, text) FROM fleet_operator`);

    await su.query(`ALTER ROLE fleet_operator_login CREATEROLE`);
    expect((await audit()).problems.join("\n")).toMatch(/fleet_operator_login can create roles/);
    await su.query(`ALTER ROLE fleet_operator_login NOCREATEROLE`);

    await su.query(`GRANT SELECT ON fleet.fleet_operator_requests TO fleet_operator`);
    expect((await audit()).ok).toBe(false);
    await su.query(`REVOKE SELECT ON fleet.fleet_operator_requests FROM fleet_operator`);

    await su.query(`GRANT fleet_service TO fleet_operator_login`);
    expect((await audit()).problems.join("\n")).toMatch(/fleet_operator_login is a member of fleet_service/);
    await su.query(`REVOKE fleet_service FROM fleet_operator_login`);

    expect((await audit()).ok).toBe(true);
  });
});
