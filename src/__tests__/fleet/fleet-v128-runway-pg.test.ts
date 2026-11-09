/**
 * v128: the founder's own status read carries its runway — provider credit free (balance − open holds), today's budget left
 * and its open run — the figures its next call is checked against. Read-only; PostgreSQL; through the founder's credential.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";

const PG_BIN = findPgBin();

describe.skipIf(!PG_BIN)("v128 the founder's runway (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let A: string, T: string;
  const status = async () => R.one<any>(`fleet.api_cognition_status($1, $2)`, [A, T]);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1 });
    A = R.founders[0].id; T = R.founders[0].token;
    await R.q(`UPDATE fleet.fleet_cognition_policy SET provider = 'anthropic' WHERE id = 1`);
  }, 300_000);
  afterAll(async () => { await R?.close(); });

  it("is schema 128", () => { expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(128); });

  it("shows credit free less open holds, today's budget left, and the open run", async () => {
    const s0 = await status();
    expect(s0.ok).toBe(true);
    expect(s0.attention).toBeTruthy();                          // the v62 field is kept
    expect(s0.runway.run).toBeNull();
    expect(s0.runway.dailyLeftMicro).toBe(Number(s0.dailyBudgetCents) * 1_000_000 - Number(s0.spentTodayMicrocents));
    const free0 = Number(s0.runway.creditFreeMicro);
    await R.one(`fleet.fleet_provider_credits_record('anthropic', 'purchase', 500, 'test-topup', $1)`, [OWNER]);   // $5.00
    expect(Number((await status()).runway.creditFreeMicro)).toBe(free0 + 500_000_000);
    await R.one(`fleet.fleet_admin_engineering_credit_hold('test-cap', 'anthropic', 100000000, 'test cap', $1)`, [OWNER]);
    expect(Number((await status()).runway.creditFreeMicro)).toBe(free0 + 400_000_000);
    await R.one(`fleet.fleet_admin_cognition_run_start($1, 400, 1, 'a bounded run', $2)`, [A, OWNER]);
    const run = (await status()).runway.run;
    expect(run).toMatchObject({ ceilingMicro: 400_000_000, spentMicro: 0 });
    expect(Date.parse(run.endsAt) - Date.now()).toBeGreaterThan(3_500_000);
    await R.q(`SELECT fleet.fleet_admin_cognition_run_end($1, 'test ended', $2)`, [A, OWNER]);
    expect((await status()).runway.run).toBeNull();
  });

  it("a local provider is never limited by credit; a wrong token reads nothing", async () => {
    await R.q(`UPDATE fleet.fleet_cognition_policy SET provider = 'local' WHERE id = 1`);
    expect((await status()).runway.creditFreeMicro).toBeNull();
    await R.q(`UPDATE fleet.fleet_cognition_policy SET provider = 'anthropic' WHERE id = 1`);
    const bad = await R.one<any>(`fleet.api_cognition_status($1, 'not-the-token')`, [A]);
    expect(bad.ok).toBe(false);
    expect(bad.runway).toBeUndefined();
  });
});
