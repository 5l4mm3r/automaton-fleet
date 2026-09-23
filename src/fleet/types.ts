/**
 * Fleet Types
 *
 * The fleet layer sits above the existing replication system and bounds
 * how many automatons may be alive across the whole lineage.
 */

import type { SurvivalTier } from "../types.js";

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
  /** Operator-selected mode. HARVEST is additionally auto-selected at the cap. */
  configuredMode: FleetState;
  realReplicationEnabled: boolean;
  realPaymentsEnabled: boolean;
  /** Parsed for visibility only. Owner sweeps are not implemented in Phase 1. */
  ownerSweepEnabled: boolean;
  /** Minimum parent credit balance (cents) required before replication. */
  minParentReserveCents: number;
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
  | "FLEET_REGISTRY_UNAVAILABLE";

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
