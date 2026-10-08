/**
 * The storefront gateway's work loop (schema v52; docs/design/gumroad-revenue-integration.md §§3, 6, 7).
 *
 * Each pass, per registered provider account:
 *  1. account check (at start, then every few hours): the token must reach exactly the registered Gumroad user with exactly
 *     the allowed scopes; otherwise the account is marked failed and NO job runs for it (deny by default);
 *  2. storefront jobs agents queued: create a DRAFT (adopted by its permalink if the answer was lost), update, publish (a
 *     provider warning keeps it a draft), unpublish, delete a draft, attach a file (presign → parts → complete → attach,
 *     the full file list each time), and the owner's create / inspect / delete probe;
 *  3. polls: sales after the watermark minus two days (read back, recorded once; flags only progress) and payouts with
 *     their rows (memo only); a daily product reconcile adopts lost creations and flags orphans.
 * Money never moves here: recorded sales and payouts are memo; the treasury credits agents only when a payout is received.
 */
import crypto from "crypto";
import type { SecretVault } from "../payments/credential-broker.js";
import { SecretHandle } from "../payments/credential-broker.js";
import { centsOf, GumroadClient, GumroadError, GUMROAD_SCOPES, payoutRowType, payoutStatus, type StorefrontHttp } from "./gumroad-client.js";
import type { StorefrontAccount, StorefrontGatewayPort, StorefrontJob } from "./gateway.js";

export interface StorefrontWorkerOptions {
  worker?: string;
  baseUrl?: string;
  pollEveryMs?: number;
  reconcileEveryMs?: number;
  accountCheckEveryMs?: number;
  now?: () => number;
  log?: (level: string, event: string, detail?: Record<string, unknown>) => void;
}

const sha256 = (v: unknown) => crypto.createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v), "utf8").digest("hex");
const codeOf = (err: unknown) => (err instanceof GumroadError ? err.code : /FLEET_[A-Z_]+/.exec(err instanceof Error ? err.message : "")?.[0] ?? "FLEET_PROVIDER_ERROR");

export class StorefrontWorker {
  private readonly worker: string;
  private readonly checkedAt = new Map<string, number>();
  private readonly okAccounts = new Set<string>();
  private lastPoll = 0;
  private lastReconcile = 0;

  constructor(private readonly gw: StorefrontGatewayPort, private readonly vault: SecretVault, private readonly http: StorefrontHttp,
    private readonly o: StorefrontWorkerOptions = {}) {
    this.worker = o.worker ?? "storefront-gateway";
    if (!/^[a-z0-9-]{3,40}$/.test(this.worker)) throw new Error("worker name must match ^[a-z0-9-]{3,40}$");
  }

  private now() { return (this.o.now ?? Date.now)(); }
  private log(level: string, event: string, detail?: Record<string, unknown>) { this.o.log?.(level, event, detail); }

  private async client(a: StorefrontAccount): Promise<GumroadClient | null> {
    if (!a.vaultRef) return null;
    const token = await this.vault.resolve(a.vaultRef);
    return token ? new GumroadClient(this.http, new SecretHandle(token, a.vaultRef), this.o.baseUrl) : null;
  }

  /** The account check: exactly the registered user, exactly the allowed scopes — or nothing runs for this account. */
  async checkAccount(a: StorefrontAccount, c: GumroadClient): Promise<boolean> {
    try {
      const w = await c.whoami();
      const exact = w.scopes.length === GUMROAD_SCOPES.length && GUMROAD_SCOPES.every((s) => w.scopes.includes(s));
      const r = await this.gw.accountCheck(this.worker, a.accountId, w.userId, w.scopes);
      const ok = r.ok && r.verified === true && exact && w.userId === a.providerUserId;
      if (ok) this.okAccounts.add(a.accountId); else this.okAccounts.delete(a.accountId);
      this.log(ok ? "info" : "error", "storefront_account_check", { accountId: a.accountId, ok, scopes: w.scopes });
      return ok;
    } catch (err) {
      this.okAccounts.delete(a.accountId);
      this.log("error", "storefront_account_check_failed", { accountId: a.accountId, code: codeOf(err) });
      return false;
    } finally {
      this.checkedAt.set(a.accountId, this.now());
    }
  }

  private async run(job: StorefrontJob, c: GumroadClient, lease: string): Promise<{ ok: boolean; result: Record<string, unknown>; error: string | null }> {
    const p = job.params as Record<string, unknown>;
    switch (job.kind) {
      case "product_create": {
        const permalink = String(job.permalink ?? p.permalink ?? "");
        try {
          const d = await c.createDraft({ name: String(p.name), priceMinor: Number(p.priceMinor), description: (p.description as string | null) ?? null, permalink });
          return { ok: true, result: { productId: d.id, warning: d.warning }, error: null };
        } catch (err) {
          // The answer may have been lost after Gumroad created it: adopt it by its permalink, never create a second.
          const found = (await c.listProducts().catch(() => [])).find((x) => x.customPermalink === permalink);
          if (found) return { ok: true, result: { productId: found.id, adopted: true }, error: null };
          return { ok: false, result: {}, error: codeOf(err) };
        }
      }
      case "product_update":
        await c.updateProduct(String(job.productId), { name: p.name as string | undefined, priceMinor: p.priceMinor === undefined ? undefined : Number(p.priceMinor),
          description: p.description as string | undefined });
        return { ok: true, result: {}, error: null };
      case "product_publish": {
        const r = await c.setPublished(String(job.productId), true);
        return { ok: true, result: { warning: r.warning }, error: null };
      }
      case "product_unpublish":
        await c.setPublished(String(job.productId), false);
        return { ok: true, result: {}, error: null };
      case "product_delete":
        if (job.productState !== "draft") return { ok: false, result: {}, error: "FLEET_INVALID_STATE" };
        await c.deleteProduct(String(job.productId));
        return { ok: true, result: {}, error: null };
      case "file_attach": {
        const b = await this.gw.uploadBlob(job.jobId, lease);
        if (!b.ok || !b.contentB64 || !job.upload) return { ok: false, result: {}, error: "FLEET_NOT_FOUND" };
        const data = Buffer.from(b.contentB64, "base64");
        try {
          if (crypto.createHash("sha256").update(data).digest("hex") !== job.upload.sha256) return { ok: false, result: {}, error: "FLEET_UPLOAD_CORRUPT" };
          const url = await c.uploadFile(job.upload.fileName, job.upload.contentType, data);
          await c.updateProduct(String(job.productId), { fileUrls: [...(job.existingFileUrls ?? []), url] });
          return { ok: true, result: { fileUrl: url }, error: null };
        } finally {
          data.fill(0);
        }
      }
      case "probe": {
        const permalink = String(p.permalink ?? "");
        const d = await c.createDraft({ name: "Fleet storefront probe (draft, deleted)", priceMinor: 100, permalink });
        const listed = (await c.listProducts()).some((x) => x.id === d.id);
        await c.deleteProduct(d.id);
        return { ok: true, result: { created: true, listed, deleted: true, warning: d.warning }, error: null };
      }
    }
  }

  /** Claim and run queued jobs (each reported once, success or a code). */
  async jobs(clients: Map<string, GumroadClient>, max = 10): Promise<number> {
    let n = 0;
    for (let i = 0; i < max; i++) {
      const lease = crypto.randomBytes(32).toString("base64url");
      const c = await this.gw.claim(this.worker, crypto.createHash("sha256").update(lease, "utf8").digest("hex"));
      if (!c.ok || !c.job) break;
      const job = c.job;
      const client = clients.get(job.accountId);
      let out: { ok: boolean; result: Record<string, unknown>; error: string | null };
      if (!client || !this.okAccounts.has(job.accountId)) out = { ok: false, result: {}, error: "FLEET_STOREFRONT_ACCOUNT_UNVERIFIED" };
      else {
        try { out = await this.run(job, client, lease); } catch (err) { out = { ok: false, result: {}, error: codeOf(err) }; }
      }
      const r = await this.gw.report(job.jobId, lease, out.ok, out.result, out.error);
      if (!r.ok) this.log("error", "storefront_report_refused", { jobId: job.jobId, code: r.code });
      this.log("info", "storefront_job", { jobId: job.jobId, kind: job.kind, ok: out.ok, code: out.error });
      n++;
    }
    return n;
  }

  /** Sales after the watermark minus two days (late flags and missed polls are re-read), then payouts with their rows. */
  async poll(a: StorefrontAccount, c: GumroadClient): Promise<{ sales: number; payouts: number }> {
    let sales = 0;
    const mark = await this.gw.cursor(this.worker, a.accountId, "sales");
    const after = mark ? new Date(Date.parse(mark) - 2 * 86_400_000).toISOString().slice(0, 10) : null;
    let page: string | null = null;
    let newest = mark;
    for (let i = 0; i < 50; i++) {
      const r = await c.sales(after, page);
      for (const s of r.sales) {
        const price = centsOf(s.price);
        const fee = centsOf(s.gumroad_fee);
        const at = typeof s.created_at === "string" ? s.created_at : null;
        if (price === null || fee === null || !at || typeof s.id !== "string" || typeof s.product_id !== "string") continue; // unparsable: never recorded
        const rec = await this.gw.saleRecord(this.worker, a.accountId, {
          saleId: s.id, productId: s.product_id, saleAt: at, priceMinor: price, feeMinor: fee, taxMinor: centsOf(s.tax_cents ?? s.gumroad_tax_cents ?? 0) ?? 0,
          listingCurrency: typeof s.currency === "string" ? s.currency.toUpperCase().slice(0, 3) : null,
          flags: { refunded: s.refunded === true, partiallyRefunded: s.partially_refunded === true, chargedback: s.chargedback === true, disputed: s.disputed === true,
                   disputeWon: s.dispute_won === true },
        }, sha256(s));
        if (rec.ok) sales++;
        if (!newest || at > newest) newest = at;
      }
      page = r.nextPageKey;
      if (!page) break;
    }
    if (newest && newest !== mark) await this.gw.cursorSet(this.worker, a.accountId, "sales", newest);
    let payouts = 0;
    let pp: string | null = null;
    for (let i = 0; i < 20; i++) {
      const r = await c.payouts(pp);
      for (const p of r.payouts) {
        if (typeof p.id !== "string") continue;
        const full = await c.payout(p.id);
        const lines = (Array.isArray(full.transactions) ? full.transactions : []).map((t: Record<string, unknown>) => ({
          rowType: payoutRowType(t.type), purchaseId: typeof t.purchase_id === "string" ? t.purchase_id : "",
          salePriceMinor: centsOf(t.sale_price, false), feeMinor: centsOf(t.gumroad_fees, false), taxMinor: centsOf(t.taxes ?? "0", false) ?? 0, netMinor: centsOf(t.net_total, false),
        }));
        const amount = centsOf(full.amount, false);
        if (amount === null || amount <= 0 || !lines.length || lines.some((l) => l.salePriceMinor === null || l.feeMinor === null || l.netMinor === null)) {
          this.log("error", "storefront_payout_unparsable", { payoutId: p.id }); // never guessed: left for the owner (reconcile shows it)
          continue;
        }
        const rec = await this.gw.payoutRecord(this.worker, a.accountId, {
          payoutId: full.id ?? p.id, amountMinor: amount, currency: String(full.currency ?? "").toUpperCase(), status: payoutStatus(full.status),
          processedAt: typeof full.processed_at === "string" ? full.processed_at : typeof full.created_at === "string" ? full.created_at : null,
          bankVisual: typeof full.bank_account_visual === "string" ? full.bank_account_visual.slice(0, 40) : null,
        }, lines, sha256(full));
        if (rec.ok) payouts++;
      }
      pp = r.nextPageKey;
      if (!pp) break;
    }
    return { sales, payouts };
  }

  /** One pass: account checks when due, jobs, then polls / reconcile when due. */
  async tick(): Promise<{ jobs: number; accounts: number }> {
    const accounts = (await this.gw.accounts(this.worker)).filter((a) => a.railStatus !== "revoked");
    const clients = new Map<string, GumroadClient>();
    for (const a of accounts) {
      const c = await this.client(a);
      if (!c) { this.okAccounts.delete(a.accountId); continue; }
      clients.set(a.accountId, c);
      if (this.now() - (this.checkedAt.get(a.accountId) ?? 0) >= (this.o.accountCheckEveryMs ?? 6 * 3_600_000)) await this.checkAccount(a, c);
    }
    const jobs = await this.jobs(clients);
    const now = this.now();
    if (now - this.lastPoll >= (this.o.pollEveryMs ?? 300_000)) {
      this.lastPoll = now;
      for (const a of accounts) {
        const c = clients.get(a.accountId);
        if (!c || !this.okAccounts.has(a.accountId)) continue;
        try { this.log("info", "storefront_poll", { accountId: a.accountId, ...(await this.poll(a, c)) }); }
        catch (err) { this.log("error", "storefront_poll_failed", { accountId: a.accountId, code: codeOf(err) }); }
      }
    }
    if (now - this.lastReconcile >= (this.o.reconcileEveryMs ?? 86_400_000)) {
      this.lastReconcile = now;
      for (const a of accounts) {
        const c = clients.get(a.accountId);
        if (!c || !this.okAccounts.has(a.accountId)) continue;
        try { this.log("info", "storefront_reconcile", { accountId: a.accountId, result: await this.gw.productsReconcile(this.worker, a.accountId, await c.listProducts()) }); }
        catch (err) { this.log("error", "storefront_reconcile_failed", { accountId: a.accountId, code: codeOf(err) }); }
      }
    }
    return { jobs, accounts: accounts.length };
  }
}
