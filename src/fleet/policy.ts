/**
 * Fleet Policy
 *
 * Pure decision functions. No I/O: callers supply registry counts and
 * financial snapshots. These rules live in code, not in the system prompt,
 * and are consulted by both FleetController and the PolicyEngine rule.
 */

import type {
  FinancialSnapshot,
  FleetConfig,
  FleetDecision,
  FleetDecisionCode,
  FleetState,
} from "./types.js";

/** Tools that spend money or create resources; blocked in EMERGENCY. */
export const EMERGENCY_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  "spawn_child",
  "fund_child",
  "start_child",
  "transfer_credits",
  "x402_fetch",
  "create_sandbox",
  "register_domain",
]);

/**
 * Tools that create or bring up fleet agents. They require a healthy shared
 * registry; when PostgreSQL is unreachable they fail closed while every other
 * tool keeps working.
 */
export const REPLICATION_TOOLS: ReadonlySet<string> = new Set(["spawn_child", "start_child", "fund_child"]);

const ELIGIBLE_TIERS = new Set(["normal", "high"]);

function decision(
  allowed: boolean,
  code: FleetDecisionCode,
  reason: string,
  state: FleetState,
): FleetDecision {
  return { allowed, code, reason, state };
}

/**
 * Effective fleet state. Precedence:
 *   EMERGENCY (flag or configured) > DEVELOPMENT > HARVEST (configured, or
 *   automatically when living >= max) > EXPANSION.
 */
export function computeFleetState(input: {
  configuredMode: FleetState;
  emergency: boolean;
  livingAgents: number;
  maxAgents: number;
}): FleetState {
  if (input.emergency || input.configuredMode === "EMERGENCY") return "EMERGENCY";
  if (input.configuredMode === "DEVELOPMENT") return "DEVELOPMENT";
  if (input.livingAgents >= input.maxAgents) return "HARVEST";
  if (input.configuredMode === "HARVEST") return "HARVEST";
  return "EXPANSION";
}

export function evaluateFinancialEligibility(
  snapshot: FinancialSnapshot | null,
  config: FleetConfig,
  state: FleetState,
): FleetDecision {
  if (!snapshot) {
    return decision(false, "FINANCIALLY_INELIGIBLE", "Financial state unavailable; replication fails closed.", state);
  }
  if (!ELIGIBLE_TIERS.has(snapshot.survivalTier)) {
    return decision(
      false,
      "FINANCIALLY_INELIGIBLE",
      `Survival tier '${snapshot.survivalTier}' is not eligible for replication (requires normal or high).`,
      state,
    );
  }
  if (!Number.isFinite(snapshot.creditsCents) || snapshot.creditsCents < config.minParentReserveCents) {
    return decision(
      false,
      "FINANCIALLY_INELIGIBLE",
      `Credits ${snapshot.creditsCents}c below required parent reserve ${config.minParentReserveCents}c.`,
      state,
    );
  }
  return decision(true, "ALLOWED", "Financial eligibility passed.", state);
}

/**
 * Synchronous replication gate (everything except financial eligibility).
 * The cap check here is advisory; the authoritative check is the atomic
 * reservation in FleetRegistry.reserveSlot().
 */
export function evaluateReplication(input: {
  config: FleetConfig;
  state: FleetState;
  livingAgents: number;
  maxAgents: number;
  isRootAgent: boolean;
  /** True when counts come from the shared (PostgreSQL) registry. */
  sharedRegistry?: boolean;
}): FleetDecision {
  const { config, state } = input;
  switch (state) {
    case "EMERGENCY":
      return decision(false, "FLEET_EMERGENCY", "Fleet is in EMERGENCY: replication disabled.", state);
    case "DEVELOPMENT":
      return decision(false, "FLEET_DEVELOPMENT_MODE", "Fleet is in DEVELOPMENT: real replication disabled.", state);
    case "HARVEST":
      return decision(
        false,
        input.livingAgents >= input.maxAgents ? "FLEET_CAP_REACHED" : "FLEET_HARVEST",
        `Fleet is in HARVEST (${input.livingAgents}/${input.maxAgents} living): replication disabled.`,
        state,
      );
    case "EXPANSION":
      break;
  }
  if (!config.realReplicationEnabled) {
    return decision(false, "REAL_REPLICATION_DISABLED", "REAL_REPLICATION_ENABLED is false.", state);
  }
  if (!input.isRootAgent && !input.sharedRegistry) {
    // A child's local registry cannot see the global lineage, so without the
    // shared registry only the fleet root may replicate.
    return decision(false, "NOT_FLEET_ROOT", "Only the fleet root may request replication.", state);
  }
  if (input.livingAgents >= input.maxAgents) {
    return decision(false, "FLEET_CAP_REACHED", `Fleet at cap (${input.livingAgents}/${input.maxAgents}).`, state);
  }
  return decision(true, "ALLOWED", "Replication permitted pending slot reservation.", state);
}

/**
 * Tool-level gate used by the PolicyEngine rule. Returns null when the
 * fleet policy has no objection.
 */
export function evaluateToolCall(input: {
  toolName: string;
  args: Record<string, unknown>;
  config: FleetConfig;
  state: FleetState;
  livingAgents: number;
  maxAgents: number;
  isRootAgent: boolean;
  sharedRegistry?: boolean;
  isFleetMemberAddress: (address: string) => boolean;
}): FleetDecision | null {
  const { toolName, config, state } = input;

  if (state === "EMERGENCY" && EMERGENCY_BLOCKED_TOOLS.has(toolName)) {
    return decision(
      false,
      "FLEET_EMERGENCY",
      `Fleet is in EMERGENCY: non-essential expenditure (${toolName}) blocked.`,
      state,
    );
  }

  switch (toolName) {
    case "spawn_child": {
      const d = evaluateReplication(input);
      return d.allowed ? null : d;
    }
    case "fund_child":
      if (state === "DEVELOPMENT") {
        return decision(false, "FLEET_DEVELOPMENT_MODE", "Fleet is in DEVELOPMENT: child funding disabled.", state);
      }
      if (!config.realPaymentsEnabled) {
        return decision(false, "REAL_PAYMENTS_DISABLED", "REAL_PAYMENTS_ENABLED is false: child funding disabled.", state);
      }
      return null;
    case "start_child":
      if (state === "DEVELOPMENT") {
        return decision(false, "FLEET_DEVELOPMENT_MODE", "Fleet is in DEVELOPMENT: starting children disabled.", state);
      }
      return null;
    case "transfer_credits": {
      if (config.realPaymentsEnabled) return null;
      const to = typeof input.args.to_address === "string" ? input.args.to_address : "";
      if (to && input.isFleetMemberAddress(to)) {
        return decision(
          false,
          "FLEET_CHILD_FUNDING_BYPASS",
          "Transfers to fleet members are child funding and require REAL_PAYMENTS_ENABLED.",
          state,
        );
      }
      return null;
    }
    default:
      return null;
  }
}
