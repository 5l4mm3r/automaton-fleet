/**
 * R36: HAProxy PROXY protocol v1 (text form) for the controller's public listener behind the host's nginx.
 *
 * nginx (stream, `proxy_protocol on`) terminates nothing: it passes the client's TLS bytes through to FleetController,
 * prefixed by one line naming the real client, e.g. `PROXY TCP4 203.0.113.7 51.195.148.111 52144 443\r\n`. The header
 * is trusted only because the listener that reads it is bound to loopback and accepts it only from a loopback peer
 * (server.ts listenProxied); nothing on the Internet can reach that listener, so nothing there can forge the line.
 *
 * Fail-closed: anything other than one well-formed TCP4/TCP6 line (UNKNOWN, v2 binary, a missing header, a TLS
 * ClientHello sent directly, an over-long or malformed line, an address that does not match its family) is refused
 * and the connection is closed. A proxied client is never treated as loopback, whatever address the header names.
 */
import net from "net";

/** The longest v1 header the specification allows, CRLF included. */
export const PROXY_V1_MAX = 107;

export interface ProxiedPeer {
  family: "TCP4" | "TCP6";
  sourceAddress: string;
  sourcePort: number;
}

const PORT_RE = /^(0|[1-9][0-9]{0,4})$/;

function port(s: string): number | null {
  if (!PORT_RE.test(s)) return null;
  const n = Number(s);
  return n <= 65535 ? n : null;
}

/** Parses one v1 header line (without its CRLF). Returns null for anything that is not a well-formed TCP4/TCP6 line. */
export function parseProxyV1(line: string): ProxiedPeer | null {
  if (line.length > PROXY_V1_MAX - 2) return null;
  const parts = line.split(" ");
  if (parts.length !== 6 || parts[0] !== "PROXY") return null;
  const [, family, src, dst, sp, dp] = parts;
  if (family !== "TCP4" && family !== "TCP6") return null;
  const ok = family === "TCP4" ? net.isIPv4 : net.isIPv6;
  if (!ok(src) || !ok(dst)) return null;
  const sourcePort = port(sp);
  if (sourcePort === null || port(dp) === null) return null;
  return { family, sourceAddress: src, sourcePort };
}

export type ProxyHeaderResult =
  | { status: "incomplete" }
  | { status: "invalid" }
  | { status: "ok"; peer: ProxiedPeer; rest: Buffer };

/** Looks for a complete header at the start of `buf` (the bytes received so far on a fresh connection). */
export function readProxyV1(buf: Buffer): ProxyHeaderResult {
  const prefix = "PROXY ";
  const n = Math.min(buf.length, prefix.length);
  if (buf.subarray(0, n).toString("latin1") !== prefix.slice(0, n)) return { status: "invalid" };
  const end = buf.indexOf("\r\n");
  if (end < 0) return buf.length >= PROXY_V1_MAX ? { status: "invalid" } : { status: "incomplete" };
  if (end + 2 > PROXY_V1_MAX) return { status: "invalid" };
  const line = buf.subarray(0, end).toString("latin1");
  if (!/^[\x20-\x7e]*$/.test(line)) return { status: "invalid" };
  const peer = parseProxyV1(line);
  return peer ? { status: "ok", peer, rest: buf.subarray(end + 2) } : { status: "invalid" };
}
