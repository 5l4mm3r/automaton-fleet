/**
 * v112 local inference only (owner directive 2026-10-23): the registry's profile is local_only by default; under it no
 * tier and no global policy can be enabled for a cloud provider (trigger-enforced, whatever path tries), a local tier is
 * zero-priced, and only the owner's explicit, recorded choice permits cloud. Amended 2026-10-24 (before any persistent
 * registry ran v112): the migration changes no provider — a registry with cloud inference enabled is recorded cloud_allowed
 * and keeps its tiers; any other is local_only. (The controller-side profile — loadCognitionProvider — is covered by
 * fleet-cognition.)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { V112_SQL } from "../../fleet/postgres/migrations-phase112.js";

/** v112's own seed statement, exactly as the migration runs it (the runner has no stop-at-version, so it is run alone). */
const SEED = (() => {
  const from = V112_SQL.indexOf("INSERT INTO fleet_inference_profile");
  return V112_SQL.slice(from, V112_SQL.indexOf(";", V112_SQL.indexOf("UNION ALL", from)) + 1);
})();

const PG_BIN = findPgBin();

describe.skipIf(!PG_BIN)("v112 local inference only (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  beforeAll(async () => { R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, localOnly: true }); }, 180_000);
  afterAll(async () => { await R?.close(); });

  it("a new registry is local_only; a cloud tier or a cloud policy cannot be enabled", async () => {
    expect(await R.genesis.inferenceProfileState()).toMatchObject({ profile: "local_only", localComputePolicy: "unpriced" });
    await R.genesis.cognitionTierVerify("T3", (await R.q(`SELECT model FROM fleet.fleet_cognition_tiers WHERE tier = 'T3'`))[0].model, "test", OWNER).catch(() => null);
    await expect(R.genesis.cognitionTierEnable("T3", true, OWNER)).rejects.toThrow(/FLEET_INFERENCE_LOCAL_ONLY/);
    await expect(R.genesis.setCognitionPolicy({ enabled: true, provider: "anthropic", model: "claude-opus-5-5", maxOutputTokens: 4_000, actor: OWNER,
      inputMicrocents: 400, outputMicrocents: 2_000 })).rejects.toThrow(/FLEET_INFERENCE_LOCAL_ONLY/);
    // A raw write is refused the same way (the guard is on the rows, not in one function).
    await expect(R.q(`UPDATE fleet.fleet_cognition_tiers SET enabled = true, verified_at = now(), verified_ref = 'x' WHERE tier = 'T2'`)).rejects.toThrow(/FLEET_INFERENCE_LOCAL_ONLY/);
  });

  it("a tier mapped to the local model is zero-priced and can be verified and enabled; the local policy too", async () => {
    for (const t of ["T1", "T2", "T3"]) {
      const r = await R.genesis.cognitionTierSetLocal(t, "qwen3.5-9b", t === "T1" ? 2_000 : 8_000, OWNER);
      expect(r).toMatchObject({ provider: "local", model: "qwen3.5-9b", input_microcents_per_token: 0, output_microcents_per_token: 0, enabled: false });
      await R.genesis.cognitionTierVerify(t, "qwen3.5-9b", "local server /v1/models lists qwen3.5-9b", OWNER);
      expect(await R.genesis.cognitionTierEnable(t, true, OWNER)).toMatchObject({ enabled: true });
    }
    await expect(R.q(`UPDATE fleet.fleet_cognition_tiers SET output_microcents_per_token = 5 WHERE tier = 'T3'`)).rejects.toThrow(/local_unpriced/);
    expect(await R.genesis.setCognitionPolicy({ enabled: true, provider: "local", model: "qwen3.5-9b", maxOutputTokens: 8_000, actor: OWNER, inputMicrocents: 0, outputMicrocents: 0 }))
      .toMatchObject({ cognition_enabled: true, provider: "local" });
  });

  it("only the owner's explicit, recorded choice permits cloud; returning to local_only disables cloud again", async () => {
    await expect(R.genesis.inferenceProfileSet("cloud_allowed", "x", "migration")).rejects.toThrow(/FLEET_APPROVAL_REQUIRED/);
    await expect(R.genesis.inferenceProfileSet("cloud_allowed", "", OWNER)).rejects.toThrow(/reason/);
    await R.genesis.inferenceProfileSet("cloud_allowed", "test: the owner chooses cloud for one tier", OWNER);
    await R.q(`UPDATE fleet.fleet_cognition_tiers SET provider = 'anthropic', model = 'claude-sonnet-5-5', input_microcents_per_token = 300, output_microcents_per_token = 1500,
      cache_write_microcents_per_token = 375, cache_read_microcents_per_token = 30, enabled = true WHERE tier = 'T2'`);
    expect((await R.q(`SELECT enabled FROM fleet.fleet_cognition_tiers WHERE tier = 'T2'`))[0].enabled).toBe(true);
    await R.genesis.inferenceProfileSet("local_only", "test: back to local", OWNER);
    const tiers = await R.q(`SELECT tier, provider, enabled FROM fleet.fleet_cognition_tiers ORDER BY tier`);
    expect(tiers).toEqual([{ tier: "T1", provider: "local", enabled: true }, { tier: "T2", provider: "anthropic", enabled: false }, { tier: "T3", provider: "local", enabled: true }]);
    const ev = await R.q(`SELECT detail->>'profile' AS p FROM fleet.fleet_events WHERE event_type = 'inference_profile_set' ORDER BY created_at`);
    expect(ev.map((e) => e.p)).toEqual(["cloud_allowed", "local_only"]);
  });

  it("upgrading changes no provider: cloud in use stays cloud_allowed with its tiers enabled; otherwise local_only (amended 2026-10-24)", async () => {
    // The migration's body outside the owner function disables nothing.
    const body = V112_SQL.slice(0, V112_SQL.indexOf("CREATE FUNCTION fleet_cognition_tier_set_local"));
    expect(body).not.toMatch(/UPDATE fleet_cognition_(tiers|policy) SET (enabled|cognition_enabled) = false/);
    const reseed = async () => {
      const c = await R.owner.connect();
      try {
        await c.query("BEGIN"); await c.query("SET LOCAL search_path = fleet");
        await c.query("DELETE FROM fleet_inference_profile"); await c.query(SEED); await c.query("COMMIT");
      } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
      return (await R.q(`SELECT profile, set_by FROM fleet.fleet_inference_profile`))[0];
    };
    // A registry in cloud use when v112 runs (an enabled Anthropic tier, as before the local directive).
    await R.genesis.inferenceProfileSet("cloud_allowed", "test: set up a cloud registry as it was before v112", OWNER);
    await R.q(`UPDATE fleet.fleet_cognition_tiers SET enabled = true WHERE tier = 'T2'`);
    const before = await R.q(`SELECT tier, provider, enabled FROM fleet.fleet_cognition_tiers ORDER BY tier`);
    expect(before.find((t) => t.tier === "T2")).toMatchObject({ provider: "anthropic", enabled: true });
    expect(await reseed()).toEqual({ profile: "cloud_allowed", set_by: "migration" });
    expect(await R.q(`SELECT tier, provider, enabled FROM fleet.fleet_cognition_tiers ORDER BY tier`)).toEqual(before);
    // The contained production registry: no cloud tier or policy enabled → local_only; cloud only by the owner's recorded choice.
    await R.q(`UPDATE fleet.fleet_cognition_tiers SET enabled = false WHERE provider <> 'local'`);
    await R.q(`UPDATE fleet.fleet_cognition_policy SET cognition_enabled = false WHERE provider NOT IN ('local','scripted')`);
    expect(await reseed()).toEqual({ profile: "local_only", set_by: "migration" });
    await expect(R.q(`UPDATE fleet.fleet_cognition_tiers SET enabled = true WHERE tier = 'T2'`)).rejects.toThrow(/FLEET_INFERENCE_LOCAL_ONLY/);
  });

  it("an hourly-limit refusal says when the next call is eligible: the controller's time, not the founder's guess (amended 2026-10-24)", async () => {
    const f = R.founders[0].id;
    expect(await R.one(`(fleet.fleet_cognition_state($1) ->> 'policyEnabled')::boolean`, [f])).toBe(true);   // the local policy (above)
    await R.genesis.setFounderCognition(f, { enabled: true, paused: false, maxTurnsPerHour: 2, reason: "test: a small hourly bound", actor: OWNER });
    const row = (agoMin: number) => R.q(`INSERT INTO fleet.fleet_cognition_log (request_id, agent_id, provider, model, outcome, input_tokens, output_tokens,
      cost_microcents, charged_cents, prompt_sha256, response_sha256, at) VALUES (gen_random_uuid(), $1, 'local', 'qwen3.5-9b', 'ok', 1, 1, 0, 0, $2, $2,
      now() - make_interval(mins => $3))`, [f, "a".repeat(64), agoMin]);
    await row(50); await row(40);
    let r = await R.one(`fleet.svc_cognition_authorize($1, 1)`, [f]);
    // 2 calls in the hour, bound 2: eligible when the oldest (50 min ago) leaves the window — in ~10 min.
    expect(r).toMatchObject({ ok: false, code: "FLEET_COGNITION_RATE_LIMITED" });
    expect(r.retryAfterS).toBeGreaterThanOrEqual(595); expect(r.retryAfterS).toBeLessThanOrEqual(601);
    await row(5);
    r = await R.one(`fleet.svc_cognition_authorize($1, 1)`, [f]);
    // 3 calls, bound 2: two must leave — the second oldest (40 min ago) → ~20 min.
    expect(r.retryAfterS).toBeGreaterThanOrEqual(1195); expect(r.retryAfterS).toBeLessThanOrEqual(1201);
    await R.genesis.setFounderCognition(f, { maxTurnsPerHour: 1, reason: "test: one call an hour", actor: OWNER });
    r = await R.one(`fleet.svc_cognition_authorize($1, 1)`, [f]);
    // 3 calls, bound 1: all three must leave but the newest — the one 5 min ago leaves in ~55 min.
    expect(r.retryAfterS).toBeGreaterThanOrEqual(3295); expect(r.retryAfterS).toBeLessThanOrEqual(3301);
  });
});
