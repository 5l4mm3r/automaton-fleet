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

/** Deterministic, keyless wallet address for a dry-run child: nobody holds its private key. */
export function keylessDryRunAddress(agentId: string): string {
  return "0x" + crypto.createHash("sha256").update(`automaton-fleet:dry-run:no-key:${agentId}`).digest("hex").slice(0, 40);
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
