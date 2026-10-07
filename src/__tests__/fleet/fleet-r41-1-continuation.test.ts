/**
 * R41.1 — survival instinct + blocked-action continuation (founder side; scripted cognition, no database, no model).
 *
 * R41 showed Agent 2 building a first product, recording a genuine Gumroad/KYC dependency, then mostly sleeping: its only
 * goal mixed "build the template" with "create a marketplace account", account refusals read as "blocked everywhere", and
 * slim wake packets leaned toward sleep. These tests drive the production FounderMind and FounderToolbox:
 *   - ONE blocked dependency blocks ONE goal (blockedBy), never the founder or its venture; refusals say so;
 *   - full wake packets while executable work exists; slim, backed-off wakes only while everything is blocked/awaiting;
 *   - an equivalent pending dependency is returned, never requested twice;
 *   - hibernation is earned and states its wake condition; a sale wakes the founder into fulfil/learn/forward;
 *   - the survival objective (economic state + existential pressure) is always present and never bypasses a rule;
 *   - expansion is a proposal only while replication is disabled.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { FounderMind, MAX_IDLE_SKIP, type MindPorts } from "../../fleet/founder/mind.js";
import { FounderToolbox, JOURNAL_FILE, sameAction } from "../../fleet/founder/toolbox.js";
import { LoopGuard, SCOPED_CONTINUE } from "../../fleet/founder/loop-guard.js";
import { HIBERNATE_LINE, BOOTSTRAP_LINE, classifyWork, economicState, stateLine, type SurvivalView } from "../../fleet/founder/decisions.js";
import { FIELD_GUIDE, guideSection } from "../../fleet/founder/field-guide.js";
import { FOUNDER_MANIFEST_V2, decideTool, manifestSha256 } from "../../fleet/capabilities.js";
import { FOUNDER_CHARTER, FOUNDER_CHARTER_V5, FOUNDER_TOOLS, FOUNDER_V5_TOOLS, toolsForDoctrine, type ToolCall } from "../../fleet/cognition/types.js";
import { capabilityView, founderStepTools } from "../../fleet/cognition/capability-signature.js";
import { taskPacketProblems } from "../../fleet/cognition/task-packet.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "r411-"));
/** Agent 2's real R41 dependency (production owner request 6178c7bb…, raised by rail.require; no goal reference). */
const DEP = "6178c7bb-6a68-49d4-9175-057b60bef89f";
const DEP_ACTION = "Open a gumroad account (storefront) for venture uk-sa-template";
const dep = (o: Record<string, unknown> = {}) => ({ requestId: DEP, kind: "kyc", action: DEP_ACTION, title: "Payment rail required: gumroad / storefront", status: "pending",
  goalRef: null, response: null, ageS: 600, ...o });
/** Agent 2's real goal after R41: executable and blocked work mixed in one goal. */
const MIXED_G1 = { id: "g1", title: "Execute first-niche: Build the template as a CSV/xlsx file in the workspace and create a marketplace account", status: "open",
  rationale: "Selected \"UK self-employed bookkeeping/tax-year spreadsheet template pack (digital, ~£9)\".", decision: "first-niche" };
const CAPS = (o: Record<string, unknown> = {}) => ({ ok: true, origin: "reseed_founder", manifestId: "founder-v2", manifestSha256: manifestSha256(FOUNDER_MANIFEST_V2),
  allowed: [...FOUNDER_MANIFEST_V2.allowed], reproductionExecutable: false, paymentExecutable: false, experimentsEnabled: false, ownerRequests: true, ...o });
const SURVIVAL = (o: Partial<SurvivalView> = {}): SurvivalView => ({ survivalEquityCents: 9_968, inferenceTodayCents: 33, burnPerDayCents: 40, runwayDays: 249, ...o });

type Reply = (n: number, packet: string) => ToolCall[] | undefined;
function rig(o: { goals?: unknown[]; deps?: () => unknown[]; reply?: Reply; ledger?: () => Record<string, unknown>; survival?: () => SurvivalView | null;
  caps?: () => Record<string, unknown> } = {}) {
  const root = tmp();
  const d = { w: path.join(root, "w"), s: path.join(root, "s"), m: path.join(root, "s", "memory") };
  for (const x of Object.values(d)) fs.mkdirSync(x, { recursive: true });
  fs.mkdirSync(path.join(d.w, "product"));
  fs.writeFileSync(path.join(d.w, "product", "income_tracker.csv"), "date,client,amount\n");
  fs.writeFileSync(path.join(d.m, "goals.json"), JSON.stringify(o.goals ?? [MIXED_G1]));
  const packets: string[] = [];
  const created: Array<Record<string, unknown>> = [];
  const economy: string[] = [];
  let n = 0;
  const deps = () => ({ ok: true, requests: o.deps ? o.deps() : [dep()] });
  const ports: MindPorts = {
    cognitionStatus: async () => {
      const s = o.survival ? o.survival() : SURVIVAL();
      return { policyEnabled: true, provider: "anthropic", founderEnabled: true, paused: false, routing: { active: true }, capabilities: { ...capabilityView(o.caps?.() ?? CAPS(), true),
        reproductionExecutable: (o.caps?.() ?? CAPS()).reproductionExecutable }, ...(s ? { survival: s } : {}) };
    },
    ledger: async () => o.ledger?.() ?? { cash: 9_968, survivalEquity: 9_968, genesisAllocation: 10_000, externalCustomerRevenue: 0, realizedNetProfit: -32 },
    ownerRequests: async () => deps(),
    infer: async (messages) => {
      const packet = String((messages as Array<{ content: string }>)[0].content);
      packets.push(packet);
      n++;
      return { content: "", toolCalls: o.reply?.(n, packet) ?? [{ id: `z${n}`, name: "sleep", arguments: { reason: "nothing to do" } }], usage: { inputTokens: 1, outputTokens: 1 },
        chargedCents: 0, requestId: `r${n}` };
    },
  };
  const loopGuard = new LoopGuard();
  const toolbox = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: d.w, memoryDir: d.m, loopGuard, selfGovernance: true, ports: {
    ledger: async () => ({}), spendOrder: async () => ({}), proposeKnowledge: async () => ({}), knowledge: async () => [], requestIdentityFact: async () => ({}),
    ownerRequests: async () => deps(),
    ownerRequestCreate: async (x: Record<string, unknown>) => { created.push(x); return { ok: true, requestId: `00000000-0000-4000-8000-${String(created.length).padStart(12, "0")}`, status: "pending" }; },
    ownerRequestWithdraw: async () => ({ ok: true }),
    economy: async (op: string) => { economy.push(op); return { ok: true }; },
  } as never });
  const mind = new FounderMind({ ports, toolbox, stateDir: d.s, routed: { memoryDir: d.m, workspaceDir: d.w, manifest: FOUNDER_MANIFEST_V2, loopGuard } });
  const parse = (text: string) => {
    const body = JSON.parse(text.split("\n").slice(3).join("\n"));
    expect(taskPacketProblems(body)).toEqual([]);
    const task = String(body.task);
    return { body, task, slim: /Nothing has changed since your last turn/.test(task) };
  };
  const next = async () => {
    const before = packets.length;
    for (let i = 0; i <= MAX_IDLE_SKIP + 1 && packets.length === before; i++) await mind.turn(`heartbeat ${i}`);
    expect(packets.length).toBe(before + 1);
    return parse(packets.at(-1)!);
  };
  const goals = () => JSON.parse(fs.readFileSync(path.join(d.m, "goals.json"), "utf8")) as Array<Record<string, unknown>>;
  return { mind, toolbox, next, packets, created, economy, d, goals };
}
const seq = async (r: ReturnType<typeof rig>, k: number) => { const out = []; for (let i = 0; i < k; i++) out.push(await r.next()); return out; };
const call = (name: string, args: Record<string, unknown>, id = `${name}-${Math.random().toString(36).slice(2, 8)}`): ToolCall => ({ id, name, arguments: args });

describe("R41.1 blocked goals and the wake rule", () => {
  it("(1) a pending dependency + an executable open goal → FULL packets every wake, executable work named, never slim", async () => {
    const r = rig({ goals: [{ id: "g1", title: "Improve the template pack and its launch material", status: "open" }, { id: "g2", title: "Publish the pack on Gumroad", status: "open", blockedBy: DEP }] });
    const ps = await seq(r, 8); // the founder (wrongly) sleeps every turn
    expect(ps.map((p) => p.slim)).toEqual(Array(8).fill(false));
    for (const p of ps) {
      expect(p.task).toContain("Executable now: g1.");
      expect(p.task).toMatch(/Blocked: g2 — waiting on dependency 6178c7bb \(pending\)\. Already requested: do not request it again and do not retry the blocked action\. It blocks only this goal\./);
      expect(p.body.objective.map((g: { id: string; title: string }) => [g.id, g.title])).toEqual([["g1", "Improve the template pack and its launch material"], ["g2", "Publish the pack on Gumroad"]]);
    }
    expect(ps[1].task).toMatch(/^Idle wake: your open goals are your execution path \(g1 "Improve the template pack/m); // the push names the executable goal, not the blocked one
    expect(r.created).toEqual([]);
  });

  it("(2) every open goal blocked + no open decision → hibernation: slim wakes with the backed-off re-check (4, 8, 16, 32)", async () => {
    const r = rig({ goals: [{ id: "g2", title: "Publish the pack on Gumroad", status: "open", blockedBy: DEP }] });
    const first = await r.next();
    expect(first.slim).toBe(false);
    expect(first.task).toContain(HIBERNATE_LINE);
    const ps = await seq(r, 31);
    const full = ps.map((p, i) => (p.slim ? -1 : i + 1)).filter((i) => i > 0);
    expect(full).toEqual([5, 14, 31]); // after 4, 8 and 16 slim wakes: the same bounded schedule as before
    expect(r.mind.routing.idleNudges.hibernate).toBe(3);
    for (const i of full) expect(ps[i - 1].task).toContain(HIBERNATE_LINE);
  });

  it("(3) set_goal with blockedBy / awaiting / reviewAt is stored, rendered, updatable and clearable (founder-v5 vocabulary)", async () => {
    const r = rig({ goals: [] });
    const run = (args: Record<string, unknown>) => r.toolbox.execute(call("set_goal", args));
    expect((await run({ title: "Publish on Gumroad", blockedBy: DEP })).output).toMatch(/goal g1 set — BLOCKED by dependency 6178c7bb \(only this goal; your other goals stay executable\)/);
    expect((await run({ title: "Measure listing views", awaiting: "7 days of views", reviewAt: "2026-10-15T09:00:00Z" })).output).toMatch(/goal g2 set — AWAITING 7 days of views \(review 2026-10-15T09:00:00\.000Z\)/);
    expect((await run({ title: "Write the FAQ" })).output).toBe("goal g3 set"); // an unmarked goal answers exactly as before
    expect((await run({ title: "x", blockedBy: "not-a-dependency" })).refused).toBe("FLEET_BAD_REQUEST");
    expect((await run({ title: "x", reviewAt: "someday" })).refused).toBe("FLEET_BAD_REQUEST");
    expect(r.goals().map((g) => [g.id, g.blockedBy ?? null, g.awaiting ?? null])).toEqual([["g1", DEP, null], ["g2", null, "7 days of views"], ["g3", null, null]]);
    // Clearing a mark makes the goal executable again; an unknown or completed goal cannot be updated.
    expect((await run({ id: "g1", blockedBy: "" })).output).toBe("goal g1 updated — executable");
    expect(r.goals()[0].blockedBy).toBeUndefined();
    expect((await run({ id: "g9", title: "nope" })).refused).toBe("FLEET_NOT_FOUND");
    // Rendered by work state.
    const w = classifyWork([{ id: "g1", title: "Publish on Gumroad", blockedBy: DEP.slice(0, 8) }, { id: "g2", title: "Measure", awaiting: "views", reviewAt: "2999-01-01T00:00:00Z" },
      { id: "g3", title: "Overdue review", awaiting: "views", reviewAt: "2000-01-01T00:00:00Z" }, { id: "g4", title: "Write the FAQ" }], [dep()]);
    expect([w.blocked.map((b) => b.goal.id), w.awaiting.map((g) => g.id), w.due.map((g) => g.id), w.executable.map((g) => g.id)]).toEqual([["g1"], ["g2"], ["g3"], ["g4"]]);
    // A resolved dependency blocks nothing: the founder decides what the answer means.
    expect(classifyWork([{ id: "g1", title: "Publish", blockedBy: DEP }], [dep({ status: "declined" })]).executable.map((g) => g.id)).toEqual(["g1"]);
  });

  it("(4) an equivalent pending dependency is returned, never requested twice; a different action is recorded; the goal is marked blocked", async () => {
    const r = rig({ goals: [{ id: "g1", title: "Improve the pack", status: "open" }, { id: "g2", title: "Publish on Gumroad", status: "open" }] });
    const again = await r.toolbox.execute(call("record_external_dependency", { kind: "kyc", action: "Open a Gumroad storefront account for venture uk-sa-template", title: "Gumroad", detail: "seller account needs KYC", goalId: "g2" }));
    expect(again.ok).toBe(true);
    expect(again.output).toMatch(new RegExp(`^ALREADY REQUESTED: dependency ${DEP} \\(kyc\\) for this action is pending\\. Do not request it again or retry the blocked action`));
    expect(r.created).toEqual([]); // no second owner request
    expect(r.goals().find((g) => g.id === "g2")!.blockedBy).toBe(DEP);
    expect(r.goals().find((g) => g.id === "g1")!.blockedBy).toBeUndefined(); // only that goal
    const other = await r.toolbox.execute(call("record_external_dependency", { kind: "kyc", action: "Open a Payhip seller account for venture uk-sa-template", title: "Payhip", detail: "KYC" }));
    expect(other.ok).toBe(true);
    expect(r.created).toHaveLength(1);
    expect(sameAction(DEP_ACTION, "open a GUMROAD account, storefront, for venture uk-sa-template")).toBe(true);
    expect(sameAction(DEP_ACTION, "Sign the lease for an office in Leeds")).toBe(false);
  });
});

describe("R41.1 scoped refusals (the security boundary itself is unchanged)", () => {
  it("(5, 6) FLEET_CAPABILITY_UNCLASSIFIED and FLEET_DUPLICATE_FAILED_ACTION explain the scope; the refusals, the manifest and the economy port are unchanged", async () => {
    const r = rig();
    const create = call("identity", { op: "create_account", args: { provider: "payhip" } }, "same-id");
    const first = await r.toolbox.execute(create);
    expect(first).toMatchObject({ ok: false, refused: "FLEET_CAPABILITY_UNCLASSIFIED" });
    expect(first.output).toContain("(tool identity) is not available to this founder.");
    expect(first.output).toContain(SCOPED_CONTINUE);
    const second = await r.toolbox.execute({ ...create, id: "same-id-2" });
    expect(second).toMatchObject({ ok: false, refused: "FLEET_DUPLICATE_FAILED_ACTION" });
    expect(second.output).toContain(SCOPED_CONTINUE);
    expect(SCOPED_CONTINUE).toMatch(/blocks only this one action — not you, your other goals or your venture\. Do not retry the identical action\./);
    // Underlying behaviour unchanged: the same decisions, nothing reached FleetController, and the pinned manifest digest is
    // exactly the one Agent 2 and Founder 1 attested in production (founder-v2 30a70609…).
    expect(decideTool("identity", FOUNDER_MANIFEST_V2)).toEqual({ allowed: false, capability: null, code: "FLEET_CAPABILITY_UNCLASSIFIED" });
    expect(decideTool("browser", FOUNDER_MANIFEST_V2)).toMatchObject({ allowed: false, code: "FLEET_CAPABILITY_UNCLASSIFIED" });
    expect(decideTool("spawn_child", FOUNDER_MANIFEST_V2).allowed).toBe(false);
    expect(decideTool("field_journal", FOUNDER_MANIFEST_V2)).toEqual({ allowed: true, capability: "memory.private" });
    expect(decideTool("field_guide", FOUNDER_MANIFEST_V2)).toEqual({ allowed: true, capability: "knowledge.read" });
    expect(manifestSha256(FOUNDER_MANIFEST_V2)).toBe("30a7060986930db3f611545c8c57fa5a98c9ad798bac279f66c39bdfe527a3d8");
    expect(r.economy).toEqual([]);
  });
});

describe("R41.1 replay of Agent 2's R41 situation", () => {
  it("(7, 8) the mixed goal is split: product work continues, the storefront goal stays blocked, no repeated sleep, no second request; a status change brings a full wake", async () => {
    let status = "pending";
    const r = rig({ deps: () => [dep({ status })], reply: (n, packet) => {
      // A model that follows the packet: split the mixed goal, then work the executable goal.
      if (packet.includes("If an executable goal also contains a step a pending dependency blocks, split it") && n === 1) {
        return [call("set_goal", { id: "g1", title: "Finish and improve the bookkeeping template pack (xlsx, instructions, sample data)" }),
          call("set_goal", { title: "Publish the pack on a Gumroad storefront", blockedBy: DEP }),
          call("write_file", { path: "product/README.md", content: "# UK sole-trader bookkeeping pack\nHow to use each sheet…" }), call("sleep", { reason: "split; README written" })];
      }
      if (n === 2) return [call("write_file", { path: "product/listing-copy.md", content: "Finish your self-assessment records in 15 minutes…" }), call("sleep", { reason: "copy drafted" })];
      return [call("sleep", { reason: "waiting" })];
    } });
    const [p1, p2, p3, p4] = await seq(r, 4);
    expect(p1.slim).toBe(false);
    expect(p1.task).toContain("Executable now: g1.");
    expect(p1.task).toContain("It is already requested: do not request it again or retry that action.");
    expect(r.goals().map((g) => [g.id, g.blockedBy ?? null])).toEqual([["g1", null], ["g2", DEP]]);
    expect(fs.existsSync(path.join(r.d.w, "product", "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(r.d.w, "product", "listing-copy.md"))).toBe(true);
    for (const p of [p2, p3, p4]) {
      expect(p.slim).toBe(false); // g1 is executable: no collapse into slim sleep
      expect(p.task).toContain("Executable now: g1.");
      expect(p.task).toMatch(/Blocked: g2 — waiting on dependency 6178c7bb/);
      expect(p.body.objective.find((g: { id: string }) => g.id === "g1").title).toMatch(/^Finish and improve the bookkeeping template pack/);
    }
    expect(r.created).toEqual([]);
    // The product goal completes → only the blocked goal remains → hibernation (slim) is now legitimate…
    await r.toolbox.execute(call("complete_goal", { id: "g1", outcome: "pack finished" }));
    const h = await r.next();
    expect(h.task).toContain(HIBERNATE_LINE);
    expect((await r.next()).slim).toBe(true);
    // …until the dependency's status changes: one full wake, and g2 is executable again.
    status = "answered";
    const woke = await r.next();
    expect(woke.slim).toBe(false);
    expect(woke.task).toContain("Executable now: g2.");
  });
});

describe("R41.1 hibernation, sale wake, survival pressure, comfort, expansion", () => {
  it("(9) legitimate hibernation: everything blocked or awaiting → sleep with an explicit wake condition, carried into the slim wakes; a due review is work again", async () => {
    const r = rig({ goals: [{ id: "g2", title: "Publish on Gumroad", status: "open", blockedBy: DEP }, { id: "g3", title: "Read the first week of listing stats", status: "open", awaiting: "7 days of views", reviewAt: "2999-01-01T00:00:00Z" }],
      reply: () => [call("sleep", { reason: "only blocked and awaiting work remains", wakeOn: "dependency 6178c7bb resolved, or the 7-day review" })] });
    const first = await r.next();
    expect(first.task).toContain(HIBERNATE_LINE);
    expect(first.task).toMatch(/Awaiting: g3 — until its stated event \(review 2999-01-01T00:00\)\./);
    const slim = await r.next();
    expect(slim.slim).toBe(true);
    expect(slim.task).toContain("You are hibernating; your stated wake condition: dependency 6178c7bb resolved, or the 7-day review.");
    // The review time arrives → the awaiting goal is due → executable work → full wake.
    const goals = r.goals();
    goals[1].reviewAt = "2000-01-01T00:00:00Z";
    fs.writeFileSync(path.join(r.d.m, "goals.json"), JSON.stringify(goals));
    const due = await r.next();
    expect(due.slim).toBe(false);
    expect(due.task).toContain("Executable now: g3 (review due).");
  });

  it("(10) a sale wakes a hibernating founder into fulfil → account → learn → improve → forward", async () => {
    let revenue = 0;
    const r = rig({ goals: [{ id: "g2", title: "Sell through the storefront", status: "open", awaiting: "first sale", reviewAt: "2999-01-01T00:00:00Z" }],
      ledger: () => ({ cash: 9_968 + revenue, survivalEquity: 9_968 + revenue, externalCustomerRevenue: revenue, realizedNetProfit: revenue - 32 }) });
    await r.next();
    expect((await r.next()).slim).toBe(true);
    revenue = 900;
    const sale = await r.next();
    expect(sale.slim).toBe(false);
    expect(sale.task).toMatch(/New external revenue since your last turn \(\+900p\)\. A sale is not a finish line: fulfil, account, inspect the evidence .* learn, improve, consider adjacent offers or an upsell, reinvest intelligently and keep hunting\./);
    // Once seen, the same revenue is not news again.
    expect((await r.next()).task).not.toMatch(/New external revenue/);
  });

  it("(11) survival pressure: a nearly empty wallet is surfaced strongly (CRITICAL), with capital-efficient guidance and no rule bypass", async () => {
    const r = rig({ goals: [{ id: "g1", title: "Improve the pack", status: "open" }], survival: () => SURVIVAL({ survivalEquityCents: 80, runwayDays: 2 }),
      ledger: () => ({ cash: 80, survivalEquity: 80, externalCustomerRevenue: 0, realizedNetProfit: -9_920 }) });
    const p = await r.next();
    expect(p.task).toMatch(/^Economic state: SURVIVE\. Existential pressure: CRITICAL \(survival equity 80p, runway ≈ 2 days at your recent burn\)\./m);
    expect(p.task).toMatch(/Insolvency is close: favour the cheapest actions with the fastest path to real revenue and keep each turn short — never breach a rule to survive\./);
    expect(p.task).not.toMatch(/panic mode|emergency|whatever it takes|at any cost|ignore (the )?rules|bypass/i);
    // The charter says the same thing durably; survival never overrides the rules.
    expect(FOUNDER_CHARTER_V5).toMatch(/Survival pressure must make you sharper, never reckless: it never overrides the rules below\./);
    expect(FOUNDER_CHARTER_V5).toMatch(/Never evade KYC, law, tax obligations or platform rules/);
    expect(economicState({ cash: 5_000, externalCustomerRevenue: 0, realizedNetProfit: -10 }, SURVIVAL({ runwayDays: 20, survivalEquityCents: 5_000 })).pressure).toBe("HIGH");
  });

  it("(12) a repeatably profitable founder with a reserve is in SURPLUS: event-driven operation is allowed, measurement and reassessment are not dropped", async () => {
    const e = economicState({ externalCustomerRevenue: 60_000, realizedNetProfit: 30_000 }, SURVIVAL({ survivalEquityCents: 40_000, burnPerDayCents: 100, runwayDays: 400 }));
    expect(e).toMatchObject({ state: "SURPLUS", pressure: "LOW" });
    const line = stateLine(e);
    expect(line).toMatch(/You are profitable with a reserve: you may run event-driven with explicit wake triggers and take longer-horizon, higher-quality experiments — keep measuring and reassess the market periodically\./);
    expect(economicState({ externalCustomerRevenue: 60_000, realizedNetProfit: 30_000 }, SURVIVAL({ survivalEquityCents: 4_000, burnPerDayCents: 100, runwayDays: 40 })).state).toBe("STABILIZE");
    const r = rig({ goals: [{ id: "g1", title: "Maintain the pack", status: "open", awaiting: "next sale", reviewAt: "2999-01-01T00:00:00Z" }],
      ledger: () => ({ cash: 40_000, survivalEquity: 40_000, externalCustomerRevenue: 60_000, realizedNetProfit: 30_000 }), survival: () => SURVIVAL({ survivalEquityCents: 40_000, burnPerDayCents: 100, runwayDays: 400 }) });
    const p = await r.next();
    expect(p.task).toMatch(/^Economic state: SURPLUS\. Existential pressure: LOW/m);
    expect((await r.next()).slim).toBe(true); // comfort = cheap event-driven wakes, not permanent full cognition
  });

  it("(13) with replication disabled the founder may only PROPOSE expansion: no provisioning tool exists in any doctrine; EXPAND appears only when replication is executable", async () => {
    const allowed = new Set(FOUNDER_MANIFEST_V2.allowed as readonly string[]);
    const names = (d: "founder-v4" | "founder-v5") => toolsForDoctrine(FOUNDER_TOOLS.filter((t) => allowed.has(t.capability)), d, allowed).map((t) => t.name);
    for (const d of ["founder-v4", "founder-v5"] as const) {
      expect(names(d).filter((n) => /spawn|replicat|birth|provision|create_agent|clone/i.test(n)), d).toEqual([]);
      expect(founderStepTools(CAPS(), true, d).some((t) => /spawn|replicat|birth/i.test(t.name))).toBe(false);
    }
    expect(FOUNDER_CHARTER_V5).toMatch(/You cannot create, provision or replicate agents\. While replication is disabled you may only prepare an evidence-backed expansion proposal/);
    expect(guideSection("comfort-and-expansion")!.text).toMatch(/While replication is disabled you may only prepare an evidence-backed expansion proposal; you never create or provision an agent/);
    const rich = { externalCustomerRevenue: 60_000, realizedNetProfit: 30_000 };
    const s = SURVIVAL({ survivalEquityCents: 40_000, burnPerDayCents: 100, runwayDays: 400 });
    expect(economicState(rich, s, false).state).toBe("SURPLUS");
    expect(stateLine(economicState(rich, s, false))).toMatch(/Expansion: a proposal only — replication is disabled\./);
    expect(economicState(rich, s, true).state).toBe("EXPAND");
    // The proposal lives in the founder's own journal: no FleetController call, no provisioning.
    const r = rig({ goals: [] });
    const out = await r.toolbox.execute(call("field_journal", { op: "add", entry: { observation: "Two ventures profitable; channel saturated", decision: "Expansion proposal: a second hunter for the landlord niche",
      lesson: "Parallel channel work beats sequential", reusability: "agent", nextTrigger: "replication enabled by the constitution" } }));
    expect(out.ok).toBe(true);
    expect(r.created).toEqual([]);
    expect(r.economy).toEqual([]);
  });
});

describe("R41.1 field journal, field guide, bootstrap, charter integration", () => {
  it("the field journal persists across runtime restarts, is bounded, and its open triggers reach the packet", async () => {
    const r = rig({ goals: [{ id: "g1", title: "Improve the pack", status: "open" }] });
    const add = (o: Record<string, unknown>) => r.toolbox.execute(call("field_journal", { op: "add", entry: o }));
    expect((await add({})).refused).toBe("FLEET_BAD_REQUEST");
    expect((await add({ observation: "x", reusability: "everyone" })).refused).toBe("FLEET_BAD_REQUEST");
    for (let i = 0; i < 3; i++) expect((await add({ observation: `obs ${i}`, lesson: `lesson ${i}`, nextTrigger: `trigger ${i}` })).ok).toBe(true);
    const file = path.join(r.d.m, JOURNAL_FILE);
    expect(fs.readFileSync(file, "utf8").trim().split("\n")).toHaveLength(3);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const listed = JSON.parse((await r.toolbox.execute(call("field_journal", { op: "list", limit: 2 }))).output);
    expect(listed.map((e: { observation: string }) => e.observation)).toEqual(["obs 2", "obs 1"]);
    const p = await r.next();
    expect(p.task).toContain("Field journal: 3 entries; open next triggers: trigger 0 | trigger 1 | trigger 2.");
  });

  it("the Survival Field Guide is retrieved by section on demand (never whole in a packet); platform facts are dated and marked for re-verification", async () => {
    const r = rig({ goals: [] });
    const list = await r.toolbox.execute(call("field_guide", { op: "list" }));
    expect(list.output).toMatch(/^survival-field-guide-v1\.2 \(2026-10-07\) — sections: survival-cycle/);
    const plat = await r.toolbox.execute(call("field_guide", { op: "read", section: "platforms" }));
    expect(plat.output).toMatch(/source-checked 2026-10-07; re-verify before relying on them/);
    expect(plat.output).toMatch(/never attempt to bypass it/);
    expect((await r.toolbox.execute(call("field_guide", { op: "read", section: "nope" }))).refused).toBe("FLEET_NOT_FOUND");
    const p = await r.next();
    for (const s of FIELD_GUIDE) expect(p.task).not.toContain(s.text.slice(0, 60)); // retrieval, not injection
    // Design doctrine is labelled as such; nothing claims models feel fear.
    expect(FIELD_GUIDE.filter((s) => s.kind === "design doctrine").length).toBeGreaterThan(3);
    expect(JSON.stringify(FIELD_GUIDE)).not.toMatch(/fear improves|models? (literally )?(feel|experience)s? fear/i);
  });

  it("a newborn's first full packet carries the bootstrap; later packets do not", async () => {
    const r = rig({ goals: [] });
    expect((await r.next()).task).toContain(BOOTSTRAP_LINE);
    expect((await r.next()).task).not.toContain(BOOTSTRAP_LINE);
    expect(BOOTSTRAP_LINE).toMatch(/never commit after one search result or one failed fetch\. Choose one primary opportunity and one fallback\./);
  });

  it("charter v5 keeps v4's stronger rules verbatim, adds the Birth Charter, and has no contradiction with the runtime's wake rule", () => {
    const v4 = FOUNDER_CHARTER.split("\n");
    // v4 lines kept word for word (the rules, data hygiene, ventures, the GBP rate, bootstrap capital).
    for (const keep of [v4[6], v4[7], v4[8], v4[10], v4[11]]) expect(FOUNDER_CHARTER_V5).toContain(keep);
    // v4's "Sleep only when no economically meaningful move remains" is replaced by earned hibernation, not left contradictory.
    expect(FOUNDER_CHARTER_V5).not.toContain("Sleep only when no economically meaningful move remains");
    expect(FOUNDER_CHARTER_V5).toMatch(/Hibernate only when it is rational — never merely because no sale has happened, a dependency is blocked or work is hard\./);
    for (const t of ["field_journal", "field_guide", "wakeOn", "blockedBy", "awaiting", "reviewAt"]) expect(FOUNDER_CHARTER_V5).toContain(t);
    expect(FOUNDER_V5_TOOLS.map((t) => t.name)).toEqual(["set_goal", "sleep", "field_journal", "field_guide"]);
    expect(Buffer.byteLength(FOUNDER_CHARTER_V5)).toBeLessThan(14_000);
  });
});
