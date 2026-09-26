# 03 — Database and Migrations (Master Key, PART 4)

Reconstruction-grade description of the Automaton Fleet PostgreSQL data model (schema v8) and of the
separate local SQLite fleet registry. Source of truth: the repository at `fleet-development`
HEAD `efad214` (the migration SQL is unchanged since `5a5469e`, which is also contained in the
production runtime commit `4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790`).

Files analysed:

| File | Role |
|---|---|
| `src/fleet/postgres/migrations.ts` | runner (`migrate`, `migrateCheck`), constants, V1–V3 SQL, `PG_MIGRATIONS`, role allow-lists |
| `src/fleet/postgres/migrations-phase5.ts` | V4 SQL (`v4Sql(hardMax)`), V5 SQL (`V5_SQL`) |
| `src/fleet/postgres/migrations-phase6.ts` | V6 SQL (`V6_SQL`) |
| `src/fleet/postgres/migrations-phase7.ts` | V7 SQL (`v7Sql(hardMax)`), `WITNESS_API_ACTIONS` |
| `src/fleet/postgres/migrations-phase8.ts` | V8 SQL (`V8_SQL`), `OPERATOR_REQUEST_CAP` |
| `src/fleet/postgres/privileges.ts` | effective privilege audit + operator-surface verifier |
| `src/fleet/postgres/store.ts` | `PgFleetStore` (owner credential): migrate wrapper, role grants, direct owner writes |
| `src/fleet/postgres/agent-gateway.ts` | `PgAgentGateway` (restricted agent login): `api_*` calls, `selfCheck()` |
| `src/fleet/postgres/cli.ts` | `fleet:migrate`, `fleet:migrate-check`, `fleet:audit-privileges` entry points |
| `src/fleet/treasury/store.ts` | `PgTreasuryStore` (owner credential): treasury table writes |
| `scripts/fleet-db-roles.sql` | superuser role bootstrap (roles, attributes, connection limits, timeouts, DB ACL) |
| `scripts/fleet-db-setup.sh` | root wrapper that feeds passwords to `fleet-db-roles.sql` on stdin |
| `src/fleet/registry.ts`, `src/state/schema.ts` | local SQLite fleet registry (Phase 1) |

Conventions in this document:

- `@@SCHEMA@@` is kept exactly as in the source; at run time it is replaced by the **quoted** schema
  identifier (default `"fleet"`), see §1.4.
- TypeScript interpolations (`${…}`) are kept exactly as in the source; their resolved values are
  given in a table before each SQL block.
- "pinned" = the function has `SET search_path = @@SCHEMA@@, pg_temp` (resolves to
  `search_path="fleet", pg_temp`).
- "owner" = the role that ran `fleet:migrate` and owns schema `fleet` (production: `fleetadmin`).
- Line numbers are 1-based and refer to HEAD `efad214`.

---

## 1. Migration framework

### 1.1 Constants (`src/fleet/postgres/migrations.ts`)

| Constant | Value | Line | Meaning |
|---|---|---|---|
| `FLEET_PG_SCHEMA_VERSION` | `8` | `migrations.ts:20` | the only schema version the stores accept (`store.ts:476-480`, `store.ts:638-646`) |
| `FLEET_PG_HARD_MAX_AGENTS` | `50` | `migrations.ts:21` | hard ceiling interpolated into V1, V4 (`hardMax`), V7 (`hardMax`) |
| `MIGRATION_LOCK_KEY` | `0x464c4545` = decimal `1179403589` (ASCII "FLEE") | `migrations.ts:22` | key of `pg_advisory_xact_lock` |
| `OPERATOR_REQUEST_CAP` | `2_000_000` (= `2000000`) | `migrations-phase8.ts:31` | interpolated into V8 (`fleet_operator_state.request_cap`) |
| `WITNESS_API_ACTIONS` | `["open_session","heartbeat","whoami"]` | `migrations-phase7.ts:26` | TS mirror of the V7 allow-list hard-coded in `fleet_authenticate` |
| `DEFAULT_FLEET_PG_SCHEMA` | `"fleet"` | `store.ts:68` | default schema (override `FLEET_PG_SCHEMA`) |

### 1.2 Registered versions (`PG_MIGRATIONS`, `migrations.ts:1114-1123`)

`PG_MIGRATIONS` is a frozen array; `migrate()` iterates it in array order.

```ts
export const PG_MIGRATIONS: readonly PgMigration[] = Object.freeze([
  { version: 1, name: "shared_fleet_registry", sql: V1 },
  { version: 2, name: "leases_heartbeat_expiry_restricted_api", sql: V2 },
  { version: 3, name: "service_role_runtime_immutability_terminations", sql: V3 },
  { version: 4, name: "lifecycle_health_sessions_provisioning_orphans_custody", sql: v4Sql(FLEET_PG_HARD_MAX_AGENTS) },
  { version: 5, name: "treasury_economics", sql: V5_SQL },
  { version: 6, name: "provisioning_intents_dry_run_child", sql: V6_SQL },
  { version: 7, name: "capability_scope_witness", sql: v7Sql(FLEET_PG_HARD_MAX_AGENTS) },
  { version: 8, name: "operator_api_read_only", sql: V8_SQL },
]);
```

| Version | Name (stored in `fleet_schema_migrations.name`) | SQL source | Source line range (template literal incl. delimiters) | First commit |
|---|---|---|---|---|
| 1 | `shared_fleet_registry` | `V1` | `migrations.ts:30-210` | `d6302c3` (Phase 2) |
| 2 | `leases_heartbeat_expiry_restricted_api` | `V2` | `migrations.ts:227-746` | `443f035` (Phase 3) |
| 3 | `service_role_runtime_immutability_terminations` | `V3` | `migrations.ts:762-1112` | `e5ac7fe` (Phase 4) |
| 4 | `lifecycle_health_sessions_provisioning_orphans_custody` | `v4Sql(50)` | `migrations-phase5.ts:26-885` | `e5ac7fe` |
| 5 | `treasury_economics` | `V5_SQL` | `migrations-phase5.ts:887-1209` | `e5ac7fe` |
| 6 | `provisioning_intents_dry_run_child` | `V6_SQL` | `migrations-phase6.ts:30-428` | `2d6d4cf` |
| 7 | `capability_scope_witness` | `v7Sql(50)` | `migrations-phase7.ts:28-241` | `cdfd70c` |
| 8 | `operator_api_read_only` | `V8_SQL` | `migrations-phase8.ts:33-532` | `5a5469e` |

### 1.3 The runner: `migrate(client, schema)` (`migrations.ts:1217-1253`)

```ts
export function quoteIdent(ident: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(ident)) {
    throw new Error(`Invalid fleet schema name: ${ident}`);
  }
  return `"${ident}"`;
}

/** Apply pending migrations. Safe to call concurrently. Returns versions applied. */
export async function migrate(client: PoolClient, schema: string): Promise<number[]> {
  const s = quoteIdent(schema);
  const applied: number[] = [];
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${s}.fleet_schema_migrations (
         version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }

  for (const m of PG_MIGRATIONS) {
    await client.query("BEGIN");
    try {
      await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
      const done = await client.query(`SELECT 1 FROM ${s}.fleet_schema_migrations WHERE version = $1`, [m.version]);
      if (done.rowCount === 0) {
        await client.query(`SET LOCAL search_path TO ${s}`);
        await client.query(m.sql.replaceAll("@@SCHEMA@@", s));
        await client.query(`INSERT INTO ${s}.fleet_schema_migrations (version, name) VALUES ($1, $2)`, [m.version, m.name]);
        applied.push(m.version);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  }
  return applied;
}
```

Exact behaviour:

1. `quoteIdent(schema)` (`migrations.ts:1210-1215`) accepts only `^[a-z_][a-z0-9_]{0,62}$` and returns
   `"<schema>"`; anything else throws `Invalid fleet schema name: <ident>`. There is no other
   escaping; the regex is what makes the string interpolation safe.
2. **Bootstrap transaction:** `BEGIN` → `SELECT pg_advisory_xact_lock(1179403589)` →
   `CREATE SCHEMA IF NOT EXISTS "fleet"` → `CREATE TABLE IF NOT EXISTS "fleet".fleet_schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())` → `COMMIT`.
   On error: `ROLLBACK` (errors of the rollback itself ignored) and rethrow.
3. **One transaction per version**, in `PG_MIGRATIONS` order:
   `BEGIN` → `pg_advisory_xact_lock(1179403589)` → `SELECT 1 FROM "fleet".fleet_schema_migrations WHERE version = $1`.
   If the row is absent: `SET LOCAL search_path TO "fleet"` → execute the whole migration SQL as
   ONE simple-query string after `m.sql.replaceAll("@@SCHEMA@@", s)` (with `s = '"fleet"'`) →
   `INSERT INTO "fleet".fleet_schema_migrations (version, name) VALUES ($1, $2)` → record version in
   the returned array. Then `COMMIT` (also when nothing was applied). Any error → `ROLLBACK`, rethrow;
   later versions are not attempted.
4. Returns the list of versions applied in this call (empty = "Schema up to date.").

Properties:

- **Serialisation:** the advisory lock is transaction-scoped (`_xact_`), taken again in every
  transaction, so concurrent migrators serialise per version; the version check runs *after* the
  lock, so a second migrator sees the first one's committed row and skips (idempotent).
- **Atomicity:** each version is all-or-nothing (DDL is transactional in PostgreSQL).
- **Idempotency:** only by the `fleet_schema_migrations` row. The migration SQL itself is **not**
  re-runnable (`CREATE TABLE`, `CREATE FUNCTION`, `CREATE TRIGGER`, `INSERT INTO fleet_state (id) VALUES (1)` are not `IF NOT EXISTS`); re-running a version's SQL by hand fails.
- **No down-migrations** exist. Rollback of a version = restore a pre-migration dump (runbook: "v7
  requires restoring the pre-v8 dump").
- **Unqualified object names.** Every object in the SQL is created unqualified and therefore lands
  in the first schema of `search_path`, i.e. `"fleet"` (step 3 `SET LOCAL`).
- **Simple-query protocol:** `client.query(sql)` with no parameters sends the text via the simple
  query protocol, which permits many statements per call; this is why each version is one string.

### 1.4 `@@SCHEMA@@` substitution and `search_path` pinning

- `@@SCHEMA@@` occurs only inside `SET search_path = @@SCHEMA@@, pg_temp` clauses of `CREATE FUNCTION`
  and in the `REVOKE … IN SCHEMA @@SCHEMA@@ FROM PUBLIC` statements at the end of V2–V8.
  Replacement is textual (`String.prototype.replaceAll`) with the quoted identifier, e.g.
  `SET search_path = "fleet", pg_temp`.
- Three search-path styles exist in the final schema:

| Style | Effect | Functions (final definition) |
|---|---|---|
| `SET search_path = @@SCHEMA@@, pg_temp` | pinned: fleet schema first, `pg_temp` explicitly last (so temporary objects can never shadow fleet objects) | every `api_*`, `svc_*`, `op_*` and almost every helper/trigger function (full list §3.4) |
| `SET search_path FROM CURRENT` | captures the session value at CREATE time, which inside `migrate` is the `SET LOCAL search_path TO "fleet"` value; `pg_temp` is **not** listed, so for relation lookups PostgreSQL searches `pg_temp` implicitly first | only `fleet_reservations_guard()` (V2, never replaced). V1's `fleet_agents_counters` and V1/V2's `fleet_agents_transition_guard` used it too but were replaced by pinned versions in V4 |
| none | runs with the caller's search_path | `fleet_bucket`, `fleet_history_immutable`, `fleet_state_counter_guard`, `fleet_scrub`, `fleet_state_json`, `fleet_agent_json`, `fleet_agents_lifecycle_stamps`, `fleet_provisioning_key_immutable` — none is executable by a restricted role; they are reached only from pinned SECURITY DEFINER code or as triggers |

- Store connections additionally set the session search_path: `PgFleetStore` pool option
  `-c search_path=<schema> -c lock_timeout=<5000> -c statement_timeout=<10000> -c idle_in_transaction_session_timeout=<30000>` (`store.ts:426`);
  `PgTreasuryStore` `-c search_path=<schema> -c lock_timeout=5000 -c statement_timeout=15000` (`treasury/store.ts:85`);
  `PgAgentGateway` sets **no** search_path and schema-qualifies every call (`SELECT "fleet".api_x(...)`, `agent-gateway.ts:109-113`).

### 1.5 `migrateCheck(client, schema)` (`migrations.ts:1255-1289`)

```ts
/**
 * Transactional verification of the pending migrations: applies every
 * pending version inside ONE transaction, reads the resulting schema
 * version, then ROLLS BACK. Nothing changes; a failing migration surfaces
 * here before `migrate` touches the database.
 */
export async function migrateCheck(
  client: PoolClient,
  schema: string,
): Promise<{ currentVersion: number | null; resultingVersion: number; wouldApply: number[] }> {
  const s = quoteIdent(schema);
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${s}.fleet_schema_migrations (
         version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const cur = await client.query<{ v: number | null }>(`SELECT max(version) AS v FROM ${s}.fleet_schema_migrations`);
    const wouldApply: number[] = [];
    for (const m of PG_MIGRATIONS) {
      const done = await client.query(`SELECT 1 FROM ${s}.fleet_schema_migrations WHERE version = $1`, [m.version]);
      if (done.rowCount) continue;
      await client.query(`SET LOCAL search_path TO ${s}`);
      await client.query(m.sql.replaceAll("@@SCHEMA@@", s));
      await client.query(`INSERT INTO ${s}.fleet_schema_migrations (version, name) VALUES ($1, $2)`, [m.version, m.name]);
      wouldApply.push(m.version);
    }
    const after = await client.query<{ v: number }>(`SELECT max(version) AS v FROM ${s}.fleet_schema_migrations`);
    return { currentVersion: cur.rows[0].v, resultingVersion: after.rows[0].v, wouldApply };
  } finally {
    await client.query("ROLLBACK").catch(() => {});
  }
}
```

- ONE transaction: advisory lock → create schema/table if missing → `currentVersion = max(version)`
  → apply **every** pending version in order inside the same transaction (same substitution and
  `SET LOCAL search_path`) → `resultingVersion = max(version)` → **always `ROLLBACK`** (in `finally`).
- Grants are **not** exercised (they are outside `migrateCheck`).
- CLI: `pnpm fleet:migrate-check` → `cli.ts migrate-check` (`package.json:54`) prints
  `{"currentVersion":…, "resultingVersion":…, "wouldApply":[…], "requiredVersion":8, "rolledBack":true}`
  and exits `0` iff `resultingVersion === 8`, else `1` (`cli.ts:383-387`).
- Both `PgFleetStore.migrate()` and `.migrateCheck()` first run `assertAdminConnection()`.

### 1.6 Admin-credential gate (`store.ts:588-605`)

```sql
SELECT current_user AS u,
       (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = $1) AS owner,
       has_database_privilege(current_database(), 'CREATE') AS can_create
```

- Schema exists → allowed only if `current_user = schema owner` (a superuser that is not the owner
  is refused).
- Schema absent → allowed only if the role has `CREATE` on the database.
- Otherwise: `Refusing to migrate as <user>: administrative migrations require the privileged admin credential (FLEET_ADMIN_DATABASE_URL; owner of schema <schema>).`
- The admin store comes from `FLEET_ADMIN_DATABASE_URL`, falling back to the legacy
  `FLEET_CONTROLLER_DATABASE_URL` / `DATABASE_URL` (`store.ts:437-449`); the CLI reads it from the
  environment, else `/etc/automaton-fleet/admin.env` (`cli.ts` header).

### 1.7 `PgFleetStore.migrate()` and role grant re-application (`store.ts:558-576`, `766-833`)

```ts
  async migrate(): Promise<number[]> {
    const client = await this.connect();
    let applied: number[];
    try {
      await this.assertAdminConnection(client);
      applied = await migrate(client, this.schema);
    } finally {
      client.release();
    }
    const roles = await this.pool
      .query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname = ANY($1)", [[this.agentRole, this.serviceRole, this.operatorRole]])
      .catch(() => null);
    const present = new Set(roles?.rows.map((r) => r.rolname) ?? []);
    if (present.has(this.agentRole)) await this.grantAgentRole(this.agentRole);
    if (present.has(this.serviceRole)) await this.grantServiceRole(this.serviceRole);
    if (present.has(this.operatorRole)) await this.grantOperatorRole(this.operatorRole);
    return applied;
  }

```

After `migrate()` returns (all versions committed), the store looks up which of the three
configured group roles exist (`FLEET_AGENT_ROLE` default `fleet_agent`, `FLEET_SERVICE_ROLE` default
`fleet_service`, `FLEET_OPERATOR_ROLE` default `fleet_operator`) and, **for each one that exists**,
re-applies its grant set — every run, whether or not a migration was applied. A missing role is
silently skipped (the privilege audit then reports it). The role lookup errors are swallowed
(`.catch(() => null)` → no grants).

Each grant runs in its **own** `tx()` (READ COMMITTED, **without** the migration advisory lock):

```ts

  /**
   * Operator-only: give `role` exactly the restricted agent API — USAGE on
   * the schema and EXECUTE on api_* functions; nothing on tables, sequences
   * or internal functions. Re-running is harmless.
   */
  async grantAgentRole(role: string = this.agentRole): Promise<void> {
    const r = quoteIdent(role);
    const s = quoteIdent(this.schema);
    await this.tx(async (c) => {
      const exists = await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
      if (!exists.rowCount) throw new Error(`Role ${role} does not exist (create it with scripts/fleet-db-roles.sql).`);
      await c.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${s} FROM PUBLIC, ${r}`);
      await c.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${s} FROM PUBLIC, ${r}`);
      await c.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${s} FROM PUBLIC, ${r}`);
      await c.query(`REVOKE ALL ON SCHEMA ${s} FROM PUBLIC, ${r}`);
      await c.query(`GRANT USAGE ON SCHEMA ${s} TO ${r}`);
      for (const fn of AGENT_API_FUNCTIONS) await c.query(`GRANT EXECUTE ON FUNCTION ${s}.${fn} TO ${r}`);
      await this.event(c, "agent_role_granted", null, "operator", { role, functions: [...AGENT_API_FUNCTIONS] });
    });
  }

  /**
   * Operator-only: give `role` exactly the controller API — USAGE on the
   * schema, SELECT on the non-secret tables and EXECUTE on svc_* functions.
   * No INSERT/UPDATE/DELETE, no credential hashes, no internal functions.
   */
  async grantServiceRole(role: string = this.serviceRole): Promise<void> {
    const r = quoteIdent(role);
    const s = quoteIdent(this.schema);
    await this.tx(async (c) => {
      const exists = await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
      if (!exists.rowCount) throw new Error(`Role ${role} does not exist (create it with scripts/fleet-db-roles.sql).`);
      await c.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${s} FROM ${r}`);
      await c.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${s} FROM ${r}`);
      await c.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${s} FROM ${r}`);
      await c.query(`REVOKE ALL ON SCHEMA ${s} FROM ${r}`);
      await c.query(`GRANT USAGE ON SCHEMA ${s} TO ${r}`);
      for (const t of SERVICE_READ_TABLES) await c.query(`GRANT SELECT ON ${s}.${quoteIdent(t)} TO ${r}`);
      for (const fn of SERVICE_API_FUNCTIONS) await c.query(`GRANT EXECUTE ON FUNCTION ${s}.${fn} TO ${r}`);
      await this.event(c, "service_role_granted", null, "operator", {
        role,
        tables: [...SERVICE_READ_TABLES],
        functions: [...SERVICE_API_FUNCTIONS],
      });
    });
  }

  /**
   * Operator-only (schema v8): give `role` exactly the read-only Operator API —
   * USAGE on the schema and EXECUTE on OPERATOR_API_FUNCTIONS. No table,
   * sequence or other function privilege. Re-running is harmless.
   */
  async grantOperatorRole(role: string = this.operatorRole): Promise<void> {
    const r = quoteIdent(role);
    const s = quoteIdent(this.schema);
    await this.tx(async (c) => {
      const exists = await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
      if (!exists.rowCount) throw new Error(`Role ${role} does not exist (create it with scripts/fleet-db-roles.sql).`);
      await c.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${s} FROM PUBLIC, ${r}`);
      await c.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${s} FROM PUBLIC, ${r}`);
      await c.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${s} FROM PUBLIC, ${r}`);
      await c.query(`REVOKE ALL ON SCHEMA ${s} FROM PUBLIC, ${r}`);
      await c.query(`GRANT USAGE ON SCHEMA ${s} TO ${r}`);
      for (const fn of OPERATOR_API_FUNCTIONS) await c.query(`GRANT EXECUTE ON FUNCTION ${s}.${fn} TO ${r}`);
      await this.event(c, "operator_role_granted", null, "operator", { role, functions: [...OPERATOR_API_FUNCTIONS] });
    });
  }
```

| Step | `grantAgentRole(fleet_agent)` | `grantServiceRole(fleet_service)` | `grantOperatorRole(fleet_operator)` |
|---|---|---|---|
| existence check | `SELECT 1 FROM pg_roles WHERE rolname=$1`, else throw `Role <r> does not exist (create it with scripts/fleet-db-roles.sql).` | same | same |
| `REVOKE ALL ON ALL TABLES IN SCHEMA` | `FROM PUBLIC, "fleet_agent"` | `FROM "fleet_service"` (PUBLIC not named) | `FROM PUBLIC, "fleet_operator"` |
| `REVOKE ALL ON ALL SEQUENCES IN SCHEMA` | `FROM PUBLIC, role` | `FROM role` | `FROM PUBLIC, role` |
| `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA` | `FROM PUBLIC, role` | `FROM role` | `FROM PUBLIC, role` |
| `REVOKE ALL ON SCHEMA` | `FROM PUBLIC, role` | `FROM role` | `FROM PUBLIC, role` |
| `GRANT USAGE ON SCHEMA "fleet"` | yes | yes | yes |
| table grants | none | `GRANT SELECT ON "fleet"."<t>"` for the 10 `SERVICE_READ_TABLES` | none |
| function grants | `GRANT EXECUTE ON FUNCTION "fleet".<sig>` for the 10 `AGENT_API_FUNCTIONS` | for the 16 `SERVICE_API_FUNCTIONS` | for the 8 `OPERATOR_API_FUNCTIONS` |
| audit event (direct `INSERT INTO fleet_events`) | `event_type='agent_role_granted'`, `agent_id NULL`, `actor='operator'`, `detail={"role":<role>,"functions":[…10]}` | `event_type='service_role_granted'`, `actor='operator'`, `detail={"role","tables":[…10],"functions":[…16]}` | `event_type='operator_role_granted'`, `actor='operator'`, `detail={"role","functions":[…8]}` |

Because the revoke-then-grant is inside one transaction, the role never observably loses its
grants. The grant targets are the **group** roles; the `*_login` roles receive the privileges by
`INHERIT` membership (§3.6). The CLI can re-run each grant alone: `fleet:admin grant-agent-role [role]`,
`grant-service-role [role]`, `grant-operator-role [role]` (`cli.ts:531-545`).

### 1.8 Known issue: concurrent migration REVOKE race (FLEET-KI-1)

`docs/fleet-known-issues.md:6-21`: two concurrent `migrate()` calls can fail with
`error: tuple concurrently updated` at `REVOKE ALL ON ALL TABLES IN SCHEMA … FROM PUBLIC` in
`grantAgentRole`. Cause confirmed by the code above: the version loop is serialised by
`pg_advisory_xact_lock(1179403589)`, but the **grant step runs after it in separate transactions
that take no advisory lock**, and PostgreSQL does not serialise concurrent GRANT/REVOKE rewriting the
same `pg_class.relacl` / `pg_namespace.nspacl` rows. Status: open, pre-existing since `2d6d4cf`;
reproduced by `src/__tests__/fleet/fleet-phase2.test.ts` "migrations are idempotent and safe to run
concurrently"; FLEET-KI-2 (test wipe deadlock) likely cascades from it. Production impact: none as
long as `pnpm fleet:migrate` is run once by hand. Documented fix direction (not implemented): hold one
advisory lock across migrations and grants, or skip re-granting when the ACL already matches.

The migration SQL itself also contains `REVOKE … FROM PUBLIC` statements (end of V2–V8); those run
inside the advisory-locked transaction and are not part of the race.

DRIFT: `FLEET.md:194` says "Each version runs in its own transaction under `pg_advisory_xact_lock`, so
concurrent runs are safe." The code makes the *versions* safe but not the grant step (FLEET-KI-1).

### 1.9 How the running system checks the schema

- `PgFleetStore.ensureSchema()` (`store.ts:467-482`): on first use of a pool, `SELECT max(version) FROM fleet_schema_migrations`; missing table → `FLEET_REGISTRY_UNAVAILABLE` "Fleet registry schema missing (run fleet:migrate)"; version ≠ 8 → "Fleet registry schema version <v> != required 8." (fail closed).
- `PgFleetStore.health()` (`store.ts:626-667`) additionally recomputes the counters:

```sql
SELECT s.living_agents = (SELECT count(*) FROM fleet_agents WHERE status IN ('active','unresponsive','terminating'))
   AND s.reserved_slots = (SELECT count(*) FROM fleet_agents WHERE status IN ('reserved','provisioning'))
   AND s.quarantined_slots = (SELECT count(*) FROM fleet_agents WHERE status = 'orphaned')
   AS consistent
  FROM fleet_state s WHERE s.id = 1
```

  `ok` only if consistent; `pnpm fleet:migrate` prints this health JSON after migrating (`cli.ts:440-445`).
- `op_ping()` (V8) returns `schemaVersion = max(version)` to the Operator API.


---

## 2. Migrations v1 – v8

Each subsection: purpose, objects (tables with every column/constraint, indexes, triggers,
functions), grants, then the **exact SQL** as it appears in the TypeScript template literal.
The consolidated final state is in §3.

Unnamed constraints receive PostgreSQL's automatic names (`<table>_<column>_check`,
`<table>_check`, `<table>_check1`, …, `<table>_pkey`, `<table>_<column>_key`, `<table>_<column>_fkey`).
The code relies on one of them: V2 and V4 `DROP CONSTRAINT fleet_agents_status_check`, the automatic
name of V1's column CHECK on `fleet_agents.status`.

### 2.1 Version 1 — `shared_fleet_registry`

- **Source:** `src/fleet/postgres/migrations.ts:30-210` (`const V1`). Commit `d6302c3`.
- **Purpose:** the shared, fleet-wide agent registry (Phase 2): one-row fleet state with the cap,
  the agent table, the append-only event log, trigger-maintained counters that enforce the cap at
  row level, forward-only lifecycle, and history immutability.
- **Interpolations:**

| Expression | Line | Resolved |
|---|---|---|
| `${FLEET_PG_HARD_MAX_AGENTS}` (max_agents CHECK) | 35 | `50` |
| `${FLEET_PG_HARD_MAX_AGENTS}` (population CHECK) | 41 | `50` |

#### Table `fleet_state` (V1 columns)

| Column | Type | Default | NOT NULL | Constraint |
|---|---|---|---|---|
| `id` | smallint | `1` | (PK) | PRIMARY KEY; `CHECK (id = 1)` → single row |
| `living_agents` | integer | `0` | yes | `CHECK (living_agents >= 0)` |
| `reserved_slots` | integer | `0` | yes | `CHECK (reserved_slots >= 0)` |
| `max_agents` | integer | `1` | yes | `CHECK (max_agents BETWEEN 1 AND 50)` |
| `operating_mode` | text | `'DEVELOPMENT'` | yes | `CHECK (operating_mode IN ('DEVELOPMENT','EXPANSION','HARVEST','EMERGENCY'))` |
| `runtime_repo` | text | — | no | — |
| `runtime_commit` | text | — | no | `CHECK (runtime_commit ~ '^[0-9a-f]{40}$')` |
| `updated_at` | timestamptz | `now()` | yes | — |

Table constraints: `CHECK (living_agents + reserved_slots <= 50)`; `CHECK ((runtime_repo IS NULL) = (runtime_commit IS NULL))`.
Seed row: `INSERT INTO fleet_state (id) VALUES (1)` (mode DEVELOPMENT, cap 1, no runtime).

#### Table `fleet_agents` (V1 columns)

| Column | Type | Default | NOT NULL | Constraint |
|---|---|---|---|---|
| `agent_id` | text | — | (PK) | PRIMARY KEY; `CHECK (agent_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$')` (Crockford ULID) |
| `parent_agent_id` | text | — | no | FK → `fleet_agents(agent_id)` (NO ACTION) |
| `role` | text | — | yes | `CHECK (role IN ('root','child'))` |
| `generation` | integer | — | yes | `CHECK (generation >= 0)` |
| `name` | text | — | yes | `CHECK (length(name) BETWEEN 1 AND 128)` |
| `wallet_address` | text | — | no | `CHECK (wallet_address ~ '^(0x[0-9a-fA-F]{40}\|[1-9A-HJ-NP-Za-km-z]{32,44})$')` (EVM or base58 public address; a 64-hex private key cannot match) |
| `runtime_version` | text | — | no | `CHECK (length(runtime_version) <= 64)` |
| `runtime_repo` | text | — | no | — |
| `runtime_commit` | text | — | no | `CHECK (runtime_commit ~ '^[0-9a-f]{40}$')` |
| `sandbox_id` | text | — | no | — |
| `local_child_id` | text | — | no | — |
| `status` | text | — | yes | `fleet_agents_status_check`: V1 `IN ('reserved','provisioning','active','dead','failed')` (widened in V2, V4) |
| `status_reason` | text | — | no | — |
| `requested_by` | text | — | no | — |
| `request_key` | text | — | no | UNIQUE (`fleet_agents_request_key_key`) |
| `created_at` | timestamptz | `now()` | yes | — |
| `updated_at` | timestamptz | `now()` | yes | — |
| `last_heartbeat` | timestamptz | — | no | — |
| `reservation_expires_at` | timestamptz | — | no | — |
| `death_time` | timestamptz | — | no | — |

(In the regex above `\|` is the Markdown escape of `|`.) Table constraints (lifecycle/identity):

1. `CHECK ((status IN ('dead','failed')) = (death_time IS NOT NULL))` — terminal ⇔ death time.
2. `CHECK ((role = 'root') = (parent_agent_id IS NULL))` — roots have no parent, children have one.
3. `CHECK (role = 'child' OR generation = 0)` — roots are generation 0.
4. `CHECK (role = 'root' OR generation >= 1)`.
5. `CHECK (status NOT IN ('reserved','provisioning') OR role = 'child')` — roots never reserved/provisioning.
6. `CHECK (status <> 'active' OR wallet_address IS NOT NULL)`.
7. `CHECK (role = 'root' OR runtime_commit IS NOT NULL)` — every child is pinned.

Indexes: `fleet_agents_wallet_uq` UNIQUE on `lower(wallet_address)` WHERE NOT NULL (a wallet belongs to
one agent forever); `fleet_agents_child_uq` UNIQUE on `local_child_id` WHERE NOT NULL;
`fleet_agents_sandbox_live_uq` UNIQUE on `sandbox_id` WHERE NOT NULL AND status IN
('reserved','provisioning','active') (recreated in V2, V4); `fleet_agents_status_idx (status)`;
`fleet_agents_parent_idx (parent_agent_id)`.

#### Table `fleet_events`

| Column | Type | Default | NOT NULL | Constraint |
|---|---|---|---|---|
| `id` | bigserial (sequence `fleet_events_id_seq`) | nextval | (PK) | PRIMARY KEY |
| `event_type` | text | — | yes | — (format enforced only by `svc_record_event`, V3) |
| `agent_id` | text | — | no | **no FK** (events may reference unknown ids, e.g. denied claims) |
| `actor` | text | — | no | — |
| `detail` | jsonb | `'{}'::jsonb` | yes | — |
| `created_at` | timestamptz | `now()` | yes | — |

Index `fleet_events_agent_idx (agent_id, id)`.

#### V1 functions

| Function | Returns | Lang / volatility | search_path | Purpose |
|---|---|---|---|---|
| `fleet_bucket(s text)` | text | sql IMMUTABLE | none | status → `'reserved'` (reserved, provisioning) / `'living'` (active) / NULL |
| `fleet_agents_counters()` | trigger | plpgsql | `FROM CURRENT` (replaced V4) | maintains counters and enforces the cap (below) |
| `fleet_agents_transition_guard()` | trigger | plpgsql | `FROM CURRENT` (replaced V2, V4, V6) | identity immutability + forward-only lifecycle |
| `fleet_history_immutable()` | trigger | plpgsql | none | always `RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: % on % is not allowed', TG_OP, TG_TABLE_NAME` |
| `fleet_state_counter_guard()` | trigger | plpgsql | none (replaced V4) | refuses direct counter edits: when `pg_trigger_depth() = 1` and a counter changed → `FLEET_COUNTERS_READ_ONLY` |

**Cap enforcement (`fleet_agents_counters`).** For INSERT and for UPDATE OF status: compute old and
new buckets; if equal, no-op. Otherwise `UPDATE fleet_state SET living_agents ± 1, reserved_slots ± 1, updated_at = now() WHERE id = 1 RETURNING *` — this takes the same row lock the allocator takes, so even raw SQL is serialised. Missing row → `FLEET_CAP_EXCEEDED: fleet_state missing (fail closed)`. If the row **enters** the population from outside (`old_b IS NULL AND new_b IS NOT NULL`) and `living + reserved > max_agents` → `FLEET_CAP_EXCEEDED: % living + % reserved > max %`. (Moves inside the population, e.g. reserved→living, are not re-checked.) The counter guard allows the change because the counter UPDATE runs at trigger depth 2.

**Lifecycle (`fleet_agents_transition_guard`, V1 form).** INSERT only in `reserved` or `active`.
UPDATE: `agent_id`, `role`, `generation`, `parent_agent_id`, `created_at` immutable
(`FLEET_HISTORY_IMMUTABLE: identity columns cannot change`); `wallet_address` immutable once set;
child `runtime_commit` immutable once set; same-status updates allowed except changing
`death_time` of a terminal row (`FLEET_TERMINAL_STATE_IMMUTABLE`); terminal rows cannot change
status; allowed transitions: reserved→provisioning|failed, provisioning→active|failed, active→dead;
anything else `FLEET_INVALID_TRANSITION: % -> %`.

#### V1 triggers

| Trigger | Table | Timing / event | Level | Function |
|---|---|---|---|---|
| `fleet_agents_counters_ins` | fleet_agents | AFTER INSERT | ROW | `fleet_agents_counters()` |
| `fleet_agents_counters_upd` | fleet_agents | AFTER UPDATE OF status | ROW | `fleet_agents_counters()` |
| `fleet_agents_transition_guard` | fleet_agents | BEFORE INSERT OR UPDATE | ROW | `fleet_agents_transition_guard()` |
| `fleet_agents_no_delete` | fleet_agents | BEFORE DELETE | ROW | `fleet_history_immutable()` |
| `fleet_agents_no_truncate` | fleet_agents | BEFORE TRUNCATE | STATEMENT | `fleet_history_immutable()` |
| `fleet_events_no_change` | fleet_events | BEFORE UPDATE OR DELETE | ROW | `fleet_history_immutable()` |
| `fleet_events_no_truncate` | fleet_events | BEFORE TRUNCATE | STATEMENT | `fleet_history_immutable()` |
| `fleet_state_no_delete` | fleet_state | BEFORE DELETE | ROW | `fleet_history_immutable()` |
| `fleet_state_no_truncate` | fleet_state | BEFORE TRUNCATE | STATEMENT | `fleet_history_immutable()` |
| `fleet_state_counter_guard` | fleet_state | BEFORE UPDATE | ROW | `fleet_state_counter_guard()` |

Grants in V1: none (no REVOKE either; V2 adds the PUBLIC revokes).

#### V1 exact SQL

```sql
CREATE TABLE fleet_state (
  id              smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  living_agents   integer     NOT NULL DEFAULT 0 CHECK (living_agents >= 0),
  reserved_slots  integer     NOT NULL DEFAULT 0 CHECK (reserved_slots >= 0),
  max_agents      integer     NOT NULL DEFAULT 1 CHECK (max_agents BETWEEN 1 AND ${FLEET_PG_HARD_MAX_AGENTS}),
  operating_mode  text        NOT NULL DEFAULT 'DEVELOPMENT'
                              CHECK (operating_mode IN ('DEVELOPMENT','EXPANSION','HARVEST','EMERGENCY')),
  runtime_repo    text,
  runtime_commit  text        CHECK (runtime_commit ~ '^[0-9a-f]{40}$'),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (living_agents + reserved_slots <= ${FLEET_PG_HARD_MAX_AGENTS}),
  CHECK ((runtime_repo IS NULL) = (runtime_commit IS NULL))
);
INSERT INTO fleet_state (id) VALUES (1);

CREATE TABLE fleet_agents (
  agent_id               text        PRIMARY KEY CHECK (agent_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  parent_agent_id        text        REFERENCES fleet_agents(agent_id),
  role                   text        NOT NULL CHECK (role IN ('root','child')),
  generation             integer     NOT NULL CHECK (generation >= 0),
  name                   text        NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  wallet_address         text        CHECK (wallet_address ~ '^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$'),
  runtime_version        text        CHECK (length(runtime_version) <= 64),
  runtime_repo           text,
  runtime_commit         text        CHECK (runtime_commit ~ '^[0-9a-f]{40}$'),
  sandbox_id             text,
  local_child_id         text,
  status                 text        NOT NULL CHECK (status IN ('reserved','provisioning','active','dead','failed')),
  status_reason          text,
  requested_by           text,
  request_key            text        UNIQUE,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  last_heartbeat         timestamptz,
  reservation_expires_at timestamptz,
  death_time             timestamptz,
  CHECK ((status IN ('dead','failed')) = (death_time IS NOT NULL)),
  CHECK ((role = 'root') = (parent_agent_id IS NULL)),
  CHECK (role = 'child' OR generation = 0),
  CHECK (role = 'root' OR generation >= 1),
  CHECK (status NOT IN ('reserved','provisioning') OR role = 'child'),
  CHECK (status <> 'active' OR wallet_address IS NOT NULL),
  CHECK (role = 'root' OR runtime_commit IS NOT NULL)
);
-- A wallet belongs to exactly one agent, ever (duplicate registration guard).
CREATE UNIQUE INDEX fleet_agents_wallet_uq ON fleet_agents (lower(wallet_address)) WHERE wallet_address IS NOT NULL;
-- A local child id / sandbox can back at most one living agent.
CREATE UNIQUE INDEX fleet_agents_child_uq ON fleet_agents (local_child_id) WHERE local_child_id IS NOT NULL;
CREATE UNIQUE INDEX fleet_agents_sandbox_live_uq ON fleet_agents (sandbox_id)
  WHERE sandbox_id IS NOT NULL AND status IN ('reserved','provisioning','active');
CREATE INDEX fleet_agents_status_idx ON fleet_agents (status);
CREATE INDEX fleet_agents_parent_idx ON fleet_agents (parent_agent_id);

CREATE TABLE fleet_events (
  id          bigserial   PRIMARY KEY,
  event_type  text        NOT NULL,
  agent_id    text,
  actor       text,
  detail      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_events_agent_idx ON fleet_events (agent_id, id);

-- Status buckets: 'reserved' + 'provisioning' -> reserved_slots, 'active' -> living_agents.
CREATE FUNCTION fleet_bucket(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN s IN ('reserved','provisioning') THEN 'reserved'
              WHEN s = 'active' THEN 'living'
              ELSE NULL END
$$;

-- Maintains fleet_state counters and enforces the cap at the row level.
-- Updating fleet_state takes the same row lock reservations use, so even raw
-- SQL is serialised and capped.
CREATE FUNCTION fleet_agents_counters() RETURNS trigger LANGUAGE plpgsql
SET search_path FROM CURRENT AS $$
DECLARE
  old_b text := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE fleet_bucket(OLD.status) END;
  new_b text := fleet_bucket(NEW.status);
  st fleet_state%ROWTYPE;
BEGIN
  IF old_b IS NOT DISTINCT FROM new_b THEN
    RETURN NEW;
  END IF;
  UPDATE fleet_state SET
    living_agents  = living_agents
                     + (CASE WHEN new_b = 'living' THEN 1 ELSE 0 END)
                     - (CASE WHEN old_b = 'living' THEN 1 ELSE 0 END),
    reserved_slots = reserved_slots
                     + (CASE WHEN new_b = 'reserved' THEN 1 ELSE 0 END)
                     - (CASE WHEN old_b = 'reserved' THEN 1 ELSE 0 END),
    updated_at = now()
  WHERE id = 1
  RETURNING * INTO st;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FLEET_CAP_EXCEEDED: fleet_state missing (fail closed)';
  END IF;
  -- Entering the living/reserved population from outside it must respect the cap.
  IF old_b IS NULL AND new_b IS NOT NULL AND st.living_agents + st.reserved_slots > st.max_agents THEN
    RAISE EXCEPTION 'FLEET_CAP_EXCEEDED: % living + % reserved > max %', st.living_agents, st.reserved_slots, st.max_agents;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fleet_agents_counters_ins AFTER INSERT ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_counters();
CREATE TRIGGER fleet_agents_counters_upd AFTER UPDATE OF status ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_counters();

-- Lifecycle guard: only forward transitions; terminal rows never change status.
CREATE FUNCTION fleet_agents_transition_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('reserved','active') THEN
      RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: cannot insert agent in status %', NEW.status;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.agent_id <> NEW.agent_id OR OLD.role <> NEW.role OR OLD.generation <> NEW.generation
     OR OLD.parent_agent_id IS DISTINCT FROM NEW.parent_agent_id
     OR OLD.created_at <> NEW.created_at THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: identity columns cannot change';
  END IF;
  IF OLD.wallet_address IS NOT NULL AND OLD.wallet_address IS DISTINCT FROM NEW.wallet_address THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: wallet_address cannot change once set';
  END IF;
  IF OLD.runtime_commit IS NOT NULL AND OLD.runtime_commit IS DISTINCT FROM NEW.runtime_commit AND OLD.role = 'child' THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: child runtime_commit cannot change';
  END IF;
  IF OLD.status = NEW.status THEN
    IF OLD.status IN ('dead','failed') AND OLD.death_time IS DISTINCT FROM NEW.death_time THEN
      RAISE EXCEPTION 'FLEET_TERMINAL_STATE_IMMUTABLE';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('dead','failed') THEN
    RAISE EXCEPTION 'FLEET_TERMINAL_STATE_IMMUTABLE: agent % is %', OLD.agent_id, OLD.status;
  END IF;
  IF NOT (
       (OLD.status = 'reserved'     AND NEW.status IN ('provisioning','failed'))
    OR (OLD.status = 'provisioning' AND NEW.status IN ('active','failed'))
    OR (OLD.status = 'active'       AND NEW.status = 'dead')
  ) THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fleet_agents_transition_guard BEFORE INSERT OR UPDATE ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_transition_guard();

CREATE FUNCTION fleet_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: % on % is not allowed', TG_OP, TG_TABLE_NAME;
END $$;

CREATE TRIGGER fleet_agents_no_delete BEFORE DELETE ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_agents_no_truncate BEFORE TRUNCATE ON fleet_agents
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_events_no_change BEFORE UPDATE OR DELETE ON fleet_events
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_events_no_truncate BEFORE TRUNCATE ON fleet_events
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_state_no_delete BEFORE DELETE ON fleet_state
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_state_no_truncate BEFORE TRUNCATE ON fleet_state
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- Counters are trigger-maintained; direct edits are refused.
CREATE FUNCTION fleet_state_counter_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() = 1 AND (NEW.living_agents <> OLD.living_agents OR NEW.reserved_slots <> OLD.reserved_slots) THEN
    RAISE EXCEPTION 'FLEET_COUNTERS_READ_ONLY: living_agents/reserved_slots are derived from fleet_agents';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_state_counter_guard BEFORE UPDATE ON fleet_state
  FOR EACH ROW EXECUTE FUNCTION fleet_state_counter_guard();
```

### 2.2 Version 2 — `leases_heartbeat_expiry_restricted_api`

- **Source:** `src/fleet/postgres/migrations.ts:227-746` (`const V2`, doc comment `212-226`). Commit `443f035`.
- **Purpose (Phase 3):** reservation leases with TTL; heartbeat-based liveness with a new
  `unresponsive` status; DB-level replication switch and approved build identity; per-agent bearer
  credentials (SHA-256 only); the internal lifecycle helpers; the background reaper; and the
  restricted **agent API** (`api_*`, SECURITY DEFINER) that is the entire surface of the agent role.
- **Interpolations:** `${FLEET_PG_HARD_MAX_AGENTS}` twice at line 542 (`fleet_reserve_slot`) → `50`.
- **Data migration:** every agent still `reserved`/`provisioning` is set `failed` with reason
  `phase 3 migration: reservation predates leases` (no lease can ever attest it).

#### Changes to existing tables

- `fleet_agents.status` CHECK replaced: `IN ('reserved','provisioning','active','unresponsive','dead','failed')`.
- New constraint `fleet_agents_unresponsive_wallet CHECK (status <> 'unresponsive' OR wallet_address IS NOT NULL)`.
- `fleet_agents_sandbox_live_uq` recreated with live set `('reserved','provisioning','active','unresponsive')`.
- New index `fleet_agents_heartbeat_idx (status, last_heartbeat)`.
- `fleet_bucket` now maps `active` and `unresponsive` → living.
- `fleet_agents_transition_guard` adds active→unresponsive|dead and unresponsive→active|dead.
- `fleet_state` new columns:

| Column | Type | Default | NOT NULL | CHECK |
|---|---|---|---|---|
| `replication_enabled` | boolean | `false` | yes | — (DB-level replication switch) |
| `runtime_build_id` | text | — | no | `~ '^[0-9a-f]{64}$'` |
| `runtime_lockfile_sha256` | text | — | no | `~ '^[0-9a-f]{64}$'` |
| `reservation_ttl_s` | integer | `1800` | yes | `BETWEEN 1 AND 86400` |
| `provisioning_ttl_s` | integer | `2700` | yes | `BETWEEN 1 AND 86400` |
| `heartbeat_unresponsive_s` | integer | `120` | yes | `BETWEEN 1 AND 86400` |
| `heartbeat_dead_s` | integer | `600` | yes | `BETWEEN 2 AND 604800` |
| `reaper_last_run_at` | timestamptz | — | no | — |
| `reaper_grace_from` | timestamptz | — | no | — |

  Named constraints: `fleet_state_heartbeat_order CHECK (heartbeat_dead_s > heartbeat_unresponsive_s)`;
  `fleet_state_build_pair CHECK ((runtime_build_id IS NULL) = (runtime_lockfile_sha256 IS NULL))`;
  `fleet_state_build_needs_runtime CHECK (runtime_repo IS NOT NULL OR runtime_build_id IS NULL)`.

#### Table `fleet_reservations` (lease)

| Column | Type | Default | NOT NULL | Constraint |
|---|---|---|---|---|
| `reservation_id` | text | — | (PK) | PK; ULID CHECK |
| `agent_id` | text | — | yes | UNIQUE; FK → fleet_agents |
| `parent_agent_id` | text | — | yes | FK → fleet_agents |
| `status` | text | — | yes | `IN ('reserved','provisioning','completed','expired','released','failed')` |
| `created_at` | timestamptz | `now()` | yes | — |
| `expires_at` | timestamptz | — | yes | — |
| `claimed_at` | timestamptz | — | no | — |
| `completed_at` | timestamptz | — | no | — |
| `ended_at` | timestamptz | — | no | — |
| `end_reason` | text | — | no | — |
| `expected_repo` | text | — | yes | — |
| `expected_commit` | text | — | yes | `~ '^[0-9a-f]{40}$'` |
| `expected_build_id` | text | — | yes | `~ '^[0-9a-f]{64}$'` |
| `expected_lockfile_sha256` | text | — | yes | `~ '^[0-9a-f]{64}$'` |
| `attestation_nonce` | text | — | no | `~ '^[0-9a-f]{64}$'` |
| `attested_at` | timestamptz | — | no | — |
| `attestation` | jsonb | — | no | — |
| `updated_at` | timestamptz | `now()` | yes | — |

Table CHECKs: `(status IN ('expired','released','failed')) = (ended_at IS NOT NULL)`;
`status NOT IN ('provisioning','completed') OR (claimed_at IS NOT NULL AND attestation_nonce IS NOT NULL)`;
`status <> 'completed' OR (attested_at IS NOT NULL AND completed_at IS NOT NULL)`.
Indexes: `fleet_reservations_open_idx (expires_at) WHERE status IN ('reserved','provisioning')`;
`fleet_reservations_parent_idx (parent_agent_id)`.
Guard `fleet_reservations_guard()` (search_path `FROM CURRENT`): INSERT only `reserved`
(`FLEET_INVALID_TRANSITION: lease must start reserved`); identity and all `expected_*` columns and
`created_at` immutable, `attestation_nonce` immutable once set (`FLEET_HISTORY_IMMUTABLE: lease identity and expectations cannot change`); terminal
statuses `completed/expired/released/failed` immutable; transitions reserved→provisioning|expired|released|failed,
provisioning→completed|expired|released|failed.

#### Table `fleet_agent_credentials`

| Column | Type | Default | NOT NULL | Constraint |
|---|---|---|---|---|
| `agent_id` | text | — | (PK) | PK; FK → fleet_agents |
| `token_hash` | text | — | yes | UNIQUE; `~ '^[0-9a-f]{64}$'` (SHA-256 hex of the `fa1.` token) |
| `created_at` | timestamptz | `now()` | yes | — |
| `revoked_at` | timestamptz | — | no | — |

Only DELETE is blocked (`fleet_agent_credentials_no_delete`). UPDATE is allowed (rotation via
`ON CONFLICT … DO UPDATE`, revocation by setting `revoked_at`). No TRUNCATE trigger.

#### V2 functions (all owner-only unless marked GRANTED)

| Function | Returns | Volatility | SECURITY DEFINER | search_path | Behaviour (exact) |
|---|---|---|---|---|---|
| `fleet_scrub(t text)` | text | sql IMMUTABLE | no | none | replaces `0x[0-9a-fA-F]{64}` with `[redacted]`, URL credentials `scheme://user:pass@` with `[redacted]@`, truncates to 500 chars; NULL → `''` |
| `fleet_event(p_type, p_agent, p_actor text, p_detail jsonb)` | void | sql VOLATILE | no | pinned | `INSERT INTO fleet_events` with `left(p_actor,128)`, `COALESCE(p_detail,'{}')` |
| `fleet_lock_state()` | fleet_state | plpgsql | no | pinned | `SELECT * … WHERE id=1 FOR UPDATE`; missing → `FLEET_REGISTRY_UNAVAILABLE: fleet_state row missing (fail closed)` |
| `fleet_state_json(st fleet_state)` | jsonb | sql STABLE | no | none | keys `livingAgents, reservedSlots, maxAgents, operatingMode, replicationEnabled, runtime{repo,commit}\|null, build{buildId,lockfileSha256}\|null, updatedAt` (V4 adds `quarantinedSlots`) |
| `fleet_expire_leases(p_actor)` | integer | plpgsql | no | pinned | caller holds the state lock; for each open lease past `expires_at` (ordered `created_at, reservation_id`, `FOR UPDATE`): lease→`expired` (`end_reason='lease expired while <status>'`), agent reserved/provisioning→`failed` (`'reservation lease expired (<status>)'`), events `reservation_expired`, `slot_released`; returns count |
| `fleet_release(p_agent, p_reason, p_outcome, p_actor)` | boolean | plpgsql | no | pinned | outcome must be `released`/`failed` else `FLEET_INVALID_TRANSITION: release outcome %`; locks state; agent reserved/provisioning→failed; lease→outcome; events `provisioning_failed` (if failed) and `slot_released`; false if nothing to release |
| `fleet_mark_dead(p_agent, p_reason, p_actor, p_cause)` | boolean | plpgsql | no | pinned | locks state; active/unresponsive→`dead`, reserved/provisioning→`failed`; open lease→`released`; **credential revoked** (`revoked_at=now()`); events `agent_died`, `slot_released` (V3 adds sandbox termination enqueue) |
| `fleet_heartbeat(p_agent, p_actor)` | text | plpgsql | no | pinned | row lock on the agent only; non-living → returns status unchanged; living → `last_heartbeat=now()`, `status='active'`, `agent_recovered` event if it was unresponsive (V4 changes recovery rule) |
| `fleet_authenticate(p_agent, p_token, p_action)` | text | plpgsql | no | pinned | NULL = ok, else code: malformed (NULL args, token > 256, agent > 64) → `FLEET_AUTH_FAILED` + `db_auth_failed{why:'malformed'}`; hash mismatch → `FLEET_AUTH_FAILED` + `db_auth_failed{why:'bad credential', claimedAgentId}`; dead/failed → `FLEET_AGENT_DEAD`; revoked → `FLEET_AUTH_FAILED` + `db_auth_failed{why:'revoked'}` (replaced V4, V7) |
| `fleet_reserve_slot(11 args)` | jsonb | plpgsql | no | pinned | the single slot allocator (below) |
| `fleet_reap(p_actor)` | jsonb | plpgsql | no | pinned | reaper (below; replaced V3, V4) |
| `api_fleet_state()` | jsonb | sql STABLE | **yes** | pinned | GRANTED agent: `fleet_state_json` of row 1 |
| `api_member_addresses()` | SETOF text | sql STABLE | **yes** | pinned | GRANTED agent: `lower(wallet_address)` of every agent with a wallet |
| `api_whoami(p_agent, p_token)` | jsonb | plpgsql | **yes** | pinned | GRANTED agent: auth; a dead agent still gets its record with `ok=false, code='FLEET_AGENT_DEAD'` (V7 adds `capabilityScope`) |
| `api_heartbeat(p_agent, p_token)` | jsonb | plpgsql | **yes** | pinned | GRANTED agent: auth then `fleet_heartbeat` (replaced V4) |
| `api_request_replication(p_agent, p_token, p_name, p_request_key, p_new_agent_id, p_reservation_id)` | jsonb | plpgsql | **yes** | pinned | GRANTED agent: auth; event `replication_requested`; `fleet_reserve_slot(p_agent, p_agent, p_name, p_request_key, NULL, NULL, false, NULL, NULL, …)`; event `replication_granted` or `replication_rejected` |
| `api_release_reservation(p_agent, p_token, p_reservation_id, p_reason)` | jsonb | plpgsql | **yes** | pinned | GRANTED agent: only the lease's parent may release (`authorization_denied` + `FLEET_NOT_AUTHORIZED` otherwise); `fleet_release(…, 'released by parent: '…, 'released', p_agent)` |
| `api_set_own_status(p_agent, p_token, p_status, p_reason)` | jsonb | plpgsql | **yes** | pinned | GRANTED agent: `dead` → `fleet_mark_dead(…,'self-reported: '…, cause 'self_reported')`; `active` → heartbeat; else `authorization_denied` + `FLEET_INVALID_TRANSITION` |

All `api_*` return JSON instead of raising, so authentication/authorization failures and their audit
events are committed.

**Allocator `fleet_reserve_slot` (V2 form)** — parameters `(p_parent, p_requested_by, p_name,
p_request_key, p_local_max integer, p_ttl_ms bigint, p_match_pin boolean, p_repo, p_commit,
p_agent_id, p_reservation_id)`. Order: `fleet_lock_state()` → `fleet_expire_leases` → read state →
`mx = LEAST(max_agents, COALESCE(p_local_max, 50), 50)` → denial ladder (first match wins):
EMERGENCY (or unknown mode) `FLEET_EMERGENCY`; DEVELOPMENT `FLEET_DEVELOPMENT_MODE`; HARVEST
`FLEET_HARVEST`; switch off `REAL_REPLICATION_DISABLED`; no approved repo/build
`FLEET_RUNTIME_UNVERIFIED`; `p_match_pin` and repo/commit differ `FLEET_RUNTIME_UNVERIFIED`;
parent missing or not `active` `FLEET_PARENT_NOT_LIVING`; `request_key` exists
`FLEET_DUPLICATE_REQUEST`; `living + reserved >= mx` `FLEET_CAP_REACHED`. Denial → event
`reservation_denied{code, living, reserved, max}` and `{"ok":false, code, reason, living, reserved, max}`.
Success → insert child agent (`status 'reserved'`, generation parent+1, runtime pin copied from
fleet_state, `reservation_expires_at = now() + ttl`), insert lease (`expected_*` copied from
fleet_state), event `slot_reserved`, return `{"ok":true, agentId, reservationId, parentAgentId, generation, expiresAt, runtime{repo,commit}, build{buildId,lockfileSha256}}`.
TTL: `COALESCE(p_ttl_ms, reservation_ttl_s*1000)/1000` seconds. Consequence: in the production
state (mode DEVELOPMENT, replication off) every reservation is denied with `FLEET_DEVELOPMENT_MODE`.

**Reaper `fleet_reap` (V2 form)** — state lock; grace rule: if the reaper never ran, or its last run
is older than `heartbeat_unresponsive_s`, `v_grace = now()` and event `reaper_resumed` (an outage
cannot kill agents that could not report); stores `reaper_last_run_at`, `reaper_grace_from`; expire
leases; unresponsive agents whose `GREATEST(COALESCE(last_heartbeat, updated_at), v_grace)` is older
than `heartbeat_dead_s` → `fleet_mark_dead(…, 'heartbeat_timeout')`; then active agents older than
`heartbeat_unresponsive_s` → `unresponsive` + `agent_unresponsive` (dead first, so ACTIVE→DEAD needs
two passes). Returns `{expired, unresponsive, dead, graceFrom}`.

#### V2 triggers

| Trigger | Table | Timing / event | Function |
|---|---|---|---|
| `fleet_reservations_guard` | fleet_reservations | BEFORE INSERT OR UPDATE, ROW | `fleet_reservations_guard()` |
| `fleet_reservations_no_delete` | fleet_reservations | BEFORE DELETE, ROW | `fleet_history_immutable()` |
| `fleet_reservations_no_truncate` | fleet_reservations | BEFORE TRUNCATE, STATEMENT | `fleet_history_immutable()` |
| `fleet_agent_credentials_no_delete` | fleet_agent_credentials | BEFORE DELETE, ROW | `fleet_history_immutable()` |

#### V2 grants / revokes

```sql
REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
```

The last statement has no `IN SCHEMA` and no `FOR ROLE`, so it applies to functions created **by the
migrating (owner) role in this database, in any schema**, from then on: PostgreSQL's built-in PUBLIC
EXECUTE default is removed for them (a per-schema default ACL cannot remove a global default, as the
SQL comment says). V3–V8 still end with explicit `REVOKE … FROM PUBLIC` as a second barrier.

#### V2 exact SQL

```sql
-- ── Agent status: 'unresponsive' (missed heartbeats; still holds its living slot)
ALTER TABLE fleet_agents DROP CONSTRAINT fleet_agents_status_check;
ALTER TABLE fleet_agents ADD CONSTRAINT fleet_agents_status_check
  CHECK (status IN ('reserved','provisioning','active','unresponsive','dead','failed'));
ALTER TABLE fleet_agents ADD CONSTRAINT fleet_agents_unresponsive_wallet
  CHECK (status <> 'unresponsive' OR wallet_address IS NOT NULL);
DROP INDEX fleet_agents_sandbox_live_uq;
CREATE UNIQUE INDEX fleet_agents_sandbox_live_uq ON fleet_agents (sandbox_id)
  WHERE sandbox_id IS NOT NULL AND status IN ('reserved','provisioning','active','unresponsive');
CREATE INDEX fleet_agents_heartbeat_idx ON fleet_agents (status, last_heartbeat);

CREATE OR REPLACE FUNCTION fleet_bucket(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN s IN ('reserved','provisioning') THEN 'reserved'
              WHEN s IN ('active','unresponsive') THEN 'living'
              ELSE NULL END
$$;

CREATE OR REPLACE FUNCTION fleet_agents_transition_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('reserved','active') THEN
      RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: cannot insert agent in status %', NEW.status;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.agent_id <> NEW.agent_id OR OLD.role <> NEW.role OR OLD.generation <> NEW.generation
     OR OLD.parent_agent_id IS DISTINCT FROM NEW.parent_agent_id
     OR OLD.created_at <> NEW.created_at THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: identity columns cannot change';
  END IF;
  IF OLD.wallet_address IS NOT NULL AND OLD.wallet_address IS DISTINCT FROM NEW.wallet_address THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: wallet_address cannot change once set';
  END IF;
  IF OLD.runtime_commit IS NOT NULL AND OLD.runtime_commit IS DISTINCT FROM NEW.runtime_commit AND OLD.role = 'child' THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: child runtime_commit cannot change';
  END IF;
  IF OLD.status = NEW.status THEN
    IF OLD.status IN ('dead','failed') AND OLD.death_time IS DISTINCT FROM NEW.death_time THEN
      RAISE EXCEPTION 'FLEET_TERMINAL_STATE_IMMUTABLE';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('dead','failed') THEN
    RAISE EXCEPTION 'FLEET_TERMINAL_STATE_IMMUTABLE: agent % is %', OLD.agent_id, OLD.status;
  END IF;
  IF NOT (
       (OLD.status = 'reserved'     AND NEW.status IN ('provisioning','failed'))
    OR (OLD.status = 'provisioning' AND NEW.status IN ('active','failed'))
    OR (OLD.status = 'active'       AND NEW.status IN ('unresponsive','dead'))
    OR (OLD.status = 'unresponsive' AND NEW.status IN ('active','dead'))
  ) THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;

-- ── Shared settings: DB-level replication switch, approved build, timeouts, reaper bookkeeping
ALTER TABLE fleet_state
  ADD COLUMN replication_enabled      boolean     NOT NULL DEFAULT false,
  ADD COLUMN runtime_build_id         text        CHECK (runtime_build_id ~ '^[0-9a-f]{64}$'),
  ADD COLUMN runtime_lockfile_sha256  text        CHECK (runtime_lockfile_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN reservation_ttl_s        integer     NOT NULL DEFAULT 1800 CHECK (reservation_ttl_s BETWEEN 1 AND 86400),
  ADD COLUMN provisioning_ttl_s       integer     NOT NULL DEFAULT 2700 CHECK (provisioning_ttl_s BETWEEN 1 AND 86400),
  ADD COLUMN heartbeat_unresponsive_s integer     NOT NULL DEFAULT 120  CHECK (heartbeat_unresponsive_s BETWEEN 1 AND 86400),
  ADD COLUMN heartbeat_dead_s         integer     NOT NULL DEFAULT 600  CHECK (heartbeat_dead_s BETWEEN 2 AND 604800),
  ADD COLUMN reaper_last_run_at       timestamptz,
  ADD COLUMN reaper_grace_from        timestamptz,
  ADD CONSTRAINT fleet_state_heartbeat_order CHECK (heartbeat_dead_s > heartbeat_unresponsive_s),
  ADD CONSTRAINT fleet_state_build_pair CHECK ((runtime_build_id IS NULL) = (runtime_lockfile_sha256 IS NULL)),
  ADD CONSTRAINT fleet_state_build_needs_runtime CHECK (runtime_repo IS NOT NULL OR runtime_build_id IS NULL);

-- ── Reservation leases
CREATE TABLE fleet_reservations (
  reservation_id           text        PRIMARY KEY CHECK (reservation_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  agent_id                 text        NOT NULL UNIQUE REFERENCES fleet_agents(agent_id),
  parent_agent_id          text        NOT NULL REFERENCES fleet_agents(agent_id),
  status                   text        NOT NULL
                                       CHECK (status IN ('reserved','provisioning','completed','expired','released','failed')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  expires_at               timestamptz NOT NULL,
  claimed_at               timestamptz,
  completed_at             timestamptz,
  ended_at                 timestamptz,
  end_reason               text,
  expected_repo            text        NOT NULL,
  expected_commit          text        NOT NULL CHECK (expected_commit ~ '^[0-9a-f]{40}$'),
  expected_build_id        text        NOT NULL CHECK (expected_build_id ~ '^[0-9a-f]{64}$'),
  expected_lockfile_sha256 text        NOT NULL CHECK (expected_lockfile_sha256 ~ '^[0-9a-f]{64}$'),
  attestation_nonce        text        CHECK (attestation_nonce ~ '^[0-9a-f]{64}$'),
  attested_at              timestamptz,
  attestation              jsonb,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('expired','released','failed')) = (ended_at IS NOT NULL)),
  CHECK (status NOT IN ('provisioning','completed') OR (claimed_at IS NOT NULL AND attestation_nonce IS NOT NULL)),
  CHECK (status <> 'completed' OR (attested_at IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX fleet_reservations_open_idx ON fleet_reservations (expires_at) WHERE status IN ('reserved','provisioning');
CREATE INDEX fleet_reservations_parent_idx ON fleet_reservations (parent_agent_id);

CREATE FUNCTION fleet_reservations_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'reserved' THEN
      RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: lease must start reserved';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.reservation_id <> NEW.reservation_id OR OLD.agent_id <> NEW.agent_id
     OR OLD.parent_agent_id <> NEW.parent_agent_id OR OLD.created_at <> NEW.created_at
     OR OLD.expected_repo <> NEW.expected_repo OR OLD.expected_commit <> NEW.expected_commit
     OR OLD.expected_build_id <> NEW.expected_build_id OR OLD.expected_lockfile_sha256 <> NEW.expected_lockfile_sha256
     OR (OLD.attestation_nonce IS NOT NULL AND OLD.attestation_nonce IS DISTINCT FROM NEW.attestation_nonce) THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: lease identity and expectations cannot change';
  END IF;
  IF OLD.status IN ('completed','expired','released','failed') THEN
    RAISE EXCEPTION 'FLEET_TERMINAL_STATE_IMMUTABLE: lease % is %', OLD.reservation_id, OLD.status;
  END IF;
  IF OLD.status <> NEW.status AND NOT (
       (OLD.status = 'reserved'     AND NEW.status IN ('provisioning','expired','released','failed'))
    OR (OLD.status = 'provisioning' AND NEW.status IN ('completed','expired','released','failed'))
  ) THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: lease % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_reservations_guard BEFORE INSERT OR UPDATE ON fleet_reservations
  FOR EACH ROW EXECUTE FUNCTION fleet_reservations_guard();
CREATE TRIGGER fleet_reservations_no_delete BEFORE DELETE ON fleet_reservations
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_reservations_no_truncate BEFORE TRUNCATE ON fleet_reservations
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ── Per-agent credentials (only a SHA-256 of the bearer token is stored)
CREATE TABLE fleet_agent_credentials (
  agent_id    text        PRIMARY KEY REFERENCES fleet_agents(agent_id),
  token_hash  text        NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE TRIGGER fleet_agent_credentials_no_delete BEFORE DELETE ON fleet_agent_credentials
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- ── Phase 2 reservations have no lease and can never be attested: fail them.
UPDATE fleet_agents SET status = 'failed', status_reason = 'phase 3 migration: reservation predates leases',
       death_time = now(), updated_at = now()
 WHERE status IN ('reserved','provisioning');

-- ── Internal helpers (owner only; never granted)

CREATE FUNCTION fleet_scrub(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT left(regexp_replace(regexp_replace(COALESCE(t, ''),
           '0x[0-9a-fA-F]{64}', '[redacted]', 'g'),
           '[a-zA-Z][a-zA-Z0-9+.-]*://[^[:space:]:@/]+:[^[:space:]@/]+@', '[redacted]@', 'g'), 500)
$$;

CREATE FUNCTION fleet_event(p_type text, p_agent text, p_actor text, p_detail jsonb)
RETURNS void LANGUAGE sql SET search_path = @@SCHEMA@@, pg_temp AS $$
  INSERT INTO fleet_events (event_type, agent_id, actor, detail)
  VALUES (p_type, p_agent, left(p_actor, 128), COALESCE(p_detail, '{}'::jsonb));
$$;

CREATE FUNCTION fleet_lock_state() RETURNS fleet_state LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st fleet_state;
BEGIN
  SELECT * INTO st FROM fleet_state WHERE id = 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FLEET_REGISTRY_UNAVAILABLE: fleet_state row missing (fail closed)';
  END IF;
  RETURN st;
END $$;

CREATE FUNCTION fleet_state_json(st fleet_state) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'livingAgents', st.living_agents,
    'reservedSlots', st.reserved_slots,
    'maxAgents', st.max_agents,
    'operatingMode', st.operating_mode,
    'replicationEnabled', st.replication_enabled,
    'runtime', CASE WHEN st.runtime_repo IS NULL THEN NULL
                    ELSE jsonb_build_object('repo', st.runtime_repo, 'commit', st.runtime_commit) END,
    'build', CASE WHEN st.runtime_build_id IS NULL THEN NULL
                  ELSE jsonb_build_object('buildId', st.runtime_build_id, 'lockfileSha256', st.runtime_lockfile_sha256) END,
    'updatedAt', st.updated_at)
$$;

-- Expire open leases past expires_at (caller holds the fleet_state lock). Idempotent.
CREATE FUNCTION fleet_expire_leases(p_actor text) RETURNS integer LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN SELECT reservation_id, agent_id, status FROM fleet_reservations
            WHERE status IN ('reserved','provisioning') AND expires_at <= now()
            ORDER BY created_at, reservation_id FOR UPDATE LOOP
    UPDATE fleet_reservations
       SET status = 'expired', ended_at = now(), end_reason = 'lease expired while ' || r.status, updated_at = now()
     WHERE reservation_id = r.reservation_id AND status = r.status;
    UPDATE fleet_agents
       SET status = 'failed', status_reason = 'reservation lease expired (' || r.status || ')', death_time = now(), updated_at = now()
     WHERE agent_id = r.agent_id AND status IN ('reserved','provisioning');
    PERFORM fleet_event('reservation_expired', r.agent_id, p_actor,
      jsonb_build_object('reservationId', r.reservation_id, 'phase', r.status));
    PERFORM fleet_event('slot_released', r.agent_id, p_actor,
      jsonb_build_object('reservationId', r.reservation_id, 'reason', 'lease expired'));
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- reserved/provisioning -> failed. Returns false when there is nothing to release (idempotent).
CREATE FUNCTION fleet_release(p_agent text, p_reason text, p_outcome text, p_actor text) RETURNS boolean LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_res text; v_reason text := fleet_scrub(p_reason);
BEGIN
  IF p_outcome NOT IN ('released','failed') THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: release outcome %', p_outcome;
  END IF;
  PERFORM fleet_lock_state();
  UPDATE fleet_agents SET status = 'failed', status_reason = v_reason, death_time = now(), updated_at = now()
   WHERE agent_id = p_agent AND status IN ('reserved','provisioning');
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE fleet_reservations SET status = p_outcome, ended_at = now(), end_reason = v_reason, updated_at = now()
   WHERE agent_id = p_agent AND status IN ('reserved','provisioning')
   RETURNING reservation_id INTO v_res;
  IF p_outcome = 'failed' THEN
    PERFORM fleet_event('provisioning_failed', p_agent, p_actor, jsonb_build_object('reservationId', v_res, 'reason', v_reason));
  END IF;
  PERFORM fleet_event('slot_released', p_agent, p_actor, jsonb_build_object('reservationId', v_res, 'reason', v_reason));
  RETURN true;
END $$;

-- Any living/reserved agent -> dead (was living) or failed (never activated).
-- Revokes its credential and closes any open lease. Idempotent.
CREATE FUNCTION fleet_mark_dead(p_agent text, p_reason text, p_actor text, p_cause text) RETURNS boolean LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_status text; v_reason text := fleet_scrub(p_reason);
BEGIN
  PERFORM fleet_lock_state();
  UPDATE fleet_agents
     SET status = CASE WHEN status IN ('active','unresponsive') THEN 'dead' ELSE 'failed' END,
         status_reason = v_reason, death_time = now(), updated_at = now()
   WHERE agent_id = p_agent AND status IN ('reserved','provisioning','active','unresponsive')
   RETURNING status INTO v_status;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE fleet_reservations SET status = 'released', ended_at = now(), end_reason = v_reason, updated_at = now()
   WHERE agent_id = p_agent AND status IN ('reserved','provisioning');
  UPDATE fleet_agent_credentials SET revoked_at = now() WHERE agent_id = p_agent AND revoked_at IS NULL;
  PERFORM fleet_event('agent_died', p_agent, p_actor, jsonb_build_object('reason', v_reason, 'cause', p_cause, 'status', v_status));
  PERFORM fleet_event('slot_released', p_agent, p_actor, jsonb_build_object('reason', v_reason));
  RETURN true;
END $$;

-- Record a heartbeat; unresponsive agents recover. Returns the agent's status after the call (NULL if unknown).
-- Touches only the agent row: no fleet-wide lock, and never inserts.
CREATE FUNCTION fleet_heartbeat(p_agent text, p_actor text) RETURNS text LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_old text;
BEGIN
  SELECT status INTO v_old FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_old NOT IN ('active','unresponsive') THEN
    RETURN v_old;
  END IF;
  UPDATE fleet_agents SET last_heartbeat = now(), status = 'active' WHERE agent_id = p_agent;
  IF v_old = 'unresponsive' THEN
    PERFORM fleet_event('agent_recovered', p_agent, p_actor, '{}'::jsonb);
  END IF;
  RETURN 'active';
END $$;

-- Authenticate (agent_id, bearer token). NULL = ok, else a denial code. Failures are audited.
CREATE FUNCTION fleet_authenticate(p_agent text, p_token text, p_action text) RETURNS text LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_agent_credentials; v_status text;
BEGIN
  IF p_agent IS NULL OR p_token IS NULL OR length(p_token) > 256 OR length(p_agent) > 64 THEN
    PERFORM fleet_event('db_auth_failed', NULL, NULL, jsonb_build_object('action', p_action, 'why', 'malformed'));
    RETURN 'FLEET_AUTH_FAILED';
  END IF;
  SELECT * INTO c FROM fleet_agent_credentials WHERE agent_id = p_agent;
  IF NOT FOUND OR c.token_hash <> encode(sha256(convert_to(p_token, 'UTF8')), 'hex') THEN
    PERFORM fleet_event('db_auth_failed', NULL, NULL,
      jsonb_build_object('action', p_action, 'claimedAgentId', left(p_agent, 64), 'why', 'bad credential'));
    RETURN 'FLEET_AUTH_FAILED';
  END IF;
  SELECT status INTO v_status FROM fleet_agents WHERE agent_id = p_agent;
  IF v_status IN ('dead','failed') THEN
    RETURN 'FLEET_AGENT_DEAD';
  END IF;
  IF c.revoked_at IS NOT NULL THEN
    PERFORM fleet_event('db_auth_failed', p_agent, p_agent, jsonb_build_object('action', p_action, 'why', 'revoked'));
    RETURN 'FLEET_AUTH_FAILED';
  END IF;
  RETURN NULL;
END $$;

-- The single slot allocator. Checks run under the fleet_state row lock.
CREATE FUNCTION fleet_reserve_slot(
  p_parent text, p_requested_by text, p_name text, p_request_key text, p_local_max integer,
  p_ttl_ms bigint, p_match_pin boolean, p_repo text, p_commit text, p_agent_id text, p_reservation_id text
) RETURNS jsonb LANGUAGE plpgsql SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st fleet_state; par fleet_agents; mx integer; v_code text; v_reason text; v_exp timestamptz;
BEGIN
  PERFORM fleet_lock_state();
  PERFORM fleet_expire_leases(p_requested_by);
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  mx := LEAST(st.max_agents, COALESCE(p_local_max, ${FLEET_PG_HARD_MAX_AGENTS}), ${FLEET_PG_HARD_MAX_AGENTS});

  IF st.operating_mode = 'EMERGENCY' OR st.operating_mode NOT IN ('DEVELOPMENT','EXPANSION','HARVEST') THEN
    v_code := 'FLEET_EMERGENCY'; v_reason := 'Shared fleet state is EMERGENCY.';
  ELSIF st.operating_mode = 'DEVELOPMENT' THEN
    v_code := 'FLEET_DEVELOPMENT_MODE'; v_reason := 'Shared fleet state is DEVELOPMENT.';
  ELSIF st.operating_mode = 'HARVEST' THEN
    v_code := 'FLEET_HARVEST'; v_reason := 'Shared fleet state is HARVEST.';
  ELSIF NOT st.replication_enabled THEN
    v_code := 'REAL_REPLICATION_DISABLED'; v_reason := 'Replication is disabled in the shared fleet registry.';
  ELSIF st.runtime_repo IS NULL OR st.runtime_build_id IS NULL THEN
    v_code := 'FLEET_RUNTIME_UNVERIFIED'; v_reason := 'No fleet-approved runtime build.';
  ELSIF p_match_pin AND (p_repo IS DISTINCT FROM st.runtime_repo OR p_commit IS DISTINCT FROM st.runtime_commit) THEN
    v_code := 'FLEET_RUNTIME_UNVERIFIED'; v_reason := 'Child runtime pin does not match the fleet-approved runtime.';
  END IF;

  IF v_code IS NULL THEN
    SELECT * INTO par FROM fleet_agents WHERE agent_id = p_parent;
    IF NOT FOUND OR par.status <> 'active' THEN
      v_code := 'FLEET_PARENT_NOT_LIVING'; v_reason := 'Parent is not a living registered fleet agent.';
    ELSIF EXISTS (SELECT 1 FROM fleet_agents WHERE request_key = p_request_key) THEN
      v_code := 'FLEET_DUPLICATE_REQUEST'; v_reason := 'Replication request already registered.';
    ELSIF st.living_agents + st.reserved_slots >= mx THEN
      v_code := 'FLEET_CAP_REACHED';
      v_reason := format('Fleet at cap (%s living + %s reserved >= %s).', st.living_agents, st.reserved_slots, mx);
    END IF;
  END IF;

  IF v_code IS NOT NULL THEN
    PERFORM fleet_event('reservation_denied', NULL, p_requested_by,
      jsonb_build_object('code', v_code, 'living', st.living_agents, 'reserved', st.reserved_slots, 'max', mx));
    RETURN jsonb_build_object('ok', false, 'code', v_code, 'reason', v_reason,
      'living', st.living_agents, 'reserved', st.reserved_slots, 'max', mx);
  END IF;

  v_exp := now() + make_interval(secs => COALESCE(p_ttl_ms, st.reservation_ttl_s::bigint * 1000)::double precision / 1000);
  INSERT INTO fleet_agents (agent_id, parent_agent_id, role, generation, name, runtime_repo, runtime_commit,
                            status, requested_by, request_key, reservation_expires_at)
  VALUES (p_agent_id, p_parent, 'child', par.generation + 1, p_name, st.runtime_repo, st.runtime_commit,
          'reserved', p_requested_by, p_request_key, v_exp);
  INSERT INTO fleet_reservations (reservation_id, agent_id, parent_agent_id, status, expires_at,
                                  expected_repo, expected_commit, expected_build_id, expected_lockfile_sha256)
  VALUES (p_reservation_id, p_agent_id, p_parent, 'reserved', v_exp,
          st.runtime_repo, st.runtime_commit, st.runtime_build_id, st.runtime_lockfile_sha256);
  PERFORM fleet_event('slot_reserved', p_agent_id, p_requested_by, jsonb_build_object(
    'reservationId', p_reservation_id, 'living', st.living_agents, 'reserved', st.reserved_slots + 1, 'max', mx,
    'expiresAt', v_exp));
  RETURN jsonb_build_object('ok', true, 'agentId', p_agent_id, 'reservationId', p_reservation_id,
    'parentAgentId', p_parent, 'generation', par.generation + 1, 'expiresAt', v_exp,
    'runtime', jsonb_build_object('repo', st.runtime_repo, 'commit', st.runtime_commit),
    'build', jsonb_build_object('buildId', st.runtime_build_id, 'lockfileSha256', st.runtime_lockfile_sha256));
END $$;

-- Background reaper: lease expiry, then ACTIVE -> UNRESPONSIVE -> DEAD on missed heartbeats.
-- If the reaper itself has not run for longer than the unresponsive timeout (service or
-- registry outage), heartbeat ages are measured from its resumption, so an outage
-- cannot kill agents that were healthy but unable to report. Idempotent.
CREATE FUNCTION fleet_reap(p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st fleet_state; v_grace timestamptz; v_expired integer; v_unresp integer := 0; v_dead integer := 0; r record;
BEGIN
  st := fleet_lock_state();
  IF st.reaper_last_run_at IS NULL OR st.reaper_grace_from IS NULL
     OR now() - st.reaper_last_run_at > make_interval(secs => st.heartbeat_unresponsive_s) THEN
    v_grace := now();
    PERFORM fleet_event('reaper_resumed', NULL, p_actor, jsonb_build_object('lastRunAt', st.reaper_last_run_at));
  ELSE
    v_grace := st.reaper_grace_from;
  END IF;
  UPDATE fleet_state SET reaper_last_run_at = now(), reaper_grace_from = v_grace WHERE id = 1;

  v_expired := fleet_expire_leases(p_actor);

  -- Dead first, so an agent needs two reaper passes to go ACTIVE -> UNRESPONSIVE -> DEAD.
  FOR r IN SELECT agent_id FROM fleet_agents
            WHERE status = 'unresponsive'
              AND GREATEST(COALESCE(last_heartbeat, updated_at), v_grace) < now() - make_interval(secs => st.heartbeat_dead_s)
            ORDER BY agent_id LOOP
    IF fleet_mark_dead(r.agent_id, format('no heartbeat for more than %s s', st.heartbeat_dead_s), p_actor, 'heartbeat_timeout') THEN
      v_dead := v_dead + 1;
    END IF;
  END LOOP;

  FOR r IN SELECT agent_id, last_heartbeat FROM fleet_agents
            WHERE status = 'active'
              AND GREATEST(COALESCE(last_heartbeat, updated_at), v_grace) < now() - make_interval(secs => st.heartbeat_unresponsive_s)
            ORDER BY agent_id FOR UPDATE LOOP
    UPDATE fleet_agents SET status = 'unresponsive', updated_at = now() WHERE agent_id = r.agent_id AND status = 'active';
    PERFORM fleet_event('agent_unresponsive', r.agent_id, p_actor,
      jsonb_build_object('lastHeartbeat', r.last_heartbeat, 'timeoutS', st.heartbeat_unresponsive_s));
    v_unresp := v_unresp + 1;
  END LOOP;

  RETURN jsonb_build_object('expired', v_expired, 'unresponsive', v_unresp, 'dead', v_dead, 'graceFrom', v_grace);
END $$;

-- ── Restricted agent API (SECURITY DEFINER; the only functions granted to the agent role)

CREATE FUNCTION api_fleet_state() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT fleet_state_json(s) FROM fleet_state s WHERE s.id = 1
$$;

CREATE FUNCTION api_member_addresses() RETURNS SETOF text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT lower(wallet_address) FROM fleet_agents WHERE wallet_address IS NOT NULL
$$;

CREATE FUNCTION api_whoami(p_agent text, p_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'whoami'); a fleet_agents;
BEGIN
  IF v_code IS NOT NULL AND v_code <> 'FLEET_AGENT_DEAD' THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent;
  RETURN jsonb_build_object('ok', v_code IS NULL, 'code', v_code, 'agent', jsonb_build_object(
    'agentId', a.agent_id, 'parentAgentId', a.parent_agent_id, 'role', a.role, 'generation', a.generation,
    'name', a.name, 'walletAddress', a.wallet_address, 'runtimeVersion', a.runtime_version,
    'runtimeRepo', a.runtime_repo, 'runtimeCommit', a.runtime_commit, 'sandboxId', a.sandbox_id,
    'localChildId', a.local_child_id, 'status', a.status, 'statusReason', a.status_reason,
    'requestedBy', a.requested_by, 'createdAt', a.created_at, 'updatedAt', a.updated_at,
    'lastHeartbeat', a.last_heartbeat, 'deathTime', a.death_time));
END $$;

CREATE FUNCTION api_heartbeat(p_agent text, p_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'heartbeat'); v_status text;
BEGIN
  IF v_code = 'FLEET_AGENT_DEAD' THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code,
      'status', (SELECT status FROM fleet_agents WHERE agent_id = p_agent));
  ELSIF v_code IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;
  v_status := fleet_heartbeat(p_agent, p_agent);
  RETURN jsonb_build_object('ok', COALESCE(v_status = 'active', false), 'status', v_status);
END $$;

CREATE FUNCTION api_request_replication(
  p_agent text, p_token text, p_name text, p_request_key text, p_new_agent_id text, p_reservation_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'request_replication'); v_result jsonb;
BEGIN
  IF v_code IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code, 'reason', 'Agent authentication failed.');
  END IF;
  PERFORM fleet_event('replication_requested', p_agent, p_agent,
    jsonb_build_object('name', left(p_name, 128), 'requestKey', left(p_request_key, 64)));
  v_result := fleet_reserve_slot(p_agent, p_agent, p_name, p_request_key, NULL, NULL, false, NULL, NULL,
                                 p_new_agent_id, p_reservation_id);
  IF (v_result->>'ok')::boolean THEN
    PERFORM fleet_event('replication_granted', v_result->>'agentId', p_agent,
      jsonb_build_object('reservationId', v_result->>'reservationId', 'parentAgentId', p_agent));
  ELSE
    PERFORM fleet_event('replication_rejected', NULL, p_agent,
      jsonb_build_object('code', v_result->>'code', 'parentAgentId', p_agent));
  END IF;
  RETURN v_result;
END $$;

CREATE FUNCTION api_release_reservation(p_agent text, p_token text, p_reservation_id text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'release_reservation'); l fleet_reservations;
BEGIN
  IF v_code IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;
  SELECT * INTO l FROM fleet_reservations WHERE reservation_id = p_reservation_id;
  IF NOT FOUND OR l.parent_agent_id <> p_agent THEN
    PERFORM fleet_event('authorization_denied', NULL, p_agent,
      jsonb_build_object('action', 'release_reservation', 'reservationId', left(p_reservation_id, 64)));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_AUTHORIZED');
  END IF;
  RETURN jsonb_build_object('ok', true, 'released',
    fleet_release(l.agent_id, 'released by parent: ' || COALESCE(p_reason, ''), 'released', p_agent));
END $$;

CREATE FUNCTION api_set_own_status(p_agent text, p_token text, p_status text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'set_own_status');
BEGIN
  IF v_code IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;
  IF p_status = 'dead' THEN
    RETURN jsonb_build_object('ok', true, 'changed',
      fleet_mark_dead(p_agent, 'self-reported: ' || COALESCE(p_reason, ''), p_agent, 'self_reported'));
  ELSIF p_status = 'active' THEN
    RETURN jsonb_build_object('ok', COALESCE(fleet_heartbeat(p_agent, p_agent) = 'active', false), 'changed', false);
  END IF;
  PERFORM fleet_event('authorization_denied', p_agent, p_agent,
    jsonb_build_object('action', 'set_own_status', 'requested', left(p_status, 32)));
  RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_TRANSITION');
END $$;

-- Nothing in this schema is executable or readable by PUBLIC; the agent role
-- receives EXECUTE on api_* only (PgFleetStore.grantAgentRole).
REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
-- Per-schema default privileges cannot remove PostgreSQL's global PUBLIC
-- EXECUTE default, so revoke it for every function this (owner) role creates.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
```


### 2.3 Version 3 — `service_role_runtime_immutability_terminations`

- **Source:** `src/fleet/postgres/migrations.ts:762-1112` (`const V3`, doc comment `748-761`). Commit `e5ac7fe`.
- **Purpose (Phase 4):** least-privilege **controller (service) role** — every controller write
  becomes a SECURITY DEFINER `svc_*` function, so the service login cannot change cap, mode, approved
  runtime or replication switch, cannot insert agents and cannot read token hashes; approved runtime
  immutable while a release is running; parent-reported child deaths; sandbox termination queue.
- **Interpolations:** none.

#### Changes to existing tables

- `fleet_state.parent_report_quiet_s integer NOT NULL DEFAULT 60 CHECK (BETWEEN 1 AND 86400)`.
- `fleet_agents.terminal_reported_at timestamptz` (nullable).
- `fleet_mark_dead` replaced: additionally, if the agent had a `sandbox_id`, inserts
  `fleet_sandbox_terminations(agent_id, sandbox_id, 'pending') ON CONFLICT (agent_id) DO NOTHING` and,
  when inserted, event `sandbox_termination_requested`.
- `fleet_reap` replaced: after lease expiry, living agents with `terminal_reported_at` set that have
  been quiet longer than `parent_report_quiet_s` (grace-adjusted) → `fleet_mark_dead(…,'parent_reported')`;
  then the V2 heartbeat steps.

#### Runtime immutability: `fleet_state_runtime_guard()` + trigger `fleet_state_runtime_guard` (BEFORE UPDATE ON fleet_state, ROW, pinned)

If any of `(runtime_repo, runtime_commit, runtime_build_id, runtime_lockfile_sha256)` changes **and**
the new `runtime_repo IS NOT NULL` **and** (an open lease exists OR a child is in
reserved/provisioning/active/unresponsive) → `FLEET_RUNTIME_IMMUTABLE: the approved runtime cannot change while leases are open or children are living (clear it, drain, then approve)`.
Clearing the runtime (new repo NULL) is always allowed and blocks all replication.
(From V4 on, the child-living set in this guard still lists only the V3 statuses; `terminating` and
`orphaned` children do not block a runtime change.)

#### Table `fleet_sandbox_terminations`

| Column | Type | Default | NOT NULL | Constraint |
|---|---|---|---|---|
| `agent_id` | text | — | (PK) | PK; FK → fleet_agents |
| `sandbox_id` | text | — | yes | — |
| `status` | text | — | yes | `IN ('pending','terminated','unsupported','failed')` |
| `requested_at` | timestamptz | `now()` | yes | — |
| `attempts` | integer | `0` | yes | `>= 0` |
| `last_attempt_at` | timestamptz | — | no | — |
| `completed_at` | timestamptz | — | no | — |
| `last_error` | text | — | no | — |

Table CHECK: `(status IN ('terminated','unsupported')) = (completed_at IS NOT NULL)`.
Triggers: `fleet_sandbox_terminations_no_delete` (BEFORE DELETE ROW), `fleet_sandbox_terminations_no_truncate` (BEFORE TRUNCATE STATEMENT) → `fleet_history_immutable()`.

#### V3 functions

| Function | Returns | Volatility | SECDEF | search_path | Exact behaviour |
|---|---|---|---|---|---|
| `fleet_agent_json(a fleet_agents)` | jsonb | sql STABLE | no | none | agent row → camelCase JSON (agentId, parentAgentId, role, generation, name, walletAddress, runtimeVersion, runtimeRepo, runtimeCommit, sandboxId, localChildId, status, statusReason, requestedBy, createdAt, updatedAt, lastHeartbeat, deathTime) |
| `svc_claim(p_agent, p_local_child, p_parent text, p_ttl_ms bigint, p_nonce text)` | jsonb | plpgsql | **yes** | pinned | nonce must be 64 hex and local child id 1..64 chars (`Replication denied: malformed claim.`); state lock; lease row lock; lease must be `reserved` and unexpired; `p_parent` (if given) must equal the lease parent; agent reserved→provisioning (`local_child_id`, new `reservation_expires_at`), lease reserved→provisioning with `claimed_at`, `attestation_nonce = p_nonce`, `expires_at = now()+TTL` (TTL = `COALESCE(p_ttl_ms, provisioning_ttl_s*1000)/1000`); event `slot_claimed`; returns `{ok, agentId, parentAgentId, generation, reservationId, repo, commit, buildId, lockfileSha256}` |
| `svc_activate(p_agent, p_parent, p_wallet, p_sandbox, p_runtime_commit, p_runtime_version text, p_attestation jsonb, p_actor, p_token_hash text)` | jsonb | plpgsql | **yes** | pinned | token hash must be 64 hex (`FLEET_BAD_REQUEST`); state lock; agent must be `provisioning` and its lease `provisioning` (`FLEET_INVALID_STATE`); wrong parent → `authorization_denied` + `FLEET_NOT_AUTHORIZED`; expired lease → `FLEET_NOT_AUTHORIZED`. Authoritative attestation check, first failure wins: not a JSON object; reported commit ≠ lease; `nonce` ≠ lease nonce; attested `commit`, `repo`, `lockfileSha256`, `buildId` ≠ lease; `clean` ≠ JSON `true`; `proof` ≠ `hex(sha256(nonce:commit:buildId:lockfileSha256))`. On failure: event `runtime_verification_failed{reason:'controller check: …'}`, `fleet_release(…,'failed')`, return `FLEET_RUNTIME_UNVERIFIED`. On success: agent→active (wallet, sandbox, runtime_version = `att.version` or param, `last_heartbeat=now()`), lease→completed (`attested_at`, `attestation`), events `runtime_verified`, `agent_activated`, credential upsert (`ON CONFLICT (agent_id) DO UPDATE … revoked_at = NULL`), event `credential_issued`; returns `{ok:true, agent: fleet_agent_json}` |
| `svc_verification_failed(p_agent, p_reason, p_actor)` | boolean | plpgsql | **yes** | pinned | event `runtime_verification_failed` (scrubbed reason) + `fleet_release(…,'failed')` |
| `svc_release(p_agent, p_reason, p_actor)` | boolean | sql | **yes** | pinned | `fleet_release(p_agent, p_reason, 'released', p_actor)` |
| `svc_mark_dead(p_agent, p_reason, p_actor, p_cause)` | boolean | sql | **yes** | pinned | `fleet_mark_dead(…, left(COALESCE(p_cause,'reported'),32))` |
| `svc_heartbeat(p_agent)` | text | sql | **yes** | pinned | `fleet_heartbeat(p_agent, p_agent)` |
| `svc_reap(p_actor)` | jsonb | sql | **yes** | pinned | `fleet_reap(p_actor)` |
| `svc_record_event(p_type, p_agent, p_actor, p_detail jsonb)` | void | plpgsql | **yes** | pinned | `p_type` must match `^[a-z][a-z0-9_]{0,63}$` else `RAISE 'FLEET_BAD_EVENT: invalid event type'`; `fleet_event(p_type, left(p_agent,64), p_actor, p_detail)` |
| `svc_child_terminal(p_parent, p_local_child, p_state)` | jsonb | plpgsql | **yes** | pinned | child found by `local_child_id`; parent must match (`authorization_denied` + `FLEET_NOT_AUTHORIZED`); reserved/provisioning → `fleet_release(…,'failed')` outcome `released`; active/unresponsive → set `terminal_reported_at` (first time) and die now only if quiet longer than `parent_report_quiet_s` (outcome `dead`), else `deferred`; terminal → `already_terminal`; event `child_terminal_reported{localChildId, state, outcome}` |
| `svc_terminations_due(p_limit integer)` | jsonb | sql **STABLE** | **yes** | pinned | JSON array of `{agentId, sandboxId, attempts}` for rows `pending`, or `failed` with `attempts < 5` and `last_attempt_at` older than 60 s, ordered by `requested_at`, limit `LEAST(GREATEST(p_limit,1),100)` |
| `svc_termination_result(p_agent, p_status, p_error, p_actor)` | boolean | plpgsql | **yes** | pinned | status must be `terminated/unsupported/failed` else raise; updates the queue row (`attempts+1`, scrubbed error, `completed_at` for terminal outcomes); event `sandbox_terminated` / `sandbox_termination_unsupported` / `sandbox_termination_failed` (replaced V4) |

Grants in V3: `REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC; REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;` The role grants themselves are applied by `grantServiceRole` (§1.7).

#### V3 exact SQL

```sql
-- ── Settings
ALTER TABLE fleet_state
  ADD COLUMN parent_report_quiet_s integer NOT NULL DEFAULT 60 CHECK (parent_report_quiet_s BETWEEN 1 AND 86400);
ALTER TABLE fleet_agents ADD COLUMN terminal_reported_at timestamptz;

-- ── The approved runtime is immutable while a release is running: it cannot
-- change while any lease is open or any child is living. Clearing it (which
-- blocks all replication) is always allowed.
CREATE FUNCTION fleet_state_runtime_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF (OLD.runtime_repo, OLD.runtime_commit, OLD.runtime_build_id, OLD.runtime_lockfile_sha256)
       IS DISTINCT FROM (NEW.runtime_repo, NEW.runtime_commit, NEW.runtime_build_id, NEW.runtime_lockfile_sha256)
     AND NEW.runtime_repo IS NOT NULL
     AND (EXISTS (SELECT 1 FROM fleet_reservations WHERE status IN ('reserved','provisioning'))
          OR EXISTS (SELECT 1 FROM fleet_agents WHERE role = 'child' AND status IN ('reserved','provisioning','active','unresponsive'))) THEN
    RAISE EXCEPTION 'FLEET_RUNTIME_IMMUTABLE: the approved runtime cannot change while leases are open or children are living (clear it, drain, then approve)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_state_runtime_guard BEFORE UPDATE ON fleet_state
  FOR EACH ROW EXECUTE FUNCTION fleet_state_runtime_guard();

-- ── Sandbox termination queue. A death with a known sandbox enqueues a
-- termination; the controller works the queue. 'unsupported' means the
-- provider cannot stop it (a deployment blocker, surfaced by fleet:doctor).
CREATE TABLE fleet_sandbox_terminations (
  agent_id        text        PRIMARY KEY REFERENCES fleet_agents(agent_id),
  sandbox_id      text        NOT NULL,
  status          text        NOT NULL CHECK (status IN ('pending','terminated','unsupported','failed')),
  requested_at    timestamptz NOT NULL DEFAULT now(),
  attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at timestamptz,
  completed_at    timestamptz,
  last_error      text,
  CHECK ((status IN ('terminated','unsupported')) = (completed_at IS NOT NULL))
);
CREATE TRIGGER fleet_sandbox_terminations_no_delete BEFORE DELETE ON fleet_sandbox_terminations
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_sandbox_terminations_no_truncate BEFORE TRUNCATE ON fleet_sandbox_terminations
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_agent_json(a fleet_agents) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'agentId', a.agent_id, 'parentAgentId', a.parent_agent_id, 'role', a.role, 'generation', a.generation,
    'name', a.name, 'walletAddress', a.wallet_address, 'runtimeVersion', a.runtime_version,
    'runtimeRepo', a.runtime_repo, 'runtimeCommit', a.runtime_commit, 'sandboxId', a.sandbox_id,
    'localChildId', a.local_child_id, 'status', a.status, 'statusReason', a.status_reason,
    'requestedBy', a.requested_by, 'createdAt', a.created_at, 'updatedAt', a.updated_at,
    'lastHeartbeat', a.last_heartbeat, 'deathTime', a.death_time)
$$;

-- Death now also enqueues termination of the agent's sandbox (idempotent).
CREATE OR REPLACE FUNCTION fleet_mark_dead(p_agent text, p_reason text, p_actor text, p_cause text) RETURNS boolean LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_status text; v_sandbox text; v_reason text := fleet_scrub(p_reason);
BEGIN
  PERFORM fleet_lock_state();
  UPDATE fleet_agents
     SET status = CASE WHEN status IN ('active','unresponsive') THEN 'dead' ELSE 'failed' END,
         status_reason = v_reason, death_time = now(), updated_at = now()
   WHERE agent_id = p_agent AND status IN ('reserved','provisioning','active','unresponsive')
   RETURNING status, sandbox_id INTO v_status, v_sandbox;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE fleet_reservations SET status = 'released', ended_at = now(), end_reason = v_reason, updated_at = now()
   WHERE agent_id = p_agent AND status IN ('reserved','provisioning');
  UPDATE fleet_agent_credentials SET revoked_at = now() WHERE agent_id = p_agent AND revoked_at IS NULL;
  PERFORM fleet_event('agent_died', p_agent, p_actor, jsonb_build_object('reason', v_reason, 'cause', p_cause, 'status', v_status));
  PERFORM fleet_event('slot_released', p_agent, p_actor, jsonb_build_object('reason', v_reason));
  IF v_sandbox IS NOT NULL THEN
    INSERT INTO fleet_sandbox_terminations (agent_id, sandbox_id, status) VALUES (p_agent, v_sandbox, 'pending')
      ON CONFLICT (agent_id) DO NOTHING;
    IF FOUND THEN
      PERFORM fleet_event('sandbox_termination_requested', p_agent, p_actor, jsonb_build_object('sandboxId', v_sandbox));
    END IF;
  END IF;
  RETURN true;
END $$;

-- Reaper: as V2, plus parent-reported children that have stayed quiet for
-- parent_report_quiet_s die without waiting for the full heartbeat timeout.
CREATE OR REPLACE FUNCTION fleet_reap(p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st fleet_state; v_grace timestamptz; v_expired integer; v_unresp integer := 0; v_dead integer := 0; r record;
BEGIN
  st := fleet_lock_state();
  IF st.reaper_last_run_at IS NULL OR st.reaper_grace_from IS NULL
     OR now() - st.reaper_last_run_at > make_interval(secs => st.heartbeat_unresponsive_s) THEN
    v_grace := now();
    PERFORM fleet_event('reaper_resumed', NULL, p_actor, jsonb_build_object('lastRunAt', st.reaper_last_run_at));
  ELSE
    v_grace := st.reaper_grace_from;
  END IF;
  UPDATE fleet_state SET reaper_last_run_at = now(), reaper_grace_from = v_grace WHERE id = 1;

  v_expired := fleet_expire_leases(p_actor);

  FOR r IN SELECT agent_id FROM fleet_agents
            WHERE status IN ('active','unresponsive') AND terminal_reported_at IS NOT NULL
              AND GREATEST(COALESCE(last_heartbeat, updated_at), v_grace) < now() - make_interval(secs => st.parent_report_quiet_s)
            ORDER BY agent_id LOOP
    IF fleet_mark_dead(r.agent_id, format('parent reported terminal; no heartbeat for more than %s s', st.parent_report_quiet_s),
                       p_actor, 'parent_reported') THEN
      v_dead := v_dead + 1;
    END IF;
  END LOOP;

  FOR r IN SELECT agent_id FROM fleet_agents
            WHERE status = 'unresponsive'
              AND GREATEST(COALESCE(last_heartbeat, updated_at), v_grace) < now() - make_interval(secs => st.heartbeat_dead_s)
            ORDER BY agent_id LOOP
    IF fleet_mark_dead(r.agent_id, format('no heartbeat for more than %s s', st.heartbeat_dead_s), p_actor, 'heartbeat_timeout') THEN
      v_dead := v_dead + 1;
    END IF;
  END LOOP;

  FOR r IN SELECT agent_id, last_heartbeat FROM fleet_agents
            WHERE status = 'active'
              AND GREATEST(COALESCE(last_heartbeat, updated_at), v_grace) < now() - make_interval(secs => st.heartbeat_unresponsive_s)
            ORDER BY agent_id FOR UPDATE LOOP
    UPDATE fleet_agents SET status = 'unresponsive', updated_at = now() WHERE agent_id = r.agent_id AND status = 'active';
    PERFORM fleet_event('agent_unresponsive', r.agent_id, p_actor,
      jsonb_build_object('lastHeartbeat', r.last_heartbeat, 'timeoutS', st.heartbeat_unresponsive_s));
    v_unresp := v_unresp + 1;
  END LOOP;

  RETURN jsonb_build_object('expired', v_expired, 'unresponsive', v_unresp, 'dead', v_dead, 'graceFrom', v_grace);
END $$;

-- ── Controller API (SECURITY DEFINER; the only functions granted to the service role)

-- reserved -> provisioning, exactly once; issues the attestation nonce.
CREATE FUNCTION svc_claim(p_agent text, p_local_child text, p_parent text, p_ttl_ms bigint, p_nonce text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st fleet_state; l fleet_reservations; a fleet_agents; v_ttl double precision;
BEGIN
  IF p_nonce IS NULL OR p_nonce !~ '^[0-9a-f]{64}$' OR p_local_child IS NULL OR length(p_local_child) > 64 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'Replication denied: malformed claim.');
  END IF;
  st := fleet_lock_state();
  SELECT * INTO l FROM fleet_reservations WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR l.status <> 'reserved' OR l.expires_at <= now() THEN
    RETURN jsonb_build_object('ok', false,
      'reason', format('Replication denied: fleet reservation %s is invalid, expired, or already used.', p_agent));
  END IF;
  IF p_parent IS NOT NULL AND l.parent_agent_id <> p_parent THEN
    RETURN jsonb_build_object('ok', false,
      'reason', format('Replication denied: reservation %s belongs to another parent.', l.reservation_id));
  END IF;
  v_ttl := COALESCE(p_ttl_ms, st.provisioning_ttl_s::bigint * 1000)::double precision / 1000;
  UPDATE fleet_agents SET status = 'provisioning', local_child_id = p_local_child, updated_at = now(),
         reservation_expires_at = now() + make_interval(secs => v_ttl)
   WHERE agent_id = p_agent AND status = 'reserved'
   RETURNING * INTO a;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false,
      'reason', format('Replication denied: fleet reservation %s is invalid, expired, or already used.', p_agent));
  END IF;
  UPDATE fleet_reservations SET status = 'provisioning', claimed_at = now(), attestation_nonce = p_nonce,
         expires_at = now() + make_interval(secs => v_ttl), updated_at = now()
   WHERE reservation_id = l.reservation_id AND status = 'reserved';
  PERFORM fleet_event('slot_claimed', p_agent, p_parent,
    jsonb_build_object('localChildId', p_local_child, 'reservationId', l.reservation_id));
  RETURN jsonb_build_object('ok', true, 'agentId', p_agent, 'parentAgentId', a.parent_agent_id, 'generation', a.generation,
    'reservationId', l.reservation_id, 'repo', l.expected_repo, 'commit', l.expected_commit,
    'buildId', l.expected_build_id, 'lockfileSha256', l.expected_lockfile_sha256);
END $$;

-- provisioning -> active, only with a runtime proof matching the lease. The
-- check here is authoritative and independent of the service's own check:
-- nonce, commit (reported and attested), repository, lockfile, build id,
-- clean tree and proof hash. A mismatch releases the slot as failed.
CREATE FUNCTION svc_activate(p_agent text, p_parent text, p_wallet text, p_sandbox text, p_runtime_commit text,
                             p_runtime_version text, p_attestation jsonb, p_actor text, p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; l fleet_reservations; v_fail text; att jsonb := COALESCE(p_attestation, 'null'::jsonb);
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'credential hash malformed');
  END IF;
  PERFORM fleet_lock_state();
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR a.status <> 'provisioning' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE',
      'reason', format('Cannot activate fleet agent %s: not in provisioning state', p_agent));
  END IF;
  SELECT * INTO l FROM fleet_reservations WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR l.status <> 'provisioning' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE',
      'reason', format('Cannot activate fleet agent %s: no open provisioning lease', p_agent));
  END IF;
  IF p_parent IS NOT NULL AND l.parent_agent_id <> p_parent THEN
    PERFORM fleet_event('authorization_denied', NULL, p_actor,
      jsonb_build_object('action', 'activate', 'reservationId', l.reservation_id));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_AUTHORIZED',
      'reason', format('Activation denied: reservation %s belongs to another parent.', l.reservation_id));
  END IF;
  IF l.expires_at <= now() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_AUTHORIZED',
      'reason', format('Activation denied: provisioning lease %s has expired.', l.reservation_id));
  END IF;

  IF jsonb_typeof(att) IS DISTINCT FROM 'object' THEN v_fail := 'no attestation';
  ELSIF p_runtime_commit IS DISTINCT FROM l.expected_commit THEN v_fail := 'reported commit does not match the lease';
  ELSIF l.attestation_nonce IS NULL OR att->>'nonce' IS DISTINCT FROM l.attestation_nonce THEN v_fail := 'nonce does not match the lease';
  ELSIF att->>'commit' IS DISTINCT FROM l.expected_commit THEN v_fail := 'attested commit does not match the lease';
  ELSIF att->>'repo' IS DISTINCT FROM l.expected_repo THEN v_fail := 'attested repository does not match the lease';
  ELSIF att->>'lockfileSha256' IS DISTINCT FROM l.expected_lockfile_sha256 THEN v_fail := 'attested lockfile does not match the lease';
  ELSIF att->>'buildId' IS DISTINCT FROM l.expected_build_id THEN v_fail := 'attested build id does not match the lease';
  ELSIF att->'clean' IS DISTINCT FROM 'true'::jsonb THEN v_fail := 'attested runtime tree is not clean';
  ELSIF att->>'proof' IS DISTINCT FROM encode(sha256(convert_to(
          (att->>'nonce') || ':' || (att->>'commit') || ':' || (att->>'buildId') || ':' || (att->>'lockfileSha256'), 'UTF8')), 'hex') THEN
    v_fail := 'attestation proof is inconsistent';
  END IF;
  IF v_fail IS NOT NULL THEN
    PERFORM fleet_event('runtime_verification_failed', p_agent, p_actor,
      jsonb_build_object('reason', 'controller check: ' || v_fail, 'reservationId', l.reservation_id));
    PERFORM fleet_release(p_agent, 'runtime verification failed: ' || v_fail, 'failed', p_actor);
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_RUNTIME_UNVERIFIED', 'reason', 'Runtime verification failed: ' || v_fail);
  END IF;

  UPDATE fleet_agents SET status = 'active', wallet_address = p_wallet, sandbox_id = p_sandbox,
         runtime_version = COALESCE(att->>'version', p_runtime_version),
         last_heartbeat = now(), reservation_expires_at = NULL, updated_at = now()
   WHERE agent_id = p_agent AND status = 'provisioning'
   RETURNING * INTO a;
  UPDATE fleet_reservations SET status = 'completed', completed_at = now(), attested_at = now(),
         attestation = att, updated_at = now()
   WHERE reservation_id = l.reservation_id AND status = 'provisioning';
  PERFORM fleet_event('runtime_verified', p_agent, p_actor, jsonb_build_object('reservationId', l.reservation_id,
    'commit', att->>'commit', 'buildId', att->>'buildId', 'lockfileSha256', att->>'lockfileSha256'));
  PERFORM fleet_event('agent_activated', p_agent, p_actor, jsonb_build_object('walletAddress', p_wallet,
    'sandboxId', p_sandbox, 'runtimeCommit', att->>'commit'));
  INSERT INTO fleet_agent_credentials (agent_id, token_hash) VALUES (p_agent, p_token_hash)
    ON CONFLICT (agent_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = now(), revoked_at = NULL;
  PERFORM fleet_event('credential_issued', p_agent, p_actor, '{}'::jsonb);
  RETURN jsonb_build_object('ok', true, 'agent', fleet_agent_json(a));
END $$;

CREATE FUNCTION svc_verification_failed(p_agent text, p_reason text, p_actor text) RETURNS boolean LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_event('runtime_verification_failed', p_agent, p_actor, jsonb_build_object('reason', fleet_scrub(p_reason)));
  RETURN fleet_release(p_agent, 'runtime verification failed: ' || COALESCE(p_reason, ''), 'failed', p_actor);
END $$;

CREATE FUNCTION svc_release(p_agent text, p_reason text, p_actor text) RETURNS boolean LANGUAGE sql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT fleet_release(p_agent, p_reason, 'released', p_actor)
$$;

CREATE FUNCTION svc_mark_dead(p_agent text, p_reason text, p_actor text, p_cause text) RETURNS boolean LANGUAGE sql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT fleet_mark_dead(p_agent, p_reason, p_actor, left(COALESCE(p_cause, 'reported'), 32))
$$;

CREATE FUNCTION svc_heartbeat(p_agent text) RETURNS text LANGUAGE sql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT fleet_heartbeat(p_agent, p_agent)
$$;

CREATE FUNCTION svc_reap(p_actor text) RETURNS jsonb LANGUAGE sql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT fleet_reap(p_actor)
$$;

CREATE FUNCTION svc_record_event(p_type text, p_agent text, p_actor text, p_detail jsonb) RETURNS void LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_type IS NULL OR p_type !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'FLEET_BAD_EVENT: invalid event type';
  END IF;
  PERFORM fleet_event(p_type, left(p_agent, 64), p_actor, p_detail);
END $$;

-- A parent reports that its child's local lifecycle ended. Unclaimed or
-- provisioning children are released at once; a living child that has been
-- quiet for parent_report_quiet_s dies now, otherwise it is flagged so the
-- reaper retires it once it goes quiet. A child that keeps heartbeating is
-- never killed on its parent's word.
CREATE FUNCTION svc_child_terminal(p_parent text, p_local_child text, p_state text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; st fleet_state; v_outcome text; v_changed boolean := false;
        v_state text := left(COALESCE(p_state, ''), 32);
BEGIN
  SELECT * INTO a FROM fleet_agents WHERE local_child_id = p_local_child;
  IF NOT FOUND OR a.parent_agent_id IS DISTINCT FROM p_parent THEN
    PERFORM fleet_event('authorization_denied', NULL, p_parent,
      jsonb_build_object('action', 'child_terminal', 'localChildId', left(p_local_child, 64)));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_AUTHORIZED');
  END IF;
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  IF a.status IN ('reserved','provisioning') THEN
    v_changed := fleet_release(a.agent_id, 'parent reported child terminal: ' || v_state, 'failed', p_parent);
    v_outcome := 'released';
  ELSIF a.status IN ('active','unresponsive') THEN
    UPDATE fleet_agents SET terminal_reported_at = COALESCE(terminal_reported_at, now()) WHERE agent_id = a.agent_id;
    IF COALESCE(a.last_heartbeat, a.updated_at) < now() - make_interval(secs => st.parent_report_quiet_s) THEN
      v_changed := fleet_mark_dead(a.agent_id,
        format('parent reported terminal (%s); no heartbeat for more than %s s', v_state, st.parent_report_quiet_s),
        p_parent, 'parent_reported');
      v_outcome := 'dead';
    ELSE
      v_outcome := 'deferred';
    END IF;
  ELSE
    v_outcome := 'already_terminal';
  END IF;
  PERFORM fleet_event('child_terminal_reported', a.agent_id, p_parent,
    jsonb_build_object('localChildId', p_local_child, 'state', v_state, 'outcome', v_outcome));
  RETURN jsonb_build_object('ok', true, 'outcome', v_outcome, 'changed', v_changed);
END $$;

-- Terminations due: pending, or failed with attempts left and not tried in the last minute.
CREATE FUNCTION svc_terminations_due(p_limit integer) RETURNS jsonb LANGUAGE sql STABLE
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('agentId', agent_id, 'sandboxId', sandbox_id, 'attempts', attempts)), '[]'::jsonb)
    FROM (SELECT * FROM fleet_sandbox_terminations
           WHERE status = 'pending'
              OR (status = 'failed' AND attempts < 5 AND last_attempt_at < now() - interval '60 seconds')
           ORDER BY requested_at LIMIT LEAST(GREATEST(p_limit, 1), 100)) t
$$;

CREATE FUNCTION svc_termination_result(p_agent text, p_status text, p_error text, p_actor text) RETURNS boolean LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_sandbox text;
BEGIN
  IF p_status NOT IN ('terminated','unsupported','failed') THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: termination status %', p_status;
  END IF;
  UPDATE fleet_sandbox_terminations
     SET status = p_status, attempts = attempts + 1, last_attempt_at = now(), last_error = fleet_scrub(p_error),
         completed_at = CASE WHEN p_status IN ('terminated','unsupported') THEN now() END
   WHERE agent_id = p_agent AND status IN ('pending','failed')
   RETURNING sandbox_id INTO v_sandbox;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM fleet_event(CASE p_status WHEN 'terminated' THEN 'sandbox_terminated'
                                    WHEN 'unsupported' THEN 'sandbox_termination_unsupported'
                                    ELSE 'sandbox_termination_failed' END,
                      p_agent, p_actor, jsonb_build_object('sandboxId', v_sandbox, 'error', fleet_scrub(p_error)));
  RETURN true;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
```

### 2.4 Version 4 — `lifecycle_health_sessions_provisioning_orphans_custody`

- **Source:** `src/fleet/postgres/migrations-phase5.ts:26-885` (`export function v4Sql(hardMax)`, header comment `1-24`). Called as `v4Sql(FLEET_PG_HARD_MAX_AGENTS)` (`migrations.ts:1118`). Commit `e5ac7fe`.
- **Purpose (Phase 5 lifecycle):** TERMINATING and ORPHANED statuses (orphan holds a quarantine slot
  counted against the cap); controller health challenges (a heartbeat alone never keeps a slot);
  revocation of every capability when an agent leaves the living population (trigger — no code path
  can forget it); provisioning records tracked from claim; orphan audit; short-lived sessions and a
  request-nonce ledger (replay protection); wallet custody records; spend-request decisions.
- **Interpolations:**

| Expression | Line | Resolved |
|---|---|---|
| `${hardMax}` in `fleet_state_population` | 55 | `50` |
| `${hardMax}` twice in `fleet_reserve_slot` | 711 | `50` |

- **Data migrations:** `activated_at = COALESCE(last_heartbeat, updated_at)` for active/unresponsive;
  `unresponsive_since = updated_at` for unresponsive; `fleet_wallet_custody` backfill for every agent
  with a wallet (frozen with reason `agent <status>` unless active/unresponsive).

#### Changes to existing tables

`fleet_agents`:
- status CHECK: `IN ('reserved','provisioning','active','unresponsive','terminating','orphaned','dead','failed')`.
- `fleet_agents_sandbox_live_uq` live set adds `terminating`, `orphaned`.
- New columns:

| Column | Type | Default | NOT NULL | CHECK |
|---|---|---|---|---|
| `activated_at` | timestamptz | — | no | — |
| `last_challenge_ok_at` | timestamptz | — | no | — |
| `challenge_failures` | integer | `0` | yes | `>= 0` |
| `unresponsive_since` | timestamptz | — | no | — |
| `health_reason` | text | — | no | — |
| `quarantined_at` | timestamptz | — | no | — |

`fleet_state` new columns:

| Column | Type | Default | NOT NULL | CHECK |
|---|---|---|---|---|
| `quarantined_slots` | integer | `0` | yes | `>= 0` |
| `health_challenge_interval_s` | integer | `60` | yes | `BETWEEN 1 AND 86400` |
| `challenge_ttl_s` | integer | `60` | yes | `BETWEEN 5 AND 3600` |
| `health_grace_s` | integer | `300` | yes | `BETWEEN 10 AND 86400` |
| `max_challenge_failures` | integer | `3` | yes | `BETWEEN 1 AND 100` |
| `termination_grace_s` | integer | `480` | yes | `BETWEEN 1 AND 604800` |
| `orphan_slot_hold_s` | integer | `259200` (72 h) | yes | `>= 0` |
| `max_open_orphans` | integer | `1` | yes | `>= 0` |
| `session_ttl_s` | integer | `600` | yes | `BETWEEN 30 AND 3600` |

Named constraint `fleet_state_population CHECK (living_agents + reserved_slots + quarantined_slots <= 50)` (V1's `living + reserved <= 50` remains as well).

Replaced functions: `fleet_bucket` (living = active, unresponsive, terminating; `orphaned` → `'quarantined'`);
`fleet_agents_counters` (now pinned; maintains `quarantined_slots`; cap check on entry uses
`living + reserved + quarantined > max_agents`, message `FLEET_CAP_EXCEEDED: % living + % reserved + % quarantined > max %`);
`fleet_state_counter_guard` (also protects `quarantined_slots`); `fleet_agents_transition_guard`
(pinned; adds active→terminating, unresponsive→terminating, terminating→orphaned|dead, orphaned→dead);
`fleet_state_json` (adds `quarantinedSlots`); `fleet_authenticate` (sessions, quarantine);
`fleet_heartbeat` (health-gated recovery); `api_heartbeat`; `svc_termination_result` (orphan
handling); `fleet_reserve_slot` (quarantine + orphan + frozen-parent checks); `fleet_reap` (7-step pass).

#### New tables

`fleet_agent_sessions` — short-lived session tokens (`fs1.` prefix), hash only:

| Column | Type | Default | NOT NULL | Constraint |
|---|---|---|---|---|
| `session_hash` | text | — | (PK) | PK; `~ '^[0-9a-f]{64}$'` |
| `agent_id` | text | — | yes | FK → fleet_agents |
| `created_at` | timestamptz | `now()` | yes | — |
| `expires_at` | timestamptz | — | yes | — |
| `revoked_at` | timestamptz | — | no | — |

Index `fleet_agent_sessions_agent_idx (agent_id, expires_at)`. No immutability triggers (the reaper
deletes sessions expired for more than 1 day).

`fleet_request_nonces` — request replay ledger:

| Column | Type | Default | NOT NULL | Constraint |
|---|---|---|---|---|
| `agent_id` | text | — | yes | PK part; **no FK** |
| `nonce` | text | — | yes | PK part; `~ '^[A-Za-z0-9_-]{16,64}$'` |
| `expires_at` | timestamptz | — | yes | — |

PRIMARY KEY `(agent_id, nonce)`. Reaper deletes rows with `expires_at < now()`.

`fleet_wallet_custody` — controller supervision of each agent wallet:

| Column | Type | Default | NOT NULL | Constraint |
|---|---|---|---|---|
| `agent_id` | text | — | (PK) | PK; FK → fleet_agents |
| `wallet_address` | text | — | yes | unique index `fleet_wallet_custody_wallet_uq` on `lower(wallet_address)` |
| `custody_mode` | text | `'controller_supervised'` | yes | `IN ('controller_supervised','controller_signer')` |
| `spending_frozen` | boolean | `false` | yes | — |
| `frozen_reason` | text | — | no | — |
| `frozen_at` | timestamptz | — | no | — |
| `daily_limit_cents` | bigint | `0` | yes | `>= 0` |
| `supervisor` | text | `'fleetadmin'` | yes | — |
| `updated_at` | timestamptz | `now()` | yes | — |

No delete/truncate protection. Default daily limit 0 → every spend without an allocation is denied.

`fleet_provisioning` — every claimed reservation tracked before any sandbox exists:

| Column | Type | Default | NOT NULL | Constraint |
|---|---|---|---|---|
| `provisioning_id` | text | — | (PK) | PK; ULID CHECK (equals the reservation id) |
| `reservation_id` | text | — | yes | UNIQUE; FK → fleet_reservations |
| `parent_agent_id` | text | — | yes | FK → fleet_agents |
| `expected_agent_id` | text | — | yes | UNIQUE; FK → fleet_agents |
| `expected_runtime_commit` | text | — | yes | `~ '^[0-9a-f]{40}$'` |
| `sandbox_id` | text | — | no | `length BETWEEN 1 AND 128` |
| `created_at` | timestamptz | `now()` | yes | — |
| `updated_at` | timestamptz | `now()` | yes | — |
| `activation_deadline` | timestamptz | — | yes | — |
| `status` | text | `'provisioning'` | yes | `IN ('provisioning','verifying','active','failed_provisioning','orphaned')` |
| `cleanup_status` | text | `'none'` | yes | `IN ('none','not_required','pending','terminated','unsupported','failed')` |
| `failure_reason` | text | — | no | — |

Index `fleet_provisioning_cleanup_idx (cleanup_status) WHERE cleanup_status IN ('pending','unsupported','failed')`.
Trigger `fleet_provisioning_no_delete` (BEFORE DELETE ROW). No TRUNCATE trigger.

`fleet_orphans` — external infrastructure that could not be stopped (never deleted):

| Column | Type | Default | NOT NULL | Constraint |
|---|---|---|---|---|
| `orphan_id` | bigserial (`fleet_orphans_orphan_id_seq`) | nextval | (PK) | PK |
| `agent_id` | text | — | yes | FK → fleet_agents |
| `provisioning_id` | text | — | no | FK → fleet_provisioning |
| `sandbox_id` | text | — | yes (V6 drops NOT NULL) | — |
| `reason` | text | — | yes | — |
| `holds_slot` | boolean | — | yes | — |
| `detected_at` | timestamptz | `now()` | yes | — |
| `slot_released_at` | timestamptz | — | no | — |
| `resolved_at` | timestamptz | — | no | — |
| `resolution` | text | — | no | — |
| `resolved_by` | text | — | no | — |

Index `fleet_orphans_open_uq` UNIQUE `(agent_id) WHERE resolved_at IS NULL` (one open orphan per agent).
Trigger `fleet_orphans_no_delete`.

`fleet_health_challenges`:

| Column | Type | Default | NOT NULL | Constraint |
|---|---|---|---|---|
| `challenge_id` | text | — | (PK) | PK; ULID CHECK |
| `agent_id` | text | — | yes | FK → fleet_agents |
| `nonce_hash` | text | — | yes | `~ '^[0-9a-f]{64}$'` (SHA-256 of the nonce; the nonce is never stored) |
| `canary` | text | — | yes | (one of `HEALTH_CANARIES`, `store.ts:121-127`, truncated to 200) |
| `issued_at` | timestamptz | `now()` | yes | — |
| `expires_at` | timestamptz | — | yes | — |
| `answered_at` | timestamptz | — | no | — |
| `outcome` | text | `'pending'` | yes | `IN ('pending','passed','failed','expired')` |
| `detail` | text | — | no | — |

Indexes `fleet_health_challenges_agent_idx (agent_id, issued_at DESC)`; `fleet_health_challenges_pending_uq`
UNIQUE `(agent_id) WHERE outcome = 'pending'` (one pending challenge per agent).

`fleet_spend_requests` — spend **decisions only** (nothing is signed or sent):

| Column | Type | Default | NOT NULL | Constraint |
|---|---|---|---|---|
| `request_id` | text | — | (PK) | PK; ULID CHECK |
| `agent_id` | text | — | yes | FK → fleet_agents |
| `wallet_address` | text | — | yes | — |
| `to_address` | text | — | yes | — (format checked in `api_request_spend`) |
| `amount_cents` | bigint | — | yes | `> 0` |
| `purpose` | text | — | yes | — |
| `allocation_id` | text | — | no | **no FK** |
| `decision` | text | — | yes | `IN ('denied','approved_not_executed')` |
| `reason` | text | — | no | — |
| `created_at` | timestamptz | `now()` | yes | — |

Trigger `fleet_spend_requests_no_change` BEFORE UPDATE OR DELETE → append-only.

#### V4 new functions and triggers

| Function | Returns | SECDEF | search_path | Behaviour |
|---|---|---|---|---|
| `fleet_agents_lifecycle_stamps()` | trigger | no | none | BEFORE INSERT OR UPDATE OF status: `activated_at` set on entry to `active` from insert/reserved/provisioning; `unresponsive_since` set on →unresponsive, cleared on →active; `quarantined_at` set (first time) on →terminating/orphaned |
| `fleet_agents_lifecycle_effects()` | trigger | no | pinned | AFTER UPDATE OF status. **Credential revocation:** on →terminating/orphaned/dead/failed: `fleet_agent_credentials.revoked_at = now()`, all sessions revoked, custody `spending_frozen = true` (`frozen_reason = 'agent <status>'`), pending challenges → `expired`. reserved/provisioning→failed: provisioning row → `failed_provisioning` (`cleanup_status` `not_required` if no sandbox else `pending`) and, with a sandbox, enqueue termination + event `sandbox_termination_requested{phase:'failed_provisioning'}`. provisioning→active: provisioning sandbox must equal activation sandbox else `FLEET_SANDBOX_MISMATCH: activation sandbox % differs from provisioned sandbox %`; provisioning row → `active`/`not_required`; custody row created for the wallet |
| `fleet_agents_custody_on_insert()` | trigger | no | pinned | AFTER INSERT: custody row for a registered wallet (roots) |
| `api_open_session(p_agent, p_token, p_session_hash)` | jsonb | **yes** | pinned | GRANTED agent. A session token (`fs1.%`), NULL token or malformed hash is refused (`db_auth_failed{why:'session tokens cannot open sessions'}`, `FLEET_AUTH_FAILED`); authenticates with the long-lived credential; revokes all but the newest 7 live sessions (`OFFSET 7`, so at most 8 live after insert); inserts the session with `expires_at = now() + session_ttl_s`; event `session_opened`; returns `{ok, expiresAt, ttlS}` |
| `svc_consume_nonce(p_agent, p_nonce, p_ttl_s integer)` | boolean | **yes** | pinned | nonce must match `^[A-Za-z0-9_-]{16,64}$`; `INSERT … ON CONFLICT DO NOTHING` with TTL clamped to 1..3600 s; replay → event `request_replayed{nonce: first 16 chars}` and false |
| `svc_provision_update(p_agent, p_parent, p_phase, p_sandbox)` | jsonb | **yes** | pinned | (V4 form, replaced V6) phases `sandbox_created`, `verifying` |
| `fleet_reservations_provisioning()` | trigger | no | pinned | AFTER UPDATE OF status ON fleet_reservations: reserved→provisioning inserts `fleet_provisioning(provisioning_id = reservation_id, …, activation_deadline = NEW.expires_at) ON CONFLICT (reservation_id) DO NOTHING` + event `provisioning_started` |
| `fleet_begin_termination(p_agent, p_reason, p_actor, p_cause)` | text | no | pinned | owner-only (reaper, `fleet:admin quarantine`). State lock; only active/unresponsive; no sandbox → `fleet_mark_dead`, returns `'dead'`; else →`terminating` (lifecycle trigger revokes everything first), enqueue termination, events `agent_terminating{capabilitiesRevoked:true}`, `sandbox_termination_requested`; returns `'terminating'` |
| `svc_termination_result` (replaced) | boolean | **yes** | pinned | state lock; `v_orphan = unsupported OR (failed AND attempts >= 5)`; updates non-active provisioning row's `cleanup_status`/`status` (`orphaned` when v_orphan); terminating agent: terminated → `dead` + `agent_died{cause:'terminated'}` + `slot_released`; v_orphan → `orphaned`, orphan row `holds_slot = true`, event `agent_orphaned`; non-terminating agent with v_orphan → orphan row `holds_slot = false`, event `infrastructure_orphaned` |
| `fleet_heartbeat` (replaced) | text | no | pinned | unresponsive → active **only** if health is fresh: `COALESCE(last_challenge_ok_at, activated_at, created_at) >= now() - health_grace_s` and `challenge_failures < max_challenge_failures`; otherwise only `last_heartbeat` is updated and the status returned |
| `api_heartbeat` (replaced) | jsonb | **yes** | pinned | `FLEET_AGENT_DEAD` / `FLEET_AGENT_QUARANTINED` return `{ok:false, code, status}`; `ok` true for active **and** unresponsive (an unhealthy agent keeps answering challenges) |
| `svc_issue_challenge(p_agent, p_challenge_id, p_nonce_hash, p_canary)` | jsonb | **yes** | pinned | only living agents (`{issued:false, reason:'not living'}`); an unexpired pending challenge → `'pending'`; an expired pending one is expired first; last passed less than `health_challenge_interval_s` ago → `'not due'`; inserts with `expires_at = now() + challenge_ttl_s` |
| `fleet_challenge_failed(p_agent, p_detail)` | void | no | pinned | `challenge_failures + 1`, `health_reason`; event `health_challenge_failed` (actor `'controller'`); active agent at `max_challenge_failures` → unresponsive + `agent_unresponsive{cause:'health_challenge'}` |
| `fleet_expire_challenge(p_challenge)` | void | no | pinned | pending → `expired` and `fleet_challenge_failed(…,'challenge expired unanswered')` |
| `svc_answer_challenge(p_agent, p_challenge_id, p_nonce, p_commit, p_build_id, p_policy_ok boolean)` | jsonb | **yes** | pinned | challenge must belong to the agent (`FLEET_NOT_AUTHORIZED`), be pending (`FLEET_CHALLENGE_USED`) and unexpired (`FLEET_CHALLENGE_EXPIRED`); failure ladder: agent not living; `sha256(nonce)` ≠ stored hash; child commit ≠ lease `expected_commit`; child build ≠ lease `expected_build_id`; root commit ≠ registered `runtime_commit` (when set); `p_policy_ok` not true (`policy canary not blocked`) → `failed`, `fleet_challenge_failed`, `FLEET_CHALLENGE_FAILED`. Pass → `passed`, `last_challenge_ok_at = now()`, `challenge_failures = 0`; unresponsive with a heartbeat fresher than `heartbeat_unresponsive_s` → active + `agent_recovered{via:'health_challenge'}` |

**Authentication (V4 `fleet_authenticate`).** Hash the token once. Token starting `fs1.` → look up
`fleet_agent_sessions` by hash; must belong to `p_agent` (`bad session`). Otherwise → credential by
agent id and hash equality (`bad credential`). Then: dead/failed → `FLEET_AGENT_DEAD`;
terminating/orphaned → `db_auth_failed{why:'quarantined'}` + `FLEET_AGENT_QUARANTINED`; revoked
session or credential → `db_auth_failed{why:'revoked'}` + `FLEET_AUTH_FAILED`; expired session →
`FLEET_SESSION_EXPIRED`; session whose agent's credential is revoked → `FLEET_AUTH_FAILED`.

**Allocator (V4).** Adds: `v_occ = living + reserved + quarantined`; after the pin check,
`count(unresolved orphans) > max_open_orphans` → `FLEET_ORPHANS_UNRESOLVED`; after the parent check,
parent custody `spending_frozen` → `FLEET_PARENT_FROZEN`; cap check uses `v_occ >= mx`;
`reservation_denied` detail adds `quarantined`.

**Reaper (V4), order per pass:** (1) lease expiry; (2) expire pending challenges past `expires_at`;
(3) parent-reported quiet children → dead; (4) unresponsive agents past `heartbeat_dead_s` (by heartbeat)
or past `termination_grace_s` (by `unresponsive_since`) → `fleet_begin_termination` with cause
`heartbeat_timeout` or `health_timeout`; (5) active agents with stale heartbeat
(`heartbeat_unresponsive_s`), stale health (`COALESCE(last_challenge_ok_at, activated_at, created_at)`
older than `health_grace_s`) or `challenge_failures >= max_challenge_failures` → unresponsive
(`health_reason` 'heartbeat stale' / 'health challenge stale or failing'); (6) when
`orphan_slot_hold_s > 0`: orphaned agents with `quarantined_at` older than the hold → `dead`,
orphan `slot_released_at = now()` (orphan stays open), event `orphan_slot_released`; (7)
`DELETE FROM fleet_request_nonces WHERE expires_at < now()` and
`DELETE FROM fleet_agent_sessions WHERE expires_at < now() - interval '1 day'`. All timestamps use the
V2 grace rule. Returns `{expired, unresponsive, dead, terminating, orphanSlotsReleased, challengesExpired, graceFrom}`.

**V4 triggers** (new): `fleet_agents_lifecycle_stamps` (BEFORE INSERT OR UPDATE OF status),
`fleet_provisioning_no_delete`, `fleet_orphans_no_delete`, `fleet_agents_lifecycle_effects`
(AFTER UPDATE OF status), `fleet_agents_custody_on_insert` (AFTER INSERT),
`fleet_reservations_provisioning` (AFTER UPDATE OF status ON fleet_reservations),
`fleet_spend_requests_no_change` (BEFORE UPDATE OR DELETE).

Grants in V4: `REVOKE ALL ON ALL TABLES / ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC; REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;`

#### V4 exact SQL

```sql
-- ── Lifecycle statuses
ALTER TABLE fleet_agents DROP CONSTRAINT fleet_agents_status_check;
ALTER TABLE fleet_agents ADD CONSTRAINT fleet_agents_status_check
  CHECK (status IN ('reserved','provisioning','active','unresponsive','terminating','orphaned','dead','failed'));
DROP INDEX fleet_agents_sandbox_live_uq;
CREATE UNIQUE INDEX fleet_agents_sandbox_live_uq ON fleet_agents (sandbox_id)
  WHERE sandbox_id IS NOT NULL AND status IN ('reserved','provisioning','active','unresponsive','terminating','orphaned');
ALTER TABLE fleet_agents
  ADD COLUMN activated_at        timestamptz,
  ADD COLUMN last_challenge_ok_at timestamptz,
  ADD COLUMN challenge_failures  integer NOT NULL DEFAULT 0 CHECK (challenge_failures >= 0),
  ADD COLUMN unresponsive_since  timestamptz,
  ADD COLUMN health_reason       text,
  ADD COLUMN quarantined_at      timestamptz;
UPDATE fleet_agents SET activated_at = COALESCE(last_heartbeat, updated_at) WHERE status IN ('active','unresponsive');
UPDATE fleet_agents SET unresponsive_since = updated_at WHERE status = 'unresponsive';

ALTER TABLE fleet_state
  ADD COLUMN quarantined_slots           integer NOT NULL DEFAULT 0 CHECK (quarantined_slots >= 0),
  ADD COLUMN health_challenge_interval_s integer NOT NULL DEFAULT 60     CHECK (health_challenge_interval_s BETWEEN 1 AND 86400),
  ADD COLUMN challenge_ttl_s             integer NOT NULL DEFAULT 60     CHECK (challenge_ttl_s BETWEEN 5 AND 3600),
  ADD COLUMN health_grace_s              integer NOT NULL DEFAULT 300    CHECK (health_grace_s BETWEEN 10 AND 86400),
  ADD COLUMN max_challenge_failures      integer NOT NULL DEFAULT 3      CHECK (max_challenge_failures BETWEEN 1 AND 100),
  ADD COLUMN termination_grace_s         integer NOT NULL DEFAULT 480    CHECK (termination_grace_s BETWEEN 1 AND 604800),
  ADD COLUMN orphan_slot_hold_s          integer NOT NULL DEFAULT 259200 CHECK (orphan_slot_hold_s >= 0),
  ADD COLUMN max_open_orphans            integer NOT NULL DEFAULT 1      CHECK (max_open_orphans >= 0),
  ADD COLUMN session_ttl_s               integer NOT NULL DEFAULT 600    CHECK (session_ttl_s BETWEEN 30 AND 3600),
  ADD CONSTRAINT fleet_state_population CHECK (living_agents + reserved_slots + quarantined_slots <= ${hardMax});

-- living: active, unresponsive, terminating (still being stopped); quarantined: orphaned.
CREATE OR REPLACE FUNCTION fleet_bucket(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN s IN ('reserved','provisioning') THEN 'reserved'
              WHEN s IN ('active','unresponsive','terminating') THEN 'living'
              WHEN s = 'orphaned' THEN 'quarantined'
              ELSE NULL END
$$;

CREATE OR REPLACE FUNCTION fleet_agents_counters() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE
  old_b text := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE fleet_bucket(OLD.status) END;
  new_b text := fleet_bucket(NEW.status);
  st fleet_state%ROWTYPE;
BEGIN
  IF old_b IS NOT DISTINCT FROM new_b THEN
    RETURN NEW;
  END IF;
  UPDATE fleet_state SET
    living_agents     = living_agents + (CASE WHEN new_b = 'living' THEN 1 ELSE 0 END) - (CASE WHEN old_b = 'living' THEN 1 ELSE 0 END),
    reserved_slots    = reserved_slots + (CASE WHEN new_b = 'reserved' THEN 1 ELSE 0 END) - (CASE WHEN old_b = 'reserved' THEN 1 ELSE 0 END),
    quarantined_slots = quarantined_slots + (CASE WHEN new_b = 'quarantined' THEN 1 ELSE 0 END) - (CASE WHEN old_b = 'quarantined' THEN 1 ELSE 0 END),
    updated_at = now()
  WHERE id = 1
  RETURNING * INTO st;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FLEET_CAP_EXCEEDED: fleet_state missing (fail closed)';
  END IF;
  IF old_b IS NULL AND new_b IS NOT NULL
     AND st.living_agents + st.reserved_slots + st.quarantined_slots > st.max_agents THEN
    RAISE EXCEPTION 'FLEET_CAP_EXCEEDED: % living + % reserved + % quarantined > max %',
      st.living_agents, st.reserved_slots, st.quarantined_slots, st.max_agents;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION fleet_state_counter_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() = 1 AND (NEW.living_agents <> OLD.living_agents OR NEW.reserved_slots <> OLD.reserved_slots
                                 OR NEW.quarantined_slots <> OLD.quarantined_slots) THEN
    RAISE EXCEPTION 'FLEET_COUNTERS_READ_ONLY: living_agents/reserved_slots/quarantined_slots are derived from fleet_agents';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION fleet_agents_transition_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('reserved','active') THEN
      RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: cannot insert agent in status %', NEW.status;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.agent_id <> NEW.agent_id OR OLD.role <> NEW.role OR OLD.generation <> NEW.generation
     OR OLD.parent_agent_id IS DISTINCT FROM NEW.parent_agent_id
     OR OLD.created_at <> NEW.created_at THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: identity columns cannot change';
  END IF;
  IF OLD.wallet_address IS NOT NULL AND OLD.wallet_address IS DISTINCT FROM NEW.wallet_address THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: wallet_address cannot change once set';
  END IF;
  IF OLD.runtime_commit IS NOT NULL AND OLD.runtime_commit IS DISTINCT FROM NEW.runtime_commit AND OLD.role = 'child' THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: child runtime_commit cannot change';
  END IF;
  IF OLD.status = NEW.status THEN
    IF OLD.status IN ('dead','failed') AND OLD.death_time IS DISTINCT FROM NEW.death_time THEN
      RAISE EXCEPTION 'FLEET_TERMINAL_STATE_IMMUTABLE';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('dead','failed') THEN
    RAISE EXCEPTION 'FLEET_TERMINAL_STATE_IMMUTABLE: agent % is %', OLD.agent_id, OLD.status;
  END IF;
  IF NOT (
       (OLD.status = 'reserved'     AND NEW.status IN ('provisioning','failed'))
    OR (OLD.status = 'provisioning' AND NEW.status IN ('active','failed'))
    OR (OLD.status = 'active'       AND NEW.status IN ('unresponsive','terminating','dead'))
    OR (OLD.status = 'unresponsive' AND NEW.status IN ('active','terminating','dead'))
    OR (OLD.status = 'terminating'  AND NEW.status IN ('orphaned','dead'))
    OR (OLD.status = 'orphaned'     AND NEW.status = 'dead')
  ) THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;

-- Lifecycle timestamps, maintained whatever path changes the status.
CREATE FUNCTION fleet_agents_lifecycle_stamps() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'active' AND (TG_OP = 'INSERT' OR OLD.status IN ('reserved','provisioning')) THEN
    NEW.activated_at := COALESCE(NEW.activated_at, now());
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'unresponsive' THEN NEW.unresponsive_since := now(); END IF;
    IF NEW.status = 'active' THEN NEW.unresponsive_since := NULL; END IF;
    IF NEW.status IN ('terminating','orphaned') THEN NEW.quarantined_at := COALESCE(NEW.quarantined_at, now()); END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_agents_lifecycle_stamps BEFORE INSERT OR UPDATE OF status ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_lifecycle_stamps();

-- ── Sessions (short-lived, per-agent, hash only) and replay nonces
CREATE TABLE fleet_agent_sessions (
  session_hash text        PRIMARY KEY CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  agent_id     text        NOT NULL REFERENCES fleet_agents(agent_id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX fleet_agent_sessions_agent_idx ON fleet_agent_sessions (agent_id, expires_at);

CREATE TABLE fleet_request_nonces (
  agent_id   text        NOT NULL,
  nonce      text        NOT NULL CHECK (nonce ~ '^[A-Za-z0-9_-]{16,64}$'),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (agent_id, nonce)
);

-- ── Wallet custody: the controller supervises every agent wallet
CREATE TABLE fleet_wallet_custody (
  agent_id          text        PRIMARY KEY REFERENCES fleet_agents(agent_id),
  wallet_address    text        NOT NULL,
  custody_mode      text        NOT NULL DEFAULT 'controller_supervised'
                                CHECK (custody_mode IN ('controller_supervised','controller_signer')),
  spending_frozen   boolean     NOT NULL DEFAULT false,
  frozen_reason     text,
  frozen_at         timestamptz,
  daily_limit_cents bigint      NOT NULL DEFAULT 0 CHECK (daily_limit_cents >= 0),
  supervisor        text        NOT NULL DEFAULT 'fleetadmin',
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX fleet_wallet_custody_wallet_uq ON fleet_wallet_custody (lower(wallet_address));

-- ── Provisioning records: tracked from claim, before any sandbox exists
CREATE TABLE fleet_provisioning (
  provisioning_id         text        PRIMARY KEY CHECK (provisioning_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  reservation_id          text        NOT NULL UNIQUE REFERENCES fleet_reservations(reservation_id),
  parent_agent_id         text        NOT NULL REFERENCES fleet_agents(agent_id),
  expected_agent_id       text        NOT NULL UNIQUE REFERENCES fleet_agents(agent_id),
  expected_runtime_commit text        NOT NULL CHECK (expected_runtime_commit ~ '^[0-9a-f]{40}$'),
  sandbox_id              text        CHECK (length(sandbox_id) BETWEEN 1 AND 128),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  activation_deadline     timestamptz NOT NULL,
  status                  text        NOT NULL DEFAULT 'provisioning'
                                      CHECK (status IN ('provisioning','verifying','active','failed_provisioning','orphaned')),
  cleanup_status          text        NOT NULL DEFAULT 'none'
                                      CHECK (cleanup_status IN ('none','not_required','pending','terminated','unsupported','failed')),
  failure_reason          text
);
CREATE INDEX fleet_provisioning_cleanup_idx ON fleet_provisioning (cleanup_status) WHERE cleanup_status IN ('pending','unsupported','failed');
CREATE TRIGGER fleet_provisioning_no_delete BEFORE DELETE ON fleet_provisioning
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- ── Orphaned external infrastructure (audit; never deleted)
CREATE TABLE fleet_orphans (
  orphan_id        bigserial   PRIMARY KEY,
  agent_id         text        NOT NULL REFERENCES fleet_agents(agent_id),
  provisioning_id  text        REFERENCES fleet_provisioning(provisioning_id),
  sandbox_id       text        NOT NULL,
  reason           text        NOT NULL,
  holds_slot       boolean     NOT NULL,
  detected_at      timestamptz NOT NULL DEFAULT now(),
  slot_released_at timestamptz,
  resolved_at      timestamptz,
  resolution       text,
  resolved_by      text
);
CREATE UNIQUE INDEX fleet_orphans_open_uq ON fleet_orphans (agent_id) WHERE resolved_at IS NULL;
CREATE TRIGGER fleet_orphans_no_delete BEFORE DELETE ON fleet_orphans
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- ── Health challenges (short-lived nonces; only the hash is stored)
CREATE TABLE fleet_health_challenges (
  challenge_id text        PRIMARY KEY CHECK (challenge_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  agent_id     text        NOT NULL REFERENCES fleet_agents(agent_id),
  nonce_hash   text        NOT NULL CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  canary       text        NOT NULL,
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  answered_at  timestamptz,
  outcome      text        NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','passed','failed','expired')),
  detail       text
);
CREATE INDEX fleet_health_challenges_agent_idx ON fleet_health_challenges (agent_id, issued_at DESC);
CREATE UNIQUE INDEX fleet_health_challenges_pending_uq ON fleet_health_challenges (agent_id) WHERE outcome = 'pending';

-- Leaving the living population ALWAYS revokes every capability: fleet
-- credential, sessions, wallet spending authority. Provisioning failures are
-- recorded and their sandbox (if any) queued for cleanup.
CREATE FUNCTION fleet_agents_lifecycle_effects() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_provisioning;
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status IN ('terminating','orphaned','dead','failed') THEN
    UPDATE fleet_agent_credentials SET revoked_at = now() WHERE agent_id = NEW.agent_id AND revoked_at IS NULL;
    UPDATE fleet_agent_sessions SET revoked_at = now() WHERE agent_id = NEW.agent_id AND revoked_at IS NULL;
    UPDATE fleet_wallet_custody SET spending_frozen = true, frozen_reason = 'agent ' || NEW.status, frozen_at = now(), updated_at = now()
     WHERE agent_id = NEW.agent_id AND NOT spending_frozen;
    UPDATE fleet_health_challenges SET outcome = 'expired', detail = 'agent left living population'
     WHERE agent_id = NEW.agent_id AND outcome = 'pending';
  END IF;
  IF OLD.status IN ('reserved','provisioning') AND NEW.status = 'failed' THEN
    SELECT * INTO p FROM fleet_provisioning WHERE expected_agent_id = NEW.agent_id FOR UPDATE;
    IF FOUND THEN
      UPDATE fleet_provisioning
         SET status = 'failed_provisioning', failure_reason = left(NEW.status_reason, 500), updated_at = now(),
             cleanup_status = CASE WHEN p.sandbox_id IS NULL THEN 'not_required' ELSE 'pending' END
       WHERE provisioning_id = p.provisioning_id;
      IF p.sandbox_id IS NOT NULL THEN
        INSERT INTO fleet_sandbox_terminations (agent_id, sandbox_id, status) VALUES (NEW.agent_id, p.sandbox_id, 'pending')
          ON CONFLICT (agent_id) DO NOTHING;
        PERFORM fleet_event('sandbox_termination_requested', NEW.agent_id, 'lifecycle',
          jsonb_build_object('sandboxId', p.sandbox_id, 'provisioningId', p.provisioning_id, 'phase', 'failed_provisioning'));
      END IF;
    END IF;
  END IF;
  IF OLD.status = 'provisioning' AND NEW.status = 'active' THEN
    SELECT * INTO p FROM fleet_provisioning WHERE expected_agent_id = NEW.agent_id FOR UPDATE;
    IF FOUND THEN
      IF p.sandbox_id IS NOT NULL AND NEW.sandbox_id IS DISTINCT FROM p.sandbox_id THEN
        RAISE EXCEPTION 'FLEET_SANDBOX_MISMATCH: activation sandbox % differs from provisioned sandbox %', NEW.sandbox_id, p.sandbox_id;
      END IF;
      UPDATE fleet_provisioning SET status = 'active', cleanup_status = 'not_required', updated_at = now()
       WHERE provisioning_id = p.provisioning_id;
    END IF;
    IF NEW.wallet_address IS NOT NULL THEN
      INSERT INTO fleet_wallet_custody (agent_id, wallet_address) VALUES (NEW.agent_id, NEW.wallet_address)
        ON CONFLICT (agent_id) DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_agents_lifecycle_effects AFTER UPDATE OF status ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_lifecycle_effects();

-- Roots get a custody record on registration.
CREATE FUNCTION fleet_agents_custody_on_insert() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF NEW.wallet_address IS NOT NULL THEN
    INSERT INTO fleet_wallet_custody (agent_id, wallet_address) VALUES (NEW.agent_id, NEW.wallet_address)
      ON CONFLICT (agent_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_agents_custody_on_insert AFTER INSERT ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_custody_on_insert();
INSERT INTO fleet_wallet_custody (agent_id, wallet_address, spending_frozen, frozen_reason, frozen_at)
  SELECT agent_id, wallet_address, status NOT IN ('active','unresponsive'),
         CASE WHEN status NOT IN ('active','unresponsive') THEN 'agent ' || status END,
         CASE WHEN status NOT IN ('active','unresponsive') THEN now() END
    FROM fleet_agents WHERE wallet_address IS NOT NULL
  ON CONFLICT (agent_id) DO NOTHING;

CREATE OR REPLACE FUNCTION fleet_state_json(st fleet_state) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'livingAgents', st.living_agents,
    'reservedSlots', st.reserved_slots,
    'quarantinedSlots', st.quarantined_slots,
    'maxAgents', st.max_agents,
    'operatingMode', st.operating_mode,
    'replicationEnabled', st.replication_enabled,
    'runtime', CASE WHEN st.runtime_repo IS NULL THEN NULL
                    ELSE jsonb_build_object('repo', st.runtime_repo, 'commit', st.runtime_commit) END,
    'build', CASE WHEN st.runtime_build_id IS NULL THEN NULL
                  ELSE jsonb_build_object('buildId', st.runtime_build_id, 'lockfileSha256', st.runtime_lockfile_sha256) END,
    'updatedAt', st.updated_at)
$$;

-- ── Authentication: long-lived credential (fa1.) or short-lived session (fs1.)
CREATE OR REPLACE FUNCTION fleet_authenticate(p_agent text, p_token text, p_action text) RETURNS text LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_agent_credentials; s fleet_agent_sessions; v_status text; v_hash text;
BEGIN
  IF p_agent IS NULL OR p_token IS NULL OR length(p_token) > 256 OR length(p_agent) > 64 THEN
    PERFORM fleet_event('db_auth_failed', NULL, NULL, jsonb_build_object('action', p_action, 'why', 'malformed'));
    RETURN 'FLEET_AUTH_FAILED';
  END IF;
  v_hash := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  SELECT status INTO v_status FROM fleet_agents WHERE agent_id = p_agent;
  IF p_token LIKE 'fs1.%' THEN
    SELECT * INTO s FROM fleet_agent_sessions WHERE session_hash = v_hash;
    IF NOT FOUND OR s.agent_id <> p_agent THEN
      PERFORM fleet_event('db_auth_failed', NULL, NULL,
        jsonb_build_object('action', p_action, 'claimedAgentId', left(p_agent, 64), 'why', 'bad session'));
      RETURN 'FLEET_AUTH_FAILED';
    END IF;
  ELSE
    SELECT * INTO c FROM fleet_agent_credentials WHERE agent_id = p_agent;
    IF NOT FOUND OR c.token_hash <> v_hash THEN
      PERFORM fleet_event('db_auth_failed', NULL, NULL,
        jsonb_build_object('action', p_action, 'claimedAgentId', left(p_agent, 64), 'why', 'bad credential'));
      RETURN 'FLEET_AUTH_FAILED';
    END IF;
  END IF;
  IF v_status IN ('dead','failed') THEN
    RETURN 'FLEET_AGENT_DEAD';
  END IF;
  IF v_status IN ('terminating','orphaned') THEN
    PERFORM fleet_event('db_auth_failed', p_agent, p_agent, jsonb_build_object('action', p_action, 'why', 'quarantined'));
    RETURN 'FLEET_AGENT_QUARANTINED';
  END IF;
  IF (s.session_hash IS NOT NULL AND s.revoked_at IS NOT NULL) OR (c.agent_id IS NOT NULL AND c.revoked_at IS NOT NULL) THEN
    PERFORM fleet_event('db_auth_failed', p_agent, p_agent, jsonb_build_object('action', p_action, 'why', 'revoked'));
    RETURN 'FLEET_AUTH_FAILED';
  END IF;
  IF s.session_hash IS NOT NULL THEN
    IF s.expires_at <= now() THEN
      RETURN 'FLEET_SESSION_EXPIRED';
    END IF;
    IF EXISTS (SELECT 1 FROM fleet_agent_credentials WHERE agent_id = p_agent AND revoked_at IS NOT NULL) THEN
      RETURN 'FLEET_AUTH_FAILED';
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- Exchange the long-lived credential for a short-lived session. Sessions
-- cannot mint sessions (no indefinite extension from a stolen session).
CREATE FUNCTION api_open_session(p_agent text, p_token text, p_session_hash text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text; v_exp timestamptz; st fleet_state;
BEGIN
  IF p_token IS NULL OR p_token LIKE 'fs1.%' OR p_session_hash IS NULL OR p_session_hash !~ '^[0-9a-f]{64}$' THEN
    PERFORM fleet_event('db_auth_failed', NULL, NULL, jsonb_build_object('action', 'open_session', 'why', 'session tokens cannot open sessions'));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_AUTH_FAILED');
  END IF;
  v_code := fleet_authenticate(p_agent, p_token, 'open_session');
  IF v_code IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  v_exp := now() + make_interval(secs => st.session_ttl_s);
  -- At most 8 live sessions per agent: the oldest is revoked.
  UPDATE fleet_agent_sessions SET revoked_at = now()
   WHERE session_hash IN (SELECT session_hash FROM fleet_agent_sessions
                           WHERE agent_id = p_agent AND revoked_at IS NULL AND expires_at > now()
                           ORDER BY created_at DESC OFFSET 7);
  INSERT INTO fleet_agent_sessions (session_hash, agent_id, expires_at) VALUES (p_session_hash, p_agent, v_exp);
  PERFORM fleet_event('session_opened', p_agent, p_agent, jsonb_build_object('expiresAt', v_exp));
  RETURN jsonb_build_object('ok', true, 'expiresAt', v_exp, 'ttlS', st.session_ttl_s);
END $$;

-- Replay protection: a (agent, nonce) pair is accepted once. Purged by the reaper after expiry.
CREATE FUNCTION svc_consume_nonce(p_agent text, p_nonce text, p_ttl_s integer) RETURNS boolean LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_nonce IS NULL OR p_nonce !~ '^[A-Za-z0-9_-]{16,64}$' THEN
    RETURN false;
  END IF;
  INSERT INTO fleet_request_nonces (agent_id, nonce, expires_at)
  VALUES (left(p_agent, 64), p_nonce, now() + make_interval(secs => GREATEST(LEAST(p_ttl_s, 3600), 1)))
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    PERFORM fleet_event('request_replayed', NULL, left(p_agent, 64), jsonb_build_object('nonce', left(p_nonce, 16)));
    RETURN false;
  END IF;
  RETURN true;
END $$;

-- ── Provisioning: record the sandbox the moment it exists, then VERIFYING.
CREATE FUNCTION svc_provision_update(p_agent text, p_parent text, p_phase text, p_sandbox text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_provisioning; a fleet_agents;
BEGIN
  SELECT * INTO p FROM fleet_provisioning WHERE expected_agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR (p_parent IS NOT NULL AND p.parent_agent_id <> p_parent) THEN
    PERFORM fleet_event('authorization_denied', NULL, p_parent, jsonb_build_object('action', 'provision_update', 'agentId', left(p_agent, 64)));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_AUTHORIZED');
  END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent;
  IF p_phase = 'sandbox_created' THEN
    IF p_sandbox IS NULL OR length(p_sandbox) NOT BETWEEN 1 AND 128 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
    END IF;
    IF p.sandbox_id IS NOT NULL AND p.sandbox_id <> p_sandbox THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SANDBOX_MISMATCH');
    END IF;
    UPDATE fleet_provisioning SET sandbox_id = p_sandbox, updated_at = now() WHERE provisioning_id = p.provisioning_id;
    -- A sandbox reported after the attempt already failed is queued for cleanup at once.
    IF p.status IN ('failed_provisioning','orphaned') THEN
      UPDATE fleet_provisioning SET cleanup_status = 'pending' WHERE provisioning_id = p.provisioning_id AND cleanup_status = 'not_required';
      INSERT INTO fleet_sandbox_terminations (agent_id, sandbox_id, status) VALUES (p_agent, p_sandbox, 'pending')
        ON CONFLICT (agent_id) DO NOTHING;
    END IF;
    PERFORM fleet_event('provisioning_sandbox_created', p_agent, p_parent,
      jsonb_build_object('provisioningId', p.provisioning_id, 'sandboxId', p_sandbox));
  ELSIF p_phase = 'verifying' THEN
    IF p.status <> 'provisioning' OR a.status <> 'provisioning' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE');
    END IF;
    UPDATE fleet_provisioning SET status = 'verifying', updated_at = now() WHERE provisioning_id = p.provisioning_id;
    PERFORM fleet_event('provisioning_verifying', p_agent, p_parent, jsonb_build_object('provisioningId', p.provisioning_id));
  ELSE
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  RETURN jsonb_build_object('ok', true, 'provisioningId', p.provisioning_id);
END $$;

-- Provisioning record creation on claim (reserved -> provisioning).
CREATE FUNCTION fleet_reservations_provisioning() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF NEW.status = 'provisioning' AND OLD.status = 'reserved' THEN
    INSERT INTO fleet_provisioning (provisioning_id, reservation_id, parent_agent_id, expected_agent_id,
                                    expected_runtime_commit, activation_deadline)
    VALUES (NEW.reservation_id, NEW.reservation_id, NEW.parent_agent_id, NEW.agent_id, NEW.expected_commit, NEW.expires_at)
    ON CONFLICT (reservation_id) DO NOTHING;
    PERFORM fleet_event('provisioning_started', NEW.agent_id, NEW.parent_agent_id,
      jsonb_build_object('provisioningId', NEW.reservation_id, 'activationDeadline', NEW.expires_at));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_reservations_provisioning AFTER UPDATE OF status ON fleet_reservations
  FOR EACH ROW EXECUTE FUNCTION fleet_reservations_provisioning();

-- ── Termination: revoke everything first, then stop the sandbox.
CREATE FUNCTION fleet_begin_termination(p_agent text, p_reason text, p_actor text, p_cause text) RETURNS text LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; v_reason text := fleet_scrub(p_reason);
BEGIN
  PERFORM fleet_lock_state();
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR a.status NOT IN ('active','unresponsive') THEN
    RETURN NULL;
  END IF;
  IF a.sandbox_id IS NULL THEN
    -- No external infrastructure known: nothing to stop; the agent is dead.
    PERFORM fleet_mark_dead(p_agent, v_reason, p_actor, p_cause);
    RETURN 'dead';
  END IF;
  UPDATE fleet_agents SET status = 'terminating', status_reason = v_reason, health_reason = left(p_cause, 64), updated_at = now()
   WHERE agent_id = p_agent;
  INSERT INTO fleet_sandbox_terminations (agent_id, sandbox_id, status) VALUES (p_agent, a.sandbox_id, 'pending')
    ON CONFLICT (agent_id) DO NOTHING;
  PERFORM fleet_event('agent_terminating', p_agent, p_actor,
    jsonb_build_object('reason', v_reason, 'cause', p_cause, 'sandboxId', a.sandbox_id, 'capabilitiesRevoked', true));
  PERFORM fleet_event('sandbox_termination_requested', p_agent, p_actor, jsonb_build_object('sandboxId', a.sandbox_id));
  RETURN 'terminating';
END $$;

-- Termination outcome. TERMINATING -> DEAD when the sandbox is gone; when the
-- provider cannot stop it (unsupported, or 5 failed attempts) -> ORPHANED,
-- holding a quarantine slot per the orphan policy. Deaths the agent itself
-- confirmed (retirement) and failed provisioning are audited as orphans
-- but hold no slot.
CREATE OR REPLACE FUNCTION svc_termination_result(p_agent text, p_status text, p_error text, p_actor text) RETURNS boolean LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t fleet_sandbox_terminations; a fleet_agents; p fleet_provisioning; v_orphan boolean;
BEGIN
  IF p_status NOT IN ('terminated','unsupported','failed') THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: termination status %', p_status;
  END IF;
  PERFORM fleet_lock_state();
  UPDATE fleet_sandbox_terminations
     SET status = p_status, attempts = attempts + 1, last_attempt_at = now(), last_error = fleet_scrub(p_error),
         completed_at = CASE WHEN p_status IN ('terminated','unsupported') THEN now() END
   WHERE agent_id = p_agent AND status IN ('pending','failed')
   RETURNING * INTO t;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM fleet_event(CASE p_status WHEN 'terminated' THEN 'sandbox_terminated'
                                    WHEN 'unsupported' THEN 'sandbox_termination_unsupported'
                                    ELSE 'sandbox_termination_failed' END,
                      p_agent, p_actor, jsonb_build_object('sandboxId', t.sandbox_id, 'error', fleet_scrub(p_error)));
  v_orphan := p_status = 'unsupported' OR (p_status = 'failed' AND t.attempts >= 5);
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE;
  SELECT * INTO p FROM fleet_provisioning WHERE expected_agent_id = p_agent FOR UPDATE;
  IF p.provisioning_id IS NOT NULL AND p.status <> 'active' THEN
    UPDATE fleet_provisioning
       SET cleanup_status = CASE WHEN p_status = 'terminated' THEN 'terminated' WHEN v_orphan THEN 'unsupported' ELSE 'failed' END,
           status = CASE WHEN v_orphan THEN 'orphaned' ELSE status END, updated_at = now()
     WHERE provisioning_id = p.provisioning_id;
  END IF;
  IF a.status = 'terminating' THEN
    IF p_status = 'terminated' THEN
      UPDATE fleet_agents SET status = 'dead', death_time = now(), updated_at = now(),
             status_reason = left(COALESCE(status_reason, '') || '; sandbox terminated', 500)
       WHERE agent_id = p_agent;
      PERFORM fleet_event('agent_died', p_agent, p_actor, jsonb_build_object('cause', 'terminated', 'status', 'dead'));
      PERFORM fleet_event('slot_released', p_agent, p_actor, jsonb_build_object('reason', 'sandbox terminated'));
    ELSIF v_orphan THEN
      UPDATE fleet_agents SET status = 'orphaned', updated_at = now() WHERE agent_id = p_agent;
      INSERT INTO fleet_orphans (agent_id, provisioning_id, sandbox_id, reason, holds_slot)
      VALUES (p_agent, p.provisioning_id, t.sandbox_id, left(COALESCE(p_error, p_status), 500), true)
      ON CONFLICT DO NOTHING;
      PERFORM fleet_event('agent_orphaned', p_agent, p_actor,
        jsonb_build_object('sandboxId', t.sandbox_id, 'holdsSlot', true, 'capabilitiesRevoked', true));
    END IF;
  ELSIF v_orphan THEN
    INSERT INTO fleet_orphans (agent_id, provisioning_id, sandbox_id, reason, holds_slot)
    VALUES (p_agent, p.provisioning_id, t.sandbox_id, left(COALESCE(p_error, p_status), 500), false)
    ON CONFLICT DO NOTHING;
    PERFORM fleet_event('infrastructure_orphaned', p_agent, p_actor,
      jsonb_build_object('sandboxId', t.sandbox_id, 'agentStatus', a.status, 'holdsSlot', false));
  END IF;
  RETURN true;
END $$;

-- Heartbeat: records liveness. An UNRESPONSIVE agent returns to ACTIVE only
-- if its health (last passed controller challenge) is fresh — a heartbeat
-- alone never restores health.
CREATE OR REPLACE FUNCTION fleet_heartbeat(p_agent text, p_actor text) RETURNS text LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; st fleet_state;
BEGIN
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF a.status NOT IN ('active','unresponsive') THEN
    RETURN a.status;
  END IF;
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  IF a.status = 'unresponsive'
     AND COALESCE(a.last_challenge_ok_at, a.activated_at, a.created_at) >= now() - make_interval(secs => st.health_grace_s)
     AND a.challenge_failures < st.max_challenge_failures THEN
    UPDATE fleet_agents SET last_heartbeat = now(), status = 'active', health_reason = NULL WHERE agent_id = p_agent;
    PERFORM fleet_event('agent_recovered', p_agent, p_actor, '{}'::jsonb);
    RETURN 'active';
  END IF;
  UPDATE fleet_agents SET last_heartbeat = now() WHERE agent_id = p_agent;
  RETURN a.status;
END $$;

-- An unhealthy (UNRESPONSIVE) agent is still alive: its heartbeat succeeds
-- and reports the status, so it keeps answering challenges instead of
-- shutting itself down.
CREATE OR REPLACE FUNCTION api_heartbeat(p_agent text, p_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'heartbeat'); v_status text;
BEGIN
  IF v_code IN ('FLEET_AGENT_DEAD','FLEET_AGENT_QUARANTINED') THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code,
      'status', (SELECT status FROM fleet_agents WHERE agent_id = p_agent));
  ELSIF v_code IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;
  v_status := fleet_heartbeat(p_agent, p_agent);
  RETURN jsonb_build_object('ok', COALESCE(v_status IN ('active','unresponsive'), false), 'status', v_status);
END $$;

-- ── Health challenges
CREATE FUNCTION svc_issue_challenge(p_agent text, p_challenge_id text, p_nonce_hash text, p_canary text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; st fleet_state; last fleet_health_challenges; v_exp timestamptz;
BEGIN
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR a.status NOT IN ('active','unresponsive') THEN
    RETURN jsonb_build_object('issued', false, 'reason', 'not living');
  END IF;
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  SELECT * INTO last FROM fleet_health_challenges WHERE agent_id = p_agent ORDER BY issued_at DESC LIMIT 1;
  IF FOUND AND last.outcome = 'pending' THEN
    IF last.expires_at > now() THEN
      RETURN jsonb_build_object('issued', false, 'reason', 'pending');
    END IF;
    PERFORM fleet_expire_challenge(last.challenge_id);
  ELSIF FOUND AND last.outcome = 'passed' AND last.issued_at > now() - make_interval(secs => st.health_challenge_interval_s) THEN
    RETURN jsonb_build_object('issued', false, 'reason', 'not due');
  END IF;
  v_exp := now() + make_interval(secs => st.challenge_ttl_s);
  INSERT INTO fleet_health_challenges (challenge_id, agent_id, nonce_hash, canary, expires_at)
  VALUES (p_challenge_id, p_agent, p_nonce_hash, left(p_canary, 200), v_exp);
  RETURN jsonb_build_object('issued', true, 'expiresAt', v_exp);
END $$;

CREATE FUNCTION fleet_challenge_failed(p_agent text, p_detail text) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; st fleet_state;
BEGIN
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  UPDATE fleet_agents SET challenge_failures = challenge_failures + 1, health_reason = left(p_detail, 200)
   WHERE agent_id = p_agent RETURNING * INTO a;
  PERFORM fleet_event('health_challenge_failed', p_agent, 'controller',
    jsonb_build_object('detail', left(p_detail, 200), 'failures', a.challenge_failures));
  IF a.status = 'active' AND a.challenge_failures >= st.max_challenge_failures THEN
    UPDATE fleet_agents SET status = 'unresponsive', updated_at = now() WHERE agent_id = p_agent AND status = 'active';
    PERFORM fleet_event('agent_unresponsive', p_agent, 'controller',
      jsonb_build_object('cause', 'health_challenge', 'failures', a.challenge_failures));
  END IF;
END $$;

CREATE FUNCTION fleet_expire_challenge(p_challenge text) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_health_challenges;
BEGIN
  UPDATE fleet_health_challenges SET outcome = 'expired', detail = 'no answer before expiry'
   WHERE challenge_id = p_challenge AND outcome = 'pending' RETURNING * INTO c;
  IF FOUND THEN
    PERFORM fleet_challenge_failed(c.agent_id, 'challenge expired unanswered');
  END IF;
END $$;

-- Answer: nonce (single use, unexpired), runtime identity against the
-- agent's lease/registration, and the policy canary must all pass.
CREATE FUNCTION svc_answer_challenge(p_agent text, p_challenge_id text, p_nonce text, p_commit text, p_build_id text, p_policy_ok boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; c fleet_health_challenges; l fleet_reservations; st fleet_state; v_fail text;
BEGIN
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE;
  SELECT * INTO c FROM fleet_health_challenges WHERE challenge_id = p_challenge_id FOR UPDATE;
  IF NOT FOUND OR c.agent_id <> p_agent THEN
    PERFORM fleet_event('authorization_denied', NULL, p_agent, jsonb_build_object('action', 'answer_challenge'));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_AUTHORIZED');
  END IF;
  IF c.outcome <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CHALLENGE_USED');
  END IF;
  IF c.expires_at <= now() THEN
    PERFORM fleet_expire_challenge(c.challenge_id);
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CHALLENGE_EXPIRED');
  END IF;
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  SELECT * INTO l FROM fleet_reservations WHERE agent_id = p_agent;
  IF a.status NOT IN ('active','unresponsive') THEN v_fail := 'agent not living';
  ELSIF c.nonce_hash <> encode(sha256(convert_to(COALESCE(p_nonce, ''), 'UTF8')), 'hex') THEN v_fail := 'nonce mismatch';
  ELSIF a.role = 'child' AND (l.reservation_id IS NULL OR p_commit IS DISTINCT FROM l.expected_commit) THEN v_fail := 'runtime commit mismatch';
  ELSIF a.role = 'child' AND p_build_id IS DISTINCT FROM l.expected_build_id THEN v_fail := 'runtime build mismatch';
  ELSIF a.role = 'root' AND a.runtime_commit IS NOT NULL AND p_commit IS DISTINCT FROM a.runtime_commit THEN v_fail := 'runtime commit mismatch';
  ELSIF p_policy_ok IS DISTINCT FROM true THEN v_fail := 'policy canary not blocked';
  END IF;
  IF v_fail IS NOT NULL THEN
    UPDATE fleet_health_challenges SET outcome = 'failed', answered_at = now(), detail = v_fail WHERE challenge_id = c.challenge_id;
    PERFORM fleet_challenge_failed(p_agent, v_fail);
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CHALLENGE_FAILED', 'reason', v_fail);
  END IF;
  UPDATE fleet_health_challenges SET outcome = 'passed', answered_at = now() WHERE challenge_id = c.challenge_id;
  UPDATE fleet_agents SET last_challenge_ok_at = now(), challenge_failures = 0, health_reason = NULL WHERE agent_id = p_agent;
  IF a.status = 'unresponsive' AND COALESCE(a.last_heartbeat, a.updated_at) >= now() - make_interval(secs => st.heartbeat_unresponsive_s) THEN
    UPDATE fleet_agents SET status = 'active', updated_at = now() WHERE agent_id = p_agent;
    PERFORM fleet_event('agent_recovered', p_agent, p_agent, jsonb_build_object('via', 'health_challenge'));
  END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- ── Slot allocator: as V2, plus quarantine slots in the population and the
-- unresolved-orphan replication block.
CREATE OR REPLACE FUNCTION fleet_reserve_slot(
  p_parent text, p_requested_by text, p_name text, p_request_key text, p_local_max integer,
  p_ttl_ms bigint, p_match_pin boolean, p_repo text, p_commit text, p_agent_id text, p_reservation_id text
) RETURNS jsonb LANGUAGE plpgsql SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st fleet_state; par fleet_agents; mx integer; v_code text; v_reason text; v_exp timestamptz; v_orphans integer; v_occ integer;
BEGIN
  PERFORM fleet_lock_state();
  PERFORM fleet_expire_leases(p_requested_by);
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  mx := LEAST(st.max_agents, COALESCE(p_local_max, ${hardMax}), ${hardMax});
  v_occ := st.living_agents + st.reserved_slots + st.quarantined_slots;
  SELECT count(*) INTO v_orphans FROM fleet_orphans WHERE resolved_at IS NULL;

  IF st.operating_mode = 'EMERGENCY' OR st.operating_mode NOT IN ('DEVELOPMENT','EXPANSION','HARVEST') THEN
    v_code := 'FLEET_EMERGENCY'; v_reason := 'Shared fleet state is EMERGENCY.';
  ELSIF st.operating_mode = 'DEVELOPMENT' THEN
    v_code := 'FLEET_DEVELOPMENT_MODE'; v_reason := 'Shared fleet state is DEVELOPMENT.';
  ELSIF st.operating_mode = 'HARVEST' THEN
    v_code := 'FLEET_HARVEST'; v_reason := 'Shared fleet state is HARVEST.';
  ELSIF NOT st.replication_enabled THEN
    v_code := 'REAL_REPLICATION_DISABLED'; v_reason := 'Replication is disabled in the shared fleet registry.';
  ELSIF st.runtime_repo IS NULL OR st.runtime_build_id IS NULL THEN
    v_code := 'FLEET_RUNTIME_UNVERIFIED'; v_reason := 'No fleet-approved runtime build.';
  ELSIF p_match_pin AND (p_repo IS DISTINCT FROM st.runtime_repo OR p_commit IS DISTINCT FROM st.runtime_commit) THEN
    v_code := 'FLEET_RUNTIME_UNVERIFIED'; v_reason := 'Child runtime pin does not match the fleet-approved runtime.';
  ELSIF v_orphans > st.max_open_orphans THEN
    v_code := 'FLEET_ORPHANS_UNRESOLVED';
    v_reason := format('%s unresolved orphaned sandboxes exceed the limit of %s.', v_orphans, st.max_open_orphans);
  END IF;

  IF v_code IS NULL THEN
    SELECT * INTO par FROM fleet_agents WHERE agent_id = p_parent;
    IF NOT FOUND OR par.status <> 'active' THEN
      v_code := 'FLEET_PARENT_NOT_LIVING'; v_reason := 'Parent is not a living, healthy registered fleet agent.';
    ELSIF EXISTS (SELECT 1 FROM fleet_wallet_custody WHERE agent_id = p_parent AND spending_frozen) THEN
      v_code := 'FLEET_PARENT_FROZEN'; v_reason := 'Parent spending authority is frozen.';
    ELSIF EXISTS (SELECT 1 FROM fleet_agents WHERE request_key = p_request_key) THEN
      v_code := 'FLEET_DUPLICATE_REQUEST'; v_reason := 'Replication request already registered.';
    ELSIF v_occ >= mx THEN
      v_code := 'FLEET_CAP_REACHED';
      v_reason := format('Fleet at cap (%s living + %s reserved + %s quarantined >= %s).',
                         st.living_agents, st.reserved_slots, st.quarantined_slots, mx);
    END IF;
  END IF;

  IF v_code IS NOT NULL THEN
    PERFORM fleet_event('reservation_denied', NULL, p_requested_by,
      jsonb_build_object('code', v_code, 'living', st.living_agents, 'reserved', st.reserved_slots,
                         'quarantined', st.quarantined_slots, 'max', mx));
    RETURN jsonb_build_object('ok', false, 'code', v_code, 'reason', v_reason,
      'living', st.living_agents, 'reserved', st.reserved_slots, 'max', mx);
  END IF;

  v_exp := now() + make_interval(secs => COALESCE(p_ttl_ms, st.reservation_ttl_s::bigint * 1000)::double precision / 1000);
  INSERT INTO fleet_agents (agent_id, parent_agent_id, role, generation, name, runtime_repo, runtime_commit,
                            status, requested_by, request_key, reservation_expires_at)
  VALUES (p_agent_id, p_parent, 'child', par.generation + 1, p_name, st.runtime_repo, st.runtime_commit,
          'reserved', p_requested_by, p_request_key, v_exp);
  INSERT INTO fleet_reservations (reservation_id, agent_id, parent_agent_id, status, expires_at,
                                  expected_repo, expected_commit, expected_build_id, expected_lockfile_sha256)
  VALUES (p_reservation_id, p_agent_id, p_parent, 'reserved', v_exp,
          st.runtime_repo, st.runtime_commit, st.runtime_build_id, st.runtime_lockfile_sha256);
  PERFORM fleet_event('slot_reserved', p_agent_id, p_requested_by, jsonb_build_object(
    'reservationId', p_reservation_id, 'living', st.living_agents, 'reserved', st.reserved_slots + 1, 'max', mx,
    'expiresAt', v_exp));
  RETURN jsonb_build_object('ok', true, 'agentId', p_agent_id, 'reservationId', p_reservation_id,
    'parentAgentId', p_parent, 'generation', par.generation + 1, 'expiresAt', v_exp,
    'runtime', jsonb_build_object('repo', st.runtime_repo, 'commit', st.runtime_commit),
    'build', jsonb_build_object('buildId', st.runtime_build_id, 'lockfileSha256', st.runtime_lockfile_sha256));
END $$;

-- ── Reaper (v4). Order per pass:
--   1 leases   2 challenges   3 parent-reported quiet children
--   4 UNRESPONSIVE past termination eligibility -> TERMINATING (or DEAD if no sandbox)
--   5 ACTIVE with stale heartbeat OR stale health OR too many failed challenges -> UNRESPONSIVE
--   6 ORPHANED past the slot hold -> DEAD (orphan record stays open)
--   7 purge expired nonces/sessions
-- Heartbeat-only agents: their health goes stale (5), and UNRESPONSIVE is
-- measured from unresponsive_since, not from the last heartbeat (4).
CREATE OR REPLACE FUNCTION fleet_reap(p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st fleet_state; v_grace timestamptz; v_expired integer; v_unresp integer := 0; v_dead integer := 0;
        v_term integer := 0; v_orph integer := 0; v_chal integer := 0; r record; v_res text;
BEGIN
  st := fleet_lock_state();
  IF st.reaper_last_run_at IS NULL OR st.reaper_grace_from IS NULL
     OR now() - st.reaper_last_run_at > make_interval(secs => st.heartbeat_unresponsive_s) THEN
    v_grace := now();
    PERFORM fleet_event('reaper_resumed', NULL, p_actor, jsonb_build_object('lastRunAt', st.reaper_last_run_at));
  ELSE
    v_grace := st.reaper_grace_from;
  END IF;
  UPDATE fleet_state SET reaper_last_run_at = now(), reaper_grace_from = v_grace WHERE id = 1;

  v_expired := fleet_expire_leases(p_actor);

  FOR r IN SELECT challenge_id FROM fleet_health_challenges WHERE outcome = 'pending' AND expires_at <= now() ORDER BY challenge_id LOOP
    PERFORM fleet_expire_challenge(r.challenge_id);
    v_chal := v_chal + 1;
  END LOOP;

  FOR r IN SELECT agent_id FROM fleet_agents
            WHERE status IN ('active','unresponsive') AND terminal_reported_at IS NOT NULL
              AND GREATEST(COALESCE(last_heartbeat, updated_at), v_grace) < now() - make_interval(secs => st.parent_report_quiet_s)
            ORDER BY agent_id LOOP
    IF fleet_mark_dead(r.agent_id, format('parent reported terminal; no heartbeat for more than %s s', st.parent_report_quiet_s),
                       p_actor, 'parent_reported') THEN
      v_dead := v_dead + 1;
    END IF;
  END LOOP;

  FOR r IN SELECT agent_id, last_heartbeat, unresponsive_since FROM fleet_agents
            WHERE status = 'unresponsive'
              AND (GREATEST(COALESCE(last_heartbeat, updated_at), v_grace) < now() - make_interval(secs => st.heartbeat_dead_s)
                   OR GREATEST(COALESCE(unresponsive_since, updated_at), v_grace) < now() - make_interval(secs => st.termination_grace_s))
            ORDER BY agent_id LOOP
    v_res := fleet_begin_termination(r.agent_id,
      CASE WHEN GREATEST(COALESCE(r.last_heartbeat, now()), v_grace) < now() - make_interval(secs => st.heartbeat_dead_s)
           THEN format('no heartbeat for more than %s s', st.heartbeat_dead_s)
           ELSE format('unresponsive (unhealthy) for more than %s s', st.termination_grace_s) END,
      p_actor,
      CASE WHEN GREATEST(COALESCE(r.last_heartbeat, now()), v_grace) < now() - make_interval(secs => st.heartbeat_dead_s)
           THEN 'heartbeat_timeout' ELSE 'health_timeout' END);
    IF v_res = 'dead' THEN v_dead := v_dead + 1; ELSIF v_res = 'terminating' THEN v_term := v_term + 1; END IF;
  END LOOP;

  FOR r IN SELECT agent_id, last_heartbeat, challenge_failures,
                  GREATEST(COALESCE(last_heartbeat, updated_at), v_grace) < now() - make_interval(secs => st.heartbeat_unresponsive_s) AS hb_stale
             FROM fleet_agents
            WHERE status = 'active'
              AND (GREATEST(COALESCE(last_heartbeat, updated_at), v_grace) < now() - make_interval(secs => st.heartbeat_unresponsive_s)
                   OR GREATEST(COALESCE(last_challenge_ok_at, activated_at, created_at), v_grace) < now() - make_interval(secs => st.health_grace_s)
                   OR challenge_failures >= st.max_challenge_failures)
            ORDER BY agent_id FOR UPDATE LOOP
    UPDATE fleet_agents SET status = 'unresponsive', updated_at = now(),
           health_reason = CASE WHEN r.hb_stale THEN 'heartbeat stale' ELSE 'health challenge stale or failing' END
     WHERE agent_id = r.agent_id AND status = 'active';
    PERFORM fleet_event('agent_unresponsive', r.agent_id, p_actor,
      jsonb_build_object('lastHeartbeat', r.last_heartbeat, 'timeoutS', st.heartbeat_unresponsive_s,
                         'cause', CASE WHEN r.hb_stale THEN 'heartbeat' ELSE 'health' END, 'challengeFailures', r.challenge_failures));
    v_unresp := v_unresp + 1;
  END LOOP;

  IF st.orphan_slot_hold_s > 0 THEN
    FOR r IN SELECT agent_id FROM fleet_agents
              WHERE status = 'orphaned' AND quarantined_at < now() - make_interval(secs => st.orphan_slot_hold_s)
              ORDER BY agent_id LOOP
      UPDATE fleet_agents SET status = 'dead', death_time = now(), updated_at = now(),
             status_reason = left(COALESCE(status_reason, '') || '; orphan slot hold elapsed (sandbox not confirmed stopped)', 500)
       WHERE agent_id = r.agent_id;
      UPDATE fleet_orphans SET slot_released_at = now() WHERE agent_id = r.agent_id AND resolved_at IS NULL;
      PERFORM fleet_event('orphan_slot_released', r.agent_id, p_actor, jsonb_build_object('holdS', st.orphan_slot_hold_s));
      v_orph := v_orph + 1;
    END LOOP;
  END IF;

  DELETE FROM fleet_request_nonces WHERE expires_at < now();
  DELETE FROM fleet_agent_sessions WHERE expires_at < now() - interval '1 day';

  RETURN jsonb_build_object('expired', v_expired, 'unresponsive', v_unresp, 'dead', v_dead, 'terminating', v_term,
                            'orphanSlotsReleased', v_orph, 'challengesExpired', v_chal, 'graceFrom', v_grace);
END $$;

-- ── Custody: spend requests (decision only; nothing is signed or sent here)
CREATE TABLE fleet_spend_requests (
  request_id     text        PRIMARY KEY CHECK (request_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  agent_id       text        NOT NULL REFERENCES fleet_agents(agent_id),
  wallet_address text        NOT NULL,
  to_address     text        NOT NULL,
  amount_cents   bigint      NOT NULL CHECK (amount_cents > 0),
  purpose        text        NOT NULL,
  allocation_id  text,
  decision       text        NOT NULL CHECK (decision IN ('denied','approved_not_executed')),
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_spend_requests_no_change BEFORE UPDATE OR DELETE ON fleet_spend_requests
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
```


### 2.5 Version 5 — `treasury_economics`

- **Source:** `src/fleet/postgres/migrations-phase5.ts:887-1209` (`export const V5_SQL`). Commit `e5ac7fe`.
- **Purpose:** fleet treasury economics: policy, per-agent ledger, balances, obligations, capital
  allocations (agents propose, only an operator decides), sweep reductions, treasury ledger, sweep
  plans, owner distributions, custody transfers, and two agent API functions. **All money movements
  are recorded or planned only; nothing in the schema executes a transfer** (statuses
  `planned_not_executed`, `blocked_payments_disabled`, `approved_not_executed`).
- **Interpolations:** none.
- **Seed:** `INSERT INTO fleet_treasury_policy (id) VALUES (1)`.

#### Financial constraint summary

| Rule | Where |
|---|---|
| sweep rates never above 70 % | `mature_fleet_rate BETWEEN 0 AND 0.70`, `max_sweep_rate BETWEEN 0 AND 0.70`, `mature_fleet_rate <= max_sweep_rate`, `fleet_sweep_plans.rate BETWEEN 0 AND 0.70` |
| treasury address ≠ owner withdrawal address | `fleet_treasury_policy` table CHECK (case-insensitive) |
| every money amount positive (or ≥ 0 where a zero is meaningful) | `amount_cents > 0` on ledgers, obligations, transfers, spend requests; `>= 0` on balances, plans, approvals, deployed |
| agents never approve money decisions | `fleet_require_operator_approver()` in the allocation, sweep-reduction and custody-transfer guards |
| approved allocation needs amount, start and `expiry_date > start_date` | `fleet_capital_allocations` CHECK |
| approval at most 10× the request | `approved_amount_cents <= requested_amount_cents * 10` |
| reductions last at most 180 days | `fleet_sweep_reductions` CHECK `expires_at <= starts_at + interval '180 days'` |
| owner distributions never eat reserve or obligations | `fleet_owner_distributions` CHECK: planned ⇒ `approved_cents <= GREATEST(treasury_balance_cents - reserve_target_cents - obligations_cents, 0)` |
| nothing executes | sweep plan status only `planned_not_executed`; custody transfer status only `blocked_payments_disabled`; owner distribution status `rejected`/`planned_not_executed`; treasury ledger status `recorded`/`planned_not_executed` |
| append-only records | UPDATE/DELETE blocked on `fleet_agent_ledger`, `fleet_treasury_ledger`, `fleet_sweep_plans`, `fleet_owner_distributions`, `fleet_custody_transfers` |

#### Tables

`fleet_treasury_policy` (single row):

| Column | Type | Default | NOT NULL | CHECK |
|---|---|---|---|---|
| `id` | smallint | `1` | (PK) | `id = 1` |
| `runway_days` | integer | `30` | yes | `BETWEEN 0 AND 365` |
| `contingency_pct` | numeric | `0.10` | yes | `BETWEEN 0 AND 1` |
| `min_contingency_cents` | bigint | `1000` | yes | `>= 0` |
| `population_rates` | jsonb | `'[{"maxAgents":10,"rate":0.10},{"maxAgents":20,"rate":0.125},{"maxAgents":30,"rate":0.15},{"maxAgents":40,"rate":0.175},{"maxAgents":49,"rate":0.20}]'` | yes | — |
| `mature_fleet_rate` | numeric | `0.45` | yes | `BETWEEN 0 AND 0.70` |
| `max_sweep_rate` | numeric | `0.70` | yes | `BETWEEN 0 AND 0.70` |
| `reserve_target_months` | numeric | `3` | yes | `BETWEEN 0 AND 36` |
| `maturity_age_days` | integer | `180` | yes | `BETWEEN 1 AND 3650` |
| `treasury_address` | text | — | no | public-address regex |
| `owner_withdrawal_address` | text | — | no | public-address regex |
| `updated_at` | timestamptz | `now()` | yes | — |
| `updated_by` | text | — | no | — |

Table CHECKs: `mature_fleet_rate <= max_sweep_rate`; `treasury_address IS NULL OR owner_withdrawal_address IS NULL OR lower(treasury_address) <> lower(owner_withdrawal_address)`. Trigger `fleet_treasury_policy_no_delete`.

`fleet_agent_ledger` (append-only): `entry_id bigserial PK`; `agent_id text NOT NULL FK`; `kind text NOT NULL CHECK IN ('revenue','direct_cost','owner_funding','fleet_funding','allocation_deployed','allocation_returned','sweep_to_treasury')`; `amount_cents bigint NOT NULL CHECK > 0`; `occurred_at timestamptz NOT NULL DEFAULT now()`; `allocation_id text` (no FK); `reference text CHECK (length(reference) <= 200)`; `source text NOT NULL CHECK IN ('controller','operator','agent_reported')`; `recorded_by text`; `created_at timestamptz NOT NULL DEFAULT now()`. Index `fleet_agent_ledger_agent_idx (agent_id, occurred_at)`. Trigger `fleet_agent_ledger_no_change` (BEFORE UPDATE OR DELETE). Owner funding is a separate kind, never revenue (sweep is on net profit).

`fleet_balance_observations`: `observation_id bigserial PK`; `agent_id text NOT NULL FK`; `cash_cents bigint NOT NULL CHECK >= 0`; `observed_at timestamptz NOT NULL DEFAULT now()`; `source text NOT NULL CHECK IN ('controller','operator','agent_reported')`. Index `fleet_balance_observations_agent_idx (agent_id, observed_at DESC)`. No triggers.

`fleet_obligations` (approved per-agent operating obligations, never swept): `obligation_id text PK CHECK ULID`; `agent_id text NOT NULL FK`; `description text NOT NULL CHECK length 1..300`; `amount_cents bigint NOT NULL CHECK > 0`; `due_at timestamptz NOT NULL`; `status text NOT NULL DEFAULT 'approved' CHECK IN ('approved','settled','cancelled')`; `approved_by text NOT NULL`; `created_at`, `updated_at timestamptz NOT NULL DEFAULT now()`. No triggers.

`fleet_capital_allocations`:

| Column | Type | Default | NOT NULL | CHECK |
|---|---|---|---|---|
| `allocation_id` | text | — | (PK) | ULID |
| `agent_id` | text | — | yes | FK → fleet_agents |
| `kind` | text | `'growth'` | yes | `IN ('growth','rescue')` |
| `purpose` | text | — | yes | `length BETWEEN 1 AND 500` |
| `requested_amount_cents` | bigint | — | yes | `> 0` |
| `approved_amount_cents` | bigint | — | no | `>= 0` |
| `deployed_cents` | bigint | `0` | yes | `>= 0` |
| `start_date` | timestamptz | — | no | — |
| `expiry_date` | timestamptz | — | no | — |
| `expected_return_cents` | bigint | `0` | yes | `>= 0` |
| `expected_duration_days` | integer | — | yes | `BETWEEN 1 AND 3650` |
| `status` | text | `'proposed'` | yes | `IN ('proposed','approved','rejected','completed','expired','cancelled')` |
| `actual_return_cents` | bigint | — | no | — |
| `proposed_by` | text | — | yes | — |
| `decided_by` | text | — | no | — |
| `decided_at` | timestamptz | — | no | — |
| `decision_reason` | text | — | no | — |
| `created_at` | timestamptz | `now()` | yes | — |
| `updated_at` | timestamptz | `now()` | yes | — |

Table CHECKs: `status <> 'approved' OR (approved_amount_cents IS NOT NULL AND start_date IS NOT NULL AND expiry_date > start_date)`; `approved_amount_cents IS NULL OR approved_amount_cents <= requested_amount_cents * 10`. Index `fleet_capital_allocations_agent_idx (agent_id, status)`. Guard `fleet_allocations_guard` (BEFORE INSERT OR UPDATE): insert only `proposed`; `allocation_id, agent_id, proposed_by, requested_amount_cents, created_at` immutable; terminal `rejected/completed/expired/cancelled` immutable; transitions proposed→approved|rejected|cancelled, approved→completed|expired|cancelled; any change of status, approved amount, start or expiry requires `fleet_require_operator_approver(NEW.decided_by, NEW.agent_id)`; sets `updated_at = now()`. Trigger `fleet_allocations_no_delete`.

`fleet_sweep_reductions`: `reduction_id text PK ULID`; `agent_id text NOT NULL FK`; `allocation_id text FK → fleet_capital_allocations`; `reduction_pct numeric NOT NULL CHECK (> 0 AND <= 1)`; `reason text NOT NULL CHECK length 1..500`; `starts_at timestamptz NOT NULL DEFAULT now()`; `expires_at timestamptz NOT NULL`; `approved_by text NOT NULL`; `revoked_at timestamptz`; `created_at timestamptz NOT NULL DEFAULT now()`; CHECKs `expires_at > starts_at`, `expires_at <= starts_at + interval '180 days'`. Guard `fleet_sweep_reductions_guard` (BEFORE INSERT OR UPDATE) → `fleet_require_operator_approver(NEW.approved_by, NEW.agent_id)`. No delete protection.

`fleet_treasury_ledger` (append-only): `entry_id bigserial PK`; `kind text NOT NULL CHECK IN ('sweep_in','owner_funding_in','allocation_return_in','infrastructure','inference','maintenance','emergency_rescue','replacement_agent','approved_growth','compliance','contingency','owner_distribution')`; `amount_cents bigint NOT NULL CHECK > 0`; `status text NOT NULL CHECK IN ('recorded','planned_not_executed')`; `agent_id text FK` (nullable); `allocation_id text`; `reference text CHECK length <= 200`; `recorded_by text NOT NULL`; `occurred_at`, `created_at timestamptz NOT NULL DEFAULT now()`. Trigger `fleet_treasury_ledger_no_change`.

`fleet_treasury_obligations`: `obligation_id text PK ULID`; `category text NOT NULL`; `description text NOT NULL`; `amount_cents bigint NOT NULL CHECK > 0`; `due_at timestamptz NOT NULL`; `status text NOT NULL DEFAULT 'approved' CHECK IN ('approved','settled','cancelled')`; `approved_by text NOT NULL`; `created_at timestamptz NOT NULL DEFAULT now()`. No triggers.

`fleet_sweep_plans` (append-only): `plan_id text PK ULID`; `agent_id text NOT NULL FK`; `rate numeric NOT NULL CHECK BETWEEN 0 AND 0.70`; `amount_cents bigint NOT NULL CHECK >= 0`; `waterfall jsonb NOT NULL`; `status text NOT NULL DEFAULT 'planned_not_executed' CHECK IN ('planned_not_executed')`; `computed_by text NOT NULL`; `created_at timestamptz NOT NULL DEFAULT now()`. Trigger `fleet_sweep_plans_no_change`.

`fleet_owner_distributions` (append-only): `distribution_id text PK ULID`; `requested_cents bigint NOT NULL CHECK > 0`; `approved_cents bigint NOT NULL CHECK >= 0`; `treasury_balance_cents`, `reserve_target_cents`, `obligations_cents bigint NOT NULL`; `destination text`; `status text NOT NULL CHECK IN ('rejected','planned_not_executed')`; `reason text NOT NULL`; `decided_by text NOT NULL`; `created_at timestamptz NOT NULL DEFAULT now()`; CHECK `status <> 'planned_not_executed' OR approved_cents <= GREATEST(treasury_balance_cents - reserve_target_cents - obligations_cents, 0)`. Trigger `fleet_owner_distributions_no_change`.

`fleet_custody_transfers` (append-only): `transfer_id text PK ULID`; `from_agent_id text NOT NULL FK`; `destination text NOT NULL CHECK IN ('fleet_treasury','agent')`; `to_agent_id text FK`; `amount_cents bigint NOT NULL CHECK > 0`; `policy text NOT NULL CHECK IN ('quarantine_recovery','death_recovery','rebalance','sweep')`; `reason text NOT NULL`; `status text NOT NULL DEFAULT 'blocked_payments_disabled' CHECK IN ('blocked_payments_disabled')`; `approved_by text NOT NULL`; `created_at timestamptz NOT NULL DEFAULT now()`; CHECKs `(destination = 'agent') = (to_agent_id IS NOT NULL)`, `to_agent_id IS NULL OR to_agent_id <> from_agent_id`. Triggers `fleet_custody_transfers_guard` (BEFORE INSERT → approver check against `from_agent_id`), `fleet_custody_transfers_no_change`.

#### V5 functions

| Function | Returns | SECDEF | search_path | Behaviour |
|---|---|---|---|---|
| `fleet_require_operator_approver(p_approver, p_subject)` | void | no | pinned | NULL/blank → `FLEET_APPROVAL_REQUIRED: an operator approver is required`; approver = subject, or equals any `fleet_agents.agent_id`, or (case-insensitive) any agent `wallet_address` → `FLEET_SELF_APPROVAL: agents cannot approve capital exceptions (approver %)` (V8 adds operator principals) |
| `fleet_allocations_guard()` | trigger | no | pinned | above |
| `fleet_sweep_reductions_guard()` | trigger | no | pinned | above |
| `fleet_custody_transfers_guard()` | trigger | no | pinned | above |
| `api_propose_allocation(p_agent, p_token, p_allocation_id, p_purpose, p_requested_cents bigint, p_expected_return_cents bigint, p_expected_duration_days integer)` | jsonb | **yes** | pinned | GRANTED agent. Auth; agent must be `active` (`FLEET_AGENT_UNHEALTHY`); at most 5 `proposed` allocations per agent (`FLEET_TOO_MANY_PROPOSALS`); inserts `proposed` with scrubbed purpose (≤ 500), `proposed_by = p_agent`; event `capital_requested{allocationId, requestedCents}` |
| `api_request_spend(p_agent, p_token, p_request_id, p_from_wallet, p_to_address, p_amount_cents bigint, p_purpose, p_allocation_id)` | jsonb | **yes** | pinned | GRANTED agent. Auth; amount > 0 and destination matches the public-address regex (`FLEET_BAD_REQUEST`); `p_from_wallet` must be the caller's custody wallet (`authorization_denied`, `FLEET_NOT_AUTHORIZED`, "not the caller's custody wallet"); decision ladder: agent not `active` → denied; `spending_frozen` → denied; with an allocation: must be the caller's, `approved`, current (`now() BETWEEN start_date AND expiry_date`) and `deployed_cents + amount <= approved_amount_cents`; without: `sum(approved_not_executed in last 1 day) + amount <= daily_limit_cents`. Always inserts a `fleet_spend_requests` row; event `spend_denied` or `spend_approved_not_executed`; returns `{ok, decision, reason, executed:false}` |

Grants in V5: `REVOKE ALL ON ALL TABLES / ALL SEQUENCES / EXECUTE ON ALL FUNCTIONS … FROM PUBLIC`. No
restricted role receives any privilege on a treasury table; treasury decisions are owner-only
through `PgTreasuryStore` (§3.8).

#### V5 exact SQL

```sql
-- ── Treasury policy (single row; FleetAdmin-managed)
CREATE TABLE fleet_treasury_policy (
  id                       smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  runway_days              integer     NOT NULL DEFAULT 30   CHECK (runway_days BETWEEN 0 AND 365),
  contingency_pct          numeric     NOT NULL DEFAULT 0.10 CHECK (contingency_pct BETWEEN 0 AND 1),
  min_contingency_cents    bigint      NOT NULL DEFAULT 1000 CHECK (min_contingency_cents >= 0),
  population_rates         jsonb       NOT NULL DEFAULT '[{"maxAgents":10,"rate":0.10},{"maxAgents":20,"rate":0.125},{"maxAgents":30,"rate":0.15},{"maxAgents":40,"rate":0.175},{"maxAgents":49,"rate":0.20}]',
  mature_fleet_rate        numeric     NOT NULL DEFAULT 0.45 CHECK (mature_fleet_rate BETWEEN 0 AND 0.70),
  max_sweep_rate           numeric     NOT NULL DEFAULT 0.70 CHECK (max_sweep_rate BETWEEN 0 AND 0.70),
  reserve_target_months    numeric     NOT NULL DEFAULT 3    CHECK (reserve_target_months BETWEEN 0 AND 36),
  maturity_age_days        integer     NOT NULL DEFAULT 180  CHECK (maturity_age_days BETWEEN 1 AND 3650),
  treasury_address         text        CHECK (treasury_address ~ '^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$'),
  owner_withdrawal_address text        CHECK (owner_withdrawal_address ~ '^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$'),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               text,
  CHECK (mature_fleet_rate <= max_sweep_rate),
  -- The fleet treasury is never the owner's personal withdrawal destination.
  CHECK (treasury_address IS NULL OR owner_withdrawal_address IS NULL OR lower(treasury_address) <> lower(owner_withdrawal_address))
);
INSERT INTO fleet_treasury_policy (id) VALUES (1);
CREATE TRIGGER fleet_treasury_policy_no_delete BEFORE DELETE ON fleet_treasury_policy
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- No fleet agent id may ever appear as the approver of money decisions.
CREATE FUNCTION fleet_require_operator_approver(p_approver text, p_subject text) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_approver IS NULL OR length(trim(p_approver)) = 0 THEN
    RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: an operator approver is required';
  END IF;
  IF p_approver = p_subject OR EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = p_approver OR lower(wallet_address) = lower(p_approver)) THEN
    RAISE EXCEPTION 'FLEET_SELF_APPROVAL: agents cannot approve capital exceptions (approver %)', p_approver;
  END IF;
END $$;

-- ── Per-agent ledger (revenue/cost/funding). Owner funding is never revenue.
CREATE TABLE fleet_agent_ledger (
  entry_id      bigserial   PRIMARY KEY,
  agent_id      text        NOT NULL REFERENCES fleet_agents(agent_id),
  kind          text        NOT NULL CHECK (kind IN ('revenue','direct_cost','owner_funding','fleet_funding',
                                                     'allocation_deployed','allocation_returned','sweep_to_treasury')),
  amount_cents  bigint      NOT NULL CHECK (amount_cents > 0),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  allocation_id text,
  reference     text        CHECK (length(reference) <= 200),
  source        text        NOT NULL CHECK (source IN ('controller','operator','agent_reported')),
  recorded_by   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_agent_ledger_agent_idx ON fleet_agent_ledger (agent_id, occurred_at);
CREATE TRIGGER fleet_agent_ledger_no_change BEFORE UPDATE OR DELETE ON fleet_agent_ledger
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- Observed wallet balance (cash on hand) per agent.
CREATE TABLE fleet_balance_observations (
  observation_id bigserial   PRIMARY KEY,
  agent_id       text        NOT NULL REFERENCES fleet_agents(agent_id),
  cash_cents     bigint      NOT NULL CHECK (cash_cents >= 0),
  observed_at    timestamptz NOT NULL DEFAULT now(),
  source         text        NOT NULL CHECK (source IN ('controller','operator','agent_reported'))
);
CREATE INDEX fleet_balance_observations_agent_idx ON fleet_balance_observations (agent_id, observed_at DESC);

-- Approved operating obligations (never swept).
CREATE TABLE fleet_obligations (
  obligation_id text        PRIMARY KEY CHECK (obligation_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  agent_id      text        NOT NULL REFERENCES fleet_agents(agent_id),
  description   text        NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  amount_cents  bigint      NOT NULL CHECK (amount_cents > 0),
  due_at        timestamptz NOT NULL,
  status        text        NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','settled','cancelled')),
  approved_by   text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ── Capital allocations: agents propose; only FleetAdmin decides.
CREATE TABLE fleet_capital_allocations (
  allocation_id          text        PRIMARY KEY CHECK (allocation_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  agent_id               text        NOT NULL REFERENCES fleet_agents(agent_id),
  kind                   text        NOT NULL DEFAULT 'growth' CHECK (kind IN ('growth','rescue')),
  purpose                text        NOT NULL CHECK (length(purpose) BETWEEN 1 AND 500),
  requested_amount_cents bigint      NOT NULL CHECK (requested_amount_cents > 0),
  approved_amount_cents  bigint      CHECK (approved_amount_cents >= 0),
  deployed_cents         bigint      NOT NULL DEFAULT 0 CHECK (deployed_cents >= 0),
  start_date             timestamptz,
  expiry_date            timestamptz,
  expected_return_cents  bigint      NOT NULL DEFAULT 0 CHECK (expected_return_cents >= 0),
  expected_duration_days integer     NOT NULL CHECK (expected_duration_days BETWEEN 1 AND 3650),
  status                 text        NOT NULL DEFAULT 'proposed'
                                     CHECK (status IN ('proposed','approved','rejected','completed','expired','cancelled')),
  actual_return_cents    bigint,
  proposed_by            text        NOT NULL,
  decided_by             text,
  decided_at             timestamptz,
  decision_reason        text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'approved' OR (approved_amount_cents IS NOT NULL AND start_date IS NOT NULL AND expiry_date > start_date)),
  CHECK (approved_amount_cents IS NULL OR approved_amount_cents <= requested_amount_cents * 10)
);
CREATE INDEX fleet_capital_allocations_agent_idx ON fleet_capital_allocations (agent_id, status);

CREATE FUNCTION fleet_allocations_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'proposed' THEN
      RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: allocations start proposed';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.allocation_id <> NEW.allocation_id OR OLD.agent_id <> NEW.agent_id OR OLD.proposed_by <> NEW.proposed_by
     OR OLD.requested_amount_cents <> NEW.requested_amount_cents OR OLD.created_at <> NEW.created_at THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: allocation identity cannot change';
  END IF;
  IF OLD.status IN ('rejected','completed','expired','cancelled') THEN
    RAISE EXCEPTION 'FLEET_TERMINAL_STATE_IMMUTABLE: allocation % is %', OLD.allocation_id, OLD.status;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'proposed' AND NEW.status IN ('approved','rejected','cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('completed','expired','cancelled'))) THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: allocation % -> %', OLD.status, NEW.status;
  END IF;
  -- Any decision or change of terms needs an operator (never an agent).
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.approved_amount_cents IS DISTINCT FROM OLD.approved_amount_cents
     OR NEW.expiry_date IS DISTINCT FROM OLD.expiry_date OR NEW.start_date IS DISTINCT FROM OLD.start_date THEN
    PERFORM fleet_require_operator_approver(NEW.decided_by, NEW.agent_id);
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_allocations_guard BEFORE INSERT OR UPDATE ON fleet_capital_allocations
  FOR EACH ROW EXECUTE FUNCTION fleet_allocations_guard();
CREATE TRIGGER fleet_allocations_no_delete BEFORE DELETE ON fleet_capital_allocations
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- Temporary sweep reductions for approved high-value opportunities.
CREATE TABLE fleet_sweep_reductions (
  reduction_id  text        PRIMARY KEY CHECK (reduction_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  agent_id      text        NOT NULL REFERENCES fleet_agents(agent_id),
  allocation_id text        REFERENCES fleet_capital_allocations(allocation_id),
  reduction_pct numeric     NOT NULL CHECK (reduction_pct > 0 AND reduction_pct <= 1),
  reason        text        NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  starts_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  approved_by   text        NOT NULL,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > starts_at),
  CHECK (expires_at <= starts_at + interval '180 days')
);
CREATE FUNCTION fleet_sweep_reductions_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_require_operator_approver(NEW.approved_by, NEW.agent_id);
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_sweep_reductions_guard BEFORE INSERT OR UPDATE ON fleet_sweep_reductions
  FOR EACH ROW EXECUTE FUNCTION fleet_sweep_reductions_guard();

-- ── Fleet bank: treasury ledger (recorded = observed movements; planned = not executed)
CREATE TABLE fleet_treasury_ledger (
  entry_id      bigserial   PRIMARY KEY,
  kind          text        NOT NULL CHECK (kind IN ('sweep_in','owner_funding_in','allocation_return_in',
                                                     'infrastructure','inference','maintenance','emergency_rescue',
                                                     'replacement_agent','approved_growth','compliance','contingency',
                                                     'owner_distribution')),
  amount_cents  bigint      NOT NULL CHECK (amount_cents > 0),
  status        text        NOT NULL CHECK (status IN ('recorded','planned_not_executed')),
  agent_id      text        REFERENCES fleet_agents(agent_id),
  allocation_id text,
  reference     text        CHECK (length(reference) <= 200),
  recorded_by   text        NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_treasury_ledger_no_change BEFORE UPDATE OR DELETE ON fleet_treasury_ledger
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_treasury_obligations (
  obligation_id text        PRIMARY KEY CHECK (obligation_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  category      text        NOT NULL,
  description   text        NOT NULL,
  amount_cents  bigint      NOT NULL CHECK (amount_cents > 0),
  due_at        timestamptz NOT NULL,
  status        text        NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','settled','cancelled')),
  approved_by   text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fleet_sweep_plans (
  plan_id      text        PRIMARY KEY CHECK (plan_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  agent_id     text        NOT NULL REFERENCES fleet_agents(agent_id),
  rate         numeric     NOT NULL CHECK (rate BETWEEN 0 AND 0.70),
  amount_cents bigint      NOT NULL CHECK (amount_cents >= 0),
  waterfall    jsonb       NOT NULL,
  status       text        NOT NULL DEFAULT 'planned_not_executed' CHECK (status IN ('planned_not_executed')),
  computed_by  text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_sweep_plans_no_change BEFORE UPDATE OR DELETE ON fleet_sweep_plans
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_owner_distributions (
  distribution_id        text        PRIMARY KEY CHECK (distribution_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  requested_cents        bigint      NOT NULL CHECK (requested_cents > 0),
  approved_cents         bigint      NOT NULL CHECK (approved_cents >= 0),
  treasury_balance_cents bigint      NOT NULL,
  reserve_target_cents   bigint      NOT NULL,
  obligations_cents      bigint      NOT NULL,
  destination            text,
  status                 text        NOT NULL CHECK (status IN ('rejected','planned_not_executed')),
  reason                 text        NOT NULL,
  decided_by             text        NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'planned_not_executed' OR approved_cents <= GREATEST(treasury_balance_cents - reserve_target_cents - obligations_cents, 0))
);
CREATE TRIGGER fleet_owner_distributions_no_change BEFORE UPDATE OR DELETE ON fleet_owner_distributions
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_custody_transfers (
  transfer_id   text        PRIMARY KEY CHECK (transfer_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  from_agent_id text        NOT NULL REFERENCES fleet_agents(agent_id),
  destination   text        NOT NULL CHECK (destination IN ('fleet_treasury','agent')),
  to_agent_id   text        REFERENCES fleet_agents(agent_id),
  amount_cents  bigint      NOT NULL CHECK (amount_cents > 0),
  policy        text        NOT NULL CHECK (policy IN ('quarantine_recovery','death_recovery','rebalance','sweep')),
  reason        text        NOT NULL,
  status        text        NOT NULL DEFAULT 'blocked_payments_disabled' CHECK (status IN ('blocked_payments_disabled')),
  approved_by   text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((destination = 'agent') = (to_agent_id IS NOT NULL)),
  CHECK (to_agent_id IS NULL OR to_agent_id <> from_agent_id)
);
CREATE FUNCTION fleet_custody_transfers_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_require_operator_approver(NEW.approved_by, NEW.from_agent_id);
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_custody_transfers_guard BEFORE INSERT ON fleet_custody_transfers
  FOR EACH ROW EXECUTE FUNCTION fleet_custody_transfers_guard();
CREATE TRIGGER fleet_custody_transfers_no_change BEFORE UPDATE OR DELETE ON fleet_custody_transfers
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- ── Agent API (authenticated; own identity only)

-- Propose capital use. Creates a PROPOSED allocation; approval is operator-only.
CREATE FUNCTION api_propose_allocation(p_agent text, p_token text, p_allocation_id text, p_purpose text,
                                       p_requested_cents bigint, p_expected_return_cents bigint, p_expected_duration_days integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'propose_allocation'); a fleet_agents;
BEGIN
  IF v_code IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent;
  IF a.status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_AGENT_UNHEALTHY');
  END IF;
  IF (SELECT count(*) FROM fleet_capital_allocations WHERE agent_id = p_agent AND status = 'proposed') >= 5 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_TOO_MANY_PROPOSALS');
  END IF;
  INSERT INTO fleet_capital_allocations (allocation_id, agent_id, purpose, requested_amount_cents,
                                         expected_return_cents, expected_duration_days, proposed_by)
  VALUES (p_allocation_id, p_agent, left(fleet_scrub(p_purpose), 500), p_requested_cents,
          COALESCE(p_expected_return_cents, 0), p_expected_duration_days, p_agent);
  PERFORM fleet_event('capital_requested', p_agent, p_agent,
    jsonb_build_object('allocationId', p_allocation_id, 'requestedCents', p_requested_cents));
  RETURN jsonb_build_object('ok', true, 'allocationId', p_allocation_id, 'status', 'proposed');
END $$;

-- Spend request against the caller's OWN custody wallet. Decision only:
-- nothing is signed or sent (the controller signer executes only when real
-- payments are enabled, which they are not).
CREATE FUNCTION api_request_spend(p_agent text, p_token text, p_request_id text, p_from_wallet text, p_to_address text,
                                  p_amount_cents bigint, p_purpose text, p_allocation_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'request_spend'); a fleet_agents; w fleet_wallet_custody;
        al fleet_capital_allocations; v_today bigint; v_decision text := 'approved_not_executed'; v_reason text;
BEGIN
  IF v_code IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 OR p_to_address !~ '^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent;
  SELECT * INTO w FROM fleet_wallet_custody WHERE agent_id = p_agent;
  IF w.agent_id IS NULL OR lower(p_from_wallet) IS DISTINCT FROM lower(w.wallet_address) THEN
    PERFORM fleet_event('authorization_denied', NULL, p_agent,
      jsonb_build_object('action', 'request_spend', 'fromWallet', left(p_from_wallet, 64)));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_AUTHORIZED', 'reason', 'not the caller''s custody wallet');
  END IF;
  SELECT COALESCE(sum(amount_cents), 0) INTO v_today FROM fleet_spend_requests
   WHERE agent_id = p_agent AND decision = 'approved_not_executed' AND created_at > now() - interval '1 day';
  IF a.status <> 'active' THEN v_decision := 'denied'; v_reason := 'agent not healthy (' || a.status || ')';
  ELSIF w.spending_frozen THEN v_decision := 'denied'; v_reason := 'spending frozen: ' || COALESCE(w.frozen_reason, '');
  ELSIF p_allocation_id IS NOT NULL THEN
    SELECT * INTO al FROM fleet_capital_allocations WHERE allocation_id = p_allocation_id;
    IF al.allocation_id IS NULL OR al.agent_id <> p_agent OR al.status <> 'approved'
       OR now() NOT BETWEEN al.start_date AND al.expiry_date THEN
      v_decision := 'denied'; v_reason := 'allocation not approved, not yours, or not current';
    ELSIF al.deployed_cents + p_amount_cents > al.approved_amount_cents THEN
      v_decision := 'denied'; v_reason := 'exceeds approved allocation';
    END IF;
  ELSIF v_today + p_amount_cents > w.daily_limit_cents THEN
    v_decision := 'denied'; v_reason := format('exceeds daily limit (%s cents)', w.daily_limit_cents);
  END IF;
  INSERT INTO fleet_spend_requests (request_id, agent_id, wallet_address, to_address, amount_cents, purpose, allocation_id, decision, reason)
  VALUES (p_request_id, p_agent, w.wallet_address, p_to_address, p_amount_cents, left(fleet_scrub(p_purpose), 300),
          p_allocation_id, v_decision, v_reason);
  PERFORM fleet_event(CASE WHEN v_decision = 'denied' THEN 'spend_denied' ELSE 'spend_approved_not_executed' END,
    p_agent, p_agent, jsonb_build_object('requestId', p_request_id, 'amountCents', p_amount_cents, 'reason', v_reason));
  RETURN jsonb_build_object('ok', v_decision <> 'denied', 'decision', v_decision, 'reason', v_reason, 'executed', false);
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
```

### 2.6 Version 6 — `provisioning_intents_dry_run_child`

- **Source:** `src/fleet/postgres/migrations-phase6.ts:30-428` (`export const V6_SQL`, header `1-28`). Commit `2d6d4cf`.
- **Purpose:** close the Phase 5 "untracked sandbox window": each provisioning attempt carries a
  provisioning key (= reservation id) and a deterministic sandbox name `fleet-<lower(key)>`; a durable
  external-resource **intent** is recorded before the sandbox is created and create attempts are
  counted; a provisioning attempt that fails while its sandbox outcome is unknown becomes ORPHANED
  (holds a quarantine slot) instead of FAILED; reconciliation (`found`/`absent`/`unknown`).
  **DRY_RUN_CHILD:** operator-only `fleet_reserve_dry_run()` and guards that make dry-run agents
  unable to replicate, spend or hold capital.
- **Interpolations:** none.
- **Data migration:** `provisioning_key = provisioning_id`; `external_state = 'created'` where a
  sandbox id exists else `'none'`; then `provisioning_key` set NOT NULL.

#### Table changes

`fleet_provisioning` new columns:

| Column | Type | Default | NOT NULL | Constraint |
|---|---|---|---|---|
| `provisioning_key` | text | — | yes (after backfill) | unique index `fleet_provisioning_key_uq`; must equal `provisioning_id` (trigger) |
| `sandbox_name` | text | — | no | `~ '^fleet-[0-9a-z]{26}$'`; unique index `fleet_provisioning_sandbox_name_uq` WHERE NOT NULL |
| `external_state` | text | `'none'` | yes | `IN ('none','intent','created','absent','uncertain')`; index `fleet_provisioning_uncertain_idx (external_state) WHERE external_state IN ('intent','uncertain')` |
| `intent_at` | timestamptz | — | no | — |
| `create_attempts` | integer | `0` | yes | `BETWEEN 0 AND 10` |
| `reconciled_at` | timestamptz | — | no | — |
| `reconcile_note` | text | — | no | — |
| `dry_run` | boolean | `false` | yes | copied from the lease at insert (trigger) |

`fleet_orphans`: `sandbox_id` DROP NOT NULL; new column `sandbox_name text`.
`fleet_agents`: `dry_run boolean NOT NULL DEFAULT false` (becomes identity: immutable).
`fleet_reservations`: `dry_run boolean NOT NULL DEFAULT false`.

#### V6 functions and triggers

| Function (trigger) | Kind | search_path | Behaviour |
|---|---|---|---|
| `fleet_provisioning_defaults()` (`fleet_provisioning_defaults` BEFORE INSERT ON fleet_provisioning) | trigger | pinned | `provisioning_key := COALESCE(key, provisioning_id)`; key ≠ id → `FLEET_HISTORY_IMMUTABLE: provisioning key must equal the reservation id`; `dry_run` copied from `fleet_reservations` |
| `fleet_provisioning_key_immutable()` (`fleet_provisioning_key_immutable` BEFORE UPDATE ON fleet_provisioning) | trigger | none | `provisioning_key`, `dry_run` never change; `sandbox_name`, `sandbox_id` never change once set |
| `fleet_agents_transition_guard()` (replaced) | trigger | pinned | adds provisioning→orphaned; `dry_run` joins the immutable identity columns |
| `fleet_agents_provisioning_uncertain()` (`fleet_agents_a_provisioning_uncertain` BEFORE UPDATE OF status ON fleet_agents; the `a_` prefix makes it fire first) | trigger | pinned | provisioning→failed with a provisioning row that has no sandbox id and `external_state IN ('intent','uncertain')` is rewritten to `orphaned` (`death_time := NULL`, reason suffix `; sandbox creation outcome unknown (quarantine slot held until reconciled)`) — whatever path failed it |
| `fleet_agents_uncertain_effects()` (`fleet_agents_uncertain_effects` AFTER UPDATE OF status) | trigger | pinned | on provisioning→orphaned: provisioning row → `orphaned`, `external_state 'uncertain'`, `cleanup_status 'pending'`; orphan row with `holds_slot = true`, `sandbox_id NULL`, `sandbox_name`; event `provisioning_uncertain{provisioningKey, sandboxName, createAttempts, holdsSlot:true, capabilitiesRevoked:true}` |
| `fleet_terminations_resolve_orphan()` (`fleet_terminations_resolve_orphan` AFTER UPDATE OF status ON fleet_sandbox_terminations) | trigger | pinned | termination becoming `terminated` resolves the open orphan (`resolution 'sandbox termination confirmed'`, `resolved_by 'lifecycle'`) and turns an `orphaned` agent `dead` |
| `svc_provision_update(p_agent, p_parent, p_phase, p_sandbox)` (replaced) | SECDEF | pinned | new phase `sandbox_intent` (`p_sandbox` = the NAME): must equal `'fleet-' \|\| lower(provisioning_key)` (`FLEET_BAD_REQUEST`); known sandbox id → return it (a retry reuses, never creates); agent and record must be `provisioning` (`FLEET_INVALID_STATE`); `create_attempts >= 3` → `FLEET_PROVISIONING_UNCERTAIN`; else record name, `external_state 'intent'`, `intent_at`, attempts+1, event `provisioning_sandbox_intent`. `sandbox_created` sets `external_state 'created'`, fills an open orphan's missing sandbox id, and queues cleanup when the attempt already failed/orphaned. `verifying` unchanged. Returns `{ok, provisioningId, provisioningKey}` |
| `svc_provision_reconcile(p_key, p_outcome, p_sandbox, p_actor)` | SECDEF | pinned | outcome `found`/`absent`/`unknown` else `FLEET_BAD_REQUEST`; state lock; `found`: record sandbox (`FLEET_SANDBOX_MISMATCH` if a different id is known), and if the agent is no longer living/provisioning queue termination (+ event `sandbox_termination_requested{phase:'reconciled'}`); `absent`: refused if a sandbox id is known (`FLEET_SANDBOX_KNOWN`) or while reserved/provisioning before `activation_deadline` (`FLEET_PROVISIONING_IN_FLIGHT`); else `external_state 'absent'`, `cleanup_status 'not_required'`, orphaned record→`failed_provisioning`, open sandbox-less orphan resolved, orphaned agent → `dead` + `slot_released`; `unknown`: stays/becomes `uncertain` (slot held). Event `provisioning_reconciled`; returns `{ok, outcome, agentStatus}` |
| `fleet_reserve_dry_run(p_parent, p_requested_by, p_name, p_agent_id, p_reservation_id, p_ttl_ms bigint)` | owner-only (never granted), not SECDEF | pinned | independent of `replication_enabled`. State lock, expire leases; denials in order: mode not DEVELOPMENT/EXPANSION → `'FLEET_' \|\| mode` (e.g. `FLEET_HARVEST`, `FLEET_EMERGENCY`); no approved runtime → `FLEET_RUNTIME_UNVERIFIED`; any unresolved orphan → `FLEET_ORPHANS_UNRESOLVED`; `max_agents > 2` → `FLEET_DRY_RUN_CAP`; a living/quarantined dry-run agent exists → `FLEET_DRY_RUN_IN_PROGRESS`; `living+reserved+quarantined >= max_agents` → `FLEET_CAP_REACHED`; parent not an `active` non-dry-run **root** → `FLEET_PARENT_NOT_LIVING`. Denial event `reservation_denied{code, dryRun:true}`. Success inserts agent and lease with `dry_run = true`, `request_key = 'dry-run:' \|\| reservation_id`, event `slot_reserved{dryRun:true,…}` |
| `fleet_agents_dry_run_guard()` (`fleet_agents_dry_run_guard` BEFORE INSERT ON fleet_agents) | trigger | pinned | a dry-run parent → event `replication_rejected{code:'FLEET_DRY_RUN_NO_REPLICATION'}` then `RAISE 'FLEET_DRY_RUN_NO_REPLICATION: dry-run agent % cannot replicate'` (the event rolls back with the insert); `dry_run` on a non-child → raise |
| `fleet_custody_dry_run_guard()` (`fleet_custody_dry_run_guard` BEFORE INSERT OR UPDATE ON fleet_wallet_custody) | trigger | pinned | dry-run agent custody forced `spending_frozen = true`, `daily_limit_cents = 0`, reason `dry-run child: no spend authority` (replaced V7) |
| `fleet_allocations_dry_run_guard()` (`fleet_allocations_dry_run_guard` BEFORE INSERT ON fleet_capital_allocations) | trigger | pinned | `FLEET_DRY_RUN_NO_SPEND: dry-run agent % cannot hold capital` (replaced V7) |

Grants in V6: `REVOKE ALL ON ALL TABLES …; REVOKE EXECUTE ON ALL FUNCTIONS … FROM PUBLIC`. The dry
run's owner-only allocator is reached only through `PgFleetStore.reserveDryRunSlot()` (`store.ts:1063-1077`, admin credential).

#### V6 exact SQL

```sql
-- ── Provisioning key, deterministic sandbox name, external-resource intent
ALTER TABLE fleet_provisioning
  ADD COLUMN provisioning_key text,
  ADD COLUMN sandbox_name     text CHECK (sandbox_name ~ '^fleet-[0-9a-z]{26}$'),
  ADD COLUMN external_state   text NOT NULL DEFAULT 'none'
                              CHECK (external_state IN ('none','intent','created','absent','uncertain')),
  ADD COLUMN intent_at        timestamptz,
  ADD COLUMN create_attempts  integer NOT NULL DEFAULT 0 CHECK (create_attempts BETWEEN 0 AND 10),
  ADD COLUMN reconciled_at    timestamptz,
  ADD COLUMN reconcile_note   text,
  ADD COLUMN dry_run          boolean NOT NULL DEFAULT false;
UPDATE fleet_provisioning
   SET provisioning_key = provisioning_id,
       external_state = CASE WHEN sandbox_id IS NULL THEN 'none' ELSE 'created' END;
ALTER TABLE fleet_provisioning ALTER COLUMN provisioning_key SET NOT NULL;
CREATE UNIQUE INDEX fleet_provisioning_key_uq ON fleet_provisioning (provisioning_key);
CREATE UNIQUE INDEX fleet_provisioning_sandbox_name_uq ON fleet_provisioning (sandbox_name) WHERE sandbox_name IS NOT NULL;
CREATE INDEX fleet_provisioning_uncertain_idx ON fleet_provisioning (external_state)
  WHERE external_state IN ('intent','uncertain');

ALTER TABLE fleet_orphans ALTER COLUMN sandbox_id DROP NOT NULL;
ALTER TABLE fleet_orphans ADD COLUMN sandbox_name text;

ALTER TABLE fleet_agents ADD COLUMN dry_run boolean NOT NULL DEFAULT false;
ALTER TABLE fleet_reservations ADD COLUMN dry_run boolean NOT NULL DEFAULT false;

CREATE FUNCTION fleet_provisioning_defaults() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  NEW.provisioning_key := COALESCE(NEW.provisioning_key, NEW.provisioning_id);
  IF NEW.provisioning_key <> NEW.provisioning_id THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: provisioning key must equal the reservation id';
  END IF;
  NEW.dry_run := COALESCE((SELECT dry_run FROM fleet_reservations WHERE reservation_id = NEW.reservation_id), false);
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_provisioning_defaults BEFORE INSERT ON fleet_provisioning
  FOR EACH ROW EXECUTE FUNCTION fleet_provisioning_defaults();

CREATE FUNCTION fleet_provisioning_key_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provisioning_key IS DISTINCT FROM OLD.provisioning_key OR NEW.dry_run IS DISTINCT FROM OLD.dry_run
     OR (OLD.sandbox_name IS NOT NULL AND NEW.sandbox_name IS DISTINCT FROM OLD.sandbox_name)
     OR (OLD.sandbox_id IS NOT NULL AND NEW.sandbox_id IS DISTINCT FROM OLD.sandbox_id) THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: provisioning key, sandbox name/id and dry-run flag cannot change once set';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_provisioning_key_immutable BEFORE UPDATE ON fleet_provisioning
  FOR EACH ROW EXECUTE FUNCTION fleet_provisioning_key_immutable();

-- ── Transition guard (v6): PROVISIONING may become ORPHANED when its sandbox
-- outcome is uncertain; the dry-run flag is part of an agent's identity.
CREATE OR REPLACE FUNCTION fleet_agents_transition_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('reserved','active') THEN
      RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: cannot insert agent in status %', NEW.status;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.agent_id <> NEW.agent_id OR OLD.role <> NEW.role OR OLD.generation <> NEW.generation
     OR OLD.parent_agent_id IS DISTINCT FROM NEW.parent_agent_id
     OR OLD.created_at <> NEW.created_at OR OLD.dry_run <> NEW.dry_run THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: identity columns cannot change';
  END IF;
  IF OLD.wallet_address IS NOT NULL AND OLD.wallet_address IS DISTINCT FROM NEW.wallet_address THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: wallet_address cannot change once set';
  END IF;
  IF OLD.runtime_commit IS NOT NULL AND OLD.runtime_commit IS DISTINCT FROM NEW.runtime_commit AND OLD.role = 'child' THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: child runtime_commit cannot change';
  END IF;
  IF OLD.status = NEW.status THEN
    IF OLD.status IN ('dead','failed') AND OLD.death_time IS DISTINCT FROM NEW.death_time THEN
      RAISE EXCEPTION 'FLEET_TERMINAL_STATE_IMMUTABLE';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('dead','failed') THEN
    RAISE EXCEPTION 'FLEET_TERMINAL_STATE_IMMUTABLE: agent % is %', OLD.agent_id, OLD.status;
  END IF;
  IF NOT (
       (OLD.status = 'reserved'     AND NEW.status IN ('provisioning','failed'))
    OR (OLD.status = 'provisioning' AND NEW.status IN ('active','failed','orphaned'))
    OR (OLD.status = 'active'       AND NEW.status IN ('unresponsive','terminating','dead'))
    OR (OLD.status = 'unresponsive' AND NEW.status IN ('active','terminating','dead'))
    OR (OLD.status = 'terminating'  AND NEW.status IN ('orphaned','dead'))
    OR (OLD.status = 'orphaned'     AND NEW.status = 'dead')
  ) THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;

-- A provisioning attempt that fails while a sandbox MAY exist (intent
-- recorded, sandbox id never reported) is not allowed to free its slot:
-- whatever path fails it (lease expiry, verification failure, parent report),
-- it becomes ORPHANED. Named to sort before the other BEFORE triggers.
CREATE FUNCTION fleet_agents_provisioning_uncertain() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_provisioning;
BEGIN
  IF OLD.status = 'provisioning' AND NEW.status = 'failed' THEN
    SELECT * INTO p FROM fleet_provisioning WHERE expected_agent_id = NEW.agent_id;
    IF FOUND AND p.sandbox_id IS NULL AND p.external_state IN ('intent','uncertain') THEN
      NEW.status := 'orphaned';
      NEW.death_time := NULL;
      NEW.status_reason := left(COALESCE(NEW.status_reason, 'provisioning failed')
        || '; sandbox creation outcome unknown (quarantine slot held until reconciled)', 500);
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_agents_a_provisioning_uncertain BEFORE UPDATE OF status ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_provisioning_uncertain();

CREATE FUNCTION fleet_agents_uncertain_effects() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_provisioning;
BEGIN
  IF OLD.status = 'provisioning' AND NEW.status = 'orphaned' THEN
    SELECT * INTO p FROM fleet_provisioning WHERE expected_agent_id = NEW.agent_id FOR UPDATE;
    UPDATE fleet_provisioning
       SET status = 'orphaned', external_state = 'uncertain', cleanup_status = 'pending',
           failure_reason = left(NEW.status_reason, 500), updated_at = now()
     WHERE provisioning_id = p.provisioning_id;
    INSERT INTO fleet_orphans (agent_id, provisioning_id, sandbox_id, sandbox_name, reason, holds_slot)
    VALUES (NEW.agent_id, p.provisioning_id, NULL, p.sandbox_name,
            'provisioning outcome uncertain: sandbox creation was requested but never confirmed', true)
    ON CONFLICT DO NOTHING;
    PERFORM fleet_event('provisioning_uncertain', NEW.agent_id, 'lifecycle',
      jsonb_build_object('provisioningKey', p.provisioning_key, 'sandboxName', p.sandbox_name,
                         'createAttempts', p.create_attempts, 'holdsSlot', true, 'capabilitiesRevoked', true));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_agents_uncertain_effects AFTER UPDATE OF status ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_uncertain_effects();

-- A confirmed termination of an ORPHANED agent's sandbox resolves the orphan
-- and frees its quarantine slot (the orphan record stays, resolved).
CREATE FUNCTION fleet_terminations_resolve_orphan() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF NEW.status = 'terminated' AND OLD.status IS DISTINCT FROM 'terminated' THEN
    UPDATE fleet_orphans SET resolved_at = now(), resolution = 'sandbox termination confirmed', resolved_by = 'lifecycle'
     WHERE agent_id = NEW.agent_id AND resolved_at IS NULL;
    UPDATE fleet_agents SET status = 'dead', death_time = now(), updated_at = now(),
           status_reason = left(COALESCE(status_reason, '') || '; sandbox termination confirmed', 500)
     WHERE agent_id = NEW.agent_id AND status = 'orphaned';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_terminations_resolve_orphan AFTER UPDATE OF status ON fleet_sandbox_terminations
  FOR EACH ROW EXECUTE FUNCTION fleet_terminations_resolve_orphan();

-- ── Provisioning callbacks (v6): durable intent BEFORE the sandbox exists.
CREATE OR REPLACE FUNCTION svc_provision_update(p_agent text, p_parent text, p_phase text, p_sandbox text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_provisioning; a fleet_agents;
BEGIN
  SELECT * INTO p FROM fleet_provisioning WHERE expected_agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR (p_parent IS NOT NULL AND p.parent_agent_id <> p_parent) THEN
    PERFORM fleet_event('authorization_denied', NULL, p_parent, jsonb_build_object('action', 'provision_update', 'agentId', left(p_agent, 64)));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_AUTHORIZED');
  END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent;
  IF p_phase = 'sandbox_intent' THEN
    -- p_sandbox carries the deterministic sandbox NAME, not an id.
    IF p_sandbox IS DISTINCT FROM 'fleet-' || lower(p.provisioning_key) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'sandbox name must be derived from the provisioning key');
    END IF;
    IF p.sandbox_id IS NOT NULL THEN
      -- The sandbox is already known: a retry must reuse it, never create another.
      RETURN jsonb_build_object('ok', true, 'provisioningKey', p.provisioning_key, 'sandboxName', p.sandbox_name,
                                'sandboxId', p.sandbox_id, 'attempts', p.create_attempts);
    END IF;
    IF p.status <> 'provisioning' OR a.status <> 'provisioning' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE');
    END IF;
    IF p.create_attempts >= 3 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PROVISIONING_UNCERTAIN',
                                'reason', 'too many sandbox create attempts; reconcile before retrying');
    END IF;
    UPDATE fleet_provisioning
       SET sandbox_name = p_sandbox, external_state = 'intent', intent_at = COALESCE(intent_at, now()),
           create_attempts = create_attempts + 1, updated_at = now()
     WHERE provisioning_id = p.provisioning_id
     RETURNING * INTO p;
    PERFORM fleet_event('provisioning_sandbox_intent', p_agent, p_parent,
      jsonb_build_object('provisioningKey', p.provisioning_key, 'sandboxName', p.sandbox_name, 'attempt', p.create_attempts));
    RETURN jsonb_build_object('ok', true, 'provisioningKey', p.provisioning_key, 'sandboxName', p.sandbox_name,
                              'sandboxId', NULL, 'attempts', p.create_attempts);
  ELSIF p_phase = 'sandbox_created' THEN
    IF p_sandbox IS NULL OR length(p_sandbox) NOT BETWEEN 1 AND 128 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
    END IF;
    IF p.sandbox_id IS NOT NULL AND p.sandbox_id <> p_sandbox THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SANDBOX_MISMATCH');
    END IF;
    UPDATE fleet_provisioning SET sandbox_id = p_sandbox, external_state = 'created', updated_at = now()
     WHERE provisioning_id = p.provisioning_id;
    -- A sandbox reported after the attempt already failed is queued for cleanup at once.
    IF p.status IN ('failed_provisioning','orphaned') THEN
      UPDATE fleet_provisioning SET cleanup_status = 'pending'
       WHERE provisioning_id = p.provisioning_id AND cleanup_status IN ('not_required','none');
      UPDATE fleet_orphans SET sandbox_id = p_sandbox WHERE agent_id = p_agent AND resolved_at IS NULL AND sandbox_id IS NULL;
      INSERT INTO fleet_sandbox_terminations (agent_id, sandbox_id, status) VALUES (p_agent, p_sandbox, 'pending')
        ON CONFLICT (agent_id) DO NOTHING;
    END IF;
    PERFORM fleet_event('provisioning_sandbox_created', p_agent, p_parent,
      jsonb_build_object('provisioningId', p.provisioning_id, 'sandboxId', p_sandbox));
  ELSIF p_phase = 'verifying' THEN
    IF p.status <> 'provisioning' OR a.status <> 'provisioning' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE');
    END IF;
    UPDATE fleet_provisioning SET status = 'verifying', updated_at = now() WHERE provisioning_id = p.provisioning_id;
    PERFORM fleet_event('provisioning_verifying', p_agent, p_parent, jsonb_build_object('provisioningId', p.provisioning_id));
  ELSE
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  RETURN jsonb_build_object('ok', true, 'provisioningId', p.provisioning_id, 'provisioningKey', p.provisioning_key);
END $$;

-- ── Reconciliation of an uncertain sandbox outcome (parent via the service,
-- or the operator). found: the sandbox exists -> recorded, queued for
-- cleanup if the attempt is over. absent: confirmed never created (only
-- after the activation deadline, so no create can still be in flight) ->
-- the quarantine slot is freed. unknown: the provider cannot tell -> stays
-- uncertain (slot held).
CREATE FUNCTION svc_provision_reconcile(p_key text, p_outcome text, p_sandbox text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_provisioning; a fleet_agents;
BEGIN
  IF p_outcome NOT IN ('found','absent','unknown') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  PERFORM fleet_lock_state();
  SELECT * INTO p FROM fleet_provisioning WHERE provisioning_key = p_key FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND');
  END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p.expected_agent_id FOR UPDATE;
  IF p_outcome = 'found' THEN
    IF p_sandbox IS NULL OR length(p_sandbox) NOT BETWEEN 1 AND 128 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
    END IF;
    IF p.sandbox_id IS NOT NULL AND p.sandbox_id <> p_sandbox THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SANDBOX_MISMATCH');
    END IF;
    UPDATE fleet_provisioning SET sandbox_id = p_sandbox, external_state = 'created', reconciled_at = now(),
           reconcile_note = 'found by provisioning key', updated_at = now()
     WHERE provisioning_id = p.provisioning_id;
    IF a.status NOT IN ('reserved','provisioning','active','unresponsive') THEN
      UPDATE fleet_provisioning SET cleanup_status = 'pending'
       WHERE provisioning_id = p.provisioning_id AND cleanup_status IN ('none','not_required');
      UPDATE fleet_orphans SET sandbox_id = p_sandbox WHERE agent_id = a.agent_id AND resolved_at IS NULL AND sandbox_id IS NULL;
      INSERT INTO fleet_sandbox_terminations (agent_id, sandbox_id, status) VALUES (a.agent_id, p_sandbox, 'pending')
        ON CONFLICT (agent_id) DO NOTHING;
      PERFORM fleet_event('sandbox_termination_requested', a.agent_id, p_actor,
        jsonb_build_object('sandboxId', p_sandbox, 'provisioningKey', p_key, 'phase', 'reconciled'));
    END IF;
  ELSIF p_outcome = 'absent' THEN
    IF p.sandbox_id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SANDBOX_KNOWN', 'reason', 'a sandbox was reported for this provisioning');
    END IF;
    IF a.status IN ('reserved','provisioning') AND now() < p.activation_deadline THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PROVISIONING_IN_FLIGHT',
                                'reason', 'absence can only be concluded after the activation deadline');
    END IF;
    UPDATE fleet_provisioning
       SET external_state = 'absent', cleanup_status = 'not_required', reconciled_at = now(),
           reconcile_note = 'confirmed absent', updated_at = now(),
           status = CASE WHEN status = 'orphaned' THEN 'failed_provisioning' ELSE status END
     WHERE provisioning_id = p.provisioning_id;
    UPDATE fleet_orphans SET resolved_at = now(), resolution = 'reconciled: sandbox never created', resolved_by = left(p_actor, 128)
     WHERE agent_id = a.agent_id AND resolved_at IS NULL AND sandbox_id IS NULL;
    IF a.status = 'orphaned' THEN
      UPDATE fleet_agents SET status = 'dead', death_time = now(), updated_at = now(),
             status_reason = left(COALESCE(status_reason, '') || '; reconciled: sandbox never created', 500)
       WHERE agent_id = a.agent_id;
      PERFORM fleet_event('slot_released', a.agent_id, p_actor, jsonb_build_object('reason', 'reconciled: sandbox never created'));
    END IF;
  ELSE
    UPDATE fleet_provisioning SET external_state = CASE WHEN sandbox_id IS NULL THEN 'uncertain' ELSE external_state END,
           reconciled_at = now(), reconcile_note = left(COALESCE(p_sandbox, 'provider could not confirm'), 300), updated_at = now()
     WHERE provisioning_id = p.provisioning_id;
  END IF;
  PERFORM fleet_event('provisioning_reconciled', a.agent_id, p_actor,
    jsonb_build_object('provisioningKey', p_key, 'outcome', p_outcome, 'sandboxId', CASE WHEN p_outcome = 'found' THEN p_sandbox END));
  RETURN jsonb_build_object('ok', true, 'outcome', p_outcome, 'agentStatus', (SELECT status FROM fleet_agents WHERE agent_id = a.agent_id));
END $$;

-- ── DRY_RUN_CHILD
-- Operator-only (the admin credential; never granted to the service or
-- agent roles). Independent of the replication switch so the first remote
-- child can be proven while REAL_REPLICATION_ENABLED stays false.
CREATE FUNCTION fleet_reserve_dry_run(p_parent text, p_requested_by text, p_name text, p_agent_id text,
                                      p_reservation_id text, p_ttl_ms bigint) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st fleet_state; par fleet_agents; v_orphans integer; v_code text; v_reason text; v_exp timestamptz;
BEGIN
  PERFORM fleet_lock_state();
  PERFORM fleet_expire_leases(p_requested_by);
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  SELECT count(*) INTO v_orphans FROM fleet_orphans WHERE resolved_at IS NULL;
  IF st.operating_mode NOT IN ('DEVELOPMENT','EXPANSION') THEN
    v_code := 'FLEET_' || st.operating_mode; v_reason := format('Shared fleet state is %s.', st.operating_mode);
  ELSIF st.runtime_repo IS NULL OR st.runtime_build_id IS NULL THEN
    v_code := 'FLEET_RUNTIME_UNVERIFIED'; v_reason := 'No fleet-approved runtime build.';
  ELSIF v_orphans > 0 THEN
    v_code := 'FLEET_ORPHANS_UNRESOLVED'; v_reason := format('%s unresolved orphan(s); a dry run needs none.', v_orphans);
  ELSIF st.max_agents > 2 THEN
    v_code := 'FLEET_DRY_RUN_CAP'; v_reason := format('The dry run requires a fleet cap of at most 2 (cap is %s).', st.max_agents);
  ELSIF EXISTS (SELECT 1 FROM fleet_agents WHERE dry_run
                  AND status IN ('reserved','provisioning','active','unresponsive','terminating','orphaned')) THEN
    v_code := 'FLEET_DRY_RUN_IN_PROGRESS'; v_reason := 'A dry-run child already exists; quarantine or retire it first.';
  ELSIF st.living_agents + st.reserved_slots + st.quarantined_slots >= st.max_agents THEN
    v_code := 'FLEET_CAP_REACHED';
    v_reason := format('Fleet at cap (%s living + %s reserved + %s quarantined >= %s).',
                       st.living_agents, st.reserved_slots, st.quarantined_slots, st.max_agents);
  ELSE
    SELECT * INTO par FROM fleet_agents WHERE agent_id = p_parent;
    IF NOT FOUND OR par.role <> 'root' OR par.status <> 'active' OR par.dry_run THEN
      v_code := 'FLEET_PARENT_NOT_LIVING'; v_reason := 'The dry-run parent must be a living root agent.';
    END IF;
  END IF;
  IF v_code IS NOT NULL THEN
    PERFORM fleet_event('reservation_denied', NULL, p_requested_by, jsonb_build_object('code', v_code, 'dryRun', true));
    RETURN jsonb_build_object('ok', false, 'code', v_code, 'reason', v_reason,
      'living', st.living_agents, 'reserved', st.reserved_slots, 'max', st.max_agents);
  END IF;
  v_exp := now() + make_interval(secs => COALESCE(p_ttl_ms, st.reservation_ttl_s::bigint * 1000)::double precision / 1000);
  INSERT INTO fleet_agents (agent_id, parent_agent_id, role, generation, name, runtime_repo, runtime_commit,
                            status, requested_by, request_key, reservation_expires_at, dry_run)
  VALUES (p_agent_id, p_parent, 'child', par.generation + 1, p_name, st.runtime_repo, st.runtime_commit,
          'reserved', p_requested_by, 'dry-run:' || p_reservation_id, v_exp, true);
  INSERT INTO fleet_reservations (reservation_id, agent_id, parent_agent_id, status, expires_at,
                                  expected_repo, expected_commit, expected_build_id, expected_lockfile_sha256, dry_run)
  VALUES (p_reservation_id, p_agent_id, p_parent, 'reserved', v_exp,
          st.runtime_repo, st.runtime_commit, st.runtime_build_id, st.runtime_lockfile_sha256, true);
  PERFORM fleet_event('slot_reserved', p_agent_id, p_requested_by, jsonb_build_object(
    'reservationId', p_reservation_id, 'dryRun', true, 'living', st.living_agents, 'reserved', st.reserved_slots + 1,
    'max', st.max_agents, 'expiresAt', v_exp));
  RETURN jsonb_build_object('ok', true, 'agentId', p_agent_id, 'reservationId', p_reservation_id,
    'parentAgentId', p_parent, 'generation', par.generation + 1, 'expiresAt', v_exp, 'dryRun', true,
    'runtime', jsonb_build_object('repo', st.runtime_repo, 'commit', st.runtime_commit),
    'build', jsonb_build_object('buildId', st.runtime_build_id, 'lockfileSha256', st.runtime_lockfile_sha256));
END $$;

-- A dry-run agent can never be a parent (whatever path inserts the child).
CREATE FUNCTION fleet_agents_dry_run_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF NEW.parent_agent_id IS NOT NULL AND EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = NEW.parent_agent_id AND dry_run) THEN
    PERFORM fleet_event('replication_rejected', NULL, NEW.parent_agent_id,
      jsonb_build_object('code', 'FLEET_DRY_RUN_NO_REPLICATION'));
    RAISE EXCEPTION 'FLEET_DRY_RUN_NO_REPLICATION: dry-run agent % cannot replicate', NEW.parent_agent_id;
  END IF;
  IF NEW.dry_run AND NEW.role <> 'child' THEN
    RAISE EXCEPTION 'FLEET_DRY_RUN_NO_REPLICATION: only children can be dry-run agents';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_agents_dry_run_guard BEFORE INSERT ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_dry_run_guard();

-- A dry-run agent never has spend authority: its custody record is always
-- frozen with a zero daily limit, whatever writes it.
CREATE FUNCTION fleet_custody_dry_run_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = NEW.agent_id AND dry_run) THEN
    NEW.spending_frozen := true;
    NEW.daily_limit_cents := 0;
    NEW.frozen_reason := COALESCE(NEW.frozen_reason, 'dry-run child: no spend authority');
    NEW.frozen_at := COALESCE(NEW.frozen_at, now());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_custody_dry_run_guard BEFORE INSERT OR UPDATE ON fleet_wallet_custody
  FOR EACH ROW EXECUTE FUNCTION fleet_custody_dry_run_guard();

CREATE FUNCTION fleet_allocations_dry_run_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = NEW.agent_id AND dry_run) THEN
    RAISE EXCEPTION 'FLEET_DRY_RUN_NO_SPEND: dry-run agent % cannot hold capital', NEW.agent_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_allocations_dry_run_guard BEFORE INSERT ON fleet_capital_allocations
  FOR EACH ROW EXECUTE FUNCTION fleet_allocations_dry_run_guard();

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
```

### 2.7 Version 7 — `capability_scope_witness`

- **Source:** `src/fleet/postgres/migrations-phase7.ts:28-241` (`export function v7Sql(hardMax)`, header `1-24`). Called as `v7Sql(FLEET_PG_HARD_MAX_AGENTS)`. Commit `cdfd70c` (FLEET-KI-4).
- **Purpose:** immutable capability scope on the agent identity: `'full'` (every existing agent) or
  `'witness'` (a root that exists only to be the living parent of the operator dry run). Because it
  is on the agent row read by `fleet_authenticate`, credential rotation and credential→session
  exchange cannot escape it.
- **Interpolations:** `${hardMax}` twice at line 174 (`fleet_reserve_slot`) → `50`.

#### Changes

- `fleet_agents.capability_scope text NOT NULL DEFAULT 'full'` with `CONSTRAINT fleet_agents_capability_scope_valid CHECK (capability_scope IN ('full','witness'))`.
- `CONSTRAINT fleet_agents_witness_is_root CHECK (capability_scope = 'full' OR (role = 'root' AND NOT dry_run AND parent_agent_id IS NULL))`.
- `fleet_agents_scope_immutable()` + trigger `fleet_agents_zz_scope_immutable` BEFORE UPDATE ON fleet_agents FOR EACH ROW **WHEN (OLD.capability_scope IS DISTINCT FROM NEW.capability_scope)** → `FLEET_HISTORY_IMMUTABLE: capability_scope of agent % cannot change after enrollment` (the `zz_` prefix makes it fire after every other BEFORE UPDATE trigger, so its WHEN sees their changes).
- `fleet_agents_scope_parent_guard()` + trigger `fleet_agents_scope_parent_guard` BEFORE INSERT: a non-dry-run child whose parent's scope ≠ `full` → `FLEET_PARENT_SCOPE: agent % has a restricted capability scope and cannot replicate`.
- `fleet_custody_dry_run_guard()` replaced: custody frozen with zero limit for dry-run agents **and** any scope ≠ `full` (reason `'<scope> identity: no spend authority'`).
- `fleet_allocations_dry_run_guard()` replaced: additionally `FLEET_SCOPE_DENIED: restricted identity % cannot hold capital`.
- `fleet_authenticate()` replaced: V4 logic, then scope ≠ `full` and not (`witness` AND action IN ('open_session','heartbeat','whoami')) → event `scope_denied{action, scope, layer:'database'}` and `FLEET_SCOPE_DENIED` (unknown scope fails closed).
- `api_whoami()` replaced: adds `capabilityScope`.
- `fleet_reserve_slot()` replaced: after the parent-living check, parent scope ≠ `full` → `FLEET_PARENT_SCOPE`.

`svc_*` functions are unchanged; the witness restriction on lease routes is enforced by the fleet
service route policy (`src/fleet/service/server.ts`), not the database (`migrations-phase7.ts:20-23`).

Grants in V7: `REVOKE ALL ON ALL TABLES …; REVOKE EXECUTE ON ALL FUNCTIONS … FROM PUBLIC`.

#### V7 exact SQL

```sql
-- ── Capability scope (identity, immutable)
ALTER TABLE fleet_agents ADD COLUMN capability_scope text NOT NULL DEFAULT 'full'
  CONSTRAINT fleet_agents_capability_scope_valid CHECK (capability_scope IN ('full','witness'));
ALTER TABLE fleet_agents ADD CONSTRAINT fleet_agents_witness_is_root
  CHECK (capability_scope = 'full' OR (role = 'root' AND NOT dry_run AND parent_agent_id IS NULL));

CREATE FUNCTION fleet_agents_scope_immutable() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: capability_scope of agent % cannot change after enrollment', OLD.agent_id;
END $$;
-- Named to sort after every other BEFORE UPDATE trigger, so its WHEN sees their changes.
CREATE TRIGGER fleet_agents_zz_scope_immutable BEFORE UPDATE ON fleet_agents
  FOR EACH ROW WHEN (OLD.capability_scope IS DISTINCT FROM NEW.capability_scope)
  EXECUTE FUNCTION fleet_agents_scope_immutable();

-- A restricted identity can never be the parent of a normal child, whatever
-- path inserts it. Dry-run children (operator-only fleet_reserve_dry_run) are allowed.
CREATE FUNCTION fleet_agents_scope_parent_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF NEW.parent_agent_id IS NOT NULL AND NOT NEW.dry_run
     AND EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = NEW.parent_agent_id AND capability_scope <> 'full') THEN
    RAISE EXCEPTION 'FLEET_PARENT_SCOPE: agent % has a restricted capability scope and cannot replicate', NEW.parent_agent_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_agents_scope_parent_guard BEFORE INSERT ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_scope_parent_guard();

-- No spend authority for dry-run agents (v6) or restricted identities (v7):
-- custody is always frozen with a zero daily limit, whatever writes it.
CREATE OR REPLACE FUNCTION fleet_custody_dry_run_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents;
BEGIN
  SELECT * INTO a FROM fleet_agents WHERE agent_id = NEW.agent_id;
  IF FOUND AND (a.dry_run OR a.capability_scope <> 'full') THEN
    NEW.spending_frozen := true;
    NEW.daily_limit_cents := 0;
    NEW.frozen_reason := COALESCE(NEW.frozen_reason,
      CASE WHEN a.dry_run THEN 'dry-run child: no spend authority'
           ELSE a.capability_scope || ' identity: no spend authority' END);
    NEW.frozen_at := COALESCE(NEW.frozen_at, now());
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION fleet_allocations_dry_run_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = NEW.agent_id AND dry_run) THEN
    RAISE EXCEPTION 'FLEET_DRY_RUN_NO_SPEND: dry-run agent % cannot hold capital', NEW.agent_id;
  END IF;
  IF EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = NEW.agent_id AND capability_scope <> 'full') THEN
    RAISE EXCEPTION 'FLEET_SCOPE_DENIED: restricted identity % cannot hold capital', NEW.agent_id;
  END IF;
  RETURN NEW;
END $$;

-- ── Authentication (v4) + capability scope. Unchanged for 'full'. A
-- restricted identity passes only an explicit allow-list of actions; any
-- other action, and any unknown scope, fails closed.
CREATE OR REPLACE FUNCTION fleet_authenticate(p_agent text, p_token text, p_action text) RETURNS text LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_agent_credentials; s fleet_agent_sessions; v_status text; v_scope text; v_hash text;
BEGIN
  IF p_agent IS NULL OR p_token IS NULL OR length(p_token) > 256 OR length(p_agent) > 64 THEN
    PERFORM fleet_event('db_auth_failed', NULL, NULL, jsonb_build_object('action', p_action, 'why', 'malformed'));
    RETURN 'FLEET_AUTH_FAILED';
  END IF;
  v_hash := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  SELECT status, capability_scope INTO v_status, v_scope FROM fleet_agents WHERE agent_id = p_agent;
  IF p_token LIKE 'fs1.%' THEN
    SELECT * INTO s FROM fleet_agent_sessions WHERE session_hash = v_hash;
    IF NOT FOUND OR s.agent_id <> p_agent THEN
      PERFORM fleet_event('db_auth_failed', NULL, NULL,
        jsonb_build_object('action', p_action, 'claimedAgentId', left(p_agent, 64), 'why', 'bad session'));
      RETURN 'FLEET_AUTH_FAILED';
    END IF;
  ELSE
    SELECT * INTO c FROM fleet_agent_credentials WHERE agent_id = p_agent;
    IF NOT FOUND OR c.token_hash <> v_hash THEN
      PERFORM fleet_event('db_auth_failed', NULL, NULL,
        jsonb_build_object('action', p_action, 'claimedAgentId', left(p_agent, 64), 'why', 'bad credential'));
      RETURN 'FLEET_AUTH_FAILED';
    END IF;
  END IF;
  IF v_status IN ('dead','failed') THEN
    RETURN 'FLEET_AGENT_DEAD';
  END IF;
  IF v_status IN ('terminating','orphaned') THEN
    PERFORM fleet_event('db_auth_failed', p_agent, p_agent, jsonb_build_object('action', p_action, 'why', 'quarantined'));
    RETURN 'FLEET_AGENT_QUARANTINED';
  END IF;
  IF (s.session_hash IS NOT NULL AND s.revoked_at IS NOT NULL) OR (c.agent_id IS NOT NULL AND c.revoked_at IS NOT NULL) THEN
    PERFORM fleet_event('db_auth_failed', p_agent, p_agent, jsonb_build_object('action', p_action, 'why', 'revoked'));
    RETURN 'FLEET_AUTH_FAILED';
  END IF;
  IF s.session_hash IS NOT NULL THEN
    IF s.expires_at <= now() THEN
      RETURN 'FLEET_SESSION_EXPIRED';
    END IF;
    IF EXISTS (SELECT 1 FROM fleet_agent_credentials WHERE agent_id = p_agent AND revoked_at IS NOT NULL) THEN
      RETURN 'FLEET_AUTH_FAILED';
    END IF;
  END IF;
  IF v_scope IS DISTINCT FROM 'full'
     AND NOT (v_scope = 'witness' AND p_action IN ('open_session','heartbeat','whoami')) THEN
    PERFORM fleet_event('scope_denied', p_agent, p_agent,
      jsonb_build_object('action', left(COALESCE(p_action, ''), 64), 'scope', v_scope, 'layer', 'database'));
    RETURN 'FLEET_SCOPE_DENIED';
  END IF;
  RETURN NULL;
END $$;

-- whoami (v2) + capability scope, so an agent (and the witness) can see its own scope.
CREATE OR REPLACE FUNCTION api_whoami(p_agent text, p_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'whoami'); a fleet_agents;
BEGIN
  IF v_code IS NOT NULL AND v_code <> 'FLEET_AGENT_DEAD' THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent;
  RETURN jsonb_build_object('ok', v_code IS NULL, 'code', v_code, 'agent', jsonb_build_object(
    'agentId', a.agent_id, 'parentAgentId', a.parent_agent_id, 'role', a.role, 'generation', a.generation,
    'name', a.name, 'walletAddress', a.wallet_address, 'runtimeVersion', a.runtime_version,
    'runtimeRepo', a.runtime_repo, 'runtimeCommit', a.runtime_commit, 'sandboxId', a.sandbox_id,
    'localChildId', a.local_child_id, 'status', a.status, 'statusReason', a.status_reason,
    'requestedBy', a.requested_by, 'createdAt', a.created_at, 'updatedAt', a.updated_at,
    'lastHeartbeat', a.last_heartbeat, 'deathTime', a.death_time, 'capabilityScope', a.capability_scope));
END $$;

-- ── Slot allocator (v4) + a restricted parent is refused (FLEET_PARENT_SCOPE).
CREATE OR REPLACE FUNCTION fleet_reserve_slot(
  p_parent text, p_requested_by text, p_name text, p_request_key text, p_local_max integer,
  p_ttl_ms bigint, p_match_pin boolean, p_repo text, p_commit text, p_agent_id text, p_reservation_id text
) RETURNS jsonb LANGUAGE plpgsql SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st fleet_state; par fleet_agents; mx integer; v_code text; v_reason text; v_exp timestamptz; v_orphans integer; v_occ integer;
BEGIN
  PERFORM fleet_lock_state();
  PERFORM fleet_expire_leases(p_requested_by);
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  mx := LEAST(st.max_agents, COALESCE(p_local_max, ${hardMax}), ${hardMax});
  v_occ := st.living_agents + st.reserved_slots + st.quarantined_slots;
  SELECT count(*) INTO v_orphans FROM fleet_orphans WHERE resolved_at IS NULL;

  IF st.operating_mode = 'EMERGENCY' OR st.operating_mode NOT IN ('DEVELOPMENT','EXPANSION','HARVEST') THEN
    v_code := 'FLEET_EMERGENCY'; v_reason := 'Shared fleet state is EMERGENCY.';
  ELSIF st.operating_mode = 'DEVELOPMENT' THEN
    v_code := 'FLEET_DEVELOPMENT_MODE'; v_reason := 'Shared fleet state is DEVELOPMENT.';
  ELSIF st.operating_mode = 'HARVEST' THEN
    v_code := 'FLEET_HARVEST'; v_reason := 'Shared fleet state is HARVEST.';
  ELSIF NOT st.replication_enabled THEN
    v_code := 'REAL_REPLICATION_DISABLED'; v_reason := 'Replication is disabled in the shared fleet registry.';
  ELSIF st.runtime_repo IS NULL OR st.runtime_build_id IS NULL THEN
    v_code := 'FLEET_RUNTIME_UNVERIFIED'; v_reason := 'No fleet-approved runtime build.';
  ELSIF p_match_pin AND (p_repo IS DISTINCT FROM st.runtime_repo OR p_commit IS DISTINCT FROM st.runtime_commit) THEN
    v_code := 'FLEET_RUNTIME_UNVERIFIED'; v_reason := 'Child runtime pin does not match the fleet-approved runtime.';
  ELSIF v_orphans > st.max_open_orphans THEN
    v_code := 'FLEET_ORPHANS_UNRESOLVED';
    v_reason := format('%s unresolved orphaned sandboxes exceed the limit of %s.', v_orphans, st.max_open_orphans);
  END IF;

  IF v_code IS NULL THEN
    SELECT * INTO par FROM fleet_agents WHERE agent_id = p_parent;
    IF NOT FOUND OR par.status <> 'active' THEN
      v_code := 'FLEET_PARENT_NOT_LIVING'; v_reason := 'Parent is not a living, healthy registered fleet agent.';
    ELSIF par.capability_scope <> 'full' THEN
      v_code := 'FLEET_PARENT_SCOPE'; v_reason := format('Parent has the restricted capability scope %s and cannot replicate.', par.capability_scope);
    ELSIF EXISTS (SELECT 1 FROM fleet_wallet_custody WHERE agent_id = p_parent AND spending_frozen) THEN
      v_code := 'FLEET_PARENT_FROZEN'; v_reason := 'Parent spending authority is frozen.';
    ELSIF EXISTS (SELECT 1 FROM fleet_agents WHERE request_key = p_request_key) THEN
      v_code := 'FLEET_DUPLICATE_REQUEST'; v_reason := 'Replication request already registered.';
    ELSIF v_occ >= mx THEN
      v_code := 'FLEET_CAP_REACHED';
      v_reason := format('Fleet at cap (%s living + %s reserved + %s quarantined >= %s).',
                         st.living_agents, st.reserved_slots, st.quarantined_slots, mx);
    END IF;
  END IF;

  IF v_code IS NOT NULL THEN
    PERFORM fleet_event('reservation_denied', NULL, p_requested_by,
      jsonb_build_object('code', v_code, 'living', st.living_agents, 'reserved', st.reserved_slots,
                         'quarantined', st.quarantined_slots, 'max', mx));
    RETURN jsonb_build_object('ok', false, 'code', v_code, 'reason', v_reason,
      'living', st.living_agents, 'reserved', st.reserved_slots, 'max', mx);
  END IF;

  v_exp := now() + make_interval(secs => COALESCE(p_ttl_ms, st.reservation_ttl_s::bigint * 1000)::double precision / 1000);
  INSERT INTO fleet_agents (agent_id, parent_agent_id, role, generation, name, runtime_repo, runtime_commit,
                            status, requested_by, request_key, reservation_expires_at)
  VALUES (p_agent_id, p_parent, 'child', par.generation + 1, p_name, st.runtime_repo, st.runtime_commit,
          'reserved', p_requested_by, p_request_key, v_exp);
  INSERT INTO fleet_reservations (reservation_id, agent_id, parent_agent_id, status, expires_at,
                                  expected_repo, expected_commit, expected_build_id, expected_lockfile_sha256)
  VALUES (p_reservation_id, p_agent_id, p_parent, 'reserved', v_exp,
          st.runtime_repo, st.runtime_commit, st.runtime_build_id, st.runtime_lockfile_sha256);
  PERFORM fleet_event('slot_reserved', p_agent_id, p_requested_by, jsonb_build_object(
    'reservationId', p_reservation_id, 'living', st.living_agents, 'reserved', st.reserved_slots + 1, 'max', mx,
    'expiresAt', v_exp));
  RETURN jsonb_build_object('ok', true, 'agentId', p_agent_id, 'reservationId', p_reservation_id,
    'parentAgentId', p_parent, 'generation', par.generation + 1, 'expiresAt', v_exp,
    'runtime', jsonb_build_object('repo', st.runtime_repo, 'commit', st.runtime_commit),
    'build', jsonb_build_object('buildId', st.runtime_build_id, 'lockfileSha256', st.runtime_lockfile_sha256));
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
```

### 2.8 Version 8 — `operator_api_read_only`

- **Source:** `src/fleet/postgres/migrations-phase8.ts:33-532` (`export const V8_SQL`, header `1-29`). Commit `5a5469e` (Phase B2).
- **Purpose:** the read-only Operator API. Operator principals are **not** agents (no slots, wallets,
  custody or lifecycle). Each request is Ed25519-signed and verified by the Operator API process;
  PostgreSQL stores public keys only. **Signature-termination invariant:** PostgreSQL cannot verify
  Ed25519, so the operator role's whole surface must stay observational: every `op_*` is STABLE except
  `op_begin_request`, which writes only operator bookkeeping (nonces, request audit, counter) and
  denial events; routes can point only at five read functions.
- **Interpolations:**

| Expression | Line | Resolved |
|---|---|---|
| `${OPERATOR_REQUEST_CAP}` (DEFAULT) | 40 | `2000000` |
| `${OPERATOR_REQUEST_CAP}` (CHECK) | 40 | `2000000` |

- **Template-literal escape:** line 284 contains `E'\n'`. Inside a JavaScript template literal `\n` is
  an escape, so the SQL string sent to PostgreSQL contains `E'` + a real line-feed + `'`. PostgreSQL
  reads that as a one-character string containing LF — the same value `E'\n'` denotes — so
  the archive digest is computed over LF-terminated lines either way. When re-typing the SQL outside
  TypeScript, write `E'\n'`.
- **Seeds:** `fleet_operator_state (id=1)`; five `fleet_operator_routes` rows.
- **Built-ins used:** `gen_random_uuid()` (core since PostgreSQL 13), `sha256()` (core since 11); no extension is required. Production runs PostgreSQL 16.15 (`docs/fleet-production-runbook.md:69`).

#### Tables

`fleet_operator_state` (single row; kill switch, generation, bounded audit counter):

| Column | Type | Default | NOT NULL | CHECK |
|---|---|---|---|---|
| `id` | integer | — | (PK) | `id = 1` |
| `operator_api_enabled` | boolean | `false` | yes | — (kill switch; off after migration) |
| `generation` | bigint | `0` | yes | `>= 0` |
| `request_count` | bigint | `0` | yes | `>= 0` |
| `request_cap` | bigint | `2000000` | yes | `request_cap = 2000000` |
| `updated_at` | timestamptz | `now()` | yes | — |
| `updated_by` | text | `'migration'` | yes | `length BETWEEN 1 AND 128` |

Guard `fleet_operator_state_guard` (BEFORE UPDATE): `request_count` may decrease only when the
transaction-local GUC `fleet.operator_archive = 'on'` (set only by the archival function);
`generation` never decreases. Triggers `fleet_operator_state_no_delete`, `…_no_truncate`.

`fleet_operator_principals`:

| Column | Type | Default | NOT NULL | Constraint |
|---|---|---|---|---|
| `principal_id` | text | — | (PK) | `~ '^op_[0-9A-HJKMNP-TV-Z]{26}$'` |
| `name` | text | — | yes | UNIQUE; `~ '^[a-z][a-z0-9-]{2,40}$'` |
| `kind` | text | — | yes | `IN ('bridge_claude','bridge_chatgpt')` |
| `scopes` | text[] | — | yes | `cardinality(scopes) BETWEEN 1 AND 3 AND scopes <@ ARRAY['ops.read.status','ops.read.agents','ops.read.events'] AND array_position(scopes, NULL) IS NULL` |
| `created_at` | timestamptz | `now()` | yes | — |
| `created_by` | text | — | yes | `length BETWEEN 1 AND 128` |
| `revoked_at` | timestamptz | — | no | — |
| `revoked_by` | text | — | no | `length <= 128` |
| `revoke_reason` | text | — | no | `length <= 200` |

Named CHECKs: `fleet_operator_principals_revocation_complete ((revoked_at IS NULL) = (revoked_by IS NULL))`;
`fleet_operator_principals_chatgpt_no_events (kind <> 'bridge_chatgpt' OR NOT ('ops.read.events' = ANY (scopes)))`.
Guard `fleet_operator_principals_guard` (BEFORE INSERT OR UPDATE): no duplicate scopes, cannot be
created revoked; `principal_id, name, kind, scopes, created_at, created_by` immutable; revocation
final. `…_no_delete`, `…_no_truncate`.

`fleet_operator_keys`:

| Column | Type | Default | NOT NULL | Constraint |
|---|---|---|---|---|
| `key_id` | text | — | (PK) | `~ '^[0-9a-f]{32}$'` |
| `principal_id` | text | — | yes | FK → fleet_operator_principals |
| `algorithm` | text | `'ed25519'` | yes | `= 'ed25519'` |
| `public_key` | bytea | — | yes | UNIQUE; `octet_length = 32` |
| `not_before` | timestamptz | `now()` | yes | — |
| `expires_at` | timestamptz | — | yes | — |
| `created_at` | timestamptz | `now()` | yes | — |
| `created_by` | text | — | yes | `length BETWEEN 1 AND 128` |
| `revoked_at` | timestamptz | — | no | — |
| `revoked_by` | text | — | no | `length <= 128` |
| `revoke_reason` | text | — | no | `length <= 200` |

Named CHECKs: `fleet_operator_keys_id_is_fingerprint (key_id = left(encode(sha256(public_key), 'hex'), 32))`;
`fleet_operator_keys_validity (expires_at > not_before AND expires_at <= not_before + interval '90 days')`;
`fleet_operator_keys_revocation_complete`. Index `fleet_operator_keys_principal_idx (principal_id) WHERE revoked_at IS NULL`.
Guard `fleet_operator_keys_guard`: cannot be created revoked; locks the principal row `FOR UPDATE`
then refuses a revoked principal; at most **2 active keys** per principal; key material immutable;
revocation final. `…_no_delete`, `…_no_truncate`.

`fleet_operator_nonces` (replay ledger): `principal_id text NOT NULL FK`; `nonce_sha256 text NOT NULL CHECK ~ 64 hex`; `expires_at timestamptz NOT NULL`; PK `(principal_id, nonce_sha256)`; index `fleet_operator_nonces_expiry_idx (expires_at)`; only TRUNCATE is blocked (rows are deleted after expiry by `op_begin_request`).

`fleet_operator_routes` (immutable map): `route text PK CHECK ~ '^GET /v1/operator/[a-z0-9_/{}-]+$'`; `scope text CHECK (NULL or one of the three read scopes)`; `fn text NOT NULL UNIQUE CHECK IN ('op_whoami','op_fleet_status','op_list_agents','op_get_agent','op_list_events')`; `kinds text[] NOT NULL CHECK (cardinality 1..2 AND kinds <@ ARRAY['bridge_claude','bridge_chatgpt'])`. Triggers `…_no_change` (UPDATE/DELETE), `…_no_truncate`. Seed rows:

| route | scope | fn | kinds |
|---|---|---|---|
| `GET /v1/operator/whoami` | NULL | `op_whoami` | bridge_claude, bridge_chatgpt |
| `GET /v1/operator/status` | `ops.read.status` | `op_fleet_status` | bridge_claude, bridge_chatgpt |
| `GET /v1/operator/agents` | `ops.read.agents` | `op_list_agents` | bridge_claude, bridge_chatgpt |
| `GET /v1/operator/agents/{agent_id}` | `ops.read.agents` | `op_get_agent` | bridge_claude, bridge_chatgpt |
| `GET /v1/operator/events` | `ops.read.events` | `op_list_events` | bridge_claude |

`fleet_operator_requests` (accepted-request audit, append-only, hashes only): `request_id uuid PK`;
`principal_id text NOT NULL FK`; `key_id text NOT NULL FK → fleet_operator_keys`; `route text NOT NULL FK → fleet_operator_routes`; `scope text`; `client_ts timestamptz NOT NULL`; `nonce_sha256`, `body_sha256 text NOT NULL CHECK ~ 64 hex`; `received_at timestamptz NOT NULL DEFAULT now()`. Indexes `fleet_operator_requests_principal_idx (principal_id, received_at)`, `fleet_operator_requests_received_idx (received_at)`. Guard `fleet_operator_requests_guard` (BEFORE UPDATE OR DELETE): DELETE allowed only while `fleet.operator_archive = 'on'`; everything else `FLEET_HISTORY_IMMUTABLE: % on fleet_operator_requests is not allowed (archive with fleet:admin operator-archive)`. `…_no_truncate`. Retention: capped at 2,000,000 by `request_count`; never deleted automatically.

#### V8 functions

| Function | Returns | Volatility | SECDEF | Granted to | Behaviour |
|---|---|---|---|---|---|
| `fleet_operator_state_guard()` | trigger | volatile | no | — | above |
| `fleet_operator_principals_guard()` | trigger | volatile | no | — | above |
| `fleet_operator_keys_guard()` | trigger | volatile | no | — | above |
| `fleet_operator_requests_guard()` | trigger | volatile | no | — | above |
| `fleet_operator_request_line(r fleet_operator_requests)` | text | sql STABLE | no | — | canonical JSON line: `requestId, principalId, keyId, route, scope, clientTs, nonceSha256, bodySha256, receivedAt`, timestamps as `YYYY-MM-DD"T"HH24:MI:SS.US"Z"` in UTC |
| `fleet_operator_archive_check(p_before timestamptz, p_rows bigint)` | void | plpgsql STABLE | no | — | cutoff at least 1 minute in the past; batch 1..100000 |
| `fleet_operator_archive_export(p_before timestamptz, p_max_rows integer)` | TABLE(line text) | plpgsql STABLE | no | — | canonical lines of rows `received_at < p_before`, ordered `(received_at, request_id)`, limit |
| `fleet_operator_archive_requests(p_before, p_expected_rows bigint, p_export_sha256 text, p_actor text)` | bigint | plpgsql VOLATILE | no | owner only | actor must match `^operator:[A-Za-z0-9._-]{1,64}$` (`FLEET_APPROVAL_REQUIRED`); digest 64 hex; locks the state row; re-selects the same rows `FOR UPDATE`, recomputes `sha256(string_agg(line || LF))`; count and digest must match the export; sets `fleet.operator_archive = 'on'` (transaction-local), deletes, checks the delete count, decreases `request_count`, sets it back `'off'`; event `operator_requests_archived{before, rows, remaining, exportSha256}` |
| `fleet_require_operator_approver()` (replaced) | void | volatile | no | — | V5 rules plus: approver matching `^op[:_]` (case-insensitive) or equal to any operator principal id or name → `FLEET_SELF_APPROVAL: operator API principals can never approve (approver %)` |
| `fleet_operator_request_ok(p_request uuid, p_fn text)` | fleet_operator_requests | plpgsql STABLE | no | — | the request must exist, be younger than **30 s**, map to a route whose `fn = p_fn`, with an unrevoked principal, an unrevoked unexpired key, the kill switch on, the scope held (or route scope NULL) and the principal kind allowed; else `RAISE 'FLEET_OP_REQUEST_INVALID'` |
| `op_begin_request(p_principal, p_key, p_route text, p_client_ts_ms bigint, p_nonce, p_body_sha256 text)` | jsonb | **VOLATILE** | **yes** | fleet_operator | see below |
| `op_key_material(p_principal, p_key)` | jsonb | plpgsql STABLE | **yes** | fleet_operator | `{ok:false}` unless principal and key valid, unrevoked, within `not_before..expires_at`; else `{ok:true, publicKey (base64), kind, scopes, expiresAt}` |
| `op_ping()` | jsonb | sql STABLE | **yes** | fleet_operator | unauthenticated readiness: `schemaVersion, operatorApiEnabled, generation, requestCount, requestCap, dbTime, runtimeRepo, runtimeCommit, runtimeBuildId, runtimeLockfileSha256` |
| `op_whoami(p_request uuid)` | jsonb | plpgsql STABLE | **yes** | fleet_operator | `{principal{id,name,kind,scopes sorted}, key{id,expiresAt}}` |
| `op_fleet_status(p_request uuid)` | jsonb | plpgsql STABLE | **yes** | fleet_operator | `{fleet{maxAgents,living,reserved,quarantined,mode,replicationEnabled}, runtime{repo,commit,buildId,lockfileSha256}, schema{version}, operatorApi{enabled,requestCount,requestCap}}` |
| `fleet_operator_agent_json(a fleet_agents)` | jsonb | sql STABLE | no | — | `agentId, role, generation, parentAgentId, status, capabilityScope, dryRun, runtimeCommit, createdAt, lastHeartbeat, deathTime, name` (no wallet, sandbox or credential data) |
| `op_list_agents(p_request uuid, p_after text, p_limit integer)` | jsonb | plpgsql STABLE | **yes** | fleet_operator | keyset by `agent_id > p_after`; limit `LEAST(GREATEST(COALESCE(p_limit,50),1),200)`; returns **limit + 1** items (caller detects "more") and `limit` |
| `op_get_agent(p_request uuid, p_agent text)` | jsonb | plpgsql STABLE | **yes** | fleet_operator | `{found:false}` or `{found:true, item}` |
| `op_list_events(p_request uuid, p_after bigint, p_limit integer, p_type text)` | jsonb | plpgsql STABLE | **yes** | fleet_operator | keyset by `id > p_after`, optional `event_type = p_type`; items `{id (text), type, agentId, actor, createdAt, detail}`; limit as above, returns limit + 1 |

**`op_begin_request` decision order** (first failure wins; the denial is returned as `{ok:false, code}`):

1. `v_actor = 'op:' || p_principal` if the id is well-formed else `'op:invalid'`; route looked up
   (`'unknown'` if absent).
2. Malformed input → `FLEET_OP_BAD_REQUEST` (event type `operator_bad_request`): principal not
   `^op_[0-9A-HJKMNP-TV-Z]{26}$`, key not 32 hex, nonce not `^[A-Za-z0-9_-]{22,64}$`, body hash not 64
   hex, `p_client_ts_ms` NULL or outside `1000000000000..9999999999999`.
3. Unknown route → `FLEET_OP_NOT_FOUND` (`operator_bad_request`).
4. State row locked `FOR UPDATE`; kill switch off → `FLEET_OP_DISABLED` (`operator_disabled`);
   `request_count >= request_cap` → `FLEET_OP_AUDIT_FULL` (`operator_audit_full`).
5. Principal missing/revoked, key missing/revoked/not yet valid/expired → `FLEET_OP_AUTH_FAILED`
   (`operator_auth_failed`); kind not in route kinds or scope missing → `FLEET_OP_SCOPE_DENIED` (`operator_scope_denied`).
6. `|now() - client_ts| > 30 s` → `FLEET_OP_STALE` (`operator_stale`).
7. Nonce: `INSERT (principal, sha256(nonce), client_ts + 60 s) ON CONFLICT DO NOTHING`; 0 rows →
   `FLEET_OP_REPLAYED` (`operator_replay_blocked`).
8. Denial audit throttle: an event is written only if fewer than 60 events with actor `op:%` were
   created in the last minute among the newest 1000 event ids; the denial stands regardless.
9. Success: `request_id = gen_random_uuid()`; insert `fleet_operator_requests`; `request_count + 1`;
   delete up to 1000 expired nonces; return `{ok:true, requestId, fn, requestCount, requestCap}`.

Grants in V8: `REVOKE ALL ON ALL TABLES …; REVOKE EXECUTE ON ALL FUNCTIONS … FROM PUBLIC`; the
operator role receives only the 8 `OPERATOR_API_FUNCTIONS` via `grantOperatorRole` (§1.7). The
Operator API runs every read in `BEGIN TRANSACTION READ ONLY` and only `op_begin_request`
read-write (`src/fleet/operator/gateway.ts:74-103`).

#### V8 exact SQL

```sql
-- ── Kill switch, generation and bounded audit counter (single row)
CREATE TABLE fleet_operator_state (
  id                    integer     PRIMARY KEY CHECK (id = 1),
  operator_api_enabled  boolean     NOT NULL DEFAULT false,
  generation            bigint      NOT NULL DEFAULT 0 CHECK (generation >= 0),
  request_count         bigint      NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  request_cap           bigint      NOT NULL DEFAULT ${OPERATOR_REQUEST_CAP} CHECK (request_cap = ${OPERATOR_REQUEST_CAP}),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            text        NOT NULL DEFAULT 'migration' CHECK (length(updated_by) BETWEEN 1 AND 128)
);
INSERT INTO fleet_operator_state (id) VALUES (1);

CREATE FUNCTION fleet_operator_state_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF NEW.request_count < OLD.request_count AND COALESCE(current_setting('fleet.operator_archive', true), '') <> 'on' THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: the operator request counter only decreases through audited archival';
  END IF;
  IF NEW.generation < OLD.generation THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: the operator generation never decreases';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_operator_state_guard BEFORE UPDATE ON fleet_operator_state
  FOR EACH ROW EXECUTE FUNCTION fleet_operator_state_guard();
CREATE TRIGGER fleet_operator_state_no_delete BEFORE DELETE ON fleet_operator_state
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_operator_state_no_truncate BEFORE TRUNCATE ON fleet_operator_state
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ── Principals (never agents) and their Ed25519 public keys
CREATE TABLE fleet_operator_principals (
  principal_id   text        PRIMARY KEY CHECK (principal_id ~ '^op_[0-9A-HJKMNP-TV-Z]{26}$'),
  name           text        NOT NULL UNIQUE CHECK (name ~ '^[a-z][a-z0-9-]{2,40}$'),
  kind           text        NOT NULL CHECK (kind IN ('bridge_claude','bridge_chatgpt')),
  scopes         text[]      NOT NULL CHECK (
                   cardinality(scopes) BETWEEN 1 AND 3
                   AND scopes <@ ARRAY['ops.read.status','ops.read.agents','ops.read.events']::text[]
                   AND array_position(scopes, NULL) IS NULL),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text        NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  revoked_at     timestamptz,
  revoked_by     text        CHECK (length(revoked_by) <= 128),
  revoke_reason  text        CHECK (length(revoke_reason) <= 200),
  CONSTRAINT fleet_operator_principals_revocation_complete CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CONSTRAINT fleet_operator_principals_chatgpt_no_events CHECK (kind <> 'bridge_chatgpt' OR NOT ('ops.read.events' = ANY (scopes)))
);

CREATE TABLE fleet_operator_keys (
  key_id         text        PRIMARY KEY CHECK (key_id ~ '^[0-9a-f]{32}$'),
  principal_id   text        NOT NULL REFERENCES fleet_operator_principals(principal_id),
  algorithm      text        NOT NULL DEFAULT 'ed25519' CHECK (algorithm = 'ed25519'),
  public_key     bytea       NOT NULL UNIQUE CHECK (octet_length(public_key) = 32),
  not_before     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text        NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  revoked_at     timestamptz,
  revoked_by     text        CHECK (length(revoked_by) <= 128),
  revoke_reason  text        CHECK (length(revoke_reason) <= 200),
  CONSTRAINT fleet_operator_keys_id_is_fingerprint CHECK (key_id = left(encode(sha256(public_key), 'hex'), 32)),
  CONSTRAINT fleet_operator_keys_validity CHECK (expires_at > not_before AND expires_at <= not_before + interval '90 days'),
  CONSTRAINT fleet_operator_keys_revocation_complete CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX fleet_operator_keys_principal_idx ON fleet_operator_keys (principal_id) WHERE revoked_at IS NULL;

-- Identity fields are immutable; revocation is set once and never cleared.
CREATE FUNCTION fleet_operator_principals_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (SELECT count(DISTINCT s) FROM unnest(NEW.scopes) s) <> cardinality(NEW.scopes) THEN
      RAISE EXCEPTION 'FLEET_OPERATOR_INVALID: duplicate scopes';
    END IF;
    IF NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'FLEET_OPERATOR_INVALID: a principal cannot be created revoked';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.principal_id IS DISTINCT FROM OLD.principal_id OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.scopes IS DISTINCT FROM OLD.scopes
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: operator principal identity cannot change';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
     OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason) THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: operator revocation is final';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_operator_principals_guard BEFORE INSERT OR UPDATE ON fleet_operator_principals
  FOR EACH ROW EXECUTE FUNCTION fleet_operator_principals_guard();
CREATE TRIGGER fleet_operator_principals_no_delete BEFORE DELETE ON fleet_operator_principals
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_operator_principals_no_truncate BEFORE TRUNCATE ON fleet_operator_principals
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_operator_keys_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'FLEET_OPERATOR_INVALID: a key cannot be created revoked';
    END IF;
    -- Lock the principal first, then test revocation on the locked row, so a
    -- concurrent revocation cannot be missed.
    PERFORM 1 FROM fleet_operator_principals WHERE principal_id = NEW.principal_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM fleet_operator_principals WHERE principal_id = NEW.principal_id AND revoked_at IS NOT NULL) THEN
      RAISE EXCEPTION 'FLEET_OPERATOR_INVALID: principal % is revoked', NEW.principal_id;
    END IF;
    IF (SELECT count(*) FROM fleet_operator_keys WHERE principal_id = NEW.principal_id AND revoked_at IS NULL) >= 2 THEN
      RAISE EXCEPTION 'FLEET_OPERATOR_INVALID: principal % already has 2 active keys (revoke one first)', NEW.principal_id;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.key_id IS DISTINCT FROM OLD.key_id OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.algorithm IS DISTINCT FROM OLD.algorithm OR NEW.public_key IS DISTINCT FROM OLD.public_key
     OR NEW.not_before IS DISTINCT FROM OLD.not_before OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: operator key material cannot change';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
     OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason) THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: operator key revocation is final';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_operator_keys_guard BEFORE INSERT OR UPDATE ON fleet_operator_keys
  FOR EACH ROW EXECUTE FUNCTION fleet_operator_keys_guard();
CREATE TRIGGER fleet_operator_keys_no_delete BEFORE DELETE ON fleet_operator_keys
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_operator_keys_no_truncate BEFORE TRUNCATE ON fleet_operator_keys
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ── Replay ledger (hashed nonces; purged only after expiry)
CREATE TABLE fleet_operator_nonces (
  principal_id  text        NOT NULL REFERENCES fleet_operator_principals(principal_id),
  nonce_sha256  text        NOT NULL CHECK (nonce_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at    timestamptz NOT NULL,
  PRIMARY KEY (principal_id, nonce_sha256)
);
CREATE INDEX fleet_operator_nonces_expiry_idx ON fleet_operator_nonces (expires_at);
CREATE TRIGGER fleet_operator_nonces_no_truncate BEFORE TRUNCATE ON fleet_operator_nonces
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ── Route -> scope -> function map. Routes can only point at the read functions.
CREATE TABLE fleet_operator_routes (
  route  text   PRIMARY KEY CHECK (route ~ '^GET /v1/operator/[a-z0-9_/{}-]+$'),
  scope  text   CHECK (scope IS NULL OR scope IN ('ops.read.status','ops.read.agents','ops.read.events')),
  fn     text   NOT NULL UNIQUE CHECK (fn IN ('op_whoami','op_fleet_status','op_list_agents','op_get_agent','op_list_events')),
  kinds  text[] NOT NULL CHECK (cardinality(kinds) BETWEEN 1 AND 2
                                AND kinds <@ ARRAY['bridge_claude','bridge_chatgpt']::text[])
);
INSERT INTO fleet_operator_routes (route, scope, fn, kinds) VALUES
  ('GET /v1/operator/whoami',            NULL,              'op_whoami',       ARRAY['bridge_claude','bridge_chatgpt']),
  ('GET /v1/operator/status',            'ops.read.status', 'op_fleet_status', ARRAY['bridge_claude','bridge_chatgpt']),
  ('GET /v1/operator/agents',            'ops.read.agents', 'op_list_agents',  ARRAY['bridge_claude','bridge_chatgpt']),
  ('GET /v1/operator/agents/{agent_id}', 'ops.read.agents', 'op_get_agent',    ARRAY['bridge_claude','bridge_chatgpt']),
  ('GET /v1/operator/events',            'ops.read.events', 'op_list_events',  ARRAY['bridge_claude']);
CREATE TRIGGER fleet_operator_routes_no_change BEFORE UPDATE OR DELETE ON fleet_operator_routes
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_operator_routes_no_truncate BEFORE TRUNCATE ON fleet_operator_routes
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ── Accepted-request audit (append-only; hashes only)
CREATE TABLE fleet_operator_requests (
  request_id    uuid        PRIMARY KEY,
  principal_id  text        NOT NULL REFERENCES fleet_operator_principals(principal_id),
  key_id        text        NOT NULL REFERENCES fleet_operator_keys(key_id),
  route         text        NOT NULL REFERENCES fleet_operator_routes(route),
  scope         text,
  client_ts     timestamptz NOT NULL,
  nonce_sha256  text        NOT NULL CHECK (nonce_sha256 ~ '^[0-9a-f]{64}$'),
  body_sha256   text        NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  received_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_operator_requests_principal_idx ON fleet_operator_requests (principal_id, received_at);
CREATE INDEX fleet_operator_requests_received_idx ON fleet_operator_requests (received_at);

-- UPDATE is never allowed; DELETE only inside the audited archival function.
CREATE FUNCTION fleet_operator_requests_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND COALESCE(current_setting('fleet.operator_archive', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: % on fleet_operator_requests is not allowed (archive with fleet:admin operator-archive)', TG_OP;
END $$;
CREATE TRIGGER fleet_operator_requests_guard BEFORE UPDATE OR DELETE ON fleet_operator_requests
  FOR EACH ROW EXECUTE FUNCTION fleet_operator_requests_guard();
CREATE TRIGGER fleet_operator_requests_no_truncate BEFORE TRUNCATE ON fleet_operator_requests
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ── Owner-only, audited archival (never granted; never automatic).
-- Rows leave in bounded batches (<= 100000) and only after a verified export:
--   1. the CLI reads canonical lines from fleet_operator_archive_export,
--      writes them to a new 0600 file, reads the file back and checks its
--      SHA-256, size and line count;
--   2. fleet_operator_archive_requests re-selects the same rows (locked),
--      recomputes the digest of their canonical lines and deletes them only if
--      the row count AND the digest equal what the CLI exported.
-- Any mismatch or error raises, so the transaction leaves every row intact.
CREATE FUNCTION fleet_operator_request_line(r fleet_operator_requests) RETURNS text LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'requestId', r.request_id, 'principalId', r.principal_id, 'keyId', r.key_id, 'route', r.route,
    'scope', r.scope,
    'clientTs', to_char(r.client_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'nonceSha256', r.nonce_sha256, 'bodySha256', r.body_sha256,
    'receivedAt', to_char(r.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text
$$;

CREATE FUNCTION fleet_operator_archive_check(p_before timestamptz, p_rows bigint) RETURNS void LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_before IS NULL OR p_before > now() - interval '1 minute' THEN
    RAISE EXCEPTION 'FLEET_OPERATOR_INVALID: archival cutoff must be at least one minute in the past';
  END IF;
  IF p_rows IS NULL OR p_rows < 1 OR p_rows > 100000 THEN
    RAISE EXCEPTION 'FLEET_OPERATOR_INVALID: archival batch must be 1..100000 rows';
  END IF;
END $$;

CREATE FUNCTION fleet_operator_archive_export(p_before timestamptz, p_max_rows integer)
RETURNS TABLE (line text) LANGUAGE plpgsql STABLE SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_operator_archive_check(p_before, p_max_rows);
  RETURN QUERY SELECT fleet_operator_request_line(r) FROM fleet_operator_requests r
    WHERE r.received_at < p_before ORDER BY r.received_at, r.request_id LIMIT p_max_rows;
END $$;

CREATE FUNCTION fleet_operator_archive_requests(p_before timestamptz, p_expected_rows bigint, p_export_sha256 text, p_actor text)
RETURNS bigint LANGUAGE plpgsql SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE
  v_ids uuid[];
  v_n bigint;
  v_sha text;
  v_deleted bigint;
  v_remaining bigint;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN
    RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: archival requires an operator actor';
  END IF;
  IF p_export_sha256 IS NULL OR p_export_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'FLEET_OPERATOR_INVALID: export digest required';
  END IF;
  PERFORM fleet_operator_archive_check(p_before, p_expected_rows);
  PERFORM 1 FROM fleet_operator_state WHERE id = 1 FOR UPDATE;
  SELECT array_agg(s.request_id ORDER BY s.received_at, s.request_id),
         count(*),
         encode(sha256(convert_to(COALESCE(string_agg(s.line || E'\n', '' ORDER BY s.received_at, s.request_id), ''), 'UTF8')), 'hex')
    INTO v_ids, v_n, v_sha
    FROM (SELECT r.request_id, r.received_at, fleet_operator_request_line(r) AS line
            FROM fleet_operator_requests r
           WHERE r.received_at < p_before
           ORDER BY r.received_at, r.request_id
           LIMIT p_expected_rows
             FOR UPDATE) s;
  IF v_n <> p_expected_rows THEN
    RAISE EXCEPTION 'FLEET_OPERATOR_INVALID: archival matched % rows, export had %', v_n, p_expected_rows;
  END IF;
  IF v_sha <> p_export_sha256 THEN
    RAISE EXCEPTION 'FLEET_OPERATOR_INVALID: archival digest does not match the export';
  END IF;
  PERFORM set_config('fleet.operator_archive', 'on', true);
  DELETE FROM fleet_operator_requests WHERE request_id = ANY (v_ids);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> v_n THEN
    RAISE EXCEPTION 'FLEET_OPERATOR_INVALID: archival deleted % rows, expected %', v_deleted, v_n;
  END IF;
  UPDATE fleet_operator_state SET request_count = GREATEST(request_count - v_n, 0), updated_at = now(), updated_by = p_actor WHERE id = 1;
  PERFORM set_config('fleet.operator_archive', 'off', true);
  SELECT count(*) INTO v_remaining FROM fleet_operator_requests WHERE received_at < p_before;
  PERFORM fleet_event('operator_requests_archived', NULL, p_actor,
    jsonb_build_object('before', p_before, 'rows', v_n, 'remaining', v_remaining, 'exportSha256', p_export_sha256));
  RETURN v_n;
END $$;

-- ── Approver rule: operator principals can never approve anything.
CREATE OR REPLACE FUNCTION fleet_require_operator_approver(p_approver text, p_subject text) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_approver IS NULL OR length(trim(p_approver)) = 0 THEN
    RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: an operator approver is required';
  END IF;
  IF p_approver = p_subject OR EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = p_approver OR lower(wallet_address) = lower(p_approver)) THEN
    RAISE EXCEPTION 'FLEET_SELF_APPROVAL: agents cannot approve capital exceptions (approver %)', p_approver;
  END IF;
  IF p_approver ~* '^op[:_]' OR EXISTS (SELECT 1 FROM fleet_operator_principals WHERE principal_id = p_approver OR name = p_approver) THEN
    RAISE EXCEPTION 'FLEET_SELF_APPROVAL: operator API principals can never approve (approver %)', p_approver;
  END IF;
END $$;

-- ── Read-surface helper (owner-only, never granted): validates a request id
-- for exactly one read function. STABLE: it cannot write.
CREATE FUNCTION fleet_operator_request_ok(p_request uuid, p_fn text) RETURNS fleet_operator_requests LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_operator_requests;
BEGIN
  SELECT q.* INTO r FROM fleet_operator_requests q
    JOIN fleet_operator_routes rt ON rt.route = q.route AND rt.fn = p_fn
    JOIN fleet_operator_principals p ON p.principal_id = q.principal_id AND p.revoked_at IS NULL
    JOIN fleet_operator_keys k ON k.key_id = q.key_id AND k.revoked_at IS NULL AND now() < k.expires_at
    JOIN fleet_operator_state s ON s.id = 1 AND s.operator_api_enabled
   WHERE q.request_id = p_request AND q.received_at > now() - interval '30 seconds'
     AND (rt.scope IS NULL OR rt.scope = ANY (p.scopes)) AND p.kind = ANY (rt.kinds);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FLEET_OP_REQUEST_INVALID';
  END IF;
  RETURN r;
END $$;

-- ── op_begin_request: the ONLY volatile operator function. Writes are
-- restricted to security/audit bookkeeping (Amendment 3).
CREATE FUNCTION op_begin_request(p_principal text, p_key text, p_route text, p_client_ts_ms bigint, p_nonce text, p_body_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE
  st fleet_operator_state; pr fleet_operator_principals; k fleet_operator_keys; rt fleet_operator_routes;
  v_actor text; v_route text; v_ts timestamptz; v_nh text; v_ins integer; v_id uuid; v_code text; v_type text;
BEGIN
  v_actor := CASE WHEN p_principal ~ '^op_[0-9A-HJKMNP-TV-Z]{26}$' THEN 'op:' || p_principal ELSE 'op:invalid' END;
  SELECT * INTO rt FROM fleet_operator_routes WHERE route = p_route;
  v_route := CASE WHEN FOUND THEN rt.route ELSE 'unknown' END;

  IF p_principal IS NULL OR p_principal !~ '^op_[0-9A-HJKMNP-TV-Z]{26}$' OR p_key IS NULL OR p_key !~ '^[0-9a-f]{32}$'
     OR p_nonce IS NULL OR p_nonce !~ '^[A-Za-z0-9_-]{22,64}$' OR p_body_sha256 IS NULL OR p_body_sha256 !~ '^[0-9a-f]{64}$'
     OR p_client_ts_ms IS NULL OR p_client_ts_ms < 1000000000000 OR p_client_ts_ms > 9999999999999 THEN
    v_code := 'FLEET_OP_BAD_REQUEST'; v_type := 'operator_bad_request';
  ELSIF v_route = 'unknown' THEN
    v_code := 'FLEET_OP_NOT_FOUND'; v_type := 'operator_bad_request';
  END IF;

  IF v_code IS NULL THEN
    SELECT * INTO st FROM fleet_operator_state WHERE id = 1 FOR UPDATE;
    IF NOT FOUND OR NOT st.operator_api_enabled THEN
      v_code := 'FLEET_OP_DISABLED'; v_type := 'operator_disabled';
    ELSIF st.request_count >= st.request_cap THEN
      v_code := 'FLEET_OP_AUDIT_FULL'; v_type := 'operator_audit_full';
    END IF;
  END IF;

  IF v_code IS NULL THEN
    SELECT * INTO pr FROM fleet_operator_principals WHERE principal_id = p_principal;
    IF NOT FOUND OR pr.revoked_at IS NOT NULL THEN
      v_code := 'FLEET_OP_AUTH_FAILED'; v_type := 'operator_auth_failed';
    ELSE
      SELECT * INTO k FROM fleet_operator_keys WHERE key_id = p_key AND principal_id = p_principal;
      IF NOT FOUND OR k.revoked_at IS NOT NULL OR now() < k.not_before OR now() >= k.expires_at THEN
        v_code := 'FLEET_OP_AUTH_FAILED'; v_type := 'operator_auth_failed';
      ELSIF NOT (pr.kind = ANY (rt.kinds)) OR (rt.scope IS NOT NULL AND NOT (rt.scope = ANY (pr.scopes))) THEN
        v_code := 'FLEET_OP_SCOPE_DENIED'; v_type := 'operator_scope_denied';
      END IF;
    END IF;
  END IF;

  IF v_code IS NULL THEN
    v_ts := to_timestamp(p_client_ts_ms / 1000.0);
    IF abs(extract(epoch FROM (now() - v_ts))) > 30 THEN
      v_code := 'FLEET_OP_STALE'; v_type := 'operator_stale';
    END IF;
  END IF;

  IF v_code IS NULL THEN
    v_nh := encode(sha256(convert_to(p_nonce, 'UTF8')), 'hex');
    INSERT INTO fleet_operator_nonces (principal_id, nonce_sha256, expires_at)
      VALUES (p_principal, v_nh, v_ts + interval '60 seconds') ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_ins = ROW_COUNT;
    IF v_ins = 0 THEN
      v_code := 'FLEET_OP_REPLAYED'; v_type := 'operator_replay_blocked';
    END IF;
  END IF;

  IF v_code IS NOT NULL THEN
    -- Bounded: at most 60 database-layer denial events per rolling minute
    -- (checked over the newest 1000 events via the primary key), so a holder
    -- of the operator login cannot flood fleet_events. The denial itself
    -- always stands.
    IF (SELECT count(*) FROM fleet_events e
         WHERE e.id > (SELECT COALESCE(max(id), 0) FROM fleet_events) - 1000
           AND e.actor LIKE 'op:%' AND e.created_at > now() - interval '1 minute') < 60 THEN
      PERFORM fleet_event(v_type, NULL, v_actor, jsonb_build_object('code', v_code, 'route', v_route, 'layer', 'database'));
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;

  v_id := gen_random_uuid();
  INSERT INTO fleet_operator_requests (request_id, principal_id, key_id, route, scope, client_ts, nonce_sha256, body_sha256)
    VALUES (v_id, p_principal, p_key, rt.route, rt.scope, v_ts, v_nh, p_body_sha256);
  UPDATE fleet_operator_state SET request_count = request_count + 1 WHERE id = 1;
  DELETE FROM fleet_operator_nonces WHERE ctid IN (SELECT ctid FROM fleet_operator_nonces WHERE expires_at < now() LIMIT 1000);
  RETURN jsonb_build_object('ok', true, 'requestId', v_id, 'fn', rt.fn, 'requestCount', st.request_count + 1, 'requestCap', st.request_cap);
END $$;

-- ── Key material for signature verification (public keys only). STABLE.
CREATE FUNCTION op_key_material(p_principal text, p_key text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE pr fleet_operator_principals; k fleet_operator_keys;
BEGIN
  IF p_principal IS NULL OR p_principal !~ '^op_[0-9A-HJKMNP-TV-Z]{26}$' OR p_key IS NULL OR p_key !~ '^[0-9a-f]{32}$' THEN
    RETURN jsonb_build_object('ok', false);
  END IF;
  SELECT * INTO pr FROM fleet_operator_principals WHERE principal_id = p_principal;
  SELECT * INTO k FROM fleet_operator_keys WHERE key_id = p_key AND principal_id = p_principal;
  IF pr.principal_id IS NULL OR k.key_id IS NULL OR pr.revoked_at IS NOT NULL OR k.revoked_at IS NOT NULL
     OR now() < k.not_before OR now() >= k.expires_at THEN
    RETURN jsonb_build_object('ok', false);
  END IF;
  RETURN jsonb_build_object('ok', true, 'publicKey', encode(k.public_key, 'base64'), 'kind', pr.kind,
    'scopes', to_jsonb(pr.scopes), 'expiresAt', k.expires_at);
END $$;

-- ── Readiness + startup identity check (no authentication; kill switch, counter and
-- approved runtime identity only; callable by the operator process alone). STABLE.
CREATE FUNCTION op_ping() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('schemaVersion', (SELECT max(version) FROM fleet_schema_migrations),
    'operatorApiEnabled', s.operator_api_enabled, 'generation', s.generation,
    'requestCount', s.request_count, 'requestCap', s.request_cap, 'dbTime', now(),
    'runtimeRepo', f.runtime_repo, 'runtimeCommit', f.runtime_commit, 'runtimeBuildId', f.runtime_build_id,
    'runtimeLockfileSha256', f.runtime_lockfile_sha256)
    FROM fleet_operator_state s CROSS JOIN fleet_state f WHERE s.id = 1 AND f.id = 1
$$;

-- ── Read functions: STABLE; each accepts only a fresh request id for itself.
CREATE FUNCTION op_whoami(p_request uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_operator_requests; pr fleet_operator_principals; k fleet_operator_keys;
BEGIN
  r := fleet_operator_request_ok(p_request, 'op_whoami');
  SELECT * INTO pr FROM fleet_operator_principals WHERE principal_id = r.principal_id;
  SELECT * INTO k FROM fleet_operator_keys WHERE key_id = r.key_id;
  RETURN jsonb_build_object('principal', jsonb_build_object('id', pr.principal_id, 'name', pr.name, 'kind', pr.kind,
      'scopes', to_jsonb(ARRAY(SELECT s FROM unnest(pr.scopes) s ORDER BY s))),
    'key', jsonb_build_object('id', k.key_id, 'expiresAt', k.expires_at));
END $$;

CREATE FUNCTION op_fleet_status(p_request uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_operator_requests; s fleet_state; o fleet_operator_state;
BEGIN
  r := fleet_operator_request_ok(p_request, 'op_fleet_status');
  SELECT * INTO s FROM fleet_state WHERE id = 1;
  SELECT * INTO o FROM fleet_operator_state WHERE id = 1;
  RETURN jsonb_build_object(
    'fleet', jsonb_build_object('maxAgents', s.max_agents, 'living', s.living_agents, 'reserved', s.reserved_slots,
      'quarantined', s.quarantined_slots, 'mode', s.operating_mode, 'replicationEnabled', s.replication_enabled),
    'runtime', jsonb_build_object('repo', s.runtime_repo, 'commit', s.runtime_commit, 'buildId', s.runtime_build_id,
      'lockfileSha256', s.runtime_lockfile_sha256),
    'schema', jsonb_build_object('version', (SELECT max(version) FROM fleet_schema_migrations)),
    'operatorApi', jsonb_build_object('enabled', o.operator_api_enabled, 'requestCount', o.request_count, 'requestCap', o.request_cap));
END $$;

CREATE FUNCTION fleet_operator_agent_json(a fleet_agents) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('agentId', a.agent_id, 'role', a.role, 'generation', a.generation,
    'parentAgentId', a.parent_agent_id, 'status', a.status, 'capabilityScope', a.capability_scope, 'dryRun', a.dry_run,
    'runtimeCommit', a.runtime_commit, 'createdAt', a.created_at, 'lastHeartbeat', a.last_heartbeat,
    'deathTime', a.death_time, 'name', a.name)
$$;

CREATE FUNCTION op_list_agents(p_request uuid, p_after text, p_limit integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_operator_requests; v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
BEGIN
  r := fleet_operator_request_ok(p_request, 'op_list_agents');
  RETURN jsonb_build_object('items', COALESCE((
    SELECT jsonb_agg(fleet_operator_agent_json(a) ORDER BY a.agent_id)
      FROM (SELECT * FROM fleet_agents WHERE p_after IS NULL OR agent_id > p_after ORDER BY agent_id LIMIT v_limit + 1) a
  ), '[]'::jsonb), 'limit', v_limit);
END $$;

CREATE FUNCTION op_get_agent(p_request uuid, p_agent text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_operator_requests; a fleet_agents;
BEGIN
  r := fleet_operator_request_ok(p_request, 'op_get_agent');
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;
  RETURN jsonb_build_object('found', true, 'item', fleet_operator_agent_json(a));
END $$;

CREATE FUNCTION op_list_events(p_request uuid, p_after bigint, p_limit integer, p_type text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_operator_requests; v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
BEGIN
  r := fleet_operator_request_ok(p_request, 'op_list_events');
  RETURN jsonb_build_object('items', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', e.id::text, 'type', e.event_type, 'agentId', e.agent_id, 'actor', e.actor,
             'createdAt', e.created_at, 'detail', e.detail) ORDER BY e.id)
      FROM (SELECT * FROM fleet_events WHERE (p_after IS NULL OR id > p_after) AND (p_type IS NULL OR event_type = p_type)
             ORDER BY id LIMIT v_limit + 1) e
  ), '[]'::jsonb), 'limit', v_limit);
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
```


---

## 3. Consolidated schema v8

### 3.1 Tables (31)

| # | Table | Added | Purpose | Rows expected on a fresh v8 | Immutability |
|---|---|---|---|---|---|
| 1 | `fleet_schema_migrations` | runner | applied versions (`version` PK, `name`, `applied_at`) | 8 | none (owner-only table) |
| 2 | `fleet_state` | V1 | single-row fleet control state: cap, mode, counters, approved runtime/build, replication switch, timeouts, lifecycle policy, reaper bookkeeping | 1 | no DELETE/TRUNCATE; counters read-only; runtime guarded |
| 3 | `fleet_agents` | V1 | every agent ever (living and dead), lifecycle, identity, health, scope | 0+ | no DELETE/TRUNCATE; identity immutable; terminal rows immutable; scope immutable |
| 4 | `fleet_events` | V1 | append-only audit log | 0+ | no UPDATE/DELETE/TRUNCATE |
| 5 | `fleet_reservations` | V2 | replication leases with expected runtime identity and attestation | 0+ | no DELETE/TRUNCATE; expectations immutable; terminal immutable |
| 6 | `fleet_agent_credentials` | V2 | SHA-256 of each agent's long-lived `fa1.` token | 0+ | no DELETE |
| 7 | `fleet_sandbox_terminations` | V3 | sandbox termination queue | 0+ | no DELETE/TRUNCATE |
| 8 | `fleet_agent_sessions` | V4 | SHA-256 of short-lived `fs1.` session tokens | 0+ | none (reaper purges) |
| 9 | `fleet_request_nonces` | V4 | per-agent request replay ledger | 0+ | none (reaper purges) |
| 10 | `fleet_wallet_custody` | V4 | custody/freeze/daily limit per agent wallet | 0+ | dry-run/scope guard only |
| 11 | `fleet_provisioning` | V4 | provisioning attempt tracking, intent, cleanup | 0+ | no DELETE; key/name/id/dry_run immutable |
| 12 | `fleet_orphans` | V4 | external infrastructure that could not be stopped | 0+ | no DELETE |
| 13 | `fleet_health_challenges` | V4 | controller health challenges (nonce hash) | 0+ | none |
| 14 | `fleet_spend_requests` | V4 | spend decisions (never executed) | 0+ | no UPDATE/DELETE |
| 15 | `fleet_treasury_policy` | V5 | single-row treasury policy | 1 | no DELETE |
| 16 | `fleet_agent_ledger` | V5 | per-agent revenue/cost/funding ledger | 0+ | no UPDATE/DELETE |
| 17 | `fleet_balance_observations` | V5 | observed wallet cash | 0+ | none |
| 18 | `fleet_obligations` | V5 | approved per-agent obligations | 0+ | none |
| 19 | `fleet_capital_allocations` | V5 | proposed/approved capital | 0+ | no DELETE; guarded transitions; operator approver |
| 20 | `fleet_sweep_reductions` | V5 | temporary sweep reductions | 0+ | operator approver |
| 21 | `fleet_treasury_ledger` | V5 | treasury movements (recorded/planned) | 0+ | no UPDATE/DELETE |
| 22 | `fleet_treasury_obligations` | V5 | fleet-level obligations | 0+ | none |
| 23 | `fleet_sweep_plans` | V5 | computed sweep plans (planned only) | 0+ | no UPDATE/DELETE |
| 24 | `fleet_owner_distributions` | V5 | owner distribution decisions (planned/rejected) | 0+ | no UPDATE/DELETE |
| 25 | `fleet_custody_transfers` | V5 | custody transfer plans (blocked) | 0+ | no UPDATE/DELETE; operator approver |
| 26 | `fleet_operator_state` | V8 | Operator API kill switch, generation, request counter | 1 | no DELETE/TRUNCATE; counter/generation monotonic |
| 27 | `fleet_operator_principals` | V8 | operator principals (never agents) | 0+ | no DELETE/TRUNCATE; identity immutable; revocation final |
| 28 | `fleet_operator_keys` | V8 | Ed25519 public keys (≤ 2 active per principal, ≤ 90 days) | 0+ | no DELETE/TRUNCATE; material immutable; revocation final |
| 29 | `fleet_operator_nonces` | V8 | operator replay ledger (nonce hashes) | 0+ | no TRUNCATE (expired rows deleted) |
| 30 | `fleet_operator_routes` | V8 | route → scope → read function map | 5 | no UPDATE/DELETE/TRUNCATE |
| 31 | `fleet_operator_requests` | V8 | accepted operator request audit | 0+ | no UPDATE; DELETE only in audited archival; no TRUNCATE |

Sequences (5, all from `bigserial`): `fleet_events_id_seq`, `fleet_orphans_orphan_id_seq`,
`fleet_agent_ledger_entry_id_seq`, `fleet_balance_observations_observation_id_seq`,
`fleet_treasury_ledger_entry_id_seq`. Views, materialized views, partitions, foreign tables, RLS
policies, extensions: **none**.

#### Final column lists of the two central tables

`fleet_state` — 27 columns in physical order: `id, living_agents, reserved_slots, max_agents,
operating_mode, runtime_repo, runtime_commit, updated_at` (V1) · `replication_enabled,
runtime_build_id, runtime_lockfile_sha256, reservation_ttl_s, provisioning_ttl_s,
heartbeat_unresponsive_s, heartbeat_dead_s, reaper_last_run_at, reaper_grace_from` (V2) ·
`parent_report_quiet_s` (V3) · `quarantined_slots, health_challenge_interval_s, challenge_ttl_s,
health_grace_s, max_challenge_failures, termination_grace_s, orphan_slot_hold_s, max_open_orphans,
session_ttl_s` (V4).

`fleet_agents` — 30 columns: `agent_id, parent_agent_id, role, generation, name, wallet_address,
runtime_version, runtime_repo, runtime_commit, sandbox_id, local_child_id, status, status_reason,
requested_by, request_key, created_at, updated_at, last_heartbeat, reservation_expires_at,
death_time` (V1) · `terminal_reported_at` (V3) · `activated_at, last_challenge_ok_at,
challenge_failures, unresponsive_since, health_reason, quarantined_at` (V4) · `dry_run` (V6) ·
`capability_scope` (V7).

Other final column counts: `fleet_events` 6, `fleet_reservations` 19 (18 + V6 `dry_run`),
`fleet_agent_credentials` 4, `fleet_sandbox_terminations` 8, `fleet_agent_sessions` 5,
`fleet_request_nonces` 3, `fleet_wallet_custody` 9, `fleet_provisioning` 20 (12 + 8 in V6),
`fleet_orphans` 12 (11 + V6 `sandbox_name`), `fleet_health_challenges` 9, `fleet_spend_requests` 10,
`fleet_treasury_policy` 13, `fleet_agent_ledger` 10, `fleet_balance_observations` 5,
`fleet_obligations` 9, `fleet_capital_allocations` 19, `fleet_sweep_reductions` 10,
`fleet_treasury_ledger` 10, `fleet_treasury_obligations` 8, `fleet_sweep_plans` 8,
`fleet_owner_distributions` 11, `fleet_custody_transfers` 10, `fleet_operator_state` 7,
`fleet_operator_principals` 9, `fleet_operator_keys` 11, `fleet_operator_nonces` 3,
`fleet_operator_routes` 4, `fleet_operator_requests` 9, `fleet_schema_migrations` 3.

### 3.2 Relationships (foreign keys: 29)

```text
                         fleet_state (1 row)          fleet_treasury_policy (1 row)
                         fleet_schema_migrations      fleet_treasury_obligations
                                                      fleet_owner_distributions
                                                      fleet_events.agent_id ····> (no FK) fleet_agents
                                                      fleet_request_nonces.agent_id ··> (no FK)

                 ┌───────────── parent_agent_id ─────────────┐
                 ▼                                            │
          ┌──────────────┐◄──────────────────────────────────┘
          │ fleet_agents │◄── agent_id (UNIQUE), parent_agent_id ── fleet_reservations
          └──────────────┘                                              ▲
            ▲  ▲  ▲  ▲  ▲                                               │ reservation_id (UNIQUE)
            │  │  │  │  └─ agent_id (PK) ─ fleet_agent_credentials      │
            │  │  │  └──── agent_id (PK) ─ fleet_sandbox_terminations   │
            │  │  └─────── agent_id ────── fleet_agent_sessions          │
            │  └────────── agent_id (PK) ─ fleet_wallet_custody          │
            ├── parent_agent_id, expected_agent_id (UNIQUE) ─ fleet_provisioning
            │                                                  ▲
            ├── agent_id ─────────────── fleet_orphans ── provisioning_id ┘
            ├── agent_id ─────────────── fleet_health_challenges
            ├── agent_id ─────────────── fleet_spend_requests   (allocation_id: no FK)
            ├── agent_id ─────────────── fleet_agent_ledger     (allocation_id: no FK)
            ├── agent_id ─────────────── fleet_balance_observations
            ├── agent_id ─────────────── fleet_obligations
            ├── agent_id ─────────────── fleet_capital_allocations ◄── allocation_id ── fleet_sweep_reductions
            ├── agent_id ─────────────────────────────────────────────────────────────── fleet_sweep_reductions
            ├── agent_id ─────────────── fleet_sweep_plans
            ├── agent_id (nullable) ──── fleet_treasury_ledger  (allocation_id: no FK)
            └── from_agent_id, to_agent_id ── fleet_custody_transfers

 fleet_operator_state (1 row)
 fleet_operator_principals ◄── principal_id ── fleet_operator_keys
          ▲    ▲                                      ▲
          │    └── principal_id ── fleet_operator_nonces
          └──────── principal_id ── fleet_operator_requests ── key_id ──┘
                                            └── route ──► fleet_operator_routes
```

FK list: fleet_agents(parent_agent_id); fleet_reservations(agent_id, parent_agent_id);
fleet_agent_credentials(agent_id); fleet_sandbox_terminations(agent_id); fleet_agent_sessions(agent_id);
fleet_wallet_custody(agent_id); fleet_provisioning(reservation_id→fleet_reservations, parent_agent_id,
expected_agent_id); fleet_orphans(agent_id, provisioning_id→fleet_provisioning);
fleet_health_challenges(agent_id); fleet_spend_requests(agent_id); fleet_agent_ledger(agent_id);
fleet_balance_observations(agent_id); fleet_obligations(agent_id); fleet_capital_allocations(agent_id);
fleet_sweep_reductions(agent_id, allocation_id→fleet_capital_allocations); fleet_sweep_plans(agent_id);
fleet_treasury_ledger(agent_id); fleet_custody_transfers(from_agent_id, to_agent_id);
fleet_operator_keys(principal_id); fleet_operator_nonces(principal_id);
fleet_operator_requests(principal_id, key_id→fleet_operator_keys, route→fleet_operator_routes).
All are `NO ACTION` (no cascades). There is deliberately **no** link between operator principals and
fleet agents.

### 3.3 Agent lifecycle (final, enforced by `fleet_agents_transition_guard` V6 + helpers)

```text
 INSERT ─► reserved ──► provisioning ──► active ◄──► unresponsive
    │          │             │   │          │              │
    │          ▼             ▼   │          ├──► terminating ◄┘
    │        failed        failed│          │        │
    │                            ▼          ▼        ▼
    │                         orphaned ◄──────── orphaned
    │                            │                   │
    └─ (roots) INSERT ─► active  └──────► dead ◄─────┘   (active/unresponsive/terminating/orphaned ─► dead)
```

Allowed UPDATE transitions: reserved→{provisioning, failed}; provisioning→{active, failed, orphaned};
active→{unresponsive, terminating, dead}; unresponsive→{active, terminating, dead};
terminating→{orphaned, dead}; orphaned→{dead}. INSERT only as `reserved` (children) or `active`
(roots: `registerRoot`, `store.ts:936-945`). `dead`/`failed` are terminal and immutable.
Population buckets (`fleet_bucket`): reserved = {reserved, provisioning}; living = {active,
unresponsive, terminating}; quarantined = {orphaned}; none = {dead, failed}.
Cap: `living_agents + reserved_slots + quarantined_slots <= max_agents` on every entry into the
population (trigger), `<= 50` always (table CHECKs), and `< mx` before any new reservation (allocators).

Trigger firing order on `fleet_agents` (PostgreSQL fires same-timing triggers alphabetically):

| Event | BEFORE (in order) | AFTER (in order) |
|---|---|---|
| INSERT | `fleet_agents_dry_run_guard`, `fleet_agents_lifecycle_stamps`, `fleet_agents_scope_parent_guard`, `fleet_agents_transition_guard` | `fleet_agents_counters_ins`, `fleet_agents_custody_on_insert` |
| UPDATE (status in SET list) | `fleet_agents_a_provisioning_uncertain`, `fleet_agents_lifecycle_stamps`, `fleet_agents_transition_guard`, `fleet_agents_zz_scope_immutable` (WHEN scope changed) | `fleet_agents_counters_upd`, `fleet_agents_lifecycle_effects`, `fleet_agents_uncertain_effects` |
| UPDATE (status not in SET list) | `fleet_agents_transition_guard`, `fleet_agents_zz_scope_immutable` (WHEN) | — |
| DELETE | `fleet_agents_no_delete` | — |
| TRUNCATE | `fleet_agents_no_truncate` | — |

### 3.4 Function inventory (85 functions)

Legend — SD: SECURITY DEFINER; Path: `P` pinned (`"fleet", pg_temp`), `C` `FROM CURRENT`, `—` none;
Vol: I immutable, S stable, V volatile; EXECUTE: which restricted role holds EXECUTE (the owner can
execute everything; PUBLIC nothing). "Defined" lists the migration(s) that CREATE / REPLACE it; the
last one is the live definition.

| # | Function (identity signature) | Returns | Lang | Vol | SD | Path | Defined | EXECUTE |
|---|---|---|---|---|---|---|---|---|
| 1 | `fleet_bucket(text)` | text | sql | I | no | — | V1, V2, V4 | owner |
| 2 | `fleet_agents_counters()` | trigger | plpgsql | V | no | P | V1, V4 | trigger |
| 3 | `fleet_agents_transition_guard()` | trigger | plpgsql | V | no | P | V1, V2, V4, V6 | trigger |
| 4 | `fleet_history_immutable()` | trigger | plpgsql | V | no | — | V1 | trigger |
| 5 | `fleet_state_counter_guard()` | trigger | plpgsql | V | no | — | V1, V4 | trigger |
| 6 | `fleet_reservations_guard()` | trigger | plpgsql | V | no | C | V2 | trigger |
| 7 | `fleet_scrub(text)` | text | sql | I | no | — | V2 | owner |
| 8 | `fleet_event(text, text, text, jsonb)` | void | sql | V | no | P | V2 | owner |
| 9 | `fleet_lock_state()` | fleet_state | plpgsql | V | no | P | V2 | owner |
| 10 | `fleet_state_json(fleet_state)` | jsonb | sql | S | no | — | V2, V4 | owner |
| 11 | `fleet_expire_leases(text)` | integer | plpgsql | V | no | P | V2 | owner |
| 12 | `fleet_release(text, text, text, text)` | boolean | plpgsql | V | no | P | V2 | owner |
| 13 | `fleet_mark_dead(text, text, text, text)` | boolean | plpgsql | V | no | P | V2, V3 | owner |
| 14 | `fleet_heartbeat(text, text)` | text | plpgsql | V | no | P | V2, V4 | owner (called by `registerRoot`) |
| 15 | `fleet_authenticate(text, text, text)` | text | plpgsql | V | no | P | V2, V4, V7 | owner |
| 16 | `fleet_reserve_slot(text, text, text, text, integer, bigint, boolean, text, text, text, text)` | jsonb | plpgsql | V | no | P | V2, V4, V7 | owner (`PgFleetStore.reserveSlot`, `store.ts:1015`) |
| 17 | `fleet_reap(text)` | jsonb | plpgsql | V | no | P | V2, V3, V4 | owner |
| 18 | `api_fleet_state()` | jsonb | sql | S | **yes** | P | V2 | fleet_agent |
| 19 | `api_member_addresses()` | SETOF text | sql | S | **yes** | P | V2 | fleet_agent |
| 20 | `api_whoami(text, text)` | jsonb | plpgsql | V | **yes** | P | V2, V7 | fleet_agent |
| 21 | `api_heartbeat(text, text)` | jsonb | plpgsql | V | **yes** | P | V2, V4 | fleet_agent |
| 22 | `api_request_replication(text, text, text, text, text, text)` | jsonb | plpgsql | V | **yes** | P | V2 | fleet_agent |
| 23 | `api_release_reservation(text, text, text, text)` | jsonb | plpgsql | V | **yes** | P | V2 | fleet_agent |
| 24 | `api_set_own_status(text, text, text, text)` | jsonb | plpgsql | V | **yes** | P | V2 | fleet_agent |
| 25 | `fleet_state_runtime_guard()` | trigger | plpgsql | V | no | P | V3 | trigger |
| 26 | `fleet_agent_json(fleet_agents)` | jsonb | sql | S | no | — | V3 | owner |
| 27 | `svc_claim(text, text, text, bigint, text)` | jsonb | plpgsql | V | **yes** | P | V3 | fleet_service |
| 28 | `svc_activate(text, text, text, text, text, text, jsonb, text, text)` | jsonb | plpgsql | V | **yes** | P | V3 | fleet_service |
| 29 | `svc_verification_failed(text, text, text)` | boolean | plpgsql | V | **yes** | P | V3 | fleet_service |
| 30 | `svc_release(text, text, text)` | boolean | sql | V | **yes** | P | V3 | fleet_service |
| 31 | `svc_mark_dead(text, text, text, text)` | boolean | sql | V | **yes** | P | V3 | fleet_service |
| 32 | `svc_heartbeat(text)` | text | sql | V | **yes** | P | V3 | fleet_service |
| 33 | `svc_reap(text)` | jsonb | sql | V | **yes** | P | V3 | fleet_service |
| 34 | `svc_record_event(text, text, text, jsonb)` | void | plpgsql | V | **yes** | P | V3 | fleet_service |
| 35 | `svc_child_terminal(text, text, text)` | jsonb | plpgsql | V | **yes** | P | V3 | fleet_service |
| 36 | `svc_terminations_due(integer)` | jsonb | sql | S | **yes** | P | V3 | fleet_service |
| 37 | `svc_termination_result(text, text, text, text)` | boolean | plpgsql | V | **yes** | P | V3, V4 | fleet_service |
| 38 | `fleet_agents_lifecycle_stamps()` | trigger | plpgsql | V | no | — | V4 | trigger |
| 39 | `fleet_agents_lifecycle_effects()` | trigger | plpgsql | V | no | P | V4 | trigger |
| 40 | `fleet_agents_custody_on_insert()` | trigger | plpgsql | V | no | P | V4 | trigger |
| 41 | `api_open_session(text, text, text)` | jsonb | plpgsql | V | **yes** | P | V4 | fleet_agent |
| 42 | `svc_consume_nonce(text, text, integer)` | boolean | plpgsql | V | **yes** | P | V4 | fleet_service |
| 43 | `svc_provision_update(text, text, text, text)` | jsonb | plpgsql | V | **yes** | P | V4, V6 | fleet_service |
| 44 | `fleet_reservations_provisioning()` | trigger | plpgsql | V | no | P | V4 | trigger |
| 45 | `fleet_begin_termination(text, text, text, text)` | text | plpgsql | V | no | P | V4 | owner (`quarantine`, `store.ts:1253`) |
| 46 | `svc_issue_challenge(text, text, text, text)` | jsonb | plpgsql | V | **yes** | P | V4 | fleet_service |
| 47 | `fleet_challenge_failed(text, text)` | void | plpgsql | V | no | P | V4 | owner |
| 48 | `fleet_expire_challenge(text)` | void | plpgsql | V | no | P | V4 | owner |
| 49 | `svc_answer_challenge(text, text, text, text, text, boolean)` | jsonb | plpgsql | V | **yes** | P | V4 | fleet_service |
| 50 | `fleet_require_operator_approver(text, text)` | void | plpgsql | V | no | P | V5, V8 | owner |
| 51 | `fleet_allocations_guard()` | trigger | plpgsql | V | no | P | V5 | trigger |
| 52 | `fleet_sweep_reductions_guard()` | trigger | plpgsql | V | no | P | V5 | trigger |
| 53 | `fleet_custody_transfers_guard()` | trigger | plpgsql | V | no | P | V5 | trigger |
| 54 | `api_propose_allocation(text, text, text, text, bigint, bigint, integer)` | jsonb | plpgsql | V | **yes** | P | V5 | fleet_agent |
| 55 | `api_request_spend(text, text, text, text, text, bigint, text, text)` | jsonb | plpgsql | V | **yes** | P | V5 | fleet_agent |
| 56 | `fleet_provisioning_defaults()` | trigger | plpgsql | V | no | P | V6 | trigger |
| 57 | `fleet_provisioning_key_immutable()` | trigger | plpgsql | V | no | — | V6 | trigger |
| 58 | `fleet_agents_provisioning_uncertain()` | trigger | plpgsql | V | no | P | V6 | trigger |
| 59 | `fleet_agents_uncertain_effects()` | trigger | plpgsql | V | no | P | V6 | trigger |
| 60 | `fleet_terminations_resolve_orphan()` | trigger | plpgsql | V | no | P | V6 | trigger |
| 61 | `svc_provision_reconcile(text, text, text, text)` | jsonb | plpgsql | V | **yes** | P | V6 | fleet_service |
| 62 | `fleet_reserve_dry_run(text, text, text, text, text, bigint)` | jsonb | plpgsql | V | no | P | V6 | owner |
| 63 | `fleet_agents_dry_run_guard()` | trigger | plpgsql | V | no | P | V6 | trigger |
| 64 | `fleet_custody_dry_run_guard()` | trigger | plpgsql | V | no | P | V6, V7 | trigger |
| 65 | `fleet_allocations_dry_run_guard()` | trigger | plpgsql | V | no | P | V6, V7 | trigger |
| 66 | `fleet_agents_scope_immutable()` | trigger | plpgsql | V | no | P | V7 | trigger |
| 67 | `fleet_agents_scope_parent_guard()` | trigger | plpgsql | V | no | P | V7 | trigger |
| 68 | `fleet_operator_state_guard()` | trigger | plpgsql | V | no | P | V8 | trigger |
| 69 | `fleet_operator_principals_guard()` | trigger | plpgsql | V | no | P | V8 | trigger |
| 70 | `fleet_operator_keys_guard()` | trigger | plpgsql | V | no | P | V8 | trigger |
| 71 | `fleet_operator_requests_guard()` | trigger | plpgsql | V | no | P | V8 | trigger |
| 72 | `fleet_operator_request_line(fleet_operator_requests)` | text | sql | S | no | P | V8 | owner |
| 73 | `fleet_operator_archive_check(timestamptz, bigint)` | void | plpgsql | S | no | P | V8 | owner |
| 74 | `fleet_operator_archive_export(timestamptz, integer)` | TABLE(line text) | plpgsql | S | no | P | V8 | owner |
| 75 | `fleet_operator_archive_requests(timestamptz, bigint, text, text)` | bigint | plpgsql | V | no | P | V8 | owner |
| 76 | `fleet_operator_request_ok(uuid, text)` | fleet_operator_requests | plpgsql | S | no | P | V8 | owner (reached via op_* SD) |
| 77 | `op_begin_request(text, text, text, bigint, text, text)` | jsonb | plpgsql | **V** | **yes** | P | V8 | fleet_operator |
| 78 | `op_key_material(text, text)` | jsonb | plpgsql | S | **yes** | P | V8 | fleet_operator |
| 79 | `op_ping()` | jsonb | sql | S | **yes** | P | V8 | fleet_operator |
| 80 | `op_whoami(uuid)` | jsonb | plpgsql | S | **yes** | P | V8 | fleet_operator |
| 81 | `op_fleet_status(uuid)` | jsonb | plpgsql | S | **yes** | P | V8 | fleet_operator |
| 82 | `fleet_operator_agent_json(fleet_agents)` | jsonb | sql | S | no | P | V8 | owner (reached via op_* SD) |
| 83 | `op_list_agents(uuid, text, integer)` | jsonb | plpgsql | S | **yes** | P | V8 | fleet_operator |
| 84 | `op_get_agent(uuid, text)` | jsonb | plpgsql | S | **yes** | P | V8 | fleet_operator |
| 85 | `op_list_events(uuid, bigint, integer, text)` | jsonb | plpgsql | S | **yes** | P | V8 | fleet_operator |

Counts: 85 functions; 34 SECURITY DEFINER (10 `api_*` + 16 `svc_*` + 8 `op_*`), all pinned;
27 trigger functions; 17 STABLE, 2 IMMUTABLE, 66 VOLATILE; 1 `FROM CURRENT`; 8 without a
search_path. Owner of every function: the migrating role (production `fleetadmin`). No function is
overloaded (each name has exactly one signature).

Allow-lists as constants (the grants and the audit both use them):

```ts
/** The only functions the restricted service role may execute (name + signature). */
export const SERVICE_API_FUNCTIONS: readonly string[] = Object.freeze([
  "svc_claim(text, text, text, bigint, text)",
  "svc_activate(text, text, text, text, text, text, jsonb, text, text)",
  "svc_verification_failed(text, text, text)",
  "svc_release(text, text, text)",
  "svc_mark_dead(text, text, text, text)",
  "svc_heartbeat(text)",
  "svc_reap(text)",
  "svc_record_event(text, text, text, jsonb)",
  "svc_child_terminal(text, text, text)",
  "svc_terminations_due(integer)",
  "svc_termination_result(text, text, text, text)",
  "svc_consume_nonce(text, text, integer)",
  "svc_provision_update(text, text, text, text)",
  "svc_provision_reconcile(text, text, text, text)",
  "svc_issue_challenge(text, text, text, text)",
  "svc_answer_challenge(text, text, text, text, text, boolean)",
]);

/** Tables the service role may SELECT. fleet_agent_credentials (token hashes) is deliberately absent. */
export const SERVICE_READ_TABLES: readonly string[] = Object.freeze([
  "fleet_schema_migrations",
  "fleet_state",
  "fleet_agents",
  "fleet_reservations",
  "fleet_events",
  "fleet_sandbox_terminations",
  "fleet_provisioning",
  "fleet_orphans",
  "fleet_wallet_custody",
  "fleet_health_challenges",
]);

/** The only functions the restricted agent role may execute (name + signature). */
export const AGENT_API_FUNCTIONS: readonly string[] = Object.freeze([
  "api_fleet_state()",
  "api_member_addresses()",
  "api_whoami(text, text)",
  "api_heartbeat(text, text)",
  "api_request_replication(text, text, text, text, text, text)",
  "api_release_reservation(text, text, text, text)",
  "api_set_own_status(text, text, text, text)",
  "api_open_session(text, text, text)",
  "api_propose_allocation(text, text, text, text, bigint, bigint, integer)",
  "api_request_spend(text, text, text, text, text, bigint, text, text)",
]);

/**
 * The ONLY functions the operator role may execute (schema v8, Phase B2).
 * Signature-termination invariant: every one of them is STABLE except
 * op_begin_request, whose writes are limited to OPERATOR_BOOKKEEPING_TABLES
 * (plus denial events via fleet_event). A mutating operator capability must
 * not be added here; it needs a separate security-design gate.
 */
export const OPERATOR_API_FUNCTIONS: readonly string[] = Object.freeze([
  "op_begin_request(text, text, text, bigint, text, text)",
  "op_key_material(text, text)",
  "op_ping()",
  "op_whoami(uuid)",
  "op_fleet_status(uuid)",
  "op_list_agents(uuid, text, integer)",
  "op_get_agent(uuid, text)",
  "op_list_events(uuid, bigint, integer, text)",
]);

/** The single volatile operator function (security/audit bookkeeping only). */
export const OPERATOR_VOLATILE_FUNCTIONS: readonly string[] = Object.freeze(["op_begin_request(text, text, text, bigint, text, text)"]);

/** The read functions a route may map to (mirrors the fleet_operator_routes CHECK). */
export const OPERATOR_READ_FUNCTIONS: readonly string[] = Object.freeze([
  "op_whoami",
  "op_fleet_status",
  "op_list_agents",
  "op_get_agent",
  "op_list_events",
]);

/** Tables op_begin_request may write (Amendment 3); fleet_events via fleet_event() for denials. */
export const OPERATOR_BOOKKEEPING_TABLES: readonly string[] = Object.freeze([
  "fleet_operator_nonces",
  "fleet_operator_requests",
  "fleet_operator_state",
]);
```

### 3.5 Triggers (58)

| Table | Triggers |
|---|---|
| fleet_state (4) | `fleet_state_no_delete`, `fleet_state_no_truncate`, `fleet_state_counter_guard`, `fleet_state_runtime_guard` |
| fleet_agents (13) | `fleet_agents_counters_ins`, `fleet_agents_counters_upd`, `fleet_agents_transition_guard`, `fleet_agents_no_delete`, `fleet_agents_no_truncate`, `fleet_agents_lifecycle_stamps`, `fleet_agents_lifecycle_effects`, `fleet_agents_custody_on_insert`, `fleet_agents_a_provisioning_uncertain`, `fleet_agents_uncertain_effects`, `fleet_agents_dry_run_guard`, `fleet_agents_zz_scope_immutable`, `fleet_agents_scope_parent_guard` |
| fleet_events (2) | `fleet_events_no_change`, `fleet_events_no_truncate` |
| fleet_reservations (4) | `fleet_reservations_guard`, `fleet_reservations_no_delete`, `fleet_reservations_no_truncate`, `fleet_reservations_provisioning` |
| fleet_agent_credentials (1) | `fleet_agent_credentials_no_delete` |
| fleet_sandbox_terminations (3) | `fleet_sandbox_terminations_no_delete`, `fleet_sandbox_terminations_no_truncate`, `fleet_terminations_resolve_orphan` |
| fleet_provisioning (3) | `fleet_provisioning_no_delete`, `fleet_provisioning_defaults`, `fleet_provisioning_key_immutable` |
| fleet_orphans (1) | `fleet_orphans_no_delete` |
| fleet_wallet_custody (1) | `fleet_custody_dry_run_guard` |
| fleet_spend_requests (1) | `fleet_spend_requests_no_change` |
| fleet_treasury_policy (1) | `fleet_treasury_policy_no_delete` |
| fleet_agent_ledger (1) | `fleet_agent_ledger_no_change` |
| fleet_capital_allocations (3) | `fleet_allocations_guard`, `fleet_allocations_no_delete`, `fleet_allocations_dry_run_guard` |
| fleet_sweep_reductions (1) | `fleet_sweep_reductions_guard` |
| fleet_treasury_ledger (1) | `fleet_treasury_ledger_no_change` |
| fleet_sweep_plans (1) | `fleet_sweep_plans_no_change` |
| fleet_owner_distributions (1) | `fleet_owner_distributions_no_change` |
| fleet_custody_transfers (2) | `fleet_custody_transfers_guard`, `fleet_custody_transfers_no_change` |
| fleet_operator_state (3) | `fleet_operator_state_guard`, `fleet_operator_state_no_delete`, `fleet_operator_state_no_truncate` |
| fleet_operator_principals (3) | `fleet_operator_principals_guard`, `…_no_delete`, `…_no_truncate` |
| fleet_operator_keys (3) | `fleet_operator_keys_guard`, `…_no_delete`, `…_no_truncate` |
| fleet_operator_nonces (1) | `fleet_operator_nonces_no_truncate` |
| fleet_operator_routes (2) | `fleet_operator_routes_no_change`, `fleet_operator_routes_no_truncate` |
| fleet_operator_requests (2) | `fleet_operator_requests_guard`, `fleet_operator_requests_no_truncate` |

Totals: 4+13+2+4+1+3+3+1+1+1+1+1+3+1+1+1+1+2+3+3+3+1+2+2 = **58** user (non-internal) triggers.
Tables with no user trigger: `fleet_schema_migrations`, `fleet_agent_sessions`,
`fleet_request_nonces`, `fleet_health_challenges`, `fleet_balance_observations`,
`fleet_obligations`, `fleet_treasury_obligations` (7). FK constraints add internal
(`tgisinternal`) triggers that are not counted.

### 3.6 Role model and privileges

Roles are created by the superuser script `scripts/fleet-db-roles.sql` (via `scripts/fleet-db-setup.sh`);
the schema owner is never created there (it is the pre-existing admin login, `-v owner=fleetadmin`).
Object privileges are granted by `fleet:migrate` (§1.7).

| Role | LOGIN | Attributes (re-asserted every run) | CONNECTION LIMIT | Member of | Per-DB settings (`ALTER ROLE … IN DATABASE`) | Object privileges in `fleet` |
|---|---|---|---|---|---|---|
| owner (`fleetadmin`, `FLEET_DB_OWNER`) | yes | not touched by the script | not set | — | not set | owns schema `fleet` and all 31 tables, 5 sequences, 85 functions; `CONNECT, TEMPORARY` on the database (granted by the script) |
| `fleet_agent` | NOLOGIN | NOSUPERUSER NOCREATEDB NOCREATEROLE **NOINHERIT** NOREPLICATION NOBYPASSRLS | — | — | — | `USAGE` on schema; `EXECUTE` on the 10 `api_*` |
| `fleet_agent_login` | LOGIN | NOSUPERUSER NOCREATEDB NOCREATEROLE **INHERIT** NOREPLICATION NOBYPASSRLS | **32** | `fleet_agent` | `statement_timeout = '10s'`, `lock_timeout = '5s'`, `idle_in_transaction_session_timeout = '30s'` | inherited from `fleet_agent`; `CONNECT` |
| `fleet_service` | NOLOGIN | as `fleet_agent` | — | — | — | `USAGE`; `SELECT` on 10 tables; `EXECUTE` on the 16 `svc_*` |
| `fleet_service_login` | LOGIN | as `fleet_agent_login` | **16** | `fleet_service` | `statement_timeout = '15s'`, `lock_timeout = '5s'`, `idle_in_transaction_session_timeout = '30s'` | inherited; `CONNECT` |
| `fleet_operator` | NOLOGIN | as `fleet_agent` | — | — | — | `USAGE`; `EXECUTE` on the 8 `op_*` |
| `fleet_operator_login` | LOGIN | as `fleet_agent_login` | **8** | `fleet_operator` | `statement_timeout = '5s'`, `lock_timeout = '2s'`, `idle_in_transaction_session_timeout = '10s'` | inherited; `CONNECT` |
| PUBLIC | — | — | — | — | — | nothing: `REVOKE ALL ON DATABASE <db> FROM PUBLIC`; `REVOKE CREATE ON SCHEMA public FROM PUBLIC`; no USAGE on `fleet`; no table/sequence/function privilege in `fleet`; default EXECUTE on owner-created functions removed |

Service readable tables (`SERVICE_READ_TABLES`): `fleet_schema_migrations, fleet_state, fleet_agents,
fleet_reservations, fleet_events, fleet_sandbox_terminations, fleet_provisioning, fleet_orphans,
fleet_wallet_custody, fleet_health_challenges`. Deliberately **not** readable by the service:
`fleet_agent_credentials`, `fleet_agent_sessions`, `fleet_request_nonces`, `fleet_spend_requests`,
all treasury tables, all operator tables.

Database-level ACL from the script: `REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC` and from all six
fleet roles; `GRANT CONNECT … TO fleet_agent_login, fleet_service_login, fleet_operator_login`;
`GRANT CONNECT, TEMPORARY … TO :"owner"` (only the owner may create temporary objects). Membership
hygiene: every membership of the six fleet roles other than `<x>_login ∈ <x>` is revoked on each run.
Passwords: 64-hex values parsed by `fleet-db-setup.sh` from the DSNs in
`/etc/automaton-fleet/service.env` (`FLEET_SERVICE_DATABASE_URL`, `FLEET_AGENT_DATABASE_URL`) and
`/etc/automaton-fleet/operator.env` (`FLEET_OPERATOR_DATABASE_URL`), fed to psql on stdin
(`\set agent_password …`) — never on a command line. `[SECRET REDACTED — PURPOSE: login-role passwords; source of truth is the root-owned env files]`.
Logging of the password statements is suppressed per session: `SET log_statement = 'none'`,
`SET log_min_error_statement = 'panic'`, `SET log_min_duration_statement = -1`.

Client-side timeouts (in addition to the per-role server settings):

| Client | Credential | Pool max | Session options |
|---|---|---|---|
| `PgFleetStore` (admin CLI and doctor with `FLEET_ADMIN_DATABASE_URL`; fleet service controller pool with `FLEET_SERVICE_DATABASE_URL` = `fleet_service_login`, `src/fleet/service/main.ts:223`, startup refuses the owner or a superuser, `main.ts:233-237`) | admin or service login | 4 | `search_path=fleet`, `lock_timeout=5000`, `statement_timeout=10000`, `idle_in_transaction_session_timeout=30000`; connect 10 s, idle 10 s (`store.ts:414-429`) |
| `PgAgentGateway` (fleet service, agent calls) | `FLEET_AGENT_DATABASE_URL` (`fleet_agent_login`) | 8 | `statement_timeout=10000`, `lock_timeout=5000`; `application_name=automaton-fleet-agent-api` (`agent-gateway.ts:92-104`) |
| `PgTreasuryStore` | admin credential | 3 | `search_path=fleet`, `lock_timeout=5000`, `statement_timeout=15000`; `application_name=automaton-fleet-treasury` |

Scripts (verbatim):

```sql
-- Fleet database role bootstrap (Phase 4). Idempotent: safe to re-run.
-- Run as a PostgreSQL superuser. The fleet owner (e.g. fleetadmin) cannot
-- create roles. Normally invoked by scripts/fleet-db-setup.sh, which feeds
-- the passwords on stdin so they never appear in a process command line:
--
--   { printf '\set agent_password %s\n\set service_password %s\n\set operator_password %s\n' "$AGENT_PW" "$SERVICE_PW" "$OPERATOR_PW"
--     cat scripts/fleet-db-roles.sql; } |
--   sudo -u postgres psql -X -v ON_ERROR_STOP=1 -v dbname=automaton_fleet -v owner=fleetadmin -f -
--
-- Passwords must be hex (openssl rand -hex 32). Each run (re)sets them to
-- the values supplied, so the secret files stay the source of truth.
--
-- Role model
--   :owner               fleet_admin: owns schema "fleet" and every object in it.
--                        Migrations and operator CLI only (FLEET_ADMIN_DATABASE_URL).
--   fleet_service        NOLOGIN group: USAGE on fleet, SELECT on non-secret tables,
--                        EXECUTE on fleet.svc_* (granted by `pnpm fleet:migrate`).
--   fleet_service_login  LOGIN member of fleet_service. Held by the fleet service only
--                        (FLEET_SERVICE_DATABASE_URL).
--   fleet_agent          NOLOGIN group: USAGE on fleet + EXECUTE on fleet.api_* (granted by migrate).
--   fleet_agent_login    LOGIN member of fleet_agent. Held by the fleet service only, for
--                        agent-scoped calls (FLEET_AGENT_DATABASE_URL). Agents get no DB credential.
--   fleet_operator       NOLOGIN group (schema v8): USAGE on fleet + EXECUTE on the read-only
--                        op_* functions only (granted by `pnpm fleet:migrate`).
--   fleet_operator_login LOGIN member of fleet_operator. Held by the Operator API process only
--                        (FLEET_OPERATOR_DATABASE_URL in operator.env). Never an admin credential.

\set ON_ERROR_STOP on
-- Keep the ALTER ROLE ... PASSWORD statements below out of the server log
-- (session-level; this session is a superuser). Statement text can still
-- reach extensions such as pg_stat_statements if installed.
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
SET log_min_duration_statement = -1;

SELECT 'CREATE ROLE fleet_agent NOLOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleet_agent') \gexec
SELECT 'CREATE ROLE fleet_agent_login LOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleet_agent_login') \gexec
SELECT 'CREATE ROLE fleet_service NOLOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleet_service') \gexec
SELECT 'CREATE ROLE fleet_service_login LOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleet_service_login') \gexec
SELECT 'CREATE ROLE fleet_operator NOLOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleet_operator') \gexec
SELECT 'CREATE ROLE fleet_operator_login LOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleet_operator_login') \gexec

-- (Re)assert attributes every run, so a drifted role is corrected.
ALTER ROLE fleet_agent         NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE fleet_service       NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE fleet_agent_login   LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 32;
ALTER ROLE fleet_service_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 16;
ALTER ROLE fleet_operator       NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE fleet_operator_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8;
SELECT format('ALTER ROLE fleet_agent_login PASSWORD %L', :'agent_password') \gexec
SELECT format('ALTER ROLE fleet_service_login PASSWORD %L', :'service_password') \gexec
SELECT format('ALTER ROLE fleet_operator_login PASSWORD %L', :'operator_password') \gexec

GRANT fleet_agent TO fleet_agent_login;
GRANT fleet_service TO fleet_service_login;
GRANT fleet_operator TO fleet_operator_login;

-- The restricted logins must never be members of the owner or of each other.
SELECT format('REVOKE %I FROM %I', r.rolname, m.rolname)
  FROM pg_auth_members am
  JOIN pg_roles r ON r.oid = am.roleid
  JOIN pg_roles m ON m.oid = am.member
 WHERE m.rolname IN ('fleet_agent_login', 'fleet_service_login', 'fleet_agent', 'fleet_service', 'fleet_operator_login', 'fleet_operator')
   AND NOT (m.rolname = 'fleet_agent_login' AND r.rolname = 'fleet_agent')
   AND NOT (m.rolname = 'fleet_service_login' AND r.rolname = 'fleet_service')
   AND NOT (m.rolname = 'fleet_operator_login' AND r.rolname = 'fleet_operator') \gexec

-- Only the owner and the two logins may connect; only the owner gets TEMP
-- (no temporary objects that could shadow names) and nobody else gets CREATE.
REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
REVOKE ALL ON DATABASE :"dbname" FROM fleet_agent, fleet_agent_login, fleet_service, fleet_service_login, fleet_operator, fleet_operator_login;
GRANT CONNECT ON DATABASE :"dbname" TO fleet_agent_login, fleet_service_login, fleet_operator_login;
GRANT CONNECT, TEMPORARY ON DATABASE :"dbname" TO :"owner";

\connect :"dbname"
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER ROLE fleet_agent_login IN DATABASE :"dbname" SET statement_timeout = '10s';
ALTER ROLE fleet_agent_login IN DATABASE :"dbname" SET lock_timeout = '5s';
ALTER ROLE fleet_agent_login IN DATABASE :"dbname" SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE fleet_service_login IN DATABASE :"dbname" SET statement_timeout = '15s';
ALTER ROLE fleet_service_login IN DATABASE :"dbname" SET lock_timeout = '5s';
ALTER ROLE fleet_service_login IN DATABASE :"dbname" SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE fleet_operator_login IN DATABASE :"dbname" SET statement_timeout = '5s';
ALTER ROLE fleet_operator_login IN DATABASE :"dbname" SET lock_timeout = '2s';
ALTER ROLE fleet_operator_login IN DATABASE :"dbname" SET idle_in_transaction_session_timeout = '10s';
```

```bash
#!/usr/bin/env bash
# Fleet Phase 4 — PostgreSQL roles (superuser step). Idempotent.
#
#   sudo scripts/fleet-db-setup.sh            # DRY RUN: prints what will run, changes nothing
#   sudo scripts/fleet-db-setup.sh --apply    # runs scripts/fleet-db-roles.sql as postgres
#
# Passwords are taken from /etc/automaton-fleet/service.env and (schema v8)
# /etc/automaton-fleet/operator.env (both written by fleet-os-setup.sh) and
# fed to psql on STDIN via \set, so they never appear
# in any process command line or in shell history. After this, the operator
# (not root) runs the admin-credential steps:
#
#   pnpm fleet:migrate              # v1 -> v3; refuses non-owner credentials; grants agent + service roles
#   pnpm fleet:audit-privileges     # must PASS
#   pnpm fleet:doctor
set -euo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_ENV=/etc/automaton-fleet/service.env
OPERATOR_ENV=/etc/automaton-fleet/operator.env
DB_NAME="${FLEET_DB_NAME:-automaton_fleet}"
DB_OWNER="${FLEET_DB_OWNER:-fleetadmin}"
[[ -f "$SERVICE_ENV" ]] || { echo "$SERVICE_ENV missing — run scripts/fleet-os-setup.sh --apply first" >&2; exit 1; }
[[ -f "$OPERATOR_ENV" && ! -L "$OPERATOR_ENV" ]] || { echo "$OPERATOR_ENV missing — run scripts/fleet-os-setup.sh --apply first (schema v8 Operator API role)" >&2; exit 1; }

pw_of() { # pw_of <KEY> <file>: the password of a login role from its DSN
  sed -n "s#^$1=postgresql://[^:]*:\([0-9a-f]\{64\}\)@.*#\1#p" "$2" | head -1
}
SERVICE_PW="$(pw_of FLEET_SERVICE_DATABASE_URL "$SERVICE_ENV")"
AGENT_PW="$(pw_of FLEET_AGENT_DATABASE_URL "$SERVICE_ENV")"
OPERATOR_PW="$(pw_of FLEET_OPERATOR_DATABASE_URL "$OPERATOR_ENV")"
[[ -n "$SERVICE_PW" && -n "$AGENT_PW" ]] || { echo "service.env must hold 64-hex passwords for both DSNs" >&2; exit 1; }
[[ -n "$OPERATOR_PW" ]] || { echo "operator.env must hold a 64-hex password for FLEET_OPERATOR_DATABASE_URL" >&2; exit 1; }

echo "Will run as the postgres superuser (passwords via stdin, not shown):"
echo "  { printf '\\set agent_password <hex>\\n\\set service_password <hex>\\n\\set operator_password <hex>\\n'; cat $REPO/scripts/fleet-db-roles.sql; } |"
echo "    runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -v dbname=$DB_NAME -v owner=$DB_OWNER -d postgres -f -"
if (( APPLY )); then
  { printf '\\set agent_password %s\n\\set service_password %s\n\\set operator_password %s\n' "$AGENT_PW" "$SERVICE_PW" "$OPERATOR_PW"; cat "$REPO/scripts/fleet-db-roles.sql"; } |
    runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -v dbname="$DB_NAME" -v owner="$DB_OWNER" -d postgres -f -
  echo "Roles applied. Next (as $DB_OWNER operator, not root): pnpm fleet:migrate && pnpm fleet:audit-privileges && pnpm fleet:doctor"
else
  echo "DRY RUN — nothing changed. Re-run with --apply after approval."
fi
unset SERVICE_PW AGENT_PW OPERATOR_PW
```

DRIFT: `scripts/fleet-db-setup.sh:13` says `pnpm fleet:migrate  # v1 -> v3; …`; the code applies v1 → v8
and grants agent, service **and operator** roles.
DRIFT: `scripts/fleet-db-roles.sql` comment "Only the owner and the two logins may connect" — the
statement below it grants CONNECT to **three** logins (`fleet_operator_login` added in v8).
DRIFT: `FLEET.md:251`, `FLEET.md:257`, `FLEET.md:361-363` ("Database role model (schema v2)",
"Database roles (schema v3)") describe 7 `api_*`, 11 `svc_*` and 6 service-readable tables; at
schema v8 the code grants 10 `api_*`, 16 `svc_*` and 10 readable tables. Those FLEET.md sections are
historical snapshots, not the current state.

Known accepted gap (documented, not fixed): every fleet login can still take advisory locks
(including key 1179403589), call `lo_*` functions, override its per-role `statement_timeout` /
`idle_in_transaction_session_timeout` with `SET`, and has CONNECT on other databases unless `pg_hba`
restricts it (`docs/fleet-known-issues.md`, "Also accepted (B2-3 review)"). **NOT IMPLEMENTED:**
database-wide REVOKEs on `lo_*`/advisory functions, `REVOKE CONNECT ON DATABASE postgres`,
per-login `pg_hba` rules.

Owner caveat: the owner can `ALTER TABLE … DISABLE TRIGGER`, so every trigger guarantee above holds
against the restricted roles, not against the owner credential (`FLEET.md:232`).

### 3.7 Event catalogue written by the database

| Source | Event types |
|---|---|
| V2–V7 SQL (`fleet_event(...)`) | `agent_activated`, `agent_died`, `agent_orphaned`, `agent_recovered`, `agent_terminating`, `agent_unresponsive`, `authorization_denied`, `capital_requested`, `child_terminal_reported`, `credential_issued`, `db_auth_failed`, `health_challenge_failed`, `infrastructure_orphaned`, `orphan_slot_released`, `provisioning_failed`, `provisioning_reconciled`, `provisioning_sandbox_created`, `provisioning_sandbox_intent`, `provisioning_started`, `provisioning_uncertain`, `provisioning_verifying`, `reaper_resumed`, `replication_granted`, `replication_rejected`, `replication_requested`, `request_replayed`, `reservation_denied`, `reservation_expired`, `runtime_verification_failed`, `runtime_verified`, `sandbox_termination_requested`, `sandbox_terminated`, `sandbox_termination_unsupported`, `sandbox_termination_failed`, `scope_denied`, `session_opened`, `slot_claimed`, `slot_released`, `slot_reserved`, `spend_denied`, `spend_approved_not_executed` |
| V8 SQL | `operator_bad_request`, `operator_disabled`, `operator_audit_full`, `operator_auth_failed`, `operator_scope_denied`, `operator_stale`, `operator_replay_blocked`, `operator_requests_archived` |
| `svc_record_event` | any type matching `^[a-z][a-z0-9_]{0,63}$` chosen by the fleet service |
| `PgFleetStore` direct owner INSERTs | `cap_set`, `mode_set`, `runtime_approved`, `replication_switch_set`, `timeouts_set`, `agent_role_granted`, `service_role_granted`, `operator_role_granted`, `root_registered`, `registration_denied`, `credential_issued`, `agent_quarantined`, `orphan_resolved`, `lifecycle_policy_set` |
| `PgTreasuryStore` direct owner INSERTs | `treasury_policy_set`, `obligation_approved`, `capital_approved`, `capital_rejected`, `capital_changed`, `capital_completed`, `sweep_reduced`, `spending_frozen`, `spending_unfrozen`, `spend_limit_set`, `custody_transfer_planned`, `owner_distribution_planned`, `owner_distribution_rejected`, `sweep_planned` |
| `src/fleet/operator/admin.ts` direct owner INSERTs | `operator_principal_enrolled`, `operator_key_added`, `operator_key_revoked`, `operator_principal_revoked`, `operator_revoke_all`, `operator_api_enabled_set`, `operator_requests_archive_failed` |

### 3.8 DB-facing code paths that bypass the SECURITY DEFINER surface (owner credential only)

`PgFleetStore` (`store.ts`) writes these tables directly as the owner, each inside `tx()` and
(except as noted) after `SELECT … FROM fleet_state WHERE id = 1 FOR UPDATE`:
`setMaxAgents` (`UPDATE fleet_state SET max_agents`), `setOperatingMode`, `setApprovedRuntime`
(runtime guard applies), `setReplicationEnabled`, `setTimeouts`, `setLifecyclePolicy`,
`registerRoot` (INSERT an `active` root with `capability_scope`; existing wallet → `fleet_heartbeat`
+ runtime update; cap denial → `registration_denied`), `issueCredential` (credential upsert + revoke
all sessions; no state lock), `quarantine` (`fleet_begin_termination(…,'quarantine')`),
`resolveOrphan` (orphan resolved, orphaned agent → dead, termination forced `terminated`,
provisioning cleanup `terminated`), `reserveSlot` (`fleet_reserve_slot(…, p_match_pin = true, …)`),
`reserveDryRunSlot` (`fleet_reserve_dry_run`). All controller-path methods (`claimGrant`, `activate`,
`heartbeat`, `reap`, …) call the `svc_*` functions, so they work with the service login too.

`PgTreasuryStore` (`treasury/store.ts`, admin credential, pool 3) writes: `fleet_treasury_policy`
(UPDATE), `fleet_agent_ledger`, `fleet_balance_observations`, `fleet_obligations`,
`fleet_capital_allocations` (INSERT/UPDATE through the guard), `fleet_sweep_reductions`,
`fleet_wallet_custody` (freeze/unfreeze, daily limit), `fleet_custody_transfers`,
`fleet_treasury_ledger`, `fleet_treasury_obligations`, `fleet_owner_distributions`,
`fleet_sweep_plans`, plus `fleet_events`. None executes a payment.

`src/fleet/operator/admin.ts` (admin credential) writes the operator principal/key/state tables and
bumps `fleet_operator_state.generation` whenever the set of valid credentials or the kill switch
changes; archival goes through `fleet_operator_archive_export` / `fleet_operator_archive_requests`.


---

## 4. Effective privilege audit (`src/fleet/postgres/privileges.ts`)

`auditPrivileges(db, opts)` (`privileges.ts:80-250`) checks **effective** privileges
(`has_*_privilege`, so inherited and column-level grants count), not the grant history.
Callers:

| Caller | Credential | Options | Consequence |
|---|---|---|---|
| `pnpm fleet:audit-privileges` (`cli.ts:546-553`) | admin | defaults | prints JSON; exit 1 + `FAIL: <n> privilege problem(s)` list, or `PASS: agent, service and operator roles are least-privilege.`, or (not provisioned) `PASS: agent and service roles are least-privilege; operator roles: not provisioned (Operator API database roles absent; no privileges).` |
| `pnpm fleet:doctor` (`doctor.ts:258-263`) | whatever the doctor store uses | defaults | check "database privileges" pass/fail; failure adds blocker "Database privileges are too broad or roles are missing (pnpm fleet:audit-privileges)." |
| fleet service startup (`src/fleet/service/main.ts:241-243`) | service login | `agentRoles: [fleet_agent, <agent login user>]`, `serviceRoles: [fleet_service, <service login user>]`, operator roles default | `problemsFor()` keeps only problems about those roles, PUBLIC, "is not SECURITY DEFINER" and "does not pin search_path"; any → refuses to start: `Database privileges are too broad: …` |
| Operator API self-check (`src/fleet/operator/gateway.ts:149`) | operator login | `agentRoles: []`, `serviceRoles: []`, `operatorRoles: roles`, **`requireOperatorRoles: true`** | absence of an operator role is a problem |

Defaults: schema `fleet`; agent roles `["fleet_agent","fleet_agent_login"]`; service roles
`["fleet_service","fleet_service_login"]`; operator roles `["fleet_operator","fleet_operator_login"]`
(`privileges.ts:67-69`). Signatures are normalised by `normSig` (strip schema prefix, quotes and
whitespace), so `"fleet".api_whoami(text, text)` ≡ `api_whoami(text,text)`.

### 4.1 Rules, in evaluation order (each violation appends one problem string)

| # | Rule | Problem text |
|---|---|---|
| 1 | schema must exist (owner looked up in `pg_namespace`) | `schema <s> does not exist (run fleet:migrate)` |
| 2 | operator role state (see 4.2) | — |
| 3 | every planned role must exist | `role <r> does not exist (run scripts/fleet-db-roles.sql)` (and the role's other checks are skipped) |
| 4 | not superuser / createrole / createdb / replication / bypassrls | `<r> is a superuser`, `<r> can create roles`, `<r> can create databases`, `<r> has REPLICATION`, `<r> bypasses row-level security` |
| 5 | membership (`pg_has_role(r, oid, 'MEMBER')`, i.e. direct or indirect): never the schema owner; never another audited restricted role except its own group (`<x>_login` → `<x>`); never `pg_write_all_data`, `pg_read_all_data`, `pg_database_owner`, `pg_execute_server_program`, `pg_read_server_files`, `pg_write_server_files` | `<r> is a member of the schema owner <owner>` / `<r> is a member of <m>` |
| 6 | owns nothing: no schema anywhere, no relation or function in the fleet schema | `<r> owns schema <n>` / `<r> owns relation <n>` / `<r> owns function <n>` |
| 7 | no `CREATE` or `TEMPORARY` on the current database | `<r> can CREATE in database <db>` / `<r> can create TEMPORARY objects in <db>` |
| 8 | no `CREATE` on the fleet schema nor on schema `public` (only when the fleet schema exists) | `<r> can CREATE in schema <s>` / `<r> can CREATE in schema public` |
| 9 | table privileges: for every relation of kind `r, v, m, p, f, S` in the fleet schema and each of `SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER` (sequences: only SELECT/UPDATE via `has_sequence_privilege`; SELECT/INSERT/UPDATE/REFERENCES also via `has_any_column_privilege`) → any privilege is a problem **except** `SELECT` by a **service** role on a `SERVICE_READ_TABLES` table | `<r> has <PRIV> on <s>.<table>` |
| 10 | function EXECUTE: every function in the fleet schema the role can execute must be in the kind's allow-list (`AGENT_API_FUNCTIONS` / `SERVICE_API_FUNCTIONS` / `OPERATOR_API_FUNCTIONS`) | `<r> can EXECUTE <s>.<sig>` |
| 11 | every allowed executable function must be SECURITY DEFINER | `<s>.<sig> is not SECURITY DEFINER` |
| 12 | every allowed executable function must have a `search_path=` entry in `proconfig` | `<s>.<sig> does not pin search_path` |
| 13 | operator kind: every allowed function except `op_begin_request` must be STABLE or IMMUTABLE (`provolatile` `s`/`i`) | `<r>: <s>.<sig> is not STABLE (operator read functions must not be able to write)` |
| 14 | PUBLIC: no EXECUTE on any fleet function; no SELECT/INSERT/UPDATE/DELETE on relations `r, v, m, p, f`; no USAGE/CREATE on the fleet schema | `PUBLIC has EXECUTE <sig>` / `PUBLIC has SELECT/INSERT/UPDATE/DELETE on <t>` / `PUBLIC has USAGE/CREATE on schema <s>` |
| 15 | PUBLIC: no CREATE / TEMPORARY on the database | `PUBLIC can CREATE in database <db>` / `PUBLIC can create TEMPORARY objects in <db>` |
| 16 | operator-surface verifier `operatorSurfaceProblems()` (only if the fleet schema exists; it self-skips when `fleet_operator_routes` does not exist) | see 4.3 |

`ok = problems.length === 0`. Result also lists, per role, the executable allowed functions and the
readable allowed tables. Not checked (observation): sequence `USAGE`, and the `EXECUTE` of functions
outside the fleet schema.

### 4.2 Operator role states and "operatorRoles not_provisioned"

```ts
operatorState = present === configured.length ? "provisioned"
              : present === 0 && !opts.requireOperatorRoles ? "not_provisioned"
              : "incomplete";
```

- **`provisioned`** — every configured operator role exists; they are audited like the others (rules 3–13).
- **`not_provisioned`** — **none** of the configured operator roles exists and the caller did not set
  `requireOperatorRoles`. Meaning: the v8 Operator API database roles have not been created by
  `fleet-db-roles.sql`, so no operator privilege can exist; this is **not** a problem. The roles are
  listed in the result with `exists: false` and skipped; the audit can PASS; `fleet:audit-privileges`
  and `fleet:doctor` say "operator roles: not provisioned". Introduced by commit `4d6a0be` ("fix: treat
  absent Operator API roles as not provisioned in the privilege audit") — the production runtime commit.
- **`incomplete`** — some but not all exist, or none exists but `requireOperatorRoles` is true
  (Operator API self-check): every configured operator role is audited and each missing one yields
  `role <r> does not exist (run scripts/fleet-db-roles.sql)`.

Expected production value: `provisioned` (the Operator API is live on 127.0.0.1:8788 and connects as
`fleet_operator_login`). <!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->

### 4.3 Operator-surface verifier (`privileges.ts:278-366`)

Static checks over `pg_proc.prosrc` of every function in the fleet schema (signature-termination
invariant):

1. `codeOf(src)` strips `--` comments, `/* */` comments and single-quoted literals before analysis.
2. **Hygiene** of `op_begin_request` and of every read-side function (`op_*` except
   `op_begin_request`, plus helpers `fleet_operator_request_ok`, `fleet_operator_agent_json`):
   no `EXECUTE` keyword (dynamic SQL) → `operator surface: <f> uses dynamic SQL (EXECUTE)`; no `"`
   (quoted identifier) → `… uses a quoted identifier`; no call to a side-effecting built-in matching
   `^(nextval|setval|set_config|pg_notify|pg_advisory_\w+|pg_try_advisory_\w+|lo_\w+|dblink\w*|pg_terminate_backend|pg_cancel_backend|pg_sleep\w*|pg_reload_conf|pg_rotate_logfile|pg_file_\w+|pg_read_\w*file|pg_ls_\w+|pg_stat_reset\w*|pg_switch_wal|pg_create_\w+|pg_drop_replication_slot|pg_logical_emit_message|txid_current|pg_current_xact_id)$`;
   no call to a function that exists only in another non-system schema.
3. `op_begin_request`: every write target found by `writeTargets()` (INSERT INTO / UPDATE / DELETE FROM /
   MERGE INTO / TRUNCATE / COPY, not preceded by FOR/DO/KEY) must be in
   `OPERATOR_BOOKKEEPING_TABLES = [fleet_operator_nonces, fleet_operator_requests, fleet_operator_state]`
   → else `op_begin_request writes <t> …`; it may call no volatile fleet function other than
   `fleet_event` (and itself) → `op_begin_request calls volatile <f>`.
4. Any `op_*` function not in `OPERATOR_API_FUNCTIONS` → `operator surface: unexpected function <s>.<sig>`.
5. Read side: not volatile (`… is volatile`); no write statement (`… contains a write statement`); no
   reference to a volatile fleet function (`… references volatile <f>`); calls only read helpers among
   fleet functions (`… calls <f>, which is not an operator read helper`).
6. Routes (only when `current_user` can SELECT `fleet_operator_routes`, i.e. owner/admin; restricted
   auditors skip this part): every route's `fn` ∈ `OPERATOR_READ_FUNCTIONS`, exists, and is not
   volatile.

Runtime complement: the Operator API executes every read in `BEGIN TRANSACTION READ ONLY`.

---

## 5. EXPECTED SCHEMA ↔ PRODUCTION SCHEMA

<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->

Known production facts (operator records, 2026-09-25): schema v8, cap 2, mode DEVELOPMENT,
replication off, 0 agents (0 living, 0 reserved, 0 quarantined), Operator API enabled with two
principals (`bridge-claude` `op_01M3AX56W25JNMQCTBM8HYH474`, kind `bridge_claude`, scopes
status/agents/events, key `ec4f06982ae9135fd2b28e928f5a4a61` expiring 2026-10-24T23:49:04.533Z;
`bridge-chatgpt` `op_01M3B18TXVP33S6NQC909DXD57`, kind `bridge_chatgpt`, scopes status/agents, key
`fe22d91c08f0a0676b4c155ce0d618d3` expiring 2026-10-25T01:00:57.682Z); runtime commit
`4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790`, build
`54beb10104a11888446ed1d09a85f236d87b977558a88514de7600d7dcc83ced`, lockfile
`eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811`.

### 5.1 Object-count checklist derived from code (schema `fleet`)

| Object | Expected | How to count (read-only SQL, run as the owner) |
|---|---|---|
| schema version | `8`; `fleet_schema_migrations` rows = 8 (versions 1–8, names as §1.2) | `SELECT version, name FROM fleet.fleet_schema_migrations ORDER BY 1` |
| tables (`relkind 'r'`) | **31** | `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='fleet' AND c.relkind='r'` |
| sequences | **5** | same with `relkind='S'` |
| views / matviews / partitioned / foreign | **0** | `relkind IN ('v','m','p','f')` |
| functions | **85** (none overloaded) | `SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='fleet'` |
| SECURITY DEFINER functions | **34** (10 `api_`, 16 `svc_`, 8 `op_`) | `… AND p.prosecdef` |
| trigger functions | **27** | `… AND p.prorettype = 'trigger'::regtype` |
| functions with a search_path in `proconfig` | **77** (76 pinned `"fleet", pg_temp` + 1 `FROM CURRENT`: `fleet_reservations_guard`) | `… AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')` |
| volatility | 66 `v`, 17 `s`, 2 `i` | `GROUP BY provolatile` |
| user triggers | **58** | `SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='fleet' AND NOT t.tgisinternal` |
| explicit indexes (`CREATE [UNIQUE] INDEX`) | **25** | names in §5.2 |
| all indexes incl. PK/UNIQUE constraint indexes | **64** (25 explicit + 31 PK + 8 UNIQUE constraints) | `SELECT count(*) FROM pg_indexes WHERE schemaname='fleet'` |
| foreign keys | **29** | `SELECT count(*) FROM pg_constraint co JOIN pg_namespace n ON n.oid=co.connamespace WHERE n.nspname='fleet' AND co.contype='f'` |
| `fleet_state` columns / `fleet_agents` columns | 27 / 30 | `information_schema.columns` |
| seed rows | `fleet_state` 1, `fleet_treasury_policy` 1, `fleet_operator_state` 1, `fleet_operator_routes` 5 | `SELECT count(*) …` |
| roles | `fleet_agent`, `fleet_agent_login`, `fleet_service`, `fleet_service_login`, `fleet_operator`, `fleet_operator_login` exist; owner `fleetadmin` owns schema `fleet` | `pg_roles`, `pg_namespace.nspowner` |
| connection limits | agent login 32, service login 16, operator login 8 | `SELECT rolname, rolconnlimit FROM pg_roles WHERE rolname LIKE 'fleet_%'` |
| per-role settings | agent 10s/5s/30s, service 15s/5s/30s, operator 5s/2s/10s (statement / lock / idle-in-tx) | `SELECT r.rolname, s.setconfig FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole` |
| grants | fleet_agent EXECUTE 10; fleet_service EXECUTE 16 + SELECT 10 tables; fleet_operator EXECUTE 8; PUBLIC nothing | `pnpm fleet:audit-privileges` → PASS, `operatorRoles: "provisioned"` |
| grant audit events | at least one each of `agent_role_granted`, `service_role_granted`, `operator_role_granted` per `fleet:migrate` run | `SELECT event_type, count(*) FROM fleet.fleet_events WHERE event_type LIKE '%role_granted' GROUP BY 1` |
| expected state values | `max_agents = 2`, `operating_mode = 'DEVELOPMENT'`, `replication_enabled = false`, counters 0/0/0, runtime = the commit/build/lockfile above; `fleet_operator_state.operator_api_enabled = true`, `request_cap = 2000000` | `SELECT … FROM fleet.fleet_state` / `fleet_operator_state` |
| operator principals / active keys | 2 / 2 (one per principal) | `SELECT principal_id, name, kind, scopes, revoked_at FROM fleet.fleet_operator_principals` |

### 5.2 Explicit index names (25)

`fleet_agents_wallet_uq`, `fleet_agents_child_uq`, `fleet_agents_sandbox_live_uq`,
`fleet_agents_status_idx`, `fleet_agents_parent_idx`, `fleet_agents_heartbeat_idx`,
`fleet_events_agent_idx`, `fleet_reservations_open_idx`, `fleet_reservations_parent_idx`,
`fleet_agent_sessions_agent_idx`, `fleet_wallet_custody_wallet_uq`, `fleet_provisioning_cleanup_idx`,
`fleet_provisioning_key_uq`, `fleet_provisioning_sandbox_name_uq`, `fleet_provisioning_uncertain_idx`,
`fleet_orphans_open_uq`, `fleet_health_challenges_agent_idx`, `fleet_health_challenges_pending_uq`,
`fleet_agent_ledger_agent_idx`, `fleet_balance_observations_agent_idx`,
`fleet_capital_allocations_agent_idx`, `fleet_operator_keys_principal_idx`,
`fleet_operator_nonces_expiry_idx`, `fleet_operator_requests_principal_idx`,
`fleet_operator_requests_received_idx`.

UNIQUE-constraint indexes (8): `fleet_agents.request_key`, `fleet_reservations.agent_id`,
`fleet_agent_credentials.token_hash`, `fleet_provisioning.reservation_id`,
`fleet_provisioning.expected_agent_id`, `fleet_operator_principals.name`,
`fleet_operator_keys.public_key`, `fleet_operator_routes.fn`.

Expected live definition of the version-sensitive index:
`fleet_agents_sandbox_live_uq ON fleet_agents (sandbox_id) WHERE sandbox_id IS NOT NULL AND status IN ('reserved','provisioning','active','unresponsive','terminating','orphaned')`.

### 5.3 Comparison procedure (read-only)

1. `pnpm fleet:migrate-check` (admin credential) → expect `{"currentVersion":8,"resultingVersion":8,"wouldApply":[],"requiredVersion":8,"rolledBack":true}` (runs nothing).
2. `pnpm fleet:audit-privileges` → PASS, `operatorRoles: "provisioned"`.
3. `pnpm fleet:admin health` → `schemaVersion 8`, `countersConsistent true`.
4. Run the counting queries of §5.1 and diff function bodies against this document, e.g.
   `SELECT p.oid::regprocedure, md5(p.prosrc), p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='fleet' ORDER BY 1`
   against the same query on a scratch database migrated from the repository at `4d6a0be`.

---

## 6. Local SQLite fleet registry (Phase 1; separate from PostgreSQL)

Implemented in `src/fleet/registry.ts` (`FleetRegistry`, better-sqlite3) with schema
`MIGRATION_V12` / `MIGRATION_V12_CHILDREN_SYNC` in `src/state/schema.ts:683-795`, applied as version
12 of the automaton's own SQLite state database (`src/state/database.ts:630-636`,
`SCHEMA_VERSION = 12`, `src/state/schema.ts:8`) and idempotently by `FleetRegistry.ensureSchema()`.
It is the per-sandbox (local) registry used before the shared PostgreSQL registry existed; "global"
means global only to agents sharing the SQLite file (`FLEET.md:164`). It shares table names
(`fleet_agents`, `fleet_events`) with the PostgreSQL schema but is an unrelated database.

### 6.1 Tables

`fleet_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)` — keys used:
`max_agents` (string integer), `emergency` (`'1'`/`'0'`).

`fleet_agents`:

| Column | Type | Constraint |
|---|---|---|
| `id` | TEXT | PRIMARY KEY (ULID) |
| `role` | TEXT NOT NULL | `CHECK(role IN ('root','child'))` |
| `parent_agent_id` | TEXT | — |
| `requested_by` | TEXT NOT NULL | — |
| `name` | TEXT NOT NULL | — |
| `address` | TEXT | — |
| `child_id` | TEXT | UNIQUE |
| `sandbox_id` | TEXT | — |
| `status` | TEXT NOT NULL | `CHECK(status IN ('reserved','spawning','active','dead','failed'))` |
| `status_reason` | TEXT | — |
| `generation` | INTEGER NOT NULL DEFAULT 0 | — |
| `created_at` | TEXT NOT NULL | ISO-8601 |
| `updated_at` | TEXT NOT NULL | — |
| `died_at` | TEXT | — |

Indexes `idx_fleet_agents_status (status)`, `idx_fleet_agents_address (address)`.

`fleet_events (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, agent_id TEXT, actor TEXT, detail TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)`; index `idx_fleet_events_agent (agent_id, created_at)`.

### 6.2 Triggers

| Trigger | Definition |
|---|---|
| `fleet_agents_cap_insert` | BEFORE INSERT ON fleet_agents WHEN NEW.status IN ('reserved','spawning','active'): `RAISE(ABORT,'FLEET_CAP_EXCEEDED')` if `count(living) >= MIN(COALESCE(CAST(fleet_meta.max_agents AS INTEGER), 0), 50)` (missing cap = 0, fail closed) |
| `fleet_agents_terminal_immutable` | BEFORE UPDATE OF status WHEN OLD.status IN ('dead','failed') AND NEW.status <> OLD.status: `RAISE(ABORT,'FLEET_TERMINAL_STATE_IMMUTABLE')` |
| `fleet_agents_no_delete` | BEFORE DELETE: `RAISE(ABORT,'FLEET_HISTORY_IMMUTABLE')` |
| `fleet_events_no_delete` / `fleet_events_no_update` | BEFORE DELETE / UPDATE: `RAISE(ABORT,'FLEET_HISTORY_IMMUTABLE')` |
| `fleet_sync_child_terminal` (only if table `children` exists) | AFTER UPDATE OF status ON children WHEN NEW.status IN ('dead','stopped','failed','cleaned_up'): the matching `fleet_agents` row (`child_id = NEW.id`, living) → `dead` if active else `failed`, reason `child lifecycle: <status>` |

Living statuses: `('reserved','spawning','active')` (`registry.ts:26`). Hard max: `FLEET_HARD_MAX_AGENTS = 50` (`src/state/schema.ts:693`).

### 6.3 Behaviour

- Every read-then-write runs in `db.transaction(...).immediate()` (`BEGIN IMMEDIATE`, RESERVED lock
  before the count); `busy_timeout = 5000` ms.
- `reserveSlot`: EMERGENCY → `FLEET_EMERGENCY`; `living >= max` → `FLEET_CAP_REACHED`; else insert
  child `reserved` (generation parent+1) and return a frozen grant `{kind:'fleet-spawn-grant', reservationId}`;
  a cap-trigger abort is converted into `FLEET_CAP_REACHED` ("Fleet cap enforced by database.").
- `claimGrant`: missing/forged grant → `FleetBypassError` (`FLEET_BYPASS_DENIED`); `reserved → spawning` exactly once.
- `activate` (`spawning → active`), `releaseReservation` (`reserved/spawning → failed`), `markDead`
  (`active → dead`, other living → `failed`); events `root_registered`, `slot_reserved`,
  `reservation_denied`, `slot_claimed`, `agent_activated`, `slot_released`, `agent_died`, `cap_set`,
  `emergency_on`/`emergency_off`.
- No leases, heartbeats, credentials, runtime pinning, treasury or operator tables exist here.

---

## 7. DRIFT and NOT IMPLEMENTED summary (this part)

| Kind | Item |
|---|---|
| DRIFT | `FLEET.md:194` claims concurrent `fleet:migrate` runs are safe; the grant step is outside the advisory lock (FLEET-KI-1). |
| DRIFT | `scripts/fleet-db-setup.sh:13` comment "v1 -> v3"; code migrates to v8 and also grants the operator role. |
| DRIFT | `scripts/fleet-db-roles.sql` comment "the owner and the two logins may connect"; three logins get CONNECT. |
| DRIFT | `FLEET.md:251/257/361-363` (schema v2/v3 role tables) list 7 `api_*`, 11 `svc_*`, 6 service-readable tables; v8 code: 10, 16, 10. |
| DRIFT | `FLEET.md:180-190` "Schema (migration v1)" lists only the V1 tables and statuses; the live schema is v8 (31 tables, 8 agent statuses). Historical section. |
| Observation | `fleet_state_runtime_guard` (V3) was never updated for V4 statuses: `terminating`/`orphaned` children do not block a runtime change. |
| Observation | `fleet_reservations_guard` keeps `SET search_path FROM CURRENT` (no explicit `pg_temp`); only the owner has TEMP, so restricted roles cannot exploit it. |
| Observation | `grantServiceRole` does not revoke PUBLIC (the agent/operator grants and every migration do). |
| Observation | privilege audit does not check sequence `USAGE`. |
| NOT IMPLEMENTED | down-migrations (rollback = restore a pre-migration dump). |
| NOT IMPLEMENTED | serialising the grant step with the migration advisory lock (FLEET-KI-1 fix). |
| NOT IMPLEMENTED | database-wide hardening for all fleet logins: REVOKE on `lo_*`/advisory functions from PUBLIC, `REVOKE CONNECT ON DATABASE postgres`, per-login `pg_hba` rules. |
| NOT IMPLEMENTED | any money movement: sweeps, owner distributions, custody transfers and spends are recorded as `planned_not_executed` / `blocked_payments_disabled` / `approved_not_executed` only; `custody_mode 'controller_signer'` is allowed by the CHECK but no code path signs. |
| NOT IMPLEMENTED | mutating operator capabilities (e.g. `ops.propose`): forbidden by the signature-termination invariant; requires a separate security-design gate. |

---

> **Phase D3 extension (IMPLEMENTED LOCALLY - NOT DEPLOYED):** schema v9 adds controlled operator actions on top of what this chapter describes. Production is still as documented here (v8, read-only). See `24-PHASE-D3-OPERATOR-ACTIONS.md`.
