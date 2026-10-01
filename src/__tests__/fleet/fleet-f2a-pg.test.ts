/**
 * F2-A schemas v26 + v27 on an R28-shaped v25 registry (PostgreSQL).
 *
 * The v25 → v26 migration turns owner requests into ACTION-SCOPED EXTERNAL DEPENDENCIES and adds the survival
 * observation; v27 retires the owner spend route (a legacy `awaiting_owner` order seeded here through the v25 spend
 * function is cancelled, never decided, and locks no capital). This drives the real migrations over a registry seeded through the v25 functions themselves —
 * including Founder 1's Gumroad record under its production id — and checks the data mapping, the autonomy invariants
 * (an open record is always one unavailable action of an exceptional kind; nothing else in the registry consults
 * dependency records), the privilege audit, doctor and the survival observation (figures only: no ration, gate or runway shutdown).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import os from "os";
import pg from "pg";
import { PgFleetStore, hashAgentToken, mintAgentToken } from "../../fleet/postgres/store.js";
import { PgAgentGateway } from "../../fleet/postgres/agent-gateway.js";
import { PgLedgerAdmin } from "../../fleet/treasury/ledger.js";
import { PgGenesisAdmin } from "../../fleet/genesis/admin.js";
import { simulateRuntimeAttestation } from "../../fleet/genesis/simulate.js";
import { runDoctor } from "../../fleet/doctor.js";
import { dependencyLines, parseDependencies } from "../../fleet/founder/mind.js";
import { findPgBin, startEphemeralPg, type EphemeralPg } from "./fixtures/ephemeral-pg.js";
import { migrateUpTo } from "./fixtures/migrate-to.js";
import { wipeRegistry } from "./fixtures/wipe.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";

const PG_BIN = findPgBin();
const OWNER = "operator:owner";
const GUMROAD = "62cbe1b7-8642-4bf4-a6a7-b41c1dcc09e3";
const GUMROAD_ACTION = "List the landlord compliance tracker on Gumroad (a Gumroad seller account needs a human identity/KYC)";
const SUBMITTED = "2026-09-26T16:28:10.793Z";
const EXCEPTIONS = "'human_identity','kyc','legal_signature','constitutional_change','non_delegable_credential'";
const OWNER_DEPENDENCY = /owner decides|owner approv|the owner can enable|ask the owner|awaiting (the )?owner|owner-enrolled|keep waiting|STALE|decision only the owner/i;
type Who = { id: string; token: string };

describe.skipIf(!PG_BIN)("F2-A schemas v26 + v27 on an R28-shaped v25 registry (PostgreSQL)", () => {
  let pgc: EphemeralPg;
  let owner: pg.Pool;
  let su: pg.Pool;
  let store: PgFleetStore;
  let gw: PgAgentGateway;
  let ledger: PgLedgerAdmin;
  let genesis: PgGenesisAdmin;
  let F: Who = { id: "", token: "" };
  let G: Who = { id: "", token: "" };
  const ids: Record<string, string> = {};
  let payee = "";
  let legacyOrder = "";
  let cashBefore = 0;
  let before: Array<Record<string, unknown>> = [];
  const q = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;
  const code = (p: Promise<unknown>) => p.then(() => "OK", (e: Error) => /FLEET_[A-Z_]+|permission denied/.exec(e.message)?.[0] ?? e.message.slice(0, 100));
  const row = async (id: string) => (await q(`SELECT kind, action, blocks_action, status, category, decided_by, response, goal_ref, title FROM fleet.fleet_owner_requests WHERE request_id = $1`, [id]))[0];
  const equity = async (id: string) => Number((await q(`SELECT (fleet.fleet_agent_economics($1) ->> 'survivalEquity')::bigint AS e`, [id]))[0].e);
  const survival = async (who: Who) => (await gw.cognitionStatus(who.id, who.token)).survival as Record<string, unknown>;
  const charge = (who: Who, cents: number, ago = "0 seconds") => q(`INSERT INTO fleet.fleet_cognition_log (request_id, agent_id, provider, model, outcome, input_tokens, output_tokens,
      cost_microcents, charged_cents, prompt_sha256, response_sha256, charged_microcents, at)
    VALUES (gen_random_uuid(), $1, 'anthropic', 'm', 'ok', 1, 1, 0, $2, repeat('a', 64), repeat('b', 64), $2::bigint * 1000000, now() - $3::interval)`, [who.id, cents, ago]);

  beforeAll(async () => {
    pgc = await startEphemeralPg(PG_BIN!);
    owner = new pg.Pool({ connectionString: pgc.ownerUrl, max: 4 });
    // ── A v25 registry, as R28 left production (schema v25, F1-LIVE-01 owner requests).
    await migrateUpTo(pgc.ownerUrl, "fleet", 25);
    const c = await owner.connect();
    try { await c.query("BEGIN"); await wipeRegistry(c, "fleet"); await c.query("COMMIT"); } finally { c.release(); }
    store = new PgFleetStore({ connectionString: pgc.ownerUrl });
    ledger = new PgLedgerAdmin({ connectionString: pgc.ownerUrl });
    genesis = new PgGenesisAdmin({ connectionString: pgc.ownerUrl });
    // (PgFleetStore operates only on the current schema version, so the v25 registry's pins are set directly.)
    await q(`UPDATE fleet.fleet_state SET max_agents = 2, runtime_repo = $1, runtime_commit = $2, runtime_build_id = $3, runtime_lockfile_sha256 = $4`,
      ["https://github.com/5l4mm3r/automaton-fleet", "c".repeat(40), "d".repeat(64), "e".repeat(64)]);
    await genesis.setEnabled(true, OWNER, "test");
    await ledger.recordOwnerFunding(40_000, `bank:${crypto.randomUUID()}`, OWNER);
    await q(`UPDATE fleet.fleet_genesis_policy SET genesis_max_founders = 2`);
    const g = await genesis.propose({ idempotencyKey: `g:${crypto.randomUUID()}`, founderCount: 2, allocationCents: 5_000, ttlS: 3600, actor: OWNER });
    await genesis.approve(g.genesisId, g.authSha256, OWNER);
    const p = await genesis.provision(g.genesisId, OWNER);
    for (const id of p.founderIds!) await genesis.attest(g.genesisId, id, (await simulateRuntimeAttestation(genesis, genesis, g.genesisId, id, OWNER)).host, OWNER);
    await genesis.fund(g.genesisId, OWNER);
    const toks = p.founderIds!.map((id) => ({ id, token: mintAgentToken(id) }));
    await genesis.activateWithHashes(g.genesisId, g.authSha256, toks.map((t) => hashAgentToken(t.token)), OWNER);
    [F, G] = toks;
    // ── Seed through the v25 functions themselves (owner connection: the restricted roles get grants only at migrate()).
    const v25 = async (who: Who, category: string, title: string, blocking: boolean) =>
      ((await q(`SELECT fleet.api_owner_request_create($1, $2, $3, $4, $5, $6, $7, $8) AS r`, [who.id, who.token, `own:${crypto.randomUUID()}`, category, "g1", title, "detail", blocking]))[0].r as {
        ok: boolean; request: { requestId: string } }).request.requestId;
    ids.declined = await v25(F, "information", "Which channel may I use?", false);
    await q(`SELECT fleet.fleet_owner_request_decide($1::uuid, 'declined', 'No.', $2)`, [ids.declined, OWNER]);
    ids.withdrawn = await v25(F, "other", "Something else", false);
    await q(`SELECT fleet.api_owner_request_withdraw($1, $2, $3::uuid)`, [F.id, F.token, ids.withdrawn]);
    ids.answeredIdentity = await v25(F, "account_or_identity", "Open a seller account", true);
    await q(`SELECT fleet.fleet_owner_request_decide($1::uuid, 'answered', 'Done.', $2)`, [ids.answeredIdentity, OWNER]);
    ids.channel = await v25(F, "sales_channel", "Enable a Gumroad sales channel", true);
    ids.spend = await v25(F, "capital_or_spend", "Approve 2000p of ad spend", false);
    ids.identity = await v25(G, "account_or_identity", "Verify my identity for Stripe", false);
    ids.policy = await v25(G, "policy_exception", "Raise my research quota", true);
    // Founder 1's Gumroad knowledge proposal, under its production id and submission time, imported as in R28.
    const k = (await q(`SELECT fleet.api_knowledge_propose($1, $2, 'policy', $3, $4) AS r`, [F.id, F.token, "Owner request: enrol a Gumroad channel for zero-capex digital products",
      "Founder agent (goal g1) asks the owner to create/enrol a Gumroad seller account. First test product: a UK landlord compliance tracker spreadsheet, priced at £9."]))[0].r as { proposalId: string };
    await q(`ALTER TABLE fleet.fleet_knowledge_proposals DISABLE TRIGGER fleet_knowledge_proposals_guard`);
    await q(`UPDATE fleet.fleet_knowledge_proposals SET proposal_id = $2, submitted_at = $3 WHERE proposal_id = $1`, [k.proposalId, GUMROAD, SUBMITTED]);
    await q(`ALTER TABLE fleet.fleet_knowledge_proposals ENABLE TRIGGER fleet_knowledge_proposals_guard`);
    expect((await q(`SELECT fleet.fleet_owner_request_import($1::uuid, 'sales_channel', true, NULL, $2) AS r`, [GUMROAD, OWNER]))[0].r)
      .toMatchObject({ requestId: GUMROAD, category: "sales_channel", blocking: true, stale: true, status: "pending", goalRef: "g1" });
    before = await q(`SELECT request_id, agent_id, idempotency_key, category, goal_ref, title, detail, status, response, decided_by, decided_at, created_at, seq, source_kind, source_ref
                        FROM fleet.fleet_owner_requests ORDER BY seq`);
    expect(before).toHaveLength(8);
    // ── A legacy owner-route spend order (v25 policy: above the daily line → awaiting_owner), as v10–v26 produced them.
    su = new pg.Pool({ connectionString: pgc.superUrl.replace(/\/postgres$/, `/${pgc.dbname}`), max: 1 });
    const e = await ledger.enrollDestination({ kind: "payee", rail: "evm_usdc", label: "payee test", reference: `ref-${crypto.randomUUID()}`, hint: "***1234", agentId: null, actor: OWNER });
    const sc = await su.connect();
    try {
      await sc.query("SET session_replication_role = replica");
      await sc.query(`UPDATE fleet.fleet_payment_destinations SET activatable_at = now() - interval '1 second', enrolled_at = now() - interval '4 days' WHERE destination_id = $1`, [e.destinationId]);
    } finally {
      await sc.query("RESET session_replication_role").catch(() => {});
      sc.release();
    }
    await ledger.activateDestination(e.destinationId, e.activationCode, OWNER);
    payee = e.destinationId;
    await q(`UPDATE fleet.fleet_economic_model SET agent_daily_spend_cents = 1000`);
    cashBefore = Number((await q(`SELECT fleet.fleet_ledger_balance(fleet.fleet_ledger_account($1, 'agent_cash')) AS b`, [F.id]))[0].b);
    expect(cashBefore).toBeGreaterThanOrEqual(2000); // the founder's real cash account (its Genesis allocation)
    const legacy = (await q(`SELECT fleet.api_spend_request($1, $2, $3, 2000, 'expense', $4, 'checkout hosting', 0) AS r`, [F.id, F.token, `legacy:${crypto.randomUUID()}`, payee]))[0].r;
    expect(legacy).toMatchObject({ ok: true, order: { status: "awaiting_owner", decisionCode: "FLEET_OWNER_APPROVAL_REQUIRED" } });
    legacyOrder = legacy.order.orderId;
  }, 240_000);

  afterAll(async () => {
    await genesis?.close(); await ledger?.close(); await gw?.close(); await store?.close(); await su?.end(); await owner?.end(); pgc?.stop();
  });

  it("migrate-check rolls back; migrate applies exactly v26 and v27, once; nothing is lost and every identity column is unchanged", async () => {
    expect(await store.migrateCheck()).toEqual({ currentVersion: 25, resultingVersion: FLEET_PG_SCHEMA_VERSION, wouldApply: Array.from({ length: FLEET_PG_SCHEMA_VERSION - 26 + 1 }, (_, i) => 26 + i) });
    expect((await q(`SELECT to_regprocedure('fleet.fleet_survival_observation(text)') AS r`))[0].r).toBeNull(); // rolled back
    expect((await q(`SELECT status FROM fleet.fleet_payment_orders WHERE order_id = $1`, [legacyOrder]))[0].status).toBe("awaiting_owner"); // rolled back
    expect(await store.migrate()).toEqual(Array.from({ length: FLEET_PG_SCHEMA_VERSION - 25 }, (_, i) => 26 + i));
    expect(await store.migrate()).toEqual([]);
    gw = new PgAgentGateway({ connectionString: pgc.agentUrl });
    expect(await q(`SELECT request_id, agent_id, idempotency_key, category, goal_ref, title, detail, status, response, decided_by, decided_at, created_at, seq, source_kind, source_ref
                      FROM fleet.fleet_owner_requests WHERE status <> 'retired' ORDER BY seq`)).toEqual(before.filter((r) => r.request_id !== ids.channel && r.request_id !== ids.spend));
    expect((await store.auditPrivileges()).problems).toEqual([]);
    expect(await q(`SELECT to_regprocedure('fleet.api_owner_request_create(text,text,text,text,text,text,text,boolean)') IS NULL AS old_gone,
                           to_regprocedure('fleet.api_owner_request_create(text,text,text,text,text,text,text,text)') IS NOT NULL AS new_there,
                           to_regprocedure('fleet.fleet_owner_request_import(uuid,text,boolean,text,text)') IS NULL AS old_import_gone`)).toEqual([{ old_gone: true, new_there: true, old_import_gone: true }]);
  });

  it("v27: the legacy owner-route order is retired (cancelled, never decided), locks no capital, and the route is unreachable; the legacy lines are inert", async () => {
    expect((await q(`SELECT status, decision_code, decided_by, reservation_journal_id, release_journal_id FROM fleet.fleet_payment_orders WHERE order_id = $1`, [legacyOrder]))[0])
      .toEqual({ status: "cancelled", decision_code: "FLEET_OWNER_ROUTE_RETIRED", decided_by: "controller", reservation_journal_id: null, release_journal_id: null });
    expect(Number((await q(`SELECT fleet.fleet_ledger_balance(fleet.fleet_ledger_account($1, 'agent_cash')) AS b`, [F.id]))[0].b)).toBe(cashBefore);
    expect(await q(`SELECT actor, detail ->> 'code' AS code FROM fleet.fleet_events WHERE event_type = 'payment_order_cancelled' AND detail ->> 'orderId' = $1`, [legacyOrder]))
      .toEqual([{ actor: "migration", code: "FLEET_OWNER_ROUTE_RETIRED" }]);
    expect(await q(`SELECT count(*)::int AS n FROM fleet.fleet_payment_orders WHERE status = 'awaiting_owner'`)).toEqual([{ n: 0 }]);
    expect(await code(q(`SELECT fleet.fleet_admin_spend_decision($1::uuid, 'approve', $2, NULL, true)`, [legacyOrder, OWNER]))).toBe("FLEET_OWNER_ROUTE_RETIRED");
    // The legacy daily line is still set low (1000) from the seed, and the same founder's order of 2000 is now reserved on custody alone.
    expect((await q(`SELECT agent_daily_spend_cents FROM fleet.fleet_economic_model`))[0].agent_daily_spend_cents).toBe("1000");
    const fresh = await gw.spendRequest(F.id, F.token, { idempotencyKey: `fresh:${crypto.randomUUID()}`, amountCents: 2000, category: "expense", destinationId: payee, purpose: "checkout hosting" });
    expect(fresh).toMatchObject({ ok: true, order: { status: "reserved", decisionCode: "FLEET_CUSTODY_CLEARED", decidedBy: "controller" } });
    expect(await gw.spendCancel(F.id, F.token, (fresh.order as { orderId: string }).orderId)).toMatchObject({ ok: true, order: { status: "cancelled" } });
    expect(Number((await q(`SELECT fleet.fleet_ledger_balance(fleet.fleet_ledger_account($1, 'agent_cash')) AS b`, [F.id]))[0].b)).toBe(cashBefore);
    await q(`UPDATE fleet.fleet_economic_model SET agent_daily_spend_cents = 5000`);
  });

  it("Gumroad is re-scoped to its one action (kyc, still unresolved: nobody decided it); ordinary requests are retired; identity ones stay open", async () => {
    expect(await row(GUMROAD)).toMatchObject({ kind: "kyc", action: GUMROAD_ACTION, blocks_action: true, status: "pending", category: "sales_channel", decided_by: null, goal_ref: "g1" });
    expect(new Date((await q(`SELECT created_at FROM fleet.fleet_owner_requests WHERE request_id = $1`, [GUMROAD]))[0].created_at).toISOString()).toBe(SUBMITTED);
    for (const [id, title, blocks] of [[ids.channel, "Enable a Gumroad sales channel", true], [ids.spend, "Approve 2000p of ad spend", false]] as const) {
      expect(await row(id)).toMatchObject({ kind: "legacy_ordinary", action: title, status: "retired", decided_by: "migration", blocks_action: blocks,
        response: expect.stringMatching(/^Ordinary business decisions are the founder's own \(or FleetController's\): no owner decision is needed, and nothing waits on this\.$/) });
    }
    expect(await row(ids.identity)).toMatchObject({ kind: "kyc", action: "Verify my identity for Stripe", blocks_action: true, status: "pending", decided_by: null });
    expect(await row(ids.policy)).toMatchObject({ kind: "constitutional_change", action: "Raise my research quota", blocks_action: true, status: "pending" });
    // Decided history keeps its outcome; only kind/action are added.
    expect(await row(ids.declined)).toMatchObject({ kind: "legacy_ordinary", action: "Which channel may I use?", status: "declined", response: "No.", decided_by: OWNER });
    expect(await row(ids.withdrawn)).toMatchObject({ kind: "legacy_ordinary", status: "withdrawn", decided_by: F.id });
    expect(await row(ids.answeredIdentity)).toMatchObject({ kind: "kyc", status: "answered", response: "Done." });
    // The invariant holds for every row: an OPEN record is an exceptional kind and blocks exactly its action.
    expect(await q(`SELECT count(*)::int AS n FROM fleet.fleet_owner_requests WHERE status = 'pending' AND NOT (kind IN (${EXCEPTIONS}) AND blocks_action)`)).toEqual([{ n: 0 }]);
    // A retired (or any decided) record cannot be reopened into an owner queue item.
    expect(await code(q(`UPDATE fleet.fleet_owner_requests SET status = 'pending', decided_at = NULL, decided_by = NULL WHERE request_id = $1`, [ids.channel]))).toBe("FLEET_INVALID_STATE");
  });

  it("the founder sees Gumroad as one unavailable action (never blocking, never stale) and the retired requests as its own decisions", async () => {
    const list = await gw.ownerRequestList(F.id, F.token);
    const g = (list.requests as Array<Record<string, unknown>>).find((r) => r.requestId === GUMROAD)!;
    expect(g).toMatchObject({ kind: "kyc", action: GUMROAD_ACTION, blocksAction: true, blocking: false, stale: false, category: "sales_channel", status: "pending",
      source: { kind: "knowledge_proposal", ref: GUMROAD, importedBy: OWNER } });
    expect(g.staleAfterS).toBeUndefined();
    const lines = dependencyLines(parseDependencies(list)!);
    expect(lines[0]).toBe(`External dependency 62cbe1b7 (kyc): the action "${GUMROAD_ACTION}" is unavailable for now. This blocks only that action — not you, your goals or other work: pursue alternatives (another marketplace, direct sales that need no new account, another product, service, niche or venture).`);
    expect(lines.filter((l) => /\(legacy_ordinary\) for "(Enable a Gumroad sales channel|Approve 2000p of ad spend)": retired — ordinary business decisions are yours; nothing waits on it\.$/.test(l))).toHaveLength(2);
    for (const l of lines) expect(l).not.toMatch(OWNER_DEPENDENCY);
    // New records: ordinary business is refused; an identity need is one action, recorded without any owner step.
    for (const kind of ["sales_channel", "capital_or_spend", "information", "other", "legacy_ordinary"]) {
      expect(await gw.ownerRequestCreate(F.id, F.token, { idempotencyKey: `dep:${kind}`, kind, action: "a", goalRef: null, title: "t", detail: "d" })).toMatchObject({ ok: false, code: "FLEET_NOT_AN_EXCEPTION" });
    }
    const made = await gw.ownerRequestCreate(F.id, F.token, { idempotencyKey: "dep:etsy", kind: "kyc", action: "Open an Etsy shop", goalRef: "g1", title: "Etsy seller identity", detail: "Selling direct meanwhile." });
    expect(made).toMatchObject({ ok: true, request: { kind: "kyc", action: "Open an Etsy shop", blocksAction: true, status: "pending" } });
    expect(await gw.ownerRequestWithdraw(F.id, F.token, (made.request as { requestId: string }).requestId)).toMatchObject({ ok: true });
  });

  it("structural proof: nothing outside the dependency functions reads dependency records, so an open one can gate no other action", async () => {
    const readers = (await q(`SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                WHERE n.nspname = 'fleet' AND p.prosrc ~ 'fleet_owner_requests' ORDER BY 1`)).map((r) => r.name as string);
    const family = new Set(["api_owner_request_create", "api_owner_request_withdraw", "api_owner_request_list", "fleet_owner_request_decide", "fleet_owner_request_import",
      "fleet_owner_requests_overview", "fleet_owner_queue", "fleet_owner_requests_guard", "fleet_owner_request_json",
      // v29: PAYMENT_RAIL_REQUIRED records (and answers) the one action-scoped kyc dependency — a member of the family.
      "fleet_rail_resolve",
      // v30: read-only observability (the Hub's dependency list and Doctor's action-scoping check) — they gate nothing.
      "fleet_hub", "fleet_economy_health"]);
    expect(readers.length).toBeGreaterThan(0);
    expect(readers.filter((n) => !family.has(n))).toEqual([]);
    // In particular the spend, experiment, capability, cognition and lifecycle paths never consult it.
    for (const fn of ["api_spend_request", "api_capabilities", "api_cognition_status", "api_experiment_propose", "svc_cognition_authorize", "fleet_survival_observation",
      "api_economy", "fleet_capital_decide", "fleet_econ_envelope_spend", "fleet_venture_move", "svc_settlement_ingest"]) expect(readers).not.toContain(fn);
  });

  it("the privilege audit enforces the autonomy invariants (triggers, the open-is-exception CHECK, the dependency writers)", async () => {
    const audit = async () => (await store.auditPrivileges()).problems;
    await q(`ALTER TABLE fleet.fleet_owner_requests DISABLE TRIGGER fleet_owner_requests_guard`);
    try {
      expect(await audit()).toEqual(expect.arrayContaining(["autonomy: trigger fleet_owner_requests.fleet_owner_requests_guard is missing or disabled"]));
    } finally { await q(`ALTER TABLE fleet.fleet_owner_requests ENABLE TRIGGER fleet_owner_requests_guard`); }
    await q(`ALTER TABLE fleet.fleet_owner_requests DROP CONSTRAINT fleet_owner_requests_open_is_exception`);
    try {
      expect(await audit()).toEqual(expect.arrayContaining(["autonomy: an open dependency could be an ordinary owner decision (CHECK missing)"]));
    } finally {
      await q(`ALTER TABLE fleet.fleet_owner_requests ADD CONSTRAINT fleet_owner_requests_open_is_exception CHECK (status <> 'pending' OR (kind IN (${EXCEPTIONS}) AND blocks_action))`);
    }
    await q(`CREATE FUNCTION fleet.rogue_dependency() RETURNS void LANGUAGE sql AS $$ UPDATE fleet.fleet_owner_requests SET response = 'x' WHERE false $$`);
    try {
      expect(await audit()).toEqual(expect.arrayContaining(["cognition surface: rogue_dependency writes a cognition control table"]));
    } finally {
      await q(`DROP FUNCTION fleet.rogue_dependency()`);
    }
    expect(await audit()).toEqual([]);
  });

  it("doctor: open dependencies are information; only the open constitutional item WARNs, and resolving it clears the WARN", async () => {
    const dep = async () => (await runDoctor({ env: {}, store, paths: { cwd: os.tmpdir() }, serviceActive: async () => "inactive" } as never)).checks.find((c) => c.name === "external dependencies")!;
    let d = await dep();
    expect(d.status).toBe("warn");
    expect(d.detail).toMatch(/^3 open \(/);
    expect(d.detail).toMatch(/kyc 2/);
    expect(d.detail).toMatch(/constitutional_change 1/);
    expect(d.detail).toMatch(/: each makes one action unavailable; no founder is blocked; oldest \d+\.\d d; 1 constitutional change\(s\) for the owner — fleet:admin owner-queue$/);
    await genesis.decideOwnerRequest(ids.policy, "answered", "Research quotas are FleetController policy; no change now.", OWNER);
    d = await dep();
    expect(d).toMatchObject({ status: "pass", detail: expect.stringMatching(/^2 open \(kyc 2\): each makes one action unavailable; no founder is blocked; oldest \d+\.\d d$/) });
  });

  it("survival observation: the founder sees its equity, burn and runway; FleetController attaches no gate, ration, threshold or schedule to it", async () => {
    // No research policy, allowance or runway floor exists in the registry.
    expect(await q(`SELECT to_regclass('fleet.fleet_discovery_policy') AS t, to_regprocedure('fleet.fleet_discovery_allowance(text)') AS f`)).toEqual([{ t: null, f: null }]);
    const eqF = await equity(F.id);
    const eqG = await equity(G.id);
    expect(eqF).toBeGreaterThan(0);
    // Nothing spent yet: figures only, no runway (no burn), and no "allowed"/"reason" field at all.
    expect(await survival(F)).toEqual({ survivalEquityCents: eqF, inferenceTodayCents: 0, burnPerDayCents: 0, runwayDays: null, burnBasis: "inference, last 7 days" });
    // Today's inference shows as today's spend and as burn; nothing switches off.
    await charge(F, 300);
    expect(await survival(F)).toMatchObject({ inferenceTodayCents: 300, runwayDays: expect.any(Number) });
    expect(Number((await survival(F)).burnPerDayCents)).toBeCloseTo(300 / 7, 1);
    // A runway far below 14 days is reported as it is — the founder's own strategy decides what to do with it.
    await charge(G, eqG, "3 days");
    const g = await survival(G);
    expect(g).toMatchObject({ inferenceTodayCents: 0, survivalEquityCents: eqG });
    expect(Number(g.runwayDays)).toBeCloseTo(7, 0);
    expect(Object.keys(g).sort()).toEqual(["burnBasis", "burnPerDayCents", "inferenceTodayCents", "runwayDays", "survivalEquityCents"]);
    // The founder cannot call the observation directly (it reaches it through its own authenticated status).
    const agent = new pg.Pool({ connectionString: pgc.agentUrl, max: 1 });
    try { expect(await code(agent.query(`SELECT fleet.fleet_survival_observation($1)`, [F.id]))).toBe("permission denied"); } finally { await agent.end(); }
    expect((await store.auditPrivileges()).problems).toEqual([]);
    // The observation grants nothing: the founder's capabilities and the four switches are as before.
    expect(await gw.capabilities(F.id, F.token)).toMatchObject({ ok: true, paymentExecutable: false, reproductionExecutable: false, experimentFinancialMode: "simulated" });
    expect(await q(`SELECT replication_enabled FROM fleet.fleet_state`)).toEqual([{ replication_enabled: false }]);
  });
});
