/**
 * Admin dashboard HTTP server (schema v38; v43 sign-in resilience). Serves the control-centre UI (the Next.js static
 * export) and a small JSON API. Listens on loopback behind the TLS front (admin.agentfleet.vip). Authentication:
 *
 *   ROUTE B (v38): passkey (WebAuthn, user verification required) → TOTP (replay-proof) → a full session.
 *   ROUTE A (v43): password + TOTP in ONE request → the same full session. Either factor wrong gives the same generic
 *   refusal (FLEET_LOGIN_INVALID); the TOTP step is accepted only when the password is right. The password is checked
 *   against a scrypt verifier (password.ts) and never logged, stored or forwarded.
 *   The session: HttpOnly, Secure, SameSite=Strict, __Host- cookie; 30-minute idle / 12-hour absolute; a CSRF token for
 *   every state change. STEP-UP — a fresh passkey assertion, or a fresh password + TOTP, bound to one operation and its
 *   exact arguments — for every sensitive operation. Owner access never depends on one browser's passkey (owner, v43).
 *
 * Every Admin operation is dash_call in the database (allow-listed, audited). Reveals and owner-identity uploads are
 * end-to-end encrypted in the Admin's browser (WebCrypto X25519): this server relays sealed bytes only. Every response
 * carries a strict CSP and no-store; POSTs must come from the configured origin; per-IP rate limits apply.
 */
import crypto from "crypto";
import http from "http";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import fs from "fs";
import path from "path";
import { SecretBox, totp } from "../identity/crypto.js";
import { hashPassword, passwordProblem, verifyPassword } from "./password.js";
import type { DashboardGatewayPort } from "./gateway.js";

export interface DashboardOptions {
  /** The public origin, e.g. https://admin.agentfleet.vip (http://localhost:<port> only in tests). */
  origin: string;
  rpId: string;
  rpName?: string;
  /** 32-byte key (dashboard state) encrypting the TOTP secret at rest. */
  stateKey: Buffer;
  /** Take the client address from X-Forwarded-For (only behind the loopback TLS front). */
  trustProxy?: boolean;
  /**
   * The Next.js static export (packages/dashboard-web/out) — the control-centre UI (owner decision 2026-10-02). Served
   * read-only from this directory; each HTML page gets a CSP listing the SHA-256 of its own inline bootstrap scripts.
   * Absent: the API only (no UI).
   */
  staticDir?: string | null;
  log?: (level: string, event: string, detail?: Record<string, unknown>) => void;
}

const sha = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const rand = () => crypto.randomBytes(32).toString("base64url");
const USER_ID = new Uint8Array(Buffer.from("automaton-fleet-admin-owner"));
const MAX_BODY = 22 * 1024 * 1024;

class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly windowMs: number) {}
  allow(key: string): boolean {
    const now = Date.now();
    const h = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (h.length >= this.max) { this.hits.set(key, h); return false; }
    h.push(now);
    this.hits.set(key, h);
    if (this.hits.size > 10_000) this.hits.clear();
    return true;
  }
}

export function createDashboardServer(gw: DashboardGatewayPort, o: DashboardOptions): http.Server {
  const box = new SecretBox(o.stateKey);
  const secure = o.origin.startsWith("https://");
  const cookieName = secure ? "__Host-fleet_session" : "fleet_session";
  const authLimit = new RateLimiter(30, 10 * 60_000);
  const apiLimit = new RateLimiter(600, 60_000);

  const csp = (scriptHashes: string[] = []) =>
    `default-src 'none'; script-src 'self'${scriptHashes.map((h) => ` 'sha256-${h}'`).join("")}; style-src 'self'; img-src 'self' data: blob:; ` +
    "connect-src 'self'; font-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
  const headers = (extra: Record<string, string> = {}) => ({
    "Content-Security-Policy": csp(),
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin", "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Cache-Control": "no-store", ...(secure ? { "Strict-Transport-Security": "max-age=63072000; includeSubDomains" } : {}), ...extra,
  });
  const json = (res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => {
    res.writeHead(status, headers({ "Content-Type": "application/json; charset=utf-8", ...extra }));
    res.end(JSON.stringify(body));
  };
  const ipOf = (req: http.IncomingMessage) => {
    const fwd = o.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
    return (fwd || req.socket.remoteAddress || "?").slice(0, 64);
  };
  const cookie = (req: http.IncomingMessage): string | null => {
    for (const part of String(req.headers.cookie ?? "").split(";")) {
      const [k, v] = part.trim().split("=");
      if (k === cookieName && v && /^[A-Za-z0-9_-]{40,60}$/.test(v)) return v;
    }
    return null;
  };
  const setCookie = (token: string | null, maxAge: number) =>
    `${cookieName}=${token ?? ""}; Path=/; HttpOnly; SameSite=Strict;${secure ? " Secure;" : ""} Max-Age=${token ? maxAge : 0}`;
  const body = (req: http.IncomingMessage): Promise<Record<string, any>> => new Promise((resolve, reject) => {
    let n = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { n += c.length; if (n > MAX_BODY) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
  const totpCheck = (secret: string, code: string, after: number): number | null => {
    if (!/^\d{6}$/.test(code)) return null;
    const now = Math.floor(Date.now() / 30_000);
    for (const c of [now - 1, now, now + 1]) {
      if (c > after && crypto.timingSafeEqual(Buffer.from(totp(secret, c * 30_000)), Buffer.from(code))) return c;
    }
    return null;
  };
  const verifyAssertion = async (response: any, purpose: string, sessionSha: string | null, op: string | null, argsSha: string | null, ip: string) => {
    const id = typeof response?.id === "string" ? response.id : "";
    const k = await gw.passkeyGet(id);
    if (!k) return null;
    const v = await verifyAuthenticationResponse({
      response, expectedOrigin: o.origin, expectedRPID: o.rpId, requireUserVerification: true,
      expectedChallenge: async (c: string) => gw.challengeUse(sha(c), purpose, sessionSha, op, argsSha),
      credential: { id: k.id, publicKey: new Uint8Array(Buffer.from(k.publicKeyB64, "base64")), counter: Number(k.counter), transports: k.transports },
    }).catch(() => null);
    if (!v?.verified) return null;
    if (!(await gw.passkeyUsed(k.id, v.authenticationInfo.newCounter, ip))) return null;
    return k.id;
  };
  /**
   * Password AND a fresh TOTP code, both always checked (no early exit), the TOTP step accepted (once) only when both are
   * right. Returns true or false — never which factor failed.
   */
  const passwordAndTotp = async (password: unknown, code: unknown): Promise<boolean> => {
    const pw = await gw.passwordGet();
    const okPw = await verifyPassword(password, pw?.verifier ?? null);
    const t = await gw.totpGet();
    const c = t?.confirmed ? totpCheck(box.open(Buffer.from(t.secretEncB64, "base64"), "dashboard:totp"), String(code ?? ""), Number(t.lastCounter)) : null;
    if (!okPw || c === null) return false;
    return gw.totpAccept(c, false);
  };
  /** The first TOTP factor, shown ONCE to the device that just enrolled (base32, otpauth URI). */
  const issueTotp = async (tokenSha: string, ip: string) => {
    const raw = crypto.randomBytes(20);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = 0, value = 0, secret = "";
    for (const x of raw) { value = (value << 8) | x; bits += 8; while (bits >= 5) { secret += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; } }
    const set = await gw.totpSet(tokenSha, box.seal(secret, "dashboard:totp"), ip);
    if (!set.ok) return set;
    return { ok: true as const, next: "totp", totpSecret: secret,
      otpauth: `otpauth://totp/${encodeURIComponent("Automaton Fleet:owner")}?secret=${secret}&issuer=${encodeURIComponent("Automaton Fleet")}&period=30&digits=6` };
  };

  // ── the static UI (Next.js export) ──
  const root = o.staticDir ? fs.realpathSync(o.staticDir) : null;
  const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".txt": "text/plain; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
    ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
  const pageCsp = new Map<string, string>(); // html file -> its CSP (hashes of its inline scripts), computed once (release files are immutable)
  const htmlCsp = (file: string, body: Buffer) => {
    let c = pageCsp.get(file);
    if (!c) {
      const hashes = [...body.toString("utf8").matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
        .map((m) => crypto.createHash("sha256").update(m[1], "utf8").digest("base64"));
      c = csp(hashes);
      pageCsp.set(file, c);
    }
    return c;
  };
  const serveStatic = (pathname: string, res: http.ServerResponse) => {
    if (!root) return json(res, 404, { ok: false, code: "FLEET_NOT_FOUND" });
    let rel: string;
    try { rel = decodeURIComponent(pathname); } catch { return json(res, 400, { ok: false, code: "FLEET_BAD_REQUEST" }); }
    if (rel.includes("\0") || rel.split("/").some((seg) => seg === ".." || seg.startsWith("."))) return json(res, 404, { ok: false, code: "FLEET_NOT_FOUND" });
    let file = path.join(root, rel.endsWith("/") ? path.join(rel, "index.html") : rel);
    const send = (status: number, f: string) => {
      const st = fs.lstatSync(f);
      if (!st.isFile()) return json(res, 404, { ok: false, code: "FLEET_NOT_FOUND" });
      const real = fs.realpathSync(f);
      if (real !== f && !real.startsWith(root + path.sep)) return json(res, 404, { ok: false, code: "FLEET_NOT_FOUND" });
      const body = fs.readFileSync(f);
      const ext = path.extname(f).toLowerCase();
      const isHtml = ext === ".html";
      const immutable = rel.startsWith("/_next/static/");
      res.writeHead(status, headers({ "Content-Type": TYPES[ext] ?? "application/octet-stream",
        ...(isHtml ? { "Content-Security-Policy": htmlCsp(f, body) } : {}),
        "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-store" }));
      return res.end(body);
    };
    if (!file.startsWith(root + path.sep) && file !== root) return json(res, 404, { ok: false, code: "FLEET_NOT_FOUND" });
    try {
      if (!rel.endsWith("/") && fs.existsSync(file) && fs.lstatSync(file).isDirectory() && fs.existsSync(path.join(file, "index.html"))) {
        res.writeHead(308, headers({ Location: `${rel}/` }));
        return res.end();
      }
      if (fs.existsSync(file)) return send(200, file);
      file = path.join(root, "404.html");
      return fs.existsSync(file) ? send(404, file) : json(res, 404, { ok: false, code: "FLEET_NOT_FOUND" });
    } catch {
      return json(res, 404, { ok: false, code: "FLEET_NOT_FOUND" });
    }
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? "/", o.origin);
    const ip = ipOf(req);
    if (!url.pathname.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { ok: false, code: "FLEET_METHOD" });
      return serveStatic(url.pathname, res);
    }
    if (!apiLimit.allow(ip)) return json(res, 429, { ok: false, code: "FLEET_RATE_LIMITED" });
    if (req.method === "POST") {
      if (req.headers.origin !== o.origin) return json(res, 403, { ok: false, code: "FLEET_ORIGIN" });
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { ok: false, code: "FLEET_CONTENT_TYPE" });
    }
    const tok = cookie(req);
    const sessionSha = tok ? sha(tok) : null;

    // ── authentication ──
    if (url.pathname.startsWith("/api/auth/") && !authLimit.allow(ip)) return json(res, 429, { ok: false, code: "FLEET_RATE_LIMITED" });
    if (req.method === "GET" && url.pathname === "/api/auth/state") {
      const st = await gw.authState();
      const live = sessionSha ? (await gw.sessionCheck(sessionSha)).ok : false;
      return json(res, 200, { ok: true, enrolled: (st.passkeys.length > 0 || Boolean(st.passwordConfigured)) && st.totpConfigured, locked: st.locked, session: live ? "full" : "none" });
    }
    if (req.method === "POST" && url.pathname === "/api/auth/enroll/options") {
      const b = await body(req);
      const tokenSha = sha(String(b.token ?? ""));
      if (!(await gw.enrollValid(tokenSha))) { await gw.log("enroll", false, "FLEET_ENROLLMENT_INVALID", ip); return json(res, 403, { ok: false, code: "FLEET_ENROLLMENT_INVALID" }); }
      const st = await gw.authState();
      const opts = await generateRegistrationOptions({ rpName: o.rpName ?? "Automaton Fleet", rpID: o.rpId, userName: "owner", userDisplayName: "Fleet Admin",
        userID: USER_ID, attestationType: "none", excludeCredentials: st.passkeys.map((p) => ({ id: p.id, transports: p.transports })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" }, supportedAlgorithmIDs: [-7, -8, -257] });
      await gw.challengeNew(sha(opts.challenge), "enroll", null, null, tokenSha);
      return json(res, 200, { ok: true, options: opts });
    }
    if (req.method === "POST" && url.pathname === "/api/auth/enroll/verify") {
      const b = await body(req);
      const token = String(b.token ?? "");
      const tokenSha = sha(token);
      const v = await verifyRegistrationResponse({ response: b.response, expectedOrigin: o.origin, expectedRPID: o.rpId, requireUserVerification: true,
        expectedChallenge: async (c: string) => gw.challengeUse(sha(c), "enroll", null, null, tokenSha) }).catch(() => null);
      if (!v?.verified) { await gw.log("enroll", false, "FLEET_PASSKEY_INVALID", ip); return json(res, 403, { ok: false, code: "FLEET_PASSKEY_INVALID" }); }
      const c = v.registrationInfo.credential;
      const add = await gw.passkeyAdd(tokenSha, null, null, c.id, Buffer.from(c.publicKey), c.counter, c.transports ?? [], String(b.name ?? "passkey").slice(0, 80), ip);
      if (!add.ok) return json(res, 403, add);
      const st = await gw.authState();
      if (st.totpConfigured) return json(res, 200, { ok: true, next: "login" });
      const t = await issueTotp(tokenSha, ip);
      return json(res, t.ok ? 200 : 403, t);
    }
    // v43 recovery: a one-time host enrollment link can set the password instead of registering a passkey.
    if (req.method === "POST" && url.pathname === "/api/auth/enroll/password") {
      const b = await body(req);
      const tokenSha = sha(String(b.token ?? ""));
      if (!(await gw.enrollValid(tokenSha))) { await gw.log("enroll", false, "FLEET_ENROLLMENT_INVALID", ip); return json(res, 403, { ok: false, code: "FLEET_ENROLLMENT_INVALID" }); }
      const problem = passwordProblem(b.password);
      if (problem) return json(res, 400, { ok: false, code: "FLEET_PASSWORD_WEAK", reason: problem });
      const set = await gw.passwordSet(tokenSha, null, null, await hashPassword(String(b.password)), ip);
      if (!set.ok) return json(res, 403, set);
      const st = await gw.authState();
      if (st.totpConfigured) return json(res, 200, { ok: true, next: "login" });
      const t = await issueTotp(tokenSha, ip);
      return json(res, t.ok ? 200 : 403, t);
    }
    if (req.method === "POST" && url.pathname === "/api/auth/enroll/totp") {
      const b = await body(req);
      const t = await gw.totpGet();
      if (!t || t.confirmed) return json(res, 400, { ok: false, code: "FLEET_TOTP_STATE" });
      const secret = box.open(Buffer.from(t.secretEncB64, "base64"), "dashboard:totp");
      const c = totpCheck(secret, String(b.code ?? ""), Number(t.lastCounter));
      if (c === null || !(await gw.totpAccept(c, true))) { await gw.log("enroll", false, "FLEET_TOTP_INVALID", ip); return json(res, 403, { ok: false, code: "FLEET_TOTP_INVALID" }); }
      await gw.log("enroll", true, null, ip, { totpConfirmed: true });
      return json(res, 200, { ok: true, next: "login" });
    }
    if (req.method === "POST" && url.pathname === "/api/auth/login/options") {
      const st = await gw.authState();
      if (st.locked) return json(res, 423, { ok: false, code: "FLEET_ADMIN_LOCKED" });
      const opts = await generateAuthenticationOptions({ rpID: o.rpId, userVerification: "required", allowCredentials: st.passkeys.map((p) => ({ id: p.id, transports: p.transports })) });
      await gw.challengeNew(sha(opts.challenge), "login", null, null, null);
      return json(res, 200, { ok: true, options: opts });
    }
    if (req.method === "POST" && url.pathname === "/api/auth/login/verify") {
      const b = await body(req);
      const id = await verifyAssertion(b.response, "login", null, null, null, ip);
      if (!id) { await gw.log("login", false, "FLEET_PASSKEY_INVALID", ip); return json(res, 403, { ok: false, code: "FLEET_PASSKEY_INVALID" }); }
      const session = rand();
      const csrf = rand();
      await gw.sessionBegin(sha(session), sha(csrf), id, ip, String(req.headers["user-agent"] ?? "").slice(0, 300));
      return json(res, 200, { ok: true, next: "totp", csrf }, { "Set-Cookie": setCookie(session, 300) });
    }
    // ROUTE A: password + TOTP together; one generic refusal for any wrong factor (counted by the lockout).
    if (req.method === "POST" && url.pathname === "/api/auth/login/password") {
      const st = await gw.authState();
      if (st.locked) return json(res, 423, { ok: false, code: "FLEET_ADMIN_LOCKED" });
      const b = await body(req);
      if (!(await passwordAndTotp(b.password, b.code))) {
        await gw.log("login", false, "FLEET_LOGIN_INVALID", ip, { method: "password" });
        return json(res, 403, { ok: false, code: "FLEET_LOGIN_INVALID" });
      }
      const session = rand();
      const csrf = rand();
      const r = await gw.sessionBeginPassword(sha(session), sha(csrf), ip, String(req.headers["user-agent"] ?? "").slice(0, 300));
      if (!r.ok) { await gw.log("login", false, "FLEET_LOGIN_INVALID", ip, { method: "password" }); return json(res, 403, { ok: false, code: "FLEET_LOGIN_INVALID" }); }
      return json(res, 200, { ok: true, csrf }, { "Set-Cookie": setCookie(session, 12 * 3600) });
    }
    if (req.method === "POST" && url.pathname === "/api/auth/login/totp") {
      if (!sessionSha) return json(res, 401, { ok: false, code: "FLEET_SESSION_INVALID" });
      const b = await body(req);
      const t = await gw.totpGet();
      if (!t?.confirmed) return json(res, 403, { ok: false, code: "FLEET_TOTP_STATE" });
      const secret = box.open(Buffer.from(t.secretEncB64, "base64"), "dashboard:totp");
      const c = totpCheck(secret, String(b.code ?? ""), Number(t.lastCounter));
      const accepted = c !== null && (await gw.totpAccept(c, false));
      const r = await gw.sessionTotp(sessionSha, accepted, ip);
      if (!r.ok) return json(res, 403, r);
      return json(res, 200, { ok: true }, { "Set-Cookie": setCookie(tok, 12 * 3600) });
    }
    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      if (sessionSha) await gw.sessionEnd(sessionSha, ip);
      return json(res, 200, { ok: true }, { "Set-Cookie": setCookie(null, 0) });
    }

    // ── everything below needs a full session ──
    if (!sessionSha || !(await gw.sessionCheck(sessionSha)).ok) return json(res, 401, { ok: false, code: "FLEET_SESSION_INVALID" });
    if (req.method === "POST" && url.pathname === "/api/stepup/options") {
      const b = await body(req);
      const op = String(b.op ?? ""), args = String(b.args ?? "{}");
      const st = await gw.authState();
      const opts = await generateAuthenticationOptions({ rpID: o.rpId, userVerification: "required", allowCredentials: st.passkeys.map((p) => ({ id: p.id, transports: p.transports })) });
      await gw.challengeNew(sha(opts.challenge), "stepup", sessionSha, op, sha(args));
      return json(res, 200, { ok: true, options: opts });
    }
    if (req.method === "POST" && url.pathname === "/api/stepup/verify") {
      const b = await body(req);
      const op = String(b.op ?? ""), args = String(b.args ?? "{}");
      const id = await verifyAssertion(b.response, "stepup", sessionSha, op, sha(args), ip);
      if (!id) { await gw.log("stepup", false, "FLEET_PASSKEY_INVALID", ip, { op }); return json(res, 403, { ok: false, code: "FLEET_PASSKEY_INVALID" }); }
      const stepup = rand();
      const r = await gw.stepupRecord(sessionSha, sha(stepup), op, sha(args), ip);
      return r.ok ? json(res, 200, { ok: true, stepup }) : json(res, 403, r);
    }
    // Step-up with the password route: a fresh password + TOTP bound to this operation and arguments.
    if (req.method === "POST" && url.pathname === "/api/stepup/password") {
      const b = await body(req);
      const op = String(b.op ?? ""), args = String(b.args ?? "{}");
      if (!(await passwordAndTotp(b.password, b.code))) {
        await gw.log("stepup", false, "FLEET_LOGIN_INVALID", ip, { op, method: "password" });
        return json(res, 403, { ok: false, code: "FLEET_LOGIN_INVALID" });
      }
      const stepup = rand();
      const r = await gw.stepupRecord(sessionSha, sha(stepup), op, sha(args), ip);
      return r.ok ? json(res, 200, { ok: true, stepup }) : json(res, 403, r);
    }
    // Sign-in methods (v43): state changes outside dash_call, so each checks the session's CSRF token itself.
    if (req.method === "POST" && ["/api/account/password", "/api/passkey/options", "/api/passkey/verify"].includes(url.pathname)) {
      const csrf = String(req.headers["x-csrf"] ?? "");
      if (!(await gw.sessionCsrfOk(sessionSha, csrf ? sha(csrf) : null))) {
        await gw.log("op", false, "FLEET_CSRF", ip, { path: url.pathname });
        return json(res, 400, { ok: false, code: "FLEET_CSRF" });
      }
      const b = await body(req);
      if (url.pathname === "/api/account/password") {
        const problem = passwordProblem(b.password);
        if (problem) return json(res, 400, { ok: false, code: "FLEET_PASSWORD_WEAK", reason: problem });
        const r = await gw.passwordSet(null, sessionSha, b.stepup ? sha(String(b.stepup)) : null, await hashPassword(String(b.password)), ip);
        return json(res, r.ok ? 200 : 403, r.ok ? { ok: true } : r);
      }
      if (url.pathname === "/api/passkey/options") {
        const st = await gw.authState();
        const opts = await generateRegistrationOptions({ rpName: o.rpName ?? "Automaton Fleet", rpID: o.rpId, userName: "owner", userDisplayName: "Fleet Admin",
          userID: USER_ID, attestationType: "none", excludeCredentials: st.passkeys.map((p) => ({ id: p.id, transports: p.transports })),
          authenticatorSelection: { residentKey: "preferred", userVerification: "required" }, supportedAlgorithmIDs: [-7, -8, -257] });
        await gw.challengeNew(sha(opts.challenge), "passkey_add", sessionSha, null, null);
        return json(res, 200, { ok: true, options: opts });
      }
      const v = await verifyRegistrationResponse({ response: b.response, expectedOrigin: o.origin, expectedRPID: o.rpId, requireUserVerification: true,
        expectedChallenge: async (c: string) => gw.challengeUse(sha(c), "passkey_add", sessionSha, null, null) }).catch(() => null);
      if (!v?.verified) { await gw.log("enroll", false, "FLEET_PASSKEY_INVALID", ip, { via: "session" }); return json(res, 403, { ok: false, code: "FLEET_PASSKEY_INVALID" }); }
      const c = v.registrationInfo.credential;
      const add = await gw.passkeyAdd(null, sessionSha, b.stepup ? sha(String(b.stepup)) : null, c.id, Buffer.from(c.publicKey), c.counter, c.transports ?? [],
        String(b.name ?? "passkey").slice(0, 80), ip);
      return json(res, add.ok ? 200 : 403, add.ok ? { ok: true } : add);
    }
    if (req.method === "GET" && url.pathname === "/api/read") {
      const r = await gw.call(sessionSha, null, url.searchParams.get("op") ?? "", url.searchParams.get("args") ?? "{}", null, ip);
      return json(res, r.ok ? 200 : r.code === "FLEET_SESSION_INVALID" ? 401 : 400, r);
    }
    if (req.method === "POST" && url.pathname === "/api/call") {
      const b = await body(req);
      const csrf = String(req.headers["x-csrf"] ?? "");
      const r = await gw.call(sessionSha, csrf ? sha(csrf) : null, String(b.op ?? ""), String(b.args ?? "{}"), b.stepup ? sha(String(b.stepup)) : null, ip);
      return json(res, r.ok ? 200 : r.code === "FLEET_SESSION_INVALID" ? 401 : 400, r);
    }
    return json(res, 404, { ok: false, code: "FLEET_NOT_FOUND" });
  };

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      o.log?.("error", "dashboard_request_failed", { path: (req.url ?? "").split("?")[0], error: err instanceof Error ? err.message.slice(0, 200) : "error" });
      if (!res.headersSent) json(res, 500, { ok: false, code: "FLEET_DASHBOARD_ERROR" });
    });
  });
}
