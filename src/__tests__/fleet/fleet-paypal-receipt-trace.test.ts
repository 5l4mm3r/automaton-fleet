/**
 * The read-only receipt trace (scripts/fleet-paypal-receipt-trace.mjs, incident 2026-10-30): it refuses anything but reads, tells a
 * sender's id from the recipient's row by the reference PayPal gives, and never prints a name, a full address or a token.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error a plain script
import { maskEmail, readOnlyHttp, trace } from "../../../scripts/fleet-paypal-receipt-trace.mjs";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const O = { target: "79T2209859237554T", now: NOW, hours: 72, minor: 250, currency: "GBP" };
const detail = (over: Record<string, unknown> = {}, payer: Record<string, unknown> = {}) => ({
  transaction_info: { transaction_id: "RECIPIENTSIDE0001", transaction_event_code: "T0000", transaction_status: "S", transaction_initiation_date: "2026-10-30T08:55:00+0000",
    transaction_amount: { currency_code: "GBP", value: "2.50" }, fee_amount: { currency_code: "GBP", value: "0.00" }, ...over },
  payer_info: { email_address: "owner.private@example.test", account_id: "PAYERACCOUNT9876", payer_name: { given_name: "Secret", surname: "Name" }, ...payer },
});
function fake(rows: unknown[], extra: Record<string, unknown> = {}) {
  const paths: string[] = [];
  const call = async (method: string, p: string) => {
    expect(method).toBe("GET");
    paths.push(p);
    if (p.startsWith("/v1/reporting/balances")) return { status: 200, debugId: "d1", json: { account_id: "TREASURYACCOUNT12", as_of_time: "2026-10-30T09:00:00Z", last_refresh_time: "2026-10-30T08:00:00Z", balances: [{ currency: "GBP", available_balance: { value: "0.22" }, total_balance: { value: "0.22" } }] } };
    if (p.startsWith("/v1/identity")) return { status: 200, json: { payer_id: "PAYERIDTREASURY1", emails: [{ value: "fleet.treasury@proton.me", primary: true }] } };
    return { status: 200, debugId: "d2", json: { start_date: "s", end_date: "e", last_refreshed_datetime: "2026-10-30T07:59:59+0000", total_items: rows.length, total_pages: 1, transaction_details: rows, ...extra } };
  };
  return { call, paths };
}

describe("PayPal receipt trace", () => {
  it("anything but a read (or the sign-in) is refused before it is sent", async () => {
    const sent: string[] = [];
    const http = readOnlyHttp(async (url: string) => { sent.push(url); return { status: 200 }; });
    await http("https://x.test/v1/reporting/balances", { method: "GET" });
    await http("https://x.test/v1/oauth2/token", { method: "POST" });
    for (const [m, p] of [["POST", "/v2/checkout/orders"], ["POST", "/v2/payments/captures/X/refund"], ["PATCH", "/v1/notifications/webhooks/X"], ["DELETE", "/v1/notifications/webhooks/X"]])
      await expect(http(`https://x.test${p}`, { method: m })).rejects.toThrow(/refused/);
    expect(sent).toHaveLength(2);
  });

  it("a sender's id is found through the recipient row's reference; a same-amount row is only a candidate", async () => {
    const f = fake([detail({ paypal_reference_id: O.target, paypal_reference_id_type: "TXN" })]);
    const r = await trace(f.call, O);
    expect(r.targetFound).toBe(true);
    expect(r.candidates.map((c: any) => c.transactionId)).toEqual(["RECIPIENTSIDE0001"]);
    expect(r.search.all).toMatchObject({ http: 200, lastRefreshed: "2026-10-30T07:59:59+0000", totalItems: 1 });
    expect(f.paths.some((p) => p.includes(`transaction_id=${O.target}`))).toBe(true);
    expect(f.paths.some((p) => p.includes("balance_affecting_records_only=N"))).toBe(true);
    const unrelated = await trace(fake([detail()]).call, O);
    expect(unrelated.targetFound).toBe(false);
    expect(unrelated.candidates).toHaveLength(1);
  });

  it("an Add money top-up is shown with its own type and funding instrument; the row's id is the target", async () => {
    const f = fake([detail({ transaction_id: O.target, transaction_event_code: "T0300", instrument_type: "CREDITCARD", instrument_sub_type: "DEBIT" }, { email_address: undefined, account_id: undefined })]);
    const r = await trace(f.call, O);
    expect(r.targetFound).toBe(true);
    expect(r.search.all.rows[0]).toMatchObject({ transactionId: O.target, eventCode: "T0300", status: "S", amount: "2.50", fee: "0.00", currency: "GBP", instrumentType: "CREDITCARD", instrumentSubType: "DEBIT", payer: null });
  });

  it("an empty answer says how far PayPal's data reaches, so absence is not read as a fault", async () => {
    const r = await trace(fake([]).call, O);
    expect(r.targetFound).toBe(false);
    expect(r.search.all.lastRefreshed).toBe("2026-10-30T07:59:59+0000");
    expect(r.balances).toMatchObject({ accountTail: "…NT12", lastRefresh: "2026-10-30T08:00:00Z" });
    expect(r.identity.emails).toEqual([{ email: "f***@proton.me", primary: true }]);
  });

  it("never prints a name, a full address or a full account id", async () => {
    const text = JSON.stringify(await trace(fake([detail()]).call, O));
    for (const secret of ["owner.private", "Secret", "PAYERACCOUNT9876", "TREASURYACCOUNT12", "PAYERIDTREASURY1", "fleet.treasury"]) expect(text).not.toContain(secret);
    expect(maskEmail("owner.private@example.test")).toBe("o***@example.test");
  });
});
