/**
 * Agent View framing: where the camera stands to look at the selected agent so that nobody and no wall is in the way.
 *
 * Candidates around the agent, preferring views of the face (in front of the direction it faces, then the quarters,
 * then the sides). A candidate must be inside the agent's room or on its open cutaway side (never behind a wall);
 * among valid candidates the one with the fewest people on the line of sight wins, ties going to the preferred
 * angle. People still on the line of sight are returned as `ghosts` (faded out while the view holds). Pure; unit-tested.
 */
import { BED_LENGTH, BED_TOP, BED_WIDTH, bedPoint, bunksFor, type Point } from "../world";
import { roomAt } from "./route";
import type { Occluder } from "./world-build";

export interface AgentFrame { cam: { x: number; y: number; z: number }; look: { x: number; y: number; z: number }; ghosts: string[]; azimuth: number }

const OFFSETS = [0.5, -0.5, 0.95, -0.95, 0, 1.4, -1.4, 1.9, -1.9, Math.PI].map((d) => d);
const DIST = 3.0, CLEAR = 0.45;

/** People within CLEAR of the segment from the camera to the agent (between them, not behind either), or beside the camera. */
export function blockers(cam: Point, p: Point, others: ReadonlyMap<string, Point>, self: string): string[] {
  const dx = p.x - cam.x, dz = p.z - cam.z, L2 = dx * dx + dz * dz;
  const out: string[] = [];
  for (const [id, q] of others) {
    if (id === self) continue;
    // Someone right beside the camera fills the frame even off the line of sight.
    if (Math.hypot(q.x - cam.x, q.z - cam.z) < 1.6) { out.push(id); continue; }
    const t = ((q.x - cam.x) * dx + (q.z - cam.z) * dz) / L2;
    if (t <= 0.02 || t >= 0.92) continue;
    if (Math.hypot(cam.x + dx * t - q.x, cam.z + dz * t - q.z) < CLEAR) out.push(id);
  }
  return out;
}

/** Whether the camera may stand at c to look at p (inside p's room or on its open front side; anywhere in corridors). */
export function viewable(c: Point, p: Point): boolean {
  const d = roomAt(p);
  if (!d) return true;
  const x0 = d.x - d.w / 2 + 0.4, x1 = d.x + d.w / 2 - 0.4, z0 = d.z - d.d / 2 + 0.4, z1 = d.z + d.d / 2;
  if (c.x < x0 || c.x > x1 || c.z < z0) return false;
  return c.z <= z1 + 4;
}

/** Whether the sight line from the camera (at camY) to the agent's head (at headY) passes through a tall obstacle. */
export function blockedByFurniture(cam: Point, camY: number, p: Point, headY: number, occluders: readonly Occluder[]): boolean {
  for (const o of occluders) {
    // The obstacle the agent itself is in (its own bunk) frames it; it does not hide it.
    if (p.x >= o.x0 && p.x <= o.x1 && p.z >= o.z0 && p.z <= o.z1) continue;
    // Sample the segment (it is short): any point inside the footprint below the obstacle's height blocks it.
    for (let i = 1; i < 24; i++) {
      const t = i / 24, x = cam.x + (p.x - cam.x) * t, z = cam.z + (p.z - cam.z) * t, y = camY + (headY - camY) * t;
      if (x >= o.x0 && x <= o.x1 && z >= o.z0 && z <= o.z1 && y < o.h) return true;
    }
  }
  return false;
}

export function frameAgent(self: string, p: Point, yaw: number, seated: boolean, others: ReadonlyMap<string, Point>, keep?: number, occluders: readonly Occluder[] = []): AgentFrame {
  const at = (az: number) => ({ x: p.x + Math.sin(az) * DIST, z: p.z + Math.cos(az) * DIST });
  const order = keep !== undefined ? [keep - yaw, ...OFFSETS] : OFFSETS;
  let best: { az: number; score: number; ghosts: string[] } | null = null;
  order.forEach((off, rank) => {
    const az = yaw + off, c = at(az);
    if (!viewable(c, p)) return;
    const headY0 = seated ? 1.1 : 1.45, near = occluders.filter((o) => Math.max(o.x0 - p.x, p.x - o.x1, o.z0 - p.z, p.z - o.z1) < DIST + 0.5);
    const furniture = blockedByFurniture(c, headY0 + 1.35, p, headY0, near) ? 25 : 0;
    const g = blockers(c, p, others, self), score = furniture + g.length * 10 + rank * (keep !== undefined && rank === 0 ? 0 : 1) + (keep !== undefined && rank > 0 ? 0.5 : 0);
    if (!best || score < best.score) best = { az, score, ghosts: g };
  });
  const chosen = best as { az: number; score: number; ghosts: string[] } | null;
  const az = chosen?.az ?? yaw, c = at(az);
  const headY = seated ? 1.1 : 1.45;
  return { cam: { x: c.x, y: headY + 1.35, z: c.z }, look: { x: p.x, y: headY - 0.2, z: p.z }, ghosts: chosen?.ghosts ?? blockers(c, p, others, self), azimuth: az };
}

/** The Quarters bunk frames as camera obstacles (posts to the top rails), one per frame for n living agents. */
export const BUNK_H = 0.12 + 2.0;
export function bunkOccluders(n: number): Occluder[] {
  const out: Occluder[] = [];
  for (let f = 0; f < bunksFor(n).frames; f++) {
    const b = bedPoint(f);
    out.push({ x0: b.x - BED_WIDTH / 2, x1: b.x + BED_WIDTH / 2, z0: b.z, z1: b.z + BED_LENGTH, h: BUNK_H });
  }
  return out;
}

/**
 * A sleeper's close-up: from the aisle at the foot of its bed, looking along the bed — never from inside a bunk or across
 * one (the generic orbit would put the camera inside a neighbouring bunk or behind its posts). The bunks have no foot
 * boards and their posts stand at the corners, so this line of sight passes no frame. An open bed (no bunk above) is seen
 * from over the top rails, looking down; a lower bed under an upper one from the height between its mattress and the bunk
 * above; an upper bed from over the rails.
 */
export function frameSleeper(self: string, p: Point, level: 0 | 1, others: ReadonlyMap<string, Point>, covered = false): AgentFrame {
  const low = level === 0 && covered;
  const cam = { x: p.x, y: low ? BED_TOP[0] + 0.5 : BUNK_H + 0.55, z: p.z + BED_LENGTH + (low ? 1.25 : 1.15) };
  return { cam, look: { x: p.x, y: BED_TOP[level] + 0.1, z: p.z + (low ? 0.3 : 0.75) }, ghosts: blockers(cam, p, others, self), azimuth: 0 };
}
