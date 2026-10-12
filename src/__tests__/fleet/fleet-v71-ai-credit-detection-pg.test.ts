/**
 * Schema v71 — AI-credit purchases detected and accounted for automatically (PostgreSQL; simulated mailbox and custody
 * worker; no provider, no money moves):
 *  - owner_card route: a provider receipt arriving in the Fleet mailbox becomes owner-funded credit (once per receipt
 *    number); nothing is posted to the books; an unreadable receipt is reported, never guessed;
 *  - treasury_paypal route: a receipt waits for the treasury's own debit (counterparty, window, implied rate); matched →
 *    treasury-funded, with the consumption already drawn taken back out of the owner payable; a receipt with no debit stays
 *    owner-funded and raises P1; the owner can attribute a debit; a debit with no receipt becomes an estimated treasury lot;
 *  - no duplicate lots, purchases or expenses; the ledger verifies.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { liveRail, type ArmedCustody } from "./fixtures/custody-signer.js";
import { PgIdentityGateway } from "../../fleet/identity/gateway.js";
import { IdentityBroker } from "../../fleet/identity/broker.js";
import { SimulatedSharedMailProvider } from "../../fleet/identity/providers.js";
import { initIdentityState, openIdentityState, openProviderVault } from "../../fleet/identity/main.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";

const PG_BIN = findPgBin();
const USD = 100_000_000;
const SENDER = "Anthropic, PBC <invoice+statements@mail.anthropic.test>";

describe.skipIf(!PG_BIN)("v71: AI-credit purchases detected and accounted for automatically (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let custody: pg.Pool;
  let rail: ArmedCustody;
  let dir = "";
  let gw: PgIdentityGateway;
  let broker: IdentityBroker;
  const shared = new SimulatedSharedMailProvider("fleet@shared.fleet-mail.test");
  const W = "custody-executor";
  const cx = async (fn: string, args: unknown[]) => (await custody.query(`SELECT fleet.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) AS r`, args)).rows[0].r;
  const bal = async (a: string) => Number(await R.one(`fleet.fleet_ledger_balance($1)`, [a]));
  const lots = () => R.q(`SELECT lot_id, source, usd_purchased::bigint AS usd, usd_remaining::bigint AS rem, gbp_cost_minor, awaiting_debit_until, usd_estimated, external_ref FROM fleet.fleet_ai_credit_lots ORDER BY purchased_at`);
  const charge = (usd: number) => R.one(`fleet.fleet_control_charge('knowledge_review_charge', $1, $2::jsonb)`,
    [crypto.randomUUID(), JSON.stringify([{ provider: "anthropic", requestId: crypto.randomUUID(), usdMicrocents: usd }])]);
  const settle = () => R.one<Record<string, any>>(`fleet.svc_ai_credit_settle(20)`);
  const policy = (route: string, extra: string[] = []) => R.one(`fleet.fleet_admin_ai_credit_policy_set('anthropic', $1, '@mail.anthropic.test', $2, 1000, 5000, true, $3)`,
    [route, extra[0] ?? (route === "treasury_paypal" ? "anthropic" : null), OWNER]);
  const receipt = async (no: string, usd: string, sender = SENDER) => {
    shared.deliver({ from: sender, to: [shared.address], subject: `Your receipt from Anthropic, PBC #${no}`, body: `Receipt #${no}\nAmount paid $${usd}\nDate paid Oct 12, 2026\nCredit purchase` });
    await broker.tick();
  };
  const debit = async (gbpMinor: number, counterparty: string | null, at = new Date()) => {
    const tid = `D${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
    expect((await cx("cx_paypal_txn_record", [W, rail.railId, JSON.stringify({ transactionId: tid, eventCode: "T0006", initiatedAt: at.toISOString(),
      status: "S", currency: "GBP", amountMinor: -gbpMinor, feeMinor: 0 })])).ok).toBe(true);
    if (counterparty) expect((await cx("cx_paypal_txn_counterparty", [W, rail.railId, tid, "T0006", counterparty])).ok).toBe(true);
    return tid;
  };
  const events = async (type: string) => Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE event_type = $1)`, [type]));

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, treasuryCents: 100_000, simulatedSettlement: false });
    await R.store.grantCustodyRole();
    custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 2, options: "-c search_path=fleet" });
    rail = await liveRail(R.owner, "fleet", OWNER);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v71-"));
    fs.chmodSync(dir, 0o700);
    initIdentityState(dir);
    gw = new PgIdentityGateway({ connectionString: R.pgc.identityUrl });
    const { vault, ownerVault } = openIdentityState(dir);
    broker = new IdentityBroker(gw, vault, { mail: shared, ownerVault, providerVault: openProviderVault(dir), stateFile: path.join(dir, "pending.json") });
    await broker.tick();
    await R.q(`UPDATE fleet.fleet_ai_credit_lots SET usd_remaining = 0`);   // the fixture's opening credit is set aside (no ledger effect)
  }, 300_000);
  afterAll(async () => {
    await gw?.close(); await custody?.end(); await R?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("migrates to v71 with a clean audit; only the owner sets the policy; the treasury route needs a counterparty", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(71);
    const audit = (await R.store.auditPrivileges()).problems;
    expect(audit, JSON.stringify(audit)).toEqual([]);
    expect(await R.code(R.one(`fleet.fleet_admin_ai_credit_policy_set('anthropic', 'owner_card', NULL, NULL, NULL, NULL, true, 'agent:x')`))).toBe("FLEET_APPROVAL_REQUIRED");
    expect(await R.code(R.one(`fleet.fleet_admin_ai_credit_policy_set('anthropic', 'treasury_paypal', NULL, NULL, NULL, NULL, true, $1)`, [OWNER]))).toMatch(/check constraint|violates/);
    expect(await R.one(`fleet.fleet_event_route('ai_credit_evidence_missing', '{}'::jsonb)`)).toBe("P1_HIGH");
    expect(Number(await R.one(`(SELECT version FROM fleet.fleet_knowledge_library WHERE entry_id = 'fleet-capability-status' AND current)`))).toBe(3);
  });

  it("owner_card: a receipt becomes owner-funded credit once; nothing is posted; unreadable or foreign mail is never guessed", async () => {
    await policy("owner_card");
    const j0 = Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ledger_journal)`));
    await receipt("2741-6510", "25.00");
    await receipt("2741-6510", "25.00");                                         // the same receipt again
    await receipt("9999-0001", "25.00", "Someone <billing@elsewhere.test>");     // not the provider's sender
    shared.deliver({ from: SENDER, to: [shared.address], subject: "Your receipt from Anthropic, PBC", body: "Thanks for your purchase." });
    await broker.tick();
    const l = await lots();
    const mine = l.filter((x) => x.external_ref === "receipt:anthropic:2741-6510");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ source: "owner", usd: String(25 * USD), awaiting_debit_until: null });
    expect(l.some((x) => String(x.external_ref).includes("9999-0001"))).toBe(false);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ledger_journal)`))).toBe(j0);
    expect(await events("ai_credit_receipt_unparsed")).toBe(1);
    // used by AI: owed to the owner (v69), automatically
    const p0 = await bal("fleet:owner:payable");
    await charge(5 * USD);
    expect(await bal("fleet:owner:payable")).toBe(p0 + 500);
    await R.q(`UPDATE fleet.fleet_ai_credit_lots SET usd_remaining = 0`);
  });

  it("treasury_paypal: the receipt is matched to the treasury's debit; consumption already drawn leaves the owner payable", async () => {
    await policy("treasury_paypal");
    await receipt("3001-0001", "25.00");
    const [lot] = (await lots()).filter((x) => x.external_ref === "receipt:anthropic:3001-0001");
    expect(lot).toMatchObject({ source: "owner" });
    expect(lot.awaiting_debit_until).not.toBeNull();
    const p0 = await bal("fleet:owner:payable");
    await charge(5 * USD);                                                       // drawn before the debit is seen
    expect(await bal("fleet:owner:payable")).toBe(p0 + 500);
    await debit(2_450, "Some other merchant");                                   // wrong counterparty: ignored
    await debit(4_000, "Anthropic, PBC");                                         // implied rate far off: ignored
    await debit(2_450, "billing@anthropic.com | Anthropic, PBC");                 // within 8% of the 1:1 controlled rate
    const s = await settle();
    expect(s.detection).toMatchObject({ matched: 1 });
    const [now] = (await lots()).filter((x) => x.lot_id === lot.lot_id);
    expect(now).toMatchObject({ source: "treasury", gbp_cost_minor: "2450", awaiting_debit_until: null });
    expect(s.reclassifiedMinor).toBe(500);
    expect(await bal("fleet:owner:payable")).toBe(p0);                           // no false owner payable
    expect(await bal("fleet:ai_credits")).toBe(2_450 - 500);
    expect((await settle()).detection).toMatchObject({ matched: 0, estimated: 0 });   // idempotent
    expect(await R.one(`fleet.fleet_ledger_verify() ->> 'ok'`)).toBe("true");
  });

  it("no debit: the receipt stays owner-funded with a P1; the owner attributes a debit; a debit without receipt is estimated", async () => {
    await receipt("3002-0002", "10.00");
    const [lot] = (await lots()).filter((x) => x.external_ref === "receipt:anthropic:3002-0002");
    await R.q(`UPDATE fleet.fleet_ai_credit_lots SET awaiting_debit_until = now() - interval '1 minute' WHERE lot_id = $1`, [lot.lot_id]);
    expect((await settle()).detection).toMatchObject({ expired: 1 });
    expect(await events("ai_credit_evidence_missing")).toBe(1);
    expect((await lots()).find((x) => x.lot_id === lot.lot_id)).toMatchObject({ source: "owner", awaiting_debit_until: null });
    // The owner knows the treasury paid it after all: attributes the debit.
    const tid = await debit(980, null);
    expect(await R.one(`fleet.fleet_admin_ai_credit_attribute($1, $2, $3, 'T0006', $4)`, [lot.lot_id, rail.railId, tid, OWNER])).toMatchObject({ ok: true, gbpMinor: 980 });
    expect(await R.code(R.one(`fleet.fleet_admin_ai_credit_attribute($1, $2, $3, 'T0006', $4)`, [lot.lot_id, rail.railId, tid, OWNER]))).toBe("FLEET_BAD_REQUEST");
    // A matching debit with no receipt for longer than the window: treasury credit with its USD estimated.
    const old = await debit(1_500, "Anthropic, PBC", new Date(Date.now() - 4 * 86_400_000));
    expect((await settle()).detection).toMatchObject({ estimated: 1 });
    const est = (await lots()).find((x) => x.external_ref === `debit:${old}`);
    expect(est).toMatchObject({ source: "treasury", usd_estimated: true, gbp_cost_minor: "1500", usd: String(15 * USD) });
    expect((await settle()).detection).toMatchObject({ estimated: 0 });        // once
    expect(await R.one(`fleet.fleet_ledger_verify() ->> 'ok'`)).toBe("true");
  });
});
