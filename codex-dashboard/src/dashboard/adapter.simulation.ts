/** SIMULATION build's implementation (selected by the `@fleet/adapter-impl` alias in next.config.ts). No gateway code. */
import { SimulationDeckAdapter } from "./adapters/simulation-command";
import type { DeckAdapter, LiveTools } from "./adapter";

export const createAdapterImpl = (): DeckAdapter => new SimulationDeckAdapter();
export const liveTools: LiveTools | null = null;
