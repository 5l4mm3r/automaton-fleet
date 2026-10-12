/**
 * Schema v69 — owner-funded AI credit is reimbursable (PostgreSQL; no model, no money moves, no reimbursement):
 *  - the migration posts no journal (the rollout refuses a moved ledger head); the owner then records, once, the AI costs
 *    charged before v69 as owed to the owner (opening journal), from the actual history — idempotent, owner-only;
 *  - every AI charge after v69 keeps its cash in the treasury's reimbursable partition and owes it to the owner — the expense
 *    is recognised once (no purchase is ever expensed); unallocated treasury money is not inflated by what the owner is owed;
 *  - the capital backing no longer treats AI costs as backing: unbacked = capital recorded without money − backed, and the
 *    books, PayPal and the owner payable reconcile.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin, startEphemeralPg, type EphemeralPg } from "./fixtures/ephemeral-pg.js";
import { migrateUpTo } from "./fixtures/migrate-to.js";
import { wipeRegistry } from "./fixtures/wipe.js";
import { PgFleetStore } from "../../fleet/postgres/store.js";
import { PgLedgerAdmin } from "../../fleet/treasury/ledger.js";
import { OWNER_PAYABLE_ACCOUNT, REIMBURSABLE_ACCOUNT } from "../../fleet/postgres/migrations-phase69.js";

const PG_BIN = findPgBin();
const OWNER = "operator:test";

describe.skipIf(!PG_BIN)("v69: owner-funded AI credit is reimbursable (PostgreSQL)", { timeout: 300_000 }, () => {
  let pgc: EphemeralPg;
  let owner: pg.Pool;
  const one = async <T = any>(expr: string, params: unknown[] = []) => (await owner.query(`SELECT ${expr} AS r`, params)).rows[0].r as T;
  const bal = async (a: string) => Number(await one(`fleet.fleet_ledger_balance($1)`, [a]));
  const charge = (usdMicrocents: number) => one(`fleet.fleet_control_charge('knowledge_review_charge', $1, $2::jsonb)`,
    [crypto.randomUUID(), JSON.stringify([{ provider: "anthropic", requestId: crypto.randomUUID(), usdMicrocents }])]);

  beforeAll(async () => {
    pgc = await startEphemeralPg(PG_BIN!);
    owner = new pg.Pool({ connectionString: pgc.ownerUrl, max: 2 });
    // History before v69: capital recorded without money, and an AI cost (£3.00) paid from the owner's provider credit.
    await migrateUpTo(pgc.ownerUrl, "fleet", 68);
    const c = await owner.connect();
    try { await c.query("BEGIN"); await wipeRegistry(c, "fleet"); await c.query("COMMIT"); } finally { c.release(); }
    await new PgLedgerAdmin({ connectionString: pgc.ownerUrl }).recordOwnerFunding(20_000, "owner-authorized-virtual:test:2026-10-12", OWNER);
    await charge(300_000_000);
    expect(await bal("fleet:treasury:unallocated")).toBe(19_700);
    await new PgFleetStore({ connectionString: pgc.ownerUrl }).migrate();
  }, 300_000);
  afterAll(async () => { await owner?.end(); await pgc?.stop?.(); });

  it("migrates with a clean audit and no journal; the owner's opening action brings past AI costs in once", async () => {
    expect((await new PgFleetStore({ connectionString: pgc.ownerUrl }).auditPrivileges()).problems).toEqual([]);
    expect(Number(await one(`(SELECT count(*) FROM fleet.fleet_ledger_journal WHERE kind = 'ai_credit_owner_payable_opening')`))).toBe(0);
    expect(await bal(OWNER_PAYABLE_ACCOUNT)).toBe(0);
    // Until it is recorded, the backing view keeps the pre-v69 picture (AI costs reduce what must be backed).
    expect(await one(`fleet.fleet_capital_backing()`)).toMatchObject({ providerPaidMinor: 300, unbackedMinor: 19_700, ownerPayableMinor: 0 });
    expect((await owner.query(`SELECT fleet.fleet_admin_ai_credit_opening('agent:x') AS r`).catch((e: Error) => e.message)) as string).toMatch(/FLEET_APPROVAL_REQUIRED/);
    expect(await one(`fleet.fleet_admin_ai_credit_opening($1)`, [OWNER])).toMatchObject({ ok: true, amountMinor: 300, ownerPayableMinor: 300 });
    expect(await one(`fleet.fleet_admin_ai_credit_opening($1)`, [OWNER])).toMatchObject({ ok: true, already: true, ownerPayableMinor: 300 });
    expect(await one(`fleet.fleet_event_route('ai_credit_owner_payable_opened', '{}'::jsonb)`)).toBe("P3_SUMMARY");
    expect(await bal(OWNER_PAYABLE_ACCOUNT)).toBe(300);
    expect(await bal(REIMBURSABLE_ACCOUNT)).toBe(300);
    expect(await bal("fleet:treasury:unallocated")).toBe(19_700);           // nothing owed to the owner is allocatable
    expect(Number(await one(`(SELECT count(*) FROM fleet.fleet_ledger_journal WHERE kind = 'ai_credit_owner_payable_opening')`))).toBe(1);
    expect(await one(`fleet.fleet_ledger_verify() ->> 'ok'`)).toBe("true");
  });

  it("each AI charge after v69 owes its cost to the owner; the expense is recognised once", async () => {
    const before = { exp: await bal("fleet:expense"), pay: await bal(OWNER_PAYABLE_ACCOUNT), un: await bal("fleet:treasury:unallocated") };
    await charge(200_000_000);                                                   // £2.00
    expect(await bal("fleet:expense")).toBe(before.exp + 200);                   // once
    expect(await bal(OWNER_PAYABLE_ACCOUNT)).toBe(before.pay + 200);
    expect(await bal("fleet:treasury:unallocated")).toBe(before.un - 200);       // the review's cost leaves the free treasury…
    expect(await bal(REIMBURSABLE_ACCOUNT)).toBe(before.pay + 200);             // …and is held for the owner (cash unchanged)
    const lines = await owner.query(`SELECT p.account_id, p.side, p.amount_cents::int AS a FROM fleet.fleet_ledger_postings p
      JOIN fleet.fleet_ledger_journal j ON j.journal_id = p.journal_id WHERE j.kind = 'knowledge_review_charge' ORDER BY j.seq DESC, p.line LIMIT 4`);
    expect(lines.rows.map((r) => `${r.account_id}:${r.side}:${r.a}`).sort()).toEqual([
      "fleet:expense:D:200", `${OWNER_PAYABLE_ACCOUNT}:C:200`, `${REIMBURSABLE_ACCOUNT}:D:200`, "fleet:treasury:unallocated:C:200"].sort());
    expect(await one(`fleet.fleet_ledger_verify() ->> 'ok'`)).toBe("true");
  });

  it("the capital backing: AI costs are owed to the owner, not backing — books, PayPal and the payable reconcile", async () => {
    const s = await one<Record<string, any>>(`fleet.fleet_capital_backing()`);
    expect(s).toMatchObject({ virtualCapitalMinor: 20_000, providerPaidMinor: 0, backedMinor: 0, unbackedMinor: 20_000, ownerPayableMinor: 500 });
    // Books: the £200 still in the treasury (AI costs stayed there, owed to the owner). PayPal holds nothing yet.
    expect(s.booksCashMinor).toBe(20_000);
  });
});
