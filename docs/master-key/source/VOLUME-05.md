# SOURCE VOLUME 05 — Treasury (src/fleet/treasury)

Exact, byte-for-byte text of each file at repository commit `efad2148a3460ab881b0ab845fb13c25d1fa3e74` (branch fleet-development).
No file in this volume contains a real secret; test fixtures generate synthetic secrets at runtime.
Each file's SHA-256 is of the file bytes on disk and matches 22-RECONSTRUCTION-MANIFEST.md.

## Files

- `src/fleet/treasury/cli.ts` — 162 lines, sha256 `5af1e67e9308d227722113ea06ac4692d4c9e3bb86a3c49da972bc52db3087ec`
- `src/fleet/treasury/custody.ts` — 39 lines, sha256 `b0e82a997f2ce4ce8ea746296d1c923101a6acb48ca700803a0a71bbaf6c21e2`
- `src/fleet/treasury/engine.ts` — 604 lines, sha256 `c3d03ff9cd191598294d1393c4d1062111a1576b3c52d548396830bfc62372e2`
- `src/fleet/treasury/store.ts` — 543 lines, sha256 `3a32a8555d89dc9e959e1cfa17ffea03ddc96b7b6956ecc6a7cbcd1b91583441`

## `src/fleet/treasury/cli.ts`

sha256 `5af1e67e9308d227722113ea06ac4692d4c9e3bb86a3c49da972bc52db3087ec` · 7338 bytes · 162 lines

```ts
/**
 * FleetAdmin treasury commands (Phase 5), dispatched from `pnpm fleet:admin`.
 * All require the admin credential. Nothing here moves money.
 *
 *   treasury-policy [runwayDays=N] [contingencyPct=X] [minContingencyCents=N] [matureFleetRate=X] [maxSweepRate=X]
 *                   [reserveTargetMonths=X] [maturityAgeDays=N] [treasuryAddress=0x..] [ownerWithdrawalAddress=0x..]
 *   treasury-position
 *   treasury-record <kind> <cents> [agentId]           observed treasury movement (sweep_in, infrastructure, …)
 *   ledger <agentId> <kind> <cents> [reference]         agent ledger entry (revenue, direct_cost, owner_funding, …)
 *   balance <agentId> <cents>                           observed agent cash
 *   obligation <agentId> <cents> <dueInDays> <description…>
 *   capital-list [agentId]
 *   capital-approve <allocationId> <cents> <days> <reason…> [--override]
 *   capital-reject <allocationId> <reason…>
 *   capital-change <allocationId> [cents=N] [expiryDays=N] <reason…>
 *   capital-complete <allocationId> <actualReturnCents>
 *   sweep-reduce <agentId> <pct 0..1> <days> <reason…>
 *   sweep-plan <agentId> [cashCents]
 *   spending-freeze <agentId> <reason…> | spending-unfreeze <agentId> <reason…> | spending-limit <agentId> <cents>
 *   custody-transfer <fromAgentId> <treasury|agentId> <cents> <policy> <reason…>
 *   owner-distribute <cents>
 *   profile <agentId>                                   internal capital-performance profile
 *   rescue-advice <agentId> [cashCents]
 */

import type { AgentLedgerKind, TreasuryKind } from "./engine.js";
import type { PgTreasuryStore, TreasuryPolicyRecord } from "./store.js";

export const TREASURY_COMMANDS = new Set([
  "treasury-policy", "treasury-position", "treasury-record", "ledger", "balance", "obligation",
  "capital-list", "capital-approve", "capital-reject", "capital-change", "capital-complete",
  "sweep-reduce", "sweep-plan", "spending-freeze", "spending-unfreeze", "spending-limit",
  "custody-transfer", "owner-distribute", "profile", "rescue-advice",
]);

const DAY = 86_400_000;

function int(v: string | undefined, name: string): number {
  if (!v || !/^\d+$/.test(v)) throw new Error(`${name} must be a non-negative integer`);
  return Number(v);
}

function kv(args: string[]): { pairs: Record<string, string>; rest: string[] } {
  const pairs: Record<string, string> = {};
  const rest: string[] = [];
  for (const a of args) {
    const m = /^([A-Za-z]+)=(.*)$/.exec(a);
    if (m) pairs[m[1]] = m[2];
    else rest.push(a);
  }
  return { pairs, rest };
}

export async function runTreasuryCommand(cmd: string, a: string[], ts: PgTreasuryStore, actor: string): Promise<unknown> {
  switch (cmd) {
    case "treasury-policy": {
      const { pairs } = kv(a);
      if (!Object.keys(pairs).length) return ts.getPolicy();
      const patch: Partial<TreasuryPolicyRecord> = {};
      for (const [k, v] of Object.entries(pairs)) {
        if (k === "treasuryAddress" || k === "ownerWithdrawalAddress") (patch as Record<string, unknown>)[k] = v || null;
        else if (["runwayDays", "contingencyPct", "minContingencyCents", "matureFleetRate", "maxSweepRate", "reserveTargetMonths", "maturityAgeDays"].includes(k)) {
          (patch as Record<string, unknown>)[k] = Number(v);
        } else throw new Error(`unknown policy key ${k}`);
      }
      return ts.setPolicy(patch, actor);
    }
    case "treasury-position":
      return ts.treasuryPosition();
    case "treasury-record":
      await ts.recordTreasury({ kind: a[0] as TreasuryKind, amountCents: int(a[1], "cents"), agentId: a[2] }, actor);
      return ts.treasuryPosition();
    case "ledger":
      await ts.recordAgentLedger({ agentId: a[0], kind: a[1] as AgentLedgerKind, amountCents: int(a[2], "cents"), reference: a[3] }, actor);
      return { recorded: true };
    case "balance":
      await ts.recordBalance(a[0], int(a[1], "cents"), "operator");
      return { recorded: true };
    case "obligation":
      return {
        obligationId: await ts.addObligation(
          { agentId: a[0], amountCents: int(a[1], "cents"), dueAt: new Date(Date.now() + int(a[2], "dueInDays") * DAY), description: a.slice(3).join(" ") },
          actor,
        ),
      };
    case "capital-list":
      return ts.listAllocations(a[0]);
    case "capital-approve": {
      const override = a.includes("--override");
      const args = a.filter((x) => x !== "--override");
      const start = new Date();
      await ts.approveAllocation(
        args[0],
        { approvedCents: int(args[1], "cents"), startDate: start, expiryDate: new Date(start.getTime() + int(args[2], "days") * DAY), reason: args.slice(3).join(" ") || "approved", override },
        actor,
      );
      return ts.listAllocations().then((l) => l.find((x) => x.allocationId === args[0]));
    }
    case "capital-reject":
      await ts.rejectAllocation(a[0], a.slice(1).join(" ") || "rejected", actor);
      return { rejected: a[0] };
    case "capital-change": {
      const { pairs, rest } = kv(a.slice(1));
      await ts.changeAllocation(
        a[0],
        {
          approvedCents: pairs.cents !== undefined ? int(pairs.cents, "cents") : undefined,
          expiryDate: pairs.expiryDays !== undefined ? new Date(Date.now() + int(pairs.expiryDays, "expiryDays") * DAY) : undefined,
          reason: rest.join(" ") || "changed",
        },
        actor,
      );
      return { changed: a[0] };
    }
    case "capital-complete":
      await ts.completeAllocation(a[0], int(a[1], "actualReturnCents"), actor);
      return { completed: a[0] };
    case "sweep-reduce": {
      const pct = Number(a[1]);
      return {
        reductionId: await ts.reduceSweep(
          { agentId: a[0], reductionPct: pct, expiresAt: new Date(Date.now() + int(a[2], "days") * DAY), reason: a.slice(3).join(" ") },
          actor,
        ),
      };
    }
    case "sweep-plan":
      return ts.planSweep(a[0], actor, { cashCents: a[1] !== undefined ? int(a[1], "cashCents") : undefined });
    case "spending-freeze":
    case "spending-unfreeze":
      await ts.freezeSpending(a[0], cmd === "spending-freeze", a.slice(1).join(" ") || cmd, actor);
      return { agentId: a[0], frozen: cmd === "spending-freeze" };
    case "spending-limit":
      await ts.setDailySpendLimit(a[0], int(a[1], "cents"), actor);
      return { agentId: a[0], dailyLimitCents: Number(a[1]) };
    case "custody-transfer": {
      const toTreasury = a[1] === "treasury";
      return {
        transferId: await ts.planCustodyTransfer(
          {
            fromAgentId: a[0],
            destination: toTreasury ? "fleet_treasury" : "agent",
            toAgentId: toTreasury ? undefined : a[1],
            amountCents: int(a[2], "cents"),
            policy: a[3] as "quarantine_recovery" | "death_recovery" | "rebalance" | "sweep",
            reason: a.slice(4).join(" "),
          },
          actor,
        ),
        executed: false,
      };
    }
    case "owner-distribute":
      return ts.planOwnerDistribution(int(a[0], "cents"), actor);
    case "profile":
      return ts.performanceProfile(a[0]);
    case "rescue-advice":
      return ts.rescueAdvice(a[0], a[1] !== undefined ? int(a[1], "cashCents") : undefined);
    default:
      throw new Error(`unknown treasury command ${cmd}`);
  }
}
```

## `src/fleet/treasury/custody.ts`

sha256 `b0e82a997f2ce4ce8ea746296d1c923101a6acb48ca700803a0a71bbaf6c21e2` · 1748 bytes · 39 lines

```ts
/**
 * Wallet custody (Phase 5)
 *
 * Model: agent wallets are supervised by the controller. An agent never
 * receives an owner or treasury private key, and spending goes through a
 * spend REQUEST to the fleet service (api_request_spend), which checks that
 * the wallet is the caller's own custody wallet, that the agent is healthy
 * and not frozen/quarantined, and that the amount is within an approved,
 * current allocation or the daily limit. FleetAdmin can freeze any wallet.
 *
 * Execution: an approved request is executed only by a controller-side
 * signer, only when REAL_PAYMENTS_ENABLED=true AND a signer is configured.
 * Neither is true in this phase, so nothing is ever signed or sent.
 */

export interface SpendDecision {
  requestId: string;
  decision: "denied" | "approved_not_executed";
  amountCents: number;
  toAddress: string;
}

export interface ControllerSigner {
  /** Signs and broadcasts a transfer from the custody wallet. Never exposed to agents. */
  send(req: SpendDecision): Promise<{ txHash: string }>;
}

export type ExecutionResult = { executed: false; reason: string } | { executed: true; txHash: string };

export async function executeApprovedSpend(
  decision: SpendDecision,
  env: Record<string, string | undefined>,
  signer: ControllerSigner | null,
): Promise<ExecutionResult> {
  if (decision.decision !== "approved_not_executed") return { executed: false, reason: "request was denied" };
  if (env.REAL_PAYMENTS_ENABLED?.trim().toLowerCase() !== "true") return { executed: false, reason: "REAL_PAYMENTS_ENABLED=false" };
  if (!signer) return { executed: false, reason: "no controller custody signer is configured" };
  return { executed: true, txHash: (await signer.send(decision)).txHash };
}
```

## `src/fleet/treasury/engine.ts`

sha256 `c3d03ff9cd191598294d1393c4d1062111a1576b3c52d548396830bfc62372e2` · 25565 bytes · 604 lines

```ts
/**
 * Fleet treasury economics (Phase 5) — pure calculation, no I/O.
 *
 * Permanent principle: capital stays with an agent while it has a credible
 * productive use; only genuine surplus is (heavily) swept to the fleet
 * treasury. Nothing required for approved operating obligations, protected
 * runway, approved growth or the contingency reserve is ever swept.
 *
 * Agent capital waterfall (all integer cents):
 *
 *   CASH ON HAND
 *   − OPERATING_OBLIGATIONS     approved, unsettled obligations
 *   − PROTECTED_RUNWAY          runway_days × daily direct-cost burn
 *   − APPROVED_GROWTH_CAPITAL   Σ unspent approved allocations that are current (start ≤ now < expiry)
 *   − CONTINGENCY_RESERVE       max(min_contingency, contingency_pct × 30 days of burn)
 *   = EXCESS_CAPITAL            (never negative)
 *
 *   sweep base   = min(EXCESS_CAPITAL, undistributed NET_PROFIT)
 *                  (owner funding is capital, never revenue or profit, so it is never swept as profit)
 *   FLEET_SWEEP  = floor(sweep base × effective rate)
 *   AGENT_RETAINED_CAPITAL = cash − FLEET_SWEEP  (≥ everything protected above, by construction)
 *
 * Nothing here moves money. Results are plans (REAL_PAYMENTS_ENABLED=false).
 */

export const HARD_MAX_SWEEP_RATE = 0.7;
const DAY_MS = 86_400_000;

// ─── Policy ──────────────────────────────────────────────────────

export interface PopulationBand {
  /** Upper bound (inclusive) of living agents for this band. */
  maxAgents: number;
  rate: number;
}

export interface TreasuryPolicy {
  runwayDays: number;
  contingencyPct: number;
  minContingencyCents: number;
  populationRates: PopulationBand[];
  /** Base rate at the full 50-agent fleet. */
  matureFleetRate: number;
  /** Absolute ceiling of the effective rate (≤ 0.70). */
  maxSweepRate: number;
  reserveTargetMonths: number;
  maturityAgeDays: number;
}

export const DEFAULT_POPULATION_RATES: readonly PopulationBand[] = Object.freeze([
  { maxAgents: 10, rate: 0.1 },
  { maxAgents: 20, rate: 0.125 },
  { maxAgents: 30, rate: 0.15 },
  { maxAgents: 40, rate: 0.175 },
  { maxAgents: 49, rate: 0.2 },
]);

export const DEFAULT_TREASURY_POLICY: Readonly<TreasuryPolicy> = Object.freeze({
  runwayDays: 30,
  contingencyPct: 0.1,
  minContingencyCents: 1000,
  populationRates: [...DEFAULT_POPULATION_RATES],
  matureFleetRate: 0.45,
  maxSweepRate: 0.7,
  reserveTargetMonths: 3,
  maturityAgeDays: 180,
});

/** Tuning constants of the dynamic rate (documented in FLEET.md). */
export const SWEEP_TUNING = Object.freeze({
  /** Excess at or beyond this multiple of the protected total counts as fully surplus. */
  surplusSaturation: 4,
  treasuryNeedWeight: 0.05,
  lossWeight: 0.05,
  productiveDiscountWeight: 0.1,
  targetRoi: 0.5,
});

export function validatePolicy(p: TreasuryPolicy): TreasuryPolicy {
  const bad = (m: string) => {
    throw new Error(`Invalid treasury policy: ${m}`);
  };
  if (!(p.maxSweepRate >= 0 && p.maxSweepRate <= HARD_MAX_SWEEP_RATE)) bad(`maxSweepRate must be 0..${HARD_MAX_SWEEP_RATE}`);
  if (!(p.matureFleetRate >= 0 && p.matureFleetRate <= p.maxSweepRate)) bad("matureFleetRate must be 0..maxSweepRate");
  if (!(p.runwayDays >= 0)) bad("runwayDays must be ≥ 0");
  if (!(p.contingencyPct >= 0 && p.contingencyPct <= 1)) bad("contingencyPct must be 0..1");
  if (!(p.minContingencyCents >= 0)) bad("minContingencyCents must be ≥ 0");
  if (!(p.reserveTargetMonths >= 0)) bad("reserveTargetMonths must be ≥ 0");
  if (!(p.maturityAgeDays >= 1)) bad("maturityAgeDays must be ≥ 1");
  let prev = 0;
  for (const b of p.populationRates) {
    if (!(b.maxAgents > prev && b.maxAgents < 50)) bad("population bands must increase and stay below 50");
    if (!(b.rate >= 0 && b.rate <= p.maxSweepRate)) bad("population band rate must be 0..maxSweepRate");
    prev = b.maxAgents;
  }
  return p;
}

// ─── Inputs ──────────────────────────────────────────────────────

export type AgentLedgerKind =
  | "revenue"
  | "direct_cost"
  | "owner_funding"
  | "fleet_funding"
  | "allocation_deployed"
  | "allocation_returned"
  | "sweep_to_treasury";

export interface AgentLedgerEntry {
  kind: AgentLedgerKind;
  amountCents: number;
  occurredAt: string | Date;
  allocationId?: string | null;
}

export interface Obligation {
  amountCents: number;
  dueAt: string | Date;
  status: "approved" | "settled" | "cancelled";
}

export type AllocationStatus = "proposed" | "approved" | "rejected" | "completed" | "expired" | "cancelled";

export interface CapitalAllocation {
  allocationId: string;
  agentId: string;
  kind: "growth" | "rescue";
  purpose: string;
  requestedAmountCents: number;
  approvedAmountCents: number | null;
  deployedCents: number;
  startDate: string | Date | null;
  expiryDate: string | Date | null;
  expectedReturnCents: number;
  expectedDurationDays: number;
  status: AllocationStatus;
  actualReturnCents: number | null;
  decidedAt?: string | Date | null;
}

export interface SweepReduction {
  reductionPct: number;
  startsAt: string | Date;
  expiresAt: string | Date;
  revokedAt?: string | Date | null;
  reason?: string;
}

const t = (d: string | Date | null | undefined): number => (d ? new Date(d).getTime() : NaN);
const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

// ─── Accounting ──────────────────────────────────────────────────

export interface LedgerSummary {
  grossRevenueCents: number;
  directCostsCents: number;
  /** GROSS_REVENUE − DIRECT_COSTS. Owner/fleet funding is excluded by construction. */
  netProfitCents: number;
  ownerFundingCents: number;
  fleetFundingCents: number;
  sweptToTreasuryCents: number;
  /** Cumulative net profit not yet swept (never includes funding). */
  undistributedProfitCents: number;
}

export function summarizeLedger(entries: readonly AgentLedgerEntry[], window?: { from?: number; to?: number }): LedgerSummary {
  const s = { revenue: 0, direct_cost: 0, owner_funding: 0, fleet_funding: 0, sweep_to_treasury: 0 } as Record<string, number>;
  for (const e of entries) {
    const at = t(e.occurredAt);
    if (window?.from !== undefined && at < window.from) continue;
    if (window?.to !== undefined && at > window.to) continue;
    if (!(e.amountCents > 0)) continue;
    if (e.kind in s) s[e.kind] += e.amountCents;
  }
  const net = s.revenue - s.direct_cost;
  return {
    grossRevenueCents: s.revenue,
    directCostsCents: s.direct_cost,
    netProfitCents: net,
    ownerFundingCents: s.owner_funding,
    fleetFundingCents: s.fleet_funding,
    sweptToTreasuryCents: s.sweep_to_treasury,
    undistributedProfitCents: Math.max(0, net - s.sweep_to_treasury),
  };
}

/** Average daily direct-cost burn over the lookback (or the agent's age, if younger; at least 1 day). */
export function dailyBurnCents(entries: readonly AgentLedgerEntry[], asOf: Date, lookbackDays: number, agentCreatedAt?: string | Date): number {
  const from = asOf.getTime() - lookbackDays * DAY_MS;
  const age = agentCreatedAt ? (asOf.getTime() - t(agentCreatedAt)) / DAY_MS : lookbackDays;
  const days = Math.max(1, Math.min(lookbackDays, Number.isFinite(age) ? age : lookbackDays));
  const costs = summarizeLedger(entries, { from, to: asOf.getTime() }).directCostsCents;
  return Math.ceil(costs / days);
}

/** An approved allocation protects capital only while current: start ≤ asOf < expiry. */
export function isAllocationCurrent(a: CapitalAllocation, asOf: Date): boolean {
  return a.status === "approved" && t(a.startDate) <= asOf.getTime() && asOf.getTime() < t(a.expiryDate);
}

export function approvedGrowthCapitalCents(allocations: readonly CapitalAllocation[], asOf: Date): number {
  return allocations
    .filter((a) => isAllocationCurrent(a, asOf))
    .reduce((sum, a) => sum + Math.max(0, (a.approvedAmountCents ?? 0) - a.deployedCents), 0);
}

export function operatingObligationsCents(obligations: readonly Obligation[]): number {
  return obligations.filter((o) => o.status === "approved").reduce((s, o) => s + Math.max(0, o.amountCents), 0);
}

/** Combined active temporary reduction: 1 − Π(1 − r). */
export function activeReduction(reductions: readonly SweepReduction[], asOf: Date): number {
  let keep = 1;
  for (const r of reductions) {
    if (r.revokedAt) continue;
    if (t(r.startsAt) <= asOf.getTime() && asOf.getTime() < t(r.expiresAt)) keep *= 1 - clamp01(r.reductionPct);
  }
  return 1 - keep;
}

// ─── Performance profile (internal only; never a public score) ───

export interface CapitalPerformanceProfile {
  capitalDeployedCents: number;
  capitalReturnedCents: number;
  /** (returned − deployed) / deployed over closed allocations; null with no history. */
  roi: number | null;
  /** Mean of 1 − |actual − expected| / expected over closed allocations with an expectation; null if none. */
  forecastAccuracy: number | null;
  failedAllocations: number;
  profitableAllocations: number;
  consecutiveFailures: number;
  /** 1 − coefficient of variation of monthly revenue over the last 6 months (0..1). */
  revenueConsistency: number;
  /** Net profit (90 d) per unit of capital deployed (90 d); null if nothing deployed. */
  capitalEfficiency: number | null;
  /** Share of capital deployed in the last 90 days that was lost. */
  recentLossRatio: number;
  /** Multiplier on the base discretionary allocation: strong → up to 2, weak → toward 0. */
  discretionaryMultiplier: number;
  rescuesLast180d: number;
}

function closed(a: CapitalAllocation): boolean {
  return a.status === "completed" || (a.status === "expired" && a.deployedCents > 0);
}

export function capitalPerformanceProfile(
  allocations: readonly CapitalAllocation[],
  ledger: readonly AgentLedgerEntry[],
  asOf: Date,
): CapitalPerformanceProfile {
  const done = allocations
    .filter(closed)
    .sort((a, b) => t(a.decidedAt ?? a.expiryDate) - t(b.decidedAt ?? b.expiryDate));
  const deployed = done.reduce((s, a) => s + a.deployedCents, 0);
  const returned = done.reduce((s, a) => s + (a.actualReturnCents ?? 0), 0);
  const failed = done.filter((a) => (a.actualReturnCents ?? 0) < a.deployedCents);
  const profitable = done.filter((a) => (a.actualReturnCents ?? 0) > a.deployedCents);
  let consecutive = 0;
  for (let i = done.length - 1; i >= 0 && (done[i].actualReturnCents ?? 0) < done[i].deployedCents; i--) consecutive++;
  const withForecast = done.filter((a) => a.expectedReturnCents > 0);
  const forecastAccuracy = withForecast.length
    ? withForecast.reduce((s, a) => s + clamp01(1 - Math.abs((a.actualReturnCents ?? 0) - a.expectedReturnCents) / a.expectedReturnCents), 0) /
      withForecast.length
    : null;

  // Revenue consistency over 6 monthly buckets.
  const months: number[] = [];
  for (let m = 0; m < 6; m++) {
    const to = asOf.getTime() - m * 30 * DAY_MS;
    months.push(summarizeLedger(ledger, { from: to - 30 * DAY_MS, to }).grossRevenueCents);
  }
  const mean = months.reduce((a, b) => a + b, 0) / months.length;
  const sd = Math.sqrt(months.reduce((s, x) => s + (x - mean) ** 2, 0) / months.length);
  const revenueConsistency = mean > 0 ? clamp01(1 - sd / mean) : 0;

  const from90 = asOf.getTime() - 90 * DAY_MS;
  const recent = done.filter((a) => t(a.decidedAt ?? a.expiryDate) >= from90);
  const recentDeployed = recent.reduce((s, a) => s + a.deployedCents, 0);
  const recentLost = recent.reduce((s, a) => s + Math.max(0, a.deployedCents - (a.actualReturnCents ?? 0)), 0);
  const recentLossRatio = recentDeployed > 0 ? clamp01(recentLost / recentDeployed) : 0;
  const deployed90 = summarizeLedger(ledger, { from: from90, to: asOf.getTime() });
  const capDeployed90 = ledger
    .filter((e) => e.kind === "allocation_deployed" && t(e.occurredAt) >= from90)
    .reduce((s, e) => s + e.amountCents, 0);

  const roi = deployed > 0 ? (returned - deployed) / deployed : null;
  const roiScore = roi === null ? 0 : clamp01(roi / SWEEP_TUNING.targetRoi);
  const multiplier = Math.min(
    2,
    Math.max(0, 1 + roiScore * (forecastAccuracy ?? 0.5) - 0.25 * consecutive - 0.5 * recentLossRatio),
  );
  return {
    capitalDeployedCents: deployed,
    capitalReturnedCents: returned,
    roi,
    forecastAccuracy,
    failedAllocations: failed.length,
    profitableAllocations: profitable.length,
    consecutiveFailures: consecutive,
    revenueConsistency,
    capitalEfficiency: capDeployed90 > 0 ? deployed90.netProfitCents / capDeployed90 : null,
    recentLossRatio,
    discretionaryMultiplier: Math.round(multiplier * 1000) / 1000,
    rescuesLast180d: allocations.filter(
      (a) => a.kind === "rescue" && a.status !== "proposed" && a.status !== "rejected" && t(a.decidedAt ?? a.startDate) >= asOf.getTime() - 180 * DAY_MS,
    ).length,
  };
}

// ─── Dynamic sweep rate ──────────────────────────────────────────

export function populationBaseRate(livingAgents: number, policy: TreasuryPolicy = DEFAULT_TREASURY_POLICY): number {
  if (livingAgents >= 50) return policy.matureFleetRate;
  for (const b of policy.populationRates) if (livingAgents <= b.maxAgents) return b.rate;
  return policy.populationRates[policy.populationRates.length - 1]?.rate ?? policy.matureFleetRate;
}

export interface SweepRateInput {
  livingAgents: number;
  agentAgeDays: number;
  excessCents: number;
  protectedCents: number;
  profile: Pick<CapitalPerformanceProfile, "roi" | "forecastAccuracy" | "recentLossRatio" | "revenueConsistency">;
  treasury: { balanceCents: number; reserveTargetCents: number };
  /** Combined active temporary reduction (0..1). */
  reduction: number;
}

export interface SweepRateBreakdown {
  base: number;
  maturity: number;
  surplusIntensity: number;
  surplusUplift: number;
  treasuryUplift: number;
  lossUplift: number;
  productiveDiscount: number;
  /** Rate before temporary reductions (base ≤ this ≤ maxSweepRate). */
  policyRate: number;
  reduction: number;
  /** Effective rate after reductions. */
  rate: number;
}

/**
 *   base      = population band rate (50 living → mature-fleet rate)
 *   maturity  = min(1, age / maturityAgeDays) × (0.5 + 0.5 × revenueConsistency)
 *   surplus   = clamp((excess / protected − 1) / (saturation − 1))
 *   uplift    = (max − base) × maturity × surplus                 highly capitalised mature agents
 *             + 0.05 × treasury reserve shortfall                  fleet needs reserves
 *             + 0.05 × recent loss ratio                           poor recent use of capital
 *             − 0.10 × roiScore × forecastAccuracy                 credible productive use keeps capital
 *   policy    = min(max, base + max(0, uplift))
 *   rate      = policy × (1 − active temporary reduction)
 */
export function computeSweepRate(input: SweepRateInput, policy: TreasuryPolicy = DEFAULT_TREASURY_POLICY): SweepRateBreakdown {
  const max = Math.min(policy.maxSweepRate, HARD_MAX_SWEEP_RATE);
  const base = Math.min(populationBaseRate(input.livingAgents, policy), max);
  const maturity = clamp01(input.agentAgeDays / policy.maturityAgeDays) * (0.5 + 0.5 * clamp01(input.profile.revenueConsistency));
  const surplusIntensity =
    input.protectedCents > 0
      ? clamp01((input.excessCents / input.protectedCents - 1) / (SWEEP_TUNING.surplusSaturation - 1))
      : input.excessCents > 0
        ? 1
        : 0;
  const surplusUplift = (max - base) * maturity * surplusIntensity;
  const shortfall = input.treasury.reserveTargetCents > 0 ? clamp01(1 - input.treasury.balanceCents / input.treasury.reserveTargetCents) : 0;
  const treasuryUplift = SWEEP_TUNING.treasuryNeedWeight * shortfall;
  const lossUplift = SWEEP_TUNING.lossWeight * clamp01(input.profile.recentLossRatio);
  const roiScore = input.profile.roi === null ? 0 : clamp01(input.profile.roi / SWEEP_TUNING.targetRoi);
  const productiveDiscount = SWEEP_TUNING.productiveDiscountWeight * roiScore * clamp01(input.profile.forecastAccuracy ?? 0);
  const policyRate = Math.min(max, base + Math.max(0, surplusUplift + treasuryUplift + lossUplift - productiveDiscount));
  const reduction = clamp01(input.reduction);
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  return {
    base: round(base),
    maturity: round(maturity),
    surplusIntensity: round(surplusIntensity),
    surplusUplift: round(surplusUplift),
    treasuryUplift: round(treasuryUplift),
    lossUplift: round(lossUplift),
    productiveDiscount: round(productiveDiscount),
    policyRate: round(policyRate),
    reduction: round(reduction),
    rate: round(policyRate * (1 - reduction)),
  };
}

// ─── Waterfall ───────────────────────────────────────────────────

export interface AgentEconomicsInput {
  agentId: string;
  cashCents: number;
  agentCreatedAt: string | Date;
  ledger: readonly AgentLedgerEntry[];
  obligations: readonly Obligation[];
  allocations: readonly CapitalAllocation[];
  reductions: readonly SweepReduction[];
  livingAgents: number;
  treasury: { balanceCents: number; reserveTargetCents: number };
  asOf?: Date;
  /** Burn lookback (default 30 days). */
  lookbackDays?: number;
}

export interface AgentWaterfall {
  agentId: string;
  asOf: string;
  CASH_ON_HAND: number;
  GROSS_REVENUE: number;
  DIRECT_COSTS: number;
  NET_PROFIT: number;
  OWNER_FUNDING: number;
  OPERATING_OBLIGATIONS: number;
  PROTECTED_RUNWAY: number;
  APPROVED_GROWTH_CAPITAL: number;
  CONTINGENCY_RESERVE: number;
  EXCESS_CAPITAL: number;
  UNDISTRIBUTED_PROFIT: number;
  SWEEP_BASE: number;
  FLEET_SWEEP: number;
  AGENT_RETAINED_CAPITAL: number;
  dailyBurnCents: number;
  runwayDays: number;
  rate: SweepRateBreakdown;
  profile: CapitalPerformanceProfile;
}

export function computeAgentWaterfall(input: AgentEconomicsInput, policy: TreasuryPolicy = DEFAULT_TREASURY_POLICY): AgentWaterfall {
  validatePolicy(policy);
  const asOf = input.asOf ?? new Date();
  const cash = Math.max(0, Math.floor(input.cashCents));
  const lookback = input.lookbackDays ?? 30;
  const burn = dailyBurnCents(input.ledger, asOf, lookback, input.agentCreatedAt);
  const all = summarizeLedger(input.ledger, { to: asOf.getTime() });
  const obligations = operatingObligationsCents(input.obligations);
  const runway = policy.runwayDays * burn;
  const growth = approvedGrowthCapitalCents(input.allocations, asOf);
  const contingency = Math.max(policy.minContingencyCents, Math.ceil(policy.contingencyPct * 30 * burn));
  const protectedTotal = obligations + runway + growth + contingency;
  const excess = Math.max(0, cash - protectedTotal);
  const profile = capitalPerformanceProfile(input.allocations, input.ledger, asOf);
  const rate = computeSweepRate(
    {
      livingAgents: input.livingAgents,
      agentAgeDays: (asOf.getTime() - t(input.agentCreatedAt)) / DAY_MS,
      excessCents: excess,
      protectedCents: protectedTotal,
      profile,
      treasury: input.treasury,
      reduction: activeReduction(input.reductions, asOf),
    },
    policy,
  );
  const sweepBase = Math.min(excess, all.undistributedProfitCents);
  const sweep = Math.floor(sweepBase * rate.rate);
  if (cash - sweep < Math.min(cash, protectedTotal)) {
    throw new Error("treasury invariant violated: sweep would reach protected capital");
  }
  return {
    agentId: input.agentId,
    asOf: asOf.toISOString(),
    CASH_ON_HAND: cash,
    GROSS_REVENUE: all.grossRevenueCents,
    DIRECT_COSTS: all.directCostsCents,
    NET_PROFIT: all.netProfitCents,
    OWNER_FUNDING: all.ownerFundingCents,
    OPERATING_OBLIGATIONS: obligations,
    PROTECTED_RUNWAY: runway,
    APPROVED_GROWTH_CAPITAL: growth,
    CONTINGENCY_RESERVE: contingency,
    EXCESS_CAPITAL: excess,
    UNDISTRIBUTED_PROFIT: all.undistributedProfitCents,
    SWEEP_BASE: sweepBase,
    FLEET_SWEEP: sweep,
    AGENT_RETAINED_CAPITAL: cash - sweep,
    dailyBurnCents: burn,
    runwayDays: burn > 0 ? Math.floor(cash / burn) : Infinity,
    rate,
    profile,
  };
}

// ─── Discretionary allocations and rescue ────────────────────────

/** Discretionary allocation limit: strong agents up to 2× the base, weak agents progressively toward 0. */
export function discretionaryLimitCents(baseCents: number, profile: CapitalPerformanceProfile): number {
  return Math.floor(baseCents * profile.discretionaryMultiplier);
}

export interface RescueRecommendation {
  recommended: boolean;
  /** Always true: rescue is discretionary and needs an operator decision. */
  requiresOperatorApproval: true;
  reasons: string[];
}

/** Emergency rescue is never automatic; this only advises the operator. */
export function evaluateRescue(profile: CapitalPerformanceProfile, waterfall: Pick<AgentWaterfall, "runwayDays">): RescueRecommendation {
  const reasons: string[] = [];
  if (profile.consecutiveFailures >= 3) reasons.push(`${profile.consecutiveFailures} consecutive failed allocations`);
  if (profile.rescuesLast180d >= 2) reasons.push(`${profile.rescuesLast180d} rescues in the last 180 days`);
  if (profile.roi !== null && profile.roi < -0.5) reasons.push(`historic ROI ${Math.round(profile.roi * 100)}%`);
  if (waterfall.runwayDays > 14) reasons.push("runway above 14 days: no emergency");
  return { recommended: reasons.length === 0, requiresOperatorApproval: true, reasons };
}

// ─── Fleet bank ──────────────────────────────────────────────────

export type TreasuryKind =
  | "sweep_in"
  | "owner_funding_in"
  | "allocation_return_in"
  | "infrastructure"
  | "inference"
  | "maintenance"
  | "emergency_rescue"
  | "replacement_agent"
  | "approved_growth"
  | "compliance"
  | "contingency"
  | "owner_distribution";

export const TREASURY_INFLOWS: ReadonlySet<TreasuryKind> = new Set(["sweep_in", "owner_funding_in", "allocation_return_in"]);
/** What fleet treasury funds may be used for (besides owner distributions of surplus). */
export const TREASURY_USES: ReadonlySet<TreasuryKind> = new Set([
  "infrastructure",
  "inference",
  "maintenance",
  "emergency_rescue",
  "replacement_agent",
  "approved_growth",
  "compliance",
  "contingency",
]);
const OPERATING_KINDS: ReadonlySet<TreasuryKind> = new Set(["infrastructure", "inference", "maintenance", "compliance"]);

export interface TreasuryEntry {
  kind: TreasuryKind;
  amountCents: number;
  status: "recorded" | "planned_not_executed";
  occurredAt: string | Date;
}

/** Balance from recorded (observed) movements only; plans do not count. */
export function treasuryBalanceCents(entries: readonly TreasuryEntry[]): number {
  return entries
    .filter((e) => e.status === "recorded")
    .reduce((s, e) => s + (TREASURY_INFLOWS.has(e.kind) ? e.amountCents : -e.amountCents), 0);
}

/** Monthly operating expense from the last `lookbackDays` of recorded operating spend (or an explicit override). */
export function monthlyOperatingExpenseCents(entries: readonly TreasuryEntry[], asOf: Date, lookbackDays = 90, overrideCents?: number): number {
  if (overrideCents !== undefined) return Math.max(0, overrideCents);
  const from = asOf.getTime() - lookbackDays * DAY_MS;
  const spent = entries
    .filter((e) => e.status === "recorded" && OPERATING_KINDS.has(e.kind) && t(e.occurredAt) >= from && t(e.occurredAt) <= asOf.getTime())
    .reduce((s, e) => s + e.amountCents, 0);
  return Math.ceil((spent * 30) / lookbackDays);
}

export function reserveTargetCents(monthlyExpenseCents: number, policy: TreasuryPolicy = DEFAULT_TREASURY_POLICY): number {
  return Math.ceil(monthlyExpenseCents * policy.reserveTargetMonths);
}

export interface OwnerDistributionPlan {
  requestedCents: number;
  approvedCents: number;
  treasuryBalanceCents: number;
  reserveTargetCents: number;
  obligationsCents: number;
  surplusCents: number;
  status: "rejected" | "planned_not_executed";
  reason: string;
}

/** Owner distributions come only from treasury surplus above the reserve target and treasury obligations. */
export function planOwnerDistribution(params: {
  requestedCents: number;
  balanceCents: number;
  reserveTargetCents: number;
  obligationsCents: number;
}): OwnerDistributionPlan {
  const surplus = Math.max(0, params.balanceCents - params.reserveTargetCents - params.obligationsCents);
  const approved = Math.min(Math.max(0, Math.floor(params.requestedCents)), surplus);
  const base = {
    requestedCents: params.requestedCents,
    treasuryBalanceCents: params.balanceCents,
    reserveTargetCents: params.reserveTargetCents,
    obligationsCents: params.obligationsCents,
    surplusCents: surplus,
  };
  if (approved <= 0) {
    return { ...base, approvedCents: 0, status: "rejected", reason: "treasury is at or below its reserve target plus obligations" };
  }
  return {
    ...base,
    approvedCents: approved,
    status: "planned_not_executed",
    reason: approved < params.requestedCents ? "partially approved: limited to surplus above reserve" : "within surplus above reserve",
  };
}
```

## `src/fleet/treasury/store.ts`

sha256 `3a32a8555d89dc9e959e1cfa17ffea03ddc96b7b6956ecc6a7cbcd1b91583441` · 27369 bytes · 543 lines

```ts
/**
 * Fleet treasury store (Phase 5) — FleetAdmin operations over the treasury
 * tables (schema v5). Connects with the ADMIN (owner) credential; neither
 * the service role nor agents hold any privilege on these tables. Agents
 * can only propose capital use and request spends through the fleet API
 * (api_propose_allocation / api_request_spend); every decision here requires
 * a named operator approver, and the database refuses any fleet agent id as
 * approver (fleet_require_operator_approver).
 *
 * Nothing here moves money. Sweeps, owner distributions and custody
 * transfers are recorded as plans ('planned_not_executed' /
 * 'blocked_payments_disabled').
 */

import pg from "pg";
import type { Pool, PoolClient } from "pg";
import { ulid } from "ulid";
import { quoteIdent } from "../postgres/migrations.js";
import { redactDetail } from "../redact.js";
import {
  DEFAULT_TREASURY_POLICY,
  TREASURY_USES,
  capitalPerformanceProfile,
  computeAgentWaterfall,
  discretionaryLimitCents,
  evaluateRescue,
  monthlyOperatingExpenseCents,
  planOwnerDistribution,
  reserveTargetCents,
  treasuryBalanceCents,
  validatePolicy,
  type AgentLedgerEntry,
  type AgentLedgerKind,
  type AgentWaterfall,
  type CapitalAllocation,
  type CapitalPerformanceProfile,
  type OwnerDistributionPlan,
  type TreasuryEntry,
  type TreasuryKind,
  type TreasuryPolicy,
} from "./engine.js";

export interface TreasuryPolicyRecord extends TreasuryPolicy {
  treasuryAddress: string | null;
  ownerWithdrawalAddress: string | null;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toAllocation(r: Record<string, any>): CapitalAllocation & { proposedBy: string; decidedBy: string | null; decisionReason: string | null } {
  return {
    allocationId: r.allocation_id,
    agentId: r.agent_id,
    kind: r.kind,
    purpose: r.purpose,
    requestedAmountCents: Number(r.requested_amount_cents),
    approvedAmountCents: r.approved_amount_cents === null ? null : Number(r.approved_amount_cents),
    deployedCents: Number(r.deployed_cents),
    startDate: iso(r.start_date),
    expiryDate: iso(r.expiry_date),
    expectedReturnCents: Number(r.expected_return_cents),
    expectedDurationDays: r.expected_duration_days,
    status: r.status,
    actualReturnCents: r.actual_return_cents === null ? null : Number(r.actual_return_cents),
    decidedAt: iso(r.decided_at),
    proposedBy: r.proposed_by,
    decidedBy: r.decided_by,
    decisionReason: r.decision_reason,
  };
}

export class PgTreasuryStore {
  readonly schema: string;
  private readonly pool: Pool;

  constructor(opts: { connectionString: string; schema?: string }) {
    this.schema = opts.schema ?? "fleet";
    quoteIdent(this.schema);
    this.pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: 3,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true,
      application_name: "automaton-fleet-treasury",
      options: `-c search_path=${this.schema} -c lock_timeout=5000 -c statement_timeout=15000`,
    });
    this.pool.on("error", () => {});
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  private async event(c: PoolClient, type: string, agentId: string | null, actor: string, detail: Record<string, unknown>): Promise<void> {
    await c.query("INSERT INTO fleet_events (event_type, agent_id, actor, detail) VALUES ($1, $2, $3, $4)", [
      type,
      agentId,
      actor,
      JSON.stringify(redactDetail(detail)),
    ]);
  }

  // ─── Policy ────────────────────────────────────────────────────

  async getPolicy(): Promise<TreasuryPolicyRecord> {
    const r = (await this.pool.query("SELECT * FROM fleet_treasury_policy WHERE id = 1")).rows[0];
    return {
      runwayDays: r.runway_days,
      contingencyPct: Number(r.contingency_pct),
      minContingencyCents: Number(r.min_contingency_cents),
      populationRates: r.population_rates,
      matureFleetRate: Number(r.mature_fleet_rate),
      maxSweepRate: Number(r.max_sweep_rate),
      reserveTargetMonths: Number(r.reserve_target_months),
      maturityAgeDays: r.maturity_age_days,
      treasuryAddress: r.treasury_address,
      ownerWithdrawalAddress: r.owner_withdrawal_address,
    };
  }

  async setPolicy(patch: Partial<TreasuryPolicyRecord>, actor: string): Promise<TreasuryPolicyRecord> {
    const cur = await this.getPolicy();
    const next = { ...cur, ...patch };
    validatePolicy(next);
    await this.tx(async (c) => {
      await c.query(
        `UPDATE fleet_treasury_policy SET runway_days = $1, contingency_pct = $2, min_contingency_cents = $3, population_rates = $4,
                mature_fleet_rate = $5, max_sweep_rate = $6, reserve_target_months = $7, maturity_age_days = $8,
                treasury_address = $9, owner_withdrawal_address = $10, updated_at = now(), updated_by = $11 WHERE id = 1`,
        [
          next.runwayDays, next.contingencyPct, next.minContingencyCents, JSON.stringify(next.populationRates),
          next.matureFleetRate, next.maxSweepRate, next.reserveTargetMonths, next.maturityAgeDays,
          next.treasuryAddress, next.ownerWithdrawalAddress, actor,
        ],
      );
      await this.event(c, "treasury_policy_set", null, actor, { ...next });
    });
    return next;
  }

  // ─── Ledgers and obligations ───────────────────────────────────

  async recordAgentLedger(
    e: { agentId: string; kind: AgentLedgerKind; amountCents: number; occurredAt?: Date; allocationId?: string; reference?: string; source?: "controller" | "operator" | "agent_reported" },
    actor: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO fleet_agent_ledger (agent_id, kind, amount_cents, occurred_at, allocation_id, reference, source, recorded_by)
       VALUES ($1, $2, $3, COALESCE($4, now()), $5, $6, $7, $8)`,
      [e.agentId, e.kind, e.amountCents, e.occurredAt ?? null, e.allocationId ?? null, e.reference ?? null, e.source ?? "operator", actor],
    );
  }

  async recordBalance(agentId: string, cashCents: number, source: "controller" | "operator" | "agent_reported" = "operator", observedAt?: Date): Promise<void> {
    await this.pool.query(
      "INSERT INTO fleet_balance_observations (agent_id, cash_cents, source, observed_at) VALUES ($1, $2, $3, COALESCE($4, now()))",
      [agentId, cashCents, source, observedAt ?? null],
    );
  }

  async addObligation(o: { agentId: string; description: string; amountCents: number; dueAt: Date }, approvedBy: string): Promise<string> {
    const id = ulid();
    await this.tx(async (c) => {
      await c.query("SELECT fleet_require_operator_approver($1, $2)", [approvedBy, o.agentId]);
      await c.query(
        "INSERT INTO fleet_obligations (obligation_id, agent_id, description, amount_cents, due_at, approved_by) VALUES ($1, $2, $3, $4, $5, $6)",
        [id, o.agentId, o.description, o.amountCents, o.dueAt, approvedBy],
      );
      await this.event(c, "obligation_approved", o.agentId, approvedBy, { obligationId: id, amountCents: o.amountCents });
    });
    return id;
  }

  // ─── Capital allocations ───────────────────────────────────────

  async listAllocations(agentId?: string): Promise<ReturnType<typeof toAllocation>[]> {
    const r = agentId
      ? await this.pool.query("SELECT * FROM fleet_capital_allocations WHERE agent_id = $1 ORDER BY created_at", [agentId])
      : await this.pool.query("SELECT * FROM fleet_capital_allocations ORDER BY created_at");
    return r.rows.map(toAllocation);
  }

  /** Operator-side proposal (e.g. an operator-initiated rescue). Agents propose via the fleet API. */
  async proposeAllocation(
    p: { agentId: string; purpose: string; requestedCents: number; expectedReturnCents: number; expectedDurationDays: number; kind?: "growth" | "rescue" },
    proposedBy: string,
  ): Promise<string> {
    const id = ulid();
    await this.pool.query(
      `INSERT INTO fleet_capital_allocations (allocation_id, agent_id, kind, purpose, requested_amount_cents, expected_return_cents,
                                              expected_duration_days, proposed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, p.agentId, p.kind ?? "growth", p.purpose, p.requestedCents, p.expectedReturnCents, p.expectedDurationDays, proposedBy],
    );
    return id;
  }

  /**
   * Approve a proposed allocation. Approved amounts above the agent's
   * discretionary limit (performance-scaled) need an explicit override.
   */
  async approveAllocation(
    allocationId: string,
    d: { approvedCents: number; startDate?: Date; expiryDate?: Date; reason: string; override?: boolean; baseDiscretionaryCents?: number },
    approver: string,
  ): Promise<void> {
    await this.tx(async (c) => {
      const cur = (await c.query("SELECT * FROM fleet_capital_allocations WHERE allocation_id = $1 FOR UPDATE", [allocationId])).rows[0];
      if (!cur) throw new Error(`unknown allocation ${allocationId}`);
      const a = toAllocation(cur);
      if (d.baseDiscretionaryCents !== undefined && !d.override) {
        const profile = await this.profileTx(c, a.agentId);
        const limit = discretionaryLimitCents(d.baseDiscretionaryCents, profile);
        if (d.approvedCents > limit) {
          throw new Error(`approval ${d.approvedCents} exceeds the agent's discretionary limit ${limit}; pass override to approve anyway`);
        }
      }
      const start = d.startDate ?? new Date();
      const expiry = d.expiryDate ?? new Date(start.getTime() + a.expectedDurationDays * 86_400_000);
      await c.query(
        `UPDATE fleet_capital_allocations SET status = 'approved', approved_amount_cents = $2, start_date = $3, expiry_date = $4,
                decided_by = $5, decided_at = now(), decision_reason = $6 WHERE allocation_id = $1`,
        [allocationId, d.approvedCents, start, expiry, approver, d.reason],
      );
      await this.event(c, "capital_approved", a.agentId, approver, { allocationId, approvedCents: d.approvedCents, override: !!d.override });
    });
  }

  async rejectAllocation(allocationId: string, reason: string, approver: string): Promise<void> {
    await this.tx(async (c) => {
      const r = await c.query(
        `UPDATE fleet_capital_allocations SET status = 'rejected', decided_by = $2, decided_at = now(), decision_reason = $3
          WHERE allocation_id = $1 RETURNING agent_id`,
        [allocationId, approver, reason],
      );
      await this.event(c, "capital_rejected", r.rows[0]?.agent_id ?? null, approver, { allocationId, reason });
    });
  }

  /** Change terms of an approved allocation (amount/expiry). */
  async changeAllocation(allocationId: string, change: { approvedCents?: number; expiryDate?: Date; reason: string }, approver: string): Promise<void> {
    await this.tx(async (c) => {
      const r = await c.query(
        `UPDATE fleet_capital_allocations SET approved_amount_cents = COALESCE($2, approved_amount_cents),
                expiry_date = COALESCE($3, expiry_date), decided_by = $4, decided_at = now(), decision_reason = $5
          WHERE allocation_id = $1 AND status = 'approved' RETURNING agent_id`,
        [allocationId, change.approvedCents ?? null, change.expiryDate ?? null, approver, change.reason],
      );
      if (!r.rowCount) throw new Error(`allocation ${allocationId} is not approved`);
      await this.event(c, "capital_changed", r.rows[0].agent_id, approver, { allocationId, ...change });
    });
  }

  /** Record deployment of approved capital (reduces the protected unspent amount). */
  async recordDeployment(allocationId: string, amountCents: number, actor: string): Promise<void> {
    await this.tx(async (c) => {
      const r = await c.query(
        `UPDATE fleet_capital_allocations SET deployed_cents = deployed_cents + $2
          WHERE allocation_id = $1 AND status = 'approved' AND deployed_cents + $2 <= approved_amount_cents RETURNING agent_id`,
        [allocationId, amountCents],
      );
      if (!r.rowCount) throw new Error(`deployment refused for ${allocationId} (not approved or exceeds approved amount)`);
      await c.query(
        "INSERT INTO fleet_agent_ledger (agent_id, kind, amount_cents, allocation_id, source, recorded_by) VALUES ($1, 'allocation_deployed', $2, $3, 'operator', $4)",
        [r.rows[0].agent_id, amountCents, allocationId, actor],
      );
    });
  }

  /** Close an allocation with its actual return (feeds the capital-performance profile). */
  async completeAllocation(allocationId: string, actualReturnCents: number, approver: string): Promise<void> {
    await this.tx(async (c) => {
      const r = await c.query(
        `UPDATE fleet_capital_allocations SET status = 'completed', actual_return_cents = $2, decided_by = $3, decided_at = now()
          WHERE allocation_id = $1 AND status = 'approved' RETURNING agent_id`,
        [allocationId, actualReturnCents, approver],
      );
      if (!r.rowCount) throw new Error(`allocation ${allocationId} is not approved`);
      if (actualReturnCents > 0) {
        await c.query(
          "INSERT INTO fleet_agent_ledger (agent_id, kind, amount_cents, allocation_id, source, recorded_by) VALUES ($1, 'allocation_returned', $2, $3, 'operator', $4)",
          [r.rows[0].agent_id, actualReturnCents, allocationId, approver],
        );
      }
      await this.event(c, "capital_completed", r.rows[0].agent_id, approver, { allocationId, actualReturnCents });
    });
  }

  /** Approved allocations past expiry become expired (they stop protecting capital even before this runs). */
  async expireAllocations(actor: string): Promise<number> {
    return this.tx(async (c) => {
      const r = await c.query(
        `UPDATE fleet_capital_allocations SET status = 'expired', decided_by = $1, decided_at = now(), decision_reason = 'expired'
          WHERE status = 'approved' AND expiry_date <= now() RETURNING allocation_id`,
        [actor],
      );
      return r.rowCount ?? 0;
    });
  }

  // ─── Sweep reductions, freezes, quarantine support ─────────────

  async reduceSweep(
    r: { agentId: string; reductionPct: number; reason: string; expiresAt: Date; allocationId?: string },
    approver: string,
  ): Promise<string> {
    const id = ulid();
    await this.tx(async (c) => {
      await c.query(
        `INSERT INTO fleet_sweep_reductions (reduction_id, agent_id, allocation_id, reduction_pct, reason, expires_at, approved_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, r.agentId, r.allocationId ?? null, r.reductionPct, r.reason, r.expiresAt, approver],
      );
      await this.event(c, "sweep_reduced", r.agentId, approver, { reductionId: id, reductionPct: r.reductionPct, expiresAt: r.expiresAt });
    });
    return id;
  }

  async freezeSpending(agentId: string, frozen: boolean, reason: string, actor: string): Promise<void> {
    await this.tx(async (c) => {
      const a = (await c.query("SELECT status FROM fleet_agents WHERE agent_id = $1", [agentId])).rows[0];
      if (!frozen && a && !["active", "unresponsive"].includes(a.status)) {
        throw new Error(`cannot unfreeze a ${a.status} agent`);
      }
      const r = await c.query(
        `UPDATE fleet_wallet_custody SET spending_frozen = $2, frozen_reason = CASE WHEN $2 THEN $3 END,
                frozen_at = CASE WHEN $2 THEN now() END, updated_at = now() WHERE agent_id = $1`,
        [agentId, frozen, reason],
      );
      if (!r.rowCount) throw new Error(`no custody record for ${agentId}`);
      await this.event(c, frozen ? "spending_frozen" : "spending_unfrozen", agentId, actor, { reason });
    });
  }

  async setDailySpendLimit(agentId: string, cents: number, actor: string): Promise<void> {
    await this.tx(async (c) => {
      await c.query("UPDATE fleet_wallet_custody SET daily_limit_cents = $2, updated_at = now() WHERE agent_id = $1", [agentId, cents]);
      await this.event(c, "spend_limit_set", agentId, actor, { dailyLimitCents: cents });
    });
  }

  /** Custody transfer according to policy. Recorded only: payments are disabled. */
  async planCustodyTransfer(
    t: { fromAgentId: string; destination: "fleet_treasury" | "agent"; toAgentId?: string; amountCents: number; policy: "quarantine_recovery" | "death_recovery" | "rebalance" | "sweep"; reason: string },
    approver: string,
  ): Promise<string> {
    const id = ulid();
    await this.tx(async (c) => {
      if (t.policy === "rebalance") {
        const s = (await c.query("SELECT status FROM fleet_agents WHERE agent_id = $1", [t.fromAgentId])).rows[0]?.status;
        if (s !== "active") throw new Error("rebalance transfers require an active source agent");
      }
      await c.query(
        `INSERT INTO fleet_custody_transfers (transfer_id, from_agent_id, destination, to_agent_id, amount_cents, policy, reason, approved_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, t.fromAgentId, t.destination, t.toAgentId ?? null, t.amountCents, t.policy, t.reason, approver],
      );
      await this.event(c, "custody_transfer_planned", t.fromAgentId, approver, { transferId: id, ...t, executed: false });
    });
    return id;
  }

  // ─── Treasury (fleet bank) ─────────────────────────────────────

  async recordTreasury(
    e: { kind: TreasuryKind; amountCents: number; agentId?: string; allocationId?: string; reference?: string; occurredAt?: Date },
    actor: string,
  ): Promise<void> {
    if (!TREASURY_USES.has(e.kind) && !["sweep_in", "owner_funding_in", "allocation_return_in"].includes(e.kind)) {
      throw new Error(`${e.kind} is not a permitted recorded treasury movement (owner distributions are planned via planOwnerDistribution)`);
    }
    await this.pool.query(
      `INSERT INTO fleet_treasury_ledger (kind, amount_cents, status, agent_id, allocation_id, reference, recorded_by, occurred_at)
       VALUES ($1, $2, 'recorded', $3, $4, $5, $6, COALESCE($7, now()))`,
      [e.kind, e.amountCents, e.agentId ?? null, e.allocationId ?? null, e.reference ?? null, actor, e.occurredAt ?? null],
    );
  }

  async addTreasuryObligation(o: { category: string; description: string; amountCents: number; dueAt: Date }, approver: string): Promise<string> {
    const id = ulid();
    await this.pool.query(
      "INSERT INTO fleet_treasury_obligations (obligation_id, category, description, amount_cents, due_at, approved_by) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, o.category, o.description, o.amountCents, o.dueAt, approver],
    );
    return id;
  }

  async treasuryPosition(opts: { asOf?: Date; monthlyExpenseOverrideCents?: number } = {}): Promise<{
    balanceCents: number;
    monthlyExpenseCents: number;
    reserveTargetCents: number;
    obligationsCents: number;
    surplusCents: number;
  }> {
    const asOf = opts.asOf ?? new Date();
    const policy = await this.getPolicy();
    const entries: TreasuryEntry[] = (
      await this.pool.query("SELECT kind, amount_cents, status, occurred_at FROM fleet_treasury_ledger")
    ).rows.map((r) => ({ kind: r.kind, amountCents: Number(r.amount_cents), status: r.status, occurredAt: r.occurred_at }));
    const balance = treasuryBalanceCents(entries);
    const monthly = monthlyOperatingExpenseCents(entries, asOf, 90, opts.monthlyExpenseOverrideCents);
    const target = reserveTargetCents(monthly, policy);
    const obligations = Number(
      (await this.pool.query("SELECT COALESCE(sum(amount_cents), 0) AS s FROM fleet_treasury_obligations WHERE status = 'approved'")).rows[0].s,
    );
    return { balanceCents: balance, monthlyExpenseCents: monthly, reserveTargetCents: target, obligationsCents: obligations, surplusCents: Math.max(0, balance - target - obligations) };
  }

  /** Owner distribution: only surplus above reserve + obligations; recorded as a plan (never executed here). */
  async planOwnerDistribution(requestedCents: number, approver: string, opts: { monthlyExpenseOverrideCents?: number } = {}): Promise<OwnerDistributionPlan & { distributionId: string }> {
    const policy = await this.getPolicy();
    if (!policy.ownerWithdrawalAddress) throw new Error("owner withdrawal address is not configured");
    if (policy.treasuryAddress && policy.treasuryAddress.toLowerCase() === policy.ownerWithdrawalAddress.toLowerCase()) {
      throw new Error("the fleet treasury must not be the owner's withdrawal destination");
    }
    const pos = await this.treasuryPosition(opts);
    const plan = planOwnerDistribution({
      requestedCents,
      balanceCents: pos.balanceCents,
      reserveTargetCents: pos.reserveTargetCents,
      obligationsCents: pos.obligationsCents,
    });
    const id = ulid();
    await this.tx(async (c) => {
      await c.query("SELECT fleet_require_operator_approver($1, NULL)", [approver]);
      await c.query(
        `INSERT INTO fleet_owner_distributions (distribution_id, requested_cents, approved_cents, treasury_balance_cents, reserve_target_cents,
                                                obligations_cents, destination, status, reason, decided_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, requestedCents, plan.approvedCents, plan.treasuryBalanceCents, plan.reserveTargetCents, plan.obligationsCents,
         policy.ownerWithdrawalAddress, plan.status, plan.reason, approver],
      );
      if (plan.status === "planned_not_executed") {
        await c.query(
          `INSERT INTO fleet_treasury_ledger (kind, amount_cents, status, reference, recorded_by) VALUES ('owner_distribution', $1, 'planned_not_executed', $2, $3)`,
          [plan.approvedCents, `distribution ${id}`, approver],
        );
      }
      await this.event(c, plan.status === "rejected" ? "owner_distribution_rejected" : "owner_distribution_planned", null, approver, {
        distributionId: id,
        ...plan,
        executed: false,
      });
    });
    return { ...plan, distributionId: id };
  }

  // ─── Agent economics ───────────────────────────────────────────

  private async profileTx(c: PoolClient | Pool, agentId: string): Promise<CapitalPerformanceProfile> {
    const allocations = (await c.query("SELECT * FROM fleet_capital_allocations WHERE agent_id = $1", [agentId])).rows.map(toAllocation);
    const ledger = await this.ledgerOf(c, agentId);
    return capitalPerformanceProfile(allocations, ledger, new Date());
  }

  private async ledgerOf(c: PoolClient | Pool, agentId: string): Promise<AgentLedgerEntry[]> {
    return (
      await c.query("SELECT kind, amount_cents, occurred_at, allocation_id FROM fleet_agent_ledger WHERE agent_id = $1 ORDER BY occurred_at", [agentId])
    ).rows.map((r) => ({ kind: r.kind, amountCents: Number(r.amount_cents), occurredAt: r.occurred_at, allocationId: r.allocation_id }));
  }

  /** Internal capital-performance profile (FleetAdmin only; not exposed to agents). */
  async performanceProfile(agentId: string): Promise<CapitalPerformanceProfile> {
    return this.profileTx(this.pool, agentId);
  }

  /** Full waterfall for an agent from registry data. Uses the latest observed balance unless cash is given. */
  async agentWaterfall(agentId: string, opts: { cashCents?: number; asOf?: Date; monthlyExpenseOverrideCents?: number } = {}): Promise<AgentWaterfall> {
    const asOf = opts.asOf ?? new Date();
    const agent = (await this.pool.query("SELECT created_at, status FROM fleet_agents WHERE agent_id = $1", [agentId])).rows[0];
    if (!agent) throw new Error(`unknown agent ${agentId}`);
    let cash = opts.cashCents;
    if (cash === undefined) {
      const b = (await this.pool.query("SELECT cash_cents FROM fleet_balance_observations WHERE agent_id = $1 ORDER BY observed_at DESC LIMIT 1", [agentId])).rows[0];
      if (!b) throw new Error(`no observed balance for ${agentId}`);
      cash = Number(b.cash_cents);
    }
    const [policy, pos, living, ledger, obligations, allocations, reductions] = await Promise.all([
      this.getPolicy(),
      this.treasuryPosition({ asOf, monthlyExpenseOverrideCents: opts.monthlyExpenseOverrideCents }),
      this.pool.query("SELECT living_agents FROM fleet_state WHERE id = 1").then((r) => r.rows[0].living_agents as number),
      this.ledgerOf(this.pool, agentId),
      this.pool.query("SELECT amount_cents, due_at, status FROM fleet_obligations WHERE agent_id = $1", [agentId]),
      this.pool.query("SELECT * FROM fleet_capital_allocations WHERE agent_id = $1", [agentId]),
      this.pool.query("SELECT reduction_pct, starts_at, expires_at, revoked_at FROM fleet_sweep_reductions WHERE agent_id = $1", [agentId]),
    ]);
    return computeAgentWaterfall(
      {
        agentId,
        cashCents: cash,
        agentCreatedAt: agent.created_at,
        ledger,
        obligations: obligations.rows.map((o) => ({ amountCents: Number(o.amount_cents), dueAt: o.due_at, status: o.status })),
        allocations: allocations.rows.map(toAllocation),
        reductions: reductions.rows.map((r) => ({ reductionPct: Number(r.reduction_pct), startsAt: r.starts_at, expiresAt: r.expires_at, revokedAt: r.revoked_at })),
        livingAgents: living,
        treasury: { balanceCents: pos.balanceCents, reserveTargetCents: pos.reserveTargetCents },
        asOf,
      },
      policy,
    );
  }

  /** Compute and record a sweep plan (never executed: payments are disabled). */
  async planSweep(agentId: string, actor: string, opts: { cashCents?: number } = {}): Promise<AgentWaterfall & { planId: string }> {
    const status = (await this.pool.query("SELECT status FROM fleet_agents WHERE agent_id = $1", [agentId])).rows[0]?.status;
    if (status !== "active") throw new Error(`sweeps are planned only for active agents (${agentId} is ${status})`);
    const w = await this.agentWaterfall(agentId, opts);
    const id = ulid();
    await this.tx(async (c) => {
      await c.query(
        "INSERT INTO fleet_sweep_plans (plan_id, agent_id, rate, amount_cents, waterfall, computed_by) VALUES ($1, $2, $3, $4, $5, $6)",
        [id, agentId, w.rate.rate, w.FLEET_SWEEP, JSON.stringify(w), actor],
      );
      await this.event(c, "sweep_planned", agentId, actor, { planId: id, rate: w.rate.rate, amountCents: w.FLEET_SWEEP, executed: false });
    });
    return { ...w, planId: id };
  }

  /** Discretionary rescue advice (never automatic). */
  async rescueAdvice(agentId: string, cashCents?: number) {
    const w = await this.agentWaterfall(agentId, { cashCents });
    return evaluateRescue(w.profile, w);
  }
}

export { DEFAULT_TREASURY_POLICY };
```
