/**
 * F2 Phase A — autonomy doctrine in the founder loop (founder side; no database, no model).
 *
 * Founder 1 slept for days waiting on an owner decision about Gumroad: the system had taught it to wait. F2-A makes the
 * founder an autonomous economic actor:
 *   - an external dependency makes ONE action unavailable (never the founder, a goal or other work), and nothing escalates
 *     toward the owner over time;
 *   - research is DECISION-DRIVEN, never browsing: it exists only to find a viable niche/product/service/gap or to expand
 *     a viable venture, serves an open economic decision (question, hypothesis, the founder's own stop condition), names
 *     the one missing fact and its value, and stops when more information would not change the decision;
 *   - runway strategy is the founder's: FleetController observes and reports survival figures, never rations, schedules
 *     or refuses research on that basis;
 *   - an idle wake is not a browse: every full packet carries the next economically meaningful move (decide, execute, or
 *     one concise opportunity cycle with a short shortlist), and an unchanged idle state is re-checked on a doubling
 *     schedule — liveness without any daily entitlement.
 * These tests drive the production FounderMind, FounderToolbox, decision ledger and charter/tool text with scripted
 * cognition. (Registry side: fleet-f2a-pg.test.ts.)
 */
import { describe, it, expect } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import {
  FounderMind, MAX_IDLE_SKIP, RENUDGE_FIRST, RENUDGE_MAX, dependencyLines, parseDependencies, slimWakePacket, type MindPorts,
} from "../../fleet/founder/mind.js";
import {
  CONSTANT_STANDARD, DECISION_LIMITS, DecisionLedgerError, OPPORTUNITY_CYCLE, commitmentCheck, decisionLines, idleKind, idleTask, loadDecisions, nextMoveLine, openDecision,
  parseSurvival, researchCheck, resolveDecision, reviewDecision, survivalLine, type Decision, type SurvivalView,
} from "../../fleet/founder/decisions.js";
import { FounderToolbox, INFRA_CEILING } from "../../fleet/founder/toolbox.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { FOUNDER_MANIFEST_V2, decideTool, manifestSha256 } from "../../fleet/capabilities.js";
import {
  FOUNDER_CHARTER, FOUNDER_CHARTER_V2, FOUNDER_CHARTER_VERSION, FOUNDER_EXPERIMENT_TOOLS, FOUNDER_ROUTED_ADDENDUM, FOUNDER_ROUTED_TOOLS, FOUNDER_TOOLS, type ToolCall,
} from "../../fleet/cognition/types.js";
import { PACKET_POLICY, buildTaskPacket, taskPacketProblems } from "../../fleet/cognition/task-packet.js";
import { capabilityView } from "../../fleet/cognition/capability-signature.js";
import { V26_SQL } from "../../fleet/postgres/migrations-phase26.js";
import { FLEET_PG_SCHEMA_VERSION, PG_MIGRATIONS } from "../../fleet/postgres/migrations.js";
import { writeTargets } from "../../fleet/postgres/privileges.js";
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
const SURVIVAL = (o: Partial<SurvivalView> = {}): SurvivalView => ({ survivalEquityCents: 9_188, inferenceTodayCents: 12, burnPerDayCents: 40, runwayDays: 229.7, ...o });
/** A legacy (pre-correction) allowance object, as an older controller build might still report it: it must have no effect. */
const LEGACY_ALLOWANCE = { allowed: false, budgetCents: 0, spentTodayCents: 300, runwayDays: 3, reason: "runway below the discovery floor: revenue-first" };

/** Founder-facing words that teach dependency on the owner (F2 design §3/§17). Constitutional items are not founder text. */
const OWNER_DEPENDENCY = /owner decides|owner approv|the owner can enable|ask the owner|awaiting (the )?owner|owner-enrolled|keep waiting|STALE|policy and the owner|decision only the owner/i;
/** Founder-facing words that make research an entitlement or a pastime rather than a decision (the corrected doctrine). */
const BROWSING = /discovery allowance|allowance (today|renews|is spent)|use (today's|your) (allowance|budget)|look for (interesting )?trends|explore trends|browse for|research current demand;|scroll/i;

const decisionArgs = (o: Record<string, unknown> = {}) => ({ key: "tracker-demand", purpose: "find_opportunity", objective: "First £200 of tracker revenue within 30 days",
  question: "Is there enough demand for a UK landlord compliance tracker at £9 to launch it?", hypothesis: "Landlord templates sell steadily on marketplaces at £5–£15",
  options: ["direct checkout page", "Etsy listing", "Notion template marketplace"], stopAfterFetches: 2, stopWhen: "two independent signals of actual purchases", ...o });
const resolveArgs = (o: Record<string, unknown> = {}) => ({ key: "tracker-demand", selected: "direct checkout page", ranking: ["direct checkout page", "Etsy listing"],
  rejected: [{ option: "Notion template marketplace", reason: "no purchase evidence for compliance templates" }], rationale: "Two marketplaces show steady sales of similar trackers at £7–£12.",
  expectedOutcome: "First sale within 14 days at £9", capitalAtRiskPence: 500, downside: "At most 500p of hosting and listing costs; fully reversible",
  invalidatedBy: "No sale after 50 targeted visitors", nextAction: "Publish the tracker on a self-hosted checkout page", ...o });
const framed = (o: Record<string, unknown> = {}) => ({ url: "https://market.example/landlord", mode: "research", decisionKey: "tracker-demand",
  evidenceGap: "How many landlord compliance templates sold last month on Etsy?", expectedValue: "Low sales would rule the tracker out at £9", informationValue: "high", ...o });

describe("F2-A charter v3 and founder-facing text", () => {
  it("charter v3: autonomous actor; FleetController is the bank; decision-driven research; runway strategy is the founder's", () => {
    expect(FOUNDER_CHARTER_VERSION).toBe("founder-charter-v3");
    expect(FOUNDER_CHARTER).toMatch(/an autonomous economic actor\. Your purpose is to stay alive economically/);
    expect(FOUNDER_CHARTER).toMatch(/no one approves your business choices: you choose niches, products, services, channels, marketing, experiments, pivots and new ventures yourself/);
    expect(FOUNDER_CHARTER).toMatch(/FleetController is your bank: it decides spending and capital by policy/);
    expect(FOUNDER_CHARTER).toMatch(/The owner maintains the fleet, is not your manager and is not consulted on ordinary business/);
    expect(FOUNDER_CHARTER).toMatch(/Your standard at any runway: pinpoint → decide → execute → measure → learn → forward\. Never search → search → search or activity for its own sake; step back only when new evidence breaks an assumption, then go forward\./);
    expect(FOUNDER_CHARTER).toMatch(/Every move has economic purpose\. Research only to find a viable niche, product, service or business gap you can bridge, or to expand a viable venture/);
    expect(FOUNDER_CHARTER).toMatch(/Prefer purchase evidence \(sales velocity, rankings, search demand, prices, reviews, competition\) over popularity/);
    expect(FOUNDER_CHARTER).toMatch(/Once you know enough for the next economically meaningful move, resolve_decision and execute; never re-research a decided question/);
    expect(FOUNDER_CHARTER).toMatch(/You manage your own risk: capital at risk, downside, concentration, opportunity cost, runway, commitments and expected return; size each commitment and name what would invalidate it first\./);
    expect(FOUNDER_CHARTER).toMatch(/Runway changes which opportunity is rational, never your precision: no casual research when rich, no panic when poor\./);
    expect(FOUNDER_CHARTER).toMatch(/rank candidates by your own judgement/);
    expect(FOUNDER_CHARTER).toMatch(/all spending is a structured request that FleetController executes under its custody rules/);
    expect(FOUNDER_CHARTER).toMatch(/A blocked dependency blocks only that one action, never you/);
    expect(FOUNDER_CHARTER).not.toMatch(/allowance|14 days|30 days|% of|discover and research opportunities|quota|searches|weight|score/i);
    // The hard rules are unchanged (no new authority), and the length stays bounded (every token is paid on every call).
    expect(FOUNDER_CHARTER).toMatch(/you cannot hold keys, sign, pay, transfer value, create sandboxes, modify your own code, install tools or reproduce/);
    expect(FOUNDER_CHARTER).toMatch(/Researching a market is not permission to trade it/);
    expect(FOUNDER_CHARTER.length).toBeLessThan(4_000);
    // v2 is frozen, byte for byte, for the sealed evaluations (its sha is an input of their pre-registration hashes).
    expect(crypto.createHash("sha256").update(FOUNDER_CHARTER_V2).digest("hex")).toBe("c111db2cc10d7bd4dd7d01de5139c1a7b033d5ba58b3e32eae02f9d787a8354e");
  });

  it("lint: no founder-facing text teaches owner dependency or browsing — charter, addendum, tools, packet policy, dependency/decision/idle/survival lines", () => {
    const ledger: Decision[] = [];
    openDecision(ledger, decisionArgs());
    openDecision(ledger, decisionArgs({ key: "etsy-expand", purpose: "expand_venture", question: "Would listing the tracker on Etsy improve profit after fees?" }));
    resolveDecision(ledger, resolveArgs({ key: "etsy-expand", selected: "none", nextAction: "Keep the direct checkout as the only channel for now" }));
    const goals = [{ id: "g2", title: "Execute tracker-demand: publish the checkout page" }];
    const texts: Array<[string, string]> = [
      ["charter", FOUNDER_CHARTER], ["routed addendum", FOUNDER_ROUTED_ADDENDUM],
      ...[...FOUNDER_TOOLS, ...FOUNDER_ROUTED_TOOLS, ...FOUNDER_EXPERIMENT_TOOLS].map((t) => [`tool ${t.name}`, `${t.description} ${JSON.stringify(t.parameters)}`] as [string, string]),
      ...PACKET_POLICY.map((p, i) => [`packet policy ${i}`, p] as [string, string]),
      ...dependencyLines(parseDependencies({ requests: ["pending", "withdrawn", "retired", "approved", "declined", "answered"].map((status, i) =>
        gumroadDep({ requestId: `0000000${i}-0000-4000-8000-000000000000`, status, response: status === "answered" ? "Use the free route." : null, ageS: 400 * 86_400 })) })!)
        .map((l, i) => [`dependency line ${i}`, l] as [string, string]),
      ...decisionLines(ledger).map((l, i) => [`decision line ${i}`, l] as [string, string]),
      ...(["decide", "execute", "opportunity"] as const).map((k) => [`idle ${k}`, idleTask(k, ledger, goals)] as [string, string]),
      ...(["execute", "opportunity"] as const).map((k) => [`next move ${k}`, nextMoveLine(k)!] as [string, string]),
      ["survival", survivalLine(SURVIVAL({ runwayDays: 3 }))],
    ];
    for (const [name, text] of texts) {
      expect(text, name).not.toMatch(OWNER_DEPENDENCY);
      expect(text, name).not.toMatch(BROWSING);
    }
    // The tools that teach the wrong reflex are gone; their replacements say nothing waits on them.
    const names = FOUNDER_TOOLS.map((t) => t.name);
    expect(names).not.toContain("request_owner_decision");
    expect(names).not.toContain("withdraw_owner_request");
    const rec = FOUNDER_TOOLS.find((t) => t.name === "record_external_dependency")!;
    expect(rec.description).toMatch(/makes only that action unavailable — never you, your goals or your other work: keep pursuing alternatives/);
    const params = rec.parameters as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(params.properties.kind.enum).toEqual(EXCEPTION_KINDS);
    expect(Object.keys(params.properties)).not.toContain("blocking");
  });

  it("tools: research is framed by a decision (two purposes only, a shortlist of at most 5, the founder's own stop); FleetController approves nothing", () => {
    const fetch = FOUNDER_TOOLS.find((t) => t.name === "web_fetch")!;
    const fp = fetch.parameters as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(fp.required).toEqual(["url", "mode"]);
    expect(fp.properties.mode.enum).toEqual(["research", "execution"]);
    expect(fp.properties.informationValue.enum).toEqual(["high", "medium", "low"]);
    for (const k of ["decisionKey", "evidenceGap", "expectedValue", "step"]) expect(Object.keys(fp.properties)).toContain(k);
    expect(fetch.description).toMatch(/Research mode serves an OPEN DECISION/);
    expect(fetch.description).toMatch(/prefer purchase evidence \(sales velocity, rankings, bestseller lists, search demand, prices, reviews, competition\) over popularity/);
    expect(fetch.description).not.toMatch(/approv|owner/i);
    const open = FOUNDER_TOOLS.find((t) => t.name === "open_decision")!;
    const op = open.parameters as { properties: Record<string, { enum?: string[]; maxItems?: number; maximum?: number }>; required: string[] };
    expect(op.properties.purpose.enum).toEqual(["find_opportunity", "expand_venture"]);
    expect(op.properties.options.maxItems).toBe(5);
    expect(op.properties.stopAfterFetches.maximum).toBe(8);
    expect(op.required).toEqual(["key", "purpose", "objective", "question", "hypothesis", "stopAfterFetches", "stopWhen"]);
    const res = FOUNDER_TOOLS.find((t) => t.name === "resolve_decision")!;
    expect((res.parameters as { required: string[] }).required).toEqual(["key", "selected", "rationale", "expectedOutcome", "capitalAtRiskPence", "downside", "invalidatedBy", "nextAction"]);
    // No new authority: every new or renamed tool is 'planning' (already granted) and the manifest digest is unchanged.
    for (const name of ["record_external_dependency", "withdraw_external_dependency", "open_decision", "resolve_decision"]) {
      expect(decideTool(name, FOUNDER_MANIFEST_V2)).toMatchObject({ allowed: true, capability: "planning" });
    }
    expect(decideTool("request_owner_decision", FOUNDER_MANIFEST_V2)).toMatchObject({ allowed: false });
    expect(manifestSha256(FOUNDER_MANIFEST_V2)).toBe("30a7060986930db3f611545c8c57fa5a98c9ad798bac279f66c39bdfe527a3d8");
  });

  it("the four engineering safety flags are untouched; v26 rations nothing and writes no money table (shared/restricted capital stays protected)", () => {
    expect(loadFleetConfig({})).toMatchObject({ realReplicationEnabled: false, realPaymentsEnabled: false, ownerSweepEnabled: false });
    expect(V26_SQL).not.toMatch(/replication_enabled|custody_execution_enabled|financial_mode|max_agents|fleet_state|fleet_economic_model|fleet_treasury_policy|REAL_|OWNER_SWEEP|FLEET_DRY_RUN|FLEET_MAX_AGENTS|fleet_capability_manifests/);
    // No FleetController research ration, entitlement or runway shutdown exists any more.
    expect(V26_SQL.replace(/--[^\n]*/g, "")).not.toMatch(/discovery|allowance|min_runway|daily_fraction|'allowed'|budgetCents/); // code, not comments
    expect(V26_SQL).toMatch(/CREATE FUNCTION fleet_survival_observation\(p_agent text\) RETURNS jsonb LANGUAGE sql STABLE/);
    // The only table v26 writes is the dependency table: no ledger, treasury, payment, reserve, obligation or tax table.
    expect(writeTargets(V26_SQL)).toEqual(["fleet_owner_requests"]);
    expect(FLEET_PG_SCHEMA_VERSION).toBe(26);
    expect(PG_MIGRATIONS.at(-1)).toMatchObject({ version: 26, name: "f2a_action_scoped_dependencies_survival_observation" });
    // Own capital: the founder's risk judgement; FleetController is the custodian that protects treasury/shared/restricted capital.
    expect(FOUNDER_TOOLS.find((t) => t.name === "request_spend")!.description).toMatch(/the risk judgement is yours.*FleetController is the custodian: it executes orders only within its custody rules, which protect treasury, shared, restricted and protected capital/);
  });
});

describe("F2-A action-scoped dependencies (founder view)", () => {
  it("parses v26 records and R28-era records alike; nothing renders as blocking or stale", () => {
    const [v26] = parseDependencies({ ok: true, requests: [gumroadDep()] })!;
    expect(v26).toEqual({ requestId: GUMROAD, kind: "kyc", action: GUMROAD_ACTION, goalRef: "g1", title: "Owner request: enrol a Gumroad channel for zero-capex digital products",
      status: "pending", ageS: 5 * 86_400, response: null, sinceDecidedS: null });
    const [legacy] = parseDependencies({ ok: true, staleAfterS: 86_400, requests: [{ requestId: GUMROAD, category: "sales_channel", goalRef: "g1", title: "Enable Gumroad",
      blocking: true, status: "pending", ageS: 9 * 86_400, stale: true, staleAfterS: 86_400, response: null }] })!;
    expect(legacy).toMatchObject({ kind: "sales_channel", action: "Enable Gumroad", status: "pending" });
    expect(Object.keys(legacy)).not.toContain("blocking");
    expect(Object.keys(legacy)).not.toContain("stale");
    expect(parseDependencies({ nope: 1 })).toBeNull();
    expect(parseDependencies({ requests: [{ status: "pending" }, "x", null] })).toEqual([]); // malformed entries dropped
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
    const now = Date.parse("2026-10-20T00:00:00Z");
    expect(dependencyLines(parseDependencies({ requests: [gumroadDep({ status: "declined", ageS: 2 * 86_400, decidedAt: "2026-10-12T00:00:00Z" })] }, now)!)).toEqual([]);
    // ageS is the age AT resolution: a record open for 400 days and answered yesterday is still news (an R28 bug).
    expect(dependencyLines(parseDependencies({ requests: [gumroadDep({ status: "answered", ageS: 400 * 86_400, decidedAt: "2026-10-19T00:00:00Z", response: "ok" })] }, now)!))
      .toEqual([expect.stringMatching(/: ANSWERED, with the note: "ok"\./)]);
    expect(dependencyLines(parseDependencies({ requests: [gumroadDep({ ageS: 400 * 86_400 })] })!)).toEqual([open]);
  });
});

describe("F2-A decision-driven research (the founder's own ledger)", () => {
  it("(3, 4) research needs an open economic decision with a hypothesis and a stop condition, for one of only two purposes", () => {
    const ledger: Decision[] = [];
    for (const purpose of ["browse", "trends", "explore", undefined]) expect(openDecision(ledger, decisionArgs({ purpose }))).toMatchObject({ ok: false, code: "FLEET_RESEARCH_PURPOSE" });
    for (const missing of ["question", "hypothesis", "stopWhen", "stopAfterFetches"]) {
      expect(openDecision(ledger, decisionArgs({ [missing]: undefined })), missing).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
    }
    expect(openDecision(ledger, decisionArgs({ stopAfterFetches: DECISION_LIMITS.maxFetches + 1 }))).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
    // (8) a decision compares a SHORT list, not hundreds of ideas
    expect(openDecision(ledger, decisionArgs({ options: ["a", "b", "c", "d", "e", "f"] }))).toMatchObject({ ok: false, code: "FLEET_SHORTLIST_TOO_LONG" });
    expect(ledger).toEqual([]);
    expect(openDecision(ledger, decisionArgs())).toMatchObject({ ok: true, decision: { key: "tracker-demand", status: "open", stop: { maxFetches: 2 } } });
    // A fetch without a decision, or without the one missing fact and its value, is not research.
    expect(researchCheck(ledger, { url: "https://x.example" })).toMatchObject({ ok: false, code: "FLEET_RESEARCH_UNFRAMED" });
    expect(researchCheck(ledger, framed({ evidenceGap: undefined }))).toMatchObject({ ok: false, code: "FLEET_RESEARCH_UNFRAMED" });
    expect(researchCheck(ledger, framed({ informationValue: undefined }))).toMatchObject({ ok: false, code: "FLEET_RESEARCH_UNFRAMED" });
    expect(researchCheck(ledger, framed({ decisionKey: "nope" }))).toMatchObject({ ok: false, code: "FLEET_DECISION_UNKNOWN" });
    expect(researchCheck(ledger, framed())).toMatchObject({ ok: true, decision: { key: "tracker-demand" } });
    // Concise: at most 3 decisions open at once.
    for (let i = 0; i < 2; i++) expect(openDecision(ledger, decisionArgs({ key: `q${i}`, question: `Question number ${i} about a different product?` }))).toMatchObject({ ok: true });
    expect(openDecision(ledger, decisionArgs({ key: "q9", question: "A fourth open question at the same time?" }))).toMatchObject({ ok: false, code: "FLEET_TOO_MANY_OPEN_DECISIONS" });
  });

  it("(6, 10) low-value research terminates; gathered evidence is reused, never re-fetched; the founder's own stop condition ends research", () => {
    const ledger: Decision[] = [];
    openDecision(ledger, decisionArgs());
    expect(researchCheck(ledger, framed({ informationValue: "low" }))).toMatchObject({ ok: false, code: "FLEET_LOW_INFORMATION_VALUE",
      detail: expect.stringMatching(/decide with what you have \(resolve_decision\)/) });
    const d = ledger[0];
    d.research.push({ at: "2026-10-01T00:00:00Z", evidenceGap: "How many landlord compliance templates sold last month on Etsy?", expectedValue: "x", informationValue: "high",
      url: "https://market.example/landlord", attemptId: "att-1" });
    expect(researchCheck(ledger, framed({ evidenceGap: "how many LANDLORD compliance templates sold last month on etsy" }))).toMatchObject({
      ok: false, code: "FLEET_EVIDENCE_ALREADY_GATHERED", detail: expect.stringMatching(/attemptId att-1\): reuse it/) });
    expect(researchCheck(ledger, framed({ evidenceGap: "What price do the top 5 trackers sell at?" }))).toMatchObject({ ok: true });
    d.research.push({ at: "2026-10-01T00:01:00Z", evidenceGap: "What price do the top 5 trackers sell at?", expectedValue: "x", informationValue: "medium", url: "u2", attemptId: "att-2" });
    expect(researchCheck(ledger, framed({ evidenceGap: "Are there reviews complaining about missing features?" }))).toMatchObject({ ok: false, code: "FLEET_DECISION_STOP_REACHED",
      detail: expect.stringMatching(/your own stop condition for tracker-demand is reached \(2 fetch\(es\); "two independent signals of actual purchases"\): decide now/) });
    // What was gathered is in the founder's packet line, with its provenance.
    expect(decisionLines(ledger)[0]).toMatch(/Research: 2\/2 fetch\(es\) \(your stop: two independent signals of actual purchases\); already gathered: "How many landlord compliance templates sold last month on Etsy\?" \(attemptId att-1\)/);
  });

  it("(5, 9) a decision ends in an action; a decided question is closed to research and cannot be reopened under another name", () => {
    const ledger: Decision[] = [];
    openDecision(ledger, decisionArgs());
    for (const missing of ["selected", "rationale", "expectedOutcome", "nextAction"]) {
      expect(resolveDecision(ledger, resolveArgs({ [missing]: undefined })), missing).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
    }
    expect(resolveDecision(ledger, resolveArgs({ ranking: ["a", "b", "c", "d", "e", "f"] }))).toMatchObject({ ok: false, code: "FLEET_SHORTLIST_TOO_LONG" });
    const r = resolveDecision(ledger, resolveArgs());
    expect(r).toMatchObject({ ok: true, decision: { status: "decided", outcome: { selected: "direct checkout page", nextAction: "Publish the tracker on a self-hosted checkout page",
      rejected: [{ option: "Notion template marketplace", reason: "no purchase evidence for compliance templates" }] } } });
    expect(researchCheck(ledger, framed({ evidenceGap: "One more look at Etsy prices?" }))).toMatchObject({ ok: false, code: "FLEET_DECISION_ALREADY_MADE",
      detail: expect.stringMatching(/selected "direct checkout page"; next action: Publish the tracker on a self-hosted checkout page\. Research on this question is closed — execute it\./) });
    expect(openDecision(ledger, decisionArgs({ key: "tracker-demand-2", question: "is there ENOUGH demand for a UK landlord compliance tracker at £9 to launch it" })))
      .toMatchObject({ ok: false, code: "FLEET_DECISION_ALREADY_MADE" });
    expect(resolveDecision(ledger, resolveArgs())).toMatchObject({ ok: false, code: "FLEET_DECISION_ALREADY_MADE" });
    expect(decisionLines(ledger)).toEqual([`Decided tracker-demand: "direct checkout page" (rejected: Notion template marketplace — no purchase evidence for compliance templates). At risk: 500p of your capital (0p committed; downside: At most 500p of hosting and listing costs; fully reversible); invalidated if: No sale after 50 targeted visitors. Next action: Publish the tracker on a self-hosted checkout page. Research on this question is closed: execute, measure, then review_decision.`]);
    // With the decision made and an execution goal open, an idle founder's move is execution, not another search.
    expect(idleKind(ledger, 1)).toBe("execute");
    expect(idleKind([], 0)).toBe("opportunity");
    expect(idleKind([{ ...ledger[0], status: "open" }], 3)).toBe("decide");
  });

  it("an unreadable ledger is an error, never silently 'no decisions'", () => {
    const m = tmp();
    expect(loadDecisions(m)).toEqual([]);
    fs.writeFileSync(path.join(m, "decisions.json"), "{not json");
    expect(() => loadDecisions(m)).toThrow(DecisionLedgerError);
  });
});

// ─────────────────────────────────────────────── the production toolbox (decision-framed web_fetch)

function toolbox(o: { selfGovernance?: boolean; spend?: (order: Record<string, unknown>) => Promise<Record<string, unknown>>; fetchError?: string } = {}) {
  const root = tmp();
  const dirs = { w: path.join(root, "w"), m: path.join(root, "m") };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const calls = { fetch: [] as Array<{ url: string; purpose: string }>, spend: 0, other: 0 };
  let n = 0;
  const box = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: dirs.w, memoryDir: dirs.m, loopGuard: new LoopGuard(), selfGovernance: o.selfGovernance ?? true, ports: {
    ledger: async () => { calls.other++; return {}; }, spendOrder: async (order: Record<string, unknown>) => { calls.spend++; return o.spend ? o.spend(order) : { ok: true, order: { status: "reserved" } }; },
    proposeKnowledge: async () => { calls.other++; return {}; },
    knowledge: async () => [], requestIdentityFact: async () => { calls.other++; return {}; },
    researchFetch: async (p: { url: string; purpose: string }) => {
      calls.fetch.push(p);
      if (o.fetchError) throw Object.assign(new Error(o.fetchError), { code: o.fetchError });
      n++;
      return { attemptId: `att-${n}`, requestedUrl: p.url, finalUrl: p.url, fetchedAt: `2026-10-01T00:0${n}:00Z`, status: 200, contentType: "text/html", bytes: 100, truncated: false,
        sha256: crypto.createHash("sha256").update(p.url).digest("hex"), title: "Marketplace page", text: "42 sold in the last month at £8.99", links: [] };
    },
  } as never });
  let id = 0;
  const run = (name: string, args: Record<string, unknown>) => box.execute({ id: `t${++id}`, name, arguments: args });
  return { box, run, calls, dirs };
}

describe("F2-A research through the founder's own runtime", () => {
  it("(3, 4, 13) only a framed fetch for an open decision reaches FleetController's fetcher — and nothing asks FleetController for permission", async () => {
    const t = toolbox();
    // Unframed research is refused by the founder's runtime before any controller call.
    expect(await t.run("web_fetch", { url: "https://social.example/trending", purpose: "look for interesting trends" })).toMatchObject({ ok: false, refused: "FLEET_RESEARCH_UNFRAMED" });
    expect(await t.run("open_decision", decisionArgs({ purpose: "trends" }))).toMatchObject({ ok: false, refused: "FLEET_RESEARCH_PURPOSE" });
    expect(t.calls.fetch).toEqual([]);
    expect(await t.run("open_decision", decisionArgs())).toMatchObject({ ok: true, output: expect.stringMatching(/^decision tracker-demand open: research only what could change it/) });
    const ok = await t.run("web_fetch", framed());
    expect(ok).toMatchObject({ ok: true, output: expect.stringMatching(/^Decision tracker-demand: 1\/2 research fetch\(es\) used\. As soon as you know enough for the next economically meaningful move, resolve_decision and execute\./) });
    // The fetcher sees a purpose derived from the decision; there is no approval step or any other controller call.
    expect(t.calls.fetch).toEqual([{ url: "https://market.example/landlord", purpose: "[tracker-demand] How many landlord compliance templates sold last month on Etsy?" }]);
    expect([t.calls.spend, t.calls.other]).toEqual([0, 0]);
    expect(loadDecisions(t.dirs.m)[0].research).toEqual([expect.objectContaining({ attemptId: "att-1", url: "https://market.example/landlord", informationValue: "high" })]);
    // An execution step is not research: it needs no decision, only the step it serves.
    expect(await t.run("web_fetch", { url: "https://docs.example/checkout", mode: "execution" })).toMatchObject({ ok: false, refused: "FLEET_BAD_REQUEST" });
    expect(await t.run("web_fetch", { url: "https://docs.example/checkout", mode: "execution", step: "Set up the self-hosted checkout page" })).toMatchObject({ ok: true });
    expect(t.calls.fetch.at(-1)).toEqual({ url: "https://docs.example/checkout", purpose: "execution: Set up the self-hosted checkout page" });
  });

  it("(5, 6, 9, 10) sufficient evidence → decision → execution goal; afterwards the question is closed and nothing is re-fetched", async () => {
    const t = toolbox();
    await t.run("open_decision", decisionArgs());
    await t.run("web_fetch", framed());
    expect(await t.run("web_fetch", framed({ url: "https://market.example/other", evidenceGap: "How many landlord compliance templates sold last month on ETSY" })))
      .toMatchObject({ ok: false, refused: "FLEET_EVIDENCE_ALREADY_GATHERED" });
    expect(await t.run("web_fetch", framed({ url: "https://market.example/tiny", evidenceGap: "Font used on the competitor page", informationValue: "low" })))
      .toMatchObject({ ok: false, refused: "FLEET_LOW_INFORMATION_VALUE" });
    await t.run("web_fetch", framed({ url: "https://market.example/prices", evidenceGap: "What price do the top 5 trackers sell at?" }));
    expect(await t.run("web_fetch", framed({ url: "https://market.example/more", evidenceGap: "Do buyers complain about missing features?" })))
      .toMatchObject({ ok: false, refused: "FLEET_DECISION_STOP_REACHED" });
    expect(t.calls.fetch).toHaveLength(2);
    const decided = await t.run("resolve_decision", resolveArgs());
    expect(decided).toMatchObject({ ok: true, output: 'decision tracker-demand made: "direct checkout page". Goal g1 opened for its next action (Publish the tracker on a self-hosted checkout page). Research on this question is closed — execute.' });
    const goals = JSON.parse(fs.readFileSync(path.join(t.dirs.m, "goals.json"), "utf8"));
    expect(goals).toEqual([expect.objectContaining({ id: "g1", title: "Execute tracker-demand: Publish the tracker on a self-hosted checkout page", status: "open", decision: "tracker-demand" })]);
    expect(loadDecisions(t.dirs.m)[0].outcome).toMatchObject({ goalId: "g1", selected: "direct checkout page" });
    expect(await t.run("web_fetch", framed({ url: "https://market.example/again", evidenceGap: "One more look at Etsy prices" }))).toMatchObject({ ok: false, refused: "FLEET_DECISION_ALREADY_MADE",
      output: expect.stringMatching(/Research on this question is closed — execute it/) });
    expect(await t.run("open_decision", decisionArgs({ key: "tracker-again" }))).toMatchObject({ ok: false, refused: "FLEET_DECISION_ALREADY_MADE" });
    expect(t.calls.fetch).toHaveLength(2);
    expect(t.calls.spend).toBe(0); // deciding spends nothing: capital moves only through an explicit, self-sized commitment
  });

  it("(12) a short runway changes nothing about permission: the founder's runtime never sees runway, and FleetController has no veto on research", async () => {
    // The toolbox has no runway input at all; the same framed fetch runs whatever the founder's position.
    const t = toolbox();
    await t.run("open_decision", decisionArgs());
    expect(await t.run("web_fetch", framed())).toMatchObject({ ok: true });
    // The survival line informs selectivity — it is never a refusal, a ration or a deadline.
    const low = survivalLine(SURVIVAL({ survivalEquityCents: 120, burnPerDayCents: 40, runwayDays: 3 }));
    expect(low).toMatch(/^Your survival position \(FleetController's observation; the risk management is yours\): survival equity 120p; inference 12p today, ≈ 40p\/day over 7 days; runway ≈ 3 days at that burn\./);
    expect(low).toContain(CONSTANT_STANDARD);
    expect(low).not.toMatch(/stop|may not|must not|refus|allowance|only spend/i);
    expect(parseSurvival({ survivalEquityCents: 120, inferenceTodayCents: 12, burnPerDayCents: 40, runwayDays: null })).toMatchObject({ runwayDays: null });
    expect(parseSurvival(LEGACY_ALLOWANCE)).toBeNull(); // a legacy allowance is not a survival observation
  });

  it("the sealed evaluation instruments keep their recorded behaviour (decision framing is the production runtime's setting)", async () => {
    const legacy = toolbox({ selfGovernance: false });
    expect(await legacy.run("web_fetch", { url: "https://x.example/p", purpose: "evaluate the candidate" })).toMatchObject({ ok: true });
    expect(legacy.calls.fetch).toEqual([{ url: "https://x.example/p", purpose: "evaluate the candidate" }]);
    // The production founder runtime turns it on.
    expect(fs.readFileSync(path.resolve("src/fleet/founder/runtime.ts"), "utf8")).toMatch(/new FounderToolbox\(\{[^)]*selfGovernance: true/);
  });
});

// ─────────────────────────────────────────────── the routed founder mind

function rig(o: { deps?: () => unknown; survival?: () => SurvivalView | null; extraStatus?: () => Record<string, unknown>; caps?: () => Record<string, unknown>;
  reply?: (n: number, packet: string) => ToolCall[]; goals?: unknown[]; toolboxPorts?: Record<string, unknown> } = {}) {
  const root = tmp();
  const dirs = { w: path.join(root, "w"), s: path.join(root, "s"), m: path.join(root, "s", "memory") };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  // Founder 1's state as R28 left it: a built product and the goal its prompts taught it ("a channel the owner can enable").
  fs.writeFileSync(path.join(dirs.m, "facts.json"), JSON.stringify({ product: "UK landlord compliance tracker spreadsheet, £9" }));
  fs.writeFileSync(path.join(dirs.m, "goals.json"), JSON.stringify(o.goals ?? [{ id: "g1", title: "Sell the tracker through a sales channel the owner can enable", status: "open" }]));
  const packets: string[] = [];
  const fetches: Array<{ url: string; purpose: string }> = [];
  const spend = { n: 0 };
  let n = 0;
  const ports: MindPorts = {
    cognitionStatus: async () => {
      const s = o.survival ? o.survival() : SURVIVAL();
      return { policyEnabled: true, provider: "anthropic", founderEnabled: true, paused: false, routing: { active: true },
        capabilities: capabilityView(o.caps?.() ?? CAPS(), true), ...(s ? { survival: s } : {}), ...(o.extraStatus?.() ?? {}) };
    },
    ledger: async () => ({ cash: 9_188, genesisAllocation: 10_000, survivalEquity: 9_188 }),
    ...(o.deps ? { ownerRequests: async () => o.deps!() } : {}),
    infer: async (messages) => {
      const packet = String((messages as Array<{ content: string }>)[0].content);
      packets.push(packet);
      n++;
      return { content: "", toolCalls: o.reply?.(n, packet) ?? [{ id: `t${n}`, name: "sleep", arguments: { reason: "nothing to do" } }], usage: { inputTokens: 1, outputTokens: 1 },
        chargedCents: 0, requestId: `r${n}` };
    },
  };
  const loopGuard = new LoopGuard();
  const toolbox = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: dirs.w, memoryDir: dirs.m, loopGuard, selfGovernance: true, ports: {
    ledger: async () => ({}), spendOrder: async () => { spend.n++; return {}; }, proposeKnowledge: async () => ({}), knowledge: async () => [], requestIdentityFact: async () => ({}),
    ownerRequestCreate: async () => ({ ok: true }), ownerRequestWithdraw: async () => ({ ok: true }),
    researchFetch: async (p: { url: string; purpose: string }) => {
      fetches.push(p);
      return { attemptId: `att-${fetches.length}`, requestedUrl: p.url, finalUrl: p.url, fetchedAt: "2026-10-01T00:00:00Z", status: 200, contentType: "text/html", bytes: 10, truncated: false,
        sha256: crypto.createHash("sha256").update(p.url).digest("hex"), title: "t", text: "37 sold this month", links: [] };
    },
    ...(o.toolboxPorts ?? {}),
  } as never });
  const mind = new FounderMind({ ports, toolbox, stateDir: dirs.s, routed: { memoryDir: dirs.m, workspaceDir: dirs.w, manifest: FOUNDER_MANIFEST_V2, loopGuard } });
  const parse = (text: string) => {
    const body = JSON.parse(text.split("\n").slice(3).join("\n"));
    expect(taskPacketProblems(body)).toEqual([]);
    const task = String(body.task);
    return { text, body, task, slim: /Nothing has changed since your last turn/.test(task), idle: /^Idle wake/m.test(task),
      opportunity: task.includes(OPPORTUNITY_CYCLE) };
  };
  /** Turn until the next inference call happens (thinking slots skipped by the idle backoff cost nothing). */
  const next = async () => {
    const before = packets.length;
    for (let i = 0; i <= MAX_IDLE_SKIP + 1 && packets.length === before; i++) await mind.turn(`heartbeat ${i}`);
    expect(packets.length).toBe(before + 1);
    return parse(packets.at(-1)!);
  };
  return { mind, next, parse, dirs, packets, fetches, spend };
}
type Rig = ReturnType<typeof rig>;
const seq = async (r: Rig, k: number) => { const out = []; for (let i = 0; i < k; i++) out.push(await r.next()); return out; };
/** Indices of the packets that were not slim among the first k (the idle schedule). */
const fullAt = async (r: Rig, k: number) => (await seq(r, k)).map((p, i) => (p.slim ? -1 : i)).filter((i) => i >= 0);

describe("F2-A dependencies in the founder loop", () => {
  it("an unresolved dependency never escalates: its age changes nothing, only its status does (one full packet)", async () => {
    let age = 3_600;
    const growing = rig({ deps: () => ({ ok: true, requests: [gumroadDep({ ageS: age })] }) });
    const constant = rig({ deps: () => ({ ok: true, requests: [gumroadDep({ ageS: 3_600 })] }) });
    const a: boolean[] = [];
    const b: boolean[] = [];
    for (let i = 0; i < 20; i++) {
      age = (i + 1) * 20 * 86_400; // up to 400 days
      const x = await growing.next();
      a.push(x.slim);
      expect(x.task).toContain("This blocks only that action");
      expect(x.task).not.toMatch(/keep waiting|STALE|owner decides|awaiting (the )?owner/i);
      b.push((await constant.next()).slim);
    }
    expect(a).toEqual(b); // identical packet schedule: time alone never produces a packet
    let status = "pending";
    const r = rig({ deps: () => ({ ok: true, requests: [gumroadDep({ status, response: status === "answered" ? "The fleet storefront will host it." : null, decidedAt: status === "answered" ? new Date().toISOString() : null })] }) });
    await seq(r, 2);
    status = "answered";
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
    expect(await box.execute({ id: "toolu_1", name: "record_external_dependency", arguments: { kind: "kyc", action: "List on Gumroad", title: "Gumroad seller account",
      detail: "Needs a human identity; selling direct meanwhile.", goalId: "g1" } })).toMatchObject({ ok: true });
    expect(sent[0]).toEqual({ idempotencyKey: "dep:toolu_1", kind: "kyc", action: "List on Gumroad", goalRef: "g1", title: "Gumroad seller account", detail: "Needs a human identity; selling direct meanwhile." });
    const ordinary = await box.execute({ id: "toolu_2", name: "record_external_dependency", arguments: { kind: "sales_channel", action: "Pick a channel", title: "t", detail: "d" } });
    expect(ordinary).toMatchObject({ ok: false, refused: "FLEET_NOT_AN_EXCEPTION" });
    expect(await box.execute({ id: "toolu_3", name: "record_external_dependency", arguments: { kind: "kyc", title: "t", detail: "d" } })).toMatchObject({ ok: false, refused: "FLEET_BAD_REQUEST" });
    await box.execute({ id: "toolu_4", name: "record_external_dependency", arguments: { kind: "kyc", action: "a", title: "t", detail: "d", goalId: "not-a-goal", blocking: true } });
    expect(sent.at(-1)).toEqual({ idempotencyKey: "dep:toolu_4", kind: "kyc", action: "a", goalRef: null, title: "t", detail: "d" }); // no blocking flag exists
    expect(await box.execute({ id: "toolu_5", name: "withdraw_external_dependency", arguments: { requestId: GUMROAD } })).toMatchObject({ ok: true });
    expect(await box.execute({ id: "toolu_6", name: "withdraw_external_dependency", arguments: { requestId: "../x" } })).toMatchObject({ ok: false, refused: "FLEET_BAD_REQUEST" });
    const limited = rig({ toolboxPorts: { ownerRequestCreate: async () => { throw Object.assign(new Error("FLEET_LIMIT_REACHED"), { code: "FLEET_LIMIT_REACHED" }); } } });
    const lbox = (limited.mind as unknown as { o: { toolbox: FounderToolbox } }).o.toolbox;
    expect(await lbox.execute({ id: "toolu_7", name: "record_external_dependency", arguments: { kind: "kyc", action: "a", title: "t", detail: "d" } })).toMatchObject({ ok: false, refused: "FLEET_LIMIT_REACHED" });
  });

  it("R28 semantic capability-change detection is preserved: the upgrade names the new and renamed tools exactly once", async () => {
    const r = rig({ deps: () => ({ ok: true, requests: [gumroadDep()] }) });
    const current = capabilityView(CAPS(), true).tools;
    const r28Tools = current.filter((t) => !["open_decision", "resolve_decision", "review_decision"].includes(t))
      .map((t) => (t === "record_external_dependency" ? "request_owner_decision" : t === "withdraw_external_dependency" ? "withdraw_owner_request" : t)).sort();
    fs.writeFileSync(path.join(r.dirs.s, "mind-continuity.json"), JSON.stringify({ at: "2026-10-01T15:32:23.972Z", turn: 12, outcome: "sleep: Gumroad 62cbe1b7 still pending.",
      tools: ["sleep"], wakeDigest: "0".repeat(64), capabilities: { sig: "1".repeat(64), tools: r28Tools } }));
    const [first, second] = await seq(r, 2);
    expect(first.slim).toBe(false);
    expect(first.task).toMatch(/Your capabilities changed since your last turn\. Newly available: open_decision, record_external_dependency, resolve_decision, review_decision, withdraw_external_dependency\. No longer available: request_owner_decision, withdraw_owner_request\./);
    expect(first.task).toContain("This blocks only that action");
    expect(second.slim).toBe(true);
    expect(second.task).not.toMatch(/capabilit/i);
  });
});

describe("F2-A idle semantics: the next economically meaningful move, never a browse", () => {
  it("(11, 2) idle is not endless search: one push per idle state, re-checked after 4, 8, 16, then every 32 slim wakes — and no daily entitlement re-triggers it", async () => {
    let s = SURVIVAL();
    const extra: Record<string, unknown> = {};
    const r = rig({ goals: [], survival: () => s, extraStatus: () => extra });
    const first = await r.next();
    expect(first).toMatchObject({ slim: false, opportunity: true });
    expect(first.task).toContain(`No open decision and no execution path. ${OPPORTUNITY_CYCLE}`);
    expect(first.task).toMatch(/Your survival position \(FleetController's observation; the risk management is yours\)/);
    // A "new day" (today's inference back to 0) and a legacy allowance object from an older controller change nothing.
    s = SURVIVAL({ inferenceTodayCents: 0 });
    extra.discovery = { allowed: true, budgetCents: 300, spentTodayCents: 0, runwayDays: 400, reason: "allowed" };
    const rest = (await fullAt(r, 64)).map((i) => i + 1);
    expect([RENUDGE_FIRST, RENUDGE_MAX]).toEqual([4, 32]);
    expect(rest).toEqual([5, 14, 31, 64]); // after 4, 8, 16 and 32 slim wakes
    expect(r.mind.routing.idleNudges).toEqual({ decide: 0, execute: 0, opportunity: 4 });
    const idle = r.parse(r.packets[5]);
    expect(idle.task).toContain(`Idle wake with no open decision and no execution path. ${OPPORTUNITY_CYCLE}`);
    expect(r.fetches).toEqual([]); // nothing was fetched just because the founder was idle
    // Bounded: the next 32 slim wakes, then one push again (the cap holds).
    expect((await fullAt(r, 33)).map((i) => i + 65)).toEqual([97]);
  });

  it("(1, 12) no runway shutdown: at 3 days or 400 days of runway the founder gets the same moves; only its own selectivity guidance is informed", async () => {
    for (const runwayDays of [3, 400, null]) {
      const r = rig({ goals: [], survival: () => SURVIVAL({ runwayDays, survivalEquityCents: runwayDays === 3 ? 120 : 9_188 }), extraStatus: () => ({ discovery: LEGACY_ALLOWANCE }) });
      const [first] = await seq(r, 1);
      expect(first.opportunity, String(runwayDays)).toBe(true);
      expect(first.task).toMatch(runwayDays === null ? /≈ 40p\/day over 7 days\. Runway changes which opportunities/ : new RegExp(`runway ≈ ${runwayDays} days at that burn`));
      expect(first.task).not.toMatch(/revenue-first|discovery floor|may not research|allowance/);
      expect((await fullAt(r, 5)).map((i) => i + 1)).toEqual([5]); // the same idle schedule at any runway
    }
  });

  it("(3, 5, 9, 10) target → evidence → decision → execution: an open decision drives research, a decision ends it, the next move is execution", async () => {
    const r = rig({ goals: [], reply: (n) => {
      if (n === 1) return [{ id: "a1", name: "open_decision", arguments: decisionArgs() }, { id: "a2", name: "sleep", arguments: { reason: "decision opened" } }];
      if (n === 2) return [{ id: "b1", name: "web_fetch", arguments: framed() }, { id: "b2", name: "sleep", arguments: { reason: "one fact in" } }];
      if (n === 3) return [{ id: "c1", name: "resolve_decision", arguments: resolveArgs() }, { id: "c2", name: "sleep", arguments: { reason: "decided" } }];
      if (n === 4) return [{ id: "d1", name: "web_fetch", arguments: framed({ url: "https://market.example/again", evidenceGap: "One more look at Etsy prices" }) }, { id: "d2", name: "sleep", arguments: { reason: "x" } }];
      return [{ id: `s${n}`, name: "sleep", arguments: { reason: "executing next turn" } }];
    } });
    const [p1, p2, p3, p4, p5] = await seq(r, 5);
    expect(p1.opportunity).toBe(true);
    expect(p2.task).toMatch(/Open decision tracker-demand \(find_opportunity, objective: First £200 of tracker revenue within 30 days\): "Is there enough demand for a UK landlord compliance tracker at £9 to launch it\?" .* Shortlist: direct checkout page \| Etsy listing \| Notion template marketplace\. Research: 0\/2 fetch\(es\)/);
    expect(p2.task).toMatch(/Do you know enough to make the next economically meaningful move\? If yes, resolve_decision and execute; if no, fetch the ONE highest-value missing fact\./);
    expect(p2.opportunity).toBe(false); // an open decision is the move: no new cycle on top of it
    expect(p3.task).toMatch(/Research: 1\/2 fetch\(es\) .*already gathered: "How many landlord compliance templates sold last month on Etsy\?" \(attemptId att-1\)/);
    expect(p4.task).toContain(`Decided tracker-demand: "direct checkout page" (rejected: Notion template marketplace — no purchase evidence for compliance templates). At risk: 500p of your capital (0p committed; downside: At most 500p of hosting and listing costs; fully reversible); invalidated if: No sale after 50 targeted visitors. Next action: Publish the tracker on a self-hosted checkout page [goal g1]. Research on this question is closed: execute, measure, then review_decision.`);
    expect(p4.task).toContain("Your open goals are your execution path: take the next concrete step toward a sale.");
    expect(p4.opportunity).toBe(false);
    expect(p4.body.objective).toEqual([expect.objectContaining({ id: "g1", title: "Execute tracker-demand: Publish the tracker on a self-hosted checkout page" })]);
    expect(r.fetches).toHaveLength(1); // the decided question was not researched again (turn 4 was refused by the runtime)
    expect(p5.task).toContain("Decided tracker-demand");
    expect(r.spend.n).toBe(0);
  });

  it("(7) unresolved Gumroad does not block alternative execution: the founder decides on a direct route and executes while Gumroad stays open", async () => {
    let deps = [gumroadDep()];
    const r = rig({ deps: () => ({ ok: true, requests: deps }), reply: (n, packet) => {
      if (n === 1 && packet.includes("Your open goals are your execution path")) {
        return [{ id: "a1", name: "open_decision", arguments: decisionArgs({ key: "tracker-channel", purpose: "expand_venture", question: "Which channel that needs no new account sells the tracker fastest?",
          options: ["self-hosted checkout page", "Etsy listing"], stopAfterFetches: 1, stopWhen: "one channel with purchase evidence" }) },
        { id: "a2", name: "resolve_decision", arguments: resolveArgs({ key: "tracker-channel", selected: "self-hosted checkout page", rejected: [], ranking: [] }) },
        { id: "a3", name: "sleep", arguments: { reason: "executing the direct route" } }];
      }
      return [{ id: `s${n}`, name: "sleep", arguments: { reason: "x" } }];
    } });
    const p1 = await r.next();
    expect(p1.task).toContain("This blocks only that action");
    expect(p1.task).toContain("Your open goals are your execution path");
    const p2 = await r.next();
    expect(p2.task).toContain(`External dependency 62cbe1b7 (kyc): the action "${GUMROAD_ACTION}" is unavailable for now.`);
    expect(p2.task).toContain('Decided tracker-channel: "self-hosted checkout page"');
    expect(p2.body.objective.map((g: { id: string }) => g.id)).toEqual(["g1", "g2"]); // the original goal and the execution goal
    expect(deps[0].status).toBe("pending"); // nothing was decided by, or asked of, the owner
    deps = [gumroadDep()];
  });
});

describe("F2-A professional self-governance (constitutional, owner-resolved 2026-10-01)", () => {
  /** Every parameter name anywhere in a JSON schema. */
  const paramNames = (schema: unknown): string[] => {
    if (!schema || typeof schema !== "object") return [];
    const o = schema as Record<string, unknown>;
    const props = (o.properties ?? {}) as Record<string, unknown>;
    return [...Object.keys(props), ...Object.values(props).flatMap(paramNames), ...paramNames(o.items)];
  };

  it("(1, 2) opportunity ranking and selection are the founder's: no Fleet-wide weights or scores exist, and the ledger stores the founder's own choice verbatim", async () => {
    const decisions = await import("../../fleet/founder/decisions.js");
    expect(Object.keys(decisions).filter((k) => /weight|score|rubric|formula/i.test(k))).toEqual([]);
    for (const t of [...FOUNDER_TOOLS, ...FOUNDER_ROUTED_TOOLS, ...FOUNDER_EXPERIMENT_TOOLS]) {
      expect(paramNames(t.parameters).filter((k) => /weight|score/i.test(k)), t.name).toEqual([]);
    }
    expect(V26_SQL.replace(/--[^\n]*/g, "")).not.toMatch(/weight|score/i);
    // The founder ranks the direct page first but selects the cheapest path for its wallet: stored exactly as given.
    const t = toolbox();
    await t.run("open_decision", decisionArgs());
    const ranking = ["direct checkout page", "Etsy listing", "Notion template marketplace"];
    expect(await t.run("resolve_decision", resolveArgs({ ranking, selected: "Notion template marketplace", rationale: "Lowest capital at risk for my current wallet; demand is adequate.",
      capitalAtRiskPence: 0, rejected: [] }))).toMatchObject({ ok: true });
    expect(loadDecisions(t.dirs.m)[0].outcome).toMatchObject({ selected: "Notion template marketplace", ranking });
    // Nothing was asked of FleetController to rank, select or approve.
    expect([t.calls.fetch.length, t.calls.spend, t.calls.other]).toEqual([0, 0, 0]);
  });

  it("(6, 7) the founder sizes its own downside before committing its own capital; its runtime holds it to that sizing; FleetController is not asked", async () => {
    const t = toolbox();
    await t.run("open_decision", decisionArgs());
    // No sizing, no decision: a resolve without capital at risk, downside and invalidation is refused.
    expect(await t.run("resolve_decision", resolveArgs({ capitalAtRiskPence: undefined }))).toMatchObject({ ok: false, refused: "FLEET_RISK_UNSIZED" });
    expect(await t.run("resolve_decision", resolveArgs({ invalidatedBy: undefined }))).toMatchObject({ ok: false, refused: "FLEET_RISK_UNSIZED" });
    const spend = (amountCents: number, decisionKey?: string) => t.run("request_spend", { amountCents, category: "expense", destinationId: "dst_hosting", purpose: "checkout hosting", ...(decisionKey ? { decisionKey } : {}) });
    // Committing own capital outside a decided, sized decision is refused by the founder's own runtime.
    expect(await spend(300)).toMatchObject({ ok: false, refused: "FLEET_COMMITMENT_UNDECIDED" });
    expect(await spend(300, "tracker-demand")).toMatchObject({ ok: false, refused: "FLEET_COMMITMENT_UNDECIDED" }); // still open
    expect([t.calls.spend, t.calls.other]).toEqual([0, 0]); // every risk decision so far stayed with the founder
    await t.run("resolve_decision", resolveArgs()); // 500p at risk, sized by the founder
    expect(await spend(300, "tracker-demand")).toMatchObject({ ok: true });
    expect(await spend(300, "tracker-demand")).toMatchObject({ ok: false, refused: "FLEET_EXPOSURE_EXCEEDED",
      output: expect.stringMatching(/you sized tracker-demand at 500p of capital at risk and have committed 300p: 300p more exceeds your own limit/) });
    expect(await spend(200, "tracker-demand")).toMatchObject({ ok: true });
    expect(t.calls.spend).toBe(2); // only the two commitments within the founder's own sizing reached the custodian
    expect(loadDecisions(t.dirs.m)[0].outcome).toMatchObject({ capitalAtRiskPence: 500, committedPence: 500 });
  });

  it("(8) FleetController still protects treasury, shared, restricted and protected capital: self-governance never bypasses custody", async () => {
    // A commitment within the founder's sizing still goes through the custodian, which may refuse it on its own rules.
    const t = toolbox({ spend: async () => { throw Object.assign(new Error("FLEET_PROTECTED_CAPITAL"), { code: "FLEET_PROTECTED_CAPITAL" }); } });
    await t.run("open_decision", decisionArgs());
    await t.run("resolve_decision", resolveArgs());
    expect(await t.run("request_spend", { amountCents: 300, category: "expense", destinationId: "dst_hosting", purpose: "checkout hosting", decisionKey: "tracker-demand" }))
      .toMatchObject({ ok: false, refused: "FLEET_PROTECTED_CAPITAL", output: expect.stringMatching(/^ERROR FLEET_PROTECTED_CAPITAL/) });
    expect(loadDecisions(t.dirs.m)[0].outcome).toMatchObject({ committedPence: 0 }); // a refused order commits nothing
    // The registry's custody checks are intact and defined once (no later migration replaced them) — and v26 touches none.
    const all = PG_MIGRATIONS.map((m) => m.sql).join("\n");
    expect(all.match(/FUNCTION fleet_order_hard_check\(/g)).toHaveLength(1);
    const hard = all.slice(all.indexOf("FUNCTION fleet_order_hard_check("), all.indexOf("END $$;", all.indexOf("FUNCTION fleet_order_hard_check(")));
    for (const code of ["FLEET_PROTECTED_CAPITAL", "FLEET_INSUFFICIENT_ALLOCATION", "FLEET_INSUFFICIENT_TREASURY", "FLEET_DESTINATION_NOT_ALLOWED", "FLEET_SPENDING_FROZEN", "FLEET_AGENT_HELD"]) {
      expect(hard, code).toContain(code);
    }
    expect(V26_SQL).not.toMatch(/api_spend_request|fleet_order_|fleet_ledger_post|payment|treasury|obligation|reserve/i);
    // Fleet / shared capital (experiments) stays FleetController's to assess: the founder never approves or resizes it.
    expect(FOUNDER_EXPERIMENT_TOOLS.find((x) => x.name === "propose_experiment")!.description).toMatch(/FleetController then decides the evidence level, the budget .* and never lets you approve or resize it/);
  });

  it("(3, 4, 5) the same professional discipline at any runway: no broader research when rich, no panic when poor, identical information-value refusals", async () => {
    const flow = (runwayDays: number) => rig({ goals: [], survival: () => SURVIVAL({ runwayDays, survivalEquityCents: runwayDays > 100 ? 900_000 : 80 }), reply: (n) => {
      if (n === 1) return [{ id: "a", name: "open_decision", arguments: decisionArgs() }, { id: "a2", name: "sleep", arguments: { reason: "x" } }];
      if (n === 2) return [{ id: "b", name: "web_fetch", arguments: framed({ url: "https://x.example/font", evidenceGap: "Font of the competitor page", informationValue: "low" }) },
        { id: "b2", name: "web_fetch", arguments: framed() }, { id: "b3", name: "sleep", arguments: { reason: "x" } }];
      if (n === 3) return [{ id: "c", name: "web_fetch", arguments: framed({ url: "https://x.example/p2", evidenceGap: "Top-5 tracker prices" }) },
        { id: "c2", name: "web_fetch", arguments: framed({ url: "https://x.example/p3", evidenceGap: "One more marketplace" }) }, { id: "c3", name: "sleep", arguments: { reason: "x" } }];
      return [{ id: `s${n}`, name: "sleep", arguments: { reason: "x" } }];
    } });
    const rich = flow(5_000);
    const poor = flow(2);
    const a = await seq(rich, 12);
    const b = await seq(poor, 12);
    // Same fetches (low value refused, stop condition honoured), same packet schedule, same moves.
    expect(rich.fetches.map((f) => f.url)).toEqual(["https://market.example/landlord", "https://x.example/p2"]);
    expect(poor.fetches.map((f) => f.url)).toEqual(rich.fetches.map((f) => f.url));
    expect(a.map((p) => [p.slim, p.idle, p.opportunity])).toEqual(b.map((p) => [p.slim, p.idle, p.opportunity]));
    for (const p of [...a, ...b].filter((x) => !x.slim)) {
      expect(p.task).toContain(CONSTANT_STANDARD);
      expect(p.task).not.toMatch(/urgent|emergency|hurry|panic mode|revenue-only|explore freely|plenty of runway/i);
    }
    // Only the figures differ: the guidance is word-for-word the same at 2 and 5 000 days.
    const strip = (t: string) => t.replace(/survival equity \d+p/g, "").replace(/runway ≈ \d+ days/g, "");
    expect(strip(a[0].task)).toBe(strip(b[0].task));
  });

  it("(9, 10) quota availability is never a reason to research; the ceilings stay, as infrastructure failsafes only", async () => {
    // A status reporting plenty of unused quota and inference ceiling changes nothing the founder is asked to do.
    const quiet = rig({ goals: [] });
    const loud = rig({ goals: [], extraStatus: () => ({ dailyBudgetCents: 100_000, spentTodayCents: 0, research: { founderHourlyRemaining: 60, founderDailyRemaining: 300 } }) });
    const q = await seq(quiet, 10);
    const l = await seq(loud, 10);
    expect(l.map((p) => [p.slim, p.idle])).toEqual(q.map((p) => [p.slim, p.idle]));
    expect([...loud.fetches, ...quiet.fetches]).toEqual([]);
    for (const p of l) expect(p.task).not.toMatch(/quota|ceiling|remaining|searches|budget/i);
    // No founder-facing text mentions quotas or ceilings as something to use.
    const texts = [FOUNDER_CHARTER, FOUNDER_ROUTED_ADDENDUM, ...PACKET_POLICY, OPPORTUNITY_CYCLE, CONSTANT_STANDARD,
      ...[...FOUNDER_TOOLS, ...FOUNDER_ROUTED_TOOLS, ...FOUNDER_EXPERIMENT_TOOLS].map((t) => `${t.description} ${JSON.stringify(t.parameters)}`)];
    for (const text of texts) expect(text).not.toMatch(/quota|ceiling|searches (per|a) day|fetches (per|a) day|daily budget/i);
    // The ceilings themselves remain (unchanged by v26), and a hit reads as a safety limit, never a budget.
    const all = PG_MIGRATIONS.map((m) => m.sql).join("\n");
    for (const re of [/founder_hourly\s+integer\s+NOT NULL DEFAULT 60/, /founder_daily\s+integer\s+NOT NULL DEFAULT 300/, /default_daily_budget_cents/, /'FLEET_COGNITION_BUDGET_EXHAUSTED'/]) expect(all).toMatch(re);
    expect(V26_SQL).not.toMatch(/fleet_research_policy|fleet_cognition_policy|fleet_founder_cognition|fleet_founder_research/);
    for (const code of ["FLEET_RESEARCH_QUOTA_HOURLY", "FLEET_RESEARCH_QUOTA_DAILY", "FLEET_COGNITION_BUDGET_EXHAUSTED"]) expect(INFRA_CEILING.test(code), code).toBe(true);
    const t = toolbox({ fetchError: "FLEET_RESEARCH_QUOTA_DAILY" });
    await t.run("open_decision", decisionArgs());
    const hit = await t.run("web_fetch", framed());
    expect(hit).toMatchObject({ ok: false, refused: "FLEET_RESEARCH_QUOTA_DAILY" });
    expect(hit.output).toMatch(/^INFRASTRUCTURE CEILING FLEET_RESEARCH_QUOTA_DAILY: a safety limit against runaway loops, bugs and provider abuse — not a research budget or a target\. Decide with the evidence you have/);
  });

  it("(11, 12, 15) an evidence-invalidated path may pivot; the pivot records why; it is followed at once by a concrete forward action", async () => {
    const t = toolbox();
    await t.run("open_decision", decisionArgs());
    await t.run("web_fetch", framed());
    await t.run("resolve_decision", resolveArgs());
    const pivot = { key: "tracker-demand", verdict: "corrected", actual: "0 sales from 64 targeted visitors in 10 days", failedAssumption: "Landlords buy compliance trackers from a direct checkout page",
      evidence: ["checkout analytics: 64 visitors, 0 purchases, 2026-10-12", "att-9: Etsy listing data shows 37 tracker sales last month"], learning: "Buyers search marketplaces, not the open web, for this product",
      impact: "Etsy fees (~10 %) are smaller than an unsellable direct page; expected first sale moves from never to ~14 days", newPath: "Etsy listing", nextAction: "List the tracker on Etsy at £9 with the landlord keywords" };
    const r = await t.run("review_decision", pivot);
    expect(r).toMatchObject({ ok: true, output: 'tracker-demand corrected on new evidence: "direct checkout page" → "Etsy listing". Goal g2 opened for the forward action (List the tracker on Etsy at £9 with the landlord keywords).' });
    const d = loadDecisions(t.dirs.m)[0];
    expect(d.outcome).toMatchObject({ selected: "Etsy listing", nextAction: "List the tracker on Etsy at £9 with the landlord keywords", goalId: "g2" });
    expect(d.reviews).toEqual([expect.objectContaining({ verdict: "corrected", previousPath: "direct checkout page", newPath: "Etsy listing", failedAssumption: pivot.failedAssumption,
      evidence: pivot.evidence, learning: pivot.learning, impact: pivot.impact, nextAction: pivot.nextAction, goalId: "g2" })]);
    // The superseded step is closed with what was measured; the forward step is the open goal.
    const goals = JSON.parse(fs.readFileSync(path.join(t.dirs.m, "goals.json"), "utf8"));
    expect(goals).toEqual([expect.objectContaining({ id: "g1", status: "complete", outcome: "superseded by a correction: 0 sales from 64 targeted visitors in 10 days" }),
      expect.objectContaining({ id: "g2", status: "open", title: "Corrected tracker-demand: List the tracker on Etsy at £9 with the landlord keywords" })]);
    expect(decisionLines(loadDecisions(t.dirs.m))[0]).toMatch(/Corrected \d{4}-\d{2}-\d{2}: "direct checkout page" → "Etsy listing" — Landlords buy compliance trackers from a direct checkout page failed \(Buyers search marketplaces, not the open web, for this product\); impact: Etsy fees .* Next action: List the tracker on Etsy at £9 with the landlord keywords \[goal g2\]/);
    // A confirmed result also closes the step and opens the next forward one (measure → learn → forward).
    expect(await t.run("review_decision", { key: "tracker-demand", verdict: "confirmed", actual: "11 sales in 14 days on Etsy at £9", learning: "Marketplace demand holds",
      nextAction: "Add a premium HMO edition at £19" })).toMatchObject({ ok: true, output: expect.stringMatching(/confirmed: 11 sales in 14 days on Etsy at £9\. Goal g3 opened/) });
  });

  it("(13) unsupported oscillation is refused: no correction without new evidence, none to the same path, no return to an abandoned path, at most three", async () => {
    const ledger: Decision[] = [];
    openDecision(ledger, decisionArgs());
    ledger[0].research.push({ at: "t", evidenceGap: "gap", expectedValue: "v", informationValue: "high", url: "https://market.example/landlord", attemptId: "att-1" });
    expect(reviewDecision(ledger, { key: "tracker-demand", verdict: "confirmed", actual: "x sales", learning: "it holds", nextAction: "keep going" })).toMatchObject({ ok: false, code: "FLEET_DECISION_OPEN" });
    resolveDecision(ledger, resolveArgs());
    const correct = (o: Record<string, unknown>) => reviewDecision(ledger, { key: "tracker-demand", verdict: "corrected", actual: "0 sales", learning: "the channel is wrong",
      failedAssumption: "direct buyers exist", impact: "lower fees beat no sales", nextAction: "list it there", ...o });
    expect(correct({ newPath: "direct checkout page", evidence: ["new data"] })).toMatchObject({ ok: false, code: "FLEET_NOT_A_CORRECTION" });
    expect(correct({ newPath: "Etsy listing", evidence: [] })).toMatchObject({ ok: false, code: "FLEET_CORRECTION_UNSUPPORTED" });
    expect(correct({ newPath: "Etsy listing", evidence: ["att-1", "https://market.example/landlord"] })).toMatchObject({ ok: false, code: "FLEET_CORRECTION_UNSUPPORTED" }); // what it decided with
    expect(correct({ newPath: "Etsy listing", evidence: ["checkout: 64 visitors, 0 purchases"], failedAssumption: undefined })).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
    expect(correct({ newPath: "Etsy listing", evidence: ["checkout: 64 visitors, 0 purchases"] })).toMatchObject({ ok: true });
    // Back to the abandoned path, even with fresh-looking evidence: oscillation.
    expect(correct({ newPath: "Direct checkout page", evidence: ["a blog post says direct sales work"] })).toMatchObject({ ok: false, code: "FLEET_OSCILLATION" });
    // Re-citing the evidence that drove the last correction is not new evidence.
    expect(correct({ newPath: "Notion template marketplace", evidence: ["checkout: 64 visitors, 0 purchases"] })).toMatchObject({ ok: false, code: "FLEET_CORRECTION_UNSUPPORTED" });
    expect(correct({ newPath: "Notion template marketplace", evidence: ["etsy: 0 sales in 21 days"] })).toMatchObject({ ok: true });
    expect(correct({ newPath: "Gumtree listing", evidence: ["notion: 0 sales in 21 days"] })).toMatchObject({ ok: true });
    expect(correct({ newPath: "Facebook marketplace", evidence: ["gumtree: 0 sales"] })).toMatchObject({ ok: false, code: "FLEET_CORRECTION_LIMIT",
      detail: expect.stringMatching(/stop re-deciding it — open a new, narrower decision/) });
    // More capital needs new evidence that justifies it; less is always allowed (preserve capital).
    const confirm = (o: Record<string, unknown>) => reviewDecision(ledger, { key: "tracker-demand", verdict: "confirmed", actual: "2 sales this week", learning: "demand is slow but real", nextAction: "continue listing", ...o });
    expect(confirm({ capitalAtRiskPence: 5_000, evidence: [] })).toMatchObject({ ok: false, code: "FLEET_EXPOSURE_UNSUPPORTED" });
    expect(confirm({ capitalAtRiskPence: 100 })).toMatchObject({ ok: true, decision: { outcome: { capitalAtRiskPence: 100 } } });
    expect(confirm({ capitalAtRiskPence: 2_000, evidence: ["gumtree: 9 sales at £9 in 7 days"] })).toMatchObject({ ok: true, decision: { outcome: { capitalAtRiskPence: 2_000 } } });
    expect(commitmentCheck(ledger, { decisionKey: "tracker-demand" }, 2_001)).toMatchObject({ ok: false, code: "FLEET_EXPOSURE_EXCEEDED" });
  });
});

describe("F2-A proof: owner absence cannot freeze a founder", () => {
  it("(8) 30 simulated days (1 440 thinking slots a day), zero owner actions, Gumroad unresolved, a founder that always sleeps: a next move every day, bounded cost", async () => {
    const ownerActions: string[] = [];
    let runway = 229.7;
    const r = rig({ deps: () => ({ ok: true, requests: [gumroadDep()] }), survival: () => SURVIVAL({ runwayDays: runway }) });
    const ports = (r.mind as unknown as { o: { ports: MindPorts & { ownerDecide?: () => void } } }).o.ports;
    ports.ownerDecide = () => ownerActions.push("decide"); // present, never called: the owner is absent
    const perDay: Array<{ calls: number; pushes: number }> = [];
    const SLOTS_PER_DAY = 1_440;
    for (let day = 0; day < 30; day++) {
      runway = Math.max(1, 229.7 - day * 8); // capital tightens; nothing switches off
      const before = r.packets.length;
      for (let s = 0; s < SLOTS_PER_DAY; s++) await r.mind.turn(`day ${day} slot ${s}`);
      const today = r.packets.slice(before).map((t) => r.parse(t));
      perDay.push({ calls: today.length, pushes: today.filter((p) => !p.slim).length });
      for (const p of today) {
        expect(p.task).toContain("This blocks only that action"); // the dependency is visible every time, as one action
        expect(p.task).not.toMatch(/keep waiting|STALE|owner decides|awaiting (the )?owner|ask the owner/i);
        if (!p.slim) expect(p.task).toMatch(/Your open goals are your execution path|Idle wake: your open goals are your execution path/);
      }
    }
    expect(ownerActions).toEqual([]);
    // Every single day the founder was pushed toward its next move at least once…
    expect(perDay.every((d) => d.pushes >= 1), JSON.stringify(perDay)).toBe(true);
    // …and an idle founder is cheap: no endless search (at most ~43 thinking calls and a handful of full packets a day).
    expect(perDay.every((d) => d.calls <= 50 && d.pushes <= 6), JSON.stringify(perDay)).toBe(true);
    expect(r.fetches).toEqual([]);
  });

  it("the slim packet invites the next move or sleep — no allowance, no 'otherwise sleep' attractor", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "m"));
    fs.mkdirSync(path.join(root, "w"));
    const slim = slimWakePacket(buildTaskPacket({ memoryDir: path.join(root, "m"), workspaceDir: path.join(root, "w"), task: "t", economics: {},
      outputContract: { form: "analysis", mustCite: false, instructions: "Decide." } }));
    expect(slim.task).toMatch(/If this leaves an economically meaningful move, read what you need .* and make it; if not, sleep — the same state is re-checked later, and any change brings a full packet\.$/);
    expect(slim.task).not.toMatch(/allowance|otherwise sleep\.$/);
  });
});
