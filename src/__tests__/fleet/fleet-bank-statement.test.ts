/**
 * v86 bank statement import: the owner's CSV export becomes settled bank lines with stable ids (an overlapping re-export
 * records nothing twice), kinds only from the bank's own type column, and nothing invented (no balance taken as "now").
 */
import { describe, it, expect } from "vitest";
import { parseCsv, parseStatement, toIsoDate, toMinor } from "../../fleet/treasury/bank-statement.js";

const STARLING = [
  "Date,Counter Party,Reference,Type,Amount (GBP),Balance (GBP),Spending Category,Notes",
  "14/10/2026,PayPal,PP-TXN-0001,FASTER PAYMENT,300.00,500.00,INCOME,",
  "15/10/2026,Canva,\"CANVA, PRO\",CARD PAYMENT,-10.99,489.01,GENERAL,",
  "15/10/2026,Canva,\"CANVA, PRO\",CARD PAYMENT,-10.99,478.02,GENERAL,",
  "16/10/2026,Canva,Refund,CARD PAYMENT,10.99,489.01,GENERAL,",
  "16/10/2026,Starling,Monthly fee,FEE,-2.00,487.01,GENERAL,",
  "16/10/2026,Starling,Interest,INTEREST,0.12,487.13,INCOME,",
  "31/02/2026,Bad,date,OTHER,-1.00,,,",
].join("\r\n");

describe("bank statement import (v86)", () => {
  it("parses quoted CSV, amounts and UK / ISO dates strictly", () => {
    expect(parseCsv('a,"b, c","d ""q"""\n1,2,3\n')).toEqual([["a", "b, c", 'd "q"'], ["1", "2", "3"]]);
    expect([toMinor("-10.99"), toMinor("1,234.5"), toMinor("£5"), toMinor("(4.00)"), toMinor("abc"), toMinor("1.234")]).toEqual([-1099, 123450, 500, -400, null, null]);
    expect([toIsoDate("15/10/2026"), toIsoDate("2026-10-15"), toIsoDate("31/02/2026"), toIsoDate("15 Oct")]).toEqual(["2026-10-15", "2026-10-15", null, null]);
  });

  it("a Starling export: kinds from the bank's type column, identical lines kept apart, invalid lines reported, never past the import time", () => {
    const now = new Date("2026-10-16T12:00:00Z");
    const st = parseStatement(STARLING, { now });
    expect(st.currency).toBe("GBP");
    expect(st.skipped).toEqual([{ row: 8, reason: "no valid date" }]);
    expect(st.lines.map((l) => [l.direction, l.kind, l.amountMinor])).toEqual([
      ["in", "transfer", 30000], ["out", "card", 1099], ["out", "card", 1099], ["in", "card_refund", 1099], ["out", "fee", 200], ["in", "interest", 12]]);
    expect(new Set(st.lines.map((l) => l.externalId)).size).toBe(6); // the two identical-looking Canva lines differ by balance
    expect(st.lines.every((l) => l.status === "settled")).toBe(true);
    expect(st.lines[1].settledAt).toBe("2026-10-15T23:59:59.000Z");
    expect(st.lines[5].settledAt).toBe(now.toISOString()); // today's line: capped at the import time
    expect(st.closingBalanceMinor).toBe(48713); // reported for comparison only; never recorded as the current balance
    // A re-export overlapping the first: the same ids.
    expect(parseStatement(STARLING, { now }).lines.map((l) => l.externalId)).toEqual(st.lines.map((l) => l.externalId));
  });

  it("a generic export with Paid in / Paid out; exact duplicates are told apart by position; a line with both sides is refused", () => {
    const st = parseStatement(["Transaction Date,Description,Paid out,Paid in", "2026-10-10,FEE,1.00,", "2026-10-10,FEE,1.00,", "2026-10-11,OWNER DEPOSIT,,50.00", "2026-10-12,X,1.00,2.00"].join("\n"),
      { now: new Date("2026-10-16T00:00:00Z") });
    expect(st.lines.map((l) => [l.direction, l.kind, l.amountMinor])).toEqual([["out", "other", 100], ["out", "other", 100], ["in", "other", 5000]]);
    expect(st.lines[0].externalId).not.toBe(st.lines[1].externalId);
    expect(st.skipped).toEqual([{ row: 5, reason: "both paid in and paid out" }]);
    expect(() => parseStatement("Date,Description\n2026-10-10,x")).toThrow(/Amount column/);
  });
});
