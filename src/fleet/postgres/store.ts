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

import pg from "pg";
import type { Pool, PoolClient } from "pg";
import { ulid } from "ulid";
import { isFleetState } from "../config.js";
import { createBoundGrant, type ClaimedGrant } from "../grants.js";
import { FleetBypassError } from "../registry.js";
import { FleetRuntimeError, samePin, type RuntimePin } from "../runtime.js";
import type {
  FleetDecisionCode,
  FleetHealth,
  FleetSpawnGrant,
  FleetState,
  SharedAgentRecord,
  SharedAgentStatus,
  SharedFleetState,
} from "../types.js";
import { FLEET_PG_HARD_MAX_AGENTS, FLEET_PG_SCHEMA_VERSION, migrate, quoteIdent } from "./migrations.js";

export const DEFAULT_FLEET_PG_SCHEMA = "fleet";
export const DEFAULT_RESERVATION_TTL_MS = 30 * 60_000;

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
  reservationTtlMs?: number;
}

export type SharedReserveResult =
  | { ok: true; grant: FleetSpawnGrant; agent: SharedAgentRecord }
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
}

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
  };
}

// ─── Secret hygiene for the audit log ────────────────────────────

const SECRET_KEY_RE = /(private|secret|mnemonic|seed|passw|api[_-]?key|token|credential|database_url)/i;
const SECRET_VALUE_RES = [/0x[0-9a-fA-F]{64}/g, /[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi];

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
  private readonly pool: Pool;
  private readonly reservationTtlMs: number;
  private schemaChecked = false;
  private closed = false;

  constructor(opts: PgFleetStoreOptions) {
    this.schema = opts.schema ?? DEFAULT_FLEET_PG_SCHEMA;
    quoteIdent(this.schema);
    this.reservationTtlMs = opts.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS;
    const lockMs = opts.lockTimeoutMs ?? 5_000;
    const stmtMs = opts.statementTimeoutMs ?? 10_000;
    this.pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: opts.poolMax ?? 4,
      // Also bounds the wait for a pooled client, so it must tolerate bursts.
      connectionTimeoutMillis: opts.connectTimeoutMs ?? 10_000,
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true,
      application_name: "automaton-fleet",
      options: `-c search_path=${this.schema} -c lock_timeout=${lockMs} -c statement_timeout=${stmtMs} -c idle_in_transaction_session_timeout=${stmtMs * 3}`,
    });
    // An idle client losing its connection must not crash the agent.
    this.pool.on("error", () => {});
  }

  /** Build from DATABASE_URL (and optional FLEET_PG_SCHEMA). Null when unconfigured. */
  static fromEnv(env: Record<string, string | undefined> = process.env): PgFleetStore | null {
    const url = env.DATABASE_URL?.trim();
    if (!url) return null;
    return new PgFleetStore({ connectionString: url, schema: env.FLEET_PG_SCHEMA?.trim() || undefined });
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

  /** Operator-only: apply schema migrations. */
  async migrate(): Promise<number[]> {
    const client = await this.connect();
    try {
      return await migrate(client, this.schema);
    } finally {
      client.release();
    }
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
        `SELECT s.living_agents = (SELECT count(*) FROM fleet_agents WHERE status = 'active')
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

  /** Operator-only: approve the runtime children must run. Null clears it (blocks all replication). */
  async setApprovedRuntime(pin: RuntimePin | null, actor: string): Promise<void> {
    await this.tx(async (c) => {
      const prev = await this.lockState(c);
      await c.query("UPDATE fleet_state SET runtime_repo = $1, runtime_commit = $2, updated_at = now() WHERE id = 1", [
        pin?.repo ?? null,
        pin?.commit ?? null,
      ]);
      await this.event(c, "runtime_approved", null, actor, {
        previous: prev.runtime_commit ? { repo: prev.runtime_repo, commit: prev.runtime_commit } : null,
        runtime: pin,
      });
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
        if (row.status !== "active") {
          return { ok: false, code: "FLEET_AGENT_DEAD", reason: `Agent ${row.agent_id} is ${row.status}; the dead are not revived.` };
        }
        const upd = await c.query<AgentRow>(
          `UPDATE fleet_agents SET last_heartbeat = now(), updated_at = now(),
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
      if (row.status !== "active") {
        return { ok: false, code: "FLEET_AGENT_DEAD", reason: `Agent ${agentId} is ${row.status}.` };
      }
      return { ok: true, agent: toAgent(row), created: false };
    });
  }

  // ─── Slot allocation ───────────────────────────────────────────

  /**
   * Atomically reserve a slot for a child of `parentAgentId`. The reservation
   * counts against the cap from this moment until it is released, expires
   * unclaimed, or the child dies.
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
        await this.lockState(c);

        // Reclaim reservations that were never claimed (crash before provisioning).
        const expired = await c.query<{ agent_id: string }>(
          `UPDATE fleet_agents SET status = 'failed', status_reason = 'reservation expired unclaimed',
                  death_time = now(), updated_at = now()
            WHERE status = 'reserved' AND reservation_expires_at < now()
            RETURNING agent_id`,
        );
        for (const r of expired.rows) await this.event(c, "reservation_expired", r.agent_id, null);

        const st = await c.query<StateRow>("SELECT * FROM fleet_state WHERE id = 1").then((r) => r.rows[0]);
        const max = Math.min(st.max_agents, params.localMaxAgents ?? FLEET_PG_HARD_MAX_AGENTS);
        const deny = async (code: FleetDecisionCode, reason: string): Promise<SharedReserveResult> => {
          await this.event(c, "reservation_denied", null, params.requestedBy, {
            code,
            living: st.living_agents,
            reserved: st.reserved_slots,
            max,
          });
          return { ok: false, code, reason, living: st.living_agents, reserved: st.reserved_slots, max };
        };

        const mode = isFleetState(st.operating_mode) ? st.operating_mode : "EMERGENCY";
        if (mode === "EMERGENCY") return deny("FLEET_EMERGENCY", "Shared fleet state is EMERGENCY.");
        if (mode === "DEVELOPMENT") return deny("FLEET_DEVELOPMENT_MODE", "Shared fleet state is DEVELOPMENT.");
        if (mode === "HARVEST") return deny("FLEET_HARVEST", "Shared fleet state is HARVEST.");

        const approved = st.runtime_repo && st.runtime_commit ? { repo: st.runtime_repo, commit: st.runtime_commit } : null;
        if (!approved || !samePin(approved, params.runtime)) {
          return deny("FLEET_RUNTIME_UNVERIFIED", "Child runtime pin does not match the fleet-approved runtime.");
        }

        const parent = await c.query<AgentRow>("SELECT * FROM fleet_agents WHERE agent_id = $1", [params.parentAgentId]);
        if (!parent.rowCount || parent.rows[0].status !== "active") {
          return deny("FLEET_PARENT_NOT_LIVING", "Parent is not a living registered fleet agent.");
        }

        const dup = await c.query("SELECT 1 FROM fleet_agents WHERE request_key = $1", [requestKey]);
        if (dup.rowCount) return deny("FLEET_DUPLICATE_REQUEST", "Replication request already registered.");

        if (st.living_agents + st.reserved_slots >= max) {
          return deny(
            "FLEET_CAP_REACHED",
            `Fleet at cap (${st.living_agents} living + ${st.reserved_slots} reserved >= ${max}).`,
          );
        }

        const id = ulid();
        const ins = await c.query<AgentRow>(
          `INSERT INTO fleet_agents (agent_id, parent_agent_id, role, generation, name, runtime_repo, runtime_commit,
                                     status, requested_by, request_key, reservation_expires_at)
           VALUES ($1, $2, 'child', $3, $4, $5, $6, 'reserved', $7, $8, now() + ($9 || ' milliseconds')::interval)
           RETURNING *`,
          [
            id,
            params.parentAgentId,
            parent.rows[0].generation + 1,
            params.name,
            approved.repo,
            approved.commit,
            params.requestedBy,
            requestKey,
            String(this.reservationTtlMs),
          ],
        );
        await this.event(c, "slot_reserved", id, params.requestedBy, {
          living: st.living_agents,
          reserved: st.reserved_slots + 1,
          max,
        });
        const grant = createBoundGrant(id, (localChildId) => this.claimGrant(id, localChildId));
        return { ok: true, grant, agent: toAgent(ins.rows[0]) };
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

  /** reserved -> provisioning, exactly once, before any sandbox exists. */
  async claimGrant(agentId: string, localChildId: string): Promise<ClaimedGrant> {
    return this.tx(async (c) => {
      const r = await c.query<AgentRow>(
        `UPDATE fleet_agents SET status = 'provisioning', local_child_id = $2, updated_at = now()
          WHERE agent_id = $1 AND status = 'reserved' AND reservation_expires_at > now()
          RETURNING *`,
        [agentId, localChildId],
      );
      if (r.rowCount !== 1) {
        throw new FleetBypassError(`Replication denied: fleet reservation ${agentId} is invalid, expired, or already used.`);
      }
      await this.event(c, "slot_claimed", agentId, null, { localChildId });
      const row = r.rows[0];
      return {
        agentId,
        parentAgentId: row.parent_agent_id,
        generation: row.generation,
        runtime: row.runtime_repo && row.runtime_commit ? { repo: row.runtime_repo, commit: row.runtime_commit } : null,
        backend: "postgres",
      };
    });
  }

  /**
   * provisioning -> active. Requires the runtime commit the parent verified in
   * the child sandbox to equal the reservation's pinned commit, and a wallet
   * never registered before.
   */
  async activate(
    agentId: string,
    params: { walletAddress: string; sandboxId?: string | null; runtimeCommit?: string | null; runtimeVersion?: string | null },
  ): Promise<SharedAgentRecord> {
    try {
      return await this.tx(async (c) => {
        const cur = await c.query<AgentRow>("SELECT * FROM fleet_agents WHERE agent_id = $1 FOR UPDATE", [agentId]);
        const row = cur.rows[0];
        if (!row || row.status !== "provisioning") {
          throw new Error(`Cannot activate fleet agent ${agentId}: not in provisioning state`);
        }
        if (!params.runtimeCommit || params.runtimeCommit !== row.runtime_commit) {
          throw new FleetRuntimeError(
            `Cannot activate fleet agent ${agentId}: verified runtime ${params.runtimeCommit ?? "<none>"} != pinned ${row.runtime_commit}`,
          );
        }
        const upd = await c.query<AgentRow>(
          `UPDATE fleet_agents SET status = 'active', wallet_address = $2, sandbox_id = $3, runtime_version = $4,
                  last_heartbeat = now(), reservation_expires_at = NULL, updated_at = now()
            WHERE agent_id = $1 AND status = 'provisioning' RETURNING *`,
          [agentId, params.walletAddress, params.sandboxId ?? null, params.runtimeVersion ?? null],
        );
        await this.event(c, "agent_activated", agentId, null, {
          walletAddress: params.walletAddress,
          sandboxId: params.sandboxId ?? null,
          runtimeCommit: params.runtimeCommit,
        });
        return toAgent(upd.rows[0]);
      });
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (e.code === "23505") {
        throw new FleetDuplicateRegistrationError(
          `Duplicate child registration rejected for ${agentId} (${e.constraint ?? "unique constraint"}).`,
        );
      }
      throw err;
    }
  }

  /** reserved/provisioning -> failed. Returns false if already released/active/dead (no double release). */
  async releaseReservation(agentId: string, reason: string): Promise<boolean> {
    return this.tx(async (c) => {
      const r = await c.query(
        `UPDATE fleet_agents SET status = 'failed', status_reason = $2, death_time = now(), updated_at = now()
          WHERE agent_id = $1 AND status IN ('reserved','provisioning')`,
        [agentId, reason],
      );
      if (r.rowCount === 1) await this.event(c, "slot_released", agentId, null, { reason });
      return r.rowCount === 1;
    });
  }

  /** Record a death. The row is retained forever and no longer counts. Idempotent. */
  async markDead(agentId: string, reason: string, actor?: string): Promise<boolean> {
    return this.tx(async (c) => {
      const r = await c.query(
        `UPDATE fleet_agents
            SET status = CASE WHEN status = 'active' THEN 'dead' ELSE 'failed' END,
                status_reason = $2, death_time = now(), updated_at = now()
          WHERE agent_id = $1 AND status IN ('reserved','provisioning','active')`,
        [agentId, reason],
      );
      if (r.rowCount === 1) await this.event(c, "agent_died", agentId, actor ?? null, { reason });
      return r.rowCount === 1;
    });
  }

  async markDeadByLocalChildId(localChildId: string, reason: string): Promise<boolean> {
    const agent = await this.read(async (c) =>
      c.query<{ agent_id: string }>("SELECT agent_id FROM fleet_agents WHERE local_child_id = $1", [localChildId]),
    );
    const id = agent.rows[0]?.agent_id;
    return id ? this.markDead(id, reason) : false;
  }

  /** Update last_heartbeat of a living agent. Never inserts. */
  async heartbeat(agentId: string): Promise<boolean> {
    return this.read(async (c) => {
      const r = await c.query(
        "UPDATE fleet_agents SET last_heartbeat = now() WHERE agent_id = $1 AND status = 'active'",
        [agentId],
      );
      return r.rowCount === 1;
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
        ? "WHERE status IN ('reserved','provisioning','active')"
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
