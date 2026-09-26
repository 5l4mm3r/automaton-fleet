# SOURCE VOLUME 06 — Dry-run child and root witness (src/fleet/dry-run)

Exact, byte-for-byte text of each file at repository commit `efad2148a3460ab881b0ab845fb13c25d1fa3e74` (branch fleet-development).
No file in this volume contains a real secret; test fixtures generate synthetic secrets at runtime.
Each file's SHA-256 is of the file bytes on disk and matches 22-RECONSTRUCTION-MANIFEST.md.

## Files

- `src/fleet/dry-run/child-main.ts` — 25 lines, sha256 `b3d5c794266293ba80c17bb09401c749700b3eeae204be961c06a3b3af089753`
- `src/fleet/dry-run/child.ts` — 138 lines, sha256 `fbf474b7bad44a57169b8c82cf4cea1e38508bd8a38e243f5b07734fb9601dfa`
- `src/fleet/dry-run/operator.ts` — 259 lines, sha256 `e4eefb08b06a63faa93682f83f0faadcc7c8fcf5ae331198fd42e92c3be4473b`
- `src/fleet/dry-run/root-main.ts` — 33 lines, sha256 `beb352c478f068d905aead17226f723f13e8806e0d9e37c1d49a322f3d7d404b`
- `src/fleet/dry-run/root-witness.ts` — 265 lines, sha256 `00dbccb8fff15bc666af6998f1feedf9ad737afa62d97316c5bc913f7ce08b31`

## `src/fleet/dry-run/child-main.ts`

sha256 `b3d5c794266293ba80c17bb09401c749700b3eeae204be961c06a3b3af089753` · 936 bytes · 25 lines

```ts
/**
 * DRY_RUN_CHILD entrypoint, started inside the child sandbox by the operator
 * dry run (`node dist/fleet/dry-run/child-main.js`). Heartbeats until the
 * controller stops accepting it. Logs JSON lines through the canonical redactor.
 */

import { createRedactedLineLogger } from "../redact.js";
import { runDryRunChild } from "./child.js";

const log = createRedactedLineLogger("fleet-dry-run-child");

const ac = new AbortController();
process.on("SIGTERM", () => ac.abort());
process.on("SIGINT", () => ac.abort());

runDryRunChild({ log, signal: ac.signal, intervalMs: Number(process.env.FLEET_DRY_RUN_INTERVAL_MS) || 30_000 }).then(
  (r) => {
    log("dry_run_child_stopped", { heartbeats: r.heartbeats, challengesPassed: r.challengesPassed, status: r.status });
    process.exit(0);
  },
  (err) => {
    log("dry_run_child_failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  },
);
```

## `src/fleet/dry-run/child.ts`

sha256 `fbf474b7bad44a57169b8c82cf4cea1e38508bd8a38e243f5b07734fb9601dfa` · 6040 bytes · 138 lines

```ts
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
```

## `src/fleet/dry-run/operator.ts`

sha256 `e4eefb08b06a63faa93682f83f0faadcc7c8fcf5ae331198fd42e92c3be4473b` · 13131 bytes · 259 lines

```ts
/**
 * DRY_RUN_CHILD — operator side (Phase 6).
 *
 *   pnpm fleet:dry-run-child --root <agentId> --api-url https://<host>:<port>            preflight only
 *   FLEET_DRY_RUN_CHILD=true pnpm fleet:dry-run-child --root <agentId> --api-url … --confirm-real-sandbox
 *
 * Provisions exactly one remote child through the real control plane and
 * proves it can connect, register, attest, heartbeat and be managed —
 * without any authority:
 *
 *   preflight   payments / owner sweep / real replication all false; fleet cap 2;
 *               approved runtime == pinned release; no orphan, stuck
 *               reservation or uncertain provisioning; https controller reachable
 *   reserve     fleet_reserve_dry_run (operator-only, dry_run=true in the DB)
 *   claim       attestation nonce issued, provisioning record created
 *   sandbox     durable intent -> ONE sandbox named after the provisioning key
 *   install     the child fetches the pinned fork, verifies the exact commit,
 *               checks the lockfile hash, `pnpm install --frozen-lockfile`, builds
 *   attest      parent-supplied verifier + reservation nonce + build id
 *   activate    controller + svc_activate re-check; the credential is issued.
 *               The wallet address is keyless (no private key exists), and
 *               custody is forced frozen with a zero limit by the database.
 *   start       credential (0600) + dry-run manifest delivered; the child runs
 *               dist/fleet/dry-run/child-main.js (no agent loop, no wallet)
 *   verify      the child opens a session over HTTPS, heartbeats and passes a
 *               controller challenge -> ACTIVE
 *
 * Any failure after the reservation fails the provisioning attempt (sandbox
 * queued for cleanup / orphaned per policy). Nothing here moves money.
 */

import crypto from "crypto";
import { ulid } from "ulid";
import type { ConwayClient } from "../../types.js";
import { createTrackedSandbox, deliverChildCredential, installPinnedRuntime } from "../../replication/spawn.js";
import { validateRuntimeBuild } from "../attestation.js";
import { CHILD_RUNTIME_DIR, CHILD_RUNTIME_MANIFEST, loadRuntimeRelease, resolveChildRuntime, sameRelease, type ChildRuntimeManifest } from "../runtime.js";
import type { PgFleetStore } from "../postgres/store.js";

export const DRY_RUN_SANDBOX = Object.freeze({ vcpu: 1, memoryMb: 1024, diskGb: 10 });
export const DRY_RUN_CHILD_LOG = "/root/.automaton/dry-run-child.log";

export interface DryRunDeps {
  /** Operator store (admin credential). */
  admin: PgFleetStore;
  env: Record<string, string | undefined>;
  rootAgentId: string;
  /** Public HTTPS URL of the controller, as the sandbox will reach it. */
  apiUrl: string;
  /** Required only for the real run. Creates REAL (paid) infrastructure. */
  conway?: ConwayClient;
  name?: string;
  fetchImpl?: typeof fetch;
  log?: (step: string, detail?: Record<string, unknown>) => void;
  /** How long to wait for the child's first heartbeat + passed challenge. Default 5 min. */
  waitActiveMs?: number;
  pollMs?: number;
  /** Test hook: allow a loopback controller URL (never in production). */
  allowLoopbackApiUrl?: boolean;
}

export interface DryRunPreflight {
  ok: boolean;
  problems: string[];
  facts: Record<string, unknown>;
}

const flagOn = (v: string | undefined) => v?.trim().toLowerCase() === "true";

/**
 * Keyless wallet address: a public-address-shaped digest of `seed`. No
 * private key exists for it, so nothing can ever sign for it.
 */
export function keylessAddress(seed: string): string {
  return "0x" + crypto.createHash("sha256").update(seed).digest("hex").slice(0, 40);
}

/** Deterministic, keyless wallet address for a dry-run child: nobody holds its private key. */
export function keylessDryRunAddress(agentId: string): string {
  return keylessAddress(`automaton-fleet:dry-run:no-key:${agentId}`);
}

export async function dryRunPreflight(deps: DryRunDeps): Promise<DryRunPreflight> {
  const { admin, env } = deps;
  const problems: string[] = [];
  const facts: Record<string, unknown> = {};
  for (const k of ["REAL_PAYMENTS_ENABLED", "OWNER_SWEEP_ENABLED", "REAL_REPLICATION_ENABLED"]) {
    facts[k] = flagOn(env[k]);
    if (flagOn(env[k])) problems.push(`${k} must be false for a dry run`);
  }
  let url: URL | null = null;
  try {
    url = new URL(deps.apiUrl);
  } catch {
    problems.push("controller URL is not a valid URL");
  }
  if (url) {
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:") problems.push("controller URL must be https");
    if (loopback && !deps.allowLoopbackApiUrl) problems.push("controller URL is loopback; a remote sandbox cannot reach it");
    facts.controllerUrl = url.origin;
    try {
      const res = await (deps.fetchImpl ?? fetch)(`${url.origin}/healthz`, { signal: AbortSignal.timeout(5000) });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
      facts.controllerReachable = res.ok && body.ok === true;
      if (!facts.controllerReachable) problems.push(`controller ${url.origin}/healthz is not healthy (${res.status})`);
    } catch (err) {
      facts.controllerReachable = false;
      problems.push(`controller ${url.origin} unreachable (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  const st = await admin.getState();
  const stale = await admin.staleness();
  Object.assign(facts, {
    fleetMaximum: st.maxAgents,
    livingAgents: st.livingAgents,
    reservedSlots: st.reservedSlots,
    quarantinedSlots: st.quarantinedSlots ?? 0,
    openOrphans: stale.openOrphans,
    staleReservations: stale.staleReservations,
    uncertainProvisioning: stale.uncertainProvisioning,
    dryRunChildren: stale.dryRunChildren,
  });
  if (st.maxAgents !== 2) problems.push(`fleet cap must be 2 for the first dry run (is ${st.maxAgents})`);
  if (st.livingAgents + st.reservedSlots + (st.quarantinedSlots ?? 0) >= st.maxAgents) problems.push("no free slot under the fleet cap");
  if (stale.openOrphans) problems.push(`${stale.openOrphans} unresolved orphan(s)`);
  if (stale.staleReservations) problems.push(`${stale.staleReservations} stuck reservation(s)`);
  if (stale.uncertainProvisioning) problems.push(`${stale.uncertainProvisioning} unreconciled provisioning attempt(s)`);
  if (stale.dryRunChildren) problems.push("a dry-run child already exists");
  const approved = st.runtime && st.build ? { ...st.runtime, ...st.build } : null;
  const release = loadRuntimeRelease(env);
  facts.approvedRuntime = approved;
  if (!approved) problems.push("no runtime approved in the registry");
  if (!release) problems.push("no pinned runtime release (FLEET_RUNTIME_*)");
  if (approved && release && !sameRelease(release, approved)) problems.push("pinned runtime release differs from the approved runtime");
  const root = await admin.getAgent(deps.rootAgentId);
  if (!root || root.role !== "root" || root.status !== "active") problems.push(`root agent ${deps.rootAgentId} is not a living root`);
  return { ok: problems.length === 0, problems, facts };
}

export interface DryRunReport {
  ok: boolean;
  agentId: string | null;
  provisioningKey: string | null;
  sandboxId: string | null;
  steps: Array<{ step: string; ok: boolean; detail?: string }>;
  authority: Awaited<ReturnType<PgFleetStore["agentAuthority"]>> | null;
}

/**
 * Perform the first remote child dry run. Refuses unless the operator set
 * FLEET_DRY_RUN_CHILD=true and supplied a Conway client (real sandbox).
 */
export async function performDryRunChild(deps: DryRunDeps): Promise<DryRunReport> {
  const { admin, env } = deps;
  const log = deps.log ?? (() => {});
  const report: DryRunReport = { ok: false, agentId: null, provisioningKey: null, sandboxId: null, steps: [], authority: null };
  const step = (name: string, ok: boolean, detail?: string) => {
    report.steps.push({ step: name, ok, ...(detail ? { detail } : {}) });
    log(name, { ok, ...(detail ? { detail } : {}) });
  };

  if (!flagOn(env.FLEET_DRY_RUN_CHILD)) throw new Error("DRY_RUN_CHILD mode is off: set FLEET_DRY_RUN_CHILD=true for this command.");
  if (!deps.conway) throw new Error("A Conway client is required: the dry run creates one real remote sandbox.");
  const pre = await dryRunPreflight(deps);
  step("preflight", pre.ok, pre.problems.join("; ") || undefined);
  if (!pre.ok) return report;

  const res = await admin.reserveDryRunSlot({ parentAgentId: deps.rootAgentId, requestedBy: "operator:dry-run", name: deps.name ?? "dry-run-child" });
  if (!res.ok) {
    step("reserve", false, `${res.code}: ${res.reason}`);
    return report;
  }
  const agentId = res.agent.agentId;
  report.agentId = agentId;
  step("reserve", true, `agent ${agentId}, reservation ${res.lease?.reservationId}`);

  try {
    const claimed = await admin.claimGrant(agentId, ulid(), { parentAgentId: deps.rootAgentId });
    report.provisioningKey = claimed.provisioningKey ?? null;
    const runtime = resolveChildRuntime(claimed.runtime);
    const build = validateRuntimeBuild(claimed.expectedBuild?.buildId, claimed.expectedBuild?.lockfileSha256);
    if (!build || !claimed.nonce) throw new Error("reservation carries no approved build identity");
    step("claim", true, `provisioning key ${claimed.provisioningKey}`);

    const sandbox = await createTrackedSandbox(deps.conway, claimed, DRY_RUN_SANDBOX);
    report.sandboxId = sandbox.id;
    step("sandbox", true, sandbox.id);
    const child = deps.conway.createScopedClient(sandbox.id);

    await claimed.reportProvisioning?.("verifying");
    const attestation = await installPinnedRuntime(child, { runtime, build, nonce: claimed.nonce });
    step("install+attest", true, `${attestation.commit} build ${attestation.buildId.slice(0, 16)}…`);

    const activated = await admin.activate(agentId, {
      walletAddress: keylessDryRunAddress(agentId),
      sandboxId: sandbox.id,
      runtimeCommit: attestation.commit,
      runtimeVersion: attestation.version ?? null,
      attestation,
      parentAgentId: deps.rootAgentId,
      actor: "operator:dry-run",
      provisioningKey: claimed.provisioningKey ?? null,
    });
    step("activate", true, `status ${activated.agent.status}`);

    const manifest: ChildRuntimeManifest = {
      agentId,
      parentAgentId: deps.rootAgentId,
      generation: claimed.generation,
      repo: runtime.repo,
      commit: runtime.commit,
      buildId: build.buildId,
      lockfileSha256: build.lockfileSha256,
      provisioningKey: claimed.provisioningKey ?? undefined,
      dryRun: true,
    };
    await child.exec("mkdir -p /root/.automaton && chmod 700 /root/.automaton", 10_000);
    await child.writeFile(CHILD_RUNTIME_MANIFEST, JSON.stringify(manifest, null, 2));
    await deliverChildCredential(deps.conway, sandbox.id, activated.credential, new URL(deps.apiUrl).origin);
    await child.exec(
      `cd ${CHILD_RUNTIME_DIR} && env -i HOME=/root PATH=/usr/local/bin:/usr/bin:/bin ` +
        `REAL_PAYMENTS_ENABLED=false OWNER_SWEEP_ENABLED=false REAL_REPLICATION_ENABLED=false ` +
        `nohup node dist/fleet/dry-run/child-main.js >${DRY_RUN_CHILD_LOG} 2>&1 &`,
      30_000,
    );
    step("start", true, "dist/fleet/dry-run/child-main.js");

    // Activation stamps a heartbeat itself; only a PASSED controller challenge
    // proves the child connected: a challenge is issued solely in a heartbeat
    // response to a signed request over its own session.
    const deadline = Date.now() + (deps.waitActiveMs ?? 300_000);
    let auth = await admin.agentAuthority(agentId);
    while (Date.now() < deadline) {
      auth = await admin.agentAuthority(agentId);
      if (auth?.status === "active" && auth.lastChallengeOkAt) break;
      if (auth && auth.status !== "active") break;
      await new Promise((r) => setTimeout(r, deps.pollMs ?? 5000));
    }
    report.authority = auth;
    const healthy = auth?.status === "active" && !!auth.lastChallengeOkAt;
    step("heartbeat+challenge", healthy, `status ${auth?.status}, last challenge ${auth?.lastChallengeOkAt ?? "none"}`);
    const zeroAuthority = auth?.dryRun === true && auth.spendingFrozen === true && auth.dailyLimitCents === 0;
    step("zero-authority", zeroAuthority, `dryRun ${auth?.dryRun}, frozen ${auth?.spendingFrozen}, dailyLimit ${auth?.dailyLimitCents}`);
    report.ok = healthy && zeroAuthority;
    return report;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    step("failed", false, msg);
    const a = await admin.getAgent(agentId).catch(() => null);
    if (a && (a.status === "reserved" || a.status === "provisioning")) {
      await admin.recordVerificationFailure(agentId, `dry run failed: ${msg}`.slice(0, 500), "operator:dry-run").catch(() => {});
    } else if (a && (a.status === "active" || a.status === "unresponsive")) {
      await admin.quarantine(agentId, `dry run failed after activation: ${msg}`.slice(0, 300), "operator:dry-run").catch(() => {});
    }
    report.authority = await admin.agentAuthority(agentId).catch(() => null);
    return report;
  }
}
```

## `src/fleet/dry-run/root-main.ts`

sha256 `beb352c478f068d905aead17226f723f13e8806e0d9e37c1d49a322f3d7d404b` · 1452 bytes · 33 lines

```ts
/**
 * Root witness entrypoint (FLEET-KI-4): `node dist/fleet/dry-run/root-main.js`,
 * run by deploy/systemd/automaton-fleet-witness.service. Logs JSON lines
 * through the canonical redactor (no credentials or session tokens).
 *
 * Exit codes: 0 stopped (SIGTERM/SIGINT); 3 the controller no longer accepts
 * this witness; 4 startup refusal; 1 anything else. The unit sets
 * RestartPreventExitStatus=3 4 so a retired or misconfigured witness is not restarted.
 */

import { createRedactedLineLogger } from "../redact.js";
import { runRootWitness } from "./root-witness.js";

const log = createRedactedLineLogger("fleet-root-witness");

const ac = new AbortController();
process.on("SIGTERM", () => ac.abort());
process.on("SIGINT", () => ac.abort());

const requested = Number(process.env.FLEET_WITNESS_INTERVAL_MS);
const intervalMs = Math.min(60_000, Math.max(10_000, Number.isFinite(requested) && requested > 0 ? requested : 30_000));

runRootWitness({ log, signal: ac.signal, intervalMs }).then(
  (r) => {
    log("witness_stopped", { agentId: r.agentId, heartbeats: r.heartbeats, challengesPassed: r.challengesPassed, status: r.status });
    process.exit(0);
  },
  (err) => {
    const exitCode = typeof (err as { exitCode?: unknown })?.exitCode === "number" ? (err as { exitCode: number }).exitCode : 1;
    log("witness_failed", { error: err instanceof Error ? err.message : String(err), exitCode });
    process.exit(exitCode);
  },
);
```

## `src/fleet/dry-run/root-witness.ts`

sha256 `00dbccb8fff15bc666af6998f1feedf9ad737afa62d97316c5bc913f7ce08b31` · 11672 bytes · 265 lines

```ts
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
```
