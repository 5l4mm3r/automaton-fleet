/**
 * The one place an agent's derived presentation state is computed — health band, department and activity — so the
 * Formal Agents list, Fleet Command and the Virtual Command Centre can never disagree.
 */
import type { Agent } from "../model";
import { healthOf, type AgentEconomics, type AgentHealth } from "./economics";
import { activityByAgent, placeAgent, type Placement } from "./departments";
import { restOf, type Rest } from "./rest";
import type { CommandView } from "./view";

export interface AgentModel {
  agent: Agent;
  health: AgentHealth;
  placement: Placement;
  /** The owner's pause / the agent's own rest report (with its freshness). */
  rest: Rest;
  econ: AgentEconomics | null;
}

export function deriveAgents(agents: readonly Agent[], view: CommandView | null, now: number = Date.now()): AgentModel[] {
  const latest = activityByAgent(view?.events ?? []);
  return agents.map((agent) => {
    const econ = view?.economics[agent.id] ?? null, rest = restOf(agent, now), t = (iso?: string | null) => { const v = iso ? Date.parse(iso) : NaN; return Number.isFinite(v) ? v : null; };
    return {
      agent, econ, rest,
      // Without the command view the baseline is unknown: the band says so instead of guessing.
      health: healthOf({ status: agent.status, cash: agent.cash }, econ, view?.genesisMinor ?? null),
      placement: placeAgent({ id: agent.id, status: agent.status, mode: agent.mode, role: agent.role, sleep: rest.sleep, sleepSince: rest.since,
        missionSince: t(agent.missionSince), heldSince: t(agent.heldSince) }, latest.get(agent.id), now),
    };
  });
}

/** Merge a pulse's agents into the deck's agents: current status, mode, cash and presence; the snapshot's wallet runway is kept. */
export function mergePulseAgents(current: readonly Agent[], pulse: readonly Agent[] | null): Agent[] {
  if (!pulse) return [...current];
  const prev = new Map(current.map((a) => [a.id, a]));
  return pulse.map((a) => {
    const p = prev.get(a.id);
    return p ? { ...p, status: a.status, cash: a.cash, mode: a.mode, role: a.role, name: a.name,
      paused: a.paused ?? null, pausedSince: a.pausedSince ?? null, hibernation: a.hibernation ?? null, missionSince: a.missionSince ?? null, heldSince: a.heldSince ?? null,
      createdAt: a.createdAt ?? p.createdAt ?? null, diedAt: a.diedAt ?? p.diedAt ?? null } : a;
  });
}
