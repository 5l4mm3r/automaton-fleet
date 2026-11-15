/**
 * Custody vault (schema v32): where the custody executor — and only it — finds the secret behind a credential
 * reference. Files in one directory owned by the custody service (systemd LoadCredential= / $CREDENTIALS_DIRECTORY, or
 * FLEET_CUSTODY_VAULT_DIR), one file per reference: `vault:paypal/treasury` → `paypal~treasury` (`~` cannot occur in a
 * reference, so the mapping is unambiguous and has no path separator).
 *
 * Strict by construction: a regular file (never a symlink), mode 0600 or 0400 (no group or other access at all), owned by
 * this process's user or root, at most 4 KiB. A secret is resolved for one call and never cached
 * or logged here; FleetController, agents and every other service cannot read the directory (unit InaccessiblePaths).
 */
import fs from "fs";
import path from "path";
import type { SecretVault } from "../payments/credential-broker.js";

const REF = /^vault:([a-z0-9][a-z0-9/._-]{2,118})$/;

export function vaultFileName(vaultRef: string): string | null {
  const m = REF.exec(vaultRef);
  if (!m || m[1].includes("..") || m[1].includes("~")) return null;
  return m[1].replace(/\//g, "~");
}

export class VaultFileError extends Error {}

/** Problems with one vault file (names and modes only, never content). */
export function vaultFileProblems(file: string, uid: number | null): string[] {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return [`${path.basename(file)}: missing`];
  }
  const p: string[] = [];
  if (st.isSymbolicLink()) p.push(`${path.basename(file)}: is a symlink`);
  else if (!st.isFile()) p.push(`${path.basename(file)}: not a regular file`);
  if ((st.mode & 0o077) !== 0) p.push(`${path.basename(file)}: accessible by group or others (mode ${(st.mode & 0o777).toString(8)}; 0600 or 0400 only)`);
  if (uid !== null && st.uid !== uid && st.uid !== 0) p.push(`${path.basename(file)}: owned by uid ${st.uid}`);
  if (st.size > 4096) p.push(`${path.basename(file)}: larger than 4 KiB`);
  return p;
}

export class FileVault implements SecretVault {
  private readonly dir: string;
  constructor(dir: string, private readonly uid: number | null = typeof process.getuid === "function" ? process.getuid() : null) {
    if (!path.isAbsolute(dir)) throw new VaultFileError("the custody vault directory must be an absolute path");
    this.dir = path.resolve(dir);
  }

  /** The file a reference maps to, inside the vault directory (null for a malformed reference). */
  fileFor(vaultRef: string): string | null {
    const name = vaultFileName(vaultRef);
    if (!name) return null;
    const f = path.join(this.dir, name);
    return path.dirname(f) === this.dir ? f : null;
  }

  async resolve(vaultRef: string): Promise<string | null> {
    const f = this.fileFor(vaultRef);
    if (!f || vaultFileProblems(f, this.uid).length) return null;
    const v = fs.readFileSync(f, "utf8").trim();
    return v.length ? v : null;
  }
}
