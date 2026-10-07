/**
 * Event normalisation: FleetController's events (the `events` read: at, type, agentId, actor, detail) and the
 * differences between two authoritative agent readings become VISUAL events — what the Virtual Command Centre animates
 * and what the Fleet Command feeds list. Presentation only: nothing here writes, and every visual event points at a
 * real event or a real state change. Unknown event types are kept in the feeds but are not animated.
 */
import { DEPARTMENT, type DepartmentId } from "./departments";
import type { HealthBand } from "./economics";

export type VisualKind =
  | "AGENT_STATE_CHANGED" | "AGENT_MOVED_DEPARTMENT" | "AGENT_WALLET_CHANGED" | "AGENT_HEALTH_CHANGED" | "AGENT_PROFIT_STATE_CHANGED"
  | "CAPITAL_REQUEST_CREATED" | "CAPITAL_REQUEST_DECIDED" | "TREASURY_TRANSFER" | "REVENUE_EVENT" | "EXPENSE_EVENT"
  | "MISSION_STARTED" | "MISSION_COMPLETED" | "RESEARCH_EVENT" | "OPPORTUNITY_EVENT" | "MARKETING_EVENT" | "VENTURE_EVENT"
  | "IDENTITY_EVENT" | "COMMS_EVENT" | "DEPENDENCY_EVENT" | "AGENT_DIED" | "ESTATE_TRANSFER" | "AGENT_BORN" | "REPLICATION_EVENT"
  | "SYSTEM_ALERT" | "CAPABILITY_CHANGED" | "PROJECT_EVENT";

/** A stop on a flow: a department, the agent's own position, or the outside world (customers, providers). */
/** A stop on an information route: a department, the event's agent, the other agent of a two-agent event, the outside. */
export type FlowStop = DepartmentId | "agent" | "counterpart" | "external";

export interface FleetEvent {
  /** Stable identity for de-duplication (the gateway's rows carry no id). */
  key: string;
  at: string;
  type: string;
  agentId: string | null;
  actor: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- gateway JSON, narrowed where used
  detail: Record<string, any>;
  /** Fleet Command priority from FleetController's router (schema v44), when read through `command_events`. */
  priority?: EventPriority;
}

/** FleetController's event classes (fleet_event_route, schema v44). Only P0–P3 ever reach Fleet Command. */
export type EventPriority = "P0_CRITICAL" | "P1_HIGH" | "P2_IMPORTANT" | "P3_SUMMARY" | "AUDIT_ONLY" | "AGENT_ACTIVITY_ONLY";
export const PRIORITY_ORDER: readonly EventPriority[] = ["P0_CRITICAL", "P1_HIGH", "P2_IMPORTANT", "P3_SUMMARY"];

export interface VisualEvent {
  id: string;
  kind: VisualKind;
  at: string;
  agentId: string | null;
  /** The other agent of a two-agent event (a team project's lead and member), when the event records one. */
  counterpartId?: string | null;
  /** The route information travels (empty: nothing travels, e.g. a state change shown on the agent). */
  path: FlowStop[];
  label: string;
  /** The real event (or "state:<agent>") this visual event stands for. */
  source: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- gateway JSON
export function toFleetEvent(row: Record<string, any>): FleetEvent | null {
  if (!row || typeof row.type !== "string" || typeof row.at !== "string") return null;
  const agentId = typeof row.agentId === "string" ? row.agentId : null, actor = typeof row.actor === "string" ? row.actor : null;
  return { key: `${row.at}|${row.type}|${agentId ?? ""}|${actor ?? ""}`, at: row.at, type: row.type, agentId, actor,
    detail: row.detail && typeof row.detail === "object" ? row.detail : {},
    ...(typeof row.priority === "string" && (PRIORITY_ORDER as readonly string[]).includes(row.priority) ? { priority: row.priority as EventPriority } : {}) };
}

/** Merge newly read events into the kept list: de-duplicated, newest first, bounded (long-running sessions stay small). */
export function mergeEvents(kept: readonly FleetEvent[], incoming: readonly FleetEvent[], cap = 400): FleetEvent[] {
  const seen = new Set(kept.map((e) => e.key));
  const fresh = incoming.filter((e) => !seen.has(e.key) && seen.add(e.key));
  return [...fresh, ...kept].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, cap);
}

const words = (s: string) => s.replace(/_/g, " ");
const ok = (d: Record<string, unknown>) => {
  const o = String(d.outcome ?? d.decision ?? d.status ?? "").toLowerCase();
  return o.startsWith("approv") || o === "granted" || o === "partial" || o === "funded";
};

type Rule = [RegExp, (e: FleetEvent) => Omit<VisualEvent, "id" | "at" | "agentId" | "source"> | null];
const RULES: Rule[] = [
  [/^capital_requested$/, () => ({ kind: "CAPITAL_REQUEST_CREATED", path: ["agent", "command"], label: "Capital request" })],
  [/^capital_decision$/, (e) => ({ kind: "CAPITAL_REQUEST_DECIDED", path: ok(e.detail) ? ["command", "treasury", "agent"] : ["command", "agent"],
    label: `Capital decision: ${String(e.detail.outcome ?? e.detail.decision ?? "decided")}` })],
  [/^(settlement_|venture_attribution|experiment_revenue_attributed)/, (e) => (e.type === "settlement_failed" || e.type === "settlement_conflict"
    ? { kind: "SYSTEM_ALERT", path: ["treasury", "security"], label: words(e.type) }
    : { kind: "REVENUE_EVENT", path: ["external", "venture", "agent"], label: "Revenue settled" })],
  [/^treasury_sweep$/, () => ({ kind: "TREASURY_TRANSFER", path: ["agent", "treasury"], label: "Profit contribution to the Treasury" })],
  [/^genesis_funded$/, () => ({ kind: "TREASURY_TRANSFER", path: ["treasury", "agent"], label: "Genesis capital" })],
  [/^(wallet_transfer|agent_transfer)$/, (e) => ({ kind: "TREASURY_TRANSFER",
    path: String(e.detail.to ?? e.detail.target ?? "") === "treasury" ? ["agent", "treasury"] : ["treasury", "agent"], label: "Transfer" })],
  [/^(payment_order_settled|commitment_added|provider_cost_reconciled|provider_credits_recorded)$/, (e) => ({ kind: "EXPENSE_EVENT", path: ["agent", "external"], label: words(e.type) })],
  [/^mission_started$/, (e) => {
    const k = String(e.detail.kind ?? e.detail.missionKind ?? "").toLowerCase();
    return { kind: k.includes("market") ? "MARKETING_EVENT" : "MISSION_STARTED", path: ["command", "agent"], label: `Mission started${k ? `: ${words(k)}` : ""}` };
  }],
  [/^mission_ended$/, () => ({ kind: "MISSION_COMPLETED", path: ["agent", "command"], label: "Mission completed" })],
  [/^mission_requested$/, () => ({ kind: "MISSION_STARTED", path: ["command"], label: "Mission requested" })],
  [/^knowledge_/, () => ({ kind: "RESEARCH_EVENT", path: ["library", "agent", "command"], label: "Research recorded" })],
  [/^opportunity_/, (e) => ({ kind: "OPPORTUNITY_EVENT", path: ["opportunity", "agent"], label: words(e.type) })],
  // Team projects: two-agent events travel between the two agents (fromAgentId → toAgentId as recorded); the others are
  // the project's own record in Venture / Dev.
  [/^project_/, (e) => ({ kind: "PROJECT_EVENT", label: PROJECT_LABEL[e.type] ?? words(e.type),
    path: typeof e.detail.fromAgentId === "string" && typeof e.detail.toAgentId === "string"
      ? (e.detail.fromAgentId === e.agentId ? ["agent", "counterpart"] : ["counterpart", "agent"])
      : ["agent", "venture"] })],
  [/^(venture_|decision_(recorded|measured|corrected)|experiment_)/, (e) => ({ kind: "VENTURE_EVENT", path: ["agent", "venture"], label: words(e.type) })],
  [/^agent_died$/, () => ({ kind: "AGENT_DIED", path: ["agent", "estate"], label: "Agent died" })],
  [/^estate_/, (e) => ({ kind: "ESTATE_TRANSFER", path: ["agent", "estate"], label: words(e.type) })],
  [/^(agent_born|genesis_activated)$/, () => ({ kind: "AGENT_BORN", path: ["command", "floor"], label: "Agent born" })],
  [/^(replication_|birth_)/, (e) => ({ kind: "REPLICATION_EVENT", path: ["command"], label: words(e.type) })],
  [/^(identity_|account_|agent_identity_created|browser_credential_|agent_credential_revoked)/, (e) => ({ kind: "IDENTITY_EVENT", path: ["agent", "identity"], label: words(e.type) })],
  [/^(mail_|comms_provider|phone_)/, (e) => ({ kind: "COMMS_EVENT", path: ["comms"], label: words(e.type) })],
  [/^(owner_request_|external_dependency_recorded|capability_dependency)/, (e) => ({ kind: "DEPENDENCY_EVENT", path: ["agent", "command"], label: words(e.type) })],
  [/^(economy_failsafe|health_challenge_failed|runtime_verification_failed|agent_quarantined|agent_unresponsive|scope_denied|authorization_denied|spend_circuit_breaker_set)$/,
    (e) => ({ kind: "SYSTEM_ALERT", path: ["security", "command"], label: words(e.type) })],
  [/^notification$/, (e) => (String(e.detail.class ?? "") === "RED" ? { kind: "SYSTEM_ALERT", path: ["security", "command"], label: String(e.detail.title ?? "RED alert") } : null)],
  [/_policy_set$|^(cognition_|comms_provider_registered|economy_policy_set)/, (e) => ({ kind: "CAPABILITY_CHANGED", path: ["command"], label: words(e.type) })],
  [/^agent_hold_(set|released)$/, (e) => ({ kind: "AGENT_STATE_CHANGED", path: ["command", "agent"], label: e.type === "agent_hold_set" ? "Held by the Admin" : "Hold released" })],
];

const PROJECT_LABEL: Readonly<Record<string, string>> = {
  project_created: "Project created", project_started: "Project started", project_funded: "Project funded", project_replanned: "Project replanned",
  project_member_offered: "Team offer", project_member_joined: "Team member joined", project_member_declined: "Offer declined", project_member_countered: "Counter-offer",
  project_offer_withdrawn: "Offer withdrawn", project_task_started: "Task started", project_task_delivered: "Task delivered", project_task_accepted: "Delivery accepted",
  project_task_rejected: "Delivery rejected", project_payment: "Project payment", project_member_exited: "Member exited", project_member_removed: "Member replaced",
  project_completed: "Project completed", project_cancelled: "Project cancelled", project_profit_distribution: "Profit distribution",
  project_distribution_pending: "Distribution pending", project_assessment: "Project assessment",
};

/** One FleetController event → its visual event (null: listed in feeds, not animated). */
export function visualFromEvent(e: FleetEvent): VisualEvent | null {
  for (const [re, make] of RULES) {
    if (!re.test(e.type)) continue;
    const v = make(e);
    if (!v) return null;
    // A route through "agent" needs an agent; without one the information goes to Fleet Command instead.
    const from = typeof e.detail.fromAgentId === "string" ? e.detail.fromAgentId : null, to = typeof e.detail.toAgentId === "string" ? e.detail.toAgentId : null;
    const counterpartId = from && to ? (from === e.agentId ? to : from) : null;
    const path = (e.agentId ? v.path : v.path.map((s) => (s === "agent" ? "command" : s))).filter((s) => s !== "counterpart" || counterpartId).filter((s, i, a) => i === 0 || a[i - 1] !== s);
    return { ...v, path, id: `ev:${e.key}`, at: e.at, agentId: e.agentId, counterpartId, source: e.type };
  }
  return null;
}

/** Decisions for the Decision Log: FleetController's and the Admin's recorded decisions (stored reasons only). */
export const DECISION_TYPES = /^(capital_decision|replication_(granted|rejected|birth_ordered)|owner_request_decided|identity_claim_decided|operator_proposal_(approved|rejected|expired)|birth_(authorized|cancelled)|agent_hold_(set|released)|mission_(started|ended)|estate_item_(reassigned|released)|decision_(recorded|corrected)|experiment_relevance_(assessed|overridden)|[a-z_]+_policy_set)$/;
export const isDecision = (type: string) => DECISION_TYPES.test(type);

export interface AgentReading {
  id: string;
  status: string;
  cash: number;
  department: DepartmentId;
  band: HealthBand;
}

/** Visual events implied by two consecutive authoritative readings of the agents (births, deaths, moves, wallet, health). */
export function diffReadings(before: readonly AgentReading[], after: readonly AgentReading[], at: string): VisualEvent[] {
  const prev = new Map(before.map((a) => [a.id, a]));
  const out: VisualEvent[] = [];
  const add = (kind: VisualKind, a: AgentReading, label: string, path: FlowStop[] = []) =>
    out.push({ id: `state:${a.id}:${kind}:${at}`, kind, at, agentId: a.id, path, label, source: `state:${a.id}` });
  for (const a of after) {
    const p = prev.get(a.id);
    if (!p) { if (before.length) add("AGENT_BORN", a, "Agent joined the Fleet", ["command", "floor"]); continue; }
    if (p.status !== a.status) {
      if (a.status === "dead") add("AGENT_DIED", a, "Agent died", ["agent", "estate"]);
      else add("AGENT_STATE_CHANGED", a, `${p.status} → ${a.status}`);
    }
    if (p.department !== a.department) add("AGENT_MOVED_DEPARTMENT", a, `${DEPARTMENT[p.department]?.name ?? p.department} → ${DEPARTMENT[a.department]?.name ?? a.department}`);
    if (p.cash !== a.cash) add("AGENT_WALLET_CHANGED", a, a.cash > p.cash ? "Wallet up" : "Wallet down");
    if (p.band !== a.band) add(p.band === "WINNING" || a.band === "WINNING" ? "AGENT_PROFIT_STATE_CHANGED" : "AGENT_HEALTH_CHANGED", a, `${p.band} → ${a.band}`);
  }
  return out;
}
