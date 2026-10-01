/**
 * F1-FRESH-EVAL-01 harness (no paid calls): the instrument must hold before any real model is used.
 *   - the shared trunk is deterministic and exercises the PRODUCTION fact store; FRESH / LEGACY / NOMEM are distinct;
 *   - probes are severed (no provider history; packet + task only) and use the production packet builder;
 *   - scoring is deterministic and the decision rule is pre-registered (hash recorded in the evaluation configs);
 *   - the hardened driver protects restarts, budget and evidence for this evaluation too (cap ≤ $1.50);
 *   - the remote entry point dispatches the evaluation and refuses an over-ceiling budget (fake Messages API).
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import {
  ARMS, EVAL_SYSTEM, FRESH_PLAN, FakeFreshModel, KEY, PRE_REGISTRATION, PRE_REGISTRATION_SHA256, PROBE_CONTRACT, PROBE_TASK, applyTrunk, classify,
  evalTools, legacyPacket, parseAnswers, runFreshCell, scoreProbe, summarize, type FreshArm, type FreshCellRequest, type ProbeScore,
} from "../../fleet/eval/f1-fresh-eval-01.js";
import { FOUNDER_CHARTER, FOUNDER_EXPERIMENT_TOOLS, FOUNDER_ROUTED_ADDENDUM, FOUNDER_ROUTED_TOOLS } from "../../fleet/cognition/types.js";
import { EvalStateError, F1_FRESH_EVAL_01_SPEC, runPlan, scoreFresh } from "../../fleet/eval/f1-eval-02-driver.js";
import { loadFacts } from "../../fleet/founder/facts.js";
import { buildTaskPacket, taskPacketProblems } from "../../fleet/cognition/task-packet.js";
import { toolsFor } from "../../fleet/cognition/gateway.js";
import { FOUNDER_MANIFEST_V2 } from "../../fleet/capabilities.js";
import { startFakeAnthropic } from "../../fleet/cognition/fake-anthropic.js";

const PRICES = { inputMicrocentsPerToken: 200, outputMicrocentsPerToken: 1000, cacheWriteMicrocentsPerToken: 250, cacheReadMicrocentsPerToken: 20 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fresh-eval-test-"));
const req = (arm: FreshArm, o: Partial<FreshCellRequest> = {}): FreshCellRequest => ({ cellId: `t-${arm}`, arm, replicate: 1, maxSteps: 3, maxTokens: 8000, prices: PRICES, budgetMicrocents: 150_000_000, ...o });
const CONFIG = { transport: "fake", model: "claude-sonnet-5-5", effort: "medium", maxTokens: 8000, prices: PRICES, capMicrocents: 150_000_000 };

describe("F1-FRESH-EVAL-01 trunk and arms (production fact store and packet builder)", () => {
  it("the shared trunk is deterministic; FRESH keeps a structured lifecycle; LEGACY does the best the old store could", () => {
    const [a, b, l] = [tmp(), tmp(), tmp()];
    applyTrunk(a, "fresh");
    applyTrunk(b, "fresh");
    applyTrunk(l, "legacy");
    for (const f of ["facts.json", "facts-ledger.json", "goals.json"]) expect(fs.readFileSync(path.join(a, f), "utf8")).toBe(fs.readFileSync(path.join(b, f), "utf8"));
    const s = loadFacts(a);
    // Known corrections: superseded / retracted. Unlinked updates: old and new are BOTH current, told apart only by observedAt.
    expect(s.current.map((f) => [f.key, f.observedAt])).toEqual([
      ["fee_rate_stallhub", "2026-10-01T08:00:00.000Z"], ["o7_price", "2026-09-20T09:10:00.000Z"], ["o7_result", "2026-09-28T17:05:00.000Z"],
      ["price_o7", "2026-09-29T10:00:00.000Z"], ["printing_cost", "2026-09-20T09:15:00.000Z"], ["stallhub_fee_rate", "2026-09-20T09:12:00.000Z"]]);
    expect(s.history.map((h) => [h.key, h.status])).toEqual([["o7_status", "superseded"], ["printco_discount", "retracted"]]);
    const legacy = JSON.parse(fs.readFileSync(path.join(l, "facts.json"), "utf8"));
    expect(legacy).toEqual({
      o7_status: "SUPERSEDED by o7_result: Goal g1 COMPLETE: the O7 listing test has finished.",
      o7_price: "O7 single-template price: £12.00.", stallhub_fee_rate: "Stallhub transaction fee: 6.5% of each sale.",
      printing_cost: "Printed unit cost: £2.00 at the PrintCo list price.",
      printco_discount: "RETRACTED: PrintCo confirmed that no bulk discount exists; the forum post was wrong.",
      o7_result: "Goal g1 COMPLETE: the O7 listing test has finished.",
      price_o7: "O7 single-template price: £13.50.", fee_rate_stallhub: "Stallhub transaction fee: 9% of each sale.",
    });
    expect(fs.existsSync(path.join(l, "facts-ledger.json"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(l, "goals.json"), "utf8"))[0]).not.toHaveProperty("completedAt");
    // The wrong values of the KNOWN corrections are out of current memory in BOTH arms (parity); the unlinked ones in neither.
    for (const facts of [Object.fromEntries(s.current.map((f) => [f.key, f.value])), legacy]) {
      const t = JSON.stringify(facts);
      expect(t).not.toContain("£1.40");
      expect(t).not.toContain("still running");
      for (const both of ["£12.00", "£13.50", "6.5%", "9%"]) expect(t).toContain(both);
    }
  });

  it("packets: the only difference is freshness metadata; the unlinked contradictions are identically worded in both", () => {
    const [f, l, ws] = [tmp(), tmp(), tmp()];
    applyTrunk(f, "fresh");
    applyTrunk(l, "legacy");
    const pf = buildTaskPacket({ memoryDir: f, workspaceDir: ws, task: PROBE_TASK, outputContract: PROBE_CONTRACT, economics: {} });
    const pl = legacyPacket(buildTaskPacket({ memoryDir: l, workspaceDir: ws, task: PROBE_TASK, outputContract: PROBE_CONTRACT, economics: {} }));
    const price = (p: typeof pf) => p.knowledge.filter((k) => k.value.startsWith("O7 single-template price")).map((k) => [k.key, k.value, k.observedAt ?? null]);
    expect(price(pf)).toEqual([["o7_price", "O7 single-template price: £12.00.", "2026-09-20T09:10:00.000Z"], ["price_o7", "O7 single-template price: £13.50.", "2026-09-29T10:00:00.000Z"]]);
    expect(price(pl)).toEqual([["o7_price", "O7 single-template price: £12.00.", null], ["price_o7", "O7 single-template price: £13.50.", null]]);
    expect(pf.knowledge.every((k) => k.observedAt && k.provenance)).toBe(true);
    expect(pl.knowledge.every((k) => Object.keys(k).sort().join() === "key,source,value")).toBe(true); // nothing F1-FRESH-01 added
    expect(JSON.stringify(pf.knowledge)).not.toMatch(/£1\.40|RETRACTED|SUPERSEDED/);
    expect(pf.previousResults).toEqual(pl.previousResults); // same goals: the answer cannot come from the goal outcome
    expect(JSON.stringify(pf.previousResults)).not.toMatch(/13\.50|12\.00|9%|6\.5%/);
    expect(taskPacketProblems(pf)).toEqual([]);
    expect(taskPacketProblems(pl)).toEqual([]);
  });

  it("every arm gets the identical production routed prefix: same system prompt, same tool definitions", () => {
    expect(EVAL_SYSTEM).toBe(`${FOUNDER_CHARTER}\n${FOUNDER_ROUTED_ADDENDUM}`);
    const t = evalTools().map((x) => x.name);
    expect(t).toEqual(expect.arrayContaining(["remember_fact", "retract_fact", "recall_facts", ...FOUNDER_ROUTED_TOOLS.map((x) => x.name), ...FOUNDER_EXPERIMENT_TOOLS.map((x) => x.name)]));
    expect(new Set(t).size).toBe(t.length);
  });

  it("every arm is severed (no provider history) and sees a byte-identical system prompt and tool definitions", async () => {
    const seen: Record<string, Array<{ messages: number; packet: boolean; tools: string; system: string }>> = {};
    for (const arm of ARMS) {
      const model = new FakeFreshModel();
      const chat = model.chat.bind(model);
      seen[arm] = [];
      model.chat = async (r) => {
        const rr = r as unknown as { tools: unknown[]; system: string };
        seen[arm].push({ messages: r.messages.length, packet: r.messages.some((m) => String(m.content).startsWith("TASK PACKET")), tools: JSON.stringify(rr.tools), system: rr.system });
        return chat(r);
      };
      const res = await runFreshCell(req(arm), model);
      expect(res.calls[0].packetPresent).toBe(arm !== "NOMEM");
      expect(res.memorySha256 === null).toBe(arm === "NOMEM");
    }
    expect(seen.FRESH[0]).toMatchObject({ messages: 2, packet: true });
    expect(seen.LEGACY[0]).toMatchObject({ messages: 2, packet: true });
    expect(seen.NOMEM[0]).toMatchObject({ messages: 1, packet: false });
    expect(seen.LEGACY[0].tools).toBe(seen.FRESH[0].tools);
    expect(seen.NOMEM[0].tools).toBe(seen.FRESH[0].tools);
    expect(new Set(ARMS.map((a) => seen[a][0].system)).size).toBe(1);
  });

  it("the LEGACY toolbox executes the same tools as string overwrites: no metadata, no history", async () => {
    const outs: string[] = [];
    let n = 0;
    const model = { id: "scripted" as const, model: "m", async chat(r: { messages: Array<{ role: string; content: unknown }> }) {
      n++;
      if (n > 1) outs.push(...r.messages.filter((m) => m.role === "tool").map((m) => String(m.content)));
      const tc = n === 1 ? [
        { id: "a", name: "remember_fact", arguments: { key: "fee_final", value: "Stallhub transaction fee: 9% of each sale.", source: "https://x.example", supersedes: ["stallhub_fee_rate"] } },
        { id: "b", name: "retract_fact", arguments: { key: "o7_price", reason: "wrong listing" } },
        { id: "c", name: "recall_facts", arguments: { query: "fee", includeHistory: true } }] : [];
      return { content: n === 1 ? "" : "ANSWERS: q1=UNKNOWN; q2=UNKNOWN; q3=UNKNOWN; q4=UNKNOWN", toolCalls: tc, usage: { inputTokens: 10, outputTokens: 1 }, usageSource: "provider" as const, attempts: 1 };
    } };
    const r = await runFreshCell(req("LEGACY"), model as never);
    expect(r.toolOutcomes).toEqual([{ name: "remember_fact", ok: true }, { name: "retract_fact", ok: true }, { name: "recall_facts", ok: true }]);
    const recall = outs.find((o) => o.includes("\"current\""))!;
    expect(recall).toContain("SUPERSEDED by fee_final: Stallhub transaction fee: 9% of each sale.");
    expect(recall).toContain("\"history\":[]");
    expect(recall).not.toMatch(/observedAt|source/);
  });
});

describe("F1-FRESH-EVAL-01 deterministic scoring and the pre-registered rule", () => {
  it("parses the last ANSWERS line, tolerates formatting, and classifies every pre-registered wrong value", () => {
    expect(parseAnswers("x\nANSWERS: q1=1; q2=1; q3=1; q4=1\n**ANSWERS: q1=£13.50; q2=9%; q3=£2.00; q4=£9.65.**")).toEqual({ q1: "£13.50", q2: "9%", q3: "£2.00", q4: "£9.65." });
    expect(parseAnswers("no line here")).toBeNull();
    expect(parseAnswers("ANSWERS: q1=4; q2=9")).toBeNull();
    const t: Array<[`q${1 | 2 | 3 | 4}`, string, string]> = [
      ["q1", "13.50", "correct"], ["q1", "£13.5", "correct"], ["q1", "12", "stale"], ["q1", "£12.00.", "stale"], ["q1", "14", "other"], ["q1", "UNKNOWN", "unknown"],
      ["q2", "9", "correct"], ["q2", "9.0%", "correct"], ["q2", "6.5", "stale"], ["q2", "7", "other"],
      ["q3", "2", "correct"], ["q3", "£2.00.", "correct"], ["q3", "1.40", "retracted"], ["q3", "1.4", "retracted"],
      ["q4", "9.65", "correct"], ["q4", "9.66", "correct"], ["q4", "10.03", "stale"], ["q4", "10.85", "retracted"], ["q4", "11.23", "stale+retracted"], ["q4", "12", "other"],
    ];
    for (const [q, raw, want] of t) expect(classify(q, raw)).toBe(want);
    expect(classify("q4", undefined)).toBe("missing");
    // The key is arithmetic, not opinion: 15 − 15·fee − 2·cost.
    expect(15 - 15 * 0.09 - 2 * 2).toBeCloseTo(KEY.q4.correct[0], 10);
    expect(15 - 15 * 0.065 - 2 * 1.4).toBeCloseTo(KEY.q4.staleRetracted[0], 10);
  });

  it("the decision rule: PROVEN, NOT_PROVEN and INCONCLUSIVE exactly as pre-registered", () => {
    const cell = (arm: FreshArm, i: number, text: string): ProbeScore => scoreProbe(`P-${arm}-${i}`, arm, text);
    const GOOD = "ANSWERS: q1=13.50; q2=9; q3=2.00; q4=9.65", BAD = "ANSWERS: q1=12; q2=6.5; q3=1.40; q4=11.23", NONE = "ANSWERS: q1=UNKNOWN; q2=UNKNOWN; q3=UNKNOWN; q4=UNKNOWN";
    const run = (f: string, l: string, n: string) => [1, 2, 3].flatMap((i) => [cell("FRESH", i, f), cell("LEGACY", i, l), cell("NOMEM", i, n)]);
    expect(summarize(run(GOOD, BAD, NONE)).verdict).toBe("PROVEN");
    expect(summarize(run(GOOD, GOOD, NONE))).toMatchObject({ verdict: "NOT_PROVEN", checks: { freshPass: true, discrimination: false } });
    expect(summarize(run(BAD, BAD, NONE))).toMatchObject({ verdict: "NOT_PROVEN", checks: { freshPass: false } });
    expect(summarize(run(GOOD, BAD, GOOD))).toMatchObject({ verdict: "INCONCLUSIVE", checks: { negativeControl: false } }); // a leak
    expect(summarize(run("no line", "no line", NONE))).toMatchObject({ verdict: "INCONCLUSIVE", checks: { validity: false } });
    expect(PRE_REGISTRATION).toMatchObject({ replicatesPerArm: 3, fresh: { minCorrect: 10, maxRetractedUse: 0, maxStaleUse: 1 }, discrimination: { minCorrectAdvantage: 3 } });
  });

  it("the pre-registration hash recorded in the evaluation configs matches the code (no post-hoc change)", () => {
    for (const f of ["docs/evaluations/f1-fresh-eval-01/real/config.json", "docs/evaluations/f1-fresh-eval-01/fake-run/config.json"]) {
      expect(JSON.parse(fs.readFileSync(f, "utf8"))._preRegistrationSha256).toBe(PRE_REGISTRATION_SHA256);
    }
    const real = JSON.parse(fs.readFileSync("docs/evaluations/f1-fresh-eval-01/real/config.json", "utf8"));
    expect(real).toMatchObject({ transport: "ssh", model: "claude-sonnet-5-5", effort: "medium", maxTokens: 8000, capMicrocents: 150_000_000, prices: PRICES });
    // Prepared, never run: no ledger, events or results exist in the real directory.
    expect(fs.readdirSync("docs/evaluations/f1-fresh-eval-01/real").sort()).toEqual(["config.json"]);
  });
});

describe("F1-FRESH-EVAL-01 through the hardened driver (fake provider, zero cost)", () => {
  async function fresh(cfg: Record<string, unknown> = CONFIG): Promise<string> {
    const out = tmp();
    fs.writeFileSync(path.join(out, "config.json"), JSON.stringify(cfg));
    return out;
  }
  const L = (out: string) => JSON.parse(fs.readFileSync(path.join(out, "ledger.json"), "utf8"));

  it("runs all nine cells, accounts every µ¢, keeps deterministic evidence paths, and scores the instrument as discriminating", async () => {
    const out = await fresh();
    const r = await runPlan(out, { spec: F1_FRESH_EVAL_01_SPEC, log: () => undefined });
    expect(r).toEqual({ ran: FRESH_PLAN.map((c) => c.cellId), stoppedAt: null, reason: null });
    expect(fs.readdirSync(path.join(out, "cells")).sort()).toEqual(FRESH_PLAN.map((c) => `${c.cellId}.json`).sort());
    const l = L(out);
    const cells = FRESH_PLAN.map((c) => JSON.parse(fs.readFileSync(path.join(out, "cells", `${c.cellId}.json`), "utf8")));
    expect(l.totalMicrocents).toBe(cells.reduce((n, c) => n + c.spentMicrocents, 0));
    expect(l.totalMicrocents).toBe(cells.flatMap((c) => c.calls).reduce((n: number, x: { costMicrocents: number }) => n + x.costMicrocents, 0));
    // Same trunk across replicates of an arm (identical memory), distinct across arms.
    const sha = (arm: FreshArm) => [...new Set(cells.filter((c) => c.arm === arm).map((c) => c.memorySha256))];
    expect(sha("FRESH")).toHaveLength(1);
    expect(sha("LEGACY")).toHaveLength(1);
    expect(sha("NOMEM")).toEqual([null]);
    expect(sha("FRESH")[0]).not.toBe(sha("LEGACY")[0]);
    const s = scoreFresh(out);
    expect(s.verdict).toBe("PROVEN");
    // FRESH resolves both unlinked contradictions by observedAt; LEGACY's naive first-match gets the price wrong (stale)
    // and the fee right only because its newer key happens to sort first; both pass the retraction parity guard.
    expect(s.arms).toMatchObject({ FRESH: { correct: 12, stale: 0, retracted: 0 }, LEGACY: { correct: 9, stale: 3, retracted: 0 }, NOMEM: { correct: 0, unknown: 12 } });
    for (const c of s.cells) {
      expect(c.score.classes).toEqual(c.arm === "FRESH" ? { q1: "correct", q2: "correct", q3: "correct", q4: "correct" }
        : c.arm === "LEGACY" ? { q1: "stale", q2: "correct", q3: "correct", q4: "correct" } : { q1: "unknown", q2: "unknown", q3: "unknown", q4: "unknown" });
    }
  }, 120_000);

  it("refuses a config cap above $1.50; a cap too small stops at the first billable call it cannot afford", async () => {
    await expect(runPlan(await fresh({ ...CONFIG, capMicrocents: 150_000_001 }), { spec: F1_FRESH_EVAL_01_SPEC, log: () => undefined })).rejects.toThrow(/authorised \$1.50/);
    const out = await fresh({ ...CONFIG, capMicrocents: 3_000_000 });
    const r = await runPlan(out, { spec: F1_FRESH_EVAL_01_SPEC, log: () => undefined });
    expect(r).toMatchObject({ stoppedAt: "P-FRESH-1", reason: "budget" });
    const c = JSON.parse(fs.readFileSync(path.join(out, "cells", "P-FRESH-1.json"), "utf8"));
    expect(c.calls).toEqual([expect.objectContaining({ ok: false, code: "FLEET_EVAL_BUDGET_STOP", costMicrocents: 0 })]);
    expect(L(out).totalMicrocents).toBe(0);
  }, 60_000);

  it("restart shield: corrupt ledger, interrupted cell, concurrent runner and a sealed run all refuse before any billable call", async () => {
    const out = await fresh();
    await runPlan(out, { spec: F1_FRESH_EVAL_01_SPEC, only: "P-FRESH-1", log: () => undefined });
    let billable = 0;
    const transport = async (payload: Record<string, unknown>, onEvent: (l: string) => void) => {
      billable++;
      const result = await runFreshCell(payload.request as FreshCellRequest, new FakeFreshModel(), { log: (e) => onEvent(JSON.stringify(e)) });
      return { mode: "cell", model: "fake", effort: "medium", result };
    };
    const ledger = fs.readFileSync(path.join(out, "ledger.json"), "utf8");
    fs.writeFileSync(path.join(out, "ledger.json"), ledger.slice(0, 40));
    await expect(runPlan(out, { spec: F1_FRESH_EVAL_01_SPEC, transport, log: () => undefined })).rejects.toThrow(EvalStateError);
    fs.writeFileSync(path.join(out, "ledger.json"), ledger);
    fs.writeFileSync(path.join(out, "events", "P-LEGACY-1.jsonl"), `${JSON.stringify({ event: "call_start", turn: 1, step: 0, boundMicrocents: 9_000_000 })}\n`);
    expect(await runPlan(out, { spec: F1_FRESH_EVAL_01_SPEC, transport, log: () => undefined })).toMatchObject({ stoppedAt: "P-LEGACY-1", reason: expect.stringMatching(/--rerun-interrupted P-LEGACY-1/) });
    expect(L(out).interrupted).toEqual([expect.objectContaining({ cellId: "P-LEGACY-1", countedMicrocents: 9_000_000 })]);
    fs.writeFileSync(path.join(out, "run.lock"), "{}");
    await expect(runPlan(out, { spec: F1_FRESH_EVAL_01_SPEC, transport, log: () => undefined })).rejects.toThrow(/F1EVAL_LOCKED/);
    fs.rmSync(path.join(out, "run.lock"));
    fs.writeFileSync(path.join(out, "CLOSED"), "sealed");
    await expect(runPlan(out, { spec: F1_FRESH_EVAL_01_SPEC, transport, log: () => undefined })).rejects.toThrow(/F1EVAL_CLOSED/);
    expect(billable).toBe(0);
  }, 60_000);

  it("malformed fact state fails closed inside a probe: the packet reports unreadable memory, never an empty or stale truth", () => {
    const [m, ws] = [tmp(), tmp()];
    applyTrunk(m, "fresh");
    fs.writeFileSync(path.join(m, "facts-ledger.json"), "{broken");
    const p = buildTaskPacket({ memoryDir: m, workspaceDir: ws, task: PROBE_TASK, outputContract: PROBE_CONTRACT, economics: {} });
    expect(p.knowledge).toEqual([]);
    expect(p.uncertainty[0]).toMatch(/^memory:facts unreadable/);
  });
});

describe("F1-FRESH-EVAL-01 remote entry point (as a process; fake Messages API, no network billing)", () => {
  it("dispatches a probe cell on claude-sonnet-5-5 and refuses a budget above the $1.50 ceiling", async () => {
    const dir = tmp();
    const KEYV = "sk-ant-FAKEKEY-fresh-canary-0123456789abcdef";
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
      const body = { mode: "cell", evaluation: "f1-fresh-eval-01", model: "claude-sonnet-5-5", effort: "medium", request: req("FRESH", { cellId: "remote", budgetMicrocents: 20_000_000 }) };
      const r = await runMain(body);
      expect(r.code).toBe(0);
      expect(r.out + r.err).not.toContain(KEYV);
      const res = JSON.parse(r.out.split("\n").find((l) => l.startsWith("RESULT "))!.slice(7));
      expect(res).toMatchObject({ evaluation: "f1-fresh-eval-01", model: "claude-sonnet-5-5", effort: "medium", result: { evaluation: "f1-fresh-eval-01", arm: "FRESH" } });
      expect(res.result.calls.length).toBeGreaterThan(0);
      expect(fake.violations).toEqual([]);
      expect((await runMain({ ...body, request: { ...body.request, budgetMicrocents: 150_000_001 } })).code).toBe(2);
      expect((await runMain({ ...body, evaluation: "f1-unknown" })).code).toBe(2);
    } finally {
      await fake.close();
    }
  }, 60_000);
});
