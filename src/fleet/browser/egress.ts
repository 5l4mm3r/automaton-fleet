/**
 * v126-egress — the browser worker's egress proxy. Chromium reaches the network only through it, so every connection a page makes — each redirect hop,
 * script requests (fetch, XHR, WebSocket, EventSource, beacons), images, frames, service workers — is checked against the same policy as the
 * worker's request filter (HostResolutionPolicy), and a refused address is never contacted. The filter in the browser context stays as a first
 * layer: it sees paths and methods (owner-account rules, the sign-in origin lock), which this proxy does not, since HTTPS is tunnelled unopened.
 *
 * - HTTPS and WebSockets: CONNECT host:port. HTTP: absolute-URI requests, forwarded one at a time; Chromium follows redirects itself, so every hop
 *   comes back here as a new request.
 * - The proxy resolves the name itself and connects to the exact address it checked (no second lookup: no DNS rebinding between check and use).
 * - Credentials are random per process: no other local process can use this proxy to reach the internet (a founder sandbox, for example).
 * - It listens on one dedicated loopback address; the systemd unit allows the browser that one address and keeps denying the rest of loopback.
 */
import crypto from "crypto";
import http from "http";
import net from "net";
import type { HostResolutionPolicy } from "./policy.js";

/** The one dedicated loopback address the unit allows the browser (deploy/systemd/automaton-fleet-browser.service.d/20-no-loopback.conf). */
export const BROWSER_EGRESS_ADDRESS = "127.0.0.77";

export interface EgressProxyOptions {
  /** The address to listen on (production: the dedicated loopback address the unit allows). */
  host: string;
  port?: number;
  policy: Pick<HostResolutionPolicy, "connectAddress">;
  /** Test-only, as in the worker. */
  allowLoopback?: boolean;
  log?: (level: string, event: string, detail?: Record<string, unknown>) => void;
  connectTimeoutMs?: number;
}

const HOP_BY_HOP = new Set(["proxy-authorization", "proxy-connection", "connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]);

export class EgressProxy {
  readonly username = "fleet-browser";
  readonly password = crypto.randomBytes(24).toString("base64url");
  private readonly expected: Buffer;
  private server: http.Server | null = null;
  /** Every socket, tunnels included (closeAllConnections does not cover a CONNECT tunnel). */
  private readonly sockets = new Set<net.Socket>();
  private address: { host: string; port: number } | null = null;
  /** Counts since start, for the worker's log and the tests. */
  readonly stats = { allowed: 0, refused: 0, unauthorised: 0, failed: 0 };

  constructor(private readonly o: EgressProxyOptions) {
    this.expected = Buffer.from(`Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`);
  }

  /** The proxy server address for Chromium. */
  get url(): string {
    if (!this.address) throw new Error("egress proxy not started");
    const h = net.isIP(this.address.host) === 6 ? `[${this.address.host}]` : this.address.host;
    return `http://${h}:${this.address.port}`;
  }

  get endpoint(): { host: string; port: number } {
    if (!this.address) throw new Error("egress proxy not started");
    return { ...this.address };
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => void this.forward(req, res));
    server.on("connect", (req, socket, head) => void this.tunnel(req, socket as net.Socket, head));
    server.on("upgrade", (req, socket) => { this.stats.refused++; (socket as net.Socket).end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); });
    server.on("clientError", (_e, socket) => { try { (socket as net.Socket).end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); } catch { /* gone */ } });
    server.maxConnections = 512;
    server.on("connection", (c: net.Socket) => { this.sockets.add(c); c.on("close", () => this.sockets.delete(c)); });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: this.o.host, port: this.o.port ?? 0, exclusive: true }, () => { server.off("error", reject); resolve(); });
    });
    const a = server.address() as net.AddressInfo;
    this.address = { host: a.address, port: a.port };
    this.server = server;
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    const closed = new Promise<void>((r) => s.close(() => r()));
    for (const c of this.sockets) c.destroy();
    this.sockets.clear();
    await closed;
  }

  private authorised(req: http.IncomingMessage): boolean {
    const got = Buffer.from(String(req.headers["proxy-authorization"] ?? ""));
    return got.length === this.expected.length && crypto.timingSafeEqual(got, this.expected);
  }

  private note(event: string, host: string, port: number) {
    this.o.log?.("info", event, { host: host.slice(0, 120), port });
  }

  private async decide(host: string, port: number): Promise<string | null> {
    return this.o.policy.connectAddress(host, port, { allowLoopback: this.o.allowLoopback }).catch(() => null);
  }

  /** CONNECT host:port — HTTPS, and WebSockets through a proxy. */
  private async tunnel(req: http.IncomingMessage, client: net.Socket, head: Buffer): Promise<void> {
    client.on("error", () => client.destroy());
    if (!this.authorised(req)) {
      this.stats.unauthorised++;
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"fleet\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    // host:port exactly (authority form); a default port is still written out, so URL parsing (which drops it) is not used.
    const m = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(req.url ?? "");
    if (!m) { client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return; }
    const host = m[1], port = Number(m[2]);
    const addr = await this.decide(host, port);
    if (!addr) {
      this.stats.refused++;
      this.note("browser_egress_refused", host, port);
      client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = net.connect({ host: addr, port });
    this.sockets.add(upstream);
    upstream.on("close", () => this.sockets.delete(upstream));
    let open = false;
    const timer = setTimeout(() => upstream.destroy(new Error("connect timeout")), this.o.connectTimeoutMs ?? 15_000);
    upstream.once("connect", () => {
      clearTimeout(timer);
      open = true;
      this.stats.allowed++;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => {
      clearTimeout(timer);
      if (!open) { this.stats.failed++; client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); } else client.destroy();
    });
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  }

  /** An absolute-URI HTTP request. Chromium follows redirects itself, so the proxy never does. */
  private async forward(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.authorised(req)) {
      this.stats.unauthorised++;
      res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="fleet"', "Content-Length": "0", Connection: "close" }).end();
      return;
    }
    let u: URL;
    try { u = new URL(req.url ?? ""); } catch { res.writeHead(400, { Connection: "close" }).end(); return; }
    if (u.protocol !== "http:" || u.username || u.password) { res.writeHead(400, { Connection: "close" }).end(); return; }
    const port = u.port ? Number(u.port) : 80;
    const addr = await this.decide(u.hostname, port);
    if (!addr) {
      this.stats.refused++;
      this.note("browser_egress_refused", u.hostname, port);
      res.writeHead(403, { "Content-Length": "0", Connection: "close" }).end();
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k) && v !== undefined) headers[k] = v;
    headers.host = u.host;
    const up = http.request({ host: addr, port, method: req.method, path: `${u.pathname}${u.search}`, headers, setHost: false, agent: false,
      timeout: this.o.connectTimeoutMs ?? 15_000 }, (r) => {
      this.stats.allowed++;
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(r.headers)) if (!HOP_BY_HOP.has(k) && v !== undefined) out[k] = v as string | string[];
      res.writeHead(r.statusCode ?? 502, r.statusMessage, out);
      r.pipe(res);
    });
    up.on("timeout", () => up.destroy(new Error("timeout")));
    up.on("error", () => { this.stats.failed++; if (!res.headersSent) res.writeHead(502, { Connection: "close" }); res.end(); });
    req.pipe(up);
  }
}
