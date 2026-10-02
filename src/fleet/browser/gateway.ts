/**
 * Browser worker database gateway (schema v37): the restricted login fleet_browser_login can call only bx_* — claim a
 * browser action under a lease, report it, ask for a credential (answered by the identity broker, sealed to this worker's
 * one-time key) and take it. No table privilege, no vault, no other agent's data.
 */
import pg from "pg";
import type { Pool } from "pg";
import { quoteIdent } from "../postgres/migrations.js";

export interface BrowserAction {
  actionId: string;
  sessionId: string;
  agentId: string;
  kind: "open" | "act" | "observe" | "close";
  steps: Array<Record<string, unknown>>;
  sessionStatus: string;
  accountId?: string;
  origins?: string[];
}

export type BxResult = { ok: true; [k: string]: unknown } | { ok: false; code: string; [k: string]: unknown };

export interface BrowserGatewayPort {
  ping(): Promise<{ schemaVersion: number | null; queued: number }>;
  claim(worker: string, leaseSha256: string): Promise<{ ok: true; action: BrowserAction | null } | { ok: false; code: string }>;
  report(actionId: string, lease: string, ok: boolean, result: Record<string, unknown>, url: string | null): Promise<BxResult>;
  secretRequest(actionId: string, lease: string, kind: string, origin: string, workerPub: string, sealedIn: Buffer | null): Promise<BxResult>;
  secretTake(requestId: string, actionId: string, lease: string): Promise<BxResult>;
  brokerKey(): Promise<{ ownerPub: string | null; fingerprint?: string }>;
}

export class PgBrowserGateway implements BrowserGatewayPort {
  private readonly pool: Pool;
  private readonly s: string;
  constructor(opts: { connectionString: string; schema?: string }) {
    this.s = quoteIdent(opts.schema ?? "fleet");
    this.pool = new pg.Pool({ connectionString: opts.connectionString, max: 2, application_name: "automaton-fleet-browser",
      options: "-c statement_timeout=10000 -c lock_timeout=5000" });
    this.pool.on("error", () => {});
  }
  private async call<T>(fn: string, args: unknown[]): Promise<T> {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    return (await this.pool.query(`SELECT ${this.s}.${fn}(${ph}) AS r`, args)).rows[0].r as T;
  }
  ping() { return this.call<{ schemaVersion: number | null; queued: number }>("bx_ping", []); }
  claim(worker: string, leaseSha256: string) { return this.call<{ ok: true; action: BrowserAction | null } | { ok: false; code: string }>("bx_claim_action", [worker, leaseSha256]); }
  report(actionId: string, lease: string, ok: boolean, result: Record<string, unknown>, url: string | null) {
    return this.call<BxResult>("bx_report_action", [actionId, lease, ok, JSON.stringify(result), url]);
  }
  secretRequest(actionId: string, lease: string, kind: string, origin: string, workerPub: string, sealedIn: Buffer | null) {
    return this.call<BxResult>("bx_secret_request", [actionId, lease, kind, origin, workerPub, sealedIn]);
  }
  secretTake(requestId: string, actionId: string, lease: string) { return this.call<BxResult>("bx_secret_take", [requestId, actionId, lease]); }
  brokerKey() { return this.call<{ ownerPub: string | null; fingerprint?: string }>("bx_broker_key", []); }
  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }
}
