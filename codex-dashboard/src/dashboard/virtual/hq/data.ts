/**
 * What the headquarters' screens show — FleetController's own figures (snapshot, command view, derived agent state),
 * reshaped into short lines. Nothing here is a number of its own; a figure the gateway does not supply reads "—".
 *
 *  - status screens: a few key figures per department (hqDataFrom);
 *  - boards: real items per department — agents and their condition, missions, opportunities, ventures, knowledge,
 *    alerts, estate items, Treasury events (hqBoardsFrom);
 *  - the Treasury banner: the Treasury's cash and the breakdowns the gateway actually supplies (treasuryBannerFrom).
 */
import { money, type Fleet } from "../../model";
import type { AgentModel } from "../../command/agents";
import { BAND_LABEL } from "../../command/economics";
import { DEPARTMENT } from "../../command/departments";
import type { CommandView, Row } from "../../command/view";
import type { HQData } from "./screens";

const DASH = "—";
const minor = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? money(v) : DASH);
const count = <T,>(xs: readonly T[] | undefined | null, f?: (x: T) => boolean) => (xs ? String(f ? xs.filter(f).length : xs.length) : DASH);
const words = (s: string) => s.replace(/_/g, " ");

/**
 * Treasury cash: LIVE reads the gateway's wealth figure only (missing → null, shown as —, never 0); the simulation shows
 * its own (labelled) simulated Treasury.
 */
export const treasuryCash = (fleet: Fleet): number | null => (fleet.live ? fleet.live.wealth?.cash ?? null : fleet.treasury);

export function hqDataFrom(fleet: Fleet, view: CommandView | null, models: readonly AgentModel[]): HQData {
  const lv = fleet.live, rp = lv?.replication, living = models.filter((m) => m.agent.status !== "dead");
  const here = (dep: string) => String(models.filter((m) => m.placement.department === dep).length);
  const bands = (b: string) => String(living.filter((m) => m.health.band === b).length);
  const redOpen = fleet.notices.filter((n) => n.level === "RED" && !n.acknowledged).length;
  const cash = minor(treasuryCash(fleet));
  return {
    command: [["Living agents", `${living.length}${rp?.maxAgents != null ? ` / ${rp.maxAgents}` : ""}`], ["Treasury cash", cash],
      ["Open RED alerts", String(redOpen)], ["Replication", rp ? (rp.met ? "threshold met" : `${money(rp.remainingMinor)} to go`) : DASH],
      ["Decisions (log)", view ? String(view.capital.length) : DASH], ["Dependencies", view ? String(view.dependencies.length) : DASH]],
    treasury: [["Treasury cash", cash], ["Owner funding", lv ? minor(lv.wealth?.ownerContributed) : money(fleet.contributed)],
      ["Fleet-generated", minor(lv?.wealth?.fleetGenerated)], ["Revenue 24 h", minor(lv?.flows24h?.revenue)], ["Spend 24 h", minor(lv?.flows24h?.spend)]],
    opportunity: [["Agents here", here("opportunity")], ["Opportunities", count(view?.opportunities)], ["Shortlisted", count(view?.opportunities, (o) => o.status === "shortlisted")]],
    floor: [["Agents here", here("floor")], ["Healthy", bands("HEALTHY")], ["Profitable", bands("WINNING")], ["Stressed", bands("WOUNDED")], ["Critical", bands("CRITICAL")]],
    marketing: [["Agents here", here("marketing")], ["Marketing missions", count(fleet.missions, (m) => /market/i.test(m.kind) && m.status === "active")]],
    library: [["Agents here", here("library")], ["Knowledge records", count(view?.knowledge)]],
    venture: [["Agents here", here("venture")], ["Ventures", count(view?.ventures)], ["Operating", count(view?.ventures, (v) => v.state === "operating")]],
    identity: [["Agents here", here("identity")], ["Values shown", "never here"]],
    estate: [["Estate items", count(fleet.estates)], ["Store", lv?.storage ? `${Math.round(lv.storage.heldBytes / 1_048_576)} / ${Math.round(lv.storage.capacityBytes / 1_048_576)} MB` : DASH]],
    comms: [["Mail", (lv?.mail ?? DASH).replace("_", " ")], ["SMS", (lv?.sms ?? DASH).replace("_", " ")], ["Recorded needs", String(lv?.recordedNeeds ?? 0)]],
    security: [["RED alerts open", String(redOpen)], ["AMBER open", String(fleet.notices.filter((n) => n.level === "AMBER" && !n.acknowledged).length)],
      ["Fleet health", lv?.health ? (lv.health.ok ? "ok" : `${lv.health.findings} finding(s)`) : DASH], ["Treasury withdrawn", minor(lv?.wealth?.ownerWithdrawn)]],
  };
}

export const redAlertOpen = (fleet: Fleet) => fleet.notices.some((n) => n.level === "RED" && !n.acknowledged);

// ── Boards ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export type BoardTone = "ok" | "warn" | "bad" | "muted" | undefined;
export interface HQBoard { title: string; rows: Array<[string, string, BoardTone?]>; empty: string }
export type HQBoards = Partial<Record<string, HQBoard>>;

const TONE: Record<string, BoardTone> = { HEALTHY: "ok", WINNING: "ok", WOUNDED: "warn", CRITICAL: "bad", DEAD: "muted", UNKNOWN: "muted" };
const str = (v: unknown, n = 26) => { const s = String(v ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

/**
 * Real items for the department boards. Board ids are `${department}:${name}` and are placed by world-build. Each list
 * is FleetController's (or, in the simulation, the simulation's own labelled data); an empty list says so.
 */
export function hqBoardsFrom(fleet: Fleet, view: CommandView | null, models: readonly AgentModel[]): HQBoards {
  const name = (id: unknown) => models.find((m) => m.agent.id === id)?.agent.name ?? (id ? str(id, 14) : "Fleet");
  const living = models.filter((m) => m.agent.status !== "dead");
  const amount = (e: Row) => (typeof e.detail?.amountMinor === "number" ? money(e.detail.amountMinor) : "");
  const treasuryEvents = (view?.events ?? []).filter((e) => /^(treasury_|genesis_funded|capital_decision|settlement_|wallet_transfer|agent_transfer)/.test(e.type));
  const boards: HQBoards = {
    "command:agents": { title: "Agents · condition · room", empty: "No agents", rows: living.slice(0, 12).map((m) => [`${str(m.agent.name, 14)} · ${DEPARTMENT[m.placement.department].name}`, BAND_LABEL[m.health.band], TONE[m.health.band]]) },
    "command:missions": { title: "Missions", empty: "No active missions", rows: fleet.missions.filter((m) => m.status === "active").slice(0, 8).map((m) => [`${name(m.agentId)} · ${str(words(m.kind), 18)}`, m.status, "ok"]) },
    "treasury:ledger": { title: "Treasury events", empty: "No Treasury events recorded yet", rows: treasuryEvents.slice(0, 8).map((e) => [`${str(words(e.type), 22)} · ${name(e.agentId)}`, amount(e as unknown as Row) || e.at.slice(11, 16)]) },
    "opportunity:board": { title: "Opportunities", empty: "No opportunities under investigation", rows: (view?.opportunities ?? []).slice(0, 8).map((o) => [`${str(o.offer ?? o.key ?? "opportunity", 22)} · ${name(o.agentId)}`, str(o.status ?? "", 12), o.status === "shortlisted" ? "ok" : undefined]) },
    "venture:board": { title: "Ventures", empty: "No ventures yet", rows: (view?.ventures ?? []).slice(0, 8).map((v) => [`${str(v.key ?? "venture", 22)} · ${name(v.agentId)}`, str(v.state ?? "", 12), v.state === "operating" ? "ok" : undefined]) },
    "library:board": { title: "Knowledge records", empty: "No recorded knowledge yet", rows: (view?.knowledge ?? []).slice(0, 8).map((k) => [str(k.subject ?? k.topic ?? "record", 26), name(k.agentId)]) },
    "marketing:board": { title: "Marketing missions", empty: "No marketing missions", rows: fleet.missions.filter((m) => /market/i.test(m.kind)).slice(0, 8).map((m) => [`${name(m.agentId)} · ${str(m.brief, 18)}`, m.status, m.status === "active" ? "ok" : "muted"]) },
    "security:board": { title: "Open alerts", empty: "No unacknowledged RED or AMBER alerts", rows: fleet.notices.filter((n) => !n.acknowledged && n.level !== "INFO").slice(0, 8).map((n) => [str(n.title, 28), n.level, n.level === "RED" ? "bad" : "warn"]) },
    "comms:board": { title: "Channels", empty: "", rows: [["Mail", (fleet.live?.mail ?? DASH).replace(/_/g, " "), fleet.live?.mail === "CONFIGURED" ? "ok" : "muted"], ["SMS", (fleet.live?.sms ?? DASH).replace(/_/g, " "), fleet.live?.sms === "CONFIGURED" ? "ok" : "muted"], ["Recorded needs", String(fleet.live?.recordedNeeds ?? 0)]] },
    "estate:board": { title: "Estate items", empty: "No estate items", rows: fleet.estates.slice(0, 8).map((e) => [str(e.name, 22), str(e.assigned || e.owner, 14), "muted"]) },
    "floor:board": { title: "Workstations", empty: "No workstations", rows: [["Online", String(living.filter((m) => m.agent.status === "active").length), "ok"], ["Held", String(living.filter((m) => m.agent.status === "held").length), "warn"], ["Provisioning", String(living.filter((m) => m.agent.status === "provisioning").length)], ["Powered down", String(models.length - living.length), "muted"]] },
    "command:projects": { title: "Team projects", empty: "No team projects in progress", rows: projectRows(view, name) },
    "venture:projects": { title: "Team projects · ETA solo → team", empty: "No team projects in progress", rows: projectRows(view, name, true) },
    "identity:board": { title: "Identity desk", empty: "", rows: [["Agents here", String(models.filter((m) => m.placement.department === "identity").length)], ["Credential values", "never displayed", "muted"]] },
  };
  return boards;
}

/** Active and planning team projects as board rows (FleetController's project records; ETAs from its planner). */
function projectRows(view: CommandView | null, name: (id: unknown) => string, eta = false): Array<[string, string, BoardTone?]> {
  const h = (v: unknown) => (typeof v === "number" ? (v >= 24 ? `${Math.round((v / 8) * 10) / 10}d` : `${Math.round(v)}h`) : DASH);
  return (view?.projects ?? []).filter((p) => p.status === "active" || p.status === "planning").slice(0, 8).map((p) => [
    `${str(p.name ?? p.projectKey, 18)} · ${name(p.leadAgentId)} +${Math.max(0, Number(p.teamSize ?? 1 + (Array.isArray(p.members) ? p.members.filter((m: Row) => m.status === "accepted").length : 0)) - 1)}`,
    eta ? `${h(p.eta?.soloHours)} → ${h(p.eta?.teamHours)}` : String(p.stage ?? p.status).toUpperCase(),
    p.status === "active" ? "ok" : undefined,
  ]);
}

// ── The Treasury banner ────────────────────────────────────────────────────────────────────────────────────────────
export interface TreasuryBanner {
  /** The Treasury's cash in minor units, or null when the gateway does not supply it (shown as —). */
  cashMinor: number | null;
  cash: string;
  /** Breakdowns the data actually contains; each unavailable one reads — (never estimated). */
  secondary: Array<[string, string]>;
}

export function treasuryBannerFrom(fleet: Fleet, view: CommandView | null): TreasuryBanner {
  const lv = fleet.live, t = view?.treasury, c = treasuryCash(fleet);
  return {
    cashMinor: c, cash: minor(c),
    secondary: [
      ["Owner funding", lv ? minor(lv.wealth?.ownerContributed) : money(fleet.contributed)],
      ["Fleet-generated profit", lv ? minor(lv.wealth?.fleetGenerated) : minor(t?.lifetimeContributionMinor)],
      ["Operating pool", minor(t?.operatingPoolMinor)],
      ["Committed (envelopes)", minor(t?.outstandingEnvelopesMinor)],
      ["Restricted / tax", minor(t?.restrictedMinor ?? t?.taxReserveMinor)],
      ["Owner withdrawn", lv ? minor(lv.wealth?.ownerWithdrawn) : DASH],
    ],
  };
}
