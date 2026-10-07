/**
 * Shared Fleet Command building blocks — rendered by the Formal Fleet Command page AND the Virtual Command Centre's
 * panels, from the same props, so the two can never show different facts. Display only: every value is FleetController's
 * (snapshot, command view); writes go through the deck's existing action dialog and the gateway's step-up.
 */
import { useMemo, useState } from "react";
import { codeText } from "../notifications/report";
import { money, type Fleet } from "../model";
import { input } from "../ui";
import { AgentPortrait, HealthTag } from "./AgentPortrait";
import type { AgentModel } from "./agents";
import { DEPARTMENT } from "./departments";
import { isDecision, PRIORITY_ORDER, type EventPriority, type FleetEvent } from "./events";
import type { CommandView, Row } from "./view";

/** A timestamp as UTC "YYYY-MM-DD HH:MM" (gateway timestamps can carry the database session's offset). */
export function utc(iso: unknown, seconds = false): string {
  if (typeof iso !== "string") return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, seconds ? 19 : 16).replace("T", " ");
}
const time = (iso: unknown) => utc(iso);
const words = (s: string) => s.replace(/_/g, " ");
const minor = (v: unknown) => (typeof v === "number" ? money(v) : typeof v === "string" && /^-?\d+$/.test(v) ? money(Number(v)) : "—");

/**
 * A few primitive facts from an event's detail (stored facts only; long values cut). A notification event reads as
 * its plain-language kind ("Fleet daily report"), never as raw class / code values.
 */
export function factsOf(detail: Row | null | undefined, max = 5): Array<[string, string]> {
  if (!detail) return [];
  if (typeof detail.code === "string" && /^[A-Z][A-Z0-9_]{2,60}$/.test(detail.code) && typeof detail.class === "string" && Object.keys(detail).length <= 3) {
    return [["kind", codeText(detail.code)], ["severity", detail.class === "DAILY" ? "report" : detail.class.toLowerCase()]];
  }
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(detail)) {
    if (out.length >= max) break;
    if (v === null || v === undefined || typeof v === "object") continue;
    const text = /Minor$/.test(k) && (typeof v === "number" || /^-?\d+$/.test(String(v))) ? minor(v) : String(v);
    out.push([words(k.replace(/Minor$/, "")), text.length > 80 ? `${text.slice(0, 77)}…` : text]);
  }
  return out;
}

export function AgentRow({ m, onOpen }: { m: AgentModel; onOpen?: (id: string) => void }) {
  return <div className="flex items-center gap-3">
    <AgentPortrait id={m.agent.id} name={m.agent.name} band={m.health.band} size={64} />
    <div className="min-w-0">
      {onOpen ? <button className="text-cyan-300 underline" onClick={() => onOpen(m.agent.id)}>{m.agent.name}</button> : <strong>{m.agent.name}</strong>}
      <p className="text-xs text-slate-400"><span className="font-mono">{money(m.agent.cash)}</span> · <HealthTag health={m.health} /> · {m.placement.activity}</p>
    </div>
  </div>;
}

export function FleetControllerStatus({ fleet, view, models }: { fleet: Fleet; view: CommandView | null; models: AgentModel[] }) {
  const lv = fleet.live, rp = lv?.replication;
  const living = models.filter((m) => m.agent.status !== "dead");
  const bands = living.reduce<Record<string, number>>((acc, m) => ({ ...acc, [m.health.label]: (acc[m.health.label] ?? 0) + 1 }), {});
  const red = fleet.notices.filter((n) => n.level === "RED" && !n.acknowledged).length;
  const cells: Array<[string, string]> = [
    ["Controller", lv ? (lv.health ? (lv.health.ok ? "Healthy" : `${lv.health.findings} finding(s)`) : "health unavailable") : view?.mode === "simulation" ? "Simulated" : "—"],
    ["Living agents", `${living.length}${rp?.maxAgents != null ? ` / cap ${rp.maxAgents}` : ""}${rp?.ceiling != null ? ` (ceiling ${rp.ceiling})` : ""}`],
    ["Treasury cash", money(lv?.wealth?.cash ?? fleet.treasury)],
    ["Fleet-generated wealth", lv?.wealth ? money(lv.wealth.fleetGenerated) : view?.mode === "simulation" ? "simulated" : "unavailable"],
    ["Replication", rp ? `${rp.met ? "threshold met" : `${money(rp.remainingMinor)} to the next threshold`} · ${rp.blockers.length ? `blocked: ${rp.blockers.join(", ")}` : "no blockers"}` : "unavailable"],
    ["Open RED alerts", String(red)],
    ["Pending dependencies", view ? String(view.dependencies.length) : "—"],
    ["Agent health", Object.entries(bands).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(" · ") || "no living agents"],
  ];
  return <dl className="grid gap-3 sm:grid-cols-2">{cells.map(([k, v]) => <div key={k} className="rounded-lg border border-slate-700 p-3"><dt className="text-xs text-slate-400">{k}</dt><dd className="mt-1">{v}</dd></div>)}</dl>;
}

export interface Capability { name: string; state: string; detail: string; tone: "off" | "on" | "dormant" | "unknown" }

/**
 * The safety / capability states, as the Fleet reports them. The host-level live-money switches are not exposed to the
 * dashboard gateway: they are shown as such (verified on the Fleet host by fleet:doctor), never guessed.
 */
export function capabilitiesOf(fleet: Fleet, view: CommandView | null): Capability[] {
  const lv = fleet.live, s = view?.settings ?? null;
  const sweeps = s?.sweeps ?? view?.treasury?.sweepPolicy ?? null, capital = s?.capital ?? view?.treasury?.capitalPolicy ?? null;
  const yesNo = (v: unknown, on: string, off: string): Pick<Capability, "state" | "tone"> => (v === true ? { state: on, tone: "on" } : v === false ? { state: off, tone: "off" } : { state: "unavailable", tone: "unknown" });
  return [
    { name: "Real payments", state: "host switch", tone: "unknown", detail: "REAL_PAYMENTS_ENABLED is a FleetController host setting, not exposed to this gateway (fleet:doctor reports it on the host). Withdrawals only record instructions while live money is off." },
    { name: "Owner sweep", state: "host switch", tone: "unknown", detail: "OWNER_SWEEP_ENABLED is a FleetController host setting, not exposed to this gateway." },
    { name: "Automatic replication — policy", ...yesNo(lv?.replication?.autoBirthEnabled ?? s?.replication?.auto_birth_enabled, "on", "off"), detail: "Replication policy auto-birth (Admin, step-up)." },
    { name: "Automatic replication — registry switch", ...yesNo(lv?.replication?.registrySwitch ?? s?.flags?.registryReplicationSwitch, "on", "off"), detail: "Registry replication switch (host operator CLI)." },
    { name: "Treasury profit sweeps", ...yesNo(sweeps?.enabled, "enabled", "disabled"), detail: "Agent net-profit sweeps into the Treasury (sweep policy)." },
    { name: "Capital engine", ...yesNo(capital?.enabled, "enabled", "disabled"), detail: "FleetController's capital-request decisions (capital policy)." },
    { name: "Mail", state: (lv?.mail ?? "unavailable").replace("_", " "), tone: lv?.mail === "CONFIGURED" ? "on" : lv?.mail === "NOT_CONFIGURED" ? "dormant" : "unknown", detail: "Shared mailbox capability. NOT CONFIGURED is the deliberate dormant state." },
    { name: "SMS", state: (lv?.sms ?? "unavailable").replace("_", " "), tone: lv?.sms === "CONFIGURED" ? "on" : lv?.sms === "NOT_CONFIGURED" ? "dormant" : "unknown", detail: "SMS capability. NOT CONFIGURED is the deliberate dormant state." },
    { name: "Recorded agent needs", state: String(lv?.recordedNeeds ?? 0), tone: "unknown", detail: "Open communication needs agents recorded (mail/SMS stay dormant until justified)." },
  ];
}

export function CapabilityState({ fleet, view }: { fleet: Fleet; view: CommandView | null }) {
  const tone = { on: "text-amber-200", off: "text-slate-300", dormant: "text-slate-300", unknown: "text-slate-400" } as const;
  return <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-slate-400"><tr><th className="p-2">Capability</th><th className="p-2">State</th><th className="p-2">Meaning</th></tr></thead>
    <tbody>{capabilitiesOf(fleet, view).map((c) => <tr key={c.name} className="border-t border-slate-800"><td className="p-2">{c.name}</td><td className={`p-2 font-mono ${tone[c.tone]}`}>{c.state.toUpperCase()}</td><td className="p-2 text-slate-400">{c.detail}</td></tr>)}</tbody></table>
    <p className="mt-2 text-xs text-slate-400">Read-only here. These states are not changed by this dashboard; automatic births are a Replication policy setting with step-up.</p></div>;
}

export function TreasurySummary({ fleet, view }: { fleet: Fleet; view: CommandView | null }) {
  const lv = fleet.live, t = view?.treasury;
  const cells: Array<[string, string]> = [
    ["Spendable Treasury cash", money(lv?.wealth?.cash ?? fleet.treasury)],
    ["Owner-contributed funding", money(lv?.wealth?.ownerContributed ?? fleet.contributed)],
    ["Owner withdrawn", lv?.wealth ? money(lv.wealth.ownerWithdrawn) : "—"],
    ["Fleet-generated realised wealth", lv?.wealth ? money(lv.wealth.fleetGenerated) : t ? minor(t.lifetimeContributionMinor) : "—"],
    ["Operating pool", t ? minor(t.operatingPoolMinor) : "—"],
    ["Outstanding envelopes", t ? minor(t.outstandingEnvelopesMinor) : "—"],
    ["Revenue (24 h)", lv?.flows24h ? money(lv.flows24h.revenue) : "—"],
    ["Spend (24 h)", lv?.flows24h ? money(lv.flows24h.spend) : "—"],
    ["Profit contributed (24 h)", lv?.flows24h ? money(lv.flows24h.profitContributed) : "—"],
  ];
  const flows = Object.entries((t?.flows30d ?? {}) as Record<string, unknown>);
  return <>
    <dl className="grid gap-3 sm:grid-cols-3">{cells.map(([k, v]) => <div key={k} className="rounded-lg border border-slate-700 p-3"><dt className="text-xs text-slate-400">{k}</dt><dd className="mt-1 font-mono">{v}</dd></div>)}</dl>
    <h4 className="mt-5 text-sm font-semibold">Treasury flows, last 30 days</h4>
    {flows.length ? <ul className="mt-2 space-y-1 text-sm">{flows.map(([k, v]) => <li key={k} className="flex justify-between gap-4"><span>{words(k)}</span><span className="font-mono">{minor(v)}</span></li>)}</ul> : <p className="mt-2 text-sm text-slate-400">No Treasury movements in the last 30 days.</p>}
  </>;
}

export function DecisionFeed({ view, models, onOpenAgent, compact = false }: { view: CommandView | null; models: AgentModel[]; onOpenAgent?: (id: string) => void; compact?: boolean }) {
  const [q, setQ] = useState(""), [kind, setKind] = useState("all");
  const name = useMemo(() => new Map(models.map((m) => [m.agent.id, m.agent.name])), [models]);
  if (!view) return <p className="text-sm text-slate-400">Reading decisions from the Fleet…</p>;
  type D = { key: string; at: string; kind: string; agentId: string | null; title: string; facts: Array<[string, string]>; reasons: string[]; source: string };
  const capital: D[] = view.capital.map((c, i) => ({ key: `cap:${i}:${String(c.at)}`, at: String(c.at ?? ""), kind: "capital", agentId: c.agentId ?? null,
    title: `Capital request ${minor(c.amountMinor)} → ${String(c.outcome ?? "—")}${c.approvedMinor != null ? ` (${minor(c.approvedMinor)} approved)` : ""}`,
    facts: [["purpose", String(c.purpose ?? "—")], ["venture", String(c.venture ?? "—")], ["expected net", minor(c.expectedNetMinor)], ["confidence", c.confidenceBp != null ? `${Number(c.confidenceBp) / 100} %` : "—"], ["evidence items", String(c.evidenceItems ?? "—")], ["policy version", String(c.policyVersion ?? "—")],
      ...factsOf(c.inputs as Row | null, 6).map(([k, v]) => [`input: ${k}`, v] as [string, string])],
    reasons: [...(Array.isArray(c.reasons) ? c.reasons.map(String) : []), ...(Array.isArray(c.wouldChange) ? c.wouldChange.map((w: unknown) => `Would change: ${String(w)}`) : [])], source: "hub capital" }));
  // Venture decision records (the agent's recorded choices and their measured outcomes).
  const ventureDecisions: D[] = view.ventures.flatMap((v) => (Array.isArray(v.decisions) ? v.decisions : []).map((x: Row, i: number) => ({
    key: `vd:${String(v.key)}:${String(x.key ?? i)}:${String(x.revision ?? "")}`, at: String(x.createdAt ?? x.measuredAt ?? ""), kind: "venture", agentId: v.agentId ?? null,
    title: `${String(v.key ?? "venture")}: ${String(x.purpose ?? x.question ?? "decision")}${x.selected ? ` → ${typeof x.selected === "object" ? JSON.stringify(x.selected).slice(0, 60) : String(x.selected)}` : ""}`,
    facts: [["outcome", x.outcome ? (typeof x.outcome === "object" ? JSON.stringify(x.outcome).slice(0, 80) : String(x.outcome)) : "pending"], ["confidence", x.confidenceBp != null ? `${Number(x.confidenceBp) / 100} %` : "—"], ["next action", String(x.nextAction ?? "—")]],
    reasons: Array.isArray(x.lessons) ? x.lessons.map(String) : [], source: "venture decision record" })));
  const fromEvents: D[] = view.events.filter((e) => isDecision(e.type) && e.type !== "capital_decision").map((e) => ({ key: e.key, at: e.at, agentId: e.agentId,
    kind: e.type.startsWith("replication_") || e.type.startsWith("birth_") ? "replication" : e.type.startsWith("mission_") ? "mission" : e.type.startsWith("estate_") ? "estate" : e.type.endsWith("_policy_set") ? "policy" : e.type.startsWith("agent_hold") ? "intervention" : "other",
    title: words(e.type), facts: [["actor", e.actor ?? "—"], ...factsOf(e.detail)], reasons: Array.isArray(e.detail.reasons) ? e.detail.reasons.map(String) : [], source: "events" }));
  const all = [...capital, ...ventureDecisions, ...fromEvents].filter((d) => (kind === "all" || d.kind === kind) && (!q || `${d.title} ${name.get(d.agentId ?? "") ?? ""} ${d.facts.map((f) => f.join(" ")).join(" ")}`.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, compact ? 6 : 200);
  return <>
    {!compact && <div className="mb-4 grid gap-3 sm:grid-cols-2"><label className="text-sm">Search decisions<input className={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Agent, purpose, outcome" /></label>
      <label className="text-sm">Kind<select className={input} value={kind} onChange={(e) => setKind(e.target.value)}>{["all", "capital", "venture", "mission", "replication", "intervention", "estate", "policy", "other"].map((k) => <option key={k}>{k}</option>)}</select></label></div>}
    {all.length === 0 && <p className="text-sm text-slate-400">No recorded decisions{kind !== "all" || q ? " match" : " yet"}.</p>}
    <ol className="space-y-3">{all.map((d) => <li key={d.key} className="rounded-lg border border-slate-700 p-3">
      <p className="text-xs text-slate-400">{time(d.at)} · {d.kind.toUpperCase()} · source: {d.source}{d.agentId ? <> · {onOpenAgent ? <button className="text-cyan-300 underline" onClick={() => onOpenAgent(d.agentId!)}>{name.get(d.agentId) ?? d.agentId}</button> : name.get(d.agentId) ?? d.agentId}</> : null}</p>
      <p className="mt-1">{d.title}</p>
      {!compact && d.facts.length > 0 && <dl className="mt-2 grid gap-x-4 text-xs text-slate-300 sm:grid-cols-2">{d.facts.map(([k, v]) => <div key={k} className="flex justify-between gap-2"><dt className="text-slate-500">{k}</dt><dd>{v}</dd></div>)}</dl>}
      {!compact && d.reasons.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs text-slate-300">{d.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
    </li>)}</ol>
    {!compact && <p className="mt-3 text-xs text-slate-400">Stored decision records and reasons only. Model reasoning is never recorded or shown.</p>}
  </>;
}

export function EventFeed({ events, models, onOpenAgent, limit = 100, filterable = true }: { events: readonly FleetEvent[]; models: AgentModel[]; onOpenAgent?: (id: string) => void; limit?: number; filterable?: boolean }) {
  const [q, setQ] = useState("");
  const name = useMemo(() => new Map(models.map((m) => [m.agent.id, m.agent.name])), [models]);
  const shown = (q ? events.filter((e) => `${e.type} ${name.get(e.agentId ?? "") ?? ""} ${e.actor ?? ""}`.toLowerCase().includes(q.toLowerCase())) : events).slice(0, limit);
  return <>
    {filterable && <label className="mb-3 block text-sm">Filter events<input className={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type, agent or actor" /></label>}
    {shown.length === 0 && <p className="text-sm text-slate-400">No events{q ? " match" : " recorded yet"}.</p>}
    <ol className="max-h-[32rem] space-y-2 overflow-y-auto pr-1">{shown.map((e) => <li key={e.key} className="border-l-2 border-cyan-900 pl-3 text-sm">
      <p className="text-xs text-slate-400">{time(e.at)} · {e.actor ?? "—"}{e.agentId ? <> · {onOpenAgent ? <button className="text-cyan-300 underline" onClick={() => onOpenAgent(e.agentId!)}>{name.get(e.agentId) ?? e.agentId}</button> : name.get(e.agentId) ?? e.agentId}</> : null}</p>
      <p>{words(e.type)}{factsOf(e.detail, 3).map(([k, v]) => ` · ${k}: ${v}`).join("")}</p>
    </li>)}</ol>
  </>;
}

const PRIORITY_TEXT: Record<EventPriority, string> = { P0_CRITICAL: "Critical", P1_HIGH: "High", P2_IMPORTANT: "Important", P3_SUMMARY: "Summary",
  AUDIT_ONLY: "Audit", AGENT_ACTIVITY_ONLY: "Activity" };
const PRIORITY_TONE: Record<EventPriority, string> = { P0_CRITICAL: "border-red-500 text-red-200", P1_HIGH: "border-amber-500 text-amber-200",
  P2_IMPORTANT: "border-cyan-600 text-cyan-200", P3_SUMMARY: "border-slate-600 text-slate-300", AUDIT_ONLY: "border-slate-700 text-slate-400", AGENT_ACTIVITY_ONLY: "border-slate-700 text-slate-400" };
/** Plain-language titles for the events Fleet Command shows (others read as words). */
const EVENT_TEXT: Record<string, string> = {
  agent_died: "Agent died", agent_orphaned: "Agent orphaned", agent_quarantined: "Agent quarantined", agent_born: "Agent born", agent_activated: "Agent activated",
  agent_hold_set: "Agent held by the Admin", agent_hold_released: "Agent hold released", agent_unresponsive: "Agent unresponsive", agent_recovered: "Agent recovered",
  runtime_verification_failed: "Runtime verification failed", economy_failsafe: "Economy failsafe engaged", spend_circuit_breaker_set: "Security breaker changed",
  mission_started: "Mission started", mission_ended: "Mission ended", mission_requested: "Mission requested", capital_requested: "Capital request submitted",
  capital_decision: "Capital request decided", treasury_sweep: "Treasury sweep", wallet_transfer: "Treasury transfer", agent_transfer: "Agent transfer",
  admin_withdrawal_requested: "Owner withdrawal requested", runtime_approved: "Production release approved", founder_runtime_upgrade_verified: "Agent runtime upgraded",
  cap_set: "Population cap changed", venture_created: "Venture launched", venture_state: "Venture state changed", notification: "Notification",
  replication_requested: "Replication requested", replication_granted: "Replication granted", replication_rejected: "Replication rejected",
  birth_ordered: "Birth ordered", birth_authorized: "Birth authorised", estate_opened: "Estate opened", estate_settled: "Estate settled",
};
export const eventTitle = (e: FleetEvent) => EVENT_TEXT[e.type] ?? words(e.type).replace(/^./, (c) => c.toUpperCase());

/**
 * Fleet Command's feed (V2.4.3): only what FleetController's router (schema v44) classes P0–P3 — never sessions,
 * logins, ledger postings or notification housekeeping — grouped Critical → High → Important → Summary, newest first in
 * each. Readable titles and a few stored facts; no raw payload. `events` null: the gateway has no router (older schema).
 */
export function CommandFeed({ events, raw, models, onOpenAgent, limit = 100, live = true }: { events: readonly FleetEvent[] | null; raw: readonly FleetEvent[];
  models: AgentModel[]; onOpenAgent?: (id: string) => void; limit?: number; live?: boolean }) {
  const name = useMemo(() => new Map(models.map((m) => [m.agent.id, m.agent.name])), [models]);
  if (events === null) return <>{live && <p className="mb-2 text-xs text-amber-200">Event routing is not available from this Fleet gateway: showing the raw event stream.</p>}
    <EventFeed events={raw} models={models} onOpenAgent={onOpenAgent} limit={limit} filterable={false} /></>;
  const all = PRIORITY_ORDER.map((p) => [p, events.filter((e) => e.priority === p).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))] as const).filter(([, xs]) => xs.length);
  // The display limit is spent in priority order (critical first), computed before rendering.
  const groups = all.map(([p, xs], i) => { const before = all.slice(0, i).reduce((n, [, ys]) => n + ys.length, 0); return [p, xs, xs.slice(0, Math.max(0, limit - before))] as const; });
  if (!groups.length) return <p className="text-sm text-slate-400">No operational events. Routine activity, sign-ins and housekeeping are kept in the audit and Agent activity records.</p>;
  return <div className="max-h-[32rem] space-y-4 overflow-y-auto pr-1">{groups.map(([p, xs, shown]) => {
    return shown.length ? <section key={p} aria-label={`${PRIORITY_TEXT[p]} events`}>
      <h4 className={`mb-1 border-l-2 pl-2 text-xs font-semibold uppercase tracking-widest ${PRIORITY_TONE[p]}`}>{PRIORITY_TEXT[p]} · {xs.length}</h4>
      <ol className="space-y-2">{shown.map((e) => <li key={e.key} className={`border-l-2 pl-3 text-sm ${PRIORITY_TONE[p].split(" ")[0]}`}>
        <p className="text-xs text-slate-400">{time(e.at)}{e.agentId ? <> · {onOpenAgent ? <button className="text-cyan-300 underline" onClick={() => onOpenAgent(e.agentId!)}>{name.get(e.agentId) ?? e.agentId}</button> : name.get(e.agentId) ?? e.agentId}</> : null}</p>
        <p>{e.type === "notification" ? codeText(typeof e.detail.code === "string" ? e.detail.code : undefined) : eventTitle(e)}{factsOf(e.type === "notification" ? null : e.detail, 3).map(([k, v]) => ` · ${k}: ${v}`).join("")}</p>
      </li>)}</ol></section> : null;
  })}</div>;
}

export function DepartmentRoster({ models, dep, onOpen }: { models: AgentModel[]; dep: keyof typeof DEPARTMENT; onOpen: (id: string) => void }) {
  const here = models.filter((m) => m.placement.department === dep);
  return here.length ? <ul className="space-y-3">{here.map((m) => <li key={m.agent.id}><AgentRow m={m} onOpen={onOpen} /></li>)}</ul> : <p className="text-sm text-slate-400">No agents here right now.</p>;
}
