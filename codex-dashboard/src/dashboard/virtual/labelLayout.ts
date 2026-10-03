/**
 * Agent label placement (pure): adaptive density and collision avoidance for up to 50 labels, every frame.
 *
 * Density: "full" (name / wallet / activity) in small Fleets or when zoomed into a department or an agent; "compact"
 * (NAME · £WALLET, one line) in the zoomed-out Fleet view of a large Fleet.
 * Placement: greedy, highest priority first (selected > critical > wounded > the rest > dead), each label tries its
 * natural spot under its agent, then staggered spots around it, then the nearest free cell of a coarse grid over the whole
 * view, and takes the first that overlaps nothing already placed. A label that still cannot avoid every overlap shows at
 * its natural spot (never hidden for crowding); only an agent off-screen is culled. Displaced labels are reported so a leader line can join them to their agent.
 */
export type LabelDensity = "full" | "compact";
export const COMPACT_ABOVE = 16;

export const densityFor = (agents: number, fleetView: boolean): LabelDensity => (fleetView && agents > COMPACT_ABOVE ? "compact" : "full");

export interface LabelItem { id: string; x: number; y: number; w: number; h: number; priority: number }
export interface Placed { x: number; y: number; displaced: boolean; overlapping: boolean }

const GAP = 2;
/** Candidate offsets (top-left relative to the natural spot) in preference order. */
const CANDIDATES = new Map<string, Array<[number, number]>>();
function candidates(w: number, h: number): Array<[number, number]> {
  const key = `${w}x${h}`, hit = CANDIDATES.get(key);
  if (hit) return hit;
  // Nearest first: the natural spot, then staggered rows below and above, then sideways — up to ~10 rows away.
  const out: Array<[number, number]> = [[0, 0]];
  for (let r = 1; r <= 10; r++) {
    for (const dy of [r * (h + GAP), -r * (h + GAP) - 34]) for (const dx of [0, -w * 0.55, w * 0.55, -w * 1.1, w * 1.1]) out.push([dx, dy]);
    if (r <= 3) for (const dx of [-(w + GAP) * r, (w + GAP) * r]) out.push([dx, 0]);
  }
  out.sort((a, b) => Math.hypot(a[0] / 2, a[1]) - Math.hypot(b[0] / 2, b[1]));
  if (CANDIDATES.size > 64) CANDIDATES.clear();
  CANDIDATES.set(key, out);
  return out;
}

export function layoutLabels(items: readonly LabelItem[], view: { w: number; h: number }): Map<string, Placed | null> {
  const out = new Map<string, Placed | null>();
  const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
  const hit = (x: number, y: number, w: number, h: number) => placed.some((p) => x < p.x + p.w + GAP && x + w + GAP > p.x && y < p.y + p.h + GAP && y + h + GAP > p.y);
  const order = [...items].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  for (const it of order) {
    // Culled only when the agent itself is off-screen.
    if (it.x < 0 || it.y < -40 || it.x > view.w || it.y > view.h) { out.set(it.id, null); continue; }
    const x0 = it.x - it.w / 2, y0 = it.y;
    let chosen: Placed | null = null;
    for (const [dx, dy] of candidates(it.w, it.h)) {
      const x = x0 + dx, y = y0 + dy;
      if (x < 0 || y < 0 || x + it.w > view.w || y + it.h > view.h) continue;
      if (!hit(x, y, it.w, it.h)) { chosen = { x, y, displaced: dx !== 0 || dy !== 0, overlapping: false }; break; }
    }
    // Crowded: the nearest free cell of a coarse grid over the whole view (a leader line joins it to its agent).
    if (!chosen) {
      const cells: Array<[number, number, number]> = [];
      for (let y = 0; y + it.h <= view.h; y += it.h + GAP) for (let x = 0; x + it.w <= view.w; x += Math.max(8, it.w / 2)) cells.push([x, y, (x + it.w / 2 - it.x) ** 2 / 4 + (y - it.y) ** 2]);
      cells.sort((a, b) => a[2] - b[2]);
      for (const [x, y] of cells) if (!hit(x, y, it.w, it.h)) { chosen = { x, y, displaced: true, overlapping: false }; break; }
    }
    chosen ??= { x: Math.min(Math.max(0, x0), Math.max(0, view.w - it.w)), y: Math.min(Math.max(0, y0), Math.max(0, view.h - it.h)), displaced: false, overlapping: true };
    placed.push({ x: chosen.x, y: chosen.y, w: it.w, h: it.h });
    out.set(it.id, chosen);
  }
  return out;
}
