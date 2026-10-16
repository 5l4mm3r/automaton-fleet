"use client";
/**
 * The specialist crew and idle strolling in the Command Centre's HTML layers (owner, 2026-10-16):
 *   · useCrew — the crew's desks from the `helpers` read (command/helpers.ts crewOf), re-evaluated each second but
 *     re-rendering only when a desk wakes, finishes or falls asleep (no extra polling: the read comes with the pulse);
 *   · useStrolling — which idle agents are away from their own place right now (from the renderer's own positions), so
 *     their labels can say "idle · strolling" — a cosmetic walk is never shown as work;
 *   · CrewLabels — a small tag over each WORKING specialist in the focused room: role and seat, what it is doing for
 *     which agent, and for how long (separate from the agent labels: their layout is untouched);
 *   · CrewSection — the department panel's honest summary and desk list.
 * Specialists are not agents: no wallet, no level, never in the roster or any agent count.
 */
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { AgentModel } from "../command/agents";
import type { DepartmentId } from "../command/departments";
import { crewOf, crewSignature, crewSummary, deskLine, DONE_WORDS, elapsed, HELPER_LINGER_MS, ROLE_COLOUR, ROLE_NAME, todayLine, type Crew, type HelperRead } from "../command/helpers";
import { placeDesks, type PlacedDesk } from "./hq/crew-layout";
import { mayWander } from "./hq/wander";
import type { Projector } from "./AgentLabels";
import type { Point } from "./world";

/** The crew at this moment (a 1 s clock; a new object only when what the desks show changes). */
export function useCrew(read: HelperRead | null | undefined, models: readonly AgentModel[]): { crew: Crew; placed: PlacedDesk[] } {
  const [crew, setCrew] = useState<Crew>(() => crewOf(read, models, Date.now()));
  const sig = useRef(crewSignature(crew));
  useEffect(() => {
    const update = () => { const c = crewOf(read, models, Date.now()), s = crewSignature(c); if (s !== sig.current) { sig.current = s; setCrew(c); } };
    const first = setTimeout(update, 0), timer = setInterval(update, 1_000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [read, models]);
  const placed = useMemo(() => placeDesks(crew.desks), [crew]);
  return { crew, placed };
}

/** An idle agent counts as strolling while it is more than this far (m) from its own place. */
export const STROLL_AWAY_M = 0.75;

/** Idle agents currently away from their own place (strolling), from the renderer's animated positions. */
export function strollingOf(models: readonly AgentModel[], homes: ReadonlyMap<string, Point>, positions: ReadonlyMap<string, Point>, teams: ReadonlyMap<string, string>, reduceMotion: boolean): Set<string> {
  const out = new Set<string>();
  if (reduceMotion) return out;
  for (const m of models) {
    const id = m.agent.id, home = homes.get(id), p = positions.get(id);
    if (!home || !p || !mayWander(m.agent.status, m.placement.basis, teams.has(id))) continue;
    if (Math.hypot(p.x - home.x, p.z - home.z) > STROLL_AWAY_M) out.add(id);
  }
  return out;
}

export function useStrolling(models: readonly AgentModel[], homes: ReadonlyMap<string, Point>, positionsRef: MutableRefObject<Map<string, Point>>, teams: ReadonlyMap<string, string>, reduceMotion: boolean): ReadonlySet<string> {
  const [set, setSet] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const tick = () => {
      const next = strollingOf(models, homes, positionsRef.current, teams, reduceMotion);
      setSet((prev) => (prev.size === next.size && [...next].every((id) => prev.has(id)) ? prev : next));
    };
    const first = setTimeout(tick, 0), timer = setInterval(tick, 1_000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [models, homes, positionsRef, teams, reduceMotion]);
  return set;
}

/** Tags over the working specialists of the focused room (none in the Fleet view; the side panel has the summary). */
export function CrewLabels({ desks, room, projectRef, fps }: { desks: readonly PlacedDesk[]; room: DepartmentId | null; projectRef: MutableRefObject<Projector | null>; fps: number }) {
  const shown = useMemo(() => (room ? desks.filter((d) => d.desk.job && d.desk.department === room) : []), [desks, room]);
  const els = useRef(new Map<string, HTMLDivElement>()), timers = useRef(new Map<string, HTMLSpanElement>());
  useEffect(() => {
    let raf = 0, last = 0, lastText = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (document.visibilityState !== "visible" || t - last < 1000 / fps - 1) return;
      last = t;
      const proj = projectRef.current, placed: Array<{ x: number; y: number; w: number; h: number }> = [];
      for (const d of shown) {
        const el = els.current.get(d.desk.key), s = proj ? proj(d.seat, 2, 1.75) : null;
        if (!el) continue;
        if (!s) { el.style.visibility = "hidden"; continue; }
        const w = el.offsetWidth, h = el.offsetHeight;
        const x = s.x - w / 2;
        let y = s.y - h;
        // Keep crew tags off each other (simple downward stagger); agent labels are a separate layer and unaffected.
        for (let k = 0; k < 6 && placed.some((r) => x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y); k++) y += h + 2;
        placed.push({ x, y, w, h });
        el.style.visibility = ""; el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      }
      if (t - lastText > 500) {
        lastText = t;
        const now = Date.now();
        for (const d of shown) { const sp = timers.current.get(d.desk.key), j = d.desk.job; if (sp && j) sp.textContent = j.phase === "working" ? (j.startedAt !== null ? elapsed(now - j.startedAt) : "start not recorded") : `${DONE_WORDS[j.phase]} ${elapsed(now - (j.finishedAt ?? now))} ago`; }
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [shown, projectRef, fps]);
  if (!shown.length) return null;
  return <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden" aria-label="Working specialists">
    {shown.map((d) => { const j = d.desk.job!; return <div key={d.desk.key} ref={(el) => { if (el) { els.current.set(d.desk.key, el); if (!el.style.transform) el.style.visibility = "hidden"; } else els.current.delete(d.desk.key); }}
      className="absolute left-0 top-0 max-w-[15rem] rounded border border-slate-600 bg-slate-950/85 px-1.5 py-0.5 text-[10px] leading-tight text-slate-200" data-crew-label={d.desk.key}>
      <span className="block font-mono uppercase tracking-wider" style={{ color: ROLE_COLOUR[d.desk.role] }}>{ROLE_NAME[d.desk.role]} {d.desk.seat} · specialist</span>
      <span className="block truncate">{j.text}</span>
      <span className="block font-mono text-slate-400">{j.phase === "working" ? "working · " : ""}<span ref={(el) => { if (el) timers.current.set(d.desk.key, el); else timers.current.delete(d.desk.key); }} /></span>
    </div>; })}
  </div>;
}

/** The department panel's crew section: the honest summary, then each desk of this room (ticking once a second). */
export function CrewSection({ crew, dep }: { crew: Crew; dep: DepartmentId }) {
  const desks = crew.desks.filter((d) => d.department === dep);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(t); }, []);
  if (!desks.length) return null;
  const t = crew.today;
  return <section className="mt-5" aria-label="Specialists">
    <h4 className="mb-2 text-xs tracking-widest text-cyan-300">SPECIALISTS (NOT AGENTS)</h4>
    <p className="text-sm text-slate-200">{crewSummary(crew, dep)}</p>
    {t && <p className="mt-1 text-xs text-slate-400">{todayLine(t)}</p>}
    <ul className="mt-2 space-y-1 text-sm">{desks.map((d) => <li key={d.key} className="flex gap-2 rounded border border-slate-800 px-2 py-1">
      <span className="w-32 shrink-0 font-mono text-xs uppercase" style={{ color: ROLE_COLOUR[d.role] }}>{ROLE_NAME[d.role]} {d.seat}</span>
      <span className={d.job ? "text-slate-100" : "text-slate-500"}>{deskLine(d, now)}</span></li>)}</ul>
    <p className="mt-2 text-xs text-slate-400">A specialist wakes only while a real helper job of its kind is running (and stays lit {HELPER_LINGER_MS / 1000} s after it finishes); asleep it is only a picture — no model is running or charging. Each desk shows the purpose the agent recorded for the job; a job without a recorded purpose (an agent on an older runtime) wakes no desk and is counted instead.</p>
  </section>;
}
