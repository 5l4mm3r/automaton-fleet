/**
 * The PayPal rail readiness probe (custody, read-only). Against a fake PayPal: it opens the dashboard-sealed credential
 * with the existing custody key (never creating one), signs in, reads the balance list, an empty Transaction Search
 * window and the webhook; it sends nothing else (no order, capture, refund or payout) and its answer carries statuses
 * and names only — never the secret, the token or an amount.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { sealTo } from "../../fleet/identity/crypto.js";
import { CUSTODY_KEY_FILE, fingerprintOf, loadOrCreateCustodyKey } from "../../fleet/custody/sealed-vault.js";
import { parseProbeArgs, runProbe } from "../../fleet/custody/paypal-probe.js";
import { PAYPAL_REQUIRED_WEBHOOK_EVENTS } from "../../fleet/custody/paypal-treasury.js";
import type { HttpPort } from "../../fleet/custody/signers.js";

const REF = "vault:paypal/treasury";
const SECRET = "AbCdEfGh123456:ZyXwVuTs98765432secret";
const TOKEN = "A21AAprobe-token-000000001";
const URL_ = "https://api.example.test/v1/webhooks/paypal";

function fakePayPal(opts: { auth?: boolean; events?: string[]; url?: string; search?: number } = {}) {
  const calls: Array<{ method: string; path: string }> = [];
  const http: HttpPort = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname });
    const json = (status: number, body: unknown) => ({ status, json: async () => body });
    if (u.pathname === "/v1/oauth2/token") return opts.auth === false ? json(401, { error: "invalid_client" }) : json(200, { access_token: TOKEN, expires_in: 32400 });
    if (init.headers.Authorization !== `Bearer ${TOKEN}`) return json(401, {});
    if (u.pathname === "/v1/reporting/balances") return json(200, { balances: [{ currency: "GBP", available_balance: { value: "12.34" }, total_balance: { value: "12.34" } }] });
    if (u.pathname === "/v1/reporting/transactions") return json(opts.search ?? 200, { transaction_details: [], total_pages: 1 });
    if (u.pathname === "/v1/notifications/webhooks/4JR443408B058674D")
      return json(200, { id: "4JR443408B058674D", url: opts.url ?? URL_, event_types: (opts.events ?? [...PAYPAL_REQUIRED_WEBHOOK_EVENTS]).map((name) => ({ name })) });
    return json(404, {});
  };
  return { http, calls };
}

describe("PayPal readiness probe (read-only)", () => {
  let dir = "";
  let sealed: Array<{ vaultRef: string; sealedB64: string; fingerprint: string }> = [];
  const gateway = { sealedCredentials: async () => sealed };
  const args = parseProbeArgs(["live", REF, "4JR443408B058674D", URL_]);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-probe-"));
    fs.chmodSync(dir, 0o700);
    const k = loadOrCreateCustodyKey(dir);
    sealed = [{ vaultRef: REF, sealedB64: sealTo(k.publicKeyDer, SECRET, `custody:${REF}`).toString("base64"), fingerprint: fingerprintOf(k.publicKeyDer) }];
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reports sign-in, balance currencies, Transaction Search and the webhook; reads only; prints no secret, token or amount", async () => {
    const pp = fakePayPal();
    const out = await runProbe(args, { gateway, stateDir: dir, http: pp.http });
    expect(out).toEqual({ credentialOpened: true, authenticated: true, balances: { status: 200, currencies: ["GBP"] }, transactionSearch: { status: 200 },
      webhook: { status: 200, urlMatches: true, missingEvents: [] } });
    expect(pp.calls.filter((c) => c.method !== "GET").map((c) => c.path)).toEqual(["/v1/oauth2/token"]);
    expect(pp.calls.map((c) => c.path).sort()).toEqual(["/v1/notifications/webhooks/4JR443408B058674D", "/v1/oauth2/token", "/v1/reporting/balances", "/v1/reporting/transactions"]);
    const text = JSON.stringify(out);
    for (const s of [SECRET, "secret", TOKEN, "12.34", "1234"]) expect(text).not.toContain(s);
  });

  it("names what is wrong: a wrong URL, missing events, refused Transaction Search, refused sign-in", async () => {
    const some = PAYPAL_REQUIRED_WEBHOOK_EVENTS.filter((e) => !e.startsWith("CUSTOMER.DISPUTE"));
    expect((await runProbe(args, { gateway, stateDir: dir, http: fakePayPal({ url: "https://elsewhere.test/hook", events: some, search: 403 }).http })))
      .toMatchObject({ authenticated: true, transactionSearch: { status: 403 },
        webhook: { status: 200, urlMatches: false, missingEvents: ["CUSTOMER.DISPUTE.CREATED", "CUSTOMER.DISPUTE.UPDATED", "CUSTOMER.DISPUTE.RESOLVED"] } });
    const refused = fakePayPal({ auth: false });
    expect(await runProbe(args, { gateway, stateDir: dir, http: refused.http })).toMatchObject({ credentialOpened: true, authenticated: false, balances: { status: null } });
    expect(refused.calls.map((c) => c.path)).toEqual(["/v1/oauth2/token"]);
  });

  it("never creates a custody key, and a credential sealed to another key is not opened", async () => {
    fs.rmSync(path.join(dir, CUSTODY_KEY_FILE));
    await expect(runProbe(args, { gateway, stateDir: dir, http: fakePayPal().http })).rejects.toThrow(/no custody key/);
    expect(fs.existsSync(path.join(dir, CUSTODY_KEY_FILE))).toBe(false);
    loadOrCreateCustodyKey(dir); // a different key now
    const pp = fakePayPal();
    expect(await runProbe(args, { gateway, stateDir: dir, http: pp.http })).toMatchObject({ credentialOpened: false, authenticated: false });
    expect(pp.calls).toEqual([]);
  });

  it("refuses malformed arguments", () => {
    expect(() => parseProbeArgs(["prod", REF, "4JR443408B058674D", URL_])).toThrow();
    expect(() => parseProbeArgs(["live", "vault:other/x", "4JR443408B058674D", URL_])).toThrow();
    expect(() => parseProbeArgs(["live", REF, "bad id", URL_])).toThrow();
    expect(() => parseProbeArgs(["live", REF, "4JR443408B058674D", "http://insecure.test/x"])).toThrow();
  });
});
