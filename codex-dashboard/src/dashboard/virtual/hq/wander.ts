/**
 * Idle wandering (owner-approved 2026-10-13; facility-wide 2026-10-16) — COSMETIC ONLY, pure and unit-tested.
 *
 * Owner, 2026-10-16: "Awake but idle agents may wander through rooms and corridors. Cosmetic movement must not change
 * their recorded task or suggest they are performing work. Sleeping or hibernating agents belong in the dorms." So an
 * idle agent (mayWander) now roams the whole facility — other rooms and the corridors (roamPoint over roamCandidates) —
 * never Quarters (the dorms are for sleepers) or Estate Storage (the dead), never onto another agent's workstation, a
 * room's work spot or a specialist's desk. Its RECORDED placement (department, activity, timers, roster, room counts) is
 * untouched: only the body walks, and the label says it is idle and strolling (VirtualCommandCentre useStrolling).
 *
 * The original rule, kept for reference (wanderPoint, still exported and tested):
 *
 * The Virtual rule stays: if something meaningful moves, something real happened. WHICH ROOM an agent is in comes only
 * from FleetController's state (departments.ts); an agent with nothing to do (no mission, no recent event, no team
 * project, awake and not held) may stroll INSIDE that room between dwells at its own place, so a quiet Fleet does not look
 * frozen. A stroll never changes the room, carries no information and is never shown as work. Deterministic per agent
 * (seeded by its id and a time slot), stopped under Reduce Motion, and cheap: one tiny computation per agent per frame, a
 * new goal only at slot boundaries.
 */
import { DEPARTMENTS, type Department, type DepartmentId } from "../../command/departments";
import { WORLD, type Point } from "../world";
import { CROSS_Z, SPINE_X, frontLine, roomAt } from "./route";

/** A wander cycle: dwell at the agent's own place, then stroll to a spot in the room and stand there for a while. */
export const WANDER_SLOT_MS = 36_000;
export const WANDER_DWELL = 0.55; // share of each slot spent at the agent's own place
/** Keep strolls this far from the room's walls (m). */
export const WANDER_MARGIN = 1.4;

const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0), 2166136261);
const unit = (n: number) => ((Math.imul(n ^ (n >>> 15), 2246822519) >>> 0) % 10_000) / 10_000;

/**
 * Where an idle agent should be at `now`: its own place `home` during the dwell part of each slot, otherwise a seeded spot
 * inside `room` (inset by WANDER_MARGIN). `ok` may veto a spot (e.g. not walkable floor): then the agent stays home.
 */
export function wanderPoint(id: string, home: Point, room: Pick<Department, "x" | "z" | "w" | "d">, now: number, ok: (p: Point) => boolean = () => true): Point {
  const seed = hash(id), t = now + (seed % WANDER_SLOT_MS), slot = Math.floor(t / WANDER_SLOT_MS), f = (t % WANDER_SLOT_MS) / WANDER_SLOT_MS;
  if (f < WANDER_DWELL) return home;
  const hw = Math.max(0, room.w / 2 - WANDER_MARGIN), hd = Math.max(0, room.d / 2 - WANDER_MARGIN);
  const p = { x: room.x + (unit(seed + slot * 7919) * 2 - 1) * hw, z: room.z + (unit(seed ^ (slot * 104729)) * 2 - 1) * hd };
  return ok(p) ? p : home;
}

/** May this agent wander? Awake, alive, not held or provisioning, and with nothing real to do right now. */
export const mayWander = (status: string, basis: string, team: boolean) => status === "active" && basis === "default" && !team;

// ── Facility-wide roaming (2026-10-16) ──────────────────────────────────────────────────────────────────────────────

/** A roam cycle: dwell at the agent's own place, then walk somewhere in the facility and stand there a while. */
export const ROAM_SLOT_MS = 80_000;
export const ROAM_DWELL = 0.45;
/** Rooms an idle stroll never enters: the dorms (sleepers) and Estate Storage (the dead). */
export const NO_ROAM_ROOMS: ReadonlySet<DepartmentId> = new Set<DepartmentId>(["quarters", "estate"]);
/** A stroll never ends this close (m) to a workstation, work spot or specialist desk (someone's place). */
export const ROAM_AVOID_M = 1.2;

/**
 * Every place an idle agent may stroll to (deterministic, sorted): a 2 m lattice inside each room except Quarters and
 * Estate (inset WANDER_MARGIN from the walls) and points every 3 m along the cross corridors and the two spines (outside
 * every room). Points within ROAM_AVOID_M of `avoid` (stations, work spots, crew seats, intakes) are dropped; `ok` may
 * veto more (the 3D scene: walkable, clear of walls, reachable).
 */
export function roamCandidates(avoid: readonly Point[], ok: (p: Point) => boolean = () => true): Point[] {
  const out: Point[] = [];
  for (const d of DEPARTMENTS) {
    if (NO_ROAM_ROOMS.has(d.id)) continue;
    const hw = d.w / 2 - WANDER_MARGIN, hd = d.d / 2 - WANDER_MARGIN;
    for (let x = -hw; x <= hw + 1e-6; x += 2) for (let z = -hd; z <= hd + 1e-6; z += 2) out.push({ x: d.x + x, z: d.z + z });
  }
  for (const z of CROSS_Z) for (let x = WORLD.minX + 2; x <= WORLD.maxX - 2 + 1e-6; x += 3) out.push({ x, z });
  for (const x of SPINE_X) for (let z = WORLD.minZ + 2; z <= WORLD.maxZ - 2 + 1e-6; z += 3) out.push({ x, z });
  const seen = new Set<string>();
  return out.filter((p) => {
    const room = roomAt(p);
    if (room && NO_ROAM_ROOMS.has(room.id)) return false;
    if (!room && !CROSS_Z.some((z) => Math.abs(p.z - z) < 1e-6) && !SPINE_X.some((x) => Math.abs(p.x - x) < 1e-6)) return false;
    if (p.x < WORLD.minX || p.x > WORLD.maxX || p.z < WORLD.minZ || p.z > WORLD.maxZ) return false;
    if (avoid.some((a) => Math.hypot(a.x - p.x, a.z - p.z) < ROAM_AVOID_M)) return false;
    const k = `${p.x.toFixed(2)},${p.z.toFixed(2)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return ok(p);
  }).sort((a, b) => a.z - b.z || a.x - b.x);
}

/**
 * Where an idle agent should be at `now`: home during the dwell part of each ROAM_SLOT_MS (seeded per agent), otherwise
 * one of `candidates`, chosen by the agent's id and the slot. Deterministic; no candidates → home.
 */
export function roamPoint(id: string, home: Point, candidates: readonly Point[], now: number): Point {
  const seed = hash(id), t = now + (seed % ROAM_SLOT_MS), slot = Math.floor(t / ROAM_SLOT_MS), f = (t % ROAM_SLOT_MS) / ROAM_SLOT_MS;
  if (f < ROAM_DWELL || !candidates.length) return home;
  return candidates[Math.min(candidates.length - 1, Math.floor(unit(seed + slot * 7919) * candidates.length))];
}

/**
 * The 2D map's walking route between two points (it has no nav grid): out of the room through its front opening onto
 * its corridor, along the cross corridors and the nearer spine, and in through the destination's opening — never
 * through a wall. Within one room (or along one corridor) straight across. Ends exactly at `to`; excludes `from`.
 */
export function corridorRoute(from: Point, to: Point): Point[] {
  const ra = roomAt(from), rb = roomAt(to);
  if (ra && rb && ra.id === rb.id) return [{ ...to }];
  type Node = { p: Point; cross: boolean };
  const nearest = (xs: readonly number[], v: number) => xs.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
  const exit = (p: Point): { pts: Point[]; node: Node } => {
    const d = roomAt(p);
    if (d) { const node = { x: d.x, z: frontLine(d) }; return { pts: [{ x: d.x, z: d.z + d.d / 2 }, node], node: { p: node, cross: true } }; }
    const cz = nearest(CROSS_Z, p.z), sx = nearest(SPINE_X, p.x), cross = Math.abs(p.z - cz) <= Math.abs(p.x - sx);
    const node = cross ? { x: p.x, z: cz } : { x: sx, z: p.z };
    return { pts: [node], node: { p: node, cross } };
  };
  const a = exit(from), b = exit(to), A = a.node, B = b.node, mid: Point[] = [];
  if (A.cross && B.cross) {
    if (Math.abs(A.p.z - B.p.z) > 1e-6) { const sx = nearest(SPINE_X, (A.p.x + B.p.x) / 2); mid.push({ x: sx, z: A.p.z }, { x: sx, z: B.p.z }); }
  } else if (!A.cross && !B.cross) {
    if (Math.abs(A.p.x - B.p.x) > 1e-6) { const cz = nearest(CROSS_Z, (A.p.z + B.p.z) / 2); mid.push({ x: A.p.x, z: cz }, { x: B.p.x, z: cz }); }
  } else mid.push(A.cross ? { x: B.p.x, z: A.p.z } : { x: A.p.x, z: B.p.z });
  const pts = [...a.pts, ...mid, ...[...b.pts].reverse(), { ...to }];
  return pts.filter((p, i) => i === pts.length - 1 || Math.hypot(p.x - (i ? pts[i - 1] : from).x, p.z - (i ? pts[i - 1] : from).z) > 0.01);
}
