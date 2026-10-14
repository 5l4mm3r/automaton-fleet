/**
 * The Fleet headquarters: departments, their place in the facility, and the DETERMINISTIC mapping from an agent's real
 * state to the department it occupies. Shared by the 3D scene, the 2D map and the Formal Agents list, so "where an agent
 * is" and "what it is doing" never differ between views. Nothing here moves an agent: only a change in FleetController's
 * state or a new event from it does.
 *
 * Where an agent is (first rule that applies):
 *   1. dead                      → Estate (its assets and data are inventoried there)
 *   2. provisioning              → Agent Floor (arriving)
 *   3. held by the Admin         → Agent Floor (HELD)
 *   3a. asleep — the OWNER'S PAUSE (FleetController's cognition switch) → Quarters, "PAUSED BY OWNER"; a hibernation the
 *      agent REPORTED → Quarters, "HIBERNATING". Two different states, never inferred: only the reading's own fields.
 *   4. an active temporary mission (the `agents` read's mode): MARKETING → Marketing, OPPORTUNITY_HUNT → Opportunity Lab,
 *      KNOWLEDGE_DATA → Library / Research   (simulation builds: the fictional role, mapped the same way)
 *   5. its most recent own event in the last ACTIVITY_WINDOW_MS, by event type (EVENT_DEPARTMENT)
 *   6. otherwise                 → Agent Floor (OPERATING)
 * An unknown mode or event type falls through to the next rule; it never throws.
 */

export type DepartmentId = "command" | "treasury" | "opportunity" | "floor" | "marketing" | "library" | "venture" | "identity" | "estate" | "comms" | "security" | "quarters";

export interface Department {
  id: DepartmentId;
  name: string;
  /** Centre on the facility floor plan (world units; x → east, z → south). */
  x: number;
  z: number;
  w: number;
  d: number;
  /** One-line purpose shown on the room and in its panel. */
  purpose: string;
  /** Restrained accent (hex) used by both renderers. */
  accent: string;
  /** Where the free floor (people's spots) begins, measured from the back wall (default 3.2 m). */
  slotTop?: number;
}

/**
 * The headquarters floor plan (world units ≈ metres), approved by the owner 2026-10-13: FLEET COMMAND IS THE HUB at the
 * centre of the complex — every department is one corridor away from it, and information between departments passes
 * through it (route.ts). Three columns (x = −21, 0, 21) and four rows with 4 m corridors between them; the hub opens on
 * every side (north and south openings, side doors onto both spines).
 *
 *   Opportunity Lab   ·   Library            ·   Marketing
 *   Treasury          ·   FLEET COMMAND      ·   Venture / Dev
 *   Identity          ·   Agent Floor        ·   Comms
 *   Quarters          ·   Estate (+ Hall)    ·   Security / Systems
 *
 * Room sizes leave space for up to 50 adult-scale operators and their furniture (the Agent Floor: 50 workstations;
 * Quarters: 50 bunks).
 */
export const DEPARTMENTS: readonly Department[] = Object.freeze([
  { id: "opportunity", name: "Opportunity Lab", x: -21, z: -26, w: 16, d: 10, purpose: "Opportunity hunting and signals under investigation", accent: "#a78bfa", slotTop: 3.8 },
  { id: "library", name: "Library / Research", x: 0, z: -26, w: 18, d: 10, purpose: "Research missions and the Fleet's knowledge", accent: "#60a5fa" },
  { id: "marketing", name: "Marketing", x: 21, z: -26, w: 16, d: 10, purpose: "Marketing missions and campaigns", accent: "#f472b6" },
  { id: "treasury", name: "Treasury", x: -21, z: -11, w: 16, d: 12, purpose: "Treasury cash, flows, allocations and contributions", accent: "#fbbf24" },
  { id: "command", name: "Fleet Command", x: 0, z: -11, w: 18, d: 12, purpose: "FleetController: the hub — decisions, policy and the control plane", accent: "#38bdf8", slotTop: 8.0 },
  { id: "venture", name: "Venture / Dev", x: 21, z: -11, w: 16, d: 12, purpose: "Ventures being built, launched and operated", accent: "#34d399" },
  { id: "identity", name: "Identity", x: -21, z: 7, w: 16, d: 16, purpose: "Agent identities and accounts (metadata only)", accent: "#c084fc" },
  { id: "floor", name: "Agent Floor", x: 0, z: 7, w: 18, d: 16, purpose: "Agents operating their businesses", accent: "#22d3ee" },
  { id: "comms", name: "Comms", x: 21, z: 7, w: 16, d: 16, purpose: "Mail and SMS capability", accent: "#2dd4bf" },
  { id: "quarters", name: "Quarters", x: -21, z: 25, w: 16, d: 12, purpose: "Rest: a bunk for every living agent; paused and hibernating agents sleep here", accent: "#818cf8", slotTop: 2.0 },
  { id: "estate", name: "Estate Storage", x: 0, z: 25, w: 18, d: 12, purpose: "Assets and data of agents that died — and the Hall of Survivors", accent: "#94a3b8" },
  { id: "security", name: "Security / Systems", x: 21, z: 25, w: 16, d: 12, purpose: "Health, alerts, runtime and capability state", accent: "#f87171" },
]);

export const DEPARTMENT: Readonly<Record<DepartmentId, Department>> = Object.freeze(Object.fromEntries(DEPARTMENTS.map((d) => [d.id, d])) as Record<DepartmentId, Department>);

/** How long an agent's last event keeps it in that event's department (then it returns to the Agent Floor). */
export const ACTIVITY_WINDOW_MS = 6 * 60 * 60 * 1000;

const MODE_DEPARTMENT: Readonly<Record<string, DepartmentId>> = Object.freeze({
  MARKETING: "marketing", OPPORTUNITY_HUNT: "opportunity", KNOWLEDGE_DATA: "library",
  // Simulation roles (fictional builds use the same rooms).
  RESEARCH: "library", "OPPORTUNITY HUNT": "opportunity", OPERATIONS: "venture", COMMUNICATIONS: "comms",
});

/** Event type → department, by exact name or prefix (first match). Covers FleetController's event vocabulary. */
const EVENT_RULES: ReadonlyArray<[RegExp, DepartmentId]> = [
  [/^(venture_|experiment_|decision_(recorded|measured|corrected)|project_)/, "venture"],
  [/^opportunity_/, "opportunity"],
  [/^knowledge_/, "library"],
  [/^(identity_|account_|agent_identity_created|browser_credential_|credential_|agent_credential_revoked|agent_account_credentials_revoked)/, "identity"],
  [/^(mail_|comms_|phone_|sms_)/, "comms"],
  [/^(settlement|wallet_transfer|agent_transfer|treasury_sweep|envelope|payment_order_|commitment_|ledger_journal_posted)/, "treasury"],
  [/^(estate_|agent_died)/, "estate"],
  [/^(health_challenge_|runtime_verification_failed|scope_denied|authorization_denied|db_auth_failed|economy_failsafe|spend_circuit_breaker_set|agent_quarantined|agent_unresponsive)/, "security"],
  [/^(capital_|mission_requested|owner_request_|external_dependency_recorded|capability_dependency|replication_|birth_|genesis_|agent_born|provisioning_)/, "command"],
];

export function eventDepartment(type: string): DepartmentId | null {
  for (const [re, dep] of EVENT_RULES) if (re.test(type)) return dep;
  return null;
}

/** The short activity word shown above an agent and in lists. */
export const ACTIVITY: Readonly<Record<DepartmentId, string>> = Object.freeze({
  command: "AT FLEET COMMAND", treasury: "SETTLING", opportunity: "OPPORTUNITY HUNT", floor: "OPERATING", marketing: "MARKETING",
  library: "RESEARCHING", venture: "BUILDING", identity: "IDENTITY SETUP", estate: "DEAD", comms: "COMMUNICATING", security: "SECURITY CHECK",
  quarters: "RESTING",
});

/** Why an agent sleeps (from the reading itself; null = awake or not reported). The owner's pause outranks a hibernation. */
export type SleepState = "owner_pause" | "hibernating";
export const SLEEP_ACTIVITY: Readonly<Record<SleepState, string>> = Object.freeze({ owner_pause: "PAUSED BY OWNER", hibernating: "HIBERNATING" });

export interface Placement {
  department: DepartmentId;
  activity: string;
  /** Which rule placed the agent (for the panel's "why here"). */
  basis: "dead" | "provisioning" | "held" | "sleep" | "mission" | "event" | "default";
  /** Since when the agent has been doing this (ms), when the reading shows it; null = not known (shown as —, never guessed). */
  since?: number | null;
}

export interface PlaceableAgent {
  id: string;
  status: string;
  /** LIVE: the `agents` read's mode (NORMAL or the mission). Simulation: its fictional role. */
  mode?: string | null;
  role?: string;
  /** The owner's pause or a fresh reported hibernation (command/rest.ts), and when it began (ms; null = not known). */
  sleep?: SleepState | null;
  sleepSince?: number | null;
  /** When the active mission started and when the hold began (ms; null = not known). */
  missionSince?: number | null;
  heldSince?: number | null;
}

export interface AgentEventLike {
  at: string;
  type: string;
  agentId: string | null;
  /** Set by activityByAgent: when the agent's current run of events in this event's department began (ms). */
  runStart?: number;
}

/** Latest event per agent (events may arrive in any order). */
export function latestEventByAgent(events: readonly AgentEventLike[]): Map<string, AgentEventLike> {
  const out = new Map<string, AgentEventLike>();
  for (const e of events) {
    if (!e.agentId) continue;
    const prev = out.get(e.agentId);
    if (!prev || Date.parse(e.at) > Date.parse(prev.at)) out.set(e.agentId, e);
  }
  return out;
}

/**
 * Latest event per agent, carrying when the activity it shows BEGAN: the earliest of the unbroken run of that agent's
 * events in the same department, each within ACTIVITY_WINDOW_MS of the next (a longer gap means the agent was back on the
 * Floor in between; an event of another department, or of none, ends the run).
 */
export function activityByAgent(events: readonly AgentEventLike[]): Map<string, AgentEventLike> {
  const by = new Map<string, Array<{ e: AgentEventLike; t: number }>>();
  for (const e of events) {
    const t = Date.parse(e.at);
    if (!e.agentId || !Number.isFinite(t)) continue;
    const xs = by.get(e.agentId) ?? []; xs.push({ e, t }); by.set(e.agentId, xs);
  }
  const out = new Map<string, AgentEventLike>();
  for (const [id, xs] of by) {
    xs.sort((a, b) => b.t - a.t);
    const dep = eventDepartment(xs[0].e.type);
    let start = xs[0].t;
    for (let i = 1; dep && i < xs.length && eventDepartment(xs[i].e.type) === dep && start - xs[i].t <= ACTIVITY_WINDOW_MS; i++) start = xs[i].t;
    out.set(id, { ...xs[0].e, runStart: start });
  }
  return out;
}

export function placeAgent(a: PlaceableAgent, latest: AgentEventLike | undefined, now: number = Date.now()): Placement {
  if (a.status === "dead" || a.status === "failed") return { department: "estate", activity: ACTIVITY.estate, basis: "dead" };
  if (a.status === "provisioning") return { department: "floor", activity: "PROVISIONING", basis: "provisioning" };
  if (a.status === "held") return { department: "floor", activity: "HELD", basis: "held", since: a.heldSince ?? null };
  if (a.sleep === "owner_pause" || a.sleep === "hibernating") return { department: "quarters", activity: SLEEP_ACTIVITY[a.sleep], basis: "sleep", since: a.sleepSince ?? null };
  const key = String(a.mode ?? a.role ?? "").trim().toUpperCase();
  const byMode = MODE_DEPARTMENT[key] ?? MODE_DEPARTMENT[key.replace(/ /g, "_")] ?? MODE_DEPARTMENT[key.replace(/_/g, " ")];
  if (byMode) return { department: byMode, activity: ACTIVITY[byMode], basis: "mission", since: a.missionSince ?? null };
  if (latest) {
    const t = Date.parse(latest.at);
    const dep = eventDepartment(latest.type);
    if (dep && dep !== "estate" && Number.isFinite(t) && now - t <= ACTIVITY_WINDOW_MS && t <= now + 60_000) {
      return { department: dep, activity: ACTIVITY[dep], basis: "event", since: latest.runStart != null && latest.runStart <= t ? latest.runStart : t };
    }
  }
  // The Agent Floor is the default when no recorded activity is current: no transition marks it, so its time is unknown.
  return { department: "floor", activity: ACTIVITY.floor, basis: "default", since: null };
}

// ── Levels (display only) ────────────────────────────────────────────────────────────────────────────────────────
// A level is how long an agent has survived: Lv = whole days alive + 1 (Lv 1 on its first day). It DISPLAYS real elapsed
// time only — no unlock, permission, economic or state effect anywhere. Unknown creation time → null (shown —).
export const DAY_MS = 86_400_000;
export function levelOf(createdAt: string | null | undefined, until: number = Date.now()): number | null {
  const t = createdAt ? Date.parse(createdAt) : NaN;
  if (!Number.isFinite(t) || !Number.isFinite(until) || until < t) return null;
  return Math.floor((until - t) / DAY_MS) + 1;
}
/** Fleet Command's level: days since the Fleet's first agent was created + 1 (null without any creation time). */
export function fleetLevel(agents: ReadonlyArray<{ createdAt?: string | null }>, now: number = Date.now()): number | null {
  const ts = agents.map((a) => (a.createdAt ? Date.parse(a.createdAt) : NaN)).filter(Number.isFinite);
  return ts.length ? levelOf(new Date(Math.min(...ts)).toISOString(), now) : null;
}
/** A duration for people: "3d 4h", "5h 12m", "42m" — or "—" when unknown. */
export function span(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const m = Math.floor(ms / 60_000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d > 0 ? `${d}d ${h % 24}h` : h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

/**
 * The i-th of `count` agents' spot inside a department (deterministic: same agents in the same order → same places).
 * Spacing adapts to how many share the room — 1.6 m apart when there is space, tighter (never under 0.6) when the
 * room is crowded — so up to 50 agents stay inside the room without stacking on one another.
 */
export function slot(dep: DepartmentId, index: number, count = 1): { x: number; z: number } {
  const d = DEPARTMENT[dep];
  const top = d.slotTop ?? 3.2, w = d.w - 2.4, h = Math.max(0.5, d.d - top - 1.0); // clear of the back-wall equipment and side furniture
  // Adult-scale people: 1.6 m apart when there is space, never closer than 0.6 m.
  let s = 1.6;
  const fits = (sp: number) => (Math.floor(w / sp) + 1) * (Math.floor(h / sp) + 1) >= count;
  while (s > 0.6 && !fits(s)) s -= 0.05;
  const cols = Math.max(1, Math.floor(w / s) + 1), rows = Math.max(1, Math.floor(h / s) + 1);
  const col = index % cols, row = Math.floor(index / cols);
  // Centre the grid in the free floor.
  const used = Math.min(cols, Math.max(1, count)) - 1, x0 = d.x - (used * s) / 2;
  return { x: x0 + col * s, z: d.z - d.d / 2 + top + (row % rows) * s + Math.floor(row / rows) * (s / 2) };
}
