/**
 * v82 public pages (unit, fake registry port): the buyer's consent to immediate supply. The offer page shows two separate,
 * unticked, required boxes with the exact wording; a purchase without both ticks is refused before the registry is asked;
 * with both, the registry gets the wording's version. The order page asks before the payment link (no auto-refresh while
 * it asks), records the confirmation on the page's own POST, and shows it once recorded.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import { PublicPages, type PublicPagesPort } from "../../fleet/service/public-pages.js";
import { BUYER_CONSENT_VERSION, BUYER_CONSENT_WORDING } from "../../fleet/storefront/consent.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

describe("v82 public pages: the buyer's consent to immediate supply", () => {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  let recorded = false;
  const token = "a".repeat(64);
  const port: PublicPagesPort = {
    async publicCall(fn, args) {
      calls.push({ fn, args });
      if (fn === "svc_offer_page") return { ok: true, seller: "Sold by Test Owner.", offer: { slug: args[0], kind: "product", available: true, title: "Cash-flow workbook",
        summary: "A workbook", brand: "Ledgerline", priceMinor: 1200, currency: "GBP", deliverables: ["Workbook"], description: "d", terms: "t", previews: [] } };
      if (fn === "svc_offer_buy") return args[2] === BUYER_CONSENT_VERSION ? { ok: true, token } : { ok: false, code: "FLEET_CONSENT_REQUIRED" };
      if (fn === "svc_order_page") return { ok: true, seller: "Sold by Test Owner.", order: { item: "Cash-flow workbook", amountMinor: 1200, currency: "GBP", kind: "digital_file",
        payment: "awaiting_payment", status: "awaiting_payment", checkout: "open", ...(recorded ? { approvalUrl: "https://www.paypal.com/checkoutnow?token=ORD1" } : {}),
        consent: { kind: "digital_immediate", recorded, version: BUYER_CONSENT_VERSION, statements: [...BUYER_CONSENT_WORDING.digital_immediate], ...(recorded ? { at: "2026-10-16T12:00:00Z" } : {}) } } };
      if (fn === "svc_order_consent") { recorded = true; return { ok: true }; }
      return { ok: false };
    },
  };
  const pages = new PublicPages(port);
  let server: http.Server;
  let base = "";
  beforeAll(async () => {
    server = http.createServer((req, res) => void pages.handle(req, res, (req.url ?? "/").split("?")[0], "127.0.0.1"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server?.close(); });
  const slug = "cash-flow-workbook-abc123";
  const form = (o: Record<string, string>) => ({ method: "POST", redirect: "manual" as const, headers: { origin: base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });

  it("the offer page shows two unticked, required boxes with the exact wording, inside the buy form", async () => {
    const html = await (await fetch(`${base}/o/${slug}`)).text();
    const formHtml = html.slice(html.indexOf(`action="/o/${slug}/buy"`), html.indexOf("</form>", html.indexOf(`action="/o/${slug}/buy"`)));
    for (const [i, t] of BUYER_CONSENT_WORDING.digital_immediate.entries()) {
      expect(formHtml).toContain(esc(t));
      expect(formHtml).toMatch(new RegExp(`<input type="checkbox" name="c${i + 1}" value="yes" required`));
    }
    expect(formHtml).not.toMatch(/checked/);
    expect(formHtml).toContain(`name="consent" value="${BUYER_CONSENT_VERSION}"`);
  });

  it("a purchase without both ticks is refused before the registry is asked; with both, the registry gets the version", async () => {
    calls.length = 0;
    for (const body of [{}, { c1: "yes" }, { c2: "yes", consent: BUYER_CONSENT_VERSION }, { c1: "yes", c2: "yes" }, { c1: "yes", c2: "yes", consent: "2020-01-01.v0" }]) {
      const r = await fetch(`${base}/o/${slug}/buy`, form(body as Record<string, string>));
      expect(r.status).toBe(400);
      expect(await r.text()).toContain("Please confirm before buying");
    }
    expect(calls.filter((c) => c.fn === "svc_offer_buy")).toEqual([]);
    const ok = await fetch(`${base}/o/${slug}/buy`, form({ c1: "yes", c2: "yes", consent: BUYER_CONSENT_VERSION }));
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe(`/order/${token}`);
    expect(calls.find((c) => c.fn === "svc_offer_buy")?.args).toEqual([slug, expect.stringMatching(/^[0-9a-f]{64}$/), BUYER_CONSENT_VERSION]);
  });

  it("the order page asks before the payment link (and does not refresh while asking); the page's own POST records it; then it is shown", async () => {
    let html = await (await fetch(`${base}/order/${token}`)).text();
    expect(html).toContain("Before you pay");
    expect(html).not.toContain("paypal.com");
    expect(html).not.toContain('http-equiv="refresh"');
    for (const t of BUYER_CONSENT_WORDING.digital_immediate) expect(html).toContain(esc(t));
    expect((await fetch(`${base}/order/${token}/consent`, form({ c1: "yes", consent: BUYER_CONSENT_VERSION }))).status).toBe(400);
    expect(recorded).toBe(false);
    // A cross-site POST is refused.
    expect((await fetch(`${base}/order/${token}/consent`, { ...form({ c1: "yes", c2: "yes", consent: BUYER_CONSENT_VERSION }), headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" } })).status).toBe(403);
    expect(recorded).toBe(false);
    const r = await fetch(`${base}/order/${token}/consent`, form({ c1: "yes", c2: "yes", consent: BUYER_CONSENT_VERSION }));
    expect(r.status).toBe(303);
    expect(calls.find((c) => c.fn === "svc_order_consent")?.args).toEqual([token, expect.stringMatching(/^[0-9a-f]{64}$/), BUYER_CONSENT_VERSION]);
    html = await (await fetch(`${base}/order/${token}`)).text();
    expect(html).toContain("paypal.com/checkoutnow");
    expect(html).toContain("Your confirmation");
    expect(html).toContain("Recorded 2026-10-16 12:00 UTC");
    expect(html).not.toContain("Before you pay");
  });

  // 2026-10-19: in a real browser the order page's consent form was refused ("cross-site request refused"): under the page's
  // former Referrer-Policy no-referrer, Chrome sends `Origin: null`, no Referer and `Sec-Fetch-Site: same-origin`. The page now
  // sends Referrer-Policy same-origin; the check accepts the browser's own same-origin mark and still refuses every other site.
  it("the consent POST as a browser sends it is accepted; cross-site, same-site and unmarked ones are refused", async () => {
    // Its own pages instance with a clock 10 minutes apart per request, so the write rate limit never answers first.
    let t = Date.now();
    const own = new PublicPages(port, { now: () => (t += 600_000) });
    const srv = http.createServer((req, res) => void own.handle(req, res, (req.url ?? "/").split("?")[0], "127.0.0.1"));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const at = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const post = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
      const body = new URLSearchParams({ c1: "yes", c2: "yes", consent: BUYER_CONSENT_VERSION }).toString();
      const u = new URL(`${at}/order/${token}/consent`);
      const rq = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body), ...headers } }, (rs) => { rs.resume(); resolve(rs.statusCode ?? 0); });
      rq.on("error", reject); rq.end(body);
    });
    const pageRes = await fetch(`${base}/order/${token}`);
    expect(pageRes.headers.get("referrer-policy")).toBe("same-origin");
    for (const [h, want] of [
      [{ origin: "null", "sec-fetch-site": "cross-site" }, 403],
      [{ origin: "null", "sec-fetch-site": "same-site" }, 403],          // another subdomain (e.g. the admin site)
      [{ origin: "null", "sec-fetch-site": "none" }, 403],
      [{ origin: "null" }, 403],                                         // no browser mark, no origin: refused
      [{}, 403],
      [{ origin: at, "sec-fetch-site": "cross-site" }, 403],             // the browser's mark wins over a claimed origin
      [{ origin: "https://evil.example", "sec-fetch-site": "same-origin" }, 403],
      [{ referer: "https://evil.example/x" }, 403],
    ] as Array<[Record<string, string>, number]>) expect(await post(h), JSON.stringify(h)).toBe(want);
    // Exactly what Chrome sent from the live order page (2026-10-19), and what it sends under the new policy.
    expect(await post({ origin: "null", "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" })).toBe(303);
    expect(await post({ origin: at, referer: `${at}/order/${token}`, "sec-fetch-site": "same-origin" })).toBe(303);
    srv.close();
  });
});
