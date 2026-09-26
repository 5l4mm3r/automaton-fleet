# SOURCE VOLUME 04 — FleetController service (src/fleet/service)

Exact, byte-for-byte text of each file at repository commit `efad2148a3460ab881b0ab845fb13c25d1fa3e74` (branch fleet-development).
No file in this volume contains a real secret; test fixtures generate synthetic secrets at runtime.
Each file's SHA-256 is of the file bytes on disk and matches 22-RECONSTRUCTION-MANIFEST.md.

## Files

- `src/fleet/service/client.ts` — 487 lines, sha256 `94fd00a3553338d59f138887d8744cbe061a5b1a31f1f4d398b2983fa14507e2`
- `src/fleet/service/log.ts` — 47 lines, sha256 `9660df45e43f378454a9107446590f46d97322d5a938a1e1205d96f7e40fbadc`
- `src/fleet/service/main.ts` — 353 lines, sha256 `92b61088d1289537b7fa317999ea9ef73d13b13235d6660edb1b6927862601c2`
- `src/fleet/service/rate-limit.ts` — 62 lines, sha256 `dd9b75f587539bb153edf535c5b9785a8136766e60670ca73152c0583e68a3fb`
- `src/fleet/service/server-signing.ts` — 18 lines, sha256 `44ea0917d57692c3fe330efc39f0d076a1ca43750bc6eb37c016c37463b1f29c`
- `src/fleet/service/server.ts` — 908 lines, sha256 `1c5c9329c98604f3998b7c24d3978f30f380c2c7dc4da28136e66abf0d9735ee`
- `src/fleet/service/terminator.ts` — 34 lines, sha256 `9aa6500b5575233dcbc30690278a108153f9955f94475e8b63e6c3c77087ccd2`

## `src/fleet/service/client.ts`

sha256 `94fd00a3553338d59f138887d8744cbe061a5b1a31f1f4d398b2983fa14507e2` · 20731 bytes · 487 lines

```ts
/**
 * FleetApiClient (Phase 3/5) — the agent's view of the fleet registry.
 *
 * Holds only this agent's own long-lived credential (from
 * ~/.automaton/fleet-credentials.json, mode 0600) and the service URL. It
 * has no database credentials and cannot do anything the fleet service's
 * restricted API does not allow for this agent.
 *
 * Phase 5: the long-lived credential is used ONLY to open a short-lived
 * session (POST /v1/session). Every other request carries the session token
 * and is signed (timestamp + single-use nonce + HMAC over method, path and
 * body), so captured requests cannot be replayed. Heartbeat responses may
 * carry a controller health challenge, which is answered automatically with
 * the runtime identity and a policy-guard canary result.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { createBoundGrant, type ClaimedGrant } from "../grants.js";
import { FleetBypassError } from "../registry.js";
import { CHILD_RUNTIME_MANIFEST, FleetRuntimeError, readOwnCommit, runningRuntimeDir } from "../runtime.js";
import { getForbiddenCommandMatch } from "../../agent/policy-rules/command-safety.js";
import { SIG_HEADERS, signRequest } from "./server-signing.js";
import type { FleetBackend } from "../backend.js";
import type { RuntimeAttestation } from "../attestation.js";
import { FleetDuplicateRegistrationError, FleetRegistryUnavailableError, agentIdFromToken } from "../postgres/store.js";
import type { RegisterResult, SharedReserveResult } from "../postgres/store.js";
import type {
  ActivationResult,
  FleetDecisionCode,
  FleetHealth,
  SharedAgentRecord,
  SharedAgentStatus,
  SharedFleetState,
} from "../types.js";

export const DEFAULT_CREDENTIALS_FILE = path.join(os.homedir() || "/root", ".automaton", "fleet-credentials.json");

export interface HealthChallengeView {
  challengeId: string;
  nonce: string;
  canary: string;
  expiresAt: string;
}

export type HealthResponder = (c: HealthChallengeView) => Promise<{ commit: string | null; buildId: string | null; policyOk: boolean }>;

/**
 * Default answer: runtime identity from the child's fleet manifest (children)
 * or the running checkout (roots), and whether this agent's own shell guard
 * refuses the canary command (policy responsiveness).
 */
export function defaultHealthResponder(opts: { manifestPath?: string; runtimeDir?: string } = {}): HealthResponder {
  return async (c) => {
    let commit: string | null = null;
    let buildId: string | null = null;
    try {
      const m = JSON.parse(fs.readFileSync(opts.manifestPath ?? CHILD_RUNTIME_MANIFEST, "utf8"));
      commit = typeof m.commit === "string" ? m.commit : null;
      buildId = typeof m.buildId === "string" ? m.buildId : null;
    } catch {
      commit = readOwnCommit(opts.runtimeDir ?? runningRuntimeDir(import.meta.url));
    }
    return { commit, buildId, policyOk: getForbiddenCommandMatch(c.canary) !== null };
  };
}

export interface FleetApiClientOptions {
  baseUrl: string;
  agentId: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  healthResponder?: HealthResponder;
  now?: () => number;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** https everywhere; plain http only to a loopback service. */
export function validateServiceUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("FLEET_API_URL is not a valid URL");
  }
  if (u.username || u.password) throw new Error("FLEET_API_URL must not contain credentials");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) {
    throw new Error("FLEET_API_URL must use https (plain http is allowed only on loopback)");
  }
  return u.origin;
}

/** Read and check the agent's credential file: must be a regular file, not group/world accessible. */
export function readCredentialFile(file: string): { agentId: string; token: string; apiUrl: string | null } | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!st.isFile()) throw new Error(`${file} is not a regular file`);
  if ((st.mode & 0o077) !== 0) throw new Error(`${file} must not be readable by group/others (chmod 600)`);
  const j = JSON.parse(fs.readFileSync(file, "utf8")) as { agentId?: unknown; token?: unknown; apiUrl?: unknown };
  if (typeof j.token !== "string" || agentIdFromToken(j.token) === null) throw new Error(`${file} holds no valid fleet token`);
  const agentId = agentIdFromToken(j.token)!;
  if (j.agentId !== undefined && j.agentId !== agentId) throw new Error(`${file}: agentId does not match token`);
  return { agentId, token: j.token, apiUrl: typeof j.apiUrl === "string" && j.apiUrl ? j.apiUrl : null };
}

export class FleetApiClient implements FleetBackend {
  readonly kind = "api" as const;
  readonly baseUrl: string;
  readonly agentId: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  /** child agentId -> reservationId for leases this client holds. */
  private readonly leases = new Map<string, string>();
  private session: { token: string; expiresAt: number } | null = null;
  private readonly responder: HealthResponder;
  private readonly now: () => number;
  /** Last health challenge outcome (diagnostics). */
  lastChallenge: { at: string; passed: boolean; code?: string } | null = null;

  constructor(opts: FleetApiClientOptions) {
    this.baseUrl = validateServiceUrl(opts.baseUrl);
    if (agentIdFromToken(opts.token) !== opts.agentId) throw new Error("fleet token does not belong to this agent");
    this.agentId = opts.agentId;
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.responder = opts.healthResponder ?? defaultHealthResponder();
    this.now = opts.now ?? Date.now;
  }

  /**
   * FLEET_API_URL (or apiUrl in the credential file) + the credential file.
   * Null when either is missing — replication then fails closed.
   */
  static fromEnv(env: Record<string, string | undefined> = process.env, file = env.FLEET_CREDENTIALS_FILE || DEFAULT_CREDENTIALS_FILE): FleetApiClient | null {
    const cred = readCredentialFile(file);
    const url = env.FLEET_API_URL?.trim() || cred?.apiUrl;
    if (!cred || !url) return null;
    return new FleetApiClient({ baseUrl: url, agentId: cred.agentId, token: cred.token });
  }

  /** Open (or reuse) a short-lived session with the long-lived credential. */
  private async ensureSession(force = false): Promise<string> {
    if (!force && this.session && this.session.expiresAt - this.now() > 30_000) return this.session.token;
    const r = await this.raw<{ sessionToken: string; expiresAt: string }>("POST", "/v1/session", {}, { authorization: `Bearer ${this.token}` });
    this.session = { token: r.sessionToken, expiresAt: Date.parse(r.expiresAt) };
    return r.sessionToken;
  }

  private async call<T>(method: "GET" | "POST", p: string, body?: unknown, retried = false): Promise<T> {
    if (p === "/v1/health") return this.raw<T>(method, p, body, {});
    const session = await this.ensureSession();
    const payload = body === undefined ? "" : JSON.stringify(body);
    const ts = String(this.now());
    const nonce = crypto.randomBytes(24).toString("base64url");
    try {
      return await this.raw<T>(method, p, body, {
        authorization: `FleetSession ${session}`,
        [SIG_HEADERS.ts]: ts,
        [SIG_HEADERS.nonce]: nonce,
        [SIG_HEADERS.sig]: signRequest(session, method, p, ts, nonce, payload),
      });
    } catch (err) {
      if (!retried && err instanceof ApiError && err.status === 401 && ["FLEET_SESSION_EXPIRED", "FLEET_AUTH_FAILED", "FLEET_SESSION_REQUIRED"].includes(err.code)) {
        this.session = null;
        return this.call<T>(method, p, body, true);
      }
      throw err;
    }
  }

  private async raw<T>(method: "GET" | "POST", p: string, body: unknown, headers: Record<string, string>): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${p}`, {
        method,
        headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch (err) {
      throw new FleetRegistryUnavailableError(`Fleet service unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    let json: Record<string, unknown>;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new FleetRegistryUnavailableError(`Fleet service returned a non-JSON response (${res.status}).`);
    }
    if (!res.ok || json.ok !== true) {
      const code = typeof json.code === "string" ? json.code : "FLEET_REQUEST_FAILED";
      if (res.status === 503) throw new FleetRegistryUnavailableError(`Fleet service: ${code}`);
      throw new ApiError(res.status, code, typeof json.reason === "string" ? json.reason : code);
    }
    return json as T;
  }

  async close(): Promise<void> {}

  async health(): Promise<FleetHealth> {
    const start = Date.now();
    try {
      const r = await this.call<{ health: FleetHealth }>("GET", "/v1/health");
      return { ...r.health, latencyMs: Date.now() - start };
    } catch (err) {
      return { ok: false, latencyMs: null, schemaVersion: null, countersConsistent: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getState(): Promise<SharedFleetState> {
    return (await this.call<{ state: SharedFleetState }>("GET", "/v1/state")).state;
  }

  async listMemberAddresses(): Promise<string[]> {
    return (await this.call<{ addresses: string[] }>("GET", "/v1/members")).addresses;
  }

  private async self(): Promise<{ agent: SharedAgentRecord; dead: boolean } | null> {
    try {
      return await this.call<{ agent: SharedAgentRecord; dead: boolean }>("GET", "/v1/self");
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 410)) return null;
      throw err;
    }
  }

  /** This agent's own registry record (GET /v1/self); null when the credential is rejected. */
  async describeSelf(): Promise<{ agent: SharedAgentRecord; dead: boolean } | null> {
    return this.self();
  }

  /** Roots are enrolled by the operator (fleet:admin enroll-root); this only confirms the credential. */
  async registerRoot(params: { walletAddress: string }): Promise<RegisterResult> {
    return this.confirm(this.agentId, params.walletAddress, "root");
  }

  async attachAgent(agentId: string, walletAddress: string): Promise<RegisterResult> {
    return this.confirm(agentId, walletAddress, "child");
  }

  private async confirm(agentId: string, walletAddress: string, role: "root" | "child"): Promise<RegisterResult> {
    if (agentId !== this.agentId) {
      return { ok: false, code: "FLEET_IDENTITY_MISMATCH", reason: "Fleet credential belongs to a different agent." };
    }
    const me = await this.self();
    if (!me) return { ok: false, code: "FLEET_NOT_REGISTERED", reason: "Fleet credential rejected (enroll with fleet:admin)." };
    if (me.dead) return { ok: false, code: "FLEET_AGENT_DEAD", reason: `Agent ${agentId} is ${me.agent.status}.` };
    if (me.agent.role !== role || (me.agent.walletAddress ?? "").toLowerCase() !== walletAddress.toLowerCase()) {
      return { ok: false, code: "FLEET_IDENTITY_MISMATCH", reason: "Fleet credential does not match this automaton's wallet/role." };
    }
    return { ok: true, agent: me.agent, created: false };
  }

  async heartbeat(agentId: string): Promise<boolean> {
    if (agentId !== this.agentId) return false;
    const r = await this.call<{ alive: boolean; challenge?: HealthChallengeView | null }>("POST", "/v1/heartbeat", {}).catch((err) => {
      if (err instanceof ApiError) return { alive: false, challenge: null };
      throw err;
    });
    if (r.alive && r.challenge) await this.answerChallenge(r.challenge);
    return r.alive === true;
  }

  /** Answer a controller health challenge (runtime identity + policy canary). Failures are recorded by the controller. */
  async answerChallenge(c: HealthChallengeView): Promise<boolean> {
    try {
      const a = await this.responder(c);
      await this.call("POST", "/v1/health/challenge", { challengeId: c.challengeId, nonce: c.nonce, commit: a.commit ?? undefined, buildId: a.buildId ?? undefined, policyOk: a.policyOk });
      this.lastChallenge = { at: new Date(this.now()).toISOString(), passed: true };
      return true;
    } catch (err) {
      this.lastChallenge = { at: new Date(this.now()).toISOString(), passed: false, code: err instanceof ApiError ? err.code : String(err) };
      return false;
    }
  }

  /** Propose a capital allocation. Approval is FleetAdmin-only. */
  async proposeCapital(p: { purpose: string; requestedCents: number; expectedReturnCents: number; expectedDurationDays: number }) {
    return (await this.call<{ allocation: { allocationId: string; status: string } }>("POST", "/v1/capital/propose", p)).allocation;
  }

  /** Request a spend from this agent's own custody wallet. Decision only; nothing is signed by the agent. */
  async requestSpend(r: { fromWallet: string; toAddress: string; amountCents: number; purpose: string; allocationId?: string }) {
    return this.call<{ decision: string; reason: string | null; executed: boolean }>("POST", "/v1/wallet/spend-request", r);
  }

  async selfStatus(agentId: string): Promise<SharedAgentStatus | null> {
    if (agentId !== this.agentId) return null;
    return (await this.self())?.agent.status ?? null;
  }

  async reserveSlot(params: { name: string; requestKey?: string }): Promise<SharedReserveResult> {
    let r: { reservation: Record<string, unknown> };
    try {
      r = await this.call("POST", "/v1/replication/request", { name: params.name, requestKey: params.requestKey });
    } catch (err) {
      if (err instanceof ApiError) {
        return { ok: false, code: err.code as FleetDecisionCode, reason: err.message, living: -1, reserved: -1, max: -1 };
      }
      throw err;
    }
    const res = r.reservation as {
      agentId: string;
      reservationId: string;
      parentAgentId: string;
      generation: number;
      expiresAt: string;
      runtime: { repo: string; commit: string };
      build: { buildId: string; lockfileSha256: string };
    };
    this.leases.set(res.agentId, res.reservationId);
    const grant = createBoundGrant(res.reservationId, (localChildId) => this.claim(res.reservationId, localChildId));
    const now = new Date().toISOString();
    return {
      ok: true,
      grant,
      agent: {
        agentId: res.agentId,
        parentAgentId: res.parentAgentId,
        role: "child",
        generation: res.generation,
        name: params.name,
        walletAddress: null,
        runtimeVersion: null,
        runtimeRepo: res.runtime.repo,
        runtimeCommit: res.runtime.commit,
        sandboxId: null,
        localChildId: null,
        status: "reserved",
        statusReason: null,
        requestedBy: this.agentId,
        createdAt: now,
        updatedAt: now,
        lastHeartbeat: null,
        deathTime: null,
      },
      lease: {
        reservationId: res.reservationId,
        agentId: res.agentId,
        parentAgentId: res.parentAgentId,
        status: "reserved",
        createdAt: now,
        expiresAt: new Date(res.expiresAt).toISOString(),
        claimedAt: null,
        completedAt: null,
        endedAt: null,
        endReason: null,
        expected: { ...res.runtime, ...res.build },
        attestedAt: null,
      },
    };
  }

  private async claim(reservationId: string, localChildId: string): Promise<ClaimedGrant> {
    try {
      const r = await this.call<{ claimed: ClaimedGrant }>("POST", "/v1/replication/claim", { reservationId, localChildId });
      const provisioningKey = r.claimed.provisioningKey ?? r.claimed.reservationId ?? reservationId;
      return {
        ...r.claimed,
        provisioningKey,
        reportProvisioning: async (phase, sandboxId) => {
          // Retried: a sandbox that exists must not go unrecorded.
          await this.postRetried("/v1/replication/provisioning", { reservationId, provisioningKey, phase, sandboxId });
        },
        recordSandboxIntent: async (sandboxName) => {
          const out = await this.postRetried<{ intent: { sandboxId: string | null; attempts: number; sandboxName: string } }>(
            "/v1/replication/provisioning",
            { reservationId, provisioningKey, phase: "sandbox_intent", sandboxName },
          );
          return out.intent;
        },
        reconcileProvisioning: async (outcome, sandboxId) => {
          await this.postRetried("/v1/replication/reconcile", { reservationId, provisioningKey, outcome, sandboxId });
        },
      };
    } catch (err) {
      if (err instanceof ApiError) throw new FleetBypassError(`Replication denied: ${err.message}`);
      throw err;
    }
  }

  /** POST with up to 3 attempts on network/5xx errors (each attempt is a fresh signed request). */
  private async postRetried<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
    let last: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        return await this.call<T>("POST", path, body);
      } catch (err) {
        last = err;
        if (err instanceof ApiError && err.status < 500) break;
        await new Promise((res) => setTimeout(res, 250 * (i + 1)));
      }
    }
    throw last;
  }

  private reservationOf(agentId: string): string {
    const id = this.leases.get(agentId);
    if (!id) throw new FleetBypassError(`No reservation held by this agent for ${agentId}.`);
    return id;
  }

  async releaseReservation(agentId: string, reason: string): Promise<boolean> {
    const r = await this.call<{ released: boolean }>("POST", "/v1/replication/release", {
      reservationId: this.reservationOf(agentId),
      reason: reason.slice(0, 300),
    });
    return r.released;
  }

  async recordVerificationFailure(agentId: string, reason: string): Promise<boolean> {
    const r = await this.call<{ released: boolean }>("POST", "/v1/replication/fail", {
      reservationId: this.reservationOf(agentId),
      reason: reason.slice(0, 500),
    });
    return r.released;
  }

  async activate(
    agentId: string,
    params: {
      walletAddress: string;
      sandboxId?: string | null;
      runtimeCommit?: string | null;
      runtimeVersion?: string | null;
      attestation?: RuntimeAttestation | null;
    },
  ): Promise<ActivationResult> {
    try {
      const reservationId = this.reservationOf(agentId);
      return await this.call<ActivationResult>("POST", "/v1/replication/activate", {
        reservationId,
        provisioningKey: reservationId,
        walletAddress: params.walletAddress,
        sandboxId: params.sandboxId ?? undefined,
        runtimeCommit: params.runtimeCommit ?? undefined,
        runtimeVersion: params.runtimeVersion ?? undefined,
        attestation: params.attestation ?? undefined,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "FLEET_RUNTIME_UNVERIFIED") throw new FleetRuntimeError(err.message);
        if (err.code === "FLEET_DUPLICATE_REGISTRATION") throw new FleetDuplicateRegistrationError(err.message);
        if (err.code === "FLEET_NOT_AUTHORIZED") throw new FleetBypassError(err.message);
        throw new Error(`Fleet activation failed: ${err.code} — ${err.message}`);
      }
      throw err;
    }
  }

  /**
   * Report that one of this agent's children ended locally. The controller
   * releases an unactivated child at once and retires a living child only
   * once it has stopped heartbeating; never another parent's child.
   */
  async markDeadByLocalChildId(localChildId: string, reason: string): Promise<boolean> {
    const r = await this.call<{ changed?: boolean }>("POST", "/v1/children/terminal", { localChildId, state: reason.slice(0, 32) }).catch(
      () => null,
    );
    return r?.changed === true;
  }

  /** Voluntary retirement: marks this agent dead and releases its slot. */
  async retire(reason: string): Promise<boolean> {
    return (await this.call<{ changed: boolean }>("POST", "/v1/status", { status: "dead", reason: reason.slice(0, 300) })).changed;
  }
}
```

## `src/fleet/service/log.ts`

sha256 `9660df45e43f378454a9107446590f46d97322d5a938a1e1205d96f7e40fbadc` · 1661 bytes · 47 lines

```ts
/**
 * Structured service logs: one JSON object per line on stdout (journald
 * captures it under the unit). Every line goes through the canonical
 * redactor (src/fleet/redact.ts); the envelope keys cannot be overridden by
 * fields, and lines are size-bounded.
 */

import fs from "fs";
import { redactAuditRecord, redactLogLine } from "../redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export type Logger = (level: LogLevel, event: string, fields?: Record<string, unknown>) => void;

export function createJsonLogger(
  write: (line: string) => void = (l) => process.stdout.write(l + "\n"),
  service = "automaton-fleet",
): Logger {
  return (level, event, fields = {}) => {
    try {
      write(redactLogLine({ ts: new Date().toISOString(), level, service, event }, fields));
    } catch {
      // logging must never take the service down
    }
  };
}

export interface AuditSinkEntry {
  ts: string;
  event: string;
  agentId?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * The service's audit sink. The entry is redacted once into the canonical
 * record; the JSONL file gets that record's line and stdout gets the same
 * redacted fields, so the two copies cannot diverge.
 */
export function createAuditSink(log: Logger, auditFile?: string): (entry: AuditSinkEntry) => void {
  if (auditFile) fs.closeSync(fs.openSync(auditFile, "a", 0o600));
  return (entry) => {
    const { record, line } = redactAuditRecord(entry);
    log("info", record.event, { agentId: record.agentId, ...record.detail, audit: true });
    if (auditFile) fs.appendFileSync(auditFile, line + "\n", { mode: 0o600 });
  };
}
```

## `src/fleet/service/main.ts`

sha256 `92b61088d1289537b7fa317999ea9ef73d13b13235d6660edb1b6927862601c2` · 17839 bytes · 353 lines

```ts
/**
 * Fleet service entrypoint (operator-run; never started by an agent).
 *
 *   production:  systemd unit deploy/systemd/automaton-fleet.service
 *                (node dist/fleet/service/main.js as automaton-fleet-service)
 *   development: pnpm fleet:service
 *
 * Environment (see secret-files.ts for where each comes from):
 *   FLEET_SERVICE_DATABASE_URL     restricted controller role (fleet_service_login) — required
 *                                  (legacy FLEET_CONTROLLER_DATABASE_URL / DATABASE_URL accepted,
 *                                  but the schema owner is refused)
 *   FLEET_AGENT_DATABASE_URL       restricted agent role (fleet_agent_login) — required
 *   FLEET_API_LISTEN               host:port (default 127.0.0.1:8787). Loopback only, unless
 *                                  FLEET_REMOTE_LISTEN_ENABLED=true AND TLS is configured
 *   FLEET_TLS_CERT_FILE / FLEET_TLS_KEY_FILE   PEM certificate / key. Production sets only the
 *                                  cert (/run/credentials/automaton-fleet.service/tls.crt) and the
 *                                  key comes from LoadCredential=tls.key (verified systemd credential,
 *                                  0440 allowed). An explicit FLEET_TLS_KEY_FILE must be strictly 0600.
 *   Phase 6 remote controller (all required together; remote exposure stays OFF by default):
 *   FLEET_REMOTE_LISTEN_ENABLED    "true" to serve remote children
 *   FLEET_PUBLIC_HOSTNAME          DNS name children connect to; the certificate must cover it
 *   FLEET_PUBLIC_LISTEN            HTTPS bind address, e.g. 0.0.0.0:8443. FLEET_API_LISTEN then
 *                                  stays a loopback plain-HTTP listener for local administration
 *   FLEET_ALLOWED_ORIGINS          comma-separated browser origins (default: none)
 *   FLEET_SERVICE_EXPECTED_USER    OS user the service must run as (systemd: automaton-fleet-service)
 *   FLEET_REAPER_INTERVAL_MS       reaper period (default 15000; 0 = off)
 *   FLEET_AUDIT_LOG                optional JSONL audit file (0600)
 *   FLEET_SHUTDOWN_DRAIN_MS        graceful drain window (default 10000)
 *   FLEET_RUNTIME_REPO/_COMMIT/_BUILD_ID/_LOCKFILE_SHA256   pinned runtime release
 *   REAL_REPLICATION_ENABLED       service-level switch (default false)
 *
 * Refuses to start if: it holds the admin credential; the controller DSN is
 * the schema owner or a superuser; the agent DSN is not the restricted agent
 * role; the effective privilege audit of either restricted role fails; the
 * listen address is not loopback; or its runtime release differs from the
 * registry-approved runtime.
 */

import crypto from "crypto";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { PgFleetStore } from "../postgres/store.js";
import { PgAgentGateway } from "../postgres/agent-gateway.js";
import { problemsFor } from "../postgres/privileges.js";
import {
  DEFAULT_TLS_KEY_FILE,
  SYSTEMD_SECRET_CREDENTIALS,
  TLS_KEY_CREDENTIAL,
  loadServiceEnv,
  secretFileProblems,
  systemdCredentialProblems,
  type SystemdCredentialHost,
} from "../secret-files.js";
import { loadRuntimeRelease, runtimeReleaseProblem, sameRelease } from "../runtime.js";
import { FleetService, type AuditEntry, type ReadinessCheck } from "./server.js";
import { createAuditSink, createJsonLogger, type Logger } from "./log.js";

function userOf(dsn: string): string | null {
  try {
    return decodeURIComponent(new URL(dsn).username) || null;
  } catch {
    return null;
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

/**
 * Parse FLEET_API_LISTEN. Loopback only, unless remote listening was
 * explicitly enabled AND the service serves TLS (never plain HTTP off-host).
 */
export function parseListen(value: string | undefined, opts: { remoteAllowed?: boolean } = {}): { host: string; port: number } {
  const raw = value?.trim() || "127.0.0.1:8787";
  const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(raw);
  if (!m) throw new Error(`FLEET_API_LISTEN must be host:port (got ${raw}).`);
  const host = m[1];
  const port = Number(m[2]);
  if (!LOOPBACK_HOSTS.has(host) && !opts.remoteAllowed) {
    throw new Error(
      `FLEET_API_LISTEN must be a loopback address (127.0.0.1 / ::1) unless FLEET_REMOTE_LISTEN_ENABLED=true and TLS is configured (got ${host}).`,
    );
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`FLEET_API_LISTEN port out of range: ${port}`);
  return { host: host.replace(/^\[|\]$/g, "") === "localhost" ? "127.0.0.1" : host.replace(/^\[|\]$/g, ""), port };
}

/**
 * TLS material from FLEET_TLS_CERT_FILE and the key. The key is either an
 * explicit FLEET_TLS_KEY_FILE (strict secretFileProblems: 0600, even inside
 * CREDENTIALS_DIRECTORY) or, when that is unset, the systemd credential
 * $CREDENTIALS_DIRECTORY/tls.key, validated by systemdCredentialProblems
 * (exact path and unit, no symlink/hard link, 0440 at most, source root 0600).
 */
export function loadTls(
  e: Record<string, string | undefined>,
  systemd: { host?: SystemdCredentialHost; sourceFile?: string } = {},
): { cert: Buffer; key: Buffer } | null {
  const certFile = e.FLEET_TLS_CERT_FILE?.trim();
  const explicitKey = e.FLEET_TLS_KEY_FILE?.trim();
  const credDir = e.CREDENTIALS_DIRECTORY?.trim();
  const keyFile = explicitKey || (credDir && certFile ? path.join(credDir, TLS_KEY_CREDENTIAL) : "");
  if (!certFile && !keyFile) return null;
  if (!certFile || !keyFile) throw new Error("Both FLEET_TLS_CERT_FILE and FLEET_TLS_KEY_FILE are required for TLS.");
  // The certificate is public; it must never name a secret (credential copy or its source).
  if (credDir && Object.keys(SYSTEMD_SECRET_CREDENTIALS).some((n) => path.resolve(certFile) === path.resolve(credDir, n))) {
    throw new Error(`Refusing TLS certificate: ${certFile} is a secret credential.`);
  }
  if (Object.values(SYSTEMD_SECRET_CREDENTIALS).includes(path.resolve(certFile))) {
    throw new Error(`Refusing TLS certificate: ${certFile} is a secret file.`);
  }
  const problems = explicitKey
    ? secretFileProblems(keyFile)
    : systemdCredentialProblems(keyFile, TLS_KEY_CREDENTIAL, credDir, systemd.sourceFile ?? DEFAULT_TLS_KEY_FILE, systemd.host);
  if (problems.length) throw new Error(`Refusing TLS key: ${problems.join("; ")}`);
  return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
}

/**
 * Phase 6: the certificate must be usable for the public hostname right
 * now: it covers the hostname, is inside its validity window (with at least
 * a day left) and matches the private key.
 */
export function tlsProblemsForHost(tls: { cert: Buffer | string; key: Buffer | string }, hostname: string, now = Date.now()): string[] {
  const problems: string[] = [];
  let x509: crypto.X509Certificate;
  try {
    x509 = new crypto.X509Certificate(tls.cert);
  } catch (err) {
    return [`certificate unreadable: ${err instanceof Error ? err.message : String(err)}`];
  }
  if (!(net.isIP(hostname) ? x509.checkIP(hostname) : x509.checkHost(hostname))) problems.push(`certificate does not cover ${hostname}`);
  if (Date.parse(x509.validFrom) > now) problems.push(`certificate not valid before ${x509.validFrom}`);
  if (Date.parse(x509.validTo) < now + 86_400_000) problems.push(`certificate expires ${x509.validTo}`);
  try {
    if (!x509.checkPrivateKey(crypto.createPrivateKey(tls.key))) problems.push("private key does not match the certificate");
  } catch {
    problems.push("private key unreadable");
  }
  return problems;
}

const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export interface RemoteConfig {
  hostname: string;
  publicListen: { host: string; port: number } | null;
  allowedOrigins: string[];
}

/** Phase 6 remote-controller configuration; throws on any unsafe combination. */
export function loadRemoteConfig(e: Record<string, string | undefined>, tls: { cert: Buffer | string; key: Buffer | string } | null): RemoteConfig | null {
  const remote = e.FLEET_REMOTE_LISTEN_ENABLED?.trim().toLowerCase() === "true";
  const publicListenRaw = e.FLEET_PUBLIC_LISTEN?.trim();
  const origins = (e.FLEET_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  for (const o of origins) {
    if (!/^https:\/\/[^/\s]+$/.test(o)) throw new Error(`FLEET_ALLOWED_ORIGINS entries must be https origins (got ${o}).`);
  }
  if (!remote) {
    if (publicListenRaw) throw new Error("FLEET_PUBLIC_LISTEN requires FLEET_REMOTE_LISTEN_ENABLED=true.");
    return null;
  }
  if (!tls) throw new Error("FLEET_REMOTE_LISTEN_ENABLED=true requires FLEET_TLS_CERT_FILE and FLEET_TLS_KEY_FILE.");
  const hostname = e.FLEET_PUBLIC_HOSTNAME?.trim() ?? "";
  if (!HOSTNAME_RE.test(hostname)) throw new Error("FLEET_REMOTE_LISTEN_ENABLED=true requires FLEET_PUBLIC_HOSTNAME (a DNS name).");
  const problems = tlsProblemsForHost(tls, hostname);
  if (problems.length) throw new Error(`Refusing remote listener: ${problems.join("; ")}`);
  return { hostname, publicListen: publicListenRaw ? parseListen(publicListenRaw, { remoteAllowed: true }) : null, allowedOrigins: origins };
}

/** Refuse to run as root, or as anyone but the expected dedicated service user. */
export function serviceUserProblem(e: Record<string, string | undefined>, who: { uid: number; username: string } = currentUser()): string | null {
  if (who.uid === 0) return "The fleet service must not run as root.";
  const expected = e.FLEET_SERVICE_EXPECTED_USER?.trim();
  if (expected && who.username !== expected) return `The fleet service must run as ${expected} (running as ${who.username}).`;
  return null;
}

function currentUser(): { uid: number; username: string } {
  const u = os.userInfo();
  return { uid: u.uid, username: u.username };
}

export interface StartedFleetService {
  service: FleetService;
  url: string;
  /** Phase 6: https://<FLEET_PUBLIC_HOSTNAME>:<port> when the remote listener is enabled. */
  publicUrl?: string | null;
  /** Graceful stop: drain, stop reaper, close pools. Idempotent. */
  stop(): Promise<void>;
}

export async function startFleetServiceFromEnv(
  e: Record<string, string | undefined>,
  opts: { log?: Logger; installSignalHandlers?: boolean; user?: { uid: number; username: string } } = {},
): Promise<StartedFleetService> {
  const log = opts.log ?? createJsonLogger();
  const userProblem = serviceUserProblem(e, opts.user);
  if (userProblem) throw new Error(userProblem);
  if (e.FLEET_ADMIN_DATABASE_URL?.trim()) {
    throw new Error("The fleet service must not hold FLEET_ADMIN_DATABASE_URL (admin credentials are for the operator CLI only).");
  }
  const serviceUrl = (e.FLEET_SERVICE_DATABASE_URL || e.FLEET_CONTROLLER_DATABASE_URL || e.DATABASE_URL)?.trim();
  const agentUrl = e.FLEET_AGENT_DATABASE_URL?.trim();
  if (!serviceUrl) throw new Error("FLEET_SERVICE_DATABASE_URL (restricted controller role) is not configured.");
  if (!agentUrl) throw new Error("FLEET_AGENT_DATABASE_URL (restricted agent role) is not configured.");
  if (userOf(agentUrl) === null || userOf(agentUrl) === userOf(serviceUrl)) {
    throw new Error("FLEET_AGENT_DATABASE_URL must use the restricted agent role, not the controller/admin user.");
  }
  const tls = loadTls(e);
  const remoteRequested = e.FLEET_REMOTE_LISTEN_ENABLED?.trim().toLowerCase() === "true";
  if (remoteRequested && !tls) throw new Error("FLEET_REMOTE_LISTEN_ENABLED=true requires FLEET_TLS_CERT_FILE and FLEET_TLS_KEY_FILE.");
  const remote = loadRemoteConfig(e, tls);
  // With a separate public HTTPS listener, FLEET_API_LISTEN is the loopback plain-HTTP admin listener.
  const listen = parseListen(e.FLEET_API_LISTEN, { remoteAllowed: remoteRequested && !!tls && !remote?.publicListen });
  const releaseProblem = runtimeReleaseProblem(e);
  const release = loadRuntimeRelease(e);

  const schema = e.FLEET_PG_SCHEMA?.trim() || undefined;
  const serviceRole = e.FLEET_SERVICE_ROLE?.trim() || "fleet_service";
  const agentRole = e.FLEET_AGENT_ROLE?.trim() || "fleet_agent";
  const controller = new PgFleetStore({ connectionString: serviceUrl, schema, applicationName: "automaton-fleet-service" });
  const agent = new PgAgentGateway({ connectionString: agentUrl, schema });
  const closePools = async () => {
    await agent.close();
    await controller.close();
  };

  try {
    const health = await controller.health();
    if (!health.ok) throw new Error(`Fleet registry unhealthy: ${health.error ?? "unknown"} (run pnpm fleet:migrate).`);
    const who = await controller.connectionIdentity();
    if (who.isOwner || who.superuser) {
      throw new Error(
        `FLEET_SERVICE_DATABASE_URL must use the restricted service role (fleet_service_login), not ${who.isOwner ? "the schema owner" : "a superuser"} ${who.user}.`,
      );
    }
    const agentProblems = await agent.selfCheck();
    if (agentProblems.length) throw new Error(`Agent DB role is not restricted: ${agentProblems.join("; ")}`);
    const audit = await controller.auditPrivileges({ agentRoles: [agentRole, userOf(agentUrl)!], serviceRoles: [serviceRole, who.user] });
    const privProblems = problemsFor(audit, [agentRole, userOf(agentUrl)!, serviceRole, who.user]);
    if (privProblems.length) throw new Error(`Database privileges are too broad: ${privProblems.join("; ")}`);

    const state = await controller.getState();
    const approved = state.runtime && state.build ? { ...state.runtime, ...state.build } : null;
    if (release && approved && !sameRelease(release, approved)) {
      throw new Error(
        `Runtime release mismatch: service pins ${release.repo}@${release.commit} (build ${release.buildId}) but the registry approves ` +
          `${approved.repo}@${approved.commit} (build ${approved.buildId}). Refusing to start.`,
      );
    }
    if (!release) log("warn", "runtime_release_unpinned", { reason: releaseProblem, effect: "claims and activations are refused" });

    const auditSink: (entry: AuditEntry) => void = createAuditSink(log, e.FLEET_AUDIT_LOG?.trim() || undefined);

    let privCache: { at: number; problems: string[] } = { at: Date.now(), problems: [] };
    const realReplicationEnabled = e.REAL_REPLICATION_ENABLED?.trim().toLowerCase() === "true";
    const service = new FleetService({
      admin: controller,
      agent,
      realReplicationEnabled,
      reaperIntervalMs: e.FLEET_REAPER_INTERVAL_MS ? Number(e.FLEET_REAPER_INTERVAL_MS) : undefined,
      drainMs: e.FLEET_SHUTDOWN_DRAIN_MS ? Number(e.FLEET_SHUTDOWN_DRAIN_MS) : undefined,
      audit: auditSink,
      release,
      tls: tls ?? undefined,
      allowedOrigins: remote?.allowedOrigins ?? [],
      readinessChecks: async (): Promise<Record<string, ReadinessCheck>> => {
        if (Date.now() - privCache.at > 60_000) {
          const a = await controller.auditPrivileges({ agentRoles: [agentRole, userOf(agentUrl)!], serviceRoles: [serviceRole, who.user] });
          privCache = { at: Date.now(), problems: problemsFor(a, [agentRole, userOf(agentUrl)!, serviceRole, who.user]) };
        }
        return { privileges: privCache.problems.length ? { ok: false, detail: privCache.problems.join("; ") } : { ok: true } };
      },
    });
    let url: string;
    let publicUrl: string | null = null;
    if (remote?.publicListen) {
      url = (await service.listenAdmin(listen.port, listen.host)).url;
      const pub = await service.listen(remote.publicListen.port, remote.publicListen.host);
      publicUrl = `https://${remote.hostname}:${pub.port}`;
    } else {
      url = (await service.listen(listen.port, listen.host)).url;
    }
    service.startReaper();
    log("info", "service_started", {
      url,
      publicUrl,
      dbUser: who.user,
      realReplicationEnabled,
      runtimeRelease: release ? `${release.repo}@${release.commit}` : null,
      pid: process.pid,
    });

    let stopping: Promise<void> | null = null;
    const stop = () =>
      (stopping ??= (async () => {
        log("info", "shutdown_started", {});
        await service.close();
        await closePools();
        log("info", "shutdown_complete", {});
      })());

    if (opts.installSignalHandlers) {
      let signals = 0;
      const onSignal = (sig: string) => {
        signals++;
        if (signals > 1) {
          log("warn", "shutdown_forced", { signal: sig });
          process.exit(1);
        }
        void stop().then(
          () => process.exit(0),
          (err) => {
            log("error", "shutdown_failed", { error: err instanceof Error ? err.message : String(err) });
            process.exit(1);
          },
        );
      };
      process.on("SIGTERM", () => onSignal("SIGTERM"));
      process.on("SIGINT", () => onSignal("SIGINT"));
    }
    return { service, url, publicUrl, stop };
  } catch (err) {
    await closePools();
    throw err;
  }
}

if (process.argv[1] && /fleet[\\/]service[\\/]main\.(ts|js)$/.test(process.argv[1])) {
  const log = createJsonLogger();
  process.on("uncaughtException", (err) => {
    log("fatal", "uncaught_exception", { error: err.message });
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    log("fatal", "unhandled_rejection", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
  let loaded;
  try {
    loaded = loadServiceEnv();
  } catch (err) {
    log("fatal", "startup_failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
  for (const w of loaded.warnings) log("warn", "config_warning", { warning: w });
  startFleetServiceFromEnv(loaded.env, { log, installSignalHandlers: true }).catch((err) => {
    log("fatal", "startup_failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
```

## `src/fleet/service/rate-limit.ts`

sha256 `dd9b75f587539bb153edf535c5b9785a8136766e60670ca73152c0583e68a3fb` · 1868 bytes · 62 lines

```ts
/**
 * Token-bucket rate limiter (in memory, per service instance).
 *
 * Keys are agent ids (claimed from the token, before any DB work) and remote
 * addresses (for authentication failures). The map is bounded so a flood of
 * distinct keys cannot exhaust memory. Multi-instance deployments rate-limit
 * per instance; the per-request nonce ledger (replay protection) is shared
 * in the database.
 */

export interface RateLimit {
  /** Burst size. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSec: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: RateLimit,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  private bucket(key: string): Bucket {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) {
        // Drop the oldest entry (Map preserves insertion order).
        const first = this.buckets.keys().next().value;
        if (first !== undefined) this.buckets.delete(first);
      }
      b = { tokens: this.limit.capacity, at: t };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.limit.capacity, b.tokens + ((t - b.at) / 1000) * this.limit.refillPerSec);
    b.at = t;
    return b;
  }

  /** Take `cost` tokens; false (and nothing taken) when the bucket is empty. */
  take(key: string, cost = 1): boolean {
    const b = this.bucket(key);
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  /** Seconds until `cost` tokens are available. */
  retryAfterS(key: string, cost = 1): number {
    const b = this.bucket(key);
    return b.tokens >= cost ? 0 : Math.ceil((cost - b.tokens) / this.limit.refillPerSec);
  }
}
```

## `src/fleet/service/server-signing.ts`

sha256 `44ea0917d57692c3fe330efc39f0d076a1ca43750bc6eb37c016c37463b1f29c` · 936 bytes · 18 lines

```ts
/**
 * Request signing shared by the fleet service and the agent client (Phase 5).
 * Kept separate from server.ts so agents never import service internals.
 */

import crypto from "crypto";

export const SIG_HEADERS = Object.freeze({ ts: "x-fleet-timestamp", nonce: "x-fleet-nonce", sig: "x-fleet-signature" });

/** Canonical string an agent signs with its session token (HMAC-SHA256, hex). */
export function canonicalRequest(method: string, path: string, ts: string, nonce: string, body: Buffer | string): string {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  return `${method.toUpperCase()}\n${path}\n${ts}\n${nonce}\n${bodyHash}`;
}

export function signRequest(sessionToken: string, method: string, path: string, ts: string, nonce: string, body: Buffer | string): string {
  return crypto.createHmac("sha256", sessionToken).update(canonicalRequest(method, path, ts, nonce, body)).digest("hex");
}
```

## `src/fleet/service/server.ts`

sha256 `1c5c9329c98604f3998b7c24d3978f30f380c2c7dc4da28136e66abf0d9735ee` · 45102 bytes · 908 lines

```ts
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
import { redactDetail } from "../redact.js";
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
  /** Memoised per request: a signed request's nonce is consumed exactly once. */
  cred?: { agentId: string; token: string };
  bearerCred?: { agentId: string; token: string };
}

/**
 * Central route authorization policy (FLEET-KI-4, default deny).
 *
 * Every /v1 route FleetService.route() serves has exactly one entry, keyed
 * "METHOD /path". route() consults it BEFORE dispatching, so a route added to
 * the handler without a policy entry is unreachable (404), and the test
 * "route-policy completeness" fails. `auth` names how the caller is
 * identified; `witness: true` is the explicit opt-in for identities with the
 * restricted capability scope 'witness'. Any other scope is denied every
 * authenticated route. Public routes identify nobody and grant no authority.
 */
export type RouteAuth = "public" | "bearer" | "session";
export interface RoutePolicy {
  auth: RouteAuth;
  /** Opt-in for capability scope 'witness'. Irrelevant for public routes. */
  witness: boolean;
}

export const ROUTE_POLICY: Readonly<Record<string, Readonly<RoutePolicy>>> = Object.freeze({
  "GET /v1/health": { auth: "public", witness: false },
  "GET /v1/state": { auth: "session", witness: false },
  "GET /v1/members": { auth: "session", witness: false },
  "GET /v1/self": { auth: "session", witness: true },
  "POST /v1/session": { auth: "bearer", witness: true },
  "POST /v1/heartbeat": { auth: "session", witness: true },
  "POST /v1/health/challenge": { auth: "session", witness: true },
  "POST /v1/status": { auth: "session", witness: false },
  "POST /v1/replication/request": { auth: "session", witness: false },
  "POST /v1/replication/claim": { auth: "session", witness: false },
  "POST /v1/replication/provisioning": { auth: "session", witness: false },
  "POST /v1/replication/activate": { auth: "session", witness: false },
  "POST /v1/replication/fail": { auth: "session", witness: false },
  "POST /v1/replication/reconcile": { auth: "session", witness: false },
  "POST /v1/replication/release": { auth: "session", witness: false },
  "POST /v1/children/terminal": { auth: "session", witness: false },
  "POST /v1/capital/propose": { auth: "session", witness: false },
  "POST /v1/wallet/spend-request": { auth: "session", witness: false },
});

/**
 * Pure policy decision. "unknown": no policy entry (never dispatched).
 * "deny": the scope may not use this route. Unknown scopes are denied every
 * authenticated route; 'full' keeps the pre-v7 behaviour.
 */
export function routeDecision(method: string, path: string, scope: string | null): "allow" | "deny" | "unknown" {
  const policy = ROUTE_POLICY[`${method} ${path}`];
  if (!policy) return "unknown";
  if (policy.auth === "public") return "allow";
  if (scope === "full") return "allow";
  if (scope === "witness") return policy.witness ? "allow" : "deny";
  return "deny";
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
  /**
   * Browser origins allowed to call the API (Phase 6). Requests carrying any
   * other Origin header are refused; agents send none. Default: none.
   */
  allowedOrigins?: string[];
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

const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** True for a loopback bind address (local administration only). */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_PEERS.has(host.replace(/^\[|\]$/g, "")) || host === "localhost";
}

export class FleetService {
  private servers: http.Server[] = [];
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

  /** Audit sink (service log + JSONL). The detail is redacted here, before any sink sees it. */
  private audit(event: string, agentId: string | null, detail: Record<string, unknown> = {}): void {
    try {
      this.opts.audit?.({ ts: new Date().toISOString(), event, agentId, detail: redactDetail(detail) });
    } catch {
      // audit sink failures must not break request handling
    }
  }

  /**
   * Durable audit (fleet_events) + service log. Never throws. Redacted once;
   * the audit sink and the database receive the same redacted detail.
   */
  private async recordDb(event: string, agentId: string | null, detail: Record<string, unknown>): Promise<void> {
    const safe = redactDetail(detail);
    this.audit(event, agentId, safe);
    await this.opts.admin.recordEvent(event, agentId, "fleet-service", safe).catch(() => {});
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
    return this.bind(port, host, !!this.opts.tls);
  }

  /**
   * Phase 6: plain-HTTP listener for local administration only. Refuses any
   * non-loopback address; remote access is HTTPS-only (listen() with TLS).
   */
  async listenAdmin(port = 0, host = "127.0.0.1"): Promise<{ host: string; port: number; url: string }> {
    if (!isLoopbackHost(host)) throw new Error(`The plain-HTTP admin listener must bind to loopback (got ${host}).`);
    return this.bind(port, host, false);
  }

  private async bind(port: number, host: string, tls: boolean): Promise<{ host: string; port: number; url: string }> {
    if (!tls && !isLoopbackHost(host)) {
      throw new Error(`Refusing plain-HTTP binding on non-loopback address ${host}: remote access requires TLS.`);
    }
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => void this.handle(req, res, tls);
    const server: http.Server = tls
      ? https.createServer({ cert: this.opts.tls!.cert, key: this.opts.tls!.key, minVersion: "TLSv1.2" }, handler)
      : http.createServer(handler);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
    this.servers.push(server);
    const addr = server.address() as AddressInfo;
    const h = addr.family === "IPv6" ? `[${addr.address}]` : addr.address;
    return { host: addr.address, port: addr.port, url: `${tls ? "https" : "http"}://${h}:${addr.port}` };
  }

  async close(): Promise<void> {
    this.draining = true;
    this.stopReaper();
    const servers = this.servers;
    this.servers = [];
    if (!servers.length) return;
    const closed = Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    for (const s of servers) s.closeIdleConnections?.();
    const deadline = Date.now() + (this.opts.drainMs ?? 10_000);
    while ((this.inFlight > 0 || this.reaping) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    for (const s of servers) s.closeAllConnections?.();
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
    if (ctx.bearerCred) return ctx.bearerCred;
    const h = req.headers.authorization ?? "";
    const m = /^Bearer (\S{1,256})$/.exec(h);
    const agentId = m ? agentIdFromToken(m[1]) : null;
    if (!m || !agentId) return this.authFailure(ctx, path, m ? "malformed token" : "missing bearer token");
    ctx.agentId = agentId;
    ctx.bearerCred = { agentId, token: m[1] };
    return ctx.bearerCred;
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
    if (ctx.cred) return ctx.cred;
    const h = req.headers.authorization ?? "";
    const m = /^FleetSession (\S{1,256})$/.exec(h);
    if (!m) {
      if (/^Bearer /.test(h) && this.opts.allowLegacyBearer) {
        const cred = await this.bearer(req, path, ctx);
        this.rateLimit(this.perAgent, cred.agentId);
        ctx.cred = cred;
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
    ctx.cred = { agentId, token };
    return ctx.cred;
  }

  /**
   * Route authorization (default deny), run by route() before any handler.
   * The caller is identified exactly as the handler would identify it (the
   * memoised bearer or signed-session check). Its capability scope is read
   * by agent id; 'full' proceeds unchanged. A restricted identity on a route
   * it has not been granted is authenticated for real (api_whoami) before the
   * denial is recorded, so an invented token cannot forge scope_denied events;
   * either way the handler never runs.
   */
  private async authorize(method: string, path: string, req: http.IncomingMessage, ctx: RequestCtx): Promise<void> {
    const policy = ROUTE_POLICY[`${method} ${path}`];
    if (!policy) throw new HttpError(404, "FLEET_NOT_FOUND", "no such endpoint");
    if (policy.auth === "public") return;
    const cred = policy.auth === "bearer" ? await this.bearer(req, path, ctx) : await this.credentials(req, path, ctx);
    const scope = await this.opts.admin.capabilityScope(cred.agentId);
    // No such agent: the handler's own authentication rejects it (unchanged behaviour).
    if (scope === null) return;
    if (routeDecision(method, path, scope) === "allow") return;
    const who = await this.opts.agent.whoami(cred.agentId, cred.token);
    if (!who.ok) {
      const gone = who.code === "FLEET_AGENT_DEAD" || who.code === "FLEET_AGENT_QUARANTINED";
      if (!gone) this.audit("api_auth_failed", null, { path, code: who.code });
      throw new HttpError(gone ? 410 : 401, who.code, "agent credential rejected");
    }
    await this.recordDb("scope_denied", cred.agentId, { method, path, scope, layer: "service", ip: ctx.ip });
    throw new HttpError(403, "FLEET_SCOPE_DENIED", "this identity's capability scope does not allow this endpoint");
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

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, tls = false): Promise<void> {
    const path = (req.url ?? "/").split("?")[0];
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    if (tls) res.setHeader("strict-transport-security", "max-age=31536000");
    // Phase 6: browsers may only call from explicitly allowed origins; agents send no Origin.
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (!(this.opts.allowedOrigins ?? []).includes(origin)) {
        this.audit("api_origin_denied", null, { path, ip: req.socket.remoteAddress ?? "unknown" });
        this.send(res, 403, { ok: false, code: "FLEET_ORIGIN_DENIED", reason: "origin not allowed" });
        return;
      }
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
      if (req.method === "OPTIONS") {
        res.setHeader("access-control-allow-methods", "GET, POST");
        res.setHeader("access-control-allow-headers", `authorization, content-type, ${SIG_HEADERS.ts}, ${SIG_HEADERS.nonce}, ${SIG_HEADERS.sig}`);
        res.writeHead(204).end();
        return;
      }
    }
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
      // Detailed readiness is for local administration only.
      if (!LOOPBACK_PEERS.has(req.socket.remoteAddress ?? "")) {
        this.send(res, 404, { ok: false, code: "FLEET_NOT_FOUND", reason: "no such endpoint" });
        return;
      }
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

  /** The caller's own reservation; the provisioning key, when sent, must be that reservation's. */
  private async ownLease(reservationId: string, body: Record<string, unknown>, callerId: string, action: string) {
    const key = str(body, "provisioningKey", 26, false);
    const lease = await this.opts.admin.getReservation(reservationId);
    if (!lease || lease.reservationId !== reservationId || lease.parentAgentId !== callerId || (key && key !== reservationId)) {
      await this.recordDb("authorization_denied", null, { action, caller: callerId, reservationId });
      throw new HttpError(403, "FLEET_NOT_AUTHORIZED", "not your reservation");
    }
    return lease;
  }

  private async route(method: string, path: string, req: http.IncomingMessage, ctx: RequestCtx): Promise<Record<string, unknown>> {
    const { admin, agent } = this.opts;
    // Default deny: no policy entry, or a scope not granted this route, never reaches a handler.
    await this.authorize(method, path, req, ctx);

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
        if (phase !== "sandbox_intent" && phase !== "sandbox_created" && phase !== "verifying") {
          throw new HttpError(400, "FLEET_BAD_REQUEST", "unknown phase");
        }
        const lease = await this.ownLease(reservationId, body, caller.agentId, "provisioning");
        if (phase === "sandbox_intent") {
          const intent = await admin.recordSandboxIntent(lease.agentId, str(body, "sandboxName", 64), caller.agentId);
          return { recorded: true, intent: { sandboxName: intent.sandboxName, sandboxId: intent.sandboxId, attempts: intent.attempts } };
        }
        await admin.reportProvisioning(lease.agentId, phase, str(body, "sandboxId", 128, false) || null, caller.agentId);
        return { recorded: true };
      }

      case "/v1/replication/reconcile": {
        // Phase 6: the parent reports what it found when it looked up an
        // uncertain sandbox by its deterministic name.
        const caller = await this.authenticate(req, path, ctx);
        const reservationId = str(body, "reservationId", 26);
        const outcome = str(body, "outcome", 16);
        if (outcome !== "found" && outcome !== "absent" && outcome !== "unknown") throw new HttpError(400, "FLEET_BAD_REQUEST", "unknown outcome");
        await this.ownLease(reservationId, body, caller.agentId, "reconcile");
        const r = await admin.reconcileProvisioning(reservationId, outcome, str(body, "sandboxId", 128, false) || null, caller.agentId);
        return { reconciled: true, agentStatus: r.agentStatus ?? null };
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
        const provisioningKey = str(body, "provisioningKey", 26, false);
        if (provisioningKey && provisioningKey !== reservationId) throw new HttpError(403, "FLEET_NOT_AUTHORIZED", "provisioning key mismatch");
        const result = await admin.activate(lease.agentId, {
          provisioningKey: provisioningKey || null,
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
```

## `src/fleet/service/terminator.ts`

sha256 `9aa6500b5575233dcbc30690278a108153f9955f94475e8b63e6c3c77087ccd2` · 1416 bytes · 34 lines

```ts
/**
 * Sandbox termination (Phase 4)
 *
 * When an agent dies with a known sandbox, the registry enqueues a
 * termination (fleet_sandbox_terminations) and the fleet service works the
 * queue through a SandboxTerminator. Only the controller terminates
 * sandboxes; agents cannot.
 *
 * The Conway API currently offers no way to stop or delete a sandbox
 * (ConwayClient.deleteSandbox is a no-op upstream), so the default
 * terminator reports "unsupported" and the termination stays recorded as an
 * unresolved zombie. `pnpm fleet:doctor` treats that as a blocker for real
 * replication rather than pretending the sandbox is gone.
 */

export type TerminationOutcome = { status: "terminated" } | { status: "unsupported"; reason: string };

export interface SandboxTerminator {
  readonly name: string;
  /** Whether this terminator can actually stop sandboxes (doctor/readiness). */
  readonly guaranteed: boolean;
  terminate(sandboxId: string): Promise<TerminationOutcome>;
}

export const CONWAY_TERMINATION_UNSUPPORTED =
  "Conway API has no sandbox stop/delete endpoint (deleteSandbox is a no-op); the sandbox may still be running.";

export class UnsupportedSandboxTerminator implements SandboxTerminator {
  readonly name = "unsupported";
  readonly guaranteed = false;
  async terminate(): Promise<TerminationOutcome> {
    return { status: "unsupported", reason: CONWAY_TERMINATION_UNSUPPORTED };
  }
}
```
