/**
 * Founder egress (Phase F.2): policy and a CONNECT proxy — built, tested,
 * NOT deployed. Founder units stay loopback-only (IPAddressDeny=any) until the
 * owner decides on internet access.
 *
 * When enabled later, a founder reaches the internet only through this proxy
 * on the controller host:
 *   - deny by default; only HTTPS CONNECT to port 443 of allow-listed hosts
 *     (exact names or "*.suffix" wildcards);
 *   - never IP literals, never loopback / private / link-local / metadata
 *     destinations, even if DNS for an allowed name resolves there
 *     (DNS-rebinding guard: the resolved address is checked before connecting);
 *   - each founder authenticates to the proxy (Proxy-Authorization), so every
 *     connection is attributed and can be switched off per founder;
 *   - plain HTTP forwarding is refused (no URL-fetch/payment proxy);
 *   - every decision is reported to an audit callback.
 */

import dns from "dns/promises";
import http from "http";
import net from "net";

export interface EgressPolicy {
  enabled: boolean;
  /** Exact host names or "*.example.com" suffix wildcards. */
  allowHosts: readonly string[];
  ports: readonly number[];
}

export const EGRESS_OFF: EgressPolicy = Object.freeze({ enabled: false, allowHosts: Object.freeze([]), ports: Object.freeze([443]) });

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export type EgressDecision = { allowed: true } | { allowed: false; code: string };

/** Name-level decision (before DNS). */
export function decideEgress(policy: EgressPolicy, host: string, port: number): EgressDecision {
  if (!policy.enabled) return { allowed: false, code: "FLEET_EGRESS_DISABLED" };
  const h = host.toLowerCase().replace(/\.$/, "");
  if (net.isIP(h.replace(/^\[|\]$/g, ""))) return { allowed: false, code: "FLEET_EGRESS_IP_LITERAL" };
  if (!HOST_RE.test(h) || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return { allowed: false, code: "FLEET_EGRESS_HOST_INVALID" };
  if (!policy.ports.includes(port)) return { allowed: false, code: "FLEET_EGRESS_PORT_DENIED" };
  const ok = policy.allowHosts.some((a) => (a.startsWith("*.") ? h.endsWith(a.slice(1)) && h.length > a.length - 1 : h === a.toLowerCase()));
  return ok ? { allowed: true } : { allowed: false, code: "FLEET_EGRESS_HOST_DENIED" };
}

/** Addresses a founder must never reach, whatever DNS says. */
export function isForbiddenAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  if (x.startsWith("::ffff:")) return isForbiddenAddress(x.slice(7));
  return x === "::" || x === "::1" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb") || x.startsWith("ff");
}

export interface EgressProxyOptions {
  policy: () => EgressPolicy;
  /** Map a Proxy-Authorization credential to a founder id (null = refuse). */
  authenticate: (proxyAuthorization: string | undefined) => string | null;
  audit: (event: { founder: string | null; host: string; port: number; allowed: boolean; code?: string }) => void;
  resolve?: (host: string) => Promise<string[]>;
  connect?: (port: number, ip: string) => net.Socket;
}

export function createEgressProxy(o: EgressProxyOptions): http.Server {
  const resolve = o.resolve ?? (async (h: string) => (await dns.lookup(h, { all: true })).map((r) => r.address));
  const server = http.createServer((_req, res) => {
    // Only CONNECT tunnels; no plain-HTTP forwarding / URL fetching.
    res.writeHead(405, { "content-type": "text/plain" }).end("CONNECT only\n");
  });
  server.on("connect", async (req: http.IncomingMessage, client: net.Socket) => {
    const deny = (status: number, founder: string | null, host: string, port: number, code: string) => {
      o.audit({ founder, host, port, allowed: false, code });
      client.end(`HTTP/1.1 ${status} ${code}\r\n\r\n`);
    };
    const m = /^([^:\s]+):(\d{1,5})$/.exec(req.url ?? "");
    const host = m?.[1] ?? "";
    const port = Number(m?.[2] ?? 0);
    const founder = o.authenticate(req.headers["proxy-authorization"]);
    if (!founder) return deny(407, null, host, port, "FLEET_EGRESS_AUTH_REQUIRED");
    if (!m) return deny(400, founder, host, port, "FLEET_EGRESS_BAD_TARGET");
    const d = decideEgress(o.policy(), host, port);
    if (!d.allowed) return deny(403, founder, host, port, d.code);
    let ips: string[];
    try {
      ips = await resolve(host);
    } catch {
      return deny(502, founder, host, port, "FLEET_EGRESS_DNS_FAILED");
    }
    if (ips.length === 0 || ips.some(isForbiddenAddress)) return deny(403, founder, host, port, "FLEET_EGRESS_ADDRESS_FORBIDDEN");
    const upstream = (o.connect ?? ((p, ip) => net.connect(p, ip)))(port, ips[0]);
    upstream.once("connect", () => {
      o.audit({ founder, host, port, allowed: true });
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once("error", () => deny(502, founder, host, port, "FLEET_EGRESS_UPSTREAM_FAILED"));
    client.once("error", () => upstream.destroy());
  });
  return server;
}
