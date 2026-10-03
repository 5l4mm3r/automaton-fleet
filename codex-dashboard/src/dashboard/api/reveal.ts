/**
 * Sealed reveal (v36/v41): nothing is hidden from Admin, but a secret is shown only in this tab, briefly.
 *
 *   1. a one-time X25519 key pair is generated here (WebCrypto; the private key is non-extractable and never stored);
 *   2. `reveal_request` (fresh passkey step-up) names the target and carries the public key;
 *   3. the identity broker — the only process with the vaults — seals the value to that key;
 *   4. `reveal_take` returns the sealed bytes ONCE (the stored copy is erased); they are opened here, in memory;
 *   5. the value is cleared after `ttlMs` (default 60 s); every step is in the reveal log (never the value).
 *
 * The plaintext never touches HTML, server logs, localStorage, sessionStorage, IndexedDB or a cookie. Callers render it
 * from the returned handle and must drop it on `onClear`.
 */
import { FleetApiError } from "./errors";
import type { GatewayClient } from "./client";

export type RevealKind = "agent_credential" | "owner_identity" | "provider_secret";

const te = new TextEncoder();
const td = new TextDecoder();
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.byteLength; }
  return out;
};
const b64enc = (u: Uint8Array): string => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const b64dec = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(shared: ArrayBuffer, salt: Uint8Array): Promise<CryptoKey> {
  const k = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: te.encode("fleet-owner-identity-v1") }, k, 256);
  return crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["decrypt"]);
}

/** Open the broker's FSB1 sealed box with this tab's one-time key. */
async function openSealed(kp: CryptoKeyPair, myPubSpki: Uint8Array, blob: Uint8Array, scope: string): Promise<string> {
  if (td.decode(blob.subarray(0, 4)) !== "FSB1") throw new FleetApiError("FLEET_BAD_RESPONSE");
  const n = (blob[4] << 8) | blob[5];
  const ephPub = blob.subarray(6, 6 + n);
  const rest = blob.subarray(6 + n);
  const eph = await crypto.subtle.importKey("spki", ephPub as BufferSource, { name: "X25519" }, false, []);
  const key = await aesKey(await crypto.subtle.deriveBits({ name: "X25519", public: eph }, kp.privateKey, 256), cat(ephPub, myPubSpki));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: rest.subarray(4, 16) as BufferSource, additionalData: te.encode(scope) }, key,
    cat(rest.subarray(32), rest.subarray(16, 32)) as BufferSource);
  return td.decode(pt);
}

export interface RevealHandle {
  /** The plaintext, until cleared (then null). */
  readonly value: string | null;
  readonly expiresAt: number;
  clear(): void;
}

export async function reveal(c: GatewayClient, kind: RevealKind, target: string,
  o: { ttlMs?: number; onClear?: () => void; pollMs?: number; timeoutMs?: number } = {}): Promise<RevealHandle> {
  const kp = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
  const req = await c.call<{ requestId: string }>("reveal_request", { kind, target, ephemeralPub: b64enc(pub) });
  const deadline = Date.now() + (o.timeoutMs ?? 60_000);
  let sealed: string | null = null;
  while (Date.now() < deadline) {
    const t = await c.call<{ ok: boolean; status?: string; sealedB64?: string; code?: string }>("reveal_take", { requestId: req.requestId });
    if (t.ok && t.status === "delivered" && t.sealedB64) { sealed = t.sealedB64; break; }
    if (!t.ok) throw new FleetApiError(t.code ?? "FLEET_REVEAL_FAILED");
    await new Promise((r) => setTimeout(r, o.pollMs ?? 700));
  }
  if (!sealed) throw new FleetApiError("FLEET_REVEAL_EXPIRED");
  let value: string | null = await openSealed(kp, pub, b64dec(sealed), `reveal:${req.requestId}`);
  const ttl = o.ttlMs ?? 60_000;
  const expiresAt = Date.now() + ttl;
  const clear = () => { if (value !== null) { value = null; clearTimeout(timer); o.onClear?.(); } };
  const timer = setTimeout(clear, ttl);
  return { get value() { return value; }, expiresAt, clear };
}
