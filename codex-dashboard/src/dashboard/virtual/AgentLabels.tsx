/**
 * Agent labels as an HTML layer over either renderer — every agent identifiable by name and wallet at any Fleet size.
 *
 * Density adapts (labelLayout.ts): name / wallet / activity in small Fleets or when zoomed into a department or an agent;
 * one compact line `NAME · £WALLET` in the zoomed-out Fleet view of a large Fleet. Placement avoids collisions every
 * frame (selected, critical and wounded agents first), staggering crowded labels with a leader line to their agent; a
 * label is culled only when its agent is off-screen. Distressed agents carry a coloured edge and keep their state in the
 * accessible name; the selected agent's label is highlighted.
 *
 * The active renderer publishes each agent's animated position and a projection to screen pixels; one capped
 * requestAnimationFrame loop places the labels (transforms via CSSOM — no style attributes, the deck's strict CSP).
 * Label sizes are measured only when their content changes, never per frame.
 */
import { clickSuppressed } from "./hq/nav-state";
import { memo, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { money } from "../model";
import type { AgentModel } from "../command/agents";
import { BAND_TEXT, type HealthBand } from "../command/economics";
import type { VirtualPrefs } from "../command/prefs";
import { densityFor, layoutLabels, type LabelItem } from "./labelLayout";
import type { BirthState, Point } from "./world";

/** World → label-layer pixels. `y` (3D only) projects a point at that height (default: the floor). */
export type Projector = (p: Point, lift: number, y?: number) => { x: number; y: number } | null;

const PRIORITY: Readonly<Record<HealthBand, number>> = { CRITICAL: 3, WOUNDED: 2, WINNING: 1, HEALTHY: 1, UNKNOWN: 1, DEAD: 0 };
const EDGE: Readonly<Record<HealthBand, string>> = {
  CRITICAL: "border-red-500", WOUNDED: "border-amber-500", WINNING: "border-emerald-700", HEALTHY: "border-slate-700", UNKNOWN: "border-slate-700", DEAD: "border-slate-800",
};

export const AgentLabels = memo(function AgentLabels({ models, positionsRef, projectRef, prefs, selected, fleetView, onAgent, hidden, marked }: {
  models: AgentModel[]; positionsRef: MutableRefObject<Map<string, Point>>; projectRef: MutableRefObject<Projector | null>; prefs: VirtualPrefs;
  selected: string | null; fleetView: boolean; onAgent: (id: string) => void;
  /** Agents not shown yet (a newborn while its station powers up). */
  hidden: ReadonlySet<string>;
  /** Birth states (the static "new" marker when motion is reduced). */
  marked: ReadonlyMap<string, BirthState>;
}) {
  const els = useRef(new Map<string, HTMLButtonElement>());
  const sizes = useRef(new Map<string, { w: number; h: number }>());
  const leaders = useRef<SVGSVGElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const lastSig = useRef(""), lastPlaced = useRef<ReturnType<typeof layoutLabels> | null>(null);
  // The label layer's width (a phone gets compact tags so the small facility stays readable).
  const [layerW, setLayerW] = useState(Infinity);
  useEffect(() => { const el = root.current; if (!el) return; const ro = new ResizeObserver(() => setLayerW(el.clientWidth || Infinity)); ro.observe(el); return () => ro.disconnect(); }, []);
  const density = densityFor(models.length, fleetView, layerW);
  const live = useRef({ models, selected, hidden, fps: prefs.fps });
  useEffect(() => { live.current = { models, selected, hidden, fps: prefs.fps }; }, [models, selected, hidden, prefs.fps]);

  // Measure after each render (content or density changed), not per frame.
  useLayoutEffect(() => {
    for (const [id, el] of els.current) sizes.current.set(id, { w: el.offsetWidth, h: el.offsetHeight });
  });

  useEffect(() => {
    let raf = 0, last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const L = live.current;
      if (document.visibilityState !== "visible" || t - last < 1000 / L.fps - 1) return;
      last = t;
      const proj = projectRef.current, layer = leaders.current;
      // The viewport is the label layer's own box (an SVG's clientWidth can read 0).
      const view = { w: root.current?.clientWidth ?? 0, h: root.current?.clientHeight ?? 0 };
      const items: LabelItem[] = [];
      for (const m of L.models) {
        const id = m.agent.id, p = positionsRef.current.get(id), s = p && proj && !L.hidden.has(id) ? proj(p, 1) : null, size = sizes.current.get(id);
        if (!s || !size) continue;
        items.push({ id, x: s.x, y: s.y, w: size.w, h: size.h, priority: id === L.selected ? 9 : PRIORITY[m.health.band] });
      }
      // Re-layout only when an anchor moved, a size changed or the view resized (a still Fleet costs nothing).
      const sig = `${view.w}x${view.h}|${L.selected}|` + items.map((i) => `${i.id}:${Math.round(i.x)},${Math.round(i.y)},${i.w},${i.h}`).join(";");
      if (sig === lastSig.current && lastPlaced.current) return;
      lastSig.current = sig;
      const placed = layoutLabels(items, view);
      lastPlaced.current = placed;
      const anchors = new Map(items.map((i) => [i.id, i]));
      for (const [id, el] of els.current) {
        const at = placed.get(id);
        if (!at) { if (el.style.visibility !== "hidden") el.style.visibility = "hidden"; continue; }
        el.style.visibility = "";
        el.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`;
        el.style.zIndex = String(id === L.selected ? 30 : at.overlapping ? 1 : 10 + (anchors.get(id)?.priority ?? 0));
      }
      // Leader lines join staggered labels to their agents.
      if (layer) for (const line of Array.from(layer.children) as SVGLineElement[]) {
        const id = line.dataset.id!, at = placed.get(id), a = anchors.get(id);
        if (!at || !a || !at.displaced) { if (line.getAttribute("visibility") !== "hidden") line.setAttribute("visibility", "hidden"); continue; }
        const lx = Math.min(Math.max(a.x, at.x), at.x + a.w), ly = at.y > a.y ? at.y : at.y + a.h;
        line.setAttribute("visibility", "visible");
        line.setAttribute("x1", a.x.toFixed(0)); line.setAttribute("y1", a.y.toFixed(0)); line.setAttribute("x2", lx.toFixed(0)); line.setAttribute("y2", ly.toFixed(0));
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [positionsRef, projectRef]);

  return <div ref={root} className="pointer-events-none absolute inset-0 overflow-hidden" aria-label="Agents" data-density={density}>
    <svg ref={leaders} className="absolute inset-0 h-full w-full" aria-hidden="true">
      {models.map((m) => <line key={m.agent.id} data-id={m.agent.id} stroke="#475569" strokeWidth={1} visibility="hidden" />)}
    </svg>
    {models.map((m) => {
      const id = m.agent.id, band = m.health.band, isNew = marked.get(id)?.mark ?? false;
      const name = `${m.agent.name}, ${money(m.agent.cash)}, ${m.health.label}, ${m.placement.activity}${isNew ? ", new" : ""}`;
      return <button key={id} type="button" data-band={band}
        ref={(el) => { if (el) { els.current.set(id, el); if (!el.style.transform) el.style.visibility = "hidden"; } else { els.current.delete(id); sizes.current.delete(id); } }}
        onClick={() => { if (!clickSuppressed()) onAgent(id); }} aria-label={name}
        className={`pointer-events-auto absolute left-0 top-0 whitespace-nowrap rounded border leading-tight ${selected === id ? "border-slate-100 bg-slate-900 ring-1 ring-slate-100" : `${EDGE[band]} bg-slate-950/85`} ${isNew ? "outline outline-1 outline-cyan-300" : ""} focus-visible:outline-2 focus-visible:outline-cyan-300 ${density === "compact" && selected !== id ? "px-1 py-0 text-[10px]" : "px-1.5 py-0.5 text-center"}`}>
        {density === "compact" && selected !== id
          ? <span className={band === "CRITICAL" || band === "WOUNDED" ? "font-semibold" : undefined}><span className="text-slate-100">{m.agent.name.length > 14 ? `${m.agent.name.slice(0, 13)}…` : m.agent.name}</span><span className="text-slate-500"> · </span><span className={`font-mono ${band === "DEAD" ? "text-slate-500" : BAND_TEXT[band]}`}>{money(m.agent.cash)}</span></span>
          : <>
            <span className="block max-w-[9rem] truncate text-[11px] text-slate-100">{m.agent.name}{isNew ? " · NEW" : ""}</span>
            <span className="block font-mono text-[11px] text-cyan-300">{money(m.agent.cash)}</span>
            <span className={`block font-mono text-[9px] tracking-wider ${band === "DEAD" ? "text-slate-500" : BAND_TEXT[band]}`}>{m.placement.activity}</span>
          </>}
      </button>;
    })}
  </div>;
});
