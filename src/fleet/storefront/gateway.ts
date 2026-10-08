/**
 * Storefront gateway database port (schema v52): the restricted login fleet_provider_login can call only gx_* — list the
 * provider accounts, record its account check, claim / report storefront jobs, fetch an upload's bytes once, record
 * verified sales and payouts (memo only), keep its poll cursors and reconcile products. It reads no table directly.
 */
import pg from "pg";

export type GxResult = { ok: true; [k: string]: unknown } | { ok: false; code: string; [k: string]: unknown };

export interface StorefrontAccount { accountId: string; railId: string; providerUserId: string; railStatus: string; vaultRef: string | null; credentialId: string | null }
export interface StorefrontJob {
  jobId: string; accountId: string; kind: "product_create" | "product_update" | "product_publish" | "product_unpublish" | "product_delete" | "file_attach" | "probe";
  params: Record<string, unknown>; productRef?: string; productId?: string; permalink?: string; productState?: string;
  upload?: { fileName: string; contentType: string; sizeBytes: number; sha256: string }; existingFileUrls?: string[];
}

export interface StorefrontGatewayPort {
  ping(): Promise<{ schemaVersion: number | null; queued: number }>;
  accounts(worker: string): Promise<StorefrontAccount[]>;
  accountCheck(worker: string, accountId: string, userId: string, scopes: string[]): Promise<GxResult & { verified?: boolean }>;
  claim(worker: string, leaseSha256: string): Promise<{ ok: true; job: StorefrontJob | null } | { ok: false; code: string }>;
  uploadBlob(jobId: string, lease: string): Promise<GxResult & { contentB64?: string }>;
  report(jobId: string, lease: string, ok: boolean, result: Record<string, unknown>, error: string | null): Promise<GxResult>;
  saleRecord(worker: string, accountId: string, sale: Record<string, unknown>, payloadSha256: string): Promise<GxResult>;
  payoutRecord(worker: string, accountId: string, payout: Record<string, unknown>, lines: Array<Record<string, unknown>>, payloadSha256: string): Promise<GxResult>;
  cursor(worker: string, accountId: string, kind: "sales" | "payouts"): Promise<string | null>;
  cursorSet(worker: string, accountId: string, kind: "sales" | "payouts", cursor: string): Promise<GxResult>;
  productsReconcile(worker: string, accountId: string, listed: Array<{ id: string; customPermalink: string | null }>): Promise<GxResult>;
}

export class PgStorefrontGateway implements StorefrontGatewayPort {
  private readonly pool: pg.Pool;
  private readonly schema: string;
  constructor(o: { connectionString: string; schema?: string }) {
    this.schema = o.schema ?? "fleet";
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(this.schema)) throw new Error("bad schema name");
    this.pool = new pg.Pool({ connectionString: o.connectionString, max: 2, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
  }
  private async call<T>(fn: string, args: unknown[]): Promise<T> {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    return (await this.pool.query(`SELECT ${this.schema}.${fn}(${ph}) AS r`, args)).rows[0].r as T;
  }
  async ping() {
    const r = await this.call<{ schemaVersion: number | null; queued: number }>("gx_ping", []);
    return { schemaVersion: r.schemaVersion === null ? null : Number(r.schemaVersion), queued: Number(r.queued) };
  }
  accounts(worker: string) { return this.call<StorefrontAccount[]>("gx_accounts", [worker]); }
  accountCheck(worker: string, accountId: string, userId: string, scopes: string[]) { return this.call<GxResult & { verified?: boolean }>("gx_account_check", [worker, accountId, userId, scopes]); }
  claim(worker: string, leaseSha256: string) { return this.call<{ ok: true; job: StorefrontJob | null } | { ok: false; code: string }>("gx_claim_job", [worker, leaseSha256]); }
  uploadBlob(jobId: string, lease: string) { return this.call<GxResult & { contentB64?: string }>("gx_upload_blob", [jobId, lease]); }
  report(jobId: string, lease: string, ok: boolean, result: Record<string, unknown>, error: string | null) {
    return this.call<GxResult>("gx_job_report", [jobId, lease, ok, JSON.stringify(result), error]);
  }
  saleRecord(worker: string, accountId: string, sale: Record<string, unknown>, payloadSha256: string) {
    return this.call<GxResult>("gx_sale_record", [worker, accountId, JSON.stringify(sale), payloadSha256]);
  }
  payoutRecord(worker: string, accountId: string, payout: Record<string, unknown>, lines: Array<Record<string, unknown>>, payloadSha256: string) {
    return this.call<GxResult>("gx_payout_record", [worker, accountId, JSON.stringify(payout), JSON.stringify(lines), payloadSha256]);
  }
  cursor(worker: string, accountId: string, kind: "sales" | "payouts") { return this.call<string | null>("gx_cursor", [worker, accountId, kind]); }
  cursorSet(worker: string, accountId: string, kind: "sales" | "payouts", cursor: string) { return this.call<GxResult>("gx_cursor_set", [worker, accountId, kind, cursor]); }
  productsReconcile(worker: string, accountId: string, listed: Array<{ id: string; customPermalink: string | null }>) {
    return this.call<GxResult>("gx_products_reconcile", [worker, accountId, JSON.stringify(listed)]);
  }
  async close(): Promise<void> { await this.pool.end().catch(() => {}); }
}
