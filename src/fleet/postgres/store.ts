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
import { redactDetail, redactText } from "../redact.js";
import { FleetRuntimeError, normalizeRepoUrl, type RuntimePin } from "../runtime.js";
import {
  checkAttestation,
  newAttestationNonce,
  sanitizeAttestation,
  type RuntimeAttestation,
  type RuntimeBuild,
} from "../attestation.js";
import type {
  ActivationResult,
  FleetCapabilityScope,
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
import { migrateCheck,
  AGENT_API_FUNCTIONS,
  CUSTODY_API_FUNCTIONS,
  FLEET_PG_HARD_MAX_AGENTS,
  FLEET_PG_SCHEMA_VERSION,
  OPERATOR_API_FUNCTIONS,
  SERVICE_API_FUNCTIONS,
  SERVICE_READ_TABLES,
  migrate,
  quoteIdent,
} from "./migrations.js";
import { agentFromJson } from "./agent-gateway.js";
import { auditPrivileges, type PrivilegeAuditOptions, type PrivilegeAuditResult } from "./privileges.js";

export const DEFAULT_FLEET_PG_SCHEMA = "fleet";
/** Default lease TTLs live in fleet_state (reservation_ttl_s = 30 min, provisioning_ttl_s = 45 min). */
export const DEFAULT_RESERVATION_TTL_MS = 30 * 60_000;
export const DEFAULT_AGENT_ROLE = "fleet_agent";
export const DEFAULT_SERVICE_ROLE = "fleet_service";
/** Schema v8: read-only Operator API role (granted op_* only). */
export const DEFAULT_OPERATOR_ROLE = "fleet_operator";
/** Schema v10: inert custody executor role (granted cx_* only). */
export const DEFAULT_CUSTODY_ROLE = "fleet_custody";

export interface FleetTimeouts {
  reservationTtlS: number;
  provisioningTtlS: number;
  heartbeatUnresponsiveS: number;
  heartbeatDeadS: number;
  parentReportQuietS: number;
}

export interface SandboxTerminationRecord {
  agentId: string;
  sandboxId: string;
  status: "pending" | "terminated" | "unsupported" | "failed";
  requestedAt: string;
  attempts: number;
  lastError: string | null;
}

/** Bearer token format: fa1.<agentId>.<43 chars base64url>. */
const TOKEN_RE = /^fa1\.([0-9A-HJKMNP-TV-Z]{26})\.[A-Za-z0-9_-]{43}$/;

/** Schema v15 inference outcome (see migrations-phase15.ts for the charge rule). */
export interface CognitionRecord {
  outcome: "ok" | "error";
  inputTokens: number;
  outputTokens: number;
  promptSha256: string;
  responseSha256: string;
  toolCalls: unknown[];
  errorCode: string | null;
  usageSource: "provider" | "estimate" | "none";
  attempts: number;
  providerStatus?: number | null;
  responseModel?: string | null;
  latencyMs?: number | null;
  /** v16: cached input, separate from inputTokens. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  providerRequestId?: string | null;
  stopReason?: string | null;
}

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

/** Short-lived session token format (Phase 5): fs1.<agentId>.<43 chars base64url>. */
const SESSION_RE = /^fs1\.([0-9A-HJKMNP-TV-Z]{26})\.[A-Za-z0-9_-]{43}$/;

export function mintSessionToken(agentId: string): string {
  return `fs1.${agentId}.${crypto.randomBytes(32).toString("base64url")}`;
}

export function agentIdFromSessionToken(token: string): string | null {
  return SESSION_RE.exec(token)?.[1] ?? null;
}

/** Canary commands a healthy agent's policy guard must refuse (health challenge). */
export const HEALTH_CANARIES: readonly string[] = Object.freeze([
  "cat /etc/automaton-fleet/service.env",
  "cat ~/.automaton/fleet-credentials.json",
  "psql -c 'GRANT fleet_service TO fleet_agent_login'",
  "cat /proc/1/environ",
  "sudo scripts/fleet-db-setup.sh --apply",
]);

export interface LifecyclePolicy {
  healthChallengeIntervalS: number;
  challengeTtlS: number;
  healthGraceS: number;
  maxChallengeFailures: number;
  terminationGraceS: number;
  orphanSlotHoldS: number;
  maxOpenOrphans: number;
  sessionTtlS: number;
}

/** Phase 6: the durable record of an intended (possibly created) sandbox. */
export interface SandboxIntent {
  provisioningKey: string;
  /** Deterministic sandbox name: fleet-<lower(provisioningKey)>. */
  sandboxName: string;
  /** Set when the controller already knows the sandbox: reuse it, never create another. */
  sandboxId: string | null;
  /** Create attempts recorded so far, including this one. */
  attempts: number;
}

export interface HealthChallenge {
  challengeId: string;
  nonce: string;
  canary: string;
  expiresAt: string;
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
  /** Restricted controller role granted the service API on migrate (if it exists). */
  serviceRole?: string;
  /** Read-only Operator API role granted op_* on migrate (if it exists). */
  operatorRole?: string;
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
  capability_scope?: FleetCapabilityScope;
}

interface StateRow {
  living_agents: number;
  reserved_slots: number;
  quarantined_slots?: number;
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
  parent_report_quiet_s: number;
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
    ...(r.capability_scope ? { capabilityScope: r.capability_scope } : {}),
  };
}

function toState(r: StateRow): SharedFleetState {
  return {
    livingAgents: r.living_agents,
    reservedSlots: r.reserved_slots,
    quarantinedSlots: r.quarantined_slots ?? 0,
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
// Thin wrappers over the canonical redactor (src/fleet/redact.ts), kept for
// existing call sites.

export function scrubText(s: string): string {
  return redactText(s);
}

export function scrubDetail(detail: Record<string, unknown>): Record<string, unknown> {
  return redactDetail(detail);
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
  readonly serviceRole: string;
  readonly operatorRole: string;
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
    this.serviceRole = opts.serviceRole ?? DEFAULT_SERVICE_ROLE;
    quoteIdent(this.serviceRole);
    this.operatorRole = opts.operatorRole ?? DEFAULT_OPERATOR_ROLE;
    quoteIdent(this.operatorRole);
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
   * Operator (admin/owner) store from FLEET_ADMIN_DATABASE_URL, or the
   * legacy FLEET_CONTROLLER_DATABASE_URL / DATABASE_URL. Null when
   * unconfigured. Never used by agents or by the fleet service.
   */
  static fromEnv(env: Record<string, string | undefined> = process.env): PgFleetStore | null {
    const url = (env.FLEET_ADMIN_DATABASE_URL || env.FLEET_CONTROLLER_DATABASE_URL || env.DATABASE_URL)?.trim();
    if (!url) return null;
    return new PgFleetStore({
      connectionString: url,
      schema: env.FLEET_PG_SCHEMA?.trim() || undefined,
      agentRole: env.FLEET_AGENT_ROLE?.trim() || undefined,
      serviceRole: env.FLEET_SERVICE_ROLE?.trim() || undefined,
      operatorRole: env.FLEET_OPERATOR_ROLE?.trim() || undefined,
      applicationName: "automaton-fleet-admin",
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

  /**
   * Operator-only: apply schema migrations, then (re)grant the agent and
   * service APIs to the restricted roles that exist. Requires the privileged
   * admin credential: the connected role must own the schema (or, before the
   * first migration, be able to create it). Restricted credentials are refused.
   */
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
      .query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname = ANY($1)", [[this.agentRole, this.serviceRole, this.operatorRole, DEFAULT_CUSTODY_ROLE]])
      .catch(() => null);
    const present = new Set(roles?.rows.map((r) => r.rolname) ?? []);
    if (present.has(this.agentRole)) await this.grantAgentRole(this.agentRole);
    if (present.has(this.serviceRole)) await this.grantServiceRole(this.serviceRole);
    if (present.has(this.operatorRole)) await this.grantOperatorRole(this.operatorRole);
    if (present.has(DEFAULT_CUSTODY_ROLE)) await this.grantCustodyRole(DEFAULT_CUSTODY_ROLE);
    return applied;
  }

  /** Phase 6: apply pending migrations in one transaction and roll back (verification only). */
  async migrateCheck(): Promise<{ currentVersion: number | null; resultingVersion: number; wouldApply: number[] }> {
    const client = await this.connect();
    try {
      await this.assertAdminConnection(client);
      return await migrateCheck(client, this.schema);
    } finally {
      client.release();
    }
  }

  /** Throws unless the connection holds the privileged admin (schema owner) role. */
  private async assertAdminConnection(c: PoolClient): Promise<void> {
    const r = await c.query<{ u: string; owner: string | null; can_create: boolean }>(
      `SELECT current_user AS u,
              (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = $1) AS owner,
              has_database_privilege(current_database(), 'CREATE') AS can_create`,
      [this.schema],
    );
    const row = r.rows[0];
    const isAdmin = row.owner ? row.owner === row.u : row.can_create;
    if (!isAdmin) {
      throw new Error(
        `Refusing to migrate as ${row.u}: administrative migrations require the privileged admin credential ` +
          `(FLEET_ADMIN_DATABASE_URL; owner of schema ${this.schema}).`,
      );
    }
  }

  // ─── Connection identity / privileges ──────────────────────────

  /** Who this store is connected as, and whether that is the schema owner or a superuser. */
  async connectionIdentity(): Promise<{ user: string; schemaOwner: string | null; isOwner: boolean; superuser: boolean }> {
    const r = await this.pool.query<{ u: string; owner: string | null; su: boolean }>(
      `SELECT current_user AS u, (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = $1) AS owner,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su`,
      [this.schema],
    );
    const row = r.rows[0];
    return { user: row.u, schemaOwner: row.owner, isOwner: row.owner === row.u, superuser: row.su === true };
  }

  /** Effective privilege audit of the restricted roles (see privileges.ts). */
  async auditPrivileges(opts: Omit<PrivilegeAuditOptions, "schema"> = {}): Promise<PrivilegeAuditResult> {
    return auditPrivileges(this.pool, { schema: this.schema, ...opts });
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
        `SELECT s.living_agents = (SELECT count(*) FROM fleet_agents WHERE status IN ('active','unresponsive','terminating'))
            AND s.reserved_slots = (SELECT count(*) FROM fleet_agents WHERE status IN ('reserved','provisioning'))
            AND s.quarantined_slots = (SELECT count(*) FROM fleet_agents WHERE status = 'orphaned')
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
        parentReportQuietS: t.parentReportQuietS ?? prev.parent_report_quiet_s,
      };
      for (const [k, v] of Object.entries(next)) {
        if (!Number.isSafeInteger(v) || v < 1) throw new Error(`Invalid timeout ${k}: ${v}`);
      }
      await c.query(
        `UPDATE fleet_state SET reservation_ttl_s = $1, provisioning_ttl_s = $2, heartbeat_unresponsive_s = $3,
                heartbeat_dead_s = $4, parent_report_quiet_s = $5, updated_at = now() WHERE id = 1`,
        [next.reservationTtlS, next.provisioningTtlS, next.heartbeatUnresponsiveS, next.heartbeatDeadS, next.parentReportQuietS],
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
        parentReportQuietS: s.parent_report_quiet_s,
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

  /**
   * Operator-only (schema v10): give `role` exactly the custody executor
   * protocol — USAGE on the schema and EXECUTE on CUSTODY_API_FUNCTIONS. No
   * table, sequence or other function privilege. Re-running is harmless.
   */
  async grantCustodyRole(role: string = DEFAULT_CUSTODY_ROLE): Promise<void> {
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
      for (const fn of CUSTODY_API_FUNCTIONS) await c.query(`GRANT EXECUTE ON FUNCTION ${s}.${fn} TO ${r}`);
      await this.event(c, "custody_role_granted", null, "operator", { role, functions: [...CUSTODY_API_FUNCTIONS] });
    });
  }

  /**
   * Operator API overview for doctor (schema v8). Needs the admin (owner)
   * credential; returns null when the tables are not visible (e.g. doctor
   * runs with the service credential).
   */
  async operatorOverview(): Promise<{
    enabled: boolean;
    generation: number;
    requestCount: number;
    requestCap: number;
    activePrincipals: number;
    activeKeys: number;
    keysExpiringSoon: number;
    recentDenials: number;
    /** Schema v9 (Phase D3): the mutation kill switch and proposals awaiting the owner. */
    actionsEnabled: boolean;
    pendingProposals: number;
  } | null> {
    try {
      return await this.read(async (c) => {
        const r = await c.query<{
          enabled: boolean; generation: string; request_count: string; request_cap: string;
          principals: string; keys: string; expiring: string; denials: string; actions: boolean; proposals: string;
        }>(
          `SELECT s.operator_api_enabled AS enabled, s.generation, s.request_count, s.request_cap,
                  s.operator_actions_enabled AS actions,
                  (SELECT count(*) FROM fleet_operator_proposals WHERE status = 'pending' AND expires_at > now()) AS proposals,
                  (SELECT count(*) FROM fleet_operator_principals WHERE revoked_at IS NULL) AS principals,
                  (SELECT count(*) FROM fleet_operator_keys k JOIN fleet_operator_principals p USING (principal_id)
                    WHERE k.revoked_at IS NULL AND p.revoked_at IS NULL AND now() < k.expires_at) AS keys,
                  (SELECT count(*) FROM fleet_operator_keys k JOIN fleet_operator_principals p USING (principal_id)
                    WHERE k.revoked_at IS NULL AND p.revoked_at IS NULL AND now() < k.expires_at
                      AND k.expires_at < now() + interval '14 days') AS expiring,
                  (SELECT count(*) FROM fleet_events WHERE event_type IN ('operator_auth_failed','operator_scope_denied','operator_replay_blocked','operator_stale',
                                                                          'operator_actions_disabled','operator_action_rate_limited')
                    AND created_at > now() - interval '10 minutes') AS denials
             FROM fleet_operator_state s WHERE s.id = 1`,
        );
        const row = r.rows[0];
        if (!row) return null;
        return {
          enabled: row.enabled,
          generation: Number(row.generation),
          requestCount: Number(row.request_count),
          requestCap: Number(row.request_cap),
          activePrincipals: Number(row.principals),
          activeKeys: Number(row.keys),
          keysExpiringSoon: Number(row.expiring),
          recentDenials: Number(row.denials),
          actionsEnabled: row.actions === true,
          pendingProposals: Number(row.proposals),
        };
      });
    } catch {
      return null;
    }
  }

  /**
   * Schema v10 ledger / custody overview for doctor. Needs the admin (owner)
   * credential; null when the ledger is not visible (service credential or
   * pre-v10 schema).
   */
  async ledgerOverview(): Promise<{
    verify: { ok: boolean; journals: number; unbalanced?: number; firstBadSeq?: number };
    custodyExecutionEnabled: boolean;
    ledgerAuthoritative: boolean;
    awaitingOwner: number;
    reserved: number;
    executing: number;
    pendingDestinations: number;
    activeDestinations: number;
    pendingConfirmations: number;
    instructions: number;
    estate: { assetsUnderDeadAgents: number; deadAgentsWithBalances: number; assetsWithoutOwner: number };
    treasuryUnallocatedCents: number;
    lifetimeFleetContributionCents: number;
  } | null> {
    try {
      return await this.read(async (c) => {
        const r = await c.query(
          `SELECT fleet_ledger_verify() AS verify, m.custody_execution_enabled, m.ledger_authoritative,
                  (SELECT count(*) FROM fleet_payment_orders WHERE status = 'awaiting_owner') AS awaiting,
                  (SELECT count(*) FROM fleet_payment_orders WHERE status = 'reserved') AS reserved,
                  (SELECT count(*) FROM fleet_payment_orders WHERE status = 'executing') AS executing,
                  (SELECT count(*) FROM fleet_payment_destinations WHERE status = 'pending') AS dst_pending,
                  (SELECT count(*) FROM fleet_payment_destinations WHERE status = 'active') AS dst_active,
                  (SELECT count(*) FROM fleet_admin_instructions WHERE status = 'pending_confirmation') AS confirmations,
                  (SELECT count(*) FROM fleet_payment_instructions) AS instructions,
                  fleet_estate_attention() AS estate,
                  fleet_ledger_balance('fleet:treasury:unallocated') AS unallocated,
                  fleet_ledger_balance('fleet:profit') AS lfc
             FROM fleet_economic_model m WHERE m.id = 1`,
        );
        const x = r.rows[0];
        if (!x) return null;
        return {
          verify: x.verify,
          custodyExecutionEnabled: x.custody_execution_enabled === true,
          ledgerAuthoritative: x.ledger_authoritative === true,
          awaitingOwner: Number(x.awaiting),
          reserved: Number(x.reserved),
          executing: Number(x.executing),
          pendingDestinations: Number(x.dst_pending),
          activeDestinations: Number(x.dst_active),
          pendingConfirmations: Number(x.confirmations),
          instructions: Number(x.instructions),
          estate: x.estate,
          treasuryUnallocatedCents: Number(x.unallocated),
          lifetimeFleetContributionCents: Number(x.lfc),
        };
      });
    } catch {
      return null;
    }
  }

  /** Schema v11 Genesis / capability / reproduction / vault / knowledge overview for doctor (admin credential; null otherwise). */
  async genesisOverview(): Promise<{
    genesisEnabled: boolean;
    inFlight: number;
    activated: number;
    founders: number;
    livingFounders: number;
    reproductionExecutionEnabled: boolean;
    founderManifestSha256: string | null;
    identityFacts: number;
    identityClaimsPending: number;
    knowledgePending: number;
    knowledgeEntries: number;
    openEstates: number;
  } | null> {
    try {
      return await this.read(async (c) => {
        const r = await c.query(
          `SELECT p.genesis_enabled,
                  (SELECT count(*) FROM fleet_genesis WHERE status IN ('approved','provisioning','attesting','funding_virtual','ready')) AS in_flight,
                  (SELECT count(*) FROM fleet_genesis WHERE status = 'activated') AS activated,
                  (SELECT count(*) FROM fleet_agents WHERE origin IN ('genesis_founder','reseed_founder')) AS founders,
                  (SELECT count(*) FROM fleet_agents WHERE origin IN ('genesis_founder','reseed_founder') AND status IN ('active','unresponsive')) AS living_founders,
                  (SELECT execution_enabled FROM fleet_reproduction_policy WHERE id = 1) AS repro,
                  (SELECT manifest_sha256 FROM fleet_capability_manifests WHERE manifest_id = 'founder-v1') AS manifest,
                  (SELECT count(*) FROM fleet_org_identity_facts) AS facts,
                  (SELECT count(*) FROM fleet_org_identity_claims WHERE status = 'requested') AS claims,
                  (SELECT count(*) FROM fleet_knowledge_proposals WHERE status = 'proposed') AS kpending,
                  (SELECT count(*) FROM fleet_knowledge_entries) AS kentries,
                  (SELECT count(*) FROM fleet_estates WHERE status = 'open') AS estates
             FROM fleet_genesis_policy p WHERE p.id = 1`,
        );
        const x = r.rows[0];
        if (!x) return null;
        return {
          genesisEnabled: x.genesis_enabled === true,
          inFlight: Number(x.in_flight),
          activated: Number(x.activated),
          founders: Number(x.founders),
          livingFounders: Number(x.living_founders),
          reproductionExecutionEnabled: x.repro === true,
          founderManifestSha256: x.manifest ?? null,
          identityFacts: Number(x.facts),
          identityClaimsPending: Number(x.claims),
          knowledgePending: Number(x.kpending),
          knowledgeEntries: Number(x.kentries),
          openEstates: Number(x.estates),
        };
      });
    } catch {
      return null;
    }
  }

  /** Schema v13: founder cognition switches and today's inference usage (null before v13). */
  async cognitionOverview(founderToolNames: readonly string[] = []): Promise<{
    enabled: boolean; provider: string; model: string; foundersEnabled: number; foundersPaused: number; callsToday: number; chargedTodayCents: number; inFlight: number;
    forbiddenRequests24h: number; foundersNearBudget: number;
  } | null> {
    try {
      return await this.read(async (c) => {
        const r = await c.query(
          `SELECT p.cognition_enabled, p.provider, p.model,
                  (SELECT count(*) FROM fleet_founder_cognition WHERE enabled) AS fen,
                  (SELECT count(*) FROM fleet_founder_cognition WHERE paused) AS fpaused,
                  (SELECT count(*) FROM fleet_cognition_log WHERE at > now() - interval '1 day') AS calls,
                  (SELECT COALESCE(sum(charged_cents), 0) FROM fleet_cognition_log WHERE at > now() - interval '1 day') AS charged,
                  (SELECT count(*) FROM fleet_cognition_inflight) AS inflight,
                  (SELECT count(*) FROM fleet_cognition_log l, jsonb_array_elements(l.tool_calls) t
                    WHERE l.at > now() - interval '1 day' AND NOT ((t ->> 'name') = ANY($1::text[]))) AS forbidden,
                  (SELECT count(*) FROM fleet_agents a WHERE a.origin IN ('genesis_founder','reseed_founder') AND a.status IN ('active','unresponsive')
                      AND (fleet_cognition_state(a.agent_id) ->> 'founderEnabled')::boolean
                      -- at ≥80% of the daily budget, or unable to afford one more maximum-length call (the estimate is reserved up front)
                      AND ((fleet_cognition_state(a.agent_id) ->> 'spentTodayCents')::bigint * 10 >= (fleet_cognition_state(a.agent_id) ->> 'dailyBudgetCents')::bigint * 8
                        OR (fleet_cognition_state(a.agent_id) ->> 'spentTodayCents')::bigint + ceil(p.max_output_tokens * p.output_microcents_per_token / 1000000.0)::bigint
                           > (fleet_cognition_state(a.agent_id) ->> 'dailyBudgetCents')::bigint)) AS near_budget
             FROM fleet_cognition_policy p WHERE p.id = 1`,
          [founderToolNames],
        );
        const x = r.rows[0];
        if (!x) return null;
        return {
          enabled: x.cognition_enabled === true,
          provider: String(x.provider),
          model: String(x.model),
          foundersEnabled: Number(x.fen),
          foundersPaused: Number(x.fpaused),
          callsToday: Number(x.calls),
          chargedTodayCents: Number(x.charged),
          inFlight: Number(x.inflight),
          forbiddenRequests24h: Number(x.forbidden),
          foundersNearBudget: Number(x.near_budget),
        };
      });
    } catch {
      return null;
    }
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
    /** Schema v7 identity scope; default 'full'. Fixed at insert, never changed. */
    capabilityScope?: FleetCapabilityScope;
  }): Promise<RegisterResult> {
    const scope: FleetCapabilityScope = params.capabilityScope ?? "full";
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
        if ((row.capability_scope ?? "full") !== scope) {
          return { ok: false, code: "FLEET_IDENTITY_MISMATCH", reason: `Wallet is registered with capability scope ${row.capability_scope ?? "full"}, not ${scope}.` };
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
      if (st.living_agents + st.reserved_slots + (st.quarantined_slots ?? 0) >= max) {
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
                                   status, requested_by, last_heartbeat, capability_scope)
         VALUES ($1, 'root', 0, $2, $3, $4, $5, 'active', $3, now(), $6) RETURNING *`,
        [id, params.name, params.walletAddress, params.runtimeVersion ?? null, params.runtimeCommit ?? null, scope],
      );
      await this.event(c, "root_registered", id, params.walletAddress, { name: params.name, capabilityScope: scope });
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
    return this.tx(async (c) => {
      const cred = await this.issueCredentialTx(c, agentId, actor);
      // Rotation invalidates every session opened with the previous credential.
      await c.query("UPDATE fleet_agent_sessions SET revoked_at = now() WHERE agent_id = $1 AND revoked_at IS NULL", [agentId]);
      return cred;
    });
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
   * Operator-only (admin credential): reserve the single DRY_RUN_CHILD slot
   * under a living root. Independent of the replication switch; the child
   * can never replicate or spend (enforced by the database).
   */
  async reserveDryRunSlot(params: { parentAgentId: string; requestedBy: string; name: string }): Promise<SharedReserveResult> {
    return this.tx(async (c): Promise<SharedReserveResult> => {
      const r = await c.query<{ res: ReserveJson }>("SELECT fleet_reserve_dry_run($1, $2, $3, $4, $5, $6) AS res", [
        params.parentAgentId, params.requestedBy, params.name, ulid(), ulid(), this.reservationTtlMs,
      ]);
      const res = r.rows[0].res;
      if (!res.ok) {
        return { ok: false, code: res.code as FleetDecisionCode, reason: res.reason, living: res.living, reserved: res.reserved, max: res.max };
      }
      const agent = await c.query<AgentRow>("SELECT * FROM fleet_agents WHERE agent_id = $1", [res.agentId]);
      const agentId = res.agentId;
      const grant = createBoundGrant(res.reservationId, (localChildId) => this.claimGrant(agentId, localChildId));
      return { ok: true, grant, agent: toAgent(agent.rows[0]), lease: leaseFromReserve(res) };
    });
  }

  /**
   * reserved -> provisioning, exactly once, before any sandbox exists. Moves
   * the lease to the provisioning TTL and issues the attestation nonce.
   * `parentAgentId` (API path) must equal the lease's parent. Runs
   * svc_claim(), so the restricted service role can do it.
   */
  async claimGrant(agentId: string, localChildId: string, opts: { parentAgentId?: string } = {}): Promise<ClaimedGrant> {
    const nonce = newAttestationNonce();
    const r = await this.tx(async (c) =>
      c.query<{ res: { ok: boolean; reason?: string; parentAgentId?: string; generation?: number; reservationId?: string;
                       repo?: string; commit?: string; buildId?: string; lockfileSha256?: string } }>(
        "SELECT svc_claim($1, $2, $3, $4, $5) AS res",
        [agentId, localChildId, opts.parentAgentId ?? null, this.provisioningTtlMs, nonce],
      ),
    );
    const res = r.rows[0].res;
    if (!res.ok) {
      const reason = res.reason ?? `Replication denied: fleet reservation ${agentId} is invalid, expired, or already used.`;
      await this.recordEvent("claim_denied", agentId, opts.parentAgentId ?? null, { reason }).catch(() => {});
      throw new FleetBypassError(reason);
    }
    const parent = opts.parentAgentId ?? null;
    return {
      agentId,
      parentAgentId: res.parentAgentId!,
      generation: res.generation!,
      runtime: { repo: res.repo!, commit: res.commit! },
      expectedBuild: { buildId: res.buildId!, lockfileSha256: res.lockfileSha256! },
      nonce,
      reservationId: res.reservationId!,
      provisioningKey: res.reservationId!,
      backend: "postgres",
      reportProvisioning: async (phase, sandboxId) => {
        await this.reportProvisioning(agentId, phase, sandboxId ?? null, parent);
      },
      recordSandboxIntent: (sandboxName) => this.recordSandboxIntent(agentId, sandboxName, parent),
      reconcileProvisioning: (outcome, sandboxId) =>
        this.reconcileProvisioning(res.reservationId!, outcome, sandboxId ?? null, parent ?? "controller").then(() => undefined),
    };
  }

  // ─── Phase 5: provisioning, health, sessions, termination ──────

  /** Record provisioning progress (svc_provision_update). Throws if refused. */
  async reportProvisioning(
    agentId: string,
    phase: "sandbox_intent" | "sandbox_created" | "verifying",
    sandboxId: string | null,
    parentAgentId: string | null,
  ): Promise<Record<string, unknown>> {
    const r = await this.tx(async (c) =>
      (await c.query("SELECT svc_provision_update($1, $2, $3, $4) AS r", [agentId, parentAgentId, phase, sandboxId])).rows[0].r,
    );
    if (!r.ok) throw new FleetBypassError(`Provisioning update refused: ${r.code}${r.reason ? ` (${r.reason})` : ""}`);
    return r;
  }

  /**
   * Phase 6: durable external-resource intent, recorded BEFORE the sandbox is
   * created. Returns the attempt number and, when the controller already
   * knows the sandbox, its id (the caller must reuse it, never create another).
   */
  async recordSandboxIntent(agentId: string, sandboxName: string, parentAgentId: string | null): Promise<SandboxIntent> {
    const r = await this.reportProvisioning(agentId, "sandbox_intent", sandboxName, parentAgentId);
    return {
      provisioningKey: String(r.provisioningKey),
      sandboxName: String(r.sandboxName),
      sandboxId: typeof r.sandboxId === "string" ? r.sandboxId : null,
      attempts: Number(r.attempts),
    };
  }

  /** Phase 6: record the outcome of looking up an uncertain sandbox (svc_provision_reconcile). */
  async reconcileProvisioning(
    provisioningKey: string,
    outcome: "found" | "absent" | "unknown",
    sandboxId: string | null,
    actor: string,
  ): Promise<{ ok: boolean; code?: string; reason?: string; agentStatus?: string }> {
    const r = await this.tx(async (c) =>
      (await c.query("SELECT svc_provision_reconcile($1, $2, $3, $4) AS r", [provisioningKey, outcome, sandboxId, actor])).rows[0].r,
    );
    if (!r.ok) throw new FleetBypassError(`Provisioning reconciliation refused: ${r.code}${r.reason ? ` (${r.reason})` : ""}`);
    return r;
  }

  /** Phase 6: liveness, health and spend authority of one agent (dry-run verification, doctor). */
  async agentAuthority(agentId: string): Promise<{
    status: string;
    dryRun: boolean;
    lastHeartbeat: string | null;
    lastChallengeOkAt: string | null;
    spendingFrozen: boolean | null;
    dailyLimitCents: number | null;
    credentialLive: boolean;
    sandboxId: string | null;
  } | null> {
    return this.read(async (c) => {
      const r = await c.query(
        `SELECT a.status, a.dry_run, a.last_heartbeat, a.last_challenge_ok_at, a.sandbox_id,
                w.spending_frozen, w.daily_limit_cents,
                EXISTS (SELECT 1 FROM fleet_agent_credentials k WHERE k.agent_id = a.agent_id AND k.revoked_at IS NULL) AS cred
           FROM fleet_agents a LEFT JOIN fleet_wallet_custody w ON w.agent_id = a.agent_id WHERE a.agent_id = $1`,
        [agentId],
      );
      const x = r.rows[0];
      if (!x) return null;
      return {
        status: x.status,
        dryRun: x.dry_run,
        lastHeartbeat: iso(x.last_heartbeat),
        lastChallengeOkAt: iso(x.last_challenge_ok_at),
        spendingFrozen: x.spending_frozen ?? null,
        dailyLimitCents: x.daily_limit_cents === null || x.daily_limit_cents === undefined ? null : Number(x.daily_limit_cents),
        credentialLive: x.cred,
        sandboxId: x.sandbox_id,
      };
    });
  }

  /** Provisioning attempts whose sandbox may exist but was never identified. */
  async listUncertainProvisioning(): Promise<Array<Record<string, unknown>>> {
    return this.read(async (c) =>
      (await c.query(
        `SELECT p.*, a.status AS agent_status FROM fleet_provisioning p JOIN fleet_agents a ON a.agent_id = p.expected_agent_id
          WHERE p.sandbox_id IS NULL AND p.external_state IN ('intent','uncertain')
            AND (a.status NOT IN ('reserved','provisioning') OR p.activation_deadline <= now())
          ORDER BY p.created_at`,
      )).rows,
    );
  }

  async listProvisioning(filter: { needsCleanup?: boolean } = {}): Promise<Array<Record<string, unknown>>> {
    const where = filter.needsCleanup ? "WHERE cleanup_status IN ('pending','unsupported','failed')" : "";
    return this.read(async (c) => (await c.query(`SELECT * FROM fleet_provisioning ${where} ORDER BY created_at`)).rows);
  }

  async listOrphans(filter: { open?: boolean } = {}): Promise<Array<Record<string, unknown>>> {
    const where = filter.open ? "WHERE resolved_at IS NULL" : "";
    return this.read(async (c) => (await c.query(`SELECT * FROM fleet_orphans ${where} ORDER BY detected_at`)).rows);
  }

  /** Replay protection: true the first time (agent, nonce) is seen. */
  async consumeNonce(agentId: string, nonce: string, ttlS: number): Promise<boolean> {
    return this.svcBool("SELECT svc_consume_nonce($1, $2, $3) AS ok", [agentId, nonce, ttlS]);
  }

  /** Issue a health challenge if one is due. The nonce is returned once; only its hash is stored. */
  async issueChallenge(agentId: string): Promise<HealthChallenge | null> {
    const nonce = crypto.randomBytes(32).toString("base64url");
    const challengeId = ulid();
    const canary = HEALTH_CANARIES[crypto.randomInt(HEALTH_CANARIES.length)];
    const r = await this.tx(async (c) =>
      (await c.query("SELECT svc_issue_challenge($1, $2, $3, $4) AS r", [agentId, challengeId, hashAgentToken(nonce), canary])).rows[0].r,
    );
    return r.issued ? { challengeId, nonce, canary, expiresAt: new Date(r.expiresAt).toISOString() } : null;
  }

  async answerChallenge(
    agentId: string,
    answer: { challengeId: string; nonce: string; commit: string | null; buildId: string | null; policyOk: boolean },
  ): Promise<{ ok: boolean; code?: string; reason?: string }> {
    return this.tx(async (c) =>
      (
        await c.query("SELECT svc_answer_challenge($1, $2, $3, $4, $5, $6) AS r", [
          agentId, answer.challengeId, answer.nonce, answer.commit, answer.buildId, answer.policyOk === true,
        ])
      ).rows[0].r,
    );
  }

  /** Operator-only: quarantine an agent now (revoke everything; terminate its sandbox). */
  async quarantine(agentId: string, reason: string, actor: string): Promise<string | null> {
    return this.tx(async (c) => {
      const r = await c.query<{ s: string | null }>("SELECT fleet_begin_termination($1, $2, $3, 'quarantine') AS s", [agentId, scrubText(reason), actor]);
      await this.event(c, "agent_quarantined", agentId, actor, { reason, result: r.rows[0].s });
      return r.rows[0].s;
    });
  }

  /** Operator-only: resolve an orphan after external cleanup was confirmed. */
  async resolveOrphan(agentId: string, resolution: string, actor: string): Promise<boolean> {
    return this.tx(async (c) => {
      await this.lockState(c);
      const o = await c.query(
        "UPDATE fleet_orphans SET resolved_at = now(), resolution = $2, resolved_by = $3 WHERE agent_id = $1 AND resolved_at IS NULL RETURNING orphan_id",
        [agentId, scrubText(resolution), actor],
      );
      if (!o.rowCount) return false;
      await c.query(
        `UPDATE fleet_agents SET status = 'dead', death_time = now(), updated_at = now(),
                status_reason = left(COALESCE(status_reason, '') || '; orphan resolved: ' || $2, 500)
          WHERE agent_id = $1 AND status = 'orphaned'`,
        [agentId, scrubText(resolution)],
      );
      await c.query(
        "UPDATE fleet_sandbox_terminations SET status = 'terminated', completed_at = now(), last_error = $2 WHERE agent_id = $1 AND status <> 'terminated'",
        [agentId, `operator confirmed: ${scrubText(resolution)}`],
      );
      await c.query(
        "UPDATE fleet_provisioning SET cleanup_status = 'terminated', updated_at = now() WHERE expected_agent_id = $1 AND cleanup_status <> 'terminated'",
        [agentId],
      );
      await this.event(c, "orphan_resolved", agentId, actor, { resolution });
      return true;
    });
  }

  async getLifecyclePolicy(): Promise<LifecyclePolicy> {
    return this.read(async (c) => {
      const s = (await c.query("SELECT * FROM fleet_state WHERE id = 1")).rows[0];
      return {
        healthChallengeIntervalS: s.health_challenge_interval_s,
        challengeTtlS: s.challenge_ttl_s,
        healthGraceS: s.health_grace_s,
        maxChallengeFailures: s.max_challenge_failures,
        terminationGraceS: s.termination_grace_s,
        orphanSlotHoldS: s.orphan_slot_hold_s,
        maxOpenOrphans: s.max_open_orphans,
        sessionTtlS: s.session_ttl_s,
      };
    });
  }

  /** Operator-only: health grace periods, termination eligibility, orphan policy, session TTL. */
  async setLifecyclePolicy(p: Partial<LifecyclePolicy>, actor: string): Promise<LifecyclePolicy> {
    const cur = await this.getLifecyclePolicy();
    const n = { ...cur, ...p };
    await this.tx(async (c) => {
      await this.lockState(c);
      await c.query(
        `UPDATE fleet_state SET health_challenge_interval_s = $1, challenge_ttl_s = $2, health_grace_s = $3, max_challenge_failures = $4,
                termination_grace_s = $5, orphan_slot_hold_s = $6, max_open_orphans = $7, session_ttl_s = $8, updated_at = now() WHERE id = 1`,
        [n.healthChallengeIntervalS, n.challengeTtlS, n.healthGraceS, n.maxChallengeFailures, n.terminationGraceS, n.orphanSlotHoldS,
         n.maxOpenOrphans, n.sessionTtlS],
      );
      await this.event(c, "lifecycle_policy_set", null, actor, { ...n });
    });
    return n;
  }

  /**
   * provisioning -> active. The child must have proven its runtime identity:
   * the attestation must carry this reservation's nonce and match the
   * recorded expected repo, commit, lockfile and build identifier. Any
   * mismatch stops activation, releases the slot and marks the provisioning
   * failed (runtime_verification_failed). Issues the child's credential.
   *
   * Checked twice: here (detailed errors, fail fast) and authoritatively in
   * svc_activate() under the fleet lock, so a controller bug cannot activate
   * an unverified child.
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
      /** Phase 6: must equal the lease's provisioning key (reservation id) when given. */
      provisioningKey?: string | null;
    },
  ): Promise<ActivationResult> {
    const pre = await this.read(async (c) => {
      const a = await c.query<AgentRow>("SELECT * FROM fleet_agents WHERE agent_id = $1", [agentId]);
      const l = await c.query<LeaseRow>("SELECT * FROM fleet_reservations WHERE agent_id = $1", [agentId]);
      return { row: a.rows[0], lease: l.rows[0], now: await dbNow(c) };
    });
    const { row, lease } = pre;
    if (!row || row.status !== "provisioning") {
      throw new Error(`Cannot activate fleet agent ${agentId}: not in provisioning state`);
    }
    if (!lease || lease.status !== "provisioning") {
      throw new Error(`Cannot activate fleet agent ${agentId}: no open provisioning lease`);
    }
    if (params.parentAgentId !== undefined && lease.parent_agent_id !== params.parentAgentId) {
      throw new FleetBypassError(`Activation denied: reservation ${lease.reservation_id} belongs to another parent.`);
    }
    if (params.provisioningKey != null && params.provisioningKey !== lease.reservation_id) {
      throw new FleetBypassError(`Activation denied: provisioning key does not match reservation ${lease.reservation_id}.`);
    }
    if (lease.expires_at.getTime() <= pre.now) {
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
      await this.recordVerificationFailure(agentId, err instanceof Error ? err.message : String(err), params.actor ?? null).catch(() => {});
      throw err;
    }

    const token = mintAgentToken(agentId);
    let res: { ok: boolean; code?: string; reason?: string; agent?: Record<string, unknown> };
    try {
      const r = await this.tx(async (c) =>
        c.query<{ res: typeof res }>("SELECT svc_activate($1, $2, $3, $4, $5, $6, $7, $8, $9) AS res", [
          agentId,
          params.parentAgentId ?? null,
          params.walletAddress,
          params.sandboxId ?? null,
          params.runtimeCommit,
          params.runtimeVersion ?? null,
          JSON.stringify({ ...attestation, repo: normalizeRepoUrl(attestation.repo) }),
          params.actor ?? null,
          hashAgentToken(token),
        ]),
      );
      res = r.rows[0].res;
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (e.code === "23505") {
        throw new FleetDuplicateRegistrationError(
          `Duplicate child registration rejected for ${agentId} (${e.constraint ?? "unique constraint"}).`,
        );
      }
      throw err;
    }
    if (!res.ok) {
      const reason = res.reason ?? "activation refused";
      if (res.code === "FLEET_RUNTIME_UNVERIFIED") throw new FleetRuntimeError(reason);
      if (res.code === "FLEET_NOT_AUTHORIZED") throw new FleetBypassError(reason);
      throw new Error(reason);
    }
    return { agent: agentFromJson(res.agent!), credential: { agentId, token } };
  }

  /**
   * Runtime verification failed: stop activation, release the reservation
   * and mark the provisioning failed. Idempotent.
   */
  async recordVerificationFailure(agentId: string, reason: string, actor: string | null = null): Promise<boolean> {
    return this.svcBool("SELECT svc_verification_failed($1, $2, $3) AS ok", [agentId, scrubText(reason), actor]);
  }

  /** reserved/provisioning -> failed. Returns false if already released/active/dead (no double release). */
  async releaseReservation(agentId: string, reason: string, actor: string | null = null): Promise<boolean> {
    return this.svcBool("SELECT svc_release($1, $2, $3) AS ok", [agentId, scrubText(reason), actor]);
  }

  /** Record a death. The row is retained forever and no longer counts; the credential is revoked. Idempotent. */
  async markDead(agentId: string, reason: string, actor?: string, cause = "reported"): Promise<boolean> {
    return this.svcBool("SELECT svc_mark_dead($1, $2, $3, $4) AS ok", [agentId, scrubText(reason), actor ?? null, cause]);
  }

  private async svcBool(sql: string, args: unknown[]): Promise<boolean> {
    return this.tx(async (c) => (await c.query<{ ok: boolean }>(sql, args)).rows[0].ok === true);
  }

  async markDeadByLocalChildId(localChildId: string, reason: string): Promise<boolean> {
    const agent = await this.read(async (c) =>
      c.query<{ agent_id: string }>("SELECT agent_id FROM fleet_agents WHERE local_child_id = $1", [localChildId]),
    );
    const id = agent.rows[0]?.agent_id;
    return id ? this.markDead(id, reason, undefined, "child_lifecycle") : false;
  }

  /**
   * A parent reports its child's local lifecycle ended (svc_child_terminal):
   * unclaimed/provisioning children are released now; a living child dies
   * now only if it has already gone quiet, else once it does.
   */
  async reportChildTerminal(
    parentAgentId: string,
    localChildId: string,
    state: string,
  ): Promise<{ ok: boolean; code?: string; outcome?: "released" | "dead" | "deferred" | "already_terminal"; changed?: boolean }> {
    return this.tx(async (c) => {
      const r = await c.query("SELECT svc_child_terminal($1, $2, $3) AS res", [parentAgentId, localChildId, scrubText(state).slice(0, 32)]);
      return r.rows[0].res;
    });
  }

  /** Update last_heartbeat of a living agent (unresponsive agents recover). Never inserts. */
  async heartbeat(agentId: string): Promise<boolean> {
    return this.tx(async (c) => {
      const r = await c.query<{ s: string | null }>("SELECT svc_heartbeat($1) AS s", [agentId]);
      return r.rows[0].s === "active";
    });
  }

  async selfStatus(agentId: string): Promise<SharedAgentStatus | null> {
    return (await this.getAgent(agentId))?.status ?? null;
  }

  /**
   * One reaper pass: expire leases, retire quiet parent-reported children,
   * then ACTIVE -> UNRESPONSIVE -> DEAD for missed heartbeats. Safe to run
   * concurrently and repeatedly.
   */
  async reap(actor = "reaper"): Promise<ReapResult> {
    return this.tx(async (c) => {
      const r = await c.query<{ res: { expired: number; unresponsive: number; dead: number; graceFrom: string | null } }>(
        "SELECT svc_reap($1) AS res",
        [actor],
      );
      return r.rows[0].res;
    });
  }

  /** Schema v13: authorize one founder inference call (switches, limits, budget, cash, survival, credits). */
  async cognitionAuthorize(agentId: string, estimateCents: number): Promise<Record<string, unknown> & { ok: boolean }> {
    return this.tx(async (c) => (await c.query("SELECT svc_cognition_authorize($1, $2) AS r", [agentId, estimateCents])).rows[0].r);
  }

  /** Schema v15/v16: record an inference outcome once, charge by the explicit usage rule, append the trusted cognition log. */
  async cognitionRecord(agentId: string, requestId: string, r: CognitionRecord): Promise<Record<string, unknown> & { ok: boolean }> {
    return this.tx(async (c) =>
      (await c.query("SELECT svc_cognition_record($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) AS r", [
        agentId, requestId, r.outcome, r.inputTokens, r.outputTokens, r.promptSha256, r.responseSha256, JSON.stringify(r.toolCalls), r.errorCode,
        r.usageSource, r.attempts, r.providerStatus ?? null, r.responseModel ?? null, r.latencyMs ?? null,
        r.cacheReadTokens ?? 0, r.cacheWriteTokens ?? 0, r.providerRequestId ?? null, r.stopReason ?? null,
      ])).rows[0].r,
    );
  }

  /** Schema v12: record a provisioned founder process's own attestation evidence (token-bound, set once). */
  async recordFounderRuntimeEvidence(agentId: string, token: string, evidence: Record<string, unknown>): Promise<{ ok: boolean; code?: string; replay?: boolean }> {
    return this.tx(async (c) => (await c.query("SELECT svc_genesis_runtime_evidence($1, $2, $3) AS r", [agentId, token, JSON.stringify(evidence)])).rows[0].r);
  }

  /** Schema v11: expire / roll back Genesis authorizations past their expiry. Returns the count. */
  async expireGenesis(limit = 10): Promise<number> {
    return this.tx(async (c) => Number((await c.query<{ n: number }>("SELECT svc_genesis_expire($1) AS n", [limit])).rows[0].n));
  }

  /** Schema v11: settle open estates of economically dead agents with nothing in flight. Returns the count. */
  async settleEstates(limit = 10): Promise<number> {
    return this.tx(async (c) => Number((await c.query<{ n: number }>("SELECT svc_settle_estates($1) AS n", [limit])).rows[0].n));
  }

  /** Schema v10: expire payment orders past their TTL (releases their reservations). Returns the count. */
  async expirePaymentOrders(limit = 100): Promise<number> {
    return this.tx(async (c) => Number((await c.query<{ n: number }>("SELECT svc_expire_payment_orders($1) AS n", [limit])).rows[0].n));
  }

  /** Append an audit event (service-level events: API auth failures, DB authorization failures, …). */
  async recordEvent(eventType: string, agentId: string | null, actor: string | null, detail: Record<string, unknown> = {}): Promise<void> {
    await this.tx(async (c) =>
      c.query("SELECT svc_record_event($1, $2, $3, $4)", [eventType, agentId, actor, JSON.stringify(scrubDetail(detail))]),
    );
  }

  // ─── Sandbox terminations ──────────────────────────────────────

  async terminationsDue(limit = 20): Promise<Array<{ agentId: string; sandboxId: string; attempts: number }>> {
    return this.tx(async (c) => (await c.query("SELECT svc_terminations_due($1) AS res", [limit])).rows[0].res);
  }

  async recordTerminationResult(
    agentId: string,
    status: "terminated" | "unsupported" | "failed",
    error: string | null,
    actor = "fleet-service",
  ): Promise<boolean> {
    return this.svcBool("SELECT svc_termination_result($1, $2, $3, $4) AS ok", [agentId, status, error ? scrubText(error) : null, actor]);
  }

  async listTerminations(): Promise<SandboxTerminationRecord[]> {
    return this.read(async (c) => {
      const r = await c.query("SELECT * FROM fleet_sandbox_terminations ORDER BY requested_at, agent_id");
      return r.rows.map((t) => ({
        agentId: t.agent_id,
        sandboxId: t.sandbox_id,
        status: t.status,
        requestedAt: t.requested_at.toISOString(),
        attempts: t.attempts,
        lastError: t.last_error,
      }));
    });
  }

  /** Stale/zombie indicators for fleet:doctor. */
  async staleness(): Promise<{
    staleAgents: number;
    unresponsive: number;
    staleReservations: number;
    openReservations: number;
    unterminatedSandboxes: number;
    reaperLastRunAt: string | null;
    openOrphans: number;
    provisioningNeedingCleanup: number;
    quarantined: number;
    terminating: number;
    uncertainProvisioning: number;
    dryRunChildren: number;
    dryRunProven: number;
  }> {
    return this.read(async (c) => {
      const r = await c.query(
        `SELECT
           (SELECT count(*) FROM fleet_agents a WHERE a.status IN ('active','unresponsive')
              AND COALESCE(a.last_heartbeat, a.updated_at) < now() - make_interval(secs => s.heartbeat_unresponsive_s))::int AS stale_agents,
           (SELECT count(*) FROM fleet_agents WHERE status = 'unresponsive')::int AS unresponsive,
           (SELECT count(*) FROM fleet_reservations WHERE status IN ('reserved','provisioning') AND expires_at <= now())::int AS stale_reservations,
           (SELECT count(*) FROM fleet_reservations WHERE status IN ('reserved','provisioning'))::int AS open_reservations,
           (SELECT count(*) FROM fleet_sandbox_terminations WHERE status <> 'terminated')::int AS unterminated,
           (SELECT count(*) FROM fleet_orphans WHERE resolved_at IS NULL)::int AS open_orphans,
           (SELECT count(*) FROM fleet_provisioning WHERE cleanup_status IN ('pending','unsupported','failed'))::int AS prov_cleanup,
           (SELECT count(*) FROM fleet_agents WHERE status = 'orphaned')::int AS quarantined,
           (SELECT count(*) FROM fleet_agents WHERE status = 'terminating')::int AS terminating,
           (SELECT count(*) FROM fleet_provisioning WHERE sandbox_id IS NULL AND external_state IN ('intent','uncertain')
               AND status <> 'active' AND (status <> 'provisioning' OR activation_deadline <= now()))::int AS uncertain,
           (SELECT count(*) FROM fleet_agents WHERE dry_run AND status IN ('reserved','provisioning','active','unresponsive','terminating','orphaned'))::int AS dry_run,
           (SELECT count(*) FROM fleet_agents WHERE dry_run AND activated_at IS NOT NULL AND last_challenge_ok_at IS NOT NULL)::int AS dry_run_proven,
           s.reaper_last_run_at
         FROM fleet_state s WHERE s.id = 1`,
      );
      const x = r.rows[0];
      return {
        staleAgents: x.stale_agents,
        unresponsive: x.unresponsive,
        staleReservations: x.stale_reservations,
        openReservations: x.open_reservations,
        unterminatedSandboxes: x.unterminated,
        reaperLastRunAt: iso(x.reaper_last_run_at),
        openOrphans: x.open_orphans,
        provisioningNeedingCleanup: x.prov_cleanup,
        quarantined: x.quarantined,
        terminating: x.terminating,
        uncertainProvisioning: x.uncertain,
        dryRunChildren: x.dry_run,
        dryRunProven: x.dry_run_proven,
      };
    });
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

  /**
   * Capability scope of an agent identity (schema v7), read by agent id with
   * the controller's own role. null when no such agent exists. Used by the
   * fleet service's route policy before any route handler runs.
   */
  /**
   * The identity's effective route scope: its capability scope, or "held"
   * while an operator/owner hold (schema v9, Phase D3) is in place. A held
   * agent gets the witness allow-list (liveness only) from routeDecision.
   */
  async capabilityScope(agentId: string): Promise<FleetCapabilityScope | string | null> {
    return this.read(async (c) => {
      const r = await c.query<{ s: string }>(
        "SELECT CASE WHEN operator_hold_at IS NOT NULL THEN 'held' ELSE capability_scope END AS s FROM fleet_agents WHERE agent_id = $1",
        [agentId],
      );
      return r.rows[0]?.s ?? null;
    });
  }

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
