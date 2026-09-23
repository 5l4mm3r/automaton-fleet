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
 * service instances may run it concurrently).
 */

import http from "http";
import type { AddressInfo } from "net";
import { ulid } from "ulid";
import { FleetBypassError } from "../registry.js";
import { FleetRuntimeError } from "../runtime.js";
import { sanitizeAttestation } from "../attestation.js";
import {
  FleetDuplicateRegistrationError,
  FleetRegistryUnavailableError,
  agentIdFromToken,
  type PgFleetStore,
} from "../postgres/store.js";
import type { PgAgentGateway } from "../postgres/agent-gateway.js";

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
  private reaping = false;

  constructor(private readonly opts: FleetServiceOptions) {}

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
    if (this.reaping) return;
    this.reaping = true;
    try {
      const r = await this.opts.admin.reap("reaper");
      if (r.expired || r.unresponsive || r.dead) this.audit("reaper_pass", null, { ...r });
    } catch (err) {
      this.audit("reaper_error", null, { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.reaping = false;
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
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => resolve());
    });
    const addr = this.server.address() as AddressInfo;
    const h = addr.family === "IPv6" ? `[${addr.address}]` : addr.address;
    return { host: addr.address, port: addr.port, url: `http://${h}:${addr.port}` };
  }

  async close(): Promise<void> {
    this.stopReaper();
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  private async readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const max = this.opts.maxBodyBytes ?? 64 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > max) throw new HttpError(413, "FLEET_BAD_REQUEST", "request body too large");
      chunks.push(chunk as Buffer);
    }
    if (size === 0) return {};
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
      return v as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "FLEET_BAD_REQUEST", "body must be a JSON object");
    }
  }

  private send(res: http.ServerResponse, status: number, body: unknown): void {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(data),
    });
    res.end(data);
  }

  /** Bearer token → (agentId, token). Syntax only; the database verifies it. */
  private async bearer(req: http.IncomingMessage, path: string): Promise<{ agentId: string; token: string }> {
    const h = req.headers.authorization ?? "";
    const m = /^Bearer (\S{1,256})$/.exec(h);
    const agentId = m ? agentIdFromToken(m[1]) : null;
    if (!m || !agentId) {
      await this.recordDb("api_auth_failed", null, { path, why: m ? "malformed token" : "missing bearer token" });
      throw new HttpError(401, "FLEET_AUTH_FAILED", "missing or malformed agent credential");
    }
    return { agentId, token: m[1] };
  }

  /** Full authentication through the restricted role; the agent must be living. */
  private async authenticate(req: http.IncomingMessage, path: string, allowDead = false) {
    const cred = await this.bearer(req, path);
    const who = await this.opts.agent.whoami(cred.agentId, cred.token);
    if (!who.ok) {
      if (who.code === "FLEET_AGENT_DEAD" && allowDead && "agent" in who) return { ...cred, agent: who.agent as never, dead: true };
      if (who.code !== "FLEET_AGENT_DEAD") this.audit("api_auth_failed", null, { path, code: who.code });
      throw new HttpError(who.code === "FLEET_AGENT_DEAD" ? 410 : 401, who.code, "agent credential rejected");
    }
    return { ...cred, agent: who.agent, dead: false };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0];
    try {
      const out = await this.route(req.method ?? "GET", path, req);
      this.send(res, 200, { ok: true, ...out });
    } catch (err) {
      if (err instanceof HttpError) {
        this.send(res, err.status, { ok: false, code: err.code, reason: err.message });
      } else if (err instanceof FleetRuntimeError) {
        this.send(res, 409, { ok: false, code: "FLEET_RUNTIME_UNVERIFIED", reason: err.message });
      } else if (err instanceof FleetBypassError) {
        this.send(res, 403, { ok: false, code: "FLEET_NOT_AUTHORIZED", reason: err.message });
      } else if (err instanceof FleetDuplicateRegistrationError) {
        this.send(res, 409, { ok: false, code: "FLEET_DUPLICATE_REGISTRATION", reason: err.message });
      } else if (err instanceof FleetRegistryUnavailableError) {
        this.send(res, 503, { ok: false, code: "FLEET_REGISTRY_UNAVAILABLE", reason: "registry unavailable" });
      } else if (isPgPermissionError(err)) {
        await this.recordDb("db_authorization_failed", null, { path, pgCode: (err as { code?: string }).code, message: (err as Error).message });
        this.send(res, 500, { ok: false, code: "FLEET_DB_AUTHORIZATION_FAILED", reason: "database refused the operation" });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        this.audit("api_error", null, { path, error: msg });
        const unavailable = /ECONNREFUSED|timeout|terminated|connect/i.test(msg);
        this.send(res, unavailable ? 503 : 400, {
          ok: false,
          code: unavailable ? "FLEET_REGISTRY_UNAVAILABLE" : "FLEET_REQUEST_FAILED",
          reason: unavailable ? "registry unavailable" : msg.slice(0, 300),
        });
      }
    }
  }

  private async route(method: string, path: string, req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const { admin, agent } = this.opts;

    if (method === "GET" && path === "/v1/health") {
      return { health: await admin.health() };
    }

    if (method === "GET" && path === "/v1/state") {
      await this.authenticate(req, path);
      return { state: await agent.fleetState() };
    }

    if (method === "GET" && path === "/v1/members") {
      await this.authenticate(req, path);
      return { addresses: await agent.memberAddresses() };
    }

    if (method === "GET" && path === "/v1/self") {
      const who = await this.authenticate(req, path, true);
      return { agent: who.agent, dead: who.dead };
    }

    if (method !== "POST") throw new HttpError(404, "FLEET_NOT_FOUND", "no such endpoint");
    const body = await this.readBody(req);

    switch (path) {
      case "/v1/heartbeat": {
        const { agentId, token } = await this.bearer(req, path);
        const r = await agent.heartbeat(agentId, token);
        if (!r.ok && r.code === "FLEET_AUTH_FAILED") throw new HttpError(401, r.code, "agent credential rejected");
        return { alive: r.ok, status: (r as { status?: string }).status ?? null, code: r.ok ? null : r.code };
      }

      case "/v1/status": {
        const { agentId, token } = await this.bearer(req, path);
        const status = str(body, "status", 32);
        const reason = str(body, "reason", 300, false);
        const r = await agent.setOwnStatus(agentId, token, status, reason);
        if (!r.ok) throw new HttpError(r.code === "FLEET_AUTH_FAILED" ? 401 : 403, r.code, "status change refused");
        if (status === "dead") this.audit("agent_died", agentId, { cause: "self_reported" });
        return { changed: (r as { changed?: boolean }).changed ?? false };
      }

      case "/v1/replication/request": {
        const { agentId, token } = await this.bearer(req, path);
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
        const caller = await this.authenticate(req, path);
        const reservationId = str(body, "reservationId", 26);
        const localChildId = str(body, "localChildId", 64);
        const lease = await admin.getReservation(reservationId);
        if (!lease || !ULID_RE.test(reservationId) || lease.reservationId !== reservationId) {
          throw new HttpError(404, "FLEET_NOT_FOUND", "unknown reservation");
        }
        const claimed = await admin.claimGrant(lease.agentId, localChildId, { parentAgentId: caller.agentId });
        return { claimed };
      }

      case "/v1/replication/activate": {
        const caller = await this.authenticate(req, path);
        const reservationId = str(body, "reservationId", 26);
        const lease = await admin.getReservation(reservationId);
        if (!lease || lease.reservationId !== reservationId) throw new HttpError(404, "FLEET_NOT_FOUND", "unknown reservation");
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
        const caller = await this.authenticate(req, path);
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
        const { agentId, token } = await this.bearer(req, path);
        const reservationId = str(body, "reservationId", 26);
        const reason = str(body, "reason", 300, false);
        const r = await agent.releaseReservation(agentId, token, reservationId, reason);
        if (!r.ok) throw new HttpError(r.code === "FLEET_AUTH_FAILED" ? 401 : 403, r.code, "release refused");
        return { released: (r as { released?: boolean }).released ?? false };
      }

      case "/v1/children/terminal": {
        // A parent reporting its child's local lifecycle end is recorded only:
        // an agent never changes another agent's state. The reaper releases
        // the slot once the child stops heartbeating.
        const caller = await this.authenticate(req, path);
        await this.recordDb("child_terminal_reported", null, {
          parentAgentId: caller.agentId,
          localChildId: str(body, "localChildId", 64),
          state: str(body, "state", 32, false),
        });
        return { recorded: true };
      }

      default:
        throw new HttpError(404, "FLEET_NOT_FOUND", "no such endpoint");
    }
  }
}
