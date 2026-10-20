/**
 * The public order and enquiry routes as production runs them (2026-10-19, launch-readiness §1 row 23): the real
 * PublicPages handler over HTTP, backed by the controller's store connected AS THE SERVICE ROLE (fleet_service_login),
 * with the privilege audit the controller runs at startup and in readiness.
 *  - the service role's grants pass the controller's own audit (startup and readiness agree with the declared list);
 *  - a grant outside the declared list is caught by that same audit (what blocked the live interim grant), and its
 *    removal clears it;
 *  - an order page and an enquiry page load (200) as the service role — the v89 call that failed live included;
 *  - access codes isolate records: with a repository-access request on file for one enquiry, that enquiry's page shows
 *    it; another enquiry's page, an order page and unknown codes show nothing of it (unknown codes: 404).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { liveRail } from "./fixtures/custody-signer.js";
import { PgFleetStore } from "../../fleet/postgres/store.js";
import { problemsFor } from "../../fleet/postgres/privileges.js";
import { PublicPages } from "../../fleet/service/public-pages.js";

const PG_BIN = findPgBin();
const CHROME = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => fs.existsSync(p));

describe.skipIf(!PG_BIN)("public order and enquiry routes as the service role, with the controller's own privilege audit (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let F: Founder;
  let controller: PgFleetStore;
  let server: http.Server;
  let base = "";
  const tokens = { order: "", enquiryA: "", enquiryB: "" };
  const REPO = "acme/ledger";
  const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, body: await r.text() }; };
  const startupProblems = async () => {
    const who = await controller.connectionIdentity();
    const audit = await controller.auditPrivileges({ agentRoles: [], serviceRoles: ["fleet_service", who.user] });
    return problemsFor(audit, ["fleet_service", who.user]);
  };

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, simulatedSettlement: false });
    [F] = R.founders;
    await R.store.grantServiceRole();
    controller = new PgFleetStore({ connectionString: R.pgc.serviceUrl, schema: "fleet", applicationName: "test-service" });
    await liveRail(R.owner, "fleet", OWNER, { capabilities: ["payouts", "receive_payments", "refunds"] });
    expect((await R.econ(F, "venture.create", { key: "ledgers", model: "service", offer: "bookkeeping fixes", state: "selected" })).ok).toBe(true);
    const o = await R.econ(F, "offer.create", { venture: "ledgers", kind: "service", title: "Spreadsheet and script fixes", summary: "I fix your bookkeeping scripts.",
      description: "Describe the problem; I fix it and open a pull request.", deliverables: ["A tested pull request"], priceMinor: 4_000, turnaroundDays: 3,
      terms: "Refunds if I cannot fix it." });
    for (const k of ["enquiryA", "enquiryB"] as const) {
      tokens[k] = crypto.randomBytes(32).toString("hex");
      await R.q(`INSERT INTO fleet.fleet_offer_enquiries (offer_id, agent_id, access_token, buyer_name, buyer_email, brief) VALUES ($1, $2, $3, 'Ada Customer', 'ada@example.test',
        'My ledger script totals VAT wrongly; please fix it.')`, [o.offer.offerId, F.id, tokens[k]]);
    }
    // A repository-access request on file for enquiry A only (populated records for the isolation checks).
    const ea = (await R.q(`SELECT enquiry_id FROM fleet.fleet_offer_enquiries WHERE access_token = $1`, [tokens.enquiryA]))[0].enquiry_id;
    expect(await R.econ(F, "code.request_access", { enquiryId: ea, repo: REPO, baseBranch: "main", purpose: "Fix the VAT total", durationDays: 7 }))
      .toMatchObject({ ok: true, status: "requested" });
    // An order with its own access code (a checkout on the treasury rail, then the order row as the offer page makes it).
    const k = await R.one(`fleet.fleet_econ_paypal_checkout($1, $2::jsonb)`, [F.id, JSON.stringify({ venture: "ledgers", amountMinor: 4_000, description: "Fix",
      idempotencyKey: `route:${crypto.randomBytes(8).toString("hex")}` })]);
    tokens.order = crypto.randomBytes(32).toString("hex");
    await R.q(`INSERT INTO fleet.fleet_customer_orders (agent_id, venture_id, checkout_id, item, amount_minor, currency, fulfilment, access_token, origin_hash, offer_id)
      SELECT agent_id, venture_id, checkout_id, description, amount_minor, currency, 'service', $2, encode(sha256('buyer'::bytea), 'hex'), $3
        FROM fleet.fleet_paypal_checkouts WHERE checkout_id = $1`, [k.checkout.checkoutId, tokens.order, o.offer.offerId]);
    const pages = new PublicPages(controller);
    server = http.createServer((req, res) => void pages.handle(req, res, (req.url ?? "/").split("?")[0], "127.0.0.1"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }, 300_000);
  afterAll(async () => { server?.close(); await controller?.close(); await R?.close(); });

  it("the service role's grants pass the controller's own audit (startup and readiness); one outside the declared list is caught", async () => {
    expect(await startupProblems()).toEqual([]);
    expect((await controller.connectionIdentity()).user).toBe("fleet_service_login");
    // The live incident's shape: a grant the declared list does not have makes startup refuse and readiness fail.
    await R.q(`GRANT EXECUTE ON FUNCTION fleet.fleet_admin_sales_set(boolean, text) TO fleet_service`);
    expect(await startupProblems()).toContain("fleet_service can EXECUTE fleet.fleet_admin_sales_set(boolean,text)");
    await R.q(`REVOKE EXECUTE ON FUNCTION fleet.fleet_admin_sales_set(boolean, text) FROM fleet_service`);
    expect(await startupProblems()).toEqual([]);
  });

  it("order and enquiry pages load as the service role; access codes isolate the records behind them", async () => {
    const order = await get(`/order/${tokens.order}`);
    expect(order.status, order.body.slice(0, 300)).toBe(200);
    expect(order.body).toContain("Your order");
    expect(order.body).not.toContain(REPO);
    const a = await get(`/enquiry/${tokens.enquiryA}`);
    expect(a.status, a.body.slice(0, 300)).toBe(200);
    expect(a.body).toContain(`Access to your code: ${REPO}`);
    const b = await get(`/enquiry/${tokens.enquiryB}`);
    expect(b.status).toBe(200);
    expect(b.body).not.toContain(REPO);
    for (const p of [`/order/${crypto.randomBytes(32).toString("hex")}`, `/enquiry/${crypto.randomBytes(32).toString("hex")}`,
      `/order/${tokens.enquiryA}`, `/enquiry/${tokens.order}`]) {
      const r = await get(p);
      expect(r.status, p).toBe(404);
      expect(r.body).not.toContain(REPO);
    }
    expect(await startupProblems()).toEqual([]);
  });

  // 2026-10-19: the live consent form was refused in a real browser ("cross-site request refused": Origin null under the
  // page's former no-referrer policy). A real Chrome submits it here: ticks both boxes, presses Confirm; the consent is
  // recorded as the service role and the buyer is back on the order page — never the refusal.
  it.skipIf(!CHROME)("a real browser submits the order page's consent form: accepted and recorded", async () => {
    const { chromium } = await import("playwright-core");
    const b = await chromium.launch({ executablePath: CHROME, headless: true });
    try {
      const p = await b.newPage();
      const posts: Array<{ status: number; origin: string | undefined; site: string | undefined }> = [];
      p.on("response", async (r) => { if (r.request().method() === "POST") { const h = await r.request().allHeaders(); posts.push({ status: r.status(), origin: h.origin, site: h["sec-fetch-site"] }); } });
      await p.goto(`${base}/order/${tokens.order}`);
      const boxes = await p.$$("form[action$='/consent'] input[type=checkbox]");
      expect(boxes.length).toBe(2);
      for (const x of boxes) await x.check();
      await p.selectOption("form[action$='/consent'] select[name=country]", "GB");          // v108: the buyer's country with the consent
      await Promise.all([p.waitForURL(`${base}/order/${tokens.order}`), p.click("form[action$='/consent'] button[type=submit]")]);
      const text = await p.textContent("body");
      expect(text).not.toContain("cross-site request refused");
      expect(posts).toEqual([expect.objectContaining({ status: 303, origin: base, site: "same-origin" })]);
      const o = (await R.q(`SELECT consent_kind, consent_version, consent_at FROM fleet.fleet_customer_orders WHERE access_token = $1`, [tokens.order]))[0];
      expect(o.consent_at).not.toBeNull();
      expect(await p.$$("form[action$='/consent']")).toHaveLength(0);   // the consent step is done
    } finally { await b.close(); }
  }, 120_000);
});
