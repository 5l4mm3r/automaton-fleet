/**
 * The Admin control centre UI (schema v38): one HTML shell, one script, one stylesheet — no framework, no CDN, no inline
 * script or style (strict CSP). Every value from the registry is rendered with textContent (agent-written names, mail
 * subjects and notes can never become markup). Reveals and owner-identity uploads are sealed/opened HERE, in the Admin's
 * browser, with WebCrypto (X25519 + HKDF-SHA256 + AES-GCM, the broker's FSB1 format): the server relays sealed bytes only.
 */

export const INDEX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Automaton Fleet — Admin</title><link rel="stylesheet" href="/app.css"></head>
<body><header><h1>Automaton Fleet</h1><nav id="nav" hidden></nav><button id="logout" hidden>Sign out</button></header>
<main id="main"><p>Loading…</p></main><div id="toast" role="status" hidden></div>
<div id="modal" hidden><div class="box"><h2 id="modal-title"></h2><pre id="reveal-value"></pre><p id="modal-note"></p>
<button id="modal-copy">Copy</button> <button id="modal-close">Close</button></div></div>
<script src="/app.js"></script></body></html>`;

export const APP_CSS = `
:root{--bg:#f6f7f9;--fg:#15181d;--muted:#5b6370;--card:#fff;--line:#dfe3e8;--accent:#1b5fd6;--red:#b42318;--amber:#b54708;--green:#067647}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e8eaee;--muted:#9aa3ae;--card:#171a20;--line:#2a2f37;--accent:#6aa0ff;--red:#f97066;--amber:#fdb022;--green:#47cd89}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;gap:16px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line);background:var(--card);position:sticky;top:0;z-index:2;flex-wrap:wrap}
h1{font-size:16px;margin:0}nav{display:flex;gap:4px;flex-wrap:wrap;flex:1}nav button{background:none;border:0;padding:6px 10px;border-radius:6px;color:var(--fg);cursor:pointer}
nav button.on{background:var(--accent);color:#fff}main{padding:16px;max-width:1200px;margin:0 auto}
section.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:0 0 14px}section.card h2{font-size:15px;margin:0 0 10px}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid var(--line);padding:5px 6px;text-align:left;vertical-align:top;word-break:break-word}
th{color:var(--muted);font-weight:600}table.kv th{width:28%}button,input,select,textarea{font:inherit}button{padding:6px 12px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.danger{border-color:var(--red);color:var(--red)}
input,select,textarea{padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);max-width:100%}
form.inline{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}.muted{color:var(--muted)}.RED{color:var(--red);font-weight:600}.AMBER{color:var(--amber);font-weight:600}
.IDENTITY{color:var(--accent);font-weight:600}.DAILY{color:var(--green)}#toast{position:fixed;bottom:16px;right:16px;background:var(--fg);color:var(--bg);padding:10px 14px;border-radius:8px;max-width:420px}
#modal{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:5}#modal[hidden]{display:none}
#modal .box{background:var(--card);padding:18px;border-radius:10px;max-width:90vw;min-width:320px}#reveal-value{white-space:pre-wrap;word-break:break-all;background:var(--bg);padding:10px;border-radius:6px;max-height:50vh;overflow:auto}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}pre.json{white-space:pre-wrap;font-size:12px;margin:0}
`;

export const APP_JS = `"use strict";
(() => {
const SENSITIVE = new Set(["reveal_request","owner_vault_upload","owner_identity_consent_set","owner_identity_consent_revoke","owner_identity_class_set","agent_transfer",
  "wallet_transfer","agent_fund","owner_withdrawal","agent_kill","birth","reseed","estate_assign","estate_release","replication_policy","mission_policy","risk_policy",
  "notification_policy","genesis_capital","passkey_revoke","totp_reset","session_revoke_all"]);
const $ = (id) => document.getElementById(id);
const S = { csrf: null, view: "overview", agent: null };
try { S.csrf = sessionStorage.getItem("fleet_csrf"); } catch {}

// ── DOM helpers: values only ever go through textContent ──
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else if (k === "text") e.textContent = String(v); else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}
const money = (m) => (m === null || m === undefined || m === "") ? "—" : "£" + (Number(m) / 100).toFixed(2);
function kv(obj) {
  if (obj === null || obj === undefined) return el("span", { class: "muted", text: "—" });
  if (typeof obj !== "object") return document.createTextNode(String(obj));
  if (Array.isArray(obj)) {
    if (!obj.length) return el("span", { class: "muted", text: "none" });
    if (obj.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
      const cols = [...new Set(obj.flatMap((x) => Object.keys(x)))].slice(0, 12);
      return el("table", {}, el("tr", {}, cols.map((c) => el("th", { text: c }))),
        obj.slice(0, 300).map((r) => el("tr", {}, cols.map((c) => el("td", {}, typeof r[c] === "object" && r[c] !== null ? el("pre", { class: "json", text: JSON.stringify(r[c], null, 1) }) : String(r[c] ?? ""))))));
    }
    return el("pre", { class: "json", text: JSON.stringify(obj, null, 1) });
  }
  return el("table", { class: "kv" }, Object.entries(obj).map(([k, v]) => el("tr", {}, el("th", { text: k }), el("td", {}, kv(v)))));
}
const card = (title, ...kids) => el("section", { class: "card" }, el("h2", { text: title }), ...kids);
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 6000); }

// ── base64url / WebAuthn JSON ──
const b64u = { enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, ""),
  dec: (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)).buffer };
const b64 = { enc: (buf) => { let s = ""; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); },
  dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) };
async function passkeyCreate(o) {
  const pk = { ...o, challenge: b64u.dec(o.challenge), user: { ...o.user, id: b64u.dec(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64u.dec(c.id) })) };
  const c = await navigator.credentials.create({ publicKey: pk });
  return { id: c.id, rawId: b64u.enc(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults(), authenticatorAttachment: c.authenticatorAttachment || undefined,
    response: { clientDataJSON: b64u.enc(c.response.clientDataJSON), attestationObject: b64u.enc(c.response.attestationObject),
      transports: c.response.getTransports ? c.response.getTransports() : [] } };
}
async function passkeyGet(o) {
  const pk = { ...o, challenge: b64u.dec(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: b64u.dec(c.id) })) };
  const c = await navigator.credentials.get({ publicKey: pk });
  return { id: c.id, rawId: b64u.enc(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults(), authenticatorAttachment: c.authenticatorAttachment || undefined,
    response: { clientDataJSON: b64u.enc(c.response.clientDataJSON), authenticatorData: b64u.enc(c.response.authenticatorData),
      signature: b64u.enc(c.response.signature), userHandle: c.response.userHandle ? b64u.enc(c.response.userHandle) : undefined } };
}

// ── API ──
async function post(path, body) {
  const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", ...(S.csrf ? { "X-CSRF": S.csrf } : {}) }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({ ok: false, code: "FLEET_BAD_RESPONSE" }));
  if (r.status === 401 && !path.startsWith("/api/auth/")) { boot(); throw new Error("signed out"); }
  return j;
}
async function read(op, args) {
  const r = await fetch("/api/read?op=" + encodeURIComponent(op) + "&args=" + encodeURIComponent(JSON.stringify(args || {})), { credentials: "same-origin" });
  const j = await r.json().catch(() => ({ ok: false, code: "FLEET_BAD_RESPONSE" }));
  if (r.status === 401) { boot(); throw new Error("signed out"); }
  if (!j.ok) throw new Error(j.code || "error");
  return j.result;
}
async function call(op, args) {
  const a = JSON.stringify(args || {});
  let stepup;
  if (SENSITIVE.has(op)) {
    const o = await post("/api/stepup/options", { op, args: a });
    if (!o.ok) throw new Error(o.code);
    const v = await post("/api/stepup/verify", { op, args: a, response: await passkeyGet(o.options) });
    if (!v.ok) throw new Error(v.code);
    stepup = v.stepup;
  }
  const r = await post("/api/call", { op, args: a, stepup });
  if (!r.ok) throw new Error((r.code || "error") + (r.reason ? ": " + r.reason : ""));
  return r.result;
}
async function act(label, fn) { try { const r = await fn(); toast(label + ": done"); return r; } catch (e) { toast(label + " failed — " + e.message); } }

// ── sealed boxes (FSB1), in the browser ──
const te = new TextEncoder(), td = new TextDecoder();
const cat = (...a) => { const n = a.reduce((s, x) => s + x.byteLength, 0); const o = new Uint8Array(n); let i = 0; for (const x of a) { o.set(new Uint8Array(x), i); i += x.byteLength; } return o; };
async function hkdf(shared, salt) {
  const k = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  return crypto.subtle.importKey("raw", await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: te.encode("fleet-owner-identity-v1") }, k, 256), "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function sealTo(recipientSpki, plaintext, scope) {
  const eph = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const ephPub = new Uint8Array(await crypto.subtle.exportKey("spki", eph.publicKey));
  const rec = await crypto.subtle.importKey("spki", recipientSpki, { name: "X25519" }, false, []);
  const key = await hkdf(await crypto.subtle.deriveBits({ name: "X25519", public: rec }, eph.privateKey, 256), cat(ephPub, recipientSpki));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(scope) }, key, te.encode(plaintext)));
  const len = new Uint8Array([ephPub.length >> 8, ephPub.length & 255]);
  return cat(te.encode("FSB1"), len, ephPub, te.encode("FIV1"), iv, ct.subarray(ct.length - 16), ct.subarray(0, ct.length - 16));
}
async function openSealed(kp, myPubSpki, blob, scope) {
  if (td.decode(blob.subarray(0, 4)) !== "FSB1") throw new Error("not sealed");
  const n = (blob[4] << 8) | blob[5];
  const ephPub = blob.subarray(6, 6 + n), rest = blob.subarray(6 + n);
  const eph = await crypto.subtle.importKey("spki", ephPub, { name: "X25519" }, false, []);
  const key = await hkdf(await crypto.subtle.deriveBits({ name: "X25519", public: eph }, kp.privateKey, 256), cat(ephPub, myPubSpki));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: rest.subarray(4, 16), additionalData: te.encode(scope) }, key, cat(rest.subarray(32), rest.subarray(16, 32)));
  return td.decode(pt);
}
async function reveal(kind, target, title) {
  const kp = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
  const r = await call("reveal_request", { kind, target, ephemeralPub: b64.enc(pub) });
  for (let i = 0; i < 60; i++) {
    await new Promise((res) => setTimeout(res, i < 4 ? 500 : 1500));
    const t = await call("reveal_take", { requestId: r.requestId });
    if (t && t.ok && t.status === "delivered") {
      const value = await openSealed(kp, pub, b64.dec(t.sealedB64), "reveal:" + r.requestId);
      showSecret(title, value);
      return;
    }
    if (t && t.ok === false) throw new Error(t.code);
  }
  throw new Error("the identity broker did not serve the reveal");
}
function showSecret(title, value) {
  $("modal-title").textContent = title;
  let shown = value;
  try { const j = JSON.parse(value); if (j && j.dataB64 && j.contentType) shown = "[" + j.contentType + " document, " + Math.round(j.dataB64.length * 0.75 / 1024) + " kB]"; } catch {}
  $("reveal-value").textContent = shown;
  $("modal-note").textContent = "Shown for 60 seconds; never stored by this page.";
  $("modal").hidden = false;
  $("modal-copy").onclick = () => navigator.clipboard && navigator.clipboard.writeText(value);
  clearTimeout(showSecret.t);
  showSecret.t = setTimeout(closeModal, 60000);
}
function closeModal() { $("reveal-value").textContent = ""; $("modal").hidden = true; }
$("modal-close").onclick = closeModal;

// ── authentication screens ──
async function boot() {
  const st = await (await fetch("/api/auth/state", { credentials: "same-origin" })).json();
  const enroll = /^#enroll=([A-Za-z0-9_-]{20,})$/.exec(location.hash);
  if (st.session === "full" && S.csrf) return shell();
  $("nav").hidden = true; $("logout").hidden = true;
  const m = $("main"); m.replaceChildren();
  if (enroll) return enrollScreen(enroll[1]);
  if (!st.enrolled) return m.append(card("Not enrolled", el("p", { text: "Run fleet:admin hub-dashboard-enroll on the server and open the link it prints." })));
  if (st.locked) return m.append(card("Locked", el("p", { text: "Too many failed attempts. Try again in 15 minutes." })));
  const code = el("input", { id: "login-code", inputmode: "numeric", autocomplete: "one-time-code", placeholder: "6-digit code", maxlength: 6 });
  const step2 = el("form", { class: "inline", hidden: true, onsubmit: async (e) => { e.preventDefault();
    const r = await post("/api/auth/login/totp", { code: code.value.trim() });
    if (!r.ok) return toast("Code refused"); shell(); } }, code, el("button", { id: "login-totp-btn", class: "primary", text: "Verify" }));
  m.append(card("Sign in", el("p", { class: "muted", text: "Passkey, then your authenticator code." }),
    el("button", { id: "login-btn", class: "primary", onclick: async () => {
      try {
        const o = await post("/api/auth/login/options", {});
        if (!o.ok) return toast(o.code);
        const v = await post("/api/auth/login/verify", { response: await passkeyGet(o.options) });
        if (!v.ok) return toast("Passkey refused");
        S.csrf = v.csrf; try { sessionStorage.setItem("fleet_csrf", v.csrf); } catch {}
        step2.hidden = false; code.focus();
      } catch (e) { toast("Passkey failed — " + e.message); }
    } }, "Sign in with passkey"), step2));
}
function enrollScreen(token) {
  const m = $("main");
  const code = el("input", { id: "totp-code", inputmode: "numeric", placeholder: "6-digit code", maxlength: 6 });
  const totpBox = el("div", { hidden: true }, el("p", { text: "Add this secret to your authenticator app, then enter the current code:" }),
    el("pre", { id: "totp-secret" }), el("pre", { id: "totp-uri", class: "muted" }),
    el("form", { class: "inline", onsubmit: async (e) => { e.preventDefault();
      const r = await post("/api/auth/enroll/totp", { code: code.value.trim() });
      if (!r.ok) return toast("Code refused"); history.replaceState(null, "", "/"); toast("Enrolled. Sign in now."); boot(); } },
      code, el("button", { id: "totp-confirm", class: "primary", text: "Confirm" })));
  const name = el("input", { id: "pk-name", value: "owner device" });
  m.append(card("Enroll an Admin passkey", el("p", { class: "muted", text: "One-time enrollment link. Your device creates a passkey; then you set up your authenticator code." }),
    el("form", { class: "inline", onsubmit: (e) => e.preventDefault() }, name, el("button", { id: "enroll-btn", class: "primary", onclick: async () => {
      try {
        const o = await post("/api/auth/enroll/options", { token });
        if (!o.ok) return toast(o.code);
        const v = await post("/api/auth/enroll/verify", { token, name: name.value, response: await passkeyCreate(o.options) });
        if (!v.ok) return toast(v.code);
        if (v.next === "totp") { $("totp-secret").textContent = v.totpSecret; $("totp-uri").textContent = v.otpauth; totpBox.hidden = false; }
        else { history.replaceState(null, "", "/"); toast("Passkey added. Sign in."); boot(); }
      } catch (e) { toast("Enrollment failed — " + e.message); }
    } }, "Register passkey")), totpBox));
}

// ── the control centre ──
const VIEWS = { overview: "Overview", agents: "Agents", treasury: "Treasury", replication: "Replication & births", missions: "Missions", estates: "Estates",
  owner: "Owner identity", notifications: "Notifications", security: "Security" };
function shell() {
  const nav = $("nav"); nav.replaceChildren(); nav.hidden = false; $("logout").hidden = false;
  for (const [k, v] of Object.entries(VIEWS)) nav.append(el("button", { id: "nav-" + k, class: S.view === k ? "on" : "", onclick: () => { S.view = k; S.agent = null; shell(); } }, v));
  $("logout").onclick = async () => { await post("/api/auth/logout", {}); S.csrf = null; try { sessionStorage.removeItem("fleet_csrf"); } catch {} boot(); };
  render().catch((e) => toast(e.message));
}
async function render() {
  const m = $("main"); m.replaceChildren(el("p", { class: "muted", text: "Loading…" }));
  const parts = S.agent ? await agentView(S.agent) : await ({ overview, agents, treasury, replication, missions, estates, owner, notifications, security })[S.view]();
  m.replaceChildren(...parts);
}
const form = (fields, label, onsubmit, cls) => {
  const inputs = fields.map(([name, ph, type]) => type === "select" ? el("select", { name }, ph.map((o) => el("option", { value: o, text: o })))
    : el("input", { name, placeholder: ph, type: type || "text" }));
  return el("form", { class: "inline", onsubmit: async (e) => { e.preventDefault(); const v = Object.fromEntries(inputs.map((i) => [i.name, i.type === "checkbox" ? i.checked : i.value.trim()])); await onsubmit(v); } },
    inputs, el("button", { class: cls || "primary", text: label }));
};
async function overview() {
  const [daily, health, engine] = await Promise.all([read("daily_report"), read("health"), read("engine")]);
  return [el("div", { class: "grid" }, card("Treasury", kv(daily.treasury)), card("Last 24 hours", kv(daily.flows)), card("Replication", kv(daily.replication)),
    card("Alerts (24 h)", kv(daily.alerts24h || {}))), card("Agents", kv(daily.agents)), card("Health", kv(health.findings)),
    card("Unacknowledged notifications", kv(engine.notifications.unacknowledged || {})), card("Genesis capital", kv(engine.genesisCapital))];
}
async function agents() {
  const list = await read("agents");
  return [card("Agents", el("table", {}, el("tr", {}, ["Agent", "Name", "Status", "Mode", "Cash", "Value", "Held", ""].map((h) => el("th", { text: h }))),
    list.map((a) => el("tr", {}, el("td", { text: a.agentId }), el("td", { text: a.name }), el("td", { text: a.status }), el("td", { text: a.mode }),
      el("td", { text: money(a.cashMinor) }), el("td", { text: money(a.valueMinor) }), el("td", { text: a.held ? "paused" : "" }),
      el("td", {}, el("button", { class: "open-agent", "data-agent": a.agentId, onclick: () => { S.agent = a.agentId; render(); } }, "Open"))))))];
}
async function agentView(id) {
  const [ident, comms, wallet, risk, events, browser] = await Promise.all([read("identity", { agentId: id }), read("comms", { agentId: id }),
    read("wallet", { agentId: id }).catch(() => null), read("risk", { agentId: id }).catch(() => null), read("agent_events", { agentId: id }), read("browser", { agentId: id })]);
  const creds = el("table", {}, el("tr", {}, ["Platform", "Handle", "Kind", "Created", ""].map((h) => el("th", { text: h }))),
    (comms.credentials || []).map((c) => el("tr", {}, el("td", { text: c.platform }), el("td", { text: c.handle || "" }), el("td", { text: c.kind }), el("td", { text: c.createdAt }),
      el("td", {}, el("button", { class: "reveal-btn", "data-credential": c.credentialId, onclick: () => act("Reveal", () => reveal("agent_credential", c.credentialId, c.platform + " " + c.kind)) }, "Reveal")))));
  return [el("p", {}, el("button", { onclick: () => { S.agent = null; render(); } }, "← Agents")),
    card("Agent " + id, el("div", { class: "inline" },
      el("button", { id: "act-hold", onclick: () => act("Pause", () => call("agent_hold", { agentId: id, reason: "paused from dashboard" })) }, "Pause"), " ",
      el("button", { id: "act-release", onclick: () => act("Resume", () => call("agent_release", { agentId: id })) }, "Resume"), " ",
      el("button", { id: "act-kill", class: "danger", onclick: () => confirm("Kill this agent? Its estate is kept.") && act("Kill", () => call("agent_kill", { agentId: id, reason: "killed from dashboard" })) }, "Kill")),
      form([["amountMinor", "amount (pence)"], ["reason", "reason"]], "Fund from Treasury", (v) => act("Fund", () => call("agent_fund", { agentId: id, amountMinor: Number(v.amountMinor), mode: "grant", reason: v.reason, acknowledge: true }))),
      form([["to", "to agent id"], ["amountMinor", "amount (pence)"], ["reason", "reason"]], "Transfer to agent", (v) => act("Transfer", () => call("agent_transfer", { from: id, to: v.to, amountMinor: Number(v.amountMinor), reason: v.reason, acknowledge: true }))),
      form([["amountMinor", "amount (pence)"], ["reason", "reason"]], "Move to Treasury", (v) => act("Treasury transfer", () => call("wallet_transfer", { agentId: id, amountMinor: Number(v.amountMinor), target: "treasury", reason: v.reason, acknowledge: true }))),
      form([["kind", ["marketing", "opportunity_hunt", "knowledge_data"], "select"], ["brief", "mission brief"]], "Assign mission", (v) => act("Mission", () => call("mission_assign", { agentId: id, kind: v.kind, brief: v.brief })), "")),
    el("div", { class: "grid" }, card("Economics", kv(risk)), card("Wallet", kv(wallet))),
    card("Personas, brands and venture identities", kv(((ident.agents || [])[0] || {}).identities || [])), card("Accounts", kv(((ident.agents || [])[0] || {}).accounts || [])),
    card("Credentials", creds), card("Mailboxes", kv(comms.mailboxes)), card("Phone numbers", kv(comms.numbers)),
    card("Browser sessions", kv(browser.sessions)), card("Activity", kv(events))];
}
async function treasury() {
  const [t, w] = await Promise.all([read("hub", { section: "treasury" }), read("withdrawals")]);
  return [card("Treasury", kv(t)), card("Withdrawal advice and history", kv(w)),
    card("Withdraw to the owner (PayPal destination)", el("p", { class: "muted", text: "Strong authentication: your passkey confirms. Real payouts run only when live payments are enabled." }),
      form([["amountMinor", "amount (pence)"], ["destination", "destination id"], ["reason", "reason"]], "Withdraw",
        (v) => act("Withdrawal", () => call("owner_withdrawal", { amountMinor: Number(v.amountMinor), destination: v.destination, reason: v.reason, acknowledge: true })))),
    card("Genesis capital", form([["minor", "minor units (e.g. 10000 = £100)"]], "Set", (v) => act("Genesis capital", () => call("genesis_capital", { currency: "GBP", minor: Number(v.minor) }))))];
}
async function replication() {
  const r = await read("replication");
  return [card("Replication", kv({ phase: r.state.phase, pendingSince: r.state.pending_since, thresholdsConsumed: r.state.thresholds_consumed,
      highWater: money(r.state.high_water_minor), nextThresholds: (r.nextThresholds || []).map(money).join(", "), registrySwitch: r.registrySwitch, autoBirth: r.policy.auto_birth_enabled })),
    card("Health window", kv(r.health.conditions)), card("Fleet-generated wealth", kv(r.health.wealth)),
    card("Manual birth", form([["mission", ["independent", "marketing", "opportunity_hunt", "knowledge_data", "other"], "select"], ["fundingMinor", "funding (pence)"], ["reason", "reason"]],
      "Birth agent", (v) => act("Birth", () => call("birth", { mission: v.mission, fundingMinor: Number(v.fundingMinor || 0), reason: v.reason })))),
    card("Reseed from a dead agent's estate", form([["deadAgentId", "dead agent id"], ["fundingMinor", "funding (pence)"], ["reason", "reason"]], "Reseed",
      (v) => act("Reseed", () => call("reseed", { deadAgentId: v.deadAgentId, fundingMinor: Number(v.fundingMinor || 0), reason: v.reason })))),
    card("Birth orders", kv(r.births)),
    card("Policy", kv(r.policy), form([["patch", '{"autoBirthEnabled": false}']], "Update policy", (v) => act("Policy", () => call("replication_policy", { patch: JSON.parse(v.patch) }))))];
}
async function missions() {
  const e = await read("engine");
  return [card("Active missions", kv(e.missions.active)), card("Open requests", kv(e.missions.openRequests)), card("Policy", kv(e.missions.policy)),
    card("Request Fleet work", form([["kind", ["marketing", "opportunity_hunt", "knowledge_data"], "select"], ["brief", "brief"]], "Request",
      (v) => act("Request", () => call("mission_request", { kind: v.kind, brief: v.brief }))))];
}
async function estates() {
  const e = await read("estates");
  return [card("Estate storage", kv({ policy: e.policy, heldBytes: e.heldBytes, byStatus: e.byStatus })),
    card("Items", el("table", {}, el("tr", {}, ["Kind", "Title", "Value", "Status", "Assign to", ""].map((h) => el("th", { text: h }))),
      (e.items || []).map((i) => { const to = el("input", { placeholder: "agent id" });
        return el("tr", {}, el("td", { text: i.kind }), el("td", { text: i.title }), el("td", { text: i.value_score }), el("td", { text: i.status }), el("td", {}, to),
          el("td", {}, el("button", { onclick: () => act("Assign", () => call("estate_assign", { itemId: i.item_id, agentId: to.value.trim() })) }, "Assign"), " ",
            el("button", { onclick: () => act("Release", () => call("estate_release", { itemId: i.item_id, reason: "released by Admin" })) }, "Release"))); })))];
}
async function owner() {
  const [id, comms, key] = await Promise.all([read("identity"), read("comms"), read("broker_key")]);
  const cls = el("select", { id: "up-class" }, ["legal_name", "date_of_birth", "residential_address", "contact_email", "contact_phone", "passport", "driving_licence",
    "id_document", "proof_of_address", "tax_identifier", "bank_account_owner", "other_fact"].map((c) => el("option", { value: c, text: c })));
  const text = el("input", { id: "up-text", placeholder: "text value (or choose a file)" });
  const file = el("input", { id: "up-file", type: "file", accept: "application/pdf,image/jpeg,image/png,image/webp" });
  const exp = el("input", { id: "up-expires", type: "date" });
  return [card("Owner identity vault",
      el("p", { class: "muted", text: "Values are sealed in this browser to the identity broker's key and installed by the broker. Agents never receive them." }),
      el("p", {}, "Broker key fingerprint: ", el("code", { id: "broker-fp", text: key.fingerprint || "not published (is the broker running?)" })),
      el("form", { class: "inline", onsubmit: async (e) => { e.preventDefault();
        if (!key.ownerPub) return toast("The broker key is not published");
        let value, contentType = "text/plain";
        if (file.files && file.files[0]) { const f = file.files[0]; contentType = f.type; value = JSON.stringify({ contentType, dataB64: b64.enc(await f.arrayBuffer()) }); }
        else value = text.value;
        if (!value) return toast("Nothing to upload");
        const sealed = await sealTo(b64.dec(key.ownerPub), value, "owner:" + cls.value);
        text.value = ""; file.value = "";
        await act("Upload", () => call("owner_vault_upload", { class: cls.value, sealedB64: b64.enc(sealed), contentType, expiresAt: exp.value || null }));
      } }, cls, text, file, exp, el("button", { id: "up-btn", class: "primary", text: "Encrypt & upload" }))),
    card("Classes in the vault", el("table", {}, el("tr", {}, ["Class", "Status", "Expires", ""].map((h) => el("th", { text: h }))),
      (comms.ownerVault || []).map((c) => el("tr", {}, el("td", { text: c.class_key }), el("td", { text: c.status }), el("td", { text: c.expires_at || "" }),
        el("td", {}, el("button", { class: "reveal-owner", "data-class": c.class_key, onclick: () => act("Reveal", () => reveal("owner_identity", c.class_key, c.class_key)) }, "Reveal")))))),
    card("Standing consent", kv((id.ownerVault || {}).consents || []), form([["purposes", "purposes, comma separated"], ["classes", "classes, comma separated"], ["statement", "statement"]], "Grant",
      (v) => act("Consent", () => call("owner_identity_consent_set", { purposes: v.purposes.split(",").map((x) => x.trim()).filter(Boolean),
        classes: v.classes.split(",").map((x) => x.trim()).filter(Boolean), statement: v.statement })))),
    card("Releases (who, which venture, provider, purpose, classes, outcome)", kv((id.ownerVault || {}).releases || [])), card("Uploads", kv(comms.uploads))];
}
async function notifications() {
  const n = await read("notifications", { limit: 100 });
  return [card("Notifications", el("table", {}, el("tr", {}, ["At", "Class", "Title", "Agent", ""].map((h) => el("th", { text: h }))),
    (n.notifications || []).map((x) => el("tr", {}, el("td", { text: x.created_at }), el("td", { class: x.class, text: x.class }), el("td", { text: x.title }), el("td", { text: x.agent_id || "" }),
      el("td", {}, x.acknowledged_at ? el("span", { class: "muted", text: "ack" }) : el("button", { class: "ack-btn", onclick: () => act("Acknowledge", () => call("notification_ack", { id: x.notification_id })).then(render) }, "Acknowledge")))))),
    card("Delivery", form([["dailyHourUtc", "daily hour (UTC)"], ["adminEmail", "admin email"]], "Save",
      (v) => act("Notification policy", () => call("notification_policy", { dailyHourUtc: v.dailyHourUtc === "" ? null : Number(v.dailyHourUtc), adminEmail: v.adminEmail || null }))))];
}
async function security() {
  const [s, reveals] = await Promise.all([read("security"), read("reveal_log")]);
  return [card("Passkeys", el("table", {}, el("tr", {}, ["Name", "Created", "Last used", "Revoked", ""].map((h) => el("th", { text: h }))),
      (s.passkeys || []).map((p) => el("tr", {}, el("td", { text: p.name }), el("td", { text: p.createdAt }), el("td", { text: p.lastUsedAt || "" }), el("td", { text: p.revokedAt || "" }),
        el("td", {}, p.revokedAt ? "" : el("button", { class: "danger", onclick: () => act("Revoke passkey", () => call("passkey_revoke", { credentialId: p.credentialId })) }, "Revoke")))))),
    card("Sessions", kv(s.sessions), el("button", { class: "danger", onclick: () => act("Revoke other sessions", () => call("session_revoke_all", {})) }, "Sign out everywhere else")),
    card("Reveal log", kv(reveals)), card("Authentication log", kv(s.authLog))];
}

boot().catch((e) => toast(e.message));
})();
`;
