/**
 * Simulated founder-runtime attestation (schema v12), for the database-only
 * Genesis dry run and tests: issues a runtime token, submits the runtime's
 * evidence through the same service function the controller uses, and
 * returns matching host evidence. The real-runtime path is
 * src/fleet/founder/provisioner.ts; this is never used to attest a real
 * founder (it runs inside the dry run's rolled-back transaction or in tests).
 */

import { newAttestationSecret, newInstanceId } from "../founder/evidence.js";
import type { GenesisDb, GenesisOps } from "./admin.js";

export async function simulateRuntimeAttestation(
  db: GenesisDb,
  ops: GenesisOps,
  genesisId: string,
  agentId: string,
  actor: string,
  overrides: { runtime?: Record<string, unknown>; host?: Record<string, unknown>; submit?: boolean } = {},
): Promise<{ host: Record<string, unknown>; submitted: Record<string, unknown> | null }> {
  const secret = newAttestationSecret();
  await ops.issueRuntime(genesisId, agentId, secret.tokenSha256, secret.nonce, actor);
  const e = await ops.expectedEvidence(genesisId, agentId);
  const pins = (await db.query(`SELECT runtime_repo, manifest_id FROM fleet_genesis WHERE genesis_id = $1`, [genesisId])).rows[0];
  const core = {
    agentId,
    genesisId,
    repo: pins.runtime_repo,
    commit: e.commit,
    buildId: e.buildId,
    lockfileSha256: e.lockfileSha256,
    manifestId: pins.manifest_id,
    manifestSha256: e.manifestSha256,
    workspaceId: e.workspaceId,
    stateNamespace: e.stateNamespace,
    instanceId: newInstanceId(),
    pid: 4242,
    uid: 61000,
  };
  let submitted: Record<string, unknown> | null = null;
  if (overrides.submit !== false) {
    const runtime = { ...core, nonce: secret.nonce, ...(overrides.runtime ?? {}) };
    submitted = (await db.query(`SELECT svc_genesis_runtime_evidence($1, $2, $3) AS r`, [agentId, secret.token, JSON.stringify(runtime)])).rows[0].r;
  }
  return { host: { ...core, source: "process", ...(overrides.host ?? {}) }, submitted };
}
