/**
 * DRY_RUN_CHILD — child side (Phase 6).
 *
 * What a dry-run child runs inside its sandbox instead of the autonomous
 * agent: `node dist/fleet/dry-run/child-main.js`. It proves fleet membership
 * and nothing else:
 *   - reads its own scoped fleet credential (0600) and runtime manifest;
 *   - opens a short-lived session with the controller over HTTPS;
 *   - heartbeats and answers controller health challenges (runtime identity
 *     + policy canary), which is what keeps it ACTIVE.
 *
 * It never starts the agent loop, never creates or loads a wallet, never
 * requests replication, spend or capital, and refuses to run at all if the
 * environment carries payment/sweep/replication switches, database or
 * controller credentials, or a wallet key.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { CHILD_RUNTIME_MANIFEST, type ChildRuntimeManifest } from "../runtime.js";
import { FleetApiClient, defaultHealthResponder, readCredentialFile, validateServiceUrl } from "../service/client.js";

/** Environment variables a dry-run child must never see. */
export const DRY_RUN_FORBIDDEN_ENV: readonly string[] = Object.freeze([
  "FLEET_ADMIN_DATABASE_URL",
  "FLEET_SERVICE_DATABASE_URL",
  "FLEET_AGENT_DATABASE_URL",
  "FLEET_CONTROLLER_DATABASE_URL",
  "DATABASE_URL",
  "REDIS_URL",
  "PGPASSWORD",
  "WALLET_PRIVATE_KEY",
  "PRIVATE_KEY",
  "CONWAY_API_KEY",
]);

const TRUE_FLAGS = ["REAL_PAYMENTS_ENABLED", "OWNER_SWEEP_ENABLED", "REAL_REPLICATION_ENABLED"];

export interface DryRunChildOptions {
  env?: Record<string, string | undefined>;
  credentialsFile?: string;
  manifestPath?: string;
  /** Wallet file whose presence refuses the run (the dry-run child holds no signing key). */
  walletFile?: string;
  /** Heartbeats to send; 0 = until stopped. Default 0. */
  heartbeats?: number;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  log?: (event: string, detail?: Record<string, unknown>) => void;
  signal?: AbortSignal;
}

export interface DryRunChildResult {
  agentId: string;
  provisioningKey: string;
  heartbeats: number;
  challengesPassed: number;
  status: string | null;
}

function home(env: Record<string, string | undefined>): string {
  return env.HOME || os.homedir() || "/root";
}

/** Everything that makes this process unfit to be a zero-authority dry-run child. */
export function dryRunChildProblems(opts: DryRunChildOptions = {}): string[] {
  const env = opts.env ?? process.env;
  const problems: string[] = [];
  for (const k of TRUE_FLAGS) if (env[k]?.trim().toLowerCase() === "true") problems.push(`${k}=true`);
  for (const k of DRY_RUN_FORBIDDEN_ENV) if (env[k]?.trim()) problems.push(`${k} present in the environment`);
  const wallet = opts.walletFile ?? path.join(home(env), ".automaton", "wallet.json");
  if (fs.existsSync(wallet)) problems.push(`wallet key file ${wallet} exists (a dry-run child holds no signing key)`);
  const manifestPath = opts.manifestPath ?? CHILD_RUNTIME_MANIFEST;
  let manifest: ChildRuntimeManifest | null = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    problems.push(`runtime manifest ${manifestPath} unreadable`);
  }
  if (manifest) {
    if (manifest.dryRun !== true) problems.push("runtime manifest is not a dry-run manifest");
    if (!manifest.provisioningKey) problems.push("runtime manifest carries no provisioning key");
  }
  return problems;
}

export async function runDryRunChild(opts: DryRunChildOptions = {}): Promise<DryRunChildResult> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  const problems = dryRunChildProblems(opts);
  if (problems.length) throw new Error(`Refusing to run as a dry-run child: ${problems.join("; ")}`);
  const manifestPath = opts.manifestPath ?? CHILD_RUNTIME_MANIFEST;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ChildRuntimeManifest;
  const file = opts.credentialsFile ?? env.FLEET_CREDENTIALS_FILE ?? path.join(home(env), ".automaton", "fleet-credentials.json");
  const cred = readCredentialFile(file);
  if (!cred) throw new Error(`No fleet credential at ${file}.`);
  if (cred.agentId !== manifest.agentId) throw new Error("Fleet credential and runtime manifest name different agents.");
  const baseUrl = validateServiceUrl(env.FLEET_API_URL?.trim() || cred.apiUrl || "");
  const client = new FleetApiClient({
    baseUrl,
    agentId: cred.agentId,
    token: cred.token,
    fetchImpl: opts.fetchImpl,
    healthResponder: defaultHealthResponder({ manifestPath }),
  });

  const result: DryRunChildResult = {
    agentId: cred.agentId,
    provisioningKey: manifest.provisioningKey!,
    heartbeats: 0,
    challengesPassed: 0,
    status: null,
  };
  const target = opts.heartbeats ?? 0;
  const interval = opts.intervalMs ?? 30_000;
  log("dry_run_child_started", { agentId: cred.agentId, provisioningKey: manifest.provisioningKey, controller: baseUrl });
  while (!opts.signal?.aborted && (target === 0 || result.heartbeats < target)) {
    const challengeBefore = client.lastChallenge;
    const alive = await client.heartbeat(cred.agentId);
    if (!alive) {
      result.status = await client.selfStatus(cred.agentId).catch(() => null);
      log("dry_run_child_rejected", { status: result.status });
      throw new Error(`Controller no longer accepts this dry-run child (status ${result.status ?? "unknown"}).`);
    }
    result.heartbeats++;
    if (client.lastChallenge && client.lastChallenge !== challengeBefore && client.lastChallenge.passed) result.challengesPassed++;
    log("dry_run_child_heartbeat", { n: result.heartbeats, challenge: client.lastChallenge });
    if (target === 0 || result.heartbeats < target) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, interval);
        opts.signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
      });
    }
  }
  result.status = await client.selfStatus(cred.agentId).catch(() => null);
  return result;
}
