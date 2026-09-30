/**
 * Living-founder runtime-upgrade rehearsal (R23) — everything a real upgrade does, on a SYNTHETIC founder against a
 * THROWAWAY registry and a rehearsal FleetController. No production registry, founder, ledger or provider is touched:
 * the model is the credential-free scripted one behind a loopback fake Messages API.
 *
 *   1. a synthetic founder is created by Genesis on the PREVIOUS runtime (`from`, e.g. the release a living founder is
 *      pinned to), activated, and given real state: goals, facts, notes, conversation history, inference charges;
 *   2. the rehearsal controller moves to the TARGET release (`to`) — the founder stays on its own runtime;
 *   3. fail-closed paths: an unapproved target build, a state change while stopped, a runtime that refuses to start
 *      (wrong pin/build) — each leaves the SAME founder healthy on its previous runtime;
 *   4. upgrade → the same founder on the target runtime (identity, credential, memory, workspace, ledger preserved);
 *   5. rollback → the same founder on the previous runtime; then upgrade again;
 *   6. routed cognition through fake provider paths on the upgraded runtime: tiers verified and enabled, routing on,
 *      the founder opted in — T1/T2/T3 selection, question-scoped escalation and return to T2, consequential-action
 *      linkage, tier/scope-aware caching, no thinking across model boundaries, memory and ledger continuity.
 *
 * Works with any FounderUpgradeHost: the process host (tests, development) and the systemd host (the production
 * machine's real founder units, still against the throwaway registry).
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import pg from "pg";
import { PgFleetStore } from "../postgres/store.js";
import { PgAgentGateway } from "../postgres/agent-gateway.js";
import { PgLedgerAdmin } from "../treasury/ledger.js";
import { GENESIS_FOUNDERS, PgGenesisAdmin } from "../genesis/admin.js";
import { FleetService } from "../service/server.js";
import { UnsupportedSandboxTerminator } from "../service/terminator.js";
import { AnthropicProvider } from "../cognition/anthropic.js";
import { REHEARSAL_AGENT_HEADER } from "../cognition/fake-openai.js";
import { startFakeAnthropic, type FakeAnthropic } from "../cognition/fake-anthropic.js";
import type { ProviderFactory } from "../cognition/routed-gateway.js";
import { REHEARSAL_DONE_FACT, REHEARSAL_TRIAGE_FACT, RoutedRehearsalModel, routedRehearsalToolless } from "../eval/routed-rehearsal-model.js";
import type { RuntimeRelease } from "../runtime.js";
import { FOUNDER_CREDENTIAL_FILE, FOUNDER_IDENTITY_FILE, type FounderIdentityFile } from "./evidence.js";
import type { FounderUpgradeHost } from "./host.js";
import { FounderProvisioner } from "./provisioner.js";
import { snapshotFounderState } from "./state-snapshot.js";
import { rollbackFounderRuntime, upgradeFounderRuntime, type UpgradeReceipt } from "./upgrade.js";
import type { RehearsalCheck } from "./rehearsal.js";

export const UPGRADE_REHEARSAL_MODEL = "fleet-rehearsal-claude";
const FAKE_KEY = "rehearsal-fake-provider-key";
const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-5";

export interface UpgradeRehearsalOptions {
  registry: { ownerUrl: string; serviceUrl: string; agentUrl: string };
  /** Pins new founders to `from` at provisioning. */
  host: FounderUpgradeHost;
  from: RuntimeRelease;
  to: RuntimeRelease;
  actor: string;
  /** Where state backups go (deleted with the rehearsal's other state by the caller). */
  backupRoot: string;
  /** The pin file of a founder on this host: the rehearsal damages it once to prove a mis-pinned runtime refuses to start. */
  pinEnvFile(agentId: string): string;
  timeoutMs?: number;
  healthTimeoutMs?: number;
  pollMs?: number;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}

export interface UpgradeRehearsalReport {
  pass: boolean;
  host: string;
  founder: string | null;
  from: RuntimeRelease;
  to: RuntimeRelease;
  checks: RehearsalCheck[];
  receipts: { failedStart?: UpgradeReceipt; upgrade?: UpgradeReceipt; second?: UpgradeReceipt };
  routed: Array<Record<string, unknown>>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms: number, step = 500): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v as T;
    if (Date.now() > end) return null;
    await sleep(step);
  }
}
const sha = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

export async function runUpgradeRehearsal(o: UpgradeRehearsalOptions): Promise<UpgradeRehearsalReport> {
  const log = o.log ?? (() => {});
  const checks: RehearsalCheck[] = [];
  const check = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    log("upgrade_rehearsal_check", { name, ok, detail });
  };
  const timeout = o.timeoutMs ?? 120_000;
  const health = o.healthTimeoutMs ?? 90_000;
  const poll = o.pollMs ?? 500;
  const report: UpgradeRehearsalReport = { pass: false, host: o.host.kind, founder: null, from: o.from, to: o.to, checks, receipts: {}, routed: [] };
  const store = new PgFleetStore({ connectionString: o.registry.ownerUrl });
  const svcStore = new PgFleetStore({ connectionString: o.registry.serviceUrl });
  const gw = new PgAgentGateway({ connectionString: o.registry.agentUrl });
  const ledger = new PgLedgerAdmin({ connectionString: o.registry.ownerUrl });
  const genesis = new PgGenesisAdmin({ connectionString: o.registry.ownerUrl });
  const owner = new pg.Pool({ connectionString: o.registry.ownerUrl, max: 2, options: "-c search_path=fleet" });
  const audit: Array<Record<string, unknown>> = [];
  const fake: FakeAnthropic = await startFakeAnthropic({
    apiKey: FAKE_KEY, model: UPGRADE_REHEARSAL_MODEL, models: [HAIKU, SONNET, OPUS], thinking: true, fault: () => null,
    script: new RoutedRehearsalModel(UPGRADE_REHEARSAL_MODEL), toolless: routedRehearsalToolless, cacheMinTokens: 1024,
  });
  const base = new AnthropicProvider({ baseUrl: fake.url, apiKey: FAKE_KEY, model: UPGRADE_REHEARSAL_MODEL, attemptTimeoutMs: 5_000, maxAttempts: 2, backoffMs: 100,
    extraHeaders: (agentId) => ({ [REHEARSAL_AGENT_HEADER]: agentId }) });
  // The production factory's rule: only the owner's mapping (model/thinking/effort) and the per-call cache mode vary.
  const factory: ProviderFactory = (c, effort, promptCache) => {
    const p = base.with({ model: c.model, thinking: c.thinking === "adaptive" ? { type: "adaptive" } : undefined, effort: effort ?? c.effort ?? undefined, promptCache });
    return Object.assign(p, { promptCache: p.settings.promptCache });
  };
  let service: FleetService | null = null;
  let port = 0;
  const controller = async (release: RuntimeRelease): Promise<string> => {
    await service?.close().catch(() => undefined);
    await store.setApprovedRuntime({ repo: release.repo, commit: release.commit }, "rehearsal", { buildId: release.buildId, lockfileSha256: release.lockfileSha256 });
    service = new FleetService({
      admin: svcStore, agent: gw, realReplicationEnabled: false, reaperIntervalMs: 0, release,
      audit: (e) => audit.push(e as unknown as Record<string, unknown>), terminator: new UnsupportedSandboxTerminator(),
      cognitionProvider: base, cognitionProviderFactory: factory, cognitionDeadlineMs: 12_000,
    });
    const l = await service.listen(port, "127.0.0.1");
    port = Number(new URL(l.url).port);
    return l.url;
  };
  let id: string | null = null;
  try {
    await store.migrate();
    await store.setMaxAgents(2, "rehearsal");
    await store.setLifecyclePolicy({ healthChallengeIntervalS: 2, challengeTtlS: 30, healthGraceS: 300, maxChallengeFailures: 3, terminationGraceS: 480, orphanSlotHoldS: 259200, maxOpenOrphans: 1, sessionTtlS: 600 }, "rehearsal");
    await genesis.setEnabled(true, o.actor, "rehearsal registry only (throwaway)");
    const boot = await genesis.bootstrapCapital();
    const acct = (await genesis.accountingCurrency()) ?? "USD";
    if (boot && boot.currency !== acct) throw new Error("the rehearsal registry's bootstrap capital is not in its accounting currency");
    const alloc = boot ? boot.minorUnits : 10_000;
    await ledger.recordOwnerFunding(alloc * 2, `rehearsal:synthetic-${crypto.randomUUID()}`, o.actor);

    // ── 1. A synthetic founder on the PREVIOUS runtime ─────────────────────────────────────────────────────
    const apiUrl = await controller(o.from);
    const g = boot
      ? await genesis.proposeCapital({ idempotencyKey: `upgrade-rehearsal:${crypto.randomUUID()}`, founderCount: GENESIS_FOUNDERS, ttlS: 3600, actor: o.actor })
      : await genesis.propose({ idempotencyKey: `upgrade-rehearsal:${crypto.randomUUID()}`, founderCount: GENESIS_FOUNDERS, allocationCents: alloc, ttlS: 3600, actor: o.actor });
    await genesis.approve(g.genesisId, g.authSha256, o.actor);
    const prov = new FounderProvisioner({ genesis, host: o.host, apiUrl, actor: o.actor, evidenceTimeoutMs: timeout, log });
    [id] = (await prov.provisionGenesis(g.genesisId)).founderIds ?? [];
    if (!id) throw new Error("Genesis produced no founder");
    report.founder = id;
    const a = id;
    const at = await prov.attestGenesis(g.genesisId);
    if (!at.ok) throw new Error(`the synthetic founder was not attested: ${at.why}`);
    await genesis.fund(g.genesisId, o.actor);
    await prov.activateGenesis(g.genesisId, g.authSha256);
    const rep = async () => (await o.host.readReport(a)) as Record<string, any> | null;
    const healthy = await waitFor(async () => { const r = await rep(); return r && r.mode === "active" && Number(r.heartbeats) >= 2 && Number(r.challengesPassed) >= 1 ? r : null; }, timeout, poll);
    const pin0 = await o.host.currentPin(a);
    check("a synthetic founder lives on the previous runtime (Genesis-attested, pinned, heartbeating, challenged)",
      Boolean(healthy) && healthy!.commit === o.from.commit && pin0?.commit === o.from.commit && at.founders[0]?.host?.buildId === o.from.buildId,
      `founder ${a.slice(-6)} on ${o.from.commit.slice(0, 7)} (build ${o.from.buildId.slice(0, 12)}…), pid ${await o.host.pid(a)}`);

    // Real state on the previous runtime: the legacy single-model path, exactly what a living founder has used.
    const today = new Date().toISOString().slice(0, 10);
    if (acct !== "USD") await ledger.recordFxRate("USD", acct, 750_000, "synthetic rehearsal rate (throwaway registry)", today, o.actor);
    await ledger.recordProviderCredits("anthropic", "purchase", 5_000, `rehearsal:synthetic-${crypto.randomUUID()}`, o.actor);
    await genesis.setCognitionPolicy({ enabled: true, provider: "anthropic", model: UPGRADE_REHEARSAL_MODEL, inputMicrocents: 1_000, outputMicrocents: 4_000, maxOutputTokens: 4_000, actor: o.actor });
    await genesis.setFounderCognition(a, { enabled: true, maxTurnsPerHour: 2_000, dailyBudgetCents: 5_000, reason: "rehearsal registry only", actor: o.actor });
    const ident = JSON.parse(fs.readFileSync(path.join(o.host.stateDir(a), FOUNDER_IDENTITY_FILE), "utf8")) as FounderIdentityFile;
    const stateNs = path.join(o.host.stateDir(a), "state", ident.stateNamespace);
    const ws = path.join(o.host.stateDir(a), "workspace", ident.workspaceId);
    const facts = () => { try { return JSON.parse(fs.readFileSync(path.join(stateNs, "memory", "facts.json"), "utf8")) as Record<string, string>; } catch { return {} as Record<string, string>; } };
    const goals = () => { try { return JSON.parse(fs.readFileSync(path.join(stateNs, "memory", "goals.json"), "utf8")) as Array<Record<string, unknown>>; } catch { return []; } };
    const logRows = async () => (await owner.query(
      `SELECT seq, request_id, model, outcome, error_code, tier, task_class, requested_tier, escalation_reason, router_decision, parent_request_id, packet_bytes, thinking_tokens,
              cache_policy, cache_saving_microcents, cache_read_tokens, cache_write_tokens, input_tokens, output_tokens, cost_microcents, charged_cents, tool_calls, reasoning
         FROM fleet_cognition_log WHERE agent_id = $1 ORDER BY seq`, [a])).rows as Array<Record<string, any>>;
    const lived = await waitFor(async () => (facts().area && goals().length > 0 && fs.existsSync(path.join(ws, "notes", "plan.md")) && (await logRows()).length >= 4 ? true : null), timeout, poll);
    const legacyRows = await logRows();
    check("the founder has real state on the previous runtime: facts, goals, notes, history and inference charges (legacy single-model path)",
      Boolean(lived) && legacyRows.every((r) => r.tier === null && r.model === UPGRADE_REHEARSAL_MODEL) && legacyRows.some((r) => Number(r.charged_cents) > 0) && fs.existsSync(path.join(stateNs, "mind-history.json")),
      `${Object.keys(facts()).length} fact(s), ${goals().length} goal(s), notes/plan.md, ${legacyRows.length} legacy call(s), tier NULL`);

    // ── 2. The controller moves to the target release; the founder does not ────────────────────────────────
    const pidBefore = await o.host.pid(a);
    await controller(o.to);
    const still = await waitFor(async () => { const h = await genesis.founderRuntimeHealthSince(a, new Date(Date.now() - 5_000)); return h?.heartbeatAfter ? h : null; }, timeout, poll);
    check("the controller moved to the target release; the founder stayed on its own runtime (same process)",
      Boolean(still) && (await o.host.pid(a)) === pidBefore && (await genesis.founderRuntimeCurrent(a))?.commit === o.from.commit,
      `controller ${o.to.commit.slice(0, 7)}; founder pid ${pidBefore} on ${o.from.commit.slice(0, 7)}`);

    /** Everything that makes the founder the SAME economic agent (must never change). */
    const identityOf = async () => ({
      agent: (await owner.query(`SELECT agent_id, role, generation, origin, genesis_id, lineage_root, workspace_id, state_namespace, capability_manifest_id, name, wallet_address, created_at FROM fleet_agents WHERE agent_id = $1`, [a])).rows[0],
      credential: (await owner.query(`SELECT token_hash, created_at, revoked_at FROM fleet_agent_credentials WHERE agent_id = $1`, [a])).rows[0],
      genesis: (await owner.query(`SELECT genesis_id, status, runtime_commit, runtime_build_id, auth_sha256 FROM fleet_genesis WHERE genesis_id = $1`, [g.genesisId])).rows[0],
      founder: (await owner.query(`SELECT status, attestation, allocation_journal_id FROM fleet_genesis_founders WHERE agent_id = $1`, [a])).rows[0],
      accounts: (await owner.query(`SELECT account_id, class, created_at FROM fleet_ledger_accounts WHERE agent_id = $1 ORDER BY account_id`, [a])).rows,
      counts: (await owner.query(`SELECT (SELECT count(*)::int FROM fleet_agents) AS agents, (SELECT count(*)::int FROM fleet_genesis) AS genesis,
                 (SELECT living_agents + reserved_slots + quarantined_slots FROM fleet_state) AS population`)).rows[0],
      identityFile: sha(path.join(o.host.stateDir(a), FOUNDER_IDENTITY_FILE)),
      credentialFile: sha(path.join(o.host.stateDir(a), FOUNDER_CREDENTIAL_FILE)),
    });
    const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
    const id0 = await identityOf();
    const durable = () => ({ area: facts().area, goals: goals().map((x) => `${String(x.id)}:${String(x.title)}`), plan: sha(path.join(ws, "notes", "plan.md")) });
    const d0 = durable();
    /** The founder's pre-upgrade memory and notes are still there (it may have added goals since: it keeps living). */
    const kept = () => { const d = durable(); return d.area === d0.area && d.plan === d0.plan && same(d.goals.slice(0, d0.goals.length), d0.goals); };
    /** cash = allocation − every charge ever recorded for this founder (the books never reset). */
    const booksOk = async () => {
      const charged = (await logRows()).reduce((n, r) => n + Number(r.charged_cents), 0);
      const cash = Number((await ledger.economics(a)).cash);
      return { ok: cash === alloc - charged && (await ledger.verify()).ok, cash, charged };
    };
    const registryCommit = async () => (await owner.query(`SELECT runtime_commit FROM fleet_agents WHERE agent_id = $1`, [a])).rows[0].runtime_commit as string;
    const failedChallenges = async () => (await owner.query(`SELECT count(*)::int AS n FROM fleet_health_challenges WHERE agent_id = $1 AND outcome = 'failed'`, [a])).rows[0].n as number;
    const upgrade = (extra: Partial<Parameters<typeof upgradeFounderRuntime>[0]> = {}) => upgradeFounderRuntime({
      agentId: a, host: o.host, registry: genesis, target: o.to, actor: o.actor, backupRoot: o.backupRoot, healthTimeoutMs: health, pollMs: poll, quiesceTimeoutMs: 60_000, log, ...extra });
    const onFrom = async (notPid: number | null) => waitFor(async () => {
      const ev = await o.host.evidence(a, { genesisId: g.genesisId, repo: o.from.repo, workspaceId: ident.workspaceId, stateNamespace: ident.stateNamespace });
      const h = await genesis.founderRuntimeHealthSince(a, new Date(Date.now() - 4_000));
      return ev && ev.commit === o.from.commit && ev.pid !== notPid && h?.heartbeatAfter && h.status === "active" ? ev : null;
    }, timeout, poll);

    // ── 3. Fail-closed paths ───────────────────────────────────────────────────────────────────────────────
    const dry = await upgrade({ dryRun: true });
    const wrongBuild = await upgrade({ target: { ...o.to, buildId: "f".repeat(64) } });
    const guard = await owner.query(`UPDATE fleet_agents SET runtime_commit = $2 WHERE agent_id = $1`, [a, o.to.commit]).then(() => "UPDATED", (e: Error) => /FLEET_[A-Z_]+/.exec(e.message)?.[0] ?? "ERR");
    check("preflight changes nothing; an unapproved target build is refused; the registry pin cannot be moved outside the lifecycle",
      dry.outcome === "preflight_ok" && wrongBuild.outcome === "preflight_failed" && /not the owner-approved runtime/.test(wrongBuild.why ?? "") && guard === "FLEET_RUNTIME_UPGRADE_REQUIRED"
        && (await o.host.pid(a)) === pidBefore && (await registryCommit()) === o.from.commit && (await genesis.founderRuntimeUpgrades(a)).length === 0,
      `dry run ${dry.outcome}; wrong build → ${wrongBuild.why}; direct UPDATE → ${guard}; founder pid ${pidBefore} untouched`);

    // State changes while the founder is stopped: nothing is switched, the founder comes back on its own runtime.
    const planted = path.join(stateNs, "memory", "planted-during-upgrade.json");
    const tampered = await upgrade({ afterStep: (s) => { if (s === "prepare") fs.writeFileSync(planted, "{}", { mode: 0o600 }); } });
    fs.rmSync(planted, { force: true });
    const backA = await onFrom(pidBefore);
    const recA = (await genesis.founderRuntimeUpgrades(a))[0];
    check("a state change while the founder is stopped aborts the upgrade: nothing switched, the same founder back on its runtime",
      tampered.outcome === "aborted" && /state changed/.test(tampered.why ?? "") && recA?.status === "aborted" && Boolean(backA) && (await registryCommit()) === o.from.commit
        && same(await identityOf(), id0) && kept(),
      `${tampered.outcome}: ${tampered.why}; record ${recA?.status}; founder pid ${backA?.pid} on ${o.from.commit.slice(0, 7)}`);

    // A runtime started against a wrong pin refuses by itself; the lifecycle rolls back.
    const pidB = await o.host.pid(a);
    const failed = await upgrade({ afterStep: (s) => {
      if (s !== "pin") return;
      const f = o.pinEnvFile(a);
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/^FLEET_RUNTIME_BUILD_ID=.*$/m, `FLEET_RUNTIME_BUILD_ID=${"e".repeat(64)}`));
    } });
    report.receipts.failedStart = failed;
    const backB = await onFrom(pidB);
    const recB = (await genesis.founderRuntimeUpgrades(a))[0];
    check("a mis-pinned target runtime refuses to start (fail closed) and the lifecycle rolls back to the previous pinned runtime",
      failed.outcome === "rolled_back" && /refused to run|not running/.test(failed.why ?? "") && recB?.status === "rolled_back" && recB.rollback !== null && Boolean(backB)
        && (await registryCommit()) === o.from.commit && (await o.host.currentPin(a))?.commit === o.from.commit && same(await identityOf(), id0) && kept(),
      `${failed.outcome}: ${failed.why}; record ${recB?.status}; founder pid ${backB?.pid} on ${o.from.commit.slice(0, 7)}; downtime ${failed.downtimeMs} ms`);

    // ── 4. Upgrade ─────────────────────────────────────────────────────────────────────────────────────────
    const turnsOf = async () => { const l = (await rep())?.agentLoop; return typeof l === "object" && l ? Number(l.turns ?? 0) : -1; };
    const up = await upgrade();
    report.receipts.upgrade = up;
    const idUp = await identityOf();
    check("upgrade: the founder runs the target runtime, proven by the registry (heartbeat + health challenge) and host observation",
      up.outcome === "verified" && up.health?.ok === true && up.health.commit === o.to.commit && up.health.buildId === o.to.buildId && (await registryCommit()) === o.to.commit
        && (await o.host.currentPin(a))?.commit === o.to.commit && (await genesis.founderRuntimeCurrent(a))?.source === "upgrade" && up.record?.status === "verified",
      `${up.outcome}${up.why ? `: ${up.why}` : ""}; pid ${up.process.before?.pid} → ${up.process.after?.pid}; ${up.health?.challengesPassed} challenge(s); downtime ${up.downtimeMs} ms`);
    check("upgrade: it is the SAME founder — id, registry identity, Genesis, credential, ledger accounts and population unchanged; no founder created",
      same(idUp, id0), same(idUp, id0) ? `agent ${a.slice(-6)}, genesis ${g.genesisId.slice(0, 8)}, ${id0.accounts.length} ledger account(s), population ${id0.counts.population}` : "identity changed");
    check("upgrade: state was byte-identical when the target runtime started; afterwards no memory or workspace file was lost",
      up.state.atStart?.stateSha256 === up.state.before?.stateSha256 && up.state.diff?.durableLost === 0 && up.state.diff.identityChanged === false && up.state.diff.credentialChanged === false && kept(),
      `state ${String(up.state.before?.stateSha256).slice(0, 16)}… at stop and at start; after: ${up.state.diff?.changed} changed, ${up.state.diff?.added} added, ${up.state.diff?.lost} lost; backup ${up.backupDir ? "taken (credential excluded)" : "missing"}`);
    const backupHasCredential = up.backupDir ? fs.existsSync(path.join(up.backupDir, "state", FOUNDER_CREDENTIAL_FILE)) : true;
    check("upgrade: the state backup holds the durable state and never the credential", Boolean(up.backupDir) && !backupHasCredential && fs.existsSync(path.join(up.backupDir!, "manifest.json")),
      up.backupDir ? `${up.backupDir}` : "no backup");
    const t0 = await turnsOf();
    const thinkingOn = await waitFor(async () => ((await turnsOf()) >= t0 + 1 ? true : null), timeout, poll);
    const rowsUp = await logRows();
    const booksUp = await booksOk();
    check("upgrade: the upgraded founder keeps working on its existing path (routing not active: legacy turns, its own history) and its books continue",
      Boolean(thinkingOn) && rowsUp.length > legacyRows.length && rowsUp.every((r) => r.tier === null) && booksUp.ok && typeof (await rep())?.agentLoop?.routing === "object",
      `${rowsUp.length - legacyRows.length} call(s) since the upgrade, all legacy; cash ${booksUp.cash} = ${alloc} − ${booksUp.charged}; ledger verifies`);

    // ── 5. Rollback, then upgrade again ────────────────────────────────────────────────────────────────────
    const rb = await rollbackFounderRuntime({ agentId: a, host: o.host, registry: genesis, upgradeId: up.upgradeId!, reason: "rehearsal: rollback of a verified upgrade", actor: o.actor, healthTimeoutMs: health, pollMs: poll, log });
    const idRb = await identityOf();
    check("rollback: the same founder is back on the previous pinned runtime, healthy, with nothing lost",
      rb.ok && rb.health?.commit === o.from.commit && rb.health.buildId === o.from.buildId && (await registryCommit()) === o.from.commit && (await o.host.currentPin(a))?.commit === o.from.commit
        && rb.record?.status === "rolled_back" && rb.record.rollback !== null && rb.state?.durableLost === 0 && same(idRb, id0) && kept()
        && (await genesis.founderRuntimeCurrent(a))?.source === "genesis",
      `${rb.ok ? "rolled back" : rb.why}; pid ${rb.health?.pid} on ${o.from.commit.slice(0, 7)}; ${rb.health?.challengesPassed} challenge(s) passed`);
    const again = await upgrade();
    report.receipts.second = again;
    check("upgrade again after the rollback: verified, same founder", again.outcome === "verified" && same(await identityOf(), id0) && kept() && (await booksOk()).ok,
      `${again.outcome}${again.why ? `: ${again.why}` : ""}; upgrade history ${(await genesis.founderRuntimeUpgrades(a)).map((u) => u.status).reverse().join(" → ")}`);
    check("no health challenge ever failed through the aborted, failed, upgraded and rolled-back runs", (await failedChallenges()) === 0, `${await failedChallenges()} failed challenge(s)`);

    // ── 6. Routed cognition on the upgraded runtime (fake provider paths) ──────────────────────────────────
    const before = (await logRows()).length;
    for (const [tier, model] of [["T1", HAIKU], ["T2", SONNET], ["T3", OPUS]] as const) {
      await genesis.cognitionTierVerify(tier, model, "rehearsal: fake Messages API (throwaway registry)", o.actor);
      await genesis.cognitionTierEnable(tier, true, o.actor);
    }
    await genesis.cognitionRoutingSet(true, null, o.actor);
    await genesis.founderRoutingSet(a, true, o.actor);
    const walked = await waitFor(async () => (facts()[REHEARSAL_DONE_FACT] ? true : null), timeout * 2, poll);
    /** Why the mind stopped recently (its own decision log: codes only). */
    const mindStops = () => {
      try {
        return fs.readFileSync(path.join(stateNs, "mind-log.jsonl"), "utf8").trim().split("\n").slice(-12).map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.stopped).map((e) => `${String(e.stopped)}${e.detail ? ` (${String(e.detail).slice(0, 160)})` : ""}`).slice(-3);
      } catch {
        return [] as string[];
      }
    };
    const all = await logRows();
    const routed = all.slice(before).filter((r) => r.tier !== null);
    report.routed = routed.map((r) => ({ seq: Number(r.seq), tier: r.tier, taskClass: r.task_class, model: r.model, scope: r.router_decision?.scope ?? null, source: r.router_decision?.source ?? null,
      escalation: r.escalation_reason, cachePolicy: r.cache_policy, cacheWrite: Number(r.cache_write_tokens), cacheRead: Number(r.cache_read_tokens), cacheSavingMicrocents: r.cache_saving_microcents === null ? null : Number(r.cache_saving_microcents),
      costMicrocents: Number(r.cost_microcents), outcome: r.outcome, tools: (r.tool_calls as Array<{ name: string }>).map((t) => t.name) }));
    const ok = routed.filter((r) => r.outcome === "ok");
    const t1 = ok.filter((r) => r.tier === "T1");
    const t2 = ok.filter((r) => r.tier === "T2");
    const question = ok.filter((r) => r.tier === "T3" && r.router_decision?.scope === "question");
    const action = ok.filter((r) => r.tier === "T3" && r.router_decision?.source === "action_boundary");
    check("routed: the opted-in founder's calls are routed by task — T1 routine chore (Haiku), T2 ordinary steps (Sonnet), T3 critical (Opus)",
      Boolean(walked) && all.slice(before).filter((r) => r.tier === null).length <= 1 && t1.length >= 1 && t1.every((r) => r.model === HAIKU && r.task_class === "extraction")
        && t2.length >= 3 && t2.every((r) => r.model === SONNET && r.task_class === "agent_step") && [...question, ...action].every((r) => r.model === OPUS),
      `${t1.length} T1, ${t2.length} T2, ${question.length + action.length} T3 call(s) after opt-in${walked ? "" : `; the routed walk did not complete — last stops: ${mindStops().join(", ") || "none"}; agent loop ${JSON.stringify((await rep())?.agentLoop?.last ?? null)}`}`);
    const parent = question[0] ? t2.find((r) => r.request_id === question[0].parent_request_id) : null;
    const afterQuestion = question[0] ? ok.find((r) => Number(r.seq) > Number(question[0].seq)) : null;
    check("routed: one question escalated as a Critical Decision Packet (reason code, parent call), then control returned to T2",
      question.length === 1 && question[0].escalation_reason === "HIGH_CONSEQUENCE" && question[0].requested_tier === "T3" && Number(question[0].packet_bytes) > 0 && Boolean(parent)
        && afterQuestion?.tier === "T2" && Object.keys(facts()).some((k) => k.startsWith("decision:")),
      question[0] ? `reason ${question[0].escalation_reason}, packet ${question[0].packet_bytes} B, parent ${String(question[0].parent_request_id).slice(0, 8)} (T2); next call ${afterQuestion?.tier}` : "no escalation recorded");
    const links = (await owner.query(`SELECT action_class, tier FROM fleet_action_cognition_links WHERE agent_id = $1 ORDER BY linked_at`, [a])).rows as Array<{ action_class: string; tier: string }>;
    const refusedTier = audit.filter((e) => e.type === "action_cognition_refused" || e.event === "action_cognition_refused").length
      || (await owner.query(`SELECT count(*)::int AS n FROM fleet_events WHERE agent_id = $1 AND event_type = 'action_cognition_refused'`, [a]).then((r) => r.rows[0].n as number, () => 0));
    const afterAction = action[0] ? ok.find((r) => Number(r.seq) > Number(action[0].seq)) : null;
    check("routed: consequential actions are linked to the cognition that produced them — a small spend at T2, a major spend only from a T3 step",
      links.some((l) => l.action_class === "spend_request" && l.tier === "T2") && links.some((l) => l.action_class === "major_spend_request" && l.tier === "T3")
        && !links.some((l) => l.action_class === "major_spend_request" && l.tier !== "T3") && action.length >= 1 && action[0].router_decision?.actionClass === "major_spend_request" && afterAction?.tier === "T2",
      `links ${links.map((l) => `${l.action_class}@${l.tier}`).join(", ") || "none"}; ${refusedTier} tier refusal(s) audited; T3 action step then ${afterAction?.tier}`);
    const saving = t2.reduce((n, r) => n + Number(r.cache_saving_microcents ?? 0), 0);
    // R23.1: the prefix is cached only on evidenced reuse — inside the tool loop on the same model — never on a turn's
    // first step after a gap, a T1 chore, the T3 question or the T3 action step; uncached rows carry no cache tokens.
    const cachedT2 = t2.filter((r) => r.cache_policy === "prefix");
    check("routed: cache only on evidenced reuse — T2 prefix written once inside the tool loop and read back; T1, the T3 question, the T3 action step and a turn's first step write nothing",
      t1.every((r) => r.cache_policy === "off" && Number(r.cache_write_tokens) === 0) && cachedT2.length >= 2 && cachedT2.every((r) => String(r.reasoning?.cacheReason ?? "").match(/tool loop|within the cache lifetime/))
        && t2.filter((r) => Number(r.cache_write_tokens) > 0).length === 1 && t2.some((r) => Number(r.cache_read_tokens) > 0) && saving > 0
        && [...t2, ...question, ...action].filter((r) => r.cache_policy === "off").every((r) => Number(r.cache_write_tokens) === 0 && Number(r.cache_read_tokens) === 0)
        && question.every((r) => r.cache_policy === "off") && action.every((r) => r.cache_policy === "off") && t2[0]?.cache_policy === "off",
      `T2: ${cachedT2.length} cached call(s), 1 write, ${t2.filter((r) => Number(r.cache_read_tokens) > 0).length} read(s), net saving ${saving} µ¢; `
        + `uncached: ${[...t1, ...t2, ...question, ...action].filter((r) => r.cache_policy === "off").length} call(s) (first step, T1, T3)`);
    check("routed: provider protocol holds through real founder loops — signed thinking never crosses a model boundary, nothing is edited mid-loop",
      fake.violations.length === 0 && routed.every((r) => r.outcome === "ok"), fake.violations.length ? fake.violations.slice(0, 3).join("; ") : `0 protocol violations over ${routed.length} routed call(s)`);
    // R23.1: after the walk the founder only sleeps; its next bare wake-up starts from the slim packet (the exact call is
    // matched by its request id in the founder's own decision log) and pays no cache write unless reuse is evidenced.
    const slimLog = () => {
      try {
        return fs.readFileSync(path.join(stateNs, "mind-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.packet === "slim" && e.requestId);
      } catch {
        return [] as Array<Record<string, unknown>>;
      }
    };
    const slimRow = await waitFor(async () => {
      const ids = new Set(slimLog().map((e) => String(e.requestId)));
      return (await logRows()).find((r) => ids.has(String(r.request_id))) ?? null;
    }, timeout * 2, poll);
    const lastFull = slimRow ? [...(await logRows())].filter((r) => r.tier === "T2" && Number(r.packet_bytes) > 0 && Number(r.seq) < Number(slimRow.seq)
      && !slimLog().some((e) => String(e.requestId) === String(r.request_id))).at(-1) : undefined;
    const why = String(slimRow?.reasoning?.cacheReason ?? "");
    check("routed: a bare wake-up after a sleep-only turn uses the slim packet — still T2, one message, smaller than the full packet of the same state, no cache write without evidenced reuse",
      Boolean(slimRow) && slimRow!.tier === "T2" && slimRow!.task_class === "agent_step" && Number(slimRow!.packet_bytes) > 0 && Boolean(lastFull)
        && Number(slimRow!.packet_bytes) < Number(lastFull!.packet_bytes)
        && (slimRow!.cache_policy === "off" ? Number(slimRow!.cache_write_tokens) === 0 : /within the cache lifetime/.test(why)),
      slimRow ? `slim packet ${slimRow.packet_bytes} B vs the previous full packet ${lastFull?.packet_bytes ?? "?"} B; cache ${slimRow.cache_policy} (${why}); cost ${slimRow.cost_microcents} µ¢` : "no slim wake-up observed");
    const booksEnd = await booksOk();
    const sumCost = routed.reduce((n, r) => n + Number(r.cost_microcents), 0);
    check("routed: memory and ledger continuity — pre-upgrade facts, goals and notes are still the founder's; every call is charged once to the same books",
      kept() && Boolean(facts()[REHEARSAL_TRIAGE_FACT]) && booksEnd.ok && same(await identityOf(), id0) && sumCost > 0,
      `fact "area" = ${facts().area}; ${goals().length} goal(s); cash ${booksEnd.cash} = ${alloc} − ${booksEnd.charged}; routed provider cost ${sumCost} µ¢; ledger verifies`);
    const secrets = [JSON.parse(fs.readFileSync(path.join(o.host.stateDir(a), FOUNDER_CREDENTIAL_FILE), "utf8")).token as string, FAKE_KEY];
    const hay = [await o.host.logText(a), JSON.stringify(audit), JSON.stringify(report.receipts), JSON.stringify((await owner.query(`SELECT before, after, rollback FROM fleet_founder_runtime_upgrades`)).rows)].join("\n");
    check("no credential in logs, audit, receipts or upgrade records", secrets.every((s) => !hay.includes(s)), `${secrets.length} secrets checked`);
    const snap = snapshotFounderState(o.host.stateDir(a));
    check("the founder's state is owned by exactly its own identity", snap.ownerUids.length === 1, `uid ${snap.ownerUids.join("/")}`);
  } catch (err) {
    check("upgrade rehearsal completed", false, err instanceof Error ? err.message : String(err));
  } finally {
    if (id) {
      await store.markDead(id, "rehearsal teardown", "rehearsal", "reported").catch(() => undefined);
      await o.host.remove(id).catch(() => undefined);
      check("clean teardown", !fs.existsSync(o.host.stateDir(id)), "founder runtime and state removed");
    }
    await (service as FleetService | null)?.close().catch(() => undefined);
    await fake.close().catch(() => undefined);
    await genesis.close();
    await ledger.close();
    await gw.close();
    await svcStore.close();
    await store.close();
    await owner.end();
  }
  report.pass = checks.every((c) => c.ok);
  return report;
}
