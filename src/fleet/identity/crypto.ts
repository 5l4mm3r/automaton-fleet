/**
 * Identity broker cryptography (schema v34). Node's built-in crypto only; no secret is ever logged or serialised.
 *
 *  - SecretBox: AES-256-GCM with a 32-byte key and a random 96-bit nonce per blob. The additional authenticated data binds
 *    a ciphertext to its scope (agent + account + kind for agent credentials; class for owner identity): a blob moved to
 *    another agent, account or class does not decrypt.
 *  - Sealed boxes: X25519 key agreement with an ephemeral key, HKDF-SHA256 → AES-256-GCM. Anyone holding the broker's
 *    PUBLIC key (the owner's CLI) can seal owner identity to the broker; only the broker's private key opens it.
 */
import crypto from "crypto";

const MAGIC = Buffer.from("FIV1");

export class SecretBox {
  private readonly key: Buffer;
  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("a SecretBox key is 32 bytes");
    this.key = Buffer.from(key);
  }
  seal(plaintext: string, scope: string): Buffer {
    const nonce = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", this.key, nonce);
    c.setAAD(Buffer.from(scope, "utf8"));
    const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return Buffer.concat([MAGIC, nonce, c.getAuthTag(), body]);
  }
  open(blob: Buffer, scope: string): string {
    if (blob.length < 4 + 12 + 16 || !blob.subarray(0, 4).equals(MAGIC)) throw new Error("not a sealed identity blob");
    const d = crypto.createDecipheriv("aes-256-gcm", this.key, blob.subarray(4, 16));
    d.setAAD(Buffer.from(scope, "utf8"));
    d.setAuthTag(blob.subarray(16, 32));
    return Buffer.concat([d.update(blob.subarray(32)), d.final()]).toString("utf8");
  }
}

export interface X25519KeyPair {
  publicKeyDer: Buffer;
  privateKeyDer: Buffer;
}

export function generateX25519(): X25519KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  return {
    publicKeyDer: publicKey.export({ type: "spki", format: "der" }),
    privateKeyDer: privateKey.export({ type: "pkcs8", format: "der" }),
  };
}

function derive(shared: Buffer, ephemeralPub: Buffer, recipientPub: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.concat([ephemeralPub, recipientPub]), Buffer.from("fleet-owner-identity-v1"), 32));
}

/** Seal to the broker's public key (the owner CLI side: it can never open what it sealed). */
export function sealTo(recipientPublicDer: Buffer, plaintext: string, scope: string): Buffer {
  const recipient = crypto.createPublicKey({ key: recipientPublicDer, format: "der", type: "spki" });
  const eph = crypto.generateKeyPairSync("x25519");
  const ephPub = eph.publicKey.export({ type: "spki", format: "der" });
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const box = new SecretBox(derive(shared, ephPub, recipientPublicDer));
  const len = Buffer.alloc(2);
  len.writeUInt16BE(ephPub.length);
  return Buffer.concat([Buffer.from("FSB1"), len, ephPub, box.seal(plaintext, scope)]);
}

/** Open with the broker's private key (broker only). */
export function openSealed(privateDer: Buffer, publicDer: Buffer, blob: Buffer, scope: string): string {
  if (blob.length < 6 || !blob.subarray(0, 4).equals(Buffer.from("FSB1"))) throw new Error("not a sealed owner-identity blob");
  const n = blob.readUInt16BE(4);
  const ephPub = blob.subarray(6, 6 + n);
  const priv = crypto.createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: crypto.createPublicKey({ key: ephPub, format: "der", type: "spki" }) });
  return new SecretBox(derive(shared, ephPub, publicDer)).open(blob.subarray(6 + n), scope);
}

/** A strong random password for an agent-created account (never shown to the agent). */
export function generatePassword(length = 28): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.!#%+";
  const out: string[] = [];
  while (out.length < length) {
    const b = crypto.randomBytes(length);
    for (const x of b) if (x < 256 - (256 % alphabet.length) && out.length < length) out.push(alphabet[x % alphabet.length]);
  }
  return out.join("");
}

/** RFC 4648 base32 decode (TOTP seeds); spaces and padding ignored. */
export function base32Decode(s: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = s.toUpperCase().replace(/[\s=]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = alphabet.indexOf(ch);
    if (i < 0) throw new Error("not base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/** v37: an RFC 6238 one-time code (SHA-1, 30 s, 6 digits) from a base32 seed or an otpauth:// URI. */
export function totp(seedOrUri: string, at = Date.now(), step = 30, digits = 6): string {
  const seed = seedOrUri.startsWith("otpauth://") ? new URL(seedOrUri).searchParams.get("secret") ?? "" : seedOrUri;
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / step)));
  const h = crypto.createHmac("sha1", base32Decode(seed)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, "0");
}
