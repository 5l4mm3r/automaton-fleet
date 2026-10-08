/**
 * Schema v49: PayPal app credentials onboarded from the Admin dashboard, sealed IN THE BROWSER to the custody executor's
 * published X25519 key (the identity broker's FSB1 format, scope `custody:<vaultRef>`). The registry stores ciphertext
 * only; this vault — inside the custody executor, whose key never leaves its 0600 state file — opens them into memory.
 *
 * The key pair is created on first start in the custody state directory (custody-x25519.json, 0600, regular file, owned
 * by the custody user); its public half and fingerprint are published to the registry for the dashboard. A revoked
 * credential disappears from the vault at the next refresh.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { generateX25519, openSealed, type X25519KeyPair } from "../identity/crypto.js";
import type { SecretVault } from "../payments/credential-broker.js";
import type { CxResult } from "./gateway.js";

export interface SealedCredentialPort {
  publishKey(worker: string, publicKeyB64: string, fingerprint: string): Promise<CxResult>;
  sealedCredentials(worker: string): Promise<Array<{ vaultRef: string; sealedB64: string; fingerprint: string }>>;
}

export const CUSTODY_KEY_FILE = "custody-x25519.json";

export function fingerprintOf(publicKeyDer: Buffer): string {
  return crypto.createHash("sha256").update(publicKeyDer).digest("hex");
}

/** Load the custody key pair from the state directory, creating it (0600) on first use. Refuses an insecure file. */
export function loadOrCreateCustodyKey(stateDir: string, uid: number | null = typeof process.getuid === "function" ? process.getuid() : null): X25519KeyPair {
  const f = path.join(stateDir, CUSTODY_KEY_FILE);
  if (fs.existsSync(f)) {
    const st = fs.lstatSync(f);
    if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0 || (uid !== null && st.uid !== uid)) {
      throw new Error(`custody key ${f} must be a regular 0600 file owned by the custody user`);
    }
    const j = JSON.parse(fs.readFileSync(f, "utf8")) as { publicKeyB64?: string; privateKeyB64?: string };
    if (typeof j.publicKeyB64 !== "string" || typeof j.privateKeyB64 !== "string") throw new Error(`custody key ${f} is malformed`);
    return { publicKeyDer: Buffer.from(j.publicKeyB64, "base64"), privateKeyDer: Buffer.from(j.privateKeyB64, "base64") };
  }
  const k = generateX25519();
  const tmp = path.join(stateDir, `.${CUSTODY_KEY_FILE}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ publicKeyB64: k.publicKeyDer.toString("base64"), privateKeyB64: k.privateKeyDer.toString("base64") }), { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, f);
  return k;
}

export class SealedCredentialVault implements SecretVault {
  private secrets = new Map<string, string>();
  readonly fingerprint: string;

  constructor(private readonly gw: SealedCredentialPort, private readonly key: X25519KeyPair, private readonly worker = "custody-executor",
    private readonly log?: (level: string, event: string, detail?: Record<string, unknown>) => void) {
    this.fingerprint = fingerprintOf(key.publicKeyDer);
  }

  async publish(): Promise<void> {
    await this.gw.publishKey(this.worker, this.key.publicKeyDer.toString("base64"), this.fingerprint);
  }

  /** Re-read the active sealed credentials (a revoked one is dropped; one sealed to an older key is skipped and reported). */
  async refresh(): Promise<number> {
    const next = new Map<string, string>();
    for (const c of await this.gw.sealedCredentials(this.worker)) {
      if (c.fingerprint !== this.fingerprint) { this.log?.("warn", "custody_sealed_credential_wrong_key", { vaultRef: c.vaultRef }); continue; }
      try {
        next.set(c.vaultRef, openSealed(this.key.privateKeyDer, this.key.publicKeyDer, Buffer.from(c.sealedB64, "base64"), `custody:${c.vaultRef}`));
      } catch {
        this.log?.("warn", "custody_sealed_credential_unreadable", { vaultRef: c.vaultRef });
      }
    }
    this.secrets = next;
    return next.size;
  }

  async resolve(vaultRef: string): Promise<string | null> {
    return this.secrets.get(vaultRef) ?? null;
  }

  refs(): string[] {
    return [...this.secrets.keys()];
  }
}

/** File vault first (host-installed credentials), then the dashboard-sealed ones. */
export class CompositeVault implements SecretVault {
  constructor(private readonly vaults: Array<SecretVault | null>) {}
  async resolve(vaultRef: string): Promise<string | null> {
    for (const v of this.vaults) {
      if (!v) continue;
      const x = await v.resolve(vaultRef).catch(() => null);
      if (x) return x;
    }
    return null;
  }
}
