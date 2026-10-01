/**
 * R23 — living-founder runtime upgrade lifecycle (schema v23).
 *
 *   unit        state snapshot / diff / backup (no content leaves, symlinks not followed, the credential never copied)
 *   PostgreSQL  the registry's own guarantees: only a living founder, only from its registered runtime to the approved
 *               one, one open attempt, no switch over changed state or moving books, verification from the registry's
 *               own heartbeat/challenge record, rollback restores the recorded runtime, append-only history, the
 *               founder's registry pin cannot move outside the lifecycle, build-checked challenges after an upgrade,
 *               tier cache policy data
 *   rehearsal   REAL founder processes: a synthetic founder created on the release Founder 1 is pinned to (eea1932,
 *               extracted from git), upgraded to this tree, rolled back, upgraded again, then routed through fake
 *               provider paths — identity, state and books preserved throughout
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, execSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { PgFleetStore, hashAgentToken, mintAgentToken, type CognitionRecord } from "../../fleet/postgres/store.js";
import { PgLedgerAdmin } from "../../fleet/treasury/ledger.js";
import { PgGenesisAdmin, type RuntimeReleaseRow } from "../../fleet/genesis/admin.js";
import { simulateRuntimeAttestation } from "../../fleet/genesis/simulate.js";
import { treeIdentity } from "../../fleet/runtime-verify.js";
import { computeBuildIdentity } from "../../fleet/attestation.js";
import { ProcessFounderHost } from "../../fleet/founder/host.js";
import { backupFounderState, categorize, diffFounderState, snapshotFounderState, summarizeSnapshot } from "../../fleet/founder/state-snapshot.js";
import { runUpgradeRehearsal } from "../../fleet/founder/upgrade-rehearsal.js";
import { findPgBin, startEphemeralPg, type EphemeralPg } from "./fixtures/ephemeral-pg.js";
import { wipeRegistry } from "./fixtures/wipe.js";

const PG_BIN = findPgBin();
const OWNER = "operator:owner";
const REPO_URL = "https://github.com/5l4mm3r/automaton-fleet";
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const NS = "st_01ABCDEFGHJKMNPQRSTVWXYZ01";
const WS = "ws_01ABCDEFGHJKMNPQRSTVWXYZ02";

function fakeState(): string {
  const d = tmp("f-state-");
  const w = (rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), body, { mode: 0o600 }); };
  w("founder.json", JSON.stringify({ v: 1, agentId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ" }));
  w("fleet-credentials.json", JSON.stringify({ agentId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ", token: "fa1.SECRET-TOKEN-VALUE" }));
  w("runtime-instance.json", "{\"pid\":1}");
  w("runtime-report.json", "{\"heartbeats\":1}");
  w(`state/${NS}/memory/facts.json`, JSON.stringify({ area: "pet grooming templates" }));
  w(`state/${NS}/memory/goals.json`, "[]");
  w(`state/${NS}/mind-history.json`, "[]");
  w(`state/${NS}/mind-log.jsonl`, "{}\n");
  w(`workspace/${WS}/notes/plan.md`, "# Plan\n");
  w(`workspace/${WS}/research/0123456789abcdef.txt`, "page");
  return d;
}

describe("founder state snapshot (unit)", () => {
  it("categorises every file, hashes durable state only, and never carries content", () => {
    const d = fakeState();
    expect(categorize("founder.json")).toBe("identity");
    expect(categorize("fleet-credentials.json")).toBe("credential");
    expect(categorize("runtime-report.json")).toBe("volatile");
    expect(categorize(`state/${NS}/memory/facts.json`)).toBe("memory");
    expect(categorize(`state/${NS}/mind-continuity.json`)).toBe("mind");
    expect(categorize(`state/${NS}/mind-history.json.tmp`)).toBe("volatile");
    expect(categorize(`workspace/${WS}/notes/plan.md`)).toBe("workspace");
    expect(categorize(".npmrc")).toBe("other");
    const a = snapshotFounderState(d);
    expect(a.categories).toMatchObject({ identity: { files: 1 }, credential: { files: 1 }, memory: { files: 2 }, mind: { files: 2 }, workspace: { files: 2 }, volatile: { files: 2 }, other: { files: 0 } });
    expect(a.entries.some((e) => e.category === "volatile")).toBe(false);
    expect(a.ownerUids).toEqual([process.getuid!()]);
    // Deterministic, and blind to volatile files and timestamps.
    fs.writeFileSync(path.join(d, "runtime-report.json"), "{\"heartbeats\":999}");
    fs.utimesSync(path.join(d, "founder.json"), new Date(), new Date(Date.now() + 5_000));
    expect(snapshotFounderState(d).stateSha256).toBe(a.stateSha256);
    // Nothing a snapshot or its summary holds is file content (in particular, never the credential).
    expect(JSON.stringify(a)).not.toMatch(/SECRET-TOKEN-VALUE|pet grooming/);
    expect(JSON.stringify(summarizeSnapshot(a))).not.toMatch(/SECRET-TOKEN-VALUE|facts\.json/);
    // Any durable change moves the hash.
    fs.appendFileSync(path.join(d, `state/${NS}/memory/facts.json`), " ");
    expect(snapshotFounderState(d).stateSha256).not.toBe(a.stateSha256);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it("diff reports lost, changed and added files; pruned research pages are not a durable loss, memory and notes are", () => {
    const d = fakeState();
    const a = snapshotFounderState(d);
    fs.writeFileSync(path.join(d, `state/${NS}/memory/goals.json`), "[{\"id\":\"g1\"}]");
    fs.writeFileSync(path.join(d, `workspace/${WS}/notes/new.md`), "n");
    fs.rmSync(path.join(d, `workspace/${WS}/research/0123456789abcdef.txt`));
    const x = diffFounderState(a, snapshotFounderState(d));
    expect(x).toMatchObject({ identical: false, durableLost: 0, identityChanged: false, credentialChanged: false });
    expect([x.lost.length, x.changed.length, x.added.length]).toEqual([1, 1, 1]);
    fs.rmSync(path.join(d, `workspace/${WS}/notes/plan.md`));
    fs.rmSync(path.join(d, `state/${NS}/memory/facts.json`));
    expect(diffFounderState(a, snapshotFounderState(d)).durableLost).toBe(2);
    fs.writeFileSync(path.join(d, "fleet-credentials.json"), "{}");
    fs.writeFileSync(path.join(d, "founder.json"), "{}");
    expect(diffFounderState(a, snapshotFounderState(d))).toMatchObject({ identityChanged: true, credentialChanged: true });
    fs.rmSync(d, { recursive: true, force: true });
  });

  it("symlinks are recorded, never followed; the backup proves each copy, excludes the credential and is never overwritten", () => {
    const d = fakeState();
    const outside = tmp("f-outside-");
    fs.writeFileSync(path.join(outside, "other-founder-secret"), "OTHER-IDENTITY-DATA");
    fs.symlinkSync(path.join(outside, "other-founder-secret"), path.join(d, `workspace/${WS}/notes/link`));
    fs.symlinkSync(outside, path.join(d, `workspace/${WS}/linked-dir`));
    const a = snapshotFounderState(d);
    expect(a.entries.filter((e) => e.kind === "symlink").map((e) => path.basename(e.path)).sort()).toEqual(["link", "linked-dir"]);
    expect(a.entries.some((e) => e.path.includes("other-founder-secret"))).toBe(false);
    const dest = path.join(tmp("f-backup-"), "u1");
    const b = backupFounderState(d, a, dest);
    expect(fs.existsSync(path.join(dest, "state", "founder.json"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "state", "fleet-credentials.json"))).toBe(false);
    expect(fs.readFileSync(path.join(dest, "state", `state/${NS}/memory/facts.json`), "utf8")).toContain("pet grooming");
    expect(fs.lstatSync(path.join(dest, "state", `workspace/${WS}/notes/link`)).isSymbolicLink()).toBe(true);
    expect(fs.statSync(dest).mode & 0o077).toBe(0);
    expect(JSON.stringify(JSON.parse(fs.readFileSync(b.manifest, "utf8")))).not.toMatch(/SECRET-TOKEN-VALUE|OTHER-IDENTITY-DATA/);
    expect(() => backupFounderState(d, a, dest)).toThrow(/EEXIST/);
    // A file that changed after the snapshot cannot be backed up as if it had not.
    fs.writeFileSync(path.join(d, `state/${NS}/memory/facts.json`), "{\"changed\":true}");
    expect(() => backupFounderState(d, a, path.join(path.dirname(dest), "u2"))).toThrow(/does not match the snapshot/);
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe.skipIf(!PG_BIN)("schema v23 runtime-upgrade registry guarantees (PostgreSQL)", () => {
  let pgc: EphemeralPg;
  let owner: pg.Pool;
  let svcRaw: pg.Pool;
  let store: PgFleetStore;
  let svc: PgFleetStore;
  let ledger: PgLedgerAdmin;
  let genesis: PgGenesisAdmin;
  const FROM: RuntimeReleaseRow = { repo: REPO_URL, commit: "c".repeat(40), buildId: "d".repeat(64), lockfileSha256: "e".repeat(64) };
  const TO: RuntimeReleaseRow = { repo: REPO_URL, commit: "a".repeat(40), buildId: "b".repeat(64), lockfileSha256: "e".repeat(64) };
  const q = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;
  const code = (p: Promise<unknown>) => p.then(() => "OK", (e: Error) => /FLEET_[A-Z_]+/.exec(e.message)?.[0] ?? e.message.slice(0, 80));
  const approve = (r: RuntimeReleaseRow) => store.setApprovedRuntime({ repo: r.repo, commit: r.commit }, "test", { buildId: r.buildId, lockfileSha256: r.lockfileSha256 });
  const before = (h = "1") => ({ stateSha256: h.repeat(64), identitySha256: "2".repeat(64), credentialSha256: "3".repeat(64), files: 9 });
  const after = (a: string, r: RuntimeReleaseRow, over: Record<string, unknown> = {}) => ({ agentId: a, commit: r.commit, buildId: r.buildId, lockfileSha256: r.lockfileSha256,
    identitySha256: "2".repeat(64), credentialSha256: "3".repeat(64), stateSha256AtStart: "1".repeat(64), durableLost: 0, ...over });
  /** A heartbeat and a health challenge answered as the founder's runtime would. */
  async function alive(a: string, r: RuntimeReleaseRow, buildId = r.buildId) {
    await svc.heartbeat(a);
    const c = await svc.issueChallenge(a);
    return c ? svc.answerChallenge(a, { challengeId: c.challengeId, nonce: c.nonce, commit: r.commit, buildId, policyOk: true }) : { ok: false, code: "NOT_ISSUED" };
  }

  async function setup(): Promise<string> {
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await wipeRegistry(c, "fleet");
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    await approve(FROM);
    await store.setMaxAgents(2, "test");
    await store.setLifecyclePolicy({ healthChallengeIntervalS: 3600, challengeTtlS: 30, healthGraceS: 300, maxChallengeFailures: 3, terminationGraceS: 480, orphanSlotHoldS: 259200, maxOpenOrphans: 1, sessionTtlS: 600 }, "test");
    await genesis.setEnabled(true, OWNER, "test");
    await ledger.recordOwnerFunding(20_000, `bank:${crypto.randomUUID()}`, OWNER);
    const g = await genesis.propose({ idempotencyKey: `g:${crypto.randomUUID()}`, founderCount: 1, allocationCents: 5_000, ttlS: 3600, actor: OWNER });
    await genesis.approve(g.genesisId, g.authSha256, OWNER);
    const p = await genesis.provision(g.genesisId, OWNER);
    const [a] = p.founderIds!;
    await genesis.attest(g.genesisId, a, (await simulateRuntimeAttestation(genesis, genesis, g.genesisId, a, OWNER)).host, OWNER);
    await genesis.fund(g.genesisId, OWNER);
    await genesis.activateWithHashes(g.genesisId, g.authSha256, [hashAgentToken(mintAgentToken(a))], OWNER);
    await alive(a, FROM);
    await approve(TO); // the controller has moved on; the founder has not
    return a;
  }

  beforeAll(async () => {
    pgc = await startEphemeralPg(PG_BIN!);
    owner = new pg.Pool({ connectionString: pgc.ownerUrl, max: 4 });
    svcRaw = new pg.Pool({ connectionString: pgc.serviceUrl, max: 2 });
    store = new PgFleetStore({ connectionString: pgc.ownerUrl });
    await store.migrate();
    svc = new PgFleetStore({ connectionString: pgc.serviceUrl });
    ledger = new PgLedgerAdmin({ connectionString: pgc.ownerUrl });
    genesis = new PgGenesisAdmin({ connectionString: pgc.ownerUrl });
  }, 180_000);

  afterAll(async () => {
    await genesis?.close();
    await ledger?.close();
    await svc?.close();
    await store?.close();
    await svcRaw?.end();
    await owner?.end();
    pgc?.stop();
  });

  it("migrates to v23 with a clean privilege audit; a founder's registered runtime is its Genesis attestation until an upgrade", async () => {
    const a = await setup();
    expect((await q(`SELECT max(version)::int AS v FROM fleet.fleet_schema_migrations`))[0].v).toBe(26);
    expect((await store.auditPrivileges()).problems).toEqual([]);
    expect(await genesis.founderRuntimeCurrent(a)).toMatchObject({ ...FROM, source: "genesis" });
    expect(await genesis.founderRuntimeCurrent("01ZZZZZZZZZZZZZZZZZZZZZZZZ")).toBeNull();
    const ctx = await genesis.founderRuntimeContext(a);
    expect(ctx).toMatchObject({ agent: { status: "active", origin: "genesis_founder", role: "root", runtimeCommit: FROM.commit }, approved: TO, inFlight: false, schemaVersion: 26 });
    // The lifecycle is owner-only: the service and agent roles can run none of it, nor read the history.
    for (const f of ["fleet_founder_runtime_upgrade_prepare($1, '{}', '{}', '{}', 'x')", "fleet_founder_runtime_current($1)", "fleet_founder_ledger_fingerprint($1)"]) {
      await expect(svcRaw.query(`SELECT fleet.${f}`, [a])).rejects.toThrow(/permission denied/);
    }
    await expect(svcRaw.query(`SELECT * FROM fleet.fleet_founder_runtime_upgrades`)).rejects.toThrow(/permission denied/);
  });

  it("prepare: only a living founder, only from its registered runtime, only to the approved runtime, with a snapshot, one attempt at a time, no inference in flight", async () => {
    const a = await setup();
    const prep = (from = FROM, to = TO, b: Record<string, unknown> = before(), agent = a) => code(genesis.founderRuntimeUpgradePrepare(agent, from, to, b, OWNER));
    expect(await prep(FROM, TO, before(), "01ZZZZZZZZZZZZZZZZZZZZZZZZ")).toBe("FLEET_BAD_REQUEST");
    expect(await prep({ ...FROM, buildId: "9".repeat(64) })).toBe("FLEET_RUNTIME_PIN_MISMATCH");
    expect(await prep({ ...FROM, commit: "9".repeat(40) })).toBe("FLEET_RUNTIME_PIN_MISMATCH");
    expect(await prep(FROM, { ...TO, buildId: "9".repeat(64) })).toBe("FLEET_RUNTIME_NOT_APPROVED");
    expect(await prep(FROM, { ...TO, commit: "9".repeat(40) })).toBe("FLEET_RUNTIME_NOT_APPROVED");
    expect(await prep(FROM, TO, { stateSha256: "zz" })).toBe("FLEET_BAD_REQUEST");
    await approve(FROM);
    expect(await prep(FROM, FROM)).toBe("FLEET_RUNTIME_UPGRADE_REFUSED"); // already on the approved runtime
    await approve(TO);
    await q(`INSERT INTO fleet.fleet_cognition_inflight (agent_id, request_id, estimate_cents) VALUES ($1, gen_random_uuid(), 1)`, [a]);
    expect(await prep()).toBe("FLEET_RUNTIME_UPGRADE_BUSY");
    await q(`DELETE FROM fleet.fleet_cognition_inflight WHERE agent_id = $1`, [a]);
    const u = await genesis.founderRuntimeUpgradePrepare(a, FROM, TO, before(), OWNER);
    expect(u).toMatchObject({ agentId: a, status: "prepared", from: FROM, to: TO, stateSha256Before: "1".repeat(64), preparedBy: OWNER });
    expect((u.ledgerBefore as { accounts: unknown[] }).accounts.length).toBeGreaterThan(0);
    expect(await prep()).toBe("FLEET_RUNTIME_UPGRADE_IN_PROGRESS");
    // Nothing is switched by prepare.
    expect((await q(`SELECT runtime_commit FROM fleet.fleet_agents WHERE agent_id = $1`, [a]))[0].runtime_commit).toBe(FROM.commit);
    expect(await genesis.founderRuntimeCurrent(a)).toMatchObject({ commit: FROM.commit, source: "genesis" });
    await genesis.founderRuntimeUpgradeAbort(u.upgradeId, "test abort", OWNER);
    expect((await genesis.founderRuntimeUpgrade(u.upgradeId))!.status).toBe("aborted");
    // A dead founder is never upgraded (a runtime upgrade does not resurrect or replace anyone).
    await store.markDead(a, "test", "test", "reported");
    expect(await prep()).toBe("FLEET_RUNTIME_UPGRADE_REFUSED");
  });

  it("commit is atomic and fail-closed: refused over changed state, moving books, a changed approval or a changed pin; then the registry pin moves once", async () => {
    const a = await setup();
    const u = await genesis.founderRuntimeUpgradePrepare(a, FROM, TO, before(), OWNER);
    const commit = (h = "1".repeat(64)) => code(genesis.founderRuntimeUpgradeCommit(u.upgradeId, h, OWNER));
    expect(await commit("4".repeat(64))).toBe("FLEET_RUNTIME_STATE_MISMATCH");
    // The books moved while the founder was "stopped" (an inference charge): refused.
    await q(`UPDATE fleet.fleet_cognition_accrual SET unposted_microcents = unposted_microcents + 5 WHERE agent_id = $1`, [a]);
    await q(`INSERT INTO fleet.fleet_cognition_accrual (agent_id, unposted_microcents) VALUES ($1, 5) ON CONFLICT (agent_id) DO NOTHING`, [a]);
    expect(await commit()).toBe("FLEET_RUNTIME_STATE_MISMATCH");
    await q(`UPDATE fleet.fleet_cognition_accrual SET unposted_microcents = 0 WHERE agent_id = $1`, [a]);
    await approve({ ...TO, buildId: "9".repeat(64) });
    expect(await commit()).toBe("FLEET_RUNTIME_NOT_APPROVED");
    await approve(TO);
    expect((await q(`SELECT runtime_commit FROM fleet.fleet_agents WHERE agent_id = $1`, [a]))[0].runtime_commit).toBe(FROM.commit);
    const c = await genesis.founderRuntimeUpgradeCommit(u.upgradeId, "1".repeat(64), OWNER);
    expect(c.status).toBe("committed");
    expect((await q(`SELECT runtime_commit, runtime_repo, status, challenge_requested_at IS NOT NULL AS challenged FROM fleet.fleet_agents WHERE agent_id = $1`, [a]))[0])
      .toEqual({ runtime_commit: TO.commit, runtime_repo: TO.repo, status: "active", challenged: true });
    expect(await genesis.founderRuntimeCurrent(a)).toMatchObject({ ...TO, source: "upgrade", upgradeId: u.upgradeId });
    expect(await commit()).toBe("FLEET_RUNTIME_UPGRADE_REFUSED"); // once
    expect(await code(genesis.founderRuntimeUpgradeAbort(u.upgradeId, "too late", OWNER))).toBe("FLEET_RUNTIME_UPGRADE_REFUSED");
    // The same founder row: nothing about its identity changed, no agent was created.
    expect((await q(`SELECT count(*)::int AS n FROM fleet.fleet_agents`))[0].n).toBe(1);
  });

  it("verify is decided from the registry's own record: heartbeat and a passed challenge since the switch, target build observed, identity and ledger accounts unchanged", async () => {
    const a = await setup();
    const u = await genesis.founderRuntimeUpgradePrepare(a, FROM, TO, before(), OWNER);
    await genesis.founderRuntimeUpgradeCommit(u.upgradeId, "1".repeat(64), OWNER);
    const verify = (x: Record<string, unknown>) => genesis.founderRuntimeUpgradeVerify(u.upgradeId, x, OWNER).then(() => "OK", (e: Error) => e.message.replace(/^.*FLEET_RUNTIME_VERIFY_FAILED: /, ""));
    // The caller's claims alone are not enough: the registry has seen no heartbeat since the switch.
    expect(await verify(after(a, TO))).toBe("no heartbeat since the switch");
    await svc.heartbeat(a);
    expect(await verify(after(a, TO))).toBe("no health challenge passed since the switch");
    // The old runtime answering (wrong commit) fails the challenge; verification then refuses for good reason.
    const c1 = await svc.issueChallenge(a);
    expect(await svc.answerChallenge(a, { challengeId: c1!.challengeId, nonce: c1!.nonce, commit: FROM.commit, buildId: FROM.buildId, policyOk: true })).toMatchObject({ ok: false, reason: "runtime commit mismatch" });
    expect(await verify(after(a, TO))).toBe("a health challenge failed since the switch");
    // A rollback is still possible from here (tested below); take a fresh founder for the passing path.
    const b = await setup();
    const v = await genesis.founderRuntimeUpgradePrepare(b, FROM, TO, before(), OWNER);
    await genesis.founderRuntimeUpgradeCommit(v.upgradeId, "1".repeat(64), OWNER);
    // After an upgrade the health challenge also checks the BUILD: the right commit with a foreign build fails.
    const wrongBuild = await alive(b, TO, "9".repeat(64));
    expect(wrongBuild).toMatchObject({ ok: false, reason: "runtime build mismatch" });
    await q(`UPDATE fleet.fleet_health_challenges SET issued_at = issued_at - interval '1 hour' WHERE agent_id = $1`, [b]); // (before the switch, for this test)
    await q(`UPDATE fleet.fleet_agents SET challenge_failures = 0, challenge_requested_at = now() WHERE agent_id = $1`, [b]);
    expect(await alive(b, TO)).toMatchObject({ ok: true });
    const verifyB = (x: Record<string, unknown>) => genesis.founderRuntimeUpgradeVerify(v.upgradeId, x, OWNER).then(() => "OK", (e: Error) => e.message.replace(/^.*FLEET_RUNTIME_VERIFY_FAILED: /, ""));
    expect(await verifyB(after("01ZZZZZZZZZZZZZZZZZZZZZZZZ", TO))).toBe("observed process belongs to another founder");
    expect(await verifyB(after(b, FROM))).toBe("observed runtime commit differs from the target");
    expect(await verifyB(after(b, TO, { buildId: "9".repeat(64) }))).toBe("observed runtime build differs from the target");
    expect(await verifyB(after(b, TO, { identitySha256: "9".repeat(64) }))).toBe("founder identity file changed");
    expect(await verifyB(after(b, TO, { credentialSha256: "9".repeat(64) }))).toBe("founder credential changed");
    expect(await verifyB(after(b, TO, { stateSha256AtStart: "9".repeat(64) }))).toBe("founder state was not identical when the new runtime started");
    expect(await verifyB(after(b, TO, { durableLost: 2 }))).toBe("memory or workspace files were lost");
    expect(await verifyB(after(b, TO))).toBe("OK");
    const rec = (await genesis.founderRuntimeUpgrade(v.upgradeId))!;
    expect(rec.status).toBe("verified");
    expect(rec.after).toMatchObject({ commit: TO.commit, health: { status: "active", heartbeatAfter: true, challengesFailed: 0 }, ledger: { accounts: expect.any(Array) } });
    expect(Number((rec.after!.health as { challengesPassed: number }).challengesPassed)).toBeGreaterThanOrEqual(1);
    expect(await verifyB(after(b, TO))).toMatch(/FLEET_RUNTIME_UPGRADE_REFUSED/);
  });

  it("rollback restores the runtime recorded at prepare (never caller input), for a committed or a verified upgrade; its health is recorded once", async () => {
    const a = await setup();
    const u = await genesis.founderRuntimeUpgradePrepare(a, FROM, TO, before(), OWNER);
    expect(await code(genesis.founderRuntimeUpgradeRollback(u.upgradeId, "too early", OWNER))).toBe("FLEET_RUNTIME_UPGRADE_REFUSED"); // nothing switched yet
    await genesis.founderRuntimeUpgradeCommit(u.upgradeId, "1".repeat(64), OWNER);
    await alive(a, TO);
    await genesis.founderRuntimeUpgradeVerify(u.upgradeId, after(a, TO), OWNER);
    const r = await genesis.founderRuntimeUpgradeRollback(u.upgradeId, "test: roll a verified upgrade back", OWNER);
    expect(r).toMatchObject({ status: "rolled_back", reason: "test: roll a verified upgrade back", closedBy: OWNER });
    expect((await q(`SELECT runtime_commit FROM fleet.fleet_agents WHERE agent_id = $1`, [a]))[0].runtime_commit).toBe(FROM.commit);
    expect(await genesis.founderRuntimeCurrent(a)).toMatchObject({ ...FROM, source: "genesis" });
    expect(await code(genesis.founderRuntimeUpgradeRollback(u.upgradeId, "again", OWNER))).toBe("FLEET_RUNTIME_UPGRADE_REFUSED");
    const rv = (x: Record<string, unknown>) => genesis.founderRuntimeUpgradeRollbackVerify(u.upgradeId, x, OWNER).then(() => "OK", (e: Error) => e.message.replace(/^.*FLEET_RUNTIME_(VERIFY_FAILED|UPGRADE_REFUSED): /, ""));
    expect(await rv(after(a, FROM))).toBe("no heartbeat since the rollback");
    expect(await rv(after(a, TO))).toBe("observed runtime is not the restored runtime");
    expect(await alive(a, FROM)).toMatchObject({ ok: true }); // back on a Genesis-state runtime: commit-checked as attested
    expect(await rv(after(a, FROM))).toBe("OK");
    expect(await rv(after(a, FROM))).toMatch(/no unverified rollback/);
    // The founder can be upgraded again; a later attempt must be rolled back before an earlier one could be.
    const u2 = await genesis.founderRuntimeUpgradePrepare(a, FROM, TO, before(), OWNER);
    await genesis.founderRuntimeUpgradeCommit(u2.upgradeId, "1".repeat(64), OWNER);
    expect((await genesis.founderRuntimeUpgrades(a)).map((x) => x.status)).toEqual(["committed", "rolled_back"]);
    const events = (await q(`SELECT event_type FROM fleet.fleet_events WHERE agent_id = $1 AND event_type LIKE 'founder_runtime_%' ORDER BY id`, [a])).map((e) => e.event_type);
    expect(events).toEqual(["founder_runtime_upgrade_prepared", "founder_runtime_upgrade_committed", "founder_runtime_upgrade_verified", "founder_runtime_upgrade_rolled_back",
      "founder_runtime_rollback_verified", "founder_runtime_upgrade_prepared", "founder_runtime_upgrade_committed"]);
  });

  it("the history is append-only and the founder's registry pin cannot move outside the lifecycle (even for the owner)", async () => {
    const a = await setup();
    const u = await genesis.founderRuntimeUpgradePrepare(a, FROM, TO, before(), OWNER);
    const e = (sql: string, p: unknown[] = []) => code(owner.query(sql, p));
    expect(await e(`UPDATE fleet.fleet_agents SET runtime_commit = $2 WHERE agent_id = $1`, [a, TO.commit])).toBe("FLEET_RUNTIME_UPGRADE_REQUIRED");
    expect(await e(`UPDATE fleet.fleet_agents SET runtime_repo = 'https://github.com/evil/fork' WHERE agent_id = $1`, [a])).toBe("FLEET_RUNTIME_UPGRADE_REQUIRED");
    expect(await e(`UPDATE fleet.fleet_founder_runtime_upgrades SET status = 'verified' WHERE upgrade_id = $1`, [u.upgradeId])).toBe("FLEET_RUNTIME_UPGRADE_REQUIRED");
    expect(await e(`DELETE FROM fleet.fleet_founder_runtime_upgrades WHERE upgrade_id = $1`, [u.upgradeId])).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await e(`TRUNCATE fleet.fleet_founder_runtime_upgrades`)).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await e(`INSERT INTO fleet.fleet_founder_runtime_upgrades (upgrade_id, agent_id, from_repo, from_commit, from_build_id, from_lockfile_sha256, to_repo, to_commit, to_build_id, to_lockfile_sha256,
        state_sha256_before, ledger_before, before, prepared_by) VALUES (gen_random_uuid(), $1, 'r', $2, $3, $3, 'r', $4, $3, $3, $3, '{}', '{}', 'operator:x')`, [a, "c".repeat(40), "d".repeat(64), "a".repeat(40)]))
      .toBe("FLEET_RUNTIME_UPGRADE_REQUIRED");
    // Inside the guard (as the functions run), the record itself still refuses rewrites and illegal transitions.
    const guarded = async (sql: string) => {
      const c = await owner.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SELECT set_config('fleet.runtime_upgrade_op', $1, true)`, [u.upgradeId]);
        return await c.query(sql, [u.upgradeId]).then(() => "OK", (x: Error) => /FLEET_[A-Z_]+/.exec(x.message)?.[0] ?? x.message);
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    };
    expect(await guarded(`UPDATE fleet.fleet_founder_runtime_upgrades SET to_commit = repeat('f', 40) WHERE upgrade_id = $1`)).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await guarded(`UPDATE fleet.fleet_founder_runtime_upgrades SET state_sha256_before = repeat('f', 64) WHERE upgrade_id = $1`)).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await guarded(`UPDATE fleet.fleet_founder_runtime_upgrades SET status = 'verified' WHERE upgrade_id = $1`)).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await guarded(`UPDATE fleet.fleet_founder_runtime_upgrades SET status = 'rolled_back' WHERE upgrade_id = $1`)).toBe("FLEET_HISTORY_IMMUTABLE");
    // Everything else about a founder row stays as mutable as before (heartbeats, status reasons…).
    expect(await e(`UPDATE fleet.fleet_agents SET last_heartbeat = now() WHERE agent_id = $1`, [a])).toBe("OK");
  });

  it("tier cache policy is data: T1 is constrained off, T2/T3 default to prefix, the routing state carries it, and each routed call records policy and saving", async () => {
    const a = await setup();
    const tiers = () => q(`SELECT tier, prompt_cache FROM fleet.fleet_cognition_tiers ORDER BY tier`);
    expect(await tiers()).toEqual([{ tier: "T1", prompt_cache: "off" }, { tier: "T2", prompt_cache: "prefix" }, { tier: "T3", prompt_cache: "prefix" }]);
    expect(await code(genesis.cognitionTierCacheSet("T1", "prefix", OWNER))).toBe("FLEET_BAD_REQUEST");
    await expect(owner.query(`UPDATE fleet.fleet_cognition_tiers SET prompt_cache = 'prefix' WHERE tier = 'T1'`)).rejects.toThrow(/fleet_cognition_tiers_t1_no_cache/);
    expect(await code(genesis.cognitionTierCacheSet("T2", "sometimes", OWNER))).toBe("FLEET_BAD_REQUEST");
    expect(await genesis.cognitionTierCacheSet("T3", "off", OWNER)).toMatchObject({ tier: "T3", prompt_cache: "off", enabled: false });
    await genesis.cognitionTierCacheSet("T3", "prefix", OWNER);
    await expect(svcRaw.query(`SELECT fleet.fleet_cognition_tier_cache_set('T2', 'off', 'x')`)).rejects.toThrow(/permission denied/);
    // Routed calls: policy + saving (+) / premium (−) at the snapshot prices.
    await q(`INSERT INTO fleet.fleet_provider_credit_events (provider, kind, usd_microcents, external_ref, recorded_by)
      SELECT 'anthropic', 'adjustment', 10000::bigint * 1000000 - fleet.fleet_provider_credit_balance('anthropic'), 'test: exact credit', 'operator:test'`);
    await genesis.setCognitionPolicy({ enabled: true, provider: "anthropic", model: "claude-opus-5-5", maxOutputTokens: 4_000, actor: OWNER, inputMicrocents: 400, outputMicrocents: 2_000, cacheWriteMicrocents: 500, cacheReadMicrocents: 20 });
    await genesis.setFounderCognition(a, { enabled: true, maxTurnsPerHour: 3_600, dailyBudgetCents: 10_000, reason: "t", actor: OWNER });
    for (const [t, m] of [["T1", "claude-haiku-4-5-20251001"], ["T2", "claude-sonnet-5-5"], ["T3", "claude-opus-5-5"]]) {
      await genesis.cognitionTierVerify(t, m, "test: models api 200", OWNER);
      await genesis.cognitionTierEnable(t, true, OWNER);
    }
    await genesis.cognitionRoutingSet(true, 2_000, OWNER);
    await genesis.founderRoutingSet(a, true, OWNER);
    const st0 = (await svc.cognitionRoutingState(a))!;
    expect((st0.tiers as Array<{ tier: string; promptCache: string }>).map((t) => [t.tier, t.promptCache])).toEqual([["T1", "off"], ["T2", "prefix"], ["T3", "prefix"]]);
    expect(st0).toMatchObject({ lastModel: null, lastAgeS: null, conversationModel: null });
    const rec = (o: Partial<CognitionRecord> = {}): CognitionRecord => ({ outcome: "ok", inputTokens: 100, outputTokens: 20, promptSha256: crypto.randomBytes(32).toString("hex"), responseSha256: "b".repeat(64),
      toolCalls: [], errorCode: null, usageSource: "provider", attempts: 1, ...o });
    const call = async (tier: string, model: string, scope: string, r: Partial<CognitionRecord>, obs: Record<string, unknown>) => {
      const route = { tier, provider: "anthropic", model, taskClass: tier === "T1" ? "extraction" : "agent_step", source: "class_minimum", scope, minTier: tier, maxTier: "T3", thinking: null, effort: null };
      const auth = await svc.cognitionRoutedAuthorize(a, 50, route, crypto.randomBytes(32).toString("hex"));
      expect(auth.ok).toBe(true);
      return svc.cognitionRoutedRecord(a, String(auth.requestId), rec(r), obs);
    };
    const w = await call("T2", "claude-sonnet-5-5", "task_step", { cacheWriteTokens: 3_574 }, { promptCache: "prefix", cacheReason: "T2 stable prefix: reuse expected" });
    expect(w).toMatchObject({ ok: true, cacheSavingMicrocents: -3_574 * (250 - 200) }); // the write premium
    const r = await call("T2", "claude-sonnet-5-5", "task_step", { cacheReadTokens: 3_574 }, { promptCache: "prefix", cacheReason: "T2 stable prefix: reuse expected" });
    expect(r).toMatchObject({ ok: true, cacheSavingMicrocents: 3_574 * (200 - 20) });
    await call("T1", "claude-haiku-4-5-20251001", "task_step", {}, { promptCache: "off", cacheReason: "T1 routine: compact, never padded" });
    await call("T3", "claude-opus-5-5", "question", {}, { promptCache: "off", cacheReason: "one-off escalation: no write premium" });
    const rows = await q(`SELECT tier, cache_policy, cache_saving_microcents::int AS s, reasoning ->> 'cacheReason' AS why, router_decision ->> 'scope' AS scope FROM fleet.fleet_cognition_log WHERE agent_id = $1 ORDER BY seq`, [a]);
    expect(rows).toEqual([
      { tier: "T2", cache_policy: "prefix", s: -178_700, why: "T2 stable prefix: reuse expected", scope: "task_step" },
      { tier: "T2", cache_policy: "prefix", s: 643_320, why: "T2 stable prefix: reuse expected", scope: "task_step" },
      { tier: "T1", cache_policy: "off", s: 0, why: "T1 routine: compact, never padded", scope: "task_step" },
      { tier: "T3", cache_policy: "off", s: 0, why: "one-off escalation: no write premium", scope: "question" },
    ]);
    // Thinking stays with the conversation's model: the T1 chore and the T3 question after it do not change it.
    expect(await svc.cognitionRoutingState(a)).toMatchObject({ lastModel: "claude-opus-5-5", conversationModel: "claude-sonnet-5-5" });
    const report = (await genesis.cognitionReport(new Date(Date.now() - 3_600_000))) as { rows: Array<Record<string, unknown>> };
    const t2 = report.rows.find((x) => x.tier === "T2")!;
    expect(t2).toMatchObject({ calls: 2, cached_calls: 2, cache_saving_microcents: 643_320 - 178_700, cache_read_tokens: 3_574, cache_write_tokens: 3_574 });
    expect(report.rows.find((x) => x.tier === "T3")).toMatchObject({ cached_calls: 0, cache_saving_microcents: 0 });
    expect((await ledger.verify()).ok).toBe(true);
    expect((await store.auditPrivileges()).problems).toEqual([]);
  });
});

// ─────────────────────────────────────────────── real processes: eea1932 → this tree → back → again → routed

const repoDir = process.cwd();
/** The release Founder 1 is pinned to in production; extracted from git so the rehearsal runs its REAL runtime code. */
const PREVIOUS = (() => {
  try {
    return execFileSync("git", ["-C", repoDir, "rev-parse", "--verify", "--quiet", "eea1932^{commit}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
})();

describe.skipIf(!PG_BIN || !PREVIOUS)("runtime-upgrade rehearsal with real founder processes (previous release eea1932 → this tree)", () => {
  let root = "";
  let releases = "";
  let from: { repo: string; commit: string; buildId: string; lockfileSha256: string };
  let to: typeof from;

  beforeAll(() => {
    root = tmp("f-upgrade-");
    releases = path.join(root, "releases");
    fs.mkdirSync(releases);
    // Previous release: its committed tree, as an installed release (no .git; the directory name is its commit).
    const old = path.join(releases, PREVIOUS);
    fs.mkdirSync(old);
    execSync(`git -C ${JSON.stringify(repoDir)} archive ${PREVIOUS} | tar -x -C ${JSON.stringify(old)}`, { stdio: ["ignore", "ignore", "inherit"] });
    fs.mkdirSync(path.join(old, "dist"));
    fs.writeFileSync(path.join(old, "dist", "NOT-BUILT"), "test tree: run from src through tsx\n");
    fs.symlinkSync(path.join(repoDir, "node_modules"), path.join(old, "node_modules"));
    const oi = computeBuildIdentity(old);
    from = { repo: REPO_URL, commit: PREVIOUS, buildId: oi.buildId, lockfileSha256: oi.lockfileSha256 };
    // Target release: this working tree.
    const ti = treeIdentity(repoDir);
    if (!ti.commit || !ti.buildId) throw new Error(`cannot identify the test runtime tree: ${ti.error}`);
    to = { repo: REPO_URL, commit: ti.commit, buildId: ti.buildId, lockfileSha256: ti.lockfileSha256! };
    fs.symlinkSync(repoDir, path.join(releases, ti.commit));
  }, 120_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("the previous release really is older runtime code: no routed mode, no loop guard, no upgrade lifecycle", () => {
    const old = path.join(releases, PREVIOUS);
    expect(fs.existsSync(path.join(old, "src/fleet/founder/upgrade.ts"))).toBe(false);
    expect(fs.existsSync(path.join(old, "src/fleet/founder/loop-guard.ts"))).toBe(false);
    expect(fs.readFileSync(path.join(old, "src/fleet/founder/mind.ts"), "utf8")).not.toMatch(/routedTurn|TASK PACKET/);
    expect(from.commit).not.toBe(to.commit);
    expect(from.buildId).not.toBe(to.buildId);
    expect(from.lockfileSha256).toBe(to.lockfileSha256);
  });

  it("upgrade, rollback, re-upgrade and routed cognition preserve the same founder: identity, memory, workspace, books", async () => {
    const reg = await startEphemeralPg(PG_BIN!);
    const host = new ProcessFounderHost(fs.mkdtempSync(path.join(root, "h-")), {
      file: process.execPath, args: [], cwd: repoDir,
      env: { PATH: process.env.PATH, NODE_ENV: "test", FLEET_CAPABILITY_MANIFEST: "founder-v2", FLEET_FOUNDER_INTERVAL_MS: "1000", FLEET_TEST_UNREADABLE: "",
        FLEET_FOUNDER_AGENT_LOOP: "controller", FLEET_FOUNDER_THINK_EVERY: "2" },
    }, {
      dir: releases, pin: from,
      // Each release runs ITS OWN runtime code (the test entry only replaces the unreadable-secrets list).
      command: (dir) => ({ file: process.execPath, args: ["--import", "tsx", path.join(dir, "src/__tests__/fleet/fixtures/founder-child.ts")] }),
    });
    try {
      const r = await runUpgradeRehearsal({
        registry: { ownerUrl: reg.ownerUrl, serviceUrl: reg.serviceUrl, agentUrl: reg.agentUrl }, host, from, to, actor: OWNER,
        backupRoot: path.join(root, "backups"), pinEnvFile: (id) => host.pinEnvFile(id), timeoutMs: 90_000, healthTimeoutMs: 45_000, pollMs: 250,
      });
      expect(r.checks.filter((c) => !c.ok)).toEqual([]);
      expect(r.pass).toBe(true);
      expect(r.checks.map((c) => c.name)).toEqual(expect.arrayContaining([
        "a synthetic founder lives on the previous runtime (Genesis-attested, pinned, heartbeating, challenged)",
        "preflight changes nothing; an unapproved target build is refused; the registry pin cannot be moved outside the lifecycle",
        "a state change while the founder is stopped aborts the upgrade: nothing switched, the same founder back on its runtime",
        "a mis-pinned target runtime refuses to start (fail closed) and the lifecycle rolls back to the previous pinned runtime",
        "upgrade: it is the SAME founder — id, registry identity, Genesis, credential, ledger accounts and population unchanged; no founder created",
        "upgrade: state was byte-identical when the target runtime started; afterwards no memory or workspace file was lost",
        "rollback: the same founder is back on the previous pinned runtime, healthy, with nothing lost",
        "upgrade again after the rollback: verified, same founder",
        "routed: one question escalated as a Critical Decision Packet (reason code, parent call), then control returned to T2",
        "routed: consequential actions are linked to the cognition that produced them — a small spend at T2, a major spend only from a T3 step",
        "routed: cache only on evidenced reuse — T2 prefix written once inside the tool loop and read back; T1, the T3 question, the T3 action step and a turn's first step write nothing",
        "routed: a bare wake-up after a sleep-only turn uses the slim packet — still T2, one message, smaller than the full packet of the same state, no cache write without evidenced reuse",
        "routed: provider protocol holds through real founder loops — signed thinking never crosses a model boundary, nothing is edited mid-loop",
        "clean teardown",
      ]));
      // The receipts carry digests and counts only.
      expect(r.receipts.upgrade).toMatchObject({ outcome: "verified", from: { commit: from.commit }, to: { commit: to.commit } });
      expect(r.receipts.upgrade!.steps.map((s) => s.step)).toEqual(["preflight", "quiesce", "stop", "snapshot", "prepare", "backup", "recheck", "commit", "pin", "prestart", "start", "prove", "compare", "verify"]);
      expect(r.receipts.failedStart!.steps.filter((s) => !s.ok).map((s) => s.step)).toEqual(["prove"]);
      expect(r.receipts.failedStart!.steps.map((s) => s.step).slice(-6)).toEqual(["rollback:stop", "rollback:registry", "rollback:pin", "rollback:start", "rollback:prove", "rollback:verify"]);
      expect(r.routed.map((x) => x.tier)).toEqual(expect.arrayContaining(["T1", "T2", "T3"]));
    } finally {
      reg.stop();
    }
  }, 600_000);
});
