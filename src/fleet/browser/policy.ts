/**
 * Browser URL policy (schema v37): the agent may visit any legitimate public website; the worker never reaches the
 * host, its loopback services, private networks or cloud metadata. Name-based checks here; the systemd unit's
 * IPAddressDeny enforces the same at the network layer for private ranges. v79: the unit must allow loopback while the
 * worker reaches PostgreSQL over TCP on 127.0.0.1, so a public name that RESOLVES to a loopback or private address is
 * refused here too (browserHostResolvesPublic, on every request); the network-layer close (PostgreSQL over its unix socket,
 * loopback denied in the unit) is a host change in the activation package.
 */
import dns from "dns";
import net from "net";

const PRIVATE_V4: Array<[number, number]> = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24],
  [0xc0a80000, 16], [0xc6120000, 15], [0xe0000000, 4], [0xf0000000, 4],
];

function v4Private(ip: string): boolean {
  const n = ip.split(".").reduce((a, x) => (a << 8) + Number(x), 0) >>> 0;
  return PRIVATE_V4.some(([base, bits]) => (n >>> (32 - bits)) === (base >>> (32 - bits)));
}

/** Whether the worker may request this URL. `allowLoopback` exists for the test suite only. */
export function browserUrlAllowed(raw: string, opts: { allowLoopback?: boolean } = {}): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol === "about:" || u.protocol === "data:" || u.protocol === "blob:") return true;
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loop = host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1";
  if (loop) return Boolean(opts.allowLoopback);
  if (host.endsWith(".internal") || host.endsWith(".local") || host === "metadata.google.internal") return false;
  const kind = net.isIP(host);
  if (kind === 4) return !v4Private(host);
  if (kind === 6) return !/^(fc|fd|fe8|fe9|fea|feb|ff|::ffff:|::$)/.test(host);
  return true;
}

/** v79: an address the worker must never reach (loopback, private, link-local, CGNAT, multicast, reserved, mapped v4). */
export function addressPrivate(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return v4Private(ip);
  if (kind === 6) {
    const low = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
    if (mapped) return v4Private(mapped[1]);
    return low === "::1" || low === "::" || /^(fc|fd|fe8|fe9|fea|feb|ff|::ffff:|64:ff9b:)/.test(low);
  }
  return true;
}

type Lookup = (host: string) => Promise<string[]>;
const systemLookup: Lookup = async (host) => (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address);
const RESOLVE_TTL_MS = 30_000;

/**
 * v79: whether a URL's host resolves only to public addresses (cached briefly). A name that does not resolve is refused
 * (nothing to reach); an IP literal was already checked by browserUrlAllowed. `allowLoopback` (tests) skips the check.
 */
export class HostResolutionPolicy {
  private readonly cache = new Map<string, { ok: boolean; at: number }>();
  constructor(private readonly lookup: Lookup = systemLookup, private readonly now: () => number = Date.now) {}
  async allowed(raw: string, opts: { allowLoopback?: boolean } = {}): Promise<boolean> {
    if (!browserUrlAllowed(raw, opts)) return false;
    if (opts.allowLoopback) return true;
    let u: URL;
    try { u = new URL(raw); } catch { return false; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return true;
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (net.isIP(host)) return true;
    const hit = this.cache.get(host);
    if (hit && this.now() - hit.at < RESOLVE_TTL_MS) return hit.ok;
    let ok = false;
    try {
      const addrs = await this.lookup(host);
      ok = addrs.length > 0 && addrs.every((a) => !addressPrivate(a));
    } catch { ok = false; }
    if (this.cache.size > 2000) this.cache.clear();
    this.cache.set(host, { ok, at: this.now() });
    return ok;
  }
}
