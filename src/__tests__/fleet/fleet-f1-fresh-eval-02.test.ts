/**
 * F1-FRESH-EVAL-02 (prepared, never run): a model-driven trunk (the founder maintains its own memory through three
 * news turns) followed by a severed probe of ten current-truth questions. These tests run the whole instrument with
 * deterministic fake founders (zero cost) and prove it classifies each behaviour correctly: ideal fresh maintenance,
 * cautious legacy UNKNOWN, stale legacy, no memory, malformed output, partial tool use and incorrect maintenance.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import {
  CHANGING, CONTROLS, DETECT, FRESH2_CAP_CEILING_MICROCENTS, FRESH2_PLAN, FakeFounder2, PRE_REGISTRATION2, PRE_REGISTRATION2_SHA256, QS,
  classify2, memState, parseAnswers2, runFresh2Cell, summarize2,
  type Arm2, type Cell2Score, type Class2, type FakePolicy, type Fresh2CellRequest, type Q,
} from "../../fleet/eval/f1-fresh-eval-02.js";
import { MAX_TOOL_CALLS_EXECUTED, type ChatResult, type CognitionProvider, type ToolCall } from "../../fleet/cognition/types.js";
import { EvalStateError, F1_FRESH_EVAL_02_SPEC, runPlan, scoreFresh2 } from "../../fleet/eval/f1-eval-02-driver.js";
import { startFakeAnthropic } from "../../fleet/cognition/fake-anthropic.js";

const PRICES = { inputMicrocentsPerToken: 200, outputMicrocentsPerToken: 1000, cacheWriteMicrocentsPerToken: 250, cacheReadMicrocentsPerToken: 20 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fresh2-eval-test-"));
const req = (arm: Arm2, o: Partial<Fresh2CellRequest> = {}): Fresh2CellRequest => ({ cellId: `t-${arm}`, arm, replicate: 1, trunkMaxSteps: 4, probeMaxSteps: 3, maxTokens: 8000, prices: PRICES, budgetMicrocents: 200_000_000, ...o });
const CONFIG = { transport: "fake", model: "claude-sonnet-5-5", effort: "medium", maxTokens: 8000, prices: PRICES, capMicrocents: 200_000_000 };
const AB: Record<Class2, string> = { CURRENT_CORRECT: "C", STALE: "S", RETRACTED: "R", "STALE+RETRACTED": "SR", UNKNOWN: "U", OTHER: "O", MISSING: "M" };
const row = (s: Cell2Score) => QS.map((q) => AB[s.classes[q]]).join(" ");
const cell = (policy: FakePolicy, arm: Arm2) => runFresh2Cell(req(arm), new FakeFounder2(policy));

describe("F1-FRESH-EVAL-02 classifies every scripted behaviour correctly (production mind, toolbox and fact store)", () => {
  //                                   q1 q2 q3 q4 q5 q6 q7 q8 q9 q10
  it("ideal fresh maintenance: clean memory in both stores and every answer current", async () => {
    for (const arm of ["FRESH", "LEGACY"] as const) {
      const r = await cell("ideal", arm);
      expect(row(r.score)).toBe("C C C C C C C C C C");
      expect(Object.values(r.score.memory!).every((m) => m === "CLEAN")).toBe(true);
      expect(r.maintenance).toEqual({ rememberCalls: 14, supersedesUsed: 0, retractCalls: 1 });
      expect(r.trunkComplete).toBe(true);
    }
  }, 60_000);

  it("unlinked observations: FRESH resolves the conflicts by observedAt; cautious LEGACY answers UNKNOWN (never stale)", async () => {
    const f = await cell("unlinked", "FRESH");
    const l = await cell("unlinked", "LEGACY");
    expect(row(f.score)).toBe("C C C C C C C C C C");
    expect(row(l.score)).toBe("U U U U U C C C U U");
    for (const r of [f, l]) {
      expect((["q1", "q2", "q3", "q4", "q5", "q6"] as Q[]).map((q) => r.score.memory![q])).toEqual(Array(6).fill("AMBIGUOUS"));
      expect(r.score.memory).toMatchObject({ q7: "CLEAN", q8: "CLEAN" });
      expect(r.maintenance).toEqual({ rememberCalls: 15, supersedesUsed: 0, retractCalls: 0 });
    }
  }, 60_000);

  it("stale legacy: a first-match reader uses stale, retracted and stale+retracted values, each classified separately", async () => {
    expect(row((await cell("stalePicker", "LEGACY")).score)).toBe("S S S S S R C C SR S");
    expect(row((await cell("stalePicker", "FRESH")).score)).toBe("C C C C C C C C C C");
  }, 60_000);

  it("no memory: the probe alone, no trunk, every answer UNKNOWN", async () => {
    const r = await cell("unlinked", "NOMEM");
    expect(row(r.score)).toBe("U U U U U U U U U U");
    expect(r.calls.map((c) => c.phase)).toEqual(["probe"]);
    expect(r).toMatchObject({ memoryAfterTrunk: null, maintenance: null, trunkComplete: true });
    expect(r.score.memory).toBeNull();
  }, 30_000);

  it("malformed output: unparsed, every answer MISSING, while the maintenance evidence is still recorded", async () => {
    const r = await cell("malformed", "FRESH");
    expect(r.score.parsed).toBe(false);
    expect(row(r.score)).toBe("M M M M M M M M M M");
    expect(Object.values(r.score.memory!).every((m) => m === "CLEAN")).toBe(true);
  }, 60_000);

  it("partial tool use: unstored domains are MISSING in memory and answered UNKNOWN; controls fail retention", async () => {
    const r = await cell("partial", "FRESH");
    expect(row(r.score)).toBe("C C U C C C U U C U");
    expect(r.score.memory).toMatchObject({ q3: "MISSING", q4: "CLEAN", q5: "CLEAN", q7: "MISSING", q8: "MISSING" });
    expect(r.maintenance).toEqual({ rememberCalls: 8, supersedesUsed: 0, retractCalls: 0 });
  }, 60_000);

  it("incorrect maintenance: superseding the new fact with the old one leaves STALE_ONLY memory and stale answers in both arms", async () => {
    for (const arm of ["FRESH", "LEGACY"] as const) {
      const r = await cell("wrongMaintain", arm);
      expect(row(r.score)).toBe("S S S S S U C C U S");
      expect((["q1", "q2", "q3", "q4", "q5", "q6"] as Q[]).map((q) => r.score.memory![q])).toEqual(Array(6).fill("STALE_ONLY"));
      expect(r.maintenance).toEqual({ rememberCalls: 20, supersedesUsed: 6, retractCalls: 1 });
    }
  }, 60_000);

  it("the production per-step tool limit applies: calls beyond it are refused, recorded, and not counted as maintenance", async () => {
    let turn = 0;
    const greedy: CognitionProvider = {
      id: "scripted", model: "greedy",
      async chat(r) {
        const usage = { inputTokens: 100, outputTokens: 10 };
        const last = r.messages[r.messages.length - 1];
        if (last.role === "tool" || /PROBE/.test(String(last.content))) return { content: "ok", toolCalls: [], usage, usageSource: "provider", stopReason: "end_turn", attempts: 1 } as ChatResult;
        turn++;
        const calls: ToolCall[] = Array.from({ length: 8 }, (_, i) => ({ id: `g${turn}-${i}`, name: "remember_fact", arguments: { key: `k${turn}_${i}`, value: `v${i}` } }));
        return { content: "", toolCalls: calls, usage, usageSource: "provider", stopReason: "tool_use", attempts: 1 } as ChatResult;
      },
    };
    const r = await runFresh2Cell(req("FRESH"), greedy);
    const limited = r.toolOutcomes.filter((t) => t.refused === "FLEET_TOOL_CALL_LIMIT");
    expect(limited).toHaveLength(3 * (8 - MAX_TOOL_CALLS_EXECUTED));
    expect(r.maintenance!.rememberCalls).toBe(3 * MAX_TOOL_CALLS_EXECUTED);
    expect(r.memoryAfterTrunk).toHaveLength(3 * MAX_TOOL_CALLS_EXECUTED);
  }, 60_000);
});

describe("F1-FRESH-EVAL-02 deterministic scoring and the pre-registered rule", () => {
  it("parses the last ANSWERS line and classifies every pre-registered value (formatting, units, tokens, tolerances)", () => {
    const a = parseAnswers2("draft\nANSWERS: q1=1\n**ANSWERS: q1=£13.50.; q2=9%; q3=out; q4=12 business days; q5=30 days; q6=`£2.00`; q7=20 listings; q8=£0.35; q9=9.66; q10=no**")!;
    expect(QS.map((q) => classify2(q, a[q]))).toEqual(Array(10).fill("CURRENT_CORRECT"));
    expect([classify2("q1", "£12.00."), classify2("q2", "6.5%"), classify2("q3", "IN"), classify2("q4", "5"), classify2("q5", "14 days"), classify2("q10", "YES")]).toEqual(Array(6).fill("STALE"));
    expect([classify2("q6", "1.40"), classify2("q9", "10.85"), classify2("q9", "11.225"), classify2("q9", "10.025")]).toEqual(["RETRACTED", "RETRACTED", "STALE+RETRACTED", "STALE"]);
    expect([classify2("q7", "unknown"), classify2("q7", "21"), classify2("q3", "maybe"), classify2("q8", undefined)]).toEqual(["UNKNOWN", "OTHER", "OTHER", "MISSING"]);
    expect(parseAnswers2("no answers here")).toBeNull();
  });

  it("memory-state detectors: trailing punctuation, negated retractions and same-text current values", () => {
    expect(memState("q1", ["price: listed at £12.00."])).toBe("STALE_ONLY");
    expect(memState("q1", ["price: listed at £12.00.", "p2: listed at £13.50."])).toBe("AMBIGUOUS");
    expect(memState("q6", ["cost: printed unit cost is £2.00."])).toBe("CLEAN");
    expect(memState("q6", ["cost: £2.00", "d: forum says 30% bulk discount, £1.40"])).toBe("AMBIGUOUS");
    expect(memState("q6", ["cost: £2.00", "d: PrintCo confirmed there is no bulk discount; the forum post was wrong."])).toBe("CLEAN");
    expect(memState("q3", ["stock: paper is out of stock until 2026-10-20"])).toBe("CLEAN");
    expect(memState("q7", [])).toBe("MISSING");
    expect(Object.keys(DETECT).sort()).toEqual(["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8"]);
  });

  const synth = (arm: Arm2, replicate: number, changing: Class2, controls: Class2, o: Partial<Cell2Score> = {}): Cell2Score => ({
    cellId: `${arm}-${replicate}`, arm, replicate, parsed: true, memory: null, maintenance: null, trunkComplete: true,
    classes: Object.fromEntries(QS.map((q) => [q, CONTROLS.includes(q) ? controls : changing])) as Record<Q, Class2>, ...o,
  });
  const set = (f: Class2, l: Class2, n: Class2 = "UNKNOWN", ctl: Class2 = "CURRENT_CORRECT") => [1, 2, 3].flatMap((r) => [synth("FRESH", r, f, ctl), synth("LEGACY", r, l, ctl), synth("NOMEM", r, n, "UNKNOWN")]);

  it("the decision rule: stale use is not required; abstention and stale use count the same against current truth", () => {
    expect(PRE_REGISTRATION2).toMatchObject({ changingAnswersPerArm: 24, fresh: { minCurrentCorrect: 18 }, superiority: { minCurrentCorrectAdvantage: 6, minReplicatePairsWon: 2 } });
    expect(CHANGING).toHaveLength(8);
    // A cautious LEGACY that never uses a stale value still loses on current truth: PROVEN without any stale use.
    expect(summarize2(set("CURRENT_CORRECT", "UNKNOWN")).verdict).toBe("PROVEN");
    expect(summarize2(set("CURRENT_CORRECT", "STALE")).verdict).toBe("PROVEN");
    // Parity: no advantage → NOT_PROVEN, even with perfect FRESH answers.
    expect(summarize2(set("CURRENT_CORRECT", "CURRENT_CORRECT")).verdict).toBe("NOT_PROVEN");
    // FRESH quality below 18/24 → NOT_PROVEN.
    expect(summarize2(set("UNKNOWN", "UNKNOWN")).verdict).toBe("NOT_PROVEN");
    // Instrument failures → INCONCLUSIVE: lost retention, a NOMEM arm that knows the answers, too few parsed cells.
    expect(summarize2(set("CURRENT_CORRECT", "UNKNOWN", "UNKNOWN", "UNKNOWN")).verdict).toBe("INCONCLUSIVE");
    expect(summarize2(set("CURRENT_CORRECT", "UNKNOWN", "CURRENT_CORRECT")).verdict).toBe("INCONCLUSIVE");
    const twoUnparsed = set("CURRENT_CORRECT", "UNKNOWN").map((c, i) => (i < 2 ? { ...c, parsed: false } : c));
    expect(summarize2(twoUnparsed).checks.validity).toBe(false);
  });

  it("superiority also needs the advantage in at least 2 of 3 replicate pairs (correlated answers within a cell)", () => {
    // FRESH 8+8+8 vs LEGACY 0+8+8: advantage 8 ≥ 6 but only 1 pair won → NOT_PROVEN.
    const cells = set("CURRENT_CORRECT", "CURRENT_CORRECT").map((c) => (c.arm === "LEGACY" && c.replicate === 1 ? synth("LEGACY", 1, "UNKNOWN", "CURRENT_CORRECT") : c));
    const s = summarize2(cells);
    expect(s.arms.FRESH.currentCorrect - s.arms.LEGACY.currentCorrect).toBe(8);
    expect(s.descriptive.replicatePairsWon).toBe(1);
    expect(s.verdict).toBe("NOT_PROVEN");
  });

  it("the pre-registration hash recorded in the evaluation configs matches the code (no post-hoc change)", () => {
    for (const f of ["docs/evaluations/f1-fresh-eval-02/real/config.json", "docs/evaluations/f1-fresh-eval-02/fake-run/config.json"]) {
      expect(JSON.parse(fs.readFileSync(f, "utf8"))._preRegistrationSha256).toBe(PRE_REGISTRATION2_SHA256);
    }
    const real = JSON.parse(fs.readFileSync("docs/evaluations/f1-fresh-eval-02/real/config.json", "utf8"));
    expect(real).toMatchObject({ transport: "ssh", model: "claude-sonnet-5-5", effort: "medium", maxTokens: 8000, capMicrocents: 200_000_000, prices: PRICES });
    expect(real.capMicrocents).toBeLessThanOrEqual(FRESH2_CAP_CEILING_MICROCENTS);
    // Prepared, never run: no ledger, events or results exist in the real directory.
    expect(fs.readdirSync("docs/evaluations/f1-fresh-eval-02/real").sort()).toEqual(["config.json"]);
  });
});

describe("F1-FRESH-EVAL-02 through the hardened driver (fake founder, zero cost)", () => {
  const fresh = (cfg: Record<string, unknown> = CONFIG): string => {
    const out = tmp();
    fs.writeFileSync(path.join(out, "config.json"), JSON.stringify(cfg));
    return out;
  };
  const L = (out: string) => JSON.parse(fs.readFileSync(path.join(out, "ledger.json"), "utf8"));

  it("runs all nine cells, accounts every µ¢, and rescoring from the stored evidence reproduces the instrument verdict", async () => {
    const out = fresh();
    const r = await runPlan(out, { spec: F1_FRESH_EVAL_02_SPEC, log: () => undefined });
    expect(r).toEqual({ ran: FRESH2_PLAN.map((c) => c.cellId), stoppedAt: null, reason: null });
    const cells = FRESH2_PLAN.map((c) => JSON.parse(fs.readFileSync(path.join(out, "cells", `${c.cellId}.json`), "utf8")));
    expect(L(out).totalMicrocents).toBe(cells.reduce((n, c) => n + c.spentMicrocents, 0));
    expect(L(out).totalMicrocents).toBe(cells.flatMap((c) => c.calls).reduce((n: number, x: { costMicrocents: number }) => n + x.costMicrocents, 0));
    expect(L(out).totalMicrocents).toBeLessThanOrEqual(CONFIG.capMicrocents);
    const s = scoreFresh2(out);
    expect(s.verdict).toBe("PROVEN");
    expect(s.arms).toMatchObject({
      FRESH: { currentCorrect: 24, stale: 0, unknown: 0, controlCorrect: 6, memoryStates: { AMBIGUOUS: 18 } },
      LEGACY: { currentCorrect: 3, stale: 0, unknown: 21, controlCorrect: 6, memoryStates: { AMBIGUOUS: 18 } },
      NOMEM: { currentCorrect: 0, unknown: 24, controlCorrect: 0 },
    });
    // The fake maintains identically in both memory arms: the whole difference is representation, none is maintenance.
    expect(s.descriptive.maintenanceEffect).toEqual({ freshClean: 0, legacyClean: 0 });
    expect(s.descriptive.representationEffect).toMatchObject({ freshAmbiguousCTA: 1 });
  }, 180_000);

  it("refuses a config cap above $2.00; a cap too small stops at the first billable call it cannot afford", async () => {
    await expect(runPlan(fresh({ ...CONFIG, capMicrocents: 200_000_001 }), { spec: F1_FRESH_EVAL_02_SPEC, log: () => undefined })).rejects.toThrow(/authorised \$2.00/);
    const out = fresh({ ...CONFIG, capMicrocents: 3_000_000 });
    expect(await runPlan(out, { spec: F1_FRESH_EVAL_02_SPEC, log: () => undefined })).toMatchObject({ stoppedAt: "C-FRESH-1", reason: "budget" });
    const c = JSON.parse(fs.readFileSync(path.join(out, "cells", "C-FRESH-1.json"), "utf8"));
    expect(c.calls).toEqual([expect.objectContaining({ ok: false, code: "FLEET_EVAL_BUDGET_STOP", costMicrocents: 0 })]);
    expect(c.trunkComplete).toBe(false);
    expect(L(out).totalMicrocents).toBe(0);
  }, 60_000);

  it("restart shield: corrupt ledger, interrupted cell, concurrent runner and a sealed run all refuse before any billable call", async () => {
    const out = fresh();
    await runPlan(out, { spec: F1_FRESH_EVAL_02_SPEC, only: "C-FRESH-1", log: () => undefined });
    let billable = 0;
    const transport = async (payload: Record<string, unknown>, onEvent: (l: string) => void) => {
      billable++;
      const result = await runFresh2Cell(payload.request as Fresh2CellRequest, new FakeFounder2(), { log: (e) => onEvent(JSON.stringify(e)) });
      return { mode: "cell", model: "fake", effort: "medium", result };
    };
    const ledger = fs.readFileSync(path.join(out, "ledger.json"), "utf8");
    fs.writeFileSync(path.join(out, "ledger.json"), ledger.slice(0, 40));
    await expect(runPlan(out, { spec: F1_FRESH_EVAL_02_SPEC, transport, log: () => undefined })).rejects.toThrow(EvalStateError);
    fs.writeFileSync(path.join(out, "ledger.json"), ledger);
    fs.writeFileSync(path.join(out, "events", "C-LEGACY-1.jsonl"), `${JSON.stringify({ event: "call_start", turn: 1, step: 0, boundMicrocents: 9_000_000 })}\n`);
    expect(await runPlan(out, { spec: F1_FRESH_EVAL_02_SPEC, transport, log: () => undefined })).toMatchObject({ stoppedAt: "C-LEGACY-1", reason: expect.stringMatching(/--rerun-interrupted C-LEGACY-1/) });
    expect(L(out).interrupted).toEqual([expect.objectContaining({ cellId: "C-LEGACY-1", countedMicrocents: 9_000_000 })]);
    fs.writeFileSync(path.join(out, "run.lock"), "{}");
    await expect(runPlan(out, { spec: F1_FRESH_EVAL_02_SPEC, transport, log: () => undefined })).rejects.toThrow(/F1EVAL_LOCKED/);
    fs.rmSync(path.join(out, "run.lock"));
    fs.writeFileSync(path.join(out, "CLOSED"), "sealed");
    await expect(runPlan(out, { spec: F1_FRESH_EVAL_02_SPEC, transport, log: () => undefined })).rejects.toThrow(/F1EVAL_CLOSED/);
    expect(billable).toBe(0);
  }, 60_000);
});

describe("F1-FRESH-EVAL-02 remote entry point (as a process; fake Messages API, no network billing)", () => {
  it("dispatches a trunk+probe cell on claude-sonnet-5-5 and refuses a budget above the $2.00 ceiling", async () => {
    const dir = tmp();
    const KEYV = "sk-ant-FAKEKEY-fresh2-canary-0123456789abcdef";
    const keyFile = path.join(dir, "cognition.key");
    fs.writeFileSync(keyFile, `${KEYV}\n`, { mode: 0o600 });
    const fake = await startFakeAnthropic({ apiKey: KEYV, model: "claude-sonnet-5-5", thinking: true, fault: () => null });
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", FLEET_COGNITION_PROVIDER: "anthropic", FLEET_COGNITION_MODEL: "claude-sonnet-5-5", FLEET_COGNITION_API_KEY_FILE: keyFile, FLEET_COGNITION_BASE_URL: fake.url, FLEET_COGNITION_THINKING: "adaptive", FLEET_COGNITION_EFFORT: "medium" };
    const runMain = (body: unknown) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const p = spawn(process.execPath, ["--import", "tsx", path.resolve("src/fleet/eval/f1-eval-02-main.ts")], { env, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => resolve({ code, out, err }));
      p.stdin.end(JSON.stringify(body));
    });
    try {
      const body = { mode: "cell", evaluation: "f1-fresh-eval-02", model: "claude-sonnet-5-5", effort: "medium", request: req("FRESH", { cellId: "remote", budgetMicrocents: 40_000_000 }) };
      const r = await runMain(body);
      expect(r.code).toBe(0);
      expect(r.out + r.err).not.toContain(KEYV);
      const res = JSON.parse(r.out.split("\n").find((l) => l.startsWith("RESULT "))!.slice(7));
      expect(res).toMatchObject({ evaluation: "f1-fresh-eval-02", model: "claude-sonnet-5-5", effort: "medium", result: { evaluation: "f1-fresh-eval-02", arm: "FRESH" } });
      expect(res.result.calls.map((c: { phase: string }) => c.phase)).toEqual(expect.arrayContaining(["trunk-1", "trunk-2", "trunk-3", "probe"]));
      expect(fake.violations).toEqual([]);
      expect((await runMain({ ...body, request: { ...body.request, budgetMicrocents: 200_000_001 } })).code).toBe(2);
      expect((await runMain({ ...body, evaluation: "f1-unknown" })).code).toBe(2);
    } finally {
      await fake.close();
    }
  }, 90_000);
});
