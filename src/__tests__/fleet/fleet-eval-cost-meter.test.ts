/**
 * The engineering cost meter (real-model scenario suite): its ceiling holds across every call, concurrent calls and every
 * error kind, amounts are exact after FX and acquisition rounding, and each call leaves one evidence row (never the key).
 * Scripted providers only — nothing here calls a real provider.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { CostMeter, jsonlSink, type MeterTerms } from "../../fleet/eval/cost-meter.js";
import { costBoundMicro } from "../../fleet/cognition/routed-gateway.js";
import { ProviderError, type ChatRequest, type ChatResult, type CognitionProvider } from "../../fleet/cognition/types.js";
import { AnthropicProvider } from "../../fleet/cognition/anthropic.js";
import { startFakeAnthropic } from "../../fleet/cognition/fake-anthropic.js";

const OPUS = { inputMicrocentsPerToken: 400, outputMicrocentsPerToken: 2_000, cacheWriteMicrocentsPerToken: 500, cacheReadMicrocentsPerToken: 20 };
// Production snapshot shapes: FX 0.747613; a lot bought for $84.00 (receipt) giving $70.00 credit.
const terms = (ceilingPence: number): MeterTerms => ({ runId: "run-test", ceilingLedgerMicro: BigInt(ceilingPence) * 1_000_000n, fxRateMicro: 747_613n,
  acquisition: { totalUsdCents: 8_400n, usdPurchasedMicro: 7_000n * 1_000_000n }, prices: { "claude-opus-5-5": OPUS } });
const req = (bytes = 4_000, maxTokens = 16_000): ChatRequest => ({ agentId: "a", system: "s", messages: [{ role: "user", content: "x".repeat(bytes) }], tools: [], maxTokens });
type Behaviour = (r: ChatRequest) => Promise<ChatResult>;
const stub = (b: Behaviour): CognitionProvider & { calls: number } => {
  const p = { id: "anthropic" as const, model: "claude-opus-5-5", calls: 0, chat: async (r: ChatRequest) => { p.calls++; return b(r); } };
  return p;
};
const ok = (inT: number, outT: number): Behaviour => async () => ({ content: "", toolCalls: [], usage: { inputTokens: inT, outputTokens: outT }, usageSource: "provider", attempts: 1, providerRequestId: "req_abc" });
/** Independent arithmetic: USD µ¢ → ledger µ (ceil) → all-in µ (ceil), as the meter states it. */
const allIn = (usd: bigint) => { const l = (usd * 747_613n + 999_999n) / 1_000_000n; return (l * 8_400n * 1_000_000n + 7_000_000_000n - 1n) / 7_000_000_000n; };

describe("engineering cost meter", () => {
  it("refuses a call whose worst case does not fit, before anything is sent", async () => {
    const m = new CostMeter(terms(1));                                             // 1p: below any Opus worst case at 16k output
    const p = stub(ok(10, 10));
    await expect(m.wrap(p).chat(req())).rejects.toMatchObject({ code: "PROVIDER_BILLING", info: { charge: "none", detail: "HARNESS_CEILING" } });
    expect(p.calls).toBe(0);
    expect(m.rows).toMatchObject([{ outcome: "refused_ceiling", charge: "none", allInMicro: "0" }]);
    expect(m.spentAllInMicro).toBe(0n);
  });

  it("charges the exact cost of the reported usage, after FX and acquisition rounding", async () => {
    const m = new CostMeter(terms(300));
    await m.wrap(stub(ok(12_000, 300))).chat(req());
    const usd = 12_000n * 400n + 300n * 2_000n;
    expect(m.rows[0]).toMatchObject({ outcome: "ok", charge: "usage", providerRequestId: "req_abc", usdMicro: String(usd), allInMicro: String(allIn(usd)) });
    expect(m.spentAllInMicro).toBe(allIn(usd));
    expect(BigInt(m.rows[0].worstAllInMicro)).toBe(allIn(BigInt(costBoundMicro(`s\n${JSON.stringify(req().messages)}`, [], 0, 16_000, OPUS))));
  });

  it("concurrent calls reserve together: the one that would overrun is refused while the other is in flight", async () => {
    const worst = allIn(BigInt(costBoundMicro(`s\n${JSON.stringify(req().messages)}`, [], 0, 16_000, OPUS)));
    const ceilingPence = Number((worst * 3n / 2n) / 1_000_000n) + 1;                 // room for one worst case, not two
    const m = new CostMeter(terms(ceilingPence));
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const p = stub(async () => { await gate; return ok(10, 10)(req()); });
    const w = m.wrap(p);
    const first = w.chat(req());
    await expect(w.chat(req())).rejects.toMatchObject({ info: { detail: "HARNESS_CEILING" } });
    release(); await first;
    expect(p.calls).toBe(1);
  });

  it("an ambiguous error counts its worst case; a certain non-processing error counts nothing; an error with usage counts the usage", async () => {
    const m = new CostMeter(terms(300));
    const fail = (charge: "none" | "estimate" | "usage") => stub(async () => { throw new ProviderError("PROVIDER_TIMEOUT", { charge, attempts: 1, ...(charge === "usage" ? { usage: { inputTokens: 1_000, outputTokens: 5 } } : {}) }); });
    for (const c of ["none", "estimate", "usage"] as const) await expect(m.wrap(fail(c)).chat(req())).rejects.toBeInstanceOf(ProviderError);
    const [none, est, use] = m.rows;
    expect(none).toMatchObject({ charge: "none", allInMicro: "0" });
    expect(est).toMatchObject({ charge: "worst_case", allInMicro: est.worstAllInMicro });
    expect(use).toMatchObject({ charge: "usage", allInMicro: String(allIn(1_000n * 400n + 5n * 2_000n)) });
    expect(m.spentAllInMicro).toBe(BigInt(est.allInMicro) + BigInt(use.allInMicro));
  });

  it("whatever the calls cost, the spend never exceeds the ceiling", async () => {
    const m = new CostMeter(terms(150));
    let seed = 7;
    const rnd = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
    const p = stub(async (r) => {
      const x = rnd();
      if (x < 0.15) throw new ProviderError("PROVIDER_CONNECTION_LOST", { charge: "estimate", attempts: 1 });
      return ok(Math.floor(r.messages[0].content.length * rnd()), Math.floor(r.maxTokens * rnd()))(r);   // at most the bound: bytes ≥ tokens
    });
    for (let i = 0; i < 400; i++) await m.wrap(p).chat(req(500 + Math.floor(rnd() * 20_000), 1_000 + Math.floor(rnd() * 15_000))).catch(() => null);
    expect(m.spentAllInMicro).toBeLessThanOrEqual(150n * 1_000_000n);
    expect(m.rows.some((r) => r.outcome === "refused_ceiling")).toBe(true);        // it ran out and refused, rather than overspend
    expect(m.rows.reduce((s, r) => s + BigInt(r.allInMicro), 0n)).toBe(m.spentAllInMicro);   // the rows add up to the spend
  });

  it("the real Anthropic client goes through it (fake Messages API): one row per call, written as it happens, never the key", async () => {
    const KEY = "sk-test-meter-key-must-not-leak";
    const fake = await startFakeAnthropic({ apiKey: KEY, model: "claude-opus-5-5" });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meter-"));
    const file = path.join(dir, "calls.jsonl");
    try {
      const m = new CostMeter(terms(300), jsonlSink(file));
      m.scenario = "s1";
      const p = m.wrap(new AnthropicProvider({ baseUrl: fake.url, apiKey: KEY, model: "claude-opus-5-5", maxAttempts: 1 }));
      await p.chat(req(800, 1_000));
      const rows = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ runId: "run-test", scenario: "s1", outcome: "ok", charge: "usage" });
      expect(BigInt(rows[0].allInMicro)).toBeGreaterThan(0n);
      expect(fs.readFileSync(file, "utf8")).not.toContain(KEY);
      expect((fs.statSync(file).mode & 0o777).toString(8)).toBe("600");
    } finally { await fake.close(); }
  });
});

describe("the run's production credit hold", () => {
  it("covers every USD microcent the meter can let through for the terms' ceiling, and not much more", async () => {
    const { creditHoldUsdMicro, ceilingPence } = await import("../../fleet/eval/scenario-suite.js");
    const t = { capsPence: { "s1-order-and-correction": 300, "s2-interrupted-twice": 250, "s3-valid-blanks-and-blocked-inspection": 200, "s4-economical-sleep": 100,
      "s5-lesson-application": 150, "s6-opportunity-choice": 200 }, fxRateMicro: "747613", acquisition: { totalUsdCents: "4955", usdPurchasedMicro: "4129000000", lot: "x" } } as never;
    const hold = creditHoldUsdMicro(t);
    expect(ceilingPence(t)).toBe(1_200);
    const m = new CostMeter({ runId: "h", ceilingLedgerMicro: 1_200_000_000n, fxRateMicro: 747_613n, acquisition: { totalUsdCents: 4_955n, usdPurchasedMicro: 4_129_000_000n }, prices: {} });
    expect(m.allIn(hold).allIn).toBeGreaterThanOrEqual(1_200_000_000n);              // the hold's worth of usage reaches the ceiling …
    expect(m.allIn(hold - 2_000n).allIn).toBeLessThanOrEqual(1_200_000_000n);        // … and barely beyond it
    expect(Number(hold) / 1e8).toBeCloseTo(13.38, 2);                                 // $13.38 for plan B
  });
});

describe("the evaluation-only contradiction switch (scenario 3B)", () => {
  it("is inert when unset; when set, it fails the named check of spreadsheets only, and the report is no longer ok", async () => {
    const { evalContradiction } = await import("../../fleet/founder/toolbox.js");
    const file = (detectedType: string) => ({ path: `p.${detectedType}`, sha256: "a".repeat(64), sizeBytes: 10, detectedType, extensionMatches: true, ok: true,
      checks: [{ id: "cached_values", status: "pass", detail: "saved values match" }, { id: "recalc", status: "pass", detail: "ok" }], facts: {} });
    const rep = { inspector: "fleet-qa-3", files: [file("xlsx"), file("pdf")], ok: true } as never;
    expect(evalContradiction(rep, {})).toBe(rep);                                              // production: untouched
    const c = evalContradiction(rep, { FLEET_EVAL_QA_CONTRADICT: "cached_values" }) as any;
    expect(c.ok).toBe(false);
    expect(c.files[0]).toMatchObject({ ok: false });
    expect(c.files[0].checks.find((x: any) => x.id === "cached_values")).toMatchObject({ status: "fail" });
    expect(c.files[0].checks.find((x: any) => x.id === "recalc")).toMatchObject({ status: "pass" });
    expect(c.files[1]).toMatchObject({ ok: true });                                            // a PDF is not touched
    expect(evalContradiction(rep, { FLEET_EVAL_QA_CONTRADICT: "rm -rf /" })).toBe(rep);        // only a check id
  });
});
