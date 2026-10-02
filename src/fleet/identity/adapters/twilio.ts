/**
 * SMS / number provider adapter (schema v36): a programmable-numbers API, Twilio-compatible, behind the provider-neutral
 * SmsProvider interface (swappable; the constitution names no provider).
 *
 *  • Numbers: search an SMS-capable mobile (then local) number in the country, buy it, release it; the monthly price
 *    becomes the agent's own recurring commitment. A country that requires an address/identity bundle for the account
 *    holder is reported as human_action_required for that number only — never worked around.
 *  • Inbound: the broker polls the messages list for each number (outbound HTTPS only; no webhook, no listener).
 *  • Outbound: the messages API.
 *
 * Credentials are read by main.ts from the broker's private state directory; they never reach an agent or a log.
 */
import type { NumberOutcome, SmsMessage, SmsProvider } from "../providers.js";

export interface TwilioOptions {
  accountSid: string;
  authToken: string;
  apiBase?: string;
  pricingBase?: string;
  fetchImpl?: typeof fetch;
}

/** Provider error codes meaning the account holder must supply an address / identity bundle (regulatory). */
const REGULATORY = new Set([21631, 21649, 21650, 21651, 21615, 21614, 21612]);

export class TwilioSmsProvider implements SmsProvider {
  readonly name = "twilio";
  private readonly base: string;
  private readonly pricing: string;
  private readonly f: typeof fetch;
  private readonly auth: string;

  constructor(private readonly o: TwilioOptions) {
    if (!/^AC[0-9a-f]{32}$/.test(o.accountSid)) throw new Error("account SID malformed");
    if (!o.authToken || o.authToken.length < 16) throw new Error("auth token missing");
    this.base = (o.apiBase ?? "https://api.twilio.com").replace(/\/+$/, "");
    this.pricing = (o.pricingBase ?? "https://pricing.twilio.com").replace(/\/+$/, "");
    this.f = o.fetchImpl ?? fetch;
    this.auth = "Basic " + Buffer.from(`${o.accountSid}:${o.authToken}`).toString("base64");
  }

  private acct(path: string): string {
    return `${this.base}/2010-04-01/Accounts/${this.o.accountSid}${path}`;
  }

  private async req(url: string, init: RequestInit = {}): Promise<{ status: number; json: Record<string, any> }> {
    const r = await this.f(url, { ...init, headers: { Authorization: this.auth, Accept: "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
    const json = r.status === 204 ? {} : ((await r.json().catch(() => ({}))) as Record<string, any>);
    return { status: r.status, json };
  }

  async provision(country: string): Promise<NumberOutcome> {
    if (!/^[A-Z]{2}$/.test(country)) return { outcome: "failed", code: "bad_country" };
    let candidate: string | null = null;
    let type: "mobile" | "local" = "mobile";
    for (const t of ["Mobile", "Local"] as const) {
      const r = await this.req(this.acct(`/AvailablePhoneNumbers/${country}/${t}.json?SmsEnabled=true&PageSize=1`));
      const n = r.status === 200 ? (r.json.available_phone_numbers ?? [])[0] : null;
      if (n?.phone_number) { candidate = String(n.phone_number); type = t === "Mobile" ? "mobile" : "local"; break; }
    }
    if (!candidate) return { outcome: "failed", code: "no_numbers_available", note: `no SMS-capable number available in ${country}` };
    const buy = await this.req(this.acct("/IncomingPhoneNumbers.json"), { method: "POST", body: new URLSearchParams({ PhoneNumber: candidate }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    if (buy.status >= 300) {
      const code = Number(buy.json.code ?? 0);
      if (REGULATORY.has(code)) return { outcome: "human_action_required", code: "regulatory_bundle_required",
        note: `numbers in ${country} need an address/identity bundle for the account holder` };
      return { outcome: "failed", code: `provider_${code || buy.status}` };
    }
    let monthlyMinor: number | undefined;
    let currency: string | undefined;
    const price = await this.req(`${this.pricing}/v1/PhoneNumbers/Countries/${country}`).catch(() => null);
    if (price?.status === 200) {
      const p = ((price.json.phone_number_prices ?? []) as Array<Record<string, any>>).find((x) => x.number_type === type);
      const v = Number(p?.current_price);
      if (Number.isFinite(v) && v > 0) { monthlyMinor = Math.round(v * 100); currency = String(price.json.price_unit ?? "USD").toUpperCase(); }
    }
    return { outcome: "succeeded", e164: String(buy.json.phone_number), providerRef: String(buy.json.sid), monthlyMinor, currency };
  }

  async release(providerRef: string) {
    if (!/^PN[0-9a-f]{32}$/.test(providerRef)) return { ok: false, code: "bad_ref" };
    const r = await this.req(this.acct(`/IncomingPhoneNumbers/${providerRef}.json`), { method: "DELETE" });
    return r.status === 204 || r.status === 404 ? { ok: true } : { ok: false, code: `provider_${r.status}` };
  }

  async send(input: { from: string; to: string; body: string }) {
    const r = await this.req(this.acct("/Messages.json"), { method: "POST", body: new URLSearchParams({ From: input.from, To: input.to, Body: input.body }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    if (r.status >= 300) throw new Error(`FLEET_SMS_PROVIDER_${r.json.code ?? r.status}`);
    return { providerMessageId: String(r.json.sid) };
  }

  async fetch(e164: string, since: Date): Promise<SmsMessage[]> {
    const day = since.toISOString().slice(0, 10);
    const r = await this.req(this.acct(`/Messages.json?${new URLSearchParams({ To: e164, "DateSent>": day, PageSize: "100" })}`));
    if (r.status !== 200) return [];
    return ((r.json.messages ?? []) as Array<Record<string, any>>)
      .filter((m) => m.direction === "inbound" && new Date(m.date_sent ?? m.date_created).getTime() >= since.getTime())
      .map((m) => ({ id: String(m.sid), to: String(m.to), from: String(m.from), body: String(m.body ?? ""), at: new Date(m.date_sent ?? m.date_created).toISOString() }));
  }
}
