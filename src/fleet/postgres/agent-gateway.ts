/**
 * Restricted agent gateway (Phase 3)
 *
 * Connects as the restricted agent role (FLEET_AGENT_DATABASE_URL) and can
 * only call the api_* SECURITY DEFINER functions. The fleet service uses it
 * for every agent-scoped request (heartbeat, state, replication request,
 * release, own status), so a bug in a request handler cannot touch the cap,
 * other agents, triggers or schema: the database refuses.
 *
 * selfCheck() verifies at startup that the connected role really is
 * restricted; the service refuses to start otherwise.
 */

import pg from "pg";
import type { Pool } from "pg";
import { isFleetState } from "../config.js";
import type { SharedAgentRecord, SharedAgentStatus, SharedFleetState } from "../types.js";
import { FLEET_PG_HARD_MAX_AGENTS, quoteIdent } from "./migrations.js";

export interface AgentGatewayOptions {
  connectionString: string;
  schema?: string;
  poolMax?: number;
  statementTimeoutMs?: number;
}

export type ApiResult<T = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; code: string; reason?: string; [k: string]: unknown };

export interface StateJson {
  livingAgents: number;
  reservedSlots: number;
  quarantinedSlots?: number;
  maxAgents: number;
  operatingMode: string;
  replicationEnabled: boolean;
  runtime: { repo: string; commit: string } | null;
  build: { buildId: string; lockfileSha256: string } | null;
  updatedAt: string;
}

export function stateFromJson(j: StateJson): SharedFleetState {
  return {
    livingAgents: j.livingAgents,
    reservedSlots: j.reservedSlots,
    quarantinedSlots: j.quarantinedSlots ?? 0,
    maxAgents: Math.min(j.maxAgents, FLEET_PG_HARD_MAX_AGENTS),
    operatingMode: isFleetState(j.operatingMode) ? j.operatingMode : "EMERGENCY",
    runtime: j.runtime,
    updatedAt: new Date(j.updatedAt).toISOString(),
    replicationEnabled: j.replicationEnabled === true,
    build: j.build,
  };
}

function isoOrNull(v: unknown): string | null {
  return v ? new Date(v as string).toISOString() : null;
}

export function agentFromJson(a: Record<string, unknown>): SharedAgentRecord {
  return {
    agentId: a.agentId as string,
    parentAgentId: (a.parentAgentId as string) ?? null,
    role: a.role as "root" | "child",
    generation: a.generation as number,
    name: a.name as string,
    walletAddress: (a.walletAddress as string) ?? null,
    runtimeVersion: (a.runtimeVersion as string) ?? null,
    runtimeRepo: (a.runtimeRepo as string) ?? null,
    runtimeCommit: (a.runtimeCommit as string) ?? null,
    sandboxId: (a.sandboxId as string) ?? null,
    localChildId: (a.localChildId as string) ?? null,
    status: a.status as SharedAgentStatus,
    statusReason: (a.statusReason as string) ?? null,
    requestedBy: (a.requestedBy as string) ?? null,
    createdAt: new Date(a.createdAt as string).toISOString(),
    updatedAt: new Date(a.updatedAt as string).toISOString(),
    lastHeartbeat: isoOrNull(a.lastHeartbeat),
    deathTime: isoOrNull(a.deathTime),
    ...(a.capabilityScope === "full" || a.capabilityScope === "witness" ? { capabilityScope: a.capabilityScope } : {}),
  };
}

export class PgAgentGateway {
  readonly schema: string;
  private readonly s: string;
  private readonly pool: Pool;

  constructor(opts: AgentGatewayOptions) {
    this.schema = opts.schema ?? "fleet";
    this.s = quoteIdent(this.schema);
    const stmtMs = opts.statementTimeoutMs ?? 10_000;
    this.pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: opts.poolMax ?? 8,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true,
      application_name: "automaton-fleet-agent-api",
      options: `-c statement_timeout=${stmtMs} -c lock_timeout=5000`,
    });
    this.pool.on("error", () => {});
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }

  private async call<T>(fn: string, args: unknown[]): Promise<T> {
    const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
    const r = await this.pool.query(`SELECT ${this.s}.${fn}(${placeholders}) AS r`, args);
    return r.rows[0].r as T;
  }

  /**
   * Startup check: the connected role must not be a superuser, must not own
   * the schema, and must have no direct privileges on fleet tables. Returns
   * the list of problems (empty = restricted as intended).
   */
  async selfCheck(): Promise<string[]> {
    const problems: string[] = [];
    const who = await this.pool.query<{ u: string; su: boolean; cr: boolean; cd: boolean; owner: string | null }>(
      `SELECT current_user AS u, r.rolsuper AS su, r.rolcreaterole AS cr, r.rolcreatedb AS cd,
              (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = $1) AS owner
         FROM pg_roles r WHERE r.rolname = current_user`,
      [this.schema],
    );
    const w = who.rows[0];
    if (!w) return ["cannot identify the connected role"];
    if (w.su) problems.push(`${w.u} is a superuser`);
    if (w.cr) problems.push(`${w.u} can create roles`);
    if (w.cd) problems.push(`${w.u} can create databases`);
    if (w.owner === w.u) problems.push(`${w.u} owns schema ${this.schema}`);
    const priv = await this.pool.query<{ t: string; p: string }>(
      `SELECT c.relname AS t, p.priv AS p
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER','REFERENCES']) AS p(priv)
        WHERE n.nspname = $1 AND c.relkind IN ('r','v','m','p','S')
          AND has_table_privilege(current_user, c.oid, p.priv)`,
      [this.schema],
    );
    for (const r of priv.rows) problems.push(`${w.u} has ${r.p} on ${this.schema}.${r.t}`);
    const create = await this.pool.query<{ c: boolean }>("SELECT has_schema_privilege(current_user, $1, 'CREATE') AS c", [this.schema]);
    if (create.rows[0]?.c) problems.push(`${w.u} can create objects in ${this.schema}`);
    return problems;
  }

  async fleetState(): Promise<SharedFleetState> {
    return stateFromJson(await this.call<StateJson>("api_fleet_state", []));
  }

  async memberAddresses(): Promise<string[]> {
    const r = await this.pool.query<{ a: string }>(`SELECT a FROM ${this.s}.api_member_addresses() AS a`);
    return r.rows.map((x) => x.a);
  }

  async whoami(agentId: string, token: string): Promise<ApiResult<{ agent: SharedAgentRecord; code?: string | null }>> {
    const r = await this.call<{ ok: boolean; code?: string; agent?: Record<string, unknown> }>("api_whoami", [agentId, token]);
    if (r.agent) {
      const agent = agentFromJson(r.agent);
      return r.ok ? { ok: true, agent } : { ok: false, code: r.code ?? "FLEET_AUTH_FAILED", agent };
    }
    return { ok: false, code: r.code ?? "FLEET_AUTH_FAILED" };
  }

  async heartbeat(agentId: string, token: string): Promise<ApiResult<{ status: string }>> {
    const r = await this.call<{ ok: boolean; code?: string; status?: string }>("api_heartbeat", [agentId, token]);
    return r.ok ? { ok: true, status: r.status ?? "active" } : { ok: false, code: r.code ?? "FLEET_AGENT_DEAD", status: r.status };
  }

  async requestReplication(
    agentId: string,
    token: string,
    name: string,
    requestKey: string,
    newAgentId: string,
    reservationId: string,
  ): Promise<Record<string, unknown> & { ok: boolean }> {
    return this.call("api_request_replication", [agentId, token, name, requestKey, newAgentId, reservationId]);
  }

  async releaseReservation(agentId: string, token: string, reservationId: string, reason: string): Promise<ApiResult<{ released: boolean }>> {
    return this.call("api_release_reservation", [agentId, token, reservationId, reason]);
  }

  async setOwnStatus(agentId: string, token: string, status: string, reason: string): Promise<ApiResult<{ changed: boolean }>> {
    return this.call("api_set_own_status", [agentId, token, status, reason]);
  }

  /** Exchange the long-lived credential for a short-lived session (only the hash is stored). */
  async openSession(agentId: string, token: string, sessionHash: string): Promise<ApiResult<{ expiresAt: string; ttlS: number }>> {
    return this.call("api_open_session", [agentId, token, sessionHash]);
  }

  async proposeAllocation(
    agentId: string,
    token: string,
    p: { allocationId: string; purpose: string; requestedCents: number; expectedReturnCents: number; expectedDurationDays: number },
  ): Promise<ApiResult<{ allocationId: string; status: string }>> {
    return this.call("api_propose_allocation", [
      agentId, token, p.allocationId, p.purpose, p.requestedCents, p.expectedReturnCents, p.expectedDurationDays,
    ]);
  }

  async requestSpend(
    agentId: string,
    token: string,
    r: { requestId: string; fromWallet: string; toAddress: string; amountCents: number; purpose: string; allocationId: string | null },
  ): Promise<Record<string, unknown> & { ok: boolean }> {
    return this.call("api_request_spend", [
      agentId, token, r.requestId, r.fromWallet, r.toAddress, r.amountCents, r.purpose, r.allocationId,
    ]);
  }

  /**
   * Schema v10: submit a structured spend order against the agent's own
   * ledger allocation. The database decides (reserved / awaiting_owner /
   * rejected); nothing is executed by this call.
   */
  async spendRequest(
    agentId: string,
    token: string,
    r: { idempotencyKey: string; amountCents: number; category: string; destinationId: string; purpose: string; recoverableCents?: number },
  ): Promise<Record<string, unknown> & { ok: boolean }> {
    return this.call("api_spend_request", [
      agentId, token, r.idempotencyKey, r.amountCents, r.category, r.destinationId, r.purpose, r.recoverableCents ?? 0,
    ]);
  }

  async spendCancel(agentId: string, token: string, orderId: string): Promise<Record<string, unknown> & { ok: boolean }> {
    return this.call("api_spend_cancel", [agentId, token, orderId]);
  }

  async ledgerSummary(agentId: string, token: string): Promise<Record<string, unknown> & { ok: boolean }> {
    return this.call("api_ledger_summary", [agentId, token]);
  }

  /** Schema v11: the agent's capability manifest. */
  async capabilities(agentId: string, token: string): Promise<Record<string, unknown> & { ok: boolean }> {
    return this.call("api_capabilities", [agentId, token]);
  }

  async knowledgePropose(agentId: string, token: string, category: string, title: string, content: string): Promise<Record<string, unknown> & { ok: boolean }> {
    return this.call("api_knowledge_propose", [agentId, token, category, title, content]);
  }

  async knowledgeList(agentId: string, token: string, after: number, limit: number): Promise<Record<string, unknown> & { ok: boolean }> {
    return this.call("api_knowledge_list", [agentId, token, after, limit]);
  }

  async identityRequest(agentId: string, token: string, factKey: string, purpose: string, workflow: string): Promise<Record<string, unknown> & { ok: boolean }> {
    return this.call("api_identity_request", [agentId, token, factKey, purpose, workflow]);
  }

  async identityFact(agentId: string, token: string, claimId: string): Promise<Record<string, unknown> & { ok: boolean }> {
    return this.call("api_identity_fact", [agentId, token, claimId]);
  }
}
