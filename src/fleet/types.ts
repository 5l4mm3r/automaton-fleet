/**
 * Fleet Types
 *
 * The fleet layer sits above the existing replication system and bounds
 * how many automatons may be alive across the whole lineage.
 */

import type { SurvivalTier } from "../types.js";
import type { RuntimePin } from "./runtime.js";
import type { RuntimeAttestation, RuntimeBuild } from "./attestation.js";

export type FleetState = "DEVELOPMENT" | "EXPANSION" | "HARVEST" | "EMERGENCY";

export const FLEET_STATES: readonly FleetState[] = Object.freeze([
  "DEVELOPMENT",
  "EXPANSION",
  "HARVEST",
  "EMERGENCY",
]);

export type FleetAgentRole = "root" | "child";

/** reserved/spawning/active are "living" and count toward the cap. */
export type FleetAgentStatus = "reserved" | "spawning" | "active" | "dead" | "failed";

export const LIVING_FLEET_STATUSES: readonly FleetAgentStatus[] = Object.freeze([
  "reserved",
  "spawning",
  "active",
]);

export interface FleetConfig {
  /** Global living-agent cap across the lineage, including the root. 1..50. */
  maxAgents: number;
  /**
   * Phase D3.1: true when FLEET_MAX_AGENTS was set by the operator (valid or
   * not; an invalid value fails closed to 1). When false, the shared
   * registry's owner-set cap is authoritative (still bounded by the hard
   * maximum 50) and maxAgents (1) only applies without a shared registry.
   * Absent (hand-built configs): treated as explicit.
   */
  maxAgentsExplicit?: boolean;
  /** Operator-selected mode. HARVEST is additionally auto-selected at the cap. */
  configuredMode: FleetState;
  realReplicationEnabled: boolean;
  realPaymentsEnabled: boolean;
  /** Parsed for visibility only. Owner sweeps are not implemented in Phase 1. */
  ownerSweepEnabled: boolean;
  /** Minimum parent credit balance (cents) required before replication. */
  minParentReserveCents: number;
  /** Pinned child runtime (FLEET_RUNTIME_REPO / FLEET_RUNTIME_COMMIT); null if unset or invalid. */
  runtime?: RuntimePin | null;
}

export interface FleetAgentRecord {
  id: string;
  role: FleetAgentRole;
  parentAgentId: string | null;
  requestedBy: string;
  name: string;
  address: string | null;
  childId: string | null;
  sandboxId: string | null;
  status: FleetAgentStatus;
  statusReason: string | null;
  generation: number;
  createdAt: string;
  updatedAt: string;
  diedAt: string | null;
}

export interface FleetEventRecord {
  id: string;
  eventType: string;
  agentId: string | null;
  actor: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

/**
 * Proof that FleetController reserved a living slot. spawnChild() refuses
 * to run without one and consumes it (single use) before creating a sandbox.
 */
export interface FleetSpawnGrant {
  readonly kind: "fleet-spawn-grant";
  readonly reservationId: string;
}

export interface FinancialSnapshot {
  creditsCents: number;
  survivalTier: SurvivalTier;
}

export type FleetDecisionCode =
  | "ALLOWED"
  | "FLEET_EMERGENCY"
  | "FLEET_DEVELOPMENT_MODE"
  | "FLEET_HARVEST"
  | "FLEET_CAP_REACHED"
  | "REAL_REPLICATION_DISABLED"
  | "REAL_PAYMENTS_DISABLED"
  | "NOT_FLEET_ROOT"
  | "FINANCIALLY_INELIGIBLE"
  | "FLEET_CHILD_FUNDING_BYPASS"
  | "FLEET_REGISTRY_UNAVAILABLE"
  | "FLEET_RUNTIME_UNVERIFIED"
  | "FLEET_NOT_REGISTERED"
  | "FLEET_PARENT_NOT_LIVING"
  | "FLEET_DUPLICATE_REQUEST"
  | "FLEET_AUTH_FAILED"
  | "FLEET_NOT_AUTHORIZED"
  | "FLEET_AGENT_DEAD";

export interface FleetDecision {
  allowed: boolean;
  code: FleetDecisionCode;
  reason: string;
  state: FleetState;
}

export interface FleetStatus {
  state: FleetState;
  configuredMode: FleetState;
  emergency: boolean;
  livingAgents: number;
  maxAgents: number;
  totalRecorded: number;
}

export type ReplicationOutcome<TChild> =
  | { ok: true; agentId: string; child: TChild; state: FleetState }
  | { ok: false; decision: FleetDecision };

// ─── Shared (PostgreSQL) registry — Phase 2 ─────────────────────

/**
 * reserved/provisioning hold a reserved slot; active and unresponsive (missed
 * heartbeats, Phase 3) are living; dead/failed are history.
 */
export type SharedAgentStatus =
  | "reserved"
  | "provisioning"
  | "active"
  | "unresponsive"
  | "terminating"
  | "orphaned"
  | "dead"
  | "failed";

export interface SharedFleetState {
  livingAgents: number;
  reservedSlots: number;
  maxAgents: number;
  operatingMode: FleetState;
  runtime: RuntimePin | null;
  updatedAt: string;
  /** DB-level replication switch (Phase 3). Absent = unknown = off. */
  replicationEnabled?: boolean;
  /** Operator-approved build identity of the runtime (Phase 3). */
  build?: RuntimeBuild | null;
  /** Slots held by ORPHANED agents (Phase 5 orphan policy); they count against the cap. */
  quarantinedSlots?: number;
}

/** Reservation lease (Phase 3): a reserved slot with an expiry. */
export type ReservationLeaseStatus = "reserved" | "provisioning" | "completed" | "expired" | "released" | "failed";

export interface ReservationLease {
  reservationId: string;
  agentId: string;
  parentAgentId: string;
  status: ReservationLeaseStatus;
  createdAt: string;
  expiresAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  expected: { repo: string; commit: string; buildId: string; lockfileSha256: string };
  attestedAt: string | null;
}

/** Per-agent bearer credential. Only its SHA-256 is stored by the registry. */
export interface FleetCredential {
  agentId: string;
  token: string;
}

export interface ActivationResult {
  agent: SharedAgentRecord;
  credential: FleetCredential;
}

/** What a spawned child reports back to the controller (verified, never trusted as-is). */
export interface SharedSpawnedChildReport {
  address?: string;
  sandboxId?: string;
  runtimeCommit?: string;
  runtimeVersion?: string | null;
  attestation?: RuntimeAttestation;
}

export interface ReapResult {
  expired: number;
  unresponsive: number;
  dead: number;
  graceFrom: string | null;
}

/**
 * Capability scope of an agent identity (schema v7). 'full' is every normal
 * agent. 'witness' is a root that may only open sessions, heartbeat, answer
 * health challenges and read itself (FLEET-KI-4). Immutable after enrollment.
 */
export type FleetCapabilityScope = "full" | "witness";

export interface SharedAgentRecord {
  agentId: string;
  parentAgentId: string | null;
  role: FleetAgentRole;
  generation: number;
  name: string;
  walletAddress: string | null;
  runtimeVersion: string | null;
  runtimeRepo: string | null;
  runtimeCommit: string | null;
  sandboxId: string | null;
  localChildId: string | null;
  status: SharedAgentStatus;
  statusReason: string | null;
  requestedBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastHeartbeat: string | null;
  deathTime: string | null;
  /** Schema v7; absent from older records. */
  capabilityScope?: FleetCapabilityScope;
}

export interface FleetHealth {
  ok: boolean;
  latencyMs: number | null;
  schemaVersion: number | null;
  /** Stored counters equal the live row counts. */
  countersConsistent: boolean | null;
  error?: string;
}

/** Cached view used by the (synchronous) PolicyEngine rule. */
export interface SharedFleetSnapshot {
  healthy: boolean;
  checkedAt: number;
  state: SharedFleetState | null;
  selfAgentId: string | null;
  memberAddresses: ReadonlySet<string>;
  error?: string;
}
