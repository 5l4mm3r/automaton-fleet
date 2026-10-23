/**
 * Money a founder tells its customers, and the run allowance (owner, 2026-10-20: "do not rely on model-generated arithmetic
 * for monetary totals"; "500p + 101p equals 601p, not 701p").
 *  - exact integer-pence arithmetic with one explicit rounding rule (half-up to the penny);
 *  - written calculations, itemised totals and labelled totals in customer-facing text are checked before sending, against
 *    exact arithmetic and the record's authoritative amounts (the real FounderToolbox, the economy port stubbed);
 *  - refunds stated to a buyer must match the payment and what is still refundable;
 *  - a call's reservation is a true upper bound of its cost (so the run's usage, its credit draw and the tax/fee on it
 *    stay within the displayed all-inclusive maximum).
 * v105 (owner, 2026-10-20: "support currencies the payment/accounting system actually supports, using their correct
 * minor-unit rules … verified figures may be formatted in words … apply the existing arithmetic checks to extracted
 * document text"):
 *  - ISO minor units (JPY 0, KWD 3), codes and symbols, amounts in words; ambiguous "$" and excess precision held back;
 *    another currency than the record's only as a marked approximation — no GBP-only rule;
 *  - the platform's own pricing text (v105 fleet_price_lines) passes, and a changed figure in it does not;
 *  - an incorrect calculation inside a real PDF and a real DOCX is refused through the delivery path (sandboxed
 *    extraction), and what extraction cannot read is stated in the delivery's result.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { formatMoney, formatPence, moneyProblems, parseAmount, parsePence, roundHalfUp, sumPence, wordsToNumber } from "../../fleet/founder/money.js";
import { runSandboxed } from "../../fleet/founder/exec-sandbox.js";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { FOUNDER_MANIFEST_V2 } from "../../fleet/capabilities.js";
import { costBoundMicro, PROVIDER_FRAMING_TOKENS } from "../../fleet/cognition/routed-gateway.js";
import { costMicrocents } from "../../fleet/cognition/charging.js";

const ORDER = "9a443c84-c55c-44e6-862c-3f4cc5d6c9e0";
const DEV_TOOLS = path.join(os.homedir(), ".cache/automaton-fleet-tools/dev");
const HAVE_TOOLS = fs.existsSync(path.join(DEV_TOOLS, "site")) && fs.existsSync(path.join(DEV_TOOLS, "bin/fleet-python"));
/** As money.currencies returns them in production today: the accounting currency (payments) and the FX rate's other. */
const RECORDS = [{ code: "GBP", exponent: 2, payments: true }, { code: "USD", exponent: 2, payments: false }];
const C = { currencies: RECORDS };

describe("money in customer-facing text (exact pence, checked before sending)", () => {
  it("500p + 101p = 601p — exactly, and a written £7.01 for it is caught", () => {
    expect(sumPence([500, 101])).toBe(601);
    expect(formatPence(601)).toBe("£6.01");
    expect(parsePence("£6.01")).toBe(601);
    expect(moneyProblems("Usage £5.00 + acquisition tax/fee £1.01 = £6.01")).toEqual([]);
    expect(moneyProblems("Usage £5.00 + acquisition tax/fee £1.01 = £7.01")).toEqual([expect.objectContaining({ kind: "calculation", stated: 701, expected: [601], currency: "GBP" })]);
    expect(() => sumPence([500, 1.01])).toThrow(/integer pence/);
  });

  it("quantities, discounts, percentage fees and rounding (half-up to the penny, once)", () => {
    const ok = ["3 × £2.50 = £7.50", "4 properties at £1.25 each: 4 × £1.25 = £5.00.", "10% off £20.00 = £18.00", "£20.00 - 10% = £18.00",
      "£19.99 less 15% = £16.99", "£5.00 + 3.4% = £5.17", "PayPal's fee is 2.9% of £5.00 + £0.30 = £0.45", "£10.00 / 3 = £3.33", "£0.05 / 2 = £0.03"];
    for (const t of ok) expect(moneyProblems(t), t).toEqual([]);
    const bad: Array<[string, number, number]> = [["3 x £2.50 = £7.00", 700, 750], ["£19.99 less 15% = £17.00", 1700, 1699],
      ["2.9% of £5.00 + £0.30 = £0.44", 44, 45], ["£0.05 / 2 = £0.02", 2, 3], ["12 × £1,250.00 = £15,500.00", 1_550_000, 1_500_000]];
    for (const [t, stated, want] of bad) expect(moneyProblems(t), t).toEqual([expect.objectContaining({ kind: "calculation", stated, expected: [want] })]);
    // The rounding rule itself: exact rationals, half-up (0.445 → 0.45; −0.445 → −0.45; 0.444… → 0.44).
    expect(roundHalfUp({ n: 89n, d: 2n })).toBe(45n);
    expect(roundHalfUp({ n: -89n, d: 2n })).toBe(-45n);
    expect(roundHalfUp({ n: 400n, d: 9n })).toBe(44n);
  });

  it("an itemised list must add up to its total (discounts and refunds count negative)", () => {
    expect(moneyProblems("- Tracker: £4.00\n- Setup: £1.00\nTotal: £6.00")).toEqual([expect.objectContaining({ kind: "itemised_total", stated: 600, expected: [500] })]);
    expect(moneyProblems("- Tracker: £4.00\n- Setup: £1.50\n- Discount: £0.50\nTotal: £5.00")).toEqual([]);
    // Prose with amounts that are not a calculation or a labelled total is not judged.
    expect(moneyProblems("Gas safety checks typically cost £60 to £90.", [500])).toEqual([]);
  });

  // The real toolbox: the economy port records what was sent; the order's record is the authority.
  const toolbox = (order: { amountMinor: number; refundedMinor: number; currency?: string }, toolsDir?: string) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "money-"));
    const w = path.join(root, "w"), m = path.join(root, "m");
    fs.mkdirSync(w); fs.mkdirSync(m);
    const sent: Array<{ op: string; args: Record<string, unknown> }> = [];
    const economy = async (op: string, args: Record<string, unknown> = {}) => {
      if (op === "order.list") return { ok: true, orders: [{ orderId: ORDER, currency: "GBP", ...order }] };
      if (op === "money.currencies") return { ok: true, currencies: RECORDS };
      sent.push({ op, args });
      return { ok: true, messageId: "00000000-0000-4000-8000-000000000001" };
    };
    const t = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: w, memoryDir: m, loopGuard: new LoopGuard(), ...(toolsDir ? { toolsDir } : {}),
      ports: { ledger: async () => ({}), ownerRequests: async () => ({ ok: true, requests: [] }), economy } as never });
    let n = 0;
    const call = (name: string, a: Record<string, unknown>) => t.execute({ id: `money-${++n}`, name, arguments: a });
    return { t, sent, call, w };
  };

  it("an inconsistent total in a message to the buyer is caught before sending; the correct one is sent", async () => {
    const x = toolbox({ amountMinor: 500, refundedMinor: 0 });
    const wrong = await x.call("customers", { op: "order_message", args: { orderId: ORDER, message: "Your corrected tracker is attached. Total: £6.00 — nothing more to pay." } });
    expect(wrong).toMatchObject({ ok: false, refused: "FLEET_AMOUNT_MISMATCH" });
    expect(wrong.output).toMatch(/"Total: £6\.00" — £6\.00 is not one of this record's amounts.*This record's amounts: £0\.00, £5\.00\. .*calculate it with exec/s);
    expect(x.sent).toEqual([]);                                                    // nothing reached the buyer
    const calc = await x.call("customers", { op: "order_message", args: { orderId: ORDER, message: "Price £4.50 + VAT 20% = £5.50" } });
    expect(calc).toMatchObject({ ok: false, refused: "FLEET_AMOUNT_MISMATCH" });
    expect(calc.output).toContain("that calculation gives £5.40");
    const right = await x.call("customers", { op: "order_message", args: { orderId: ORDER, message: "Your corrected tracker is attached. You paid £5.00 in total." } });
    expect(right.ok, right.output).toBe(true);
    expect(x.sent.map((s) => s.op)).toEqual(["order.message"]);
  });

  it("refunds stated to the buyer match the payment and what is still refundable", async () => {
    const full = toolbox({ amountMinor: 500, refundedMinor: 0 });
    expect((await full.call("wallet", { op: "refund", args: { orderId: ORDER, reason: "Full refund of £5.00 as you asked." } })).ok).toBe(true);
    const over = await full.call("wallet", { op: "refund", args: { orderId: ORDER, reason: "Full refund of £6.00 as you asked." } });
    expect(over).toMatchObject({ ok: false, refused: "FLEET_AMOUNT_MISMATCH" });
    // After a £2.00 partial refund: £3.00 is what is still refundable; £4.00 is no figure of this order.
    const part = toolbox({ amountMinor: 500, refundedMinor: 200 });
    expect((await part.call("customers", { op: "order_message", args: { orderId: ORDER, message: "I have refunded the remaining £3.00." } })).ok).toBe(true);
    expect(await part.call("customers", { op: "order_message", args: { orderId: ORDER, message: "I have refunded the remaining £4.00." } }))
      .toMatchObject({ ok: false, refused: "FLEET_AMOUNT_MISMATCH" });
    // A quote states its own price: a labelled total in its scope must be that price (correct arithmetic is not enough).
    expect(await part.call("customers", { op: "quote", args: { enquiryId: "e1", scope: "Total: 3 trackers × £2.00 = £6.00", priceMinor: 500, turnaroundDays: 2 } }))
      .toMatchObject({ ok: false, refused: "FLEET_AMOUNT_MISMATCH" });
    expect((await part.call("customers", { op: "quote", args: { enquiryId: "e1", scope: "Total: 2 trackers × £2.50 = £5.00", priceMinor: 500, turnaroundDays: 2 } })).ok).toBe(true);
  });

  it("currencies the records use, with their ISO minor units; codes, symbols and words; no GBP-only rule", () => {
    // Minor units: JPY has none, KWD three; written amounts become exact minor units of their currency.
    expect(parseAmount("JPY 1,500")).toMatchObject({ currency: "JPY", precisionOk: true });
    expect(Number(roundHalfUp(parseAmount("KWD 1.250")!.minor))).toBe(1250);
    expect(Number(roundHalfUp(parseAmount("6.40 USD")!.minor))).toBe(640);
    expect(parseAmount("US$6.40")).toMatchObject({ currency: "USD" });
    expect(parseAmount("$6.40")).toMatchObject({ currency: null, ambiguous: "$" });
    expect(formatMoney(150_000, "JPY")).toBe("JPY 150,000");
    expect(formatMoney(1_250, "KWD")).toBe("KWD 1.250");
    for (const t of ["JPY 500 + JPY 250 = JPY 750", "KWD 1.250 + KWD 0.500 = KWD 1.750", "USD 4.50 + USD 0.50 = USD 5.00", "€10.00 + €5.00 = €15.00", "3 × 6.40 USD = 19.20 USD"]) {
      expect(moneyProblems(t, [], C), t).toEqual([]);
    }
    expect(moneyProblems("USD 4.50 + USD 0.50 = USD 5.10", [], C)).toEqual([expect.objectContaining({ kind: "calculation", stated: 510, expected: [500], currency: "USD" })]);
    expect(moneyProblems("JPY 500 + JPY 250 = JPY 760", [], C)).toEqual([expect.objectContaining({ kind: "calculation", stated: 760, expected: [750], currency: "JPY" })]);
    // Verified figures may be written in words; wrong ones are caught the same way.
    expect(wordsToNumber("five hundred and one")).toBe(501);
    expect(moneyProblems("Total: five pounds", [500], C)).toEqual([]);
    expect(moneyProblems("Total: five pounds and fifty pence", [550], C)).toEqual([]);
    expect(moneyProblems("Total: six pounds", [500], C)).toEqual([expect.objectContaining({ kind: "not_authoritative", stated: 600 })]);
    expect(moneyProblems("three pounds plus two pounds = six pounds", [], C)).toEqual([expect.objectContaining({ kind: "calculation", stated: 600, expected: [500] })]);
    // Ambiguous or over-precise claims are held back until identified or corrected.
    expect(moneyProblems("Price $4.50 + $0.50 = $5.00", [], C)).toEqual([expect.objectContaining({ kind: "ambiguous_currency" })]);
    expect(moneyProblems("Total: $5.00", [500], C)).toEqual([expect.objectContaining({ kind: "ambiguous_currency" })]);
    expect(moneyProblems("Total: £5.005", [500], C)).toEqual([expect.objectContaining({ kind: "precision", currency: "GBP" })]);
    expect(moneyProblems("£5.00 × 1.27 = US$6.35", [], C)).toEqual([expect.objectContaining({ kind: "mixed_currency" })]);
    // The record's currency is the record's: another currency is accepted as a marked approximation, not as the total.
    expect(moneyProblems("Total: about US$6.40", [500], C)).toEqual([]);
    expect(moneyProblems("Total: £5.00 (about US$6.40)", [500], C)).toEqual([]);
    expect(moneyProblems("Total: US$6.40", [500], C)).toEqual([expect.objectContaining({ kind: "not_authoritative", currency: "USD" })]);
    // A record in another currency is checked in that currency (no fleet-wide GBP assumption).
    expect(moneyProblems("Total: USD 6.40", [{ minor: 640, currency: "USD" }], C)).toEqual([]);
    expect(moneyProblems("Total: £6.40", [{ minor: 640, currency: "USD" }], C)).toEqual([expect.objectContaining({ kind: "not_authoritative" })]);
    // Not claims: a range in prose, counts that look like codes, figures without a currency, a comma after an amount.
    expect(moneyProblems("Gas safety checks typically cost £60 to £90.", [500], C)).toEqual([]);
    expect(moneyProblems("The 3 hrs and 5 PDF files total 8", [500], C)).toEqual([]);
    expect(moneyProblems("You paid £5.00, thanks.", [400], C)).toEqual([expect.objectContaining({ kind: "not_authoritative", stated: 500 })]);
  });

  it("the platform's pricing text (v105) passes; a changed line, subtotal or total in it does not", () => {
    // Exactly as fleet_price_lines renders 3 × £2.50 less 10%, 1 × £1.00, a 2.9% fee, VAT 20% (checked against PG in fleet-v100-obligations-pg).
    const text = ["- Tracker: 3 × £2.50 = £7.50, less 10% discount (£0.75) = £6.75", "- Setup: 1 × £1.00 = £1.00", "Subtotal: £7.75",
      "Card fee (2.9% of the subtotal): £0.22", "VAT 20%: £1.59", "Total: £9.56"].join("\n");
    expect(moneyProblems(text, [956], C)).toEqual([]);
    expect(moneyProblems(text.replace("Subtotal: £7.75", "Subtotal: £8.75"), [956], C)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "itemised_total", stated: 875, expected: [775] })]));
    expect(moneyProblems(text.replace("Total: £9.56", "Total: £9.66"), [956], C)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "itemised_total", stated: 966, expected: [956] })]));
    expect(moneyProblems(text.replace("3 × £2.50 = £7.50", "3 × £2.50 = £7.00"), [956], C)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "calculation", stated: 700, expected: [750] })]));
    // Inclusive tax is shown, not added.
    expect(moneyProblems("- Report: 1 × £12.00 = £12.00\nSubtotal: £12.00\nTotal: £12.00\n(includes VAT 20%: £2.00)", [1200], C)).toEqual([]);
  });

  it("a quote with line items is checked against the platform's calculation (money.price), not the agent's arithmetic", async () => {
    const x = toolbox({ amountMinor: 500, refundedMinor: 0 });
    const priced: Array<Record<string, unknown>> = [];
    const econ = (x.t as unknown as { o: { ports: { economy: (op: string, a: Record<string, unknown>) => Promise<unknown> } } }).o.ports;
    const inner = econ.economy;
    econ.economy = async (op, a) => {
      if (op === "money.price") { priced.push(a); return { ok: true, pricing: { currency: "GBP", lines: [{ lineMinor: 750 }], subtotalMinor: 750, totalMinor: 900, tax: { minor: 150 } } }; }
      if (op === "enquiry.read") return { ok: true, enquiry: {} };
      return inner(op, a);
    };
    const items = [{ description: "Tracker", quantity: 3, unitMinor: 250 }];
    expect((await x.call("customers", { op: "quote", args: { enquiryId: "e1", scope: "Three trackers. Total: £9.00 including VAT", items, tax: { bp: 2000 }, turnaroundDays: 2 } })).ok).toBe(true);
    expect(await x.call("customers", { op: "quote", args: { enquiryId: "e1", scope: "Three trackers. Total: £9.50", items, tax: { bp: 2000 }, turnaroundDays: 2 } }))
      .toMatchObject({ ok: false, refused: "FLEET_AMOUNT_MISMATCH" });
    expect(priced[0]).toEqual({ items, fees: undefined, tax: { bp: 2000 } });
  });

  // Real documents through the delivery path: made with the agent toolchain, extracted in the sandbox, checked before staging.
  it.skipIf(!HAVE_TOOLS)("an incorrect calculation inside a real PDF or DOCX is refused before delivery; correct ones are delivered, with what was read", async () => {
    const x = toolbox({ amountMinor: 500, refundedMinor: 0 }, DEV_TOOLS);
    fs.writeFileSync(path.join(x.w, "make.py"), String.raw`
import docx
from reportlab.pdfgen import canvas
def pdf(name, lines):
    c = canvas.Canvas(name)
    for i, l in enumerate(lines):
        c.drawString(72, 760 - 18 * i, l)
    c.save()
pdf("costs-bad.pdf", ["Renovation estimate", "Labour: 12 hours x £25.00 = £320.00", "Thank you."])
pdf("costs-ok.pdf", ["Renovation estimate", "Labour: 12 hours x £25.00 = £300.00", "Thank you."])
def doc(name, total):
    d = docx.Document()
    d.add_paragraph("Monthly budget")
    t = d.add_table(rows=0, cols=2)
    for a, b in [("Rent", "£650.00"), ("Utilities", "£120.50"), ("Insurance", "£29.50"), ("Total", total)]:
        r = t.add_row().cells
        r[0].text = a; r[1].text = b
    d.save(name)
doc("budget-bad.docx", "£810.00")
doc("budget-ok.docx", "£800.00")
`);
    const made = await runSandboxed(x.w, "python3 make.py", { timeoutMs: 120_000, maxOutput: 20_000, toolsDir: DEV_TOOLS });
    expect(made.code, made.output).toBe(0);
    const deliver = (paths: string[]) => x.call("wallet", { op: "deliver", args: { orderId: ORDER, paths, message: "Your files are attached." } });

    const badPdf = await deliver(["costs-bad.pdf"]);
    expect(badPdf).toMatchObject({ ok: false, refused: "FLEET_AMOUNT_MISMATCH" });
    expect(badPdf.output).toMatch(/in costs-bad\.pdf: .*that calculation gives £300\.00 .*not £320\.00.*Nothing was delivered/s);
    const badDocx = await deliver(["costs-ok.pdf", "budget-bad.docx"]);
    expect(badDocx).toMatchObject({ ok: false, refused: "FLEET_AMOUNT_MISMATCH" });
    expect(badDocx.output).toMatch(/in budget-bad\.docx: .*the lines above it add up to £800\.00, not £810\.00/s);
    expect(badDocx.output).not.toContain("costs-ok.pdf");
    expect(x.sent).toEqual([]);                                                    // nothing was staged or delivered

    const ok = await deliver(["costs-ok.pdf", "budget-ok.docx"]);
    expect(ok.ok, ok.output).toBe(true);
    expect(x.sent.map((s) => s.op)).toEqual(["order.stage_file", "order.stage_file", "order.deliver"]);
    // The result says what the check read and what it could not (no claim that every figure was checked).
    expect(ok.output).toContain('"moneyCheck"');
    expect(ok.output).toMatch(/budget-ok\.docx.*headers, footers, text boxes/s);
    expect(ok.output).toMatch(/formulas and figures without a currency are not/);
  }, 240_000);

  it.skipIf(!HAVE_TOOLS)("wallet invoice writes the record's invoice to the workspace as text and PDF (the figures are the record's)", async () => {
    const x = toolbox({ amountMinor: 650, refundedMinor: 0 }, DEV_TOOLS);
    const econ = (x.t as unknown as { o: { ports: { economy: (op: string, a: Record<string, unknown>) => Promise<unknown> } } }).o.ports;
    const inner = econ.economy;
    const text = "INVOICE INV-9A443C84C5\nIssued: 20 Oct 2026\nSeller: (seller details not set)\nBilled to: Ada\nOrder: " + ORDER
      + "\n\n- Landlord tracker: 2 × £2.50 = £5.00\n- Set-up call: 1 × £3.00 = £3.00, less 50% discount (£1.50) = £1.50\nSubtotal: £6.50\nTotal: £6.50\n\nPaid: £6.50 (PayPal)";
    econ.economy = async (op, a) => (op === "order.invoice" ? { ok: true, invoice: { number: "INV-9A443C84C5", amountMinor: 650, currency: "GBP", text } } : inner(op, a));
    const r = await x.call("wallet", { op: "invoice", args: { orderId: ORDER } });
    expect(r.ok, r.output).toBe(true);
    expect(r.output).toContain('"paths":["invoices/INV-9A443C84C5.txt","invoices/INV-9A443C84C5.pdf"]');
    expect(fs.readFileSync(path.join(x.w, "invoices/INV-9A443C84C5.txt"), "utf8")).toBe(`${text}\n`);
    const back = await runSandboxed(x.w, `python3 -c "import pypdf; print(pypdf.PdfReader('invoices/INV-9A443C84C5.pdf').pages[0].extract_text())"`, { timeoutMs: 60_000, maxOutput: 20_000, toolsDir: DEV_TOOLS });
    expect(back.output).toContain("Total: £6.50");
    expect(moneyProblems(back.output, [650], C)).toEqual([]);                        // the PDF's own text passes the same checks
  }, 120_000);

  it("a call's reservation bounds its cost: any usage within the request's bytes and the output allowance costs no more", () => {
    const prices = { inputMicrocentsPerToken: 400, outputMicrocentsPerToken: 2000, cacheWriteMicrocentsPerToken: 500, cacheReadMicrocentsPerToken: 20 };
    const prompt = JSON.stringify({ system: "charter ".repeat(2000), messages: [{ role: "user", content: "TASK PACKET ".repeat(5000) }] });
    const tools = [{ name: "exec", description: "run a command ".repeat(300), parameters: { type: "object" } }];
    const bound = costBoundMicro(prompt, tools, 1_600, 16_000, prices);            // one image at its bound
    const bytes = Buffer.byteLength(prompt) + Buffer.byteLength(JSON.stringify(tools)) + 1_600 + PROVIDER_FRAMING_TOKENS;
    // The dearest split of those input tokens (all cache writes) and the whole output allowance.
    expect(costMicrocents({ inputTokens: 0, cacheWriteTokens: bytes, cacheReadTokens: 0, outputTokens: 16_000 }, prices)).toBe(bound);
    for (const split of [[bytes, 0, 0], [0, 0, bytes], [bytes / 2, bytes / 2, 0]]) {
      expect(costMicrocents({ inputTokens: split[0], cacheWriteTokens: split[1], cacheReadTokens: split[2], outputTokens: 16_000 }, prices)).toBeLessThanOrEqual(bound);
    }
  });
});
