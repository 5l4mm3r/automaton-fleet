/**
 * Schema v35 — the Fleet economy engine (PostgreSQL, end to end; no real money).
 *
 * Replication from FLEET-GENERATED Treasury wealth only (owner funding never counts): the £1k/£2k/£4k/£8k/… ladder, the
 * 24-hour health window and its reset, the high-water mark (a dip and recovery never re-triggers), births queued only
 * when every switch is on, the 50-living ceiling. Manual Admin birth and reseed. Temporary missions (stagnation
 * assignment against a real need, Admin assignment, 36/48 h and 7-day windows, marketing reviews, beneficiary-paid
 * costs, return to NORMAL). Recurring commitments and the advisory risk picture (≥50%/≥75% exposure: deeper reasoning,
 * never a veto). Admin transfers without an economic cap. Estate inventory, dead recurring costs stopped, reuse with
 * credential re-sealing. DAILY / AMBER / RED / IDENTITY notifications.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { auditPrivileges } from "../../fleet/postgres/privileges.js";

const PG_BIN = findPgBin();

describe.skipIf(!PG_BIN)("v35 Fleet economy engine (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let A: Founder;
  let B: Founder;
  let C: Founder;
  let svc: pg.Pool;
  let agentDb: pg.Pool;
  const ok = async (p: Promise<Record<string, any>>) => {
    const r = await p;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return r;
  };
  const key = (p: string) => `${p}:${crypto.randomUUID()}`;
  const cash = (who: Founder) => R.one<number>(`fleet.fleet_agent_cash($1)`, [who.id]).then(Number);
  const revenue = (agent: string, amount: number) => R.q(`SELECT fleet.fleet_admin_record_external('external_revenue', $1, $2, $3, $4, $5, $6)`,
    [agent, amount, `stripe:${crypto.randomUUID()}`, crypto.createHash("sha256").update(crypto.randomUUID()).digest("hex"), OWNER, key("rev")]);
  /** A controller-booked inference cost of an agent (a real agent_expense journal). */
  const expense = (agent: string, amount: number) => R.q(`SELECT fleet.fleet_ledger_post('inference_charge', $1, 'controller', 'test inference', 'controller', $2,
      NULL, NULL, NULL, NULL, now(), jsonb_build_array(jsonb_build_object('account', fleet.fleet_ledger_account($2, 'agent_expense'), 'side', 'D', 'amount', $3::bigint),
                                                      jsonb_build_object('account', fleet.fleet_ledger_account($2, 'agent_cash'), 'side', 'C', 'amount', $3::bigint)))`,
    [key("infer"), agent, amount]);
  const tick = async (switchOn: boolean) => (await svc.query(`SELECT fleet.svc_replication_tick($1) AS r`, [switchOn])).rows[0].r as Record<string, any>;
  const backdatePending = (hours: number) => R.q(`UPDATE fleet.fleet_replication_state SET pending_since = now() - make_interval(hours => $1) WHERE id = 1`, [hours]);
  const wealth = async () => Number((await R.one<any>(`fleet.fleet_generated_treasury_wealth()`)).fleetGeneratedMinor);
  /** Test-only: age an agent (the registry forbids rewriting created_at; the owner disables that guard for one statement). */
  const age = async (agent: string, days: number) => {
    const c = await R.owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("ALTER TABLE fleet.fleet_agents DISABLE TRIGGER USER");
      await c.query(`UPDATE fleet.fleet_agents SET created_at = now() - make_interval(days => $2) WHERE agent_id = $1`, [agent, days]);
      await c.query("ALTER TABLE fleet.fleet_agents ENABLE TRIGGER USER");
      await c.query("COMMIT");
    } finally { c.release(); }
  };

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 3, allocationCents: 10_000, treasuryCents: 1_000_000 });
    [A, B, C] = R.founders;
    await R.store.grantServiceRole();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2 });
    agentDb = new pg.Pool({ connectionString: R.pgc.agentUrl, max: 1 });
  }, 240_000);
  afterAll(async () => {
    await svc?.end(); await agentDb?.end(); await R?.close();
  });

  it("replication: owner funding never counts; the ladder; the 24 h window and its reset; switches; high-water mark", async () => {
    // The ladder: £1k, £2k, £4k, £8k, £12k, £16k, £20k, then +£4k per further agent.
    const ladder = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7, 8, 47].map((n) => R.one<string>(`fleet.fleet_replication_threshold($1)`, [n]).then(Number)));
    expect(ladder).toEqual([100_000, 200_000, 400_000, 800_000, 1_200_000, 1_600_000, 2_000_000, 2_400_000, 2_800_000, 18_400_000]); // n = 47 is agent 49: £20k + 41 × £4k

    // Owner funding (initial £10k and a further £5k) is never Fleet-generated wealth.
    expect(await wealth()).toBe(0);
    await R.ledger.recordOwnerFunding(500_000, `bank:${crypto.randomUUID()}`, OWNER);
    expect(await wealth()).toBe(0);
    expect((await tick(true)).phase).toBe("idle");

    // Realised customer revenue moved into the Treasury is. A transfer above the advised safe amount needs an
    // acknowledgement — never a cap.
    await revenue(A.id, 1_200_000);
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_wallet_transfer($1, 1100000, 'treasury', 'surplus', $2, $3)`, [A.id, OWNER, key("wt")]))).toBe("FLEET_ACKNOWLEDGE_REQUIRED");
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_wallet_transfer($1, 99999999, 'treasury', 'too much', $2, $3, true)`, [A.id, OWNER, key("wt")]))).toBe("FLEET_INSUFFICIENT_FUNDS");
    await R.q(`SELECT fleet.fleet_admin_wallet_transfer($1, 1100000, 'treasury', 'surplus', $2, $3, true)`, [A.id, OWNER, key("wt")]);
    expect(await wealth()).toBe(1_070_000);

    // Crossing a threshold makes replication PENDING, not a birth.
    let t = await tick(true);
    expect(t.phase).toBe("pending");
    expect(t.health.thresholdMinor).toBe(100_000);
    expect((await tick(true)).phase).toBe("pending");
    // The timer resets when health drops (an open RED), and restarts afresh.
    await backdatePending(20);
    await R.q(`SELECT fleet.fleet_notify('RED', 'TEST_RED', NULL, 'synthetic red', '{}'::jsonb, $1)`, [key("red")]);
    t = await tick(true);
    expect(t.phase).toBe("idle");
    expect(t.health.conditions.noOpenRed).toBe(false);
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_events WHERE event_type = 'replication_pending_reset'`))[0].n).toBe(1);
    const red = (await R.q(`SELECT notification_id FROM fleet.fleet_notifications WHERE code = 'TEST_RED'`))[0].notification_id;
    await R.q(`SELECT fleet.fleet_admin_notification_ack($1, $2)`, [red, OWNER]);
    expect((await tick(true)).phase).toBe("pending");
    const since = (await R.q(`SELECT pending_since FROM fleet.fleet_replication_state`))[0].pending_since as Date;
    expect(Date.now() - since.getTime()).toBeLessThan(60_000);

    // After 24 healthy hours: no capacity (3 living, cap 3) → waits; switches off → waits; neither consumes a threshold.
    await backdatePending(25);
    expect((await tick(true)).phase).toBe("ready_capacity");
    await R.q(`UPDATE fleet.fleet_state SET max_agents = 10`);
    expect((await tick(true)).phase).toBe("ready_disabled"); // policy autoBirthEnabled=false, registry switch off
    await R.q(`UPDATE fleet.fleet_state SET replication_enabled = true`);
    expect((await tick(true)).phase).toBe("ready_disabled");
    await R.q(`SELECT fleet.fleet_admin_replication_policy_set('{"autoBirthEnabled": true}'::jsonb, $1)`, [OWNER]);
    expect((await tick(false)).phase).toBe("ready_disabled"); // the service's REAL_REPLICATION_ENABLED
    expect((await R.q(`SELECT thresholds_consumed FROM fleet.fleet_replication_state`))[0].thresholds_consumed).toBe(0);
    t = await tick(true);
    expect(t.phase).toBe("birth_ordered");
    const order = (await R.q(`SELECT * FROM fleet.fleet_birth_orders WHERE order_id = $1`, [t.orderId]))[0];
    expect(order).toMatchObject({ kind: "automatic", status: "queued", threshold_minor: "100000", wealth_minor: "1070000" });
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_notifications WHERE code = 'AUTOMATIC_BIRTH'`))[0].n).toBe(1);

    // Agents 3, 4 and 5 (£2k, £4k, £8k) follow, each after its own full window; agent 6 needs £12k, which the Fleet lacks.
    for (const threshold of [200_000, 400_000, 800_000]) {
      t = await tick(true);
      expect(t.phase).toBe("pending");
      expect(t.health.thresholdMinor).toBe(threshold);
      await backdatePending(25);
      expect((await tick(true)).phase).toBe("birth_ordered");
    }
    t = await tick(true);
    expect(t.phase).toBe("idle");
    expect(t.health.thresholdMinor).toBe(1_200_000);
    // High-water mark: wealth dips below £8k and recovers — no second birth at £8k; the next trigger stays £12k.
    await R.q(`SELECT fleet.fleet_admin_agent_capital($1, 600000, 'grant', $2, 'test dip', true, $3)`, [B.id, OWNER, key("cap")]);
    expect(await wealth()).toBe(470_000);
    expect((await tick(true)).phase).toBe("idle");
    await R.q(`SELECT fleet.fleet_admin_wallet_transfer($1, 600000, 'treasury', 'recover', $2, $3, true)`, [B.id, OWNER, key("wt")]);
    expect(await wealth()).toBe(1_070_000);
    t = await tick(true);
    expect(t.phase).toBe("idle");
    expect(t.health.thresholdMinor).toBe(1_200_000);
    expect(await R.code(R.q(`UPDATE fleet.fleet_replication_state SET thresholds_consumed = 0`))).toBe("FLEET_IMMUTABLE");
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_birth_orders WHERE kind = 'automatic'`))[0].n).toBe(4);
    // The agent role cannot drive replication.
    expect(await R.code(agentDb.query(`SELECT fleet.svc_replication_tick(true)`))).toBe("permission denied");
    expect(await R.code(agentDb.query(`SELECT fleet.fleet_admin_birth('independent', 'x', 0, NULL, 'operator:owner', 'abcdefgh1')`))).toBe("permission denied");
  });

  it("manual Admin birth and reseed: an explicit override bounded only by the population ceiling and real Treasury cash", async () => {
    const pop = await R.one<any>(`fleet.fleet_population()`);
    const r = await R.one<any>(`fleet.fleet_admin_birth('marketing', 'the Fleet needs a marketer', 5000, NULL, $1, $2)`, [OWNER, key("birth")]);
    expect(r.ok).toBe(true);
    expect(r.population.queuedBirths).toBe(pop.queuedBirths + 1);
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_birth('independent', 'too rich', 999999999999, NULL, $1, $2)`, [OWNER, key("birth")]))).toBe("FLEET_TREASURY_INSUFFICIENT");
    // The ceiling counts living agents and queued births alike.
    const p2 = await R.one<any>(`fleet.fleet_population()`);
    await R.q(`UPDATE fleet.fleet_state SET max_agents = $1`, [p2.living + p2.queuedBirths]);
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_birth('independent', 'over the ceiling', 0, NULL, $1, $2)`, [OWNER, key("birth")]))).toBe("FLEET_CAP_EXCEEDED");
    await R.q(`SELECT fleet.fleet_admin_replication_policy_set('{"populationCeiling": 50}'::jsonb, $1)`, [OWNER]);
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_replication_policy_set('{"populationCeiling": 51}'::jsonb, $1)`, [OWNER]))).toMatch(/check constraint/);
    await R.q(`UPDATE fleet.fleet_state SET max_agents = 10`);
    // An agent is never an Admin; an existing agent cannot fulfil a new order; a queued order can be cancelled.
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_birth('independent', 'self', 0, NULL, $1, $2)`, [`operator:${A.id}`, key("birth")]))).toBe("FLEET_SELF_APPROVAL");
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_birth_fulfil($1, $2, $3)`, [r.orderId, A.id, OWNER]))).toBe("FLEET_BAD_REQUEST");
    await R.q(`SELECT fleet.fleet_admin_birth_cancel($1, 'test', $2)`, [r.orderId, OWNER]);
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_reseed($1, 'not dead', 0, $2, $3)`, [A.id, OWNER, key("reseed")]))).toBe("FLEET_BAD_REQUEST");
  });

  it("missions: stagnation meets a real need; windows; reviews; the beneficiary pays; return to NORMAL", async () => {
    expect((await ok(R.econ(C, "mission.status"))).mode).toBe("NORMAL");
    // No need, no mission: a stagnant agent is not given busywork.
    await R.q(`SELECT fleet.fleet_admin_mission_policy_set('{"stagnationDays": 3}'::jsonb, $1)`, [OWNER]);
    await age(C.id, 10);
    await age(A.id, 10);
    expect((await svc.query(`SELECT fleet.svc_mission_tick() AS r`)).rows[0].r.assigned).toBe(0);
    // B (earning) asks for marketing help for its own work. A earned recently (not stagnant); C never earned → C is assigned.
    await revenue(B.id, 50_000);
    const req = await ok(R.econ(B, "mission.request", { kind: "marketing", brief: "promote my storefront launch" }));
    expect((await svc.query(`SELECT fleet.svc_mission_tick() AS r`)).rows[0].r.assigned).toBe(1);
    expect((await ok(R.econ(A, "mission.status"))).mode).toBe("NORMAL");
    const st = await ok(R.econ(C, "mission.status"));
    expect(st.mode).toBe("MARKETING");
    expect(st.mission.request_id).toBe(req.requestId);
    expect(new Date(st.mission.hard_end_at).getTime() - new Date(st.mission.started_at).getTime()).toBe(7 * 86_400_000);
    // Reviews: by the beneficiary; an effective review continues; the mission's costs are paid by B when it ends.
    await expense(C.id, 3_000);
    const mid = st.mission.mission_id;
    expect((await ok(R.econ(B, "mission.review", { missionId: mid, effective: true, note: "traffic up 40%" }))).continues).toBe(true);
    const bBefore = await cash(B);
    const cBefore = await cash(C);
    const end = await ok(R.econ(B, "mission.review", { missionId: mid, effective: false, note: "no conversions after day two" }));
    expect(end.ended).toMatchObject({ status: "terminated", costMinor: 3000, rechargedMinor: 3000, returnedTo: "NORMAL" });
    expect(await cash(B)).toBe(bBefore - 3000);
    expect(await cash(C)).toBe(cBefore + 3000);
    expect((await ok(R.econ(C, "mission.status"))).mode).toBe("NORMAL");
    // Admin assigns a knowledge mission (36 h target, 48 h max); the agent reports knowledge into the Fleet and completes.
    const k = await R.one<any>(`fleet.fleet_admin_mission_assign($1, 'knowledge_data', 'map UK print-on-demand suppliers', NULL, $2)`, [C.id, OWNER]);
    const km = (await R.q(`SELECT * FROM fleet.fleet_agent_missions WHERE mission_id = $1`, [k.missionId]))[0];
    expect(km.target_end_at.getTime() - km.started_at.getTime()).toBe(36 * 3_600_000);
    expect(km.hard_end_at.getTime() - km.started_at.getTime()).toBe(48 * 3_600_000);
    const rep = await ok(R.econ(C, "mission.report", { outcome: "three suppliers mapped", complete: true,
      knowledge: [{ topic: "manufacturer", subject: "uk/pod-suppliers", claim: "three UK POD suppliers ship in 48h at under 6 GBP per unit" }] }));
    expect(rep.knowledgeRecorded).toBe(1);
    expect(rep.ended.status).toBe("completed");
    // The whole Fleet sees it (fleet-shared knowledge compounds).
    const kb = await ok(R.econ(B, "knowledge.search", { query: "pod-suppliers" }));
    expect(kb.knowledge[0]).toMatchObject({ own: false, fleetShared: true });
    // A mission past its hard end expires on the controller pass.
    const k2 = await R.one<any>(`fleet.fleet_admin_mission_assign($1, 'opportunity_hunt', 'find a niche', NULL, $2)`, [C.id, OWNER]);
    await R.q(`UPDATE fleet.fleet_agent_missions SET started_at = now() - interval '49 hours', target_end_at = now() - interval '13 hours', hard_end_at = now() - interval '1 hour' WHERE mission_id = $1`, [k2.missionId]);
    expect((await svc.query(`SELECT fleet.svc_mission_tick() AS r`)).rows[0].r.expired).toBe(1);
    expect((await ok(R.econ(C, "mission.status"))).mode).toBe("NORMAL");
    // A stranger cannot review someone else's mission.
    const k3 = await R.one<any>(`fleet.fleet_admin_mission_assign($1, 'marketing', 'promote the Fleet', NULL, $2)`, [C.id, OWNER]);
    expect((await R.econ(B, "mission.review", { missionId: k3.missionId, effective: false, note: "x" })).code).toBe("FLEET_MISSION_SCOPE");
    await R.q(`SELECT fleet.fleet_admin_mission_end($1, 'done', $2)`, [k3.missionId, OWNER]);
  });

  it("commitments and risk: the agent's own decisions; exposure deepens reasoning and reports AMBER, never vetoes", async () => {
    const c = await ok(R.econ(B, "commitment.add", { vendor: "hosting.example", description: "VPS for the storefront", amountMinor: 1_500, period: "monthly", idempotencyKey: key("c") }));
    expect(c.risk.monthlyCommitmentsMinor).toBe(1500);
    const again = await ok(R.econ(B, "commitment.add", { vendor: "hosting.example", description: "VPS", amountMinor: 1_500, period: "monthly", idempotencyKey: "replay-key-1" }));
    expect((await ok(R.econ(B, "commitment.add", { vendor: "hosting.example", description: "VPS", amountMinor: 1_500, period: "monthly", idempotencyKey: "replay-key-1" }))).replay).toBe(true);
    await ok(R.econ(B, "commitment.cancel", { commitmentId: again.commitmentId, reason: "duplicate" }));
    expect((await ok(R.econ(B, "commitment.list"))).commitments).toHaveLength(1);
    expect((await R.econ(A, "commitment.cancel", { commitmentId: c.commitmentId })).code).toBe("FLEET_COMMITMENT_NONE");
    // Exposure tiers.
    const value = Number((await ok(R.econ(B, "risk.assess"))).risk.valueMinor);
    const half = await ok(R.econ(B, "risk.assess", { amountMinor: Math.ceil(value * 0.55) }));
    expect(half.risk.exposureTier).toBe("deep");
    const most = await ok(R.econ(B, "risk.assess", { amountMinor: Math.ceil(value * 0.8) }));
    expect(most.risk.exposureTier).toBe("deepest");
    expect(most.risk.guidance).toMatch(/your decision/i);
    expect(most.risk.vulnerable).toBe(true); // young business
    expect(Number(most.risk.redZoneCushionMinor)).toBeGreaterThanOrEqual(0);
    // A real high-exposure reservation is reported AMBER (informational) — the spend itself is not refused here.
    const before = (await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_notifications WHERE code = 'HIGH_EXPOSURE_SPEND'`))[0].n;
    const big = Math.ceil(Number(await cash(B)) * 0.9);
    await R.q(`SELECT fleet.fleet_ledger_post('spend_reservation', $1, 'controller', 'test reservation', 'controller', $2, NULL, NULL, NULL, NULL, now(),
      jsonb_build_array(jsonb_build_object('account', fleet.fleet_ledger_account($2, 'agent_reserved'), 'side', 'D', 'amount', $3::bigint),
                        jsonb_build_object('account', fleet.fleet_ledger_account($2, 'agent_cash'), 'side', 'C', 'amount', $3::bigint)))`, [key("res"), B.id, big]);
    await svc.query(`SELECT fleet.svc_notify_tick()`);
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_notifications WHERE code = 'HIGH_EXPOSURE_SPEND'`))[0].n).toBe(before + 1);
  });

  it("Admin transfers: agent → agent and agent → Treasury beyond the advice with acknowledgement; real balances only; audited", async () => {
    await revenue(A.id, 40_000);
    const aCash = await cash(A);
    const bCash = await cash(B);
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_agent_transfer($1, $2, $3, 'rebalance', $4, $5, false)`, [A.id, B.id, aCash, OWNER, key("at")]))).toBe("FLEET_ACKNOWLEDGE_REQUIRED");
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_agent_transfer($1, $2, $3, 'rebalance', $4, $5, true)`, [A.id, B.id, aCash + 1, OWNER, key("at")]))).toBe("FLEET_INSUFFICIENT_FUNDS");
    const idem = key("at");
    const r = await R.one<any>(`fleet.fleet_admin_agent_transfer($1, $2, $3, 'rebalance', $4, $5, true)`, [A.id, B.id, aCash, OWNER, idem]);
    expect(r.ok).toBe(true);
    expect((await R.one<any>(`fleet.fleet_admin_agent_transfer($1, $2, $3, 'rebalance', $4, $5, true)`, [A.id, B.id, aCash, OWNER, idem])).replay).toBe(true);
    expect(await cash(A)).toBe(0);
    expect(await cash(B)).toBe(bCash + aCash);
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_events WHERE event_type = 'agent_transfer'`))[0].n).toBe(1);
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_agent_transfer($1, $2, 1, 'x', $3, $4, true)`, [B.id, A.id, `operator:${B.id}`, key("at")]))).toBe("FLEET_SELF_APPROVAL");
    expect(await R.code(agentDb.query(`SELECT fleet.fleet_admin_agent_transfer($1, $2, 1, 'x', 'operator:owner', 'abcdefgh2', true)`, [B.id, A.id]))).toBe("permission denied");
    // Give A some cash back for the estate test.
    await R.q(`SELECT fleet.fleet_admin_agent_transfer($1, $2, 20000, 'back', $3, $4, true)`, [B.id, A.id, OWNER, key("at")]);
    const ledger = await R.one<any>(`fleet.fleet_ledger_verify()`);
    expect(ledger.ok).toBe(true);
  });

  it("estate: inventory at death, dead recurring costs stop, reuse with a credential re-seal job, capacity pruning", async () => {
    // A owns a persona, a domain account with a renewal commitment, and knowledge; then dies.
    const persona = await ok(R.econ(A, "identity.create", { displayName: "Maya Hart", kind: "persona" }));
    const dom = await ok(R.econ(A, "account.create", { platform: "sim-registrar", kind: "domain", handle: "maya-hart-shop.example", idempotencyKey: key("acct") }));
    const used = await ok(R.econ(A, "account.create", { platform: "sim-store", kind: "storefront", handle: "mayahart", idempotencyKey: key("acct") }));
    await R.q(`UPDATE fleet.fleet_agent_accounts SET status = 'active', verification = 'email_verified' WHERE account_id = $1`, [used.accountId]);
    await R.q(`INSERT INTO fleet.fleet_agent_account_credentials (credential_id, account_id, agent_id, kind, vault_ref) VALUES (gen_random_uuid(), $1, $2, 'password', $3)`,
      [used.accountId, A.id, `avault:${crypto.randomUUID()}`]);
    await ok(R.econ(A, "commitment.add", { vendor: "registrar.example", description: "domain renewal", amountMinor: 1200, period: "yearly",
      accountId: dom.accountId, nextDueAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), idempotencyKey: key("c") }));
    await ok(R.econ(A, "knowledge.record", { topic: "channel", subject: "sim-store/listing", claim: "listings with three photos convert twice as often" }));
    await R.store.markDead(A.id, "test death", "test", "reported");
    const e = (await svc.query(`SELECT fleet.svc_estate_tick(20) AS r`)).rows[0].r;
    expect(e.inventoried).toBeGreaterThanOrEqual(4);
    expect(e.commitmentsStopped).toBe(1);
    expect(e.released).toBe(1); // the unused domain is released at renewal
    const items = (await R.q(`SELECT kind, ref_id, status FROM fleet.fleet_estate_items WHERE origin_agent_id = $1`, [A.id]));
    expect(items.find((i) => i.ref_id === dom.accountId)?.status).toBe("released");
    expect((await R.q(`SELECT kind FROM fleet.fleet_identity_jobs WHERE account_id = $1 AND kind = 'account.close'`, [dom.accountId]))).toHaveLength(1);
    expect((await svc.query(`SELECT fleet.svc_estate_tick(20) AS r`)).rows[0].r.inventoried).toBe(0); // idempotent
    // B finds and claims the storefront: ownership moves and the broker is asked to re-seal its credentials.
    const found = await ok(R.econ(B, "estate.search", { kind: "account" }));
    const store = found.items.find((i: any) => i.title.includes("sim-store"));
    expect(store.transferable).toBe(true);
    const claim = await ok(R.econ(B, "estate.claim", { itemId: store.itemId, reason: "reuse an established storefront instead of opening a new one" }));
    expect(claim.credentialRebindJob).toBeTruthy();
    expect((await R.q(`SELECT agent_id FROM fleet.fleet_agent_accounts WHERE account_id = $1`, [used.accountId]))[0].agent_id).toBe(B.id);
    expect((await R.q(`SELECT kind, agent_id, params FROM fleet.fleet_identity_jobs WHERE job_id = $1`, [claim.credentialRebindJob]))[0])
      .toMatchObject({ kind: "credential.rebind", agent_id: B.id, params: { fromAgent: A.id } });
    expect((await R.econ(B, "estate.claim", { itemId: store.itemId, reason: "again" })).code).toBe("FLEET_ESTATE_UNAVAILABLE");
    const kn = items.find((i) => i.kind === "knowledge");
    if (kn) {
      const id = (await R.q(`SELECT item_id FROM fleet.fleet_estate_items WHERE kind = 'knowledge' AND ref_id = $1`, [kn.ref_id]))[0].item_id;
      expect((await R.econ(B, "estate.claim", { itemId: id, reason: "x" })).code).toBe("FLEET_ESTATE_NOT_TRANSFERABLE");
    }
    // Ownership changes only through the estate path.
    expect(await R.code(R.q(`UPDATE fleet.fleet_agent_identities SET agent_id = $1 WHERE identity_id = $2`, [B.id, persona.identity.identity_id]))).toBe("FLEET_IMMUTABLE");
    // Admin reassigns the persona to B.
    const pItem = (await R.q(`SELECT item_id FROM fleet.fleet_estate_items WHERE kind = 'identity' AND ref_id = $1`, [persona.identity.identity_id]))[0].item_id;
    await R.q(`SELECT fleet.fleet_admin_estate_assign($1, $2, $3)`, [pItem, B.id, OWNER]);
    expect((await R.q(`SELECT agent_id FROM fleet.fleet_agent_identities WHERE identity_id = $1`, [persona.identity.identity_id]))[0].agent_id).toBe(B.id);
    // Capacity: shrink it; the least valuable unprotected knowledge is pruned first; protected items are kept.
    await R.q(`UPDATE fleet.fleet_estate_policy SET capacity_bytes = 1`);
    await R.q(`INSERT INTO fleet.fleet_estate_items (origin_agent_id, kind, ref_id, title, size_bytes, value_score) VALUES ($1, 'data', 'junk-1', 'old scrape', 5000, 5), ($1, 'data', 'gold-1', 'customer list', 5000, 90)`, [A.id]);
    const pr = (await svc.query(`SELECT fleet.svc_estate_tick(20) AS r`)).rows[0].r;
    expect(pr.pruned).toBeGreaterThanOrEqual(1);
    const st = Object.fromEntries((await R.q(`SELECT ref_id, status FROM fleet.fleet_estate_items WHERE ref_id IN ('junk-1','gold-1')`)).map((x) => [x.ref_id, x.status]));
    expect(st).toEqual({ "junk-1": "pruned", "gold-1": "held" });
  });

  it("notifications: DAILY once a day, IDENTITY per human-only action, RED on a tripped breaker; reports only", async () => {
    await R.q(`UPDATE fleet.fleet_notification_policy SET daily_hour_utc = 0`);
    await svc.query(`SELECT fleet.svc_notify_tick()`);
    await svc.query(`SELECT fleet.svc_notify_tick()`);
    const daily = await R.q(`SELECT detail FROM fleet.fleet_notifications WHERE class = 'DAILY'`);
    expect(daily).toHaveLength(1);
    expect(daily[0].detail).toHaveProperty("treasury.fleetGeneratedMinor");
    expect(daily[0].detail).toHaveProperty("replication.nextThresholdMinor");
    await R.q(`INSERT INTO fleet.fleet_owner_requests (request_id, agent_id, idempotency_key, kind, action, title, detail, blocks_action)
      VALUES (gen_random_uuid(), $1, $2, 'human_identity', 'account.verify_identity sim-liveness', 'Live selfie needed for sim-liveness', 'liveness', true)`, [B.id, key("dep")]);
    await svc.query(`SELECT fleet.svc_notify_tick()`);
    await svc.query(`SELECT fleet.svc_notify_tick()`);
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_notifications WHERE class = 'IDENTITY'`))[0].n).toBe(1);
    await R.q(`UPDATE fleet.fleet_spend_circuit_breaker SET tripped = true, trip_reason = 'synthetic credential compromise'`);
    await svc.query(`SELECT fleet.svc_notify_tick()`);
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_notifications WHERE class = 'RED' AND code = 'BREAKER_TRIPPED'`))[0].n).toBe(1);
    await R.q(`UPDATE fleet.fleet_spend_circuit_breaker SET tripped = false, trip_reason = NULL`);
    const list = await R.one<any>(`fleet.fleet_admin_notifications(50, true)`);
    expect(list.unacknowledged.IDENTITY).toBe(1);
    // Agents read none of it; the notification store is append-only.
    expect(await R.code(agentDb.query(`SELECT * FROM fleet.fleet_notifications`))).toBe("permission denied");
    expect(await R.code(R.q(`DELETE FROM fleet.fleet_notifications`))).toBe("FLEET_HISTORY_IMMUTABLE");
  });

  it("the privilege audit passes with the v35 surface", async () => {
    expect((await auditPrivileges(R.owner, { schema: "fleet" })).problems).toEqual([]);
  });
});
