/**
 * v112 local inference only (owner directive 2026-10-23): the registry's profile is local_only by default; under it no
 * tier and no global policy can be enabled for a cloud provider (trigger-enforced, whatever path tries), a local tier is
 * zero-priced, and only the owner's explicit, recorded choice permits cloud. Existing enabled cloud tiers are disabled by the
 * migration itself. (The controller-side profile — loadCognitionProvider — is covered by fleet-cognition.)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";

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
});
