/**
 * The owner's Admin password (schema v43): only a scrypt verifier is ever stored. Memory-hard (N=32768, r=8, p=1 →
 * 32 MiB per check), a random 16-byte salt, a 32-byte key, and a constant-time comparison. The password itself is never
 * logged, stored, returned or sent to the database.
 *
 * Verifier format: scrypt$v1$N=<n>,r=<r>,p=<p>$<salt b64url>$<key b64url> (checked again by the schema).
 */
import crypto from "crypto";

const N = 32768, R = 8, P = 1, KEYLEN = 32;
const MAXMEM = 128 * N * R * 2;
export const PASSWORD_MIN = 12, PASSWORD_MAX = 256;

const scrypt = (password: string, salt: Buffer, n: number, r: number, p: number) => new Promise<Buffer>((resolve, reject) =>
  crypto.scrypt(password.normalize("NFC"), salt, KEYLEN, { N: n, r, p, maxmem: Math.max(MAXMEM, 128 * n * r * 2) }, (err, key) => (err ? reject(err) : resolve(key))));

/** Why a chosen password is not acceptable, or null. Length is what matters: any characters, 12–256 of them. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string") return "a password is required";
  const n = [...password.normalize("NFC")].length;
  if (n < PASSWORD_MIN) return `use at least ${PASSWORD_MIN} characters`;
  if (n > PASSWORD_MAX) return `use at most ${PASSWORD_MAX} characters`;
  if (/^\s|\s$/.test(password)) return "the password cannot start or end with a space";
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return `scrypt$v1$N=${N},r=${R},p=${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** A verifier no password matches: checked when no password is set, so the timing never reveals whether one exists. */
const DUMMY = `scrypt$v1$N=${N},r=${R},p=${P}$${Buffer.alloc(16).toString("base64url")}$${Buffer.alloc(KEYLEN).toString("base64url")}`;

/** Constant-time check of a presented password against a stored verifier (or the dummy one when none is set). */
export async function verifyPassword(password: unknown, verifier: string | null): Promise<boolean> {
  const m = /^scrypt\$v1\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(verifier ?? DUMMY) ?? /^scrypt\$v1\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(DUMMY)!;
  const [n, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (n > 1 << 20 || r > 32 || p > 16) return false;
  const want = Buffer.from(m[5], "base64url");
  const candidate = typeof password === "string" && password.length <= PASSWORD_MAX * 4 ? password : "";
  const got = await scrypt(candidate, Buffer.from(m[4], "base64url"), n, r, p);
  const same = got.length === want.length && crypto.timingSafeEqual(got, want);
  return same && verifier !== null && typeof password === "string" && candidate.length > 0;
}
