/**
 * Shared Fleet Registry — PostgreSQL store
 *
 * The authoritative, fleet-wide record of agents and allocator of slots.
 * Every agent process (root and children, in any sandbox) talks to the same
 * database, so the living-agent cap is global rather than per-sandbox.
 *
 * Locking strategy
 *   - Every slot-affecting transaction first runs
 *       SELECT … FROM fleet_state WHERE id = 1 FOR UPDATE
 *     The single fleet_state row is a fleet-wide mutex: concurrent
 *     reservations from any number of processes/hosts serialise on it, and
 *     each one reads the counters only after the previous one committed.
 *   - fleet_agents triggers maintain living_agents / reserved_slots and raise
 *     FLEET_CAP_EXCEEDED if a row entering the living/reserved population
 *     would exceed max_agents. The trigger updates the same row, so raw SQL
 *     that bypasses this class is serialised and capped too.
 *   - State transitions are conditional UPDATEs (… WHERE status = 'x'),
 *     so claim / activate / release / death each happen at most once.
 *   - lock_timeout and statement_timeout bound every wait; a timeout is a
 *     failure, and failures deny replication (fail closed).
 */

import crypto from "crypto";
import pg from "pg";
import type { Pool, PoolClient } from "pg";
import { ulid } from "ulid";
import { isFleetState } from "../config.js";
import { createBoundGrant, type ClaimedGrant } from "../grants.js";
import { FleetBypassError } from "../registry.js";
import { FleetRuntimeError, type RuntimePin } from "../runtime.js";
import {
  checkAttestation,
  newAttestationNonce,
  sanitizeAttestation,
  type RuntimeAttestation,
  type RuntimeBuild,
} from "../attestation.js";
import type {
  ActivationResult,
  FleetCredential,
  FleetDecisionCode,
  FleetHealth,
  FleetSpawnGrant,
  FleetState,
  ReapResult,
  ReservationLease,
  ReservationLeaseStatus,
  SharedAgentRecord,
  SharedAgentStatus,
  SharedFleetState,
} from "../types.js";
import {
  AGENT_API_FUNCTIONS,
  FLEET_PG_HARD_MAX_AGENTS,
  FLEET_PG_SCHEMA_VERSION,
  migrate,
  quoteIdent,
} from "./migrations.js";

export const DEFAULT_FLEET_PG_SCHEMA = "fleet";
/** Default lease TTLs live in fleet_state (reservation_ttl_s = 30 min, provisioning_ttl_s = 45 min). */
export const DEFAULT_RESERVATION_TTL_MS = 30 * 60_000;
export const DEFAULT_AGENT_ROLE = "fleet_agent";

export interface FleetTimeouts {
  reservationTtlS: number;
  provisioningTtlS: number;
  heartbeatUnresponsiveS: number;
  heartbeatDeadS: number;
}

/** Bearer token format: fa1.<agentId>.<43 chars base64url>. */
const TOKEN_RE = /^fa1\.([0-9A-HJKMNP-TV-Z]{26})\.[A-Za-z0-9_-]{43}$/;

export function mintAgentToken(agentId: string): string {
  return `fa1.${agentId}.${crypto.randomBytes(32).toString("base64url")}`;
}

export function hashAgentToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** Agent id embedded in a well-formed token, else null. */
export function agentIdFromToken(token: string): string | null {
  return TOKEN_RE.exec(token)?.[1] ?? null;
}

export class FleetRegistryUnavailableError extends Error {
  readonly code = "FLEET_REGISTRY_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "FleetRegistryUnavailableError";
  }
}

export class FleetDuplicateRegistrationError extends Error {
  readonly code = "FLEET_DUPLICATE_REGISTRATION";
  constructor(message: string) {
    super(message);
    this.name = "FleetDuplicateRegistrationError";
  }
}

export interface PgFleetStoreOptions {
  connectionString: string;
  schema?: string;
  poolMax?: number;
  connectTimeoutMs?: number;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  /** Override fleet_state.reservation_ttl_s for reservations made by this store (tests). */
  reservationTtlMs?: number;
  /** Override fleet_state.provisioning_ttl_s for claims made by this store (tests). */
  provisioningTtlMs?: number;
  /** Restricted role granted the agent API on migrate (if it exists). */
  agentRole?: string;
  /** application_name reported to PostgreSQL. */
  applicationName?: string;
}

export type SharedReserveResult =
  | { ok: true; grant: FleetSpawnGrant; agent: SharedAgentRecord; lease?: ReservationLease }
  | { ok: false; code: FleetDecisionCode; reason: string; living: number; reserved: number; max: number };

export type RegisterResult =
  | { ok: true; agent: SharedAgentRecord; created: boolean }
  | { ok: false; code: FleetDecisionCode | "FLEET_AGENT_DEAD" | "FLEET_IDENTITY_MISMATCH"; reason: string };

interface AgentRow {
  agent_id: string;
  parent_agent_id: string | null;
  role: "root" | "child";
  generation: number;
  name: string;
  wallet_address: string | null;
  runtime_version: string | null;
  runtime_repo: string | null;
  runtime_commit: string | null;
  sandbox_id: string | null;
  local_child_id: string | null;
  status: SharedAgentStatus;
  status_reason: string | null;
  requested_by: string | null;
  created_at: Date;
  updated_at: Date;
  last_heartbeat: Date | null;
  reservation_expires_at: Date | null;
  death_time: Date | null;
}

interface StateRow {
  living_agents: number;
  reserved_slots: number;
  max_agents: number;
  operating_mode: string;
  runtime_repo: string | null;
  runtime_commit: string | null;
  updated_at: Date;
  replication_enabled: boolean;
  runtime_build_id: string | null;
  runtime_lockfile_sha256: string | null;
  reservation_ttl_s: number;
  provisioning_ttl_s: number;
  heartbeat_unresponsive_s: number;
  heartbeat_dead_s: number;
}

interface LeaseRow {
  reservation_id: string;
  agent_id: string;
  parent_agent_id: string;
  status: ReservationLeaseStatus;
  created_at: Date;
  expires_at: Date;
  claimed_at: Date | null;
  completed_at: Date | null;
  ended_at: Date | null;
  end_reason: string | null;
  expected_repo: string;
  expected_commit: string;
  expected_build_id: string;
  expected_lockfile_sha256: string;
  attestation_nonce: string | null;
  attested_at: Date | null;
}

type ReserveJson =
  | {
      ok: true;
      agentId: string;
      reservationId: string;
      parentAgentId: string;
      generation: number;
      expiresAt: string;
      runtime: { repo: string; commit: string };
      build: { buildId: string; lockfileSha256: string };
    }
  | { ok: false; code: string; reason: string; living: number; reserved: number; max: number };

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toAgent(r: AgentRow): SharedAgentRecord {
  return {
    agentId: r.agent_id,
    parentAgentId: r.parent_agent_id,
    role: r.role,
    generation: r.generation,
    name: r.name,
    walletAddress: r.wallet_address,
    runtimeVersion: r.runtime_version,
    runtimeRepo: r.runtime_repo,
    runtimeCommit: r.runtime_commit,
    sandboxId: r.sandbox_id,
    localChildId: r.local_child_id,
    status: r.status,
    statusReason: r.status_reason,
    requestedBy: r.requested_by,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    lastHeartbeat: iso(r.last_heartbeat),
    deathTime: iso(r.death_time),
  };
}

function toState(r: StateRow): SharedFleetState {
  return {
    livingAgents: r.living_agents,
    reservedSlots: r.reserved_slots,
    maxAgents: Math.min(r.max_agents, FLEET_PG_HARD_MAX_AGENTS),
    operatingMode: isFleetState(r.operating_mode) ? r.operating_mode : "EMERGENCY",
    runtime: r.runtime_repo && r.runtime_commit ? { repo: r.runtime_repo, commit: r.runtime_commit } : null,
    updatedAt: r.updated_at.toISOString(),
    replicationEnabled: r.replication_enabled === true,
    build: r.runtime_build_id && r.runtime_lockfile_sha256
      ? { buildId: r.runtime_build_id, lockfileSha256: r.runtime_lockfile_sha256 }
      : null,
  };
}

function toLease(r: LeaseRow): ReservationLease {
  return {
    reservationId: r.reservation_id,
    agentId: r.agent_id,
    parentAgentId: r.parent_agent_id,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    claimedAt: iso(r.claimed_at),
    completedAt: iso(r.completed_at),
    endedAt: iso(r.ended_at),
    endReason: r.end_reason,
    expected: {
      repo: r.expected_repo,
      commit: r.expected_commit,
      buildId: r.expected_build_id,
      lockfileSha256: r.expected_lockfile_sha256,
    },
    attestedAt: iso(r.attested_at),
  };
}

function leaseFromReserve(r: Extract<ReserveJson, { ok: true }>): ReservationLease {
  return {
    reservationId: r.reservationId,
    agentId: r.agentId,
    parentAgentId: r.parentAgentId,
    status: "reserved",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(r.expiresAt).toISOString(),
    claimedAt: null,
    completedAt: null,
    endedAt: null,
    endReason: null,
    expected: { ...r.runtime, ...r.build },
    attestedAt: null,
  };
}

/** Database clock (ms) — lease expiry is always judged by the registry's clock. */
async function dbNow(c: PoolClient): Promise<number> {
  const r = await c.query<{ now: Date }>("SELECT now() AS now");
  return r.rows[0].now.getTime();
}

// ─── Secret hygiene for the audit log ────────────────────────────

const SECRET_KEY_RE = /(private|secret|mnemonic|seed|passw|api[_-]?key|token|credential|database_url)/i;
const SECRET_VALUE_RES = [/0x[0-9a-fA-F]{64}/g, /[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi];

export function scrubText(s: string): string {
  return SECRET_VALUE_RES.reduce((acc, re) => acc.replace(re, "[redacted]"), s).slice(0, 500);
}

export function scrubDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = "[redacted]";
    } else if (typeof v === "string") {
      out[k] = SECRET_VALUE_RES.reduce((s, re) => s.replace(re, "[redacted]"), v);
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = scrubDetail(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function isConnectionError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  if (!e) return false;
  if (typeof e.code === "string") {
    // 08xxx connection exceptions, 57P0x shutdown, 53xxx resources, network errnos
    if (/^(08|57P0|53)/.test(e.code)) return true;
    if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "EAI_AGAIN", "EPIPE"].includes(e.code)) return true;
    // 55P03 lock_not_available, 57014 query_canceled (statement/lock timeout)
    if (e.code === "55P03" || e.code === "57014") return true;
  }
  return /timeout|Connection terminated|ECONNREFUSED|connection is closed/i.test(e.message ?? "");
}

function pgMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class PgFleetStore {
  readonly kind = "postgres" as const;
  readonly schema: string;
  readonly agentRole: string;
  private readonly pool: Pool;
  private readonly reservationTtlMs: number | null;
  private readonly provisioningTtlMs: number | null;
  private schemaChecked = false;
  private closed = false;

  constructor(opts: PgFleetStoreOptions) {
    this.schema = opts.schema ?? DEFAULT_FLEET_PG_SCHEMA;
    quoteIdent(this.schema);
    this.reservationTtlMs = opts.reservationTtlMs ?? null;
    this.provisioningTtlMs = opts.provisioningTtlMs ?? null;
    this.agentRole = opts.agentRole ?? DEFAULT_AGENT_ROLE;
    quoteIdent(this.agentRole);
    const lockMs = opts.lockTimeoutMs ?? 5_000;
    const stmtMs = opts.statementTimeoutMs ?? 10_000;
    this.pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: opts.poolMax ?? 4,
      // Also bounds the wait for a pooled client, so it must tolerate bursts.
      connectionTimeoutMillis: opts.connectTimeoutMs ?? 10_000,
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true,
      application_name: opts.applicationName ?? "automaton-fleet",
      options: `-c search_path=${this.schema} -c lock_timeout=${lockMs} -c statement_timeout=${stmtMs} -c idle_in_transaction_session_timeout=${stmtMs * 3}`,
    });
    // An idle client losing its connection must not crash the agent.
    this.pool.on("error", () => {});
  }

  /**
   * Controller/operator store from FLEET_CONTROLLER_DATABASE_URL (or the
   * legacy DATABASE_URL). Null when unconfigured. Never used by agents.
   */
  static fromEnv(env: Record<string, string | undefined> = process.env): PgFleetStore | null {
    const url = (env.FLEET_CONTROLLER_DATABASE_URL || env.DATABASE_URL)?.trim();
    if (!url) return null;
    return new PgFleetStore({
      connectionString: url,
      schema: env.FLEET_PG_SCHEMA?.trim() || undefined,
      agentRole: env.FLEET_AGENT_ROLE?.trim() || undefined,
      applicationName: "automaton-fleet-controller",
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end().catch(() => {});
  }

  // ─── Plumbing ──────────────────────────────────────────────────

  private async connect(): Promise<PoolClient> {
    if (this.closed) throw new FleetRegistryUnavailableError("Fleet registry connection is closed.");
    try {
      return await this.pool.connect();
    } catch (err) {
      throw new FleetRegistryUnavailableError(`Fleet registry unreachable: ${pgMessage(err)}`);
    }
  }

  private async ensureSchema(client: PoolClient): Promise<void> {
    if (this.schemaChecked) return;
    let version: number | null = null;
    try {
      const r = await client.query("SELECT max(version) AS v FROM fleet_schema_migrations");
      version = r.rows[0]?.v ?? null;
    } catch (err) {
      throw new FleetRegistryUnavailableError(`Fleet registry schema missing (run fleet:migrate): ${pgMessage(err)}`);
    }
    if (version !== FLEET_PG_SCHEMA_VERSION) {
      throw new FleetRegistryUnavailableError(
        `Fleet registry schema version ${version ?? "none"} != required ${FLEET_PG_SCHEMA_VERSION}.`,
      );
    }
    this.schemaChecked = true;
  }

  /** Run fn in a READ COMMITTED transaction. Connection problems surface as FleetRegistryUnavailableError. */
  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.connect();
    let broken = false;
    try {
      await this.ensureSchema(client);
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        broken = true;
      }
      if (err instanceof FleetRegistryUnavailableError) throw err;
      if (isConnectionError(err)) {
        broken = true;
        throw new FleetRegistryUnavailableError(`Fleet registry transaction failed: ${pgMessage(err)}`);
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }

  private async read<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.connect();
    let broken = false;
    try {
      await this.ensureSchema(client);
      return await fn(client);
    } catch (err) {
      if (err instanceof FleetRegistryUnavailableError) throw err;
      if (isConnectionError(err)) {
        broken = true;
        throw new FleetRegistryUnavailableError(`Fleet registry query failed: ${pgMessage(err)}`);
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }

  private async lockState(c: PoolClient): Promise<StateRow> {
    const r = await c.query<StateRow>("SELECT * FROM fleet_state WHERE id = 1 FOR UPDATE");
    if (r.rowCount !== 1) throw new FleetRegistryUnavailableError("fleet_state row missing (fail closed).");
    return r.rows[0];
  }

  private async event(
    c: PoolClient,
    eventType: string,
    agentId: string | null,
    actor: string | null,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    await c.query("INSERT INTO fleet_events (event_type, agent_id, actor, detail) VALUES ($1, $2, $3, $4)", [
      eventType,
      agentId,
      actor,
      JSON.stringify(scrubDetail(detail)),
    ]);
  }

  // ─── Operator / migrations ─────────────────────────────────────

  /** Operator-only: apply schema migrations, then (re)grant the agent API to the restricted role if it exists. */
  async migrate(): Promise<number[]> {
    const client = await this.connect();
    let applied: number[];
    try {
      applied = await migrate(client, this.schema);
    } finally {
      client.release();
    }
    const role = await this.pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [this.agentRole]).catch(() => null);
    if (role?.rowCount) await this.grantAgentRole(this.agentRole);
    return applied;
  }

  // ─── Health ────────────────────────────────────────────────────

  async health(): Promise<FleetHealth> {
    const start = Date.now();
    let client: PoolClient;
    try {
      client = await this.connect();
    } catch (err) {
      return { ok: false, latencyMs: null, schemaVersion: null, countersConsistent: null, error: pgMessage(err) };
    }
    let broken = false;
    try {
      await client.query("SELECT 1");
      const v = await client.query("SELECT max(version) AS v FROM fleet_schema_migrations");
      const schemaVersion: number | null = v.rows[0]?.v ?? null;
      if (schemaVersion !== FLEET_PG_SCHEMA_VERSION) {
        return {
          ok: false,
          latencyMs: Date.now() - start,
          schemaVersion,
          countersConsistent: null,
          error: `schema version ${schemaVersion ?? "none"} != ${FLEET_PG_SCHEMA_VERSION}`,
        };
      }
      const c = await client.query(
        `SELECT s.living_agents = (SELECT count(*) FROM fleet_agents WHERE status IN ('active','unresponsive'))
            AND s.reserved_slots = (SELECT count(*) FROM fleet_agents WHERE status IN ('reserved','provisioning'))
            AS consistent
           FROM fleet_state s WHERE s.id = 1`,
      );
      const countersConsistent = c.rows[0]?.consistent === true;
      return {
        ok: countersConsistent,
        latencyMs: Date.now() - start,
        schemaVersion,
        countersConsistent,
        error: countersConsistent ? undefined : "fleet_state counters disagree with fleet_agents",
      };
    } catch (err) {
      broken = isConnectionError(err);
      return { ok: false, latencyMs: null, schemaVersion: null, countersConsistent: null, error: pgMessage(err) };
    } finally {
      client.release(broken);
    }
  }

  // ─── Shared fleet state ────────────────────────────────────────

  async getState(): Promise<SharedFleetState> {
    return this.read(async (c) => {
      const r = await c.query<StateRow>("SELECT * FROM fleet_state WHERE id = 1");
      if (r.rowCount !== 1) throw new FleetRegistryUnavailableError("fleet_state row missing (fail closed).");
      return toState(r.rows[0]);
    });
  }

  /** Operator-only. */
  async setMaxAgents(max: number, actor: string): Promise<void> {
    if (!Number.isSafeInteger(max) || max < 1 || max > FLEET_PG_HARD_MAX_AGENTS) {
      throw new Error(`Invalid fleet max agents: ${max} (must be 1..${FLEET_PG_HARD_MAX_AGENTS})`);
    }
    await this.tx(async (c) => {
      const prev = await this.lockState(c);
      await c.query("UPDATE fleet_state SET max_agents = $1, updated_at = now() WHERE id = 1", [max]);
      await this.event(c, "cap_set", null, actor, { previous: prev.max_agents, max });
    });
  }

  /** Operator-only. EMERGENCY is entered this way as well. */
  async setOperatingMode(mode: FleetState, actor: string, reason: string): Promise<void> {
    if (!isFleetState(mode)) throw new Error(`Invalid operating mode: ${String(mode)}`);
    await this.tx(async (c) => {
      const prev = await this.lockState(c);
      await c.query("UPDATE fleet_state SET operating_mode = $1, updated_at = now() WHERE id = 1", [mode]);
      await this.event(c, "mode_set", null, actor, { previous: prev.operating_mode, mode, reason });
    });
  }

  /** Operator-only: approve the runtime children must run, with its build identity. Null clears it (blocks all replication). */
  async setApprovedRuntime(pin: RuntimePin | null, actor: string, build: RuntimeBuild | null = null): Promise<void> {
    await this.tx(async (c) => {
      const prev = await this.lockState(c);
      await c.query(
        `UPDATE fleet_state SET runtime_repo = $1, runtime_commit = $2, runtime_build_id = $3, runtime_lockfile_sha256 = $4,
                updated_at = now() WHERE id = 1`,
        [pin?.repo ?? null, pin?.commit ?? null, pin ? build?.buildId ?? null : null, pin ? build?.lockfileSha256 ?? null : null],
      );
      await this.event(c, "runtime_approved", null, actor, {
        previous: prev.runtime_commit ? { repo: prev.runtime_repo, commit: prev.runtime_commit, buildId: prev.runtime_build_id } : null,
        runtime: pin,
        build: pin ? build : null,
      });
    });
  }

  /** Operator-only: DB-level replication switch (independent of every process's REAL_REPLICATION_ENABLED). */
  async setReplicationEnabled(enabled: boolean, actor: string): Promise<void> {
    await this.tx(async (c) => {
      const prev = await this.lockState(c);
      await c.query("UPDATE fleet_state SET replication_enabled = $1, updated_at = now() WHERE id = 1", [enabled === true]);
      await this.event(c, "replication_switch_set", null, actor, { previous: prev.replication_enabled, enabled: enabled === true });
    });
  }

  /** Operator-only: lease and heartbeat timeouts (seconds). */
  async setTimeouts(t: Partial<FleetTimeouts>, actor: string): Promise<FleetTimeouts> {
    return this.tx(async (c) => {
      const prev = await this.lockState(c);
      const next: FleetTimeouts = {
        reservationTtlS: t.reservationTtlS ?? prev.reservation_ttl_s,
        provisioningTtlS: t.provisioningTtlS ?? prev.provisioning_ttl_s,
        heartbeatUnresponsiveS: t.heartbeatUnresponsiveS ?? prev.heartbeat_unresponsive_s,
        heartbeatDeadS: t.heartbeatDeadS ?? prev.heartbeat_dead_s,
      };
      for (const [k, v] of Object.entries(next)) {
        if (!Number.isSafeInteger(v) || v < 1) throw new Error(`Invalid timeout ${k}: ${v}`);
      }
      await c.query(
        `UPDATE fleet_state SET reservation_ttl_s = $1, provisioning_ttl_s = $2, heartbeat_unresponsive_s = $3,
                heartbeat_dead_s = $4, updated_at = now() WHERE id = 1`,
        [next.reservationTtlS, next.provisioningTtlS, next.heartbeatUnresponsiveS, next.heartbeatDeadS],
      );
      await this.event(c, "timeouts_set", null, actor, { ...next });
      return next;
    });
  }

  async getTimeouts(): Promise<FleetTimeouts> {
    return this.read(async (c) => {
      const r = await c.query<StateRow>("SELECT * FROM fleet_state WHERE id = 1");
      const s = r.rows[0];
      return {
        reservationTtlS: s.reservation_ttl_s,
        provisioningTtlS: s.provisioning_ttl_s,
        heartbeatUnresponsiveS: s.heartbeat_unresponsive_s,
        heartbeatDeadS: s.heartbeat_dead_s,
      };
    });
  }

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

  // ─── Registration ──────────────────────────────────────────────

  /**
   * Register (or re-attach) a root automaton, identified by wallet address.
   * Idempotent: the same wallet always yields the same agent_id. A new root
   * occupies a living slot and is subject to the cap.
   */
  async registerRoot(params: {
    walletAddress: string;
    name: string;
    runtimeVersion?: string | null;
    runtimeCommit?: string | null;
    localMaxAgents?: number;
  }): Promise<RegisterResult> {
    return this.tx(async (c): Promise<RegisterResult> => {
      const st = await this.lockState(c);
      const existing = await c.query<AgentRow>("SELECT * FROM fleet_agents WHERE lower(wallet_address) = lower($1)", [
        params.walletAddress,
      ]);
      if (existing.rowCount) {
        const row = existing.rows[0];
        if (row.role !== "root") {
          return { ok: false, code: "FLEET_IDENTITY_MISMATCH", reason: "Wallet is registered as a child, not a root." };
        }
        if (row.status !== "active" && row.status !== "unresponsive") {
          return { ok: false, code: "FLEET_AGENT_DEAD", reason: `Agent ${row.agent_id} is ${row.status}; the dead are not revived.` };
        }
        await c.query("SELECT fleet_heartbeat($1, $2)", [row.agent_id, params.walletAddress]);
        const upd = await c.query<AgentRow>(
          `UPDATE fleet_agents SET updated_at = now(),
                  runtime_version = COALESCE($2, runtime_version), runtime_commit = COALESCE($3, runtime_commit)
            WHERE agent_id = $1 RETURNING *`,
          [row.agent_id, params.runtimeVersion ?? null, params.runtimeCommit ?? null],
        );
        return { ok: true, agent: toAgent(upd.rows[0]), created: false };
      }

      const max = Math.min(st.max_agents, params.localMaxAgents ?? FLEET_PG_HARD_MAX_AGENTS);
      if (st.living_agents + st.reserved_slots >= max) {
        await this.event(c, "registration_denied", null, params.walletAddress, {
          code: "FLEET_CAP_REACHED",
          living: st.living_agents,
          reserved: st.reserved_slots,
          max,
        });
        return { ok: false, code: "FLEET_CAP_REACHED", reason: `Fleet at cap (${st.living_agents + st.reserved_slots}/${max}); root not registered.` };
      }
      const id = ulid();
      const ins = await c.query<AgentRow>(
        `INSERT INTO fleet_agents (agent_id, role, generation, name, wallet_address, runtime_version, runtime_commit,
                                   status, requested_by, last_heartbeat)
         VALUES ($1, 'root', 0, $2, $3, $4, $5, 'active', $3, now()) RETURNING *`,
        [id, params.name, params.walletAddress, params.runtimeVersion ?? null, params.runtimeCommit ?? null],
      );
      await this.event(c, "root_registered", id, params.walletAddress, { name: params.name });
      return { ok: true, agent: toAgent(ins.rows[0]), created: true };
    });
  }

  /** A child confirms the identity its parent assigned. No inserts. */
  async attachAgent(agentId: string, walletAddress: string): Promise<RegisterResult> {
    return this.read(async (c): Promise<RegisterResult> => {
      const r = await c.query<AgentRow>("SELECT * FROM fleet_agents WHERE agent_id = $1", [agentId]);
      const row = r.rows[0];
      if (!row) return { ok: false, code: "FLEET_NOT_REGISTERED", reason: `Agent ${agentId} is not in the fleet registry.` };
      if (!row.wallet_address || row.wallet_address.toLowerCase() !== walletAddress.toLowerCase()) {
        return { ok: false, code: "FLEET_IDENTITY_MISMATCH", reason: "Wallet does not match the registered agent." };
      }
      if (row.status !== "active" && row.status !== "unresponsive") {
        return { ok: false, code: "FLEET_AGENT_DEAD", reason: `Agent ${agentId} is ${row.status}.` };
      }
      return { ok: true, agent: toAgent(row), created: false };
    });
  }

  /**
   * Operator-only: issue (or rotate) the bearer credential of a living agent.
   * The token is returned once; only its SHA-256 is stored.
   */
  async issueCredential(agentId: string, actor: string): Promise<FleetCredential> {
    return this.tx(async (c) => this.issueCredentialTx(c, agentId, actor));
  }

  private async issueCredentialTx(c: PoolClient, agentId: string, actor: string | null): Promise<FleetCredential> {
    const a = await c.query<{ status: string }>("SELECT status FROM fleet_agents WHERE agent_id = $1 FOR UPDATE", [agentId]);
    if (!a.rowCount || !["active", "unresponsive"].includes(a.rows[0].status)) {
      throw new Error(`Cannot issue a credential for ${agentId}: agent is not living.`);
    }
    const token = mintAgentToken(agentId);
    await c.query(
      `INSERT INTO fleet_agent_credentials (agent_id, token_hash) VALUES ($1, $2)
       ON CONFLICT (agent_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = now(), revoked_at = NULL`,
      [agentId, hashAgentToken(token)],
    );
    await this.event(c, "credential_issued", agentId, actor, {});
    return { agentId, token };
  }

  // ─── Slot allocation ───────────────────────────────────────────

  /**
   * Atomically reserve a slot for a child of `parentAgentId`. Creates a
   * reservation lease that counts against the cap until it completes,
   * expires, is released, or the child dies. Runs fleet_reserve_slot(),
   * the same allocator the restricted agent API uses.
   */
  async reserveSlot(params: {
    parentAgentId: string;
    requestedBy: string;
    name: string;
    runtime: RuntimePin | null;
    requestKey?: string;
    localMaxAgents?: number;
  }): Promise<SharedReserveResult> {
    const requestKey = params.requestKey ?? ulid();
    let result: SharedReserveResult;
    try {
      result = await this.tx(async (c): Promise<SharedReserveResult> => {
        const r = await c.query<{ res: ReserveJson }>(
          "SELECT fleet_reserve_slot($1, $2, $3, $4, $5, $6, true, $7, $8, $9, $10) AS res",
          [
            params.parentAgentId,
            params.requestedBy,
            params.name,
            requestKey,
            params.localMaxAgents ?? null,
            this.reservationTtlMs,
            params.runtime?.repo ?? null,
            params.runtime?.commit ?? null,
            ulid(),
            ulid(),
          ],
        );
        const res = r.rows[0].res;
        if (!res.ok) {
          return { ok: false, code: res.code as FleetDecisionCode, reason: res.reason, living: res.living, reserved: res.reserved, max: res.max };
        }
        const agent = await c.query<AgentRow>("SELECT * FROM fleet_agents WHERE agent_id = $1", [res.agentId]);
        const agentId = res.agentId;
        const grant = createBoundGrant(res.reservationId, (localChildId) => this.claimGrant(agentId, localChildId));
        return { ok: true, grant, agent: toAgent(agent.rows[0]), lease: leaseFromReserve(res) };
      });
    } catch (err) {
      if (/FLEET_CAP_EXCEEDED/.test(pgMessage(err))) {
        const st = await this.getState().catch(() => null);
        return {
          ok: false,
          code: "FLEET_CAP_REACHED",
          reason: "Fleet cap enforced by database.",
          living: st?.livingAgents ?? -1,
          reserved: st?.reservedSlots ?? -1,
          max: st?.maxAgents ?? -1,
        };
      }
      if (/request_key/.test(pgMessage(err))) {
        return { ok: false, code: "FLEET_DUPLICATE_REQUEST", reason: "Replication request already registered.", living: -1, reserved: -1, max: -1 };
      }
      throw err;
    }
    return result;
  }

  /**
   * reserved -> provisioning, exactly once, before any sandbox exists. Moves
   * the lease to the provisioning TTL and issues the attestation nonce.
   * `parentAgentId` (API path) must equal the lease's parent.
   */
  async claimGrant(agentId: string, localChildId: string, opts: { parentAgentId?: string } = {}): Promise<ClaimedGrant> {
    const nonce = newAttestationNonce();
    const claimed = await this.tx(async (c): Promise<ClaimedGrant | string> => {
      const st = await this.lockState(c);
      const l = await c.query<LeaseRow>("SELECT * FROM fleet_reservations WHERE agent_id = $1 FOR UPDATE", [agentId]);
      const lease = l.rows[0];
      if (!lease || lease.status !== "reserved" || lease.expires_at.getTime() <= (await dbNow(c))) {
        return `Replication denied: fleet reservation ${agentId} is invalid, expired, or already used.`;
      }
      if (opts.parentAgentId !== undefined && lease.parent_agent_id !== opts.parentAgentId) {
        return `Replication denied: reservation ${lease.reservation_id} belongs to another parent.`;
      }
      const ttlMs = this.provisioningTtlMs ?? st.provisioning_ttl_s * 1000;
      const r = await c.query<AgentRow>(
        `UPDATE fleet_agents SET status = 'provisioning', local_child_id = $2, updated_at = now(),
                reservation_expires_at = now() + ($3 || ' milliseconds')::interval
          WHERE agent_id = $1 AND status = 'reserved'
          RETURNING *`,
        [agentId, localChildId, String(ttlMs)],
      );
      if (r.rowCount !== 1) return `Replication denied: fleet reservation ${agentId} is invalid, expired, or already used.`;
      await c.query(
        `UPDATE fleet_reservations SET status = 'provisioning', claimed_at = now(), attestation_nonce = $2,
                expires_at = now() + ($3 || ' milliseconds')::interval, updated_at = now()
          WHERE reservation_id = $1 AND status = 'reserved'`,
        [lease.reservation_id, nonce, String(ttlMs)],
      );
      await this.event(c, "slot_claimed", agentId, opts.parentAgentId ?? null, { localChildId, reservationId: lease.reservation_id });
      const row = r.rows[0];
      return {
        agentId,
        parentAgentId: row.parent_agent_id,
        generation: row.generation,
        runtime: { repo: lease.expected_repo, commit: lease.expected_commit },
        expectedBuild: { buildId: lease.expected_build_id, lockfileSha256: lease.expected_lockfile_sha256 },
        nonce,
        reservationId: lease.reservation_id,
        backend: "postgres",
      };
    });
    if (typeof claimed === "string") {
      await this.recordEvent("claim_denied", agentId, opts.parentAgentId ?? null, { reason: claimed }).catch(() => {});
      throw new FleetBypassError(claimed);
    }
    return claimed;
  }

  /**
   * provisioning -> active. The child must have proven its runtime identity:
   * the attestation must carry this reservation's nonce and match the
   * recorded expected repo, commit, lockfile and build identifier. Any
   * mismatch stops activation, releases the slot and marks the provisioning
   * failed (runtime_verification_failed). Issues the child's credential.
   */
  async activate(
    agentId: string,
    params: {
      walletAddress: string;
      sandboxId?: string | null;
      runtimeCommit?: string | null;
      runtimeVersion?: string | null;
      attestation?: RuntimeAttestation | null;
      parentAgentId?: string;
      actor?: string | null;
    },
  ): Promise<ActivationResult> {
    let verificationFailure: string | null = null;
    try {
      return await this.tx(async (c) => {
        await this.lockState(c);
        const cur = await c.query<AgentRow>("SELECT * FROM fleet_agents WHERE agent_id = $1 FOR UPDATE", [agentId]);
        const row = cur.rows[0];
        if (!row || row.status !== "provisioning") {
          throw new Error(`Cannot activate fleet agent ${agentId}: not in provisioning state`);
        }
        const l = await c.query<LeaseRow>("SELECT * FROM fleet_reservations WHERE agent_id = $1 FOR UPDATE", [agentId]);
        const lease = l.rows[0];
        if (!lease || lease.status !== "provisioning") {
          throw new Error(`Cannot activate fleet agent ${agentId}: no open provisioning lease`);
        }
        if (params.parentAgentId !== undefined && lease.parent_agent_id !== params.parentAgentId) {
          throw new FleetBypassError(`Activation denied: reservation ${lease.reservation_id} belongs to another parent.`);
        }
        if (lease.expires_at.getTime() <= (await dbNow(c))) {
          throw new FleetBypassError(`Activation denied: provisioning lease ${lease.reservation_id} has expired.`);
        }
        let attestation: RuntimeAttestation;
        try {
          if (!params.runtimeCommit || params.runtimeCommit !== lease.expected_commit) {
            throw new FleetRuntimeError(
              `Cannot activate fleet agent ${agentId}: verified runtime ${params.runtimeCommit ?? "<none>"} != pinned ${lease.expected_commit}`,
            );
          }
          attestation = checkAttestation(params.attestation ? sanitizeAttestation(params.attestation) : null, {
            repo: lease.expected_repo,
            commit: lease.expected_commit,
            buildId: lease.expected_build_id,
            lockfileSha256: lease.expected_lockfile_sha256,
            nonce: lease.attestation_nonce ?? "",
          });
        } catch (err) {
          verificationFailure = err instanceof Error ? err.message : String(err);
          throw err;
        }
        const upd = await c.query<AgentRow>(
          `UPDATE fleet_agents SET status = 'active', wallet_address = $2, sandbox_id = $3, runtime_version = $4,
                  last_heartbeat = now(), reservation_expires_at = NULL, updated_at = now()
            WHERE agent_id = $1 AND status = 'provisioning' RETURNING *`,
          [agentId, params.walletAddress, params.sandboxId ?? null, attestation.version ?? params.runtimeVersion ?? null],
        );
        await c.query(
          `UPDATE fleet_reservations SET status = 'completed', completed_at = now(), attested_at = now(),
                  attestation = $2, updated_at = now()
            WHERE reservation_id = $1 AND status = 'provisioning'`,
          [lease.reservation_id, JSON.stringify(attestation)],
        );
        await this.event(c, "runtime_verified", agentId, params.actor ?? null, {
          reservationId: lease.reservation_id,
          commit: attestation.commit,
          buildId: attestation.buildId,
          lockfileSha256: attestation.lockfileSha256,
        });
        await this.event(c, "agent_activated", agentId, params.actor ?? null, {
          walletAddress: params.walletAddress,
          sandboxId: params.sandboxId ?? null,
          runtimeCommit: attestation.commit,
        });
        const credential = await this.issueCredentialTx(c, agentId, params.actor ?? null);
        return { agent: toAgent(upd.rows[0]), credential };
      });
    } catch (err) {
      if (verificationFailure !== null) {
        await this.recordVerificationFailure(agentId, verificationFailure).catch(() => {});
      }
      const e = err as { code?: string; constraint?: string };
      if (e.code === "23505") {
        throw new FleetDuplicateRegistrationError(
          `Duplicate child registration rejected for ${agentId} (${e.constraint ?? "unique constraint"}).`,
        );
      }
      throw err;
    }
  }

  /**
   * Runtime verification failed: stop activation, release the reservation
   * and mark the provisioning failed. Idempotent.
   */
  async recordVerificationFailure(agentId: string, reason: string, actor: string | null = null): Promise<boolean> {
    return this.tx(async (c) => {
      await this.event(c, "runtime_verification_failed", agentId, actor, { reason: scrubText(reason) });
      const r = await c.query<{ ok: boolean }>("SELECT fleet_release($1, $2, 'failed', $3) AS ok", [
        agentId,
        scrubText(`runtime verification failed: ${reason}`),
        actor,
      ]);
      return r.rows[0].ok;
    });
  }

  /** reserved/provisioning -> failed. Returns false if already released/active/dead (no double release). */
  async releaseReservation(agentId: string, reason: string, actor: string | null = null): Promise<boolean> {
    return this.tx(async (c) => {
      const r = await c.query<{ ok: boolean }>("SELECT fleet_release($1, $2, 'released', $3) AS ok", [agentId, scrubText(reason), actor]);
      return r.rows[0].ok;
    });
  }

  /** Record a death. The row is retained forever and no longer counts; the credential is revoked. Idempotent. */
  async markDead(agentId: string, reason: string, actor?: string, cause = "reported"): Promise<boolean> {
    return this.tx(async (c) => {
      const r = await c.query<{ ok: boolean }>("SELECT fleet_mark_dead($1, $2, $3, $4) AS ok", [
        agentId,
        scrubText(reason),
        actor ?? null,
        cause,
      ]);
      return r.rows[0].ok;
    });
  }

  async markDeadByLocalChildId(localChildId: string, reason: string): Promise<boolean> {
    const agent = await this.read(async (c) =>
      c.query<{ agent_id: string }>("SELECT agent_id FROM fleet_agents WHERE local_child_id = $1", [localChildId]),
    );
    const id = agent.rows[0]?.agent_id;
    return id ? this.markDead(id, reason, undefined, "child_lifecycle") : false;
  }

  /** Update last_heartbeat of a living agent (unresponsive agents recover). Never inserts. */
  async heartbeat(agentId: string): Promise<boolean> {
    return this.tx(async (c) => {
      const r = await c.query<{ s: string | null }>("SELECT fleet_heartbeat($1, $1) AS s", [agentId]);
      return r.rows[0].s === "active";
    });
  }

  async selfStatus(agentId: string): Promise<SharedAgentStatus | null> {
    return (await this.getAgent(agentId))?.status ?? null;
  }

  /**
   * One reaper pass: expire leases, then ACTIVE -> UNRESPONSIVE -> DEAD for
   * missed heartbeats. Safe to run concurrently and repeatedly.
   */
  async reap(actor = "reaper"): Promise<ReapResult> {
    return this.tx(async (c) => {
      const r = await c.query<{ res: { expired: number; unresponsive: number; dead: number; graceFrom: string | null } }>(
        "SELECT fleet_reap($1) AS res",
        [actor],
      );
      return r.rows[0].res;
    });
  }

  /** Append an audit event (service-level events: API auth failures, DB authorization failures, …). */
  async recordEvent(eventType: string, agentId: string | null, actor: string | null, detail: Record<string, unknown> = {}): Promise<void> {
    await this.tx(async (c) => this.event(c, eventType, agentId, actor, detail));
  }

  async getReservation(idOrAgentId: string): Promise<ReservationLease | null> {
    return this.read(async (c) => {
      const r = await c.query<LeaseRow>(
        "SELECT * FROM fleet_reservations WHERE reservation_id = $1 OR agent_id = $1",
        [idOrAgentId],
      );
      return r.rows[0] ? toLease(r.rows[0]) : null;
    });
  }

  async listReservations(filter?: { open?: boolean }): Promise<ReservationLease[]> {
    const where = filter?.open ? "WHERE status IN ('reserved','provisioning')" : "";
    return this.read(async (c) => {
      const r = await c.query<LeaseRow>(`SELECT * FROM fleet_reservations ${where} ORDER BY created_at, reservation_id`);
      return r.rows.map(toLease);
    });
  }

  // ─── Queries ───────────────────────────────────────────────────

  async getAgent(agentId: string): Promise<SharedAgentRecord | null> {
    return this.read(async (c) => {
      const r = await c.query<AgentRow>("SELECT * FROM fleet_agents WHERE agent_id = $1", [agentId]);
      return r.rows[0] ? toAgent(r.rows[0]) : null;
    });
  }

  async listAgents(filter?: { living?: boolean }): Promise<SharedAgentRecord[]> {
    const where = filter?.living === undefined
      ? ""
      : filter.living
        ? "WHERE status IN ('reserved','provisioning','active','unresponsive')"
        : "WHERE status IN ('dead','failed')";
    return this.read(async (c) => {
      const r = await c.query<AgentRow>(`SELECT * FROM fleet_agents ${where} ORDER BY created_at, agent_id`);
      return r.rows.map(toAgent);
    });
  }

  async getEvents(agentId?: string): Promise<Array<{ eventType: string; agentId: string | null; detail: Record<string, unknown> }>> {
    return this.read(async (c) => {
      const r = agentId
        ? await c.query("SELECT * FROM fleet_events WHERE agent_id = $1 ORDER BY id", [agentId])
        : await c.query("SELECT * FROM fleet_events ORDER BY id");
      return r.rows.map((e) => ({ eventType: e.event_type, agentId: e.agent_id, detail: e.detail }));
    });
  }

  /** Public wallet addresses of every fleet agent (any status). */
  async listMemberAddresses(): Promise<string[]> {
    return this.read(async (c) => {
      const r = await c.query<{ a: string }>(
        "SELECT lower(wallet_address) AS a FROM fleet_agents WHERE wallet_address IS NOT NULL",
      );
      return r.rows.map((x) => x.a);
    });
  }
}
