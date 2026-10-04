/**
 * Information routes through the building. A packet's stops (departments, an agent, the outside) come from a real
 * recorded event (world.ts packetFor); this turns its straight hops into a path along the HQ's data conduits — out of
 * the source room through its front opening, along the cross corridor in front of it, up or down a spine conduit,
 * along the destination's cross corridor and in through its opening — so information visibly travels through the
 * infrastructure instead of through walls. Pure geometry, unit-tested.
 */
import { DEPARTMENTS, type Department } from "../../command/departments";
import type { Point } from "../world";

/** Cross-corridor conduit lines (z) and the two spine conduits (x), as built by world-build. */
export const CROSS_Z = [-23.5, -11.5, 4.5, 17.5, 30.75, 42.6] as const;
export const SPINE_X = [-10, 10] as const;
/** Where outside information enters the conduit network (the east gate's spine junction). */
const GATE_NODE: Point = { x: 10, z: -4 };

export const roomAt = (p: Point): Department | undefined => DEPARTMENTS.find((d) => Math.abs(p.x - d.x) <= d.w / 2 && Math.abs(p.z - d.z) <= d.d / 2);

/** The conduit in front of a room: the first cross corridor south of its front opening. */
export function frontLine(d: Department): number {
  const z1 = d.z + d.d / 2;
  return CROSS_Z.find((z) => z > z1) ?? z1 + 1.2;
}

/** The conduit node a point joins the network at, and the in-room approach to it. */
function access(p: Point): { inner: Point[]; node: Point } {
  const d = roomAt(p);
  if (d) { const z1 = d.z + d.d / 2; return { inner: [{ x: d.x, z: z1 }], node: { x: d.x, z: frontLine(d) } }; }
  if (p.x > 20) return { inner: [], node: GATE_NODE }; // the outside, through the east gate
  // Already in a corridor: join the nearest cross corridor.
  const z = CROSS_Z.reduce((a, b) => (Math.abs(b - p.z) < Math.abs(a - p.z) ? b : a));
  return { inner: [], node: { x: p.x, z } };
}

function spineFor(ax: number, bx: number): number {
  const side = (x: number) => (x < -1 ? -1 : x > 1 ? 1 : 0);
  const sa = side(ax), sb = side(bx);
  if (sa !== 0 && (sa === sb || sb === 0)) return sa * 10;
  if (sb !== 0) return sb * 10;
  return 10;
}

/** The path between two network nodes along the conduits (Manhattan through a spine when the corridors differ). */
function between(a: Point, b: Point): Point[] {
  if (Math.abs(a.z - b.z) < 0.01) return [b];
  const onSpine = SPINE_X.some((x) => Math.abs(a.x - x) < 0.01) && SPINE_X.some((x) => Math.abs(b.x - x) < 0.01) && Math.abs(a.x - b.x) < 0.01;
  if (onSpine) return [b];
  const sx = Math.abs(a.x - 10) < 0.01 || Math.abs(a.x + 10) < 0.01 ? a.x : spineFor(a.x, b.x);
  return [{ x: sx, z: a.z }, { x: sx, z: b.z }, b];
}

/** Turn a packet's stops into a conduit path (consecutive duplicates removed). */
export function routeThrough(stops: readonly Point[]): Point[] {
  if (stops.length < 2) return stops.slice();
  const out: Point[] = [stops[0]];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i], ra = roomAt(a), rb = roomAt(b);
    if (ra && rb && ra.id === rb.id) { out.push(b); continue; } // within one room: straight across it
    const A = access(a), B = access(b);
    out.push(...A.inner, A.node, ...between(A.node, B.node), ...B.inner.slice().reverse(), b);
  }
  return out.filter((p, i) => i === 0 || Math.hypot(p.x - out[i - 1].x, p.z - out[i - 1].z) > 0.01);
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
