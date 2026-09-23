/**
 * Fleet Layer Tests (Phase 6): deployment of the real control plane, pinned
 * runtime identity, the untracked-sandbox window, the HTTPS controller, the
 * DRY_RUN_CHILD and operator verification with independent readiness levels.
 *
 * Describe names include "security", "policy" and "financial" so these also
 * run under test:security and test:financial. PostgreSQL tests use a
 * throwaway cluster set up exactly as production (fixtures/ephemeral-pg.ts).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import fs from "fs";
import http from "http";
import https from "https";
import net from "net";
import os from "os";
import path from "path";
import pg from "pg";
import { ulid } from "ulid";
import { FleetService, type AuditEntry } from "../../fleet/service/server.js";
import { UnsupportedSandboxTerminator } from "../../fleet/service/terminator.js";
import { loadRemoteConfig, parseListen, serviceUserProblem, startFleetServiceFromEnv, tlsProblemsForHost } from "../../fleet/service/main.js";
import { FleetApiClient } from "../../fleet/service/client.js";
import { PgAgentGateway } from "../../fleet/postgres/agent-gateway.js";
import { PgFleetStore } from "../../fleet/postgres/store.js";
import { FLEET_PG_SCHEMA_VERSION, PG_MIGRATIONS } from "../../fleet/postgres/migrations.js";
import { runDoctor, osUserCanRead, formatChecklist } from "../../fleet/doctor.js";
import { treeIdentity, verifyRuntimeIdentity } from "../../fleet/runtime-verify.js";
import { dryRunChildProblems, runDryRunChild } from "../../fleet/dry-run/child.js";
import { dryRunPreflight, keylessDryRunAddress, performDryRunChild } from "../../fleet/dry-run/operator.js";
import {
  CHILD_FLEET_CREDENTIALS,
  FleetProvisioningUncertainError,
  createTrackedSandbox,
  findSandboxByName,
  installPinnedRuntime,
  sandboxNameFor,
} from "../../replication/spawn.js";
import { CHILD_RUNTIME_MANIFEST, FleetRuntimeError, buildRuntimeInstallCommand } from "../../fleet/runtime.js";
import { attestationProof, computeBuildIdentity, type RuntimeAttestation } from "../../fleet/attestation.js";
import type { ClaimedGrant } from "../../fleet/grants.js";
import { getForbiddenCommandMatch } from "../../agent/policy-rules/command-safety.js";
import type { CreateSandboxOptions, SandboxInfo } from "../../types.js";
import { MockConwayClient, TEST_RUNTIME_BUILD, TEST_RUNTIME_PIN, isFleetSandboxCheck, runtimeVerifyStdout } from "../mocks.js";
import { findPgBin, startEphemeralPg, type EphemeralPg } from "./fixtures/ephemeral-pg.js";
import { wipeRegistry } from "./fixtures/wipe.js";

const PIN = TEST_RUNTIME_PIN;
const BUILD = TEST_RUNTIME_BUILD;
const RELEASE = { ...PIN, ...BUILD };
const RELEASE_ENV = {
  FLEET_RUNTIME_REPO: PIN.repo,
  FLEET_RUNTIME_COMMIT: PIN.commit,
  FLEET_RUNTIME_BUILD_ID: BUILD.buildId,
  FLEET_RUNTIME_LOCKFILE_SHA256: BUILD.lockfileSha256,
};
const FLAGS_OFF = { REAL_REPLICATION_ENABLED: "false", REAL_PAYMENTS_ENABLED: "false", OWNER_SWEEP_ENABLED: "false" };
const REPO_ROOT = path.resolve(__dirname, "../../..");

function wallet(): string {
  return `0x${randomBytes(20).toString("hex")}`;
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fleet-p6-"));
}

/** Self-signed certificate for localhost / 127.0.0.1 (key 0600). */
function makeCert(dir: string, cn = "localhost", days = 2): { cert: Buffer; key: Buffer; certFile: string; keyFile: string } {
  const certFile = path.join(dir, "fleet.crt");
  const keyFile = path.join(dir, "fleet.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", String(days),
    "-subj", `/CN=${cn}`, "-addext", `subjectAltName=DNS:${cn},IP:127.0.0.1`, "-keyout", keyFile, "-out", certFile], { stdio: "ignore" });
  fs.chmodSync(keyFile, 0o600);
  return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile), certFile, keyFile };
}

/** Minimal fetch that trusts a private CA (the child and doctor reach the test HTTPS controller). */
function caFetch(ca: Buffer): typeof fetch {
  return (async (input: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(input));
    return new Promise((resolve, reject) => {
      const req = (u.protocol === "https:" ? https : http).request(
        u,
        { method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, ca },
        (res) => {
          let d = "";
          res.on("data", (x) => (d += x));
          res.on("end", () =>
            resolve({ ok: res.statusCode! >= 200 && res.statusCode! < 300, status: res.statusCode!, json: async () => JSON.parse(d) } as Response),
          );
        },
      );
      req.on("error", reject);
      if (init.body) req.write(init.body as string);
      req.end();
    });
  }) as typeof fetch;
}

/** Conway sandbox provider double: sandboxes are listed with their names (optionally not), creates can "lose" their response. */
class NamedSandboxConway extends MockConwayClient {
  sandboxes: SandboxInfo[] = [];
  created = 0;
  /** createSandbox calls that create the sandbox but lose the response. */
  loseCreateResponse = 0;
  /** createSandbox calls that fail without creating anything. */
  failCreate = 0;
  reportNames = true;
  onStart: ((files: Record<string, string>) => void) | null = null;

  constructor(state: Parameters<typeof runtimeVerifyStdout>[0] = {}, installExit = 0) {
    super();
    vi.spyOn(this, "exec").mockImplementation(async (command: string) => {
      if (isFleetSandboxCheck(command)) return { stdout: runtimeVerifyStdout(state, command), stderr: "", exitCode: 0 };
      if (command.includes("--frozen-lockfile")) return { stdout: "", stderr: "ERR_PNPM_OUTDATED_LOCKFILE", exitCode: installExit };
      if (command.includes("dist/fleet/dry-run/child-main.js")) this.onStart?.(this.files);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });
  }

  override async createSandbox(o: CreateSandboxOptions): Promise<SandboxInfo> {
    if (this.failCreate > 0) {
      this.failCreate--;
      throw new Error("connect ETIMEDOUT");
    }
    this.created++;
    const sb: SandboxInfo = { id: `sbx-${ulid()}`, name: o.name, status: "running", region: "t", vcpu: 1, memoryMb: 1024, diskGb: 10, createdAt: new Date().toISOString() };
    this.sandboxes.push(sb);
    if (this.loseCreateResponse > 0) {
      this.loseCreateResponse--;
      throw new Error("socket hang up");
    }
    return sb;
  }

  override async listSandboxes(): Promise<SandboxInfo[]> {
    return this.sandboxes.map((s) => (this.reportNames ? s : { ...s, name: undefined }));
  }
}

// ─── Pure: runtime identity, remote config, service user, dry-run child refusals ───

describe("Fleet security: Phase 6 pinned runtime identity", () => {
  const approved = { ...RELEASE };

  it("runtime pin mismatch is rejected (repository or commit differs)", () => {
    expect(verifyRuntimeIdentity({ env: RELEASE_ENV, approved }).ok).toBe(true);
    const repo = verifyRuntimeIdentity({ env: RELEASE_ENV, approved: { ...approved, repo: "https://github.com/other/fork" } });
    expect(repo.ok).toBe(false);
    expect(repo.problems.join(" ")).toMatch(/repository differs/);
    const commit = verifyRuntimeIdentity({ env: { ...RELEASE_ENV, FLEET_RUNTIME_COMMIT: "a".repeat(40) }, approved });
    expect(commit.problems.join(" ")).toMatch(/commit differs/);
    expect(verifyRuntimeIdentity({ env: { ...RELEASE_ENV, FLEET_RUNTIME_REPO: "" }, approved }).problems.join(" ")).toMatch(/not pinned/);
    expect(verifyRuntimeIdentity({ env: RELEASE_ENV, approved: null }).problems.join(" ")).toMatch(/no runtime approved/);
  });

  it("build ID mismatch is rejected (pin vs approved, and an installed tree vs the pin)", () => {
    const r = verifyRuntimeIdentity({ env: { ...RELEASE_ENV, FLEET_RUNTIME_BUILD_ID: "c".repeat(64) }, approved });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/build identifier differs/);

    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, "package.json"), '{"name":"x"}');
      fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      fs.mkdirSync(path.join(dir, "dist"));
      fs.mkdirSync(path.join(dir, "src"));
      fs.writeFileSync(path.join(dir, "src", "a.ts"), "export {};\n");
      const id = computeBuildIdentity(dir);
      const env = { ...RELEASE_ENV, FLEET_RUNTIME_BUILD_ID: id.buildId, FLEET_RUNTIME_LOCKFILE_SHA256: id.lockfileSha256 };
      const tree = { ...treeIdentity(dir), commit: PIN.commit, origin: PIN.repo };
      expect(verifyRuntimeIdentity({ env, approved: { ...approved, buildId: id.buildId, lockfileSha256: id.lockfileSha256 }, tree }).ok).toBe(true);
      fs.writeFileSync(path.join(dir, "dist", "injected.js"), "evil()\n");
      const tampered = { ...treeIdentity(dir), commit: PIN.commit, origin: PIN.repo };
      const bad = verifyRuntimeIdentity({ env, approved: { ...approved, buildId: id.buildId, lockfileSha256: id.lockfileSha256 }, tree: tampered });
      expect(bad.ok).toBe(false);
      expect(bad.problems.join(" ")).toMatch(/installed tree: build identifier differs/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("frozen-lockfile failure is rejected: lockfile hash checked before install; a failing frozen install aborts provisioning", async () => {
    const cmd = buildRuntimeInstallCommand(PIN, BUILD);
    expect(cmd.indexOf("sha256sum -c")).toBeGreaterThan(0);
    expect(cmd.indexOf("sha256sum -c")).toBeLessThan(cmd.indexOf("pnpm install --frozen-lockfile"));
    expect(cmd).not.toMatch(/--no-frozen-lockfile|pnpm install(?! --frozen-lockfile)/);
    const conway = new NamedSandboxConway({}, 1);
    await expect(installPinnedRuntime(conway, { runtime: PIN, build: BUILD, nonce: "a".repeat(64) })).rejects.toThrow(FleetRuntimeError);
    // A tree whose lockfile differs from the pin fails verification.
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, "package.json"), "{}");
      fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "changed\n");
      fs.mkdirSync(path.join(dir, "dist"));
      fs.mkdirSync(path.join(dir, "src"));
      const r = verifyRuntimeIdentity({ env: RELEASE_ENV, approved: RELEASE, tree: { ...treeIdentity(dir), commit: PIN.commit, origin: null } });
      expect(r.problems.join(" ")).toMatch(/lockfile verification failed/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the runtime uses pnpm install --frozen-lockfile everywhere it is built", () => {
    for (const f of ["scripts/fleet-build-runtime.sh", "scripts/fleet-deploy-release.sh"]) {
      const s = fs.readFileSync(path.join(REPO_ROOT, f), "utf8");
      expect(s).toMatch(/pnpm install --frozen-lockfile/);
      expect(s).not.toMatch(/--no-frozen-lockfile/);
    }
  });
});

describe("Fleet security: Phase 6 HTTPS controller configuration", () => {
  let dir: string;
  let tls: ReturnType<typeof makeCert>;
  beforeAll(() => {
    dir = tmpDir();
    tls = makeCert(dir);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("HTTPS is required for remote binding: TLS, a public hostname and a certificate covering it", () => {
    expect(loadRemoteConfig({}, null)).toBeNull();
    expect(() => loadRemoteConfig({ FLEET_REMOTE_LISTEN_ENABLED: "true" }, null)).toThrow(/requires FLEET_TLS_CERT_FILE/);
    expect(() => loadRemoteConfig({ FLEET_REMOTE_LISTEN_ENABLED: "true" }, tls)).toThrow(/FLEET_PUBLIC_HOSTNAME/);
    expect(() => loadRemoteConfig({ FLEET_REMOTE_LISTEN_ENABLED: "true", FLEET_PUBLIC_HOSTNAME: "fleet.example.com" }, tls)).toThrow(
      /does not cover fleet\.example\.com/,
    );
    const ok = loadRemoteConfig(
      { FLEET_REMOTE_LISTEN_ENABLED: "true", FLEET_PUBLIC_HOSTNAME: "localhost", FLEET_PUBLIC_LISTEN: "0.0.0.0:8443", FLEET_ALLOWED_ORIGINS: "https://ops.example.com" },
      tls,
    );
    expect(ok).toEqual({ hostname: "localhost", publicListen: { host: "0.0.0.0", port: 8443 }, allowedOrigins: ["https://ops.example.com"] });
    expect(() => loadRemoteConfig({ FLEET_ALLOWED_ORIGINS: "http://insecure.example.com" }, null)).toThrow(/https origins/);
    // A certificate about to expire, or a key that does not match, is refused.
    const short = makeCert(tmpDir(), "localhost", 1);
    expect(tlsProblemsForHost(short, "localhost").join(" ")).toMatch(/expires/);
    expect(tlsProblemsForHost({ cert: tls.cert, key: short.key }, "localhost").join(" ")).toMatch(/does not match/);
  });

  it("HTTP remote binding is rejected everywhere (config, listener, admin listener)", async () => {
    expect(() => parseListen("0.0.0.0:8787")).toThrow(/loopback/);
    expect(() => loadRemoteConfig({ FLEET_PUBLIC_LISTEN: "0.0.0.0:443" }, null)).toThrow(/requires FLEET_REMOTE_LISTEN_ENABLED/);
    const svc = new FleetService({ admin: {} as PgFleetStore, agent: {} as PgAgentGateway, realReplicationEnabled: false, reaperIntervalMs: 0, release: null });
    await expect(svc.listen(0, "0.0.0.0")).rejects.toThrow(/plain-HTTP binding on non-loopback/);
    await expect(svc.listenAdmin(0, "0.0.0.0")).rejects.toThrow(/must bind to loopback/);
    await expect(svc.listenAdmin(0, "::")).rejects.toThrow(/must bind to loopback/);
    await svc.close();
    await expect(
      startFleetServiceFromEnv(
        { FLEET_SERVICE_DATABASE_URL: "postgresql://s:x@127.0.0.1:1/x", FLEET_AGENT_DATABASE_URL: "postgresql://a:x@127.0.0.1:1/x", FLEET_API_LISTEN: "0.0.0.0:0" },
        { log: () => {} },
      ),
    ).rejects.toThrow(/loopback/);
  });

  it("the service starts only under its dedicated OS user (never root)", async () => {
    expect(serviceUserProblem({}, { uid: 0, username: "root" })).toMatch(/must not run as root/);
    expect(serviceUserProblem({ FLEET_SERVICE_EXPECTED_USER: "automaton-fleet-service" }, { uid: 1000, username: "sl4mm3r" })).toMatch(
      /must run as automaton-fleet-service/,
    );
    expect(serviceUserProblem({ FLEET_SERVICE_EXPECTED_USER: "automaton-fleet-service" }, { uid: 990, username: "automaton-fleet-service" })).toBeNull();
    await expect(
      startFleetServiceFromEnv({ FLEET_SERVICE_EXPECTED_USER: "automaton-fleet-service", FLEET_SERVICE_DATABASE_URL: "x", FLEET_AGENT_DATABASE_URL: "y" }, {
        log: () => {},
        user: { uid: 1000, username: "operator" },
      }),
    ).rejects.toThrow(/must run as automaton-fleet-service/);
    const unit = fs.readFileSync(path.join(REPO_ROOT, "deploy/systemd/automaton-fleet.service"), "utf8");
    expect(unit).toMatch(/^User=automaton-fleet-service$/m);
    expect(unit).toMatch(/^Environment=FLEET_SERVICE_EXPECTED_USER=automaton-fleet-service$/m);
    expect(unit).toMatch(/^IPAddressDeny=any$/m);
    expect(unit).not.toMatch(/^LoadCredential=tls\.key/m); // remote exposure stays disabled in the shipped unit
    expect(unit).not.toMatch(/postgresql:\/\//);
  });

  it("live deployment (when installed): the unit runs as automaton-fleet-service", () => {
    let state = "";
    try {
      state = execFileSync("systemctl", ["is-active", "automaton-fleet.service"], { encoding: "utf8" }).trim();
    } catch {
      state = "inactive";
    }
    if (state !== "active") return; // not deployed on this host yet: covered by scripts/fleet-verify-deployment.sh
    const pid = execFileSync("systemctl", ["show", "-p", "MainPID", "--value", "automaton-fleet.service"], { encoding: "utf8" }).trim();
    expect(execFileSync("ps", ["-o", "user=", "-p", pid], { encoding: "utf8" }).trim()).toBe("automaton-fleet-service");
  });

  it("firewall and remote drop-in expose only HTTPS; PostgreSQL/Redis/admin HTTP stay closed", () => {
    const fw = fs.readFileSync(path.join(REPO_ROOT, "deploy/firewall/fleet-firewall.sh"), "utf8");
    expect(fw).toMatch(/ufw default deny incoming/);
    expect(fw).toMatch(/ufw allow 443\/tcp/);
    for (const p of ["5432", "6379", "8787"]) expect(fw).toMatch(new RegExp(`ufw deny ${p}/tcp`));
    expect(fw).not.toMatch(/ufw allow (5432|6379|8787)/);
    const dropIn = fs.readFileSync(path.join(REPO_ROOT, "deploy/systemd/automaton-fleet.service.d/remote.conf.example"), "utf8");
    expect(dropIn).toMatch(/^LoadCredential=tls\.key:\/etc\/automaton-fleet\/tls\/fleet\.key$/m);
    expect(dropIn).toMatch(/^LoadCredential=tls\.crt:\/etc\/automaton-fleet\/tls\/fleet\.crt$/m);
    expect(dropIn).not.toMatch(/5432|6379/);
    const rt = fs.readFileSync(path.join(REPO_ROOT, "deploy/etc/runtime.env.example"), "utf8");
    expect(rt).toMatch(/^FLEET_REMOTE_LISTEN_ENABLED=false$/m);
    for (const f of ["REAL_REPLICATION_ENABLED", "REAL_PAYMENTS_ENABLED", "OWNER_SWEEP_ENABLED", "FLEET_DRY_RUN_CHILD"]) {
      expect(rt).toMatch(new RegExp(`^${f}=false$`, "m"));
    }
  });
});

describe("Fleet security: Phase 6 privileged secrets vs OS identities", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("the agent user cannot read controller secrets (mode/owner model), and a world-readable secret is detected", () => {
    const me = os.userInfo();
    const passwd = path.join(dir, "passwd");
    const group = path.join(dir, "group");
    fs.writeFileSync(passwd, `op:x:${me.uid}:${me.gid}::/home/op:/bin/bash\nautomaton-agent:x:${me.uid + 7001}:${me.uid + 7001}::/home/a:/usr/sbin/nologin\nautomaton-fleet-service:x:${me.uid + 7002}:${me.uid + 7002}::/:/usr/sbin/nologin\n`);
    fs.writeFileSync(group, `automaton-fleet-admin:x:${me.gid}:op\n`);
    const admin = path.join(dir, "admin.env");
    const service = path.join(dir, "service.env");
    fs.writeFileSync(admin, "FLEET_ADMIN_DATABASE_URL=x\n", { mode: 0o640 });
    fs.writeFileSync(service, "FLEET_SERVICE_DATABASE_URL=x\n", { mode: 0o600 });
    fs.chmodSync(admin, 0o640);
    fs.chmodSync(service, 0o600);
    for (const u of ["automaton-agent", "automaton-fleet-service"]) {
      expect(osUserCanRead(admin, u, passwd, group)).toBe(false);
      expect(osUserCanRead(service, u, passwd, group)).toBe(false);
    }
    expect(osUserCanRead(admin, "op", passwd, group)).toBe(true); // operator group may read admin.env
    fs.chmodSync(service, 0o644);
    expect(osUserCanRead(service, "automaton-agent", passwd, group)).toBe(true);
    // The agent unit hides the secret directory regardless of modes.
    const agentUnit = fs.readFileSync(path.join(REPO_ROOT, "deploy/systemd/automaton-agent.service"), "utf8");
    expect(agentUnit).toMatch(/InaccessiblePaths=\/etc\/automaton-fleet/);
    expect(agentUnit).toMatch(/^User=automaton-agent$/m);
  });

  it("live deployment (when installed): automaton-agent cannot read any controller secret file", () => {
    if (!fs.existsSync("/etc/automaton-fleet")) return; // not deployed yet: covered by scripts/fleet-verify-deployment.sh
    for (const f of ["admin.env", "service.env", "tls/fleet.key"]) {
      const file = path.join("/etc/automaton-fleet", f);
      if (!fs.existsSync(file)) continue;
      expect(osUserCanRead(file, "automaton-agent")).not.toBe(true);
      expect(osUserCanRead(file, "automaton-fleet-service")).not.toBe(true);
    }
  });

  it("a dry-run child refuses to run with payment/sweep/replication switches, DB or controller credentials, or a wallet key", () => {
    const manifest = path.join(dir, "fleet-runtime.json");
    fs.writeFileSync(manifest, JSON.stringify({ agentId: ulid(), dryRun: true, provisioningKey: ulid(), repo: PIN.repo, commit: PIN.commit }));
    const base = { env: { HOME: dir }, manifestPath: manifest, walletFile: path.join(dir, "wallet.json") };
    expect(dryRunChildProblems(base)).toEqual([]);
    expect(dryRunChildProblems({ ...base, env: { HOME: dir, REAL_PAYMENTS_ENABLED: "true" } }).join(" ")).toMatch(/REAL_PAYMENTS_ENABLED/);
    expect(dryRunChildProblems({ ...base, env: { HOME: dir, OWNER_SWEEP_ENABLED: "true" } }).join(" ")).toMatch(/OWNER_SWEEP_ENABLED/);
    expect(dryRunChildProblems({ ...base, env: { HOME: dir, DATABASE_URL: "postgresql://x" } }).join(" ")).toMatch(/DATABASE_URL/);
    expect(dryRunChildProblems({ ...base, env: { HOME: dir, FLEET_ADMIN_DATABASE_URL: "x" } }).join(" ")).toMatch(/FLEET_ADMIN_DATABASE_URL/);
    fs.writeFileSync(base.walletFile, "{}");
    expect(dryRunChildProblems(base).join(" ")).toMatch(/wallet key file/);
    fs.rmSync(base.walletFile);
    fs.writeFileSync(manifest, JSON.stringify({ agentId: ulid(), repo: PIN.repo, commit: PIN.commit }));
    expect(dryRunChildProblems(base).join(" ")).toMatch(/not a dry-run manifest/);
  });

  it("agents cannot run the Phase 6 operator commands or flip exposure/safety switches", () => {
    for (const c of [
      "pnpm fleet:dry-run-child --root x --api-url https://h --confirm-real-sandbox",
      "pnpm fleet:verify",
      "FLEET_DRY_RUN_CHILD=true node x",
      "export REAL_PAYMENTS_ENABLED=true",
      "FLEET_REMOTE_LISTEN_ENABLED=true pnpm fleet:service",
      "sudo ufw allow 5432/tcp",
      "psql -c 'select * from fleet.fleet_provisioning'",
      "node dist/fleet/dry-run/child-main.js",
    ]) {
      expect(getForbiddenCommandMatch(c), c).not.toBeNull();
    }
  });
});

// ─── PostgreSQL ──────────────────────────────────────────────────

const PG_BIN = findPgBin();
if (!PG_BIN) console.warn("[fleet-phase6] PostgreSQL binaries not found — Phase 6 database tests SKIPPED. Set PG_BIN.");

describe.skipIf(!PG_BIN)("Fleet security policy: Phase 6 control plane, provisioning intents and dry-run child (PostgreSQL)", () => {
  let pgc: EphemeralPg;
  let admin: PgFleetStore;
  let svc: PgFleetStore;
  let ownerRaw: pg.Pool;
  let gateway: PgAgentGateway;
  let service: FleetService | null = null;
  let url = "";
  let certDir: string;
  let tls: ReturnType<typeof makeCert>;
  const audit: AuditEntry[] = [];
  const opened: Array<{ close(): Promise<void> }> = [];
  const track = <T extends { close(): Promise<void> }>(x: T): T => (opened.push(x), x);

  async function status(agentId: string) {
    return (await admin.getAgent(agentId))!.status;
  }

  async function population() {
    const st = await admin.getState();
    return st.livingAgents + st.reservedSlots + (st.quarantinedSlots ?? 0);
  }

  async function reset(max = 2) {
    const c = await ownerRaw.connect();
    try {
      await c.query("BEGIN");
      await wipeRegistry(c, "fleet");
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    } finally {
      c.release();
    }
    await admin.setApprovedRuntime(null, "test");
    await admin.setMaxAgents(max, "test");
    await admin.setOperatingMode("EXPANSION", "test", "test");
    await admin.setApprovedRuntime(PIN, "test", BUILD);
    await admin.setReplicationEnabled(true, "test");
    await admin.setTimeouts({ reservationTtlS: 1800, provisioningTtlS: 2700, heartbeatUnresponsiveS: 120, heartbeatDeadS: 600, parentReportQuietS: 60 }, "test");
  }

  async function enrollRoot(name = "root") {
    const reg = await admin.registerRoot({ walletAddress: wallet(), name });
    if (!reg.ok) throw new Error(reg.reason);
    const cred = await admin.issueCredential(reg.agent.agentId, "test");
    return { agent: reg.agent, cred };
  }

  function honest(claimed: ClaimedGrant): RuntimeAttestation {
    const a = { nonce: claimed.nonce!, commit: PIN.commit, repo: PIN.repo, buildId: BUILD.buildId, lockfileSha256: BUILD.lockfileSha256, clean: true, fileCount: 3, version: "0.2.1", proof: "" };
    return { ...a, proof: attestationProof(a) };
  }

  async function claimed(parentId: string) {
    const res = await admin.reserveSlot({ parentAgentId: parentId, requestedBy: "t", name: "kid", runtime: PIN });
    if (!res.ok) throw new Error(`${res.code}: ${res.reason}`);
    const c = await svc.claimGrant(res.agent.agentId, ulid(), { parentAgentId: parentId });
    return { agentId: res.agent.agentId, reservationId: res.lease!.reservationId, claimed: c };
  }

  async function provisioning(agentId: string) {
    return (await ownerRaw.query("SELECT * FROM fleet.fleet_provisioning WHERE expected_agent_id = $1", [agentId])).rows[0];
  }

  async function expireLease(agentId: string) {
    await ownerRaw.query("UPDATE fleet.fleet_reservations SET expires_at = now() - interval '1 second' WHERE agent_id = $1", [agentId]);
    await ownerRaw.query("UPDATE fleet.fleet_provisioning SET activation_deadline = now() - interval '1 second' WHERE expected_agent_id = $1", [agentId]);
  }

  async function startService(extra: Partial<ConstructorParameters<typeof FleetService>[0]> = {}) {
    await service?.close();
    service = new FleetService({
      admin: svc,
      agent: gateway,
      realReplicationEnabled: false,
      reaperIntervalMs: 0,
      release: RELEASE,
      audit: (e) => audit.push(e),
      terminator: new UnsupportedSandboxTerminator(),
      tls: { cert: tls.cert, key: tls.key },
      ...extra,
    });
    url = (await service.listen(0, "127.0.0.1")).url;
  }

  beforeAll(async () => {
    certDir = tmpDir();
    tls = makeCert(certDir);
    pgc = await startEphemeralPg(PG_BIN!);
    ownerRaw = new pg.Pool({ connectionString: pgc.ownerUrl, max: 6 });
    admin = track(new PgFleetStore({ connectionString: pgc.ownerUrl }));
    svc = track(new PgFleetStore({ connectionString: pgc.serviceUrl }));
    await admin.migrate();
    gateway = track(new PgAgentGateway({ connectionString: pgc.agentUrl }));
  }, 60_000);

  afterAll(async () => {
    await service?.close();
    for (const s of opened) await s.close();
    await ownerRaw?.end();
    pgc?.stop();
    fs.rmSync(certDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await reset();
    audit.length = 0;
    await startService();
  });

  // ── Part A: migrations

  it("migration v1 -> v5 -> v6: verified transactionally (rolled back), then applied; data preserved; privileges still least", async () => {
    const schema = "fleet_mig_v1";
    const c = await ownerRaw.connect();
    try {
      await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await c.query(`CREATE SCHEMA ${schema}`);
      await c.query(`CREATE TABLE ${schema}.fleet_schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
      await c.query("BEGIN");
      await c.query(`SET LOCAL search_path TO ${schema}`);
      await c.query(PG_MIGRATIONS[0].sql.replaceAll("@@SCHEMA@@", `"${schema}"`));
      await c.query(`INSERT INTO ${schema}.fleet_schema_migrations (version, name) VALUES (1, $1)`, [PG_MIGRATIONS[0].name]);
      await c.query("COMMIT");
      await c.query(`UPDATE ${schema}.fleet_state SET max_agents = 2`);
    } finally {
      c.release();
    }
    const store = track(new PgFleetStore({ connectionString: pgc.ownerUrl, schema }));
    expect((await store.health()).schemaVersion).toBe(1);
    const check = await store.migrateCheck();
    expect(check).toEqual({ currentVersion: 1, resultingVersion: FLEET_PG_SCHEMA_VERSION, wouldApply: [2, 3, 4, 5, 6] });
    expect((await store.health()).schemaVersion).toBe(1); // rolled back
    expect(await store.migrate()).toEqual([2, 3, 4, 5, 6]);
    const h = await store.health();
    expect(h.schemaVersion).toBe(6);
    expect(FLEET_PG_SCHEMA_VERSION).toBe(6);
    expect((await store.getState()).maxAgents).toBe(2);
    const v5 = await ownerRaw.query(`SELECT version FROM ${schema}.fleet_schema_migrations ORDER BY version`);
    expect(v5.rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await store.auditPrivileges()).problems).toEqual([]);
    expect(await store.migrate()).toEqual([]); // idempotent
    await ownerRaw.query(`DROP SCHEMA ${schema} CASCADE`);
  });

  it("migrations (and the transactional check) cannot be performed by the restricted agent or service role", async () => {
    for (const dsn of [pgc.agentUrl, pgc.serviceUrl]) {
      const s = track(new PgFleetStore({ connectionString: dsn }));
      await expect(s.migrate()).rejects.toThrow(/Refusing to migrate/);
      await expect(s.migrateCheck()).rejects.toThrow(/Refusing to migrate/);
    }
  });

  // ── Part C: the untracked sandbox window

  it("duplicate provisioning retry creates one logical child (lost create response -> found by provisioning key)", async () => {
    await reset(3);
    const root = await enrollRoot();
    const k = await claimed(root.agent.agentId);
    expect(k.claimed.provisioningKey).toBe(k.reservationId);
    const conway = new NamedSandboxConway();
    conway.loseCreateResponse = 1;
    const sb = await createTrackedSandbox(conway, k.claimed, { vcpu: 1, memoryMb: 1024, diskGb: 10 });
    expect(conway.created).toBe(1);
    expect(conway.sandboxes).toHaveLength(1);
    expect(conway.sandboxes[0]).toMatchObject({ id: sb.id, name: sandboxNameFor(k.reservationId) });
    let p = await provisioning(k.agentId);
    expect(p).toMatchObject({ provisioning_key: k.reservationId, sandbox_id: sb.id, sandbox_name: sandboxNameFor(k.reservationId), external_state: "created", create_attempts: 2 });
    // Retrying again reuses the recorded sandbox; nothing new is created.
    expect(await createTrackedSandbox(conway, k.claimed, { vcpu: 1, memoryMb: 1024, diskGb: 10 })).toEqual({ id: sb.id });
    expect(conway.created).toBe(1);
    // The reservation cannot be claimed a second time.
    await expect(svc.claimGrant(k.agentId, ulid(), { parentAgentId: root.agent.agentId })).rejects.toThrow(/already used/);
    // A different sandbox can never be attached to the same provisioning.
    await expect(k.claimed.reportProvisioning!("sandbox_created", "sbx-second")).rejects.toThrow(/FLEET_SANDBOX_MISMATCH/);
    // The provisioning key must match at activation.
    await expect(
      svc.activate(k.agentId, { walletAddress: wallet(), sandboxId: sb.id, runtimeCommit: PIN.commit, attestation: honest(k.claimed), parentAgentId: root.agent.agentId, provisioningKey: ulid() }),
    ).rejects.toThrow(/provisioning key does not match/);
    await svc.activate(k.agentId, { walletAddress: wallet(), sandboxId: sb.id, runtimeCommit: PIN.commit, attestation: honest(k.claimed), parentAgentId: root.agent.agentId, provisioningKey: k.reservationId });
    const children = await ownerRaw.query("SELECT count(*)::int AS n FROM fleet.fleet_agents WHERE parent_agent_id = $1", [root.agent.agentId]);
    expect(children.rows[0].n).toBe(1);
    p = await provisioning(k.agentId);
    expect(p.status).toBe("active");

    // A provider that cannot report names makes absence unprovable: never create a second sandbox.
    const k2 = await claimed(root.agent.agentId);
    const blind = new NamedSandboxConway();
    blind.reportNames = false;
    blind.loseCreateResponse = 1;
    await expect(createTrackedSandbox(blind, k2.claimed, { vcpu: 1, memoryMb: 1024, diskGb: 10 })).rejects.toThrow(FleetProvisioningUncertainError);
    expect(blind.created).toBe(1);
    expect(await provisioning(k2.agentId)).toMatchObject({ external_state: "uncertain", sandbox_id: null, create_attempts: 2 });
    expect(await findSandboxByName(blind, sandboxNameFor(k2.reservationId))).toBe("unknown");
  });

  it("the intent is durable BEFORE creation: if it cannot be recorded, no sandbox is created; the controller caps create attempts", async () => {
    const root = await enrollRoot();
    const k = await claimed(root.agent.agentId);
    const conway = new NamedSandboxConway();
    const broken: ClaimedGrant = { ...k.claimed, recordSandboxIntent: async () => { throw new Error("controller unreachable"); } };
    await expect(createTrackedSandbox(conway, broken, { vcpu: 1, memoryMb: 1024, diskGb: 10 })).rejects.toThrow(/controller unreachable/);
    expect(conway.created).toBe(0);
    // A name not derived from the provisioning key is refused.
    await expect(k.claimed.recordSandboxIntent!("fleet-" + ulid().toLowerCase())).rejects.toThrow(/FLEET_BAD_REQUEST/);
    for (let i = 0; i < 3; i++) await k.claimed.recordSandboxIntent!(sandboxNameFor(k.reservationId));
    await expect(k.claimed.recordSandboxIntent!(sandboxNameFor(k.reservationId))).rejects.toThrow(/FLEET_PROVISIONING_UNCERTAIN/);
  });

  it("provisioning callback loss is reconciled: ORPHANED + quarantine slot + capabilities revoked, found by name, cleanup record kept", async () => {
    const root = await enrollRoot();
    const k = await claimed(root.agent.agentId);
    const conway = new NamedSandboxConway();
    const lossy: ClaimedGrant = { ...k.claimed, reportProvisioning: async () => { throw new Error("callback lost"); } };
    await expect(createTrackedSandbox(conway, lossy, { vcpu: 1, memoryMb: 1024, diskGb: 10 })).rejects.toThrow(/callback lost/);
    expect(conway.created).toBe(1);
    const name = sandboxNameFor(k.reservationId);
    expect(await provisioning(k.agentId)).toMatchObject({ external_state: "intent", sandbox_id: null, sandbox_name: name });

    // Registration never completes: the lease expires. The sandbox may exist,
    // so the slot is NOT freed: ORPHANED with a quarantine slot.
    await expireLease(k.agentId);
    await svc.reap("t");
    expect(await status(k.agentId)).toBe("orphaned");
    const st = await admin.getState();
    expect(st.quarantinedSlots).toBe(1);
    expect(await population()).toBeLessThanOrEqual(2);
    const orphan = (await admin.listOrphans({ open: true })).find((o) => o.agent_id === k.agentId)!;
    expect(orphan).toMatchObject({ holds_slot: true, sandbox_id: null, sandbox_name: name });
    expect(await provisioning(k.agentId)).toMatchObject({ status: "orphaned", external_state: "uncertain", cleanup_status: "pending" });
    const creds = await ownerRaw.query("SELECT count(*)::int AS n FROM fleet.fleet_agent_credentials WHERE agent_id = $1 AND revoked_at IS NULL", [k.agentId]);
    expect(creds.rows[0].n).toBe(0);
    expect((await admin.listUncertainProvisioning()).map((p) => p.provisioning_key)).toContain(k.reservationId);
    expect((await admin.staleness()).uncertainProvisioning).toBe(1);
    // Replication is blocked while the orphan is open (and the cap is full).
    const denied = await admin.reserveSlot({ parentAgentId: root.agent.agentId, requestedBy: "t", name: "x", runtime: PIN });
    expect(denied.ok).toBe(false);

    // Reconciliation: the sandbox is found by its deterministic name.
    const found = await findSandboxByName(conway, name);
    expect(found).toEqual({ id: conway.sandboxes[0].id });
    await admin.reconcileProvisioning(k.reservationId, "found", conway.sandboxes[0].id, "operator:test");
    expect(await provisioning(k.agentId)).toMatchObject({ sandbox_id: conway.sandboxes[0].id, external_state: "created", cleanup_status: "pending" });
    expect((await admin.listOrphans({ open: true })).find((o) => o.agent_id === k.agentId)).toMatchObject({ sandbox_id: conway.sandboxes[0].id });
    await service!.processTerminations();
    expect(await status(k.agentId)).toBe("orphaned"); // Conway cannot stop it: still quarantined
    expect(await admin.resolveOrphan(k.agentId, "operator confirmed sandbox stopped", "operator:test")).toBe(true);
    expect(await status(k.agentId)).toBe("dead");
    expect((await admin.getState()).quarantinedSlots).toBe(0);
    const ev = await ownerRaw.query("SELECT event_type FROM fleet.fleet_events WHERE agent_id = $1 ORDER BY id", [k.agentId]);
    expect(ev.rows.map((r) => r.event_type)).toEqual(expect.arrayContaining(["provisioning_sandbox_intent", "provisioning_uncertain", "provisioning_reconciled"]));
  });

  it("an intent whose sandbox was never created is reconciled as absent only after the activation deadline; the slot is freed", async () => {
    const root = await enrollRoot();
    const k = await claimed(root.agent.agentId);
    const conway = new NamedSandboxConway();
    conway.failCreate = 2;
    await expect(createTrackedSandbox(conway, k.claimed, { vcpu: 1, memoryMb: 1024, diskGb: 10 })).rejects.toThrow(FleetProvisioningUncertainError);
    expect(conway.created).toBe(0);
    await expect(admin.reconcileProvisioning(k.reservationId, "absent", null, "operator:test")).rejects.toThrow(/FLEET_PROVISIONING_IN_FLIGHT/);
    await expireLease(k.agentId);
    await svc.reap("t");
    expect(await status(k.agentId)).toBe("orphaned");
    expect(await findSandboxByName(conway, sandboxNameFor(k.reservationId))).toBeNull();
    await admin.reconcileProvisioning(k.reservationId, "absent", null, "operator:test");
    expect(await status(k.agentId)).toBe("dead");
    expect(await provisioning(k.agentId)).toMatchObject({ external_state: "absent", cleanup_status: "not_required", status: "failed_provisioning" });
    expect((await admin.listOrphans({ open: true })).find((o) => o.agent_id === k.agentId)).toBeUndefined();
    expect((await admin.getState()).quarantinedSlots).toBe(0);
    // A late report of a sandbox after "absent" is still captured and queued for cleanup.
    await svc.reportProvisioning(k.agentId, "sandbox_created", "sbx-late", root.agent.agentId);
    const t = await ownerRaw.query("SELECT sandbox_id, status FROM fleet.fleet_sandbox_terminations WHERE agent_id = $1", [k.agentId]);
    expect(t.rows[0]).toMatchObject({ sandbox_id: "sbx-late", status: "pending" });
  });

  it("a known sandbox whose registration never completes keeps the Phase 5 policy: FAILED_PROVISIONING, cleanup queued, no slot", async () => {
    const root = await enrollRoot();
    const k = await claimed(root.agent.agentId);
    const conway = new NamedSandboxConway();
    const sb = await createTrackedSandbox(conway, k.claimed, { vcpu: 1, memoryMb: 1024, diskGb: 10 });
    await expireLease(k.agentId);
    await svc.reap("t");
    expect(await status(k.agentId)).toBe("failed");
    expect(await provisioning(k.agentId)).toMatchObject({ status: "failed_provisioning", cleanup_status: "pending", sandbox_id: sb.id });
    expect((await admin.getState()).quarantinedSlots).toBe(0);
  });

  it("the provisioning callback over the service carries the provisioning key; another key or parent is refused", async () => {
    await reset(4);
    await startService({ realReplicationEnabled: true, tls: undefined });
    const root = await enrollRoot();
    const other = await enrollRoot("other");
    const res = await admin.reserveSlot({ parentAgentId: root.agent.agentId, requestedBy: "t", name: "kid", runtime: PIN });
    if (!res.ok) throw new Error(res.reason);
    const c = new FleetApiClient({ baseUrl: url, agentId: root.agent.agentId, token: root.cred.token });
    const r = await (c as unknown as { claim(r: string, l: string): Promise<ClaimedGrant> }).claim(res.lease!.reservationId, ulid());
    expect(r.provisioningKey).toBe(res.lease!.reservationId);
    const intent = await r.recordSandboxIntent!(sandboxNameFor(res.lease!.reservationId));
    expect(intent).toMatchObject({ attempts: 1, sandboxId: null });
    const o = new FleetApiClient({ baseUrl: url, agentId: other.agent.agentId, token: other.cred.token });
    await expect(
      (o as unknown as { call(m: string, p: string, b: unknown): Promise<unknown> }).call("POST", "/v1/replication/provisioning", {
        reservationId: res.lease!.reservationId, phase: "sandbox_intent", sandboxName: sandboxNameFor(res.lease!.reservationId),
      }),
    ).rejects.toThrow(/not your reservation/);
    await expect(
      (c as unknown as { call(m: string, p: string, b: unknown): Promise<unknown> }).call("POST", "/v1/replication/provisioning", {
        reservationId: res.lease!.reservationId, provisioningKey: ulid(), phase: "verifying",
      }),
    ).rejects.toThrow(/not your reservation/);
  });

  // ── Part D: HTTPS controller

  it("the service serves HTTPS remotely and plain HTTP only on loopback for administration; health exposes no secrets", async () => {
    const dir = tmpDir();
    const envBase = {
      FLEET_SERVICE_DATABASE_URL: pgc.serviceUrl,
      FLEET_AGENT_DATABASE_URL: pgc.agentUrl,
      FLEET_REAPER_INTERVAL_MS: "0",
      ...RELEASE_ENV,
      FLEET_REMOTE_LISTEN_ENABLED: "true",
      FLEET_PUBLIC_HOSTNAME: "localhost",
      FLEET_PUBLIC_LISTEN: "127.0.0.1:0",
      FLEET_TLS_CERT_FILE: tls.certFile,
      FLEET_TLS_KEY_FILE: tls.keyFile,
      FLEET_API_LISTEN: "127.0.0.1:0",
    };
    const started = await startFleetServiceFromEnv(envBase, { log: () => {} });
    try {
      expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(started.publicUrl).toMatch(/^https:\/\/localhost:\d+$/);
      const f = caFetch(tls.cert);
      const pub = await f(`${started.publicUrl}/healthz`);
      const body = await pub.json();
      expect(body).toEqual({ ok: true, status: "alive", uptimeS: expect.any(Number) });
      const text = JSON.stringify(body);
      for (const secret of [pgc.serviceUrl, pgc.agentUrl, "postgresql://", "password", tls.key.toString()]) expect(text).not.toContain(secret);
      const admin = await fetch(`${started.url}/readyz`);
      expect(admin.status).toBe(200);
      expect(JSON.stringify(await admin.json())).not.toMatch(/postgresql:\/\//);
      // Plain HTTP to the TLS port fails; browsers from other origins are refused.
      await expect(fetch(started.publicUrl!.replace("https:", "http:") + "/healthz")).rejects.toThrow();
      const cross = await f(`${started.publicUrl}/healthz`, { headers: { origin: "https://evil.example.com" } });
      expect(cross.status).toBe(403);
    } finally {
      await started.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    await expect(startFleetServiceFromEnv({ ...envBase, FLEET_PUBLIC_HOSTNAME: "fleet.example.com" }, { log: () => {} })).rejects.toThrow(/does not cover/);
  });

  it("PostgreSQL cannot be reached through the fleet service (no proxy, no CONNECT, no PG protocol)", async () => {
    await startService({ tls: undefined });
    const port = Number(new URL(url).port);
    // A PostgreSQL SSLRequest / startup packet gets an HTTP error, never a PG response byte.
    const reply = await new Promise<string>((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => s.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])));
      let d = "";
      s.on("data", (x) => (d += x.toString("latin1")));
      s.on("close", () => resolve(d));
      s.on("error", () => resolve(d));
      setTimeout(() => s.destroy(), 1500);
    });
    expect(reply === "" || reply.startsWith("HTTP/1.1 400")).toBe(true);
    expect(reply).not.toMatch(/^[SN]$/);
    // CONNECT tunnelling to the database port is not supported.
    const tunnel = await new Promise<string>((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => s.write(`CONNECT 127.0.0.1:${pgc.port} HTTP/1.1\r\nHost: 127.0.0.1:${pgc.port}\r\n\r\n`));
      let d = "";
      s.on("data", (x) => (d += x.toString()));
      s.on("close", () => resolve(d));
      s.on("error", () => resolve(d));
      setTimeout(() => s.destroy(), 1500);
    });
    expect(tunnel).not.toMatch(/^HTTP\/1\.1 200/);
    for (const p of ["/v1/db", "/v1/sql", "/v1/query", "/../../postgres", "/v1/admin/set-cap"]) {
      const r = await fetch(`${url}${p}`, { method: "POST", body: "{}" });
      expect([401, 404]).toContain(r.status);
    }
  });

  // ── Part E: DRY_RUN_CHILD

  async function runDryRun(opts: { heartbeats?: number } = {}) {
    const root = await enrollRoot();
    const conway = new NamedSandboxConway();
    const dir = tmpDir();
    let childRun: Promise<Awaited<ReturnType<typeof runDryRunChild>>> | null = null;
    conway.onStart = (files) => {
      const cred = path.join(dir, "fleet-credentials.json");
      const manifest = path.join(dir, "fleet-runtime.json");
      fs.writeFileSync(cred, files[CHILD_FLEET_CREDENTIALS], { mode: 0o600 });
      fs.writeFileSync(manifest, files[CHILD_RUNTIME_MANIFEST]);
      childRun = runDryRunChild({
        env: { HOME: dir, ...FLAGS_OFF },
        credentialsFile: cred,
        manifestPath: manifest,
        walletFile: path.join(dir, "wallet.json"),
        heartbeats: opts.heartbeats ?? 2,
        intervalMs: 20,
        fetchImpl: caFetch(tls.cert),
      });
    };
    const report = await performDryRunChild({
      admin,
      env: { ...FLAGS_OFF, ...RELEASE_ENV, FLEET_DRY_RUN_CHILD: "true" },
      rootAgentId: root.agent.agentId,
      apiUrl: url,
      conway,
      fetchImpl: caFetch(tls.cert),
      allowLoopbackApiUrl: true,
      waitActiveMs: 20_000,
      pollMs: 50,
    });
    const child = childRun ? await childRun : null;
    return { root, conway, dir, report, child: child as Awaited<ReturnType<typeof runDryRunChild>> | null };
  }

  it("dry-run child: pinned install, attestation, activation, session over HTTPS, heartbeat and passed challenge -> ACTIVE", async () => {
    const { conway, dir, report, child } = await runDryRun();
    try {
      expect(report.steps.filter((s) => !s.ok), JSON.stringify(report.steps)).toEqual([]);
      expect(report.ok).toBe(true);
      expect(report.steps.map((s) => s.step)).toEqual(["preflight", "reserve", "claim", "sandbox", "install+attest", "activate", "start", "heartbeat+challenge", "zero-authority"]);
      const agentId = report.agentId!;
      // It fetched the pinned fork at the exact commit with the frozen lockfile.
      const cmds = (conway.exec as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c[0]);
      expect(cmds.some((c) => c.includes(`git fetch -q --depth 1 origin ${PIN.commit}`) && c.includes("pnpm install --frozen-lockfile") && c.includes("pnpm build"))).toBe(true);
      expect(cmds.join("\n")).not.toMatch(/--init|Conway-Research/);
      // Attested and registered in PostgreSQL.
      const lease = (await ownerRaw.query("SELECT * FROM fleet.fleet_reservations WHERE agent_id = $1", [agentId])).rows[0];
      expect(lease).toMatchObject({ status: "completed", dry_run: true });
      expect(lease.attestation).toMatchObject({ commit: PIN.commit, buildId: BUILD.buildId });
      expect(await provisioning(agentId)).toMatchObject({ dry_run: true, status: "active", external_state: "created", sandbox_name: sandboxNameFor(report.provisioningKey!) });
      // Heartbeat + challenge.
      expect(child).toMatchObject({ agentId, heartbeats: 2, status: "active", provisioningKey: report.provisioningKey });
      expect(child!.challengesPassed).toBeGreaterThanOrEqual(1);
      expect(report.authority).toMatchObject({ status: "active", dryRun: true, credentialLive: true });
      expect(report.authority!.lastChallengeOkAt).not.toBeNull();
      // What the child received: its own scoped credential and a no-secret manifest.
      const cred = JSON.parse(conway.files[CHILD_FLEET_CREDENTIALS]);
      expect(Object.keys(cred).sort()).toEqual(["agentId", "apiUrl", "token"]);
      expect(cred.apiUrl).toBe(new URL(url).origin);
      const manifest = JSON.parse(conway.files[CHILD_RUNTIME_MANIFEST]);
      expect(manifest).toMatchObject({ dryRun: true, provisioningKey: report.provisioningKey, commit: PIN.commit, buildId: BUILD.buildId });
      const everything = JSON.stringify(conway.files) + cmds.join("\n");
      expect(everything).not.toMatch(/postgresql:\/\/|FLEET_ADMIN|service\.env|admin\.env|PRIVATE_KEY/);
      expect(conway.files["/root/.automaton/wallet.json"]).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("financial: the dry-run child has zero spend authority (keyless address, custody frozen at 0, no capital, no spend)", async () => {
    const { dir, report } = await runDryRun({ heartbeats: 1 });
    try {
      const agentId = report.agentId!;
      const a = (await admin.getAgent(agentId))!;
      expect(a.walletAddress?.toLowerCase()).toBe(keylessDryRunAddress(agentId));
      expect(report.authority).toMatchObject({ spendingFrozen: true, dailyLimitCents: 0 });
      // Even the owner cannot grant it spend authority.
      await ownerRaw.query("UPDATE fleet.fleet_wallet_custody SET spending_frozen = false, daily_limit_cents = 1000000 WHERE agent_id = $1", [agentId]);
      expect(await admin.agentAuthority(agentId)).toMatchObject({ spendingFrozen: true, dailyLimitCents: 0 });
      await expect(
        ownerRaw.query(
          `INSERT INTO fleet.fleet_capital_allocations (allocation_id, agent_id, purpose, requested_amount_cents, expected_duration_days, status, proposed_by)
           VALUES ($1, $2, 'x', 100, 1, 'proposed', $2)`,
          [ulid(), agentId],
        ),
      ).rejects.toThrow(/FLEET_DRY_RUN_NO_SPEND|violates|column/);
      const cred = JSON.parse(fs.readFileSync(path.join(dir, "fleet-credentials.json"), "utf8"));
      const c = new FleetApiClient({ baseUrl: url, agentId, token: cred.token, fetchImpl: caFetch(tls.cert) });
      const spend = await c.requestSpend({ fromWallet: a.walletAddress!, toAddress: wallet(), amountCents: 1, purpose: "test" }).catch((e: Error) => e);
      if (spend instanceof Error) expect(spend.message).toMatch(/frozen|refused|FLEET/i);
      else expect(spend).toMatchObject({ executed: false }), expect(spend.decision).not.toBe("approved");
      await expect(c.proposeCapital({ purpose: "grow", requestedCents: 100, expectedReturnCents: 200, expectedDurationDays: 5 })).rejects.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the dry-run child cannot replicate (service, registry and database guards)", async () => {
    const { dir, report, root } = await runDryRun({ heartbeats: 1 });
    try {
      const agentId = report.agentId!;
      await admin.setMaxAgents(3, "test");
      // Through the service, even with replication enabled at every layer.
      await startService({ realReplicationEnabled: true });
      const cred = JSON.parse(fs.readFileSync(path.join(dir, "fleet-credentials.json"), "utf8"));
      const c = new FleetApiClient({ baseUrl: url, agentId, token: cred.token, fetchImpl: caFetch(tls.cert) });
      const r = await c.reserveSlot({ name: "grandchild" }).catch((e: Error) => ({ ok: false, reason: e.message }));
      expect(r.ok).toBe(false);
      // Through the registry API directly.
      const direct = await admin.reserveSlot({ parentAgentId: agentId, requestedBy: "t", name: "gc", runtime: PIN }).catch((e: Error) => ({ ok: false, reason: e.message }));
      expect(direct.ok).toBe(false);
      // And by the database guard itself.
      await expect(
        ownerRaw.query(
          `INSERT INTO fleet.fleet_agents (agent_id, parent_agent_id, role, generation, name, runtime_repo, runtime_commit, status)
           VALUES ($1, $2, 'child', 2, 'gc', $3, $4, 'reserved')`,
          [ulid(), agentId, PIN.repo, PIN.commit],
        ),
      ).rejects.toThrow(/FLEET_DRY_RUN_NO_REPLICATION/);
      const kids = await ownerRaw.query("SELECT count(*)::int AS n FROM fleet.fleet_agents WHERE parent_agent_id = $1", [agentId]);
      expect(kids.rows[0].n).toBe(0);
      // A dry run under a child, a second dry run, or a dry run above cap 2 are refused.
      expect((await admin.reserveDryRunSlot({ parentAgentId: agentId, requestedBy: "t", name: "x" })).ok).toBe(false);
      await admin.setMaxAgents(2, "test");
      const second = await admin.reserveDryRunSlot({ parentAgentId: root.agent.agentId, requestedBy: "t", name: "x" });
      expect(second).toMatchObject({ ok: false });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the dry-run child can be quarantined: capabilities revoked, heartbeats refused, quarantine slot held within the cap", async () => {
    const { dir, report, root } = await runDryRun({ heartbeats: 1 });
    try {
      const agentId = report.agentId!;
      expect(await admin.quarantine(agentId, "dry run complete", "operator:test")).toBe("terminating");
      await service!.processTerminations();
      expect(await status(agentId)).toBe("orphaned");
      expect(await admin.agentAuthority(agentId)).toMatchObject({ credentialLive: false, spendingFrozen: true });
      await expect(
        runDryRunChild({
          env: { HOME: dir, ...FLAGS_OFF },
          credentialsFile: path.join(dir, "fleet-credentials.json"),
          manifestPath: path.join(dir, "fleet-runtime.json"),
          walletFile: path.join(dir, "wallet.json"),
          heartbeats: 1,
          fetchImpl: caFetch(tls.cert),
        }),
      ).rejects.toThrow(/no longer accepts/);
      expect(await population()).toBe(2); // root + quarantine slot
      const next = await admin.reserveDryRunSlot({ parentAgentId: root.agent.agentId, requestedBy: "t", name: "again" });
      expect(next.ok).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the fleet stays at maximum 2 living/reserved/quarantined slots; the dry run requires cap <= 2 and REAL_* flags off", async () => {
    const root = await enrollRoot();
    expect(await population()).toBe(1);
    const dr = await admin.reserveDryRunSlot({ parentAgentId: root.agent.agentId, requestedBy: "t", name: "d" });
    expect(dr.ok).toBe(true);
    expect(await population()).toBe(2);
    const more = await admin.reserveSlot({ parentAgentId: root.agent.agentId, requestedBy: "t", name: "n", runtime: PIN });
    expect(more).toMatchObject({ ok: false, code: "FLEET_CAP_REACHED" });
    await expect(admin.registerRoot({ walletAddress: wallet(), name: "r2" })).resolves.toMatchObject({ ok: false });
    expect(await population()).toBe(2);
    await expect(ownerRaw.query("UPDATE fleet.fleet_state SET living_agents = 0")).rejects.toThrow(/FLEET_COUNTERS_READ_ONLY/);

    await reset(3);
    const r2 = await enrollRoot();
    expect(await admin.reserveDryRunSlot({ parentAgentId: r2.agent.agentId, requestedBy: "t", name: "d" })).toMatchObject({ ok: false, code: "FLEET_DRY_RUN_CAP" });
    await admin.setMaxAgents(2, "test");
    for (const flag of ["REAL_PAYMENTS_ENABLED", "OWNER_SWEEP_ENABLED", "REAL_REPLICATION_ENABLED"]) {
      const pre = await dryRunPreflight({ admin, env: { ...FLAGS_OFF, ...RELEASE_ENV, [flag]: "true" }, rootAgentId: r2.agent.agentId, apiUrl: url, fetchImpl: caFetch(tls.cert), allowLoopbackApiUrl: true });
      expect(pre.ok).toBe(false);
      expect(pre.problems.join(" ")).toContain(flag);
    }
    const clean = await dryRunPreflight({ admin, env: { ...FLAGS_OFF, ...RELEASE_ENV }, rootAgentId: r2.agent.agentId, apiUrl: url, fetchImpl: caFetch(tls.cert), allowLoopbackApiUrl: true });
    expect(clean.problems).toEqual([]);
    // Loopback / plain-HTTP controller URLs cannot serve a remote child.
    const lb = await dryRunPreflight({ admin, env: { ...FLAGS_OFF, ...RELEASE_ENV }, rootAgentId: r2.agent.agentId, apiUrl: url, fetchImpl: caFetch(tls.cert) });
    expect(lb.problems.join(" ")).toMatch(/loopback/);
    await expect(
      performDryRunChild({ admin, env: { ...FLAGS_OFF, ...RELEASE_ENV }, rootAgentId: r2.agent.agentId, apiUrl: url, conway: new NamedSandboxConway() }),
    ).rejects.toThrow(/FLEET_DRY_RUN_CHILD=true/);
  });

  // ── Part F: doctor readiness levels

  it("fleet:doctor reports SAFE FOR DRY RUN / REAL REPLICATION / REAL PAYMENTS as independent levels", async () => {
    const dir = tmpDir();
    const etc = path.join(dir, "etc");
    fs.mkdirSync(etc);
    fs.writeFileSync(path.join(etc, "admin.env"), "FLEET_ADMIN_DATABASE_URL=x\n", { mode: 0o640 });
    fs.writeFileSync(path.join(etc, "service.env"), "FLEET_SERVICE_DATABASE_URL=x\n", { mode: 0o600 });
    fs.chmodSync(path.join(etc, "admin.env"), 0o640);
    fs.chmodSync(path.join(etc, "service.env"), 0o600);
    const me = os.userInfo();
    fs.writeFileSync(path.join(dir, "passwd"), `op:x:${me.uid}:${me.gid}::/:/bin/sh\nautomaton-fleet-service:x:${me.uid + 7002}:${me.uid + 7002}::/:/usr/sbin/nologin\nautomaton-agent:x:${me.uid + 7001}:${me.uid + 7001}::/:/usr/sbin/nologin\n`);
    fs.writeFileSync(path.join(dir, "group"), `automaton-fleet-admin:x:${me.gid}:op\n`);
    fs.writeFileSync(path.join(dir, "unit"), "[Service]\n");
    const paths = { cwd: dir, etcDir: etc, adminEnv: path.join(etc, "admin.env"), serviceEnv: path.join(etc, "service.env"), passwd: path.join(dir, "passwd"), group: path.join(dir, "group"), systemdUnit: path.join(dir, "unit") };
    await enrollRoot();
    const remoteEnv = {
      FLEET_REMOTE_LISTEN_ENABLED: "true",
      FLEET_PUBLIC_HOSTNAME: "localhost",
      FLEET_TLS_CERT_FILE: tls.certFile,
      FLEET_TLS_KEY_FILE: tls.keyFile,
    };
    const started = await startFleetServiceFromEnv(
      { FLEET_SERVICE_DATABASE_URL: pgc.serviceUrl, FLEET_AGENT_DATABASE_URL: pgc.agentUrl, FLEET_API_LISTEN: "127.0.0.1:0", FLEET_PUBLIC_LISTEN: "127.0.0.1:0", FLEET_REAPER_INTERVAL_MS: "60000", ...RELEASE_ENV, ...remoteEnv },
      { log: () => {} },
    );
    try {
      await started.service.reapOnce();
      const env = { ...FLAGS_OFF, ...RELEASE_ENV, ...remoteEnv, FLEET_API_URL: started.url, FLEET_PUBLIC_URL: started.publicUrl! };
      const doctor = (e: Record<string, string>) =>
        runDoctor({ env: e, store: admin, paths, fetchImpl: caFetch(tls.cert), serviceActive: async () => "active" });
      const r = await doctor(env);
      expect(r.checklist.filter((c) => !c.ok), formatChecklist(r)).toEqual([]);
      expect(r.checklist.map((c) => c.item)).toEqual([
        "PostgreSQL roles correct", "schema v6", "controller service active", "privileged secrets protected", "runtime repo pinned",
        "runtime commit pinned", "build ID pinned", "HTTPS valid", "remote controller reachable", "replay protection working",
        "agent credentials scoped", "payments disabled", "owner sweeps disabled", "fleet cap = 2", "no unresolved orphan", "no stuck reservation",
      ]);
      expect(r.readiness.dryRun).toEqual({ safe: true, blockers: [] });
      expect(r.readiness.realReplication.safe).toBe(false);
      expect(r.readiness.realReplication.blockers.join("\n")).toMatch(/No dry-run child has yet reached ACTIVE/);
      expect(r.readiness.realReplication.blockers.join("\n")).toMatch(/Sandbox termination cannot be guaranteed/);
      expect(r.readiness.realPayments.safe).toBe(false);
      expect(r.readiness.realPayments.blockers.join("\n")).toMatch(/custody signer/);
      expect(r.readiness.realPayments.blockers.join("\n")).not.toMatch(/dry-run/);
      const text = formatChecklist(r);
      expect(text).toMatch(/SAFE FOR DRY RUN:\s+YES/);
      expect(text).toMatch(/SAFE FOR REAL REPLICATION:\s+NO/);
      expect(text).toMatch(/SAFE FOR REAL PAYMENTS:\s+NO/);

      // Enabling payments makes the fleet unsafe even for a dry run; a wrong cap too.
      const paid = await doctor({ ...env, REAL_PAYMENTS_ENABLED: "true" });
      expect(paid.readiness.dryRun.safe).toBe(false);
      await admin.setMaxAgents(5, "test");
      expect((await doctor(env)).readiness.dryRun.blockers.join(" ")).toMatch(/fleet cap = 2/);
      await admin.setMaxAgents(2, "test");
      // A world-readable service secret or a missing certificate breaks dry-run readiness.
      fs.chmodSync(path.join(etc, "service.env"), 0o644);
      expect((await doctor(env)).readiness.dryRun.blockers.join(" ")).toMatch(/privileged secrets/);
      fs.chmodSync(path.join(etc, "service.env"), 0o600);
      expect((await doctor({ ...env, FLEET_PUBLIC_HOSTNAME: "fleet.example.com" })).readiness.dryRun.blockers.join(" ")).toMatch(/HTTPS valid/);
      // An unreconciled provisioning attempt blocks all three levels' prerequisites.
      const root2 = (await admin.listAgents()).find((a) => a.role === "root")!;
      const k = await claimed(root2.agentId);
      await k.claimed.recordSandboxIntent!(sandboxNameFor(k.reservationId));
      await expireLease(k.agentId);
      await svc.reap("t");
      const stuck = await doctor(env);
      expect(stuck.readiness.dryRun.blockers.join(" ")).toMatch(/no unresolved orphan|no stuck reservation/);
    } finally {
      await started.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
