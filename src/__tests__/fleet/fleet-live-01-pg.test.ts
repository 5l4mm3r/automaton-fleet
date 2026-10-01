/**
 * F1-LIVE-01 schema v25 — owner-request liveness (PostgreSQL). A founder can record what it needs from the owner; only
 * the owner decides; a decision grants nothing; a request cannot silently disappear (doctor warns when it goes stale).
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
import { FounderMind, MAX_IDLE_SKIP, wakeDigest, type MindPorts } from "../../fleet/founder/mind.js";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { FOUNDER_MANIFEST_V2 } from "../../fleet/capabilities.js";

const PG_BIN = findPgBin();
const OWNER = "operator:owner";
type Who = { id: string; token: string };

describe.skipIf(!PG_BIN)("F1-LIVE-01 owner requests (schema v25, PostgreSQL)", () => {
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
    idempotencyKey: `own:${crypto.randomUUID()}`, category: "sales_channel", goalRef: "g1", title: "Enable a Gumroad channel", detail: "Product built; need a listing route.", blocking: true, ...o } as never);
  /** Backdate a request (owner, with its guard off for the test only) to simulate time passing. */
  const age = async (id: string, s: number) => {
    await q(`ALTER TABLE fleet.fleet_owner_requests DISABLE TRIGGER fleet_owner_requests_guard`);
    await q(`UPDATE fleet.fleet_owner_requests SET created_at = now() - make_interval(secs => $2) WHERE request_id = $1`, [id, s]);
    await q(`ALTER TABLE fleet.fleet_owner_requests ENABLE TRIGGER fleet_owner_requests_guard`);
  };

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

  it("migrates to v25 with a clean privilege audit; founders get exactly create / withdraw / list, nothing to decide", async () => {
    expect((await q(`SELECT max(version)::int AS v FROM fleet.fleet_schema_migrations`))[0].v).toBe(25);
    expect((await store.auditPrivileges()).problems).toEqual([]);
    const agent = new pg.Pool({ connectionString: pgc.agentUrl, max: 1 });
    try {
      expect(await code(agent.query(`SELECT fleet.fleet_owner_request_decide(gen_random_uuid(), 'approved', 'x', 'operator:owner')`))).toBe("permission denied");
      expect(await code(agent.query(`SELECT * FROM fleet.fleet_owner_requests`))).toBe("permission denied");
      expect(await code(agent.query(`SELECT fleet.fleet_owner_queue(true)`))).toBe("permission denied");
    } finally { await agent.end(); }
  });

  it("create: validated, idempotent, bounded (5 pending, 10/day) and scrubbed; a founder sees only its own", async () => {
    const idem = `own:${crypto.randomUUID()}`;
    const a = await create(F, { idempotencyKey: idem });
    expect(a).toMatchObject({ ok: true, request: { status: "pending", category: "sales_channel", goalRef: "g1", blocking: true, stale: false, staleAfterS: 86_400 } });
    expect(await create(F, { idempotencyKey: idem, title: "changed" })).toMatchObject({ ok: true, replayed: true, request: { requestId: (a.request as { requestId: string }).requestId, title: "Enable a Gumroad channel" } });
    for (const bad of [{ category: "money_now" }, { goalRef: "goal-1" }, { title: "" }, { detail: "x".repeat(2001) }, { blocking: null }]) {
      expect(await create(F, bad), JSON.stringify(bad)).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
    }
    const leak = await create(F, { title: "Use postgres://u:secret@host/db", detail: `key 0x${"ab".repeat(32)}` });
    expect(JSON.stringify(leak)).not.toMatch(/secret@|abababab/);
    for (let i = 0; i < 3; i++) expect(await create(F)).toMatchObject({ ok: true });
    expect(await create(F)).toMatchObject({ ok: false, code: "FLEET_LIMIT_REACHED" }); // 5 pending
    const mine = await gw.ownerRequestList(F.id, F.token);
    expect((mine.requests as unknown[]).length).toBe(5);
    expect(await gw.ownerRequestList(G.id, G.token)).toMatchObject({ ok: true, requests: [] });
    expect(await gw.ownerRequestWithdraw(G.id, G.token, (a.request as { requestId: string }).requestId)).toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    expect(await create(F, { idempotencyKey: idem })).toMatchObject({ ok: true, replayed: true }); // replay is never limited
    // Clean up for the next tests: the founder withdraws its own.
    for (const r of mine.requests as Array<{ requestId: string }>) expect(await gw.ownerRequestWithdraw(F.id, F.token, r.requestId)).toMatchObject({ ok: true, request: { status: "withdrawn" } });
    expect(await gw.ownerRequestWithdraw(F.id, F.token, (a.request as { requestId: string }).requestId)).toMatchObject({ ok: false, code: "FLEET_INVALID_STATE" });
    // Rate limit: 10 created per day (5 so far + 5 more), the 11th is refused even with nothing pending.
    for (let i = 0; i < 5; i++) { const r = await create(F); await gw.ownerRequestWithdraw(F.id, F.token, (r.request as { requestId: string }).requestId); }
    expect(await create(F)).toMatchObject({ ok: false, code: "FLEET_RATE_LIMITED" });
    await q(`ALTER TABLE fleet.fleet_owner_requests DISABLE TRIGGER fleet_owner_requests_guard`);
    await q(`UPDATE fleet.fleet_owner_requests SET created_at = now() - interval '2 days' WHERE agent_id = $1`, [F.id]);
    await q(`ALTER TABLE fleet.fleet_owner_requests ENABLE TRIGGER fleet_owner_requests_guard`);
  });

  it("only the owner decides; the answer reaches the founder; a decision is final, immutable and grants nothing", async () => {
    const before = await q(`SELECT (SELECT count(*) FROM fleet.fleet_payment_orders) AS o, (SELECT count(*) FROM fleet.fleet_org_identity_claims) AS c,
                                   (SELECT count(*) FROM fleet.fleet_ledger_journal) AS j, (SELECT to_jsonb(m) FROM fleet.fleet_capability_manifests m WHERE manifest_id = 'founder-v2') AS m`);
    const r = await create(F);
    const id = (r.request as { requestId: string }).requestId;
    expect(await code(genesis.decideOwnerRequest(id, "approved", null, "owner"))).toBe("FLEET_APPROVAL_REQUIRED");
    expect(await code(genesis.decideOwnerRequest(id, "answered", "  ", OWNER))).toBe("FLEET_BAD_REQUEST");
    const d = await genesis.decideOwnerRequest(id, "declined", "No Gumroad account this month: use a free route or pivot.", OWNER);
    expect(d).toMatchObject({ status: "declined", decidedBy: OWNER, agentId: F.id, note: expect.stringMatching(/grants no capability/) });
    expect(await code(genesis.decideOwnerRequest(id, "approved", null, OWNER))).toBe("FLEET_INVALID_STATE");
    expect(await code(q(`UPDATE fleet.fleet_owner_requests SET title = 'x' WHERE request_id = $1`, [id]))).toMatch(/FLEET_INVALID_STATE|FLEET_IMMUTABLE/);
    expect(await code(q(`DELETE FROM fleet.fleet_owner_requests WHERE request_id = $1`, [id]))).toBe("FLEET_IMMUTABLE");
    const seen = (await gw.ownerRequestList(F.id, F.token)).requests as Array<Record<string, unknown>>;
    expect(seen.find((x) => x.requestId === id)).toMatchObject({ status: "declined", response: "No Gumroad account this month: use a free route or pivot.", stale: false });
    // An approval changes nothing else: no order, claim, journal or manifest change.
    const r2 = await create(F, { category: "account_or_identity" });
    await genesis.decideOwnerRequest((r2.request as { requestId: string }).requestId, "approved", null, OWNER);
    expect(await q(`SELECT (SELECT count(*) FROM fleet.fleet_payment_orders) AS o, (SELECT count(*) FROM fleet.fleet_org_identity_claims) AS c,
                           (SELECT count(*) FROM fleet.fleet_ledger_journal) AS j, (SELECT to_jsonb(m) FROM fleet.fleet_capability_manifests m WHERE manifest_id = 'founder-v2') AS m`)).toEqual(before);
    expect((await q(`SELECT event_type FROM fleet.fleet_events WHERE event_type LIKE 'owner_request_%' ORDER BY id DESC LIMIT 1`))[0].event_type).toBe("owner_request_decided");
  });

  it("staleness: a pending blocking request past 24 h is stale for the founder, and doctor WARNs (never an ordinary PASS)", async () => {
    const r = await create(F);
    const id = (r.request as { requestId: string }).requestId;
    const doctorLines = async () => (await runDoctor({ env: {}, store, paths: { cwd: os.tmpdir() }, serviceActive: async () => "inactive" } as never)).checks
      .filter((c) => c.name === "owner requests" || c.name === "institutional knowledge");
    let lines = await doctorLines();
    expect(lines.find((c) => c.name === "owner requests")).toMatchObject({ status: "pass", detail: expect.stringMatching(/^1 pending \(1 blocking a founder goal\); 0 blocking request\(s\) unanswered past 1\.0 d/) });
    await age(id, 5 * 86_400);
    const list = (await gw.ownerRequestList(F.id, F.token)).requests as Array<Record<string, unknown>>;
    expect(list.find((x) => x.requestId === id)).toMatchObject({ status: "pending", stale: true, ageS: expect.any(Number) });
    expect(Number(list.find((x) => x.requestId === id)!.ageS)).toBeGreaterThanOrEqual(5 * 86_400);
    // A knowledge proposal used as an owner request (Founder 1's 62cbe1b7) also warns once it is unreviewed past 24 h.
    expect((await gw.knowledgePropose(F.id, F.token, "policy", "Owner request: enrol a Gumroad channel", "Please enable a channel."))).toMatchObject({ ok: true });
    await q(`ALTER TABLE fleet.fleet_knowledge_proposals DISABLE TRIGGER fleet_knowledge_proposals_guard`);
    await q(`UPDATE fleet.fleet_knowledge_proposals SET submitted_at = now() - interval '5 days'`);
    await q(`ALTER TABLE fleet.fleet_knowledge_proposals ENABLE TRIGGER fleet_knowledge_proposals_guard`);
    lines = await doctorLines();
    expect(lines.find((c) => c.name === "owner requests")).toMatchObject({ status: "warn", detail: expect.stringMatching(/1 blocking request\(s\) unanswered past 1\.0 d; oldest 5\.0 d — fleet:admin owner-queue/) });
    expect(lines.find((c) => c.name === "institutional knowledge")).toMatchObject({ status: "warn", detail: expect.stringMatching(/oldest 5\.0 d: unreviewed past 1\.0 d — fleet:admin owner-queue/) });
    // The owner's queue lists both, oldest first, with ages (titles only: no detail content for knowledge).
    const queue = await genesis.ownerQueue(false);
    expect((queue.ownerRequests as Array<Record<string, unknown>>).map((x) => [x.requestId, x.stale])).toEqual([[id, true]]);
    expect(queue.knowledgeProposals).toEqual([expect.objectContaining({ title: "Owner request: enrol a Gumroad channel", stale: true })]);
    expect(JSON.stringify(queue.knowledgeProposals)).not.toContain("Please enable a channel.");
    // Answered: no longer warns.
    await genesis.decideOwnerRequest(id, "answered", "Try a free listing route first.", OWNER);
    expect((await doctorLines()).find((c) => c.name === "owner requests")).toMatchObject({ status: "pass" });
  });

  it("capabilities expose the experiment policy bounds the founder's capability signature depends on", async () => {
    const caps = await gw.capabilities(F.id, F.token);
    expect(caps).toMatchObject({ ok: true, experimentFinancialMode: "simulated", experimentHardCapMinor: 5000, experimentMaxActive: 3, ownerRequests: true, paymentExecutable: false });
    const off = capabilityView(caps, true);
    await genesis.experimentPolicySet(true, null, OWNER);
    const on = capabilityView(await gw.capabilities(F.id, F.token), true);
    expect(on.signature).not.toBe(off.signature);
    expect(on.tools.filter((t) => !off.tools.includes(t))).toEqual(["add_experiment_evidence", "list_experiments", "propose_experiment", "record_experiment", "start_experiment"]);
    await genesis.experimentPolicySet(false, null, OWNER);
    expect(capabilityView(await gw.capabilities(F.id, F.token), true).signature).toBe(off.signature); // stable across reads
  });

  it("over HTTP: the founder's client creates, lists and withdraws; cognition status carries the capability view", async () => {
    const svc = new PgFleetStore({ connectionString: pgc.serviceUrl });
    const service = new FleetService({ admin: svc, agent: gw, realReplicationEnabled: false, reaperIntervalMs: 0,
      release: { repo: "https://github.com/5l4mm3r/automaton-fleet", commit: "c".repeat(40), buildId: "d".repeat(64), lockfileSha256: "e".repeat(64) },
      audit: () => undefined, terminator: new UnsupportedSandboxTerminator(), cognitionProviderFactory: () => { throw new Error("no inference in this test"); } });
    const url = (await service.listen(0, "127.0.0.1")).url;
    try {
      const client = new FleetApiClient({ baseUrl: url, agentId: G.id, token: G.token });
      const made = await client.ownerRequestCreate({ idempotencyKey: "own:http-1", category: "information", goalRef: null, title: "Which channel may I use?", detail: "Asking before building.", blocking: false });
      expect(made).toMatchObject({ ok: true, request: { status: "pending", blocking: false } });
      const id = (made.request as { requestId: string }).requestId;
      expect(await client.ownerRequests()).toMatchObject({ ok: true, staleAfterS: 86_400, requests: [expect.objectContaining({ requestId: id })] });
      expect(await client.ownerRequestWithdraw(id)).toMatchObject({ ok: true, request: { status: "withdrawn" } });
      // (the client raises a refusal as an ApiError carrying the code; the founder toolbox turns it into data)
      await expect(client.ownerRequestWithdraw("not-a-uuid")).rejects.toMatchObject({ code: "FLEET_BAD_REQUEST" });
      const status = await client.cognitionStatus();
      const view = capabilityView(await gw.capabilities(G.id, G.token), (status.routing as { active?: boolean }).active === true);
      expect(status.capabilities).toEqual(JSON.parse(JSON.stringify(view)));
      expect(JSON.stringify(status.capabilities)).not.toMatch(/token|secret|fs1\./);
    } finally {
      await service.close();
      await svc.close();
    }
  });

  // ─────────────────────────────────────────────── legacy backfill: Founder 1's 62cbe1b7, end to end

  describe("legacy operational request backfill (62cbe1b7) and owner-answer delivery", () => {
    const GUMROAD_TITLE = "Owner request: enrol a Gumroad channel for zero-capex digital products";
    const GUMROAD_TEXT = "Founder agent (goal g1) asks the owner to create/enrol a Gumroad seller account and expose it as a destination/upload path. "
      + "First test product: a UK landlord compliance tracker spreadsheet, priced at £9. Full proposal is in workspace/proposal_gumroad.md.";
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

    it("nothing is converted by the migration; only the founder-labelled owner request is eligible; import is explicit, deterministic and idempotent", async () => {
      const mk = async (category: string, title: string, content: string) => ((await gw.knowledgePropose(F.id, F.token, category, title, content)) as { proposalId: string }).proposalId;
      legacyId = await mk("policy", GUMROAD_TITLE, GUMROAD_TEXT);
      marketId = await mk("market", "UK MTD Income Tax spreadsheet templates are commoditised", "Free lead magnets everywhere (goal g1 research).");
      failureId = await mk("failure", "Idle waiting on an owner approval still costs inference", `While listing request ${legacyId.slice(0, 8)} waited on the owner (goal g1)…`);
      await backdate(legacyId, SUBMITTED);
      expect(await q(`SELECT count(*)::int AS n FROM fleet.fleet_owner_requests WHERE source_kind = 'knowledge_proposal'`)).toEqual([{ n: 0 }]);
      // The owner's queue flags the candidate (advisory) — and only it.
      const queue = await genesis.ownerQueue(false);
      const flags = Object.fromEntries((queue.knowledgeProposals as Array<{ proposalId: string; looksLikeOwnerRequest: boolean }>).map((k) => [k.proposalId, k.looksLikeOwnerRequest]));
      expect([flags[legacyId], flags[marketId], flags[failureId]]).toEqual([true, false, false]);
      // Ordinary institutional knowledge is never converted, even when asked explicitly.
      for (const id of [marketId, failureId]) expect(await code(genesis.importOwnerRequest(id, "sales_channel", true, null, OWNER))).toBe("FLEET_NOT_AN_OWNER_REQUEST");
      // Category and blocking are stated by the owner, never inferred; the owner actor is required.
      expect(await code(genesis.importOwnerRequest(legacyId, "sales_channel", null as never, null, OWNER))).toBe("FLEET_BAD_REQUEST");
      expect(await code(genesis.importOwnerRequest(legacyId, "guess", true, null, OWNER))).toBe("FLEET_BAD_REQUEST");
      expect(await code(genesis.importOwnerRequest(legacyId, "sales_channel", true, null, "owner"))).toBe("FLEET_APPROVAL_REQUIRED");
      await expect(cli("owner-request-import", legacyId, "sales_channel")).rejects.toThrow(/blocking\|non-blocking/);
      const before = await authority();
      const proposalBefore = await q(`SELECT to_jsonb(k) AS k FROM fleet.fleet_knowledge_proposals k WHERE proposal_id = $1`, [legacyId]);
      const r = (await cli("owner-request-import", legacyId, "sales_channel", "blocking")).output as Record<string, any>;
      expect(r).toMatchObject({
        requestId: legacyId, agentId: F.id, category: "sales_channel", goalRef: "g1", goalSource: "proposal_text", title: GUMROAD_TITLE, blocking: true,
        status: "pending", response: null, decidedAt: null, stale: true,
        source: { kind: "knowledge_proposal", ref: legacyId, importedBy: OWNER },
        note: expect.stringMatching(/nothing was decided or granted/),
      });
      expect(new Date(r.createdAt).toISOString()).toBe(SUBMITTED); // its age stays true
      expect(Number(r.ageS)).toBeGreaterThan(4 * 86_400);
      // Idempotent: a second run (even with other arguments) returns the same request and changes nothing.
      const again = (await cli("owner-request-import", legacyId, "other", "non-blocking", "--goal", "g9")).output as Record<string, unknown>;
      expect(again).toMatchObject({ requestId: legacyId, category: "sales_channel", blocking: true, goalRef: "g1", replayed: true });
      expect(await q(`SELECT count(*)::int AS n FROM fleet.fleet_owner_requests WHERE source_ref = $1`, [legacyId])).toEqual([{ n: 1 }]);
      // The original proposal is untouched and still auditable; it is now tracked as an owner request (no double warning).
      expect(await q(`SELECT to_jsonb(k) AS k FROM fleet.fleet_knowledge_proposals k WHERE proposal_id = $1`, [legacyId])).toEqual(proposalBefore);
      const q2 = await genesis.ownerQueue(false);
      expect((q2.knowledgeProposals as Array<Record<string, unknown>>).find((k) => k.proposalId === legacyId)).toMatchObject({ status: "proposed", importedAsRequest: true });
      expect(await authority()).toEqual(before); // conversion grants nothing
      expect((await q(`SELECT detail FROM fleet.fleet_events WHERE event_type = 'owner_request_imported'`))[0].detail).toMatchObject({ proposalId: legacyId, goalSource: "proposal_text", blocking: true });
      // A reviewed proposal is no longer an open request; ambiguous goal references are not guessed.
      const twoGoals = await mk("policy", "Owner request: two goals", "For g1 and g2.");
      const imported2 = await genesis.importOwnerRequest(twoGoals, "information", false, null, OWNER);
      expect(imported2).toMatchObject({ goalRef: null, goalSource: "ambiguous" });
      await gw.ownerRequestWithdraw(F.id, F.token, twoGoals);
      const reviewed = await mk("policy", "Owner request: reviewed already", "x");
      await genesis.reviewKnowledge(reviewed, false, "not a lesson", OWNER);
      expect(await code(genesis.importOwnerRequest(reviewed, "other", false, null, OWNER))).toBe("FLEET_INVALID_STATE");
    });

    it("doctor: the imported blocker WARNs as a stale blocking owner request, and its knowledge proposal is not double-counted", async () => {
      const checks = (await runDoctor({ env: {}, store, paths: { cwd: os.tmpdir() }, serviceActive: async () => "inactive" } as never)).checks;
      expect(checks.find((c) => c.name === "owner requests")).toMatchObject({ status: "warn", detail: expect.stringMatching(/1 blocking request\(s\) unanswered past 1\.0 d/) });
      expect(checks.find((c) => c.name === "institutional knowledge")!.detail).toMatch(/\(\d+ imported as owner requests\)/);
    });

    it("after R28 the founder gets ONE full packet: new capabilities AND the still-unresolved, stale 62cbe1b7; an owner answer arrives exactly once; nothing more is granted", async () => {
      await genesis.experimentPolicySet(true, null, OWNER); // as in production since 2026-09-30
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "live01-e2e-"));
      const dirs = { w: path.join(root, "w"), s: path.join(root, "s"), m: path.join(root, "s", "memory") };
      for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(dirs.m, "facts.json"), JSON.stringify({ product: "built" }));
      fs.writeFileSync(path.join(dirs.m, "goals.json"), JSON.stringify([{ id: "g1", title: "Find a sales channel", status: "open" }]));
      // State as an R27 runtime leaves it: the last turn slept, its digest recorded without any liveness signal, no capability record.
      const economics = { cash: 9_000, genesisAllocation: 10_000 };
      fs.writeFileSync(path.join(dirs.s, "mind-continuity.json"), JSON.stringify({ at: "2026-10-01T15:32:23.972Z", turn: 12, outcome: "sleep: No change; awaiting Gumroad approval. Conserving funds.",
        tools: ["sleep"], wakeDigest: wakeDigest(dirs.m, dirs.w, economics) }));
      const packets: string[] = [];
      const ports: MindPorts = {
        cognitionStatus: async () => ({ policyEnabled: true, provider: "anthropic", founderEnabled: true, paused: false, routing: { active: true },
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
        return { task, slim: /Nothing has changed since your last turn/.test(task) };
      };
      // 1–6: the first wake after the upgrade (the restart resets the idle backoff) is FULL and says what changed.
      const first = await next();
      expect(first.slim).toBe(false);
      expect(first.task).toMatch(/first capability record of this runtime\): .*propose_experiment.*request_owner_decision/s);
      expect(first.task).toMatch(/Experiment pipeline: ON \(simulated; hard cap 5000 minor units; up to 3 active\)/);
      expect(first.task).toMatch(new RegExp(`Owner request ${legacyId.slice(0, 8)} \\(sales_channel, blocks goal g1\\) "${GUMROAD_TITLE}": pending for \\d+ d — STALE`));
      expect(first.task).toMatch(/pursue an alternative route, propose a safe experiment, gather more evidence, pivot, abandon the blocked path, or keep waiting/);
      const line = (t: string) => t.split("\n").filter((l) => l.startsWith(`Owner request ${legacyId.slice(0, 8)}`));
      expect(line(first.task)).toHaveLength(1);
      expect(line(first.task)[0]).not.toMatch(/APPROVED|DECLINED|ANSWERED/); // 7: no answer is invented
      // Unchanged wakes are slim again, and the blocker stays visible.
      const quiet = await next();
      expect(quiet.slim).toBe(true);
      expect(quiet.task).toMatch(/STALE/);
      // The owner answers: exactly one meaningful change, carrying the response; then slim again.
      const before = await authority();
      const capsBefore = capabilityView(await gw.capabilities(F.id, F.token), true).signature;
      expect((await cli("owner-request-decide", legacyId, "declined", "No Gumroad account this month.", "Find a channel that needs no account, or pivot.")).output)
        .toMatchObject({ status: "declined", note: expect.stringMatching(/grants no capability/) });
      const answered = await next();
      expect(answered.slim).toBe(false);
      expect(answered.task).toMatch(/: DECLINED by the owner, who wrote: "No Gumroad account this month\. Find a channel that needs no account, or pivot\."\. This records the owner's answer only; it grants no capability, account, money or permission by itself\./);
      expect(line(answered.task)[0]).not.toMatch(/STALE/);
      expect((await next()).slim).toBe(true);
      expect((await next()).slim).toBe(true);
      // 8: the decision granted nothing — no order, instruction, claim, journal, experiment, manifest or replication change,
      // and the founder's capability signature (what it can do) is unchanged.
      expect(await authority()).toEqual(before);
      expect(capabilityView(await gw.capabilities(F.id, F.token), true).signature).toBe(capsBefore);
      // Approved and answered read differently from declined (and from each other); none implies authority.
      for (const [d, word] of [["approved", "APPROVED"], ["answered", "ANSWERED"]] as const) {
        const r = await create(F, { category: "information", goalRef: null, blocking: false, title: `Question ${d}` });
        await genesis.decideOwnerRequest((r.request as { requestId: string }).requestId, d, d === "answered" ? "Use the free route." : null, OWNER);
        const t = (await next()).task;
        expect(t).toMatch(new RegExp(`"Question ${d}": ${word} by the owner`));
        expect(t).toMatch(new RegExp(`"Question ${d}": ${word} by the owner[^\\n]*grants no capability, account, money or permission`));
      }
      expect(await authority()).toEqual(before);
      await genesis.experimentPolicySet(false, null, OWNER);
    });
  });
});
