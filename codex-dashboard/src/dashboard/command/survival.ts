/**
 * Survival as a DISPLAY (owner-approved 2026-10-13): levels, time alive, time on the current activity, the side list's
 * order and the Hall of Survivors. Computed only from the reading's own times (creation, death, the event or state that
 * placed the agent); an unknown time is shown as —, never estimated. Levels unlock nothing and change nothing.
 */
import type { Agent } from "../model";
import type { AgentModel } from "./agents";
import { levelOf } from "./departments";

export interface RailEntry { id: string; level: number | null; aliveMs: number | null; onActivityMs: number | null }

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/** One living agent's side-list figures at `now`. */
export function railEntry(m: AgentModel, now: number = Date.now()): RailEntry {
  const born = ms(m.agent.createdAt), since = m.placement.since;
  return {
    id: m.agent.id, level: levelOf(m.agent.createdAt, now),
    aliveMs: Number.isFinite(born) && now >= born ? now - born : null,
    onActivityMs: since != null && Number.isFinite(since) && now >= since ? now - since : null,
  };
}

/**
 * The side list: LIVING agents only, the longest survivors first (unknown creation time last), then by name and id —
 * deterministic for the same reading.
 */
export function railOrder(models: readonly AgentModel[], now: number = Date.now()): Array<{ m: AgentModel; e: RailEntry }> {
  return models.filter((m) => m.agent.status !== "dead").map((m) => ({ m, e: railEntry(m, now) })).sort((a, b) =>
    (b.e.aliveMs ?? -1) - (a.e.aliveMs ?? -1) || a.m.agent.name.localeCompare(b.m.agent.name) || (a.m.agent.id < b.m.agent.id ? -1 : 1));
}

export interface Survivor { id: string; name: string; createdAt: string | null; diedAt: string | null; lifespanMs: number | null; level: number | null }

/** Every agent that has died, with how long it survived (null when either time is unknown), the longest first. */
export function hallOfSurvivors(agents: readonly Agent[]): Survivor[] {
  return agents.filter((a) => a.status === "dead").map((a) => {
    const b = ms(a.createdAt), d = ms(a.diedAt), known = Number.isFinite(b) && Number.isFinite(d) && d >= b;
    return { id: a.id, name: a.name, createdAt: a.createdAt ?? null, diedAt: a.diedAt ?? null, lifespanMs: known ? d - b : null, level: known ? levelOf(a.createdAt, d) : null };
  }).sort((x, y) => (y.lifespanMs ?? -1) - (x.lifespanMs ?? -1) || (x.id < y.id ? -1 : 1));
}
