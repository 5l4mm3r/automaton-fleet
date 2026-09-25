/**
 * Claude bridge (Phase D, extended by Phase D3) — signed Operator API client.
 *
 * Signing is exactly B2's FLEET-OP-SIG-V1 (canonical.ts signedHeaders: same
 * canonical string, millisecond timestamp, 144-bit nonce, empty-body SHA-256,
 * key id = sha256(raw public key)[0:32], Ed25519). The client:
 *  - only builds targets the B2 route policy accepts (parseTarget +
 *    matchRoute + per-route parameter formats); anything else is
 *    UNSUPPORTED_REQUEST before a byte is sent;
 *  - sends GET with the five signing headers (no Authorization, no cookies,
 *    no body) to 127.0.0.1:<tunnel port>; D3 actions are POST with exactly
 *    the route's closed body schema in canonical serialization
 *    (canonicalActionBody), whose SHA-256 is part of the signed string;
 *  - has one typed method per operation; there is no generic request method;
 *  - never retries a signed request (a resend would be a replay);
 *  - bounds time and response size, requires JSON, validates the envelope,
 *    the code/HTTP-status pairing and the exact data shape (validate.ts);
 *  - loads the private key once from its protected file (0600, owner,
 *    single link, O_NOFOLLOW) and refuses a key whose id differs from the
 *    configured one, or a configured expiry in the past.
 */

import http from "http";
import { randomBytes, type KeyObject } from "crypto";
import { canonicalActionBody, keyIdOf, parseTarget, rawPublicKey, signedHeaders } from "../operator/canonical.js";
import { matchRoute } from "../operator/route-policy.js";
import { loadOperatorPrivateKey } from "../operator/keygen.js";
import { BridgeError, OP_CODE_MAP } from "./errors.js";
import type { KeyRef } from "./config.js";
import {
  checked,
  validateActionPage,
  validateActionResult,
  validateAgentOne,
  validateLifecycle,
  validateOrphanPage,
  validateProposalPage,
  validateReservationPage,
  validateRuntime,
  validateAgentPage,
  validateEnvelope,
  validateEventPage,
  validateStatus,
  validateWhoami,
  type AgentItem,
  type EventItem,
  type Page,
  type StatusData,
  type WhoamiData,
} from "./validate.js";

export interface SignerIdentity {
  principalId: string;
  key: KeyObject;
  keyId: string;
}

/** Load and check the signing key: protected file, expected key id, not locally known to be expired. */
export function loadSigner(principalId: string, ref: KeyRef, now = Date.now()): SignerIdentity {
  let key: KeyObject;
  try {
    key = loadOperatorPrivateKey(ref.keyFile);
  } catch (err) {
    throw new BridgeError("KEY_INVALID", `signing key rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
  const keyId = keyIdOf(rawPublicKey(key));
  if (keyId !== ref.keyId) throw new BridgeError("KEY_MISMATCH", `signing key file holds key ${keyId}, config expects ${ref.keyId}`);
  if (ref.expiresAt && Date.parse(ref.expiresAt) <= now) throw new BridgeError("KEY_EXPIRED", `signing key ${keyId} expired at ${ref.expiresAt}; rotate it (fleet:bridge key rotate-prepare)`);
  return { principalId, key, keyId };
}

export interface ClientOptions {
  port: number;
  signer: SignerIdentity;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Tests only. */
  now?: () => number;
  nonce?: () => string;
}

export interface Result<T> {
  requestId: string;
  serverTime: string;
  data: T;
}

export class OperatorBridgeClient {
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(private readonly opts: ClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxBytes = opts.maxResponseBytes ?? 512 * 1024;
  }

  async whoami(): Promise<Result<WhoamiData>> {
    return this.call("/v1/operator/whoami", (d) => {
      const w = validateWhoami(d);
      if (w.principal.id !== this.opts.signer.principalId || w.key.id !== this.opts.signer.keyId) {
        throw new BridgeError("IDENTITY_MISMATCH", "the Operator API answered for a different principal or key");
      }
      return w;
    });
  }

  async fleetStatus(): Promise<Result<StatusData>> {
    return this.call("/v1/operator/status", validateStatus);
  }

  async listAgents(q: { after?: string; limit?: number } = {}): Promise<Result<Page<AgentItem>>> {
    const limit = q.limit ?? 50;
    return this.call(target("/v1/operator/agents", { after: q.after, limit: q.limit }), (d) => validateAgentPage(d, limit));
  }

  async getAgent(agentId: string): Promise<Result<{ item: AgentItem }>> {
    if (!/^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/.test(agentId)) throw new BridgeError("UNSUPPORTED_REQUEST", "agent id must be a 26-character ULID");
    return this.call(`/v1/operator/agents/${agentId.toLowerCase()}`, validateAgentOne);
  }

  async listEvents(q: { after?: string; limit?: number; type?: string } = {}): Promise<Result<Page<EventItem>>> {
    const limit = q.limit ?? 50;
    return this.call(target("/v1/operator/events", { after: q.after, limit: q.limit, type: q.type }), (d) => validateEventPage(d, limit));
  }

  // ── D3 Tier 2 reads

  async lifecycleHealth(): Promise<Result<Record<string, unknown>>> {
    return this.call("/v1/operator/lifecycle", validateLifecycle);
  }

  async runtimeVerification(): Promise<Result<Record<string, unknown>>> {
    return this.call("/v1/operator/runtime", validateRuntime);
  }

  async listReservations(q: { after?: string; limit?: number } = {}) {
    const limit = q.limit ?? 50;
    return this.call(target("/v1/operator/reservations", { after: q.after, limit: q.limit }), (d) => validateReservationPage(d, limit));
  }

  async listOrphans(q: { after?: string; limit?: number } = {}) {
    const limit = q.limit ?? 50;
    return this.call(target("/v1/operator/orphans", { after: q.after, limit: q.limit }), (d) => validateOrphanPage(d, limit));
  }

  async listProposals(q: { after?: string; limit?: number } = {}) {
    const limit = q.limit ?? 50;
    return this.call(target("/v1/operator/proposals", { after: q.after, limit: q.limit }), (d) => validateProposalPage(d, limit));
  }

  async listActions(q: { after?: string; limit?: number } = {}) {
    const limit = q.limit ?? 50;
    return this.call(target("/v1/operator/actions", { after: q.after, limit: q.limit }), (d) => validateActionPage(d, limit));
  }

  // ── D3 Tier 3 actions (one typed method each; never retried)

  async holdAgent(a: { agentId: string; reason: string; idempotencyKey?: string }) {
    return this.act("/v1/operator/actions/hold-agent", "hold_agent", { agentId: agentIdUpper(a.agentId), reason: a.reason, idempotencyKey: a.idempotencyKey ?? newIdempotencyKey() });
  }

  async releaseAgentHold(a: { agentId: string; reason: string; idempotencyKey?: string }) {
    return this.act("/v1/operator/actions/release-agent-hold", "release_agent_hold", {
      agentId: agentIdUpper(a.agentId),
      reason: a.reason,
      idempotencyKey: a.idempotencyKey ?? newIdempotencyKey(),
    });
  }

  async requestHealthChallenge(a: { agentId: string; reason?: string; idempotencyKey?: string }) {
    return this.act("/v1/operator/actions/request-health-challenge", "request_health_challenge", {
      agentId: agentIdUpper(a.agentId),
      ...(a.reason !== undefined ? { reason: a.reason } : {}),
      idempotencyKey: a.idempotencyKey ?? newIdempotencyKey(),
    });
  }

  async revokeAgentSessions(a: { agentId: string; reason: string; idempotencyKey?: string }) {
    return this.act("/v1/operator/actions/revoke-agent-sessions", "revoke_agent_sessions", {
      agentId: agentIdUpper(a.agentId),
      reason: a.reason,
      idempotencyKey: a.idempotencyKey ?? newIdempotencyKey(),
    });
  }

  async reconcileLifecycle(a: { reason?: string; idempotencyKey?: string } = {}) {
    return this.act("/v1/operator/actions/reconcile-lifecycle", "reconcile_lifecycle", {
      ...(a.reason !== undefined ? { reason: a.reason } : {}),
      idempotencyKey: a.idempotencyKey ?? newIdempotencyKey(),
    });
  }

  async proposeAgentAction(a: { kind: string; agentId: string; reason: string; idempotencyKey?: string }) {
    return this.act("/v1/operator/proposals", "propose_agent_action", {
      kind: a.kind,
      agentId: agentIdUpper(a.agentId),
      reason: a.reason,
      idempotencyKey: a.idempotencyKey ?? newIdempotencyKey(),
    });
  }

  private async act(path: string, action: string, fields: Record<string, string>): Promise<Result<Record<string, unknown>>> {
    const match = matchRoute("POST", path);
    if (!match || !match.route.body) throw new BridgeError("UNSUPPORTED_REQUEST", `not a supported Operator API action: ${path.slice(0, 80)}`);
    const schema = match.route.body;
    for (const [k, v] of Object.entries(fields)) {
      const f = Object.prototype.hasOwnProperty.call(schema, k) ? schema[k] : undefined;
      if (!f || typeof v !== "string" || !f.re.test(v)) throw new BridgeError("UNSUPPORTED_REQUEST", `unsupported value for field ${k}`);
    }
    for (const [k, f] of Object.entries(schema)) if (f.required && !(k in fields)) throw new BridgeError("UNSUPPORTED_REQUEST", `missing field ${k}`);
    const body = Buffer.from(canonicalActionBody(fields), "utf8");
    const now = this.opts.now ?? Date.now;
    const headers = signedHeaders(this.opts.signer.key, this.opts.signer.principalId, path, {
      method: "POST",
      body,
      now: now(),
      ...(this.opts.nonce ? { nonce: this.opts.nonce() } : {}),
    });
    return this.finish(await this.send(path, headers, body), (d) => validateActionResult(d, action));
  }

  private async call<T>(tgt: string, validate: (d: unknown) => T): Promise<Result<T>> {
    const parsed = parseTarget(tgt);
    const match = parsed.ok ? matchRoute("GET", parsed.path) : null;
    if (!parsed.ok || !match) throw new BridgeError("UNSUPPORTED_REQUEST", `not a supported Operator API request: ${tgt.slice(0, 80)}`);
    for (const [k, v] of Object.entries(parsed.params)) {
      const re = match.route.params[k];
      if (!re || !re.test(v)) throw new BridgeError("UNSUPPORTED_REQUEST", `unsupported value for parameter ${k}`);
    }
    const now = this.opts.now ?? Date.now;
    const headers = signedHeaders(this.opts.signer.key, this.opts.signer.principalId, tgt, {
      now: now(),
      ...(this.opts.nonce ? { nonce: this.opts.nonce() } : {}),
    });
    return this.finish(await this.send(tgt, headers), validate);
  }

  private finish<T>(res: { status: number; json: unknown }, validate: (d: unknown) => T): Result<T> {
    const env = checked(() => validateEnvelope(res.json));
    if (!env.ok) {
      const m = OP_CODE_MAP[env.code];
      if (!m) throw new BridgeError("MALFORMED_RESPONSE", `unknown Operator API error code ${env.code}`, env.requestId);
      if (m.status !== res.status) throw new BridgeError("MALFORMED_RESPONSE", `error ${env.code} arrived with HTTP ${res.status}`, env.requestId);
      throw new BridgeError(m.code, `${env.code}: ${m.hint}`, env.requestId);
    }
    if (res.status !== 200) throw new BridgeError("MALFORMED_RESPONSE", `success envelope with HTTP ${res.status}`, env.requestId);
    return { requestId: env.requestId, serverTime: env.serverTime, data: checked(() => validate(env.data), env.requestId) };
  }

  private send(path: string, signed: Record<string, string>, body?: Buffer): Promise<{ status: number; json: unknown }> {
    const port = this.opts.port;
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          fn();
        }
      };
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: body ? "POST" : "GET",
          headers: {
            ...signed,
            host: `127.0.0.1:${port}`,
            accept: "application/json",
            connection: "close",
            ...(body ? { "content-type": "application/json", "content-length": String(body.length) } : {}),
          },
          agent: false,
        },
        (res) => {
          const ct = String(res.headers["content-type"] ?? "");
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (d: Buffer) => {
            size += d.length;
            if (size > this.maxBytes) {
              done(() => reject(new BridgeError("MALFORMED_RESPONSE", `response larger than ${this.maxBytes} bytes`)));
              req.destroy();
            } else chunks.push(d);
          });
          res.on("end", () =>
            done(() => {
              if (!/^application\/json(;|$)/.test(ct)) return reject(new BridgeError("MALFORMED_RESPONSE", "response is not application/json"));
              try {
                resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
              } catch {
                reject(new BridgeError("MALFORMED_RESPONSE", "response is not valid JSON"));
              }
            }),
          );
          res.on("error", (e) => done(() => reject(new BridgeError("NETWORK", `response interrupted: ${e.message}`))));
          res.on("aborted", () => done(() => reject(new BridgeError("NETWORK", "response aborted"))));
        },
      );
      const timer = setTimeout(() => {
        done(() => reject(new BridgeError("TIMEOUT", `no complete response within ${this.timeoutMs} ms`)));
        req.destroy();
      }, this.timeoutMs);
      req.on("error", (e) => done(() => reject(new BridgeError("NETWORK", `request failed: ${(e as NodeJS.ErrnoException).code ?? e.message}`))));
      req.end(body);
    });
  }
}

/** Action bodies carry agent ids in the registry's upper-case form. */
function agentIdUpper(id: string): string {
  if (typeof id !== "string" || !/^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/.test(id)) throw new BridgeError("UNSUPPORTED_REQUEST", "agent id must be a 26-character ULID");
  return id.toUpperCase();
}

/** A fresh idempotency key when the caller supplied none (144 random bits). */
export function newIdempotencyKey(): string {
  return randomBytes(18).toString("base64url");
}

function target(path: string, q: Record<string, string | number | undefined>): string {
  for (const [k, v] of Object.entries(q)) {
    if (v !== undefined && !/^[A-Za-z0-9_]{1,64}$/.test(String(v))) throw new BridgeError("UNSUPPORTED_REQUEST", `unsupported value for parameter ${k}`);
  }
  const parts = Object.entries(q)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${String(v)}`);
  return parts.length ? `${path}?${parts.join("&")}` : path;
}
