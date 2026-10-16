/**
 * v76: the Fleet's public offer and order pages, served by the controller (master specification §30).
 *
 *   GET  /o/<slug>                          an offer (product: Buy with PayPal; service: send a brief with up to 3 files)
 *   GET  /o/<slug>/preview/<n>              a public sample file of the offer
 *   POST /o/<slug>/buy                      a fresh checkout + order → 303 to the buyer's order page
 *   POST /o/<slug>/enquire                  a service brief (JSON from the page's script) → the buyer's request page
 *   GET  /order/<token>                     the buyer's order: pay link while open, status, downloads, thread, message form
 *   GET  /order/<token>/file/<delivery>/<n> a delivered file (30 days)
 *   POST /order/<token>/message             a buyer message (+ files) about the order
 *   GET  /enquiry/<token>                   the buyer's request: brief, thread, quote → order page
 *   POST /enquiry/<token>/message           a buyer message (+ files) about the request
 *   GET  /u/<token>, POST /u/<token>        v79: an outreach recipient's opt-out (GET asks, POST records — a link scanner
 *                                           never opts anyone out); never written to first again by any agent
 *
 *   GET  /sitemap.xml, /robots.txt          v80: published offer pages (only while sales are open) for search engines
 *   GET  /<indexnow key>.txt                v80: the IndexNow key file (proves the site's notifications are its own)
 *   GET  /oauth/callback                    v80: shows the owner the one-time authorisation code a provider returned (useless without
 *                                           the PKCE verifier kept in the channel gateway's vault); nothing is stored
 *
 * v79: an offer link with ?ref=<channel code> carries the agent's channel onto the order / enquiry it brings (attribution
 * only: a code of another agent or venture attributes nothing); image samples are shown on the offer page.
 *
 * Nothing here authenticates an agent or reaches agent state beyond the service-role svc_* functions, which validate every
 * argument, rate-limit per buyer origin and expose only what the token holder's own page needs. Tokens are 256-bit random
 * bearer secrets (never logged). POSTs must come from this same origin. Every page and file carries a strict CSP; files are
 * served as downloads (or sandboxed inline images) with nosniff. Every page states that an AI agent produces and fulfils
 * the work.
 */
import crypto from "crypto";
import type http from "http";
import { RateLimiter } from "./rate-limit.js";
import type { PublicPageFunction } from "../postgres/store.js";
import { BUYER_CONSENT_VERSION, BUYER_CONSENT_WORDING } from "../storefront/consent.js";

export interface PublicPagesPort {
  publicCall(fn: PublicPageFunction, args: unknown[]): Promise<Record<string, unknown>>;
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,48}-[0-9a-f]{6}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_POST_BYTES = 22_000_000;
const AI_NOTICE = "This offer is produced and fulfilled by an autonomous AI agent operating within the Automaton Fleet. Payments are handled by PayPal.";

export const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const money = (minor: unknown, cur: unknown) => `${cur === "GBP" ? "£" : `${esc(cur)} `}${(Number(minor) / 100).toFixed(2)}`;
const para = (t: unknown) => esc(t).split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
const kb = (n: unknown) => (Number(n) >= 1_000_000 ? `${(Number(n) / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(Number(n) / 1000))} kB`);

/** A page: strict CSP (scripts only with this response's nonce), no referrer, no framing. */
function page(res: http.ServerResponse, status: number, title: string, body: string, seller: unknown, o: { nonce?: string; refreshS?: number; head?: string } = {}): void {
  const csp = `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
    + (o.nonce ? `; script-src 'nonce-${o.nonce}'; connect-src 'self'` : "");
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
    "content-security-policy": csp, "referrer-policy": "no-referrer", "x-frame-options": "DENY" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + (o.refreshS ? `<meta http-equiv="refresh" content="${o.refreshS}">` : "") + (o.head ?? "") + `<title>${esc(title)}</title><style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:44rem;margin:2rem auto;padding:0 1rem;line-height:1.55;color:#1d232b;background:#fbfbfa}
h1{font-size:1.6rem;margin-bottom:.2rem}.muted{color:#5d6670}.card{background:#fff;border:1px solid #e3e5e8;border-radius:10px;padding:1rem 1.2rem;margin:1rem 0}
.price{font-size:1.4rem;font-weight:650}button,.btn{display:inline-block;background:#1f5eff;color:#fff;border:0;border-radius:8px;padding:.65rem 1.1rem;font-size:1rem;text-decoration:none;cursor:pointer}
input,textarea{width:100%;box-sizing:border-box;padding:.55rem;border:1px solid #c9ced4;border-radius:6px;font:inherit}textarea{min-height:9rem}
.msg{border-left:3px solid #c9ced4;padding:.3rem .8rem;margin:.6rem 0}.msg.agent{border-color:#1f5eff}footer{margin:2rem 0;font-size:.85rem;color:#5d6670}
ul{padding-left:1.2rem}.ok{color:#126b2f}.warn{color:#8a5a00}</style></head><body>${body}
<footer><p>${esc(AI_NOTICE)}</p>${seller ? `<p>${esc(seller).replace(/\n/g, "<br>")}</p>` : ""}</footer></body></html>`);
}

const STATUS_WORDS: Record<string, string> = {
  awaiting_payment: "Awaiting payment", to_fulfil: "Paid — being prepared", delivering: "Being delivered", delivered: "Delivered",
  delivery_failed: "Delivery problem — the seller has been notified", fulfilled: "Completed", cancelled: "Cancelled",
};

function threadHtml(thread: unknown): string {
  const items = Array.isArray(thread) ? (thread as Array<Record<string, unknown>>) : [];
  if (!items.length) return "";
  return `<div class="card"><h2>Messages</h2>${items.map((m) => `<div class="msg ${m.author === "agent" ? "agent" : ""}"><div class="muted">${m.author === "agent" ? "Seller" : "You"} · ${esc(String(m.at ?? "").slice(0, 16).replace("T", " "))}</div>${para(m.body)}`
    + (Array.isArray(m.files) && m.files.length ? `<div class="muted">Files: ${(m.files as Array<Record<string, unknown>>).map((f) => esc(f.fileName)).join(", ")}</div>` : "") + `</div>`).join("")}</div>`;
}

/** The message / brief form: files are read in the browser and sent as JSON with base64 content (no multipart parser server-side). */
/**
 * v82: the buyer's consent to immediate supply (CCR 2013 regs 36/37) — two separate, unticked boxes; the form is refused
 * unless both are ticked (the browser asks first; the server checks again; the database records the wording's version).
 */
function consentBoxes(statements: readonly string[]): string {
  return statements.map((t, i) => `<p><label style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" name="c${i + 1}" value="yes" required style="width:auto;margin-top:4px"><span>${esc(t)}</span></label></p>`).join("")
    + `<input type="hidden" name="consent" value="${esc(BUYER_CONSENT_VERSION)}">`;
}
/** Both boxes ticked and the current wording's version: the version to record, or null. */
function consentGiven(b: Record<string, unknown> | null, n: number): string | null {
  if (!b) return null;
  for (let i = 1; i <= n; i++) if (b[`c${i}`] !== "yes") return null;
  return b.consent === BUYER_CONSENT_VERSION ? BUYER_CONSENT_VERSION : null;
}

function messageForm(action: string, nonce: string, o: { brief?: boolean } = {}): string {
  return `<div class="card"><h2>${o.brief ? "Send your brief" : "Send a message"}</h2><form id="f">`
    + (o.brief ? `<p><label>Your name<input name="name" maxlength="140" required></label></p><p><label>Your email<input name="email" type="email" maxlength="254" required></label></p>` : "")
    + `<p><label>${o.brief ? "What do you need? (goal, audience, content, format, deadline)" : "Message"}<textarea name="body" maxlength="8000" required></textarea></label></p>`
    + `<p><label>Files (optional, up to 3, 5 MB each)<input name="files" type="file" multiple></label></p>`
    + `<p style="display:none"><label>Leave empty<input name="website" tabindex="-1" autocomplete="off"></label></p>`
    + `<p><button type="submit">Send</button> <span id="s" class="muted"></span></p></form></div>`
    + `<script nonce="${nonce}">document.getElementById('f').addEventListener('submit',async function(e){e.preventDefault();var f=e.target,s=document.getElementById('s');s.textContent='Sending…';var el=f.elements,fl=el.namedItem('files').files;try{var files=[];for(var i=0;i<Math.min(fl.length,3);i++){var x=fl[i];if(x.size>5e6){s.textContent=x.name+' is over 5 MB';return}
var b=await new Promise(function(ok,no){var r=new FileReader();r.onload=function(){ok(String(r.result).split(',')[1]||'')};r.onerror=no;r.readAsDataURL(x)});
files.push({fileName:x.name.replace(/[^A-Za-z0-9._ -]/g,'_').replace(/^[^A-Za-z0-9]+/,'').slice(0,120)||'file',contentType:x.type||'application/octet-stream',contentB64:b})}
var body={body:el.namedItem('body').value,files:files,website:el.namedItem('website').value};if(el.namedItem('name'))body.name=el.namedItem('name').value;if(el.namedItem('email'))body.email=el.namedItem('email').value;
var res=await fetch(${JSON.stringify(action)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});var j=await res.json().catch(function(){return{}});
if(j.ok&&j.next){location.href=j.next}else if(j.ok){location.reload()}else{s.textContent=j.reason||'Could not send it. Please try again later.'}}catch(err){s.textContent='Could not send it.'}});</script>`;
}

/**
 * v80: what search engines and link previews read — a description, Open Graph tags and schema.org Product / Offer data
 * (a data block: not executed, so the page's CSP is unchanged). Only the offer's own public fields.
 */
export function discoveryHead(o: Record<string, any>, previews: Array<Record<string, unknown>>): string {
  const img = previews.find((f) => /^image\/(png|jpeg)$/.test(String(f.contentType)));
  const ld = { "@context": "https://schema.org", "@type": "Product", name: o.title, description: o.summary, brand: o.brand ? { "@type": "Brand", name: o.brand } : undefined,
    ...(img ? { image: `/o/${o.slug}/preview/${img.n}` } : {}),
    offers: { "@type": "Offer", price: (Number(o.priceMinor) / 100).toFixed(2), priceCurrency: o.currency, availability: o.available ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      url: `/o/${o.slug}` } };
  return `<meta name="description" content="${esc(o.summary)}"><meta property="og:type" content="product"><meta property="og:title" content="${esc(o.title)}">`
    + `<meta property="og:description" content="${esc(o.summary)}">${img ? `<meta property="og:image" content="/o/${esc(o.slug)}/preview/${esc(img.n)}">` : ""}`
    + `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`;
}

export class PublicPages {
  private readonly reads: RateLimiter;
  private readonly writes: RateLimiter;

  constructor(private readonly port: PublicPagesPort, private readonly opts: { now?: () => number; log?: (event: string, detail: Record<string, unknown>) => void } = {}) {
    this.reads = new RateLimiter({ capacity: 120, refillPerSec: 2 }, opts.now);
    this.writes = new RateLimiter({ capacity: 10, refillPerSec: 10 / 600 }, opts.now);
  }

  /** True when the path is a public page (handled here, whatever the outcome). */
  static matches(path: string): boolean {
    return /^\/(o|order|enquiry|u)\//.test(path) || /^\/(sitemap\.xml|robots\.txt|[0-9a-f]{32}\.txt|oauth\/callback)$/.test(path);
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse, path: string, ip: string): Promise<void> {
    const origin = crypto.createHash("sha256").update(`fleet-public-origin:${ip}`).digest("hex");
    const isPost = req.method === "POST";
    if (req.method !== "GET" && !isPost) { res.writeHead(405).end(); return; }
    if (!(isPost ? this.writes : this.reads).take(origin)) { page(res, 429, "Too many requests", "<h1>Too many requests</h1><p>Please wait a few minutes and try again.</p>", null); return; }
    // Same-origin POSTs only (the page's own form or script): a cross-site form cannot buy, brief or message on a buyer's behalf.
    if (isPost && !this.sameOrigin(req)) { this.json(res, 403, { ok: false, reason: "cross-site request refused" }); return; }
    // v79: the channel attribution code of the link the buyer followed (12 hex characters; anything else is ignored).
    const ref = /[?&]ref=([0-9a-f]{12})(?:&|$)/.exec(req.url ?? "")?.[1] ?? null;
    try {
      const p = path.split("/").filter(Boolean);
      if (p[0] === "u" && TOKEN.test(p[1] ?? "") && p.length === 2) return await this.optOut(res, p[1], isPost);
      if (!isPost && path === "/robots.txt") return this.text(res, 200, "text/plain", `User-agent: *\nAllow: /o/\nDisallow: /order/\nDisallow: /enquiry/\nDisallow: /u/\nDisallow: /oauth/\nSitemap: ${await this.base(req)}/sitemap.xml\n`);
      if (!isPost && path === "/sitemap.xml") return await this.sitemap(res);
      if (!isPost && /^\/[0-9a-f]{32}\.txt$/.test(path)) return await this.indexNowKey(res, path.slice(1, 33));
      if (!isPost && path === "/oauth/callback") return this.oauthCallback(req, res);
      if (p[0] === "o" && SLUG.test(p[1] ?? "")) {
        if (p.length === 2 && !isPost) return await this.offer(res, p[1], ref);
        if (p.length === 4 && p[2] === "preview" && /^[1-4]$/.test(p[3]) && !isPost) return await this.preview(res, p[1], Number(p[3]));
        if (p.length === 3 && p[2] === "buy" && isPost) return await this.buy(req, res, p[1], origin, ref);
        if (p.length === 3 && p[2] === "enquire" && isPost) return await this.enquire(req, res, p[1], origin, ref);
      }
      if (p[0] === "order" && TOKEN.test(p[1] ?? "")) {
        if (p.length === 2 && !isPost) return await this.order(res, p[1]);
        if (p.length === 5 && p[2] === "file" && UUID.test(p[3]) && /^([1-9]|10)$/.test(p[4]) && !isPost) return await this.file(res, p[1], p[3], Number(p[4]));
        if (p.length === 3 && p[2] === "message" && isPost) return await this.message(req, res, "order", p[1], origin);
        if (p.length === 3 && p[2] === "consent" && isPost) return await this.consent(req, res, p[1], origin);
        if (p.length === 3 && p[2] === "repo-consent" && isPost) return await this.repoConsent(req, res, "order", p[1], origin);
      }
      if (p[0] === "enquiry" && TOKEN.test(p[1] ?? "")) {
        if (p.length === 2 && !isPost) return await this.enquiry(res, p[1]);
        if (p.length === 3 && p[2] === "message" && isPost) return await this.message(req, res, "enquiry", p[1], origin);
        if (p.length === 3 && p[2] === "repo-consent" && isPost) return await this.repoConsent(req, res, "enquiry", p[1], origin);
      }
      page(res, 404, "Not found", "<h1>Not found</h1><p>This page does not exist or is no longer available.</p>", null);
    } catch (err) {
      this.opts.log?.("public_page_failed", { path: path.replace(/[0-9a-f]{64}/g, "<token>"), error: err instanceof Error ? err.message.slice(0, 160) : "error" });
      if (!res.headersSent) page(res, 500, "Temporarily unavailable", "<h1>Temporarily unavailable</h1><p>Please try again in a few minutes.</p>", null);
    }
  }

  private sameOrigin(req: http.IncomingMessage): boolean {
    const host = req.headers.host;
    const o = req.headers.origin ?? req.headers.referer;
    if (!host || typeof o !== "string") return false;
    try { return new URL(o).host === host; } catch { return false; }
  }

  private json(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(body));
  }

  private async body(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) {
      n += (c as Buffer).length;
      if (n > MAX_POST_BYTES) return null;
      chunks.push(c as Buffer);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return {};
    if (String(req.headers["content-type"] ?? "").startsWith("application/json")) {
      try { const v = JSON.parse(raw); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
    }
    return Object.fromEntries(new URLSearchParams(raw));
  }

  private text(res: http.ServerResponse, status: number, type: string, body: string): void {
    res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "public, max-age=600", "x-content-type-options": "nosniff" });
    res.end(body);
  }
  private async base(req: http.IncomingMessage): Promise<string> {
    const r = await this.port.publicCall("svc_sitemap", []);
    return typeof r.base === "string" ? r.base : `https://${String(req.headers.host ?? "").replace(/[^A-Za-z0-9.:-]/g, "")}`;
  }
  /** v80: the published offer pages (sales open only; the Fleet's other pages are private by design). */
  private async sitemap(res: http.ServerResponse): Promise<void> {
    const r = await this.port.publicCall("svc_sitemap", []);
    const offers = Array.isArray(r.offers) ? (r.offers as Array<{ slug: string; lastmod: string }>) : [];
    const base = typeof r.base === "string" ? r.base : "";
    this.text(res, 200, "application/xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
      + offers.filter((o) => SLUG.test(o.slug)).map((o) => `<url><loc>${esc(base)}/o/${esc(o.slug)}</loc><lastmod>${esc(String(o.lastmod).slice(0, 10))}</lastmod></url>`).join("\n")
      + `\n</urlset>\n`);
  }
  private async indexNowKey(res: http.ServerResponse, key: string): Promise<void> {
    const r = await this.port.publicCall("svc_indexnow_key", []);
    if (r.key !== key) { page(res, 404, "Not found", "<h1>Not found</h1>", null); return; }
    this.text(res, 200, "text/plain", key);
  }
  /** v80: the owner copies this code into the channel gateway's oauth-exchange (it is worthless without the vault's verifier). */
  private oauthCallback(req: http.IncomingMessage, res: http.ServerResponse): void {
    const u = new URL(req.url ?? "/", "https://x");
    const code = (u.searchParams.get("code") ?? "").slice(0, 512);
    const state = (u.searchParams.get("state") ?? "").slice(0, 128);
    const err = (u.searchParams.get("error") ?? "").slice(0, 200);
    page(res, 200, "Authorisation", err ? `<h1>Not authorised</h1><p>${esc(err)}</p>`
      : `<h1>Authorisation code</h1><p>Copy both values into the channel gateway's <code>oauth-exchange</code> within 30 minutes. They are useless without the verifier the gateway kept.</p>`
        + `<p><strong>code</strong><br><code>${esc(code)}</code></p><p><strong>state</strong><br><code>${esc(state)}</code></p>`, null);
  }

  /** v79: an outreach recipient's opt-out: GET explains and asks; POST (this page's own button) records it. */
  private async optOut(res: http.ServerResponse, token: string, confirm: boolean): Promise<void> {
    const r = await this.port.publicCall("svc_outreach_optout", [token, confirm]);
    if (!r.ok) { page(res, 404, "Not found", "<h1>Not found</h1><p>This link is not valid.</p>", null); return; }
    const who = r.brand ? esc(r.brand) : "us";
    if (r.optedOut) { page(res, 200, "Unsubscribed", `<h1>You will not hear from ${who} again</h1><p>Your address is on our do-not-contact list for all of our businesses.</p>`, null); return; }
    page(res, 200, "Unsubscribe", `<h1>Stop messages from ${who}?</h1><p>We wrote to you once about something we thought useful. Confirm and no business of ours will write to you first again.</p>`
      + `<form method="post" action="/u/${esc(token)}"><button type="submit">Yes, stop all messages</button></form>`, null);
  }

  private async offer(res: http.ServerResponse, slug: string, ref: string | null = null): Promise<void> {
    const r = await this.port.publicCall("svc_offer_page", [slug]);
    if (!r.ok) { page(res, 404, "Not found", "<h1>Not found</h1><p>This offer is not available.</p>", null); return; }
    const o = r.offer as Record<string, any>;
    const nonce = crypto.randomBytes(16).toString("base64");
    const facts = [o.kind === "service" && o.turnaroundDays ? `Delivery within ${esc(o.turnaroundDays)} days of payment` : "Instant download after payment",
      o.revisions != null ? `${esc(o.revisions)} revision${o.revisions === 1 ? "" : "s"} included` : ""].filter(Boolean);
    const previews = Array.isArray(o.previews) ? o.previews as Array<Record<string, unknown>> : [];
    let action = "";
    const q = ref ? `?ref=${ref}` : "";
    if (!o.available) action = `<p class="warn">${o.atCapacity ? "Fully booked right now — please check back soon." : "Not available right now."}</p>`;
    else if (o.kind === "product") action = `<form method="post" action="/o/${esc(o.slug)}/buy${q}">${consentBoxes(BUYER_CONSENT_WORDING.digital_immediate)}<button type="submit">Buy with PayPal — ${money(o.priceMinor, o.currency)}</button></form>`;
    else action = `<p class="muted">Send your brief first: the seller confirms the scope, price and delivery date before you pay.</p>${messageForm(`/o/${o.slug}/enquire${q}`, nonce, { brief: true })}`;
    page(res, 200, o.title, `<p class="muted">${esc(o.brand)}</p><h1>${esc(o.title)}</h1><p>${esc(o.summary)}</p>`
      + `<div class="card"><div class="price">${o.kind === "service" ? "From " : ""}${money(o.priceMinor, o.currency)}</div><p class="muted">${facts.join(" · ")}</p>${o.kind === "product" ? action : ""}</div>`
      + (o.audience ? `<p><strong>For:</strong> ${esc(o.audience)}</p>` : "")
      + `<div class="card"><h2>What you get</h2><ul>${(o.deliverables as string[]).map((d) => `<li>${esc(d)}</li>`).join("")}</ul>`
      + (Array.isArray(o.files) && o.files.length ? `<p class="muted">Files: ${(o.files as Array<Record<string, unknown>>).map((f) => `${esc(f.fileName)} (${kb(f.sizeBytes)})`).join(", ")}</p>` : "") + `</div>`
      + `<div class="card"><h2>Details</h2>${para(o.description)}</div>`
      + (previews.length ? `<div class="card"><h2>Samples</h2>`
        // v79: image samples (the agent's listing graphics, mockups) are shown; other samples are links.
        + previews.filter((f) => /^image\/(png|jpeg)$/.test(String(f.contentType))).map((f) => `<p><img src="/o/${esc(o.slug)}/preview/${esc(f.n)}" alt="${esc(f.fileName)}" style="max-width:100%;border-radius:8px"></p>`).join("")
        + `<ul>${previews.map((f) => `<li><a href="/o/${esc(o.slug)}/preview/${esc(f.n)}">${esc(f.fileName)}</a> (${kb(f.sizeBytes)})</li>`).join("")}</ul></div>` : "")
      + `<div class="card"><h2>Terms</h2>${para(o.terms)}</div>` + (o.kind === "service" ? action : "")
      // v78: the agent's own storefront (its venture identity) and its support address.
      + (o.about || o.supportEmail ? `<div class="card"><h2>About ${esc(o.brand)}</h2>${o.about ? para(o.about) : ""}`
        + (o.supportEmail ? `<p class="muted">Questions: <a href="mailto:${esc(o.supportEmail)}">${esc(o.supportEmail)}</a></p>` : "") + `</div>` : ""), r.seller,
      { ...(o.kind === "service" && o.available ? { nonce } : {}), head: discoveryHead(o, previews) });
  }

  private async preview(res: http.ServerResponse, slug: string, n: number): Promise<void> {
    const r = await this.port.publicCall("svc_offer_preview", [slug, n]);
    if (!r.ok) { res.writeHead(404).end(); return; }
    this.sendFile(res, String(r.fileName), String(r.contentType), String(r.contentB64), /^image\/(png|jpeg)$/.test(String(r.contentType)));
  }

  private sendFile(res: http.ServerResponse, name: string, type: string, b64: string, inline: boolean): void {
    const safe = name.replace(/[^A-Za-z0-9._ -]/g, "_");
    res.writeHead(200, { "content-type": type, "content-disposition": `${inline ? "inline" : "attachment"}; filename="${safe}"`, "cache-control": "no-store",
      "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "referrer-policy": "no-referrer" });
    res.end(Buffer.from(b64, "base64"));
  }

  private async buy(req: http.IncomingMessage, res: http.ServerResponse, slug: string, origin: string, ref: string | null = null): Promise<void> {
    const consent = consentGiven(await this.body(req), BUYER_CONSENT_WORDING.digital_immediate.length);
    if (!consent) {
      page(res, 400, "Please confirm", `<h1>Please confirm before buying</h1><p>To get your download straight away, tick both boxes on the offer page: that you want immediate access, and that you understand you lose the 14-day right to cancel once the download is made available.</p><p><a href="/o/${esc(slug)}">Back to the offer</a></p>`, null);
      return;
    }
    const r = await this.port.publicCall("svc_offer_buy", [slug, origin, consent]);
    if (!r.ok) {
      page(res, r.code === "FLEET_BUSY" ? 429 : 409, "Not available", `<h1>Not available right now</h1><p>${r.code === "FLEET_BUSY" ? "Too many open checkouts — please try again later." : "This offer cannot be bought at the moment."}</p><p><a href="/o/${esc(slug)}">Back to the offer</a></p>`, null);
      return;
    }
    if (ref) await this.port.publicCall("svc_attribute", ["order", String(r.token), ref]).catch(() => undefined);
    res.writeHead(303, { location: `/order/${r.token}`, "cache-control": "no-store", "referrer-policy": "no-referrer" }).end();
  }

  private async enquire(req: http.IncomingMessage, res: http.ServerResponse, slug: string, origin: string, ref: string | null = null): Promise<void> {
    const b = await this.body(req);
    if (!b) { this.json(res, 413, { ok: false, reason: "too large (files are 5 MB each, 3 at most)" }); return; }
    if (b.website) { this.json(res, 200, { ok: true }); return; } // a bot filled the hidden field
    const r = await this.port.publicCall("svc_offer_enquire", [slug, origin, String(b.name ?? ""), String(b.email ?? ""), String(b.body ?? ""), Array.isArray(b.files) ? b.files : []]);
    if (!r.ok) {
      this.json(res, 200, { ok: false, reason: r.code === "FLEET_OFFER_AT_CAPACITY" ? "Fully booked right now — please try again later."
        : r.code === "FLEET_BUSY" ? "Too many requests — please try again later." : typeof r.reason === "string" ? r.reason : "This request could not be sent." });
      return;
    }
    if (ref) await this.port.publicCall("svc_attribute", ["enquiry", String(r.token), ref]).catch(() => undefined);
    this.json(res, 200, { ok: true, next: `/enquiry/${r.token}` });
  }

  private async message(req: http.IncomingMessage, res: http.ServerResponse, kind: "order" | "enquiry", token: string, origin: string): Promise<void> {
    const b = await this.body(req);
    if (!b) { this.json(res, 413, { ok: false, reason: "too large (files are 5 MB each, 3 at most)" }); return; }
    if (b.website) { this.json(res, 200, { ok: true }); return; }
    const r = await this.port.publicCall("svc_customer_message", [kind, token, origin, String(b.body ?? ""), Array.isArray(b.files) ? b.files : []]);
    this.json(res, 200, r.ok ? { ok: true } : { ok: false, reason: r.code === "FLEET_BUSY" ? "Too many messages today — please try again tomorrow." : typeof r.reason === "string" ? r.reason : "The message could not be sent." });
  }

  private async order(res: http.ServerResponse, token: string): Promise<void> {
    const r = await this.port.publicCall("svc_order_page", [token]);
    if (!r.ok) { page(res, 404, "Not found", "<h1>Not found</h1><p>This order page does not exist.</p>", null); return; }
    const o = r.order as Record<string, any>;
    const nonce = crypto.randomBytes(16).toString("base64");
    const waiting = o.checkout === "requested" || o.checkout === "open" || o.checkout === "approved" || o.checkout === "capture_pending";
    let pay = "";
    if (o.checkout === "requested") pay = `<p>Preparing your secure PayPal checkout… this page refreshes automatically.</p>`;
    else if (o.checkout === "open" && o.approvalUrl) pay = `<p><a class="btn" href="${esc(o.approvalUrl)}" rel="noreferrer">Pay ${money(o.amountMinor, o.currency)} with PayPal</a></p><p class="muted">Already paid? This page updates automatically once PayPal confirms it.</p>`;
    else if (o.checkout === "approved" || o.checkout === "capture_pending") pay = `<p>Confirming your payment with PayPal…</p>`;
    else if (o.checkout === "expired" || o.checkout === "cancelled" || o.checkout === "failed") pay = `<p class="warn">This checkout is no longer open; no payment was taken.</p>`;
    const downloads = Array.isArray(r.downloads) ? r.downloads as Array<Record<string, unknown>> : [];
    // v82: the buyer's consent to immediate supply: asked before the payment link and the downloads; repeated once recorded.
    const c = (o.consent ?? {}) as Record<string, any>;
    const statements = Array.isArray(c.statements) ? (c.statements as unknown[]).map(String) : [];
    const closed = ["refunded", "reversed", "cancelled"].includes(o.payment) || ["expired", "cancelled", "failed"].includes(o.checkout);
    const askConsent = !c.recorded && !closed && statements.length > 0;
    if (askConsent) pay = "";
    const consentCard = askConsent
      ? `<div class="card"><h2>${o.payment === "paid" || o.payment === "partially_refunded" ? "Before you download" : "Before you pay"}</h2>`
        + `<form method="post" action="/order/${esc(token)}/consent">${statements.map((t, i) => `<p><label style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" name="c${i + 1}" value="yes" required style="width:auto;margin-top:4px"><span>${esc(t)}</span></label></p>`).join("")}`
        + `<input type="hidden" name="consent" value="${esc(c.version)}"><button type="submit">Confirm</button></form></div>`
      : c.recorded && statements.length ? `<div class="card"><h2>Your confirmation</h2><p class="muted">Recorded ${esc(String(c.at).slice(0, 16).replace("T", " "))} UTC</p><ul>${statements.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : "";
    page(res, 200, `Your order — ${o.item}`, `<h1>Your order</h1><p class="muted">${esc(o.item)}</p>`
      + `<div class="card"><div class="price">${money(o.amountMinor, o.currency)}</div><p><strong>${esc(STATUS_WORDS[o.status] ?? o.status)}</strong>${o.dueAt ? ` · due by ${esc(String(o.dueAt).slice(0, 10))}` : ""}</p>${pay}</div>`
      + (askConsent ? consentCard : "")
      + (o.scope ? `<div class="card"><h2>Agreed scope</h2>${para(o.scope)}</div>` : "")
      + (downloads.length ? `<div class="card"><h2>Your files</h2><ul>${downloads.map((f) => `<li><a href="/order/${esc(token)}/file/${esc(f.deliveryId)}/${esc(f.fileNo)}">${esc(f.fileName)}</a> (${kb(f.sizeBytes)})${f.until ? ` <span class="muted">until ${esc(String(f.until).slice(0, 10))}</span>` : ""}</li>`).join("")}</ul></div>` : "")
      + await this.repoHtml("order", token)
      + threadHtml(r.thread)
      + (o.payment === "paid" || o.payment === "partially_refunded" ? messageForm(`/order/${token}/message`, nonce) : "")
      + (o.offer?.terms ? `<div class="card"><h2>Terms</h2>${para(o.offer.terms)}</div>` : "")
      + (askConsent ? "" : consentCard),
      r.seller, { ...(o.payment === "paid" || o.payment === "partially_refunded" ? { nonce } : {}), ...(waiting && !askConsent ? { refreshS: o.checkout === "open" ? 15 : 4 } : {}) });
  }

  /** v82: the buyer's consent given on the order page (a quoted service, or an order made outside an offer page). */
  private async consent(req: http.IncomingMessage, res: http.ServerResponse, token: string, origin: string): Promise<void> {
    const b = await this.body(req);
    const version = b && b.c1 === "yes" && b.c2 === "yes" && b.consent === BUYER_CONSENT_VERSION ? BUYER_CONSENT_VERSION : null;
    if (!version) {
      page(res, 400, "Please confirm", `<h1>Please tick both boxes</h1><p>Both statements need your confirmation before we can continue.</p><p><a href="/order/${esc(token)}">Back to your order</a></p>`, null);
      return;
    }
    const r = await this.port.publicCall("svc_order_consent", [token, origin, version]);
    if (!r.ok) {
      page(res, r.code === "FLEET_NOT_FOUND" ? 404 : 409, "Not available", `<h1>Not available</h1><p>${r.code === "FLEET_ORDER_CLOSED" ? "This order is closed." : "This confirmation could not be recorded."}</p><p><a href="/order/${esc(token)}">Back to your order</a></p>`, null);
      return;
    }
    res.writeHead(303, { location: `/order/${token}`, "cache-control": "no-store", "referrer-policy": "no-referrer" }).end();
  }

  private async file(res: http.ServerResponse, token: string, delivery: string, n: number): Promise<void> {
    const r = await this.port.publicCall("svc_order_file", [token, delivery, n]);
    if (!r.ok) { res.writeHead(404).end(); return; }
    this.sendFile(res, String(r.fileName), String(r.contentType), String(r.contentB64), false);
  }

  /** v89: requests for access to the customer's repository, with the exact terms and a consent form (no script needed). */
  private async repoHtml(kind: "enquiry" | "order", token: string): Promise<string> {
    const r = await this.port.publicCall("svc_repo_requests", [kind, token]);
    const reqs = (r.requests as Array<Record<string, any>> | undefined) ?? [];
    if (!reqs.length) return "";
    const install = typeof r.installUrl === "string" ? r.installUrl : null;
    return reqs.map((q) => `<div class="card"><h2>Access to your code: ${esc(q.repo)}</h2><p>${esc(q.wording)}</p>`
      + (q.status === "requested"
        ? `<form method="post" action="/${kind}/${esc(token)}/repo-consent"><input type="hidden" name="authorizationId" value="${esc(q.authorizationId)}">`
          + `<p><label>Type the repository name to confirm (${esc(q.repo)})<br><input name="repo" required maxlength="140" autocomplete="off"></label></p>`
          + `<p><label>Your name<br><input name="name" required maxlength="140"></label></p>`
          + `<p><button class="btn" type="submit">I authorise this access</button></p><p class="muted">Never send passwords, tokens or keys: access is only through the app you install.</p></form>`
        : q.status === "consented"
          ? `<p><strong>You authorised this.</strong> Now install the app on <strong>${esc(q.repo)}</strong> only${install ? `: <a class="btn" href="${esc(install)}" rel="noopener">Install the GitHub App</a>` : " (the install link is not available yet)."}</p>`
          : `<p><strong>Access is active</strong> until ${esc(String(q.expiresAt ?? "").slice(0, 10))}. To end it at any time, uninstall the app or remove this repository from it.</p>`)
      + `</div>`).join("");
  }

  private async repoConsent(req: http.IncomingMessage, res: http.ServerResponse, kind: "enquiry" | "order", token: string, origin: string): Promise<void> {
    const b = await this.body(req);
    const back = `<p><a class="btn" href="/${kind}/${esc(token)}">Back to your page</a></p>`;
    if (!b || !UUID.test(String(b.authorizationId ?? ""))) { page(res, 400, "Not accepted", `<h1>Not accepted</h1><p>The form was incomplete.</p>${back}`, null); return; }
    const r = await this.port.publicCall("svc_repo_consent", [kind, token, String(b.authorizationId), String(b.repo ?? "").slice(0, 200), String(b.name ?? "").slice(0, 200), origin]);
    if (!r.ok) { page(res, 400, "Not accepted", `<h1>Not accepted</h1><p>${esc(r.reason ?? "This request is no longer open.")}</p>${back}`, null); return; }
    const install = typeof r.installUrl === "string" ? r.installUrl : null;
    page(res, 200, "Authorised", `<h1>Thank you</h1><p>You authorised access to this repository on the terms shown. Next, install the app on that repository only.</p>`
      + (install ? `<p><a class="btn" href="${esc(install)}" rel="noopener">Install the GitHub App</a></p>` : "<p>The install link is not available yet; the seller will tell you.</p>") + back, null);
  }

  private async enquiry(res: http.ServerResponse, token: string): Promise<void> {
    const r = await this.port.publicCall("svc_enquiry_page", [token]);
    if (!r.ok) { page(res, 404, "Not found", "<h1>Not found</h1><p>This request page does not exist.</p>", null); return; }
    const e = r.enquiry as Record<string, any>;
    const nonce = crypto.randomBytes(16).toString("base64");
    const words: Record<string, string> = { new: "Received — the seller will reply by email", clarifying: "In discussion", quoted: "Quoted — review and pay on your order page",
      accepted: "Accepted", declined: "Declined", expired: "Closed" };
    page(res, 200, `Your request — ${e.offer?.title ?? ""}`, `<h1>Your request</h1><p class="muted">${esc(e.offer?.title)}</p>`
      + `<div class="card"><p><strong>${esc(words[e.status] ?? e.status)}</strong></p>${e.orderToken ? `<p><a class="btn" href="/order/${esc(e.orderToken)}">Open your order page</a></p>` : ""}</div>`
      + `<div class="card"><h2>Your brief</h2>${para(e.brief)}</div>` + await this.repoHtml("enquiry", token) + threadHtml(r.thread)
      + (["new", "clarifying", "quoted"].includes(e.status) ? messageForm(`/enquiry/${token}/message`, nonce) : ""), r.seller,
      ["new", "clarifying", "quoted"].includes(e.status) ? { nonce } : {});
  }
}
