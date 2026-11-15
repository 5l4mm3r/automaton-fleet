/**
 * LiveFleetAdapter — the owner dashboard's `FleetAdapter` in LIVE mode.
 *
 *   interface FleetAdapter { readonly mode: 'simulation' | 'live'; snapshot(): Promise<Fleet>; execute(command: Command): Promise<Fleet>; }
 *
 * It reads the Fleet through the authenticated dashboard gateway and translates the dashboard's commands into real
 * gateway operations. The backend is authoritative: the adapter never computes balances, eligibility, health or agent
 * survival — `toFleet` only reshapes the gateway's own values into the dashboard's view model.
 *
 * Fail closed: there is NO simulation fallback here (this module imports nothing from the simulation). An unreachable
 * gateway or an ended session is an error the UI must show. After every command the Fleet is re-read; if the command's
 * outcome is unknown (connection lost mid-call) the Fleet is still re-read and FLEET_OUTCOME_UNKNOWN is raised with
 * that fresh state attached, so the owner reviews before acting again.
 *
 * The two mapping functions belong to the dashboard (its Fleet and Command types): `toFleet` must not invent values
 * for unavailable sections, and `toLiveCommand` must return the command's live form (or an unsupported kind).
 */
import { GatewayClient, type GatewayClientOptions } from "../api/client";
import { FleetApiError } from "../api/errors";
import { executeLiveCommand } from "../api/operations";
import { loadLiveSnapshot } from "../api/snapshot";
import type { LiveCommand, LiveSnapshot } from "../api/types";

export interface FleetAdapter<Fleet, Command> {
  readonly mode: "simulation" | "live";
  snapshot(): Promise<Fleet>;
  execute(command: Command): Promise<Fleet>;
}

export interface LiveMapping<Fleet, Command, Extra = undefined> {
  /** Reshape the authoritative snapshot (and any extra reads) into the dashboard's view model. No computed authority. */
  toFleet(snapshot: LiveSnapshot, extra: Extra): Fleet;
  /** The command's live form. `last` is the last authoritative snapshot (e.g. which notifications are unacknowledged). */
  toLiveCommand(command: Command, last: LiveSnapshot | null): LiveCommand | Promise<LiveCommand>;
  /** Optional further gateway reads the view needs (same rules: authoritative values only, unavailable stays unavailable). */
  loadExtra?(client: GatewayClient, snapshot: LiveSnapshot): Promise<Extra>;
}

export class OutcomeUnknownError<Fleet> extends FleetApiError {
  constructor(readonly fleet: Fleet | null) {
    super("FLEET_OUTCOME_UNKNOWN");
  }
}

export class LiveFleetAdapter<Fleet, Command, Extra = undefined> implements FleetAdapter<Fleet, Command> {
  readonly mode = "live" as const;
  readonly client: GatewayClient;
  /** The last authoritative snapshot (for "last updated" display); never substituted for a failed read. */
  last: LiveSnapshot | null = null;

  constructor(private readonly map: LiveMapping<Fleet, Command, Extra>, client?: GatewayClient | GatewayClientOptions) {
    this.client = client instanceof GatewayClient ? client : new GatewayClient(client);
  }

  async snapshot(): Promise<Fleet> {
    const s = await loadLiveSnapshot(this.client);
    const extra = (this.map.loadExtra ? await this.map.loadExtra(this.client, s) : undefined) as Extra;
    this.last = s;
    return this.map.toFleet(s, extra);
  }

  async execute(command: Command): Promise<Fleet> {
    const live = await this.map.toLiveCommand(command, this.last);
    try {
      await executeLiveCommand(this.client, live);
    } catch (e) {
      if (e instanceof FleetApiError && e.code === "FLEET_OUTCOME_UNKNOWN") {
        const fresh = await this.snapshot().catch(() => null);
        throw new OutcomeUnknownError(fresh);
      }
      throw e;
    }
    return this.snapshot();
  }
}
