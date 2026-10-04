/**
 * Virtual HQ — the 3D headquarters on the LIVE export, against real Fleets behind the real dashboard gateway, in
 * Chrome, signed in with a virtual passkey + TOTP.
 *
 * Checks: the scene renders at every quality level without errors; the hierarchical camera (Fleet → Department →
 * Agent) steps back one level per Escape; the agent panel is the existing live panel; a real FleetController event
 * moves an agent and travels between departments as information; a real multi-agent team project (v42: proposed,
 * funded from the lead's own capital, offered, accepted by the recruit itself, started) appears in the HQ and in the
 * project panels with the planner's figures.
 *
 * With FLEET_HQ_SHOTS=<dir> it writes the visual review package; with FLEET_HQ_MATRIX=1 it measures the frame cadence
 * of the Fleet, Department and Agent views at every quality for Fleets of 1, 10, 25 and 50 agents.
 *
 * Department occupancy comes from real recorded events in the fixture's own event log (the same rules that place agents
 * in production); nothing is staged in the browser.
 *
 * A dedicated visual/performance run (WebGL is slow in software and starves a parallel suite). Run it on its own:
 *   FLEET_HQ_TESTS=1 [FLEET_HQ_SHOTS=/some/dir] [FLEET_HQ_GPU=1] [FLEET_HQ_MATRIX=1] npx vitest run src/__tests__/fleet/fleet-virtual-hq-pg.test.ts
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
const QUALITIES = ["low", "medium", "high", "ultra"] as const;

function ensureLiveUi() {
  const html = path.join(UI, "index.html");
  if (!fs.existsSync(path.join(UI, "login", "index.html")) || !fs.readFileSync(html, "utf8").includes("LIVE · AUTHORITATIVE")) {
    execFileSync(process.execPath, ["scripts/build.mjs", "live"], { cwd: CODEX, stdio: "ignore", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
  }
}

const rafRate = (page: Page, ms = 3000) => page.evaluate((d) => new Promise<number>((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < d) requestAnimationFrame(f); else res((n * 1000) / d); }; requestAnimationFrame(f); }), ms);
const round = (v: number) => Math.round(v * 10) / 10;

/** A real Fleet of n agents behind the real dashboard service, signed in. */
async function signedInFleet(browser: Browser, n: number) {
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
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
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
  return { R, page, origin, errors, close: async () => { await ctx.close(); server.close(); await dgw.close(); await R.close(); } };
}

/** Real recorded activity that places agents across the building (production's own placement rules). */
const ACTIVITY = ["knowledge_recorded", "opportunity_recorded", "venture_created", "ledger_journal_posted", "knowledge_recorded", "venture_created", "mail_draft_recorded",
  "identity_claim_recorded", "health_challenge_passed", "capital_requested", "opportunity_recorded", "knowledge_recorded"];
async function spreadAgents(R: EconomyRegistry) {
  for (const [i, f] of R.founders.entries()) {
    const type = i < ACTIVITY.length ? ACTIVITY[i] : null;
    if (type) await R.q(`SELECT fleet.fleet_event($1, $2, 'agent', '{"source":"hq-review"}'::jsonb)`, [type, f.id]);
  }
}

/**
 * A real team project through the agents' own operations: founder-1 proposes a venture project (the planner decides the
 * ETAs), funds it from its own capital, offers founder-2 the engineer role; founder-2 accepts itself; the project starts
 * and work begins in parallel.
 */
async function teamProject(R: EconomyRegistry) {
  const [A, B] = R.founders;
  const ok = async (p: Promise<Record<string, any>>) => { const r = await p; expect(r, JSON.stringify(r)).toMatchObject({ ok: true }); return r; };
  const e = await R.one(`fleet.fleet_admin_legal_entity_add('Fleet Trading Ltd', 'GB', 'company', true, $1)`, [OWNER]);
  await R.one(`fleet.fleet_admin_tax_profile_set($1, '[{"taxKind":"profit","rateBp":2000}]'::jsonb, now() - interval '1 second', NULL, $2)`, [e.entity_id, OWNER]);
  await R.one(`fleet.fleet_admin_rail_add('simulated', 'sim', 'shared', NULL, ARRAY['receive_payments'], 'sim checkout', NULL, 'simulated', NULL, NULL, $1)`, [OWNER]);
  await ok(R.econ(A, "venture.create", { key: "client-portal", model: "software", offer: "client portal", state: "selected", channels: ["direct"] }));
  await R.econ(A, "rail.require", { ventureKey: "client-portal" });
  const p = await ok(R.econ(A, "project.propose", {
    idempotencyKey: `hq:${crypto.randomUUID()}`, key: "portal-v1", ventureKey: "client-portal", name: "Client portal", objective: "Ship the client portal sooner",
    expectedValueMinor: 50_000, expectedReturnMinor: 30_000, budgetMinor: 3_000, opportunityCostMinor: 1_000, timeValueMinorPerDay: 4_000,
    coordinationHours: 2, coordinationCostMinor: 500, risk: "medium",
    justification: { decomposition: "architecture, backend, frontend, integration", parallelism: "backend and frontend run in parallel after architecture",
      whyTeam: "an engineer takes the 20 h backend off the critical path", timeToRevenue: "revenue starts at launch; 16 h sooner" },
    tasks: [
      { key: "arch", title: "Architecture", ownerRole: "lead", hours: 8, deliverable: "design doc", acceptance: "covers API and data model" },
      { key: "backend", title: "Backend", ownerRole: "engineer", hours: 20, deps: ["arch"], deliverable: "API service", acceptance: "tests pass", capability: "backend" },
      { key: "frontend", title: "Frontend", ownerRole: "lead", hours: 18, deps: ["arch"], deliverable: "portal UI", acceptance: "usable" },
      { key: "integration", title: "Integration", ownerRole: "lead", hours: 6, deps: ["backend", "frontend"], deliverable: "live portal", acceptance: "end to end" },
    ],
    roles: [{ role: "engineer", taskScope: "the backend API", requiredCapability: "backend", compensation: { type: "FIXED", fixedMinor: 1_000 } }],
  }));
  const P = p.project.projectId as string;
  await ok(R.econ(A, "project.fund", { projectId: P, amountMinor: 1_600, source: "own" }));
  const o = await ok(R.econ(A, "project.offer", { projectId: P, role: "engineer", agentId: B.id, deliverable: "the backend API", expectedHours: 20, deadline: new Date(Date.now() + 7 * 86_400_000).toISOString() }));
  await ok(R.econ(B, "project.respond", { memberId: o.memberId, response: "ACCEPT", reason: "fits my capacity; fair pay" }));
  await ok(R.econ(A, "project.start", { projectId: P }));
  await ok(R.econ(A, "project.task", { projectId: P, taskKey: "arch", action: "start" }));
  await ok(R.econ(A, "project.task", { projectId: P, taskKey: "arch", action: "deliver", evidence: [{ kind: "note", observation: "design doc" }] }));
  await ok(R.econ(A, "project.review", { projectId: P, taskKey: "arch", verdict: "accept", reason: "meets acceptance" }));
  await ok(R.econ(B, "project.task", { projectId: P, taskKey: "backend", action: "start" }));
  await ok(R.econ(A, "project.task", { projectId: P, taskKey: "frontend", action: "start" }));
  return { P, eta: p.project.eta as Record<string, number> };
}

describe.skipIf(!process.env.FLEET_HQ_TESTS || !PG_BIN || !CHROME || !fs.existsSync(path.join(CODEX, "node_modules")))("Virtual HQ (LIVE export, real Fleets)", { timeout: 3_600_000 }, () => {
  let browser: Browser;
  let F: Awaited<ReturnType<typeof signedInFleet>>;
  let project: Awaited<ReturnType<typeof teamProject>>;
  const report: Record<string, unknown> = {};

  beforeAll(async () => {
    ensureLiveUi();
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
    // FLEET_HQ_GPU=1 measures on the machine's GPU (ANGLE over OpenGL) instead of software WebGL.
    const gl = process.env.FLEET_HQ_GPU ? ["--use-angle=gl", "--enable-gpu", "--ignore-gpu-blocklist"] : ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"];
    browser = await chromium.launch({ executablePath: CHROME!, headless: true, args: ["--no-sandbox", ...gl] });
    F = await signedInFleet(browser, 12);
    await spreadAgents(F.R);
    project = await teamProject(F.R);
  }, 900_000);

  afterAll(async () => {
    await F?.close(); await browser?.close();
    console.log(`virtual hq: ${JSON.stringify(report)}`);
    if (SHOTS) fs.writeFileSync(path.join(SHOTS, "performance.json"), JSON.stringify(report, null, 2));
  });

  const open = async (page: Page, origin: string, quality: string, extra: object = {}) => {
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [PREFS, JSON.stringify({ renderer: "3d", quality, fps: 60, reduceMotion: false, ambient: true, dataFlow: true, ...extra })]);
    // On a GPU whose driver cannot build shadow maps, a real browser remembers that after the first failure; each fresh
    // test context starts with that memory, or the repeated driver resets make Chrome block WebGL for the whole run.
    if (process.env.FLEET_HQ_GPU) await page.evaluate(() => localStorage.setItem("fleet.virtual.gpu.noShadowMaps.v1", "1"));
    await page.goto(`${origin}/#Virtual`);
    await page.reload();
    await page.locator("canvas").first().waitFor();
    await page.getByRole("complementary", { name: "Selection details" }).getByText("The Fleet, as it is").waitFor({ timeout: 30_000 });
    await page.waitForTimeout(6000); // births settle, people walk to their spots, the camera arrives
  };
  const shot = async (page: Page, name: string) => { if (SHOTS) await page.locator("canvas").first().screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
  const hint = (page: Page) => page.getByText(/· Esc steps back a level$/).textContent();
  const panel = (page: Page) => page.getByRole("complementary", { name: "Selection details" });
  const toDepartment = async (page: Page, dep: string) => {
    await panel(page).getByRole("button", { name: dep, exact: true }).first().click();
    await page.waitForTimeout(4500);
    expect(await hint(page)).toMatch(new RegExp(`^${dep.replace("/", "\\/")}`));
  };
  const toFleet = async (page: Page) => {
    for (let i = 0; i < 3 && !/^Fleet view/.test((await hint(page)) ?? ""); i++) { await page.keyboard.press("Escape"); await page.waitForTimeout(400); }
    expect(await hint(page)).toMatch(/^Fleet view/);
  };
  const toAgent = async (page: Page, name: string) => {
    await panel(page).getByRole("button").filter({ hasText: new RegExp(`^${name}\\b`) }).first().click();
    await panel(page).getByText("WHY THIS CONDITION", { exact: false }).waitFor();
    await page.waitForTimeout(4500);
    expect(await hint(page)).toMatch(new RegExp(`^${name}`));
  };

  it("hierarchical camera, the live agent panel, Escape steps back one level; the department views", async () => {
    const { page, origin } = F;
    await open(page, origin, "high");
    expect(await hint(page)).toMatch(/^Fleet view/);
    for (const [dep, file] of [["Fleet Command", "05-fleet-command"], ["Treasury", "06-treasury-banner"], ["Agent Floor", "07-agent-floor"], ["Opportunity Lab", "08-opportunity-lab"],
      ["Venture / Dev", "09-venture-dev"], ["Library / Research", "10-library-research"], ["Security / Systems", "11-security-systems"]] as const) {
      await toDepartment(page, dep);
      await shot(page, file);
      await toFleet(page);
    }
    await toAgent(page, "founder-1");
    await shot(page, "12-founder-1-close-up");
    await page.keyboard.press("Escape"); await page.waitForTimeout(500);
    expect(await hint(page)).not.toMatch(/^founder-1|^Fleet view/);
    await page.keyboard.press("Escape"); await page.waitForTimeout(500);
    expect(await hint(page)).toMatch(/^Fleet view/);
    expect(await page.getByText("The 3D view stopped").count()).toBe(0);
  });

  it("the team project: both agents in Venture / Dev at the team table, the project panel with the planner's figures", async () => {
    const { page } = F;
    // The planner's own figures: solo 52 h, team 34 h critical path + 2 h coordination, 16 h planned saving (not 52 ÷ 2).
    expect(project.eta).toMatchObject({ soloHours: 52, teamHours: 36, plannedTimeSavedHours: 16 });
    await toDepartment(page, "Venture / Dev");
    const p = panel(page);
    const card = p.getByRole("article", { name: "Project Client portal" });
    await card.waitFor({ timeout: 30_000 });
    const text = (await card.textContent()) ?? "";
    // 52 h = 6.5 working days solo, 36 h = 4.5 days as a team (the panel shows working days of 8 h).
    for (const t of ["LEAD: founder-1", "TEAM: 2", "ETA solo", "6.5 days", "ETA team", "4.5 days", "founder-2", "engineer", "£10.00 fixed"]) expect(text, t).toContain(t);
    await page.waitForTimeout(3000);
    await shot(page, "15-team-project-venture");
    await p.screenshot({ path: SHOTS ? path.join(SHOTS, "16-project-panel.png") : path.join(process.env.TMPDIR ?? "/tmp", "hq-16.png") });
    await toFleet(page);
  });

  it("a real FleetController event moves the agent and travels between departments as information", async () => {
    const { page, R } = F;
    const A = R.founders[3].id; // founder-4, recorded in the Treasury
    await R.q(`SELECT fleet.fleet_event('knowledge_recorded', $1, 'agent', '{"topic":"hq-live"}'::jsonb)`, [A]);
    await page.getByRole("list", { name: "Recent Fleet activity" }).getByText("Research recorded").first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(1500); // mid-flight along the conduits
    await shot(page, "14-information-flow");
    await page.getByLabel("Agents", { exact: true }).getByRole("button", { name: /^founder-4, .*, RESEARCHING$/ }).waitFor({ timeout: 30_000 });
    await panel(page).getByRole("button").filter({ hasText: /^founder-4\b/ }).first().click();
    await panel(page).getByText("WHY THIS CONDITION", { exact: false }).waitFor();
    expect(await panel(page).textContent()).toContain("Library / Research");
    await toFleet(page);
  });

  for (const [i, q] of QUALITIES.entries()) {
    it(`${q}: every room, screen and person renders without errors; frame cadence recorded`, async () => {
      const { page, origin, errors } = F;
      await open(page, origin, q);
      await shot(page, `0${i + 1}-fleet-${q}`);
      const fleet = round(await rafRate(page));
      await toDepartment(page, "Agent Floor");
      const dep = round(await rafRate(page));
      await toFleet(page);
      await toAgent(page, "founder-1");
      const agent = round(await rafRate(page));
      await toFleet(page);
      report[`12 agents ${q}`] = { fleet, department: dep, agent };
      expect(await page.getByText("The 3D view stopped").count()).toBe(0);
      expect(fleet, `${q} frame cadence`).toBeGreaterThan(1);
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }

  it.skipIf(!process.env.FLEET_HQ_MATRIX)("performance matrix: Fleet / Department / Agent × Low…Ultra × 1, 10, 25, 50 agents", async () => {
    await F.page.goto("about:blank"); // the review page's scene must not render alongside (it would share the GPU)
    for (const n of [1, 10, 25, 50]) {
      const G = await signedInFleet(browser, n);
      try {
        await spreadAgents(G.R);
        for (const q of QUALITIES) {
          await open(G.page, G.origin, q);
          const fleet = round(await rafRate(G.page));
          await toDepartment(G.page, "Agent Floor");
          const dep = round(await rafRate(G.page));
          await toFleet(G.page);
          await toAgent(G.page, "founder-1");
          const agent = round(await rafRate(G.page));
          await toFleet(G.page);
          report[`${n} agents ${q}`] = { fleet, department: dep, agent };
          expect(await G.page.getByText("The 3D view stopped").count()).toBe(0);
        }
        expect(G.errors, G.errors.join("\n")).toEqual([]);
      } finally { await G.close(); }
    }
  });
});
