/**
 * Operator API server (Phase B2). A separate process from FleetController:
 * loopback-only HTTP listener (127.0.0.1:8788), read-only v1 routes, every
 * request individually Ed25519-signed (canonical.ts) and re-checked by the
 * database (op_begin_request) before exactly one STABLE read function runs.
 *
 * Verification order (fail closed; unauthenticated input never causes a
 * database write):
 *   1  canonical request target, route in OPERATOR_ROUTE_POLICY   (404 / 400)
 *   2  headers: exactly one of each X-Fleet-Op-*, no Authorization/Cookie
 *   3  empty body (no Content-Length > 0, no Transfer-Encoding)
 *   4  query parameters allow-listed per route with exact formats
 *   5  (unused; auth failures never lock out other principals)
 *   6  ±30 s timestamp window (process clock)
 *   7  principal/key lookup (public keys only; cache <= 30 s, dropped on
 *      kill-switch generation change) and principal kind for the route;
 *      lookups of pairs never seen valid share one global budget
 *   8  Ed25519 signature over the canonical string
 *   9  scope, 10 per-principal rate limit
 *  11  op_begin_request: kill switch, audit cap, principal/key/scope/route
 *      again from the database, database-time window, nonce (replay)
 *  12  exactly the route's read function, in a READ ONLY transaction;
 *      typed, per-item-redacted response
 *
 * /healthz and /readyz are unauthenticated, require a loopback Host header
 * (DNS rebinding) and serve a readiness result cached per poll interval.
 * Denied-request audit lines are budgeted; the excess is summarised.
 *
 * 401 responses never say which check failed; the reason goes to the audit
 * log only. Private keys, signatures, raw nonces, Authorization values and
 * request bodies are never logged.
 */

import http from "http";
import crypto, { type KeyObject } from "crypto";
import { RateLimiter, type RateLimit } from "../service/rate-limit.js";
import {
  EMPTY_BODY_SHA256,
  OP_LIMITS,
  PRINCIPAL_RE,
  canonicalString,
  decodeSignature,
  parseTarget,
  publicKeyFromRaw,
  readOpHeaders,
  verifySignature,
  type OpErrorCode,
} from "./canonical.js";
import { matchRoute, verifyRoutePolicy, type RouteMatch } from "./route-policy.js";
import type { KeyMaterial, OperatorGateway } from "./gateway.js";
import { agentItem, dbId, eventItem, statusBody, untrusted, type RuntimeFlagsView } from "./responses.js";
import { redactDetail, redactText } from "../redact.js";

export const OPERATOR_SCHEMA_VERSION = 8;

export interface OperatorLimits {
  perPrincipal: RateLimit;
  /**
   * Database lookups for principal/key pairs never seen valid by this process.
   * Global (all clients share one loopback peer behind the SSH tunnel), so it
   * only throttles junk identities: pairs already known valid bypass it and
   * cannot be locked out by someone else's failures.
   */
  unknownKeyLookups: RateLimit;
  /** Denied-request audit records; beyond this they are counted and summarised. */
  deniedAudit: RateLimit;
  maxConcurrent: number;
  keyCacheMs: number;
  pollMs: number;
  maxResponseBytes: number;
}

export const DEFAULT_OPERATOR_LIMITS: OperatorLimits = Object.freeze({
  perPrincipal: { capacity: 30, refillPerSec: 1 },
  unknownKeyLookups: { capacity: 20, refillPerSec: 20 / 60 },
  deniedAudit: { capacity: 120, refillPerSec: 2 },
  maxConcurrent: 16,
  keyCacheMs: 30_000,
  pollMs: 5_000,
  maxResponseBytes: 256 * 1024,
});

export interface OperatorAuditEntry {
  ts: string;
  event: string;
  agentId: string | null;
  detail: Record<string, unknown>;
}

export interface OperatorServiceOptions {
  gateway: OperatorGateway;
  /** Audit sink (operator JSONL + journald via createAuditSink). */
  audit?: (entry: OperatorAuditEntry) => void;
  now?: () => number;
  /** Safety flags as read by this process from runtime.env. */
  runtimeFlags?: () => RuntimeFlagsView;
  /** Extra readiness checks (privilege audit, clock). */
  readinessChecks?: () => Promise<Record<string, { ok: boolean; warn?: boolean }>>;
  limits?: Partial<OperatorLimits>;
}

const STATUS_OF: Record<string, number> = {
  FLEET_OP_BAD_REQUEST: 400,
  FLEET_OP_NONCANONICAL: 400,
  FLEET_OP_BAD_PARAM: 400,
  FLEET_OP_STALE: 401,
  FLEET_OP_AUTH_FAILED: 401,
  FLEET_OP_SCOPE_DENIED: 403,
  FLEET_OP_NOT_FOUND: 404,
  FLEET_OP_REPLAYED: 409,
  FLEET_OP_RATE_LIMITED: 429,
  FLEET_OP_INTERNAL: 500,
  FLEET_OP_DISABLED: 503,
  FLEET_OP_AUDIT_FULL: 503,
};

class OpFailure extends Error {
  constructor(
    readonly code: OpErrorCode,
    /** Audit-only reason (never sent to the client). */
    readonly reason: string,
  ) {
    super(code);
  }
}

/** No flag source: report unknown, never "off". */
const NO_FLAGS: RuntimeFlagsView = { realReplicationEnabled: null, realPaymentsEnabled: null, ownerSweepEnabled: null, dryRunChildEnabled: null };

const LOOPBACK_HOST_HEADER = /^(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?$/;

type ReadinessResult = { ready: boolean; state: string; checks: Record<string, { ok: boolean; warn?: boolean }> };

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function emptyBody(req: http.IncomingMessage): Promise<boolean> {
  return new Promise((resolve) => {
    let got = false;
    req.on("data", () => {
      got = true;
    });
    req.on("end", () => resolve(!got));
    req.on("error", () => resolve(false));
  });
}

export class OperatorService {
  private readonly limits: OperatorLimits;
  private readonly now: () => number;
  private readonly perPrincipal: RateLimiter;
  private readonly unknownLookups: RateLimiter;
  private readonly deniedAudit: RateLimiter;
  private suppressedDenials = 0;
  /** Pairs that resolved to a valid key at least once (revocation is still enforced by the database per request). */
  private readonly knownPairs = new Set<string>();
  private readyCache: { at: number; value: Promise<ReadinessResult> } | null = null;
  private readonly keyCache = new Map<string, { at: number; km: KeyMaterial; pub: KeyObject }>();
  private server: http.Server | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private inflight = 0;
  private generation: number | null = null;
  private enabled = false;
  private dbOk = false;
  private schemaVersion: number | null = null;

  constructor(private readonly opts: OperatorServiceOptions) {
    const problems = verifyRoutePolicy();
    if (problems.length) throw new Error(`Operator route policy violates the read-only invariant: ${problems.join("; ")}`);
    this.limits = { ...DEFAULT_OPERATOR_LIMITS, ...(opts.limits ?? {}) };
    this.now = opts.now ?? Date.now;
    this.perPrincipal = new RateLimiter(this.limits.perPrincipal, this.now);
    this.unknownLookups = new RateLimiter(this.limits.unknownKeyLookups, this.now);
    this.deniedAudit = new RateLimiter(this.limits.deniedAudit, this.now);
  }

  /** Poll the kill switch / generation; drops the key cache when the generation changes. */
  async refresh(): Promise<void> {
    await this.poll();
    this.readyCache = null;
  }

  private async poll(): Promise<void> {
    try {
      const p = await this.opts.gateway.ping();
      if (this.generation !== p.generation) this.keyCache.clear();
      this.generation = p.generation;
      this.enabled = p.operatorApiEnabled === true;
      this.schemaVersion = p.schemaVersion;
      this.dbOk = true;
    } catch {
      this.dbOk = false;
    }
  }

  async listen(port: number, host = "127.0.0.1"): Promise<{ url: string; port: number }> {
    if (!isLoopbackHost(host)) throw new Error(`Operator API listens on loopback only (refusing ${host})`);
    await this.refresh();
    const server = http.createServer(
      { maxHeaderSize: OP_LIMITS.maxHeaderBytes, requestTimeout: 10_000, headersTimeout: 5_000, keepAliveTimeout: 5_000 },
      (req, res) => void this.handle(req, res),
    );
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
    this.pollTimer = setInterval(() => void this.refresh(), this.limits.pollMs);
    this.pollTimer.unref();
    const addr = server.address() as { port: number };
    return { url: `http://${host.includes(":") ? `[${host}]` : host}:${addr.port}`, port: addr.port };
  }

  async close(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private auditDenied(detail: Record<string, unknown>): void {
    if (!this.deniedAudit.take("all")) {
      this.suppressedDenials++;
      return;
    }
    if (this.suppressedDenials > 0) {
      this.audit("operator_request_denied_suppressed", { count: this.suppressedDenials });
      this.suppressedDenials = 0;
    }
    this.audit("operator_request_denied", detail);
  }

  private audit(event: string, detail: Record<string, unknown>): void {
    try {
      this.opts.audit?.({ ts: new Date(this.now()).toISOString(), event, agentId: null, detail: redactDetail(detail) });
    } catch {
      // audit sink failures must not break request handling
    }
  }

  /**
   * Readiness, computed at most once per poll interval and shared by
   * concurrent callers, so unauthenticated /readyz traffic cannot multiply
   * database work.
   */
  private readiness(): Promise<ReadinessResult> {
    const c = this.readyCache;
    if (c && this.now() - c.at < this.limits.pollMs) return c.value;
    const value = this.computeReadiness();
    this.readyCache = { at: this.now(), value };
    return value;
  }

  private async computeReadiness(): Promise<ReadinessResult> {
    await this.poll();
    const checks: Record<string, { ok: boolean; warn?: boolean }> = {
      database: { ok: this.dbOk },
      schema: { ok: this.schemaVersion === OPERATOR_SCHEMA_VERSION },
      killSwitch: { ok: this.enabled, warn: !this.enabled },
    };
    try {
      Object.assign(checks, (await this.opts.readinessChecks?.()) ?? {});
    } catch {
      checks.readinessChecks = { ok: false };
    }
    const allOk = Object.entries(checks).every(([k, c]) => c.ok || k === "killSwitch");
    const ready = allOk && this.enabled;
    return { ready, state: ready ? "ready" : allOk ? "disabled" : "not_ready", checks };
  }

  private async keyMaterial(principal: string, key: string): Promise<{ km: KeyMaterial; pub: KeyObject } | null> {
    const ck = `${principal}|${key}`;
    const hit = this.keyCache.get(ck);
    if (hit && this.now() - hit.at < this.limits.keyCacheMs) return hit;
    const known = this.knownPairs.has(ck);
    if (!known && this.unknownLookups.retryAfterS("all") > 0) throw new OpFailure("FLEET_OP_RATE_LIMITED", "unknown key lookups");
    const km = await this.opts.gateway.keyMaterial(principal, key);
    if (!km.ok || typeof km.publicKey !== "string") {
      if (!known) this.unknownLookups.take("all");
      return null;
    }
    const raw = Buffer.from(km.publicKey, "base64");
    if (raw.length !== 32) return null;
    const entry = { at: this.now(), km, pub: publicKeyFromRaw(raw) };
    this.keyCache.set(ck, entry);
    if (this.knownPairs.size < 1000) this.knownPairs.add(ck);
    return entry;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const started = this.now();
    const requestId = crypto.randomUUID();
    const peer = req.socket.remoteAddress ?? "unknown";
    const raw = req.url ?? "";
    let status = 500;
    let code: string | undefined;
    let reason: string | undefined;
    let routeKey = "unknown";
    let principal = "none";
    let items: number | undefined;
    let counted = false;

    const send = (st: number, body: Record<string, unknown>) => {
      status = st;
      const text = JSON.stringify(body);
      res.writeHead(st, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-request-id": requestId,
        "content-length": Buffer.byteLength(text),
      });
      res.end(text);
    };

    if ((raw === "/healthz" || raw === "/readyz") && !LOOPBACK_HOST_HEADER.test(req.headers.host ?? "")) {
      // DNS-rebinding guard for the unauthenticated endpoints.
      send(421, { ok: false, code: "FLEET_OP_BAD_REQUEST" });
      return;
    }
    if (req.method === "GET" && raw === "/healthz") {
      send(200, { ok: true, status: "alive" });
      return;
    }
    if (req.method === "GET" && raw === "/readyz") {
      const r = await this.readiness();
      send(r.ready ? 200 : 503, r);
      return;
    }

    try {
      if (this.inflight >= this.limits.maxConcurrent) throw new OpFailure("FLEET_OP_RATE_LIMITED", "concurrency");
      this.inflight++;
      counted = true;

      const target = parseTarget(raw);
      if (!target.ok) {
        const underOperator = raw.startsWith("/v1/operator/");
        throw new OpFailure(underOperator ? target.code : "FLEET_OP_NOT_FOUND", "target");
      }
      const match = matchRoute(req.method ?? "", target.path);
      if (!match) throw new OpFailure("FLEET_OP_NOT_FOUND", "route");
      routeKey = match.key;

      const h = readOpHeaders(req.headersDistinct as Record<string, string[] | undefined>);
      if (!h.ok) throw new OpFailure("FLEET_OP_BAD_REQUEST", "headers");
      if (PRINCIPAL_RE.test(h.values.principal)) principal = h.values.principal;
      const cl = req.headers["content-length"];
      if ((cl !== undefined && cl !== "0") || req.headers["transfer-encoding"] !== undefined) throw new OpFailure("FLEET_OP_BAD_REQUEST", "body");
      if (!(await emptyBody(req))) throw new OpFailure("FLEET_OP_BAD_REQUEST", "body");
      for (const [k, v] of Object.entries(target.params)) {
        const re = match.route.params[k];
        if (!re || !re.test(v)) throw new OpFailure("FLEET_OP_BAD_PARAM", "param");
      }

      const authFail = (c: OpErrorCode, why: string): never => {
        throw new OpFailure(c, why);
      };
      const ts = Number(h.values.timestamp);
      if (Math.abs(this.now() - ts) > OP_LIMITS.skewMs) authFail("FLEET_OP_STALE", "clock window");
      const key = await this.keyMaterial(h.values.principal, h.values.key);
      if (!key) authFail("FLEET_OP_AUTH_FAILED", "unknown/revoked/expired principal or key");
      if (!match.route.kinds.includes(key!.km.kind as never)) authFail("FLEET_OP_AUTH_FAILED", "principal kind not allowed for route");
      const sig = decodeSignature(h.values.signature);
      const canonical = canonicalString({
        principal: h.values.principal,
        key: h.values.key,
        method: req.method ?? "",
        path: target.path,
        query: target.query,
        timestamp: h.values.timestamp,
        nonce: h.values.nonce,
        bodySha256: EMPTY_BODY_SHA256,
      });
      if (!sig || !verifySignature(key!.pub, canonical, sig)) authFail("FLEET_OP_AUTH_FAILED", "signature");
      if (match.route.scope !== null && !(key!.km.scopes ?? []).includes(match.route.scope)) throw new OpFailure("FLEET_OP_SCOPE_DENIED", "scope");
      if (!this.perPrincipal.take(h.values.principal)) throw new OpFailure("FLEET_OP_RATE_LIMITED", "principal rate");

      const begun = await this.opts.gateway.beginRequest({
        principal: h.values.principal,
        key: h.values.key,
        route: match.key,
        clientTsMs: ts,
        nonce: h.values.nonce,
        bodySha256: EMPTY_BODY_SHA256,
      });
      if (!begun.ok) {
        const c = (Object.prototype.hasOwnProperty.call(STATUS_OF, begun.code) ? begun.code : "FLEET_OP_INTERNAL") as OpErrorCode;
        throw new OpFailure(c, "database");
      }
      if (begun.fn !== match.route.fn) throw new OpFailure("FLEET_OP_INTERNAL", "route/function mismatch between process and database");

      const data = await this.dispatch(match, target.params, begun.requestId);
      if (data === null) throw new OpFailure("FLEET_OP_NOT_FOUND", "agent not found");
      items = Array.isArray((data as { items?: unknown[] }).items) ? (data as { items: unknown[] }).items.length : undefined;
      send(200, { ok: true, requestId, serverTime: new Date(this.now()).toISOString(), data });
    } catch (err) {
      if (err instanceof OpFailure) {
        code = err.code;
        reason = err.reason;
      } else {
        code = "FLEET_OP_INTERNAL";
        reason = redactText(err instanceof Error ? err.message : String(err));
      }
      if (!res.headersSent) send(STATUS_OF[code] ?? 500, { ok: false, requestId, code });
    } finally {
      if (counted) this.inflight--;
      (status < 400 ? (d: Record<string, unknown>) => this.audit("operator_request", d) : (d: Record<string, unknown>) => this.auditDenied(d))({
        requestId,
        principal,
        route: routeKey,
        status,
        ...(code ? { code, reason } : {}),
        ...(items !== undefined ? { items } : {}),
        ms: this.now() - started,
        peer: peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1" ? "loopback" : "other",
      });
    }
  }

  private async dispatch(match: RouteMatch, params: Record<string, string>, requestId: string): Promise<Record<string, unknown> | null> {
    const g = this.opts.gateway;
    switch (match.route.fn) {
      case "op_whoami": {
        const w = await g.whoami(requestId);
        const p = (w.principal ?? {}) as Record<string, unknown>;
        const k = (w.key ?? {}) as Record<string, unknown>;
        return {
          principal: {
            id: typeof p.id === "string" && PRINCIPAL_RE.test(p.id) ? p.id : null,
            name: typeof p.name === "string" && /^[a-z][a-z0-9-]{2,40}$/.test(p.name) ? p.name : null,
            kind: p.kind === "bridge_claude" || p.kind === "bridge_chatgpt" ? p.kind : "unknown",
            scopes: Array.isArray(p.scopes) ? p.scopes.filter((s) => s === "ops.read.status" || s === "ops.read.agents" || s === "ops.read.events") : [],
          },
          key: {
            id: typeof k.id === "string" && /^[0-9a-f]{32}$/.test(k.id) ? k.id : null,
            expiresAt: typeof k.expiresAt === "string" ? new Date(k.expiresAt).toISOString() : null,
          },
        };
      }
      case "op_fleet_status": {
        const db = await g.fleetStatus(requestId);
        const r = await this.readiness();
        return statusBody(db, this.opts.runtimeFlags?.() ?? NO_FLAGS, { ready: r.ready, checks: r.checks });
      }
      case "op_list_agents": {
        const limit = params.limit ? Number(params.limit) : 50;
        const r = await g.listAgents(requestId, params.after ? dbId(params.after) : null, limit);
        return this.page(r.items, limit, (a) => agentItem(a), (it) => (it.agentId as string | null) ?? null);
      }
      case "op_get_agent": {
        const r = await g.getAgent(requestId, dbId(match.pathParams.agent_id));
        return r.found && r.item ? { item: agentItem(r.item) } : null;
      }
      case "op_list_events": {
        const limit = params.limit ? Number(params.limit) : 50;
        const r = await g.listEvents(requestId, params.after ?? null, limit, params.type ?? null);
        return this.page(r.items, limit, (e) => eventItem(e), (it) => (it.id as string | null) ?? null);
      }
      default:
        throw new OpFailure("FLEET_OP_INTERNAL", `unmapped function ${untrusted(match.route.fn).value}`);
    }
  }

  /** Keyset page bounded by `limit` and by maxResponseBytes (never truncates an item). */
  private page(
    rawItems: Record<string, unknown>[],
    limit: number,
    build: (x: Record<string, unknown>) => Record<string, unknown>,
    cursorOf: (it: Record<string, unknown>) => string | null,
  ): Record<string, unknown> {
    const out: Record<string, unknown>[] = [];
    let bytes = 256;
    let more = rawItems.length > limit;
    for (const raw of rawItems.slice(0, limit)) {
      const it = build(raw);
      const size = Buffer.byteLength(JSON.stringify(it));
      if (bytes + size > this.limits.maxResponseBytes) {
        more = true;
        break;
      }
      bytes += size + 1;
      out.push(it);
    }
    const last = out[out.length - 1];
    return { items: out, next: more && last ? { after: cursorOf(last) } : null };
  }
}
