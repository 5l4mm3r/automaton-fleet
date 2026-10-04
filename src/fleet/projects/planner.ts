/**
 * Team-project planner (schema v42) — the TypeScript twin of the database's `fleet_project_schedule`.
 *
 * A project is a dependency graph of tasks, each owned by ONE owner (the lead, or a role a recruited agent fills). An
 * owner works on one task at a time; a task starts when its dependencies are finished and its owner is free (and, for a
 * recruited agent who accepted with a later start, not before that start). The schedule is deterministic greedy list
 * scheduling: repeatedly place the ready task with the earliest possible start (ties: plan order).
 *
 *   solo ETA  = the sum of all task hours (one agent does everything, one task at a time);
 *   team ETA  = the schedule's makespan + the coordination overhead the lead declared (explicit, never zero by default).
 *
 * Time saved therefore comes only from real concurrency in the graph: a serial chain gets no shorter however many agents
 * own its links (and the coordination overhead makes the team slower), while independent branches owned by different
 * agents run side by side. There is no hours ÷ headcount formula anywhere.
 *
 * Hours are handled in integer hundredths, so the result is exact and equal to the database's numeric arithmetic.
 */

export interface PlanTask {
  key: string;
  /** "lead" or a role key filled by a recruited agent. */
  role: string;
  hours: number;
  deps?: readonly string[];
}

export interface ScheduledTask { key: string; role: string; startHours: number; finishHours: number }

export interface Schedule {
  makespanHours: number;
  tasks: ScheduledTask[];
  /** The chain (dependency or same-owner) that determines the makespan, first task first. */
  criticalPath: string[];
}

const centi = (h: number) => Math.round(h * 100);
const hours = (c: number) => c / 100;

/** Greedy list schedule of `tasks` (plan order); `offsets` = earliest start per role in hours (e.g. ACCEPT_WITH_TIMING). */
export function schedule(tasks: readonly PlanTask[], offsets: Readonly<Record<string, number>> = {}): Schedule {
  const n = tasks.length;
  const index = new Map(tasks.map((t, i) => [t.key, i]));
  if (index.size !== n) throw new Error("FLEET_PROJECT_PLAN: task keys must be unique");
  const dur = tasks.map((t) => centi(t.hours));
  const start = new Array<number>(n).fill(0), fin = new Array<number>(n).fill(0), done = new Array<boolean>(n).fill(false);
  const avail = new Map<string, number>();
  for (let k = 0; k < n; k++) {
    let best = -1, bestStart = 0;
    for (let i = 0; i < n; i++) {
      if (done[i]) continue;
      let es = Math.max(avail.get(tasks[i].role) ?? 0, centi(offsets[tasks[i].role] ?? 0));
      let ready = true;
      for (const d of tasks[i].deps ?? []) {
        const j = index.get(d);
        if (j === undefined) throw new Error(`FLEET_PROJECT_PLAN: task ${tasks[i].key} depends on unknown task ${d}`);
        if (!done[j]) { ready = false; break; }
        es = Math.max(es, fin[j]);
      }
      if (ready && (best < 0 || es < bestStart)) { best = i; bestStart = es; }
    }
    if (best < 0) throw new Error("FLEET_PROJECT_PLAN: the task dependencies contain a cycle");
    start[best] = bestStart; fin[best] = bestStart + dur[best]; done[best] = true;
    avail.set(tasks[best].role, fin[best]);
  }
  let last = -1;
  for (let i = 0; i < n; i++) if (last < 0 || fin[i] > fin[last]) last = i;
  const path: string[] = [];
  for (let cur = last, guard = 0; cur >= 0 && guard <= n; guard++) {
    path.unshift(tasks[cur].key);
    let prev = -1;
    for (const d of tasks[cur].deps ?? []) { const j = index.get(d)!; if (fin[j] === start[cur]) { prev = j; break; } }
    if (prev < 0) for (let j = 0; j < n; j++) if (j !== cur && tasks[j].role === tasks[cur].role && fin[j] === start[cur] && start[cur] > 0) { prev = j; break; }
    cur = prev;
  }
  return {
    makespanHours: last < 0 ? 0 : hours(fin[last]),
    tasks: tasks.map((t, i) => ({ key: t.key, role: t.role, startHours: hours(start[i]), finishHours: hours(fin[i]) })),
    criticalPath: path,
  };
}

export interface PlanEstimate {
  soloHours: number;
  /** Makespan + coordination overhead. */
  teamHours: number;
  makespanHours: number;
  coordinationHours: number;
  /** solo − team; negative when the team would be slower (serial work plus coordination). */
  timeSavedHours: number;
  criticalPath: string[];
}

export function estimate(tasks: readonly PlanTask[], coordinationHours: number, offsets: Readonly<Record<string, number>> = {}): PlanEstimate {
  const s = schedule(tasks, offsets);
  const solo = tasks.reduce((a, t) => a + centi(t.hours), 0);
  const team = centi(s.makespanHours) + centi(coordinationHours);
  return { soloHours: hours(solo), teamHours: hours(team), makespanHours: s.makespanHours, coordinationHours, timeSavedHours: hours(solo - team), criticalPath: s.criticalPath };
}

/** Compensation terms of one contract (minor units; revenue share in basis points of attributable venture net profit). */
export interface Terms {
  type: "FIXED" | "REVENUE_SHARE" | "MILESTONE" | "HYBRID";
  fixedMinor?: number;
  revenueShareBp?: number;
  revenueShareCapMinor?: number;
  milestones?: Array<{ key: string; taskKey: string; amountMinor: number }>;
}

/** The cost a lead should expect from a contract: fixed + milestones + its expected revenue share (capped). */
export function expectedCost(t: Terms, expectedValueMinor: number): number {
  const share = t.revenueShareBp ? Math.floor((Math.max(0, expectedValueMinor) * t.revenueShareBp) / 10_000) : 0;
  const capped = t.revenueShareCapMinor !== undefined ? Math.min(share, t.revenueShareCapMinor) : share;
  return (t.fixedMinor ?? 0) + (t.milestones ?? []).reduce((a, m) => a + m.amountMinor, 0) + capped;
}

export interface Gate { benefitMinor: number; costMinor: number; justified: boolean }

/**
 * The recruitment test: recruit only when the expected benefit (the value of finishing earlier, at the lead's own
 * value of a day, plus any quality / risk benefit it claims) exceeds the collaboration cost plus the coordination cost.
 */
export function gate(e: PlanEstimate, o: { timeValueMinorPerDay: number; qualityBenefitMinor?: number; memberCostMinor: number; coordinationCostMinor: number }): Gate {
  const benefit = Math.floor((centi(e.timeSavedHours) * o.timeValueMinorPerDay) / 2400) + (o.qualityBenefitMinor ?? 0);
  const cost = o.memberCostMinor + o.coordinationCostMinor;
  return { benefitMinor: benefit, costMinor: cost, justified: benefit > cost };
}
