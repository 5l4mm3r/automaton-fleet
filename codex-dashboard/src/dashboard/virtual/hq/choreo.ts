/**
 * Agent choreography (pure; unit-tested): which work animation a person shows, how it reacts to its own real events,
 * the Agent Floor's desks as walking obstacles, and how walkers give way to each other.
 *
 * Rules:
 *  - Location follows work (departments.ts / spots.ts). Here only the BODY: what someone does where they are.
 *  - Working animations (typing, reading, inspecting, operating a console, meeting) only for agents whose state says they
 *    are working: a mission, a recent real event, or a team project. An agent with nothing recent (basis "default"),
 *    held or provisioning sits at its station with subtle life — never typing, never "busy".
 *  - Reactions only to the agent's own recorded events: CONFIRM as its event launches from its terminal, COMPLETE when
 *    that event is a delivery or completion, RECEIVE when an event arrives at it (transport.ts response phase).
 */
import type { Placement } from "../../command/departments";
import type { Point } from "../world";
import type { Footprint } from "./nav";

export type Activity =
  | "walk" | "fastWalk" | "rise"
  | "idle" | "waiting" | "observe"
  | "seated" | "seatedRead" | "seatedIdle"
  | "terminal" | "reading" | "inspect"
  | "meetSeat" | "meetStand" | "pointing"
  | "dead";

export type Reaction = "confirm" | "complete" | "receive";

/** Is this agent doing real work right now (by FleetController state), as opposed to idling? */
export const isWorking = (status: string, basis: Placement["basis"]) => status !== "dead" && status !== "held" && status !== "provisioning" && basis !== "default" && basis !== "dead";

/** Slow deterministic cycles between related work animations (every ~15–25 s, desynchronised per person). */
const cycle = (t: number, seed: number, n: number) => Math.floor((t + (seed % 97) * 3.1) / (15 + (seed % 11))) % n;

export interface ActivityContext {
  status: string; basis: Placement["basis"]; department: string;
  moving: boolean; fast: boolean; rising: boolean;
  atStation: boolean; atSpot: boolean; spotPose: "seat" | "stand" | null; meeting: boolean; team: boolean;
  seed: number; t: number;
}

export function chooseActivity(c: ActivityContext): Activity {
  if (c.status === "dead") return "dead";
  if (c.moving) return c.fast ? "fastWalk" : "walk";
  if (c.rising) return "rise";
  const working = isWorking(c.status, c.basis) || c.team;
  if (c.atSpot && c.meeting) return c.spotPose === "seat" ? "meetSeat" : (["meetStand", "meetStand", "pointing"] as const)[cycle(c.t, c.seed, 3)];
  if (c.atStation || (c.atSpot && c.spotPose === "seat")) return working ? (["seated", "seated", "seatedRead"] as const)[cycle(c.t, c.seed, 3)] : "seatedIdle";
  if (c.atSpot) return working ? (["terminal", "reading", "terminal", "inspect"] as const)[cycle(c.t, c.seed, 4)] : "waiting";
  // In a room without a free spot (crowded): watching the room's displays while working there; otherwise waiting.
  if (c.department !== "floor") return working ? "observe" : "waiting";
  return "idle";
}

/** The reaction to show now (most recent wins), and how far through it is (0..1); null when none. */
export const REACTION_MS: Readonly<Record<Reaction, number>> = { confirm: 1400, complete: 2200, receive: 1300 };
export function reactionAt(now: number, at: { send?: number; done?: number; receive?: number }): { kind: Reaction; k: number } | null {
  const cands: Array<[Reaction, number | undefined]> = [["complete", at.done], ["confirm", at.send], ["receive", at.receive]];
  let best: { kind: Reaction; k: number; at: number } | null = null;
  for (const [kind, t] of cands) {
    if (t === undefined) continue;
    const k = (now - t) / REACTION_MS[kind];
    if (k < 0 || k >= 1) continue;
    if (!best || t > best.at) best = { kind, k, at: t };
  }
  return best && { kind: best.kind, k: best.k };
}

/** The Agent Floor workstations (stations.tsx geometry; the station point is the seat): desk and chair are obstacles. */
export const stationDesks = (stations: ReadonlyMap<string, Point>): Footprint[] =>
  [...stations.values()].flatMap((p) => [{ x0: p.x - 0.68, z0: p.z - 0.99, x1: p.x + 0.68, z1: p.z - 0.29 }, { x0: p.x - 0.27, z0: p.z - 0.15, x1: p.x + 0.27, z1: p.z + 0.4 }]);

/**
 * Local avoidance for a walker at `p` heading `dir` (unit): people close ahead push it sideways (to its right, the
 * same rule for everyone so two people meeting head-on pass each other) and slow it down. Returns the sideways push
 * (m/s) and a speed factor (0.35..1).
 */
export function giveWay(self: string, p: Point, dir: Point, others: ReadonlyMap<string, Point>): { push: Point; slow: number } {
  let px = 0, pz = 0, slow = 1;
  const rx = -dir.z, rz = dir.x; // the walker's right (three.js: +x right when facing +z… mirrored consistently)
  for (const [id, q] of others) {
    if (id === self) continue;
    const dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz);
    if (d > 1.1 || d < 1e-4) continue;
    const ahead = (dx * dir.x + dz * dir.z) / d;
    if (ahead < 0.2) continue; // behind or beside: not in the way
    const side = dx * rx + dz * rz; // >0: the other is on my right
    const w = (1.1 - d) / 1.1 * ahead;
    const s = side > 0.05 ? -1 : 1; // step away from them; dead ahead → keep right
    px += rx * s * w * 0.9; pz += rz * s * w * 0.9;
    if (d < 0.6) slow = Math.min(slow, Math.max(0.35, d / 0.6));
  }
  return { push: { x: px, z: pz }, slow };
}
