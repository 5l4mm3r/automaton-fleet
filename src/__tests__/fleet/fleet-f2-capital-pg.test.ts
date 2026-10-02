/**
 * F2 schema v30 — the capital engine (PostgreSQL): Fleet-capital requests decided deterministically by FleetController as
 * lender (APPROVE / PARTIAL_APPROVE / APPROVE_WITH_LIMITS / DEFER / REJECT, never the owner); execution envelopes as
 * bounded authority (purpose, single exposure, stop-loss, milestones, expiry, all from the ledger); Treasury sweeps from
 * realized net profit after tax only (never gross revenue, disabled until activated); relative cognition depth (the £20
 * line retired); experiments without an owner branch or nominal caps; the Hub and Doctor views.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";

const PG_BIN = findPgBin();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const ev = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "sales", observation: `evidence ${i}`, source: "https://example.test" }));

describe.skipIf(!PG_BIN)("F2 v30 capital engine, envelopes, sweeps, cognition depth, experiments, Hub (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let F: Founder;
  let G: Founder;
  let svc: pg.Pool;
  let rail = "";
  let vF = "";
  let payF = "";
  const acct = (who: Founder, cls: string) => `agent:${who.id}:${cls.slice(6)}`;
  const req = (who: Founder, venture: string, amount: number, extra: Record<string, unknown> = {}) => R.econ(who, "capital.request", {
    idempotencyKey: `cr:${crypto.randomUUID()}`, ventureKey: venture, purpose: "inventory for the validated product", amountMinor: amount,
    evidence: ev(3), expectedRevenueMinor: amount * 3, expectedNetMinor: amount, expectedPaybackDays: 30, downsideMinor: amount, confidenceBp: 7000, ...extra });
  const ingest = (ext: string, gross: number, venture: string) => svc.query(`SELECT fleet.svc_settlement_ingest($1, $2, 'sale', $3, 0, 'GBP', $4, now(), $5, NULL) AS r`,
    [rail, ext, gross, venture, sha(ext)]).then((r) => r.rows[0].r);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 20_000, treasuryCents: 1_000_000 });
    [F, G] = R.founders;
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2 });
    await R.store.grantServiceRole();
    const e = await R.one(`fleet.fleet_admin_legal_entity_add('Fleet Trading Ltd', 'GB', 'company', true, $1)`, [OWNER]);
    await R.one(`fleet.fleet_admin_tax_profile_set($1, '[{"taxKind":"profit","rateBp":2000}]'::jsonb, now() - interval '1 second', NULL, $2)`, [e.entity_id, OWNER]);
    rail = (await R.one(`fleet.fleet_admin_rail_add('simulated', 'sim', 'shared', NULL, ARRAY['receive_payments'], 'sim checkout', NULL, 'simulated', NULL, NULL, $1)`, [OWNER])).railId;
    for (const [who, key] of [[F, "planners"], [G, "posters"]] as const) {
      await R.econ(who, "venture.create", { key, model: "digital_product", offer: key, state: "selected", channels: ["direct"] });
      await R.econ(who, "rail.require", { ventureKey: key });
    }
    vF = (await R.q(`SELECT venture_id FROM fleet.fleet_ventures WHERE agent_id = $1`, [F.id]))[0].venture_id;
    payF = (await R.econ(F, "vendor.register", { vendorName: "Printer", category: "supplier", reference: "printer@supplier.example" })).destinationId;
  }, 240_000);
  afterAll(async () => { await svc?.end(); await R?.close(); });

  it("migrates with a clean privilege audit; no capital outcome, table or function routes to the owner", async () => {
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    const outcomes = (await R.q(`SELECT pg_get_constraintdef(k.oid) AS d FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
      WHERE c.relname = 'fleet_capital_decisions' AND k.contype = 'c'`)).map((x) => x.d).join(" ");
    expect(outcomes).toMatch(/APPROVE.*PARTIAL_APPROVE.*APPROVE_WITH_LIMITS.*DEFER.*REJECT/);
    expect(outcomes).toMatch(/decided_by = 'controller'/);
    const src = (await R.q(`SELECT p.prosrc AS s FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'fleet' AND p.proname = 'fleet_capital_decide'`))[0].s;
    expect(src).not.toMatch(/owner/i);
  });

  it("the privilege audit enforces the economy invariants: guards, the not-live rail pin, controller-only decisions, single writers, no bypass", async () => {
    const audit = async () => (await R.store.auditPrivileges()).problems;
    await R.q(`ALTER TABLE fleet.fleet_ventures DISABLE TRIGGER fleet_ventures_guard`);
    try { expect(await audit()).toContain("economy surface: trigger fleet_ventures.fleet_ventures_guard is missing or disabled"); }
    finally { await R.q(`ALTER TABLE fleet.fleet_ventures ENABLE TRIGGER fleet_ventures_guard`); }
    await R.q(`ALTER TABLE fleet.fleet_payment_rails DROP CONSTRAINT fleet_payment_rails_not_live`);
    try { expect(await audit()).toEqual(expect.arrayContaining([expect.stringMatching(/a payment rail could be live/)])); }
    finally { await R.q(`ALTER TABLE fleet.fleet_payment_rails ADD CONSTRAINT fleet_payment_rails_not_live CHECK (mode <> 'live')`); }
    await R.q(`CREATE FUNCTION fleet.rogue_settle() RETURNS void LANGUAGE sql AS $$ UPDATE fleet.fleet_external_transactions SET status = 'settled' WHERE false $$`);
    await R.q(`CREATE FUNCTION fleet.rogue_move() RETURNS text LANGUAGE sql AS $$ SELECT set_config('fleet.venture_move', 'x', true) $$`);
    try {
      expect(await audit()).toEqual(expect.arrayContaining(["economy surface: rogue_settle writes fleet_external_transactions",
        "economy surface: rogue_move references the venture state-machine guard"]));
    } finally { await R.q(`DROP FUNCTION fleet.rogue_settle(); DROP FUNCTION fleet.rogue_move();`); }
    expect(await audit()).toEqual([]);
  });

  it("APPROVE creates an envelope funded from the Treasury into restricted envelope capital; the agent's own cash is untouched", async () => {
    const t0 = await R.balance("fleet:treasury:unallocated");
    const cash0 = await R.balance(acct(F, "agent_cash"));
    const r = await req(F, "planners", 5_000, { milestones: [{ key: "first-sales", metric: "revenue_minor", target: 3000, trancheMinor: 0 }] });
    expect(r).toMatchObject({ ok: true, outcome: "APPROVE", approvedMinor: 5_000, envelope: { status: "active", position: { allocatedMinor: 5_000, availableMinor: 5_000 } } });
    expect(await R.balance("fleet:treasury:unallocated")).toBe(t0 - 5_000);
    expect(await R.balance(acct(F, "agent_envelope_cash"))).toBe(5_000);
    expect(await R.balance(acct(F, "agent_cash"))).toBe(cash0);
    // Envelope capital is restricted: an own-capital order can never reach it.
    const own = await R.gw.spendRequest(F.id, F.token, { idempotencyKey: `k:${crypto.randomUUID()}`, amountCents: cash0 + 1, category: "expense", destinationId: payF, purpose: "x" });
    expect(own).toMatchObject({ ok: false, custody: "INSUFFICIENT_OWN_CAPITAL" });
    // Replay is idempotent.
    const idem = `cr:${crypto.randomUUID()}`;
    const a = await R.econ(G, "capital.request", { idempotencyKey: idem, ventureKey: "posters", purpose: "p", amountMinor: 1000, evidence: ev(3), expectedRevenueMinor: 3000,
      expectedNetMinor: 1000, downsideMinor: 1000, confidenceBp: 8000 });
    expect(await R.econ(G, "capital.request", { idempotencyKey: idem, ventureKey: "posters", purpose: "p", amountMinor: 1000, evidence: ev(3), expectedRevenueMinor: 3000,
      expectedNetMinor: 1000, downsideMinor: 1000, confidenceBp: 8000 })).toMatchObject({ replayed: true, outcome: a.outcome });
  });

  it("the lender decision is deterministic and explained: REJECT negative value, DEFER thin evidence, PARTIAL above the request cap, LIMITS on low confidence", async () => {
    await R.q(`UPDATE fleet.fleet_capital_policy SET reapply_cooldown_s = 0`);
    expect(await req(G, "posters", 1000, { expectedNetMinor: -100 })).toMatchObject({ outcome: "REJECT", reasons: ["NEGATIVE_EXPECTED_VALUE"], wouldChange: expect.any(String) });
    expect(await req(G, "posters", 1000, { evidence: ev(1) })).toMatchObject({ outcome: "DEFER", reasons: ["MORE_EVIDENCE"] });
    // Above 10% of the Treasury: a first tranche (the larger of the alternative and the tranche share), the rest through milestones.
    const big = await req(G, "posters", 400_000, { alternativeMinor: 60_000, milestones: [{ key: "m1", metric: "revenue_minor", target: 1000, trancheMinor: 20_000 }] });
    expect(big).toMatchObject({ outcome: "PARTIAL_APPROVE", reasons: ["FIRST_TRANCHE"] });
    expect(big.approvedMinor).toBeLessThanOrEqual(100_000);
    const low = await req(G, "posters", 1000, { confidenceBp: 1000, expectedNetMinor: 5000 });
    expect(low).toMatchObject({ outcome: "APPROVE_WITH_LIMITS", reasons: ["LOW_CONFIDENCE"], envelope: { maxSingleBp: 5000 } });
    // Every decision records the policy version and its inputs.
    const d = await R.q(`SELECT policy_version, inputs FROM fleet.fleet_capital_decisions`);
    expect(d.every((x) => x.policy_version >= 1 && typeof x.inputs === "object")).toBe(true);
    // Agent concentration: G's outstanding Fleet capital caps further requests (DEFER, not the owner).
    await R.q(`UPDATE fleet.fleet_capital_policy SET max_agent_exposure_bp = 1`);
    try {
      expect(await req(G, "posters", 1000)).toMatchObject({ outcome: "DEFER", reasons: ["AGENT_CONCENTRATION"] });
    } finally { await R.q(`UPDATE fleet.fleet_capital_policy SET max_agent_exposure_bp = 2500`); }
  });

  it("envelopes are bounded authority: purpose, single exposure and availability are enforced; a release returns to the envelope", async () => {
    const env = (await R.econ(F, "envelope.list")).envelopes[0];
    const spend = (amount: number, category = "expense", idem = `k:${crypto.randomUUID()}`) => R.econ(F, "envelope.spend", { envelopeId: env.envelopeId, amountMinor: amount,
      category, destinationId: payF, purpose: "print run", idempotencyKey: idem });
    expect(await spend(100, "asset_acquisition")).toMatchObject({ ok: false, code: "FLEET_ENVELOPE_PURPOSE" });
    expect(await spend(5_001)).toMatchObject({ ok: false, code: "FLEET_ENVELOPE_EXHAUSTED" });
    const o = await spend(2_000);
    expect(o).toMatchObject({ ok: true, order: { status: "reserved" }, envelope: { position: { reservedMinor: 2_000, availableMinor: 3_000 } } });
    expect(await R.balance(acct(F, "agent_envelope_cash"))).toBe(3_000);
    // Cancelling releases back into the envelope (not into own cash).
    const cash = await R.balance(acct(F, "agent_cash"));
    await R.gw.spendCancel(F.id, F.token, o.order.orderId);
    expect(await R.balance(acct(F, "agent_envelope_cash"))).toBe(5_000);
    expect(await R.balance(acct(F, "agent_cash"))).toBe(cash);
    // Another agent's destination or a held agent: custody refusals.
    const payG = (await R.econ(G, "vendor.register", { vendorName: "G supplier", category: "supplier", reference: "g@supplier.example" })).destinationId;
    expect(await R.econ(F, "envelope.spend", { envelopeId: env.envelopeId, amountMinor: 10, destinationId: payG, purpose: "x", idempotencyKey: `k:${crypto.randomUUID()}` }))
      .toMatchObject({ ok: false, custody: "INVALID_DESTINATION" });
  });

  it("stop-loss freezes only that envelope and returns unspent capital to the Treasury; milestones release tranches from ledger facts", async () => {
    // Settle 3 000 of spend under a fresh small envelope so its loss reaches the maximum.
    await R.q(`UPDATE fleet.fleet_capital_policy SET reapply_cooldown_s = 0`);
    const r = await req(F, "planners", 4_000, { downsideMinor: 2_500 });
    const id = r.envelope.envelopeId;
    const o = await R.econ(F, "envelope.spend", { envelopeId: id, amountMinor: 3_000, destinationId: payF, purpose: "ads", idempotencyKey: `k:${crypto.randomUUID()}` });
    // Settlement (custody executor protocol) is pinned off; record the spend as settled through the owner path used by the ledger tests.
    const sj = (await R.q(`SELECT fleet.fleet_ledger_post('spend_settlement', $1, 'operator:owner', 'test settlement', 'owner', $2, $3::uuid, NULL, $4, NULL, now(),
      jsonb_build_array(jsonb_build_object('account', fleet.fleet_ledger_account($2, 'agent_expense'), 'side', 'D', 'amount', 3000),
                        jsonb_build_object('account', fleet.fleet_ledger_account($2, 'agent_reserved'), 'side', 'C', 'amount', 3000)))`,
      [`settle:${o.order.orderId}`, F.id, o.order.orderId, `ext:${crypto.randomUUID()}`]))[0].fleet_ledger_post;
    await R.q(`ALTER TABLE fleet.fleet_payment_orders DISABLE TRIGGER fleet_orders_guard`);
    await R.q(`UPDATE fleet.fleet_payment_orders SET status = 'settled', settlement_journal_id = $2, settled_cents = amount_cents WHERE order_id = $1`, [o.order.orderId, sj]);
    await R.q(`ALTER TABLE fleet.fleet_payment_orders ENABLE TRIGGER fleet_orders_guard`);
    const t0 = await R.balance("fleet:treasury:unallocated");
    const reap = (await svc.query(`SELECT fleet.svc_capital_reap(100) AS r`)).rows[0].r;
    expect(reap.changed).toBeGreaterThanOrEqual(1);
    const e = (await R.econ(F, "envelope.list", { all: true })).envelopes.find((x: { envelopeId: string }) => x.envelopeId === id);
    expect(e).toMatchObject({ status: "frozen", statusReason: expect.stringContaining("stop-loss") });
    expect(await R.balance("fleet:treasury:unallocated")).toBe(t0 + 1_000);
    // The other envelope is unaffected.
    expect((await R.econ(F, "envelope.list")).envelopes.length).toBe(1);
    // A milestone met on the ledger releases the next tranche of G's partial envelope automatically.
    const partial = (await R.econ(G, "envelope.list")).envelopes.find((x: { milestones: unknown[] }) => (x.milestones ?? []).length > 0);
    const before = partial.position.allocatedMinor;
    const vG = (await R.q(`SELECT venture_id FROM fleet.fleet_ventures WHERE agent_id = $1`, [G.id]))[0].venture_id;
    expect(await ingest(`g-sale-${crypto.randomUUID()}`, 1500, vG)).toMatchObject({ status: "settled" });
    await svc.query(`SELECT fleet.svc_capital_reap(100)`);
    const after = (await R.econ(G, "envelope.list")).envelopes.find((x: { envelopeId: string }) => x.envelopeId === partial.envelopeId);
    expect(after.position.allocatedMinor).toBe(before + 20_000);
    expect(after.milestones[0]).toMatchObject({ met: true });
  });

  it("sweeps take a share of realized net profit after tax — never gross revenue — at a curve FleetController sets; disabled until activated", async () => {
    // Revenue for F's venture through the rail: tax reserved automatically.
    await ingest(`f-sale-${crypto.randomUUID()}`, 10_000, vF);
    const c = await R.one(`fleet.fleet_sweep_compute($1)`, [F.id]);
    const eco = await R.one(`fleet.fleet_agent_economics($1)`, [F.id]);
    const tax = await R.balance(acct(F, "agent_tax_reserve"));
    expect(c.afterTaxUncontributedProfitMinor).toBe(Math.max(0, Number(eco.realizedNetProfit) - Number(eco.lifetimeContribution) - tax));
    expect(c.afterTaxUncontributedProfitMinor).toBeLessThan(Number(eco.externalCustomerRevenue));
    expect(c.rateBp).toBeLessThanOrEqual(7000);
    expect(await R.one(`fleet.fleet_sweep_execute($1, 'controller', $2)`, [F.id, `sw:${crypto.randomUUID()}`])).toMatchObject({ ok: false, code: "FLEET_SWEEP_DISABLED" });
    expect((await svc.query(`SELECT fleet.svc_sweep_run('2026-10') AS r`)).rows[0].r).toMatchObject({ enabled: false });
    await R.one(`fleet.fleet_admin_sweep_policy_set(true, NULL, NULL, NULL, NULL, NULL, $1)`, [OWNER]);
    try {
      const lfc0 = await R.balance("fleet:profit");
      const run = (await svc.query(`SELECT fleet.svc_sweep_run('2026-10') AS r`)).rows[0].r;
      expect(run).toMatchObject({ ok: true, enabled: true });
      const swept = await R.balance("fleet:profit") - lfc0;
      expect(swept).toBe(run.totalMinor);
      // Idempotent per period: a second run moves nothing.
      expect((await svc.query(`SELECT fleet.svc_sweep_run('2026-10') AS r`)).rows[0].r.totalMinor).toBe(0);
      expect(await R.balance("fleet:profit") - lfc0).toBe(swept);
      // Agents cannot set their rate: no agent operation touches the sweep policy.
      expect(await R.econ(F, "sweep.set", { rateBp: 0 })).toEqual({ ok: false, code: "FLEET_UNKNOWN_OPERATION" });
    } finally { await R.one(`fleet.fleet_admin_sweep_policy_set(false, NULL, NULL, NULL, NULL, NULL, $1)`, [OWNER]); }
  });

  it("cognition depth is relative: the same amount is major for a small wallet and ordinary for a large one; the £20 column is inert", async () => {
    const major = (who: Founder, amount: number) => R.one(`fleet.fleet_spend_is_major($1, $2)`, [who.id, amount]);
    await R.ledger.agentCapital({ agentId: G.id, amountCents: 500_000, mode: "grant", actor: OWNER });
    const small = Number((await R.one(`fleet.fleet_agent_economics($1)`, [F.id])).expensePurchasingCapacity);
    expect(await major(F, Math.ceil(small / 4))).toBe(true);
    expect(await major(G, Math.ceil(small / 4))).toBe(false);
    await R.q(`UPDATE fleet.fleet_cognition_routing SET major_spend_threshold_minor = 1`);
    expect(await major(G, Math.ceil(small / 4))).toBe(false);
    const src = (await R.q(`SELECT prosrc FROM pg_proc WHERE proname = 'svc_action_cognition_verify'`))[0].prosrc as string;
    expect(src).not.toMatch(/major_spend_threshold_minor/);
    expect(src).toMatch(/fleet_spend_is_major/);
  });

  it("experiments: no owner branch, no nominal ladder cap, no controller sizing of own capital (v31: custody only; irreversible = whole budget at risk)", async () => {
    const src = (await R.q(`SELECT prosrc FROM pg_proc WHERE proname = 'fleet_experiment_evaluate'`))[0].prosrc as string;
    expect(src).not.toMatch(/OWNER_DECISION_REQUIRED|decided by the owner|auto_cap_minor|hard_cap_minor/);
    expect(src).not.toMatch(/'partially_approved', 'code'|FLEET_EXPERIMENT_PARTIAL|survival headroom|approved_max_loss_minor/);
    expect(src).toMatch(/irreversible/);
  });

  it("Hub: overview, wallets, ventures, Treasury, rails, tax, capital, envelopes, opportunities, profit board, credentials and audit — never a secret", async () => {
    const hub = (s: string, a: Record<string, unknown> = {}) => R.one(`fleet.fleet_hub($1, $2::jsonb)`, [s, JSON.stringify(a)]);
    const o = await hub("overview");
    expect(o).toMatchObject({ currency: "GBP", sweepsEnabled: false, capitalEngineEnabled: true });
    expect(o.treasuryMinor).toBe(await R.balance("fleet:treasury:unallocated"));
    const agents = await hub("agents");
    expect(agents.map((x: { agentId: string }) => x.agentId).sort()).toEqual([F.id, G.id].sort());
    expect(agents[0].wallet).toHaveProperty("safeTransfer");
    expect((await hub("wallet", { agentId: F.id })).history.length).toBeGreaterThan(0);
    for (const s of ["ventures", "treasury", "rails", "tax", "capital", "envelopes", "opportunities", "profit", "dependencies", "credentials", "audit", "reconcile"]) {
      const v = await hub(s);
      expect(v).toBeDefined();
      expect(JSON.stringify(v)).not.toMatch(/vault:|sk_live|password|"reference":/);
    }
    expect((await hub("profit")).length).toBe(2);
  });

  it("Doctor economy health: the ledgers reconcile; envelope cash equals the envelopes' positions; rails are pinned not-live", async () => {
    const h = await R.one(`fleet.fleet_economy_health()`);
    const by = Object.fromEntries(h.findings.map((f: { code: string }) => [f.code, f]));
    expect(by.ENVELOPE_LEDGER).toMatchObject({ severity: "INFO", detail: { mismatchedAgents: 0 } });
    expect(by.RAILS_NOT_LIVE_PINNED.severity).toBe("INFO");
    expect(by.DEPENDENCIES_ACTION_SCOPED).toMatchObject({ severity: "INFO", detail: { violations: 0 } });
    expect(by.LEDGER_VERIFY.severity).toBe("INFO");
    expect(h.ok).toBe(true);
  });
});
