/**
 * Schema v47 — provider records and cash-basis settlement (Gumroad revenue integration, stage G2;
 * docs/design/gumroad-revenue-integration.md §§4, 5, 7.2). PostgreSQL; no provider, no bank, no network: the G3 gateway
 * and G4 bank feed are represented by their recorders, called directly.
 *
 * Boundaries proven here: S1–S3 never create cash; S4 alone is not capital (unverified access, owner-external account);
 * S5 credits exactly the received amount, allocated by provider row (USD) or by the labelled pro-rata policy (GBP),
 * with anything unattributable or unreconciled in suspense; negative shares come from the responsible agent's cash and
 * then a payable advanced by the treasury, repaid first from later shares; one credit per payout / bank transaction
 * across automated posting, manual revenue (mandatory canonical claims for a registered account), owner funding, the
 * pilot attestation, retries, both processing orders and concurrent attempts; a failed posting rolls back entirely.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";

const PG_BIN = findPgBin();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const uid = (p: string) => `${p}${crypto.randomBytes(6).toString("hex")}`;
const today = () => new Date().toISOString().slice(0, 10);
/** A fixed sale time for this run (a re-read of a sale reports the same time). */
const SALE_AT = new Date(Date.now() - 86_400_000).toISOString();

type Line = { rowType: string; purchaseId?: string; salePriceMinor: number; feeMinor: number; taxMinor?: number; netMinor: number };

describe.skipIf(!PG_BIN)("v47 provider records and cash-basis settlement (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let F: Founder;
  let G: Founder;
  let vF = "";
  let vG = "";
  let rail = "";
  let acct = "";
  const SELLER = "SELLER_abc==";
  let dGBP = "";
  let dUSD = "";
  let dExt = "";

  const sale = (id: string, product: string, price: number, fee: number, at = SALE_AT, flags: Record<string, boolean> = {}) =>
    R.one(`fleet.fleet_provider_sale_record($1, $2, $3, $4, 'USD', $5, $6, 0, 'USD', $7::jsonb, $8, 'gateway')`,
      [acct, id, product, at, price, fee, JSON.stringify(flags), sha(`${id}|${price}|${fee}|${JSON.stringify(flags)}`)]);
  const payout = (id: string, amount: number, currency: string, lines: Line[], status = "completed", processed = new Date(Date.now() - 2 * 86_400_000).toISOString()) =>
    R.one(`fleet.fleet_provider_payout_record($1, $2, $3, $4, $5, $6, '••12', $7::jsonb, $8, 'gateway')`,
      [acct, id, amount, currency, status, processed, JSON.stringify(lines), sha(`${id}|${amount}`)]);
  const receipt = (dest: string, txn: string, amount: number, currency: string, booked = today(), descriptor = "GUMROAD PAYOUT") =>
    R.one(`fleet.fleet_bank_receipt_record($1, $2, $3, $4, $5::date, $6, $7, 'bankfeed')`, [dest, txn, amount, currency, booked, descriptor, sha(`${dest}|${txn}|${amount}`)]);
  const cash = (who: Founder) => R.balance(`agent:${who.id}:cash`);
  const payable = (who: Founder) => R.balance(`agent:${who.id}:provider_payable`);
  const bal = (acc: string) => R.balance(acc);
  const journals = async () => Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ledger_journal)`));
  const claims = async (like: string) => Number(await R.one(`(SELECT count(*) FROM fleet.fleet_revenue_claims WHERE claim_key LIKE $1)`, [like]));
  const pkey = (payoutId: string) => `gumroad:${SELLER}:payout:${payoutId}`;
  const assign = (product: string, venture: string, from: string | null = "2020-01-01T00:00:00Z", reason = "test product") =>
    R.one(`fleet.fleet_admin_provider_product_assign($1, $2, $3, $4, $5, $6)`, [acct, product, venture, from, reason, OWNER]);
  const realMoney = async () => {
    // Σ agent cash + treasury unallocated: what the fleet's real treasury money is partitioned into here.
    const agents = Number(await R.one(`(SELECT COALESCE(sum(fleet.fleet_ledger_balance(account_id)), 0) FROM fleet.fleet_ledger_accounts WHERE class = 'agent_cash')`));
    return agents + await bal("fleet:treasury:unallocated");
  };

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000, simulatedSettlement: false });
    [F, G] = R.founders;
    for (const [who, key] of [[F, "uk-sa-template"], [G, "landlord-compliance-tracker"]] as const) {
      expect((await R.econ(who, "venture.create", { key, model: "digital_product", offer: key, state: "selected", channels: ["gumroad"] })).ok).toBe(true);
    }
    vF = (await R.q(`SELECT venture_id FROM fleet.fleet_ventures WHERE agent_id = $1`, [F.id]))[0].venture_id;
    vG = (await R.q(`SELECT venture_id FROM fleet.fleet_ventures WHERE agent_id = $1`, [G.id]))[0].venture_id;
    rail = (await R.one(`fleet.fleet_admin_rail_add('gumroad', 'Owner Gumroad', 'shared', NULL, ARRAY['storefront','receive_payments'], 'gumroad: owner store', NULL, 'live_receive', NULL, NULL, $1)`, [OWNER])).railId;
    acct = (await R.one(`fleet.fleet_admin_provider_account_register($1, $2, 'Owner store', $3, $4)`, [rail, SELLER, [sha("owner@example.com")], OWNER])).accountId;
    await R.one(`fleet.fleet_fx_record('USD', 'GBP', 790000, 'test fixture rate', $1::date, $2)`, [today(), OWNER]);
    const dest = (kind: string, label: string, currency: string, pattern: string | null) =>
      R.one(`fleet.fleet_admin_settlement_destination_add($1, $2, $3, '••12', $4, $5, NULL, NULL, $6)`, [kind, label, `${label} ••12`, currency, pattern, OWNER]);
    dGBP = (await dest("fleet_treasury", "Fleet treasury GBP", "GBP", "GUMROAD|STRIPE")).destination_id;
    dUSD = (await dest("fleet_treasury", "Fleet treasury USD", "USD", null)).destination_id;
    dExt = (await dest("owner_external", "Owner personal", "GBP", null)).destination_id;
    await assign("PROD_F", vF);
    await assign("PROD_G", vG);
  }, 240_000);
  afterAll(async () => { await R?.close(); });

  it("migrates to v47 with a clean audit; new accounts start at zero; no journal", async () => {
    expect(await R.one(`(SELECT max(version) FROM fleet.fleet_schema_migrations)`)).toBe(47);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    for (const a of ["fleet:provider:suspense", "fleet:provider:advances", `agent:${F.id}:provider_payable`]) expect(await bal(a)).toBe(0);
    expect((await R.one(`fleet.fleet_ledger_verify()`)).ok).toBe(true);
  });

  it("S1–S3 create no cash: a verified sale and a reported (even completed) payout are memo only", async () => {
    const before = { j: await journals(), f: await cash(F), money: await realMoney() };
    await sale("S_memo1", "PROD_F", 1000, 100);
    await payout("PO_memo", 900, "USD", [{ rowType: "sale", purchaseId: "S_memo1", salePriceMinor: 1000, feeMinor: 100, netMinor: 900 }]);
    expect(await journals()).toBe(before.j);
    expect(await cash(F)).toBe(before.f);
    expect(await realMoney()).toBe(before.money);
    const memo = (await R.one(`fleet.fleet_agent_wallet($1)`, [F.id])).providerPending;
    expect(memo).toMatchObject({ currency: "USD", spendable: false, inReportedPayoutsNotReceivedMinor: 900 });
    expect((await R.one(`fleet.fleet_agent_economics($1)`, [F.id])).expensePurchasingCapacity).toBe(before.f);
  });

  it("verified records are idempotent; a conflicting re-read changes nothing; refund states only progress; rows are immutable", async () => {
    expect(await sale("S_memo1", "PROD_F", 1000, 100)).toMatchObject({ ok: true, replay: true });
    expect(await sale("S_memo1", "PROD_F", 1100, 100)).toMatchObject({ ok: false, code: "FLEET_PROVIDER_CONFLICT" });
    await sale("S_memo1", "PROD_F", 1000, 100, undefined, { refunded: true });
    await sale("S_memo1", "PROD_F", 1000, 100, undefined, { refunded: false });
    expect((await R.q(`SELECT refunded, price_minor FROM fleet.fleet_provider_sales WHERE sale_id = 'S_memo1'`))[0]).toMatchObject({ refunded: true, price_minor: "1000" });
    expect(await R.code(R.q(`UPDATE fleet.fleet_provider_sales SET price_minor = 1 WHERE sale_id = 'S_memo1'`))).toBe("FLEET_IMMUTABLE");
    expect(await payout("PO_memo", 901, "USD", [{ rowType: "sale", purchaseId: "S_memo1", salePriceMinor: 1000, feeMinor: 100, netMinor: 900 }])).toMatchObject({ code: "FLEET_PROVIDER_CONFLICT" });
    expect(await R.code(R.q(`DELETE FROM fleet.fleet_provider_payout_lines`))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE event_type = 'provider_conflict')`))).toBe(2);
  });

  it("attribution is immutable history: a sale keeps the owner it was earned by; a reassignment takes effect from now only", async () => {
    await assign("PROD_X", vF);
    await sale("S_hist1", "PROD_X", 500, 50);
    expect(await R.code(assign("PROD_X", vG, "2021-01-01T00:00:00Z"))).toBe("FLEET_IMMUTABLE");
    await assign("PROD_X", vG, null, "moved to G");
    expect(await R.one(`fleet.fleet_provider_sale_owner($1, 'S_hist1')`, [acct])).toBe(F.id);
    await sale("S_hist2", "PROD_X", 500, 50, new Date(Date.now() + 1000).toISOString());
    expect(await R.one(`fleet.fleet_provider_sale_owner($1, 'S_hist2')`, [acct])).toBe(G.id);
    expect(await R.code(assign("PROD_X", vG, null))).toBe("FLEET_BAD_REQUEST");
    expect(await R.code(R.q(`UPDATE fleet.fleet_provider_product_attributions SET agent_id = $1`, [F.id]))).toBe("FLEET_HISTORY_IMMUTABLE");
  });

  it("S4 is not capital: a receipt into a treasury whose access is unverified is held; verifying access lets it post — exactly once", async () => {
    await sale("S_u1", "PROD_F", 1000, 100);
    await sale("S_u2", "PROD_G", 500, 50);
    await payout("PO_usd1", 1300, "USD", [
      { rowType: "sale", purchaseId: "S_u1", salePriceMinor: 1000, feeMinor: 100, netMinor: 900 },
      { rowType: "sale", purchaseId: "S_u2", salePriceMinor: 500, feeMinor: 50, netMinor: 450 },
      { rowType: "payout_fee", salePriceMinor: 0, feeMinor: 50, netMinor: -50 }]);
    const before = { f: await cash(F), g: await cash(G), money: await realMoney(), j: await journals() };
    const held = await receipt(dUSD, "TXN_USD_1", 1300, "USD");
    expect(held).toMatchObject({ status: "held", reason: "treasury access not verified" });
    expect(await journals()).toBe(before.j);
    expect(await R.code(R.one(`fleet.fleet_admin_settlement_destination_verify_access($1, 'owner_attested', '{}'::jsonb, $2)`, [dUSD, OWNER]))).toBe("FLEET_BAD_REQUEST");
    await R.one(`fleet.fleet_admin_settlement_destination_verify_access($1, 'owner_attested', $2::jsonb, $3)`, [dUSD, JSON.stringify({ note: "fleet treasury account, operated under the fleet funding mechanism" }), OWNER]);
    const posted = await receipt(dUSD, "TXN_USD_1", 1300, "USD");   // the bank feed reads it again
    expect(posted).toMatchObject({ status: "posted", allocation: { basis: "usd_exact", quarantined: false } });
    const df = (await cash(F)) - before.f; const dg = (await cash(G)) - before.g;
    expect(df + dg).toBe(1300);                                  // exactly the received amount, by provider row
    // The $0.50 payout fee is shared pro rata to positive nets (900 : 450) in exact cents: −34 / −17 floors, the remaining
    // cent to the first agent by id — so F nets 866 or 867 and G 434 or 433, never anything that does not sum to 1300.
    expect([[866, 434], [867, 433]]).toContainEqual([df, dg]);
    expect((await realMoney()) - before.money).toBe(1300);
    expect(await claims(`${pkey("PO_usd1")}`)).toBe(1);
    expect(await claims(`bank:${dUSD}:txn:TXN_USD_1`)).toBe(1);
    // Replays never post again.
    const j = await journals();
    expect(await receipt(dUSD, "TXN_USD_1", 1300, "USD")).toMatchObject({ replay: true, status: "posted" });
    expect(await journals()).toBe(j);
    expect(await receipt(dUSD, "TXN_USD_1", 1301, "USD")).toMatchObject({ code: "FLEET_PROVIDER_CONFLICT" });
  });

  it("a GBP payout is split pro rata to USD net (an allocation POLICY, labelled), exact in total, within one penny per agent", async () => {
    await R.one(`fleet.fleet_admin_settlement_destination_verify_access($1, 'owner_attested', $2::jsonb, $3)`, [dGBP, JSON.stringify({ note: "fleet treasury GBP" }), OWNER]);
    await sale("S_g1", "PROD_F", 941, 94);
    await sale("S_g2", "PROD_G", 470, 47);
    await payout("PO_gbp1", 1000, "GBP", [
      { rowType: "sale", purchaseId: "S_g1", salePriceMinor: 941, feeMinor: 94, netMinor: 847 },
      { rowType: "sale", purchaseId: "S_g2", salePriceMinor: 470, feeMinor: 47, netMinor: 423 }]);
    const before = { f: await cash(F), g: await cash(G) };
    const out = await receipt(dGBP, "TXN_GBP_1", 1000, "GBP");
    expect(out.allocation).toMatchObject({ basis: "pro_rata_usd_net", quarantined: false });
    expect(out.allocation.policy).toMatch(/allocation policy.*not a provider exchange rate/);
    const df = (await cash(F)) - before.f; const dg = (await cash(G)) - before.g;
    expect(df + dg).toBe(1000);
    expect(Math.abs(df - (1000 * 847) / 1270)).toBeLessThan(1);
    expect(Math.abs(dg - (1000 * 423) / 1270)).toBeLessThan(1);
    expect([df, dg]).toEqual([667, 333]);
    expect((await R.q(`SELECT DISTINCT basis FROM fleet.fleet_provider_allocations a JOIN fleet.fleet_settlement_receipts r USING (receipt_id) WHERE r.bank_txn_id = 'TXN_GBP_1'`)).map((x) => x.basis))
      .toEqual(["pro_rata_usd_net"]);
  });

  it("rows that do not reconcile quarantine the WHOLE payout in suspense: wrong USD sum, implied rate out of band, receipt ≠ payout", async () => {
    await sale("S_q1", "PROD_F", 1000, 100);
    await payout("PO_q_usd", 950, "USD", [{ rowType: "sale", purchaseId: "S_q1", salePriceMinor: 1000, feeMinor: 100, netMinor: 900 }]);
    const f0 = await cash(F); const s0 = await bal("fleet:provider:suspense");
    expect(await receipt(dUSD, "TXN_Q_USD", 950, "USD")).toMatchObject({ status: "posted", allocation: { quarantined: true } });
    expect(await cash(F)).toBe(f0);
    expect((await bal("fleet:provider:suspense")) - s0).toBe(950);
    await sale("S_q2", "PROD_F", 1000, 100);
    await payout("PO_q_gbp", 500, "GBP", [{ rowType: "sale", purchaseId: "S_q2", salePriceMinor: 1000, feeMinor: 100, netMinor: 900 }]);  // 0.556 vs 0.79
    expect((await receipt(dGBP, "TXN_Q_GBP", 500, "GBP")).allocation).toMatchObject({ quarantined: true });
    expect((await R.q(`SELECT status_reason FROM fleet.fleet_settlement_receipts WHERE bank_txn_id = 'TXN_Q_GBP'`))[0].status_reason).toMatch(/implied rate .* outside 300 bp/);
    expect(await cash(F)).toBe(f0);
    // A receipt with no matching payout amount stays unmatched (nothing posted).
    expect(await receipt(dGBP, "TXN_STRAY", 4321, "GBP")).toMatchObject({ status: "unmatched" });
  });

  it("an unattributable row stays in suspense — never guessed — until the owner attributes the product and releases it", async () => {
    await sale("S_orphan", "PROD_ORPHAN", 800, 80);
    await sale("S_own", "PROD_F", 400, 40);
    await payout("PO_orphan", 1080, "USD", [
      { rowType: "sale", purchaseId: "S_orphan", salePriceMinor: 800, feeMinor: 80, netMinor: 720 },
      { rowType: "sale", purchaseId: "S_own", salePriceMinor: 400, feeMinor: 40, netMinor: 360 }]);
    const f0 = await cash(F); const g0 = await cash(G); const s0 = await bal("fleet:provider:suspense");
    await receipt(dUSD, "TXN_ORPHAN", 1080, "USD");
    expect((await cash(F)) - f0).toBe(360);
    expect((await bal("fleet:provider:suspense")) - s0).toBe(720);
    const rid = (await R.q(`SELECT receipt_id FROM fleet.fleet_settlement_receipts WHERE bank_txn_id = 'TXN_ORPHAN'`))[0].receipt_id;
    expect(await R.code(R.one(`fleet.fleet_admin_provider_suspense_release($1, $2)`, [rid, OWNER]))).toBe("FLEET_NOTHING_TO_RELEASE");
    await assign("PROD_ORPHAN", vG);                             // first assignment: covers its past sales
    const rel = await R.one(`fleet.fleet_admin_provider_suspense_release($1, $2)`, [rid, OWNER]);
    expect(rel).toMatchObject({ ok: true, movedMinor: 720 });
    expect((await cash(G)) - g0).toBe(720);
    expect((await bal("fleet:provider:suspense")) - s0).toBe(0);
    expect(Number(await R.one(`(SELECT sum(share_minor) FROM fleet.fleet_provider_allocations WHERE receipt_id = $1)`, [rid]))).toBe(1080);
    expect(await R.code(R.one(`fleet.fleet_admin_provider_suspense_release($1, $2)`, [rid, OWNER]))).toBe("FLEET_NOTHING_TO_RELEASE");
  });

  it("a negative share comes from the responsible agent's cash, then a treasury-advanced payable that cuts its capacity — repaid first from its next share", async () => {
    // G earns, then moves most of its cash back to the treasury: a later chargeback exceeds what it holds.
    await sale("S_big", "PROD_G", 20000, 0);
    await payout("PO_big", 20000, "USD", [{ rowType: "sale", purchaseId: "S_big", salePriceMinor: 20000, feeMinor: 0, netMinor: 20000 }]);
    await receipt(dUSD, "TXN_BIG", 20000, "USD");
    const gc = await cash(G);
    await R.one(`fleet.fleet_admin_wallet_transfer($1, $2, 'treasury', 'test: drain', $3, $4, true)`, [G.id, gc - 1000, OWNER, uid("wt:")]);
    expect(await cash(G)).toBe(1000);
    await sale("S_f9", "PROD_F", 6000, 0);
    await payout("PO_cb", 3000, "USD", [
      { rowType: "sale", purchaseId: "S_f9", salePriceMinor: 6000, feeMinor: 0, netMinor: 6000 },
      { rowType: "chargeback", purchaseId: "S_big", salePriceMinor: -3000, feeMinor: 0, netMinor: -3000 }]);
    const before = { f: await cash(F), money: await realMoney(), adv: await bal("fleet:provider:advances"), un: await bal("fleet:treasury:unallocated") };
    expect(await receipt(dUSD, "TXN_CB", 3000, "USD")).toMatchObject({ status: "posted" });
    expect((await cash(F)) - before.f).toBe(6000);
    expect(await cash(G)).toBe(0);
    expect(await payable(G)).toBe(2000);
    expect((await bal("fleet:provider:advances")) - before.adv).toBe(2000);
    expect(before.un - (await bal("fleet:treasury:unallocated"))).toBe(2000);
    expect((await realMoney()) - before.money).toBe(3000);       // real money moved: exactly the receipt
    const eco = await R.one(`fleet.fleet_agent_economics($1)`, [G.id]);
    expect(eco).toMatchObject({ providerPayable: 2000, expensePurchasingCapacity: 0 });
    // G's next share repays the payable first.
    await sale("S_g10", "PROD_G", 2500, 0);
    await payout("PO_rep", 2500, "USD", [{ rowType: "sale", purchaseId: "S_g10", salePriceMinor: 2500, feeMinor: 0, netMinor: 2500 }]);
    await receipt(dUSD, "TXN_REP", 2500, "USD");
    expect(await payable(G)).toBe(0);
    expect(await cash(G)).toBe(500);
    expect((await bal("fleet:provider:advances")) - before.adv).toBe(0);
  });

  it("a posting that cannot complete rolls back entirely: no journal, no claim, no allocation; the receipt is held with the reason", async () => {
    // A chargeback larger than the agent's lifetime revenue cannot be booked (revenue never goes negative).
    await assign("PROD_NEW", vF);
    await sale("S_neg", "PROD_NEW", 1, 0);
    await payout("PO_fail2", 1, "USD", [
      { rowType: "sale", purchaseId: "S_neg", salePriceMinor: 1, feeMinor: 0, netMinor: 50000001 },
      { rowType: "chargeback", purchaseId: "S_big", salePriceMinor: 0, feeMinor: 0, netMinor: -50000000 }]);
    const j0 = await journals(); const c0 = await claims("%PO_fail2%"); const money = await realMoney();
    const out = await receipt(dUSD, "TXN_FAIL2", 1, "USD");
    expect(out).toMatchObject({ ok: false, status: "held" });
    expect(await journals()).toBe(j0);
    expect(await claims("%PO_fail2%")).toBe(c0);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_provider_allocations a JOIN fleet.fleet_settlement_receipts r USING (receipt_id) WHERE r.bank_txn_id = 'TXN_FAIL2')`))).toBe(0);
    expect(await realMoney()).toBe(money);
    expect((await R.q(`SELECT status_reason FROM fleet.fleet_settlement_receipts WHERE bank_txn_id = 'TXN_FAIL2'`))[0].status_reason).toMatch(/could not post: FLEET_LEDGER_NEGATIVE/);
  });

  it("a receipt into an owner account is held; it reaches agents only when the transfer into the treasury is linked — both bank transactions claimed", async () => {
    await sale("S_ext", "PROD_F", 1270, 0);
    await payout("PO_ext", 1003, "GBP", [{ rowType: "sale", purchaseId: "S_ext", salePriceMinor: 1270, feeMinor: 0, netMinor: 1270 }]);
    const ext = await receipt(dExt, "TXN_EXT", 1003, "GBP");
    expect(ext).toMatchObject({ status: "held", reason: "outside the fleet treasury" });
    const f0 = await cash(F);
    const tr = await receipt(dGBP, "TXN_EXT_IN", 1003, "GBP");
    expect(tr.status).toBe("unmatched");                         // its payout is already matched to the owner-account receipt
    const out = await R.one(`fleet.fleet_admin_receipt_transfer_link($1, $2, $3)`, [ext.receiptId, tr.receiptId, OWNER]);
    expect(out).toMatchObject({ status: "posted" });
    expect((await cash(F)) - f0).toBe(1003);
    expect(await claims(`bank:${dExt}:txn:TXN_EXT`)).toBe(1);
    expect(await claims(`bank:${dGBP}:txn:TXN_EXT_IN`)).toBe(1);
    expect(await R.code(R.one(`fleet.fleet_admin_receipt_transfer_link($1, $2, $3)`, [ext.receiptId, tr.receiptId, OWNER]))).toBe("FLEET_INVALID_STATE");
  });

  it("the pilot fallback is explicit, labelled and bounded: no pilot, no attestation; an exact match only; never beyond 30 days", async () => {
    await sale("S_pil", "PROD_F", 1270, 0);
    await payout("PO_pil", 1003, "GBP", [{ rowType: "sale", purchaseId: "S_pil", salePriceMinor: 1270, feeMinor: 0, netMinor: 1270 }]);
    const attest = (amount: number) => R.one(`fleet.fleet_admin_receipt_attest($1, $2, 'PO_pil', $3, 'GBP', $4::date, $5)`, [dGBP, acct, amount, today(), OWNER]);
    expect(await R.code(attest(1003))).toBe("FLEET_PILOT_REQUIRED");
    expect(await R.code(R.one(`fleet.fleet_admin_pilot_authorise('receipt_attestation', 31, 'too long', $1)`, [OWNER]))).toBe("FLEET_BAD_REQUEST");
    const pilot = await R.one(`fleet.fleet_admin_pilot_authorise('receipt_attestation', 7, 'first live pilot', $1)`, [OWNER]);
    expect(await attest(1002)).toMatchObject({ ok: false, status: "held" });
    expect(await R.code(attest(1003))).toMatch(/duplicate key|FLEET_/);   // one receipt per payout: the held mismatch occupies it
    await R.one(`fleet.fleet_admin_pilot_revoke($1, $2)`, [pilot.pilotId, OWNER]);
    expect(await R.code(R.one(`fleet.fleet_admin_receipt_attest($1, $2, 'PO_pil', 1003, 'GBP', $3::date, $4)`, [dGBP, acct, today(), OWNER]))).toBe("FLEET_PILOT_REQUIRED");
  });

  it("a successful attestation credits only within the pilot, labelled as not independently verified, and claims the payout once", async () => {
    await sale("S_pil2", "PROD_F", 1270, 0);
    await payout("PO_pil2", 1003, "GBP", [{ rowType: "sale", purchaseId: "S_pil2", salePriceMinor: 1270, feeMinor: 0, netMinor: 1270 }]);
    await R.one(`fleet.fleet_admin_pilot_authorise('receipt_attestation', 7, 'pilot', $1)`, [OWNER]);
    const f0 = await cash(F);
    const out = await R.one(`fleet.fleet_admin_receipt_attest($1, $2, 'PO_pil2', 1003, 'GBP', $3::date, $4)`, [dGBP, acct, today(), OWNER]);
    expect(out).toMatchObject({ status: "posted", evidence: "owner_attested (not independently verified)" });
    expect((await cash(F)) - f0).toBe(1003);
    expect((await R.q(`SELECT claim_kind FROM fleet.fleet_revenue_claims WHERE claim_key = $1`, [`bank:${dGBP}:txn:attested:PO_pil2`]))[0].claim_kind).toBe("owner_attestation");
    expect((await R.q(`SELECT note FROM fleet.fleet_provider_allocations a JOIN fleet.fleet_settlement_receipts r USING (receipt_id) WHERE r.payout_id = 'PO_pil2' AND a.agent_id IS NOT NULL`))[0].note)
      .toMatch(/owner-attested receipt, not independently verified/);
    // The same payout arriving through the bank feed later is not a second credit.
    expect(await receipt(dGBP, "TXN_PIL2_FEED", 1003, "GBP")).toMatchObject({ status: "unmatched" });
  });

  it("one credit per payout across processing orders: manual first ⇒ automation credits nothing; automation first ⇒ manual refused", async () => {
    const manual = (ref: string, counterparty: string, claim?: string, kind = "external_revenue") => claim
      ? R.ledger.recordRevenueClaimed(F.id, 777, ref, counterparty, OWNER, claim)
      : R.ledger.recordExternal(kind as "external_revenue", F.id, 777, ref, counterparty, OWNER);
    // Manual revenue naming the registered account (or any of its identifiers) must claim a canonical payout.
    expect(await R.code(manual("owner-ref-1", "gumroad"))).toBe("FLEET_CLAIM_REQUIRED");
    expect(await R.code(manual("owner-ref-2", "owner@example.com"))).toBe("FLEET_CLAIM_REQUIRED");
    expect(await R.code(manual("owner-ref-3", SELLER))).toBe("FLEET_CLAIM_REQUIRED");
    expect(await R.code(manual("owner-ref-4", "gumroad", "gumroad:UNKNOWNSELLER:payout:PO_x"))).toBe("FLEET_BAD_REQUEST");
    expect(await R.code(manual("owner-ref-5", "gumroad", "bank:somewhere:txn:1"))).toBe("FLEET_BAD_REQUEST");
    expect(await R.code(R.ledger.recordExternal("external_refund", F.id, 5, "owner-ref-6", "gumroad", OWNER))).toBe("FLEET_PROVIDER_AUTOMATED");
    // Manual first.
    const f0 = await cash(F);
    await manual("owner-ref-man", "gumroad", pkey("PO_man"));
    expect(await R.code(manual("owner-ref-man2", "gumroad", `${pkey("PO_man")}:part:1`))).toBe("FLEET_ALREADY_CLAIMED");
    await sale("S_man", "PROD_F", 777, 0);
    await payout("PO_man", 777, "USD", [{ rowType: "sale", purchaseId: "S_man", salePriceMinor: 777, feeMinor: 0, netMinor: 777 }]);
    expect(await receipt(dUSD, "TXN_MAN", 777, "USD")).toMatchObject({ status: "posted", manualClaim: pkey("PO_man"), credited: 0 });
    expect((await cash(F)) - f0).toBe(777);                      // once — by the owner's record
    expect(await claims(`bank:${dUSD}:txn:TXN_MAN`)).toBe(1);
    // Automation first.
    await sale("S_auto", "PROD_F", 555, 0);
    await payout("PO_auto", 555, "USD", [{ rowType: "sale", purchaseId: "S_auto", salePriceMinor: 555, feeMinor: 0, netMinor: 555 }]);
    await receipt(dUSD, "TXN_AUTO", 555, "USD");
    expect(await R.code(manual("owner-ref-auto", "gumroad", pkey("PO_auto")))).toBe("FLEET_ALREADY_CLAIMED");
    expect(await R.code(manual("owner-ref-auto2", "gumroad", `${pkey("PO_auto")}:part:2`))).toBe("FLEET_ALREADY_CLAIMED");
    // Another reference cannot bypass it: the payout id or the bank transaction as a reference needs the claim too.
    expect(await R.code(manual("PO_auto", "someone-else"))).toBe("FLEET_CLAIM_REQUIRED");
    expect(await R.code(manual("TXN_AUTO", "someone-else"))).toBe("FLEET_CLAIM_REQUIRED");
    // Owner funding never reuses a receipt reference.
    for (const ref of ["TXN_AUTO", "PO_auto", `bank:${dUSD}:txn:TXN_AUTO`, pkey("PO_auto")]) {
      expect(await R.code(R.ledger.recordOwnerFunding(555, ref.replace(/=/g, "-"), OWNER))).toMatch(/FLEET_PROVIDER_RECEIPT|FLEET_ALREADY_CLAIMED/);
    }
  });

  it("concurrent claims of one payout: exactly one succeeds and the other rolls back completely", async () => {
    const key = pkey("PO_race");
    const pools = [new pg.Pool({ connectionString: R.pgc.ownerUrl, max: 1 }), new pg.Pool({ connectionString: R.pgc.ownerUrl, max: 1 })];
    const j0 = await journals(); const f0 = await cash(F);
    const call = (p: pg.Pool, i: number) => p.query(`SELECT fleet.fleet_admin_record_external_claimed('external_revenue', $1, 321, $2, $3, $4, $5, $6) AS r`,
      [F.id, `race-${i}`, sha("gumroad"), OWNER, uid("race:"), key]).then(() => "OK", (e: Error) => /FLEET_[A-Z_]+/.exec(e.message)?.[0] ?? e.message);
    const out = await Promise.all(pools.map((p, i) => call(p, i)));
    await Promise.all(pools.map((p) => p.end()));
    expect(out.sort()).toEqual(["FLEET_ALREADY_CLAIMED", "OK"]);
    expect(await journals()).toBe(j0 + 1);
    expect((await cash(F)) - f0).toBe(321);
  });

  it("a provider debit is booked at once into suspense and moves to the responsible agent only by an owner attribution with a reason", async () => {
    const before = { s: await bal("fleet:provider:suspense"), money: await realMoney(), f: await cash(F) };
    const d = await receipt(dUSD, "TXN_DEBIT", -300, "USD");
    expect(d).toMatchObject({ status: "posted", debitInSuspense: 300 });
    expect((await bal("fleet:provider:suspense")) - before.s).toBe(-300);
    expect((await realMoney()) - before.money).toBe(-300);
    expect(await R.code(R.one(`fleet.fleet_admin_receipt_debit_assign($1, $2, 400, 'too much', $3)`, [d.receiptId, F.id, OWNER]))).toBe("FLEET_BAD_REQUEST");
    await R.one(`fleet.fleet_admin_receipt_debit_assign($1, $2, 300, 'refunds on uk-sa-template', $3)`, [d.receiptId, F.id, OWNER]);
    expect((await bal("fleet:provider:suspense")) - before.s).toBe(0);
    expect(before.f - (await cash(F))).toBe(300);
    expect((await realMoney()) - before.money).toBe(-300);
  });

  it("allocation property: random mixed payouts conserve the received amount exactly; each share is within one minor unit of its pro-rata value", async () => {
    let seed = 47;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    for (let k = 0; k < 40; k++) {
      const lines: Line[] = []; let netF = 0; let netG = 0; let netX = 0;
      for (let i = 0; i < 1 + rnd(6); i++) {
        const who = rnd(3); const id = uid("P"); const price = 200 + rnd(5000); const fee = rnd(price / 10 | 0);
        const neg = rnd(5) === 0; const net = (neg ? -1 : 1) * (price - fee);
        await sale(id, who === 0 ? "PROD_F" : who === 1 ? "PROD_G" : "PROD_NOBODY", price, fee);
        lines.push({ rowType: neg ? "partial_refund" : "sale", purchaseId: id, salePriceMinor: neg ? -price : price, feeMinor: neg ? -fee : fee, netMinor: net });
        if (who === 0) netF += net; else if (who === 1) netG += net; else netX += net;
      }
      const usd = netF + netG + netX;
      if (usd <= 0) continue;
      const gbp = Math.max(1, Math.round(usd * 0.79));
      const po = uid("PO_rand");
      await payout(po, gbp, "GBP", lines);
      const a = await R.one(`fleet.fleet_provider_payout_allocation($1, $2, $3, 'GBP')`, [acct, po, gbp]);
      expect(a.quarantined).toBe(false);
      const shares = Object.fromEntries((a.buckets as Array<{ agentId: string; share: number }>).map((b) => [b.agentId, Number(b.share)]));
      const total = (shares[F.id] ?? 0) + (shares[G.id] ?? 0) + Number(a.suspense);
      expect(total).toBe(gbp);
      if (netF) expect(Math.abs((shares[F.id] ?? 0) - (gbp * netF) / usd)).toBeLessThan(1);
      if (netG) expect(Math.abs((shares[G.id] ?? 0) - (gbp * netG) / usd)).toBeLessThan(1);
    }
  });

  it("reconciliation: allocations conserve every posted receipt, advances equal payables, the ledger verifies, the audit stays clean", async () => {
    const rec = await R.one(`fleet.fleet_reconcile()`);
    const by = Object.fromEntries((rec.findings as Array<{ code: string; severity: string }>).map((f) => [f.code, f.severity]));
    expect(by.PROVIDER_ALLOCATION_CONSERVATION).toBe("INFO");
    expect(by.PROVIDER_ADVANCES_MATCH).toBeUndefined();
    expect(by.PROVIDER_RECEIPTS_HELD).toBe("WARN");             // the failed posting and the attestation mismatch are held, visibly
    expect((await R.one(`fleet.fleet_ledger_verify()`)).ok).toBe(true);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });
});
