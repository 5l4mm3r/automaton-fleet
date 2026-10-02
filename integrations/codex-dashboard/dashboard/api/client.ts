/**
 * The gateway client (LIVE only). Same-origin JSON over the dashboard service's `/api/*`; the session is an HttpOnly,
 * Secure, SameSite=Strict cookie the browser holds; the CSRF token is kept for this tab only (sessionStorage, never
 * localStorage or a cookie). Sensitive operations take a fresh passkey step-up bound to the operation and its EXACT
 * argument string (serialised once, reused for the step-up and the call).
 *
 * Fail-closed rules:
 *  • no fallback to anything — an unreachable gateway is an error the UI must show;
 *  • writes are NEVER retried automatically (a retry after an unknown outcome could act twice): a network failure on a
 *    write is FLEET_OUTCOME_UNKNOWN, and the adapter re-reads the Fleet so the owner sees what actually happened;
 *  • reads are retried once on a network error only.
 */
import { FleetApiError } from "./errors";
import { browserWebAuthn, type WebAuthnPort } from "./webauthn";
import { SENSITIVE_OPS } from "./operations-meta";

export interface TokenStore {
  get(): string | null;
  set(v: string): void;
  clear(): void;
}

/** The tab's CSRF token: sessionStorage when available, else memory (private mode). */
export function tabTokenStore(key = "fleet_csrf"): TokenStore {
  let mem: string | null = null;
  return {
    get: () => { try { return sessionStorage.getItem(key) ?? mem; } catch { return mem; } },
    set: (v) => { mem = v; try { sessionStorage.setItem(key, v); } catch { /* memory only */ } },
    clear: () => { mem = null; try { sessionStorage.removeItem(key); } catch { /* ignore */ } },
  };
}

export interface GatewayClientOptions {
  /** Default: same origin (""). Only set for a development proxy; never hard-code an installation. */
  baseUrl?: string;
  fetch?: typeof fetch;
  webauthn?: WebAuthnPort;
  csrf?: TokenStore;
  /** Called on any 401 (session ended): the UI returns to sign-in. */
  onSignedOut?: () => void;
}

export class GatewayClient {
  readonly mode = "live" as const;
  private readonly base: string;
  private readonly f: typeof fetch;
  readonly webauthn: WebAuthnPort;
  readonly csrf: TokenStore;
  private readonly signedOut: () => void;

  constructor(o: GatewayClientOptions = {}) {
    this.base = (o.baseUrl ?? "").replace(/\/+$/, "");
    this.f = o.fetch ?? ((input, init) => fetch(input, init));
    this.webauthn = o.webauthn ?? browserWebAuthn;
    this.csrf = o.csrf ?? tabTokenStore();
    this.signedOut = o.onSignedOut ?? (() => {});
  }

  private async parse(r: Response): Promise<Record<string, any>> {
    const j = (await r.json().catch(() => ({ ok: false, code: "FLEET_BAD_RESPONSE" }))) as Record<string, any>;
    if (r.status === 401) { this.csrf.clear(); this.signedOut(); }
    return j;
  }

  /** POST JSON; throws FleetApiError("FLEET_NETWORK") when the request may not have reached the gateway. */
  async post(path: string, body: unknown): Promise<{ status: number; json: Record<string, any> }> {
    const t = this.csrf.get();
    let r: Response;
    try {
      r = await this.f(`${this.base}${path}`, { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json", ...(t ? { "X-CSRF": t } : {}) }, body: JSON.stringify(body ?? {}) });
    } catch {
      throw new FleetApiError("FLEET_NETWORK");
    }
    return { status: r.status, json: await this.parse(r) };
  }

  async getJson(path: string): Promise<{ status: number; json: Record<string, any> }> {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await this.f(`${this.base}${path}`, { credentials: "same-origin", cache: "no-store" });
        return { status: r.status, json: await this.parse(r) };
      } catch {
        if (attempt >= 1) throw new FleetApiError("FLEET_UNAVAILABLE");
      }
    }
  }

  /** One gateway read (ordinary authentication). */
  async read<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    const { status, json } = await this.getJson(`/api/read?op=${encodeURIComponent(op)}&args=${encodeURIComponent(JSON.stringify(args))}`);
    if (!json.ok) throw new FleetApiError(json.code ?? "FLEET_UNAVAILABLE", json.reason, status);
    return json.result as T;
  }

  /**
   * One state change. A sensitive operation first asks the authenticator for a fresh passkey assertion bound to this
   * exact operation and argument string; the gateway consumes it once (a replay is refused).
   */
  async call<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    const a = JSON.stringify(args);
    let stepup: string | undefined;
    if (SENSITIVE_OPS.has(op)) {
      const o = await this.post("/api/stepup/options", { op, args: a });
      if (!o.json.ok) throw new FleetApiError(o.json.code ?? "FLEET_STEPUP_REQUIRED", undefined, o.status);
      let assertion: Record<string, any>;
      try {
        assertion = await this.webauthn.get(o.json.options);
      } catch {
        throw new FleetApiError("FLEET_STEPUP_CANCELLED");
      }
      const v = await this.post("/api/stepup/verify", { op, args: a, response: assertion });
      if (!v.json.ok) throw new FleetApiError(v.json.code ?? "FLEET_PASSKEY_INVALID", undefined, v.status);
      stepup = v.json.stepup;
    }
    let r: { status: number; json: Record<string, any> };
    try {
      r = await this.post("/api/call", { op, args: a, stepup });
    } catch (e) {
      // The request may or may not have been applied: never retry automatically.
      if (e instanceof FleetApiError && e.code === "FLEET_NETWORK") throw new FleetApiError("FLEET_OUTCOME_UNKNOWN");
      throw e;
    }
    if (!r.json.ok) throw new FleetApiError(r.json.code ?? "FLEET_UNAVAILABLE", r.json.reason, r.status);
    // Several FleetController functions report a refusal inside their result ({ ok: false, code, reason }) rather than
    // as a gateway error (e.g. insufficient funds): that is a refusal, never a success.
    const res = r.json.result as Record<string, unknown> | null;
    if (res && typeof res === "object" && !Array.isArray(res) && op !== "reveal_take") {
      const why = typeof res.reason === "string" ? res.reason : undefined;
      if (res.ok === false && typeof res.code === "string") throw new FleetApiError(res.code, why, r.status);
      // Money operations answer a status: "refused" (a constitutional or balance limit) or "needs_acknowledgement" (above
      // the advised safe amount — repeat with acknowledge: true after the owner reads the warnings).
      if (res.status === "refused" || res.status === "rejected") throw new FleetApiError(typeof res.code === "string" ? res.code : "FLEET_REFUSED", why, r.status);
      if (res.status === "needs_acknowledgement") throw new FleetApiError("FLEET_ACKNOWLEDGE_REQUIRED", Array.isArray(res.warnings) ? res.warnings.join("; ").slice(0, 300) : why, r.status);
    }
    return r.json.result as T;
  }
}
