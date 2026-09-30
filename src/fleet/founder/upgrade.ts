/**
 * Living-founder runtime upgrade lifecycle (R23, schema v23).
 *
 * Moves ONE living founder from the runtime it is registered on to the owner-approved runtime — the same economic
 * agent before and after: same founder id, registry row, Genesis, credential, ledger accounts and balances, memory,
 * goals, workspace and history. It never creates a founder, never touches Genesis, never issues a credential and
 * never writes a ledger entry. The founder's process is stopped and started ONLY here, as an explicit operation.
 *
 *   preflight   nothing is changed: the founder is a healthy living founder; its registered runtime, its host pin and
 *               its running process all agree; the target is exactly the approved runtime and its installed tree
 *               hashes to the approved build; the rollback tree is intact too; no upgrade is open; the downtime
 *               budget is far inside the registry's heartbeat limits
 *   stop        the founder is stopped (proved), and no inference call is left in flight
 *   snapshot    state inventory + hash; durable state copied to a root-only backup (never the credential)
 *   prepare     registry: the attempt is recorded with the snapshot and the founder's ledger fingerprint
 *   commit      registry: the pin moves to the target in ONE transaction — refused unless the state hash and the
 *               ledger fingerprint still equal the prepared ones
 *   pin         host: the founder's unit points at the target release (tree verified again)
 *   start       the founder starts on the target; its state must still hash to the snapshot at that moment
 *   prove       the registry itself must have seen a heartbeat and a passed health challenge since the commit, with
 *               no failed one; the observed process must be the target commit/build, owned by this founder
 *   verify      registry: identity and credential files unchanged, no memory/workspace file lost, same ledger accounts
 *
 * Any failure before `commit` aborts (nothing was switched; the founder is started again on its old runtime). Any
 * failure from `commit` on rolls back: registry pin and host pin return to the runtime recorded at prepare, the
 * founder starts on it and must prove health again. A founder started against the wrong pin, build or registry row
 * refuses by itself (exit 4, never restarted), so a half-finished switch fails closed rather than running.
 */

import path from "path";
import { computeBuildIdentity } from "../attestation.js";
import type { RuntimeRelease } from "../runtime.js";
import { sameRelease } from "../runtime.js";
import type { PgGenesisAdmin, RuntimeReleaseRow, RuntimeUpgradeView } from "../genesis/admin.js";
import type { HostEvidence } from "./evidence.js";
import type { FounderUpgradeHost } from "./host.js";
import { backupFounderState, diffFounderState, snapshotFounderState, summarizeSnapshot, type StateDiff, type StateSnapshot } from "./state-snapshot.js";

/** The registry operations the lifecycle uses (PgGenesisAdmin provides them). */
export type UpgradeRegistry = Pick<PgGenesisAdmin,
  "founderRuntimeContext" | "founderRuntimeCurrent" | "founderRuntimeUpgrades" | "founderRuntimeUpgrade" | "founderRuntimeUpgradePrepare" | "founderRuntimeUpgradeCommit"
  | "founderRuntimeUpgradeVerify" | "founderRuntimeUpgradeRollback" | "founderRuntimeUpgradeRollbackVerify" | "founderRuntimeUpgradeAbort"
  | "founderRuntimeHealthSince" | "founderLedgerFingerprint">;

export type UpgradeStepName =
  | "preflight" | "quiesce" | "stop" | "snapshot" | "backup" | "prepare" | "recheck" | "commit" | "pin" | "prestart" | "start" | "prove" | "compare" | "verify"
  | "abort" | "rollback:stop" | "rollback:registry" | "rollback:pin" | "rollback:start" | "rollback:prove" | "rollback:verify";

export interface UpgradeStep { step: UpgradeStepName; ok: boolean; at: string; detail?: string }

export interface UpgradeOptions {
  agentId: string;
  host: FounderUpgradeHost;
  registry: UpgradeRegistry;
  /** The runtime to move the founder to: must be exactly the owner-approved runtime. */
  target: RuntimeRelease;
  actor: string;
  /** Root-only directory for state backups (one sub-directory per upgrade attempt). */
  backupRoot: string;
  /** Preflight only: prove the upgrade is possible without stopping or changing anything. */
  dryRun?: boolean;
  /** How long the switched founder has to prove health before it is rolled back (default 150 s). */
  healthTimeoutMs?: number;
  /** How long to wait for an in-flight inference call to be recorded (default 270 s: above the controller's deadline). */
  quiesceTimeoutMs?: number;
  stopTimeoutMs?: number;
  pollMs?: number;
  log?: (event: string, detail?: Record<string, unknown>) => void;
  /** Rehearsals and tests only: called after each completed step; throwing injects a failure at that point. */
  afterStep?: (step: UpgradeStepName) => Promise<void> | void;
}

export interface HealthProof {
  ok: boolean;
  why?: string;
  pid: number | null;
  uid: number | null;
  instanceId: string | null;
  commit: string | null;
  buildId: string | null;
  lockfileSha256: string | null;
  heartbeatAfter: boolean;
  challengesPassed: number;
  challengesFailed: number;
  status: string | null;
  waitedMs: number;
}

export interface UpgradeReceipt {
  ok: boolean;
  outcome: "preflight_ok" | "preflight_failed" | "verified" | "aborted" | "rolled_back" | "rollback_failed";
  agentId: string;
  upgradeId: string | null;
  from: RuntimeReleaseRow | null;
  to: RuntimeReleaseRow;
  why?: string;
  steps: UpgradeStep[];
  /** State inventory summaries (counts, bytes, digests: never content). */
  state: { before?: Record<string, unknown>; atStart?: Record<string, unknown>; after?: Record<string, unknown>; diff?: Pick<StateDiff, "identical" | "durableLost" | "identityChanged" | "credentialChanged"> & { lost: number; changed: number; added: number; changedPaths: string[] } };
  ledger: { before?: Record<string, unknown>; after?: Record<string, unknown> };
  process: { before?: { pid: number | null; uid: number | null; instanceId: string | null }; after?: { pid: number | null; uid: number | null; instanceId: string | null } };
  health?: HealthProof;
  rollback?: { health?: HealthProof; record?: RuntimeUpgradeView | null };
  backupDir: string | null;
  /** From the verified stop to the first proof of health on the target (or on the restored runtime). */
  downtimeMs: number | null;
  record: RuntimeUpgradeView | null;
}

class StepFailure extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rel = (r: RuntimeReleaseRow): RuntimeRelease => ({ repo: r.repo, commit: r.commit, buildId: r.buildId, lockfileSha256: r.lockfileSha256 });
const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 300);

/** The installed tree of a release must hash to exactly the release's build and lockfile. */
export function verifyInstalledRelease(host: Pick<FounderUpgradeHost, "releaseDir">, r: RuntimeReleaseRow): string | null {
  try {
    const id = computeBuildIdentity(host.releaseDir(r.commit));
    if (id.buildId !== r.buildId) return `installed tree of ${r.commit.slice(0, 7)} hashes to build ${id.buildId.slice(0, 12)}…, not ${r.buildId.slice(0, 12)}…`;
    if (id.lockfileSha256 !== r.lockfileSha256) return `installed tree of ${r.commit.slice(0, 7)} has a different lockfile`;
    return null;
  } catch (err) {
    return `release ${r.commit.slice(0, 7)} is not verifiable on this host (${short(err)})`;
  }
}

/**
 * Wait until the founder is provably alive on `expected`: the host observes the process (its tree identity, its
 * environment's founder id, its ownership of the state directory) and the REGISTRY reports a heartbeat and a passed
 * health challenge since `since`, with none failed. A process that exits with a refusal ends the wait at once.
 */
export async function proveFounderHealth(o: {
  agentId: string; host: FounderUpgradeHost; registry: Pick<UpgradeRegistry, "founderRuntimeHealthSince">; expected: RuntimeReleaseRow; since: string;
  identity: { genesisId: string; workspaceId: string; stateNamespace: string }; notInstance?: string | null; timeoutMs: number; pollMs: number;
  /** Default true. False only where no runtime switch happened (an aborted attempt): the registry schedules no extra challenge then. */
  requireChallenge?: boolean;
}): Promise<HealthProof> {
  const started = Date.now();
  let last: HealthProof = { ok: false, why: "not started", pid: null, uid: null, instanceId: null, commit: null, buildId: null, lockfileSha256: null, heartbeatAfter: false, challengesPassed: 0, challengesFailed: 0, status: null, waitedMs: 0 };
  for (;;) {
    const ev: HostEvidence | null = await o.host.evidence(o.agentId, { genesisId: o.identity.genesisId, repo: o.expected.repo, workspaceId: o.identity.workspaceId, stateNamespace: o.identity.stateNamespace }).catch(() => null);
    const h = await o.registry.founderRuntimeHealthSince(o.agentId, o.since).catch(() => null);
    const why =
      !ev ? "the founder process is not running"
      : ev.agentId !== o.agentId ? "the running process does not belong to this founder"
      : ev.commit !== o.expected.commit ? `the running process is on commit ${ev.commit.slice(0, 7)}`
      : ev.buildId !== o.expected.buildId ? "the running process is on a different build"
      : ev.lockfileSha256 !== o.expected.lockfileSha256 ? "the running process has a different lockfile"
      : ev.workspaceId !== o.identity.workspaceId || ev.stateNamespace !== o.identity.stateNamespace ? "the founder's workspace/state areas are missing or not its own"
      : ev.stateDirOwnerUid !== ev.uid ? "the state directory is not owned by the founder process"
      : ev.instanceId === "missing-instance-0000" || (o.notInstance && ev.instanceId === o.notInstance) ? "the new process has not written its instance marker"
      : !h ? "the registry did not answer"
      : h.challengesFailed > 0 ? "a health challenge failed"
      : h.status !== "active" ? `the registry holds the founder as ${h.status}`
      : h.runtimeCommit !== o.expected.commit ? "the registry pin is not the expected runtime"
      : !h.heartbeatAfter ? "no heartbeat yet"
      : o.requireChallenge !== false && h.challengesPassed < 1 ? "no health challenge passed yet"
      : undefined;
    last = {
      ok: why === undefined, ...(why ? { why } : {}), pid: ev?.pid ?? null, uid: ev?.uid ?? null, instanceId: ev?.instanceId ?? null,
      commit: ev?.commit ?? null, buildId: ev?.buildId ?? null, lockfileSha256: ev?.lockfileSha256 ?? null,
      heartbeatAfter: h?.heartbeatAfter === true, challengesPassed: Number(h?.challengesPassed ?? 0), challengesFailed: Number(h?.challengesFailed ?? 0), status: h?.status ?? null,
      waitedMs: Date.now() - started,
    };
    if (last.ok) return last;
    // Final conditions: waiting cannot fix them.
    if (h && h.challengesFailed > 0) return last;
    if (!ev) {
      const code = await o.host.lastExit?.(o.agentId).catch(() => null);
      if (typeof code === "number" && (code === 3 || code === 4)) return { ...last, why: `the founder runtime refused to run (exit ${code})` };
    }
    if (Date.now() - started > o.timeoutMs) return last;
    await sleep(o.pollMs);
  }
}

/** Upgrade one living founder to the approved runtime, or leave it exactly as it was. */
export async function upgradeFounderRuntime(o: UpgradeOptions): Promise<UpgradeReceipt> {
  const log = o.log ?? (() => {});
  const poll = o.pollMs ?? 1_000;
  const healthTimeout = o.healthTimeoutMs ?? 150_000;
  const steps: UpgradeStep[] = [];
  const receipt: UpgradeReceipt = { ok: false, outcome: "preflight_failed", agentId: o.agentId, upgradeId: null, from: null, to: { ...o.target }, steps, state: {}, ledger: {}, process: {}, backupDir: null, downtimeMs: null, record: null };
  const mark = async (step: UpgradeStepName, detail?: string) => {
    steps.push({ step, ok: true, at: new Date().toISOString(), ...(detail ? { detail } : {}) });
    log("founder_runtime_upgrade_step", { agentId: o.agentId, step, detail: detail ?? null });
    await o.afterStep?.(step);
  };
  const fail = (step: UpgradeStepName, why: string): never => {
    steps.push({ step, ok: false, at: new Date().toISOString(), detail: why });
    log("founder_runtime_upgrade_step_failed", { agentId: o.agentId, step, why });
    throw new StepFailure(why);
  };

  // ── preflight (nothing is changed) ─────────────────────────────────────────────────────────────────────────
  let from: RuntimeReleaseRow;
  let identity: { genesisId: string; workspaceId: string; stateNamespace: string };
  let before: { pid: number | null; uid: number | null; instanceId: string | null };
  try {
    const ctx = await o.registry.founderRuntimeContext(o.agentId);
    const a = ctx.agent;
    if (ctx.schemaVersion < 23) fail("preflight", `registry schema v${ctx.schemaVersion} has no runtime-upgrade lifecycle`);
    if (!a || !["genesis_founder", "reseed_founder"].includes(a.origin) || a.role !== "root") fail("preflight", "not a founder");
    if (a!.status !== "active") fail("preflight", `founder is ${a!.status}; only a healthy active founder is upgraded`);
    if (a!.challengeFailures !== 0) fail("preflight", `founder has ${a!.challengeFailures} failed health challenge(s)`);
    if (!a!.genesisId || !a!.workspaceId || !a!.stateNamespace) fail("preflight", "founder record lacks its Genesis/workspace identity");
    identity = { genesisId: a!.genesisId!, workspaceId: a!.workspaceId!, stateNamespace: a!.stateNamespace! };
    const cur = await o.registry.founderRuntimeCurrent(o.agentId);
    if (!cur) fail("preflight", "founder has no registered runtime");
    from = { repo: cur!.repo, commit: cur!.commit, buildId: cur!.buildId, lockfileSha256: cur!.lockfileSha256 };
    receipt.from = from;
    if (a!.runtimeCommit !== from.commit) fail("preflight", "registry row and the founder's runtime record disagree");
    if (!ctx.approved || !sameRelease(ctx.approved, o.target)) fail("preflight", "the target is not the owner-approved runtime");
    if (from.commit === o.target.commit && from.buildId === o.target.buildId) fail("preflight", "the founder already runs the target runtime");
    const open = (await o.registry.founderRuntimeUpgrades(o.agentId, 5)).find((u) => u.status === "prepared" || u.status === "committed");
    if (open) fail("preflight", `upgrade ${open.upgradeId} of this founder is still ${open.status}; resolve it first (rollback-runtime)`);
    // Target attestation, and the rollback path: both installed trees hash to their releases.
    const tProblem = verifyInstalledRelease(o.host, o.target);
    if (tProblem) fail("preflight", tProblem);
    const fProblem = verifyInstalledRelease(o.host, from);
    if (fProblem) fail("preflight", `no rollback path: ${fProblem}`);
    // Current pin: host pin, registry and the running process agree.
    const pin = await o.host.currentPin(o.agentId);
    if (!pin || pin.commit !== from.commit || (pin.buildId !== null && pin.buildId !== from.buildId) || (pin.workingDirectory !== null && path.resolve(pin.workingDirectory) !== path.resolve(o.host.releaseDir(from.commit)))) {
      fail("preflight", `the founder's host pin (${pin?.commit?.slice(0, 7) ?? "none"}) is not its registered runtime ${from.commit.slice(0, 7)}`);
    }
    const ev = await o.host.evidence(o.agentId, { genesisId: identity.genesisId, repo: from.repo, workspaceId: identity.workspaceId, stateNamespace: identity.stateNamespace });
    if (!ev) fail("preflight", "the founder process is not running");
    if (ev!.agentId !== o.agentId || ev!.commit !== from.commit || ev!.buildId !== from.buildId) fail("preflight", "the running founder process is not its registered runtime");
    if (ev!.workspaceId !== identity.workspaceId || ev!.stateNamespace !== identity.stateNamespace || ev!.stateDirOwnerUid !== ev!.uid) fail("preflight", "the founder's state areas are not its own");
    before = { pid: ev!.pid, uid: ev!.uid, instanceId: ev!.instanceId };
    receipt.process.before = before;
    const fresh = a!.lastHeartbeat ? Date.now() - Date.parse(a!.lastHeartbeat) : Infinity;
    if (!(fresh < ctx.heartbeatUnresponsiveS * 1_000)) fail("preflight", "the founder has not sent a recent heartbeat");
    // Downtime budget: even a full health wait plus a rollback's must stay far inside the registry's dead threshold.
    const worstMs = 2 * healthTimeout + (o.stopTimeoutMs ?? 60_000) * 2;
    if (worstMs >= ctx.heartbeatDeadS * 1_000 * 0.8) fail("preflight", `the upgrade's worst-case downtime (${Math.round(worstMs / 1000)} s) is too close to the registry's dead threshold (${ctx.heartbeatDeadS} s)`);
    const snap = snapshotFounderState(o.host.stateDir(o.agentId));
    if (!snap.identitySha256 || !snap.credentialSha256) fail("preflight", "the founder's identity or credential file is missing");
    if (snap.ownerUids.length !== 1 || snap.ownerUids[0] !== ev!.uid) fail("preflight", "the founder's state is not owned by exactly its own uid");
    await mark("preflight", `from ${from.commit.slice(0, 7)} to ${o.target.commit.slice(0, 7)}; ${snap.entries.length} state files`);
  } catch (err) {
    if (!(err instanceof StepFailure)) steps.push({ step: "preflight", ok: false, at: new Date().toISOString(), detail: short(err) });
    return { ...receipt, outcome: "preflight_failed", why: short(err) };
  }
  if (o.dryRun) return { ...receipt, ok: true, outcome: "preflight_ok" };

  // ── stop → snapshot → prepare → commit → pin → start → prove → verify ──────────────────────────────────────
  let upgradeId: string | null = null;
  let committed = false;
  let stoppedAt = 0;
  let snapA: StateSnapshot | null = null;
  try {
    // Do not stop the founder in the middle of a paid inference call if a short wait avoids it.
    const idleBy = Date.now() + (o.quiesceTimeoutMs ?? 270_000);
    while ((await o.registry.founderRuntimeContext(o.agentId)).inFlight) {
      if (Date.now() > idleBy) fail("quiesce", "an inference call of this founder stayed in flight");
      await sleep(poll);
    }
    await mark("quiesce");
    await o.host.stopStrict(o.agentId, o.stopTimeoutMs).catch((e) => fail("stop", short(e)));
    stoppedAt = Date.now();
    // A call that started in the instant before the stop is still recorded (and charged) by the controller: wait it out.
    while ((await o.registry.founderRuntimeContext(o.agentId)).inFlight) {
      if (Date.now() > idleBy) fail("stop", "an inference call of this founder is still being recorded");
      await sleep(poll);
    }
    await mark("stop", `pid ${before!.pid} stopped`);

    snapA = snapshotFounderState(o.host.stateDir(o.agentId));
    receipt.state.before = summarizeSnapshot(snapA);
    await mark("snapshot", `state ${snapA.stateSha256.slice(0, 16)}…, ${snapA.entries.length} files`);

    const prepared = await o.registry.founderRuntimeUpgradePrepare(o.agentId, from!, o.target, {
      ...summarizeSnapshot(snapA), pid: before!.pid, uid: before!.uid, instanceId: before!.instanceId, host: o.host.kind,
    }, o.actor).catch((e) => fail("prepare", short(e)));
    upgradeId = prepared.upgradeId;
    receipt.upgradeId = upgradeId;
    receipt.ledger.before = prepared.ledgerBefore;
    await mark("prepare", upgradeId);

    const backupDir = path.join(o.backupRoot, upgradeId);
    try {
      const b = backupFounderState(o.host.stateDir(o.agentId), snapA, backupDir);
      receipt.backupDir = b.dir;
      await mark("backup", `${b.files} files, ${b.bytes} bytes (credential excluded)`);
    } catch (e) {
      if (e instanceof StepFailure) throw e;
      fail("backup", short(e));
    }

    const snapB = snapshotFounderState(o.host.stateDir(o.agentId));
    if (snapB.stateSha256 !== snapA.stateSha256) fail("recheck", "the founder's state changed while it was stopped");
    await mark("recheck");

    await o.registry.founderRuntimeUpgradeCommit(upgradeId, snapB.stateSha256, o.actor).catch((e) => fail("commit", short(e)));
    committed = true;
    const since = (await o.registry.founderRuntimeUpgrade(upgradeId))!.committedAt!;
    await mark("commit", `registry pin ${o.target.commit.slice(0, 7)}`);

    await o.host.pinRuntime(o.agentId, o.target).catch((e) => fail("pin", short(e)));
    await mark("pin");

    const snapC = snapshotFounderState(o.host.stateDir(o.agentId));
    receipt.state.atStart = summarizeSnapshot(snapC);
    if (snapC.stateSha256 !== snapA.stateSha256) fail("prestart", "the founder's state is not identical to the snapshot");
    await mark("prestart");

    await o.host.start(o.agentId).catch((e) => fail("start", short(e)));
    await mark("start");

    const health = await proveFounderHealth({ agentId: o.agentId, host: o.host, registry: o.registry, expected: o.target, since, identity: identity!, notInstance: before!.instanceId, timeoutMs: healthTimeout, pollMs: poll });
    receipt.health = health;
    if (!health.ok) fail("prove", health.why ?? "no proof of health");
    receipt.downtimeMs = Date.now() - stoppedAt;
    receipt.process.after = { pid: health.pid, uid: health.uid, instanceId: health.instanceId };
    await mark("prove", `pid ${health.pid}, ${health.challengesPassed} challenge(s) passed after ${health.waitedMs} ms`);

    const snapD = snapshotFounderState(o.host.stateDir(o.agentId));
    const diff = diffFounderState(snapA, snapD);
    receipt.state.after = summarizeSnapshot(snapD);
    receipt.state.diff = { identical: diff.identical, durableLost: diff.durableLost, identityChanged: diff.identityChanged, credentialChanged: diff.credentialChanged,
      lost: diff.lost.length, changed: diff.changed.length, added: diff.added.length, changedPaths: [...diff.lost, ...diff.changed, ...diff.added].map((x) => x.path).slice(0, 40) };
    if (diff.identityChanged || diff.credentialChanged) fail("compare", "the founder's identity or credential file changed");
    if (diff.durableLost !== 0) fail("compare", `${diff.durableLost} memory/workspace file(s) were lost`);
    await mark("compare", diff.identical ? "state identical" : `${diff.changed.length} changed, ${diff.added.length} added by the running founder; none lost`);

    const verified = await o.registry.founderRuntimeUpgradeVerify(upgradeId, {
      agentId: o.agentId, commit: health.commit, buildId: health.buildId, lockfileSha256: health.lockfileSha256, pid: health.pid, uid: health.uid, instanceId: health.instanceId,
      identitySha256: snapD.identitySha256, credentialSha256: snapD.credentialSha256, stateSha256AtStart: snapC.stateSha256, stateSha256After: snapD.stateSha256,
      durableLost: diff.durableLost, changed: diff.changed.length, added: diff.added.length, downtimeMs: receipt.downtimeMs, backupDir: receipt.backupDir,
    }, o.actor).catch((e) => fail("verify", short(e)));
    receipt.record = verified;
    receipt.ledger.after = (verified.after?.ledger as Record<string, unknown> | undefined) ?? await o.registry.founderLedgerFingerprint(o.agentId);
    await mark("verify");
    return { ...receipt, ok: true, outcome: "verified" };
  } catch (err) {
    const why = short(err);
    if (!(err instanceof StepFailure)) steps.push({ step: steps.at(-1)?.step ?? "preflight", ok: false, at: new Date().toISOString(), detail: `unexpected failure after this step: ${why}` });
    receipt.why = why;
    if (!committed) {
      // Nothing was switched: close the record (if one exists) and bring the founder back on its own runtime.
      try {
        if (upgradeId) await o.registry.founderRuntimeUpgradeAbort(upgradeId, `upgrade aborted: ${why}`.slice(0, 480), o.actor);
        if (stoppedAt) {
          const since = new Date().toISOString();
          if (!(await o.host.pid(o.agentId))) await o.host.start(o.agentId);
          const h = await proveFounderHealth({ agentId: o.agentId, host: o.host, registry: o.registry, expected: from!, since, identity: identity!, notInstance: before!.instanceId, timeoutMs: healthTimeout, pollMs: poll, requireChallenge: false });
          receipt.rollback = { health: h };
          if (!h.ok) throw new Error(`the founder did not come back on its runtime: ${h.why}`);
          receipt.downtimeMs = Date.now() - stoppedAt;
        }
        steps.push({ step: "abort", ok: true, at: new Date().toISOString(), detail: "nothing was switched" });
        receipt.record = upgradeId ? await o.registry.founderRuntimeUpgrade(upgradeId) : null;
        return { ...receipt, outcome: "aborted" };
      } catch (e2) {
        steps.push({ step: "abort", ok: false, at: new Date().toISOString(), detail: short(e2) });
        return { ...receipt, outcome: "rollback_failed", why: `${why}; then: ${short(e2)}` };
      }
    }
    const rb = await rollbackFounderRuntime({ agentId: o.agentId, host: o.host, registry: o.registry, upgradeId: upgradeId!, reason: `automatic rollback: ${why}`.slice(0, 480), actor: o.actor,
      healthTimeoutMs: healthTimeout, stopTimeoutMs: o.stopTimeoutMs, pollMs: poll, log, snapshotBefore: snapA ?? undefined });
    steps.push(...rb.steps);
    receipt.rollback = { health: rb.health, record: rb.record };
    receipt.record = rb.record;
    if (stoppedAt && rb.ok) receipt.downtimeMs = Date.now() - stoppedAt;
    return { ...receipt, outcome: rb.ok ? "rolled_back" : "rollback_failed", ...(rb.ok ? {} : { why: `${why}; rollback: ${rb.why}` }) };
  }
}

export interface RollbackReceipt {
  ok: boolean;
  agentId: string;
  upgradeId: string;
  why?: string;
  restored: RuntimeReleaseRow | null;
  steps: UpgradeStep[];
  health?: HealthProof;
  state?: { durableLost: number; identityChanged: boolean; credentialChanged: boolean; changed: number; added: number; lost: number };
  record: RuntimeUpgradeView | null;
}

/**
 * Return a founder to the runtime recorded when `upgradeId` was prepared: stop it, move the registry pin back (one
 * transaction), re-pin the host, start it and prove health on the restored runtime. Safe to repeat: an upgrade
 * already rolled back in the registry only has its host pin and process reconciled (a crash between the two steps
 * leaves the founder stopped or refusing to start — never running the wrong code).
 */
export async function rollbackFounderRuntime(o: {
  agentId: string; host: FounderUpgradeHost; registry: UpgradeRegistry; upgradeId: string; reason: string; actor: string;
  healthTimeoutMs?: number; stopTimeoutMs?: number; pollMs?: number; log?: (event: string, detail?: Record<string, unknown>) => void;
  /** The state as it was before the upgrade (for the no-loss comparison); absent = compared against the state at rollback time. */
  snapshotBefore?: StateSnapshot;
}): Promise<RollbackReceipt> {
  const steps: UpgradeStep[] = [];
  const log = o.log ?? (() => {});
  const mark = (step: UpgradeStepName, ok: boolean, detail?: string) => {
    steps.push({ step, ok, at: new Date().toISOString(), ...(detail ? { detail } : {}) });
    log(ok ? "founder_runtime_upgrade_step" : "founder_runtime_upgrade_step_failed", { agentId: o.agentId, step, detail: detail ?? null });
  };
  const out: RollbackReceipt = { ok: false, agentId: o.agentId, upgradeId: o.upgradeId, restored: null, steps, record: null };
  let at: UpgradeStepName = "rollback:stop";
  try {
    const u = await o.registry.founderRuntimeUpgrade(o.upgradeId);
    if (!u || u.agentId !== o.agentId) throw new Error("no such runtime upgrade of this founder");
    if (u.status === "prepared") throw new Error("the upgrade was never committed: abort it instead (nothing was switched)");
    if (u.status === "aborted") throw new Error("the upgrade was aborted: nothing was switched");
    out.restored = u.from;
    const ctx = await o.registry.founderRuntimeContext(o.agentId);
    if (!ctx.agent?.genesisId || !ctx.agent.workspaceId || !ctx.agent.stateNamespace) throw new Error("founder record lacks its Genesis/workspace identity");
    const identity = { genesisId: ctx.agent.genesisId, workspaceId: ctx.agent.workspaceId, stateNamespace: ctx.agent.stateNamespace };
    const problem = verifyInstalledRelease(o.host, u.from);
    if (problem) throw new Error(`the previous runtime cannot be restored: ${problem}`);
    const prior = await o.host.evidence(o.agentId, { ...identity, repo: u.from.repo }).catch(() => null);

    await o.host.stopStrict(o.agentId, o.stopTimeoutMs);
    mark("rollback:stop", true);
    const snap = snapshotFounderState(o.host.stateDir(o.agentId));

    at = "rollback:registry";
    let rolled = u;
    if (u.status === "committed" || u.status === "verified") rolled = await o.registry.founderRuntimeUpgradeRollback(o.upgradeId, o.reason, o.actor);
    mark("rollback:registry", true, `registry pin ${u.from.commit.slice(0, 7)}`);

    at = "rollback:pin";
    await o.host.pinRuntime(o.agentId, rel(u.from));
    mark("rollback:pin", true);

    at = "rollback:start";
    await o.host.start(o.agentId);
    mark("rollback:start", true);

    at = "rollback:prove";
    const health = await proveFounderHealth({ agentId: o.agentId, host: o.host, registry: o.registry, expected: u.from, since: rolled.closedAt!, identity, notInstance: prior?.instanceId ?? null,
      timeoutMs: o.healthTimeoutMs ?? 150_000, pollMs: o.pollMs ?? 1_000 });
    out.health = health;
    if (!health.ok) throw new Error(health.why ?? "no proof of health on the restored runtime");
    mark("rollback:prove", true, `pid ${health.pid}, ${health.challengesPassed} challenge(s) passed`);

    at = "rollback:verify";
    const after = snapshotFounderState(o.host.stateDir(o.agentId));
    const diff = diffFounderState(o.snapshotBefore ?? snap, after);
    out.state = { durableLost: diff.durableLost, identityChanged: diff.identityChanged, credentialChanged: diff.credentialChanged, changed: diff.changed.length, added: diff.added.length, lost: diff.lost.length };
    out.record = rolled.rollback ? rolled : await o.registry.founderRuntimeUpgradeRollbackVerify(o.upgradeId, {
      agentId: o.agentId, commit: health.commit, buildId: health.buildId, lockfileSha256: health.lockfileSha256, pid: health.pid, uid: health.uid, instanceId: health.instanceId,
      identitySha256: after.identitySha256, credentialSha256: after.credentialSha256, stateSha256After: after.stateSha256, durableLost: diff.durableLost,
    }, o.actor);
    mark("rollback:verify", true);
    return { ...out, ok: true };
  } catch (err) {
    mark(at, false, short(err));
    out.record = await o.registry.founderRuntimeUpgrade(o.upgradeId).catch(() => null);
    return { ...out, why: short(err) };
  }
}
