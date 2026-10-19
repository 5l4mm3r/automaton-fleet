/**
 * Schema v97 — the customer's checkout, end to end in a real browser (2026-10-19, owner: the order page "screams scam").
 *
 * The live proof's path exactly: a published product (a passing fleet-qa-3 review of its files, the legal seller, the
 * agent's brand and support address), the owner's proof purchase while sales are closed, then the buyer's order page served
 * by the real PublicPages handler AS THE SERVICE ROLE, driven by Chrome:
 *   1. the page says what is bought (brand, title, what is inside the ZIP read from the file, what is needed, delivery),
 *      the total, the seller, support and refund rights; it asks the consent the law requires before any payment button;
 *   2. consent ticked and confirmed → PayPal's own gold button with PayPal's hosted logo, leading to the genuine
 *      paypal.com approval link (intercepted here: no real PayPal);
 *   3. back from PayPal while the payment is confirmed: "processing — please don't pay again", refreshing;
 *   4. captured: the receipt (reference, amount, time, PayPal transaction id, seller); the download being prepared;
 *   5. delivered by the offer pass and the mail: the download button, the file itself;
 *   6. a closed checkout: "no payment was taken".
 * Desktop and mobile screenshots of every state go to FLEET_V97_SHOTS (when set). No order token is printed or shown.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, autoCapabilityChecks, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { liveRail } from "./fixtures/custody-signer.js";
import { PgFleetStore } from "../../fleet/postgres/store.js";
import { PublicPages } from "../../fleet/service/public-pages.js";
import { PgIdentityGateway } from "../../fleet/identity/gateway.js";
import { IdentityBroker } from "../../fleet/identity/broker.js";
import { SimulatedSharedMailProvider } from "../../fleet/identity/providers.js";
import { initIdentityState, openIdentityState, openProviderVault } from "../../fleet/identity/main.js";
import { trackerZip } from "./fixtures/tracker-zip.js";

const PG_BIN = findPgBin();
const CHROME = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => fs.existsSync(p));
const SHOTS = process.env.FLEET_V97_SHOTS;
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

// The live offer's own words (2026-10-19); the seller is a placeholder.
const OFFER = {
  title: "UK Landlord Compliance Tracker (England) – gas, EICR, EPC & rent-review spreadsheet",
  summary: "Spreadsheet template that tracks gas safety, EICR and EPC due dates per property with OVERDUE / DUE SOON flags, plus a rent-increase log.",
  description: "Import the two CSV sheets into Excel or Google Sheets. Formulas calculate due dates (gas 12 months, EICR 5 years, EPC 10 years validity) and flag OVERDUE / DUE SOON. Includes a rent increase log. Intervals checked against gov.uk guidance. An organising tool, not legal advice. Produced by an AI agent.",
  audience: "UK private landlords in England with a few properties",
  deliverables: ["properties.csv tracker", "rent_log.csv", "README"],
  terms: "Digital download, no refunds once delivered unless the file is faulty. Not legal advice.",
};

describe.skipIf(!PG_BIN || !CHROME)("v97: the customer's checkout in a real browser, as the service role (PostgreSQL + Chrome)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let F: Founder;
  let G: Founder;
  let label = "";
  let controller: PgFleetStore;
  let custody: pg.Pool;
  let server: http.Server;
  let base = "";
  let dir: string;
  let igw: PgIdentityGateway;
  let broker: IdentityBroker;
  let slug = "";
  const shared = new SimulatedSharedMailProvider("fleet@shared.fleet-mail.test");
  const zipBytes = trackerZip();
  const idem = () => `k-${crypto.randomUUID()}`;
  const cx = async (fn: string, args: unknown[]) => (await custody.query(`SELECT fleet.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) AS r`, args)).rows[0].r;
  const checkoutOf = (token: string) => R.one<string>(`(SELECT checkout_id::text FROM fleet.fleet_customer_orders WHERE access_token = $1)`, [token]);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000, simulatedSettlement: false, outwardHeld: true });
    autoCapabilityChecks(R);
    [F, G] = R.founders;
    await R.store.grantServiceRole();
    await R.store.grantCustodyRole();
    controller = new PgFleetStore({ connectionString: R.pgc.serviceUrl, schema: "fleet", applicationName: "test-service" });
    custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 2, options: "-c search_path=fleet" });
    await liveRail(R.owner, "fleet", OWNER);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v97-"));
    fs.chmodSync(dir, 0o700);
    initIdentityState(dir);
    igw = new PgIdentityGateway({ connectionString: R.pgc.identityUrl });
    const { vault, ownerVault } = openIdentityState(dir);
    broker = new IdentityBroker(igw, vault, { mail: shared, ownerVault, providerVault: openProviderVault(dir), stateFile: path.join(dir, "pending.json") });
    await broker.tick();
    // The seller (owner facts), the agent's brand and its support address — then the product, published on a passing review.
    expect((await R.econ(F, "venture.create", { key: "landlords", model: "digital_product", offer: "landlord tracker", state: "selected" })).ok).toBe(true);
    await R.q(`SELECT fleet.fleet_admin_public_site_set($1, 'Automaton Fleet', 'operator:test')`, ["https://shop.fleet.test"]);
    await R.q(`SELECT fleet.fleet_admin_seller_set($1::jsonb, 'operator:test')`, [JSON.stringify({ legalForm: "individual", legalName: "A. Seller",
      postalAddress: "1 Example Street\nLondon\nEX1 1AA" })]);
    expect((await R.econ(F, "identity.create", { kind: "venture_identity", ventureKey: "landlords", displayName: "LandlordTrack",
      bio: "Simple spreadsheet tools for UK private landlords, produced by an AI agent." })).ok).toBe(true);
    expect((await R.econ(F, "mailbox.provision", { ventureKey: "landlords", idempotencyKey: idem() })).ok).toBe(true);
    const o = await R.econ(F, "offer.create", { venture: "landlords", kind: "product", priceMinor: 500, ...OFFER });
    expect(o.ok, JSON.stringify(o)).toBe(true);
    expect((await R.econ(F, "offer.file", { offerId: o.offer.offerId, role: "deliverable", fileName: "tracker.zip", contentType: "application/zip", contentB64: zipBytes.toString("base64") })).ok).toBe(true);
    const rv = await R.econ(F, "review.record", { subject: "offer", offerId: o.offer.offerId, files: [{ name: "tracker.zip", sha256: sha(zipBytes), sizeBytes: zipBytes.length }],
      automated: { inspector: "fleet-qa-3", ok: true, files: [{ path: "tracker.zip", sha256: sha(zipBytes), sizeBytes: zipBytes.length, detectedType: "zip", ok: true, checks: [{ id: "zip_integrity", status: "pass", detail: "3 members" }] }] },
      criteria: [{ criterion: "Calculations reconcile", met: true, evidence: "recalculated" }, { criterion: "Clear instructions for the buyer", met: true, evidence: "read the README" },
        ...OFFER.deliverables.map((d) => ({ criterion: d, met: true, evidence: "opened and checked" }))], verdict: "pass" });
    expect(rv.ok, JSON.stringify(rv)).toBe(true);
    const p = await R.econ(F, "offer.publish", { offerId: o.offer.offerId, reviewId: rv.reviewId });
    expect(p.ok, JSON.stringify(p)).toBe(true);
    slug = p.offer.slug;
    const pages = new PublicPages(controller);
    server = http.createServer((req, res) => void pages.handle(req, res, (req.url ?? "/").split("?")[0], "127.0.0.1"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    label = await R.one<string>(`fleet.fleet_agent_label($1)`, [F.id]);
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  }, 300_000);
  afterAll(async () => {
    server?.close(); await igw?.close(); await custody?.end(); await controller?.close(); await R?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the whole journey: consent → PayPal's button → confirming → receipt → download; a closed checkout took nothing", async () => {
    const { chromium } = await import("playwright-core");
    const proof = (await R.q(`SELECT fleet.fleet_admin_offer_proof_buy($1, $2) AS r`, [slug, OWNER]))[0].r;
    expect(proof.ok, JSON.stringify(proof)).toBe(true);
    const token = String(proof.page).split("/").pop()!;
    const checkoutId = await checkoutOf(token);
    // Custody opens the PayPal order (as live: the checkout is open before the buyer's consent).
    const ppOrder = `ORD${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
    const approval = `https://www.paypal.com/checkoutnow?token=${ppOrder}`;
    expect((await cx("cx_paypal_checkout_update", ["custody-executor", checkoutId, "open", ppOrder, approval, null])).ok).toBe(true);

    const b = await chromium.launch({ executablePath: CHROME, headless: true });
    const shots = async (name: string) => {
      if (!SHOTS) return;
      for (const [k, vp] of [["desktop", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 844 }]] as const) {
        const q = await b.newPage({ viewport: vp, deviceScaleFactor: k === "mobile" ? 2 : 1 });
        await q.goto(`${base}/order/${token}`, { waitUntil: "load" });
        await q.screenshot({ path: path.join(SHOTS, `${name}-${k}.png`), fullPage: true });
        await q.close();
      }
    };
    try {
      const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
      const paypalVisits: string[] = [];
      await p.route("https://www.paypal.com/**", async (r) => { paypalVisits.push(r.request().url()); await r.fulfill({ status: 200, contentType: "text/html", body: "<h1>PayPal (test stand-in)</h1>" }); });

      // 1. What is bought, the total, consent first — no payment button yet.
      await p.goto(`${base}/order/${token}`);
      let text = await p.innerText("body");
      for (const s of ["LandlordTrack", OFFER.title, "Order summary", "Total", "£5.00", "Not paid yet", "Step 1 of 2", "What you're buying", "properties.csv tracker",
        "tracker.zip", "ZIP archive", "Inside it", "properties.csv", "14 columns, 1 row below the headings", "Gas safety due", "rent_log.csv", "8 columns",
        "UK Landlord Compliance Tracker (England)", "A spreadsheet app that opens CSV files", "open it with your computer's or phone's file manager",
        "after PayPal confirms your payment", "30 days", "Who you're buying from", "Sold by A. Seller under the brand LandlordTrack", "Questions? Email",
        "Refunds and your rights", OFFER.terms, "faulty or not as described", "Refunds are paid back through PayPal", "autonomous AI agent"]) expect(text, s).toContain(s);
      expect(text).not.toContain("12 Example St");                 // headings only: no row of the product before payment
      // Support: the shared address (never a routing tag), with the agent's current name as the subject.
      expect(text).toContain(`Customer support: ${shared.address} (email subject: "${label} - your question")`);
      const ref = await R.one<string>(`(SELECT upper(left(replace(order_id::text, '-', ''), 8)) FROM fleet.fleet_customer_orders WHERE access_token = $1)`, [token]);
      expect(text).toContain(`Questions? Email ${shared.address} with the subject ${label} - Order ${ref}`);
      expect(await p.$eval("a[href^='mailto:']", (a) => a.getAttribute("href"))).toBe(`mailto:${shared.address}?subject=${encodeURIComponent(`${label} - Order ${ref}`)}`);
      expect(text).not.toMatch(/\+[0-9a-f]{10}@/);
      expect(await p.$$("a.pp")).toHaveLength(0);
      expect(text).not.toContain(token);
      await shots("1-consent");

      // 2. Consent → PayPal's own button, to the genuine approval link.
      for (const x of await p.$$("form[action$='/consent'] input[type=checkbox]")) await x.check();
      await Promise.all([p.waitForURL(`${base}/order/${token}`), p.click("form[action$='/consent'] button[type=submit]")]);
      text = await p.innerText("body");
      expect(text).toContain("Step 2 of 2");
      expect(text).toContain("You pay on PayPal's own website (paypal.com)");
      expect(text).toContain("Your confirmation");
      const btn = await p.$("a.pp");
      expect(await btn!.innerText()).toMatch(/Pay £5\.00 with/);
      expect(await btn!.getAttribute("href")).toBe(approval);
      expect(await p.$eval("a.pp img", (i) => [i.getAttribute("src"), i.getAttribute("alt")])).toEqual(["https://www.paypalobjects.com/paypal-ui/logos/svg/paypal-color.svg", "PayPal"]);
      const csp = (await (await fetch(`${base}/order/${token}`)).headers.get("content-security-policy")) ?? "";
      expect(csp).toContain("img-src 'self' https://www.paypalobjects.com;");
      expect(csp).not.toMatch(/script-src/);                     // no script on the unpaid page
      await shots("2-pay");
      await Promise.all([p.waitForURL(/paypal\.com/), btn!.click()]);
      expect(paypalVisits).toEqual([approval]);

      // 3. The buyer approved on PayPal and is back while the capture is confirmed.
      expect((await cx("cx_paypal_checkout_update", ["custody-executor", checkoutId, "approved", null, null, null])).ok).toBe(true);
      await p.goto(`${base}/order/${token}`);
      text = await p.innerText("body");
      expect(text).toContain("Processing your payment");          // v99 wording
      expect(text).toContain("Please don't pay again");
      expect(await p.$$("a.pp")).toHaveLength(0);
      expect(await p.$eval("meta[http-equiv=refresh]", (m) => m.getAttribute("content"))).toBe("4");
      await shots("3-confirming");

      // 4. Captured (PayPal's evidence through custody): the receipt; the download being prepared.
      const cap = `CAP${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
      expect((await cx("cx_paypal_capture_record", ["custody-executor", checkoutId, cap, "COMPLETED", 500, 30, "GBP", "capture_response"])).ok).toBe(true);
      expect((await cx("cx_paypal_buyer_record", ["custody-executor", checkoutId, JSON.stringify({ email_address: "owner@example.test", name: { given_name: "Owen", surname: "Owner" },
        address: { country_code: "GB" }, payer_id: "PAYEROWN0001" })])).recorded).toBe(true);
      await p.goto(`${base}/order/${token}`);
      text = await p.innerText("body");
      for (const s of ["Paid", "Receipt", "Order reference", "Amount paid", "Paid on", "PayPal transaction ID", cap, "your download is being prepared"]) expect(text, s).toContain(s);
      expect(await p.$$("a.pp")).toHaveLength(0);
      await shots("4-paid");

      // 5. The offer pass delivers the reviewed files; the mail goes; the download is on the page.
      expect(await R.one(`fleet.svc_offer_tick(20)`)).toMatchObject({ ok: true, delivered: 1 });
      await broker.tick();
      const mail = shared.outbox.at(-1)!;
      expect(mail.to).toEqual(["owner@example.test"]);
      // The buyer's email: the agent's name opens the subject; From the shared address, no routing-tag Reply-To.
      expect(mail.subject).toBe(`${label} - Your order: ${OFFER.title}`);
      expect(mail.from).toBe(shared.address);
      expect(mail.replyTo ?? null).toBeNull();
      expect(mail.body).toContain(`Customer support: ${shared.address} (email subject: "${label} - your question")`);
      expect(mail.body).not.toMatch(/\+[0-9a-f]{10}@/);
      await p.goto(`${base}/order/${token}`);
      text = await p.innerText("body");
      expect(text).toContain("Paid · ready to download");
      expect(text).toContain("Download tracker.zip");
      expect(text).toMatch(/Available here until \d{4}-\d{2}-\d{2}/);
      const [dl] = await Promise.all([p.waitForEvent("download"), p.click("a.dl")]);
      const saved = path.join(dir, "got.zip");
      await dl.saveAs(saved);
      expect(sha(fs.readFileSync(saved))).toBe(sha(zipBytes));
      await shots("5-delivered");

      // 6. A checkout that closed unpaid (a second order of the offer; the first is done).
      const again = (await R.q(`SELECT fleet.fleet_admin_offer_proof_buy($1, $2) AS r`, [slug, OWNER]))[0].r;
      const t2 = String(again.page).split("/").pop()!;
      expect(t2).not.toBe(token);
      await R.q(`UPDATE fleet.fleet_paypal_checkouts SET status = 'expired', closed_at = now() WHERE checkout_id = $1`, [await checkoutOf(t2)]);
      await p.goto(`${base}/order/${t2}`);
      text = await p.innerText("body");
      expect(text).toContain("Checkout closed");
      expect(text).toContain("No payment was taken.");
      expect(await p.$$("a.pp, form[action$='/consent']")).toHaveLength(0);
      if (SHOTS) for (const [k, vp] of [["desktop", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 844 }]] as const) {
        const q = await b.newPage({ viewport: vp, deviceScaleFactor: k === "mobile" ? 2 : 1 });
        await q.goto(`${base}/order/${t2}`);
        await q.screenshot({ path: path.join(SHOTS, `6-closed-${k}.png`), fullPage: true });
        await q.close();
      }
    } finally { await b.close(); }
  }, 240_000);

  it("a buyer's email to the shared address reaches the agent its subject names (current name; renamed → the new name; shared names → owner)", async () => {
    const routed = async (subject: string) => {
      // A new sender each time (an established correspondent would route by rule 4 regardless of the subject).
      shared.deliver({ from: `Buyer <b${crypto.randomBytes(4).toString("hex")}@customer.test>`, to: [shared.address], subject, body: "A question about my order" });
      await broker.tick();
      return (await R.q(`SELECT agent_id, routing FROM fleet.fleet_agent_mail WHERE direction = 'in' AND subject = $1 ORDER BY received_at DESC LIMIT 1`, [subject]))[0];
    };
    expect(await routed(`${label} - Order 1234ABCD`)).toMatchObject({ agent_id: F.id, routing: "subject" });
    expect(await routed(`Re: ${label.toUpperCase()}: is the EPC column right?`)).toMatchObject({ agent_id: F.id, routing: "subject" });
    expect(await routed(`${label}0 - not this agent`)).toMatchObject({ agent_id: null, routing: "unassigned" });
    expect(await routed("Question about a landlord tracker")).toMatchObject({ agent_id: null, routing: "unassigned" });
    // Renamed: the pages and emails use the new name at once; the new name routes, the old one no longer does.
    await R.q(`SELECT fleet.fleet_admin_agent_rename($1, 'Landlord Desk', $2)`, [F.id, OWNER]);
    expect((await R.q(`SELECT fleet.fleet_storefront(venture_id) AS s FROM fleet.fleet_ventures WHERE venture_key = 'landlords'`))[0].s)
      .toMatchObject({ supportEmail: shared.address, supportSubject: "Landlord Desk - " });
    expect(await routed("Landlord Desk - Order 1234ABCD")).toMatchObject({ agent_id: F.id, routing: "subject" });
    expect(await routed(`${label} - after the rename`)).toMatchObject({ agent_id: null, routing: "unassigned" });
    // Two living agents with the same name: never guessed.
    await R.q(`SELECT fleet.fleet_admin_agent_rename($1, 'Landlord Desk', $2)`, [G.id, OWNER]);
    expect(await routed("Landlord Desk - which of you?")).toMatchObject({ agent_id: null, routing: "unassigned" });
  });
});
