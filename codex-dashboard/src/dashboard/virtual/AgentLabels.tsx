/**
 * Agent labels (name, wallet, activity) as an HTML layer over either renderer, at a fixed readable size whatever the
 * zoom. The active renderer publishes each agent's animated position and a projection to screen pixels; one capped
 * requestAnimationFrame loop places the labels (transform via CSSOM — no style attributes, the deck's strict CSP).
 * Labels are buttons, so agents are reachable by keyboard and screen reader in both renderers.
 * With many agents in the Fleet view only the selected agent's label shows, so labels never pile up unreadably.
 */
import { memo, useEffect, useRef, type MutableRefObject } from "react";
import { money } from "../model";
import type { AgentModel } from "../command/agents";
import { BAND_TEXT } from "../command/economics";
import type { VirtualPrefs } from "../command/prefs";
import type { Point } from "./world";

export type Projector = (p: Point, lift: number) => { x: number; y: number } | null;
export const COMPACT_ABOVE = 16;

export const AgentLabels = memo(function AgentLabels({ models, positionsRef, projectRef, prefs, selected, fleetView, onAgent }: {
  models: AgentModel[]; positionsRef: MutableRefObject<Map<string, Point>>; projectRef: MutableRefObject<Projector | null>; prefs: VirtualPrefs;
  selected: string | null; fleetView: boolean; onAgent: (id: string) => void;
}) {
  const els = useRef(new Map<string, HTMLButtonElement>());
  const fps = useRef(prefs.fps);
  useEffect(() => { fps.current = prefs.fps; }, [prefs.fps]);
  useEffect(() => {
    let raf = 0, last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (document.visibilityState !== "visible" || t - last < 1000 / fps.current - 1) return;
      last = t;
      const proj = projectRef.current;
      for (const [id, el] of els.current) {
        const p = positionsRef.current.get(id), s = p && proj ? proj(p, 1) : null;
        if (!s) { el.style.visibility = "hidden"; continue; }
        el.style.visibility = "";
        el.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, 0)`;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [positionsRef, projectRef]);

  const compact = fleetView && models.length > COMPACT_ABOVE;
  return <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-label="Agents">
    {models.filter((m) => !compact || m.agent.id === selected).map((m) => <button key={m.agent.id} type="button"
      ref={(el) => { if (el) { els.current.set(m.agent.id, el); el.style.visibility = "hidden"; } else els.current.delete(m.agent.id); }}
      onClick={() => onAgent(m.agent.id)}
      aria-label={`${m.agent.name}, ${money(m.agent.cash)}, ${m.health.label}, ${m.placement.activity}`}
      className={`pointer-events-auto absolute left-0 top-0 max-w-[9rem] rounded border px-1.5 py-0.5 text-center leading-tight ${selected === m.agent.id ? "border-slate-200 bg-slate-900" : "border-slate-700 bg-slate-950/85"} focus-visible:outline-2 focus-visible:outline-cyan-300`}>
      <span className="block truncate text-[11px] text-slate-100">{m.agent.name}</span>
      <span className="block font-mono text-[11px] text-cyan-300">{money(m.agent.cash)}</span>
      <span className={`block font-mono text-[9px] tracking-wider ${m.agent.status === "dead" ? "text-slate-500" : BAND_TEXT[m.health.band]}`}>{m.placement.activity}</span>
    </button>)}
  </div>;
});
