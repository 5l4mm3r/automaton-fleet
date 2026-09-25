/**
 * Shared Fleet Controller (Phase 2)
 *
 * Replication entry point backed by the shared PostgreSQL registry. The
 * global cap, operating mode and approved runtime come from fleet_state;
 * the local environment can only make them stricter.
 *
 *   1. FleetPolicy on the shared counts (state, flags, cap), runtime pin
 *      check, financial eligibility,
 *   2. PgFleetStore.reserveSlot() — atomic, under the fleet_state row lock,
 *   3. spawn(grant) — spawnChild() claims the grant before any side effect,
 *      installs the pinned runtime and attests it,
 *   4. activate (the registry checks the attestation against the
 *      reservation's recorded expectations) or release on any failure,
 *   5. deliver the child's own registry credential into its sandbox.
 *
 * Phase 3: the backend is either the admin PgFleetStore (fleet service,
 * tests) or FleetApiClient (agents), so agents never hold DB credentials.
 * If the registry is unreachable every replication request is denied with
 * FLEET_REGISTRY_UNAVAILABLE; nothing else about the agent is affected.
 */

import { ulid } from "ulid";
import { effectiveMaxAgents as effectiveMax, localCapOverride, strictestMode } from "./config.js";
import { computeFleetState, evaluateFinancialEligibility, evaluateReplication } from "./policy.js";
import type { FleetBackend } from "./backend.js";
import { FleetRuntimeError, resolveChildRuntime, samePin } from "./runtime.js";
import type {
  FleetCredential,
  SharedAgentStatus,
  SharedSpawnedChildReport,
  FinancialSnapshot,
  FleetConfig,
  FleetDecision,
  FleetDecisionCode,
  FleetSpawnGrant,
  FleetState,
  ReplicationOutcome,
  SharedFleetSnapshot,
  SharedFleetState,
} from "./types.js";

export interface SharedFleetControllerOptions {
  store: FleetBackend;
  config: FleetConfig;
  self: { address: string; name: string };
  /** False for children; they identify via selfAgentId from their runtime manifest. */
  isRootAgent: boolean;
  selfAgentId?: string | null;
  runtimeVersion?: string | null;
  runtimeCommit?: string | null;
  getFinancialSnapshot?: () => Promise<FinancialSnapshot>;
  /** Snapshots older than this are treated as unhealthy by the policy rule. */
  snapshotStaleMs?: number;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
  /** Called once when the registry reports this agent dead/failed (e.g. reaped). */
  onDead?: (status: SharedAgentStatus) => void;
}

export type SharedSpawnedChild = SharedSpawnedChildReport;

/** Puts the child's own credential into its sandbox (never the parent's, never DB credentials). */
export type CredentialDelivery<TChild> = (child: TChild, credential: FleetCredential) => Promise<void>;

export interface SharedFleetStatus {
  state: FleetState;
  shared: SharedFleetState;
  effectiveMaxAgents: number;
  occupied: number;
}

const DEFAULT_STALE_MS = 90_000;

export class SharedFleetController {
  private selfAgentId: string | null;
  /** True only after the registry confirmed this agent's identity. */
  private registered = false;
  private last: SharedFleetSnapshot;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: SharedFleetControllerOptions) {
    this.selfAgentId = opts.selfAgentId ?? null;
    this.last = { healthy: false, checkedAt: 0, state: null, selfAgentId: null, memberAddresses: new Set(), error: "not yet checked" };
  }

  get store(): FleetBackend {
    return this.opts.store;
  }

  get config(): FleetConfig {
    return this.opts.config;
  }

  /** Confirmed registry id; null until registration/attachment succeeds. */
  get agentId(): string | null {
    return this.registered ? this.selfAgentId : null;
  }

  private log(level: "info" | "warn" | "error", msg: string): void {
    this.opts.log?.(level, msg);
  }

  /**
   * Register (root) or attach (child) this automaton. Never throws; an
   * unregistered agent keeps running but cannot replicate.
   */
  async init(): Promise<{ ok: boolean; code?: string; reason?: string }> {
    try {
      const res = this.opts.isRootAgent
        ? await this.opts.store.registerRoot({
            walletAddress: this.opts.self.address,
            name: this.opts.self.name,
            runtimeVersion: this.opts.runtimeVersion ?? null,
            runtimeCommit: this.opts.runtimeCommit ?? null,
            localMaxAgents: localCapOverride(this.opts.config),
          })
        : this.selfAgentId
          ? await this.opts.store.attachAgent(this.selfAgentId, this.opts.self.address)
          : { ok: false as const, code: "FLEET_NOT_REGISTERED" as const, reason: "Child has no fleet agent id." };
      if (res.ok) {
        this.selfAgentId = res.agent.agentId;
        this.registered = true;
      } else {
        this.registered = false;
        this.log("warn", `Fleet registration failed: ${res.code} — ${res.reason}`);
      }
      await this.refresh();
      return res.ok ? { ok: true } : { ok: false, code: res.code, reason: res.reason };
    } catch (err) {
      await this.refresh();
      const reason = err instanceof Error ? err.message : String(err);
      this.log("warn", `Fleet registry unavailable at init: ${reason}`);
      return { ok: false, code: "FLEET_REGISTRY_UNAVAILABLE", reason };
    }
  }

  /** Re-read shared state for the synchronous policy rule. Never throws. */
  async refresh(): Promise<SharedFleetSnapshot> {
    try {
      const health = await this.opts.store.health();
      if (!health.ok) throw new Error(health.error ?? "unhealthy");
      const [state, members] = await Promise.all([this.opts.store.getState(), this.opts.store.listMemberAddresses()]);
      this.last = { healthy: true, checkedAt: Date.now(), state, selfAgentId: this.agentId, memberAddresses: new Set(members) };
    } catch (err) {
      this.last = {
        healthy: false,
        checkedAt: Date.now(),
        state: null,
        selfAgentId: this.agentId,
        memberAddresses: this.last.memberAddresses,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return this.last;
  }

  /** Last snapshot, marked unhealthy once stale. */
  snapshot(now = Date.now()): SharedFleetSnapshot {
    const stale = now - this.last.checkedAt > (this.opts.snapshotStaleMs ?? DEFAULT_STALE_MS);
    return stale && this.last.healthy ? { ...this.last, healthy: false, error: "fleet snapshot stale" } : this.last;
  }

  /**
   * Heartbeat this agent (UPDATE only; never inserts) and refresh the
   * snapshot. If the registry says this agent is dead (reaped, or marked by
   * the operator) the agent stops being registered and onDead fires once.
   */
  async heartbeat(): Promise<boolean> {
    let ok = false;
    try {
      if (!this.registered && !this.dead) await this.init();
      if (this.registered && this.selfAgentId) {
        ok = await this.opts.store.heartbeat(this.selfAgentId);
        if (!ok) {
          const status = await this.opts.store.selfStatus(this.selfAgentId).catch(() => null);
          if (status === "dead" || status === "failed") this.handleDeath(status);
        }
      }
    } catch (err) {
      this.log("warn", `Fleet heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.refresh();
    return ok;
  }

  private dead = false;

  private handleDeath(status: SharedAgentStatus): void {
    if (this.dead) return;
    this.dead = true;
    this.registered = false;
    this.log("error", `Fleet registry reports this agent ${this.selfAgentId} as ${status}; its slot has been released.`);
    try {
      this.opts.onDead?.(status);
    } catch {
      // onDead must not break the heartbeat loop
    }
  }

  startHeartbeat(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.heartbeat(), intervalMs);
    this.timer.unref?.();
  }

  stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async close(): Promise<void> {
    this.stopHeartbeat();
    await this.opts.store.close();
  }

  // ─── Decisions ─────────────────────────────────────────────────

  private deny(code: FleetDecisionCode, reason: string, state: FleetState): FleetDecision {
    return { allowed: false, code, reason, state };
  }

  async getStatus(): Promise<SharedFleetStatus> {
    const shared = await this.opts.store.getState();
    const effectiveMaxAgents = effectiveMax(this.opts.config, shared.maxAgents);
    const occupied = shared.livingAgents + shared.reservedSlots + (shared.quarantinedSlots ?? 0);
    const state = computeFleetState({
      configuredMode: strictestMode(this.opts.config.configuredMode, shared.operatingMode),
      emergency: false,
      livingAgents: occupied,
      maxAgents: effectiveMaxAgents,
    });
    return { state, shared, effectiveMaxAgents, occupied };
  }

  async evaluateReplication(requestedRuntime?: { repo?: unknown; commit?: unknown }): Promise<FleetDecision> {
    let status: SharedFleetStatus;
    try {
      status = await this.getStatus();
    } catch (err) {
      return this.deny(
        "FLEET_REGISTRY_UNAVAILABLE",
        `Shared fleet registry unavailable; replication fails closed (${err instanceof Error ? err.message : String(err)}).`,
        strictestMode(this.opts.config.configuredMode, "DEVELOPMENT"),
      );
    }

    const gate = evaluateReplication({
      config: this.opts.config,
      state: status.state,
      livingAgents: status.occupied,
      maxAgents: status.effectiveMaxAgents,
      isRootAgent: this.opts.isRootAgent,
      sharedRegistry: true,
    });
    if (!gate.allowed) return gate;

    if (!this.registered) {
      await this.init();
      if (!this.registered) {
        return this.deny("FLEET_NOT_REGISTERED", "This agent is not registered in the shared fleet registry.", status.state);
      }
    }

    try {
      const pin = resolveChildRuntime(this.opts.config.runtime, requestedRuntime);
      if (!samePin(pin, status.shared.runtime)) {
        return this.deny("FLEET_RUNTIME_UNVERIFIED", "Local runtime pin does not match the fleet-approved runtime.", status.state);
      }
    } catch (err) {
      return this.deny("FLEET_RUNTIME_UNVERIFIED", err instanceof Error ? err.message : String(err), status.state);
    }

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
   * Request a new child. `spawn` receives a single-use grant bound to the
   * shared registry and must pass it to spawnChild(). Policy denials are
   * returned; spawn errors are rethrown after the slot has been released.
   */
  async requestReplication<TChild extends SharedSpawnedChild>(
    request: { name: string; requestedBy?: string; requestKey?: string; runtime?: { repo?: unknown; commit?: unknown } },
    spawn: (grant: FleetSpawnGrant) => Promise<TChild>,
    deliverCredential?: CredentialDelivery<TChild>,
  ): Promise<ReplicationOutcome<TChild>> {
    const requestedBy = request.requestedBy ?? this.opts.self.address;
    const decision = await this.evaluateReplication(request.runtime);
    if (!decision.allowed) return { ok: false, decision };

    let reservation;
    try {
      reservation = await this.opts.store.reserveSlot({
        parentAgentId: this.selfAgentId!,
        requestedBy,
        name: request.name,
        runtime: this.opts.config.runtime ?? null,
        requestKey: request.requestKey ?? ulid(),
        localMaxAgents: localCapOverride(this.opts.config),
      });
    } catch (err) {
      return {
        ok: false,
        decision: this.deny(
          "FLEET_REGISTRY_UNAVAILABLE",
          `Slot reservation failed; replication fails closed (${err instanceof Error ? err.message : String(err)}).`,
          decision.state,
        ),
      };
    }
    if (!reservation.ok) {
      return { ok: false, decision: this.deny(reservation.code, reservation.reason, decision.state) };
    }

    const agentId = reservation.agent.agentId;
    const release = async (why: string) => {
      try {
        await this.opts.store.releaseReservation(agentId, why);
      } catch (err) {
        // Registry unreachable: the slot stays occupied (fail-safe over-count)
        // until an operator releases it.
        this.log("error", `Could not release fleet slot ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    let child: TChild;
    try {
      child = await spawn(reservation.grant);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof FleetRuntimeError) {
        // Runtime verification failed: stop, release, mark provisioning failed.
        await this.opts.store.recordVerificationFailure(agentId, msg).catch(() => release(`runtime verification failed: ${msg}`));
      } else {
        await release(`spawn failed: ${msg}`);
      }
      throw err;
    }

    let credential: FleetCredential;
    try {
      if (!child.address) throw new Error("spawned child has no wallet address");
      ({ credential } = await this.opts.store.activate(agentId, {
        walletAddress: child.address,
        sandboxId: child.sandboxId ?? null,
        runtimeCommit: child.runtimeCommit ?? null,
        runtimeVersion: child.runtimeVersion ?? null,
        attestation: child.attestation ?? null,
      }));
    } catch (err) {
      await release(`activation failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    if (deliverCredential) {
      try {
        await deliverCredential(child, credential);
      } catch (err) {
        // Without its credential the child cannot heartbeat; the reaper will
        // mark it unresponsive and then dead, releasing the slot.
        this.log("error", `Could not deliver fleet credential to child ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await this.refresh();
    return { ok: true, agentId, child, state: (await this.getStatus().catch(() => null))?.state ?? decision.state };
  }
}

export { FleetRuntimeError };
