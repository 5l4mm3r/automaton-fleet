/**
 * v86 bank feed service end to end (PostgreSQL + a SIMULATED Starling; no bank account): the service, as the bank-feed role,
 * records the account's transactions and then its balance into the money location; a card line matches the agent-less
 * evidence path, and a token that can do more than read is refused before any data is read.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { startLocationFeed } from "../../fleet/settlement/location-feed-main.js";

const PG_BIN = findPgBin();
const ACCOUNT = "11111111-2222-3333-4444-555555555555", CATEGORY = "66666666-7777-8888-9999-000000000000";
const gbp = (minorUnits: number) => ({ currency: "GBP", minorUnits });

function starling(scopes: string[]) {
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    const p = new URL(url).pathname;
    const body = p === "/api/v2/identity/token" ? { scopes }
      : p.endsWith("/balance") ? { effectiveBalance: gbp(41_700), clearedBalance: gbp(42_000), pendingTransactions: gbp(300) }
      : { feedItems: [
        { feedItemUid: "a1", direction: "OUT", status: "SETTLED", source: "STARLING_PAY_STRIPE", spendingCategory: "BANK_CHARGES", amount: gbp(200), counterPartyName: "Starling", settlementTime: new Date(Date.now() - 3_600_000).toISOString() },
        { feedItemUid: "a2", direction: "OUT", status: "PENDING", source: "MASTER_CARD", amount: gbp(300), counterPartyName: "SOMEWHERE", transactionTime: new Date().toISOString() },
      ] };
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetch, urls };
}

describe.skipIf(!PG_BIN)("v86 bank feed service (PostgreSQL, simulated Starling)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let loc = "";
  let dir = "";
  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, simulatedSettlement: false });
    loc = (await R.one<any>(`fleet.fleet_admin_location_add('bank', 'starling', 'Starling', NULL, $1)`, [OWNER])).locationId;
    await R.q(`SELECT fleet.fleet_admin_location_status($1, 'active', NULL, $2)`, [loc, OWNER]);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bankfeed-"));
    fs.writeFileSync(path.join(dir, `bank_${loc}`), "tok-simulated-0123456789abcdef");
  }, 300_000);
  afterAll(async () => { fs.rmSync(dir, { recursive: true, force: true }); await R?.close(); });

  const env = () => ({ FLEET_BANKFEED_DATABASE_URL: R.pgc.bankfeedUrl, CREDENTIALS_DIRECTORY: dir,
    FLEET_LOCATION_FEED_ACCOUNTS: JSON.stringify([{ locationId: loc, provider: "starling", accountUid: ACCOUNT, categoryUid: CATEGORY }]) });

  it("a pass records the account's lines, then its balance; the location becomes spendable from fresh evidence", async () => {
    const s = starling(["account:read", "balance:read", "transaction:read"]);
    const svc = await startLocationFeed(env(), { uid: 1000, username: "u", fetch: s.fetch as never, pollMs: 3_600_000, log: () => {} });
    await svc.tick();
    await svc.close();
    const lines = await R.q(`SELECT external_id, status, kind, source FROM fleet.fleet_bank_transactions WHERE location_id = $1 ORDER BY external_id`, [loc]);
    expect(lines).toEqual([{ external_id: "starling:a1", status: "settled", kind: "fee", source: "api" }, { external_id: "starling:a2", status: "pending", kind: "card", source: "api" }]);
    const liq = await R.one<any>(`fleet.fleet_location_liquidity($1)`, [loc]);
    expect(liq).toMatchObject({ stale: false, availableMinor: 41_700 });
    expect(Number(liq.freeMinor)).toBe(41_700); // the reading came after its lines: nothing counted twice
  });

  it("a token that can do more than read is refused before any data is read", async () => {
    const before = await R.one(`(SELECT count(*) FROM fleet.fleet_bank_balance_observations WHERE location_id = $1)`, [loc]);
    const s = starling(["account:read", "transaction:read", "pay-local:create"]);
    const svc = await startLocationFeed(env(), { uid: 1000, username: "u", fetch: s.fetch as never, pollMs: 3_600_000, log: () => {} });
    await svc.tick();
    await svc.close();
    expect(s.urls.every((u) => u.endsWith("/api/v2/identity/token"))).toBe(true);
    expect(await R.one(`(SELECT count(*) FROM fleet.fleet_bank_balance_observations WHERE location_id = $1)`, [loc])).toBe(before);
  });
});
