/**
 * F2-A schema v26 on an R28-shaped v25 registry (PostgreSQL).
 *
 * The v25 → v26 migration turns owner requests into ACTION-SCOPED EXTERNAL DEPENDENCIES and adds the controller's
 * DISCOVERY ALLOWANCE. This drives the real migration over a registry seeded through the v25 functions themselves —
 * including Founder 1's Gumroad record under its production id — and checks the data mapping, the autonomy invariants
 * (an open record is always one unavailable action of an exceptional kind; nothing else in the registry consults
 * dependency records), the privilege audit, doctor and the allowance (bounded, renewable, fail-closed).
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

const PG_BIN = findPgBin();
const OWNER = "operator:owner";
const GUMROAD = "62cbe1b7-8642-4bf4-a6a7-b41c1dcc09e3";
const GUMROAD_ACTION = "List the landlord compliance tracker on Gumroad (a Gumroad seller account needs a human identity/KYC)";
const SUBMITTED = "2026-09-26T16:28:10.793Z";
const EXCEPTIONS = "'human_identity','kyc','legal_signature','constitutional_change','non_delegable_credential'";
const OWNER_DEPENDENCY = /owner decides|owner approv|the owner can enable|ask the owner|awaiting (the )?owner|owner-enrolled|keep waiting|STALE|decision only the owner/i;
type Who = { id: string; token: string };

describe.skipIf(!PG_BIN)("F2-A schema v26 on an R28-shaped v25 registry (PostgreSQL)", () => {
  let pgc: EphemeralPg;
  let owner: pg.Pool;
  let store: PgFleetStore;
  let gw: PgAgentGateway;
  let ledger: PgLedgerAdmin;
  let genesis: PgGenesisAdmin;
  let F: Who = { id: "", token: "" };
  let G: Who = { id: "", token: "" };
  const ids: Record<string, string> = {};
  let before: Array<Record<string, unknown>> = [];
  const q = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;
  const code = (p: Promise<unknown>) => p.then(() => "OK", (e: Error) => /FLEET_[A-Z_]+|permission denied/.exec(e.message)?.[0] ?? e.message.slice(0, 100));
  const row = async (id: string) => (await q(`SELECT kind, action, blocks_action, status, category, decided_by, response, goal_ref, title FROM fleet.fleet_owner_requests WHERE request_id = $1`, [id]))[0];
  const equity = async (id: string) => Number((await q(`SELECT (fleet.fleet_agent_economics($1) ->> 'survivalEquity')::bigint AS e`, [id]))[0].e);
  const budgetFor = (eq: number) => Math.min(300, Math.floor((eq * 200) / 10_000));
  const allowance = async (who: Who) => (await gw.cognitionStatus(who.id, who.token)).discovery as Record<string, unknown>;
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
  }, 240_000);

  afterAll(async () => {
    await genesis?.close(); await ledger?.close(); await gw?.close(); await store?.close(); await owner?.end(); pgc?.stop();
  });

  it("migrate-check rolls back; migrate applies exactly v26, once; nothing is lost and every identity column is unchanged", async () => {
    expect(await store.migrateCheck()).toEqual({ currentVersion: 25, resultingVersion: 26, wouldApply: [26] });
    expect((await q(`SELECT to_regclass('fleet.fleet_discovery_policy') AS r`))[0].r).toBeNull(); // rolled back
    expect(await store.migrate()).toEqual([26]);
    expect(await store.migrate()).toEqual([]);
    gw = new PgAgentGateway({ connectionString: pgc.agentUrl });
    expect(await q(`SELECT request_id, agent_id, idempotency_key, category, goal_ref, title, detail, status, response, decided_by, decided_at, created_at, seq, source_kind, source_ref
                      FROM fleet.fleet_owner_requests WHERE status <> 'retired' ORDER BY seq`)).toEqual(before.filter((r) => r.request_id !== ids.channel && r.request_id !== ids.spend));
    expect((await store.auditPrivileges()).problems).toEqual([]);
    expect(await q(`SELECT to_regprocedure('fleet.api_owner_request_create(text,text,text,text,text,text,text,boolean)') IS NULL AS old_gone,
                           to_regprocedure('fleet.api_owner_request_create(text,text,text,text,text,text,text,text)') IS NOT NULL AS new_there,
                           to_regprocedure('fleet.fleet_owner_request_import(uuid,text,boolean,text,text)') IS NULL AS old_import_gone`)).toEqual([{ old_gone: true, new_there: true, old_import_gone: true }]);
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
      "fleet_owner_requests_overview", "fleet_owner_queue", "fleet_owner_requests_guard", "fleet_owner_request_json"]);
    expect(readers.length).toBeGreaterThan(0);
    expect(readers.filter((n) => !family.has(n))).toEqual([]);
    // In particular the spend, experiment, capability, cognition and lifecycle paths never consult it.
    for (const fn of ["api_spend_request", "api_capabilities", "api_cognition_status", "api_experiment_propose", "svc_cognition_authorize", "fleet_discovery_allowance"]) expect(readers).not.toContain(fn);
  });

  it("the privilege audit enforces the autonomy invariants (triggers, the open-is-exception CHECK, no writer of the discovery policy)", async () => {
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
    await q(`CREATE FUNCTION fleet.rogue_discovery() RETURNS void LANGUAGE sql AS $$ UPDATE fleet.fleet_discovery_policy SET max_daily_cents = 100000 $$`);
    await q(`CREATE FUNCTION fleet.rogue_dependency() RETURNS void LANGUAGE sql AS $$ UPDATE fleet.fleet_owner_requests SET response = 'x' WHERE false $$`);
    try {
      expect(await audit()).toEqual(expect.arrayContaining(["cognition surface: rogue_discovery writes a cognition control table", "cognition surface: rogue_dependency writes a cognition control table"]));
    } finally {
      await q(`DROP FUNCTION fleet.rogue_discovery()`);
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

  it("discovery allowance: constitutional defaults; bounded by equity and today's inference; a runway floor; disabled or missing policy fails closed", async () => {
    expect(await q(`SELECT enabled, daily_fraction_bp, max_daily_cents, min_runway_days, burn_window_days, updated_by FROM fleet.fleet_discovery_policy`))
      .toEqual([{ enabled: true, daily_fraction_bp: 200, max_daily_cents: 300, min_runway_days: 14, burn_window_days: 7, updated_by: "migration" }]);
    const eqF = await equity(F.id);
    const eqG = await equity(G.id);
    expect(eqF).toBeGreaterThan(0);
    expect(eqG).toBeGreaterThan(0);
    // Nothing spent yet: allowed, no runway figure (no burn).
    expect(await allowance(F)).toEqual({ allowed: true, budgetCents: budgetFor(eqF), spentTodayCents: 0, runwayDays: null, reason: "allowed" });
    // Today's inference (all of it, not only discovery) reaching the budget ends today's discovery.
    await charge(F, budgetFor(eqF));
    expect(await allowance(F)).toMatchObject({ allowed: false, budgetCents: budgetFor(eqF), spentTodayCents: budgetFor(eqF), reason: "today's discovery allowance is spent" });
    // Spend older than a day renews the allowance but still counts as burn: runway below the floor means revenue-first.
    await charge(G, eqG, "3 days");
    const g = await allowance(G);
    expect(g).toMatchObject({ allowed: false, spentTodayCents: 0, reason: "runway below the discovery floor: revenue-first" });
    expect(Number(g.runwayDays)).toBeCloseTo(7, 0); // equity ÷ (equity / 7 days)
    // The owner's constitutional switch, and its bounds.
    await q(`UPDATE fleet.fleet_discovery_policy SET enabled = false`);
    expect(await allowance(F)).toMatchObject({ allowed: false, reason: "discovery disabled by policy" });
    await q(`UPDATE fleet.fleet_discovery_policy SET enabled = true, max_daily_cents = 0`);
    expect(await allowance(F)).toMatchObject({ allowed: false, budgetCents: 0 }); // a zero budget is never "allowed"
    await q(`UPDATE fleet.fleet_discovery_policy SET max_daily_cents = 300`);
    await expect(q(`UPDATE fleet.fleet_discovery_policy SET daily_fraction_bp = 5000`)).rejects.toThrow(/check constraint/);
    expect(await code(q(`DELETE FROM fleet.fleet_discovery_policy`))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await code(q(`TRUNCATE fleet.fleet_discovery_policy`))).toBe("FLEET_HISTORY_IMMUTABLE");
    // Fail closed: without the policy row there is no allowance (NULL arithmetic must never read as "allowed").
    await q(`ALTER TABLE fleet.fleet_discovery_policy DISABLE TRIGGER fleet_discovery_policy_no_delete`);
    try {
      await q(`DELETE FROM fleet.fleet_discovery_policy`);
      expect(await allowance(F)).toEqual({ allowed: false, budgetCents: 0, spentTodayCents: 0, runwayDays: null, reason: "no discovery policy" });
    } finally {
      await q(`INSERT INTO fleet.fleet_discovery_policy (id) VALUES (1) ON CONFLICT DO NOTHING`);
      await q(`ALTER TABLE fleet.fleet_discovery_policy ENABLE TRIGGER fleet_discovery_policy_no_delete`);
    }
    expect((await store.auditPrivileges()).problems).toEqual([]);
    // The allowance grants nothing: the founder's capabilities and the four switches are as before.
    expect(await gw.capabilities(F.id, F.token)).toMatchObject({ ok: true, paymentExecutable: false, reproductionExecutable: false, experimentFinancialMode: "simulated" });
    expect(await q(`SELECT replication_enabled FROM fleet.fleet_state`)).toEqual([{ replication_enabled: false }]);
  });
});
