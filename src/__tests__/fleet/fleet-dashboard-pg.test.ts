/**
 * Schema v38/v39 — the Admin control centre: the Next.js static export served by the v38 dashboard service (PostgreSQL +
 * the identity broker + a REAL Chrome with a virtual WebAuthn authenticator; no real account, identity or money).
 *
 * Enrollment with a one-time link (passkey + TOTP), sign-in (passkey → TOTP, replay-proof), agents and an agent page
 * (agent-written text can never become markup), pause, an end-to-end Admin reveal of an agent credential decrypted only
 * in the browser after a step-up, an owner-identity upload sealed in the browser and revealed again, and the API's
 * refusals (no session, no CSRF, no step-up, a replayed step-up, a foreign origin, a used enrollment link).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import pg from "pg";
import { chromium, type Browser, type Page } from "playwright-core";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { PgIdentityGateway } from "../../fleet/identity/gateway.js";
import { IdentityBroker } from "../../fleet/identity/broker.js";
import { SimulatedMailProvider, SimulatedPlatform } from "../../fleet/identity/providers.js";
import { initIdentityState, openIdentityState } from "../../fleet/identity/main.js";
import { totp } from "../../fleet/identity/crypto.js";
import { PgDashboardGateway } from "../../fleet/dashboard/gateway.js";
import { createDashboardServer } from "../../fleet/dashboard/server.js";
import { dashboardEnvProblems } from "../../fleet/dashboard/main.js";
import { execFileSync } from "child_process";

const UI = path.resolve(__dirname, "../../../packages/dashboard-web/out");
/** The control centre is the Next.js export; build it when the release build has not. */
function ensureUi() {
  if (!fs.existsSync(path.join(UI, "login", "index.html"))) {
    execFileSync("pnpm", ["--filter", "@automaton-fleet/dashboard-web", "build"], { cwd: path.resolve(__dirname, "../../.."), stdio: "ignore", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
  }
}
import { auditPrivileges } from "../../fleet/postgres/privileges.js";

const PG_BIN = findPgBin();
const CHROME = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => fs.existsSync(p)) ?? null;

describe("dashboard startup (unit)", () => {
  it("refuses root, foreign credentials, a public listen address and a non-https origin", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "dash-")); fs.chmodSync(d, 0o700);
    fs.writeFileSync(path.join(d, "dashboard.key"), crypto.randomBytes(32).toString("base64"), { mode: 0o600 });
    const ui = fs.mkdtempSync(path.join(os.tmpdir(), "dash-ui-"));
    fs.mkdirSync(path.join(ui, "login")); fs.writeFileSync(path.join(ui, "index.html"), "x"); fs.writeFileSync(path.join(ui, "login", "index.html"), "x");
    const base = { FLEET_DASHBOARD_DATABASE_URL: "postgresql://fleet_dashboard_login:x@127.0.0.1/db", FLEET_DASHBOARD_ORIGIN: "https://admin.example.test", FLEET_DASHBOARD_STATE_DIR: d,
      FLEET_DASHBOARD_STATIC_DIR: ui };
    try {
      expect(dashboardEnvProblems(base, { uid: process.getuid!(), username: "u" })).toEqual([]);
      expect(dashboardEnvProblems(base, { uid: 0, username: "root" })).toContain("refusing to run as root (uid 0)");
      for (const k of ["FLEET_ADMIN_DATABASE_URL", "FLEET_IDENTITY_DATABASE_URL", "FLEET_SERVICE_DATABASE_URL"]) {
        expect(dashboardEnvProblems({ ...base, [k]: "x" }, { uid: process.getuid!(), username: "u" }).join(), k).toMatch(new RegExp(k));
      }
      expect(dashboardEnvProblems({ ...base, FLEET_DASHBOARD_LISTEN: "0.0.0.0:8790" }, { uid: process.getuid!(), username: "u" }).join()).toMatch(/loopback/);
      expect(dashboardEnvProblems({ ...base, FLEET_DASHBOARD_ORIGIN: "http://admin.example.test" }, { uid: process.getuid!(), username: "u" }).join()).toMatch(/https/);
      expect(dashboardEnvProblems({ ...base, FLEET_DASHBOARD_STATIC_DIR: d }, { uid: process.getuid!(), username: "u" }).join()).toMatch(/not built/);
    } finally { fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(ui, { recursive: true, force: true }); }
  });
});

describe.skipIf(!PG_BIN || !CHROME)("v38/v39 Admin control centre — Next.js (PostgreSQL + Chrome + virtual passkey)", { timeout: 180_000 }, () => {
  let R: EconomyRegistry;
  let A: Founder;
  let dir: string;
  let igw: PgIdentityGateway;
  let dgw: PgDashboardGateway;
  let broker: IdentityBroker;
  let server: http.Server;
  let browser: Browser;
  let page: Page;
  let ORIGIN = "";
  let loop: NodeJS.Timeout;
  let totpSecret = "";
  let token = "";
  const mail = new SimulatedMailProvider();
  const market = new SimulatedPlatform({ platform: "sim-market", mail });
  const ok = async (p: Promise<Record<string, any>>) => { const r = await p; expect(r.ok, JSON.stringify(r)).toBe(true); return r; };
  const toast = async () => (await page.locator("#toasts").textContent()) ?? "";
  const cspViolations: string[] = [];
  const waitToast = async (re: RegExp) => { await expect.poll(toast, { timeout: 30_000 }).toMatch(re); };

  beforeAll(async () => {
    ensureUi();
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000 });
    [A] = R.founders;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-dash-"));
    fs.chmodSync(dir, 0o700);
    initIdentityState(dir);
    igw = new PgIdentityGateway({ connectionString: R.pgc.identityUrl });
    const { vault, ownerVault } = openIdentityState(dir);
    broker = new IdentityBroker(igw, vault, { mail, connectors: [market], ownerVault, stateFile: path.join(dir, "pending.json") });
    let busy = false;
    loop = setInterval(() => { if (!busy) { busy = true; void broker.tick().catch(() => {}).finally(() => { busy = false; }); } }, 200);
    // An agent with a credential (created by the broker) and a hostile persona name.
    await ok(R.econ(A, "mailbox.provision", { localPart: "maya", idempotencyKey: `id:${crypto.randomUUID()}` }));
    await ok(R.econ(A, "identity.create", { displayName: `<img src=x onerror="window.__xss=1">`, kind: "brand" }));
    await ok(R.econ(A, "account.create", { platform: "sim-market", kind: "marketplace", handle: "mayahart", idempotencyKey: `id:${crypto.randomUUID()}` }));
    for (let i = 0; i < 60 && !(await R.q(`SELECT 1 FROM fleet.fleet_agent_account_credentials`)).length; i++) await new Promise((r) => setTimeout(r, 100));

    dgw = new PgDashboardGateway({ connectionString: R.pgc.dashboardUrl });
    server = createDashboardServer(dgw, { origin: "http://localhost:0", rpId: "localhost", stateKey: crypto.randomBytes(32) });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    ORIGIN = `http://localhost:${port}`;
    server.close();
    server = createDashboardServer(dgw, { origin: ORIGIN, rpId: "localhost", stateKey: crypto.randomBytes(32), staticDir: UI });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));

    browser = await chromium.launch({ executablePath: CHROME!, headless: true, args: ["--no-sandbox"] });
    const ctx = await browser.newContext();
    page = await ctx.newPage();
    page.on("console", (m) => { if (/Content Security Policy|Refused to (execute|load|apply)/i.test(m.text())) cspViolations.push(m.text()); });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("WebAuthn.enable", { enableUI: false });
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true } });
    token = crypto.randomBytes(32).toString("base64url");
    await R.q(`SELECT fleet.fleet_admin_dashboard_enroll($1, $2)`, [crypto.createHash("sha256").update(token).digest("hex"), OWNER]);
  }, 240_000);
  afterAll(async () => {
    clearInterval(loop);
    await browser?.close(); server?.close(); await dgw?.close(); await igw?.close(); await R?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("enrolls a passkey and a TOTP factor from a one-time link, then signs in (passkey → TOTP)", async () => {
    await page.goto(`${ORIGIN}/login/#enroll=${token}`);
    await page.click("#enroll-btn");
    await page.locator("#totp-secret").waitFor({ state: "visible" });
    totpSecret = (await page.locator("#totp-secret").textContent())!.trim();
    expect(totpSecret).toMatch(/^[A-Z2-7]{32}$/);
    await page.fill("#totp-code", totp(totpSecret));
    await page.click("#totp-confirm");
    await page.locator("#login-btn").waitFor();
    // The enrollment link works once.
    const again = await fetch(`${ORIGIN}/api/auth/enroll/options`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ token }) });
    expect((await again.json()).code).toBe("FLEET_ENROLLMENT_INVALID");
    await page.click("#login-btn");
    await page.locator("#login-code").waitFor({ state: "visible" });
    // The enrollment code's time step was used: a replay of it is refused; the next step's code works.
    await page.fill("#login-code", totp(totpSecret));
    await page.click("#login-totp-btn");
    await page.getByRole("alert").filter({ hasText: "Code refused" }).waitFor();
    await page.click("#login-btn");
    await page.locator("#login-code").waitFor({ state: "visible" });
    await page.fill("#login-code", totp(totpSecret, Date.now() + 30_000));
    await page.click("#login-totp-btn");
    await page.locator("#fig-cash").waitFor();
    const log = (await R.q(`SELECT event, ok FROM fleet.fleet_admin_auth_log ORDER BY seq`)).map((r) => `${r.event}:${r.ok}`);
    expect(log).toEqual(expect.arrayContaining(["enroll_issued:true", "passkey_added:true", "totp_set:true", "login:true", "totp:false", "totp:true"]));
  });

  it("shows the three Treasury figures separately and the replication trigger and gate as separate answers", async () => {
    // Fixture: the owner funded £10,000; Genesis allocated £200; the Fleet has contributed nothing yet.
    await page.goto(`${ORIGIN}/replication/`);
    await page.locator("#fig-fleet").waitFor();
    expect(await page.locator("#fig-cash").textContent()).toBe("£9,800.00");
    expect(await page.locator("#fig-owner").textContent()).toBe("£10,000.00");
    expect(await page.locator("#fig-fleet").textContent()).toBe("£0.00");
    expect(await page.locator("main").textContent()).toContain("Has the Fleet earned another agent?");
    expect(await page.locator("main").textContent()).toContain("Wealth threshold not yet met");
    expect(await page.locator('[data-gate="treasurySolvent"]').textContent()).toContain("ok");
  });

  it("agents and an agent page: agent-written text stays text; pause works", async () => {
    await page.goto(`${ORIGIN}/agents/`);
    await page.locator(`.open-agent[data-agent="${A.id}"]`).click();
    await page.getByRole("tab", { name: "Identity" }).waitFor();
    await page.getByText(`<img src=x onerror="window.__xss=1">`).waitFor();
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    expect(await page.locator("main img").count()).toBe(0);
    await page.getByRole("tab", { name: "Controls" }).click();
    await page.click("#act-hold");
    await waitToast(/Pause: done/);
    expect((await R.q(`SELECT operator_hold_at FROM fleet.fleet_agents WHERE agent_id = $1`, [A.id]))[0].operator_hold_at).not.toBeNull();
    await page.click("#act-release");
    await waitToast(/Resume: done/);
  });

  it("reveals an agent credential end to end: step-up passkey, broker-sealed, opened only in the browser, logged", async () => {
    const password = [...market.accounts.values()].find((a) => a.handle === "mayahart")!.password;
    await page.getByRole("tab", { name: "Credentials" }).click();
    await page.locator("[data-reveal]").first().click();
    await page.locator("#reveal-value").waitFor({ state: "visible", timeout: 30_000 });
    expect(await page.locator("#reveal-value").textContent()).toBe(password);
    await page.getByRole("button", { name: "Close" }).click();
    await page.locator("#reveal-value").waitFor({ state: "hidden" });
    // Nothing persisted: no storage holds it; the page source never had it.
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(stored).not.toContain(password);
    expect((await R.q(`SELECT outcome FROM fleet.fleet_reveal_log ORDER BY seq`)).map((r) => r.outcome)).toEqual(["requested", "served", "delivered"]);
    // The server only ever relayed sealed bytes: nothing stored or logged holds the password.
    const everything = JSON.stringify(await R.q(`SELECT (SELECT jsonb_agg(l) FROM fleet.fleet_admin_auth_log l) a, (SELECT jsonb_agg(r) FROM fleet.fleet_reveal_requests r) r,
      (SELECT jsonb_agg(detail) FROM fleet.fleet_events) e`));
    expect(everything).not.toContain(password);
  });

  it("uploads an owner fact sealed in the browser to the broker key, then reveals it", async () => {
    await page.goto(`${ORIGIN}/owner-vault/`);
    await expect.poll(async () => (await page.locator("#broker-fp").textContent()) ?? "", { timeout: 20_000 }).toMatch(/^[0-9a-f]{64}$/);
    await page.selectOption("#up-class", "legal_name");
    await page.fill("#up-text", "Test Owner Synthetic");
    await page.click("#up-btn");
    await waitToast(/Upload: done/);
    await expect.poll(async () => (await R.q(`SELECT status FROM fleet.fleet_owner_vault_inbox`))[0]?.status, { timeout: 20_000 }).toBe("installed");
    expect((await R.q(`SELECT sealed FROM fleet.fleet_owner_vault_inbox`))[0].sealed).toBeNull();
    await page.goto(`${ORIGIN}/owner-vault/`);
    await page.locator('.reveal-owner[data-class="legal_name"] [data-reveal]').click();
    await page.locator("#reveal-value").waitFor({ state: "visible", timeout: 30_000 });
    expect(await page.locator("#reveal-value").textContent()).toBe("Test Owner Synthetic");
    await page.getByRole("button", { name: "Close" }).click();
  });

  it("refuses: no session, no CSRF, no step-up, a replayed step-up, a foreign origin; the dashboard role is least-privilege", async () => {
    const cookies = await page.context().cookies();
    const c = cookies.find((x) => x.name === "fleet_session")!;
    const csrf = await page.evaluate(() => sessionStorage.getItem("fleet_csrf"));
    const callApi = (body: unknown, h: Record<string, string> = {}) => fetch(`${ORIGIN}/api/call`, { method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: `fleet_session=${c.value}`, ...h }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
    expect((await fetch(`${ORIGIN}/api/read?op=agents&args=%7B%7D`)).status).toBe(401);
    expect((await callApi({ op: "agent_hold", args: JSON.stringify({ agentId: A.id }) })).code).toBe("FLEET_CSRF");
    expect((await callApi({ op: "agent_kill", args: JSON.stringify({ agentId: A.id }) }, { "X-CSRF": csrf! })).code).toBe("FLEET_STEPUP_REQUIRED");
    expect((await callApi({ op: "agent_kill", args: JSON.stringify({ agentId: A.id }), stepup: "forged-step-up-token-0000000000000000000000" }, { "X-CSRF": csrf! })).code)
      .toBe("FLEET_STEPUP_REQUIRED");
    expect((await callApi({ op: "fleet_admin_birth", args: "{}" }, { "X-CSRF": csrf! })).code).toBe("FLEET_UNKNOWN_OP");
    // The static UI: strict hashed CSP (no unsafe-inline), no traversal, no dotfiles; Chrome reported no CSP violation.
    const html = await fetch(`${ORIGIN}/agents/`);
    const pol = html.headers.get("content-security-policy") ?? "";
    expect(pol).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+\/=]+'/);
    expect(pol).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect((await fetch(`${ORIGIN}/agents`, { redirect: "manual" })).status).toBe(308);
    for (const bad of ["/..%2f..%2fpackage.json", "/%2e%2e/%2e%2e/package.json", "/.next/", "/_next/../../package.json"]) {
      expect((await fetch(`${ORIGIN}${bad}`, { redirect: "manual" })).status, bad).toBe(404);
    }
    expect(cspViolations).toEqual([]);
    const foreign = await fetch(`${ORIGIN}/api/call`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example", Cookie: `fleet_session=${c.value}`, "X-CSRF": csrf! },
      body: JSON.stringify({ op: "agent_hold", args: "{}" }) });
    expect(foreign.status).toBe(403);
    // A step-up is single use: the stored step-ups have all been consumed.
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_admin_stepups WHERE used_at IS NULL`))[0].n).toBe(0);
    const dash = new pg.Pool({ connectionString: R.pgc.dashboardUrl, max: 1 });
    try {
      expect(await R.code(dash.query(`SELECT * FROM fleet.fleet_agent_account_credentials`))).toBe("permission denied");
      expect(await R.code(dash.query(`SELECT fleet.fleet_admin_birth('independent', 'x', 0, NULL, 'operator:owner', 'abcdefgh9')`))).toBe("permission denied");
    } finally { await dash.end(); }
    expect((await auditPrivileges(R.owner, { schema: "fleet", requireIdentityRoles: true, requireBrowserRoles: true, requireDashboardRoles: true })).problems).toEqual([]);
  });
});
