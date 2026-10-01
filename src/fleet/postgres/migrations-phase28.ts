/**
 * Schema v28 — F2 economy records: opportunities, decisions, ventures and economic knowledge (agent-owned).
 *
 * The agent is the entrepreneur. Everything in this migration is the AGENT's own record of its economic work; nothing
 * here approves, ranks, scores or selects anything on the agent's behalf, and nothing routes to the owner.
 *
 * 1. Policy (`fleet_economy_policy`, one row): shortlist size, evidence freshness, knowledge freshness and the
 *    forecast tolerance used for calibration REPORTING. Plus infrastructure failsafes (open opportunities, active
 *    ventures, records per day) that exist only against runaway loops; no agent-facing output names them.
 * 2. Opportunities (`fleet_opportunities`): a candidate with its structured evidence and economics. The AGENT ranks
 *    its own shortlist (`agent_rank`, at most `shortlist_max` shortlisted); FleetController computes no score and holds
 *    no weights. Candidates whose newest evidence is older than the freshness window become `stale` (lazily, when the
 *    agent next reads or ranks).
 * 3. Decision records (`fleet_decision_records`): the registry copy of the founder's decision ledger — selected
 *    option, alternatives, evidence, forecast (revenue, cost, margin, ROI, time to revenue, confidence, capital
 *    exposed), downside, invalidation evidence and next action. The forecast is immutable once recorded; the outcome
 *    is recorded once. When a decision names a venture, the measured outcome comes from the LEDGER (attributed
 *    journals), never from the agent's claim. A correction is a new revision that names what changed.
 * 4. Ventures (`fleet_ventures`): a first-class business with an explicit state machine
 *      discovered → researching → validating → selected → building → launching → operating → scaling,
 *      plus pivoting / paused / failed → closed.
 *    No transition needs the owner. FleetController enforces facts only: scaling needs ledger-backed positive net
 *    profit; operating needs a declared channel. History is append-only (`fleet_venture_transitions`).
 * 5. Venture attribution (`fleet_venture_journals`): a ledger journal of the venture's own agent attributed to the
 *    venture, with a cost category. Venture financials (revenue, refunds, fees, costs by category, tax reserved,
 *    net profit, capital deployed, ROI) are derived from attributed postings only — never stored, never drifted.
 * 6. Economic knowledge (`fleet_economic_knowledge`): structured learning (niches, products, channels, pricing,
 *    conversion, vendors, demand, failed/succeeded assumptions, launch results, costs) with freshness. An agent sees
 *    its own entries; entries backed by a ledger-measured outcome are shared fleet-wide (the flywheel).
 * 7. One agent entry point, `api_economy(agent, token, op, args)`, authenticated and capability-checked per op
 *    (planning / ledger.read / knowledge.read, so existing manifests — Founder 1's founder-v2 — need no change).
 *    Validation errors come back as {ok:false, code, reason}; anything else raises (fail closed).
 * 8. Performance (`fleet_agent_performance`): the agent's own record — forecast accuracy, measured and corrected
 *    decisions, ventures by outcome, realized ROI, capital efficiency, conversion. It is INPUT to the agent's own
 *    judgement and is never read by any FleetController decision about the agent's own capital.
 */

export const V28_SQL = `
-- ═══ 1. Economy policy (configuration; failsafes are never shown to agents) ═══
CREATE TABLE fleet_economy_policy (
  id                          smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  shortlist_max               integer     NOT NULL DEFAULT 5   CHECK (shortlist_max BETWEEN 1 AND 20),
  evidence_fresh_days         integer     NOT NULL DEFAULT 30  CHECK (evidence_fresh_days BETWEEN 1 AND 365),
  knowledge_fresh_days        integer     NOT NULL DEFAULT 180 CHECK (knowledge_fresh_days BETWEEN 1 AND 3650),
  forecast_tolerance_bp       integer     NOT NULL DEFAULT 2500 CHECK (forecast_tolerance_bp BETWEEN 1 AND 10000),
  failsafe_open_opportunities integer     NOT NULL DEFAULT 60  CHECK (failsafe_open_opportunities BETWEEN 5 AND 1000),
  failsafe_active_ventures    integer     NOT NULL DEFAULT 25  CHECK (failsafe_active_ventures BETWEEN 1 AND 500),
  failsafe_records_per_day    integer     NOT NULL DEFAULT 400 CHECK (failsafe_records_per_day BETWEEN 10 AND 10000),
  failsafe_vendors_per_day    integer     NOT NULL DEFAULT 20  CHECK (failsafe_vendors_per_day BETWEEN 1 AND 1000),
  research_loop_fetches       integer     NOT NULL DEFAULT 40  CHECK (research_loop_fetches BETWEEN 5 AND 5000),
  research_loop_window_h      integer     NOT NULL DEFAULT 24  CHECK (research_loop_window_h BETWEEN 1 AND 720),
  no_route_hours              integer     NOT NULL DEFAULT 72  CHECK (no_route_hours BETWEEN 1 AND 2160),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  updated_by                  text        NOT NULL DEFAULT 'migration'
);
INSERT INTO fleet_economy_policy (id) VALUES (1);
CREATE TRIGGER fleet_economy_policy_no_delete BEFORE DELETE ON fleet_economy_policy FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_economy_policy_no_truncate BEFORE TRUNCATE ON fleet_economy_policy FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_admin_economy_policy_set(p jsonb, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_economy_policy; k text;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  FOR k IN SELECT jsonb_object_keys(COALESCE(p, '{}'::jsonb)) LOOP
    IF k NOT IN ('shortlistMax','evidenceFreshDays','knowledgeFreshDays','forecastToleranceBp','failsafeOpenOpportunities','failsafeActiveVentures',
                 'failsafeRecordsPerDay','failsafeVendorsPerDay','researchLoopFetches','researchLoopWindowH','noRouteHours') THEN
      RAISE EXCEPTION 'FLEET_BAD_REQUEST: unknown economy policy key %', k;
    END IF;
  END LOOP;
  UPDATE fleet_economy_policy SET
    shortlist_max = COALESCE((p ->> 'shortlistMax')::integer, shortlist_max),
    evidence_fresh_days = COALESCE((p ->> 'evidenceFreshDays')::integer, evidence_fresh_days),
    knowledge_fresh_days = COALESCE((p ->> 'knowledgeFreshDays')::integer, knowledge_fresh_days),
    forecast_tolerance_bp = COALESCE((p ->> 'forecastToleranceBp')::integer, forecast_tolerance_bp),
    failsafe_open_opportunities = COALESCE((p ->> 'failsafeOpenOpportunities')::integer, failsafe_open_opportunities),
    failsafe_active_ventures = COALESCE((p ->> 'failsafeActiveVentures')::integer, failsafe_active_ventures),
    failsafe_records_per_day = COALESCE((p ->> 'failsafeRecordsPerDay')::integer, failsafe_records_per_day),
    failsafe_vendors_per_day = COALESCE((p ->> 'failsafeVendorsPerDay')::integer, failsafe_vendors_per_day),
    research_loop_fetches = COALESCE((p ->> 'researchLoopFetches')::integer, research_loop_fetches),
    research_loop_window_h = COALESCE((p ->> 'researchLoopWindowH')::integer, research_loop_window_h),
    no_route_hours = COALESCE((p ->> 'noRouteHours')::integer, no_route_hours),
    updated_at = now(), updated_by = p_actor
   WHERE id = 1 RETURNING * INTO r;
  PERFORM fleet_event('economy_policy_set', NULL, p_actor, p);
  RETURN to_jsonb(r);
END $$;

-- ═══ 2. Opportunities (evidence and economics; the agent ranks) ═══
CREATE TABLE fleet_opportunities (
  opportunity_id         uuid        PRIMARY KEY,
  agent_id               text        NOT NULL REFERENCES fleet_agents(agent_id),
  opportunity_key        text        NOT NULL CHECK (opportunity_key ~ '^[a-z0-9][a-z0-9._-]{1,47}$'),
  venture_type           text        NOT NULL CHECK (venture_type IN ('physical_product','digital_product','software','service','marketplace','other')),
  offer                  text        NOT NULL CHECK (length(offer) BETWEEN 1 AND 200),
  target_customer        text        CHECK (length(target_customer) <= 200),
  target_market          text        CHECK (length(target_market) <= 200),
  evidence               jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) <= 12),
  demand                 text        CHECK (length(demand) <= 300),
  competition            text        CHECK (length(competition) <= 300),
  est_margin_bp          integer     CHECK (est_margin_bp BETWEEN -10000 AND 10000),
  capital_required_minor bigint      CHECK (capital_required_minor BETWEEN 0 AND 100000000000),
  operating_cost_minor   bigint      CHECK (operating_cost_minor BETWEEN 0 AND 100000000000),
  time_to_launch_days    integer     CHECK (time_to_launch_days BETWEEN 0 AND 3650),
  time_to_revenue_days   integer     CHECK (time_to_revenue_days BETWEEN 0 AND 3650),
  downside_minor         bigint      CHECK (downside_minor BETWEEN 0 AND 100000000000),
  confidence_bp          integer     CHECK (confidence_bp BETWEEN 0 AND 10000),
  channel                text        CHECK (length(channel) <= 200),
  expected_outcome       text        CHECK (length(expected_outcome) <= 400),
  agent_rank             smallint    CHECK (agent_rank BETWEEN 1 AND 20),
  status                 text        NOT NULL DEFAULT 'candidate'
                                     CHECK (status IN ('candidate','shortlisted','selected','rejected','invalidated','stale','converted')),
  status_reason          text        CHECK (length(status_reason) <= 300),
  evidence_at            timestamptz,
  venture_id             uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, opportunity_key),
  CHECK ((status = 'shortlisted') = (agent_rank IS NOT NULL)),
  CHECK (status <> 'converted' OR venture_id IS NOT NULL)
);
CREATE UNIQUE INDEX fleet_opportunities_rank_uq ON fleet_opportunities (agent_id, agent_rank) WHERE status = 'shortlisted';
CREATE INDEX fleet_opportunities_agent_status ON fleet_opportunities (agent_id, status);
CREATE TRIGGER fleet_opportunities_no_delete BEFORE DELETE ON fleet_opportunities FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_opportunities_no_truncate BEFORE TRUNCATE ON fleet_opportunities FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE FUNCTION fleet_opportunities_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.opportunity_id <> OLD.opportunity_id OR NEW.agent_id <> OLD.agent_id OR NEW.opportunity_key <> OLD.opportunity_key OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: an opportunity''s identity is fixed';
  END IF;
  IF OLD.status = 'converted' AND (NEW.status <> 'converted' OR NEW.venture_id IS DISTINCT FROM OLD.venture_id) THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a converted opportunity belongs to its venture';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_opportunities_guard BEFORE UPDATE ON fleet_opportunities FOR EACH ROW EXECUTE FUNCTION fleet_opportunities_guard();

-- ═══ 3. Ventures ═══
CREATE TABLE fleet_ventures (
  venture_id          uuid        PRIMARY KEY,
  agent_id            text        NOT NULL REFERENCES fleet_agents(agent_id),
  venture_key         text        NOT NULL CHECK (venture_key ~ '^[a-z0-9][a-z0-9._-]{1,47}$'),
  business_model      text        NOT NULL CHECK (business_model IN ('physical_product','digital_product','software','service','marketplace','other')),
  offer               text        NOT NULL CHECK (length(offer) BETWEEN 1 AND 200),
  target_market       text        CHECK (length(target_market) <= 200),
  channels            text[]      NOT NULL DEFAULT '{}' CHECK (cardinality(channels) <= 8),
  state               text        NOT NULL DEFAULT 'discovered'
                                  CHECK (state IN ('discovered','researching','validating','selected','building','launching','operating','scaling',
                                                   'pivoting','paused','failed','closed')),
  state_reason        text        CHECK (length(state_reason) <= 300),
  opportunity_id      uuid        REFERENCES fleet_opportunities(opportunity_id),
  parent_venture_id   uuid        REFERENCES fleet_ventures(venture_id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz,
  UNIQUE (agent_id, venture_key),
  CHECK ((state = 'closed') = (closed_at IS NOT NULL))
);
ALTER TABLE fleet_opportunities ADD CONSTRAINT fleet_opportunities_venture_fk FOREIGN KEY (venture_id) REFERENCES fleet_ventures(venture_id);
CREATE INDEX fleet_ventures_agent_state ON fleet_ventures (agent_id, state);
CREATE TRIGGER fleet_ventures_no_delete BEFORE DELETE ON fleet_ventures FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_ventures_no_truncate BEFORE TRUNCATE ON fleet_ventures FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_venture_transition_rules (
  from_state text NOT NULL,
  to_state   text NOT NULL,
  PRIMARY KEY (from_state, to_state)
);
INSERT INTO fleet_venture_transition_rules (from_state, to_state) VALUES
  ('discovered','researching'), ('discovered','validating'), ('discovered','selected'), ('discovered','failed'), ('discovered','closed'),
  ('researching','validating'), ('researching','selected'), ('researching','paused'), ('researching','failed'), ('researching','closed'),
  ('validating','selected'), ('validating','researching'), ('validating','pivoting'), ('validating','paused'), ('validating','failed'), ('validating','closed'),
  ('selected','building'), ('selected','launching'), ('selected','pivoting'), ('selected','paused'), ('selected','failed'), ('selected','closed'),
  ('building','launching'), ('building','pivoting'), ('building','paused'), ('building','failed'), ('building','closed'),
  ('launching','operating'), ('launching','pivoting'), ('launching','paused'), ('launching','failed'), ('launching','closed'),
  ('operating','scaling'), ('operating','pivoting'), ('operating','paused'), ('operating','failed'), ('operating','closed'),
  ('scaling','operating'), ('scaling','pivoting'), ('scaling','paused'), ('scaling','failed'), ('scaling','closed'),
  ('pivoting','researching'), ('pivoting','validating'), ('pivoting','selected'), ('pivoting','building'), ('pivoting','failed'), ('pivoting','closed'),
  ('paused','researching'), ('paused','validating'), ('paused','selected'), ('paused','building'), ('paused','launching'), ('paused','operating'),
  ('paused','failed'), ('paused','closed'),
  ('failed','closed');
CREATE TRIGGER fleet_venture_transition_rules_no_change BEFORE UPDATE OR DELETE ON fleet_venture_transition_rules FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_venture_transition_rules_no_truncate BEFORE TRUNCATE ON fleet_venture_transition_rules FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_venture_transitions (
  seq         bigserial   PRIMARY KEY,
  venture_id  uuid        NOT NULL REFERENCES fleet_ventures(venture_id),
  agent_id    text        NOT NULL REFERENCES fleet_agents(agent_id),
  from_state  text,
  to_state    text        NOT NULL,
  reason      text        CHECK (length(reason) <= 300),
  decision_id uuid,
  actor       text        NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_venture_transitions_venture ON fleet_venture_transitions (venture_id, seq);
CREATE TRIGGER fleet_venture_transitions_no_change BEFORE UPDATE OR DELETE ON fleet_venture_transitions FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_venture_transitions_no_truncate BEFORE TRUNCATE ON fleet_venture_transitions FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- The state column moves only with a transition row in the same statement chain (fleet_venture_move), never directly.
CREATE FUNCTION fleet_ventures_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.venture_id <> OLD.venture_id OR NEW.agent_id <> OLD.agent_id OR NEW.venture_key <> OLD.venture_key OR NEW.created_at <> OLD.created_at
     OR NEW.parent_venture_id IS DISTINCT FROM OLD.parent_venture_id OR NEW.opportunity_id IS DISTINCT FROM OLD.opportunity_id THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a venture''s identity and lineage are fixed';
  END IF;
  IF OLD.state = 'closed' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: a closed venture is final'; END IF;
  IF NEW.state <> OLD.state AND COALESCE(current_setting('fleet.venture_move', true), '') <> NEW.venture_id::text THEN
    RAISE EXCEPTION 'FLEET_VENTURE_TRANSITION: a venture changes state only through its state machine';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_ventures_guard BEFORE UPDATE ON fleet_ventures FOR EACH ROW EXECUTE FUNCTION fleet_ventures_guard();

-- ═══ 4. Venture attribution of ledger journals (financials are derived, never stored) ═══
CREATE TABLE fleet_venture_journals (
  journal_id     uuid        PRIMARY KEY REFERENCES fleet_ledger_journal(journal_id),
  venture_id     uuid        NOT NULL REFERENCES fleet_ventures(venture_id),
  agent_id       text        NOT NULL REFERENCES fleet_agents(agent_id),
  cost_category  text        NOT NULL CHECK (cost_category IN ('revenue','refund','processor_fee','marketing','production','fulfilment','inference',
                                                               'subscription','operating','tax','capital','other')),
  attributed_by  text        NOT NULL,
  attributed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_venture_journals_venture ON fleet_venture_journals (venture_id);
CREATE FUNCTION fleet_venture_journals_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleet_ledger_journal j JOIN fleet_ventures v ON v.venture_id = NEW.venture_id
                  WHERE j.journal_id = NEW.journal_id AND j.agent_id = v.agent_id AND v.agent_id = NEW.agent_id) THEN
    RAISE EXCEPTION 'FLEET_ATTRIBUTION_SCOPE: a journal is attributed only to a venture of the journal''s own agent';
  END IF;
  IF EXISTS (SELECT 1 FROM fleet_ledger_journal j WHERE j.journal_id = NEW.journal_id AND j.kind = 'reversal') THEN
    RAISE EXCEPTION 'FLEET_ATTRIBUTION_SCOPE: a reversal follows its original''s attribution';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_venture_journals_guard BEFORE INSERT ON fleet_venture_journals FOR EACH ROW EXECUTE FUNCTION fleet_venture_journals_guard();
CREATE TRIGGER fleet_venture_journals_no_change BEFORE UPDATE OR DELETE ON fleet_venture_journals FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_venture_journals_no_truncate BEFORE TRUNCATE ON fleet_venture_journals FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- Venture financials from attributed postings (a reversal of an attributed journal counts against the same venture).
CREATE FUNCTION fleet_venture_financials(p_venture uuid, p_since timestamptz DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  WITH att AS (
    SELECT vj.journal_id, vj.cost_category, j.kind FROM fleet_venture_journals vj JOIN fleet_ledger_journal j ON j.journal_id = vj.journal_id
     WHERE vj.venture_id = p_venture
    UNION ALL  -- a reversal counts against the same venture, under its original's kind (it mirrors the postings)
    SELECT r.journal_id, vj.cost_category, j.kind FROM fleet_venture_journals vj JOIN fleet_ledger_journal j ON j.journal_id = vj.journal_id
      JOIN fleet_ledger_journal r ON r.reverses_journal_id = vj.journal_id
     WHERE vj.venture_id = p_venture
  ), p AS (
    SELECT a.cost_category, a.kind, ac.class, po.side, po.amount_cents
      FROM att a JOIN fleet_ledger_journal j ON j.journal_id = a.journal_id
      JOIN fleet_ledger_postings po ON po.journal_id = j.journal_id
      JOIN fleet_ledger_accounts ac ON ac.account_id = po.account_id
     WHERE p_since IS NULL OR j.occurred_at >= p_since
  ), s AS (
    SELECT
      COALESCE(sum(CASE WHEN side = 'C' THEN amount_cents ELSE -amount_cents END) FILTER (WHERE class = 'agent_revenue' AND kind <> 'external_refund'), 0) AS revenue,
      COALESCE(sum(CASE WHEN side = 'D' THEN amount_cents ELSE -amount_cents END) FILTER (WHERE class = 'agent_revenue' AND kind = 'external_refund'), 0) AS refunds,
      COALESCE(sum(CASE WHEN side = 'D' THEN amount_cents ELSE -amount_cents END) FILTER (WHERE class = 'agent_fees'), 0) AS fees,
      COALESCE(sum(CASE WHEN side = 'D' THEN amount_cents ELSE -amount_cents END) FILTER (WHERE class = 'agent_expense'), 0) AS costs,
      COALESCE(sum(CASE WHEN side = 'D' THEN amount_cents ELSE -amount_cents END) FILTER (WHERE class = 'agent_assets'), 0) AS assets,
      COALESCE(sum(CASE WHEN side = 'D' THEN amount_cents ELSE -amount_cents END) FILTER (WHERE class = 'agent_tax_reserve'), 0) AS tax_reserved,
      COALESCE(sum(CASE WHEN side = 'D' THEN amount_cents ELSE -amount_cents END) FILTER (WHERE class = 'agent_tax_expense'), 0) AS tax_paid,
      COALESCE(sum(CASE WHEN side = 'D' THEN amount_cents ELSE -amount_cents END) FILTER (WHERE class = 'agent_contributions'), 0) AS contributed
    FROM p
  ), c AS (
    SELECT jsonb_object_agg(cost_category, amt) AS by_cat FROM (
      SELECT cost_category, sum(CASE WHEN side = 'D' THEN amount_cents ELSE -amount_cents END) AS amt FROM p
       WHERE class IN ('agent_expense','agent_fees') GROUP BY cost_category) x
  )
  SELECT jsonb_build_object('revenueMinor', s.revenue, 'refundsMinor', s.refunds, 'processorFeesMinor', s.fees, 'costsMinor', s.costs,
    'costsByCategory', COALESCE(c.by_cat, '{}'::jsonb), 'assetsMinor', s.assets, 'taxReservedMinor', s.tax_reserved, 'taxPaidMinor', s.tax_paid,
    'grossProfitMinor', s.revenue - s.refunds - s.fees,
    'netProfitMinor', s.revenue - s.refunds - s.fees - s.costs,
    'netProfitAfterTaxMinor', s.revenue - s.refunds - s.fees - s.costs - s.tax_reserved - s.tax_paid,
    'capitalDeployedMinor', s.costs + s.fees + s.assets,
    'roiBp', CASE WHEN s.costs + s.fees + s.assets > 0 THEN ((s.revenue - s.refunds - s.fees - s.costs) * 10000 / (s.costs + s.fees + s.assets)) END,
    'treasuryContributionMinor', s.contributed)
    FROM s CROSS JOIN c
$$;

-- ═══ 5. Decision records (forecast immutable; outcome once; corrections are revisions) ═══
CREATE TABLE fleet_decision_records (
  decision_id               uuid        PRIMARY KEY,
  agent_id                  text        NOT NULL REFERENCES fleet_agents(agent_id),
  decision_key              text        NOT NULL CHECK (decision_key ~ '^[a-z0-9][a-z0-9:._-]{1,63}$'),
  revision                  integer     NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 50),
  purpose                   text        NOT NULL CHECK (purpose IN ('find_opportunity','expand_venture','select_opportunity','launch','pivot','scale',
                                                                  'terminate','spend','capital_request','other')),
  question                  text        NOT NULL CHECK (length(question) BETWEEN 1 AND 300),
  selected                  text        NOT NULL CHECK (length(selected) BETWEEN 1 AND 300),
  alternatives              jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(alternatives) = 'array' AND jsonb_array_length(alternatives) <= 8),
  evidence                  jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) <= 12),
  opportunity_id            uuid        REFERENCES fleet_opportunities(opportunity_id),
  venture_id                uuid        REFERENCES fleet_ventures(venture_id),
  forecast_revenue_minor    bigint      CHECK (forecast_revenue_minor BETWEEN 0 AND 100000000000),
  forecast_cost_minor       bigint      CHECK (forecast_cost_minor BETWEEN 0 AND 100000000000),
  forecast_margin_bp        integer     CHECK (forecast_margin_bp BETWEEN -10000 AND 10000),
  forecast_roi_bp           integer     CHECK (forecast_roi_bp BETWEEN -10000 AND 1000000),
  forecast_days_to_revenue  integer     CHECK (forecast_days_to_revenue BETWEEN 0 AND 3650),
  confidence_bp             integer     CHECK (confidence_bp BETWEEN 0 AND 10000),
  capital_exposed_minor     bigint      NOT NULL DEFAULT 0 CHECK (capital_exposed_minor BETWEEN 0 AND 100000000000),
  downside                  text        CHECK (length(downside) <= 300),
  invalidated_by            text        CHECK (length(invalidated_by) <= 300),
  next_action               text        CHECK (length(next_action) <= 300),
  correction                text        CHECK (length(correction) <= 600),
  outcome_status            text        NOT NULL DEFAULT 'pending' CHECK (outcome_status IN ('pending','measured')),
  outcome_source            text        CHECK (outcome_source IN ('ledger','agent_reported')),
  actual_revenue_minor      bigint      CHECK (actual_revenue_minor BETWEEN -100000000000 AND 100000000000),
  actual_cost_minor         bigint      CHECK (actual_cost_minor BETWEEN -100000000000 AND 100000000000),
  actual_days_to_revenue    integer     CHECK (actual_days_to_revenue BETWEEN 0 AND 3650),
  revenue_error_bp          integer,
  cost_error_bp             integer,
  lessons                   text        CHECK (length(lessons) <= 600),
  measured_at               timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, decision_key, revision),
  CHECK ((outcome_status = 'measured') = (measured_at IS NOT NULL AND outcome_source IS NOT NULL)),
  CHECK (revision = 1 OR correction IS NOT NULL)
);
CREATE INDEX fleet_decision_records_agent ON fleet_decision_records (agent_id, created_at DESC);
CREATE FUNCTION fleet_decision_records_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'FLEET_IMMUTABLE: decision records are never deleted'; END IF;
  IF OLD.outcome_status = 'measured' THEN RAISE EXCEPTION 'FLEET_IMMUTABLE: a measured outcome is final (record a correction instead)'; END IF;
  IF (to_jsonb(NEW) - ARRAY['outcome_status','outcome_source','actual_revenue_minor','actual_cost_minor','actual_days_to_revenue','revenue_error_bp',
                            'cost_error_bp','lessons','measured_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['outcome_status','outcome_source','actual_revenue_minor','actual_cost_minor','actual_days_to_revenue',
                            'revenue_error_bp','cost_error_bp','lessons','measured_at']) THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a decision''s forecast and evidence are fixed once recorded';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_decision_records_guard BEFORE UPDATE OR DELETE ON fleet_decision_records FOR EACH ROW EXECUTE FUNCTION fleet_decision_records_guard();
CREATE TRIGGER fleet_decision_records_no_truncate BEFORE TRUNCATE ON fleet_decision_records FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ═══ 6. Venture metrics (agent-observed counts: visits, leads, conversions, units) ═══
CREATE TABLE fleet_venture_metrics (
  seq        bigserial   PRIMARY KEY,
  venture_id uuid        NOT NULL REFERENCES fleet_ventures(venture_id),
  agent_id   text        NOT NULL REFERENCES fleet_agents(agent_id),
  metric     text        NOT NULL CHECK (metric IN ('visits','leads','conversions','units_sold','customers','repeat_customers','listings')),
  value      bigint      NOT NULL CHECK (value BETWEEN 0 AND 1000000000),
  period_end date        NOT NULL,
  source     text        NOT NULL CHECK (source IN ('agent_observed','provider')),
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_venture_metrics_venture ON fleet_venture_metrics (venture_id, metric, seq DESC);
CREATE TRIGGER fleet_venture_metrics_no_change BEFORE UPDATE OR DELETE ON fleet_venture_metrics FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_venture_metrics_no_truncate BEFORE TRUNCATE ON fleet_venture_metrics FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ═══ 7. Economic knowledge (the flywheel) ═══
CREATE TABLE fleet_economic_knowledge (
  knowledge_id    uuid        PRIMARY KEY,
  agent_id        text        NOT NULL REFERENCES fleet_agents(agent_id),
  topic           text        NOT NULL CHECK (topic IN ('niche','product','channel','pricing','conversion','vendor','manufacturer','demand','acquisition',
                                                       'assumption_failed','assumption_succeeded','launch_result','operational_cost')),
  subject         text        NOT NULL CHECK (subject ~ '^[a-z0-9][a-z0-9 ._/-]{1,79}$'),
  claim           text        NOT NULL CHECK (length(claim) BETWEEN 1 AND 600),
  evidence        jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) <= 8),
  venture_id      uuid        REFERENCES fleet_ventures(venture_id),
  decision_id     uuid        REFERENCES fleet_decision_records(decision_id),
  outcome_backed  boolean     NOT NULL DEFAULT false,
  confidence_bp   integer     CHECK (confidence_bp BETWEEN 0 AND 10000),
  observed_at     timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  superseded_at   timestamptz,
  CHECK (NOT outcome_backed OR decision_id IS NOT NULL),
  CHECK (expires_at > observed_at)
);
CREATE INDEX fleet_economic_knowledge_lookup ON fleet_economic_knowledge (topic, subject) WHERE superseded_at IS NULL;
CREATE FUNCTION fleet_economic_knowledge_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'FLEET_IMMUTABLE: knowledge is never deleted (it is superseded)'; END IF;
  IF OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL OR (to_jsonb(NEW) - 'superseded_at') IS DISTINCT FROM (to_jsonb(OLD) - 'superseded_at') THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a knowledge entry only ever becomes superseded';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_economic_knowledge_guard BEFORE UPDATE OR DELETE ON fleet_economic_knowledge FOR EACH ROW EXECUTE FUNCTION fleet_economic_knowledge_guard();
CREATE TRIGGER fleet_economic_knowledge_no_truncate BEFORE TRUNCATE ON fleet_economic_knowledge FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ═══ 8. Internal helpers (owner functions; reached by agents only through api_economy) ═══
CREATE FUNCTION fleet_econ_bad(p_reason text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'FLEET_BAD_REQUEST: %', p_reason; END $$;

-- Text argument: trimmed, scrubbed of secrets, bounded; NULL when absent (or an error when required).
CREATE FUNCTION fleet_econ_text(a jsonb, k text, p_max integer, p_required boolean DEFAULT false) RETURNS text LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v text;
BEGIN
  IF a ? k AND jsonb_typeof(a -> k) NOT IN ('string','null') THEN PERFORM fleet_econ_bad(k || ' must be text'); END IF;
  v := NULLIF(btrim(a ->> k), '');
  IF v IS NULL THEN
    IF p_required THEN PERFORM fleet_econ_bad(k || ' is required'); END IF;
    RETURN NULL;
  END IF;
  IF length(v) > p_max THEN PERFORM fleet_econ_bad(format('%s is at most %s characters', k, p_max)); END IF;
  RETURN fleet_scrub(v);
END $$;

-- Integer argument within bounds (money is always integer minor units; never floating point).
CREATE FUNCTION fleet_econ_int(a jsonb, k text, p_min bigint, p_max bigint, p_required boolean DEFAULT false) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  IF NOT (a ? k) OR jsonb_typeof(a -> k) = 'null' THEN
    IF p_required THEN PERFORM fleet_econ_bad(k || ' is required'); END IF;
    RETURN NULL;
  END IF;
  IF jsonb_typeof(a -> k) <> 'number' OR (a ->> k) !~ '^-?[0-9]{1,15}$' THEN PERFORM fleet_econ_bad(k || ' must be an integer (minor units / basis points)'); END IF;
  v := (a ->> k)::bigint;
  IF v < p_min OR v > p_max THEN PERFORM fleet_econ_bad(format('%s must be between %s and %s', k, p_min, p_max)); END IF;
  RETURN v;
END $$;

CREATE FUNCTION fleet_econ_key(a jsonb, k text, p_required boolean DEFAULT true) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text := a ->> k;
BEGIN
  IF v IS NULL THEN
    IF p_required THEN PERFORM fleet_econ_bad(k || ' is required'); END IF;
    RETURN NULL;
  END IF;
  v := lower(btrim(v));
  IF v !~ '^[a-z0-9][a-z0-9._-]{1,47}$' THEN PERFORM fleet_econ_bad(k || ' must be a short slug (a-z, 0-9, . _ -)'); END IF;
  RETURN v;
END $$;

-- Structured evidence items: {kind, source, observation, observedAt?, attemptId?}.
CREATE FUNCTION fleet_econ_evidence(a jsonb, k text, p_max integer) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE e jsonb; out jsonb := '[]'::jsonb; v_kind text; v_obs timestamptz;
BEGIN
  IF NOT (a ? k) OR jsonb_typeof(a -> k) = 'null' THEN RETURN '[]'::jsonb; END IF;
  IF jsonb_typeof(a -> k) <> 'array' OR jsonb_array_length(a -> k) > p_max THEN PERFORM fleet_econ_bad(format('%s is an array of at most %s items', k, p_max)); END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(a -> k) x LOOP
    IF jsonb_typeof(e) = 'string' THEN e := jsonb_build_object('kind', 'note', 'observation', e #>> '{}'); END IF;
    IF jsonb_typeof(e) <> 'object' THEN PERFORM fleet_econ_bad(k || ' items are objects'); END IF;
    v_kind := COALESCE(e ->> 'kind', 'note');
    IF v_kind NOT IN ('sales','ranking','bestseller','search_demand','customer_pain','reviews','pricing','competition','repeat_purchase','margin',
                      'channel','fleet_outcome','social','supplier','note') THEN
      PERFORM fleet_econ_bad('evidence kind ' || left(v_kind, 30) || ' is not recognised');
    END IF;
    IF COALESCE(length(e ->> 'observation'), 0) NOT BETWEEN 1 AND 400 OR COALESCE(length(e ->> 'source'), 0) > 300 THEN
      PERFORM fleet_econ_bad('each evidence item needs an observation (<= 400) and an optional source (<= 300)');
    END IF;
    BEGIN
      v_obs := CASE WHEN e ? 'observedAt' THEN (e ->> 'observedAt')::timestamptz ELSE now() END;
    EXCEPTION WHEN others THEN PERFORM fleet_econ_bad('observedAt must be a date');
    END;
    IF v_obs > now() + interval '1 day' THEN PERFORM fleet_econ_bad('observedAt is in the future'); END IF;
    out := out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('kind', v_kind, 'source', fleet_scrub(e ->> 'source'),
      'observation', fleet_scrub(e ->> 'observation'), 'observedAt', v_obs,
      'attemptId', CASE WHEN e ->> 'attemptId' ~ '^[0-9a-f-]{36}$' THEN e ->> 'attemptId' END)));
  END LOOP;
  RETURN out;
END $$;

CREATE FUNCTION fleet_econ_failsafe_records(p_agent text) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_economy_policy; n integer;
BEGIN
  SELECT * INTO p FROM fleet_economy_policy WHERE id = 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_REGISTRY_UNAVAILABLE: economy policy missing (fail closed)'; END IF;
  SELECT (SELECT count(*) FROM fleet_decision_records WHERE agent_id = p_agent AND created_at > now() - interval '1 day')
       + (SELECT count(*) FROM fleet_economic_knowledge WHERE agent_id = p_agent AND observed_at > now() - interval '1 day')
       + (SELECT count(*) FROM fleet_venture_transitions WHERE agent_id = p_agent AND at > now() - interval '1 day') INTO n;
  IF n >= p.failsafe_records_per_day THEN
    RAISE EXCEPTION 'FLEET_INFRASTRUCTURE_CEILING: an infrastructure failsafe against runaway loops was hit; continue with the decision at hand';
  END IF;
END $$;

-- ═══ 9. Opportunity operations ═══
CREATE FUNCTION fleet_opportunity_json(o fleet_opportunities) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('key', o.opportunity_key, 'type', o.venture_type, 'offer', o.offer, 'targetCustomer', o.target_customer,
    'targetMarket', o.target_market, 'evidence', o.evidence, 'demand', o.demand, 'competition', o.competition, 'estMarginBp', o.est_margin_bp,
    'capitalRequiredMinor', o.capital_required_minor, 'operatingCostMinorPerMonth', o.operating_cost_minor, 'timeToLaunchDays', o.time_to_launch_days,
    'timeToRevenueDays', o.time_to_revenue_days, 'downsideMinor', o.downside_minor, 'confidenceBp', o.confidence_bp, 'channel', o.channel,
    'expectedOutcome', o.expected_outcome, 'rank', o.agent_rank, 'status', o.status, 'statusReason', o.status_reason, 'evidenceAt', o.evidence_at,
    'ventureKey', (SELECT v.venture_key FROM fleet_ventures v WHERE v.venture_id = o.venture_id), 'updatedAt', o.updated_at))
$$;

-- Lazily mark candidates whose newest evidence is older than the freshness window as stale.
CREATE FUNCTION fleet_opportunity_expire(p_agent text) RETURNS integer LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE n integer;
BEGIN
  UPDATE fleet_opportunities SET status = 'stale', agent_rank = NULL, status_reason = 'evidence older than the freshness window: re-verify or drop',
         updated_at = now()
   WHERE agent_id = p_agent AND status IN ('candidate','shortlisted')
     AND COALESCE(evidence_at, created_at) < now() - make_interval(days => (SELECT evidence_fresh_days FROM fleet_economy_policy WHERE id = 1));
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN PERFORM fleet_event('opportunity_stale', p_agent, 'controller', jsonb_build_object('count', n)); END IF;
  RETURN n;
END $$;

CREATE FUNCTION fleet_econ_opportunity_record(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_opportunities; v_key text := fleet_econ_key(a, 'key'); v_ev jsonb := fleet_econ_evidence(a, 'evidence', 12); v_new boolean;
        v_type text := fleet_econ_text(a, 'type', 20); v_evat timestamptz;
BEGIN
  IF v_type IS NOT NULL AND v_type NOT IN ('physical_product','digital_product','software','service','marketplace','other') THEN
    PERFORM fleet_econ_bad('type is physical_product, digital_product, software, service, marketplace or other');
  END IF;
  SELECT max((e ->> 'observedAt')::timestamptz) INTO v_evat FROM jsonb_array_elements(v_ev) e;
  SELECT * INTO o FROM fleet_opportunities WHERE agent_id = p_agent AND opportunity_key = v_key FOR UPDATE;
  v_new := NOT FOUND;
  IF v_new THEN
    IF (SELECT count(*) FROM fleet_opportunities WHERE agent_id = p_agent AND status IN ('candidate','shortlisted','selected'))
       >= (SELECT failsafe_open_opportunities FROM fleet_economy_policy WHERE id = 1) THEN
      RAISE EXCEPTION 'FLEET_INFRASTRUCTURE_CEILING: an infrastructure failsafe was hit: reject or invalidate candidates you will not pursue, then decide';
    END IF;
    INSERT INTO fleet_opportunities (opportunity_id, agent_id, opportunity_key, venture_type, offer, evidence, evidence_at)
      VALUES (gen_random_uuid(), p_agent, v_key, COALESCE(v_type, 'other'), fleet_econ_text(a, 'offer', 200, true),
              v_ev, v_evat)
      RETURNING * INTO o;
  ELSIF o.status IN ('converted','rejected','invalidated') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_OPPORTUNITY_CLOSED',
      'reason', format('%s is %s; decided questions are not reopened without new evidence — record a new candidate key if the evidence is new', v_key, o.status));
  END IF;
  UPDATE fleet_opportunities SET
    venture_type = COALESCE(v_type, venture_type), offer = COALESCE(fleet_econ_text(a, 'offer', 200), offer),
    target_customer = COALESCE(fleet_econ_text(a, 'targetCustomer', 200), target_customer),
    target_market = COALESCE(fleet_econ_text(a, 'targetMarket', 200), target_market),
    -- New evidence is appended (newest kept within the bound); nothing already gathered is lost silently.
    evidence = CASE WHEN v_new OR jsonb_array_length(v_ev) = 0 THEN evidence
                    ELSE (SELECT COALESCE(jsonb_agg(x ORDER BY n DESC), '[]'::jsonb) FROM (
                            SELECT x, n FROM jsonb_array_elements(evidence || v_ev) WITH ORDINALITY t(x, n) ORDER BY n DESC LIMIT 12) y) END,
    evidence_at = GREATEST(evidence_at, v_evat),
    demand = COALESCE(fleet_econ_text(a, 'demand', 300), demand), competition = COALESCE(fleet_econ_text(a, 'competition', 300), competition),
    est_margin_bp = COALESCE(fleet_econ_int(a, 'estMarginBp', -10000, 10000)::integer, est_margin_bp),
    capital_required_minor = COALESCE(fleet_econ_int(a, 'capitalRequiredMinor', 0, 100000000000), capital_required_minor),
    operating_cost_minor = COALESCE(fleet_econ_int(a, 'operatingCostMinorPerMonth', 0, 100000000000), operating_cost_minor),
    time_to_launch_days = COALESCE(fleet_econ_int(a, 'timeToLaunchDays', 0, 3650)::integer, time_to_launch_days),
    time_to_revenue_days = COALESCE(fleet_econ_int(a, 'timeToRevenueDays', 0, 3650)::integer, time_to_revenue_days),
    downside_minor = COALESCE(fleet_econ_int(a, 'downsideMinor', 0, 100000000000), downside_minor),
    confidence_bp = COALESCE(fleet_econ_int(a, 'confidenceBp', 0, 10000)::integer, confidence_bp),
    channel = COALESCE(fleet_econ_text(a, 'channel', 200), channel),
    expected_outcome = COALESCE(fleet_econ_text(a, 'expectedOutcome', 400), expected_outcome),
    status = CASE WHEN status = 'stale' AND jsonb_array_length(v_ev) > 0 THEN 'candidate' ELSE status END,
    status_reason = CASE WHEN status = 'stale' AND jsonb_array_length(v_ev) > 0 THEN 're-verified with fresh evidence' ELSE status_reason END,
    updated_at = now()
   WHERE opportunity_id = o.opportunity_id RETURNING * INTO o;
  PERFORM fleet_event('opportunity_recorded', p_agent, p_agent, jsonb_build_object('key', v_key, 'new', v_new, 'evidenceItems', jsonb_array_length(o.evidence)));
  RETURN jsonb_build_object('ok', true, 'created', v_new, 'opportunity', fleet_opportunity_json(o));
END $$;

-- The agent's own ranking: [{key, rank}] becomes the shortlist; every other shortlisted candidate returns to candidate.
CREATE FUNCTION fleet_econ_opportunity_shortlist(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_max integer := (SELECT shortlist_max FROM fleet_economy_policy WHERE id = 1); e jsonb; v_key text; v_rank integer; n integer := 0;
        v_keys text[] := ARRAY[]::text[]; v_ranks integer[] := ARRAY[]::integer[];
BEGIN
  PERFORM fleet_opportunity_expire(p_agent);
  IF jsonb_typeof(a -> 'ranking') IS DISTINCT FROM 'array' OR jsonb_array_length(a -> 'ranking') < 1 THEN
    PERFORM fleet_econ_bad('ranking is your ordered shortlist: [{key, rank}, …]');
  END IF;
  IF jsonb_array_length(a -> 'ranking') > v_max THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SHORTLIST_TOO_LONG',
      'reason', format('a shortlist holds at most %s candidates: it exists to produce a decision, not a feed', v_max));
  END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(a -> 'ranking') x LOOP
    v_key := fleet_econ_key(e, 'key');
    v_rank := fleet_econ_int(e, 'rank', 1, v_max, true)::integer;
    IF v_key = ANY (v_keys) OR v_rank = ANY (v_ranks) THEN PERFORM fleet_econ_bad('each key and each rank appears once'); END IF;
    IF NOT EXISTS (SELECT 1 FROM fleet_opportunities WHERE agent_id = p_agent AND opportunity_key = v_key AND status IN ('candidate','shortlisted')) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_A_CANDIDATE',
        'reason', format('%s is not an open candidate (record it first, or re-verify it if stale)', v_key));
    END IF;
    v_keys := v_keys || v_key; v_ranks := v_ranks || v_rank;
  END LOOP;
  UPDATE fleet_opportunities SET status = 'candidate', agent_rank = NULL, updated_at = now() WHERE agent_id = p_agent AND status = 'shortlisted';
  FOR n IN 1 .. cardinality(v_keys) LOOP
    UPDATE fleet_opportunities SET status = 'shortlisted', agent_rank = v_ranks[n], status_reason = fleet_econ_text(a, 'rationale', 300), updated_at = now()
     WHERE agent_id = p_agent AND opportunity_key = v_keys[n];
  END LOOP;
  PERFORM fleet_event('opportunity_shortlist', p_agent, p_agent, jsonb_build_object('size', cardinality(v_keys)));
  RETURN jsonb_build_object('ok', true, 'shortlist', (SELECT jsonb_agg(fleet_opportunity_json(o) ORDER BY o.agent_rank) FROM fleet_opportunities o
                                                      WHERE o.agent_id = p_agent AND o.status = 'shortlisted'));
END $$;

CREATE FUNCTION fleet_econ_opportunity_status(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_opportunities; v_key text := fleet_econ_key(a, 'key'); v_status text := fleet_econ_text(a, 'status', 20, true);
        v_reason text := fleet_econ_text(a, 'reason', 300, true);
BEGIN
  IF v_status NOT IN ('selected','rejected','invalidated') THEN PERFORM fleet_econ_bad('status is selected, rejected or invalidated'); END IF;
  SELECT * INTO o FROM fleet_opportunities WHERE agent_id = p_agent AND opportunity_key = v_key FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF o.status IN ('converted','rejected','invalidated') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_OPPORTUNITY_CLOSED', 'reason', format('%s is already %s', v_key, o.status));
  END IF;
  UPDATE fleet_opportunities SET status = v_status, agent_rank = NULL, status_reason = v_reason, updated_at = now()
   WHERE opportunity_id = o.opportunity_id RETURNING * INTO o;
  PERFORM fleet_event('opportunity_' || v_status, p_agent, p_agent, jsonb_build_object('key', v_key));
  RETURN jsonb_build_object('ok', true, 'opportunity', fleet_opportunity_json(o));
END $$;

CREATE FUNCTION fleet_econ_opportunity_list(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_status text := COALESCE(fleet_econ_text(a, 'status', 20), 'open'); v_limit integer := COALESCE(fleet_econ_int(a, 'limit', 1, 20), 10)::integer;
BEGIN
  PERFORM fleet_opportunity_expire(p_agent);
  RETURN jsonb_build_object('ok', true, 'opportunities', COALESCE((
    SELECT jsonb_agg(fleet_opportunity_json(o) ORDER BY o.agent_rank NULLS LAST, o.updated_at DESC) FROM (
      SELECT * FROM fleet_opportunities o
       WHERE o.agent_id = p_agent AND (CASE v_status WHEN 'open' THEN o.status IN ('candidate','shortlisted','selected') ELSE o.status = v_status END)
       ORDER BY o.agent_rank NULLS LAST, o.updated_at DESC LIMIT v_limit) o), '[]'::jsonb));
END $$;

-- ═══ 10. Ventures ═══
CREATE FUNCTION fleet_venture_json(v fleet_ventures, p_detail boolean DEFAULT false) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('key', v.venture_key, 'model', v.business_model, 'offer', v.offer, 'targetMarket', v.target_market,
    'channels', to_jsonb(v.channels), 'state', v.state, 'stateReason', v.state_reason,
    'opportunityKey', (SELECT o.opportunity_key FROM fleet_opportunities o WHERE o.opportunity_id = v.opportunity_id),
    'parentVentureKey', (SELECT p.venture_key FROM fleet_ventures p WHERE p.venture_id = v.parent_venture_id),
    'createdAt', v.created_at, 'updatedAt', v.updated_at, 'closedAt', v.closed_at,
    'financials', fleet_venture_financials(v.venture_id),
    'transitions', CASE WHEN p_detail THEN (SELECT jsonb_agg(jsonb_build_object('from', t.from_state, 'to', t.to_state, 'reason', t.reason, 'at', t.at) ORDER BY t.seq DESC)
                                              FROM (SELECT * FROM fleet_venture_transitions t WHERE t.venture_id = v.venture_id ORDER BY t.seq DESC LIMIT 10) t) END,
    'metrics', CASE WHEN p_detail THEN (SELECT jsonb_object_agg(m.metric, m.value) FROM (
                  SELECT DISTINCT ON (metric) metric, value FROM fleet_venture_metrics WHERE venture_id = v.venture_id ORDER BY metric, seq DESC) m) END))
$$;

-- The single state mover: rule table, factual conditions, append-only history.
CREATE FUNCTION fleet_venture_move(v fleet_ventures, p_to text, p_reason text, p_decision uuid, p_actor text) RETURNS fleet_ventures LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_ventures; f jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleet_venture_transition_rules WHERE from_state = v.state AND to_state = p_to) THEN
    RAISE EXCEPTION 'FLEET_VENTURE_TRANSITION: % -> % is not a venture transition', v.state, p_to;
  END IF;
  IF p_to = 'scaling' THEN
    f := fleet_venture_financials(v.venture_id);
    IF (f ->> 'netProfitMinor')::bigint <= 0 THEN
      RAISE EXCEPTION 'FLEET_VENTURE_EVIDENCE: scaling needs ledger-backed positive net profit (now %); keep operating, or pivot', f ->> 'netProfitMinor';
    END IF;
  END IF;
  IF p_to = 'operating' AND cardinality(v.channels) = 0 THEN
    RAISE EXCEPTION 'FLEET_VENTURE_EVIDENCE: an operating venture names at least one channel it sells through';
  END IF;
  PERFORM set_config('fleet.venture_move', v.venture_id::text, true);
  UPDATE fleet_ventures SET state = p_to, state_reason = p_reason, updated_at = now(), closed_at = CASE WHEN p_to = 'closed' THEN now() END
   WHERE venture_id = v.venture_id RETURNING * INTO r;
  PERFORM set_config('fleet.venture_move', '', true);
  INSERT INTO fleet_venture_transitions (venture_id, agent_id, from_state, to_state, reason, decision_id, actor)
    VALUES (v.venture_id, v.agent_id, v.state, p_to, p_reason, p_decision, p_actor);
  PERFORM fleet_event('venture_state', v.agent_id, p_actor, jsonb_build_object('venture', v.venture_key, 'from', v.state, 'to', p_to));
  RETURN r;
END $$;

CREATE FUNCTION fleet_econ_venture_create(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v fleet_ventures; v_key text := fleet_econ_key(a, 'key'); o fleet_opportunities; p fleet_ventures; v_state text := COALESCE(fleet_econ_text(a, 'state', 20), 'discovered');
        v_model text := fleet_econ_text(a, 'model', 20); v_channels text[] := ARRAY[]::text[]; c text; v_id uuid := gen_random_uuid();
BEGIN
  SELECT * INTO v FROM fleet_ventures WHERE agent_id = p_agent AND venture_key = v_key;
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'replayed', true, 'venture', fleet_venture_json(v)); END IF;
  IF (SELECT count(*) FROM fleet_ventures WHERE agent_id = p_agent AND state NOT IN ('failed','closed'))
     >= (SELECT failsafe_active_ventures FROM fleet_economy_policy WHERE id = 1) THEN
    RAISE EXCEPTION 'FLEET_INFRASTRUCTURE_CEILING: an infrastructure failsafe was hit: close or fail ventures you no longer operate';
  END IF;
  IF v_state NOT IN ('discovered','researching','validating','selected') THEN PERFORM fleet_econ_bad('a venture starts discovered, researching, validating or selected'); END IF;
  IF a ? 'opportunityKey' THEN
    SELECT * INTO o FROM fleet_opportunities WHERE agent_id = p_agent AND opportunity_key = fleet_econ_key(a, 'opportunityKey') FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND', 'reason', 'no such opportunity of yours'); END IF;
    IF o.status IN ('converted','rejected','invalidated') THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_OPPORTUNITY_CLOSED', 'reason', format('%s is %s', o.opportunity_key, o.status));
    END IF;
  END IF;
  IF a ? 'parentVentureKey' THEN
    SELECT * INTO p FROM fleet_ventures WHERE agent_id = p_agent AND venture_key = fleet_econ_key(a, 'parentVentureKey');
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND', 'reason', 'no such parent venture of yours'); END IF;
  END IF;
  IF a ? 'channels' THEN
    IF jsonb_typeof(a -> 'channels') <> 'array' OR jsonb_array_length(a -> 'channels') > 8 THEN PERFORM fleet_econ_bad('channels is an array of at most 8'); END IF;
    FOR c IN SELECT jsonb_array_elements_text(a -> 'channels') LOOP
      IF length(btrim(c)) NOT BETWEEN 1 AND 60 THEN PERFORM fleet_econ_bad('each channel is 1-60 characters'); END IF;
      v_channels := v_channels || fleet_scrub(btrim(c));
    END LOOP;
  END IF;
  IF v_model IS NULL THEN v_model := COALESCE(o.venture_type, 'other'); END IF;
  IF v_model NOT IN ('physical_product','digital_product','software','service','marketplace','other') THEN
    PERFORM fleet_econ_bad('model is physical_product, digital_product, software, service, marketplace or other');
  END IF;
  INSERT INTO fleet_ventures (venture_id, agent_id, venture_key, business_model, offer, target_market, channels, state, opportunity_id, parent_venture_id)
    VALUES (v_id, p_agent, v_key, v_model, COALESCE(fleet_econ_text(a, 'offer', 200), o.offer, fleet_econ_text(a, 'offer', 200, true)),
            COALESCE(fleet_econ_text(a, 'targetMarket', 200), o.target_market), v_channels, v_state, o.opportunity_id, p.venture_id)
    RETURNING * INTO v;
  INSERT INTO fleet_venture_transitions (venture_id, agent_id, from_state, to_state, reason, actor)
    VALUES (v.venture_id, p_agent, NULL, v_state, COALESCE(fleet_econ_text(a, 'reason', 300), 'created'), p_agent);
  IF o.opportunity_id IS NOT NULL THEN
    UPDATE fleet_opportunities SET status = 'converted', agent_rank = NULL, venture_id = v.venture_id, status_reason = 'converted into venture ' || v_key, updated_at = now()
     WHERE opportunity_id = o.opportunity_id;
  END IF;
  PERFORM fleet_event('venture_created', p_agent, p_agent, jsonb_build_object('venture', v_key, 'state', v_state, 'model', v_model,
    'parent', p.venture_key, 'opportunity', o.opportunity_key));
  RETURN jsonb_build_object('ok', true, 'venture', fleet_venture_json(v));
END $$;

CREATE FUNCTION fleet_econ_venture_transition(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v fleet_ventures; v_to text := fleet_econ_text(a, 'to', 20, true); v_reason text := fleet_econ_text(a, 'reason', 300, true); d uuid; c text;
BEGIN
  SELECT * INTO v FROM fleet_ventures WHERE agent_id = p_agent AND venture_key = fleet_econ_key(a, 'key') FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND', 'reason', 'no such venture of yours'); END IF;
  IF v.state = 'closed' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE', 'reason', 'the venture is closed'); END IF;
  IF a ? 'decisionKey' THEN
    SELECT decision_id INTO d FROM fleet_decision_records WHERE agent_id = p_agent AND decision_key = lower(a ->> 'decisionKey') ORDER BY revision DESC LIMIT 1;
  END IF;
  IF a ? 'channels' THEN  -- the agent's own channel choice moves with the venture (no approval)
    IF jsonb_typeof(a -> 'channels') <> 'array' OR jsonb_array_length(a -> 'channels') > 8 THEN PERFORM fleet_econ_bad('channels is an array of at most 8'); END IF;
    UPDATE fleet_ventures SET channels = (SELECT COALESCE(array_agg(fleet_scrub(left(btrim(x), 60))), ARRAY[]::text[]) FROM jsonb_array_elements_text(a -> 'channels') x
                                           WHERE length(btrim(x)) > 0), updated_at = now()
     WHERE venture_id = v.venture_id RETURNING * INTO v;
  END IF;
  BEGIN
    v := fleet_venture_move(v, v_to, v_reason, d, p_agent);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM ~ '^FLEET_VENTURE_(TRANSITION|EVIDENCE)' THEN
      RETURN jsonb_build_object('ok', false, 'code', split_part(SQLERRM, ':', 1), 'reason', btrim(substr(SQLERRM, position(':' IN SQLERRM) + 1)));
    END IF;
    RAISE;
  END;
  RETURN jsonb_build_object('ok', true, 'venture', fleet_venture_json(v));
END $$;

CREATE FUNCTION fleet_econ_venture_metric(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v fleet_ventures; v_metric text := fleet_econ_text(a, 'metric', 30, true);
BEGIN
  SELECT * INTO v FROM fleet_ventures WHERE agent_id = p_agent AND venture_key = fleet_econ_key(a, 'key');
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND', 'reason', 'no such venture of yours'); END IF;
  IF v_metric NOT IN ('visits','leads','conversions','units_sold','customers','repeat_customers','listings') THEN
    PERFORM fleet_econ_bad('metric is visits, leads, conversions, units_sold, customers, repeat_customers or listings');
  END IF;
  INSERT INTO fleet_venture_metrics (venture_id, agent_id, metric, value, period_end, source)
    VALUES (v.venture_id, p_agent, v_metric, fleet_econ_int(a, 'value', 0, 1000000000, true), COALESCE((a ->> 'periodEnd')::date, current_date), 'agent_observed');
  RETURN jsonb_build_object('ok', true);
END $$;

-- ═══ 11. Decision records ═══
CREATE FUNCTION fleet_decision_json(d fleet_decision_records) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('key', d.decision_key, 'revision', d.revision, 'purpose', d.purpose, 'question', d.question,
    'selected', d.selected, 'alternatives', d.alternatives, 'evidenceItems', jsonb_array_length(d.evidence),
    'opportunityKey', (SELECT o.opportunity_key FROM fleet_opportunities o WHERE o.opportunity_id = d.opportunity_id),
    'ventureKey', (SELECT v.venture_key FROM fleet_ventures v WHERE v.venture_id = d.venture_id),
    'forecast', jsonb_strip_nulls(jsonb_build_object('revenueMinor', d.forecast_revenue_minor, 'costMinor', d.forecast_cost_minor, 'marginBp', d.forecast_margin_bp,
                  'roiBp', d.forecast_roi_bp, 'daysToRevenue', d.forecast_days_to_revenue, 'confidenceBp', d.confidence_bp)),
    'capitalExposedMinor', d.capital_exposed_minor, 'downside', d.downside, 'invalidatedBy', d.invalidated_by, 'nextAction', d.next_action,
    'correction', d.correction, 'outcome', CASE WHEN d.outcome_status = 'measured' THEN jsonb_strip_nulls(jsonb_build_object('source', d.outcome_source,
                  'revenueMinor', d.actual_revenue_minor, 'costMinor', d.actual_cost_minor, 'daysToRevenue', d.actual_days_to_revenue,
                  'revenueErrorBp', d.revenue_error_bp, 'costErrorBp', d.cost_error_bp, 'lessons', d.lessons, 'measuredAt', d.measured_at)) END,
    'createdAt', d.created_at))
$$;

CREATE FUNCTION fleet_econ_decision_record(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE d fleet_decision_records; v_key text := lower(btrim(a ->> 'key')); v_purpose text := COALESCE(fleet_econ_text(a, 'purpose', 30), 'other');
        v_alt jsonb := '[]'::jsonb; e jsonb; o uuid; vv uuid;
BEGIN
  IF v_key IS NULL OR v_key !~ '^[a-z0-9][a-z0-9:._-]{1,63}$' THEN PERFORM fleet_econ_bad('key is your decision key'); END IF;
  PERFORM fleet_econ_failsafe_records(p_agent);
  SELECT * INTO d FROM fleet_decision_records WHERE agent_id = p_agent AND decision_key = v_key ORDER BY revision DESC LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'replayed', true, 'decision', fleet_decision_json(d)); END IF;
  IF v_purpose NOT IN ('find_opportunity','expand_venture','select_opportunity','launch','pivot','scale','terminate','spend','capital_request','other') THEN
    PERFORM fleet_econ_bad('purpose is find_opportunity, expand_venture, select_opportunity, launch, pivot, scale, terminate, spend, capital_request or other');
  END IF;
  IF a ? 'alternatives' THEN
    IF jsonb_typeof(a -> 'alternatives') <> 'array' OR jsonb_array_length(a -> 'alternatives') > 8 THEN PERFORM fleet_econ_bad('alternatives is an array of at most 8'); END IF;
    FOR e IN SELECT x FROM jsonb_array_elements(a -> 'alternatives') x LOOP
      v_alt := v_alt || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('option', left(fleet_scrub(COALESCE(e ->> 'option', e #>> '{}')), 200),
                                                                               'reason', left(fleet_scrub(e ->> 'reason'), 300))));
    END LOOP;
  END IF;
  IF a ? 'opportunityKey' THEN
    SELECT opportunity_id INTO o FROM fleet_opportunities WHERE agent_id = p_agent AND opportunity_key = fleet_econ_key(a, 'opportunityKey');
    IF o IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND', 'reason', 'no such opportunity of yours'); END IF;
  END IF;
  IF a ? 'ventureKey' THEN
    SELECT venture_id INTO vv FROM fleet_ventures WHERE agent_id = p_agent AND venture_key = fleet_econ_key(a, 'ventureKey');
    IF vv IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND', 'reason', 'no such venture of yours'); END IF;
  END IF;
  INSERT INTO fleet_decision_records (decision_id, agent_id, decision_key, purpose, question, selected, alternatives, evidence, opportunity_id, venture_id,
      forecast_revenue_minor, forecast_cost_minor, forecast_margin_bp, forecast_roi_bp, forecast_days_to_revenue, confidence_bp, capital_exposed_minor,
      downside, invalidated_by, next_action)
    VALUES (gen_random_uuid(), p_agent, v_key, v_purpose, fleet_econ_text(a, 'question', 300, true), fleet_econ_text(a, 'selected', 300, true), v_alt,
      fleet_econ_evidence(a, 'evidence', 12), o, vv,
      fleet_econ_int(a, 'forecastRevenueMinor', 0, 100000000000), fleet_econ_int(a, 'forecastCostMinor', 0, 100000000000),
      fleet_econ_int(a, 'forecastMarginBp', -10000, 10000)::integer, fleet_econ_int(a, 'forecastRoiBp', -10000, 1000000)::integer,
      fleet_econ_int(a, 'forecastDaysToRevenue', 0, 3650)::integer, fleet_econ_int(a, 'confidenceBp', 0, 10000)::integer,
      COALESCE(fleet_econ_int(a, 'capitalExposedMinor', 0, 100000000000), 0),
      fleet_econ_text(a, 'downside', 300), fleet_econ_text(a, 'invalidatedBy', 300), fleet_econ_text(a, 'nextAction', 300))
    RETURNING * INTO d;
  PERFORM fleet_event('decision_recorded', p_agent, p_agent, jsonb_build_object('key', v_key, 'purpose', v_purpose,
    'capitalExposedMinor', d.capital_exposed_minor, 'forecast', d.forecast_revenue_minor IS NOT NULL));
  RETURN jsonb_build_object('ok', true, 'decision', fleet_decision_json(d));
END $$;

-- Signed relative error of actual vs forecast, in basis points of the forecast (NULL when there is no forecast).
CREATE FUNCTION fleet_forecast_error_bp(p_forecast bigint, p_actual bigint) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_forecast IS NULL OR p_actual IS NULL THEN NULL
              WHEN p_forecast = 0 THEN CASE WHEN p_actual = 0 THEN 0 ELSE 10000 * sign(p_actual)::integer END
              ELSE GREATEST(-1000000, LEAST(1000000, ((p_actual - p_forecast) * 10000 / abs(p_forecast))))::integer END
$$;

-- Measure: a venture-linked decision is measured from the LEDGER (attributed journals since the decision); otherwise the
-- agent's own report. The measured result and its lessons feed knowledge (shared fleet-wide only when ledger-backed).
CREATE FUNCTION fleet_econ_decision_outcome(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE d fleet_decision_records; f jsonb; v_src text; v_rev bigint; v_cost bigint; v_days integer; v_lessons text := fleet_econ_text(a, 'lessons', 600);
        v_first timestamptz; p fleet_economy_policy;
BEGIN
  SELECT * INTO d FROM fleet_decision_records WHERE agent_id = p_agent AND decision_key = lower(btrim(a ->> 'key')) ORDER BY revision DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND', 'reason', 'no such decision of yours'); END IF;
  IF d.outcome_status = 'measured' THEN RETURN jsonb_build_object('ok', true, 'replayed', true, 'decision', fleet_decision_json(d)); END IF;
  SELECT * INTO p FROM fleet_economy_policy WHERE id = 1;
  IF d.venture_id IS NOT NULL THEN
    f := fleet_venture_financials(d.venture_id, d.created_at);
    v_src := 'ledger';
    v_rev := (f ->> 'revenueMinor')::bigint - (f ->> 'refundsMinor')::bigint;
    v_cost := (f ->> 'costsMinor')::bigint + (f ->> 'processorFeesMinor')::bigint;
    SELECT min(j.occurred_at) INTO v_first FROM fleet_venture_journals vj JOIN fleet_ledger_journal j ON j.journal_id = vj.journal_id
     WHERE vj.venture_id = d.venture_id AND vj.cost_category = 'revenue' AND j.occurred_at >= d.created_at;
    v_days := CASE WHEN v_first IS NOT NULL THEN floor(extract(epoch FROM v_first - d.created_at) / 86400)::integer END;
  ELSE
    v_src := 'agent_reported';
    v_rev := fleet_econ_int(a, 'actualRevenueMinor', -100000000000, 100000000000);
    v_cost := fleet_econ_int(a, 'actualCostMinor', -100000000000, 100000000000);
    v_days := fleet_econ_int(a, 'actualDaysToRevenue', 0, 3650)::integer;
    IF v_rev IS NULL AND v_cost IS NULL THEN PERFORM fleet_econ_bad('a decision without a venture is measured with actualRevenueMinor and/or actualCostMinor'); END IF;
  END IF;
  UPDATE fleet_decision_records SET outcome_status = 'measured', outcome_source = v_src, actual_revenue_minor = v_rev, actual_cost_minor = v_cost,
         actual_days_to_revenue = v_days, revenue_error_bp = fleet_forecast_error_bp(forecast_revenue_minor, v_rev),
         cost_error_bp = fleet_forecast_error_bp(forecast_cost_minor, v_cost), lessons = v_lessons, measured_at = now()
   WHERE decision_id = d.decision_id RETURNING * INTO d;
  IF v_lessons IS NOT NULL THEN
    INSERT INTO fleet_economic_knowledge (knowledge_id, agent_id, topic, subject, claim, venture_id, decision_id, outcome_backed, observed_at, expires_at)
      VALUES (gen_random_uuid(), p_agent,
              CASE WHEN v_rev IS NOT NULL AND v_rev > 0 THEN 'assumption_succeeded' ELSE 'assumption_failed' END,
              left(regexp_replace(lower(d.decision_key), '[^a-z0-9 ._/-]', '-', 'g'), 80), v_lessons, d.venture_id, d.decision_id, v_src = 'ledger',
              now(), now() + make_interval(days => p.knowledge_fresh_days));
  END IF;
  PERFORM fleet_event('decision_measured', p_agent, p_agent, jsonb_build_object('key', d.decision_key, 'source', v_src,
    'revenueErrorBp', d.revenue_error_bp, 'costErrorBp', d.cost_error_bp));
  RETURN jsonb_build_object('ok', true, 'decision', fleet_decision_json(d));
END $$;

-- A correction: a new revision naming the previous path, the new path, and why (new evidence). The previous revision's
-- forecast stays on record for calibration.
CREATE FUNCTION fleet_econ_decision_correct(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE d fleet_decision_records; n fleet_decision_records; v_corr text := fleet_econ_text(a, 'correction', 600, true);
        v_sel text := fleet_econ_text(a, 'selected', 300, true); v_ev jsonb := fleet_econ_evidence(a, 'evidence', 12);
BEGIN
  PERFORM fleet_econ_failsafe_records(p_agent);
  SELECT * INTO d FROM fleet_decision_records WHERE agent_id = p_agent AND decision_key = lower(btrim(a ->> 'key')) ORDER BY revision DESC LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND', 'reason', 'no such decision of yours'); END IF;
  IF jsonb_array_length(v_ev) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CORRECTION_UNSUPPORTED', 'reason', 'a correction rests on NEW evidence; without it, keep executing the decided path');
  END IF;
  IF lower(v_sel) = lower(d.selected) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_A_CORRECTION', 'reason', 'the selected path is unchanged: record the outcome instead');
  END IF;
  IF EXISTS (SELECT 1 FROM fleet_decision_records WHERE agent_id = p_agent AND decision_key = d.decision_key AND lower(selected) = lower(v_sel)) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_OSCILLATION', 'reason', 'that path was already abandoned on evidence; choose a forward path');
  END IF;
  INSERT INTO fleet_decision_records (decision_id, agent_id, decision_key, revision, purpose, question, selected, alternatives, evidence, opportunity_id, venture_id,
      forecast_revenue_minor, forecast_cost_minor, forecast_margin_bp, forecast_roi_bp, forecast_days_to_revenue, confidence_bp, capital_exposed_minor,
      downside, invalidated_by, next_action, correction)
    VALUES (gen_random_uuid(), p_agent, d.decision_key, d.revision + 1, d.purpose, d.question, v_sel,
      d.alternatives || jsonb_build_array(jsonb_build_object('option', left(d.selected, 200), 'reason', 'abandoned on new evidence')), v_ev, d.opportunity_id, d.venture_id,
      COALESCE(fleet_econ_int(a, 'forecastRevenueMinor', 0, 100000000000), d.forecast_revenue_minor),
      COALESCE(fleet_econ_int(a, 'forecastCostMinor', 0, 100000000000), d.forecast_cost_minor),
      COALESCE(fleet_econ_int(a, 'forecastMarginBp', -10000, 10000)::integer, d.forecast_margin_bp),
      COALESCE(fleet_econ_int(a, 'forecastRoiBp', -10000, 1000000)::integer, d.forecast_roi_bp),
      COALESCE(fleet_econ_int(a, 'forecastDaysToRevenue', 0, 3650)::integer, d.forecast_days_to_revenue),
      COALESCE(fleet_econ_int(a, 'confidenceBp', 0, 10000)::integer, d.confidence_bp),
      COALESCE(fleet_econ_int(a, 'capitalExposedMinor', 0, 100000000000), d.capital_exposed_minor),
      COALESCE(fleet_econ_text(a, 'downside', 300), d.downside), COALESCE(fleet_econ_text(a, 'invalidatedBy', 300), d.invalidated_by),
      fleet_econ_text(a, 'nextAction', 300, true), v_corr)
    RETURNING * INTO n;
  PERFORM fleet_event('decision_corrected', p_agent, p_agent, jsonb_build_object('key', d.decision_key, 'revision', n.revision));
  RETURN jsonb_build_object('ok', true, 'decision', fleet_decision_json(n));
END $$;

CREATE FUNCTION fleet_econ_decision_list(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_limit integer := COALESCE(fleet_econ_int(a, 'limit', 1, 20), 10)::integer;
BEGIN
  RETURN jsonb_build_object('ok', true, 'decisions', COALESCE((SELECT jsonb_agg(fleet_decision_json(d) ORDER BY d.created_at DESC) FROM (
    SELECT DISTINCT ON (decision_key) * FROM fleet_decision_records WHERE agent_id = p_agent ORDER BY decision_key, revision DESC) d
    WHERE (NOT (a ? 'pending') OR (d.outcome_status = 'pending') = (a ->> 'pending')::boolean)
    LIMIT v_limit), '[]'::jsonb));
END $$;

-- ═══ 12. Knowledge ═══
CREATE FUNCTION fleet_econ_knowledge_record(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_topic text := fleet_econ_text(a, 'topic', 30, true); v_subject text := lower(btrim(a ->> 'subject')); k fleet_economic_knowledge;
        v_venture uuid; p fleet_economy_policy;
BEGIN
  PERFORM fleet_econ_failsafe_records(p_agent);
  SELECT * INTO p FROM fleet_economy_policy WHERE id = 1;
  IF v_topic NOT IN ('niche','product','channel','pricing','conversion','vendor','manufacturer','demand','acquisition','assumption_failed',
                     'assumption_succeeded','launch_result','operational_cost') THEN
    PERFORM fleet_econ_bad('topic is niche, product, channel, pricing, conversion, vendor, manufacturer, demand, acquisition, assumption_failed, assumption_succeeded, launch_result or operational_cost');
  END IF;
  IF v_subject IS NULL OR v_subject !~ '^[a-z0-9][a-z0-9 ._/-]{1,79}$' THEN PERFORM fleet_econ_bad('subject is a short lowercase key (e.g. "etsy/printables")'); END IF;
  IF a ? 'ventureKey' THEN
    SELECT venture_id INTO v_venture FROM fleet_ventures WHERE agent_id = p_agent AND venture_key = fleet_econ_key(a, 'ventureKey');
  END IF;
  -- The newest entry on the same subject supersedes this agent's older one (nothing is deleted).
  UPDATE fleet_economic_knowledge SET superseded_at = now() WHERE agent_id = p_agent AND topic = v_topic AND subject = v_subject AND superseded_at IS NULL;
  INSERT INTO fleet_economic_knowledge (knowledge_id, agent_id, topic, subject, claim, evidence, venture_id, confidence_bp, observed_at, expires_at)
    VALUES (gen_random_uuid(), p_agent, v_topic, v_subject, fleet_econ_text(a, 'claim', 600, true), fleet_econ_evidence(a, 'evidence', 8), v_venture,
            fleet_econ_int(a, 'confidenceBp', 0, 10000)::integer, now(), now() + make_interval(days => p.knowledge_fresh_days))
    RETURNING * INTO k;
  PERFORM fleet_event('knowledge_recorded', p_agent, p_agent, jsonb_build_object('topic', v_topic, 'subject', v_subject));
  RETURN jsonb_build_object('ok', true, 'knowledgeId', k.knowledge_id);
END $$;

-- Search: the agent's own fresh entries plus fleet entries backed by a ledger-measured outcome. Bounded, compact.
CREATE FUNCTION fleet_econ_knowledge_search(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_topic text := fleet_econ_text(a, 'topic', 30); v_q text := lower(fleet_econ_text(a, 'query', 80)); v_limit integer := COALESCE(fleet_econ_int(a, 'limit', 1, 10), 5)::integer;
BEGIN
  IF v_topic IS NULL AND v_q IS NULL THEN PERFORM fleet_econ_bad('search by topic and/or query (the exact fact you need)'); END IF;
  RETURN jsonb_build_object('ok', true, 'knowledge', COALESCE((SELECT jsonb_agg(x ORDER BY ord) FROM (
    SELECT jsonb_strip_nulls(jsonb_build_object('topic', k.topic, 'subject', k.subject, 'claim', k.claim, 'outcomeBacked', k.outcome_backed,
             'own', k.agent_id = p_agent, 'confidenceBp', k.confidence_bp, 'observedAt', k.observed_at, 'evidenceItems', jsonb_array_length(k.evidence))) AS x,
           row_number() OVER (ORDER BY k.outcome_backed DESC, k.observed_at DESC) AS ord
      FROM fleet_economic_knowledge k
     WHERE k.superseded_at IS NULL AND k.expires_at > now() AND (k.agent_id = p_agent OR k.outcome_backed)
       AND (v_topic IS NULL OR k.topic = v_topic)
       AND (v_q IS NULL OR position(v_q IN k.subject) > 0 OR position(v_q IN lower(k.claim)) > 0)
     ORDER BY k.outcome_backed DESC, k.observed_at DESC LIMIT v_limit) y), '[]'::jsonb));
END $$;

-- ═══ 13. Performance: the agent's own record (input to its judgement; read by no decision about its own capital) ═══
CREATE FUNCTION fleet_agent_performance(p_agent text) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  WITH p AS (SELECT forecast_tolerance_bp AS tol FROM fleet_economy_policy WHERE id = 1),
  d AS (SELECT * FROM fleet_decision_records WHERE agent_id = p_agent),
  m AS (SELECT * FROM d WHERE outcome_status = 'measured'),
  fc AS (SELECT count(*) FILTER (WHERE revenue_error_bp IS NOT NULL) AS n_rev,
                round(avg(abs(revenue_error_bp)) FILTER (WHERE revenue_error_bp IS NOT NULL))::integer AS mae_rev,
                round(avg(revenue_error_bp) FILTER (WHERE revenue_error_bp IS NOT NULL))::integer AS bias_rev,
                count(*) FILTER (WHERE abs(revenue_error_bp) <= (SELECT tol FROM p)) AS within_rev,
                round(avg(abs(cost_error_bp)) FILTER (WHERE cost_error_bp IS NOT NULL))::integer AS mae_cost,
                count(*) FILTER (WHERE outcome_source = 'ledger') AS ledger_backed
           FROM m),
  v AS (SELECT state, fleet_venture_financials(venture_id) AS f FROM fleet_ventures WHERE agent_id = p_agent),
  vs AS (SELECT count(*) FILTER (WHERE state IN ('operating','scaling','launching','building','selected','validating','researching','discovered','pivoting','paused')) AS active,
                count(*) FILTER (WHERE state = 'failed' OR (state = 'closed' AND (f ->> 'netProfitMinor')::bigint <= 0)) AS failed,
                count(*) FILTER (WHERE (state IN ('operating','scaling') OR state = 'closed') AND (f ->> 'netProfitMinor')::bigint > 0) AS profitable,
                count(*) FILTER (WHERE state IN ('operating','scaling','closed','failed') OR (f ->> 'revenueMinor')::bigint > 0) AS launched
           FROM v),
  conv AS (SELECT sum(value) FILTER (WHERE metric = 'conversions') AS c, sum(value) FILTER (WHERE metric = 'visits') AS vis FROM (
             SELECT DISTINCT ON (venture_id, metric) metric, value FROM fleet_venture_metrics WHERE agent_id = p_agent ORDER BY venture_id, metric, seq DESC) x),
  e AS (SELECT fleet_agent_economics(p_agent) AS eco)
  SELECT jsonb_build_object(
    'decisions', jsonb_build_object('recorded', (SELECT count(DISTINCT decision_key) FROM d), 'measured', (SELECT count(*) FROM m),
                  'corrected', (SELECT count(*) FROM d WHERE revision > 1), 'ledgerBacked', fc.ledger_backed),
    'forecast', jsonb_strip_nulls(jsonb_build_object('measured', fc.n_rev, 'revenueMeanAbsErrorBp', fc.mae_rev, 'revenueBiasBp', fc.bias_rev,
                  'withinToleranceBp', CASE WHEN fc.n_rev > 0 THEN (fc.within_rev * 10000 / fc.n_rev)::integer END,
                  'toleranceBp', (SELECT tol FROM p), 'costMeanAbsErrorBp', fc.mae_cost)),
    'ventures', jsonb_build_object('active', vs.active, 'launched', vs.launched, 'profitable', vs.profitable, 'failed', vs.failed),
    'realized', jsonb_strip_nulls(jsonb_build_object('revenueMinor', (e.eco ->> 'externalCustomerRevenue')::bigint,
                  'costsMinor', (e.eco ->> 'expenses')::bigint + (e.eco ->> 'fees')::bigint, 'netProfitMinor', (e.eco ->> 'realizedNetProfit')::bigint,
                  'roiBp', CASE WHEN (e.eco ->> 'expenses')::bigint + (e.eco ->> 'fees')::bigint > 0
                                THEN ((e.eco ->> 'realizedNetProfit')::bigint * 10000 / ((e.eco ->> 'expenses')::bigint + (e.eco ->> 'fees')::bigint)) END,
                  'capitalEfficiencyBp', CASE WHEN (e.eco ->> 'expenses')::bigint + (e.eco ->> 'fees')::bigint > 0
                                THEN ((e.eco ->> 'externalCustomerRevenue')::bigint * 10000 / ((e.eco ->> 'expenses')::bigint + (e.eco ->> 'fees')::bigint)) END)),
    'conversionBp', CASE WHEN COALESCE(conv.vis, 0) > 0 THEN (conv.c * 10000 / conv.vis)::integer END,
    'note', 'Your own record, for your own judgement. FleetController never uses it to approve or limit your own capital.')
  FROM fc, vs, conv, e
$$;

-- ═══ 14. The agent entry point ═══
CREATE FUNCTION api_economy(p_agent text, p_token text, p_op text, p_args jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text; v_class text; a jsonb := COALESCE(p_args, '{}'::jsonb);
BEGIN
  v_class := CASE p_op
    WHEN 'opportunity.record' THEN 'planning' WHEN 'opportunity.shortlist' THEN 'planning' WHEN 'opportunity.status' THEN 'planning'
    WHEN 'opportunity.list' THEN 'planning'
    WHEN 'venture.create' THEN 'planning' WHEN 'venture.transition' THEN 'planning' WHEN 'venture.status' THEN 'planning'
    WHEN 'venture.list' THEN 'planning' WHEN 'venture.metric' THEN 'planning'
    WHEN 'decision.record' THEN 'planning' WHEN 'decision.outcome' THEN 'planning' WHEN 'decision.correct' THEN 'planning'
    WHEN 'decision.list' THEN 'planning'
    WHEN 'knowledge.record' THEN 'planning' WHEN 'knowledge.search' THEN 'knowledge.read'
    WHEN 'performance' THEN 'ledger.read'
  END;
  IF v_class IS NULL OR p_op IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_UNKNOWN_OPERATION'); END IF;
  v_code := fleet_authenticate(p_agent, p_token, 'economy:' || p_op);
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  IF NOT fleet_agent_can(p_agent, v_class) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CAPABILITY_DENIED'); END IF;
  IF jsonb_typeof(a) <> 'object' OR length(a::text) > 32000 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'arguments are a JSON object (<= 32 kB)'); END IF;
  BEGIN
    RETURN CASE p_op
      WHEN 'opportunity.record' THEN fleet_econ_opportunity_record(p_agent, a)
      WHEN 'opportunity.shortlist' THEN fleet_econ_opportunity_shortlist(p_agent, a)
      WHEN 'opportunity.status' THEN fleet_econ_opportunity_status(p_agent, a)
      WHEN 'opportunity.list' THEN fleet_econ_opportunity_list(p_agent, a)
      WHEN 'venture.create' THEN fleet_econ_venture_create(p_agent, a)
      WHEN 'venture.transition' THEN fleet_econ_venture_transition(p_agent, a)
      WHEN 'venture.status' THEN (SELECT CASE WHEN v.venture_id IS NULL THEN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND')
                                              ELSE jsonb_build_object('ok', true, 'venture', fleet_venture_json(v, true)) END
                                    FROM (SELECT 1) one LEFT JOIN fleet_ventures v ON v.agent_id = p_agent AND v.venture_key = fleet_econ_key(a, 'key'))
      WHEN 'venture.list' THEN jsonb_build_object('ok', true, 'ventures', COALESCE((SELECT jsonb_agg(fleet_venture_json(v) ORDER BY v.updated_at DESC)
                                 FROM fleet_ventures v WHERE v.agent_id = p_agent AND (COALESCE((a ->> 'includeClosed')::boolean, false) OR v.state NOT IN ('closed'))), '[]'::jsonb))
      WHEN 'venture.metric' THEN fleet_econ_venture_metric(p_agent, a)
      WHEN 'decision.record' THEN fleet_econ_decision_record(p_agent, a)
      WHEN 'decision.outcome' THEN fleet_econ_decision_outcome(p_agent, a)
      WHEN 'decision.correct' THEN fleet_econ_decision_correct(p_agent, a)
      WHEN 'decision.list' THEN fleet_econ_decision_list(p_agent, a)
      WHEN 'knowledge.record' THEN fleet_econ_knowledge_record(p_agent, a)
      WHEN 'knowledge.search' THEN fleet_econ_knowledge_search(p_agent, a)
      WHEN 'performance' THEN jsonb_build_object('ok', true, 'performance', fleet_agent_performance(p_agent))
    END;
  EXCEPTION
    WHEN raise_exception THEN
      -- Only the registry's own validation and failsafe refusals are answered; anything else is a fault and raises.
      IF SQLERRM ~ '^FLEET_(BAD_REQUEST|INFRASTRUCTURE_CEILING|VENTURE_[A-Z]+|IMMUTABLE|INVALID_STATE|ATTRIBUTION_SCOPE):' THEN
        -- The refused operation rolled back; a failsafe hit is still recorded (telemetry, never shown to the agent as a budget).
        IF SQLERRM ~ '^FLEET_INFRASTRUCTURE_CEILING:' THEN
          PERFORM fleet_event('economy_failsafe', p_agent, 'controller', jsonb_build_object('op', p_op));
        END IF;
        RETURN jsonb_build_object('ok', false, 'code', split_part(SQLERRM, ':', 1), 'reason', btrim(substr(SQLERRM, position(':' IN SQLERRM) + 1)));
      END IF;
      RAISE;
    WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'a value has the wrong format');
  END;
END $$;

-- ═══ 15. Owner/admin attribution of an existing journal to a venture (corrections of history; audited) ═══
CREATE FUNCTION fleet_admin_venture_attribute(p_journal uuid, p_venture uuid, p_category text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_ledger_journal;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  SELECT * INTO j FROM fleet_ledger_journal WHERE journal_id = p_journal;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such journal'; END IF;
  INSERT INTO fleet_venture_journals (journal_id, venture_id, agent_id, cost_category, attributed_by) VALUES (p_journal, p_venture, j.agent_id, p_category, p_actor);
  PERFORM fleet_event('venture_attribution', j.agent_id, p_actor, jsonb_build_object('journalId', p_journal, 'ventureId', p_venture, 'category', p_category));
  RETURN jsonb_build_object('ok', true, 'financials', fleet_venture_financials(p_venture));
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
