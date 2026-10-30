/**
 * v123 Treasury Watch, end to end on disposable data: fake PayPal → custody's pass → movement → classification → booking →
 * reconciliation → event + notification → the position, Fleet Control's facts. No live call of any kind.
 * HTTP 200 is not evidence; a positive row is not funding; nothing is booked twice, whatever order things arrive in.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import crypto from "crypto";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { liveRail, type ArmedCustody } from "./fixtures/custody-signer.js";
import { PgCustodyGateway } from "../../fleet/custody/gateway.js";
import { PayPalTreasuryWorker } from "../../fleet/custody/paypal-treasury.js";
import type { HttpPort } from "../../fleet/custody/signers.js";
import { MemoryVault } from "../../fleet/payments/credential-broker.js";
import { SPEND_REVIEW_SYSTEM, spendReviewPrompt } from "../../fleet/spend/review.js";
import { treasuryBody } from "../../fleet/operator/responses.js";
import { validateTreasury } from "../../fleet/bridge/validate.js";

const PG_BIN = findPgBin();
const HOUR = 3_600_000;
const SELF = "TREASURYACCOUNT12";
const id = (p = "TX") => `${p}${crypto.randomBytes(7).toString("hex").toUpperCase()}`;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, "+0000");
type Row = { transaction_info: Record<string, unknown>; payer_info?: Record<string, unknown> };
/** One transaction keeps one time, as at PayPal: a later status change is the same row. */
const firstAt = new Map<string, string>();
const row = (txn: string, code: string, value: string, o: { at?: number; status?: string; fee?: string; ref?: string; payer?: Record<string, unknown>; currency?: string } = {}): Row => {
  if (!firstAt.has(txn)) firstAt.set(txn, ago(o.at ?? 2 * HOUR));
  return { transaction_info: { transaction_id: txn, transaction_event_code: code, transaction_status: o.status ?? "S", transaction_initiation_date: firstAt.get(txn),
    transaction_amount: { currency_code: o.currency ?? "GBP", value }, fee_amount: { currency_code: "GBP", value: o.fee ?? "0.00" }, ...(o.ref ? { paypal_reference_id: o.ref, paypal_reference_id_type: "TXN" } : {}) },
  ...(o.payer ? { payer_info: o.payer } : {}) };
};

describe.skipIf(!PG_BIN)("Treasury Watch (v123)", () => {
  let R: EconomyRegistry, rail: ArmedCustody, gw: PgCustodyGateway, worker: PayPalTreasuryWorker;
  let rows: Row[] = [], searchStatus = 200, cash = 0, page2Status = 200;
  const seen: Array<{ start: string; end: string; page: string }> = [];
  const http: HttpPort = async (url) => {
    const u = new URL(url);
    const json = (status: number, body: unknown) => ({ status, json: async () => body, headers: { get: (n: string) => (n.toLowerCase() === "paypal-debug-id" ? "dbg00001" : null) } });
    if (u.pathname === "/v1/oauth2/token") return json(200, { access_token: "A21AAfake-token", expires_in: 32400, app_id: "APP-1", scope: "https://uri.paypal.com/services/reporting/search/read" });
    if (u.pathname === "/v1/reporting/balances") return json(200, { account_id: SELF, as_of_time: new Date().toISOString(), last_refresh_time: new Date(Date.now() - 1000).toISOString(),
      balances: [{ currency: "GBP", available_balance: { value: (cash / 100).toFixed(2) }, total_balance: { value: (cash / 100).toFixed(2) } }] });
    if (u.pathname === "/v1/reporting/transactions") {
      const start = u.searchParams.get("start_date")!, end = u.searchParams.get("end_date")!, page = u.searchParams.get("page")!;
      seen.push({ start, end, page });
      if (searchStatus !== 200) return json(searchStatus, { name: "NOT_AUTHORIZED" });
      const shown = rows.filter((r) => { const when = r.transaction_info.transaction_initiation_date; if (!when) return true; const at = Date.parse(String(when).replace("+0000", "Z")); return at >= Date.parse(start) && at <= Date.parse(end); });
      if (page === "2") return json(page2Status, page2Status === 200 ? { last_refreshed_datetime: ago(HOUR), total_items: shown.length, total_pages: 2, transaction_details: [] } : { name: "INTERNAL_SERVER_ERROR" });
      return json(200, { last_refreshed_datetime: ago(HOUR), total_items: shown.length, total_pages: page2Status !== 200 ? 2 : 1, transaction_details: shown });
    }
    return json(404, {});
  };
  const position = async () => (await R.q(`SELECT fleet.fleet_treasury_position() AS r`))[0].r as any;
  const sync = async () => (await position()).providerSync;
  const pass = async () => { await worker.tick(); return (await R.q(`SELECT fleet.svc_treasury_watch_tick() AS r`))[0].r as any; };
  const movement = async (txn: string) => (await R.q(`SELECT * FROM fleet.fleet_treasury_movements WHERE transaction_id = $1`, [txn]))[0] as any;
  const alerts = async (code: string) => (await R.q(`SELECT title, detail, class, dedupe_key FROM fleet.fleet_notifications WHERE code = $1 ORDER BY created_at`, [code])) as any[];
  const journals = async (ref: string) => (await R.q(`SELECT kind, source, actor FROM fleet.fleet_ledger_journal WHERE external_ref = $1`, [ref])) as any[];
  const ref = (txn: string) => `paypal:${rail.railId.slice(0, 8)}:${txn}`;
  const unalloc = async () => Number((await R.q(`SELECT fleet.fleet_ledger_balance('fleet:treasury:unallocated') AS b`))[0].b);
  const shortfall = async () => Number((await R.q(`SELECT fleet.fleet_ledger_balance('fleet:treasury:shortfall') AS b`))[0].b);
  const settle = (txn: string) => R.q(`UPDATE fleet.fleet_paypal_transactions SET attributed_as = 'not_revenue', attributed_ref = 'test', attributed_by = 'operator:test', attributed_at = now() WHERE transaction_id = $1`, [txn]);
  /** A row is old enough to book once its pairing wait has passed. */
  const age = (txn: string) => R.q(`UPDATE fleet.fleet_paypal_transactions SET first_seen_at = now() - interval '2 hours' WHERE transaction_id = $1`, [txn]);
  const policyOn = () => R.q(`SELECT fleet.fleet_admin_treasury_watch_policy_set(true, $1, NULL, NULL, NULL, 'operator:test') AS r`, [rail.railId]);
  const policyOff = () => R.q(`SELECT fleet.fleet_admin_treasury_watch_policy_set(false, NULL, NULL, NULL, NULL, 'operator:test') AS r`);
  /** PayPal holds `net` more than the books expect (the top-up has reached its balance). */
  const paypalHolds = async (extra: number) => { cash += extra; await worker.tick(); };

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, simulatedSettlement: false });
    await R.store.grantServiceRole();
    await R.store.grantCustodyRole();
    rail = await liveRail(R.owner, "fleet", OWNER);
    gw = new PgCustodyGateway({ connectionString: R.pgc.custodyUrl });
    worker = new PayPalTreasuryWorker(gw, new MemoryVault(new Map([[rail.vaultRef, "client-id:client-secret"]])), http, { reconcileEveryMs: 0, balanceEveryMs: 0, backfillEveryMs: 60 * 60_000, webhookIds: {} } as never);
    // PayPal's balance as the books expect it, so differences below are this test's movements alone.
    const cb = (await R.q(`SELECT fleet.fleet_capital_backing() AS r`))[0].r as any;
    cash = Number(cb.booksCashMinor) - Number(cb.unbackedMinor);
  }, 300_000);
  afterAll(async () => { await gw?.close(); await R?.close(); });
  beforeEach(() => { searchStatus = 200; page2Status = 200; });

  it("before any read, the position says so instead of showing an unexplained zero; auto-booking starts off", async () => {
    const p = await position();
    expect(p.providerSync).toMatchObject({ state: "never_read", unmatchedReceipts: { count: 0 }, reconciliation: { open: 0 }, webhooks: { receivedEver: 0 } });
    expect(p.autoBook).toMatchObject({ enabled: false, codes: ["T0300", "T0700"] });
    expect(p.movements).toEqual([]);
  });

  it("the freshness facts are separate, beyond HTTP 200, and no full account id is stored", async () => {
    await pass(); await pass();
    const s = await sync();
    expect(s.search).toMatchObject({ lastHttp: 200, returned: 0, ingested: 0, dropped: 0, refused: 0, truncated: false, reportedUpTo: expect.any(String) });
    expect(s.search.lastOkAt).toEqual(expect.any(String));
    expect(s.lastTransactionIngestedAt).toBeNull();
    expect(s.balances).toMatchObject({ lastHttp: 200, accountTail: "NT12", refreshedAt: expect.any(String) });
    expect(JSON.stringify(s)).not.toContain(SELF);
    expect(s.backfill).toMatchObject({ lastHttp: 200, horizonDays: 93 });
  });

  it("a watch tick with nothing to do repeats harmlessly", async () => {
    await expect(pass()).resolves.toMatchObject({ ok: true, evaluated: 0, failed: 0 });
  });

  it("policy off: a top-up is seen, explained and left unbooked, with one actionable alert", async () => {
    const t = id(); rows = [row(t, "T0300", "2.50")];
    await pass(); await pass();
    const m = await movement(t);
    expect(m).toMatchObject({ classification: "top_up", accounting_status: "needs_review", provider_status: "S", direction: "in", journal_id: null });
    expect(m.action).toContain("auto-booking is off");
    expect(await journals(ref(t))).toEqual([]);
    expect((await alerts("TREASURY_NEEDS_REVIEW")).filter((a) => a.title.includes(t))).toHaveLength(1);
    expect((await position()).pendingIncomingMinor).toBeGreaterThanOrEqual(250);
    expect(await R.q(`SELECT 1 FROM fleet.fleet_events WHERE event_type = 'treasury_movement_needs_review' AND detail ->> 'transactionId' = $1`, [t])).toHaveLength(1);
    await settle(t);
    await pass();
    expect(await movement(t)).toMatchObject({ classification: "attributed_not_revenue", accounting_status: "recorded", action: null });
  });

  describe("with the owner's rule on", () => {
    // Switched on yesterday: these rows are newer than the start (a row older than it is tested below).
    beforeAll(async () => { await policyOn(); await R.q(`UPDATE fleet.fleet_treasury_watch_policy SET auto_book_from = now() - interval '1 day'`); });
    afterAll(async () => { await policyOff(); });

    it("pending → settled: nothing while pending, then exactly once from PayPal's net, with evidence on the balance", async () => {
      const t = id(); const u0 = await unalloc();
      rows = [row(t, "T0300", "2.50", { status: "P", at: 10 * 60_000 })];
      await pass();
      expect(await movement(t)).toMatchObject({ accounting_status: "pending", journal_id: null });
      rows = [row(t, "T0300", "2.50", { status: "S" })];
      await pass();
      // Too new (a paired leg may still arrive), then no balance evidence: it waits, books nothing.
      expect(await movement(t)).toMatchObject({ accounting_status: "awaiting_evidence", journal_id: null });
      await age(t); await pass();
      expect((await movement(t)).rule).toContain("available balance does not yet show");
      expect(await unalloc()).toBe(u0);
      await paypalHolds(250);
      await pass();
      const m = await movement(t);
      expect(m).toMatchObject({ classification: "top_up", accounting_status: "booked" });
      expect(await unalloc()).toBe(u0 + 250);
      expect(await journals(ref(t))).toEqual([{ kind: "owner_funding", source: "executor", actor: "treasury-watch" }]);
      expect(await R.q(`SELECT attributed_as, attributed_ref, attributed_by FROM fleet.fleet_paypal_transactions WHERE transaction_id = $1`, [t])).toEqual([{ attributed_as: "owner_funding", attributed_ref: ref(t), attributed_by: "treasury-watch" }]);
      expect(await alerts("TREASURY_FUNDING_RECEIVED")).toEqual([expect.objectContaining({ title: `Funding received and booked: GBP 2.50 net (${t})` })]);
      // Repeating everything changes nothing (restart recovery, a re-delivered row, a concurrent pass).
      await pass(); await pass();
      expect(await unalloc()).toBe(u0 + 250);
      expect(await journals(ref(t))).toHaveLength(1);
      expect(await alerts("TREASURY_FUNDING_RECEIVED")).toHaveLength(1);
      const h = await R.q(`SELECT to_status FROM fleet.fleet_treasury_movement_history WHERE movement_id = $1 ORDER BY history_id`, [m.movement_id]);
      expect(h.map((x: any) => x.to_status).filter((s: string, i: number, a: string[]) => a[i - 1] !== s)).toEqual(["pending", "awaiting_evidence", "booked"]);
      await expect(R.q(`DELETE FROM fleet.fleet_treasury_movement_history WHERE movement_id = $1`, [m.movement_id])).rejects.toThrow(/FLEET_HISTORY_IMMUTABLE/);
      // The books and PayPal agree again.
      expect((await R.q(`SELECT fleet.fleet_capital_backing() AS r`))[0].r.differenceMinor).toBe(0);
    });

    it("the fee comes from PayPal's row: only the net is booked", async () => {
      const t = id(); const u0 = await unalloc();
      rows = [row(t, "T0700", "3.00", { fee: "-0.25", at: 3 * HOUR })];
      await worker.tick(); await age(t); await paypalHolds(275); await pass();
      expect(await movement(t)).toMatchObject({ accounting_status: "booked" });
      expect(await unalloc()).toBe(u0 + 275);
    });

    it("the manual route and the watch can never both book: same journal kind and reference", async () => {
      const t = id(); const u0 = await unalloc();
      rows = [row(t, "T0300", "1.00", { at: 3 * HOUR })];
      await worker.tick(); await age(t); await paypalHolds(100);
      await R.q(`SELECT fleet.fleet_admin_record_owner_funding(100, $1, 'operator:test', $2)`, [ref(t), `manual-${t}`]);
      await R.q(`SELECT fleet.fleet_admin_paypal_txn_attribute($1, $2, 'T0300', 'owner_funding', $3, 'operator:test')`, [rail.railId, t, ref(t)]);
      await pass();
      expect(await movement(t)).toMatchObject({ accounting_status: "recorded" });
      expect(await unalloc()).toBe(u0 + 100);
      expect(await journals(ref(t))).toHaveLength(1);
    });

    it.each([
      ["a payment from someone (a code outside the rule)", (t: string) => row(t, "T0000", "5.00"), "incoming_payment"],
      ["a card code PayPal does not publish as a plain deposit", (t: string) => row(t, "T0701", "5.00"), "funding_other_code"],
      ["a named third-party payer", (t: string) => row(t, "T0300", "5.00", { payer: { account_id: "SOMEONEELSE123", email_address: "x@example.test" } }), "top_up"],
      ["a reference to another transaction", (t: string) => row(t, "T0300", "5.00", { ref: "OTHERTXN12345" }), "top_up"],
      ["another currency", (t: string) => row(t, "T0300", "5.00", { currency: "USD" }), "top_up"],
    ])("never books %s: it stays unallocated with an alert", async (_n, make, cls) => {
      const t = id(); const u0 = await unalloc();
      rows = [make(t)];
      await worker.tick(); await age(t); await paypalHolds(500);
      await pass();
      expect(await movement(t)).toMatchObject({ classification: cls, accounting_status: "needs_review", journal_id: null });
      expect(await unalloc()).toBe(u0);
      expect((await alerts("TREASURY_NEEDS_REVIEW")).filter((a) => a.title.includes(t))).toHaveLength(1);
      cash -= 500;
      await settle(t);
      await worker.tick();
    });

    it("a top-up from this account's own payer record is allowed; instrument fields are not required", async () => {
      const t = id(); const u0 = await unalloc();
      rows = [row(t, "T0300", "1.25", { at: 3 * HOUR, payer: { account_id: SELF } })];
      await worker.tick(); await age(t); await paypalHolds(125); await pass();
      expect(await movement(t)).toMatchObject({ accounting_status: "booked" });
      expect(await unalloc()).toBe(u0 + 125);
    });

    it("a deposit with an equal amount leaving at the same time is not funding (a card paying for a purchase)", async () => {
      const t = id(), out = id(); const u0 = await unalloc();
      rows = [row(t, "T0300", "7.77"), row(out, "T0000", "-7.77")];
      await worker.tick(); await age(t); await pass();
      expect(await movement(t)).toMatchObject({ accounting_status: "needs_review", rule: expect.stringContaining("equal amount left") });
      expect(await movement(out)).toMatchObject({ classification: "outgoing_payment", direction: "out", accounting_status: "needs_review" });
      expect(await unalloc()).toBe(u0);
      for (const x of [t, out]) await settle(x);
      await pass();
    });

    it("a reversal seen before any booking books nothing (out of order)", async () => {
      const t = id(); const u0 = await unalloc();
      rows = [row(t, "T0300", "3.00", { status: "V" })];
      await pass();
      expect(await movement(t)).toMatchObject({ accounting_status: "reversed", journal_id: null });
      expect(await unalloc()).toBe(u0);
    });

    const bookOne = async (value: string, minor: number) => {
      const t = id();
      rows = [row(t, "T0300", value, { at: 4 * HOUR })];
      await worker.tick(); await age(t); await paypalHolds(minor); await pass();
      expect(await movement(t)).toMatchObject({ accounting_status: "booked" });
      return t;
    };

    it("a booked deposit PayPal reverses is taken back once from unallocated; the alert says so", async () => {
      const t = await bookOne("4.00", 400); const u0 = await unalloc();
      rows = [row(t, "T0300", "4.00", { status: "V" })];
      cash -= 400;
      await pass(); await pass();
      expect(await movement(t)).toMatchObject({ accounting_status: "reversed", shortfall_minor: "0", return_journal_id: expect.any(String) });
      expect(await unalloc()).toBe(u0 - 400);
      expect(await journals(`return:${ref(t)}`)).toEqual([{ kind: "owner_funding_returned", source: "executor", actor: "treasury-watch" }]);
      expect((await alerts("TREASURY_FUNDING_REVERSED")).filter((a) => a.title.includes(t))).toHaveLength(1);
      expect((await R.q(`SELECT fleet.fleet_ledger_verify() AS r`))[0].r.ok).toBe(true);
    });

    it("a separate reversal row naming a funded deposit takes it back; a different amount is not guessed", async () => {
      const t = await bookOne("2.00", 200);
      const rv = id(); const u0 = await unalloc();
      rows = [row(rv, "T1106", "-1.50", { at: 10 * 60_000, ref: t })];
      await pass();
      expect(await movement(rv)).toMatchObject({ classification: "funding_reversal", accounting_status: "reversal_review" });
      expect(await unalloc()).toBe(u0);
      const rv2 = id();
      rows = [row(rv2, "T1106", "-2.00", { at: 5 * 60_000, ref: t })];
      cash -= 200;
      await pass();
      expect(await movement(rv2)).toMatchObject({ classification: "funding_reversal", return_journal_id: expect.any(String) });
      expect(await journals(`return:${ref(t)}`)).toHaveLength(1);
      expect(await unalloc()).toBe(u0 - 200);
    });

    it("a reversal after the money was spent leaves an open shortfall: no money invented, no wallet touched, RED alert; later money fills it", async () => {
      const t = await bookOne("6.00", 600);
      const free = await unalloc();
      const agent = R.founders[0].id;
      const wallet = async () => Number((await R.q(`SELECT fleet.fleet_ledger_balance(fleet.fleet_ledger_account($1, 'agent_cash')) AS b`, [agent]))[0].b);
      const w0 = await wallet();
      // The money has gone from unallocated (test-only posting), leaving 100p there.
      await R.q(`SELECT fleet.fleet_ledger_post('treasury_shortfall_cover', $1, 'controller', 'test only', 'controller', NULL, NULL, NULL, NULL, NULL, now(), jsonb_build_array(jsonb_build_object('account', 'fleet:treasury:shortfall', 'side', 'D', 'amount', $2::bigint), jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', $2::bigint)))`, [`spent-${t}`, free - 100]);
      expect(await unalloc()).toBe(100);
      const s0 = await shortfall();
      rows = [row(t, "T0300", "6.00", { status: "V" })];
      await pass(); await pass();
      expect(await movement(t)).toMatchObject({ accounting_status: "reversal_shortfall", shortfall_minor: "500" });
      expect(await unalloc()).toBe(0);
      expect(await shortfall()).toBe(s0 - 500);
      expect(await wallet()).toBe(w0);
      expect((await alerts("TREASURY_FUNDING_REVERSED")).filter((a) => a.class === "RED" && a.title.includes("left a shortfall of GBP 5.00"))).toHaveLength(1);
      expect(await R.q(`SELECT 1 FROM fleet.fleet_events WHERE event_type = 'treasury_reversal_shortfall' AND detail ->> 'transactionId' = $1`, [t])).toHaveLength(1);
      expect((await position()).providerSync.needsReview).toBeGreaterThan(0);
      expect((await R.q(`SELECT fleet.fleet_ledger_verify() AS r`))[0].r.ok).toBe(true);
    });
  });

  it("every other outgoing type is explicit: withdrawal, unlinked refund, hold, fee, unknown", async () => {
    const cases: Array<[string, string, string]> = [["T0403", "-5.00", "withdrawal"], ["T1107", "-5.00", "refund_unlinked"], ["T2101", "-1.00", "hold_or_release"], ["T0106", "-1.00", "fee_unlinked"], ["T9999", "-1.00", "outgoing_unknown"]];
    rows = cases.map(([c, v]) => row(id(), c, v));
    await pass();
    for (let i = 0; i < cases.length; i++) {
      const m = await movement(String(rows[i].transaction_info.transaction_id));
      expect(m, cases[i][0]).toMatchObject({ classification: cases[i][2], direction: "out", journal_id: null });
      expect(m.action, cases[i][0]).toEqual(expect.any(String));
    }
    expect(await R.q(`SELECT 1 FROM fleet.fleet_events WHERE event_type = 'treasury_outgoing_recorded' AND detail ->> 'eventCode' = 'T0403'`)).toHaveLength(1);
    rows = [];
  });

  it("display-only rows need nothing; rows the Fleet cannot read are counted and cost no other row; alert once a day", async () => {
    const good = id(), shown = id();
    rows = [{ transaction_info: { transaction_id: "BADROW00000000001" } } as Row, row(good, "T0000", "1.11"), row(shown, "T9800", "1.00")];
    await pass(); await pass();
    const s = await sync();
    expect(s.state).toBe("rows_lost");
    expect(s.search).toMatchObject({ dropped: 1, ingested: 2 });
    expect(await movement(good)).toBeTruthy();
    expect(await movement(shown)).toMatchObject({ classification: "display_only", accounting_status: "none_required" });
    expect((await alerts("TREASURY_SYNC_PROBLEM")).filter((a) => a.title.includes("rows_lost"))).toHaveLength(1);
    rows = [];
  });

  it("a failing Search, a failing later page and silence are each shown and alert; a 200 on page 1 is not success", async () => {
    searchStatus = 403;
    await pass();
    let s = await sync();
    expect(s).toMatchObject({ state: "failing", search: { lastHttp: 403, lastErrorName: "NOT_AUTHORIZED" } });
    expect((await alerts("TREASURY_SYNC_PROBLEM")).some((a) => a.title.includes("failing"))).toBe(true);
    searchStatus = 200; page2Status = 500;
    await pass();
    s = await sync();
    expect(s).toMatchObject({ state: "failing", search: { lastHttp: 500 } });
    page2Status = 200;
    await pass();
    expect((await sync()).search.lastHttp).toBe(200);
    await R.q(`UPDATE fleet.fleet_paypal_sync_status SET last_ok_at = now() - interval '3 hours' WHERE kind = 'transaction_search'`);
    expect((await sync()).state).toBe("stale");
    await R.q(`SELECT fleet.svc_treasury_watch_tick()`);
    expect((await alerts("TREASURY_SYNC_PROBLEM")).some((a) => a.title.includes("stale"))).toBe(true);
    await worker.tick();
  });

  it("PayPal's data being old is its own state, separate from the Fleet's requests succeeding", async () => {
    await R.q(`UPDATE fleet.fleet_paypal_sync_status SET detail = detail || jsonb_build_object('lastRefreshedAt', to_char(now() - interval '7 hours', 'YYYY-MM-DD"T"HH24:MI:SSOF')) WHERE kind = 'transaction_search'`);
    expect((await sync()).state).toBe("provider_data_stale");
    await worker.tick();
  });

  it("a late receipt, published after any short overlap, is still taken in", async () => {
    const newer = id(), late = id();
    rows = [row(newer, "T0000", "0.10", { at: 60_000 })];
    await worker.tick();
    rows.push(row(late, "T0000", "0.20", { at: 5 * HOUR }));
    await worker.tick();
    expect(Date.parse(seen.at(-1)!.start)).toBeLessThanOrEqual(Date.now() - 71 * HOUR);
    expect(await R.q(`SELECT 1 FROM fleet.fleet_paypal_transactions WHERE transaction_id = $1`, [late])).toHaveLength(1);
    rows = [];
  });

  it("an unexplained balance difference is raised past its grace, once a day, and clears", async () => {
    const start = Number((await R.q(`SELECT fleet.fleet_capital_backing() AS r`))[0].r.differenceMinor);
    cash += 1234; await worker.tick();
    await R.q(`SELECT fleet.svc_treasury_watch_tick()`);
    expect(await alerts("TREASURY_BALANCE_UNEXPLAINED")).toHaveLength(0);
    await R.q(`UPDATE fleet.fleet_treasury_watch_state SET difference_since = now() - interval '7 hours'`);
    await R.q(`SELECT fleet.svc_treasury_watch_tick()`);
    await R.q(`SELECT fleet.svc_treasury_watch_tick()`);
    expect(await alerts("TREASURY_BALANCE_UNEXPLAINED")).toHaveLength(1);
    cash -= 1234 + start; await worker.tick();
    await R.q(`SELECT fleet.svc_treasury_watch_tick()`);
    expect((await sync()).watch.differenceSince).toBeUndefined();
  });

  it("a row the watch fails on is recorded and retried, and the rows after it still run", async () => {
    const bad = id(), ok = id();
    rows = [row(bad, "T0000", "0.33", { at: 5 * HOUR }), row(ok, "T0000", "0.44", { at: 4 * HOUR })];
    await worker.tick();
    await R.q(`CREATE FUNCTION fleet.boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (SELECT transaction_id FROM fleet.fleet_treasury_movements WHERE movement_id = NEW.movement_id) = '${bad}' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`);
    await R.q(`CREATE TRIGGER boom BEFORE INSERT ON fleet.fleet_treasury_movement_history FOR EACH ROW EXECUTE FUNCTION fleet.boom()`);
    const r = (await R.q(`SELECT fleet.svc_treasury_watch_tick() AS r`))[0].r as any;
    expect(r.failed).toBe(1);
    expect(await movement(ok)).toMatchObject({ classification: "incoming_payment" });
    expect(await movement(bad)).toMatchObject({ classification: "processing_failed", accounting_status: "needs_review", last_error: expect.stringContaining("injected failure") });
    expect((await alerts("TREASURY_INGESTION_FAILED")).filter((a) => a.title.includes(bad))).toHaveLength(1);
    await R.q(`DROP TRIGGER boom ON fleet.fleet_treasury_movement_history`);
    await R.q(`DROP FUNCTION fleet.boom()`);
    await R.q(`SELECT fleet.svc_treasury_watch_tick()`);
    expect(await movement(bad)).toMatchObject({ classification: "incoming_payment", last_error: null });
    rows = [];
  });

  it("Fleet Control gets verified facts or unknown, and only the facts it needs", async () => {
    const f = (await R.q(`SELECT fleet.fleet_treasury_control_facts() AS r`))[0].r as any;
    expect(Object.keys(f).sort()).toEqual(["backedTreasuryAvailableMinor", "ownerPayableMinor", "providerCashAvailableMinor", "providerCashFresh", "providerCashObservedAt", "providerDataReachesTo", "providerSync", "reconciliation", "restrictedMinor", "unbackedCapitalMinor"]);
    expect(JSON.stringify(f)).not.toMatch(/agentId|wallet|TX[0-9A-F]{14}/);
  });

  it("a spend review's job carries the treasury facts; the prompt says they are context", async () => {
    const job = { reviewId: "r", kind: "card_request" as const, agentId: "a", amountMinor: 100, payee: "p", signals: {}, request: {}, attempt: 1, treasury: { reconciliation: "unavailable", providerCashAvailableMinor: null } };
    expect(spendReviewPrompt(job)).toContain('"providerCashAvailableMinor": null');
    expect(SPEND_REVIEW_SYSTEM).toContain("a null figure means unknown");
    const fn = (await R.q(`SELECT pg_get_functiondef('fleet.svc_spend_reviews_claim(integer, text)'::regprocedure) AS d`))[0].d as string;
    expect(fn).toContain("'treasury', fleet_treasury_control_facts()");
  });

  it("the operator read is a closed shape: no account id, nothing it does not name", async () => {
    const db = (await R.q(`SELECT fleet.fleet_treasury_position() AS r`))[0].r as any;
    const body = treasuryBody({ ...db, smuggled: "x", movements: [{ ...db.movements[0], counterparty: "someone@example.test" }] });
    expect(JSON.stringify(body)).not.toContain("someone@example.test");
    expect(JSON.stringify(body)).not.toContain("smuggled");
    expect(() => validateTreasury(body)).not.toThrow();
    expect(() => validateTreasury({ ...body, extra: 1 })).toThrow();
    expect(() => validateTreasury({ ...body, movements: [{ amountMinor: 1, counterparty: "x" }] })).toThrow();
  });

  it("auto-booking cannot reach back before it was switched on", async () => {
    await policyOn();
    await R.q(`UPDATE fleet.fleet_treasury_watch_policy SET auto_book_from = now() + interval '1 hour'`);
    const t = id(); const u0 = await unalloc();
    rows = [row(t, "T0300", "2.50")];
    await worker.tick(); await age(t); await paypalHolds(250); await pass();
    expect(await movement(t)).toMatchObject({ accounting_status: "needs_review", rule: "older than the auto-booking start" });
    expect(await unalloc()).toBe(u0);
    await policyOff();
  });

  it("the switch needs the owner and the live rail", async () => {
    await expect(R.q(`SELECT fleet.fleet_admin_treasury_watch_policy_set(true, $1, NULL, NULL, NULL, 'treasury-watch')`, [rail.railId])).rejects.toThrow(/FLEET_APPROVAL_REQUIRED/);
    await expect(R.q(`SELECT fleet.fleet_admin_treasury_watch_policy_set(true, gen_random_uuid(), NULL, NULL, NULL, 'operator:test')`)).rejects.toThrow(/FLEET_BAD_REQUEST/);
  });
});
