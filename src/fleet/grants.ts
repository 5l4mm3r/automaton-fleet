/**
 * Fleet spawn grants
 *
 * A grant is proof that a slot was reserved. Grants issued by the shared
 * (PostgreSQL) registry are bound here to the store that issued them; the
 * binding lives in a module-private WeakMap, so an object merely shaped like
 * a grant (forged, deserialised, or copied from a reservation id) has no
 * binding and cannot be claimed through the shared path.
 *
 * Grants without a binding fall back to the Phase 1 local SQLite registry,
 * which checks the reservation row itself. Production call sites (spawn_child
 * tool, orchestrator) only ever obtain shared grants.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { FleetBypassError, FleetRegistry } from "./registry.js";
import { loadRuntimePin, type RuntimePin } from "./runtime.js";
import { loadRuntimeBuild, newAttestationNonce, type RuntimeBuild } from "./attestation.js";
import type { FleetSpawnGrant } from "./types.js";

export interface ClaimedGrant {
  agentId: string;
  parentAgentId: string | null;
  generation: number;
  /** Runtime the child must run, as approved for this reservation. */
  runtime: RuntimePin | null;
  /** Build identity the child must prove before activation (Phase 3). */
  expectedBuild: RuntimeBuild | null;
  /** Single-use attestation nonce issued at claim time (Phase 3). */
  nonce: string | null;
  reservationId: string | null;
  backend: "postgres" | "sqlite";
  /**
   * Phase 5: report provisioning progress to the controller. Called the
   * moment a sandbox exists ("sandbox_created") and before runtime
   * verification ("verifying"), so a failed provisioning stays visible for
   * cleanup. Absent for the local (SQLite) path.
   */
  reportProvisioning?: (phase: "sandbox_created" | "verifying", sandboxId?: string) => Promise<void>;
  /**
   * Phase 6: the provisioning key (= reservation id). Carried through sandbox
   * creation (deterministic sandbox name), the child's runtime manifest, the
   * provisioning callbacks and activation.
   */
  provisioningKey?: string | null;
  /**
   * Phase 6: record the durable external-resource intent BEFORE creating the
   * sandbox. Returns the attempt number and the sandbox id if the controller
   * already knows it (then it must be reused).
   */
  recordSandboxIntent?: (sandboxName: string) => Promise<{ sandboxId: string | null; attempts: number; sandboxName: string }>;
  /** Phase 6: report the outcome of looking up an uncertain sandbox by name. */
  reconcileProvisioning?: (outcome: "found" | "absent" | "unknown", sandboxId?: string) => Promise<void>;
}

type Claimer = (localChildId: string) => Promise<ClaimedGrant>;

const bindings = new WeakMap<FleetSpawnGrant, Claimer>();

export function createBoundGrant(reservationId: string, claim: Claimer): FleetSpawnGrant {
  const grant: FleetSpawnGrant = Object.freeze({ kind: "fleet-spawn-grant", reservationId });
  bindings.set(grant, claim);
  return grant;
}

export function isSharedGrant(grant: unknown): boolean {
  return typeof grant === "object" && grant !== null && bindings.has(grant as FleetSpawnGrant);
}

/**
 * Consume a grant exactly once. Throws FleetBypassError when the grant is
 * missing, malformed, forged, expired or already used.
 */
export async function claimFleetGrant(
  grant: FleetSpawnGrant | undefined,
  localChildId: string,
  localDb: DatabaseType,
): Promise<ClaimedGrant> {
  if (grant && typeof grant === "object") {
    const claim = bindings.get(grant);
    if (claim) {
      bindings.delete(grant);
      return claim(localChildId);
    }
  }
  const agent = new FleetRegistry(localDb).claimGrant(grant, localChildId);
  return {
    agentId: agent.id,
    parentAgentId: agent.parentAgentId,
    generation: agent.generation,
    runtime: loadRuntimePin(),
    expectedBuild: loadRuntimeBuild(),
    nonce: newAttestationNonce(),
    reservationId: agent.id,
    backend: "sqlite",
  };
}

export { FleetBypassError };
