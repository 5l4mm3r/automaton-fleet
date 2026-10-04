/**
 * What each department's screen shows — FleetController's own figures (snapshot, command view, derived agent state),
 * reshaped into short lines. Nothing here is a number of its own; a figure the gateway does not supply reads "—".
 */
import { money, type Fleet } from "../../model";
import type { AgentModel } from "../../command/agents";
import type { CommandView } from "../../command/view";
import type { HQData } from "./screens";

const minor = (v: unknown) => (typeof v === "number" ? money(v) : "—");
const count = <T,>(xs: readonly T[] | undefined | null, f?: (x: T) => boolean) => (xs ? String(f ? xs.filter(f).length : xs.length) : "—");

export function hqDataFrom(fleet: Fleet, view: CommandView | null, models: readonly AgentModel[]): HQData {
  const lv = fleet.live, rp = lv?.replication, living = models.filter((m) => m.agent.status !== "dead");
  const here = (dep: string) => String(models.filter((m) => m.placement.department === dep).length);
  const bands = (b: string) => String(living.filter((m) => m.health.band === b).length);
  const redOpen = fleet.notices.filter((n) => n.level === "RED" && !n.acknowledged).length;
  return {
    command: [["Living agents", `${living.length}${rp?.maxAgents != null ? ` / ${rp.maxAgents}` : ""}`], ["Treasury cash", money(lv?.wealth?.cash ?? fleet.treasury)],
      ["Open RED alerts", String(redOpen)], ["Replication", rp ? (rp.met ? "threshold met" : `${money(rp.remainingMinor)} to go`) : "—"],
      ["Decisions (log)", view ? String(view.capital.length) : "—"], ["Dependencies", view ? String(view.dependencies.length) : "—"]],
    treasury: [["Treasury cash", money(lv?.wealth?.cash ?? fleet.treasury)], ["Owner funding", money(lv?.wealth?.ownerContributed ?? fleet.contributed)],
      ["Fleet-generated", lv?.wealth ? money(lv.wealth.fleetGenerated) : "—"], ["Revenue 24 h", lv?.flows24h ? money(lv.flows24h.revenue) : "—"], ["Spend 24 h", lv?.flows24h ? money(lv.flows24h.spend) : "—"]],
    opportunity: [["Agents here", here("opportunity")], ["Opportunities", count(view?.opportunities)], ["Shortlisted", count(view?.opportunities, (o) => o.status === "shortlisted")]],
    floor: [["Agents here", here("floor")], ["Healthy", bands("HEALTHY")], ["Profitable", bands("WINNING")], ["Stressed", bands("WOUNDED")], ["Critical", bands("CRITICAL")]],
    marketing: [["Agents here", here("marketing")], ["Marketing missions", count(fleet.missions, (m) => /market/i.test(m.kind) && m.status === "active")]],
    library: [["Agents here", here("library")], ["Knowledge records", count(view?.knowledge)]],
    venture: [["Agents here", here("venture")], ["Ventures", count(view?.ventures)], ["Operating", count(view?.ventures, (v) => v.state === "operating")]],
    identity: [["Agents here", here("identity")], ["Values shown", "never here"]],
    estate: [["Estate items", count(fleet.estates)], ["Store", lv?.storage ? `${Math.round(lv.storage.heldBytes / 1_048_576)} / ${Math.round(lv.storage.capacityBytes / 1_048_576)} MB` : "—"]],
    comms: [["Mail", (lv?.mail ?? "—").replace("_", " ")], ["SMS", (lv?.sms ?? "—").replace("_", " ")], ["Recorded needs", String(lv?.recordedNeeds ?? 0)]],
    security: [["RED alerts open", String(redOpen)], ["AMBER open", String(fleet.notices.filter((n) => n.level === "AMBER" && !n.acknowledged).length)],
      ["Fleet health", lv?.health ? (lv.health.ok ? "ok" : `${lv.health.findings} finding(s)`) : "—"], ["Treasury withdrawn", minor(lv?.wealth?.ownerWithdrawn)]],
  };
}

export const redAlertOpen = (fleet: Fleet) => fleet.notices.some((n) => n.level === "RED" && !n.acknowledged);
