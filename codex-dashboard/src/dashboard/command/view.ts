/**
 * What Fleet Command (Formal) and the Virtual Command Centre read, beyond the deck's snapshot. One shape for both modes:
 * the LIVE adapter fills it from the gateway (api/command.ts, existing read operations only); the SIMULATION adapter
 * from its fictional engine. Sections that could not be read are listed in `unavailable` and stay empty — never filled.
 */
import type { Agent } from "../model";
import type { AgentEconomics } from "./economics";
import type { FleetEvent } from "./events";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- gateway JSON rows, narrowed where rendered
export type Row = Record<string, any>;

export interface CommandView {
  mode: "live" | "simulation";
  fetchedAt: string;
  /** 100 % wallet health: the Genesis allocation per agent (settings.genesisCapital.minor); null = unreadable. */
  genesisMinor: number | null;
  currency: string;
  economics: Record<string, AgentEconomics>;
  /** FleetController's event log, newest first (bounded). */
  events: FleetEvent[];
  /** Capital requests with FleetController's decision, reasons, inputs and policy version (hub capital). */
  capital: Row[];
  /** Ventures with their decision records (hub ventures). */
  ventures: Row[];
  opportunities: Row[];
  knowledge: Row[];
  /** Pending owner requests / external dependencies (hub dependencies). */
  dependencies: Row[];
  /** Fleet totals (hub overview). */
  overview: Row | null;
  /** Treasury accounts, 30-day flows, sweep and capital policies (hub treasury). */
  treasury: Row | null;
  /** All policies, population and registry flags (settings). */
  settings: Row | null;
  unavailable: string[];
}

/** The light real-time read: the agents' current state and the latest events. */
export interface Pulse {
  fetchedAt: string;
  agents: Agent[] | null;
  events: FleetEvent[];
}

export const emptyCommandView = (mode: CommandView["mode"]): CommandView => ({
  mode, fetchedAt: "", genesisMinor: null, currency: "GBP", economics: {}, events: [], capital: [], ventures: [], opportunities: [], knowledge: [],
  dependencies: [], overview: null, treasury: null, settings: null, unavailable: [],
});
