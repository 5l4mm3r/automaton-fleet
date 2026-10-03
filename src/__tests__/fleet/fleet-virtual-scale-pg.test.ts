/**
 * The Virtual Command Centre at Fleet scale — the LIVE export on the real dashboard gateway with real Fleets of 1, 10,
 * 25 and 50 activated agents (the constitutional maximum), in Chrome (WebGL through SwiftShader), signed in with a
 * virtual passkey + TOTP. For each size, in the 3D scene and in the 2D map: every agent is rendered and reachable, the
 * frame loop keeps running, switching renderers repeatedly leaves exactly one canvas (resources released), and the
 * JS heap does not grow over a sustained run. Phone and tablet viewports get the map / a simplified scene, and the
 * Formal dashboard never loads the Virtual chunks.
 *
 * A dedicated performance run: frame cadence and heap growth only mean something on an otherwise idle machine, and the
 * 50-agent Chrome session would starve the rest of the parallel suite. Run it on its own:
 *   FLEET_SCALE_TESTS=1 npx vitest run src/__tests__/fleet/fleet-virtual-scale-pg.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import path from "path";
import { execFileSync } from "child_process";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { totp } from "../../fleet/identity/crypto.js";
import { PgDashboardGateway } from "../../fleet/dashboard/gateway.js";
import { createDashboardServer } from "../../fleet/dashboard/server.js";

const PG_BIN = findPgBin();
const CHROME = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => fs.existsSync(p)) ?? null;
const CODEX = path.resolve(__dirname, "../../../codex-dashboard");
const UI = path.join(CODEX, "out");
const PREFS = "fleet.virtual.prefs.v1";

function ensureLiveUi() {
  const html = path.join(UI, "index.html");
  if (!fs.existsSync(path.join(UI, "login", "index.html")) || !fs.readFileSync(html, "utf8").includes("LIVE · AUTHORITATIVE")) {
    execFileSync(process.execPath, ["scripts/build.mjs", "live"], { cwd: CODEX, stdio: "ignore", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
  }
}

/** A real Fleet of n agents behind the real dashboard service, and a signed-in browser context. */
async function fleetOf(n: number, browser: Browser) {
  const R = await startEconomyRegistry(PG_BIN!, { founders: n, allocationCents: 10_000, treasuryCents: Math.max(1_000_000, n * 20_000) });
  await R.q(`UPDATE fleet.fleet_genesis_policy SET bootstrap_capital_currency = 'GBP', bootstrap_capital_minor = 10000`);
  const dgw = new PgDashboardGateway({ connectionString: R.pgc.dashboardUrl });
  let server = createDashboardServer(dgw, { origin: "http://localhost:0", rpId: "localhost", stateKey: crypto.randomBytes(32) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  server.close();
  const origin = `http://localhost:${port}`;
  server = createDashboardServer(dgw, { origin, rpId: "localhost", stateKey: crypto.randomBytes(32), staticDir: UI });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text()); });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const token = crypto.randomBytes(32).toString("base64url");
  await R.q(`SELECT fleet.fleet_admin_dashboard_enroll($1, $2)`, [crypto.createHash("sha256").update(token).digest("hex"), OWNER]);
  await page.goto(`${origin}/login/#enroll=${token}`);
  await page.getByRole("button", { name: "Register passkey" }).click();
  await page.getByRole("button", { name: "Confirm authenticator" }).waitFor();
  const secret = (await page.locator("p.font-mono").first().textContent())!.trim();
  await page.getByLabel("Code from the authenticator").fill(totp(secret));
  await page.getByRole("button", { name: "Confirm authenticator" }).click();
  await page.getByRole("button", { name: "Sign in with passkey" }).click();
  await page.getByLabel("Authenticator code").fill(totp(secret, Date.now() + 30_000));
  await page.getByRole("button", { name: "Complete sign-in" }).click();
  await page.waitForURL(`${origin}/`);
  return { R, dgw, server, ctx, page, origin, errors, close: async () => { await ctx.close(); server.close(); await dgw.close(); await R.close(); } };
}

/** requestAnimationFrame callbacks per second over `ms` (the browser's real frame cadence with the scene running). */
const rafRate = (page: Page, ms = 3000) => page.evaluate((d) => new Promise<number>((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < d) requestAnimationFrame(f); else res((n * 1000) / d); }; requestAnimationFrame(f); }), ms);
const heapMb = (page: Page) => page.evaluate(() => ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1_048_576);
const setPrefs = (page: Page, p: object) => page.evaluate(([k, v]) => localStorage.setItem(k, v), [PREFS, JSON.stringify({ quality: "medium", fps: 60, reduceMotion: false, ambient: true, dataFlow: true, renderer: "map", ...p })]);

describe.skipIf(!process.env.FLEET_SCALE_TESTS || !PG_BIN || !CHROME || !fs.existsSync(path.join(CODEX, "node_modules")))("Virtual Command Centre at Fleet scale (LIVE export, real Fleets of 1 / 10 / 25 / 50 agents)", { timeout: 600_000 }, () => {
  let browser: Browser;
  const report: Record<string, unknown> = {};
  beforeAll(async () => {
    ensureLiveUi();
    browser = await chromium.launch({ executablePath: CHROME!, headless: true, args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--enable-precise-memory-info", "--js-flags=--expose-gc"] });
  }, 600_000);
  afterAll(async () => { await browser?.close(); console.log(`virtual scale: ${JSON.stringify(report)}`); });

  for (const n of [1, 10, 25, 50]) {
    it(`${n} agent(s): all rendered and reachable in 3D and map; frames keep coming; renderer switches release resources; no heap growth`, async () => {
      const F = await fleetOf(n, browser);
      try {
        const { page } = F;
        const r: Record<string, number> = {};
        for (const renderer of ["3d", "map"] as const) {
          await setPrefs(page, { renderer, quality: renderer === "3d" ? "low" : "medium" });
          await page.goto(`${F.origin}/#Virtual`);
          await page.reload(); // a fresh Virtual view: the new display preferences, the Fleet view
          // Every real agent is in the scene: the map draws one agent element per agent; the 3D scene publishes the label
          // layer (all labels while ≤ 16 agents; with more, the Fleet view keeps only the selected one, so we count them
          // through the side panel's list, which names every agent with its health and room).
          if (renderer === "3d") await page.locator("canvas").first().waitFor();
          const panel = page.getByRole("complementary", { name: "Selection details" });
          await panel.getByText("The Fleet, as it is").waitFor({ timeout: 15_000 }).catch(async (e) => {
            await page.screenshot({ path: `/tmp/claude-1000/-home-sl4mm3r-projects-automaton-fleet/7961b396-7e10-40e9-a7cf-75c2e132e244/scratchpad/scale-fail-${renderer}.png` });
            console.log("PAGE TEXT:", (await page.locator("main").textContent())?.slice(0, 600), "ERRORS:", F.errors.join(" | ").slice(0, 600));
            throw e;
          });
          await page.waitForFunction((k) => [...document.querySelectorAll('aside[aria-label="Selection details"] li button')].filter((b) => b.textContent?.startsWith("founder-")).length === k, n, { timeout: 60_000 });
          if (renderer === "map") expect(await page.locator('svg[aria-label="Fleet headquarters map"] g[role=button][aria-label^="founder-"]').count()).toBe(n);
          // In the zoomed-out Fleet view every agent is identifiable by name and wallet (compact above 16 agents).
          const labelState = () => page.evaluate(() => {
            const layer = document.querySelector('[aria-label="Agents"]') as HTMLElement;
            const shown = [...layer.querySelectorAll("button")].filter((b) => (b as HTMLElement).style.visibility !== "hidden" && (b as HTMLElement).style.transform);
            const rects = shown.map((b) => b.getBoundingClientRect());
            let overlapping = 0;
            rects.forEach((a, i) => { if (rects.some((c, j) => j !== i && a.left < c.right && a.right > c.left && a.top < c.bottom && a.bottom > c.top)) overlapping++; });
            return { density: layer.dataset.density, shown: shown.length, withNameAndWallet: shown.filter((b) => /founder-\d+/.test(b.textContent ?? "") && /£\d/.test(b.textContent ?? "")).length, overlapping };
          });
          await page.waitForFunction((k) => [...document.querySelectorAll('[aria-label="Agents"] button')].filter((b) => (b as HTMLElement).style.visibility !== "hidden" && (b as HTMLElement).style.transform).length === k, n, { timeout: 60_000 });
          await page.waitForTimeout(1500); // births settle, the layout converges
          const ls = await labelState();
          expect(ls.density).toBe(n > 16 ? "compact" : "full");
          expect(ls.shown).toBe(n);
          expect(ls.withNameAndWallet).toBe(n);
          r[`${renderer}LabelOverlapPct`] = Math.round((ls.overlapping / n) * 100);
          expect(ls.overlapping / n, "share of labels overlapping another").toBeLessThanOrEqual(0.15);
          // Focus one agent: its label and panel appear whatever the Fleet size.
          await panel.getByRole("button").filter({ hasText: /^founder-/ }).first().click();
          await panel.getByText("WHY THIS CONDITION", { exact: false }).waitFor();
          // While the camera eases to the agent, then once settled (the steady state a watching Admin sees).
          r[`${renderer}FpsMoving`] = Math.round(await rafRate(page, 1200));
          await page.waitForTimeout(1500);
          r[`${renderer}Fps`] = Math.round(await rafRate(page));
          expect(r[`${renderer}Fps`], `${renderer} frame cadence`).toBeGreaterThan(20);
          expect(r[`${renderer}FpsMoving`], `${renderer} cadence while moving`).toBeGreaterThan(5);
        }
        // Switching renderers repeatedly leaves at most one canvas (the scene and its WebGL resources are released).
        const settings = page.getByRole("button", { name: "Display" });
        await settings.click();
        for (let i = 0; i < 4; i++) {
          await page.getByLabel("View").selectOption("3d"); await page.locator("canvas").first().waitFor();
          await page.getByLabel("View").selectOption("map"); await page.locator('svg[aria-label="Fleet headquarters map"]').waitFor();
        }
        expect(await page.locator("canvas").count()).toBe(0);
        await page.getByLabel("View").selectOption("3d"); await page.locator("canvas").first().waitFor();
        expect(await page.locator("canvas").count()).toBe(1);
        // A sustained run (the live pulse every 5 s, the frame loop, the label layer) does not grow the heap.
        await page.evaluate(() => (globalThis as { gc?: () => void }).gc?.());
        const h0 = await heapMb(page);
        await page.waitForTimeout(25_000);
        await page.evaluate(() => (globalThis as { gc?: () => void }).gc?.());
        r.heapGrowthMb = Math.round(((await heapMb(page)) - h0) * 10) / 10;
        expect(r.heapGrowthMb, "heap growth over 25 s").toBeLessThan(15);
        expect(F.errors, F.errors.join("\n")).toEqual([]);
        report[`${n} agents`] = r;
      } finally {
        await F.close();
      }
    });
  }

  it("phones get the map and the Formal dashboard by default; tablets a simplified scene; Formal never loads the Virtual chunks", async () => {
    const F = await fleetOf(2, browser);
    try {
      const phone = await F.ctx.newPage();
      await phone.setViewportSize({ width: 390, height: 844 });
      const loaded: string[] = [];
      phone.on("response", (res) => { if (/\.js$/.test(res.url())) loaded.push(res.url()); });
      await phone.goto(`${F.origin}/#Agents`);
      await phone.getByText("Agent registry").waitFor();
      await phone.waitForTimeout(1500);
      const formalScripts = loaded.length;
      expect(formalScripts).toBeGreaterThan(0);
      // Formal pages work at phone width; no Virtual chunk (three.js) was fetched.
      const formalBodies = await Promise.all(loaded.map((u) => fetch(u).then((r) => r.text())));
      expect(formalBodies.some((b) => b.includes("WebGLRenderer"))).toBe(false);
      await phone.goto(`${F.origin}/#Virtual`);
      await phone.locator('svg[aria-label="Fleet headquarters map"]').waitFor(); // the map, not WebGL
      expect(await phone.locator("canvas").count()).toBe(0);
      await phone.close();
      const tablet = await F.ctx.newPage();
      await tablet.setViewportSize({ width: 900, height: 1200 });
      await tablet.goto(`${F.origin}/#Virtual`);
      await tablet.getByRole("button", { name: "Display" }).click();
      expect(await tablet.getByLabel("Virtual quality").inputValue()).toBe("medium");
      await tablet.close();
    } finally {
      await F.close();
    }
  });
});
