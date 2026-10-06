/**
 * Walking navigation for the operators (pure; unit-tested). The walkable floor is a grid (0.25 m) rasterised from the
 * building's own geometry: every wall, parapet, desk, chair, console, rack, table and pillar the builder placed in the
 * walking band blocks its footprint, inflated by a person's radius — so a path can never pass through architecture or
 * furniture, and doorways are the only way into a room. Paths come from A* (8-way, no corner cutting, a cost for
 * hugging obstacles so people keep to the middle of aisles and corridors), then are pulled straight wherever the
 * straight line stays on walkable floor.
 *
 * Presentation only: WHERE an agent goes is decided by FleetController state (departments.ts, spots.ts); this decides
 * only how it walks there.
 */
import type { Point } from "../world";

export interface Footprint { x0: number; z0: number; x1: number; z1: number }
export interface NavGrid {
  x0: number; z0: number; cell: number; cols: number; rows: number;
  /** 1 where a person cannot stand (inflated obstacles, outside the building). */
  blocked: Uint8Array;
  /** Distance (m) from each cell to the nearest blocked cell (capped), for the clearance cost. */
  clear: Float32Array;
}

export const NAV_CELL = 0.25;
export const PERSON_RADIUS = 0.28;
const CLEAR_CAP = 1.0;

export function navGrid(footprints: readonly Footprint[], bounds: { minX: number; maxX: number; minZ: number; maxZ: number }, cell = NAV_CELL, radius = PERSON_RADIUS): NavGrid {
  const cols = Math.ceil((bounds.maxX - bounds.minX) / cell), rows = Math.ceil((bounds.maxZ - bounds.minZ) / cell);
  const blocked = new Uint8Array(cols * rows);
  for (const f of footprints) {
    const c0 = Math.max(0, Math.floor((f.x0 - radius - bounds.minX) / cell)), c1 = Math.min(cols - 1, Math.floor((f.x1 + radius - bounds.minX) / cell));
    const r0 = Math.max(0, Math.floor((f.z0 - radius - bounds.minZ) / cell)), r1 = Math.min(rows - 1, Math.floor((f.z1 + radius - bounds.minZ) / cell));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) blocked[r * cols + c] = 1;
  }
  for (let c = 0; c < cols; c++) { blocked[c] = 1; blocked[(rows - 1) * cols + c] = 1; }
  for (let r = 0; r < rows; r++) { blocked[r * cols] = 1; blocked[r * cols + cols - 1] = 1; }
  // Clearance: breadth-first distance from the blocked cells (in cells, 8-way), capped.
  const clear = new Float32Array(cols * rows).fill(CLEAR_CAP);
  const q = new Int32Array(cols * rows); let head = 0, tail = 0;
  const dist = new Int16Array(cols * rows).fill(-1);
  for (let i = 0; i < blocked.length; i++) if (blocked[i]) { dist[i] = 0; q[tail++] = i; clear[i] = 0; }
  const maxD = Math.ceil(CLEAR_CAP / cell);
  while (head < tail) {
    const i = q[head++], d = dist[i];
    if (d >= maxD) continue;
    const r = (i / cols) | 0, c = i - r * cols;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
      const j = rr * cols + cc;
      if (dist[j] >= 0) continue;
      dist[j] = d + 1; clear[j] = Math.min(CLEAR_CAP, (d + 1) * cell); q[tail++] = j;
    }
  }
  return { x0: bounds.minX, z0: bounds.minZ, cell, cols, rows, blocked, clear };
}

const cellOf = (g: NavGrid, p: Point) => {
  const c = Math.min(g.cols - 1, Math.max(0, Math.floor((p.x - g.x0) / g.cell))), r = Math.min(g.rows - 1, Math.max(0, Math.floor((p.z - g.z0) / g.cell)));
  return r * g.cols + c;
};
const centre = (g: NavGrid, i: number): Point => { const r = (i / g.cols) | 0, c = i - r * g.cols; return { x: g.x0 + (c + 0.5) * g.cell, z: g.z0 + (r + 0.5) * g.cell }; };

export const walkable = (g: NavGrid, p: Point) => !g.blocked[cellOf(g, p)];

/** The nearest walkable cell to p (p itself when free) within `maxR` metres; -1 if none. */
function nearestFree(g: NavGrid, p: Point, maxR = 2.5): number {
  const i0 = cellOf(g, p);
  if (!g.blocked[i0]) return i0;
  const r0 = (i0 / g.cols) | 0, c0 = i0 - r0 * g.cols, R = Math.ceil(maxR / g.cell);
  let best = -1, bestD = Infinity;
  for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) {
    const r = r0 + dr, c = c0 + dc;
    if (r < 0 || c < 0 || r >= g.rows || c >= g.cols) continue;
    const j = r * g.cols + c;
    if (g.blocked[j]) continue;
    const q = centre(g, j), d = Math.hypot(q.x - p.x, q.z - p.z);
    if (d < bestD) { bestD = d; best = j; }
  }
  return best;
}

/**
 * Whether the straight segment a→b stays on walkable floor: every grid cell the segment touches is walkable (an exact
 * grid traversal, not sampling — so any part of a clear segment is itself clear, and corners are never grazed).
 */
export function lineClear(g: NavGrid, a: Point, b: Point): boolean {
  const fx = (p: Point) => (p.x - g.x0) / g.cell, fz = (p: Point) => (p.z - g.z0) / g.cell;
  let cx = Math.floor(fx(a)), cz = Math.floor(fz(a));
  const ex = Math.floor(fx(b)), ez = Math.floor(fz(b));
  const dx = fx(b) - fx(a), dz = fz(b) - fz(a);
  const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
  const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity, tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tmx = dx !== 0 ? (dx > 0 ? cx + 1 - fx(a) : fx(a) - cx) * tdx : Infinity;
  let tmz = dz !== 0 ? (dz > 0 ? cz + 1 - fz(a) : fz(a) - cz) * tdz : Infinity;
  const blocked = (c: number, r: number) => c < 0 || r < 0 || c >= g.cols || r >= g.rows || g.blocked[r * g.cols + c] === 1;
  for (let guard = 0; guard < g.cols + g.rows + 4; guard++) {
    if (blocked(cx, cz)) return false;
    if (cx === ex && cz === ez) return true;
    if (Math.abs(tmx - tmz) < 1e-12) { // exactly through a corner: both neighbours count
      if (blocked(cx + stepX, cz) || blocked(cx, cz + stepZ)) return false;
      cx += stepX; cz += stepZ; tmx += tdx; tmz += tdz;
    } else if (tmx < tmz) { cx += stepX; tmx += tdx; } else { cz += stepZ; tmz += tdz; }
  }
  return true;
}

// Reused search buffers (one search at a time; the scene paces searches per frame).
let buf: { n: number; g: Float32Array; parent: Int32Array; stamp: Uint32Array; closed: Uint32Array; heap: Int32Array; f: Float32Array; gen: number } | null = null;
function buffers(n: number) {
  if (!buf || buf.n !== n) buf = { n, g: new Float32Array(n), parent: new Int32Array(n), stamp: new Uint32Array(n), closed: new Uint32Array(n), heap: new Int32Array(n * 2), f: new Float32Array(n), gen: 0 };
  buf.gen++;
  return buf;
}

/**
 * A walking path from `from` to `to` (excluding `from`; ending exactly at `to`), or null when there is none. A start or
 * goal inside furniture (a seat in its chair) steps out to the nearest free floor first.
 */
export function findPath(g: NavGrid, from: Point, to: Point): Point[] | null {
  const s = nearestFree(g, from), t = nearestFree(g, to);
  if (s < 0 || t < 0) return null;
  if (s === t) return [{ x: to.x, z: to.z }];
  const B = buffers(g.cols * g.rows), gen = B.gen, tc = centre(g, t);
  let hn = 0;
  const push = (i: number) => {
    let k = hn++; B.heap[k] = i;
    while (k > 0) { const p = (k - 1) >> 1; if (B.f[B.heap[p]] <= B.f[i]) break; B.heap[k] = B.heap[p]; B.heap[p] = i; k = p; }
  };
  const pop = () => {
    const top = B.heap[0], last = B.heap[--hn];
    let k = 0;
    if (hn > 0) {
      B.heap[0] = last;
      for (;;) { const l = k * 2 + 1, r = l + 1; let m = k;
        if (l < hn && B.f[B.heap[l]] < B.f[B.heap[m]]) m = l; if (r < hn && B.f[B.heap[r]] < B.f[B.heap[m]]) m = r;
        if (m === k) break; const tmp = B.heap[m]; B.heap[m] = B.heap[k]; B.heap[k] = tmp; k = m; }
    }
    return top;
  };
  const h = (i: number) => { const p = centre(g, i), dx = Math.abs(p.x - tc.x), dz = Math.abs(p.z - tc.z); return (Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz)); };
  B.g[s] = 0; B.stamp[s] = gen; B.parent[s] = -1; B.f[s] = h(s); push(s);
  let found = false;
  while (hn > 0) {
    const i = pop();
    if (B.closed[i] === gen) continue;
    B.closed[i] = gen;
    if (i === t) { found = true; break; }
    const r = (i / g.cols) | 0, c = i - r * g.cols;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= g.rows || cc >= g.cols) continue;
      const j = rr * g.cols + cc;
      if (g.blocked[j] || B.closed[j] === gen) continue;
      if (dr && dc && (g.blocked[r * g.cols + cc] || g.blocked[rr * g.cols + c])) continue; // no corner cutting
      const step = (dr && dc ? Math.SQRT2 : 1) * g.cell * (1 + Math.max(0, 0.7 - g.clear[j]) * 2.5);
      const ng = B.g[i] + step;
      if (B.stamp[j] === gen && ng >= B.g[j]) continue;
      B.stamp[j] = gen; B.g[j] = ng; B.parent[j] = i; B.f[j] = ng + h(j); push(j);
    }
  }
  if (!found) return null;
  const cells: Point[] = [];
  for (let i = t; i !== -1; i = B.parent[i]) cells.push(centre(g, i));
  cells.reverse();
  // Pull the path straight wherever the straight line stays walkable.
  const raw = [centre(g, s), ...cells.slice(1)], out: Point[] = [];
  let a = 0;
  while (a < raw.length - 1) {
    let b = raw.length - 1;
    while (b > a + 1 && !lineClear(g, raw[a], raw[b])) b--;
    out.push(raw[b]); a = b;
  }
  if (out.length) out[out.length - 1] = { x: to.x, z: to.z }; else out.push({ x: to.x, z: to.z });
  // Stepping out of a chair: go to the free floor first (never through the desk).
  if (g.blocked[cellOf(g, from)]) out.unshift(centre(g, s));
  return out;
}

/**
 * Path following for natural walking (pure; unit-tested): the farthest point along the remaining path (`pos` →
 * `path[0]` → …) within `reach` metres that can be walked to in a straight line. Steering toward it rounds corners and
 * takes doorways square-on, because a point is only accepted when the straight line to it stays on walkable floor.
 */
export function lookahead(g: NavGrid, pos: Point, path: readonly Point[], reach: number): Point {
  let best: Point = path[0] ?? pos, prev = pos, left = reach;
  for (const wp of path) {
    const seg = Math.hypot(wp.x - prev.x, wp.z - prev.z);
    if (seg >= left) {
      const k = left / Math.max(seg, 1e-6), p = { x: prev.x + (wp.x - prev.x) * k, z: prev.z + (wp.z - prev.z) * k };
      if (lineClear(g, pos, p)) best = p;
      break;
    }
    if (!lineClear(g, pos, wp)) break;
    best = wp; left -= seg; prev = wp;
  }
  return best;
}
