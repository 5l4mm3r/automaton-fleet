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
import { FounderToolbox, JOURNAL_ARCHIVE_FILE, JOURNAL_FILE, JOURNAL_INDEX_FILE, readJournal, sameAction } from "../../fleet/founder/toolbox.js";
import { LoopGuard, SCOPED_CONTINUE } from "../../fleet/founder/loop-guard.js";
import { ASSESS_LINE, HIBERNATE_LINE, BOOTSTRAP_LINE, classifyWork, economicState, stateLine, type SurvivalView } from "../../fleet/founder/decisions.js";
import { FIELD_GUIDE, OWNER_SELECTED_TITLES, READING_COLLECTION, guideSection, releaseDoctrines } from "../../fleet/founder/field-guide.js";
import { FOUNDER_MANIFEST_V2, TOOL_CAPABILITIES, decideTool, manifestSha256 } from "../../fleet/capabilities.js";
import { FOUNDER_CHARTER, FOUNDER_CHARTER_V5, FOUNDER_EXPERIMENT_TOOLS, FOUNDER_ROUTED_TOOLS, FOUNDER_TOOLS, FOUNDER_V5_TOOLS, toolsForDoctrine, type ToolCall } from "../../fleet/cognition/types.js";
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
  it("(1) a pending dependency + an executable open goal → full packets that name the executable work; an undeclared sleep gets an assessment push before any slim wake", async () => {
    const r = rig({ goals: [{ id: "g1", title: "Improve the template pack and its launch material", status: "open" }, { id: "g2", title: "Publish the pack on Gumroad", status: "open", blockedBy: DEP }] });
    const ps = await seq(r, 8); // the founder sleeps every turn without declaring hibernation
    // Owner 2026-10-08: hibernation is the founder's judgement, not a goal-count rule — after the assessment push the
    // ordinary bounded schedule applies (re-check after 4 slim wakes).
    expect(ps.map((p) => p.slim)).toEqual([false, false, true, true, true, true, false, true]);
    expect(ps[1].task).toContain(ASSESS_LINE);
    for (const p of ps.filter((x) => !x.slim)) {
      expect(p.task).toContain("Executable now: g1.");
      expect(p.task).toMatch(/Blocked: g2 — waiting on dependency 6178c7bb \(pending\)\. Already requested: do not request it again and do not retry the blocked action\. It blocks only this goal\./);
      expect(p.body.objective.map((g: { id: string; title: string }) => [g.id, g.title])).toEqual([["g1", "Improve the template pack and its launch material"], ["g2", "Publish the pack on Gumroad"]]);
    }
    expect(ps[1].task).toMatch(/^Idle wake: your open goals are your execution path \(g1 "Improve the template pack/m); // the push names the executable goal, not the blocked one
    expect(ps[6].task).toMatch(/^Idle wake: your open goals are your execution path \(g1 "Improve the template pack/m);
    expect(r.created).toEqual([]);
  });

  it("(2, amended) every open goal blocked + no decision: the packet asks for the hibernation judgement; a DECLARED hibernation gets slim wakes with the backed-off re-check (4, 8, 16, 32)", async () => {
    const r = rig({ goals: [{ id: "g2", title: "Publish the pack on Gumroad", status: "open", blockedBy: DEP }],
      reply: (n) => [call("sleep", { reason: "pack finished; only the Gumroad listing remains and it waits on the KYC dependency", wakeOn: "dependency 6178c7bb resolved" }, `h${n}`)] });
    const first = await r.next();
    expect(first.slim).toBe(false);
    expect(first.task).toContain(HIBERNATE_LINE);
    const ps = await seq(r, 31);
    const full = ps.map((p, i) => (p.slim ? -1 : i + 1)).filter((i) => i > 0);
    expect(full).toEqual([5, 14, 31]); // after 4, 8 and 16 slim wakes: the same bounded schedule as before
    expect(r.mind.routing.idleNudges.hibernate).toBe(3);
    for (const i of full) {
      expect(ps[i - 1].task).toMatch(/Hibernation re-check: you chose to wait \("pack finished; only the Gumroad listing remains .*"\), to be woken by: dependency 6178c7bb resolved\. Nothing material has changed since\./);
      expect(ps[i - 1].task).toContain(HIBERNATE_LINE);
    }
    expect(ps[0].task).toContain("You are hibernating; your stated wake condition: dependency 6178c7bb resolved.");
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
    // (R41.1 classified identity/browser/fleet_services; an unknown tool is still unclassified and refused before anything runs.)
    const create = call("hidden_payment_tool", { op: "create_account", args: { provider: "payhip" } }, "same-id");
    const first = await r.toolbox.execute(create);
    expect(first).toMatchObject({ ok: false, refused: "FLEET_CAPABILITY_UNCLASSIFIED" });
    expect(first.output).toContain("(tool hidden_payment_tool) is not available to this founder.");
    expect(first.output).toContain(SCOPED_CONTINUE);
    const second = await r.toolbox.execute({ ...create, id: "same-id-2" });
    expect(second).toMatchObject({ ok: false, refused: "FLEET_DUPLICATE_FAILED_ACTION" });
    expect(second.output).toContain(SCOPED_CONTINUE);
    expect(SCOPED_CONTINUE).toMatch(/blocks only this one action — not you, your other goals or your venture\. Do not retry the identical action\./);
    // Underlying behaviour unchanged: the same decisions, nothing reached FleetController, and the pinned manifest digest is
    // exactly the one Agent 2 and Founder 1 attested in production (founder-v2 30a70609…).
    expect(decideTool("hidden_payment_tool", FOUNDER_MANIFEST_V2)).toEqual({ allowed: false, capability: null, code: "FLEET_CAPABILITY_UNCLASSIFIED" });
    expect(decideTool("identity", FOUNDER_MANIFEST_V2)).toEqual({ allowed: true, capability: "planning" });
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
      // Only the blocked storefront goal left: the founder judges waiting worthwhile and declares it.
      if (packet.includes(HIBERNATE_LINE)) return [call("sleep", { reason: "pack built, copy written; only the storefront waits on KYC", wakeOn: "dependency 6178c7bb resolved" })];
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
      ledger: () => ({ cash: 9_968 + revenue, survivalEquity: 9_968 + revenue, externalCustomerRevenue: revenue, realizedNetProfit: revenue - 32 }),
      reply: (n) => [call("sleep", { reason: "listing live and promoted; waiting for buyers", wakeOn: "a sale or a buyer reply" }, `s${n}`)] });
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
      ledger: () => ({ cash: 40_000, survivalEquity: 40_000, externalCustomerRevenue: 60_000, realizedNetProfit: 30_000 }), survival: () => SURVIVAL({ survivalEquityCents: 40_000, burnPerDayCents: 100, runwayDays: 400 }),
      reply: (n) => [call("sleep", { reason: "venture repeatable and profitable; nothing to improve before the next sales data", wakeOn: "the next sale", reviewAt: "2999-01-01T00:00:00Z" }, `p${n}`)] });
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
    expect(p.task).toContain("Field journal: 3 entries, 3 consolidated lesson(s) (field_journal op lessons); open next triggers: trigger 0 | trigger 1 | trigger 2.");
  });

  it("journal beyond the 500-entry window: evicted entries are archived (never deleted), lessons and unresolved triggers are consolidated and survive, triggers can be resolved, the archive rotates", async () => {
    const r = rig({ goals: [] });
    const add = (o: Record<string, unknown>) => r.toolbox.execute(call("field_journal", { op: "add", entry: o }));
    expect((await add({ observation: "first week", lesson: "Etsy blocks fetches", nextTrigger: "marketplace API access" })).ok).toBe(true);
    for (let i = 1; i < 520; i++) await add({ observation: `obs ${i}`, ...(i % 100 === 0 ? { lesson: "Etsy blocks fetches" } : {}), ...(i === 7 ? { nextTrigger: "Gumroad KYC done" } : {}) });
    const window = readJournal(r.d.m);
    expect(window).toHaveLength(500);
    expect(window[0].observation).toBe("obs 20");
    const archived = fs.readFileSync(path.join(r.d.m, JOURNAL_ARCHIVE_FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l).observation);
    expect(archived).toEqual(["first week", ...Array.from({ length: 19 }, (_, i) => `obs ${i + 1}`)]); // exactly the evicted entries, in order
    const lessons = JSON.parse((await r.toolbox.execute(call("field_journal", { op: "lessons" }))).output);
    expect(lessons.lessons).toEqual([expect.objectContaining({ lesson: "Etsy blocks fetches", count: 6 })]); // the first one left the window; the lesson did not
    expect(lessons.openTriggers.map((t: { trigger: string }) => t.trigger)).toEqual(["marketplace API access", "Gumroad KYC done"]);
    expect(lessons.archivedEntries).toBe(20);
    expect((await r.toolbox.execute(call("field_journal", { op: "resolve", trigger: "marketplace api access" }))).ok).toBe(true);
    expect((await add({ observation: "KYC completed by the owner", resolves: "Gumroad KYC done" })).ok).toBe(true);
    expect(JSON.parse((await r.toolbox.execute(call("field_journal", { op: "lessons" }))).output).openTriggers).toEqual([]);
    expect((await r.toolbox.execute(call("field_journal", { op: "resolve", trigger: "nothing" }))).refused).toBe("FLEET_NOT_FOUND");
    // Rotation: a full archive is renamed, never truncated.
    fs.appendFileSync(path.join(r.d.m, JOURNAL_ARCHIVE_FILE), "x".repeat(4 * 1024 * 1024) + "\n");
    await add({ observation: "after rotation" });
    expect(fs.existsSync(path.join(r.d.m, "field-journal-archive.1.jsonl"))).toBe(true);
    expect(fs.readFileSync(path.join(r.d.m, JOURNAL_ARCHIVE_FILE), "utf8").trim().split("\n")).toHaveLength(1);
    for (const f of [JOURNAL_ARCHIVE_FILE, JOURNAL_INDEX_FILE, "field-journal-archive.1.jsonl"]) expect(fs.statSync(path.join(r.d.m, f)).mode & 0o777, f).toBe(0o600);
    const p = await r.next();
    expect(p.task).toMatch(/Field journal: 500 entries \(\+22 archived\), 1 consolidated lesson\(s\) \(field_journal op lessons\)\./);
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
    expect(FOUNDER_CHARTER_V5).toMatch(/Hibernation is your own judgement that waiting is the better use of capital — worthwhile immediate work is exhausted, or a sufficiently prepared foundation and real marketing effort need time to produce results — never merely because no sale has happened, a dependency is blocked or work is hard\./);
    expect(FOUNDER_CHARTER_V5).toContain("An empty goal list is not proof there is nothing to do");
    for (const t of ["field_journal", "field_guide", "wakeOn", "blockedBy", "awaiting", "reviewAt"]) expect(FOUNDER_CHARTER_V5).toContain(t);
    expect(FOUNDER_V5_TOOLS.map((t) => t.name)).toEqual(["set_goal", "sleep", "field_journal", "field_guide"]);
    expect(Buffer.byteLength(FOUNDER_CHARTER_V5)).toBeLessThan(14_000);
  });
});

// ─────────────────────────────────────────────── R41.1 completion: owner clarifications of 2026-10-08 (supplemental)

describe("R41.1 completion — supplemental acceptance (owner clarifications 2026-10-08)", () => {
  it("S1: empty goals → assessment and purposeful action, never vacuous automatic sleep; a completed assessment that supports waiting is respected", async () => {
    // The newborn with nothing recorded gets the bootstrap and the opportunity cycle, then acts.
    const actor = rig({ goals: [], reply: (n) => n === 1 ? [call("open_decision", { key: "first-hunt", purpose: "find_opportunity", objective: "First paying customer within 30 days",
      question: "Which of three materially different offers has reachable demand?", hypothesis: "A narrow template beats a broad course", options: ["template", "mini-course", "fixed-scope service"],
      stopAfterFetches: 3, stopWhen: "two independent purchase signals" }), call("sleep", { reason: "decision opened" })] : undefined });
    const p1 = await actor.next();
    expect(p1.slim).toBe(false);
    expect(p1.task).toContain(BOOTSTRAP_LINE);
    expect(p1.task).toMatch(/No open decision and no execution path\. Run ONE concise opportunity-identification cycle/);
    expect((await actor.next()).task).toMatch(/Open decision first-hunt/); // the hunt continues from its own decision, not a slim sleep
    // A founder that sleeps without assessing is pushed to assess once before any slim wake.
    const idle = rig({ goals: [] });
    const [a, b, c] = await seq(idle, 3);
    expect([a.slim, b.slim, c.slim]).toEqual([false, false, true]);
    expect(b.task).toContain(ASSESS_LINE);
    expect(ASSESS_LINE).toContain("an empty goal list is not proof there is nothing to do");
    // An assessment that supports waiting (declared) is respected at once: no new venture is demanded.
    const waiter = rig({ goals: [], reply: (n) => [call("sleep", { reason: "assessed: tried three offers, none had reachable demand this week; waiting for the next marketplace data", reviewAt: "2999-01-01T00:00:00Z" }, `w${n}`)] });
    const [w1, w2] = await seq(waiter, 2);
    expect([w1.slim, w2.slim]).toEqual([false, true]);
    expect(w2.task).toContain("You are hibernating; your stated wake condition: review at 2999-01-01T00:00:00.000Z.");
  });

  it("S1b: repeated UNDECLARED sleep can never settle into indefinite automatic inactivity — at most 10 slim wakes between full assessment pushes; a DECLARED hibernation may back off to 32", async () => {
    const streaks = async (reply?: (n: number) => ToolCall[]) => {
      const r = rig({ goals: [], reply });
      const ps = await seq(r, 200);
      let longest = 0, cur = 0;
      for (const p of ps) { cur = p.slim ? cur + 1 : 0; longest = Math.max(longest, cur); }
      return { ps, longest };
    };
    const undeclared = await streaks();
    expect(undeclared.longest).toBe(10);
    const pushes = undeclared.ps.slice(1).filter((p) => !p.slim);
    expect(pushes.length).toBeGreaterThanOrEqual(17);
    for (const p of pushes) expect(p.task).toContain(ASSESS_LINE); // every re-check demands the assessment again
    expect(pushes.at(-1)!.task).toMatch(/You have now rested \d+ time\(s\) in this state without declaring hibernation\./);
    const declared = await streaks((n) => [call("sleep", { reason: "foundation built; waiting for results", wakeOn: "a sale" }, `d${n}`)]);
    expect(declared.longest).toBe(32);
  });

  it("S2: a prepared foundation and real marketing effort with a genuine measurement window support economical hibernation — no blocked goal needed; the review time wakes it", async () => {
    const r = rig({ goals: [] , reply: (n) => [call("sleep", { reason: "product live, listing optimised, three community posts and one outreach batch done; results need a week", wakeOn: "a sale, a reply or a listing-views change", reviewAt: "2999-01-01T00:00:00Z" }, `m${n}`)] });
    fs.writeFileSync(path.join(r.d.m, "goals.json"), JSON.stringify([{ id: "g1", title: "Launch the pack", status: "complete" }, { id: "g2", title: "First marketing batch", status: "complete" }]));
    const [f, s1, s2] = await seq(r, 3);
    expect(f.slim).toBe(false);
    expect([s1.slim, s2.slim]).toEqual([true, true]); // waiting is cheaper than looking busy
    // The scheduled review arrives: the next wake is full and says what to do — inspect what changed.
    const c = JSON.parse(fs.readFileSync(path.join(r.d.s, "mind-continuity.json"), "utf8"));
    c.reviewAt = "2000-01-01T00:00:00.000Z";
    fs.writeFileSync(path.join(r.d.s, "mind-continuity.json"), JSON.stringify(c));
    const review = await r.next();
    expect(review.slim).toBe(false);
    expect(review.task).toContain("Your scheduled review time (2000-01-01T00:00:00.000Z) has come: inspect what changed and choose the next useful action.");
  });

  it("S2b: a hibernation declared at the end of a WORKING turn is recorded; a later plain sleep-only turn keeps it; a working turn ending in a plain sleep clears it", async () => {
    const r = rig({ goals: [], reply: (n) => n === 1
      ? [call("write_file", { path: "product/faq.md", content: "FAQ" }), call("sleep", { reason: "FAQ done; launch prepared", wakeOn: "a sale or a reply" })]
      : n === 4 ? [call("write_file", { path: "product/faq.md", content: "FAQ v2" }), call("sleep", { reason: "small fix" })]
      : [call("sleep", { reason: "still waiting" })] });
    const cont = () => JSON.parse(fs.readFileSync(path.join(r.d.s, "mind-continuity.json"), "utf8"));
    await r.next();
    expect(cont().wakeOn).toBe("a sale or a reply");
    const [p2, p3] = await seq(r, 2);
    expect(p2.slim).toBe(false); // the working turn changed the workspace: one full look
    expect(p3.slim).toBe(true); // nothing changed since and the declaration stands
    expect(cont().wakeOn).toBe("a sale or a reply");
    await r.next(); // n === 4 — a working turn that ends in a plain sleep
    expect(cont().wakeOn).toBeUndefined();
  });

  it("S5: meaningful wake events prompt re-evaluation (dependency change, sale, due review); no material change keeps the economical wait", async () => {
    let status = "pending";
    let revenue = 0;
    const r = rig({ goals: [{ id: "g2", title: "Publish on Gumroad", status: "open", blockedBy: DEP }], deps: () => [dep({ status })],
      ledger: () => ({ cash: 9_968 + revenue, survivalEquity: 9_968 + revenue, externalCustomerRevenue: revenue, realizedNetProfit: revenue - 32 }),
      reply: (n) => [call("sleep", { reason: "waiting on KYC", wakeOn: "dependency resolved or a sale" }, `e${n}`)] });
    await r.next();
    expect((await seq(r, 3)).map((p) => p.slim)).toEqual([true, true, true]); // nothing material changed
    revenue = 500;
    expect((await r.next()).task).toMatch(/New external revenue since your last turn \(\+500p\)/);
    expect((await r.next()).slim).toBe(true); // back to waiting once the change was seen
    status = "answered";
    const woke = await r.next();
    expect(woke.slim).toBe(false);
    expect(woke.task).toContain("Executable now: g2.");
  });

  it("S8: journal continuity and knowledge reuse survive a runtime restart; the bootstrap is a newborn's only", async () => {
    const r = rig({ goals: [{ id: "g1", title: "Improve the pack", status: "open" }] });
    expect((await r.next()).task).toContain(BOOTSTRAP_LINE);
    expect((await r.toolbox.execute(call("field_journal", { op: "add", entry: { observation: "Etsy blocks fetches (403)", lesson: "use marketplace search pages that allow fetching", reusability: "candidate_fleet", nextTrigger: "next demand check" } }))).ok).toBe(true);
    // A new runtime process on the same state (a restart or an upgrade keeps the memory directory).
    const ports = (r.mind as unknown as { o: ConstructorParameters<typeof FounderMind>[0] }).o;
    const reborn = new FounderMind(ports);
    let packet = "";
    const infer = ports.ports.infer;
    ports.ports.infer = async (m, w, route, d) => { packet = String((m as Array<{ content: string }>)[0].content); return infer(m, w, route, d); };
    for (let i = 0; i <= MAX_IDLE_SKIP + 1 && !packet; i++) await reborn.turn(`after restart ${i}`);
    expect(packet).toContain("Field journal: 1 entry, 1 consolidated lesson(s) (field_journal op lessons); open next triggers: next demand check.");
    expect(packet).not.toContain(BOOTSTRAP_LINE);
    // Reuse/promotion goes through the existing Fleet knowledge path (the founder's own tool), never automatically.
    expect(BOOTSTRAP_LINE).toMatch(/inspect existing Fleet knowledge \(economic_knowledge, read_knowledge\)/);
    expect(guideSection("journal")!.text).toMatch(/Promotion rule: never turn one anecdote into Fleet doctrine/);
  });

  it("S9: study is optional — the reading collection is retrievable with provenance and licence, nothing forces reading, and a declared hibernation is not interrupted by study", async () => {
    const r = rig({ goals: [], reply: (n) => [call("sleep", { reason: "nothing worth doing until the review", reviewAt: "2999-01-01T00:00:00Z" }, `q${n}`)] });
    const lib = await r.toolbox.execute(call("field_guide", { op: "library", topic: "pricing" }));
    expect(lib.ok).toBe(true);
    expect(lib.output).toMatch(/study is optional — read only when it pays for a current decision; owner-selected books: none supplied yet/);
    expect(lib.output).toMatch(/openstax-marketing: "Principles of Marketing" \(OpenStax \(Rice University\), 2023-01-25; durable principles; CC BY-NC-SA — free to read; do not copy into products\)/);
    expect(READING_COLLECTION.every((s) => /^https?:\/\//.test(s.url) && s.licence && s.edition && s.topics.length)).toBe(true);
    expect(READING_COLLECTION.filter((s) => s.kind === "dated platform/legal facts").every((s) => /re-check/.test(s.note))).toBe(true);
    expect(OWNER_SELECTED_TITLES).toEqual([]); // none supplied: nothing invented
    const ps = await seq(r, 4);
    expect(ps.slice(1).every((p) => p.slim)).toBe(true);
    for (const p of ps) expect(p.task).not.toMatch(/must (read|study)|read .* before you sleep|daily reading/i);
    expect(FOUNDER_CHARTER_V5).toMatch(/Study \(the guide's reading collection\) only when its expected value for a current decision or capability justifies its cognition cost\./);
  });

  it("S10: the v5 tools dispatch end to end in the runtime (guide library, journal, sleep with reviewAt); malformed inputs are refused", async () => {
    const r = rig({ goals: [] });
    expect((await r.toolbox.execute(call("sleep", { reason: "x", reviewAt: "soon" }))).refused).toBe("FLEET_BAD_REQUEST");
    expect((await r.toolbox.execute(call("sleep", { reason: "x", reviewAt: "2999-01-01T00:00:00Z" }))).output).toBe("hibernating; review at 2999-01-01T00:00:00.000Z");
    expect((await r.toolbox.execute(call("sleep", { reason: "x" }))).output).toBe("sleeping");
    expect((await r.toolbox.execute(call("field_guide", { op: "read", section: "risk-tiers" }))).output).toMatch(/Judge the actual venture: a digital product or course is not safe merely because of its format/);
    expect((await r.toolbox.execute(call("field_guide", { op: "read", section: "assessment" }))).output).toMatch(/An empty goal list is not proof there is nothing to do/);
    expect((await r.toolbox.execute(call("field_guide", { op: "nope" }))).refused).toBe("FLEET_BAD_REQUEST");
    // Every tool the v5 gateway can offer is implemented by this runtime and classified under founder-v2.
    const allowed = new Set(FOUNDER_MANIFEST_V2.allowed as readonly string[]);
    for (const t of FOUNDER_V5_TOOLS) expect(decideTool(t.name, FOUNDER_MANIFEST_V2), t.name).toEqual({ allowed: true, capability: t.capability });
    expect([...allowed]).toEqual(expect.arrayContaining(FOUNDER_V5_TOOLS.map((t) => t.capability)));
  });

  it("doctrine compatibility marker: a release implements founder-v5 only when its tree carries the v5 runtime module", () => {
    const root = tmp();
    const v5 = "a".repeat(40), v4 = "b".repeat(40);
    fs.mkdirSync(path.join(root, v5, "src/fleet/founder"), { recursive: true });
    fs.writeFileSync(path.join(root, v5, "src/fleet/founder/field-guide.ts"), "x");
    fs.mkdirSync(path.join(root, v4, "src/fleet/founder"), { recursive: true });
    const d = releaseDoctrines(root, (p) => fs.existsSync(p));
    expect(d(v5)).toEqual(["founder-v4", "founder-v5"]);
    expect(d(v4)).toEqual(["founder-v4"]);
    expect(d(null)).toEqual(["founder-v4"]);
    expect(d("../../etc")).toEqual(["founder-v4"]); // a commit is 40 hex characters, never a path
  });

  it("classification drift guard: every advertised founder tool is classified with exactly its advertised class (the identity/browser/fleet_services gap is closed)", () => {
    const advertised = [...FOUNDER_TOOLS, ...FOUNDER_V5_TOOLS, ...FOUNDER_ROUTED_TOOLS, ...FOUNDER_EXPERIMENT_TOOLS];
    const routedLocal = new Set(["routine_task", "escalate_question"]); // answered by the mind itself, never by the toolbox
    const unclassified = [...new Set(advertised.filter((t) => !routedLocal.has(t.name) && !(t.name in TOOL_CAPABILITIES)).map((t) => t.name))].sort();
    expect(unclassified).toEqual([]);
    for (const t of advertised) if (t.name in TOOL_CAPABILITIES) expect(TOOL_CAPABILITIES[t.name], t.name).toBe(t.capability);
  });
});
