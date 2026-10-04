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
import pg from "pg";
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
 * A real team project through the agents' own operations — setup (before the page opens): the test-only economic
 * environment the backend suites use (a tax profile, a simulated rail, the Treasury sweep policy switched on in THIS
 * throwaway database), founder-1's venture, and its proposal and funding. The planner decides the ETAs. Founder-2's role
 * is negotiated explicitly (hybrid: a pre-agreed fixed project cost + a share of POST-SWEEP distributable profit).
 */
const SHARE_TERMS = { type: "HYBRID", fixedMinor: 1_000, profitShareBp: 3_000, profitShareUntil: new Date(Date.now() + 365 * 86_400_000).toISOString() };
async function teamProject(R: EconomyRegistry) {
  const [A] = R.founders;
  const ok = async (p: Promise<Record<string, any>>) => { const r = await p; expect(r, JSON.stringify(r)).toMatchObject({ ok: true }); return r; };
  const e = await R.one(`fleet.fleet_admin_legal_entity_add('Fleet Trading Ltd', 'GB', 'company', true, $1)`, [OWNER]);
  await R.one(`fleet.fleet_admin_tax_profile_set($1, '[{"taxKind":"profit","rateBp":2000}]'::jsonb, now() - interval '1 second', NULL, $2)`, [e.entity_id, OWNER]);
  const rail = (await R.one(`fleet.fleet_admin_rail_add('simulated', 'sim', 'shared', NULL, ARRAY['receive_payments'], 'sim checkout', NULL, 'simulated', NULL, NULL, $1)`, [OWNER])).railId as string;
  await R.one(`fleet.fleet_admin_sweep_policy_set(true, NULL, NULL, NULL, NULL, NULL, $1)`, [OWNER]);
  await R.store.grantServiceRole();
  await ok(R.econ(A, "venture.create", { key: "client-portal", model: "software", offer: "client portal", state: "selected", channels: ["direct"] }));
  await R.econ(A, "rail.require", { ventureKey: "client-portal" });
  const p = await ok(R.econ(A, "project.propose", {
    idempotencyKey: `hq:${crypto.randomUUID()}`, key: "portal-v1", ventureKey: "client-portal", name: "Client portal", objective: "Ship the client portal sooner",
    expectedValueMinor: 50_000, expectedReturnMinor: 30_000, budgetMinor: 3_000, opportunityCostMinor: 1_000, timeValueMinorPerDay: 40_000, // the lead's forecast: a launch-dated client contract values each day saved
    coordinationHours: 2, coordinationCostMinor: 500, risk: "medium",
    justification: { decomposition: "architecture, backend, frontend, integration", parallelism: "backend and frontend run in parallel after architecture",
      whyTeam: "an engineer takes the 20 h backend off the critical path", timeToRevenue: "revenue starts at launch; 16 h sooner" },
    tasks: [
      { key: "arch", title: "Architecture", ownerRole: "lead", hours: 8, deliverable: "design doc", acceptance: "covers API and data model" },
      { key: "backend", title: "Backend", ownerRole: "engineer", hours: 20, deps: ["arch"], deliverable: "API service", acceptance: "tests pass", capability: "backend" },
      { key: "frontend", title: "Frontend", ownerRole: "lead", hours: 18, deps: ["arch"], deliverable: "portal UI", acceptance: "usable" },
      { key: "integration", title: "Integration", ownerRole: "lead", hours: 6, deps: ["backend", "frontend"], deliverable: "live portal", acceptance: "end to end" },
    ],
    roles: [{ role: "engineer", taskScope: "the backend API", requiredCapability: "backend", compensation: SHARE_TERMS }],
  }));
  const P = (p.id ?? p.project?.projectId ?? p.project?.id) as string;
  await ok(R.econ(A, "project.fund", { projectId: P, amountMinor: 1_600, source: "own" }));
  return { P, rail, eta: (p.project?.eta ?? {}) as Record<string, number>, ok };
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
    // FLEET_HQ_GPU=native: Chrome's own hardware backend (real GPUs: D3D11 / Metal / Vulkan / GL) — scripts/hq-benchmark.sh.
    const gl = process.env.FLEET_HQ_GPU === "native" ? ["--enable-gpu", "--ignore-gpu-blocklist"]
      : process.env.FLEET_HQ_GPU ? ["--use-angle=gl", "--enable-gpu", "--ignore-gpu-blocklist"] : ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"];
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
    if (process.env.FLEET_HQ_GPU && process.env.FLEET_HQ_GPU !== "native") await page.evaluate(() => localStorage.setItem("fleet.virtual.gpu.noShadowMaps.v1", "1"));
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

  // Video of an animated sequence (FLEET_HQ_VIDEO=1): the scene canvas recorded in the browser (MediaRecorder → WebM).
  const VIDEO = !!(process.env.FLEET_HQ_VIDEO && SHOTS);
  const startRec = async (page: Page) => { if (VIDEO) await page.evaluate(() => {
    const c = document.querySelector("canvas") as HTMLCanvasElement, rec = new MediaRecorder(c.captureStream(30), { mimeType: "video/webm;codecs=vp9", videoBitsPerSecond: 6_000_000 });
    const w = window as unknown as { __chunks: Blob[]; __rec: MediaRecorder }; w.__chunks = []; rec.ondataavailable = (e) => w.__chunks.push(e.data); rec.start(250); w.__rec = rec;
  }); };
  const stopRec = async (page: Page, name: string) => {
    if (!VIDEO) return;
    const b64 = await page.evaluate(() => new Promise<string>((res) => {
      const w = window as unknown as { __chunks: Blob[]; __rec: MediaRecorder };
      w.__rec.onstop = async () => { const buf = new Uint8Array(await new Blob(w.__chunks, { type: "video/webm" }).arrayBuffer()); let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); res(btoa(s)); };
      w.__rec.stop();
    }));
    fs.writeFileSync(path.join(SHOTS, `${name}.webm`), Buffer.from(b64, "base64"));
  };
  const ticker = (page: Page, text: string) => page.getByRole("list", { name: "Recent Fleet activity" }).getByText(text).first().waitFor({ timeout: 25_000 });

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

  it("live choreography from real events: an agent walks between departments; a team offer, acceptance and task delivery travel between the agents; a sale, the internal Treasury sweep and the post-sweep distribution", async () => {
    const { page, R } = F;
    const [A, B] = R.founders, walker = R.founders[5];
    const ok = project.ok, P = project.P;
    const svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 1 });
    try {
      // 13. A real state change: founder-6 records research and walks from Venture / Dev to the Library, through the building.
      await startRec(page);
      await R.q(`SELECT fleet.fleet_event('knowledge_recorded', $1, 'agent', '{"topic":"hq-walk"}'::jsonb)`, [walker.id]);
      await ticker(page, "founder-6 · Research recorded");
      await page.waitForTimeout(3500); await shot(page, "13-agent-walking");
      await page.waitForTimeout(6000); await stopRec(page, "13-agent-walking");
      // 15. The team offer travels from founder-1 to founder-2; founder-2 answers itself; the acceptance travels back.
      await startRec(page);
      const o = await ok(R.econ(A, "project.offer", { projectId: P, role: "engineer", agentId: B.id, deliverable: "the backend API", expectedHours: 20, compensation: SHARE_TERMS, deadline: new Date(Date.now() + 7 * 86_400_000).toISOString() }));
      await ticker(page, "Team offer");
      await page.waitForTimeout(2200); await shot(page, "15-team-offer");
      await ok(R.econ(B, "project.respond", { memberId: o.memberId, response: "ACCEPT", reason: "fits my capacity; fair terms" }));
      await ticker(page, "Team member joined");
      await page.waitForTimeout(5000); await stopRec(page, "15-team-offer");
      // Work begins in parallel after the architecture task (the planner's dependency graph).
      await ok(R.econ(A, "project.start", { projectId: P }));
      for (const [who, k, act] of [[A, "arch", "start"], [A, "arch", "deliver"]] as const) await ok(R.econ(who, "project.task", { projectId: P, taskKey: k, action: act }));
      await ok(R.econ(A, "project.review", { projectId: P, taskKey: "arch", verdict: "accept", reason: "meets acceptance" }));
      await ok(R.econ(B, "project.task", { projectId: P, taskKey: "backend", action: "start" }));
      await ok(R.econ(A, "project.task", { projectId: P, taskKey: "frontend", action: "start" }));
      await page.waitForTimeout(8000); // both now work in Venture / Dev (their latest recorded activity is the project)
      // 16. founder-2 delivers the backend to founder-1.
      await startRec(page);
      await ok(R.econ(B, "project.task", { projectId: P, taskKey: "backend", action: "deliver" }));
      await ticker(page, "Task delivered");
      await page.waitForTimeout(1500); await shot(page, "16-task-delivery");
      await page.waitForTimeout(4000); await stopRec(page, "16-task-delivery");
      await ok(R.econ(A, "project.review", { projectId: P, taskKey: "backend", verdict: "accept", reason: "tests pass" }));
      for (const [k, act] of [["frontend", "deliver"], ["integration", "start"], ["integration", "deliver"]] as const) {
        await ok(R.econ(A, "project.task", { projectId: P, taskKey: k, action: act }));
        if (act === "deliver") await ok(R.econ(A, "project.review", { projectId: P, taskKey: k, verdict: "accept", reason: "done" }));
      }
      // 17. A real sale (test rail), the internal Treasury sweep (no external transfer), then the post-sweep distribution.
      const vid = (await R.q(`SELECT venture_id FROM fleet.fleet_ventures WHERE agent_id = $1 AND venture_key = 'client-portal'`, [A.id]))[0].venture_id;
      const ext = `sale:${crypto.randomUUID()}`;
      await svc.query(`SELECT fleet.svc_settlement_ingest($1, $2, 'sale', 125000, 0, 'GBP', $3, now(), $4, NULL)`, [project.rail, ext, vid, crypto.createHash("sha256").update(ext).digest("hex")]);
      const orders0 = Number((await R.q(`SELECT count(*) AS n FROM fleet.fleet_payment_orders`))[0].n);
      await startRec(page);
      const sweep = (await svc.query(`SELECT fleet.svc_sweep_run('2027-05') AS r`)).rows[0].r;
      expect(sweep).toMatchObject({ enabled: true });
      await ticker(page, "Profit contribution to the Treasury");
      await page.waitForTimeout(2500); await shot(page, "17a-treasury-sweep");
      const dist = await ok(R.econ(A, "project.distribute", { projectId: P }));
      await ticker(page, "Profit distribution");
      await page.waitForTimeout(2200); await shot(page, "17c-profit-distribution");
      await page.waitForTimeout(5000); await stopRec(page, "17-sweep-then-distribution");
      // The order the owner set: realised profit → Treasury sweep → negotiated distribution of the remainder; nothing external.
      const t = dist.tranche ?? dist.distribution?.tranches?.at(-1);
      // The sweep took exactly the policy rate that applied to this agent (dynamic policy; no team exemption).
      expect(Number(t.sweepRateBp)).toBeGreaterThan(0);
      expect(Number(t.sweepAttributedMinor)).toBe(Math.floor((Number(t.profitMinor) * Number(t.sweepRateBp)) / 10_000));
      expect(Number(t.distributableMinor)).toBe(Number(t.profitMinor) - Number(t.sweepAttributedMinor));
      expect(Number((await R.q(`SELECT count(*) AS n FROM fleet.fleet_payment_orders`))[0].n)).toBe(orders0); // no external payment
      // The Treasury banner shows the authoritative figure after the sweep.
      await toDepartment(page, "Treasury");
      const cash = Number((await R.one(`fleet.fleet_generated_treasury_wealth()`)).treasuryCashMinor);
      expect(cash).toBeGreaterThan(0);
      await page.waitForTimeout(2500); await shot(page, "17b-treasury-banner-after-sweep");
      await toFleet(page);
    } finally { await svc.end(); }
  });

  it("the team project panel: lead, roles, negotiated terms, the post-sweep distribution and the planner's critical path", async () => {
    const { page } = F;
    // The planner's own figures: solo 52 h; team = 34 h critical path + 2 h coordination (not 52 ÷ 2).
    expect(project.eta).toMatchObject({ soloHours: 52, teamHours: 36 });
    await toDepartment(page, "Venture / Dev");
    const p = panel(page);
    const card = p.getByRole("article", { name: "Project Client portal" });
    await card.waitFor({ timeout: 30_000 });
    const text = (await card.textContent()) ?? "";
    for (const t of ["LEAD: founder-1", "TEAM: 2", "6.5 days", "4.5 days", "founder-2", "engineer", "£10.00 fixed", "30 % of post-sweep distributable profit", "Profit distribution (after the Treasury sweep)", "Treasury sweep"]) expect(text, t).toContain(t);
    await page.waitForTimeout(3000);
    await shot(page, "15b-team-project-venture");
    await p.screenshot({ path: SHOTS ? path.join(SHOTS, "18-project-panel.png") : path.join(process.env.TMPDIR ?? "/tmp", "hq-18.png") });
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
