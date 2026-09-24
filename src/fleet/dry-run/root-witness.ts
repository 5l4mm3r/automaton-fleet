/**
 * Root witness (FLEET-KI-4).
 *
 * The operator-controlled dry run needs a living root parent: a root is
 * ACTIVE only while it heartbeats and passes controller health challenges.
 * The witness is the smallest process that does exactly that for a root
 * enrolled with capability scope 'witness' (`fleet:admin enroll-witness-root`):
 *
 *   - reads its own scoped credential (0600) and opens fs1 sessions with it;
 *   - sends signed heartbeats and answers health challenges (pinned runtime
 *     commit + whether the bundled shell guard blocks the canary; the canary
 *     is only pattern-matched, never executed);
 *   - stops cleanly on SIGTERM.
 *
 * It never starts the agent loop, never loads inference, wallet or
 * replication code, holds no database credential and no controller secret,
 * and never calls anything but POST /v1/session, POST /v1/heartbeat,
 * POST /v1/health/challenge and GET /v1/self. That whitelist is NOT the
 * security boundary: the witness identity's capability scope is enforced by
 * the fleet service (route policy) and the database (fleet_authenticate).
 *
 * Startup refuses (before any network access): uid 0; REAL_PAYMENTS_ENABLED,
 * REAL_REPLICATION_ENABLED or OWNER_SWEEP_ENABLED true; privileged or
 * forbidden environment variables; wallet files; readable controller
 * secrets; an installed tree whose build identity differs from the pinned
 * release. After the first session it refuses unless the registry says it is
 * a living root with scope 'witness' pinned to the same runtime commit.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { computeBuildIdentity } from "../attestation.js";
import { loadRuntimeRelease, runningRuntimeDir, type RuntimeRelease } from "../runtime.js";
import {
  DEFAULT_ADMIN_ENV_FILE,
  DEFAULT_RUNTIME_ENV_FILE,
  DEFAULT_SERVICE_ENV_FILE,
  DEFAULT_TLS_KEY_FILE,
  FLEET_ETC_DIR,
  readEnvFile,
} from "../secret-files.js";
import { findPrivilegedEnv } from "../secrets.js";
import { FleetRegistryUnavailableError } from "../postgres/store.js";
import { FleetApiClient, readCredentialFile, validateServiceUrl, type HealthResponder } from "../service/client.js";
import { getForbiddenCommandMatch } from "../../agent/policy-rules/command-safety.js";
import { DRY_RUN_FORBIDDEN_ENV } from "./child.js";

/** The only endpoints the witness calls (informational; the server enforces the scope). */
export const WITNESS_ENDPOINTS: readonly string[] = Object.freeze([
  "POST /v1/session",
  "POST /v1/heartbeat",
  "POST /v1/health/challenge",
  "GET /v1/self",
]);

const REFUSED_TRUE_FLAGS = ["REAL_PAYMENTS_ENABLED", "REAL_REPLICATION_ENABLED", "OWNER_SWEEP_ENABLED"];
const RUNTIME_KEYS = ["FLEET_RUNTIME_REPO", "FLEET_RUNTIME_COMMIT", "FLEET_RUNTIME_BUILD_ID", "FLEET_RUNTIME_LOCKFILE_SHA256"];
const MAX_REFUSED_HEARTBEATS = 5;

/** Startup refusal (misconfiguration): systemd must not restart it. */
export class WitnessRefusedError extends Error {
  readonly exitCode = 4;
}

/** The controller no longer accepts this witness (dead, quarantined, revoked): do not restart. */
export class WitnessRejectedError extends Error {
  readonly exitCode = 3;
}

export interface RootWitnessOptions {
  env?: Record<string, string | undefined>;
  /** Credential file; default FLEET_CREDENTIALS_FILE or ~/.automaton/fleet-credentials.json. */
  credentialsFile?: string;
  /** Installed runtime tree to verify; default: the tree this module runs from. */
  runtimeDir?: string;
  /** Non-secret runtime.env holding the pinned release; default FLEET_RUNTIME_ENV_FILE or /etc/automaton-fleet/runtime.env. */
  runtimeEnvFile?: string;
  /** Effective uid; default process.getuid(). */
  uid?: number | null;
  /** Controller secrets the witness must NOT be able to read. */
  secretFiles?: string[];
  /** Heartbeats to send; 0 = until stopped. Default 0. */
  heartbeats?: number;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  log?: (event: string, detail?: Record<string, unknown>) => void;
  signal?: AbortSignal;
}

export interface RootWitnessPreflight {
  problems: string[];
  release: RuntimeRelease | null;
}

export interface RootWitnessResult {
  agentId: string;
  heartbeats: number;
  challengesPassed: number;
  status: string | null;
}

function home(env: Record<string, string | undefined>): string {
  return env.HOME || os.homedir() || "/";
}

/** Pinned release: runtime.env, overridden by FLEET_RUNTIME_* in the process environment. */
function runtimeEnv(opts: RootWitnessOptions, env: Record<string, string | undefined>): Record<string, string | undefined> {
  const file = opts.runtimeEnvFile ?? env.FLEET_RUNTIME_ENV_FILE ?? DEFAULT_RUNTIME_ENV_FILE;
  const merged: Record<string, string | undefined> = { ...readEnvFile(file) };
  for (const k of [...RUNTIME_KEYS, ...REFUSED_TRUE_FLAGS]) if (env[k] !== undefined) merged[k] = env[k];
  return merged;
}

/** Everything that makes this process unfit to be a zero-authority root witness. No network access. */
export function rootWitnessPreflight(opts: RootWitnessOptions = {}): RootWitnessPreflight {
  const env = opts.env ?? process.env;
  const problems: string[] = [];

  const uid = opts.uid !== undefined ? opts.uid : (process.getuid?.() ?? null);
  if (uid === 0) problems.push("running as root (uid 0)");

  let rt: Record<string, string | undefined> = {};
  try {
    rt = runtimeEnv(opts, env);
  } catch (err) {
    problems.push(`runtime env unreadable (${err instanceof Error ? err.message : String(err)})`);
  }
  for (const k of REFUSED_TRUE_FLAGS) {
    if (env[k]?.trim().toLowerCase() === "true" || rt[k]?.trim().toLowerCase() === "true") problems.push(`${k}=true`);
  }

  const forbidden = new Set([...findPrivilegedEnv(env), ...DRY_RUN_FORBIDDEN_ENV.filter((k) => env[k]?.trim())]);
  for (const k of [...forbidden].sort()) problems.push(`${k} present in the environment`);

  const walletDir = path.join(home(env), ".automaton");
  try {
    for (const f of fs.readdirSync(walletDir)) {
      if (/^wallet/i.test(f)) problems.push(`wallet state ${path.join(walletDir, f)} exists (a witness holds no signing key)`);
    }
  } catch {
    // no ~/.automaton: nothing to refuse
  }

  const secrets = opts.secretFiles ?? [
    DEFAULT_ADMIN_ENV_FILE,
    DEFAULT_SERVICE_ENV_FILE,
    DEFAULT_TLS_KEY_FILE,
    path.join(FLEET_ETC_DIR, "legacy-env-fleet.bak"),
  ];
  for (const f of secrets) {
    try {
      fs.accessSync(f, fs.constants.R_OK);
      problems.push(`controller secret ${f} is readable by this process`);
    } catch {
      // unreadable or absent: correct
    }
  }

  const release = loadRuntimeRelease(rt);
  if (!release) {
    problems.push("no complete pinned runtime release (FLEET_RUNTIME_REPO/_COMMIT/_BUILD_ID/_LOCKFILE_SHA256)");
  } else {
    const dir = opts.runtimeDir ?? runningRuntimeDir(import.meta.url);
    try {
      const id = computeBuildIdentity(dir);
      if (id.buildId !== release.buildId) problems.push(`installed runtime build ${id.buildId} differs from the pinned ${release.buildId}`);
      if (id.lockfileSha256 !== release.lockfileSha256) problems.push("installed runtime lockfile differs from the pinned release");
    } catch (err) {
      problems.push(`installed runtime unverifiable (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return { problems, release };
}

/**
 * Challenge answer: the pinned (already verified) runtime identity, and
 * whether the bundled shell guard blocks the canary. Nothing is executed.
 */
export function witnessHealthResponder(release: RuntimeRelease): HealthResponder {
  return async (c) => ({ commit: release.commit, buildId: release.buildId, policyOk: getForbiddenCommandMatch(c.canary) !== null });
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
}

export async function runRootWitness(opts: RootWitnessOptions = {}): Promise<RootWitnessResult> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  const pre = rootWitnessPreflight(opts);
  if (pre.problems.length) throw new WitnessRefusedError(`Refusing to run as a root witness: ${pre.problems.join("; ")}`);
  const release = pre.release!;

  const file = opts.credentialsFile ?? env.FLEET_CREDENTIALS_FILE ?? path.join(home(env), ".automaton", "fleet-credentials.json");
  let cred: ReturnType<typeof readCredentialFile>;
  let baseUrl: string;
  try {
    cred = readCredentialFile(file);
    if (!cred) throw new Error(`no fleet credential at ${file}`);
    baseUrl = validateServiceUrl(env.FLEET_API_URL?.trim() || cred.apiUrl || "");
  } catch (err) {
    throw new WitnessRefusedError(`Refusing to run as a root witness: ${err instanceof Error ? err.message : String(err)}`);
  }
  const client = new FleetApiClient({
    baseUrl,
    agentId: cred.agentId,
    token: cred.token,
    fetchImpl: opts.fetchImpl,
    healthResponder: witnessHealthResponder(release),
  });

  const me = await client.describeSelf();
  if (!me) throw new WitnessRejectedError("The controller rejected the witness credential.");
  if (me.dead) throw new WitnessRejectedError(`The witness root is ${me.agent.status}.`);
  if (me.agent.role !== "root" || me.agent.capabilityScope !== "witness") {
    throw new WitnessRefusedError(
      `Refusing to run as a root witness: the credential belongs to role ${me.agent.role} with capability scope ${me.agent.capabilityScope ?? "unknown"}, not a witness root.`,
    );
  }
  if (me.agent.runtimeCommit !== release.commit) {
    throw new WitnessRefusedError("Refusing to run as a root witness: the registry runtime commit differs from the pinned release.");
  }

  const result: RootWitnessResult = { agentId: cred.agentId, heartbeats: 0, challengesPassed: 0, status: me.agent.status };
  const target = opts.heartbeats ?? 0;
  const interval = opts.intervalMs ?? 30_000;
  let refused = 0;
  log("witness_started", { agentId: cred.agentId, controller: baseUrl, commit: release.commit, status: me.agent.status });
  while (!opts.signal?.aborted && (target === 0 || result.heartbeats < target)) {
    const challengeBefore = client.lastChallenge;
    let alive = false;
    try {
      alive = await client.heartbeat(cred.agentId);
    } catch (err) {
      if (!(err instanceof FleetRegistryUnavailableError)) throw err;
      log("witness_controller_unavailable", { error: err.message });
      await pause(interval, opts.signal);
      continue;
    }
    if (!alive) {
      const status = await client.selfStatus(cred.agentId).catch(() => null);
      result.status = status;
      if (status !== "active" && status !== "unresponsive") {
        log("witness_rejected", { status });
        throw new WitnessRejectedError(`The controller no longer accepts this witness (status ${status ?? "unknown"}).`);
      }
      refused++;
      log("witness_heartbeat_refused", { status, refused });
      if (refused >= MAX_REFUSED_HEARTBEATS) throw new Error(`${refused} consecutive heartbeats were refused.`);
    } else {
      refused = 0;
      result.heartbeats++;
      if (client.lastChallenge && client.lastChallenge !== challengeBefore && client.lastChallenge.passed) result.challengesPassed++;
      log("witness_heartbeat", { n: result.heartbeats, challenge: client.lastChallenge });
    }
    if (target === 0 || result.heartbeats < target) await pause(interval, opts.signal);
  }
  result.status = await client.selfStatus(cred.agentId).catch(() => result.status);
  return result;
}
