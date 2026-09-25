/**
 * Bridges (Phase C) — direct loopback transport to the Operator API.
 *
 * For a bridge running ON the controller host (the ChatGPT adapter), there is
 * no SSH tunnel: it connects to 127.0.0.1:<port> itself. Before any signed
 * request it proves, from the kernel's socket table (/proc/net/tcp[6]),
 * that every listener on that port belongs to the expected Operator API
 * user, then checks the endpoint's /healthz + /readyz identity exactly as the
 * Phase D tunnel does. A different listener (another local user squatting
 * the port while the Operator API is down) is TUNNEL_NOT_OWNED; a disabled or
 * not-ready API is API_DISABLED / API_NOT_READY with no signed request sent.
 */

import fs from "fs";
import { BridgeError } from "./errors.js";
import { OperatorBridgeClient, loadSigner, type SignerIdentity } from "./client.js";
import { verifyOperatorEndpoint } from "./endpoint.js";
import type { KeyRef } from "./config.js";

/** uids of every TCP socket listening on `port` (IPv4 and IPv6). */
export function listenerUids(port: number): number[] {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  const uids: number[] = [];
  for (const f of ["/proc/self/net/tcp", "/proc/self/net/tcp6"]) {
    let text = "";
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length > 9 && c[3] === "0A" && c[1].endsWith(`:${hex}`)) uids.push(Number(c[7]));
    }
  }
  return uids;
}

export function uidOfUser(name: string): number | null {
  try {
    for (const line of fs.readFileSync("/etc/passwd", "utf8").split("\n")) {
      const p = line.split(":");
      if (p[0] === name && /^\d+$/.test(p[2] ?? "")) return Number(p[2]);
    }
  } catch {
    // unreadable
  }
  return null;
}

export interface DirectOptions {
  principalId: string;
  key: KeyRef;
  /** Operator API loopback port (8788 in production). */
  port: number;
  /** Required owner uid of the listener (the Operator API service user). */
  listenerUid: number;
  timeoutMs?: number;
}

/** One verified, signed call over loopback; nothing is cached between calls except the key. */
export async function withDirectClient<T>(opts: DirectOptions, fn: (c: OperatorBridgeClient) => Promise<T>, signer?: SignerIdentity): Promise<T> {
  const s = signer ?? loadSigner(opts.principalId, opts.key);
  const uids = listenerUids(opts.port);
  if (uids.length === 0) throw new BridgeError("NETWORK", `nothing is listening on 127.0.0.1:${opts.port}`);
  if (!uids.every((u) => u === opts.listenerUid)) throw new BridgeError("TUNNEL_NOT_OWNED", `127.0.0.1:${opts.port} is not held (only) by the Operator API user`);
  const readiness = await verifyOperatorEndpoint(opts.port);
  if (!readiness.ready) throw new BridgeError(readiness.state === "disabled" ? "API_DISABLED" : "API_NOT_READY", `the Operator API is ${readiness.state}; no signed request was sent`);
  return fn(new OperatorBridgeClient({ port: opts.port, signer: s, timeoutMs: opts.timeoutMs }));
}
