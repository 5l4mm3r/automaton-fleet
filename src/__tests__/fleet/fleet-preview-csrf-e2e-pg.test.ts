/**
 * The /hq-preview/ layout (production's: the LIVE root export + the preview build under /hq-preview/, one static dir,
 * one dashboard server, one origin) — mutations through the real gateway with real passkey + TOTP sign-in.
 *
 * Gated (builds the LIVE and preview exports): FLEET_PREVIEW_TESTS=1 npx vitest run src/__tests__/fleet/fleet-preview-csrf-e2e-pg.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { chromium, type Browser, type BrowserContext, type Page, type Request } from "playwright-core";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { CODEX, ensureLiveUi } from "./fixtures/live-ui.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { totp } from "../../fleet/identity/crypto.js";
import { PgDashboardGateway } from "../../fleet/dashboard/gateway.js";
import { createDashboardServer } from "../../fleet/dashboard/server.js";

const PG_BIN = findPgBin();
const CHROME = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => fs.existsSync(p)) ?? null;
const RUN = !!process.env.FLEET_PREVIEW_TESTS && !!PG_BIN && !!CHROME && fs.existsSync(path.join(CODEX, "node_modules"));

/** Copy a directory tree (the exports are small). */
function copyTree(from: string, to: string) { fs.cpSync(from, to, { recursive: true }); }

describe.skipIf(!RUN)("/hq-preview/ beside the production root: secure mutations (real gateway, passkey + TOTP)", { timeout: 240_000 }, () => {
  let R: EconomyRegistry;
  let dgw: PgDashboardGateway;
  let server: http.Server;
  let browser: Browser;
  let ctx: BrowserContext;
  let tmp = "";
  let ORIGIN = "";
  let secret = "";
  const stateKey = crypto.randomBytes(32); // stable across a server restart (it seals the TOTP secret)
  const calls: Array<Record<string, unknown>> = [];
  let passkeys: Array<Record<string, unknown>> = [];
  // TOTP steps are single-use: every sign-in here takes the first unspent step in the server's window (±1 step).
  let lastStep = 0;
  const nextCode = async () => {
    let now = Math.floor(Date.now() / 30_000);
    const want = Math.max(now, lastStep + 1);
    while (want > now + 1) { await new Promise((r) => setTimeout(r, 2000)); now = Math.floor(Date.now() / 30_000); }
    lastStep = want;
    return totp(secret, want * 30_000 + 1);
  };

  const watch = (page: Page, tab: string) => {
    page.on("request", (r: Request) => {
      if (!r.url().endsWith("/api/call")) return;
      const h = r.headers();
      void r.response().then(async (res) => {
        const body = await res?.json().catch(() => null) as { ok?: boolean; code?: string } | null;
        calls.push({ tab, page: new URL(page.url()).pathname, url: r.url(), method: r.method(), xcsrf: !!h["x-csrf"], cookie: (await ctx.cookies()).some((c) => c.name.length > 0),
          origin: h["origin"] ?? null, referer: h["referer"] ?? null, contentType: h["content-type"], status: res?.status(), ok: body?.ok ?? null, code: body?.code ?? null, op: JSON.parse(r.postData() ?? "{}").op });
      });
    });
  };
  const notify = (title: string) => R.q(`SELECT fleet.fleet_notify('AMBER', 'TEST_NOTICE', NULL, $1, '{}'::jsonb, $2)`, [title, crypto.randomUUID()]);
  const unacked = async () => Number((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_notifications WHERE acknowledged_at IS NULL`))[0].n);

  beforeAll(async () => {
    // The two exports, in production's layout: <root> = LIVE build, <root>/hq-preview/ = preview build.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-preview-layout-"));
    execFileSync(process.execPath, ["scripts/build.mjs", "preview"], { cwd: CODEX, stdio: "ignore", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
    copyTree(path.join(CODEX, "out"), path.join(tmp, "preview"));
    execFileSync(process.execPath, ["scripts/build.mjs", "live"], { cwd: CODEX, stdio: "ignore", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
    ensureLiveUi();
    copyTree(path.join(CODEX, "out"), path.join(tmp, "root"));
    copyTree(path.join(tmp, "preview"), path.join(tmp, "root", "hq-preview"));
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000, treasuryCents: 1_000_000 });
    dgw = new PgDashboardGateway({ connectionString: R.pgc.dashboardUrl });
    server = createDashboardServer(dgw, { origin: "http://localhost:0", rpId: "localhost", stateKey: crypto.randomBytes(32) });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    server.close();
    ORIGIN = `http://localhost:${port}`;
    server = createDashboardServer(dgw, { origin: ORIGIN, rpId: "localhost", stateKey, staticDir: path.join(tmp, "root") });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
    browser = await chromium.launch({ executablePath: CHROME!, headless: true, args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
    ctx = await browser.newContext();
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("WebAuthn.enable", { enableUI: false });
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    (globalThis as { __auth?: { cdp: typeof cdp; id: string } }).__auth = { cdp, id: authenticatorId };
    const enrol = crypto.randomBytes(32).toString("base64url");
    await R.q(`SELECT fleet.fleet_admin_dashboard_enroll($1, $2)`, [crypto.createHash("sha256").update(enrol).digest("hex"), OWNER]);
    await page.goto(`${ORIGIN}/login/#enroll=${enrol}`);
    await page.getByRole("button", { name: "Register passkey" }).click();
    await page.getByRole("button", { name: "Confirm authenticator" }).waitFor();
    secret = (await page.locator("p.font-mono").first().textContent())!.trim();
    lastStep = Math.floor(Date.now() / 30_000);
    await page.getByLabel("Code from the authenticator").fill(totp(secret, lastStep * 30_000 + 1));
    await page.getByRole("button", { name: "Confirm authenticator" }).click();
    (globalThis as { __tabA?: Page }).__tabA = page;
    // (A real browser's platform authenticator is shared by its tabs; a virtual one is per tab: the lonely-tab test
    // copies the owner's passkey into its own tab's authenticator.)
  }, 600_000);
  afterAll(async () => {
    await browser?.close(); server?.close(); await dgw?.close(); await R?.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`preview csrf calls: ${JSON.stringify(calls)}`);
  });

  const signIn = async (page: Page, at: string) => {
    await page.goto(`${ORIGIN}${at}`);
    await page.getByRole("button", { name: "Sign in with passkey" }).click();
    // (V2.4.2: the start screen also has the password form's code field; the passkey step's own form replaces it.)
    await page.getByRole("button", { name: "Complete sign-in" }).waitFor();
    await page.getByLabel("Authenticator code").fill(await nextCode());
    await page.getByRole("button", { name: "Complete sign-in" }).click();
  };
  const openNotifications = async (page: Page) => {
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /^\d+Notifications/ }).click();
    await page.getByText("Alert feed").waitFor();
  };
  const ackOne = async (page: Page, title: string) => {
    const row = page.locator("div.rounded-lg").filter({ hasText: title }).first();
    await row.getByRole("button", { name: "Acknowledge" }).click();
    const review = page.getByRole("button", { name: "Review changes" });
    if (await review.isVisible().catch(() => false)) { await review.click(); await page.getByRole("button", { name: "Confirm", exact: true }).click(); }
    await page.waitForTimeout(1500);
  };

  const sidebarCount = async (page: Page) => Number(/\((\d+)\)/.exec((await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /Notifications/ }).textContent()) ?? "")?.[1] ?? NaN);
  const ackedRow = async (title: string) => (await R.q(`SELECT acknowledged_at IS NOT NULL AS acked, acknowledged_by FROM fleet.fleet_notifications WHERE title = $1`, [title]))[0];
  const tokenOf = (page: Page) => page.evaluate(() => sessionStorage.getItem("fleet_csrf"));
  /** Raw HTTP against the gateway (the server's own checks, no browser help). */
  const rawCall = async (headers: Record<string, string>, op = "notification_ack", args: Record<string, unknown> = { id: crypto.randomUUID() }) => {
    const r = await fetch(`${ORIGIN}/api/call`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ op, args: JSON.stringify(args) }) });
    return { status: r.status, code: ((await r.json().catch(() => ({}))) as { code?: string }).code ?? null };
  };
  const cookieHeader = async () => (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");

  it("the tab that signed in acknowledges at the root and in the preview (same mutation path, X-CSRF sent)", async () => {
    const A = (globalThis as { __tabA?: Page }).__tabA!;
    watch(A, "A");
    await signIn(A, "/login/");
    await A.waitForURL(`${ORIGIN}/`);
    for (const t of ["N-root-A", "N-preview-A"]) await notify(t);
    await A.reload(); await openNotifications(A); await ackOne(A, "N-root-A");
    await A.goto(`${ORIGIN}/hq-preview/`); await openNotifications(A); await ackOne(A, "N-preview-A");
    expect((await ackedRow("N-root-A")).acked).toBe(true); expect((await ackedRow("N-preview-A")).acked).toBe(true);
    expect((await ackedRow("N-preview-A")).acknowledged_by).toBe(OWNER); // attributed to the authenticated Admin (the dashboard's owner actor)
    expect(calls.filter((c) => c.tab === "A").every((c) => c.xcsrf && c.status === 200 && String(c.url).endsWith("/api/call") && !String(c.url).includes("/hq-preview/api"))).toBe(true);
  });

  it("a NEW tab opened at /hq-preview/ (never signed in) takes the token from the open dashboard tab: individual Acknowledge works and persists", async () => {
    await notify("N-preview-B");
    const B = await ctx.newPage(); watch(B, "B");
    (globalThis as { __tabB?: Page }).__tabB = B;
    await B.goto(`${ORIGIN}/hq-preview/`); await openNotifications(B);
    const before = await sidebarCount(B);
    await ackOne(B, "N-preview-B");
    expect((await ackedRow("N-preview-B")).acked).toBe(true);
    const mine = calls.filter((c) => c.tab === "B" && c.op === "notification_ack");
    expect(mine.length).toBe(1); expect(mine[0]).toMatchObject({ xcsrf: true, status: 200, code: null });
    await B.reload(); await openNotifications(B);
    expect(await sidebarCount(B)).toBe(before - 1); // persisted; the sidebar counter follows
    await B.getByLabel("Filter").selectOption("unread");
    expect(await B.locator("div.rounded-lg").filter({ hasText: "N-preview-B" }).count()).toBe(0); // no longer among the unread
    await B.getByLabel("Filter").selectOption("all");
  });

  it("Acknowledge all (the existing control): every eligible notification, history kept, counters and refresh correct, harmless at zero", async () => {
    const B = (globalThis as { __tabB?: Page }).__tabB!;
    for (const t of ["N-all-1", "N-all-2", "N-all-3"]) await notify(t);
    await B.reload(); await openNotifications(B);
    const total = Number((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_notifications`))[0].n);
    expect(await sidebarCount(B)).toBeGreaterThanOrEqual(3);
    await B.getByRole("button", { name: "Acknowledge all" }).click();
    const review = B.getByRole("button", { name: "Review changes" });
    if (await review.isVisible().catch(() => false)) { await review.click(); await B.getByRole("button", { name: "Confirm", exact: true }).click(); }
    await B.waitForTimeout(2500);
    expect(await unacked()).toBe(0);
    expect(Number((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_notifications`))[0].n)).toBe(total); // history kept (nothing deleted)
    for (const t of ["N-all-1", "N-all-2", "N-all-3"]) expect((await ackedRow(t)).acknowledged_by).toBe(OWNER); // attributed
    expect(await sidebarCount(B)).toBe(0);
    await B.reload(); await openNotifications(B); expect(await sidebarCount(B)).toBe(0); // persisted
    // At zero outstanding: harmless (no error shown, nothing changes).
    const acks = calls.length;
    await B.getByRole("button", { name: "Acknowledge all" }).click();
    if (await review.isVisible().catch(() => false)) { await review.click(); await B.getByRole("button", { name: "Confirm", exact: true }).click(); }
    await B.waitForTimeout(1500);
    expect(await B.getByRole("alert").filter({ hasText: /FLEET_/ }).count()).toBe(0);
    expect(calls.slice(acks).every((c) => c.status === 200)).toBe(true);
    // A repeated individual acknowledgement of an already acknowledged notification is harmless (server: no change).
    const id = (await R.q(`SELECT notification_id FROM fleet.fleet_notifications WHERE title = 'N-all-1'`))[0].notification_id;
    const tok = await tokenOf(B);
    const again = await rawCall({ Cookie: await cookieHeader(), "X-CSRF": tok!, Origin: ORIGIN }, "notification_ack", { id });
    expect(again.status).toBe(200);
  });

  it("a stale token (the session was replaced) is refused, then the write is retried once with the current token from another tab", async () => {
    await notify("N-stale"); // tab B stays open: it holds the current token
    const S = await ctx.newPage(); watch(S, "S");
    await S.goto(`${ORIGIN}/hq-preview/`); await openNotifications(S);
    await S.evaluate(() => sessionStorage.setItem("fleet_csrf", "stale_" + "x".repeat(40)));
    await ackOne(S, "N-stale");
    const mine = calls.filter((c) => c.tab === "S" && c.op === "notification_ack");
    expect(mine.map((c) => c.code)).toEqual(["FLEET_CSRF", null]); // refused (nothing ran), then accepted once
    expect((await ackedRow("N-stale")).acked).toBe(true);
    await S.close();
  });

  it("a tab with no verified peer is refused (nothing applied) and offered \"Verify this tab\" (in the dialog and on the page)", async () => {
    await notify("N-lonely");
    // The passkey as it is NOW (its signature counter included — the server refuses a stale, cloned counter).
    const au = (globalThis as { __auth?: { cdp: { send: (m: string, p: unknown) => Promise<{ credentials: Array<Record<string, unknown>> }> }; id: string } }).__auth!;
    passkeys = (await au.cdp.send("WebAuthn.getCredentials", { authenticatorId: au.id })).credentials;
    for (const p of ctx.pages()) await p.close(); // no other dashboard tab is open
    const D = await ctx.newPage(); watch(D, "D");
    const cdp = await ctx.newCDPSession(D);
    await cdp.send("WebAuthn.enable", { enableUI: false });
    const { authenticatorId: dAuth } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    for (const credential of passkeys) await cdp.send("WebAuthn.addCredential", { authenticatorId: dAuth, credential: credential as never });
    await D.goto(`${ORIGIN}/hq-preview/`); await openNotifications(D);
    const sent = calls.length;
    await ackOne(D, "N-lonely");
    // Without a token the gateway refused it before anything ran (FLEET_CSRF); nothing was applied.
    expect(calls.slice(sent).filter((c) => c.tab === "D").map((c) => [c.xcsrf, c.code])).toEqual([[false, "FLEET_CSRF"]]);
    expect((await ackedRow("N-lonely")).acked).toBe(false);
    // Offered where the owner is looking: in the open dialog (the page behind a modal dialog is inert)...
    const verify = D.getByRole("dialog").getByRole("link", { name: "Verify this tab" });
    expect(await verify.isVisible()).toBe(true);
    expect(await verify.getAttribute("href")).toBe("/hq-preview/login/#reverify");
    // ...and, once the dialog is closed, on the page.
    await D.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    expect(await D.getByRole("alert").getByRole("link", { name: "Verify this tab" }).isVisible()).toBe(true);
    (globalThis as { __tabD?: Page }).__tabD = D;
  });

  it("the server's own checks: missing, wrong or stale token, foreign Origin, unauthenticated and invalid sessions are all refused", async () => {
    const cookie = await cookieHeader();
    expect(await rawCall({ Cookie: cookie, Origin: ORIGIN })).toEqual({ status: 400, code: "FLEET_CSRF" }); // missing
    expect(await rawCall({ Cookie: cookie, Origin: ORIGIN, "X-CSRF": "wrong_" + "y".repeat(40) })).toEqual({ status: 400, code: "FLEET_CSRF" }); // wrong / stale
    expect((await rawCall({ Cookie: cookie, Origin: "https://evil.example", "X-CSRF": "z".repeat(43) })).status).toBe(403); // foreign Origin
    expect((await rawCall({ Origin: ORIGIN })).status).toBe(401); // unauthenticated
    expect((await rawCall({ Cookie: cookie.replace(/=([^;]+)/, "=forged"), Origin: ORIGIN, "X-CSRF": "z".repeat(43) })).status).toBe(401); // invalid session
  });

  it("verifying the lonely tab (passkey + TOTP) returns to /hq-preview/ and its writes then succeed; preview assets and sign-in stay under /hq-preview/", async () => {
    const D = (globalThis as { __tabD?: Page }).__tabD!;
    await D.getByRole("alert").getByRole("link", { name: "Verify this tab" }).click();
    await D.waitForURL(`${ORIGIN}/hq-preview/login/#reverify`);
    await D.getByText("Verify this tab to make changes", { exact: false }).waitFor();
    await D.getByRole("button", { name: "Sign in with passkey" }).click();
    await D.getByRole("button", { name: "Complete sign-in" }).waitFor();
    await D.getByLabel("Authenticator code").fill(await nextCode());
    await D.getByRole("button", { name: "Complete sign-in" }).click();
    await D.waitForURL(`${ORIGIN}/hq-preview/`);
    expect(new URL(D.url()).pathname).toBe("/hq-preview/"); // back in the preview, not the production root
    await openNotifications(D); await ackOne(D, "N-lonely");
    expect((await ackedRow("N-lonely")).acked).toBe(true);
    // Every script the preview loads comes from /hq-preview/; its sign-in/out never leaves the preview.
    const srcs = await D.locator("script[src]").evaluateAll((els) => els.map((e) => (e as HTMLScriptElement).getAttribute("src") ?? ""));
    expect(srcs.length).toBeGreaterThan(0); expect(srcs.every((u) => u.startsWith("/hq-preview/"))).toBe(true);
    expect(await D.getByText(/PREVIEW V2\.4\.3 · UI \d+\.\d+\.\d+/).count()).toBe(1);
  });

  it("UX readiness sweep of the preview: every page and Virtual, desktop and phone — no errors, CSP violations, failing requests, overflow, path escapes, stale naming or unnamed buttons", async () => {
    const P = await ctx.newPage();
    const problems: string[] = [];
    P.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    P.on("console", (m) => { if (m.type() === "error" || /Content Security Policy|Refused to/i.test(m.text())) problems.push(`console ${m.type()}: ${m.text().slice(0, 200)}`); });
    P.on("response", (r) => { const u = new URL(r.url()); if (r.status() >= 400 && !(u.pathname === "/api/call")) problems.push(`HTTP ${r.status()} ${u.pathname}`); });
    P.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/_next/")) problems.push(`asset outside /hq-preview/: ${u.pathname}`); });
    const PAGES = ["Overview", "Fleet Command", "Agents", "Treasury", "Replication", "Missions", "Estates", "Owner identity", "Notifications", "Security", "Settings"];
    const report: Record<string, unknown> = {};
    for (const vp of [{ w: 1440, h: 900 }, { w: 390, h: 844 }]) {
      await P.setViewportSize({ width: vp.w, height: vp.h });
      await P.goto(`${ORIGIN}/hq-preview/`);
      await P.getByText("LIVE · AUTHORITATIVE FLEET DATA", { exact: false }).waitFor();
      for (const name of PAGES) {
        await P.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: new RegExp(`^\\d+${name.replace(" ", "\\s")}`) }).click();
        await P.waitForTimeout(700);
        const r = await P.evaluate(() => ({
          overflowPx: document.documentElement.scrollWidth - window.innerWidth,
          founder: /\bfounder-\d+/i.test(document.body.innerText),
          unnamed: [...document.querySelectorAll("button, a[href], [role=button]")].filter((e) => (e as HTMLElement).offsetParent !== null
            && !((e.getAttribute("aria-label") ?? "") + (e.textContent ?? "") + (e.getAttribute("title") ?? "")).trim()).length,
        }));
        if (r.overflowPx > 1) problems.push(`${vp.w}px ${name}: horizontal overflow ${r.overflowPx}px`);
        if (r.founder) problems.push(`${vp.w}px ${name}: "founder-N" shown`);
        if (r.unnamed) problems.push(`${vp.w}px ${name}: ${r.unnamed} control(s) without an accessible name`);
        report[`${vp.w}:${name}`] = r;
      }
      // Keyboard: Tab moves focus through the deck's controls, and the focused one is visibly outlined.
      await P.keyboard.press("Tab"); await P.keyboard.press("Tab");
      const focus = await P.evaluate(() => { const e = document.activeElement as HTMLElement | null; const cs = e ? getComputedStyle(e) : null; return { tag: e?.tagName ?? "", ring: cs ? (cs.outlineStyle !== "none" && cs.outlineWidth !== "0px") || cs.boxShadow !== "none" : false }; });
      if (!["BUTTON", "A", "INPUT", "SELECT"].includes(focus.tag)) problems.push(`${vp.w}px keyboard focus lands on ${focus.tag}`);
      if (!focus.ring) problems.push(`${vp.w}px keyboard focus not visible`);
    }
    // Virtual (3D) on the preview: plaques, title on entry, no errors.
    await P.setViewportSize({ width: 1440, height: 900 });
    await P.evaluate(() => localStorage.setItem("fleet.virtual.prefs.v1", JSON.stringify({ renderer: "3d", quality: "low", fps: 30, reduceMotion: false, ambient: true, dataFlow: true })));
    await P.goto(`${ORIGIN}/hq-preview/#Virtual`); await P.reload();
    await P.locator('[aria-label="Rooms"] [data-room]').first().waitFor({ timeout: 30_000 });
    expect(await P.locator('[aria-label="Rooms"] [data-room]').count()).toBe(11);
    await P.locator('[data-room="treasury"]').click(); await P.waitForTimeout(1500);
    expect(await P.getByRole("heading", { name: /^Treasury: / }).isVisible()).toBe(true);
    console.log(`ux sweep: ${JSON.stringify(problems)}`);
    expect(problems).toEqual([]);
    await P.close();
  });

  // ── V2.4.2: owner access that does not depend on one browser's passkey, and notification housekeeping ──
  const PASSWORD = "e2e owner password 2026-10-07";
  let ctx2: BrowserContext;
  let F: Page;
  const errorsOf = (page: Page) => {
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    // (The browser's generic "Failed to load resource" line carries no URL; HTTP statuses are checked per path below.)
    page.on("console", (m) => { if ((m.type() === "error" && !/^Failed to load resource/.test(m.text())) || /Content Security Policy|Refused to/i.test(m.text())) problems.push(`console ${m.type()}: ${m.text().slice(0, 200)}`); });
    page.on("response", (r) => { const u = new URL(r.url()); if (r.status() >= 400 && !["/api/call", "/api/auth/login/password"].includes(u.pathname)) problems.push(`HTTP ${r.status()} ${u.pathname}`); });
    return problems;
  };

  /**
   * The suite signs in many times from 127.0.0.1, which the per-address sign-in limit (30 / 10 min, in the server's memory)
   * eventually refuses — as it should. A fresh server image on the same origin resets it; sessions live in the database.
   */
  const restartServer = async () => {
    const port = Number(new URL(ORIGIN).port);
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    server = createDashboardServer(dgw, { origin: ORIGIN, rpId: "localhost", stateKey, staticDir: path.join(tmp, "root") });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  };

  it("V2.4.2 sign-in: both routes offered; the owner sets a password from Security (passkey confirmation); a SEPARATE browser with NO passkey signs in with password + code", async () => {
    await restartServer();
    const A = (globalThis as { __tabD?: Page }).__tabD!; // the owner's open tab (it holds the owner's passkey; earlier tests closed the others)
    const problemsA = errorsOf(A);
    await signIn(A, "/hq-preview/login/#reverify"); // a fresh passkey + TOTP session in this tab, whatever earlier tests left
    await A.waitForURL(`${ORIGIN}/hq-preview/`);
    await A.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /^\d+Security/ }).click();
    await A.getByRole("heading", { name: "Sign-in methods" }).waitFor();
    expect(await A.getByText("Not set", { exact: false }).first().isVisible()).toBe(true);
    await A.getByRole("button", { name: "Set password" }).click();
    await A.getByLabel("New password (at least 12 characters)").fill(PASSWORD);
    await A.getByLabel("Repeat the password").fill(PASSWORD);
    await A.getByRole("button", { name: "Confirm and save" }).click();
    await A.getByRole("dialog", { name: "Confirm it is you" }).getByRole("button", { name: "Use my passkey" }).click();
    await A.getByText("Password saved.", { exact: false }).waitFor({ timeout: 30_000 });
    expect(Number((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_admin_password`))[0].n)).toBe(1);
    expect(problemsA).toEqual([]);
    // A different browser: no virtual authenticator at all (as Firefox without the owner's Edge passkey).
    ctx2 = await browser.newContext();
    F = await ctx2.newPage();
    const problemsF = errorsOf(F);
    await F.goto(`${ORIGIN}/hq-preview/login/`);
    await F.getByRole("form", { name: "Sign in with password" }).waitFor();
    expect(await F.getByRole("button", { name: "Sign in with passkey" }).isVisible()).toBe(true);
    await F.getByLabel("Password", { exact: true }).fill("not the password at all");
    await F.getByLabel("Authenticator code").fill(await nextCode());
    await F.getByRole("button", { name: "Sign in", exact: true }).click();
    await F.getByText("Sign-in details were not accepted", { exact: false }).waitFor(); // one generic message
    await F.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await F.getByLabel("Authenticator code").fill(await nextCode());
    await F.getByRole("button", { name: "Sign in", exact: true }).click();
    await F.waitForURL(`${ORIGIN}/hq-preview/`);
    await F.getByText("LIVE · AUTHORITATIVE FLEET DATA", { exact: false }).waitFor();
    // A sensitive action from the password browser: confirmed with password + code (no passkey exists here).
    await F.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /^\d+Security/ }).click();
    await F.getByText("this session signed in with it", { exact: false }).waitFor();
    expect(problemsF).toEqual([]);
  });

  it("V2.4.2 notifications: the daily report opens as a readable report; delete one, a selection (acknowledge and delete), all acknowledged; persisted; tombstones attributed", async () => {
    const problems = errorsOf(F);
    await R.q(`SELECT fleet.fleet_notify('DAILY', 'DAILY_REPORT', NULL, 'Fleet daily report e2e', fleet.fleet_daily_report(), 'daily:e2e')`);
    for (const t of ["N-del-1", "N-del-2", "N-del-3"]) await notify(t);
    for (const t of ["N-del-1", "N-del-2"]) await R.q(`SELECT fleet.fleet_admin_notification_ack(notification_id, $2) FROM fleet.fleet_notifications WHERE title = $1`, [t, OWNER]);
    await F.reload(); await openNotifications(F);
    // The report: a readable view, the stored payload only behind "View technical data".
    await F.getByRole("button", { name: "Fleet daily report e2e — open the report" }).click();
    const dlg = F.getByRole("dialog", { name: "Notification detail" });
    await dlg.getByRole("heading", { name: /^Fleet daily report · \d{4}-\d{2}-\d{2}$/ }).waitFor();
    for (const t of ["External revenue", "Treasury cash", "Living agents", "Agent-1"]) expect(await dlg.getByText(t, { exact: false }).first().isVisible()).toBe(true);
    const visible = await dlg.evaluate((d) => { const c = d.cloneNode(true) as HTMLElement; c.querySelectorAll("details").forEach((x) => x.remove()); return c.textContent ?? ""; }); // all but the collapsed technical data
    expect(visible).not.toMatch(/revenueMinor|generatedAt|\{"/);
    await dlg.getByRole("button", { name: "Acknowledge" }).click();
    await F.waitForTimeout(1500);
    expect((await ackedRow("Fleet daily report e2e")).acked).toBe(true);
    // Delete one acknowledged notification (low risk: no second confirmation).
    await F.locator("div.rounded-lg").filter({ hasText: "Fleet daily report e2e" }).first().getByRole("button", { name: "Delete" }).click();
    await F.waitForTimeout(1500);
    const tomb = (await R.q(`SELECT deleted_at, deleted_by, title, detail FROM fleet.fleet_notifications WHERE dedupe_key = 'daily:e2e'`))[0];
    expect(tomb).toMatchObject({ deleted_by: OWNER, title: "Deleted notification", detail: {} });
    // A selection with one unread: an explicit "Acknowledge and delete".
    await F.getByRole("button", { name: "Select" }).click();
    await F.getByLabel("Select N-del-1").check(); await F.getByLabel("Select N-del-3").check();
    await F.getByRole("button", { name: "Delete selected (2)" }).click();
    const conf = F.getByRole("dialog", { name: "Confirm deletion" });
    await conf.getByRole("heading", { name: "Acknowledge and delete 2 notifications?" }).waitFor();
    await conf.getByRole("button", { name: "Acknowledge and delete" }).click();
    await F.waitForTimeout(1500);
    for (const t of ["N-del-1", "N-del-3"]) expect(Number((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_notifications WHERE title = $1`, [t]))[0].n)).toBe(0); // scrubbed
    // Delete all acknowledged (FleetController's count, confirmed).
    const n = Number((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_notifications WHERE acknowledged_at IS NOT NULL AND deleted_at IS NULL`))[0].n);
    expect(n).toBeGreaterThan(0);
    await F.getByRole("button", { name: `Delete all acknowledged (${n})` }).click();
    await F.getByRole("dialog", { name: "Confirm deletion" }).getByRole("heading", { name: `Delete ${n} acknowledged notification${n === 1 ? "" : "s"} from your inbox?` }).waitFor();
    await F.getByRole("dialog", { name: "Confirm deletion" }).getByRole("button", { name: "Delete", exact: true }).click();
    await F.waitForTimeout(1500);
    expect(Number((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_notifications WHERE acknowledged_at IS NOT NULL AND deleted_at IS NULL`))[0].n)).toBe(0);
    await F.reload(); await openNotifications(F);
    expect(await F.getByText("N-del-2").count()).toBe(0);
    expect(await sidebarCount(F)).toBe(await unacked());
    expect(Number((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_notifications WHERE deleted_at IS NOT NULL AND deleted_by <> $1`, [OWNER]))[0].n)).toBe(0);
    expect(problems).toEqual([]);
    await ctx2.close();
  });
});
