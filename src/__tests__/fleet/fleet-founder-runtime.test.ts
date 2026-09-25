/**
 * Phase F.1 — founder runtime provisioning and real-runtime attestation
 * (schema v12): real founder runtime processes (the production runtime code,
 * spawned by ProcessFounderHost), a real FleetService over HTTP and an
 * ephemeral PostgreSQL cluster with the real roles.
 *
 * Proves: two founder runtimes provision, attest (their own evidence + host
 * evidence of the same process), activate only through the owner gate, then
 * heartbeat, confirm their own manifest and read only their own ledger; every
 * attack in the F.1 list fails closed and any failure rolls the whole Genesis
 * back with the runtimes torn down.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { PgFleetStore, hashAgentToken, mintAgentToken } from "../../fleet/postgres/store.js";
import { PgAgentGateway } from "../../fleet/postgres/agent-gateway.js";
import { PgLedgerAdmin } from "../../fleet/treasury/ledger.js";
import { PgGenesisAdmin } from "../../fleet/genesis/admin.js";
import { FleetService } from "../../fleet/service/server.js";
import { UnsupportedSandboxTerminator } from "../../fleet/service/terminator.js";
import { treeIdentity } from "../../fleet/runtime-verify.js";
import { ProcessFounderHost } from "../../fleet/founder/host.js";
import { FounderProvisioner } from "../../fleet/founder/provisioner.js";
import { capabilitySelfTest, founderPreflight } from "../../fleet/founder/runtime.js";
import { FOUNDER_ATTEST_FILE, FOUNDER_CREDENTIAL_FILE, FOUNDER_IDENTITY_FILE, FOUNDER_REPORT_FILE } from "../../fleet/founder/evidence.js";
import { FOUNDER_MANIFEST_V1 } from "../../fleet/capabilities.js";
import { runFounderRehearsal } from "../../fleet/founder/rehearsal.js";
import { findPgBin, startEphemeralPg, type EphemeralPg } from "./fixtures/ephemeral-pg.js";
import { wipeRegistry } from "./fixtures/wipe.js";

const PG_BIN = findPgBin();
const OWNER = "operator:owner";
const REPO_URL = "https://github.com/5l4mm3r/automaton-fleet";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 30_000, step = 250): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error("timed out");
    await sleep(step);
  }
}

describe("founder runtime preflight (unit)", () => {
  it("refuses readable fleet secrets, a missing/unknown manifest, the agent loop, root, and privileged environment", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "founder-pre-"));
    const secret = path.join(tmp, "admin.env");
    fs.writeFileSync(secret, "x", { mode: 0o600 });
    const base = { FLEET_FOUNDER_ID: "01ZZZZZZZZZZZZZZZZZZZZZZZZ", FLEET_CAPABILITY_MANIFEST: "founder-v1", FLEET_FOUNDER_STATE_DIR: tmp, FLEET_RUNTIME_ENV_FILE: "/nonexistent" };
    const fail = (env: Record<string, string>, unreadable: string[] = [], uid = 1000) => {
      try {
        founderPreflight({ env: { ...base, ...env } as never, unreadable, uid });
        return "OK";
      } catch (err) {
        return (err as Error).message;
      }
    };
    expect(fail({}, [secret])).toMatch(/admin\.env is readable by this founder/);
    expect(fail({ FLEET_CAPABILITY_MANIFEST: "" })).toMatch(/not a compiled manifest/);
    expect(fail({ FLEET_CAPABILITY_MANIFEST: "founder-v2" })).toMatch(/not a compiled manifest/);
    expect(fail({ FLEET_FOUNDER_AGENT_LOOP: "enabled" })).toMatch(/only 'disabled' or 'controller'/);
    expect(fail({ FLEET_FOUNDER_AGENT_LOOP: "local" })).toMatch(/only 'disabled' or 'controller'/);
    expect(fail({ FLEET_FOUNDER_AGENT_LOOP: "controller" })).not.toMatch(/AGENT_LOOP|inference provider/);
    expect(fail({ FLEET_COGNITION_API_KEY_FILE: "/x" })).toMatch(/inference provider configuration/);
    expect(fail({ OPENAI_API_KEY: "sk-x" })).toMatch(/inference provider configuration/);
    expect(fail({ CONWAY_API_KEY: "x" })).toMatch(/CONWAY_API_KEY present/);
    expect(fail({ FLEET_ADMIN_DATABASE_URL: "postgresql://x" })).toMatch(/FLEET_ADMIN_DATABASE_URL present/);
    expect(fail({ REAL_PAYMENTS_ENABLED: "true" })).toMatch(/REAL_PAYMENTS_ENABLED=true/);
    expect(fail({}, [], 0)).toMatch(/running as root/);
    expect(fail({ FLEET_FOUNDER_ID: "not-a-ulid" })).toMatch(/FLEET_FOUNDER_ID/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("the capability self-test allows no non-grantable or unclassified tool under founder-v1", () => {
    const t = capabilitySelfTest(FOUNDER_MANIFEST_V1);
    expect(t).toMatchObject({ forbiddenAllowed: 0, unclassifiedDenied: true });
    expect(t.allowed + t.denied).toBe(t.tools);
    expect(t.denied).toBeGreaterThanOrEqual(27);
  });
});

describe.skipIf(!PG_BIN)("Phase F.1 founder runtimes (schema v12, real processes + HTTP + PostgreSQL)", () => {
  let pgc: EphemeralPg;
  let owner: pg.Pool;
  let agentRaw: pg.Pool;
  let store: PgFleetStore;
  let svcStore: PgFleetStore;
  let gw: PgAgentGateway;
  let ledger: PgLedgerAdmin;
  let genesis: PgGenesisAdmin;
  let service: FleetService;
  let apiUrl = "";
  let root = "";
  let runtimeEnvFile = "";
  let identity: ReturnType<typeof treeIdentity>;
  const audit: Array<Record<string, unknown>> = [];
  const hosts: ProcessFounderHost[] = [];

  const repoDir = process.cwd();
  const baseEnv = () => ({
    PATH: process.env.PATH,
    NODE_ENV: "test",
    FLEET_CAPABILITY_MANIFEST: "founder-v1",
    FLEET_RUNTIME_ENV_FILE: runtimeEnvFile,
    FLEET_FOUNDER_INTERVAL_MS: "1000",
    FLEET_TEST_UNREADABLE: "",
  });
  const newHost = (env: Record<string, string | undefined> = {}) => {
    const h = new ProcessFounderHost(fs.mkdtempSync(path.join(root, "h-")), {
      file: process.execPath,
      args: ["--import", "tsx", path.join(repoDir, "src/__tests__/fleet/fixtures/founder-child.ts")],
      cwd: repoDir,
      env: { ...baseEnv(), ...env },
    });
    hosts.push(h);
    return h;
  };
  const provisioner = (host: ProcessFounderHost, timeoutMs = 60_000) =>
    new FounderProvisioner({ genesis, host, apiUrl, actor: OWNER, evidenceTimeoutMs: timeoutMs, pollMs: 250 });
  const population = async () => (await owner.query(`SELECT living_agents + reserved_slots + quarantined_slots AS p FROM fleet.fleet_state`)).rows[0].p;
  const key = () => `rt:${crypto.randomBytes(9).toString("base64url")}`;

  async function reset(pins = { commit: identity.commit!, buildId: identity.buildId!, lockfileSha256: identity.lockfileSha256! }) {
    for (const h of hosts.splice(0)) for (const d of fs.readdirSync((h as unknown as { root: string }).root)) await h.remove(d).catch(() => undefined);
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await wipeRegistry(c, "fleet");
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    await store.setApprovedRuntime({ repo: REPO_URL, commit: pins.commit }, "test", { buildId: pins.buildId, lockfileSha256: pins.lockfileSha256 });
    await store.setMaxAgents(2, "test");
    await store.setLifecyclePolicy({ healthChallengeIntervalS: 2, challengeTtlS: 30, healthGraceS: 300, maxChallengeFailures: 3, terminationGraceS: 480, orphanSlotHoldS: 259200, maxOpenOrphans: 1, sessionTtlS: 600 }, "test");
    await genesis.setEnabled(true, OWNER, "test");
  }

  async function approved(n = 2, alloc = 2_500) {
    if (alloc) await ledger.recordOwnerFunding(alloc * n, `synthetic:${crypto.randomUUID()}`, OWNER);
    const g = await genesis.propose({ idempotencyKey: key(), founderCount: n, allocationCents: alloc, ttlS: 3600, actor: OWNER });
    await genesis.approve(g.genesisId, g.authSha256, OWNER);
    return g;
  }

  beforeAll(async () => {
    identity = treeIdentity(repoDir);
    if (!identity.commit || !identity.buildId) throw new Error(`cannot identify the test runtime tree: ${identity.error}`);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "founders-"));
    runtimeEnvFile = path.join(root, "runtime.env");
    fs.writeFileSync(runtimeEnvFile, [
      `FLEET_RUNTIME_REPO=${REPO_URL}`,
      `FLEET_RUNTIME_COMMIT=${identity.commit}`,
      `FLEET_RUNTIME_BUILD_ID=${identity.buildId}`,
      `FLEET_RUNTIME_LOCKFILE_SHA256=${identity.lockfileSha256}`,
      "REAL_PAYMENTS_ENABLED=false",
      "REAL_REPLICATION_ENABLED=false",
      "",
    ].join("\n"));
    pgc = await startEphemeralPg(PG_BIN!);
    owner = new pg.Pool({ connectionString: pgc.ownerUrl, max: 6 });
    agentRaw = new pg.Pool({ connectionString: pgc.agentUrl, max: 2 });
    store = new PgFleetStore({ connectionString: pgc.ownerUrl });
    await store.migrate();
    svcStore = new PgFleetStore({ connectionString: pgc.serviceUrl });
    gw = new PgAgentGateway({ connectionString: pgc.agentUrl });
    ledger = new PgLedgerAdmin({ connectionString: pgc.ownerUrl });
    genesis = new PgGenesisAdmin({ connectionString: pgc.ownerUrl });
    service = new FleetService({
      admin: svcStore,
      agent: gw,
      realReplicationEnabled: false,
      reaperIntervalMs: 0,
      release: { repo: REPO_URL, commit: identity.commit, buildId: identity.buildId, lockfileSha256: identity.lockfileSha256! },
      audit: (e) => audit.push(e as unknown as Record<string, unknown>),
      terminator: new UnsupportedSandboxTerminator(),
    });
    apiUrl = (await service.listen(0, "127.0.0.1")).url;
    await reset();
  }, 180_000);

  afterAll(async () => {
    for (const h of hosts) for (const d of fs.existsSync((h as unknown as { root: string }).root) ? fs.readdirSync((h as unknown as { root: string }).root) : []) await h.remove(d).catch(() => undefined);
    await service?.close();
    await genesis?.close();
    await ledger?.close();
    await gw?.close();
    await svcStore?.close();
    await store?.close();
    await agentRaw?.end();
    await owner?.end();
    pgc?.stop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("two founder runtimes provision, attest, activate through the owner gate, heartbeat, and see only themselves", async () => {
    const host = newHost();
    const prov = provisioner(host);
    const g = await approved();
    const pv = await prov.provisionGenesis(g.genesisId);
    const [a, b] = pv.founderIds!;
    // Before activation: no credential exists; the attestation token opens nothing but its own route.
    const attestA = JSON.parse(fs.readFileSync(path.join(host.stateDir(a), FOUNDER_ATTEST_FILE), "utf8"));
    const hb = await fetch(`${apiUrl}/v1/heartbeat`, { method: "POST", headers: { authorization: `FleetFounderAttest ${a}.${attestA.token}` } });
    expect(hb.status).toBe(401);
    const ses = await fetch(`${apiUrl}/v1/session`, { method: "POST", headers: { authorization: `Bearer ${attestA.token}` } });
    expect(ses.status).toBe(401);
    expect(await gw.ledgerSummary(a, mintAgentToken(a))).toMatchObject({ ok: false, code: "FLEET_AUTH_FAILED" });

    const at = await prov.attestGenesis(g.genesisId);
    expect(at, JSON.stringify(at)).toMatchObject({ ok: true, status: "funding_virtual" });
    for (const f of at.founders) {
      expect(f.host).toMatchObject({ commit: identity.commit, buildId: identity.buildId, manifestId: "founder-v1", envFounderId: f.agentId });
    }
    expect(new Set(at.founders.map((f) => f.host!.pid)).size).toBe(2);
    const rows = await owner.query(`SELECT agent_id, runtime_evidence, host_evidence, status FROM fleet.fleet_genesis_founders WHERE genesis_id = $1 ORDER BY ordinal`, [g.genesisId]);
    for (const r of rows.rows) {
      expect(r.status).toBe("attested");
      expect(r.runtime_evidence.instanceId).toBe(r.host_evidence.instanceId);
      expect(r.runtime_evidence.capabilitySelfTest).toMatchObject({ forbiddenAllowed: 0, unclassifiedDenied: true });
      expect(JSON.stringify(r.runtime_evidence)).not.toContain(attestA.token);
    }
    await genesis.fund(g.genesisId, OWNER);
    // Owner gate: refused while Genesis is disabled; nothing is delivered.
    await genesis.setEnabled(false, OWNER, "test");
    await expect(prov.activateGenesis(g.genesisId, g.authSha256)).rejects.toThrow(/FLEET_GENESIS_DISABLED/);
    expect(fs.existsSync(path.join(host.stateDir(a), FOUNDER_CREDENTIAL_FILE))).toBe(false);
    await genesis.setEnabled(true, OWNER, "test");
    await prov.activateGenesis(g.genesisId, g.authSha256);
    expect(fs.existsSync(path.join(host.stateDir(a), FOUNDER_ATTEST_FILE))).toBe(false);

    const reports = await Promise.all([a, b].map((id) => waitFor(async () => {
      const r = await host.readReport(id);
      return r && r.mode === "active" && Number(r.heartbeats) >= 3 ? r : null;
    }, 60_000)));
    for (const [i, r] of reports.entries()) {
      expect(r).toMatchObject({
        agentId: [a, b][i],
        capabilities: { matchesCompiled: true, reproductionExecutable: false, paymentExecutable: false },
        ledger: { cash: 2_500, genesisAllocation: 2_500, externalCustomerRevenue: 0, lifetimeContribution: 0 },
        agentLoop: "disabled",
      });
    }
    expect(await population()).toBe(2);
    const st = await owner.query(`SELECT agent_id, status, last_heartbeat FROM fleet.fleet_agents WHERE agent_id = ANY($1)`, [[a, b]]);
    expect(st.rows.every((x) => x.status === "active" && x.last_heartbeat)).toBe(true);
    // Isolation identity: distinct directories, instance ids, pids.
    const wa = fs.readdirSync(path.join(host.stateDir(a), "workspace"));
    const wb = fs.readdirSync(path.join(host.stateDir(b), "workspace"));
    expect(wa).toHaveLength(1);
    expect(wa[0]).not.toBe(wb[0]);
    // A's credential cannot act for B and vice versa (tokens are identity-bound).
    const credA = JSON.parse(fs.readFileSync(path.join(host.stateDir(a), FOUNDER_CREDENTIAL_FILE), "utf8"));
    const credB = JSON.parse(fs.readFileSync(path.join(host.stateDir(b), FOUNDER_CREDENTIAL_FILE), "utf8"));
    expect(await gw.ledgerSummary(b, credA.token)).toMatchObject({ ok: false, code: "FLEET_AUTH_FAILED" });
    expect(await gw.ledgerSummary(a, credB.token)).toMatchObject({ ok: false, code: "FLEET_AUTH_FAILED" });
    // Reproduction and payment execution remain unavailable to a living founder.
    const repl = await agentRaw.query(`SELECT fleet.api_request_replication($1, $2, 'kid', $3, NULL, NULL) AS r`, [a, credA.token, key()]).then((x) => x.rows[0].r, (e: Error) => ({ ok: false, code: /^(FLEET_[A-Z_]+)/.exec(e.message)?.[1] }));
    expect(repl.ok).toBe(false);
    expect(repl.code).toMatch(/^FLEET_/);
    // Even with every replication switch on, the founder origin guard refuses a child.
    await store.setOperatingMode("EXPANSION", "t", "t");
    await store.setReplicationEnabled(true, "t");
    await store.setMaxAgents(5, "t");
    await expect(agentRaw.query(`SELECT fleet.api_request_replication($1, $2, 'kid', $3, NULL, NULL)`, [a, credA.token, key()])).rejects.toThrow(/FLEET_REPRODUCTION_DISABLED/);
    await store.setReplicationEnabled(false, "t");
    await store.setOperatingMode("DEVELOPMENT", "t", "t");
    await store.setMaxAgents(2, "t");
    await expect(agentRaw.query(`SELECT fleet.cx_claim_instruction('w', repeat('a',64))`)).rejects.toThrow(/permission denied/);
    // No secret in process arguments, runtime logs, events or the controller audit.
    const secrets = [attestA.token, credA.token, credB.token];
    for (const id of [a, b]) {
      const pid = await host.pid(id);
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      for (const s of secrets) expect(cmdline).not.toContain(s);
      for (const s of secrets) expect(host.logs.get(id) ?? "").not.toContain(s);
    }
    const ev = (await owner.query(`SELECT detail::text AS d FROM fleet.fleet_events`)).rows.map((x) => x.d).join("\n");
    for (const s of secrets) expect(ev).not.toContain(s);
    for (const s of secrets) expect(JSON.stringify(audit)).not.toContain(s);
    // Economic death: authority ends immediately; the runtime stops with the controller's refusal.
    await store.markDead(a, "rehearsal teardown", "test", "reported");
    await waitFor(async () => host.exitCode(a) === 3, 30_000);
    await prov.teardown(g.genesisId);
    expect(fs.existsSync(host.stateDir(a))).toBe(false);
    await reset();
  }, 240_000);

  it("wrong runtime commit, build id or lockfile rolls the whole Genesis back and tears the runtimes down", async () => {
    for (const bad of [{ commit: "a".repeat(40) }, { buildId: "b".repeat(64) }, { lockfileSha256: "c".repeat(64) }]) {
      // The authorization pins a runtime that is NOT what the founder processes actually run.
      await reset({ commit: identity.commit!, buildId: identity.buildId!, lockfileSha256: identity.lockfileSha256!, ...bad });
      const host = newHost();
      const prov = provisioner(host);
      const g = await approved(2, 0);
      const pv = await prov.provisionGenesis(g.genesisId);
      // (the runtime's preflight compares its tree with the pinned runtime.env = the real tree, so it starts and reports honestly)
      const at = await prov.attestGenesis(g.genesisId);
      expect(at.ok, JSON.stringify(bad)).toBe(false);
      expect(at.status).toBe("rolled_back");
      expect(at.why).toMatch(/runtime commit differs|runtime build id differs|runtime lockfile differs/);
      for (const id of pv.founderIds!) expect(fs.existsSync(host.stateDir(id))).toBe(false);
      expect(await population()).toBe(0);
    }
    await reset();
  }, 240_000);

  it("a runtime whose installed tree differs from its pinned release refuses to start; the Genesis rolls back", async () => {
    const host = newHost({ FLEET_RUNTIME_ENV_FILE: "/nonexistent" });
    const prov = provisioner(host, 15_000);
    const g = await approved(2, 0);
    await prov.provisionGenesis(g.genesisId);
    const at = await prov.attestGenesis(g.genesisId);
    expect(at).toMatchObject({ ok: false, status: "rolled_back" });
    expect(await population()).toBe(0);
    await reset();
  }, 120_000);

  it("a runtime whose tree differs from its own pinned build refuses to start, even when the authorization matches the tree", async () => {
    const wrongEnv = path.join(root, "runtime-wrong.env");
    fs.writeFileSync(wrongEnv, fs.readFileSync(runtimeEnvFile, "utf8").replace(`FLEET_RUNTIME_BUILD_ID=${identity.buildId}`, `FLEET_RUNTIME_BUILD_ID=${"7".repeat(64)}`));
    const host = newHost({ FLEET_RUNTIME_ENV_FILE: wrongEnv });
    const prov = provisioner(host, 15_000);
    const g = await approved(2, 0);
    await prov.provisionGenesis(g.genesisId);
    const at = await prov.attestGenesis(g.genesisId);
    expect(at).toMatchObject({ ok: false, status: "rolled_back" });
    expect([...host.logs.values()].join("\n")).toMatch(/installed runtime build .* differs from the pinned/);
    await reset();
  }, 120_000);

  it("a founder lying about its own process in the instance marker is not attested", async () => {
    const host = newHost();
    const prov = provisioner(host);
    const g = await approved(1, 0);
    const pv = await prov.provisionGenesis(g.genesisId);
    const [a] = pv.founderIds!;
    await waitFor(async () => (await genesis.runtimeEvidence(g.genesisId, a)).evidence);
    const f = path.join(host.stateDir(a), "runtime-instance.json");
    const inst = JSON.parse(fs.readFileSync(f, "utf8"));
    fs.writeFileSync(f, JSON.stringify({ ...inst, pid: inst.pid + 1 }), { mode: 0o600 });
    const at = await prov.attestGenesis(g.genesisId);
    expect(at).toMatchObject({ ok: false, status: "rolled_back" });
    await reset();
  }, 120_000);

  it("missing, unknown or modified capability manifests fail closed", async () => {
    for (const [env, mutate] of [
      [{ FLEET_CAPABILITY_MANIFEST: "" }, null],
      [{ FLEET_CAPABILITY_MANIFEST: "founder-v9" }, null],
      [{}, (f: Record<string, unknown>) => ({ ...f, manifestSha256: "0".repeat(64) })], // modified after authorization
    ] as const) {
      const host = newHost(env as Record<string, string>);
      const prov = provisioner(host, 15_000);
      const g = await approved(2, 0);
      const pv = await genesis.provision(g.genesisId, OWNER);
      // Provision through the provisioner, optionally tampering with one founder's identity file before start.
      const origStart = host.start.bind(host);
      host.start = async (id: string) => {
        if (mutate && id === pv.founderIds![1]) {
          const f = path.join(host.stateDir(id), FOUNDER_IDENTITY_FILE);
          fs.writeFileSync(f, JSON.stringify(mutate(JSON.parse(fs.readFileSync(f, "utf8")))), { mode: 0o600 });
        }
        return origStart(id);
      };
      await prov.provisionGenesis(g.genesisId);
      const at = await prov.attestGenesis(g.genesisId);
      expect(at, JSON.stringify(env)).toMatchObject({ ok: false, status: "rolled_back" });
      await waitFor(async () => /not a compiled manifest|differs from the authorized digest|policy rule is not active/.test([...host.logs.values()].join("\n")), 10_000);
      await reset();
    }
  }, 240_000);

  it("swapped identity, another founder's credential and stale/replayed tokens are refused", async () => {
    const host = newHost();
    const prov = provisioner(host, 15_000);
    const g = await approved(2, 0);
    const pv = await genesis.provision(g.genesisId, OWNER);
    const [a, b] = pv.founderIds!;
    const origStart = host.start.bind(host);
    host.start = async (id: string) => {
      if (id === b) {
        // Founder B's state is handed founder A's identity file (a swapped identity).
        const fa = JSON.parse(fs.readFileSync(path.join(host.stateDir(a), FOUNDER_IDENTITY_FILE), "utf8"));
        fs.writeFileSync(path.join(host.stateDir(b), FOUNDER_IDENTITY_FILE), JSON.stringify(fa), { mode: 0o600 });
      }
      return origStart(id);
    };
    await prov.provisionGenesis(g.genesisId);
    const stale = JSON.parse(fs.readFileSync(path.join(host.stateDir(a), FOUNDER_ATTEST_FILE), "utf8"));
    const at = await prov.attestGenesis(g.genesisId);
    expect(at).toMatchObject({ ok: false, status: "rolled_back" });
    expect(host.logs.get(b)).toMatch(/names a different founder/);
    // The rolled-back Genesis's token is dead: replaying its evidence is refused.
    const replay = await fetch(`${apiUrl}/v1/genesis/runtime-evidence`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `FleetFounderAttest ${a}.${stale.token}` },
      body: JSON.stringify({ nonce: stale.nonce }),
    });
    expect(replay.status).toBe(409);
    expect((await replay.json()).code).toBe("FLEET_GENESIS_NOT_ATTESTING");
    const forged = await fetch(`${apiUrl}/v1/genesis/runtime-evidence`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `FleetFounderAttest ${a}.${crypto.randomBytes(32).toString("base64url")}` },
      body: "{}",
    });
    expect(forged.status).toBe(401);
    const bare = await fetch(`${apiUrl}/v1/genesis/runtime-evidence`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(bare.status).toBe(401);
    await reset();

    // Another founder's fleet credential installed into this founder's state: it refuses to run as someone else.
    const host2 = newHost();
    const prov2 = provisioner(host2);
    const g2 = await approved(2, 0);
    const pv2 = await prov2.provisionGenesis(g2.genesisId);
    const [c, d] = pv2.founderIds!;
    expect((await prov2.attestGenesis(g2.genesisId)).ok).toBe(true);
    await genesis.fund(g2.genesisId, OWNER);
    await prov2.activateGenesis(g2.genesisId, g2.authSha256);
    await host2.stop(d);
    fs.copyFileSync(path.join(host2.stateDir(c), FOUNDER_CREDENTIAL_FILE), path.join(host2.stateDir(d), FOUNDER_CREDENTIAL_FILE));
    await host2.start(d);
    await waitFor(async () => host2.exitCode(d) === 4, 20_000);
    expect(host2.logs.get(d)).toMatch(/credential belongs to another agent/);
    await reset();
  }, 240_000);

  it("a duplicate founder process is refused; the first keeps its identity", async () => {
    const host = newHost();
    const prov = provisioner(host);
    const g = await approved(2, 0);
    const pv = await prov.provisionGenesis(g.genesisId);
    const [a] = pv.founderIds!;
    await waitFor(async () => (await genesis.runtimeEvidence(g.genesisId, a)).evidence);
    const dup = await host.startDuplicate(a);
    let out = "";
    dup.stdout?.on("data", (x) => (out += x));
    const code = await new Promise<number | null>((r) => dup.once("exit", (c) => r(c)));
    expect(code).toBe(3);
    expect(out).toMatch(/FLEET_DUPLICATE_FOUNDER_RUNTIME/);
    expect((await owner.query(`SELECT count(*)::int AS n FROM fleet.fleet_events WHERE event_type = 'genesis_duplicate_runtime'`)).rows[0].n).toBe(1);
    // The duplicate overwrote the instance marker: the host no longer sees a consistent process, so attestation fails closed.
    const at = await prov.attestGenesis(g.genesisId);
    expect(at.ok).toBe(false);
    expect(await population()).toBe(0);
    await reset();
  }, 180_000);

  it("partial provisioning failure, and a process that dies during attestation, roll everything back", async () => {
    // Founder 2's state already exists (stale provisioning): founder 1 is torn down, the Genesis rolls back.
    const host = newHost();
    const prov = provisioner(host);
    const g = await approved(2, 1_000);
    const pv = await genesis.provision(g.genesisId, OWNER);
    fs.mkdirSync(host.stateDir(pv.founderIds![1]), { recursive: true });
    await expect(prov.provisionGenesis(g.genesisId)).rejects.toThrow(/already exists/);
    expect((await genesis.status(g.genesisId))!.status).toBe("rolled_back");
    expect(await host.pid(pv.founderIds![0])).toBeNull();
    expect(fs.existsSync(host.stateDir(pv.founderIds![0]))).toBe(false);
    expect(await population()).toBe(0);
    await reset();

    // Founder 2 dies after reporting but before the owner attests: host evidence is gone → rollback.
    const host2 = newHost();
    const prov2 = provisioner(host2);
    const g2 = await approved(2, 1_000);
    const pv2 = await prov2.provisionGenesis(g2.genesisId);
    const [x, y] = pv2.founderIds!;
    await waitFor(async () => (await genesis.runtimeEvidence(g2.genesisId, y)).evidence && (await genesis.runtimeEvidence(g2.genesisId, x)).evidence);
    await host2.stop(y);
    const at = await prov2.attestGenesis(g2.genesisId);
    expect(at).toMatchObject({ ok: false, status: "rolled_back" });
    for (const id of [x, y]) {
      expect(await host2.pid(id)).toBeNull();
      expect(fs.existsSync(host2.stateDir(id))).toBe(false);
      expect((await ledger.economics(id)).cash).toBe(0);
    }
    expect(await population()).toBe(0);
    expect((await owner.query(`SELECT count(*)::int AS n FROM fleet.fleet_agent_credentials`)).rows[0].n).toBe(0);
    await reset();
  }, 240_000);

  it("the real-runtime rehearsal (throwaway registry, process host, founder cognition) passes and leaves the main registry untouched", async () => {
    const reg = await startEphemeralPg(PG_BIN!);
    const before = await population();
    try {
      // As the shipped unit: the founder thinks only through the controller.
      const host = newHost({ FLEET_FOUNDER_AGENT_LOOP: "controller" });
      const r = await runFounderRehearsal({
        registry: { ownerUrl: reg.ownerUrl, serviceUrl: reg.serviceUrl, agentUrl: reg.agentUrl },
        host,
        release: { repo: REPO_URL, commit: identity.commit!, buildId: identity.buildId!, lockfileSha256: identity.lockfileSha256! },
        actor: OWNER,
        timeoutMs: 60_000,
      });
      expect(r.checks.filter((c) => !c.ok)).toEqual([]);
      expect(r.pass).toBe(true);
      expect(r.founders).toHaveLength(2);
      expect(r.founders.every((f) => f.heartbeats >= 3 && f.challengesPassed >= 1)).toBe(true);
      expect(r.checks.map((c) => c.name)).toEqual(expect.arrayContaining([
        "each founder's shell runs in its Landlock sandbox (own state and credential unreadable, no TCP)",
        "founder cognition is off until the owner switches it on",
        "both founders think through the controller and pay from their own ledger",
        "forbidden tools and a planted prompt injection are refused mid-loop",
        "pausing one founder stops it at once; the other continues",
        "switching cognition off stops every founder",
      ]));
    } finally {
      reg.stop();
    }
    expect(await population()).toBe(before);
  }, 360_000);
});

void hashAgentToken;
void FOUNDER_REPORT_FILE;
