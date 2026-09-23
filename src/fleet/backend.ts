/**
 * FleetBackend — what a SharedFleetController needs from the registry.
 *
 * Two implementations:
 *   - PgFleetStore  (controller/operator side; holds admin DB credentials,
 *                    used by the fleet service and by tests)
 *   - FleetApiClient (agent side; talks to the fleet service over HTTP with
 *                    the agent's own bearer credential, no DB credentials)
 */

import type { RuntimeAttestation } from "./attestation.js";
import type { RegisterResult, SharedReserveResult } from "./postgres/store.js";
import type { RuntimePin } from "./runtime.js";
import type { ActivationResult, FleetHealth, SharedAgentStatus, SharedFleetState } from "./types.js";

export interface FleetBackend {
  readonly kind: "postgres" | "api";
  health(): Promise<FleetHealth>;
  getState(): Promise<SharedFleetState>;
  listMemberAddresses(): Promise<string[]>;
  registerRoot(params: {
    walletAddress: string;
    name: string;
    runtimeVersion?: string | null;
    runtimeCommit?: string | null;
    localMaxAgents?: number;
  }): Promise<RegisterResult>;
  attachAgent(agentId: string, walletAddress: string): Promise<RegisterResult>;
  heartbeat(agentId: string): Promise<boolean>;
  selfStatus(agentId: string): Promise<SharedAgentStatus | null>;
  reserveSlot(params: {
    parentAgentId: string;
    requestedBy: string;
    name: string;
    runtime: RuntimePin | null;
    requestKey?: string;
    localMaxAgents?: number;
  }): Promise<SharedReserveResult>;
  releaseReservation(agentId: string, reason: string): Promise<boolean>;
  recordVerificationFailure(agentId: string, reason: string): Promise<boolean>;
  activate(
    agentId: string,
    params: {
      walletAddress: string;
      sandboxId?: string | null;
      runtimeCommit?: string | null;
      runtimeVersion?: string | null;
      attestation?: RuntimeAttestation | null;
    },
  ): Promise<ActivationResult>;
  markDeadByLocalChildId(localChildId: string, reason: string): Promise<boolean>;
  close(): Promise<void>;
}
