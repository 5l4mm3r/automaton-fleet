/**
 * SIMULATION builds only: Fleet Command / Virtual reads over the fictional engine. Everything here is fictional and the
 * whole build says so. Events are recorded only when the operator runs a simulated command (plus a few fixture events
 * describing the fixture agents), so the simulated Virtual Command Centre moves only because something "happened" in
 * the simulation — the same rule as LIVE. A LIVE build never includes this module (adapter.simulation.ts only).
 *
 * Helper activity (the Virtual specialists) follows the same rule: a fictional helper job exists only when the operator
 * runs a simulated command for a fictional agent (a mission → a routine chore; ending one → a deliverable review and its
 * inspection; a money command → a spend review; a trading day → each working agent's routine chore and one critical
 * question). Each fictional job carries the purpose the simulated command implies (a mission's role → research / marketing /
 * production / customer support; a review → quality review; an inspection; a money command → spend review; a critical
 * question → decision) and its state (running, then finished) — never guessed from a room. The read is marked simulated
 * and every job's outcome says "simulated".
 */
import { SimulationAdapter } from "./simulation";
import type { Command, Fleet } from "../model";
import { economicsFrom } from "../command/economics";
import { mergeEvents, toFleetEvent, type FleetEvent } from "../command/events";
import type { CommandView, Pulse, Row } from "../command/view";
import type { HelperJob, HelperKind, HelperPurpose, HelperRead, HelperTier } from "../command/helpers";

/** Fictional Genesis allocation (100 % wallet health) for the simulation fixture. */
export const SIMULATION_GENESIS_MINOR = 100_000;

const OP_EVENT: Readonly<Record<string, string>> = Object.freeze({
  fund: "wallet_transfer", transfer: "agent_transfer", hold: "agent_hold_set", kill: "agent_died", mission: "mission_started", mission_end: "mission_ended",
  birth: "birth_ordered", reseed: "birth_ordered", provision: "agent_born", estate: "estate_item_reassigned", policy: "replication_policy_set",
  tick: "settlement_recorded", withdraw: "admin_withdrawal_requested", topup: "ledger_journal_posted",
});

/** One fictional team project, so the project views are exercised in the simulation (labelled fictional everywhere). */
const SIMULATION_PROJECT = (at: string): Row => ({
  projectId: "sim-p1", projectKey: "sim-pipeline", name: "Research pipeline (fictional)", objective: "Fictional: automate the research brief pipeline", ventureKey: "Signal intelligence (fictional)",
  leadAgentId: "A-001", leadName: "Atlas", status: "active", stage: "building", risk: "medium", createdAt: at, startedAt: at, teamSize: 2,
  economics: { expectedValueMinor: 90_000, budgetMinor: 12_000, coordinationBudgetMinor: 1_500, benefitMinor: 30_000, costMinor: 9_500, justified: true, fundingSource: "own_capital", escrowMinor: 9_000, paidMinor: 0,
    gate: ["Fictional: backend and frontend run in parallel after the architecture task"] },
  eta: { soloHours: 52, teamHours: 38, criticalPathHours: 34, coordinationHours: 4, plannedTimeSavedHours: 14, criticalPath: ["arch", "backend", "integrate"], projectedRemainingHours: 30 },
  members: [{ memberId: "sim-m1", agentId: "A-003", name: "Rook", role: "engineer", taskScope: "Frontend build", expectedHours: 18, compensation: { type: "FIXED", fixedMinor: 6_000 }, status: "accepted", contributionStatus: "in_progress", earnedMinor: 0, paidMinor: 0 }],
  tasks: [
    { key: "arch", title: "Architecture", ownerRole: "lead", hours: 8, deps: [], status: "accepted", progressBp: 10_000 },
    { key: "backend", title: "Backend", ownerRole: "lead", hours: 20, deps: ["arch"], status: "in_progress", progressBp: 4_000 },
    { key: "frontend", title: "Frontend", ownerRole: "engineer", assigneeAgentId: "A-003", hours: 18, deps: ["arch"], status: "in_progress", progressBp: 5_000 },
    { key: "integrate", title: "Integration", ownerRole: "lead", hours: 6, deps: ["backend", "frontend"], status: "pending", progressBp: 0 },
  ],
  events: [],
});

/** A fictional agent's routine chore by its fictional role (the same task classes the real T1 tier runs). */
const ROLE_TASK: Readonly<Record<string, string>> = Object.freeze({ Research: "research_triage", Marketing: "formatting", "Opportunity hunt": "query_formulation", Operations: "basic_summary", Communications: "classification" });
/** The purpose a fictional agent's chore is recorded with, by its fictional role (default: production). */
const ROLE_PURPOSE: Readonly<Record<string, HelperPurpose>> = Object.freeze({ Research: "research", Marketing: "marketing", "Opportunity hunt": "research", Operations: "production", Communications: "customer_support" });
const KIND_PURPOSE: Readonly<Record<Exclude<HelperKind, "routine">, HelperPurpose>> = Object.freeze({ escalation: "decision", review: "quality_review", inspection: "inspection", fleet_review: "spend_review" });
const HELPER_WINDOW_S = 600;

interface SimJob { id: string; agentId: string; kind: HelperKind; taskClass: string | null; purpose: HelperPurpose; tier: HelperTier | null; startedAt: number | null; durationMs: number; knownAt: number }

export class SimulationDeckAdapter {
  readonly mode = "simulation" as const;
  private readonly engine = new SimulationAdapter();
  private log: FleetEvent[] = [];
  private fleet: Fleet | null = null;
  private jobs: SimJob[] = [];
  private jobSeq = 0;
  private jobsToday = { day: "", routine: 0, escalation: 0, review: 0, inspection: 0, fleetReview: 0 };

  /** Record one fictional helper job (in flight for a few seconds, or — a review / inspection — known after the fact). */
  private job(agentId: string, kind: HelperKind, taskClass: string | null = null, routinePurpose: HelperPurpose = "production") {
    const now = Date.now(), id = `sim-h${++this.jobSeq}`, after = kind === "review" || kind === "inspection";
    const tier: HelperTier | null = kind === "routine" ? "T1" : kind === "escalation" ? "T3" : kind === "review" ? "T2" : null;
    const purpose = kind === "routine" ? routinePurpose : KIND_PURPOSE[kind];
    this.jobs.unshift({ id, agentId, kind, taskClass, purpose, tier, startedAt: after ? null : now, durationMs: 8_000 + (this.jobSeq * 3_700) % 16_000, knownAt: now });
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.jobsToday.day !== day) this.jobsToday = { day, routine: 0, escalation: 0, review: 0, inspection: 0, fleetReview: 0 };
    // Every fictional job records its purpose: today's unrecorded count stays 0 in the simulation.
    this.jobsToday[kind === "fleet_review" ? "fleetReview" : kind]++;
    this.jobs = this.jobs.slice(0, 200);
  }

  /** The `helpers` read over the fictional jobs (same shape and window as LIVE; marked simulated). */
  private helpers(): HelperRead {
    const now = Date.now(), iso = (t: number) => new Date(t).toISOString();
    const jobs: HelperJob[] = this.jobs.flatMap((j) => {
      const end = j.startedAt === null ? j.knownAt : j.startedAt + j.durationMs, running = j.startedAt !== null && end > now;
      if (!running && now - end > HELPER_WINDOW_S * 1000) return [];
      return [{ id: j.id, agentId: j.agentId, kind: j.kind, taskClass: j.taskClass, tier: j.tier, purpose: j.purpose, state: running ? "running" as const : "finished" as const, startedAt: j.startedAt === null ? null : iso(j.startedAt),
        finishedAt: running ? null : iso(end), knownAt: iso(j.knownAt), outcome: running ? null : "simulated" }];
    });
    const day = new Date(now).toISOString().slice(0, 10), t = this.jobsToday.day === day ? this.jobsToday : { routine: 0, escalation: 0, review: 0, inspection: 0, fleetReview: 0 };
    return { asOf: iso(now), windowS: HELPER_WINDOW_S, jobs, receivedAt: now, simulated: true,
      today: { routine: t.routine, escalation: t.escalation, review: t.review, inspection: t.inspection, fleetReview: t.fleetReview, unrecorded: 0 } };
  }

  constructor() {
    const t = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const fixture: Row[] = [
      { at: t(42), type: "knowledge_recorded", agentId: "A-001", actor: "agent", detail: { topic: "demand", subject: "Independent research services (fictional)" } },
      { at: t(35), type: "capital_requested", agentId: "A-001", actor: "agent", detail: { amountMinor: 25_000, purpose: "Fictional research subscription" } },
      { at: t(34), type: "capital_decision", agentId: "A-001", actor: "controller", detail: { outcome: "approved", approvedMinor: 20_000, reasons: ["Fictional: evidence sufficient", "Fictional: within the red-zone cushion"] } },
      { at: t(20), type: "mission_started", agentId: "A-002", actor: "operator:owner", detail: { kind: "marketing" } },
      { at: t(12), type: "commitment_added", agentId: "A-003", actor: "agent", detail: { amountMinor: 2_200 } },
      { at: t(5), type: "agent_hold_set", agentId: "A-004", actor: "operator:owner", detail: { reason: "Fictional review" } },
      { at: t(30), type: "project_created", agentId: "A-001", actor: "agent", detail: { projectKey: "sim-pipeline", name: "Research pipeline (fictional)", leadAgentId: "A-001" } },
      { at: t(28), type: "project_member_joined", agentId: "A-003", actor: "agent", detail: { projectKey: "sim-pipeline", name: "Research pipeline (fictional)", leadAgentId: "A-001", fromAgentId: "A-003", toAgentId: "A-001" } },
    ];
    this.log = mergeEvents([], fixture.map(toFleetEvent).filter((e): e is FleetEvent => e !== null));
  }

  async snapshot(): Promise<Fleet> { this.fleet = await this.engine.snapshot(); return this.fleet; }

  async execute(command: Command): Promise<Fleet> {
    const before = this.fleet ?? (await this.engine.snapshot());
    const after = await this.engine.execute(command);
    const type = OP_EVENT[command.op];
    if (type && after.tick !== before.tick) {
      const agentId = command.args.agentId ?? (command.op === "provision" ? after.agents.at(-1)?.id : null) ?? null;
      const e = toFleetEvent({ at: new Date().toISOString(), type, agentId, actor: "operator:owner (simulation)",
        detail: { ...command.args, kind: command.op === "mission" ? String(command.args.role ?? "").toLowerCase() : undefined } });
      if (e) this.log = mergeEvents(this.log, [e]);
      if (command.op === "tick") {
        const extra = after.agents.filter((a) => a.status === "active").map((a) => toFleetEvent({ at: new Date().toISOString(), type: "settlement_recorded", agentId: a.id, actor: "simulation", detail: {} }));
        this.log = mergeEvents(this.log, extra.filter((x): x is FleetEvent => x !== null));
      }
      // Fictional helper jobs, only for what the operator just ran.
      const subject = agentId ? after.agents.find((a) => a.id === agentId) : undefined;
      if (command.op === "mission" && subject) {
        const role = String(command.args.role ?? "");
        this.job(subject.id, "routine", ROLE_TASK[role] ?? "basic_summary", ROLE_PURPOSE[role] ?? "production");
        if (role === "Research") this.job(subject.id, "routine", "page_interpretation", "research");
      } else if (command.op === "mission_end" && subject) { this.job(subject.id, "review"); this.job(subject.id, "inspection"); }
      else if ((command.op === "fund" || command.op === "transfer" || command.op === "topup") && subject) this.job(subject.id, "fleet_review");
      else if (command.op === "tick") {
        const working = after.agents.filter((a) => a.status === "active" && !a.paused && a.hibernation?.state !== "hibernating");
        for (const a of working.slice(0, 3)) this.job(a.id, "routine", ROLE_TASK[a.role] ?? "basic_summary", ROLE_PURPOSE[a.role] ?? "production");
        const lowest = [...working].sort((a, b) => a.cash - b.cash)[0];
        if (lowest) this.job(lowest.id, "escalation");
      }
    }
    this.fleet = after;
    return after;
  }

  async reset(): Promise<Fleet> {
    this.fleet = await this.engine.reset();
    return this.fleet;
  }

  async command(): Promise<CommandView> {
    const f = this.fleet ?? (await this.snapshot());
    const economics: CommandView["economics"] = {};
    for (const a of f.agents) {
      // Fictional economics: profit is what the agent holds above its fictional Genesis allocation.
      const net = a.cash - SIMULATION_GENESIS_MINOR;
      economics[a.id] = economicsFrom(a.id,
        { lifetime: { revenueMinor: Math.max(0, net) + a.burn * 30, expensesMinor: a.burn * 30, feesMinor: 0, netProfitMinor: net },
          last30d: { revenueMinor: Math.max(0, net), refundsMinor: 0, inferenceMinor: 0, operatingCostsMinor: Math.max(0, -net) },
          runway: { days: a.burn ? Math.floor(a.cash / a.burn) : null, burnPerDayMinor: a.burn }, retainedEarningsMinor: Math.max(0, net), treasuryContributionsMinor: 0 },
        { commitmentsDue30dMinor: a.burn * 5, redZoneMet: a.cash >= a.burn * 10, vulnerable: a.cash < SIMULATION_GENESIS_MINOR });
    }
    return {
      mode: "simulation", fetchedAt: new Date().toISOString(), genesisMinor: SIMULATION_GENESIS_MINOR, currency: "GBP", economics, events: this.log, commandEvents: null,
      capital: [{ agentId: "A-001", venture: "Signal intelligence (fictional)", purpose: "Fictional research subscription", amountMinor: 25_000, expectedNetMinor: 60_000,
        confidenceBp: 6_500, evidenceItems: 3, outcome: "approved", approvedMinor: 20_000, reasons: ["Fictional: evidence sufficient", "Fictional: within the red-zone cushion"],
        wouldChange: ["Fictional: more evidence would raise the amount"], inputs: { cushionMet: true }, policyVersion: 1, at: this.log.find((e) => e.type === "capital_decision")?.at ?? "" }],
      ventures: f.agents.map((a) => ({ agentId: a.id, key: a.venture, state: a.status === "dead" ? "closed" : "operating", decisions: [] })),
      opportunities: [{ agentId: "A-004", title: "Frontier Labs lead (fictional)", status: "shortlisted" }],
      projects: [SIMULATION_PROJECT(this.log.find((e) => e.type === "project_created")?.at ?? "")], projectSummary: { active: 1, planning: 0, completed: 0, cancelled: 0, agentsCollaborating: 2, plannedTimeSavedHours: 14, note: "Simulation: fictional project." },
      knowledge: [{ agentId: "A-001", topic: "demand", subject: "Independent research services (fictional)", claim: "Fictional claim for the simulation.", observedAt: this.log.at(-1)?.at }],
      dependencies: [], overview: { currency: "GBP", activeVentures: f.agents.filter((a) => a.status !== "dead").length },
      treasury: { unallocatedMinor: f.treasury, lifetimeContributionMinor: 0, flows30d: {} }, helpers: this.helpers(),
      settings: { genesisCapital: { currency: "GBP", minor: SIMULATION_GENESIS_MINOR }, replication: { auto_birth_enabled: f.policy.autoBirth, population_ceiling: f.policy.maxAgents, window_hours: 24 },
        missions: null, risk: null, flags: { registryReplicationSwitch: false, maxAgents: f.policy.maxAgents } },
      unavailable: ["risk policy (simulation)", "mission policy (simulation)"],
    };
  }

  /** The simulation has no per-agent ledger: nothing is shown rather than fictional journals. */
  async agentLedger(): Promise<Row[]> { return []; }

  async pulse(): Promise<Pulse> {
    const f = await this.snapshot();
    return { fetchedAt: new Date().toISOString(), agents: f.agents, events: this.log.slice(0, 60), helpers: this.helpers() };
  }
}
