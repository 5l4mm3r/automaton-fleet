/**
 * Operator key generation (Phase B2). Runs ON THE BRIDGE HOST as the
 * bridge's own user — never on the controller, never with a database
 * credential:
 *
 *   pnpm fleet:operator-keygen <private-key-file>
 *
 * Writes an Ed25519 private key (PKCS#8 PEM) with exclusive create, mode
 * 0600, into a directory that is not group/world-writable and not a symlink.
 * Prints ONLY the public key (base64url, 32 raw bytes) and its key id; the
 * operator enrolls those with `fleet:admin operator-enroll` and compares the
 * key id out of band. The private key never appears on stdout or in logs.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { keyIdOf, rawPublicKey } from "./canonical.js";

/** A directory for private output: real (no symlink anywhere in its path), owned by this user, not group/world-writable. */
export function requirePrivateDirectory(dir: string): void {
  const d = fs.lstatSync(dir);
  if (d.isSymbolicLink() || !d.isDirectory()) throw new Error(`${dir} must be a real directory`);
  if (fs.realpathSync(dir) !== dir) throw new Error(`${dir} resolves through a symlink`);
  if (typeof process.getuid === "function" && d.uid !== process.getuid()) throw new Error(`${dir} is not owned by this user`);
  if (d.mode & 0o022) throw new Error(`${dir} is group/world-writable (mode ${(d.mode & 0o777).toString(8)})`);
}

export function generateOperatorKey(file: string): { publicKey: string; keyId: string; file: string } {
  const abs = path.resolve(file);
  requirePrivateDirectory(path.dirname(abs));
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const fd = fs.openSync(abs, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, pem);
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  const raw = rawPublicKey(privateKey);
  return { publicKey: raw.toString("base64url"), keyId: keyIdOf(raw), file: abs };
}

/** Load a private key written by generateOperatorKey (bridge side). Refuses loose permissions. */
export function loadOperatorPrivateKey(file: string): crypto.KeyObject {
  // Open once without following symlinks, then check and read that same descriptor (no check-then-read race).
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let pem: Buffer;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`${file} must be a regular file`);
    if (st.mode & 0o077) throw new Error(`${file} must be mode 0600 (is ${(st.mode & 0o777).toString(8)})`);
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${file} is not owned by this user`);
    if (st.nlink !== 1) throw new Error(`${file} has extra hard links`);
    pem = fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const key = crypto.createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${file} is not an Ed25519 private key`);
  return key;
}

if (process.argv[1] && /fleet[\\/]operator[\\/]keygen\.(ts|js)$/.test(process.argv[1])) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: fleet:operator-keygen <private-key-file>   (run on the bridge host as the bridge user)");
    process.exit(2);
  }
  try {
    const r = generateOperatorKey(file);
    console.log(JSON.stringify({ publicKey: r.publicKey, keyId: r.keyId, privateKeyFile: r.file }));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
