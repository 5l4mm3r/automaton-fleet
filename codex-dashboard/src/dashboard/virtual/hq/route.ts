/**
 * Information routes through the building. A packet's stops (departments, an agent, the outside) come from a real
 * recorded event (world.ts packetFor); this turns its straight hops into a path through the HQ's CEILING DATA PIPES.
 *
 * Fleet Command is the hub (approved 2026-10-13): information between two departments leaves the source room through its
 * front opening, follows the corridor pipes to the hub's nearest opening (north onto the corridor in front of the top row,
 * south onto the corridor in front of the hub; the other rows join the south corridor along a spine), passes through the
 * live core at the centre of Fleet Command, and goes out the same way to its destination — so every avenue visibly runs
 * through FleetController, and nothing travels through walls. Inside one room it crosses the room directly. Pure
 * geometry, unit-tested.
 */
import { DEPARTMENT, DEPARTMENTS, type Department, type DepartmentId } from "../../command/departments";
import type { Point } from "../world";

/** Cross-corridor pipe lines (z: in front of each row) and the two spine pipes (x), as built by world-build. */
export const CROSS_Z = [-19, -3, 17, 33] as const;
export const SPINE_X = [-11, 11] as const;
/** The facility's east edge, where outside information enters the pipe network (the gate's junction). */
export const GATE_X = 31;
const HUB_ROOM = DEPARTMENT.command;
/** The hub's openings onto the corridor network: north (back wall) and south (front), with the in-room point behind each. */
export const HUB_NORTH: Point = Object.freeze({ x: HUB_ROOM.x, z: CROSS_Z[0] });
export const HUB_SOUTH: Point = Object.freeze({ x: HUB_ROOM.x, z: CROSS_Z[1] });
const HUB_NORTH_IN: Point = { x: HUB_ROOM.x, z: HUB_ROOM.z - HUB_ROOM.d / 2 };
const HUB_SOUTH_IN: Point = { x: HUB_ROOM.x, z: HUB_ROOM.z + HUB_ROOM.d / 2 };

/** The pipes run under the ceiling; at a route's ends they drop to the intake or the agent (presentation height, m). */
export const PIPE_Y = 3.95;
export const PIPE_END_Y = 0.6;
/** How far along the path (m) a pipe drops from the ceiling to its end point. */
export const PIPE_DROP = 1.6;

/**
 * Each department's INTAKE: where information for that department arrives and leaves (the end of its pipe drop). Fleet
 * Command: the live core at the centre of the hub. Treasury: the capital intake on the gold seal under the hub displays.
 * Elsewhere: the intake node in the equipment band.
 */
export const INTAKE: Readonly<Record<DepartmentId, Point>> = Object.freeze(Object.fromEntries(DEPARTMENTS.map((d) => {
  const z0 = d.z - d.d / 2;
  return [d.id, d.id === "command" ? { x: d.x, z: d.z } : d.id === "treasury" ? { x: d.x, z: d.z + 1.4 } : { x: d.x, z: z0 + 1.6 }];
})) as Record<DepartmentId, Point>);
/** The live core at the centre of Fleet Command — every route between departments passes it. */
export const HUB: Point = INTAKE.command;

export const roomAt = (p: Point): Department | undefined => DEPARTMENTS.find((d) => Math.abs(p.x - d.x) <= d.w / 2 && Math.abs(p.z - d.z) <= d.d / 2);

/** The corridor in front of a room: the first cross corridor south of its front opening. */
export function frontLine(d: Department): number {
  const z1 = d.z + d.d / 2;
  return CROSS_Z.find((z) => z > z1) ?? z1 + 1.2;
}

const same = (a: Point, b: Point) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;

/**
 * The pipe path from a point to the hub's core (both ends included). `side` picks the spine for points on the centre
 * line (−1 west, +1 east) — the side the other end of the route is on, so a route never doubles back.
 */
export function toHub(p: Point, side: -1 | 1 = 1): Point[] {
  const d = roomAt(p);
  if (d?.id === "command") return same(p, HUB) ? [HUB] : [p, HUB];
  const out: Point[] = [p];
  let node: Point;
  if (d) { const z1 = d.z + d.d / 2; out.push({ x: d.x, z: z1 }); node = { x: d.x, z: frontLine(d) }; }
  else if (p.x > GATE_X) node = { x: GATE_X, z: HUB_SOUTH.z }; // the outside, through the east gate
  else node = { x: p.x, z: CROSS_Z.reduce((a, b) => (Math.abs(b - p.z) < Math.abs(a - p.z) ? b : a)) }; // in a corridor: its nearest cross corridor
  out.push(node);
  if (node.z === HUB_NORTH.z) out.push(HUB_NORTH, HUB_NORTH_IN);
  else if (node.z === HUB_SOUTH.z) out.push(HUB_SOUTH, HUB_SOUTH_IN);
  else {
    const sx = node.x < -1e-6 ? SPINE_X[0] : node.x > 1e-6 ? SPINE_X[1] : side < 0 ? SPINE_X[0] : SPINE_X[1];
    // Along the cross corridor to the spine, along the spine to the hub's south corridor, along it to the hub.
    out.push({ x: sx, z: node.z }, { x: sx, z: HUB_SOUTH.z }, HUB_SOUTH, HUB_SOUTH_IN);
  }
  out.push(HUB);
  return dedupe(out);
}

function dedupe(pts: Point[]): Point[] {
  return pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) > 0.01);
}

/** Turn a packet's stops into a pipe path: within one room straight across it, otherwise through the hub. */
export function routeThrough(stops: readonly Point[]): Point[] {
  if (stops.length < 2) return stops.slice();
  const out: Point[] = [stops[0]];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i], ra = roomAt(a), rb = roomAt(b);
    if (ra && rb && ra.id === rb.id) { out.push(b); continue; }
    const sideOf = (p: Point): -1 | 1 => (p.x < 0 ? -1 : 1);
    const up = toHub(a, sideOf(b)), down = toHub(b, sideOf(a)).reverse();
    out.push(...up.slice(1), ...down.slice(1));
  }
  return dedupe(out);
}

/** Total length of a path (m). */
export const pathLength = (pts: readonly Point[]) => pts.reduce((n, p, i) => (i ? n + Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) : 0), 0);

/** The point at fraction f (0..1) along a path, and the heading there. */
export function along(pts: readonly Point[], f: number): { p: Point; dir: Point } {
  const total = pathLength(pts);
  let left = Math.max(0, Math.min(1, f)) * total;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], l = Math.hypot(b.x - a.x, b.z - a.z);
    if (left <= l || i === pts.length - 1) { const k = l ? Math.min(1, left / l) : 0; return { p: { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k }, dir: l ? { x: (b.x - a.x) / l, z: (b.z - a.z) / l } : { x: 0, z: 1 } }; }
    left -= l;
  }
  return { p: pts[pts.length - 1] ?? { x: 0, z: 0 }, dir: { x: 0, z: 1 } };
}

/**
 * The pipe's height at a distance `s` (m) along a route of length `L`: under the ceiling, dropping to the end points over
 * the first and last PIPE_DROP metres (where the intake or the agent is). A route shorter than two drops never reaches
 * the ceiling (it arcs between its ends).
 */
export function pipeHeight(s: number, L: number): number {
  const f = Math.max(0, Math.min(1, Math.min(s, L - s) / PIPE_DROP));
  return PIPE_END_Y + (PIPE_Y - PIPE_END_Y) * f;
}
