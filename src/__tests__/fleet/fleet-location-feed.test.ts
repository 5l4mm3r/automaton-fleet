/**
 * v86 money-location feed against a SIMULATED Starling (no bank account): read-only scopes only, Starling feed items
 * mapped to bank evidence, transactions recorded before the balance, a write-capable token refused outright.
 */
import { describe, it, expect } from "vitest";
import { LocationFeedConnector, StarlingClient, readOnlyScope, starlingTxn, type LocationBalance, type LocationTxn } from "../../fleet/settlement/location-feed.js";

const ACCOUNT = "11111111-2222-3333-4444-555555555555", CATEGORY = "66666666-7777-8888-9999-000000000000", LOC = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const gbp = (minorUnits: number) => ({ currency: "GBP", minorUnits });

function simulatedStarling(scopes: string[]) {
  const seen: string[] = [];
  const fetch = async (url: string, init: { headers: Record<string, string> }) => {
    seen.push(url);
    expect(init.headers.Authorization).toBe("Bearer tok-simulated");
    const path = new URL(url).pathname;
    const body = path === "/api/v2/identity/token" ? { scopes }
      : path.endsWith("/balance") ? { effectiveBalance: gbp(48_150), clearedBalance: gbp(50_000), pendingTransactions: gbp(1_850) }
      : { feedItems: [
        { feedItemUid: "f1", direction: "OUT", status: "PENDING", source: "MASTER_CARD", amount: gbp(1_850), counterPartyName: "SHOP LTD", transactionTime: "2026-10-16T10:00:00Z" },
        { feedItemUid: "f2", direction: "OUT", status: "SETTLED", source: "MASTER_CARD", amount: gbp(980), sourceAmount: { currency: "USD", minorUnits: 1_250 }, counterPartyName: "TOOL INC", transactionTime: "2026-10-15T09:00:00Z", settlementTime: "2026-10-16T02:00:00Z" },
        { feedItemUid: "f3", direction: "IN", status: "SETTLED", source: "FASTER_PAYMENTS_IN", amount: gbp(30_000), counterPartyName: "PayPal", reference: "PP-TXN-0001", settlementTime: "2026-10-16T08:00:00Z" },
        { feedItemUid: "f4", direction: "OUT", status: "SETTLED", source: "STARLING_PAY_STRIPE", spendingCategory: "BANK_CHARGES", amount: gbp(300), counterPartyName: "Starling", settlementTime: "2026-10-16T08:00:00Z" },
        { feedItemUid: "f5", direction: "OUT", status: "UPCOMING", source: "DIRECT_DEBIT", amount: gbp(500) },
        { feedItemUid: "f6", direction: "OUT", status: "DECLINED", source: "MASTER_CARD", amount: gbp(700), counterPartyName: "SHOP LTD", transactionTime: "2026-10-16T11:00:00Z" },
      ] };
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetch, seen };
}

function port() {
  const calls: Array<["txn", LocationTxn] | ["balance", LocationBalance]> = [];
  return {
    calls,
    locations: async () => [{ locationId: LOC, provider: "starling", currency: "GBP", status: "active" }],
    balance: async (_w: string, _l: string, b: LocationBalance) => { calls.push(["balance", b]); return { ok: true }; },
    txn: async (_w: string, _l: string, t: LocationTxn) => { calls.push(["txn", t]); return { ok: true }; },
  };
}
const vault = { resolve: async (ref: string) => (ref === "vault:bank/starling" ? "tok-simulated" : null) };

describe("money-location feed (v86; simulated Starling)", () => {
  it("maps Starling items: pending / settled / declined, card / transfer / fee, FX kept, upcoming items skipped", () => {
    expect(starlingTxn({ feedItemUid: "x", direction: "OUT", status: "UPCOMING", source: "DIRECT_DEBIT", amount: gbp(1) })).toBeNull();
    expect(starlingTxn({ feedItemUid: "r", direction: "IN", status: "SETTLED", source: "MASTER_CARD", amount: gbp(370), counterPartyName: "Shop Ltd", settlementTime: "2026-10-16T00:00:00Z" }))
      .toMatchObject({ externalId: "starling:r", kind: "card_refund", direction: "in", status: "settled", settledAt: "2026-10-16T00:00:00Z" });
    expect([readOnlyScope("transaction:read"), readOnlyScope("account-list:read"), readOnlyScope("pay-local:create"), readOnlyScope("payee:edit")]).toEqual([true, true, false, false]);
  });

  it("one pass records the transactions, then the balance (the reading taken after them)", async () => {
    const s = simulatedStarling(["account:read", "balance:read", "transaction:read"]);
    const p = port();
    const c = new LocationFeedConnector(p, vault, { starling: new StarlingClient({ accountUid: ACCOUNT, categoryUid: CATEGORY, fetch: s.fetch }) }, { [LOC]: "vault:bank/starling" },
      { now: () => Date.parse("2026-10-16T12:00:00Z") });
    expect(await c.tick()).toEqual({ locations: 1, recorded: 5, refused: 0 });
    expect(p.calls.map((x) => x[0])).toEqual(["txn", "txn", "txn", "txn", "txn", "balance"]);
    const txns = p.calls.filter((x) => x[0] === "txn").map((x) => x[1] as LocationTxn);
    expect(txns.map((t) => [t.status, t.kind, t.amountMinor])).toEqual([["pending", "card", 1850], ["settled", "card", 980], ["settled", "transfer", 30000], ["settled", "fee", 300], ["declined", "card", 700]]);
    expect(txns[1]).toMatchObject({ originalAmountMinor: 1250, originalCurrency: "USD", authorisedAt: "2026-10-15T09:00:00Z", settledAt: "2026-10-16T02:00:00Z" });
    expect(p.calls.at(-1)).toEqual(["balance", { availableMinor: 48150, clearedMinor: 50000, pendingMinor: 1850, currency: "GBP" }]);
    expect(s.seen.some((u) => u.includes("changesSince=2026-10-13T12%3A00%3A00.000Z"))).toBe(true);
  });

  it("a token that can do anything but read is refused before any data is read; an unconfigured location is skipped", async () => {
    const s = simulatedStarling(["account:read", "transaction:read", "pay-local:create"]);
    const p = port();
    const c = new LocationFeedConnector(p, vault, { starling: new StarlingClient({ accountUid: ACCOUNT, categoryUid: CATEGORY, fetch: s.fetch }) }, { [LOC]: "vault:bank/starling" });
    expect(await c.tick()).toEqual({ locations: 1, recorded: 0, refused: 1 });
    expect(p.calls).toEqual([]);
    expect(s.seen.every((u) => u.endsWith("/api/v2/identity/token"))).toBe(true);
    const none = new LocationFeedConnector(port(), vault, { starling: new StarlingClient({ accountUid: ACCOUNT, categoryUid: CATEGORY, fetch: s.fetch }) }, {});
    expect(await none.tick()).toEqual({ locations: 1, recorded: 0, refused: 1 });
  });
});
