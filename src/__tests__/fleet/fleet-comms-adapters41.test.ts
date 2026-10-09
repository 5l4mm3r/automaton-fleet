/**
 * Schema v41 provider adapters (unit; no network, no real account, nothing bought):
 *  • Proton Mail Bridge: loopback only; Bridge's certificate pinned exactly (proved against real TLS servers); the INBOX
 *    read-only after a UID cursor (restart-safe), real MIME parsed; outgoing From the shared address with Reply-To, a
 *    Fleet Message-ID and References (proved on the real message nodemailer composes); errors as codes, never secrets.
 *  • Twilio: a scoped API key; a live quote (availability, rental, per-message prices, regulation); the agent's ceiling
 *    checked BEFORE any purchase; a required regulatory bundle attached when approved, else a human step for that number
 *    only; message prices for charging.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import tls from "tls";
import nodemailer from "nodemailer";
import { ProtonBridgeMailProvider, type ImapLike } from "../../fleet/identity/adapters/proton-bridge.js";
import { TwilioSmsProvider, priceMicro } from "../../fleet/identity/adapters/twilio.js";

const HAS_OPENSSL = (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();

function selfSigned(dir: string, name: string): { key: string; cert: string } {
  const key = path.join(dir, `${name}.key`);
  const cert = path.join(dir, `${name}.pem`);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  return { key: fs.readFileSync(key, "utf8"), cert: fs.readFileSync(cert, "utf8") };
}

const RAW = (o: { uid: number; subject: string; from?: string; to?: string; inReplyTo?: string; refs?: string; body?: string; html?: boolean }) => Buffer.from([
  `From: ${o.from ?? "Sam Buyer <sam@customer.test>"}`, `To: ${o.to ?? "fleet+abc123def0@proton.example"}`, "Cc: other@customer.test",
  `Subject: ${o.subject}`, `Message-ID: <m${o.uid}@customer.test>`, ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`] : []),
  ...(o.refs ? [`References: ${o.refs}`] : []), "Date: Thu, 01 Oct 2026 10:00:00 +0000", "MIME-Version: 1.0",
  `Content-Type: ${o.html ? "text/html" : "text/plain"}; charset=utf-8`, "", o.body ?? `Body ${o.uid}`, ""].join("\r\n"));

function fakeImap(state: { uidValidity: bigint; messages: Array<{ uid: number; source: Buffer }>; log: string[]; failConnect?: Error }) {
  return (_o: Record<string, unknown>): ImapLike => ({
    async connect() { state.log.push("connect"); if (state.failConnect) throw state.failConnect; },
    async mailboxOpen(p, opts) { state.log.push(`open ${p} ro=${opts.readOnly}`); return { uidValidity: state.uidValidity }; },
    async search(q) {
      state.log.push(`search ${JSON.stringify(q)}`);
      if (typeof q.uid === "string") { const from = Number(q.uid.split(":")[0]); const all = state.messages.map((m) => m.uid);
        return all.filter((u) => u >= from).length ? all.filter((u) => u >= from) : [Math.max(...all)]; } // n:* always returns the last
      return state.messages.map((m) => m.uid);
    },
    async fetchAll(range, query) {
      const uids = range.split(",").map(Number);
      return state.messages.filter((m) => uids.includes(m.uid)).map((m) => ({ uid: m.uid, size: m.source.length, internalDate: new Date("2026-10-01T10:00:00Z"),
        ...(query.source ? { source: m.source } : {}) }));
    },
    async logout() { state.log.push("logout"); },
  });
}

describe("Proton Mail Bridge adapter (shared mailbox)", () => {
  let dir = "";
  let bridge = { key: "", cert: "" };
  let other = { key: "", cert: "" };
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-"));
    if (HAS_OPENSSL) { bridge = selfSigned(dir, "bridge"); other = selfSigned(dir, "other"); }
  });
  afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
  const base = () => ({ address: "Fleet@Proton.example", username: "fleet@proton.example", password: "bridge-generated-pw-123", certPem: bridge.cert });

  it.skipIf(!HAS_OPENSSL)("is loopback-only and needs Bridge's certificate and credentials", () => {
    expect(() => new ProtonBridgeMailProvider({ ...base(), host: "10.0.0.5" })).toThrow(/loopback/);
    expect(() => new ProtonBridgeMailProvider({ ...base(), host: "bridge.example.com" })).toThrow(/loopback/);
    expect(() => new ProtonBridgeMailProvider({ ...base(), certPem: "" })).toThrow(/certificate/);
    expect(() => new ProtonBridgeMailProvider({ ...base(), password: "" })).toThrow(/credentials/);
    const p = new ProtonBridgeMailProvider(base());
    expect(p.address).toBe("fleet@proton.example");
    expect(p.mode).toBe("shared");
  });

  it.skipIf(!HAS_OPENSSL)("pins Bridge's certificate exactly (a real TLS handshake: the pinned certificate passes, any other fails)", async () => {
    let tlsOpts: Record<string, any> = {};
    const p = new ProtonBridgeMailProvider({ ...base(), imapFactory: (o) => { tlsOpts = o.tls as Record<string, any>; return fakeImap({ uidValidity: 1n, messages: [], log: [] })({}); } });
    await p.health();
    const handshake = (server: { key: string; cert: string }) => new Promise<string>((resolve) => {
      const srv = tls.createServer({ key: server.key, cert: server.cert }, (s) => s.end());
      srv.listen(0, "127.0.0.1", () => {
        const port = (srv.address() as { port: number }).port;
        const c = tls.connect({ host: "127.0.0.1", port, ...tlsOpts }, () => { c.end(); srv.close(); resolve("ok"); });
        c.on("error", (e) => { srv.close(); resolve(String((e as Error).message)); });
      });
    });
    expect(await handshake(bridge)).toBe("ok");
    expect(await handshake(other)).not.toBe("ok"); // another certificate (even a valid self-signed one) is refused
  });

  it.skipIf(!HAS_OPENSSL)("reads the INBOX read-only after a UID cursor: real MIME parsed, restart-safe, UIDVALIDITY change re-scans", async () => {
    const state = { uidValidity: 7n, log: [] as string[], messages: [
      { uid: 11, source: RAW({ uid: 11, subject: "Order" }) },
      { uid: 12, source: RAW({ uid: 12, subject: "Re: hello", inReplyTo: "<x1@proton.example>", refs: "<x0@proton.example> <x1@proton.example>" }) },
      { uid: 13, source: RAW({ uid: 13, subject: "HTML only", html: true, body: "<p>Hello <b>there</b></p>" }) },
    ] };
    const p = new ProtonBridgeMailProvider({ ...base(), imapFactory: fakeImap(state) });
    const first = await p.fetchShared(null);
    expect(first.messages).toHaveLength(3);
    expect(first.messages[0]).toMatchObject({ providerId: "imap:7:11", messageId: "<m11@customer.test>", from: "\"Sam Buyer\" <sam@customer.test>",
      to: ["fleet+abc123def0@proton.example"], cc: ["other@customer.test"], subject: "Order", body: "Body 11" });
    expect(first.messages[1]).toMatchObject({ inReplyTo: "<x1@proton.example>", references: ["<x0@proton.example>", "<x1@proton.example>"] });
    expect(first.messages[2].body).toMatch(/Hello\s+there/);
    expect(state.log).toContain("open INBOX ro=true");
    expect(JSON.parse(first.cursor!)).toEqual({ v: "7", u: 13 });
    // Nothing new: the server's "n:*" quirk (always returns the last message) is filtered out.
    expect((await p.fetchShared(first.cursor)).messages).toHaveLength(0);
    state.messages.push({ uid: 14, source: RAW({ uid: 14, subject: "New" }) });
    const next = await p.fetchShared(first.cursor);
    expect(next.messages.map((m) => m.subject)).toEqual(["New"]);
    // UIDVALIDITY changed: a fresh scan of the last 7 days (the registry de-duplicates by provider id).
    state.uidValidity = 8n;
    const rescan = await p.fetchShared(next.cursor);
    expect(rescan.messages).toHaveLength(4);
    expect(rescan.messages[0].providerId).toBe("imap:8:11");
    expect(state.log.filter((l) => l === "logout").length).toBeGreaterThanOrEqual(4);
  });

  it.skipIf(!HAS_OPENSSL)("sends From the shared address with Reply-To, a Fleet Message-ID and References (the real composed message)", async () => {
    const stream = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
    let raw = "";
    let smtpOpts: Record<string, unknown> = {};
    const p = new ProtonBridgeMailProvider({ ...base(), smtpFactory: (o) => { smtpOpts = o; return { sendMail: async (m) => {
      const info = await stream.sendMail(m as never); raw = (info.message as Buffer).toString("utf8"); return { messageId: info.messageId }; } }; } });
    const r = await p.send({ from: "fleet@proton.example", to: ["sam@customer.test"], subject: "Re: Order", body: "Ships Friday.",
      replyTo: "fleet+abc123def0@proton.example", messageId: "<11111111-2222-3333-4444-555555555555@proton.example>",
      inReplyTo: "<m11@customer.test>", references: ["<m10@customer.test>", "<m11@customer.test>"] });
    expect(r.externalMessageId).toBe("<11111111-2222-3333-4444-555555555555@proton.example>");
    expect(raw).toMatch(/^From: fleet@proton\.example$/m);
    expect(raw).toMatch(/^Reply-To: fleet\+abc123def0@proton\.example$/m);
    expect(raw).toMatch(/^Message-ID: <11111111-2222-3333-4444-555555555555@proton\.example>$/m);
    expect(raw).toMatch(/^In-Reply-To: <m11@customer\.test>$/m);
    expect(raw).toMatch(/^References: <m10@customer\.test> <m11@customer\.test>$/m);
    expect(smtpOpts).toMatchObject({ host: "127.0.0.1", port: 1025, secure: false, requireTLS: true, logger: false, debug: false });
    await expect(p.send({ from: "someone@else.example", to: ["a@b.test"], subject: "s", body: "b" })).rejects.toThrow(/FLEET_MAIL_FOREIGN_SENDER/);
  });

  it.skipIf(!HAS_OPENSSL)("v56: an order delivery's files go as attachments; a Bcc'd message is routed by its Delivered-To (ours only)", async () => {
    const stream = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
    let raw = "";
    const p = new ProtonBridgeMailProvider({ ...base(), smtpFactory: () => ({ sendMail: async (m) => {
      const info = await stream.sendMail(m as never); raw = (info.message as Buffer).toString("utf8"); return { messageId: info.messageId }; } }) });
    await p.send({ from: "fleet@proton.example", to: ["buyer@customer.test"], subject: "Your order", body: "Attached.",
      attachments: [{ fileName: "planner-pack.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-1.4 planner") }] });
    expect(raw).toMatch(/Content-Type: application\/pdf; name=planner-pack\.pdf/);
    expect(raw).toMatch(/Content-Disposition: attachment; filename=planner-pack\.pdf/);
    expect(raw).toContain(Buffer.from("%PDF-1.4 planner").toString("base64"));
    const bcc = Buffer.from(["Delivered-To: fleet+abc123def0@proton.example", "X-Original-To: someone@elsewhere.test", "From: List <list@news.test>",
      "To: subscribers@news.test", "Subject: Digest", "Message-ID: <d1@news.test>", "Date: Thu, 01 Oct 2026 10:00:00 +0000", "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8", "", "digest body", ""].join("\r\n"));
    const q = new ProtonBridgeMailProvider({ ...base(), imapFactory: fakeImap({ uidValidity: 3n, messages: [{ uid: 1, source: bcc }], log: [] }) });
    const got = (await q.fetchShared(null)).messages[0];
    expect(got.to).toEqual(["subscribers@news.test"]);
    expect(got.cc).toEqual(["fleet+abc123def0@proton.example"]);
  });

  it.skipIf(!HAS_OPENSSL)("errors are codes: an authentication failure never carries the password or the server's text", async () => {
    const authErr = Object.assign(new Error("AUTHENTICATIONFAILED bridge-generated-pw-123 rejected for fleet@proton.example"), { authenticationFailed: true });
    const p = new ProtonBridgeMailProvider({ ...base(), imapFactory: fakeImap({ uidValidity: 1n, messages: [], log: [], failConnect: authErr }),
      smtpFactory: () => ({ sendMail: async () => { throw Object.assign(new Error("535 bad creds bridge-generated-pw-123"), { code: "EAUTH" }); } }) });
    const e1 = await p.fetchShared(null).catch((e: Error) => e.message);
    expect(e1).toBe("FLEET_MAIL_PROVIDER_AUTH");
    const e2 = await p.send({ from: "fleet@proton.example", to: ["a@b.test"], subject: "s", body: "b" }).catch((e: Error) => e.message);
    expect(e2).toBe("FLEET_MAIL_PROVIDER_AUTH");
    const refused = new ProtonBridgeMailProvider({ ...base(), imapFactory: fakeImap({ uidValidity: 1n, messages: [], log: [], failConnect: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1143"), { code: "ECONNREFUSED" }) }) });
    await expect(refused.health()).rejects.toThrow(/^FLEET_MAIL_PROVIDER_CONNECT$/);
  });
});

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

describe("Twilio adapter, cost-aware (v41)", () => {
  const acc = "AC" + "0".repeat(32);
  const key = { accountSid: acc, apiKeySid: "SK" + "1".repeat(32), apiKeySecret: "api-key-secret-0123456789" };
  const pricing: Array<[RegExp, () => { json: unknown }]> = [
    [/pricing\.twilio\.com\/v1\/PhoneNumbers\/Countries\/GB/, () => ({ json: { price_unit: "USD", phone_number_prices: [
      { number_type: "mobile", base_price: "1.15", current_price: "1.15" }, { number_type: "local", base_price: "1.15", current_price: "1.00" },
      { number_type: "toll free", current_price: "2.00" }] } })],
    [/pricing\.twilio\.com\/v1\/Messaging\/Countries\/GB/, () => ({ json: { price_unit: "USD",
      outbound_sms_prices: [{ carrier: "A", prices: [{ number_type: "mobile", current_price: "0.0400" }] }, { carrier: "B", prices: [{ number_type: "mobile", current_price: "0.0524" }] }],
      inbound_sms_prices: [{ number_type: "mobile", current_price: "0.0079" }] } })],
  ];

  it("parses decimal prices exactly", () => {
    expect(priceMicro("1.15")).toBe(1_150_000);
    expect(priceMicro("-0.00790")).toBe(7_900);
    expect(priceMicro("0.0524")).toBe(52_400);
    expect(priceMicro("abc")).toBeNull();
  });

  it("uses the scoped API key; quotes availability, rental, the dearest carrier's message price and regulation", async () => {
    const { f, calls } = fakeFetch([...pricing,
      [/AvailablePhoneNumbers\/GB\/Mobile\.json/, () => ({ json: { available_phone_numbers: [{ phone_number: "+447700900111", locality: "London", capabilities: { SMS: true, voice: true }, address_requirements: "none" }] } })],
      [/AvailablePhoneNumbers\/GB\/Local\.json/, () => ({ json: { available_phone_numbers: [] } })],
      [/numbers\.twilio\.com\/v2\/RegulatoryCompliance\/Regulations/, () => ({ json: { results: [{ requirements: { end_user: [{ name: "Individual" }], supporting_document: [{ name: "Proof of address" }] } }] } })],
    ]);
    const t = new TwilioSmsProvider({ ...key, fetchImpl: f });
    const q = await t.quote("GB", ["mobile", "local"]);
    expect(q).toMatchObject({ provider: "twilio", currency: "USD",
      options: [{ numberType: "mobile", monthlyMicro: 1_150_000, available: [{ e164: "+447700900111", locality: "London" }], smsCapable: true, voiceCapable: true }],
      messaging: { outbound_mobile: 52_400, inbound_mobile: 7_900 },
      regulation: { mobile: { required: true, endUser: ["Individual"], documents: ["Proof of address"], address: "none" } } });
    expect(calls.every((c) => c.auth === "Basic " + Buffer.from(`${key.apiKeySid}:${key.apiKeySecret}`).toString("base64"))).toBe(true);
    expect(calls.some((c) => c.method !== "GET")).toBe(false); // a quote buys nothing
    expect(() => new TwilioSmsProvider({ accountSid: acc, apiKeySid: "SKnot", apiKeySecret: "x" })).toThrow(/API key/);
  });

  it("never buys above the agent's ceiling or at an unverifiable price", async () => {
    const above = fakeFetch([...pricing, [/AvailablePhoneNumbers/, () => ({ json: { available_phone_numbers: [{ phone_number: "+447700900111" }] } })]]);
    expect(await new TwilioSmsProvider({ ...key, fetchImpl: above.f }).provision("GB", { numberType: "mobile", maxMonthlyMicro: 1_000_000, currency: "USD" }))
      .toMatchObject({ outcome: "failed", code: "price_above_ceiling" });
    expect(above.calls.some((c) => c.method === "POST")).toBe(false);
    const noPrice = fakeFetch([[/AvailablePhoneNumbers/, () => ({ json: { available_phone_numbers: [{ phone_number: "+447700900111" }] } })]]);
    expect(await new TwilioSmsProvider({ ...key, fetchImpl: noPrice.f }).provision("GB", { numberType: "mobile", maxMonthlyMicro: 5_000_000, currency: "USD" }))
      .toMatchObject({ outcome: "failed", code: "price_unverifiable" });
    expect(noPrice.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("a required bundle: attached when approved; otherwise a human step for this number only (nothing bought)", async () => {
    const regulated: Array<[RegExp, (c: Call) => { status?: number; json?: unknown }]> = [...pricing,
      [/AvailablePhoneNumbers\/GB\/Mobile\.json/, () => ({ json: { available_phone_numbers: [{ phone_number: "+447700900111", address_requirements: "none" }] } })],
      [/RegulatoryCompliance\/Regulations/, () => ({ json: { results: [{ requirements: {} }] } })]];
    const none = fakeFetch([...regulated, [/RegulatoryCompliance\/Bundles/, () => ({ json: { results: [] } })]]);
    expect(await new TwilioSmsProvider({ ...key, fetchImpl: none.f }).provision("GB", { numberType: "mobile", maxMonthlyMicro: 2_000_000, currency: "USD" }))
      .toMatchObject({ outcome: "human_action_required", code: "regulatory_bundle_required" });
    expect(none.calls.some((c) => c.method === "POST")).toBe(false);
    const approved = fakeFetch([...regulated, [/RegulatoryCompliance\/Bundles\?.*Status=twilio-approved/, () => ({ json: { results: [{ sid: "BU" + "b".repeat(32) }] } })],
      [/^POST .*IncomingPhoneNumbers\.json$/, () => ({ status: 201, json: { sid: "PN" + "a".repeat(32), phone_number: "+447700900111" } })]]);
    expect(await new TwilioSmsProvider({ ...key, fetchImpl: approved.f }).provision("GB", { numberType: "mobile", maxMonthlyMicro: 2_000_000, currency: "USD" }))
      .toMatchObject({ outcome: "succeeded", monthlyMicro: 1_150_000, numberType: "mobile" });
    expect(new URLSearchParams(approved.calls.find((c) => c.method === "POST")!.body).get("BundleSid")).toBe("BU" + "b".repeat(32));
    // A number requiring a validated address without one: a human step, nothing bought.
    const addr = fakeFetch([...pricing, [/AvailablePhoneNumbers\/GB\/Local\.json/, () => ({ json: { available_phone_numbers: [{ phone_number: "+441610000000", address_requirements: "local" }] } })],
      [/RegulatoryCompliance\/Regulations/, () => ({ json: { results: [] } })], [/Addresses\.json/, () => ({ json: { addresses: [] } })]]);
    expect(await new TwilioSmsProvider({ ...key, fetchImpl: addr.f }).provision("GB", { numberType: "local", maxMonthlyMicro: 2_000_000, currency: "USD" }))
      .toMatchObject({ outcome: "human_action_required", code: "address_required" });
    expect(addr.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("reads a message's final price (null until priced); a health check needs valid credentials", async () => {
    const { f } = fakeFetch([
      [/Messages\/SM[a]{32}\.json$/, () => ({ json: { sid: "SM" + "a".repeat(32), price: "-0.00790", price_unit: "USD" } })],
      [/Messages\/SM[b]{32}\.json$/, () => ({ json: { sid: "SM" + "b".repeat(32), price: null } })],
      [new RegExp(`Accounts/${acc}\\.json$`), () => ({ status: 401, json: {} })],
    ]);
    const t = new TwilioSmsProvider({ ...key, fetchImpl: f });
    expect(await t.messagePrice("SM" + "a".repeat(32))).toEqual({ priceMicro: 7_900, currency: "USD" });
    expect(await t.messagePrice("SM" + "b".repeat(32))).toBeNull();
    expect(await t.messagePrice("../x")).toBeNull();
    await expect(t.health()).rejects.toThrow(/^FLEET_SMS_PROVIDER_AUTH$/);
  });
});
