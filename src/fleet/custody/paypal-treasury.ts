/**
 * PayPal treasury worker (schema v48), inside the custody executor — the only process that can read the PayPal
 * credential. It receives money for agents' checkouts and keeps the registry reconciled with PayPal; it never pays anyone
 * (payouts are the signer's, behind the four-key activation).
 *
 * Each pass:
 *  1. webhooks the controller stored unverified are verified with PayPal (postback to verify-webhook-signature, with the
 *     webhook id configured for the rail) — rejected ones are marked, verified ones interpreted: an approved order is
 *     captured; a completed / pending capture, a refund or a reversal is recorded;
 *  2. checkouts agents requested are created as Orders v2 orders (custom_id / invoice_id carry the checkout id; the
 *     PayPal-Request-Id makes a retry return the same order) and approved ones captured (idempotent the same way);
 *  3. periodically, Transaction Search (24 h windows with 3 h overlap; PayPal can lag up to 3 h) records PayPal's own
 *     transactions and posts any capture the webhooks missed; the Balances API is observed.
 *
 * Contract: PayPal is reached only through its REST API with the owner's app credential (never paypal.com itself); no
 * secret or token is ever returned, stored or logged; an unknown outcome is left for the next pass, never guessed.
 */
import { SecretHandle, type SecretVault } from "../payments/credential-broker.js";
import type { HttpPort } from "./signers.js";
import type { CxResult } from "./gateway.js";

export interface PayPalInboxItem { eventId: string; eventType: string; status: "received" | "verified"; headers: Record<string, string>; body: string }
export interface PayPalWorkItem {
  checkoutId: string; status: "requested" | "approved"; amountMinor: number; currency: string; description: string;
  paypalOrderId: string | null; railId: string; railMode: "live" | "sandbox"; credentialId: string; vaultRef: string;
}
export interface PayPalRail { railId: string; railMode: "live" | "sandbox"; credentialId: string; vaultRef: string; lastSyncAt: string | null;
  /** v49: the rail's PayPal webhook id as the owner registered it (non-secret). */
  webhookId?: string | null }

export interface PayPalGatewayPort {
  paypalInbox(worker: string, limit: number): Promise<PayPalInboxItem[]>;
  paypalInboxResult(worker: string, eventId: string, status: "verified" | "rejected" | "processed" | "ignored", note: string | null): Promise<CxResult>;
  paypalWork(worker: string, limit: number): Promise<PayPalWorkItem[]>;
  paypalRails(worker: string): Promise<PayPalRail[]>;
  paypalCheckoutByOrder(worker: string, orderId: string): Promise<CxResult>;
  paypalCheckoutUpdate(worker: string, checkoutId: string, status: "open" | "approved" | "capture_pending" | "failed", orderId: string | null, approvalUrl: string | null,
    failure: string | null): Promise<CxResult>;
  paypalCaptureRecord(worker: string, checkoutId: string, captureId: string, status: "COMPLETED" | "PENDING", grossMinor: number, feeMinor: number, currency: string,
    evidence: "capture_response" | "webhook" | "transaction_search"): Promise<CxResult>;
  paypalRefundRecord(worker: string, captureId: string, refundId: string, kind: "refund" | "reversal" | "dispute_fee" | "chargeback_fee", amountMinor: number,
    currency: string): Promise<CxResult>;
  paypalTxnRecord(worker: string, railId: string, txn: Record<string, unknown>): Promise<CxResult>;
  paypalBalanceRecord(worker: string, railId: string, currency: string, availableMinor: number, totalMinor: number): Promise<CxResult>;
  /** v56: paid orders whose buyer contact is not recorded yet, and the record of PayPal's payer object (NULL: not readable now). */
  paypalBuyerWork?(worker: string, limit: number): Promise<Array<{ checkoutId: string; paypalOrderId: string; railMode: "live" | "sandbox"; vaultRef: string }>>;
  paypalBuyerRecord?(worker: string, checkoutId: string, payer: Record<string, unknown> | null): Promise<CxResult>;
}

export interface PayPalTreasuryOptions {
  worker?: string;
  /** PayPal webhook id per rail (verify-webhook-signature needs it; non-secret). */
  webhookIds?: Record<string, string>;
  /** Where PayPal returns the buyer after approval / cancellation (a public page of the fleet). */
  returnUrl?: string;
  cancelUrl?: string;
  reconcileEveryMs?: number;
  balanceEveryMs?: number;
  now?: () => number;
  log?: (level: string, event: string, detail?: Record<string, unknown>) => void;
}

const PAYPAL_ID = /^[A-Z0-9]{5,40}$/;
const base = (mode: string) => (mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com");
const decimal = (minor: number) => `${minor < 0 ? "-" : ""}${Math.trunc(Math.abs(minor) / 100)}.${String(Math.abs(minor) % 100).padStart(2, "0")}`;

/** "12.30" / "-0.70" / "12" → minor units exactly (two-decimal currencies); anything else → null. */
export function toMinor(v: unknown): number | null {
  if (typeof v !== "string" || !/^-?\d{1,12}(\.\d{1,2})?$/.test(v)) return null;
  const neg = v.startsWith("-");
  const [i, f = ""] = v.replace("-", "").split(".");
  const n = Number(i) * 100 + Number(f.padEnd(2, "0"));
  return neg ? -n : n;
}

/** The checkout id carried in a capture / transaction (custom_id, or invoice_id "fleet:<uuid>"). */
export function checkoutIdOf(customId: unknown, invoiceId: unknown): string | null {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (typeof customId === "string" && uuid.test(customId)) return customId;
  if (typeof invoiceId === "string" && invoiceId.startsWith("fleet:") && uuid.test(invoiceId.slice(6))) return invoiceId.slice(6);
  return null;
}

export class PayPalTreasuryWorker {
  private readonly worker: string;
  private readonly tokens = new Map<string, { token: string; until: number }>();
  private lastReconcile = new Map<string, number>();
  private lastBalance = new Map<string, number>();
  private readonly now: () => number;
  readonly stats = { verified: 0, rejected: 0, opened: 0, captured: 0, refunds: 0, transactions: 0, errors: 0, lastError: null as string | null };

  constructor(
    private readonly gw: PayPalGatewayPort,
    private readonly vault: SecretVault,
    private readonly http: HttpPort,
    private readonly opts: PayPalTreasuryOptions = {},
  ) {
    this.worker = opts.worker ?? "custody-executor";
    this.now = opts.now ?? Date.now;
  }

  private log(level: string, event: string, detail?: Record<string, unknown>) {
    this.opts.log?.(level, event, detail);
  }

  /** An access token for a rail's credential (memory only, refreshed a minute before PayPal's expiry). */
  private async token(r: { railMode: string; vaultRef: string }): Promise<string | null> {
    const key = `${r.railMode}|${r.vaultRef}`;
    const hit = this.tokens.get(key);
    if (hit && hit.until > this.now()) return hit.token;
    const secret = await this.vault.resolve(r.vaultRef).catch(() => null);
    if (!secret) return null;
    const h = new SecretHandle(secret, r.vaultRef);
    const res = await this.http(`${base(r.railMode)}/v1/oauth2/token`, {
      method: "POST", headers: { Authorization: h.basic(), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: "grant_type=client_credentials",
    });
    if (res.status !== 200) return null;
    const j = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof j.access_token !== "string" || j.access_token.length < 10) return null;
    const ttl = typeof j.expires_in === "number" && j.expires_in > 120 ? j.expires_in : 600;
    this.tokens.set(key, { token: j.access_token, until: this.now() + (ttl - 60) * 1000 });
    return j.access_token;
  }

  private async call(r: { railMode: string; vaultRef: string }, method: string, path: string, body?: unknown, requestId?: string): Promise<{ status: number; json: any } | null> {
    const t = await this.token(r);
    if (!t) return null;
    const headers: Record<string, string> = { Authorization: `Bearer ${t}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    const res = await this.http(`${base(r.railMode)}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401) this.tokens.delete(`${r.railMode}|${r.vaultRef}`);
    return { status: res.status, json };
  }

  /** One pass (never throws). */
  async tick(): Promise<void> {
    try {
      const rails = await this.gw.paypalRails(this.worker);
      await this.inbox(rails);
      await this.work();
      await this.buyers();
      for (const r of rails) {
        if (this.now() - (this.lastReconcile.get(r.railId) ?? 0) >= (this.opts.reconcileEveryMs ?? 15 * 60_000)) await this.reconcile(r);
        if (this.now() - (this.lastBalance.get(r.railId) ?? 0) >= (this.opts.balanceEveryMs ?? 60 * 60_000)) await this.balance(r);
      }
      this.stats.lastError = null;
    } catch (err) {
      this.stats.errors++;
      this.stats.lastError = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
      this.log("warn", "paypal_treasury_pass_failed", { error: this.stats.lastError });
    }
  }

  // ── 1. Webhooks ──
  private async inbox(rails: PayPalRail[]): Promise<void> {
    const items = await this.gw.paypalInbox(this.worker, 20);
    for (const w of items) {
      if (w.status === "received") {
        const v = await this.verify(w, rails);
        if (v === "unknown") continue; // retried next pass
        await this.gw.paypalInboxResult(this.worker, w.eventId, v === "verified" ? "verified" : "rejected", v === "verified" ? null : "signature did not verify");
        if (v !== "verified") { this.stats.rejected++; continue; }
        this.stats.verified++;
      }
      const done = await this.interpret(w);
      if (done !== null) await this.gw.paypalInboxResult(this.worker, w.eventId, done ? "processed" : "ignored", null);
    }
  }

  private async verify(w: PayPalInboxItem, rails: PayPalRail[]): Promise<"verified" | "rejected" | "unknown"> {
    const h = Object.fromEntries(Object.entries(w.headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const need = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"];
    if (need.some((k) => !h[k])) return "rejected";
    let event: unknown;
    try { event = JSON.parse(w.body); } catch { return "rejected"; }
    const hook = (r: PayPalRail) => this.opts.webhookIds?.[r.railId] ?? r.webhookId ?? null;
    const candidates = rails.filter((r) => hook(r));
    if (!candidates.length) return "unknown"; // no webhook id configured yet: keep it for when one is
    let anyAnswer = false;
    for (const r of candidates) {
      const res = await this.call(r, "POST", "/v1/notifications/verify-webhook-signature", {
        auth_algo: h["paypal-auth-algo"], cert_url: h["paypal-cert-url"], transmission_id: h["paypal-transmission-id"],
        transmission_sig: h["paypal-transmission-sig"], transmission_time: h["paypal-transmission-time"], webhook_id: hook(r), webhook_event: event,
      }).catch(() => null);
      if (!res || res.status >= 500) continue;
      anyAnswer = true;
      if (res.status === 200 && res.json?.verification_status === "SUCCESS") return "verified";
    }
    return anyAnswer ? "rejected" : "unknown";
  }

  /** Act on a verified event: true = processed, false = not relevant (ignored), null = retry later. */
  private async interpret(w: PayPalInboxItem): Promise<boolean | null> {
    let ev: any;
    try { ev = JSON.parse(w.body); } catch { return false; }
    const res = ev?.resource ?? {};
    switch (w.eventType) {
      case "CHECKOUT.ORDER.APPROVED": {
        if (typeof res.id !== "string") return false;
        const c = await this.gw.paypalCheckoutByOrder(this.worker, res.id);
        if (!c.ok) return false;
        const st = String((c as any).status);
        if (st === "open") await this.gw.paypalCheckoutUpdate(this.worker, String((c as any).checkoutId), "approved", null, null, null);
        if (st === "open" || st === "approved") {
          const ok = await this.capture({ checkoutId: String((c as any).checkoutId), paypalOrderId: res.id, railMode: (c as any).railMode, vaultRef: (c as any).vaultRef,
            amountMinor: Number((c as any).amountMinor), currency: String((c as any).currency) });
          return ok ? true : null;
        }
        return true;
      }
      case "PAYMENT.CAPTURE.COMPLETED":
      case "PAYMENT.CAPTURE.PENDING": {
        const checkoutId = checkoutIdOf(res.custom_id, res.invoice_id);
        const gross = toMinor(res.amount?.value);
        if (!checkoutId || gross === null || typeof res.id !== "string") return false;
        const fee = toMinor(res.seller_receivable_breakdown?.paypal_fee?.value) ?? 0;
        const r = await this.gw.paypalCaptureRecord(this.worker, checkoutId, res.id, w.eventType.endsWith("COMPLETED") ? "COMPLETED" : "PENDING", gross, Math.abs(fee),
          String(res.amount?.currency_code ?? ""), "webhook");
        if (r.ok) this.stats.captured++;
        return true; // a refusal (mismatch / conflict) is recorded by the registry as an event
      }
      case "PAYMENT.CAPTURE.REFUNDED": {
        const up = (Array.isArray(res.links) ? res.links : []).find((l: any) => l?.rel === "up" && typeof l.href === "string");
        const captureId = up ? /\/captures\/([A-Z0-9]+)$/.exec(up.href)?.[1] : undefined;
        const amount = toMinor(res.amount?.value);
        if (!captureId || amount === null || typeof res.id !== "string") return false;
        const r = await this.gw.paypalRefundRecord(this.worker, captureId, res.id, "refund", amount, String(res.amount?.currency_code ?? ""));
        if (r.ok) this.stats.refunds++;
        return true;
      }
      case "PAYMENT.CAPTURE.REVERSED": {
        // The resource is either the reversed capture itself or a refund-shaped object linking "up" to it (PayPal's
        // documented sample); the capture is taken from that link when present.
        const amount = toMinor(res.amount?.value);
        if (typeof res.id !== "string" || amount === null) return false;
        const up = (Array.isArray(res.links) ? res.links : []).find((l: any) => l?.rel === "up" && typeof l.href === "string");
        const linked = up ? /\/captures\/([A-Z0-9]+)$/.exec(up.href)?.[1] : undefined;
        const captureId = linked ?? res.id;
        const r = await this.gw.paypalRefundRecord(this.worker, captureId, `REV-${res.id}`.slice(0, 64), "reversal", Math.abs(amount), String(res.amount?.currency_code ?? ""));
        if (r.ok) this.stats.refunds++;
        return true;
      }
      default:
        return false;
    }
  }

  // ── 2. Checkouts ──
  private async work(): Promise<void> {
    for (const c of await this.gw.paypalWork(this.worker, 20)) {
      if (c.status === "requested") await this.open(c);
      else if (c.status === "approved" && c.paypalOrderId) await this.capture(c as PayPalWorkItem & { paypalOrderId: string });
    }
  }

  private async open(c: PayPalWorkItem): Promise<void> {
    const body = {
      intent: "CAPTURE",
      purchase_units: [{ reference_id: c.checkoutId, custom_id: c.checkoutId, invoice_id: `fleet:${c.checkoutId}`, description: c.description.slice(0, 127),
        amount: { currency_code: c.currency, value: decimal(c.amountMinor) } }],
      payment_source: { paypal: { experience_context: { shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW",
        ...(this.opts.returnUrl ? { return_url: this.opts.returnUrl } : {}), ...(this.opts.cancelUrl ? { cancel_url: this.opts.cancelUrl } : {}) } } },
    };
    const res = await this.call(c, "POST", "/v2/checkout/orders", body, `order:${c.checkoutId}`).catch(() => null);
    if (!res) return; // auth or network: next pass (the request id returns the same order if it was created)
    if (res.status === 200 || res.status === 201) {
      const id = res.json?.id;
      const link = (Array.isArray(res.json?.links) ? res.json.links : []).find((l: any) => l?.rel === "payer-action" || l?.rel === "approve");
      if (typeof id === "string" && PAYPAL_ID.test(id) && typeof link?.href === "string") {
        const r = await this.gw.paypalCheckoutUpdate(this.worker, c.checkoutId, "open", id, link.href, null);
        if (r.ok) this.stats.opened++;
        else this.log("warn", "paypal_checkout_open_refused", { checkoutId: c.checkoutId, code: (r as { code: string }).code });
      }
      return;
    }
    if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 429) {
      const name = String(res.json?.name ?? `http_${res.status}`).toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60);
      await this.gw.paypalCheckoutUpdate(this.worker, c.checkoutId, "failed", null, null, `paypal_${name}`.slice(0, 64));
    }
  }

  /** Capture an approved order (idempotent by request id; an already-captured order is read back). True when settled either way. */
  private async capture(c: { checkoutId: string; paypalOrderId: string; railMode: string; vaultRef: string; amountMinor: number; currency: string }): Promise<boolean> {
    let res = await this.call(c, "POST", `/v2/checkout/orders/${c.paypalOrderId}/capture`, {}, `capture:${c.checkoutId}`).catch(() => null);
    if (!res) return false;
    if (res.status === 422 && /ORDER_ALREADY_CAPTURED/.test(JSON.stringify(res.json))) {
      res = await this.call(c, "GET", `/v2/checkout/orders/${c.paypalOrderId}`).catch(() => null);
      if (!res) return false;
    }
    if (res.status === 200 || res.status === 201) {
      const cap = res.json?.purchase_units?.[0]?.payments?.captures?.[0];
      const gross = toMinor(cap?.amount?.value);
      if (!cap || typeof cap.id !== "string" || gross === null) return false;
      const fee = Math.abs(toMinor(cap?.seller_receivable_breakdown?.paypal_fee?.value) ?? 0);
      const status = cap.status === "COMPLETED" ? "COMPLETED" : cap.status === "PENDING" ? "PENDING" : null;
      if (!status) {
        await this.gw.paypalCheckoutUpdate(this.worker, c.checkoutId, "failed", null, null, `paypal_capture_${String(cap.status).toLowerCase()}`.slice(0, 64));
        return true;
      }
      const r = await this.gw.paypalCaptureRecord(this.worker, c.checkoutId, cap.id, status, gross, fee, String(cap.amount?.currency_code ?? ""), "capture_response");
      if (r.ok && status === "COMPLETED") this.stats.captured++;
      return true;
    }
    if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 429 && res.status !== 422) {
      await this.gw.paypalCheckoutUpdate(this.worker, c.checkoutId, "failed", null, null, `paypal_capture_http_${res.status}`);
      return true;
    }
    return false;
  }

  // ── 3. Reconciliation and balances ──
  // ── v56: the buyer of a paid order (for its delivery and invoice), from PayPal's own order record ──
  private async buyers(): Promise<void> {
    if (!this.gw.paypalBuyerWork || !this.gw.paypalBuyerRecord) return;
    for (const b of await this.gw.paypalBuyerWork(this.worker, 20)) {
      if (!PAYPAL_ID.test(b.paypalOrderId)) continue;
      const res = await this.call(b, "GET", `/v2/checkout/orders/${b.paypalOrderId}`).catch(() => null);
      if (!res) continue; // credential unavailable: next pass
      const payer = res.status === 200 && res.json && typeof res.json.payer === "object" ? (res.json.payer as Record<string, unknown>) : null;
      await this.gw.paypalBuyerRecord(this.worker, b.checkoutId, payer);
    }
  }

  private async reconcile(r: PayPalRail): Promise<void> {
    const end = new Date(this.now());
    const since = r.lastSyncAt ? Date.parse(r.lastSyncAt) - 3 * 3_600_000 : this.now() - 3 * 86_400_000;
    const start = new Date(Math.max(since, this.now() - 30 * 86_400_000));
    let page = 1;
    for (;;) {
      const qs = new URLSearchParams({ start_date: start.toISOString().replace(/\.\d{3}Z$/, "Z"), end_date: end.toISOString().replace(/\.\d{3}Z$/, "Z"),
        fields: "transaction_info", page_size: "500", page: String(page) });
      const res = await this.call(r, "GET", `/v1/reporting/transactions?${qs}`).catch(() => null);
      if (!res || res.status !== 200) return; // retried at the next interval
      for (const d of Array.isArray(res.json?.transaction_details) ? res.json.transaction_details : []) {
        const t = d?.transaction_info ?? {};
        const amount = toMinor(t.transaction_amount?.value);
        if (typeof t.transaction_id !== "string" || !PAYPAL_ID.test(t.transaction_id) || !/^T\d{4}$/.test(String(t.transaction_event_code)) || amount === null) continue;
        const fee = toMinor(t.fee_amount?.value) ?? 0;
        const txn = { transactionId: t.transaction_id, eventCode: t.transaction_event_code, initiatedAt: t.transaction_initiation_date, status: t.transaction_status,
          amountMinor: amount, feeMinor: fee, currency: t.transaction_amount?.currency_code, invoiceId: t.invoice_id ?? null, customField: t.custom_field ?? null,
          referenceId: typeof t.paypal_reference_id === "string" ? t.paypal_reference_id : null };
        const rec = await this.gw.paypalTxnRecord(this.worker, r.railId, txn);
        this.stats.transactions++;
        // v56: a refund PayPal shows but no webhook reported (only the shortfall; the transaction id is its claim).
        const short = Number((rec as any).refundShortfallMinor ?? 0);
        if (rec.ok && short > 0 && typeof (rec as any).captureId === "string") {
          const rr = await this.gw.paypalRefundRecord(this.worker, (rec as any).captureId, t.transaction_id, "refund", short, String(t.transaction_amount?.currency_code ?? ""));
          if (rr.ok) this.stats.refunds++;
        }
        if (rec.ok && (rec as any).needsCapturePost === true) {
          await this.gw.paypalCaptureRecord(this.worker, String((rec as any).checkoutId), t.transaction_id, "COMPLETED", amount, Math.abs(fee),
            String(t.transaction_amount?.currency_code ?? ""), "transaction_search");
        }
      }
      const pages = Number(res.json?.total_pages ?? 1);
      if (!(page < pages) || page >= 20) break;
      page++;
    }
    this.lastReconcile.set(r.railId, this.now());
  }

  private async balance(r: PayPalRail): Promise<void> {
    const res = await this.call(r, "GET", "/v1/reporting/balances").catch(() => null);
    if (!res || res.status !== 200) return;
    for (const b of Array.isArray(res.json?.balances) ? res.json.balances : []) {
      const avail = toMinor(b?.available_balance?.value);
      const total = toMinor(b?.total_balance?.value);
      if (typeof b?.currency === "string" && avail !== null && total !== null) await this.gw.paypalBalanceRecord(this.worker, r.railId, b.currency, avail, total);
    }
    this.lastBalance.set(r.railId, this.now());
  }
}
