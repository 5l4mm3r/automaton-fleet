/**
 * Genesis founder runtime (Phase F.1, schema v12).
 *
 * The process a Genesis founder runs as: `node dist/fleet/founder/main.js`,
 * started by deploy/systemd/automaton-fleet-founder@.service with a unique
 * DynamicUser, its own 0700 state directory and the founder-v1 capability
 * manifest. Two modes, chosen by what the owner's provisioner placed in the
 * founder's private state directory:
 *
 *   attest  (genesis-attest.json present, no fleet credential): prove what is
 *           running — the installed tree identity (commit, build id, lockfile),
 *           the compiled capability manifest, the founder identity and its
 *           workspace/state namespace — to FleetController with the one-time
 *           attestation token, then stay up (the provisioner observes this very
 *           process from outside). No session, no heartbeat, no agent API.
 *   active  (fleet-credentials.json present, after the owner's activation):
 *           open sessions, heartbeat, answer health challenges, confirm its own
 *           capability manifest and read its own ledger position.
 *
 * The autonomous agent loop is NOT started in this phase (it needs an
 * inference provider credential and an egress policy — owner decisions).
 * Enforcement never relies on this process: the capability manifest, the
 * origin/reproduction guards, spend orders and custody live in the database
 * and FleetController. Startup refuses (exit 4, never restarted) on any
 * identity, manifest, isolation or secret-visibility problem; a controller
 * refusal exits 3 (never restarted).
 */

import fs from "fs";
import os from "os";
import path from "path";
import { computeBuildIdentity } from "../attestation.js";
import { loadRuntimeRelease, runningRuntimeDir, type RuntimeRelease } from "../runtime.js";
import { treeIdentity } from "../runtime-verify.js";
import {
  DEFAULT_ADMIN_ENV_FILE,
  DEFAULT_CUSTODY_ENV_FILE,
  DEFAULT_OPERATOR_ENV_FILE,
  DEFAULT_RUNTIME_ENV_FILE,
  DEFAULT_SERVICE_ENV_FILE,
  DEFAULT_TLS_KEY_FILE,
  readEnvFile,
} from "../secret-files.js";
import { findPrivilegedEnv } from "../secrets.js";
import { FleetApiClient, readCredentialFile, validateServiceUrl, type HealthResponder } from "../service/client.js";
import { FleetRegistryUnavailableError } from "../postgres/store.js";
import { MANIFESTS, NON_GRANTABLE, TOOL_CAPABILITIES, createCapabilityManifestRule, decideTool, manifestSha256, type CapabilityManifest } from "../capabilities.js";
import { getForbiddenCommandMatch } from "../../agent/policy-rules/command-safety.js";
import { DRY_RUN_FORBIDDEN_ENV } from "../dry-run/child.js";
import { FounderToolbox } from "./toolbox.js";
import { FounderMind } from "./mind.js";
import { sandboxSelfTest, type SandboxSelfTest } from "./exec-sandbox.js";
import {
  FOUNDER_ATTEST_FILE,
  FOUNDER_ATTEST_SCHEME,
  FOUNDER_CREDENTIAL_FILE,
  FOUNDER_IDENTITY_FILE,
  FOUNDER_INSTANCE_FILE,
  FOUNDER_REPORT_FILE,
  ULID_RE,
  newInstanceId,
  type FounderAttestFile,
  type FounderIdentityFile,
  type RuntimeEvidence,
} from "./evidence.js";

export class FounderRefusedError extends Error {
  readonly exitCode = 4;
}
export class FounderRejectedError extends Error {
  readonly exitCode = 3;
}

const REFUSED_TRUE_FLAGS = ["REAL_PAYMENTS_ENABLED", "REAL_REPLICATION_ENABLED", "OWNER_SWEEP_ENABLED"];
const RUNTIME_KEYS = ["FLEET_RUNTIME_REPO", "FLEET_RUNTIME_COMMIT", "FLEET_RUNTIME_BUILD_ID", "FLEET_RUNTIME_LOCKFILE_SHA256"];

/** Secrets and other identities' state a founder must never be able to read. */
export const FOUNDER_UNREADABLE_PATHS: readonly string[] = Object.freeze([
  DEFAULT_ADMIN_ENV_FILE,
  DEFAULT_SERVICE_ENV_FILE,
  DEFAULT_OPERATOR_ENV_FILE,
  DEFAULT_CUSTODY_ENV_FILE,
  DEFAULT_TLS_KEY_FILE,
  "/etc/automaton-fleet/legacy-env-fleet.bak",
  "/etc/automaton-fleet/chatgpt-adapter.json",
  "/etc/automaton-fleet/chatgpt-tunnel/adapter-token",
  "/etc/automaton-fleet/chatgpt-tunnel/openai-api-key",
  "/var/lib/automaton-fleet-chatgpt-adapter/bridge-chatgpt.key",
  "/var/lib/automaton-fleet-witness/fleet-credentials.json",
  "/run/credentials/automaton-fleet.service/service.env",
  "/etc/automaton-fleet/cognition.key",
]);

export interface FounderRuntimeOptions {
  env?: Record<string, string | undefined>;
  /** Installed runtime tree (default: the tree this module runs from). */
  runtimeDir?: string;
  uid?: number | null;
  /** Paths that must be unreadable (default FOUNDER_UNREADABLE_PATHS). */
  unreadable?: readonly string[];
  fetchImpl?: typeof fetch;
  log?: (event: string, detail?: Record<string, unknown>) => void;
  signal?: AbortSignal;
  /** Active mode: heartbeats to send (0 = until stopped). */
  heartbeats?: number;
  /** Active mode: think on every Nth heartbeat (default FLEET_FOUNDER_THINK_EVERY or 1). */
  thinkEvery?: number;
}

export interface FounderRuntimeResult {
  mode: "attest" | "active";
  agentId: string;
  instanceId: string;
  heartbeats: number;
  challengesPassed: number;
  /** Mind turns that actually ran (controller cognition). */
  mindTurns?: number;
  mindRefusals?: number;
}

interface Context {
  env: Record<string, string | undefined>;
  release: RuntimeRelease;
  runtimeDir: string;
  agentId: string;
  stateDir: string;
  identity: FounderIdentityFile;
  manifest: CapabilityManifest;
  uid: number;
  instanceId: string;
  log: (event: string, detail?: Record<string, unknown>) => void;
}

function readOwnJson<T>(file: string, uid: number): T | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!st.isFile()) throw new FounderRefusedError(`${path.basename(file)} is not a regular file`);
  if ((st.mode & 0o077) !== 0) throw new FounderRefusedError(`${path.basename(file)} must be 0600`);
  if (st.uid !== uid) throw new FounderRefusedError(`${path.basename(file)} is not owned by this founder`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function writeOwn(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Capability self-test over the full tool catalogue under this manifest. */
export function capabilitySelfTest(manifest: CapabilityManifest): RuntimeEvidence["capabilitySelfTest"] {
  let allowed = 0;
  let denied = 0;
  let forbiddenAllowed = 0;
  for (const [tool, cls] of Object.entries(TOOL_CAPABILITIES)) {
    const d = decideTool(tool, manifest);
    if (d.allowed) {
      allowed++;
      if (NON_GRANTABLE.has(cls)) forbiddenAllowed++;
    } else denied++;
  }
  const unclassifiedDenied = decideTool("__unclassified_probe__", manifest).allowed === false;
  return { tools: Object.keys(TOOL_CAPABILITIES).length, allowed, denied, forbiddenAllowed, unclassifiedDenied };
}

/** Everything that makes this process unfit to be a founder runtime. No network access. */
export function founderPreflight(opts: FounderRuntimeOptions = {}): Context {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  const problems: string[] = [];
  const uid = opts.uid !== undefined ? opts.uid : (process.getuid?.() ?? null);
  if (uid === null) problems.push("unknown uid");
  if (uid === 0) problems.push("running as root (uid 0)");

  const agentId = env.FLEET_FOUNDER_ID?.trim() ?? "";
  if (!ULID_RE.test(agentId)) problems.push("FLEET_FOUNDER_ID is missing or malformed");
  const manifestId = env.FLEET_CAPABILITY_MANIFEST?.trim() ?? "";
  const manifest = Object.prototype.hasOwnProperty.call(MANIFESTS, manifestId) ? MANIFESTS[manifestId] : null;
  if (!manifest) problems.push(`FLEET_CAPABILITY_MANIFEST ${manifestId || "(missing)"} is not a compiled manifest`);
  if (!createCapabilityManifestRule(env)) problems.push("the capability manifest policy rule is not active");
  // "controller": the founder may think, but only through FleetController's
  // gateway, and only while the owner's registry switches allow it.
  if (env.FLEET_FOUNDER_AGENT_LOOP && env.FLEET_FOUNDER_AGENT_LOOP !== "disabled" && env.FLEET_FOUNDER_AGENT_LOOP !== "controller") {
    problems.push("FLEET_FOUNDER_AGENT_LOOP: only 'disabled' or 'controller' (cognition mediated by FleetController) are valid");
  }

  // Founders never hold an inference provider or its credential: the controller does.
  const providerEnv = Object.keys(env).filter((k) => env[k] && (/^FLEET_COGNITION_/.test(k) || /^(OPENAI|ANTHROPIC|CONWAY|OPENROUTER|GROQ|MISTRAL|GEMINI|GOOGLE)_API_KEY$/.test(k)));
  if (providerEnv.length) problems.push(`inference provider configuration present in a founder environment (${providerEnv.join(", ")})`);

  let rt: Record<string, string | undefined> = {};
  try {
    rt = { ...readEnvFile(env.FLEET_RUNTIME_ENV_FILE ?? DEFAULT_RUNTIME_ENV_FILE) };
    for (const k of [...RUNTIME_KEYS, ...REFUSED_TRUE_FLAGS]) if (env[k] !== undefined) rt[k] = env[k];
  } catch (err) {
    problems.push(`runtime env unreadable (${err instanceof Error ? err.message : String(err)})`);
  }
  for (const k of REFUSED_TRUE_FLAGS) {
    if (env[k]?.trim().toLowerCase() === "true" || rt[k]?.trim().toLowerCase() === "true") problems.push(`${k}=true`);
  }
  for (const k of [...new Set([...findPrivilegedEnv(env), ...DRY_RUN_FORBIDDEN_ENV.filter((x) => env[x]?.trim())])].sort()) {
    problems.push(`${k} present in the environment`);
  }
  for (const f of opts.unreadable ?? FOUNDER_UNREADABLE_PATHS) {
    try {
      fs.accessSync(f, fs.constants.R_OK);
      problems.push(`${f} is readable by this founder`);
    } catch {
      // unreadable or absent: correct
    }
  }

  const release = loadRuntimeRelease(rt);
  const runtimeDir = opts.runtimeDir ?? runningRuntimeDir(import.meta.url);
  if (!release) problems.push("no complete pinned runtime release");
  else {
    try {
      const id = computeBuildIdentity(runtimeDir);
      if (id.buildId !== release.buildId) problems.push(`installed runtime build ${id.buildId} differs from the pinned ${release.buildId}`);
      if (id.lockfileSha256 !== release.lockfileSha256) problems.push("installed runtime lockfile differs from the pinned release");
    } catch (err) {
      problems.push(`installed runtime unverifiable (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  const stateDir = path.resolve(env.FLEET_FOUNDER_STATE_DIR?.trim() || path.join("/var/lib/automaton-founders", agentId));
  let identity: FounderIdentityFile | null = null;
  if (uid !== null && uid !== 0 && ULID_RE.test(agentId)) {
    try {
      const real = fs.realpathSync(stateDir);
      const st = fs.lstatSync(real);
      if (!st.isDirectory()) problems.push("state directory is not a directory");
      if (st.uid !== uid) problems.push("state directory is not owned by this founder");
      if ((st.mode & 0o077) !== 0) problems.push(`state directory mode ${(st.mode & 0o777).toString(8)} is not private`);
      if (path.basename(real) !== agentId) problems.push("state directory does not belong to this founder id");
      identity = readOwnJson<FounderIdentityFile>(path.join(real, FOUNDER_IDENTITY_FILE), uid);
      if (!identity) problems.push(`${FOUNDER_IDENTITY_FILE} missing`);
    } catch (err) {
      problems.push(err instanceof FounderRefusedError ? err.message : `state directory unusable (${(err as NodeJS.ErrnoException).code ?? String(err)})`);
    }
  }
  if (identity && manifest) {
    if (identity.agentId !== agentId) problems.push("founder.json names a different founder (swapped identity)");
    if (identity.manifestId !== manifest.manifestId) problems.push("founder.json binds a different capability manifest");
    if (identity.manifestSha256 !== manifestSha256(manifest)) problems.push("compiled capability manifest differs from the authorized digest");
    if (!/^ws_[0-9A-HJKMNP-TV-Z]{26}$/.test(identity.workspaceId) || !/^st_[0-9A-HJKMNP-TV-Z]{26}$/.test(identity.stateNamespace)) {
      problems.push("founder.json workspace/state namespace malformed");
    }
    try {
      validateServiceUrl(identity.apiUrl);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (manifest) {
    const t = capabilitySelfTest(manifest);
    if (t.forbiddenAllowed !== 0 || !t.unclassifiedDenied) problems.push("capability self-test failed (a non-grantable or unclassified tool would be allowed)");
  }
  if (problems.length) throw new FounderRefusedError(`Refusing to run as a Genesis founder: ${problems.join("; ")}`);
  return {
    env,
    release: release!,
    runtimeDir,
    agentId,
    stateDir: fs.realpathSync(stateDir),
    identity: identity!,
    manifest: manifest!,
    uid: uid!,
    instanceId: newInstanceId(),
    log,
  };
}

function ensurePrivateDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return fs.realpathSync(dir);
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
}

export function founderHealthResponder(release: RuntimeRelease): HealthResponder {
  return async (c) => ({ commit: release.commit, buildId: release.buildId, policyOk: getForbiddenCommandMatch(c.canary) !== null });
}

export async function runFounderRuntime(opts: FounderRuntimeOptions = {}): Promise<FounderRuntimeResult> {
  const ctx = founderPreflight(opts);
  const { log } = ctx;
  const fetchImpl = opts.fetchImpl ?? fetch;
  // Private working areas, named by the authorized isolation identity.
  const workspaceDir = ensurePrivateDir(path.join(ctx.stateDir, "workspace", ctx.identity.workspaceId));
  const stateNsDir = ensurePrivateDir(path.join(ctx.stateDir, "state", ctx.identity.stateNamespace));
  ensurePrivateDir(path.join(stateNsDir, "memory"));
  const bootedAt = new Date().toISOString();
  writeOwn(path.join(ctx.stateDir, FOUNDER_INSTANCE_FILE), { instanceId: ctx.instanceId, pid: process.pid, uid: ctx.uid, bootedAt });
  // An installed release has no .git (its commit is the directory name); a development tree reports HEAD.
  const tree = treeIdentity(ctx.runtimeDir);
  const report = (extra: Record<string, unknown>) =>
    writeOwn(path.join(ctx.stateDir, FOUNDER_REPORT_FILE), {
      agentId: ctx.agentId,
      instanceId: ctx.instanceId,
      pid: process.pid,
      manifestId: ctx.manifest.manifestId,
      manifestSha256: manifestSha256(ctx.manifest),
      commit: tree.commit,
      buildId: tree.buildId,
      updatedAt: new Date().toISOString(),
      ...extra,
    });

  const cred = readCredentialFile(path.join(ctx.stateDir, FOUNDER_CREDENTIAL_FILE));
  if (!cred) {
    // ── attest mode
    const attest = readOwnJson<FounderAttestFile>(path.join(ctx.stateDir, FOUNDER_ATTEST_FILE), ctx.uid);
    if (!attest) throw new FounderRefusedError("Refusing to run as a Genesis founder: neither a fleet credential nor an attestation token is present");
    if (attest.agentId !== ctx.agentId || attest.genesisId !== ctx.identity.genesisId) {
      throw new FounderRefusedError("Refusing to run as a Genesis founder: the attestation token belongs to another founder or Genesis");
    }
    const evidence: RuntimeEvidence = {
      agentId: ctx.agentId,
      genesisId: ctx.identity.genesisId,
      repo: ctx.release.repo,
      commit: tree.commit ?? "unknown",
      buildId: tree.buildId ?? "unknown",
      lockfileSha256: tree.lockfileSha256 ?? "unknown",
      manifestId: ctx.manifest.manifestId,
      manifestSha256: manifestSha256(ctx.manifest),
      workspaceId: ctx.identity.workspaceId,
      stateNamespace: ctx.identity.stateNamespace,
      instanceId: ctx.instanceId,
      pid: process.pid,
      uid: ctx.uid,
      nonce: attest.nonce,
      bootedAt,
      workspaceDir,
      stateDir: stateNsDir,
      capabilitySelfTest: capabilitySelfTest(ctx.manifest),
    };
    const base = validateServiceUrl(ctx.identity.apiUrl);
    let res: Response;
    try {
      res = await fetchImpl(`${base}/v1/genesis/runtime-evidence`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `${FOUNDER_ATTEST_SCHEME} ${ctx.agentId}.${attest.token}` },
        body: JSON.stringify(evidence),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      report({ mode: "attest", evidenceSubmitted: false, error: "controller unreachable" });
      throw new Error(`controller unreachable (${err instanceof Error ? err.name : "error"})`);
    }
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; code?: string };
    if (!res.ok || body.ok !== true) {
      report({ mode: "attest", evidenceSubmitted: false, code: body.code ?? `HTTP_${res.status}` });
      log("founder_attestation_refused", { code: body.code ?? `HTTP_${res.status}` });
      throw new FounderRejectedError(`The controller refused this founder's runtime evidence (${body.code ?? res.status}).`);
    }
    report({ mode: "attest", evidenceSubmitted: true, capabilitySelfTest: evidence.capabilitySelfTest });
    log("founder_runtime_evidence_submitted", { agentId: ctx.agentId, instanceId: ctx.instanceId, commit: evidence.commit });
    // Stay up: the owner's provisioner attests THIS process from outside, then activation restarts it.
    while (!opts.signal?.aborted) await pause(60_000, opts.signal);
    return { mode: "attest", agentId: ctx.agentId, instanceId: ctx.instanceId, heartbeats: 0, challengesPassed: 0 };
  }

  // ── active mode
  if (cred.agentId !== ctx.agentId) throw new FounderRefusedError("Refusing to run as a Genesis founder: the fleet credential belongs to another agent");
  const client = new FleetApiClient({
    baseUrl: validateServiceUrl(ctx.identity.apiUrl),
    agentId: cred.agentId,
    token: cred.token,
    fetchImpl: opts.fetchImpl,
    healthResponder: founderHealthResponder(ctx.release),
  });
  // A controller that is briefly unreachable (a deploy, a reboot) is waited out at startup as in the loop.
  const untilAvailable = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof FleetRegistryUnavailableError) || opts.signal?.aborted) throw err;
        log("founder_waiting_for_controller", { error: err.message.slice(0, 120) });
        await pause(Math.min(60_000, Math.max(1_000, Number(ctx.env.FLEET_FOUNDER_INTERVAL_MS) || 30_000)), opts.signal);
      }
    }
  };
  const me = await untilAvailable(() => client.describeSelf());
  if (!me || me.dead) throw new FounderRejectedError("The controller does not accept this founder as living.");
  if (me.agent.role !== "root" || me.agent.runtimeCommit !== ctx.release.commit) {
    throw new FounderRefusedError("Refusing to run as a Genesis founder: the registry record does not match this runtime.");
  }
  const caps = (await untilAvailable(() => client.capabilities())) as { origin?: string; manifestId?: string; manifestSha256?: string; reproductionExecutable?: boolean; paymentExecutable?: boolean };
  if (caps.origin !== "genesis_founder" || caps.manifestId !== ctx.manifest.manifestId || caps.manifestSha256 !== manifestSha256(ctx.manifest)) {
    throw new FounderRejectedError("The registry capability manifest differs from this runtime's compiled manifest.");
  }
  const result: FounderRuntimeResult = { mode: "active", agentId: ctx.agentId, instanceId: ctx.instanceId, heartbeats: 0, challengesPassed: 0, mindTurns: 0, mindRefusals: 0 };
  const mind =
    ctx.env.FLEET_FOUNDER_AGENT_LOOP === "controller"
      ? new FounderMind({
          ports: client,
          stateDir: stateNsDir,
          log,
          toolbox: new FounderToolbox({ manifest: ctx.manifest, workspaceDir, memoryDir: path.join(stateNsDir, "memory"), ports: client }),
        })
      : null;
  const thinkEvery = Math.max(1, opts.thinkEvery ?? (Number(ctx.env.FLEET_FOUNDER_THINK_EVERY) || 1));
  let lastMind: Record<string, unknown> | null = null;
  // Phase F.3: prove the shell sandbox before the mind may use it (the identity file sits next to the credential).
  let execSandbox: SandboxSelfTest | null = null;
  if (mind) {
    const api = new URL(ctx.identity.apiUrl);
    execSandbox = await sandboxSelfTest(workspaceDir, path.join(ctx.stateDir, FOUNDER_IDENTITY_FILE), Number(api.port) || (api.protocol === "https:" ? 443 : 80));
    log(execSandbox.ok ? "founder_exec_sandbox_ok" : "founder_exec_sandbox_failed", { ...execSandbox });
  }
  const interval = Math.min(60_000, Math.max(1_000, Number(ctx.env.FLEET_FOUNDER_INTERVAL_MS) || 30_000));
  const target = opts.heartbeats ?? 0;
  log("founder_started", { agentId: ctx.agentId, instanceId: ctx.instanceId, commit: ctx.release.commit, manifest: ctx.manifest.manifestId });
  while (!opts.signal?.aborted && (target === 0 || result.heartbeats < target)) {
    const before = client.lastChallenge;
    let alive = false;
    try {
      alive = await client.heartbeat(cred.agentId);
    } catch (err) {
      if (!(err instanceof FleetRegistryUnavailableError)) throw err;
      await pause(interval, opts.signal);
      continue;
    }
    if (!alive) {
      const status = await client.selfStatus(cred.agentId).catch(() => null);
      report({ mode: "active", heartbeats: result.heartbeats, rejected: status });
      throw new FounderRejectedError(`The controller no longer accepts this founder (status ${status ?? "unknown"}).`);
    }
    result.heartbeats++;
    if (client.lastChallenge && client.lastChallenge !== before && client.lastChallenge.passed) result.challengesPassed++;
    if (mind && result.heartbeats % thinkEvery === 0) {
      const t = await mind.turn(`Heartbeat ${result.heartbeats} (thinking slot ${result.heartbeats / thinkEvery}) at ${new Date().toISOString()}. Decide your next step.`);
      if (t.ran) result.mindTurns!++;
      result.mindRefusals! += t.refusals.length;
      lastMind = { ran: t.ran, reason: t.reason ?? null, steps: t.steps, tools: t.toolCalls, refusals: t.refusals, chargedCents: t.chargedCents };
    }
    const ledger = (await client.ledger().catch(() => null)) as Record<string, unknown> | null;
    report({
      mode: "active",
      heartbeats: result.heartbeats,
      challengesPassed: result.challengesPassed,
      capabilities: { manifestSha256: caps.manifestSha256, matchesCompiled: true, reproductionExecutable: caps.reproductionExecutable, paymentExecutable: caps.paymentExecutable },
      ledger: ledger ? { cash: ledger.cash, genesisAllocation: ledger.genesisAllocation, externalCustomerRevenue: ledger.externalCustomerRevenue, lifetimeContribution: ledger.lifetimeContribution } : null,
      agentLoop: mind ? { mode: "controller", turns: result.mindTurns, refusals: result.mindRefusals, last: lastMind, execSandbox } : "disabled",
      home: os.homedir() === ctx.stateDir,
    });
    if (target === 0 || result.heartbeats < target) await pause(interval, opts.signal);
  }
  return result;
}
