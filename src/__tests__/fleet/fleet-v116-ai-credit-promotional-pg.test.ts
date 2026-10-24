/**
 * Schema v116 — promotional AI credit is its own lot (PostgreSQL; no provider, no money moves):
 *  - the grant is recorded once from the console (amount, dates, identifier, remaining); what the console shows already
 *    used is drawn from that grant only — never from a purchased lot — and nothing is posted to the GBP books;
 *  - the draw order is the owner's recorded observation (default unchanged: oldest first); an expired grant is never
 *    drawn, and the minutely settlement records its expiry once, so it stops counting as credit;
 *  - the status reports promotional credit and Fleet's use of it separately.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";

const PG_BIN = findPgBin();
const USD = 100_000_000;   // one dollar in USD microcents

describe.skipIf(!PG_BIN)("v116: promotional AI credit as its own lot (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  const balance = async () => Number(await R.one(`fleet.fleet_provider_credit_balance('anthropic')`));
  const journals = async () => Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ledger_journal)`));
  const lotOf = async (ref: string) => (await R.q(`SELECT * FROM fleet.fleet_ai_credit_lots WHERE external_ref = $1`, [ref]))[0];
  /** A provider consumption as the live path records it (the draw is what this test is about; no charge is posted here). */
  const consume = async (usd: number) => {
    const req = crypto.randomUUID();
    await R.q(`INSERT INTO fleet.fleet_provider_credit_events (provider, kind, usd_microcents, request_id, recorded_by) VALUES ('anthropic', 'consumption', $1, $2, 'controller')`, [-usd, req]);
    return (await R.q(`SELECT l.source, d.usd FROM fleet.fleet_ai_credit_draws d JOIN fleet.fleet_ai_credit_lots l ON l.lot_id = d.lot_id WHERE d.request_id = $1 ORDER BY d.draw_id`, [req]))
      .map((r) => `${r.source}:${Number(r.usd) / USD}`);
  };
  const grant = (ref: string, cents: number, remaining: number, grantedAt: string, expiresAt: string) =>
    R.one<Record<string, any>>(`fleet.fleet_admin_ai_credit_promotional_grant('anthropic', $1, $2, $3, $4::timestamptz, $5::timestamptz, 'console billing page', $6)`,
      [ref, cents, remaining, grantedAt, expiresAt, OWNER]);
  const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, treasuryCents: 100_000, simulatedSettlement: false });
    await R.q(`UPDATE fleet.fleet_ai_credit_lots SET usd_remaining = 0`);   // the fixture's opening credit is set aside (no ledger effect)
  }, 300_000);
  afterAll(async () => { await R?.close(); });

  it("migrates to v116 with a clean audit", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(116);
    const audit = (await R.store.auditPrivileges()).problems;
    expect(audit, JSON.stringify(audit)).toEqual([]);
  });

  it("records a grant once: its own lot, what the console shows used drawn from it alone, nothing posted", async () => {
    await R.one(`fleet.fleet_provider_credits_record('anthropic', 'purchase', 2000, 'receipt-older', $1)`, [OWNER]);   // $20 bought by the owner
    await R.q(`UPDATE fleet.fleet_ai_credit_lots SET purchased_at = now() - interval '10 days' WHERE external_ref = 'receipt-older'`);
    const bal0 = await balance(), j0 = await journals();
    const r = await grant("credit_grant_A1", 5_000, 4_500, days(-1), days(30));          // $50 granted, $45 left
    expect(r).toMatchObject({ ok: true, grantUsdCents: 5_000, remainingUsdCents: 4_500, usedBeforeRecordingUsdCents: 500 });
    expect(await balance()).toBe(bal0 + 45 * USD);                                       // only what is left counts as credit
    const lot = await lotOf("grant:anthropic:credit_grant_A1");
    expect(lot).toMatchObject({ source: "promotional", gbp_cost_minor: null, acq_total_usd_cents: null, journal_id: null });
    expect(Number(lot.usd_purchased)).toBe(50 * USD);
    expect(Number(lot.usd_remaining)).toBe(45 * USD);
    expect(Number((await lotOf("receipt-older")).usd_remaining)).toBe(20 * USD);        // the purchased lot is untouched
    expect(await journals()).toBe(j0);                                                   // no posting: the grant was never an asset
    expect((await R.q(`SELECT kind, usd_microcents FROM fleet.fleet_provider_credit_events WHERE external_ref LIKE 'grant:anthropic:credit_grant_A1%' ORDER BY seq`))
      .map((e) => `${e.kind}:${Number(e.usd_microcents) / USD}`)).toEqual(["grant:50", "grant_used:-5"]);
    expect(await R.code(grant("credit_grant_A1", 5_000, 4_500, days(-1), days(30)))).toBe("FLEET_ALREADY_CLAIMED");
    expect(await R.code(grant("credit_grant_B1", 1_000, 1_001, days(-1), days(30)))).toBe("FLEET_BAD_REQUEST");          // more left than granted
    expect(await R.code(grant("credit_grant_B2", 1_000, 1_000, days(-40), days(-1)))).toBe("FLEET_PROMOTIONAL_EXPIRED");
    expect(await R.code(R.one(`fleet.fleet_admin_ai_credit_promotional_grant('anthropic', 'credit_grant_C1', 1000, 1000, now() - interval '1 day', now() + interval '9 days', 'x', 'agent:x')`)))
      .toBe("FLEET_APPROVAL_REQUIRED");
  });

  it("draws in the recorded order: oldest first by default; promotional first only on the owner's evidence", async () => {
    expect(await consume(1 * USD)).toEqual(["owner:1"]);                                 // default: the older purchased lot
    expect(await R.code(R.one(`fleet.fleet_admin_ai_credit_draw_order('anthropic', 'promotional_first', 'console', $1)`, [OWNER]))).toBe("FLEET_NOT_FOUND");
    await R.one(`fleet.fleet_admin_ai_credit_policy_set('anthropic', 'owner_card', NULL, NULL, NULL, NULL, true, $1)`, [OWNER]);
    expect(await R.code(R.one(`fleet.fleet_admin_ai_credit_draw_order('anthropic', 'cheapest', 'console', $1)`, [OWNER]))).toBe("FLEET_BAD_REQUEST");
    expect(await R.one(`fleet.fleet_admin_ai_credit_draw_order('anthropic', 'promotional_first', 'console usage page: the grant fell first', $1)`, [OWNER]))
      .toMatchObject({ ok: true, drawOrder: "promotional_first" });
    expect(await consume(2 * USD)).toEqual(["promotional:2"]);
    // a second, sooner-expiring grant is drawn before the first
    await grant("credit_grant_A2", 300, 300, days(-1), days(5));
    expect(await consume(4 * USD)).toEqual(["promotional:3", "promotional:1"]);
    expect(Number((await R.q(`SELECT count(*) AS n FROM fleet.fleet_ai_credit_policy_history WHERE policy ->> 'draw_order' = 'promotional_first'`))[0].n)).toBe(1);
  });

  it("an expired grant is never drawn; the settlement records its expiry once, with no posting", async () => {
    await R.q(`UPDATE fleet.fleet_ai_credit_lots SET granted_at = now() - interval '40 days', purchased_at = now() - interval '40 days', expires_at = now() - interval '1 minute'
                WHERE external_ref = 'grant:anthropic:credit_grant_A1'`);
    const left = Number((await lotOf("grant:anthropic:credit_grant_A1")).usd_remaining);
    expect(left).toBe(42 * USD);                                           // 45 − 2 − 1
    expect(await consume(1 * USD)).toEqual(["owner:1"]);                                 // promotional first, but that grant has expired
    const bal0 = await balance(), j0 = await journals();
    const s = await R.one<Record<string, any>>(`fleet.svc_ai_credit_settle(20)`);
    expect(s.detection.promotionalExpired).toEqual({ lots: 1, usdMicrocents: left });
    expect(await balance()).toBe(bal0 - left);
    expect(Number((await lotOf("grant:anthropic:credit_grant_A1")).usd_remaining)).toBe(0);
    expect(await journals()).toBe(j0);
    expect((await R.one<Record<string, any>>(`fleet.svc_ai_credit_settle(20)`)).detection.promotionalExpired).toEqual({ lots: 0, usdMicrocents: 0 });
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE event_type = 'ai_credit_promotional_expired')`))).toBe(1);
  });

  it("reports promotional credit and Fleet's use of it separately; a grant never takes an acquisition cost", async () => {
    const st = await R.one<Record<string, any>>(`fleet.fleet_ai_credit_status()`);
    const a1 = st.promotional.find((p: any) => p.grantRef === "anthropic:credit_grant_A1");
    expect(a1).toMatchObject({ grantedUsdMicrocents: 50 * USD, remainingUsdMicrocents: 0, expired: true, usedBeforeRecordingUsdMicrocents: 5 * USD,
      expiredUsdMicrocents: 42 * USD, fleetUse: { calls: 2, usdMicrocents: 3 * USD } });
    expect(st.promotional.find((p: any) => p.grantRef === "anthropic:credit_grant_A2")).toMatchObject({ remainingUsdMicrocents: 0, expired: false, fleetUse: { calls: 1 } });
    expect(st.policy.anthropic.draw_order).toBe("promotional_first");
    expect(String(st.promotionalTreatment)).toMatch(/not decided/);
    const lot = String((await lotOf("grant:anthropic:credit_grant_A2")).lot_id);
    await expect(R.one(`fleet.fleet_admin_ai_credit_lot_cost($1, 300, 360, 'not a purchase', $2)`, [lot, OWNER])).rejects.toThrow();
    expect(await R.one(`fleet.fleet_ledger_verify() ->> 'ok'`)).toBe("true");
  });
});
