/**
 * Schema v42 — multi-agent PROJECT TEAMS: an agent recruits other EXISTING LIVING agents into a venture project when
 * collaboration has a strong economic reason (owner brief 2026-10-04, Part B).
 *
 * Recruitment is not replication and involves no owner step. It never creates an agent, never touches replication, the
 * registry cap or the constitutional ceiling of 50 living agents. It is an internal commercial contract between agents,
 * with FleetController as the ledger and custody authority.
 *
 *  • THE PLAN (`fleet_projects`, `fleet_project_tasks`, `fleet_project_roles`): the lead decomposes the work into a task
 *    graph, each task owned by the lead or a ROLE. `fleet_project_schedule` (twin of src/fleet/projects/planner.ts) is a
 *    deterministic list schedule — an owner does one task at a time, a task waits for its dependencies — so:
 *    solo ETA = Σ task hours; team ETA = makespan + the coordination overhead the lead declares. Time saved comes only
 *    from real concurrency; there is no hours ÷ headcount anywhere. The planner's figures are the only ones stored or shown.
 *  • THE GATE: a team project (at least one role) is accepted only when the expected benefit (the value of finishing
 *    earlier at the lead's own value of a day, plus any quality / risk benefit it claims) exceeds the expected cost of
 *    the contracts plus the coordination cost; the reasons are stored. Re-checked when a counter-offer changes terms.
 *  • CONTRACTS (`fleet_project_members`): the lead OFFERS a role to an existing living agent (role, scope, deliverable,
 *    duration, deadline, dependencies, compensation: FIXED | REVENUE_SHARE | MILESTONE | HYBRID — explicit before work
 *    starts). Only the target answers: ACCEPT, COUNTER, DECLINE or ACCEPT_WITH_TIMING. Nobody is forced; an offer can be
 *    withdrawn; a member can exit at any time; the lead can replace a member.
 *  • MONEY (ledger): the lead's project budget sits in escrow (`agent_project_escrow`), funded from its OWN spendable
 *    capital (custody availability is the only check — no resizing, no owner step, no ceiling) or from FLEET capital
 *    approved through the EXISTING capital-request path (the request carries the project's economics; the envelope it
 *    creates funds the escrow). Tax reserves, envelope capital of other purposes, protected principal and obligations can
 *    never fund a project (they are not spendable cash). A member's ACCEPT requires the escrow to cover the contract's
 *    fixed and milestone amounts, so earned pay is always there. Payments are balanced `project_payment` journals between
 *    exactly two agents: project EXPENSE for the payer, project INCOME for the payee — internal classes that are never
 *    external revenue or external cost. The Fleet's consolidated revenue, profit, sweep base, replication wealth and tax
 *    figures are unchanged by them (they read only agent_revenue / agent_expense / agent_fees). Per agent, the economics
 *    add `internalProjectIncome`, `internalProjectExpense` and `netProfitInclInternal`; the sweep base
 *    (realizedNetProfit) deliberately excludes internal flows on both sides, so Σ over agents of the sweep base equals the
 *    Fleet's consolidated external net profit (an internal transfer can never create sweepable profit).
 *  • SETTLEMENT: milestones are paid when the lead accepts the milestone's task; fixed pay when all the role's tasks are
 *    accepted; revenue share is settled on request from the venture's ledger net profit since the contract started
 *    (bounded by its end date and cap) out of the lead's spendable cash. On cancellation, removal, a member's death or the
 *    lead's death, work already DELIVERED counts as earned (the lead cannot avoid paying by cancelling instead of
 *    reviewing); unspent escrow returns to its source (own → the lead's cash; Fleet → its envelope, or the Treasury if the
 *    envelope has closed).
 *  • LIFECYCLE: a dead or quarantined agent loses all project authority at once (authentication refuses it). A member's
 *    death or quarantine exits its contracts with settlement; the LEAD's death or quarantine cancels its projects with
 *    settlement (documented rule — no project survives without a living lead). An operator hold only pauses the agent.
 *  • HISTORY: an append-only project event log; immutable payments; an outcome record per finished project (predicted vs
 *    actual duration, cost, return, parallelism, coordination, contributions, failures, lessons), also written to the
 *    Fleet's economic knowledge (topic team_project). Competency is a VIEW over completed work (accepted, rejected,
 *    on-time, estimate accuracy, earnings) — no birth-assigned score, no universal ranking.
 *  • VISIBILITY: lifecycle events (project_*) carry fromAgentId / toAgentId so the Virtual HQ can draw a truthful packet
 *    between two agents; the dashboard reads everything through `projects` (read-only, the same gateway).
 */
import { V10_SQL } from "./migrations-phase10.js";
import { V11_SQL } from "./migrations-phase11.js";
import { V29_SQL } from "./migrations-phase29.js";
import { V30_SQL } from "./migrations-phase30.js";
import { V35_SQL } from "./migrations-phase35.js";
import { DASHBOARD_READ_OPS_V41, V41_SQL } from "./migrations-phase41.js";

function restate(src: string, name: string, edits: Array<[string, string]>): string {
  const head = Math.max(src.lastIndexOf(`CREATE FUNCTION ${name}(`), src.lastIndexOf(`CREATE OR REPLACE FUNCTION ${name}(`));
  if (head < 0) throw new Error(`v42: function ${name} not found`);
  const end = src.indexOf("$$;", src.indexOf("AS $$", head) + 5);
  let body = "CREATE OR REPLACE " + src.slice(src.indexOf("FUNCTION", head), end + 3);
  for (const [from, to] of edits) {
    if (body.split(from).length !== 2) throw new Error(`v42: expected text not found exactly once in ${name}: ${from.slice(0, 60)}`);
    body = body.replace(from, to);
  }
  return body;
}

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

/** v42 agent operations (all through api_economy). */
export const PROJECT_OPS = ["project.propose", "project.replan", "project.fund", "project.offer", "project.respond", "project.counter_accept",
  "project.withdraw_offer", "project.start", "project.task", "project.review", "project.settle_share", "project.exit", "project.replace",
  "project.cancel", "project.complete", "project.list", "project.status", "project.offers", "project.talent"] as const;
export const DASHBOARD_READ_OPS_V42 = [...DASHBOARD_READ_OPS_V41, "projects"] as const;
/** Lifecycle event types (fleet_events.event_type) — each carries projectId, and fromAgentId / toAgentId where two agents are involved. */
export const PROJECT_EVENT_TYPES = ["project_created", "project_replanned", "project_funded", "project_member_offered", "project_member_countered",
  "project_member_joined", "project_member_declined", "project_offer_withdrawn", "project_started", "project_task_started", "project_task_delivered",
  "project_task_accepted", "project_task_rejected", "project_payment", "project_member_exited", "project_member_removed", "project_completed",
  "project_cancelled"] as const;

const DISPATCH = restate(V41_SQL, "api_economy", [
  [`WHEN 'account.mark' THEN 'planning' WHEN 'phone.quote' THEN 'planning'`,
   `WHEN 'account.mark' THEN 'planning' WHEN 'phone.quote' THEN 'planning'
    -- v42: team projects are the agents' own commercial decisions (no approval step); funding commits capital.
    WHEN 'project.fund' THEN 'spend.request'
    WHEN 'project.propose' THEN 'planning' WHEN 'project.replan' THEN 'planning' WHEN 'project.offer' THEN 'planning' WHEN 'project.respond' THEN 'planning'
    WHEN 'project.counter_accept' THEN 'planning' WHEN 'project.withdraw_offer' THEN 'planning' WHEN 'project.start' THEN 'planning' WHEN 'project.task' THEN 'planning'
    WHEN 'project.review' THEN 'planning' WHEN 'project.settle_share' THEN 'planning' WHEN 'project.exit' THEN 'planning' WHEN 'project.replace' THEN 'planning'
    WHEN 'project.cancel' THEN 'planning' WHEN 'project.complete' THEN 'planning' WHEN 'project.list' THEN 'planning' WHEN 'project.status' THEN 'planning'
    WHEN 'project.offers' THEN 'planning' WHEN 'project.talent' THEN 'planning'`],
  [`      WHEN 'phone.quote' THEN fleet_econ_phone_quote(p_agent, a)`,
   `      WHEN 'phone.quote' THEN fleet_econ_phone_quote(p_agent, a)
      WHEN 'project.propose' THEN fleet_econ_project_propose(p_agent, a)
      WHEN 'project.replan' THEN fleet_econ_project_replan(p_agent, a)
      WHEN 'project.fund' THEN fleet_econ_project_fund(p_agent, a)
      WHEN 'project.offer' THEN fleet_econ_project_offer(p_agent, a)
      WHEN 'project.respond' THEN fleet_econ_project_respond(p_agent, a)
      WHEN 'project.counter_accept' THEN fleet_econ_project_counter_accept(p_agent, a)
      WHEN 'project.withdraw_offer' THEN fleet_econ_project_withdraw_offer(p_agent, a)
      WHEN 'project.start' THEN fleet_econ_project_start(p_agent, a)
      WHEN 'project.task' THEN fleet_econ_project_task(p_agent, a)
      WHEN 'project.review' THEN fleet_econ_project_review(p_agent, a)
      WHEN 'project.settle_share' THEN fleet_econ_project_settle_share(p_agent, a)
      WHEN 'project.exit' THEN fleet_econ_project_exit(p_agent, a)
      WHEN 'project.replace' THEN fleet_econ_project_replace(p_agent, a)
      WHEN 'project.cancel' THEN fleet_econ_project_cancel(p_agent, a)
      WHEN 'project.complete' THEN fleet_econ_project_complete(p_agent, a)
      WHEN 'project.list' THEN fleet_econ_project_list(p_agent, a)
      WHEN 'project.status' THEN fleet_econ_project_status(p_agent, a)
      WHEN 'project.offers' THEN fleet_econ_project_offers(p_agent, a)
      WHEN 'project.talent' THEN fleet_econ_project_talent(p_agent, a)`],
  ["CAPABILITY_[A-Z_]+|", "CAPABILITY_[A-Z_]+|PROJECT_[A-Z_]+|"],
]);

const DASH_CALL = restate(V41_SQL, "dash_call", [
  [`p_op IN (${q(DASHBOARD_READ_OPS_V41)})`, `p_op IN (${q(DASHBOARD_READ_OPS_V42)})`],
  [`      WHEN 'comms_status' THEN fleet_admin_comms_status()`, `      WHEN 'comms_status' THEN fleet_admin_comms_status()
      WHEN 'projects' THEN fleet_admin_projects(a)`],
]);

// project_payment moves value between the paying agent and exactly one payee (the posting function's scope rule).
const LEDGER_POST = restate(V10_SQL, "fleet_ledger_post", [
  [`  ELSIF p_kind = 'agent_transfer' AND cardinality(v_agents) <> 2 THEN
    RAISE EXCEPTION 'FLEET_LEDGER_SCOPE: agent_transfer moves cash between exactly two agents';`,
   `  ELSIF p_kind = 'agent_transfer' AND cardinality(v_agents) <> 2 THEN
    RAISE EXCEPTION 'FLEET_LEDGER_SCOPE: agent_transfer moves cash between exactly two agents';
  ELSIF p_kind = 'project_payment' AND (cardinality(v_agents) <> 2 OR p_agent IS NULL OR NOT (p_agent = ANY (v_agents))) THEN
    RAISE EXCEPTION 'FLEET_LEDGER_SCOPE: project_payment moves value from the paying agent to exactly one other agent';`],
]);

const OPEN_AGENT = restate(V29_SQL, "fleet_ledger_open_agent", [
  [`'agent_contributions','agent_investment_pnl','agent_tax_reserve','agent_tax_expense','agent_envelope_cash']`,
   `'agent_contributions','agent_investment_pnl','agent_tax_reserve','agent_tax_expense','agent_envelope_cash',
                           'agent_project_escrow','agent_project_income','agent_project_expense']`],
]);

// Escrow is still the agent's (recoverable, returned unspent) but never spendable cash; internal flows are reported
// beside, never inside, the external figures (realizedNetProfit stays the sweep base).
const ECONOMICS = restate(V11_SQL, "fleet_agent_economics", [
  [`DECLARE v_cash bigint; v_res bigint;`, `DECLARE v_escrow bigint; v_pinc bigint; v_pexp bigint; v_cash bigint; v_res bigint;`],
  [`  v_inv := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_investment_pnl'));`,
   `  v_inv := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_investment_pnl'));
  v_escrow := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_project_escrow'));
  v_pinc := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_project_income'));
  v_pexp := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_project_expense'));`],
  [`  v_rec := v_cash + v_res_rec + v_assets_rec;`, `  v_rec := v_cash + v_res_rec + v_assets_rec + v_escrow;`],
  [`    'survivalEquityExhausted', v_eq <= 0 AND v_principal > 0);`,
   `    'survivalEquityExhausted', v_eq <= 0 AND v_principal > 0,
    'projectEscrow', v_escrow, 'internalProjectIncome', v_pinc, 'internalProjectExpense', v_pexp, 'netProfitInclInternal', v_net + v_pinc - v_pexp);`],
]);

const AGENT_VALUE = restate(V35_SQL, "fleet_agent_value", [
  [`a.class IN ('agent_cash','agent_reserved','agent_assets','agent_envelope_cash')`, `a.class IN ('agent_cash','agent_reserved','agent_assets','agent_envelope_cash','agent_project_escrow')`],
]);

// Envelope capital moved into a project's escrow is reserved; paid out of it, spent; returned to the Treasury directly
// (the envelope closed meanwhile), returned.
const ENVELOPE_POSITION = restate(V30_SQL, "fleet_envelope_position", [
  [`               FROM fleet_payment_orders WHERE envelope_id = e.envelope_id),`,
   `               FROM fleet_payment_orders WHERE envelope_id = e.envelope_id),
       pj AS (SELECT COALESCE(sum(escrow_fleet_minor), 0) AS held, COALESCE(sum(fleet_paid_minor), 0) AS paid, COALESCE(sum(fleet_returned_minor), 0) AS back
                FROM fleet_projects WHERE envelope_id = e.envelope_id),`],
  [`'reservedMinor', o.reserved, 'spentMinor', o.spent, 'availableMinor', e.allocated_minor - e.returned_minor - o.reserved - o.spent,`,
   `'reservedMinor', o.reserved + pj.held, 'spentMinor', o.spent + pj.paid, 'projectEscrowMinor', pj.held, 'projectPaidMinor', pj.paid,
    'availableMinor', e.allocated_minor - e.returned_minor - o.reserved - o.spent - pj.held - pj.paid - pj.back,`],
  [`'lossMinor', GREATEST(0, o.spent - rv.revenue)`, `'lossMinor', GREATEST(0, o.spent + pj.paid - rv.revenue)`],
  [`  FROM o, rv`, `  FROM o, rv, pj`],
]);

// Shared capital for a team project goes through the EXISTING request path; the request names the project and carries
// its planner economics into the decision's inputs. The decision itself is FleetController's, unchanged.
const CAPITAL_REQUEST = restate(V30_SQL, "fleet_econ_capital_request", [
  [`DECLARE v fleet_ventures; q fleet_capital_requests;`, `DECLARE v_project fleet_projects; v fleet_ventures; q fleet_capital_requests;`],
  [`  IF v.state IN ('failed','closed') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE', 'reason', 'the venture is ' || v.state); END IF;`,
   `  IF v.state IN ('failed','closed') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE', 'reason', 'the venture is ' || v.state); END IF;
  IF a ? 'projectId' THEN
    SELECT * INTO v_project FROM fleet_projects WHERE project_id = fleet_project_uuid(a, 'projectId') AND lead_agent_id = p_agent;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND', 'reason', 'projectId is one of your own projects'); END IF;
    IF v_project.venture_id <> v.venture_id THEN PERFORM fleet_econ_bad('the project belongs to another venture'); END IF;
    IF v_project.status NOT IN ('planning','active') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE', 'reason', 'the project is ' || v_project.status); END IF;
  END IF;`],
  [`expected_payback_days, downside_minor, confidence_bp, milestones, alternative_plan, alternative_minor, categories)`,
   `expected_payback_days, downside_minor, confidence_bp, milestones, alternative_plan, alternative_minor, categories, project_id, project_economics)`],
  [`fleet_econ_int(a, 'alternativeMinor', 1, 100000000000), COALESCE(v_cats, ARRAY['expense','fee']))`,
   `fleet_econ_int(a, 'alternativeMinor', 1, 100000000000), COALESCE(v_cats, ARRAY['expense','fee']),
      v_project.project_id, CASE WHEN v_project.project_id IS NOT NULL THEN fleet_project_economics(v_project) END)`],
  [`  d := fleet_capital_decide(q);`, `  d := fleet_capital_decide(q);
  IF q.project_id IS NOT NULL THEN d := jsonb_set(d, '{inputs}', COALESCE(d -> 'inputs', '{}'::jsonb) || jsonb_build_object('project', q.project_economics)); END IF;`],
]);

export const V42_SQL = `
-- ═══ 1. Ledger grammar: escrow and internal project flows (never external revenue or cost) ═══
INSERT INTO fleet_ledger_classes (class, kind, normal_side, scope, non_negative, description) VALUES
  ('agent_project_escrow',  'asset',   'D', 'agent', true, 'Agent capital committed to its own team project (escrow): recoverable, never spendable cash'),
  ('agent_project_income',  'revenue', 'C', 'agent', true, 'Internal project income received from another Fleet agent (never external revenue)'),
  ('agent_project_expense', 'expense', 'D', 'agent', true, 'Internal project expense paid to another Fleet agent (never an external cost)');

INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance) VALUES
  ('project_escrow',           false, ARRAY['controller'], false, 'Move the lead''s own spendable cash into its project escrow', 'reservation'),
  ('project_escrow_release',   false, ARRAY['controller'], false, 'Return unspent own-capital project escrow to the lead''s cash', 'reservation'),
  ('project_envelope_escrow',  false, ARRAY['controller'], false, 'Move approved envelope capital into the project escrow it was approved for', 'fleet_capital'),
  ('project_envelope_release', false, ARRAY['controller'], false, 'Return unspent Fleet-capital project escrow to its envelope', 'fleet_capital'),
  ('project_envelope_return',  false, ARRAY['controller'], false, 'Return unspent Fleet-capital project escrow to the Treasury (its envelope has closed)', 'fleet_capital'),
  ('project_payment',          false, ARRAY['controller'], true,  'Internal project compensation between two agents (expense for the payer, income for the payee)', 'internal_transfer');

INSERT INTO fleet_ledger_rules (kind, class, side) VALUES
  ('project_escrow','agent_project_escrow','D'), ('project_escrow','agent_cash','C'),
  ('project_escrow_release','agent_cash','D'), ('project_escrow_release','agent_project_escrow','C'),
  ('project_envelope_escrow','agent_project_escrow','D'), ('project_envelope_escrow','agent_envelope_cash','C'),
  ('project_envelope_release','agent_envelope_cash','D'), ('project_envelope_release','agent_project_escrow','C'),
  ('project_envelope_return','treasury_cash','D'), ('project_envelope_return','agent_project_escrow','C'),
  ('project_payment','agent_project_expense','D'), ('project_payment','agent_project_escrow','C'), ('project_payment','agent_cash','C'),
  ('project_payment','agent_cash','D'), ('project_payment','agent_project_income','C');

${LEDGER_POST}

${OPEN_AGENT}
SELECT fleet_ledger_open_agent(agent_id, 'migration') FROM fleet_ledger_accounts WHERE class = 'agent_cash' GROUP BY agent_id;

${ECONOMICS}

${AGENT_VALUE}

-- Institutional knowledge gains the team-project topic (project outcomes).
ALTER TABLE fleet_economic_knowledge DROP CONSTRAINT fleet_economic_knowledge_topic_check;
ALTER TABLE fleet_economic_knowledge ADD CONSTRAINT fleet_economic_knowledge_topic_check CHECK (topic IN ('niche','product','channel','pricing','conversion',
  'vendor','manufacturer','demand','acquisition','assumption_failed','assumption_succeeded','launch_result','operational_cost','team_project'));

-- ═══ 2. Projects, roles, tasks, contracts, payments, events, outcomes ═══
CREATE TABLE fleet_projects (
  project_id               uuid          PRIMARY KEY,
  lead_agent_id            text          NOT NULL REFERENCES fleet_agents(agent_id),
  venture_id               uuid          NOT NULL REFERENCES fleet_ventures(venture_id),
  project_key              text          NOT NULL CHECK (project_key ~ '^[a-z0-9][a-z0-9._-]{1,47}$'),
  name                     text          NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  objective                text          NOT NULL CHECK (length(objective) BETWEEN 1 AND 600),
  idempotency_key          text          NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_.-]{4,128}$'),
  status                   text          NOT NULL DEFAULT 'planning' CHECK (status IN ('planning','active','completed','cancelled')),
  stage                    text          NOT NULL DEFAULT 'planning' CHECK (stage IN ('planning','recruiting','research','building','integration','launch','review','completed','cancelled')),
  plan_version             integer       NOT NULL DEFAULT 1 CHECK (plan_version >= 1),
  expected_value_minor     bigint        NOT NULL CHECK (expected_value_minor BETWEEN 0 AND 100000000000),
  expected_return_minor    bigint        NOT NULL CHECK (expected_return_minor BETWEEN -100000000000 AND 100000000000),
  budget_minor             bigint        NOT NULL CHECK (budget_minor BETWEEN 0 AND 100000000000),
  opportunity_cost_minor   bigint        NOT NULL CHECK (opportunity_cost_minor BETWEEN 0 AND 100000000000),
  time_value_minor_per_day bigint        NOT NULL CHECK (time_value_minor_per_day BETWEEN 0 AND 100000000000),
  quality_benefit_minor    bigint        NOT NULL DEFAULT 0 CHECK (quality_benefit_minor BETWEEN 0 AND 100000000000),
  coordination_hours       numeric(9,2)  NOT NULL CHECK (coordination_hours BETWEEN 0 AND 100000),
  coordination_cost_minor  bigint        NOT NULL CHECK (coordination_cost_minor BETWEEN 0 AND 100000000000),
  risk                     text          NOT NULL CHECK (risk IN ('low','medium','high')),
  risk_note                text          CHECK (length(risk_note) <= 300),
  justification            jsonb         NOT NULL CHECK (jsonb_typeof(justification) = 'object' AND length(justification::text) <= 6000),
  -- The planner's figures (recomputed on every plan, timing and terms change; never the lead's own claim).
  solo_hours               numeric(11,2) NOT NULL,
  team_hours               numeric(11,2) NOT NULL,
  makespan_hours           numeric(11,2) NOT NULL,
  planned_time_saved_hours numeric(11,2) NOT NULL,
  critical_path            text[]        NOT NULL,
  benefit_minor            bigint        NOT NULL,
  cost_minor               bigint        NOT NULL,
  gate_reasons             jsonb         NOT NULL DEFAULT '[]',
  target_completion        timestamptz,
  -- Escrow by source (balances), and what the Fleet-capital part has paid or returned (envelope bookkeeping).
  envelope_id              uuid          REFERENCES fleet_envelopes(envelope_id),
  escrow_own_minor         bigint        NOT NULL DEFAULT 0 CHECK (escrow_own_minor >= 0),
  escrow_fleet_minor       bigint        NOT NULL DEFAULT 0 CHECK (escrow_fleet_minor >= 0),
  own_paid_minor           bigint        NOT NULL DEFAULT 0 CHECK (own_paid_minor >= 0),
  fleet_paid_minor         bigint        NOT NULL DEFAULT 0 CHECK (fleet_paid_minor >= 0),
  fleet_returned_minor     bigint        NOT NULL DEFAULT 0 CHECK (fleet_returned_minor >= 0),
  created_at               timestamptz   NOT NULL DEFAULT now(),
  updated_at               timestamptz   NOT NULL DEFAULT now(),
  started_at               timestamptz,
  completed_at             timestamptz,
  cancelled_at             timestamptz,
  cancel_reason            text          CHECK (length(cancel_reason) <= 300),
  UNIQUE (lead_agent_id, project_key),
  UNIQUE (lead_agent_id, idempotency_key),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK (status NOT IN ('completed','cancelled') OR (escrow_own_minor = 0 AND escrow_fleet_minor = 0))
);
CREATE INDEX fleet_projects_lead ON fleet_projects (lead_agent_id, status);
CREATE INDEX fleet_projects_venture ON fleet_projects (venture_id);
CREATE TRIGGER fleet_projects_no_delete BEFORE DELETE ON fleet_projects FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_projects_no_truncate BEFORE TRUNCATE ON fleet_projects FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE FUNCTION fleet_projects_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('completed','cancelled') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a finished project is final';
  END IF;
  IF NEW.project_id <> OLD.project_id OR NEW.lead_agent_id <> OLD.lead_agent_id OR NEW.venture_id <> OLD.venture_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a project''s identity, lead and venture never change';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_projects_guard BEFORE UPDATE ON fleet_projects FOR EACH ROW EXECUTE FUNCTION fleet_projects_guard();

CREATE TABLE fleet_project_roles (
  project_id           uuid    NOT NULL REFERENCES fleet_projects(project_id),
  role                 text    NOT NULL CHECK (role ~ '^[a-z][a-z0-9_-]{1,31}$' AND role <> 'lead'),
  task_scope           text    NOT NULL CHECK (length(task_scope) BETWEEN 1 AND 300),
  required_capability  text    NOT NULL CHECK (required_capability ~ '^[a-z][a-z0-9_]{1,31}$'),
  proposed_terms       jsonb   NOT NULL,
  expected_cost_minor  bigint  NOT NULL CHECK (expected_cost_minor >= 0),
  plan_version         integer NOT NULL,
  PRIMARY KEY (project_id, role)
);
CREATE TRIGGER fleet_project_roles_no_delete BEFORE DELETE OR TRUNCATE ON fleet_project_roles FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_project_tasks (
  project_id           uuid         NOT NULL REFERENCES fleet_projects(project_id),
  task_key             text         NOT NULL CHECK (task_key ~ '^[a-z0-9][a-z0-9._-]{0,39}$'),
  ord                  integer      NOT NULL CHECK (ord BETWEEN 1 AND 1000),
  title                text         NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  owner_role           text         NOT NULL CHECK (owner_role ~ '^[a-z][a-z0-9_-]{1,31}$'),
  capability           text         CHECK (capability ~ '^[a-z][a-z0-9_]{1,31}$'),
  hours                numeric(9,2) NOT NULL CHECK (hours > 0 AND hours <= 2000),
  deps                 text[]       NOT NULL DEFAULT '{}' CHECK (cardinality(deps) <= 20),
  deliverable          text         NOT NULL CHECK (length(deliverable) BETWEEN 1 AND 300),
  acceptance           text         NOT NULL CHECK (length(acceptance) BETWEEN 1 AND 300),
  status               text         NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','delivered','accepted','rejected','cancelled')),
  progress_bp          integer      NOT NULL DEFAULT 0 CHECK (progress_bp BETWEEN 0 AND 10000),
  assignee_agent_id    text         REFERENCES fleet_agents(agent_id),
  started_at           timestamptz,
  delivered_at         timestamptz,
  accepted_at          timestamptz,
  evidence             jsonb        NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) <= 12),
  review_note          text         CHECK (length(review_note) <= 300),
  rejections           integer      NOT NULL DEFAULT 0 CHECK (rejections >= 0),
  PRIMARY KEY (project_id, task_key)
);
CREATE TRIGGER fleet_project_tasks_no_truncate BEFORE TRUNCATE ON fleet_project_tasks FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_project_members (
  member_id             uuid         PRIMARY KEY,
  project_id            uuid         NOT NULL REFERENCES fleet_projects(project_id),
  role                  text         NOT NULL,
  agent_id              text         NOT NULL REFERENCES fleet_agents(agent_id),
  task_scope            text         NOT NULL CHECK (length(task_scope) BETWEEN 1 AND 300),
  required_capability   text         NOT NULL,
  deliverable           text         NOT NULL CHECK (length(deliverable) BETWEEN 1 AND 300),
  expected_hours        numeric(9,2) NOT NULL CHECK (expected_hours > 0 AND expected_hours <= 10000),
  deadline              timestamptz  NOT NULL,
  dependencies          text         CHECK (length(dependencies) <= 300),
  terms                 jsonb        NOT NULL,
  counter_terms         jsonb,
  status                text         NOT NULL DEFAULT 'offered' CHECK (status IN ('offered','countered','accepted','declined','withdrawn','exited','removed','completed')),
  response              text         CHECK (response IN ('ACCEPT','COUNTER','DECLINE','ACCEPT_WITH_TIMING')),
  response_reason       text         CHECK (length(response_reason) <= 300),
  start_at              timestamptz,
  expected_finish       timestamptz,
  actual_finish         timestamptz,
  contribution_status   text         NOT NULL DEFAULT 'none' CHECK (contribution_status IN ('none','in_progress','delivered','accepted','rejected','partial')),
  earned_minor          bigint       NOT NULL DEFAULT 0 CHECK (earned_minor >= 0),
  paid_minor            bigint       NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  fixed_paid            boolean      NOT NULL DEFAULT false,
  share_paid_minor      bigint       NOT NULL DEFAULT 0 CHECK (share_paid_minor >= 0),
  exit_reason           text         CHECK (length(exit_reason) <= 300),
  offered_at            timestamptz  NOT NULL DEFAULT now(),
  responded_at          timestamptz,
  accepted_at           timestamptz,
  ended_at              timestamptz,
  FOREIGN KEY (project_id, role) REFERENCES fleet_project_roles(project_id, role)
);
-- One live contract per role, and an agent holds at most one live contract per project.
CREATE UNIQUE INDEX fleet_project_members_role_live ON fleet_project_members (project_id, role) WHERE status IN ('offered','countered','accepted');
CREATE UNIQUE INDEX fleet_project_members_agent_live ON fleet_project_members (project_id, agent_id) WHERE status IN ('offered','countered','accepted');
CREATE INDEX fleet_project_members_agent ON fleet_project_members (agent_id, status);
CREATE TRIGGER fleet_project_members_no_delete BEFORE DELETE ON fleet_project_members FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_project_members_no_truncate BEFORE TRUNCATE ON fleet_project_members FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE FUNCTION fleet_project_members_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.member_id <> OLD.member_id OR NEW.project_id <> OLD.project_id OR NEW.agent_id <> OLD.agent_id OR NEW.role <> OLD.role THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a contract''s parties and role never change';
  END IF;
  IF OLD.status IN ('declined','withdrawn') AND NEW.status <> OLD.status THEN RAISE EXCEPTION 'FLEET_IMMUTABLE: a declined or withdrawn offer is final'; END IF;
  -- Terms are fixed once accepted (a change is a new contract).
  IF OLD.status = 'accepted' AND NEW.terms IS DISTINCT FROM OLD.terms THEN RAISE EXCEPTION 'FLEET_IMMUTABLE: accepted terms never change'; END IF;
  IF NEW.paid_minor < OLD.paid_minor OR NEW.share_paid_minor < OLD.share_paid_minor THEN RAISE EXCEPTION 'FLEET_IMMUTABLE: payments are never undone'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_project_members_guard BEFORE UPDATE ON fleet_project_members FOR EACH ROW EXECUTE FUNCTION fleet_project_members_guard();

CREATE TABLE fleet_project_payments (
  payment_id       uuid        PRIMARY KEY,
  project_id       uuid        NOT NULL REFERENCES fleet_projects(project_id),
  member_id        uuid        NOT NULL REFERENCES fleet_project_members(member_id),
  venture_id       uuid        NOT NULL REFERENCES fleet_ventures(venture_id),
  payer_agent_id   text        NOT NULL REFERENCES fleet_agents(agent_id),
  payee_agent_id   text        NOT NULL REFERENCES fleet_agents(agent_id),
  kind             text        NOT NULL CHECK (kind IN ('fixed','milestone','revenue_share')),
  milestone_key    text,
  amount_minor     bigint      NOT NULL CHECK (amount_minor > 0),
  from_fleet_minor bigint      NOT NULL CHECK (from_fleet_minor >= 0),
  from_own_minor   bigint      NOT NULL CHECK (from_own_minor >= 0),
  from_cash_minor  bigint      NOT NULL CHECK (from_cash_minor >= 0),
  journal_id       uuid        NOT NULL UNIQUE REFERENCES fleet_ledger_journal(journal_id),
  reason           text        NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
  at               timestamptz NOT NULL DEFAULT now(),
  CHECK (payer_agent_id <> payee_agent_id),
  CHECK (amount_minor = from_fleet_minor + from_own_minor + from_cash_minor)
);
CREATE UNIQUE INDEX fleet_project_payments_once ON fleet_project_payments (member_id, kind, COALESCE(milestone_key, '')) WHERE kind <> 'revenue_share';
CREATE TRIGGER fleet_project_payments_no_change BEFORE UPDATE OR DELETE ON fleet_project_payments FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_project_payments_no_truncate BEFORE TRUNCATE ON fleet_project_payments FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_project_events (
  seq          bigserial   PRIMARY KEY,
  project_id   uuid        NOT NULL REFERENCES fleet_projects(project_id),
  event_type   text        NOT NULL,
  agent_id     text,
  actor        text        NOT NULL,
  detail       jsonb       NOT NULL DEFAULT '{}',
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_project_events_project ON fleet_project_events (project_id, seq);
CREATE TRIGGER fleet_project_events_no_change BEFORE UPDATE OR DELETE ON fleet_project_events FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_project_events_no_truncate BEFORE TRUNCATE ON fleet_project_events FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_project_outcomes (
  project_id               uuid          PRIMARY KEY REFERENCES fleet_projects(project_id),
  outcome                  text          NOT NULL CHECK (outcome IN ('completed','cancelled')),
  team_size                integer       NOT NULL,
  solo_hours               numeric(11,2) NOT NULL,
  predicted_hours          numeric(11,2) NOT NULL,
  actual_hours             numeric(11,2),
  realised_time_saved_hours numeric(11,2),
  task_hours_delivered     numeric(11,2) NOT NULL,
  parallelism              numeric(7,2),
  coordination_hours       numeric(9,2)  NOT NULL,
  predicted_cost_minor     bigint        NOT NULL,
  actual_cost_minor        bigint        NOT NULL,
  predicted_return_minor   bigint        NOT NULL,
  actual_return_minor      bigint,
  contributions            jsonb         NOT NULL,
  failures                 jsonb         NOT NULL,
  lessons                  text          CHECK (length(lessons) <= 600),
  knowledge_id             uuid,
  recorded_at              timestamptz   NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_project_outcomes_no_change BEFORE UPDATE OR DELETE ON fleet_project_outcomes FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_project_outcomes_no_truncate BEFORE TRUNCATE ON fleet_project_outcomes FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

ALTER TABLE fleet_capital_requests ADD COLUMN project_id uuid REFERENCES fleet_projects(project_id), ADD COLUMN project_economics jsonb;

-- ═══ 3. The planner (twin of src/fleet/projects/planner.ts) ═══
-- p_tasks: [{key, role, hours, deps}] in plan order; p_offsets: {role: earliest start hours}. Greedy list schedule.
CREATE FUNCTION fleet_project_schedule(p_tasks jsonb, p_offsets jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql IMMUTABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE n integer := COALESCE(jsonb_array_length(p_tasks), 0); keys text[] := ARRAY[]::text[]; roles text[] := ARRAY[]::text[];
        dur numeric[] := ARRAY[]::numeric[]; st numeric[]; fin numeric[]; done boolean[]; avail jsonb := '{}'::jsonb;
        i integer; j integer; k integer; best integer; best_start numeric; es numeric; d text; ready boolean; last integer; cur integer; prev integer;
        path text[] := ARRAY[]::text[]; out jsonb := '[]'::jsonb; guard integer;
BEGIN
  IF n = 0 THEN RETURN jsonb_build_object('makespanHours', 0, 'tasks', '[]'::jsonb, 'criticalPath', '[]'::jsonb); END IF;
  FOR i IN 1..n LOOP
    keys := keys || (p_tasks -> (i - 1) ->> 'key'); roles := roles || (p_tasks -> (i - 1) ->> 'role');
    dur := dur || round((p_tasks -> (i - 1) ->> 'hours')::numeric, 2);
  END LOOP;
  IF (SELECT count(DISTINCT x) FROM unnest(keys) x) <> n THEN RAISE EXCEPTION 'FLEET_PROJECT_PLAN: task keys must be unique'; END IF;
  st := array_fill(0::numeric, ARRAY[n]); fin := array_fill(0::numeric, ARRAY[n]); done := array_fill(false, ARRAY[n]);
  FOR k IN 1..n LOOP
    best := NULL; best_start := NULL;
    FOR i IN 1..n LOOP
      CONTINUE WHEN done[i];
      es := GREATEST(COALESCE((avail ->> roles[i])::numeric, 0), round(COALESCE((p_offsets ->> roles[i])::numeric, 0), 2));
      ready := true;
      FOR d IN SELECT jsonb_array_elements_text(COALESCE(p_tasks -> (i - 1) -> 'deps', '[]'::jsonb)) LOOP
        j := array_position(keys, d);
        IF j IS NULL THEN RAISE EXCEPTION 'FLEET_PROJECT_PLAN: task % depends on unknown task %', keys[i], d; END IF;
        IF NOT done[j] THEN ready := false; EXIT; END IF;
        es := GREATEST(es, fin[j]);
      END LOOP;
      IF ready AND (best IS NULL OR es < best_start) THEN best := i; best_start := es; END IF;
    END LOOP;
    IF best IS NULL THEN RAISE EXCEPTION 'FLEET_PROJECT_PLAN: the task dependencies contain a cycle'; END IF;
    st[best] := best_start; fin[best] := best_start + dur[best]; done[best] := true;
    avail := avail || jsonb_build_object(roles[best], fin[best]);
  END LOOP;
  last := 1;
  FOR i IN 2..n LOOP IF fin[i] > fin[last] THEN last := i; END IF; END LOOP;
  cur := last; guard := 0;
  WHILE cur IS NOT NULL AND guard <= n LOOP
    path := keys[cur] || path; guard := guard + 1; prev := NULL;
    FOR d IN SELECT jsonb_array_elements_text(COALESCE(p_tasks -> (cur - 1) -> 'deps', '[]'::jsonb)) LOOP
      j := array_position(keys, d);
      IF fin[j] = st[cur] THEN prev := j; EXIT; END IF;
    END LOOP;
    IF prev IS NULL AND st[cur] > 0 THEN
      FOR j IN 1..n LOOP
        IF j <> cur AND roles[j] = roles[cur] AND fin[j] = st[cur] THEN prev := j; EXIT; END IF;
      END LOOP;
    END IF;
    cur := prev;
  END LOOP;
  FOR i IN 1..n LOOP out := out || jsonb_build_array(jsonb_build_object('key', keys[i], 'role', roles[i], 'startHours', st[i], 'finishHours', fin[i])); END LOOP;
  RETURN jsonb_build_object('makespanHours', fin[last], 'tasks', out, 'criticalPath', to_jsonb(path));
END $$;

-- ═══ 4. Helpers ═══
CREATE FUNCTION fleet_project_uuid(a jsonb, k text) RETURNS uuid LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF NOT (a ? k) OR (a ->> k) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: % is required (a uuid)', k;
  END IF;
  RETURN (a ->> k)::uuid;
END $$;

CREATE FUNCTION fleet_project_hours(v jsonb, label text, p_max numeric DEFAULT 2000) RETURNS numeric LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF v IS NULL OR jsonb_typeof(v) <> 'number' OR (v #>> '{}') !~ '^[0-9]{1,6}(\\.[0-9]{1,2})?$' THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: % is a number of hours with at most two decimals', label;
  END IF;
  IF (v #>> '{}')::numeric > p_max THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: % is at most % hours', label, p_max; END IF;
  RETURN (v #>> '{}')::numeric;
END $$;

-- Compensation terms: {type, fixedMinor?, revenueShareBp?, revenueShareCapMinor?, revenueShareUntil?, milestones?: [{key, taskKey, amountMinor}]}.
CREATE FUNCTION fleet_project_terms(t jsonb, p_project uuid, p_role text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_type text; v_fixed bigint; v_bp integer; v_cap bigint; v_until timestamptz; v_ms jsonb := '[]'::jsonb; m jsonb; v_keys text[] := ARRAY[]::text[];
BEGIN
  IF t IS NULL OR jsonb_typeof(t) <> 'object' THEN PERFORM fleet_econ_bad('compensation is {type: FIXED|REVENUE_SHARE|MILESTONE|HYBRID, ...}'); END IF;
  v_type := upper(COALESCE(t ->> 'type', ''));
  IF v_type NOT IN ('FIXED','REVENUE_SHARE','MILESTONE','HYBRID') THEN PERFORM fleet_econ_bad('compensation.type is FIXED, REVENUE_SHARE, MILESTONE or HYBRID'); END IF;
  v_fixed := fleet_econ_int(t, 'fixedMinor', 1, 100000000000);
  v_bp := fleet_econ_int(t, 'revenueShareBp', 1, 5000)::integer;
  v_cap := fleet_econ_int(t, 'revenueShareCapMinor', 1, 100000000000);
  IF t ? 'revenueShareUntil' THEN v_until := (t ->> 'revenueShareUntil')::timestamptz; END IF;
  IF t ? 'milestones' THEN
    IF jsonb_typeof(t -> 'milestones') <> 'array' OR jsonb_array_length(t -> 'milestones') NOT BETWEEN 1 AND 6 THEN PERFORM fleet_econ_bad('milestones is an array of 1 to 6'); END IF;
    FOR m IN SELECT x FROM jsonb_array_elements(t -> 'milestones') x LOOP
      IF jsonb_typeof(m) <> 'object' OR COALESCE(m ->> 'key', '') !~ '^[a-z0-9][a-z0-9._-]{0,39}$' OR (m ->> 'key') = ANY (v_keys) THEN
        PERFORM fleet_econ_bad('each milestone has a unique key, a taskKey and amountMinor');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM fleet_project_tasks WHERE project_id = p_project AND task_key = m ->> 'taskKey' AND owner_role = p_role) THEN
        PERFORM fleet_econ_bad(format('milestone %s: taskKey must be a task of the role %s', m ->> 'key', p_role));
      END IF;
      v_keys := v_keys || (m ->> 'key');
      v_ms := v_ms || jsonb_build_array(jsonb_build_object('key', m ->> 'key', 'taskKey', m ->> 'taskKey', 'amountMinor', fleet_econ_int(m, 'amountMinor', 1, 100000000000, true)));
    END LOOP;
  END IF;
  IF v_type = 'FIXED' AND (v_fixed IS NULL OR v_bp IS NOT NULL OR jsonb_array_length(v_ms) > 0) THEN PERFORM fleet_econ_bad('FIXED is fixedMinor only'); END IF;
  IF v_type = 'MILESTONE' AND (jsonb_array_length(v_ms) = 0 OR v_fixed IS NOT NULL OR v_bp IS NOT NULL) THEN PERFORM fleet_econ_bad('MILESTONE is milestones only'); END IF;
  IF v_type = 'REVENUE_SHARE' AND (v_bp IS NULL OR v_fixed IS NOT NULL OR jsonb_array_length(v_ms) > 0) THEN PERFORM fleet_econ_bad('REVENUE_SHARE is revenueShareBp (+ cap, end date)'); END IF;
  IF v_type = 'HYBRID' AND (v_bp IS NULL OR (v_fixed IS NULL AND jsonb_array_length(v_ms) = 0)) THEN PERFORM fleet_econ_bad('HYBRID is a fixed or milestone part plus a revenue share'); END IF;
  IF v_bp IS NOT NULL AND (v_until IS NULL OR v_until <= now() OR v_until > now() + interval '3 years') THEN
    PERFORM fleet_econ_bad('a revenue share needs revenueShareUntil: a date within 3 years (an agreed period)');
  END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object('type', v_type, 'fixedMinor', v_fixed, 'revenueShareBp', v_bp, 'revenueShareCapMinor', v_cap,
    'revenueShareUntil', v_until, 'milestones', CASE WHEN jsonb_array_length(v_ms) > 0 THEN v_ms END));
END $$;

-- What a contract needs in escrow (fixed + milestones) and what the lead should expect it to cost (+ expected share).
CREATE FUNCTION fleet_project_terms_escrow(t jsonb) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE((t ->> 'fixedMinor')::bigint, 0) + COALESCE((SELECT sum((m ->> 'amountMinor')::bigint) FROM jsonb_array_elements(COALESCE(t -> 'milestones', '[]'::jsonb)) m), 0)
$$;
CREATE FUNCTION fleet_project_terms_cost(t jsonb, p_expected bigint) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT fleet_project_terms_escrow(t) + CASE WHEN t ? 'revenueShareBp' THEN
    LEAST(COALESCE((t ->> 'revenueShareCapMinor')::bigint, 9223372036854775807), floor(GREATEST(0, p_expected)::numeric * (t ->> 'revenueShareBp')::integer / 10000)::bigint) ELSE 0 END
$$;

CREATE FUNCTION fleet_project_event(p fleet_projects, p_type text, p_agent text, p_actor text, p_detail jsonb) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_detail jsonb := jsonb_build_object('projectId', p.project_id, 'projectKey', p.project_key, 'name', p.name, 'leadAgentId', p.lead_agent_id,
                          'ventureKey', (SELECT venture_key FROM fleet_ventures WHERE venture_id = p.venture_id)) || COALESCE(p_detail, '{}'::jsonb);
BEGIN
  INSERT INTO fleet_project_events (project_id, event_type, agent_id, actor, detail) VALUES (p.project_id, p_type, p_agent, left(p_actor, 128), v_detail);
  PERFORM fleet_event(p_type, p_agent, p_actor, v_detail);
END $$;

-- The plan as the scheduler's input, and each role's earliest start (a member who accepted with a later start).
CREATE FUNCTION fleet_project_plan_tasks(p_project uuid, p_remaining boolean DEFAULT false) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('key', t.task_key, 'role', t.owner_role, 'deps', to_jsonb(t.deps),
           'hours', CASE WHEN NOT p_remaining THEN t.hours
                         WHEN t.status IN ('delivered','accepted') THEN 0
                         WHEN t.status = 'in_progress' THEN round(t.hours * (10000 - t.progress_bp) / 10000, 2)
                         ELSE t.hours END) ORDER BY t.ord), '[]'::jsonb)
    FROM fleet_project_tasks t WHERE t.project_id = p_project AND t.status <> 'cancelled'
$$;
CREATE FUNCTION fleet_project_offsets(p_project uuid) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(jsonb_object_agg(m.role, round(GREATEST(0, extract(epoch FROM (m.start_at - now())) / 3600)::numeric, 2)), '{}'::jsonb)
    FROM fleet_project_members m WHERE m.project_id = p_project AND m.status = 'accepted' AND m.start_at IS NOT NULL
$$;

-- Recompute the planner's figures and the recruitment gate (stored; the only figures ever shown).
CREATE FUNCTION fleet_project_evaluate(p_project uuid) RETURNS fleet_projects LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_projects; s jsonb; v_solo numeric; v_team numeric; v_saved numeric; v_cost bigint; v_benefit bigint; v_roles integer; r jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO p FROM fleet_projects WHERE project_id = p_project FOR UPDATE;
  s := fleet_project_schedule(fleet_project_plan_tasks(p_project), fleet_project_offsets(p_project));
  SELECT COALESCE(sum(hours), 0) INTO v_solo FROM fleet_project_tasks WHERE project_id = p_project AND status <> 'cancelled';
  SELECT count(*) INTO v_roles FROM fleet_project_roles WHERE project_id = p_project;
  v_team := (s ->> 'makespanHours')::numeric + CASE WHEN v_roles > 0 THEN p.coordination_hours ELSE 0 END;
  v_saved := v_solo - v_team;
  -- Expected cost: live contracts at their terms, unfilled roles at their proposed terms.
  SELECT COALESCE(sum(CASE WHEN m.member_id IS NOT NULL THEN fleet_project_terms_cost(COALESCE(m.terms, ro.proposed_terms), p.expected_value_minor) ELSE ro.expected_cost_minor END), 0)
    INTO v_cost
    FROM fleet_project_roles ro LEFT JOIN fleet_project_members m ON m.project_id = ro.project_id AND m.role = ro.role AND m.status IN ('offered','countered','accepted')
   WHERE ro.project_id = p_project;
  v_cost := v_cost + CASE WHEN v_roles > 0 THEN p.coordination_cost_minor ELSE 0 END;
  v_benefit := floor(round(v_saved * 100) * p.time_value_minor_per_day / 2400)::bigint + p.quality_benefit_minor;
  r := jsonb_build_array(
    format('solo %s h (one agent, every task in turn); team %s h = critical path %s h + coordination %s h', v_solo, v_team, s ->> 'makespanHours', CASE WHEN v_roles > 0 THEN p.coordination_hours ELSE 0 END),
    format('time saved %s h valued at %s per day = %s; quality/risk benefit %s', v_saved, p.time_value_minor_per_day, v_benefit - p.quality_benefit_minor, p.quality_benefit_minor),
    format('expected cost: contracts %s + coordination %s = %s', v_cost - CASE WHEN v_roles > 0 THEN p.coordination_cost_minor ELSE 0 END, CASE WHEN v_roles > 0 THEN p.coordination_cost_minor ELSE 0 END, v_cost),
    CASE WHEN v_benefit > v_cost THEN 'justified: expected benefit exceeds collaboration cost plus coordination overhead'
         ELSE 'not justified: expected benefit does not exceed collaboration cost plus coordination overhead' END);
  UPDATE fleet_projects SET solo_hours = v_solo, team_hours = v_team, makespan_hours = (s ->> 'makespanHours')::numeric, planned_time_saved_hours = v_saved,
         critical_path = ARRAY(SELECT jsonb_array_elements_text(s -> 'criticalPath')), benefit_minor = v_benefit, cost_minor = v_cost, gate_reasons = r
   WHERE project_id = p_project RETURNING * INTO p;
  RETURN p;
END $$;

-- The plan's projection from actual progress (remaining work from now; coordination pro rata to the work remaining).
CREATE FUNCTION fleet_project_projection(p fleet_projects) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE s jsonb; v_total numeric; v_left numeric; v_rem numeric; v_elapsed numeric; v_roles integer;
BEGIN
  IF p.status IN ('completed','cancelled') THEN
    RETURN jsonb_build_object('remainingHours', 0, 'projectedFinishAt', COALESCE(p.completed_at, p.cancelled_at),
      'projectedTotalHours', CASE WHEN p.started_at IS NOT NULL THEN round((extract(epoch FROM (COALESCE(p.completed_at, p.cancelled_at) - p.started_at)) / 3600)::numeric, 2) END);
  END IF;
  s := fleet_project_schedule(fleet_project_plan_tasks(p.project_id, true), fleet_project_offsets(p.project_id));
  SELECT COALESCE(sum(hours), 0) INTO v_total FROM fleet_project_tasks WHERE project_id = p.project_id AND status <> 'cancelled';
  SELECT COALESCE(sum((x ->> 'hours')::numeric), 0) INTO v_left FROM jsonb_array_elements(fleet_project_plan_tasks(p.project_id, true)) x;
  SELECT count(*) INTO v_roles FROM fleet_project_roles WHERE project_id = p.project_id;
  v_rem := (s ->> 'makespanHours')::numeric + CASE WHEN v_roles > 0 AND v_total > 0 THEN round(p.coordination_hours * v_left / v_total, 2) ELSE 0 END;
  v_elapsed := CASE WHEN p.started_at IS NOT NULL THEN round((extract(epoch FROM (now() - p.started_at)) / 3600)::numeric, 2) ELSE 0 END;
  RETURN jsonb_build_object('remainingHours', v_rem, 'remainingWorkHours', v_left, 'projectedFinishAt', now() + make_interval(secs => (v_rem * 3600)::double precision),
    'projectedTotalHours', v_elapsed + v_rem, 'criticalPath', s -> 'criticalPath');
END $$;

-- Committed (not yet paid) escrow needs of live contracts, and what is free.
CREATE FUNCTION fleet_project_committed(p_project uuid) RETURNS bigint LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(sum(GREATEST(0, fleet_project_terms_escrow(m.terms) - (m.paid_minor - m.share_paid_minor))), 0)::bigint
    FROM fleet_project_members m WHERE m.project_id = p_project AND m.status = 'accepted'
$$;

CREATE FUNCTION fleet_project_economics(p fleet_projects) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('projectId', p.project_id, 'expectedValueMinor', p.expected_value_minor, 'expectedReturnMinor', p.expected_return_minor,
    'budgetMinor', p.budget_minor, 'coordinationBudgetMinor', p.coordination_cost_minor, 'opportunityCostMinor', p.opportunity_cost_minor,
    'soloHours', p.solo_hours, 'teamHours', p.team_hours, 'timeSavedHours', p.planned_time_saved_hours, 'benefitMinor', p.benefit_minor, 'costMinor', p.cost_minor,
    'roiBp', CASE WHEN p.budget_minor > 0 THEN (p.expected_return_minor * 10000 / p.budget_minor) END, 'risk', p.risk, 'gate', p.gate_reasons)
$$;

CREATE FUNCTION fleet_project_post(p_kind text, p_idem text, p_actor text, p_reason text, p_agent text, p_lines jsonb) RETURNS uuid LANGUAGE sql
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT fleet_ledger_post(p_kind, p_idem, p_actor, left(p_reason, 200), 'controller', p_agent, NULL, NULL, NULL, NULL, now(), p_lines)
$$;

-- One payment: from escrow (Fleet capital first — what it was approved for — then own), or for a revenue share from the
-- lead's spendable cash. Balanced: payer project expense / payee project income.
CREATE FUNCTION fleet_project_pay(p_project uuid, p_member uuid, p_kind text, p_ms text, p_amount bigint, p_actor text, p_reason text) RETURNS bigint LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_projects; m fleet_project_members; v_fleet bigint := 0; v_own bigint := 0; v_cash bigint := 0; v_j uuid; v_id uuid := gen_random_uuid(); v_lines jsonb;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN 0; END IF;
  SELECT * INTO p FROM fleet_projects WHERE project_id = p_project FOR UPDATE;
  SELECT * INTO m FROM fleet_project_members WHERE member_id = p_member FOR UPDATE;
  IF p_kind <> 'revenue_share' AND EXISTS (SELECT 1 FROM fleet_project_payments WHERE member_id = p_member AND kind = p_kind AND COALESCE(milestone_key, '') = COALESCE(p_ms, '')) THEN
    RETURN 0;  -- already paid (exactly once)
  END IF;
  PERFORM fleet_ledger_open_agent(p.lead_agent_id, p_actor); PERFORM fleet_ledger_open_agent(m.agent_id, p_actor);
  IF p_kind = 'revenue_share' THEN
    v_cash := p_amount;
  ELSE
    IF p.escrow_fleet_minor + p.escrow_own_minor < p_amount THEN RAISE EXCEPTION 'FLEET_PROJECT_UNFUNDED: the escrow holds % of the % due', p.escrow_fleet_minor + p.escrow_own_minor, p_amount; END IF;
    v_fleet := LEAST(p.escrow_fleet_minor, p_amount); v_own := p_amount - v_fleet;
  END IF;
  v_lines := jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(p.lead_agent_id, 'agent_project_expense'), 'side', 'D', 'amount', p_amount));
  IF v_fleet + v_own > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(p.lead_agent_id, 'agent_project_escrow'), 'side', 'C', 'amount', v_fleet + v_own)); END IF;
  IF v_cash > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(p.lead_agent_id, 'agent_cash'), 'side', 'C', 'amount', v_cash)); END IF;
  v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(m.agent_id, 'agent_cash'), 'side', 'D', 'amount', p_amount),
                                          jsonb_build_object('account', fleet_ledger_account(m.agent_id, 'agent_project_income'), 'side', 'C', 'amount', p_amount));
  v_j := fleet_project_post('project_payment', 'prjpay:' || v_id, p_actor, p_kind || ' — ' || p.name || ': ' || p_reason, p.lead_agent_id, v_lines);
  INSERT INTO fleet_project_payments (payment_id, project_id, member_id, venture_id, payer_agent_id, payee_agent_id, kind, milestone_key, amount_minor,
      from_fleet_minor, from_own_minor, from_cash_minor, journal_id, reason)
    VALUES (v_id, p_project, p_member, p.venture_id, p.lead_agent_id, m.agent_id, p_kind, p_ms, p_amount, v_fleet, v_own, v_cash, v_j, left(p_reason, 300));
  IF v_fleet + v_own > 0 THEN
    UPDATE fleet_projects SET escrow_fleet_minor = escrow_fleet_minor - v_fleet, escrow_own_minor = escrow_own_minor - v_own,
           fleet_paid_minor = fleet_paid_minor + v_fleet, own_paid_minor = own_paid_minor + v_own WHERE project_id = p_project;
  END IF;
  UPDATE fleet_project_members SET paid_minor = paid_minor + p_amount, earned_minor = earned_minor + p_amount,
         share_paid_minor = share_paid_minor + CASE WHEN p_kind = 'revenue_share' THEN p_amount ELSE 0 END,
         fixed_paid = fixed_paid OR p_kind = 'fixed' WHERE member_id = p_member;
  PERFORM fleet_project_event(p, 'project_payment', p.lead_agent_id, p_actor, jsonb_build_object('fromAgentId', p.lead_agent_id, 'toAgentId', m.agent_id,
    'memberId', m.member_id, 'role', m.role, 'kind', p_kind, 'milestone', p_ms, 'amountMinor', p_amount, 'fromFleetCapitalMinor', v_fleet, 'fromOwnMinor', v_own + v_cash,
    'internal', true));
  RETURN p_amount;
END $$;

-- What a contract has earned and not been paid. p_delivered: count delivered-but-unreviewed work as earned
-- (cancellation, removal, death — the lead cannot avoid paying by not reviewing).
CREATE FUNCTION fleet_project_settle_member(p_member uuid, p_delivered boolean, p_actor text, p_reason text) RETURNS bigint LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE m fleet_project_members; ms jsonb; v_paid bigint := 0; v_ok text[] := CASE WHEN p_delivered THEN ARRAY['accepted','delivered'] ELSE ARRAY['accepted'] END; v_all boolean;
BEGIN
  SELECT * INTO m FROM fleet_project_members WHERE member_id = p_member;
  IF m.status NOT IN ('accepted','exited','removed','completed') THEN RETURN 0; END IF;
  FOR ms IN SELECT x FROM jsonb_array_elements(COALESCE(m.terms -> 'milestones', '[]'::jsonb)) x LOOP
    IF EXISTS (SELECT 1 FROM fleet_project_tasks WHERE project_id = m.project_id AND task_key = ms ->> 'taskKey' AND status = ANY (v_ok) AND assignee_agent_id = m.agent_id) THEN
      v_paid := v_paid + fleet_project_pay(m.project_id, m.member_id, 'milestone', ms ->> 'key', (ms ->> 'amountMinor')::bigint, p_actor, p_reason || ' (milestone ' || (ms ->> 'key') || ')');
    END IF;
  END LOOP;
  IF m.terms ? 'fixedMinor' AND NOT m.fixed_paid THEN
    SELECT bool_and(t.status = ANY (v_ok) AND t.assignee_agent_id = m.agent_id) INTO v_all
      FROM fleet_project_tasks t WHERE t.project_id = m.project_id AND t.owner_role = m.role AND t.status <> 'cancelled';
    IF COALESCE(v_all, false) THEN v_paid := v_paid + fleet_project_pay(m.project_id, m.member_id, 'fixed', NULL, (m.terms ->> 'fixedMinor')::bigint, p_actor, p_reason || ' (fixed)'); END IF;
  END IF;
  RETURN v_paid;
END $$;

-- Return all unspent escrow to its sources.
CREATE FUNCTION fleet_project_release(p_project uuid, p_actor text, p_reason text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_projects; e fleet_envelopes; v_own bigint; v_fleet bigint; v_env boolean;
BEGIN
  SELECT * INTO p FROM fleet_projects WHERE project_id = p_project FOR UPDATE;
  v_own := p.escrow_own_minor; v_fleet := p.escrow_fleet_minor;
  IF v_own > 0 THEN
    PERFORM fleet_project_post('project_escrow_release', 'prjrel:' || p.project_id || ':' || gen_random_uuid(), p_actor, 'project escrow returned: ' || p_reason, p.lead_agent_id,
      jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(p.lead_agent_id, 'agent_cash'), 'side', 'D', 'amount', v_own),
                        jsonb_build_object('account', fleet_ledger_account(p.lead_agent_id, 'agent_project_escrow'), 'side', 'C', 'amount', v_own)));
  END IF;
  IF v_fleet > 0 THEN
    SELECT * INTO e FROM fleet_envelopes WHERE envelope_id = p.envelope_id;
    v_env := e.status IN ('active','frozen');
    IF v_env THEN
      PERFORM fleet_project_post('project_envelope_release', 'prjenv:' || p.project_id || ':' || gen_random_uuid(), p_actor, 'project escrow returned to its envelope: ' || p_reason, p.lead_agent_id,
        jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(p.lead_agent_id, 'agent_envelope_cash'), 'side', 'D', 'amount', v_fleet),
                          jsonb_build_object('account', fleet_ledger_account(p.lead_agent_id, 'agent_project_escrow'), 'side', 'C', 'amount', v_fleet)));
    ELSE
      PERFORM fleet_project_post('project_envelope_return', 'prjtre:' || p.project_id || ':' || gen_random_uuid(), p_actor, 'project escrow returned to the Treasury (envelope closed): ' || p_reason, p.lead_agent_id,
        jsonb_build_array(jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', v_fleet),
                          jsonb_build_object('account', fleet_ledger_account(p.lead_agent_id, 'agent_project_escrow'), 'side', 'C', 'amount', v_fleet)));
    END IF;
  END IF;
  UPDATE fleet_projects SET escrow_own_minor = 0, escrow_fleet_minor = 0,
         fleet_returned_minor = fleet_returned_minor + CASE WHEN v_fleet > 0 AND NOT v_env THEN v_fleet ELSE 0 END WHERE project_id = p_project;
  RETURN jsonb_build_object('ownReturnedMinor', v_own, 'fleetReturnedMinor', v_fleet, 'fleetReturnedTo', CASE WHEN v_fleet > 0 THEN CASE WHEN v_env THEN 'envelope' ELSE 'treasury' END END);
END $$;

-- Finish a project (completed or cancelled): settle every live contract, return escrow, record the outcome.
CREATE FUNCTION fleet_project_finish(p_project uuid, p_outcome text, p_actor text, p_reason text, p_actual_return bigint, p_lessons text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_projects; m fleet_project_members; v_paid bigint := 0; rel jsonb; v_actual numeric; v_task_hours numeric; v_kid uuid; v_contrib jsonb; v_fail jsonb; v_cost bigint;
BEGIN
  SELECT * INTO p FROM fleet_projects WHERE project_id = p_project FOR UPDATE;
  FOR m IN SELECT * FROM fleet_project_members WHERE project_id = p_project AND status IN ('accepted','exited','removed') ORDER BY offered_at LOOP
    v_paid := v_paid + fleet_project_settle_member(m.member_id, p_outcome = 'cancelled', p_actor, p_outcome || ': ' || p_reason);
  END LOOP;
  UPDATE fleet_project_members SET status = CASE WHEN p_outcome = 'completed' THEN 'completed' ELSE 'exited' END, ended_at = now(),
         actual_finish = COALESCE(actual_finish, now()), exit_reason = CASE WHEN p_outcome = 'cancelled' THEN left('project cancelled: ' || p_reason, 300) END
   WHERE project_id = p_project AND status = 'accepted';
  UPDATE fleet_project_members SET status = 'withdrawn', ended_at = now(), exit_reason = left('project ' || p_outcome, 300)
   WHERE project_id = p_project AND status IN ('offered','countered');
  UPDATE fleet_project_tasks SET status = 'cancelled' WHERE project_id = p_project AND status IN ('pending','in_progress','rejected');
  rel := fleet_project_release(p_project, p_actor, p_outcome || ': ' || p_reason);
  SELECT * INTO p FROM fleet_projects WHERE project_id = p_project;
  v_actual := CASE WHEN p.started_at IS NOT NULL THEN round((extract(epoch FROM (now() - p.started_at)) / 3600)::numeric, 2) END;
  SELECT COALESCE(sum(hours), 0) INTO v_task_hours FROM fleet_project_tasks WHERE project_id = p_project AND status IN ('accepted','delivered');
  SELECT COALESCE(sum(amount_minor), 0) INTO v_cost FROM fleet_project_payments WHERE project_id = p_project;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('agentId', x.agent_id, 'role', x.role, 'status', x.status, 'paidMinor', x.paid_minor,
           'tasksAccepted', (SELECT count(*) FROM fleet_project_tasks t WHERE t.project_id = p_project AND t.assignee_agent_id = x.agent_id AND t.status = 'accepted'),
           'rejections', (SELECT COALESCE(sum(t.rejections), 0) FROM fleet_project_tasks t WHERE t.project_id = p_project AND t.assignee_agent_id = x.agent_id))), '[]'::jsonb)
    INTO v_contrib FROM fleet_project_members x WHERE x.project_id = p_project AND x.accepted_at IS NOT NULL;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('type', e.event_type, 'agentId', e.agent_id, 'detail', e.detail - 'projectId' - 'projectKey' - 'name' - 'leadAgentId' - 'ventureKey', 'at', e.at) ORDER BY e.seq), '[]'::jsonb)
    INTO v_fail FROM fleet_project_events e WHERE e.project_id = p_project AND e.event_type IN ('project_task_rejected','project_member_exited','project_member_removed','project_member_declined');
  IF p_outcome = 'completed' OR v_actual IS NOT NULL THEN
    v_kid := gen_random_uuid();
    INSERT INTO fleet_economic_knowledge (knowledge_id, agent_id, topic, subject, claim, evidence, venture_id, confidence_bp, expires_at)
      VALUES (v_kid, p.lead_agent_id, 'team_project', left('project/' || p.project_key, 80),
        left(format('%s team project "%s": %s agents, planned %s h (solo %s h), actual %s h; cost %s vs predicted %s; return %s vs predicted %s.%s',
          p_outcome, p.name, (SELECT count(*) FROM fleet_project_members x WHERE x.project_id = p_project AND x.accepted_at IS NOT NULL) + 1,
          p.team_hours, p.solo_hours, COALESCE(v_actual::text, 'n/a'), v_cost, p.cost_minor - p.coordination_cost_minor,
          COALESCE(p_actual_return::text, 'n/a'), p.expected_return_minor, COALESCE(' Lessons: ' || p_lessons, '')), 600),
        '[]'::jsonb, p.venture_id, NULL, now() + interval '365 days');
  END IF;
  INSERT INTO fleet_project_outcomes (project_id, outcome, team_size, solo_hours, predicted_hours, actual_hours, realised_time_saved_hours, task_hours_delivered,
      parallelism, coordination_hours, predicted_cost_minor, actual_cost_minor, predicted_return_minor, actual_return_minor, contributions, failures, lessons, knowledge_id)
    VALUES (p_project, p_outcome, jsonb_array_length(v_contrib) + 1, p.solo_hours, p.team_hours, v_actual,
      CASE WHEN p_outcome = 'completed' AND v_actual IS NOT NULL THEN p.solo_hours - v_actual END, v_task_hours,
      CASE WHEN v_actual > 0 THEN round(v_task_hours / v_actual, 2) END, p.coordination_hours,
      p.cost_minor - p.coordination_cost_minor, v_cost, p.expected_return_minor, p_actual_return, v_contrib, v_fail, fleet_scrub(p_lessons), v_kid);
  UPDATE fleet_projects SET status = p_outcome, stage = p_outcome, completed_at = CASE WHEN p_outcome = 'completed' THEN now() END,
         cancelled_at = CASE WHEN p_outcome = 'cancelled' THEN now() END, cancel_reason = CASE WHEN p_outcome = 'cancelled' THEN left(p_reason, 300) END
   WHERE project_id = p_project RETURNING * INTO p;
  PERFORM fleet_project_event(p, 'project_' || p_outcome, p.lead_agent_id, p_actor, jsonb_build_object('reason', p_reason, 'paidOnSettlementMinor', v_paid,
    'returned', rel, 'actualHours', v_actual, 'realisedTimeSavedHours', CASE WHEN p_outcome = 'completed' AND v_actual IS NOT NULL THEN p.solo_hours - v_actual END));
  RETURN jsonb_build_object('paidOnSettlementMinor', v_paid, 'returned', rel);
END $$;

-- ═══ 5. JSON views ═══
CREATE FUNCTION fleet_project_member_json(m fleet_project_members) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('memberId', m.member_id, 'agentId', m.agent_id, 'name', (SELECT name FROM fleet_agents WHERE agent_id = m.agent_id),
    'role', m.role, 'taskScope', m.task_scope, 'requiredCapability', m.required_capability, 'deliverable', m.deliverable, 'expectedHours', m.expected_hours,
    'deadline', m.deadline, 'dependencies', m.dependencies, 'compensation', m.terms, 'counterTerms', m.counter_terms, 'status', m.status, 'response', m.response,
    'responseReason', m.response_reason, 'startAt', m.start_at, 'expectedFinish', m.expected_finish, 'actualFinish', m.actual_finish,
    'contributionStatus', m.contribution_status, 'earnedMinor', m.earned_minor, 'paidMinor', m.paid_minor, 'revenueSharePaidMinor', m.share_paid_minor,
    'exitReason', m.exit_reason, 'offeredAt', m.offered_at, 'respondedAt', m.responded_at, 'acceptedAt', m.accepted_at, 'endedAt', m.ended_at))
$$;

CREATE FUNCTION fleet_project_json(p fleet_projects, p_detail boolean DEFAULT true) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE pr jsonb := fleet_project_projection(p); o fleet_project_outcomes;
BEGIN
  SELECT * INTO o FROM fleet_project_outcomes WHERE project_id = p.project_id;
  RETURN jsonb_strip_nulls(jsonb_build_object(
    'projectId', p.project_id, 'projectKey', p.project_key, 'name', p.name, 'objective', p.objective,
    'ventureId', p.venture_id, 'ventureKey', (SELECT venture_key FROM fleet_ventures WHERE venture_id = p.venture_id),
    'leadAgentId', p.lead_agent_id, 'leadName', (SELECT name FROM fleet_agents WHERE agent_id = p.lead_agent_id),
    'status', p.status, 'stage', p.stage, 'planVersion', p.plan_version, 'risk', p.risk, 'riskNote', p.risk_note,
    'createdAt', p.created_at, 'startedAt', p.started_at, 'completedAt', p.completed_at, 'cancelledAt', p.cancelled_at, 'cancelReason', p.cancel_reason,
    'targetCompletion', p.target_completion,
    'teamSize', 1 + (SELECT count(*) FROM fleet_project_members m WHERE m.project_id = p.project_id AND m.status IN ('accepted','completed')),
    'economics', jsonb_build_object('expectedValueMinor', p.expected_value_minor, 'expectedReturnMinor', p.expected_return_minor, 'budgetMinor', p.budget_minor,
        'coordinationBudgetMinor', p.coordination_cost_minor, 'opportunityCostMinor', p.opportunity_cost_minor, 'timeValueMinorPerDay', p.time_value_minor_per_day,
        'qualityBenefitMinor', p.quality_benefit_minor, 'benefitMinor', p.benefit_minor, 'costMinor', p.cost_minor, 'justified', p.benefit_minor > p.cost_minor,
        'gate', p.gate_reasons, 'roiBp', CASE WHEN p.budget_minor > 0 THEN (p.expected_return_minor * 10000 / p.budget_minor) END,
        'fundingSource', CASE WHEN p.escrow_fleet_minor + p.fleet_paid_minor + p.fleet_returned_minor > 0 AND p.escrow_own_minor + p.own_paid_minor > 0 THEN 'mixed'
                              WHEN p.envelope_id IS NOT NULL THEN 'fleet_capital' WHEN p.escrow_own_minor + p.own_paid_minor > 0 THEN 'own_capital' ELSE 'unfunded' END,
        'envelopeId', p.envelope_id, 'escrowMinor', p.escrow_own_minor + p.escrow_fleet_minor, 'escrowOwnMinor', p.escrow_own_minor, 'escrowFleetMinor', p.escrow_fleet_minor,
        'committedMinor', fleet_project_committed(p.project_id), 'paidMinor', (SELECT COALESCE(sum(amount_minor), 0) FROM fleet_project_payments WHERE project_id = p.project_id),
        'justification', CASE WHEN p_detail THEN p.justification END),
    'eta', jsonb_build_object('soloHours', p.solo_hours, 'teamHours', p.team_hours, 'criticalPathHours', p.makespan_hours,
        'coordinationHours', p.coordination_hours, 'plannedTimeSavedHours', p.planned_time_saved_hours, 'criticalPath', to_jsonb(p.critical_path),
        'projectedRemainingHours', pr -> 'remainingHours', 'projectedFinishAt', pr -> 'projectedFinishAt', 'projectedTotalHours', pr -> 'projectedTotalHours',
        'actualHours', o.actual_hours, 'realisedTimeSavedHours', o.realised_time_saved_hours),
    'members', (SELECT COALESCE(jsonb_agg(fleet_project_member_json(m) ORDER BY m.offered_at), '[]'::jsonb) FROM fleet_project_members m WHERE m.project_id = p.project_id
                 AND (p_detail OR m.status IN ('offered','countered','accepted','completed'))),
    'roles', CASE WHEN p_detail THEN (SELECT COALESCE(jsonb_agg(jsonb_build_object('role', r.role, 'taskScope', r.task_scope, 'requiredCapability', r.required_capability,
                 'proposedCompensation', r.proposed_terms, 'expectedCostMinor', r.expected_cost_minor) ORDER BY r.role), '[]'::jsonb) FROM fleet_project_roles r WHERE r.project_id = p.project_id) END,
    'tasks', (SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('key', t.task_key, 'title', t.title, 'ownerRole', t.owner_role, 'assigneeAgentId', t.assignee_agent_id,
                 'hours', t.hours, 'deps', to_jsonb(t.deps), 'status', t.status, 'progressBp', t.progress_bp, 'deliverable', t.deliverable, 'acceptance', t.acceptance,
                 'startedAt', t.started_at, 'deliveredAt', t.delivered_at, 'acceptedAt', t.accepted_at, 'reviewNote', t.review_note, 'rejections', t.rejections)) ORDER BY t.ord), '[]'::jsonb)
               FROM fleet_project_tasks t WHERE t.project_id = p.project_id),
    'events', CASE WHEN p_detail THEN (SELECT COALESCE(jsonb_agg(jsonb_build_object('at', e.at, 'type', e.event_type, 'agentId', e.agent_id,
                 'detail', e.detail - 'projectId' - 'projectKey' - 'name' - 'leadAgentId' - 'ventureKey') ORDER BY e.seq DESC), '[]'::jsonb)
               FROM (SELECT * FROM fleet_project_events WHERE project_id = p.project_id ORDER BY seq DESC LIMIT 30) e) END,
    'outcome', CASE WHEN o.project_id IS NOT NULL THEN jsonb_strip_nulls(to_jsonb(o) - 'project_id') END));
END $$;

-- Competency from completed work only (no birth-assigned scores, no universal ranking): per agent and capability.
CREATE VIEW fleet_agent_competency AS
  SELECT t.assignee_agent_id AS agent_id,
         COALESCE(t.capability, r.required_capability, 'lead') AS capability,
         count(*) FILTER (WHERE t.status = 'accepted') AS tasks_accepted,
         COALESCE(sum(t.rejections), 0) AS rejections,
         count(*) FILTER (WHERE t.status = 'accepted' AND (m.deadline IS NULL OR t.delivered_at <= m.deadline)) AS delivered_on_time,
         count(*) FILTER (WHERE t.status = 'accepted' AND m.deadline IS NOT NULL AND t.delivered_at > m.deadline) AS delivered_late,
         COALESCE(sum(t.hours) FILTER (WHERE t.status = 'accepted'), 0) AS estimated_hours,
         COALESCE(round((sum(extract(epoch FROM (t.delivered_at - t.started_at))) FILTER (WHERE t.status = 'accepted') / 3600)::numeric, 2), 0) AS actual_hours,
         count(DISTINCT t.project_id) AS projects,
         count(DISTINCT t.project_id) FILTER (WHERE pj.status = 'completed') AS projects_completed
    FROM fleet_project_tasks t
    JOIN fleet_projects pj ON pj.project_id = t.project_id
    LEFT JOIN fleet_project_roles r ON r.project_id = t.project_id AND r.role = t.owner_role
    LEFT JOIN LATERAL (SELECT x.deadline FROM fleet_project_members x WHERE x.project_id = t.project_id AND x.role = t.owner_role AND x.agent_id = t.assignee_agent_id
                        ORDER BY x.offered_at DESC LIMIT 1) m ON true
   WHERE t.assignee_agent_id IS NOT NULL AND t.status IN ('accepted','delivered','rejected')
   GROUP BY 1, 2;

-- ═══ 6. Agent operations ═══
CREATE FUNCTION fleet_project_for_lead(p_agent text, a jsonb) RETURNS fleet_projects LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_projects;
BEGIN
  SELECT * INTO p FROM fleet_projects WHERE project_id = fleet_project_uuid(a, 'projectId') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such project'; END IF;
  IF p.lead_agent_id <> p_agent THEN RAISE EXCEPTION 'FLEET_PROJECT_NOT_LEAD: only the project''s lead decides this'; END IF;
  RETURN p;
END $$;

CREATE FUNCTION fleet_project_stage(a jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF NOT (a ? 'stage') THEN RETURN NULL; END IF;
  IF lower(a ->> 'stage') NOT IN ('planning','recruiting','research','building','integration','launch','review') THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: stage is planning, recruiting, research, building, integration, launch or review';
  END IF;
  RETURN lower(a ->> 'stage');
END $$;

CREATE FUNCTION fleet_project_live(p fleet_projects) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p.status NOT IN ('planning','active') THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: the project is %', p.status; END IF;
END $$;

-- Replace the plan (tasks and roles) of a planning/active project; work already started keeps its task.
CREATE FUNCTION fleet_project_set_plan(p fleet_projects, a jsonb) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t jsonb; r jsonb; v_ord integer := 0; v_keys text[] := ARRAY[]::text[]; v_roles text[] := ARRAY['lead']; v_deps text[]; v_terms jsonb; v_role text;
BEGIN
  IF jsonb_typeof(a -> 'roles') IS DISTINCT FROM 'array' OR jsonb_array_length(a -> 'roles') > 12 THEN PERFORM fleet_econ_bad('roles is an array (0 to 12) of {role, taskScope, requiredCapability, compensation}'); END IF;
  IF jsonb_typeof(a -> 'tasks') IS DISTINCT FROM 'array' OR jsonb_array_length(a -> 'tasks') NOT BETWEEN 1 AND 60 THEN PERFORM fleet_econ_bad('tasks is an array of 1 to 60 {key, title, ownerRole, hours, deps, deliverable, acceptance}'); END IF;
  FOR r IN SELECT x FROM jsonb_array_elements(a -> 'roles') x LOOP
    v_role := lower(COALESCE(r ->> 'role', ''));
    IF v_role !~ '^[a-z][a-z0-9_-]{1,31}$' OR v_role = 'lead' OR v_role = ANY (v_roles) THEN PERFORM fleet_econ_bad('each role has a unique slug (not "lead")'); END IF;
    v_roles := v_roles || v_role;
  END LOOP;
  -- Tasks: validate, then upsert by key (started work must stay in the plan with its owner).
  FOR t IN SELECT x FROM jsonb_array_elements(a -> 'tasks') x LOOP
    IF COALESCE(t ->> 'key', '') !~ '^[a-z0-9][a-z0-9._-]{0,39}$' OR (t ->> 'key') = ANY (v_keys) THEN PERFORM fleet_econ_bad('each task has a unique key (slug)'); END IF;
    IF NOT (lower(COALESCE(t ->> 'ownerRole', '')) = ANY (v_roles)) THEN PERFORM fleet_econ_bad(format('task %s: ownerRole is "lead" or one of the roles', t ->> 'key')); END IF;
    v_keys := v_keys || (t ->> 'key');
  END LOOP;
  IF EXISTS (SELECT 1 FROM fleet_project_tasks x WHERE x.project_id = p.project_id AND x.status IN ('in_progress','delivered','accepted')
               AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(a -> 'tasks') y WHERE y ->> 'key' = x.task_key AND lower(y ->> 'ownerRole') = x.owner_role)) THEN
    RAISE EXCEPTION 'FLEET_PROJECT_PLAN: tasks already started stay in the plan with the same owner';
  END IF;
  UPDATE fleet_project_tasks SET status = 'cancelled' WHERE project_id = p.project_id AND status IN ('pending','rejected') AND NOT (task_key = ANY (v_keys));
  -- Tasks no longer in the plan keep their record (cancelled) after the live plan's order.
  UPDATE fleet_project_tasks SET ord = LEAST(1000, 100 + ord) WHERE project_id = p.project_id AND status = 'cancelled' AND ord <= 100;
  FOR t IN SELECT x FROM jsonb_array_elements(a -> 'tasks') x LOOP
    v_ord := v_ord + 1;
    IF jsonb_typeof(t -> 'deps') IS NOT NULL AND jsonb_typeof(t -> 'deps') <> 'array' THEN PERFORM fleet_econ_bad('deps is an array of task keys'); END IF;
    v_deps := ARRAY(SELECT jsonb_array_elements_text(COALESCE(t -> 'deps', '[]'::jsonb)));
    IF (t ->> 'key') = ANY (v_deps) THEN PERFORM fleet_econ_bad(format('task %s cannot depend on itself', t ->> 'key')); END IF;
    IF EXISTS (SELECT 1 FROM unnest(v_deps) d WHERE NOT (d = ANY (v_keys))) THEN PERFORM fleet_econ_bad(format('task %s depends on a task that is not in the plan', t ->> 'key')); END IF;
    INSERT INTO fleet_project_tasks (project_id, task_key, ord, title, owner_role, capability, hours, deps, deliverable, acceptance)
      VALUES (p.project_id, t ->> 'key', v_ord, COALESCE(fleet_econ_text(t, 'title', 160), t ->> 'key'), lower(t ->> 'ownerRole'),
              CASE WHEN t ? 'capability' THEN lower(t ->> 'capability') END, fleet_project_hours(t -> 'hours', 'task ' || (t ->> 'key') || ' hours'), v_deps,
              fleet_econ_text(t, 'deliverable', 300, true), fleet_econ_text(t, 'acceptance', 300, true))
    ON CONFLICT (project_id, task_key) DO UPDATE SET ord = EXCLUDED.ord, title = EXCLUDED.title, owner_role = EXCLUDED.owner_role, capability = EXCLUDED.capability,
         hours = EXCLUDED.hours, deps = EXCLUDED.deps, deliverable = EXCLUDED.deliverable, acceptance = EXCLUDED.acceptance,
         status = CASE WHEN fleet_project_tasks.status = 'cancelled' THEN 'pending' ELSE fleet_project_tasks.status END;
  END LOOP;
  -- Validate the graph now (unknown deps / cycles raise).
  PERFORM fleet_project_schedule(fleet_project_plan_tasks(p.project_id), '{}'::jsonb);
  -- Roles: new or updated proposed terms (a role with a live contract keeps its contract).
  FOR r IN SELECT x FROM jsonb_array_elements(a -> 'roles') x LOOP
    v_role := lower(r ->> 'role');
    INSERT INTO fleet_project_roles (project_id, role, task_scope, required_capability, proposed_terms, expected_cost_minor, plan_version)
      VALUES (p.project_id, v_role, fleet_econ_text(r, 'taskScope', 300, true), lower(COALESCE(r ->> 'requiredCapability', '')), '{}'::jsonb, 0, p.plan_version)
    ON CONFLICT (project_id, role) DO UPDATE SET task_scope = EXCLUDED.task_scope, required_capability = EXCLUDED.required_capability, plan_version = EXCLUDED.plan_version;
    IF NOT EXISTS (SELECT 1 FROM fleet_project_tasks WHERE project_id = p.project_id AND owner_role = v_role AND status <> 'cancelled') THEN
      PERFORM fleet_econ_bad(format('role %s owns no task: recruit only for real work', v_role));
    END IF;
    v_terms := fleet_project_terms(r -> 'compensation', p.project_id, v_role);
    UPDATE fleet_project_roles SET proposed_terms = v_terms, expected_cost_minor = fleet_project_terms_cost(v_terms, p.expected_value_minor)
     WHERE project_id = p.project_id AND role = v_role;
  END LOOP;
  IF EXISTS (SELECT 1 FROM fleet_project_roles ro WHERE ro.project_id = p.project_id AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(a -> 'roles') y WHERE lower(y ->> 'role') = ro.role)) THEN
    RAISE EXCEPTION 'FLEET_PROJECT_PLAN: a role cannot be dropped from the plan (end its contract; give its tasks to another owner)';
  END IF;
END $$;

CREATE FUNCTION fleet_project_economics_args(a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j jsonb := a -> 'justification';
BEGIN
  IF jsonb_typeof(j) IS DISTINCT FROM 'object' THEN
    PERFORM fleet_econ_bad('justification is {decomposition, parallelism, whyTeam, timeToRevenue, skills?} — your own reasoning, stored with the plan');
  END IF;
  RETURN jsonb_build_object('decomposition', fleet_econ_text(j, 'decomposition', 1200, true), 'parallelism', fleet_econ_text(j, 'parallelism', 1200, true),
    'whyTeam', fleet_econ_text(j, 'whyTeam', 1200, true), 'timeToRevenue', fleet_econ_text(j, 'timeToRevenue', 600, true), 'skills', fleet_econ_text(j, 'skills', 600));
END $$;

CREATE FUNCTION fleet_econ_project_propose(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v fleet_ventures; p fleet_projects; v_idem text := fleet_econ_text(a, 'idempotencyKey', 128, true); v_id uuid := gen_random_uuid(); v_roles integer;
BEGIN
  SELECT * INTO p FROM fleet_projects WHERE lead_agent_id = p_agent AND idempotency_key = v_idem;
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'replayed', true, 'project', fleet_project_json(p)); END IF;
  SELECT * INTO v FROM fleet_ventures WHERE agent_id = p_agent AND venture_key = fleet_econ_key(a, 'ventureKey');
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND', 'reason', 'a project serves one of your own ventures'); END IF;
  IF lower(COALESCE(a ->> 'risk', '')) NOT IN ('low','medium','high') THEN PERFORM fleet_econ_bad('risk is low, medium or high'); END IF;
  IF v.state IN ('failed','closed') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE', 'reason', 'the venture is ' || v.state); END IF;
  INSERT INTO fleet_projects (project_id, lead_agent_id, venture_id, project_key, name, objective, idempotency_key, expected_value_minor, expected_return_minor, budget_minor,
      opportunity_cost_minor, time_value_minor_per_day, quality_benefit_minor, coordination_hours, coordination_cost_minor, risk, risk_note, justification, target_completion,
      solo_hours, team_hours, makespan_hours, planned_time_saved_hours, critical_path, benefit_minor, cost_minor)
    VALUES (v_id, p_agent, v.venture_id, fleet_econ_key(a, 'key'), fleet_econ_text(a, 'name', 80, true), fleet_econ_text(a, 'objective', 600, true), v_idem,
      fleet_econ_int(a, 'expectedValueMinor', 0, 100000000000, true), fleet_econ_int(a, 'expectedReturnMinor', -100000000000, 100000000000, true),
      fleet_econ_int(a, 'budgetMinor', 0, 100000000000, true), fleet_econ_int(a, 'opportunityCostMinor', 0, 100000000000, true),
      fleet_econ_int(a, 'timeValueMinorPerDay', 0, 100000000000, true), COALESCE(fleet_econ_int(a, 'qualityBenefitMinor', 0, 100000000000), 0),
      fleet_project_hours(a -> 'coordinationHours', 'coordinationHours', 100000), fleet_econ_int(a, 'coordinationCostMinor', 0, 100000000000, true),
      lower(COALESCE(fleet_econ_text(a, 'risk', 10, true), '')), fleet_econ_text(a, 'riskNote', 300), fleet_project_economics_args(a),
      CASE WHEN a ? 'targetCompletion' THEN (a ->> 'targetCompletion')::timestamptz END, 0, 0, 0, 0, '{}', 0, 0)
    RETURNING * INTO p;
  PERFORM fleet_project_set_plan(p, a);
  p := fleet_project_evaluate(v_id);
  SELECT count(*) INTO v_roles FROM fleet_project_roles WHERE project_id = v_id;
  IF v_roles = 0 THEN RAISE EXCEPTION 'FLEET_PROJECT_NOT_JUSTIFIED: a team project recruits at least one role (work alone needs no project)'; END IF;
  IF p.benefit_minor <= p.cost_minor THEN
    RAISE EXCEPTION 'FLEET_PROJECT_NOT_JUSTIFIED: expected benefit % does not exceed collaboration cost plus coordination % (team %h vs solo %h): do it alone, re-plan the decomposition or change the terms',
      p.benefit_minor, p.cost_minor, p.team_hours, p.solo_hours;
  END IF;
  UPDATE fleet_projects SET stage = 'recruiting' WHERE project_id = v_id RETURNING * INTO p;
  PERFORM fleet_project_event(p, 'project_created', p_agent, p_agent, jsonb_build_object('soloHours', p.solo_hours, 'teamHours', p.team_hours,
    'timeSavedHours', p.planned_time_saved_hours, 'benefitMinor', p.benefit_minor, 'costMinor', p.cost_minor, 'roles', v_roles));
  RETURN jsonb_build_object('ok', true, 'project', fleet_project_json(p),
    'note', 'Planner figures are FleetController''s. Fund the escrow (project.fund) and offer roles (project.offer) to existing living agents; each decides for itself.');
END $$;

CREATE FUNCTION fleet_econ_project_replan(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_projects := fleet_project_for_lead(p_agent, a); v_reason text := fleet_econ_text(a, 'reason', 300, true);
BEGIN
  PERFORM fleet_project_live(p);
  UPDATE fleet_projects SET plan_version = plan_version + 1, objective = COALESCE(fleet_econ_text(a, 'objective', 600), objective),
         coordination_hours = CASE WHEN a ? 'coordinationHours' THEN fleet_project_hours(a -> 'coordinationHours', 'coordinationHours', 100000) ELSE coordination_hours END,
         coordination_cost_minor = COALESCE(fleet_econ_int(a, 'coordinationCostMinor', 0, 100000000000), coordination_cost_minor),
         expected_value_minor = COALESCE(fleet_econ_int(a, 'expectedValueMinor', 0, 100000000000), expected_value_minor),
         expected_return_minor = COALESCE(fleet_econ_int(a, 'expectedReturnMinor', -100000000000, 100000000000), expected_return_minor),
         time_value_minor_per_day = COALESCE(fleet_econ_int(a, 'timeValueMinorPerDay', 0, 100000000000), time_value_minor_per_day),
         stage = COALESCE(fleet_project_stage(a), stage)
   WHERE project_id = p.project_id RETURNING * INTO p;
  IF a ? 'tasks' OR a ? 'roles' THEN
    IF NOT (a ? 'tasks' AND a ? 'roles') THEN PERFORM fleet_econ_bad('a re-plan gives the whole plan: tasks and roles'); END IF;
    PERFORM fleet_project_set_plan(p, a);
  END IF;
  p := fleet_project_evaluate(p.project_id);
  PERFORM fleet_project_event(p, 'project_replanned', p_agent, p_agent, jsonb_build_object('reason', v_reason, 'planVersion', p.plan_version,
    'teamHours', p.team_hours, 'soloHours', p.solo_hours, 'benefitMinor', p.benefit_minor, 'costMinor', p.cost_minor, 'stage', p.stage));
  RETURN jsonb_build_object('ok', true, 'project', fleet_project_json(p), 'justified', p.benefit_minor > p.cost_minor);
END $$;

-- Fund the escrow: own spendable capital (custody availability only), or a Fleet-capital envelope approved for THIS project.
CREATE FUNCTION fleet_econ_project_fund(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_projects := fleet_project_for_lead(p_agent, a); v_amount bigint := fleet_econ_int(a, 'amountMinor', 1, 100000000000, true);
        v_src text := lower(COALESCE(fleet_econ_text(a, 'source', 20, true), '')); v_avail bigint; e fleet_envelopes; pos jsonb; rq fleet_capital_requests;
        v_key text := 'prjesc:' || md5(p.project_id::text || ':' || COALESCE(fleet_econ_text(a, 'idempotencyKey', 128), gen_random_uuid()::text));
BEGIN
  -- A retried call with the same idempotency key funds once.
  IF EXISTS (SELECT 1 FROM fleet_ledger_journal WHERE idempotency_key = v_key) THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'project', fleet_project_json(p, false));
  END IF;
  PERFORM fleet_project_live(p);
  PERFORM fleet_ledger_open_agent(p_agent, 'controller');
  IF v_src = 'own' THEN
    -- Custody availability only: spendable own cash (tax reserve, envelope capital, protected principal and obligations are not spendable).
    v_avail := (fleet_agent_economics(p_agent) ->> 'expensePurchasingCapacity')::bigint;
    IF v_amount > v_avail THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PROJECT_INSUFFICIENT_FUNDS', 'reason', format('your spendable own capital is %s; restricted balances (tax reserve, envelope capital, protected principal, obligations) cannot fund a project', v_avail),
        'availableMinor', v_avail);
    END IF;
    PERFORM fleet_project_post('project_escrow', v_key, p_agent, 'project escrow (own capital): ' || p.name, p_agent,
      jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_project_escrow'), 'side', 'D', 'amount', v_amount),
                        jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'C', 'amount', v_amount)));
    UPDATE fleet_projects SET escrow_own_minor = escrow_own_minor + v_amount WHERE project_id = p.project_id RETURNING * INTO p;
  ELSIF v_src = 'fleet_capital' THEN
    SELECT * INTO e FROM fleet_envelopes WHERE envelope_id = fleet_project_uuid(a, 'envelopeId') AND agent_id = p_agent FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND', 'reason', 'envelopeId is one of your envelopes'); END IF;
    SELECT * INTO rq FROM fleet_capital_requests WHERE request_id = e.request_id;
    IF rq.project_id IS DISTINCT FROM p.project_id THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PROJECT_CAPITAL_SCOPE', 'reason', 'Fleet capital funds a project only through a capital request made for that project (fleet_capital request with projectId)');
    END IF;
    IF e.status <> 'active' OR e.expires_at <= now() THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE', 'reason', 'the envelope is ' || e.status); END IF;
    IF NOT ('expense' = ANY (e.categories)) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PROJECT_CAPITAL_SCOPE', 'reason', 'the envelope does not cover expenses'); END IF;
    IF e.max_single_bp IS NOT NULL AND v_amount > fleet_ceil_bp(e.capital_minor, e.max_single_bp) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PROJECT_CAPITAL_SCOPE', 'reason', 'above the envelope''s single-commitment limit (FleetController''s approval limits apply)');
    END IF;
    IF p.envelope_id IS NOT NULL AND p.envelope_id <> e.envelope_id THEN PERFORM fleet_econ_bad('a project draws on one envelope'); END IF;
    pos := fleet_envelope_position(e);
    IF v_amount > (pos ->> 'availableMinor')::bigint THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PROJECT_INSUFFICIENT_FUNDS', 'reason', 'the envelope has ' || (pos ->> 'availableMinor') || ' available', 'availableMinor', (pos ->> 'availableMinor')::bigint);
    END IF;
    PERFORM fleet_project_post('project_envelope_escrow', v_key, p_agent, 'project escrow (Fleet capital): ' || p.name, p_agent,
      jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_project_escrow'), 'side', 'D', 'amount', v_amount),
                        jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_envelope_cash'), 'side', 'C', 'amount', v_amount)));
    UPDATE fleet_projects SET escrow_fleet_minor = escrow_fleet_minor + v_amount, envelope_id = e.envelope_id WHERE project_id = p.project_id RETURNING * INTO p;
  ELSE
    PERFORM fleet_econ_bad('source is own (your spendable capital) or fleet_capital (an envelope approved for this project)');
  END IF;
  PERFORM fleet_project_event(p, 'project_funded', p_agent, p_agent, jsonb_build_object('source', v_src, 'amountMinor', v_amount,
    'escrowMinor', p.escrow_own_minor + p.escrow_fleet_minor));
  RETURN jsonb_build_object('ok', true, 'project', fleet_project_json(p, false));
END $$;

-- Offer a role to an EXISTING LIVING agent (never a new one): an internal contract proposal.
CREATE FUNCTION fleet_econ_project_offer(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_projects := fleet_project_for_lead(p_agent, a); ro fleet_project_roles; ag fleet_agents; m fleet_project_members; v_terms jsonb; v_target text := fleet_econ_text(a, 'agentId', 64, true);
BEGIN
  PERFORM fleet_project_live(p);
  SELECT * INTO ro FROM fleet_project_roles WHERE project_id = p.project_id AND role = lower(COALESCE(a ->> 'role', ''));
  IF NOT FOUND THEN PERFORM fleet_econ_bad('role is one of the plan''s roles'); END IF;
  SELECT * INTO ag FROM fleet_agents WHERE agent_id = v_target;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND', 'reason', 'agentId is an existing Fleet agent (recruitment never creates one)'); END IF;
  IF v_target = p_agent THEN PERFORM fleet_econ_bad('you lead the project; recruit another agent'); END IF;
  IF ag.status <> 'active' OR ag.operator_hold_at IS NOT NULL OR ag.capability_scope <> 'full' OR ag.dry_run THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PROJECT_AGENT_UNAVAILABLE', 'reason', 'only a living, active, unrestricted agent can be offered work');
  END IF;
  IF EXISTS (SELECT 1 FROM fleet_project_members x WHERE x.project_id = p.project_id AND x.status IN ('offered','countered','accepted') AND (x.role = ro.role OR x.agent_id = v_target)) THEN
    RAISE EXCEPTION 'FLEET_INVALID_STATE: that role (or that agent) already has a live offer or contract in this project';
  END IF;
  v_terms := fleet_project_terms(COALESCE(a -> 'compensation', ro.proposed_terms), p.project_id, ro.role);
  INSERT INTO fleet_project_members (member_id, project_id, role, agent_id, task_scope, required_capability, deliverable, expected_hours, deadline, dependencies, terms, start_at)
    VALUES (gen_random_uuid(), p.project_id, ro.role, v_target, ro.task_scope, ro.required_capability, fleet_econ_text(a, 'deliverable', 300, true),
      fleet_project_hours(a -> 'expectedHours', 'expectedHours', 10000), (fleet_econ_text(a, 'deadline', 40, true))::timestamptz, fleet_econ_text(a, 'dependencies', 300), v_terms,
      CASE WHEN a ? 'startAt' THEN (a ->> 'startAt')::timestamptz END)
    RETURNING * INTO m;
  IF m.deadline <= now() THEN PERFORM fleet_econ_bad('deadline is in the future'); END IF;
  p := fleet_project_evaluate(p.project_id);
  IF p.benefit_minor <= p.cost_minor THEN
    RAISE EXCEPTION 'FLEET_PROJECT_NOT_JUSTIFIED: at these terms the expected benefit % no longer exceeds the cost %', p.benefit_minor, p.cost_minor;
  END IF;
  PERFORM fleet_project_event(p, 'project_member_offered', p_agent, p_agent, jsonb_build_object('fromAgentId', p_agent, 'toAgentId', v_target, 'memberId', m.member_id,
    'role', m.role, 'compensation', v_terms, 'deadline', m.deadline));
  RETURN jsonb_build_object('ok', true, 'memberId', m.member_id, 'offer', fleet_project_member_json(m),
    'note', 'The offer waits for the agent''s own decision: ACCEPT, COUNTER, DECLINE or ACCEPT_WITH_TIMING.');
END $$;

-- The target's own decision. ACCEPT needs the lead's escrow to cover the contract's fixed and milestone pay.
CREATE FUNCTION fleet_econ_project_respond(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE m fleet_project_members; p fleet_projects; v_resp text := upper(COALESCE(a ->> 'response', '')); v_reason text := fleet_econ_text(a, 'reason', 300);
        v_free bigint; v_need bigint; v_counter jsonb; v_start timestamptz;
BEGIN
  SELECT * INTO m FROM fleet_project_members WHERE member_id = fleet_project_uuid(a, 'memberId') FOR UPDATE;
  IF NOT FOUND OR m.agent_id <> p_agent THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND', 'reason', 'no offer of yours with that memberId'); END IF;
  IF m.status <> 'offered' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: the offer is %', m.status; END IF;
  SELECT * INTO p FROM fleet_projects WHERE project_id = m.project_id FOR UPDATE;
  PERFORM fleet_project_live(p);
  IF v_resp NOT IN ('ACCEPT','COUNTER','DECLINE','ACCEPT_WITH_TIMING') THEN PERFORM fleet_econ_bad('response is ACCEPT, COUNTER, DECLINE or ACCEPT_WITH_TIMING'); END IF;
  IF v_resp = 'DECLINE' THEN
    UPDATE fleet_project_members SET status = 'declined', response = v_resp, response_reason = v_reason, responded_at = now(), ended_at = now() WHERE member_id = m.member_id RETURNING * INTO m;
    p := fleet_project_evaluate(p.project_id);
    PERFORM fleet_project_event(p, 'project_member_declined', p_agent, p_agent, jsonb_build_object('fromAgentId', p_agent, 'toAgentId', p.lead_agent_id, 'memberId', m.member_id, 'role', m.role, 'reason', v_reason));
    RETURN jsonb_build_object('ok', true, 'status', 'declined');
  END IF;
  IF v_resp = 'COUNTER' THEN
    IF jsonb_typeof(a -> 'counter') IS DISTINCT FROM 'object' THEN PERFORM fleet_econ_bad('counter is {compensation?, startAt?, deadline?} — what you would accept'); END IF;
    v_counter := jsonb_strip_nulls(jsonb_build_object('compensation', CASE WHEN (a -> 'counter') ? 'compensation' THEN fleet_project_terms(a -> 'counter' -> 'compensation', p.project_id, m.role) END,
      'startAt', CASE WHEN (a -> 'counter') ? 'startAt' THEN ((a -> 'counter') ->> 'startAt')::timestamptz END,
      'deadline', CASE WHEN (a -> 'counter') ? 'deadline' THEN ((a -> 'counter') ->> 'deadline')::timestamptz END));
    IF v_counter = '{}'::jsonb THEN PERFORM fleet_econ_bad('a counter changes compensation, startAt or deadline'); END IF;
    UPDATE fleet_project_members SET status = 'countered', response = v_resp, response_reason = v_reason, counter_terms = v_counter, responded_at = now() WHERE member_id = m.member_id RETURNING * INTO m;
    PERFORM fleet_project_event(p, 'project_member_countered', p_agent, p_agent, jsonb_build_object('fromAgentId', p_agent, 'toAgentId', p.lead_agent_id, 'memberId', m.member_id, 'role', m.role, 'counter', v_counter));
    RETURN jsonb_build_object('ok', true, 'status', 'countered', 'note', 'The lead decides whether to accept your counter.');
  END IF;
  -- ACCEPT / ACCEPT_WITH_TIMING
  IF v_resp = 'ACCEPT_WITH_TIMING' THEN
    v_start := (fleet_econ_text(a, 'startAt', 40, true))::timestamptz;
    IF v_start <= now() THEN PERFORM fleet_econ_bad('startAt is a later time you can start'); END IF;
  END IF;
  v_need := fleet_project_terms_escrow(m.terms);
  v_free := p.escrow_own_minor + p.escrow_fleet_minor - fleet_project_committed(p.project_id);
  IF v_need > v_free THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PROJECT_UNFUNDED', 'reason', format('the lead''s escrow has %s free for the %s this contract pays; the lead must fund it first', v_free, v_need));
  END IF;
  UPDATE fleet_project_members SET status = 'accepted', response = v_resp, response_reason = v_reason, responded_at = now(), accepted_at = now(),
         start_at = COALESCE(v_start, start_at, now()), contribution_status = 'none',
         expected_finish = COALESCE(v_start, start_at, now()) + make_interval(secs => (expected_hours * 3600)::double precision)
   WHERE member_id = m.member_id RETURNING * INTO m;
  p := fleet_project_evaluate(p.project_id);
  PERFORM fleet_project_event(p, 'project_member_joined', p_agent, p_agent, jsonb_build_object('fromAgentId', p_agent, 'toAgentId', p.lead_agent_id, 'memberId', m.member_id,
    'role', m.role, 'response', v_resp, 'startAt', m.start_at, 'compensation', m.terms, 'teamHours', p.team_hours));
  RETURN jsonb_build_object('ok', true, 'status', 'accepted', 'contract', fleet_project_member_json(m), 'project', fleet_project_json(p, false));
END $$;

CREATE FUNCTION fleet_econ_project_counter_accept(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_projects := fleet_project_for_lead(p_agent, a); m fleet_project_members; v_free bigint; v_need bigint; v_terms jsonb;
BEGIN
  PERFORM fleet_project_live(p);
  SELECT * INTO m FROM fleet_project_members WHERE member_id = fleet_project_uuid(a, 'memberId') AND project_id = p.project_id FOR UPDATE;
  IF NOT FOUND OR m.status <> 'countered' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: no counter-offer to accept'; END IF;
  v_terms := COALESCE(m.counter_terms -> 'compensation', m.terms);
  v_need := fleet_project_terms_escrow(v_terms);
  v_free := p.escrow_own_minor + p.escrow_fleet_minor - fleet_project_committed(p.project_id);
  IF v_need > v_free THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PROJECT_UNFUNDED', 'reason', format('fund the escrow first: %s free, %s needed', v_free, v_need)); END IF;
  UPDATE fleet_project_members SET terms = v_terms, status = 'accepted', accepted_at = now(), start_at = COALESCE((m.counter_terms ->> 'startAt')::timestamptz, now()),
         deadline = COALESCE((m.counter_terms ->> 'deadline')::timestamptz, deadline),
         expected_finish = COALESCE((m.counter_terms ->> 'startAt')::timestamptz, now()) + make_interval(secs => (expected_hours * 3600)::double precision)
   WHERE member_id = m.member_id RETURNING * INTO m;
  p := fleet_project_evaluate(p.project_id);
  IF p.benefit_minor <= p.cost_minor THEN
    RAISE EXCEPTION 'FLEET_PROJECT_NOT_JUSTIFIED: at the countered terms the expected benefit % does not exceed the cost %', p.benefit_minor, p.cost_minor;
  END IF;
  PERFORM fleet_project_event(p, 'project_member_joined', m.agent_id, p_agent, jsonb_build_object('fromAgentId', m.agent_id, 'toAgentId', p_agent, 'memberId', m.member_id,
    'role', m.role, 'response', 'COUNTER_ACCEPTED', 'compensation', m.terms, 'teamHours', p.team_hours));
  RETURN jsonb_build_object('ok', true, 'contract', fleet_project_member_json(m), 'project', fleet_project_json(p, false));
END $$;

CREATE FUNCTION fleet_econ_project_withdraw_offer(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_projects := fleet_project_for_lead(p_agent, a); m fleet_project_members;
BEGIN
  UPDATE fleet_project_members SET status = 'withdrawn', ended_at = now(), exit_reason = fleet_econ_text(a, 'reason', 300)
   WHERE member_id = fleet_project_uuid(a, 'memberId') AND project_id = p.project_id AND status IN ('offered','countered') RETURNING * INTO m;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: no open offer with that memberId'; END IF;
  p := fleet_project_evaluate(p.project_id);
  PERFORM fleet_project_event(p, 'project_offer_withdrawn', p_agent, p_agent, jsonb_build_object('fromAgentId', p_agent, 'toAgentId', m.agent_id, 'memberId', m.member_id, 'role', m.role));
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE FUNCTION fleet_econ_project_start(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_projects := fleet_project_for_lead(p_agent, a);
BEGIN
  IF p.status <> 'planning' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: the project is %', p.status; END IF;
  UPDATE fleet_projects SET status = 'active', started_at = now(), stage = COALESCE(fleet_project_stage(a), 'building')
   WHERE project_id = p.project_id RETURNING * INTO p;
  PERFORM fleet_project_event(p, 'project_started', p_agent, p_agent, jsonb_build_object('teamHours', p.team_hours, 'soloHours', p.solo_hours,
    'members', (SELECT COALESCE(jsonb_agg(m.agent_id), '[]'::jsonb) FROM fleet_project_members m WHERE m.project_id = p.project_id AND m.status = 'accepted')));
  RETURN jsonb_build_object('ok', true, 'project', fleet_project_json(p, false));
END $$;

-- Task work by its owner (the lead for "lead" tasks, the role's accepted member otherwise): start, progress, deliver.
CREATE FUNCTION fleet_econ_project_task(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_projects; t fleet_project_tasks; m fleet_project_members; v_action text := lower(COALESCE(a ->> 'action', '')); v_ev jsonb;
BEGIN
  SELECT * INTO p FROM fleet_projects WHERE project_id = fleet_project_uuid(a, 'projectId') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such project'; END IF;
  IF p.status <> 'active' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: the project is % (the lead starts it)', p.status; END IF;
  SELECT * INTO t FROM fleet_project_tasks WHERE project_id = p.project_id AND task_key = a ->> 'taskKey' FOR UPDATE;
  IF NOT FOUND OR t.status = 'cancelled' THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such task in the plan'; END IF;
  IF t.owner_role = 'lead' THEN
    IF p_agent <> p.lead_agent_id THEN RAISE EXCEPTION 'FLEET_PROJECT_NOT_OWNER: this task belongs to the lead'; END IF;
  ELSE
    SELECT * INTO m FROM fleet_project_members WHERE project_id = p.project_id AND role = t.owner_role AND status = 'accepted';
    IF NOT FOUND OR m.agent_id <> p_agent THEN RAISE EXCEPTION 'FLEET_PROJECT_NOT_OWNER: this task belongs to the % role''s contracted agent', t.owner_role; END IF;
  END IF;
  IF v_action = 'start' THEN
    IF t.status NOT IN ('pending','rejected') THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: the task is %', t.status; END IF;
    IF EXISTS (SELECT 1 FROM fleet_project_tasks d WHERE d.project_id = p.project_id AND d.task_key = ANY (t.deps) AND d.status NOT IN ('delivered','accepted')) THEN
      RAISE EXCEPTION 'FLEET_PROJECT_BLOCKED: a dependency is not delivered yet';
    END IF;
    UPDATE fleet_project_tasks SET status = 'in_progress', assignee_agent_id = p_agent, started_at = COALESCE(started_at, now()), progress_bp = 0
     WHERE project_id = t.project_id AND task_key = t.task_key RETURNING * INTO t;
    IF m.member_id IS NOT NULL THEN UPDATE fleet_project_members SET contribution_status = 'in_progress' WHERE member_id = m.member_id; END IF;
    PERFORM fleet_project_event(p, 'project_task_started', p_agent, p_agent, jsonb_build_object('taskKey', t.task_key, 'role', t.owner_role));
  ELSIF v_action = 'progress' THEN
    IF t.status <> 'in_progress' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: the task is %', t.status; END IF;
    UPDATE fleet_project_tasks SET progress_bp = fleet_econ_int(a, 'progressBp', 0, 9999, true)::integer WHERE project_id = t.project_id AND task_key = t.task_key RETURNING * INTO t;
  ELSIF v_action = 'deliver' THEN
    IF t.status <> 'in_progress' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: the task is % (start it first)', t.status; END IF;
    v_ev := COALESCE(fleet_econ_evidence(a, 'evidence', 12), '[]'::jsonb);
    UPDATE fleet_project_tasks SET status = 'delivered', delivered_at = now(), progress_bp = 10000, evidence = v_ev
     WHERE project_id = t.project_id AND task_key = t.task_key RETURNING * INTO t;
    IF m.member_id IS NOT NULL THEN UPDATE fleet_project_members SET contribution_status = 'delivered' WHERE member_id = m.member_id; END IF;
    PERFORM fleet_project_event(p, 'project_task_delivered', p_agent, p_agent, jsonb_build_object('fromAgentId', p_agent, 'toAgentId', p.lead_agent_id,
      'taskKey', t.task_key, 'role', t.owner_role, 'deliverable', t.deliverable));
  ELSE
    PERFORM fleet_econ_bad('action is start, progress or deliver');
  END IF;
  RETURN jsonb_build_object('ok', true, 'task', t.task_key, 'status', t.status, 'projection', fleet_project_projection(p));
END $$;

-- The lead reviews a delivery. Acceptance pays any milestone on it, and the fixed amount once the role's work is all accepted.
CREATE FUNCTION fleet_econ_project_review(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_projects := fleet_project_for_lead(p_agent, a); t fleet_project_tasks; m fleet_project_members; v_verdict text := lower(COALESCE(a ->> 'verdict', ''));
        v_reason text := fleet_econ_text(a, 'reason', 300, true); v_paid bigint := 0;
BEGIN
  PERFORM fleet_project_live(p);
  SELECT * INTO t FROM fleet_project_tasks WHERE project_id = p.project_id AND task_key = a ->> 'taskKey' FOR UPDATE;
  IF NOT FOUND OR t.status <> 'delivered' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: only a delivered task is reviewed'; END IF;
  IF v_verdict = 'accept' THEN
    UPDATE fleet_project_tasks SET status = 'accepted', accepted_at = now(), review_note = v_reason WHERE project_id = t.project_id AND task_key = t.task_key RETURNING * INTO t;
    SELECT * INTO m FROM fleet_project_members WHERE project_id = p.project_id AND role = t.owner_role AND agent_id = t.assignee_agent_id
      AND status IN ('accepted','exited','removed') ORDER BY offered_at DESC LIMIT 1;
    IF m.member_id IS NOT NULL THEN
      v_paid := fleet_project_settle_member(m.member_id, false, p_agent, 'accepted: ' || t.task_key);
      UPDATE fleet_project_members SET contribution_status = CASE WHEN NOT EXISTS (SELECT 1 FROM fleet_project_tasks x WHERE x.project_id = p.project_id AND x.owner_role = m.role
               AND x.status NOT IN ('accepted','cancelled')) THEN 'accepted' ELSE 'partial' END,
             actual_finish = CASE WHEN NOT EXISTS (SELECT 1 FROM fleet_project_tasks x WHERE x.project_id = p.project_id AND x.owner_role = m.role AND x.status NOT IN ('accepted','cancelled')) THEN now() END
       WHERE member_id = m.member_id;
    END IF;
    PERFORM fleet_project_event(p, 'project_task_accepted', p_agent, p_agent, jsonb_build_object('fromAgentId', p_agent, 'toAgentId', t.assignee_agent_id,
      'taskKey', t.task_key, 'role', t.owner_role, 'paidMinor', v_paid));
  ELSIF v_verdict = 'reject' THEN
    UPDATE fleet_project_tasks SET status = 'rejected', review_note = v_reason, rejections = rejections + 1, progress_bp = 0, delivered_at = NULL
     WHERE project_id = t.project_id AND task_key = t.task_key RETURNING * INTO t;
    UPDATE fleet_project_members SET contribution_status = 'rejected' WHERE project_id = p.project_id AND role = t.owner_role AND status = 'accepted';
    PERFORM fleet_project_event(p, 'project_task_rejected', p_agent, p_agent, jsonb_build_object('fromAgentId', p_agent, 'toAgentId', t.assignee_agent_id,
      'taskKey', t.task_key, 'role', t.owner_role, 'reason', v_reason));
  ELSE
    PERFORM fleet_econ_bad('verdict is accept or reject');
  END IF;
  RETURN jsonb_build_object('ok', true, 'task', t.task_key, 'status', t.status, 'paidMinor', v_paid);
END $$;

-- Revenue share owed: share of the venture's ledger net profit since the contract started (to its end date, capped),
-- less what was paid, out of the lead's spendable cash (what cannot be paid now stays owed).
CREATE FUNCTION fleet_econ_project_settle_share(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE m fleet_project_members; p fleet_projects; v_net bigint; v_owed bigint; v_due bigint; v_pay bigint; v_avail bigint; v_until timestamptz;
BEGIN
  SELECT * INTO m FROM fleet_project_members WHERE member_id = fleet_project_uuid(a, 'memberId') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such contract'; END IF;
  SELECT * INTO p FROM fleet_projects WHERE project_id = m.project_id FOR UPDATE;
  IF p_agent NOT IN (m.agent_id, p.lead_agent_id) THEN RAISE EXCEPTION 'FLEET_PROJECT_NOT_PARTY: only the two parties settle a revenue share'; END IF;
  IF NOT (m.terms ? 'revenueShareBp') OR m.accepted_at IS NULL THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: no agreed revenue share in this contract'; END IF;
  v_until := (m.terms ->> 'revenueShareUntil')::timestamptz;
  v_net := GREATEST(0, (fleet_venture_financials(p.venture_id, GREATEST(m.start_at, m.accepted_at)) ->> 'netProfitMinor')::bigint
                     - CASE WHEN now() > v_until THEN (fleet_venture_financials(p.venture_id, v_until) ->> 'netProfitMinor')::bigint ELSE 0 END);
  v_owed := floor(v_net::numeric * (m.terms ->> 'revenueShareBp')::integer / 10000)::bigint;
  IF m.terms ? 'revenueShareCapMinor' THEN v_owed := LEAST(v_owed, (m.terms ->> 'revenueShareCapMinor')::bigint); END IF;
  v_due := GREATEST(0, v_owed - m.share_paid_minor);
  v_avail := GREATEST(0, (fleet_agent_economics(p.lead_agent_id) ->> 'expensePurchasingCapacity')::bigint);
  v_pay := LEAST(v_due, v_avail);
  IF v_pay > 0 THEN PERFORM fleet_project_pay(p.project_id, m.member_id, 'revenue_share', NULL, v_pay, p_agent, format('revenue share %s bp of venture net profit %s', m.terms ->> 'revenueShareBp', v_net)); END IF;
  RETURN jsonb_build_object('ok', true, 'ventureNetProfitMinor', v_net, 'owedMinor', v_owed, 'paidNowMinor', v_pay, 'stillOwedMinor', v_due - v_pay,
    'note', 'Computed from the venture''s ledger net profit (external) since the contract started; internal payments are never part of it.');
END $$;

-- Ending a contract early: the member exits (voluntary; accepted work stays paid, delivered work is still reviewed and paid
-- on acceptance), or the lead removes / replaces it (delivered work counts as earned).
CREATE FUNCTION fleet_project_end_member(m fleet_project_members, p_status text, p_delivered boolean, p_actor text, p_reason text) RETURNS bigint LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_projects; v_paid bigint := 0;
BEGIN
  SELECT * INTO p FROM fleet_projects WHERE project_id = m.project_id FOR UPDATE;
  IF m.status = 'accepted' AND p.status IN ('planning','active') THEN v_paid := fleet_project_settle_member(m.member_id, p_delivered, p_actor, p_status || ': ' || p_reason); END IF;
  UPDATE fleet_project_members SET status = CASE WHEN m.status IN ('offered','countered') THEN 'withdrawn' ELSE p_status END, ended_at = now(),
         actual_finish = COALESCE(actual_finish, now()), exit_reason = left(p_reason, 300) WHERE member_id = m.member_id;
  UPDATE fleet_project_tasks SET status = 'pending', progress_bp = 0, assignee_agent_id = NULL, started_at = NULL
   WHERE project_id = m.project_id AND owner_role = m.role AND status = 'in_progress' AND assignee_agent_id = m.agent_id;
  IF p.status IN ('planning','active') THEN PERFORM fleet_project_evaluate(p.project_id); END IF;
  PERFORM fleet_project_event(p, CASE WHEN p_status = 'removed' THEN 'project_member_removed' ELSE 'project_member_exited' END, m.agent_id, p_actor,
    jsonb_build_object('fromAgentId', m.agent_id, 'toAgentId', p.lead_agent_id, 'memberId', m.member_id, 'role', m.role, 'reason', p_reason, 'paidOnExitMinor', v_paid));
  RETURN v_paid;
END $$;

CREATE FUNCTION fleet_econ_project_exit(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE m fleet_project_members; v_paid bigint;
BEGIN
  SELECT * INTO m FROM fleet_project_members WHERE project_id = fleet_project_uuid(a, 'projectId') AND agent_id = p_agent AND status IN ('accepted','offered','countered') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: you hold no live contract in that project'; END IF;
  v_paid := fleet_project_end_member(m, 'exited', false, p_agent, COALESCE(fleet_econ_text(a, 'reason', 300), 'member exit'));
  RETURN jsonb_build_object('ok', true, 'paidMinor', v_paid, 'note', 'You are out of the project. Delivered work is still reviewed and paid on acceptance.');
END $$;

CREATE FUNCTION fleet_econ_project_replace(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_projects := fleet_project_for_lead(p_agent, a); m fleet_project_members; v_paid bigint;
BEGIN
  PERFORM fleet_project_live(p);
  SELECT * INTO m FROM fleet_project_members WHERE member_id = fleet_project_uuid(a, 'memberId') AND project_id = p.project_id AND status = 'accepted' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no live contract with that memberId'; END IF;
  v_paid := fleet_project_end_member(m, 'removed', true, p_agent, fleet_econ_text(a, 'reason', 300, true));
  RETURN jsonb_build_object('ok', true, 'paidMinor', v_paid, 'note', 'The role is open again: offer it to another agent.');
END $$;

CREATE FUNCTION fleet_econ_project_cancel(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_projects := fleet_project_for_lead(p_agent, a); r jsonb;
BEGIN
  PERFORM fleet_project_live(p);
  r := fleet_project_finish(p.project_id, 'cancelled', p_agent, fleet_econ_text(a, 'reason', 300, true), fleet_econ_int(a, 'actualReturnMinor', -100000000000, 100000000000), fleet_econ_text(a, 'lessons', 600));
  RETURN jsonb_build_object('ok', true) || r;
END $$;

CREATE FUNCTION fleet_econ_project_complete(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_projects := fleet_project_for_lead(p_agent, a); r jsonb;
BEGIN
  IF p.status <> 'active' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: the project is %', p.status; END IF;
  IF EXISTS (SELECT 1 FROM fleet_project_tasks WHERE project_id = p.project_id AND status NOT IN ('accepted','cancelled')) THEN
    RAISE EXCEPTION 'FLEET_INVALID_STATE: every task is accepted (or removed from the plan) before completion';
  END IF;
  r := fleet_project_finish(p.project_id, 'completed', p_agent, 'completed', fleet_econ_int(a, 'actualReturnMinor', -100000000000, 100000000000), fleet_econ_text(a, 'lessons', 600, true));
  SELECT * INTO p FROM fleet_projects WHERE project_id = p.project_id;
  RETURN jsonb_build_object('ok', true, 'project', fleet_project_json(p)) || r;
END $$;

CREATE FUNCTION fleet_econ_project_list(p_agent text, a jsonb) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'projects', COALESCE(jsonb_agg(fleet_project_json(p, false) ORDER BY p.updated_at DESC), '[]'::jsonb))
    FROM fleet_projects p
   WHERE (p.lead_agent_id = p_agent OR EXISTS (SELECT 1 FROM fleet_project_members m WHERE m.project_id = p.project_id AND m.agent_id = p_agent))
     AND (a ->> 'status' IS NULL OR p.status = a ->> 'status')
$$;

CREATE FUNCTION fleet_econ_project_status(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_projects;
BEGIN
  SELECT * INTO p FROM fleet_projects WHERE project_id = fleet_project_uuid(a, 'projectId');
  IF NOT FOUND OR NOT (p.lead_agent_id = p_agent OR EXISTS (SELECT 1 FROM fleet_project_members m WHERE m.project_id = p.project_id AND m.agent_id = p_agent)) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND', 'reason', 'not a project you lead or were offered work in');
  END IF;
  RETURN jsonb_build_object('ok', true, 'project', fleet_project_json(p, p.lead_agent_id = p_agent));
END $$;

CREATE FUNCTION fleet_econ_project_offers(p_agent text, a jsonb) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'offers', COALESCE(jsonb_agg(fleet_project_member_json(m) || jsonb_build_object('projectId', p.project_id, 'project', p.name,
           'objective', p.objective, 'leadAgentId', p.lead_agent_id, 'escrowFreeMinor', p.escrow_own_minor + p.escrow_fleet_minor - fleet_project_committed(p.project_id),
           'teamHours', p.team_hours, 'tasks', (SELECT COALESCE(jsonb_agg(jsonb_build_object('key', t.task_key, 'title', t.title, 'hours', t.hours, 'deps', to_jsonb(t.deps)) ORDER BY t.ord), '[]'::jsonb)
                                                FROM fleet_project_tasks t WHERE t.project_id = p.project_id AND t.owner_role = m.role AND t.status <> 'cancelled'))
           ORDER BY m.offered_at), '[]'::jsonb),
    'note', 'Decide on your own economics: your projects, commitments, capacity, the pay and its strategic value. ACCEPT, COUNTER, DECLINE or ACCEPT_WITH_TIMING.')
    FROM fleet_project_members m JOIN fleet_projects p ON p.project_id = m.project_id
   WHERE m.agent_id = p_agent AND m.status = 'offered' AND p.status IN ('planning','active')
$$;

-- Teammate search: work history per capability, raw (no score), living recruitable agents only.
CREATE FUNCTION fleet_econ_project_talent(p_agent text, a jsonb) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'agents', COALESCE(jsonb_agg(x ORDER BY x ->> 'agentId'), '[]'::jsonb),
    'note', 'Raw delivery history from completed project work (no score is assigned at birth and none is ranked). Agents with no history are still recruitable.')
    FROM (SELECT jsonb_build_object('agentId', g.agent_id, 'name', g.name,
            'activeContracts', (SELECT count(*) FROM fleet_project_members m WHERE m.agent_id = g.agent_id AND m.status = 'accepted'),
            'history', COALESCE((SELECT jsonb_agg(jsonb_build_object('capability', c.capability, 'tasksAccepted', c.tasks_accepted, 'rejections', c.rejections,
                'deliveredOnTime', c.delivered_on_time, 'deliveredLate', c.delivered_late, 'estimatedHours', c.estimated_hours, 'actualHours', c.actual_hours,
                'projects', c.projects, 'projectsCompleted', c.projects_completed) ORDER BY c.capability)
              FROM fleet_agent_competency c WHERE c.agent_id = g.agent_id AND (a ->> 'capability' IS NULL OR c.capability = lower(a ->> 'capability'))), '[]'::jsonb)) AS x
            FROM fleet_agents g WHERE g.status = 'active' AND g.operator_hold_at IS NULL AND g.capability_scope = 'full' AND NOT g.dry_run AND g.agent_id <> p_agent) s
$$;

-- ═══ 7. Lifecycle: death / quarantine removes project authority at once ═══
CREATE FUNCTION fleet_agents_projects_on_exit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_projects; m fleet_project_members; v_why text;
BEGIN
  IF NEW.status IN ('dead','failed','terminating','orphaned') AND OLD.status NOT IN ('dead','failed','terminating','orphaned') THEN
    v_why := CASE WHEN NEW.status IN ('dead','failed') THEN 'agent died' ELSE 'agent quarantined' END;
    BEGIN
      -- A project never survives without a living lead: cancelled, every contract settled (delivered work is paid), escrow returned.
      FOR p IN SELECT * FROM fleet_projects WHERE lead_agent_id = NEW.agent_id AND status IN ('planning','active') LOOP
        PERFORM fleet_project_finish(p.project_id, 'cancelled', 'lifecycle', 'lead unavailable: ' || v_why, NULL, NULL);
      END LOOP;
      -- A member's contracts end (settled; delivered work counts); its offers lapse.
      FOR m IN SELECT * FROM fleet_project_members WHERE agent_id = NEW.agent_id AND status IN ('accepted','offered','countered') LOOP
        PERFORM fleet_project_end_member(m, 'exited', true, 'lifecycle', 'member unavailable: ' || v_why);
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      PERFORM fleet_event('project_lifecycle_failed', NEW.agent_id, 'lifecycle', jsonb_build_object('error', left(SQLERRM, 200)));
    END;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER fleet_agents_projects_on_exit AFTER UPDATE OF status ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_projects_on_exit();

-- ═══ 8. Dashboard read (read-only): projects with lead, members, roles, compensation, planner ETAs, economics, events ═══
CREATE FUNCTION fleet_admin_projects(a jsonb) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  WITH sel AS (
    SELECT p.* FROM fleet_projects p
     WHERE (a ->> 'status' IS NULL OR p.status = a ->> 'status')
       AND (a ->> 'agentId' IS NULL OR p.lead_agent_id = a ->> 'agentId' OR EXISTS (SELECT 1 FROM fleet_project_members m WHERE m.project_id = p.project_id AND m.agent_id = a ->> 'agentId'))
       AND (a ->> 'ventureKey' IS NULL OR p.venture_id IN (SELECT venture_id FROM fleet_ventures WHERE venture_key = a ->> 'ventureKey'))
     ORDER BY (p.status IN ('planning','active')) DESC, p.updated_at DESC
     LIMIT LEAST(COALESCE((a ->> 'limit')::integer, 100), 500))
  SELECT jsonb_build_object(
    'summary', jsonb_build_object(
        'active', (SELECT count(*) FROM fleet_projects WHERE status = 'active'),
        'planning', (SELECT count(*) FROM fleet_projects WHERE status = 'planning'),
        'completed', (SELECT count(*) FROM fleet_projects WHERE status = 'completed'),
        'cancelled', (SELECT count(*) FROM fleet_projects WHERE status = 'cancelled'),
        'agentsCollaborating', (SELECT count(DISTINCT x) FROM (SELECT lead_agent_id AS x FROM fleet_projects WHERE status IN ('planning','active')
                                 UNION SELECT m.agent_id FROM fleet_project_members m JOIN fleet_projects p ON p.project_id = m.project_id WHERE m.status = 'accepted' AND p.status IN ('planning','active')) u),
        'plannedTimeSavedHours', (SELECT COALESCE(sum(planned_time_saved_hours), 0) FROM fleet_projects WHERE status IN ('planning','active')),
        'escrowMinor', (SELECT COALESCE(sum(escrow_own_minor + escrow_fleet_minor), 0) FROM fleet_projects WHERE status IN ('planning','active')),
        'internalPaymentsMinor', (SELECT COALESCE(sum(amount_minor), 0) FROM fleet_project_payments),
        'note', 'Internal payments move value between agents; they are never Fleet revenue.'),
    'projects', COALESCE((SELECT jsonb_agg(fleet_project_json(s)) FROM sel s), '[]'::jsonb))
$$;

${DISPATCH}

${DASH_CALL}

${ENVELOPE_POSITION}

${CAPITAL_REQUEST}
`;
