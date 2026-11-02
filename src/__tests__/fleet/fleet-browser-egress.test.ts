/**
 * v126-egress — the browser's egress proxy, in real Chrome. A refused address is never contacted: not by a redirect hop, a script request (fetch, XHR,
 * WebSocket, EventSource, beacon), an image, a frame or a prefetch, in a bare context, the agent's session or a context built like sign-in's.
 *
 * Test sites listen on loopback. The resolver is injected (names → addresses), and one loopback address (127.0.0.2) is treated as public, so
 * every refusal below goes through the policy's real address check (127.0.0.3 and 127.0.0.1 are refused as loopback). No Chromium host-resolver
 * rules are used: Chromium sends names to the proxy, which resolves them itself.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";
import http from "http";
import https from "https";
import net from "net";
import os from "os";
import path from "path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { BrowserWorker } from "../../fleet/browser/worker.js";
import { HostResolutionPolicy } from "../../fleet/browser/policy.js";
import { EgressProxy } from "../../fleet/browser/egress.js";

const CHROME = [process.env.FLEET_TEST_CHROME ?? "", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => p && fs.existsSync(p)) ?? null;
const OPENSSL = fs.existsSync("/usr/bin/openssl");
const PUB = "127.0.0.2", PRIV = "127.0.0.3";
const DNS: Record<string, string[]> = { "allowed.test": [PUB], "refused.test": [PRIV], "loopname.test": ["127.0.0.1"], "mixed.test": [PUB, PRIV], "v6loop.test": ["::1"] };
const lookup = async (h: string) => { if (!DNS[h]) throw new Error("ENOTFOUND"); return DNS[h]; };

const listen = (s: net.Server, host: string) => new Promise<number>((r) => s.listen(0, host, () => r((s.address() as net.AddressInfo).port)));
const wsAccept = (req: http.IncomingMessage, socket: net.Socket) => {
  const accept = crypto.createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
};

describe("browser egress policy (unit)", () => {
  it("connectAddress: the URL rules, then every address public; the one checked address is returned", async () => {
    const p = new HostResolutionPolicy(lookup, Date.now, new Set([PUB]));
    expect(await p.connectAddress("allowed.test", 443)).toBe(PUB);
    for (const [h, port] of [["refused.test", 443], ["loopname.test", 80], ["mixed.test", 443], ["v6loop.test", 443], ["nowhere.test", 443], ["127.0.0.1", 8787],
      ["::1", 443], ["[::1]", 443], ["10.0.0.1", 80], ["169.254.169.254", 80], ["::ffff:10.0.0.1", 80], ["metadata.google.internal", 80], ["db.internal", 5432],
      ["printer.local", 80], ["localhost", 80], ["allowed.test", 0], ["allowed.test", 70000]] as const) {
      expect(await p.connectAddress(h, port), `${h}:${port}`).toBeNull();
    }
    // Test mode admits loopback only, never another private range.
    expect(await p.connectAddress("127.0.0.1", 9443, { allowLoopback: true })).toBe("127.0.0.1");
    expect(await p.connectAddress("10.0.0.1", 80, { allowLoopback: true })).toBeNull();
  });
});

describe.skipIf(!CHROME || !OPENSSL)("v126-egress proxy (real Chrome)", { timeout: 120_000 }, () => {
  let dir = "";
  let worker: BrowserWorker;
  let browser: Browser;
  const servers: net.Server[] = [];
  /** TCP connections that reached a refused address (127.0.0.3, or the 127.0.0.1 sentinel). Must stay 0 throughout. */
  let refusedHits = 0;
  const hits: string[] = [];
  let AH = 0, AS = 0, RH = 0, RS = 0, SENT = 0;
  const contexts: BrowserContext[] = [];
  const stats = () => worker.egressStats()!;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-egress-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", path.join(dir, "key.pem"),
      "-out", path.join(dir, "cert.pem"), "-days", "1", "-subj", "/CN=allowed.test"], { stdio: "ignore" });
    const tls = { key: fs.readFileSync(path.join(dir, "key.pem")), cert: fs.readFileSync(path.join(dir, "cert.pem")) };
    const html = (res: http.ServerResponse, title: string, body = "") => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(`<!doctype html><title>${title}</title><body>${body}</body>`); };
    const allowed = (secure: boolean) => (req: http.IncomingMessage, res: http.ServerResponse) => {
      const u = new URL(req.url ?? "/", "http://x");
      const R = `http://refused.test:${RH}`, RSx = `https://refused.test:${RS}`;
      if (u.pathname === "/ok") return html(res, secure ? "ok-https" : "ok-http");
      if (u.pathname === "/hop1") { res.writeHead(302, { Location: "/hop2" }); return res.end(); }
      if (u.pathname === "/hop2") { res.writeHead(307, { Location: secure ? `${RSx}/landed` : `${R}/landed` }); return res.end(); }
      if (u.pathname === "/to-loopback") { res.writeHead(302, { Location: `http://127.0.0.1:${SENT}/x` }); return res.end(); }
      if (u.pathname === "/script") return html(res, "start", `<script>
        const R = ${JSON.stringify(R)}, RS = ${JSON.stringify(RSx)}, L = ${JSON.stringify(`http://127.0.0.1:${SENT}`)};
        for (const u of [R + '/f', RS + '/f', '/hop1', L + '/f', ${JSON.stringify(`http://localhost:${SENT}/f`)}, ${JSON.stringify(`http://loopname.test:${SENT}/f`)}, ${JSON.stringify(`http://[::1]:${SENT}/f`)}]) fetch(u).catch(() => {});
        const x = new XMLHttpRequest(); x.open('GET', R + '/x'); x.send();
        for (const w of ['ws://refused.test:${RH}/ws', 'wss://refused.test:${RS}/ws', 'ws://127.0.0.1:${SENT}/ws']) { try { new WebSocket(w); } catch {} }
        try { new EventSource(R + '/es'); } catch {}
        navigator.sendBeacon(R + '/b', 'x');
        new Image().src = R + '/i.png';
        const f = document.createElement('iframe'); f.src = RS + '/frame'; document.body.appendChild(f);
        const l = document.createElement('link'); l.rel = 'prefetch'; l.href = R + '/pf'; document.head.appendChild(l);
        setTimeout(() => { document.title = 'done'; }, 3000);
      </script>`);
      res.writeHead(404); res.end();
    };
    const ah = http.createServer(allowed(false)), as = https.createServer(tls, allowed(true));
    for (const s of [ah, as]) s.on("upgrade", (req, socket) => wsAccept(req, socket as net.Socket));
    const count = (label: string) => (s: net.Server) => s.on("connection", () => { refusedHits++; hits.push(label); });
    const rh = http.createServer((_q, r) => r.end("refused")), rs = https.createServer(tls, (_q, r) => r.end("refused")), sent = net.createServer((c) => c.destroy());
    count("127.0.0.3 http")(rh); count("127.0.0.3 https")(rs); count("127.0.0.1 sentinel")(sent);
    AH = await listen(ah, PUB); AS = await listen(as, PUB); RH = await listen(rh, PRIV); RS = await listen(rs, PRIV); SENT = await listen(sent, "127.0.0.1");
    servers.push(ah, as, rh, rs, sent);
    // The worker's own options: the proxy is on 127.0.0.1 here (no unit), everything else as in production. The gateway is not used.
    worker = new BrowserWorker({} as never, { executablePath: CHROME!, hostPolicy: new HostResolutionPolicy(lookup, Date.now, new Set([PUB])), egressHost: "127.0.0.1", ignoreHttpsErrors: true });
    expect(await worker.selfTest()).toMatchObject({ ok: true });
    browser = await (worker as any).ensureBrowser();
  }, 60_000);

  afterAll(async () => {
    for (const c of contexts) await c.close().catch(() => {});
    await worker?.close();
    for (const s of servers) { (s as http.Server).closeAllConnections?.(); s.close(); }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  /** A bare context (no request filter), the agent's own session (with the filter) and one built like the sign-in context. */
  const kinds = async (): Promise<Array<[string, Page]>> => {
    const bare = await browser.newContext({ ignoreHTTPSErrors: true });
    const signInLike = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: false, serviceWorkers: "block" });
    const agent = await (worker as any).newSession(false);
    contexts.push(bare, signInLike, agent.context);
    return [["bare context", await bare.newPage()], ["sign-in-like context", await signInLike.newPage()], ["agent session", agent.page]];
  };

  it("allowed sites work over http, https and WebSocket, and the traffic goes through the proxy", async () => {
    const before = stats().allowed;
    for (const [name, page] of await kinds()) {
      await page.goto(`http://allowed.test:${AH}/ok`);
      expect(await page.title(), name).toBe("ok-http");
      await page.goto(`https://allowed.test:${AS}/ok`);
      expect(await page.title(), name).toBe("ok-https");
      const ws = await page.evaluate((u) => new Promise((r) => { const w = new WebSocket(u); w.onopen = () => r("open"); w.onerror = () => r("error"); setTimeout(() => r("timeout"), 5000); }), `wss://allowed.test:${AS}/ws`);
      expect(ws, name).toBe("open");
    }
    expect(stats().allowed - before).toBeGreaterThanOrEqual(9);
    expect(refusedHits, hits.join(", ")).toBe(0);
  });

  it("a redirect chain to a refused address never contacts it, in every kind of context", async () => {
    const before = stats().refused;
    for (const [name, page] of await kinds()) {
      for (const start of [`http://allowed.test:${AH}/hop1`, `https://allowed.test:${AS}/hop1`, `http://allowed.test:${AH}/to-loopback`]) {
        await page.goto(start).catch(() => undefined);
        expect(page.url(), `${name} ${start}`).not.toMatch(/refused\.test|127\.0\.0\.1/);
      }
    }
    expect(stats().refused - before).toBeGreaterThanOrEqual(9);
    expect(refusedHits, hits.join(", ")).toBe(0);
  });

  it("script requests, WebSockets, beacons, images, frames and prefetches to refused addresses never connect", async () => {
    for (const [name, page] of await kinds()) {
      await page.goto(`http://allowed.test:${AH}/script`);
      await page.waitForFunction(() => document.title === "done", undefined, { timeout: 10_000 });
      await new Promise((r) => setTimeout(r, 500));
      expect(refusedHits, `${name}: ${hits.join(", ")}`).toBe(0);
    }
  });

  it("the proxy itself: no credentials is 407; refused targets are 403 for CONNECT and plain HTTP; nothing reaches them", async () => {
    const { host, port } = (worker as any).egress.endpoint as { host: string; port: number };
    const auth = `Basic ${Buffer.from(`${(worker as any).egress.username}:${(worker as any).egress.password}`).toString("base64")}`;
    const raw = (line: string, withAuth: boolean) => new Promise<string>((resolve) => {
      const s = net.connect({ host, port }, () => s.write(`${line}\r\n${withAuth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`));
      s.once("data", (d) => { resolve(d.toString("latin1").split("\r\n")[0]); s.destroy(); });
      s.once("error", () => resolve("error"));
    });
    expect(await raw(`CONNECT allowed.test:${AS} HTTP/1.1\r\nHost: allowed.test:${AS}`, false)).toMatch(/^HTTP\/1\.1 407 /);
    expect(await raw(`CONNECT allowed.test:${AS} HTTP/1.1\r\nHost: allowed.test:${AS}`, true)).toMatch(/^HTTP\/1\.1 200 /);
    for (const t of [`refused.test:${RH}`, `127.0.0.1:${SENT}`, `localhost:${SENT}`, `loopname.test:${SENT}`, `[::1]:${SENT}`, `mixed.test:${RH}`, `${PRIV}:${RH}`,
      "10.0.0.1:80", "169.254.169.254:80", "metadata.google.internal:80", "db.internal:5432", "[fd00::1]:443"]) {
      expect(await raw(`CONNECT ${t} HTTP/1.1\r\nHost: ${t}`, true), t).toMatch(/^HTTP\/1\.1 403 /);
    }
    for (const u of [`http://refused.test:${RH}/x`, `http://127.0.0.1:${SENT}/x`, "http://169.254.169.254/latest/meta-data"]) {
      expect(await raw(`GET ${u} HTTP/1.1\r\nHost: ${new URL(u).host}`, true), u).toMatch(/^HTTP\/1\.1 403 /);
    }
    expect(await raw(`GET http://allowed.test:${AH}/ok HTTP/1.1\r\nHost: allowed.test:${AH}`, true)).toMatch(/^HTTP\/1\.1 200 /);
    // Malformed targets are refused before any lookup.
    for (const t of ["allowed.test", "allowed.test:", "user@allowed.test:443", "allowed.test:443/x"]) expect(await raw(`CONNECT ${t} HTTP/1.1\r\nHost: x`, true), t).toMatch(/^HTTP\/1\.1 400 /);
    expect(refusedHits, hits.join(", ")).toBe(0);
  });

  it("control: the same pages in Chrome WITHOUT the proxy do reach the refused address (so the zero counts above are the proxy's doing)", async () => {
    const { chromium } = await import("playwright-core");
    // Test-only name mapping for this control browser; production Chromium never resolves names itself (the proxy does).
    const plain = await chromium.launch({ executablePath: CHROME!, headless: true, args: [`--host-resolver-rules=MAP allowed.test ${PUB}, MAP refused.test ${PRIV}`] });
    try {
      const page = await (await plain.newContext({ ignoreHTTPSErrors: true })).newPage();
      const before = refusedHits;
      await page.goto(`http://allowed.test:${AH}/hop1`).catch(() => undefined);
      expect(refusedHits - before, "a redirect hop reaches the refused address without the proxy").toBeGreaterThan(0);
      const mid = refusedHits;
      await page.goto(`http://allowed.test:${AH}/script`);
      await page.waitForFunction(() => document.title === "done", undefined, { timeout: 10_000 });
      expect(refusedHits - mid, "script requests reach it without the proxy").toBeGreaterThan(0);
    } finally {
      await plain.close();
      refusedHits = 0;
      hits.length = 0;
    }
  });

  it("another local process cannot use the proxy without this process's credentials, and each proxy has its own", async () => {
    const other = new EgressProxy({ host: "127.0.0.1", policy: new HostResolutionPolicy(lookup) });
    await other.start();
    try {
      expect(other.password).not.toBe((worker as any).egress.password);
      expect(other.password.length).toBeGreaterThanOrEqual(32);
    } finally { await other.close(); }
  });
});
