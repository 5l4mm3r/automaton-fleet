/**
 * Fleet Configuration
 *
 * Parsed from environment variables. Every value fails closed: anything
 * missing or malformed resolves to the most restrictive setting.
 *
 *   FLEET_MAX_AGENTS          integer 1..50   (optional local tightening; see effectiveMaxAgents)
 *   FLEET_MODE                DEVELOPMENT | EXPANSION | HARVEST | EMERGENCY (default DEVELOPMENT)
 *   REAL_REPLICATION_ENABLED  "true" to enable (default false)
 *   REAL_PAYMENTS_ENABLED     "true" to enable (default false)
 *   OWNER_SWEEP_ENABLED       "true" to enable (default false; no-op in Phase 1)
 *   MIN_AGENT_RESERVE_USD     parent reserve before replication (default 10)
 *   FLEET_RUNTIME_REPO        https URL of the fleet fork children run (no default)
 *   FLEET_RUNTIME_COMMIT      full 40-hex commit children run (no default)
 */

import { FLEET_HARD_MAX_AGENTS } from "../state/schema.js";
import type { FleetConfig, FleetState } from "./types.js";
import { FLEET_STATES } from "./types.js";
import { loadRuntimePin } from "./runtime.js";

export { FLEET_HARD_MAX_AGENTS };

export const DEFAULT_FLEET_CONFIG: Readonly<FleetConfig> = Object.freeze({
  maxAgents: 1,
  configuredMode: "DEVELOPMENT",
  realReplicationEnabled: false,
  realPaymentsEnabled: false,
  ownerSweepEnabled: false,
  minParentReserveCents: 1000,
  runtime: null,
});

type Env = Record<string, string | undefined>;

/** Only the exact string "true" (case-insensitive) enables a flag. */
function parseFlag(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

export function parseMaxAgents(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_FLEET_CONFIG.maxAgents;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_FLEET_CONFIG.maxAgents;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < 1 || n > FLEET_HARD_MAX_AGENTS) {
    return DEFAULT_FLEET_CONFIG.maxAgents;
  }
  return n;
}

function parseMode(value: string | undefined): FleetState {
  const upper = value?.trim().toUpperCase();
  return FLEET_STATES.includes(upper as FleetState)
    ? (upper as FleetState)
    : DEFAULT_FLEET_CONFIG.configuredMode;
}

function parseUsdToCents(value: string | undefined, fallbackCents: number): number {
  if (value === undefined || value.trim() === "") return fallbackCents;
  const n = Number(value.trim());
  if (!Number.isFinite(n) || n < 0) return fallbackCents;
  return Math.round(n * 100);
}

/**
 * The local cap to send with registry operations: the operator's explicit
 * FLEET_MAX_AGENTS, or undefined (the registry's owner-set cap applies,
 * bounded by the hard maximum in the database).
 */
export function localCapOverride(config: FleetConfig): number | undefined {
  return config.maxAgentsExplicit === false ? undefined : Math.min(config.maxAgents, FLEET_HARD_MAX_AGENTS);
}

/**
 * Effective living-agent cap. With a shared registry: its owner-set cap,
 * tightened by an explicit local FLEET_MAX_AGENTS, never above the hard
 * maximum. Without one (local-only): the local value (default 1, fail closed).
 * Nothing an agent controls can raise either input.
 */
export function effectiveMaxAgents(config: FleetConfig, sharedMax: number | null | undefined): number {
  if (sharedMax === null || sharedMax === undefined || !Number.isFinite(sharedMax)) return Math.min(config.maxAgents, FLEET_HARD_MAX_AGENTS);
  return Math.min(sharedMax, localCapOverride(config) ?? FLEET_HARD_MAX_AGENTS, FLEET_HARD_MAX_AGENTS);
}

export function loadFleetConfig(env: Env = process.env): FleetConfig {
  return Object.freeze({
    maxAgents: parseMaxAgents(env.FLEET_MAX_AGENTS),
    maxAgentsExplicit: env.FLEET_MAX_AGENTS !== undefined && env.FLEET_MAX_AGENTS.trim() !== "",
    configuredMode: parseMode(env.FLEET_MODE),
    realReplicationEnabled: parseFlag(env.REAL_REPLICATION_ENABLED),
    realPaymentsEnabled: parseFlag(env.REAL_PAYMENTS_ENABLED),
    ownerSweepEnabled: parseFlag(env.OWNER_SWEEP_ENABLED),
    minParentReserveCents: parseUsdToCents(
      env.MIN_AGENT_RESERVE_USD,
      DEFAULT_FLEET_CONFIG.minParentReserveCents,
    ),
    runtime: loadRuntimePin(env),
  });
}

/** Strictness order: EMERGENCY > DEVELOPMENT > HARVEST > EXPANSION. */
const MODE_STRICTNESS: Record<FleetState, number> = { EXPANSION: 0, HARVEST: 1, DEVELOPMENT: 2, EMERGENCY: 3 };

/** The more restrictive of two modes (local env can only tighten the shared mode). */
export function strictestMode(a: FleetState, b: FleetState): FleetState {
  return MODE_STRICTNESS[a] >= MODE_STRICTNESS[b] ? a : b;
}

export function isFleetState(value: unknown): value is FleetState {
  return typeof value === "string" && FLEET_STATES.includes(value as FleetState);
}
