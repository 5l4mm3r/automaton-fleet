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
 *   4. an active temporary mission (the `agents` read's mode): MARKETING → Marketing, OPPORTUNITY_HUNT → Opportunity Lab,
 *      KNOWLEDGE_DATA → Library / Research   (simulation builds: the fictional role, mapped the same way)
 *   5. its most recent own event in the last ACTIVITY_WINDOW_MS, by event type (EVENT_DEPARTMENT)
 *   6. otherwise                 → Agent Floor (OPERATING)
 * An unknown mode or event type falls through to the next rule; it never throws.
 */

export type DepartmentId = "command" | "treasury" | "opportunity" | "floor" | "marketing" | "library" | "venture" | "identity" | "estate" | "comms" | "security";

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
 * The headquarters floor plan (world units ≈ metres): a connected complex — rooms on a grid with 3 m corridors between
 * them, Fleet Command at the head of the central spine, Security / Systems at its foot. Room sizes leave space for up to
 * 50 adult-scale operators and their furniture.
 */
export const DEPARTMENTS: readonly Department[] = Object.freeze([
  { id: "command", name: "Fleet Command", x: 0, z: -30, w: 18, d: 10, purpose: "FleetController: decisions, policy and the control plane", accent: "#38bdf8", slotTop: 8.0 },
  { id: "treasury", name: "Treasury", x: -18, z: -17, w: 14, d: 10, purpose: "Treasury cash, flows, allocations and contributions", accent: "#fbbf24" },
  { id: "opportunity", name: "Opportunity Lab", x: 18, z: -17, w: 14, d: 10, purpose: "Opportunity hunting and signals under investigation", accent: "#a78bfa", slotTop: 3.8 },
  { id: "floor", name: "Agent Floor", x: 0, z: -4, w: 18, d: 14, purpose: "Agents operating their businesses", accent: "#22d3ee" },
  { id: "marketing", name: "Marketing", x: -18, z: 11, w: 14, d: 10, purpose: "Marketing missions and campaigns", accent: "#f472b6" },
  { id: "library", name: "Library / Research", x: 0, z: 11, w: 16, d: 10, purpose: "Research missions and the Fleet's knowledge", accent: "#60a5fa" },
  { id: "venture", name: "Venture / Dev", x: 18, z: 11, w: 14, d: 10, purpose: "Ventures being built, launched and operated", accent: "#34d399" },
  { id: "identity", name: "Identity", x: -18, z: 24, w: 14, d: 10, purpose: "Agent identities and accounts (metadata only)", accent: "#c084fc" },
  { id: "estate", name: "Estate Storage", x: 0, z: 24, w: 16, d: 10, purpose: "Assets and data of agents that died", accent: "#94a3b8" },
  { id: "comms", name: "Comms", x: 18, z: 24, w: 14, d: 10, purpose: "Mail and SMS capability", accent: "#2dd4bf" },
  { id: "security", name: "Security / Systems", x: 0, z: 37, w: 18, d: 9, purpose: "Health, alerts, runtime and capability state", accent: "#f87171" },
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
});

export interface Placement {
  department: DepartmentId;
  activity: string;
  /** Which rule placed the agent (for the panel's "why here"). */
  basis: "dead" | "provisioning" | "held" | "mission" | "event" | "default";
}

export interface PlaceableAgent {
  id: string;
  status: string;
  /** LIVE: the `agents` read's mode (NORMAL or the mission). Simulation: its fictional role. */
  mode?: string | null;
  role?: string;
}

export interface AgentEventLike {
  at: string;
  type: string;
  agentId: string | null;
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

export function placeAgent(a: PlaceableAgent, latest: AgentEventLike | undefined, now: number = Date.now()): Placement {
  if (a.status === "dead" || a.status === "failed") return { department: "estate", activity: ACTIVITY.estate, basis: "dead" };
  if (a.status === "provisioning") return { department: "floor", activity: "PROVISIONING", basis: "provisioning" };
  if (a.status === "held") return { department: "floor", activity: "HELD", basis: "held" };
  const key = String(a.mode ?? a.role ?? "").trim().toUpperCase();
  const byMode = MODE_DEPARTMENT[key] ?? MODE_DEPARTMENT[key.replace(/ /g, "_")] ?? MODE_DEPARTMENT[key.replace(/_/g, " ")];
  if (byMode) return { department: byMode, activity: ACTIVITY[byMode], basis: "mission" };
  if (latest) {
    const t = Date.parse(latest.at);
    const dep = eventDepartment(latest.type);
    if (dep && dep !== "estate" && Number.isFinite(t) && now - t <= ACTIVITY_WINDOW_MS && t <= now + 60_000) {
      return { department: dep, activity: ACTIVITY[dep], basis: "event" };
    }
  }
  return { department: "floor", activity: ACTIVITY.floor, basis: "default" };
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
