/**
 * The one place the deck gets its adapter and its LIVE-only tools — chosen at BUILD time. `@fleet/adapter-impl` resolves
 * (next.config.ts) to adapter.live.ts in a LIVE build and to adapter.simulation.ts otherwise, so each build physically
 * contains one implementation: a LIVE build has no simulation engine or fictional data; a SIMULATION build has no gateway
 * client (its `liveTools` is null). There is no runtime switch and no fallback from one to the other.
 */
import type { ComponentType } from "react";
import type { Command, Fleet } from "./model";
import type { CommandView, Pulse, Row } from "./command/view";
import type { LiveAuth } from "./api/auth";
import type { loadAgentDetail } from "./api/snapshot";
import type { RevealKind } from "./api/reveal";
import type { GatewayClient, StepupConfirm } from "./api/client";
import { createAdapterImpl, liveTools as impl } from "@fleet/adapter-impl";

export interface DeckAdapter {
  readonly mode: "simulation" | "live";
  snapshot(): Promise<Fleet>;
  execute(command: Command): Promise<Fleet>;
  /** Fleet Command / Virtual reads: economics, the event log, decisions, ventures, knowledge, policies. */
  command(): Promise<CommandView>;
  /** The light real-time read: current agents and the latest events. Reads only; never replays a write. */
  pulse(): Promise<Pulse>;
  /** One agent's recent ledger journals (newest first). */
  agentLedger(agentId: string): Promise<Row[]>;
}

/** Everything the deck needs only in LIVE mode (null in a simulation build). */
export interface LiveTools {
  auth(): LiveAuth;
  agentDetail(agentId: string): ReturnType<typeof loadAgentDetail>;
  logout(): Promise<void>;
  /** The fresh authoritative Fleet attached to an unknown-outcome error, if `e` is one. */
  outcomeUnknownFleet(e: unknown): Fleet | null | undefined;
  Reveal: ComponentType<{ kind: RevealKind; target: string; title: string; close: () => void }>;
  /** v43: how this tab asks the owner to confirm a sensitive operation (passkey, or password + authenticator code). */
  setStepupConfirm(fn: StepupConfirm | null): void;
  /** v48–v50: the gateway client itself, for the treasury, onboarding and footprint panels (reads and step-up operations). */
  gateway(): GatewayClient;
}

export const liveTools: LiveTools | null = impl;

export function createAdapter(): DeckAdapter {
  return createAdapterImpl();
}
