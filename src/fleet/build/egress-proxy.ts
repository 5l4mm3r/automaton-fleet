/**
 * The build environment's only way out (schema v89): an HTTPS CONNECT proxy on a loopback port that opens tunnels only to
 * allow-listed package-registry hosts on port 443. Plain HTTP proxying, other ports, IP literals and every other host are
 * refused; nothing is decrypted or cached. The build unit itself may reach only loopback (systemd IPAddressDeny), and
 * its sandbox only this port (Landlock), so a customer's build scripts can fetch dependencies and nothing else.
 */
import http from "http";
import net from "net";

export const DEFAULT_EGRESS_ALLOW = ["registry.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org", "crates.io", "static.crates.io", "index.crates.io",
  "proxy.golang.org", "sum.golang.org", "rubygems.org", "repo.maven.apache.org", "repo1.maven.org"] as const;

export function parseAllow(v: string | undefined): string[] {
  const xs = (v?.trim() ? v.split(",") : [...DEFAULT_EGRESS_ALLOW]).map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (const x of xs) if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(x)) throw new Error(`not a host name: ${x}`);
  return xs;
}

/** Whether a CONNECT target is allowed: an exact allow-listed host name (no IP literal), port 443. */
export function allowedTarget(target: string, allow: readonly string[]): { host: string; port: number } | null {
  const m = /^([a-z0-9.-]{1,253}):(\d{1,5})$/i.exec(target);
  if (!m) return null;
  const host = m[1].toLowerCase(), port = Number(m[2]);
  if (port !== 443 || net.isIP(host) !== 0 || !allow.includes(host)) return null;
  return { host, port };
}

export function startEgressProxy(o: { port: number; allow: readonly string[]; host?: string; log?: (event: string, detail: Record<string, unknown>) => void;
  connect?: (port: number, host: string) => net.Socket }): Promise<http.Server> {
  const tunnels = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    // Plain HTTP proxying is refused: registries are HTTPS, and nothing is relayed in the clear.
    o.log?.("egress_refused", { method: req.method, reason: "not CONNECT" });
    res.writeHead(403, { "content-type": "text/plain" }).end("only HTTPS tunnels to package registries\n");
  });
  server.on("connect", (req, client: net.Socket, head) => {
    const t = allowedTarget(req.url ?? "", o.allow);
    if (!t) {
      o.log?.("egress_refused", { target: String(req.url ?? "").slice(0, 120) });
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n", () => client.destroy());
      return;
    }
    const upstream = (o.connect ?? ((p, h) => net.connect(p, h)))(t.port, t.host);
    upstream.setTimeout(120_000, () => upstream.destroy());
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    tunnels.add(client); tunnels.add(upstream);
    // A tunnel lives while both ends do: either end closing (or failing) closes both.
    const close = () => { upstream.destroy(); client.destroy(); tunnels.delete(client); tunnels.delete(upstream); };
    for (const s of [upstream, client]) { s.on("error", close); s.on("end", close); s.on("close", close); }
  });
  // Closing the proxy ends its tunnels too (they are detached from the HTTP server's own connections).
  const closeServer = server.close.bind(server);
  server.close = ((cb?: (err?: Error) => void) => { for (const t of tunnels) t.destroy(); tunnels.clear(); server.closeAllConnections(); return closeServer(cb); }) as typeof server.close;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host ?? "127.0.0.1", () => resolve(server));
  });
}

if (process.argv[1] && /fleet[\\/]build[\\/]egress-proxy\.(ts|js)$/.test(process.argv[1])) {
  const port = Number(process.env.FLEET_BUILD_PROXY_PORT ?? 3129);
  if (process.getuid?.() === 0) { console.error("refusing to run as root"); process.exit(1); }
  startEgressProxy({ port, allow: parseAllow(process.env.FLEET_BUILD_EGRESS_ALLOW), log: (event, detail) => console.log(JSON.stringify({ event, ...detail })) })
    .then(() => console.log(JSON.stringify({ event: "egress_proxy_started", port })))
    .catch((e) => { console.error(String(e)); process.exit(1); });
}
