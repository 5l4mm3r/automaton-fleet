/**
 * Controlled founder web research (Pre-Genesis step 4): URL and destination policy.
 *
 * Founder-supplied URLs and remote redirects are hostile. This module is pure and shared by FleetController
 * (a first check, before anything leaves the controller) and the isolated fetcher (the authoritative check,
 * repeated on every redirect hop and on every resolved address).
 *
 * URL rules:
 *   - https only (no http downgrade, no ftp/file/data/javascript/ws…);
 *   - no userinfo;
 *   - port 443 only;
 *   - ≤ 2048 characters, no whitespace/control characters;
 *   - the fragment is dropped.
 * Host rules:
 *   - a DNS name with a dot (IP literals in any form are refused, since the WHATWG parser normalises decimal/hex/octal
 *     IPv4 into dotted form and IPv6 into brackets);
 *   - not localhost, not a private-use suffix (.local, .internal, .lan, .home.arpa, …);
 *   - not the fleet's own domains.
 * Address rules (every resolved address must be public): loopback, private (RFC 1918), CGNAT, link-local
 * (incl. cloud metadata 169.254.169.254), multicast, reserved, documentation, benchmarking, unspecified,
 * IPv4-mapped/NAT64/6to4/Teredo forms of those, ULA, site-local, and the host's own addresses are all refused.
 */

import net from "net";

export const RESEARCH_LIMITS = Object.freeze({
  maxUrlLength: 2048,
  maxRedirects: 3,
  connectTimeoutMs: 5_000,
  totalDeadlineMs: 20_000,
  maxBodyBytes: 2 * 1024 * 1024,
  maxTextChars: 50_000,
  maxPurposeChars: 300,
});

export type PolicyCode =
  | "RESEARCH_URL_INVALID" | "RESEARCH_SCHEME_REFUSED" | "RESEARCH_USERINFO_REFUSED" | "RESEARCH_PORT_REFUSED"
  | "RESEARCH_IP_LITERAL_REFUSED" | "RESEARCH_HOST_REFUSED" | "RESEARCH_FLEET_HOST_REFUSED" | "RESEARCH_ADDRESS_REFUSED";

export class ResearchPolicyError extends Error {
  constructor(readonly code: PolicyCode, readonly detail: string) {
    super(code);
  }
}

const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".home.arpa", ".corp", ".localdomain", ".private", ".test", ".invalid", ".example", ".onion", ".arpa"];

/** Parse and normalise a founder/redirect URL; throws ResearchPolicyError. `fleetDomains` are refused (e.g. agentfleet.vip). */
export function checkUrl(raw: string, fleetDomains: readonly string[] = []): URL {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > RESEARCH_LIMITS.maxUrlLength) throw new ResearchPolicyError("RESEARCH_URL_INVALID", "empty or too long");
  if (/[\s\x00-\x1f\x7f\\]/.test(raw)) throw new ResearchPolicyError("RESEARCH_URL_INVALID", "whitespace, control characters or backslashes");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ResearchPolicyError("RESEARCH_URL_INVALID", "not a URL");
  }
  if (u.protocol !== "https:") throw new ResearchPolicyError("RESEARCH_SCHEME_REFUSED", `scheme ${u.protocol.slice(0, 20)}`);
  if (u.username || u.password) throw new ResearchPolicyError("RESEARCH_USERINFO_REFUSED", "credentials in the URL");
  if (u.port !== "" && u.port !== "443") throw new ResearchPolicyError("RESEARCH_PORT_REFUSED", `port ${u.port}`);
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || net.isIP(host) !== 0 || /^[0-9.]+$/.test(host) || /^0x/i.test(host)) throw new ResearchPolicyError("RESEARCH_IP_LITERAL_REFUSED", "IP literal");
  if (host.length > 253 || !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)) {
    throw new ResearchPolicyError("RESEARCH_HOST_REFUSED", "not a public DNS name");
  }
  if (host === "localhost" || PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) throw new ResearchPolicyError("RESEARCH_HOST_REFUSED", "private-use name");
  for (const d of fleetDomains) {
    const dd = d.toLowerCase().replace(/^\.+|\.$/g, "");
    if (dd && (host === dd || host.endsWith(`.${dd}`))) throw new ResearchPolicyError("RESEARCH_FLEET_HOST_REFUSED", "the fleet's own domain");
  }
  u.hash = "";
  return u;
}

function buildBlockList(): net.BlockList {
  const b = new net.BlockList();
  for (const [a, p] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
    ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
    ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ] as const) b.addSubnet(a, p, "ipv4");
  for (const [a, p] of [
    // NB: no ::ffff:0:0/96 rule here. Node's BlockList would then match EVERY plain IPv4 address.
    // IPv4-mapped addresses are unwrapped by embeddedV4() and checked against the IPv4 rules instead.
    ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32], ["2001:2::", 48],
    ["2001:10::", 28], ["2001:20::", 28], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
  ] as const) b.addSubnet(a, p, "ipv6");
  return b;
}
const BLOCKED = buildBlockList();

/** Embedded IPv4 of IPv4-mapped / NAT64 / 6to4 addresses (so a private IPv4 cannot hide inside IPv6). */
function embeddedV4(ip6: string): string | null {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip6);
  if (m) return m[1];
  const words = expandV6(ip6);
  if (!words) return null;
  const toV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) return toV4(words[6], words[7]); // ::ffff:a.b.c.d
  if (words[0] === 0x64 && words[1] === 0xff9b) return toV4(words[6], words[7]); // 64:ff9b::/96
  if (words[0] === 0x2002) return toV4(words[1], words[2]); // 6to4
  return null;
}

function expandV6(ip: string): number[] | null {
  if (net.isIPv6(ip) === false) return null;
  let s = ip.toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const p = v4[1].split(".").map(Number);
    s = s.replace(v4[1], `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`);
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const fill = s.includes("::") ? 8 - h.length - t.length : 0;
  const all = [...h, ...Array(fill).fill("0"), ...t];
  if (all.length !== 8) return null;
  return all.map((x) => parseInt(x || "0", 16));
}

/** True when an address may be connected to: public, not the host itself. */
export function isPublicAddress(ip: string, localAddresses: ReadonlySet<string> = new Set()): boolean {
  const fam = net.isIP(ip);
  if (fam === 0) return false;
  if (localAddresses.has(ip.toLowerCase())) return false;
  if (fam === 4) return !BLOCKED.check(ip, "ipv4");
  if (BLOCKED.check(ip, "ipv6")) {
    // Blocked prefixes that embed IPv4 are refused regardless; nothing in them is allowed.
    return false;
  }
  const v4 = embeddedV4(ip);
  if (v4 && BLOCKED.check(v4, "ipv4")) return false;
  return true;
}

/** Validate every resolved address (all must be public: one private answer refuses the whole name). */
export function checkAddresses(host: string, addresses: readonly string[], localAddresses: ReadonlySet<string> = new Set()): string[] {
  if (addresses.length === 0) throw new ResearchPolicyError("RESEARCH_ADDRESS_REFUSED", `${host}: no addresses`);
  for (const a of addresses) if (!isPublicAddress(a, localAddresses)) throw new ResearchPolicyError("RESEARCH_ADDRESS_REFUSED", `${host} resolves to a non-public address`);
  return [...addresses];
}

/** Bound and clean a founder's stated purpose (logged, never interpreted). */
export function cleanPurpose(p: unknown): string {
  return (typeof p === "string" ? p : "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, RESEARCH_LIMITS.maxPurposeChars);
}
