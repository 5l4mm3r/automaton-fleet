/**
 * Operator API database gateway (Phase B2, extended by Phase D3). Connects
 * ONLY as the restricted fleet_operator_login role
 * (FLEET_OPERATOR_DATABASE_URL) and calls ONLY the op_* functions; it never
 * issues table SQL. The admin, service and agent credentials are never
 * available to this process.
 *
 * Reads run in READ ONLY transactions (unchanged). The only read-write calls
 * are the two admission functions and the six named D3 action functions,
 * each called with its fixed function name (ACTION_FN) - never a name taken
 * from a request.
 */

import pg from "pg";
import type { Pool } from "pg";
import { quoteIdent } from "../postgres/migrations.js";
import { auditPrivileges, DEFAULT_OPERATOR_ROLES, type PrivilegeAuditResult } from "../postgres/privileges.js";

export interface PingResult {
  schemaVersion: number | null;
  operatorApiEnabled: boolean;
  generation: number;
  requestCount: number;
  requestCap: number;
  dbTime: string;
  runtimeRepo: string | null;
  runtimeCommit: string | null;
  runtimeBuildId: string | null;
  runtimeLockfileSha256: string | null;
}

export interface KeyMaterial {
  ok: boolean;
  publicKey?: string;
  kind?: string;
  scopes?: string[];
  expiresAt?: string;
}

export type BeginResult = { ok: true; requestId: string; fn: string; requestCount: number; requestCap: number } | { ok: false; code: string };

export type Page = { items: Record<string, unknown>[]; limit: number };

/** The D3 action functions, by action name (the only volatile calls besides admission). */
export const ACTION_FN = Object.freeze({
  hold_agent: "op_act_hold_agent",
  release_agent_hold: "op_act_release_agent_hold",
  request_health_challenge: "op_act_request_health_challenge",
  revoke_agent_sessions: "op_act_revoke_agent_sessions",
  reconcile_lifecycle: "op_act_reconcile_lifecycle",
  propose_agent_action: "op_propose_agent_action",
} as const);
export type ActionName = keyof typeof ACTION_FN;

/** A database refusal of an action body/request (raised inside the action function; nothing was changed). */
export class ActionRefused extends Error {
  constructor(readonly code: "FLEET_OP_BAD_PARAM" | "FLEET_OP_REQUEST_INVALID") {
    super(code);
  }
}

/** What the Operator API server needs from the database (a fake implements it in tests). */
export interface OperatorGateway {
  ping(): Promise<PingResult>;
  keyMaterial(principal: string, key: string): Promise<KeyMaterial>;
  beginRequest(a: { principal: string; key: string; route: string; clientTsMs: number; nonce: string; bodySha256: string }): Promise<BeginResult>;
  whoami(requestId: string): Promise<Record<string, unknown>>;
  fleetStatus(requestId: string): Promise<Record<string, unknown>>;
  listAgents(requestId: string, after: string | null, limit: number): Promise<{ items: Record<string, unknown>[]; limit: number }>;
  getAgent(requestId: string, agentId: string): Promise<{ found: boolean; item?: Record<string, unknown> }>;
  listEvents(requestId: string, after: string | null, limit: number, type: string | null): Promise<{ items: Record<string, unknown>[]; limit: number }>;
  // ── D3
  beginAction(a: { principal: string; key: string; route: string; clientTsMs: number; nonce: string; bodySha256: string }): Promise<BeginResult>;
  lifecycleHealth(requestId: string): Promise<Record<string, unknown>>;
  runtimeStatus(requestId: string): Promise<Record<string, unknown>>;
  listReservations(requestId: string, after: string | null, limit: number): Promise<Page>;
  listOrphans(requestId: string, after: string | null, limit: number): Promise<Page>;
  listProposals(requestId: string, after: string | null, limit: number): Promise<Page>;
  listActions(requestId: string, after: string | null, limit: number): Promise<Page>;
  /** Run one named action with the exact signed body; throws ActionRefused on a database refusal. */
  act(action: ActionName, requestId: string, body: string): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export class PgOperatorGateway implements OperatorGateway {
  private readonly pool: Pool;
  private readonly s: string;

  constructor(opts: { connectionString: string; schema?: string; poolMax?: number }) {
    const schema = opts.schema ?? "fleet";
    this.s = quoteIdent(schema);
    this.pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: opts.poolMax ?? 4,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true,
      application_name: "automaton-fleet-operator-api",
      options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=10000`,
    });
    this.pool.on("error", () => {});
  }

  private async fn<T>(sql: string, params: unknown[]): Promise<T> {
    const r = await this.pool.query<{ r: T }>(sql, params);
    return r.rows[0].r;
  }

  /**
   * Every read runs in its own READ ONLY transaction: whatever an op_* read
   * function (or anything it calls, directly or via dynamic SQL) tries, the
   * server refuses any write, sequence change, NOTIFY or large-object write.
   * Only op_begin_request (fn) runs read-write.
   */
  private async ro<T>(sql: string, params: unknown[]): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN TRANSACTION READ ONLY");
      const r = await c.query<{ r: T }>(sql, params);
      await c.query("COMMIT");
      return r.rows[0].r;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  async ping(): Promise<PingResult> {
    return this.ro<PingResult>(`SELECT ${this.s}.op_ping() AS r`, []);
  }

  async keyMaterial(principal: string, key: string): Promise<KeyMaterial> {
    return this.ro<KeyMaterial>(`SELECT ${this.s}.op_key_material($1, $2) AS r`, [principal, key]);
  }

  async beginRequest(a: { principal: string; key: string; route: string; clientTsMs: number; nonce: string; bodySha256: string }): Promise<BeginResult> {
    return this.fn<BeginResult>(`SELECT ${this.s}.op_begin_request($1, $2, $3, $4, $5, $6) AS r`, [
      a.principal,
      a.key,
      a.route,
      a.clientTsMs,
      a.nonce,
      a.bodySha256,
    ]);
  }

  async whoami(requestId: string): Promise<Record<string, unknown>> {
    return this.ro(`SELECT ${this.s}.op_whoami($1) AS r`, [requestId]);
  }

  async fleetStatus(requestId: string): Promise<Record<string, unknown>> {
    return this.ro(`SELECT ${this.s}.op_fleet_status($1) AS r`, [requestId]);
  }

  async listAgents(requestId: string, after: string | null, limit: number): Promise<{ items: Record<string, unknown>[]; limit: number }> {
    return this.ro(`SELECT ${this.s}.op_list_agents($1, $2, $3) AS r`, [requestId, after, limit]);
  }

  async getAgent(requestId: string, agentId: string): Promise<{ found: boolean; item?: Record<string, unknown> }> {
    return this.ro(`SELECT ${this.s}.op_get_agent($1, $2) AS r`, [requestId, agentId]);
  }

  async listEvents(requestId: string, after: string | null, limit: number, type: string | null): Promise<{ items: Record<string, unknown>[]; limit: number }> {
    return this.ro(`SELECT ${this.s}.op_list_events($1, $2, $3, $4) AS r`, [requestId, after, limit, type]);
  }

  async beginAction(a: { principal: string; key: string; route: string; clientTsMs: number; nonce: string; bodySha256: string }): Promise<BeginResult> {
    return this.fn<BeginResult>(`SELECT ${this.s}.op_begin_action($1, $2, $3, $4, $5, $6) AS r`, [
      a.principal,
      a.key,
      a.route,
      a.clientTsMs,
      a.nonce,
      a.bodySha256,
    ]);
  }

  async lifecycleHealth(requestId: string): Promise<Record<string, unknown>> {
    return this.ro(`SELECT ${this.s}.op_lifecycle_health($1) AS r`, [requestId]);
  }

  async runtimeStatus(requestId: string): Promise<Record<string, unknown>> {
    return this.ro(`SELECT ${this.s}.op_runtime_status($1) AS r`, [requestId]);
  }

  async listReservations(requestId: string, after: string | null, limit: number): Promise<Page> {
    return this.ro(`SELECT ${this.s}.op_list_reservations($1, $2, $3) AS r`, [requestId, after, limit]);
  }

  async listOrphans(requestId: string, after: string | null, limit: number): Promise<Page> {
    return this.ro(`SELECT ${this.s}.op_list_orphans($1, $2, $3) AS r`, [requestId, after, limit]);
  }

  async listProposals(requestId: string, after: string | null, limit: number): Promise<Page> {
    return this.ro(`SELECT ${this.s}.op_list_proposals($1, $2, $3) AS r`, [requestId, after, limit]);
  }

  async listActions(requestId: string, after: string | null, limit: number): Promise<Page> {
    return this.ro(`SELECT ${this.s}.op_list_actions($1, $2, $3) AS r`, [requestId, after, limit]);
  }

  /**
   * One D3 action, in its own read-write transaction (the action function
   * re-validates everything and records its ledger row atomically with its
   * effect). The function name comes from the fixed ACTION_FN table.
   */
  async act(action: ActionName, requestId: string, body: string): Promise<Record<string, unknown>> {
    if (!Object.prototype.hasOwnProperty.call(ACTION_FN, action)) throw new Error("unknown action");
    const fn = ACTION_FN[action];
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const r = await c.query<{ r: Record<string, unknown> }>(`SELECT ${this.s}.${fn}($1, $2) AS r`, [requestId, body]);
      await c.query("COMMIT");
      return r.rows[0].r;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      const msg = err instanceof Error ? err.message : "";
      if (msg.startsWith("FLEET_OP_BAD_PARAM")) throw new ActionRefused("FLEET_OP_BAD_PARAM");
      if (msg.startsWith("FLEET_OP_REQUEST_INVALID")) throw new ActionRefused("FLEET_OP_REQUEST_INVALID");
      throw err;
    } finally {
      c.release();
    }
  }

  /** Who this connection is, and whether it is anything more than the operator role. */
  async identity(): Promise<{ user: string; isOwner: boolean; superuser: boolean; memberOf: string[] }> {
    const r = await this.pool.query<{ u: string; owner: string | null; su: boolean; m: string[] | null }>(
      `SELECT current_user AS u, (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = current_schema()) AS owner,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su,
              ARRAY(SELECT rolname::text FROM pg_roles WHERE rolname <> current_user AND pg_has_role(current_user, oid, 'MEMBER') ORDER BY 1) AS m`,
    );
    const row = r.rows[0];
    return { user: row.u, isOwner: row.owner === row.u, superuser: row.su === true, memberOf: row.m ?? [] };
  }

  /** Privilege audit restricted to the operator roles (the agent/service roles are the controller's concern). */
  async auditOperator(schema = "fleet"): Promise<PrivilegeAuditResult> {
    // The connected login is audited too, whatever its name.
    const who = (await this.pool.query<{ u: string }>("SELECT current_user AS u")).rows[0].u;
    const roles = [...new Set([...DEFAULT_OPERATOR_ROLES, who])];
    return auditPrivileges(this.pool, { schema, agentRoles: [], serviceRoles: [], operatorRoles: roles, requireOperatorRoles: true });
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }
}
