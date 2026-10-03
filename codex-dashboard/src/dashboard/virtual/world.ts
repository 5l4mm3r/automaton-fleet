/**
 * The Virtual Command Centre's world state — shared by the 3D scene and the 2D map. Pure: given the derived agents and
 * the visual events, where each agent should stand and which information packets are travelling. Renderers only
 * interpolate towards these targets; they never decide anything themselves.
 */
import type { AgentModel } from "../command/agents";
import { DEPARTMENT, DEPARTMENTS, slot, type DepartmentId } from "../command/departments";
import type { FlowStop, VisualEvent } from "../command/events";

export interface Point { x: number; z: number }

/** The facility's bounds (world units) — the 2D map's viewBox and the 3D camera's "Fleet view". */
export const WORLD = Object.freeze({ minX: -21, maxX: 21, minZ: -20, maxZ: 23 });
/** Where outside information (customers, providers) enters the facility. */
export const EXTERNAL: Point = Object.freeze({ x: 23, z: -2 });

/** Each agent's target spot: its department, then a deterministic slot by order of id within that department. */
export function agentTargets(models: readonly AgentModel[]): Map<string, Point & { department: DepartmentId }> {
  const byDep = new Map<DepartmentId, AgentModel[]>();
  for (const m of models) (byDep.get(m.placement.department) ?? byDep.set(m.placement.department, []).get(m.placement.department)!).push(m);
  const out = new Map<string, Point & { department: DepartmentId }>();
  for (const [dep, list] of byDep) {
    [...list].sort((a, b) => a.agent.id.localeCompare(b.agent.id)).forEach((m, i) => out.set(m.agent.id, { ...slot(dep, i), department: dep }));
  }
  return out;
}

export function stopPoint(stop: FlowStop, agentId: string | null, agents: ReadonlyMap<string, Point>): Point | null {
  if (stop === "external") return EXTERNAL;
  if (stop === "agent") return agentId ? agents.get(agentId) ?? null : null;
  const d = DEPARTMENT[stop];
  return d ? { x: d.x, z: d.z } : null;
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
}

const COLOUR: Partial<Record<VisualEvent["kind"], string>> = {
  REVENUE_EVENT: "#34d399", TREASURY_TRANSFER: "#fbbf24", CAPITAL_REQUEST_CREATED: "#38bdf8", CAPITAL_REQUEST_DECIDED: "#38bdf8", EXPENSE_EVENT: "#f97316",
  RESEARCH_EVENT: "#60a5fa", OPPORTUNITY_EVENT: "#a78bfa", VENTURE_EVENT: "#34d399", MARKETING_EVENT: "#f472b6", SYSTEM_ALERT: "#f87171",
  AGENT_DIED: "#94a3b8", ESTATE_TRANSFER: "#94a3b8", AGENT_BORN: "#22d3ee", IDENTITY_EVENT: "#c084fc", COMMS_EVENT: "#2dd4bf",
};

/** A visual event with a route becomes a packet (null: nothing travels, or a stop cannot be placed). */
export function packetFor(e: VisualEvent, agents: ReadonlyMap<string, Point>, now: number): Packet | null {
  if (e.path.length < 1) return null;
  const pts = e.path.map((s) => stopPoint(s, e.agentId, agents));
  if (pts.some((p) => p === null)) return null;
  const points = pts as Point[];
  if (points.length === 1) points.push({ x: points[0].x, z: points[0].z - 0.01 }); // a pulse in place
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  return { id: e.id, kind: e.kind, points, start: now, duration: Math.min(6000, Math.max(1200, length * 140)), colour: COLOUR[e.kind] ?? "#22d3ee", label: e.label, agentId: e.agentId };
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
  if (focus.level === "agent") { const p = agents.get(focus.id); if (p) return { x: p.x, z: p.z, w: 12, d: 10 }; }
  return { x: (WORLD.minX + WORLD.maxX) / 2, z: (WORLD.minZ + WORLD.maxZ) / 2, w: WORLD.maxX - WORLD.minX, d: WORLD.maxZ - WORLD.minZ };
}

export const departmentIds = DEPARTMENTS.map((d) => d.id);
