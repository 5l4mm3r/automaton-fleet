/**
 * The Command Deck's LIVE wiring: one same-origin gateway client for the tab, the tested LiveFleetAdapter with the
 * deck's mapping, and the session hand-off to /login. Nothing installation-specific: every request is relative (`/api/*`
 * of whatever host serves this build).
 */
import { LOGIN_PATH } from "../base";
import { GatewayClient } from "../api/client";
import { LiveFleetAdapter } from "../adapters/live";
import type { Command, Fleet } from "../model";
import { loadWallets, toFleet, toLiveCommand, type Wallets } from "./mapping";
import { CommandReader } from "../api/command";
import type { CommandView, Pulse, Row } from "../command/view";

let client: GatewayClient | null = null;

/** The tab's gateway client. A 401 anywhere sends the owner to sign-in. */
export function liveClient(): GatewayClient {
  client ??= new GatewayClient({ onSignedOut: () => { if (typeof window !== "undefined" && !location.pathname.startsWith(LOGIN_PATH)) location.replace(LOGIN_PATH); } });
  return client;
}

/** The deck's LIVE adapter: the tested LiveFleetAdapter plus the Fleet Command / Virtual reads (existing operations only). */
export class LiveDeckAdapter extends LiveFleetAdapter<Fleet, Command, Wallets> {
  private readonly reader: CommandReader;
  constructor(c: GatewayClient) {
    super({
      toFleet: (s, wallets) => toFleet(s, wallets),
      toLiveCommand: (cmd, last) => toLiveCommand(cmd, last, c),
      loadExtra: (cl, s) => loadWallets(cl, s),
    }, c);
    this.reader = new CommandReader(c);
  }
  command(): Promise<CommandView> { return this.reader.load(); }
  pulse(): Promise<Pulse> { return this.reader.pulse(); }
  agentLedger(agentId: string): Promise<Row[]> { return this.reader.agentLedger(agentId); }
}

export function createLiveAdapter(): LiveDeckAdapter {
  return new LiveDeckAdapter(liveClient());
}
