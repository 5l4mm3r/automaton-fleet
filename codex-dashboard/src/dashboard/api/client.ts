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
 *  • reads are retried once on a network error only — and, being side-effect free, when the edge says it is busy
 *    (429 / 503: the per-address request limit), after a short backoff (Retry-After honoured, capped), at most
 *    READ_BUSY_RETRIES times;
 *  • at most READ_CONCURRENCY reads are in flight per client: a refresh's dozens of reads are paced instead of arriving
 *    as one burst (a phone switching apps used to send ~48 at once and trip the edge's burst limit).
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
  /** How the owner confirms a sensitive operation (default: the passkey). */
  stepupConfirm?: StepupConfirm | null;
}

/**
 * The owner's choice for one step-up (v43): a fresh passkey assertion, or a fresh password + authenticator code — the
 * gateway binds either to the exact operation and arguments. Throwing (FLEET_STEPUP_CANCELLED) cancels the operation.
 */
export type StepupChoice = { method: "passkey" } | { method: "password"; password: string; code: string };
export type StepupConfirm = (op: string) => Promise<StepupChoice>;

/** Reads in flight at once, per client (the edge allows a burst of 40 at 10 r/s per address). */
export const READ_CONCURRENCY = 6;
/** Retries of a read the edge refused as busy (429 / 503). */
export const READ_BUSY_RETRIES = 3;
const BUSY_STATUS = new Set([429, 503]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GatewayClient {
  readonly mode = "live" as const;
  private readonly base: string;
  private readonly f: typeof fetch;
  readonly webauthn: WebAuthnPort;
  readonly csrf: TokenStore;
  private readonly share: TokenShare | null;
  private readonly signedOut: () => void;
  private readsInFlight = 0;
  /** Set by a 401: reads still queued behind it are not sent (the session is gone; the UI returns to sign-in). */
  private sessionEnded = false;
  private readonly readQueue: Array<() => void> = [];
  /** Set by the deck's UI: asks the owner how to confirm a sensitive operation (null: the passkey). */
  stepupConfirm: StepupConfirm | null;

  constructor(o: GatewayClientOptions = {}) {
    this.base = (o.baseUrl ?? "").replace(/\/+$/, "");
    this.f = o.fetch ?? ((input, init) => fetch(input, init));
    this.webauthn = o.webauthn ?? browserWebAuthn;
    this.csrf = o.csrf ?? tabTokenStore();
    this.share = o.share === undefined ? broadcastTokenShare(this.csrf) : o.share;
    this.signedOut = o.onSignedOut ?? (() => {});
    this.stepupConfirm = o.stepupConfirm ?? null;
  }

  private async parse(r: Response): Promise<Json> {
    const j = (await r.json().catch(() => ({ ok: false, code: "FLEET_BAD_RESPONSE" }))) as Json;
    if (r.status === 401) { this.sessionEnded = true; this.csrf.clear(); this.signedOut(); }
    return j;
  }

  /** A new token from signing in, in this tab: keep it and let the other tabs adopt it. */
  adoptToken(token: string): void { this.sessionEnded = false; this.csrf.set(token); this.share?.announce(token); }

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

  /** A sign-in-method change outside dash_call (password, passkey registration): the same token rules as any write. */
  write(path: string, body: unknown): Promise<{ status: number; json: Json }> { return this.postWrite(path, body); }

  /**
   * A fresh step-up for `op` and the exact argument string `a`: the passkey, or the password + an authenticator code,
   * as the owner chooses. Returns the single-use step-up token the gateway consumes with the operation.
   */
  async stepUp(op: string, a: string): Promise<string> {
    const choice: StepupChoice = this.stepupConfirm ? await this.stepupConfirm(op) : { method: "passkey" };
    if (choice.method === "password") {
      const v = await this.postWrite("/api/stepup/password", { op, args: a, password: choice.password, code: choice.code });
      if (!v.json.ok) throw new FleetApiError(v.json.code ?? "FLEET_LOGIN_INVALID", undefined, v.status);
      return String(v.json.stepup);
    }
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
    return String(v.json.stepup);
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

  /** A slot among READ_CONCURRENCY reads in flight; released by the returned function. */
  private async readSlot(): Promise<() => void> {
    if (this.readsInFlight >= READ_CONCURRENCY) await new Promise<void>((r) => this.readQueue.push(r));
    this.readsInFlight++;
    let done = false;
    return () => { if (done) return; done = true; this.readsInFlight--; this.readQueue.shift()?.(); };
  }

  async getJson(path: string): Promise<{ status: number; json: Json }> {
    const queued = this.readsInFlight >= READ_CONCURRENCY;
    const release = await this.readSlot();
    try {
      if (queued && this.sessionEnded && path.startsWith("/api/read")) return { status: 401, json: { ok: false, code: "FLEET_SESSION_INVALID" } as Json };
      for (let attempt = 0, busy = 0; ; attempt++) {
        let r: Response;
        try {
          r = await this.f(`${this.base}${path}`, { credentials: "same-origin", cache: "no-store" });
        } catch {
          if (attempt >= 1) throw new FleetApiError("FLEET_UNAVAILABLE");
          continue;
        }
        if (BUSY_STATUS.has(r.status) && busy < READ_BUSY_RETRIES) {
          busy++;
          const after = Number(r.headers.get("Retry-After"));
          await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 5_000) : 400 * 2 ** (busy - 1) + Math.random() * 200);
          continue;
        }
        if (BUSY_STATUS.has(r.status)) return { status: r.status, json: { ok: false, code: "FLEET_BUSY" } as Json };
        return { status: r.status, json: await this.parse(r) };
      }
    } finally {
      release();
    }
  }

  /** One gateway read (ordinary authentication). */
  async read<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    const { status, json } = await this.getJson(`/api/read?op=${encodeURIComponent(op)}&args=${encodeURIComponent(JSON.stringify(args))}`);
    if (!json.ok) throw new FleetApiError(json.code ?? "FLEET_UNAVAILABLE", json.reason, status);
    return json.result as T;
  }

  /**
   * One state change. A sensitive operation first takes a fresh step-up (passkey, or password + authenticator code)
   * bound to this exact operation and argument string; the gateway consumes it once (a replay is refused).
   */
  async call<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    const a = JSON.stringify(args);
    const stepup = SENSITIVE_OPS.has(op) ? await this.stepUp(op, a) : undefined;
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
