/**
 * Fleet Service (Phase 3)
 *
 * The only process that holds fleet database credentials. Agents talk to it
 * over HTTP with their own bearer token (fa1.<agentId>.<secret>); they never
 * receive DATABASE_URL or any controller secret.
 *
 *   agent ──HTTP(token)──► FleetService ──restricted role──► api_* functions
 *                                       └─admin role──────► claim / activate (attestation) / reaper
 *
 * Agent-scoped operations (heartbeat, state, replication request, release,
 * own status) run through PgAgentGateway, i.e. as the restricted role.
 * Controller operations that need more than the restricted API (claiming a
 * lease, verifying a child's attestation and activating it, recording a
 * verification failure) first authenticate the caller through the
 * restricted role, then run on the admin store with the caller pinned as
 * the reservation's required parent.
 *
 * The background reaper runs here (fleet_reap is idempotent; several
 * service instances may run it concurrently), followed by the sandbox
 * termination queue.
 *
 * Phase 4: the controller store connects as the restricted service role
 * (svc_* functions only), the service pins one runtime release and refuses
 * leases that expect another, exposes /healthz and /readyz for local
 * monitoring, and drains in-flight requests on shutdown.
 */

import crypto from "crypto";
import http from "http";
import https from "https";
import type { AddressInfo } from "net";
import { ulid } from "ulid";
import { FleetBypassError } from "../registry.js";
import { FleetRuntimeError, sameRelease, type RuntimeRelease } from "../runtime.js";
import { sanitizeAttestation } from "../attestation.js";
import {
  FleetDuplicateRegistrationError,
  FleetRegistryUnavailableError,
  agentIdFromSessionToken,
  agentIdFromToken,
  hashAgentToken,
  mintSessionToken,
  type PgFleetStore,
} from "../postgres/store.js";
import type { PgAgentGateway } from "../postgres/agent-gateway.js";
import { UnsupportedSandboxTerminator, type SandboxTerminator } from "./terminator.js";
import { RateLimiter, type RateLimit } from "./rate-limit.js";

export { SIG_HEADERS, canonicalRequest, signRequest } from "./server-signing.js";
import { SIG_HEADERS, signRequest } from "./server-signing.js";

interface RequestCtx {
  raw: Buffer;
  ip: string;
  requestId: string;
  agentId: string | null;
  status: number;
}

export interface AuditEntry {
  ts: string;
  event: string;
  agentId?: string | null;
  detail?: Record<string, unknown>;
}

export interface FleetServiceOptions {
  admin: PgFleetStore;
  agent: PgAgentGateway;
  /** Service-level REAL_REPLICATION_ENABLED; false rejects every replication request. */
  realReplicationEnabled: boolean;
  /** Reaper period; 0 disables the background reaper. Default 15 s. */
  reaperIntervalMs?: number;
  audit?: (entry: AuditEntry) => void;
  maxBodyBytes?: number;
  /**
   * The runtime release this service instance runs. Claims and activations
   * of leases expecting any other runtime are refused; null refuses them all.
   */
  release: RuntimeRelease | null;
  /** Controller-side sandbox termination (default: unsupported — see terminator.ts). */
  terminator?: SandboxTerminator;
  /** Max time close() waits for in-flight requests. Default 10 s. */
  drainMs?: number;
  /** Extra readiness checks (e.g. cached privilege audit). */
  readinessChecks?: () => Promise<Record<string, ReadinessCheck>>;
  /**
   * Accept the long-lived fa1 credential as a bearer on every endpoint
   * (Phase 3 behaviour). Default false: the long-lived credential is only
   * accepted by POST /v1/session; every other request needs a short-lived
   * session and a signed, single-use request.
   */
  allowLegacyBearer?: boolean;
  /** Max clock skew for signed requests (default 60 s). */
  maxSkewMs?: number;
  rateLimits?: { perAgent?: RateLimit; sessions?: RateLimit; authFailuresPerIp?: RateLimit };
  /** TLS material; when set, listen() serves HTTPS. */
  tls?: { cert: string | Buffer; key: string | Buffer };
  now?: () => number;
}

export interface ReadinessCheck {
  ok: boolean;
  /** Non-fatal: reported, but does not make the service unready. */
  warn?: boolean;
  detail?: string;
}

export interface Readiness {
  ready: boolean;
  draining: boolean;
  realReplicationEnabled: boolean;
  checks: Record<string, ReadinessCheck>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function str(body: Record<string, unknown>, key: string, max: number, required = true): string {
  const v = body[key];
  if (typeof v !== "string" || v.length === 0 || v.length > max) {
    if (!required && v === undefined) return "";
    throw new HttpError(400, "FLEET_BAD_REQUEST", `${key} must be a string of 1..${max} characters`);
  }
  return v;
}

function isPgPermissionError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "42501" || code === "42883"; // insufficient_privilege / undefined_function (no EXECUTE path)
}

export class FleetService {
  private server: http.Server | null = null;
  private reaperTimer: ReturnType<typeof setInterval> | null = null;
  private reaping: Promise<void> | null = null;
  private lastReapOkAt: number | null = null;
  private lastReapError: string | null = null;
  private inFlight = 0;
  private draining = false;
  private readonly startedAt = Date.now();
  private readonly terminator: SandboxTerminator;
  private readonly perAgent: RateLimiter;
  private readonly sessions: RateLimiter;
  private readonly authFailures: RateLimiter;
  private readonly now: () => number;

  constructor(private readonly opts: FleetServiceOptions) {
    this.terminator = opts.terminator ?? new UnsupportedSandboxTerminator();
    this.now = opts.now ?? Date.now;
    this.perAgent = new RateLimiter(opts.rateLimits?.perAgent ?? { capacity: 60, refillPerSec: 5 }, this.now);
    this.sessions = new RateLimiter(opts.rateLimits?.sessions ?? { capacity: 10, refillPerSec: 10 / 60 }, this.now);
    this.authFailures = new RateLimiter(opts.rateLimits?.authFailuresPerIp ?? { capacity: 20, refillPerSec: 20 / 60 }, this.now);
  }

  private audit(event: string, agentId: string | null, detail: Record<string, unknown> = {}): void {
    try {
      this.opts.audit?.({ ts: new Date().toISOString(), event, agentId, detail });
    } catch {
      // audit sink failures must not break request handling
    }
  }

  /** Durable audit (fleet_events) + service log. Never throws. */
  private async recordDb(event: string, agentId: string | null, detail: Record<string, unknown>): Promise<void> {
    this.audit(event, agentId, detail);
    await this.opts.admin.recordEvent(event, agentId, "fleet-service", detail).catch(() => {});
  }

  // ─── Reaper ─────────────────────────────────────────────────────

  async reapOnce(): Promise<void> {
    if (this.reaping) return this.reaping;
    this.reaping = (async () => {
      try {
        const r = await this.opts.admin.reap("reaper");
        if (r.expired || r.unresponsive || r.dead) this.audit("reaper_pass", null, { ...r });
        await this.processTerminations();
        this.lastReapOkAt = Date.now();
        this.lastReapError = null;
      } catch (err) {
        this.lastReapError = err instanceof Error ? err.message : String(err);
        this.audit("reaper_error", null, { error: this.lastReapError });
      } finally {
        this.reaping = null;
      }
    })();
    return this.reaping;
  }

  /** Work the sandbox termination queue. Unsupported terminations stay recorded as zombies. */
  async processTerminations(): Promise<void> {
    const due = await this.opts.admin.terminationsDue(20);
    for (const t of due) {
      let status: "terminated" | "unsupported" | "failed";
      let error: string | null = null;
      try {
        const out = await this.terminator.terminate(t.sandboxId);
        status = out.status;
        if (out.status === "unsupported") error = out.reason;
      } catch (err) {
        status = "failed";
        error = err instanceof Error ? err.message : String(err);
      }
      await this.opts.admin.recordTerminationResult(t.agentId, status, error, "fleet-service");
      this.audit(`sandbox_termination_${status}`, t.agentId, { sandboxId: t.sandboxId, terminator: this.terminator.name, error });
    }
  }

  startReaper(): void {
    const every = this.opts.reaperIntervalMs ?? 15_000;
    if (this.reaperTimer || every <= 0) return;
    void this.reapOnce();
    this.reaperTimer = setInterval(() => void this.reapOnce(), every);
    this.reaperTimer.unref?.();
  }

  stopReaper(): void {
    if (this.reaperTimer) clearInterval(this.reaperTimer);
    this.reaperTimer = null;
  }

  // ─── HTTP ───────────────────────────────────────────────────────

  async listen(port = 0, host = "127.0.0.1"): Promise<{ host: string; port: number; url: string }> {
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => void this.handle(req, res);
    this.server = this.opts.tls
      ? https.createServer({ cert: this.opts.tls.cert, key: this.opts.tls.key, minVersion: "TLSv1.2" }, handler)
      : http.createServer(handler);
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => resolve());
    });
    const addr = this.server.address() as AddressInfo;
    const h = addr.family === "IPv6" ? `[${addr.address}]` : addr.address;
    return { host: addr.address, port: addr.port, url: `${this.opts.tls ? "https" : "http"}://${h}:${addr.port}` };
  }

  /**
   * Graceful shutdown: stop accepting connections, refuse new requests with
   * 503, wait (up to drainMs) for in-flight requests and any running reaper
   * pass, then drop remaining connections.
   */
  async close(): Promise<void> {
    this.draining = true;
    this.stopReaper();
    const s = this.server;
    this.server = null;
    if (!s) return;
    const closed = new Promise<void>((r) => s.close(() => r()));
    s.closeIdleConnections?.();
    const deadline = Date.now() + (this.opts.drainMs ?? 10_000);
    while ((this.inFlight > 0 || this.reaping) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    s.closeAllConnections?.();
    await closed;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  /** Liveness + readiness for local monitoring (GET /healthz, GET /readyz). */
  async readiness(): Promise<Readiness> {
    const checks: Record<string, ReadinessCheck> = {};
    const h = await this.opts.admin.health().catch((err) => ({ ok: false, error: String(err), schemaVersion: null }));
    checks.database = { ok: h.ok, detail: h.ok ? `schema v${h.schemaVersion}` : (h as { error?: string }).error ?? "unhealthy" };
    let state: Awaited<ReturnType<PgAgentGateway["fleetState"]>> | null = null;
    try {
      state = await this.opts.agent.fleetState();
      checks.agentApi = { ok: true };
    } catch (err) {
      checks.agentApi = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
    const rel = this.opts.release;
    const approved = state?.runtime && state.build ? { ...state.runtime, ...state.build } : null;
    if (!state) checks.runtimeRelease = { ok: false, detail: "fleet state unavailable" };
    else if (!rel && !approved) checks.runtimeRelease = { ok: true, warn: true, detail: "no runtime release pinned and none approved (replication impossible)" };
    else if (!rel) checks.runtimeRelease = { ok: false, detail: "registry approves a runtime but this service has no pinned release" };
    else if (!approved) checks.runtimeRelease = { ok: true, warn: true, detail: `release ${rel.commit} pinned; registry has no approved runtime` };
    else checks.runtimeRelease = sameRelease(rel, approved)
      ? { ok: true, detail: `${rel.repo}@${rel.commit}` }
      : { ok: false, detail: `service release ${rel.commit}/${rel.buildId.slice(0, 12)} != approved ${approved.commit}/${approved.buildId.slice(0, 12)}` };
    const every = this.opts.reaperIntervalMs ?? 15_000;
    if (every <= 0) checks.reaper = { ok: true, warn: true, detail: "background reaper disabled" };
    else {
      const age = this.lastReapOkAt === null ? null : Date.now() - this.lastReapOkAt;
      const ok = age !== null && age <= Math.max(3 * every, 60_000);
      checks.reaper = { ok, detail: ok ? `last pass ${Math.round(age! / 1000)} s ago` : this.lastReapError ?? "no successful reaper pass yet" };
    }
    checks.sandboxTermination = this.terminator.guaranteed
      ? { ok: true, detail: this.terminator.name }
      : { ok: true, warn: true, detail: "sandbox termination is not supported; dead agents' sandboxes may keep running" };
    if (this.opts.readinessChecks) Object.assign(checks, await this.opts.readinessChecks().catch((err) => ({ extra: { ok: false, detail: String(err) } })));
    const ready = !this.draining && Object.values(checks).every((c) => c.ok);
    return { ready, draining: this.draining, realReplicationEnabled: this.opts.realReplicationEnabled, checks };
  }

  /** Refuse leases that expect a runtime other than this service's release; the slot is released as failed. */
  private async enforceRelease(lease: { agentId: string; reservationId: string; expected: { repo: string; commit: string; buildId: string; lockfileSha256: string } }, callerId: string): Promise<void> {
    if (sameRelease(this.opts.release, lease.expected)) return;
    const reason = this.opts.release
      ? `lease expects ${lease.expected.commit}/${lease.expected.buildId.slice(0, 12)}, service release is ${this.opts.release.commit}/${this.opts.release.buildId.slice(0, 12)}`
      : "fleet service has no pinned runtime release";
    await this.opts.admin.recordVerificationFailure(lease.agentId, `runtime release mismatch: ${reason}`, callerId).catch(() => {});
    await this.recordDb("runtime_release_mismatch", lease.agentId, { reservationId: lease.reservationId, reason });
    throw new HttpError(409, "FLEET_RUNTIME_UNVERIFIED", `Runtime release mismatch: ${reason}`);
  }

  private async readRaw(req: http.IncomingMessage): Promise<Buffer> {
    const max = this.opts.maxBodyBytes ?? 64 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > max) throw new HttpError(413, "FLEET_BAD_REQUEST", "request body too large");
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  private parseBody(raw: Buffer): Record<string, unknown> {
    if (raw.length === 0) return {};
    try {
      const v = JSON.parse(raw.toString("utf8"));
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
      return v as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "FLEET_BAD_REQUEST", "body must be a JSON object");
    }
  }

  private send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      ...headers,
      "content-type": "application/json",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(data),
    });
    res.end(data);
  }

  private async authFailure(ctx: RequestCtx, path: string, why: string, code = "FLEET_AUTH_FAILED", status = 401): Promise<never> {
    await this.recordDb("api_auth_failed", null, { path, why, ip: ctx.ip });
    if (!this.authFailures.take(ctx.ip)) {
      throw new HttpError(429, "FLEET_RATE_LIMITED", "too many failed authentications");
    }
    throw new HttpError(status, code, why);
  }

  private rateLimit(limiter: RateLimiter, key: string): void {
    if (!limiter.take(key)) {
      this.audit("rate_limited", key.startsWith("ip:") ? null : key, { key });
      throw Object.assign(new HttpError(429, "FLEET_RATE_LIMITED", "rate limit exceeded"), { retryAfter: limiter.retryAfterS(key) });
    }
  }

  /** Long-lived fa1 bearer. Only POST /v1/session accepts it (unless allowLegacyBearer). */
  private async bearer(req: http.IncomingMessage, path: string, ctx: RequestCtx): Promise<{ agentId: string; token: string }> {
    const h = req.headers.authorization ?? "";
    const m = /^Bearer (\S{1,256})$/.exec(h);
    const agentId = m ? agentIdFromToken(m[1]) : null;
    if (!m || !agentId) return this.authFailure(ctx, path, m ? "malformed token" : "missing bearer token");
    ctx.agentId = agentId;
    return { agentId, token: m[1] };
  }

  /**
   * Agent identity of a request. Required (default): a short-lived session
   * token (FleetSession fs1.…) scoped to one agent, plus a signed request:
   * timestamp within the skew window, single-use nonce (shared DB ledger, so
   * replays are refused across instances and restarts) and an HMAC over
   * method, path, timestamp, nonce and body. The database then checks the
   * session itself (unexpired, unrevoked, agent living, credential valid).
   */
  private async credentials(req: http.IncomingMessage, path: string, ctx: RequestCtx): Promise<{ agentId: string; token: string }> {
    const h = req.headers.authorization ?? "";
    const m = /^FleetSession (\S{1,256})$/.exec(h);
    if (!m) {
      if (/^Bearer /.test(h) && this.opts.allowLegacyBearer) {
        const cred = await this.bearer(req, path, ctx);
        this.rateLimit(this.perAgent, cred.agentId);
        return cred;
      }
      return this.authFailure(ctx, path, /^Bearer /.test(h) ? "session required (long-lived credential only opens sessions)" : "missing session", "FLEET_SESSION_REQUIRED");
    }
    const token = m[1];
    const agentId = agentIdFromSessionToken(token);
    if (!agentId) return this.authFailure(ctx, path, "malformed session token");
    ctx.agentId = agentId;
    this.rateLimit(this.perAgent, agentId);
    const ts = String(req.headers[SIG_HEADERS.ts] ?? "");
    const nonce = String(req.headers[SIG_HEADERS.nonce] ?? "");
    const sig = String(req.headers[SIG_HEADERS.sig] ?? "");
    const skew = this.opts.maxSkewMs ?? 60_000;
    if (!/^\d{10,16}$/.test(ts) || Math.abs(this.now() - Number(ts)) > skew) {
      return this.authFailure(ctx, path, "request timestamp outside the allowed window", "FLEET_REQUEST_STALE");
    }
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) return this.authFailure(ctx, path, "missing request signature");
    const expected = signRequest(token, req.method ?? "GET", path, ts, nonce, ctx.raw);
    if (!crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"))) {
      return this.authFailure(ctx, path, "bad request signature");
    }
    if (!(await this.opts.admin.consumeNonce(agentId, nonce, Math.ceil((2 * skew) / 1000)))) {
      await this.recordDb("request_replay_blocked", agentId, { path, ip: ctx.ip });
      throw new HttpError(409, "FLEET_REQUEST_REPLAYED", "request nonce already used");
    }
    return { agentId, token };
  }

  /** Full authentication through the restricted role; the agent must be living (not quarantined). */
  private async authenticate(req: http.IncomingMessage, path: string, ctx: RequestCtx, allowDead = false) {
    const cred = await this.credentials(req, path, ctx);
    const who = await this.opts.agent.whoami(cred.agentId, cred.token);
    if (!who.ok) {
      const gone = who.code === "FLEET_AGENT_DEAD" || who.code === "FLEET_AGENT_QUARANTINED";
      if (gone && allowDead && "agent" in who) return { ...cred, agent: who.agent as never, dead: true };
      if (!gone) this.audit("api_auth_failed", null, { path, code: who.code });
      throw new HttpError(gone ? 410 : 401, who.code, "agent credential rejected");
    }
    return { ...cred, agent: who.agent, dead: false };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/healthz") {
      this.send(res, this.draining ? 503 : 200, {
        ok: !this.draining,
        status: this.draining ? "draining" : "alive",
        uptimeS: Math.round((Date.now() - this.startedAt) / 1000),
      });
      return;
    }
    if (this.draining) {
      res.setHeader("connection", "close");
      this.send(res, 503, { ok: false, code: "FLEET_SERVICE_DRAINING", reason: "fleet service is shutting down" });
      return;
    }
    this.inFlight++;
    try {
      await this.handleInner(req, res, path);
    } finally {
      this.inFlight--;
    }
  }

  private async handleInner(req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<void> {
    if (req.method === "GET" && path === "/readyz") {
      const r = await this.readiness();
      this.send(res, r.ready ? 200 : 503, { ok: r.ready, ...r });
      return;
    }
    const started = this.now();
    const ctx: RequestCtx = { raw: Buffer.alloc(0), ip: req.socket.remoteAddress ?? "unknown", requestId: crypto.randomUUID(), agentId: null, status: 200 };
    const send = (status: number, body: unknown, headers?: Record<string, string>) => {
      ctx.status = status;
      this.send(res, status, body, { "x-request-id": ctx.requestId, ...headers });
    };
    try {
      ctx.raw = await this.readRaw(req);
      const out = await this.route(req.method ?? "GET", path, req, ctx);
      send(200, { ok: true, ...out });
    } catch (err) {
      await this.sendError(err, path, send);
    } finally {
      // Request audit log (every API request; no bodies, no tokens).
      this.audit("api_request", ctx.agentId, {
        requestId: ctx.requestId,
        method: req.method,
        path,
        status: ctx.status,
        ms: this.now() - started,
        ip: ctx.ip,
      });
    }
  }

  private async sendError(err: unknown, path: string, send: (status: number, body: unknown, headers?: Record<string, string>) => void): Promise<void> {
    {
      if (err instanceof HttpError) {
        const retry = (err as HttpError & { retryAfter?: number }).retryAfter;
        send(err.status, { ok: false, code: err.code, reason: err.message }, retry ? { "retry-after": String(retry) } : undefined);
      } else if (err instanceof FleetRuntimeError) {
        send(409, { ok: false, code: "FLEET_RUNTIME_UNVERIFIED", reason: err.message });
      } else if (err instanceof FleetBypassError) {
        send(403, { ok: false, code: "FLEET_NOT_AUTHORIZED", reason: err.message });
      } else if (err instanceof FleetDuplicateRegistrationError) {
        send(409, { ok: false, code: "FLEET_DUPLICATE_REGISTRATION", reason: err.message });
      } else if (err instanceof FleetRegistryUnavailableError) {
        send(503, { ok: false, code: "FLEET_REGISTRY_UNAVAILABLE", reason: "registry unavailable" });
      } else if (isPgPermissionError(err)) {
        await this.recordDb("db_authorization_failed", null, { path, pgCode: (err as { code?: string }).code, message: (err as Error).message });
        send(500, { ok: false, code: "FLEET_DB_AUTHORIZATION_FAILED", reason: "database refused the operation" });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        this.audit("api_error", null, { path, error: msg });
        const unavailable = /ECONNREFUSED|timeout|terminated|connect/i.test(msg);
        send(unavailable ? 503 : 400, {
          ok: false,
          code: unavailable ? "FLEET_REGISTRY_UNAVAILABLE" : "FLEET_REQUEST_FAILED",
          reason: unavailable ? "registry unavailable" : msg.slice(0, 300),
        });
      }
    }
  }

  private async route(method: string, path: string, req: http.IncomingMessage, ctx: RequestCtx): Promise<Record<string, unknown>> {
    const { admin, agent } = this.opts;

    if (method === "GET" && path === "/v1/health") {
      return { health: await admin.health() };
    }

    if (method === "GET" && path === "/v1/state") {
      await this.authenticate(req, path, ctx);
      return { state: await agent.fleetState() };
    }

    if (method === "GET" && path === "/v1/members") {
      await this.authenticate(req, path, ctx);
      return { addresses: await agent.memberAddresses() };
    }

    if (method === "GET" && path === "/v1/self") {
      const who = await this.authenticate(req, path, ctx, true);
      return { agent: who.agent, dead: who.dead };
    }

    if (method !== "POST") throw new HttpError(404, "FLEET_NOT_FOUND", "no such endpoint");
    const body = this.parseBody(ctx.raw);

    switch (path) {
      case "/v1/session": {
        // The only endpoint that accepts the long-lived credential.
        const { agentId, token } = await this.bearer(req, path, ctx);
        this.rateLimit(this.sessions, agentId);
        const sessionToken = mintSessionToken(agentId);
        const r = await agent.openSession(agentId, token, hashAgentToken(sessionToken));
        if (!r.ok) {
          const gone = r.code === "FLEET_AGENT_DEAD" || r.code === "FLEET_AGENT_QUARANTINED";
          if (!gone) await this.authFailure(ctx, path, `session refused (${r.code})`);
          throw new HttpError(410, r.code, "agent is not living");
        }
        return { sessionToken, expiresAt: new Date((r as { expiresAt: string }).expiresAt).toISOString() };
      }

      case "/v1/health/challenge": {
        const caller = await this.authenticate(req, path, ctx);
        const r = await admin.answerChallenge(caller.agentId, {
          challengeId: str(body, "challengeId", 26),
          nonce: str(body, "nonce", 64),
          commit: str(body, "commit", 40, false) || null,
          buildId: str(body, "buildId", 64, false) || null,
          policyOk: body.policyOk === true,
        });
        if (!r.ok) throw new HttpError(409, r.code ?? "FLEET_CHALLENGE_FAILED", r.reason ?? "challenge failed");
        return { passed: true };
      }

      case "/v1/replication/provisioning": {
        const caller = await this.authenticate(req, path, ctx);
        const reservationId = str(body, "reservationId", 26);
        const phase = str(body, "phase", 32);
        if (phase !== "sandbox_created" && phase !== "verifying") throw new HttpError(400, "FLEET_BAD_REQUEST", "unknown phase");
        const lease = await admin.getReservation(reservationId);
        if (!lease || lease.reservationId !== reservationId || lease.parentAgentId !== caller.agentId) {
          await this.recordDb("authorization_denied", null, { action: "provisioning", caller: caller.agentId, reservationId });
          throw new HttpError(403, "FLEET_NOT_AUTHORIZED", "not your reservation");
        }
        await admin.reportProvisioning(lease.agentId, phase, str(body, "sandboxId", 128, false) || null, caller.agentId);
        return { recorded: true };
      }

      case "/v1/capital/propose": {
        const { agentId, token } = await this.credentials(req, path, ctx);
        const amount = Number(body.requestedCents);
        const expected = Number(body.expectedReturnCents ?? 0);
        const days = Number(body.expectedDurationDays);
        if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(expected) || expected < 0 || !Number.isSafeInteger(days)) {
          throw new HttpError(400, "FLEET_BAD_REQUEST", "requestedCents, expectedReturnCents and expectedDurationDays must be integers");
        }
        const r = await agent.proposeAllocation(agentId, token, {
          allocationId: ulid(),
          purpose: str(body, "purpose", 500),
          requestedCents: amount,
          expectedReturnCents: expected,
          expectedDurationDays: days,
        });
        if (!r.ok) throw new HttpError(r.code === "FLEET_AUTH_FAILED" ? 401 : 403, r.code, "proposal refused");
        return { allocation: r };
      }

      case "/v1/wallet/spend-request": {
        const { agentId, token } = await this.credentials(req, path, ctx);
        const amount = Number(body.amountCents);
        if (!Number.isSafeInteger(amount) || amount <= 0) throw new HttpError(400, "FLEET_BAD_REQUEST", "amountCents must be a positive integer");
        const r = await agent.requestSpend(agentId, token, {
          requestId: ulid(),
          fromWallet: str(body, "fromWallet", 64),
          toAddress: str(body, "toAddress", 64),
          amountCents: amount,
          purpose: str(body, "purpose", 300),
          allocationId: str(body, "allocationId", 26, false) || null,
        });
        if (!r.ok && r.code) {
          const gone = r.code === "FLEET_AGENT_DEAD" || r.code === "FLEET_AGENT_QUARANTINED";
          throw new HttpError(r.code === "FLEET_AUTH_FAILED" ? 401 : gone ? 410 : 403, String(r.code), String(r.reason ?? "spend refused"));
        }
        // Never executed here: the controller signer runs only with REAL_PAYMENTS_ENABLED=true (it is not).
        return { decision: r.decision, reason: r.reason ?? null, executed: false };
      }

      case "/v1/heartbeat": {
        const { agentId, token } = await this.credentials(req, path, ctx);
        const r = await agent.heartbeat(agentId, token);
        if (!r.ok && (r.code === "FLEET_AUTH_FAILED" || r.code === "FLEET_SESSION_EXPIRED")) {
          throw new HttpError(401, r.code, "agent credential rejected");
        }
        // A heartbeat proves only liveness; health needs a passed controller challenge.
        const challenge = r.ok ? await admin.issueChallenge(agentId).catch(() => null) : null;
        return { alive: r.ok, status: (r as { status?: string }).status ?? null, code: r.ok ? null : r.code, challenge };
      }

      case "/v1/status": {
        const { agentId, token } = await this.credentials(req, path, ctx);
        const status = str(body, "status", 32);
        const reason = str(body, "reason", 300, false);
        const r = await agent.setOwnStatus(agentId, token, status, reason);
        if (!r.ok) throw new HttpError(r.code === "FLEET_AUTH_FAILED" ? 401 : 403, r.code, "status change refused");
        if (status === "dead") this.audit("agent_died", agentId, { cause: "self_reported" });
        return { changed: (r as { changed?: boolean }).changed ?? false };
      }

      case "/v1/replication/request": {
        const { agentId, token } = await this.credentials(req, path, ctx);
        const name = str(body, "name", 128);
        const requestKey = str(body, "requestKey", 64, false) || ulid();
        if (!this.opts.realReplicationEnabled) {
          await this.recordDb("replication_rejected", null, { parentAgentId: agentId, code: "REAL_REPLICATION_DISABLED", by: "service" });
          throw new HttpError(403, "REAL_REPLICATION_DISABLED", "The fleet service has REAL_REPLICATION_ENABLED=false.");
        }
        const r = await agent.requestReplication(agentId, token, name, requestKey, ulid(), ulid());
        this.audit(r.ok ? "replication_granted" : "replication_rejected", agentId, {
          code: r.ok ? null : r.code,
          reservationId: r.ok ? r.reservationId : null,
        });
        if (!r.ok) {
          const status = r.code === "FLEET_AUTH_FAILED" ? 401 : r.code === "FLEET_AGENT_DEAD" ? 410 : 409;
          throw Object.assign(new HttpError(status, String(r.code), String(r.reason ?? "replication denied")), { detail: r });
        }
        return { reservation: r };
      }

      case "/v1/replication/claim": {
        const caller = await this.authenticate(req, path, ctx);
        const reservationId = str(body, "reservationId", 26);
        const localChildId = str(body, "localChildId", 64);
        const lease = await admin.getReservation(reservationId);
        if (!lease || !ULID_RE.test(reservationId) || lease.reservationId !== reservationId) {
          throw new HttpError(404, "FLEET_NOT_FOUND", "unknown reservation");
        }
        if (lease.parentAgentId === caller.agentId) await this.enforceRelease(lease, caller.agentId);
        const claimed = await admin.claimGrant(lease.agentId, localChildId, { parentAgentId: caller.agentId });
        return { claimed };
      }

      case "/v1/replication/activate": {
        const caller = await this.authenticate(req, path, ctx);
        const reservationId = str(body, "reservationId", 26);
        const lease = await admin.getReservation(reservationId);
        if (!lease || lease.reservationId !== reservationId) throw new HttpError(404, "FLEET_NOT_FOUND", "unknown reservation");
        if (lease.parentAgentId === caller.agentId) await this.enforceRelease(lease, caller.agentId);
        const result = await admin.activate(lease.agentId, {
          walletAddress: str(body, "walletAddress", 64),
          sandboxId: str(body, "sandboxId", 128, false) || null,
          runtimeCommit: str(body, "runtimeCommit", 40, false) || null,
          runtimeVersion: str(body, "runtimeVersion", 64, false) || null,
          attestation: body.attestation ? sanitizeAttestation(body.attestation) : null,
          parentAgentId: caller.agentId,
          actor: caller.agentId,
        });
        this.audit("agent_activated", result.agent.agentId, { parentAgentId: caller.agentId });
        return { agent: result.agent, credential: result.credential };
      }

      case "/v1/replication/fail": {
        const caller = await this.authenticate(req, path, ctx);
        const reservationId = str(body, "reservationId", 26);
        const reason = str(body, "reason", 500);
        const lease = await admin.getReservation(reservationId);
        if (!lease || lease.parentAgentId !== caller.agentId) {
          await this.recordDb("authorization_denied", null, { action: "fail_reservation", caller: caller.agentId, reservationId });
          throw new HttpError(403, "FLEET_NOT_AUTHORIZED", "not your reservation");
        }
        return { released: await admin.recordVerificationFailure(lease.agentId, reason, caller.agentId) };
      }

      case "/v1/replication/release": {
        const { agentId, token } = await this.credentials(req, path, ctx);
        const reservationId = str(body, "reservationId", 26);
        const reason = str(body, "reason", 300, false);
        const r = await agent.releaseReservation(agentId, token, reservationId, reason);
        if (!r.ok) throw new HttpError(r.code === "FLEET_AUTH_FAILED" ? 401 : 403, r.code, "release refused");
        return { released: (r as { released?: boolean }).released ?? false };
      }

      case "/v1/children/terminal": {
        // A parent reports its child's local lifecycle ended. Only its own
        // children; a child that is still heartbeating is never killed on the
        // parent's word (svc_child_terminal defers it to the reaper).
        const caller = await this.authenticate(req, path, ctx);
        const r = await admin.reportChildTerminal(caller.agentId, str(body, "localChildId", 64), str(body, "state", 32, false));
        if (!r.ok) throw new HttpError(403, r.code ?? "FLEET_NOT_AUTHORIZED", "not your child");
        this.audit("child_terminal_reported", null, { parentAgentId: caller.agentId, outcome: r.outcome });
        return { recorded: true, outcome: r.outcome, changed: r.changed === true };
      }

      default:
        throw new HttpError(404, "FLEET_NOT_FOUND", "no such endpoint");
    }
  }
}
