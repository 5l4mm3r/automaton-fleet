/**
 * F1-FRESH-01 — structured fact freshness in founder memory.
 *
 * Reproduces the F1-EVAL-02 stale-status finding: after Phase F closed goal g1, the fact
 * "O2 open uncertainties + status" still said "goal g1 open / research is done" and would have been read as current
 * truth by the next packet. Here: the stale fact is flagged, a newer status fact supersedes it, recall and every
 * packet use the current fact only, and the old value survives only as audit history.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { FACTS_FILE, FACT_LEDGER_FILE, loadFacts, parseSource, recallFacts, rememberFact, retractFact } from "../../fleet/founder/facts.js";
import { buildDecisionPacket, buildTaskPacket, renderTaskPacket, taskPacketProblems } from "../../fleet/cognition/task-packet.js";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { FOUNDER_MANIFEST_V2, decideTool } from "../../fleet/capabilities.js";
import { FOUNDER_TOOLS } from "../../fleet/cognition/types.js";

const OUTPUT = { form: "decision" as const, mustCite: true, instructions: "decide" };
const clock = (...isos: string[]) => { let i = 0; return () => new Date(isos[Math.min(i++, isos.length - 1)]); };

function founderDirs(legacyFacts?: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fresh01-"));
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
  const packet = (task = "Decide the next step for opportunity O2.") => buildTaskPacket({ memoryDir: mem, workspaceDir: ws, task, outputContract: OUTPUT });
  const raw = (f: string) => fs.readFileSync(path.join(mem, f), "utf8");
  return { mem, ws, tool, packet, raw };
}

describe("F1-FRESH-01 regression: the F1-EVAL-02 stale status fact", () => {
  it("old status fact → newer current status supersedes it → recall and packets use the current fact → the old one is audit history only", async () => {
    // State as F1-EVAL-02 left it after Phase C: a status fact written by a runtime without freshness (legacy string).
    const STALE_KEY = "O2 open uncertainties + status";
    const d = founderDirs({ [STALE_KEY]: "goal g1 open; desk research is done; next: listing test", o2_demand: "GroomersNet thread, 41 replies (attemptId aaaaaaaa-0000-4000-8000-000000000001)" });
    fs.writeFileSync(path.join(d.mem, "goals.json"), JSON.stringify([{ id: "g1", title: "Validate O2", status: "open", at: "2026-09-29T23:42:00.000Z" }]));
    // Phase F: the goal closes. The founder did not touch the status fact (exactly what happened in F1-EVAL-02).
    expect(await d.tool("complete_goal", { id: "g1", outcome: "Listing test failed: 0 sales in 14 days (simulated)" })).toMatchObject({ ok: true });
    const goals = JSON.parse(fs.readFileSync(path.join(d.mem, "goals.json"), "utf8"));
    expect(goals[0].completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The next packet no longer presents the stale fact as unqualified truth: it is flagged and listed as uncertain.
    const p1 = d.packet();
    const staleEntry = p1.knowledge.find((k) => k.key === STALE_KEY)!;
    expect(staleEntry.possiblyStale).toMatch(/names goal g1, completed .*; this fact's time is unknown/);
    expect(staleEntry.observedAt).toBeUndefined(); // no invented timestamp for a legacy fact
    expect(p1.uncertainty).toContain(STALE_KEY);
    // A newer, contradictory status fact arrives and explicitly replaces the stale one.
    const r = await d.tool("remember_fact", { key: "o2_status", value: "g1 complete: listing test failed (0 sales); O2 is not viable at £12", source: "goal:g1", supersedes: [STALE_KEY] });
    expect(r).toMatchObject({ ok: true, output: `remembered; superseded: ${STALE_KEY}` });
    // Recall: current truth only by default.
    const rec = JSON.parse(String((await d.tool("recall_facts", {})).output));
    expect(Object.keys(rec.current).sort()).toEqual(["o2_demand", "o2_status"]);
    expect(rec.current.o2_status).toMatchObject({ status: "current", source: "goal:g1", observedAt: expect.any(String) });
    expect(rec.history).toBeUndefined();
    // Packets (task and decision) carry the current status and never the superseded one.
    const p2 = d.packet();
    expect(p2.knowledge.map((k) => k.key)).toEqual(["o2_demand", "o2_status"]);
    expect(p2.knowledge.find((k) => k.key === "o2_status")).toMatchObject({ provenance: "goal:g1", observedAt: expect.any(String) });
    expect(p2.knowledge.find((k) => k.key === "o2_status")!.possiblyStale).toBeUndefined(); // recorded after g1 closed
    expect(renderTaskPacket(p2)).not.toContain("desk research is done");
    const dp = buildDecisionPacket({ memoryDir: d.mem, workspaceDir: d.ws, question: "Is O2 still worth a listing test?", escalationReason: "EVIDENCE_CONFLICT",
      hypothesis: "Run the O2 listing test again", state: "g1 complete", economicConsequence: "£0.20 fee", conflict: ["status says open"] });
    expect(JSON.stringify(dp)).not.toContain("desk research is done");
    expect(dp.knowledge.map((k) => k.key)).toContain("o2_status");
    // The old value survives as audit history only, exactly as it was (no invented time or source).
    const hist = JSON.parse(String((await d.tool("recall_facts", { includeHistory: true })).output)).history;
    expect(hist).toEqual([{ key: STALE_KEY, value: "goal g1 open; desk research is done; next: listing test", status: "superseded", supersededBy: "o2_status", endedAt: expect.any(String) }]);
    // facts.json stays the legacy shape (current facts only): older runtimes and a rollback read it unchanged.
    const onDisk = JSON.parse(d.raw(FACTS_FILE));
    expect(onDisk).toEqual({ o2_demand: expect.any(String), o2_status: expect.any(String) });
    expect(Object.values(onDisk).every((v) => typeof v === "string")).toBe(true);
  });
});

describe("F1-FRESH-01 fact store", () => {
  it("an in-place update supersedes; multiple supersessions keep an ordered history; chains across keys are auditable", () => {
    const d = founderDirs();
    const now = clock("2026-10-01T10:00:00.000Z", "2026-10-01T11:00:00.000Z", "2026-10-01T12:00:00.000Z", "2026-10-01T13:00:00.000Z", "2026-10-01T14:00:00.000Z");
    expect(rememberFact(d.mem, { key: "fee", value: "Stallhub fee 6.5%", source: "https://stallhub.example/fees", now })).toMatchObject({ ok: true, output: "remembered" });
    expect(rememberFact(d.mem, { key: "fee", value: "Stallhub fee 9% from 1 Oct", source: "bbbbbbbb-0000-4000-8000-000000000002", now })).toMatchObject({ ok: true, output: /updated/ });
    expect(rememberFact(d.mem, { key: "fee", value: "Stallhub fee 9.5% from 1 Nov", now })).toMatchObject({ ok: true });
    const s = loadFacts(d.mem);
    expect(s.current).toEqual([{ key: "fee", value: "Stallhub fee 9.5% from 1 Nov", status: "current", observedAt: "2026-10-01T12:00:00.000Z", source: null }]);
    expect(s.history.map((h) => [h.value, h.status, h.observedAt, h.supersededBy, h.endedAt, h.source])).toEqual([
      ["Stallhub fee 6.5%", "superseded", "2026-10-01T10:00:00.000Z", "fee", "2026-10-01T11:00:00.000Z", { url: "https://stallhub.example/fees" }],
      ["Stallhub fee 9% from 1 Oct", "superseded", "2026-10-01T11:00:00.000Z", "fee", "2026-10-01T12:00:00.000Z", { attemptId: "bbbbbbbb-0000-4000-8000-000000000002" }],
    ]);
    // Cross-key chain: a → b → c.
    rememberFact(d.mem, { key: "plan_a", value: "sell at £12", now });
    rememberFact(d.mem, { key: "plan_b", value: "sell at £9", supersedes: ["plan_a"], now });
    rememberFact(d.mem, { key: "plan_c", value: "bundle at £15", supersedes: ["plan_b"], now });
    const t = loadFacts(d.mem);
    expect(t.current.map((f) => f.key)).toEqual(["fee", "plan_c"]);
    expect(t.history.slice(-2).map((h) => [h.key, h.supersededBy])).toEqual([["plan_a", "plan_b"], ["plan_b", "plan_c"]]);
    // Superseding an unknown key refuses the whole write (nothing changes).
    const before = [d.raw(FACTS_FILE), d.raw(FACT_LEDGER_FILE)];
    expect(rememberFact(d.mem, { key: "plan_d", value: "x", supersedes: ["no_such_fact"], now })).toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    expect([d.raw(FACTS_FILE), d.raw(FACT_LEDGER_FILE)]).toEqual(before);
  });

  it("retraction removes a fact from current truth and keeps it as retracted history with the reason", async () => {
    const d = founderDirs();
    await d.tool("remember_fact", { key: "competitor_count", value: "3 competitors", source: "cccccccc-0000-4000-8000-000000000003" });
    expect(await d.tool("retract_fact", { key: "competitor_count", reason: "misread the search page: those were ads" })).toMatchObject({ ok: true });
    expect(loadFacts(d.mem).current).toEqual([]);
    expect(d.packet().knowledge).toEqual([]);
    const h = loadFacts(d.mem).history;
    expect(h).toEqual([{ key: "competitor_count", value: "3 competitors", status: "retracted", observedAt: expect.any(String), source: { attemptId: "cccccccc-0000-4000-8000-000000000003" },
      endedAt: expect.any(String), reason: "misread the search page: those were ads" }]);
    expect(await d.tool("retract_fact", { key: "competitor_count", reason: "again" })).toMatchObject({ ok: false, refused: "FLEET_NOT_FOUND" });
    expect(await d.tool("retract_fact", { key: "competitor_count" })).toMatchObject({ ok: false, refused: "FLEET_BAD_REQUEST" });
  });

  it("legacy Record<string,string> facts load safely: nothing deleted, no invented timestamps, the first write migrates lazily", () => {
    const legacy = { a: "alpha", b: "beta", "decision:1": JSON.stringify({ question: "q", answer: "x", at: "2026-09-29T00:00:00Z" }) };
    const d = founderDirs(legacy);
    const bytes = d.raw(FACTS_FILE);
    expect(loadFacts(d.mem).current).toEqual(Object.keys(legacy).sort().map((k) => ({ key: k, value: legacy[k as keyof typeof legacy], status: "current", observedAt: null, source: null })));
    expect(d.raw(FACTS_FILE)).toBe(bytes); // loading never rewrites
    expect(fs.existsSync(path.join(d.mem, FACT_LEDGER_FILE))).toBe(false);
    rememberFact(d.mem, { key: "c", value: "gamma", now: clock("2026-10-01T09:00:00.000Z") });
    const s = loadFacts(d.mem);
    expect(s.current.map((f) => [f.key, f.observedAt])).toEqual([["a", null], ["b", null], ["c", "2026-10-01T09:00:00.000Z"], ["decision:1", null]]);
    expect(JSON.parse(d.raw(FACTS_FILE))).toEqual({ ...legacy, c: "gamma" });
    // A value changed outside the store (an older runtime after a rollback): its metadata is not misattributed.
    const f = JSON.parse(d.raw(FACTS_FILE));
    f.c = "gamma (edited by an older runtime)";
    fs.writeFileSync(path.join(d.mem, FACTS_FILE), JSON.stringify(f));
    expect(loadFacts(d.mem).current.find((x) => x.key === "c")).toMatchObject({ observedAt: null, source: null });
  });

  it("malformed structured data fails closed: nothing is rewritten, deleted or guessed", async () => {
    const cases: Array<[string, string, string]> = [
      [FACTS_FILE, "{not json", "facts.json is not valid JSON"],
      [FACTS_FILE, JSON.stringify(["a"]), "not an object of facts"],
      [FACTS_FILE, JSON.stringify({ a: { value: "x" } }), "is not a string"],
      [FACT_LEDGER_FILE, JSON.stringify({ version: "fleet-facts-v0", current: {}, history: [], trimmed: 0 }), "not a valid fleet-facts-v1 ledger"],
      [FACT_LEDGER_FILE, JSON.stringify({ version: "fleet-facts-v1", current: { a: { observedAt: "yesterday", source: null, valueSha256: "0".repeat(64) } }, history: [], trimmed: 0 }), "not a valid"],
      [FACT_LEDGER_FILE, JSON.stringify({ version: "fleet-facts-v1", current: {}, history: [{ key: "a", value: "v", status: "current", observedAt: null, source: null }], trimmed: 0 }), "not a valid"],
    ];
    for (const [file, content, message] of cases) {
      const d = founderDirs({ a: "alpha" });
      fs.writeFileSync(path.join(d.mem, file), content);
      const snapshot = fs.readdirSync(d.mem).map((f) => [f, d.raw(f)]);
      expect(() => loadFacts(d.mem)).toThrow(message);
      expect(await d.tool("remember_fact", { key: "b", value: "beta" })).toMatchObject({ ok: false, refused: "FLEET_FACTS_MALFORMED" });
      expect(await d.tool("retract_fact", { key: "a", reason: "x" })).toMatchObject({ ok: false, refused: "FLEET_FACTS_MALFORMED" });
      expect(await d.tool("recall_facts", {})).toMatchObject({ ok: false, refused: "FLEET_FACTS_MALFORMED" });
      expect(fs.readdirSync(d.mem).map((f) => [f, d.raw(f)])).toEqual(snapshot); // nothing written
      // A packet reports the problem instead of presenting an empty memory as the truth.
      const p = d.packet();
      expect(p.knowledge).toEqual([]);
      expect(p.uncertainty[0]).toMatch(/^memory:facts unreadable/);
    }
  });

  it("provenance: stated sources are kept, never invented, survive updates in history, and are refreshed only on re-observation", () => {
    const d = founderDirs();
    const now = clock("2026-10-01T08:00:00.000Z", "2026-10-01T09:00:00.000Z", "2026-10-01T10:00:00.000Z", "2026-10-01T11:00:00.000Z");
    expect(parseSource("AAAAAAAA-0000-4000-8000-000000000001")).toEqual({ attemptId: "aaaaaaaa-0000-4000-8000-000000000001" });
    expect(parseSource("https://gov.example/vat")).toEqual({ url: "https://gov.example/vat" });
    expect(parseSource("decision:5f0e…")).toEqual({ ref: "decision:5f0e…" });
    expect(parseSource("  ")).toBeNull();
    rememberFact(d.mem, { key: "vat", value: "VAT threshold £90k", source: "https://gov.example/vat", now });
    rememberFact(d.mem, { key: "vat", value: "VAT threshold £90k", now }); // re-observed, no new source: source kept
    expect(loadFacts(d.mem).current[0]).toMatchObject({ observedAt: "2026-10-01T09:00:00.000Z", source: { url: "https://gov.example/vat" } });
    rememberFact(d.mem, { key: "vat", value: "VAT threshold £95k", now }); // a new value without a source: unknown, not inherited
    const s = loadFacts(d.mem);
    expect(s.current[0]).toMatchObject({ value: "VAT threshold £95k", source: null });
    expect(s.history[0]).toMatchObject({ value: "VAT threshold £90k", source: { url: "https://gov.example/vat" }, observedAt: "2026-10-01T09:00:00.000Z" });
    expect(recallFacts(d.mem, { query: "vat", includeHistory: true })).toMatchObject({ ok: true, current: [{ key: "vat" }], history: [{ key: "vat", status: "superseded" }] });
  });

  it("packets are deterministic, sorted, valid, current-only, and a stale hint needs a completed goal named by the fact", async () => {
    const d = founderDirs();
    const now = clock("2026-10-01T08:00:00.000Z", "2026-10-01T08:30:00.000Z", "2026-10-01T09:00:00.000Z", "2026-10-01T10:00:00.000Z");
    rememberFact(d.mem, { key: "zeta", value: "last by key", now });
    rememberFact(d.mem, { key: "alpha", value: "first by key", source: "https://a.example/x", now });
    rememberFact(d.mem, { key: "g2_note", value: "g2 is open and waiting for fees", now });
    rememberFact(d.mem, { key: "alpha", value: "first by key, revised", now });
    fs.writeFileSync(path.join(d.mem, "goals.json"), JSON.stringify([{ id: "g2", title: "Fees", status: "complete", completedAt: "2026-10-01T09:30:00.000Z" }, { id: "g3", title: "Other", status: "open" }]));
    const a = d.packet();
    const b = d.packet();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.knowledge.map((k) => k.key)).toEqual(["alpha", "g2_note", "zeta"]);
    expect(a.knowledge[0]).toEqual({ key: "alpha", value: "first by key, revised", source: "facts.json", observedAt: "2026-10-01T10:00:00.000Z" }); // no provenance: not stated for this value
    expect(a.knowledge[1].possiblyStale).toBe("names goal g2, completed 2026-10-01T09:30:00.000Z after this fact was recorded (2026-10-01T09:00:00.000Z)");
    expect(a.knowledge[2].possiblyStale).toBeUndefined();
    expect(taskPacketProblems(a)).toEqual([]);
    expect(renderTaskPacket(a)).not.toContain("first by key\"");
    // Recorded after the goal closed: not flagged.
    rememberFact(d.mem, { key: "g2_note", value: "g2 closed: fees accepted", now: clock("2026-10-01T09:45:00.000Z") });
    expect(d.packet().knowledge.find((k) => k.key === "g2_note")!.possiblyStale).toBeUndefined();
  });

  it("the tool surface: retract_fact is a private-memory tool (no new authority), and facts.json never holds anything but strings", async () => {
    expect(decideTool("retract_fact", FOUNDER_MANIFEST_V2)).toMatchObject({ allowed: true });
    expect(FOUNDER_TOOLS.find((t) => t.name === "retract_fact")).toMatchObject({ capability: "memory.private" });
    const d = founderDirs({ legacy: "kept" });
    await d.tool("remember_fact", { key: "x", value: "1", source: "ref:one" });
    await d.tool("remember_fact", { key: "x", value: "2", supersedes: "x" }); // not a list: refused
    expect(JSON.parse(d.raw(FACTS_FILE))).toEqual({ legacy: "kept", x: "1" });
    await d.tool("remember_fact", { key: "y", value: "3", supersedes: ["x"] });
    await d.tool("retract_fact", { key: "legacy", reason: "obsolete" });
    expect(JSON.parse(d.raw(FACTS_FILE))).toEqual({ y: "3" });
    expect(loadFacts(d.mem).history.map((h) => [h.key, h.status])).toEqual([["x", "superseded"], ["legacy", "retracted"]]);
  });
});
