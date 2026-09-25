/**
 * Claude bridge (Phase D) — signing-key status and rotation.
 *
 * Rotation is strictly: add new key -> verify new key -> switch client ->
 * revoke old key -> prove old key rejected -> delete old key file.
 *
 *   rotate-prepare  generate a new key on this host (0600, exclusive) and
 *                   record it as pending; print the operator's VPS command
 *                   (fleet:admin operator-add-key, public key only)
 *   rotate-verify   a signed whoami with the PENDING key must be accepted and
 *                   report that key id; records its server expiry
 *   rotate-switch   the pending key becomes current; the old one becomes
 *                   "previous"; print the operator's revoke command
 *   rotate-finish   a signed whoami with the PREVIOUS key must now fail
 *                   AUTH_FAILED and the current key must still work; only
 *                   then is the old private key file deleted
 *
 * Enrolment and revocation stay on the VPS with the admin credential: the
 * bridge has no path to either. Every step refuses to run out of order.
 */

import fs from "fs";
import path from "path";
import { generateOperatorKey } from "../operator/keygen.js";
import { BridgeError } from "./errors.js";
import { readOwnedFile, saveBridgeConfig, type BridgeConfig, type KeyRef } from "./config.js";
import type { WhoamiData } from "./validate.js";

/** Operator policy: warn three weeks before expiry, critical in the last week (max validity is 90 days). */
export const KEY_WARN_DAYS = 21;
export const KEY_CRITICAL_DAYS = 7;
export const DEFAULT_ROTATION_DAYS = 30;

export type KeyLevel = "ok" | "warn" | "critical" | "expired" | "unknown";

export function keyLevel(expiresAt: string | null, now = Date.now()): { level: KeyLevel; daysLeft: number | null } {
  if (!expiresAt) return { level: "unknown", daysLeft: null };
  const days = (Date.parse(expiresAt) - now) / 86_400_000;
  const daysLeft = Math.floor(days * 10) / 10;
  if (days <= 0) return { level: "expired", daysLeft };
  if (days <= KEY_CRITICAL_DAYS) return { level: "critical", daysLeft };
  if (days <= KEY_WARN_DAYS) return { level: "warn", daysLeft };
  return { level: "ok", daysLeft };
}

/** A whoami performed with a specific key reference (tunnel + signed request). */
export type WhoamiWith = (ref: KeyRef) => Promise<WhoamiData>;

export function rotatePrepare(cfg: BridgeConfig, cfgFile: string, opts: { dir?: string; now?: Date; days?: number } = {}) {
  if (cfg.pendingKey) throw new BridgeError("CONFIG_INVALID", "a rotation is already pending (run rotate-verify / rotate-switch)");
  if (cfg.previousKey) throw new BridgeError("CONFIG_INVALID", "the previous rotation is not finished (run rotate-finish)");
  const days = opts.days ?? DEFAULT_ROTATION_DAYS;
  if (!(Number.isInteger(days) && days >= 1 && days <= 90)) throw new BridgeError("CONFIG_INVALID", "expires-days must be 1..90");
  const dir = opts.dir ?? path.dirname(cfg.key.keyFile);
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const r = generateOperatorKey(path.join(dir, `bridge-claude.${stamp}.key`));
  const next: BridgeConfig = { ...cfg, pendingKey: { keyFile: r.file, keyId: r.keyId, expiresAt: null } };
  saveBridgeConfig(next, cfgFile);
  return {
    config: next,
    pending: next.pendingKey!,
    publicKey: r.publicKey,
    operatorCommand: `pnpm fleet:admin operator-add-key ${cfg.principalId} --public-key ${r.publicKey} --expires-days ${days}`,
  };
}

export async function rotateVerify(cfg: BridgeConfig, cfgFile: string, whoamiWith: WhoamiWith) {
  if (!cfg.pendingKey) throw new BridgeError("CONFIG_INVALID", "no pending key (run rotate-prepare first)");
  const w = await whoamiWith(cfg.pendingKey);
  if (w.key.id !== cfg.pendingKey.keyId || w.principal.id !== cfg.principalId) throw new BridgeError("IDENTITY_MISMATCH", "the pending key was answered for a different key or principal");
  const next: BridgeConfig = { ...cfg, pendingKey: { ...cfg.pendingKey, expiresAt: w.key.expiresAt } };
  saveBridgeConfig(next, cfgFile);
  return { config: next, pending: next.pendingKey! };
}

export function rotateSwitch(cfg: BridgeConfig, cfgFile: string) {
  if (!cfg.pendingKey) throw new BridgeError("CONFIG_INVALID", "no pending key");
  if (!cfg.pendingKey.expiresAt) throw new BridgeError("CONFIG_INVALID", "the pending key has not been verified (run rotate-verify)");
  const next: BridgeConfig = { ...cfg, key: cfg.pendingKey, previousKey: cfg.key, pendingKey: null };
  saveBridgeConfig(next, cfgFile);
  return {
    config: next,
    operatorCommand: `pnpm fleet:admin operator-revoke-key ${cfg.key.keyId} rotated to ${cfg.pendingKey.keyId}`,
  };
}

export async function rotateFinish(cfg: BridgeConfig, cfgFile: string, whoamiWith: WhoamiWith) {
  const prev = cfg.previousKey;
  if (!prev) throw new BridgeError("CONFIG_INVALID", "no previous key to retire");
  let oldStillWorks = false;
  try {
    await whoamiWith(prev);
    oldStillWorks = true;
  } catch (err) {
    // Rejected by the server, or past the expiry the server itself enforces. Anything else is undecided: keep everything.
    if (!(err instanceof BridgeError) || (err.code !== "AUTH_FAILED" && err.code !== "KEY_EXPIRED")) throw err;
  }
  if (oldStillWorks) throw new BridgeError("CONFIG_INVALID", `the old key ${prev.keyId} is still accepted; revoke it on the VPS first (operator-revoke-key)`);
  const w = await whoamiWith(cfg.key);
  if (w.key.id !== cfg.key.keyId) throw new BridgeError("IDENTITY_MISMATCH", "the current key was answered for a different key");
  readOwnedFile(prev.keyFile, "previous signing key", { secret: true }); // ours, regular, 0600, single link
  fs.rmSync(prev.keyFile);
  const next: BridgeConfig = { ...cfg, previousKey: null, key: { ...cfg.key, expiresAt: w.key.expiresAt } };
  saveBridgeConfig(next, cfgFile);
  return { config: next, removed: prev.keyFile };
}

/** Record the server-reported expiry of the current key (key status --remote). */
export async function refreshExpiry(cfg: BridgeConfig, cfgFile: string, whoamiWith: WhoamiWith) {
  const w = await whoamiWith(cfg.key);
  if (w.key.expiresAt === cfg.key.expiresAt) return cfg;
  const next: BridgeConfig = { ...cfg, key: { ...cfg.key, expiresAt: w.key.expiresAt } };
  saveBridgeConfig(next, cfgFile);
  return next;
}
