/**
 * The Virtual Command Centre's world state — shared by the 3D scene and the 2D map. Pure: given the derived agents and
 * the visual events, where each agent should stand and which information packets are travelling. Renderers only
 * interpolate towards these targets; they never decide anything themselves.
 */
import type { AgentModel } from "../command/agents";
import { DEPARTMENT, DEPARTMENTS, slot, type DepartmentId } from "../command/departments";
import type { FlowStop, VisualEvent } from "../command/events";
import { INTAKE } from "./hq/route";

export interface Point { x: number; z: number }

/** The facility's bounds (world units) — the 2D map's viewBox and the 3D camera's "Fleet view". */
export const WORLD = Object.freeze({ minX: -27, maxX: 27, minZ: -37, maxZ: 43 });
/** Where outside information (customers, providers) enters the facility: its east gate. */
export const EXTERNAL: Point = Object.freeze({ x: 29, z: -4 });

/** Each agent's target spot: its department, then a deterministic slot by order of id within that department. */
export function agentTargets(models: readonly AgentModel[]): Map<string, Point & { department: DepartmentId }> {
  const byDep = new Map<DepartmentId, AgentModel[]>();
  for (const m of models) (byDep.get(m.placement.department) ?? byDep.set(m.placement.department, []).get(m.placement.department)!).push(m);
  const out = new Map<string, Point & { department: DepartmentId }>();
  for (const [dep, list] of byDep) {
    [...list].sort((a, b) => a.agent.id.localeCompare(b.agent.id)).forEach((m, i) => out.set(m.agent.id, { ...slot(dep, i, list.length), department: dep }));
  }
  return out;
}

export function stopPoint(stop: FlowStop, agentId: string | null, agents: ReadonlyMap<string, Point>, counterpartId: string | null = null): Point | null {
  if (stop === "external") return EXTERNAL;
  if (stop === "agent") return agentId ? agents.get(agentId) ?? null : null;
  if (stop === "counterpart") return counterpartId ? agents.get(counterpartId) ?? null : null;
  // A department's information arrives at (and leaves from) its intake at the end of the room's conduit.
  return INTAKE[stop] ?? null;
}

export interface Packet {
  id: string;
  kind: VisualEvent["kind"];
  points: Point[];
  start: number;
  duration: number;
  colour: string;
  label: string;
  agentId: string | null;
  /** The agent at the destination end of the route, when the route ends at an agent (receive reactions). */
  endAgentId?: string | null;
  /** The agent at the source end, when the route starts at an agent (its terminal confirms). */
  startAgentId?: string | null;
  /** When the event itself happened (ms), if known — the scheduler does not animate stale events. */
  at?: number;
}

const COLOUR: Partial<Record<VisualEvent["kind"], string>> = {
  REVENUE_EVENT: "#34d399", TREASURY_TRANSFER: "#fbbf24", CAPITAL_REQUEST_CREATED: "#38bdf8", CAPITAL_REQUEST_DECIDED: "#38bdf8", EXPENSE_EVENT: "#f97316",
  RESEARCH_EVENT: "#60a5fa", OPPORTUNITY_EVENT: "#a78bfa", VENTURE_EVENT: "#34d399", MARKETING_EVENT: "#f472b6", SYSTEM_ALERT: "#f87171",
  AGENT_DIED: "#94a3b8", ESTATE_TRANSFER: "#94a3b8", AGENT_BORN: "#22d3ee", IDENTITY_EVENT: "#c084fc", COMMS_EVENT: "#2dd4bf", PROJECT_EVENT: "#facc15",
};

/** A visual event with a route becomes a packet (null: nothing travels, or a stop cannot be placed). */
export function packetFor(e: VisualEvent, agents: ReadonlyMap<string, Point>, now: number): Packet | null {
  if (e.path.length < 1) return null;
  const pts = e.path.map((s) => stopPoint(s, e.agentId, agents, e.counterpartId ?? null));
  if (pts.some((p) => p === null)) return null;
  const points = pts as Point[];
  if (points.length === 1) points.push({ x: points[0].x, z: points[0].z - 0.01 }); // a pulse in place
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  const last = e.path[e.path.length - 1], endAgentId = last === "agent" ? e.agentId : last === "counterpart" ? e.counterpartId ?? null : null;
  const first = e.path[0], startAgentId = first === "agent" ? e.agentId : first === "counterpart" ? e.counterpartId ?? null : null;
  return { id: e.id, kind: e.kind, points, start: now, duration: Math.min(6000, Math.max(1200, length * 140)), colour: COLOUR[e.kind] ?? "#22d3ee", label: e.label, agentId: e.agentId, endAgentId, startAgentId, at: Number.isFinite(Date.parse(e.at ?? "")) ? Date.parse(e.at!) : undefined };
}

/** Where a packet is at time t (null once it has arrived). */
export function packetAt(p: Packet, t: number): Point | null {
  const f = (t - p.start) / p.duration;
  if (f < 0 || f >= 1) return null;
  const segs = p.points.length - 1, at = f * segs, i = Math.min(segs - 1, Math.floor(at)), k = at - i;
  return { x: p.points[i].x + (p.points[i + 1].x - p.points[i].x) * k, z: p.points[i].z + (p.points[i + 1].z - p.points[i].z) * k };
}

/** Keep only travelling packets, newest last, at most `cap` (long sessions and bursts stay bounded). */
export function livePackets(packets: readonly Packet[], t: number, cap: number): Packet[] {
  const alive = packets.filter((p) => t - p.start < p.duration);
  return alive.slice(Math.max(0, alive.length - cap));
}

/** The rectangle to frame for a focus level (Fleet → department → agent). */
export function focusRect(focus: { level: "fleet" } | { level: "department"; id: DepartmentId } | { level: "agent"; id: string }, agents: ReadonlyMap<string, Point>) {
  if (focus.level === "department") { const d = DEPARTMENT[focus.id]; return { x: d.x, z: d.z, w: d.w + 4, d: d.d + 4 }; }
  if (focus.level === "agent") { const p = agents.get(focus.id); if (p) return { x: p.x, z: p.z, w: 9, d: 7 }; }
  return { x: (WORLD.minX + WORLD.maxX) / 2, z: (WORLD.minZ + WORLD.maxZ) / 2, w: WORLD.maxX - WORLD.minX, d: WORLD.maxZ - WORLD.minZ };
}

export const departmentIds = DEPARTMENTS.map((d) => d.id);

// ── Workstations and births ─────────────────────────────────────────────────────────────────────────────────────
// Every agent has a persistent workstation on the Agent Floor (stable order by agent id, the dead included). Living
// agents' stations are lit; a dead agent's station is powered down. An agent on the Agent Floor stands at its own one.

export function stationIndex(models: readonly AgentModel[]): Map<string, number> {
  return new Map([...models].map((m) => m.agent.id).sort().map((id, i) => [id, i]));
}
/**
 * The i-th workstation on the Agent Floor: an office layout of two banks either side of a central aisle (filled from
 * the aisle outwards, alternating banks), rows 2.4 m apart so there is a walkway behind every row of chairs. Ten
 * desks a row, five rows: the constitutional 50. Seats face the back wall (monitors north).
 */
export const STATION_DX = 1.45, STATION_DZ = 2.4, STATION_AISLE = 1.7;
export function stationPoint(i: number): Point {
  const d = DEPARTMENT.floor, col = i % 10, row = Math.floor(i / 10) % 5;
  const bank = col % 2 ? 1 : -1, k = Math.floor(col / 2);
  return { x: d.x + bank * (STATION_AISLE / 2 + 0.65 + k * STATION_DX), z: d.z - d.d / 2 + 3.2 + row * STATION_DZ };
}

/** How long a newborn's station powers up before the agent appears, then how long it stays at its station. */
export const BIRTH_POWER_MS = 1_200;
export const BIRTH_ENTER_MS = 7_000;
/** The static "new" marker that replaces the sequence when motion is reduced. */
export const BIRTH_MARK_MS = 10_000;

export type BirthPhase = "powering" | "entering" | "settled";
export interface BirthState { phase: BirthPhase; power: number; visible: boolean; atStation: boolean; mark: boolean }

/**
 * The birth sequence of an agent first seen at `bornAt` (presentation only: `bornAt` comes from an authoritative new
 * reading or a recorded birth event). Dormant station → powers up → the agent enters from Fleet Command and walks to its
 * station → it goes to its first destination. Reduced motion: the station is simply online and the agent in place,
 * marked as new for a while.
 */
export function birthState(bornAt: number | undefined, now: number, reduceMotion: boolean): BirthState {
  if (bornAt === undefined) return { phase: "settled", power: 1, visible: true, atStation: false, mark: false };
  const t = now - bornAt;
  if (reduceMotion) return { phase: "settled", power: 1, visible: true, atStation: false, mark: t < BIRTH_MARK_MS };
  if (t < BIRTH_POWER_MS) return { phase: "powering", power: Math.max(0, t / BIRTH_POWER_MS), visible: false, atStation: true, mark: false };
  if (t < BIRTH_POWER_MS + BIRTH_ENTER_MS) return { phase: "entering", power: 1, visible: true, atStation: true, mark: false };
  return { phase: "settled", power: 1, visible: true, atStation: false, mark: false };
}

/** Agents' targets including stations and birth sequences (an entering newborn heads for its own station first). */
export function agentTargetsWithStations(models: readonly AgentModel[], births: ReadonlyMap<string, number>, now: number, reduceMotion: boolean): Map<string, Point & { department: DepartmentId }> {
  const base = agentTargets(models), stations = stationIndex(models);
  for (const m of models) {
    const i = stations.get(m.agent.id)!;
    const b = birthState(births.get(m.agent.id), now, reduceMotion);
    if (b.atStation || m.placement.department === "floor") base.set(m.agent.id, { ...stationPoint(i), department: "floor" });
  }
  return base;
}

/** Birth event types that mark when an agent came into being (authoritative; nothing else starts a sequence). */
export const BIRTH_EVENTS = new Set(["agent_born", "genesis_activated"]);
/** Funding events that justify a Genesis-capital flow to a newborn's station. */
export const BIRTH_FUNDING_EVENTS = new Set(["genesis_funded", "wallet_transfer", "agent_transfer"]);
