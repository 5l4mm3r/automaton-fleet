/**
 * Owner identity upload, sealed IN THE BROWSER to the identity broker's published X25519 key (FSB1, the broker's own
 * format: X25519 + HKDF-SHA256 + AES-256-GCM, scope `owner:<class>`). The dashboard service and the database only ever
 * hold sealed bytes; the broker installs them into its owner vault and the database copy is erased.
 */
import { FleetApiError } from "./errors";
import type { GatewayClient } from "./client";

export { OWNER_IDENTITY_CLASSES } from "../live/constants";
import { OWNER_IDENTITY_CLASSES } from "../live/constants";

const te = new TextEncoder();
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.byteLength; }
  return out;
};
const b64enc = (u: Uint8Array): string => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const b64dec = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function sealTo(recipientSpki: Uint8Array, plaintext: string, scope: string): Promise<Uint8Array> {
  const eph = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const ephPub = new Uint8Array(await crypto.subtle.exportKey("spki", eph.publicKey));
  const rec = await crypto.subtle.importKey("spki", recipientSpki as BufferSource, { name: "X25519" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: rec }, eph.privateKey, 256);
  const k = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: cat(ephPub, recipientSpki) as BufferSource, info: te.encode("fleet-owner-identity-v1") }, k, 256);
  const key = await crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(scope) }, key, te.encode(plaintext)));
  return cat(te.encode("FSB1"), new Uint8Array([ephPub.length >> 8, ephPub.length & 255]), ephPub, te.encode("FIV1"), iv, ct.subarray(ct.length - 16), ct.subarray(0, ct.length - 16));
}

/** Seal one owner fact (text) to the broker's published key; returns the upload command's fields. Never sends plaintext. */
export async function sealOwnerFact(c: GatewayClient, cls: string, value: string): Promise<{ class: string; sealedB64: string; contentType: string }> {
  if (!(OWNER_IDENTITY_CLASSES as readonly string[]).includes(cls)) throw new FleetApiError("FLEET_BAD_REQUEST", "unknown owner identity class");
  if (!value) throw new FleetApiError("FLEET_BAD_REQUEST", "the value is empty");
  const key = await c.read<{ ownerPub: string | null }>("broker_key");
  if (!key?.ownerPub) throw new FleetApiError("FLEET_OWNER_VAULT_UNAVAILABLE", "the identity broker has not published its key (is it provisioned?)");
  const sealed = await sealTo(b64dec(key.ownerPub), value, `owner:${cls}`);
  return { class: cls, sealedB64: b64enc(sealed), contentType: "text/plain" };
}

/**
 * v49: seal a PayPal app credential ("clientId:clientSecret") to the custody executor's published key (scope
 * `custody:<vaultRef>`); only the custody executor can open it. Returns the upload fields; never sends plaintext.
 */
export async function sealForCustody(c: GatewayClient, vaultRef: string, clientId: string, clientSecret: string): Promise<{ vaultRef: string; sealedB64: string }> {
  if (!/^vault:paypal\/[a-z0-9/._-]{1,100}$/.test(vaultRef)) throw new FleetApiError("FLEET_BAD_REQUEST", "the reference is vault:paypal/<name> (lower-case)");
  if (!/^[^:\s]{8,}$/.test(clientId) || !/^[^:\s]{8,}$/.test(clientSecret)) throw new FleetApiError("FLEET_BAD_REQUEST", "the client id and secret from your PayPal REST app");
  const key = await c.read<{ publicKey: string | null }>("custody_key");
  if (!key?.publicKey) throw new FleetApiError("FLEET_CUSTODY_KEY_UNAVAILABLE", "the custody executor has not published its key yet (is it running?)");
  const sealed = await sealTo(b64dec(key.publicKey), `${clientId}:${clientSecret}`, `custody:${vaultRef}`);
  return { vaultRef, sealedB64: b64enc(sealed) };
}
