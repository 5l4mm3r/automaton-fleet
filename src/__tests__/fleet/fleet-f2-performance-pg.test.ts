/**
 * F2 performance (PostgreSQL): the per-call database cost of the economy's hot paths at a realistic volume — the brief
 * that feeds every full task packet, the wallet, opportunity and venture reads, settlement ingest, the Hub's overview,
 * reconciliation and the economy doctor. Bounds are generous regression guards (a shared VM), and the measured
 * percentiles are printed for the engineering report.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";

const PG_BIN = findPgBin();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

describe.skipIf(!PG_BIN)("F2 performance of the economy hot paths (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let svc: pg.Pool;
  let rail = "";
  const ventures: string[] = [];

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 3, allocationCents: 50_000, treasuryCents: 5_000_000 });
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2 });
    await R.store.grantServiceRole();
    const e = await R.one(`fleet.fleet_admin_legal_entity_add('Fleet Trading Ltd', 'GB', 'company', true, $1)`, [OWNER]);
    await R.one(`fleet.fleet_admin_tax_profile_set($1, '[{"taxKind":"vat","rateBp":2000,"inclusive":true},{"taxKind":"profit","rateBp":1900}]'::jsonb, now() - interval '1 second', NULL, $2)`, [e.entity_id, OWNER]);
    rail = (await R.one(`fleet.fleet_admin_rail_add('simulated', 'sim', 'shared', NULL, ARRAY['receive_payments','refunds'], 'sim', NULL, 'simulated', NULL, NULL, $1)`, [OWNER])).railId;
    for (const [i, who] of R.founders.entries()) {
      for (let k = 0; k < 4; k++) {
        await R.econ(who, "opportunity.record", { key: `opp-${k}`, type: "digital_product", offer: `offer ${k}`, evidence: [{ kind: "sales", observation: "x" }] });
        await R.econ(who, "venture.create", { key: `v-${i}-${k}`, model: "digital_product", offer: `v${k}`, state: "selected", channels: ["direct"] });
        await R.econ(who, "rail.require", { ventureKey: `v-${i}-${k}` });
        ventures.push((await R.q(`SELECT venture_id FROM fleet.fleet_ventures WHERE venture_key = $1`, [`v-${i}-${k}`]))[0].venture_id);
      }
    }
    // 1 200 settled sales across 12 ventures (100 each) with tax reservations: realistic first-months volume.
    for (let n = 0; n < 1_200; n++) {
      await svc.query(`SELECT fleet.svc_settlement_ingest($1, $2, 'sale', $3, $4, 'GBP', $5, now(), $6, NULL)`,
        [rail, `seed-${n}`, 900 + (n % 7) * 100, 40, ventures[n % ventures.length], sha(`seed-${n}`)]);
    }
  }, 600_000);
  afterAll(async () => { await svc?.end(); await R?.close(); });

  async function timed(label: string, n: number, fn: (i: number) => Promise<unknown>) {
    const t: number[] = [];
    for (let i = 0; i < n; i++) {
      const s = process.hrtime.bigint();
      await fn(i);
      t.push(Number(process.hrtime.bigint() - s) / 1e6);
    }
    t.sort((a, b) => a - b);
    const p = (q: number) => t[Math.min(t.length - 1, Math.floor(q * t.length))];
    return { label, n, p50: +p(0.5).toFixed(2), p95: +p(0.95).toFixed(2) };
  }

  it("hot paths stay well within interactive latency at 1 200 sales / 12 ventures", async () => {
    const [A] = R.founders;
    const rows = [
      await timed("brief (every full packet)", 30, () => R.econ(A, "brief")),
      await timed("wallet", 30, () => R.econ(A, "wallet")),
      await timed("opportunity.list", 30, () => R.econ(A, "opportunity.list")),
      await timed("venture.status", 30, () => R.econ(A, "venture.status", { key: "v-0-0" })),
      await timed("settlement ingest (new sale)", 50, (i) => svc.query(`SELECT fleet.svc_settlement_ingest($1, $2, 'sale', 1000, 40, 'GBP', $3, now(), $4, NULL)`,
        [rail, `perf-${i}`, ventures[i % ventures.length], sha(`perf-${i}`)])),
      await timed("settlement ingest (duplicate)", 50, (i) => svc.query(`SELECT fleet.svc_settlement_ingest($1, $2, 'sale', 1000, 40, 'GBP', $3, now(), $4, NULL)`,
        [rail, `perf-${i}`, ventures[i % ventures.length], sha(`perf-${i}`)])),
      await timed("hub overview", 10, () => R.one(`fleet.fleet_hub('overview', '{}')`)),
      await timed("hub profit board", 10, () => R.one(`fleet.fleet_hub('profit', '{}')`)),
      await timed("reconcile", 5, () => R.one(`fleet.fleet_reconcile()`)),
      await timed("economy health (doctor)", 5, () => R.one(`fleet.fleet_economy_health()`)),
    ];
    console.log(`F2_PERF ${JSON.stringify(rows)}`);
    const by = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(by["brief (every full packet)"].p95).toBeLessThan(500);
    expect(by["settlement ingest (new sale)"].p95).toBeLessThan(500);
    expect(by["hub overview"].p95).toBeLessThan(5_000);
    expect(by["reconcile"].p95).toBeLessThan(15_000);
  }, 600_000);
});
