/**
 * F1-LIVE-01 → F2-A (schema v26) — external dependencies (PostgreSQL).
 *
 * v25 let a founder ask the owner for a decision and made an unanswered "blocking" request STALE (doctor WARN). F2-A
 * (v26) turns those records into ACTION-SCOPED EXTERNAL DEPENDENCIES: only an action that needs a human or legal
 * identity (or a Fleet constitutional change) can be recorded; it makes that one action unavailable and never blocks the
 * founder; nothing escalates over time; ordinary business is refused as "not an exception". A resolution still grants
 * nothing. (Founder side: fleet-f2a-autonomy.test.ts; the v25 → v26 data migration: fleet-f2a-pg.test.ts.)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { PgFleetStore, hashAgentToken, mintAgentToken } from "../../fleet/postgres/store.js";
import { PgAgentGateway } from "../../fleet/postgres/agent-gateway.js";
import { PgLedgerAdmin } from "../../fleet/treasury/ledger.js";
import { PgGenesisAdmin } from "../../fleet/genesis/admin.js";
import { simulateRuntimeAttestation } from "../../fleet/genesis/simulate.js";
import { runDoctor } from "../../fleet/doctor.js";
import { capabilityView } from "../../fleet/cognition/capability-signature.js";
import { FleetService } from "../../fleet/service/server.js";
import { FleetApiClient } from "../../fleet/service/client.js";
import { UnsupportedSandboxTerminator } from "../../fleet/service/terminator.js";
import { findPgBin, startEphemeralPg, type EphemeralPg } from "./fixtures/ephemeral-pg.js";
import { wipeRegistry } from "./fixtures/wipe.js";
import { runGenesisCommand } from "../../fleet/genesis/cli.js";
import { FounderMind, MAX_IDLE_SKIP, type MindPorts } from "../../fleet/founder/mind.js";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { FOUNDER_MANIFEST_V2 } from "../../fleet/capabilities.js";

const PG_BIN = findPgBin();
const OWNER = "operator:owner";
type Who = { id: string; token: string };
/** Founder-facing words that teach dependency on the owner (F2 design §3/§17). */
const OWNER_DEPENDENCY = /owner decides|owner approv|the owner can enable|ask the owner|awaiting (the )?owner|owner-enrolled|keep waiting|STALE|decision only the owner/i;

describe.skipIf(!PG_BIN)("F2-A external dependencies (schema v26, PostgreSQL)", () => {
  let pgc: EphemeralPg;
  let owner: pg.Pool;
  let store: PgFleetStore;
  let gw: PgAgentGateway;
  let ledger: PgLedgerAdmin;
  let genesis: PgGenesisAdmin;
  let F: Who = { id: "", token: "" };
  let G: Who = { id: "", token: "" };
  const q = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;
  const code = (p: Promise<unknown>) => p.then(() => "OK", (e: Error) => /FLEET_[A-Z_]+|permission denied/.exec(e.message)?.[0] ?? e.message.slice(0, 100));
  const create = (who: Who, o: Record<string, unknown> = {}) => gw.ownerRequestCreate(who.id, who.token, {
    idempotencyKey: `dep:${crypto.randomUUID()}`, kind: "kyc", action: "List the tracker on Gumroad", goalRef: "g1", title: "Gumroad seller account",
    detail: "A Gumroad seller account needs a human identity; selling directly meanwhile.", ...o } as never);
  const idOf = (r: Record<string, unknown>) => (r.request as { requestId: string }).requestId;
  /** Backdate a record (owner, with its guard off for the test only) to simulate time passing. */
  const age = async (id: string, s: number) => {
    await q(`ALTER TABLE fleet.fleet_owner_requests DISABLE TRIGGER fleet_owner_requests_guard`);
    await q(`UPDATE fleet.fleet_owner_requests SET created_at = now() - make_interval(secs => $2) WHERE request_id = $1`, [id, s]);
    await q(`ALTER TABLE fleet.fleet_owner_requests ENABLE TRIGGER fleet_owner_requests_guard`);
  };
  /** The registry's survival equity for a founder, and the discovery budget the v26 policy defaults derive from it. */
  const equity = async (id: string) => Number((await q(`SELECT (fleet.fleet_agent_economics($1) ->> 'survivalEquity')::bigint AS e`, [id]))[0].e);
  const budgetFor = (eq: number) => Math.min(300, Math.floor((eq * 200) / 10_000));
  const doctorLines = async () => (await runDoctor({ env: {}, store, paths: { cwd: os.tmpdir() }, serviceActive: async () => "inactive" } as never)).checks
    .filter((c) => c.name === "external dependencies" || c.name === "institutional knowledge");

  beforeAll(async () => {
    pgc = await startEphemeralPg(PG_BIN!);
    owner = new pg.Pool({ connectionString: pgc.ownerUrl, max: 4 });
    store = new PgFleetStore({ connectionString: pgc.ownerUrl });
    await store.migrate();
    gw = new PgAgentGateway({ connectionString: pgc.agentUrl });
    ledger = new PgLedgerAdmin({ connectionString: pgc.ownerUrl });
    genesis = new PgGenesisAdmin({ connectionString: pgc.ownerUrl });
    const c = await owner.connect();
    try { await c.query("BEGIN"); await wipeRegistry(c, "fleet"); await c.query("COMMIT"); } finally { c.release(); }
    await store.setApprovedRuntime({ repo: "https://github.com/5l4mm3r/automaton-fleet", commit: "c".repeat(40) }, "test", { buildId: "d".repeat(64), lockfileSha256: "e".repeat(64) });
    await store.setMaxAgents(2, "test");
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
  }, 180_000);

  afterAll(async () => {
    await genesis?.close(); await ledger?.close(); await gw?.close(); await store?.close(); await owner?.end(); pgc?.stop();
  });

  it("migrates to v26 with a clean privilege audit; founders get exactly create / withdraw / list, nothing to decide", async () => {
    expect((await q(`SELECT max(version)::int AS v FROM fleet.fleet_schema_migrations`))[0].v).toBe(26);
    expect((await store.auditPrivileges()).problems).toEqual([]);
    const agent = new pg.Pool({ connectionString: pgc.agentUrl, max: 1 });
    try {
      expect(await code(agent.query(`SELECT fleet.fleet_owner_request_decide(gen_random_uuid(), 'approved', 'x', 'operator:owner')`))).toBe("permission denied");
      expect(await code(agent.query(`SELECT * FROM fleet.fleet_owner_requests`))).toBe("permission denied");
      expect(await code(agent.query(`SELECT fleet.fleet_owner_queue(true)`))).toBe("permission denied");
      expect(await code(agent.query(`SELECT * FROM fleet.fleet_discovery_policy`))).toBe("permission denied");
      expect(await code(agent.query(`SELECT fleet.fleet_discovery_allowance($1)`, [F.id]))).toBe("permission denied");
    } finally { await agent.end(); }
    // The v25 signatures are gone (a founder cannot mark a goal blocked; the owner cannot import by category).
    expect(await q(`SELECT to_regprocedure('fleet.api_owner_request_create(text,text,text,text,text,text,text,boolean)') AS a,
                           to_regprocedure('fleet.fleet_owner_request_import(uuid,text,boolean,text,text)') AS b`)).toEqual([{ a: null, b: null }]);
  });

  it("create: only identity/legal/constitutional kinds, scoped to one action; validated, idempotent, bounded (5 open, 10/day), scrubbed; own only", async () => {
    // Ordinary business is never an owner dependency: refused before anything is stored.
    for (const kind of ["sales_channel", "capital_or_spend", "information", "other", "niche", "product", "marketing", "pivot", "experiment", "spending", "capital", null]) {
      expect(await create(F, { kind }), String(kind)).toMatchObject({ ok: false, code: "FLEET_NOT_AN_EXCEPTION", reason: expect.stringMatching(/are yours or FleetController's/) });
    }
    expect(await q(`SELECT count(*)::int AS n FROM fleet.fleet_owner_requests`)).toEqual([{ n: 0 }]);
    const idem = `dep:${crypto.randomUUID()}`;
    const a = await create(F, { idempotencyKey: idem });
    expect(a).toMatchObject({ ok: true, note: expect.stringMatching(/only this action is unavailable\. Keep working/),
      request: { status: "pending", kind: "kyc", action: "List the tracker on Gumroad", goalRef: "g1", blocksAction: true, blocking: false, stale: false, category: "kyc" } });
    expect((a.request as Record<string, unknown>).staleAfterS).toBeUndefined();
    expect(await create(F, { idempotencyKey: idem, title: "changed" })).toMatchObject({ ok: true, replayed: true, request: { requestId: idOf(a), title: "Gumroad seller account" } });
    for (const bad of [{ goalRef: "goal-1" }, { title: "" }, { action: "" }, { action: "x".repeat(201) }, { detail: "x".repeat(2001) }]) {
      expect(await create(F, bad), JSON.stringify(bad)).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
    }
    const leak = await create(F, { title: "Use postgres://u:secret@host/db", action: "Sign in with postgres://u:secret@host/db", detail: `key 0x${"ab".repeat(32)}` });
    expect(JSON.stringify(leak)).not.toMatch(/secret@|abababab/);
    for (const kind of ["human_identity", "legal_signature", "non_delegable_credential"]) expect(await create(F, { kind })).toMatchObject({ ok: true, request: { kind } });
    expect(await create(F)).toMatchObject({ ok: false, code: "FLEET_LIMIT_REACHED", reason: expect.stringMatching(/at most 5 open dependencies/) });
    const mine = await gw.ownerRequestList(F.id, F.token);
    expect((mine.requests as unknown[]).length).toBe(5);
    expect(await gw.ownerRequestList(G.id, G.token)).toMatchObject({ ok: true, requests: [] });
    expect(await gw.ownerRequestWithdraw(G.id, G.token, idOf(a))).toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    expect(await create(F, { idempotencyKey: idem })).toMatchObject({ ok: true, replayed: true }); // replay is never limited
    expect((await q(`SELECT detail FROM fleet.fleet_events WHERE event_type = 'external_dependency_recorded' ORDER BY id LIMIT 1`))[0].detail)
      .toMatchObject({ requestId: idOf(a), kind: "kyc", goalRef: "g1" });
    // Clean up for the next tests: the founder withdraws its own (its own decision; no owner involved).
    for (const r of mine.requests as Array<{ requestId: string }>) expect(await gw.ownerRequestWithdraw(F.id, F.token, r.requestId)).toMatchObject({ ok: true, request: { status: "withdrawn" } });
    expect(await gw.ownerRequestWithdraw(F.id, F.token, idOf(a))).toMatchObject({ ok: false, code: "FLEET_INVALID_STATE" });
    // Rate limit: 10 created per day (5 so far + 5 more), the 11th is refused even with nothing open.
    for (let i = 0; i < 5; i++) { const r = await create(F); await gw.ownerRequestWithdraw(F.id, F.token, idOf(r)); }
    expect(await create(F)).toMatchObject({ ok: false, code: "FLEET_RATE_LIMITED" });
    await q(`ALTER TABLE fleet.fleet_owner_requests DISABLE TRIGGER fleet_owner_requests_guard`);
    await q(`UPDATE fleet.fleet_owner_requests SET created_at = now() - interval '2 days' WHERE agent_id = $1`, [F.id]);
    await q(`ALTER TABLE fleet.fleet_owner_requests ENABLE TRIGGER fleet_owner_requests_guard`);
  });

  it("only the owner resolves (rare, identity-only); the answer reaches the founder; it is final, immutable and grants nothing", async () => {
    const before = await q(`SELECT (SELECT count(*) FROM fleet.fleet_payment_orders) AS o, (SELECT count(*) FROM fleet.fleet_org_identity_claims) AS c,
                                   (SELECT count(*) FROM fleet.fleet_ledger_journal) AS j, (SELECT to_jsonb(m) FROM fleet.fleet_capability_manifests m WHERE manifest_id = 'founder-v2') AS m`);
    const r = await create(F);
    const id = idOf(r);
    expect(await code(genesis.decideOwnerRequest(id, "approved", null, "owner"))).toBe("FLEET_APPROVAL_REQUIRED");
    expect(await code(genesis.decideOwnerRequest(id, "answered", "  ", OWNER))).toBe("FLEET_BAD_REQUEST");
    const d = await genesis.decideOwnerRequest(id, "declined", "No Gumroad identity this month.", OWNER);
    expect(d).toMatchObject({ status: "declined", decidedBy: OWNER, agentId: F.id, blocksAction: false, note: expect.stringMatching(/grants no capability/) });
    expect(await code(genesis.decideOwnerRequest(id, "approved", null, OWNER))).toBe("FLEET_INVALID_STATE");
    expect(await code(q(`UPDATE fleet.fleet_owner_requests SET title = 'x' WHERE request_id = $1`, [id]))).toMatch(/FLEET_INVALID_STATE|FLEET_IMMUTABLE/);
    expect(await code(q(`DELETE FROM fleet.fleet_owner_requests WHERE request_id = $1`, [id]))).toBe("FLEET_IMMUTABLE");
    const seen = (await gw.ownerRequestList(F.id, F.token)).requests as Array<Record<string, unknown>>;
    expect(seen.find((x) => x.requestId === id)).toMatchObject({ status: "declined", response: "No Gumroad identity this month.", stale: false, blocking: false });
    // An approval changes nothing else: no order, claim, journal or manifest change.
    const r2 = await create(F, { kind: "human_identity" });
    await genesis.decideOwnerRequest(idOf(r2), "approved", null, OWNER);
    expect(await q(`SELECT (SELECT count(*) FROM fleet.fleet_payment_orders) AS o, (SELECT count(*) FROM fleet.fleet_org_identity_claims) AS c,
                           (SELECT count(*) FROM fleet.fleet_ledger_journal) AS j, (SELECT to_jsonb(m) FROM fleet.fleet_capability_manifests m WHERE manifest_id = 'founder-v2') AS m`)).toEqual(before);
    expect((await q(`SELECT event_type FROM fleet.fleet_events WHERE event_type LIKE 'owner_request_%' ORDER BY id DESC LIMIT 1`))[0].event_type).toBe("owner_request_decided");
    // The registry itself refuses an open record of an ordinary kind, or one that does not block exactly its action.
    for (const [kind, blocks] of [["legacy_ordinary", true], ["kyc", false]] as const) {
      await expect(q(`INSERT INTO fleet.fleet_owner_requests (request_id, agent_id, idempotency_key, kind, action, title, detail, blocks_action)
        VALUES (gen_random_uuid(), $1, $2, $3, 'a', 't', 'd', $4)`, [F.id, `raw:${kind}`, kind, blocks])).rejects.toThrow(/fleet_owner_requests_open_is_exception/);
    }
    await expect(q(`INSERT INTO fleet.fleet_owner_requests (request_id, agent_id, idempotency_key, kind, action, title, detail, blocks_action)
      VALUES (gen_random_uuid(), $1, 'raw:sales', 'sales_channel', 'a', 't', 'd', true)`, [F.id])).rejects.toThrow(/fleet_owner_requests_kind_check/);
  });

  it("no staleness: an open dependency days old is not stale and never a WARN; only a constitutional item asks the owner to look", async () => {
    const r = await create(F);
    const id = idOf(r);
    let lines = await doctorLines();
    expect(lines.find((c) => c.name === "external dependencies")).toMatchObject({ status: "pass", detail: expect.stringMatching(/^1 open \(kyc 1\): each makes one action unavailable; no founder is blocked; oldest 0\.0 d$/) });
    await age(id, 5 * 86_400);
    const list = (await gw.ownerRequestList(F.id, F.token)).requests as Array<Record<string, unknown>>;
    expect(list.find((x) => x.requestId === id)).toMatchObject({ status: "pending", stale: false, blocking: false, blocksAction: true });
    expect(Number(list.find((x) => x.requestId === id)!.ageS)).toBeGreaterThanOrEqual(5 * 86_400);
    // An unreviewed knowledge proposal is fleet knowledge, never a founder's blocker: it does not WARN either.
    expect((await gw.knowledgePropose(F.id, F.token, "policy", "Owner request: enrol a Gumroad channel", "Please enable a channel."))).toMatchObject({ ok: true });
    await q(`ALTER TABLE fleet.fleet_knowledge_proposals DISABLE TRIGGER fleet_knowledge_proposals_guard`);
    await q(`UPDATE fleet.fleet_knowledge_proposals SET submitted_at = now() - interval '5 days'`);
    await q(`ALTER TABLE fleet.fleet_knowledge_proposals ENABLE TRIGGER fleet_knowledge_proposals_guard`);
    lines = await doctorLines();
    expect(lines.find((c) => c.name === "external dependencies")).toMatchObject({ status: "pass", detail: expect.stringMatching(/^1 open \(kyc 1\): each makes one action unavailable; no founder is blocked; oldest 5\.0 d$/) });
    expect(lines.find((c) => c.name === "institutional knowledge")).toMatchObject({ status: "pass", detail: expect.stringMatching(/1 proposal\(s\) for review; nothing waits on them/) });
    for (const c of lines) expect(c.detail).not.toMatch(/blocking|unanswered|STALE/);
    // A constitutional change is the one thing the owner is asked to look at (still not a founder blocker).
    const k = await create(G, { kind: "constitutional_change", action: "Raise the discovery allowance ceiling", goalRef: null });
    lines = await doctorLines();
    const dep = lines.find((c) => c.name === "external dependencies")!;
    expect(dep).toMatchObject({ status: "warn" });
    expect(dep.detail).toMatch(/^2 open \(/);
    expect(dep.detail).toMatch(/kyc 1/);
    expect(dep.detail).toMatch(/constitutional_change 1/);
    expect(dep.detail).toMatch(/no founder is blocked; oldest 5\.0 d; 1 constitutional change\(s\) for the owner — fleet:admin owner-queue$/);
    // The owner's queue lists open records oldest first; none is stale.
    const queue = await genesis.ownerQueue(false);
    expect((queue.ownerRequests as Array<Record<string, unknown>>).map((x) => [x.requestId, x.kind, x.stale])).toEqual([[id, "kyc", false], [idOf(k), "constitutional_change", false]]);
    expect(JSON.stringify(queue.knowledgeProposals)).not.toContain("Please enable a channel.");
    await genesis.decideOwnerRequest(idOf(k), "answered", "Not now.", OWNER);
    expect((await doctorLines()).find((c) => c.name === "external dependencies")).toMatchObject({ status: "pass" });
    await gw.ownerRequestWithdraw(F.id, F.token, id);
  });

  it("capabilities expose the experiment policy bounds the founder's capability signature depends on", async () => {
    const caps = await gw.capabilities(F.id, F.token);
    expect(caps).toMatchObject({ ok: true, experimentFinancialMode: "simulated", experimentHardCapMinor: 5000, experimentMaxActive: 3, ownerRequests: true, paymentExecutable: false });
    const off = capabilityView(caps, true);
    expect(off.tools).toEqual(expect.arrayContaining(["record_external_dependency", "withdraw_external_dependency"]));
    expect(off.tools).not.toContain("request_owner_decision");
    await genesis.experimentPolicySet(true, null, OWNER);
    const on = capabilityView(await gw.capabilities(F.id, F.token), true);
    expect(on.signature).not.toBe(off.signature);
    expect(on.tools.filter((t) => !off.tools.includes(t))).toEqual(["add_experiment_evidence", "list_experiments", "propose_experiment", "record_experiment", "start_experiment"]);
    await genesis.experimentPolicySet(false, null, OWNER);
    expect(capabilityView(await gw.capabilities(F.id, F.token), true).signature).toBe(off.signature); // stable across reads
  });

  it("over HTTP: create / list / withdraw; an R28 runtime's category body is mapped or refused; cognition status carries capabilities and the discovery allowance", async () => {
    const svc = new PgFleetStore({ connectionString: pgc.serviceUrl });
    const service = new FleetService({ admin: svc, agent: gw, realReplicationEnabled: false, reaperIntervalMs: 0,
      release: { repo: "https://github.com/5l4mm3r/automaton-fleet", commit: "c".repeat(40), buildId: "d".repeat(64), lockfileSha256: "e".repeat(64) },
      audit: () => undefined, terminator: new UnsupportedSandboxTerminator(), cognitionProviderFactory: () => { throw new Error("no inference in this test"); } });
    const url = (await service.listen(0, "127.0.0.1")).url;
    try {
      const client = new FleetApiClient({ baseUrl: url, agentId: G.id, token: G.token });
      const made = await client.ownerRequestCreate({ idempotencyKey: "dep:http-1", kind: "legal_signature", action: "Sign the marketplace seller agreement", goalRef: null,
        title: "Seller agreement signature", detail: "A legally binding signature; selling direct meanwhile." });
      expect(made).toMatchObject({ ok: true, request: { status: "pending", kind: "legal_signature", blocksAction: true, blocking: false } });
      const id = idOf(made);
      expect(await client.ownerRequests()).toMatchObject({ ok: true, requests: expect.arrayContaining([expect.objectContaining({ requestId: id, action: "Sign the marketplace seller agreement" })]) });
      expect(await client.ownerRequestWithdraw(id)).toMatchObject({ ok: true, request: { status: "withdrawn" } });
      // (the client raises a refusal as an ApiError carrying the code; the founder toolbox turns it into data)
      await expect(client.ownerRequestWithdraw("not-a-uuid")).rejects.toMatchObject({ code: "FLEET_BAD_REQUEST" });
      // An R28 founder runtime still sends { category, blocking }: an identity category maps to a kind (its title is the
      // action); an ordinary one is refused — it was never the owner's to decide.
      const raw = (body: Record<string, unknown>) => (client as unknown as { call: (m: string, p: string, b: unknown) => Promise<Record<string, unknown>> })
        .call("POST", "/v1/owner-requests/create", body);
      const legacy = await raw({ idempotencyKey: "own:r28-1", category: "account_or_identity", goalRef: null, title: "Open a seller account", detail: "Needs KYC.", blocking: true });
      expect(legacy).toMatchObject({ ok: true, request: { kind: "kyc", action: "Open a seller account", blocksAction: true, blocking: false } });
      await client.ownerRequestWithdraw(idOf(legacy));
      await expect(raw({ idempotencyKey: "own:r28-2", category: "sales_channel", goalRef: "g1", title: "Enable a Gumroad channel", detail: "x", blocking: true }))
        .rejects.toMatchObject({ code: "FLEET_NOT_AN_EXCEPTION" });
      const status = await client.cognitionStatus();
      const view = capabilityView(await gw.capabilities(G.id, G.token), (status.routing as { active?: boolean }).active === true);
      expect(status.capabilities).toEqual(JSON.parse(JSON.stringify(view)));
      expect(JSON.stringify(status.capabilities)).not.toMatch(/token|secret|fs1\./);
      // F2-A: the controller's discovery allowance (equity × 2 %, at most 300; no burn yet, so no runway figure).
      const eq = await equity(G.id);
      expect(eq).toBeGreaterThan(0);
      expect(status.discovery).toEqual({ allowed: true, budgetCents: budgetFor(eq), spentTodayCents: 0, runwayDays: null, reason: "allowed" });
    } finally {
      await service.close();
      await svc.close();
    }
  });

  // ─────────────────────────────────────────────── legacy backfill: Founder 1's Gumroad proposal, end to end

  describe("legacy proposal backfill as an action-scoped dependency, and the founder loop around it", () => {
    const GUMROAD_TITLE = "Owner request: enrol a Gumroad channel for zero-capex digital products";
    const GUMROAD_TEXT = "Founder agent (goal g1) asks the owner to create/enrol a Gumroad seller account and expose it as a destination/upload path. "
      + "First test product: a UK landlord compliance tracker spreadsheet, priced at £9. Full proposal is in workspace/proposal_gumroad.md.";
    const ACTION = "List the landlord compliance tracker on Gumroad (a Gumroad seller account needs a human identity/KYC)";
    let legacyId = "";
    let marketId = "";
    let failureId = "";
    const SUBMITTED = "2026-09-26T16:28:10.793Z";
    const backdate = async (id: string, iso: string) => {
      await q(`ALTER TABLE fleet.fleet_knowledge_proposals DISABLE TRIGGER fleet_knowledge_proposals_guard`);
      await q(`UPDATE fleet.fleet_knowledge_proposals SET submitted_at = $2 WHERE proposal_id = $1`, [id, iso]);
      await q(`ALTER TABLE fleet.fleet_knowledge_proposals ENABLE TRIGGER fleet_knowledge_proposals_guard`);
    };
    const cli = (...args: string[]) => runGenesisCommand(args[0], args.slice(1), genesis, OWNER, { connectionString: pgc.ownerUrl, apiUrl: null });
    const authority = async () => q(`SELECT (SELECT count(*) FROM fleet.fleet_payment_orders) AS orders, (SELECT count(*) FROM fleet.fleet_payment_instructions) AS instr,
      (SELECT count(*) FROM fleet.fleet_org_identity_claims) AS claims, (SELECT count(*) FROM fleet.fleet_ledger_journal) AS journals,
      (SELECT count(*) FROM fleet.fleet_experiments) AS experiments, (SELECT to_jsonb(m) FROM fleet.fleet_capability_manifests m WHERE manifest_id = 'founder-v2') AS manifest,
      (SELECT replication_enabled FROM fleet.fleet_state) AS replication`);

    it("only the founder-labelled proposal is eligible; import states the kind and the one action, is explicit, deterministic and idempotent", async () => {
      const mk = async (category: string, title: string, content: string) => ((await gw.knowledgePropose(F.id, F.token, category, title, content)) as unknown as { proposalId: string }).proposalId;
      legacyId = await mk("policy", GUMROAD_TITLE, GUMROAD_TEXT);
      marketId = await mk("market", "UK MTD Income Tax spreadsheet templates are commoditised", "Free lead magnets everywhere (goal g1 research).");
      failureId = await mk("failure", "Idle waiting on an owner approval still costs inference", `While listing request ${legacyId.slice(0, 8)} waited on the owner (goal g1)…`);
      await backdate(legacyId, SUBMITTED);
      expect(await q(`SELECT count(*)::int AS n FROM fleet.fleet_owner_requests WHERE source_kind = 'knowledge_proposal'`)).toEqual([{ n: 0 }]);
      const queue = await genesis.ownerQueue(false);
      const flags = Object.fromEntries((queue.knowledgeProposals as Array<{ proposalId: string; looksLikeOwnerRequest: boolean }>).map((k) => [k.proposalId, k.looksLikeOwnerRequest]));
      expect([flags[legacyId], flags[marketId], flags[failureId]]).toEqual([true, false, false]);
      // Ordinary institutional knowledge is never converted, even when asked explicitly.
      for (const id of [marketId, failureId]) expect(await code(genesis.importOwnerRequest(id, "kyc", "x", null, OWNER))).toBe("FLEET_NOT_AN_OWNER_REQUEST");
      // Kind and action are stated by the owner, never inferred; an ordinary kind is not a dependency; the owner actor is required.
      expect(await code(genesis.importOwnerRequest(legacyId, "sales_channel", ACTION, null, OWNER))).toBe("FLEET_NOT_AN_EXCEPTION");
      expect(await code(genesis.importOwnerRequest(legacyId, "kyc", null as never, null, OWNER))).toBe("FLEET_BAD_REQUEST");
      expect(await code(genesis.importOwnerRequest(legacyId, "kyc", ACTION, null, "owner"))).toBe("FLEET_APPROVAL_REQUIRED");
      await expect(cli("owner-request-import", legacyId, "kyc")).rejects.toThrow(/human_identity\|kyc\|legal_signature\|constitutional_change\|non_delegable_credential <unavailable action…>/);
      const before = await authority();
      const proposalBefore = await q(`SELECT to_jsonb(k) AS k FROM fleet.fleet_knowledge_proposals k WHERE proposal_id = $1`, [legacyId]);
      const r = (await cli("owner-request-import", legacyId, "kyc", ...ACTION.split(" "))).output as Record<string, any>;
      expect(r).toMatchObject({
        requestId: legacyId, agentId: F.id, kind: "kyc", action: ACTION, goalRef: "g1", goalSource: "proposal_text", title: GUMROAD_TITLE, blocksAction: true, blocking: false,
        status: "pending", response: null, decidedAt: null, stale: false,
        source: { kind: "knowledge_proposal", ref: legacyId, importedBy: OWNER },
        note: expect.stringMatching(/nothing was decided or granted, and the founder is not blocked/),
      });
      expect(new Date(r.createdAt).toISOString()).toBe(SUBMITTED); // its age stays true
      // Idempotent: a second run (even with other arguments) returns the same record and changes nothing.
      const again = (await cli("owner-request-import", legacyId, "human_identity", "something", "else", "--goal", "g9")).output as Record<string, unknown>;
      expect(again).toMatchObject({ requestId: legacyId, kind: "kyc", action: ACTION, goalRef: "g1", replayed: true });
      expect(await q(`SELECT count(*)::int AS n FROM fleet.fleet_owner_requests WHERE source_ref = $1`, [legacyId])).toEqual([{ n: 1 }]);
      expect(await q(`SELECT to_jsonb(k) AS k FROM fleet.fleet_knowledge_proposals k WHERE proposal_id = $1`, [legacyId])).toEqual(proposalBefore);
      const q2 = await genesis.ownerQueue(false);
      expect((q2.knowledgeProposals as Array<Record<string, unknown>>).find((k) => k.proposalId === legacyId)).toMatchObject({ status: "proposed", importedAsRequest: true });
      expect(await authority()).toEqual(before); // conversion grants nothing
      expect((await q(`SELECT detail FROM fleet.fleet_events WHERE event_type = 'owner_request_imported'`))[0].detail).toMatchObject({ proposalId: legacyId, goalSource: "proposal_text", kind: "kyc" });
      // Ambiguous goal references are not guessed; a reviewed proposal is no longer importable.
      const twoGoals = await mk("policy", "Owner request: two goals", "For g1 and g2.");
      expect(await genesis.importOwnerRequest(twoGoals, "human_identity", "Verify identity for g1/g2", null, OWNER)).toMatchObject({ goalRef: null, goalSource: "ambiguous" });
      await gw.ownerRequestWithdraw(F.id, F.token, twoGoals);
      const reviewed = await mk("policy", "Owner request: reviewed already", "x");
      await genesis.reviewKnowledge(reviewed, false, "not a lesson", OWNER);
      expect(await code(genesis.importOwnerRequest(reviewed, "kyc", "x", null, OWNER))).toBe("FLEET_INVALID_STATE");
    });

    it("doctor: the imported dependency is information (PASS, kyc), and its knowledge proposal is not double-counted", async () => {
      const checks = (await runDoctor({ env: {}, store, paths: { cwd: os.tmpdir() }, serviceActive: async () => "inactive" } as never)).checks;
      expect(checks.find((c) => c.name === "external dependencies")).toMatchObject({ status: "pass", detail: expect.stringMatching(/^1 open \(kyc 1\): each makes one action unavailable; no founder is blocked/) });
      expect(checks.find((c) => c.name === "institutional knowledge")!.detail).toMatch(/\(\d+ imported as dependencies\)/);
    });

    it("after F2-A the founder gets ONE full packet naming the renamed tools and the Gumroad action; idle wakes become discovery; the allowance bounds it; nothing is granted", async () => {
      await genesis.experimentPolicySet(true, null, OWNER); // as in production since 2026-09-30
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "f2a-e2e-"));
      const dirs = { w: path.join(root, "w"), s: path.join(root, "s"), m: path.join(root, "s", "memory") };
      for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(dirs.m, "facts.json"), JSON.stringify({ product: "built" }));
      fs.writeFileSync(path.join(dirs.m, "goals.json"), JSON.stringify([{ id: "g1", title: "Find a sales channel the owner can enable", status: "open" }]));
      const economics = { cash: 9_000, genesisAllocation: 10_000 };
      // State as the R28 runtime leaves it: a sleep-only turn, a digest with R28 signals, and R28's tool names.
      const caps = capabilityView(await gw.capabilities(F.id, F.token), true);
      const r28Tools = caps.tools.map((t) => (t === "record_external_dependency" ? "request_owner_decision" : t === "withdraw_external_dependency" ? "withdraw_owner_request" : t)).sort();
      fs.writeFileSync(path.join(dirs.s, "mind-continuity.json"), JSON.stringify({ at: "2026-10-01T15:32:23.972Z", turn: 12, outcome: "sleep: Gumroad 62cbe1b7 still pending; awaiting approval.",
        tools: ["sleep"], wakeDigest: "0".repeat(64), capabilities: { sig: "1".repeat(64), tools: r28Tools } }));
      const packets: string[] = [];
      const ports: MindPorts = {
        // The real registry status (including its discovery allowance); cognition switched on for the test.
        cognitionStatus: async () => ({ ...(await gw.cognitionStatus(F.id, F.token)), policyEnabled: true, provider: "anthropic", founderEnabled: true, paused: false, routing: { active: true },
          capabilities: capabilityView(await gw.capabilities(F.id, F.token), true) }),
        ledger: async () => economics,
        ownerRequests: () => gw.ownerRequestList(F.id, F.token),
        infer: async (messages) => { packets.push(String((messages as Array<{ content: string }>)[0].content)); return { content: "", toolCalls: [{ id: `s${packets.length}`, name: "sleep", arguments: { reason: "considering" } }], usage: { inputTokens: 1, outputTokens: 1 }, chargedCents: 0, requestId: `r${packets.length}` }; },
      };
      const loopGuard = new LoopGuard();
      const toolbox = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: dirs.w, memoryDir: dirs.m, loopGuard, ports: {
        ledger: async () => economics, spendOrder: async () => ({}), proposeKnowledge: async () => ({}), knowledge: async () => [], requestIdentityFact: async () => ({}),
      } });
      const mind = new FounderMind({ ports, toolbox, stateDir: dirs.s, routed: { memoryDir: dirs.m, workspaceDir: dirs.w, manifest: FOUNDER_MANIFEST_V2, loopGuard } });
      const next = async () => {
        const n = packets.length;
        for (let i = 0; i <= MAX_IDLE_SKIP + 1 && packets.length === n; i++) await mind.turn(`heartbeat ${i}`);
        expect(packets.length).toBe(n + 1);
        const task = String(JSON.parse(packets.at(-1)!.split("\n").slice(3).join("\n")).task);
        return { task, slim: /Nothing has changed since your last turn/.test(task), discovery: /autonomous opportunity discovery/.test(task) };
      };
      const line = (t: string) => t.split("\n").filter((l) => l.startsWith(`External dependency ${legacyId.slice(0, 8)}`));
      // 1: the first wake after the upgrade is FULL and names what changed — once.
      const first = await next();
      expect(first.slim).toBe(false);
      expect(first.task).toMatch(/Your capabilities changed since your last turn\. Newly available: record_external_dependency, withdraw_external_dependency\. No longer available: request_owner_decision, withdraw_owner_request\./);
      expect(line(first.task)).toEqual([`External dependency ${legacyId.slice(0, 8)} (kyc): the action "${ACTION}" is unavailable for now. This blocks only that action — not you, your goals or other work: pursue alternatives (another marketplace, direct sales that need no new account, another product, service, niche or venture).`]);
      expect(first.task).not.toMatch(OWNER_DEPENDENCY);
      // 2: the next idle wake is not "nothing has changed → sleep": the allowance permits discovery, Gumroad still unresolved.
      const eq = await equity(F.id);
      const budget = budgetFor(eq);
      expect(budget).toBeGreaterThan(0);
      const discovery = await next();
      expect(discovery).toMatchObject({ slim: false, discovery: true });
      expect(discovery.task).toContain(`autonomous opportunity discovery (allowance today 0p of ${budget}p).`);
      expect(line(discovery.task)).toHaveLength(1);
      expect(mind.routing.discoveryTurns).toBe(1);
      // 3: the allowance is the controller's: once today's inference reaches it, idle wakes fall back to the slim packet.
      await q(`INSERT INTO fleet.fleet_cognition_log (request_id, agent_id, provider, model, outcome, input_tokens, output_tokens, cost_microcents, charged_cents, prompt_sha256, response_sha256, charged_microcents)
        VALUES (gen_random_uuid(), $1, 'anthropic', 'm', 'ok', 1, 1, 0, $2, repeat('a', 64), repeat('b', 64), $2::bigint * 1000000)`, [F.id, budget]);
      const after = (await gw.cognitionStatus(F.id, F.token)).discovery as Record<string, unknown>;
      expect(after).toMatchObject({ allowed: false, budgetCents: budget, spentTodayCents: budget, reason: "today's discovery allowance is spent" });
      expect(Number(after.runwayDays)).toBeCloseTo((eq * 7) / budget, 0); // equity ÷ (today's burn spread over the 7-day window)
      const spent = await next();
      expect(spent).toMatchObject({ slim: true, discovery: false });
      expect(spent.task).toMatch(/otherwise you may sleep until your discovery allowance renews/);
      expect(line(spent.task)).toHaveLength(1); // the dependency stays visible as one unavailable action
      // 4: a resolution (rare: the owner provides the identity) is news exactly once; it grants nothing.
      const before = await authority();
      const capsBefore = capabilityView(await gw.capabilities(F.id, F.token), true).signature;
      expect((await cli("owner-request-decide", legacyId, "answered", "The fleet storefront identity covers this.")).output).toMatchObject({ status: "answered", note: expect.stringMatching(/grants no capability/) });
      const answered = await next();
      expect(answered.slim).toBe(false);
      expect(line(answered.task)).toEqual([`External dependency ${legacyId.slice(0, 8)} (kyc) for "${ACTION}": ANSWERED, with the note: "The fleet storefront identity covers this.". This records an answer only; it grants no capability, account, money or permission by itself.`]);
      expect((await next()).slim).toBe(true);
      expect(await authority()).toEqual(before);
      expect(capabilityView(await gw.capabilities(F.id, F.token), true).signature).toBe(capsBefore);
      await genesis.experimentPolicySet(false, null, OWNER);
    });
  });
});
