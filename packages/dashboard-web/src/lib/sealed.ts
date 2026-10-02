/**
 * The identity broker's sealed-box format (FSB1), in the browser with WebCrypto — so revealed secrets and uploaded
 * owner identity are encrypted end to end between this tab and the broker; the dashboard server relays sealed bytes.
 *   FSB1 | u16 len | ephemeral X25519 SPKI | FIV1 | nonce(12) | tag(16) | ciphertext
 *   key = HKDF-SHA256(X25519(eph, recipient), salt = ephSPKI || recipientSPKI, info = "fleet-owner-identity-v1"); AES-256-GCM, AAD = scope
 */
const te = new TextEncoder();
const td = new TextDecoder();
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.byteLength; }
  return out;
};
export const b64 = {
  enc: (u: Uint8Array): string => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); },
  dec: (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};

async function aesKey(shared: ArrayBuffer, salt: Uint8Array): Promise<CryptoKey> {
  const k = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: te.encode("fleet-owner-identity-v1") }, k, 256);
  return crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealTo(recipientSpki: Uint8Array, plaintext: string, scope: string): Promise<Uint8Array> {
  const eph = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const ephPub = new Uint8Array(await crypto.subtle.exportKey("spki", eph.publicKey));
  const rec = await crypto.subtle.importKey("spki", recipientSpki as BufferSource, { name: "X25519" }, false, []);
  const key = await aesKey(await crypto.subtle.deriveBits({ name: "X25519", public: rec }, eph.privateKey, 256), cat(ephPub, recipientSpki));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(scope) }, key, te.encode(plaintext)));
  return cat(te.encode("FSB1"), new Uint8Array([ephPub.length >> 8, ephPub.length & 255]), ephPub, te.encode("FIV1"), iv,
    ct.subarray(ct.length - 16), ct.subarray(0, ct.length - 16));
}

/** A one-time key pair for one reveal; the private key never leaves this tab's memory. */
export async function revealKeyPair() {
  const kp = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
  return { kp, pub };
}

export async function openSealed(kp: CryptoKeyPair, myPubSpki: Uint8Array, blob: Uint8Array, scope: string): Promise<string> {
  if (td.decode(blob.subarray(0, 4)) !== "FSB1") throw new Error("not a sealed box");
  const n = (blob[4] << 8) | blob[5];
  const ephPub = blob.subarray(6, 6 + n);
  const rest = blob.subarray(6 + n);
  const eph = await crypto.subtle.importKey("spki", ephPub as BufferSource, { name: "X25519" }, false, []);
  const key = await aesKey(await crypto.subtle.deriveBits({ name: "X25519", public: eph }, kp.privateKey, 256), cat(ephPub, myPubSpki));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: rest.subarray(4, 16) as BufferSource, additionalData: te.encode(scope) }, key,
    cat(rest.subarray(32), rest.subarray(16, 32)) as BufferSource);
  return td.decode(pt);
}
