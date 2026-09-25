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
