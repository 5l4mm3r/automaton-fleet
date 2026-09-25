/**
 * ChatGPT adapter (Phase C) — service entry point.
 *
 *   OpenAI Secure MCP Tunnel -> tunnel-client (own user, OpenAI key only)
 *     -> Unix socket (tunnel group only) + static token
 *     -> THIS adapter (own user, bridge-chatgpt Ed25519 key only)
 *     -> signed FLEET-OP-SIG-V1 over loopback -> Operator API 127.0.0.1:8788
 *
 * It exposes four read tools (no events: bridge_chatgpt can never hold
 * ops.read.events) through the shared MCP core, returning the Phase D model
 * view (untrusted_text preserved). Fail-closed rules:
 *  - refuses to start as root, as the wrong user, with any fleet/admin/DB/
 *    Conway/OpenAI credential in its environment, or while it can read any
 *    other fleet secret file;
 *  - the config is root-owned, own-group 0640; the key is 0600, own user;
 *  - identity gate: before serving (and every 5 minutes) a signed whoami must
 *    return this exact principal and key, kind bridge_chatgpt, and scopes
 *    exactly {ops.read.status, ops.read.agents}. Anything else — including a
 *    Claude principal or key — refuses every tool call (IDENTITY_MISMATCH);
 *  - every call re-proves the 8788 listener's owner uid and readiness.
 * No listening TCP socket: systemd passes the Unix socket (LISTEN_FDS).
 */

import fs from "fs";
import os from "os";
import type http from "http";
import { DEFAULT_ADMIN_ENV_FILE, DEFAULT_CUSTODY_ENV_FILE, DEFAULT_OPERATOR_ENV_FILE, DEFAULT_SERVICE_ENV_FILE, DEFAULT_TLS_KEY_FILE, OPERATOR_FORBIDDEN_ENV } from "../secret-files.js";
import { redactDetail } from "../redact.js";
import { BridgeError } from "../bridge/errors.js";
import { loadSigner, type SignerIdentity } from "../bridge/client.js";
import { uidOfUser, withDirectClient } from "../bridge/direct.js";
import { CHATGPT_TOOL_NAMES, FleetMcpServer, toolsNamed, UNTRUSTED_NOTICE, type Executor } from "../bridge/mcp-core.js";
import { DEFAULT_ADAPTER_CONFIG, loadAdapterConfig, type AdapterConfig } from "./config.js";
import { createAdapterServer } from "./http.js";

export const ADAPTER_NAME = "fleet-operator-chatgpt";
export const CHATGPT_SCOPES = Object.freeze(["ops.read.agents", "ops.read.status"]);
export const ADAPTER_FORBIDDEN_ENV: readonly string[] = Object.freeze([
  ...OPERATOR_FORBIDDEN_ENV,
  "FLEET_OPERATOR_DATABASE_URL",
  "CONTROL_PLANE_API_KEY",
  "OPENAI_ADMIN_KEY",
  "OPENAI_API_KEY",
]);
export const ADAPTER_UNREADABLE_FILES: readonly string[] = Object.freeze([
  DEFAULT_ADMIN_ENV_FILE,
  DEFAULT_SERVICE_ENV_FILE,
  DEFAULT_OPERATOR_ENV_FILE,
  DEFAULT_CUSTODY_ENV_FILE,
  DEFAULT_TLS_KEY_FILE,
  "/etc/automaton-fleet/legacy-env-fleet.bak",
  "/etc/automaton-fleet/chatgpt-tunnel/openai-api-key",
  "/etc/automaton-fleet/chatgpt-tunnel/adapter-token",
  "/run/credentials/automaton-fleet.service/service.env",
  "/var/lib/automaton-fleet-witness/fleet-credentials.json",
]);
const IDENTITY_TTL_MS = 5 * 60_000;

export const CHATGPT_INSTRUCTIONS =
  "Read-only view of the Automaton fleet for its owner, through the signed Operator API (principal bridge-chatgpt). " +
  "Tools: fleet_whoami, fleet_status, fleet_list_agents, fleet_get_agent. There are no write, admin or event tools. " +
  UNTRUSTED_NOTICE;

export interface AdapterStartOptions {
  configFile?: string;
  env?: Record<string, string | undefined>;
  /** Tests: config ownership (production: root / this service's group). */
  configOwnerUid?: number;
  configGroupGid?: number | null;
  /** Tests: override the Operator API listener owner (production: uid of config.operator.user). */
  operatorListenerUid?: number;
  /** Tests: files that must be unreadable (production: ADAPTER_UNREADABLE_FILES). */
  unreadableFiles?: readonly string[];
  /** Listen: systemd socket (LISTEN_FDS) in production; a Unix socket path in tests. */
  socketPath?: string;
  auditFile?: string;
  log?: (line: Record<string, unknown>) => void;
  now?: () => number;
}

export function adapterEnvProblems(e: Record<string, string | undefined>, unreadable: readonly string[] = ADAPTER_UNREADABLE_FILES): string[] {
  const problems: string[] = [];
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (uid === 0) problems.push("refusing to run as root");
  const expected = e.FLEET_CHATGPT_ADAPTER_EXPECTED_USER?.trim();
  if (expected && os.userInfo().username !== expected) problems.push(`running as ${os.userInfo().username}, expected ${expected}`);
  if (!expected && e.NODE_ENV === "production") problems.push("FLEET_CHATGPT_ADAPTER_EXPECTED_USER is required in production");
  for (const k of ADAPTER_FORBIDDEN_ENV) if (e[k]) problems.push(`${k} present (the ChatGPT adapter must hold no other credential)`);
  for (const f of unreadable) {
    try {
      fs.accessSync(f, fs.constants.R_OK);
      problems.push(`secret ${f} is readable by this process`);
    } catch {
      // not readable: as intended
    }
  }
  return problems;
}

/** Signed whoami must describe exactly the configured bridge_chatgpt principal with exactly the read scopes. */
export function identityProblems(cfg: AdapterConfig, w: { principal: { id: string; kind: string; scopes: string[] }; key: { id: string } }): string[] {
  const p: string[] = [];
  if (w.principal.id !== cfg.principalId) p.push("principal differs from config");
  if (w.key.id !== cfg.keyId) p.push("key differs from config");
  if (w.principal.kind !== "bridge_chatgpt") p.push(`principal kind is ${w.principal.kind}, expected bridge_chatgpt`);
  const scopes = [...w.principal.scopes].sort();
  if (JSON.stringify(scopes) !== JSON.stringify(CHATGPT_SCOPES)) p.push(`scopes are [${scopes.join(", ")}], expected exactly [${CHATGPT_SCOPES.join(", ")}]`);
  return p;
}

export async function startAdapter(opts: AdapterStartOptions = {}): Promise<{ server: http.Server; mcp: FleetMcpServer; close: () => Promise<void> }> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((l) => process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), service: ADAPTER_NAME, ...l })}\n`));
  const problems = adapterEnvProblems(env, opts.unreadableFiles ?? ADAPTER_UNREADABLE_FILES);
  if (problems.length) throw new Error(`ChatGPT adapter startup refused: ${problems.join("; ")}`);
  const cfg = loadAdapterConfig(opts.configFile ?? env.FLEET_CHATGPT_ADAPTER_CONFIG ?? DEFAULT_ADAPTER_CONFIG, { ownerUid: opts.configOwnerUid, groupGid: opts.configGroupGid });
  const listenerUid = opts.operatorListenerUid ?? uidOfUser(cfg.operator.user);
  if (listenerUid === null) throw new Error(`ChatGPT adapter startup refused: unknown Operator API user ${cfg.operator.user}`);
  const signer: SignerIdentity = loadSigner(cfg.principalId, { keyFile: cfg.keyFile, keyId: cfg.keyId, expiresAt: null });
  const now = opts.now ?? Date.now;

  const auditFile = opts.auditFile ?? env.FLEET_CHATGPT_ADAPTER_AUDIT_LOG;
  if (auditFile) fs.closeSync(fs.openSync(auditFile, "a", 0o600));
  const audit = (entry: Record<string, unknown>) => {
    const line = JSON.stringify(redactDetail({ ts: new Date(now()).toISOString(), ...entry }));
    if (auditFile) fs.appendFileSync(auditFile, `${line}\n`, { mode: 0o600 });
  };

  const direct = { principalId: cfg.principalId, key: { keyFile: cfg.keyFile, keyId: cfg.keyId, expiresAt: null }, port: cfg.operator.port, listenerUid };
  let identity: { at: number; ok: boolean; problems: string[] } = { at: 0, ok: false, problems: ["not yet verified"] };
  const verifyIdentity = async () => {
    if (identity.ok && now() - identity.at < IDENTITY_TTL_MS) return;
    const w = await withDirectClient(direct, async (c) => (await c.whoami()).data, signer);
    const p = identityProblems(cfg, w);
    identity = { at: now(), ok: p.length === 0, problems: p };
    audit({ event: "identity_check", ok: identity.ok, problems: p });
    if (!identity.ok) log({ level: "error", event: "identity_refused", problems: p });
  };
  const execute: Executor = async (tool, args) => {
    await verifyIdentity();
    if (!identity.ok) throw new BridgeError("IDENTITY_MISMATCH", `the adapter's Operator API identity is not the approved read-only ChatGPT principal: ${identity.problems.join("; ")}`);
    return withDirectClient(direct, (c) => tool.run(c, args), signer);
  };

  const mcp = new FleetMcpServer({
    serverName: ADAPTER_NAME,
    instructions: CHATGPT_INSTRUCTIONS,
    tools: toolsNamed(CHATGPT_TOOL_NAMES),
    execute,
    requireInitialize: false,
    rateLimit: { capacity: cfg.limits.burst, refillPerSec: cfg.limits.callsPerMinute / 60 },
    maxQueued: cfg.limits.maxQueued,
    now,
    log: (l) => audit(l),
  });
  const server = createAdapterServer({
    mcp,
    tunnelTokenSha256: cfg.tunnelTokenSha256,
    audit: (e) => audit({ ...e }),
    health: () => ({ ok: true, ready: identity.ok }),
  });

  const fds = env.LISTEN_FDS === "1" && env.LISTEN_PID === String(process.pid);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    if (fds) server.listen({ fd: 3 }, () => resolve());
    else if (opts.socketPath) server.listen(opts.socketPath, () => resolve());
    else reject(new Error("no listener: expected a systemd socket (LISTEN_FDS=1) or an explicit socket path"));
  });
  // Warm the identity gate (failures are retried on the next call; nothing is served unverified).
  void verifyIdentity().catch((err) => log({ level: "warn", event: "identity_pending", code: err instanceof BridgeError ? err.code : "INTERNAL" }));
  log({ level: "info", event: "adapter_started", principalId: cfg.principalId, keyId: cfg.keyId, tools: CHATGPT_TOOL_NAMES, systemdSocket: fds });
  audit({ event: "adapter_started", principalId: cfg.principalId, keyId: cfg.keyId });
  const close = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await Promise.race([mcp.drain(), new Promise((r) => setTimeout(r, 3000))]);
  };
  return { server, mcp, close };
}

if (process.argv[1] && /fleet[\\/]chatgpt-adapter[\\/]main\.(ts|js)$/.test(process.argv[1])) {
  console.log = console.info = console.debug = (...a: unknown[]) => process.stderr.write(`${a.map(String).join(" ")}\n`);
  startAdapter().then(
    ({ close }) => {
      const stop = () => void close().finally(() => process.exit(0));
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    },
    (err) => {
      process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), service: ADAPTER_NAME, level: "fatal", event: "startup_failed", error: err instanceof Error ? err.message : String(err) })}\n`);
      process.exit(1);
    },
  );
}
