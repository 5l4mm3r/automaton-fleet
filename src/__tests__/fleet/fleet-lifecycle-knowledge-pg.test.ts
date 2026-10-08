/**
 * Schema v50 — insolvency dormancy, commitment-aware burn, temporary sweep reductions, the foundational knowledge library
 * and PII-free shared lessons (docs/design/master-launch-specification.md §§8, 9). PostgreSQL.
 *
 * Proven here: an agent with nothing spendable and nothing in flight becomes dormant (the owner told), any money clears it,
 * and it dies only if the owner set a grace (default never) — then with cause `insolvent`; an open checkout keeps it out of
 * dormancy; burn includes recurring commitments; a reduction lowers the dynamic sweep rate until it expires, reverting by
 * itself; agents may only ask; the library returns ranked entries with hard rules and a stale-fact banner, and regulated
 * topics always pull in their compliance entry; shared knowledge never stores e-mail addresses, phones or card numbers.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { liveRail } from "./fixtures/custody-signer.js";
import { KNOWLEDGE_LIBRARY_V1 } from "../../fleet/postgres/knowledge-library-v1.js";

const PG_BIN = findPgBin();

describe.skipIf(!PG_BIN)("v50 insolvency, sweep reductions, knowledge library, PII scrubbing (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let F: Founder;
  let G: Founder;
  let svc: pg.Pool;
  let su: pg.Pool;
  const tick = async () => (await svc.query(`SELECT fleet.svc_insolvency_tick() AS r`)).rows[0].r;
  const status = async (who: Founder) => (await R.q(`SELECT status FROM fleet.fleet_agents WHERE agent_id = $1`, [who.id]))[0].status;
  const drain = async (who: Founder) => {
    const cash = await R.balance(`agent:${who.id}:cash`);
    await R.one(`fleet.fleet_admin_card_charge_record($1, $2, 'drain', $3, $4)`, [who.id, cash, `stmt-${crypto.randomUUID()}`, OWNER]);
  };

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 5_000, simulatedSettlement: false });
    [F, G] = R.founders;
    await R.store.grantServiceRole();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2 });
    su = new pg.Pool({ connectionString: R.pgc.superUrl.replace(/\/postgres$/, "/fleet_t"), max: 1 });
    for (const [who, key] of [[F, "f-venture"], [G, "g-venture"]] as const) {
      expect((await R.econ(who, "venture.create", { key, model: "digital_product", offer: key, state: "selected" })).ok).toBe(true);
    }
  }, 240_000);
  afterAll(async () => { await svc?.end(); await su?.end(); await R?.close(); });

  it("migrates with a clean audit and the library loaded; dormancy is on, automatic death is off by default", async () => {
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    expect(await R.one(`fleet.fleet_insolvency_json()`)).toMatchObject({ policy: { dormancyEnabled: true, deathAfterHours: null }, episodes: [] });
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_knowledge_library WHERE current)`))).toBe(KNOWLEDGE_LIBRARY_V1.entries.length);
    expect(await tick()).toMatchObject({ dormant: 0 });
  });

  it("an agent with nothing spendable and nothing in flight is dormant; money clears it; it dies only under an owner grace", async () => {
    await drain(F);
    expect(await tick()).toMatchObject({ dormant: 1 });
    expect(await tick()).toMatchObject({ dormant: 0, cleared: 0, died: 0 }); // one episode, no repeat
    expect(await R.one(`fleet.fleet_event_route('agent_dormant_insolvent', '{}'::jsonb)`)).toBe("P1_HIGH");
    // No grace set: still alive however long it stays dormant.
    const c = await su.connect();
    try { await c.query("SET session_replication_role = replica"); await c.query(`UPDATE fleet.fleet_agent_insolvency SET since = now() - interval '30 days' WHERE agent_id = $1`, [F.id]); }
    finally { c.release(); }
    await tick();
    expect(await status(F)).toBe("active");
    // Money arriving clears dormancy.
    await R.ledger.agentCapital({ agentId: F.id, amountCents: 100, mode: "grant", actor: OWNER });
    expect(await tick()).toMatchObject({ cleared: 1 });
    // An open checkout is in flight: an otherwise empty agent is not dormant while a sale may still arrive.
    await drain(G);
    await liveRail(R.owner, "fleet", OWNER);
    const ck = await R.econ(G, "paypal.checkout", { venture: "g-venture", amountMinor: 900, description: "a template", idempotencyKey: `chk-${crypto.randomUUID()}` });
    expect(ck.ok, JSON.stringify(ck)).toBe(true);
    const custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 1 });
    try {
      await R.store.grantCustodyRole();
      await custody.query(`SELECT fleet.cx_paypal_checkout_update('custody-executor', $1, 'open', 'ORD123456', 'https://www.paypal.com/checkoutnow?token=ORD123456', NULL)`, [ck.checkout.checkoutId]);
    } finally { await custody.end(); }
    expect(await tick()).toMatchObject({ dormant: 0 });
    await R.econ(G, "paypal.cancel", { checkoutId: ck.checkout.checkoutId }).catch(() => null);
    // With the owner's grace set, a dormant agent past it dies with cause insolvent (and the estate flow follows).
    await R.one(`fleet.fleet_admin_insolvency_policy_set(true, 24, $1)`, [OWNER]);
    await drain(F);
    await tick();
    const c2 = await su.connect();
    try { await c2.query("SET session_replication_role = replica"); await c2.query(`UPDATE fleet.fleet_agent_insolvency SET since = now() - interval '25 hours' WHERE agent_id = $1 AND status = 'dormant'`, [F.id]); }
    finally { c2.release(); }
    expect(await tick()).toMatchObject({ died: 1 });
    expect(await status(F)).toBe("dead");
    const died = (await R.q(`SELECT detail FROM fleet.fleet_events WHERE event_type = 'agent_died' AND agent_id = $1`, [F.id]))[0].detail;
    expect(died.cause).toBe("insolvent");
  });

  it("burn includes recurring commitments", async () => {
    const before = await R.one(`fleet.fleet_survival_observation($1)`, [G.id]);
    expect(Number(before.commitmentsPerDayCents)).toBe(0);
    const r = await R.econ(G, "commitment.add", { vendor: "Host", description: "VPS", amountMinor: 3040, period: "monthly", idempotencyKey: `cm-${crypto.randomUUID()}`,
      nextDueAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const after = await R.one(`fleet.fleet_survival_observation($1)`, [G.id]);
    expect(Number(after.commitmentsPerDayCents)).toBe(100);
    expect(after.burnBasis).toMatch(/commitments/);
  });

  it("a temporary sweep reduction lowers the dynamic rate until it expires; agents only ask; it reverts by itself", async () => {
    const base = (await R.one(`fleet.fleet_sweep_compute($1)`, [G.id])).rateBp as number;
    const ask = await R.econ(G, "sweep.reduction_request", { reductionBp: 5000, days: 30, reason: "reinvest in a second product line for Q4" });
    expect(ask).toMatchObject({ ok: true, status: "pending" });
    expect((await R.econ(G, "sweep.reduction_request", { reductionBp: 100, days: 3, reason: "another reason here" })).code).toBe("FLEET_REQUEST_PENDING");
    expect(Number((await R.one(`fleet.fleet_sweep_compute($1)`, [G.id])).rateBp)).toBe(base); // asking changes nothing
    const g = await R.one(`fleet.fleet_admin_sweep_reduction_grant($1, 5000, 30, 'approved for Q4 reinvestment', $2, $3)`, [G.id, ask.requestId, OWNER]);
    expect(g.sweep.reinvestmentReductionBp).toBe(5000);
    expect(g.sweep.rateBp).toBe(Math.floor(base * 5000 / 10000));
    expect(await R.code(R.q(`UPDATE fleet.fleet_sweep_rate_reductions SET reduction_bp = 9000`))).toBe("FLEET_HISTORY_IMMUTABLE");
    const c = await su.connect();
    try { await c.query("SET session_replication_role = replica"); await c.query(`UPDATE fleet.fleet_sweep_rate_reductions SET starts_at = now() - interval '31 days', expires_at = now() - interval '1 day'`); }
    finally { c.release(); }
    expect((await svc.query(`SELECT fleet.svc_sweep_reductions_expire() AS r`)).rows[0].r).toMatchObject({ expired: 1 });
    expect(Number((await R.one(`fleet.fleet_sweep_compute($1)`, [G.id])).rateBp)).toBe(base);
    expect((await R.econ(G, "sweep.reductions")).reductions[0]).toMatchObject({ status: "expired" });
  });

  it("the library ranks entries, always carries hard rules and flags unverified facts; regulated topics pull in their compliance entry", async () => {
    const r = await R.econ(G, "knowledge.library", { query: "sell templates on gumroad fees payout" });
    expect(r.ok).toBe(true);
    expect(r.entries[0].id).toBe("channel-gumroad");
    expect(r.entries[0].banner).toMatch(/VERIFY BEFORE RELYING/);
    expect(r.entries[0].hardRules.join(" ")).toMatch(/prohibits "Services"/);
    const reviews = await R.econ(G, "knowledge.library", { query: "ask customers for a testimonial" });
    expect(reviews.entries[0].id).toBe("legal-reviews-dmcc");
    const tax = await R.econ(G, "knowledge.library", { query: "write a guide about personal tax", limit: 3 });
    expect(tax.entries.map((e: any) => e.id)).toContain("legal-no-regulated-advice");
    const cat = await R.econ(G, "knowledge.library", { category: "unit-economics" });
    expect(cat.entries.length).toBe(KNOWLEDGE_LIBRARY_V1.entries.filter((e) => e.category === "unit-economics").length);
    expect((await R.econ(G, "knowledge.library", { id: "econ-stop-rules" })).entry.id).toBe("econ-stop-rules");
    // Versions are history; reloading an unchanged library loads nothing.
    expect((await R.one(`fleet.fleet_admin_knowledge_library_load($1::jsonb, $2)`, [JSON.stringify(KNOWLEDGE_LIBRARY_V1), OWNER])).loaded).toBe(0);
    expect(await R.code(R.q(`UPDATE fleet.fleet_knowledge_library SET body = 'x' WHERE entry_id = 'econ-stop-rules'`))).toBe("FLEET_HISTORY_IMMUTABLE");
  });

  it("shared knowledge and proposals never store personal data", async () => {
    const k = await R.econ(G, "knowledge.record", { topic: "channel", subject: "etsy buyers", claim:
      "Buyer jane.doe@example.com (07700 900123, card 4111 1111 1111 1111, LS1 1AA, GB33BUKB20201555555555, 20-20-15) asked for a UK edition", confidenceBp: 6000 });
    expect(k.ok, JSON.stringify(k)).toBe(true);
    const claim = (await R.q(`SELECT claim FROM fleet.fleet_economic_knowledge WHERE agent_id = $1 ORDER BY observed_at DESC LIMIT 1`, [G.id]))[0].claim as string;
    expect(claim).toBe("Buyer [email] ([phone], card [number], [postcode], [bank account], [sort code]) asked for a UK edition");
    const p = await R.gw.knowledgePropose(G.id, G.token, "customer", "Contact a@b.co for help", "Call +44 7700 900123");
    expect(p.ok, JSON.stringify(p)).toBe(true);
    const row = (await R.q(`SELECT title, content, content_sha256 FROM fleet.fleet_knowledge_proposals WHERE agent_id = $1`, [G.id]))[0];
    expect([row.title, row.content]).toEqual(["Contact [email] for help", "Call [phone]"]);
    expect(row.content_sha256).toBe(crypto.createHash("sha256").update("Call [phone]").digest("hex"));
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    expect((await R.one(`fleet.fleet_ledger_verify()`)).ok).toBe(true);
  });
});
