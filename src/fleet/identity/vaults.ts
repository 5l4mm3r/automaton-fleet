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

function readPrivate(file: string): Buffer | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0 || st.size > 1_000_000) return null;
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
  "proof_of_address", "tax_identifier", "bank_account_owner", "other_fact", "passport", "driving_licence"] as const;
export type OwnerIdentityClass = (typeof OWNER_IDENTITY_CLASSES)[number];

/** Owner CLI side: seal one class to the broker's public key. The CLI can never read it back. */
export function sealOwnerFact(brokerPublicDer: Buffer, cls: OwnerIdentityClass, value: string): Buffer {
  if (!OWNER_IDENTITY_CLASSES.includes(cls)) throw new Error("unknown owner identity class");
  // A fact is text; a document (passport, licence, proof of address) is {"contentType","dataB64"} JSON — up to ~8 MB.
  if (!value || value.length > 11_000_000) throw new Error("an owner fact or document is 1 byte to ~8 MB");
  return sealTo(brokerPublicDer, value, `owner:${cls}`);
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

  /**
   * Open exactly the requested classes for one brokered verification. Only the broker calls this, only after the
   * registry authorised the release (standing consent ∩ configured classes); the values go to the provider connector
   * and nowhere else.
   */
  open(classes: readonly OwnerIdentityClass[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const c of classes) {
      const blob = readPrivate(this.fileFor(c));
      if (!blob) throw new Error(`FLEET_OWNER_IDENTITY_MISSING: ${c}`);
      out[c] = openSealed(this.privateDer, this.publicDer, blob, `owner:${c}`);
    }
    return out;
  }
}
