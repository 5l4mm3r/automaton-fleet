/**
 * F1-FRESH-02 — founder memory retention (local; no model calls).
 *
 * F1-FRESH-EVAL-02 (sealed, INCONCLUSIVE) failed its retention guard: the listing quota was missing from memory.
 * The sealed evidence shows why (src/fleet/eval/f1-fresh-eval-02-retention.ts): every turn the founder rewrote ONE
 * summary fact and superseded the previous one; the rewrite restated the turn's news but silently dropped facts the
 * news did not mention. Facts that later news restated came back; the never-changing quota did not.
 *
 * The fix keeps independent operational facts individually addressable and makes a lossy rewrite visible:
 *   remember_facts      several facts in one atomic call (no per-step tool-call ceiling on fact capture)
 *   NOT CARRIED FORWARD rememberFact / rememberFacts report values a replaced fact stated that no current fact states
 * These tests reproduce the behaviour with deterministic writers and measure memory coverage.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { FACTS_FILE, FACT_LEDGER_FILE, FACT_BATCH_LIMIT, loadFacts, notCarriedForward, rememberFact, rememberFacts, retractFact, statedValues } from "../../fleet/founder/facts.js";
import { buildTaskPacket, renderTaskPacket, taskPacketProblems } from "../../fleet/cognition/task-packet.js";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { FounderMind } from "../../fleet/founder/mind.js";
import { FOUNDER_MANIFEST_V2, decideTool, manifestSha256 } from "../../fleet/capabilities.js";
import { FOUNDER_TOOLS, MAX_TOOL_CALLS_EXECUTED, type ToolCall } from "../../fleet/cognition/types.js";
import { toolsFor } from "../../fleet/cognition/gateway.js";
import { analyseSealedRun, DOMAINS } from "../../fleet/eval/f1-fresh-eval-02-retention.js";

const SEALED = "docs/evaluations/f1-fresh-eval-02/real";
const clock = (start = "2026-10-01T08:00:00.000Z") => { let t = Date.parse(start); return () => new Date((t += 60_000)); };

function founder(legacyFacts?: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fresh02-"));
  const mem = path.join(root, "memory");
  const ws = path.join(root, "workspace");
  fs.mkdirSync(mem);
  fs.mkdirSync(ws);
  if (legacyFacts) fs.writeFileSync(path.join(mem, FACTS_FILE), JSON.stringify(legacyFacts, null, 2));
  const toolbox = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: ws, memoryDir: mem, ports: {
    ledger: async () => ({}), spendOrder: async () => ({}), proposeKnowledge: async () => ({}), knowledge: async () => [], requestIdentityFact: async () => ({}),
  } as never });
  let n = 0;
  const tool = (name: string, args: Record<string, unknown>) => toolbox.execute({ id: `toolu_${++n}`, name, arguments: args });
  const raw = (f: string) => fs.readFileSync(path.join(mem, f), "utf8");
  const current = () => loadFacts(mem).current.map((f) => f.value).join("\n");
  return { root, mem, ws, toolbox, tool, raw, current };
}

/** The operational facts of the F1-FRESH-EVAL-02 world (turn-1 news), with phrasing-tolerant detectors. */
const WORLD = [
  { key: "o7_price", value: "O7 template listed at £12.00 on Stallhub", re: /£12\.00/ },
  { key: "stallhub_fee", value: "Stallhub transaction fee 6.5% of each sale", re: /6\.5%/ },
  { key: "printco_unit_cost", value: "PrintCo printed unit cost £2.00 at list price", re: /£2\.00/ },
  { key: "printco_paper", value: "PrintCo paper: in stock", re: /in stock/ },
  { key: "printco_lead_time", value: "PrintCo standard lead time 5 business days", re: /5 business days/ },
  { key: "stallhub_refund_window", value: "Stallhub refund window 14 days", re: /14 days/ },
  { key: "stallhub_listing_quota", value: "Stallhub listing quota 20 listings per month", re: /20 listings/ },
  { key: "ads_cpc", value: "Ad cost per click averaged £0.35", re: /£0\.35/ },
] as const;
const coverage = (text: string, facts: ReadonlyArray<{ re: RegExp }>) => facts.filter((f) => f.re.test(text)).length;

describe("F1-FRESH-EVAL-02 root cause, from the sealed evidence (read-only replay through the production stores)", () => {
  const rows = analyseSealedRun(SEALED);
  const by = Object.fromEntries(rows.map((r) => [r.cellId, r]));

  it("the replay reproduces every sealed facts.json; no tool-call limit was involved (≤ 2 calls per step, 0 refusals)", () => {
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(r.replayMatchesSealed, r.cellId).toBe(true);
      expect(r.limitRefusals).toBe(0);
      expect(r.maxCallsInOneStep).toBeLessThanOrEqual(2);
      // Fact selection: exactly one summary fact written per turn (LEGACY-2 rewrote its turn-3 summary once more).
      expect(r.turns.map((t) => t.memoryCalls)).toEqual(r.cellId === "C-LEGACY-2" ? [1, 1, 2] : [1, 1, 1]);
      expect(r.turns.every((t) => t.keys.length === 1 || r.arm === "LEGACY")).toBe(true);
    }
  });

  it("capture was complete at every fact count (8, 1, 4 per turn); the loss is the turn-2 rewrite dropping unmentioned facts", () => {
    for (const r of rows) {
      expect(r.turns.map((t) => [t.captured.length, t.turn])).toEqual([[8, 1], [1, 2], [4, 3]]);
    }
    const carried2 = rows.reduce((n, r) => n + r.turns[1].carried.length, 0);
    const unmentioned2 = rows.reduce((n, r) => n + r.turns[1].carried.length + r.turns[1].dropped.length, 0);
    expect([carried2, unmentioned2]).toEqual([19, 42]); // 45% carried forward through the turn-2 rewrite
    const carried3 = rows.reduce((n, r) => n + r.turns[2].carried.length, 0);
    const unmentioned3 = rows.reduce((n, r) => n + r.turns[2].carried.length + r.turns[2].dropped.length, 0);
    expect([carried3, unmentioned3]).toEqual([18, 19]);
  });

  it("the quota was stored at turn 1 in every cell, dropped by the turn-2 rewrite in 5 of 6, and never restated", () => {
    for (const r of rows) expect(r.turns[0].present).toContain("quota");
    expect(rows.filter((r) => r.turns[1].dropped.includes("quota")).map((r) => r.cellId)).toEqual(["C-FRESH-1", "C-FRESH-3", "C-LEGACY-1", "C-LEGACY-2", "C-LEGACY-3"]);
    expect(rows.filter((r) => r.turns[2].present.includes("quota")).map((r) => r.cellId)).toEqual(["C-FRESH-2"]);
    // Facts that changed later came back with the news; the never-changing quota is the one that stayed lost.
    expect(rows.every((r) => ["stock", "lead", "refund"].every((d) => r.turns[2].present.includes(d as never)))).toBe(true);
  });

  it("detector quality: q5 was present in C-FRESH-2/3 (\"30d\") and the quota in C-FRESH-2 (\"20/mo\"); C-FRESH-1 really lacked a stated unit cost", () => {
    expect(by["C-FRESH-2"].turns[2].present).toEqual(expect.arrayContaining(["refund", "quota"]));
    expect(by["C-FRESH-3"].turns[2].present).toContain("refund");
    expect(by["C-FRESH-1"].turns[2].present).not.toContain("cost"); // only derivable (£10.92 − £8.92), which the founder did
    expect(DOMAINS).toHaveLength(8);
  });

  it("with the fix, the same sealed turn-2 rewrites would have reported the dropped quota — exactly in the 5 cells that lost it", () => {
    for (const r of rows) {
      const cell = JSON.parse(fs.readFileSync(path.join(SEALED, "cells", `${r.cellId}.json`), "utf8"));
      const d = founder();
      const results: Record<number, string[]> = {};
      for (const t of [1, 2]) {
        for (const c of cell.calls.filter((x: { phase: string }) => x.phase === `trunk-${t}`)) {
          for (const w of c.toolCalls ?? []) {
            if (w.name !== "remember_fact") continue;
            const res = rememberFact(d.mem, { key: w.arguments.key, value: w.arguments.value, ...(w.arguments.supersedes ? { supersedes: w.arguments.supersedes } : {}) });
            expect(res.ok).toBe(true);
            if (res.ok) results[t] = res.notCarried ?? [];
          }
        }
      }
      expect(results[1]).toEqual([]);
      const warnsQuota = results[2].some((c) => /quota/i.test(c));
      expect(warnsQuota, r.cellId).toBe(r.turns[1].dropped.includes("quota"));
      // The lead time was dropped in every cell and every report names it.
      expect(results[2].some((c) => /lead|biz day|business day/i.test(c)), r.cellId).toBe(true);
    }
  });
});

describe("F1-FRESH-02 stated values and the carry-forward report (deterministic)", () => {
  it("numbers, amounts, percentages and dates are values; ids, list markers, URLs and attemptIds are not", () => {
    const v = statedValues("Price £12.00; fee 6.5% (£0.78). Out of stock until 2026-10-20. Goal g1, O7, step (2). Quota 20/mo. See https://x.example/a/99 and aaaaaaaa-0000-4000-8000-000000000001.");
    expect([...v.keys()]).toEqual(["12", "6.5", "0.78", "2026-10-20", "20"]);
    expect(v.get("20")).toBe("Quota 20/mo");
    expect(v.get("2026-10-20")).toBe("Out of stock until 2026-10-20");
    expect(statedValues("12.00 and 12").size).toBe(1);
  });

  it("a value still stated by any current fact is carried; only values no current fact states are reported; output is bounded", () => {
    expect(notCarriedForward(["fee 6.5%; quota 20/mo"], ["fee 9%", "quota: 20 listings"])).toEqual(["fee 6.5%"]);
    expect(notCarriedForward(["a 1; b 2; c 3; d 4; e 5; f 6; g 7; h 8; i 9; j 10"], [])).toHaveLength(9);
    expect(notCarriedForward(["no values here"], [])).toEqual([]);
  });
});

describe("F1-FRESH-02 memory coverage: 1, 5 and 8 facts per turn (deterministic writers)", () => {
  /** Turn 1 stores the first n facts; turn 2 is a fee correction written the way the founder wrote it. */
  async function scenario(n: number, style: "summary" | "atomic") {
    const d = founder();
    const facts = WORLD.slice(0, n);
    if (style === "summary") {
      await d.tool("remember_fact", { key: "O7_summary", value: facts.map((f) => f.value).join("; ") });
      const t2 = await d.tool("remember_fact", { key: "O7_summary_v2", value: "Stallhub fee now 9% (correction). Plan: digital first.", supersedes: ["O7_summary"] });
      return { d, facts, t2 };
    }
    const t1 = await d.tool("remember_facts", { facts: facts.map((f) => ({ key: f.key, value: f.value })) });
    expect(t1).toMatchObject({ ok: true, output: expect.stringMatching(new RegExp(`^${n} facts written`)) });
    await d.tool("remember_fact", { key: "O7_summary", value: `O7 plan: digital first; ${n} operational facts kept separately.` });
    const t2 = await d.tool("remember_facts", { facts: [
      { key: "stallhub_fee", value: "Stallhub transaction fee 9% of each sale (correction)" },
      { key: "O7_summary", value: "O7 plan v2: digital first; fee now 9%." },
    ] });
    return { d, facts, t2 };
  }

  for (const n of [1, 5, 8]) {
    it(`${n} fact(s): a lossy summary rewrite drops what it does not restate, and says so; atomic facts keep every unrelated fact`, async () => {
      const s = await scenario(n, "summary");
      const unrelated = s.facts.filter((f) => f.key !== "stallhub_fee");
      expect(coverage(s.d.current(), unrelated)).toBe(0); // the F1-FRESH-EVAL-02 failure
      if (unrelated.some((f) => /\d/.test(f.value))) expect(String(s.t2.output)).toContain("NOT CARRIED FORWARD");
      const a = await scenario(n, "atomic");
      expect(coverage(a.d.current(), unrelated)).toBe(unrelated.length); // 100% retained
      expect(a.d.current()).toMatch(n >= 2 ? /fee 9%/ : /./);
      // The correction is acknowledged as the only value no longer current (the summary rewrite drops nothing else).
      const carried = String(a.t2.output);
      if (n >= 2) expect(carried).toMatch(/NOT CARRIED FORWARD[^]*6\.5%/);
      for (const f of unrelated) expect(carried).not.toContain(f.value);
    });
  }

  it("mixed numeric / text / status facts, a later correction, a retraction: unrelated facts stay intact and individually current", async () => {
    const d = founder();
    await d.tool("remember_facts", { facts: WORLD.map((f) => ({ key: f.key, value: f.value, source: "news:2026-09-20" })) });
    // Correction of one fact (explicit, same key) and a status change, in one atomic write.
    const r = await d.tool("remember_facts", { facts: [
      { key: "stallhub_fee", value: "Stallhub transaction fee 9% of each sale", source: "stallhub email 2026-09-24" },
      { key: "printco_paper", value: "PrintCo paper: out of stock until 2026-10-20" },
      { key: "printco_bulk_claim", value: "Forum claim: PrintCo 30% bulk discount (£1.40 per unit), unverified" },
    ] });
    expect(r).toMatchObject({ ok: true });
    expect(await d.tool("retract_fact", { key: "printco_bulk_claim", reason: "PrintCo confirmed there is no bulk discount" })).toMatchObject({ ok: true });
    const cur = Object.fromEntries(loadFacts(d.mem).current.map((f) => [f.key, f.value]));
    expect(Object.keys(cur).sort()).toEqual(WORLD.map((f) => f.key).sort());
    expect(cur.stallhub_fee).toMatch(/9%/);
    expect(cur.printco_paper).toMatch(/out of stock/);
    for (const f of WORLD.filter((x) => !["stallhub_fee", "printco_paper"].includes(x.key))) expect(cur[f.key]).toBe(f.value);
    const h = loadFacts(d.mem).history.map((x) => [x.key, x.status]);
    expect(h).toEqual([["stallhub_fee", "superseded"], ["printco_paper", "superseded"], ["printco_bulk_claim", "retracted"]]);
  });

  it("summary creation never erases independent facts: superseding a summary retires only the summary", async () => {
    const d = founder();
    await d.tool("remember_facts", { facts: [...WORLD.map((f) => ({ key: f.key, value: f.value })), { key: "O7_summary", value: `O7 at £12.00, fee 6.5%, quota 20 listings; plan: digital first` }] });
    const r = await d.tool("remember_fact", { key: "O7_summary_2026-09-24", value: "O7 plan: digital first, no print stock.", supersedes: ["O7_summary"] });
    expect(r).toMatchObject({ ok: true });
    expect(String(r.output)).not.toContain("NOT CARRIED FORWARD"); // every value is still stated by an atomic fact
    expect(coverage(d.current(), WORLD)).toBe(WORLD.length);
  });
});

describe("F1-FRESH-02 remember_facts: atomicity, limits and the per-step tool-call ceiling", () => {
  it("validation failures write nothing: duplicate key, unknown supersedes, self-conflict, bad entry, too many facts", async () => {
    const d = founder({ legacy: "kept" });
    await d.tool("remember_facts", { facts: [{ key: "a", value: "1" }] });
    const before = [d.raw(FACTS_FILE), d.raw(FACT_LEDGER_FILE)];
    const bad: unknown[] = [
      [{ key: "b", value: "2" }, { key: "b", value: "3" }],
      [{ key: "b", value: "2" }, { key: "c", value: "3", supersedes: ["nope"] }],
      [{ key: "b", value: "2" }, { key: "c", value: "3", supersedes: ["b"] }],
      [{ key: "b", value: "2" }, { key: "c", value: 3 }],
      [{ key: "b", value: "2" }, { key: "", value: "3" }],
      [{ key: "b", value: "2", supersedes: "a" }],
      Array.from({ length: FACT_BATCH_LIMIT + 1 }, (_, i) => ({ key: `k${i}`, value: "v" })),
      [],
      "not a list",
    ];
    for (const facts of bad) {
      const r = await d.tool("remember_facts", { facts });
      expect(r.ok, JSON.stringify(facts).slice(0, 80)).toBe(false);
      expect([d.raw(FACTS_FILE), d.raw(FACT_LEDGER_FILE)]).toEqual(before);
    }
    expect(await d.tool("remember_facts", { facts: [{ key: "b", value: "2" }, { key: "c", value: "3", supersedes: ["a"] }] })).toMatchObject({ ok: true });
    expect(JSON.parse(d.raw(FACTS_FILE))).toEqual({ legacy: "kept", b: "2", c: "3" });
  });

  it("malformed memory fails closed for remember_facts exactly as for remember_fact", async () => {
    const d = founder({ a: "alpha" });
    fs.writeFileSync(path.join(d.mem, FACT_LEDGER_FILE), "{broken");
    const snap = fs.readdirSync(d.mem).map((f) => [f, d.raw(f)]);
    expect(await d.tool("remember_facts", { facts: [{ key: "b", value: "beta" }] })).toMatchObject({ ok: false, refused: "FLEET_FACTS_MALFORMED" });
    expect(fs.readdirSync(d.mem).map((f) => [f, d.raw(f)])).toEqual(snap);
  });

  /** A scripted founder turn through the production mind: the given responses in order, then "done". */
  async function mindTurn(d: ReturnType<typeof founder>, responses: ToolCall[][]) {
    let i = 0;
    const mind = new FounderMind({ toolbox: d.toolbox, stateDir: fs.mkdtempSync(path.join(d.root, "state-")), maxStepsPerTurn: 4, ports: {
      cognitionStatus: async () => ({ policyEnabled: true, provider: "scripted", founderEnabled: true, paused: false }),
      infer: async () => ({ content: i < responses.length ? "storing" : "done", toolCalls: responses[i++] ?? [], usage: { inputTokens: 1, outputTokens: 1 }, chargedCents: 0, requestId: `r${i}` }),
    } });
    return mind.turn("News: eight operational facts (see the packet).");
  }
  const call = (name: string, args: Record<string, unknown>, n: number): ToolCall => ({ id: `c${n}`, name, arguments: args });

  it("8 separate remember_fact calls in one step: 5 run and 3 are refused (FLEET_TOOL_CALL_LIMIT); one remember_facts stores all 8", async () => {
    const d = founder();
    const t = await mindTurn(d, [WORLD.map((f, n) => call("remember_fact", { key: f.key, value: f.value }, n))]);
    expect(t.refusals.filter((r) => r.code === "FLEET_TOOL_CALL_LIMIT")).toHaveLength(WORLD.length - MAX_TOOL_CALLS_EXECUTED);
    expect(coverage(d.current(), WORLD)).toBe(MAX_TOOL_CALLS_EXECUTED);
    const e = founder();
    const u = await mindTurn(e, [[call("remember_facts", { facts: WORLD.map((f) => ({ key: f.key, value: f.value })) }, 1)]]);
    expect(u.refusals).toEqual([]);
    expect(coverage(e.current(), WORLD)).toBe(WORLD.length);
  });

  it("interrupted storage is recoverable: the refused calls retried in the next step complete the memory", async () => {
    const d = founder();
    const calls = WORLD.map((f, n) => call("remember_fact", { key: f.key, value: f.value }, n));
    await mindTurn(d, [calls, calls.slice(MAX_TOOL_CALLS_EXECUTED).map((c) => ({ ...c, id: `${c.id}-retry` }))]);
    expect(coverage(d.current(), WORLD)).toBe(WORLD.length);
  });

  it("legacy memory: a legacy facts.json keeps every key and its string shape; metadata only for what the store wrote", async () => {
    const d = founder({ old_status: "goal g1 open", "decision:1": JSON.stringify({ answer: "x" }) });
    expect(await d.tool("remember_facts", { facts: WORLD.slice(0, 3).map((f) => ({ key: f.key, value: f.value })) })).toMatchObject({ ok: true });
    const onDisk = JSON.parse(d.raw(FACTS_FILE));
    expect(Object.values(onDisk).every((v) => typeof v === "string")).toBe(true);
    expect(onDisk).toMatchObject({ old_status: "goal g1 open" });
    expect(loadFacts(d.mem).current.filter((f) => f.observedAt === null).map((f) => f.key).sort()).toEqual(["decision:1", "old_status"]);
  });

  it("task packet after severance: every atomic fact is individually present, current-only and within the packet limits", async () => {
    const d = founder();
    await d.tool("remember_facts", { facts: WORLD.map((f) => ({ key: f.key, value: f.value })) });
    await d.tool("remember_facts", { facts: [{ key: "stallhub_fee", value: "Stallhub transaction fee 9% of each sale" }, { key: "O7_summary", value: "plan: digital first" }] });
    const p = buildTaskPacket({ memoryDir: d.mem, workspaceDir: d.ws, task: "PROBE: answer from memory.", outputContract: { form: "decision", mustCite: false, instructions: "answer" } });
    expect(taskPacketProblems(p)).toEqual([]);
    expect(p.knowledge.map((k) => k.key)).toEqual([...WORLD.map((f) => f.key), "O7_summary"].sort((a, b) => a.localeCompare(b)));
    const text = renderTaskPacket(p);
    expect(coverage(text, WORLD.filter((f) => f.key !== "stallhub_fee"))).toBe(WORLD.length - 1);
    expect(text).toContain("9% of each sale");
    expect(text).not.toContain("6.5%");
    expect(p.knowledge.every((k) => k.observedAt)).toBe(true);
  });

  it("the tool surface: remember_facts is private memory (no new authority, manifest digest unchanged) and advertised with the founder tools", () => {
    expect(decideTool("remember_facts", FOUNDER_MANIFEST_V2)).toMatchObject({ allowed: true, capability: "memory.private" });
    // The manifest (capability classes) is unchanged, so its digest is the one founders already carry.
    expect(manifestSha256(FOUNDER_MANIFEST_V2)).toBe("30a7060986930db3f611545c8c57fa5a98c9ad798bac279f66c39bdfe527a3d8");
    expect(FOUNDER_TOOLS.find((t) => t.name === "remember_facts")).toMatchObject({ capability: "memory.private" });
    expect(toolsFor(FOUNDER_MANIFEST_V2.allowed).map((t) => t.name)).toEqual(expect.arrayContaining(["remember_fact", "remember_facts", "retract_fact", "recall_facts"]));
    expect(FOUNDER_TOOLS.find((t) => t.name === "remember_fact")!.description).toMatch(/under their own keys/);
  });
});

describe("F1-FRESH-02 direct store API", () => {
  it("rememberFacts: one save, ordered history, notCarried across the batch; retractFact unchanged", () => {
    const d = founder();
    const now = clock();
    expect(rememberFacts(d.mem, { facts: [{ key: "fee", value: "fee 6.5%" }, { key: "quota", value: "quota 20/mo" }], now })).toMatchObject({ ok: true, output: "2 facts written (fee: remembered | quota: remembered)" });
    const r = rememberFacts(d.mem, { facts: [{ key: "fee", value: "fee 9%" }, { key: "summary", value: "plan only", supersedes: ["quota"] }], now });
    expect(r).toMatchObject({ ok: true, notCarried: ["fee 6.5%", "quota 20/mo"] });
    expect(loadFacts(d.mem).history.map((h) => [h.key, h.supersededBy])).toEqual([["fee", "fee"], ["quota", "summary"]]);
    expect(retractFact(d.mem, { key: "summary", reason: "obsolete", now })).toMatchObject({ ok: true });
  });
});
