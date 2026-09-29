/**
 * F1-EVAL-02 harness: the experimental controls must hold before any paid inference.
 *   - the task packet is built only from persistent state (never from conversation history), deterministically,
 *     and refuses provider state, transcripts and secret-shaped text;
 *   - arm A restores history, B restores memory + a packet (no history), R memory only, C nothing;
 *   - the budget guard refuses a call before anything is sent;
 *   - signed thinking never reaches a snapshot, a result or a packet;
 *   - the real Anthropic adapter path accepts the harness's conversations (fake Messages API, no violations);
 *   - the driver checkpoints, resumes without rerunning completed cells, and counts interrupted spend conservatively.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { buildTaskPacket, renderTaskPacket, taskPacketProblems, PACKET_LIMITS } from "../../fleet/eval/task-packet.js";
import { runCell, worstCaseMicrocents, type CellRequest, type Snapshot } from "../../fleet/eval/f1-eval-02.js";
import { FakeFounderModel } from "../../fleet/eval/fake-founder-model.js";
import { PLAN, scoreCell } from "../../fleet/eval/f1-eval-02-plan.js";
import { interruptedSpend, runPlan } from "../../fleet/eval/f1-eval-02-driver.js";
import { PHASE_B_OBSERVATIONS, PHASE_C_OBSERVATION, PROBE_D, PROBE_CONTRACT } from "../../fleet/eval/f1-eval-02-fixtures.js";
import { startFakeAnthropic } from "../../fleet/cognition/fake-anthropic.js";
import { AnthropicProvider } from "../../fleet/cognition/anthropic.js";
import type { ChatRequest, ChatResult, CognitionProvider } from "../../fleet/cognition/types.js";
import { spawn } from "child_process";

const PRICES = { inputMicrocentsPerToken: 400, outputMicrocentsPerToken: 2000, cacheWriteMicrocentsPerToken: 500, cacheReadMicrocentsPerToken: 20 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "f1e02-test-"));
const cell = (o: Partial<CellRequest>): CellRequest => ({
  cellId: "t", phase: "D", arm: "C", observations: [PROBE_D], webVersion: 1, state: null, maxSteps: 4, maxTokens: 4000, prices: PRICES, budgetMicrocents: 300_000_000, ...o,
});

async function trunkState(): Promise<Snapshot> {
  const b = await runCell(cell({ cellId: "B-trunk", phase: "B", arm: "trunk", observations: PHASE_B_OBSERVATIONS }), new FakeFounderModel());
  const c = await runCell(cell({ cellId: "C-trunk", phase: "C", arm: "trunk", observations: [PHASE_C_OBSERVATION], state: b.snapshot }), new FakeFounderModel());
  return c.snapshot;
}

describe("F1-EVAL-02 task packet (provider-neutral, from persistent state only)", () => {
  function dirs(): { mem: string; ws: string } {
    const root = tmp();
    const mem = path.join(root, "memory");
    const ws = path.join(root, "workspace");
    fs.mkdirSync(path.join(ws, "research"), { recursive: true });
    fs.mkdirSync(mem);
    fs.writeFileSync(path.join(mem, "facts.json"), JSON.stringify({ o2_demand: "GroomersNet thread 41 replies, attemptId aaaaaaaa-0000-4000-8000-000000000001", risk_unknown: "conversion unverified" }));
    fs.writeFileSync(path.join(mem, "goals.json"), JSON.stringify([{ id: "g1", title: "Validate O2", status: "open" }, { id: "g0", title: "Compare", status: "complete", outcome: "O2 first" }]));
    const page = (id: string, url: string, body: string) => `UNTRUSTED EXTERNAL WEB CONTENT\nattemptId: ${id} (cite it as evidence)\nrequested: ${url}\nfinal: ${url}\nfetched: 2026-09-29T00:00:00Z\nstatus: 200  type: text/html  bytes: 1  truncated: false  sha256: ${"b".repeat(64)}\ntitle: t\n---BEGIN UNTRUSTED CONTENT---\n${body}\n---END UNTRUSTED CONTENT---\n`;
    fs.writeFileSync(path.join(ws, "research", "a.txt"), page("aaaaaaaa-0000-4000-8000-000000000001", "https://forum.groomersnet.example/t/x", "REFERENCED-EXCERPT"));
    fs.writeFileSync(path.join(ws, "research", "b.txt"), page("bbbbbbbb-0000-4000-8000-000000000002", "https://stallhub.example/other", "UNREFERENCED-EXCERPT"));
    fs.writeFileSync(path.join(ws, "plan.md"), "Validation plan: listing test");
    // Conversation history exists beside the memory, with a marker that must never reach a packet.
    fs.writeFileSync(path.join(root, "mind-history.json"), JSON.stringify([{ role: "user", content: "HISTORY-ONLY-MARKER" }]));
    return { mem, ws };
  }

  it("is deterministic, carries goals/facts/results/notes/evidence refs, and excerpts only referenced evidence", () => {
    const d = dirs();
    const a = buildTaskPacket({ memoryDir: d.mem, workspaceDir: d.ws, task: PROBE_D, outputContract: PROBE_CONTRACT });
    const b = buildTaskPacket({ memoryDir: d.mem, workspaceDir: d.ws, task: PROBE_D, outputContract: PROBE_CONTRACT });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.objective.map((g) => g.id)).toEqual(["g1"]);
    expect(a.previousResults).toEqual([{ goalId: "g0", title: "Compare", outcome: "O2 first" }]);
    expect(a.knowledge.map((k) => k.key)).toEqual(["o2_demand", "risk_unknown"]);
    expect(a.uncertainty).toEqual(["risk_unknown"]);
    expect(a.notes.map((n) => n.path)).toEqual(["plan.md"]);
    const text = renderTaskPacket(a);
    expect(text).toContain("REFERENCED-EXCERPT");
    expect(text).not.toContain("UNREFERENCED-EXCERPT");
    expect(a.evidence.map((e) => e.attemptId)).toContain("bbbbbbbb-0000-4000-8000-000000000002"); // still referenced by provenance
    expect(text).not.toContain("HISTORY-ONLY-MARKER");
    expect(Buffer.byteLength(text)).toBeLessThan(PACKET_LIMITS.totalBytes + 1_000);
  });

  it("refuses provider state, transcripts and secret-shaped text", () => {
    const d = dirs();
    const p = buildTaskPacket({ memoryDir: d.mem, workspaceDir: d.ws, task: "t", outputContract: PROBE_CONTRACT });
    expect(taskPacketProblems(p)).toEqual([]);
    expect(taskPacketProblems({ ...p, knowledge: [{ key: "x", value: "y", source: "facts.json", signature: "abc" }] })).toContain("forbidden key packet.knowledge[0].signature");
    expect(taskPacketProblems({ ...p, extra: { messages: [] } })).toContain("forbidden key packet.extra.messages");
    expect(taskPacketProblems({ ...p, task: "sk-ant-api03-abcdefghijklmnop" }).join()).toMatch(/secret-shaped/);
    expect(() => renderTaskPacket({ ...p, notes: [{ path: "x", sha256: "", bytes: 1, excerpt: "-----BEGIN PRIVATE KEY-----" }] })).toThrow(/FLEET_TASK_PACKET_INVALID/);
  });
});

describe("F1-EVAL-02 arms (controls)", () => {
  it("A restores history; B a packet without history; R memory only; C nothing (a genuine negative control)", async () => {
    const s = await trunkState();
    expect(Object.keys(s).some((k) => k.startsWith("workspace/research/"))).toBe(true);
    const run = (arm: "A" | "B" | "R" | "C") => runCell(cell({ cellId: `D-${arm}`, arm, state: s }), new FakeFounderModel());
    const [A, B, R, C] = await Promise.all([run("A"), run("B"), run("R"), run("C")]);
    expect(A.restored.history).toBeGreaterThan(0);
    expect(B.restored.history).toBe(0);
    expect(B.restored.memory).toBeGreaterThan(0);
    expect(B.packet).not.toBeNull();
    expect(B.calls.every((c) => c.packetPresent)).toBe(true);
    // B's first request is the packet + the task only: nothing from the trunk's conversation.
    expect(B.calls[0].messages).toBe(2);
    expect(R.packet).toBeNull();
    expect(R.restored).toMatchObject({ history: 0 });
    expect(R.restored.memory).toBeGreaterThan(0);
    expect(C.restored).toEqual({ history: 0, memory: 0, workspace: 0 });
    expect(C.packet).toBeNull();
    // The same task text reaches every arm.
    for (const r of [A, B, R, C]) expect(r.turns).toHaveLength(1);
    const score = (r: typeof A) => scoreCell(r, new Set()).hitCount;
    expect(score(C)).toBe(0);
    expect(score(B)).toBeGreaterThanOrEqual(5);
    expect(score(R)).toBeGreaterThanOrEqual(5); // via recall_facts
    expect(scoreCell(B, new Set()).packetMarkerSources!.forum_41.length).toBeGreaterThan(0);
  }, 60_000);

  it("C cannot reach the learned evidence through the web either (the probe names no URLs)", async () => {
    const C = await runCell(cell({ arm: "C" }), new FakeFounderModel());
    expect(C.fetches).toEqual([]);
    expect(PROBE_D).not.toMatch(/https?:\/\//);
  });
});

describe("F1-EVAL-02 budget guard, leak and protocol checks", () => {
  it("refuses a call whose worst case exceeds the remaining budget, before the provider is reached", async () => {
    const m = new FakeFounderModel();
    const r = await runCell(cell({ budgetMicrocents: 1_000_000 }), m);
    expect(m.calls).toBe(0);
    expect(r.stopped).toBe("budget");
    expect(r.spentMicrocents).toBe(0);
    expect(r.calls[0].code).toBe("FLEET_EVAL_BUDGET_STOP");
    expect(worstCaseMicrocents(10_000, 4000, PRICES)).toBe(12_000 * 500 + 4000 * 2000);
  });

  it("stops within budget: cumulative worst case never exceeds the cap", async () => {
    const budget = 20_000_000;
    const r = await runCell(cell({ phase: "B", arm: "trunk", observations: PHASE_B_OBSERVATIONS, budgetMicrocents: budget }), new FakeFounderModel());
    expect(r.stopped).toBe("budget");
    // The invariant checked before every call: spend so far + that call's worst case ≤ budget.
    let before = 0;
    for (const c of r.calls.filter((x) => x.ok)) {
      expect(before + c.boundMicrocents).toBeLessThanOrEqual(budget);
      before += c.costMicrocents;
    }
    expect(r.calls.filter((c) => c.ok).length).toBeGreaterThan(0);
    expect(r.spentMicrocents).toBeLessThanOrEqual(budget);
  });

  it("signed thinking never reaches the result, the snapshot or a packet", async () => {
    class Thinker extends FakeFounderModel {
      override async chat(req: ChatRequest): Promise<ChatResult> {
        const r = await super.chat(req);
        return { ...r, thinking: [{ type: "thinking", thinking: "PRIVATE-REASONING", signature: "SIGNATURE-SECRET" }], blockOrder: ["thinking:0", ...r.toolCalls.map((t) => `tool:${t.id}`), "text"] };
      }
    }
    const b = await runCell(cell({ cellId: "B-trunk", phase: "B", arm: "trunk", observations: PHASE_B_OBSERVATIONS }), new Thinker());
    const j = JSON.stringify(b);
    expect(j).not.toContain("SIGNATURE-SECRET");
    expect(j).not.toContain("PRIVATE-REASONING");
    expect(b.calls.every((c) => c.thinkingBlocks === 1)).toBe(true);
    const B = await runCell(cell({ arm: "B", state: b.snapshot }), new Thinker());
    expect(JSON.stringify(B.packet)).not.toContain("SIGNATURE");
    expect(JSON.stringify(B)).not.toContain("SIGNATURE-SECRET");
  });

  it("the real Anthropic adapter accepts every arm's conversations (fake Messages API with signed thinking, no violations)", async () => {
    const fake = await startFakeAnthropic({ apiKey: "k", model: "m", thinking: true, fault: () => null });
    try {
      const p = new AnthropicProvider({ baseUrl: fake.url, apiKey: "k", model: "m", attemptTimeoutMs: 5000, maxAttempts: 1, backoffMs: 10, thinking: { type: "adaptive" }, effort: "high" });
      const s = await trunkState();
      for (const arm of ["trunk", "A", "B", "R", "C"] as const) {
        const r = await runCell(cell({ cellId: `P-${arm}`, arm, state: s, observations: arm === "trunk" ? PHASE_B_OBSERVATIONS : [PROBE_D] }), p as CognitionProvider);
        expect(r.calls.filter((c) => !c.ok).map((c) => `${arm} ${c.code} ${c.detail}`)).toEqual([]);
        expect(JSON.stringify(r)).not.toMatch(/"signature"/);
      }
      expect(fake.violations).toEqual([]);
    } finally {
      await fake.close();
    }
  }, 60_000);
});

describe("F1-EVAL-02 driver (durable checkpoints, resume, conservative accounting)", () => {
  it("counts an interrupted cell's started-but-unfinished call at its worst case", () => {
    const lines = [
      JSON.stringify({ event: "call_start", turn: 1, step: 0, boundMicrocents: 100 }),
      JSON.stringify({ event: "call_end", turn: 1, step: 0, costMicrocents: 40 }),
      JSON.stringify({ event: "call_start", turn: 1, step: 1, boundMicrocents: 90 }),
    ];
    expect(interruptedSpend(lines)).toBe(130);
  });

  it("checkpoints each cell, never reruns a completed cell, and passes the remaining cap to the next", async () => {
    const out = tmp();
    fs.writeFileSync(path.join(out, "config.json"), JSON.stringify({ transport: "fake", model: "fake", effort: "high", maxTokens: 4000, prices: PRICES, capMicrocents: 300_000_000 }));
    const r1 = await runPlan(out, { only: "B-trunk", log: () => undefined });
    expect(r1.ran).toEqual(["B-trunk"]);
    expect(fs.existsSync(path.join(out, "cells", "B-trunk.json"))).toBe(true);
    expect(fs.existsSync(path.join(out, "state", "B-trunk.json"))).toBe(true);
    // An interrupted C-trunk attempt: its events exist without a result.
    fs.writeFileSync(path.join(out, "events", "C-trunk.jsonl"), `${JSON.stringify({ event: "call_start", turn: 1, step: 0, boundMicrocents: 7_000_000 })}\n`);
    const seen: number[] = [];
    const r2 = await runPlan(out, {
      mandatoryOnly: true, log: () => undefined,
      transport: async (payload, onEvent) => {
        const req = payload.request as CellRequest;
        seen.push(req.budgetMicrocents);
        const result = await runCell(req, new FakeFounderModel(), { log: (e) => onEvent(JSON.stringify(e)) });
        return { mode: "cell", model: "fake", effort: "high", result };
      },
    });
    expect(r2.ran).not.toContain("B-trunk");
    expect(r2.ran[0]).toBe("C-trunk");
    expect(r2.ran).toEqual(PLAN.filter((p) => p.mandatory && p.cellId !== "B-trunk").map((p) => p.cellId));
    const ledger = JSON.parse(fs.readFileSync(path.join(out, "ledger.json"), "utf8"));
    expect(ledger.interrupted[0]).toMatchObject({ cellId: "C-trunk", countedMicrocents: 7_000_000 });
    expect(seen[0]).toBe(300_000_000 - ledger.cells["B-trunk"].spentMicrocents - 7_000_000);
    expect(ledger.totalMicrocents).toBeLessThanOrEqual(300_000_000);
  }, 60_000);

  it("refuses a cap above the authorised ceiling", async () => {
    const out = tmp();
    fs.writeFileSync(path.join(out, "config.json"), JSON.stringify({ transport: "fake", model: "fake", effort: "high", maxTokens: 4000, prices: PRICES, capMicrocents: 300_000_001 }));
    await expect(runPlan(out, { log: () => undefined })).rejects.toThrow(/authorised/);
  });
});

describe("F1-EVAL-02 remote entry point (as a process; the credential never leaves it)", () => {
  it("runs a cell against the Messages API with the key from its file, and no output line contains the key or a signature", async () => {
    const dir = tmp();
    const KEY = "sk-ant-FAKEKEY-leakcanary-0123456789abcdef";
    const keyFile = path.join(dir, "cognition.key");
    fs.writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
    const fake = await startFakeAnthropic({ apiKey: KEY, model: "claude-opus-5-5", thinking: true, fault: () => null });
    try {
      const req = { mode: "cell", model: "claude-opus-5-5", effort: "high", request: cell({ cellId: "leak", maxSteps: 3, budgetMicrocents: 50_000_000, observations: ["Heartbeat. Finish with a text reply headed DECISION."] }) };
      const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", FLEET_COGNITION_PROVIDER: "anthropic", FLEET_COGNITION_MODEL: "claude-opus-5-5", FLEET_COGNITION_API_KEY_FILE: keyFile, FLEET_COGNITION_BASE_URL: fake.url, FLEET_COGNITION_THINKING: "adaptive", FLEET_COGNITION_EFFORT: "medium" };
      const { code, out, err } = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        const p = spawn(process.execPath, ["--import", "tsx", path.resolve("src/fleet/eval/f1-eval-02-main.ts")], { env, stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        let err = "";
        p.stdout.on("data", (d) => (out += d));
        p.stderr.on("data", (d) => (err += d));
        p.on("close", (code) => resolve({ code, out, err }));
        p.stdin.end(JSON.stringify(req));
      });
      expect(code).toBe(0);
      expect(out + err).not.toContain(KEY);
      expect(out).not.toMatch(/"signature"/);
      const res = JSON.parse(out.split("\n").find((l) => l.startsWith("RESULT "))!.slice(7));
      expect(res).toMatchObject({ model: "claude-opus-5-5", effort: "high", thinking: "adaptive", maxAttempts: 1 });
      expect(res.result.calls.length).toBeGreaterThan(0);
      expect(res.result.calls.every((c: { ok: boolean }) => c.ok)).toBe(true);
      expect(fake.violations).toEqual([]);
      // An unknown model or an over-ceiling budget is refused before anything is sent.
      for (const bad of [{ ...req, model: "claude-unknown" }, { ...req, request: { ...req.request, budgetMicrocents: 300_000_001 } }]) {
        const c = await new Promise<number | null>((resolve) => {
          const p = spawn(process.execPath, ["--import", "tsx", path.resolve("src/fleet/eval/f1-eval-02-main.ts")], { env, stdio: ["pipe", "ignore", "ignore"] });
          p.on("close", resolve);
          p.stdin.end(JSON.stringify(bad));
        });
        expect(c).toBe(2);
      }
    } finally {
      await fake.close();
    }
  }, 60_000);
});
