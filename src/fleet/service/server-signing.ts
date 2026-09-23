/**
 * Request signing shared by the fleet service and the agent client (Phase 5).
 * Kept separate from server.ts so agents never import service internals.
 */

import crypto from "crypto";

export const SIG_HEADERS = Object.freeze({ ts: "x-fleet-timestamp", nonce: "x-fleet-nonce", sig: "x-fleet-signature" });

/** Canonical string an agent signs with its session token (HMAC-SHA256, hex). */
export function canonicalRequest(method: string, path: string, ts: string, nonce: string, body: Buffer | string): string {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  return `${method.toUpperCase()}\n${path}\n${ts}\n${nonce}\n${bodyHash}`;
}

export function signRequest(sessionToken: string, method: string, path: string, ts: string, nonce: string, body: Buffer | string): string {
  return crypto.createHmac("sha256", sessionToken).update(canonicalRequest(method, path, ts, nonce, body)).digest("hex");
}
