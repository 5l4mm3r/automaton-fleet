/**
 * Browser worker database gateway (schema v37): the restricted login fleet_browser_login can call only bx_* — claim a
 * browser action under a lease, report it, ask for a credential (answered by the identity broker, sealed to this worker's
 * one-time key) and take it. No table privilege, no vault, no other agent's data. v79: read a file the acting agent staged
 * for an upload (bx_file_take) and store what a page produced — a download, a screenshot, a printed PDF — for that agent
 * (bx_file_put).
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
  /** v80: under an owner's scoped release (sales closed), outward steps run only on these origins; absent = unrestricted. */
  outwardOrigins?: string[];
}

export type BxResult = { ok: true; [k: string]: unknown } | { ok: false; code: string; [k: string]: unknown };

export interface BrowserGatewayPort {
  ping(): Promise<{ schemaVersion: number | null; queued: number }>;
  claim(worker: string, leaseSha256: string): Promise<{ ok: true; action: BrowserAction | null } | { ok: false; code: string }>;
  report(actionId: string, lease: string, ok: boolean, result: Record<string, unknown>, url: string | null): Promise<BxResult>;
  secretRequest(actionId: string, lease: string, kind: string, origin: string, workerPub: string, sealedIn: Buffer | null): Promise<BxResult>;
  secretTake(requestId: string, actionId: string, lease: string): Promise<BxResult>;
  brokerKey(): Promise<{ ownerPub: string | null; fingerprint?: string }>;
  /** v79: a file the action's agent staged (to_page, unexpired): name, type and bytes. */
  fileTake(actionId: string, lease: string, fileId: string): Promise<{ ok: true; fileName: string; contentType: string; data: Buffer } | { ok: false; code: string }>;
  /** v79: store a file the page produced for the action's agent (download | screenshot | pdf). */
  filePut(actionId: string, lease: string, kind: "download" | "screenshot" | "pdf", fileName: string, contentType: string, data: Buffer): Promise<BxResult>;
  /** v95 (optional for in-memory test gateways): actions whose answer was lost — outward ones become uncertain, reads fail. */
  actionsLost?(worker: string, restart: boolean): Promise<BxResult & { uncertain?: number; failed?: number }>;
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
  actionsLost(worker: string, restart: boolean) { return this.call<BxResult & { uncertain?: number; failed?: number }>("bx_actions_lost", [worker, restart]); }
  report(actionId: string, lease: string, ok: boolean, result: Record<string, unknown>, url: string | null) {
    return this.call<BxResult>("bx_report_action", [actionId, lease, ok, JSON.stringify(result), url]);
  }
  secretRequest(actionId: string, lease: string, kind: string, origin: string, workerPub: string, sealedIn: Buffer | null) {
    return this.call<BxResult>("bx_secret_request", [actionId, lease, kind, origin, workerPub, sealedIn]);
  }
  secretTake(requestId: string, actionId: string, lease: string) { return this.call<BxResult>("bx_secret_take", [requestId, actionId, lease]); }
  brokerKey() { return this.call<{ ownerPub: string | null; fingerprint?: string }>("bx_broker_key", []); }
  async fileTake(actionId: string, lease: string, fileId: string) {
    const r = await this.call<{ ok: boolean; code?: string; fileName?: string; contentType?: string; dataB64?: string }>("bx_file_take", [actionId, lease, fileId]);
    if (!r.ok) return { ok: false as const, code: String(r.code ?? "FLEET_NOT_FOUND") };
    return { ok: true as const, fileName: String(r.fileName), contentType: String(r.contentType), data: Buffer.from(String(r.dataB64 ?? ""), "base64") };
  }
  filePut(actionId: string, lease: string, kind: "download" | "screenshot" | "pdf", fileName: string, contentType: string, data: Buffer) {
    return this.call<BxResult>("bx_file_put", [actionId, lease, kind, fileName, contentType, data]);
  }
  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }
}
