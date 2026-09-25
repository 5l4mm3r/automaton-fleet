/**
 * Claude bridge (Phase D) — SSH host-key pinning.
 *
 * The tunnel never trusts ~/.ssh/known_hosts or the global file. It uses a
 * dedicated known_hosts file that must contain exactly ONE line: the
 * controller host with an ssh-ed25519 key whose SHA-256 fingerprint equals
 * the pinned value in the bridge config (and the runbook). Anything else is
 * HOST_KEY_MISMATCH, before ssh is even started; ssh then enforces the same
 * key again (StrictHostKeyChecking=yes, HostKeyAlgorithms=ssh-ed25519).
 */

import crypto from "crypto";
import { execFileSync } from "child_process";
import { BridgeError } from "./errors.js";
import { readOwnedFile } from "./config.js";

const B64_BLOB = /^[A-Za-z0-9+/]+={0,2}$/;

/** OpenSSH-style fingerprint of a base64 public-key blob: "SHA256:<base64, no padding>". */
export function fingerprintOfBlob(blobB64: string): string {
  return `SHA256:${crypto.createHash("sha256").update(Buffer.from(blobB64, "base64")).digest("base64").replace(/=+$/, "")}`;
}

export function knownHostsToken(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

/** Validates the dedicated known_hosts file against the pin. */
export function verifyPinnedKnownHosts(file: string, host: string, port: number, pinned: string): void {
  let text: string;
  try {
    text = readOwnedFile(file, "known_hosts").toString("utf8");
  } catch (err) {
    throw new BridgeError("HOST_KEY_MISMATCH", err instanceof Error ? err.message : String(err));
  }
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (lines.length !== 1) throw new BridgeError("HOST_KEY_MISMATCH", `${file} must hold exactly one host key line (has ${lines.length})`);
  const parts = lines[0].split(/\s+/);
  if (parts.length < 3 || parts[0] !== knownHostsToken(host, port) || parts[1] !== "ssh-ed25519" || !B64_BLOB.test(parts[2])) {
    throw new BridgeError("HOST_KEY_MISMATCH", `${file} must contain exactly "${knownHostsToken(host, port)} ssh-ed25519 <key>"`);
  }
  const fpr = fingerprintOfBlob(parts[2]);
  if (fpr !== pinned) throw new BridgeError("HOST_KEY_MISMATCH", `pinned host key ${pinned} does not match ${file} (${fpr})`);
}

/**
 * Build the dedicated known_hosts line from an existing (possibly hashed)
 * known_hosts file, accepting only the ssh-ed25519 key with the pinned
 * fingerprint. Used by `fleet:bridge init`; never contacts the network (no
 * ssh-keyscan / TOFU).
 */
export function pinnedLineFrom(sourceKnownHosts: string, host: string, port: number, pinned: string, sshKeygen = "/usr/bin/ssh-keygen"): string {
  let out = "";
  try {
    out = execFileSync(sshKeygen, ["-F", knownHostsToken(host, port), "-f", sourceKnownHosts], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    out = "";
  }
  for (const line of out.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 3 && parts[1] === "ssh-ed25519" && B64_BLOB.test(parts[2]) && fingerprintOfBlob(parts[2]) === pinned) {
      return `${knownHostsToken(host, port)} ssh-ed25519 ${parts[2]}\n`;
    }
  }
  throw new BridgeError("HOST_KEY_MISMATCH", `no ssh-ed25519 key with fingerprint ${pinned} for ${host} in ${sourceKnownHosts}`);
}
