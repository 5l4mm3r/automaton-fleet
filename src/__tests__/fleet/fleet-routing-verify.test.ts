/**
 * The v22 routing verification runner (the real-API check's code), proven first against the fake Messages API as a
 * real process with a canary key file: tiers/models, T1 compact context, Sonnet cache write→read, a question-scoped
 * Opus escalation, control returning downward, no provider-bound thinking crossing models, exact per-model cost,
 * no retries, the budget guard firing before any request is sent, and the credential never printed.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { startFakeAnthropic } from "../../fleet/cognition/fake-anthropic.js";
import { costMicrocents } from "../../fleet/cognition/charging.js";
import { VERIFY_TIERS } from "../../fleet/eval/routing-verify.js";

const KEY = "sk-ant-FAKEKEY-routing-canary-0123456789";

async function run(req: unknown, baseUrl: string, keyFile: string) {
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", FLEET_COGNITION_PROVIDER: "anthropic", FLEET_COGNITION_MODEL: "claude-opus-5-5",
    FLEET_COGNITION_API_KEY_FILE: keyFile, FLEET_COGNITION_BASE_URL: baseUrl, FLEET_COGNITION_THINKING: "adaptive", FLEET_COGNITION_EFFORT: "medium" };
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const p = spawn(process.execPath, ["--import", "tsx", path.resolve("src/fleet/eval/routing-verify-main.ts")], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
    p.stdin.end(JSON.stringify(req));
  });
}

describe("routing verification runner (fake Messages API, real process)", () => {
  it("proves the routed path end to end within budget, and never prints the key", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rv-"));
    const keyFile = path.join(dir, "cognition.key");
    fs.writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
    const fake = await startFakeAnthropic({ apiKey: KEY, model: "claude-opus-5-5", models: ["claude-haiku-4-5-20251001", "claude-sonnet-5-5"], thinking: true, fault: () => null, cacheMinTokens: 512 });
    try {
      const r = await run({ mode: "verify", budgetMicrocents: 25_000_000 }, fake.url, keyFile);
      expect(r.code).toBe(0);
      expect(r.out + r.err).not.toContain(KEY);
      const res = JSON.parse(r.out.split("\n").find((l) => l.startsWith("RESULT "))!.slice(7));
      expect(res.stopped).toBeNull();
      // v23: the cache mode is decided per call from each tier's policy (T1 off; T2/T3 prefix; a one-off question never caches).
      expect(res.tierPromptCache).toEqual({ T1: "off", T2: "prefix", T3: "prefix" });
      expect(res.controllerPromptCache).toBe("off");
      const c = res.calls;
      expect(c.map((x: Record<string, unknown>) => [x.tier, x.model, x.scope])).toEqual([
        ["T1", "claude-haiku-4-5-20251001", "task_step"], ["T2", "claude-sonnet-5-5", "task_step"], ["T2", "claude-sonnet-5-5", "task_step"],
        ["T3", "claude-opus-5-5", "question"], ["T2", "claude-sonnet-5-5", "task_step"]]);
      // One HTTP request per call (no retries); the response names the authorized model.
      for (const x of c) {
        expect(x.requests).toHaveLength(1);
        expect(x.requests[0].responseModel).toBe(x.model);
      }
      expect(c[0].requests[0]).toMatchObject({ tools: 0, thinking: null, effort: null });
      expect(c[0].requests[0].systemCached).toBe(false);
      // R23.1: T2 caches only on evidenced reuse — not right after the T1 chore, but on the next Sonnet call inside the window.
      expect(c[1].requests[0]).toMatchObject({ thinking: { type: "adaptive" }, effort: "medium", systemCached: false, tools: 20 }); // toolbox (incl. F1-FRESH-01 retract_fact, F1-FRESH-02 remember_facts) + the two cognition tools
      expect(c[1].usage.cacheWriteTokens ?? 0).toBe(0);
      expect(c[2].requests[0].systemCached).toBe(true);
      expect(c[2].usage.cacheWriteTokens).toBeGreaterThan(0);
      expect(c[4].requests[0].systemCached).toBe(false); // after the Opus escalation: no evidenced Sonnet reuse
      // The T3 escalation: one decision packet, no toolbox, no cache write premium.
      expect(c[3].requests[0]).toMatchObject({ messages: 1, model: "claude-opus-5-5", effort: "medium", systemCached: false, tools: 0 });
      expect(c[3].usage.cacheWriteTokens ?? 0).toBe(0);
      expect(c[3].thinkingBlocks).toBeGreaterThan(0); // Opus produced signed thinking…
      expect(c[4].requests[0].containsSignature).toBe(false); // …which never reached Sonnet
      for (const x of c) expect(x.costMicrocents).toBe(costMicrocents(x.usage, VERIFY_TIERS.find((t) => t.model === x.model)!.prices));
      expect(res.spentMicrocents).toBe(c.reduce((n: number, x: { costMicrocents: number }) => n + x.costMicrocents, 0));
      expect(fake.violations).toEqual([]);
      // Over the authorised ceiling: refused outright. A tiny budget: the guard stops before any request is sent.
      expect((await run({ mode: "verify", budgetMicrocents: 25_000_001 }, fake.url, keyFile)).code).toBe(2);
      const before = [...fake.requests.values()].reduce((a, b) => a + b, 0);
      const tiny = JSON.parse((await run({ mode: "verify", budgetMicrocents: 1_000 }, fake.url, keyFile)).out.split("\n").find((l) => l.startsWith("RESULT "))!.slice(7));
      expect(tiny).toMatchObject({ stopped: "BUDGET_STOP", spentMicrocents: 0 });
      expect([...fake.requests.values()].reduce((a, b) => a + b, 0)).toBe(before);
    } finally {
      await fake.close();
    }
  }, 60_000);
});
