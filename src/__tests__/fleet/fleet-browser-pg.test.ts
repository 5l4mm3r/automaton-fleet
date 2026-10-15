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
import { browserUrlAllowed, HostResolutionPolicy, addressPrivate } from "../../fleet/browser/policy.js";
import { auditPrivileges } from "../../fleet/postgres/privileges.js";

const PG_BIN = findPgBin();
// R41.1: FLEET_TEST_CHROME runs the suite against a specific build (e.g. the pinned Chrome-for-Testing headless shell the
// production worker uses: scripts/fleet-browser-setup.sh).
const CHROME = [process.env.FLEET_TEST_CHROME ?? "", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => p && fs.existsSync(p)) ?? null;
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
  it("v79: a name that resolves to a loopback or private address is refused; the result is cached briefly", async () => {
    const dns: Record<string, string[]> = { "shop.example.com": ["93.184.216.34"], "rebind.example.com": ["127.0.0.1"], "mixed.example.com": ["93.184.216.34", "10.0.0.7"],
      "v6loop.example.com": ["::1"], "mapped.example.com": ["::ffff:127.0.0.1"], "cgnat.example.com": ["100.64.1.1"] };
    let lookups = 0;
    let now = 0;
    const p = new HostResolutionPolicy(async (h) => { lookups++; if (!dns[h]) throw new Error("ENOTFOUND"); return dns[h]; }, () => now);
    expect(await p.allowed("https://shop.example.com/listing")).toBe(true);
    for (const bad of ["https://rebind.example.com/", "https://mixed.example.com/", "https://v6loop.example.com/", "https://mapped.example.com/", "https://cgnat.example.com/",
      "https://nowhere.example.com/", "http://127.0.0.1:8787/"]) expect(await p.allowed(bad), bad).toBe(false);
    const n = lookups;
    expect(await p.allowed("https://shop.example.com/other")).toBe(true);
    expect(lookups).toBe(n); // cached
    now += 31_000;
    await p.allowed("https://shop.example.com/");
    expect(lookups).toBe(n + 1);
    expect(await p.allowed("data:text/html,x")).toBe(true);
    expect(await p.allowed("https://127.0.0.1:9443/", { allowLoopback: true })).toBe(true);
    for (const ip of ["127.0.0.1", "::1", "10.1.2.3", "169.254.169.254", "fd00::1", "::ffff:10.0.0.1"]) expect(addressPrivate(ip), ip).toBe(true);
    for (const ip of ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]) expect(addressPrivate(ip), ip).toBe(false);
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
      // v79: a listing editor with a photo upload, an embedded description editor (iframe), a CSV export, a preview popup
      // and a delete confirmation; a change-password form.
      if (u.pathname === "/listing/edit") return send(page("Edit listing", `<form id=f><label for=photo>Photos</label><input id=photo type=file multiple accept="image/*">
        <p id=picked>none</p><iframe name=desc srcdoc="<textarea id=body></textarea><p id=echo></p><script>document.getElementById('body').addEventListener('input',e=>document.getElementById('echo').textContent='desc:'+e.target.value)</script>"></iframe>
        <a id=csv href="/listing/export.csv" download>Download CSV</a> <a id=pv href="/listing/preview" target=_blank>Preview</a>
        <button type=button id=del>Delete draft</button><p id=deleted>kept</p><label><input type=checkbox id=news checked> newsletter</label></form>
        <script>document.getElementById('photo').addEventListener('change',e=>{document.getElementById('picked').textContent=[...e.target.files].map(f=>f.name+':'+f.size+':'+f.type).join(',')});
        document.getElementById('del').addEventListener('click',()=>{document.getElementById('deleted').textContent=confirm('Delete this draft?')?'deleted':'kept'});</script>`));
      if (u.pathname === "/listing/export.csv") { res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="listings.csv"' }); res.end("id,title,price\n1,Cash-flow workbook,12.00\n"); return; }
      if (u.pathname === "/listing/preview") return send(page("Listing preview", "<h1>Cash-flow workbook</h1><p>Preview as buyers see it</p>"));
      // v79: a JavaScript-rendered profile wizard (content arrives after load; a hidden file input behind a drop zone; a
      // button enabled only after validation) and a social composer (contenteditable editor, image attach, character count).
      if (u.pathname === "/studio/profile") return send(page("Profile setup", `<div id=app>Loading…</div><script>
        setTimeout(()=>{document.getElementById('app').innerHTML='<h2>Step 1 of 2: your shop</h2><input id=shop placeholder="Shop name"><textarea id=about placeholder="About"></textarea>'
          +'<div id=drop style="border:2px dashed #999;padding:20px">Drop your logo here<input id=logo type=file accept="image/png" style="display:none"></div><p id=logo-ok></p>'
          +'<button id=next disabled>Continue</button><p id=saved></p>';
          const v=()=>{document.getElementById('next').disabled=!(document.getElementById('shop').value.length>2&&document.getElementById('logo').files.length)};
          document.getElementById('shop').addEventListener('input',v);
          document.getElementById('logo').addEventListener('change',e=>{document.getElementById('logo-ok').textContent='logo '+e.target.files[0].name;v()});
          document.getElementById('next').addEventListener('click',()=>{document.getElementById('app').innerHTML='<h2>Step 2 of 2: done</h2><p>Profile saved for '+document.getElementById('shop').value+'</p>'});
        },400);</script>`));
      if (u.pathname === "/social/compose") return send(page("New post", `<div id=editor contenteditable=true style="min-height:60px;border:1px solid #ccc"></div><p id=count>0/280</p>
        <input id=media type=file accept="image/*"><button id=post>Post</button><p id=posted></p><script>
        const ed=document.getElementById('editor');ed.addEventListener('input',()=>{document.getElementById('count').textContent=ed.innerText.length+'/280'});
        document.getElementById('post').addEventListener('click',()=>{const f=document.getElementById('media').files[0];
          document.getElementById('posted').innerHTML='Posted: <a href="/social/p/42">view post</a> with '+(f?f.name:'no image')+' - '+ed.innerText.slice(0,40)});</script>`));
      if (u.pathname === "/account/password" && req.method === "GET") return send(page("Change password", `<form method=post action=/account/password><input id=cur name=cur type=password>
        <input id=new1 name=new1 type=password><input id=new2 name=new2 type=password><button>Change</button></form>`));
      if (u.pathname === "/account/password" && req.method === "POST") {
        const f = await form(req);
        const x = users.get(who ?? "");
        if (!x || x.password !== f.get("cur") || !f.get("new1") || f.get("new1") !== f.get("new2")) return send(page("Change password", "<p>Password not changed</p>"), 400);
        x.password = f.get("new1")!;
        return send(page("Password changed", "<p>Password changed</p>"));
      }
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

  it("v79 hands: the agent's own files uploaded, an embedded editor, a dialog, a download, a popup tab, a screenshot and its own design rendered", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f6b1c20000000049454e44ae426082", "hex");
    const logo = await ok(R.econ(A, "browser.stage_file", { fileName: "logo.png", contentType: "image/png", contentB64: png.toString("base64") }));
    const html = `<!doctype html><html><body style="margin:0"><div style="width:600px;height:300px;background:#123456;color:#fff;font:48px sans-serif">Ledgerline</div></body></html>`;
    const design = await ok(R.econ(A, "browser.stage_file", { fileName: "banner.html", contentType: "text/html", contentB64: Buffer.from(html).toString("base64") }));
    const o = await browse(A, "browser.open", { url: `${SITE}/listing/edit` });
    const sid = o.sessionId;
    const r = await browse(A, "browser.act", { sessionId: sid, steps: [
      { action: "upload_file", selector: "#photo", fileIds: [logo.fileId] },
      { action: "fill", selector: "#body", value: "Hand-made templates", frame: "iframe[name=desc]" },
      { action: "wait_for", selector: "#echo:has-text(\"desc:Hand-made templates\")", frame: "iframe[name=desc]" },
      { action: "dialog", accept: true }, { action: "click", selector: "#del" }, { action: "uncheck", selector: "#news" }, { action: "hover", text: "Preview" },
      { action: "scroll", to: "bottom" }, { action: "download", selector: "#csv" }] });
    expect(r.status, JSON.stringify(r.result)).toBe("done");
    expect(r.result.text).toContain(`logo.png:${png.length}:image/png`);
    expect(r.result.text).toContain("deleted");
    expect(r.result.lastDialog).toBe("confirm: Delete this draft?");
    const dl = r.result.files.find((f: any) => f.kind === "download");
    expect(dl).toMatchObject({ fileName: "listings.csv" });
    const got = await ok(R.econ(A, "browser.fetch_file", { fileId: dl.fileId }));
    expect(Buffer.from(got.contentB64, "base64").toString()).toContain("Cash-flow workbook,12.00");
    expect((await R.econ(B, "browser.fetch_file", { fileId: dl.fileId })).code).toBe("FLEET_NOT_FOUND");
    // A link that opens a new tab: it becomes the current tab; the agent can go back to the first.
    const t = await browse(A, "browser.act", { sessionId: sid, steps: [{ action: "click", selector: "#pv" }, { action: "wait_idle" }] });
    expect(t.result.title).toBe("Listing preview");
    expect(t.result.tabs).toHaveLength(2);
    const back = await browse(A, "browser.act", { sessionId: sid, steps: [{ action: "tab", index: 0 }, { action: "screenshot" }] });
    expect(back.result.title).toBe("Edit listing");
    const shot = await ok(R.econ(A, "browser.fetch_file", { fileId: back.result.files[0].fileId }));
    expect(Buffer.from(shot.contentB64, "base64").subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    // The agent's own design, rendered (a session without an account), then captured as an image and a PDF.
    const d = await browse(A, "browser.act", { sessionId: sid, steps: [{ action: "set_content", fileId: design.fileId }, { action: "screenshot", selector: "div" }, { action: "pdf" }] });
    expect(d.status, JSON.stringify(d.result)).toBe("done");
    expect(d.result.text).toContain("Ledgerline");
    const [img, pdf] = d.result.files;
    expect(img).toMatchObject({ kind: "screenshot" });
    const pdfBytes = Buffer.from((await ok(R.econ(A, "browser.fetch_file", { fileId: pdf.fileId }))).contentB64, "base64");
    expect(pdfBytes.subarray(0, 4).toString()).toBe("%PDF");
    // A name the agent invented: the worker never fetches a file that is not this agent's staged one.
    const forged = await browse(A, "browser.act", { sessionId: sid, steps: [{ action: "upload_file", selector: "#photo", fileId: crypto.randomUUID() }] });
    expect(forged.result.code).toBe("FLEET_BROWSER_FILE_UNAVAILABLE");
    await browse(A, "browser.close", { sessionId: sid });
  });

  it("v79 interfaces: a JavaScript profile wizard (dynamic content, hidden drop-zone input, validation) and a social composer (rich editor, image); the post recorded as presence", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f6b1c20000000049454e44ae426082", "hex");
    const logo = await ok(R.econ(A, "browser.stage_file", { fileName: "ledgerline-logo.png", contentType: "image/png", contentB64: png.toString("base64") }));
    const o = await browse(A, "browser.open", { url: `${SITE}/studio/profile` });
    const sid = o.sessionId;
    const w = await browse(A, "browser.act", { sessionId: sid, steps: [{ action: "wait_for", selector: "#shop" },
      { action: "fill", selector: "#shop", value: "Ledgerline" }, { action: "fill", selector: "#about", value: "Cash-flow tools for freelancers" },
      { action: "upload_file", selector: "#logo", fileId: logo.fileId }, { action: "wait_for", selector: "#next:not([disabled])" }, { action: "click", selector: "#next" },
      { action: "wait_for", selector: "text=Profile saved" }] });
    expect(w.status, JSON.stringify(w.result)).toBe("done");
    expect(w.result.text).toContain("Profile saved for Ledgerline");
    const c = await browse(A, "browser.act", { sessionId: sid, steps: [{ action: "goto", url: `${SITE}/social/compose` },
      { action: "fill", selector: "#editor", value: "New: a cash-flow workbook for freelancers" }, { action: "upload_file", selector: "#media", fileId: logo.fileId },
      { action: "click", selector: "#post" }] });
    expect(c.status, JSON.stringify(c.result)).toBe("done");
    expect(c.result.text, c.result.text).toContain("Posted: view post with ledgerline-logo.png - New: a cash-flow workbook for freelancer");
    expect(c.result.text).toMatch(/41\/280/);
    // The agent records what it published, with the browser action as evidence (its channel's rules recorded first).
    await ok(R.econ(A, "venture.create", { key: "ledgers", model: "digital_product", offer: "cash-flow tools", state: "selected" }));
    const ch = await ok(R.econ(A, "channel.add", { ventureKey: "ledgers", name: "Sim social", kind: "social", status: "active", rulesSource: `${SITE}/terms`.replace("http://", "https://"),
      rulesSummary: "Automated posting through the composer is allowed for business accounts; AI-generated posts must be labelled." }));
    const post = (c.result.links as Array<{ text: string; href: string }>).find((l) => l.text === "view post")!;
    const item = await ok(R.econ(A, "presence.record", { channelId: ch.channel.channelId, kind: "post", title: "Cash-flow workbook launch post", status: "live",
      url: post.href.replace("http://", "https://"), evidenceActionId: c.actionId ?? c.result.actionId ?? (await R.q(`SELECT action_id FROM fleet.fleet_browser_actions WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1`, [A.id]))[0].action_id }));
    expect(item.item).toMatchObject({ status: "live", kind: "post" });
    expect((await R.econ(B, "presence.record", { channelId: ch.channel.channelId, kind: "post", title: "x" })).code).toBe("FLEET_NOT_FOUND");
    await browse(A, "browser.close", { sessionId: sid });
  });

  it("v79: no image leaves a session that captured a secret; a password change is pending until the agent confirms the site accepted it", async () => {
    // sessionId captured the dashboard's API key earlier: a screenshot of that session is refused.
    const shot = await browse(A, "browser.act", { sessionId, steps: [{ action: "goto", url: `${SITE}/dashboard` }, { action: "screenshot" }] });
    expect(shot.result.code).toBe("FLEET_BROWSER_CAPTURE_REFUSED");
    const old = users.get("mayahart")!.password;
    await ok(R.econ(A, "account.mark", { accountId, status: "active", note: "back to normal" }));
    // A rejected change (the confirmation does not match): the site keeps the old password, and so does the vault.
    const bad = await browse(A, "browser.act", { sessionId, steps: [{ action: "goto", url: `${SITE}/account/password` }, { action: "fill", selector: "#cur", credential: "password" },
      { action: "fill", selector: "#new1", credential: "generate_password" }, { action: "fill", selector: "#new2", value: "something-else" }, { action: "click", text: "Change" }] });
    expect(bad.result.text).toContain("Password not changed");
    expect(users.get("mayahart")!.password).toBe(old);
    const creds = async () => (await R.q(`SELECT status FROM fleet.fleet_agent_account_credentials WHERE account_id = $1 AND kind = 'password' AND status IN ('active','pending') ORDER BY status`, [accountId])).map((x) => x.status);
    expect(await creds()).toEqual(["active", "pending"]);
    await ok(R.econ(A, "account.password_discard", { accountId }));
    expect(await creds()).toEqual(["active"]);
    // An accepted change: the new password (filled twice, never seen) is pending until confirmed; then it is the account's.
    const good = await browse(A, "browser.act", { sessionId, steps: [{ action: "goto", url: `${SITE}/account/password` }, { action: "fill", selector: "#cur", credential: "password" },
      { action: "fill", selector: "#new1", credential: "generate_password" }, { action: "fill", selector: "#new2", credential: "new_password" }, { action: "click", text: "Change" }] });
    expect(good.result.text, JSON.stringify(good.result)).toContain("Password changed");
    const now = users.get("mayahart")!.password;
    expect(now).not.toBe(old);
    expect(await creds()).toEqual(["active", "pending"]);
    await ok(R.econ(A, "account.password_confirm", { accountId }));
    expect(await creds()).toEqual(["active"]);
    const login = await browse(A, "browser.act", { sessionId, steps: [{ action: "goto", url: `${SITE}/login` }, { action: "fill", selector: "#user", credential: "username" },
      { action: "fill", selector: "#pass", credential: "password" }, { action: "click", text: "Log in" }, { action: "wait_for", selector: "#key" }] });
    expect(login.status, JSON.stringify(login.result)).toBe("done");
    expect(JSON.stringify(results)).not.toContain(now);
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
