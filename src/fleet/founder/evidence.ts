/**
 * Founder runtime attestation evidence (Phase F.1, schema v12).
 *
 * Two independent observations of the same founder process must agree with
 * the Genesis authorization before the database attests it:
 *
 *   RuntimeEvidence — produced by the founder process about itself (its own
 *     installed tree identity, compiled capability manifest, identity files,
 *     workspace/state directories) and submitted with its one-time
 *     attestation token and nonce;
 *   HostEvidence — produced by the owner's provisioner from OUTSIDE the
 *     process (/proc/<pid>/cwd tree identity, environment, uid, state
 *     directory ownership, the instance id the process wrote to its state).
 *
 * Both carry the same field set so the database can compare each against
 * the authorization with one function.
 */

import crypto from "crypto";

export interface FounderEvidenceCore {
  agentId: string;
  genesisId: string;
  repo: string;
  commit: string;
  buildId: string;
  lockfileSha256: string;
  manifestId: string;
  manifestSha256: string;
  workspaceId: string;
  stateNamespace: string;
  instanceId: string;
  pid: number;
  uid: number;
}

export interface RuntimeEvidence extends FounderEvidenceCore {
  nonce: string;
  bootedAt: string;
  workspaceDir: string;
  stateDir: string;
  capabilitySelfTest: { tools: number; allowed: number; denied: number; forbiddenAllowed: number; unclassifiedDenied: boolean };
}

export interface HostEvidence extends FounderEvidenceCore {
  source: "systemd" | "process";
  unit: string | null;
  exe: string | null;
  cwd: string;
  envFounderId: string | null;
  envManifest: string | null;
  stateDirOwnerUid: number | null;
  stateDirMode: string | null;
  observedAt: string;
}

/** Identity files the provisioner places in a founder's private state directory (non-secret except the token). */
export interface FounderIdentityFile {
  v: 1;
  agentId: string;
  genesisId: string;
  workspaceId: string;
  stateNamespace: string;
  manifestId: string;
  manifestSha256: string;
  apiUrl: string;
}

export interface FounderAttestFile {
  v: 1;
  agentId: string;
  genesisId: string;
  token: string;
  nonce: string;
}

export const FOUNDER_IDENTITY_FILE = "founder.json";
export const FOUNDER_ATTEST_FILE = "genesis-attest.json";
export const FOUNDER_CREDENTIAL_FILE = "fleet-credentials.json";
export const FOUNDER_INSTANCE_FILE = "runtime-instance.json";
export const FOUNDER_REPORT_FILE = "runtime-report.json";

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function newAttestationSecret(): { token: string; tokenSha256: string; nonce: string } {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, tokenSha256: crypto.createHash("sha256").update(token, "utf8").digest("hex"), nonce: crypto.randomBytes(24).toString("base64url") };
}

export function newInstanceId(): string {
  return crypto.randomBytes(18).toString("base64url");
}

/** Header scheme for the single attestation endpoint: `FleetFounderAttest <agentId>.<token>`. */
export const FOUNDER_ATTEST_SCHEME = "FleetFounderAttest";

export function parseFounderAttestHeader(h: string | undefined): { agentId: string; token: string } | null {
  const m = /^FleetFounderAttest ([0-9A-HJKMNP-TV-Z]{26})\.([A-Za-z0-9_-]{32,128})$/.exec(h ?? "");
  return m ? { agentId: m[1], token: m[2] } : null;
}
