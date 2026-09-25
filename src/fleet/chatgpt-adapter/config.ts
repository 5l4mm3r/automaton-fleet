/**
 * ChatGPT adapter (Phase C) — configuration.
 *
 * /etc/automaton-fleet/chatgpt-adapter.json, root:automaton-fleet-chatgpt-adapter
 * 0640, single link, no symlinks (the same strict group-read rule as
 * operator.env). It holds PUBLIC identities and paths only: the enrolled
 * bridge_chatgpt principal id, the key id and key file path, the Operator API
 * port and service user, the SHA-256 of the tunnel token (never the token),
 * and rate limits. Unknown fields are rejected.
 */

import fs from "fs";
import path from "path";
import { KEY_ID_RE, PRINCIPAL_RE } from "../operator/canonical.js";
import { operatorEnvFileProblems } from "../secret-files.js";
import { BridgeError } from "../bridge/errors.js";

export const DEFAULT_ADAPTER_CONFIG = "/etc/automaton-fleet/chatgpt-adapter.json";

export interface AdapterConfig {
  version: 1;
  principalId: string;
  keyFile: string;
  keyId: string;
  operator: { port: number; user: string };
  /** sha256 (hex) of the static token tunnel-client adds to every request. */
  tunnelTokenSha256: string;
  limits: { callsPerMinute: number; burst: number; maxQueued: number };
}

function fail(msg: string): never {
  throw new BridgeError("CONFIG_INVALID", msg);
}

function exact(o: unknown, keys: string[], where: string): Record<string, unknown> {
  if (!o || typeof o !== "object" || Array.isArray(o)) fail(`${where} must be an object`);
  const got = Object.keys(o as object).sort().join(",");
  if (got !== [...keys].sort().join(",")) fail(`${where} must have exactly the fields ${keys.join(", ")}`);
  return o as Record<string, unknown>;
}

const intIn = (v: unknown, lo: number, hi: number, where: string) => (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : fail(`${where} must be an integer ${lo}..${hi}`));

export function parseAdapterConfig(raw: unknown): AdapterConfig {
  const o = exact(raw, ["version", "principalId", "keyFile", "keyId", "operator", "tunnelTokenSha256", "limits"], "config");
  if (o.version !== 1) fail("config.version must be 1");
  if (typeof o.principalId !== "string" || !PRINCIPAL_RE.test(o.principalId)) fail("config.principalId must be op_<ULID>");
  if (typeof o.keyFile !== "string" || !path.isAbsolute(o.keyFile) || path.normalize(o.keyFile) !== o.keyFile) fail("config.keyFile must be a normalized absolute path");
  if (typeof o.keyId !== "string" || !KEY_ID_RE.test(o.keyId)) fail("config.keyId must be 32 lowercase hex");
  if (typeof o.tunnelTokenSha256 !== "string" || !/^[0-9a-f]{64}$/.test(o.tunnelTokenSha256)) fail("config.tunnelTokenSha256 must be 64 lowercase hex");
  const op = exact(o.operator, ["port", "user"], "config.operator");
  if (typeof op.user !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(op.user)) fail("config.operator.user is not a valid user name");
  const l = exact(o.limits, ["callsPerMinute", "burst", "maxQueued"], "config.limits");
  return {
    version: 1,
    principalId: o.principalId,
    keyFile: o.keyFile,
    keyId: o.keyId,
    operator: { port: intIn(op.port, 1024, 65535, "config.operator.port"), user: op.user },
    tunnelTokenSha256: o.tunnelTokenSha256,
    limits: {
      callsPerMinute: intIn(l.callsPerMinute, 1, 600, "config.limits.callsPerMinute"),
      burst: intIn(l.burst, 1, 100, "config.limits.burst"),
      maxQueued: intIn(l.maxQueued, 0, 32, "config.limits.maxQueued"),
    },
  };
}

/** Root-owned (or `ownerUid`), group = this service's group, 0640 or stricter, one link, no symlinks. */
export function loadAdapterConfig(file = DEFAULT_ADAPTER_CONFIG, fileOpts: { ownerUid?: number; groupGid?: number | null } = {}): AdapterConfig {
  if (!fs.existsSync(file)) fail(`${file} does not exist`);
  const problems = operatorEnvFileProblems(file, fileOpts);
  if (problems.length) fail(`refusing insecure config: ${problems.join("; ")}`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail(`${file} is not valid JSON`);
  }
  return parseAdapterConfig(raw);
}
