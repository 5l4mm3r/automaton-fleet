/**
 * L13 — sub-cent inference accounting (schema v17). Each call is attributed exact integer microcents; a
 * per-founder accrual posts whole cents to the ledger and carries the remainder (< 1¢), so repeated small
 * calls neither round up into artificial losses nor round down into free inference.
 * Invariant per founder: Σ posted·10⁶ + unposted = Σ charged µ¢.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { PgFleetStore, hashAgentToken, mintAgentToken, type CognitionRecord } from "../../fleet/postgres/store.js";
import { PgLedgerAdmin } from "../../fleet/treasury/ledger.js";
import { PgGenesisAdmin } from "../../fleet/genesis/admin.js";
import { simulateRuntimeAttestation } from "../../fleet/genesis/simulate.js";
import { accrue, chargedMicrocents, costMicrocents } from "../../fleet/cognition/charging.js";
import { findPgBin, startEphemeralPg, type EphemeralPg } from "./fixtures/ephemeral-pg.js";
import { wipeRegistry } from "./fixtures/wipe.js";
import { crossRateMicro, parseEcbRates, refreshFx } from "../../fleet/treasury/fx.js";

const PG_BIN = findPgBin();
const OWNER = "operator:owner";
const PRICES = { inputMicrocentsPerToken: 400, outputMicrocentsPerToken: 2_000, cacheWriteMicrocentsPerToken: 500, cacheReadMicrocentsPerToken: 20 };
const M = 1_000_000;

describe.skipIf(!PG_BIN)("L13 sub-cent inference accounting (schema v17, PostgreSQL)", () => {
  let pgc: EphemeralPg;
  let owner: pg.Pool;
  let store: PgFleetStore;
  let svc: PgFleetStore;
  let ledger: PgLedgerAdmin;
  let genesis: PgGenesisAdmin;
  const q = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;

  async function setup(budgetCents = 10_000, creditsCents = 10_000) {
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
    // Two founders simulate a future multi-founder fleet (earned expansion); production Genesis creates one (v19).
    await q(`UPDATE fleet.fleet_genesis_policy SET genesis_max_founders = 2`);
    const g = await genesis.propose({ idempotencyKey: `g:${crypto.randomUUID()}`, founderCount: 2, allocationCents: 5_000, ttlS: 3600, actor: OWNER });
    await genesis.approve(g.genesisId, g.authSha256, OWNER);
    const p = await genesis.provision(g.genesisId, OWNER);
    for (const id of p.founderIds!) await genesis.attest(g.genesisId, id, (await simulateRuntimeAttestation(genesis, genesis, g.genesisId, id, OWNER)).host, OWNER);
    await genesis.fund(g.genesisId, OWNER);
    await genesis.activateWithHashes(g.genesisId, g.authSha256, p.founderIds!.map((id) => hashAgentToken(mintAgentToken(id))), OWNER);
    // v21: the prepaid-credit gate is the provider's native-USD credit (outside the GBP ledger): exactly creditsCents.
    for (const provider of ["scripted", "anthropic", "openai_compatible"]) {
      await q(`INSERT INTO fleet.fleet_provider_credit_events (provider, kind, usd_microcents, external_ref, recorded_by)
        SELECT $1::text, 'adjustment', $2::bigint * 1000000 - fleet.fleet_provider_credit_balance($1::text), 'test: exact credit', 'operator:test'`, [provider, creditsCents]);
    }
    await genesis.setCognitionPolicy({
      enabled: true, provider: "anthropic", model: "claude-opus-5-5", maxOutputTokens: 4_000, actor: OWNER,
      inputMicrocents: PRICES.inputMicrocentsPerToken, outputMicrocents: PRICES.outputMicrocentsPerToken,
      cacheWriteMicrocents: PRICES.cacheWriteMicrocentsPerToken, cacheReadMicrocents: PRICES.cacheReadMicrocentsPerToken,
    });
    for (const id of p.founderIds!) await genesis.setFounderCognition(id, { enabled: true, maxTurnsPerHour: 3_600, dailyBudgetCents: budgetCents, reason: "t", actor: OWNER });
    return p.founderIds!;
  }

  const base: Omit<CognitionRecord, "inputTokens" | "outputTokens"> = { outcome: "ok", promptSha256: "a".repeat(64), responseSha256: "b".repeat(64), toolCalls: [], errorCode: null, usageSource: "provider", attempts: 1 };
  /** Authorize (estimate in cents) and record a call with the given usage. */
  async function call(agent: string, usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }, o: Partial<CognitionRecord> = {}, estimateCents = 100) {
    const a = await svc.cognitionAuthorize(agent, estimateCents);
    if (!a.ok) return a;
    return svc.cognitionRecord(agent, String(a.requestId), { ...base, ...usage, ...o });
  }
  const unposted = async (agent: string) => Number((await q(`SELECT unposted_microcents FROM fleet.fleet_cognition_accrual WHERE agent_id = $1`, [agent]))[0]?.unposted_microcents ?? 0);
  const cash = async (agent: string) => Number((await ledger.economics(agent)).cash);
  const journals = async (agent: string) => (await q(`SELECT count(*)::int AS n FROM fleet.fleet_ledger_journal WHERE kind = 'inference_charge' AND agent_id = $1`, [agent]))[0].n;
  /** The exact identity: posted cents·10⁶ + carried remainder = Σ attributed µ¢. */
  let agentRaw: pg.Pool;
  let svcRaw: pg.Pool;
  async function invariant(agent: string) {
    const r = (await q(`SELECT COALESCE(sum(charged_cents),0)::bigint AS posted, COALESCE(sum(charged_microcents),0)::bigint AS micro FROM fleet.fleet_cognition_log WHERE agent_id = $1`, [agent]))[0];
    expect(Number(r.posted) * M + (await unposted(agent))).toBe(Number(r.micro));
    expect(5_000 - (await cash(agent))).toBe(Number(r.posted));
    expect((await ledger.verify()).ok).toBe(true);
  }

  beforeAll(async () => {
    pgc = await startEphemeralPg(PG_BIN!);
    owner = new pg.Pool({ connectionString: pgc.ownerUrl, max: 4 });
    store = new PgFleetStore({ connectionString: pgc.ownerUrl });
    await store.migrate();
    svc = new PgFleetStore({ connectionString: pgc.serviceUrl });
    ledger = new PgLedgerAdmin({ connectionString: pgc.ownerUrl });
    genesis = new PgGenesisAdmin({ connectionString: pgc.ownerUrl });
    agentRaw = new pg.Pool({ connectionString: pgc.agentUrl, max: 2 });
    svcRaw = new pg.Pool({ connectionString: pgc.serviceUrl, max: 2 });
  }, 180_000);

  afterAll(async () => {
    await agentRaw?.end();
    await svcRaw?.end();
    await genesis?.close();
    await ledger?.close();
    await svc?.close();
    await store?.close();
    await owner?.end();
    pgc?.stop();
  });

  it("one sub-cent call is attributed exactly and carried; nothing is posted or lost", async () => {
    const [a] = await setup();
    const r = await call(a, { inputTokens: 1_000, outputTokens: 0 }); // 400,000 µ¢ = 0.4¢
    expect(r).toMatchObject({ ok: true, chargedCents: 0, chargedMicrocents: 400_000, unpostedMicrocents: 400_000, journalId: null });
    expect(await journals(a)).toBe(0);
    expect(await cash(a)).toBe(5_000);
    const st = await genesis.cognitionState(a);
    expect(st).toMatchObject({ spentTodayMicrocents: 400_000, spentTodayCents: 1, unpostedMicrocents: 400_000 }); // budget view rounds UP
    await invariant(a);
  });

  it("many sub-cent calls: exactly their sum is posted, one journal per cent crossing, no per-call rounding", async () => {
    const [a] = await setup();
    for (let i = 0; i < 25; i++) await call(a, { inputTokens: 1_000, outputTokens: 0 }); // 25 × 0.4¢ = 10¢
    expect(5_000 - (await cash(a))).toBe(10);
    expect(await unposted(a)).toBe(0);
    expect(await journals(a)).toBe(10); // each crossing posts 1¢ (the old rule would have posted 25¢)
    await invariant(a);
  });

  it("mixed input/output/thinking/cache usage is priced per category, exactly, and matches the TypeScript mirror", async () => {
    const [a] = await setup();
    const u = { inputTokens: 1_234, outputTokens: 567, cacheReadTokens: 8_900, cacheWriteTokens: 321 }; // output includes thinking
    const want = costMicrocents(u, PRICES); // 1234·400 + 567·2000 + 321·500 + 8900·20
    expect(want).toBe(493_600 + 1_134_000 + 160_500 + 178_000);
    const r = await call(a, u);
    expect(r).toMatchObject({ chargedMicrocents: want, chargedCents: Math.floor(want / M), unpostedMicrocents: want % M });
    const [row] = await q(`SELECT cost_microcents, charged_microcents, cache_read_tokens, cache_write_tokens FROM fleet.fleet_cognition_log WHERE agent_id = $1`, [a]);
    expect(row).toEqual({ cost_microcents: String(want), charged_microcents: String(want), cache_read_tokens: 8_900, cache_write_tokens: 321 });
    expect(accrue(0, chargedMicrocents("provider", u, PRICES, 100))).toEqual({ postCents: Math.floor(want / M), unpostedMicrocents: want % M });
    await invariant(a);
  });

  it("crossing exactly one cent, and crossing several cents in one call", async () => {
    const [a] = await setup();
    // 999,999 µ¢ then 1 µ¢: exactly 1¢, posted by the second call, remainder 0.
    await call(a, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 49_999 }, {}, 1); // 999,980 µ¢
    await call(a, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1 }); // +20 = 1,000,000
    expect(await unposted(a)).toBe(0);
    expect(5_000 - (await cash(a))).toBe(1);
    // Carry 600,000 then add 3,700,000: posts 4¢, carries 300,000.
    await call(a, { inputTokens: 1_500, outputTokens: 0 }); // 600,000
    const r = await call(a, { inputTokens: 0, outputTokens: 1_850 }); // 3,700,000
    expect(r).toMatchObject({ chargedCents: 4, unpostedMicrocents: 300_000 });
    expect(5_000 - (await cash(a))).toBe(5);
    await invariant(a);
  });

  it("retries, timeouts and refusals: estimate charges keep the remainder; uncharged failures change nothing; a replay never charges twice", async () => {
    const [a] = await setup();
    await call(a, { inputTokens: 1_000, outputTokens: 0 }); // carry 400,000
    // A timeout (usage unknown) is charged its whole-cent estimate; the carried remainder is untouched.
    const t = await call(a, { inputTokens: 0, outputTokens: 0 }, { outcome: "error", usageSource: "estimate", errorCode: "PROVIDER_TIMEOUT" }, 3);
    expect(t).toMatchObject({ chargedMicrocents: 3 * M, chargedCents: 3, unpostedMicrocents: 400_000 });
    // A provider error status (never billed) is 0 and leaves the accrual alone.
    const n = await call(a, { inputTokens: 0, outputTokens: 0 }, { outcome: "error", usageSource: "none", errorCode: "PROVIDER_RATE_LIMITED", attempts: 3 });
    expect(n).toMatchObject({ chargedMicrocents: 0, chargedCents: 0, unpostedMicrocents: 400_000 });
    // A retried success is one record for its attempts.
    await call(a, { inputTokens: 1_500, outputTokens: 0 }, { attempts: 2 }); // +600,000 → posts 1¢
    expect(await unposted(a)).toBe(0);
    // Replay of an already-recorded authorization: refused, accrual and ledger unchanged.
    const auth = await svc.cognitionAuthorize(a, 5);
    await svc.cognitionRecord(a, String(auth.requestId), { ...base, inputTokens: 1_000, outputTokens: 0 });
    const before = { u: await unposted(a), c: await cash(a), j: await journals(a) };
    expect(await svc.cognitionRecord(a, String(auth.requestId), { ...base, inputTokens: 999_999, outputTokens: 0 })).toMatchObject({ ok: false, code: "FLEET_COGNITION_ALREADY_RECORDED" });
    expect({ u: await unposted(a), c: await cash(a), j: await journals(a) }).toEqual(before);
    // The attribution never exceeds the reservation (cap in µ¢, not a rounded cent).
    const capped = await call(a, { inputTokens: 0, outputTokens: 100_000 }, {}, 2); // cost 2e8 µ¢, reservation 2¢
    expect(capped).toMatchObject({ chargedMicrocents: 2 * M });
    await invariant(a);
  });

  it("two founders accrue independently", async () => {
    const [a, b] = await setup();
    await call(a, { inputTokens: 1_000, outputTokens: 0 }); // a: 400,000
    await call(b, { inputTokens: 2_000, outputTokens: 0 }); // b: 800,000
    await call(a, { inputTokens: 1_000, outputTokens: 0 }); // a: 800,000
    await call(b, { inputTokens: 1_000, outputTokens: 0 }); // b: 1,200,000 → posts 1¢, carries 200,000
    expect([await unposted(a), await unposted(b)]).toEqual([800_000, 200_000]);
    expect([5_000 - (await cash(a)), 5_000 - (await cash(b))]).toEqual([0, 1]);
    await invariant(a);
    await invariant(b);
  });

  it("daily budget is exact in µ¢ and fail closed: the unposted remainder counts as spent", async () => {
    const [a] = await setup(2); // 2¢ budget
    await call(a, { inputTokens: 1_500, outputTokens: 0 }, {}, 1); // 600,000 µ¢ spent, nothing posted
    // 600,000 + reservation 1¢ ≤ 2¢ → allowed; a 2¢ reservation would exceed → refused.
    expect((await svc.cognitionAuthorize(a, 2))).toMatchObject({ ok: false, code: "FLEET_COGNITION_BUDGET_EXHAUSTED" });
    const r = await call(a, { inputTokens: 1_000, outputTokens: 0 }, {}, 1); // +400,000 = exactly 1¢ spent
    expect(r.ok).toBe(true);
    // Exactly at the boundary: 1¢ spent + 1¢ reservation = 2¢ budget → allowed; the next µ¢ over is refused.
    const ok = await call(a, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 50_000 }, {}, 1); // +1,000,000 → 2¢ spent
    expect(ok.ok).toBe(true);
    expect(await svc.cognitionAuthorize(a, 1)).toMatchObject({ ok: false, code: "FLEET_COGNITION_BUDGET_EXHAUSTED" });
    await invariant(a);
  });

  it("cash, survival-equity and prepaid-credit gates count the carried remainder (fail closed at the exact boundary)", async () => {
    const [a, b] = await setup(1_000_000, 5); // ample budget; only 5¢ of prepaid credits
    await call(b, { inputTokens: 1_000, outputTokens: 0 }, {}, 1); // b carries 400,000 µ¢ (fleet-wide credits now 5¢ − 0.4¢)
    // Credits: a 5¢ reservation no longer fits (5,000,000 − 400,000 < 5,000,000); 4¢ does.
    expect(await svc.cognitionAuthorize(a, 5)).toMatchObject({ ok: false, code: "FLEET_COGNITION_CREDITS_EXHAUSTED" });
    const four = await svc.cognitionAuthorize(a, 4);
    expect(four.ok).toBe(true);
    await svc.cognitionRecord(a, String(four.requestId), { ...base, inputTokens: 0, outputTokens: 0, usageSource: "none", outcome: "error", errorCode: "PROVIDER_UNAVAILABLE" });
    // Own funds: with 400,000 µ¢ carried, a reservation of the whole survival equity is refused; one cent less is not.
    await call(a, { inputTokens: 1_000, outputTokens: 0 }, {}, 1);
    const eq = Number((await ledger.economics(a)).survivalEquity);
    const cashA = Number((await ledger.economics(a)).cash);
    expect(eq).toBeGreaterThan(1);
    await ledger.recordProviderCredits("anthropic", "purchase", 20_000, `invoice:${crypto.randomUUID()}`, OWNER); // credits out of the way (native USD, v21)
    const refused = await svc.cognitionAuthorize(a, Math.min(eq, cashA));
    expect(refused.ok).toBe(false);
    expect(["FLEET_PROTECTED_CAPITAL", "FLEET_INSUFFICIENT_ALLOCATION"]).toContain(refused.code);
    const allowed = await svc.cognitionAuthorize(a, Math.min(eq, cashA) - 1);
    expect(allowed.ok).toBe(true);
  });

  it("v21: GBP books, USD provider credit — FleetController converts the exact USD cost at its controlled rate; founders set neither", async () => {
    const [a] = await setup(1_000_000, 1_000);
    expect((await q(`SELECT accounting_currency FROM fleet.fleet_economic_model`))[0].accounting_currency).toBe("GBP");
    expect((await q(`SELECT DISTINCT currency FROM fleet.fleet_ledger_accounts`)).map((r) => r.currency)).toEqual(["GBP"]);
    // The ECB feed: strict parse, integer cross (rounded up), recorded with provenance; implausible jumps refused.
    const csv = "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS\n" +
      "EXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,A,2026-09-25,0.86045,A,F\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-09-25,1.1403,A,F";
    expect(parseEcbRates(csv)).toEqual({ observedOn: "2026-09-25", quotePerEur: "0.86045", basePerEur: "1.1403" });
    expect(crossRateMicro("0.86045", "1.1403")).toBe(754_583);
    expect(() => parseEcbRates(csv.replace("2026-09-25,1.1403", "2026-09-24,1.1403"))).toThrow(/reference dates differ/);
    expect(() => parseEcbRates("garbage")).toThrow();
    const today = new Date().toISOString().slice(0, 10);
    // The fixture's identity rate (1.0) is > 20 % away: the controller's feed refuses the jump (nothing recorded); the owner may record it.
    await expect(refreshFx({ fetch: async () => ({ ok: true, requestedUrl: "u", finalUrl: "https://data-api.ecb.europa.eu/x", redirects: [], status: 200, contentType: "text/csv", title: null,
      text: csv.replaceAll("2026-09-25", today), truncated: false, links: [], bytes: 1, sha256: "c".repeat(64), fetchedAt: "", latencyMs: 1 }) }, (r) => svc.fxRecord(r))).rejects.toThrow(/FLEET_FX_IMPLAUSIBLE/);
    await ledger.recordFxRate("USD", "GBP", 754_582, "owner: ECB 2026-09-25 cross", today, OWNER);
    expect((await svc.fxRecord({ base: "USD", quote: "GBP", rateMicro: 754_583, source: "ECB", url: "https://x", sha256: "c".repeat(64), observedOn: today })).ok).toBe(true);
    await ledger.recordFxRate("USD", "GBP", 754_582, "owner: ECB 2026-09-25 cross (again)", today, OWNER); // latest wins
    // Founders and the controller cannot record owner rates or provider credit; founders cannot even read them.
    for (const p of [agentRaw, svcRaw]) {
      await expect(p.query(`SELECT fleet.fleet_fx_record('USD','GBP',1,'x',current_date,'operator:owner')`)).rejects.toThrow(/permission denied/);
      await expect(p.query(`SELECT fleet.fleet_provider_credits_record('anthropic','purchase',100,'ref','operator:owner')`)).rejects.toThrow(/permission denied/);
    }
    await expect(agentRaw.query(`SELECT fleet.svc_fx_record('USD','GBP',1,'x','u',NULL,current_date)`)).rejects.toThrow(/permission denied/);
    await expect(agentRaw.query(`SELECT * FROM fleet.fleet_fx_rates`)).rejects.toThrow(/permission denied/);
    await expect(agentRaw.query(`SELECT * FROM fleet.fleet_provider_credit_events`)).rejects.toThrow(/permission denied/);
    await expect(q(`UPDATE fleet.fleet_fx_rates SET rate_micro = 1`)).rejects.toThrow();
    // A 100 USD¢ estimate reserves ceil(100 × 0.754582) = 76 pence.
    const auth = await svc.cognitionAuthorize(a, 100);
    expect(auth).toMatchObject({ ok: true, estimateCents: 76, estimateUsdCents: 100, currency: "GBP", fxRateMicro: 754_582 });
    // 1,000 input tokens at 400 USD µ¢ = 400,000 USD µ¢ → ceil(400,000 × 0.754582) = 301,833 GBP µp.
    const before = Number((await ledger.providerCredits("anthropic")).balanceUsdMicrocents);
    const rec = await svc.cognitionRecord(a, String(auth.requestId), { ...base, inputTokens: 1_000, outputTokens: 0 });
    expect(rec).toMatchObject({ ok: true, chargedMicrocents: 301_833, currency: "GBP", fxRateMicro: 754_582, providerUsdMicrocents: 400_000 });
    const [row] = await q(`SELECT cost_microcents, charged_microcents, ledger_currency, fx_rate_micro, fx_rate_id, provider_usd_microcents FROM fleet.fleet_cognition_log WHERE request_id = $1`, [auth.requestId]);
    expect(row).toMatchObject({ ledger_currency: "GBP", fx_rate_micro: "754582", provider_usd_microcents: "400000" });
    expect(Number(row.cost_microcents)).toBe(400_000);
    expect(Number(row.charged_microcents)).toBe(301_833);
    expect(row.fx_rate_id).not.toBeNull();
    const pc = await ledger.providerCredits("anthropic");
    expect(Number(pc.balanceUsdMicrocents)).toBe(before - 400_000); // native USD, exact
    expect(pc).toMatchObject({ accountingCurrency: "GBP" });
    // No rate within 5 days → fail closed (every rate aged in a rolled-back transaction).
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query(`ALTER TABLE fleet.fleet_fx_rates DISABLE TRIGGER USER`);
      await c.query(`UPDATE fleet.fleet_fx_rates SET observed_on = current_date - 6`);
      expect((await c.query(`SELECT fleet.svc_cognition_authorize($1, 1) AS r`, [a])).rows[0].r).toMatchObject({ ok: false, code: "FLEET_FX_UNAVAILABLE" });
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
    // The accounting currency cannot change once journals exist.
    await expect(q(`UPDATE fleet.fleet_economic_model SET accounting_currency = 'USD'`)).rejects.toThrow(/FLEET_LEDGER_NOT_EMPTY/);
    expect((await ledger.verify()).ok).toBe(true);
  });

  it("the accrual survives a restart (it is registry state, not process state)", async () => {
    const [a] = await setup();
    await call(a, { inputTokens: 1_750, outputTokens: 0 }); // 700,000
    await svc.close();
    svc = new PgFleetStore({ connectionString: pgc.serviceUrl }); // a fresh controller connection
    const r = await call(a, { inputTokens: 1_000, outputTokens: 0 }); // +400,000 → posts 1¢, carries 100,000
    expect(r).toMatchObject({ chargedCents: 1, unpostedMicrocents: 100_000 });
    await invariant(a);
    // The accrual cannot be deleted or truncated, and only svc_cognition_record writes it (audited).
    await expect(q(`DELETE FROM fleet.fleet_cognition_accrual`)).rejects.toThrow();
    expect((await store.auditPrivileges()).problems).toEqual([]);
  });

  it("reconciles the real L14 probe: 6,560 in / 523 out at 400/2000 µ¢ = 3,670,000 µ¢ → 3¢ posted + 670,000 µ¢ carried (was 7¢)", async () => {
    const [a] = await setup();
    // The five real calls' totals (6,560 in / 523 out), split so that per-call costs are 1.2¢, 1.1¢, 0.5¢, 0.47¢, 0.4¢:
    // the v16 rule rounded each call up (2+2+1+1+1 = 7¢), which is exactly what the real probe reported.
    const calls = [[1_500, 300], [1_635, 223], [1_250, 0], [1_175, 0], [1_000, 0]];
    expect(calls.reduce((n, c) => n + c[0], 0)).toBe(6_560);
    expect(calls.reduce((n, c) => n + c[1], 0)).toBe(523);
    let oldRule = 0;
    for (const [i, o] of calls) {
      await call(a, { inputTokens: i, outputTokens: o });
      oldRule += Math.ceil((i * 400 + o * 2_000) / M);
    }
    const rows = await q(`SELECT sum(cost_microcents)::bigint AS cost, sum(charged_microcents)::bigint AS micro, sum(charged_cents)::int AS posted FROM fleet.fleet_cognition_log WHERE agent_id = $1`, [a]);
    expect(rows[0]).toEqual({ cost: "3670000", micro: "3670000", posted: 3 });
    expect(await unposted(a)).toBe(670_000);
    expect(oldRule).toBe(7); // the v16 per-call rounding would have charged 7¢ for the same calls
    await invariant(a);
  });
});
