/**
 * The specialist crew (owner, 2026-10-16) — pure and unit-tested: which visual specialist a REAL helper job wakes, and
 * the state of every specialist desk at a moment.
 *
 * Backend reality (unchanged): agents have no persistent crew. Real helper activity is one of
 *   · routine     — `routine_task`: one bounded chore on the cheap T1 tier (task class: extraction, page_interpretation…)
 *   · escalation  — `escalate_question`: one question to the critical T3 tier (the advisor)
 *   · review      — `independent_review`: a separate model call reviewing a deliverable (known once the review is filed)
 *   · inspection  — the deterministic QA inspector run when a deliverable review is filed (software, no model)
 *   · fleet_review — Fleet Control's automated spend review (paid by the treasury)
 * read through the gateway's `helpers` operation. Each job carries the PURPOSE the agent recorded for it (research,
 * marketing, production, customer support, quality review, decision, evidence check, spend review, inspection) and its
 * recorded state (running, finished, failed, or ended without a result). The desk role comes ONLY from that recorded
 * purpose — never guessed from where the agent is; a job without one (an agent on an older runtime) wakes no desk and is
 * counted honestly instead. Specialists are a DISPLAY of those jobs: a desk wakes only while a job of its role is in flight, and stays lit for a short display linger after the job finished (a completed real job, said
 * so on the desk). An asleep specialist is a picture, never a running or chargeable model session; nothing here polls
 * beyond the Command Centre's normal pulse. Specialists are not agents: no wallet, no level, no bunk, no station, never
 * in the living-agent roster or any agent count.
 */
import type { AgentModel } from "./agents";
import type { DepartmentId } from "./departments";
import { agentLabel } from "../naming";

export type HelperKind = "routine" | "escalation" | "review" | "inspection" | "fleet_review";
export type HelperTier = "T1" | "T2" | "T3";
/** What the agent recorded the job was for (null: not recorded — an agent on an older runtime, or a purpose this display does not know). */
export type HelperPurpose = "research" | "marketing" | "production" | "customer_support" | "quality_review" | "decision" | "evidence_check" | "spend_review" | "inspection";
/** The recorded state: "ended" = the call's reservation ended without a recorded result. */
export type HelperState = "running" | "finished" | "failed" | "ended";

/** One helper job as the `helpers` read returns it (times ISO, recorded start and end; finishedAt null + "running" = in flight). */
export interface HelperJob {
  id: string; agentId: string; kind: HelperKind; taskClass: string | null; tier: HelperTier | null;
  purpose: HelperPurpose | null; state: HelperState;
  startedAt: string | null; finishedAt: string | null; knownAt: string; outcome: string | null;
}
export interface HelperToday {
  routine: number; escalation: number; review: number; inspection: number; fleetReview: number;
  /** Routine chores today whose purpose was not recorded (agents still on an older runtime). */
  unrecorded: number;
}
/** The `helpers` read (newest first, ≤ 200 jobs from the last windowS seconds plus any in flight), as received. */
export interface HelperRead {
  asOf: string; windowS: number; jobs: HelperJob[]; today: HelperToday;
  /** When this browser received the answer (ms) — server times are read relative to `asOf` from here (clock skew). */
  receivedAt: number;
  /** Simulation builds only: fictional jobs from the operator's simulated commands. */
  simulated?: boolean;
}

export type HelperRole = "researcher" | "marketer" | "producer" | "support" | "reviewer" | "advisor";
export const HELPER_ROLES: readonly HelperRole[] = Object.freeze(["researcher", "marketer", "producer", "support", "reviewer", "advisor"]);
/** Where each role's desks are: researchers in Library / Research, reviewers and the critical-tier advisor in Fleet Command. */
export const ROLE_DEPARTMENT: Readonly<Record<HelperRole, DepartmentId>> = Object.freeze({
  researcher: "library", marketer: "marketing", producer: "venture", support: "comms", reviewer: "command", advisor: "command",
});
export const ROLE_NAME: Readonly<Record<HelperRole, string>> = Object.freeze({
  researcher: "Researcher", marketer: "Marketer", producer: "Producer", support: "Support", reviewer: "Reviewer", advisor: "Critical advisor",
});
/** Each role's uniform stripe and lit screen (the advisor — the Opus tier — in gold). */
export const ROLE_COLOUR: Readonly<Record<HelperRole, string>> = Object.freeze({
  researcher: "#60a5fa", marketer: "#f472b6", producer: "#34d399", support: "#2dd4bf", reviewer: "#38bdf8", advisor: "#fbbf24",
});

/** The desk role of each recorded purpose. */
export const PURPOSE_ROLE: Readonly<Record<HelperPurpose, HelperRole>> = Object.freeze({
  research: "researcher", marketing: "marketer", production: "producer", customer_support: "support",
  quality_review: "reviewer", evidence_check: "reviewer", spend_review: "reviewer", inspection: "reviewer", decision: "advisor",
});

/**
 * The specialist role a job wakes — ONLY from the purpose the agent recorded for it (PURPOSE_ROLE). null: no recorded
 * purpose (an agent on an older runtime, or a purpose this display does not know) — nothing wakes, nothing is guessed.
 */
export function helperRole(job: Pick<HelperJob, "purpose">): HelperRole | null {
  const p = job.purpose;
  return p && Object.prototype.hasOwnProperty.call(PURPOSE_ROLE, p) ? PURPOSE_ROLE[p] : null;
}

/** How many desks each role has: one per living agent, at least 2 and at most 4. */
export const deskCount = (living: number) => Math.max(2, Math.min(4, Math.floor(Number.isFinite(living) ? living : 0)));
/** How long a desk stays lit after its job finished (a display persistence of a real completed job). */
export const HELPER_LINGER_MS = 25_000;
/** A read older than this (by this browser's clock) no longer describes the desks: nothing wakes from it. */
export const HELPER_STALE_MS = 60_000;

const KINDS: ReadonlySet<string> = new Set(["routine", "escalation", "review", "inspection", "fleet_review"]);
const TIERS: ReadonlySet<string> = new Set(["T1", "T2", "T3"]);
const PURPOSES: ReadonlySet<string> = new Set(Object.keys(PURPOSE_ROLE));
const STATES: ReadonlySet<string> = new Set(["running", "finished", "failed", "ended"]);
const iso = (v: unknown): string | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null);
const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/**
 * The `helpers` answer, checked field by field; malformed jobs are dropped (never repaired), null when unusable.
 * An older gateway without purpose / state / today.unrecorded: purpose null (wakes no desk), state from finishedAt
 * ("running" while null, else "finished"), unrecorded 0. An unknown purpose is treated as not recorded (never guessed).
 */
export function toHelperRead(x: unknown, receivedAt: number): HelperRead | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>, asOf = iso(r.asOf);
  if (!asOf || !Array.isArray(r.jobs)) return null;
  const jobs: HelperJob[] = [];
  for (const j of r.jobs.slice(0, 200) as unknown[]) {
    if (!j || typeof j !== "object") continue;
    const o = j as Record<string, unknown>, knownAt = iso(o.knownAt);
    if (typeof o.id !== "string" || !o.id || typeof o.agentId !== "string" || !o.agentId || typeof o.kind !== "string" || !KINDS.has(o.kind) || !knownAt) continue;
    const finishedAt = iso(o.finishedAt);
    jobs.push({ id: o.id, agentId: o.agentId, kind: o.kind as HelperKind, taskClass: typeof o.taskClass === "string" ? o.taskClass : null,
      tier: typeof o.tier === "string" && TIERS.has(o.tier) ? (o.tier as HelperTier) : null,
      purpose: typeof o.purpose === "string" && PURPOSES.has(o.purpose) ? (o.purpose as HelperPurpose) : null,
      state: typeof o.state === "string" && STATES.has(o.state) ? (o.state as HelperState) : finishedAt ? "finished" : "running",
      startedAt: iso(o.startedAt), finishedAt, knownAt, outcome: typeof o.outcome === "string" ? o.outcome : null });
  }
  const t = (r.today && typeof r.today === "object" ? r.today : {}) as Record<string, unknown>;
  return { asOf, windowS: typeof r.windowS === "number" && r.windowS > 0 ? r.windowS : 600, jobs, receivedAt,
    today: { routine: count(t.routine), escalation: count(t.escalation), review: count(t.review), inspection: count(t.inspection), fleetReview: count(t.fleetReview), unrecorded: count(t.unrecorded) } };
}

/** "page_interpretation" → "page interpretation" (an unknown class is shown as the backend named it, made readable). */
export const taskWords = (c: string | null) => (c ? c.replace(/[_-]+/g, " ").trim().toLowerCase() : "");

const CHORE: Readonly<Partial<Record<HelperPurpose, string>>> = Object.freeze({ research: "Research", marketing: "Marketing", production: "Production", customer_support: "Customer-support" });

/** What the desk shows, in plain words, from the recorded purpose: "Research chore (page interpretation) for Agent-1". */
export function jobText(job: Pick<HelperJob, "purpose" | "taskClass">, agent: string): string {
  const p = job.purpose && PURPOSES.has(job.purpose) ? job.purpose : null, cls = taskWords(job.taskClass);
  switch (p) {
    case "decision": return `Critical question for ${agent}`;
    case "quality_review": return `Reviewing a deliverable for ${agent}`;
    case "evidence_check": return `Checking cited evidence for ${agent} (Fleet Control)`;
    case "spend_review": return `Spend review for ${agent} (Fleet Control)`;
    case "inspection": return `Inspecting a deliverable for ${agent} (automated check)`;
    case null: return `Helper job${cls ? ` (${cls})` : ""} for ${agent} — purpose not recorded`;
    default: return `${CHORE[p]} chore${cls ? ` (${cls})` : ""} for ${agent}`;
  }
}

/** A job a desk is showing, with its times on this browser's clock. */
export interface DeskJob {
  id: string; kind: HelperKind; agentId: string; agentName: string; text: string; tier: HelperTier | null;
  /** When it started (ms, this browser's clock); null when the backend does not know (only known after the fact). */
  startedAt: number | null;
  /** In flight, or a job over (finished, failed, or ended without a result) still on the desk for the linger (until `until`). */
  phase: DeskPhase; finishedAt: number | null; until: number | null;
}
export type DeskPhase = "working" | "finished" | "failed" | "ended";
/** How an over job is said on a desk: "finished", "failed", "ended without a result". */
export const DONE_WORDS: Readonly<Record<Exclude<DeskPhase, "working">, string>> = Object.freeze({ finished: "finished", failed: "failed", ended: "ended without a result" });
export interface CrewDesk { key: string; role: HelperRole; seat: number; department: DepartmentId; job: DeskJob | null }
export interface Crew {
  /** "live": from the read · "unavailable": no read (older gateway, a failure) · "stale": the last read is too old. */
  status: "live" | "unavailable" | "stale";
  simulated: boolean;
  desks: CrewDesk[];
  /** Jobs in progress beyond a role's desks (shown as a number, never dropped silently). */
  overflow: Partial<Record<HelperRole, number>>;
  today: HelperToday | null;
  working: number; asleep: number;
  /** Jobs in flight or within the linger that wake no desk because no purpose was recorded (older agent runtime). */
  unrecorded: number;
}

const hashOf = (s: string) => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);

/**
 * Every specialist desk at `now` (this browser's clock). Pure: the same read, agents and time → the same crew.
 *   · a job is shown while in flight (finishedAt null), or for HELPER_LINGER_MS after it finished; a review / inspection
 *     is shown from knownAt for the linger (it is only known after the fact, when the agent files the review);
 *   · nothing older than the read's window is shown; a read older than HELPER_STALE_MS wakes nothing;
 *   · each role's jobs (oldest first, then id) take a free desk, preferring one derived from the job id — so concurrent
 *     jobs wake several specialists of that role and a job keeps its desk while older jobs keep theirs.
 */
export function crewOf(read: HelperRead | null | undefined, models: readonly AgentModel[], now: number): Crew {
  const living = models.filter((m) => m.agent.status !== "dead").length, n = deskCount(living);
  const desks: CrewDesk[] = HELPER_ROLES.flatMap((role) => Array.from({ length: n }, (_, i) => ({ key: `${role}:${i + 1}`, role, seat: i + 1, department: ROLE_DEPARTMENT[role], job: null as DeskJob | null })));
  const base = { simulated: !!read?.simulated, desks, overflow: {}, today: read?.today ?? null, working: 0, asleep: desks.length, unrecorded: 0 };
  if (!read) return { ...base, status: "unavailable" };
  if (now - read.receivedAt > HELPER_STALE_MS) return { ...base, status: "stale" };
  // Server times → this browser's clock: the server's "now" was asOf when the answer arrived.
  const skew = read.receivedAt - Date.parse(read.asOf), local = (s: string | null) => (s ? Date.parse(s) + skew : null);
  const windowMs = read.windowS * 1000, byId = new Map(models.map((m) => [m.agent.id, m]));
  const active = new Map<HelperRole, DeskJob[]>();
  let unrecorded = 0;
  for (const j of read.jobs) {
    const started = local(j.startedAt), known = local(j.knownAt)!;
    // A job the backend recorded as over without an end time is over from when it became known.
    const finished = local(j.finishedAt) ?? (j.state !== "running" ? known : null);
    // A review / inspection is only known once the agent files the deliverable review (knownAt, often after the model
    // call finished): it is shown from knownAt for the linger, whatever its start and finish times were.
    const afterTheFact = j.kind === "review" || j.kind === "inspection";
    const end = afterTheFact ? Math.max(known, finished ?? known) : finished;
    if (end !== null && (now - end > HELPER_LINGER_MS || now - end > windowMs)) continue; // over and past the linger
    if (end === null && started !== null && started > now + 60_000) continue; // a start in the future is not believed
    const role = helperRole(j);
    if (!role) { unrecorded++; continue; } // no recorded purpose: no desk is guessed, the job is counted instead
    const m = byId.get(j.agentId);
    const agentName = m?.agent.name ?? agentLabel({ name: null }, `an agent (${j.agentId.slice(0, 6)}…)`);
    const phase: DeskPhase = end === null ? "working" : j.state === "failed" || j.state === "ended" ? j.state : "finished";
    const job: DeskJob = { id: j.id, kind: j.kind, agentId: j.agentId, agentName, text: jobText(j, agentName), tier: j.tier, startedAt: started,
      phase, finishedAt: end, until: end === null ? null : end + HELPER_LINGER_MS };
    (active.get(role) ?? active.set(role, []).get(role)!).push(job);
  }
  const overflow: Partial<Record<HelperRole, number>> = {};
  let working = 0;
  for (const [role, jobs] of active) {
    jobs.sort((a, b) => (a.startedAt ?? a.finishedAt ?? 0) - (b.startedAt ?? b.finishedAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const mine = desks.filter((d) => d.role === role);
    for (const job of jobs) {
      const free = mine.filter((d) => !d.job);
      if (!free.length) { overflow[role] = (overflow[role] ?? 0) + 1; continue; }
      const start = hashOf(job.id) % mine.length;
      const desk = [...mine.slice(start), ...mine.slice(0, start)].find((d) => !d.job)!;
      desk.job = job; working++;
    }
  }
  return { ...base, status: "live", overflow, working, asleep: desks.length - working, unrecorded };
}

export const todayTotal = (t: HelperToday | null) => (t ? t.routine + t.escalation + t.review + t.inspection + t.fleetReview : 0);

/** "1 helper job without a recorded purpose (agent on an older runtime)" — null when there is none. */
export const unrecordedLine = (n: number) => (n > 0 ? `${n} helper job${n === 1 ? "" : "s"} without a recorded purpose (agent on an older runtime)` : null);

/**
 * The honest one-line summary: "Helpers: 1 working · 9 asleep · 14 helper jobs today" (or why there is none). The
 * Fleet-wide summary and Fleet Command's add the running / lingering jobs that wake no desk for want of a recorded purpose.
 */
export function crewSummary(c: Crew, dep?: DepartmentId): string {
  const desks = dep ? c.desks.filter((d) => d.department === dep) : c.desks;
  if (c.status === "unavailable") return "Helpers: helper activity unavailable — every specialist shown asleep";
  if (c.status === "stale") return "Helpers: helper activity not current (feed interrupted) — every specialist shown asleep";
  const w = desks.filter((d) => d.job).length, more = Object.entries(c.overflow).filter(([r]) => !dep || ROLE_DEPARTMENT[r as HelperRole] === dep).reduce((s, [, v]) => s + (v ?? 0), 0);
  const total = todayTotal(c.today);
  const none = !dep || dep === "command" ? unrecordedLine(c.unrecorded) : null;
  return `Helpers${c.simulated ? " (simulated)" : ""}: ${w} working${more ? ` (+${more} more in progress)` : ""} · ${desks.length - w} asleep · ${total} helper job${total === 1 ? "" : "s"} today${none ? ` · ${none}` : ""}`;
}

/** The Fleet-wide today line, with the routine chores whose purpose was not recorded. */
export function todayLine(t: HelperToday): string {
  return `Today, Fleet-wide: ${t.routine} routine chores${t.unrecorded ? ` (${t.unrecorded} without a recorded purpose — agent on an older runtime)` : ""} · ${t.escalation} critical questions · ${t.review} reviews · ${t.inspection} inspections · ${t.fleetReview} spend reviews (${todayTotal(t)} in all).`;
}

/** A timer for a desk: "42 s", "3 m 05 s", "1 h 02 m" (null start → "—"). */
export function elapsed(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.floor(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h ? `${h} h ${String(m % 60).padStart(2, "0")} m` : m ? `${m} m ${String(s % 60).padStart(2, "0")} s` : `${s} s`;
}

/** The desk's status line at `now`: "Working · Research chore (page interpretation) for Agent-1 · 42 s", "Finished 6 s ago · …", "Failed …", "Ended without a result …", "Asleep". */
export function deskLine(d: CrewDesk, now: number): string {
  const j = d.job;
  if (!j) return "Asleep — no job";
  if (j.phase === "working") return `Working · ${j.text} · ${j.startedAt !== null ? elapsed(now - j.startedAt) : "start not recorded"}`;
  const w = DONE_WORDS[j.phase];
  return `${w[0].toUpperCase()}${w.slice(1)} ${elapsed(now - (j.finishedAt ?? now))} ago · ${j.text}${j.phase !== "ended" && j.startedAt !== null && j.finishedAt !== null ? ` · took ${elapsed(j.finishedAt - j.startedAt)}` : ""}`;
}

/** A change signature: the crew re-renders only when a desk's job or phase (or the read's status) changes. */
export const crewSignature = (c: Crew) => `${c.status}|${c.simulated}|${c.desks.length}|${todayTotal(c.today)}|${c.today?.unrecorded ?? 0}|${c.unrecorded}|${JSON.stringify(c.overflow)}|` + c.desks.map((d) => (d.job ? `${d.key}=${d.job.id}:${d.job.phase}` : "")).join(",");
