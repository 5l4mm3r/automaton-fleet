/**
 * Agent financial health — ONE definition for the Formal dashboard and the Virtual Command Centre (portraits, labels,
 * colours). Pure functions over authoritative values read from FleetController; nothing here is a balance of its own.
 *
 * WALLET HEALTH (percent)
 *   100 % = the Genesis allocation: the starting capital FleetController gives every agent at birth
 *           (fleet_genesis_policy.bootstrap_capital_minor, read through `settings`.genesisCapital). It is the Fleet's own
 *           "operating baseline" for one agent, so 100 % means "the agent still holds what it was started with".
 *   health  = floor(agent cash ÷ Genesis allocation × 100)     (agent cash = the `agents` read's cashMinor)
 *   With no Genesis allocation readable the band is UNKNOWN — never guessed.
 *
 * BANDS (thresholds are central: HEALTH_THRESHOLDS)
 *   HEALTHY ≥ 80 %   ·   WOUNDED 40–79 %   ·   CRITICAL < 40 %   ·   DEAD = status dead/failed (FleetController's verdict)
 *   A living agent at £0 is CRITICAL (0 %), not DEAD: only FleetController declares death.
 *   Authoritative risk caps (fleet_agent_risk_context, the `risk` read) can only make a band WORSE, never better:
 *     · cash below the commitments due in the next 30 days                  → at most CRITICAL
 *     · a vulnerable business below its red-zone cushion (redZoneMet false) → at most WOUNDED
 *
 * WINNING ("shades") — a HEALTHY agent that is genuinely making money now, on four authoritative facts:
 *     1. realised lifetime net profit > 0          (wallet.lifetime.netProfitMinor)
 *     2. last-30-day net > 0                       (wallet.last30d: revenue − refunds − inference − operating costs)
 *     3. its red-zone cushion is met               (risk.redZoneMet is not false)
 *     4. the band before this rule is HEALTHY      (so no distressed agent wears shades for an old profit)
 *
 * PRIORITY  DEAD > CRITICAL > WOUNDED > WINNING > HEALTHY  (UNKNOWN only when the baseline or the cash is unreadable)
 */

export const HEALTH_THRESHOLDS = Object.freeze({ healthyPct: 80, woundedPct: 40 });

export type HealthBand = "DEAD" | "CRITICAL" | "WOUNDED" | "WINNING" | "HEALTHY" | "UNKNOWN";

/** Plain-language state shown next to every portrait (portraits never carry meaning by colour or image alone). */
export const BAND_LABEL: Readonly<Record<HealthBand, string>> = Object.freeze({
  DEAD: "DEAD", CRITICAL: "CRITICAL", WOUNDED: "STRESSED", WINNING: "PROFITABLE", HEALTHY: "HEALTHY", UNKNOWN: "HEALTH UNAVAILABLE",
});

/** Restrained semantic accents (text classes) for the bands; always paired with BAND_LABEL text. */
export const BAND_TEXT: Readonly<Record<HealthBand, string>> = Object.freeze({
  DEAD: "text-slate-500", CRITICAL: "text-red-300", WOUNDED: "text-amber-300", WINNING: "text-emerald-300", HEALTHY: "text-cyan-300", UNKNOWN: "text-slate-400",
});

/** Authoritative economic facts for one agent (minor units). Missing facts are null, never zero-filled. */
export interface AgentEconomics {
  agentId: string;
  /** Lifetime realised revenue, expenses (incl. fees) and net profit (wallet.lifetime). */
  revenueMinor: number | null;
  expensesMinor: number | null;
  netProfitMinor: number | null;
  /** Last 30 days: revenue − refunds − inference − operating costs (wallet.last30d). */
  recentNetMinor: number | null;
  retainedMinor: number | null;
  treasuryContributionsMinor: number | null;
  runwayDays: number | null;
  burnPerDayMinor: number | null;
  /** Risk context (`risk` read); null when not read. */
  commitmentsDue30dMinor: number | null;
  redZoneMet: boolean | null;
  vulnerable: boolean | null;
}

export interface AgentHealth {
  band: HealthBand;
  /** floor(cash ÷ Genesis allocation × 100); null when the baseline is unreadable or the agent is dead. */
  pct: number | null;
  label: string;
  /** Why the band is what it is, in order (shown in panels and tooltips). */
  reasons: string[];
}

const RANK: Record<HealthBand, number> = { DEAD: 0, CRITICAL: 1, WOUNDED: 2, WINNING: 3, HEALTHY: 4, UNKNOWN: 5 };
const worse = (a: HealthBand, b: HealthBand): HealthBand => (RANK[a] <= RANK[b] ? a : b);

export function healthOf(agent: { status: string; cash: number | null }, econ: AgentEconomics | null | undefined, baselineMinor: number | null | undefined): AgentHealth {
  const done = (band: HealthBand, pct: number | null, reasons: string[]): AgentHealth => ({ band, pct, label: BAND_LABEL[band], reasons });
  if (agent.status === "dead" || agent.status === "failed") return done("DEAD", null, ["FleetController records this agent as dead."]);
  if (agent.cash === null || !Number.isFinite(agent.cash)) return done("UNKNOWN", null, ["The agent's cash is not available from the Fleet gateway."]);
  if (!baselineMinor || baselineMinor <= 0) return done("UNKNOWN", null, ["The Genesis allocation (100 % wallet health) is not available from the Fleet gateway."]);

  const pct = Math.max(0, Math.floor((agent.cash * 100) / baselineMinor));
  const reasons = [`Wallet health ${pct} % of the Genesis allocation.`];
  let band: HealthBand = pct >= HEALTH_THRESHOLDS.healthyPct ? "HEALTHY" : pct >= HEALTH_THRESHOLDS.woundedPct ? "WOUNDED" : "CRITICAL";
  if (agent.cash <= 0) reasons.push("No cash left.");

  if (econ?.commitmentsDue30dMinor != null && agent.cash < econ.commitmentsDue30dMinor) {
    band = worse(band, "CRITICAL");
    reasons.push("Cash is below the commitments due in the next 30 days.");
  }
  if (econ?.vulnerable === true && econ.redZoneMet === false) {
    band = worse(band, "WOUNDED");
    reasons.push("A vulnerable business below its red-zone cushion.");
  }

  if (band === "HEALTHY" && econ && (econ.netProfitMinor ?? 0) > 0 && (econ.recentNetMinor ?? 0) > 0 && econ.redZoneMet !== false) {
    band = "WINNING";
    reasons.push("Realised net profit, profitable over the last 30 days, red-zone cushion met.");
  }
  return done(band, pct, reasons);
}

const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const sum = (...xs: Array<number | null>) => (xs.some((x) => x === null) ? null : xs.reduce<number>((a, x) => a + (x as number), 0));

/**
 * Economics from the gateway's own JSON: `wallet` = fleet_agent_wallet (from `hub` agents or `wallet`), `risk` =
 * fleet_agent_risk_context. Only reshaping and the documented 30-day net sum; absent fields stay null.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- gateway JSON, narrowed field by field
export function economicsFrom(agentId: string, wallet: Record<string, any> | null | undefined, risk: Record<string, any> | null | undefined): AgentEconomics {
  const life = wallet?.lifetime ?? {}, last = wallet?.last30d ?? {};
  const recent = wallet?.last30d ? sum(n(last.revenueMinor), last.refundsMinor == null ? 0 : -(n(last.refundsMinor) ?? 0),
    last.inferenceMinor == null ? 0 : -(n(last.inferenceMinor) ?? 0), last.operatingCostsMinor == null ? 0 : -(n(last.operatingCostsMinor) ?? 0)) : null;
  return {
    agentId,
    revenueMinor: n(life.revenueMinor), expensesMinor: life.expensesMinor == null ? null : (n(life.expensesMinor) ?? 0) + (n(life.feesMinor) ?? 0),
    netProfitMinor: n(life.netProfitMinor), recentNetMinor: recent,
    retainedMinor: n(wallet?.retainedEarningsMinor), treasuryContributionsMinor: n(wallet?.treasuryContributionsMinor),
    runwayDays: n(wallet?.runway?.days), burnPerDayMinor: n(wallet?.runway?.burnPerDayMinor),
    commitmentsDue30dMinor: risk ? n(risk.commitmentsDue30dMinor) : null,
    redZoneMet: risk && typeof risk.redZoneMet === "boolean" ? risk.redZoneMet : null,
    vulnerable: risk && typeof risk.vulnerable === "boolean" ? risk.vulnerable : null,
  };
}
