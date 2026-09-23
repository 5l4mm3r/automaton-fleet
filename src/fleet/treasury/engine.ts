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
