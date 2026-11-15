/**
 * Mail provider adapter (schema v36): a hosted mail API on a Fleet-controlled domain, Mailgun-compatible. It sits behind
 * the provider-neutral MailProvider interface (the constitution names no provider; swap the adapter, keep the layer).
 *
 *  • Addresses: any local part on the Fleet domain is live (one catch-all inbound route that STORES messages, created
 *    once by `main.js mail-setup`), so an agent's new address or alias needs no provider call.
 *  • Inbound: the broker polls the provider's events API for stored messages (outbound HTTPS only — no webhook, no
 *    listener) and retrieves each one.
 *  • Outbound: the messages API.
 *
 * The API key is read by main.ts from the broker's private state directory; it never reaches an agent or a log.
 */
import crypto from "crypto";
import type { MailMessage, MailProvider } from "../providers.js";

export interface MailgunOptions {
  domain: string;
  apiKey: string;
  /** https://api.mailgun.net (US) or https://api.eu.mailgun.net (EU). */
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

const DOMAIN = /^[a-z0-9.-]{3,190}$/;

export class MailgunMailProvider implements MailProvider {
  readonly name = "fleet-mail";
  private readonly base: string;
  private readonly f: typeof fetch;
  private readonly auth: string;

  constructor(private readonly o: MailgunOptions) {
    if (!DOMAIN.test(o.domain)) throw new Error("mail domain is a lowercase DNS name");
    if (!o.apiKey || o.apiKey.length < 16) throw new Error("mail API key missing");
    this.base = (o.apiBase ?? "https://api.mailgun.net").replace(/\/+$/, "");
    if (!/^https:\/\/[a-z0-9.-]+$/.test(this.base)) throw new Error("mail API base must be an https origin");
    this.f = o.fetchImpl ?? fetch;
    this.auth = "Basic " + Buffer.from(`api:${o.apiKey}`).toString("base64");
  }

  private async req(url: string, init: RequestInit = {}): Promise<Record<string, any>> {
    const r = await this.f(url, { ...init, headers: { Authorization: this.auth, Accept: "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
    // Status only: a provider error body is never surfaced (it could echo request content).
    if (!r.ok) throw new Error(`FLEET_MAIL_PROVIDER_HTTP_${r.status}`);
    return (await r.json()) as Record<string, any>;
  }

  async provision(localPart: string | null, hint: string): Promise<{ address: string }> {
    const base = (localPart ?? hint.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "").slice(0, 40)) || "agent";
    // A chosen local part is used as is (the registry's unique index refuses a taken one); a derived one gets a suffix.
    const local = localPart ? base : `${base}.${crypto.randomBytes(2).toString("hex")}`;
    if (!/^[a-z0-9._+-]{1,64}$/.test(local)) throw new Error("FLEET_BAD_REQUEST");
    return { address: `${local}@${this.o.domain}` };
  }

  async send(input: { from: string; to: string[]; subject: string; body: string; inReplyTo?: string | null; attachments?: unknown[] | null }): Promise<{ providerMessageId: string }> {
    if (!input.from.toLowerCase().endsWith(`@${this.o.domain}`)) throw new Error("FLEET_MAIL_FOREIGN_SENDER");
    // v56: this optional adapter sends text only; an order delivery with files fails truthfully (retried, then reported).
    if (input.attachments?.length) throw new Error("FLEET_MAIL_ATTACHMENTS_UNSUPPORTED");
    const form = new URLSearchParams();
    form.set("from", input.from);
    for (const t of input.to) form.append("to", t);
    form.set("subject", input.subject);
    form.set("text", input.body);
    if (input.inReplyTo) {
      form.set("h:In-Reply-To", input.inReplyTo);
      form.set("h:References", input.inReplyTo);
    }
    const r = await this.req(`${this.base}/v3/${this.o.domain}/messages`, { method: "POST", body: form,
      headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    return { providerMessageId: String(r.id ?? "") };
  }

  async fetch(address: string, since: Date): Promise<MailMessage[]> {
    const q = new URLSearchParams({ event: "stored", recipient: address, begin: String(Math.floor(since.getTime() / 1000)), ascending: "yes", limit: "100" });
    const ev = await this.req(`${this.base}/v3/${this.o.domain}/events?${q}`);
    const out: MailMessage[] = [];
    for (const item of (ev.items ?? []) as Array<Record<string, any>>) {
      const url = item.storage?.url;
      if (typeof url !== "string" || !url.startsWith(this.base)) continue; // only the provider's own storage
      const m = await this.req(url);
      out.push({
        id: String(m["Message-Id"] ?? item.message?.headers?.["message-id"] ?? item.id),
        to: address,
        from: String(m.From ?? m.sender ?? ""),
        subject: String(m.subject ?? m.Subject ?? ""),
        body: String(m["body-plain"] ?? m["stripped-text"] ?? ""),
        at: new Date(Number(item.timestamp ?? Date.now() / 1000) * 1000).toISOString(),
      });
    }
    return out;
  }

  /** One-time setup: the catch-all route that stores inbound mail for the Fleet domain (idempotent). */
  async ensureInboundRoute(): Promise<{ created: boolean }> {
    const expression = `match_recipient(".*@${this.o.domain.replace(/\./g, "\\.")}")`;
    const routes = await this.req(`${this.base}/v3/routes?limit=1000`);
    if (((routes.items ?? []) as Array<Record<string, any>>).some((r) => r.expression === expression)) return { created: false };
    const form = new URLSearchParams({ priority: "10", description: "automaton-fleet inbound (store)", expression });
    form.append("action", "store()");
    await this.req(`${this.base}/v3/routes`, { method: "POST", body: form, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    return { created: true };
  }
}
