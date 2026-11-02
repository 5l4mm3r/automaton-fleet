/**
 * Browser worker (schema v37): executes agents' browser actions in real Chromium sessions — the general account /
 * website operator (no per-site adapter). It holds no vault: a credential a step needs is requested from the registry,
 * answered by the identity broker sealed to this worker's one-time X25519 key, filled into the page and forgotten. Page
 * snapshots never carry a value this worker filled or captured, and never read input values at all.
 *
 * Sessions live in memory (a worker restart ends them: the next action reports FLEET_BROWSER_SESSION_LOST and the agent
 * opens a new one). Every request a page makes is checked against the URL policy. v51: an `upload` step sets an owner
 * document (under the owner's standing authority) into the page's file input from memory.
 *
 * v79 — the general operator's missing hands: `upload_file` sets files the agent staged from its own workspace (a logo, a
 * listing image, a product file) into a page's file input; `download` saves what a page offers for the agent; `screenshot`
 * and `pdf` capture the page (inputs masked; refused once the session has handled the owner's card / facts or captured a
 * secret); `set_content` renders an HTML file the agent staged (brand images, listing graphics, mockups — then screenshot
 * or pdf), only in a session without an account; `hover`, `scroll`, `uncheck`, `wait_idle`, `tab` (popups and new tabs
 * become the current tab), `dialog` (accept or dismiss the next alert / confirm / prompt) and a `frame` on any element
 * step (embedded editors, hosted card fields). A name that resolves to a private or loopback address is refused on every
 * request (HostResolutionPolicy) — this closes a gap: the unit allows loopback for PostgreSQL.
 *
 * v126 — an account the owner made (`ownerAccount`). The agent must never read its login, have it used on another site, or replace it. The login never enters the agent's browser:
 * `sign_in` runs alone in a separate browser context that takes no agent step, on the login URL the owner pinned. The field and the form are found by the worker, not named by the
 * agent; once a value is in the page nothing leaves for another origin and a 307 or 308 is refused. Only the session it produces (cookies, local storage) moves to the agent's context.
 * In the agent's context the steps are as usual, except that it cannot ask for the login, capture, open a mailed link, type into a password field, or type characters by key; pages
 * that change how an account is secured are refused by path, which is a defence on unknown sites and not a guarantee. The main protection there is that changing a password normally
 * needs the current one, which the agent does not have.
 * The limit: the sign-in page is trusted. Its markup or script decides where a typed value goes and can read it, and the value can then reach the agent or another site. The rules below
 * remove what is cheap to remove and do not make a hostile page safe: if the agent can edit that page, for example a site theme, the password can reach it. The owner pins the page and
 * uses a password for this account alone. A session cookie can also be read by script the agent publishes on that origin.
 */
import crypto from "crypto";
import fs from "fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { generateX25519, openSealed, sealTo } from "../identity/crypto.js";
import type { BrowserAction, BrowserGatewayPort } from "./gateway.js";
import { HostResolutionPolicy } from "./policy.js";
import { BROWSER_EGRESS_ADDRESS, EgressProxy } from "./egress.js";
import net from "net";

export interface BrowserWorkerOptions {
  worker?: string;
  executablePath: string;
  /** The identity broker's published owner-vault public key (base64 SPKI): captured secrets are sealed to it. */
  brokerPublicKey?: () => Promise<string | null>;
  /** Test-only: loopback sites and self-signed certificates. */
  allowLoopback?: boolean;
  ignoreHttpsErrors?: boolean;
  /** Chromium's own sandbox (off only where the host cannot provide it; the service's isolation remains). */
  chromiumSandbox?: boolean;
  log?: (level: string, event: string, detail?: Record<string, unknown>) => void;
  /** v79: the resolution policy (tests inject a resolver). */
  hostPolicy?: HostResolutionPolicy;
  /** v126-egress: where the egress proxy listens (default: the dedicated loopback address the unit allows). */
  egressHost?: string;
}

interface Session {
  context: BrowserContext;
  page: Page;
  secrets: Set<string>;
  /** v49: values filled from the owner's facts / card (redacted from snapshots at a shorter length). */
  ownerValues: Set<string>;
  /** v79: every tab of the session (popups included); `page` is the current one. */
  pages: Page[];
  /** v79: a captured secret was shown on a page of this session (no image of it may leave the worker). */
  captured: boolean;
  /** v79: the decision for the next dialog (otherwise dismissed), and the last dialog's text. */
  dialog: { accept: boolean; text?: string } | null;
  lastDialog: string | null;
  /** v79: files the page produced during the current action. */
  produced: Array<{ fileId: string; kind: string; fileName: string; sizeBytes: number }>;
  /** v79: make a new tab (popup) part of the session and the current tab. */
  adopt: (p: Page) => void;
  /** v126: on an account the owner made. */
  owner: boolean;
}

const TEXT_MAX = 8000;
/** v79: the largest file a page may hand over (download / screenshot / pdf). */
export const BROWSER_FILE_MAX_BYTES = 25_000_000;
const EXT_TYPES: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  svg: "image/svg+xml", csv: "text/csv", txt: "text/plain", json: "application/json", zip: "application/zip", html: "text/html", md: "text/markdown",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", mp4: "video/mp4", mp3: "audio/mpeg" };
/** v80: steps that act outward (anything but reading / rendering) — confined to a release's origins while sales are closed. */
const OUTWARD_STEPS = new Set(["sign_in", "click", "fill", "select", "check", "uncheck", "press", "upload", "upload_file", "download", "capture", "open_auth_link", "dialog"]);
/** v79: a download whose name says it carries credentials never reaches the agent (a shown secret is captured into the vault instead). */
const CREDENTIAL_FILE = /recovery|backup[ _-]?codes|secret|credential|private[ _-]?key|\.pem$|\.key$/i;
/** v126: on an owner's account the agent may have these filled; its login goes in only through `sign_in`. The registry enforces the same. */
const OWNER_FILL = new Set(["username", "email"]);
const OWNER_KEYS = new Set(["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"]);
const PASSWORD_LIKE = /pass(word|wd|code)|\bpwd\b|new-password|current-password/i;
/** v126: pages that change how an account is secured. A defence on unknown sites, not a guarantee. */
const ACCOUNT_SECURITY_PATH = /pass(word|wd)|pwd|\/security(\/|\.|$)|two[-_]?factor|\/2fa(\/|\.|$)|\/mfa(\/|\.|$)|recovery|(delete|close|deactivate)[-_]?account/i;
/** v126: the sign-in context has no use for these, and a page's script could use them to send a value out of sight of the route. */
const SIGN_IN_INIT = "for (const n of ['Worker', 'SharedWorker', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel']) { try { delete window[n]; Object.defineProperty(window, n, { value: undefined }); } catch {} }";
const OTP_NAMES = ["otp", "totp", "mfa", "2fa", "code", "onetimecode", "one-time-code", "one_time_code", "verification-code", "verification_code", "verificationcode", "auth-code", "auth_code", "authcode"];
const USER_FIELD = ['input[type="email"]', 'input[autocomplete~="username"]', 'input[autocomplete~="email"]', 'input[name*="user" i]', 'input[id*="user" i]', 'input[name*="email" i]', 'input[id*="email" i]', 'input[name*="login" i]', 'input[id*="login" i]'];
const CAPTCHA = "iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='turnstile'], iframe[src*='captcha'], .g-recaptcha, .h-captcha, .cf-turnstile";

/** v126: a secret as a page or a URL may carry it. */
export function secretForms(v: string): string[] {
  const strict = encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const forms = new Set([v, encodeURIComponent(v), encodeURI(v), strict, strict.toLowerCase(), strict.replace(/%20/g, "+"), JSON.stringify(v).slice(1, -1),
    v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"),
    Buffer.from(v).toString("base64"), Buffer.from(v).toString("base64").replace(/=+$/, ""), Buffer.from(v).toString("base64url"), Buffer.from(v).toString("hex")]);
  return [...forms];
}

export class BrowserWorker {
  private readonly worker: string;
  private browser: Browser | null = null;
  /** v126-egress: Chromium's only way out; checks every connection against the same policy. */
  private egress: EgressProxy | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly key = generateX25519();
  private readonly hosts: HostResolutionPolicy;

  /** v95: the start-up sweep of actions claimed before this process ran has been done. */
  private swept = false;

  constructor(private readonly gw: BrowserGatewayPort, private readonly o: BrowserWorkerOptions) {
    this.worker = o.worker ?? "browser-worker";
    if (!/^[a-z0-9_.-]{1,64}$/.test(this.worker)) throw new Error("worker name must match ^[a-z0-9_.-]{1,64}$");
    this.hosts = o.hostPolicy ?? new HostResolutionPolicy();
  }

  /**
   * R41.1: prove at startup — inside the worker's own sandbox — that the pinned Chromium launches and renders a page
   * (about:blank and a data: URL; no network). The worker refuses to start otherwise (fail closed).
   */
  async selfTest(): Promise<{ ok: true; version: string }> {
    const b = await this.ensureBrowser();
    // v126-egress: this process (and so Chromium, in the same unit) reaches its egress proxy, which refuses a request without its credentials.
    await this.egressReachable();
    const context = await b.newContext({ acceptDownloads: false });
    try {
      const page = await context.newPage();
      await page.goto("data:text/html,<title>fleet-browser-selftest</title><p>ok</p>");
      const title = await page.title();
      if (title !== "fleet-browser-selftest") throw new Error("self-test page did not render");
      return { ok: true, version: b.version() };
    } finally {
      await context.close();
    }
  }

  private async ensureBrowser(): Promise<Browser> {
    if (!this.egress) {
      const egress = new EgressProxy({ host: this.o.egressHost ?? BROWSER_EGRESS_ADDRESS, policy: { connectAddress: (h, p, o) => this.hosts.connectAddress(h, p, o) },
        allowLoopback: this.o.allowLoopback, log: this.o.log });
      await egress.start();
      this.egress = egress;
    }
    if (!this.browser || !this.browser.isConnected()) {
      // v126-egress: every connection goes through the egress proxy, loopback included (no implicit bypass); QUIC is off, since it would not use the proxy.
      this.browser = await chromium.launch({ executablePath: this.o.executablePath, headless: true, chromiumSandbox: this.o.chromiumSandbox ?? false,
        proxy: { server: this.egress.url, username: this.egress.username, password: this.egress.password, bypass: "<-loopback>" },
        args: ["--disable-dev-shm-usage", "--no-first-run", "--disable-background-networking", "--disable-sync", "--metrics-recording-only", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          "--disable-quic"] });
    }
    return this.browser;
  }

  /** v126-egress: a connection to the proxy without its credentials is answered 407: the address is reachable from this unit and the proxy is this one. */
  private egressReachable(): Promise<void> {
    const { host, port } = this.egress!.endpoint;
    return new Promise((resolve, reject) => {
      const s = net.connect({ host, port });
      const fail = (why: string) => { s.destroy(); reject(new Error(`egress proxy unreachable at ${host}:${port}: ${why}`)); };
      const t = setTimeout(() => fail("timeout"), 5_000);
      s.once("connect", () => s.write("CONNECT selftest.invalid:443 HTTP/1.1\r\nHost: selftest.invalid:443\r\n\r\n"));
      s.once("data", (d) => { clearTimeout(t); s.destroy(); /^HTTP\/1\.1 407 /.test(d.toString("latin1")) ? resolve() : reject(new Error("egress proxy answered unexpectedly")); });
      s.once("error", (e) => { clearTimeout(t); fail((e as NodeJS.ErrnoException).code ?? "error"); });
    });
  }

  /** v126-egress: the proxy's counts (tests, logs). */
  egressStats(): Record<string, number> | null { return this.egress ? { ...this.egress.stats } : null; }

  private async newSession(owner: boolean): Promise<Session> {
    const b = await this.ensureBrowser();
    // v79: downloads are accepted (into the service's private temporary directory) and handed over only by a download step.
    const context = await b.newContext({ ignoreHTTPSErrors: Boolean(this.o.ignoreHttpsErrors), acceptDownloads: true, viewport: { width: 1280, height: 900 },
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" });
    const allow = { allowLoopback: this.o.allowLoopback };
    await context.route("**/*", async (route) => {
      const req = route.request();
      if (!(await this.hosts.allowed(req.url(), allow).catch(() => false))) return route.abort("blockedbyclient");
      if (owner) {
        let path = "";
        try { path = decodeURIComponent(new URL(req.url()).pathname); } catch { path = req.url(); }
        let top = false;
        try { top = req.isNavigationRequest() && req.frame().parentFrame() === null; } catch { top = false; }
        if ((top || !["GET", "HEAD"].includes(req.method())) && ACCOUNT_SECURITY_PATH.test(path)) return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    const page = await context.newPage();
    const s: Session = { context, page, secrets: new Set(), ownerValues: new Set(), pages: [page], captured: false, dialog: null, lastDialog: null, produced: [], adopt: () => {}, owner };
    const watch = (p: Page) => {
      p.setDefaultTimeout(15_000);
      p.on("dialog", (d) => {
        s.lastDialog = this.scrub(s, `${d.type()}: ${d.message()}`).slice(0, 300);
        const plan = s.dialog;
        s.dialog = null;
        void (plan?.accept ? d.accept(plan.text) : d.dismiss()).catch(() => {});
      });
      p.on("close", () => {
        s.pages = s.pages.filter((x) => x !== p);
        if (s.page === p && s.pages.length) s.page = s.pages[s.pages.length - 1];
      });
    };
    watch(page);
    // A popup or a new tab becomes the current tab (sign-in windows, links that open a new tab).
    s.adopt = (p: Page) => { if (!s.pages.includes(p)) { s.pages.push(p); watch(p); } s.page = p; };
    context.on("page", (p) => { if (!s.pages.includes(p)) s.adopt(p); });
    return s;
  }

  /** v126: a value this session holds, in the forms a page may carry it, never leaves; longest first, so one value cannot split another. Owner values from 3 characters (a card's CVC). */
  private scrub(s: Session, text: string, minimum = 4): string {
    const forms = [...s.secrets].filter((x) => x.length >= (s.ownerValues.has(x) ? 3 : minimum)).flatMap(secretForms).sort((a, b) => b.length - a.length);
    let out = text;
    for (const f of forms) out = out.split(f).join("[credential]");
    return out;
  }

  /**
   * v126: the login of an account the owner made, used where the agent cannot reach it: a separate context takes no agent step, the login URL is the owner's, and the worker finds the
   * form. Only the resulting session moves to the agent's context.
   */
  private async signIn(s: Session, action: BrowserAction, lease: string): Promise<void> {
    if (!s.owner || !action.loginUrl) throw new Error("FLEET_SIGNIN_UNAVAILABLE");
    if (action.steps.length !== 1) throw new Error("FLEET_BAD_REQUEST");
    const target = new URL(action.loginUrl);
    const origin = target.origin.toLowerCase();
    const b = await this.ensureBrowser();
    const context = await b.newContext({ ignoreHTTPSErrors: Boolean(this.o.ignoreHttpsErrors), acceptDownloads: false, serviceWorkers: "block", viewport: { width: 1280, height: 900 },
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" });
    let filled = false;
    let held = "";
    const carries = (text: string, v: string) => { let plain = text; try { plain = decodeURIComponent(text); } catch { plain = text; } return plain.includes(v) || secretForms(v).some((f) => text.includes(f)); };
    let state: Awaited<ReturnType<BrowserContext["storageState"]>>;
    let after = action.loginUrl;
    const at = (page: Page) => { try { return new URL(page.url()).origin.toLowerCase(); } catch { return ""; } };
    try {
      await context.route("**/*", async (route) => {
        const req = route.request();
        if (!(await this.hosts.allowed(req.url(), { allowLoopback: this.o.allowLoopback }).catch(() => false))) return route.abort("blockedbyclient");
        const reading = req.method() === "GET" || req.method() === "HEAD";
        let same = false;
        try { same = new URL(req.url()).origin.toLowerCase() === origin; } catch { same = false; }
        // Before the value exists a page may load its scripts and fonts. Once it does, nothing goes elsewhere.
        if (!same) return filled || !reading ? route.abort("blockedbyclient") : route.continue();
        if (!filled) return route.continue();
        if (held && carries(req.url(), held)) return route.abort("blockedbyclient");
        try {
          // Redirect hops never reach this route, so each answer is looked at here. A 307 or 308 would carry the form on.
          const response = await route.fetch({ maxRedirects: 0 });
          const status = response.status();
          if (status === 307 || status === 308) return route.abort("blockedbyclient");
          if (status >= 300 && status < 400 && new URL(response.headers().location ?? "", req.url()).origin.toLowerCase() !== origin) return route.abort("blockedbyclient");
          return route.fulfill({ response });
        } catch { return route.abort("failed"); }
      });
      await context.routeWebSocket(/.*/, (ws) => {
        let same = false;
        try { same = new URL(ws.url().replace(/^ws/, "http")).origin.toLowerCase() === origin; } catch { same = false; }
        if (!same || filled) return ws.close();
        ws.connectToServer();
      });
      await context.addInitScript(SIGN_IN_INIT);
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      page.on("dialog", (d) => void d.dismiss().catch(() => {}));
      let documentStatus = 200;
      page.on("response", (r) => { try { if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) documentStatus = r.status(); } catch { /* a closed frame */ } });
      const settle = () => page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
      const human = async () => { if (await page.locator(CAPTCHA).count()) throw new Error("FLEET_SIGNIN_HUMAN"); };
      await page.goto(action.loginUrl, { waitUntil: "domcontentloaded" });
      await settle();
      const here = new URL(page.url());
      if (here.origin.toLowerCase() !== origin || here.pathname !== target.pathname) throw new Error("FLEET_SIGNIN_MOVED");
      await human();
      const password = page.locator('input[type="password"]:visible');
      // The name goes into the form that holds the password, and only into a field that says what it is. A lone text box in a name-first form is the one exception.
      const named = (scope: string) => page.locator(USER_FIELD.map((x) => `${scope}${x}:visible`).join(", ")).first();
      if (await password.count()) {
        const username = named('form:has(input[type="password"]) ');
        if (await username.count()) await username.fill(await this.secret(action, lease, "username", origin));
      } else {
        let username = named("");
        if (!(await username.count())) {
          const plain = page.locator('input[type="text"]:visible, input:not([type]):visible');
          if ((await plain.count()) !== 1) throw new Error("FLEET_SIGNIN_FORM");
          username = plain.first();
        }
        await username.fill(await this.secret(action, lease, "username", origin));
        await username.press("Enter");
        await password.first().waitFor({ state: "visible" }).catch(() => { throw new Error("FLEET_SIGNIN_FORM"); });
        if (at(page) !== origin) throw new Error("FLEET_ORIGIN_NOT_PINNED");
        await human();
      }
      if ((await password.count()) !== 1) throw new Error("FLEET_SIGNIN_FORM");
      const field = await password.first().elementHandle();
      if (!field) throw new Error("FLEET_SIGNIN_FORM");
      const form = await field.evaluate((el) => { const f = (el as HTMLInputElement).form; return f ? { to: new URL(f.getAttribute("action") ?? "", document.baseURI).origin, method: (f.getAttribute("method") ?? "get").toLowerCase() } : { to: document.location.origin, method: "post" }; });
      if (form.to.toLowerCase() !== origin) throw new Error("FLEET_ORIGIN_NOT_PINNED");
      if (form.method !== "post") throw new Error("FLEET_SIGNIN_FORM"); // the password would go into an address
      filled = true; // before the value exists
      // Not kept for scrubbing: it is not in the agent's context, and a kept value would confirm a guess.
      const value = await this.secret(action, lease, "password", origin);
      held = value;
      if (at(page) !== origin || !(await field.evaluate((el) => el.isConnected && (el as HTMLInputElement).type === "password"))) throw new Error("FLEET_ORIGIN_NOT_PINNED");
      await field.fill(value, { timeout: 2_000 });
      await field.press("Enter");
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await settle();
      if (at(page) !== origin) throw new Error("FLEET_ORIGIN_NOT_PINNED");
      // Only a field that says it is the code: a live code must not land in a promotion box.
      const code = page.locator(['input[autocomplete="one-time-code"]:visible', ...OTP_NAMES.flatMap((n) => [`input[name="${n}" i]:visible`, `input[id="${n}" i]:visible`])].join(", ")).first();
      const looksLikeCode = async () => (await code.count()) > 0 && !(await code.evaluate((el) => {
        const i = el as HTMLInputElement;
        return /promo|coupon|voucher|discount|gift|referr|invite|post|zip/i.test([i.name, i.id, i.placeholder, i.getAttribute("aria-label"), i.labels?.[0]?.textContent].join(" "));
      }));
      if (!(await password.count()) && (await looksLikeCode())) {
        const c = await this.secret(action, lease, "totp", origin).catch(() => { throw new Error("FLEET_SIGNIN_HUMAN"); });
        await code.fill(c);
        await code.press("Enter");
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await settle();
        if (at(page) !== origin) throw new Error("FLEET_ORIGIN_NOT_PINNED");
      }
      await human();
      if (documentStatus >= 400 || (await password.count()) || (await looksLikeCode())) throw new Error("FLEET_SIGNIN_FAILED");
      // Only this site's state moves across, and none that holds the login as it stands.
      const all = await context.storageState();
      const host = target.hostname.toLowerCase();
      state = { cookies: all.cookies.filter((c) => { const d = c.domain.replace(/^\./, "").toLowerCase(); return host === d || host.endsWith(`.${d}`); }), origins: all.origins.filter((o) => o.origin.toLowerCase() === origin) };
      const landed = new URL(page.url());
      after = `${landed.origin}${landed.pathname}`;
      if (carries(`${JSON.stringify(state)} ${after}`, value)) throw new Error("FLEET_SIGNIN_FORM");
    } finally {
      await context.close().catch(() => {});
    }
    await s.context.setStorageState(state);
    await s.page.goto(after, { waitUntil: "domcontentloaded" });
  }

  /**
   * v126: redirect hops never reach the route, so a page or frame could land on an address the policy refuses. Nothing of it reaches the agent. Only real web addresses are looked at:
   * Chromium's own error page for a dead link is not a refused one.
   */
  private async refusedPage(s: Session): Promise<boolean> {
    let refused = false;
    for (const p of [...s.pages]) {
      const addresses = p.frames().map((f) => f.url()).filter((u) => /^https?:/i.test(u));
      let bad = false;
      for (const u of addresses) if (!(await this.hosts.allowed(u, { allowLoopback: this.o.allowLoopback }).catch(() => false))) bad = true;
      if (bad) { refused = true; await p.goto("about:blank").catch(() => {}); }
    }
    return refused;
  }

  /** v126: what a session on an owner's account refuses before a step runs. */
  private async ownerStepAllowed(s: Session, step: Record<string, unknown>, a: string, page: Page): Promise<void> {
    if (!s.owner) return;
    if (a === "capture" || a === "open_auth_link" || a === "upload") throw new Error("FLEET_OWNER_ACCOUNT");
    if (a === "press" && !OWNER_KEYS.has(String(step.key))) throw new Error("FLEET_OWNER_ACCOUNT");
    if (a !== "fill") return;
    if (typeof step.credential === "string" && !OWNER_FILL.has(step.credential)) throw new Error("FLEET_OWNER_ACCOUNT");
    // Neither the agent's text nor the account's name can become a new password, even where the page has changed the field's type. A site that shows a password field under a
    // plain name after a toggle cannot be told apart.
    const like = await this.locator(page, step).evaluate((el) => {
      // A label, or anything inside one, passes a fill on to its control.
      const i = ((el.closest("label") as HTMLLabelElement | null)?.control ?? el) as HTMLInputElement;
      return { type: i.type ?? "", words: [i.name, i.id, i.getAttribute("autocomplete"), i.getAttribute("placeholder"), i.getAttribute("aria-label")].join(" ") };
    });
    if (like.type === "password" || PASSWORD_LIKE.test(like.words)) throw new Error("FLEET_OWNER_ACCOUNT");
  }

  private origin(page: Page): string {
    try { return new URL(page.url()).origin.toLowerCase(); } catch { return ""; }
  }

  /** Ask the registry/broker for one credential value; resolves to the plaintext (kept only by the caller). */
  private async secret(action: BrowserAction, lease: string, kind: string, origin: string, sealedIn: Buffer | null = null): Promise<string> {
    const req = await this.gw.secretRequest(action.actionId, lease, kind, origin, this.key.publicKeyDer.toString("base64"), sealedIn);
    if (!req.ok) throw new Error(req.code);
    const id = String(req.requestId);
    for (let i = 0; i < 120; i++) {
      const t = await this.gw.secretTake(id, action.actionId, lease);
      if (!t.ok) throw new Error(t.code);
      if (t.status === "served") return openSealed(this.key.privateKeyDer, this.key.publicKeyDer, Buffer.from(String(t.sealedB64), "base64"), `bsecret:${id}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("FLEET_SECRET_TIMEOUT");
  }

  private locator(page: Page, step: Record<string, unknown>) {
    // v79: an element inside an embedded frame (hosted card fields, embedded editors).
    const root = typeof step.frame === "string" ? page.frameLocator(step.frame).first() : page;
    if (typeof step.selector === "string") return root.locator(step.selector).first();
    return root.getByText(String(step.text), { exact: false }).first();
  }

  /** v79: store a file the page produced for the acting agent (bounded); its id is reported with the action. */
  private async produce(s: Session, action: BrowserAction, lease: string, kind: "download" | "screenshot" | "pdf", fileName: string, data: Buffer): Promise<void> {
    if (data.length < 1 || data.length > BROWSER_FILE_MAX_BYTES) throw new Error("FLEET_BROWSER_FILE_TOO_LARGE");
    const ext = /\.([a-z0-9]{1,5})$/i.exec(fileName)?.[1]?.toLowerCase() ?? "";
    const type = EXT_TYPES[ext] ?? "application/octet-stream";
    const name = fileName.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^[^A-Za-z0-9]+/, "").slice(0, 120) || `${kind}.bin`;
    const r = await this.gw.filePut(action.actionId, lease, kind, name, type, data);
    if (!r.ok) throw new Error(String(r.code));
    s.produced.push({ fileId: String(r.fileId), kind, fileName: name, sizeBytes: data.length });
  }

  /** v79: an image of the page leaves the worker only if nothing secret of the owner's was put into this session. */
  private imageAllowed(s: Session): void {
    if (s.ownerValues.size || s.captured) throw new Error("FLEET_BROWSER_CAPTURE_REFUSED");
  }

  private async run(s: Session, action: BrowserAction, lease: string, progress: { done: number }): Promise<number> {
    const done = progress;
    for (const step of action.steps) {
      const a = String(step.action);
      const page = s.page;
      // v80: an owner's release names its origins; an outward step on any other page is refused (a click may have navigated away).
      if (a === "sign_in") {
        // v126: its origin is the owner's login URL, whatever page the agent is on.
        if (Array.isArray(action.outwardOrigins) && !action.outwardOrigins.includes(action.loginUrl ? new URL(action.loginUrl).origin.toLowerCase() : "")) throw new Error("FLEET_OUTWARD_SCOPE");
        await this.signIn(s, action, lease);
        done.done++;
        continue;
      }
      if (Array.isArray(action.outwardOrigins) && OUTWARD_STEPS.has(a) && !action.outwardOrigins.includes(this.origin(page))) throw new Error("FLEET_OUTWARD_SCOPE");
      await this.ownerStepAllowed(s, step, a, page);
      switch (a) {
        case "goto": {
          const url = String(step.url);
          if (!(await this.hosts.allowed(url, { allowLoopback: this.o.allowLoopback }))) throw new Error("FLEET_BROWSER_URL_BLOCKED");
          await page.goto(url, { waitUntil: "domcontentloaded" });
          break;
        }
        case "back": await page.goBack({ waitUntil: "domcontentloaded" }); break;
        case "click": {
          // v79: a click that opens a tab (target=_blank, window.open) moves the session to it.
          const popup = page.waitForEvent("popup", { timeout: 1_500 }).catch(() => null);
          await this.locator(page, step).click();
          const p = await Promise.race([popup, new Promise<null>((r) => setTimeout(() => r(null), 500))]);
          if (p) { s.adopt(p); await p.waitForLoadState("domcontentloaded").catch(() => {}); }
          else await page.waitForLoadState("domcontentloaded").catch(() => {});
          break;
        }
        case "fill": {
          if (typeof step.credential === "string") {
            // v49: the owner's facts and card are named by class / field (the registry checks the standing authority, the
            // origin and, for the card, an open hold); the value is filled and forgotten like any credential.
            const kind = step.credential === "owner_fact" ? `owner_fact:${String(step.class)}${typeof step.field === "string" ? `:${step.field}` : ""}`
              : step.credential === "owner_card" ? `owner_card:${String(step.field)}` : step.credential;
            // v125: a login goes only into a real password field on the page's own document, and the page is checked again at the last moment: the origin
            // is read once the field exists, and a page that moved meanwhile gets nothing. Elsewhere it could be read back, or sent to another site.
            const login = ["password", "new_password", "generate_password"].includes(step.credential);
            const target = this.locator(page, step);
            if (login) {
              if (typeof step.frame === "string") throw new Error("FLEET_ORIGIN_NOT_PINNED");
              await target.waitFor({ state: "visible", timeout: 15_000 });
              const field = await target.evaluate((el) => (el as HTMLInputElement).tagName === "INPUT" && (el as HTMLInputElement).type === "password");
              if (!field) throw new Error("FLEET_BROWSER_FIELD_REFUSED");
            }
            const at = this.origin(page);
            const v = await this.secret(action, lease, kind, at);
            s.secrets.add(v);
            if (step.credential === "owner_fact" || step.credential === "owner_card") s.ownerValues.add(v);
            if (login && this.origin(page) !== at) throw new Error("FLEET_ORIGIN_NOT_PINNED");
            await target.fill(v, login ? { timeout: 2_000 } : undefined);
          } else {
            await this.locator(page, step).fill(String(step.value ?? ""));
          }
          break;
        }
        case "upload": {
          // v51: an owner document set straight into the provider's own file input from memory (sealed to this worker's
          // one-time key by the broker; never written to disk, never in a snapshot, never shown to the agent).
          const raw = await this.secret(action, lease, `owner_document:${String(step.class)}`, this.origin(page));
          const doc = JSON.parse(raw) as { contentType: string; dataB64: string };
          const ext = ({ "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as Record<string, string>)[doc.contentType];
          if (!ext) throw new Error("FLEET_OWNER_DOCUMENT_INVALID");
          const buffer = Buffer.from(doc.dataB64, "base64");
          try {
            await this.locator(page, step).setInputFiles({ name: `document.${ext}`, mimeType: doc.contentType, buffer });
          } finally {
            buffer.fill(0);
          }
          break;
        }
        case "select": await this.locator(page, step).selectOption(String(step.value)); break;
        case "check": await this.locator(page, step).check(); break;
        case "press": await page.keyboard.press(String(step.key)); await page.waitForLoadState("domcontentloaded").catch(() => {}); break;
        case "wait": await page.waitForTimeout(Math.min(10_000, Number(step.ms))); break;
        case "wait_for": await this.locator(page, step).waitFor(); break;
        case "open_auth_link": {
          const link = await this.secret(action, lease, "auth_link", this.origin(page));
          if (!(await this.hosts.allowed(link, { allowLoopback: this.o.allowLoopback }))) throw new Error("FLEET_BROWSER_URL_BLOCKED");
          s.secrets.add(link);
          await page.goto(link, { waitUntil: "domcontentloaded" });
          break;
        }
        case "capture": {
          const pub = await this.o.brokerPublicKey?.();
          if (!pub) throw new Error("FLEET_BROKER_KEY_UNAVAILABLE");
          const value = (await this.locator(page, step).innerText()).trim();
          if (!value) throw new Error("FLEET_CAPTURE_EMPTY");
          s.secrets.add(value);
          s.captured = true;
          const kind = String(step.kind);
          const sealed = sealTo(Buffer.from(pub, "base64"), value, `capture:${action.accountId}:${kind}`);
          const ack = await this.secret(action, lease, `capture:${kind}`, this.origin(page), sealed);
          if (ack !== "stored") throw new Error("FLEET_CAPTURE_FAILED");
          break;
        }
        // ── v79 ──
        case "upload_file": {
          // Files the agent staged from its own workspace (browser stage_file), read for this action only.
          const ids = Array.isArray(step.fileIds) ? step.fileIds.map(String) : [String(step.fileId)];
          const files: Array<{ name: string; mimeType: string; buffer: Buffer }> = [];
          for (const id of ids) {
            const f = await this.gw.fileTake(action.actionId, lease, id);
            if (!f.ok) throw new Error(f.code);
            files.push({ name: f.fileName, mimeType: f.contentType, buffer: f.data });
          }
          await this.locator(page, step).setInputFiles(files.length === 1 ? files[0] : files);
          break;
        }
        case "set_content": {
          // Render an HTML (or SVG) file the agent staged; the session has no account; subresources pass the URL policy.
          const f = await this.gw.fileTake(action.actionId, lease, String(step.fileId));
          if (!f.ok) throw new Error(f.code);
          if (f.contentType !== "text/html" && f.contentType !== "image/svg+xml") throw new Error("FLEET_BROWSER_NOT_HTML");
          await page.setContent(f.data.toString("utf8"), { waitUntil: "load", timeout: 20_000 });
          break;
        }
        case "download": {
          const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), this.locator(page, step).click()]);
          const name = dl.suggestedFilename() || "download.bin";
          try {
            if (CREDENTIAL_FILE.test(name)) throw new Error("FLEET_BROWSER_DOWNLOAD_CREDENTIAL");
            const file = await dl.path();
            if (!file) throw new Error("FLEET_BROWSER_DOWNLOAD_FAILED");
            if ((await fs.promises.stat(file)).size > BROWSER_FILE_MAX_BYTES) throw new Error("FLEET_BROWSER_FILE_TOO_LARGE");
            await this.produce(s, action, lease, "download", name, await fs.promises.readFile(file));
          } finally {
            await dl.delete().catch(() => {});
          }
          break;
        }
        case "screenshot": {
          this.imageAllowed(s);
          const mask = [page.locator("input, textarea, select")];
          const data = typeof step.selector === "string"
            ? await this.locator(page, step).screenshot({ type: "png", mask, timeout: 20_000 })
            : await page.screenshot({ type: "png", fullPage: step.fullPage === true, mask, timeout: 20_000 });
          await this.produce(s, action, lease, "screenshot", `screenshot-${Date.now().toString(36)}.png`, data);
          break;
        }
        case "pdf": {
          this.imageAllowed(s);
          // v125: a PDF prints field values as they are, unmasked.
          if (s.secrets.size) throw new Error("FLEET_BROWSER_CAPTURE_REFUSED");
          const data = await page.pdf({ printBackground: true, format: step.format === "Letter" ? "Letter" : "A4", landscape: step.landscape === true });
          await this.produce(s, action, lease, "pdf", `page-${Date.now().toString(36)}.pdf`, data);
          break;
        }
        case "hover": await this.locator(page, step).hover(); break;
        case "uncheck": await this.locator(page, step).uncheck(); break;
        case "scroll": {
          if (typeof step.selector === "string") await this.locator(page, step).scrollIntoViewIfNeeded();
          else await page.evaluate((to) => window.scrollTo(0, to === "top" ? 0 : document.body.scrollHeight), String(step.to));
          await page.waitForTimeout(300);
          break;
        }
        case "wait_idle": await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {}); break;
        case "tab": {
          const p = s.pages[Number(step.index)];
          if (!p) throw new Error("FLEET_BROWSER_NO_TAB");
          s.page = p;
          await p.bringToFront().catch(() => {});
          break;
        }
        case "dialog": s.dialog = { accept: step.accept === true, ...(typeof step.text === "string" ? { text: step.text } : {}) }; break;
        default:
          throw new Error("FLEET_BAD_REQUEST");
      }
      done.done++;
      if (await this.refusedPage(s)) throw new Error("FLEET_BROWSER_URL_BLOCKED");
    }
    return done.done;
  }

  /** What the agent sees: text, form fields (never their values), links, buttons, CAPTCHA presence; secrets redacted. */
  private async snapshot(s: Session): Promise<Record<string, unknown>> {
    const page = s.page;
    const data = await page.evaluate(() => {
      const sel = (el: Element): string => {
        const id = (el as HTMLElement).id;
        if (id && /^[A-Za-z][\w-]*$/.test(id)) return `#${id}`;
        const name = el.getAttribute("name");
        if (name) return `${el.tagName.toLowerCase()}[name="${name.replace(/"/g, "")}"]`;
        const all = Array.from(document.querySelectorAll(el.tagName));
        return `${el.tagName.toLowerCase()} >> nth=${all.indexOf(el)}`;
      };
      const label = (el: Element): string => {
        const id = (el as HTMLElement).id;
        const l = id ? document.querySelector(`label[for="${id}"]`) : el.closest("label");
        return (l?.textContent ?? el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? "").trim().slice(0, 2000);
      };
      const fields = Array.from(document.querySelectorAll("input, textarea, select")).filter((e) => (e as HTMLInputElement).type !== "hidden").slice(0, 60)
        .map((e) => ({ selector: sel(e), type: (e as HTMLInputElement).type || e.tagName.toLowerCase(), name: e.getAttribute("name") ?? undefined, label: label(e),
          required: (e as HTMLInputElement).required || undefined }));
      const links = Array.from(document.querySelectorAll("a[href]")).slice(0, 60)
        .map((a) => ({ text: (a.textContent ?? "").trim().slice(0, 2000), href: (a as HTMLAnchorElement).href }));
      const buttons = Array.from(document.querySelectorAll("button, input[type=submit], input[type=button], [role=button]")).slice(0, 30)
        .map((b) => ({ selector: sel(b), text: ((b.textContent ?? "") || (b.tagName === "INPUT" && ["submit", "button", "reset"].includes((b as HTMLInputElement).type) ? (b as HTMLInputElement).value : "") || "").trim().slice(0, 2000) }));
      const captcha = Boolean(document.querySelector("iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='turnstile'], iframe[src*='captcha'], .g-recaptcha, .h-captcha, .cf-turnstile"));
      return { title: document.title, text: (document.body?.innerText ?? "").slice(0, 20000), fields, links, buttons, captcha };
    });
    // Origin + path only: query strings and fragments can carry tokens.
    let url = "";
    try { const u = new URL(page.url()); url = u.protocol === "about:" ? page.url() : `${u.origin}${u.pathname}`; } catch { url = ""; }
    const where = (p: Page) => { try { const x = new URL(p.url()); return x.protocol === "about:" ? p.url() : `${x.origin}${x.pathname}`; } catch { return ""; } };
    const tabs = s.pages.length > 1 ? s.pages.map((p, i) => ({ index: i, current: p === s.page, url: where(p) })) : undefined;
    // v126: cut to length only after the scrub: a cut could leave part of a value behind. A short value is too common to redact from an address.
    const text = this.scrub(s, data.text);
    return { url: this.scrub(s, url, 8), title: this.scrub(s, String(data.title ?? "")).slice(0, 2000), text: text.slice(0, TEXT_MAX), truncated: text.length > TEXT_MAX,
      fields: data.fields.map((f) => ({ ...f, label: this.scrub(s, f.label).slice(0, 120) })),
      links: data.links.map((l) => ({ text: this.scrub(s, l.text).slice(0, 120), href: this.scrub(s, l.href) })),
      buttons: data.buttons.map((b) => ({ ...b, text: this.scrub(s, b.text).slice(0, 80) })), captcha: data.captcha,
      ...(tabs ? { tabs: tabs.map((t) => ({ ...t, url: this.scrub(s, t.url, 8) })) } : {}), ...(s.lastDialog ? { lastDialog: s.lastDialog } : {}),
      ...(data.captcha ? { note: "A CAPTCHA is present: a human-only step. account.mark {status: human_action_required} keeps every other action going." } : {}) };
  }

  /** Execute one action and report it. */
  async handle(action: BrowserAction, lease: string): Promise<boolean> {
    let s = this.sessions.get(action.sessionId);
    if (action.kind === "close") {
      if (s) { await s.context.close().catch(() => {}); this.sessions.delete(action.sessionId); }
      await this.gw.report(action.actionId, lease, true, { closed: true }, null);
      return true;
    }
    if (!s) {
      if (action.kind !== "open") {
        await this.gw.report(action.actionId, lease, false, { code: "FLEET_BROWSER_SESSION_LOST", note: "the browser session ended; open a new one" }, null);
        return false;
      }
      s = await this.newSession(action.ownerAccount === true);
      this.sessions.set(action.sessionId, s);
    }
    const progress = { done: 0 };
    s.produced = [];
    let error: string | null = null;
    try {
      await this.run(s, action, lease, progress);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      error = /FLEET_[A-Z_]+/.exec(m)?.[0] ?? (/Timeout/i.test(m) ? "FLEET_BROWSER_TIMEOUT" : "FLEET_BROWSER_STEP_FAILED");
    }
    if (await this.refusedPage(s)) error = error ?? "FLEET_BROWSER_URL_BLOCKED";
    let snap: Record<string, unknown> = {};
    try { snap = await this.snapshot(s); } catch { snap = { url: null }; }
    const steps = progress.done;
    const result = { ...snap, stepsDone: steps, ...(s.produced.length ? { files: s.produced } : {}), ...(error ? { code: error, failedStep: steps } : {}) };
    await this.gw.report(action.actionId, lease, !error, result, typeof snap.url === "string" ? snap.url : null);
    this.o.log?.("info", "browser_action", { actionId: action.actionId, kind: action.kind, steps, code: error });
    return !error;
  }

  async tick(max = 5): Promise<number> {
    let n = 0;
    // v95: sessions live in this process, so after a (re)start every action still claimed lost its answer; later, any
    // claimed beyond the lost-answer window. One with an outward step becomes uncertain (never re-run); a read fails.
    if (this.gw.actionsLost) {
      const lost = await this.gw.actionsLost(this.worker, !this.swept).catch(() => null);
      if (lost?.ok) this.swept = true;
      if (lost && (Number(lost.uncertain) || Number(lost.failed))) this.o.log?.("warn", "browser_actions_lost", { uncertain: lost.uncertain ?? 0, failed: lost.failed ?? 0 });
    }
    for (let i = 0; i < max; i++) {
      const lease = crypto.randomBytes(32).toString("base64url");
      const c = await this.gw.claim(this.worker, crypto.createHash("sha256").update(lease, "utf8").digest("hex"));
      if (!c.ok || !c.action) break;
      await this.handle(c.action, lease);
      n++;
    }
    return n;
  }

  async close(): Promise<void> {
    for (const s of this.sessions.values()) await s.context.close().catch(() => {});
    this.sessions.clear();
    await this.browser?.close().catch(() => {});
    this.browser = null;
    await this.egress?.close().catch(() => {});
    this.egress = null;
  }
}
