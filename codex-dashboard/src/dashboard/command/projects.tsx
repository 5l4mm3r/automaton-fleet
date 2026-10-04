/**
 * Team projects (schema v42): an agent recruits other existing living agents into a venture project by internal
 * contract. These views show FleetController's own project records (the `projects` read) — the lead, each member's
 * role, scope, compensation and contribution status, the planner's ETAs (solo, team, projected; realised time saved only
 * once completed), budget, expected value, the task graph and the project's recent events. Nothing is estimated here:
 * a figure the record does not carry reads "—".
 */
import type { AgentModel } from "./agents";
import type { CommandView, Row } from "./view";
import { money } from "../model";

const DASH = "—";
const minor = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? money(v) : typeof v === "string" && /^-?\d+$/.test(v) ? money(Number(v)) : DASH);
const words = (s: unknown) => String(s ?? "").replace(/_/g, " ");
/** Hours → "38 h" or "4.5 days" (planner hours are working hours; a day here is 8 h). */
export function hours(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return DASH;
  return v >= 24 ? `${Math.round((v / 8) * 10) / 10} days` : `${Math.round(v * 10) / 10} h`;
}

/**
 * What a compensation agreement says, in words — the exact negotiated terms (nothing derived, no default ratio). A
 * profit share is a share of the POST-SWEEP distributable profit: the Treasury sweep comes first, then distribution.
 */
export function compensationText(c: Row | null | undefined): string {
  if (!c || !c.type) return DASH;
  const parts: string[] = [];
  const bp = c.profitShareBp ?? c.revenueShareBp, cap = c.profitShareCapMinor ?? c.revenueShareCapMinor;
  if (c.fixedMinor != null) parts.push(`${minor(c.fixedMinor)} fixed`);
  if (bp != null) parts.push(`${Number(bp) / 100} % of post-sweep distributable profit${cap != null ? ` (cap ${minor(cap)})` : ""}`);
  if (Array.isArray(c.milestones) && c.milestones.length) parts.push(`milestones ${c.milestones.map((m: Row) => `${words(m.key)} ${minor(m.amountMinor)}`).join(", ")}`);
  return `${words(c.type).toLowerCase()}${parts.length ? ` — ${parts.join(" + ")}` : ""}`;
}

/** Projects an agent leads or is (or was) contracted into. */
export const projectsOf = (view: CommandView | null, agentId: string): Row[] =>
  (view?.projects ?? []).filter((p) => p.leadAgentId === agentId || (Array.isArray(p.members) && p.members.some((m: Row) => m.agentId === agentId)));

/** The agents actively working on a project together (lead + accepted members), for the HQ's team placement. */
export function activeTeams(view: CommandView | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of view?.projects ?? []) {
    if (p.status !== "active") continue;
    const team = [String(p.leadAgentId), ...(Array.isArray(p.members) ? p.members.filter((m: Row) => m.status === "accepted").map((m: Row) => String(m.agentId)) : [])];
    if (team.length < 2) continue;
    for (const id of team) if (!out.has(id)) out.set(id, String(p.projectId));
  }
  return out;
}

const STATUS_TONE: Record<string, string> = { active: "text-emerald-300", planning: "text-sky-300", completed: "text-slate-300", cancelled: "text-slate-500" };

export function ProjectCard({ p, models, onOpenAgent, compact = false }: { p: Row; models: AgentModel[]; onOpenAgent?: (id: string) => void; compact?: boolean }) {
  const name = (id: unknown) => models.find((m) => m.agent.id === id)?.agent.name ?? (id ? String(id) : DASH);
  const eta = (p.eta ?? {}) as Row, econ = (p.economics ?? {}) as Row, dist = (p.distribution ?? null) as Row | null;
  const members = Array.isArray(p.members) ? (p.members as Row[]) : [], tasks = Array.isArray(p.tasks) ? (p.tasks as Row[]) : [];
  const agent = (id: unknown) => onOpenAgent && id ? <button className="text-cyan-300 underline" onClick={() => onOpenAgent(String(id))}>{name(id)}</button> : <>{name(id)}</>;
  const figures: Array<[string, string]> = [
    ["ETA solo", hours(eta.soloHours)], ["ETA team", hours(eta.teamHours)],
    [p.status === "completed" ? "Realised time saved" : "Projected time saved", p.status === "completed" ? hours(eta.realisedTimeSavedHours) : hours(eta.plannedTimeSavedHours)],
    ["Projected remaining", p.status === "active" ? hours(eta.projectedRemainingHours) : DASH],
    ["Budget", minor(econ.budgetMinor)], ["Expected value", minor(econ.expectedValueMinor)],
    ["Fixed / milestone paid", minor(econ.paidMinor)], ["Funding", words(econ.fundingSource) || DASH],
  ];
  return <article className="rounded-lg border border-slate-700 bg-slate-950/40 p-3 text-sm" aria-label={`Project ${String(p.name ?? p.projectKey)}`}>
    <header className="flex flex-wrap items-baseline justify-between gap-2">
      <h4 className="font-semibold text-slate-100">PROJECT: {String(p.name ?? p.projectKey ?? DASH)}</h4>
      <span className={`font-mono text-xs tracking-widest ${STATUS_TONE[String(p.status)] ?? "text-slate-300"}`}>STATUS: {words(p.stage ?? p.status).toUpperCase()}</span>
    </header>
    <p className="mt-1 text-slate-400">LEAD: {agent(p.leadAgentId)} · TEAM: {String(p.teamSize ?? members.filter((m) => m.status === "accepted").length + 1)}{p.ventureKey ? ` · venture ${String(p.ventureKey)}` : ""}</p>
    {p.objective && !compact && <p className="mt-1 text-slate-300">{String(p.objective)}</p>}
    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">{figures.map(([k, v]) => <div key={k} className="min-w-0"><dt className="text-xs text-slate-500">{k}</dt><dd className="font-mono">{v}</dd></div>)}</dl>
    {!compact && <>
      <h5 className="mt-3 text-xs uppercase tracking-widest text-slate-500">Team and contracts</h5>
      {members.length ? <ul className="mt-1 space-y-1">{members.map((m) => <li key={String(m.memberId ?? m.agentId)} className="rounded border border-slate-800 p-2">
        {agent(m.agentId)} · <span className="text-slate-300">{words(m.role)}</span>{m.taskScope ? ` — ${String(m.taskScope)}` : ""}
        <span className="block text-xs text-slate-400">{compensationText(m.compensation as Row)} · contract {words(m.status)} · contribution {words(m.contributionStatus) || DASH} · earned {minor(m.earnedMinor)} · paid {minor(m.paidMinor)}{m.profitSharePaidMinor != null || m.profitShareOwedMinor != null ? ` · profit share paid ${minor(m.profitSharePaidMinor)}, owed ${minor(m.profitShareOwedMinor)}` : ""}</span>
      </li>)}</ul> : <p className="mt-1 text-slate-400">No members contracted yet.</p>}
      {Array.isArray(econ.gate) && econ.gate.length > 0 && <><h5 className="mt-3 text-xs uppercase tracking-widest text-slate-500">Why a team (the lead&apos;s recorded reasoning and forecast)</h5>
        <ul className="mt-1 list-disc pl-5 text-slate-300">{(econ.gate as unknown[]).slice(0, 4).map((g, i) => <li key={i}>{String(g)}</li>)}</ul></>}
      {dist && Array.isArray(dist.memberShares) && dist.memberShares.length > 0 && <><h5 className="mt-3 text-xs uppercase tracking-widest text-slate-500">Profit distribution (after the Treasury sweep)</h5>
        <p className="mt-1 text-slate-300">Negotiated shares of the post-sweep pool: {dist.memberShares.map((x: Row) => `${name(x.agentId)} ${Number(x.shareBp) / 100} %`).join(" · ")} · lead {name(p.leadAgentId)} {Number(dist.leadShareBp ?? 0) / 100} % · distributed {minor(dist.distributedMinor)}</p>
        {Array.isArray(dist.tranches) && dist.tranches.slice(-3).map((t: Row, i: number) => <p key={i} className="text-xs text-slate-400">profit {minor(t.profitMinor)} → Treasury sweep {minor(t.sweepAttributedMinor)} ({Number(t.sweepRateBp) / 100} %) → distributable {minor(t.distributableMinor)} · lead residual {minor(t.leadResidualMinor)}</p>)}</>}
      {econ.forecast && <><h5 className="mt-3 text-xs uppercase tracking-widest text-slate-500">The lead&apos;s forecast (to be compared with what is realised)</h5>
        <p className="mt-1 text-xs text-slate-400">{Object.entries(econ.forecast as Row).filter(([, v]) => typeof v !== "object").slice(0, 6).map(([k, v]) => `${words(k)}: ${typeof v === "number" && /Minor$/.test(k) ? minor(v) : String(v)}`).join(" · ")}</p></>}
      {tasks.length > 0 && <><h5 className="mt-3 text-xs uppercase tracking-widest text-slate-500">Tasks (dependency graph)</h5>
        <ol className="mt-1 space-y-1">{tasks.map((t) => <li key={String(t.key)} className="flex flex-wrap justify-between gap-2 border-b border-slate-800 pb-1">
          <span>{String(t.title ?? t.key)} <span className="text-xs text-slate-500">· {words(t.ownerRole)}{t.assigneeAgentId ? ` (${name(t.assigneeAgentId)})` : ""}{Array.isArray(t.deps) && t.deps.length ? ` · after ${t.deps.join(", ")}` : ""}</span></span>
          <span className="font-mono text-xs">{hours(t.hours)} · {words(t.status)}{typeof t.progressBp === "number" ? ` ${Math.round(t.progressBp / 100)} %` : ""}</span>
        </li>)}</ol></>}
    </>}
  </article>;
}

/** Fleet Command's view: active cross-agent projects, team size, status and planned time saved. */
export function ProjectsOverview({ view, models, onOpenAgent }: { view: CommandView | null; models: AgentModel[]; onOpenAgent?: (id: string) => void }) {
  const s = view?.projectSummary, list = view?.projects ?? [];
  if (view?.unavailable.includes("projects")) return <p className="text-sm text-slate-400">Team projects could not be read.</p>;
  return <div className="space-y-3">
    {s && <p className="text-sm text-slate-300">{String(s.active ?? 0)} active · {String(s.planning ?? 0)} planning · {String(s.completed ?? 0)} completed · {String(s.agentsCollaborating ?? 0)} agents collaborating · planned time saved {hours(s.plannedTimeSavedHours)}</p>}
    {list.length ? list.filter((p) => p.status === "active" || p.status === "planning").map((p) => <ProjectCard key={String(p.projectId)} p={p} models={models} onOpenAgent={onOpenAgent} compact />)
      : <p className="text-sm text-slate-400">No team projects. Agents recruit other agents only when the collaboration is economically justified.</p>}
  </div>;
}
