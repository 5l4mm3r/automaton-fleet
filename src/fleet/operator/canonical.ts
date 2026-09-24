/**
 * Operator API request authentication (Phase B2): strict request-target
 * canonicalization and Ed25519 request signatures (FLEET-OP-SIG-V1).
 *
 * Nothing here normalizes: a request target or header that is not already
 * canonical is rejected, so independent implementations cannot disagree
 * about encoding, query order, duplicates or empty bodies.
 *
 * String to sign (nine lines, LF-separated, no trailing LF, ASCII):
 *
 *   FLEET-OP-SIG-V1
 *   <principal_id>        op_<ULID>
 *   <key_id>              32 lowercase hex = first half of sha256(raw public key)
 *   <METHOD>              exactly as received ("GET" in v1)
 *   <path>                raw path, /v1/operator(/segment)+, lowercase, no %, no empty/dot segments
 *   <query>               raw query without "?", already canonical ("" when absent)
 *   <timestamp>           epoch milliseconds, 13 digits
 *   <nonce>               base64url, 22-64 chars (>= 128 bits)
 *   <body_sha256_hex>     sha256 of the raw body bytes (empty body in v1)
 *
 * Only Node's built-in crypto is used (Ed25519, RFC 8032, no prehash).
 */

import crypto, { type KeyObject } from "crypto";

export const OP_SIG_VERSION = "FLEET-OP-SIG-V1";

export const OP_HEADERS = Object.freeze({
  principal: "x-fleet-op-principal",
  key: "x-fleet-op-key",
  timestamp: "x-fleet-op-timestamp",
  nonce: "x-fleet-op-nonce",
  signature: "x-fleet-op-signature",
});

export const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const OP_LIMITS = Object.freeze({
  maxTargetBytes: 2048,
  maxHeaderBytes: 8192,
  skewMs: 30_000,
});

export const PRINCIPAL_RE = /^op_[0-9A-HJKMNP-TV-Z]{26}$/;
export const KEY_ID_RE = /^[0-9a-f]{32}$/;
const TIMESTAMP_RE = /^[1-9][0-9]{12}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{22,64}$/;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/;
const PATH_RE = /^\/v1\/operator(\/[a-z0-9][a-z0-9_-]{0,63})+$/;
const QUERY_KEY_RE = /^[a-z][a-z_]{0,31}$/;
const QUERY_VALUE_RE = /^[A-Za-z0-9._~-]{1,128}$/;

export type OpErrorCode =
  | "FLEET_OP_BAD_REQUEST"
  | "FLEET_OP_NONCANONICAL"
  | "FLEET_OP_BAD_PARAM"
  | "FLEET_OP_STALE"
  | "FLEET_OP_AUTH_FAILED"
  | "FLEET_OP_SCOPE_DENIED"
  | "FLEET_OP_NOT_FOUND"
  | "FLEET_OP_REPLAYED"
  | "FLEET_OP_RATE_LIMITED"
  | "FLEET_OP_INTERNAL"
  | "FLEET_OP_DISABLED"
  | "FLEET_OP_AUDIT_FULL";

export type TargetResult =
  | { ok: true; path: string; query: string; params: Record<string, string> }
  | { ok: false; code: "FLEET_OP_BAD_REQUEST" | "FLEET_OP_NONCANONICAL" };

/**
 * Parse the raw request target. Rejects (never normalizes) anything that is
 * not canonical: percent-encoding, "+", empty/bare/duplicate/unsorted query
 * parameters, fragments, dot segments, trailing slashes, uppercase.
 */
export function parseTarget(raw: string): TargetResult {
  if (typeof raw !== "string" || raw.length === 0 || Buffer.byteLength(raw, "utf8") > OP_LIMITS.maxTargetBytes) {
    return { ok: false, code: "FLEET_OP_BAD_REQUEST" };
  }
  if (!/^[\x21-\x7e]+$/.test(raw) || raw.includes("#")) return { ok: false, code: "FLEET_OP_NONCANONICAL" };
  const q = raw.indexOf("?");
  const path = q < 0 ? raw : raw.slice(0, q);
  const query = q < 0 ? "" : raw.slice(q + 1);
  if (!PATH_RE.test(path)) return { ok: false, code: "FLEET_OP_NONCANONICAL" };
  const params: Record<string, string> = {};
  if (q >= 0) {
    if (query === "") return { ok: false, code: "FLEET_OP_NONCANONICAL" };
    let prev = "";
    for (const part of query.split("&")) {
      const eq = part.indexOf("=");
      if (eq <= 0) return { ok: false, code: "FLEET_OP_NONCANONICAL" };
      const k = part.slice(0, eq);
      const v = part.slice(eq + 1);
      if (!QUERY_KEY_RE.test(k) || !QUERY_VALUE_RE.test(v)) return { ok: false, code: "FLEET_OP_NONCANONICAL" };
      if (prev !== "" && !(k > prev)) return { ok: false, code: "FLEET_OP_NONCANONICAL" }; // unsorted or duplicate
      prev = k;
      params[k] = v;
    }
  }
  return { ok: true, path, query, params };
}

export interface SignedFields {
  principal: string;
  key: string;
  method: string;
  path: string;
  query: string;
  timestamp: string;
  nonce: string;
  bodySha256: string;
}

export function canonicalString(f: SignedFields): string {
  return [OP_SIG_VERSION, f.principal, f.key, f.method, f.path, f.query, f.timestamp, f.nonce, f.bodySha256].join("\n");
}

export function bodyDigest(body: Buffer | string): string {
  return crypto.createHash("sha256").update(body).digest("hex");
}

export interface OpHeaderValues {
  principal: string;
  key: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

/**
 * Exactly one of each X-Fleet-Op-* header, in its exact format; no
 * Authorization (agent credentials never cross over) and no Cookie.
 */
export function readOpHeaders(headers: Record<string, string[] | undefined>): { ok: true; values: OpHeaderValues } | { ok: false } {
  if (headers.authorization !== undefined || headers.cookie !== undefined) return { ok: false };
  const one = (name: string, re: RegExp): string | null => {
    const v = headers[name];
    if (!v || v.length !== 1 || !re.test(v[0])) return null;
    return v[0];
  };
  const principal = one(OP_HEADERS.principal, PRINCIPAL_RE);
  const key = one(OP_HEADERS.key, KEY_ID_RE);
  const timestamp = one(OP_HEADERS.timestamp, TIMESTAMP_RE);
  const nonce = one(OP_HEADERS.nonce, NONCE_RE);
  const signature = one(OP_HEADERS.signature, SIGNATURE_RE);
  if (!principal || !key || !timestamp || !nonce || !signature) return { ok: false };
  return { ok: true, values: { principal, key, timestamp, nonce, signature } };
}

/** base64url, no padding, exactly 64 bytes, and canonical (re-encodes to the same string). */
export function decodeSignature(sig: string): Buffer | null {
  if (!SIGNATURE_RE.test(sig)) return null;
  const b = Buffer.from(sig, "base64url");
  if (b.length !== 64 || b.toString("base64url") !== sig) return null;
  return b;
}

/** First 32 hex chars of sha256(raw 32-byte public key). */
export function keyIdOf(rawPublicKey: Buffer): string {
  return crypto.createHash("sha256").update(rawPublicKey).digest("hex").slice(0, 32);
}

/** Raw 32-byte Ed25519 public key -> KeyObject. */
export function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  return crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
}

/** Raw 32-byte public key of an Ed25519 KeyObject (public or private). */
export function rawPublicKey(key: KeyObject): Buffer {
  const pub = key.type === "private" ? crypto.createPublicKey(key) : key;
  const jwk = pub.export({ format: "jwk" }) as { x?: string; crv?: string };
  if (jwk.crv !== "Ed25519" || !jwk.x) throw new Error("not an Ed25519 key");
  return Buffer.from(jwk.x, "base64url");
}

export function verifySignature(publicKey: KeyObject, canonical: string, signature: Buffer): boolean {
  try {
    return crypto.verify(null, Buffer.from(canonical, "utf8"), publicKey, signature);
  } catch {
    return false;
  }
}

/** Client side (bridges, tests): sign the canonical string; returns base64url. */
export function signCanonical(privateKey: KeyObject, canonical: string): string {
  return crypto.sign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64url");
}

/** Client side: fresh nonce (144 random bits, base64url). */
export function newNonce(): string {
  return crypto.randomBytes(18).toString("base64url");
}

/**
 * Client side: headers for one signed GET request to `target` (path+query,
 * already canonical). The private key never leaves the caller.
 */
export function signedHeaders(
  privateKey: KeyObject,
  principal: string,
  target: string,
  opts: { method?: string; now?: number; nonce?: string; keyId?: string } = {},
): Record<string, string> {
  const q = target.indexOf("?");
  const fields: SignedFields = {
    principal,
    key: opts.keyId ?? keyIdOf(rawPublicKey(privateKey)),
    method: opts.method ?? "GET",
    path: q < 0 ? target : target.slice(0, q),
    query: q < 0 ? "" : target.slice(q + 1),
    timestamp: String(opts.now ?? Date.now()),
    nonce: opts.nonce ?? newNonce(),
    bodySha256: EMPTY_BODY_SHA256,
  };
  return {
    [OP_HEADERS.principal]: fields.principal,
    [OP_HEADERS.key]: fields.key,
    [OP_HEADERS.timestamp]: fields.timestamp,
    [OP_HEADERS.nonce]: fields.nonce,
    [OP_HEADERS.signature]: signCanonical(privateKey, canonicalString(fields)),
  };
}
