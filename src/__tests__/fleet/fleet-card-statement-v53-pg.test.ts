/**
 * Schema v53 — the weekly card statement and the owner's PayPal receiving test. PostgreSQL; custody and the reaper are their
 * database roles, called directly.
 *
 * Proven here:
 *  - the schedule: the latest Monday 09:00 Europe/London (default) at or before a moment, across the BST boundary;
 *  - the reaper issues nothing when nothing is charged or owed, and once per scheduled time otherwise; the amount owed is
 *    the whole card liability at issue; a statement lists the charges booked in its period;
 *  - a newer statement supersedes an unpaid older one; only the newest is paid; "paid" records the card repayment and
 *    releases the reserve; a reference is never used twice; a settled statement's facts are fixed;
 *  - the owner's receiving test goes through the custody path, is refused above its maximum, posts the net capture as
 *    OWNER CAPITAL (never an agent's revenue or held agent money), reports a refund without posting it, and keeps its
 *    "no owner, no venture" identity fixed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { liveRail, type ArmedCustody } from "./fixtures/custody-signer.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";
import { PAYPAL_TEST_MAX_MINOR } from "../../fleet/postgres/migrations-phase53.js";

const PG_BIN = findPgBin();

describe.skipIf(!PG_BIN)("v53: weekly card statement and the owner's receiving test (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let F: Founder;
  let svc: pg.Pool;
  let custody: pg.Pool;
  let su: pg.Pool;
  let rail: ArmedCustody;
  const one = async (db: pg.Pool, sql: string, params: unknown[] = []) => (await db.query(`SELECT ${sql} AS r`, params)).rows[0].r;
  const cx = (fn: string, args: unknown[]) => one(custody, `fleet.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")})`, args);
  const tick = () => one(svc, `fleet.svc_card_statement_tick()`);
  const statements = async () => (await R.one(`fleet.fleet_card_clearing()`)).statements as Array<Record<string, any>>;
  const events = async (type: string) => Number((await R.q(`SELECT count(*) AS n FROM fleet.fleet_events WHERE event_type = $1`, [type]))[0].n);
  const slot = async (at: string) => new Date(await R.one(`(SELECT fleet.fleet_card_statement_slot($1::timestamptz, p) FROM fleet.fleet_card_statement_policy p)`, [at])).toISOString();

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, simulatedSettlement: false });
    [F] = R.founders;
    for (const g of ["grantServiceRole", "grantCustodyRole"] as const) await R.store[g]();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2 });
    custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 2 });
    su = new pg.Pool({ connectionString: R.pgc.superUrl.replace(/\/postgres$/, "/fleet_t"), max: 1 });
    rail = await liveRail(R.owner, "fleet", OWNER, { scope: ["payouts", "receive_payments"] });
  }, 300_000);
  afterAll(async () => { for (const p of [svc, custody, su]) await p?.end(); await R?.close(); });

  it("migrates to v53 with a clean audit; the default schedule is Monday 09:00 Europe/London", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(53);
    expect(await R.one(`(SELECT max(version) FROM fleet.fleet_schema_migrations)`)).toBe(FLEET_PG_SCHEMA_VERSION);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    expect((await R.q(`SELECT enabled, weekday, hour, time_zone FROM fleet.fleet_card_statement_policy`))[0])
      .toEqual({ enabled: true, weekday: 1, hour: 9, time_zone: "Europe/London" });
    // Friday 9 Oct 2026 (BST): the latest slot is Monday 5 Oct 09:00 BST = 08:00Z; a moment before it goes back a week.
    expect(await slot("2026-10-09T12:00:00Z")).toBe("2026-10-05T08:00:00.000Z");
    expect(await slot("2026-10-05T07:59:00Z")).toBe("2026-09-28T08:00:00.000Z");
    expect(await slot("2026-10-05T08:00:00Z")).toBe("2026-10-05T08:00:00.000Z");
    // After the clocks go back (GMT): Monday 2 Nov 09:00 GMT = 09:00Z.
    expect(await slot("2026-11-04T12:00:00Z")).toBe("2026-11-02T09:00:00.000Z");
  });

  it("the schedule is the owner's: validated, audited and restorable", async () => {
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_card_statement_policy_set(NULL, NULL, NULL, 'Mars/Olympus', $1)`, [OWNER]))).toBe("FLEET_BAD_REQUEST");
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_card_statement_policy_set(NULL, 8, NULL, NULL, $1)`, [OWNER]))).toBe("FLEET_BAD_REQUEST");
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_card_statement_policy_set(NULL, 5, 17, NULL, 'agent')`))).toBe("FLEET_APPROVAL_REQUIRED");
    const r = await R.one(`fleet.fleet_admin_card_statement_policy_set(NULL, 5, 17, 'Europe/Paris', $1)`, [OWNER]);
    expect(r).toMatchObject({ ok: true, enabled: true, weekday: 5, hour: 17, timeZone: "Europe/Paris" });
    expect(await R.one(`fleet.fleet_event_route('card_statement_policy_set', '{}'::jsonb)`)).toBe("AUDIT_ONLY");
    await R.one(`fleet.fleet_admin_card_statement_policy_set(true, 1, 9, 'Europe/London', $1)`, [OWNER]);
  });

  it("nothing charged and nothing owed issues nothing; a charge makes the scheduled statement, once", async () => {
    expect(await tick()).toMatchObject({ ok: true, issued: false });
    const ch = await R.one(`fleet.fleet_admin_card_charge_record($1, 1_500, 'Hosting Ltd', 'stmt-line-1', $2)`, [F.id, OWNER]);
    expect(ch.ok).toBe(true);
    expect(await R.balance("fleet:card:payable")).toBe(1_500);
    const t = await tick();
    expect(t).toMatchObject({ ok: true, issued: true, statement: { status: "issued", dueMinor: 1_500 } });
    // Its period ends at the latest scheduled time; the charge was booked after it, so it is listed on the next statement.
    expect(new Date(t.statement.periodEnd).toISOString()).toBe(await slot(new Date().toISOString()));
    expect(t.statement.chargeCount).toBe(0);
    expect(await tick()).toMatchObject({ ok: true, issued: false, reason: "already issued" });
    expect(await R.one(`fleet.fleet_event_route('card_statement_issued', '{}'::jsonb)`)).toBe("P2_IMPORTANT");
    expect(await events("card_statement_issued")).toBe(1);
  });

  it("a newer statement supersedes the older one; paying it repays the card and releases the reserve", async () => {
    const first = (await statements()).find((s) => s.status === "issued")!;
    await R.one(`fleet.fleet_admin_card_charge_record($1, 700, 'Domains Co', 'stmt-line-2', $2)`, [F.id, OWNER]);
    const now = await R.one(`fleet.fleet_admin_card_statement_issue($1)`, [OWNER]);
    expect(now).toMatchObject({ ok: true, issued: true, statement: { status: "issued", chargeCount: 2, chargesMinor: 2_200, dueMinor: 2_200 } });
    expect((now.statement.lines as Array<{ merchant: string }>).map((l) => l.merchant)).toEqual(["Hosting Ltd", "Domains Co"]);
    const list = await statements();
    expect(list.find((s) => s.statementId === first.statementId)).toMatchObject({ status: "superseded", supersededBy: now.statement.statementId });
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_card_statement_paid($1, 'pp-transfer-0', $2)`, [first.statementId, OWNER]))).toBe("FLEET_INVALID_STATE");
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_card_statement_paid($1, ' ', $2)`, [now.statement.statementId, OWNER]))).toBe("FLEET_BAD_REQUEST");

    const paid = await R.one(`fleet.fleet_admin_card_statement_paid($1, 'pp-transfer-1', $2)`, [now.statement.statementId, OWNER]);
    expect(paid).toMatchObject({ ok: true, outstandingMinor: 0, statement: { status: "paid", paidMinor: 2_200, paidReference: "pp-transfer-1" } });
    expect(await R.balance("fleet:card:payable")).toBe(0);
    expect(await R.balance("fleet:card:reserve")).toBe(0);
    expect((await R.q(`SELECT amount_minor, reference FROM fleet.fleet_card_repayments`))).toEqual([{ amount_minor: "2200", reference: "pp-transfer-1" }]);
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_card_statement_paid($1, 'pp-transfer-2', $2)`, [now.statement.statementId, OWNER]))).toBe("FLEET_INVALID_STATE");

    // A reference already used for a repayment is refused; settled statements are history.
    await R.one(`fleet.fleet_admin_card_charge_record($1, 300, 'Fonts Inc', 'stmt-line-3', $2)`, [F.id, OWNER]);
    const third = await R.one(`fleet.fleet_admin_card_statement_issue($1)`, [OWNER]);
    expect(third.statement).toMatchObject({ chargeCount: 1, chargesMinor: 300, dueMinor: 300 });
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_card_statement_paid($1, 'pp-transfer-1', $2)`, [third.statement.statementId, OWNER]))).toBe("FLEET_ALREADY_CLAIMED");
    expect(await R.code(R.q(`UPDATE fleet.fleet_card_statements SET due_minor = 1 WHERE statement_id = $1`, [now.statement.statementId]))).toMatch(/FLEET_HISTORY_IMMUTABLE|permission denied/);
    expect(await R.code(R.q(`UPDATE fleet.fleet_card_statements SET due_minor = 1 WHERE statement_id = $1`, [third.statement.statementId]))).toMatch(/FLEET_IMMUTABLE|permission denied/);
    expect(await R.one(`fleet.fleet_event_route('card_statement_paid', '{}'::jsonb)`)).toBe("P2_IMPORTANT");
  });

  it("the owner's receiving test: custody path, owner capital (never revenue), refund reported, identity fixed", async () => {
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_paypal_test_checkout($1, $2)`, [PAYPAL_TEST_MAX_MINOR + 1, OWNER]))).toBe("FLEET_BAD_REQUEST");
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_paypal_test_checkout(100, 'agent')`))).toBe("FLEET_APPROVAL_REQUIRED");
    const t = await R.one(`fleet.fleet_admin_paypal_test_checkout(100, $1)`, [OWNER]);
    expect(t).toMatchObject({ ok: true, test: { amountMinor: 100, status: "requested", mode: "live" } });
    const id = t.test.checkoutId as string;
    expect(await R.one(`fleet.fleet_admin_paypal_test_checkout(100, $1)`, [OWNER])).toMatchObject({ ok: true, replay: true, test: { checkoutId: id } });
    const work = await cx("cx_paypal_work", ["custody-executor", 20]);
    expect((work as Array<{ checkoutId: string; description: string }>).find((w) => w.checkoutId === id)).toMatchObject({ description: "Automaton Fleet receiving test" });

    const order = `ORD${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
    await cx("cx_paypal_checkout_update", ["custody-executor", id, "open", order, `https://www.paypal.com/checkoutnow?token=${order}`, null]);
    expect((await R.one(`fleet.fleet_paypal_test_json()`)).tests[0]).toMatchObject({ status: "open", approvalUrl: `https://www.paypal.com/checkoutnow?token=${order}` });
    await cx("cx_paypal_checkout_update", ["custody-executor", id, "approved", null, null, null]);

    const cap0 = await R.balance("fleet:owner:capital"), tre0 = await R.balance("fleet:treasury:unallocated");
    const rev0 = await R.balance(`agent:${F.id}:revenue`).catch(() => 0);
    const cap = `CAP${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
    expect(await cx("cx_paypal_capture_record", ["custody-executor", id, cap, "COMPLETED", 100, 30, "GBP", "capture_response"]))
      .toMatchObject({ ok: true, status: "captured", netMinor: 70, ownerTest: true });
    expect(await cx("cx_paypal_capture_record", ["custody-executor", id, cap, "COMPLETED", 100, 30, "GBP", "webhook"])).toMatchObject({ ok: true, replay: true });
    expect(await R.balance("fleet:owner:capital")).toBe(cap0 + 70);
    expect(await R.balance("fleet:treasury:unallocated")).toBe(tre0 + 70);
    expect(await R.balance(`agent:${F.id}:revenue`).catch(() => 0)).toBe(rev0);
    expect(Number((await R.q(`SELECT count(*) AS n FROM fleet.fleet_paypal_availability WHERE checkout_id = $1`, [id]))[0].n)).toBe(0);
    expect((await R.q(`SELECT kind FROM fleet.fleet_ledger_journal j JOIN fleet.fleet_paypal_checkouts c ON c.journal_id = j.journal_id WHERE c.checkout_id = $1`, [id]))[0].kind)
      .toBe("owner_funding");

    let s = (await R.one(`fleet.fleet_paypal_test_json()`)).tests[0];
    expect(s).toMatchObject({ status: "captured", ownerCapitalMinor: 70, stage: "captured (waiting for Transaction Search)" });
    await cx("cx_paypal_txn_record", ["custody-executor", rail.railId, JSON.stringify({ transactionId: cap, eventCode: "T0006",
      initiatedAt: new Date().toISOString(), status: "S", currency: "GBP", amountMinor: 100, feeMinor: 30, customField: id })]);
    s = (await R.one(`fleet.fleet_paypal_test_json()`)).tests[0];
    expect(s.stage).toBe("captured and completed (waiting for a Balances reading)");
    await cx("cx_paypal_balance_record", ["custody-executor", rail.railId, "GBP", 5_000, 6_000]);
    s = (await R.one(`fleet.fleet_paypal_test_json()`)).tests[0];
    expect(s.stage).toBe("captured, completed and in the balance: receiving works");

    // A refund of the test is the owner's own money: reported once, never posted (no agent is debited).
    for (let i = 0; i < 2; i++) {
      expect(await cx("cx_paypal_refund_record", ["custody-executor", cap, "REF12345", "refund", 100, "GBP"])).toMatchObject({ ok: true, ownerTest: true, posted: false });
    }
    expect(await events("paypal_test_refund_seen")).toBe(1);
    expect(await R.one(`fleet.fleet_event_route('paypal_test_refund_seen', '{}'::jsonb)`)).toBe("P1_HIGH");
    expect(await R.balance("fleet:owner:capital")).toBe(cap0 + 70);

    // The test's identity (no agent, no venture) is fixed; an agent checkout always has both.
    const c = await su.connect();
    try {
      await c.query("SET search_path = fleet");
      expect(await R.code(c.query(`UPDATE fleet_paypal_checkouts SET agent_id = $1 WHERE checkout_id = $2`, [F.id, id]))).toBe("FLEET_IMMUTABLE");
      expect(await R.code(c.query(`UPDATE fleet_paypal_checkouts SET purpose = 'agent_sale' WHERE checkout_id = $1`, [id]))).toBe("FLEET_IMMUTABLE");
      expect(await R.code(c.query(`INSERT INTO fleet_paypal_checkouts (agent_id, venture_id, rail_id, description, amount_minor, currency, idempotency_key)
        VALUES (NULL, NULL, $1, 'no owner', 100, 'GBP', 'test:no-owner:1')`, [rail.railId]))).toMatch(/fleet_paypal_checkouts_purpose/);
    } finally { c.release(); }
  });
});
