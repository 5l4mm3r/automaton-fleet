/**
 * The one place an agent's derived presentation state is computed — health band, department and activity — so the
 * Formal Agents list, Fleet Command and the Virtual Command Centre can never disagree.
 */
import type { Agent } from "../model";
import { healthOf, type AgentEconomics, type AgentHealth } from "./economics";
import { latestEventByAgent, placeAgent, type Placement } from "./departments";
import type { CommandView } from "./view";

export interface AgentModel {
  agent: Agent;
  health: AgentHealth;
  placement: Placement;
  econ: AgentEconomics | null;
}

export function deriveAgents(agents: readonly Agent[], view: CommandView | null, now: number = Date.now()): AgentModel[] {
  const latest = latestEventByAgent(view?.events ?? []);
  return agents.map((agent) => {
    const econ = view?.economics[agent.id] ?? null;
    return {
      agent, econ,
      // Without the command view the baseline is unknown: the band says so instead of guessing.
      health: healthOf({ status: agent.status, cash: agent.cash }, econ, view?.genesisMinor ?? null),
      placement: placeAgent({ id: agent.id, status: agent.status, mode: agent.mode, role: agent.role }, latest.get(agent.id), now),
    };
  });
}

/** Merge a pulse's agents into the deck's agents: current status, mode and cash; the snapshot's wallet runway is kept. */
export function mergePulseAgents(current: readonly Agent[], pulse: readonly Agent[] | null): Agent[] {
  if (!pulse) return [...current];
  const prev = new Map(current.map((a) => [a.id, a]));
  return pulse.map((a) => {
    const p = prev.get(a.id);
    return p ? { ...p, status: a.status, cash: a.cash, mode: a.mode, role: a.role, name: a.name } : a;
  });
}
