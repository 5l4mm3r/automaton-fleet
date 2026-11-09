/**
 * 2026-11-09 (SHEET-1 diagnosis): the founder sees its runway and its owner task's required files.
 * SHEET-1 replayed with its real figures (fleet_cognition_log, 1e-8 USD): 50 calls averaging $0.0648424; every call refused
 * FLEET_COGNITION_CREDITS_EXHAUSTED from $0.795588 free (a call's worst-case reservation was about $0.78); the delivery note
 * the task asked for was never written and nothing had told the founder the end was near.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { FounderMind, type MindPorts } from "../../fleet/founder/mind.js";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { FOUNDER_MANIFEST_V2, manifestSha256 } from "../../fleet/capabilities.js";
import { capabilityView } from "../../fleet/cognition/capability-signature.js";
import type { ToolCall } from "../../fleet/cognition/types.js";
import { FINISH_STEPS, finishLine, missingRequired, parseRunway, requiredFilesLine, requiredFilesOf, runwayView, stepsWithin, type CallCost } from "../../fleet/founder/runway.js";

const USD = 100_000_000;   // µ¢ per dollar (1e-8 USD)
const RESERVE = 78_000_000;   // SHEET-1: a step's worst case, ~$0.78
const AVG = 6_484_240;        // SHEET-1: the average actual call, $0.0648424
const sheetCalls = (n = 20): CallCost[] => Array.from({ length: n }, () => ({ reserveUsdMicro: RESERVE, reserveMinorMicro: RESERVE, chargedMinorMicro: AVG }));
const credit = (free: number) => ({ creditFreeMicro: free, dailyLeftMicro: 50 * USD, run: null });
const TASK = (body: string) => ({ ownerTasks: [{ id: "5a1e0001-0000-4000-8000-000000000000", at: "2026-11-09T15:42:00Z", title: "SHEET-1", body }] });

describe("runway (SHEET-1 replay)", () => {
  it("counts steps the way FleetController checks them: a step runs only while its whole reservation is covered", () => {
    expect(stepsWithin(75_788_000, RESERVE, AVG)).toBe(0);            // the second refusal: $0.75788 free
    expect(stepsWithin(79_558_800, RESERVE, AVG)).toBe(1);            // $0.795588 free: call 50 ran, the next was refused
    expect(stepsWithin(150_000_000, RESERVE, AVG)).toBe(12);
    expect(stepsWithin(150_000_000, RESERVE, null)).toBeNull();
  });

  it("says how many steps are left, why the last of the budget cannot be used, and says FINISH NOW in time", () => {
    const at = (free: number) => runwayView({ ...credit(free), run: { ceilingMicro: 1_000 * USD, spentMicro: 0, endsAt: "2026-11-09T16:42:27Z" } }, sheetCalls(), Date.parse("2026-11-09T15:50:00Z"));
    const early = at(4 * USD);
    expect(early.binding).toBe("provider credit");
    expect(early.steps).toBe(50);
    expect(early.finishNow).toBe(false);
    expect(early.line).toMatch(/about 50 more steps before your model calls are refused \(the provider credit is the limit\)/);
    expect(early.line).toMatch(/about 12× what a step has actually cost/);
    expect(early.line).toMatch(/This run ends in 52 minutes \(16:42 UTC\)/);
    // With SHEET-1's rates the founder is told to finish with about 8 steps (≈ $0.50 of real cost) still to go.
    const late = at(125_000_000);
    expect(late.steps).toBe(FINISH_STEPS);
    expect(late.finishNow).toBe(true);
    expect(finishLine(late, ["deliverables/sheet-1/DELIVERY-NOTE.md"])).toBe("FINISH NOW: about 8 steps left. Write the missing required file first — "
      + "deliverables/sheet-1/DELIVERY-NOTE.md — short and complete beats polished and absent; start nothing new and do not re-check finished work.");
    expect(at(79_558_800).steps).toBe(1);
    expect(at(75_788_000).line).toMatch(/no longer covers one step's reservation — your next model call will be refused/);
  });

  it("the run's own ceiling, the daily budget and the clock each bind when they are the nearest", () => {
    const now = Date.parse("2026-11-09T16:35:00Z");
    const run = runwayView({ creditFreeMicro: 90 * USD, dailyLeftMicro: 50 * USD, run: { ceilingMicro: 4 * USD, spentMicro: 3 * USD, endsAt: "2026-11-09T17:42:00Z" } }, sheetCalls(), now);
    expect(run).toMatchObject({ binding: "run budget", steps: 4, finishNow: true });
    const daily = runwayView({ creditFreeMicro: 90 * USD, dailyLeftMicro: 2 * USD, run: null }, sheetCalls(), now);
    expect(daily).toMatchObject({ binding: "daily budget", steps: 19, finishNow: false });
    expect(daily.line).toMatch(/daily budget is the limit/);   // shown: within SHOW_STEPS though no run is open
    const clock = runwayView({ creditFreeMicro: 90 * USD, dailyLeftMicro: 50 * USD, run: { ceilingMicro: 100 * USD, spentMicro: 0, endsAt: "2026-11-09T16:42:00Z" } }, sheetCalls(), now);
    expect(clock).toMatchObject({ minutesLeft: 7, finishNow: true });
    expect(finishLine(clock, [])).toMatch(/^FINISH NOW: about \d+ steps \/ 7 minutes left\. Complete what you are delivering/);
  });

  it("stays out of the packet when nothing is near, and is honest before the first step is known", () => {
    expect(runwayView(credit(90 * USD), sheetCalls(), Date.now()).line).toBeNull();
    expect(runwayView(null, sheetCalls(), Date.now()).line).toBeNull();
    const first = runwayView({ ...credit(4 * USD), run: { ceilingMicro: 400 * USD, spentMicro: 0, endsAt: new Date(Date.now() + 3_600_000).toISOString() } }, [], Date.now());
    expect(first.line).toMatch(/^Runway: not known until your first recorded step of this run\./);
    expect(first.finishNow).toBe(false);
    expect(parseRunway({ creditFreeMicro: "123", dailyLeftMicro: null, run: { ceilingMicro: 1, spentMicro: 0, endsAt: "bad" } })).toEqual({ creditFreeMicro: 123, dailyLeftMicro: null, run: null });
    expect(parseRunway("x")).toBeNull();
  });
});

describe("required files of an owner task", () => {
  it("reads 'Required files:' from the task, workspace-relative only", () => {
    const f = requiredFilesOf(TASK("Build the report.\nRequired files: deliverables/sheet-1/Jobs-Report.xlsx, `deliverables/sheet-1/DELIVERY-NOTE.md`.\nThanks"));
    expect(f).toEqual([{ task: "5a1e0001", path: "deliverables/sheet-1/Jobs-Report.xlsx" }, { task: "5a1e0001", path: "deliverables/sheet-1/DELIVERY-NOTE.md" }]);
    expect(requiredFilesOf(TASK("Required files: /etc/passwd, ../x.md, a/../../b, ./ok.md, a//b, $(id).md"))).toEqual([{ task: "5a1e0001", path: "ok.md" }]);
    expect(requiredFilesOf(TASK("No list here: the required files are obvious"))).toEqual([]);
    expect(requiredFilesOf({})).toEqual([]);
  });

  it("a file counts as written only when it is a regular, non-empty file inside the workspace", () => {
    const w = fs.mkdtempSync(path.join(os.tmpdir(), "rf-"));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "rf-out-"));
    fs.mkdirSync(path.join(w, "d"));
    fs.writeFileSync(path.join(w, "d", "a.xlsx"), "x".repeat(17));
    fs.writeFileSync(path.join(w, "d", "empty.md"), "");
    fs.writeFileSync(path.join(out, "secret.md"), "outside");
    fs.symlinkSync(path.join(out, "secret.md"), path.join(w, "d", "link.md"));
    const files = ["d/a.xlsx", "d/empty.md", "d/link.md", "d/none.md"].map((p) => ({ task: "5a1e0001", path: p }));
    expect(missingRequired(w, files)).toEqual(["d/empty.md", "d/link.md", "d/none.md"]);
    expect(requiredFilesLine(w, files)).toBe("Required files of owner task 5a1e0001: d/a.xlsx — written (17 bytes); d/empty.md — MISSING; d/link.md — MISSING; d/none.md — MISSING. "
      + "The task is not complete while 3 are missing: write every required file before polishing or re-checking finished ones.");
    expect(requiredFilesLine(w, files.slice(0, 1))).toMatch(/All written\.$/);
    expect(requiredFilesLine(w, [])).toBeNull();
  });
});

// ─── The mind with the SHEET-1 shape: an owner task naming two files; the credit running down ───
const CAPS = { ok: true, origin: "reseed_founder", manifestId: "founder-v2", manifestSha256: manifestSha256(FOUNDER_MANIFEST_V2),
  allowed: [...FOUNDER_MANIFEST_V2.allowed], reproductionExecutable: false, paymentExecutable: false, experimentsEnabled: false, ownerRequests: true };
const c = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: `${name}-${Math.random().toString(36).slice(2, 8)}`, name, arguments: args });
const BODY = "Turn the export into a workbook and a note.\nRequired files: deliverables/sheet-1/Jobs-Report.xlsx, deliverables/sheet-1/DELIVERY-NOTE.md";

function rig(script: (turn: number, step: number) => ToolCall[], o: { free: () => number; body?: string; requests?: unknown[] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rw-"));
  const d = { w: path.join(root, "w"), s: path.join(root, "s"), m: path.join(root, "s", "memory") };
  for (const x of Object.values(d)) fs.mkdirSync(x, { recursive: true });
  fs.writeFileSync(path.join(d.m, "goals.json"), "[]");
  const packets: string[] = [], toolOutputs: string[][] = [];
  let turn = 0, step = 0;
  const ports: MindPorts = {
    cognitionStatus: async () => ({ policyEnabled: true, provider: "anthropic", founderEnabled: true, paused: false, routing: { active: true },
      capabilities: { ...capabilityView(CAPS, true), reproductionExecutable: false },
      attention: { ownerPending: 0, eventsDigest: "0".repeat(32), notices: [], recentEvents: [], ...TASK(o.body ?? BODY), ownerTasksDigest: "1".repeat(32) },
      runway: { creditFreeMicro: o.free(), dailyLeftMicro: 50 * USD, run: { ceilingMicro: 1_000 * USD, spentMicro: 0, endsAt: new Date(Date.now() + 3_600_000).toISOString() } },
      survival: { survivalEquityCents: 9_000, inferenceTodayCents: 80, burnPerDayCents: 40, runwayDays: 240 } }),
    ledger: async () => ({ cash: 9_000, survivalEquity: 9_000, genesisAllocation: 10_000, externalCustomerRevenue: 0 }),
    ownerRequests: async () => ({ ok: true, requests: o.requests ?? [] }),
    economy: async () => ({ ok: true }),
    infer: async (messages) => {
      const ms = messages as Array<{ role: string; content: string }>;
      if (ms.length === 1) { turn++; step = 0; packets.push(String(ms[0].content)); toolOutputs.push([]); }
      else toolOutputs.at(-1)!.push(String(ms.at(-1)!.content));
      step++;
      vi.setSystemTime(Date.now() + 11_000);   // steps 11 s apart: the between-step status read runs every step
      return { content: "", toolCalls: script(turn, step), usage: { inputTokens: 1, outputTokens: 1 }, chargedCents: 1, chargedMicrocents: AVG, requestId: `r${turn}-${step}`,
        reserve: { usdMicro: RESERVE, minorMicro: RESERVE } };
    },
  };
  const loopGuard = new LoopGuard({ stateDir: d.s, workspaceDir: d.w });
  const toolbox = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: d.w, memoryDir: d.m, loopGuard, selfGovernance: true,
    ports: { ledger: async () => ({}), ownerRequests: async () => ({ ok: true, requests: o.requests ?? [] }), economy: async () => ({ ok: true }) } as never });
  const mind = new FounderMind({ ports, toolbox, stateDir: d.s, workContinuity: true, hibernationSafetyMs: Number.POSITIVE_INFINITY, maxStepsPerTurn: 16,
    routed: { memoryDir: d.m, workspaceDir: d.w, manifest: FOUNDER_MANIFEST_V2, loopGuard } });
  return { mind, packets, toolOutputs, d };
}

describe("the founder's turn (SHEET-1 shape)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("the packet lists the required files as written / MISSING with the runway; a sleep while one is missing is answered once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const r = rig((t, s) => {
      if (t === 1 && s === 1) return [c("write_file", { path: "deliverables/sheet-1/Jobs-Report.xlsx", content: "workbook" })];
      if (t === 1 && s === 2) return [c("sleep", { reason: "workbook done" })];                       // forgets the note
      if (t === 1 && s === 3) return [c("write_file", { path: "deliverables/sheet-1/DELIVERY-NOTE.md", content: "Three jobs have no price: …" })];
      return [c("sleep", { reason: "delivered" })];
    }, { free: () => 4 * USD });
    await r.mind.turn("heartbeat");
    expect(r.packets[0]).toContain("Required files of owner task 5a1e0001: deliverables/sheet-1/Jobs-Report.xlsx — MISSING; deliverables/sheet-1/DELIVERY-NOTE.md — MISSING.");
    expect(r.packets[0]).toContain("Runway: not known until your first recorded step of this run.");
    expect(r.toolOutputs[0][1]).toMatch(/FLEET_TASK_INCOMPLETE[\s\S]*required file still missing — deliverables\/sheet-1\/DELIVERY-NOTE\.md/);
    expect(fs.existsSync(path.join(r.d.w, "deliverables/sheet-1/DELIVERY-NOTE.md"))).toBe(true);
    // The next turn's packet: both written, and the runway now counted from the recorded steps.
    await r.mind.turn("heartbeat 2");
    expect(r.packets[1]).toMatch(/Jobs-Report\.xlsx — written \(8 bytes\); deliverables\/sheet-1\/DELIVERY-NOTE\.md — written \(\d+ bytes\)\. All written\./);
    expect(r.packets[1]).toMatch(/Runway: about 50 more steps before your model calls are refused \(the provider credit is the limit\)/);
  });

  it("a second sleep in the same turn stops: a reminder, never a trap", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const r = rig(() => [c("sleep", { reason: "blocked: the export file is unreadable" })], { free: () => 4 * USD });
    const res = await r.mind.turn("heartbeat");
    expect(r.toolOutputs[0][0]).toMatch(/FLEET_TASK_INCOMPLETE/);
    expect(res.steps).toBe(2);
  });

  it("when the runway runs short mid-turn the founder is told to finish now, once, naming the missing file", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let free = 3 * USD;
    const r = rig((t, s) => {
      free -= 6 * AVG;   // spending fast: the runway shrinks between steps
      return s < 6 ? [c("list_files", { path: `deliverables/d${s}` })] : [c("sleep", { reason: "out of steps" })];
    }, { free: () => free });
    await r.mind.turn("heartbeat");
    const notes = r.toolOutputs[0].filter((x) => x.includes("[platform] FINISH NOW"));
    expect(notes.length).toBe(1);
    expect(notes[0]).toMatch(/FINISH NOW: about [1-8] steps? left\. Write the missing required files first — deliverables\/sheet-1\/Jobs-Report\.xlsx, deliverables\/sheet-1\/DELIVERY-NOTE\.md/);
    const log = fs.readFileSync(path.join(r.d.s, "mind-log.jsonl"), "utf8");
    expect(log).toMatch(/"finishNow":\{"steps":[1-8],"binding":"provider credit"/);
  });

  it("under Agent-1's real packet pressure (it fitted only at the last level) the new lines still fit and are never dropped", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const requests = Array.from({ length: 4 }, (_, i) => ({ requestId: `dep-${i}`, kind: "non_delegable_credential", status: "pending", action: "Publishing the listing on a marketplace through its API gateway " + "once the owner-held shop is connected. ".repeat(3),
      title: `Owner-held account ${i} ` + "for the venture, connected to the gateway. ".repeat(6), blocksAction: true, createdAt: new Date().toISOString() }));
    const body = "SHEET-1: " + "Treat it as a real client's job; put everything in deliverables/sheet-1/. ".repeat(17) + "\n" + BODY;
    let free = 130_000_000;
    const r = rig((t) => (t === 1 ? [c("list_files", { path: "." })] : [c("sleep", { reason: "x" }), c("sleep", { reason: "x" })]), { free: () => free, body, requests });
    fs.writeFileSync(path.join(r.d.m, "facts.json"), JSON.stringify(Object.fromEntries(Array.from({ length: 16 }, (_, i) =>
      [`ledger_check_old_${String(i).padStart(2, "0")}`, `STALE-FACT-${i} ` + "September ledger check: keep every turn to a bare sleep. ".repeat(7)]))));
    fs.mkdirSync(path.join(r.d.w, "product"));
    for (let i = 0; i < 80; i++) fs.writeFileSync(path.join(r.d.w, "product", `big${i}.txt`), `RESULT-MARK-${i} ` + "x".repeat(5_000));
    await r.mind.turn("heartbeat");          // one recorded step, so the runway is known
    free = 125_000_000;
    await r.mind.turn("heartbeat 2");
    expect(r.packets.length).toBe(2);        // both packets were built (no "essentials do not fit")
    const fits = fs.readFileSync(path.join(r.d.s, "mind-log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).packetFit).filter(Boolean);
    expect(Math.max(...fits)).toBeGreaterThanOrEqual(5);   // the pressure is real: as on 9 Nov, the packet fitted only after shortening
    expect(r.packets[1]).toContain("deliverables/sheet-1/DELIVERY-NOTE.md — MISSING");
    expect(r.packets[1]).toMatch(/Runway: about 8 more steps/);
    expect(r.packets[1]).toContain("FINISH NOW: about 8 steps left. Write the missing required files first");
  });
});
