/**
 * Notification detail as the owner reads it (pure; unit-tested). A notification's `detail` is structured data written by
 * FleetController; it is turned into readable sections here — never shown raw by default.
 *
 * The Fleet daily report (code DAILY_REPORT) carries the WHOLE report as it was generated (fleet_daily_report(): flows,
 * Treasury, agents, ventures, decisions, replication, alerts …), so the notification itself is the authoritative record
 * of that day — no second lookup, nothing invented. A payload without the report's shape is "Report unavailable".
 */
import { money } from "../model";
import { displayAgentName } from "../naming";

export type Row = Record<string, unknown>;
export type Fact = [label: string, value: string];
export interface Section { title: string; facts: Fact[]; note?: string }
export interface AgentLine { name: string; status: string; mode: string; cash: string; value: string }
export interface DailyReport { date: string; generatedAt: string; window: string; sections: Section[]; agents: AgentLine[] }

const isObj = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : null);
const amount = (v: unknown) => { const n = num(v); return n === null ? "—" : money(n); };
const count = (v: unknown) => { const n = num(v); return n === null ? "—" : n.toLocaleString("en-GB"); };
const text = (v: unknown, max = 200) => (v === null || v === undefined ? "—" : String(v).slice(0, max));
/** "2026-10-07T07:01:11.06+00:00" → "2026-10-07 07:01 UTC". */
export function utcText(iso: unknown): string {
  if (typeof iso !== "string") return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The daily report, or null when the payload does not have the report's shape (shown as "Report unavailable"). */
export function dailyReport(detail: unknown): DailyReport | null {
  if (!isObj(detail) || typeof detail.generatedAt !== "string" || !isObj(detail.flows) || Number.isNaN(Date.parse(detail.generatedAt))) return null;
  const f = detail.flows, t = isObj(detail.treasury) ? detail.treasury : null, rp = isObj(detail.replication) ? detail.replication : null;
  const alerts = isObj(detail.alerts24h) ? detail.alerts24h : null;
  const agents = Array.isArray(detail.agents) ? detail.agents.filter(isObj) : [];
  const sections: Section[] = [
    { title: `Money in the last ${text(detail.window, 10)}`, facts: [
      ["External revenue", amount(f.revenueMinor)], ["Spending", amount(f.spendMinor)],
      ["Realised profit contributed to the Treasury", amount(f.profitContributionMinor)], ["Owner funding", amount(f.ownerFundingMinor)]],
      note: "Owner funding is capital, never revenue or profit." },
    ...(t ? [{ title: "Treasury", facts: [
      ["Treasury cash", amount(t.treasuryCashMinor)], ["Fleet-generated realised wealth", amount(t.fleetGeneratedMinor)],
      ["Owner contributed", amount(t.ownerContributedMinor)], ["Owner withdrawn", amount(t.ownerWithdrawnMinor)]] as Fact[] }] : []),
    { title: "Activity in the window", facts: [
      ["Ventures opened", count(detail.venturesOpened24h)], ["Ventures closed", count(detail.venturesClosed24h)],
      ["Recorded decisions", count(detail.decisions24h)], ["Accounts created", count(detail.accountsCreated24h)],
      ["Agent deaths", count(detail.deaths24h)], ["Active missions", count(detail.missionsActive)]] },
    { title: "Replication and safety", facts: [
      ...(rp ? [["Replication phase", text(rp.phase, 40)], ["Thresholds used", count(rp.thresholdsConsumed)], ["Next threshold", amount(rp.nextThresholdMinor)]] as Fact[] : []),
      ["Births queued", count(detail.birthsQueued)], ["Security breaker", detail.breakerTripped === true ? "TRIPPED" : detail.breakerTripped === false ? "not tripped" : "—"],
      ["Identity actions waiting for you", count(detail.identityActionsPending)],
      ["Alerts in the window", alerts && Object.keys(alerts).length ? Object.entries(alerts).map(([k, v]) => `${count(v)} ${k}`).join(", ") : "none"]] },
  ];
  return {
    date: utcText(detail.generatedAt).slice(0, 10), generatedAt: utcText(detail.generatedAt), window: text(detail.window, 10), sections,
    agents: agents.map((a) => ({ name: displayAgentName(typeof a.name === "string" ? a.name : null, text(a.agentId, 26)), status: text(a.status, 20),
      mode: text(a.mode, 20), cash: amount(a.cashMinor), value: amount(a.valueMinor) })),
  };
}

const SECRET_KEY = /secret|token|password|passphrase|private|credential|seed|apikey|api_key|sealed|cipher/i;
const words = (k: string) => k.replace(/Minor$/, "").replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

/** Readable facts from any other notification's detail: primitives only, money formatted, secret-looking keys withheld. */
export function detailFacts(detail: unknown, max = 24): Fact[] {
  if (!isObj(detail)) return [];
  const out: Fact[] = [];
  for (const [k, v] of Object.entries(detail)) {
    if (out.length >= max) break;
    if (SECRET_KEY.test(k)) { out.push([words(k), "withheld"]); continue; }
    if (v === null || v === undefined) continue;
    if (typeof v === "object") { if (!Array.isArray(v) || v.some((x) => typeof x === "object")) continue; out.push([words(k), v.map((x) => text(x, 60)).join(", ").slice(0, 200)]); continue; }
    out.push([words(k), /Minor$/.test(k) && num(v) !== null ? amount(v) : typeof v === "boolean" ? (v ? "yes" : "no") : /At$/.test(k) ? utcText(v) : text(v)]);
  }
  return out;
}

/** The technical view (collapsed by default): the stored payload as text, secret-looking keys withheld at every depth. */
export function technicalText(detail: unknown): string {
  const scrub = (v: unknown, depth: number): unknown => {
    if (depth > 8) return "…";
    if (Array.isArray(v)) return v.slice(0, 200).map((x) => scrub(x, depth + 1));
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? "(withheld)" : scrub(x, depth + 1)]));
    return typeof v === "string" ? v.slice(0, 2000) : v;
  };
  try { return JSON.stringify(scrub(detail, 0), null, 2).slice(0, 60_000); } catch { return "(unreadable)"; }
}

/** Plain-language names for notification codes the owner sees (others are shown as words). */
const CODE_TEXT: Record<string, string> = {
  DAILY_REPORT: "Fleet daily report", ADMIN_PASSKEY_ADDED: "Passkey added", ADMIN_PASSKEY_REVOKED: "Passkey revoked", ADMIN_PASSWORD_SET: "Sign-in password set",
  ADMIN_TOTP_RESET: "Authenticator reset", ADMIN_AUTH_LOCKOUT: "Sign-in locked after failures", ADMIN_PASSKEY_CLONE_SUSPECTED: "Passkey clone suspected",
  HUMAN_ACTION_REQUIRED: "Your action is needed", BREAKER_TRIPPED: "Security breaker tripped", TREASURY_INSOLVENT: "Treasury below obligations",
  HIGH_EXPOSURE_SPEND: "High-exposure spend",
};
export function codeText(code: string | undefined): string {
  if (!code) return "Notification";
  return CODE_TEXT[code] ?? code.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
/** Notifications raised by automated tests carry TEST_ codes; they are labelled, never mistaken for live Fleet reports. */
export const isTestNotice = (code: string | undefined) => typeof code === "string" && /^TEST_/.test(code);
