/**
 * v76 end to end — one spreadsheet product, from the agent's workspace to a simulated buyer's inbox, through the real
 * founder tools and the real inspector (fleet-qa-1, sandboxed with the pinned toolchain) against PostgreSQL, custody's cx_*
 * calls and the identity broker on a simulated shared mailbox.
 *
 * The agent builds a workbook with `exec` (XlsxWriter from the toolchain); its first version divides by an empty cell, so
 * `deliverable inspect` reports the #DIV/0! with its address and a passing `deliverable review` is refused by the registry
 * (FLEET_REVIEW_AUTOMATED_FAILED). The fixed workbook inspects clean and its acceptance case (inputs → expected totals)
 * passes; the review records the exact bytes' hashes with the inspector's report. The offer is created and its file comes
 * from the workspace through `offer file`; it publishes on that review. A buyer buys on the public page, custody opens and
 * captures the checkout, the offer tick delivers automatically, and the buyer's mail attachment and download are byte for
 * byte the reviewed workbook. Skips without PostgreSQL, the dev toolchain or Landlock.
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

describe.skipIf(!PG_BIN || !HAVE_TOOLS)("v76 e2e: a spreadsheet product from the agent's workspace to a buyer (real inspector)", { timeout: 300_000 }, () => {
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
});
