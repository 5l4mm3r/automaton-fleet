/**
 * Browser worker (schema v37): executes agents' browser actions in real Chromium sessions — the general account /
 * website operator (no per-site adapter). It holds no vault: a credential a step needs is requested from the registry,
 * answered by the identity broker sealed to this worker's one-time X25519 key, filled into the page and forgotten. Page
 * snapshots never carry a value this worker filled or captured, and never read input values at all.
 *
 * Sessions live in memory (a worker restart ends them: the next action reports FLEET_BROWSER_SESSION_LOST and the agent
 * opens a new one). Every request a page makes is checked against the URL policy.
 */
import crypto from "crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { generateX25519, openSealed, sealTo } from "../identity/crypto.js";
import type { BrowserAction, BrowserGatewayPort } from "./gateway.js";
import { browserUrlAllowed } from "./policy.js";

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
}

interface Session {
  context: BrowserContext;
  page: Page;
  secrets: Set<string>;
}

const TEXT_MAX = 8000;

export class BrowserWorker {
  private readonly worker: string;
  private browser: Browser | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly key = generateX25519();

  constructor(private readonly gw: BrowserGatewayPort, private readonly o: BrowserWorkerOptions) {
    this.worker = o.worker ?? "browser-worker";
    if (!/^[a-z0-9_.-]{1,64}$/.test(this.worker)) throw new Error("worker name must match ^[a-z0-9_.-]{1,64}$");
  }

  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.launch({ executablePath: this.o.executablePath, headless: true, chromiumSandbox: this.o.chromiumSandbox ?? false,
        args: ["--disable-dev-shm-usage", "--no-first-run", "--disable-background-networking", "--disable-sync", "--metrics-recording-only"] });
    }
    return this.browser;
  }

  private async newSession(): Promise<Session> {
    const b = await this.ensureBrowser();
    const context = await b.newContext({ ignoreHTTPSErrors: Boolean(this.o.ignoreHttpsErrors), acceptDownloads: false,
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" });
    await context.route("**/*", (route) => (browserUrlAllowed(route.request().url(), { allowLoopback: this.o.allowLoopback }) ? route.continue() : route.abort("blockedbyclient")));
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    return { context, page, secrets: new Set() };
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
    if (typeof step.selector === "string") return page.locator(step.selector).first();
    return page.getByText(String(step.text), { exact: false }).first();
  }

  private async run(s: Session, action: BrowserAction, lease: string, progress: { done: number }): Promise<number> {
    const done = progress;
    for (const step of action.steps) {
      const a = String(step.action);
      const page = s.page;
      switch (a) {
        case "goto": {
          const url = String(step.url);
          if (!browserUrlAllowed(url, { allowLoopback: this.o.allowLoopback })) throw new Error("FLEET_BROWSER_URL_BLOCKED");
          await page.goto(url, { waitUntil: "domcontentloaded" });
          break;
        }
        case "back": await page.goBack({ waitUntil: "domcontentloaded" }); break;
        case "click": await this.locator(page, step).click(); await page.waitForLoadState("domcontentloaded").catch(() => {}); break;
        case "fill": {
          if (typeof step.credential === "string") {
            const v = await this.secret(action, lease, step.credential, this.origin(page));
            s.secrets.add(v);
            await this.locator(page, step).fill(v);
          } else {
            await this.locator(page, step).fill(String(step.value ?? ""));
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
          if (!browserUrlAllowed(link, { allowLoopback: this.o.allowLoopback })) throw new Error("FLEET_BROWSER_URL_BLOCKED");
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
          const kind = String(step.kind);
          const sealed = sealTo(Buffer.from(pub, "base64"), value, `capture:${action.accountId}:${kind}`);
          const ack = await this.secret(action, lease, `capture:${kind}`, this.origin(page), sealed);
          if (ack !== "stored") throw new Error("FLEET_CAPTURE_FAILED");
          break;
        }
        default:
          throw new Error("FLEET_BAD_REQUEST");
      }
      done.done++;
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
        return (l?.textContent ?? el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? "").trim().slice(0, 120);
      };
      const fields = Array.from(document.querySelectorAll("input, textarea, select")).filter((e) => (e as HTMLInputElement).type !== "hidden").slice(0, 60)
        .map((e) => ({ selector: sel(e), type: (e as HTMLInputElement).type || e.tagName.toLowerCase(), name: e.getAttribute("name") ?? undefined, label: label(e),
          required: (e as HTMLInputElement).required || undefined }));
      const links = Array.from(document.querySelectorAll("a[href]")).slice(0, 60)
        .map((a) => ({ text: (a.textContent ?? "").trim().slice(0, 120), href: (a as HTMLAnchorElement).href }));
      const buttons = Array.from(document.querySelectorAll("button, input[type=submit], input[type=button], [role=button]")).slice(0, 30)
        .map((b) => ({ selector: sel(b), text: ((b.textContent ?? "") || (b as HTMLInputElement).value || "").trim().slice(0, 80) }));
      const captcha = Boolean(document.querySelector("iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='turnstile'], iframe[src*='captcha'], .g-recaptcha, .h-captcha, .cf-turnstile"));
      return { title: document.title, text: (document.body?.innerText ?? "").slice(0, 20000), fields, links, buttons, captcha };
    });
    let text = data.text;
    let linksJson = JSON.stringify(data.links);
    for (const secret of s.secrets) {
      if (secret.length < 4) continue;
      text = text.split(secret).join("[credential]");
      linksJson = linksJson.split(secret).join("[credential]");
    }
    // Origin + path only: query strings and fragments can carry tokens.
    let url = "";
    try { const u = new URL(page.url()); url = u.protocol === "about:" ? page.url() : `${u.origin}${u.pathname}`; } catch { url = ""; }
    return { url, title: data.title, text: text.slice(0, TEXT_MAX),
      truncated: text.length > TEXT_MAX, fields: data.fields, links: JSON.parse(linksJson), buttons: data.buttons, captcha: data.captcha,
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
      s = await this.newSession();
      this.sessions.set(action.sessionId, s);
    }
    const progress = { done: 0 };
    let error: string | null = null;
    try {
      await this.run(s, action, lease, progress);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      error = /FLEET_[A-Z_]+/.exec(m)?.[0] ?? (/Timeout/i.test(m) ? "FLEET_BROWSER_TIMEOUT" : "FLEET_BROWSER_STEP_FAILED");
    }
    let snap: Record<string, unknown> = {};
    try { snap = await this.snapshot(s); } catch { snap = { url: null }; }
    const steps = progress.done;
    const result = { ...snap, stepsDone: steps, ...(error ? { code: error, failedStep: steps } : {}) };
    await this.gw.report(action.actionId, lease, !error, result, typeof snap.url === "string" ? snap.url : null);
    this.o.log?.("info", "browser_action", { actionId: action.actionId, kind: action.kind, steps, code: error });
    return !error;
  }

  async tick(max = 5): Promise<number> {
    let n = 0;
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
  }
}
