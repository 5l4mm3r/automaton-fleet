/**
 * Fleet Layer Tests (Phase 5): lifecycle enforcement, secure remote control
 * plane, dynamic treasury economics, fleet bank, custody, capital performance.
 *
 * Describe names include "financial", "security" and "policy" so these also
 * run under test:financial and test:security. PostgreSQL tests use a
 * throwaway cluster set up exactly as production (fixtures/ephemeral-pg.ts).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import fs from "fs";
import https from "https";
import os from "os";
import path from "path";
import pg from "pg";
import { ulid } from "ulid";
import {
  DEFAULT_TREASURY_POLICY,
  HARD_MAX_SWEEP_RATE,
  activeReduction,
  capitalPerformanceProfile,
  computeAgentWaterfall,
  computeSweepRate,
  discretionaryLimitCents,
  evaluateRescue,
  planOwnerDistribution,
  populationBaseRate,
  summarizeLedger,
  validatePolicy,
  type AgentEconomicsInput,
  type AgentLedgerEntry,
  type CapitalAllocation,
} from "../../fleet/treasury/engine.js";
import { PgTreasuryStore } from "../../fleet/treasury/store.js";
import { executeApprovedSpend } from "../../fleet/treasury/custody.js";
import { FleetApiClient, type HealthResponder } from "../../fleet/service/client.js";
import { FleetService, type AuditEntry } from "../../fleet/service/server.js";
import { signRequest, SIG_HEADERS } from "../../fleet/service/server-signing.js";
import { RateLimiter } from "../../fleet/service/rate-limit.js";
import { UnsupportedSandboxTerminator } from "../../fleet/service/terminator.js";
import { parseListen, startFleetServiceFromEnv } from "../../fleet/service/main.js";
import { PgAgentGateway } from "../../fleet/postgres/agent-gateway.js";
import { PgFleetStore, hashAgentToken, mintSessionToken } from "../../fleet/postgres/store.js";
import { attestationProof, type RuntimeAttestation } from "../../fleet/attestation.js";
import type { ClaimedGrant } from "../../fleet/grants.js";
import { loadFleetConfig } from "../../fleet/config.js";
import { TEST_RUNTIME_BUILD, TEST_RUNTIME_PIN } from "../mocks.js";
import { findPgBin, startEphemeralPg, type EphemeralPg } from "./fixtures/ephemeral-pg.js";
import { wipeRegistry } from "./fixtures/wipe.js";

const PIN = TEST_RUNTIME_PIN;
const BUILD = TEST_RUNTIME_BUILD;
const RELEASE = { ...PIN, ...BUILD };
const DAY = 86_400_000;
const NOW = new Date("2027-06-01T00:00:00Z");

function wallet(): string {
  return `0x${randomBytes(20).toString("hex")}`;
}

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * DAY);
}

/** Steady monthly revenue for `months` months + daily costs. */
function steadyLedger(opts: { months: number; monthlyRevenue: number; dailyCost: number }): AgentLedgerEntry[] {
  const out: AgentLedgerEntry[] = [];
  for (let m = 0; m < opts.months; m++) out.push({ kind: "revenue", amountCents: opts.monthlyRevenue, occurredAt: daysAgo(m * 30 + 15) });
  for (let d = 0; d < 30; d++) out.push({ kind: "direct_cost", amountCents: opts.dailyCost, occurredAt: daysAgo(d + 0.5) });
  return out;
}

function econ(over: Partial<AgentEconomicsInput> = {}): AgentEconomicsInput {
  return {
    agentId: "A",
    cashCents: 1_000_000,
    agentCreatedAt: NOW,
    ledger: [{ kind: "revenue", amountCents: 2_000_000, occurredAt: daysAgo(1) }],
    obligations: [],
    allocations: [],
    reductions: [],
    livingAgents: 5,
    treasury: { balanceCents: 1_000_000, reserveTargetCents: 1_000_000 },
    asOf: NOW,
    ...over,
  };
}

function allocation(over: Partial<CapitalAllocation> = {}): CapitalAllocation {
  return {
    allocationId: ulid(),
    agentId: "A",
    kind: "growth",
    purpose: "ads",
    requestedAmountCents: 100_000,
    approvedAmountCents: 100_000,
    deployedCents: 0,
    startDate: daysAgo(1),
    expiryDate: new Date(NOW.getTime() + 30 * DAY),
    expectedReturnCents: 150_000,
    expectedDurationDays: 30,
    status: "approved",
    actualReturnCents: null,
    ...over,
  };
}

// ─── Treasury economics (pure) ───────────────────────────────────

describe("Fleet financial: dynamic sweep policy", () => {
  it("10% base sweep at early fleet size", () => {
    for (const n of [1, 5, 10]) expect(populationBaseRate(n)).toBe(0.1);
    expect([11, 20].map((n) => populationBaseRate(n))).toEqual([0.125, 0.125]);
    expect([21, 31, 41, 49].map((n) => populationBaseRate(n))).toEqual([0.15, 0.175, 0.2, 0.2]);
    const w = computeAgentWaterfall(econ({ livingAgents: 3 }));
    expect(w.rate.base).toBe(0.1);
    expect(w.rate.rate).toBe(0.1);
    expect(w.FLEET_SWEEP).toBe(Math.floor(w.SWEEP_BASE * 0.1));
    expect(w.FLEET_SWEEP).toBeGreaterThan(0);
  });

  it("the mature-fleet base rate (45%, configurable) applies at 50 living agents", () => {
    expect(populationBaseRate(50)).toBe(0.45);
    expect(computeAgentWaterfall(econ({ livingAgents: 50 })).rate.rate).toBe(0.45);
    const p = { ...DEFAULT_TREASURY_POLICY, matureFleetRate: 0.3 };
    expect(computeAgentWaterfall(econ({ livingAgents: 50 }), p).rate.rate).toBe(0.3);
  });

  it("the rate can reach the configured maximum (70%) for highly capitalised mature agents, never beyond", () => {
    const mature = econ({
      livingAgents: 50,
      agentCreatedAt: daysAgo(400),
      ledger: steadyLedger({ months: 12, monthlyRevenue: 500_000, dailyCost: 1_000 }),
      cashCents: 50_000_000,
      treasury: { balanceCents: 0, reserveTargetCents: 1_000_000 },
    });
    const w = computeAgentWaterfall(mature);
    expect(w.rate.rate).toBe(0.7);
    expect(computeAgentWaterfall(mature, { ...DEFAULT_TREASURY_POLICY, maxSweepRate: 0.6, matureFleetRate: 0.45 }).rate.rate).toBe(0.6);
    expect(() => validatePolicy({ ...DEFAULT_TREASURY_POLICY, maxSweepRate: 0.71 })).toThrow(/maxSweepRate/);
    expect(HARD_MAX_SWEEP_RATE).toBe(0.7);
    // Same mature agent with little surplus stays near its base.
    const lean = computeAgentWaterfall({ ...mature, cashCents: 40_000 });
    expect(lean.rate.surplusUplift).toBe(0);
    expect(lean.rate.rate).toBeCloseTo(0.45 + 0.05, 6); // base + treasury-need uplift only
  });

  it("the rate reflects maturity, surplus, treasury need, recent losses and productive use", () => {
    const base = { livingAgents: 20, agentAgeDays: 365, excessCents: 200_000, protectedCents: 100_000, reduction: 0,
      treasury: { balanceCents: 100, reserveTargetCents: 100 }, profile: { roi: null, forecastAccuracy: null, recentLossRatio: 0, revenueConsistency: 1 } };
    const r0 = computeSweepRate(base);
    expect(r0.base).toBe(0.125);
    expect(r0.surplusUplift).toBeGreaterThan(0);
    const young = computeSweepRate({ ...base, agentAgeDays: 0 });
    expect(young.surplusUplift).toBe(0);
    const needy = computeSweepRate({ ...base, treasury: { balanceCents: 0, reserveTargetCents: 100 } });
    expect(needy.rate).toBeGreaterThan(r0.rate);
    const lossy = computeSweepRate({ ...base, profile: { ...base.profile, recentLossRatio: 1 } });
    expect(lossy.rate).toBeGreaterThan(r0.rate);
    const productive = computeSweepRate({ ...base, profile: { ...base.profile, roi: 1, forecastAccuracy: 1 } });
    expect(productive.rate).toBeLessThan(r0.rate);
    expect(productive.rate).toBeGreaterThanOrEqual(productive.base);
  });
});

describe("Fleet financial: waterfall never sweeps protected capital", () => {
  it("approved operating obligations cannot be swept", () => {
    const w = computeAgentWaterfall(econ({ cashCents: 100_000, obligations: [{ amountCents: 95_000, dueAt: NOW, status: "approved" }] }));
    expect(w.OPERATING_OBLIGATIONS).toBe(95_000);
    expect(w.EXCESS_CAPITAL).toBe(100_000 - 95_000 - w.CONTINGENCY_RESERVE);
    expect(w.AGENT_RETAINED_CAPITAL).toBeGreaterThanOrEqual(95_000 + w.CONTINGENCY_RESERVE);
    const all = computeAgentWaterfall(econ({ cashCents: 50_000, obligations: [{ amountCents: 60_000, dueAt: NOW, status: "approved" }] }));
    expect(all.FLEET_SWEEP).toBe(0);
    // Settled/cancelled obligations no longer protect.
    expect(computeAgentWaterfall(econ({ obligations: [{ amountCents: 60_000, dueAt: NOW, status: "settled" }] })).OPERATING_OBLIGATIONS).toBe(0);
  });

  it("protected runway (30 days of burn by default) cannot be swept", () => {
    const ledger: AgentLedgerEntry[] = [...steadyLedger({ months: 1, monthlyRevenue: 5_000_000, dailyCost: 2_000 })];
    const w = computeAgentWaterfall(econ({ cashCents: 70_000, ledger, agentCreatedAt: daysAgo(60) }));
    expect(w.dailyBurnCents).toBe(2_000);
    expect(w.PROTECTED_RUNWAY).toBe(60_000);
    expect(w.CONTINGENCY_RESERVE).toBe(6_000);
    expect(w.EXCESS_CAPITAL).toBe(4_000);
    expect(w.AGENT_RETAINED_CAPITAL).toBeGreaterThanOrEqual(66_000);
    expect(computeAgentWaterfall(econ({ cashCents: 70_000, ledger, agentCreatedAt: daysAgo(60) }), { ...DEFAULT_TREASURY_POLICY, runwayDays: 35 }).EXCESS_CAPITAL).toBe(0);
  });

  it("an approved, current growth allocation cannot be swept; an expired one stops protecting capital", () => {
    const current = computeAgentWaterfall(econ({ cashCents: 150_000, allocations: [allocation({ approvedAmountCents: 100_000, deployedCents: 20_000 })] }));
    expect(current.APPROVED_GROWTH_CAPITAL).toBe(80_000);
    expect(current.AGENT_RETAINED_CAPITAL).toBeGreaterThanOrEqual(80_000 + current.CONTINGENCY_RESERVE);
    const expired = computeAgentWaterfall(econ({ cashCents: 150_000, allocations: [allocation({ expiryDate: daysAgo(1) })] }));
    expect(expired.APPROVED_GROWTH_CAPITAL).toBe(0);
    expect(expired.EXCESS_CAPITAL).toBeGreaterThan(current.EXCESS_CAPITAL);
    for (const status of ["proposed", "rejected", "cancelled"] as const) {
      expect(computeAgentWaterfall(econ({ allocations: [allocation({ status })] })).APPROVED_GROWTH_CAPITAL).toBe(0);
    }
    const future = computeAgentWaterfall(econ({ allocations: [allocation({ startDate: new Date(NOW.getTime() + DAY) })] }));
    expect(future.APPROVED_GROWTH_CAPITAL).toBe(0);
  });

  it("genuine excess capital from profit is swept", () => {
    const w = computeAgentWaterfall(econ({ cashCents: 1_000_000, livingAgents: 15 }));
    expect(w.EXCESS_CAPITAL).toBe(1_000_000 - w.CONTINGENCY_RESERVE);
    expect(w.SWEEP_BASE).toBe(w.EXCESS_CAPITAL);
    expect(w.FLEET_SWEEP).toBe(Math.floor(w.SWEEP_BASE * w.rate.rate));
    expect(w.AGENT_RETAINED_CAPITAL + w.FLEET_SWEEP).toBe(w.CASH_ON_HAND);
  });

  it("owner funding is never treated as revenue or profit, and is never swept as profit", () => {
    const ledger: AgentLedgerEntry[] = [{ kind: "owner_funding", amountCents: 5_000_000, occurredAt: daysAgo(3) }];
    const w = computeAgentWaterfall(econ({ cashCents: 5_000_000, ledger }));
    expect(w.GROSS_REVENUE).toBe(0);
    expect(w.NET_PROFIT).toBe(0);
    expect(w.OWNER_FUNDING).toBe(5_000_000);
    expect(w.EXCESS_CAPITAL).toBeGreaterThan(0);
    expect(w.FLEET_SWEEP).toBe(0);
    const s = summarizeLedger([...ledger, { kind: "revenue", amountCents: 300, occurredAt: daysAgo(1) }, { kind: "direct_cost", amountCents: 100, occurredAt: daysAgo(1) }]);
    expect(s).toMatchObject({ grossRevenueCents: 300, directCostsCents: 100, netProfitCents: 200, ownerFundingCents: 5_000_000 });
  });

  it("only undistributed profit is swept (prior sweeps are not swept twice)", () => {
    const ledger: AgentLedgerEntry[] = [
      { kind: "revenue", amountCents: 100_000, occurredAt: daysAgo(10) },
      { kind: "sweep_to_treasury", amountCents: 80_000, occurredAt: daysAgo(5) },
    ];
    const w = computeAgentWaterfall(econ({ cashCents: 1_000_000, ledger }));
    expect(w.UNDISTRIBUTED_PROFIT).toBe(20_000);
    expect(w.SWEEP_BASE).toBe(20_000);
  });

  it("a strong opportunity can temporarily reduce the sweep; the reduction ends at expiry", () => {
    const reduction = { reductionPct: 0.5, startsAt: daysAgo(1), expiresAt: new Date(NOW.getTime() + 7 * DAY) };
    const normal = computeAgentWaterfall(econ());
    const reduced = computeAgentWaterfall(econ({ reductions: [reduction] }));
    expect(reduced.rate.rate).toBeCloseTo(normal.rate.rate * 0.5, 6);
    expect(reduced.FLEET_SWEEP).toBeLessThan(normal.FLEET_SWEEP);
    const later = computeAgentWaterfall(econ({ reductions: [reduction], asOf: new Date(NOW.getTime() + 8 * DAY) }));
    expect(later.rate.reduction).toBe(0);
    expect(activeReduction([{ ...reduction, revokedAt: NOW }], NOW)).toBe(0);
    expect(activeReduction([reduction, { ...reduction, reductionPct: 0.5 }], NOW)).toBeCloseTo(0.75, 6);
  });

  it("invariant under random inputs: retained capital always covers everything protected; rate within [0, max]", () => {
    for (let i = 0; i < 500; i++) {
      const r = (n: number) => Math.floor(Math.random() * n);
      const ledger: AgentLedgerEntry[] = Array.from({ length: r(20) }, () => ({
        kind: (["revenue", "direct_cost", "owner_funding", "sweep_to_treasury"] as const)[r(4)],
        amountCents: 1 + r(500_000),
        occurredAt: daysAgo(r(200)),
      }));
      const w = computeAgentWaterfall(
        econ({
          cashCents: r(10_000_000),
          ledger,
          agentCreatedAt: daysAgo(r(500)),
          livingAgents: 1 + r(50),
          obligations: r(2) ? [{ amountCents: 1 + r(2_000_000), dueAt: NOW, status: "approved" }] : [],
          allocations: r(2) ? [allocation({ approvedAmountCents: r(1_000_000), deployedCents: 0 })] : [],
          treasury: { balanceCents: r(1_000_000), reserveTargetCents: r(1_000_000) },
        }),
      );
      const protectedTotal = w.OPERATING_OBLIGATIONS + w.PROTECTED_RUNWAY + w.APPROVED_GROWTH_CAPITAL + w.CONTINGENCY_RESERVE;
      expect(w.AGENT_RETAINED_CAPITAL).toBeGreaterThanOrEqual(Math.min(w.CASH_ON_HAND, protectedTotal));
      expect(w.FLEET_SWEEP).toBeLessThanOrEqual(w.EXCESS_CAPITAL);
      expect(w.rate.rate).toBeLessThanOrEqual(0.7);
      expect(w.rate.rate).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("Fleet financial: capital performance, discretionary capital and rescue", () => {
  const closed = (deployed: number, actual: number, expected: number, daysAgoN: number): CapitalAllocation =>
    allocation({ status: "completed", deployedCents: deployed, actualReturnCents: actual, expectedReturnCents: expected, decidedAt: daysAgo(daysAgoN) });

  it("strong agents earn larger discretionary allocations; weak agents progressively lose them", () => {
    const strong = capitalPerformanceProfile([closed(100, 180, 170, 200), closed(100, 160, 150, 100), closed(100, 190, 190, 10)], [], NOW);
    expect(strong.roi).toBeCloseTo(0.7667, 3);
    expect(strong.profitableAllocations).toBe(3);
    expect(strong.forecastAccuracy!).toBeGreaterThan(0.9);
    expect(strong.discretionaryMultiplier).toBeGreaterThan(1.8);
    const weak1 = capitalPerformanceProfile([closed(100, 180, 170, 200), closed(100, 20, 150, 50)], [], NOW);
    const weak3 = capitalPerformanceProfile([closed(100, 10, 150, 150), closed(100, 20, 150, 50), closed(100, 0, 150, 10)], [], NOW);
    expect(weak3.consecutiveFailures).toBe(3);
    expect(weak3.failedAllocations).toBe(3);
    expect(weak3.discretionaryMultiplier).toBeLessThan(weak1.discretionaryMultiplier);
    expect(weak3.discretionaryMultiplier).toBeLessThan(0.5);
    expect(discretionaryLimitCents(100_000, strong)).toBeGreaterThan(discretionaryLimitCents(100_000, weak3));
    const five = capitalPerformanceProfile(Array.from({ length: 5 }, (_, i) => closed(100, 0, 150, 60 - i)), [], NOW);
    expect(five.discretionaryMultiplier).toBe(0);
  });

  it("the profile is internal: no single public score, but consistency, efficiency and loss ratio are tracked", () => {
    const p = capitalPerformanceProfile([closed(100, 50, 150, 10)], steadyLedger({ months: 6, monthlyRevenue: 10_000, dailyCost: 10 }), NOW);
    expect(Object.keys(p)).not.toContain("score");
    expect(p.revenueConsistency).toBeGreaterThan(0.9);
    expect(p.recentLossRatio).toBeCloseTo(0.5, 6);
  });

  it("emergency rescue is discretionary: never automatic, and advised against for chronic failure", () => {
    const fine = capitalPerformanceProfile([], [], NOW);
    expect(evaluateRescue(fine, { runwayDays: 3 })).toEqual({ recommended: true, requiresOperatorApproval: true, reasons: [] });
    const chronic = capitalPerformanceProfile([closed(100, 0, 1, 30), closed(100, 0, 1, 20), closed(100, 0, 1, 10)], [], NOW);
    const r = evaluateRescue(chronic, { runwayDays: 3 });
    expect(r.recommended).toBe(false);
    expect(r.requiresOperatorApproval).toBe(true);
    expect(evaluateRescue(fine, { runwayDays: 60 }).recommended).toBe(false);
  });
});

describe("Fleet financial: fleet bank and owner distributions", () => {
  it("treasury reserve blocks owner distribution", () => {
    const p = planOwnerDistribution({ requestedCents: 10_000, balanceCents: 300_000, reserveTargetCents: 300_000, obligationsCents: 0 });
    expect(p).toMatchObject({ status: "rejected", approvedCents: 0, surplusCents: 0 });
    expect(planOwnerDistribution({ requestedCents: 10_000, balanceCents: 350_000, reserveTargetCents: 300_000, obligationsCents: 60_000 }).status).toBe("rejected");
  });

  it("owner distribution works only above the reserve target (and obligations), limited to the surplus", () => {
    const ok = planOwnerDistribution({ requestedCents: 10_000, balanceCents: 400_000, reserveTargetCents: 300_000, obligationsCents: 50_000 });
    expect(ok).toMatchObject({ status: "planned_not_executed", approvedCents: 10_000, surplusCents: 50_000 });
    const partial = planOwnerDistribution({ requestedCents: 80_000, balanceCents: 400_000, reserveTargetCents: 300_000, obligationsCents: 50_000 });
    expect(partial).toMatchObject({ status: "planned_not_executed", approvedCents: 50_000 });
  });

  it("financial safety: spend execution never happens with payments disabled or without a controller signer", async () => {
    const d = { requestId: ulid(), decision: "approved_not_executed" as const, amountCents: 100, toAddress: wallet() };
    const signer = { send: async () => ({ txHash: "0xabc" }) };
    expect(await executeApprovedSpend(d, { REAL_PAYMENTS_ENABLED: "false" }, signer)).toEqual({ executed: false, reason: "REAL_PAYMENTS_ENABLED=false" });
    expect(await executeApprovedSpend(d, {}, signer)).toMatchObject({ executed: false });
    expect(await executeApprovedSpend(d, { REAL_PAYMENTS_ENABLED: "true" }, null)).toMatchObject({ executed: false });
    const cfg = loadFleetConfig({});
    expect(cfg.realReplicationEnabled || cfg.realPaymentsEnabled || cfg.ownerSweepEnabled).toBe(false);
    if (fs.existsSync(".env.fleet")) {
      const text = fs.readFileSync(".env.fleet", "utf8");
      for (const k of ["REAL_REPLICATION_ENABLED", "REAL_PAYMENTS_ENABLED", "OWNER_SWEEP_ENABLED"]) expect(text).toMatch(new RegExp(`^${k}=false$`, "m"));
    }
  });
});

describe("Fleet security: remote control plane primitives", () => {
  it("rate limiter enforces burst and refill", () => {
    let t = 0;
    const rl = new RateLimiter({ capacity: 3, refillPerSec: 1 }, () => t);
    expect([rl.take("a"), rl.take("a"), rl.take("a"), rl.take("a")]).toEqual([true, true, true, false]);
    expect(rl.take("b")).toBe(true);
    expect(rl.retryAfterS("a")).toBe(1);
    t += 1000;
    expect(rl.take("a")).toBe(true);
  });

  it("remote listening requires explicit enablement AND TLS", async () => {
    expect(() => parseListen("0.0.0.0:8443")).toThrow(/loopback/);
    expect(parseListen("0.0.0.0:8443", { remoteAllowed: true })).toEqual({ host: "0.0.0.0", port: 8443 });
    await expect(
      startFleetServiceFromEnv({ FLEET_SERVICE_DATABASE_URL: "postgresql://s:x@127.0.0.1:1/x", FLEET_AGENT_DATABASE_URL: "postgresql://a:x@127.0.0.1:1/x", FLEET_REMOTE_LISTEN_ENABLED: "true", FLEET_API_LISTEN: "0.0.0.0:0" }, { log: () => {} }),
    ).rejects.toThrow(/requires FLEET_TLS_CERT_FILE/);
  });
});

// ─── PostgreSQL ──────────────────────────────────────────────────

const PG_BIN = findPgBin();
if (!PG_BIN) console.warn("[fleet-phase5] PostgreSQL binaries not found — Phase 5 database tests SKIPPED. Set PG_BIN.");

describe.skipIf(!PG_BIN)("Fleet security policy: lifecycle, remote auth, custody and treasury (PostgreSQL)", () => {
  let pgc: EphemeralPg;
  let admin: PgFleetStore;
  let svc: PgFleetStore;
  let treasury: PgTreasuryStore;
  let ownerRaw: pg.Pool;
  let agentRaw: pg.Pool;
  let gateway: PgAgentGateway;
  let service: FleetService | null = null;
  let url = "";
  const audit: AuditEntry[] = [];
  const opened: Array<{ close(): Promise<void> }> = [];
  const track = <T extends { close(): Promise<void> }>(x: T): T => (opened.push(x), x);

  async function events(type: string, agentId?: string): Promise<number> {
    const r = await ownerRaw.query(
      "SELECT count(*)::int AS n FROM fleet.fleet_events WHERE event_type = $1 AND ($2::text IS NULL OR agent_id = $2)",
      [type, agentId ?? null],
    );
    return r.rows[0].n;
  }

  async function status(agentId: string) {
    return (await admin.getAgent(agentId))!.status;
  }

  async function reset(max = 6) {
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
    await admin.setLifecyclePolicy(
      { healthChallengeIntervalS: 60, challengeTtlS: 60, healthGraceS: 300, maxChallengeFailures: 3, terminationGraceS: 480, orphanSlotHoldS: 259200, maxOpenOrphans: 1, sessionTtlS: 600 },
      "test",
    );
  }

  async function enrollRoot(name = "root") {
    const reg = await admin.registerRoot({ walletAddress: wallet(), name });
    if (!reg.ok) throw new Error(reg.reason);
    const cred = await admin.issueCredential(reg.agent.agentId, "test");
    return { agent: reg.agent, cred };
  }

  function honest(claimed: ClaimedGrant, over: Partial<RuntimeAttestation> = {}): RuntimeAttestation {
    const a = { nonce: claimed.nonce!, commit: PIN.commit, repo: PIN.repo, buildId: BUILD.buildId, lockfileSha256: BUILD.lockfileSha256, clean: true, fileCount: 3, version: "0.2.1", proof: "", ...over };
    return { ...a, proof: attestationProof(a) };
  }

  async function claimed(parentId: string) {
    const res = await admin.reserveSlot({ parentAgentId: parentId, requestedBy: "t", name: "kid", runtime: PIN });
    if (!res.ok) throw new Error(`${res.code}: ${res.reason}`);
    const localChildId = ulid();
    const c = await svc.claimGrant(res.agent.agentId, localChildId, { parentAgentId: parentId });
    return { agentId: res.agent.agentId, reservationId: res.lease!.reservationId, claimed: c, localChildId };
  }

  async function activeChild(parentId: string, sandboxId: string | null = null) {
    const k = await claimed(parentId);
    if (sandboxId) await k.claimed.reportProvisioning!("sandbox_created", sandboxId);
    const w = wallet();
    const act = await svc.activate(k.agentId, { walletAddress: w, sandboxId, runtimeCommit: PIN.commit, attestation: honest(k.claimed), parentAgentId: parentId, actor: parentId });
    return { ...k, cred: act.credential, wallet: w };
  }

  const honestResponder: HealthResponder = async () => ({ commit: PIN.commit, buildId: BUILD.buildId, policyOk: true });
  const lyingResponder: HealthResponder = async () => ({ commit: "f".repeat(40), buildId: BUILD.buildId, policyOk: true });
  const brokenPolicyResponder: HealthResponder = async () => ({ commit: PIN.commit, buildId: BUILD.buildId, policyOk: false });

  function client(cred: { agentId: string; token: string }, responder: HealthResponder = honestResponder, fetchImpl?: typeof fetch) {
    return new FleetApiClient({ baseUrl: url, agentId: cred.agentId, token: cred.token, healthResponder: responder, fetchImpl });
  }

  async function startService(extra: Partial<ConstructorParameters<typeof FleetService>[0]> = {}) {
    await service?.close();
    service = new FleetService({
      admin: svc,
      agent: gateway,
      realReplicationEnabled: true,
      reaperIntervalMs: 0,
      release: RELEASE,
      audit: (e) => audit.push(e),
      terminator: new UnsupportedSandboxTerminator(),
      ...extra,
    });
    url = (await service.listen(0, "127.0.0.1")).url;
  }

  async function armReaper() {
    await ownerRaw.query("UPDATE fleet.fleet_state SET reaper_last_run_at = now(), reaper_grace_from = '-infinity'");
  }

  beforeAll(async () => {
    pgc = await startEphemeralPg(PG_BIN!);
    ownerRaw = new pg.Pool({ connectionString: pgc.ownerUrl, max: 6 });
    agentRaw = new pg.Pool({ connectionString: pgc.agentUrl, max: 3 });
    admin = track(new PgFleetStore({ connectionString: pgc.ownerUrl }));
    svc = track(new PgFleetStore({ connectionString: pgc.serviceUrl }));
    treasury = track(new PgTreasuryStore({ connectionString: pgc.ownerUrl }));
    await admin.migrate();
    gateway = track(new PgAgentGateway({ connectionString: pgc.agentUrl }));
  }, 60_000);

  afterAll(async () => {
    await service?.close();
    for (const s of opened) await s.close();
    await ownerRaw?.end();
    await agentRaw?.end();
    pgc?.stop();
  });

  beforeEach(async () => {
    await reset();
    audit.length = 0;
    await startService();
  });

  it("privilege audit still passes with the Phase 5 schema", async () => {
    const r = await admin.auditPrivileges();
    expect(r.problems).toEqual([]);
  });

  // ── Part A: provisioning records and lifecycle

  it("provisioning is tracked from claim; a sandbox is recorded the moment it exists; a failed activation stays visible for cleanup", async () => {
    const root = await enrollRoot();
    const k = await claimed(root.agent.agentId);
    let p = (await admin.listProvisioning()).find((x) => x.expected_agent_id === k.agentId)!;
    expect(p).toMatchObject({ reservation_id: k.reservationId, parent_agent_id: root.agent.agentId, status: "provisioning", cleanup_status: "none", sandbox_id: null, expected_runtime_commit: PIN.commit });
    expect(p.activation_deadline).toBeInstanceOf(Date);
    await k.claimed.reportProvisioning!("sandbox_created", "sbx-fail-1");
    await k.claimed.reportProvisioning!("verifying");
    p = (await admin.listProvisioning()).find((x) => x.expected_agent_id === k.agentId)!;
    expect(p).toMatchObject({ sandbox_id: "sbx-fail-1", status: "verifying" });

    await expect(
      svc.activate(k.agentId, { walletAddress: wallet(), sandboxId: "sbx-fail-1", runtimeCommit: PIN.commit, attestation: honest(k.claimed, { buildId: "c".repeat(64) }), parentAgentId: root.agent.agentId }),
    ).rejects.toThrow();
    p = (await admin.listProvisioning({ needsCleanup: true })).find((x) => x.expected_agent_id === k.agentId)!;
    expect(p).toMatchObject({ status: "failed_provisioning", cleanup_status: "pending", sandbox_id: "sbx-fail-1" });
    await service!.processTerminations();
    p = (await admin.listProvisioning({ needsCleanup: true })).find((x) => x.expected_agent_id === k.agentId)!;
    expect(p).toMatchObject({ status: "orphaned", cleanup_status: "unsupported" });
    const orphans = await admin.listOrphans({ open: true });
    expect(orphans.find((o) => o.agent_id === k.agentId)).toMatchObject({ sandbox_id: "sbx-fail-1", holds_slot: false });
    expect((await admin.getState()).reservedSlots).toBe(0);
  });

  it("another parent cannot report provisioning for a reservation; the activation sandbox must match the provisioned one", async () => {
    const root = await enrollRoot();
    const other = await enrollRoot("other");
    const k = await claimed(root.agent.agentId);
    await expect(svc.reportProvisioning(k.agentId, "sandbox_created", "sbx-x", other.agent.agentId)).rejects.toThrow(/refused/);
    await k.claimed.reportProvisioning!("sandbox_created", "sbx-real");
    await expect(k.claimed.reportProvisioning!("sandbox_created", "sbx-swap")).rejects.toThrow(/FLEET_SANDBOX_MISMATCH/);
    await expect(
      svc.activate(k.agentId, { walletAddress: wallet(), sandboxId: "sbx-other", runtimeCommit: PIN.commit, attestation: honest(k.claimed), parentAgentId: root.agent.agentId }),
    ).rejects.toThrow(/FLEET_SANDBOX_MISMATCH/);
    expect(await status(k.agentId)).toBe("provisioning");
  });

  it("health challenges: an honest agent passes; an unresponsive agent recovers only by passing a challenge", async () => {
    const root = await enrollRoot();
    const kid = await activeChild(root.agent.agentId, "sbx-h1");
    const c = client(kid.cred);
    expect(await c.heartbeat(kid.agentId)).toBe(true);
    expect(c.lastChallenge?.passed).toBe(true);
    expect(await events("health_challenge_failed")).toBe(0);
    const rec = (await ownerRaw.query("SELECT last_challenge_ok_at, challenge_failures FROM fleet.fleet_agents WHERE agent_id = $1", [kid.agentId])).rows[0];
    expect(rec.last_challenge_ok_at).not.toBeNull();
    // Force UNRESPONSIVE by stale health; a heartbeat alone does not recover it.
    await armReaper();
    await ownerRaw.query("UPDATE fleet.fleet_agents SET last_challenge_ok_at = now() - interval '1 hour' WHERE agent_id = $1", [kid.agentId]);
    await svc.reap("t");
    expect(await status(kid.agentId)).toBe("unresponsive");
    expect(await svc.heartbeat(kid.agentId)).toBe(false);
    expect(await status(kid.agentId)).toBe("unresponsive");
    // Challenges are single-use: the next one is issued, and passing it restores ACTIVE.
    await ownerRaw.query("UPDATE fleet.fleet_health_challenges SET issued_at = now() - interval '1 hour' WHERE agent_id = $1", [kid.agentId]);
    expect(await c.heartbeat(kid.agentId)).toBe(true);
    expect(await status(kid.agentId)).toBe("active");
    expect(await events("agent_recovered", kid.agentId)).toBeGreaterThanOrEqual(1);
  });

  it("a heartbeat-only zombie cannot remain healthy forever: failed challenges -> UNRESPONSIVE -> TERMINATING -> ORPHANED (capabilities revoked)", async () => {
    const root = await enrollRoot();
    const kid = await activeChild(root.agent.agentId, "sbx-zombie");
    const zombie = client(kid.cred, lyingResponder);
    for (let i = 0; i < 3; i++) expect(await zombie.heartbeat(kid.agentId)).toBe(true);
    expect(await status(kid.agentId)).toBe("unresponsive");
    expect(await events("health_challenge_failed", kid.agentId)).toBe(3);
    // Keeps heartbeating: still unresponsive (heartbeats do not restore health).
    for (let i = 0; i < 3; i++) await zombie.heartbeat(kid.agentId);
    expect(await status(kid.agentId)).toBe("unresponsive");
    // Unresponsive longer than the termination grace, despite fresh heartbeats -> TERMINATING.
    await armReaper();
    await ownerRaw.query("UPDATE fleet.fleet_agents SET unresponsive_since = now() - interval '1 hour' WHERE agent_id = $1", [kid.agentId]);
    expect(await svc.reap("t")).toMatchObject({ terminating: 1 });
    expect(await status(kid.agentId)).toBe("terminating");
    // Capabilities revoked immediately: no session, no heartbeat, no spend, no replication.
    expect(await zombie.heartbeat(kid.agentId)).toBe(false);
    const custody = (await ownerRaw.query("SELECT spending_frozen FROM fleet.fleet_wallet_custody WHERE agent_id = $1", [kid.agentId])).rows[0];
    expect(custody.spending_frozen).toBe(true);
    const creds = (await ownerRaw.query("SELECT revoked_at FROM fleet.fleet_agent_credentials WHERE agent_id = $1", [kid.agentId])).rows[0];
    expect(creds.revoked_at).not.toBeNull();
    // Provider cannot stop it -> ORPHANED, holding a quarantine slot; audit record kept.
    await service!.processTerminations();
    expect(await status(kid.agentId)).toBe("orphaned");
    const st = await admin.getState();
    expect(st).toMatchObject({ livingAgents: 1, quarantinedSlots: 1 });
    expect((await admin.listOrphans({ open: true })).find((o) => o.agent_id === kid.agentId)).toMatchObject({ holds_slot: true, sandbox_id: "sbx-zombie" });
    expect(await events("agent_orphaned", kid.agentId)).toBe(1);
    expect((await admin.health()).countersConsistent).toBe(true);
  });

  it("stale health alone (no answers at all) makes an ACTIVE agent UNRESPONSIVE even with fresh heartbeats", async () => {
    const root = await enrollRoot();
    const kid = await activeChild(root.agent.agentId);
    await svc.heartbeat(kid.agentId);
    await armReaper();
    await ownerRaw.query("UPDATE fleet.fleet_agents SET activated_at = now() - interval '1 hour', last_heartbeat = now() WHERE agent_id = $1", [kid.agentId]);
    const r = await svc.reap("t");
    expect(r.unresponsive).toBe(1);
    expect((await admin.getAgent(kid.agentId))!.status).toBe("unresponsive");
    // No sandbox known -> termination eligibility leads straight to DEAD.
    await ownerRaw.query("UPDATE fleet.fleet_agents SET unresponsive_since = now() - interval '1 hour' WHERE agent_id = $1", [kid.agentId]);
    expect((await svc.reap("t")).dead).toBe(1);
    expect(await status(kid.agentId)).toBe("dead");
  });

  it("a failing policy canary counts as a failed health check", async () => {
    const root = await enrollRoot();
    const kid = await activeChild(root.agent.agentId);
    const c = client(kid.cred, brokenPolicyResponder);
    await c.heartbeat(kid.agentId);
    expect(c.lastChallenge).toMatchObject({ passed: false, code: "FLEET_CHALLENGE_FAILED" });
    const row = (await ownerRaw.query("SELECT challenge_failures, health_reason FROM fleet.fleet_agents WHERE agent_id = $1", [kid.agentId])).rows[0];
    expect(row).toMatchObject({ challenge_failures: 1, health_reason: "policy canary not blocked" });
  });

  it("orphan policy: unresolved orphans beyond the limit block replication; quarantine slots count against the cap; hold expiry and operator resolution", async () => {
    await reset(4);
    const root = await enrollRoot();
    const kids = [await activeChild(root.agent.agentId, "sbx-o1"), await activeChild(root.agent.agentId, "sbx-o2")];
    for (const k of kids) await admin.quarantine(k.agentId, "test quarantine", "operator:t");
    await service!.processTerminations();
    expect((await admin.getState()).quarantinedSlots).toBe(2);
    // 2 open orphans > max 1 -> replication blocked fleet-wide.
    const denied = await admin.reserveSlot({ parentAgentId: root.agent.agentId, requestedBy: "t", name: "x", runtime: PIN });
    expect(!denied.ok && denied.code).toBe("FLEET_ORPHANS_UNRESOLVED");
    // Operator confirms external cleanup of one -> resolved, slot freed.
    expect(await admin.resolveOrphan(kids[0].agentId, "sandbox deleted manually in provider console", "operator:t")).toBe(true);
    expect(await status(kids[0].agentId)).toBe("dead");
    // Hold expiry releases the other slot but keeps the orphan record open (still counted for the replication block).
    await ownerRaw.query("UPDATE fleet.fleet_agents SET quarantined_at = now() - interval '4 days' WHERE agent_id = $1", [kids[1].agentId]);
    expect((await svc.reap("t")).orphanSlotsReleased).toBe(1);
    expect(await status(kids[1].agentId)).toBe("dead");
    expect((await admin.getState()).quarantinedSlots).toBe(0);
    expect((await admin.listOrphans({ open: true })).map((o) => o.agent_id)).toEqual([kids[1].agentId]);
    expect((await admin.health()).countersConsistent).toBe(true);
  });

  it("a quarantined agent cannot replicate, act or authenticate", async () => {
    const root = await enrollRoot();
    const kid = await activeChild(root.agent.agentId, "sbx-q");
    const c = client(kid.cred);
    expect(await c.heartbeat(kid.agentId)).toBe(true);
    expect(await admin.quarantine(kid.agentId, "suspicious", "operator:t")).toBe("terminating");
    expect(await c.heartbeat(kid.agentId)).toBe(false);
    const rep = await c.reserveSlot({ name: "grandchild" }).catch((e) => ({ ok: false, code: String(e) }));
    expect(rep.ok).toBe(false);
    const viaDb = await admin.reserveSlot({ parentAgentId: kid.agentId, requestedBy: "t", name: "g", runtime: PIN });
    expect(!viaDb.ok && viaDb.code).toBe("FLEET_PARENT_NOT_LIVING");
    const direct = await agentRaw.query("SELECT fleet.api_heartbeat($1, $2) AS r", [kid.agentId, kid.cred.token]);
    expect(direct.rows[0].r).toMatchObject({ ok: false });
    expect(["FLEET_AGENT_QUARANTINED", "FLEET_AUTH_FAILED"]).toContain(direct.rows[0].r.code);
  });

  // ── Part B: authenticated, short-lived, replay-protected requests

  it("the long-lived credential only opens sessions; sessions cannot open sessions", async () => {
    const root = await enrollRoot();
    const bare = await fetch(`${url}/v1/state`, { headers: { authorization: `Bearer ${root.cred.token}` } });
    expect(bare.status).toBe(401);
    expect((await bare.json()).code).toBe("FLEET_SESSION_REQUIRED");
    const s = await fetch(`${url}/v1/session`, { method: "POST", headers: { authorization: `Bearer ${root.cred.token}` } });
    const { sessionToken } = await s.json();
    expect(sessionToken).toMatch(/^fs1\./);
    const nested = await fetch(`${url}/v1/session`, { method: "POST", headers: { authorization: `Bearer ${sessionToken}` } });
    expect(nested.status).toBe(401);
    const db = await agentRaw.query("SELECT fleet.api_open_session($1, $2, $3) AS r", [root.agent.agentId, sessionToken, "e".repeat(64)]);
    expect(db.rows[0].r).toMatchObject({ ok: false });
  });

  it("forged / wrong-agent identity is refused (token scoped to one agent)", async () => {
    const a = await enrollRoot("a");
    const b = await enrollRoot("b");
    // A's session secret with B's agent id: the DB finds no such session for B.
    const s = await (await fetch(`${url}/v1/session`, { method: "POST", headers: { authorization: `Bearer ${a.cred.token}` } })).json();
    const secret = (s.sessionToken as string).split(".")[2];
    const forged = `fs1.${b.agent.agentId}.${secret}`;
    const ts = String(Date.now());
    const nonce = randomBytes(18).toString("base64url");
    const r = await fetch(`${url}/v1/state`, {
      headers: { authorization: `FleetSession ${forged}`, [SIG_HEADERS.ts]: ts, [SIG_HEADERS.nonce]: nonce, [SIG_HEADERS.sig]: signRequest(forged, "GET", "/v1/state", ts, nonce, "") },
    });
    expect(r.status).toBe(401);
    // A's long-lived credential presented as B.
    const wrong = new FleetApiClient({ baseUrl: url, agentId: a.agent.agentId, token: a.cred.token, healthResponder: honestResponder });
    expect(await wrong.heartbeat(b.agent.agentId)).toBe(false);
    expect(() => new FleetApiClient({ baseUrl: url, agentId: b.agent.agentId, token: a.cred.token })).toThrow(/does not belong/);
    // A fabricated session never issued by the service.
    const fake = mintSessionToken(a.agent.agentId);
    const r2 = await fetch(`${url}/v1/state`, {
      headers: { authorization: `FleetSession ${fake}`, [SIG_HEADERS.ts]: ts, [SIG_HEADERS.nonce]: randomBytes(18).toString("base64url"), [SIG_HEADERS.sig]: "0".repeat(64) },
    });
    expect(r2.status).toBe(401);
    expect(await events("db_auth_failed")).toBeGreaterThanOrEqual(1);
  });

  it("a replayed request is refused (single-use nonce, shared across service instances)", async () => {
    const root = await enrollRoot();
    const captured: Array<{ url: string; init: RequestInit }> = [];
    const spy: typeof fetch = async (u, init) => {
      captured.push({ url: String(u), init: init! });
      return fetch(u, init);
    };
    const c = client(root.cred, honestResponder, spy);
    expect(await c.heartbeat(root.agent.agentId)).toBe(true);
    const hb = captured.find((x) => x.url.endsWith("/v1/heartbeat"))!;
    const replay = await fetch(hb.url, { method: "POST", headers: hb.init.headers, body: hb.init.body });
    expect(replay.status).toBe(409);
    expect((await replay.json()).code).toBe("FLEET_REQUEST_REPLAYED");
    // Replayed against a second, independent service instance: still refused.
    const other = new FleetService({ admin: svc, agent: gateway, realReplicationEnabled: false, reaperIntervalMs: 0, release: RELEASE });
    const otherUrl = (await other.listen(0, "127.0.0.1")).url;
    try {
      const r2 = await fetch(`${otherUrl}/v1/heartbeat`, { method: "POST", headers: hb.init.headers, body: hb.init.body });
      expect(r2.status).toBe(409);
    } finally {
      await other.close();
    }
    // Tampered body with the captured signature: refused.
    const tampered = await fetch(hb.url, { method: "POST", headers: { ...(hb.init.headers as Record<string, string>), [SIG_HEADERS.nonce]: randomBytes(18).toString("base64url") }, body: hb.init.body });
    expect(tampered.status).toBe(401);
    expect(await events("request_replay_blocked")).toBeGreaterThanOrEqual(1);
  });

  it("stale timestamps and expired sessions are refused; the client transparently opens a new session", async () => {
    const root = await enrollRoot();
    const c = client(root.cred);
    expect(await c.heartbeat(root.agent.agentId)).toBe(true);
    // Expire every session server-side.
    await ownerRaw.query("UPDATE fleet.fleet_agent_sessions SET expires_at = now() - interval '1 second'");
    const s = (await ownerRaw.query("SELECT count(*)::int AS n FROM fleet.fleet_agent_sessions")).rows[0].n;
    expect(await c.heartbeat(root.agent.agentId)).toBe(true);
    expect((await ownerRaw.query("SELECT count(*)::int AS n FROM fleet.fleet_agent_sessions")).rows[0].n).toBe(s + 1);
    // Direct use of an expired session token is refused by the database.
    const exp = mintSessionToken(root.agent.agentId);
    await ownerRaw.query("INSERT INTO fleet.fleet_agent_sessions (session_hash, agent_id, expires_at) VALUES ($1, $2, now() - interval '1 minute')", [hashAgentToken(exp), root.agent.agentId]);
    expect((await agentRaw.query("SELECT fleet.api_whoami($1, $2) AS r", [root.agent.agentId, exp])).rows[0].r).toMatchObject({ ok: false, code: "FLEET_SESSION_EXPIRED" });
    // Stale timestamp.
    const tok = (await (await fetch(`${url}/v1/session`, { method: "POST", headers: { authorization: `Bearer ${root.cred.token}` } })).json()).sessionToken;
    const ts = String(Date.now() - 10 * 60_000);
    const nonce = randomBytes(18).toString("base64url");
    const old = await fetch(`${url}/v1/state`, { headers: { authorization: `FleetSession ${tok}`, [SIG_HEADERS.ts]: ts, [SIG_HEADERS.nonce]: nonce, [SIG_HEADERS.sig]: signRequest(tok, "GET", "/v1/state", ts, nonce, "") } });
    expect(old.status).toBe(401);
    expect((await old.json()).code).toBe("FLEET_REQUEST_STALE");
  });

  it("requests after death, quarantine or credential revocation are refused", async () => {
    const root = await enrollRoot();
    const kidA = await activeChild(root.agent.agentId);
    const kidB = await activeChild(root.agent.agentId, "sbx-rq");
    const kidC = await activeChild(root.agent.agentId);
    const [ca, cb, cc] = [client(kidA.cred), client(kidB.cred), client(kidC.cred)];
    for (const [c, k] of [[ca, kidA], [cb, kidB], [cc, kidC]] as const) expect(await c.heartbeat(k.agentId)).toBe(true);
    await admin.markDead(kidA.agentId, "died", "t");
    await admin.quarantine(kidB.agentId, "q", "operator:t");
    await admin.issueCredential(kidC.agentId, "operator:rotate"); // rotation revokes existing sessions
    expect(await ca.heartbeat(kidA.agentId)).toBe(false);
    expect(await cb.heartbeat(kidB.agentId)).toBe(false);
    expect(await cc.heartbeat(kidC.agentId)).toBe(false); // old long-lived credential cannot open a new session either
    // A dead agent may still learn that it is dead (so it shuts down), but can do nothing else.
    expect(await ca.selfStatus(kidA.agentId).catch(() => null)).not.toBe("active");
    await expect(ca.requestSpend({ fromWallet: kidA.wallet, toAddress: wallet(), amountCents: 1, purpose: "x" })).rejects.toThrow();
    const spend = await cb.requestSpend({ fromWallet: kidB.wallet, toAddress: wallet(), amountCents: 10, purpose: "x" }).catch((e) => e);
    expect(spend).toBeInstanceOf(Error);
  });

  it("rate limiting: per-agent request limit and per-address authentication-failure limit", async () => {
    await startService({ rateLimits: { perAgent: { capacity: 4, refillPerSec: 0.001 }, authFailuresPerIp: { capacity: 2, refillPerSec: 0.001 } } });
    const root = await enrollRoot();
    const c = client(root.cred);
    const results: boolean[] = [];
    for (let i = 0; i < 6; i++) results.push(await c.getState().then(() => true, () => false));
    expect(results.filter(Boolean).length).toBeLessThan(6);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await fetch(`${url}/v1/state`, { headers: { authorization: "Bearer junk" } })).status);
    expect(codes).toContain(429);
    expect(audit.some((e) => e.event === "rate_limited")).toBe(true);
  });

  it("every API request is audit-logged without secrets", async () => {
    const root = await enrollRoot();
    await client(root.cred).heartbeat(root.agent.agentId);
    const reqs = audit.filter((e) => e.event === "api_request");
    expect(reqs.length).toBeGreaterThanOrEqual(2);
    expect(reqs.find((e) => e.detail?.path === "/v1/heartbeat")).toMatchObject({ agentId: root.agent.agentId, detail: { method: "POST", status: 200 } });
    expect(JSON.stringify(audit)).not.toContain(root.cred.token);
    expect(JSON.stringify(audit)).not.toMatch(/fs1\.[0-9A-Z]{26}\.[A-Za-z0-9_-]{43}/);
  });

  it("the service serves HTTPS when TLS is configured", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-tls-"));
    try {
      execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
        "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem")], { stdio: "ignore" });
      const cert = fs.readFileSync(path.join(dir, "c.pem"));
      const tlsService = new FleetService({ admin: svc, agent: gateway, realReplicationEnabled: false, reaperIntervalMs: 0, release: RELEASE, tls: { cert, key: fs.readFileSync(path.join(dir, "k.pem")) } });
      const u = (await tlsService.listen(0, "127.0.0.1")).url;
      try {
        expect(u).toMatch(/^https:/);
        const body = await new Promise<string>((resolve, reject) =>
          https.get(`${u}/healthz`, { ca: cert }, (res) => { let d = ""; res.on("data", (x) => (d += x)); res.on("end", () => resolve(d)); }).on("error", reject),
        );
        expect(JSON.parse(body)).toMatchObject({ ok: true, status: "alive" });
        await expect(fetch(u.replace("https:", "http:") + "/healthz")).rejects.toThrow();
      } finally {
        await tlsService.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Parts C–E through the database

  it("an agent can propose capital but can never approve its own exception", async () => {
    const root = await enrollRoot();
    const kid = await activeChild(root.agent.agentId);
    const c = client(kid.cred);
    const prop = await c.proposeCapital({ purpose: "launch a paid newsletter", requestedCents: 50_000, expectedReturnCents: 90_000, expectedDurationDays: 30 });
    expect(prop.status).toBe("proposed");
    // No approval surface for agents: no HTTP endpoint, no DB privilege.
    const tok = (await (await fetch(`${url}/v1/session`, { method: "POST", headers: { authorization: `Bearer ${kid.cred.token}` } })).json()).sessionToken;
    const ts = String(Date.now());
    const nonce = randomBytes(18).toString("base64url");
    const body = JSON.stringify({ allocationId: prop.allocationId });
    const approveHttp = await fetch(`${url}/v1/capital/approve`, {
      method: "POST",
      headers: { authorization: `FleetSession ${tok}`, "content-type": "application/json", [SIG_HEADERS.ts]: ts, [SIG_HEADERS.nonce]: nonce, [SIG_HEADERS.sig]: signRequest(tok, "POST", "/v1/capital/approve", ts, nonce, body) },
      body,
    });
    expect(approveHttp.status).toBe(404);
    await expect(agentRaw.query("UPDATE fleet.fleet_capital_allocations SET status = 'approved' WHERE allocation_id = $1", [prop.allocationId])).rejects.toThrow(/permission denied/);
    // Even through the admin path, the agent (or any agent / its wallet) as approver is refused by the database.
    for (const approver of [kid.agentId, root.agent.agentId, kid.wallet]) {
      await expect(treasury.approveAllocation(prop.allocationId, { approvedCents: 50_000, reason: "self" }, approver)).rejects.toThrow(/FLEET_SELF_APPROVAL/);
      await expect(treasury.reduceSweep({ agentId: kid.agentId, reductionPct: 0.5, reason: "self", expiresAt: new Date(Date.now() + DAY) }, approver)).rejects.toThrow(/FLEET_SELF_APPROVAL/);
    }
    await treasury.approveAllocation(prop.allocationId, { approvedCents: 40_000, reason: "promising" }, "operator:alice");
    expect((await treasury.listAllocations(kid.agentId))[0]).toMatchObject({ status: "approved", approvedAmountCents: 40_000, decidedBy: "operator:alice" });
  });

  it("FleetAdmin controls: approve, reject, change, reduce sweep, freeze; legacy custody transfers are superseded by the v10 ledger", async () => {
    const root = await enrollRoot();
    const kid = await activeChild(root.agent.agentId);
    const a1 = await treasury.proposeAllocation({ agentId: kid.agentId, purpose: "p1", requestedCents: 10_000, expectedReturnCents: 12_000, expectedDurationDays: 10 }, "operator:bob");
    const a2 = await treasury.proposeAllocation({ agentId: kid.agentId, purpose: "p2", requestedCents: 10_000, expectedReturnCents: 12_000, expectedDurationDays: 10 }, "operator:bob");
    await treasury.approveAllocation(a1, { approvedCents: 8_000, reason: "ok" }, "operator:alice");
    await treasury.rejectAllocation(a2, "no", "operator:alice");
    await treasury.changeAllocation(a1, { approvedCents: 9_000, reason: "raise" }, "operator:alice");
    await expect(treasury.approveAllocation(a2, { approvedCents: 1, reason: "late" }, "operator:alice")).rejects.toThrow(/TERMINAL_STATE/);
    const rid = await treasury.reduceSweep({ agentId: kid.agentId, reductionPct: 0.4, reason: "high-value launch", expiresAt: new Date(Date.now() + 7 * DAY), allocationId: a1 }, "operator:alice");
    expect(rid).toMatch(/^[0-9A-Z]{26}$/);
    await treasury.freezeSpending(kid.agentId, true, "audit", "operator:alice");
    // Schema v10: value moves only through the central ledger; the v5 transfer register is frozen.
    await expect(
      treasury.planCustodyTransfer({ fromAgentId: kid.agentId, destination: "fleet_treasury", amountCents: 500, policy: "quarantine_recovery", reason: "test" }, "operator:alice"),
    ).rejects.toThrow(/FLEET_LEGACY_SUPERSEDED/);
    expect((await ownerRaw.query("SELECT count(*)::int AS n FROM fleet.fleet_custody_transfers")).rows[0].n).toBe(0);
    expect(await events("custody_transfer_planned", kid.agentId)).toBe(0);
  });

  it("the legacy wallet spend path is superseded; the v10 spend order path refuses other agents' destinations, frozen, unfunded and dead agents; nothing executes", async () => {
    const root = await enrollRoot();
    const a = await activeChild(root.agent.agentId);
    const b = await activeChild(root.agent.agentId);
    await treasury.setDailySpendLimit(a.agentId, 1_000, "operator:alice");
    const ca = client(a.cred);
    // v5 path: refused for everyone, own wallet or not, with the explicit supersession code.
    for (const fromWallet of [b.wallet, a.wallet]) {
      const r = await ca.requestSpend({ fromWallet, toAddress: wallet(), amountCents: 10, purpose: "x" }).catch((e) => e);
      expect(r).toBeInstanceOf(Error);
      expect((r as { code?: string }).code).toBe("FLEET_LEGACY_SUPERSEDED");
    }
    expect((await ownerRaw.query("SELECT count(*)::int AS n FROM fleet.fleet_spend_requests")).rows[0].n).toBe(0);
    // v10 path over HTTP: no allocation -> refused; the agent names only a destination id, never an address.
    const dst = `dst_${"0".repeat(26)}`;
    const order = (amountCents: number) => ca.spendOrder({ idempotencyKey: `t:${ulid()}`, amountCents, category: "expense", destinationId: dst, purpose: "hosting" });
    await expect(order(1)).rejects.toMatchObject({ code: "FLEET_DESTINATION_NOT_ALLOWED" });
    await expect(ca.spendOrder({ idempotencyKey: "short", amountCents: 1, category: "expense", destinationId: dst, purpose: "x" })).rejects.toMatchObject({ status: 400 });
    await expect(ca.spendOrder({ idempotencyKey: `t:${ulid()}`, amountCents: 1, category: "expense", destinationId: "0xabc", purpose: "x" })).rejects.toMatchObject({ status: 400 });
    expect(await ca.ledger()).toMatchObject({ cash: 0, reserved: 0, protectedPrincipal: 0, lifetimeContribution: 0 }); // nothing allocated
    await treasury.freezeSpending(a.agentId, true, "operator review", "operator:alice");
    await expect(order(1)).rejects.toMatchObject({ code: expect.stringMatching(/^FLEET_/) });
    // A dead agent cannot use either path.
    const cb = client(b.cred);
    await cb.heartbeat(b.agentId);
    await admin.markDead(b.agentId, "retired", "t");
    await expect(cb.requestSpend({ fromWallet: b.wallet, toAddress: wallet(), amountCents: 1, purpose: "x" })).rejects.toThrow();
    await expect(cb.spendOrder({ idempotencyKey: `t:${ulid()}`, amountCents: 1, category: "expense", destinationId: dst, purpose: "x" })).rejects.toThrow();
    expect((await ownerRaw.query("SELECT count(*)::int AS n FROM fleet.fleet_payment_orders WHERE status IN ('executing','settled')")).rows[0].n).toBe(0);
  });

  it("treasury policy and obligations stay registers; v5 treasury money records and owner distributions are superseded by the v10 ledger", async () => {
    await expect(treasury.setPolicy({ treasuryAddress: "0x" + "1".repeat(40), ownerWithdrawalAddress: "0x" + "1".repeat(40) }, "operator:alice")).rejects.toThrow();
    await treasury.setPolicy({ treasuryAddress: "0x" + "1".repeat(40), ownerWithdrawalAddress: "0x" + "2".repeat(40), reserveTargetMonths: 3 }, "operator:alice");
    await expect(treasury.recordTreasury({ kind: "sweep_in", amountCents: 300_000 }, "operator:alice")).rejects.toThrow(/FLEET_LEGACY_SUPERSEDED/);
    await treasury.addTreasuryObligation({ category: "inference", description: "Q3 inference", amountCents: 100_000, dueAt: new Date(Date.now() + 30 * DAY) }, "operator:alice");
    await expect(treasury.planOwnerDistribution(50_000, "operator:alice")).rejects.toThrow(/FLEET_LEGACY_SUPERSEDED/);
    expect((await treasury.treasuryPosition()).balanceCents).toBe(0);
    await expect(ownerRaw.query("INSERT INTO fleet.fleet_owner_distributions (distribution_id, requested_cents, approved_cents, treasury_balance_cents, reserve_target_cents, obligations_cents, status, reason, decided_by) VALUES ($1, 10, 10, 100, 100, 0, 'planned_not_executed', 'x', 'operator:x')", [ulid()])).rejects.toThrow(/check constraint|FLEET_LEGACY_SUPERSEDED/);
  });

  it("v5 agent ledger, balance observations and sweep plans are superseded; obligations remain a register", async () => {
    const root = await enrollRoot();
    const kid = await activeChild(root.agent.agentId);
    await expect(treasury.recordAgentLedger({ agentId: kid.agentId, kind: "revenue", amountCents: 200_000 }, "operator:alice")).rejects.toThrow(/FLEET_LEGACY_SUPERSEDED/);
    await expect(treasury.recordBalance(kid.agentId, 1_197_000)).rejects.toThrow(/FLEET_LEGACY_SUPERSEDED/);
    await treasury.addObligation({ agentId: kid.agentId, description: "domain renewal", amountCents: 50_000, dueAt: new Date(Date.now() + 10 * DAY) }, "operator:alice");
    await expect(treasury.planSweep(kid.agentId, "operator:alice", { cashCents: 1_197_000 })).rejects.toThrow(/FLEET_LEGACY_SUPERSEDED/);
    expect((await ownerRaw.query("SELECT count(*)::int AS n FROM fleet.fleet_sweep_plans")).rows[0].n).toBe(0);
    await admin.quarantine(kid.agentId, "q", "operator:alice");
    await expect(treasury.planSweep(kid.agentId, "operator:alice")).rejects.toThrow(/only for active agents|FLEET_LEGACY_SUPERSEDED/);
  });

  it("discretionary limits are enforced on approval unless explicitly overridden", async () => {
    const root = await enrollRoot();
    const kid = await activeChild(root.agent.agentId);
    for (let i = 0; i < 4; i++) {
      const id = await treasury.proposeAllocation({ agentId: kid.agentId, purpose: `bet ${i}`, requestedCents: 1_000, expectedReturnCents: 2_000, expectedDurationDays: 5 }, "operator:bob");
      await treasury.approveAllocation(id, { approvedCents: 1_000, reason: "try" }, "operator:alice");
      await treasury.recordDeployment(id, 1_000, "operator:alice");
      await treasury.completeAllocation(id, 0, "operator:alice");
    }
    const prof = await treasury.performanceProfile(kid.agentId);
    expect(prof.consecutiveFailures).toBe(4);
    expect(prof.discretionaryMultiplier).toBe(0);
    const next = await treasury.proposeAllocation({ agentId: kid.agentId, purpose: "again", requestedCents: 1_000, expectedReturnCents: 2_000, expectedDurationDays: 5 }, "operator:bob");
    await expect(treasury.approveAllocation(next, { approvedCents: 1_000, reason: "x", baseDiscretionaryCents: 5_000 }, "operator:alice")).rejects.toThrow(/discretionary limit/);
    await treasury.approveAllocation(next, { approvedCents: 1_000, reason: "operator judgement", baseDiscretionaryCents: 5_000, override: true }, "operator:alice");
    expect((await treasury.rescueAdvice(kid.agentId, 10)).recommended).toBe(false);
  });
});
