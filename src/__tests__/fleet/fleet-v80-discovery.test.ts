/**
 * v80 discovery (units): robots.txt, the sitemap (only what the registry lists — published offers while sales are open),
 * the IndexNow key file, structured data and Open Graph on an offer page, the owner's OAuth callback page, and the IndexNow
 * notifier (only due pages; a 200 / 202 marks them notified; nothing sent when nothing is due).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import { PublicPages, discoveryHead, type PublicPagesPort } from "../../fleet/service/public-pages.js";
import { IndexNowPinger, INDEXNOW_ENDPOINT } from "../../fleet/service/indexnow.js";

const KEY = "0123456789abcdef0123456789abcdef";

describe("v80 discovery pages and IndexNow (units)", () => {
  const port: PublicPagesPort = {
    async publicCall(fn) {
      if (fn === "svc_sitemap") return { ok: true, open: true, base: "https://api.agentfleet.vip", offers: [{ slug: "cash-flow-workbook-abc123", lastmod: "2026-10-15T10:00:00Z" }, { slug: "<bad>", lastmod: "x" }] };
      if (fn === "svc_indexnow_key") return { ok: true, key: KEY };
      return { ok: false };
    },
  };
  let server: http.Server;
  let base = "";
  beforeAll(async () => {
    const pages = new PublicPages(port);
    server = http.createServer((req, res) => void pages.handle(req, res, (req.url ?? "/").split("?")[0], "127.0.0.1"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server?.close(); });

  it("robots, sitemap and key file; the callback page shows the code (escaped)", async () => {
    const robots = await (await fetch(`${base}/robots.txt`)).text();
    expect(robots).toContain("Allow: /o/");
    expect(robots).toContain("Disallow: /order/");
    expect(robots).toContain("Sitemap: https://api.agentfleet.vip/sitemap.xml");
    const map = await (await fetch(`${base}/sitemap.xml`)).text();
    expect(map).toContain("<loc>https://api.agentfleet.vip/o/cash-flow-workbook-abc123</loc><lastmod>2026-10-15</lastmod>");
    expect(map).not.toContain("bad");
    expect(await (await fetch(`${base}/${KEY}.txt`)).text()).toBe(KEY);
    expect((await fetch(`${base}/${"f".repeat(32)}.txt`)).status).toBe(404);
    const cb = await (await fetch(`${base}/oauth/callback?code=abc%3Cscript%3E&state=s1`)).text();
    expect(cb).toContain("abc&lt;script&gt;");
    expect(cb).not.toContain("<script>");
  });

  it("an offer page's structured data and preview tags carry only its public fields (and cannot break out of the data block)", () => {
    const h = discoveryHead({ slug: "s-abc123", title: "Workbook </script><b>", summary: "Plan cash", brand: "Ledgerline", priceMinor: 1200, currency: "GBP", available: true },
      [{ n: 1, contentType: "image/png", fileName: "cover.png" }]);
    expect(h).toContain('"price":"12.00"');
    expect(h).toContain('"availability":"https://schema.org/InStock"');
    expect(h).toContain('<meta property="og:image" content="/o/s-abc123/preview/1">');
    expect(h).not.toContain("</script><b>");
  });

  it("IndexNow: only due pages; a 202 marks them notified; nothing sent when none are due or too soon", async () => {
    const sent: Array<{ url: string; body: any }> = [];
    const done: Array<{ n: number; status: number }> = [];
    let due = [{ offerId: "o1", slug: "cash-flow-workbook-abc123", updatedAt: "2026-10-15T10:00:00Z" }];
    let t = 0;
    const p = new IndexNowPinger({ due: async () => ({ key: KEY, base: "https://api.agentfleet.vip", offers: due }), done: async (o, st) => { done.push({ n: o.length, status: st }); } },
      async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { status: 202 }; }, { everyMs: 60_000, now: () => t });
    expect(await p.tick()).toEqual({ sent: 1, status: 202 });
    expect(sent[0]).toEqual({ url: INDEXNOW_ENDPOINT, body: { host: "api.agentfleet.vip", key: KEY, keyLocation: `https://api.agentfleet.vip/${KEY}.txt`,
      urlList: ["https://api.agentfleet.vip/o/cash-flow-workbook-abc123"] } });
    expect(done).toEqual([{ n: 1, status: 202 }]);
    expect(await p.tick()).toEqual({ sent: 0, status: null }); // too soon
    t += 61_000; due = [];
    expect(await p.tick()).toEqual({ sent: 0, status: null });
    expect(sent).toHaveLength(1);
  });
});
