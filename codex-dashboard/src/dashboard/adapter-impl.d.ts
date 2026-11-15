/** `@fleet/adapter-impl` is bound at build time (next.config.ts) to adapter.live.ts or adapter.simulation.ts. */
declare module "@fleet/adapter-impl" {
  import type { DeckAdapter, LiveTools } from "./adapter";
  export const createAdapterImpl: () => DeckAdapter;
  export const liveTools: LiveTools | null;
}
