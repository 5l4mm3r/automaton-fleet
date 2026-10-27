/**
 * v122 founder recovery with REAL founder processes on the runtimes production's founders run (Agent-1 7c194b8, Agent-2
 * b60e262), each a SYNTHETIC Genesis founder with synthetic credentials on a throwaway registry; the controller is this tree
 * (v122). No provider (cognition disabled; the founder is paused), no production credential, nothing external.
 *  1. marked unresponsive while it runs (what the reaper did after the outage) → its own heartbeat restores it to active
 *     (before v122 that heartbeat was refused and the process exited);
 *  2. a controller outage longer than the heartbeat timeout → the founder rides it out; same process, still active;
 *  3. death (process stopped; the reaper's health timeout) → the owner's reinstatement → the SAME founder restarted on the same
 *     runtime: heartbeat → challenge → active, under the verification hold; same identity, credential, accounts and files.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { PgFleetStore } from "../../fleet/postgres/store.js";
import { PgAgentGateway } from "../../fleet/postgres/agent-gateway.js";
import { PgLedgerAdmin } from "../../fleet/treasury/ledger.js";
import { GENESIS_FOUNDERS, PgGenesisAdmin } from "../../fleet/genesis/admin.js";
import { FleetService } from "../../fleet/service/server.js";
import { UnsupportedSandboxTerminator } from "../../fleet/service/terminator.js";
import { computeBuildIdentity } from "../../fleet/attestation.js";
import { treeIdentity } from "../../fleet/runtime-verify.js";
import { ProcessFounderHost } from "../../fleet/founder/host.js";
import { FounderProvisioner } from "../../fleet/founder/provisioner.js";
import { FOUNDER_CREDENTIAL_FILE, FOUNDER_IDENTITY_FILE, type FounderIdentityFile } from "../../fleet/founder/evidence.js";
import type { RuntimeRelease } from "../../fleet/runtime.js";
import { findPgBin, startEphemeralPg } from "./fixtures/ephemeral-pg.js";

const PG_BIN = findPgBin();
const OWNER = "operator:rehearsal";
const REPO_URL = "https://github.com/5l4mm3r/automaton-fleet.git";
const repoDir = process.cwd();
const RUNTIMES: Array<[string, string]> = [
  ["Agent-1's runtime", "7c194b8c2348baa8fa5d34bd7ef6b201dc4911c2"],
  ["Agent-2's runtime", "b60e262bf7393e0ea2cca3b491199987f830cb3b"],
];
const have = (c: string) => { try { execSync(`git -C ${JSON.stringify(repoDir)} cat-file -e ${c}^{commit}`, { stdio: "ignore" }); return true; } catch { return false; } };
const sha = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms: number, step = 250): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => null); if (v) return v as T; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, step)); }
}

for (const [label, commit] of RUNTIMES) {
  describe.skipIf(!PG_BIN || !have(commit))(`v122 recovery with a real founder process on ${label} (${commit.slice(0, 7)})`, { timeout: 600_000 }, () => {
    let root = "";
    let releases = "";
    let release: RuntimeRelease;
    let controllerRelease: RuntimeRelease;

    beforeAll(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "v122-real-"));
      releases = path.join(root, "releases");
      fs.mkdirSync(releases);
      const dir = path.join(releases, commit);
      fs.mkdirSync(dir);
      execSync(`git -C ${JSON.stringify(repoDir)} archive ${commit} | tar -x -C ${JSON.stringify(dir)}`, { stdio: ["ignore", "ignore", "inherit"] });
      fs.mkdirSync(path.join(dir, "dist"));
      fs.writeFileSync(path.join(dir, "dist", "NOT-BUILT"), "test tree: run from src through tsx\n");
      fs.symlinkSync(path.join(repoDir, "node_modules"), path.join(dir, "node_modules"));
      const id = computeBuildIdentity(dir);
      release = { repo: REPO_URL, commit, buildId: id.buildId, lockfileSha256: id.lockfileSha256 };
      const ti = treeIdentity(repoDir);
      controllerRelease = { repo: REPO_URL, commit: ti.commit!, buildId: ti.buildId!, lockfileSha256: ti.lockfileSha256! };
    }, 180_000);
    afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

    it("unresponsive → recovers by its own heartbeat; rides out a controller outage; dies, is reinstated and passes a fresh challenge — paused throughout", async () => {
      const reg = await startEphemeralPg(PG_BIN!);
      const host = new ProcessFounderHost(fs.mkdtempSync(path.join(root, "h-")), {
        file: process.execPath, args: [], cwd: repoDir,
        env: { PATH: process.env.PATH, NODE_ENV: "test", FLEET_CAPABILITY_MANIFEST: "founder-v2", FLEET_FOUNDER_INTERVAL_MS: "1000", FLEET_TEST_UNREADABLE: "",
          FLEET_FOUNDER_AGENT_LOOP: "controller", FLEET_FOUNDER_THINK_EVERY: "2" },
      }, { dir: releases, pin: release, command: (d) => ({ file: process.execPath, args: ["--import", "tsx", path.join(d, "src/__tests__/fleet/fixtures/founder-child.ts")] }) });
      const store = new PgFleetStore({ connectionString: reg.ownerUrl });
      const svcStore = new PgFleetStore({ connectionString: reg.serviceUrl });
      const gw = new PgAgentGateway({ connectionString: reg.agentUrl });
      const ledger = new PgLedgerAdmin({ connectionString: reg.ownerUrl });
      const genesis = new PgGenesisAdmin({ connectionString: reg.ownerUrl });
      const owner = new pg.Pool({ connectionString: reg.ownerUrl, max: 2, options: "-c search_path=fleet" });
      const q = async (sql: string, p: unknown[] = []) => (await owner.query(sql, p)).rows;
      let service: FleetService | null = null;
      let port = 0;
      const startController = async () => {
        service = new FleetService({ admin: svcStore, agent: gw, realReplicationEnabled: false, reaperIntervalMs: 1_000, release: controllerRelease,
          terminator: new UnsupportedSandboxTerminator() });
        const l = await service.listen(port, "127.0.0.1");
        port = Number(new URL(l.url).port);
        service.startReaper();                                                                // as production's main.ts: the reaper runs (every 1 s here)
        return l.url;
      };
      let a = "";
      try {
        await store.migrate();
        await store.setMaxAgents(2, "rehearsal");
        await store.setLifecyclePolicy({ healthChallengeIntervalS: 2, challengeTtlS: 30, healthGraceS: 300, maxChallengeFailures: 3, terminationGraceS: 480 }, OWNER);
        await q(`UPDATE fleet_state SET heartbeat_unresponsive_s = 6`);                         // fast heartbeat loss (the test's founder beats every 1 s)
        await store.setApprovedRuntime({ repo: release.repo, commit: release.commit }, "rehearsal", { buildId: release.buildId, lockfileSha256: release.lockfileSha256 });
        await genesis.setEnabled(true, OWNER, "throwaway registry");
        const boot = await genesis.bootstrapCapital();
        const alloc = boot ? boot.minorUnits : 10_000;
        await ledger.recordOwnerFunding(alloc * 2, `rehearsal:synthetic-${crypto.randomUUID()}`, OWNER);
        const apiUrl = await startController();
        const g = boot
          ? await genesis.proposeCapital({ idempotencyKey: `v122:${crypto.randomUUID()}`, founderCount: GENESIS_FOUNDERS, ttlS: 3600, actor: OWNER })
          : await genesis.propose({ idempotencyKey: `v122:${crypto.randomUUID()}`, founderCount: GENESIS_FOUNDERS, allocationCents: alloc, ttlS: 3600, actor: OWNER });
        await genesis.approve(g.genesisId, g.authSha256, OWNER);
        const prov = new FounderProvisioner({ genesis, host, apiUrl, actor: OWNER, evidenceTimeoutMs: 90_000 });
        [a] = (await prov.provisionGenesis(g.genesisId)).founderIds ?? [];
        expect(a).toBeTruthy();
        expect((await prov.attestGenesis(g.genesisId)).ok).toBe(true);
        await genesis.fund(g.genesisId, OWNER);
        await prov.activateGenesis(g.genesisId, g.authSha256);
        const status = async () => (await q(`SELECT status FROM fleet_agents WHERE agent_id = $1`, [a]))[0].status as string;
        const rep = async () => (await host.readReport(a)) as Record<string, any> | null;
        const healthy = await waitFor(async () => { const r = await rep(); return r && r.mode === "active" && Number(r.heartbeats) >= 2 && Number(r.challengesPassed) >= 1 ? r : null; }, 90_000);
        expect(healthy, "the synthetic founder lives on the production runtime").not.toBeNull();
        expect(healthy!.commit).toBe(commit);
        await genesis.setFounderCognition(a, { enabled: true, paused: true, dailyBudgetCents: 754, maxTurnsPerHour: 120, reason: "paused throughout", actor: OWNER });
        const identityOf = async () => ({
          agent: (await q(`SELECT agent_id, origin, genesis_id, workspace_id, state_namespace, wallet_address, created_at FROM fleet_agents WHERE agent_id = $1`, [a]))[0],
          credential: (await q(`SELECT token_hash, created_at FROM fleet_agent_credentials WHERE agent_id = $1`, [a]))[0],
          accounts: await q(`SELECT account_id, class FROM fleet_ledger_accounts WHERE agent_id = $1 ORDER BY account_id`, [a]),
          identityFile: sha(path.join(host.stateDir(a), FOUNDER_IDENTITY_FILE)),
          credentialFile: sha(path.join(host.stateDir(a), FOUNDER_CREDENTIAL_FILE)),
        });
        const ident0 = await identityOf();
        const pid0 = await host.pid(a);

        // 1. Marked unresponsive while running (the outage's effect): its own heartbeat restores it (R1); same process.
        await q(`UPDATE fleet_agents SET status = 'unresponsive' WHERE agent_id = $1`, [a]);
        expect(await waitFor(async () => (await status()) === "active", 20_000)).toBe(true);
        expect(await host.pid(a)).toBe(pid0);

        // 2. A controller outage longer than the heartbeat timeout: the founder rides it out (R2); same process, active.
        await service!.close();
        await new Promise((r) => setTimeout(r, 9_000));
        await startController();
        await new Promise((r) => setTimeout(r, 6_000));
        expect(await status()).toBe("active");
        expect(await host.pid(a)).toBe(pid0);
        expect(Number((await q(`SELECT count(*) AS n FROM fleet_events WHERE event_type = 'reaper_resumed'`))[0].n)).toBeGreaterThanOrEqual(2);   // the restart was seen as a gap
        expect((await q(`SELECT reaper_last_run_at IS NOT NULL AS ran FROM fleet_state`))[0].ran).toBe(true);

        // 3. Death: the process stopped, the reaper's health timeout (the incident's cause), the estate settled.
        await host.stop(a);
        await q(`UPDATE fleet_agents SET status = 'unresponsive' WHERE agent_id = $1`, [a]);
        // (separately: the status change stamps unresponsive_since = now(); the incident's age is set after it)
        await q(`UPDATE fleet_agents SET unresponsive_since = now() - interval '9 minutes', last_challenge_ok_at = now() - interval '1 hour', challenge_failures = 3
                 WHERE agent_id = $1`, [a]);
        // The grace window restarted after the outage above (R2): the incident's death needs it in the past too.
        await q(`UPDATE fleet_state SET reaper_grace_from = now() - interval '1 hour'`);
        const died = await waitFor(async () => (await status()) === "dead", 20_000);
        if (!died) console.log("DIAG", JSON.stringify(await q(`SELECT status, sandbox_id, unresponsive_since, last_heartbeat, last_challenge_ok_at, challenge_failures, lifecycle_hold_until,
          (SELECT reaper_last_run_at FROM fleet_state) AS rl, (SELECT reaper_grace_from FROM fleet_state) AS rg, (SELECT termination_grace_s FROM fleet_state) AS tg, now() AS now
          FROM fleet_agents WHERE agent_id = $1`, [a])), JSON.stringify(await q(`SELECT event_type, created_at FROM fleet_events WHERE created_at > now() - interval '40 seconds' ORDER BY id DESC LIMIT 8`)));
        expect(died).toBe(true);
        await waitFor(async () => (await q(`SELECT status FROM fleet_estates WHERE agent_id = $1`, [a]))[0]?.status === "settled", 20_000);
        expect((await q(`SELECT detail ->> 'cause' AS c FROM fleet_events WHERE event_type = 'agent_died' AND agent_id = $1`, [a]))[0].c).toBe("health_timeout");
        //    The owner's reinstatement (hold 30 min), then the SAME founder restarted on the same runtime.
        const r = (await q(`SELECT fleet_admin_incident_reinstate('real-process rehearsal', ARRAY[$1]::text[], '{}'::uuid[], 30, $2) AS r`, [a, OWNER]))[0].r;
        expect(r.ok).toBe(true);
        await host.start(a);
        expect(await waitFor(async () => (await status()) === "active", 60_000), "heartbeat → challenge → active").toBe(true);
        const after = (await q(`SELECT lifecycle_hold_until, (SELECT outcome FROM fleet_health_challenges c WHERE c.agent_id = a.agent_id ORDER BY issued_at DESC LIMIT 1) AS last
                                FROM fleet_agents a WHERE agent_id = $1`, [a]))[0];
        expect(after.lifecycle_hold_until).toBeNull();                                        // the hold ended at active
        expect(after.last).toBe("passed");
        expect(await host.pid(a)).not.toBe(pid0);                                            // a new process …
        expect(await identityOf()).toEqual(ident0);                                          // … of the SAME founder
        const ws = JSON.parse(fs.readFileSync(path.join(host.stateDir(a), FOUNDER_IDENTITY_FILE), "utf8")) as FounderIdentityFile;
        expect(fs.existsSync(path.join(host.stateDir(a), "workspace", ws.workspaceId))).toBe(true);
        // Paused throughout: no model call was ever made; cognition still paused; the ledger verifies.
        expect(Number((await q(`SELECT count(*) AS n FROM fleet_cognition_log WHERE agent_id = $1`, [a]))[0].n)).toBe(0);
        expect((await q(`SELECT paused FROM fleet_founder_cognition WHERE agent_id = $1`, [a]))[0].paused).toBe(true);
        expect((await q(`SELECT fleet_ledger_verify() ->> 'ok' AS ok`))[0].ok).toBe("true");
      } finally {
        if (a) await host.stop(a).catch(() => undefined);
        await service?.close().catch(() => undefined);
        await owner.end(); await genesis.close(); await ledger.close(); await gw.close(); await svcStore.close(); await store.close();
        reg.stop();
      }
    });
  });
}
