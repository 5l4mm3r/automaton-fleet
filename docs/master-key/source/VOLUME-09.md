# SOURCE VOLUME 09 — ChatGPT adapter C (src/fleet/chatgpt-adapter)

Exact, byte-for-byte text of each file at repository commit `efad2148a3460ab881b0ab845fb13c25d1fa3e74` (branch fleet-development).
No file in this volume contains a real secret; test fixtures generate synthetic secrets at runtime.
Each file's SHA-256 is of the file bytes on disk and matches 22-RECONSTRUCTION-MANIFEST.md.

## Files

- `src/fleet/chatgpt-adapter/config.ts` — 81 lines, sha256 `866e4c3127cb4c034de45600b9da7be44689b3599a203631607107281c7171ff`
- `src/fleet/chatgpt-adapter/http.ts` — 125 lines, sha256 `c983edbd7b8a514e8aaf2c533238ae8de047c5c738dacf05ff14b1eb2a203e6f`
- `src/fleet/chatgpt-adapter/main.ts` — 193 lines, sha256 `db6b0622f2cf733a4914e164d986cd8b8effc234bf8e50dc8c27978d02e414ca`

## `src/fleet/chatgpt-adapter/config.ts`

sha256 `866e4c3127cb4c034de45600b9da7be44689b3599a203631607107281c7171ff` · 4021 bytes · 81 lines

```ts
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
```

## `src/fleet/chatgpt-adapter/http.ts`

sha256 `c983edbd7b8a514e8aaf2c533238ae8de047c5c738dacf05ff14b1eb2a203e6f` · 5736 bytes · 125 lines

```ts
/**
 * ChatGPT adapter (Phase C) — Streamable HTTP transport on a Unix socket.
 *
 * The only client is OpenAI's tunnel-client (Secure MCP Tunnel), reaching
 * this server over a systemd-created Unix socket that only its group can
 * open. Every request must also carry the static tunnel token (compared by
 * SHA-256 in constant time). Surface:
 *
 *   POST /mcp      JSON-RPC 2.0 (one message; no batching) -> 200 JSON, or 202 for a notification
 *   GET  /healthz  {"ok":true}                               (no token; no fleet data)
 *   anything else  404 / 405
 *
 * Deliberately absent: GET/SSE streams, sessions, OAuth protected-resource
 * metadata (/.well-known/*), CORS. Without OAuth metadata, tunnel-client
 * registers no Harpoon targets, so its outbound-HTTP feature stays inert.
 * Browsers (any Origin header) are refused. Bodies are bounded; responses are
 * application/json and no-store.
 */

import crypto from "crypto";
import http from "http";
import type { FleetMcpServer } from "../bridge/mcp-core.js";
import { MAX_MESSAGE_BYTES } from "../bridge/mcp-core.js";

export const TOKEN_HEADER = "x-fleet-adapter-token";

export interface HttpAuditEntry {
  event: "http";
  method: string;
  path: string;
  status: number;
  ms: number;
  rpc?: string;
}

export interface AdapterHttpOptions {
  mcp: FleetMcpServer;
  tunnelTokenSha256: string;
  audit?: (e: HttpAuditEntry) => void;
  health?: () => { ok: boolean; ready: boolean };
}

const KNOWN_PATHS = new Set(["/mcp", "/healthz"]);

export function tokenMatches(presented: string | string[] | undefined, expectedSha256: string): boolean {
  if (typeof presented !== "string" || presented.length === 0 || presented.length > 256) return false;
  const got = crypto.createHash("sha256").update(presented, "utf8").digest();
  const want = Buffer.from(expectedSha256, "hex");
  return want.length === 32 && crypto.timingSafeEqual(got, want);
}

export function createAdapterServer(opts: AdapterHttpOptions): http.Server {
  const server = http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 30_000, headersTimeout: 5_000, keepAliveTimeout: 5_000 }, (req, res) => {
    const started = Date.now();
    const rawPath = (req.url ?? "").split("?")[0];
    const pathLabel = KNOWN_PATHS.has(rawPath) ? rawPath : rawPath.startsWith("/.well-known/") ? "/.well-known/*" : "other";
    let rpc: string | undefined;
    const send = (status: number, body: unknown, extra: Record<string, string> = {}) => {
      const text = body === null ? "" : JSON.stringify(body);
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-length": String(Buffer.byteLength(text)),
        ...extra,
      });
      res.end(text);
      opts.audit?.({ event: "http", method: String(req.method ?? "").slice(0, 10), path: pathLabel, status, ms: Date.now() - started, ...(rpc ? { rpc } : {}) });
    };
    const drainAnd = (fn: () => void) => {
      req.resume();
      req.on("end", fn);
      req.on("error", () => fn());
    };

    const host = String(req.headers.host ?? "");
    if (!/^localhost(:80)?$/.test(host)) return drainAnd(() => send(421, { ok: false, error: "misdirected" }));
    if (req.headers.origin !== undefined) return drainAnd(() => send(403, { ok: false, error: "browser origins are not accepted" }));

    if (rawPath === "/healthz" && req.method === "GET") {
      const h = opts.health?.() ?? { ok: true, ready: true };
      return drainAnd(() => send(200, { ok: h.ok, ready: h.ready }));
    }
    // No OAuth: discovery probes (sent with their own header set) get a plain 404, never a 401 that
    // could start an OAuth flow, and no protected-resource metadata that could register Harpoon targets.
    if (rawPath.startsWith("/.well-known/")) return drainAnd(() => send(404, { ok: false, error: "not found" }));
    if (!tokenMatches(req.headers[TOKEN_HEADER], opts.tunnelTokenSha256)) return drainAnd(() => send(401, { ok: false, error: "unauthorized" }));
    if (rawPath !== "/mcp") return drainAnd(() => send(404, { ok: false, error: "not found" }));
    if (req.method !== "POST") return drainAnd(() => send(405, { ok: false, error: "method not allowed" }, { allow: "POST" }));
    if (!/^application\/json(\s*;|$)/i.test(String(req.headers["content-type"] ?? ""))) return drainAnd(() => send(415, { ok: false, error: "content-type must be application/json" }));
    const declared = Number(req.headers["content-length"] ?? "NaN");
    if (Number.isFinite(declared) && declared > MAX_MESSAGE_BYTES) return drainAnd(() => send(413, { ok: false, error: "body too large" }));

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (d: Buffer) => {
      if (aborted) return;
      size += d.length;
      if (size > MAX_MESSAGE_BYTES) {
        aborted = true;
        send(413, { ok: false, error: "body too large" });
        req.destroy();
      } else chunks.push(d);
    });
    req.on("end", () => {
      if (aborted) return;
      const body = Buffer.concat(chunks).toString("utf8");
      try {
        const m = JSON.parse(body) as { method?: unknown };
        if (m && typeof m === "object" && !Array.isArray(m) && typeof m.method === "string") rpc = m.method.slice(0, 40);
      } catch {
        // dispatchRaw reports the parse error
      }
      void opts.mcp.dispatchRaw(body).then(
        (r) => (r === null ? send(202, null) : send(200, r)),
        () => send(500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "internal error" } }),
      );
    });
    req.on("error", () => {
      aborted = true;
    });
  });
  return server;
}
```

## `src/fleet/chatgpt-adapter/main.ts`

sha256 `db6b0622f2cf733a4914e164d986cd8b8effc234bf8e50dc8c27978d02e414ca` · 10495 bytes · 193 lines

```ts
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
import { DEFAULT_ADMIN_ENV_FILE, DEFAULT_OPERATOR_ENV_FILE, DEFAULT_SERVICE_ENV_FILE, DEFAULT_TLS_KEY_FILE, OPERATOR_FORBIDDEN_ENV } from "../secret-files.js";
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
```
