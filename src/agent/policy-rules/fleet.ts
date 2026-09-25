/**
 * Fleet Policy Rules
 *
 * Applies FleetPolicy to tool calls before execution: replication and
 * child funding gates per fleet state, EMERGENCY expenditure blocking,
 * and transfers to fleet members while real payments are disabled.
 * Fails closed when the fleet registry is not accessible.
 *
 * Phase 2: counts, mode and cap come from the shared (PostgreSQL) registry
 * snapshot kept fresh by the fleet heartbeat. PolicyEngine is synchronous, so
 * the rule reads that cached snapshot; if it is missing, stale or unhealthy,
 * replication tools are denied (FLEET_REGISTRY_UNAVAILABLE) while all other
 * tools keep working. The authoritative cap check is still the locked
 * reservation transaction in PostgreSQL.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { PolicyRule, PolicyRequest, PolicyRuleResult } from "../../types.js";
import type { FleetConfig } from "../../fleet/types.js";
import { effectiveMaxAgents, loadFleetConfig, strictestMode } from "../../fleet/config.js";
import { FleetRegistry } from "../../fleet/registry.js";
import {
  computeFleetState,
  evaluateToolCall,
  EMERGENCY_BLOCKED_TOOLS,
  REPLICATION_TOOLS,
} from "../../fleet/policy.js";
import { getActiveSharedFleet } from "../../fleet/shared.js";
import { SPEND_TOOLS } from "../../fleet/spend-gate.js";

const registries = new WeakMap<DatabaseType, FleetRegistry>();

function registryFor(db: DatabaseType): FleetRegistry {
  let registry = registries.get(db);
  if (!registry) {
    registry = new FleetRegistry(db);
    registries.set(db, registry);
  }
  return registry;
}

function createFleetGateRule(config: FleetConfig): PolicyRule {
  return {
    id: "fleet.policy_gate",
    description: "Enforce FleetPolicy: fleet state, global agent cap, and child-funding gates",
    priority: 450,
    appliesTo: { by: "name", names: [...EMERGENCY_BLOCKED_TOOLS] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const db = (request.context.db as any)?.raw as DatabaseType | undefined;

      let registry: FleetRegistry;
      try {
        if (!db) throw new Error("database not accessible");
        registry = registryFor(db);
      } catch {
        return {
          rule: "fleet.policy_gate",
          action: "deny",
          reasonCode: "FLEET_REGISTRY_UNAVAILABLE",
          humanMessage: "Fleet policy check failed: registry not accessible (fail-closed)",
        };
      }

      const snap = getActiveSharedFleet()?.snapshot() ?? null;
      const shared = snap?.healthy && snap.state ? snap.state : null;

      const livingAgents = shared ? shared.livingAgents + shared.reservedSlots : registry.countLiving();
      const maxAgents = effectiveMaxAgents(config, shared ? shared.maxAgents : null);
      const state = computeFleetState({
        configuredMode: shared ? strictestMode(config.configuredMode, shared.operatingMode) : config.configuredMode,
        emergency: registry.isEmergency(),
        livingAgents,
        maxAgents,
      });

      const decision = evaluateToolCall({
        toolName: request.tool.name,
        args: request.args,
        config,
        state,
        livingAgents,
        maxAgents,
        isRootAgent: !request.context.config?.parentAddress,
        sharedRegistry: !!shared,
        isFleetMemberAddress: (a) =>
          registry.isFleetMemberAddress(a) || !!snap?.memberAddresses.has(a.trim().toLowerCase()),
      });
      if (!decision) {
        if (!shared && REPLICATION_TOOLS.has(request.tool.name)) {
          return {
            rule: "fleet.policy_gate",
            action: "deny",
            reasonCode: "FLEET_REGISTRY_UNAVAILABLE",
            humanMessage: `Shared fleet registry unavailable (${snap?.error ?? "not configured"}); replication fails closed`,
          };
        }
        return null;
      }

      return {
        rule: "fleet.policy_gate",
        action: "deny",
        reasonCode: decision.code,
        humanMessage: `${decision.reason} (fleet state: ${decision.state})`,
      };
    },
  };
}

/**
 * Phase D3.1 universal spend gate (policy layer): while real payments are
 * disabled, no tool that spends or transfers value runs. The library
 * chokepoints (spend-gate.ts) enforce the same rule independently.
 */
function createSpendGateRule(config: FleetConfig): PolicyRule {
  return {
    id: "fleet.spend_gate",
    description: "Deny every spending / value-transfer tool while REAL_PAYMENTS_ENABLED is not true",
    // Right after fleet.policy_gate (450), so its more specific denials (DEVELOPMENT, child-funding
    // bypass, registry unavailable) are reported first; any spend tool it lets through stops here.
    priority: 455,
    appliesTo: { by: "name", names: [...SPEND_TOOLS] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      if (config.realPaymentsEnabled === true) return null;
      return {
        rule: "fleet.spend_gate",
        action: "deny",
        reasonCode: "REAL_PAYMENTS_DISABLED",
        humanMessage: `${request.tool.name} spends or transfers real value; the fleet spend gate blocks it while REAL_PAYMENTS_ENABLED is false`,
      };
    },
  };
}

export function createFleetRules(config: FleetConfig = loadFleetConfig()): PolicyRule[] {
  return [createSpendGateRule(config), createFleetGateRule(config)];
}
