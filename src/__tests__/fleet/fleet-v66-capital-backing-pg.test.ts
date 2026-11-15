/**
 * Schema v66 — backing the existing capital with real money (PostgreSQL; no money moves):
 *  - the reconciliation: capital recorded without money, minus backed = unbacked (since v69 AI costs paid from the owner's
 *    provider credit are owed to the owner, not backing);
 *  - a real PayPal deposit backs it without a second ledger credit; only the part beyond the unbacked amount is new owner
 *    funding; the transaction is closed and its key can never be recorded again (funding, attribution, a second backing);
 *  - only completed money in the books' currency, received into the treasury, by the owner; backings are history.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { liveRail, type ArmedCustody } from "./fixtures/custody-signer.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";

const PG_BIN = findPgBin();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

describe.skipIf(!PG_BIN)("v66: backing the existing capital (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let custody: pg.Pool;
  let rail: ArmedCustody;
  const W = "custody-executor";
  const session = crypto.randomBytes(16).toString("hex");
  const dash = (op: string, args: object) => R.one<Record<string, any>>(`fleet.dash_call($1, $2, $3, $4, NULL, 'test')`, [sha(session), sha("csrf"), op, JSON.stringify(args)]);
  const id = (p: string) => `${p}${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
  const cx = async (fn: string, args: unknown[]) => (await custody.query(`SELECT fleet.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) AS r`, args)).rows[0].r;
  const deposit = async (amountMinor: number, feeMinor = 0, o: { status?: string; currency?: string; eventCode?: string } = {}) => {
    const tid = id("D");
    const r = await cx("cx_paypal_txn_record", [W, rail.railId, JSON.stringify({ transactionId: tid, eventCode: o.eventCode ?? "T0000",
      initiatedAt: new Date().toISOString(), status: o.status ?? "S", currency: o.currency ?? "GBP", amountMinor, feeMinor })]);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return { tid, eventCode: o.eventCode ?? "T0000" };
  };
  const back = (t: { tid: string; eventCode: string }, actor = OWNER) =>
    R.one<Record<string, any>>(`fleet.fleet_admin_capital_back($1, $2, $3, $4)`, [rail.railId, t.tid, t.eventCode, actor]);
  const status = () => R.one<Record<string, any>>(`fleet.fleet_capital_backing()`);
  const journals = async () => Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ledger_journal)`));
  const capital = () => R.balance("fleet:owner:capital");

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, treasuryCents: 10_000, simulatedSettlement: false });
    await R.store.grantCustodyRole();
    custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 2, options: "-c search_path=fleet" });
    rail = await liveRail(R.owner, "fleet", OWNER);
    // As in production: owner capital recorded with no money behind it, then an AI cost paid from provider credit (£5.00).
    await R.ledger.recordOwnerFunding(20_000, "owner-authorized-virtual:test-founders:2026-10-12", OWNER);
    expect(await R.one(`fleet.fleet_control_charge('knowledge_review_charge', 'test', $1::jsonb)`,
      [JSON.stringify([{ provider: "anthropic", requestId: crypto.randomUUID(), usdMicrocents: 500_000_000 }])])).toBe("500000000");
    await cx("cx_paypal_balance_record", [W, rail.railId, "GBP", 0, 0]);
    await R.q(`INSERT INTO fleet.fleet_admin_passkeys (credential_id, public_key, name) VALUES ('v66_test_credential', decode(repeat('00', 40), 'hex'), 'test')`);
    await R.q(`INSERT INTO fleet.fleet_admin_sessions (session_sha, csrf_sha, credential_id, method, totp_ok, expires_at) VALUES ($1, $2, 'v66_test_credential', 'passkey', true, now() + interval '1 hour')`,
      [sha(session), sha("csrf")]);
  }, 300_000);
  afterAll(async () => { await custody?.end(); await R?.close(); });

  it("migrates to v66 with a clean audit", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(66);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    expect(await R.one(`fleet.fleet_event_route('capital_backed', '{}'::jsonb)`)).toBe("P3_SUMMARY");
  });

  it("reconciles: capital without money − AI costs paid from provider credit = what still needs real money", async () => {
    const s = await status();
    // v69 (reimbursable): the £5 AI cost stays in the treasury owed to the owner; it does not back the capital.
    expect(s).toMatchObject({ currency: "GBP", virtualCapitalMinor: 20_000, providerPaidMinor: 0, backedMinor: 0, unbackedMinor: 20_000, ownerPayableMinor: 500 });
    // The books hold the £100 real funding (agent wallet) plus the £200 virtual less the £5 cost; PayPal shows nothing yet.
    expect(s.booksCashMinor).toBe(10_000 + 20_000);
    expect(s.differenceMinor).toBe(0 - (s.booksCashMinor - s.unbackedMinor));
    const view = await dash("capital_backing", {});
    expect(view.ok, JSON.stringify(view)).toBe(true);
    expect(view.result.unbackedMinor).toBe(20_000);
  });

  it("refuses what cannot back capital: not the owner, not completed, another currency, money out", async () => {
    expect(await R.code(back(await deposit(1_000), "agent:someone"))).toBe("FLEET_APPROVAL_REQUIRED");
    expect(await R.code(back(await deposit(1_000, 0, { status: "P" })))).toBe("FLEET_NOT_SETTLED");
    expect(await R.code(back(await deposit(1_000, 0, { currency: "USD" })))).toBe("FLEET_FX_REQUIRED");
    expect(await R.code(back(await deposit(-1_000)))).toBe("FLEET_BAD_REQUEST");
    expect(await R.code(R.one(`fleet.fleet_admin_capital_back($1, 'NOSUCHTXN1', 'T0000', $2)`, [rail.railId, OWNER]))).toBe("FLEET_NOT_FOUND");
    expect((await status()).backedMinor).toBe(0);
  });

  it("a deposit backs the existing capital without a second credit, and its key can never be recorded again", async () => {
    const before = { journals: await journals(), capital: await capital(), treasury: await R.balance("fleet:treasury:unallocated") };
    const t = await deposit(10_000);
    const r = await back(t);
    expect(r).toMatchObject({ ok: true, netMinor: 10_000, backedMinor: 10_000, excessMinor: 0, excessJournalId: null, unbackedAfterMinor: 10_000 });
    // No ledger entry: the money was already in the books.
    expect(await journals()).toBe(before.journals);
    expect(await capital()).toBe(before.capital);
    expect(await R.balance("fleet:treasury:unallocated")).toBe(before.treasury);
    expect(await R.one(`(SELECT attributed_as FROM fleet.fleet_paypal_transactions WHERE transaction_id = $1)`, [t.tid])).toBe("capital_backing");
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE event_type = 'capital_backed')`))).toBe(1);
    // Never twice: backing again, owner funding with its key, or attributing it.
    expect(await R.code(back(t))).toBe("FLEET_ALREADY_CLAIMED");
    expect(await R.code(R.ledger.recordOwnerFunding(10_000, `paypal:txn:${t.tid}`, OWNER))).toBe("FLEET_ALREADY_CLAIMED");
    expect(await R.code(R.one(`fleet.fleet_admin_paypal_txn_attribute($1, $2, $3, 'not_revenue', NULL, $4)`, [rail.railId, t.tid, t.eventCode, OWNER]))).toBe("FLEET_NOT_FOUND");
    // A deposit already recorded as owner funding cannot also back capital.
    const f = await deposit(500);
    await R.ledger.recordOwnerFunding(500, `paypal:txn:${f.tid}`, OWNER);
    expect(await R.code(back(f))).toBe("FLEET_ALREADY_CLAIMED");
    // PayPal now shows the deposit: the difference closes by exactly the backed amount.
    await cx("cx_paypal_balance_record", [W, rail.railId, "GBP", 10_000, 10_000]);
    const s = await status();
    expect(s).toMatchObject({ backedMinor: 10_000, unbackedMinor: 10_000 });
    expect(s.differenceMinor).toBe(10_000 - (s.booksCashMinor - 10_000));
    expect(await R.code(R.q(`UPDATE fleet.fleet_capital_backings SET backed_minor = 1`))).toMatch(/FLEET_HISTORY_IMMUTABLE|permission denied/);
  });

  it("only the part beyond what is unbacked becomes new owner funding (net of PayPal's fee); then nothing is left to back", async () => {
    const before = { journals: await journals(), capital: await capital() };
    const r = await back(await deposit(12_000, -300));
    expect(r).toMatchObject({ ok: true, netMinor: 11_700, backedMinor: 10_000, excessMinor: 1_700, unbackedAfterMinor: 0 });
    expect(await journals()).toBe(before.journals + 1);
    expect(await capital()).toBe(before.capital + 1_700);
    expect(await R.one(`(SELECT kind FROM fleet.fleet_ledger_journal WHERE journal_id = $1)`, [r.excessJournalId])).toBe("owner_funding");
    expect((await status()).unbackedMinor).toBe(0);
    expect(await R.code(back(await deposit(1_000)))).toBe("FLEET_NOTHING_TO_BACK");
    expect(await R.one(`fleet.fleet_ledger_verify() ->> 'ok'`)).toBe("true");
  });
});
