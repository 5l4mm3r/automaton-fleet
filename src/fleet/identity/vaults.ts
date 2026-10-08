/**
 * The identity broker's two vaults (schema v34). Both live only in the broker's own state directory (its OS user, 0700),
 * which FleetController, agents and every other service cannot read (unit InaccessiblePaths).
 *
 *  AgentCredentialVault — credentials of accounts the AGENTS created and own: one blob per credential, AES-256-GCM,
 *    bound to (agent, account, kind). The registry stores only the reference (avault:<uuid>). Revocation shreds the blob.
 *  OwnerIdentityVault — the owner's voluntarily supplied real-world facts/documents, one sealed blob per class, sealed to
 *    the broker's X25519 key (the owner CLI seals; only the broker opens). Never in the database, never to an agent.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { SecretBox, openSealed, sealTo } from "./crypto.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A directory the broker owns exclusively (0700, its own uid). Names only, never content. */
export function privateDirProblems(dir: string, uid: number | null): string[] {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return [`${dir}: missing`];
  }
  const p: string[] = [];
  if (!st.isDirectory() || st.isSymbolicLink()) p.push(`${dir}: not a directory`);
  if ((st.mode & 0o077) !== 0) p.push(`${dir}: accessible by group or others (mode ${(st.mode & 0o777).toString(8)}; 0700 only)`);
  if (uid !== null && st.uid !== uid) p.push(`${dir}: owned by uid ${st.uid}`);
  return p;
}

function writePrivate(file: string, data: Buffer): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, file);
}

/** v51: the owner vault holds documents (up to ~8 MB, ~11 MB sealed); credentials and provider secrets stay small. */
const OWNER_BLOB_MAX = 16_000_000;

function readPrivate(file: string, max = 1_000_000): Buffer | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0 || st.size > max) return null;
  return fs.readFileSync(file);
}

export interface CredentialScope {
  agentId: string;
  accountId: string;
  kind: string;
}

const scopeOf = (s: CredentialScope) => `agent:${s.agentId}|account:${s.accountId}|kind:${s.kind}`;

export class AgentCredentialVault {
  private readonly box: SecretBox;
  constructor(private readonly dir: string, key: Buffer) {
    this.box = new SecretBox(key);
  }

  private file(ref: string): string {
    const m = /^avault:([0-9a-f-]{36})$/.exec(ref);
    if (!m || !UUID.test(m[1])) throw new Error("malformed credential reference");
    return path.join(this.dir, `${m[1]}.bin`);
  }

  /** Store a secret for one agent's account; returns the reference the registry records. */
  put(scope: CredentialScope, secret: string): string {
    const ref = `avault:${crypto.randomUUID()}`;
    writePrivate(this.file(ref), this.box.seal(secret, scopeOf(scope)));
    return ref;
  }

  /** Use a secret for exactly this scope (a reference of another agent/account/kind does not open). */
  async withSecret<T>(ref: string, scope: CredentialScope, fn: (secret: string) => Promise<T>): Promise<T> {
    const blob = readPrivate(this.file(ref));
    if (!blob) throw new Error("FLEET_CREDENTIAL_UNAVAILABLE: no usable credential for this reference");
    let secret: string;
    try {
      secret = this.box.open(blob, scopeOf(scope));
    } catch {
      throw new Error("FLEET_CREDENTIAL_SCOPE: the credential does not belong to this account");
    }
    return fn(secret);
  }

  /** v37: encrypt an auxiliary broker-only value (an authentication message) under a scope distinct from any credential. */
  sealAux(value: string, scope: string): Buffer {
    if (!/^authmsg:/.test(scope)) throw new Error("auxiliary scopes are authmsg:*");
    return this.box.seal(value, scope);
  }
  openAux(blob: Buffer, scope: string): string {
    if (!/^authmsg:/.test(scope)) throw new Error("auxiliary scopes are authmsg:*");
    return this.box.open(blob, scope);
  }

  /** Shred a retired credential (overwrite, then unlink). */
  shred(ref: string): boolean {
    const f = this.file(ref);
    try {
      const n = fs.statSync(f).size;
      fs.writeFileSync(f, crypto.randomBytes(n));
      fs.unlinkSync(f);
      return true;
    } catch {
      return false;
    }
  }
}

export const OWNER_IDENTITY_CLASSES = ["legal_name", "date_of_birth", "residential_address", "contact_email", "contact_phone", "id_document",
  "proof_of_address", "tax_identifier", "bank_account_owner", "other_fact", "passport", "driving_licence",
  // v49: the owner's payment card (a JSON value: number, expMonth, expYear, cvc, name, postcode) — filled into checkouts, never shown.
  "payment_card"] as const;
export type OwnerIdentityClass = (typeof OWNER_IDENTITY_CLASSES)[number];

/** Owner CLI side: seal one class to the broker's public key. The CLI can never read it back. */
export function sealOwnerFact(brokerPublicDer: Buffer, cls: OwnerIdentityClass, value: string): Buffer {
  if (!OWNER_IDENTITY_CLASSES.includes(cls)) throw new Error("unknown owner identity class");
  // A fact is text; a document (passport, licence, proof of address) is {"contentType","dataB64"} JSON — up to ~8 MB.
  if (!value || value.length > 11_000_000) throw new Error("an owner fact or document is 1 byte to ~8 MB");
  return sealTo(brokerPublicDer, value, `owner:${cls}`);
}

/** v51: seal a mail / SMS provider secret (a JSON object of strings) to the broker's owner-vault key for one provider. */
export function sealProviderSecret(brokerPublicDer: Buffer, name: string, json: string): Buffer {
  if (!/^[a-z0-9][a-z0-9._-]{1,40}$/.test(name)) throw new Error("bad provider name");
  if (!json || json.length > 40_000) throw new Error("a provider secret is at most 40 kB");
  return sealTo(brokerPublicDer, json, `provider-upload:${name}`);
}

export class OwnerIdentityVault {
  constructor(private readonly dir: string, private readonly privateDer: Buffer, private readonly publicDer: Buffer) {}

  /** The broker's owner-vault public key (SPKI DER, base64) — published so uploads can be sealed to it. */
  publicKeyBase64(): string {
    return this.publicDer.toString("base64");
  }

  fileFor(cls: OwnerIdentityClass): string {
    if (!OWNER_IDENTITY_CLASSES.includes(cls)) throw new Error("unknown owner identity class");
    return path.join(this.dir, `${cls}.sealed`);
  }

  /** Install a sealed blob (written by the owner CLI) for one class. */
  install(cls: OwnerIdentityClass, sealed: Buffer): string {
    // v36: only a blob sealed to THIS broker key for THIS class is accepted (the plaintext is discarded at once).
    openSealed(this.privateDer, this.publicDer, sealed, `owner:${cls}`);
    writePrivate(this.fileFor(cls), sealed);
    return `ovault:${cls}`;
  }

  /** v51: open a mail / SMS provider secret the owner sealed to this key from the dashboard or the CLI (one provider name). */
  openProviderUpload(sealed: Buffer, name: string): Record<string, string> {
    if (!/^[a-z0-9][a-z0-9._-]{1,40}$/.test(name)) throw new Error("bad provider name");
    const v = JSON.parse(openSealed(this.privateDer, this.publicDer, sealed, `provider-upload:${name}`)) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.values(v as Record<string, unknown>).some((x) => typeof x !== "string")) throw new Error("FLEET_BAD_REQUEST");
    return v as Record<string, string>;
  }

  /** v37: open a secret the browser worker captured from a page, sealed to this key for one account and kind. */
  openCapture(sealed: Buffer, scope: string): string {
    if (!/^capture:[0-9a-f-]{36}:(api_key|password|recovery_codes|totp)$/.test(scope)) throw new Error("bad capture scope");
    return openSealed(this.privateDer, this.publicDer, sealed, scope);
  }

  /**
   * Open exactly the requested classes for one brokered verification. Only the broker calls this, only after the
   * registry authorised the release (standing consent ∩ configured classes); the values go to the provider connector
   * and nowhere else.
   */
  open(classes: readonly OwnerIdentityClass[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const c of classes) {
      const blob = readPrivate(this.fileFor(c), OWNER_BLOB_MAX);
      if (!blob) throw new Error(`FLEET_OWNER_IDENTITY_MISSING: ${c}`);
      out[c] = openSealed(this.privateDer, this.publicDer, blob, `owner:${c}`);
    }
    return out;
  }
}

/**
 * v41: the communications providers' master secrets (a mail bridge login, a numbers-API key), one blob per provider,
 * AES-256-GCM under a key derived from the broker's vault key for this purpose only. They reach only the provider
 * adapters inside the broker: never an agent, a prompt, a log or the database (which learns names, field names and a
 * keyed fingerprint). Admin reveals one through the step-up Reveal (sealed to the session's key).
 */
export const PROVIDER_SECRET_NAME = /^[a-z0-9][a-z0-9._-]{1,40}$/;

export class ProviderSecretVault {
  private readonly box: SecretBox;
  private readonly mac: Buffer;
  constructor(private readonly dir: string, vaultKey: Buffer) {
    const k = Buffer.from(crypto.hkdfSync("sha256", vaultKey, Buffer.alloc(0), "fleet-provider-secrets-v1", 64));
    this.box = new SecretBox(k.subarray(0, 32));
    this.mac = k.subarray(32);
  }

  private file(name: string): string {
    if (!PROVIDER_SECRET_NAME.test(name)) throw new Error("malformed provider secret name");
    return path.join(this.dir, `${name}.bin`);
  }

  /** Install (or replace) a provider's secret: a flat object of non-empty string fields. */
  put(name: string, value: Record<string, string>): { fields: string[]; fingerprint: string } {
    const keys = Object.keys(value).sort();
    if (keys.length < 1 || keys.length > 10 || keys.some((k) => !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k) || typeof value[k] !== "string" || !value[k] || value[k].length > 8192)) {
      throw new Error("a provider secret is 1..10 non-empty string fields");
    }
    const canonical = JSON.stringify(Object.fromEntries(keys.map((k) => [k, value[k]])));
    writePrivate(this.file(name), this.box.seal(canonical, `provider:${name}`));
    return { fields: keys, fingerprint: this.fingerprint(canonical) };
  }

  /** The secret for a provider adapter (null when not installed). */
  get(name: string): Record<string, string> | null {
    const blob = readPrivate(this.file(name));
    if (!blob) return null;
    return JSON.parse(this.box.open(blob, `provider:${name}`)) as Record<string, string>;
  }

  /** Names, field names and keyed fingerprints — what the registry may know. */
  list(): Array<{ name: string; fields: string[]; fingerprint: string }> {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir).filter((f) => f.endsWith(".bin")).map((f) => f.slice(0, -4)).filter((n) => PROVIDER_SECRET_NAME.test(n));
    } catch {
      return [];
    }
    const out: Array<{ name: string; fields: string[]; fingerprint: string }> = [];
    for (const name of names.sort()) {
      try {
        const v = this.get(name);
        if (v) out.push({ name, fields: Object.keys(v).sort(), fingerprint: this.fingerprint(JSON.stringify(v)) });
      } catch {
        // an unreadable blob is not listed (and cannot be used)
      }
    }
    return out;
  }

  remove(name: string): boolean {
    const f = this.file(name);
    try {
      fs.writeFileSync(f, crypto.randomBytes(fs.statSync(f).size));
      fs.unlinkSync(f);
      return true;
    } catch {
      return false;
    }
  }

  private fingerprint(canonical: string): string {
    return crypto.createHmac("sha256", this.mac).update(canonical, "utf8").digest("hex").slice(0, 16);
  }
}
