/**
 * Fleet Layer Tests (Phase 2): shared PostgreSQL registry + pinned runtime.
 *
 * PostgreSQL tests run in a throwaway schema (fleet_test_<ulid>) inside the
 * database named by FLEET_TEST_DATABASE_URL, DATABASE_URL, or .env.fleet,
 * and drop it afterwards. They are skipped (loudly) when none is configured.
 *
 * Describe names include "policy", "security" and "financial" so these tests
 * also run under test:security and test:financial.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import { randomBytes } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { ulid } from "ulid";
import {
  DEFAULT_FLEET_CONFIG,
  FleetDuplicateRegistrationError,
  FleetRuntimeError,
  FleetBypassError,
  PgFleetStore,
  SharedFleetController,
  isUpstreamRepo,
  loadFleetConfig,
  resolveChildRuntime,
  setActiveSharedFleet,
  validateRuntimePin,
  verifyOwnRuntime,
} from "../../fleet/index.js";
import type { FleetConfig, FleetSpawnGrant, RuntimePin } from "../../fleet/index.js";
import { claimFleetGrant } from "../../fleet/grants.js";
import { FleetRegistry } from "../../fleet/registry.js";
import { buildRuntimeInstallCommand, checkRuntimeVerification } from "../../fleet/runtime.js";
import { scrubDetail } from "../../fleet/postgres/store.js";
import { readEnvFile } from "../../fleet/postgres/cli.js";
import { spawnChild } from "../../replication/spawn.js";
import { ChildLifecycle } from "../../replication/lifecycle.js";
import { createBuiltinTools } from "../../agent/tools.js";
import { PolicyEngine } from "../../agent/policy-engine.js";
import { createDefaultRules } from "../../agent/policy-rules/index.js";
import { getForbiddenCommandMatch } from "../../agent/policy-rules/command-safety.js";
import { isProtectedFile } from "../../self-mod/code.js";
import { DEFAULT_TREASURY_POLICY } from "../../types.js";
import type { AutomatonDatabase, GenesisConfig, ToolContext } from "../../types.js";
import {
  MockConwayClient,
  MockInferenceClient,
  TEST_RUNTIME_PIN,
  createTestConfig,
  createTestDb,
  createTestIdentity,
  runtimeVerifyStdout,
  stubRuntimePinEnv,
} from "../mocks.js";

vi.mock("../../registry/erc8004.js", () => ({
  queryAgent: vi.fn(),
  getTotalAgents: vi.fn().mockResolvedValue(0),
  registerAgent: vi.fn(),
  leaveFeedback: vi.fn(),
}));

// ─── Helpers ────────────────────────────────────────────────────

const PIN: RuntimePin = TEST_RUNTIME_PIN;
const identity = createTestIdentity();
const UNREACHABLE_URL = "postgresql://nobody:nothing@127.0.0.1:1/none";

const PG_URL =
  process.env.FLEET_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  readEnvFile(path.resolve(".env.fleet")).DATABASE_URL ||
  "";

function wallet(): string {
  return `0x${randomBytes(20).toString("hex")}`;
}

function fleetConfig(overrides: Partial<FleetConfig> = {}): FleetConfig {
  return {
    ...DEFAULT_FLEET_CONFIG,
    configuredMode: "EXPANSION",
    realReplicationEnabled: true,
    maxAgents: 50,
    runtime: PIN,
    ...overrides,
  };
}

const genesis: GenesisConfig = {
  name: "fleet-child",
  genesisPrompt: "You are a fleet child.",
  creatorAddress: identity.address,
  parentAddress: identity.address,
};

/** Stand-in for spawnChild against the shared registry: claim, yield, report verified runtime. */
function fakeSharedSpawn(localDb: AutomatonDatabase, calls: { n: number } = { n: 0 }) {
  return async (grant: FleetSpawnGrant) => {
    calls.n++;
    const claimed = await claimFleetGrant(grant, ulid(), localDb.raw);
    await new Promise((r) => setTimeout(r, 5));
    return { address: wallet(), sandboxId: `sbx-${ulid()}`, runtimeCommit: claimed.runtime!.commit, runtimeVersion: "0.2.1" };
  };
}

function mockConwayForPinnedSpawn(
  opts: { verify?: Parameters<typeof runtimeVerifyStdout>[0]; wallet?: string } = {},
): MockConwayClient {
  const conway = new MockConwayClient();
  const w = opts.wallet ?? wallet();
  vi.spyOn(conway, "exec").mockImplementation(async (command: string) => {
    if (command.includes("FLEET_RUNTIME_VERIFY")) {
      return { stdout: runtimeVerifyStdout(opts.verify), stderr: "", exitCode: 0 };
    }
    if (command.includes("--init")) return { stdout: `Wallet initialized: ${w}`, stderr: "", exitCode: 0 };
    return { stdout: "ok", stderr: "", exitCode: 0 };
  });
  return conway;
}

// ─── Pinned runtime: pure validation ────────────────────────────

describe("Fleet security: pinned child runtime validation", () => {
  it("rejects the upstream Conway Research repository in every spelling", () => {
    for (const repo of [
      "https://github.com/Conway-Research/automaton",
      "https://github.com/Conway-Research/automaton.git",
      "https://github.com/conway-research/AUTOMATON/",
      "git@github.com:Conway-Research/automaton.git",
      "ssh://git@github.com/Conway-Research/automaton",
      "https://gitlab.com/conway-research/automaton",
    ]) {
      expect(isUpstreamRepo(repo)).toBe(true);
      const v = validateRuntimePin(repo, PIN.commit);
      expect(v.ok).toBe(false);
    }
    expect(() => resolveChildRuntime({ repo: "https://github.com/Conway-Research/automaton", commit: PIN.commit })).toThrow(FleetRuntimeError);
  });

  it("rejects arbitrary/unsafe repositories and non-SHA commits", () => {
    for (const repo of [
      "http://github.com/example-fleet/automaton-fleet",
      "https://user:pass@github.com/example-fleet/automaton-fleet",
      "https://github.com/example-fleet/automaton-fleet?ref=main",
      "https://github.com/example-fleet/automaton-fleet;rm -rf /",
      "file:///tmp/evil",
      "/tmp/evil",
      "https://github.com/../automaton",
    ]) {
      expect(validateRuntimePin(repo, PIN.commit).ok).toBe(false);
    }
    for (const commit of ["main", "HEAD", "v0.2.1", "0123456", PIN.commit + "0", "g".repeat(40), ""]) {
      expect(validateRuntimePin(PIN.repo, commit).ok).toBe(false);
    }
    expect(validateRuntimePin(PIN.repo + ".git", PIN.commit.toUpperCase())).toEqual({ ok: true, pin: PIN });
  });

  it("an agent cannot choose a different repo or commit than the parent-approved pin", () => {
    expect(() => resolveChildRuntime(PIN, { repo: "https://github.com/attacker/automaton" })).toThrow(/does not match/);
    expect(() => resolveChildRuntime(PIN, { commit: "f".repeat(40) })).toThrow(/does not match/);
    expect(() => resolveChildRuntime(PIN, { repo: "https://github.com/Conway-Research/automaton" })).toThrow(/Upstream/);
    expect(() => resolveChildRuntime(null)).toThrow(/No approved fleet runtime/);
    expect(resolveChildRuntime(PIN, { repo: PIN.repo, commit: PIN.commit })).toEqual(PIN);
  });

  it("install command fetches exactly the pinned commit of the fleet fork", () => {
    const cmd = buildRuntimeInstallCommand(PIN);
    expect(cmd).toContain(`git remote add origin '${PIN.repo}'`);
    expect(cmd).toContain(`git fetch -q --depth 1 origin ${PIN.commit}`);
    expect(cmd).toContain(`git checkout -q --detach ${PIN.commit}`);
    expect(cmd).not.toMatch(/Conway-Research|git clone/i);
  });

  it("verification rejects wrong commit, wrong origin, dirty sources and empty output", () => {
    expect(checkRuntimeVerification(runtimeVerifyStdout(), PIN).commit).toBe(PIN.commit);
    expect(() => checkRuntimeVerification(runtimeVerifyStdout({ commit: "a".repeat(40) }), PIN)).toThrow(/does not match pinned/);
    expect(() => checkRuntimeVerification(runtimeVerifyStdout({ repo: "https://github.com/Conway-Research/automaton" }), PIN)).toThrow(/origin/);
    expect(() => checkRuntimeVerification(runtimeVerifyStdout({ clean: false }), PIN)).toThrow(/sources differ/);
    expect(() => checkRuntimeVerification("ok", PIN)).toThrow(/no result/);
  });

  it("FLEET_RUNTIME_REPO/COMMIT are parsed into config; invalid values yield no pin", () => {
    expect(loadFleetConfig({ FLEET_RUNTIME_REPO: PIN.repo, FLEET_RUNTIME_COMMIT: PIN.commit }).runtime).toEqual(PIN);
    expect(loadFleetConfig({ FLEET_RUNTIME_REPO: "https://github.com/Conway-Research/automaton", FLEET_RUNTIME_COMMIT: PIN.commit }).runtime).toBeNull();
    expect(loadFleetConfig({}).runtime).toBeNull();
  });
});

// ─── Pinned runtime: spawnChild ─────────────────────────────────

describe("Fleet security: spawnChild uses the pinned fleet runtime", () => {
  let db: AutomatonDatabase;
  beforeEach(() => {
    db = createTestDb();
    stubRuntimePinEnv(vi.stubEnv);
  });
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /** Local (SQLite) grant: spawnChild reads the pin from FLEET_RUNTIME_* env. */
  function localGrant(): FleetSpawnGrant {
    const r = new FleetRegistry(db.raw);
    r.setMaxAgents(5);
    const root = r.ensureRootAgent({ address: identity.address, name: "root" });
    const res = r.reserveSlot({ parentAgentId: root.id, requestedBy: identity.address, name: "c" });
    if (!res.ok) throw new Error(res.reason);
    return res.grant;
  }

  it("child uses the pinned fleet runtime and never clones upstream (correct commit accepted)", async () => {
    const conway = mockConwayForPinnedSpawn();
    const child = await spawnChild(conway, identity, db, genesis, new ChildLifecycle(db.raw), localGrant());
    const commands = (conway.exec as any).mock.calls.map((c: any[]) => c[0] as string);
    expect(commands.join("\n")).not.toMatch(/Conway-Research|git clone/i);
    expect(commands.some((c: string) => c.includes(`git fetch -q --depth 1 origin ${PIN.commit}`))).toBe(true);
    expect(child.runtimeCommit).toBe(PIN.commit);
    const manifest = JSON.parse(conway.files["/root/.automaton/fleet-runtime.json"]);
    expect(manifest).toMatchObject({ repo: PIN.repo, commit: PIN.commit, generation: 1 });
    expect(JSON.stringify(manifest)).not.toMatch(/private|secret|postgres/i);
  });

  it("wrong commit in the sandbox is rejected before genesis or wallet init", async () => {
    const conway = mockConwayForPinnedSpawn({ verify: { commit: "b".repeat(40) } });
    await expect(spawnChild(conway, identity, db, genesis, new ChildLifecycle(db.raw), localGrant())).rejects.toThrow(FleetRuntimeError);
    const commands = (conway.exec as any).mock.calls.map((c: any[]) => c[0] as string);
    expect(commands.some((c: string) => c.includes("--init"))).toBe(false);
    expect(conway.files["/root/.automaton/genesis.json"]).toBeUndefined();
  });

  it("upstream repo pin is rejected before any sandbox is created", async () => {
    vi.stubEnv("FLEET_RUNTIME_REPO", "https://github.com/Conway-Research/automaton.git");
    const conway = mockConwayForPinnedSpawn();
    const createSpy = vi.spyOn(conway, "createSandbox");
    await expect(spawnChild(conway, identity, db, genesis, new ChildLifecycle(db.raw), localGrant())).rejects.toThrow(FleetRuntimeError);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("missing pin is rejected before any sandbox is created (both spawn paths)", async () => {
    vi.stubEnv("FLEET_RUNTIME_COMMIT", "");
    const conway = mockConwayForPinnedSpawn();
    const createSpy = vi.spyOn(conway, "createSandbox");
    await expect(spawnChild(conway, identity, db, genesis, new ChildLifecycle(db.raw), localGrant())).rejects.toThrow(/No approved fleet runtime/);
    await expect(spawnChild(conway, identity, db, genesis, undefined, localGrant())).rejects.toThrow(/No approved fleet runtime/);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("start_child refuses a child whose runtime cannot be verified", async () => {
    db.raw.prepare(
      "INSERT INTO children (id, name, address, sandbox_id, genesis_prompt, status) VALUES ('c1','kid',?, 's', 'g', 'funded')",
    ).run(wallet());
    const conway = mockConwayForPinnedSpawn();
    const tool = createBuiltinTools("sbx").find((t) => t.name === "start_child")!;
    const ctx: ToolContext = { identity, config: createTestConfig(), db, conway, inference: new MockInferenceClient() };
    // No shared registry => no fleet-approved runtime => refused.
    const out = await tool.execute({ child_id: "c1" }, ctx);
    expect(out).toContain("FLEET_RUNTIME_UNVERIFIED");
    const commands = (conway.exec as any).mock.calls.map((c: any[]) => c[0] as string);
    expect(commands.some((c: string) => c.includes("--run"))).toBe(false);
  });
});

// ─── Child-side startup self-check ──────────────────────────────

describe("Fleet security: child refuses startup on unverifiable runtime", () => {
  let dir: string;
  let head: string;
  let manifestPath: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-runtime-"));
    const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "export {};\n");
    fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
    git("add", ".");
    git("commit", "-qm", "init");
    git("remote", "add", "origin", PIN.repo + ".git");
    head = git("rev-parse", "HEAD");
    manifestPath = path.join(dir, "fleet-runtime.json");
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  function writeManifest(commit: string, repo = PIN.repo) {
    fs.writeFileSync(manifestPath, JSON.stringify({ agentId: ulid(), parentAgentId: ulid(), generation: 1, repo, commit }));
  }

  it("accepts the correct pinned commit", () => {
    writeManifest(head);
    const r = verifyOwnRuntime({ isChild: true, manifestPath, runtimeDir: dir });
    expect(r.ok).toBe(true);
  });

  it("refuses a wrong commit", () => {
    writeManifest("c".repeat(40));
    const r = verifyOwnRuntime({ isChild: true, manifestPath, runtimeDir: dir });
    expect(r.ok).toBe(false);
  });

  it("refuses an upstream manifest", () => {
    writeManifest(head, "https://github.com/Conway-Research/automaton");
    expect(verifyOwnRuntime({ isChild: true, manifestPath, runtimeDir: dir }).ok).toBe(false);
  });

  it("refuses modified sources", () => {
    writeManifest(head);
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const evil = 1;\n");
    try {
      expect(verifyOwnRuntime({ isChild: true, manifestPath, runtimeDir: dir }).ok).toBe(false);
    } finally {
      fs.writeFileSync(path.join(dir, "src", "a.ts"), "export {};\n");
    }
  });

  it("refuses a child with no manifest; a root needs none", () => {
    const missing = path.join(dir, "missing.json");
    expect(verifyOwnRuntime({ isChild: true, manifestPath: missing, runtimeDir: dir }).ok).toBe(false);
    expect(verifyOwnRuntime({ isChild: false, manifestPath: missing, runtimeDir: dir }).ok).toBe(true);
  });
});

// ─── Configuration safety ───────────────────────────────────────

describe("Fleet financial safety flags (treasury)", () => {
  it(".env.fleet keeps real replication, payments and owner sweep disabled", () => {
    const file = path.resolve(".env.fleet");
    if (!fs.existsSync(file)) return;
    const env = readEnvFile(file);
    expect(env.REAL_REPLICATION_ENABLED).toBe("false");
    expect(env.REAL_PAYMENTS_ENABLED).toBe("false");
    expect(env.OWNER_SWEEP_ENABLED).toBe("false");
    const cfg = loadFleetConfig(env);
    expect(cfg.realReplicationEnabled).toBe(false);
    expect(cfg.realPaymentsEnabled).toBe(false);
    expect(cfg.ownerSweepEnabled).toBe(false);
  });

  it("shared-registry and runtime tampering via shell is forbidden; new guard files are protected", () => {
    for (const cmd of [
      `psql "$DATABASE_URL" -c "UPDATE fleet.fleet_state SET max_agents = 50"`,
      `psql -c "UPDATE fleet_state SET operating_mode='EXPANSION'"`,
      `psql -c "INSERT INTO fleet.fleet_agents VALUES (1)"`,
      `psql -c "ALTER TABLE fleet.fleet_agents DISABLE TRIGGER ALL"`,
      `psql -c "SET session_replication_role = replica"`,
      `psql -c "DROP SCHEMA fleet CASCADE"`,
      `pnpm fleet:admin set-cap 50`,
      `FLEET_RUNTIME_REPO=https://github.com/x/y node dist/index.js`,
      `export DATABASE_URL=postgres://x`,
    ]) {
      expect(getForbiddenCommandMatch(cmd), cmd).not.toBeNull();
    }
    for (const f of ["src/fleet/runtime.ts", "src/fleet/grants.ts", "src/fleet/shared.ts", "src/fleet/shared-controller.ts", "src/fleet/postgres/store.ts", "src/fleet/postgres/migrations.ts", "src/replication/lifecycle.ts"]) {
      expect(isProtectedFile(path.resolve(f)), f).toBe(true);
    }
  });

  it("audit detail never stores secrets", () => {
    const d = scrubDetail({
      privateKey: "0x" + "a".repeat(64),
      note: `key 0x${"b".repeat(64)} url postgresql://u:p@h/db`,
      nested: { apiKey: "x", ok: 1 },
      walletAddress: "0x" + "c".repeat(40),
    });
    expect(JSON.stringify(d)).not.toMatch(/a{64}|b{64}|u:p@/);
    expect(d.walletAddress).toBe("0x" + "c".repeat(40));
    expect((d.nested as any).apiKey).toBe("[redacted]");
  });
});

// ─── PostgreSQL unavailable ─────────────────────────────────────

describe("Fleet policy: PostgreSQL unavailable fails closed", () => {
  let db: AutomatonDatabase;
  let controller: SharedFleetController;

  beforeEach(async () => {
    db = createTestDb();
    controller = new SharedFleetController({
      store: new PgFleetStore({ connectionString: UNREACHABLE_URL, connectTimeoutMs: 500 }),
      config: fleetConfig({ maxAgents: 5 }),
      self: { address: identity.address, name: "root" },
      isRootAgent: true,
      getFinancialSnapshot: async () => ({ creditsCents: 10_000, survivalTier: "high" }),
    });
    await controller.init();
  });
  afterEach(async () => {
    setActiveSharedFleet(null);
    await controller.close();
    db.close();
  });

  it("health check reports the registry down", async () => {
    const h = await controller.store.health();
    expect(h.ok).toBe(false);
    expect(h.error).toBeTruthy();
    expect(controller.snapshot().healthy).toBe(false);
  });

  it("replication is denied and no slot is granted", async () => {
    const calls = { n: 0 };
    const out = await controller.requestReplication({ name: "c" }, fakeSharedSpawn(db, calls));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.decision.code).toBe("FLEET_REGISTRY_UNAVAILABLE");
    expect(calls.n).toBe(0);
  });

  it("policy rule denies replication tools but not ordinary work", () => {
    setActiveSharedFleet(controller);
    const tools = createBuiltinTools("sbx");
    const ctx: ToolContext = { identity, config: createTestConfig(), db, conway: new MockConwayClient(), inference: new MockInferenceClient() };
    const engine = new PolicyEngine(db.raw, createDefaultRules(DEFAULT_TREASURY_POLICY, fleetConfig({ maxAgents: 5, realPaymentsEnabled: true })));
    const spend = {
      recordSpend: () => {}, getHourlySpend: () => 0, getDailySpend: () => 0, getTotalSpend: () => 0,
      checkLimit: () => ({ allowed: true, currentHourlySpend: 0, currentDailySpend: 0, limitHourly: 0, limitDaily: 0 }),
      pruneOldRecords: () => 0,
    };
    const evalTool = (name: string, args: Record<string, unknown>) =>
      engine.evaluate({ tool: tools.find((t) => t.name === name)!, args, context: ctx, turnContext: { inputSource: "agent", turnToolCallCount: 0, sessionSpend: spend } });

    for (const [name, args] of [["spawn_child", { name: "c" }], ["start_child", { child_id: "c" }], ["fund_child", { child_id: "c", amount_cents: 1 }]] as const) {
      const d = evalTool(name, args);
      expect(d.action, name).toBe("deny");
      expect(d.reasonCode, name).toBe("FLEET_REGISTRY_UNAVAILABLE");
    }
    expect(evalTool("check_credits", {}).rulesTriggered).not.toContain("fleet.policy_gate");
    expect(evalTool("transfer_credits", { to_address: "0x1111111111111111111111111111111111111111", amount_cents: 1 }).rulesTriggered)
      .not.toContain("fleet.policy_gate");
  });

  it("spawn_child tool fails closed without touching Conway", async () => {
    setActiveSharedFleet(controller);
    vi.stubEnv("FLEET_MODE", "EXPANSION");
    vi.stubEnv("REAL_REPLICATION_ENABLED", "true");
    try {
      const conway = mockConwayForPinnedSpawn();
      const createSpy = vi.spyOn(conway, "createSandbox");
      const tool = createBuiltinTools("sbx").find((t) => t.name === "spawn_child")!;
      const out = await tool.execute({ name: "c" }, { identity, config: createTestConfig(), db, conway, inference: new MockInferenceClient() });
      expect(out).toContain("Blocked: FLEET_REGISTRY_UNAVAILABLE");
      expect(createSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ─── PostgreSQL shared registry ─────────────────────────────────

describe.skipIf(!PG_URL)("Fleet policy: shared PostgreSQL registry", () => {
  const schema = `fleet_test_${ulid().toLowerCase()}`;
  let admin: PgFleetStore;
  let raw: pg.Pool;
  const opened: Array<{ close(): Promise<void> }> = [];

  function newStore(extra: Partial<ConstructorParameters<typeof PgFleetStore>[0]> = {}): PgFleetStore {
    const s = new PgFleetStore({ connectionString: PG_URL, schema, ...extra });
    opened.push(s);
    return s;
  }

  function newController(opts: { maxAgents?: number; isRootAgent?: boolean; selfAgentId?: string; address?: string; config?: Partial<FleetConfig>; store?: PgFleetStore } = {}) {
    const c = new SharedFleetController({
      store: opts.store ?? newStore(),
      config: fleetConfig({ maxAgents: opts.maxAgents ?? 50, ...opts.config }),
      self: { address: opts.address ?? identity.address, name: "root" },
      isRootAgent: opts.isRootAgent ?? true,
      selfAgentId: opts.selfAgentId,
      getFinancialSnapshot: async () => ({ creditsCents: 10_000, survivalTier: "high" }),
    });
    return c;
  }

  async function occupancy() {
    const s = await admin.getState();
    const counts = await raw.query(
      `SELECT count(*) FILTER (WHERE status = 'active')::int AS living,
              count(*) FILTER (WHERE status IN ('reserved','provisioning'))::int AS reserved,
              count(*)::int AS total
         FROM ${schema}.fleet_agents`,
    );
    return { ...s, rows: counts.rows[0] as { living: number; reserved: number; total: number } };
  }

  /** Wipe agents between tests (bypassing history triggers only in the throwaway schema). */
  async function reset(max: number, mode: "EXPANSION" | "DEVELOPMENT" = "EXPANSION") {
    // The table owner can disable triggers — acceptable only in this throwaway
    // schema, and the reason agents must not hold the owner role in production.
    const c = await raw.connect();
    try {
      await c.query("BEGIN");
      // Same lock order as reservations (fleet_state first) to avoid deadlocks.
      await c.query(`LOCK TABLE ${schema}.fleet_state, ${schema}.fleet_agents, ${schema}.fleet_events IN ACCESS EXCLUSIVE MODE`);
      for (const t of ["fleet_agents", "fleet_events", "fleet_state"]) await c.query(`ALTER TABLE ${schema}.${t} DISABLE TRIGGER USER`);
      await c.query(`DELETE FROM ${schema}.fleet_agents`);
      await c.query(`DELETE FROM ${schema}.fleet_events`);
      await c.query(`UPDATE ${schema}.fleet_state SET living_agents = 0, reserved_slots = 0`);
      for (const t of ["fleet_agents", "fleet_events", "fleet_state"]) await c.query(`ALTER TABLE ${schema}.${t} ENABLE TRIGGER USER`);
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    } finally {
      c.release();
    }
    await admin.setMaxAgents(max, "test");
    await admin.setOperatingMode(mode, "test", "test");
    await admin.setApprovedRuntime(PIN, "test");
  }

  beforeAll(async () => {
    raw = new pg.Pool({ connectionString: PG_URL, max: 25 });
    admin = newStore();
    await admin.migrate();
  });

  afterAll(async () => {
    setActiveSharedFleet(null);
    for (const s of opened) await s.close();
    await raw.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await raw.end();
  });

  let db: AutomatonDatabase;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    setActiveSharedFleet(null);
    db.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  // ── Schema & migrations ──

  it("migrations are idempotent and safe to run concurrently", async () => {
    const results = await Promise.all([newStore().migrate(), newStore().migrate(), newStore().migrate()]);
    expect(results.flat()).toEqual([]);
    const h = await admin.health();
    expect(h).toMatchObject({ ok: true, schemaVersion: 1, countersConsistent: true });
  });

  it("schema holds the required columns and no secret columns", async () => {
    const cols = await raw.query(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1",
      [schema],
    );
    const byTable = (t: string) => cols.rows.filter((r) => r.table_name === t).map((r) => r.column_name);
    expect(byTable("fleet_agents")).toEqual(expect.arrayContaining([
      "agent_id", "parent_agent_id", "generation", "wallet_address", "runtime_version", "runtime_commit",
      "status", "created_at", "last_heartbeat", "death_time",
    ]));
    expect(byTable("fleet_state")).toEqual(expect.arrayContaining([
      "living_agents", "max_agents", "operating_mode", "reserved_slots", "updated_at",
    ]));
    for (const r of cols.rows) expect(r.column_name).not.toMatch(/private|secret|mnemonic|seed|password|api_key/);
  });

  it("wallet_address cannot hold a private key", async () => {
    await reset(5);
    await expect(
      raw.query(
        `INSERT INTO ${schema}.fleet_agents (agent_id, role, generation, name, wallet_address, status) VALUES ($1, 'root', 0, 'x', $2, 'active')`,
        [ulid(), "0x" + "ab".repeat(32)],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("schema version mismatch makes the store unavailable (fail closed)", async () => {
    const other = new PgFleetStore({ connectionString: PG_URL, schema: `fleet_missing_${ulid().toLowerCase()}` });
    opened.push(other);
    expect((await other.health()).ok).toBe(false);
    await expect(other.getState()).rejects.toThrow(/FLEET|schema/i);
  });

  // ── Identity & heartbeats ──

  it("agent ids are stable: re-registering the same wallet returns the same agent", async () => {
    await reset(3);
    const a = newController();
    const b = newController(); // a second process / sandbox for the same agent
    await a.init();
    await b.init();
    expect(a.agentId).toMatch(/^[0-9A-Z]{26}$/);
    expect(b.agentId).toBe(a.agentId);
    expect((await occupancy()).rows.total).toBe(1);
  });

  it("duplicate heartbeat does not duplicate the agent", async () => {
    await reset(3);
    const c = newController();
    await c.init();
    const results = await Promise.all(Array.from({ length: 10 }, () => c.heartbeat()));
    expect(results.every(Boolean)).toBe(true);
    expect(await admin.heartbeat(ulid())).toBe(false); // unknown agent: never inserted
    const occ = await occupancy();
    expect(occ.rows.total).toBe(1);
    expect(occ.livingAgents).toBe(1);
    const agent = await admin.getAgent(c.agentId!);
    expect(agent!.lastHeartbeat).not.toBeNull();
  });

  // ── Global cap ──

  it("20 concurrent requests at fleet cap 2 yield exactly 2 living/reserved agents", async () => {
    await reset(2);
    const root = newController();
    await root.init();
    const calls = { n: 0 };
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => root.requestReplication({ name: `c${i}` }, fakeSharedSpawn(db, calls))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.decision.code === "FLEET_CAP_REACHED")).toBe(true);
    expect(calls.n).toBe(1);
    const occ = await occupancy();
    expect(occ.livingAgents + occ.reservedSlots).toBe(2);
    expect(occ.rows.living + occ.rows.reserved).toBe(2);
    expect((await admin.health()).countersConsistent).toBe(true);
  });

  it("20 concurrent requests from 20 independent agent connections at cap 2 yield exactly 2", async () => {
    await reset(2);
    const root = newController();
    await root.init();
    const controllers = Array.from({ length: 20 }, () => newController({ store: newStore({ poolMax: 1 }) }));
    await Promise.all(controllers.map((c) => c.init()));
    const results = await Promise.all(controllers.map((c, i) => c.requestReplication({ name: `c${i}` }, fakeSharedSpawn(db))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const occ = await occupancy();
    expect(occ.livingAgents + occ.reservedSlots).toBe(2);
  });

  it("20 concurrent OS processes at cap 2 yield exactly 2 living/reserved agents", async () => {
    await reset(2);
    const root = newController();
    await root.init();
    const run = promisify(execFile);
    const tsx = path.resolve("node_modules/.bin/tsx");
    const worker = path.resolve("src/__tests__/fleet/fixtures/pg-reserve-worker.ts");
    const startAt = Date.now() + 8000;
    const outputs = await Promise.all(
      Array.from({ length: 20 }, () =>
        run(tsx, [worker, schema, root.agentId!, String(startAt), PIN.repo, PIN.commit], {
          timeout: 60_000,
          env: { ...process.env, FLEET_TEST_DATABASE_URL: PG_URL },
        }).then((r) => JSON.parse(r.stdout)),
      ),
    );
    expect(outputs.filter((o) => o.ok)).toHaveLength(1);
    expect(outputs.filter((o) => !o.ok).every((o) => o.code === "FLEET_CAP_REACHED")).toBe(true);
    const occ = await occupancy();
    expect(occ.livingAgents + occ.reservedSlots).toBe(2);
  }, 90_000);

  it("no race can exceed the cap: randomized churn with failures and deaths", async () => {
    await reset(5);
    const root = newController();
    await root.init();
    let peak = 0;
    const sample = async () => {
      const r = await raw.query(`SELECT count(*)::int AS n FROM ${schema}.fleet_agents WHERE status IN ('reserved','provisioning','active')`);
      peak = Math.max(peak, r.rows[0].n);
    };
    for (let round = 0; round < 4; round++) {
      const results = await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          root
            .requestReplication({ name: `r${round}-${i}` }, async (grant) => {
              const child = await fakeSharedSpawn(db)(grant);
              await sample();
              if (Math.random() < 0.3) throw new Error("provision failed");
              return child;
            })
            .catch(() => null),
        ),
      );
      await sample();
      // Kill some living children to free slots for the next round.
      for (const r of results) if (r && r.ok && Math.random() < 0.5) await admin.markDead(r.agentId, "churn");
      const occ = await occupancy();
      expect(occ.livingAgents + occ.reservedSlots).toBeLessThanOrEqual(5);
      expect((await admin.health()).countersConsistent).toBe(true);
    }
    expect(peak).toBeLessThanOrEqual(5);
  });

  it("raw SQL cannot exceed the cap even from 20 concurrent connections (trigger backstop)", async () => {
    await reset(3);
    const root = newController();
    await root.init();
    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        raw.query(
          `INSERT INTO ${schema}.fleet_agents (agent_id, parent_agent_id, role, generation, name, runtime_commit, status)
           VALUES ($1, $2, 'child', 1, 'raw', $3, 'reserved')`,
          [ulid(), root.agentId, PIN.commit],
        ),
      ),
    );
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(2);
    for (const a of attempts) if (a.status === "rejected") expect(String(a.reason)).toMatch(/FLEET_CAP_EXCEEDED/);
    const occ = await occupancy();
    expect(occ.livingAgents + occ.reservedSlots).toBe(3);
  });

  it("counters are read-only and history cannot be deleted or revived", async () => {
    await reset(3);
    const root = newController();
    await root.init();
    await expect(raw.query(`UPDATE ${schema}.fleet_state SET living_agents = 0`)).rejects.toThrow(/FLEET_COUNTERS_READ_ONLY/);
    await expect(raw.query(`UPDATE ${schema}.fleet_state SET max_agents = 51`)).rejects.toThrow(/check constraint/);
    await expect(raw.query(`DELETE FROM ${schema}.fleet_agents`)).rejects.toThrow(/FLEET_HISTORY_IMMUTABLE/);
    await expect(raw.query(`DELETE FROM ${schema}.fleet_events`)).rejects.toThrow(/FLEET_HISTORY_IMMUTABLE/);
    await expect(raw.query(`TRUNCATE ${schema}.fleet_agents CASCADE`)).rejects.toThrow(/FLEET_HISTORY_IMMUTABLE/);
  });

  // ── Slot lifecycle ──

  it("failed provision returns the slot", async () => {
    await reset(2);
    const root = newController();
    await root.init();
    await expect(
      root.requestReplication({ name: "c1" }, async (grant) => {
        await claimFleetGrant(grant, ulid(), db.raw);
        throw new Error("sandbox exploded");
      }),
    ).rejects.toThrow("sandbox exploded");
    let occ = await occupancy();
    expect(occ.reservedSlots).toBe(0);
    expect(occ.livingAgents).toBe(1);
    const failed = await admin.listAgents({ living: false });
    expect(failed).toHaveLength(1);
    expect(failed[0].status).toBe("failed");
    expect(failed[0].deathTime).not.toBeNull();
    expect((await root.requestReplication({ name: "c2" }, fakeSharedSpawn(db))).ok).toBe(true);
    occ = await occupancy();
    expect(occ.livingAgents).toBe(2);
  });

  it("releasing twice is a no-op the second time (no double release)", async () => {
    await reset(3);
    const root = newController();
    await root.init();
    const res = await admin.reserveSlot({ parentAgentId: root.agentId!, requestedBy: "t", name: "c", runtime: PIN });
    if (!res.ok) throw new Error(res.reason);
    expect((await occupancy()).reservedSlots).toBe(1);
    const releases = await Promise.all([
      admin.releaseReservation(res.agent.agentId, "a"),
      admin.releaseReservation(res.agent.agentId, "b"),
      admin.releaseReservation(res.agent.agentId, "c"),
    ]);
    expect(releases.filter(Boolean)).toHaveLength(1);
    const occ = await occupancy();
    expect(occ.reservedSlots).toBe(0);
    expect(occ.livingAgents).toBe(1);
    expect((await admin.getEvents(res.agent.agentId)).filter((e) => e.eventType === "slot_released")).toHaveLength(1);
    // A released grant can no longer be claimed.
    await expect(claimFleetGrant(res.grant, ulid(), db.raw)).rejects.toThrow(FleetBypassError);
  });

  it("a slot whose activation fails (runtime not verified) is returned", async () => {
    await reset(2);
    const root = newController();
    await root.init();
    await expect(
      root.requestReplication({ name: "c" }, async (grant) => {
        await claimFleetGrant(grant, ulid(), db.raw);
        return { address: wallet(), sandboxId: "s", runtimeCommit: "d".repeat(40) };
      }),
    ).rejects.toThrow(FleetRuntimeError);
    expect((await occupancy()).reservedSlots).toBe(0);
  });

  it("unclaimed reservations expire and free their slot; expired grants cannot be claimed", async () => {
    await reset(2);
    const root = newController();
    await root.init();
    const shortTtl = newStore({ reservationTtlMs: 1 });
    const res = await shortTtl.reserveSlot({ parentAgentId: root.agentId!, requestedBy: "t", name: "c", runtime: PIN });
    if (!res.ok) throw new Error(res.reason);
    await new Promise((r) => setTimeout(r, 20));
    await expect(claimFleetGrant(res.grant, ulid(), db.raw)).rejects.toThrow(FleetBypassError);
    const next = await admin.reserveSlot({ parentAgentId: root.agentId!, requestedBy: "t", name: "c2", runtime: PIN });
    expect(next.ok).toBe(true);
    expect((await admin.getAgent(res.agent.agentId))!.status).toBe("failed");
  });

  it("registry outage mid-provision keeps the slot occupied (fail-safe)", async () => {
    await reset(3);
    const store = newStore();
    const root = newController({ store });
    await root.init();
    await expect(
      root.requestReplication({ name: "c" }, async (grant) => {
        await claimFleetGrant(grant, ulid(), db.raw);
        await store.close(); // registry becomes unreachable for this agent
        throw new Error("sandbox failed while registry down");
      }),
    ).rejects.toThrow(/registry down/);
    const occ = await occupancy();
    expect(occ.reservedSlots).toBe(1); // not silently freed; operator must release
  });

  // ── Duplicate registration ──

  it("duplicate child registration is rejected (same wallet, same request, double activation)", async () => {
    await reset(5);
    const root = newController();
    await root.init();
    const shared = wallet();

    const first = await root.requestReplication({ name: "a" }, async (grant) => {
      const c = await claimFleetGrant(grant, ulid(), db.raw);
      return { address: shared, sandboxId: "s1", runtimeCommit: c.runtime!.commit };
    });
    expect(first.ok).toBe(true);

    await expect(
      root.requestReplication({ name: "b" }, async (grant) => {
        const c = await claimFleetGrant(grant, ulid(), db.raw);
        return { address: shared.toUpperCase().replace("0X", "0x"), sandboxId: "s2", runtimeCommit: c.runtime!.commit };
      }),
    ).rejects.toThrow(FleetDuplicateRegistrationError);

    if (!first.ok) throw new Error();
    await expect(admin.activate(first.agentId, { walletAddress: wallet(), runtimeCommit: PIN.commit })).rejects.toThrow(/not in provisioning/);

    const key = ulid();
    const r1 = await admin.reserveSlot({ parentAgentId: root.agentId!, requestedBy: "t", name: "k", runtime: PIN, requestKey: key });
    const r2 = await admin.reserveSlot({ parentAgentId: root.agentId!, requestedBy: "t", name: "k", runtime: PIN, requestKey: key });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe("FLEET_DUPLICATE_REQUEST");

    const occ = await occupancy();
    expect(occ.livingAgents).toBe(2); // root + first child
    expect(occ.reservedSlots).toBe(1); // r1
    expect((await admin.health()).countersConsistent).toBe(true);
  });

  // ── Dead agents ──

  it("dead agents stay recorded but do not count toward the cap", async () => {
    await reset(2);
    const root = newController();
    await root.init();
    const out = await root.requestReplication({ name: "c1" }, fakeSharedSpawn(db));
    if (!out.ok) throw new Error("expected spawn");
    expect((await root.requestReplication({ name: "blocked" }, fakeSharedSpawn(db))).ok).toBe(false);

    expect(await admin.markDead(out.agentId, "out of credits")).toBe(true);
    expect(await admin.markDead(out.agentId, "again")).toBe(false);
    const dead = (await admin.getAgent(out.agentId))!;
    expect(dead.status).toBe("dead");
    expect(dead.deathTime).not.toBeNull();
    await expect(raw.query(`UPDATE ${schema}.fleet_agents SET status = 'active' WHERE agent_id = $1`, [out.agentId])).rejects.toThrow(/FLEET_TERMINAL_STATE_IMMUTABLE/);

    expect((await root.requestReplication({ name: "c2" }, fakeSharedSpawn(db))).ok).toBe(true);
    const occ = await occupancy();
    expect(occ.livingAgents).toBe(2);
    expect(occ.rows.total).toBe(3);
  });

  it("a child reaching a terminal lifecycle state is marked dead in the shared registry", async () => {
    await reset(2);
    stubRuntimePinEnv(vi.stubEnv);
    const root = newController();
    await root.init();
    setActiveSharedFleet(root);
    const conway = mockConwayForPinnedSpawn();
    const lifecycle = new ChildLifecycle(db.raw);
    const out = await root.requestReplication({ name: genesis.name }, (grant) => spawnChild(conway, identity, db, genesis, lifecycle, grant));
    if (!out.ok) throw new Error("expected spawn");
    const agent = (await admin.getAgent(out.agentId))!;
    expect(agent).toMatchObject({ status: "active", runtimeCommit: PIN.commit, runtimeRepo: PIN.repo, generation: 1, parentAgentId: root.agentId });
    expect(agent.walletAddress).toBe(out.child.address);

    lifecycle.transition(out.child.id, "failed", "crashed");
    await vi.waitFor(async () => expect((await admin.getAgent(out.agentId))!.status).toBe("dead"));
    expect((await occupancy()).livingAgents).toBe(1);
  });

  // ── Policy integration ──

  it("modes: shared DEVELOPMENT/EMERGENCY and local env can only tighten", async () => {
    await reset(5, "DEVELOPMENT");
    const root = newController();
    await root.init();
    let out = await root.requestReplication({ name: "c" }, fakeSharedSpawn(db));
    expect(!out.ok && out.decision.code).toBe("FLEET_DEVELOPMENT_MODE");

    await admin.setOperatingMode("EMERGENCY", "test", "drill");
    out = await root.requestReplication({ name: "c" }, fakeSharedSpawn(db));
    expect(!out.ok && out.decision.code).toBe("FLEET_EMERGENCY");

    await admin.setOperatingMode("EXPANSION", "test", "resume");
    const devLocal = newController({ config: { configuredMode: "DEVELOPMENT" } });
    await devLocal.init();
    out = await devLocal.requestReplication({ name: "c" }, fakeSharedSpawn(db));
    expect(!out.ok && out.decision.code).toBe("FLEET_DEVELOPMENT_MODE");

    // Local cap tighter than shared cap wins.
    const tight = newController({ maxAgents: 1 });
    await tight.init();
    out = await tight.requestReplication({ name: "c" }, fakeSharedSpawn(db));
    expect(!out.ok && out.decision.code).toBe("FLEET_CAP_REACHED");
    expect((await occupancy()).reservedSlots).toBe(0);
  });

  it("runtime pin must match the fleet-approved runtime (wrong commit / arbitrary repo / cleared)", async () => {
    await reset(5);
    const wrongCommit = newController({ config: { runtime: { repo: PIN.repo, commit: "e".repeat(40) } } });
    await wrongCommit.init();
    let out = await wrongCommit.requestReplication({ name: "c" }, fakeSharedSpawn(db));
    expect(!out.ok && out.decision.code).toBe("FLEET_RUNTIME_UNVERIFIED");

    const root = newController();
    await root.init();
    out = await root.requestReplication({ name: "c", runtime: { repo: "https://github.com/attacker/automaton" } }, fakeSharedSpawn(db));
    expect(!out.ok && out.decision.code).toBe("FLEET_RUNTIME_UNVERIFIED");

    // Direct store call with a mismatching pin is refused inside the transaction.
    const direct = await admin.reserveSlot({ parentAgentId: root.agentId!, requestedBy: "t", name: "c", runtime: { repo: PIN.repo, commit: "e".repeat(40) } });
    expect(!direct.ok && direct.code).toBe("FLEET_RUNTIME_UNVERIFIED");

    await admin.setApprovedRuntime(null, "test");
    out = await root.requestReplication({ name: "c" }, fakeSharedSpawn(db));
    expect(!out.ok && out.decision.code).toBe("FLEET_RUNTIME_UNVERIFIED");
    expect((await occupancy()).reservedSlots).toBe(0);
  });

  it("financial eligibility still gates shared replication", async () => {
    await reset(5);
    const c = new SharedFleetController({
      store: newStore(),
      config: fleetConfig(),
      self: { address: identity.address, name: "root" },
      isRootAgent: true,
      getFinancialSnapshot: async () => ({ creditsCents: 5, survivalTier: "critical" }),
    });
    await c.init();
    const out = await c.requestReplication({ name: "c" }, fakeSharedSpawn(db));
    expect(!out.ok && out.decision.code).toBe("FINANCIALLY_INELIGIBLE");
  });

  it("a registered child agent can replicate against the shared cap; unregistered cannot", async () => {
    await reset(3);
    const root = newController();
    await root.init();
    const first = await root.requestReplication({ name: "kid" }, fakeSharedSpawn(db));
    if (!first.ok) throw new Error("expected spawn");

    const kid = newController({ isRootAgent: false, selfAgentId: first.agentId, address: first.child.address });
    expect((await kid.init()).ok).toBe(true);
    const grandkid = await kid.requestReplication({ name: "grandkid" }, fakeSharedSpawn(db));
    expect(grandkid.ok).toBe(true);
    if (grandkid.ok) expect((await admin.getAgent(grandkid.agentId))!.generation).toBe(2);

    // Cap (3) now reached for everyone.
    expect(!((await root.requestReplication({ name: "x" }, fakeSharedSpawn(db))).ok)).toBe(true);

    const impostor = newController({ isRootAgent: false, selfAgentId: first.agentId, address: wallet() });
    expect((await impostor.init()).ok).toBe(false);
    await reset(5);
    const out = await impostor.requestReplication({ name: "x" }, fakeSharedSpawn(db));
    expect(!out.ok && out.decision.code).toBe("FLEET_NOT_REGISTERED");
  });

  it("spawn_child tool succeeds only through the shared registry and stops at the shared cap", async () => {
    await reset(2);
    stubRuntimePinEnv(vi.stubEnv);
    vi.stubEnv("FLEET_MAX_AGENTS", "2");
    vi.stubEnv("FLEET_MODE", "EXPANSION");
    vi.stubEnv("REAL_REPLICATION_ENABLED", "true");
    vi.stubEnv("MIN_AGENT_RESERVE_USD", "1");
    const root = newController({ config: loadFleetConfig() });
    await root.init();
    setActiveSharedFleet(root);
    const conway = mockConwayForPinnedSpawn();
    const tool = createBuiltinTools("sbx").find((t) => t.name === "spawn_child")!;
    const ctx: ToolContext = { identity, config: createTestConfig(), db, conway, inference: new MockInferenceClient() };
    expect(await tool.execute({ name: "child-one" }, ctx)).toContain("Child spawned");
    expect(await tool.execute({ name: "child-two" }, ctx)).toContain("Blocked: FLEET_CAP_REACHED");
    const occ = await occupancy();
    expect(occ.livingAgents + occ.reservedSlots).toBe(2);
  });

  it("policy rule uses shared counts and a stale snapshot fails closed", async () => {
    await reset(2);
    const root = newController({ config: { realPaymentsEnabled: true } });
    await root.init();
    await root.requestReplication({ name: "c1" }, fakeSharedSpawn(db));
    setActiveSharedFleet(root);
    const tools = createBuiltinTools("sbx");
    const ctx: ToolContext = { identity, config: createTestConfig(), db, conway: new MockConwayClient(), inference: new MockInferenceClient() };
    const engine = new PolicyEngine(db.raw, createDefaultRules(DEFAULT_TREASURY_POLICY, fleetConfig({ realPaymentsEnabled: true })));
    const spend = {
      recordSpend: () => {}, getHourlySpend: () => 0, getDailySpend: () => 0, getTotalSpend: () => 0,
      checkLimit: () => ({ allowed: true, currentHourlySpend: 0, currentDailySpend: 0, limitHourly: 0, limitDaily: 0 }),
      pruneOldRecords: () => 0,
    };
    const evalSpawn = () =>
      engine.evaluate({ tool: tools.find((t) => t.name === "spawn_child")!, args: { name: "c" }, context: ctx, turnContext: { inputSource: "agent", turnToolCallCount: 0, sessionSpend: spend } });

    expect(evalSpawn().reasonCode).toBe("FLEET_CAP_REACHED"); // shared 2/2, local SQLite knows nothing
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000);
    expect(evalSpawn().reasonCode).toBe("FLEET_REGISTRY_UNAVAILABLE");
  });
});
