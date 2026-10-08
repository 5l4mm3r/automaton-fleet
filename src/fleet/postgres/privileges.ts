/**
 * Effective database privilege audit (Phase 4)
 *
 * Checks what the restricted roles can ACTUALLY do (has_*_privilege, so
 * inherited and column-level grants count), not what we believe we granted.
 * Used by `pnpm fleet:audit-privileges`, `pnpm fleet:doctor` and the fleet
 * service at startup; any problem fails the command / refuses startup.
 *
 *   agent roles    USAGE on the schema + EXECUTE on api_* only
 *   service roles  USAGE + SELECT on SERVICE_READ_TABLES + EXECUTE on svc_* only
 *   both           not superuser/createrole/createdb/replication/bypassrls, own
 *                  nothing, no CREATE/TEMP, not members of the owner or of
 *                  each other
 *   PUBLIC         nothing in the schema
 *   custody roles  (schema v10) USAGE + EXECUTE on cx_* only, no table privilege
 *   operator roles (schema v8/v9) USAGE + EXECUTE on op_* only, no table privilege,
 *                  every function STABLE except the admission functions and
 *                  the named D3 action functions (OPERATOR_VOLATILE_FUNCTIONS)
 *
 * Operator surface (schema v8 signature-termination invariant, extended in v9):
 * the admission functions write only the operator bookkeeping tables (+ denial
 * events via fleet_event); no read-side operator function calls a volatile
 * function; each D3 action function writes and calls only what
 * OPERATOR_ACTION_WRITES allows it; GET routes point only at read functions
 * and POST routes only at action functions. See migrations-phase8/9.ts.
 *
 * Ledger / custody surface (schema v10): only LEDGER_WRITERS write the ledger
 * tables; the cx_* functions write and call only what CUSTODY_WRITES allows;
 * custody execution is pinned off by a CHECK constraint. See migrations-phase10.ts.
 */

import {
  AGENT_API_FUNCTIONS,
  CUSTODY_API_FUNCTIONS,
  CUSTODY_WRITES,
  IDENTITY_API_FUNCTIONS,
  BROWSER_API_FUNCTIONS,
  DASHBOARD_API_FUNCTIONS,
  GENESIS_GUARDS,
  GENESIS_OPERATORS,
  LEDGER_TABLES,
  LEDGER_WRITERS,
  OPERATOR_ACTION_FUNCTIONS,
  OPERATOR_ACTION_HELPERS,
  OPERATOR_ACTION_WRITES,
  OPERATOR_API_FUNCTIONS,
  OPERATOR_BOOKKEEPING_TABLES,
  OPERATOR_READ_FUNCTIONS,
  OPERATOR_VOLATILE_FUNCTIONS,
  SERVICE_API_FUNCTIONS,
  SERVICE_READ_TABLES,
} from "./migrations.js";

export interface Queryable {
  query<R = any>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface PrivilegeAuditOptions {
  schema?: string;
  agentRoles?: string[];
  serviceRoles?: string[];
  /** Schema v8 read-only Operator API roles (default fleet_operator + fleet_operator_login). */
  operatorRoles?: string[];
  /**
   * Require the operator roles to exist (the Operator API's own self-check).
   * Otherwise, when NONE of them exists, the Operator API is simply not
   * provisioned: a role that does not exist holds no privilege, so this is
   * not a problem. As soon as any one exists, all must exist and pass every
   * operator check.
   */
  requireOperatorRoles?: boolean;
  /** Schema v10 custody executor roles (default fleet_custody + fleet_custody_login); same provisioning rule as the operator roles. */
  custodyRoles?: string[];
  requireCustodyRoles?: boolean;
  /** Schema v34 identity broker roles (default fleet_identity + fleet_identity_login). */
  identityRoles?: string[];
  requireIdentityRoles?: boolean;
  /** Schema v37 browser worker roles (default fleet_browser + fleet_browser_login). */
  browserRoles?: string[];
  requireBrowserRoles?: boolean;
  /** Schema v38 Admin dashboard roles (default fleet_dashboard + fleet_dashboard_login). */
  dashboardRoles?: string[];
  requireDashboardRoles?: boolean;
}

/** "provisioned": every operator role exists; "not_provisioned": none exists (and not required); "incomplete": some are missing. */
export type OperatorRoleState = "provisioned" | "not_provisioned" | "incomplete";

export interface PrivilegeAuditResult {
  ok: boolean;
  schema: string;
  owner: string | null;
  database: string;
  problems: string[];
  roles: Array<{ role: string; kind: RoleKind; exists: boolean; functions: string[]; tables: string[] }>;
  operatorRoles: OperatorRoleState;
  custodyRoles: OperatorRoleState;
}

export const DEFAULT_AGENT_ROLES = ["fleet_agent", "fleet_agent_login"];
export const DEFAULT_SERVICE_ROLES = ["fleet_service", "fleet_service_login"];
export const DEFAULT_OPERATOR_ROLES = ["fleet_operator", "fleet_operator_login"];
export const DEFAULT_CUSTODY_ROLES = ["fleet_custody", "fleet_custody_login"];
/** Schema v34 identity broker roles (same provisioning rule: absent = not provisioned). */
export const DEFAULT_IDENTITY_ROLES = ["fleet_identity", "fleet_identity_login"];
/** Schema v37 browser worker roles (same provisioning rule). */
export const DEFAULT_BROWSER_ROLES = ["fleet_browser", "fleet_browser_login"];
/** Schema v38 Admin dashboard roles (same provisioning rule). */
export const DEFAULT_DASHBOARD_ROLES = ["fleet_dashboard", "fleet_dashboard_login"];

type RoleKind = "agent" | "service" | "operator" | "custody" | "identity" | "browser" | "dashboard";

const TABLE_PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

/** "fleet.api_whoami(text, text)" / "api_whoami(text,text)" -> "api_whoami(text,text)". */
function normSig(sig: string): string {
  return sig.replace(/^.*?\.(?=[a-z_][a-z0-9_]*\()/i, "").replace(/"/g, "").replace(/\s+/g, "");
}

export async function auditPrivileges(db: Queryable, opts: PrivilegeAuditOptions = {}): Promise<PrivilegeAuditResult> {
  const schema = opts.schema ?? "fleet";
  const problems: string[] = [];
  const head = await db.query<{ db: string; owner: string | null }>(
    `SELECT current_database() AS db, (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = $1) AS owner`,
    [schema],
  );
  const { db: database, owner } = head.rows[0];
  if (!owner) problems.push(`schema ${schema} does not exist (run fleet:migrate)`);

  const roles: PrivilegeAuditResult["roles"] = [];
  const configuredOperatorRoles = opts.operatorRoles ?? DEFAULT_OPERATOR_ROLES;
  const presentOperator = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ANY($1)`, [configuredOperatorRoles]);
  const operatorPresent = presentOperator.rows[0].n;
  const operatorState: OperatorRoleState =
    operatorPresent === configuredOperatorRoles.length ? "provisioned" : operatorPresent === 0 && !opts.requireOperatorRoles ? "not_provisioned" : "incomplete";
  const operatorRoles = operatorState === "not_provisioned" ? [] : configuredOperatorRoles;
  if (operatorState === "not_provisioned") {
    for (const r of configuredOperatorRoles) roles.push({ role: r, kind: "operator", exists: false, functions: [], tables: [] });
  }
  const configuredCustodyRoles = opts.custodyRoles ?? DEFAULT_CUSTODY_ROLES;
  const presentCustody = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ANY($1)`, [configuredCustodyRoles]);
  const custodyPresent = presentCustody.rows[0].n;
  const custodyState: OperatorRoleState =
    custodyPresent === configuredCustodyRoles.length ? "provisioned" : custodyPresent === 0 && !opts.requireCustodyRoles ? "not_provisioned" : "incomplete";
  const custodyRoles = custodyState === "not_provisioned" ? [] : configuredCustodyRoles;
  if (custodyState === "not_provisioned") {
    for (const r of configuredCustodyRoles) roles.push({ role: r, kind: "custody", exists: false, functions: [], tables: [] });
  }
  const configuredIdentityRoles = opts.identityRoles ?? DEFAULT_IDENTITY_ROLES;
  const identityPresent = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ANY($1)`, [configuredIdentityRoles])).rows[0].n;
  const identityState: OperatorRoleState =
    identityPresent === configuredIdentityRoles.length ? "provisioned" : identityPresent === 0 && !opts.requireIdentityRoles ? "not_provisioned" : "incomplete";
  const identityRoles = identityState === "not_provisioned" ? [] : configuredIdentityRoles;
  if (identityState === "not_provisioned") {
    for (const r of configuredIdentityRoles) roles.push({ role: r, kind: "identity", exists: false, functions: [], tables: [] });
  }
  const configuredBrowserRoles = opts.browserRoles ?? DEFAULT_BROWSER_ROLES;
  const browserPresent = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ANY($1)`, [configuredBrowserRoles])).rows[0].n;
  const browserState: OperatorRoleState =
    browserPresent === configuredBrowserRoles.length ? "provisioned" : browserPresent === 0 && !opts.requireBrowserRoles ? "not_provisioned" : "incomplete";
  const browserRoles = browserState === "not_provisioned" ? [] : configuredBrowserRoles;
  if (browserState === "not_provisioned") {
    for (const r of configuredBrowserRoles) roles.push({ role: r, kind: "browser", exists: false, functions: [], tables: [] });
  }
  const configuredDashboardRoles = opts.dashboardRoles ?? DEFAULT_DASHBOARD_ROLES;
  const dashboardPresent = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ANY($1)`, [configuredDashboardRoles])).rows[0].n;
  const dashboardState: OperatorRoleState =
    dashboardPresent === configuredDashboardRoles.length ? "provisioned" : dashboardPresent === 0 && !opts.requireDashboardRoles ? "not_provisioned" : "incomplete";
  const dashboardRoles = dashboardState === "not_provisioned" ? [] : configuredDashboardRoles;
  if (dashboardState === "not_provisioned") {
    for (const r of configuredDashboardRoles) roles.push({ role: r, kind: "dashboard", exists: false, functions: [], tables: [] });
  }
  const allRestricted = [
    ...(opts.agentRoles ?? DEFAULT_AGENT_ROLES),
    ...(opts.serviceRoles ?? DEFAULT_SERVICE_ROLES),
    ...operatorRoles,
    ...custodyRoles,
    ...identityRoles,
    ...browserRoles,
    ...dashboardRoles,
  ];
  const plan: Array<[string, RoleKind]> = [
    ...(opts.agentRoles ?? DEFAULT_AGENT_ROLES).map((r) => [r, "agent"] as [string, RoleKind]),
    ...(opts.serviceRoles ?? DEFAULT_SERVICE_ROLES).map((r) => [r, "service"] as [string, RoleKind]),
    ...operatorRoles.map((r) => [r, "operator"] as [string, RoleKind]),
    ...custodyRoles.map((r) => [r, "custody"] as [string, RoleKind]),
    ...identityRoles.map((r) => [r, "identity"] as [string, RoleKind]),
    ...browserRoles.map((r) => [r, "browser"] as [string, RoleKind]),
    ...dashboardRoles.map((r) => [r, "dashboard"] as [string, RoleKind]),
  ];

  const agentFns = new Set(AGENT_API_FUNCTIONS.map(normSig));
  const serviceFns = new Set(SERVICE_API_FUNCTIONS.map(normSig));
  const operatorFns = new Set(OPERATOR_API_FUNCTIONS.map(normSig));
  const custodyFns = new Set(CUSTODY_API_FUNCTIONS.map(normSig));
  const identityFns = new Set(IDENTITY_API_FUNCTIONS.map(normSig));
  const browserFns = new Set(BROWSER_API_FUNCTIONS.map(normSig));
  const dashboardFns = new Set(DASHBOARD_API_FUNCTIONS.map(normSig));
  const operatorVolatile = new Set(OPERATOR_VOLATILE_FUNCTIONS.map(normSig));
  const serviceTables = new Set(SERVICE_READ_TABLES);

  for (const [role, kind] of plan) {
    const r = await db.query<{ su: boolean; cr: boolean; cd: boolean; repl: boolean; bypass: boolean }>(
      `SELECT rolsuper AS su, rolcreaterole AS cr, rolcreatedb AS cd, rolreplication AS repl, rolbypassrls AS bypass
         FROM pg_roles WHERE rolname = $1`,
      [role],
    );
    if (!r.rows[0]) {
      problems.push(`role ${role} does not exist (run scripts/fleet-db-roles.sql)`);
      roles.push({ role, kind, exists: false, functions: [], tables: [] });
      continue;
    }
    const a = r.rows[0];
    if (a.su) problems.push(`${role} is a superuser`);
    if (a.cr) problems.push(`${role} can create roles`);
    if (a.cd) problems.push(`${role} can create databases`);
    if (a.repl) problems.push(`${role} has REPLICATION`);
    if (a.bypass) problems.push(`${role} bypasses row-level security`);

    // Membership: never in the owner role, never in another restricted role
    // (other than its own group: *_login -> its NOLOGIN group).
    const group = role.replace(/_login$/, "");
    const members = await db.query<{ r: string }>(
      `SELECT rolname AS r FROM pg_roles WHERE rolname <> $1 AND pg_has_role($1, oid, 'MEMBER')`,
      [role],
    );
    for (const m of members.rows) {
      if (m.r === owner) problems.push(`${role} is a member of the schema owner ${owner}`);
      else if (allRestricted.includes(m.r) && m.r !== group) problems.push(`${role} is a member of ${m.r}`);
      else if (/^pg_(write_all_data|read_all_data|database_owner|execute_server_program|read_server_files|write_server_files)$/.test(m.r)) {
        problems.push(`${role} is a member of ${m.r}`);
      }
    }

    const owns = await db.query<{ n: string }>(
      `SELECT 'schema ' || nspname AS n FROM pg_namespace WHERE nspowner = (SELECT oid FROM pg_roles WHERE rolname = $1)
       UNION ALL
       SELECT 'relation ' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $2 AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = $1)
       UNION ALL
       SELECT 'function ' || p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $2 AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = $1)`,
      [role, schema],
    );
    for (const o of owns.rows) problems.push(`${role} owns ${o.n}`);

    const dbp = await db.query<{ c: boolean; t: boolean }>(
      `SELECT has_database_privilege($1, current_database(), 'CREATE') AS c,
              has_database_privilege($1, current_database(), 'TEMPORARY') AS t`,
      [role],
    );
    if (dbp.rows[0].c) problems.push(`${role} can CREATE in database ${database}`);
    if (dbp.rows[0].t) problems.push(`${role} can create TEMPORARY objects in ${database}`);

    if (owner) {
      const sp = await db.query<{ c: boolean; pc: boolean }>(
        `SELECT has_schema_privilege($1, $2, 'CREATE') AS c, has_schema_privilege($1, 'public', 'CREATE') AS pc`,
        [role, schema],
      );
      if (sp.rows[0].c) problems.push(`${role} can CREATE in schema ${schema}`);
      if (sp.rows[0].pc) problems.push(`${role} can CREATE in schema public`);
    }

    const tables = await db.query<{ t: string; p: string }>(
      `SELECT c.relname AS t, p.priv AS p
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN unnest($3::text[]) AS p(priv)
        WHERE n.nspname = $2 AND c.relkind IN ('r','v','m','p','f','S')
          AND (CASE WHEN c.relkind = 'S' THEN p.priv IN ('SELECT','UPDATE') AND has_sequence_privilege($1, c.oid,
                      CASE WHEN p.priv = 'SELECT' THEN 'SELECT' ELSE 'UPDATE' END)
                    WHEN p.priv IN ('SELECT','INSERT','UPDATE','REFERENCES')
                      THEN has_table_privilege($1, c.oid, p.priv) OR has_any_column_privilege($1, c.oid, p.priv)
                    ELSE has_table_privilege($1, c.oid, p.priv) END)
        ORDER BY 1, 2`,
      [role, schema, TABLE_PRIVS],
    );
    const readable: string[] = [];
    for (const t of tables.rows) {
      if (kind === "service" && t.p === "SELECT" && serviceTables.has(t.t)) {
        readable.push(t.t);
        continue;
      }
      problems.push(`${role} has ${t.p} on ${schema}.${t.t}`);
    }

    const fns = await db.query<{ sig: string; secdef: boolean; cfg: string[] | null; vol: string }>(
      `SELECT p.oid::regprocedure::text AS sig, p.prosecdef AS secdef, p.proconfig AS cfg, p.provolatile AS vol
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $2 AND has_function_privilege($1, p.oid, 'EXECUTE')
        ORDER BY 1`,
      [role, schema],
    );
    const allowed = kind === "agent" ? agentFns : kind === "service" ? serviceFns : kind === "custody" ? custodyFns : kind === "identity" ? identityFns : kind === "browser" ? browserFns : kind === "dashboard" ? dashboardFns : operatorFns;
    const executable: string[] = [];
    for (const f of fns.rows) {
      const sig = normSig(f.sig);
      if (!allowed.has(sig)) {
        problems.push(`${role} can EXECUTE ${schema}.${sig}`);
        continue;
      }
      executable.push(sig);
      if (!f.secdef) problems.push(`${schema}.${sig} is not SECURITY DEFINER`);
      if (!(f.cfg ?? []).some((c) => c.startsWith("search_path="))) problems.push(`${schema}.${sig} does not pin search_path`);
      if (kind === "operator" && !operatorVolatile.has(sig) && f.vol !== "s" && f.vol !== "i") {
        problems.push(`${role}: ${schema}.${sig} is not STABLE (operator read functions must not be able to write)`);
      }
    }
    roles.push({ role, kind, exists: true, functions: executable, tables: readable });
  }

  // PUBLIC must have nothing in the fleet schema and no CREATE/TEMP on the database.
  if (owner) {
    const pub = await db.query<{ what: string }>(
      `SELECT 'EXECUTE ' || p.oid::regprocedure::text AS what
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND has_function_privilege('public', p.oid, 'EXECUTE')
       UNION ALL
       SELECT 'SELECT/INSERT/UPDATE/DELETE on ' || c.relname
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r','v','m','p','f')
          AND (has_table_privilege('public', c.oid, 'SELECT') OR has_table_privilege('public', c.oid, 'INSERT')
               OR has_table_privilege('public', c.oid, 'UPDATE') OR has_table_privilege('public', c.oid, 'DELETE'))
       UNION ALL
       SELECT 'USAGE/CREATE on schema ' || $1 WHERE has_schema_privilege('public', $1, 'USAGE') OR has_schema_privilege('public', $1, 'CREATE')`,
      [schema],
    );
    for (const p of pub.rows) problems.push(`PUBLIC has ${p.what}`);
  }
  const pubDb = await db.query<{ c: boolean; t: boolean }>(
    `SELECT has_database_privilege('public', current_database(), 'CREATE') AS c,
            has_database_privilege('public', current_database(), 'TEMPORARY') AS t`,
  );
  if (pubDb.rows[0].c) problems.push(`PUBLIC can CREATE in database ${database}`);
  if (pubDb.rows[0].t) problems.push(`PUBLIC can create TEMPORARY objects in ${database}`);

  if (owner) problems.push(...(await operatorSurfaceProblems(db, schema)));
  if (owner) problems.push(...(await ledgerSurfaceProblems(db, schema)));
  if (owner) problems.push(...(await genesisSurfaceProblems(db, schema)));
  if (owner) problems.push(...(await cognitionSurfaceProblems(db, schema)));
  if (owner) problems.push(...(await economySurfaceProblems(db, schema)));

  return { ok: problems.length === 0, schema, owner, database, problems, roles, operatorRoles: operatorState, custodyRoles: custodyState };
}

/** A PL/pgSQL/SQL body without comments or string literals (so quotes inside literals don't count). */
function codeOf(src: string): string {
  return src
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
}

/** INSERT/UPDATE/DELETE/MERGE/TRUNCATE/COPY targets in a body (comments and literals stripped; quoted names unquoted). */
export function writeTargets(src: string): string[] {
  const body = codeOf(src);
  const out = new Set<string>();
  const re = /(?<!\b(?:FOR|DO|KEY)\s+)\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?|COPY)\s+(?:ONLY\s+)?((?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*))?)/gi;
  for (const m of body.matchAll(re)) {
    const last = m[1].split(".").pop()!.trim().replace(/^"|"$/g, "");
    out.add(last.toLowerCase());
  }
  return [...out].sort();
}

/** Built-in functions with side effects outside the statement's own rows; never needed by the read surface. */
const SIDE_EFFECT_BUILTINS = /^(nextval|setval|set_config|pg_notify|pg_advisory_\w+|pg_try_advisory_\w+|lo_\w+|dblink\w*|pg_terminate_backend|pg_cancel_backend|pg_sleep\w*|pg_reload_conf|pg_rotate_logfile|pg_file_\w+|pg_read_\w*file|pg_ls_\w+|pg_stat_reset\w*|pg_switch_wal|pg_create_\w+|pg_drop_replication_slot|pg_logical_emit_message|txid_current|pg_current_xact_id)$/;

/** Read helpers the op_* read functions may call (each is checked the same way). */
const OPERATOR_READ_HELPERS = ["fleet_operator_request_ok", "fleet_operator_agent_json"];

/**
 * Schema v8 signature-termination invariant, checked against the live
 * catalog (only when the operator schema exists). Static checks; the
 * runtime control is that the Operator API runs every read in a READ ONLY
 * transaction (gateway.ts).
 *  - no operator-surface body uses dynamic SQL (EXECUTE) or quoted
 *    identifiers (which could hide names from these checks);
 *  - op_begin_request writes only OPERATOR_BOOKKEEPING_TABLES and calls no
 *    volatile fleet function other than fleet_event;
 *  - read-side functions are non-volatile, contain no write statement, call
 *    no fleet function outside the read helpers, no function from another
 *    user schema and no side-effecting built-in;
 *  - no unexpected op_* function exists; every route points at a read function.
 */
export async function operatorSurfaceProblems(db: Queryable, schema: string): Promise<string[]> {
  const problems: string[] = [];
  const present = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = 'fleet_operator_routes'`,
    [schema],
  );
  if (!present.rows[0]?.n) return problems;
  const fns = await db.query<{ name: string; sig: string; vol: string; src: string }>(
    `SELECT p.proname AS name, p.oid::regprocedure::text AS sig, p.provolatile AS vol, p.prosrc AS src
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1`,
    [schema],
  );
  const foreign = await db.query<{ name: string }>(
    `SELECT DISTINCT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ($1, 'pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_%'`,
    [schema],
  );
  const fleetNames = new Set(fns.rows.map((f) => f.name));
  const foreignNames = new Set(foreign.rows.map((f) => f.name));
  const volatileNames = new Set(fns.rows.filter((f) => f.vol === "v").map((f) => f.name));
  const opNames = new Set(OPERATOR_API_FUNCTIONS.map((f) => f.replace(/\(.*$/, "")));
  const readSide = new Set([...opNames, ...OPERATOR_READ_HELPERS]);
  readSide.delete("op_begin_request");
  const allowedWrites = new Set(OPERATOR_BOOKKEEPING_TABLES);
  const callsOf = (src: string) => new Set([...codeOf(src).matchAll(/\b([a-z_][a-z0-9_$]*)\s*\(/gi)].map((m) => m[1].toLowerCase()));
  const hygiene = (name: string, src: string) => {
    const code = codeOf(src);
    if (/\bEXECUTE\b/i.test(code)) problems.push(`operator surface: ${name} uses dynamic SQL (EXECUTE)`);
    if (code.includes('"')) problems.push(`operator surface: ${name} uses a quoted identifier`);
    for (const c of callsOf(src)) {
      if (SIDE_EFFECT_BUILTINS.test(c)) problems.push(`operator surface: ${name} calls side-effecting ${c}`);
      if (foreignNames.has(c) && !fleetNames.has(c)) problems.push(`operator surface: ${name} calls ${c} from another schema`);
    }
  };
  const admission = new Set(["op_begin_request", "op_begin_action"]);
  const volatileOps = new Set(OPERATOR_VOLATILE_FUNCTIONS.map((f) => f.replace(/\(.*$/, "")));
  for (const n of volatileOps) readSide.delete(n);
  const actionHelpers = new Set(OPERATOR_ACTION_HELPERS);
  for (const f of fns.rows) {
    if (admission.has(f.name)) {
      // v8: op_begin_request held the admission logic itself; v9: both wrappers call fleet_operator_begin only.
      hygiene(f.name, f.src);
      for (const t of writeTargets(f.src)) {
        if (!allowedWrites.has(t)) problems.push(`operator surface: ${f.name} writes ${t} (only operator bookkeeping is allowed)`);
      }
      for (const c of callsOf(f.src)) {
        if (volatileNames.has(c) && c !== "fleet_event" && c !== "fleet_operator_begin" && c !== f.name) {
          problems.push(`operator surface: ${f.name} calls volatile ${c}`);
        }
      }
      continue;
    }
    if (f.name === "fleet_operator_begin") {
      hygiene(f.name, f.src);
      for (const t of writeTargets(f.src)) {
        if (!allowedWrites.has(t)) problems.push(`operator surface: fleet_operator_begin writes ${t} (only operator bookkeeping is allowed)`);
      }
      for (const c of callsOf(f.src)) {
        if (volatileNames.has(c) && c !== "fleet_event" && c !== f.name) problems.push(`operator surface: fleet_operator_begin calls volatile ${c}`);
      }
      continue;
    }
    const rule = Object.prototype.hasOwnProperty.call(OPERATOR_ACTION_WRITES, f.name) ? OPERATOR_ACTION_WRITES[f.name] : undefined;
    if (rule) {
      hygiene(f.name, f.src);
      if (/fleet\.proposal_decision/.test(f.src)) problems.push(`operator surface: ${f.name} references the owner proposal-decision guard`);
      const allowedW = new Set(rule.writes);
      for (const t of writeTargets(f.src)) {
        if (!allowedW.has(t)) problems.push(`operator surface: ${f.name} writes ${t} (not in its D3 allow-list)`);
      }
      const allowedC = new Set(rule.calls);
      for (const c of callsOf(f.src)) {
        if (c === f.name || !fleetNames.has(c)) continue;
        if (volatileNames.has(c) && !allowedC.has(c)) problems.push(`operator surface: ${f.name} calls volatile ${c} (not in its D3 allow-list)`);
        else if (!volatileNames.has(c) && !allowedC.has(c) && !actionHelpers.has(c)) problems.push(`operator surface: ${f.name} calls ${c}, which is not a D3 action helper`);
      }
      continue;
    }
    if (actionHelpers.has(f.name) && f.name !== "fleet_scrub") {
      hygiene(f.name, f.src);
      if (f.vol === "v") problems.push(`operator surface: action helper ${f.name} is volatile`);
      if (writeTargets(f.src).length) problems.push(`operator surface: action helper ${f.name} contains a write statement`);
      for (const c of callsOf(f.src)) {
        if (c !== f.name && fleetNames.has(c) && !actionHelpers.has(c)) problems.push(`operator surface: action helper ${f.name} calls ${c}`);
      }
      continue;
    }
    if (f.name.startsWith("op_") && !opNames.has(f.name)) problems.push(`operator surface: unexpected function ${schema}.${normSig(f.sig)}`);
    if (!readSide.has(f.name)) continue;
    hygiene(f.name, f.src);
    if (f.vol === "v") problems.push(`operator surface: ${f.name} is volatile`);
    if (writeTargets(f.src).length) problems.push(`operator surface: ${f.name} contains a write statement`);
    for (const c of callsOf(f.src)) {
      if (volatileNames.has(c)) problems.push(`operator surface: ${f.name} references volatile ${c}`);
      else if (fleetNames.has(c) && c !== f.name && !readSide.has(c)) problems.push(`operator surface: ${f.name} calls ${c}, which is not an operator read helper`);
    }
  }
  // Route contents need SELECT (owner/admin). A restricted auditor (the fleet service's startup
  // self-check) skips this part; the fleet_operator_routes CHECK still confines fn to the read functions.
  const canRead = await db.query<{ ok: boolean }>(
    `SELECT has_table_privilege(current_user, $1, 'SELECT') AS ok`,
    [`${schemaIdent(schema)}.fleet_operator_routes`],
  );
  if (!canRead.rows[0]?.ok) return [...new Set(problems)];
  const routes = await db.query<{ route: string; fn: string }>(`SELECT route, fn FROM ${schemaIdent(schema)}.fleet_operator_routes ORDER BY route`);
  const readFns = new Set(OPERATOR_READ_FUNCTIONS);
  const actionFns = new Set(OPERATOR_ACTION_FUNCTIONS);
  for (const r of routes.rows) {
    const f = fns.rows.find((x) => x.name === r.fn);
    if (r.route.startsWith("GET ")) {
      if (!readFns.has(r.fn)) problems.push(`operator surface: route ${r.route} maps to non-read function ${r.fn}`);
      if (!f) problems.push(`operator surface: route ${r.route} maps to missing function ${r.fn}`);
      else if (f.vol === "v") problems.push(`operator surface: route ${r.route} maps to volatile ${r.fn}`);
    } else if (r.route.startsWith("POST ")) {
      if (!actionFns.has(r.fn)) problems.push(`operator surface: route ${r.route} maps to non-action function ${r.fn}`);
      if (!f) problems.push(`operator surface: route ${r.route} maps to missing function ${r.fn}`);
    } else problems.push(`operator surface: route ${r.route} has an unsupported method`);
  }
  return [...new Set(problems)];
}

/**
 * Schema v10 ledger / custody invariants, checked against the live catalog
 * (only once the ledger exists):
 *  - only LEDGER_WRITERS contain a write to a ledger table, and only they
 *    (plus the ledger's own guard triggers) mention the fleet.ledger_* write
 *    guards, so no other function can open the ledger;
 *  - cx_* functions use no dynamic SQL, write only their CUSTODY_WRITES tables
 *    and call only their allowed volatile functions; no unexpected cx_* exists;
 *  - custody execution is off and pinned off by a CHECK constraint;
 *  - the ledger tables and the economic model have their immutability triggers.
 */
export async function ledgerSurfaceProblems(db: Queryable, schema: string): Promise<string[]> {
  const problems: string[] = [];
  const present = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = 'fleet_ledger_journal'`,
    [schema],
  );
  if (!present.rows[0]?.n) return problems;
  const fns = await db.query<{ name: string; sig: string; vol: string; src: string }>(
    `SELECT p.proname AS name, p.oid::regprocedure::text AS sig, p.provolatile AS vol, p.prosrc AS src
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1`,
    [schema],
  );
  const fleetNames = new Set(fns.rows.map((f) => f.name));
  const volatileNames = new Set(fns.rows.filter((f) => f.vol === "v").map((f) => f.name));
  const ledgerTables = new Set(LEDGER_TABLES);
  const writers = new Set(LEDGER_WRITERS);
  const guardNames = new Set(["fleet_ledger_write_guard", "fleet_ledger_journal_guard", "fleet_ledger_head_guard"]);
  const callsOf = (src: string) => new Set([...codeOf(src).matchAll(/\b([a-z_][a-z0-9_$]*)\s*\(/gi)].map((m) => m[1].toLowerCase()));
  const cxNames = new Set(CUSTODY_API_FUNCTIONS.map((f) => f.replace(/\(.*$/, "")));
  for (const f of fns.rows) {
    for (const t of writeTargets(f.src)) {
      if (ledgerTables.has(t) && !writers.has(f.name)) problems.push(`ledger surface: ${f.name} writes ${t} (only ${[...writers].join(", ")} may)`);
    }
    if (/fleet\.ledger_(post|hash)/.test(f.src) && !writers.has(f.name) && !guardNames.has(f.name)) {
      problems.push(`ledger surface: ${f.name} references a ledger write guard`);
    }
    if (f.name.startsWith("cx_")) {
      const rule = Object.prototype.hasOwnProperty.call(CUSTODY_WRITES, f.name) ? CUSTODY_WRITES[f.name] : undefined;
      if (!cxNames.has(f.name) || !rule) {
        problems.push(`custody surface: unexpected function ${schema}.${normSig(f.sig)}`);
        continue;
      }
      const code = codeOf(f.src);
      if (/\bEXECUTE\b/i.test(code)) problems.push(`custody surface: ${f.name} uses dynamic SQL (EXECUTE)`);
      if (code.includes('"')) problems.push(`custody surface: ${f.name} uses a quoted identifier`);
      const allowedW = new Set(rule.writes);
      for (const t of writeTargets(f.src)) if (!allowedW.has(t)) problems.push(`custody surface: ${f.name} writes ${t} (not in its allow-list)`);
      const allowedC = new Set(rule.calls);
      for (const c of callsOf(f.src)) {
        if (c === f.name || !fleetNames.has(c)) {
          if (SIDE_EFFECT_BUILTINS.test(c)) problems.push(`custody surface: ${f.name} calls side-effecting ${c}`);
          continue;
        }
        if (volatileNames.has(c) && !allowedC.has(c)) problems.push(`custody surface: ${f.name} calls volatile ${c} (not in its allow-list)`);
      }
    }
  }
  const model = await db.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = $1 AND c.relname = 'fleet_economic_model' AND k.contype = 'c'
                       AND pg_get_constraintdef(k.oid) ~ 'NOT custody_execution_enabled') AS ok`,
    [schema],
  );
  if (!model.rows[0]?.ok) problems.push("custody surface: custody execution is not pinned off by a CHECK constraint (constitutional invariant)");
  // v48: custody execution is on only while it names an owner activation, and only the activation switch (behind its guard
  // trigger) changes it.
  const v48 = (await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'fleet_custody_activations'`, [schema])).rows[0]?.n;
  if (v48) {
    const act = await db.query<{ d: string }>(
      `SELECT pg_get_constraintdef(k.oid) AS d FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = 'fleet_economic_model' AND k.conname = 'fleet_economic_model_custody_activation'`, [schema]);
    if (!/NOT custody_execution_enabled/.test(act.rows[0]?.d ?? "") || !/custody_activation_id IS NOT NULL/.test(act.rows[0]?.d ?? "")) {
      problems.push("custody surface: custody execution is not bound to an owner activation (CHECK missing)");
    }
    for (const f of fns.rows) {
      if (/fleet\.custody_activation/.test(f.src) && !["fleet_custody_switch", "fleet_economic_model_custody_guard"].includes(f.name)) {
        problems.push(`custody surface: ${f.name} references the custody activation guard`);
      }
    }
  }
  const trig = await db.query<{ t: string }>(
    `SELECT c.relname || ':' || tg.tgname AS t FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND NOT tg.tgisinternal AND tg.tgenabled <> 'D'`,
    [schema],
  );
  const have = new Set(trig.rows.map((r) => r.t));
  for (const need of [
    "fleet_ledger_journal:fleet_ledger_journal_no_change",
    "fleet_ledger_journal:fleet_ledger_journal_no_truncate",
    "fleet_ledger_journal:fleet_ledger_journal_write_guard",
    "fleet_ledger_journal:fleet_ledger_journal_balanced",
    "fleet_ledger_postings:fleet_ledger_postings_no_change",
    "fleet_ledger_postings:fleet_ledger_postings_no_truncate",
    "fleet_ledger_postings:fleet_ledger_postings_write_guard",
    "fleet_ledger_postings:fleet_ledger_postings_rules",
    "fleet_ledger_postings:fleet_ledger_postings_balanced",
    "fleet_ledger_postings:fleet_ledger_postings_nonnegative",
    "fleet_ledger_head:fleet_ledger_head_guard",
    "fleet_payment_instructions:fleet_instructions_guard",
    "fleet_payment_orders:fleet_orders_guard",
    "fleet_payment_destinations:fleet_destinations_guard",
    ...(v48 ? ["fleet_economic_model:fleet_economic_model_custody_guard", "fleet_custody_activations:fleet_custody_activations_guard",
      "fleet_custody_activations:fleet_custody_activations_no_truncate"] : []),
  ]) {
    if (!have.has(need)) problems.push(`ledger surface: trigger ${need.replace(":", ".")} is missing or disabled`);
  }
  return [...new Set(problems)];
}

/**
 * Schema v11 Genesis / capability / reproduction invariants (only once v11 exists):
 *  - only the Genesis operator helpers and guards mention the fleet.genesis_op
 *    guard, so nothing else can create or advance a founder or edit a Genesis;
 *  - reproduction execution and reseeding are pinned off by CHECK constraints;
 *  - the Genesis, founder, origin, capability, knowledge and death-freeze
 *    triggers exist and are enabled;
 *  - the constitutional capability exclusions are not grantable (when readable).
 */
export async function genesisSurfaceProblems(db: Queryable, schema: string): Promise<string[]> {
  const problems: string[] = [];
  const present = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'fleet_genesis'`,
    [schema],
  );
  if (!present.rows[0]?.n) return problems;
  const fns = await db.query<{ name: string; src: string }>(
    `SELECT p.proname AS name, p.prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1`,
    [schema],
  );
  const allowed = new Set([...GENESIS_OPERATORS, ...GENESIS_GUARDS]);
  for (const f of fns.rows) {
    if (/fleet\.genesis_op/.test(f.src) && !allowed.has(f.name)) problems.push(`genesis surface: ${f.name} references the Genesis operation guard`);
  }
  const pins = await db.query<{ t: string }>(
    `SELECT c.relname || ':' || pg_get_constraintdef(k.oid) AS t FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND k.contype = 'c'
        AND c.relname IN ('fleet_reproduction_policy','fleet_genesis_policy')`,
    [schema],
  );
  const pinText = pins.rows.map((r) => r.t).join("\n");
  if (!/fleet_reproduction_policy:CHECK \(\(NOT execution_enabled\)\)/.test(pinText)) problems.push("genesis surface: reproduction execution is not pinned off by a CHECK constraint");
  if (!/fleet_genesis_policy:CHECK \(\(NOT refounding_enabled\)\)/.test(pinText)) problems.push("genesis surface: reseeding is not pinned off by a CHECK constraint");
  const trig = await db.query<{ t: string }>(
    `SELECT c.relname || ':' || tg.tgname AS t FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND NOT tg.tgisinternal AND tg.tgenabled <> 'D'`,
    [schema],
  );
  const have = new Set(trig.rows.map((r) => r.t));
  for (const need of [
    "fleet_agents:fleet_agents_origin_guard",
    "fleet_agents:fleet_agents_death_freeze",
    "fleet_genesis:fleet_genesis_guard",
    "fleet_genesis_founders:fleet_genesis_founders_guard",
    "fleet_capability_manifests:fleet_capability_manifests_guard",
    "fleet_capability_classes:fleet_capability_classes_no_change",
    "fleet_payment_orders:fleet_orders_capability_gate",
    "fleet_knowledge_entries:fleet_knowledge_entries_guard",
    "fleet_knowledge_proposals:fleet_knowledge_proposals_guard",
  ]) {
    if (!have.has(need)) problems.push(`genesis surface: trigger ${need.replace(":", ".")} is missing or disabled`);
  }
  // v19: the single-founder Genesis guard (every new Genesis row within genesis_max_founders).
  const v19 = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'fleet_genesis_policy' AND column_name = 'genesis_max_founders'`, [schema]);
  if (v19.rows.length > 0 && !have.has("fleet_genesis:fleet_genesis_founder_count")) problems.push("genesis surface: trigger fleet_genesis.fleet_genesis_founder_count is missing or disabled");
  const canRead = await db.query<{ ok: boolean }>(`SELECT has_table_privilege(current_user, $1, 'SELECT') AS ok`, [`${schemaIdent(schema)}.fleet_capability_classes`]);
  if (canRead.rows[0]?.ok) {
    const cls = await db.query<{ class: string; grantable: boolean }>(`SELECT class, grantable FROM ${schemaIdent(schema)}.fleet_capability_classes`);
    for (const c of ["reproduction", "custody.payment_execution", "self_modification", "tool.discovery", "compute.provisioning"]) {
      const row = cls.rows.find((r) => r.class === c);
      if (!row || row.grantable) problems.push(`genesis surface: capability ${c} must exist and not be grantable`);
    }
  }
  return [...new Set(problems)];
}

/**
 * Schema v13 founder-cognition invariants (only once v13 exists):
 *  - cognition cannot be enabled without a provider (CHECK constraint);
 *  - the trusted inference log is append-only (row and TRUNCATE triggers), the
 *    policy/switch rows cannot be deleted, and death/quarantine stops cognition;
 *  - only svc_cognition_record writes the log and only the owner functions (and
 *    the lifecycle trigger) write the switches.
 */
export async function cognitionSurfaceProblems(db: Queryable, schema: string): Promise<string[]> {
  const problems: string[] = [];
  const present = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'fleet_cognition_log'`,
    [schema],
  );
  if (!present.rows[0]?.n) return problems;
  const checks = await db.query<{ t: string }>(
    `SELECT pg_get_constraintdef(k.oid) AS t FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = 'fleet_cognition_policy' AND k.contype = 'c'`,
    [schema],
  );
  if (!checks.rows.some((r) => /NOT cognition_enabled\) OR \(provider <> 'none'/.test(r.t))) problems.push("cognition surface: cognition can be enabled without a provider (CHECK missing)");
  const trig = await db.query<{ t: string }>(
    `SELECT c.relname || ':' || tg.tgname AS t FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND NOT tg.tgisinternal AND tg.tgenabled <> 'D'`,
    [schema],
  );
  const have = new Set(trig.rows.map((r) => r.t));
  for (const need of [
    "fleet_cognition_log:fleet_cognition_log_no_change",
    "fleet_cognition_log:fleet_cognition_log_no_truncate",
    "fleet_cognition_policy:fleet_cognition_policy_no_delete",
    "fleet_founder_cognition:fleet_founder_cognition_no_delete",
    "fleet_agents:fleet_agents_cognition_stop",
    "fleet_cognition_accrual:fleet_cognition_accrual_no_delete",
    "fleet_research_attempts:fleet_research_attempts_no_change",
    "fleet_research_attempts:fleet_research_attempts_no_truncate",
    "fleet_research_results:fleet_research_results_no_change",
    "fleet_research_results:fleet_research_results_no_truncate",
  ]) {
    if (!have.has(need)) problems.push(`cognition surface: trigger ${need.replace(":", ".")} is missing or disabled`);
  }
  // v21: FX rates and native-USD provider credit are append-only (only when those tables exist).
  const v21 = (await db.query(`SELECT 1 FROM pg_tables WHERE schemaname = $1 AND tablename = 'fleet_fx_rates'`, [schema])).rows.length > 0;
  for (const need of v21 ? [
    "fleet_fx_rates:fleet_fx_rates_no_change", "fleet_fx_rates:fleet_fx_rates_no_truncate",
    "fleet_provider_credit_events:fleet_provider_credit_events_no_change", "fleet_provider_credit_events:fleet_provider_credit_events_no_truncate",
    "fleet_ledger_accounts:fleet_ledger_accounts_currency", "fleet_economic_model:fleet_economic_model_currency_guard",
  ] : []) {
    if (!have.has(need)) problems.push(`cognition surface: trigger ${need.replace(":", ".")} is missing or disabled`);
  }
  // v22: routing policy rows cannot be deleted; the action-minimum table and action links are append-only.
  const v22 = (await db.query(`SELECT 1 FROM pg_tables WHERE schemaname = $1 AND tablename = 'fleet_cognition_tiers'`, [schema])).rows.length > 0;
  for (const need of v22 ? [
    "fleet_cognition_routing:fleet_cognition_routing_no_delete", "fleet_cognition_tiers:fleet_cognition_tiers_no_delete",
    "fleet_action_min_tier:fleet_action_min_tier_no_change", "fleet_action_min_tier:fleet_action_min_tier_no_truncate",
    "fleet_action_cognition_links:fleet_action_cognition_links_no_change", "fleet_action_cognition_links:fleet_action_cognition_links_no_truncate",
  ] : []) {
    if (!have.has(need)) problems.push(`cognition surface: trigger ${need.replace(":", ".")} is missing or disabled`);
  }
  // v23: the runtime-upgrade history is append-only and guarded; a founder's registered runtime moves only inside it.
  const v23 = (await db.query(`SELECT 1 FROM pg_tables WHERE schemaname = $1 AND tablename = 'fleet_founder_runtime_upgrades'`, [schema])).rows.length > 0;
  for (const need of v23 ? [
    "fleet_founder_runtime_upgrades:fleet_founder_runtime_upgrades_guard", "fleet_founder_runtime_upgrades:fleet_founder_runtime_upgrades_no_delete",
    "fleet_founder_runtime_upgrades:fleet_founder_runtime_upgrades_no_truncate", "fleet_agents:fleet_agents_founder_runtime_guard",
  ] : []) {
    if (!have.has(need)) problems.push(`founder runtime upgrade: trigger ${need.replace(":", ".")} is missing or disabled`);
  }
  // v24: the experiment pipeline's history is append-only, changes only inside experiment operations, and is financially inert.
  const v24 = (await db.query(`SELECT 1 FROM pg_tables WHERE schemaname = $1 AND tablename = 'fleet_experiments'`, [schema])).rows.length > 0;
  for (const need of v24 ? [
    "fleet_experiments:fleet_experiments_guard", "fleet_experiments:fleet_experiments_no_delete", "fleet_experiments:fleet_experiments_no_truncate",
    "fleet_experiment_transitions:fleet_experiment_transitions_guard", "fleet_experiment_transitions:fleet_experiment_transitions_no_change",
    "fleet_experiment_events:fleet_experiment_events_guard", "fleet_experiment_events:fleet_experiment_events_no_change",
    "fleet_experiment_results:fleet_experiment_results_guard", "fleet_experiment_results:fleet_experiment_results_no_change",
    "fleet_strategy_registry:fleet_strategy_registry_guard", "fleet_strategy_registry:fleet_strategy_registry_no_change",
    "fleet_experiment_policy:fleet_experiment_policy_no_delete", "fleet_evidence_ladder:fleet_evidence_ladder_no_delete",
    "fleet_experiment_relevance:fleet_experiment_relevance_guard", "fleet_experiment_relevance:fleet_experiment_relevance_no_change",
    "fleet_opportunity_revenue_attributions:fleet_opportunity_revenue_guard", "fleet_opportunity_revenue_attributions:fleet_opportunity_revenue_no_change",
    "fleet_relevance_calls:fleet_relevance_calls_guard", "fleet_relevance_calls:fleet_relevance_calls_no_change",
    "fleet_research_evidence_artifacts:fleet_research_evidence_artifacts_guard", "fleet_research_evidence_artifacts:fleet_research_evidence_artifacts_no_change",
  ] : []) {
    if (!have.has(need)) problems.push(`experiment pipeline: trigger ${need.replace(":", ".")} is missing or disabled`);
  }
  if (v24) {
    const ck = await db.query<{ t: string }>(
      `SELECT c.relname || ':' || pg_get_constraintdef(k.oid) AS t FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND k.contype = 'c' AND c.relname IN ('fleet_experiment_policy','fleet_experiment_results','fleet_strategy_registry','fleet_evidence_ladder')`, [schema]);
    for (const t of ["fleet_experiment_policy", "fleet_experiment_results", "fleet_strategy_registry"]) {
      if (!ck.rows.some((r) => r.t.startsWith(`${t}:`) && /financial_mode = 'simulated'/.test(r.t))) problems.push(`experiment pipeline: ${t} is not pinned to simulated money (CHECK missing)`);
    }
    for (const t of ["fleet_experiment_results", "fleet_strategy_registry"]) {
      if (!ck.rows.some((r) => r.t.startsWith(`${t}:`) && /roi_authority = 'simulated_non_authoritative'/.test(r.t))) problems.push(`experiment pipeline: ${t} ROI is not pinned non-authoritative (CHECK missing)`);
    }
    if (!ck.rows.some((r) => r.t.startsWith("fleet_evidence_ladder:") && /cap_scope = 'simulation_only'/.test(r.t))) problems.push("experiment pipeline: ladder caps are not pinned simulation-only (CHECK missing)");
    const money = await db.query<{ name: string }>(
      `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND (p.proname LIKE '%experiment%' OR p.proname LIKE '%evidence_ladder%')
          AND p.prosrc ~* '(fleet_ledger_post\\s*\\(|fleet_payment_orders|fleet_payment_instructions|fleet_order_reserve|fleet_order_release|fleet_admin_)'`, [schema]);
    for (const r of money.rows) problems.push(`experiment pipeline: ${r.name} touches ledger postings or payment orders (R24 is financially inert)`);
    // Simulated ROI (founder-reported spend) is recorded and reported, never read by a decision: only these may name it.
    const roiReaders = new Set(["fleet_experiment_conclude_internal", "fleet_experiment_json", "api_experiment_list"]);
    const roi = await db.query<{ name: string }>(
      `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.prosrc ~* 'simulated_roi'`, [schema]);
    for (const r of roi.rows) if (!roiReaders.has(r.name)) problems.push(`experiment pipeline: ${r.name} reads simulated (non-authoritative) ROI`);
  }
  // v26 (F2-A): dependency records are guarded and never deleted; an OPEN record is always an action-scoped exception
  // (never an ordinary business decision waiting on the owner).
  const v26 = (await db.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'fleet_owner_requests' AND column_name = 'blocks_action'`, [schema])).rows.length > 0;
  for (const need of v26 ? ["fleet_owner_requests:fleet_owner_requests_guard", "fleet_owner_requests:fleet_owner_requests_no_truncate"] : []) {
    if (!have.has(need)) problems.push(`autonomy: trigger ${need.replace(":", ".")} is missing or disabled`);
  }
  if (v26) {
    const ck = await db.query<{ t: string }>(
      `SELECT pg_get_constraintdef(k.oid) AS t FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = 'fleet_owner_requests' AND k.conname = 'fleet_owner_requests_open_is_exception'`, [schema]);
    if (!ck.rows.length) problems.push("autonomy: an open dependency could be an ordinary owner decision (CHECK missing)");
  }
  // v27 (F2-A): own-capital spend never waits on the owner; the circuit breaker is infrastructure with relative signals only.
  const v27 = (await db.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'fleet_spend_circuit_breaker'`, [schema])).rows.length > 0;
  for (const need of v27 ? ["fleet_spend_circuit_breaker:fleet_spend_circuit_breaker_no_delete", "fleet_spend_circuit_breaker:fleet_spend_circuit_breaker_no_truncate"] : []) {
    if (!have.has(need)) problems.push(`own capital: trigger ${need.replace(":", ".")} is missing or disabled`);
  }
  if (v27) {
    const ck = await db.query<{ t: string }>(
      `SELECT pg_get_constraintdef(k.oid) AS t FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = 'fleet_payment_orders' AND k.conname = 'fleet_payment_orders_no_owner_route'`, [schema]);
    if (!ck.rows.length) problems.push("own capital: a spend order could wait on the owner (CHECK fleet_payment_orders_no_owner_route missing)");
    const cols = await db.query<{ c: string }>(
      `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'fleet_spend_circuit_breaker'`, [schema]);
    for (const r of cols.rows) {
      if (/cents|minor|amount|gbp|usd/i.test(r.c)) problems.push(`own capital: circuit breaker column ${r.c} looks like a nominal amount (relative signals only)`);
    }
  }
  if (v23) {
    const ck = await db.query<{ t: string }>(
      `SELECT pg_get_constraintdef(k.oid) AS t FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = 'fleet_cognition_tiers' AND k.conname = 'fleet_cognition_tiers_t1_no_cache'`, [schema]);
    if (!ck.rows.length) problems.push("cognition surface: T1 prompt caching is not constrained off (CHECK missing)");
  }
  if (v22) {
    const ck = await db.query<{ t: string }>(
      `SELECT pg_get_constraintdef(k.oid) AS t FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = 'fleet_cognition_tiers' AND k.contype = 'c'`, [schema]);
    if (!ck.rows.some((r) => /NOT enabled\) OR \(verified_at IS NOT NULL/.test(r.t))) problems.push("cognition surface: a tier can be enabled without verification (CHECK missing)");
  }
  const fns = await db.query<{ name: string; src: string }>(
    `SELECT p.proname AS name, p.prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1`,
    [schema],
  );
  const writers: Record<string, Set<string>> = {
    fleet_cognition_log: new Set(["svc_cognition_record", "svc_cognition_routed_record"]),
    fleet_cognition_policy: new Set(["fleet_cognition_set_policy"]),
    fleet_founder_cognition: new Set(["fleet_founder_cognition_set", "fleet_agents_cognition_stop"]),
    fleet_cognition_accrual: new Set(["svc_cognition_record", "svc_cognition_routed_record"]),
    // v22 routing: policy data only through the owner functions; action links only through the boundary check.
    fleet_cognition_routing: new Set(["fleet_cognition_routing_set"]),
    fleet_cognition_tiers: new Set(["fleet_cognition_tier_set", "fleet_cognition_tier_verify", "fleet_cognition_tier_enable", "fleet_cognition_tier_cache_set"]),
    // v23: a living founder's runtime-upgrade history only through the lifecycle functions.
    // v24: experiments change only through the experiment functions (founder API, controller reaper, owner decisions).
    fleet_experiments: new Set(["api_experiment_propose", "api_experiment_add_evidence", "api_experiment_start", "api_experiment_record", "svc_experiment_reap",
      "fleet_experiment_apply", "fleet_experiment_conclude_internal", "fleet_experiment_decide", "fleet_experiment_assess_relevance", "svc_experiment_relevance_record"]),
    fleet_experiment_relevance: new Set(["svc_experiment_relevance_record", "fleet_experiment_assess_relevance"]),
    fleet_research_evidence_artifacts: new Set(["svc_research_artifact_record"]),
    fleet_relevance_calls: new Set(["svc_experiment_relevance_record", "svc_relevance_call_failed"]),
    fleet_opportunity_revenue_attributions: new Set(["fleet_experiment_attribute_revenue"]),
    fleet_experiment_results: new Set(["fleet_experiment_conclude_internal"]),
    fleet_strategy_registry: new Set(["fleet_experiment_conclude_internal"]),
    fleet_experiment_transitions: new Set(["fleet_experiment_transition"]),
    fleet_experiment_events: new Set(["api_experiment_add_evidence", "api_experiment_record", "fleet_experiment_observe"]),
    fleet_experiment_policy: new Set(["fleet_experiment_policy_set"]),
    fleet_evidence_ladder: new Set(["fleet_evidence_ladder_set"]),
    fleet_founder_runtime_upgrades: new Set(["fleet_founder_runtime_upgrade_prepare", "fleet_founder_runtime_upgrade_commit", "fleet_founder_runtime_upgrade_verify",
      "fleet_founder_runtime_upgrade_rollback", "fleet_founder_runtime_upgrade_rollback_verify", "fleet_founder_runtime_upgrade_abort"]),
    fleet_founder_routing: new Set(["fleet_founder_routing_set"]),
    fleet_action_cognition_links: new Set(["svc_action_cognition_verify", "svc_action_cognition_verify_ctx"]),
    // v18 research: only the controller functions write the audit; only the owner functions write the switches.
    fleet_research_attempts: new Set(["svc_research_authorize"]),
    fleet_research_refusals_suppressed: new Set(["svc_research_authorize"]),
    fleet_research_results: new Set(["svc_research_record"]),
    fleet_research_policy: new Set(["fleet_research_set_policy"]),
    fleet_founder_research: new Set(["fleet_founder_research_set"]),
    // v21: rates only through the validated insert; provider credit only through the owner recorder and inference recording.
    fleet_fx_rates: new Set(["fleet_fx_insert"]),
    fleet_provider_credit_events: new Set(["fleet_provider_credits_record", "svc_cognition_record", "svc_cognition_routed_record", "svc_experiment_relevance_record", "svc_relevance_call_failed", "fleet_relevance_call_reconcile"]),
    // v25/v26: dependency records only through the founder API and the owner's resolve/import.
    fleet_owner_requests: new Set(["api_owner_request_create", "api_owner_request_withdraw", "fleet_owner_request_decide", "fleet_owner_request_import",
      // v29: PAYMENT_RAIL_REQUIRED records ONE action-scoped kyc dependency (and answers it when a rail is connected).
      "fleet_rail_resolve",
      // v36: a number provider's account-holder identity step records ONE action-scoped human_identity dependency.
      "ix_phone_status",
      // v37: an agent marking its own account human_action_required (CAPTCHA, liveness) records ONE dependency for it.
      "fleet_account_human_dependency",
      // v34: a provider needing a non-delegable human identity act records ONE action-scoped dependency for that account.
      "ix_report_job",
      // v46: a rail answers a dependency only with its evidenced readiness, and keeps unverified holder identity open as
      // its own dependency; a legacy request is answered only from a verified, assigned capability.
      "fleet_rail_requirement_assign", "fleet_rail_identity_dependency", "fleet_admin_dependency_answer_from_capability"]),
    // v27: the spend circuit breaker only through the owner's infrastructure control.
    fleet_spend_circuit_breaker: new Set(["fleet_admin_spend_circuit_breaker", "fleet_admin_spend_circuit_breaker_novelty"]),
  };
  for (const f of fns.rows) {
    for (const t of writeTargets(f.src)) {
      if (writers[t] && !writers[t].has(f.name)) problems.push(`cognition surface: ${f.name} writes a cognition control table`);
    }
    // Dynamic SQL naming a cognition table would hide its writes from the check above.
    if (/\bEXECUTE\b/i.test(codeOf(f.src)) && /fleet_(cognition_log|cognition_policy|founder_cognition|cognition_accrual|research_[a-z_]+|founder_research|cognition_routing|cognition_tiers|founder_routing|action_cognition_links|action_min_tier)\b/i.test(f.src)) {
      problems.push(`cognition surface: ${f.name} uses dynamic SQL near a cognition control table`);
    }
  }
  return [...new Set(problems)];
}

function schemaIdent(schema: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`Invalid fleet schema name: ${schema}`);
  return `"${schema}"`;
}

/** Problems that concern only the given roles (plus PUBLIC); used by the service's startup self-check. */
export function problemsFor(result: PrivilegeAuditResult, roles: string[]): string[] {
  return result.problems.filter((p) => p.startsWith("PUBLIC") || roles.some((r) => p.startsWith(`${r} `) || p.startsWith(`role ${r} `)) || p.includes(" is not SECURITY DEFINER") || p.includes(" does not pin search_path"));
}

/**
 * Schema v28–v30 (F2) economy invariants (only once the economy tables exist):
 *  - the guard / append-only / no-delete triggers of the economic records, money tables and policies are present and
 *    enabled;
 *  - real money is constitutionally off here: no payment rail can be live (CHECK), and every capital decision is the
 *    controller's (CHECK), never the owner's or the agent's;
 *  - each money / record / policy table is written only by its named functions (no other function can attribute money,
 *    settle a transaction, move an envelope, change a rail or a credential, or move a venture's state);
 *  - the state-machine and vendor-registry bypass settings are referenced only by their single owner functions;
 *  - no economy function uses dynamic SQL near those tables.
 */
export async function economySurfaceProblems(db: Queryable, schema: string): Promise<string[]> {
  const problems: string[] = [];
  const has = async (t: string) => (await db.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`, [schema, t])).rows.length > 0;
  if (!(await has("fleet_ventures"))) return problems;
  const v29 = await has("fleet_payment_rails");
  const v30 = await has("fleet_envelopes");
  const v42 = await has("fleet_projects");
  const v46 = await has("fleet_rail_capability_checks");
  const v47 = await has("fleet_settlement_receipts");
  const trig = await db.query<{ t: string }>(
    `SELECT c.relname || ':' || tg.tgname AS t FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND NOT tg.tgisinternal AND tg.tgenabled <> 'D'`, [schema]);
  const have = new Set(trig.rows.map((r) => r.t));
  const need = [
    "fleet_ventures:fleet_ventures_guard", "fleet_ventures:fleet_ventures_no_delete", "fleet_venture_transitions:fleet_venture_transitions_no_change",
    "fleet_venture_transition_rules:fleet_venture_transition_rules_no_change", "fleet_venture_journals:fleet_venture_journals_guard",
    "fleet_venture_journals:fleet_venture_journals_no_change", "fleet_decision_records:fleet_decision_records_guard", "fleet_opportunities:fleet_opportunities_guard",
    "fleet_economic_knowledge:fleet_economic_knowledge_guard", "fleet_economy_policy:fleet_economy_policy_no_delete",
    ...(v29 ? ["fleet_payment_rails:fleet_payment_rails_guard", "fleet_payment_rails:fleet_payment_rails_no_delete", "fleet_external_transactions:fleet_external_transactions_guard",
      "fleet_external_transactions:fleet_external_transactions_no_delete", "fleet_credential_refs:fleet_credential_refs_guard", "fleet_credential_use_log:fleet_credential_use_log_no_change",
      "fleet_tax_profiles:fleet_tax_profiles_no_change", "fleet_legal_entities:fleet_legal_entities_guard", "fleet_vendor_destinations:fleet_vendor_destinations_no_delete",
      "fleet_rail_assignments:fleet_rail_assignments_no_delete", "fleet_tax_policy:fleet_tax_policy_no_delete", "fleet_transfer_policy:fleet_transfer_policy_no_delete"] : []),
    ...(v30 ? ["fleet_envelopes:fleet_envelopes_guard", "fleet_envelopes:fleet_envelopes_no_delete", "fleet_capital_decisions:fleet_capital_decisions_no_change",
      "fleet_capital_requests:fleet_capital_requests_no_change", "fleet_payment_orders:fleet_orders_funding_guard", "fleet_capital_policy:fleet_capital_policy_no_delete",
      "fleet_sweep_policy:fleet_sweep_policy_no_delete", "fleet_cognition_depth_policy:fleet_cognition_depth_policy_no_delete"] : []),
    ...(v42 ? ["fleet_projects:fleet_projects_guard", "fleet_projects:fleet_projects_no_delete", "fleet_project_members:fleet_project_members_guard",
      "fleet_project_members:fleet_project_members_no_delete", "fleet_project_payments:fleet_project_payments_no_change",
      "fleet_project_events:fleet_project_events_no_change", "fleet_project_outcomes:fleet_project_outcomes_no_change",
      "fleet_project_distributions:fleet_project_distributions_no_change", "fleet_sweep_records:fleet_sweep_records_no_change"] : []),
    ...(v46 ? ["fleet_rail_capability_checks:fleet_rail_capability_checks_no_change", "fleet_rail_capability_checks:fleet_rail_capability_checks_no_truncate",
      "fleet_revenue_claims:fleet_revenue_claims_no_change", "fleet_revenue_claims:fleet_revenue_claims_no_truncate",
      "fleet_payment_rails:fleet_payment_rails_simulation_guard"] : []),
    ...(v47 ? ["fleet_provider_accounts:fleet_provider_accounts_no_change", "fleet_provider_product_attributions:fleet_provider_product_attributions_no_change",
      "fleet_provider_product_attributions:fleet_provider_product_attributions_guard", "fleet_provider_sales:fleet_provider_sales_guard",
      "fleet_provider_sales:fleet_provider_sales_no_delete", "fleet_provider_payouts:fleet_provider_payouts_guard", "fleet_provider_payouts:fleet_provider_payouts_no_delete",
      "fleet_provider_payout_lines:fleet_provider_payout_lines_no_change", "fleet_settlement_destinations:fleet_settlement_destinations_guard",
      "fleet_settlement_destinations:fleet_settlement_destinations_no_delete", "fleet_settlement_receipts:fleet_settlement_receipts_guard",
      "fleet_settlement_receipts:fleet_settlement_receipts_no_delete", "fleet_provider_allocations:fleet_provider_allocations_no_change",
      "fleet_pilot_authorisations:fleet_pilot_authorisations_no_delete"] : []),
  ];
  for (const t of need) if (!have.has(t)) problems.push(`economy surface: trigger ${t.replace(":", ".")} is missing or disabled`);
  const checks = await db.query<{ n: string; d: string }>(
    `SELECT k.conname AS n, pg_get_constraintdef(k.oid) AS d FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace s ON s.oid = c.relnamespace
      WHERE s.nspname = $1 AND k.contype = 'c' AND c.relname IN ('fleet_payment_rails','fleet_capital_decisions','fleet_credential_refs')`, [schema]);
  const v48 = await has("fleet_custody_activations");
  if (v29 && !v48 && !checks.rows.some((r) => r.n === "fleet_payment_rails_not_live" && /mode <> 'live'/.test(r.d))) {
    problems.push("economy surface: a payment rail could be live (the not-live CHECK is missing) — real payments are constitutionally off");
  }
  if (v48) {
    // v48: a live rail is only the owner's PayPal treasury, with a credential, receiving / refunding / paying out — never a
    // card, storefront or bank-transfer capability.
    const live = checks.rows.find((r) => r.n === "fleet_payment_rails_live_scope")?.d ?? "";
    if (!/mode <> 'live'/.test(live) || !/'paypal'/.test(live) || !/credential_id IS NOT NULL/.test(live) || /card_spend|bank_transfer|storefront|marketplace/.test(live)) {
      problems.push("economy surface: the live rail scope CHECK is missing or allows more than the PayPal treasury capabilities");
    }
  }
  if (v46) {
    // v46: the receive-only mode is its own pinned capability — one provider, receiving capabilities only — and a gumroad
    // credential never carries more than the gateway's scopes; a registry with such a rail never allows simulated settlement.
    const scope = checks.rows.find((r) => r.n === "fleet_payment_rails_live_receive_scope")?.d ?? "";
    if (!/live_receive/.test(scope) || !/gumroad/.test(scope) || !/storefront/.test(scope) || /payouts|refunds|card_spend|bank_transfer/.test(scope)) {
      problems.push("economy surface: the receive-only rail scope CHECK is missing or allows an outgoing capability");
    }
    const cred = checks.rows.find((r) => r.n === "fleet_credential_refs_gumroad_scope")?.d ?? "";
    if (!/gumroad/.test(cred) || !/view_sales/.test(cred) || /edit_sales|refund_sales|account/.test(cred)) {
      problems.push("economy surface: the gumroad credential scope CHECK is missing or allows more than the receive-only scopes");
    }
    const sim = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${schema}.fleet_payment_rails WHERE mode IN ('live_receive','live') AND status <> 'revoked'
          AND (SELECT simulated_settlement_allowed FROM ${schema}.fleet_economic_model WHERE id = 1)`);
    if (Number(sim.rows[0]?.n ?? 0) > 0) problems.push("economy surface: simulated settlement is allowed on a registry with a receive-only provider rail or a live rail");
  }
  if (v30 && !checks.rows.some((r) => /decided_by = 'controller'/.test(r.d))) problems.push("economy surface: a capital decision could be made by someone other than the controller (CHECK missing)");
  const writers: Record<string, Set<string>> = {
    fleet_ventures: new Set(["fleet_econ_venture_create", "fleet_econ_venture_transition", "fleet_venture_move"]),
    fleet_venture_transitions: new Set(["fleet_econ_venture_create", "fleet_venture_move"]),
    fleet_venture_journals: new Set(["fleet_admin_venture_attribute", "fleet_settlement_post", "cx_report_result", "cx_paypal_capture_record", "cx_paypal_refund_record"]),
    fleet_decision_records: new Set(["fleet_econ_decision_record", "fleet_econ_decision_outcome", "fleet_econ_decision_correct"]),
    fleet_opportunities: new Set(["fleet_econ_opportunity_record", "fleet_econ_opportunity_shortlist", "fleet_econ_opportunity_status", "fleet_opportunity_expire", "fleet_econ_venture_create"]),
    fleet_economic_knowledge: new Set(["fleet_econ_knowledge_record", "fleet_econ_decision_outcome", "fleet_project_finish"]),
    fleet_economy_policy: new Set(["fleet_admin_economy_policy_set"]),
    fleet_payment_rails: new Set(["fleet_admin_rail_add", "fleet_admin_rail_set_status", "fleet_admin_credential_set_status", "fleet_settlement_post",
      "fleet_admin_rail_webhook_set"]),
    fleet_rail_assignments: new Set(["fleet_rail_resolve", "fleet_admin_rail_set_status", "fleet_admin_rail_assign"]),
    fleet_rail_requirements: new Set(["fleet_rail_resolve", "fleet_econ_rail_require", "fleet_rail_requirement_assign"]),
    // v46: readiness evidence only by the owner (and simulated evidence for a simulated rail at registration); external
    // settlement claims only by the claiming recorder.
    fleet_rail_capability_checks: new Set(["fleet_admin_rail_add", "fleet_admin_rail_verify"]),
    fleet_revenue_claims: new Set(["fleet_admin_record_external_claimed",
      // v47: the posting transaction claims the payout and the bank transaction; a linked transfer claims the original.
      "fleet_provider_receipt_post", "fleet_receipt_process", "fleet_admin_receipt_transfer_link",
      // v48: PayPal captures and refunds, and money paid to the owner's card.
      "cx_paypal_capture_record", "cx_paypal_refund_record", "fleet_admin_card_receipt_record"]),
    // v47: provider records only through their recorders (the G3 gateway / G4 bank feed call them via their roles),
    // attribution and destinations only by the owner, allocations only by the posting functions.
    fleet_provider_accounts: new Set(["fleet_admin_provider_account_register"]),
    fleet_provider_product_attributions: new Set(["fleet_admin_provider_product_assign"]),
    fleet_provider_sales: new Set(["fleet_provider_sale_record"]),
    fleet_provider_payouts: new Set(["fleet_provider_payout_record"]),
    fleet_provider_payout_lines: new Set(["fleet_provider_payout_record"]),
    fleet_settlement_destinations: new Set(["fleet_admin_settlement_destination_add", "fleet_admin_settlement_destination_verify_access"]),
    fleet_settlement_receipts: new Set(["fleet_bank_receipt_record", "fleet_receipt_process", "fleet_provider_receipt_post", "fleet_admin_receipt_attest",
      "fleet_admin_receipt_transfer_link"]),
    fleet_provider_allocations: new Set(["fleet_provider_post_share", "fleet_provider_post_suspense", "fleet_provider_receipt_post",
      "fleet_admin_provider_suspense_release", "fleet_admin_receipt_debit_assign"]),
    fleet_pilot_authorisations: new Set(["fleet_admin_pilot_authorise", "fleet_admin_pilot_revoke"]),
    fleet_external_transactions: new Set(["svc_settlement_ingest", "fleet_settlement_post"]),
    fleet_credential_refs: new Set(["fleet_admin_credential_register", "fleet_admin_credential_set_status", "svc_credential_use", "cx_credential_use"]),
    fleet_credential_use_log: new Set(["svc_credential_use", "cx_credential_use"]),
    fleet_legal_entities: new Set(["fleet_admin_legal_entity_add"]),
    fleet_tax_profiles: new Set(["fleet_admin_tax_profile_set"]),
    fleet_tax_policy: new Set(["fleet_admin_tax_policy_set"]),
    fleet_transfer_policy: new Set(["fleet_admin_transfer_policy_set"]),
    fleet_vendor_destinations: new Set(["fleet_econ_vendor_register"]),
    fleet_destination_references: new Set(["fleet_econ_vendor_register", "fleet_admin_destination_reference_set"]),
    fleet_agent_wallet_plans: new Set(["fleet_econ_wallet_plan"]),
    fleet_capital_requests: new Set(["fleet_econ_capital_request"]),
    fleet_capital_decisions: new Set(["fleet_econ_capital_request"]),
    fleet_envelopes: new Set(["fleet_econ_capital_request", "fleet_envelope_allocate", "fleet_envelope_return", "fleet_envelope_evaluate"]),
    fleet_capital_policy: new Set(["fleet_admin_capital_policy_set"]),
    fleet_sweep_policy: new Set(["fleet_admin_sweep_policy_set"]),
    fleet_cognition_depth_policy: new Set(["fleet_admin_cognition_depth_set"]),
    fleet_admin_withdrawal_policy: new Set(["fleet_admin_withdrawal_policy_set"]),
    // v32: custody signer attestations (custody role only) and the attestation heartbeat policy (owner).
    fleet_custody_attestations: new Set(["cx_attest_signer"]),
    fleet_custody_policy: new Set(["fleet_admin_custody_policy_set"]),
    // v34: agent operational identity (agent ops), the broker protocol (ix_*), owner identity metadata/consent (owner).
    // (v35: an estate transfer re-owns an inherited identity/account/mailbox and queues the credential re-seal.)
    fleet_agent_identities: new Set(["fleet_econ_identity_create", "fleet_econ_identity_update", "fleet_estate_assign_internal"]),
    fleet_agent_accounts: new Set(["fleet_admin_account_freeze", "fleet_admin_account_unfreeze", "fleet_econ_account_create", "fleet_econ_mailbox_provision", "fleet_econ_account_revoke", "ix_claim_job",
      "ix_credential_record", "ix_mailbox_record", "ix_report_job", "fleet_estate_assign_internal",
      // v37: browser-created accounts (register / pin origins / record outcome) and broker-stored browser credentials.
      "fleet_econ_account_register", "fleet_econ_account_add_origin", "fleet_econ_account_mark", "fleet_account_human_dependency", "ix_browser_credential_record"]),
    fleet_agent_account_credentials: new Set(["fleet_econ_account_revoke", "ix_credential_record", "ix_browser_credential_record"]),
    fleet_agent_mailboxes: new Set(["ix_mailbox_record", "fleet_estate_assign_internal", "fleet_econ_mailbox_provision"]),
    fleet_identity_jobs: new Set(["fleet_identity_enqueue", "ix_claim_job", "ix_report_job", "fleet_estate_assign_internal", "svc_estate_tick"]),
    // v35: the economy engine. Replication state/birth orders only by the controller pass and Admin; missions by their
    // engine; commitments by the agent; notifications through fleet_notify; estate items by the estate engine.
    fleet_replication_state: new Set(["svc_replication_tick"]),
    fleet_replication_policy: new Set(["fleet_admin_replication_policy_set"]),
    fleet_birth_orders: new Set(["svc_replication_tick", "fleet_admin_birth", "fleet_admin_reseed", "fleet_admin_birth_fulfil", "fleet_admin_birth_cancel",
      "fleet_birth_authorize", "fleet_birth_born"]),
    fleet_mission_policy: new Set(["fleet_admin_mission_policy_set"]),
    fleet_mission_requests: new Set(["fleet_mission_start", "fleet_mission_end", "fleet_admin_mission_request", "fleet_econ_mission_request"]),
    fleet_agent_missions: new Set(["fleet_mission_start", "fleet_mission_end", "fleet_econ_mission_report", "fleet_econ_mission_review"]),
    fleet_agent_commitments: new Set(["fleet_econ_commitment_add", "fleet_econ_commitment_cancel", "fleet_estate_assign_internal", "svc_estate_tick",
      "ix_phone_record", "fleet_econ_phone_release",
      // v41: a number's rental commitment (created at provisioning, advanced when charged, cancelled at release, inherited).
      "ix_phone_record2", "fleet_phone_release_internal", "svc_comms_tick"]),
    fleet_risk_policy: new Set(["fleet_admin_risk_policy_set"]),
    fleet_notifications: new Set(["fleet_notify", "fleet_admin_notification_ack", "ix_notification_emailed", "fleet_admin_notifications_delete",
      "fleet_admin_notifications_delete_acknowledged"]),
    fleet_notification_policy: new Set(["fleet_admin_notification_policy_set", "svc_notify_tick"]),
    fleet_estate_items: new Set(["svc_estate_tick", "fleet_estate_assign_internal", "fleet_admin_estate_release"]),
    fleet_estate_policy: new Set([]),
    // v36: mail (agent send; broker delivery/status), phones/SMS (agent ops; broker provision/delivery/status), commitments
    // created for a number's monthly fee, owner vault installation, reveal serving/taking, notification email status.
    fleet_agent_mail: new Set(["ix_mail_deliver", "ix_mail_consumed", "ix_mail_deliver2", "ix_mail_sent", "fleet_econ_mail_send",
      // v41: shared-mailbox ingestion (attribution), outbound status, Admin routing of unassigned mail.
      "fleet_mail_store_in", "ix_mail_sent2", "fleet_admin_mail_assign"]),
    fleet_agent_phone_numbers: new Set(["fleet_econ_phone_provision", "fleet_econ_phone_release", "ix_phone_record", "ix_phone_status",
      "ix_phone_record2", "fleet_phone_release_internal", "svc_comms_tick"]),
    fleet_agent_sms: new Set(["fleet_econ_sms_send", "ix_sms_deliver", "ix_sms_sent", "ix_sms_cost", "svc_comms_tick"]),
    // v41: communications providers (the broker's configuration), capability dependencies, quotes, charges, number
    // dependencies, provider-secret names.
    fleet_comms_providers: new Set(["ix_comms_configure", "ix_comms_health"]),
    fleet_capability_demands: new Set(["fleet_comms_unavailable", "ix_comms_configure"]),
    fleet_phone_quotes: new Set(["fleet_econ_phone_quote", "ix_phone_quote_record"]),
    fleet_phone_charges: new Set(["fleet_comms_charge"]),
    fleet_phone_number_dependencies: new Set(["ix_browser_secret_serve"]),
    fleet_provider_secrets: new Set(["ix_provider_secrets_publish"]),
    fleet_owner_vault_inbox: new Set(["fleet_admin_owner_vault_upload", "ix_vault_installed"]),
    fleet_reveal_requests: new Set(["fleet_admin_reveal_request", "fleet_admin_reveal_take", "ix_reveal_pending", "ix_reveal_serve"]),
    fleet_reveal_log: new Set(["fleet_reveal_log_write"]),
    fleet_identity_broker_keys: new Set(["ix_publish_owner_key"]),
    // v37: the browser operator — sessions/actions by the agent ops and the worker (bx_*); credential requests by the worker,
    // served by the broker; authentication-message blobs by the broker only.
    fleet_browser_sessions: new Set(["fleet_econ_browser_open", "fleet_econ_browser_close", "fleet_browser_enqueue", "bx_report_action", "fleet_admin_account_freeze"]),
    fleet_browser_actions: new Set(["fleet_browser_enqueue", "bx_claim_action", "bx_report_action"]),
    fleet_browser_secret_requests: new Set(["bx_secret_request", "bx_secret_take", "ix_browser_secrets_pending", "ix_browser_secret_serve"]),
    fleet_auth_message_blobs: new Set(["ix_auth_blob_store", "ix_browser_secrets_pending", "ix_browser_secret_serve", "fleet_admin_mail_assign"]),
    // v38: Admin authentication state — written only by the dashboard gateway functions (and the owner's enrollment).
    fleet_admin_passkeys: new Set(["dash_passkey_add", "dash_passkey_used", "dash_passkey_revoke", "dash_passkey_rename"]),
    // v45: Fleet Command's bounded feed (copied from routed events; cleared by the owner) and the short-lived suppression
    // keys of deleted notifications.
    fleet_command_feed: new Set(["fleet_command_feed_capture", "fleet_admin_command_clear"]),
    fleet_notification_suppress: new Set(["fleet_notify", "fleet_admin_notifications_delete", "fleet_admin_notifications_delete_acknowledged", "svc_event_retention"]),
    // v43: the password verifier — written only by dash_password_set (enrollment token, or a session with a step-up).
    fleet_admin_password: new Set(["dash_password_set"]),
    fleet_admin_totp: new Set(["dash_totp_set", "dash_totp_accept", "dash_totp_reset", "fleet_admin_dashboard_totp_reset"]),
    fleet_admin_enrollment: new Set(["dash_passkey_add", "dash_password_set", "fleet_admin_dashboard_enroll"]),
    fleet_admin_challenges: new Set(["dash_challenge_new", "dash_challenge_use"]),
    fleet_admin_sessions: new Set(["dash_session_begin", "dash_session_begin_password", "dash_session_totp", "dash_session_live", "dash_session_end",
      "dash_sessions_revoke_all", "dash_password_set"]),
    fleet_admin_stepups: new Set(["dash_stepup_record", "dash_stepup_consume"]),
    fleet_admin_auth_log: new Set(["fleet_admin_auth_log_write"]),
    fleet_identity_releases: new Set(["ix_release_record"]),
    fleet_owner_identity_classes: new Set(["fleet_admin_owner_identity_class_set", "ix_vault_installed"]),
    fleet_owner_identity_consent: new Set(["fleet_admin_owner_identity_consent_set", "fleet_admin_owner_identity_consent_revoke"]),
    // v42: team projects — written only by the project operations and their settlement helpers (money moves only through
    // fleet_project_pay / fleet_project_release, both posting through fleet_ledger_post).
    fleet_projects: new Set(["fleet_econ_project_propose", "fleet_econ_project_replan", "fleet_econ_project_fund", "fleet_econ_project_start",
      "fleet_project_evaluate", "fleet_project_pay", "fleet_project_release", "fleet_project_finish"]),
    fleet_project_roles: new Set(["fleet_project_set_plan"]),
    fleet_project_tasks: new Set(["fleet_project_set_plan", "fleet_econ_project_task", "fleet_econ_project_review", "fleet_project_end_member", "fleet_project_finish"]),
    fleet_project_members: new Set(["fleet_econ_project_offer", "fleet_econ_project_respond", "fleet_econ_project_counter_accept", "fleet_econ_project_withdraw_offer",
      "fleet_econ_project_task", "fleet_econ_project_review", "fleet_project_pay", "fleet_project_pay_share", "fleet_project_distribute", "fleet_project_end_member",
      "fleet_project_finish"]),
    fleet_project_payments: new Set(["fleet_project_pay", "fleet_project_pay_share"]),
    fleet_project_distributions: new Set(["fleet_project_distribute"]),
    fleet_sweep_records: new Set(["fleet_sweep_execute"]),
    fleet_project_events: new Set(["fleet_project_event"]),
    fleet_project_outcomes: new Set(["fleet_project_finish"]),
    // v48: custody activations only by the owner functions and the reaper's expiry; wallet limits only by the owner; PayPal
    // records by the agent's checkout ops and the custody executor; card clearing only by the owner (and its booking helper).
    fleet_custody_activations: new Set(["fleet_admin_custody_activate", "fleet_admin_custody_deactivate", "svc_custody_activation_expire"]),
    fleet_agent_wallet_limits: new Set(["fleet_admin_wallet_limits_set"]),
    fleet_paypal_checkouts: new Set(["fleet_econ_paypal_checkout", "fleet_econ_paypal_cancel", "cx_paypal_work", "cx_paypal_checkout_update", "cx_paypal_capture_record"]),
    fleet_paypal_webhook_inbox: new Set(["svc_paypal_webhook_receive", "cx_paypal_inbox", "cx_paypal_inbox_result"]),
    fleet_paypal_transactions: new Set(["cx_paypal_txn_record", "fleet_admin_paypal_txn_attribute"]),
    fleet_paypal_balance_observations: new Set(["cx_paypal_balance_record"]),
    fleet_card_charges: new Set(["fleet_admin_card_charge_record", "fleet_admin_card_charge_confirm", "fleet_card_charge_post",
      "fleet_econ_card_authorize", "fleet_econ_card_void", "svc_card_holds_expire"]),
    fleet_card_repayments: new Set(["fleet_admin_card_repayment_record"]),
    fleet_card_receipts: new Set(["fleet_admin_card_receipt_record", "fleet_admin_card_receipt_resolve"]),
    // v49: the owner's standing authority and account freezes only by the owner; identity uses only by the worker's request
    // function; sealed custody credentials only by the owner, the custody key only by custody.
    fleet_identity_autonomy: new Set(["fleet_admin_identity_autonomy_set"]),
    fleet_identity_autonomy_history: new Set(["fleet_admin_identity_autonomy_set"]),
    fleet_identity_uses: new Set(["bx_secret_request"]),
    fleet_custody_sealed_credentials: new Set(["fleet_admin_custody_credential_upload", "fleet_admin_custody_credential_revoke"]),
    fleet_custody_keys: new Set(["cx_publish_key"]),
    // v50: insolvency episodes only by the reaper; sweep reductions by the owner functions and the reaper's expiry; the
    // knowledge library only by its loader.
    fleet_agent_insolvency: new Set(["svc_insolvency_tick"]),
    fleet_insolvency_policy: new Set(["fleet_admin_insolvency_policy_set"]),
    fleet_sweep_rate_reductions: new Set(["fleet_admin_sweep_reduction_grant", "fleet_admin_sweep_reduction_end", "svc_sweep_reductions_expire"]),
    fleet_sweep_rate_reduction_requests: new Set(["fleet_econ_sweep_reduction_request", "fleet_admin_sweep_reduction_grant", "fleet_admin_sweep_reduction_decline"]),
    fleet_knowledge_library: new Set(["fleet_admin_knowledge_library_load"]),
  };
  const fns = await db.query<{ name: string; src: string }>(
    `SELECT p.proname AS name, p.prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1`, [schema]);
  for (const f of fns.rows) {
    for (const t of writeTargets(f.src)) {
      if (writers[t] && !writers[t].has(f.name)) problems.push(`economy surface: ${f.name} writes ${t}`);
    }
    if (/fleet\.venture_move/.test(f.src) && !["fleet_venture_move", "fleet_ventures_guard"].includes(f.name)) problems.push(`economy surface: ${f.name} references the venture state-machine guard`);
    if (/fleet\.vendor_register/.test(f.src) && !["fleet_econ_vendor_register", "fleet_destinations_guard"].includes(f.name)) problems.push(`economy surface: ${f.name} references the vendor-registry guard`);
    if (/\bEXECUTE\b/i.test(codeOf(f.src)) && /fleet_(ventures|venture_journals|external_transactions|envelopes|capital_decisions|payment_rails|credential_refs|tax_profiles)\b/.test(f.src)) {
      problems.push(`economy surface: ${f.name} uses dynamic SQL near an economy table`);
    }
  }
  return [...new Set(problems)];
}
