/**
 * Mobile access to the owner dashboard (LIVE export, real gateway, PostgreSQL, Chrome with phone emulation).
 *
 * A signed-in owner on a phone-sized screen. Every request is timed and replayed through the production edge's limit
 * (nginx limit_req: 10 r/s, burst 40 per address, deploy/nginx/automaton-fleet-edge.conf).
 *
 * The defect this pins (2026-10-16): returning to the page fired blur / visibilitychange / focus together and each started
 * a full refresh — one app switch sent ~48 reads at once; the edge refused the excess (503) and one refused read failed the
 * whole refresh ("The Fleet is unreachable"). The edge's own log held 903 such refusals in 12 days. Fixed in UI 0.21.1:
 * one refresh in flight, none on hiding, focus refresh at most every 15 s, reads paced and retried when the edge is busy.
 *
 * This is emulation (Chrome's device mode, iPhone 13 profile), not a real phone or WebKit.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import path from "path";
import { chromium, devices, type Browser, type Page, type BrowserContext } from "playwright-core";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { ensureLiveUi } from "./fixtures/live-ui.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { totp } from "../../fleet/identity/crypto.js";
import { PgDashboardGateway } from "../../fleet/dashboard/gateway.js";
import { createDashboardServer } from "../../fleet/dashboard/server.js";

const PG_BIN = findPgBin();
const CHROME = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => fs.existsSync(p)) ?? null;
const CODEX = path.resolve(__dirname, "../../../codex-dashboard");
const UI = path.join(CODEX, "out");
const OUT = process.env.FLEET_MOBILE_DIAG_DIR ?? null;

describe.skipIf(!PG_BIN || !CHROME || !fs.existsSync(path.join(CODEX, "node_modules")))("owner dashboard on a phone (LIVE export, emulated)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let dgw: PgDashboardGateway;
  let server: http.Server;
  let browser: Browser;
  let ctx: BrowserContext;
  let page: Page;
  let ORIGIN = "";
  let secret = "";
  const PASSWORD = "a long owner password for the phone test";
  const log: Array<{ t: number; status: number | string; type: string; url: string }> = [];
  const errors: string[] = [];

  beforeAll(async () => {
    ensureLiveUi();
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000, treasuryCents: 1_000_000 });
    dgw = new PgDashboardGateway({ connectionString: R.pgc.dashboardUrl });
    server = createDashboardServer(dgw, { origin: "http://localhost:0", rpId: "localhost", stateKey: crypto.randomBytes(32) });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    server.close();
    ORIGIN = `http://localhost:${port}`;
    server = createDashboardServer(dgw, { origin: ORIGIN, rpId: "localhost", stateKey: crypto.randomBytes(32), staticDir: UI });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
    browser = await chromium.launch({ executablePath: CHROME!, headless: true, args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
    ctx = await browser.newContext({ ...devices["iPhone 13"] });
    page = await ctx.newPage();
    const t0 = Date.now();
    page.on("response", (r) => log.push({ t: Date.now() - t0, status: r.status(), type: r.request().resourceType(), url: r.url().replace(ORIGIN, "") }));
    page.on("requestfailed", (r) => log.push({ t: Date.now() - t0, status: "FAIL", type: r.resourceType(), url: r.url().replace(ORIGIN, "") }));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
    page.on("pageerror", (e) => errors.push("pageerror: " + String(e).slice(0, 300)));
    // The owner set up as on production: password + authenticator (a phone has no desktop passkey).
    const token = crypto.randomBytes(32).toString("base64url");
    await R.q(`SELECT fleet.fleet_admin_dashboard_enroll($1, $2)`, [crypto.createHash("sha256").update(token).digest("hex"), OWNER]);
    await page.goto(`${ORIGIN}/login/#enroll=${token}`);
  }, 300_000);
  afterAll(async () => { await browser?.close(); server?.close(); await dgw?.close(); await R?.close(); });

  const windowMax = (rows: typeof log, ms: number) => {
    let best = 0;
    for (const a of rows) best = Math.max(best, rows.filter((b) => b.t >= a.t && b.t < a.t + ms).length);
    return best;
  };

  it("diagnostic: sign in on a phone and load the deck", async () => {
    // Set the password through the enrollment page's own form.
    await page.getByLabel("New password").fill(PASSWORD);
    await page.getByLabel("Repeat the password").fill(PASSWORD);
    await page.getByRole("button", { name: "Set password" }).click();
    await page.getByRole("button", { name: "Confirm authenticator" }).waitFor();
    secret = (await page.locator("p.font-mono").first().textContent())!.trim();
    await page.getByLabel("Code from the authenticator").fill(totp(secret));
    await page.getByRole("button", { name: "Confirm authenticator" }).click();
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByLabel("Authenticator code").first().fill(totp(secret, Date.now() + 30_000));
    const before = log.length;
    const tSign = Date.now();
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(`${ORIGIN}/`, { timeout: 30_000 });
    await page.waitForTimeout(12_000);
    const after = log.slice(before);
    const first = after[0]?.t ?? 0;
    const rows = after.map((r) => ({ ...r, t: r.t - first }));
    const report = {
      signInToDeckMs: Date.now() - tSign - 12_000,
      requests12s: rows.length,
      api: rows.filter((r) => r.url.startsWith("/api/")).length,
      maxIn1s: windowMax(rows, 1000), maxIn4s: windowMax(rows, 4000),
      byStatus: rows.reduce<Record<string, number>>((a, r) => (a[String(r.status)] = (a[String(r.status)] ?? 0) + 1, a), {}),
      overflowX: await page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth),
      viewport: page.viewportSize(),
      errors,
      mainText: (await page.locator("main").textContent().catch(() => ""))?.slice(0, 300),
    };
    console.log("MOBILE-DIAG " + JSON.stringify(report, null, 1));
    if (OUT) {
      fs.writeFileSync(path.join(OUT, "mobile-requests.json"), JSON.stringify(rows, null, 1));
      await page.screenshot({ path: path.join(OUT, "mobile-deck.png"), fullPage: false });
    }
    expect(report.errors).toEqual([]);
    expect(report.byStatus).toEqual({ "200": rows.length });
    expect(report.overflowX).toBeLessThanOrEqual(0);
    expect(edgeRejects(rows)).toBe(0);
  });

  /** nginx limit_req (rate r/s, burst b, nodelay): which of these requests the production edge would refuse. */
  const edgeRejects = (rows: typeof log, rate = 10, burst = 40) => {
    let excess = 0, last = rows[0]?.t ?? 0, rejected = 0;
    for (const r of rows) {
      excess = Math.max(0, excess - ((r.t - last) * rate) / 1000); last = r.t;
      if (excess + 1 > burst + 1) rejected++; else excess += 1;
    }
    return rejected;
  };
  const appSwitch = async () => {
    // What a phone does when the owner switches to another app (e.g. the authenticator) and back.
    await page.evaluate(() => {
      const set = (v: string) => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
      set("hidden"); document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("blur"));
      set("visible"); document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus"));
    });
  };

  it("diagnostic: switching to another app and back", async () => {
    await page.waitForTimeout(5_000); // the edge's bucket drains
    const before = log.length;
    await appSwitch();
    await page.waitForTimeout(6_000);
    const rows = log.slice(before);
    const first = rows[0]?.t ?? 0;
    const r = rows.map((x) => ({ ...x, t: x.t - first }));
    const twice = [...r, ...r.map((x) => ({ ...x, t: x.t + 1500 }))].sort((a, b) => a.t - b.t);
    console.log("MOBILE-SWITCH " + JSON.stringify({ requests: r.length, api: r.filter((x) => x.url.startsWith("/api/")).length, maxIn1s: windowMax(r, 1000),
      edgeRejectsOneSwitch: edgeRejects(r), edgeRejectsTwoSwitches1500ms: edgeRejects(twice) }));
    expect(r.length).toBeLessThanOrEqual(20); // one refresh, not one per event (was ~48)
    expect(edgeRejects(r)).toBe(0);
    expect(edgeRejects(twice)).toBe(0);
    // A second switch at once does not refresh again (at most once per 15 s).
    const n = log.length;
    await appSwitch();
    await page.waitForTimeout(2_000);
    expect(log.length - n).toBe(0);
  });

  it("every administration page opens on a phone: no sideways overflow, no script error, the controls reachable", async () => {
    const pages = ["Overview", "Fleet Command", "Agents", "Treasury", "Money & identity", "Launch & channels", "Mail", "Notifications", "Security", "Settings"];
    const seen: Record<string, number> = {};
    for (const name of pages) {
      const nav = page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: new RegExp(`^\\d+${name.replace(/[&]/g, "\\$&")}`) });
      await nav.scrollIntoViewIfNeeded();
      await nav.click();
      await page.waitForTimeout(1_500);
      seen[name] = await page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth);
      if (OUT) await page.screenshot({ path: path.join(OUT, `mobile-${name.replace(/\W+/g, "-")}.png`) });
    }
    console.log("MOBILE-PAGES " + JSON.stringify(seen));
    expect(errors).toEqual([]);
    for (const [name, over] of Object.entries(seen)) expect(over, name).toBeLessThanOrEqual(0);
  });
});
