/**
 * Fleet Policy Rules
 *
 * Applies FleetPolicy to tool calls before execution: replication and
 * child funding gates per fleet state, EMERGENCY expenditure blocking,
 * and transfers to fleet members while real payments are disabled.
 * Fails closed when the fleet registry is not accessible.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { PolicyRule, PolicyRequest, PolicyRuleResult } from "../../types.js";
import type { FleetConfig } from "../../fleet/types.js";
import { loadFleetConfig } from "../../fleet/config.js";
import { FleetRegistry } from "../../fleet/registry.js";
import { computeFleetState, evaluateToolCall, EMERGENCY_BLOCKED_TOOLS } from "../../fleet/policy.js";

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

      const livingAgents = registry.countLiving();
      const maxAgents = config.maxAgents;
      const state = computeFleetState({
        configuredMode: config.configuredMode,
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
        isFleetMemberAddress: (a) => registry.isFleetMemberAddress(a),
      });
      if (!decision) return null;

      return {
        rule: "fleet.policy_gate",
        action: "deny",
        reasonCode: decision.code,
        humanMessage: `${decision.reason} (fleet state: ${decision.state})`,
      };
    },
  };
}

export function createFleetRules(config: FleetConfig = loadFleetConfig()): PolicyRule[] {
  return [createFleetGateRule(config)];
}
