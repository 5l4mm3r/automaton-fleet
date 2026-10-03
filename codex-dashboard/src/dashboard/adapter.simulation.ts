/** SIMULATION build's implementation (selected by the `@fleet/adapter-impl` alias in next.config.ts). No gateway code. */
import { SimulationAdapter } from "./adapters/simulation";
import type { DeckAdapter, LiveTools } from "./adapter";

export const createAdapterImpl = (): DeckAdapter => new SimulationAdapter();
export const liveTools: LiveTools | null = null;
