/**
 * Fleet layer public API.
 */

import type { ToolContext } from "../types.js";
import { getSurvivalTier } from "../conway/credits.js";
import { loadFleetConfig } from "./config.js";
import { FleetController } from "./controller.js";
import type { FleetConfig } from "./types.js";

export * from "./types.js";
export { loadFleetConfig, DEFAULT_FLEET_CONFIG, FLEET_HARD_MAX_AGENTS } from "./config.js";
export { FleetRegistry, FleetBypassError } from "./registry.js";
export { FleetController } from "./controller.js";
export { SharedFleetController } from "./shared-controller.js";
export {
  getActiveSharedFleet,
  setActiveSharedFleet,
  getSharedFleetForContext,
  requestSharedReplication,
  closeActiveSharedFleet,
} from "./shared.js";
export {
  PgFleetStore,
  FleetRegistryUnavailableError,
  FleetDuplicateRegistrationError,
  agentIdFromToken,
  hashAgentToken,
} from "./postgres/store.js";
export type { FleetTimeouts } from "./postgres/store.js";
export { FLEET_PG_SCHEMA_VERSION, PG_MIGRATIONS, AGENT_API_FUNCTIONS, SERVICE_API_FUNCTIONS, SERVICE_READ_TABLES } from "./postgres/migrations.js";
export { auditPrivileges } from "./postgres/privileges.js";
export type { PrivilegeAuditResult } from "./postgres/privileges.js";
export { runDoctor, formatDoctorReport } from "./doctor.js";
export type { DoctorReport, DoctorCheck } from "./doctor.js";
export { readSecretEnvFile, loadAdminEnv, loadServiceEnv, SecretFileError } from "./secret-files.js";
export { UnsupportedSandboxTerminator } from "./service/terminator.js";
export * as treasury from "./treasury/engine.js";
export { PgTreasuryStore } from "./treasury/store.js";
export { executeApprovedSpend } from "./treasury/custody.js";
export { RateLimiter } from "./service/rate-limit.js";
export { signRequest, canonicalRequest, SIG_HEADERS } from "./service/server-signing.js";
export { defaultHealthResponder } from "./service/client.js";
export type { HealthResponder } from "./service/client.js";
export type { SandboxTerminator } from "./service/terminator.js";
export { PgAgentGateway } from "./postgres/agent-gateway.js";
export type { FleetBackend } from "./backend.js";
export { FleetService } from "./service/server.js";
export { FleetApiClient, validateServiceUrl, readCredentialFile } from "./service/client.js";
export {
  ATTEST_SCRIPT,
  computeBuildIdentity,
  checkAttestation,
  parseAttestation,
  attestationProof,
  loadRuntimeBuild,
  validateRuntimeBuild,
} from "./attestation.js";
export type { RuntimeAttestation, RuntimeBuild, BuildIdentity } from "./attestation.js";
export { findPrivilegedEnv, scrubPrivilegedEnv, agentChildEnv, isPrivilegedEnvName } from "./secrets.js";
export {
  FleetRuntimeError,
  validateRuntimePin,
  loadRuntimePin,
  resolveChildRuntime,
  verifyChildRuntime,
  verifyOwnRuntime,
  isUpstreamRepo,
} from "./runtime.js";
export type { RuntimePin } from "./runtime.js";
export {
  computeFleetState,
  evaluateReplication,
  evaluateToolCall,
  evaluateFinancialEligibility,
  EMERGENCY_BLOCKED_TOOLS,
} from "./policy.js";

/**
 * Build a Phase 1 local (SQLite) controller. Local-only: it cannot see other
 * sandboxes, so no production replication path uses it — spawn_child and the
 * orchestrator go through requestSharedReplication().
 */
export function createFleetControllerForContext(
  ctx: Pick<ToolContext, "db" | "identity" | "config" | "conway">,
  fleetConfig: FleetConfig = loadFleetConfig(),
): FleetController {
  return new FleetController({
    db: ctx.db.raw,
    config: fleetConfig,
    self: { address: ctx.identity.address, name: ctx.config.name },
    isRootAgent: !ctx.config.parentAddress,
    getFinancialSnapshot: async () => {
      const creditsCents = await ctx.conway.getCreditsBalance();
      return { creditsCents, survivalTier: getSurvivalTier(creditsCents) };
    },
  });
}
