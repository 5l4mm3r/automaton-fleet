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
  if (kind === 6) return !v6Private(host) && !/^::ffff:/.test(host);   // a mapped literal in a URL stays refused, as before
  return true;
}

/** v79: an address the worker must never reach (loopback, private, link-local, CGNAT, multicast, reserved, mapped v4). */
export function addressPrivate(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return v4Private(ip);
  if (kind === 6) return v6Private(ip);
  return true;
}

/** The 16 bytes of a valid IPv6 literal (compressed or not, with or without a dotted IPv4 tail), or null. */
function v6Bytes(ip: string): number[] | null {
  let a = ip.toLowerCase().replace(/%.*$/, "");
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (dotted) {
    const o = dotted.slice(1).map(Number);
    a = a.slice(0, dotted.index) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = a.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail].map((g) => parseInt(g, 16));
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups.flatMap((g) => [g >> 8, g & 0xff]);
}

/**
 * v79, widened after the 2 Nov review: an IPv6 address the worker must never reach. Besides loopback, unspecified, unique-local,
 * link-local, site-local and multicast, every form that carries or translates to an IPv4 address is refused unless it is an
 * IPv4-mapped public one: IPv4-compatible ::/96, SIIT ::ffff:0:0:0/96, NAT64 64:ff9b::/96 and 64:ff9b:1::/48, 6to4 2002::/16,
 * Teredo 2001::/32; and the discard (100::/64) and documentation (2001:db8::/32) ranges.
 */
export function v6Private(ip: string): boolean {
  const b = v6Bytes(ip);
  if (!b) return true;
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4Private(b.slice(12).join("."));   // ::ffff:a.b.c.d
  if (zero(0, 12)) return true;                                                                   // ::, ::1, ::a.b.c.d
  if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff) return true;                                  // ::ffff:0:a.b.c.d
  const w0 = (b[0] << 8) | b[1], w1 = (b[2] << 8) | b[3];
  if (w0 === 0x64 && w1 === 0xff9b) return true;                                                  // NAT64 (both prefixes)
  if (w0 === 0x2002) return true;                                                                 // 6to4
  if (w0 === 0x2001 && (w1 === 0 || w1 === 0xdb8)) return true;                                   // Teredo, documentation
  if (w0 === 0x100 && zero(2, 8)) return true;                                                    // discard
  if ((b[0] & 0xfe) === 0xfc) return true;                                                        // fc00::/7
  if (b[0] === 0xfe && (b[1] & 0x80) === 0x80) return true;                                       // fe80::/10, fec0::/10
  return b[0] === 0xff;                                                                           // multicast
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
  /**
   * `testPublic` is for tests only: loopback addresses a test site listens on, treated as public so that the refusal of every other
   * address goes through the real check. Production passes nothing.
   */
  constructor(private readonly lookup: Lookup = systemLookup, private readonly now: () => number = Date.now, private readonly testPublic: ReadonlySet<string> = new Set()) {}
  private refused(ip: string): boolean { return !this.testPublic.has(ip) && addressPrivate(ip); }
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
      ok = addrs.length > 0 && addrs.every((a) => !this.refused(a));
    } catch { ok = false; }
    if (this.cache.size > 2000) this.cache.clear();
    this.cache.set(host, { ok, at: this.now() });
    return ok;
  }

  /**
   * v126-egress: the one address a connection to host:port may go to, or null. The egress proxy connects to exactly the address returned: there is no
   * second lookup, so a name cannot answer differently between the check and the connection. Same rules as `allowed`: the URL rules, then every
   * address the name resolves to must be public. `allowLoopback` (tests) admits loopback addresses only, never another private range.
   */
  async connectAddress(host: string, port: number, opts: { allowLoopback?: boolean } = {}): Promise<string | null> {
    const h = host.replace(/^\[|\]$/g, "").toLowerCase();
    if (!h || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    const literal = net.isIP(h) === 6 ? `[${h}]` : h;
    if (!browserUrlAllowed(`https://${literal}:${port}/`, opts)) return null;
    const admit = (a: string) => !this.refused(a) || (Boolean(opts.allowLoopback) && (a === "::1" || /^127\./.test(a)));
    if (net.isIP(h)) return admit(h) ? h : null;
    let addrs: string[];
    try { addrs = await this.lookup(h); } catch { return null; }
    if (!addrs.length || !addrs.every(admit)) return null;
    return addrs[0];
  }
}
