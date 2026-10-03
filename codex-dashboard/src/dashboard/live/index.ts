/**
 * The Command Deck's LIVE wiring: one same-origin gateway client for the tab, the tested LiveFleetAdapter with the
 * deck's mapping, and the session hand-off to /login. Nothing installation-specific: every request is relative (`/api/*`
 * of whatever host serves this build).
 */
import { GatewayClient } from "../api/client";
import { LiveFleetAdapter } from "../adapters/live";
import type { Command, Fleet } from "../model";
import { loadWallets, toFleet, toLiveCommand, type Wallets } from "./mapping";

let client: GatewayClient | null = null;

/** The tab's gateway client. A 401 anywhere sends the owner to sign-in. */
export function liveClient(): GatewayClient {
  client ??= new GatewayClient({ onSignedOut: () => { if (typeof window !== "undefined" && !location.pathname.startsWith("/login")) location.replace("/login/"); } });
  return client;
}

export function createLiveAdapter(): LiveFleetAdapter<Fleet, Command, Wallets> {
  const c = liveClient();
  return new LiveFleetAdapter<Fleet, Command, Wallets>({
    toFleet: (s, wallets) => toFleet(s, wallets),
    toLiveCommand: (cmd, last) => toLiveCommand(cmd, last, c),
    loadExtra: (cl, s) => loadWallets(cl, s),
  }, c);
}
