/**
 * Schema v36 provider adapters (unit; a fake HTTP layer — no network, no real account): the request shapes the Mailgun-
 * and Twilio-compatible adapters send, how they parse replies, that provider error bodies never surface, and that a
 * regulatory refusal becomes an action-scoped human step. Also the authentication-message classifier.
 */
import { describe, it, expect } from "vitest";
import { MailgunMailProvider } from "../../fleet/identity/adapters/mailgun.js";
import { TwilioSmsProvider } from "../../fleet/identity/adapters/twilio.js";
import { isAuthenticationMessage } from "../../fleet/identity/providers.js";

type Call = { url: string; method: string; body: string; auth: string };
function fakeFetch(routes: Array<[RegExp, (c: Call) => { status?: number; json?: unknown }]>) {
  const calls: Call[] = [];
  const f = (async (input: string | URL, init?: RequestInit) => {
    const c: Call = { url: String(input), method: init?.method ?? "GET", body: init?.body ? String(init.body) : "",
      auth: String((init?.headers as Record<string, string>)?.Authorization ?? "") };
    calls.push(c);
    const hit = routes.find(([re]) => re.test(`${c.method} ${c.url}`));
    const r = hit ? hit[1](c) : { status: 404, json: { message: "not found" } };
    const status = r.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(r.json ?? {}), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
}

describe("mail adapter (Mailgun-compatible)", () => {
  const key = "key-0123456789abcdef0123";
  it("sends from the Fleet domain only, with threading headers; never another domain", async () => {
    const { f, calls } = fakeFetch([[/^POST https:\/\/api\.eu\.mailgun\.net\/v3\/mail\.fleet\.example\/messages$/, () => ({ json: { id: "<abc@mail.fleet.example>" } })]]);
    const m = new MailgunMailProvider({ domain: "mail.fleet.example", apiKey: key, apiBase: "https://api.eu.mailgun.net", fetchImpl: f });
    const r = await m.send({ from: "maya@mail.fleet.example", to: ["a@x.test", "b@x.test"], subject: "Hi", body: "Body", inReplyTo: "<orig@x.test>" });
    expect(r.providerMessageId).toBe("<abc@mail.fleet.example>");
    const body = new URLSearchParams(calls[0].body);
    expect(body.getAll("to")).toEqual(["a@x.test", "b@x.test"]);
    expect(body.get("h:In-Reply-To")).toBe("<orig@x.test>");
    expect(calls[0].auth).toBe("Basic " + Buffer.from(`api:${key}`).toString("base64"));
    await expect(m.send({ from: "x@other.example", to: ["a@x.test"], subject: "s", body: "b" })).rejects.toThrow(/FOREIGN_SENDER/);
  });

  it("fetches stored inbound mail via events + storage (provider storage only); errors are status codes, never bodies", async () => {
    const { f } = fakeFetch([
      [/^GET https:\/\/api\.mailgun\.net\/v3\/mail\.fleet\.example\/events\?/, () => ({ json: { items: [
        { id: "ev1", timestamp: 1_790_000_000, storage: { url: "https://api.mailgun.net/v3/domains/mail.fleet.example/messages/K1" } },
        { id: "ev2", timestamp: 1_790_000_100, storage: { url: "https://evil.example/steal" } }] } })],
      [/^GET https:\/\/api\.mailgun\.net\/v3\/domains\/mail\.fleet\.example\/messages\/K1$/, () => ({ json: { "Message-Id": "<m1@x.test>", From: "sam@customer.test",
        subject: "Order", "body-plain": "12 prints please" } })],
    ]);
    const m = new MailgunMailProvider({ domain: "mail.fleet.example", apiKey: key, fetchImpl: f });
    const got = await m.fetch("maya@mail.fleet.example", new Date(0));
    expect(got).toEqual([expect.objectContaining({ id: "<m1@x.test>", from: "sam@customer.test", subject: "Order", body: "12 prints please", to: "maya@mail.fleet.example" })]);
    const bad = fakeFetch([[/./, () => ({ status: 401, json: { message: `invalid key ${key}` } })]]);
    const m2 = new MailgunMailProvider({ domain: "mail.fleet.example", apiKey: key, fetchImpl: bad.f });
    await expect(m2.fetch("maya@mail.fleet.example", new Date(0))).rejects.toThrow(/^FLEET_MAIL_PROVIDER_HTTP_401$/);
    expect(() => new MailgunMailProvider({ domain: "mail.fleet.example", apiKey: key, apiBase: "http://api.mailgun.net" })).toThrow(/https/);
  });

  it("creates the catch-all store route once", async () => {
    let routes: unknown[] = [];
    const { f, calls } = fakeFetch([
      [/^GET .*\/v3\/routes/, () => ({ json: { items: routes } })],
      [/^POST .*\/v3\/routes$/, (c) => { routes = [{ expression: new URLSearchParams(c.body).get("expression") }]; return { json: { route: {} } }; }],
    ]);
    const m = new MailgunMailProvider({ domain: "mail.fleet.example", apiKey: key, fetchImpl: f });
    expect(await m.ensureInboundRoute()).toEqual({ created: true });
    expect(new URLSearchParams(calls[1].body).get("action")).toBe("store()");
    expect(await m.ensureInboundRoute()).toEqual({ created: false });
  });
});

describe("SMS adapter (Twilio-compatible)", () => {
  const sid = "AC" + "0".repeat(32);
  const token = "tok-0123456789abcdef";
  it("buys an SMS-capable mobile number and reports its monthly price", async () => {
    const { f, calls } = fakeFetch([
      [/AvailablePhoneNumbers\/GB\/Mobile\.json/, () => ({ json: { available_phone_numbers: [{ phone_number: "+447700900111" }] } })],
      [/^POST .*IncomingPhoneNumbers\.json$/, () => ({ status: 201, json: { sid: "PN" + "a".repeat(32), phone_number: "+447700900111" } })],
      [/pricing\.twilio\.com\/v1\/PhoneNumbers\/Countries\/GB/, () => ({ json: { price_unit: "USD", phone_number_prices: [{ number_type: "mobile", current_price: "1.15" }] } })],
    ]);
    const t = new TwilioSmsProvider({ accountSid: sid, authToken: token, fetchImpl: f });
    expect(await t.provision("GB")).toEqual({ outcome: "succeeded", e164: "+447700900111", providerRef: "PN" + "a".repeat(32), numberType: "mobile",
      monthlyMicro: 1_150_000, currency: "USD" });
    expect(new URLSearchParams(calls.find((c) => c.method === "POST")!.body).get("PhoneNumber")).toBe("+447700900111");
    expect(calls[0].auth).toBe("Basic " + Buffer.from(`${sid}:${token}`).toString("base64"));
  });

  it("a regulatory bundle requirement is a human step for that number only; no numbers is a plain failure", async () => {
    const reg = fakeFetch([
      [/AvailablePhoneNumbers\/DE\/Mobile\.json/, () => ({ json: { available_phone_numbers: [{ phone_number: "+4915100000000" }] } })],
      [/^POST .*IncomingPhoneNumbers\.json$/, () => ({ status: 400, json: { code: 21649, message: "Bundle required" } })],
    ]);
    expect(await new TwilioSmsProvider({ accountSid: sid, authToken: token, fetchImpl: reg.f }).provision("DE"))
      .toMatchObject({ outcome: "human_action_required", code: "regulatory_bundle_required" });
    const none = fakeFetch([[/AvailablePhoneNumbers/, () => ({ json: { available_phone_numbers: [] } })]]);
    expect(await new TwilioSmsProvider({ accountSid: sid, authToken: token, fetchImpl: none.f }).provision("FR"))
      .toMatchObject({ outcome: "failed", code: "no_numbers_available" });
  });

  it("sends, lists inbound only, releases", async () => {
    const { f, calls } = fakeFetch([
      [/^POST .*Messages\.json$/, () => ({ status: 201, json: { sid: "SM1" } })],
      [/^GET .*Messages\.json\?/, () => ({ json: { messages: [
        { sid: "SM2", direction: "inbound", from: "+447700900555", to: "+447700900111", body: "hello", date_sent: "Thu, 01 Oct 2026 10:00:00 +0000" },
        { sid: "SM3", direction: "outbound-api", from: "+447700900111", to: "+447700900555", body: "mine", date_sent: "Thu, 01 Oct 2026 10:01:00 +0000" }] } })],
      [/^DELETE .*IncomingPhoneNumbers\/PN[a]{32}\.json$/, () => ({ status: 204 })],
    ]);
    const t = new TwilioSmsProvider({ accountSid: sid, authToken: token, fetchImpl: f });
    expect(await t.send({ from: "+447700900111", to: "+447700900555", body: "hi" })).toEqual({ providerMessageId: "SM1" });
    expect(await t.fetch("+447700900111", new Date("2026-09-30T00:00:00Z"))).toEqual([expect.objectContaining({ id: "SM2", body: "hello" })]);
    expect(await t.release("PN" + "a".repeat(32))).toEqual({ ok: true });
    expect(await t.release("../../etc")).toEqual({ ok: false, code: "bad_ref" });
    expect(calls.some((c) => c.url.includes(".."))).toBe(false);
  });
});

describe("authentication-message classifier", () => {
  it("withholds sign-up, login and reset codes; leaves business mail whole", () => {
    expect(isAuthenticationMessage("Confirm your account", "Click https://shop.test/verify?t=abc to verify")).toBe(true);
    expect(isAuthenticationMessage("Your login code", "Your security code is 734211")).toBe(true);
    expect(isAuthenticationMessage("", "Your verification code is 991234")).toBe(true);
    expect(isAuthenticationMessage("Reset", "Reset your password: https://x.test/reset?k=1")).toBe(true);
    expect(isAuthenticationMessage("Bulk order", "12 prints to 4 Example Road TT1 2AB, ref 55881, call 07700 900123")).toBe(false);
    expect(isAuthenticationMessage("Invoice 1042", "Please pay 1042.50 by Friday: https://pay.test/i/1042")).toBe(false);
  });
});
