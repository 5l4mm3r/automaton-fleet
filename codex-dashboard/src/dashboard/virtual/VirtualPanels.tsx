/**
 * The Virtual Command Centre's information panels — clicked rooms and agents open these. They are built from the same
 * Fleet Command components and the same authoritative data as the Formal dashboard; actions reuse the deck's controls
 * (review + passkey step-up on the gateway). Nothing here holds state of its own.
 */
import { ProjectCard, projectsOf } from "../command/projects";
import { useEffect, useState, type ReactNode } from "react";
import { money, type Fleet } from "../model";
import { button } from "../ui";
import { AgentPortrait, HealthTag } from "../command/AgentPortrait";
import type { AgentModel } from "../command/agents";
import { DEPARTMENT, type DepartmentId } from "../command/departments";
import { eventDepartment } from "../command/departments";
import { CapabilityState, DecisionFeed, DepartmentRoster, EventFeed, FleetControllerStatus, TreasurySummary, factsOf, utc } from "../command/panels";
import type { Control } from "../command/FleetCommandPage";
import type { CommandView, Row } from "../command/view";

const time = (iso: unknown) => utc(iso);
const minor = (v: unknown) => (typeof v === "number" ? money(v) : "—");

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="mt-5"><h4 className="mb-2 text-xs tracking-widest text-cyan-300">{title.toUpperCase()}</h4>{children}</section>;
}
const list = (rows: Row[], render: (r: Row) => ReactNode, empty: string) => rows.length ? <ul className="space-y-2 text-sm">{rows.slice(0, 30).map((r, i) => <li key={i} className="rounded border border-slate-800 p-2">{render(r)}</li>)}</ul> : <p className="text-sm text-slate-400">{empty}</p>;

export function DepartmentPanel({ dep, fleet, view, models, openAgent, go }: { dep: DepartmentId; fleet: Fleet; view: CommandView | null; models: AgentModel[]; openAgent: (id: string) => void; go: (page: string) => void }) {
  const d = DEPARTMENT[dep];
  const name = (id: unknown) => models.find((m) => m.agent.id === id)?.agent.name ?? String(id ?? "—");
  const events = (view?.events ?? []).filter((e) => eventDepartment(e.type) === dep);
  const roster = <Section title="Agents here"><DepartmentRoster models={models} dep={dep} onOpen={openAgent} /></Section>;
  const feed = <Section title="Recent activity"><EventFeed events={events} models={models} onOpenAgent={openAgent} limit={15} filterable={false} /></Section>;
  let body: ReactNode;
  switch (dep) {
    case "command":
      body = <><Section title="Controller state"><FleetControllerStatus fleet={fleet} view={view} models={models} /></Section>
        <Section title="Decisions"><DecisionFeed view={view} models={models} onOpenAgent={openAgent} compact /></Section>
        <Section title="Information received"><EventFeed events={view?.events ?? []} models={models} onOpenAgent={openAgent} limit={12} filterable={false} /></Section>
        <button className={`${button} mt-4`} onClick={() => go("Fleet Command")}>Open Fleet Command (behaviour, full logs)</button></>;
      break;
    case "treasury":
      body = <><Section title="Treasury"><TreasurySummary fleet={fleet} view={view} /></Section>
        <Section title="Capital allocations">{list(view?.capital ?? [], (c) => <>{time(c.at)} · {name(c.agentId)} · {minor(c.amountMinor)} requested → {String(c.outcome ?? "—")}{c.approvedMinor != null ? ` (${minor(c.approvedMinor)})` : ""}</>, "No capital requests.")}</Section>
        {feed}<button className={`${button} mt-4`} onClick={() => go("Treasury")}>Open Treasury (transactions and controls)</button></>;
      break;
    case "opportunity":
      body = <>{roster}<Section title="Opportunities">{list(view?.opportunities ?? [], (o) => <>{String(o.offer ?? o.key ?? "opportunity")} · {String(o.status ?? "")}{o.confidenceBp != null ? ` · confidence ${Number(o.confidenceBp) / 100} %` : ""} · {name(o.agentId)}</>, "No opportunities under investigation.")}</Section>{feed}</>;
      break;
    case "library":
      body = <>{roster}<Section title="Fleet knowledge">{list(view?.knowledge ?? [], (k) => <>{String(k.subject ?? k.topic ?? "")}{k.claim ? ` — ${String(k.claim).slice(0, 140)}` : ""} · {name(k.agentId)} · {time(k.observedAt)}</>, "No recorded knowledge yet.")}</Section>{feed}</>;
      break;
    case "marketing":
      body = <>{roster}<Section title="Marketing missions">{list(fleet.missions.filter((m) => /market/i.test(m.kind)) as unknown as Row[], (m) => <>{String(m.brief)} · {String(m.status)} · {name(m.agentId)}</>, "No marketing missions.")}</Section>{feed}</>;
      break;
    case "venture":
      body = <>{roster}<Section title="Team projects">{(view?.projects ?? []).filter((p) => p.status === "active" || p.status === "planning").length
        ? <div className="space-y-2">{(view?.projects ?? []).filter((p) => p.status === "active" || p.status === "planning").map((p) => <ProjectCard key={String(p.projectId)} p={p} models={models} onOpenAgent={openAgent} />)}</div>
        : <p className="text-sm text-slate-400">No team projects in progress.</p>}</Section><Section title="Ventures">{list(view?.ventures ?? [], (v) => <>{String(v.key ?? "venture")}{v.offer ? ` — ${String(v.offer).slice(0, 80)}` : ""} · {String(v.state ?? "")} · {name(v.agentId)}</>, "No ventures yet.")}</Section>{feed}</>;
      break;
    case "identity":
      body = <>{roster}<p className="mt-4 text-sm text-slate-400">Identity and account metadata only. Credentials and owner identity facts are revealed only through the Formal pages, with a fresh passkey verification.</p>{feed}
        <button className={`${button} mt-4`} onClick={() => go("Owner identity")}>Owner identity</button></>;
      break;
    case "comms":
      body = <>{roster}<Section title="Capability"><p className="text-sm">MAIL: {(fleet.live?.mail ?? (view?.mode === "simulation" ? "SIMULATED" : "UNAVAILABLE")).replace("_", " ")} · SMS: {(fleet.live?.sms ?? (view?.mode === "simulation" ? "SIMULATED" : "UNAVAILABLE")).replace("_", " ")}</p>
        <p className="mt-2 text-sm text-slate-400">NOT CONFIGURED is the deliberate dormant state: no mailbox, no number, so no communications traffic is shown. Recorded agent needs: {fleet.live?.recordedNeeds ?? 0}.</p></Section>{feed}</>;
      break;
    case "estate":
      body = <>{roster}<Section title="Estate items">{list(fleet.estates as unknown as Row[], (e) => <>{String(e.name)} · {String(e.size)} MB · from {String(e.owner)}{e.assigned ? ` · assigned to ${name(e.assigned)}` : ""}</>, "No estate items.")}</Section>{feed}
        <button className={`${button} mt-4`} onClick={() => go("Estates")}>Open Estates</button></>;
      break;
    case "security":
      body = <><Section title="Alerts">{list(fleet.notices.filter((n) => !n.acknowledged && n.level !== "INFO") as unknown as Row[], (n) => <>{String(n.level)} · {String(n.title)} · {String(n.time)}</>, "No unacknowledged RED or AMBER alerts.")}</Section>
        <Section title="Capabilities"><CapabilityState fleet={fleet} view={view} /></Section>{feed}</>;
      break;
    default:
      body = <>{roster}{feed}</>;
  }
  return <div><p className="text-xs tracking-widest" style={{ color: d.accent }}>DEPARTMENT</p><h3 className="text-xl font-semibold">{d.name}</h3><p className="text-sm text-slate-400">{d.purpose}</p>{body}</div>;
}

export function AgentPanel({ m, fleet, view, control, go, loadLedger }: { m: AgentModel; fleet: Fleet; view: CommandView | null; control: Control; go: (page: string, id?: string) => void; loadLedger?: (agentId: string) => Promise<Row[]> }) {
  const a = m.agent, e = m.econ;
  const [ledger, setLedger] = useState<Row[] | null>(loadLedger ? null : []);
  useEffect(() => {
    if (!loadLedger) return;
    let live = true;
    loadLedger(a.id).then((r) => { if (live) setLedger(r); }, () => { if (live) setLedger([]); });
    return () => { live = false; };
  }, [a.id, loadLedger]);
  const assets = fleet.estates.filter((x) => x.assigned === a.id);
  const deps = (view?.dependencies ?? []).filter((d) => d.agentId === a.id);
  const missions = fleet.missions.filter((x) => x.agentId === a.id);
  const ventures = (view?.ventures ?? []).filter((v) => v.agentId === a.id);
  const events = (view?.events ?? []).filter((x) => x.agentId === a.id);
  const decisions = (view?.capital ?? []).filter((c) => c.agentId === a.id);
  const stat = (k: string, v: string) => <div className="rounded border border-slate-800 p-2"><dt className="text-xs text-slate-400">{k}</dt><dd className="font-mono">{v}</dd></div>;
  return <div>
    <div className="flex items-center gap-4"><AgentPortrait id={a.id} name={a.name} band={m.health.band} size={128} />
      <div><p className="text-xs tracking-widest text-cyan-300">AGENT</p><h3 className="text-xl font-semibold">{a.name}</h3><p className="font-mono text-2xl">{money(a.cash)}</p><HealthTag health={m.health} /></div></div>
    <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
      {stat("State", a.status.toUpperCase())}{stat("Activity", m.placement.activity)}{stat("Department", DEPARTMENT[m.placement.department].name)}
      {stat("Mission", missions.find((x) => x.status === "active")?.kind ?? (a.mode && a.mode !== "NORMAL" ? a.mode.replace(/_/g, " ") : "none"))}
      {stat("Revenue (lifetime)", e?.revenueMinor != null ? money(e.revenueMinor) : "—")}{stat("Expenses (lifetime)", e?.expensesMinor != null ? money(e.expensesMinor) : "—")}
      {stat("Net profit (lifetime)", e?.netProfitMinor != null ? money(e.netProfitMinor) : "—")}{stat("Net, last 30 days", e?.recentNetMinor != null ? money(e.recentNetMinor) : "—")}
      {stat("Runway", e?.runwayDays != null ? `${e.runwayDays} days` : a.runwayDays != null ? `${a.runwayDays} days` : "—")}{stat("Red-zone cushion", e?.redZoneMet == null ? "—" : e.redZoneMet ? "met" : "below")}
    </dl>
    <Section title="Why this condition"><ul className="list-disc pl-5 text-sm text-slate-300">{m.health.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
      <p className="mt-1 text-xs text-slate-400">Placed in {DEPARTMENT[m.placement.department].name}: {m.placement.basis === "mission" ? "its active mission" : m.placement.basis === "event" ? "its latest recorded activity" : m.placement.basis}.</p></Section>
    <Section title="Team projects">{projectsOf(view, a.id).length ? <div className="space-y-2">{projectsOf(view, a.id).map((p) => <ProjectCard key={String(p.projectId)} p={p} models={fleet.agents.map((x) => ({ agent: x }) as unknown as AgentModel)} />)}</div> : <p className="text-sm text-slate-400">Not on a team project.</p>}</Section>
    <Section title="Venture">{ventures.length ? ventures.map((v, i) => <p key={i} className="text-sm">{String(v.key ?? "venture")}{v.offer ? ` — ${String(v.offer).slice(0, 80)}` : ""} · {String(v.state ?? "")}</p>) : <p className="text-sm text-slate-400">No venture recorded.</p>}</Section>
    <Section title="Recent transactions">{ledger === null ? <p className="text-sm text-slate-400">Reading the agent&apos;s ledger…</p> : ledger.length ? <ol className="space-y-1 text-sm">{ledger.slice(0, 8).map((j, i) => <li key={i}>{time(j.at)} · {String(j.kind ?? "").replace(/_/g, " ")}{j.reason ? ` · ${String(j.reason).slice(0, 60)}` : ""}{Array.isArray(j.postings) && j.postings.length ? ` · ${money(Math.max(...j.postings.map((p: Row) => Number(p.amountMinor) || 0)))}` : ""}</li>)}</ol> : <p className="text-sm text-slate-400">No ledger journals for this agent.</p>}</Section>
    <Section title="Assets">{assets.length ? assets.map((x) => <p key={x.id} className="text-sm">{x.name} · {x.size} MB (inherited from {x.owner})</p>) : <p className="text-sm text-slate-400">No estate assets assigned.</p>}</Section>
    <Section title="Warnings and dependencies">{[...m.health.band === "CRITICAL" || m.health.band === "WOUNDED" ? [m.health.reasons.join(" ")] : [], ...deps.map((d) => `${String(d.title ?? d.kind ?? "dependency")} · ${String(d.status ?? "")}${d.blocking ? " · blocking" : ""}`)].map((w, i) => <p key={i} className="text-sm text-amber-200">{w}</p>)}
      {m.health.band !== "CRITICAL" && m.health.band !== "WOUNDED" && !deps.length && <p className="text-sm text-slate-400">None.</p>}</Section>
    <Section title="Recent decisions">{decisions.length ? decisions.slice(0, 5).map((c, i) => <p key={i} className="text-sm">{time(c.at)} · capital {minor(c.amountMinor)} → {String(c.outcome ?? "—")}</p>) : <p className="text-sm text-slate-400">No capital decisions.</p>}</Section>
    <Section title="Recent actions">{events.length ? <ol className="space-y-1 text-sm">{events.slice(0, 10).map((x) => <li key={x.key}>{time(x.at)} · {x.type.replace(/_/g, " ")}{factsOf(x.detail, 2).map(([k, v]) => ` · ${k}: ${v}`).join("")}</li>)}</ol> : <p className="text-sm text-slate-400">No recorded activity.</p>}</Section>
    <div className="mt-5 flex flex-wrap gap-2">
      <button className={button} onClick={() => go("Agents", a.id)}>View full agent</button>
      <button className={button} onClick={() => go("Fleet Command")}>Decisions</button>
      <button className={button} onClick={() => go("Missions")}>Missions</button>
      <button className={button} onClick={() => go("Treasury")}>Transactions</button>
      {a.status !== "dead" && control(a.status === "held" ? "Resume" : "Hold", "hold", [], { agentId: a.id, action: a.status === "held" ? "resume" : "hold" })}
    </div>
    <p className="mt-3 text-xs text-slate-400">Money movements, missions and retirement are on the full agent page, with the same review and passkey step-up.</p>
  </div>;
}
