/**
 * Schema v37 — the general browser / account operator with credential execution (PostgreSQL + the identity broker + a
 * REAL headless Chrome against a local HTTPS test site; no real website, account or identity).
 *
 * An agent signs up on a site no adapter knows: its username and email are filled by the broker, a strong password is
 * generated and stored in the vault, the verification email is opened from the withheld message, it logs in and captures
 * the API key the dashboard shows into its vault — and none of those secrets ever appears in anything the agent receives.
 * A page on another origin cannot get the password filled (origin pinning); a CAPTCHA is a human-only step for that
 * account; sessions are per agent; private addresses are unreachable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";
import https from "https";
import os from "os";
import path from "path";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { PgIdentityGateway } from "../../fleet/identity/gateway.js";
import { IdentityBroker } from "../../fleet/identity/broker.js";
import { SimulatedMailProvider } from "../../fleet/identity/providers.js";
import { initIdentityState, openIdentityState } from "../../fleet/identity/main.js";
import { PgBrowserGateway } from "../../fleet/browser/gateway.js";
import { BrowserWorker } from "../../fleet/browser/worker.js";
import { browserEnvProblems } from "../../fleet/browser/main.js";
import { browserUrlAllowed } from "../../fleet/browser/policy.js";
import { auditPrivileges } from "../../fleet/postgres/privileges.js";

const PG_BIN = findPgBin();
const CHROME = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => fs.existsSync(p)) ?? null;
const OPENSSL = fs.existsSync("/usr/bin/openssl");

describe("browser URL policy and worker startup (unit)", () => {
  it("public sites only; never the host, private networks or metadata", () => {
    for (const ok of ["https://example.com/signup", "http://shop.example.org/", "about:blank"]) expect(browserUrlAllowed(ok), ok).toBe(true);
    for (const bad of ["http://127.0.0.1:8787/", "http://localhost/", "http://10.0.0.5/", "http://169.254.169.254/latest/meta-data", "http://192.168.1.1/",
      "http://[::1]/", "http://[fd00::1]/", "file:///etc/passwd", "ftp://example.com/", "https://user:pw@example.com/", "http://metadata.google.internal/"]) {
      expect(browserUrlAllowed(bad), bad).toBe(false);
    }
    expect(browserUrlAllowed("https://127.0.0.1:9443/", { allowLoopback: true })).toBe(true);
  });
  it("the worker refuses root, foreign credentials and a missing browser", () => {
    const base = { FLEET_BROWSER_DATABASE_URL: "postgresql://fleet_browser_login:x@127.0.0.1/db", FLEET_BROWSER_EXECUTABLE: process.execPath };
    expect(browserEnvProblems(base, { uid: 1000, username: "u" })).toEqual([]);
    expect(browserEnvProblems(base, { uid: 0, username: "root" })).toContain("refusing to run as root (uid 0)");
    for (const k of ["FLEET_ADMIN_DATABASE_URL", "FLEET_IDENTITY_DATABASE_URL", "FLEET_CUSTODY_DATABASE_URL", "ANTHROPIC_API_KEY"]) {
      expect(browserEnvProblems({ ...base, [k]: "x" }, { uid: 1000, username: "u" }).join(), k).toMatch(new RegExp(k));
    }
    expect(browserEnvProblems({ ...base, FLEET_BROWSER_EXECUTABLE: "/nope" }, { uid: 1000, username: "u" }).join()).toMatch(/EXECUTABLE/);
  });
});

describe.skipIf(!PG_BIN || !CHROME || !OPENSSL)("v37 general browser operator with credential execution (PostgreSQL + Chrome)", { timeout: 120_000 }, () => {
  let R: EconomyRegistry;
  let A: Founder;
  let B: Founder;
  let dir: string;
  let igw: PgIdentityGateway;
  let bgw: PgBrowserGateway;
  let broker: IdentityBroker;
  let worker: BrowserWorker;
  let agentDb: pg.Pool;
  let site: https.Server;
  let phish: https.Server;
  let SITE = "";
  let PHISH = "";
  let loop: NodeJS.Timeout;
  const mail = new SimulatedMailProvider();
  const users = new Map<string, { email: string; password: string; verified: boolean }>();
  const tokens = new Map<string, string>();
  const API_KEY = `sk_live_${crypto.randomBytes(16).toString("hex")}`;
  const results: unknown[] = [];
  const ok = async (p: Promise<Record<string, any>>) => {
    const r = await p;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return r;
  };
  /** Enqueue a browser op as the agent and run the worker until its page result is back. */
  const browse = async (who: Founder, op: string, args: Record<string, unknown>) => {
    const q = await R.econ(who, op, args);
    if (!q.ok) return q;
    for (let i = 0; i < 200; i++) {
      await worker.tick(1);
      const r = await R.econ(who, "browser.result", { actionId: q.actionId });
      if (r.status === "done" || r.status === "failed") { results.push(r); return { ...r, sessionId: q.sessionId }; }
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error("browser action did not finish");
  };
  const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
  const form = (req: https.IncomingMessage): Promise<URLSearchParams> => new Promise((res) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => res(new URLSearchParams(d))); });

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-browser-"));
    fs.chmodSync(dir, 0o700);
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", path.join(dir, "key.pem"),
      "-out", path.join(dir, "cert.pem"), "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
    const tls = { key: fs.readFileSync(path.join(dir, "key.pem")), cert: fs.readFileSync(path.join(dir, "cert.pem")) };
    site = https.createServer(tls, async (req, res) => {
      const u = new URL(req.url ?? "/", SITE);
      const send = (html: string, status = 200, headers: Record<string, string> = {}) => { res.writeHead(status, { "Content-Type": "text/html", ...headers }); res.end(html); };
      const who = /sid=([a-z0-9]+)/.exec(req.headers.cookie ?? "")?.[1];
      if (u.pathname === "/signup" && req.method === "GET") return send(page("Sign up", `<form method=post action=/signup><label for=username>Username</label><input id=username name=username>
        <label for=email>Email</label><input id=email name=email type=email><label for=password>Password</label><input id=password name=password type=password>
        <p>By signing up you accept the <a href="/terms">seller terms</a>.</p><button type=submit>Create account</button></form>`));
      if (u.pathname === "/signup" && req.method === "POST") {
        const f = await form(req);
        users.set(f.get("username")!, { email: f.get("email")!, password: f.get("password")!, verified: false });
        const t = crypto.randomBytes(8).toString("hex");
        tokens.set(t, f.get("username")!);
        mail.deliver({ to: f.get("email")!, from: "noreply@sim-shop.test", subject: "Verify your email", body: `Welcome! Confirm here: ${SITE}/verify?t=${t}` });
        return send(page("Check your email", "<p>Check your email to verify your account.</p>"));
      }
      if (u.pathname === "/verify") {
        const name = tokens.get(u.searchParams.get("t") ?? "");
        if (name) users.get(name)!.verified = true;
        return send(page("Verified", name ? "<p>Email verified. You can log in.</p>" : "<p>Invalid link</p>"));
      }
      if (u.pathname === "/login" && req.method === "GET") return send(page("Log in", `<form method=post action=/login><input id=user name=user placeholder=Username>
        <input id=pass name=pass type=password placeholder=Password><button>Log in</button></form>`));
      if (u.pathname === "/login" && req.method === "POST") {
        const f = await form(req);
        const x = users.get(f.get("user") ?? "");
        if (x && x.verified && x.password === f.get("pass")) return send("", 302, { Location: "/dashboard", "Set-Cookie": `sid=${f.get("user")}; Secure; HttpOnly` });
        return send(page("Log in", "<p>Wrong credentials</p>"), 401);
      }
      if (u.pathname === "/dashboard") {
        if (!who || !users.get(who)) return send("", 302, { Location: "/login" });
        return send(page("Dashboard", `<h1>Shop dashboard</h1><p>Customer orders: 3 (Sam, 4 Example Road)</p><p>Your API key: <code id=key>${API_KEY}</code></p>`));
      }
      if (u.pathname === "/captcha") return send(page("Prove you are human", `<div class="g-recaptcha"></div><iframe src="about:blank#recaptcha"></iframe>`));
      return send(page("Not found", "nothing"), 404);
    });
    phish = https.createServer(tls, (_req, res) => { res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page("Session expired", `<input id=password type=password><button>Continue</button>`)); });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
    await new Promise<void>((r) => phish.listen(0, "127.0.0.1", () => r()));
    SITE = `https://127.0.0.1:${(site.address() as { port: number }).port}`;
    PHISH = `https://127.0.0.1:${(phish.address() as { port: number }).port}`;

    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000 });
    [A, B] = R.founders;
    initIdentityState(path.join(dir, "identity"));
    fs.chmodSync(path.join(dir, "identity"), 0o700);
    igw = new PgIdentityGateway({ connectionString: R.pgc.identityUrl });
    const { vault, ownerVault } = openIdentityState(path.join(dir, "identity"));
    broker = new IdentityBroker(igw, vault, { mail, ownerVault, stateFile: path.join(dir, "identity", "pending.json") });
    await broker.registerProviders(); // v41: the broker registers its providers (none = NOT CONFIGURED)
    bgw = new PgBrowserGateway({ connectionString: R.pgc.browserUrl });
    worker = new BrowserWorker(bgw, { executablePath: CHROME!, allowLoopback: true, ignoreHttpsErrors: true, brokerPublicKey: async () => (await bgw.brokerKey()).ownerPub });
    agentDb = new pg.Pool({ connectionString: R.pgc.agentUrl, max: 1 });
    // The broker runs alongside (it serves credential requests while the worker waits).
    let busy = false;
    loop = setInterval(() => { if (!busy) { busy = true; void broker.tick().catch(() => {}).finally(() => { busy = false; }); } }, 150);
    await ok(R.econ(A, "mailbox.provision", { localPart: "maya", idempotencyKey: `id:${crypto.randomUUID()}` }));
    for (let i = 0; i < 40 && !(await R.q(`SELECT 1 FROM fleet.fleet_agent_mailboxes`)).length; i++) await new Promise((r) => setTimeout(r, 100));
  }, 240_000);
  afterAll(async () => {
    clearInterval(loop);
    await worker?.close(); await bgw?.close(); await igw?.close(); await agentDb?.end(); await R?.close();
    site?.close(); phish?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  let accountId = "";
  let sessionId = "";

  it("signs up on an unknown site: username, email and a generated password filled by the broker; the email link opened from the withheld message", async () => {
    const box = (await R.q(`SELECT address FROM fleet.fleet_agent_mailboxes WHERE agent_id = $1`, [A.id]))[0].address;
    const reg = await ok(R.econ(A, "account.register", { platform: "sim-shop", kind: "storefront", handle: "mayahart", origin: SITE, loginEmail: box }));
    accountId = reg.accountId;
    const o = await browse(A, "browser.open", { url: `${SITE}/signup`, accountId });
    expect(o.status).toBe("done");
    sessionId = o.sessionId;
    expect(o.result.fields.map((f: any) => f.selector)).toEqual(expect.arrayContaining(["#username", "#email", "#password"]));
    expect(o.result.links.some((l: any) => l.text === "seller terms")).toBe(true);
    const s = await browse(A, "browser.act", { sessionId, steps: [
      { action: "fill", selector: "#username", credential: "username" }, { action: "fill", selector: "#email", credential: "email" },
      { action: "fill", selector: "#password", credential: "generate_password" }, { action: "click", text: "Create account" }] });
    expect(s.status, JSON.stringify(s.result)).toBe("done");
    expect(s.result.title).toBe("Check your email");
    const u = users.get("mayahart")!;
    expect(u.email).toBe(box);
    expect(u.password).toMatch(/^[A-Za-z0-9\-_.!#%+]{28}$/);
    // The password is the vault's credential for this account.
    const cred = (await R.q(`SELECT kind, status FROM fleet.fleet_agent_account_credentials WHERE account_id = $1`, [accountId]));
    expect(cred).toEqual([{ kind: "password", status: "active" }]);
    // The verification email is withheld from the agent; open_auth_link uses it.
    for (let i = 0; i < 30 && !(await R.q(`SELECT 1 FROM fleet.fleet_auth_message_blobs`)).length; i++) await new Promise((r) => setTimeout(r, 100));
    const inbox = (await ok(R.econ(A, "mail.inbox", {}))).messages;
    expect(inbox[0]).toMatchObject({ subject: "Verify your email", authenticationMessage: true });
    expect(JSON.stringify(inbox)).not.toMatch(/verify\?t=/);
    const v = await browse(A, "browser.act", { sessionId, steps: [{ action: "open_auth_link" }] });
    expect(v.status, JSON.stringify(v.result)).toBe("done");
    expect(v.result.text).toContain("Email verified");
    expect(v.result.url).toBe(`${SITE}/verify`); // no token in what the agent sees
    expect(u.verified).toBe(true);
  });

  it("logs in with vault credentials and captures the dashboard's API key into the vault; the agent sees the business data, never a secret", async () => {
    const r = await browse(A, "browser.act", { sessionId, steps: [
      { action: "goto", url: `${SITE}/login` }, { action: "fill", selector: "#user", credential: "username" }, { action: "fill", selector: "#pass", credential: "password" },
      { action: "click", text: "Log in" }, { action: "wait_for", selector: "#key" }, { action: "capture", selector: "#key", kind: "api_key" }] });
    expect(r.status, JSON.stringify(r.result)).toBe("done");
    expect(r.result.text).toContain("Customer orders: 3 (Sam, 4 Example Road)");
    expect(r.result.text).toContain("[credential]");
    const kinds = (await R.q(`SELECT kind FROM fleet.fleet_agent_account_credentials WHERE account_id = $1 AND status = 'active' ORDER BY kind`, [accountId])).map((x) => x.kind);
    expect(kinds).toEqual(["api_key", "password"]);
    await ok(R.econ(A, "account.mark", { accountId, status: "active", verification: "email_verified", note: "signed up and verified via browser" }));
    // Nothing the agent received — nor anything stored as text — contains a secret.
    const everything = JSON.stringify(results) + JSON.stringify(await R.q(`SELECT (SELECT jsonb_agg(result) FROM fleet.fleet_browser_actions) a,
      (SELECT jsonb_agg(steps) FROM fleet.fleet_browser_actions) s, (SELECT jsonb_agg(detail) FROM fleet.fleet_events) e, (SELECT jsonb_agg(m) FROM fleet.fleet_agent_mail m) m`));
    expect(everything).not.toContain(users.get("mayahart")!.password);
    expect(everything).not.toContain(API_KEY);
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_browser_secret_requests WHERE sealed IS NOT NULL OR sealed_in IS NOT NULL`))[0].n).toBe(0);
  });

  it("origin pinning: another origin cannot get the password filled; a CAPTCHA is a human step for that account only", async () => {
    const p = await browse(A, "browser.act", { sessionId, steps: [{ action: "goto", url: PHISH }, { action: "fill", selector: "#password", credential: "password" }] });
    expect(p.status).toBe("failed");
    expect(p.result.code).toBe("FLEET_ORIGIN_NOT_PINNED");
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_events WHERE event_type = 'browser_credential_refused'`))[0].n).toBe(1);
    const c = await browse(A, "browser.act", { sessionId, steps: [{ action: "goto", url: `${SITE}/captcha` }] });
    expect(c.result.captcha).toBe(true);
    await ok(R.econ(A, "account.mark", { accountId, status: "human_action_required", note: "reCAPTCHA on the payout settings page" }));
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_owner_requests WHERE kind = 'human_identity' AND status = 'pending'`))[0].n).toBe(1);
    expect(await ok(R.econ(A, "venture.list", {}))).toMatchObject({ ok: true }); // everything else continues
  });

  it("scope and reach: sessions are per agent; private addresses are unreachable; roles are least-privilege", async () => {
    expect((await R.econ(B, "browser.act", { sessionId, steps: [{ action: "goto", url: SITE }] })).code).toBe("FLEET_BROWSER_NONE");
    expect((await R.econ(B, "browser.open", { url: SITE, accountId })).code).toBe("FLEET_NOT_FOUND");
    const x = await browse(A, "browser.act", { sessionId, steps: [{ action: "goto", url: "http://10.11.12.13/admin" }] });
    expect(x.result.code).toBe("FLEET_BROWSER_URL_BLOCKED");
    expect((await R.econ(A, "browser.act", { sessionId, steps: [{ action: "fill", selector: "#a", credential: "password", value: "x" }] })).code).toBe("FLEET_BAD_REQUEST");
    await browse(A, "browser.close", { sessionId });
    expect((await R.econ(A, "browser.observe", { sessionId })).code).toBe("FLEET_BROWSER_CLOSED");
    const bx = new pg.Pool({ connectionString: R.pgc.browserUrl, max: 1 });
    try {
      expect(await R.code(bx.query(`SELECT * FROM fleet.fleet_agent_account_credentials`))).toBe("permission denied");
      expect(await R.code(bx.query(`SELECT fleet.ix_browser_secrets_pending('x')`))).toBe("permission denied");
    } finally { await bx.end(); }
    expect((await auditPrivileges(R.owner, { schema: "fleet", requireIdentityRoles: true, requireBrowserRoles: true })).problems).toEqual([]);
  });
});
