/**
 * Formal Fleet Command — the administrative view of FleetController (the same facts the Virtual Command Centre's Fleet
 * Command panel shows, from the same components). Behaviour changes use the deck's action dialog: review, then a fresh
 * passkey step-up on the gateway. Settings with no safe write path are shown read-only and say why.
 */
import { ProjectsOverview } from "./projects";
import { useState, type ReactNode } from "react";
import { money, type Fleet } from "../model";
import { Panel, button } from "../ui";
import type { AgentModel } from "./agents";
import { CapabilityState, CommandFeed, DecisionFeed, EventFeed, FleetControllerStatus, TreasurySummary, AgentRow } from "./panels";
import type { EventPriority } from "./events";
import type { CommandView, Row } from "./view";
import type { FeedState } from "./useFleetCommand";

export type Field = { key: string; label: string; value?: string; options?: string[][] };
export type Control = (label: string, op: string, fields?: Field[], args?: Record<string, string>, sensitive?: boolean) => ReactNode;

const TABS = ["Overview", "Decision Log", "Information Feed", "Full history", "Behaviour", "Safety & Capabilities", "Advanced"] as const;
type Tab = (typeof TABS)[number];
const val = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const pct = (bp: unknown) => (typeof bp === "number" ? String(bp / 100) : "");

export function FleetCommandPage({ fleet, view, models, feed, live, control, openAgent, go, clear }: {
  fleet: Fleet; view: CommandView | null; models: AgentModel[]; feed: FeedState; live: boolean; control: Control; openAgent: (id: string) => void; go: (page: string) => void;
  /** Clear one priority from the Fleet Command display (LIVE; display housekeeping, no step-up). */
  clear?: (p: EventPriority) => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>("Overview");
  const s = view?.settings ?? null, rp = fleet.live?.replication;
  const missions = s?.missions as Row | null | undefined, risk = s?.risk as Row | null | undefined;
  const pending = !view ? <p className="text-sm text-slate-400">Reading Fleet Command from the Fleet…</p> : null;
  const readOnly = (rows: Array<[string, ReactNode]>) => <dl className="grid gap-3 sm:grid-cols-2">{rows.map(([k, v]) => <div key={k} className="rounded-lg border border-slate-700 p-3"><dt className="text-xs text-slate-400">{k}</dt><dd className="mt-1">{v}</dd></div>)}</dl>;

  return <div className="space-y-5">
    <div role="tablist" aria-label="Fleet Command sections" className="flex flex-wrap gap-2">{TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} className={`${button} ${tab === t ? "bg-cyan-950 text-cyan-200" : ""}`} onClick={() => setTab(t)}>{t}</button>)}</div>
    <p className="text-xs text-slate-400">Feed: {feed === "live" ? "live" : feed === "reconnecting" ? "interrupted — reconnecting (showing the last data read)" : "connecting"}{view?.fetchedAt ? ` · command data read ${view.fetchedAt.slice(11, 19)} UTC` : ""}{view?.unavailable.length ? ` · unavailable: ${view.unavailable.join(", ")}` : ""}</p>

    {tab === "Overview" && <>
      <Panel title="Controller status"><FleetControllerStatus fleet={fleet} view={view} models={models} /></Panel>
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Latest decisions">{pending ?? <DecisionFeed view={view} models={models} onOpenAgent={openAgent} compact />}<button className={`${button} mt-3`} onClick={() => setTab("Decision Log")}>Open the decision log</button></Panel>
        <Panel title="Information received">{pending ?? <CommandFeed events={view!.commandEvents} models={models} onOpenAgent={openAgent} limit={8} onClear={clear} />}<button className={`${button} mt-3`} onClick={() => setTab("Information Feed")}>Open the feed</button></Panel>
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Agents">{models.length ? <ul className="space-y-3">{models.map((m) => <li key={m.agent.id}><AgentRow m={m} onOpen={openAgent} /></li>)}</ul> : <p className="text-sm text-slate-400">No agents.</p>}</Panel>
        <Panel title="Team projects">{pending ?? <ProjectsOverview view={view} models={models} onOpenAgent={openAgent} />}</Panel>
        <Panel title="Pending dependencies">{pending ?? (view!.dependencies.length ? <ul className="space-y-2 text-sm">{view!.dependencies.map((d, i) => <li key={i} className="rounded border border-slate-700 p-2">{val(d.title ?? d.kind ?? d.summary ?? "dependency")} · {val(d.status)}{d.agentId ? ` · ${models.find((m) => m.agent.id === d.agentId)?.agent.name ?? d.agentId}` : ""}</li>)}</ul> : <p className="text-sm text-slate-400">No pending dependencies.</p>)}</Panel>
      </div>
      <Panel title="Treasury"><TreasurySummary fleet={fleet} view={view} /><button className={`${button} mt-4`} onClick={() => go("Treasury")}>Treasury controls</button></Panel>
    </>}

    {tab === "Decision Log" && <Panel title="Decision log">{pending ?? <DecisionFeed view={view} models={models} onOpenAgent={openAgent} />}</Panel>}
    {tab === "Information Feed" && <Panel title="Information received by Fleet Command">{pending ?? <CommandFeed events={view!.commandEvents} models={models} onOpenAgent={openAgent} limit={300} onClear={clear} />}</Panel>}
    {tab === "Full history" && <Panel title="Full event history (audit)"><p className="mb-3 text-xs text-slate-400">Every recorded Fleet event, including the audit mechanics and Agent activity Fleet Command leaves out. Sign-in and security detail is under Security.</p>
      {pending ?? <EventFeed events={view!.events} models={models} onOpenAgent={openAgent} limit={300} />}</Panel>}

    {tab === "Behaviour" && <>
      <Panel title="Replication behaviour">
        {readOnly([["Population ceiling (policy)", val(rp?.ceiling ?? s?.replication?.population_ceiling)], ["Health window", `${val(rp?.windowHours ?? s?.replication?.window_hours)} h`],
          ["Automatic births (policy)", (rp?.autoBirthEnabled ?? s?.replication?.auto_birth_enabled) ? "on" : "off"], ["Next threshold", rp ? money(rp.thresholdMinor) : "—"]])}
        <div className="mt-4 flex flex-wrap gap-2">{control("Change replication policy", "policy", live ? [
          { key: "autoBirth", label: "Automatic births (policy; the registry switch and service flag also apply)", options: rp?.autoBirthEnabled ? [["true", "On"], ["false", "Off"]] : [["false", "Off"], ["true", "On"]] },
          { key: "populationCeiling", label: "Population ceiling (1–50)", value: String(rp?.ceiling ?? 50) }, { key: "windowHours", label: "Health window (hours)", value: String(rp?.windowHours || 24) }]
          : [{ key: "amount", label: "Wealth threshold (GBP)", value: String(fleet.policy.threshold / 100) }, { key: "maxAgents", label: "Maximum agents", value: String(fleet.policy.maxAgents) },
            { key: "autoBirth", label: "Automatic policy preference (no background provisioning)", options: [["false", "Off"], ["true", "On — preference only"]] }], {}, true)}</div>
      </Panel>
      <Panel title="Mission behaviour">{missions ? <>
        {readOnly([["Stagnation threshold", `${val(missions.stagnation_days)} days`], ["Automatic mission assignment", missions.auto_assign_enabled ? "on" : "off"],
          ["Research mission target / maximum", `${val(missions.knowledge_target_hours)} h / ${val(missions.knowledge_max_hours)} h`], ["Marketing mission maximum / review", `${val(missions.marketing_max_hours)} h / ${val(missions.marketing_review_hours)} h`]])}
        <div className="mt-4">{control("Change mission behaviour", "mission_policy", [
          { key: "stagnationDays", label: "Stagnation threshold (days, 1–365)", value: val(missions.stagnation_days) },
          { key: "autoAssignEnabled", label: "Automatic mission assignment", options: missions.auto_assign_enabled ? [["true", "On"], ["false", "Off"]] : [["false", "Off"], ["true", "On"]] },
          { key: "knowledgeTargetHours", label: "Research target (hours, 1–336)", value: val(missions.knowledge_target_hours) }, { key: "knowledgeMaxHours", label: "Research maximum (hours, 1–336)", value: val(missions.knowledge_max_hours) },
          { key: "marketingMaxHours", label: "Marketing maximum (hours, 1–720)", value: val(missions.marketing_max_hours) }, { key: "marketingReviewHours", label: "Marketing review (hours, 1–168)", value: val(missions.marketing_review_hours) }], {}, true)}</div>
      </> : <p className="text-sm text-slate-400">{live ? "Mission policy is not available from the Fleet gateway." : "Mission policy is not modelled in the simulation."}</p>}</Panel>
      <Panel title="Risk thresholds">{risk ? <>
        {readOnly([["Red-zone cushion", `${pct(risk.red_zone_bp)} %`], ["Vulnerable while younger than", `${val(risk.vulnerable_age_days)} days`], ["Comfort runway", `${val(risk.comfort_months)} months`],
          ["Amber / deep / deepest exposure", `${pct(risk.amber_bp)} % / ${pct(risk.deep_bp)} % / ${pct(risk.deepest_bp)} %`]])}
        <div className="mt-4">{control("Change risk thresholds", "risk_policy", [
          { key: "redZoneBp", label: "Red-zone cushion (% of commitments, 0–100)", value: pct(risk.red_zone_bp) }, { key: "vulnerableAgeDays", label: "Vulnerable while younger than (days)", value: val(risk.vulnerable_age_days) },
          { key: "comfortMonths", label: "Comfort runway (months, 1–36)", value: val(risk.comfort_months) }, { key: "amberBp", label: "Amber exposure (%)", value: pct(risk.amber_bp) },
          { key: "deepBp", label: "Deep exposure (%)", value: pct(risk.deep_bp) }, { key: "deepestBp", label: "Deepest exposure (%)", value: pct(risk.deepest_bp) }], {}, true)}</div>
      </> : <p className="text-sm text-slate-400">{live ? "Risk policy is not available from the Fleet gateway." : "Risk policy is not modelled in the simulation."}</p>}</Panel>
      <Panel title="Read-only here">
        {readOnly([["Maximum living agents (registry cap)", val(s?.flags?.maxAgents ?? rp?.maxAgents)], ["Genesis allocation per agent (100 % wallet health)", view?.genesisMinor != null ? money(view.genesisMinor) : "unavailable"],
          ["Treasury profit sweeps", s?.sweeps ? (s.sweeps.enabled ? "enabled" : "disabled") : "unavailable"], ["Capital engine", s?.capital ? (s.capital.enabled ? "enabled" : "disabled") : "unavailable"]])}
        <p className="mt-3 text-xs text-slate-400">The registry cap changes only on the Fleet host with the owner&apos;s approval; the Genesis allocation and the sweep and capital policies are economic policy (architecture review), so the dashboard has no control for them. Notification delivery is under Notifications.</p>
      </Panel>
    </>}

    {tab === "Safety & Capabilities" && <Panel title="Safety and capability state"><CapabilityState fleet={fleet} view={view} /></Panel>}

    {tab === "Advanced" && <Panel title="Diagnostics">
      {readOnly([["Fleet snapshot read", fleet.live?.fetchedAt ? `${fleet.live.fetchedAt.slice(0, 19).replace("T", " ")} UTC` : live ? "—" : "simulation"],
        ["Command data read", view?.fetchedAt ? `${view.fetchedAt.slice(0, 19).replace("T", " ")} UTC` : "—"], ["Live feed", feed],
        ["Events held in this tab", String(view?.events.length ?? 0)], ["Unavailable sections", [...(fleet.live?.unavailable ?? []), ...(view?.unavailable ?? [])].join(", ") || "none"],
        ["Transport", "Reads only: agents + latest events every 5 s while Fleet Command or Virtual is open and the tab is visible; the full command view every 30 s."]])}
      <div className="mt-4 flex flex-wrap gap-2"><button className={button} onClick={() => go("Security")}>Audit &amp; reveal log</button><button className={button} onClick={() => go("Replication")}>Replication</button><button className={button} onClick={() => go("Notifications")}>Notifications</button></div>
    </Panel>}
  </div>;
}
