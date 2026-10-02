/**
 * Browser URL policy (schema v37): the agent may visit any legitimate public website; the worker never reaches the
 * host, its loopback services, private networks or cloud metadata. Name-based checks here; the systemd unit's
 * IPAddressDeny enforces the same at the network layer (covering DNS that resolves to a private address).
 */
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
