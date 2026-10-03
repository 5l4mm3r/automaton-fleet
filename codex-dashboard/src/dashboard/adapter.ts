/**
 * The one place the deck gets its adapter and its LIVE-only tools — chosen at BUILD time. `@fleet/adapter-impl` resolves
 * (next.config.ts) to adapter.live.ts in a LIVE build and to adapter.simulation.ts otherwise, so each build physically
 * contains one implementation: a LIVE build has no simulation engine or fictional data; a SIMULATION build has no gateway
 * client (its `liveTools` is null). There is no runtime switch and no fallback from one to the other.
 */
import type { ComponentType } from "react";
import type { Command, Fleet } from "./model";
import type { LiveAuth } from "./api/auth";
import type { loadAgentDetail } from "./api/snapshot";
import type { RevealKind } from "./api/reveal";
import { createAdapterImpl, liveTools as impl } from "@fleet/adapter-impl";

export interface DeckAdapter {
  readonly mode: "simulation" | "live";
  snapshot(): Promise<Fleet>;
  execute(command: Command): Promise<Fleet>;
}

/** Everything the deck needs only in LIVE mode (null in a simulation build). */
export interface LiveTools {
  auth(): LiveAuth;
  agentDetail(agentId: string): ReturnType<typeof loadAgentDetail>;
  logout(): Promise<void>;
  /** The fresh authoritative Fleet attached to an unknown-outcome error, if `e` is one. */
  outcomeUnknownFleet(e: unknown): Fleet | null | undefined;
  Reveal: ComponentType<{ kind: RevealKind; target: string; title: string; close: () => void }>;
}

export const liveTools: LiveTools | null = impl;

export function createAdapter(): DeckAdapter {
  return createAdapterImpl();
}
