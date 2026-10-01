/**
 * Schema v22 neutral cognition routing — PostgreSQL (throwaway cluster).
 * Inert by default; tiers must be verified before they can be enabled; routed calls keep every legacy circuit breaker,
 * are charged at their own snapshot prices and logged with routing observability; identical failed prompts are
 * refused; the consequential-action boundary is enforced from the controller's record (mislabelling cannot lower
 * it; links are single-use; digests must match); the legacy path of non-routed founders is unchanged.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { PgFleetStore, hashAgentToken, mintAgentToken, type CognitionRecord } from "../../fleet/postgres/store.js";
import { PgLedgerAdmin } from "../../fleet/treasury/ledger.js";
import { PgGenesisAdmin } from "../../fleet/genesis/admin.js";
import { simulateRuntimeAttestation } from "../../fleet/genesis/simulate.js";
import { costMicrocents } from "../../fleet/cognition/charging.js";
import { actionDigest } from "../../fleet/cognition/router.js";
import { findPgBin, startEphemeralPg, type EphemeralPg } from "./fixtures/ephemeral-pg.js";
import { wipeRegistry } from "./fixtures/wipe.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";

const PG_BIN = findPgBin();
const OWNER = "operator:owner";
const LEGACY = { inputMicrocentsPerToken: 400, outputMicrocentsPerToken: 2_000, cacheWriteMicrocentsPerToken: 500, cacheReadMicrocentsPerToken: 20 };
const SONNET = { inputMicrocentsPerToken: 200, outputMicrocentsPerToken: 1_000, cacheWriteMicrocentsPerToken: 250, cacheReadMicrocentsPerToken: 20 };
const DST = "dst_01ABCDEFGHJKMNPQRSTVWXYZ01";

describe.skipIf(!PG_BIN)("schema v22 neutral cognition routing (PostgreSQL)", () => {
  let pgc: EphemeralPg;
  let owner: pg.Pool;
  let store: PgFleetStore;
  let svc: PgFleetStore;
  let svcRaw: pg.Pool;
  let ledger: PgLedgerAdmin;
  let genesis: PgGenesisAdmin;
  const q = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;

  async function setup(): Promise<string[]> {
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
    await ledger.recordOwnerFunding(40_000, `bank:${crypto.randomUUID()}`, OWNER);
    await q(`UPDATE fleet.fleet_genesis_policy SET genesis_max_founders = 2`);
    const g = await genesis.propose({ idempotencyKey: `g:${crypto.randomUUID()}`, founderCount: 2, allocationCents: 5_000, ttlS: 3600, actor: OWNER });
    await genesis.approve(g.genesisId, g.authSha256, OWNER);
    const p = await genesis.provision(g.genesisId, OWNER);
    for (const id of p.founderIds!) await genesis.attest(g.genesisId, id, (await simulateRuntimeAttestation(genesis, genesis, g.genesisId, id, OWNER)).host, OWNER);
    await genesis.fund(g.genesisId, OWNER);
    await genesis.activateWithHashes(g.genesisId, g.authSha256, p.founderIds!.map((id) => hashAgentToken(mintAgentToken(id))), OWNER);
    await q(`INSERT INTO fleet.fleet_provider_credit_events (provider, kind, usd_microcents, external_ref, recorded_by)
      SELECT 'anthropic', 'adjustment', 10000::bigint * 1000000 - fleet.fleet_provider_credit_balance('anthropic'), 'test: exact credit', 'operator:test'`);
    await genesis.setCognitionPolicy({ enabled: true, provider: "anthropic", model: "claude-opus-5-5", maxOutputTokens: 4_000, actor: OWNER,
      inputMicrocents: LEGACY.inputMicrocentsPerToken, outputMicrocents: LEGACY.outputMicrocentsPerToken, cacheWriteMicrocents: LEGACY.cacheWriteMicrocentsPerToken, cacheReadMicrocents: LEGACY.cacheReadMicrocentsPerToken });
    for (const id of p.founderIds!) await genesis.setFounderCognition(id, { enabled: true, maxTurnsPerHour: 3_600, dailyBudgetCents: 10_000, reason: "t", actor: OWNER });
    return p.founderIds!;
  }

  /** Verify + enable T2 and T3, routing on, founder a opted in (b stays legacy). */
  async function activate(a: string) {
    for (const [t, m] of [["T2", "claude-sonnet-5-5"], ["T3", "claude-opus-5-5"], ["T1", "claude-haiku-4-5-20251001"]]) {
      await genesis.cognitionTierVerify(t, m, "test: models api 200", OWNER);
      await genesis.cognitionTierEnable(t, true, OWNER);
    }
    await genesis.cognitionRoutingSet(true, 2_000, OWNER);
    await genesis.founderRoutingSet(a, true, OWNER);
  }

  const rec = (o: Partial<CognitionRecord> = {}): CognitionRecord => ({ outcome: "ok", inputTokens: 1_000, outputTokens: 200, promptSha256: "a".repeat(64), responseSha256: "b".repeat(64),
    toolCalls: [], errorCode: null, usageSource: "provider", attempts: 1, ...o });
  const routeFor = (tier: string, model: string, taskClass: string, extra: Record<string, unknown> = {}) =>
    ({ tier, provider: "anthropic", model, taskClass, source: "class_minimum", scope: "task_step", minTier: tier, maxTier: "T3", thinking: "adaptive", effort: "medium", ...extra });

  beforeAll(async () => {
    pgc = await startEphemeralPg(PG_BIN!);
    owner = new pg.Pool({ connectionString: pgc.ownerUrl, max: 4 });
    store = new PgFleetStore({ connectionString: pgc.ownerUrl });
    await store.migrate();
    svc = new PgFleetStore({ connectionString: pgc.serviceUrl });
    svcRaw = new pg.Pool({ connectionString: pgc.serviceUrl, max: 2 });
    ledger = new PgLedgerAdmin({ connectionString: pgc.ownerUrl });
    genesis = new PgGenesisAdmin({ connectionString: pgc.ownerUrl });
  }, 180_000);

  afterAll(async () => {
    await svcRaw?.end();
    await genesis?.close();
    await ledger?.close();
    await svc?.close();
    await store?.close();
    await owner?.end();
    pgc?.stop();
  });

  it("migrates to v22 with a clean privilege audit; routing is inert by default", async () => {
    const [a] = await setup();
    expect((await q(`SELECT max(version)::int AS v FROM fleet.fleet_schema_migrations`))[0].v).toBe(FLEET_PG_SCHEMA_VERSION);
    expect((await store.auditPrivileges()).problems).toEqual([]);
    const st = await svc.cognitionRoutingState(a);
    expect(st).toMatchObject({ routingEnabled: false, globalEnabled: false });
    expect((st!.tiers as Array<Record<string, unknown>>).map((t) => [t.tier, t.model, t.enabled, t.verifiedAt])).toEqual([
      ["T1", "claude-haiku-4-5-20251001", false, null], ["T2", "claude-sonnet-5-5", false, null], ["T3", "claude-opus-5-5", false, null]]);
    expect(await svc.cognitionRoutedAuthorize(a, 5, routeFor("T2", "claude-sonnet-5-5", "agent_step"), "1".repeat(64))).toMatchObject({ ok: false, code: "FLEET_ROUTING_DISABLED" });
    expect(await svc.actionCognitionVerify(a, "spend_request", 100_000, null, null)).toEqual({ ok: true, enforced: false });
    // Legacy path works exactly as before and writes no routing columns.
    const au = await svc.cognitionAuthorize(a, 5);
    expect(au.ok).toBe(true);
    expect((await svc.cognitionRecord(a, String(au.requestId), rec())).ok).toBe(true);
    const [row] = await q(`SELECT model, cost_microcents::bigint AS c, tier, task_class, route_version FROM fleet.fleet_cognition_log WHERE agent_id = $1`, [a]);
    expect(row).toEqual({ model: "claude-opus-5-5", c: String(costMicrocents({ inputTokens: 1_000, outputTokens: 200 }, LEGACY)), tier: null, task_class: null, route_version: null });
  });

  it("a tier cannot be enabled unverified; verification names the model; changing a mapping voids it", async () => {
    await setup();
    await expect(genesis.cognitionTierEnable("T2", true, OWNER)).rejects.toThrow(/fleet_cognition_tiers_enabled_requires_verified/);
    await expect(genesis.cognitionTierVerify("T2", "claude-sonnet-5", "wrong model", OWNER)).rejects.toThrow(/no tier T2 mapped/);
    await genesis.cognitionTierVerify("T2", "claude-sonnet-5-5", "models api", OWNER);
    await genesis.cognitionTierEnable("T2", true, OWNER);
    await genesis.cognitionTierSet({ tier: "T2", model: "claude-sonnet-5", thinking: "adaptive", effort: "medium", maxOutputTokens: 8000, inputMicrocents: 200, outputMicrocents: 1000, cacheWriteMicrocents: 250, cacheReadMicrocents: 20, actor: OWNER });
    const [t2] = await q(`SELECT model, enabled, verified_at FROM fleet.fleet_cognition_tiers WHERE tier = 'T2'`);
    expect(t2).toEqual({ model: "claude-sonnet-5", enabled: false, verified_at: null });
    await expect(genesis.cognitionRoutingSet(true, null, OWNER)).rejects.toThrow(/enable and verify at least one tier/);
  });

  it("routed calls: every legacy breaker, snapshot prices, routing observability, one founder only", async () => {
    const [a, b] = await setup();
    await activate(a);
    expect(await svc.cognitionRoutedAuthorize(b, 5, routeFor("T2", "claude-sonnet-5-5", "agent_step"), "1".repeat(64))).toMatchObject({ ok: false, code: "FLEET_ROUTING_DISABLED" });
    expect(await svc.cognitionRoutedAuthorize(a, 5, routeFor("T2", "claude-sonnet-5", "agent_step"), "1".repeat(64))).toMatchObject({ ok: false, code: "FLEET_COGNITION_MODEL_MISMATCH" });
    const au = await svc.cognitionRoutedAuthorize(a, 5, routeFor("T2", "claude-sonnet-5-5", "opportunity_research", { taskId: "opp-1" }), "1".repeat(64));
    expect(au).toMatchObject({ ok: true, tier: "T2", model: "claude-sonnet-5-5" });
    // Legacy breaker still applies: one call in flight.
    expect(await svc.cognitionRoutedAuthorize(a, 5, routeFor("T2", "claude-sonnet-5-5", "agent_step"), "2".repeat(64))).toMatchObject({ ok: false, code: "FLEET_COGNITION_BUSY" });
    // A routed authorization cannot be recorded through the legacy... and a legacy one not through the routed recorder.
    const usage = { inputTokens: 1_500, outputTokens: 300, cacheReadTokens: 4_000, cacheWriteTokens: 0 };
    const r = await svc.cognitionRoutedRecord(a, String(au.requestId), rec(usage), { packetBytes: 1234, thinkingTokens: 77, promptCache: "prefix" });
    const want = costMicrocents(usage, SONNET);
    expect(r).toMatchObject({ ok: true, tier: "T2", model: "claude-sonnet-5-5", chargedMicrocents: want, providerUsdMicrocents: want });
    const [row] = await q(`SELECT provider, model, tier, task_class, task_id, route_version, packet_bytes, thinking_tokens, reasoning, cache_read_tokens, cost_microcents::bigint AS c
      FROM fleet.fleet_cognition_log WHERE request_id = $1`, [au.requestId]);
    expect(row).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5", tier: "T2", task_class: "opportunity_research", task_id: "opp-1", route_version: 1,
      packet_bytes: 1234, thinking_tokens: 77, cache_read_tokens: 4_000, c: String(want) });
    expect(row.reasoning).toMatchObject({ thinking: "adaptive", effort: "medium", promptCache: "prefix" });
    const legacy = await svc.cognitionAuthorize(a, 5);
    expect(await svc.cognitionRoutedRecord(a, String(legacy.requestId), rec(), {})).toMatchObject({ ok: false, code: "FLEET_ROUTE_NOT_AUTHORIZED" });
    expect((await ledger.verify()).ok).toBe(true);
    const credit = await q(`SELECT -usd_microcents AS used FROM fleet.fleet_provider_credit_events WHERE request_id = $1`, [au.requestId]);
    expect(credit).toEqual([{ used: String(want) }]);
  });

  it("T1 lifecycle fails closed in the database too: a disabled T1 is refused, never served by another tier", async () => {
    const [a] = await setup();
    await activate(a);
    // A T1 task cannot be smuggled onto T2's model: the snapshot must match the named tier's own mapping.
    expect(await svc.cognitionRoutedAuthorize(a, 5, routeFor("T1", "claude-sonnet-5-5", "extraction"), "3".repeat(64))).toMatchObject({ ok: false, code: "FLEET_COGNITION_MODEL_MISMATCH" });
    await genesis.cognitionTierEnable("T1", false, OWNER);
    expect(await svc.cognitionRoutedAuthorize(a, 5, routeFor("T1", "claude-haiku-4-5-20251001", "extraction"), "3".repeat(64))).toMatchObject({ ok: false, code: "FLEET_COGNITION_TIER_UNAVAILABLE" });
    // A replacement mapping is unverified until verified through the control path.
    await genesis.cognitionTierSet({ tier: "T1", model: "claude-haiku-5", thinking: null, effort: null, maxOutputTokens: 2000, inputMicrocents: 100, outputMicrocents: 500, cacheWriteMicrocents: 125, cacheReadMicrocents: 10, actor: OWNER });
    await expect(genesis.cognitionTierEnable("T1", true, OWNER)).rejects.toThrow(/enabled_requires_verified/);
    expect(await svc.cognitionRoutedAuthorize(a, 5, routeFor("T1", "claude-haiku-5", "extraction"), "3".repeat(64))).toMatchObject({ ok: false, code: "FLEET_COGNITION_TIER_UNAVAILABLE" });
  });

  it("loop economics: an identical prompt after a non-transient failure is refused before the provider", async () => {
    const [a] = await setup();
    await activate(a);
    const bad = await svc.cognitionRoutedAuthorize(a, 5, routeFor("T2", "claude-sonnet-5-5", "agent_step"), "f".repeat(64));
    await svc.cognitionRoutedRecord(a, String(bad.requestId), rec({ outcome: "error", errorCode: "PROVIDER_BAD_REQUEST", usageSource: "none", promptSha256: "f".repeat(64), inputTokens: 0, outputTokens: 0 }), {});
    expect(await svc.cognitionRoutedAuthorize(a, 5, routeFor("T2", "claude-sonnet-5-5", "agent_step"), "f".repeat(64))).toMatchObject({ ok: false, code: "FLEET_COGNITION_DUPLICATE_FAILURE" });
    expect((await svc.cognitionRoutedAuthorize(a, 5, routeFor("T2", "claude-sonnet-5-5", "agent_step"), "e".repeat(64))).ok).toBe(true); // changed input: allowed
  });

  it("consequential-action boundary: minimum tier from the controller's record; mislabelling, reuse and digest mismatch refused", async () => {
    const [a] = await setup();
    await activate(a);
    const spend = (amountCents: number) => ({ amountCents, category: "expense", destinationId: DST });
    async function produce(tier: string, model: string, taskClass: string, toolId: string, amountCents: number) {
      const au = await svc.cognitionRoutedAuthorize(a, 5, routeFor(tier, model, taskClass), crypto.randomBytes(32).toString("hex"));
      expect(au.ok).toBe(true);
      await svc.cognitionRoutedRecord(a, String(au.requestId), rec({ toolCalls: [{ id: toolId, name: "request_spend", argsSha256: "0".repeat(64), actionSha256: actionDigest("request_spend", spend(amountCents)) }] }), {});
      return String(au.requestId);
    }
    // v30: "major" is RELATIVE — a spend exposing at least 25% (fleet_cognition_depth_policy) of the founder's own available
    // capital — never a fixed amount (the v22 £20 line is retired). Small: 10% of this founder's wallet; big: 5 000p (≥ 25%).
    const avail = Number((await q(`SELECT fleet.fleet_agent_economics($1) ->> 'expensePurchasingCapacity' AS v`, [a]))[0].v);
    const small = Math.max(1, Math.floor(avail / 10));
    expect(5_000 * 4).toBeGreaterThanOrEqual(avail);
    // Below the relative major line: T2 cognition suffices; the link is single-use.
    await produce("T2", "claude-sonnet-5-5", "capital_request_preparation", "toolu_small", small);
    expect(await svc.actionCognitionVerify(a, "spend_request", small, "toolu_small", actionDigest("request_spend", spend(small)))).toMatchObject({ ok: true, enforced: true, actionClass: "spend_request", tier: "T2" });
    expect(await svc.actionCognitionVerify(a, "spend_request", small, "toolu_small", actionDigest("request_spend", spend(small)))).toMatchObject({ ok: false, code: "FLEET_ACTION_COGNITION_REUSED" });
    // A major spend produced by T2 cognition is refused: it needs T3.
    await produce("T2", "claude-sonnet-5-5", "capital_request_preparation", "toolu_big", 5_000);
    expect(await svc.actionCognitionVerify(a, "spend_request", 5_000, "toolu_big", actionDigest("request_spend", spend(5_000)))).toMatchObject({ ok: false, code: "FLEET_ACTION_COGNITION_TIER", actionClass: "major_spend_request", minTier: "T3", tier: "T2" });
    // Mislabelled as a routine T1 task ("formatting"): the recorded tier is T1, so it is refused all the more.
    await produce("T1", "claude-haiku-4-5-20251001", "formatting", "toolu_mislabel", 5_000);
    expect(await svc.actionCognitionVerify(a, "spend_request", 5_000, "toolu_mislabel", actionDigest("request_spend", spend(5_000)))).toMatchObject({ ok: false, code: "FLEET_ACTION_COGNITION_TIER", tier: "T1" });
    // The amount was changed after the cognition (digest mismatch) / no producing call at all.
    await produce("T3", "claude-opus-5-5", "major_capital_proposal", "toolu_t3", 5_000);
    expect(await svc.actionCognitionVerify(a, "spend_request", 9_000, "toolu_t3", actionDigest("request_spend", spend(9_000)))).toMatchObject({ ok: false, code: "FLEET_ACTION_COGNITION_MISSING" });
    expect(await svc.actionCognitionVerify(a, "spend_request", 5_000, null, null)).toMatchObject({ ok: false, code: "FLEET_ACTION_COGNITION_MISSING" });
    // T3 cognition for the exact action: accepted once.
    expect(await svc.actionCognitionVerify(a, "spend_request", 5_000, "toolu_t3", actionDigest("request_spend", spend(5_000)))).toMatchObject({ ok: true, tier: "T3", actionClass: "major_spend_request" });
    // Links are append-only.
    await expect(q(`DELETE FROM fleet.fleet_action_cognition_links`)).rejects.toThrow(/FLEET_HISTORY_IMMUTABLE/);
  });

  it("grants: the service role runs the routed functions but none of the owner controls; policy rows cannot be deleted", async () => {
    const [a] = await setup();
    for (const sql of [
      `SELECT fleet.fleet_cognition_routing_set(true, 1, 'x')`, `SELECT fleet.fleet_cognition_tier_verify('T2', 'claude-sonnet-5-5', 'ref', 'x')`,
      `SELECT fleet.fleet_cognition_tier_enable('T2', true, 'x')`, `SELECT fleet.fleet_founder_routing_set('${a}', true, 'x')`,
      `UPDATE fleet.fleet_cognition_tiers SET enabled = true`, `INSERT INTO fleet.fleet_action_cognition_links VALUES (gen_random_uuid(), 'x', '${a}', 'spend_request', '${"0".repeat(64)}', 'T3')`,
    ]) await expect(svcRaw.query(sql)).rejects.toThrow(/permission denied/);
    await expect(q(`DELETE FROM fleet.fleet_cognition_tiers`)).rejects.toThrow(/FLEET_HISTORY_IMMUTABLE/);
    await expect(q(`DELETE FROM fleet.fleet_cognition_routing`)).rejects.toThrow(/FLEET_HISTORY_IMMUTABLE/);
    await expect(q(`UPDATE fleet.fleet_action_min_tier SET min_tier = 'T1'`)).rejects.toThrow(/FLEET_HISTORY_IMMUTABLE/);
  });

  it("observability: the report aggregates cost and outcome per task class × tier (legacy rows separately)", async () => {
    const [a] = await setup();
    await activate(a);
    const au = await svc.cognitionRoutedAuthorize(a, 5, routeFor("T3", "claude-opus-5-5", "failure_diagnosis", { escalationReason: "EVIDENCE_CONFLICT", requestedTier: "T3", scope: "question" }), "9".repeat(64));
    await svc.cognitionRoutedRecord(a, String(au.requestId), rec({ cacheReadTokens: 100 }), { thinkingTokens: 5 });
    const l = await svc.cognitionAuthorize(a, 5);
    await svc.cognitionRecord(a, String(l.requestId), rec());
    const rep = await genesis.cognitionReport(new Date(Date.now() - 3_600_000));
    const rows = rep.rows as Array<Record<string, unknown>>;
    expect(rows.find((r) => r.task_class === "failure_diagnosis")).toMatchObject({ tier: "T3", model: "claude-opus-5-5", calls: 1, escalations: 1, cache_read_tokens: 100, thinking_tokens: 5 });
    expect(rows.find((r) => r.task_class === "(legacy)")).toMatchObject({ tier: null, calls: 1 });
  });
}, 240_000);
