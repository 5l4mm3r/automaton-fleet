/**
 * Official-API clients of the channel gateway (schema v80). Each speaks only to its provider's API host, only the
 * operations listed here, with the owner-authorised token from the gateway's vault (refreshed in place; never logged,
 * never returned). Nothing here can reach any other host.
 *
 *  Etsy Open API v3 (developers.etsy.com; OAuth 2.0 + PKCE; access token 1 h, refresh token 90 days; every call carries
 *  x-api-key = keystring:shared secret): who am I + token scopes; draft listing (type download), update, image, file,
 *  activate / deactivate; shop receipts and payment-account ledger (read).
 *  Pinterest API v5 (developers.pinterest.com): user account; create board; create Pin (image as base64, a link, alt text).
 *  Trial access keeps Pins visible only to their creator until Pinterest grants Standard access.
 *
 * VERIFY ON THE FIRST LIVE CALL (fake-tested only): Etsy ledger entry types that are payouts (mapped from /DISBURSE/), the
 * token-scopes endpoint's shape, and Pinterest's user-account id field.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { vaultFileName, vaultFileProblems } from "../custody/vault.js";

export type ChannelHttp = (url: string, init: { method: string; headers: Record<string, string>; body?: string | FormData | URLSearchParams }) =>
  Promise<{ status: number; json: () => Promise<unknown> }>;

export const ETSY_API = "https://api.etsy.com";
export const PINTEREST_API = "https://api.pinterest.com";

export class ChannelApiError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(code); }
}

/** The owner-authorised token of one connection (vault file, 0600; JSON). */
export interface StoredToken {
  provider: "etsy" | "pinterest";
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

/** The gateway's own vault: one 0600 file per reference, written atomically; tokens never leave this module except to their API. */
export class TokenStore {
  constructor(private readonly dir: string, private readonly uid: number | null = typeof process.getuid === "function" ? process.getuid() : null) {}
  private file(ref: string): string {
    const name = vaultFileName(ref);
    if (!name || !/^(etsy|pinterest)~[a-z0-9_-]{1,40}$/.test(name)) throw new ChannelApiError("FLEET_CHANNEL_API_VAULT_REF");
    return path.join(this.dir, name);
  }
  read(ref: string): StoredToken | null {
    const f = this.file(ref);
    if (vaultFileProblems(f, this.uid).length) return null;
    try { return JSON.parse(fs.readFileSync(f, "utf8")) as StoredToken; } catch { return null; }
  }
  write(ref: string, t: StoredToken): void {
    const f = this.file(ref);
    const tmp = `${f}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(t), { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, f);
  }
  /** A pending authorisation (PKCE verifier) by its state, consumed once. */
  savePending(state: string, data: Record<string, string>): void {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(state)) throw new ChannelApiError("FLEET_BAD_REQUEST");
    const f = path.join(this.dir, `pending~${state}`);
    fs.writeFileSync(f, JSON.stringify({ ...data, at: Date.now() }), { mode: 0o600, flag: "wx" });
  }
  takePending(state: string): Record<string, string> | null {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(state)) return null;
    const f = path.join(this.dir, `pending~${state}`);
    if (vaultFileProblems(f, this.uid).length) return null;
    const v = JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, string> & { at: number };
    fs.unlinkSync(f);
    return Date.now() - Number(v.at) < 30 * 60_000 ? v : null;
  }
}

const json = async (r: { status: number; json: () => Promise<unknown> }, what: string) => {
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (r.status === 401) throw new ChannelApiError("FLEET_CHANNEL_API_UNAUTHORIZED", 401);
  if (r.status === 429) throw new ChannelApiError("FLEET_CHANNEL_API_RATE_LIMITED", 429);
  if (r.status >= 300) throw new ChannelApiError(`FLEET_CHANNEL_API_REJECTED: ${what} (${r.status})`, r.status);
  return body;
};

/** Refresh an expiring token (5 minutes' margin) and persist it; returns the usable access token. */
export async function freshToken(http: ChannelHttp, store: TokenStore, ref: string, now = Date.now()): Promise<StoredToken> {
  const t = store.read(ref);
  if (!t) throw new ChannelApiError("FLEET_CHANNEL_API_NO_TOKEN");
  if (t.expiresAt - now > 5 * 60_000) return t;
  let r;
  if (t.provider === "etsy") {
    r = await http(`${ETSY_API}/v3/public/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: t.clientId, refresh_token: t.refreshToken }) });
  } else {
    r = await http(`${PINTEREST_API}/v5/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${t.clientId}:${t.clientSecret}`).toString("base64")}` },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refreshToken }) });
  }
  const b = await json(r, "token refresh") as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  if (typeof b.access_token !== "string") throw new ChannelApiError("FLEET_CHANNEL_API_REFRESH");
  const next: StoredToken = { ...t, accessToken: b.access_token, refreshToken: typeof b.refresh_token === "string" ? b.refresh_token : t.refreshToken,
    expiresAt: now + Math.max(60, Number(b.expires_in) || 3600) * 1000 };
  store.write(ref, next);
  return next;
}

const minorToDecimal = (minor: number) => (minor / 100).toFixed(2);

export class EtsyClient {
  constructor(private readonly http: ChannelHttp, private readonly t: StoredToken) {}
  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.t.accessToken}`, "x-api-key": `${this.t.clientId}:${this.t.clientSecret}`, Accept: "application/json", ...extra };
  }
  private async call(method: string, p: string, body?: URLSearchParams | FormData) {
    if (!/^\/v3\/application\/[A-Za-z0-9/_?=&.-]+$/.test(p)) throw new ChannelApiError("FLEET_CHANNEL_API_PATH");
    const headers = body instanceof URLSearchParams ? this.headers({ "Content-Type": "application/x-www-form-urlencoded" }) : this.headers();
    return json(await this.http(`${ETSY_API}${p}`, { method, headers, ...(body ? { body } : {}) }), `${method} ${p.split("?")[0]}`);
  }
  /** The account behind the token: Etsy user id and shop id. */
  async whoami(): Promise<{ account: string; shopId: string | null }> {
    const me = await this.call("GET", "/v3/application/users/me") as { user_id?: unknown; shop_id?: unknown };
    return { account: String(me.user_id ?? ""), shopId: me.shop_id === undefined || me.shop_id === null ? null : String(me.shop_id) };
  }
  async scopes(): Promise<string[]> {
    const b = await json(await this.http(`${ETSY_API}/v3/application/scopes`, { method: "POST", headers: this.headers({ "Content-Type": "application/x-www-form-urlencoded" }),
      body: new URLSearchParams({ token: this.t.accessToken }) }), "token scopes") as { scopes?: unknown };
    return Array.isArray(b.scopes) ? b.scopes.map(String).sort() : [];
  }
  async createDraft(shopId: string, p: Record<string, unknown>): Promise<{ listingId: string; url: string | null }> {
    const f = new URLSearchParams({ quantity: String(p.quantity ?? 999), title: String(p.title), description: String(p.description),
      price: minorToDecimal(Number(p.priceMinor)), who_made: String(p.whoMade ?? "i_did"), when_made: String(p.whenMade ?? "made_to_order"),
      taxonomy_id: String(p.taxonomyId), is_supply: "false", type: "download" });
    if (Array.isArray(p.tags)) for (const t of p.tags.slice(0, 13)) f.append("tags", String(t).slice(0, 20));
    const r = await this.call("POST", `/v3/application/shops/${shopId}/listings`, f) as { listing_id?: unknown; url?: unknown };
    return { listingId: String(r.listing_id), url: typeof r.url === "string" ? r.url : null };
  }
  async update(shopId: string, listingId: string, fields: Record<string, string>): Promise<{ url: string | null; state: string | null }> {
    const r = await this.call("PATCH", `/v3/application/shops/${shopId}/listings/${listingId}`, new URLSearchParams(fields)) as { url?: unknown; state?: unknown };
    return { url: typeof r.url === "string" ? r.url : null, state: typeof r.state === "string" ? r.state : null };
  }
  async image(shopId: string, listingId: string, name: string, type: string, data: Buffer): Promise<string> {
    const fd = new FormData();
    fd.append("image", new Blob([new Uint8Array(data)], { type }), name);
    const r = await this.call("POST", `/v3/application/shops/${shopId}/listings/${listingId}/images`, fd) as { listing_image_id?: unknown };
    return String(r.listing_image_id ?? "");
  }
  async file(shopId: string, listingId: string, name: string, type: string, data: Buffer): Promise<string> {
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(data)], { type }), name);
    fd.append("name", name);
    const r = await this.call("POST", `/v3/application/shops/${shopId}/listings/${listingId}/files`, fd) as { listing_file_id?: unknown };
    return String(r.listing_file_id ?? "");
  }
  async receipts(shopId: string, minCreated: number): Promise<Array<{ ref: string; occurredAt: string; currency: string; grossMinor: number }>> {
    const r = await this.call("GET", `/v3/application/shops/${shopId}/receipts?min_created=${minCreated}&limit=100`) as { results?: unknown };
    return (Array.isArray(r.results) ? r.results : []).flatMap((x: Record<string, any>) => {
      const g = x.grandtotal ?? {};
      const minor = Math.round((Number(g.amount) / Number(g.divisor || 100)) * 100);
      return x.receipt_id && Number.isFinite(minor) && minor > 0 ? [{ ref: `etsy-receipt-${x.receipt_id}`, occurredAt: new Date(Number(x.create_timestamp ?? x.created_timestamp) * 1000).toISOString(),
        currency: String(g.currency_code ?? "GBP"), grossMinor: minor }] : [];
    });
  }
  async payouts(shopId: string, minCreated: number, maxCreated: number): Promise<Array<{ ref: string; paidOn: string; currency: string; amountMinor: number }>> {
    const r = await this.call("GET", `/v3/application/shops/${shopId}/payment-account/ledger-entries?min_created=${minCreated}&max_created=${maxCreated}&limit=100`) as { results?: unknown };
    return (Array.isArray(r.results) ? r.results : []).flatMap((x: Record<string, any>) =>
      /DISBURSE/i.test(String(x.ledger_type ?? "")) && Number(x.amount) < 0
        ? [{ ref: `etsy-ledger-${x.entry_id}`, paidOn: new Date(Number(x.create_date) * 1000).toISOString().slice(0, 10), currency: String(x.currency ?? "GBP"),
            amountMinor: Math.abs(Math.round(Number(x.amount))) }] : []);
  }
}

export class PinterestClient {
  constructor(private readonly http: ChannelHttp, private readonly t: StoredToken) {}
  private async call(method: string, p: string, body?: Record<string, unknown>) {
    if (!/^\/v5\/(user_account|boards|pins)(\/[A-Za-z0-9_-]+)?$/.test(p)) throw new ChannelApiError("FLEET_CHANNEL_API_PATH");
    return json(await this.http(`${PINTEREST_API}${p}`, { method, headers: { Authorization: `Bearer ${this.t.accessToken}`, "Content-Type": "application/json",
      Accept: "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), `${method} ${p}`);
  }
  async whoami(): Promise<{ account: string; business: boolean }> {
    const r = await this.call("GET", "/v5/user_account") as { username?: unknown; account_type?: unknown };
    return { account: String(r.username ?? ""), business: String(r.account_type ?? "").toUpperCase() === "BUSINESS" };
  }
  async board(name: string, description: string): Promise<string> {
    const r = await this.call("POST", "/v5/boards", { name, description, privacy: "PUBLIC" }) as { id?: unknown };
    return String(r.id ?? "");
  }
  async pin(p: Record<string, unknown>, type: string, data: Buffer): Promise<{ id: string; url: string }> {
    const r = await this.call("POST", "/v5/pins", { board_id: String(p.boardId), title: String(p.title), description: String(p.description ?? ""), link: String(p.link),
      alt_text: String(p.altText), media_source: { source_type: "image_base64", content_type: type, data: data.toString("base64") } }) as { id?: unknown };
    const id = String(r.id ?? "");
    return { id, url: `https://www.pinterest.com/pin/${id}/` };
  }
}
