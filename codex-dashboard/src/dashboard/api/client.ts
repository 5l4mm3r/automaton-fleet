/**
 * The gateway client (LIVE only). Same-origin JSON over the dashboard service's `/api/*`; the session is an HttpOnly,
 * Secure, SameSite=Strict cookie the browser holds; the CSRF token is kept for this tab only (sessionStorage, never
 * localStorage or a cookie). Sensitive operations take a fresh passkey step-up bound to the operation and its EXACT
 * argument string (serialised once, reused for the step-up and the call).
 *
 * Tabs: the CSRF token is issued once, at sign-in, to the tab that signed in; the session cookie is shared by every tab.
 * A tab opened afterwards (a new tab, the /hq-preview/ build in another tab) therefore holds the session but not the
 * token, and the gateway refuses its writes (FLEET_CSRF) — correctly. Such a tab asks this dashboard's other open tabs
 * for the token over a BroadcastChannel, which browsers scope to this exact origin: only same-origin script (already
 * trusted with the session) can take part, a cross-site page never can, so the CSRF defence is unchanged. A tab that
 * signs in announces its new token so other tabs drop their stale one. No tab can answer → the gateway refuses the
 * write (FLEET_CSRF, before anything ran: dash_call checks the token first) and the owner is asked to verify this tab
 * (passkey + TOTP); an ended session still answers 401 and returns to sign-in. A write refused with FLEET_CSRF is
 * retried once, only with a different, current token from another tab.
 *
 * Fail-closed rules:
 *  • no fallback to anything — an unreachable gateway is an error the UI must show;
 *  • writes are NEVER retried automatically (a retry after an unknown outcome could act twice): a network failure on a
 *    write is FLEET_OUTCOME_UNKNOWN, and the adapter re-reads the Fleet so the owner sees what actually happened;
 *  • reads are retried once on a network error only.
 */
import { FleetApiError } from "./errors";
import type { Json } from "./types";
import { browserWebAuthn, type WebAuthnPort } from "./webauthn";
import { SENSITIVE_OPS } from "./operations-meta";

export interface TokenStore {
  get(): string | null;
  set(v: string): void;
  clear(): void;
}

/** Same-origin hand-off of the CSRF token between this dashboard's open tabs (see the header). */
export interface TokenShare {
  /** Ask the other open tabs for the current token; null when none answers within `ms`. */
  request(ms: number): Promise<string | null>;
  /** This tab has a new token (it signed in): other tabs adopt it. */
  announce(token: string): void;
}
const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/;
export function broadcastTokenShare(store: TokenStore, name = "fleet-csrf-v1"): TokenShare | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const ch = new BroadcastChannel(name);
  (ch as unknown as { unref?: () => void }).unref?.(); // (Node: never keeps a process alive; browsers have no unref)
  const waiting = new Map<string, (t: string) => void>();
  ch.onmessage = (e: MessageEvent) => {
    const m = (e.data ?? {}) as { kind?: unknown; id?: unknown; token?: unknown };
    if (m.kind === "need" && typeof m.id === "string") { const t = store.get(); if (t) ch.postMessage({ kind: "have", id: m.id, token: t }); }
    else if (m.kind === "have" && typeof m.id === "string" && typeof m.token === "string" && TOKEN_RE.test(m.token)) waiting.get(m.id)?.(m.token);
    else if (m.kind === "rotated" && typeof m.token === "string" && TOKEN_RE.test(m.token)) store.set(m.token);
  };
  return {
    request: (ms) => new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      const done = (t: string | null) => { waiting.delete(id); clearTimeout(timer); resolve(t); };
      const timer = setTimeout(() => done(null), ms);
      waiting.set(id, (t) => done(t));
      ch.postMessage({ kind: "need", id });
    }),
    announce: (token) => ch.postMessage({ kind: "rotated", token }),
  };
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
  /** Token hand-off between this dashboard's tabs (default: a same-origin BroadcastChannel; null disables it). */
  share?: TokenShare | null;
  /** Called on any 401 (session ended): the UI returns to sign-in. */
  onSignedOut?: () => void;
}

export class GatewayClient {
  readonly mode = "live" as const;
  private readonly base: string;
  private readonly f: typeof fetch;
  readonly webauthn: WebAuthnPort;
  readonly csrf: TokenStore;
  private readonly share: TokenShare | null;
  private readonly signedOut: () => void;

  constructor(o: GatewayClientOptions = {}) {
    this.base = (o.baseUrl ?? "").replace(/\/+$/, "");
    this.f = o.fetch ?? ((input, init) => fetch(input, init));
    this.webauthn = o.webauthn ?? browserWebAuthn;
    this.csrf = o.csrf ?? tabTokenStore();
    this.share = o.share === undefined ? broadcastTokenShare(this.csrf) : o.share;
    this.signedOut = o.onSignedOut ?? (() => {});
  }

  private async parse(r: Response): Promise<Json> {
    const j = (await r.json().catch(() => ({ ok: false, code: "FLEET_BAD_RESPONSE" }))) as Json;
    if (r.status === 401) { this.csrf.clear(); this.signedOut(); }
    return j;
  }

  /** A new token from signing in, in this tab: keep it and let the other tabs adopt it. */
  adoptToken(token: string): void { this.csrf.set(token); this.share?.announce(token); }

  /** The token for a write: this tab's, else one from another open tab; null when this tab must be verified. */
  private async writeToken(): Promise<string | null> {
    const t = this.csrf.get();
    if (t) return t;
    const got = (await this.share?.request(600)) ?? null;
    if (got) this.csrf.set(got);
    return got;
  }

  /**
   * POST a write (call / step-up) with this tab's token (or one from another open tab). The gateway decides: an ended
   * session answers 401 (→ sign-in, as always); a live session without a valid token answers FLEET_CSRF — refused
   * BEFORE anything ran (dash_call checks the token first) — and is then retried once, only with a different, current
   * token from another tab; with none, this tab must be verified (FLEET_TAB_UNVERIFIED). Never an unknown outcome.
   */
  private async postWrite(path: string, body: unknown): Promise<{ status: number; json: Json }> {
    const t = await this.writeToken();
    const r = await this.post(path, body);
    if (r.json.ok || r.json.code !== "FLEET_CSRF") return r;
    if (t) this.csrf.clear();
    const fresh = t ? (await this.share?.request(600)) ?? null : null; // (no token: the peers were already asked)
    if (!fresh || fresh === t) throw new FleetApiError("FLEET_TAB_UNVERIFIED", undefined, r.status);
    this.csrf.set(fresh);
    const again = await this.post(path, body);
    if (!again.json.ok && again.json.code === "FLEET_CSRF") throw new FleetApiError("FLEET_TAB_UNVERIFIED", undefined, again.status);
    return again;
  }

  /** POST JSON; throws FleetApiError("FLEET_NETWORK") when the request may not have reached the gateway. */
  async post(path: string, body: unknown): Promise<{ status: number; json: Json }> {
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

  async getJson(path: string): Promise<{ status: number; json: Json }> {
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
      const o = await this.postWrite("/api/stepup/options", { op, args: a });
      if (!o.json.ok) throw new FleetApiError(o.json.code ?? "FLEET_STEPUP_REQUIRED", undefined, o.status);
      let assertion: Json;
      try {
        assertion = await this.webauthn.get(o.json.options);
      } catch {
        throw new FleetApiError("FLEET_STEPUP_CANCELLED");
      }
      const v = await this.postWrite("/api/stepup/verify", { op, args: a, response: assertion });
      if (!v.json.ok) throw new FleetApiError(v.json.code ?? "FLEET_PASSKEY_INVALID", undefined, v.status);
      stepup = v.json.stepup;
    }
    let r: { status: number; json: Json };
    try {
      r = await this.postWrite("/api/call", { op, args: a, stepup });
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
