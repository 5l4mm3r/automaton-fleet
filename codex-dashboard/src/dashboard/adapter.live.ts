/** LIVE build's implementation (selected by the `@fleet/adapter-impl` alias in next.config.ts). */
import { LiveAuth } from "./api/auth";
import { loadAgentDetail } from "./api/snapshot";
import { OutcomeUnknownError } from "./adapters/live";
import { createLiveAdapter, liveClient } from "./live";
import { LiveReveal } from "./live/reveal-dialog";
import type { DeckAdapter, LiveTools } from "./adapter";
import type { Fleet } from "./model";

export const createAdapterImpl = (): DeckAdapter => createLiveAdapter();

export const liveTools: LiveTools = {
  auth: () => new LiveAuth(liveClient()),
  agentDetail: (agentId) => loadAgentDetail(liveClient(), agentId),
  logout: () => new LiveAuth(liveClient()).logout(),
  outcomeUnknownFleet: (e) => (e instanceof OutcomeUnknownError ? (e.fleet as Fleet | null) : undefined),
  Reveal: LiveReveal,
  setStepupConfirm: (fn) => { liveClient().stepupConfirm = fn; },
  gateway: () => liveClient(),
};
