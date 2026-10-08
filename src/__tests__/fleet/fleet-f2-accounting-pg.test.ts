/**
 * F2 accounting invariants, security boundaries and safety flags (PostgreSQL).
 *
 * A seeded random sequence of economic events (sales, refunds, duplicate callbacks, conflicting payloads, orphans,
 * own-capital spends, cancels, tax true-ups, Fleet-capital requests, envelope spends, sweeps) is applied across three
 * founders; after EVERY step the invariants are checked:
 *   - the ledger verifies (hash chain, double entry) and global debits equal credits;
 *   - a duplicate callback never changes any balance;
 *   - venture attribution sums to exactly the settled external sales;
 *   - tax reserves are never part of available capital, and never negative;
 *   - envelope cash equals the envelopes' positions; the Treasury never goes negative;
 *   - contributions never exceed realized net profit.
 * Then the security boundaries: an agent cannot reach secrets, another wallet, tax reserves, admin or service functions;
 * malformed input fails closed. And the four engineering safety flags stay off.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { loadFleetConfig } from "../../fleet/config.js";

const PG_BIN = findPgBin();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.skipIf(!PG_BIN)("F2 accounting invariants, security boundaries and safety flags (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let svc: pg.Pool;
  let agentPool: pg.Pool;
  let rail = "";
  const ventures = new Map<string, { who: Founder; id: string }>();
  const vendors = new Map<string, string>();

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 3, allocationCents: 20_000, treasuryCents: 5_000_000 });
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2 });
    agentPool = new pg.Pool({ connectionString: R.pgc.agentUrl, max: 1 });
    await R.store.grantServiceRole();
    const e = await R.one(`fleet.fleet_admin_legal_entity_add('Fleet Trading Ltd', 'GB', 'company', true, $1)`, [OWNER]);
    await R.one(`fleet.fleet_admin_tax_profile_set($1, '[{"taxKind":"vat","rateBp":2000,"inclusive":true},{"taxKind":"profit","rateBp":2500}]'::jsonb, now() - interval '1 second', NULL, $2)`, [e.entity_id, OWNER]);
    rail = (await R.one(`fleet.fleet_admin_rail_add('simulated', 'sim', 'shared', NULL, ARRAY['receive_payments','refunds'], 'sim', NULL, 'simulated', NULL, NULL, $1)`, [OWNER])).railId;
    await R.one(`fleet.fleet_admin_sweep_policy_set(true, NULL, NULL, NULL, NULL, NULL, $1)`, [OWNER]);
    await R.q(`UPDATE fleet.fleet_capital_policy SET reapply_cooldown_s = 0`);
    for (const [i, who] of R.founders.entries()) {
      const key = `venture-${i}`;
      await R.econ(who, "venture.create", { key, model: "digital_product", offer: key, state: "selected", channels: ["direct"] });
      await R.econ(who, "rail.require", { ventureKey: key });
      ventures.set(key, { who, id: (await R.q(`SELECT venture_id FROM fleet.fleet_ventures WHERE venture_key = $1`, [key]))[0].venture_id });
      vendors.set(who.id, (await R.econ(who, "vendor.register", { vendorName: `v${i}`, category: "supplier", reference: `v${i}@vendor.example` })).destinationId);
    }
  }, 240_000);
  afterAll(async () => { await agentPool?.end(); await svc?.end(); await R?.close(); });

  const snapshot = async () => (await R.q(`SELECT account_id, fleet.fleet_ledger_balance(account_id)::bigint AS b FROM fleet.fleet_ledger_accounts ORDER BY account_id`))
    .map((r) => `${r.account_id}=${r.b}`).join("|");
  async function invariants(step: string) {
    const v = await R.one(`fleet.fleet_ledger_verify()`);
    expect(v.ok, `${step}: ledger verifies`).toBe(true);
    const tot = (await R.q(`SELECT COALESCE(sum(amount_cents) FILTER (WHERE side = 'D'), 0)::bigint AS d, COALESCE(sum(amount_cents) FILTER (WHERE side = 'C'), 0)::bigint AS c FROM fleet.fleet_ledger_postings`))[0];
    expect(tot.d, `${step}: debits = credits`).toBe(tot.c);
    const sales = Number((await R.q(`SELECT COALESCE(sum(gross_minor), 0) AS s FROM fleet.fleet_external_transactions WHERE status = 'settled' AND kind = 'sale'`))[0].s);
    const refunds = Number((await R.q(`SELECT COALESCE(sum(gross_minor), 0) AS s FROM fleet.fleet_external_transactions WHERE status = 'settled' AND kind = 'refund'`))[0].s);
    const fin = (await R.q(`SELECT COALESCE(sum((fleet.fleet_venture_financials(venture_id) ->> 'revenueMinor')::bigint), 0) AS r,
                                   COALESCE(sum((fleet.fleet_venture_financials(venture_id) ->> 'refundsMinor')::bigint), 0) AS f FROM fleet.fleet_ventures`))[0];
    expect([Number(fin.r), Number(fin.f)], `${step}: venture attribution = settled transactions`).toEqual([sales, refunds]);
    for (const who of R.founders) {
      const w = await R.one(`fleet.fleet_agent_wallet($1)`, [who.id]);
      const cash = await R.balance(`agent:${who.id}:cash`);
      expect(w.taxReserveMinor, `${step}: tax reserve never negative`).toBeGreaterThanOrEqual(0);
      expect(w.availableMinor, `${step}: available never exceeds own cash (tax reserve is outside it)`).toBeLessThanOrEqual(cash);
      const eco = await R.one(`fleet.fleet_agent_economics($1)`, [who.id]);
      expect(Number(eco.lifetimeContribution), `${step}: contributions ≤ realized net profit`).toBeLessThanOrEqual(Math.max(0, Number(eco.realizedNetProfit)));
    }
    const env = await R.one(`fleet.fleet_economy_health()`);
    expect(env.findings.find((f: { code: string }) => f.code === "ENVELOPE_LEDGER").severity, `${step}: envelope cash = positions`).toBe("INFO");
    expect(await R.balance("fleet:treasury:unallocated")).toBeGreaterThanOrEqual(0);
  }

  it("a 160-step seeded random sequence keeps every accounting invariant; duplicates never move money", async () => {
    const r = rng(20261001);
    const keys = [...ventures.keys()];
    const sent: Array<{ ext: string; kind: "sale" | "refund"; gross: number; fee: number; venture: string }> = [];
    const envelopes: Array<{ who: Founder; id: string }> = [];
    const orders: Array<{ who: Founder; id: string }> = [];
    let n = 0;
    const ingest = (ext: string, kind: string, gross: number, fee: number, venture: string | null, payload?: string) =>
      svc.query(`SELECT fleet.svc_settlement_ingest($1, $2, $3, $4, $5, 'GBP', $6, now(), $7, NULL) AS r`, [rail, ext, kind, gross, fee, venture, payload ?? sha(`${ext}|${kind}|${gross}|${fee}`)])
        .then((x) => x.rows[0].r);
    for (let step = 0; step < 160; step++) {
      const p = r();
      const v = ventures.get(keys[Math.floor(r() * keys.length)])!;
      if (p < 0.35) {
        const gross = 100 + Math.floor(r() * 5_000);
        const ext = `ord-${++n}`;
        await ingest(ext, "sale", gross, Math.floor(gross * 0.03), v.id);
        sent.push({ ext, kind: "sale", gross, fee: Math.floor(gross * 0.03), venture: v.id });
      } else if (p < 0.45 && sent.length) {
        // Duplicate callback: never moves money.
        const s = sent[Math.floor(r() * sent.length)];
        const before = await snapshot();
        expect(await ingest(s.ext, s.kind, s.gross, s.fee, s.venture)).toMatchObject({ ok: true, replay: true });
        expect(await snapshot()).toBe(before);
      } else if (p < 0.5 && sent.length) {
        // Conflicting payload for a known id: refused, nothing moves.
        const s = sent[Math.floor(r() * sent.length)];
        const before = await snapshot();
        expect(await ingest(s.ext, s.kind, s.gross + 1, s.fee, s.venture, sha(`tampered-${step}`))).toMatchObject({ ok: false, code: "FLEET_SETTLEMENT_CONFLICT" });
        expect(await snapshot()).toBe(before);
      } else if (p < 0.56) {
        // Refund of a prior sale (may fail for insufficient cash: recorded as failed, never half-posted).
        const s = sent.filter((x) => x.kind === "sale")[Math.floor(r() * Math.max(1, sent.filter((x) => x.kind === "sale").length))];
        if (s) await ingest(s.ext, "refund", s.gross, 0, s.venture);
      } else if (p < 0.6) {
        await ingest(`orphan-${++n}`, "sale", 300, 0, null); // orphan money
      } else if (p < 0.72) {
        const amount = 1 + Math.floor(r() * 3_000);
        const o = await R.gw.spendRequest(v.who.id, v.who.token, { idempotencyKey: `s:${crypto.randomUUID()}`, amountCents: amount, category: "expense", destinationId: vendors.get(v.who.id)!, purpose: "op" });
        if (o.ok) orders.push({ who: v.who, id: (o.order as { orderId: string }).orderId });
      } else if (p < 0.77 && orders.length) {
        const o = orders.splice(Math.floor(r() * orders.length), 1)[0];
        await R.gw.spendCancel(o.who.id, o.who.token, o.id);
      } else if (p < 0.82) {
        await svc.query(`SELECT fleet.svc_tax_true_up(100)`);
      } else if (p < 0.88) {
        const key = keys.find((k) => ventures.get(k)!.who.id === v.who.id)!;
        const c = await R.econ(v.who, "capital.request", { idempotencyKey: `c:${crypto.randomUUID()}`, ventureKey: key, purpose: "growth", amountMinor: 1_000 + Math.floor(r() * 20_000),
          evidence: [{ kind: "sales", observation: "a" }, { kind: "margin", observation: "b" }], expectedRevenueMinor: 30_000, expectedNetMinor: 5_000 + Math.floor(r() * 10_000),
          downsideMinor: 1_000, confidenceBp: 2_000 + Math.floor(r() * 8_000) });
        if (c.envelope) envelopes.push({ who: v.who, id: c.envelope.envelopeId });
      } else if (p < 0.94 && envelopes.length) {
        const e = envelopes[Math.floor(r() * envelopes.length)];
        await R.econ(e.who, "envelope.spend", { envelopeId: e.id, amountMinor: 1 + Math.floor(r() * 2_000), destinationId: vendors.get(e.who.id)!, purpose: "inside the envelope",
          idempotencyKey: `e:${crypto.randomUUID()}` });
      } else {
        await svc.query(`SELECT fleet.svc_sweep_run($1)`, [`2026-10-${String(1 + (step % 28)).padStart(2, "0")}`]);
        await svc.query(`SELECT fleet.svc_capital_reap(100)`);
      }
      await invariants(`step ${step}`);
    }
    expect(sent.length).toBeGreaterThan(20);
  }, 600_000);

  it("security: an agent reaches no secret, no other wallet, no tax reserve, no admin or service function; malformed input fails closed", async () => {
    const [A, B] = R.founders;
    // No table, no admin/service/internal function is reachable through the agent role.
    for (const sql of [`SELECT * FROM fleet.fleet_credential_refs`, `SELECT * FROM fleet.fleet_destination_references`, `SELECT fleet.fleet_hub('overview', '{}')`,
      `SELECT fleet.fleet_agent_wallet('${B.id}')`, `SELECT fleet.svc_settlement_ingest(gen_random_uuid(), 'x', 'sale', 1, 0, 'GBP', NULL, now(), repeat('a',64), NULL)`,
      `SELECT fleet.fleet_admin_wallet_transfer('${A.id}', 1, 'treasury', 'x', 'operator:x', 'k1234567')`, `SELECT fleet.fleet_econ_capital_request('${A.id}', '{}')`,
      `SELECT fleet.svc_sweep_run('2026-10')`]) {
      expect(await R.code(agentPool.query(sql)), sql).toBe("permission denied");
    }
    // The service role cannot run owner functions either.
    for (const sql of [`SELECT fleet.fleet_admin_rail_add('simulated','x','shared',NULL,ARRAY['receive_payments'],'x',NULL,'simulated',NULL,NULL,'operator:x')`,
      `SELECT fleet.fleet_admin_credential_register('paypal','x','vault:paypal/x','{}',false,NULL,'operator:x')`, `SELECT fleet.fleet_hub('credentials', '{}')`]) {
      expect(await R.code(svc.query(sql)), sql).toBe("permission denied");
    }
    // Another founder's envelope, vendor and venture are invisible or refused.
    const envA = (await R.econ(A, "envelope.list")).envelopes[0];
    if (envA) {
      expect(await R.econ(B, "envelope.spend", { envelopeId: envA.envelopeId, amountMinor: 1, destinationId: vendors.get(B.id)!, purpose: "x", idempotencyKey: `x:${crypto.randomUUID()}` }))
        .toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    }
    expect(await R.gw.spendRequest(B.id, B.token, { idempotencyKey: `x:${crypto.randomUUID()}`, amountCents: 1, category: "expense", destinationId: vendors.get(A.id)!, purpose: "x" }))
      .toMatchObject({ ok: false, custody: "INVALID_DESTINATION" });
    expect(await R.econ(B, "venture.status", { key: "venture-0" })).toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    // The agent's own wallet view carries no secret material.
    expect(JSON.stringify(await R.econ(A, "wallet"))).not.toMatch(/vault:|reference_sha|password|token/i);
    // Malformed input fails closed (never a partial write).
    for (const args of [{ key: 1 }, { key: "ok-key", offer: { nested: true } }, { key: "ok-key", offer: "x", capitalRequiredMinor: "100" }, { key: "ok-key", offer: "x", estMarginBp: 1.5 },
      { key: "ok-key", offer: "x", evidence: "not an array" }, { key: "ok-key", offer: "x", evidence: [{ kind: "sales", observation: "x", observedAt: "not a date" }] }]) {
      expect(await R.econ(A, "opportunity.record", args as Record<string, unknown>)).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
    }
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_opportunities WHERE opportunity_key = 'ok-key'`))[0].n).toBe(0);
    expect(await R.gw.economy(A.id, A.token, "wallet", "not an object" as unknown as Record<string, unknown>)).toMatchObject({ ok: false });
  });

  it("the four engineering safety flags are off by default and in this environment; the registry pins agree", async () => {
    const c = loadFleetConfig({});
    expect([c.realPaymentsEnabled, c.ownerSweepEnabled, c.realReplicationEnabled]).toEqual([false, false, false]);
    for (const k of ["REAL_PAYMENTS_ENABLED", "OWNER_SWEEP_ENABLED", "REAL_REPLICATION_ENABLED", "FLEET_DRY_RUN_CHILD"]) expect(process.env[k] === "true", k).toBe(false);
    const live = loadFleetConfig(process.env);
    expect([live.realPaymentsEnabled, live.ownerSweepEnabled, live.realReplicationEnabled]).toEqual([false, false, false]);
    // Registry: custody execution and live rails are pinned off by CHECK; reproduction execution pinned off.
    expect(await R.code(R.q(`UPDATE fleet.fleet_economic_model SET custody_execution_enabled = true`))).toMatch(/check constraint|FLEET_/);
    // v46: a rail's mode is fixed (the guard refuses first); a live rail is still refused by the not-live CHECK at insert.
    expect(await R.code(R.q(`UPDATE fleet.fleet_payment_rails SET mode = 'live'`))).toMatch(/fleet_payment_rails_not_live|FLEET_IMMUTABLE/);
    expect(await R.code(R.one(`fleet.fleet_admin_rail_add('paypal', 'x', 'shared', NULL, ARRAY['receive_payments'], 'x', NULL, 'live', NULL, NULL, $1)`, [OWNER])))
      .toMatch(/fleet_payment_rails_not_live/);
    expect((await R.q(`SELECT execution_enabled FROM fleet.fleet_reproduction_policy WHERE id = 1`))[0].execution_enabled).toBe(false);
  });
});
