/**
 * v76: the Fleet's public offer and order pages, served by the controller (master specification §30).
 *
 *   GET  /o/<slug>                          an offer (product: Buy with PayPal; service: send a brief with up to 3 files)
 *   GET  /o/<slug>/preview/<n>              a public sample file of the offer
 *   POST /o/<slug>/buy                      a fresh checkout + order → 303 to the buyer's order page
 *   POST /o/<slug>/enquire                  a service brief (JSON from the page's script) → the buyer's request page
 *   GET  /order/<token>                     the buyer's order (v97: the checkout): what it buys (read from the files), the total,
 *                                           consent, PayPal's payment button, receipt, downloads, seller, support, refund rights
 *   GET  /order/<token>/preview/<n>         v97: the offer's preview image, by the order's access code
 *   GET  /order/<token>?token=…&PayerID=…   v99: PayPal's return of an approving buyer → recorded, then the clean page ("processing")
 *   POST /order/<token>/country             v108: the buyer's country before payment (the owner's supported geography)
 *   POST /order/<token>/pay                 v98: the buyer is ready to pay → PayPal (a link PayPal confirmed recently) or the page
 *                                           while custody reuses or replaces the PayPal order
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
import { formatName, readContents, type Contents } from "../storefront/contents.js";
import { ORDER_CONTENTS_MAX_BYTES } from "../postgres/migrations-phase97.js";
import { DELIVERY_RETENTION_DAYS } from "../postgres/migrations-phase76.js";

export interface PublicPagesPort {
  publicCall(fn: PublicPageFunction, args: unknown[]): Promise<Record<string, unknown>>;
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,48}-[0-9a-f]{6}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_POST_BYTES = 22_000_000;
/** PayPal's own hosted logo (its brand asset, served by PayPal) on the order page's payment button. */
const PAYPAL_LOGO_ORIGIN = "https://www.paypalobjects.com";
const PAYPAL_LOGO = `${PAYPAL_LOGO_ORIGIN}/paypal-ui/logos/svg/paypal-color.svg`;
const AI_NOTICE = "This offer is produced and fulfilled by an autonomous AI agent operating within the Automaton Fleet. Payments are handled by PayPal.";

export const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const money = (minor: unknown, cur: unknown) => `${cur === "GBP" ? "£" : `${esc(cur)} `}${(Number(minor) / 100).toFixed(2)}`;
const para = (t: unknown) => esc(t).split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
const kb = (n: unknown) => (Number(n) >= 1_000_000 ? `${(Number(n) / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(Number(n) / 1000))} kB`);
/** A time as the buyer reads it: "19 Oct 2026, 16:09 UTC". */
const when = (iso: unknown) => { const d = new Date(String(iso)); return Number.isNaN(d.getTime()) ? String(iso ?? "") : `${d.toLocaleString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })} UTC`; };
const ext = (name: string) => (/\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1] ?? "").toLowerCase();
const brand = (off: Record<string, any>) => typeof off.brand === "string" && off.brand.trim() !== "";
/** What a buyer needs to open the files (from the file types; nothing claimed beyond the format). */
function needsFor(names: readonly string[]): string[] {
  const e = new Set(names.map(ext));
  const out: string[] = [];
  if (e.has("zip")) out.push("A ZIP file: open it with your computer's or phone's file manager to get the files inside.");
  if (e.has("csv")) out.push("A spreadsheet app that opens CSV files, such as Microsoft Excel, Google Sheets or LibreOffice Calc.");
  if (e.has("xlsx") || e.has("xls")) out.push("A spreadsheet app that opens Excel workbooks, such as Microsoft Excel, Google Sheets or LibreOffice Calc.");
  if (e.has("ods")) out.push("A spreadsheet app that opens OpenDocument spreadsheets, such as LibreOffice Calc or Google Sheets.");
  if (e.has("pdf")) out.push("A PDF reader (built into most web browsers).");
  if (e.has("docx")) out.push("A word processor that opens Word documents, such as Microsoft Word, Google Docs or LibreOffice Writer.");
  if (e.has("epub")) out.push("An e-book reader app that opens EPUB files.");
  return out;
}

/** A page: strict CSP (scripts only with this response's nonce), no referrer to other sites, no framing.
 *  Referrer-Policy same-origin (2026-10-19; was no-referrer): with no-referrer a browser sends `Origin: null` on the page's
 *  own form POST, which the same-origin check had to refuse — the order page's consent form failed ("cross-site request
 *  refused") in a real browser. Same-origin sends the page's origin to this site only, never to another. */
function page(res: http.ServerResponse, status: number, title: string, body: string, seller: unknown, o: { nonce?: string; refreshS?: number; head?: string; paypalLogo?: boolean } = {}): void {
  // v98: a page with PayPal's button may hand the buyer on to PayPal after its own form (Chrome applies form-action to that redirect).
  const csp = `default-src 'none'; img-src 'self'${o.paypalLogo ? ` ${PAYPAL_LOGO_ORIGIN}` : ""}; style-src 'unsafe-inline'; form-action 'self'${o.paypalLogo ? " https://www.paypal.com https://www.sandbox.paypal.com" : ""}; base-uri 'none'; frame-ancestors 'none'`
    + (o.nonce ? `; script-src 'nonce-${o.nonce}'; connect-src 'self'` : "");
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
    "content-security-policy": csp, "referrer-policy": "same-origin", "x-frame-options": "DENY" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + (o.refreshS ? `<meta http-equiv="refresh" content="${o.refreshS}">` : "") + (o.head ?? "") + `<title>${esc(title)}</title><style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:44rem;margin:2rem auto;padding:0 1rem;line-height:1.55;color:#1d232b;background:#fbfbfa}
h1{font-size:1.6rem;margin-bottom:.2rem}.muted{color:#5d6670}.card{background:#fff;border:1px solid #e3e5e8;border-radius:10px;padding:1rem 1.2rem;margin:1rem 0}
.price{font-size:1.4rem;font-weight:650}button,.btn{font:inherit;font-weight:600;display:inline-block;background:#1f5eff;color:#fff;border:0;border-radius:8px;padding:.65rem 1.1rem;font-size:1rem;text-decoration:none;cursor:pointer}
input,textarea{width:100%;box-sizing:border-box;padding:.55rem;border:1px solid #c9ced4;border-radius:6px;font:inherit}textarea{min-height:9rem}
.msg{border-left:3px solid #c9ced4;padding:.3rem .8rem;margin:.6rem 0}.msg.agent{border-color:#1f5eff}footer{margin:2rem 0;font-size:.85rem;color:#5d6670}
ul{padding-left:1.2rem}.ok{color:#126b2f}.warn{color:#8a5a00}
.top{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:.3rem 1rem;border-bottom:1px solid #e3e5e8;padding-bottom:.7rem;margin-bottom:1.2rem}
.brand{font-weight:700;font-size:1.15rem}.small{font-size:.88rem}h2{font-size:1.15rem;margin:.2rem 0 .6rem}h3{font-size:1rem;margin:1rem 0 .3rem}
.steps{display:flex;gap:.5rem;list-style:none;padding:0;margin:1rem 0}.steps li{flex:1;font-size:.85rem;color:#5d6670;border-top:4px solid #e3e5e8;padding-top:.35rem}
.steps li.done{border-color:#126b2f;color:#126b2f}.steps li.now{border-color:#1d232b;color:#1d232b;font-weight:650}
.pill{display:inline-block;border-radius:999px;padding:.12rem .7rem;font-size:.85rem;font-weight:650;background:#eef0f3;color:#1d232b}
.pill.ok{background:#e3f4e8;color:#126b2f}.pill.warn{background:#fff3d6;color:#7a4f00}.pill.bad{background:#fde8e8;color:#9b1c1c}
.line{display:flex;justify-content:space-between;gap:1rem}.total{display:flex;justify-content:space-between;align-items:baseline;border-top:1px solid #e3e5e8;padding-top:.6rem;margin-top:.6rem}
.total .price{font-size:1.7rem}.block{display:block;width:100%;box-sizing:border-box;text-align:center;margin-top:.5rem}
.pp{display:flex;align-items:center;justify-content:center;gap:.5rem;width:100%;box-sizing:border-box;background:#ffc439;color:#111;border-radius:999px;padding:.75rem 1rem;font-size:1.08rem;font-weight:650;text-decoration:none;min-height:3.1rem;margin-top:.4rem}
.pp:hover{background:#f2ba36}.pp img{height:1.4rem;width:auto;display:block}
dl.receipt{display:grid;grid-template-columns:max-content 1fr;gap:.35rem 1rem;margin:0}dl.receipt dt{color:#5d6670}dl.receipt dd{margin:0;overflow-wrap:anywhere}
pre.peek{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f6f7;border-radius:6px;padding:.6rem;font-size:.82rem;margin:.3rem 0}
.cols{display:flex;flex-wrap:wrap;gap:.3rem;margin:.35rem 0 .2rem;padding:0;list-style:none}.cols li{background:#f0f2f5;border-radius:4px;padding:.1rem .45rem;font-size:.82rem}
ul.inside>li{margin:.5rem 0}.dl{display:block;text-align:center;background:#126b2f;color:#fff;border-radius:8px;padding:.7rem 1rem;text-decoration:none;font-weight:600;margin:.4rem 0}
@media print{.noprint,footer form{display:none}body{background:#fff}}</style></head><body>${body}
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
/** v108: the buyer's country (ISO 3166-1 alpha-2), chosen before paying — the owner's supported geography is checked by the database. */
const COUNTRY_CODES = ("AD AE AF AG AI AL AM AO AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ "
  + "DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP "
  + "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ "
  + "OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG TH TJ TK TL TM TN TO TR TT TV TW TZ "
  + "UA UG US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW").split(" ");
const REGION = new Intl.DisplayNames(["en-GB"], { type: "region" });
const COUNTRY_OPTIONS = (() => {
  const named = COUNTRY_CODES.map((c) => [c, REGION.of(c) ?? c] as const).sort((a, b) => a[1].localeCompare(b[1], "en-GB"));
  const top = ["GB", "US"].map((c) => named.find((x) => x[0] === c)!);
  return [...top, ...named.filter((x) => !["GB", "US"].includes(x[0]))];
})();
function countrySelect(): string {
  return `<p><label>Your country<select name="country" required><option value="">Choose your country…</option>`
    + COUNTRY_OPTIONS.map(([c, n]) => `<option value="${c}">${esc(n)}</option>`).join("") + `</select></label></p>`
    + `<p class="small muted">Digital products from this shop are not yet available to buyers in the European Union.</p>`;
}
const countryOf = (b: Record<string, unknown> | null): string | null => (b && typeof b.country === "string" && /^[A-Z]{2}$/.test(b.country) ? b.country : null);
const COUNTRY_REFUSED = (c: string) => `<h1>Not available in your country yet</h1><p>This shop cannot sell digital products to buyers in ${esc(REGION.of(c) ?? c)} yet. <strong>No payment was taken.</strong></p>`;

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
  /** v97: what is inside each deliverable, by its digest (bounded). */
  private readonly contentsCache = new Map<string, Contents | null>();

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
        if (p.length === 2 && !isPost) {
          // v99: PayPal returns an approving buyer here with its order id and the payer id: custody is asked to read the order at
          // once and the clean page says "processing" until it has (the return alone is never payment).
          const ret = /[?&]token=([A-Z0-9]{5,40})(?:&|$)/.exec(req.url ?? "")?.[1];
          if (ret && /[?&]PayerID=[A-Za-z0-9]{5,40}(?:&|$)/.test(req.url ?? "")) {
            await this.port.publicCall("svc_order_returned", [p[1], ret]);
            res.writeHead(303, { location: `/order/${p[1]}`, "cache-control": "no-store", "referrer-policy": "no-referrer" }).end();
            return;
          }
          return await this.order(res, p[1]);
        }
        if (p.length === 4 && p[2] === "preview" && /^[1-4]$/.test(p[3]) && !isPost) return await this.orderPreview(res, p[1], Number(p[3]));
        if (p.length === 5 && p[2] === "file" && UUID.test(p[3]) && /^([1-9]|10)$/.test(p[4]) && !isPost) return await this.file(res, p[1], p[3], Number(p[4]));
        if (p.length === 3 && p[2] === "message" && isPost) return await this.message(req, res, "order", p[1], origin);
        if (p.length === 3 && p[2] === "consent" && isPost) return await this.consent(req, res, p[1], origin);
        if (p.length === 3 && p[2] === "pay" && isPost) return await this.payNow(res, p[1], origin);
        if (p.length === 3 && p[2] === "country" && isPost) return await this.country(req, res, p[1], origin);
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

  /** A POST is this site's own when its Origin (or, without one, its Referer) names this host, or — when the browser
   *  withholds the origin (`Origin: null`, e.g. under a no-referrer policy) — when the browser itself marks the request
   *  `Sec-Fetch-Site: same-origin` (a header web content cannot set). Cross-site, same-site (another subdomain) and
   *  unmarked requests are refused. */
  private sameOrigin(req: http.IncomingMessage): boolean {
    const host = req.headers.host;
    if (!host) return false;
    const site = req.headers["sec-fetch-site"];
    if (typeof site === "string" && site !== "same-origin") return false;   // the browser says it is not this site's own
    const o = req.headers.origin ?? req.headers.referer;
    if (typeof o === "string" && o !== "null") {
      try { return new URL(o).host === host; } catch { return false; }
    }
    return site === "same-origin";
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
    else if (o.kind === "product") action = `<form method="post" action="/o/${esc(o.slug)}/buy${q}">${countrySelect()}${consentBoxes(BUYER_CONSENT_WORDING.digital_immediate)}<button type="submit">Buy with PayPal — ${money(o.priceMinor, o.currency)}</button></form>`;
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
        + (o.supportEmail ? `<p class="muted">Questions: <a href="mailto:${esc(o.supportEmail)}${o.supportSubject ? `?subject=${esc(encodeURIComponent(`${o.supportSubject}${o.title}`))}` : ""}">${esc(o.supportEmail)}</a>${o.supportSubject ? ` — start the subject with <strong>${esc(o.supportSubject)}</strong>` : ""}</p>` : "") + `</div>` : ""), r.seller,
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
    const body = await this.body(req);
    const consent = consentGiven(body, BUYER_CONSENT_WORDING.digital_immediate.length);
    if (!consent) {
      page(res, 400, "Please confirm", `<h1>Please confirm before buying</h1><p>To get your download straight away, tick both boxes on the offer page: that you want immediate access, and that you understand you lose the 14-day right to cancel once the download is made available.</p><p><a href="/o/${esc(slug)}">Back to the offer</a></p>`, null);
      return;
    }
    const country = countryOf(body);
    if (!country) {
      page(res, 400, "Please choose your country", `<h1>Please choose your country</h1><p>Choose your country on the offer page before buying.</p><p><a href="/o/${esc(slug)}">Back to the offer</a></p>`, null);
      return;
    }
    const r = await this.port.publicCall("svc_offer_buy", [slug, origin, consent]);
    if (!r.ok) {
      page(res, r.code === "FLEET_BUSY" ? 429 : 409, "Not available", `<h1>Not available right now</h1><p>${r.code === "FLEET_BUSY" ? "Too many open checkouts — please try again later." : "This offer cannot be bought at the moment."}</p><p><a href="/o/${esc(slug)}">Back to the offer</a></p>`, null);
      return;
    }
    if (ref) await this.port.publicCall("svc_attribute", ["order", String(r.token), ref]).catch(() => undefined);
    // v108: the buyer's country is recorded with the order before any payment (refused where the shop does not sell).
    const cr = await this.port.publicCall("svc_order_country", [String(r.token), origin, country]);
    if (!cr.ok && cr.code === "FLEET_COUNTRY_UNSUPPORTED") { page(res, 409, "Not available", COUNTRY_REFUSED(country) + `<p><a href="/o/${esc(slug)}">Back to the offer</a></p>`, null); return; }
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

  /** v97: the buyer's order page is the checkout — what they buy (from the actual files), the total, the consent the law
   *  asks for, PayPal's own payment button, then the receipt and the download; the seller, support and refund rights. */
  private async order(res: http.ServerResponse, token: string): Promise<void> {
    const r = await this.port.publicCall("svc_order_page", [token]);
    if (!r.ok) { page(res, 404, "Not found", "<h1>Not found</h1><p>This order page does not exist.</p>", null); return; }
    const o = r.order as Record<string, any>;
    const off = (o.offer ?? null) as Record<string, any> | null;
    const nonce = crypto.randomBytes(16).toString("base64");
    const total = money(o.amountMinor, o.currency);
    const product = off ? off.kind === "product" : o.kind === "digital_file";
    const paid = o.payment === "paid" || o.payment === "partially_refunded";
    const downloads = Array.isArray(r.downloads) ? r.downloads as Array<Record<string, unknown>> : [];
    const c = (o.consent ?? {}) as Record<string, any>;
    const statements = Array.isArray(c.statements) ? (c.statements as unknown[]).map(String) : [];
    const closed = ["refunded", "reversed", "cancelled"].includes(o.payment) || (!paid && ["expired", "cancelled", "failed"].includes(o.checkout));
    const askConsent = !c.recorded && !closed && statements.length > 0;
    const country = (o.country ?? {}) as { stated?: string | null };
    const conversation = (o.conversation ?? { open: true }) as { open?: boolean; note?: string };
    const confirming = !paid && (o.checkout === "approved" || o.checkout === "capture_pending" || o.pay === "processing");
    const delivered = downloads.length > 0 || ["delivered", "fulfilled"].includes(o.status);
    const ref = esc(o.reference ?? "");
    const brand = off?.brand ? String(off.brand) : "";

    // ── the state, in the buyer's words ──
    let pill: string;
    if (o.payment === "refunded") pill = `<span class="pill">Refunded</span>`;
    else if (o.payment === "reversed") pill = `<span class="pill bad">Payment reversed</span>`;
    else if (closed) pill = `<span class="pill">Checkout closed</span>`;
    else if (paid) pill = `<span class="pill ok">${delivered ? (product ? "Paid · ready to download" : "Paid · delivered") : "Paid"}</span>`;
    else if (confirming) pill = `<span class="pill warn">Processing your payment</span>`;
    else pill = `<span class="pill warn">Not paid yet</span>`;

    let action = "";
    if (askConsent) {
      action = `<form method="post" action="/order/${esc(token)}/consent" class="noprint"><h3>${paid ? "Before you download" : "Step 1 of 2 · Before you pay"}</h3>`
        + (product ? `<p class="small">This is a digital download. You normally have 14 days to cancel an online purchase, but for a download that right ends once it is made available to you. To get your files straight after payment, please confirm both statements:</p>`
          : `<p class="small">You normally have 14 days to cancel an online purchase. For the seller to start your work straight away, please confirm both statements:</p>`)
        + statements.map((t, i) => `<p><label style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" name="c${i + 1}" value="yes" required style="width:auto;margin-top:4px"><span>${esc(t)}</span></label></p>`).join("")
        + (!paid && !country.stated ? countrySelect() : "")
        + `<input type="hidden" name="consent" value="${esc(c.version)}"><button type="submit" class="block">${paid ? "Confirm and show my download" : "Confirm and continue to payment"}</button></form>`;
    } else if (closed) {
      action = o.payment === "refunded" || o.payment === "partially_refunded" || o.payment === "reversed" ? ""
        : `<p>This checkout is no longer open. <strong>No payment was taken.</strong></p>`;
    } else if (paid) {
      action = "";
    } else if (!country.stated && !confirming) {
      // v108: the buyer's country before payment (the owner's supported geography).
      action = `<form method="post" action="/order/${esc(token)}/country" class="noprint"><h3>Step 1 of 2 · Your country</h3>${countrySelect()}<button type="submit" class="block">Continue to payment</button></form>`;
    } else if (confirming) {
      action = `<h3>Processing your payment</h3><p>You approved the payment on PayPal and we are confirming it with PayPal now — usually a few seconds. <strong>Please don't pay again.</strong> This page updates by itself.</p>`;
    } else if (o.pay === "preparing") {
      action = `<h3>Step 2 of 2 · Pay</h3><p>Opening a fresh PayPal checkout for you… this page refreshes by itself, usually within a few seconds. Nothing has been charged.</p>`;
    } else if (o.pay === "link" || o.pay === "button" || o.pay === "retry" || (!o.pay && o.checkout === "open" && o.approvalUrl)) {
      // v98: a link PayPal confirmed recently goes straight to PayPal; otherwise the button asks for a fresh (or re-confirmed) one first.
      const mark = `<span>Pay ${total} with</span><img src="${PAYPAL_LOGO}" alt="PayPal" width="85" height="24">`;
      action = `<h3>Step 2 of 2 · Pay</h3>`
        + (o.pay === "retry" ? `<p class="warn">PayPal could not open a checkout just now. Nothing has been charged. Please try again in a moment${o.payFailureRef ? ` (PayPal reference ${esc(o.payFailureRef)})` : ""}.</p>` : "")
        + (o.approvalUrl && o.pay !== "button" && o.pay !== "retry" ? `<a class="pp" href="${esc(o.approvalUrl)}" rel="noreferrer">${mark}</a>`
          : `<form method="post" action="/order/${esc(token)}/pay" class="noprint" style="margin:0"><button type="submit" class="pp" style="border:0">${mark}</button></form>`)
        + `<p class="small muted">You pay on PayPal's own website (paypal.com), then PayPal brings you back to this page. This shop never receives your card or bank details.`
        + (o.payableUntil ?? o.expiresAt ? ` You can pay for this order until ${esc(when(o.payableUntil ?? o.expiresAt))}.` : "") + `</p>`
        + `<p class="small muted">Paid already? Reload this page to see your receipt.</p>`;
    } else if (o.checkout === "requested") {
      action = `<p>Preparing your PayPal checkout… this page refreshes by itself.</p>`;
    }

    const stepNames = product ? ["Confirm", "Pay with PayPal", "Download"] : ["Confirm", "Pay with PayPal", "Delivery"];
    const stepDone = [!statements.length || !!c.recorded, paid, delivered];
    const now = stepDone.findIndex((d) => !d);
    const steps = closed ? "" : `<ol class="steps noprint">${stepNames.map((n, i) => `<li class="${stepDone[i] ? "done" : i === now ? "now" : ""}">${i + 1}. ${n}${stepDone[i] ? " ✓" : ""}</li>`).join("")}</ol>`;

    const summary = `<div class="card"><h2>Order summary</h2>`
      + `<div class="line"><span>${esc(o.item)}</span><span>${total}</span></div>`
      + `<div class="total"><strong>Total</strong><span class="price">${total}</span></div>`
      + `<p>${pill}${o.dueAt ? ` <span class="muted small">due by ${esc(String(o.dueAt).slice(0, 10))}</span>` : ""}</p>${action}</div>`;

    // ── the receipt, once PayPal has captured the payment ──
    const receipt = o.paidAt ? `<div class="card"><h2>Receipt</h2><dl class="receipt">`
      + `<dt>Order reference</dt><dd>${ref}</dd><dt>Item</dt><dd>${esc(o.item)}</dd><dt>Amount paid</dt><dd>${total}</dd>`
      + `<dt>Paid on</dt><dd>${esc(when(o.paidAt))}</dd><dt>Paid with</dt><dd>PayPal</dd>`
      + (o.paypalTransactionId ? `<dt>PayPal transaction ID</dt><dd>${esc(o.paypalTransactionId)}</dd>` : "")
      + (o.refundedMinor ? `<dt>Refunded</dt><dd>${money(o.refundedMinor, o.currency)} (through PayPal)</dd>` : "")
      + (brand ? `<dt>Seller</dt><dd>${esc(brand)}</dd>` : "")
      + `</dl><p class="small muted">The seller's legal name and address are under "Who you're buying from" below.</p>`
      + `<p class="noprint"><button type="button" id="print">Print or save this receipt</button></p></div>` : "";

    const files = paid && downloads.length
      ? `<div class="card"><h2>Your download</h2>${downloads.map((f) => `<a class="dl" href="/order/${esc(token)}/file/${esc(f.deliveryId)}/${esc(f.fileNo)}">Download ${esc(f.fileName)} (${kb(f.sizeBytes)})</a>`
          + (f.until ? `<p class="small muted">Available here until ${esc(String(f.until).slice(0, 10))}.</p>` : "")).join("")}</div>`
      : paid && product && !askConsent && !delivered
        ? `<div class="card"><h2>Your download</h2><p>Payment received — your download is being prepared. It appears on this page and is emailed to the address on your PayPal account. Reload this page in a minute or two.</p></div>`
        : "";

    page(res, 200, `Your order — ${o.item}`, `<div class="top"><span class="brand">${esc(brand || "Your order")}</span><span class="muted small">Order ${ref}</span></div>`
      + `<h1>${esc(off?.title ?? o.item)}</h1>${off?.summary ? `<p class="muted">${esc(off.summary)}</p>` : ""}`
      + steps + summary + receipt + files
      + (o.scope ? `<div class="card"><h2>Agreed scope</h2>${para(o.scope)}</div>` : "")
      + (off ? await this.buying(token, off, product, o) : "")
      + await this.repoHtml("order", token)
      + threadHtml(r.thread)
      + (paid && conversation.open !== false ? `<div class="noprint">${messageForm(`/order/${token}/message`, nonce)}</div>` : "")
      + (paid && conversation.open === false ? `<div class="card noprint"><p class="muted">${esc(String(conversation.note ?? "This order's conversation is closed."))}</p></div>` : "")
      + this.sellerCard(r.seller, off, ref, paid)
      + this.rightsCard(off, product)
      + (!askConsent && c.recorded && statements.length ? `<div class="card"><h2>Your confirmation</h2><p class="muted small">Recorded ${esc(when(c.at))}</p><ul>${statements.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : "")
      + (o.paidAt ? `<script nonce="${nonce}">document.getElementById('print').addEventListener('click',function(){window.print()});</script>` : ""),
      null, { ...(paid || o.paidAt ? { nonce } : {}), paypalLogo: action.includes(PAYPAL_LOGO),
        ...((o.pay === "preparing" || o.pay === "processing") && !askConsent ? { refreshS: 3 } : (o.checkout === "requested" && !o.pay) || confirming ? (askConsent ? {} : { refreshS: 4 }) : {}) });
  }

  /** v97: what the order buys — the offer's promises, and what is inside its download, read from the file itself. */
  private async buying(token: string, off: Record<string, any>, product: boolean, o: Record<string, any>): Promise<string> {
    const files = Array.isArray(off.files) ? off.files as Array<Record<string, any>> : [];
    const previews = (Array.isArray(off.previews) ? off.previews as Array<Record<string, unknown>> : []).filter((f) => /^image\/(png|jpeg)$/.test(String(f.contentType)));
    const names: string[] = [];
    let inside = "";
    for (const f of files.slice(0, 10)) {
      names.push(String(f.fileName));
      const ct = await this.contents(token, f);
      inside += `<li><strong>${esc(f.fileName)}</strong> — ${esc(formatName(String(f.fileName)))}, ${kb(f.sizeBytes)}`;
      if (ct && ct.members.length && ext(String(f.fileName)) === "zip") inside += `<p class="small muted" style="margin:.3rem 0">Inside it:</p>`;
      if (ct) inside += `<ul class="inside">${ct.members.map((m) => {
        names.push(m.name);
        const head = ext(String(f.fileName)) === "zip" ? `<strong>${esc(m.name)}</strong> — ${esc(formatName(m.name))}, ${kb(m.sizeBytes)}` : "";
        if (m.kind === "table") return `<li>${head}${head ? "<br>" : ""}<span class="small">${m.columns.length} columns, ${m.rows} row${m.rows === 1 ? "" : "s"} below the headings. Columns:</span><ul class="cols">${m.columns.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></li>`;
        if (m.kind === "text") return `<li>${head}<pre class="peek">${esc(m.lines.join("\n"))}${m.more ? "\n…" : ""}</pre></li>`;
        return `<li>${head}</li>`;
      }).join("")}${ct.truncated ? `<li class="muted small">…and more files</li>` : ""}</ul>`;
      inside += `</li>`;
    }
    const needs = needsFor(names);
    return `<div class="card"><h2>What you're buying</h2>`
      + (brand(off) ? `<p class="muted small" style="margin:0">${esc(off.brand)} · ${esc(off.title)}</p>` : "")
      + (off.audience ? `<p><strong>For:</strong> ${esc(off.audience)}</p>` : "")
      + (Array.isArray(off.deliverables) && off.deliverables.length ? `<h3>Included</h3><ul>${(off.deliverables as string[]).map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : "")
      + (inside ? `<h3>The download</h3><ul class="inside">${inside}</ul>` : "")
      + (needs.length ? `<h3>What you need</h3><ul>${needs.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "")
      + `<h3>Delivery</h3><p>${product
        ? `A download on this page after PayPal confirms your payment; the seller also emails it to the address on your PayPal account. It stays available here for ${DELIVERY_RETENTION_DAYS} days after delivery.`
        : o.turnaroundDays ? `Delivered within ${esc(o.turnaroundDays)} days of payment, on this page and by email.` : "On this page and by email, as agreed with the seller."}</p>`
      + (previews.length ? `<h3>Preview</h3>${previews.map((f) => `<p><img src="/order/${esc(token)}/preview/${esc(f.n)}" alt="${esc(f.fileName)}" style="max-width:100%;border-radius:8px;border:1px solid #e3e5e8"></p>`).join("")}` : "")
      + (off.description ? `<h3>From the seller</h3>${para(off.description)}` : "")
      + `</div>`;
  }

  /** The legal seller (as the owner registered them), the brand's own support address and the AI notice. */
  private sellerCard(seller: unknown, off: Record<string, any> | null, ref: string, paid: boolean): string {
    if (!seller && !off?.supportEmail) return "";
    return `<div class="card"><h2>Who you're buying from</h2>${seller ? `<p>${esc(seller).replace(/\n/g, "<br>")}</p>` : ""}`
      + (off?.about ? `<p class="muted small">${esc(off.about)}</p>` : "")
      + (off?.supportEmail ? (() => {
        const subject = `${off.supportSubject ?? ""}Order ${ref}`;
        return `<p>Questions? Email <a href="mailto:${esc(off.supportEmail)}?subject=${esc(encodeURIComponent(subject))}">${esc(off.supportEmail)}</a> with the subject <strong>${esc(subject)}</strong>${paid ? ", or send a message on this page" : ""}.</p>`;
      })() : "")
      + `</div>`;
  }

  /** The seller's terms and the buyer's statutory rights (UK: Consumer Contracts Regulations 2013, Consumer Rights Act 2015). */
  private rightsCard(off: Record<string, any> | null, product: boolean): string {
    return `<div class="card"><h2>Refunds and your rights</h2>`
      + (off?.terms ? `<p><strong>Seller's terms:</strong> ${esc(off.terms)}</p>` : "")
      + (product
        ? `<p>Because this is a digital download, your 14-day right to cancel ends once the download is made available to you — you confirm this before paying.</p>`
          + `<p>If the download is faulty or not as described, you are entitled to a repair or a replacement, or, if that is not possible, some or all of your money back. Contact the seller with your order reference. Refunds are paid back through PayPal.</p>`
        : `<p>If the work is not as agreed or not done with reasonable care and skill, you are entitled to have it put right, or, if that is not possible, some or all of your money back. Contact the seller with your order reference. Refunds are paid back through PayPal.</p>`)
      + `<p class="small muted">These rights are in addition to the seller's terms.</p></div>`;
  }

  /** The contents of one deliverable (bounded; read once per file digest). */
  private async contents(token: string, f: Record<string, any>): Promise<Contents | null> {
    const e = ext(String(f.fileName));
    if (!["zip", "csv", "txt", "md"].includes(e) || Number(f.sizeBytes) > ORDER_CONTENTS_MAX_BYTES || typeof f.sha256 !== "string") return null;
    if (this.contentsCache.has(f.sha256)) return this.contentsCache.get(f.sha256)!;
    const r = await this.port.publicCall("svc_order_sample", [token, "contents", Number(f.n)]);
    const v = r.ok && r.sha256 === f.sha256 ? readContents(String(r.fileName), Buffer.from(String(r.contentB64), "base64")) : null;
    if (r.ok) {
      if (this.contentsCache.size >= 64) this.contentsCache.delete(this.contentsCache.keys().next().value!);
      this.contentsCache.set(f.sha256, v);
    }
    return v;
  }

  /** v97: an order's preview image (the offer's sample), by the order's access code. */
  private async orderPreview(res: http.ServerResponse, token: string, n: number): Promise<void> {
    const r = await this.port.publicCall("svc_order_sample", [token, "preview", n]);
    if (!r.ok || !/^image\/(png|jpeg)$/.test(String(r.contentType))) { res.writeHead(404).end(); return; }
    this.sendFile(res, String(r.fileName), String(r.contentType), String(r.contentB64), true);
  }

  /** v98: the buyer is ready to pay — straight to PayPal when the link was confirmed recently, else back to the page, which shows
   *  "opening a fresh PayPal checkout" until custody has reused or replaced the PayPal order (seconds). */
  private async payNow(res: http.ServerResponse, token: string, origin: string): Promise<void> {
    const r = await this.port.publicCall("svc_order_pay", [token, origin]);
    if (!r.ok && r.code === "FLEET_NOT_FOUND") { page(res, 404, "Not found", "<h1>Not found</h1><p>This order page does not exist.</p>", null); return; }
    const to = r.ok && typeof r.redirect === "string" && /^https:\/\/www\.(sandbox\.)?paypal\.com\//.test(r.redirect) ? r.redirect : `/order/${token}`;
    res.writeHead(303, { location: to, "cache-control": "no-store", "referrer-policy": "no-referrer" }).end();
  }

  /** v108: the buyer's country, chosen on the order page before payment. */
  private async country(req: http.IncomingMessage, res: http.ServerResponse, token: string, origin: string): Promise<void> {
    const c = countryOf(await this.body(req));
    if (!c) { page(res, 400, "Please choose your country", `<h1>Please choose your country</h1><p><a href="/order/${esc(token)}">Back to your order</a></p>`, null); return; }
    const r = await this.port.publicCall("svc_order_country", [token, origin, c]);
    if (!r.ok && r.code === "FLEET_COUNTRY_UNSUPPORTED") { page(res, 409, "Not available", COUNTRY_REFUSED(c) + `<p><a href="/order/${esc(token)}">Back to your order</a></p>`, null); return; }
    if (!r.ok && r.code === "FLEET_NOT_FOUND") { page(res, 404, "Not found", "<h1>Not found</h1><p>This order page does not exist.</p>", null); return; }
    res.writeHead(303, { location: `/order/${token}`, "cache-control": "no-store", "referrer-policy": "no-referrer" }).end();
  }

  /** v82: the buyer's consent given on the order page (a quoted service, or an order made outside an offer page). */
  private async consent(req: http.IncomingMessage, res: http.ServerResponse, token: string, origin: string): Promise<void> {
    const b = await this.body(req);
    const version = b && b.c1 === "yes" && b.c2 === "yes" && b.consent === BUYER_CONSENT_VERSION ? BUYER_CONSENT_VERSION : null;
    if (!version) {
      page(res, 400, "Please confirm", `<h1>Please tick both boxes</h1><p>Both statements need your confirmation before we can continue.</p><p><a href="/order/${esc(token)}">Back to your order</a></p>`, null);
      return;
    }
    const country = countryOf(b);
    if (country) {
      const cr = await this.port.publicCall("svc_order_country", [token, origin, country]);
      if (!cr.ok && cr.code === "FLEET_COUNTRY_UNSUPPORTED") { page(res, 409, "Not available", COUNTRY_REFUSED(country) + `<p><a href="/order/${esc(token)}">Back to your order</a></p>`, null); return; }
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
