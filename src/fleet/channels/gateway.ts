/**
 * Channel gateway database port (schema v80): the restricted login fleet_channels_login can call only chx_* — read the
 * owner-connected accounts, record each account check, claim an agent's API job under a lease, read its file, report it,
 * and record provider evidence (sales as memos, payouts as claims on the owner's evidence chain). No table privilege, no
 * other unit's data, no money.
 */
import pg from "pg";
import type { Pool } from "pg";
import { quoteIdent } from "../postgres/migrations.js";

export interface ChannelConnection {
  connectionId: string;
  channelId: string;
  agentId: string;
  provider: "etsy" | "pinterest";
  vaultRef: string;
  expectedAccount: string;
  shopId?: string;
  status: "pending_check" | "active" | "failed";
}

export interface ChannelJob {
  jobId: string;
  connectionId: string;
  provider: "etsy" | "pinterest";
  shopId?: string;
  op: string;
  payload: Record<string, unknown>;
  hasBlob: boolean;
  blobName?: string;
  blobType?: string;
}

export type ChxResult = { ok: boolean; [k: string]: unknown };

export interface ChannelGatewayPort {
  ping(): Promise<{ schemaVersion: number | null; queued: number }>;
  connections(worker: string): Promise<ChannelConnection[]>;
  connectionCheck(worker: string, connectionId: string, account: string | null, scopes: string[], error: string | null): Promise<ChxResult>;
  claim(worker: string, leaseSha256: string): Promise<{ ok: boolean; job: ChannelJob | null }>;
  blob(jobId: string, lease: string): Promise<Buffer | null>;
  report(jobId: string, lease: string, ok: boolean, result: Record<string, unknown> | null, externalId: string | null, externalUrl: string | null, error: string | null): Promise<ChxResult>;
  saleRecord(worker: string, connectionId: string, sale: Record<string, unknown>): Promise<ChxResult>;
  payoutRecord(worker: string, connectionId: string, payout: Record<string, unknown>): Promise<ChxResult>;
  cursor(worker: string, connectionId: string, kind: "receipts" | "ledger"): Promise<string | null>;
  cursorSet(worker: string, connectionId: string, kind: "receipts" | "ledger", cursor: string): Promise<ChxResult>;
  indexNowDue(worker: string, limit: number): Promise<{ key?: string; base?: string | null; offers?: Array<{ offerId: string; slug: string; updatedAt: string }> }>;
  indexNowDone(worker: string, offers: Array<{ offerId: string; updatedAt: string }>, status: number): Promise<ChxResult>;
}

export class PgChannelGateway implements ChannelGatewayPort {
  private readonly pool: Pool;
  private readonly s: string;
  constructor(opts: { connectionString: string; schema?: string }) {
    this.s = quoteIdent(opts.schema ?? "fleet");
    this.pool = new pg.Pool({ connectionString: opts.connectionString, max: 2, application_name: "automaton-fleet-channels",
      options: "-c statement_timeout=30000 -c lock_timeout=5000" });
    this.pool.on("error", () => {});
  }
  private async call<T>(fn: string, args: unknown[]): Promise<T> {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    return (await this.pool.query(`SELECT ${this.s}.${fn}(${ph}) AS r`, args)).rows[0].r as T;
  }
  ping() { return this.call<{ schemaVersion: number | null; queued: number }>("chx_ping", []); }
  connections(worker: string) { return this.call<ChannelConnection[]>("chx_connections", [worker]); }
  connectionCheck(worker: string, connectionId: string, account: string | null, scopes: string[], error: string | null) {
    return this.call<ChxResult>("chx_connection_check", [worker, connectionId, account, scopes, error]);
  }
  claim(worker: string, leaseSha256: string) { return this.call<{ ok: boolean; job: ChannelJob | null }>("chx_claim_job", [worker, leaseSha256]); }
  async blob(jobId: string, lease: string) {
    const r = await this.call<{ ok: boolean; dataB64?: string }>("chx_job_blob", [jobId, lease]);
    return r.ok && typeof r.dataB64 === "string" ? Buffer.from(r.dataB64, "base64") : null;
  }
  report(jobId: string, lease: string, ok: boolean, result: Record<string, unknown> | null, externalId: string | null, externalUrl: string | null, error: string | null) {
    return this.call<ChxResult>("chx_job_report", [jobId, lease, ok, result === null ? null : JSON.stringify(result), externalId, externalUrl, error]);
  }
  saleRecord(worker: string, connectionId: string, sale: Record<string, unknown>) { return this.call<ChxResult>("chx_sale_record", [worker, connectionId, JSON.stringify(sale)]); }
  payoutRecord(worker: string, connectionId: string, payout: Record<string, unknown>) { return this.call<ChxResult>("chx_payout_record", [worker, connectionId, JSON.stringify(payout)]); }
  cursor(worker: string, connectionId: string, kind: "receipts" | "ledger") { return this.call<string | null>("chx_cursor", [worker, connectionId, kind]); }
  cursorSet(worker: string, connectionId: string, kind: "receipts" | "ledger", cursor: string) { return this.call<ChxResult>("chx_cursor_set", [worker, connectionId, kind, cursor]); }
  indexNowDue(worker: string, limit: number) { return this.call<{ key?: string; base?: string | null; offers?: Array<{ offerId: string; slug: string; updatedAt: string }> }>("chx_indexnow_due", [worker, limit]); }
  indexNowDone(worker: string, offers: Array<{ offerId: string; updatedAt: string }>, status: number) { return this.call<ChxResult>("chx_indexnow_done", [worker, JSON.stringify(offers), status]); }
  async close(): Promise<void> { await this.pool.end().catch(() => {}); }
}
