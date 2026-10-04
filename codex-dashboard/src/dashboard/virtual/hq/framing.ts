/**
 * Agent View framing: where the camera stands to look at the selected agent so that nobody and no wall is in the way.
 *
 * Candidates around the agent, preferring views of the face (in front of the direction it faces, then the quarters,
 * then the sides). A candidate must be inside the agent's room or on its open cutaway side (never behind a wall);
 * among valid candidates the one with the fewest people on the line of sight wins, ties going to the preferred
 * angle. People still on the line of sight are returned as `ghosts` (faded out while the view holds). Pure; unit-tested.
 */
import type { Point } from "../world";
import { roomAt } from "./route";

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

export function frameAgent(self: string, p: Point, yaw: number, seated: boolean, others: ReadonlyMap<string, Point>, keep?: number): AgentFrame {
  const at = (az: number) => ({ x: p.x + Math.sin(az) * DIST, z: p.z + Math.cos(az) * DIST });
  const order = keep !== undefined ? [keep - yaw, ...OFFSETS] : OFFSETS;
  let best: { az: number; score: number; ghosts: string[] } | null = null;
  order.forEach((off, rank) => {
    const az = yaw + off, c = at(az);
    if (!viewable(c, p)) return;
    const g = blockers(c, p, others, self), score = g.length * 10 + rank * (keep !== undefined && rank === 0 ? 0 : 1) + (keep !== undefined && rank > 0 ? 0.5 : 0);
    if (!best || score < best.score) best = { az, score, ghosts: g };
  });
  const chosen = best as { az: number; score: number; ghosts: string[] } | null;
  const az = chosen?.az ?? yaw, c = at(az);
  const headY = seated ? 1.1 : 1.45;
  return { cam: { x: c.x, y: headY + 1.35, z: c.z }, look: { x: p.x, y: headY - 0.2, z: p.z }, ghosts: chosen?.ghosts ?? blockers(c, p, others, self), azimuth: az };
}
