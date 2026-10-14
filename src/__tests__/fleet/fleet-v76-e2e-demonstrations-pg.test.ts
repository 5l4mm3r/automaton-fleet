/**
 * v76 end-to-end demonstrations — real founder tools and the real inspector (fleet-qa-1, sandboxed with the pinned
 * toolchain) against PostgreSQL, custody's cx_* calls and the identity broker on a simulated shared mailbox. SIMULATED
 * evidence: the buyer, PayPal (custody calls recorded directly) and the mailbox are fakes; nothing here touches production.
 *
 * 1. Spreadsheet product: a #DIV/0! in the first build is caught and a passing review is refused by the registry; the fix
 *    passes an acceptance case (inputs → expected totals), is reviewed, published, bought and delivered byte-identical.
 * 2. Downloadable course (a ZIP of PDF lessons + a workbook): a placeholder inside one lesson fails the bundle with the
 *    member and the reason; the fixed course is reviewed, sold and delivered intact. Recorded limitation: a technically
 *    clean but thin PDF passes — it is flagged (sparse_pages, advisory) but the inspector does not judge substance.
 * 3. Service: a real work sample's review publishes it; the buyer's CSV reaches the workspace (path, never bytes); the
 *    workbook is built from it and an acceptance case checks the buyer's own numbers; delivered; a revision request makes
 *    the earlier review stale; the revised work is delivered on a fresh review; both versions stay on the order page.
 * Skips without PostgreSQL, the dev toolchain or Landlock.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
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
const DEV_TOOLS = path.join(os.homedir(), ".cache/automaton-fleet-tools/dev");
const HAVE_TOOLS = fs.existsSync(path.join(DEV_TOOLS, "site")) && fs.existsSync(path.join(DEV_TOOLS, "bin/fleet-python"));
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

/** The agent's own build script: a 3-month cash-flow workbook; `broken` leaves the divisor of the margin empty. */
const buildWorkbook = (broken: boolean) => String.raw`
import xlsxwriter
wb = xlsxwriter.Workbook("deliver/cashflow.xlsx")
ws = wb.add_worksheet("Forecast")
ws.write_row("A1", ["Month", "Income", "Costs", "Net", "Closing", "Margin"])
ws.write("G1", "Opening")
ws.write("H1", 1000)
for i, (m, inc, cost) in enumerate([("Jan", 2000, 1500), ("Feb", 2200, 1600), ("Mar", 1800, 1900)]):
    r = i + 2
    ws.write_row("A%d" % r, [m, inc, cost])
    ws.write_formula("D%d" % r, "=B%d-C%d" % (r, r), None, inc - cost)
    prev = "H1" if r == 2 else "E%d" % (r - 1)
    ws.write_formula("E%d" % r, "=%s+D%d" % (prev, r))
    ws.write_formula("F%d" % r, "=D%d/${broken ? "I1" : "B%d"}" % (r, ${broken ? "" : "r"}))
ws.write_formula("D5", "=SUM(D2:D4)")
wb.close()
print("BUILT")
`;

describe.skipIf(!PG_BIN || !HAVE_TOOLS)("v76 e2e demonstrations: product, course and service from the agent's workspace to a simulated buyer (real inspector)", { timeout: 300_000 }, () => {
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
  const criteria = [
    { criterion: "Projects month-end cash from the opening balance", met: true, evidence: "acceptance case: opening 1000 → Mar closing 2000" },
    { criterion: "Totals reconcile", met: true, evidence: "D5 = sum of monthly net; recalculated clean" },
    { criterion: "Matches the listing: month-end cash and margin per month", met: true, evidence: "columns E and F for Jan..Mar" },
  ];
  const cases = [{ name: "forecast", file: "deliver/cashflow.xlsx", sheet: "Forecast", inputs: { H1: 500 }, expect: { E4: 1500, D5: 1000, F2: 0.25 } }];

  beforeAll(async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v76e2e-")));
    ws = path.join(root, "w");
    fs.mkdirSync(path.join(ws, "deliver"), { recursive: true });
    fs.mkdirSync(path.join(root, "m"));
    sandboxed = !(await runSandboxed(ws, "echo up", { timeoutMs: 15_000, maxOutput: 4_000 })).sandboxUnavailable;
    if (!sandboxed) return;
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, simulatedSettlement: false });
    [F] = R.founders;
    await R.store.grantServiceRole();
    await R.store.grantCustodyRole();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2, options: "-c search_path=fleet" });
    custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 2, options: "-c search_path=fleet" });
    expect((await R.econ(F, "venture.create", { key: "sheets", model: "digital_product", offer: "cash-flow workbook", state: "selected" })).ok).toBe(true);
    await liveRail(R.owner, "fleet", OWNER);
    await R.q(`SELECT fleet.fleet_admin_public_site_set('https://shop.fleet.test', 'Automaton Fleet (test trading name), contact via your order page', 'operator:test')`);
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
      toolsDir: DEV_TOOLS, execTimeoutMs: 60_000, ports: {
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

  it("build → inspect (fails, then passes) → review → offer → buyer purchase → automatic delivery of the reviewed bytes", async (ctx) => {
    if (!sandboxed) { console.warn("Landlock unavailable: the e2e spreadsheet path is not exercised on this host"); ctx.skip(); }
    // 1. The agent builds a first version with its own toolchain; the margin divides by an empty cell.
    fs.writeFileSync(path.join(ws, "build.py"), buildWorkbook(true));
    const b1 = await tool("exec", { command: "python3 build.py" });
    expect(b1.output, b1.output).toContain("BUILT");
    const i1 = await tool("deliverable", { op: "inspect", args: { paths: ["deliver/cashflow.xlsx"] } });
    expect(i1.ok).toBe(true);
    const r1 = JSON.parse(i1.output);
    expect(r1).toMatchObject({ inspector: QA_INSPECTOR_VERSION, ok: false });
    expect(r1.files[0].issues.join(" ")).toMatch(/#DIV\/0!.*F2|F2.*#DIV\/0!/);
    // A passing review of a failing file is refused by the registry, not just discouraged.
    const rv1 = await tool("deliverable", { op: "review", args: { paths: ["deliver/cashflow.xlsx"], subject: "sample", criteria, verdict: "pass" } });
    expect(rv1, rv1.output).toMatchObject({ ok: false, refused: "FLEET_REVIEW_AUTOMATED_FAILED" });

    // 2. Fixed: the margin divides by income. Clean, and the acceptance case drives the model with other inputs.
    fs.writeFileSync(path.join(ws, "build.py"), buildWorkbook(false));
    expect((await tool("exec", { command: "python3 build.py" })).output).toContain("BUILT");
    const i2 = JSON.parse((await tool("deliverable", { op: "inspect", args: { paths: ["deliver/cashflow.xlsx"], cases } })).output);
    expect(i2, JSON.stringify(i2)).toMatchObject({ ok: true, files: [{ type: "xlsx", ok: true }] });
    expect(i2.files[0].issues.join(" ")).not.toMatch(/FAIL/);
    // Advisory presentation findings on this deliberately plain workbook (no number formats, plain headers); not a failure.
    expect(i2.files[0].issues.join(" ")).toMatch(/WARN presentation: every number and formula cell is in General format/);
    const bytes = fs.readFileSync(path.join(ws, "deliver/cashflow.xlsx"));

    // 3. The offer, its file from the workspace, the review of exactly those bytes, publication.
    const o = JSON.parse((await tool("offer", { op: "create", args: { venture: "sheets", kind: "product", title: "Three-month cash-flow workbook",
      summary: "A small cash-flow forecast in Excel.", description: "Enter your opening balance, income and costs; it projects month-end cash and margin.",
      deliverables: ["Cash-flow workbook (.xlsx)"], priceMinor: 900, terms: "Digital download; refunds if the file does not open or does not match the description." } })).output);
    const offerId = o.offer.offerId;
    const f = await tool("offer", { op: "file", args: { offerId, role: "deliverable", path: "deliver/cashflow.xlsx" } });
    expect(f.ok, f.output).toBe(true);
    const rv2 = await tool("deliverable", { op: "review", args: { paths: ["deliver/cashflow.xlsx"], cases, subject: "offer", offerId, criteria, verdict: "pass" } });
    expect(rv2.ok, rv2.output).toBe(true);
    const review = JSON.parse(rv2.output);
    expect(review).toMatchObject({ verdict: "pass", automatedOk: true });
    const stored = await R.one<any>(`(SELECT jsonb_build_object('files', files, 'automated', automated) FROM fleet.fleet_artifact_reviews WHERE review_id = $1)`, [review.reviewId]);
    expect(JSON.stringify(stored)).toContain(sha(bytes));
    expect(stored.automated.inspector).toBe(QA_INSPECTOR_VERSION);
    const p = JSON.parse((await tool("offer", { op: "publish", args: { offerId, reviewId: review.reviewId } })).output);
    expect(p).toMatchObject({ ok: true, offer: { status: "published" } });

    // 4. A simulated buyer: public buy → custody opens and captures → the offer tick delivers the reviewed workbook.
    const buy = await call(svc, "svc_offer_buy", [p.offer.slug, sha("buyer-e2e")]);
    expect(buy).toMatchObject({ ok: true });
    const checkoutId = await R.one<string>(`(SELECT checkout_id::text FROM fleet.fleet_customer_orders WHERE access_token = $1)`, [buy.token]);
    const ppOrder = `ORD${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
    expect((await call(custody, "cx_paypal_checkout_update", ["custody-executor", checkoutId, "open", ppOrder, `https://www.paypal.com/checkoutnow?token=${ppOrder}`, null])).ok).toBe(true);
    expect((await call(custody, "cx_paypal_capture_record", ["custody-executor", checkoutId, `CAP${crypto.randomBytes(6).toString("hex").toUpperCase()}`, "COMPLETED", 900, 40, "GBP", "capture_response"])).ok).toBe(true);
    expect((await call(custody, "cx_paypal_buyer_record", ["custody-executor", checkoutId, JSON.stringify({ email_address: "bea@example.test",
      name: { given_name: "Bea", surname: "Buyer" }, address: { country_code: "GB" }, payer_id: "PAYERBEAE2E01" })])).recorded).toBe(true);
    expect(await call(svc, "svc_offer_tick", [20])).toMatchObject({ ok: true, delivered: 1 });
    await broker.tick();
    const mail = shared.outbox.at(-1)!;
    expect(mail.to).toEqual(["bea@example.test"]);
    const att = (mail.attachments ?? []) as Array<{ fileName: string; content?: Buffer; contentB64?: string }>;
    expect(att.map((a) => a.fileName)).toEqual(["cashflow.xlsx"]);
    const attBytes = att[0].content ?? Buffer.from(att[0].contentB64 ?? "", "base64");
    expect(sha(attBytes)).toBe(sha(bytes));
    const page = await call(svc, "svc_order_page", [buy.token]);
    expect(page.order).toMatchObject({ payment: "paid", status: "delivered" });
    const dl = await call(svc, "svc_order_file", [buy.token, page.downloads[0].deliveryId, page.downloads[0].fileNo]);
    expect(dl.ok).toBe(true);
    expect(sha(Buffer.from(dl.contentB64, "base64"))).toBe(sha(bytes));
    // No inspector residue in the agent's workspace.
    expect(fs.readdirSync(path.join(ws, ".tmp")).filter((x) => /^(fleet-qa-|qa-spec-)/.test(x))).toEqual([]);
  });

  it("a downloadable course: a placeholder inside a lesson is caught through the bundle; the fixed course is reviewed, sold and delivered intact", async (ctx) => {
    if (!sandboxed) ctx.skip();
    const course = (draft: boolean) => String.raw`
import zipfile, xlsxwriter
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
lessons = [
  ("01-why-cash-flow.pdf", ["Lesson 1: Why cash flow, not profit, keeps a small business alive.", "Profit is an opinion; cash is a fact.",
                            "Exercise: list every payment you expect in the next 30 days."]),
  ("02-forecasting.pdf", ["Lesson 2: Building a 13-week forecast.", "${draft ? "TODO: write the worked example." : "Worked example: opening 1,000; receipts 2,000; payments 1,500; closing 1,500."}",
                          "Exercise: fill in the workbook's first four weeks."]),
  ("03-acting-early.pdf", ["Lesson 3: Acting before the shortfall.", "Chase invoices at day 7, not day 30; agree supplier terms early.",
                           "Exercise: mark the first week your closing balance drops below your buffer."]),
]
for name, lines in lessons:
    c = canvas.Canvas("course/" + name, pagesize=A4)
    c.setFont("Helvetica", 12)
    y = 780
    for ln in lines:
        c.drawString(60, y, ln); y -= 22
    c.showPage(); c.save()
wb = xlsxwriter.Workbook("course/13-week-forecast.xlsx")
ws = wb.add_worksheet("Weeks")
ws.write_row("A1", ["Week", "Receipts", "Payments", "Closing"])
ws.write("F1", "Opening"); ws.write("G1", 1000)
for w in range(1, 5):
    r = w + 1
    ws.write_row("A%d" % r, [w, 500, 400])
    ws.write_formula("D%d" % r, "=%s+B%d-C%d" % ("G1" if r == 2 else "D%d" % (r - 1), r, r))
wb.close()
with zipfile.ZipFile("deliver/cash-flow-course.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for name, _ in lessons:
        z.write("course/" + name, "cash-flow-course/" + name)
    z.write("course/13-week-forecast.xlsx", "cash-flow-course/13-week-forecast.xlsx")
print("BUILT")
`;
    fs.mkdirSync(path.join(ws, "course"), { recursive: true });
    fs.writeFileSync(path.join(ws, "course.py"), course(true));
    expect((await tool("exec", { command: "python3 course.py" })).output).toContain("BUILT");
    const i1 = JSON.parse((await tool("deliverable", { op: "inspect", args: { paths: ["deliver/cash-flow-course.zip"] } })).output);
    expect(i1, JSON.stringify(i1)).toMatchObject({ ok: false, files: [{ type: "zip", ok: false }] });
    expect(i1.files[0].issues.join(" ")).toMatch(/placeholder.*TODO/i);

    fs.writeFileSync(path.join(ws, "course.py"), course(false));
    expect((await tool("exec", { command: "python3 course.py" })).output).toContain("BUILT");
    const i2 = JSON.parse((await tool("deliverable", { op: "inspect", args: { paths: ["deliver/cash-flow-course.zip"] } })).output);
    expect(i2, JSON.stringify(i2)).toMatchObject({ ok: true, files: [{ type: "zip", ok: true }] });
    const bytes = fs.readFileSync(path.join(ws, "deliver/cash-flow-course.zip"));

    const o = JSON.parse((await tool("offer", { op: "create", args: { venture: "sheets", kind: "product", title: "Cash-flow basics: a three-lesson course",
      summary: "Three short PDF lessons and a 13-week forecast workbook.", description: "Learn why cash, not profit, decides survival; build a 13-week forecast; act before a shortfall.",
      deliverables: ["Three PDF lessons", "13-week forecast workbook (.xlsx)"], priceMinor: 1_200, terms: "Digital download; refunds if the files do not open or do not match the description." } })).output);
    expect((await tool("offer", { op: "file", args: { offerId: o.offer.offerId, role: "deliverable", path: "deliver/cash-flow-course.zip" } })).ok).toBe(true);
    const courseCriteria = [
      { criterion: "Three lessons as described", met: true, evidence: "bundle holds 01..03 PDFs, each opened and read" },
      { criterion: "Worked example present and correct", met: true, evidence: "lesson 2: 1,000 + 2,000 − 1,500 = 1,500" },
      { criterion: "Workbook rolls the closing balance forward", met: true, evidence: "Weeks!D2..D5 recalculated clean" },
    ];
    const rv = await tool("deliverable", { op: "review", args: { paths: ["deliver/cash-flow-course.zip"], subject: "offer", offerId: o.offer.offerId, criteria: courseCriteria, verdict: "pass" } });
    expect(rv.ok, rv.output).toBe(true);
    const p = JSON.parse((await tool("offer", { op: "publish", args: { offerId: o.offer.offerId, reviewId: JSON.parse(rv.output).reviewId } })).output);
    expect(p).toMatchObject({ ok: true, offer: { status: "published" } });

    const buy = await call(svc, "svc_offer_buy", [p.offer.slug, sha("buyer-course")]);
    await buyerPays(await checkoutOf(buy.token), 1_200, "cal@example.test");
    expect(await call(svc, "svc_offer_tick", [20])).toMatchObject({ ok: true, delivered: 1 });
    await broker.tick();
    const mail = shared.outbox.at(-1)!;
    expect(mail.to).toEqual(["cal@example.test"]);
    expect(sha(attBytes((mail.attachments as any[])[0]))).toBe(sha(bytes));

    // Limitation, recorded on purpose: a technically clean but thin "course" (one line per lesson) also inspects clean.
    // The inspector proves the files open, render, recalculate and hold no placeholders; it does not judge substance.
    fs.writeFileSync(path.join(ws, "thin.py"), String.raw`
from reportlab.pdfgen import canvas
c = canvas.Canvas("deliver/thin.pdf"); c.drawString(60, 780, "Lesson 1: Cash matters."); c.showPage(); c.save()
print("BUILT")
`);
    expect((await tool("exec", { command: "python3 thin.py" })).output).toContain("BUILT");
    const thin = JSON.parse((await tool("deliverable", { op: "inspect", args: { paths: ["deliver/thin.pdf"] } })).output);
    expect(thin.ok).toBe(true);
    // …but it is flagged (advisory): content fills a sliver of the page. Flagged, not blocked — the judgement stays the agent's.
    expect(thin.files[0].issues.join(" ")).toMatch(/WARN sparse_pages/);
  });

  it("a service: sample review publishes it; the buyer's file reaches the workspace; the work is built from it, checked against the buyer's numbers, delivered; a revision needs a fresh review", async (ctx) => {
    if (!sandboxed) ctx.skip();
    // A real work sample, inspected and reviewed, publishes the service.
    const invoiceBuild = (src: string, out: string, paidCol: boolean) => String.raw`
import csv, xlsxwriter
rows = list(csv.DictReader(open("${src}")))
wb = xlsxwriter.Workbook("${out}")
ws = wb.add_worksheet("Invoices")
hdr = ["Client", "Net", "VAT", "Gross"] + (["Paid on"] if ${paidCol ? "True" : "False"} else [])
ws.write_row("A1", hdr)
for i, r in enumerate(rows):
    n = i + 2
    ws.write("A%d" % n, r["client"]); ws.write_number("B%d" % n, float(r["net"]))
    ws.write_formula("C%d" % n, "=B%d*0.2" % n); ws.write_formula("D%d" % n, "=B%d+C%d" % (n, n))
    if ${paidCol ? "True" : "False"}: ws.write("E%d" % n, r.get("paid", ""))
last = len(rows) + 1
ws.write("A%d" % (last + 1), "Total"); ws.write_formula("D%d" % (last + 1), "=SUM(D2:D%d)" % last)
wb.close()
print("BUILT", len(rows))
`;
    fs.mkdirSync(path.join(ws, "samples"), { recursive: true });
    fs.writeFileSync(path.join(ws, "samples/demo.csv"), "client,net,paid\nAcme,100,2026-10-01\nBeta,250,\n");
    fs.writeFileSync(path.join(ws, "sample.py"), invoiceBuild("samples/demo.csv", "samples/invoice-tracker-sample.xlsx", false));
    expect((await tool("exec", { command: "python3 sample.py" })).output).toContain("BUILT 2");
    const svcOffer = JSON.parse((await tool("offer", { op: "create", args: { venture: "sheets", kind: "service", title: "Invoice tracker built from your data",
      summary: "Send your invoice list; I build a VAT-ready Excel tracker.", description: "Send a CSV export; I confirm scope and price before you pay.",
      deliverables: ["A tested .xlsx tracker"], priceMinor: 5_000, turnaroundDays: 3, revisions: 1, capacity: 1,
      terms: "One revision included; refunds if I cannot deliver what was agreed." } })).output);
    const sampleCriteria = [
      { criterion: "VAT at 20% per row", met: true, evidence: "case: Acme net 100 → VAT 20, gross 120" },
      { criterion: "Total gross reconciles", met: true, evidence: "case: total 420" },
      { criterion: "Opens and recalculates", met: true, evidence: "inspector: recalculated clean" },
    ];
    const sampleCases = [{ name: "sample", file: "samples/invoice-tracker-sample.xlsx", sheet: "Invoices", inputs: {}, expect: { C2: 20, D2: 120, D4: 420 } }];
    const sr = await tool("deliverable", { op: "review", args: { paths: ["samples/invoice-tracker-sample.xlsx"], cases: sampleCases, subject: "sample", criteria: sampleCriteria, verdict: "pass" } });
    expect(sr.ok, sr.output).toBe(true);
    const pub = JSON.parse((await tool("offer", { op: "publish", args: { offerId: svcOffer.offer.offerId, reviewId: JSON.parse(sr.output).reviewId } })).output);
    expect(pub).toMatchObject({ ok: true, offer: { status: "published" } });

    // The buyer's brief with their data; the agent fetches the file into its workspace (path only, never bytes).
    const buyerCsv = "client,net,paid\nNorth Ltd,1200,\nSouth LLP,800,2026-10-02\nEast & Co,500,\n";
    const e = await call(svc, "svc_offer_enquire", [pub.offer.slug, sha("buyer-svc"), "Dee Buyer", "dee@example.test", "Please build a VAT tracker from my invoice export, with a total.",
      JSON.stringify([{ fileName: "invoices.csv", contentType: "text/csv", contentB64: Buffer.from(buyerCsv).toString("base64") }])]);
    expect(e, JSON.stringify(e)).toMatchObject({ ok: true });
    const enquiries = JSON.parse((await tool("customers", { op: "enquiries", args: {} })).output);
    const enquiryId = enquiries.enquiries.find((x: any) => x.status !== "accepted")?.enquiryId ?? enquiries.enquiries[0].enquiryId;
    const read = JSON.parse((await tool("customers", { op: "read", args: { enquiryId } })).output);
    const msg = read.thread.find((m: any) => m.files);
    const got = await tool("customers", { op: "fetch_file", args: { messageId: msg.messageId, fileNo: 1 } });
    expect(got.ok, got.output).toBe(true);
    const fetched = JSON.parse(got.output);
    expect(got.output).not.toContain(Buffer.from(buyerCsv).toString("base64"));
    expect(fs.readFileSync(path.join(ws, fetched.path), "utf8")).toBe(buyerCsv);

    const q = JSON.parse((await tool("customers", { op: "quote", args: { enquiryId, scope: "VAT tracker for 3 invoices with a gross total", priceMinor: 5_000, turnaroundDays: 3 } })).output);
    expect(q).toMatchObject({ ok: true, order: { fulfilment: "service" } });
    const orderId = q.order.orderId;
    const token = (await call(svc, "svc_enquiry_page", [e.token])).enquiry.orderToken as string;
    await buyerPays(await checkoutOf(token), 5_000, "dee@example.test");
    await call(svc, "svc_offer_tick", [20]);

    // Built from the buyer's own file; the acceptance case checks the buyer's numbers (2500 net → 3000 gross).
    fs.writeFileSync(path.join(ws, "build-order.py"), invoiceBuild(fetched.path, "deliver/invoice-tracker.xlsx", false));
    expect((await tool("exec", { command: "python3 build-order.py" })).output).toContain("BUILT 3");
    const orderCases = [{ name: "buyer-data", file: "deliver/invoice-tracker.xlsx", sheet: "Invoices", inputs: {}, expect: { D2: 1440, D5: 3000 } }];
    const orderCriteria = [
      { criterion: "Every invoice from the buyer's export", met: true, evidence: "3 rows = 3 rows in invoices.csv" },
      { criterion: "VAT and gross per invoice", met: true, evidence: "case: North Ltd 1200 → 1440" },
      { criterion: "A total", met: true, evidence: "case: total gross 3000 (2500 net × 1.2)" },
    ];
    const r1 = await tool("deliverable", { op: "review", args: { paths: ["deliver/invoice-tracker.xlsx"], cases: orderCases, subject: "order", orderId, criteria: orderCriteria, verdict: "pass" } });
    expect(r1.ok, r1.output).toBe(true);
    const r1id = JSON.parse(r1.output).reviewId;
    const d1 = await tool("wallet", { op: "deliver", args: { orderId, paths: ["deliver/invoice-tracker.xlsx"], reviewId: r1id, message: "Your tracker is attached." } });
    expect(d1.ok, d1.output).toBe(true);
    await broker.tick();
    const v1 = fs.readFileSync(path.join(ws, "deliver/invoice-tracker.xlsx"));
    expect(sha(attBytes((shared.outbox.at(-1)!.attachments as any[])[0]))).toBe(sha(v1));

    // A revision: the buyer asks for the paid date; the old review is stale for the revised work.
    expect((await call(svc, "svc_customer_message", ["order", token, sha("buyer-svc"), "Please add the date each invoice was paid.", JSON.stringify([])])).ok).toBe(true);
    fs.writeFileSync(path.join(ws, "build-order.py"), invoiceBuild(fetched.path, "deliver/invoice-tracker.xlsx", true));
    expect((await tool("exec", { command: "python3 build-order.py" })).output).toContain("BUILT 3");
    const stale = await tool("wallet", { op: "deliver", args: { orderId, paths: ["deliver/invoice-tracker.xlsx"], reviewId: r1id, resendReason: "revision: paid date" } });
    expect(stale).toMatchObject({ ok: false, refused: "FLEET_REVIEW_STALE" });
    const r2 = await tool("deliverable", { op: "review", args: { paths: ["deliver/invoice-tracker.xlsx"], cases: orderCases, subject: "order", orderId,
      criteria: [...orderCriteria, { criterion: "Paid date column (revision)", met: true, evidence: "column E from the export's paid field" }], verdict: "pass" } });
    expect(r2.ok, r2.output).toBe(true);
    const d2 = await tool("wallet", { op: "deliver", args: { orderId, paths: ["deliver/invoice-tracker.xlsx"], reviewId: JSON.parse(r2.output).reviewId, resendReason: "revision: paid date column" } });
    expect(d2.ok, d2.output).toBe(true);
    await broker.tick();
    const v2 = fs.readFileSync(path.join(ws, "deliver/invoice-tracker.xlsx"));
    expect(sha(v2)).not.toBe(sha(v1));
    const page = await call(svc, "svc_order_page", [token]);
    expect(page.downloads.map((x: any) => x.sha256)).toEqual(expect.arrayContaining([sha(v1), sha(v2)]));
  });
});
