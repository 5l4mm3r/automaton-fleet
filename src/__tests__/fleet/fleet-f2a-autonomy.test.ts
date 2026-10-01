/**
 * F2 Phase A — autonomy doctrine in the founder loop (founder side; no database, no model).
 *
 * Founder 1 slept for days waiting on an owner decision about Gumroad: the system had taught it to wait. F2-A makes the
 * founder an autonomous economic actor: an external dependency makes ONE action unavailable (never the founder, a goal
 * or other work), nothing escalates toward the owner over time, and an idle wake with a controller-granted discovery
 * allowance becomes autonomous opportunity discovery instead of sleep. These tests drive the production FounderMind,
 * FounderToolbox and charter/tool text with scripted cognition. (Registry side: fleet-f2a-pg.test.ts.)
 */
import { describe, it, expect } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import {
  FounderMind, MAX_IDLE_SKIP, dependencyLines, discoveryTask, parseDependencies, parseDiscovery, slimWakePacket, type DiscoveryAllowance, type MindPorts,
} from "../../fleet/founder/mind.js";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { FOUNDER_MANIFEST_V2, decideTool, manifestSha256 } from "../../fleet/capabilities.js";
import {
  FOUNDER_CHARTER, FOUNDER_CHARTER_V2, FOUNDER_CHARTER_VERSION, FOUNDER_EXPERIMENT_TOOLS, FOUNDER_ROUTED_ADDENDUM, FOUNDER_ROUTED_TOOLS, FOUNDER_TOOLS, type ToolCall,
} from "../../fleet/cognition/types.js";
import { PACKET_POLICY, buildTaskPacket, taskPacketProblems } from "../../fleet/cognition/task-packet.js";
import { capabilityView } from "../../fleet/cognition/capability-signature.js";
import { V26_SQL } from "../../fleet/postgres/migrations-phase26.js";
import { FLEET_PG_SCHEMA_VERSION, PG_MIGRATIONS } from "../../fleet/postgres/migrations.js";
import { loadFleetConfig } from "../../fleet/config.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "f2a-"));
const GUMROAD = "62cbe1b7-8642-4bf4-a6a7-b41c1dcc09e3";
const GUMROAD_ACTION = "List the landlord compliance tracker on Gumroad (a Gumroad seller account needs a human identity/KYC)";
const EXCEPTION_KINDS = ["human_identity", "kyc", "legal_signature", "constitutional_change", "non_delegable_credential"];
const CAPS = (o: Record<string, unknown> = {}) => ({ ok: true, origin: "genesis_founder", manifestId: "founder-v2", manifestSha256: manifestSha256(FOUNDER_MANIFEST_V2),
  allowed: [...FOUNDER_MANIFEST_V2.allowed], reproductionExecutable: false, paymentExecutable: false, experimentsEnabled: true,
  experimentFinancialMode: "simulated", experimentHardCapMinor: 5000, experimentMaxActive: 3, ownerRequests: true, ...o });
/** The v26 registry's view of Founder 1's Gumroad record after the migration (still unresolved; nobody decided it). */
const gumroadDep = (o: Record<string, unknown> = {}) => ({ requestId: GUMROAD, kind: "kyc", action: GUMROAD_ACTION, blocksAction: true, goalRef: "g1",
  title: "Owner request: enrol a Gumroad channel for zero-capex digital products", status: "pending", response: null, ageS: 5 * 86_400,
  category: "sales_channel", blocking: false, stale: false, ...o });
const ALLOWED: DiscoveryAllowance = { allowed: true, budgetCents: 183, spentTodayCents: 12, runwayDays: 210.4, reason: "allowed" };

/** Founder-facing words that teach dependency on the owner (F2 design §3/§17). Constitutional items are not founder text. */
const OWNER_DEPENDENCY = /owner decides|owner approv|the owner can enable|ask the owner|awaiting (the )?owner|owner-enrolled|keep waiting|STALE|policy and the owner|decision only the owner/i;

describe("F2-A charter v3 and founder-facing text", () => {
  it("charter v3 states the autonomy doctrine: autonomous actor, FleetController is the bank, the owner is not an operational approver", () => {
    expect(FOUNDER_CHARTER_VERSION).toBe("founder-charter-v3");
    expect(FOUNDER_CHARTER).toMatch(/an autonomous economic actor\. Your purpose is to stay alive economically/);
    expect(FOUNDER_CHARTER).toMatch(/no one approves your business choices: you choose niches, products, services, channels, marketing, experiments, pivots and new ventures yourself/);
    expect(FOUNDER_CHARTER).toMatch(/FleetController is your bank: it decides spending and capital by policy/);
    expect(FOUNDER_CHARTER).toMatch(/The owner maintains the fleet, is not your manager and is not consulted on ordinary business/);
    expect(FOUNDER_CHARTER).toMatch(/survive → discover → research → select → build → distribute → market → sell → earn → pay costs → retain capital → contribute to the fleet treasury → reinvest → expand → repeat/);
    expect(FOUNDER_CHARTER).toMatch(/A blocked dependency blocks only that one action, never you/);
    expect(FOUNDER_CHARTER).toMatch(/direct sales needing no new account/);
    expect(FOUNDER_CHARTER).toMatch(/never idle by default/);
    expect(FOUNDER_CHARTER).toMatch(/discovery allowance/);
    // The hard rules are unchanged (no new authority), and the length stays bounded (every token is paid on every call).
    expect(FOUNDER_CHARTER).toMatch(/you cannot hold keys, sign, pay, transfer value, create sandboxes, modify your own code, install tools or reproduce/);
    expect(FOUNDER_CHARTER).toMatch(/Researching a market is not permission to trade it/);
    expect(FOUNDER_CHARTER.length).toBeLessThan(4_000);
    // v2 is frozen, byte for byte, for the sealed evaluations (its sha is an input of their pre-registration hashes).
    expect(crypto.createHash("sha256").update(FOUNDER_CHARTER_V2).digest("hex")).toBe("c111db2cc10d7bd4dd7d01de5139c1a7b033d5ba58b3e32eae02f9d787a8354e");
    expect(FOUNDER_CHARTER_V2).toMatch(/all spending is a structured request that policy and the owner decide/);
  });

  it("no founder-facing text teaches owner dependency (lint): charter, addendum, every tool, packet policy, dependency and discovery lines", () => {
    const texts: Array<[string, string]> = [
      ["charter", FOUNDER_CHARTER], ["routed addendum", FOUNDER_ROUTED_ADDENDUM],
      ...[...FOUNDER_TOOLS, ...FOUNDER_ROUTED_TOOLS, ...FOUNDER_EXPERIMENT_TOOLS].map((t) => [`tool ${t.name}`, `${t.description} ${JSON.stringify(t.parameters)}`] as [string, string]),
      ...PACKET_POLICY.map((p, i) => [`packet policy ${i}`, p] as [string, string]),
      ...dependencyLines(parseDependencies({ requests: ["pending", "withdrawn", "retired", "approved", "declined", "answered"].map((status, i) =>
        gumroadDep({ requestId: `0000000${i}-0000-4000-8000-000000000000`, status, response: status === "answered" ? "Use the free route." : null, ageS: 400 * 86_400 })) })!)
        .map((l, i) => [`dependency line ${i}`, l] as [string, string]),
      ["discovery task", discoveryTask(ALLOWED)],
    ];
    for (const [name, text] of texts) expect(text, name).not.toMatch(OWNER_DEPENDENCY);
    // The tools that teach the wrong reflex are gone; their replacements say nothing waits on them.
    const names = FOUNDER_TOOLS.map((t) => t.name);
    expect(names).not.toEqual(expect.arrayContaining(["request_owner_decision"]));
    expect(names).not.toContain("withdraw_owner_request");
    const rec = FOUNDER_TOOLS.find((t) => t.name === "record_external_dependency")!;
    expect(rec.description).toMatch(/makes only that action unavailable — never you, your goals or your other work: keep pursuing alternatives/);
    expect(rec.description).toMatch(/Ordinary business choices — niche, product, channel, marketing, pivots, experiments, spending, capital — are yours \(or FleetController's\) and are not dependencies/);
    // Only genuine exceptions are expressible: the kind enum carries no ordinary category, and nothing marks a goal blocked.
    const params = rec.parameters as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(params.properties.kind.enum).toEqual(EXCEPTION_KINDS);
    expect(Object.keys(params.properties)).not.toContain("blocking");
    expect(params.required).toEqual(["kind", "action", "title", "detail"]);
  });

  it("no new authority: the renamed tools stay 'planning' (already granted) and the manifest digest is unchanged", () => {
    for (const name of ["record_external_dependency", "withdraw_external_dependency"]) {
      expect(decideTool(name, FOUNDER_MANIFEST_V2)).toMatchObject({ allowed: true, capability: "planning" });
      expect(FOUNDER_TOOLS.find((t) => t.name === name)).toMatchObject({ capability: "planning" });
    }
    expect(decideTool("request_owner_decision", FOUNDER_MANIFEST_V2)).toMatchObject({ allowed: false });
    expect(manifestSha256(FOUNDER_MANIFEST_V2)).toBe("30a7060986930db3f611545c8c57fa5a98c9ad798bac279f66c39bdfe527a3d8");
  });

  it("the four engineering safety flags are untouched: v26 changes no flag, switch, cap, mode, custody or financial mode", () => {
    expect(loadFleetConfig({})).toMatchObject({ realReplicationEnabled: false, realPaymentsEnabled: false, ownerSweepEnabled: false });
    expect(V26_SQL).not.toMatch(/replication_enabled|custody_execution_enabled|financial_mode|max_agents|fleet_state|fleet_economic_model|fleet_treasury_policy|REAL_|OWNER_SWEEP|FLEET_DRY_RUN|FLEET_MAX_AGENTS|fleet_capability_manifests/);
    expect(FLEET_PG_SCHEMA_VERSION).toBe(26);
    expect(PG_MIGRATIONS.at(-1)).toMatchObject({ version: 26, name: "f2a_action_scoped_dependencies_discovery" });
  });
});

describe("F2-A action-scoped dependencies (founder view)", () => {
  it("parses v26 records and R28-era records alike; nothing renders as blocking or stale", () => {
    const [v26] = parseDependencies({ ok: true, requests: [gumroadDep()] })!;
    expect(v26).toEqual({ requestId: GUMROAD, kind: "kyc", action: GUMROAD_ACTION, goalRef: "g1", title: "Owner request: enrol a Gumroad channel for zero-capex digital products",
      status: "pending", ageS: 5 * 86_400, response: null, sinceDecidedS: null });
    // An R28 controller (before v26) reports category/blocking/stale and no kind/action: the founder still sees one action.
    const [legacy] = parseDependencies({ ok: true, staleAfterS: 86_400, requests: [{ requestId: GUMROAD, category: "sales_channel", goalRef: "g1", title: "Enable Gumroad",
      blocking: true, status: "pending", ageS: 9 * 86_400, stale: true, staleAfterS: 86_400, response: null }] })!;
    expect(legacy).toMatchObject({ kind: "sales_channel", action: "Enable Gumroad", status: "pending" });
    expect(Object.keys(legacy)).not.toEqual(expect.arrayContaining(["blocking"]));
    expect(Object.keys(legacy)).not.toContain("stale");
    expect(parseDependencies({ nope: 1 })).toBeNull();
    expect(parseDependencies({ requests: [{ status: "pending" }, "x", null] })).toEqual([]); // malformed entries dropped
    // Bounded: 20 parsed, 5 shown, text clipped.
    const many = parseDependencies({ requests: Array.from({ length: 30 }, (_, i) => gumroadDep({ requestId: `x${i}`, action: "a".repeat(500) })) })!;
    expect(many).toHaveLength(20);
    expect(many[0].action).toHaveLength(200);
    expect(dependencyLines(many)).toHaveLength(5);
  });

  it("lines: an open dependency is ONE unavailable action plus the alternatives; outcomes never imply authority", () => {
    const [open, withdrawn, retired, declined, answered] = dependencyLines(parseDependencies({ requests: [gumroadDep(),
      gumroadDep({ status: "withdrawn", ageS: 60 }), gumroadDep({ status: "retired", ageS: 60 }), gumroadDep({ status: "declined", ageS: 60 }),
      gumroadDep({ status: "answered", ageS: 60, response: "The fleet storefront will cover this later." })] })!);
    expect(open).toBe(`External dependency 62cbe1b7 (kyc): the action "${GUMROAD_ACTION}" is unavailable for now. This blocks only that action — not you, your goals or other work: pursue alternatives (another marketplace, direct sales that need no new account, another product, service, niche or venture).`);
    expect(withdrawn).toMatch(/: withdrawn by you\.$/);
    expect(retired).toMatch(/: retired — ordinary business decisions are yours; nothing waits on it\.$/);
    expect(declined).toMatch(/: DECLINED\. This records an answer only; it grants no capability, account, money or permission by itself\.$/);
    expect(answered).toMatch(/: ANSWERED, with the note: "The fleet storefront will cover this later\."\. This records an answer only; it grants no capability/);
    // A record resolved more than a week ago drops out; an open one never does (and never changes wording with age).
    const now = Date.parse("2026-10-20T00:00:00Z");
    expect(dependencyLines(parseDependencies({ requests: [gumroadDep({ status: "declined", ageS: 2 * 86_400, decidedAt: "2026-10-12T00:00:00Z" })] }, now)!)).toEqual([]);
    // ageS is the age AT resolution: a record open for 400 days and answered yesterday is still news (an R28 bug).
    expect(dependencyLines(parseDependencies({ requests: [gumroadDep({ status: "answered", ageS: 400 * 86_400, decidedAt: "2026-10-19T00:00:00Z", response: "ok" })] }, now)!))
      .toEqual([expect.stringMatching(/: ANSWERED, with the note: "ok"\./)]);
    expect(dependencyLines(parseDependencies({ requests: [gumroadDep({ status: "declined", ageS: 8 * 86_400 })] })!)).toEqual([]); // no decision time: age
    expect(dependencyLines(parseDependencies({ requests: [gumroadDep({ ageS: 400 * 86_400 })] })!)).toEqual([open]);
  });
});

// ─────────────────────────────────────────────── the routed founder mind

function rig(o: { deps?: () => unknown; discovery?: () => DiscoveryAllowance | null; caps?: () => Record<string, unknown>; reply?: (n: number, packet: string) => ToolCall[];
  charge?: number; toolboxPorts?: Record<string, unknown> } = {}) {
  const root = tmp();
  const dirs = { w: path.join(root, "w"), s: path.join(root, "s"), m: path.join(root, "s", "memory") };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  // Founder 1's state as R28 left it: a built product and the goal its prompts taught it ("a channel the owner can enable").
  fs.writeFileSync(path.join(dirs.m, "facts.json"), JSON.stringify({ product: "UK landlord compliance tracker spreadsheet, £9" }));
  fs.writeFileSync(path.join(dirs.m, "goals.json"), JSON.stringify([{ id: "g1", title: "Sell the tracker through a sales channel the owner can enable", status: "open" }]));
  const packets: string[] = [];
  const statusCalls = { n: 0 };
  let n = 0;
  const ports: MindPorts = {
    cognitionStatus: async () => {
      statusCalls.n++;
      const d = o.discovery?.();
      return { policyEnabled: true, provider: "anthropic", founderEnabled: true, paused: false, routing: { active: true },
        capabilities: capabilityView(o.caps?.() ?? CAPS(), true), ...(d ? { discovery: d } : {}) };
    },
    ledger: async () => ({ cash: 9_188, genesisAllocation: 10_000, survivalEquity: 9_188 }),
    ...(o.deps ? { ownerRequests: async () => o.deps!() } : {}),
    infer: async (messages) => {
      const packet = String((messages as Array<{ content: string }>)[0].content);
      packets.push(packet);
      n++;
      return { content: "", toolCalls: o.reply?.(n, packet) ?? [{ id: `t${n}`, name: "sleep", arguments: { reason: "nothing to do" } }], usage: { inputTokens: 1, outputTokens: 1 },
        chargedCents: o.charge ?? 0, requestId: `r${n}` };
    },
  };
  const loopGuard = new LoopGuard();
  const toolbox = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: dirs.w, memoryDir: dirs.m, loopGuard, ports: {
    ledger: async () => ({}), spendOrder: async () => ({}), proposeKnowledge: async () => ({}), knowledge: async () => [], requestIdentityFact: async () => ({}),
    ownerRequestCreate: async () => ({ ok: true }), ownerRequestWithdraw: async () => ({ ok: true }), ...(o.toolboxPorts ?? {}),
  } as never });
  const mind = new FounderMind({ ports, toolbox, stateDir: dirs.s, routed: { memoryDir: dirs.m, workspaceDir: dirs.w, manifest: FOUNDER_MANIFEST_V2, loopGuard } });
  const parse = (text: string) => {
    const body = JSON.parse(text.split("\n").slice(3).join("\n"));
    expect(taskPacketProblems(body)).toEqual([]);
    const task = String(body.task);
    return { text, body, task, slim: /Nothing has changed since your last turn/.test(task), discovery: /autonomous opportunity discovery/.test(task) };
  };
  /** Turn until the next inference call happens (thinking slots skipped by the idle backoff cost nothing). */
  const next = async () => {
    const before = packets.length;
    for (let i = 0; i <= MAX_IDLE_SKIP + 1 && packets.length === before; i++) await mind.turn(`heartbeat ${i}`);
    expect(packets.length).toBe(before + 1);
    return parse(packets.at(-1)!);
  };
  return { mind, next, parse, dirs, packets, statusCalls };
}
type Rig = ReturnType<typeof rig>;
const seq = async (r: Rig, k: number) => { const out = []; for (let i = 0; i < k; i++) out.push(await r.next()); return out; };

describe("F2-A dependencies in the founder loop", () => {
  it("an unresolved dependency never escalates: its age is not a signal, only a status change is (one full packet)", async () => {
    let dep = gumroadDep({ ageS: 3_600 });
    const r = rig({ deps: () => ({ ok: true, requests: [dep] }) });
    const [first, second] = await seq(r, 2);
    expect(first.slim).toBe(false);
    expect(first.task).toContain(`External dependency 62cbe1b7 (kyc): the action "${GUMROAD_ACTION}" is unavailable for now. This blocks only that action`);
    expect(second.slim).toBe(true); // visible, but nothing new
    expect(second.task).toContain("This blocks only that action");
    for (const days of [1, 2, 4, 8, 64, 400]) { // the R28 staleness milestones are gone: time alone never produces a packet
      dep = gumroadDep({ ageS: days * 86_400 });
      const w = await r.next();
      expect(w.slim, `day ${days}`).toBe(true);
      expect(w.task).not.toMatch(OWNER_DEPENDENCY);
    }
    dep = gumroadDep({ status: "answered", response: "The fleet storefront will host it.", ageS: 401 * 86_400, decidedAt: new Date().toISOString() });
    const resolved = await r.next();
    expect(resolved.slim).toBe(false);
    expect(resolved.task).toMatch(/ANSWERED, with the note: "The fleet storefront will host it\."/);
    expect((await r.next()).slim).toBe(true);
  });

  it("record_external_dependency: only exception kinds, scoped to one action; the controller's refusal comes back as data", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const ports = { ownerRequestCreate: async (x: Record<string, unknown>) => {
      sent.push(x);
      return EXCEPTION_KINDS.includes(String(x.kind)) ? { ok: true, request: { requestId: "d1", status: "pending" }, note: "Recorded: only this action is unavailable." }
        : { ok: false, code: "FLEET_NOT_AN_EXCEPTION", reason: "Niche, product, channel, marketing, pivot, experiment, spending and capital decisions are yours or FleetController's." };
    } };
    const r = rig({ toolboxPorts: ports });
    const box = (r.mind as unknown as { o: { toolbox: FounderToolbox } }).o.toolbox;
    const ok = await box.execute({ id: "toolu_1", name: "record_external_dependency", arguments: { kind: "kyc", action: "List on Gumroad", title: "Gumroad seller account",
      detail: "Needs a human identity; selling direct meanwhile.", goalId: "g1" } });
    expect(ok).toMatchObject({ ok: true });
    expect(sent[0]).toEqual({ idempotencyKey: "dep:toolu_1", kind: "kyc", action: "List on Gumroad", goalRef: "g1", title: "Gumroad seller account", detail: "Needs a human identity; selling direct meanwhile." });
    const ordinary = await box.execute({ id: "toolu_2", name: "record_external_dependency", arguments: { kind: "sales_channel", action: "Pick a channel", title: "t", detail: "d" } });
    expect(ordinary).toMatchObject({ ok: false, refused: "FLEET_NOT_AN_EXCEPTION" });
    expect(ordinary.output).toMatch(/are yours or FleetController's/);
    expect(await box.execute({ id: "toolu_3", name: "record_external_dependency", arguments: { kind: "kyc", title: "t", detail: "d" } })).toMatchObject({ ok: false, refused: "FLEET_BAD_REQUEST" });
    await box.execute({ id: "toolu_4", name: "record_external_dependency", arguments: { kind: "kyc", action: "a", title: "t", detail: "d", goalId: "not-a-goal", blocking: true } });
    expect(sent.at(-1)).toEqual({ idempotencyKey: "dep:toolu_4", kind: "kyc", action: "a", goalRef: null, title: "t", detail: "d" }); // no blocking flag exists
    expect(await box.execute({ id: "toolu_5", name: "withdraw_external_dependency", arguments: { requestId: GUMROAD } })).toMatchObject({ ok: true });
    expect(await box.execute({ id: "toolu_6", name: "withdraw_external_dependency", arguments: { requestId: "../x" } })).toMatchObject({ ok: false, refused: "FLEET_BAD_REQUEST" });
    // A controller error raised by the client is data with the controller's code.
    const limited = rig({ toolboxPorts: { ownerRequestCreate: async () => { throw Object.assign(new Error("FLEET_LIMIT_REACHED"), { code: "FLEET_LIMIT_REACHED" }); } } });
    const lbox = (limited.mind as unknown as { o: { toolbox: FounderToolbox } }).o.toolbox;
    expect(await lbox.execute({ id: "toolu_7", name: "record_external_dependency", arguments: { kind: "kyc", action: "a", title: "t", detail: "d" } })).toMatchObject({ ok: false, refused: "FLEET_LIMIT_REACHED" });
    // A runtime without the port: unavailable, never a crash.
    const none = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: r.dirs.w, memoryDir: r.dirs.m, ports: { ledger: async () => ({}), spendOrder: async () => ({}),
      proposeKnowledge: async () => ({}), knowledge: async () => [], requestIdentityFact: async () => ({}) } as never });
    expect(await none.execute({ id: "toolu_8", name: "record_external_dependency", arguments: { kind: "kyc", action: "a", title: "t", detail: "d" } })).toMatchObject({ ok: false, refused: "FLEET_TOOL_NOT_AVAILABLE" });
  });

  it("R28 semantic capability-change detection is preserved: the upgrade names the renamed tools exactly once", async () => {
    const r = rig({ deps: () => ({ ok: true, requests: [gumroadDep()] }) });
    const current = capabilityView(CAPS(), true).tools;
    const r28Tools = current.map((t) => (t === "record_external_dependency" ? "request_owner_decision" : t === "withdraw_external_dependency" ? "withdraw_owner_request" : t)).sort();
    // State as the R28 runtime leaves it: a sleep-only turn, its digest recorded with the R28 signal format, R28 tools.
    fs.writeFileSync(path.join(r.dirs.s, "mind-continuity.json"), JSON.stringify({ at: "2026-10-01T15:32:23.972Z", turn: 12, outcome: "sleep: Gumroad 62cbe1b7 still pending.",
      tools: ["sleep"], wakeDigest: "0".repeat(64), capabilities: { sig: "1".repeat(64), tools: r28Tools } }));
    const [first, second] = await seq(r, 2);
    expect(first.slim).toBe(false);
    expect(first.task).toMatch(/Your capabilities changed since your last turn\. Newly available: record_external_dependency, withdraw_external_dependency\. No longer available: request_owner_decision, withdraw_owner_request\./);
    expect(first.task).toContain("This blocks only that action");
    expect(first.task).not.toMatch(OWNER_DEPENDENCY);
    expect(second.slim).toBe(true);
    expect(second.task).not.toMatch(/capabilit/i);
  });
});

describe("F2-A autonomous discovery trigger", () => {
  it("parses the controller's allowance; anything malformed or absent is 'no allowance' (an older controller)", () => {
    expect(parseDiscovery(ALLOWED)).toEqual(ALLOWED);
    expect(parseDiscovery({ allowed: false, budgetCents: "183", spentTodayCents: "190", runwayDays: null, reason: "today's discovery allowance is spent" }))
      .toEqual({ allowed: false, budgetCents: 183, spentTodayCents: 190, runwayDays: null, reason: "today's discovery allowance is spent" });
    for (const bad of [undefined, null, {}, { allowed: "yes" }, "allowed"]) expect(parseDiscovery(bad)).toBeNull();
    expect(parseDiscovery({ ...ALLOWED, reason: "r".repeat(500) })!.reason).toHaveLength(120);
    const t = discoveryTask(ALLOWED);
    expect(t).toMatch(/^No actionable current work — autonomous opportunity discovery \(allowance today 12p of 183p; runway ≈ 210 days\)\./);
    expect(t).toMatch(/distribution routes that need no new account or human identity/);
    expect(t).toMatch(/Unavailable actions \(external dependencies\) do not block this/);
    expect(discoveryTask({ ...ALLOWED, runwayDays: null })).not.toMatch(/runway/);
  });

  it("an idle wake with allowance is discovery (a full packet), not sleep; without allowance it is the slim packet as before", async () => {
    let discovery: DiscoveryAllowance | null = ALLOWED;
    const r = rig({ discovery: () => discovery });
    const [first, second, third] = await seq(r, 3);
    expect(first.slim).toBe(false); // a first turn is full in any case
    expect(first.discovery).toBe(false);
    expect([second.discovery, third.discovery]).toEqual([true, true]);
    expect([second.slim, third.slim]).toEqual([false, false]);
    expect(second.task).toMatch(/autonomous opportunity discovery \(allowance today 12p of 183p; runway ≈ 210 days\)/);
    expect(second.body.knowledge.length).toBeGreaterThan(0); // the founder's own memory is in the packet
    expect(r.mind.routing).toMatchObject({ discoveryTurns: 2, slimWakeups: 0 });
    discovery = { ...ALLOWED, allowed: false, spentTodayCents: 183, reason: "today's discovery allowance is spent" };
    const spent = await r.next();
    expect(spent).toMatchObject({ slim: true, discovery: false });
    expect(spent.task).toMatch(/otherwise you may sleep until your discovery allowance renews/);
    discovery = null; // an older controller reports no allowance: the R23.1 behaviour, unchanged
    expect(await r.next()).toMatchObject({ slim: true, discovery: false });
    expect(r.mind.routing).toMatchObject({ discoveryTurns: 2, slimWakeups: 2 });
  });

  it("the founder pursues alternatives while the Gumroad dependency stays unresolved: discovery carries both, and work resets the loop", async () => {
    let step = 0;
    const r = rig({ deps: () => ({ ok: true, requests: [gumroadDep()] }), discovery: () => ALLOWED,
      reply: (n, packet) => {
        // In a discovery packet the founder records an alternative route and sleeps; otherwise it just sleeps.
        if (/autonomous opportunity discovery/.test(packet) && step++ === 0) {
          return [{ id: `w${n}`, name: "remember_fact", arguments: { key: "alt_channel", value: "Sell the tracker directly via a self-hosted checkout page (no new account)" } },
            { id: `s${n}`, name: "sleep", arguments: { reason: "alternative found; building the direct route next" } }];
        }
        return [{ id: `s${n}`, name: "sleep", arguments: { reason: "nothing to do" } }];
      } });
    const [first, disc, afterWork, nextDisc] = await seq(r, 4);
    expect(first.discovery).toBe(false);
    expect(disc.discovery).toBe(true);
    expect(disc.task).toContain(`the action "${GUMROAD_ACTION}" is unavailable for now. This blocks only that action`);
    expect(disc.task).toMatch(/Unavailable actions \(external dependencies\) do not block this/);
    // The turn did work (memory changed): the next wake is an ordinary full packet carrying the new fact.
    expect(afterWork).toMatchObject({ slim: false, discovery: false });
    expect(JSON.stringify(afterWork.body.knowledge)).toContain("self-hosted checkout page");
    expect(nextDisc.discovery).toBe(true); // and idle again → discovery again
  });

  it("discovery stays bounded by the idle backoff: a founder that keeps declining costs at most one call per backed-off slot", async () => {
    const r = rig({ discovery: () => ALLOWED });
    let slots = 0;
    while (r.packets.length < 8) { await r.mind.turn(`slot ${slots}`); slots++; }
    // 1, 2, 4, 8, 16, 32, 32 skipped slots between the 8 calls (MAX_IDLE_SKIP = 32), exactly as before F2-A.
    expect(MAX_IDLE_SKIP).toBe(32);
    expect(slots).toBe(8 + 1 + 2 + 4 + 8 + 16 + 32 + 32);
    expect(r.mind.routing.discoveryTurns).toBe(7);
  });
});

describe("F2-A proof: owner absence cannot freeze a founder", () => {
  it("30 simulated days, zero owner actions, Gumroad unresolved throughout: every day has autonomous work and no packet points at the owner", async () => {
    // FleetController's allowance model (fleet_discovery_allowance, policy defaults): budget/day = min(300p, equity × 2 %), runway floor 14 d.
    const policy = { dailyFractionBp: 200, maxDailyCents: 300, minRunwayDays: 14 };
    let equity = 9_188;
    let spentToday = 0;
    const allowance = (): DiscoveryAllowance => {
      const budget = Math.min(policy.maxDailyCents, Math.floor((equity * policy.dailyFractionBp) / 10_000));
      const runway = equity / 40; // ≈ 40p/day trailing burn
      const reason = equity <= 0 ? "no survival equity" : runway < policy.minRunwayDays ? "runway below the discovery floor: revenue-first" : spentToday >= budget ? "today's discovery allowance is spent" : "allowed";
      return { allowed: reason === "allowed", budgetCents: budget, spentTodayCents: spentToday, runwayDays: Math.round(runway * 10) / 10, reason };
    };
    const ownerActions: string[] = [];
    const CHARGE = 25;
    const r = rig({ deps: () => ({ ok: true, requests: [gumroadDep()] }), discovery: allowance, charge: CHARGE });
    const ports = (r.mind as unknown as { o: { ports: MindPorts & { ownerDecide?: () => void } } }).o.ports;
    ports.ownerDecide = () => ownerActions.push("decide"); // present, never called: the owner is absent
    const perDay: Array<{ calls: number; discovery: number; slim: number }> = [];
    const SLOTS_PER_DAY = 2 * (MAX_IDLE_SKIP + 1); // far fewer than a real day (2 880 slots): a conservative bound
    for (let day = 0; day < 30; day++) {
      spentToday = 0; // the allowance renews daily — no one has to act
      const before = r.packets.length;
      for (let s = 0; s < SLOTS_PER_DAY; s++) {
        const n = r.packets.length;
        await r.mind.turn(`day ${day} slot ${s}`);
        if (r.packets.length > n) { spentToday += CHARGE; equity -= CHARGE; }
      }
      const today = r.packets.slice(before).map((t) => r.parse(t));
      perDay.push({ calls: today.length, discovery: today.filter((p) => p.discovery).length, slim: today.filter((p) => p.slim).length });
      for (const p of today) {
        expect(p.task).not.toMatch(OWNER_DEPENDENCY);
        expect(p.task).toContain("This blocks only that action"); // the dependency is visible every time, as one action
      }
    }
    expect(ownerActions).toEqual([]);
    // Every single day the founder had an autonomous next step (a discovery packet), not only "nothing has changed".
    expect(perDay.every((d) => d.discovery >= 1), JSON.stringify(perDay)).toBe(true);
    // Spend stays inside the controller's allowance each day (± the one call that crosses it), and survival equity remains.
    expect(perDay.every((d) => d.discovery * CHARGE <= Math.min(300, Math.floor((9_188 * 200) / 10_000)) + CHARGE)).toBe(true);
    expect(equity).toBeGreaterThan(0);
  });

  it("the slim packet no longer ends in 'otherwise sleep' as the only option", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "m"));
    fs.mkdirSync(path.join(root, "w"));
    const slim = slimWakePacket(buildTaskPacket({ memoryDir: path.join(root, "m"), workspaceDir: path.join(root, "w"), task: "t", economics: {},
      outputContract: { form: "analysis", mustCite: false, instructions: "Decide." } }));
    expect(slim.task).toMatch(/otherwise you may sleep until your discovery allowance renews\.$/);
    expect(slim.task).not.toMatch(/otherwise sleep\.$/);
  });
});
