/**
 * FleetApiClient (Phase 3) — the agent's view of the fleet registry.
 *
 * Holds only this agent's own bearer credential (from
 * ~/.automaton/fleet-credentials.json, mode 0600) and the service URL. It
 * has no database credentials and cannot do anything the fleet service's
 * restricted API does not allow for this agent.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { createBoundGrant, type ClaimedGrant } from "../grants.js";
import { FleetBypassError } from "../registry.js";
import { FleetRuntimeError } from "../runtime.js";
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

export interface FleetApiClientOptions {
  baseUrl: string;
  agentId: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
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

  constructor(opts: FleetApiClientOptions) {
    this.baseUrl = validateServiceUrl(opts.baseUrl);
    if (agentIdFromToken(opts.token) !== opts.agentId) throw new Error("fleet token does not belong to this agent");
    this.agentId = opts.agentId;
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
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

  private async call<T>(method: "GET" | "POST", p: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${p}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
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
    const r = await this.call<{ alive: boolean }>("POST", "/v1/heartbeat", {}).catch((err) => {
      if (err instanceof ApiError) return { alive: false };
      throw err;
    });
    return r.alive === true;
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
      return r.claimed;
    } catch (err) {
      if (err instanceof ApiError) throw new FleetBypassError(`Replication denied: ${err.message}`);
      throw err;
    }
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
      return await this.call<ActivationResult>("POST", "/v1/replication/activate", {
        reservationId: this.reservationOf(agentId),
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

  /** Recorded for audit only; an agent never changes another agent's state (the reaper does). */
  async markDeadByLocalChildId(localChildId: string, reason: string): Promise<boolean> {
    await this.call("POST", "/v1/children/terminal", { localChildId, state: reason.slice(0, 32) }).catch(() => {});
    return false;
  }

  /** Voluntary retirement: marks this agent dead and releases its slot. */
  async retire(reason: string): Promise<boolean> {
    return (await this.call<{ changed: boolean }>("POST", "/v1/status", { status: "dead", reason: reason.slice(0, 300) })).changed;
  }
}
