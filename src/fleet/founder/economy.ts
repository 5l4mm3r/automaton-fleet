/**
 * F2 (schema v28+): the founder's compact economic brief for a full task packet.
 *
 * One line of figures from FleetController's `brief` operation — available capital, restricted tax reserve and envelope
 * capital, burn, recent revenue, active ventures, the founder's own shortlist and pending outcomes — so the founder
 * starts each working turn from its real position without a state dump. Everything else is one tool call away
 * (wallet, venture status, opportunity list). Information only: never a permission, a limit, a budget or a score.
 */

export interface EconomyBrief {
  availableMinor: number;
  taxReserveMinor: number;
  envelopeCapitalMinor: number;
  burnPerDayMinor: number;
  revenue30dMinor: number;
  ventures: Array<{ key: string; state: string; netMinor: number }>;
  shortlist: string[];
  pendingOutcomes: number;
  activeEnvelopes: number;
}

const int = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) ? v : typeof v === "string" && /^-?\d{1,15}$/.test(v) ? Number(v) : 0);
const slug = (v: unknown): string | null => (typeof v === "string" && /^[a-z0-9][a-z0-9._-]{0,47}$/.test(v) ? v : null);

/** A malformed brief is dropped (null), never half-trusted. */
export function parseBrief(v: unknown): EconomyBrief | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const b = v as Record<string, unknown>;
  const ventures = Array.isArray(b.ventures)
    ? (b.ventures as unknown[]).flatMap((x) => {
        const r = x as Record<string, unknown>;
        const key = slug(r?.key);
        return key && typeof r.state === "string" && /^[a-z]{3,12}$/.test(r.state) ? [{ key, state: r.state, netMinor: int(r.netMinor) }] : [];
      }).slice(0, 6)
    : [];
  const shortlist = Array.isArray(b.shortlist) ? (b.shortlist as unknown[]).map(slug).filter((x): x is string => !!x).slice(0, 20) : [];
  return {
    availableMinor: int(b.availableMinor), taxReserveMinor: int(b.taxReserveMinor), envelopeCapitalMinor: int(b.envelopeCapitalMinor),
    burnPerDayMinor: int(b.burnPerDayMinor), revenue30dMinor: int(b.revenue30dMinor), ventures, shortlist, pendingOutcomes: int(b.pendingOutcomes),
    activeEnvelopes: int(b.activeEnvelopes),
  };
}

const gbp = (minor: number) => `£${(minor / 100).toFixed(2)}`;

/** One compact line (bounded) for a full packet. */
export function economyLine(b: EconomyBrief): string {
  const parts = [
    `available ${gbp(b.availableMinor)}`,
    ...(b.taxReserveMinor > 0 ? [`tax reserve ${gbp(b.taxReserveMinor)} (restricted)`] : []),
    ...(b.envelopeCapitalMinor > 0 ? [`Fleet envelope capital ${gbp(b.envelopeCapitalMinor)} in ${b.activeEnvelopes} envelope(s)`] : []),
    ...(b.burnPerDayMinor > 0 ? [`burn ≈ ${gbp(b.burnPerDayMinor)}/day`] : []),
    `revenue 30d ${gbp(b.revenue30dMinor)}`,
  ];
  const ventures = b.ventures.length ? `ventures: ${b.ventures.map((v) => `${v.key} (${v.state}, net ${gbp(v.netMinor)})`).join("; ")}` : "no active venture";
  const shortlist = b.shortlist.length ? `your shortlist: ${b.shortlist.join(", ")}` : "no shortlist";
  const pending = b.pendingOutcomes > 0 ? `; ${b.pendingOutcomes} decided path(s) await measurement (review_decision)` : "";
  return `Your economy (figures for your own judgement; details via wallet, venture, opportunity): ${parts.join(", ")}; ${ventures}; ${shortlist}${pending}.`.slice(0, 700);
}
