/**
 * The side list (owner-approved 2026-10-13): every LIVING agent — portrait, name, level, what it is doing and where, how
 * long it has been at it, how long it has been alive — longest survivors first (survival.ts). Selecting an entry focuses
 * the camera on that agent through the Command Centre's existing focus (the 3D camera flies to it; the map frames it).
 *
 * Fleet Command heads the list: the hub's own level (days since the Fleet's first agent + 1). Levels are a display of
 * time survived only — nothing unlocks. Times the reading does not supply read —; nothing is estimated.
 */
import { memo } from "react";
import type { AgentModel } from "../command/agents";
import { AgentPortrait } from "../command/AgentPortrait";
import { DEPARTMENT, fleetLevel, span } from "../command/departments";
import { railOrder } from "../command/survival";
import type { Agent } from "../model";
import { SLEEP_MARK } from "./AgentLabels";

export const AgentRail = memo(function AgentRail({ models, all, selected, now, onAgent, onCommand }: {
  /** The derived agents (living ones are listed). */
  models: readonly AgentModel[];
  /** Every agent ever recorded (the dead included) — for Fleet Command's age. */
  all: readonly Agent[];
  selected: string | null; now: number;
  onAgent: (id: string) => void; onCommand: () => void;
}) {
  const rows = railOrder(models, now), hub = fleetLevel(all, now);
  return <nav aria-label="Living agents" className="flex max-h-[62vh] flex-col overflow-hidden rounded-2xl border border-fuchsia-900/60 bg-slate-950/95">
    <button type="button" onClick={onCommand} className="flex items-center justify-between gap-2 border-b border-fuchsia-900/60 bg-slate-900/80 px-3 py-2 text-left hover:bg-slate-800/80">
      <span><span className="block text-[10px] uppercase tracking-[0.25em] text-sky-300">The hub</span><span className="block text-sm font-semibold uppercase tracking-[0.18em] text-white">Fleet Command</span></span>
      <span className="font-mono text-xs text-fuchsia-300">{hub ? `Lv ${hub}` : "Lv —"}</span>
    </button>
    <p className="border-b border-slate-800 px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-slate-400">{rows.length} alive · longest survivors first</p>
    <ol className="flex-1 overflow-y-auto">
      {rows.map(({ m, e }) => {
        const a = m.agent, sleep = m.placement.basis === "sleep" && a.sleep ? SLEEP_MARK[a.sleep] : null, on = selected === a.id;
        return <li key={a.id}>
          <button type="button" data-agent={a.id} aria-current={on ? "true" : undefined} onClick={() => onAgent(a.id)}
            aria-label={`${a.name}${e.level ? `, level ${e.level}` : ""}, ${m.placement.activity} in ${DEPARTMENT[m.placement.department].name}, for ${span(e.onActivityMs)}, alive ${span(e.aliveMs)}`}
            className={`flex w-full items-center gap-2 border-b border-slate-900 px-2 py-1.5 text-left ${on ? "bg-fuchsia-950/60 ring-1 ring-inset ring-fuchsia-400/70" : "hover:bg-slate-900"}`}>
            <AgentPortrait id={a.id} name={a.name} band={m.health.band} size={40} />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2"><span className="truncate text-[12px] font-semibold text-slate-100">{a.name}</span><span className="shrink-0 font-mono text-[11px] text-fuchsia-300">{e.level ? `Lv ${e.level}` : "Lv —"}</span></span>
              <span className={`block truncate font-mono text-[10px] tracking-wider ${sleep ? sleep.text : "text-cyan-300"}`}>{sleep ? `${sleep.glyph} ` : ""}{m.placement.activity} · {DEPARTMENT[m.placement.department].name}</span>
              <span className="flex justify-between gap-2 font-mono text-[10px] text-slate-400"><span>on it {span(e.onActivityMs)}</span><span>alive {span(e.aliveMs)}</span></span>
            </span>
          </button>
        </li>;
      })}
      {!rows.length && <li className="px-3 py-3 text-sm text-slate-400">No living agents.</li>}
    </ol>
  </nav>;
});
