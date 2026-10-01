/**
 * F1-FRESH-02 memory observability: founder_memory_write telemetry (counts and codes only) and the read-only
 * memory-report aggregation / fact-store health. Fact keys, values, reasons and sources are private founder memory:
 * every test plants canaries in them and proves none reaches telemetry, the log line or the report.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { FACTS_FILE, FACT_LEDGER_FILE } from "../../fleet/founder/facts.js";
import { FounderToolbox, type MemoryTelemetry } from "../../fleet/founder/toolbox.js";
import { FounderMind } from "../../fleet/founder/mind.js";
import { aggregateMemoryEvents, factStoreHealth } from "../../fleet/founder/memory-report.js";
import { createRedactedLineLogger } from "../../fleet/redact.js";
import { buildTaskPacket, renderTaskPacket } from "../../fleet/cognition/task-packet.js";
import { FOUNDER_MANIFEST_V2 } from "../../fleet/capabilities.js";
import { MAX_TOOL_CALLS_EXECUTED, type ToolCall } from "../../fleet/cognition/types.js";

const CANARY = {
  key: "canary_key_7f3a",
  value: "CANARY-VALUE-quota 20 listings/month £12.00 secret-ish",
  reason: "CANARY-REASON-forum post was wrong",
  source: "https://canary.example/CANARY-SOURCE",
  secret: "sk-ant-api03-CANARYsecretCANARYsecretCANARYsecret0123456789abcdef",
  pem: "-----BEGIN PRIVATE KEY-----MIIEvCANARY",
};
const FIELDS = ["tool", "ok", "code", "batch", "factsBefore", "factsAfter", "written", "superseded", "supersedesUsed", "retracted", "notCarried"].sort();

function founder(o: { telemetry?: boolean; legacy?: Record<string, string> } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fresh02obs-"));
  const mem = path.join(root, "memory");
  const ws = path.join(root, "workspace");
  fs.mkdirSync(mem);
  fs.mkdirSync(ws);
  if (o.legacy) fs.writeFileSync(path.join(mem, FACTS_FILE), JSON.stringify(o.legacy));
  const records: MemoryTelemetry[] = [];
  const lines: string[] = [];
  const log = createRedactedLineLogger("fleet-founder", (l) => lines.push(l));
  const toolbox = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: ws, memoryDir: mem, ports: {
    ledger: async () => ({}), spendOrder: async () => ({}), proposeKnowledge: async () => ({}), knowledge: async () => [], requestIdentityFact: async () => ({}),
  } as never, ...(o.telemetry === false ? {} : { memoryTelemetry: (m: MemoryTelemetry) => { records.push(m); log("founder_memory_write", { ...m, runtimeCommit: "64be9ce4d56b718c07ab0cba20ebcf70e975837d", buildId: "fe22333a" }); } }) });
  let n = 0;
  const tool = (name: string, args: Record<string, unknown>) => toolbox.execute({ id: `t${++n}`, name, arguments: args });
  return { root, mem, ws, toolbox, tool, records, lines };
}
const noLeak = (text: string) => {
  for (const c of Object.values(CANARY)) expect(text).not.toContain(c);
  for (const frag of ["CANARY", "canary_key", "sk-ant-", "PRIVATE KEY", "quota 20", "£12.00"]) expect(text).not.toContain(frag);
};

describe("F1-FRESH-02 founder_memory_write telemetry (metadata only)", () => {
  it("remember_facts and remember_fact emit one record each with exactly the count fields", async () => {
    const d = founder();
    await d.tool("remember_facts", { facts: [
      { key: CANARY.key, value: CANARY.value, source: CANARY.source },
      { key: "fee", value: "fee 6.5%" },
      { key: "secretish", value: `${CANARY.secret} ${CANARY.pem}` },
    ] });
    await d.tool("remember_fact", { key: "lead", value: "lead 5 business days" });
    expect(d.records).toEqual([
      { tool: "remember_facts", ok: true, code: null, batch: 3, factsBefore: 0, factsAfter: 3, written: 3, superseded: 0, supersedesUsed: 0, retracted: 0, notCarried: 0 },
      { tool: "remember_fact", ok: true, code: null, batch: null, factsBefore: 3, factsAfter: 4, written: 1, superseded: 0, supersedesUsed: 0, retracted: 0, notCarried: 0 },
    ]);
    for (const r of d.records) expect(Object.keys(r).sort()).toEqual(FIELDS);
  });

  it("supersession, NOT CARRIED FORWARD and retraction are counted", async () => {
    const d = founder();
    await d.tool("remember_facts", { facts: [{ key: "summary", value: "fee 6.5%; quota 20/mo; lead 5 days" }, { key: "fee", value: "fee 6.5%" }, { key: "old", value: "old status" }] });
    // same-key update (fee) + `supersedes` retiring two other keys, dropping "quota 20/mo" and "lead 5 days"
    const r = await d.tool("remember_facts", { facts: [{ key: "fee", value: "fee 9%" }, { key: "plan", value: "plan only", supersedes: ["summary", "old"] }] });
    expect(String(r.output)).toContain("NOT CARRIED FORWARD");
    await d.tool("retract_fact", { key: "plan", reason: CANARY.reason });
    expect(d.records.slice(1)).toEqual([
      { tool: "remember_facts", ok: true, code: null, batch: 2, factsBefore: 3, factsAfter: 2, written: 2, superseded: 3, supersedesUsed: 1, retracted: 0, notCarried: 3 },
      { tool: "retract_fact", ok: true, code: null, batch: null, factsBefore: 2, factsAfter: 1, written: 0, superseded: 0, supersedesUsed: 0, retracted: 1, notCarried: 0 },
    ]);
  });

  it("refusals and errors are recorded by code only: bad request, not found, malformed store, failed recall, the per-step limit", async () => {
    const d = founder({ legacy: { a: "alpha" } });
    await d.tool("remember_fact", { key: CANARY.key }); // no value
    await d.tool("remember_facts", { facts: [{ key: CANARY.key, value: CANARY.value }, { key: CANARY.key, value: "dup" }] });
    await d.tool("retract_fact", { key: CANARY.key, reason: CANARY.reason });
    await d.tool("remember_fact", { key: "b", value: "x", supersedes: [CANARY.key] });
    fs.writeFileSync(path.join(d.mem, FACT_LEDGER_FILE), `{broken ${CANARY.value}`);
    await d.tool("remember_facts", { facts: [{ key: "c", value: CANARY.value }] });
    await d.tool("recall_facts", { query: CANARY.key });
    expect(d.records.map((r) => [r.tool, r.ok, r.code, r.batch, r.factsBefore])).toEqual([
      ["remember_fact", false, "FLEET_BAD_REQUEST", null, null],
      ["remember_facts", false, "FLEET_BAD_REQUEST", 2, null],
      ["retract_fact", false, "FLEET_NOT_FOUND", null, 1],
      ["remember_fact", false, "FLEET_NOT_FOUND", null, 1],
      ["remember_facts", false, "FLEET_FACTS_MALFORMED", 1, null],
      ["recall_facts", false, "FLEET_FACTS_MALFORMED", null, null],
    ]);
    // A successful recall is a read, not a write: not recorded.
    const e = founder();
    await e.tool("recall_facts", {});
    expect(e.records).toEqual([]);
    // The mind's per-step limit: memory calls beyond it are recorded as FLEET_TOOL_CALL_LIMIT (other tools are not).
    const f = founder();
    let i = 0;
    const mind = new FounderMind({ toolbox: f.toolbox, stateDir: fs.mkdtempSync(path.join(f.root, "st-")), maxStepsPerTurn: 2, ports: {
      cognitionStatus: async () => ({ policyEnabled: true, provider: "scripted", founderEnabled: true, paused: false }),
      infer: async () => ({ content: "", toolCalls: i++ === 0 ? Array.from({ length: 7 }, (_, n): ToolCall => ({ id: `c${n}`, name: n === 6 ? "list_goals" : "remember_fact", arguments: { key: `k${n}`, value: CANARY.value } })) : [], usage: { inputTokens: 1, outputTokens: 1 }, chargedCents: 0, requestId: `r${i}` }),
    } });
    await mind.turn("news");
    expect(f.records.filter((r) => r.ok)).toHaveLength(MAX_TOOL_CALLS_EXECUTED);
    expect(f.records.filter((r) => !r.ok).map((r) => r.code)).toEqual(["FLEET_TOOL_CALL_LIMIT"]); // k5 (remember_fact); list_goals is not memory
    noLeak(JSON.stringify([d.records, f.records]));
  });

  it("no fact key, value, reason, source or secret-shaped text reaches a record or the logged line", async () => {
    const d = founder();
    await d.tool("remember_facts", { facts: [{ key: CANARY.key, value: `${CANARY.value} ${CANARY.secret}`, source: CANARY.source }, { key: "pem", value: CANARY.pem }] });
    await d.tool("remember_fact", { key: CANARY.key, value: "replaced", supersedes: ["pem"] });
    await d.tool("retract_fact", { key: CANARY.key, reason: CANARY.reason });
    await d.tool("remember_fact", { key: CANARY.key }); // refused
    expect(d.lines).toHaveLength(4);
    noLeak(JSON.stringify(d.records));
    noLeak(d.lines.join("\n"));
    for (const l of d.lines) {
      const j = JSON.parse(l);
      expect(j).toMatchObject({ service: "fleet-founder", event: "founder_memory_write", runtimeCommit: "64be9ce4d56b718c07ab0cba20ebcf70e975837d" });
      for (const [k, v] of Object.entries(j)) if (!["ts", "service", "event", "tool", "code", "runtimeCommit", "buildId"].includes(k)) expect(v === null || typeof v === "number" || typeof v === "boolean", k).toBe(true);
    }
  });

  it("legacy memory works with telemetry on, and telemetry changes no tool output, file or task packet", async () => {
    const legacy = { old_status: "goal g1 open", "decision:1": JSON.stringify({ answer: "x" }) };
    const on = founder({ legacy });
    const off = founder({ legacy, telemetry: false });
    const script: Array<[string, Record<string, unknown>]> = [
      ["remember_facts", { facts: [{ key: "fee", value: "fee 6.5%" }, { key: "quota", value: "quota 20/mo" }] }],
      ["remember_fact", { key: "fee", value: "fee 9%" }],
      ["remember_fact", { key: "summary", value: "plan", supersedes: ["old_status"] }],
      ["retract_fact", { key: "quota", reason: "wrong" }],
      ["remember_fact", { key: "x" }],
      ["recall_facts", {}],
    ];
    for (const [name, args] of script) {
      const a = await on.tool(name, args);
      const b = await off.tool(name, args);
      const strip = (o: unknown) => String((o as { output: string }).output).replace(/"observedAt":"[^"]+"|"endedAt":"[^"]+"/g, "");
      expect({ ...a, output: strip(a) }).toEqual({ ...b, output: strip(b) });
    }
    expect(on.records).toHaveLength(5);
    expect(off.records).toEqual([]);
    expect(fs.readFileSync(path.join(on.mem, FACTS_FILE), "utf8")).toBe(fs.readFileSync(path.join(off.mem, FACTS_FILE), "utf8"));
    expect(JSON.parse(fs.readFileSync(path.join(on.mem, FACTS_FILE), "utf8"))).toMatchObject({ "decision:1": legacy["decision:1"] });
    const packet = (d: ReturnType<typeof founder>) => renderTaskPacket(buildTaskPacket({ memoryDir: d.mem, workspaceDir: d.ws, task: "t", outputContract: { form: "decision", mustCite: false, instructions: "x" } }))
      .replace(/"observedAt":"[^"]+"/g, "");
    expect(packet(on)).toBe(packet(off));
    expect(fs.readdirSync(on.mem).sort()).toEqual(fs.readdirSync(off.mem).sort()); // no telemetry file in founder memory
  });
});

describe("F1-FRESH-02 memory-report (read-only; counts and status only)", () => {
  it("aggregates the logged lines: batch vs individual writes, warnings, refusals by code, malformed, runtimes", async () => {
    const d = founder();
    await d.tool("remember_facts", { facts: [{ key: "summary", value: "fee 6.5%; quota 20/mo" }, { key: "lead", value: "lead 5 days" }] });
    await d.tool("remember_fact", { key: "s2", value: "fee 9%", supersedes: ["summary"] });
    await d.tool("remember_fact", { key: CANARY.key });
    fs.writeFileSync(path.join(d.mem, FACTS_FILE), "{not json");
    await d.tool("remember_facts", { facts: [{ key: "z", value: "1" }] });
    const s = aggregateMemoryEvents(["noise", "{\"event\":\"founder_turn\"}", ...d.lines, "founder_memory_write {broken"]);
    expect(s).toMatchObject({
      events: 4, rememberFactsEverUsed: true, batchWrites: 1, batchFactsWritten: 2, individualWrites: 1, retractions: 0,
      superseded: 1, supersedesUsed: 1, notCarriedWarnings: 1, notCarriedValues: 2, refused: 2,
      refusedByCode: { FLEET_BAD_REQUEST: 1, FLEET_FACTS_MALFORMED: 1 }, malformed: 1, runtimes: ["64be9ce4d56b718c07ab0cba20ebcf70e975837d"],
      byTool: { remember_fact: { ok: 1, refused: 1 }, remember_facts: { ok: 1, refused: 1 }, retract_fact: { ok: 0, refused: 0 }, recall_facts: { ok: 0, refused: 0 } },
    });
    expect(aggregateMemoryEvents([])).toMatchObject({ events: 0, rememberFactsEverUsed: false, firstAt: null });
    noLeak(JSON.stringify(s));
  });

  it("fact-store health: counts, legacy facts, history, inferred batch writes — and never a key or value", async () => {
    const d = founder({ legacy: { [CANARY.key]: CANARY.value } });
    expect(factStoreHealth(d.mem)).toEqual({ memoryDir: "present", factsFile: "present", ledgerFile: "absent", parse: "ok", currentFacts: 1, legacyFacts: 1,
      history: { superseded: 0, retracted: 0, trimmed: 0 }, multiFactWrites: 0 });
    await d.tool("remember_facts", { facts: [{ key: "a", value: CANARY.secret }, { key: "b", value: "2" }] });
    await d.tool("remember_fact", { key: "a", value: "3" });
    await d.tool("retract_fact", { key: CANARY.key, reason: CANARY.reason });
    const h = factStoreHealth(d.mem);
    expect(h).toEqual({ memoryDir: "present", factsFile: "present", ledgerFile: "present", parse: "ok", currentFacts: 2, legacyFacts: 0,
      history: { superseded: 1, retracted: 1, trimmed: 0 }, multiFactWrites: 1 });
    noLeak(JSON.stringify(h));
    // Malformed: reported as such, without the store's message (which names the key).
    fs.writeFileSync(path.join(d.mem, FACTS_FILE), JSON.stringify({ [CANARY.key]: { v: CANARY.value } }));
    const m = factStoreHealth(d.mem);
    expect(m).toMatchObject({ parse: "malformed", currentFacts: null });
    noLeak(JSON.stringify(m));
    expect(factStoreHealth(path.join(d.root, "nope"))).toMatchObject({ memoryDir: "absent", parse: "skipped" });
  });

  it("never follows a symlink planted in founder memory (a root reader cannot be redirected), and never writes the live store", () => {
    const d = founder();
    const outside = path.join(d.root, "outside.json");
    fs.writeFileSync(outside, JSON.stringify({ [CANARY.key]: CANARY.value }));
    fs.symlinkSync(outside, path.join(d.mem, FACTS_FILE));
    const before = fs.readdirSync(d.mem).map((f) => [f, fs.lstatSync(path.join(d.mem, f)).mtimeMs]);
    const h = factStoreHealth(d.mem);
    expect(h).toMatchObject({ factsFile: "not-a-regular-file", parse: "skipped", currentFacts: null });
    noLeak(JSON.stringify(h));
    expect(fs.readdirSync(d.mem).map((f) => [f, fs.lstatSync(path.join(d.mem, f)).mtimeMs])).toEqual(before);
    const linkedDir = path.join(d.root, "linked-memory");
    fs.symlinkSync(d.mem, linkedDir);
    expect(factStoreHealth(linkedDir)).toMatchObject({ memoryDir: "not-a-directory" });
  });
});
