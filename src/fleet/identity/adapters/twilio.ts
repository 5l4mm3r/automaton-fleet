/**
 * SMS / number provider adapter (schema v36; v41 cost-aware): a programmable-numbers API, Twilio-compatible, behind the
 * provider-neutral SmsProvider interface (swappable; the constitution names no provider). DORMANT until the owner
 * activates it — nothing here runs without installed credentials.
 *
 *  • Credentials: a scoped API key (SK… + secret, used with the account SID) is preferred over the account's master auth
 *    token. Both come from the broker's encrypted provider vault; they never reach an agent, a prompt or a log.
 *  • Quote (v41): live availability per number type, the current monthly rental (Pricing API), per-message prices
 *    (the most expensive carrier, conservatively) and the regulatory requirements — the agent decides with them.
 *  • Provision: re-checks the current monthly price against the agent's ceiling BEFORE buying; attaches an approved
 *    regulatory bundle / a validated address when the country requires one; otherwise reports human_action_required for
 *    that number only — never worked around.
 *  • Inbound: the broker polls the messages list per number (outbound HTTPS only; no webhook, no listener).
 *  • Prices: a message's final price, for charging the agent.
 */
import type { NumberOutcome, NumberQuote, NumberType, SmsMessage, SmsProvider } from "../providers.js";

export interface TwilioOptions {
  accountSid: string;
  /** Preferred: a scoped API key (SK…) and its secret. */
  apiKeySid?: string;
  apiKeySecret?: string;
  /** Fallback: the account auth token. */
  authToken?: string;
  apiBase?: string;
  pricingBase?: string;
  numbersBase?: string;
  fetchImpl?: typeof fetch;
}

/** Provider error codes meaning the account holder must supply an address / identity bundle (regulatory). */
const REGULATORY = new Set([21631, 21649, 21650, 21651, 21615, 21614, 21612]);
const RESOURCE: Record<NumberType, string> = { mobile: "Mobile", local: "Local", toll_free: "TollFree", national: "National" };
const PRICING_TYPE: Record<string, NumberType> = { mobile: "mobile", local: "local", "toll free": "toll_free", toll_free: "toll_free", national: "national" };

/** A decimal price string ("-0.00790", "1.15") → absolute micro-units, or null. */
export function priceMicro(v: unknown): number | null {
  const s = String(v ?? "").trim();
  const m = /^-?(\d{1,9})(?:\.(\d{1,12}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 1_000_000 + Number(((m[2] ?? "") + "000000").slice(0, 6));
}

export class TwilioSmsProvider implements SmsProvider {
  readonly name = "twilio";
  private readonly base: string;
  private readonly pricing: string;
  private readonly numbersApi: string;
  private readonly f: typeof fetch;
  private readonly auth: string;

  constructor(private readonly o: TwilioOptions) {
    if (!/^AC[0-9a-f]{32}$/.test(o.accountSid)) throw new Error("account SID malformed");
    if (o.apiKeySid !== undefined || o.apiKeySecret !== undefined) {
      if (!/^SK[0-9a-f]{32}$/.test(o.apiKeySid ?? "") || !o.apiKeySecret || o.apiKeySecret.length < 16) throw new Error("API key malformed");
      this.auth = "Basic " + Buffer.from(`${o.apiKeySid}:${o.apiKeySecret}`).toString("base64");
    } else {
      if (!o.authToken || o.authToken.length < 16) throw new Error("API key or auth token missing");
      this.auth = "Basic " + Buffer.from(`${o.accountSid}:${o.authToken}`).toString("base64");
    }
    this.base = (o.apiBase ?? "https://api.twilio.com").replace(/\/+$/, "");
    this.pricing = (o.pricingBase ?? "https://pricing.twilio.com").replace(/\/+$/, "");
    this.numbersApi = (o.numbersBase ?? "https://numbers.twilio.com").replace(/\/+$/, "");
    for (const b of [this.base, this.pricing, this.numbersApi]) if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(b)) throw new Error("API bases must be https origins");
    this.f = o.fetchImpl ?? fetch;
  }

  private acct(path: string): string {
    return `${this.base}/2010-04-01/Accounts/${this.o.accountSid}${path}`;
  }

  private async req(url: string, init: RequestInit = {}): Promise<{ status: number; json: Record<string, any> }> {
    const r = await this.f(url, { ...init, headers: { Authorization: this.auth, Accept: "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
    const json = r.status === 204 ? {} : ((await r.json().catch(() => ({}))) as Record<string, any>);
    return { status: r.status, json };
  }

  private async available(country: string, t: NumberType, size = 3): Promise<Array<Record<string, any>>> {
    const r = await this.req(this.acct(`/AvailablePhoneNumbers/${country}/${RESOURCE[t]}.json?SmsEnabled=true&PageSize=${size}`));
    return r.status === 200 ? ((r.json.available_phone_numbers ?? []) as Array<Record<string, any>>) : [];
  }

  /** Current monthly rental per number type (micro-units of the price unit). */
  private async monthly(country: string): Promise<{ currency: string; byType: Partial<Record<NumberType, number>> } | null> {
    const r = await this.req(`${this.pricing}/v1/PhoneNumbers/Countries/${country}`);
    if (r.status !== 200) return null;
    const byType: Partial<Record<NumberType, number>> = {};
    for (const p of (r.json.phone_number_prices ?? []) as Array<Record<string, any>>) {
      const t = PRICING_TYPE[String(p.number_type ?? "").toLowerCase()];
      const v = priceMicro(p.current_price ?? p.base_price);
      if (t && v !== null) byType[t] = v;
    }
    return { currency: String(r.json.price_unit ?? "USD").toUpperCase(), byType };
  }

  private async regulation(country: string, t: NumberType): Promise<Record<string, unknown> | null> {
    const q = new URLSearchParams({ IsoCountry: country, NumberType: t === "toll_free" ? "toll-free" : t, EndUserType: "individual" });
    const r = await this.req(`${this.numbersApi}/v2/RegulatoryCompliance/Regulations?${q}`);
    if (r.status !== 200) return null;
    const regs = (r.json.results ?? []) as Array<Record<string, any>>;
    if (!regs.length) return { required: false };
    const req = regs[0].requirements ?? {};
    const names = (xs: unknown) => (Array.isArray(xs) ? xs.map((x: any) => String(x?.name ?? x?.type ?? "")).filter(Boolean).slice(0, 10) : []);
    return { required: true, endUser: names(req.end_user), documents: names(req.supporting_document) };
  }

  async quote(country: string, types: NumberType[]): Promise<NumberQuote> {
    if (!/^[A-Z]{2}$/.test(country)) return { error: "bad_country" };
    const monthly = await this.monthly(country).catch(() => null);
    if (!monthly) return { error: "pricing_unavailable" };
    const options: Array<{ numberType: NumberType; monthlyMicro: number | null; available: Array<{ e164: string; locality?: string; region?: string }>;
      smsCapable: boolean; voiceCapable?: boolean }> = [];
    const regulation: Record<string, unknown> = {};
    for (const t of types) {
      const nums = await this.available(country, t).catch(() => []);
      if (!nums.length) continue;
      options.push({ numberType: t, monthlyMicro: monthly.byType[t] ?? null, smsCapable: true, voiceCapable: Boolean(nums[0].capabilities?.voice),
        available: nums.slice(0, 3).map((n) => ({ e164: String(n.phone_number), locality: n.locality ? String(n.locality).slice(0, 60) : undefined,
          region: n.region ? String(n.region).slice(0, 40) : undefined })) });
      const reg = await this.regulation(country, t).catch(() => null);
      const addr = String(nums[0].address_requirements ?? "none");
      regulation[t] = { ...(reg ?? { required: "unknown" }), address: addr };
    }
    if (!options.length) return { error: "no_numbers_available" };
    const messaging: Record<string, number> = {};
    const m = await this.req(`${this.pricing}/v1/Messaging/Countries/${country}`).catch(() => null);
    if (m?.status === 200) {
      for (const carrier of (m.json.outbound_sms_prices ?? []) as Array<Record<string, any>>) {
        for (const p of (carrier.prices ?? []) as Array<Record<string, any>>) {
          const t = PRICING_TYPE[String(p.number_type ?? "").toLowerCase()];
          const v = priceMicro(p.current_price ?? p.base_price);
          if (t && v !== null) messaging[`outbound_${t}`] = Math.max(messaging[`outbound_${t}`] ?? 0, v);
        }
      }
      for (const p of (m.json.inbound_sms_prices ?? []) as Array<Record<string, any>>) {
        const t = PRICING_TYPE[String(p.number_type ?? "").toLowerCase()];
        const v = priceMicro(p.current_price ?? p.base_price);
        if (t && v !== null) messaging[`inbound_${t}`] = v;
      }
    }
    return { provider: this.name, currency: monthly.currency, options, messaging, regulation };
  }

  async provision(country: string, opts: { numberType?: NumberType; phoneNumber?: string | null; maxMonthlyMicro?: number | null; currency?: string | null } = {}): Promise<NumberOutcome> {
    if (!/^[A-Z]{2}$/.test(country)) return { outcome: "failed", code: "bad_country" };
    const types: NumberType[] = opts.numberType ? [opts.numberType] : ["mobile", "local"];
    const monthly = await this.monthly(country).catch(() => null);
    for (const t of types) {
      // The agent's ceiling binds at the moment of purchase: an unverifiable or higher price is not bought.
      const price = monthly?.byType[t] ?? null;
      if (opts.maxMonthlyMicro != null) {
        if (price === null || (opts.currency && monthly && monthly.currency !== opts.currency.toUpperCase())) {
          return { outcome: "failed", code: "price_unverifiable", note: "the current monthly price could not be confirmed; request a fresh quote" };
        }
        if (price > opts.maxMonthlyMicro) return { outcome: "failed", code: "price_above_ceiling", note: "the current monthly price is above your ceiling; request a fresh quote" };
      }
      const nums = await this.available(country, t, 10);
      if (!nums.length) continue;
      const chosen = (opts.phoneNumber && nums.find((n) => n.phone_number === opts.phoneNumber)) || nums[0];
      const form = new URLSearchParams({ PhoneNumber: String(chosen.phone_number) });
      // Regulation: an approved bundle / a validated address of the account holder, when the country requires it.
      const reg = await this.regulation(country, t).catch(() => null);
      if (reg?.required === true) {
        const q = new URLSearchParams({ Status: "twilio-approved", IsoCountry: country, NumberType: t === "toll_free" ? "toll-free" : t, PageSize: "1" });
        const b = await this.req(`${this.numbersApi}/v2/RegulatoryCompliance/Bundles?${q}`);
        const sid = b.status === 200 ? String(((b.json.results ?? []) as Array<Record<string, any>>)[0]?.sid ?? "") : "";
        if (!/^BU[0-9a-f]{32}$/.test(sid)) {
          return { outcome: "human_action_required", code: "regulatory_bundle_required",
            note: `${country} ${t} numbers need an approved regulatory bundle for the account holder (identity and address)` };
        }
        form.set("BundleSid", sid);
      }
      if (String(chosen.address_requirements ?? "none") !== "none" && !form.has("BundleSid")) {
        const a = await this.req(this.acct(`/Addresses.json?${new URLSearchParams({ IsoCountry: country, PageSize: "20" })}`));
        const addr = a.status === 200 ? ((a.json.addresses ?? []) as Array<Record<string, any>>).find((x) => x.validated !== false) : undefined;
        if (!addr || !/^AD[0-9a-f]{32}$/.test(String(addr.sid))) {
          return { outcome: "human_action_required", code: "address_required", note: `${country} ${t} numbers need a validated address of the account holder` };
        }
        form.set("AddressSid", String(addr.sid));
      }
      const buy = await this.req(this.acct("/IncomingPhoneNumbers.json"), { method: "POST", body: form, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
      if (buy.status >= 300) {
        const code = Number(buy.json.code ?? 0);
        if (REGULATORY.has(code)) return { outcome: "human_action_required", code: "regulatory_bundle_required",
          note: `numbers in ${country} need an address/identity bundle for the account holder` };
        return { outcome: "failed", code: `provider_${code || buy.status}` };
      }
      return { outcome: "succeeded", e164: String(buy.json.phone_number), providerRef: String(buy.json.sid), numberType: t,
        monthlyMicro: price ?? undefined, currency: monthly?.currency };
    }
    return { outcome: "failed", code: "no_numbers_available", note: `no SMS-capable number available in ${country}` };
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

  async messagePrice(providerMessageId: string): Promise<{ priceMicro: number; currency: string } | null> {
    if (!/^(SM|MM)[0-9a-f]{32}$/.test(providerMessageId)) return null;
    const r = await this.req(this.acct(`/Messages/${providerMessageId}.json`));
    if (r.status !== 200 || r.json.price === null || r.json.price === undefined) return null;
    const v = priceMicro(r.json.price);
    return v === null ? null : { priceMicro: v, currency: String(r.json.price_unit ?? "USD").toUpperCase() };
  }

  async health(): Promise<void> {
    const r = await this.req(this.acct(".json"));
    if (r.status === 401 || r.status === 403) throw new Error("FLEET_SMS_PROVIDER_AUTH");
    if (r.status !== 200) throw new Error(`FLEET_SMS_PROVIDER_HTTP_${r.status}`);
  }
}
