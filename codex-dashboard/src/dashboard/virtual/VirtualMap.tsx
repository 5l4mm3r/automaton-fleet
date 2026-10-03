/**
 * The 2D facility map — a top-down rendering of the same world as the 3D scene. It needs no WebGL (phones, weak devices,
 * browsers without WebGL, "Map" chosen in the display settings). It repaints only when something real moves (agents,
 * packets, the camera easing): no ambient animation, so a still 50-agent Fleet costs nothing per frame. One requestAnimationFrame loop moves agents towards
 * their targets, carries packets and frames the focus by setting SVG attributes directly: no React render per frame, no
 * style attributes (the deck's strict CSP), capped to the chosen frame rate and paused while the tab is hidden.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { Projector } from "./AgentLabels";
import { money } from "../model";
import type { AgentModel } from "../command/agents";
import { DEPARTMENT, DEPARTMENTS, type DepartmentId } from "../command/departments";
import { portraitPng } from "../command/portrait";
import type { VirtualPrefs } from "../command/prefs";
import { focusRect, livePackets, packetAt, WORLD, type Packet, type Point } from "./world";

/** The floor grid as one path (cheaper to repaint than a pattern fill). */
const GRID = (() => {
  let d = "";
  for (let x = WORLD.minX; x <= WORLD.maxX; x += 2) d += `M${x} ${WORLD.minZ}V${WORLD.maxZ}`;
  for (let z = WORLD.minZ; z <= WORLD.maxZ; z += 2) d += `M${WORLD.minX} ${z}H${WORLD.maxX}`;
  return d;
})();

export type Focus = { level: "fleet" } | { level: "department"; id: DepartmentId } | { level: "agent"; id: string };

/** One cached bitmap per agent and condition (cheap to repaint with 50 agents on the map). */
const Portrait = memo(function Portrait({ id, band }: { id: string; band: AgentModel["health"]["band"] }) {
  const href = useMemo(() => portraitPng(id, band), [id, band]);
  return <image href={href} x={-0.5} y={-1.04} width={1} height={1} className="[image-rendering:pixelated]" />;
});

function activate(fn: () => void) {
  return { onClick: fn, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } } };
}

const MapAgent = memo(function MapAgent({ m, selected, mountedAt, register, onAgent }: {
  m: AgentModel; selected: boolean; mountedAt: number; register: (id: string, el: SVGGElement | null, start: Point | null) => void; onAgent: (id: string) => void;
}) {
  // Born while the map is open → walks in from Fleet Command; otherwise appears at its own spot.
  const [start] = useState<Point | null>(() => (Date.now() - mountedAt > 3000 ? { x: DEPARTMENT.command.x, z: DEPARTMENT.command.z } : null));
  const id = m.agent.id;
  const ref = useCallback((el: SVGGElement | null) => register(id, el, start), [register, id, start]);
  return <g ref={ref} role="button" tabIndex={0} aria-label={`${m.agent.name}, ${money(m.agent.cash)}, ${m.health.label}, ${m.placement.activity}`} className="cursor-pointer outline-none"
    opacity={m.agent.status === "dead" ? 0.55 : 1} {...activate(() => onAgent(id))}>
    {selected && <circle r={0.95} fill="none" stroke="#e2e8f0" strokeWidth={0.06} />}
    <Portrait id={id} band={m.health.band} />
  </g>;
});

export function VirtualMap({ models, targets, packets, focus, prefs, selected, onRoom, onAgent, positionsRef, projectRef }: {
  models: AgentModel[]; targets: Map<string, Point>; packets: Packet[]; focus: Focus; prefs: VirtualPrefs; selected: string | null;
  onRoom: (id: DepartmentId) => void; onAgent: (id: string) => void;
  /** Published for the label layer: animated positions and world → screen projection. */
  positionsRef: MutableRefObject<Map<string, Point>>; projectRef: MutableRefObject<Projector | null>;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const agentEls = useRef(new Map<string, SVGGElement>());
  const packetEls = useRef<SVGCircleElement[]>([]);
  const pos = useRef(new Map<string, Point>());
  /** The element each agent's current transform was written to (a remounted element is redrawn). */
  const drawn = useRef(new Map<string, SVGGElement>());
  const packetsOn = useRef(true);
  const view = useRef<{ x: number; z: number; w: number; d: number }>({ x: WORLD.minX, z: WORLD.minZ, w: WORLD.maxX - WORLD.minX, d: WORLD.maxZ - WORLD.minZ });
  const [mountedAt] = useState(() => Date.now());
  const live = useRef({ targets, packets, focus, prefs });
  useEffect(() => { live.current = { targets, packets, focus, prefs }; }, [targets, packets, focus, prefs]);
  /** An agent's element registers here; `start` is where it appears (Fleet Command for a birth), else its own spot. */
  const register = useCallback((id: string, el: SVGGElement | null, start: Point | null) => {
    if (!el) { agentEls.current.delete(id); return; }
    agentEls.current.set(id, el);
    if (start && !pos.current.has(id)) { pos.current.set(id, { ...start }); el.setAttribute("transform", `translate(${start.x} ${start.z})`); }
  }, []);

  useEffect(() => {
    positionsRef.current = pos.current;
    const project: Projector = (p, lift) => {
      const el = svg.current, v = view.current;
      if (!el) return null;
      const W = el.clientWidth, H = el.clientHeight, k = Math.min(W / v.w, H / v.d);
      return { x: (W - v.w * k) / 2 + (p.x - v.x) * k, y: (H - v.d * k) / 2 + (p.z + 0.05 * lift - v.z) * k };
    };
    projectRef.current = project;
    let raf = 0, last = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      const { targets: tg, packets: pk, focus: fc, prefs: pr } = live.current;
      if (document.visibilityState !== "visible" || t - last < 1000 / pr.fps - 1) return;
      const dt = last ? Math.min(0.1, (t - last) / 1000) : 0.016;
      last = t;
      const snap = pr.reduceMotion;
      // Only what changes is written to the DOM: a still Fleet costs no repaint (large Fleets stay smooth).
      // Agents walk towards their department slot (about 4 units per second; snap with reduced motion).
      for (const [id, el] of agentEls.current) {
        const target = tg.get(id);
        if (!target) continue;
        const cur = pos.current.get(id);
        if (cur && cur.x === target.x && cur.z === target.z && drawn.current.get(id) === el) continue;
        const from = cur ?? { ...target };
        const dx = target.x - from.x, dz = target.z - from.z, dist = Math.hypot(dx, dz), step = 4 * dt;
        const next = snap || dist <= step ? { ...target } : { x: from.x + (dx / dist) * step, z: from.z + (dz / dist) * step };
        pos.current.set(id, next);
        drawn.current.set(id, el);
        el.setAttribute("transform", `translate(${next.x.toFixed(3)} ${next.z.toFixed(3)})`);
      }
      // Packets (data flows), only when enabled and motion is allowed; idle circles are written once.
      const now = Date.now();
      const shown = pr.dataFlow && !snap ? livePackets(pk, now, 60) : [];
      if (shown.length || packetsOn.current) {
        packetsOn.current = shown.length > 0;
        packetEls.current.forEach((c, i) => {
          const p = shown[i], at = p ? packetAt(p, now) : null;
          if (!p || !at) { if (c.getAttribute("r") !== "0") c.setAttribute("r", "0"); return; }
          c.setAttribute("cx", at.x.toFixed(3)); c.setAttribute("cy", at.z.toFixed(3)); c.setAttribute("r", "0.28"); c.setAttribute("fill", p.colour);
        });
      }
      // Camera: ease the viewBox towards the focus; stop writing once it has arrived.
      const r = focusRect(fc, pos.current);
      const goal = { x: r.x - r.w / 2, z: r.z - r.d / 2, w: r.w, d: r.d }, v = view.current, k = snap ? 1 : Math.min(1, dt * 4);
      const far = Math.abs(goal.x - v.x) + Math.abs(goal.z - v.z) + Math.abs(goal.w - v.w) + Math.abs(goal.d - v.d);
      if (far > 0.002) {
        if (far < 0.01) { v.x = goal.x; v.z = goal.z; v.w = goal.w; v.d = goal.d; }
        else { v.x += (goal.x - v.x) * k; v.z += (goal.z - v.z) * k; v.w += (goal.w - v.w) * k; v.d += (goal.d - v.d) * k; }
        svg.current?.setAttribute("viewBox", `${v.x.toFixed(3)} ${v.z.toFixed(3)} ${v.w.toFixed(3)} ${v.d.toFixed(3)}`);
      }
    };
    raf = requestAnimationFrame(tick);
    // Clear only what this renderer published (the other renderer may already have taken over).
    return () => { cancelAnimationFrame(raf); if (projectRef.current === project) projectRef.current = null; };
  }, [positionsRef, projectRef]);


  return <svg ref={svg} viewBox={`${WORLD.minX} ${WORLD.minZ} ${WORLD.maxX - WORLD.minX} ${WORLD.maxZ - WORLD.minZ}`} className="h-full w-full select-none" role="group" aria-label="Fleet headquarters map">
    <rect x={WORLD.minX - 5} y={WORLD.minZ - 5} width={WORLD.maxX - WORLD.minX + 10} height={WORLD.maxZ - WORLD.minZ + 10} fill="#030712" />
    <path d={GRID} fill="none" stroke="#0f2236" strokeWidth={0.05} />
    {/* Corridors from Fleet Command to every department (where information travels). */}
    {DEPARTMENTS.filter((d) => d.id !== "command").map((d) => <line key={`c-${d.id}`} x1={0} y1={-15} x2={d.x} y2={d.z} stroke="#0e2a3d" strokeWidth={0.12} />)}
    {DEPARTMENTS.map((d) => <g key={d.id} role="button" tabIndex={0} aria-label={`${d.name}: ${d.purpose}`} className="cursor-pointer outline-none focus-visible:opacity-80" {...activate(() => onRoom(d.id))}>
      <rect x={d.x - d.w / 2} y={d.z - d.d / 2} width={d.w} height={d.d} rx={0.4} fill={d.id === "command" ? "#06182a" : "#071322"} stroke={d.accent} strokeOpacity={focus.level === "department" && focus.id === d.id ? 1 : 0.55} strokeWidth={d.id === "command" ? 0.16 : 0.08} />
      {/* No continuous ambient animation on the map: any animation inside the SVG repaints the whole map every frame. */}
      {d.id === "command" && <circle cx={d.x} cy={d.z} r={1.4} fill="none" stroke={d.accent} strokeWidth={0.1} />}
      <text x={d.x - d.w / 2 + 0.4} y={d.z - d.d / 2 + 0.75} fontSize={0.62} fill={d.accent} className="font-mono tracking-widest">{d.name.toUpperCase()}</text>
    </g>)}
    {models.map((m) => <MapAgent key={m.agent.id} m={m} selected={selected === m.agent.id} mountedAt={mountedAt} register={register} onAgent={onAgent} />)}
    {Array.from({ length: 60 }, (_, i) => <circle key={`p${i}`} ref={(el) => { if (el) packetEls.current[i] = el; }} r={0} />)}
  </svg>;
}
