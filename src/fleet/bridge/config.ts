/**
 * Claude bridge (Phase D) — local configuration.
 *
 * The config file holds PATHS and PUBLIC identities only (principal id, key
 * id, pinned SSH host-key fingerprint), never key material. It is read with
 * O_NOFOLLOW and must be a single-link regular file owned by this user and
 * not writable by group/other (it decides which key, host and host key are
 * trusted). Unknown fields are rejected. The remote endpoint is fixed to the
 * Operator API loopback listener (127.0.0.1:8788); the SSH account can only
 * forward there anyway.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { KEY_ID_RE, PRINCIPAL_RE } from "../operator/canonical.js";
import { BridgeError } from "./errors.js";

export const OPERATOR_REMOTE = Object.freeze({ host: "127.0.0.1", port: 8788 });

export const DEFAULT_BRIDGE_DIR = path.join(os.homedir(), ".config", "automaton-fleet", "operator");
export const DEFAULT_CONFIG_FILE = path.join(DEFAULT_BRIDGE_DIR, "bridge-claude.json");

export interface KeyRef {
  keyFile: string;
  keyId: string;
  /** Server-reported expiry (ISO), learned from whoami; null until known. */
  expiresAt: string | null;
}

export interface BridgeConfig {
  version: 1;
  principalId: string;
  key: KeyRef;
  /** Rotation in progress: generated, maybe enrolled, not yet in use. */
  pendingKey: KeyRef | null;
  /** Rotation finishing: replaced key, kept until proven revoked. */
  previousKey: KeyRef | null;
  ssh: {
    host: string;
    port: number;
    user: string;
    identityFile: string;
    knownHostsFile: string;
    /** Pinned ssh-ed25519 host key, "SHA256:<base64 without padding>". */
    hostKeyFingerprint: string;
    binary: string;
  };
}

const HOST_RE = /^(?:(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])$|^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const FPR_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

function fail(msg: string): never {
  throw new BridgeError("CONFIG_INVALID", msg);
}

function exactKeys(o: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (!o || typeof o !== "object" || Array.isArray(o)) fail(`${where} must be an object`);
  const got = Object.keys(o as object).sort();
  const want = [...keys].sort();
  if (got.join(",") !== want.join(",")) fail(`${where} must have exactly the fields ${want.join(", ")}`);
  return o as Record<string, unknown>;
}

function absPath(v: unknown, where: string): string {
  if (typeof v !== "string" || !path.isAbsolute(v) || path.normalize(v) !== v || v.includes("\0")) fail(`${where} must be a normalized absolute path`);
  return v;
}

function keyRef(v: unknown, where: string): KeyRef {
  const o = exactKeys(v, ["keyFile", "keyId", "expiresAt"], where);
  const keyFile = absPath(o.keyFile, `${where}.keyFile`);
  if (typeof o.keyId !== "string" || !KEY_ID_RE.test(o.keyId)) fail(`${where}.keyId must be 32 lowercase hex`);
  if (o.expiresAt !== null && (typeof o.expiresAt !== "string" || !ISO_RE.test(o.expiresAt))) fail(`${where}.expiresAt must be an ISO time or null`);
  return { keyFile, keyId: o.keyId, expiresAt: o.expiresAt as string | null };
}

export function parseBridgeConfig(raw: unknown): BridgeConfig {
  const o = exactKeys(raw, ["version", "principalId", "key", "pendingKey", "previousKey", "ssh"], "config");
  if (o.version !== 1) fail("config.version must be 1");
  if (typeof o.principalId !== "string" || !PRINCIPAL_RE.test(o.principalId)) fail("config.principalId must be op_<ULID>");
  const s = exactKeys(o.ssh, ["host", "port", "user", "identityFile", "knownHostsFile", "hostKeyFingerprint", "binary"], "config.ssh");
  if (typeof s.host !== "string" || !HOST_RE.test(s.host)) fail("config.ssh.host must be an IPv4 address or lowercase hostname");
  if (!Number.isInteger(s.port) || (s.port as number) < 1 || (s.port as number) > 65535) fail("config.ssh.port must be 1..65535");
  if (typeof s.user !== "string" || !USER_RE.test(s.user)) fail("config.ssh.user is not a valid user name");
  if (typeof s.hostKeyFingerprint !== "string" || !FPR_RE.test(s.hostKeyFingerprint)) fail("config.ssh.hostKeyFingerprint must be SHA256:<43 base64 chars>");
  const cfg: BridgeConfig = {
    version: 1,
    principalId: o.principalId,
    key: keyRef(o.key, "config.key"),
    pendingKey: o.pendingKey === null ? null : keyRef(o.pendingKey, "config.pendingKey"),
    previousKey: o.previousKey === null ? null : keyRef(o.previousKey, "config.previousKey"),
    ssh: {
      host: s.host,
      port: s.port as number,
      user: s.user,
      identityFile: absPath(s.identityFile, "config.ssh.identityFile"),
      knownHostsFile: absPath(s.knownHostsFile, "config.ssh.knownHostsFile"),
      hostKeyFingerprint: s.hostKeyFingerprint,
      binary: absPath(s.binary, "config.ssh.binary"),
    },
  };
  const files = [cfg.key.keyFile, cfg.pendingKey?.keyFile, cfg.previousKey?.keyFile].filter(Boolean);
  if (new Set(files).size !== files.length) fail("key files must be distinct");
  return cfg;
}

const uid = () => (typeof process.getuid === "function" ? process.getuid() : -1);

/**
 * A file this user owns, single-link, regular, not group/world-writable,
 * read through one O_NOFOLLOW descriptor. `secret` additionally forbids any
 * group/other access.
 */
export function readOwnedFile(file: string, what: string, opts: { secret?: boolean; maxBytes?: number } = {}): Buffer {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    throw new BridgeError(what === "config" ? "CONFIG_INVALID" : "KEY_INVALID", `${what} ${file} cannot be opened (${(err as NodeJS.ErrnoException).code ?? "error"})`);
  }
  try {
    const st = fs.fstatSync(fd);
    const bad = (m: string): never => {
      throw new BridgeError(what === "config" ? "CONFIG_INVALID" : "KEY_INVALID", `${what} ${file} ${m}`);
    };
    if (!st.isFile()) bad("is not a regular file");
    if (st.uid !== uid()) bad("is not owned by this user");
    if (st.nlink !== 1) bad("has extra hard links");
    if (opts.secret ? st.mode & 0o077 : st.mode & 0o022) bad(`has unsafe mode ${(st.mode & 0o777).toString(8)}`);
    if (st.size > (opts.maxBytes ?? 64 * 1024)) bad("is too large");
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function loadBridgeConfig(file = DEFAULT_CONFIG_FILE): BridgeConfig {
  const text = readOwnedFile(file, "config").toString("utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail(`config ${file} is not valid JSON`);
  }
  return parseBridgeConfig(raw);
}

/** Atomic, exclusive-temp write (0600) in the config's own directory. */
export function saveBridgeConfig(cfg: BridgeConfig, file = DEFAULT_CONFIG_FILE): void {
  parseBridgeConfig(JSON.parse(JSON.stringify(cfg)));
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(cfg, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}
