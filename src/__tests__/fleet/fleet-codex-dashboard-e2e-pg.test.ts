/**
 * The owner's Codex dashboard (codex-dashboard/, LIVE static export) served by the REAL v41 dashboard service, in Chrome
 * with a virtual passkey, over a real PostgreSQL registry and the identity broker.
 *
 * Proves, through the dashboard's own UI: real enrollment and passkey + TOTP sign-in (no demo code); authoritative
 * Treasury figures (Fleet-generated wealth from the ledger); a fund with a fresh passkey step-up; hold; controls with no
 * live contract disabled with their reason; an owner fact sealed in the browser, then revealed through the broker for 60
 * s; MAIL / SMS NOT CONFIGURED as a healthy state; an unreachable gateway shown as unreachable (never fictional data);
 * an expired session returning to sign-in; and zero CSP violations under the service's strict per-page policy.
 * Fleet Command / Virtual Command Centre: FleetController's state, decisions and events in Formal Fleet Command; a
 * behaviour change through a fresh passkey step-up; portraits and health identical in Agents and Virtual; a real event
 * moving an agent in real time; the 3D scene and the 2D map; an interrupted feed recovering.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { chromium, type Browser, type Page } from "playwright-core";
import { eventTitle } from "../../../codex-dashboard/src/dashboard/command/panels";
import { toFleetEvent } from "../../../codex-dashboard/src/dashboard/command/events";
import { codeText } from "../../../codex-dashboard/src/dashboard/notifications/report";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { ensureLiveUi } from "./fixtures/live-ui.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { PgIdentityGateway } from "../../fleet/identity/gateway.js";
import { IdentityBroker } from "../../fleet/identity/broker.js";
import { initIdentityState, openIdentityState } from "../../fleet/identity/main.js";
import { totp } from "../../fleet/identity/crypto.js";
import { PgDashboardGateway } from "../../fleet/dashboard/gateway.js";
import { createDashboardServer } from "../../fleet/dashboard/server.js";
import { simulateRuntimeAttestation } from "../../fleet/genesis/simulate.js";
import { hashAgentToken, mintAgentToken } from "../../fleet/postgres/store.js";

const PG_BIN = findPgBin();
const CHROME = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => fs.existsSync(p)) ?? null;
const CODEX = path.resolve(__dirname, "../../../codex-dashboard");
const UI = path.join(CODEX, "out");
const FICTION = ["Atlas", "Neon Studio", "Signal intelligence", "owner@example.invalid", "Training TOTP", "DEMO-ONLY", "FICTIONAL DATA"];

/** The LIVE export (rebuilt when absent or when the last build was the simulation). */

describe.skipIf(!PG_BIN || !CHROME || !fs.existsSync(path.join(CODEX, "node_modules")))("Codex dashboard LIVE export on the real v41 gateway (PostgreSQL + Chrome + virtual passkey)", { timeout: 180_000 }, () => {
  let R: EconomyRegistry;
  let A: Founder;
  let dir: string;
  let igw: PgIdentityGateway;
  let broker: IdentityBroker;
  let loop: ReturnType<typeof setInterval>;
  let dgw: PgDashboardGateway;
  let server: http.Server;
  let browser: Browser;
  let page: Page;
  let ORIGIN = "";
  let token = "";
  let secret = "";
  const csp: string[] = [];
  const cash = (who: string) => R.one<number>(`fleet.fleet_agent_cash($1)`, [who]).then(Number);
  const main = () => page.locator("main").textContent().then((t) => t ?? "");
  /** V2.4.2: a sensitive action first asks how to confirm it ("Confirm it is you"); this owner uses the passkey. */
  async function passkeyIfAsked() {
    const b = page.getByRole("dialog", { name: "Confirm it is you" }).getByRole("button", { name: "Use my passkey" });
    if (await b.waitFor({ timeout: 3000 }).then(() => true, () => false)) await b.click();
  }
  /** Review → Confirm in the dashboard's own modal. */
  async function confirm(expectText: RegExp) {
    await page.getByRole("button", { name: "Review changes" }).click();
    await page.getByRole("button", { name: "Confirm", exact: true }).click(); await passkeyIfAsked();
    await page.getByRole("status").filter({ hasText: expectText }).first().waitFor();
  }

  beforeAll(async () => {
    ensureLiveUi();
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000, treasuryCents: 1_000_000 });
    [A] = R.founders;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-codex-e2e-"));
    fs.chmodSync(dir, 0o700);
    initIdentityState(dir);
    igw = new PgIdentityGateway({ connectionString: R.pgc.identityUrl });
    const { vault, ownerVault } = openIdentityState(dir);
    broker = new IdentityBroker(igw, vault, { ownerVault, stateFile: path.join(dir, "pending.json") }); // no mail / SMS provider (dormant)
    await broker.registerProviders();
    let busy = false;
    loop = setInterval(() => { if (!busy) { busy = true; void broker.tick().catch(() => {}).finally(() => { busy = false; }); } }, 200);
    dgw = new PgDashboardGateway({ connectionString: R.pgc.dashboardUrl });
    server = createDashboardServer(dgw, { origin: "http://localhost:0", rpId: "localhost", stateKey: crypto.randomBytes(32) });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    server.close();
    ORIGIN = `http://localhost:${port}`;
    server = createDashboardServer(dgw, { origin: ORIGIN, rpId: "localhost", stateKey: crypto.randomBytes(32), staticDir: UI });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
    // SwiftShader gives headless Chrome WebGL, so the Virtual Command Centre's 3D scene runs under the same CSP.
    browser = await chromium.launch({ executablePath: CHROME!, headless: true, args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
    const ctx = await browser.newContext();
    page = await ctx.newPage();
    page.on("console", (m) => { if (/Content Security Policy|Refused to (execute|load|apply)/i.test(m.text())) csp.push(m.text()); });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("WebAuthn.enable", { enableUI: false });
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true } });
    // The Genesis allocation per agent (100 % wallet health), as production has it (£100.00).
    await R.q(`UPDATE fleet.fleet_genesis_policy SET bootstrap_capital_currency = 'GBP', bootstrap_capital_minor = 10000`);
    token = crypto.randomBytes(32).toString("base64url");
    await R.q(`SELECT fleet.fleet_admin_dashboard_enroll($1, $2)`, [crypto.createHash("sha256").update(token).digest("hex"), OWNER]);
  }, 300_000);
  afterAll(async () => {
    clearInterval(loop);
    await browser?.close(); server?.close(); await dgw?.close(); await igw?.close(); await R?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("an unauthenticated visit to the deck goes to sign-in; the export is the LIVE build", async () => {
    await page.goto(`${ORIGIN}/`);
    await page.waitForURL(/\/login\/$/);
    await page.getByText("This Fleet has no owner sign-in yet", { exact: false }).waitFor(); // after the sign-in state is read
    expect(await main()).toContain(`hub-dashboard-enroll ${ORIGIN}`); // the origin it is served from, nothing built in
    for (const f of FICTION) expect(await page.content(), f).not.toContain(f);
  });

  it("real enrollment and sign-in through the dashboard: one-time link → passkey → TOTP shown once → passkey + TOTP", async () => {
    await page.goto(`${ORIGIN}/login/#enroll=${token}`);
    await page.getByRole("button", { name: "Register passkey" }).click();
    await page.getByRole("button", { name: "Confirm authenticator" }).waitFor();
    secret = (await page.locator("p.font-mono").first().textContent())!.trim();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(page.url()).not.toContain(token); // the one-time token leaves the address bar
    await page.getByLabel("Code from the authenticator").fill(totp(secret));
    await page.getByRole("button", { name: "Confirm authenticator" }).click();
    await page.getByRole("button", { name: "Sign in with passkey" }).click();
    await page.getByRole("button", { name: "Complete sign-in" }).waitFor(); // the passkey step's own code field (V2.4.2: the start screen has one too)
    // The enrollment code's time step is spent; the next step's code completes the session (a demo code never would).
    await page.getByLabel("Authenticator code").fill(totp(secret, Date.now() + 30_000));
    await page.getByRole("button", { name: "Complete sign-in" }).click();
    await page.waitForURL(`${ORIGIN}/`);
    await page.getByText("LIVE · AUTHORITATIVE FLEET DATA", { exact: false }).waitFor();
  });

  it("shows authoritative figures: Treasury cash and Fleet-generated wealth from the ledger; no fictional data anywhere", async () => {
    await page.getByRole("status").filter({ hasText: "Live Fleet read" }).waitFor();
    const w = await R.one<any>(`fleet.fleet_generated_treasury_wealth()`);
    const gbp = (minor: unknown) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(Number(minor) / 100);
    const text = await main();
    expect(text).toContain(gbp(w.treasuryCashMinor));
    expect(text).toContain(`Fleet-generated wealth${gbp(w.fleetGeneratedMinor)}`);
    expect(text).toContain("Agent-1");
    for (const f of FICTION) expect(text, f).not.toContain(f);
    await page.goto(`${ORIGIN}/#Replication`);
    await page.getByText("Fleet-generated realised wealth:").waitFor();
    expect(await main()).toContain(`Next threshold: ${gbp(100_000)}`);
    expect(await main()).toMatch(/Automatic births: policy off, registry switch off/);
  });

  it("controls with no live contract are disabled with their reason; MAIL / SMS NOT CONFIGURED is a normal state", async () => {
    await page.goto(`${ORIGIN}/#Treasury`);
    const topup = page.getByRole("button", { name: "Top up" });
    await topup.waitFor();
    expect(await topup.isDisabled()).toBe(true);
    expect(await topup.getAttribute("title")).toMatch(/recorded with its bank/);
    await page.goto(`${ORIGIN}/#Settings`);
    await page.getByText("MAIL: NOT CONFIGURED").first().waitFor();
    expect(await main()).toContain("SMS: NOT CONFIGURED");
    expect(await main()).toContain("Fleet health: ok");
    expect(await main()).toContain("Scenarios are simulation devices");
  });

  it("funding an agent asks the passkey for a fresh step-up and moves the real ledger; hold pauses the real agent", async () => {
    const before = await cash(A.id);
    await page.goto(`${ORIGIN}/#Agents/${A.id}`);
    await page.getByRole("button", { name: "Fund agent" }).click();
    await page.getByLabel("Amount in GBP").fill("12.34");
    await page.getByLabel("Reason").fill("e2e funding");
    await confirm(/Done: fund/);
    expect(await cash(A.id)).toBe(before + 1234);
    expect((await R.q(`SELECT op, ok FROM fleet.fleet_admin_auth_log WHERE event = 'stepup' ORDER BY seq DESC LIMIT 1`))[0]).toMatchObject({ ok: true });
    // Hold and Resume both report "Done: hold", so the second confirmation can match the first status line: wait for
    // the real agent row instead.
    const held = async () => (await R.q(`SELECT operator_hold_at FROM fleet.fleet_agents WHERE agent_id = $1`, [A.id]))[0].operator_hold_at !== null;
    const until = async (want: boolean) => { for (let i = 0; i < 100 && (await held()) !== want; i++) await new Promise((r) => setTimeout(r, 100)); return held(); };
    await page.getByRole("button", { name: "Hold" }).click();
    await confirm(/Done: hold/);
    expect(await until(true)).toBe(true);
    await page.getByRole("button", { name: "Resume" }).click();
    await page.getByRole("button", { name: "Review changes" }).click();
    await page.getByRole("button", { name: "Confirm", exact: true }).click(); await passkeyIfAsked();
    expect(await until(false)).toBe(false);
  });

  it("an owner fact is sealed in the browser, installed by the broker, then revealed through the broker for 60 s", async () => {
    await page.goto(`${ORIGIN}/#Owner identity`);
    await page.getByRole("button", { name: "Add identity fact" }).click();
    await page.getByLabel("Identity class").selectOption("legal_name");
    await page.getByLabel("Value (sealed in this browser before sending)").fill("Owner Example Legal Name");
    await confirm(/Done: document/);
    const row = await R.q(`SELECT status, sealed FROM fleet.fleet_owner_vault_inbox ORDER BY created_at DESC LIMIT 1`);
    expect(JSON.stringify(row)).not.toContain("Owner Example Legal Name"); // only sealed bytes ever reached the server
    // The broker installs it; the class appears; Reveal opens it in this tab only.
    for (let i = 0; i < 50 && !(await R.q(`SELECT 1 FROM fleet.fleet_owner_identity_classes WHERE class_key = 'legal_name' AND status = 'configured'`)).length; i++) await new Promise((r) => setTimeout(r, 200));
    await page.reload();
    await page.getByRole("button", { name: "Reveal" }).first().click();
    await page.getByRole("button", { name: "Review changes" }).click();
    await page.getByRole("button", { name: "Confirm", exact: true }).click(); await passkeyIfAsked();
    await page.getByText("Owner Example Legal Name").waitFor();
    expect(await page.getByText("LIVE · SEALED TO THIS BROWSER · CLEARS AFTER 60 SECONDS").count()).toBe(1);
    await page.getByRole("button", { name: "Close and clear" }).click();
    expect(await page.getByText("Owner Example Legal Name").count()).toBe(0);
    expect((await R.q(`SELECT outcome FROM fleet.fleet_reveal_log WHERE kind = 'owner_identity' ORDER BY seq`)).map((r) => r.outcome)).toEqual(["requested", "served", "delivered"]);
    const storage = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }));
    expect(storage).not.toContain("Owner Example Legal Name");
  });

  const gbp = (minor: unknown) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(Number(minor) / 100);
  const words = (t: string) => t.replace(/_/g, " ");
  /** The shared health definition, computed independently from the database (100 % = the Genesis allocation). */
  async function expectedBand(agentId: string) {
    const c = await cash(agentId);
    const g = Number((await R.q(`SELECT bootstrap_capital_minor AS g FROM fleet.fleet_genesis_policy LIMIT 1`))[0].g);
    const pct = Math.floor((c * 100) / g);
    return { pct, label: pct >= 80 ? "HEALTHY" : pct >= 40 ? "STRESSED" : "CRITICAL" };
  }

  it("Fleet Command: FleetController's state, decisions and event feed; capability states are read-only and truthful", async () => {
    await page.goto(`${ORIGIN}/#Fleet%20Command`);
    await page.getByText("Controller status").waitFor();
    await page.getByText("command data read", { exact: false }).waitFor();
    const text = await main();
    expect(text).toMatch(/Living agents2 \/ cap \d+/);
    expect(text).toContain("Fleet-generated wealth");
    // The decision log holds the Admin's earlier hold / resume (stored decisions only).
    await page.getByRole("tab", { name: "Decision Log" }).click();
    await page.getByText("agent hold set").first().waitFor();
    expect(await main()).toContain("Model reasoning is never recorded or shown");
    // The information feed shows FleetController's routed events only (v44: P0–P3); audit mechanics never appear there;
    // the full history tab shows the raw record.
    const routed = await R.q(`SELECT event_type, detail FROM fleet.fleet_events WHERE fleet.fleet_event_route(event_type, detail) IN ('P0_CRITICAL','P1_HIGH','P2_IMPORTANT','P3_SUMMARY') ORDER BY created_at DESC LIMIT 1`);
    const latest = await R.q(`SELECT event_type FROM fleet.fleet_events ORDER BY created_at DESC LIMIT 1`);
    await page.getByRole("tab", { name: "Information Feed" }).click();
    const title = routed[0].event_type === "notification" ? codeText(routed[0].detail?.code) : eventTitle(toFleetEvent({ type: routed[0].event_type, at: "2026-10-07T00:00:00Z", detail: routed[0].detail })!);
    await page.getByText(title).first().waitFor();
    const feedText = await page.getByRole("tabpanel").or(page.locator("main")).first().textContent();
    for (const noise of ["Session opened", "Ledger journal posted", "Runtime approved"]) expect(feedText ?? "").not.toContain(noise);
    await page.getByRole("tab", { name: "Full history" }).click();
    await page.getByText(words(latest[0].event_type)).first().waitFor();
    await page.getByRole("tab", { name: "Safety & Capabilities" }).click();
    const caps = await main();
    for (const t of ["REAL PAYMENTS", "HOST SWITCH", "NOT CONFIGURED", "not exposed to this gateway"]) expect(caps.toUpperCase()).toContain(t.toUpperCase());
    expect(await page.locator("table button, table input, table select").count()).toBe(0); // nothing editable there
  });

  it("a behaviour change asks the passkey for a fresh step-up and changes the real mission policy (then restored)", async () => {
    await page.goto(`${ORIGIN}/#Fleet%20Command`);
    await page.getByRole("tab", { name: "Behaviour" }).click();
    const before = Number((await R.q(`SELECT stagnation_days FROM fleet.fleet_mission_policy WHERE id = 1`))[0].stagnation_days);
    const stepups = Number((await R.q(`SELECT count(*) AS n FROM fleet.fleet_admin_auth_log WHERE event = 'stepup' AND ok`))[0].n);
    const stagnation = async () => Number((await R.q(`SELECT stagnation_days FROM fleet.fleet_mission_policy WHERE id = 1`))[0].stagnation_days);
    for (const value of [before + 7, before]) {
      await page.getByRole("button", { name: "Change mission behaviour" }).click();
      await page.getByLabel("Stagnation threshold (days, 1–365)").fill(String(value));
      await page.getByRole("button", { name: "Review changes" }).click();
      await page.getByRole("button", { name: "Confirm", exact: true }).click(); await passkeyIfAsked();
      // The status line may still show the previous "Done", so wait for the real policy row instead.
      for (let i = 0; i < 100 && (await stagnation()) !== value; i++) await new Promise((r) => setTimeout(r, 100));
      expect(await stagnation()).toBe(value);
      await page.getByRole("button", { name: "Change mission behaviour" }).waitFor(); // dialog closed
    }
    expect(Number((await R.q(`SELECT count(*) AS n FROM fleet.fleet_admin_auth_log WHERE event = 'stepup' AND ok`))[0].n)).toBe(stepups + 2);
    expect(Number((await R.q(`SELECT count(*) AS n FROM fleet.fleet_events WHERE event_type = 'mission_policy_set'`))[0].n)).toBeGreaterThanOrEqual(2);
  });

  it("Agents show original portraits with the shared health state (text, not colour alone)", async () => {
    await page.goto(`${ORIGIN}/#Agents`);
    const exp = await expectedBand(A.id);
    const row = page.locator("tr", { hasText: A.id });
    await row.getByText(`${exp.label} · ${exp.pct}%`).waitFor();
    // The painted 128×128 portrait (a data: PNG under the CSP), with its state in text and data.
    await row.locator("img[data-band]").waitFor();
    expect(await row.locator("img[data-band]").count()).toBe(1);
    expect(await row.locator("img[role=img]").getAttribute("alt")).toMatch(/portrait/);
    expect(await row.locator("img[data-band]").getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(await row.locator("img[data-band]").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(128);
  });

  it("Virtual shows the same Fleet: same health and figures, a real event moves the agent live, 3D and map, the feed recovers", async () => {
    const exp = await expectedBand(A.id);
    const w = await R.one<any>(`fleet.fleet_generated_treasury_wealth()`);
    await page.evaluate(() => localStorage.setItem("fleet.virtual.prefs.v1", JSON.stringify({ renderer: "map", quality: "medium", fps: 30, reduceMotion: false, ambient: true, dataFlow: true })));
    await page.goto(`${ORIGIN}/#Virtual`);
    const labels = page.getByLabel("Agents", { exact: true });
    const label = labels.getByRole("button", { name: new RegExp(`^Agent-1, ${gbp(await cash(A.id)).replace(/[.£]/g, "\\$&")}, ${exp.label}, `) });
    await label.waitFor();
    // The Treasury room's panel shows the same Treasury cash as the Formal Treasury page.
    await page.getByRole("button", { name: /^Treasury: / }).click();
    await page.getByRole("complementary", { name: "Selection details" }).getByText(gbp(w.treasuryCashMinor)).first().waitFor();
    // A real FleetController event (research recorded) moves the agent to the Library within the live pulse.
    await R.q(`SELECT fleet.fleet_event('knowledge_recorded', $1, 'agent', '{"topic":"e2e"}'::jsonb)`, [A.id]);
    await page.getByRole("list", { name: "Recent Fleet activity" }).getByText("Research recorded").waitFor({ timeout: 20_000 });
    await page.keyboard.press("Escape"); // back to the Fleet view (the Treasury framing put the Library off-screen)
    await labels.getByRole("button", { name: /^Agent-1, .*, RESEARCHING$/ }).waitFor({ timeout: 20_000 });
    await labels.getByRole("button", { name: /^Agent-1,/ }).click();
    const details = page.getByRole("complementary", { name: "Selection details" });
    expect(await details.textContent()).toContain("Library / Research");
    // The agent's own recent transactions come from its real ledger journals.
    const j = await R.q(`SELECT kind FROM fleet.fleet_ledger_journal WHERE agent_id = $1 ORDER BY seq DESC LIMIT 1`, [A.id]);
    await details.getByText(words(j[0].kind), { exact: false }).first().waitFor();
    // The 3D scene (WebGL through SwiftShader) renders the same agents.
    await page.getByRole("button", { name: "Display" }).click();
    await page.getByLabel("View").selectOption("3d");
    await page.locator("canvas").first().waitFor();
    await labels.getByRole("button", { name: /^Agent-1,/ }).waitFor();
    expect(await page.getByText("The 3D view stopped").count()).toBe(0);
    await page.getByLabel("View").selectOption("map");
    expect(await page.getByText("The 3D view stopped").count()).toBe(0); // leaving 3D is not a failure
    // The live feed is interrupted (reads fail), says so, keeps the last authoritative positions, then recovers.
    await page.route("**/api/read**", (r) => r.abort());
    await page.getByText("Feed interrupted — reconnecting", { exact: false }).waitFor({ timeout: 20_000 });
    expect(await labels.getByRole("button", { name: /^Agent-1,/ }).count()).toBe(1);
    await page.unroute("**/api/read**");
    await page.getByText("Live feed", { exact: true }).waitFor({ timeout: 70_000 });
  });

  it("a real birth while Virtual is open: its dormant workstation powers up, then the agent enters with name and wallet", async () => {
    await page.evaluate(() => localStorage.setItem("fleet.virtual.prefs.v1", JSON.stringify({ renderer: "map", quality: "medium", fps: 60, reduceMotion: false, ambient: true, dataFlow: true })));
    await page.goto(`${ORIGIN}/#Overview`);
    await page.goto(`${ORIGIN}/#Virtual`);
    await page.reload();
    const labels = page.getByLabel("Agents", { exact: true });
    await labels.getByRole("button", { name: /^Agent-1,/ }).waitFor();
    const before = new Set((await R.q(`SELECT agent_id FROM fleet.fleet_agents`)).map((r) => r.agent_id));
    // A real birth (the authoritative pipeline: Admin birth order → authorize → provision → attest → fund → activate).
    await R.q(`UPDATE fleet.fleet_state SET max_agents = max_agents + 1`);
    const orderId = (await R.one<any>(`fleet.fleet_admin_birth('marketing', 'e2e birth', 10000, NULL, $1, $2)`, [OWNER, `birth:${crypto.randomUUID()}`])).orderId as string;
    const g = await R.genesis.birthAuthorize(orderId, OWNER) as any;
    const pv = await R.genesis.provision(g.genesisId, OWNER);
    for (const id of pv.founderIds!) await R.genesis.attest(g.genesisId, id, (await simulateRuntimeAttestation(R.genesis, R.genesis, g.genesisId, id, OWNER)).host, OWNER);
    await R.genesis.fund(g.genesisId, OWNER);
    await R.genesis.activateWithHashes(g.genesisId, g.authSha256, pv.founderIds!.map((id) => hashAgentToken(mintAgentToken(id))), OWNER);
    const born = (await R.q(`SELECT agent_id, name FROM fleet.fleet_agents`)).find((r) => !before.has(r.agent_id))!;
    expect(born).toBeTruthy();
    // Its workstation appears dark, powers up, and only then does the agent show.
    const station = page.locator(`rect[data-station="${born.agent_id}"]`);
    await station.waitFor({ state: "attached", timeout: 30_000 });
    const samples: Array<{ power: number; agentShown: boolean }> = [];
    for (let i = 0; i < 40; i++) {
      samples.push(await page.evaluate(([id, name]) => {
        const st = document.querySelector(`rect[data-station="${id}"]`);
        const g = [...document.querySelectorAll('svg[aria-label="Fleet headquarters map"] g[role=button]')].find((e) => e.getAttribute("aria-label")?.startsWith(`${name},`));
        return { power: Number(st?.getAttribute("fill-opacity") ?? 0), agentShown: !!g && g.getAttribute("visibility") !== "hidden" };
      }, [born.agent_id, born.name]));
      await page.waitForTimeout(100);
    }
    // While the station is still dark the agent is not shown; once it is online the agent is.
    for (const x of samples) if (x.power < 0.3) expect(x.agentShown, JSON.stringify(x)).toBe(false);
    expect(samples.at(-1)!.agentShown).toBe(true);
    expect(Math.min(...samples.map((s) => s.power)), "station starts dormant / powering").toBeLessThan(0.4);
    expect(samples.at(-1)!.power, "station fully online").toBeCloseTo(0.56, 2);
    await labels.getByRole("button", { name: new RegExp(`^${born.name}, £100\.00, `) }).waitFor({ timeout: 20_000 });
    // It then goes to its first destination: its birth mission (Marketing).
    await labels.getByRole("button", { name: new RegExp(`^${born.name}, .*, MARKETING$`) }).waitFor({ timeout: 20_000 });
    await page.getByRole("list", { name: "Recent Fleet activity" }).getByText("Agent born — station online").first().waitFor({ timeout: 20_000 });
  });

  it("an unreachable gateway is shown as unreachable — never fictional data", async () => {
    await page.route("**/api/read**", (r) => r.abort());
    await page.goto(`${ORIGIN}/`);
    await page.getByText("The Fleet is unreachable", { exact: false }).waitFor();
    for (const f of FICTION) expect(await main(), f).not.toContain(f);
    await page.unroute("**/api/read**");
  });

  it("an expired session returns to sign-in; there were no CSP violations under the strict per-page policy", async () => {
    await R.q(`UPDATE fleet.fleet_admin_sessions SET expires_at = now() - interval '1 second' WHERE ended_at IS NULL`);
    await page.goto(`${ORIGIN}/`);
    await page.waitForURL(/\/login\/$/);
    const r = await fetch(`${ORIGIN}/`);
    const policy = r.headers.get("content-security-policy") ?? "";
    expect(policy).toMatch(/script-src 'self'( 'sha256-[A-Za-z0-9+/=]+')+;/);
    expect(policy).toContain("style-src 'self';");
    expect(policy).not.toContain("unsafe-inline");
    expect(csp, csp.join("\n")).toEqual([]);
  });
});
