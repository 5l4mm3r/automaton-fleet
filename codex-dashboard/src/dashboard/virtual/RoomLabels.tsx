"use client";
/**
 * Fleet view room plaques: every room's canonical name (departments.ts — static architectural metadata, never live
 * activity) on a restrained plaque at the room's top-left wall corner, in the room's accent. Hover/focus strengthens
 * it and adds the room's one-line purpose; click/tap enters the room. Plaques sit above agent labels (room identity
 * stays legible), below the location line, controls and activity feed. Positioned by a requestAnimationFrame loop
 * through CSSOM (the deck's strict CSP allows no style attributes).
 *
 * Each plaque also reports its room's on-screen footprint (data-onscreen: all four floor corners inside the viewport;
 * data-cx/cy: the floor centre; data-fx/fy: open floor just inside the entrance; data-w: the projected width) — what "the whole facility is reachable" means, testable.
 */
import { memo, useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { DEPARTMENTS, type DepartmentId } from "../command/departments";
import type { Projector } from "./AgentLabels";
import { WALL_H } from "./hq/world-build";
import { clickSuppressed } from "./hq/nav-state";

export const RoomLabels = memo(function RoomLabels({ projectRef, visible, hovered, onHover, onRoom }: {
  projectRef: MutableRefObject<Projector | null>; visible: boolean; hovered: DepartmentId | null;
  onHover: (id: DepartmentId | null) => void; onRoom: (id: DepartmentId) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<DepartmentId, HTMLButtonElement>());
  useEffect(() => { for (const d of DEPARTMENTS) { const el = els.current.get(d.id); if (el) el.style.borderLeftColor = d.accent; } }, []);
  useEffect(() => {
    let raf = 0, last = "";
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const proj = projectRef.current, W = root.current?.clientWidth ?? 0, H = root.current?.clientHeight ?? 0;
      if (!proj || !W) return;
      let sig = `${W}x${H}`;
      const placed: Array<[HTMLButtonElement, number, number, string, string, string, string, string, string]> = [];
      for (const d of DEPARTMENTS) {
        const el = els.current.get(d.id); if (!el) continue;
        const x0 = d.x - d.w / 2, x1 = d.x + d.w / 2, z0 = d.z - d.d / 2, z1 = d.z + d.d / 2;
        const a = proj({ x: x0 + 0.3, z: z0 }, 0, WALL_H + 0.25);
        const cs = [proj({ x: x0, z: z0 }, 0, 0.12), proj({ x: x1, z: z0 }, 0, 0.12), proj({ x: x0, z: z1 }, 0, 0.12), proj({ x: x1, z: z1 }, 0, 0.12)];
        const c = proj({ x: d.x, z: d.z }, 0, 0.12), fl = proj({ x: d.x + 1.1, z: z1 - 0.7 }, 0, 0.12); // fl: open floor inside the entrance
        const on = cs.every((p) => p && p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H) ? "1" : "0";
        const w = cs[2] && cs[3] ? Math.round(cs[3].x - cs[2].x) : 0;
        const sx = (p: { x: number; y: number } | null, k: "x" | "y") => (p ? String(Math.round(p[k])) : "");
        if (!a) { placed.push([el, -9999, -9999, on, "", "", String(w), "", ""]); continue; }
        placed.push([el, Math.round(a.x), Math.round(a.y), on, sx(c, "x"), sx(c, "y"), String(w), sx(fl, "x"), sx(fl, "y")]);
        sig += `|${d.id}:${Math.round(a.x)},${Math.round(a.y)},${on},${w}`;
      }
      if (sig === last) return;
      last = sig;
      for (const [el, x, y, on, cx, cy, w, fx, fy] of placed) {
        el.style.transform = `translate(${x}px, ${y - el.offsetHeight}px)`;
        el.dataset.onscreen = on; el.dataset.cx = cx; el.dataset.cy = cy; el.dataset.w = w; el.dataset.fx = fx; el.dataset.fy = fy;
        // Narrow rooms on small screens get the compact plaque (same name, smaller type).
        el.dataset.compact = Number(w) < 120 ? "1" : "0";
        // A plaque never extends past its own room on screen (wrapping instead), so neighbours never collide.
        el.style.maxWidth = `${Math.max(44, Number(w) - 4)}px`;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [projectRef]);

  return <div ref={root} aria-label="Rooms" className={`pointer-events-none absolute inset-0 z-40 overflow-hidden ${visible ? "" : "invisible"}`}>
    {DEPARTMENTS.map((d) => {
      const on = hovered === d.id;
      return <button key={d.id} ref={(el) => { if (el) els.current.set(d.id, el); else els.current.delete(d.id); }} type="button"
        aria-label={`${d.name} — ${d.purpose}`} data-room={d.id} tabIndex={visible ? 0 : -1}
        onClick={() => { if (!clickSuppressed()) onRoom(d.id); }} onPointerEnter={() => onHover(d.id)} onPointerLeave={() => onHover(null)}
        onFocus={() => onHover(d.id)} onBlur={() => onHover(null)}
        className={`group pointer-events-auto absolute left-0 top-0 max-w-[16rem] select-none rounded-sm border-l-2 px-2 py-0.5 text-left shadow-md shadow-black/40 transition-colors data-[compact=1]:px-1.5 ${on ? "bg-slate-900/95 ring-1 ring-slate-500/60" : "bg-slate-950/70"}`}>
        <span className={`block font-semibold uppercase leading-4 tracking-[0.16em] group-data-[compact=1]:text-[9px] group-data-[compact=1]:leading-3 group-data-[compact=1]:tracking-[0.08em] ${on ? "text-white text-[12px]" : "text-slate-200 text-[11px]"}`}>{d.name}</span>
        {/* The purpose floats under the plaque (not limited to the room's width), shown on hover/focus at every size. */}
        {on && <span role="note" className="absolute left-0 top-full z-10 mt-1 w-max max-w-[18rem] rounded-sm border border-slate-700 bg-slate-950/95 px-2 py-1 text-[11px] font-normal normal-case leading-4 tracking-normal text-slate-200 shadow-lg shadow-black/50">{d.purpose}</span>}
      </button>;
    })}
  </div>;
});
