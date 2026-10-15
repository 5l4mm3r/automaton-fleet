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
 */
import crypto from "crypto";
import fs from "fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { generateX25519, openSealed, sealTo } from "../identity/crypto.js";
import type { BrowserAction, BrowserGatewayPort } from "./gateway.js";
import { HostResolutionPolicy } from "./policy.js";

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
}

const TEXT_MAX = 8000;
/** v79: the largest file a page may hand over (download / screenshot / pdf). */
export const BROWSER_FILE_MAX_BYTES = 25_000_000;
const EXT_TYPES: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  svg: "image/svg+xml", csv: "text/csv", txt: "text/plain", json: "application/json", zip: "application/zip", html: "text/html", md: "text/markdown",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", mp4: "video/mp4", mp3: "audio/mpeg" };
/** v79: a download whose name says it carries credentials never reaches the agent (a shown secret is captured into the vault instead). */
const CREDENTIAL_FILE = /recovery|backup[ _-]?codes|secret|credential|private[ _-]?key|\.pem$|\.key$/i;

export class BrowserWorker {
  private readonly worker: string;
  private browser: Browser | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly key = generateX25519();
  private readonly hosts: HostResolutionPolicy;

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
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.launch({ executablePath: this.o.executablePath, headless: true, chromiumSandbox: this.o.chromiumSandbox ?? false,
        args: ["--disable-dev-shm-usage", "--no-first-run", "--disable-background-networking", "--disable-sync", "--metrics-recording-only"] });
    }
    return this.browser;
  }

  private async newSession(): Promise<Session> {
    const b = await this.ensureBrowser();
    // v79: downloads are accepted (into the service's private temporary directory) and handed over only by a download step.
    const context = await b.newContext({ ignoreHTTPSErrors: Boolean(this.o.ignoreHttpsErrors), acceptDownloads: true, viewport: { width: 1280, height: 900 },
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" });
    const allow = { allowLoopback: this.o.allowLoopback };
    await context.route("**/*", async (route) => ((await this.hosts.allowed(route.request().url(), allow).catch(() => false)) ? route.continue() : route.abort("blockedbyclient")));
    const page = await context.newPage();
    const s: Session = { context, page, secrets: new Set(), ownerValues: new Set(), pages: [page], captured: false, dialog: null, lastDialog: null, produced: [], adopt: () => {} };
    const watch = (p: Page) => {
      p.setDefaultTimeout(15_000);
      p.on("dialog", (d) => {
        s.lastDialog = `${d.type()}: ${d.message().slice(0, 300)}`;
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
            const v = await this.secret(action, lease, kind, this.origin(page));
            s.secrets.add(v);
            if (step.credential === "owner_fact" || step.credential === "owner_card") s.ownerValues.add(v);
            await this.locator(page, step).fill(v);
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
      // Owner values are redacted from 3 characters (a card's CVC); other short values are left (too common to redact).
      if (secret.length < (s.ownerValues.has(secret) ? 3 : 4)) continue;
      text = text.split(secret).join("[credential]");
      linksJson = linksJson.split(secret).join("[credential]");
    }
    // Origin + path only: query strings and fragments can carry tokens.
    let url = "";
    try { const u = new URL(page.url()); url = u.protocol === "about:" ? page.url() : `${u.origin}${u.pathname}`; } catch { url = ""; }
    const where = (p: Page) => { try { const x = new URL(p.url()); return x.protocol === "about:" ? p.url() : `${x.origin}${x.pathname}`; } catch { return ""; } };
    const tabs = s.pages.length > 1 ? s.pages.map((p, i) => ({ index: i, current: p === s.page, url: where(p) })) : undefined;
    return { url, title: data.title, text: text.slice(0, TEXT_MAX),
      truncated: text.length > TEXT_MAX, fields: data.fields, links: JSON.parse(linksJson), buttons: data.buttons, captcha: data.captcha,
      ...(tabs ? { tabs } : {}), ...(s.lastDialog ? { lastDialog: s.lastDialog } : {}),
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
    s.produced = [];
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
    const result = { ...snap, stepsDone: steps, ...(s.produced.length ? { files: s.produced } : {}), ...(error ? { code: error, failedStep: steps } : {}) };
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
