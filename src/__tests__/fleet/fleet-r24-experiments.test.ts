/**
 * R24 — Opportunity → Experiment pipeline (schema v24, financially inert): adversarial PostgreSQL tests.
 *
 * Real roles: the founder acts only through its authenticated api_experiment_* functions (agent role), the controller
 * through svc_experiment_reap (service role), the owner through fleet_experiment_* (owner role). Research evidence is
 * the registry's own research record (attempt + result rows with the page hash) plus the evidence artifact the controller
 * keeps at fetch time. Provenance (the hash-verified page) and relevance (the controller's independent judgement of that
 * page for that proposal) are separate: only relevant items count. The assessor's model is scripted here: it answers
 * from markers in the page text, so each test fixes what the model says and checks what the controller does with it.
 *
 * Set R24_RECEIPT=<file> to write the simulated end-to-end experiment receipt.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import pg from "pg";
import { PgFleetStore, hashAgentToken, mintAgentToken } from "../../fleet/postgres/store.js";
import { PgAgentGateway } from "../../fleet/postgres/agent-gateway.js";
import { PgLedgerAdmin } from "../../fleet/treasury/ledger.js";
import { PgGenesisAdmin } from "../../fleet/genesis/admin.js";
import { simulateRuntimeAttestation } from "../../fleet/genesis/simulate.js";
import { RouteError, parseRouteRequest, route } from "../../fleet/cognition/router.js";
import { FleetService } from "../../fleet/service/server.js";
import { UnsupportedSandboxTerminator } from "../../fleet/service/terminator.js";
import { FleetApiClient } from "../../fleet/service/client.js";
import { FOUNDER_EXPERIMENT_TOOLS, FOUNDER_TOOLS, type ToolSpec } from "../../fleet/cognition/types.js";
import { FOUNDER_MANIFEST_V2, MANIFESTS, decideTool, manifestSha256 } from "../../fleet/capabilities.js";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { infer as inferLegacy } from "../../fleet/cognition/gateway.js";
import os from "os";
import path from "path";
import { findPgBin, startEphemeralPg, type EphemeralPg } from "./fixtures/ephemeral-pg.js";
import { RelevanceAssessor, relevanceRoute, type RelevanceJob } from "../../fleet/experiments/relevance.js";
import { buildEvidenceArtifact } from "../../fleet/research/artifact.js";
import { research } from "../../fleet/research/gateway.js";
import { containsSecretShape } from "../../fleet/cognition/gateway.js";
import type { ProviderFactory } from "../../fleet/cognition/routed-gateway.js";
import type { TierCandidate } from "../../fleet/cognition/router.js";
import { ProviderError } from "../../fleet/cognition/types.js";
import { wipeRegistry } from "./fixtures/wipe.js";

const PG_BIN = findPgBin();
const OWNER = "operator:owner";

type Item = { attemptId: string; sha256: string; supports: string; rationale: string };
type Who = { id: string; token: string };

describe.skipIf(!PG_BIN)("R24 opportunity → experiment pipeline (schema v24, PostgreSQL, financially inert)", () => {
  let pgc: EphemeralPg;
  let owner: pg.Pool;
  let svcRaw: pg.Pool;
  let agentRaw: pg.Pool;
  let store: PgFleetStore;
  let svc: PgFleetStore;
  let gw: PgAgentGateway;
  let ledger: PgLedgerAdmin;
  let genesis: PgGenesisAdmin;
  const q = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;
  const code = (p: Promise<unknown>) => p.then(() => "OK", (e: Error) => /FLEET_[A-Z_]+|permission denied/.exec(e.message)?.[0] ?? e.message.slice(0, 100));
  let F: Who = { id: "", token: "" };
  let G: Who = { id: "", token: "" }; // a second founder (evidence isolation)

  async function founders(n: number, allocation: number): Promise<Who[]> {
    await q(`UPDATE fleet.fleet_genesis_policy SET genesis_max_founders = $1`, [n]);
    const g = await genesis.propose({ idempotencyKey: `g:${crypto.randomUUID()}`, founderCount: n, allocationCents: allocation, ttlS: 3600, actor: OWNER });
    await genesis.approve(g.genesisId, g.authSha256, OWNER);
    const p = await genesis.provision(g.genesisId, OWNER);
    for (const id of p.founderIds!) await genesis.attest(g.genesisId, id, (await simulateRuntimeAttestation(genesis, genesis, g.genesisId, id, OWNER)).host, OWNER);
    await genesis.fund(g.genesisId, OWNER);
    const toks = p.founderIds!.map((id) => ({ id, token: mintAgentToken(id) }));
    await genesis.activateWithHashes(g.genesisId, g.authSha256, toks.map((t) => hashAgentToken(t.token)), OWNER);
    return toks;
  }

  async function setup(allocation = 5_000) {
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await wipeRegistry(c, "fleet");
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    await store.setApprovedRuntime({ repo: "https://github.com/5l4mm3r/automaton-fleet", commit: "c".repeat(40) }, "test", { buildId: "d".repeat(64), lockfileSha256: "e".repeat(64) });
    await store.setMaxAgents(2, "test");
    await genesis.setEnabled(true, OWNER, "test");
    await ledger.recordOwnerFunding(allocation * 4, `bank:${crypto.randomUUID()}`, OWNER);
    [F, G] = await founders(2, allocation);
    await genesis.experimentPolicySet(true, null, OWNER);
    for (const [t, m] of [["T2", "claude-sonnet-5-5"], ["T3", "claude-opus-5-5"]]) {
      await genesis.cognitionTierVerify(t, m, "test: models api 200", OWNER);
      await genesis.cognitionTierEnable(t, true, OWNER);
    }
    modelLog.length = 0;
  }

  /**
   * A page this founder fetched through the controller: the research record (attempt + result with the page hash) and,
   * unless artifact:false, the evidence artifact the controller keeps at fetch time. Cited with its relevance claim.
   */
  async function page(agent: string, host: string, o: { outcome?: "fetched" | "failed"; text?: string; artifact?: boolean; supports?: string } = {}): Promise<Item> {
    const id = crypto.randomUUID();
    const outcome = o.outcome ?? "fetched";
    const text = o.text ?? `Forum thread on ${host}: landlords asked for a simple rent-tracking spreadsheet and several said they would pay £10-£15 for one.`;
    const sha = crypto.createHash("sha256").update(text).digest("hex");
    await q(`INSERT INTO fleet.fleet_research_attempts (attempt_id, agent_id, requested_url, requested_host, purpose, decision) VALUES ($1, $2, $3, $4, 'test research', 'authorized')`,
      [id, agent, `https://${host}/page`, host]);
    await q(`INSERT INTO fleet.fleet_research_results (attempt_id, outcome, failure_code, final_url, http_status, content_type, bytes, text_chars, content_sha256, latency_ms)
             VALUES ($1, $2, $3, $4, 200, 'text/html', 100, 80, $5, 10)`, [id, outcome, outcome === "failed" ? "RESEARCH_UPSTREAM" : null, `https://${host}/page`, outcome === "fetched" ? sha : null]);
    if (outcome === "fetched" && o.artifact !== false) {
      const art = buildEvidenceArtifact({ sha256: sha, finalUrl: `https://${host}/page`, title: `${host} thread`, text })!;
      expect(await svc.researchArtifactRecord(agent, id, art)).toMatchObject({ ok: true });
    }
    return { attemptId: id, sha256: sha, supports: o.supports ?? "demand", rationale: `Landlords on ${host} ask for a simple rent-tracking sheet.` };
  }

  /**
   * The assessor's model, scripted from markers in the page text: a genuine demand page supports 'demand' with a verbatim
   * quote; MIXED is ambiguous at every tier; T3RESOLVES is ambiguous at T2 and supports at T3; CONTRADICT contradicts;
   * FABRICATE claims support with a quote that is not on the page; anything else does not bear on the claim.
   */
  const modelLog: Array<{ tier: string; model: string; agentId: string; system: string; prompt: string }> = [];
  const scripted: ProviderFactory = (c: TierCandidate) => ({
    id: "scripted" as const, model: c.model,
    async chat(req) {
      const prompt = String(req.messages[0].content);
      modelLog.push({ tier: c.tier, model: c.model, agentId: req.agentId, system: req.system, prompt });
      const page = prompt.slice(prompt.indexOf("<page"));
      const say = (x: Record<string, unknown>) => ({ content: JSON.stringify(x), toolCalls: [], usage: { inputTokens: 1_200, outputTokens: 150 }, usageSource: "provider" as const, attempts: 1 });
      if (page.includes("FABRICATE")) return say({ stance: "supports", supports: "demand", quotes: ["thousands of landlords pre-ordered"], reason: "strong demand" });
      if (page.includes("MIXED") || (page.includes("T3RESOLVES") && c.tier === "T2")) return say({ stance: "mixed", supports: "demand", quotes: [], reason: "some want it, some do not" });
      if (page.includes("CONTRADICT")) return say({ stance: "contradicts", supports: "none", quotes: ["landlords said they would never pay"], reason: "evidence against demand" });
      if (page.includes("landlords asked for a simple rent-tracking spreadsheet") || page.includes("T3RESOLVES")) {
        return say({ stance: "supports", supports: "demand", quotes: [page.includes("T3RESOLVES") ? "T3RESOLVES landlords want" : "landlords asked for a simple rent-tracking spreadsheet"], reason: "landlords ask for it and name a price" });
      }
      return say({ stance: "neutral", supports: "none", quotes: [], reason: "the page is about something else" });
    },
  });
  let assessor: RelevanceAssessor;
  const relevancePorts = () => ({ relevancePending: (n: number) => svc.relevancePending(n), relevanceRecord: (...a: Parameters<PgFleetStore["relevanceRecord"]>) => svc.relevanceRecord(...a),
    relevanceCallFailed: (...a: Parameters<PgFleetStore["relevanceCallFailed"]>) => svc.relevanceCallFailed(...a) });
  /** One pass of the controller's independent relevance assessor (the reaper and the request path run the same pass). */
  const settle = () => assessor.runOnce(50);
  const expJson = async (id: string) => (await q(`SELECT fleet.fleet_experiment_json(e) AS j FROM fleet.fleet_experiments e WHERE experiment_id = $1`, [id]))[0].j as Record<string, any>;
  const proposal = (over: Record<string, unknown> = {}) => ({
    opportunityKey: "bookkeeping-templates",
    hypothesis: "Small landlords will pay £12 for a rent-tracking spreadsheet template sold on a marketplace.",
    evidence: [] as Item[], claimedLevel: 2,
    uncertainty: "Demand may be seasonal; listing fees may change.",
    objective: "Establish whether a £12 template gets 3 sales in 14 days.",
    requestedMinor: 800, maxLossMinor: 600, timeToSignalS: 86_400,
    successCriteria: [{ metric: "sales", op: ">=", value: 3 }],
    failureCriteria: [{ metric: "sales", op: "<", value: 1 }, { metric: "refund_rate", op: ">=", value: 0.5 }],
    stopConditions: [{ kind: "spend_at_least", value: 600 }, { kind: "metric", metric: "refund_rate", op: ">=", value: 0.5 }],
    expiresInS: 7 * 86_400, reversibility: "reversible", dependencies: ["marketplace seller account (owner)"],
    revenuePath: "Template sales on the marketplace, net of fees.",
    expectedPayoff: { simulatedRevenueMinor: 3_600, learningValue: "Whether landlords buy templates at £12." },
    executionSteps: ["Draft the template", "Write the listing", "Publish (simulated)", "Measure sales for 14 days"],
    ...over,
  });
  const propose = (who: Who, p: Record<string, unknown>, idem = `exp:${crypto.randomUUID()}`) => gw.experimentPropose(who.id, who.token, idem, p);
  const exp = (r: Record<string, unknown>) => r.experiment as Record<string, any>;
  /** An audited owner override of one item (optional; never needed for ordinary evidence). */
  const override = (experimentId: string, item: Item, verdict: "relevant" | "irrelevant" | "uncertain", actor = OWNER) =>
    genesis.experimentAssessRelevance(experimentId, item.attemptId, verdict, actor, `${verdict}: owner read the page`);
  /** Propose, then let the controller's assessor judge every cited item: the controller's decision after relevance. */
  const proposeAssessed = async (who: Who, p: Record<string, unknown>, idem?: string): Promise<Record<string, any>> => {
    const r = await propose(who, p, idem);
    if (!r.ok || !((p.evidence ?? []) as Item[]).length) return r;
    await settle();
    return { ok: true, proposed: r, experiment: await expJson(exp(r).experimentId) };
  };
  const rec = (who: Who, experimentId: string, r: Record<string, unknown>) =>
    gw.experimentRecord(who.id, who.token, { experimentId, idempotencyKey: `rec:${crypto.randomUUID()}`, ...r } as never);
  const inTime = async (sql: string, params: unknown[]) => {
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('fleet.experiment_op', 'on', true)`);
      await c.query(sql, params);
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  };
  const ledgerHead = async () => (await q(`SELECT head_seq::text AS s, head_hash AS h, (SELECT count(*)::int FROM fleet.fleet_ledger_journal) AS j FROM fleet.fleet_ledger_head`))[0];
  /** Realized external revenue of a founder recorded by the owner (a real ledger journal; returns its id). */
  const revenue = async (agent: string, amount: number) => (await q(`SELECT fleet.fleet_admin_record_external('external_revenue', $1, $2, $3, $4, $5, $6) AS j`,
    [agent, amount, `stripe:${crypto.randomUUID()}`, crypto.createHash("sha256").update(`customer:${crypto.randomUUID()}`).digest("hex"), OWNER, `rev:${crypto.randomUUID()}`]))[0].j as string;
  /** A running experiment on an opportunity with controller-recorded sales (concluded by the caller). */
  const running = async (who: Who, key: string, sales: number) => {
    const r = await proposeAssessed(who, proposal({ opportunityKey: key, evidence: [await page(who.id, `${key}-a.example`), await page(who.id, `${key}-b.example`)] }));
    const id = exp(r).experimentId as string;
    await gw.experimentStart(who.id, who.token, id);
    await genesis.experimentObserve(id, `obs:${crypto.randomUUID()}`, "sales", sales, "synthetic executor (simulated)", OWNER);
    return id;
  };

  beforeAll(async () => {
    pgc = await startEphemeralPg(PG_BIN!);
    owner = new pg.Pool({ connectionString: pgc.ownerUrl, max: 4 });
    svcRaw = new pg.Pool({ connectionString: pgc.serviceUrl, max: 2 });
    agentRaw = new pg.Pool({ connectionString: pgc.agentUrl, max: 2 });
    store = new PgFleetStore({ connectionString: pgc.ownerUrl });
    await store.migrate();
    svc = new PgFleetStore({ connectionString: pgc.serviceUrl });
    gw = new PgAgentGateway({ connectionString: pgc.agentUrl });
    ledger = new PgLedgerAdmin({ connectionString: pgc.ownerUrl });
    genesis = new PgGenesisAdmin({ connectionString: pgc.ownerUrl });
    assessor = new RelevanceAssessor({ ports: relevancePorts(), providerFactory: scripted });
  }, 180_000);

  afterAll(async () => {
    await genesis?.close();
    await ledger?.close();
    await gw?.close();
    await svc?.close();
    await store?.close();
    await agentRaw?.end();
    await svcRaw?.end();
    await owner?.end();
    pgc?.stop();
  });

  it("migrates to v24 with a clean privilege audit; the pipeline is off by default, pinned to simulated money and simulation-only caps", async () => {
    await setup();
    expect((await q(`SELECT max(version)::int AS v FROM fleet.fleet_schema_migrations`))[0].v).toBe(24);
    expect((await store.auditPrivileges()).problems).toEqual([]);
    await genesis.experimentPolicySet(false, null, OWNER);
    expect(await propose(F, proposal())).toMatchObject({ ok: false, code: "FLEET_EXPERIMENTS_DISABLED" });
    expect(await code(q(`UPDATE fleet.fleet_experiment_policy SET financial_mode = 'real'`))).toMatch(/violates check constraint|FLEET/);
    expect(await code(q(`UPDATE fleet.fleet_evidence_ladder SET cap_scope = 'real_money'`))).toMatch(/violates check constraint|FLEET/);
    expect((await q(`SELECT level, code, auto_cap_minor, cap_scope FROM fleet.fleet_evidence_ladder ORDER BY level`)).map((r) => [r.level, r.code, r.auto_cap_minor === null ? null : Number(r.auto_cap_minor), r.cap_scope]))
      .toEqual([[0, "claim", 0, "simulation_only"], [1, "desk_single", 300, "simulation_only"], [2, "desk_corroborated", 1000, "simulation_only"],
        [3, "observed_signal", 2500, "simulation_only"], [4, "revenue", null, "simulation_only"]]);
    expect(await code(genesis.evidenceLadderSet(0, 100, OWNER))).toBe("FLEET_BAD_REQUEST"); // an unverified claim never earns capital
  });

  it("(1) a valid opportunity with verified, corroborated, relevant evidence becomes an approved, bounded experiment — decided by the controller", async () => {
    await setup();
    const ev = [await page(F.id, "example.com"), await page(F.id, "marketplace.example")];
    const r = await proposeAssessed(F, proposal({ evidence: ev }));
    expect(r.ok).toBe(true);
    expect(exp(r)).toMatchObject({ status: "approved", claimedLevel: 2, verifiedLevel: 2, requestedMinor: 800, approvedMinor: 800, approvedMaxLossMinor: 600, decidedBy: "controller",
      decisionCode: "FLEET_EXPERIMENT_APPROVED", financialMode: "simulated", executed: false, evidence: { verified: 2, relevant: 2, unassessed: 0 } });
    const view = await genesis.experimentView(exp(r).experimentId);
    expect((view!.transitions as Array<Record<string, unknown>>).map((t) => [t.from_status, t.to_status, t.actor_kind, t.code]))
      .toEqual([[null, "proposed", "founder", "FLEET_EXPERIMENT_PROPOSED"], ["proposed", "watch", "controller", "FLEET_RELEVANCE_PENDING"],
        ["watch", "approved", "controller", "FLEET_EXPERIMENT_APPROVED"]]);
    expect((view!.verified_evidence as { items: Array<{ host: string; supports: string }> }).items.map((i) => [i.host, i.supports])).toEqual([["example.com", "demand"], ["marketplace.example", "demand"]]);
    // Every required field is on record, as proposed; the proposal is immutable.
    expect(view!.proposal).toMatchObject({ opportunityKey: "bookkeeping-templates", expectedPayoff: { simulatedRevenueMinor: 3_600 }, reversibility: "reversible", executionSteps: expect.any(Array) });
    expect(await code(inTime(`UPDATE fleet.fleet_experiments SET requested_minor = 5000 WHERE experiment_id = $1`, [exp(r).experimentId]))).toBe("FLEET_HISTORY_IMMUTABLE");
  });

  it("(2) insufficient evidence goes to WATCH (never capital); over the hard cap is rejected; added evidence re-decides a watched proposal once assessed", async () => {
    await setup();
    const w = await propose(F, proposal({ claimedLevel: 3 }));
    expect(exp(w)).toMatchObject({ status: "watch", claimedLevel: 3, verifiedLevel: 0, approvedMinor: null, decisionCode: "FLEET_EVIDENCE_INSUFFICIENT" });
    expect(exp(w).decisionReason).toMatch(/claimed E3, verified E0/);
    const big = await propose(F, proposal({ requestedMinor: 9_000, maxLossMinor: 9_000, evidence: [await page(F.id, "a.example")] }));
    expect(exp(big)).toMatchObject({ status: "rejected", decisionCode: "FLEET_EXPERIMENT_OVER_CAP" });
    // Evidence arrives for the watched proposal: re-verified (provenance), still watched until its relevance is assessed.
    const ev = [await page(F.id, "b.example"), await page(F.id, "c.example")];
    const more = await gw.experimentAddEvidence(F.id, F.token, exp(w).experimentId, `ev:${crypto.randomUUID()}`, ev);
    expect(exp(more)).toMatchObject({ status: "watch", verifiedLevel: 0, decisionCode: "FLEET_RELEVANCE_PENDING", evidence: { verified: 2, relevant: 0, unassessed: 2 } });
    await settle();
    expect(await expJson(exp(w).experimentId)).toMatchObject({ status: "approved", verifiedLevel: 2, approvedMinor: 800 });
    // A rejected proposal is final.
    expect(await code(genesis.experimentDecide(exp(big).experimentId, "approved", 9_000, null, OWNER, "try"))).toBe("FLEET_INVALID_STATE");
  });

  it("(3) partial approval: the evidence level caps the budget, and survival headroom caps the maximum loss", async () => {
    await setup(1_500);
    const single = await proposeAssessed(F, proposal({ evidence: [await page(F.id, "one.example")] }));
    expect(exp(single)).toMatchObject({ status: "partially_approved", verifiedLevel: 1, requestedMinor: 800, approvedMinor: 300, approvedMaxLossMinor: 300, decisionCode: "FLEET_EXPERIMENT_PARTIAL" });
    const ev2 = [await page(F.id, "two.example"), await page(F.id, "three.example")];
    const a = await proposeAssessed(F, proposal({ opportunityKey: "second-opp", requestedMinor: 1_000, maxLossMinor: 1_000, evidence: ev2 }));
    // Cash 1500: 300 already committed as maximum loss → headroom 1200 → full approval of 1000.
    expect(exp(a)).toMatchObject({ status: "approved", approvedMinor: 1_000, approvedMaxLossMinor: 1_000 });
    const b = await proposeAssessed(F, proposal({ opportunityKey: "third-opp", requestedMinor: 1_000, maxLossMinor: 1_000, evidence: [await page(F.id, "four.example"), await page(F.id, "five.example")] }));
    // Headroom now 1500 − 300 − 1000 = 200: the budget stays within the E2 cap, the maximum loss shrinks to the headroom.
    expect(exp(b)).toMatchObject({ status: "partially_approved", approvedMinor: 1_000, approvedMaxLossMinor: 200 });
    // A founder holds at most max_active_per_founder open experiments (3 by default).
    const six = await page(F.id, "six.example");
    const irreversible = proposal({ opportunityKey: "fourth-opp", reversibility: "irreversible", requestedMinor: 100, maxLossMinor: 100, evidence: [six] });
    expect(await propose(F, irreversible)).toMatchObject({ ok: false, code: "FLEET_EXPERIMENT_LIMIT" });
    await q(`UPDATE fleet.fleet_experiment_policy SET max_active_per_founder = 10`);
    // All of F's survival headroom is committed (300 + 1000 + 200 of 1500): protected capital refuses before anything else.
    expect(exp(await proposeAssessed(F, irreversible))).toMatchObject({ status: "rejected", decisionCode: "FLEET_PROTECTED_CAPITAL" });
    // G has headroom: an irreversible experiment is returned to the owner (watch → proposed), who may decide it partially.
    const w = await proposeAssessed(G, { ...irreversible, evidence: [await page(G.id, "seven.example")] });
    expect(exp(w)).toMatchObject({ status: "proposed", decisionCode: "FLEET_OWNER_DECISION_REQUIRED", approvedMinor: null });
    expect(await code(genesis.experimentDecide(exp(w).experimentId, "partially_approved", 101, null, OWNER, "too much"))).toBe("FLEET_BAD_REQUEST");
    expect(await genesis.experimentDecide(exp(w).experimentId, "partially_approved", 50, 50, OWNER, "half, as a probe")).toMatchObject({ status: "partially_approved", approvedMinor: 50, decidedBy: OWNER });
  });

  it("(4) the budget cannot be exceeded; (8) a stop condition (maximum loss, or a metric) ends the experiment with a result", async () => {
    await setup();
    const r = await proposeAssessed(F, proposal({ evidence: [await page(F.id, "x.example"), await page(F.id, "y.example")] }));
    const id = exp(r).experimentId as string;
    expect(await rec(F, id, { kind: "sim_spend", amountMinor: 100 })).toMatchObject({ ok: false, code: "FLEET_EXPERIMENT_NOT_STARTED" });
    expect(exp(await gw.experimentStart(F.id, F.token, id))).toMatchObject({ status: "running" });
    expect(exp(await rec(F, id, { kind: "sim_spend", amountMinor: 400 }))).toMatchObject({ status: "running", simSpentMinor: 400 });
    expect(await rec(F, id, { kind: "sim_spend", amountMinor: 250 })).toMatchObject({ ok: false, code: "FLEET_BUDGET_EXCEEDED" }); // 650 > max loss 600
    expect(exp(await rec(F, id, { kind: "step", note: "listing drafted" }))).toMatchObject({ simSpentMinor: 400 });
    // Nobody can raise the spend or the budget outside the functions.
    expect(await code(q(`UPDATE fleet.fleet_experiments SET sim_spent_minor = 0 WHERE experiment_id = $1`, [id]))).toBe("FLEET_EXPERIMENT_OP_REQUIRED");
    expect(await code(inTime(`UPDATE fleet.fleet_experiments SET approved_minor = 5000 WHERE experiment_id = $1`, [id]))).toBe("FLEET_HISTORY_IMMUTABLE");
    // Spending up to the maximum loss is the implicit (and explicit) stop condition.
    const stop = await rec(F, id, { kind: "sim_spend", amountMinor: 200 });
    expect(stop).toMatchObject({ ok: true, stopped: "max loss reached" });
    expect(exp(stop)).toMatchObject({ status: "stopped", simSpentMinor: 600, result: { outcome: "stopped", actualSpendMinor: 600 } });
    expect(await rec(F, id, { kind: "sim_spend", amountMinor: 1 })).toMatchObject({ ok: false, code: "FLEET_INVALID_STATE" });
    // A metric stop (even the founder's own report: stopping early is conservative).
    const m = await proposeAssessed(F, proposal({ opportunityKey: "metric-stop", evidence: [await page(F.id, "m1.example"), await page(F.id, "m2.example")] }));
    const mid = exp(m).experimentId as string;
    await gw.experimentStart(F.id, F.token, mid);
    const ms = await rec(F, mid, { kind: "observation", metric: "refund_rate", value: 0.6 });
    expect(ms).toMatchObject({ ok: true, stopped: "refund_rate >= 0.5" });
    expect(exp(ms).result).toMatchObject({ outcome: "stopped" });
  });

  it("(5) an expired approval cannot execute (its simulated capital reverts); the reaper expires stale proposals and approvals", async () => {
    await setup();
    const r = await proposeAssessed(F, proposal({ evidence: [await page(F.id, "e1.example"), await page(F.id, "e2.example")] }));
    const id = exp(r).experimentId as string;
    await inTime(`UPDATE fleet.fleet_experiments SET approval_expires_at = now() - interval '1 second' WHERE experiment_id = $1`, [id]);
    expect(await gw.experimentStart(F.id, F.token, id)).toMatchObject({ ok: false, code: "FLEET_APPROVAL_EXPIRED", experiment: { status: "expired" } });
    expect(await rec(F, id, { kind: "sim_spend", amountMinor: 10 })).toMatchObject({ ok: false, code: "FLEET_INVALID_STATE" });
    // Reaper: a watched proposal past its expiry, and an approval never started in time.
    const w = await propose(F, proposal({ opportunityKey: "stale-watch" }));
    const a = await proposeAssessed(F, proposal({ opportunityKey: "stale-approval", evidence: [await page(F.id, "e3.example"), await page(F.id, "e4.example")] }));
    await inTime(`UPDATE fleet.fleet_experiments SET approval_expires_at = now() - interval '1 second' WHERE experiment_id = $1`, [exp(a).experimentId]);
    const c = await owner.connect();
    try {
      // (expires_at is part of the immutable proposal: simulate the passage of time on the clock instead)
      await c.query("BEGIN");
      await c.query(`ALTER TABLE fleet.fleet_experiments DISABLE TRIGGER fleet_experiments_guard`);
      await c.query(`UPDATE fleet.fleet_experiments SET expires_at = now() - interval '1 second' WHERE experiment_id = $1`, [exp(w).experimentId]);
      await c.query(`ALTER TABLE fleet.fleet_experiments ENABLE TRIGGER fleet_experiments_guard`);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    expect(await svc.reapExperiments(50)).toBe(2);
    const st = await q(`SELECT experiment_id, status FROM fleet.fleet_experiments WHERE experiment_id IN ($1, $2)`, [exp(w).experimentId, exp(a).experimentId]);
    expect(st.map((x) => x.status).sort()).toEqual(["expired", "expired"]);
    const codes = await q(`SELECT code FROM fleet.fleet_experiment_transitions WHERE experiment_id IN ($1, $2) AND to_status = 'expired' ORDER BY code`, [exp(w).experimentId, exp(a).experimentId]);
    expect(codes.map((x) => x.code)).toEqual(["FLEET_APPROVAL_EXPIRED", "FLEET_EXPIRED"]);
  });

  it("(6) a founder cannot self-approve, size its budget, assess its own evidence, change policy or alter its evidence level", async () => {
    await setup();
    const w = await propose(F, proposal());
    const id = exp(w).experimentId as string;
    // No owner function is executable by the agent role; no table is writable or readable.
    for (const sql of [`SELECT fleet.fleet_experiment_decide($1, 'approved', 800, 600, 'operator:x', 'self')`, `SELECT fleet.fleet_experiment_conclude($1, 'operator:x', 'x', 4::smallint)`,
      `SELECT fleet.fleet_experiment_observe($1, 'obs:self-00001', 'sales', 99, 'self', 'operator:x')`,
      `SELECT fleet.fleet_experiment_assess_relevance($1, $1, 'relevant', 'operator:x', 'self')`, `SELECT fleet.fleet_experiment_attribute_revenue($1, $1, 'operator:x', 'self')`]) {
      expect(await code(agentRaw.query(sql, [id]))).toBe("permission denied");
    }
    expect(await code(agentRaw.query(`SELECT fleet.fleet_experiment_policy_set(true, 999999, 'operator:x')`))).toBe("permission denied");
    expect(await code(agentRaw.query(`SELECT fleet.fleet_evidence_ladder_set(1::smallint, 999999, 'operator:x')`))).toBe("permission denied");
    expect(await code(agentRaw.query(`UPDATE fleet.fleet_experiments SET status = 'approved'`))).toBe("permission denied");
    expect(await code(agentRaw.query(`SELECT * FROM fleet.fleet_experiments`))).toBe("permission denied");
    expect(await code(agentRaw.query(`SELECT * FROM fleet.fleet_experiment_relevance`))).toBe("permission denied");
    expect(await code(svcRaw.query(`SELECT fleet.fleet_experiment_decide($1, 'approved', 800, 600, 'operator:x', 'x')`, [id]))).toBe("permission denied");
    expect(await code(svcRaw.query(`SELECT fleet.fleet_experiment_assess_relevance($1, $1, 'relevant', 'operator:x', 'x')`, [id]))).toBe("permission denied");
    // The owner path refuses the founder's own identity as approver or relevance assessor.
    expect(await code(genesis.experimentDecide(id, "approved", 800, 600, `operator:${F.id}`, "self"))).toBe("FLEET_SELF_APPROVAL");
    // A proposal cannot carry decision fields or its own verified level.
    for (const k of ["approvedMinor", "status", "verifiedLevel", "decidedBy"]) {
      expect(await propose(F, { ...proposal(), [k]: 1 })).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
    }
    // Claiming E4 buys nothing: the level is the registry's.
    const only = await page(F.id, "only.example");
    const claim = await propose(F, proposal({ opportunityKey: "overclaim", claimedLevel: 4, evidence: [only] }));
    expect(exp(claim)).toMatchObject({ claimedLevel: 4, verifiedLevel: 0, status: "watch" });
    expect(await code(override(exp(claim).experimentId, only, "relevant", `operator:${F.id}`))).toBe("FLEET_SELF_APPROVAL");
    await settle();
    expect(await expJson(exp(claim).experimentId)).toMatchObject({ claimedLevel: 4, verifiedLevel: 1, approvedMinor: 300 });
  });

  it("(16) provenance is not relevance: the founder claims relevance, the independent assessor rejects it; genuine support is accepted", async () => {
    await setup();
    // Two genuinely fetched, unaltered pages from two hosts, each claimed by the founder to show demand.
    const weather = await page(F.id, "weather.example", { text: "Sunny spells tomorrow with light winds from the west and a high of 18 degrees." });
    const recipes = await page(F.id, "recipes.example", { text: "Whisk two eggs with milk, add flour gradually and rest the batter for an hour." });
    const r = await propose(F, proposal({ claimedLevel: 2, evidence: [weather, recipes] }));
    const id = exp(r).experimentId as string;
    // Provenance alone: E0, WATCH, pending the controller's assessment (no owner involved).
    expect(exp(r)).toMatchObject({ status: "watch", verifiedLevel: 0, decisionCode: "FLEET_RELEVANCE_PENDING", evidence: { verified: 2, relevant: 0, unassessed: 2 } });
    expect(await settle()).toEqual({ assessed: 2, deferred: 0 });
    expect(await expJson(id)).toMatchObject({ status: "watch", verifiedLevel: 0, approvedMinor: null, decisionCode: "FLEET_EVIDENCE_INSUFFICIENT",
      evidence: { verified: 2, relevant: 0, irrelevant: 2, unassessed: 0, overridden: 0 } });
    const view = (await genesis.experimentView(id))! as Record<string, any>;
    // Each verdict is explicit: the controller, the tier (T2: the normal judgement), the artifact it judged, the reason.
    expect(view.relevance.map((x: Record<string, any>) => [x.attempt_id, x.verdict, x.assessed_by, x.assessor_kind, x.tier, x.refs.contentSha256, x.cognition.length]))
      .toEqual([[weather.attemptId, "irrelevant", "controller", "controller", "T2", weather.sha256, 1], [recipes.attemptId, "irrelevant", "controller", "controller", "T2", recipes.sha256, 1]]);
    expect(view.relevance[0].reason).toMatch(/does not bear on the claim/);
    expect(view.relevance[0].artifact_excerpt_sha256).toMatch(/^[0-9a-f]{64}$/);
    // Genuinely supporting evidence is accepted by the same assessor, with a verbatim quote of the preserved artifact.
    const ev = [await page(F.id, "landlord-forum.example"), await page(F.id, "letting-agents.example")];
    const ok = await proposeAssessed(F, proposal({ opportunityKey: "genuine-demand", evidence: ev }));
    expect(exp(ok)).toMatchObject({ status: "approved", verifiedLevel: 2, approvedMinor: 800, decidedBy: "controller", evidence: { relevant: 2, overridden: 0 } });
    const gv = (await genesis.experimentView(exp(ok).experimentId))! as Record<string, any>;
    expect(gv.relevance[0]).toMatchObject({ verdict: "relevant", tier: "T2", refs: { quotes: ["landlords asked for a simple rent-tracking spreadsheet"] } });
    // The founder's own rationale never reaches the assessor (its judgement is independent of the founder's argument).
    expect(modelLog.every((m) => !m.prompt.includes("ask for a simple rent-tracking sheet") && m.agentId === "controller")).toBe(true);
    // Verdicts are final and immutable; no direct write.
    expect(await code(inTime(`UPDATE fleet.fleet_experiment_relevance SET verdict = 'relevant' WHERE experiment_id = $1`, [id]))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await code(q(`INSERT INTO fleet.fleet_experiment_relevance (experiment_id, attempt_id, content_sha256, supports, verdict, assessed_by, assessor_kind, tier, reason)
                          VALUES ($1, $2, $3, 'demand', 'relevant', 'controller', 'controller', 'T2', 'sneak')`, [id, weather.attemptId, weather.sha256]))).toBe("FLEET_EXPERIMENT_OP_REQUIRED");
    expect(await code(agentRaw.query(`SELECT fleet.svc_experiment_relevance_record($1, $1, 'relevant', 'T2', 'self', '{}'::jsonb, '[]'::jsonb)`, [id]))).toBe("permission denied");
    expect((await store.auditPrivileges()).problems).toEqual([]);
  });

  it("(19) hash/source mismatch fails closed; a missing artifact cannot earn E1/E2; a fabricated quote is not relevance", async () => {
    await setup();
    // The artifact is bound to the research record: same page hash, same host, this founder's fetched attempt.
    const text = "landlords asked for a simple rent-tracking spreadsheet";
    const base = await page(F.id, "bound.example", { artifact: false, text });
    const art = buildEvidenceArtifact({ sha256: base.sha256, finalUrl: "https://bound.example/page", title: null, text })!;
    expect(await svc.researchArtifactRecord(F.id, base.attemptId, { ...art, sha256: "0".repeat(64) })).toMatchObject({ ok: false, code: "FLEET_ARTIFACT_HASH_MISMATCH" });
    expect(await svc.researchArtifactRecord(F.id, base.attemptId, { ...art, host: "elsewhere.example" })).toMatchObject({ ok: false, code: "FLEET_ARTIFACT_SOURCE_MISMATCH" });
    expect(await svc.researchArtifactRecord(G.id, base.attemptId, art)).toMatchObject({ ok: false, code: "FLEET_ARTIFACT_NO_FETCH" });
    const failed = await page(F.id, "down.example", { outcome: "failed" });
    expect(await svc.researchArtifactRecord(F.id, failed.attemptId, art)).toMatchObject({ ok: false, code: "FLEET_ARTIFACT_NO_FETCH" });
    expect(await svc.researchArtifactRecord(F.id, base.attemptId, art)).toMatchObject({ ok: true });
    expect(await svc.researchArtifactRecord(F.id, base.attemptId, art)).toMatchObject({ ok: false, code: "FLEET_DUPLICATE_EVENT" });
    // Pages without an artifact: T0 (software, no model call) → uncertain → no level, WATCH, never capital.
    const bare = [await page(F.id, "no-artifact-a.example", { artifact: false }), await page(F.id, "no-artifact-b.example", { artifact: false })];
    const r = await proposeAssessed(F, proposal({ opportunityKey: "no-artifacts", evidence: bare }));
    expect(exp(r)).toMatchObject({ status: "watch", verifiedLevel: 0, approvedMinor: null, decisionCode: "FLEET_EVIDENCE_UNCERTAIN", evidence: { uncertain: 2, relevant: 0 } });
    expect(modelLog.length).toBe(0);
    const bv = (await genesis.experimentView(exp(r).experimentId))! as Record<string, any>;
    expect(bv.relevance.map((x: Record<string, any>) => [x.verdict, x.tier, x.cognition.length])).toEqual([["uncertain", "T0", 0], ["uncertain", "T0", 0]]);
    // A 'relevant' verdict must quote the artifact verbatim — the registry refuses anything else, whoever sends it.
    const liar = await page(F.id, "fabricate.example", { text: "FABRICATE a page about something: landlords asked about the weather." });
    const lr = await propose(F, proposal({ opportunityKey: "fabricated-quote", evidence: [liar] }));
    const lid = exp(lr).experimentId as string;
    const artRow = (await q(`SELECT excerpt_sha256 FROM fleet.fleet_research_evidence_artifacts WHERE attempt_id = $1`, [liar.attemptId]))[0];
    expect(await svc.relevanceRecord(lid, liar.attemptId, "relevant", "T2", "trust me", { excerptSha256: artRow.excerpt_sha256, quotes: ["thousands of landlords pre-ordered"] }, []))
      .toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" }); // (a model verdict needs its call on record)
    const call = [{ requestId: crypto.randomUUID(), provider: "anthropic", tier: "T2", model: "claude-sonnet-5-5", inputTokens: 10, outputTokens: 5, usdMicrocents: 3000, stance: "supports" }];
    expect(await svc.relevanceRecord(lid, liar.attemptId, "relevant", "T2", "trust me", { excerptSha256: artRow.excerpt_sha256, quotes: ["thousands of landlords pre-ordered"] }, call))
      .toMatchObject({ ok: false, code: "FLEET_RELEVANCE_UNVERIFIED" });
    expect(await svc.relevanceRecord(lid, liar.attemptId, "relevant", "T2", "trust me", { excerptSha256: "f".repeat(64), quotes: ["landlords asked about the weather"] }, [{ ...call[0], requestId: crypto.randomUUID() }]))
      .toMatchObject({ ok: false, code: "FLEET_RELEVANCE_UNVERIFIED" });
    // (both refused verdicts' inference is still accounted as provider consumption)
    expect((await q(`SELECT count(*)::int AS n FROM fleet.fleet_provider_credit_events WHERE recorded_by = 'controller:evidence_relevance'`))[0].n).toBe(2);
    // Through the assessor: the model's fabricated quote is not on the page → uncertain, after one T3 look.
    await settle();
    expect(await expJson(lid)).toMatchObject({ status: "watch", decisionCode: "FLEET_EVIDENCE_UNCERTAIN", evidence: { uncertain: 1 } });
  });

  it("(20) conflicting or ambiguous evidence is uncertain (T3 only then); uncertain never auto-approves; the owner override is audited, optional", async () => {
    await setup();
    const head0 = await ledgerHead();
    const good = await page(F.id, "good.example");
    const mixed = await page(F.id, "mixed.example", { text: "MIXED reviews: some landlords want a tracker, others say spreadsheets are pointless." });
    const r = await proposeAssessed(F, proposal({ opportunityKey: "mixed-signal", evidence: [good, mixed] }));
    const id = exp(r).experimentId as string;
    // One relevant page and one ambiguous page: never an automatic approval, whatever the relevant page is worth.
    expect(exp(r)).toMatchObject({ status: "watch", verifiedLevel: 1, approvedMinor: null, decisionCode: "FLEET_EVIDENCE_UNCERTAIN", evidence: { relevant: 1, uncertain: 1 } });
    const view = (await genesis.experimentView(id))! as Record<string, any>;
    const m = view.relevance.find((x: Record<string, any>) => x.attempt_id === mixed.attemptId);
    // Ambiguous at T2 → one question-scoped escalation to T3 (EVIDENCE_CONFLICT) → still ambiguous → uncertain.
    expect(m).toMatchObject({ verdict: "uncertain", tier: "T3" });
    expect(m.cognition.map((c: Record<string, any>) => [c.tier, c.model, c.stance, c.route.escalationReason])).toEqual([["T2", "claude-sonnet-5-5", "mixed", null], ["T3", "claude-opus-5-5", "mixed", "EVIDENCE_CONFLICT"]]);
    // The clear page never went above T2.
    expect(view.relevance.find((x: Record<string, any>) => x.attempt_id === good.attemptId)).toMatchObject({ verdict: "relevant", tier: "T2" });
    // A contradicting page is conflicting evidence: uncertain.
    const contra = await page(F.id, "contra.example", { text: "CONTRADICT: surveyed landlords said they would never pay for a template." });
    const c = await proposeAssessed(F, proposal({ opportunityKey: "contradicted", evidence: [contra] }));
    expect(exp(c)).toMatchObject({ status: "watch", decisionCode: "FLEET_EVIDENCE_UNCERTAIN" });
    // Ambiguous at T2 but clear at T3: the escalation resolves it (relevant at T3).
    const t3 = await page(G.id, "t3.example", { text: "T3RESOLVES landlords want a tracker; the thread is long and meandering." });
    const t = await proposeAssessed(G, proposal({ opportunityKey: "t3-resolves", evidence: [t3] }));
    expect(exp(t)).toMatchObject({ status: "partially_approved", verifiedLevel: 1, approvedMinor: 300 });
    // The owner may override (audited), e.g. after reading the mixed page; the controller re-decides. Never required above.
    expect(await code(override(id, mixed, "relevant", `operator:${F.id}`))).toBe("FLEET_SELF_APPROVAL");
    const after = await override(id, mixed, "relevant");
    expect(after).toMatchObject({ status: "approved", verifiedLevel: 2, decidedBy: "controller", evidence: { relevant: 2, uncertain: 0, overridden: 1 } });
    expect(await code(override(id, mixed, "irrelevant"))).toBe("FLEET_INVALID_STATE"); // relevance is settled before the decision
    const ov = (await genesis.experimentView(id))! as Record<string, any>;
    expect(ov.relevance.filter((x: Record<string, any>) => x.attempt_id === mixed.attemptId).map((x: Record<string, any>) => [x.assessor_kind, x.verdict, x.overrides]))
      .toEqual([["controller", "uncertain", null], ["owner", "relevant", "uncertain"]]);
    const ev = await q(`SELECT actor, detail FROM fleet.fleet_events WHERE event_type = 'experiment_relevance_overridden' AND detail ->> 'experimentId' = $1`, [id]);
    expect(ev).toEqual([{ actor: OWNER, detail: expect.objectContaining({ attemptId: mixed.attemptId, verdict: "relevant", controllerVerdict: "uncertain" }) }]);
    // Ordinary evidence needed no owner at all: across every other proposal here, zero owner rows.
    expect((await q(`SELECT count(*)::int AS n FROM fleet.fleet_experiment_relevance WHERE assessor_kind = 'owner'`))[0].n).toBe(1);
    // Consequential proposals (irreversible, or above the E2 cap) are judged at T3 directly.
    const big = await page(F.id, "big.example");
    await q(`UPDATE fleet.fleet_experiment_policy SET max_active_per_founder = 10`);
    modelLog.length = 0;
    await proposeAssessed(F, proposal({ opportunityKey: "bigger", requestedMinor: 2_000, maxLossMinor: 500, evidence: [big] }));
    expect(modelLog.map((x) => x.tier)).toEqual(["T3"]);
    // The assessor's inference is fleet overhead in the provider-credit record: never a ledger posting or a founder charge.
    const credit = await q(`SELECT count(*)::int AS n, COALESCE(sum(usd_microcents), 0)::bigint AS usd FROM fleet.fleet_provider_credit_events WHERE recorded_by = 'controller:evidence_relevance'`);
    expect(credit[0].n).toBeGreaterThan(0);
    expect(Number(credit[0].usd)).toBeLessThan(0);
    expect(await ledgerHead()).toEqual(head0);
  });

  it("(21) relevance cognition is independent of the founder's profitability and history; the work list carries no founder data", async () => {
    await setup();
    await q(`UPDATE fleet.fleet_experiment_policy SET max_active_per_founder = 10`);
    // F becomes 'successful': realized revenue and a succeeded experiment. G has nothing.
    await q(`SELECT fleet.fleet_admin_record_external('external_revenue', $1, 2500, $2, $3, $4, $5)`,
      [F.id, `stripe:${crypto.randomUUID()}`, crypto.createHash("sha256").update("customer:x").digest("hex"), OWNER, `rev:${crypto.randomUUID()}`]);
    const past = await proposeAssessed(F, proposal({ opportunityKey: "past-win", evidence: [await page(F.id, "pw-a.example"), await page(F.id, "pw-b.example")] }));
    await gw.experimentStart(F.id, F.token, exp(past).experimentId);
    await genesis.experimentObserve(exp(past).experimentId, `obs:${crypto.randomUUID()}`, "sales", 9, "synthetic executor (simulated)", OWNER);
    await genesis.experimentConclude(exp(past).experimentId, OWNER, null, null);
    // Identical proposals and identical pages (same host and text) from both founders.
    const same = { text: "MIXED: landlords are split on paying for a rent tracker." };
    const pf = await propose(F, proposal({ opportunityKey: "same-task", evidence: [await page(F.id, "same.example", same)] }));
    const pg2 = await propose(G, proposal({ opportunityKey: "same-task", evidence: [await page(G.id, "same.example", same)] }));
    const work = await svc.relevancePending(50);
    const jobs = work.jobs as Array<Record<string, unknown>>;
    expect(jobs.length).toBe(2);
    for (const j of jobs) expect(Object.keys(j).sort()).toEqual(["artifact", "attemptId", "e2CapMinor", "experimentId", "proposal", "seq", "sha256", "supports"]);
    expect(JSON.stringify(work)).not.toContain(F.id);
    expect(JSON.stringify(work)).not.toContain(G.id);
    expect(JSON.stringify(work)).not.toMatch(/revenue|roi|wealth|balance|history|outcome/i);
    // The route is a function of the task alone: identical for both, and identical to a route computed without any founder.
    expect(relevanceRoute(jobs[0] as unknown as RelevanceJob)).toEqual(relevanceRoute(jobs[1] as unknown as RelevanceJob));
    modelLog.length = 0;
    await settle();
    const byFounder = modelLog.map((m) => ({ tier: m.tier, model: m.model, system: m.system, prompt: m.prompt.replace(/fetched="[^"]+"/, "") }));
    expect(byFounder.length).toBe(4); // T2 then T3 for each (ambiguous)
    expect(byFounder.slice(0, 2)).toEqual(byFounder.slice(2, 4));
    const [vf, vg] = [(await genesis.experimentView(exp(pf).experimentId))! as Record<string, any>, (await genesis.experimentView(exp(pg2).experimentId))! as Record<string, any>];
    expect(vf.relevance.map((x: Record<string, any>) => [x.verdict, x.tier])).toEqual(vg.relevance.map((x: Record<string, any>) => [x.verdict, x.tier]));
    // The relevance source cannot even name founder economics or history (structural check of the assessor module).
    const src = fs.readFileSync("src/fleet/experiments/relevance.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/economics|agent_revenue|strategy_registry|simulated_roi|fleet_experiment_results/);
  });

  it("(22) no raw page dump or credential-shaped material enters a persistent evidence artifact", async () => {
    await setup();
    const secrets = ["sk-ant-api03-" + "A".repeat(40), "-----BEGIN RSA PRIVATE KEY-----\nMIIEow" + "B".repeat(60) + "\n-----END RSA PRIVATE KEY-----",
      "postgres://fleetadmin:hunter2secret@db.example/fleet", "0x" + "c".repeat(64)];
    const body = `<html>` + "Landlords asked for a simple rent-tracking spreadsheet. ".repeat(20) + secrets.join(" leaked ") + " filler ".repeat(8_000);
    const text = body.replace(/<[^>]+>/g, "");
    const sha = crypto.createHash("sha256").update(body).digest("hex");
    const attemptId = crypto.randomUUID();
    await q(`INSERT INTO fleet.fleet_research_attempts (attempt_id, agent_id, requested_url, requested_host, purpose, decision) VALUES ($1, $2, 'https://forum.landlord-talk.co.uk/p', 'forum.landlord-talk.co.uk', 'test', 'authorized')`, [attemptId, F.id]);
    const refused: string[] = [];
    const out = await research({
      capabilities: async () => ({ ok: true }),
      authorize: async () => ({ ok: true, attemptId }),
      record: (a, id, x) => svc.researchRecord(a, id, x),
      recordArtifact: (a, id, x) => svc.researchArtifactRecord(a, id, x),
      artifactRefused: (_a, _id, c) => refused.push(c),
    }, { fetch: async (url: string) => ({ ok: true as const, requestedUrl: url, finalUrl: url, redirects: [], status: 200, contentType: "text/html", title: "Landlord forum",
      text, truncated: false, links: [], bytes: body.length, sha256: sha, fetchedAt: new Date().toISOString(), latencyMs: 5 }) }, F.id, F.token, { url: "https://forum.landlord-talk.co.uk/p", purpose: "demand research" });
    expect(out.sha256).toBe(sha);
    expect(refused).toEqual([]);
    const a = (await q(`SELECT * FROM fleet.fleet_research_evidence_artifacts WHERE attempt_id = $1`, [attemptId]))[0];
    expect(a).toMatchObject({ agent_id: F.id, content_sha256: sha, host: "forum.landlord-talk.co.uk", truncated: true, artifact_version: 1 });
    expect(a.excerpt.length).toBeLessThanOrEqual(6_000);
    expect(a.source_chars).toBe(50_000); // the research text bound; the artifact keeps at most 6000 of it
    expect(a.excerpt).not.toMatch(/<html>/);
    expect(a.redactions).toBeGreaterThan(0);
    for (const s of secrets) expect(a.excerpt).not.toContain(s.slice(0, 20));
    expect(containsSecretShape(a.excerpt)).toBe(false);
    expect((await q(`SELECT fleet.fleet_secret_shaped($1) AS s`, [a.excerpt]))[0].s).toBe(false);
    expect(a.excerpt_sha256).toBe(crypto.createHash("sha256").update(a.excerpt).digest("hex"));
    // Directly, too: the registry refuses a secret-shaped or oversized excerpt, whatever the controller code does.
    const p2 = await page(F.id, "direct.example", { artifact: false, text: "x" });
    const base = { sha256: p2.sha256, host: "direct.example", title: null, sourceChars: 1, truncated: false, redactions: 0 };
    expect(await svc.researchArtifactRecord(F.id, p2.attemptId, { ...base, excerpt: `key ${secrets[0]}` })).toMatchObject({ ok: false, code: "FLEET_ARTIFACT_SECRET_SHAPED" });
    expect(await svc.researchArtifactRecord(F.id, p2.attemptId, { ...base, excerpt: "y".repeat(6_001) })).toMatchObject({ ok: false, code: "FLEET_ARTIFACT_INVALID" });
    expect(await code(inTime(`UPDATE fleet.fleet_research_evidence_artifacts SET excerpt = 'rewritten' WHERE attempt_id = $1`, [attemptId]))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await code(agentRaw.query(`SELECT * FROM fleet.fleet_research_evidence_artifacts`))).toBe("permission denied");
  });

  it("(23) no evidence artifact accumulates while the pipeline is off; activation keeps artifacts from then on only", async () => {
    await setup();
    await genesis.experimentPolicySet(false, null, OWNER);
    const text = "Forum: landlords asked for a simple rent-tracking spreadsheet; several would pay £12.";
    const fetchOnce = async (host: string) => {
      const attemptId = crypto.randomUUID();
      await q(`INSERT INTO fleet.fleet_research_attempts (attempt_id, agent_id, requested_url, requested_host, purpose, decision) VALUES ($1, $2, $3, $4, 'test', 'authorized')`,
        [attemptId, F.id, `https://${host}/p`, host]);
      const refused: string[] = [];
      const sha = crypto.createHash("sha256").update(`${host}:${text}`).digest("hex");
      await research({ capabilities: async () => ({ ok: true }), authorize: async () => ({ ok: true, attemptId }), record: (a, id, x) => svc.researchRecord(a, id, x),
        recordArtifact: (a, id, x) => svc.researchArtifactRecord(a, id, x), artifactRefused: (_a, _id, c) => refused.push(c) },
      { fetch: async (url: string) => ({ ok: true as const, requestedUrl: url, finalUrl: url, redirects: [], status: 200, contentType: "text/html", title: "t", text, truncated: false,
        links: [], bytes: text.length, sha256: sha, fetchedAt: new Date().toISOString(), latencyMs: 3 }) }, F.id, F.token, { url: `https://${host}/p`, purpose: "demand research" });
      return { attemptId, sha256: sha, refused };
    };
    // Off: the fetch works as always, but nothing is archived (and that is not treated as a refusal worth auditing).
    const off = await fetchOnce("forum.landlord-talk.co.uk");
    expect(off.refused).toEqual([]);
    expect((await q(`SELECT count(*)::int AS n FROM fleet.fleet_research_evidence_artifacts`))[0].n).toBe(0);
    const art = buildEvidenceArtifact({ sha256: off.sha256, finalUrl: "https://forum.landlord-talk.co.uk/p", title: null, text })!;
    expect(await svc.researchArtifactRecord(F.id, off.attemptId, art)).toMatchObject({ ok: false, code: "FLEET_EXPERIMENTS_DISABLED" });
    // On: artifacts are kept from now on — never retroactively for pages fetched while off.
    await genesis.experimentPolicySet(true, null, OWNER);
    const on = await fetchOnce("letting-agents-forum.co.uk");
    expect(on.refused).toEqual([]);
    expect((await q(`SELECT attempt_id FROM fleet.fleet_research_evidence_artifacts`)).map((r) => r.attempt_id)).toEqual([on.attemptId]);
    // A page fetched while off can still be cited (provenance), but without an artifact it can never earn a level.
    const cite = (x: { attemptId: string; sha256: string }) => ({ attemptId: x.attemptId, sha256: x.sha256, supports: "demand", rationale: "Landlords ask for this tracker." });
    const r = await proposeAssessed(F, proposal({ opportunityKey: "archive-off", evidence: [cite(off)] }));
    expect(exp(r)).toMatchObject({ status: "watch", verifiedLevel: 0, decisionCode: "FLEET_EVIDENCE_UNCERTAIN" });
    const ok = await proposeAssessed(F, proposal({ opportunityKey: "archive-on", evidence: [cite(on)] }));
    expect(exp(ok)).toMatchObject({ verifiedLevel: 1, status: "partially_approved" });
  });

  it("(24) failed relevance-provider calls never disappear from provider-credit accounting", async () => {
    await setup();
    const T2 = { in: 200, out: 1000 }; // seeded T2 prices (USD µ¢ per token)
    let mode: "estimate" | "usage" | "none" | "throw" | "t3-estimate" = "estimate";
    const failing: ProviderFactory = (c: TierCandidate) => ({
      id: "scripted" as const, model: c.model,
      async chat(req) {
        modelLog.push({ tier: c.tier, model: c.model, agentId: req.agentId, system: req.system, prompt: String(req.messages[0].content) });
        if (mode === "t3-estimate" && c.tier === "T2") {
          return { content: JSON.stringify({ stance: "mixed", supports: "demand", quotes: [], reason: "unclear" }), toolCalls: [], usage: { inputTokens: 1_000, outputTokens: 100 }, usageSource: "provider" as const, attempts: 1 };
        }
        if (mode === "throw") throw new Error("socket hang up");
        if (mode === "usage") throw new ProviderError("PROVIDER_MALFORMED_RESPONSE", { charge: "usage", attempts: 1, usage: { inputTokens: 900, outputTokens: 40 } });
        if (mode === "none") throw new ProviderError("PROVIDER_RATE_LIMITED", { charge: "none", attempts: 3, status: 429 });
        throw new ProviderError("PROVIDER_TIMEOUT", { charge: "estimate", attempts: 1 });
      },
    });
    const flaky = new RelevanceAssessor({ ports: relevancePorts(), providerFactory: failing });
    const calls = async () => q(`SELECT request_id, tier, outcome, error_code, charge, usd_microcents, estimate_usd_microcents, cost_status FROM fleet.fleet_relevance_calls ORDER BY at, request_id`);
    const credit = async (id: string) => q(`SELECT usd_microcents::bigint AS usd, recorded_by, external_ref FROM fleet.fleet_provider_credit_events WHERE request_id = $1`, [id]);
    const item = await page(F.id, "flaky.example");
    const r = await propose(F, proposal({ opportunityKey: "flaky-provider", evidence: [item] }));
    const id = exp(r).experimentId as string;

    // 1. Timeout after sending (the provider may have billed; amount unknown): an explicit, audited reconciliation item.
    expect(await flaky.runOnce(5)).toEqual({ assessed: 0, deferred: 1 });
    let k = await calls();
    expect(k).toHaveLength(1);
    expect(k[0]).toMatchObject({ tier: "T2", outcome: "failed", error_code: "PROVIDER_TIMEOUT", charge: "unknown", usd_microcents: null, cost_status: "unknown_reconciliation_required" });
    expect(Number(k[0].estimate_usd_microcents)).toBeGreaterThan(0);
    expect(await credit(k[0].request_id)).toEqual([]); // not guessed into the credit record
    expect((await q(`SELECT detail FROM fleet.fleet_events WHERE event_type = 'provider_cost_reconciliation_required'`)).map((e) => e.detail.requestId)).toEqual([k[0].request_id]);
    expect((await genesis.relevanceCallsUnreconciled()).map((x) => x.request_id)).toEqual([k[0].request_id]);
    expect(await expJson(id)).toMatchObject({ status: "watch", decisionCode: "FLEET_RELEVANCE_PENDING" }); // the item stays pending for a retry
    // The owner reconciles it once with the provider's actual charge.
    expect(await genesis.relevanceCallReconcile(k[0].request_id, 4_200, OWNER, "console usage 2026-09-30")).toMatchObject({ ok: true, usdMicrocents: 4_200 });
    expect(await credit(k[0].request_id)).toEqual([{ usd: "-4200", recorded_by: OWNER, external_ref: "console usage 2026-09-30" }]);
    expect(await genesis.relevanceCallsUnreconciled()).toEqual([]);
    expect(await code(genesis.relevanceCallReconcile(k[0].request_id, 1, OWNER, "again"))).toBe("FLEET_DUPLICATE_EVENT");
    expect(await code(genesis.relevanceCallReconcile(crypto.randomUUID(), 1, OWNER, "no such call"))).toBe("FLEET_NOT_FOUND");
    expect(await code(agentRaw.query(`SELECT fleet.svc_relevance_call_failed($1, $1, '{}'::jsonb)`, [id]))).toBe("permission denied");

    // 2. A failure that reported usage: its actual cost, straight into the credit record.
    mode = "usage";
    await flaky.runOnce(5);
    k = await calls();
    expect(k[1]).toMatchObject({ charge: "usage", cost_status: "known", usd_microcents: String(900 * T2.in + 40 * T2.out) });
    expect(await credit(k[1].request_id)).toEqual([{ usd: String(-(900 * T2.in + 40 * T2.out)), recorded_by: "controller:evidence_relevance", external_ref: null }]);

    // 3. Refused before billing (rate limited): known zero, logged, nothing to reconcile.
    mode = "none";
    await flaky.runOnce(5);
    k = await calls();
    expect(k[2]).toMatchObject({ charge: "none", cost_status: "none", usd_microcents: null, error_code: "PROVIDER_RATE_LIMITED" });
    expect(await credit(k[2].request_id)).toEqual([]);

    // 4. Not even a provider error (connection dropped in our own code): unknown cost, reconciliation required.
    mode = "throw";
    await flaky.runOnce(5);
    expect((await calls())[3]).toMatchObject({ error_code: "PROVIDER_ERROR", charge: "unknown", cost_status: "unknown_reconciliation_required" });

    // 5. T2 answers (ambiguous), the T3 escalation fails: the verdict stands at T2 with its cost; the T3 failure is logged too.
    mode = "t3-estimate";
    expect(await flaky.runOnce(5)).toEqual({ assessed: 1, deferred: 0 });
    k = await calls();
    expect(k.slice(4).map((x) => [x.tier, x.outcome, x.cost_status])).toEqual(expect.arrayContaining([["T2", "ok", "known"], ["T3", "failed", "unknown_reconciliation_required"]]));
    const v = (await genesis.experimentView(id))! as Record<string, any>;
    expect(v.relevance[0]).toMatchObject({ verdict: "uncertain", tier: "T2" });
    // Every call is in the log and counts against the hourly budget, answered or failed.
    expect((await svc.relevancePending(10)).callsLastHour).toBe(k.length);
    expect(k.length).toBe(6);
    expect((await genesis.relevanceCallsUnreconciled()).length).toBe(2);
    expect((await store.auditPrivileges()).problems).toEqual([]);
  });

  it("(9) success is decided from controller-recorded observations only, and records strategy-registry knowledge; (7) the founder cannot edit the authoritative result", async () => {
    await setup();
    const r = await proposeAssessed(F, proposal({ evidence: [await page(F.id, "s1.example"), await page(F.id, "s2.example")] }));
    const id = exp(r).experimentId as string;
    await gw.experimentStart(F.id, F.token, id);
    await rec(F, id, { kind: "sim_spend", amountMinor: 200 });
    // The founder's own claims do not decide success.
    await rec(F, id, { kind: "observation", metric: "sales", value: 50 });
    await rec(F, id, { kind: "result_claim", detail: { outcome: "succeeded" } });
    await genesis.experimentObserve(id, `obs:${crypto.randomUUID()}`, "sales", 4, "synthetic executor: marketplace dashboard (simulated)", OWNER);
    await genesis.experimentObserve(id, `obs:${crypto.randomUUID()}`, "simulated_revenue_minor", 4_800, "synthetic executor (simulated)", OWNER);
    const done = await genesis.experimentConclude(id, OWNER, "Landlords bought at £12; the listing photo mattered more than the price.", null);
    expect(done).toMatchObject({ status: "succeeded", result: { outcome: "succeeded", actualSpendMinor: 200, simulatedRevenueMinor: 4_800, confidenceAfter: 3,
      roiAuthority: "simulated_non_authoritative", spendSource: "founder_reported_simulated" } });
    expect(Number((done.result as { simulatedRoi: unknown }).simulatedRoi)).toBe(23); // (4800 − 200) / 200, simulated and non-authoritative
    const view = await genesis.experimentView(id);
    const res = view!.result as Record<string, any>;
    expect(res.criteria.success).toEqual([{ metric: "sales", op: ">=", target: 3, observed: 4, met: true }]);
    expect(res.evidence.founderClaims).toBe(1);
    expect(res.founder_claim).toEqual({ outcome: "succeeded" });
    expect(res.discrepancies).toMatchObject({ revenueVsForecast: { forecast: 3_600, observed: 4_800 }, founderClaimMatches: true });
    const reg = view!.registry as Record<string, any>;
    expect(reg).toMatchObject({ outcome: "succeeded", opportunity_key: "bookkeeping-templates", evidence_level: 2, financial_mode: "simulated", roi_authority: "simulated_non_authoritative" });
    const kp = (await q(`SELECT category, status, title, content FROM fleet.fleet_knowledge_proposals WHERE proposal_id = $1`, [reg.knowledge_proposal_id]))[0];
    expect(kp).toMatchObject({ category: "technique", status: "proposed" }); // the owner still promotes
    expect(kp.content).toMatch(/Controller-recorded experiment result \(simulated capital\).*Outcome: succeeded.*simulated ROI 23\.0000 \(non-authoritative\)/s);
    // The authoritative result cannot be rewritten: not by the founder, not by the owner, not by a later claim.
    expect(await rec(F, id, { kind: "result_claim", detail: { outcome: "failed" } })).toMatchObject({ ok: false, code: "FLEET_RESULT_AUTHORITATIVE" });
    expect(await code(inTime(`UPDATE fleet.fleet_experiment_results SET outcome = 'failed' WHERE experiment_id = $1`, [id]))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await code(inTime(`DELETE FROM fleet.fleet_strategy_registry WHERE experiment_id = $1`, [id]))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await code(agentRaw.query(`SELECT * FROM fleet.fleet_experiment_results`))).toBe("permission denied");
    expect(await code(genesis.experimentConclude(id, OWNER, "again", 4))).toBe("FLEET_INVALID_STATE");
    // A later proposal on the same opportunity, with relevant desk evidence, reaches E3 (observed signal) — a controller-derived level.
    const s3 = await page(F.id, "s3.example");
    const pending = await propose(F, proposal({ requestedMinor: 2_000, maxLossMinor: 1_000, evidence: [s3] }));
    expect(exp(pending)).toMatchObject({ verifiedLevel: 0, status: "watch" }); // the earlier success alone is not relevance for a new proposal
    await settle();
    expect(await expJson(exp(pending).experimentId)).toMatchObject({ verifiedLevel: 3, status: "approved", approvedMinor: 2_000 });
  });

  it("(17) E4 needs revenue attributed to the same opportunity lineage: unrelated revenue cannot produce E4, attributed revenue can", async () => {
    await setup();
    await q(`UPDATE fleet.fleet_experiment_policy SET max_active_per_founder = 10`);
    const early = await revenue(F.id, 900); // realized before any experiment on the opportunity
    const rt = await running(F, "rent-tracker", 4);
    expect(await code(genesis.experimentAttributeRevenue(early, rt, OWNER, "tracker sales"))).toBe("FLEET_INVALID_STATE"); // not concluded yet
    expect(await genesis.experimentConclude(rt, OWNER, null, null)).toMatchObject({ status: "succeeded" });
    expect(await code(genesis.experimentAttributeRevenue(early, rt, OWNER, "tracker sales"))).toBe("FLEET_REVENUE_NOT_ATTRIBUTABLE"); // predates the experiment
    // Revenue of another opportunity's lineage, and another founder's revenue.
    const other = await running(F, "logo-design", 0);
    await genesis.experimentConclude(other, OWNER, null, null);
    const otherRev = await revenue(F.id, 500);
    expect(await genesis.experimentAttributeRevenue(otherRev, other, OWNER, "logo client paid")).toMatchObject({ opportunity_key: "logo-design", amount_minor: 500 });
    expect(await code(genesis.experimentAttributeRevenue(await revenue(G.id, 300), rt, OWNER, "not F's money"))).toBe("FLEET_REVENUE_NOT_ATTRIBUTABLE");
    const unattributed = await revenue(F.id, 700);
    expect(await code(genesis.experimentAttributeRevenue(unattributed, rt, `operator:${F.id}`, "my revenue"))).toBe("FLEET_SELF_APPROVAL");
    // F now has positive realized revenue (unattributed, and attributed to logo-design): the rent-tracker proposal stays E3.
    expect(Number((await q(`SELECT fleet.fleet_ledger_balance(fleet.fleet_ledger_account($1, 'agent_revenue')) AS b`, [F.id]))[0].b)).toBeGreaterThan(0);
    const e3 = await proposeAssessed(F, proposal({ opportunityKey: "rent-tracker", evidence: [await page(F.id, "rt-1.example")] }));
    expect(exp(e3)).toMatchObject({ verifiedLevel: 3, status: "approved", approvedMinor: 800 });
    // Revenue attributed to this opportunity's lineage: E4, which the owner decides (never automatic).
    expect(await genesis.experimentAttributeRevenue(unattributed, rt, OWNER, "tracker customers paid via the marketplace"))
      .toMatchObject({ journal_id: unattributed, opportunity_key: "rent-tracker", experiment_id: rt, amount_minor: 700, attributed_by: OWNER });
    expect(await code(genesis.experimentAttributeRevenue(unattributed, rt, OWNER, "again"))).toBe("FLEET_DUPLICATE_EVENT");
    const e4 = await proposeAssessed(F, proposal({ opportunityKey: "rent-tracker", requestedMinor: 1_200, maxLossMinor: 600, evidence: [await page(F.id, "rt-2.example")] }));
    expect(exp(e4)).toMatchObject({ verifiedLevel: 4, status: "proposed", decisionCode: "FLEET_OWNER_DECISION_REQUIRED", approvedMinor: null });
    // The attribution cannot be rewritten; a reversed revenue journal stops counting.
    expect(await code(inTime(`UPDATE fleet.fleet_opportunity_revenue_attributions SET opportunity_key = 'rent-tracker' WHERE journal_id = $1`, [otherRev]))).toBe("FLEET_HISTORY_IMMUTABLE");
    await q(`SELECT fleet.fleet_admin_reverse($1, $2, 'customer refunded', $3)`, [unattributed, OWNER, `rev:${crypto.randomUUID()}`]);
    const back = await proposeAssessed(F, proposal({ opportunityKey: "rent-tracker", evidence: [await page(F.id, "rt-3.example")] }));
    expect(exp(back)).toMatchObject({ verifiedLevel: 3 });
    expect((await store.auditPrivileges()).problems).toEqual([]);
  });

  it("(18) simulated founder-reported ROI influences no authoritative decision: capital, headroom, evidence level, confidence, reproduction", async () => {
    await setup(1_500);
    const repro0 = (await q(`SELECT fleet.fleet_reproduction_eligibility($1) AS r`, [F.id]))[0].r;
    const eco0 = await ledger.economics(F.id);
    // Two identical experiments; the founder reports a very different simulated spend for each.
    const a = await proposeAssessed(F, proposal({ opportunityKey: "roi-a", evidence: [await page(F.id, "ra-1.example"), await page(F.id, "ra-2.example")] }));
    const aid = exp(a).experimentId as string;
    await gw.experimentStart(F.id, F.token, aid);
    await rec(F, aid, { kind: "sim_spend", amountMinor: 590 });
    // Reported spend never releases headroom: A still commits its whole maximum loss (600), so B's loss is capped at 900.
    const b = await proposeAssessed(F, proposal({ opportunityKey: "roi-b", requestedMinor: 1_000, maxLossMinor: 1_000, evidence: [await page(F.id, "rb-1.example"), await page(F.id, "rb-2.example")] }));
    expect(exp(b)).toMatchObject({ status: "partially_approved", approvedMinor: 1_000, approvedMaxLossMinor: 900 });
    const bid = exp(b).experimentId as string;
    await gw.experimentStart(F.id, F.token, bid);
    await rec(F, bid, { kind: "sim_spend", amountMinor: 10 });
    for (const id of [aid, bid]) {
      await genesis.experimentObserve(id, `obs:${crypto.randomUUID()}`, "sales", 4, "synthetic executor (simulated)", OWNER);
      await genesis.experimentObserve(id, `obs:${crypto.randomUUID()}`, "simulated_revenue_minor", 1_000, "synthetic executor (simulated)", OWNER);
      await genesis.experimentConclude(id, OWNER, null, null);
    }
    const [va, vb] = [(await genesis.experimentView(aid))! as Record<string, any>, (await genesis.experimentView(bid))! as Record<string, any>];
    expect(Number(va.result.simulated_roi)).toBeCloseTo(0.6949, 4);
    expect(Number(vb.result.simulated_roi)).toBe(99);
    for (const v of [va, vb]) {
      expect(v.result).toMatchObject({ outcome: "succeeded", confidence_after: 3, roi_authority: "simulated_non_authoritative", spend_source: "founder_reported_simulated" });
      expect(v.registry).toMatchObject({ outcome: "succeeded", evidence_level: 2, confidence_after: 3, roi_authority: "simulated_non_authoritative" });
    }
    // Follow-ups on each opportunity are decided identically despite a 140× ROI difference.
    const fa = await proposeAssessed(F, proposal({ opportunityKey: "roi-a", evidence: [await page(F.id, "ra-3.example")] }));
    const fb = await proposeAssessed(F, proposal({ opportunityKey: "roi-b", evidence: [await page(F.id, "rb-3.example")] }));
    const pick = (x: Record<string, any>) => [x.verifiedLevel, x.status, x.approvedMinor, x.approvedMaxLossMinor, x.decisionCode];
    expect(pick(exp(fa))).toEqual([3, "approved", 800, 600, "FLEET_EXPERIMENT_APPROVED"]);
    expect(pick(exp(fb))).toEqual(pick(exp(fa)));
    // Books, economics and reproduction eligibility never saw it.
    expect(await ledger.economics(F.id)).toEqual(eco0);
    expect((await q(`SELECT fleet.fleet_reproduction_eligibility($1) AS r`, [F.id]))[0].r).toEqual(repro0);
    // Structurally: only the recording and reporting functions may name simulated ROI; a new reader fails the audit.
    expect((await store.auditPrivileges()).problems).toEqual([]);
    await q(`CREATE FUNCTION fleet.fleet_rank_founders_by_roi(p text) RETURNS numeric LANGUAGE sql AS $$ SELECT max(simulated_roi) FROM fleet.fleet_strategy_registry WHERE agent_id = p $$`);
    try {
      expect((await store.auditPrivileges()).problems).toContain("experiment pipeline: fleet_rank_founders_by_roi reads simulated (non-authoritative) ROI");
    } finally {
      await q(`DROP FUNCTION fleet.fleet_rank_founders_by_roi(text)`);
    }
  });

  it("(10) failure is first-class knowledge: an unmet signal fails at the run window, is kept, and feeds failure knowledge", async () => {
    await setup();
    const r = await proposeAssessed(F, proposal({ opportunityKey: "no-demand", evidence: [await page(F.id, "f1.example"), await page(F.id, "f2.example")] }));
    const id = exp(r).experimentId as string;
    await gw.experimentStart(F.id, F.token, id);
    await rec(F, id, { kind: "sim_spend", amountMinor: 150 });
    await rec(F, id, { kind: "result_claim", detail: { outcome: "succeeded" } }); // an optimistic claim
    await genesis.experimentObserve(id, `obs:${crypto.randomUUID()}`, "sales", 0, "synthetic executor (simulated)", OWNER);
    await inTime(`UPDATE fleet.fleet_experiments SET run_deadline = now() - interval '1 second' WHERE experiment_id = $1`, [id]);
    expect(await svc.reapExperiments(50)).toBe(1);
    const view = await genesis.experimentView(id);
    expect(view).toMatchObject({ status: "failed" });
    expect(view!.result).toMatchObject({ outcome: "failed", actual_spend_minor: 150, simulated_revenue_minor: 0, confidence_after: 1, concluded_kind: "controller" });
    expect(Number((view!.result as { simulated_roi: unknown }).simulated_roi)).toBe(-1);
    expect((view!.result as Record<string, any>).discrepancies).toMatchObject({ founderClaimOutcome: "succeeded", founderClaimMatches: false });
    const reg = view!.registry as Record<string, any>;
    expect(reg.outcome).toBe("failed");
    expect((await q(`SELECT category FROM fleet.fleet_knowledge_proposals WHERE proposal_id = $1`, [reg.knowledge_proposal_id]))[0].category).toBe("failure");
    // The founder sees its failure in its own registry view; nothing is deleted or disguised.
    const mine = await gw.experimentList(F.id, F.token, 20);
    expect((mine.registry as Array<Record<string, unknown>>)[0]).toMatchObject({ opportunityKey: "no-demand", outcome: "failed", roiAuthority: "simulated_non_authoritative" });
  });

  it("(11) duplicate or replayed proposals, starts and steps are idempotent; a changed replay is refused", async () => {
    await setup();
    const ev = [await page(F.id, "d1.example"), await page(F.id, "d2.example")];
    const p = proposal({ evidence: ev });
    const a = await propose(F, p, "exp:replay-key-0001");
    const b = await propose(F, p, "exp:replay-key-0001");
    expect(b).toMatchObject({ ok: true, replay: true, experiment: { experimentId: exp(a).experimentId } });
    expect(await propose(F, { ...p, requestedMinor: 700 }, "exp:replay-key-0001")).toMatchObject({ ok: false, code: "FLEET_IDEMPOTENCY_CONFLICT" });
    expect((await q(`SELECT count(*)::int AS n FROM fleet.fleet_experiments WHERE agent_id = $1`, [F.id]))[0].n).toBe(1);
    const id = exp(a).experimentId as string;
    await settle();
    expect(await expJson(id)).toMatchObject({ status: "approved" });
    await gw.experimentStart(F.id, F.token, id);
    expect(await gw.experimentStart(F.id, F.token, id)).toMatchObject({ ok: true, replay: true });
    const step = { experimentId: id, idempotencyKey: "rec:replay-step-0001", kind: "sim_spend", amountMinor: 100 };
    expect(exp(await gw.experimentRecord(F.id, F.token, step))).toMatchObject({ simSpentMinor: 100 });
    expect(await gw.experimentRecord(F.id, F.token, step)).toMatchObject({ ok: false, code: "FLEET_DUPLICATE_EVENT", experiment: { simSpentMinor: 100 } });
    expect(await gw.experimentRecord(F.id, F.token, { ...step, amountMinor: 101 })).toMatchObject({ ok: false, code: "FLEET_IDEMPOTENCY_CONFLICT" });
    // Another founder's key space is separate, and it cannot touch this experiment at all.
    expect(await gw.experimentStart(G.id, G.token, id)).toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    expect(await gw.experimentRecord(G.id, G.token, { ...step, idempotencyKey: "rec:other-founder-01" })).toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
  });

  it("(12) malformed or tampered evidence and proposals fail closed; nothing is recorded", async () => {
    await setup();
    const good = await page(F.id, "ok.example");
    const other = await page(G.id, "other.example");
    const failed = await page(F.id, "down.example", { outcome: "failed" });
    const cases: Array<[unknown, string]> = [
      [[{ ...good, sha256: "0".repeat(64) }], "FLEET_EVIDENCE_UNVERIFIED"],          // tampered page hash
      [[other], "FLEET_EVIDENCE_UNVERIFIED"],                                         // another founder's research
      [[failed], "FLEET_EVIDENCE_UNVERIFIED"],                                        // a fetch that failed
      [[{ ...good, attemptId: crypto.randomUUID() }], "FLEET_EVIDENCE_UNVERIFIED"],  // an attempt that never happened
      [[good, good], "FLEET_EVIDENCE_DUPLICATE"],
      [[{ ...good, trustMe: true }], "FLEET_EVIDENCE_INVALID"],
      [[{ ...good, attemptId: "not-a-uuid" }], "FLEET_EVIDENCE_INVALID"],
      [[{ attemptId: good.attemptId, sha256: good.sha256 }], "FLEET_EVIDENCE_INVALID"],  // no relevance claim at all
      [[{ ...good, supports: "vibes" }], "FLEET_EVIDENCE_INVALID"],
      [[{ ...good, rationale: "trust me" }], "FLEET_EVIDENCE_INVALID"],
      [[{ ...good, rationale: "see sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA" }], "FLEET_BAD_REQUEST"], // secret-shaped text anywhere: refused before any lookup
    ];
    for (const [evidence, want] of cases) expect((await propose(F, proposal({ evidence }))).code).toBe(want);
    for (const [bad, field] of [
      [{ hypothesis: "short" }, "hypothesis"], [{ maxLossMinor: 900 }, "requestedMinor/maxLossMinor"], [{ successCriteria: [] }, "successCriteria"],
      [{ stopConditions: [{ kind: "vibes", value: 1 }] }, "stopConditions"], [{ reversibility: "maybe" }, "reversibility"], [{ timeToSignalS: 10 }, "timeToSignalS"],
      [{ hypothesis: "Buy from 0x" + "a".repeat(64) + " wallet, trust me." }, "secret-shaped text"], [{ executionSteps: [] }, "executionSteps"],
    ] as Array<[Record<string, unknown>, string]>) {
      expect(await propose(F, proposal(bad))).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST", reason: field });
    }
    expect(await gw.experimentPropose(F.id, F.token, "exp:array-payload-1", [proposal()] as never)).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
    expect(await gw.experimentPropose(F.id, "fa1.forged", "exp:forged-token-01", proposal())).toMatchObject({ ok: false, code: "FLEET_AUTH_FAILED" });
    expect((await q(`SELECT count(*)::int AS n FROM fleet.fleet_experiments`))[0].n).toBe(0);
    expect((await q(`SELECT count(*)::int AS n FROM fleet.fleet_events WHERE event_type = 'experiment_evidence_refused'`))[0].n).toBe(10);
  });

  it("(13) no real-money side effect is possible; (14) ledger and audit links reconcile; (15) cognition tiering is independent of outcomes", async () => {
    await setup();
    const before = await ledgerHead();
    const eco0 = await ledger.economics(F.id);
    const ids: string[] = [];
    for (const [k, sales] of [["reco-win", 5], ["reco-loss", 0]] as const) {
      const r = await proposeAssessed(F, proposal({ opportunityKey: k, evidence: [await page(F.id, `${k}-a.example`), await page(F.id, `${k}-b.example`)] }));
      const id = exp(r).experimentId as string;
      ids.push(id);
      await gw.experimentStart(F.id, F.token, id);
      await rec(F, id, { kind: "sim_spend", amountMinor: 120 });
      await rec(F, id, { kind: "sim_spend", amountMinor: 80 });
      await genesis.experimentObserve(id, `obs:${crypto.randomUUID()}`, "sales", sales, "synthetic executor (simulated)", OWNER);
      if (sales) await genesis.experimentObserve(id, `obs:${crypto.randomUUID()}`, "simulated_revenue_minor", 1_000, "synthetic executor (simulated)", OWNER);
      await genesis.experimentConclude(id, OWNER, null as never, null);
    }
    // (13) The books never moved; no payment order, instruction or custody action exists; economics unchanged.
    expect(await ledgerHead()).toEqual(before);
    expect(await ledger.economics(F.id)).toEqual(eco0);
    expect((await q(`SELECT (SELECT count(*)::int FROM fleet.fleet_payment_orders) AS o, (SELECT count(*)::int FROM fleet.fleet_payment_instructions) AS i`))[0]).toEqual({ o: 0, i: 0 });
    expect((await ledger.verify()).ok).toBe(true);
    // (14) Every transition is audited once; spends reconcile across events, the experiment, the result and the registry.
    for (const id of ids) {
      const v = (await genesis.experimentView(id))! as Record<string, any>;
      const events = await q(`SELECT count(*)::int AS n FROM fleet.fleet_events WHERE event_type LIKE 'experiment\\_%' ESCAPE '\\'
                                AND event_type NOT IN ('experiment_evidence_refused','experiment_budget_refused','experiment_policy_set','experiment_relevance_assessed','experiment_revenue_attributed')
                                AND detail ->> 'experimentId' = $1`, [id]);
      expect(events[0].n).toBe(v.transitions.length);
      const assessed = await q(`SELECT count(*)::int AS n FROM fleet.fleet_events WHERE event_type = 'experiment_relevance_assessed' AND detail ->> 'experimentId' = $1`, [id]);
      expect(assessed[0].n).toBe(v.relevance.length);
      const spent = v.events.filter((e: { kind: string }) => e.kind === "sim_spend").reduce((n: number, e: { amount_minor: string }) => n + Number(e.amount_minor), 0);
      expect([spent, Number(v.sim_spent_minor), Number(v.result.actual_spend_minor), Number(v.registry.actual_spend_minor)]).toEqual([200, 200, 200, 200]);
      expect(v.registry.knowledge_proposal_id).toBeTruthy();
      expect(v.transitions.at(-1)).toMatchObject({ to_status: v.status, actor_kind: "owner" });
    }
    // (15) The router's input has no field for outcomes, ROI or history, refuses one if sent, and routes identically.
    for (const k of ["experimentOutcome", "roi", "strategyRegistry", "wins", "losses"]) {
      expect(() => parseRouteRequest({ taskClass: "agent_step", [k]: 1 })).toThrow(RouteError);
    }
    expect(route(parseRouteRequest({ taskClass: "agent_step" }))).toEqual(route(parseRouteRequest({ taskClass: "agent_step" })));
    const rs = await svc.cognitionRoutingState(F.id);
    expect(JSON.stringify(rs)).not.toMatch(/experiment|registry|roi|outcome/i);
    const routerSrc = fs.readFileSync("src/fleet/cognition/router.ts", "utf8") + fs.readFileSync("src/fleet/cognition/routed-gateway.ts", "utf8");
    expect(routerSrc).not.toMatch(/fleet_experiment|strategy_registry|experimentOutcome/);
    expect((await store.auditPrivileges()).problems).toEqual([]);
  });

  it("over HTTP: the founder's client proposes, starts and records through FleetController; refusals come back as data; the reaper runs the expiry", async () => {
    await setup();
    const service = new FleetService({ admin: svc, agent: gw, realReplicationEnabled: false, reaperIntervalMs: 0,
      release: { repo: "https://github.com/5l4mm3r/automaton-fleet", commit: "c".repeat(40), buildId: "d".repeat(64), lockfileSha256: "e".repeat(64) },
      audit: () => undefined, terminator: new UnsupportedSandboxTerminator(), cognitionProviderFactory: scripted });
    const url = (await service.listen(0, "127.0.0.1")).url;
    try {
      const client = new FleetApiClient({ baseUrl: url, agentId: F.id, token: F.token });
      const caps = await client.capabilities();
      expect(caps.experimentsEnabled).toBe(true);
      const ev = [await page(F.id, "h1.example"), await page(F.id, "h2.example")];
      const r = await client.experimentPropose("exp:http-propose-001", proposal({ evidence: ev }));
      expect(r).toMatchObject({ ok: true, experiment: { status: "watch", evidence: { verified: 2, relevant: 0 } } });
      const id = (r.experiment as { experimentId: string }).experimentId;
      await service.assessRelevance();
      expect(await expJson(id)).toMatchObject({ status: "approved", approvedMinor: 800 });
      expect(await client.experimentStart(id)).toMatchObject({ ok: true, experiment: { status: "running" } });
      // (the client raises a refusal as an ApiError carrying the registry's code; the founder toolbox turns it into data)
      await expect(client.experimentRecord({ experimentId: id, idempotencyKey: "rec:http-over-budget", kind: "sim_spend", amountMinor: 5_000 }))
        .rejects.toMatchObject({ code: "FLEET_BUDGET_EXCEEDED" });
      const list = await client.experimentList();
      expect(list).toMatchObject({ ok: true, enabled: true, financialMode: "simulated" });
      expect((list.ladder as unknown[]).length).toBe(5);
      // Another founder's id in the path of a request is simply not found (own experiments only).
      const other = new FleetApiClient({ baseUrl: url, agentId: G.id, token: G.token });
      await expect(other.experimentStart(id)).rejects.toMatchObject({ code: "FLEET_NOT_FOUND" });
      await genesis.experimentPolicySet(false, null, OWNER);
      expect((await client.capabilities()).experimentsEnabled).toBe(false);
      await expect(client.experimentPropose("exp:http-propose-002", proposal({ opportunityKey: "off-now" }))).rejects.toMatchObject({ code: "FLEET_EXPERIMENTS_DISABLED" });
      await inTime(`UPDATE fleet.fleet_experiments SET run_deadline = now() - interval '1 second' WHERE experiment_id = $1`, [id]);
      await service.reapOnce();
      expect((await genesis.experimentView(id))!.status).toBe("failed"); // no controller-recorded signal before the window closed
    } finally {
      await service.close();
    }
  });

  it("simulated end-to-end: opportunity → evidence → relevance → proposal → decision → bounded run → measured result → registry and knowledge (receipt)", async () => {
    await setup();
    const t0 = new Date().toISOString();
    const head0 = await ledgerHead();
    const evidence = [await page(F.id, "marketplace.example"), await page(F.id, "forum.example")];
    const proposed = await propose(F, proposal({ opportunityKey: "landlord-rent-tracker", evidence }), "exp:e2e-receipt-0001");
    const id = exp(proposed).experimentId as string;
    await settle();
    const decided = await expJson(id);
    const started = await gw.experimentStart(F.id, F.token, id);
    await rec(F, id, { kind: "step", note: "template drafted (simulated)" });
    await rec(F, id, { kind: "sim_spend", amountMinor: 20, note: "listing fee (simulated)" });
    await rec(F, id, { kind: "sim_spend", amountMinor: 150, note: "promoted listing (simulated)" });
    await rec(F, id, { kind: "observation", metric: "sales", value: 3, attemptId: evidence[0].attemptId, note: "dashboard page shows 3 sales" });
    await genesis.experimentObserve(id, "obs:e2e-sales-00001", "sales", 3, "synthetic executor: marketplace sales (simulated)", OWNER);
    await genesis.experimentObserve(id, "obs:e2e-revenue-0001", "simulated_revenue_minor", 3_600, "synthetic executor: 3 × £12 (simulated)", OWNER);
    await rec(F, id, { kind: "result_claim", detail: { outcome: "succeeded" } });
    const concluded = await genesis.experimentConclude(id, OWNER, "Three sales in the window at £12; promotion spend was the main cost.", null);
    const view = (await genesis.experimentView(id))! as Record<string, any>;
    const receipt = {
      receipt: "r24-simulated-experiment", generatedAt: new Date().toISOString(), startedAt: t0, financialMode: "simulated",
      founder: F.id, experimentId: id, opportunityKey: view.opportunity_key,
      evidence: { claimedLevel: view.claimed_level, verifiedLevel: view.verified_level,
        provenance: view.verified_evidence.items.map((i: Record<string, unknown>) => ({ attemptId: i.attemptId, host: i.host, sha256: i.sha256, supports: i.supports, rationale: i.rationale })),
        relevance: view.relevance.map((x: Record<string, unknown>) => ({ attemptId: x.attempt_id, sha256: x.content_sha256, verdict: x.verdict, assessedBy: x.assessed_by, reason: x.reason })) },
      proposal: { status: exp(proposed).status, code: exp(proposed).decisionCode, reason: exp(proposed).decisionReason },
      decision: { status: decided.status, decidedBy: decided.decidedBy, code: decided.decisionCode, reason: decided.decisionReason,
        requestedMinor: view.requested_minor, approvedMinor: view.approved_minor, approvedMaxLossMinor: view.approved_max_loss_minor, approvalExpiresAt: view.approval_expires_at },
      run: { startedAt: exp(started).startedAt, runDeadline: exp(started).runDeadline, events: view.events.map((e: Record<string, unknown>) => ({ kind: e.kind, amountMinor: e.amount_minor, metric: e.metric, value: e.value, verification: e.verification })) },
      transitions: view.transitions.map((t: Record<string, unknown>) => ({ from: t.from_status, to: t.to_status, actorKind: t.actor_kind, code: t.code })),
      result: { outcome: view.result.outcome, actualSpendMinor: view.result.actual_spend_minor, spendSource: view.result.spend_source, elapsedS: view.result.elapsed_s,
        simulatedRevenueMinor: view.result.simulated_revenue_minor, simulatedRoi: view.result.simulated_roi, roiAuthority: view.result.roi_authority,
        criteria: view.result.criteria, discrepancies: view.result.discrepancies, lessons: view.result.lessons,
        confidence: { before: view.result.confidence_before, after: view.result.confidence_after }, concludedKind: view.result.concluded_kind },
      strategyRegistry: { seq: view.registry.seq, outcome: view.registry.outcome, knowledgeProposalId: view.registry.knowledge_proposal_id },
      ledger: { before: head0, after: await ledgerHead(), unchanged: JSON.stringify(head0) === JSON.stringify(await ledgerHead()) },
      paymentOrders: (await q(`SELECT count(*)::int AS n FROM fleet.fleet_payment_orders`))[0].n,
    };
    expect(concluded).toMatchObject({ status: "succeeded" });
    expect(receipt).toMatchObject({ proposal: { status: "watch" }, decision: { status: "approved", decidedBy: "controller" },
      result: { outcome: "succeeded", actualSpendMinor: 170, simulatedRevenueMinor: 3600, roiAuthority: "simulated_non_authoritative" }, ledger: { unchanged: true }, paymentOrders: 0 });
    expect(receipt.transitions.map((t) => t.to)).toEqual(["proposed", "watch", "approved", "running", "succeeded"]);
    if (process.env.R24_RECEIPT) fs.writeFileSync(process.env.R24_RECEIPT, JSON.stringify(receipt, null, 2) + "\n");
  });
});

describe("R24 founder surface (no database): gated tools, unchanged manifest, toolbox passes requests through", () => {
  it("the experiment tools add no authority: existing classes, same manifest digest; only advertised while the owner has the pipeline on", async () => {
    expect(manifestSha256(FOUNDER_MANIFEST_V2)).toBe(manifestSha256(MANIFESTS["founder-v2"]));
    expect(FOUNDER_EXPERIMENT_TOOLS.map((t) => [t.name, t.capability])).toEqual([["propose_experiment", "spend.request"], ["add_experiment_evidence", "planning"],
      ["start_experiment", "planning"], ["record_experiment", "planning"], ["list_experiments", "planning"]]);
    for (const t of FOUNDER_EXPERIMENT_TOOLS) {
      expect(decideTool(t.name, FOUNDER_MANIFEST_V2)).toMatchObject({ allowed: true });
      expect(FOUNDER_TOOLS.some((x) => x.name === t.name)).toBe(false);
    }
    // Every evidence item the founder cites carries an explicit relevance claim (which the owner still assesses).
    for (const name of ["propose_experiment", "add_experiment_evidence"]) {
      const items = (FOUNDER_EXPERIMENT_TOOLS.find((t) => t.name === name)!.parameters as { properties: { evidence: { items: { required: string[] } } } }).properties.evidence.items;
      expect(items.required).toEqual(["attemptId", "sha256", "supports", "rationale"]);
    }
    const seen: string[][] = [];
    const provider = { id: "scripted" as const, model: "m", async chat(req: { tools: ToolSpec[] }) {
      seen.push(req.tools.map((t) => t.name));
      return { content: "ok", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, usageSource: "provider" as const, attempts: 1 };
    } };
    const ports = (enabled: boolean) => ({
      capabilities: async () => ({ ok: true, origin: "genesis_founder", allowed: FOUNDER_MANIFEST_V2.allowed as unknown as string[], experimentsEnabled: enabled }),
      cognitionStatus: async () => ({ ok: true, policyEnabled: true, provider: "scripted", model: "m", maxOutputTokens: 100 }),
      authorize: async () => ({ ok: true, requestId: crypto.randomUUID() }),
      record: async (_a: string, _i: string, r: { usageSource: string }) => ({ ok: true, chargedCents: 0, chargedMicrocents: 0, usageSource: r.usageSource }),
    });
    await inferLegacy(ports(false) as never, provider as never, "A", "t", { messages: [{ role: "user", content: "hb" }] });
    await inferLegacy(ports(true) as never, provider as never, "A", "t", { messages: [{ role: "user", content: "hb" }] });
    expect(seen[0].some((n) => FOUNDER_EXPERIMENT_TOOLS.some((t) => t.name === n))).toBe(false); // the legacy prompt is unchanged while off
    expect(seen[1]).toEqual(expect.arrayContaining(FOUNDER_EXPERIMENT_TOOLS.map((t) => t.name)));
  });

  it("the founder toolbox passes experiment requests through as requests (its own keys, ids validated) and reports refusals as data", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "r24-tb-"));
    fs.mkdirSync(path.join(root, "w"));
    fs.mkdirSync(path.join(root, "m"));
    const calls: Array<[string, unknown[]]> = [];
    const tb = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: path.join(root, "w"), memoryDir: path.join(root, "m"), ports: {
      ledger: async () => ({}), spendOrder: async () => ({}), proposeKnowledge: async () => ({}), knowledge: async () => [], requestIdentityFact: async () => ({}),
      experimentPropose: async (...a: unknown[]) => (calls.push(["propose", a]), { ok: false, code: "FLEET_EVIDENCE_UNVERIFIED" }),
      experimentStart: async (...a: unknown[]) => (calls.push(["start", a]), { ok: true, experiment: { status: "running" } }),
      experimentRecord: async (...a: unknown[]) => (calls.push(["record", a]), { ok: true }),
      experimentList: async () => ({ ok: true, experiments: [] }),
    } as never });
    const p = await tb.execute({ id: "toolu_1", name: "propose_experiment", arguments: { opportunityKey: "x-opp", approvedMinor: 999, idempotencyKey: "mine" } });
    expect(p).toMatchObject({ ok: false, refused: "FLEET_EVIDENCE_UNVERIFIED" });
    expect(calls[0][1][0]).toBe("exp:toolu_1"); // the key is derived from the tool call, never chosen by the model
    expect(calls[0][1][1]).toEqual({ opportunityKey: "x-opp", approvedMinor: 999 }); // passed as a request: the registry refuses decision fields
    expect(await tb.execute({ id: "toolu_2", name: "start_experiment", arguments: { experimentId: "../../etc" } })).toMatchObject({ ok: false, refused: "FLEET_BAD_REQUEST" });
    const id = crypto.randomUUID();
    expect(await tb.execute({ id: "toolu_3", name: "start_experiment", arguments: { experimentId: id } })).toMatchObject({ ok: true });
    await tb.execute({ id: "toolu_4", name: "record_experiment", arguments: { experimentId: id, kind: "result_claim", claimedOutcome: "succeeded" } });
    expect(calls.at(-1)).toEqual(["record", [{ experimentId: id, idempotencyKey: "exrec:toolu_4", kind: "result_claim", detail: { outcome: "succeeded" } }]]);
    expect(await tb.execute({ id: "toolu_5", name: "list_experiments", arguments: {} })).toMatchObject({ ok: true });
  });
});
