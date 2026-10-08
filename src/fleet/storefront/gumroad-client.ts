/**
 * Gumroad API client for the storefront gateway (schema v52; docs/design/gumroad-revenue-integration.md §6).
 *
 * DENY BY DEFAULT. Every request is checked against the operation allowlist (method + path) before it is sent: verify the
 * account, create / update / enable / disable a product, delete a draft, the file presign → part upload → complete →
 * attach sequence, read sales, read payouts, list products. Refunds, receipts, e-mails, offer codes, custom fields,
 * profile, pages and resource subscriptions are refused here, whatever a caller asks. Only api.gumroad.com is reached,
 * plus the S3 part-upload host a presign response named (https, *.amazonaws.com).
 *
 * The access token is held in a SecretHandle and only ever becomes an Authorization header. Errors carry codes, never
 * provider text.
 */
import { SecretHandle } from "../payments/credential-broker.js";

export type StorefrontHttp = (url: string, init: { method: string; headers: Record<string, string>; body?: string | Buffer }) =>
  Promise<{ status: number; json(): Promise<unknown>; header(name: string): string | null }>;

export const GUMROAD_API = "https://api.gumroad.com";
/** The scopes the token must have — exactly (an extra `account`, `edit_sales`, `refund_sales`, … is refused). */
export const GUMROAD_SCOPES = ["edit_products", "view_sales", "view_payouts"] as const;

const ID = "[A-Za-z0-9=_-]{3,64}";
/** method + path (no query) → allowed. Nothing else is ever sent. */
const ALLOWLIST: Array<[string, RegExp]> = [
  ["GET", /^\/v2\/user$/],
  ["GET", /^\/oauth\/token\/info$/],
  ["GET", /^\/v2\/products$/],
  ["POST", /^\/v2\/products$/],
  ["PUT", new RegExp(`^/v2/products/${ID}$`)],
  ["PUT", new RegExp(`^/v2/products/${ID}/(enable|disable)$`)],
  ["DELETE", new RegExp(`^/v2/products/${ID}$`)],
  ["POST", /^\/v2\/files\/(presign|complete|abort)$/],
  ["GET", /^\/v2\/sales$/],
  ["GET", new RegExp(`^/v2/sales/${ID}$`)],
  ["GET", /^\/v2\/payouts$/],
  ["GET", /^\/v2\/payouts\/upcoming$/],
  ["GET", new RegExp(`^/v2/payouts/${ID}$`)],
];

export function gumroadAllowed(method: string, url: string, base = GUMROAD_API): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (`${u.protocol}//${u.host}` !== new URL(base).origin) return false;
  return ALLOWLIST.some(([m, re]) => m === method && re.test(u.pathname));
}

/** An S3 presigned part URL as Gumroad's presign returns it: https on *.amazonaws.com only. */
export function partUploadAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /(^|\.)amazonaws\.com$/.test(u.hostname) && !u.username && !u.password;
  } catch { return false; }
}

/** "12.30" / "-0.70" / 1230 → minor units exactly (decimal strings are dollars; integers are already cents). */
export function centsOf(v: unknown, integerIsCents = true): number | null {
  if (typeof v === "number" && Number.isSafeInteger(v)) return integerIsCents ? v : v * 100;
  if (typeof v !== "string") return null;
  const m = /^(-)?(\d{1,12})(?:\.(\d{1,2}))?$/.exec(v.trim());
  if (!m) return null;
  const n = Number(m[2]) * 100 + Number((m[3] ?? "0").padEnd(2, "0"));
  return m[1] ? -n : n;
}

export class GumroadError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(code); }
}

export class GumroadClient {
  constructor(private readonly http: StorefrontHttp, private readonly token: SecretHandle, private readonly base = GUMROAD_API) {}

  private async call<T = Record<string, unknown>>(method: string, path: string, opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {}): Promise<T> {
    const u = new URL(path, this.base);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    if (!gumroadAllowed(method, u.toString(), this.base)) throw new GumroadError("FLEET_PROVIDER_OPERATION_REFUSED");
    let r: Awaited<ReturnType<StorefrontHttp>>;
    try {
      r = await this.http(u.toString(), { method, headers: { Authorization: this.token.bearer(), Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    } catch {
      throw new GumroadError("FLEET_PROVIDER_UNREACHABLE");
    }
    if (r.status === 401 || r.status === 403) throw new GumroadError("FLEET_PROVIDER_AUTH", r.status);
    if (r.status === 404) throw new GumroadError("FLEET_PROVIDER_NOT_FOUND", r.status);
    if (r.status === 429) throw new GumroadError("FLEET_PROVIDER_RATE_LIMITED", r.status);
    if (r.status >= 500) throw new GumroadError("FLEET_PROVIDER_UNAVAILABLE", r.status);
    let body: unknown;
    try { body = await r.json(); } catch { throw new GumroadError("FLEET_PROVIDER_BAD_RESPONSE", r.status); }
    if (r.status >= 400 || !body || typeof body !== "object" || (body as { success?: unknown }).success === false) throw new GumroadError("FLEET_PROVIDER_REJECTED", r.status);
    return body as T;
  }

  /** The account the token reaches, and the scopes it was granted (from the token itself). */
  async whoami(): Promise<{ userId: string; scopes: string[] }> {
    const u = await this.call<{ user?: { user_id?: unknown; id?: unknown } }>("GET", "/v2/user");
    const info = await this.call<{ scope?: unknown; scopes?: unknown }>("GET", "/oauth/token/info");
    const raw = info.scope ?? info.scopes;
    const scopes = (Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/\s+/) : []).map(String).filter(Boolean).sort();
    const userId = String(u.user?.user_id ?? u.user?.id ?? "");
    if (!userId) throw new GumroadError("FLEET_PROVIDER_BAD_RESPONSE");
    return { userId, scopes };
  }

  async listProducts(): Promise<Array<{ id: string; customPermalink: string | null; published: boolean }>> {
    const r = await this.call<{ products?: Array<Record<string, unknown>> }>("GET", "/v2/products");
    return (r.products ?? []).map((p) => ({ id: String(p.id ?? ""), customPermalink: typeof p.custom_permalink === "string" ? p.custom_permalink : null,
      published: p.published === true })).filter((p) => /^[A-Za-z0-9=_-]{3,64}$/.test(p.id));
  }

  /** Always a draft, with the fleet's permalink (crash-safe adoption by permalink). */
  async createDraft(p: { name: string; priceMinor: number; description?: string | null; permalink: string }): Promise<{ id: string; warning: string | null }> {
    const r = await this.call<{ product?: { id?: unknown }; warning?: unknown }>("POST", "/v2/products",
      { body: { name: p.name, price: p.priceMinor, description: p.description ?? undefined, custom_permalink: p.permalink, draft: true } });
    const id = String(r.product?.id ?? "");
    if (!/^[A-Za-z0-9=_-]{3,64}$/.test(id)) throw new GumroadError("FLEET_PROVIDER_BAD_RESPONSE");
    return { id, warning: typeof r.warning === "string" ? r.warning.slice(0, 300) : null };
  }

  async updateProduct(id: string, p: { name?: string; priceMinor?: number; description?: string; fileUrls?: string[] }): Promise<void> {
    const body: Record<string, unknown> = {};
    if (p.name !== undefined) body.name = p.name;
    if (p.priceMinor !== undefined) body.price = p.priceMinor;
    if (p.description !== undefined) body.description = p.description;
    // Full-replace semantics: a files update always carries every file the product keeps.
    if (p.fileUrls !== undefined) body.files = p.fileUrls.map((url) => ({ url }));
    await this.call("PUT", `/v2/products/${encodeURIComponent(id)}`, { body });
  }

  async setPublished(id: string, published: boolean): Promise<{ warning: string | null }> {
    const r = await this.call<{ warning?: unknown }>("PUT", `/v2/products/${encodeURIComponent(id)}/${published ? "enable" : "disable"}`, { body: {} });
    return { warning: typeof r.warning === "string" ? r.warning.slice(0, 300) : null };
  }

  async deleteProduct(id: string): Promise<void> {
    await this.call("DELETE", `/v2/products/${encodeURIComponent(id)}`);
  }

  /** presign → PUT each part (S3, pinned host pattern) → complete; aborts on any failure. Returns the file URL to attach. */
  async uploadFile(fileName: string, contentType: string, data: Buffer): Promise<string> {
    const pre = await this.call<{ upload_id?: unknown; key?: unknown; parts?: Array<{ part_number?: unknown; presigned_url?: unknown }> }>("POST", "/v2/files/presign",
      { body: { filename: fileName, file_size: data.length, content_type: contentType } });
    const uploadId = String(pre.upload_id ?? "");
    const key = String(pre.key ?? "");
    const parts = (pre.parts ?? []).map((p) => ({ n: Number(p.part_number), url: String(p.presigned_url ?? "") }));
    if (!uploadId || !key || !parts.length || parts.some((p) => !Number.isInteger(p.n) || p.n < 1 || !partUploadAllowed(p.url))) {
      throw new GumroadError("FLEET_PROVIDER_BAD_RESPONSE");
    }
    try {
      const size = Math.ceil(data.length / parts.length);
      const done: Array<{ part_number: number; etag: string }> = [];
      for (const [i, p] of parts.sort((a, b) => a.n - b.n).entries()) {
        const r = await this.http(p.url, { method: "PUT", headers: { "Content-Type": contentType }, body: data.subarray(i * size, (i + 1) * size) });
        const etag = r.header("etag");
        if (r.status >= 300 || !etag) throw new GumroadError("FLEET_PROVIDER_UPLOAD_FAILED", r.status);
        done.push({ part_number: p.n, etag });
      }
      const c = await this.call<{ file_url?: unknown }>("POST", "/v2/files/complete", { body: { upload_id: uploadId, key, parts: done } });
      const url = String(c.file_url ?? "");
      if (!/^https:\/\/[^\s]{8,2000}$/.test(url)) throw new GumroadError("FLEET_PROVIDER_BAD_RESPONSE");
      return url;
    } catch (err) {
      await this.call("POST", "/v2/files/abort", { body: { upload_id: uploadId, key } }).catch(() => undefined);
      throw err;
    }
  }

  /** Sales after a date, page by page (the API's own page keys). */
  async sales(after: string | null, pageKey: string | null): Promise<{ sales: Array<Record<string, unknown>>; nextPageKey: string | null }> {
    const r = await this.call<{ sales?: Array<Record<string, unknown>>; next_page_key?: unknown }>("GET", "/v2/sales",
      { query: { after: after ?? undefined, page_key: pageKey ?? undefined } });
    return { sales: r.sales ?? [], nextPageKey: typeof r.next_page_key === "string" && r.next_page_key ? r.next_page_key : null };
  }

  async payouts(pageKey: string | null): Promise<{ payouts: Array<Record<string, unknown>>; nextPageKey: string | null }> {
    const r = await this.call<{ payouts?: Array<Record<string, unknown>>; next_page_key?: unknown }>("GET", "/v2/payouts", { query: { page_key: pageKey ?? undefined } });
    return { payouts: r.payouts ?? [], nextPageKey: typeof r.next_page_key === "string" && r.next_page_key ? r.next_page_key : null };
  }

  async payout(id: string): Promise<Record<string, unknown>> {
    const r = await this.call<{ payout?: Record<string, unknown> }>("GET", `/v2/payouts/${encodeURIComponent(id)}`, { query: { include_sales: true, include_transactions: true } });
    if (!r.payout) throw new GumroadError("FLEET_PROVIDER_BAD_RESPONSE");
    return r.payout;
  }
}

/** The payout row types of the v47 recorder (anything unknown is a summary row: quarantined, never allocated). */
export function payoutRowType(t: unknown): string {
  const s = String(t ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const known: Record<string, string> = {
    sale: "sale", full_refund: "full_refund", partial_refund: "partial_refund", chargeback: "chargeback", credit: "credit",
    refund_fee_written_off: "refund_fee_written_off", failed_refund_fee_returned: "failed_refund_fee_returned",
    failed_refund_fee_retained: "failed_refund_fee_retained", affiliate_credit: "affiliate_credit", payout_fee: "payout_fee",
    technical_adjustment: "technical_adjustment",
  };
  return known[s] ?? "summary";
}

/** Gumroad payout status → the recorder's (payable | pending | completed | failed). */
export function payoutStatus(s: unknown): "payable" | "pending" | "completed" | "failed" {
  const v = String(s ?? "").toLowerCase();
  if (v === "completed" || v === "paid") return "completed";
  if (["failed", "returned", "cancelled", "reversed"].includes(v)) return "failed";
  if (v === "payable" || v === "upcoming") return "payable";
  return "pending";
}
