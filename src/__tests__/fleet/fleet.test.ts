/**
 * Fleet Layer Tests (Phase 1)
 *
 * FleetRegistry / FleetPolicy / FleetController: global living-agent cap,
 * fleet operating states, transaction-safe slot reservation, and
 * replication bypass prevention.
 *
 * Describe names include "policy", "security", "financial" and "treasury"
 * so these tests also run under test:security and test:financial.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";
import { ulid } from "ulid";
import {
  FleetController,
  FleetRegistry,
  FleetBypassError,
  loadFleetConfig,
  DEFAULT_FLEET_CONFIG,
  computeFleetState,
  evaluateToolCall,
} from "../../fleet/index.js";
import type { FinancialSnapshot, FleetConfig, FleetSpawnGrant } from "../../fleet/index.js";
import { spawnChild } from "../../replication/spawn.js";
import { ChildLifecycle } from "../../replication/lifecycle.js";
import { createBuiltinTools, executeTool } from "../../agent/tools.js";
import { PolicyEngine } from "../../agent/policy-engine.js";
import { createDefaultRules } from "../../agent/policy-rules/index.js";
import { getForbiddenCommandMatch } from "../../agent/policy-rules/command-safety.js";
import { isProtectedFile } from "../../self-mod/code.js";
import { SCHEMA_VERSION } from "../../state/schema.js";
import { DEFAULT_TREASURY_POLICY } from "../../types.js";
import type { AutomatonDatabase, AutomatonTool, GenesisConfig, ToolContext } from "../../types.js";
import {
  MockConwayClient,
  MockInferenceClient,
  createTestConfig,
  createTestDb,
  createTestIdentity,
} from "../mocks.js";

vi.mock("../../registry/erc8004.js", () => ({
  queryAgent: vi.fn(),
  getTotalAgents: vi.fn().mockResolvedValue(0),
  registerAgent: vi.fn(),
  leaveFeedback: vi.fn(),
}));

// ─── Helpers ────────────────────────────────────────────────────

const identity = createTestIdentity();
const CHILD_WALLET = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const HEALTHY: FinancialSnapshot = { creditsCents: 10_000, survivalTier: "high" };

function fleetConfig(overrides: Partial<FleetConfig> = {}): FleetConfig {
  return {
    ...DEFAULT_FLEET_CONFIG,
    configuredMode: "EXPANSION",
    realReplicationEnabled: true,
    ...overrides,
  };
}

function makeController(
  db: AutomatonDatabase,
  config: FleetConfig,
  opts: { isRootAgent?: boolean; snapshot?: () => Promise<FinancialSnapshot> } = {},
): FleetController {
  return new FleetController({
    db: db.raw,
    config,
    self: { address: identity.address, name: "root" },
    isRootAgent: opts.isRootAgent ?? true,
    getFinancialSnapshot: opts.snapshot ?? (async () => HEALTHY),
  });
}

/** Stand-in for spawnChild: consumes the grant, yields, returns a child. */
function fakeSpawn(db: AutomatonDatabase, calls: { n: number } = { n: 0 }) {
  return async (grant: FleetSpawnGrant) => {
    calls.n++;
    new FleetRegistry(db.raw).claimGrant(grant, ulid());
    await new Promise((r) => setTimeout(r, 5));
    return { address: CHILD_WALLET, sandboxId: `sbx-${ulid()}` };
  };
}

function mockConwayForSpawn(): MockConwayClient {
  const conway = new MockConwayClient();
  vi.spyOn(conway, "exec").mockImplementation(async (command: string) => {
    if (command.includes("--init")) {
      return { stdout: `Wallet initialized: ${CHILD_WALLET}`, stderr: "", exitCode: 0 };
    }
    return { stdout: "ok", stderr: "", exitCode: 0 };
  });
  return conway;
}

const genesis: GenesisConfig = {
  name: "fleet-child",
  genesisPrompt: "You are a fleet child.",
  creatorAddress: identity.address,
  parentAddress: identity.address,
};

function tmpDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-test-")), "fleet.db");
}

// ─── Configuration ──────────────────────────────────────────────

describe("Fleet policy: configuration defaults", () => {
  it("defaults to a single agent, DEVELOPMENT, and all real actions disabled", () => {
    const config = loadFleetConfig({});
    expect(config.maxAgents).toBe(1);
    expect(config.configuredMode).toBe("DEVELOPMENT");
    expect(config.realReplicationEnabled).toBe(false);
    expect(config.realPaymentsEnabled).toBe(false);
    expect(config.ownerSweepEnabled).toBe(false);
  });

  it("fails closed on malformed values", () => {
    for (const bad of ["0", "51", "-2", "2.5", "abc", "1e2", ""]) {
      expect(loadFleetConfig({ FLEET_MAX_AGENTS: bad }).maxAgents).toBe(1);
    }
    expect(loadFleetConfig({ FLEET_MAX_AGENTS: "50" }).maxAgents).toBe(50);
    expect(loadFleetConfig({ REAL_REPLICATION_ENABLED: "yes" }).realReplicationEnabled).toBe(false);
    expect(loadFleetConfig({ REAL_REPLICATION_ENABLED: "1" }).realReplicationEnabled).toBe(false);
    expect(loadFleetConfig({ REAL_PAYMENTS_ENABLED: "TRUE" }).realPaymentsEnabled).toBe(true);
    expect(loadFleetConfig({ FLEET_MODE: "bogus" }).configuredMode).toBe("DEVELOPMENT");
    expect(loadFleetConfig({ FLEET_MODE: "expansion" }).configuredMode).toBe("EXPANSION");
  });

  it("registry rejects caps outside 1..50", () => {
    const db = createTestDb();
    const registry = new FleetRegistry(db.raw);
    expect(() => registry.setMaxAgents(0)).toThrow();
    expect(() => registry.setMaxAgents(51)).toThrow();
    db.close();
  });
});

// ─── Operating states ───────────────────────────────────────────

describe("Fleet policy: operating states", () => {
  it("computes state precedence EMERGENCY > DEVELOPMENT > HARVEST > EXPANSION", () => {
    const base = { livingAgents: 1, maxAgents: 5, emergency: false };
    expect(computeFleetState({ ...base, configuredMode: "EXPANSION" })).toBe("EXPANSION");
    expect(computeFleetState({ ...base, configuredMode: "EXPANSION", livingAgents: 5 })).toBe("HARVEST");
    expect(computeFleetState({ ...base, configuredMode: "HARVEST" })).toBe("HARVEST");
    expect(computeFleetState({ ...base, configuredMode: "DEVELOPMENT", livingAgents: 5 })).toBe("DEVELOPMENT");
    expect(computeFleetState({ ...base, configuredMode: "EXPANSION", emergency: true })).toBe("EMERGENCY");
    expect(computeFleetState({ ...base, configuredMode: "EMERGENCY" })).toBe("EMERGENCY");
  });

  it("real replication is disabled in DEVELOPMENT even with REAL_REPLICATION_ENABLED=true", async () => {
    const db = createTestDb();
    const calls = { n: 0 };
    const fleet = makeController(db, fleetConfig({ configuredMode: "DEVELOPMENT", maxAgents: 5 }));
    const out = await fleet.requestReplication({ name: "c" }, fakeSpawn(db, calls));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.decision.code).toBe("FLEET_DEVELOPMENT_MODE");
    expect(calls.n).toBe(0);
    expect(fleet.registry.countLiving()).toBe(1);
    db.close();
  });

  it("real replication is disabled when REAL_REPLICATION_ENABLED=false", async () => {
    const db = createTestDb();
    const fleet = makeController(db, fleetConfig({ realReplicationEnabled: false, maxAgents: 5 }));
    const out = await fleet.requestReplication({ name: "c" }, fakeSpawn(db));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.decision.code).toBe("REAL_REPLICATION_DISABLED");
    db.close();
  });

  it("HARVEST disables replication (configured)", async () => {
    const db = createTestDb();
    const calls = { n: 0 };
    const fleet = makeController(db, fleetConfig({ configuredMode: "HARVEST", maxAgents: 5 }));
    expect(fleet.getState()).toBe("HARVEST");
    const out = await fleet.requestReplication({ name: "c" }, fakeSpawn(db, calls));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.decision.code).toBe("FLEET_HARVEST");
    expect(calls.n).toBe(0);
    db.close();
  });

  it("HARVEST is selected automatically when the living count reaches the cap", async () => {
    const db = createTestDb();
    const fleet = makeController(db, fleetConfig({ maxAgents: 2 }));
    expect(fleet.getState()).toBe("EXPANSION");
    const out = await fleet.requestReplication({ name: "c" }, fakeSpawn(db));
    expect(out.ok).toBe(true);
    expect(fleet.getState()).toBe("HARVEST");
    db.close();
  });

  it("EMERGENCY disables replication (runtime flag and configured mode)", async () => {
    const db = createTestDb();
    const calls = { n: 0 };
    const fleet = makeController(db, fleetConfig({ maxAgents: 5 }));
    fleet.enterEmergency("test");
    expect(fleet.getState()).toBe("EMERGENCY");
    const out = await fleet.requestReplication({ name: "c" }, fakeSpawn(db, calls));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.decision.code).toBe("FLEET_EMERGENCY");
    // Registry refuses reservations directly as well.
    const direct = fleet.registry.reserveSlot({ parentAgentId: null, requestedBy: "x", name: "x" });
    expect(direct.ok).toBe(false);
    expect(calls.n).toBe(0);

    const db2 = createTestDb();
    const fleet2 = makeController(db2, fleetConfig({ configuredMode: "EMERGENCY", maxAgents: 5 }));
    const out2 = await fleet2.requestReplication({ name: "c" }, fakeSpawn(db2));
    expect(out2.ok).toBe(false);
    if (!out2.ok) expect(out2.decision.code).toBe("FLEET_EMERGENCY");
    db.close();
    db2.close();
  });

  it("EMERGENCY blocks non-essential expenditure tools but not survival top-ups", () => {
    const base = {
      args: {},
      config: fleetConfig({ realPaymentsEnabled: true, maxAgents: 5 }),
      state: "EMERGENCY" as const,
      livingAgents: 1,
      maxAgents: 5,
      isRootAgent: true,
      isFleetMemberAddress: () => false,
    };
    for (const tool of ["spawn_child", "fund_child", "start_child", "transfer_credits", "x402_fetch", "create_sandbox", "register_domain"]) {
      expect(evaluateToolCall({ ...base, toolName: tool })?.code).toBe("FLEET_EMERGENCY");
    }
    expect(evaluateToolCall({ ...base, toolName: "topup_credits" })).toBeNull();
    expect(evaluateToolCall({ ...base, toolName: "check_credits" })).toBeNull();
  });
});

// ─── Global cap ─────────────────────────────────────────────────

describe("Fleet policy: global living-agent cap", () => {
  let db: AutomatonDatabase;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("FLEET_MAX_AGENTS=1 rejects reproduction (the root occupies the only slot)", async () => {
    const calls = { n: 0 };
    const fleet = makeController(db, fleetConfig({ maxAgents: 1 }));
    const out = await fleet.requestReplication({ name: "c" }, fakeSpawn(db, calls));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.decision.code).toBe("FLEET_CAP_REACHED");
      expect(out.decision.state).toBe("HARVEST");
    }
    expect(calls.n).toBe(0);
    expect(fleet.registry.countLiving()).toBe(1);
  });

  it("cap 2 allows one child", async () => {
    const fleet = makeController(db, fleetConfig({ maxAgents: 2 }));
    const out = await fleet.requestReplication({ name: "c1" }, fakeSpawn(db));
    expect(out.ok).toBe(true);
    expect(fleet.registry.countLiving()).toBe(2);
    const children = fleet.registry.listAgents().filter((a) => a.role === "child");
    expect(children).toHaveLength(1);
    expect(children[0].status).toBe("active");
    expect(children[0].address).toBe(CHILD_WALLET);
    expect(children[0].generation).toBe(1);
  });

  it("cap 2 rejects the second child", async () => {
    const fleet = makeController(db, fleetConfig({ maxAgents: 2 }));
    expect((await fleet.requestReplication({ name: "c1" }, fakeSpawn(db))).ok).toBe(true);
    const second = await fleet.requestReplication({ name: "c2" }, fakeSpawn(db));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.decision.code).toBe("FLEET_CAP_REACHED");
    expect(fleet.registry.countLiving()).toBe(2);
  });

  it("20 concurrent requests at cap 2 result in exactly 2 living agents", async () => {
    const fleet = makeController(db, fleetConfig({ maxAgents: 2 }));
    const calls = { n: 0 };
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => fleet.requestReplication({ name: `c${i}` }, fakeSpawn(db, calls))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(19);
    expect(calls.n).toBe(1);
    expect(fleet.registry.countLiving()).toBe(2);
  });

  it("20 concurrent requests from multiple parents/controllers at cap 2 yield exactly 2 living agents", async () => {
    // Separate controllers (as separate parents would construct) over separate
    // connections to the same database file.
    const dbPath = tmpDbPath();
    const setup = new Database(dbPath);
    const root = new FleetRegistry(setup);
    root.setMaxAgents(2);
    root.ensureRootAgent({ address: identity.address, name: "root" });

    const conns = Array.from({ length: 20 }, () => new Database(dbPath));
    const results = await Promise.all(
      conns.map(async (conn, i) => {
        const registry = new FleetRegistry(conn);
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        return registry.reserveSlot({ parentAgentId: null, requestedBy: `parent-${i}`, name: `c${i}` });
      }),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(root.countLiving()).toBe(2);
    for (const c of conns) c.close();
    setup.close();
  });

  it("20 concurrent OS processes at cap 2 result in exactly 2 living agents", async () => {
    const dbPath = tmpDbPath();
    const setup = new Database(dbPath);
    setup.pragma("journal_mode = WAL");
    const registry = new FleetRegistry(setup);
    registry.setMaxAgents(2);
    registry.ensureRootAgent({ address: identity.address, name: "root" });

    const run = promisify(execFile);
    const tsx = path.resolve("node_modules/.bin/tsx");
    const worker = path.resolve("src/__tests__/fleet/fixtures/reserve-worker.ts");
    const startAt = Date.now() + 6000;
    const outputs = await Promise.all(
      Array.from({ length: 20 }, () =>
        run(tsx, [worker, dbPath, String(startAt)], { timeout: 60_000 }).then((r) => JSON.parse(r.stdout)),
      ),
    );
    expect(outputs.filter((o) => o.ok)).toHaveLength(1);
    expect(outputs.filter((o) => !o.ok).every((o) => o.code === "FLEET_CAP_REACHED")).toBe(true);
    expect(registry.countLiving()).toBe(2);
    setup.close();
  }, 90_000);

  it("a failed spawn releases its reserved slot", async () => {
    const fleet = makeController(db, fleetConfig({ maxAgents: 2 }));
    await expect(
      fleet.requestReplication({ name: "c1" }, async (grant) => {
        new FleetRegistry(db.raw).claimGrant(grant, ulid());
        throw new Error("sandbox exploded");
      }),
    ).rejects.toThrow("sandbox exploded");
    expect(fleet.registry.countLiving()).toBe(1);
    const failed = fleet.registry.listAgents({ living: false });
    expect(failed).toHaveLength(1);
    expect(failed[0].status).toBe("failed");
    expect((await fleet.requestReplication({ name: "c2" }, fakeSpawn(db))).ok).toBe(true);
  });

  it("a spawn function that never claims its grant cannot leave a dangling slot", async () => {
    const fleet = makeController(db, fleetConfig({ maxAgents: 2 }));
    await expect(
      fleet.requestReplication({ name: "c1" }, async () => ({ address: CHILD_WALLET, sandboxId: "s" })),
    ).rejects.toThrow(/Cannot activate/);
    expect(fleet.registry.countLiving()).toBe(1);
  });
});

// ─── Dead agents ────────────────────────────────────────────────

describe("Fleet policy: dead agents", () => {
  let db: AutomatonDatabase;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("dead agents remain recorded", async () => {
    const fleet = makeController(db, fleetConfig({ maxAgents: 2 }));
    const out = await fleet.requestReplication({ name: "c1" }, fakeSpawn(db));
    if (!out.ok) throw new Error("expected spawn");
    expect(fleet.registry.markDead(out.agentId, "ran out of credits")).toBe(true);

    const agent = fleet.registry.getAgent(out.agentId)!;
    expect(agent.status).toBe("dead");
    expect(agent.diedAt).not.toBeNull();
    expect(agent.statusReason).toBe("ran out of credits");
    expect(fleet.registry.countTotal()).toBe(2);
    expect(fleet.registry.getEvents(out.agentId).map((e) => e.eventType)).toContain("agent_died");

    // History cannot be deleted, and the dead cannot be revived.
    expect(() => db.raw.prepare("DELETE FROM fleet_agents WHERE id = ?").run(out.agentId)).toThrow(/FLEET_HISTORY_IMMUTABLE/);
    expect(() => db.raw.prepare("UPDATE fleet_agents SET status = 'active' WHERE id = ?").run(out.agentId)).toThrow(/FLEET_TERMINAL_STATE_IMMUTABLE/);
    expect(() => db.raw.prepare("DELETE FROM fleet_events").run()).toThrow(/FLEET_HISTORY_IMMUTABLE/);
  });

  it("dead agent releases its living slot", async () => {
    const fleet = makeController(db, fleetConfig({ maxAgents: 2 }));
    const first = await fleet.requestReplication({ name: "c1" }, fakeSpawn(db));
    if (!first.ok) throw new Error("expected spawn");
    expect((await fleet.requestReplication({ name: "blocked" }, fakeSpawn(db))).ok).toBe(false);

    fleet.registry.markDead(first.agentId, "died");
    expect(fleet.registry.countLiving()).toBe(1);
    expect(fleet.getState()).toBe("EXPANSION");

    const second = await fleet.requestReplication({ name: "c2" }, fakeSpawn(db));
    expect(second.ok).toBe(true);
    expect(fleet.registry.countLiving()).toBe(2);
    expect(fleet.registry.countTotal()).toBe(3);
  });

  it("a child reaching a terminal lifecycle state is recorded dead automatically", async () => {
    const fleet = makeController(db, fleetConfig({ maxAgents: 2 }));
    const conway = mockConwayForSpawn();
    const lifecycle = new ChildLifecycle(db.raw);
    const out = await fleet.requestReplication({ name: genesis.name }, (grant) =>
      spawnChild(conway, identity, db, genesis, lifecycle, grant),
    );
    if (!out.ok) throw new Error("expected spawn");
    expect(fleet.registry.getAgent(out.agentId)!.status).toBe("active");

    lifecycle.transition(out.child.id, "failed", "crashed");
    const agent = fleet.registry.getAgent(out.agentId)!;
    expect(agent.status).toBe("dead");
    expect(agent.statusReason).toBe("child lifecycle: failed");
    expect(fleet.registry.countLiving()).toBe(1);
  });
});

// ─── Financial eligibility ──────────────────────────────────────

describe("Fleet financial eligibility (treasury)", () => {
  let db: AutomatonDatabase;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("rejects replication in low survival tiers", async () => {
    const fleet = makeController(db, fleetConfig({ maxAgents: 5 }), {
      snapshot: async () => ({ creditsCents: 5, survivalTier: "critical" }),
    });
    const out = await fleet.requestReplication({ name: "c" }, fakeSpawn(db));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.decision.code).toBe("FINANCIALLY_INELIGIBLE");
    expect(fleet.registry.countLiving()).toBe(1);
  });

  it("rejects replication below the parent reserve", async () => {
    const fleet = makeController(db, fleetConfig({ maxAgents: 5, minParentReserveCents: 20_000 }));
    const out = await fleet.requestReplication({ name: "c" }, fakeSpawn(db));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.decision.code).toBe("FINANCIALLY_INELIGIBLE");
  });

  it("fails closed when the financial snapshot is unavailable", async () => {
    const fleet = makeController(db, fleetConfig({ maxAgents: 5 }), {
      snapshot: async () => { throw new Error("rpc down"); },
    });
    const out = await fleet.requestReplication({ name: "c" }, fakeSpawn(db));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.decision.code).toBe("FINANCIALLY_INELIGIBLE");
  });

  it("child funding is blocked while REAL_PAYMENTS_ENABLED=false", () => {
    const base = {
      args: { child_id: "x", amount_cents: 100 },
      livingAgents: 2,
      maxAgents: 5,
      isRootAgent: true,
      isFleetMemberAddress: () => false,
    };
    expect(evaluateToolCall({ ...base, toolName: "fund_child", state: "EXPANSION", config: fleetConfig() })?.code)
      .toBe("REAL_PAYMENTS_DISABLED");
    expect(evaluateToolCall({ ...base, toolName: "fund_child", state: "DEVELOPMENT", config: fleetConfig({ realPaymentsEnabled: true }) })?.code)
      .toBe("FLEET_DEVELOPMENT_MODE");
    expect(evaluateToolCall({ ...base, toolName: "fund_child", state: "EXPANSION", config: fleetConfig({ realPaymentsEnabled: true }) }))
      .toBeNull();
  });
});

// ─── Bypass prevention ──────────────────────────────────────────

describe("Fleet security: replication bypass prevention", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;
  beforeEach(() => {
    db = createTestDb();
    conway = mockConwayForSpawn();
  });
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("direct spawnChild() without a fleet grant fails before any sandbox is created", async () => {
    const createSpy = vi.spyOn(conway, "createSandbox");
    await expect(spawnChild(conway, identity, db, genesis, new ChildLifecycle(db.raw))).rejects.toThrow(FleetBypassError);
    await expect(spawnChild(conway, identity, db, genesis)).rejects.toThrow(FleetBypassError);
    expect(createSpy).not.toHaveBeenCalled();
    expect(db.getChildren()).toHaveLength(0);
  });

  it("forged and reused grants are rejected", async () => {
    const createSpy = vi.spyOn(conway, "createSandbox");
    const forged: FleetSpawnGrant = { kind: "fleet-spawn-grant", reservationId: ulid() };
    await expect(spawnChild(conway, identity, db, genesis, undefined, forged)).rejects.toThrow(FleetBypassError);
    await expect(spawnChild(conway, identity, db, genesis, undefined, { reservationId: "x" } as any)).rejects.toThrow(FleetBypassError);
    expect(createSpy).not.toHaveBeenCalled();

    const fleet = makeController(db, fleetConfig({ maxAgents: 3 }));
    let captured: FleetSpawnGrant | undefined;
    const out = await fleet.requestReplication({ name: genesis.name }, (grant) => {
      captured = grant;
      return spawnChild(conway, identity, db, genesis, new ChildLifecycle(db.raw), grant);
    });
    expect(out.ok).toBe(true);
    await expect(spawnChild(conway, identity, db, genesis, new ChildLifecycle(db.raw), captured)).rejects.toThrow(/already used/);
    expect(fleet.registry.countLiving()).toBe(2);
  });

  it("raw SQL inserts cannot exceed the cap (database trigger backstop)", () => {
    const registry = new FleetRegistry(db.raw);
    registry.setMaxAgents(2);
    registry.ensureRootAgent({ address: identity.address, name: "root" });
    const insert = db.raw.prepare(
      `INSERT INTO fleet_agents (id, role, requested_by, name, status, created_at, updated_at)
       VALUES (?, 'child', 'attacker', 'x', 'active', 'now', 'now')`,
    );
    insert.run(ulid());
    expect(() => insert.run(ulid())).toThrow(/FLEET_CAP_EXCEEDED/);
    expect(registry.countLiving()).toBe(2);
  });

  it("the trigger fails closed when no cap has been configured", () => {
    const raw = new Database(tmpDbPath());
    FleetRegistry.ensureSchema(raw);
    expect(() =>
      raw.prepare(
        `INSERT INTO fleet_agents (id, role, requested_by, name, status, created_at, updated_at)
         VALUES ('a', 'root', 'x', 'x', 'active', 'now', 'now')`,
      ).run(),
    ).toThrow(/FLEET_CAP_EXCEEDED/);
    raw.close();
  });

  it("spawn_child tool is blocked under default configuration and never touches Conway", async () => {
    for (const k of ["FLEET_MAX_AGENTS", "FLEET_MODE", "REAL_REPLICATION_ENABLED", "REAL_PAYMENTS_ENABLED"]) {
      vi.stubEnv(k, "");
    }
    const createSpy = vi.spyOn(conway, "createSandbox");
    const tool = createBuiltinTools("test-sandbox-id").find((t) => t.name === "spawn_child")!;
    const ctx: ToolContext = {
      identity,
      config: createTestConfig(),
      db,
      conway,
      inference: new MockInferenceClient(),
    };
    const result = await tool.execute({ name: "sneaky-child" }, ctx);
    expect(result).toContain("Blocked: FLEET_DEVELOPMENT_MODE");
    expect(createSpy).not.toHaveBeenCalled();
    expect(db.getChildren()).toHaveLength(0);
  });

  it("spawn_child tool succeeds only through the controller when fleet allows it", async () => {
    vi.stubEnv("FLEET_MAX_AGENTS", "2");
    vi.stubEnv("FLEET_MODE", "EXPANSION");
    vi.stubEnv("REAL_REPLICATION_ENABLED", "true");
    vi.stubEnv("MIN_AGENT_RESERVE_USD", "1");
    conway.creditsCents = 10_000;
    const tool = createBuiltinTools("test-sandbox-id").find((t) => t.name === "spawn_child")!;
    const ctx: ToolContext = {
      identity,
      config: createTestConfig(),
      db,
      conway,
      inference: new MockInferenceClient(),
    };
    expect(await tool.execute({ name: "child-one" }, ctx)).toContain("Child spawned");
    expect(await tool.execute({ name: "child-two" }, ctx)).toContain("Blocked: FLEET_CAP_REACHED");
    expect(new FleetRegistry(db.raw).countLiving()).toBe(2);
  });

  it("a child automaton cannot replicate against its own local registry", async () => {
    const fleet = makeController(db, fleetConfig({ maxAgents: 5 }), { isRootAgent: false });
    const out = await fleet.requestReplication({ name: "c" }, fakeSpawn(db));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.decision.code).toBe("NOT_FLEET_ROOT");
  });

  it("shell tampering with fleet tables and fleet code is forbidden", () => {
    expect(getForbiddenCommandMatch(`sqlite3 ~/.automaton/state.db "UPDATE fleet_meta SET value='50'"`)).not.toBeNull();
    expect(getForbiddenCommandMatch(`sqlite3 state.db "INSERT INTO fleet_agents VALUES (1)"`)).not.toBeNull();
    expect(getForbiddenCommandMatch(`sqlite3 state.db "DROP TRIGGER fleet_agents_cap_insert"`)).not.toBeNull();
    expect(getForbiddenCommandMatch(`sed -i 's/1/50/' src/fleet/config.ts`)).not.toBeNull();
    expect(getForbiddenCommandMatch("ls -la")).toBeNull();
  });

  it("fleet guardrail files are protected from self-modification", () => {
    for (const f of ["src/fleet/registry.ts", "src/fleet/policy.ts", "src/fleet/controller.ts", "dist/fleet/config.js", "src/agent/policy-rules/fleet.ts", "src/replication/spawn.ts"]) {
      expect(isProtectedFile(path.resolve(f))).toBe(true);
    }
  });
});

// ─── PolicyEngine integration ───────────────────────────────────

describe("Fleet policy engine rule", () => {
  let db: AutomatonDatabase;
  let tools: AutomatonTool[];
  let ctx: ToolContext;
  const spend = {
    recordSpend: () => {},
    getHourlySpend: () => 0,
    getDailySpend: () => 0,
    getTotalSpend: () => 0,
    checkLimit: () => ({ allowed: true, currentHourlySpend: 0, currentDailySpend: 0, limitHourly: 0, limitDaily: 0 }),
    pruneOldRecords: () => 0,
  };

  beforeEach(() => {
    db = createTestDb();
    tools = createBuiltinTools("test-sandbox-id");
    ctx = { identity, config: createTestConfig(), db, conway: new MockConwayClient(), inference: new MockInferenceClient() };
  });
  afterEach(() => { db.close(); });

  function evaluate(config: FleetConfig, toolName: string, args: Record<string, unknown>, context: ToolContext = ctx) {
    const engine = new PolicyEngine(db.raw, createDefaultRules(DEFAULT_TREASURY_POLICY, config));
    const tool = tools.find((t) => t.name === toolName)!;
    return engine.evaluate({ tool, args, context, turnContext: { inputSource: "agent", turnToolCallCount: 0, sessionSpend: spend } });
  }

  it("is registered in the default rule set", () => {
    expect(createDefaultRules().map((r) => r.id)).toContain("fleet.policy_gate");
  });

  it("denies spawn_child in DEVELOPMENT", () => {
    const d = evaluate(loadFleetConfig({}), "spawn_child", { name: "c" });
    expect(d.action).toBe("deny");
    expect(d.reasonCode).toBe("FLEET_DEVELOPMENT_MODE");
  });

  it("denies fund_child while real payments are disabled", () => {
    const d = evaluate(fleetConfig({ maxAgents: 3 }), "fund_child", { child_id: "c", amount_cents: 100 });
    expect(d.action).toBe("deny");
    expect(d.reasonCode).toBe("REAL_PAYMENTS_DISABLED");
  });

  it("denies transfer_credits to a fleet member while real payments are disabled", () => {
    db.raw.prepare(
      "INSERT INTO children (id, name, address, sandbox_id, genesis_prompt, status) VALUES ('c1','kid',?, 's', 'g', 'healthy')",
    ).run(CHILD_WALLET);
    const toChild = evaluate(loadFleetConfig({}), "transfer_credits", { to_address: CHILD_WALLET.toUpperCase().replace("0X", "0x"), amount_cents: 10 });
    expect(toChild.action).toBe("deny");
    expect(toChild.reasonCode).toBe("FLEET_CHILD_FUNDING_BYPASS");

    const toOther = evaluate(loadFleetConfig({}), "transfer_credits", { to_address: "0x1111111111111111111111111111111111111111", amount_cents: 10 });
    expect(toOther.rulesTriggered).not.toContain("fleet.policy_gate");
  });

  it("denies EMERGENCY expenditure via the policy engine", () => {
    new FleetRegistry(db.raw).setEmergency(true, "test");
    const d = evaluate(fleetConfig({ realPaymentsEnabled: true }), "x402_fetch", { url: "https://conway.tech/x" });
    expect(d.action).toBe("deny");
    expect(d.reasonCode).toBe("FLEET_EMERGENCY");
  });

  it("fails closed when the registry is unavailable", () => {
    const noDb = { ...ctx, db: {} as AutomatonDatabase };
    const d = evaluate(fleetConfig(), "spawn_child", { name: "c" }, noDb);
    expect(d.action).toBe("deny");
    expect(d.reasonCode).toBe("FLEET_REGISTRY_UNAVAILABLE");
  });

  it("denied spawn_child via executeTool never reaches the tool", async () => {
    const engine = new PolicyEngine(db.raw, createDefaultRules(DEFAULT_TREASURY_POLICY, loadFleetConfig({})));
    const result = await executeTool("spawn_child", { name: "c" }, tools, ctx, engine, {
      inputSource: "agent",
      turnToolCallCount: 0,
      sessionSpend: spend,
    });
    expect(result.error).toContain("FLEET_DEVELOPMENT_MODE");
    expect(db.getChildren()).toHaveLength(0);
  });
});

// ─── Schema ─────────────────────────────────────────────────────

describe("Fleet schema migration", () => {
  it("createDatabase applies the fleet tables and triggers", () => {
    expect(SCHEMA_VERSION).toBe(12);
    const db = createTestDb();
    const names = (db.raw.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'fleet%'").all() as { name: string }[]).map((r) => r.name);
    for (const n of [
      "fleet_agents",
      "fleet_meta",
      "fleet_events",
      "fleet_agents_cap_insert",
      "fleet_agents_terminal_immutable",
      "fleet_agents_no_delete",
      "fleet_sync_child_terminal",
    ]) {
      expect(names).toContain(n);
    }
    db.close();
  });
});
