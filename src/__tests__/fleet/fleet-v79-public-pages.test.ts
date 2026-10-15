/**
 * v79 public pages (unit, fake registry port): a channel's attribution code on an offer link is carried into the buy and
 * brief forms and recorded on the order / enquiry; image samples are shown; the outreach opt-out asks on GET and records
 * only on the page's own POST.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import { PublicPages, type PublicPagesPort } from "../../fleet/service/public-pages.js";

describe("v79 public pages: attribution, image samples, opt-out", () => {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  let optedOut = false;
  const port: PublicPagesPort = {
    async publicCall(fn, args) {
      calls.push({ fn, args });
      if (fn === "svc_offer_page") return { ok: true, seller: "Sold by Test Owner.", offer: { slug: args[0], kind: String(args[0]).startsWith("svc") ? "service" : "product",
        available: true, title: "Cash-flow workbook", summary: "A workbook", brand: "Ledgerline", priceMinor: 1200, currency: "GBP", deliverables: ["Workbook"],
        description: "d", terms: "t", previews: [{ n: 1, fileName: "cover.png", contentType: "image/png", sizeBytes: 2000 }, { n: 2, fileName: "sample.pdf", contentType: "application/pdf", sizeBytes: 9000 }] } };
      if (fn === "svc_offer_buy") return { ok: true, token: "a".repeat(64) };
      if (fn === "svc_offer_enquire") return { ok: true, token: "b".repeat(64) };
      if (fn === "svc_attribute") return { ok: true };
      if (fn === "svc_outreach_optout") { if (args[1] === true) optedOut = true; return { ok: true, brand: "Ledgerline", optedOut }; }
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

  it("carries ?ref into the forms and attributes the order / enquiry; ignores a malformed code", async () => {
    const html = await (await fetch(`${base}/o/${slug}?ref=0123456789ab`)).text();
    expect(html).toContain(`action="/o/${slug}/buy?ref=0123456789ab"`);
    expect(html).toContain(`<img src="/o/${slug}/preview/1"`);
    expect(html).not.toContain(`<img src="/o/${slug}/preview/2"`);
    const svc = await (await fetch(`${base}/o/svc-brief-abc123?ref=0123456789ab`)).text();
    expect(svc).toContain(`/o/svc-brief-abc123/enquire?ref=0123456789ab`);
    expect(await (await fetch(`${base}/o/${slug}?ref=<script>`)).text()).not.toContain("?ref=");
    const buy = await fetch(`${base}/o/${slug}/buy?ref=0123456789ab`, { method: "POST", redirect: "manual", headers: { origin: base } });
    expect(buy.status).toBe(303);
    expect(calls.find((c) => c.fn === "svc_attribute")?.args).toEqual(["order", "a".repeat(64), "0123456789ab"]);
    const enq = await fetch(`${base}/o/svc-brief-abc123/enquire?ref=0123456789ab`, { method: "POST", headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ name: "Bea", email: "bea@example.test", body: "I need a workbook" }) });
    expect(await enq.json()).toMatchObject({ ok: true });
    expect(calls.filter((c) => c.fn === "svc_attribute").map((c) => c.args[0])).toEqual(["order", "enquiry"]);
  });

  it("opt-out: GET asks (a scanner opts nobody out); the page's POST records; a cross-site POST is refused", async () => {
    const t = "c".repeat(64);
    const get = await (await fetch(`${base}/u/${t}`)).text();
    expect(get).toContain("Stop messages from Ledgerline?");
    expect(optedOut).toBe(false);
    expect((await fetch(`${base}/u/${t}`, { method: "POST", headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect(optedOut).toBe(false);
    const post = await (await fetch(`${base}/u/${t}`, { method: "POST", headers: { origin: base } })).text();
    expect(post).toContain("You will not hear from Ledgerline again");
    expect(optedOut).toBe(true);
    expect((await fetch(`${base}/u/not-a-token`)).status).toBe(404);
  });
});
