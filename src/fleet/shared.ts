/**
 * Process-wide shared fleet wiring.
 *
 * One SharedFleetController per automaton process. index.ts creates it at
 * boot; the spawn_child tool, the orchestrator and the PolicyEngine rule
 * all use the same instance. When DATABASE_URL is not configured there is
 * no controller and every replication path fails closed.
 */

import type { ToolContext } from "../types.js";
import { getSurvivalTier } from "../conway/credits.js";
import { onChildTerminal } from "../replication/lifecycle.js";
import { loadFleetConfig, strictestMode } from "./config.js";
import { PgFleetStore } from "./postgres/store.js";
import { computeFleetState, evaluateReplication } from "./policy.js";
import { SharedFleetController, type SharedSpawnedChild } from "./shared-controller.js";
import type { FleetConfig, FleetDecision, FleetSpawnGrant, ReplicationOutcome } from "./types.js";

let active: SharedFleetController | null = null;
let unsubscribeLifecycle: (() => void) | null = null;

export function getActiveSharedFleet(): SharedFleetController | null {
  return active;
}

/** Install (or clear) the process's shared controller. Child deaths are forwarded to it. */
export function setActiveSharedFleet(controller: SharedFleetController | null): void {
  unsubscribeLifecycle?.();
  unsubscribeLifecycle = null;
  active = controller;
  if (controller) {
    unsubscribeLifecycle = onChildTerminal((childId, state) => {
      controller.store
        .markDeadByLocalChildId(childId, `child lifecycle: ${state}`)
        .catch(() => {
          // Registry unreachable: the agent keeps its slot (safe direction).
        });
    });
  }
}

export function registryUnavailableDecision(config: FleetConfig, detail: string): FleetDecision {
  return {
    allowed: false,
    code: "FLEET_REGISTRY_UNAVAILABLE",
    reason: `Shared fleet registry unavailable; replication fails closed (${detail}).`,
    state: strictestMode(config.configuredMode, "DEVELOPMENT"),
  };
}

/**
 * The controller replication must go through. Uses the active controller,
 * or builds one from DATABASE_URL. Returns null when no shared registry is
 * configured — callers must treat that as a denial.
 */
export async function getSharedFleetForContext(
  ctx: Pick<ToolContext, "identity" | "config" | "conway">,
  fleetConfig: FleetConfig = loadFleetConfig(),
  opts: { selfAgentId?: string | null; runtimeVersion?: string | null; runtimeCommit?: string | null } = {},
): Promise<SharedFleetController | null> {
  if (active) return active;
  const store = PgFleetStore.fromEnv();
  if (!store) return null;
  const controller = new SharedFleetController({
    store,
    config: fleetConfig,
    self: { address: ctx.identity.address, name: ctx.config.name },
    isRootAgent: !ctx.config.parentAddress,
    selfAgentId: opts.selfAgentId ?? null,
    runtimeVersion: opts.runtimeVersion ?? null,
    runtimeCommit: opts.runtimeCommit ?? null,
    getFinancialSnapshot: async () => {
      const creditsCents = await ctx.conway.getCreditsBalance();
      return { creditsCents, survivalTier: getSurvivalTier(creditsCents) };
    },
  });
  await controller.init();
  setActiveSharedFleet(controller);
  return controller;
}

export async function closeActiveSharedFleet(): Promise<void> {
  const c = active;
  setActiveSharedFleet(null);
  await c?.close();
}

/**
 * Denials that follow from local configuration alone (DEVELOPMENT, EMERGENCY,
 * HARVEST, REAL_REPLICATION_ENABLED=false) need no registry round-trip.
 */
export function localReplicationPreflight(config: FleetConfig, isRootAgent: boolean): FleetDecision {
  const state = computeFleetState({ configuredMode: config.configuredMode, emergency: false, livingAgents: 0, maxAgents: config.maxAgents });
  return evaluateReplication({ config, state, livingAgents: 0, maxAgents: config.maxAgents, isRootAgent, sharedRegistry: true });
}

/**
 * The single production replication path: local preflight, then the shared
 * registry controller. No shared registry => denied.
 */
export async function requestSharedReplication<TChild extends SharedSpawnedChild>(
  ctx: Pick<ToolContext, "identity" | "config" | "conway">,
  request: { name: string; requestedBy?: string },
  spawn: (grant: FleetSpawnGrant) => Promise<TChild>,
  fleetConfig: FleetConfig = loadFleetConfig(),
): Promise<ReplicationOutcome<TChild>> {
  const pre = localReplicationPreflight(fleetConfig, !ctx.config.parentAddress);
  if (!pre.allowed) return { ok: false, decision: pre };
  let fleet: SharedFleetController | null;
  try {
    fleet = await getSharedFleetForContext(ctx, fleetConfig);
  } catch (err) {
    return { ok: false, decision: registryUnavailableDecision(fleetConfig, err instanceof Error ? err.message : String(err)) };
  }
  if (!fleet) return { ok: false, decision: registryUnavailableDecision(fleetConfig, "DATABASE_URL not configured") };
  return fleet.requestReplication(request, spawn);
}
