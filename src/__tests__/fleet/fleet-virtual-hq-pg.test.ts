/**
 * Virtual HQ v2 — the 3D headquarters on the LIVE export, against a real Fleet behind the real dashboard gateway, in
 * Chrome (WebGL through SwiftShader), signed in with a virtual passkey + TOTP.
 *
 * Checks: the scene renders at every quality level without errors; the hierarchical camera (Fleet → Department → Agent)
 * steps back one level per Escape; the agent panel is the existing live panel; a real FleetController event still moves
 * an agent (state stays authoritative in 3D). It also records the frame cadence per quality level and, when
 * FLEET_HQ_SHOTS names a directory, writes the review screenshots there.
 *
 * A dedicated visual/performance run (software WebGL is slow and starves a parallel suite). Run it on its own:
 *   FLEET_HQ_TESTS=1 [FLEET_HQ_SHOTS=/some/dir] [FLEET_HQ_GPU=1] npx vitest run src/__tests__/fleet/fleet-virtual-hq-pg.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { chromium, type Browser, type Page } from "playwright-core";
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
const SHOTS = process.env.FLEET_HQ_SHOTS ?? "";

function ensureLiveUi() {
  const html = path.join(UI, "index.html");
  if (!fs.existsSync(path.join(UI, "login", "index.html")) || !fs.readFileSync(html, "utf8").includes("LIVE · AUTHORITATIVE")) {
    execFileSync(process.execPath, ["scripts/build.mjs", "live"], { cwd: CODEX, stdio: "ignore", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
  }
}

const rafRate = (page: Page, ms = 4000) => page.evaluate((d) => new Promise<number>((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < d) requestAnimationFrame(f); else res((n * 1000) / d); }; requestAnimationFrame(f); }), ms);

describe.skipIf(!process.env.FLEET_HQ_TESTS || !PG_BIN || !CHROME || !fs.existsSync(path.join(CODEX, "node_modules")))("Virtual HQ v2 (LIVE export, real Fleet)", { timeout: 900_000 }, () => {
  let browser: Browser, R: EconomyRegistry, dgw: PgDashboardGateway, server: ReturnType<typeof createDashboardServer>, page: Page, origin: string;
  const errors: string[] = [];
  const report: Record<string, unknown> = {};

  beforeAll(async () => {
    ensureLiveUi();
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
    // FLEET_HQ_GPU=1 measures on the machine's GPU (ANGLE over OpenGL) instead of software WebGL.
    const gl = process.env.FLEET_HQ_GPU ? ["--use-angle=gl", "--enable-gpu", "--ignore-gpu-blocklist"] : ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"];
    browser = await chromium.launch({ executablePath: CHROME!, headless: true, args: ["--no-sandbox", ...gl] });
    R = await startEconomyRegistry(PG_BIN!, { founders: 6, allocationCents: 10_000, treasuryCents: 1_000_000 });
    await R.q(`UPDATE fleet.fleet_genesis_policy SET bootstrap_capital_currency = 'GBP', bootstrap_capital_minor = 10000`);
    dgw = new PgDashboardGateway({ connectionString: R.pgc.dashboardUrl });
    let s = createDashboardServer(dgw, { origin: "http://localhost:0", rpId: "localhost", stateKey: crypto.randomBytes(32) });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    const port = (s.address() as { port: number }).port;
    s.close();
    origin = `http://localhost:${port}`;
    server = s = createDashboardServer(dgw, { origin, rpId: "localhost", stateKey: crypto.randomBytes(32), staticDir: UI });
    await new Promise<void>((r) => s.listen(port, "127.0.0.1", () => r()));
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error" || /Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text()); });
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
    // Real recorded activity, so agents are spread through the building by FleetController's own state.
    const ids = R.founders.map((f) => f.id);
    await R.q(`SELECT fleet.fleet_event('knowledge_recorded', $1, 'agent', '{"topic":"hq"}'::jsonb)`, [ids[1]]);
    await R.q(`SELECT fleet.fleet_event('knowledge_recorded', $1, 'agent', '{"topic":"hq"}'::jsonb)`, [ids[2]]);
  }, 900_000);

  afterAll(async () => {
    await browser?.close(); server?.close(); await dgw?.close(); await R?.close();
    console.log(`virtual hq: ${JSON.stringify(report)}`);
  });

  const open = async (quality: string) => {
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [PREFS, JSON.stringify({ renderer: "3d", quality, fps: 60, reduceMotion: false, ambient: true, dataFlow: true })]);
    await page.goto(`${origin}/#Virtual`);
    await page.reload();
    await page.locator("canvas").first().waitFor();
    await page.getByLabel("Agents", { exact: true }).getByRole("button", { name: /^founder-1,/ }).waitFor({ timeout: 30_000 });
    await page.waitForTimeout(4000); // births settle, the camera arrives
  };
  const shot = async (name: string) => { if (SHOTS) await page.locator("canvas").first().screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
  const hint = () => page.getByText(/· Esc steps back a level$/).textContent();

  it("hierarchical camera: Fleet → Department → Agent, the existing live agent panel, Escape steps back one level", async () => {
    await open("high");
    expect(await hint()).toMatch(/^Fleet view/);
    await shot("1-fleet-view");
    const panel = page.getByRole("complementary", { name: "Selection details" });
    for (const [dep, file] of [["Agent Floor", "2-agent-floor"], ["Fleet Command", "3-fleet-command"], ["Treasury", "4-treasury"]] as const) {
      await panel.getByRole("button", { name: dep, exact: true }).first().click();
      await page.waitForTimeout(4500);
      expect(await hint()).toMatch(new RegExp(`^${dep}`));
      await shot(file);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => /^Fleet view/.test(document.body.innerText.match(/[^\n]*Esc steps back a level/)?.[0] ?? ""));
    }
    // Agent View: the label opens the existing live panel (condition explained from real figures).
    await page.getByLabel("Agents", { exact: true }).getByRole("button", { name: /^founder-1,/ }).click();
    await panel.getByText("WHY THIS CONDITION", { exact: false }).waitFor();
    await page.waitForTimeout(4500);
    expect(await hint()).toMatch(/^founder-1/);
    await shot("5-founder-1-selected");
    // Escape: agent → its department → Fleet.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    expect(await hint()).not.toMatch(/^founder-1|^Fleet view/);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    expect(await hint()).toMatch(/^Fleet view/);
    expect(await page.getByText("The 3D view stopped").count()).toBe(0);
  });

  it("a real FleetController event still moves the agent in 3D (state stays authoritative)", async () => {
    const labels = page.getByLabel("Agents", { exact: true });
    const A = R.founders[0].id;
    await R.q(`SELECT fleet.fleet_event('knowledge_recorded', $1, 'agent', '{"topic":"hq-live"}'::jsonb)`, [A]);
    await labels.getByRole("button", { name: /^founder-1, .*, RESEARCHING$/ }).waitFor({ timeout: 30_000 });
    // (Selected from the side panel: the label is walking with its agent, and software WebGL walks slowly.)
    const panel = page.getByRole("complementary", { name: "Selection details" });
    await panel.getByRole("button").filter({ hasText: /^founder-1\b/ }).first().click();
    await panel.getByText("WHY THIS CONDITION", { exact: false }).waitFor();
    expect(await panel.textContent()).toContain("Library / Research");
    await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
  });

  for (const [i, q] of (["low", "medium", "high", "ultra"] as const).entries()) {
    it(`${q}: every room, screen and person renders without errors; frame cadence recorded`, async () => {
      await open(q);
      await shot(`${6 + i}-quality-${q}`);
      const fleet = Math.round(await rafRate(page) * 10) / 10;
      await page.getByLabel("Agents", { exact: true }).getByRole("button", { name: /^founder-1,/ }).click();
      await page.waitForTimeout(4500);
      const agent = Math.round(await rafRate(page) * 10) / 10;
      report[q] = { fleetViewFps: fleet, agentViewFps: agent };
      expect(await page.getByText("The 3D view stopped").count()).toBe(0);
      expect(fleet, `${q} frame cadence`).toBeGreaterThan(1);
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }
});
