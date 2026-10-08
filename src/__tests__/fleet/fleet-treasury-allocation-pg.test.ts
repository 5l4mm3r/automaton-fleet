/**
 * Treasury sweep semantics (owner §2, V2.2 audit) — PostgreSQL.
 *
 * Three things that must not be confused:
 *  1. the Fleet Treasury's INTERNAL economic allocation (the sweep): realised after-tax net profit → a Lifetime Fleet
 *     Contribution on the ledger (agent cash → Treasury cash). Gated ONLY by the database policy row
 *     `fleet_sweep_policy.enabled`; run per period by `svc_sweep_run` / the hub command `economy-sweep-run`;
 *  2. REAL external payment-rail movement: payment orders executed by the custody executor, only with
 *     REAL_PAYMENTS_ENABLED=true AND a controller signer (and custody execution is constitutionally off in the registry);
 *  3. owner withdrawals (an owner instruction + reservation; external settlement is again (2)). OWNER_SWEEP_ENABLED is
 *     a host safety assertion (runtimes and the doctor refuse it on); no database function reads it.
 * So OWNER_SWEEP_ENABLED=false and REAL_PAYMENTS_ENABLED=false leave internal allocation intact, and internal
 * allocation never moves money externally. Each unit of realised profit is swept once (v42 fix of the v30 base).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { PgHubAdmin } from "../../fleet/hub/admin.js";
import { executeApprovedSpend } from "../../fleet/treasury/custody.js";
import { FLEET_SPEND_GATE, RealSpendBlockedError, assertRealSpendAllowed } from "../../fleet/spend-gate.js";

const PG_BIN = findPgBin();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

describe.skipIf(!PG_BIN)("Treasury sweep semantics: internal allocation vs external payments vs owner withdrawals (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let A: Founder, B: Founder, C: Founder;
  let svc: pg.Pool;
  let hub: PgHubAdmin;
  let rail = "";
  const acct = (who: Founder, cls: string) => `agent:${who.id}:${cls.slice(6)}`;
  const ok = async (p: Promise<Record<string, any>>) => { const r = await p; expect(r, JSON.stringify(r)).toMatchObject({ ok: true }); return r; };
  const count = async (table: string) => Number(await R.one(`(SELECT count(*) FROM fleet.${table})`));
  const venture = async (who: Founder, key: string) => {
    await ok(R.econ(who, "venture.create", { key, model: "software", offer: key, state: "selected", channels: ["direct"] }));
    await R.econ(who, "rail.require", { ventureKey: key });
  };
  const sell = async (who: Founder, key: string, gross: number) => {
    const vid = (await R.q(`SELECT venture_id FROM fleet.fleet_ventures WHERE agent_id = $1 AND venture_key = $2`, [who.id, key]))[0].venture_id;
    const ext = `sale:${crypto.randomUUID()}`;
    await svc.query(`SELECT fleet.svc_settlement_ingest($1, $2, 'sale', $3, 0, 'GBP', $4, now(), $5, NULL)`, [rail, ext, gross, vid, sha(ext)]);
  };
  const treasury = () => R.balance("fleet:treasury:unallocated");
  const external = async () => R.one(`(fleet.fleet_daily_report() -> 'flows')`);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 3, allocationCents: 1_000_000, treasuryCents: 10_000_000 });
    [A, B, C] = R.founders;
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2 });
    await R.store.grantServiceRole();
    hub = new PgHubAdmin({ connectionString: R.pgc.ownerUrl });
    const e = await R.one(`fleet.fleet_admin_legal_entity_add('Fleet Trading Ltd', 'GB', 'company', true, $1)`, [OWNER]);
    await R.one(`fleet.fleet_admin_tax_profile_set($1, '[{"taxKind":"profit","rateBp":2000}]'::jsonb, now() - interval '1 second', NULL, $2)`, [e.entity_id, OWNER]);
    rail = (await R.one(`fleet.fleet_admin_rail_add('simulated', 'sim', 'shared', NULL, ARRAY['receive_payments'], 'sim checkout', NULL, 'simulated', NULL, NULL, $1)`, [OWNER])).railId;
    for (const [who, key] of [[A, "a-v"], [B, "b-v"], [C, "c-v"]] as const) await venture(who, key);
  }, 300_000);
  afterAll(async () => { await hub?.close(); await svc?.end(); await R?.close(); });

  it("what enables internal allocation: only the database policy row (no host flag); while it is disabled the pass is a no-op", async () => {
    const src = (await R.q(`SELECT string_agg(p.prosrc, ' ') AS s FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'fleet'`))[0].s as string;
    expect(src).not.toMatch(/OWNER_SWEEP|REAL_PAYMENTS|ownerSweep|realPayments/); // no SQL path reads either host flag
    expect((await R.q(`SELECT enabled FROM fleet.fleet_sweep_policy WHERE id = 1`))[0].enabled).toBe(false);
    await sell(A, "a-v", 125_000);
    const t0 = await treasury();
    expect(await hub.sweepRun("2026-09")).toMatchObject({ ok: true, enabled: false });
    expect(await treasury()).toBe(t0);
  });

  it("the sweep is an INTERNAL ledger allocation: £1,000 at 10% → £100 Treasury contribution; no payment order, rail call, custody or owner instruction", async () => {
    await R.one(`fleet.fleet_admin_sweep_policy_set(true, NULL, NULL, NULL, NULL, NULL, $1)`, [OWNER]);
    const before = { orders: await count("fleet_payment_orders"), ext: await count("fleet_external_transactions"), instr: await count("fleet_admin_instructions"),
      journals: Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ledger_journal)`)) };
    const t0 = await treasury(), a0 = await R.balance(acct(A, "agent_cash")), flows0 = await external();
    expect(Number((await hub.sweepCompute(A.id) as any).afterTaxUncontributedProfitMinor)).toBe(100_000);
    const run = await hub.sweepRun("2026-10") as any;
    expect(run).toMatchObject({ ok: true, enabled: true, swept: 1, totalMinor: 10_000 });
    expect(await treasury()).toBe(t0 + 10_000);
    expect(await R.balance(acct(A, "agent_cash"))).toBe(a0 - 10_000);
    expect(await count("fleet_payment_orders")).toBe(before.orders);
    expect(await count("fleet_external_transactions")).toBe(before.ext);
    expect(await count("fleet_admin_instructions")).toBe(before.instr);
    const kinds = await R.q(`SELECT kind FROM fleet.fleet_ledger_journal ORDER BY seq DESC LIMIT 1`);
    expect(kinds[0].kind).toBe("profit_contribution");
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ledger_journal)`))).toBe(before.journals + 1);
    // External revenue is unchanged; only the profit-contribution flow moved.
    const flows = await external() as any;
    expect(flows.revenueMinor).toBe((flows0 as any).revenueMinor);
    expect(flows.profitContributionMinor - (flows0 as any).profitContributionMinor).toBe(10_000);
    expect(await R.one(`fleet.fleet_ledger_verify()`)).toMatchObject({ ok: true, unbalanced: 0 });
  });

  it("no double sweep: a retried period replays; a LATER period does not sweep the already-swept profit again; only new profit is swept", async () => {
    const t0 = await treasury();
    expect(await hub.sweepRun("2026-10")).toMatchObject({ swept: 0, totalMinor: 0 });          // same period: replay
    expect(await hub.sweepRun("2026-11")).toMatchObject({ swept: 0, totalMinor: 0 });          // the remaining £900 is post-sweep, not re-swept
    expect(await treasury()).toBe(t0);
    const c = await hub.sweepCompute(A.id) as any;
    expect(c).toMatchObject({ afterTaxUncontributedProfitMinor: 0, sweptBasisMinor: 100_000 });
    await sell(A, "a-v", 12_500);                                                               // +£100 realised after tax
    expect(await hub.sweepRun("2026-12")).toMatchObject({ swept: 1, totalMinor: 1_000 });      // 10% of the NEW profit only
    expect(await treasury()).toBe(t0 + 1_000);
    expect(await R.q(`SELECT basis_minor::int AS b, amount_minor::int AS a FROM fleet.fleet_sweep_records WHERE agent_id = $1 ORDER BY at`, [A.id]))
      .toEqual([{ b: 100_000, a: 10_000 }, { b: 10_000, a: 1_000 }]);
  });

  it("an interrupted allocation followed by a retry records exactly one sweep (atomic; idempotent per period and agent)", async () => {
    await sell(B, "b-v", 125_000);
    const t0 = await treasury();
    const c = await svc.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT fleet.svc_sweep_run('2027-01')`);
      await c.query("ROLLBACK");                                                                 // the pass dies before commit
    } finally { c.release(); }
    expect(await treasury()).toBe(t0);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_sweep_records WHERE agent_id = $1)`, [B.id]))).toBe(0);
    expect(await hub.sweepRun("2027-01")).toMatchObject({ swept: 1, totalMinor: 10_000 });
    expect(await hub.sweepRun("2027-01")).toMatchObject({ swept: 0 });
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_sweep_records WHERE agent_id = $1)`, [B.id]))).toBe(1);
    expect(await treasury()).toBe(t0 + 10_000);
  });

  it("OWNER_SWEEP_ENABLED=false (and REAL_PAYMENTS_ENABLED=false) do not disable internal Treasury accounting", async () => {
    const saved = { o: process.env.OWNER_SWEEP_ENABLED, p: process.env.REAL_PAYMENTS_ENABLED };
    process.env.OWNER_SWEEP_ENABLED = "false"; process.env.REAL_PAYMENTS_ENABLED = "false";
    try {
      await sell(C, "c-v", 125_000);
      const t0 = await treasury();
      expect(await hub.sweepRun("2027-02")).toMatchObject({ swept: 1, totalMinor: 10_000 });
      expect(await treasury()).toBe(t0 + 10_000);
    } finally {
      if (saved.o === undefined) delete process.env.OWNER_SWEEP_ENABLED; else process.env.OWNER_SWEEP_ENABLED = saved.o;
      if (saved.p === undefined) delete process.env.REAL_PAYMENTS_ENABLED; else process.env.REAL_PAYMENTS_ENABLED = saved.p;
    }
  });

  it("REAL_PAYMENTS_ENABLED=false still prohibits every external movement; custody execution is constitutionally off in the registry", async () => {
    let signed = 0;
    const signer = { send: async () => { signed++; return { txHash: "0x" + "1".repeat(64) }; } };
    const decision = { decision: "approved_not_executed" } as never;
    expect(await executeApprovedSpend(decision, { REAL_PAYMENTS_ENABLED: "false" }, signer as never)).toEqual({ executed: false, reason: "REAL_PAYMENTS_ENABLED=false" });
    expect(await executeApprovedSpend(decision, {}, signer as never)).toEqual({ executed: false, reason: "REAL_PAYMENTS_ENABLED=false" });
    expect(signed).toBe(0);
    expect(FLEET_SPEND_GATE.allows("credit_transfer")).toBe(false);
    expect(() => assertRealSpendAllowed("onchain_transaction")).toThrow(RealSpendBlockedError);
    // v48: custody execution changes only through an owner activation (none exists); a rail's mode is fixed; a live rail
    // is the owner's PayPal treasury only, with a credential reference (none here).
    expect(await R.code(R.q(`UPDATE fleet.fleet_economic_model SET custody_execution_enabled = true`))).toBe("FLEET_CUSTODY_ACTIVATION_REQUIRED");
    expect((await R.q(`SELECT custody_execution_enabled FROM fleet.fleet_economic_model`))[0].custody_execution_enabled).toBe(false);
    expect(await R.code(R.q(`UPDATE fleet.fleet_payment_rails SET mode = 'live'`))).toMatch(/fleet_payment_rails_live_scope|FLEET_IMMUTABLE|^OK$/);
    expect(await R.code(R.one(`fleet.fleet_admin_rail_add('paypal', 'x', 'shared', NULL, ARRAY['receive_payments'], 'x', NULL, 'live', NULL, NULL, $1)`, [OWNER])))
      .toMatch(/fleet_payment_rails_live_scope/);
  });

  it("post-sweep distributions are representable once the allocation is recorded: £900 split per contract, nothing swept twice", async () => {
    // A share-only project on a fresh venture of B; B's earlier profit is already swept.
    await venture(B, "b-team");
    const plan = {
      idempotencyKey: `prj:${crypto.randomUUID()}`, key: "b-team", ventureKey: "b-team", name: "B team", objective: "launch", expectedValueMinor: 50_000,
      expectedReturnMinor: 30_000, budgetMinor: 0, opportunityCostMinor: 0, timeValueMinorPerDay: 4_000, coordinationHours: 2, coordinationCostMinor: 500, risk: "low",
      qualityBenefitMinor: 45_000, forecast: { qualityReasoning: "the member brings the capability the lead lacks" },
      justification: { decomposition: "a, then b ∥ c", parallelism: "b and c in parallel", whyTeam: "capability", timeToRevenue: "at launch" },
      tasks: [{ key: "a", title: "A", ownerRole: "lead", hours: 8, deliverable: "a", acceptance: "a" },
              { key: "b", title: "B", ownerRole: "eng", hours: 20, deps: ["a"], deliverable: "b", acceptance: "b" },
              { key: "c", title: "C", ownerRole: "lead", hours: 18, deps: ["a"], deliverable: "c", acceptance: "c" }],
      roles: [{ role: "eng", taskScope: "b", requiredCapability: "backend", compensation: { type: "PROFIT_SHARE", profitShareBp: 3_000, profitShareUntil: inDays(90) } }],
    };
    const p = (await ok(R.econ(B, "project.propose", plan))).id;
    const m = (await ok(R.econ(B, "project.offer", { projectId: p, role: "eng", agentId: C.id, deliverable: "b", expectedHours: 20, deadline: inDays(5),
      compensation: { type: "PROFIT_SHARE", profitShareBp: 3_000, profitShareUntil: inDays(90) } }))).memberId;
    await ok(R.econ(C, "project.respond", { memberId: m, response: "ACCEPT" }));
    await sell(B, "b-team", 125_000);
    expect(await ok(R.econ(C, "project.distribute", { projectId: p }))).toMatchObject({ pendingProfitMinor: 100_000, paidNowMinor: 0 }); // before the allocation
    const t0 = await treasury();
    expect(await hub.sweepRun("2027-03")).toMatchObject({ totalMinor: 10_000 });
    expect(await treasury()).toBe(t0 + 10_000);
    const c0 = await R.balance(acct(C, "agent_cash"));
    const d = await ok(R.econ(C, "project.distribute", { projectId: p }));
    expect(d.tranche).toMatchObject({ profitMinor: 100_000, sweepAttributedMinor: 10_000, distributableMinor: 90_000, leadShareBp: 7_000, leadResidualMinor: 63_000 });
    expect(await R.balance(acct(C, "agent_cash"))).toBe(c0 + 27_000);
    // Neither the next period nor a replayed distribution sweeps or pays again.
    expect(await hub.sweepRun("2027-04")).toMatchObject({ totalMinor: 0 });
    expect(await ok(R.econ(B, "project.distribute", { projectId: p }))).toMatchObject({ paidNowMinor: 0, stillOwedMinor: 0 });
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_project_distributions WHERE project_id = $1)`, [p]))).toBe(1);
    expect(await R.one(`fleet.fleet_ledger_verify()`)).toMatchObject({ ok: true, unbalanced: 0 });
  });
});
