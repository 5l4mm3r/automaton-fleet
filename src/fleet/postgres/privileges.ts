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
 */

import { AGENT_API_FUNCTIONS, SERVICE_API_FUNCTIONS, SERVICE_READ_TABLES } from "./migrations.js";

export interface Queryable {
  query<R = any>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface PrivilegeAuditOptions {
  schema?: string;
  agentRoles?: string[];
  serviceRoles?: string[];
}

export interface PrivilegeAuditResult {
  ok: boolean;
  schema: string;
  owner: string | null;
  database: string;
  problems: string[];
  roles: Array<{ role: string; kind: "agent" | "service"; exists: boolean; functions: string[]; tables: string[] }>;
}

export const DEFAULT_AGENT_ROLES = ["fleet_agent", "fleet_agent_login"];
export const DEFAULT_SERVICE_ROLES = ["fleet_service", "fleet_service_login"];

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
  const allRestricted = [...(opts.agentRoles ?? DEFAULT_AGENT_ROLES), ...(opts.serviceRoles ?? DEFAULT_SERVICE_ROLES)];
  const plan: Array<[string, "agent" | "service"]> = [
    ...(opts.agentRoles ?? DEFAULT_AGENT_ROLES).map((r) => [r, "agent"] as [string, "agent"]),
    ...(opts.serviceRoles ?? DEFAULT_SERVICE_ROLES).map((r) => [r, "service"] as [string, "service"]),
  ];

  const agentFns = new Set(AGENT_API_FUNCTIONS.map(normSig));
  const serviceFns = new Set(SERVICE_API_FUNCTIONS.map(normSig));
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

    const fns = await db.query<{ sig: string; secdef: boolean; cfg: string[] | null }>(
      `SELECT p.oid::regprocedure::text AS sig, p.prosecdef AS secdef, p.proconfig AS cfg
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $2 AND has_function_privilege($1, p.oid, 'EXECUTE')
        ORDER BY 1`,
      [role, schema],
    );
    const allowed = kind === "agent" ? agentFns : serviceFns;
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

  return { ok: problems.length === 0, schema, owner, database, problems, roles };
}

/** Problems that concern only the given roles (plus PUBLIC); used by the service's startup self-check. */
export function problemsFor(result: PrivilegeAuditResult, roles: string[]): string[] {
  return result.problems.filter((p) => p.startsWith("PUBLIC") || roles.some((r) => p.startsWith(`${r} `) || p.startsWith(`role ${r} `)) || p.includes(" is not SECURITY DEFINER") || p.includes(" does not pin search_path"));
}
