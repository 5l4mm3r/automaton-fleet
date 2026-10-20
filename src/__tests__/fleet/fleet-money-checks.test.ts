/**
 * Money a founder tells its customers, and the run allowance (owner, 2026-10-20: "do not rely on model-generated arithmetic
 * for monetary totals"; "500p + 101p equals 601p, not 701p").
 *  - exact integer-pence arithmetic with one explicit rounding rule (half-up to the penny);
 *  - written calculations, itemised totals and labelled totals in customer-facing text are checked before sending, against
 *    exact arithmetic and the record's authoritative amounts (the real FounderToolbox, the economy port stubbed);
 *  - refunds stated to a buyer must match the payment and what is still refundable;
 *  - a call's reservation is a true upper bound of its cost (so the run's usage, its credit draw and the tax/fee on it
 *    stay within the displayed all-inclusive maximum).
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { formatPence, moneyProblems, parsePence, roundHalfUp, sumPence } from "../../fleet/founder/money.js";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { FOUNDER_MANIFEST_V2 } from "../../fleet/capabilities.js";
import { costBoundMicro, PROVIDER_FRAMING_TOKENS } from "../../fleet/cognition/routed-gateway.js";
import { costMicrocents } from "../../fleet/cognition/charging.js";

const ORDER = "9a443c84-c55c-44e6-862c-3f4cc5d6c9e0";

describe("money in customer-facing text (exact pence, checked before sending)", () => {
  it("500p + 101p = 601p — exactly, and a written £7.01 for it is caught", () => {
    expect(sumPence([500, 101])).toBe(601);
    expect(formatPence(601)).toBe("£6.01");
    expect(parsePence("£6.01")).toBe(601);
    expect(moneyProblems("Usage £5.00 + acquisition tax/fee £1.01 = £6.01")).toEqual([]);
    expect(moneyProblems("Usage £5.00 + acquisition tax/fee £1.01 = £7.01")).toEqual([expect.objectContaining({ kind: "calculation", stated: 701, expected: [601] })]);
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
  const toolbox = (order: { amountMinor: number; refundedMinor: number }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "money-"));
    const w = path.join(root, "w"), m = path.join(root, "m");
    fs.mkdirSync(w); fs.mkdirSync(m);
    const sent: Array<{ op: string; args: Record<string, unknown> }> = [];
    const economy = async (op: string, args: Record<string, unknown> = {}) => {
      if (op === "order.list") return { ok: true, orders: [{ orderId: ORDER, ...order }] };
      sent.push({ op, args });
      return { ok: true, messageId: "00000000-0000-4000-8000-000000000001" };
    };
    const t = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: w, memoryDir: m, loopGuard: new LoopGuard(),
      ports: { ledger: async () => ({}), ownerRequests: async () => ({ ok: true, requests: [] }), economy } as never });
    let n = 0;
    const call = (name: string, a: Record<string, unknown>) => t.execute({ id: `money-${++n}`, name, arguments: a });
    return { t, sent, call };
  };

  it("an inconsistent total in a message to the buyer is caught before sending; the correct one is sent", async () => {
    const x = toolbox({ amountMinor: 500, refundedMinor: 0 });
    const wrong = await x.call("customers", { op: "order_message", args: { orderId: ORDER, message: "Your corrected tracker is attached. Total: £6.00 — nothing more to pay." } });
    expect(wrong).toMatchObject({ ok: false, refused: "FLEET_AMOUNT_MISMATCH" });
    expect(wrong.output).toMatch(/"Total: £6\.00" — £6\.00 is not one of this record's amounts.*This record's amounts: £0\.00, £5\.00\. .*Calculate money with exec/s);
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

  it("a call's reservation bounds its cost: any usage within the request's bytes and the output allowance costs no more", () => {
    const prices = { inputMicrocentsPerToken: 400, outputMicrocentsPerToken: 2000, cacheWriteMicrocentsPerToken: 500, cacheReadMicrocentsPerToken: 20 };
    const prompt = JSON.stringify({ system: "charter ".repeat(2000), messages: [{ role: "user", content: "TASK PACKET ".repeat(5000) }] });
    const tools = [{ name: "exec", description: "run a command ".repeat(300), parameters: { type: "object" } }];
    const bound = costBoundMicro(prompt, tools, 1, 16_000, prices);
    const bytes = Buffer.byteLength(prompt) + Buffer.byteLength(JSON.stringify(tools)) + 1_600 + PROVIDER_FRAMING_TOKENS;
    // The dearest split of those input tokens (all cache writes) and the whole output allowance.
    expect(costMicrocents({ inputTokens: 0, cacheWriteTokens: bytes, cacheReadTokens: 0, outputTokens: 16_000 }, prices)).toBe(bound);
    for (const split of [[bytes, 0, 0], [0, 0, bytes], [bytes / 2, bytes / 2, 0]]) {
      expect(costMicrocents({ inputTokens: split[0], cacheWriteTokens: split[1], cacheReadTokens: split[2], outputTokens: 16_000 }, prices)).toBeLessThanOrEqual(bound);
    }
  });
});
