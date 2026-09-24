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
 *   operator roles (schema v8) USAGE + EXECUTE on op_* only, no table privilege,
 *                  every function STABLE except op_begin_request
 *
 * Operator surface (schema v8, signature-termination invariant): op_begin_request
 * writes only the operator bookkeeping tables (+ denial events via fleet_event),
 * no read-side operator function calls a volatile function, and routes point
 * only at the read functions. See migrations-phase8.ts.
 */

import {
  AGENT_API_FUNCTIONS,
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
}

export const DEFAULT_AGENT_ROLES = ["fleet_agent", "fleet_agent_login"];
export const DEFAULT_SERVICE_ROLES = ["fleet_service", "fleet_service_login"];
export const DEFAULT_OPERATOR_ROLES = ["fleet_operator", "fleet_operator_login"];

type RoleKind = "agent" | "service" | "operator";

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
  const allRestricted = [...(opts.agentRoles ?? DEFAULT_AGENT_ROLES), ...(opts.serviceRoles ?? DEFAULT_SERVICE_ROLES), ...operatorRoles];
  const plan: Array<[string, RoleKind]> = [
    ...(opts.agentRoles ?? DEFAULT_AGENT_ROLES).map((r) => [r, "agent"] as [string, RoleKind]),
    ...(opts.serviceRoles ?? DEFAULT_SERVICE_ROLES).map((r) => [r, "service"] as [string, RoleKind]),
    ...operatorRoles.map((r) => [r, "operator"] as [string, RoleKind]),
  ];

  const agentFns = new Set(AGENT_API_FUNCTIONS.map(normSig));
  const serviceFns = new Set(SERVICE_API_FUNCTIONS.map(normSig));
  const operatorFns = new Set(OPERATOR_API_FUNCTIONS.map(normSig));
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
    const allowed = kind === "agent" ? agentFns : kind === "service" ? serviceFns : operatorFns;
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

  return { ok: problems.length === 0, schema, owner, database, problems, roles, operatorRoles: operatorState };
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
  for (const f of fns.rows) {
    if (f.name === "op_begin_request") {
      hygiene(f.name, f.src);
      for (const t of writeTargets(f.src)) {
        if (!allowedWrites.has(t)) problems.push(`operator surface: op_begin_request writes ${t} (only operator bookkeeping is allowed)`);
      }
      for (const c of callsOf(f.src)) {
        if (volatileNames.has(c) && c !== "fleet_event" && c !== "op_begin_request") {
          problems.push(`operator surface: op_begin_request calls volatile ${c}`);
        }
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
  for (const r of routes.rows) {
    if (!readFns.has(r.fn)) problems.push(`operator surface: route ${r.route} maps to non-read function ${r.fn}`);
    const f = fns.rows.find((x) => x.name === r.fn);
    if (!f) problems.push(`operator surface: route ${r.route} maps to missing function ${r.fn}`);
    else if (f.vol === "v") problems.push(`operator surface: route ${r.route} maps to volatile ${r.fn}`);
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
