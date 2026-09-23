/**
 * Fleet Registry
 *
 * Durable record of every agent in the fleet (living and dead) and the
 * authoritative, transaction-safe allocator of living-agent slots.
 *
 * Concurrency: every read-then-write runs inside BEGIN IMMEDIATE, which
 * takes SQLite's RESERVED lock before the count is read. Concurrent writers
 * (other connections or processes sharing the file) block on busy_timeout
 * until the lock is released, so two reservations can never both observe
 * the same "free slot". The fleet_agents_cap_insert trigger re-checks the
 * cap inside the INSERT itself as a final backstop.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { ulid } from "ulid";
import { MIGRATION_V12, MIGRATION_V12_CHILDREN_SYNC } from "../state/schema.js";
import { FLEET_HARD_MAX_AGENTS } from "./config.js";
import type {
  FleetAgentRecord,
  FleetAgentStatus,
  FleetEventRecord,
  FleetSpawnGrant,
} from "./types.js";

const LIVING_SQL = "('reserved','spawning','active')";
const BUSY_TIMEOUT_MS = 5000;

export class FleetBypassError extends Error {
  readonly code = "FLEET_BYPASS_DENIED";
  constructor(message: string) {
    super(message);
    this.name = "FleetBypassError";
  }
}

export type ReserveResult =
  | { ok: true; grant: FleetSpawnGrant; agent: FleetAgentRecord }
  | { ok: false; code: "FLEET_CAP_REACHED" | "FLEET_EMERGENCY"; reason: string; living: number; max: number };

interface AgentRow {
  id: string;
  role: "root" | "child";
  parent_agent_id: string | null;
  requested_by: string;
  name: string;
  address: string | null;
  child_id: string | null;
  sandbox_id: string | null;
  status: FleetAgentStatus;
  status_reason: string | null;
  generation: number;
  created_at: string;
  updated_at: string;
  died_at: string | null;
}

function toRecord(row: AgentRow): FleetAgentRecord {
  return {
    id: row.id,
    role: row.role,
    parentAgentId: row.parent_agent_id,
    requestedBy: row.requested_by,
    name: row.name,
    address: row.address,
    childId: row.child_id,
    sandboxId: row.sandbox_id,
    status: row.status,
    statusReason: row.status_reason,
    generation: row.generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    diedAt: row.died_at,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function isCapTriggerError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("FLEET_CAP_EXCEEDED");
}

export class FleetRegistry {
  constructor(private readonly db: DatabaseType) {
    this.db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    FleetRegistry.ensureSchema(db);
  }

  /** Idempotent. Normally applied by the V12 migration; kept for raw DBs. */
  static ensureSchema(db: DatabaseType): void {
    db.exec(MIGRATION_V12);
    const hasChildren = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'children'")
      .get();
    if (hasChildren) db.exec(MIGRATION_V12_CHILDREN_SYNC);
  }

  // ─── Cap / flags ─────────────────────────────────────────────

  setMaxAgents(max: number): void {
    if (!Number.isSafeInteger(max) || max < 1 || max > FLEET_HARD_MAX_AGENTS) {
      throw new Error(`Invalid fleet max agents: ${max} (must be 1..${FLEET_HARD_MAX_AGENTS})`);
    }
    const tx = this.db.transaction(() => {
      const prev = this.getMeta("max_agents");
      if (prev === String(max)) return;
      this.setMeta("max_agents", String(max));
      this.insertEvent("cap_set", null, null, { previous: prev, max });
    });
    tx.immediate();
  }

  getMaxAgents(): number {
    const n = Number(this.getMeta("max_agents"));
    return Number.isSafeInteger(n) && n >= 1 ? Math.min(n, FLEET_HARD_MAX_AGENTS) : 0;
  }

  setEmergency(on: boolean, reason: string, actor?: string): void {
    const tx = this.db.transaction(() => {
      this.setMeta("emergency", on ? "1" : "0");
      this.insertEvent(on ? "emergency_on" : "emergency_off", null, actor ?? null, { reason });
    });
    tx.immediate();
  }

  isEmergency(): boolean {
    return this.getMeta("emergency") === "1";
  }

  // ─── Registration & slot allocation ──────────────────────────

  /**
   * Register the running automaton as the fleet root (idempotent).
   * The root is a living agent and occupies one slot.
   */
  ensureRootAgent(params: { address: string; name: string }): FleetAgentRecord {
    const tx = this.db.transaction((): FleetAgentRecord => {
      const existing = this.db
        .prepare("SELECT * FROM fleet_agents WHERE role = 'root' ORDER BY created_at LIMIT 1")
        .get() as AgentRow | undefined;
      if (existing) return toRecord(existing);

      const id = ulid();
      const ts = nowIso();
      this.db
        .prepare(
          `INSERT INTO fleet_agents (id, role, parent_agent_id, requested_by, name, address, status, generation, created_at, updated_at)
           VALUES (?, 'root', NULL, ?, ?, ?, 'active', 0, ?, ?)`,
        )
        .run(id, params.address, params.name, params.address, ts, ts);
      this.insertEvent("root_registered", id, params.address, { name: params.name });
      return this.getAgentOrThrow(id);
    });
    return tx.immediate();
  }

  /**
   * Atomically reserve a living slot. Never exceeds the cap regardless of
   * how many callers race: the count and the insert are one IMMEDIATE txn.
   */
  reserveSlot(params: { parentAgentId: string | null; requestedBy: string; name: string }): ReserveResult {
    const tx = this.db.transaction((): ReserveResult => {
      const max = this.getMaxAgents();
      const living = this.countLiving();

      if (this.isEmergency()) {
        this.insertEvent("reservation_denied", null, params.requestedBy, { code: "FLEET_EMERGENCY", living, max });
        return { ok: false, code: "FLEET_EMERGENCY", reason: "Fleet is in EMERGENCY.", living, max };
      }
      if (living >= max) {
        this.insertEvent("reservation_denied", null, params.requestedBy, { code: "FLEET_CAP_REACHED", living, max });
        return {
          ok: false,
          code: "FLEET_CAP_REACHED",
          reason: `Fleet at cap (${living}/${max} living agents).`,
          living,
          max,
        };
      }

      const parent = params.parentAgentId ? this.getAgent(params.parentAgentId) : null;
      const id = ulid();
      const ts = nowIso();
      this.db
        .prepare(
          `INSERT INTO fleet_agents (id, role, parent_agent_id, requested_by, name, status, generation, created_at, updated_at)
           VALUES (?, 'child', ?, ?, ?, 'reserved', ?, ?, ?)`,
        )
        .run(id, params.parentAgentId, params.requestedBy, params.name, (parent?.generation ?? 0) + 1, ts, ts);
      this.insertEvent("slot_reserved", id, params.requestedBy, { living: living + 1, max });
      return {
        ok: true,
        grant: Object.freeze({ kind: "fleet-spawn-grant", reservationId: id }),
        agent: this.getAgentOrThrow(id),
      };
    });

    try {
      return tx.immediate();
    } catch (err) {
      if (isCapTriggerError(err)) {
        const max = this.getMaxAgents();
        return { ok: false, code: "FLEET_CAP_REACHED", reason: "Fleet cap enforced by database.", living: this.countLiving(), max };
      }
      throw err;
    }
  }

  /**
   * Consume a grant (reserved -> spawning) and bind it to a child id.
   * Called by spawnChild() before any sandbox is created. Single use.
   */
  claimGrant(grant: FleetSpawnGrant | undefined, childId: string): FleetAgentRecord {
    if (!grant || grant.kind !== "fleet-spawn-grant" || typeof grant.reservationId !== "string") {
      throw new FleetBypassError(
        "Replication denied: spawnChild requires a FleetController slot reservation. Use FleetController.requestReplication().",
      );
    }
    const tx = this.db.transaction((): FleetAgentRecord => {
      const res = this.db
        .prepare(
          `UPDATE fleet_agents SET status = 'spawning', child_id = ?, updated_at = ?
           WHERE id = ? AND status = 'reserved' AND role = 'child'`,
        )
        .run(childId, nowIso(), grant.reservationId);
      if (res.changes !== 1) {
        throw new FleetBypassError(
          `Replication denied: fleet reservation ${grant.reservationId} is invalid, expired, or already used.`,
        );
      }
      this.insertEvent("slot_claimed", grant.reservationId, null, { childId });
      return this.getAgentOrThrow(grant.reservationId);
    });
    return tx.immediate();
  }

  /** spawning -> active once the child sandbox and wallet exist. */
  activate(agentId: string, params: { address?: string; sandboxId?: string }): FleetAgentRecord {
    const tx = this.db.transaction((): FleetAgentRecord => {
      const res = this.db
        .prepare(
          `UPDATE fleet_agents SET status = 'active', address = ?, sandbox_id = ?, updated_at = ?
           WHERE id = ? AND status = 'spawning'`,
        )
        .run(params.address ?? null, params.sandboxId ?? null, nowIso(), agentId);
      if (res.changes !== 1) {
        throw new Error(`Cannot activate fleet agent ${agentId}: not in spawning state`);
      }
      this.insertEvent("agent_activated", agentId, null, params);
      return this.getAgentOrThrow(agentId);
    });
    return tx.immediate();
  }

  /** Release a slot that never became active (reserved/spawning -> failed). Idempotent. */
  releaseReservation(agentId: string, reason: string): boolean {
    const tx = this.db.transaction((): boolean => {
      const ts = nowIso();
      const res = this.db
        .prepare(
          `UPDATE fleet_agents SET status = 'failed', status_reason = ?, died_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('reserved','spawning')`,
        )
        .run(reason, ts, ts, agentId);
      if (res.changes === 1) this.insertEvent("slot_released", agentId, null, { reason });
      return res.changes === 1;
    });
    return tx.immediate();
  }

  /** Record the death of a living agent. The row is retained forever. */
  markDead(agentId: string, reason: string): boolean {
    const tx = this.db.transaction((): boolean => {
      const ts = nowIso();
      const res = this.db
        .prepare(
          `UPDATE fleet_agents
              SET status = CASE WHEN status = 'active' THEN 'dead' ELSE 'failed' END,
                  status_reason = ?, died_at = ?, updated_at = ?
            WHERE id = ? AND status IN ${LIVING_SQL}`,
        )
        .run(reason, ts, ts, agentId);
      if (res.changes === 1) this.insertEvent("agent_died", agentId, null, { reason });
      return res.changes === 1;
    });
    return tx.immediate();
  }

  // ─── Queries ─────────────────────────────────────────────────

  countLiving(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM fleet_agents WHERE status IN ${LIVING_SQL}`)
      .get() as { n: number };
    return row.n;
  }

  countTotal(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM fleet_agents").get() as { n: number }).n;
  }

  getAgent(id: string): FleetAgentRecord | null {
    const row = this.db.prepare("SELECT * FROM fleet_agents WHERE id = ?").get(id) as AgentRow | undefined;
    return row ? toRecord(row) : null;
  }

  getRootAgent(): FleetAgentRecord | null {
    const row = this.db
      .prepare("SELECT * FROM fleet_agents WHERE role = 'root' ORDER BY created_at LIMIT 1")
      .get() as AgentRow | undefined;
    return row ? toRecord(row) : null;
  }

  listAgents(filter?: { living?: boolean }): FleetAgentRecord[] {
    const where = filter?.living === undefined
      ? ""
      : filter.living
        ? `WHERE status IN ${LIVING_SQL}`
        : `WHERE status NOT IN ${LIVING_SQL}`;
    const rows = this.db
      .prepare(`SELECT * FROM fleet_agents ${where} ORDER BY created_at, id`)
      .all() as AgentRow[];
    return rows.map(toRecord);
  }

  /** True if the address belongs to any fleet agent or recorded child (any status). */
  isFleetMemberAddress(address: string): boolean {
    const needle = address.trim().toLowerCase();
    if (!needle) return false;
    const fleet = this.db
      .prepare("SELECT 1 FROM fleet_agents WHERE role = 'child' AND lower(address) = ? LIMIT 1")
      .get(needle);
    if (fleet) return true;
    const hasChildren = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'children'")
      .get();
    if (!hasChildren) return false;
    return !!this.db.prepare("SELECT 1 FROM children WHERE lower(address) = ? LIMIT 1").get(needle);
  }

  getEvents(agentId?: string): FleetEventRecord[] {
    const rows = (agentId
      ? this.db.prepare("SELECT * FROM fleet_events WHERE agent_id = ? ORDER BY created_at, id").all(agentId)
      : this.db.prepare("SELECT * FROM fleet_events ORDER BY created_at, id").all()) as Array<{
      id: string;
      event_type: string;
      agent_id: string | null;
      actor: string | null;
      detail: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      agentId: r.agent_id,
      actor: r.actor,
      detail: JSON.parse(r.detail),
      createdAt: r.created_at,
    }));
  }

  recordEvent(eventType: string, agentId: string | null, actor: string | null, detail: Record<string, unknown>): void {
    this.insertEvent(eventType, agentId, actor, detail);
  }

  // ─── Internals ───────────────────────────────────────────────

  private getAgentOrThrow(id: string): FleetAgentRecord {
    const agent = this.getAgent(id);
    if (!agent) throw new Error(`Fleet agent ${id} not found`);
    return agent;
  }

  private getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM fleet_meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO fleet_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(key, value, nowIso());
  }

  private insertEvent(eventType: string, agentId: string | null, actor: string | null, detail: Record<string, unknown>): void {
    this.db
      .prepare("INSERT INTO fleet_events (id, event_type, agent_id, actor, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ulid(), eventType, agentId, actor, JSON.stringify(detail), nowIso());
  }
}
