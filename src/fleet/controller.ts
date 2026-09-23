/**
 * Fleet Controller
 *
 * The single entry point for reproduction. Every replication request —
 * from the spawn_child tool or the orchestrator — goes through
 * requestReplication(), which:
 *
 *   1. evaluates FleetPolicy (state, flags, root-only, cap),
 *   2. checks financial eligibility (EXPANSION only, fails closed),
 *   3. atomically reserves a living slot in FleetRegistry,
 *   4. hands the resulting single-use grant to the spawn function,
 *   5. activates the slot on success or releases it on failure.
 *
 * spawnChild() refuses to run without a grant, so the controller cannot
 * be skipped by calling the lower-level spawn function directly.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { FleetRegistry } from "./registry.js";
import {
  computeFleetState,
  evaluateFinancialEligibility,
  evaluateReplication,
  evaluateToolCall,
} from "./policy.js";
import type {
  FinancialSnapshot,
  FleetConfig,
  FleetDecision,
  FleetSpawnGrant,
  FleetState,
  FleetStatus,
  ReplicationOutcome,
} from "./types.js";

export interface FleetControllerOptions {
  db: DatabaseType;
  config: FleetConfig;
  /** The automaton this controller runs inside. */
  self: { address: string; name: string };
  /** False when this automaton has a parent (it cannot see the global registry). */
  isRootAgent: boolean;
  /** Supplies the parent's current finances. Errors fail closed. */
  getFinancialSnapshot?: () => Promise<FinancialSnapshot>;
}

export interface SpawnedChildInfo {
  address?: string;
  sandboxId?: string;
}

export class FleetController {
  readonly registry: FleetRegistry;
  private readonly rootAgentId: string;

  constructor(private readonly opts: FleetControllerOptions) {
    this.registry = new FleetRegistry(opts.db);
    this.registry.setMaxAgents(opts.config.maxAgents);
    this.rootAgentId = this.registry.ensureRootAgent(opts.self).id;
  }

  get config(): FleetConfig {
    return this.opts.config;
  }

  getStatus(): FleetStatus {
    const livingAgents = this.registry.countLiving();
    const maxAgents = this.registry.getMaxAgents();
    const emergency = this.registry.isEmergency();
    return {
      state: computeFleetState({
        configuredMode: this.opts.config.configuredMode,
        emergency,
        livingAgents,
        maxAgents,
      }),
      configuredMode: this.opts.config.configuredMode,
      emergency,
      livingAgents,
      maxAgents,
      totalRecorded: this.registry.countTotal(),
    };
  }

  getState(): FleetState {
    return this.getStatus().state;
  }

  enterEmergency(reason: string): void {
    this.registry.setEmergency(true, reason, this.opts.self.address);
  }

  clearEmergency(reason: string): void {
    this.registry.setEmergency(false, reason, this.opts.self.address);
  }

  /** Synchronous gate used by the PolicyEngine rule. */
  evaluateToolCall(toolName: string, args: Record<string, unknown>): FleetDecision | null {
    const status = this.getStatus();
    return evaluateToolCall({
      toolName,
      args,
      config: this.opts.config,
      state: status.state,
      livingAgents: status.livingAgents,
      maxAgents: status.maxAgents,
      isRootAgent: this.opts.isRootAgent,
      isFleetMemberAddress: (a) => this.registry.isFleetMemberAddress(a),
    });
  }

  /** Full pre-reservation check, including financial eligibility. */
  async evaluateReplication(): Promise<FleetDecision> {
    const status = this.getStatus();
    const gate = evaluateReplication({
      config: this.opts.config,
      state: status.state,
      livingAgents: status.livingAgents,
      maxAgents: status.maxAgents,
      isRootAgent: this.opts.isRootAgent,
    });
    if (!gate.allowed) return gate;

    let snapshot: FinancialSnapshot | null = null;
    if (this.opts.getFinancialSnapshot) {
      try {
        snapshot = await this.opts.getFinancialSnapshot();
      } catch {
        snapshot = null;
      }
    }
    return evaluateFinancialEligibility(snapshot, this.opts.config, status.state);
  }

  /**
   * Request a new child. `spawn` receives the single-use grant and must pass
   * it to spawnChild(). Policy denials are returned; spawn errors are
   * rethrown after the reserved slot has been released.
   */
  async requestReplication<TChild extends SpawnedChildInfo>(
    request: { name: string; requestedBy?: string },
    spawn: (grant: FleetSpawnGrant) => Promise<TChild>,
  ): Promise<ReplicationOutcome<TChild>> {
    const requestedBy = request.requestedBy ?? this.opts.self.address;

    const decision = await this.evaluateReplication();
    if (!decision.allowed) {
      this.registry.recordEvent("replication_denied", null, requestedBy, {
        code: decision.code,
        reason: decision.reason,
        state: decision.state,
        name: request.name,
      });
      return { ok: false, decision };
    }

    const reservation = this.registry.reserveSlot({
      parentAgentId: this.rootAgentId,
      requestedBy,
      name: request.name,
    });
    if (!reservation.ok) {
      return {
        ok: false,
        decision: {
          allowed: false,
          code: reservation.code,
          reason: reservation.reason,
          state: this.getState(),
        },
      };
    }

    const agentId = reservation.agent.id;
    let child: TChild;
    try {
      child = await spawn(reservation.grant);
    } catch (err) {
      this.registry.releaseReservation(agentId, `spawn failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    try {
      this.registry.activate(agentId, { address: child.address, sandboxId: child.sandboxId });
    } catch (err) {
      // The spawn function did not claim the grant (or the child already
      // died). Never leave a dangling living slot.
      this.registry.releaseReservation(agentId, `activation failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    return { ok: true, agentId, child, state: this.getState() };
  }
}
