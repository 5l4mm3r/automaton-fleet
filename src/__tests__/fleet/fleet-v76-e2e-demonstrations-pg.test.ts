/**
 * v76 end-to-end demonstrations — real founder tools and the real inspector (fleet-qa-1, sandboxed with the pinned
 * toolchain) against PostgreSQL, custody's cx_* calls and the identity broker on a simulated shared mailbox. SIMULATED
 * evidence: the buyer, PayPal (custody calls recorded directly) and the mailbox are fakes; nothing here touches production.
 *
 * Each demonstration shows the gate rejecting real defects and passing a sale-ready product (fixtures/sale-ready/*.py,
 * run by the agent's exec exactly as it would run its own scripts):
 * 1. Spreadsheet product — a #DIV/0! fails; a "valid" plain workbook whose saved values are wrong (cached 0, what previewers
 *    show) now FAILS; the sale-ready 12-month forecast + guide passes substantive acceptance cases; a review that leaves a
 *    listed deliverable unchecked is refused (FLEET_REVIEW_PROMISE_UNCOVERED); sold; delivered byte-identical.
 * 2. Downloadable course — a placeholder inside a lesson fails the bundle with its reason; the sale-ready course (three
 *    illustrated lessons with exercises and answers, a genuine 13-week workbook) passes its cases; sold; delivered intact.
 *    Recorded limitation: a thin but clean PDF is flagged (sparse_pages, advisory) but not blocked.
 * 3. Service — a reviewed work sample publishes it; the buyer's CSV reaches the workspace (path, never bytes); the tracker is
 *    built from it and an acceptance case checks the buyer's own totals; delivered; a revision request makes the review
 *    stale; the revised tracker is delivered on a fresh review.
 * Sales are opened by the owner first (closed by default). Skips without PostgreSQL, the dev toolchain or Landlock.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { BUYER_CONSENT_VERSION } from "../../fleet/storefront/consent.js";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, autoCapabilityChecks, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { liveRail } from "./fixtures/custody-signer.js";
import { PgIdentityGateway } from "../../fleet/identity/gateway.js";
import { IdentityBroker } from "../../fleet/identity/broker.js";
import { SimulatedSharedMailProvider } from "../../fleet/identity/providers.js";
import { initIdentityState, openIdentityState, openProviderVault } from "../../fleet/identity/main.js";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { FOUNDER_MANIFEST_V2 } from "../../fleet/capabilities.js";
import { runSandboxed } from "../../fleet/founder/exec-sandbox.js";
import { QA_INSPECTOR_VERSION } from "../../fleet/founder/qa/inspector.js";

const PG_BIN = findPgBin();
// fleet-qa-3 opens spreadsheets in the office application; on a host without one it says so (two warnings), never a silent pass.
const RENDERER = ["/usr/bin/soffice", "/usr/bin/libreoffice"].some((p) => fs.existsSync(p));
const SHEET_ISSUES = RENDERER ? [] : [expect.stringMatching(/^WARN sheet_as_displayed: not opened in an office application/), expect.stringMatching(/^WARN sheet_render: not rendered/)];
const DEV_TOOLS = path.join(os.homedir(), ".cache/automaton-fleet-tools/dev");
const HAVE_TOOLS = fs.existsSync(path.join(DEV_TOOLS, "site")) && fs.existsSync(path.join(DEV_TOOLS, "bin/fleet-python"));
const SALE_READY = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "sale-ready");
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

/** Defective drafts an agent might write first. */
const DIV0 = String.raw`
import xlsxwriter
wb = xlsxwriter.Workbook("deliver/draft.xlsx"); ws = wb.add_worksheet("Forecast")
ws.write_row("A1", ["Month", "Income", "Costs", "Net", "Margin"])
ws.write_row("A2", ["Jan", 2000, 1500]); ws.write_formula("D2", "=B2-C2", None, 500); ws.write_formula("E2", "=D2/F2")
wb.close(); print("BUILT")
`;
/** Opens, recalculates without an error cell — but every formula is saved with 0, which is what previewers show. */
const STALE = String.raw`
import xlsxwriter
wb = xlsxwriter.Workbook("deliver/plain.xlsx"); ws = wb.add_worksheet("Forecast")
ws.write_row("A1", ["Month", "Income", "Costs", "Net", "Closing"]); ws.write("G1", 1000)
for i, (m, a, b) in enumerate([("Jan", 2000, 1500), ("Feb", 2200, 1600), ("Mar", 1800, 1900)]):
    r = i + 2
    ws.write_row("A%d" % r, [m, a, b]); ws.write_formula("D%d" % r, "=B%d-C%d" % (r, r))
    ws.write_formula("E%d" % r, "=%s+D%d" % ("G1" if r == 2 else "E%d" % (r - 1), r))
wb.close(); print("BUILT")
`;
const DRAFT_COURSE = String.raw`
import zipfile
from reportlab.pdfgen import canvas
c = canvas.Canvas("deliver/l2.pdf"); c.drawString(60, 780, "Lesson 2: Building a 13-week forecast.")
c.drawString(60, 760, "TODO: write the worked example."); c.showPage(); c.save()
with zipfile.ZipFile("deliver/draft-course.zip", "w") as z: z.write("deliver/l2.pdf", "course/02-forecasting.pdf")
print("BUILT")
`;

describe.skipIf(!PG_BIN || !HAVE_TOOLS)("v76 e2e demonstrations: sale-ready product, course and service from the agent's workspace to a simulated buyer (real inspector)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let F: Founder;
  let svc: pg.Pool;
  let custody: pg.Pool;
  let dir: string;
  let ws: string;
  let igw: PgIdentityGateway;
  let broker: IdentityBroker;
  let box: FounderToolbox;
  let sandboxed = true;
  const shared = new SimulatedSharedMailProvider("fleet@shared.fleet-mail.test");
  let callNo = 0;
  const tool = (name: string, args: Record<string, unknown>) => box.execute({ id: `e2e${++callNo}`, name, arguments: args });
  const json = async (name: string, args: Record<string, unknown>) => { const r = await tool(name, args); expect(r.ok, r.output).toBe(true); return JSON.parse(r.output); };
  const exec = async (command: string, want = "BUILT") => { const r = await tool("exec", { command }); expect(r.output, r.output).toContain(want); return r.output; };
  const script = (name: string, body?: string) => body !== undefined ? fs.writeFileSync(path.join(ws, name), body) : fs.copyFileSync(path.join(SALE_READY, name), path.join(ws, name));
  const call = async (pool: pg.Pool, fn: string, args: unknown[]) => {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    return (await pool.query(`SELECT fleet.${fn}(${ph}) AS r`, args)).rows[0].r;
  };
  /** A simulated buyer's payment: custody opens the checkout, captures it and records the buyer (fake PayPal). */
  const buyerPays = async (checkoutId: string, amountMinor: number, email: string) => {
    const ppOrder = `ORD${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
    expect((await call(custody, "cx_paypal_checkout_update", ["custody-executor", checkoutId, "open", ppOrder, `https://www.paypal.com/checkoutnow?token=${ppOrder}`, null])).ok).toBe(true);
    expect((await call(custody, "cx_paypal_capture_record", ["custody-executor", checkoutId, `CAP${crypto.randomBytes(6).toString("hex").toUpperCase()}`, "COMPLETED", amountMinor, 40, "GBP", "capture_response"])).ok).toBe(true);
    expect((await call(custody, "cx_paypal_buyer_record", ["custody-executor", checkoutId, JSON.stringify({ email_address: email,
      name: { given_name: "Sim", surname: "Buyer" }, address: { country_code: "GB" }, payer_id: `PAYER${crypto.randomBytes(4).toString("hex").toUpperCase()}` })])).recorded).toBe(true);
  };
  const checkoutOf = (token: string) => R.one<string>(`(SELECT checkout_id::text FROM fleet.fleet_customer_orders WHERE access_token = $1)`, [token]);
  const attBytes = (a: { content?: Buffer; contentB64?: string }) => a.content ?? Buffer.from(a.contentB64 ?? "", "base64");
  const issues = (r: any, i = 0) => (r.files[i].issues as string[]).join(" ");
  /** Sell a published product to a simulated buyer; returns the delivered attachments. */
  const sell = async (slug: string, price: number, email: string) => {
    const buy = await call(svc, "svc_offer_buy", [slug, sha(email), BUYER_CONSENT_VERSION]);
    expect(buy, JSON.stringify(buy)).toMatchObject({ ok: true });
    await buyerPays(await checkoutOf(buy.token), price, email);
    expect(await call(svc, "svc_offer_tick", [20])).toMatchObject({ ok: true, delivered: 1 });
    await broker.tick();
    const mail = shared.outbox.at(-1)!;
    expect(mail.to).toEqual([email]);
    return { token: buy.token as string, attachments: (mail.attachments ?? []) as Array<{ fileName: string; content?: Buffer; contentB64?: string }> };
  };

  beforeAll(async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v76e2e-")));
    ws = path.join(root, "w");
    fs.mkdirSync(path.join(ws, "deliver"), { recursive: true });
    fs.mkdirSync(path.join(root, "m"));
    sandboxed = !(await runSandboxed(ws, "echo up", { timeoutMs: 15_000, maxOutput: 4_000 })).sandboxUnavailable;
    if (!sandboxed) return;
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, simulatedSettlement: false });
    // v85: an agent checks what it can deliver before it quotes or publishes (valid 7 days).
    // v87: each publish / quote is preceded by a check naming it (the gate itself: fleet-v87-media-capabilities-pg).
    autoCapabilityChecks(R);
    [F] = R.founders;
    await R.store.grantServiceRole();
    await R.store.grantCustodyRole();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2, options: "-c search_path=fleet" });
    custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 2, options: "-c search_path=fleet" });
    expect((await R.econ(F, "venture.create", { key: "sheets", model: "digital_product", offer: "cash-flow tools", state: "selected" })).ok).toBe(true);
    await liveRail(R.owner, "fleet", OWNER);
    await R.q(`SELECT fleet.fleet_admin_public_site_set('https://shop.fleet.test', 'Automaton Fleet (test trading name), contact via your order page', $1)`, [OWNER]);
    await R.q(`SELECT fleet.fleet_admin_sales_set(true, $1)`, [OWNER]);
    // v78: the legal seller (owner facts) and the venture's storefront (the agent's own venture identity).
    await R.q(`SELECT fleet.fleet_admin_seller_set($1::jsonb, $2)`, [JSON.stringify({ legalForm: "individual", legalName: "Test Owner", postalAddress: "1 Test Street, Testtown, TT1 1TT" }), OWNER]);
    expect((await R.econ(F, "identity.create", { kind: "venture_identity", ventureKey: "sheets", displayName: "Ledgerline",
      bio: "Cash-flow spreadsheets, courses and services for small businesses." })).ok).toBe(true);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v76e2e-id-"));
    fs.chmodSync(dir, 0o700);
    initIdentityState(dir);
    igw = new PgIdentityGateway({ connectionString: R.pgc.identityUrl });
    const { vault, ownerVault } = openIdentityState(dir);
    broker = new IdentityBroker(igw, vault, { mail: shared, ownerVault, providerVault: openProviderVault(dir), stateFile: path.join(dir, "pending.json") });
    await broker.tick();
    const mb = await R.econ(F, "mailbox.provision", { idempotencyKey: `k-${crypto.randomUUID()}` });
    expect(mb.ok, JSON.stringify(mb)).toBe(true);
    box = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: ws, memoryDir: path.join(root, "m"), loopGuard: new LoopGuard(), selfGovernance: true,
      toolsDir: DEV_TOOLS, execTimeoutMs: 90_000, ports: {
        ledger: async () => ({ cash: 10_000, expensePurchasingCapacity: 10_000 }),
        spendOrder: async () => ({ ok: true }), proposeKnowledge: async () => ({}), knowledge: async () => [], requestIdentityFact: async () => ({}),
        economy: (op: string, args: Record<string, unknown>) => R.econ(F, op, args),
      } as never });
  }, 300_000);
  afterAll(async () => {
    await igw?.close(); await svc?.end(); await custody?.end(); await R?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if (ws) fs.rmSync(path.dirname(ws), { recursive: true, force: true });
  });

  it("spreadsheet product: #DIV/0! and wrong saved values fail; the sale-ready forecast passes substantive cases, every promise is checked; sold and delivered", async (ctx) => {
    if (!sandboxed) { console.warn("Landlock unavailable: the e2e demonstrations are not exercised on this host"); ctx.skip(); }
    script("div0.py", DIV0); await exec("python3 div0.py");
    const d0 = await json("deliverable", { op: "inspect", args: { paths: ["deliver/draft.xlsx"] } });
    expect(d0).toMatchObject({ inspector: QA_INSPECTOR_VERSION, ok: false });
    expect(issues(d0)).toMatch(/FAIL formula_errors.*(E2.*#DIV\/0!|#DIV\/0!.*E2)/);
    script("plain.py", STALE); await exec("python3 plain.py");
    const st = await json("deliverable", { op: "inspect", args: { paths: ["deliver/plain.xlsx"] } });
    expect(st.ok).toBe(false); // valid file, recalculates cleanly — but the numbers a buyer's preview shows are wrong
    expect(issues(st)).toMatch(/FAIL cached_values: \d+ cell\(s\).*E2 cached 0, recalculated 1500/); // (the agent sees each issue clipped to 400 characters)

    script("cashflow.py"); await exec("python3 cashflow.py", "BUILT 1080 Apr,May,Sep,Oct");
    const paths = ["deliver/cashflow-forecast.xlsx", "deliver/cashflow-quick-start.pdf"];
    // Acceptance cases derived independently of the workbook: opening £500 lowers every closing by £1,500.
    const cases = [
      { name: "opening-500", file: paths[0], sheet: "Inputs", inputs: { B3: 500 }, expect: { "Forecast!F15": 720, "Forecast!G4": "Below buffer", "Forecast!F18": -420 } },
      { name: "buffer-1000", file: paths[0], sheet: "Inputs", inputs: { B4: 1000 }, expect: { "Forecast!G7": "OK", "Forecast!F18": 1080 } },
      { name: "supplied", file: paths[0], sheet: "Inputs", inputs: {}, expect: { "Forecast!C16": 44500, "Forecast!D16": 44280, "Forecast!F15": 2220, "Forecast!G7": "Below buffer" } },
    ];
    const ok = await json("deliverable", { op: "inspect", args: { paths, cases } });
    expect(ok, JSON.stringify(ok)).toMatchObject({ ok: true, files: [{ type: "xlsx", ok: true, issues: SHEET_ISSUES }, { type: "pdf", ok: true, issues: [] }] });
    const deliverables = ["12-month cash-flow workbook (.xlsx) with a Start here sheet", "Below-buffer warning for every month", "Quick-start guide with a worked example (PDF)"];
    const o = await json("offer", { op: "create", args: { venture: "sheets", kind: "product", title: "12-month cash-flow forecast for sole traders",
      summary: "See your bank balance month by month and get warned before it drops below your buffer.",
      description: "Enter your opening balance, buffer, income and costs; the forecast rolls the balance forward, flags every month below your buffer and charts the year. Includes a quick-start guide.",
      deliverables, priceMinor: 1_200, terms: "Digital download; refunds if the files do not open or do not match the description." } });
    const offerId = o.offer.offerId;
    for (const p of paths) await json("offer", { op: "file", args: { offerId, role: "deliverable", path: p } });
    const criteria = [
      { criterion: deliverables[0], met: true, evidence: "Start here (6 steps), Inputs (blue input cells), Forecast (12 months, chart); all £-formatted; saved values match recalculation" },
      { criterion: deliverables[1], met: true, evidence: "case opening-500: G4 'Below buffer'; supplied: Apr/May/Sep/Oct flagged; case buffer-1000 clears G7" },
      { criterion: deliverables[2], met: true, evidence: "1-page guide rendered; worked example reconciles: £44,500 in − £44,280 out = £220; £2,000 → £2,220" },
      { criterion: "Totals reconcile with the inputs", met: true, evidence: "case supplied: C16 44500, D16 44280, F15 2220" },
    ];
    // Leaving a listed deliverable unchecked is refused, whatever else passes.
    expect(await tool("deliverable", { op: "review", args: { paths, cases, subject: "offer", offerId, criteria: criteria.filter((_, i) => i !== 1), verdict: "pass" } }))
      .toMatchObject({ ok: false, refused: "FLEET_REVIEW_PROMISE_UNCOVERED" });
    const rv = await json("deliverable", { op: "review", args: { paths, cases, subject: "offer", offerId, criteria, verdict: "pass" } });
    expect(rv).toMatchObject({ verdict: "pass", automatedOk: true });
    expect(await json("offer", { op: "publish", args: { offerId, reviewId: rv.reviewId } })).toMatchObject({ offer: { status: "published" } });
    const sold = await sell(o.offer.slug, 1_200, "bea@example.test");
    expect(sold.attachments.map((a) => a.fileName).sort()).toEqual(["cashflow-forecast.xlsx", "cashflow-quick-start.pdf"]);
    for (const a of sold.attachments) expect(sha(attBytes(a))).toBe(sha(fs.readFileSync(path.join(ws, "deliver", a.fileName))));
    expect(fs.readdirSync(path.join(ws, ".tmp")).filter((x) => /^(fleet-qa-|qa-spec-)/.test(x))).toEqual([]);
  });

  it("downloadable course: a placeholder inside a lesson fails the bundle with its reason; the sale-ready course passes its cases; sold and delivered intact", async (ctx) => {
    if (!sandboxed) ctx.skip();
    script("draft.py", DRAFT_COURSE); await exec("python3 draft.py");
    const dr = await json("deliverable", { op: "inspect", args: { paths: ["deliver/draft-course.zip"] } });
    expect(dr).toMatchObject({ ok: false, files: [{ type: "zip", ok: false }] });
    expect(issues(dr)).toMatch(/failing members: course\/02-forecasting\.pdf \(placeholders: placeholder text: .*TODO/);

    script("course.py"); await exec("python3 course.py", "BUILT 350 10");
    // The bundle passes clean, and the workbook inside it is driven: 13 weeks, opening £600 lowers every week by £600.
    const cases = [{ name: "opening-600", file: "course/13-week-forecast.xlsx", sheet: "Forecast", inputs: { I3: 600 },
      expect: { E16: 400, F4: "Below buffer", F5: "OK", F6: "Below buffer", I8: -250 } }];
    const ok = await json("deliverable", { op: "inspect", args: { paths: ["deliver/cash-flow-course.zip", "course/13-week-forecast.xlsx"], cases } });
    expect(ok, JSON.stringify(ok)).toMatchObject({ ok: true, files: [{ type: "zip", ok: true, issues: [] }, { type: "xlsx", ok: true, issues: SHEET_ISSUES }] });
    expect(ok.files[0].facts.nested.map((n: any) => n.name)).toEqual(["cash-flow-course/01-why-cash-flow.pdf", "cash-flow-course/02-forecasting.pdf",
      "cash-flow-course/03-acting-early.pdf", "cash-flow-course/13-week-forecast.xlsx"]);
    const deliverables = ["Three illustrated PDF lessons with exercises and answers", "13-week cash-flow forecast workbook (.xlsx)"];
    const o = await json("offer", { op: "create", args: { venture: "sheets", kind: "product", title: "Cash-flow basics: a three-lesson course",
      summary: "Why cash beats profit, how to build a 13-week forecast, and how to act before a shortfall.",
      description: "Three illustrated PDF lessons with worked examples, exercises and answers, plus the 13-week forecast workbook used in lesson 2.",
      deliverables, priceMinor: 1_500, terms: "Digital download; refunds if the files do not open or do not match the description." } });
    await json("offer", { op: "file", args: { offerId: o.offer.offerId, role: "deliverable", path: "deliver/cash-flow-course.zip" } });
    const criteria = [
      { criterion: deliverables[0], met: true, evidence: "3 lessons rendered (2–3 pages each): headings, worked examples, a chart (lesson 2), 3 exercises each with an answers page" },
      { criterion: deliverables[1], met: true, evidence: "W1..W13 present; case opening-600: W13 £400, lowest −£250, W1 and W3 below buffer; saved values match recalculation" },
      { criterion: "Lesson figures match the workbook", met: true, evidence: "lesson 2 table and text (lowest W10 £350; W8, W9, W10 below £800) equal the workbook's example" },
    ];
    const rv = await json("deliverable", { op: "review", args: { paths: ["deliver/cash-flow-course.zip"], subject: "offer", offerId: o.offer.offerId, criteria, verdict: "pass" } });
    expect((await json("offer", { op: "publish", args: { offerId: o.offer.offerId, reviewId: rv.reviewId } })).offer.status).toBe("published");
    const sold = await sell(o.offer.slug, 1_500, "cal@example.test");
    expect(sha(attBytes(sold.attachments[0]))).toBe(sha(fs.readFileSync(path.join(ws, "deliver/cash-flow-course.zip"))));

    // Limitation, recorded on purpose: a thin but clean PDF passes; it is flagged (advisory), not blocked.
    script("thin.py", String.raw`
from reportlab.pdfgen import canvas
c = canvas.Canvas("deliver/thin.pdf"); c.drawString(60, 780, "Lesson 1: Cash matters."); c.showPage(); c.save()
print("BUILT")
`);
    await exec("python3 thin.py");
    const thin = await json("deliverable", { op: "inspect", args: { paths: ["deliver/thin.pdf"] } });
    expect(thin.ok).toBe(true);
    expect(issues(thin)).toMatch(/WARN sparse_pages/);
  });

  it("service: sample review publishes; the buyer's CSV is built into a tracker checked against the buyer's own totals; delivered; a revision needs a fresh review", async (ctx) => {
    if (!sandboxed) ctx.skip();
    script("invoice_tracker.py");
    fs.mkdirSync(path.join(ws, "samples"), { recursive: true });
    fs.writeFileSync(path.join(ws, "samples/demo.csv"), "client,net,invoice_date,paid\nAcme Ltd,100,2026-09-01,2026-09-20\nBeta LLP,250,2026-09-05,\n");
    await exec("python3 invoice_tracker.py samples/demo.csv samples/invoice-tracker-sample.xlsx --paid-date", "BUILT 2 420.0");
    const deliverables = ["VAT invoice tracker workbook (.xlsx) built from your data", "Totals by client"];
    const svcOffer = await json("offer", { op: "create", args: { venture: "sheets", kind: "service", title: "VAT invoice tracker built from your data",
      summary: "Send your invoice export; I build a VAT-ready Excel tracker with totals by client.", description: "Send a CSV export; I confirm scope and price before you pay.",
      deliverables, priceMinor: 5_000, turnaroundDays: 3, revisions: 1, capacity: 1, terms: "One revision included; refunds if I cannot deliver what was agreed." } });
    const sampleCases = [{ name: "sample", file: "samples/invoice-tracker-sample.xlsx", sheet: "Invoices", inputs: {}, expect: { D4: 20, E4: 120, E6: 420, "Summary!D5": 300, G5: "Unpaid" } }];
    const sampleCriteria = [
      { criterion: deliverables[0], met: true, evidence: "built from samples/demo.csv: 2 rows, VAT from the G1 rate cell, real dates, £ formats" },
      { criterion: deliverables[1], met: true, evidence: "Summary sheet: Beta LLP gross £300 (case)" },
      { criterion: "Totals reconcile", met: true, evidence: "case: gross total £420 = (100 + 250) × 1.2" },
    ];
    const sr = await json("deliverable", { op: "review", args: { paths: ["samples/invoice-tracker-sample.xlsx"], cases: sampleCases, subject: "sample", criteria: sampleCriteria, verdict: "pass" } });
    const pub = await json("offer", { op: "publish", args: { offerId: svcOffer.offer.offerId, reviewId: sr.reviewId } });
    expect(pub.offer.status).toBe("published");

    const buyerCsv = "client,net,invoice_date,paid\nNorth Ltd,1200,2026-09-03,\nSouth LLP,800,2026-09-10,2026-10-02\nEast & Co,500,2026-09-18,\nNorth Ltd,350.50,2026-09-29,2026-10-08\n";
    const e = await call(svc, "svc_offer_enquire", [pub.offer.slug, sha("buyer-svc"), "Dee Buyer", "dee@example.test", "Please build a VAT tracker from my invoice export, with totals by client.",
      JSON.stringify([{ fileName: "invoices.csv", contentType: "text/csv", contentB64: Buffer.from(buyerCsv).toString("base64") }])]);
    expect(e, JSON.stringify(e)).toMatchObject({ ok: true });
    const enquiryId = (await json("customers", { op: "enquiries", args: {} })).enquiries[0].enquiryId;
    const msg = (await json("customers", { op: "read", args: { enquiryId } })).thread.find((m: any) => m.files);
    const got = await tool("customers", { op: "fetch_file", args: { messageId: msg.messageId, fileNo: 1 } });
    expect(got.ok, got.output).toBe(true);
    expect(got.output).not.toContain(Buffer.from(buyerCsv).toString("base64"));
    const fetched = JSON.parse(got.output);
    expect(fs.readFileSync(path.join(ws, fetched.path), "utf8")).toBe(buyerCsv);
    const q = await json("customers", { op: "quote", args: { enquiryId, scope: "VAT tracker for your 4 invoices with totals by client", priceMinor: 5_000, turnaroundDays: 3 } });
    const orderId = q.order.orderId;
    const token = (await call(svc, "svc_enquiry_page", [e.token])).enquiry.orderToken as string;
    // v82: the buyer asks for the work to start now on the order page (CCR 2013 reg 36) before paying.
    expect(await call(svc, "svc_order_consent", [token, sha("dee@example.test"), BUYER_CONSENT_VERSION])).toMatchObject({ ok: true });
    await buyerPays(await checkoutOf(token), 5_000, "dee@example.test");
    await call(svc, "svc_offer_tick", [20]);

    // Built from the buyer's own file; expectations computed by hand from the CSV: net 2,850.50; VAT 570.10; gross 3,420.60.
    await exec(`python3 invoice_tracker.py ${fetched.path} deliver/invoice-tracker.xlsx`, "BUILT 4 3420.6");
    const orderCases = [{ name: "buyer-totals", file: "deliver/invoice-tracker.xlsx", sheet: "Invoices", inputs: {}, expect: { C8: 2850.5, D8: 570.1, E8: 3420.6, "Summary!D4": 1860.6 } }];
    const orderCriteria = [
      { criterion: deliverables[0], met: true, evidence: "4 rows = 4 invoices in invoices.csv; case buyer-totals: net £2,850.50, VAT £570.10, gross £3,420.60" },
      { criterion: deliverables[1], met: true, evidence: "Summary: North Ltd gross £1,860.60 (1,200 + 350.50, × 1.2)" },
      { criterion: "Matches the agreed scope", met: true, evidence: "quote: VAT tracker for the 4 invoices with totals by client — delivered as quoted" },
    ];
    const r1 = await json("deliverable", { op: "review", args: { paths: ["deliver/invoice-tracker.xlsx"], cases: orderCases, subject: "order", orderId, criteria: orderCriteria, verdict: "pass" } });
    await json("wallet", { op: "deliver", args: { orderId, paths: ["deliver/invoice-tracker.xlsx"], reviewId: r1.reviewId, message: "Your tracker is attached." } });
    await broker.tick();
    const v1 = fs.readFileSync(path.join(ws, "deliver/invoice-tracker.xlsx"));
    expect(sha(attBytes((shared.outbox.at(-1)!.attachments as any[])[0]))).toBe(sha(v1));

    // Revision: the buyer asks for paid dates; the earlier review is stale for any further delivery.
    expect((await call(svc, "svc_customer_message", ["order", token, sha("buyer-svc"), "Please add the date each invoice was paid.", JSON.stringify([])])).ok).toBe(true);
    await exec(`python3 invoice_tracker.py ${fetched.path} deliver/invoice-tracker.xlsx --paid-date`, "BUILT 4 3420.6");
    // v95: a second delivery on the order is a new operation: the first try is refused and names the latest one (after).
    const first = await tool("wallet", { op: "deliver", args: { orderId, paths: ["deliver/invoice-tracker.xlsx"], reviewId: r1.reviewId, resendReason: "revision: paid date" } });
    expect(first).toMatchObject({ ok: false, refused: "FLEET_OPERATION_EXISTS" });
    const after = /after: \\?"([0-9a-f-]{36})/.exec(first.output)?.[1];   // the reason, as the tool shows it (JSON)
    expect(after, first.output).toBeTruthy();
    expect(await tool("wallet", { op: "deliver", args: { orderId, paths: ["deliver/invoice-tracker.xlsx"], reviewId: r1.reviewId, resendReason: "revision: paid date", after } }))
      .toMatchObject({ ok: false, refused: "FLEET_REVIEW_STALE" });
    const revCases = [{ ...orderCases[0], name: "revision", expect: { ...orderCases[0].expect, G4: "Unpaid", G5: "Paid", G7: "Paid" } }];
    const r2 = await json("deliverable", { op: "review", args: { paths: ["deliver/invoice-tracker.xlsx"], cases: revCases, subject: "order", orderId,
      criteria: [...orderCriteria, { criterion: "Paid date and status per invoice (revision)", met: true, evidence: "case revision: South LLP and the second North Ltd invoice Paid, others Unpaid" }],
      verdict: "pass" } });
    await json("wallet", { op: "deliver", args: { orderId, paths: ["deliver/invoice-tracker.xlsx"], reviewId: r2.reviewId, resendReason: "revision: paid date column", after } });
    await broker.tick();
    const v2 = fs.readFileSync(path.join(ws, "deliver/invoice-tracker.xlsx"));
    expect(sha(v2)).not.toBe(sha(v1));
    const page = await call(svc, "svc_order_page", [token]);
    expect(page.downloads.map((x: any) => x.sha256)).toEqual(expect.arrayContaining([sha(v1), sha(v2)]));
  });
});
