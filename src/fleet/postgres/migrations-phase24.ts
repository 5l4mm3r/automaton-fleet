/**
 * Schema v24 — R24 Opportunity → Experiment pipeline (FINANCIALLY INERT).
 *
 *   Opportunity → Evidence → Hypothesis → Experiment proposal → Capital/risk decision → Bounded experiment
 *     → Measured result → Strategy Registry / failure knowledge
 *
 * Tables (all append-only history; state changes only through the functions below):
 *   fleet_experiment_policy       singleton: pipeline switch (default OFF), financial mode pinned 'simulated' by CHECK,
 *                                 hard cap, TTLs, active-experiment limit
 *   fleet_evidence_ladder         E0..E4: what each evidence level means and the auto-approval cap (policy DATA)
 *   fleet_experiments             one proposal each; immutable proposal fields; audited state machine
 *   fleet_experiment_transitions  every state change: from, to, actor, actor kind, code, reason, evidence
 *   fleet_experiment_events       simulated spend, observations (founder claim / evidence-linked / controller-recorded),
 *                                 evidence additions and result claims; idempotent per experiment
 *   fleet_experiment_results      the ONE authoritative result per concluded experiment (controller/owner; immutable)
 *   fleet_strategy_registry       what the fleet has learned per opportunity, successes AND failures (immutable)
 *
 * Authority
 *   - A founder proposes, adds evidence, starts an approved experiment, records simulated steps and observations, and
 *     may submit a result CLAIM (kept, labelled unverified). It never approves, sizes its budget, concludes, scores ROI,
 *     edits a result or changes any policy/ladder row.
 *   - FleetController decides deterministically at submission (fleet_experiment_evaluate); the owner may decide what
 *     policy leaves to the owner, stop an experiment, record controller observations and conclude.
 *   - The evidence level used for decisions is the level the registry VERIFIES — never the founder's claim. PROVENANCE
 *     (this founder really fetched this unaltered page) and RELEVANCE (the page supports this proposal) are separate:
 *     provenance alone never elevates an opportunity. Relevance is judged per evidence item by FleetController's
 *     independent assessor (never the founder) against a bounded, sanitized evidence artifact preserved at fetch time
 *     (fleet_research_evidence_artifacts); verdicts relevant / irrelevant / uncertain are immutable, cite the artifact,
 *     and a 'relevant' verdict must quote the artifact verbatim (checked here). 'uncertain' never earns a level and
 *     keeps the proposal on WATCH. The owner may override (audited), but ordinary evidence never waits for the owner.
 *   - E4 needs external revenue attributed to the SAME opportunity lineage: a ledger revenue journal the owner linked to a
 *     concluded experiment of this founder on this opportunity (fleet_opportunity_revenue_attributions). Generic revenue
 *     of the founder is not evidence for any particular opportunity.
 *   - ROI here is SIMULATED and NON-AUTHORITATIVE: its spend is founder-reported. It is recorded for learning only and
 *     read by no decision (capital, evidence level, confidence, reproduction, ranking); the privilege audit enforces that
 *     only the recording/reporting functions reference it. Authoritative ROI needs ledger-backed spend (future phase).
 *   - Caps (hard cap, ladder auto caps) are SIMULATION-ONLY values, not approved real-money limits (cap_scope CHECK).
 *
 * Financial mode: 'simulated' is pinned by a CHECK constraint. Budgets and spends are simulated numbers on the
 * experiment; no function here posts a journal, creates a payment order or issues a payment instruction.
 * Cognition routing is untouched: nothing here reads or writes routing tables, and the router has no input for it.
 */

export const V24_SQL = `
-- ═══ 1. Policy data ═══
CREATE TABLE fleet_experiment_policy (
  id                     smallint    PRIMARY KEY CHECK (id = 1),
  enabled                boolean     NOT NULL DEFAULT false,
  financial_mode         text        NOT NULL DEFAULT 'simulated' CHECK (financial_mode = 'simulated'),
  hard_cap_minor         bigint      NOT NULL DEFAULT 5000 CHECK (hard_cap_minor BETWEEN 0 AND 1000000),
  max_proposal_ttl_s     integer     NOT NULL DEFAULT 1209600 CHECK (max_proposal_ttl_s BETWEEN 3600 AND 7776000),
  approval_ttl_s         integer     NOT NULL DEFAULT 604800 CHECK (approval_ttl_s BETWEEN 600 AND 7776000),
  max_run_s              integer     NOT NULL DEFAULT 2592000 CHECK (max_run_s BETWEEN 3600 AND 15552000),
  max_active_per_founder integer     NOT NULL DEFAULT 3 CHECK (max_active_per_founder BETWEEN 1 AND 20),
  -- Controller relevance-assessor inference budget (calls per rolling hour, fleet-wide).
  relevance_max_calls_per_hour integer NOT NULL DEFAULT 60 CHECK (relevance_max_calls_per_hour BETWEEN 0 AND 1000),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             text        NOT NULL DEFAULT 'migration'
);
INSERT INTO fleet_experiment_policy (id) VALUES (1);
CREATE TRIGGER fleet_experiment_policy_no_delete BEFORE DELETE OR TRUNCATE ON fleet_experiment_policy
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
COMMENT ON COLUMN fleet_experiment_policy.hard_cap_minor IS 'R24 simulation-only cap (simulated minor units); not an approved real-money limit';

-- Evidence Ladder (R24 definition; levels are computed by the registry, never taken from the founder).
-- Only evidence items whose provenance is verified AND whose relevance the owner assessed as relevant count.
CREATE TABLE fleet_evidence_ladder (
  level          smallint    PRIMARY KEY CHECK (level BETWEEN 0 AND 4),
  code           text        NOT NULL UNIQUE CHECK (code ~ '^[a-z_]{3,40}$'),
  description    text        NOT NULL,
  auto_cap_minor bigint      CHECK (auto_cap_minor IS NULL OR auto_cap_minor >= 0),
  cap_scope      text        NOT NULL DEFAULT 'simulation_only' CHECK (cap_scope = 'simulation_only'),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     text        NOT NULL DEFAULT 'migration'
);
COMMENT ON COLUMN fleet_evidence_ladder.auto_cap_minor IS 'R24 simulation-only auto-approval cap; not an approved real-money limit';
INSERT INTO fleet_evidence_ladder (level, code, description, auto_cap_minor) VALUES
  (0, 'claim',             'the founder''s assertion, or evidence with verified provenance but no assessed relevance',                    0),
  (1, 'desk_single',       'one hash-verified research page of this founder, assessed relevant to this proposal',                        300),
  (2, 'desk_corroborated', 'hash-verified pages from at least two distinct hosts, each assessed relevant to this proposal',              1000),
  (3, 'observed_signal',   'relevant desk evidence plus an earlier succeeded controller result of this founder on the same opportunity', 2500),
  (4, 'revenue',           'observed signal plus ledger revenue attributed to this opportunity''s experiment lineage; owner decides',   NULL);
CREATE TRIGGER fleet_evidence_ladder_no_delete BEFORE DELETE OR TRUNCATE ON fleet_evidence_ladder
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- Evidence artifacts: what the controller preserved of a fetched page for later relevance review — normalized,
-- redacted, bounded text (never the raw page), tied to the attempt, the page hash, the host and the fetch time.
CREATE TABLE fleet_research_evidence_artifacts (
  attempt_id       uuid        PRIMARY KEY REFERENCES fleet_research_results(attempt_id),
  agent_id         text        NOT NULL REFERENCES fleet_agents(agent_id),
  content_sha256   text        NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  host             text        NOT NULL CHECK (host ~ '^[a-z0-9.-]{1,253}$'),
  fetched_at       timestamptz NOT NULL,
  title            text        CHECK (length(title) <= 200),
  excerpt          text        NOT NULL CHECK (length(excerpt) BETWEEN 1 AND 6000),
  excerpt_sha256   text        NOT NULL CHECK (excerpt_sha256 ~ '^[0-9a-f]{64}$'),
  source_chars     integer     NOT NULL CHECK (source_chars >= 0),
  truncated        boolean     NOT NULL,
  redactions       integer     NOT NULL CHECK (redactions >= 0),
  artifact_version smallint    NOT NULL DEFAULT 1 CHECK (artifact_version = 1),
  recorded_at      timestamptz NOT NULL DEFAULT now()
);

-- ═══ 2. Experiments and their history ═══
CREATE TABLE fleet_experiments (
  seq                  bigserial   UNIQUE,
  experiment_id        uuid        PRIMARY KEY,
  agent_id             text        NOT NULL REFERENCES fleet_agents(agent_id),
  idempotency_key      text        NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_.-]{8,128}$'),
  request_sha256       text        NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  opportunity_key      text        NOT NULL CHECK (opportunity_key ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  proposal             jsonb       NOT NULL CHECK (length(proposal::text) <= 32768),
  claimed_level        smallint    NOT NULL CHECK (claimed_level BETWEEN 0 AND 4),
  verified_level       smallint    NOT NULL CHECK (verified_level BETWEEN 0 AND 4),
  verified_evidence    jsonb       NOT NULL,
  requested_minor      bigint      NOT NULL CHECK (requested_minor BETWEEN 0 AND 1000000000),
  max_loss_minor       bigint      NOT NULL CHECK (max_loss_minor >= 0),
  reversibility        text        NOT NULL CHECK (reversibility IN ('reversible','partially_reversible','irreversible')),
  time_to_signal_s     integer     NOT NULL CHECK (time_to_signal_s > 0),
  expires_at           timestamptz NOT NULL,
  status               text        NOT NULL CHECK (status IN ('proposed','watch','rejected','partially_approved','approved','running',
                                                              'stopped','succeeded','failed','expired')),
  approved_minor       bigint      CHECK (approved_minor >= 0),
  approved_max_loss_minor bigint   CHECK (approved_max_loss_minor >= 0),
  approval_expires_at  timestamptz,
  decided_by           text,
  decision_code        text        CHECK (decision_code ~ '^FLEET_[A-Z_]{2,48}$'),
  decision_reason      text        CHECK (length(decision_reason) <= 300),
  started_at           timestamptz,
  run_deadline         timestamptz,
  ended_at             timestamptz,
  sim_spent_minor      bigint      NOT NULL DEFAULT 0 CHECK (sim_spent_minor >= 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, idempotency_key),
  CHECK (max_loss_minor <= requested_minor),
  CHECK (approved_minor IS NULL OR approved_minor <= requested_minor),
  CHECK (approved_max_loss_minor IS NULL OR approved_max_loss_minor <= approved_minor),
  CHECK (status NOT IN ('approved','partially_approved','running','stopped','succeeded','failed') OR approved_minor IS NOT NULL),
  CHECK (status NOT IN ('running') OR (started_at IS NOT NULL AND run_deadline IS NOT NULL)),
  CHECK (sim_spent_minor <= COALESCE(approved_minor, 0))
);
CREATE INDEX fleet_experiments_agent_idx ON fleet_experiments (agent_id, seq);
CREATE INDEX fleet_experiments_open_idx ON fleet_experiments (status, expires_at) WHERE status IN ('proposed','watch','approved','partially_approved','running');

CREATE TABLE fleet_experiment_transitions (
  seq           bigserial   PRIMARY KEY,
  experiment_id uuid        NOT NULL REFERENCES fleet_experiments(experiment_id),
  from_status   text,
  to_status     text        NOT NULL,
  actor         text        NOT NULL CHECK (length(actor) BETWEEN 3 AND 128),
  actor_kind    text        NOT NULL CHECK (actor_kind IN ('founder','controller','owner')),
  code          text        NOT NULL CHECK (code ~ '^FLEET_[A-Z_]{2,48}$'),
  reason        text        CHECK (length(reason) <= 300),
  evidence      jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (length(evidence::text) <= 8192),
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_experiment_transitions_exp_idx ON fleet_experiment_transitions (experiment_id, seq);

CREATE TABLE fleet_experiment_events (
  seq             bigserial   PRIMARY KEY,
  experiment_id   uuid        NOT NULL REFERENCES fleet_experiments(experiment_id),
  idempotency_key text        NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_.-]{8,128}$'),
  request_sha256  text        NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  kind            text        NOT NULL CHECK (kind IN ('sim_spend','observation','step','evidence_added','result_claim')),
  amount_minor    bigint      CHECK (amount_minor > 0),
  metric          text        CHECK (metric ~ '^[a-z][a-z0-9_]{1,39}$'),
  value           numeric     CHECK (value IS NULL OR abs(value) < 1e15),
  verification    text        NOT NULL CHECK (verification IN ('founder_claim','evidence_linked','controller_recorded')),
  attempt_id      uuid,
  note            text        CHECK (length(note) <= 600),
  detail          jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (length(detail::text) <= 8192),
  actor           text        NOT NULL,
  at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, idempotency_key),
  CHECK ((kind = 'sim_spend') = (amount_minor IS NOT NULL)),
  CHECK (kind <> 'observation' OR (metric IS NOT NULL AND value IS NOT NULL)),
  CHECK (verification <> 'evidence_linked' OR attempt_id IS NOT NULL)
);

CREATE TABLE fleet_experiment_results (
  experiment_id        uuid        PRIMARY KEY REFERENCES fleet_experiments(experiment_id),
  outcome              text        NOT NULL CHECK (outcome IN ('succeeded','failed','stopped')),
  actual_spend_minor   bigint      NOT NULL CHECK (actual_spend_minor >= 0),
  elapsed_s            integer     NOT NULL CHECK (elapsed_s >= 0),
  criteria             jsonb       NOT NULL,
  evidence             jsonb       NOT NULL,
  simulated_revenue_minor bigint   NOT NULL DEFAULT 0 CHECK (simulated_revenue_minor >= 0),
  -- Founder-reported simulated spend: this ROI is for learning only and never an input to a decision.
  simulated_roi        numeric,
  roi_authority        text        NOT NULL DEFAULT 'simulated_non_authoritative' CHECK (roi_authority = 'simulated_non_authoritative'),
  spend_source         text        NOT NULL DEFAULT 'founder_reported_simulated' CHECK (spend_source = 'founder_reported_simulated'),
  discrepancies        jsonb       NOT NULL,
  lessons              text        NOT NULL CHECK (length(lessons) BETWEEN 1 AND 2000),
  confidence_before    smallint    NOT NULL CHECK (confidence_before BETWEEN 0 AND 4),
  confidence_after     smallint    NOT NULL CHECK (confidence_after BETWEEN 0 AND 4),
  founder_claim        jsonb,
  concluded_by         text        NOT NULL,
  concluded_kind       text        NOT NULL CHECK (concluded_kind IN ('controller','owner')),
  financial_mode       text        NOT NULL CHECK (financial_mode = 'simulated'),
  concluded_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fleet_strategy_registry (
  seq                   bigserial   PRIMARY KEY,
  agent_id              text        NOT NULL REFERENCES fleet_agents(agent_id),
  opportunity_key       text        NOT NULL,
  experiment_id         uuid        NOT NULL UNIQUE REFERENCES fleet_experiment_results(experiment_id),
  outcome               text        NOT NULL CHECK (outcome IN ('succeeded','failed','stopped')),
  evidence_level        smallint    NOT NULL,
  actual_spend_minor    bigint      NOT NULL,
  simulated_revenue_minor bigint    NOT NULL,
  simulated_roi         numeric,
  roi_authority         text        NOT NULL DEFAULT 'simulated_non_authoritative' CHECK (roi_authority = 'simulated_non_authoritative'),
  lessons               text        NOT NULL,
  confidence_after      smallint    NOT NULL,
  knowledge_proposal_id uuid        REFERENCES fleet_knowledge_proposals(proposal_id),
  financial_mode        text        NOT NULL CHECK (financial_mode = 'simulated'),
  recorded_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_strategy_registry_opp_idx ON fleet_strategy_registry (agent_id, opportunity_key, seq);

-- Relevance, separate from provenance: one verified evidence item of one proposal, judged by FleetController's independent
-- assessor (T0 software checks, then T2, T3 only when ambiguous/conflicting or consequential) against the evidence
-- artifact, with the artifact reference and the quotes that justify it. The owner may add ONE audited override per
-- item; the effective verdict is the override if present, else the controller's. Rows never change.
CREATE TABLE fleet_experiment_relevance (
  seq             bigserial   PRIMARY KEY,
  experiment_id   uuid        NOT NULL REFERENCES fleet_experiments(experiment_id),
  attempt_id      uuid        NOT NULL REFERENCES fleet_research_attempts(attempt_id),
  content_sha256  text        NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  supports        text        NOT NULL,
  verdict         text        NOT NULL CHECK (verdict IN ('relevant','irrelevant','uncertain')),
  assessed_by     text        NOT NULL CHECK (assessed_by = 'controller' OR assessed_by ~ '^operator:[A-Za-z0-9._-]{1,64}$'),
  assessor_kind   text        NOT NULL CHECK (assessor_kind IN ('controller','owner')),
  tier            text        CHECK (tier IN ('T0','T1','T2','T3')),
  artifact_excerpt_sha256 text CHECK (artifact_excerpt_sha256 ~ '^[0-9a-f]{64}$'),
  refs            jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (length(refs::text) <= 4096),
  cognition       jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(cognition) = 'array' AND length(cognition::text) <= 8192),
  overrides       text        CHECK (overrides IN ('relevant','irrelevant','uncertain')),
  reason          text        NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, attempt_id, assessor_kind),
  CHECK ((assessor_kind = 'controller') = (assessed_by = 'controller')),
  CHECK ((assessor_kind = 'controller') = (tier IS NOT NULL)),
  CHECK (assessor_kind = 'owner' OR verdict <> 'relevant' OR artifact_excerpt_sha256 IS NOT NULL)
);
CREATE INDEX fleet_experiment_relevance_at_idx ON fleet_experiment_relevance (assessor_kind, at);

-- Every relevance-assessor model call, answered or failed: nothing the provider may have billed disappears. A known
-- cost is also provider-credit consumption; a failure the provider did not bill is known zero ('none'); anything else
-- is 'unknown_reconciliation_required' (with the upper-bound estimate) until the owner records the actual cost
-- (fleet_relevance_call_reconcile: a consumption event carrying this request id).
CREATE TABLE fleet_relevance_calls (
  request_id      uuid        PRIMARY KEY,
  experiment_id   uuid        REFERENCES fleet_experiments(experiment_id),
  attempt_id      uuid,
  provider        text        NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  tier            text        NOT NULL CHECK (tier IN ('T1','T2','T3')),
  model           text        NOT NULL CHECK (model ~ '^[A-Za-z0-9._:/@-]{1,120}$'),
  outcome         text        NOT NULL CHECK (outcome IN ('ok','failed')),
  error_code      text        CHECK (error_code ~ '^[A-Z_]{2,64}$'),
  charge          text        NOT NULL CHECK (charge IN ('usage','none','unknown')),
  input_tokens    bigint      CHECK (input_tokens >= 0),
  output_tokens   bigint      CHECK (output_tokens >= 0),
  usd_microcents  bigint      CHECK (usd_microcents >= 0),
  estimate_usd_microcents bigint CHECK (estimate_usd_microcents >= 0),
  cost_status     text        NOT NULL CHECK (cost_status IN ('known','none','unknown_reconciliation_required')),
  at              timestamptz NOT NULL DEFAULT now(),
  CHECK ((cost_status = 'known') = (usd_microcents IS NOT NULL)),
  CHECK ((outcome = 'failed') = (error_code IS NOT NULL)),
  CHECK (outcome = 'failed' OR cost_status = 'known'),
  CHECK (cost_status <> 'none' OR charge = 'none'),
  CHECK (cost_status <> 'unknown_reconciliation_required' OR charge = 'unknown')
);
CREATE INDEX fleet_relevance_calls_at_idx ON fleet_relevance_calls (at);

-- E4 lineage: realized ledger revenue attributed to a concluded experiment of the same founder and opportunity. Each
-- revenue journal is attributable once; a reversed journal stops counting.
CREATE TABLE fleet_opportunity_revenue_attributions (
  seq             bigserial   PRIMARY KEY,
  journal_id      uuid        NOT NULL UNIQUE REFERENCES fleet_ledger_journal(journal_id),
  agent_id        text        NOT NULL REFERENCES fleet_agents(agent_id),
  opportunity_key text        NOT NULL,
  experiment_id   uuid        NOT NULL REFERENCES fleet_experiment_results(experiment_id),
  amount_minor    bigint      NOT NULL CHECK (amount_minor > 0),
  attributed_by   text        NOT NULL CHECK (attributed_by ~ '^operator:[A-Za-z0-9._-]{1,64}$'),
  reason          text        NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_opportunity_revenue_opp_idx ON fleet_opportunity_revenue_attributions (agent_id, opportunity_key);

-- Guards: every table changes only inside an experiment operation; proposal fields never change; the state machine.
CREATE FUNCTION fleet_experiments_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_fixed text[] := ARRAY['seq','experiment_id','agent_id','idempotency_key','request_sha256','opportunity_key','proposal','claimed_level',
                                'requested_minor','max_loss_minor','reversibility','time_to_signal_s','expires_at','created_at'];
BEGIN
  IF COALESCE(current_setting('fleet.experiment_op', true), '') = '' THEN
    RAISE EXCEPTION 'FLEET_EXPERIMENT_OP_REQUIRED: experiments change only through the experiment functions';
  END IF;
  IF TG_TABLE_NAME <> 'fleet_experiments' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'proposed' THEN RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: experiments start proposed'; END IF;
    RETURN NEW;
  END IF;
  IF (SELECT jsonb_object_agg(k, to_jsonb(NEW) -> k) FROM unnest(v_fixed) k) IS DISTINCT FROM (SELECT jsonb_object_agg(k, to_jsonb(OLD) -> k) FROM unnest(v_fixed) k) THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: an experiment proposal never changes';
  END IF;
  IF OLD.status IN ('rejected','stopped','succeeded','failed','expired') THEN
    RAISE EXCEPTION 'FLEET_TERMINAL_STATE_IMMUTABLE: experiment % is %', OLD.experiment_id, OLD.status;
  END IF;
  IF NEW.sim_spent_minor < OLD.sim_spent_minor THEN RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: spend never decreases'; END IF;
  IF OLD.approved_minor IS NOT NULL AND NEW.approved_minor IS DISTINCT FROM OLD.approved_minor THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: an approved budget never changes';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'proposed'           AND NEW.status IN ('watch','rejected','partially_approved','approved','expired'))
    OR (OLD.status = 'watch'              AND NEW.status IN ('proposed','rejected','partially_approved','approved','expired'))
    OR (OLD.status IN ('approved','partially_approved') AND NEW.status IN ('running','expired','rejected'))
    OR (OLD.status = 'running'            AND NEW.status IN ('stopped','succeeded','failed'))) THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: experiment % -> %', OLD.status, NEW.status;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('approved','partially_approved','watch','rejected') THEN
    IF NEW.decided_by IS NULL OR (NEW.decided_by <> 'controller' AND NEW.decided_by !~ '^operator:[A-Za-z0-9._-]{1,64}$') THEN
      RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: only the controller or the owner decides an experiment';
    END IF;
    IF NEW.decided_by <> 'controller' THEN PERFORM fleet_require_operator_approver(substr(NEW.decided_by, 10), NEW.agent_id); END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_experiments_guard BEFORE INSERT OR UPDATE ON fleet_experiments FOR EACH ROW EXECUTE FUNCTION fleet_experiments_guard();
CREATE TRIGGER fleet_experiments_no_delete BEFORE DELETE ON fleet_experiments FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_experiments_no_truncate BEFORE TRUNCATE ON fleet_experiments FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_experiment_transitions_guard BEFORE INSERT ON fleet_experiment_transitions FOR EACH ROW EXECUTE FUNCTION fleet_experiments_guard();
CREATE TRIGGER fleet_experiment_transitions_no_change BEFORE UPDATE OR DELETE ON fleet_experiment_transitions FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_experiment_transitions_no_truncate BEFORE TRUNCATE ON fleet_experiment_transitions FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_experiment_events_guard BEFORE INSERT ON fleet_experiment_events FOR EACH ROW EXECUTE FUNCTION fleet_experiments_guard();
CREATE TRIGGER fleet_experiment_events_no_change BEFORE UPDATE OR DELETE ON fleet_experiment_events FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_experiment_events_no_truncate BEFORE TRUNCATE ON fleet_experiment_events FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_experiment_results_guard BEFORE INSERT ON fleet_experiment_results FOR EACH ROW EXECUTE FUNCTION fleet_experiments_guard();
CREATE TRIGGER fleet_experiment_results_no_change BEFORE UPDATE OR DELETE ON fleet_experiment_results FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_experiment_results_no_truncate BEFORE TRUNCATE ON fleet_experiment_results FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_strategy_registry_guard BEFORE INSERT ON fleet_strategy_registry FOR EACH ROW EXECUTE FUNCTION fleet_experiments_guard();
CREATE TRIGGER fleet_strategy_registry_no_change BEFORE UPDATE OR DELETE ON fleet_strategy_registry FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_strategy_registry_no_truncate BEFORE TRUNCATE ON fleet_strategy_registry FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_relevance_calls_guard BEFORE INSERT ON fleet_relevance_calls FOR EACH ROW EXECUTE FUNCTION fleet_experiments_guard();
CREATE TRIGGER fleet_relevance_calls_no_change BEFORE UPDATE OR DELETE ON fleet_relevance_calls FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_relevance_calls_no_truncate BEFORE TRUNCATE ON fleet_relevance_calls FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_research_evidence_artifacts_guard BEFORE INSERT ON fleet_research_evidence_artifacts FOR EACH ROW EXECUTE FUNCTION fleet_experiments_guard();
CREATE TRIGGER fleet_research_evidence_artifacts_no_change BEFORE UPDATE OR DELETE ON fleet_research_evidence_artifacts FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_research_evidence_artifacts_no_truncate BEFORE TRUNCATE ON fleet_research_evidence_artifacts FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_experiment_relevance_guard BEFORE INSERT ON fleet_experiment_relevance FOR EACH ROW EXECUTE FUNCTION fleet_experiments_guard();
CREATE TRIGGER fleet_experiment_relevance_no_change BEFORE UPDATE OR DELETE ON fleet_experiment_relevance FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_experiment_relevance_no_truncate BEFORE TRUNCATE ON fleet_experiment_relevance FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_opportunity_revenue_guard BEFORE INSERT ON fleet_opportunity_revenue_attributions FOR EACH ROW EXECUTE FUNCTION fleet_experiments_guard();
CREATE TRIGGER fleet_opportunity_revenue_no_change BEFORE UPDATE OR DELETE ON fleet_opportunity_revenue_attributions FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_opportunity_revenue_no_truncate BEFORE TRUNCATE ON fleet_opportunity_revenue_attributions FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ═══ 3. Internal helpers (owner-only; never granted) ═══
CREATE FUNCTION fleet_experiment_begin() RETURNS void LANGUAGE sql SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT set_config('fleet.experiment_op', 'on', true)
$$;

-- Text a founder supplies must not carry secret-shaped material (credentials never enter experiment records).
CREATE FUNCTION fleet_secret_shaped(t text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(t, '') ~ '(f[as]1\\.[0-9A-HJKMNP-TV-Z]{26}\\.[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{32,}|0x[0-9a-fA-F]{64}|[a-zA-Z][a-zA-Z0-9+.-]*://[^[:space:]:@/]+:[^[:space:]@/]+@)'
$$;

CREATE FUNCTION fleet_experiment_transition(e fleet_experiments, p_to text, p_actor text, p_kind text, p_code text, p_reason text, p_evidence jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  INSERT INTO fleet_experiment_transitions (experiment_id, from_status, to_status, actor, actor_kind, code, reason, evidence)
    VALUES (e.experiment_id, CASE WHEN p_code = 'FLEET_EXPERIMENT_PROPOSED' THEN NULL ELSE e.status END, p_to, left(p_actor, 128), p_kind, p_code, left(p_reason, 300), COALESCE(p_evidence, '{}'::jsonb));
  PERFORM fleet_event('experiment_' || p_to, e.agent_id, left(p_actor, 128),
    jsonb_build_object('experimentId', e.experiment_id, 'from', CASE WHEN p_code = 'FLEET_EXPERIMENT_PROPOSED' THEN NULL ELSE e.status END, 'to', p_to, 'code', p_code, 'actorKind', p_kind));
END $$;

-- Verify the PROVENANCE of founder-supplied evidence against the registry's own research record. Each item also carries
-- the founder's relevance CLAIM (which element of the proposal it supports, and why); the claim is recorded, never
-- trusted: only the owner's assessment (fleet_experiment_relevance) makes an item count. Returns
-- {ok, items:[{attemptId, sha256, host, fetchedAt, supports, rationale}], hosts} or {ok:false, code, index}. Fail closed.
CREATE FUNCTION fleet_experiment_verify_evidence(p_agent text, p_items jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x jsonb; i integer := 0; a fleet_research_attempts; r fleet_research_results; v_items jsonb := '[]'::jsonb; v_hosts text[] := '{}'; v_seen uuid[] := '{}'; v_id uuid;
BEGIN
  IF p_items IS NULL THEN RETURN jsonb_build_object('ok', true, 'items', '[]'::jsonb, 'hosts', 0); END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) > 20 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_EVIDENCE_INVALID', 'index', -1); END IF;
  FOR x IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF jsonb_typeof(x) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(x) k WHERE k NOT IN ('attemptId','sha256','supports','rationale'))
       OR COALESCE(x ->> 'attemptId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR COALESCE(x ->> 'sha256', '') !~ '^[0-9a-f]{64}$'
       OR COALESCE(x ->> 'supports', '') NOT IN ('problem','demand','willingness_to_pay','channel','competition','feasibility','cost')
       OR length(COALESCE(x ->> 'rationale', '')) NOT BETWEEN 10 AND 300 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_EVIDENCE_INVALID', 'index', i);
    END IF;
    IF fleet_secret_shaped(x ->> 'rationale') THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_EVIDENCE_INVALID', 'index', i);
    END IF;
    v_id := (x ->> 'attemptId')::uuid;
    IF v_id = ANY (v_seen) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_EVIDENCE_DUPLICATE', 'index', i); END IF;
    v_seen := v_seen || v_id;
    SELECT * INTO a FROM fleet_research_attempts WHERE attempt_id = v_id;
    SELECT * INTO r FROM fleet_research_results WHERE attempt_id = v_id;
    -- Only this founder's own authorized, fetched page whose recorded hash is exactly the claimed one.
    IF a.attempt_id IS NULL OR a.agent_id <> p_agent OR a.decision <> 'authorized' OR r.attempt_id IS NULL OR r.outcome <> 'fetched'
       OR r.content_sha256 IS DISTINCT FROM x ->> 'sha256' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_EVIDENCE_UNVERIFIED', 'index', i);
    END IF;
    v_items := v_items || jsonb_build_array(jsonb_build_object('attemptId', v_id, 'sha256', r.content_sha256,
      'host', lower(COALESCE(substring(r.final_url FROM '^https://([^/:?#]+)'), a.requested_host)), 'fetchedAt', r.recorded_at,
      'supports', x ->> 'supports', 'rationale', left(fleet_scrub(x ->> 'rationale'), 300)));
    v_hosts := array_append(v_hosts, lower(COALESCE(substring(r.final_url FROM '^https://([^/:?#]+)'), a.requested_host)));
    i := i + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'items', v_items, 'hosts', (SELECT count(DISTINCT h) FROM unnest(v_hosts) h));
END $$;

-- Relevance of one proposal's provenance-verified evidence: {verified, relevant, irrelevant, uncertain, unassessed,
-- relevantHosts, overridden}. The effective verdict of an item is the owner's override if any, else the controller's;
-- a verdict counts only for the same page hash that verified the item's provenance.
CREATE FUNCTION fleet_experiment_relevant_evidence(p_exp uuid, p_verified jsonb) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'verified', count(*),
    'relevant', count(*) FILTER (WHERE v.verdict = 'relevant'),
    'irrelevant', count(*) FILTER (WHERE v.verdict = 'irrelevant'),
    'uncertain', count(*) FILTER (WHERE v.verdict = 'uncertain'),
    'unassessed', count(*) FILTER (WHERE v.verdict IS NULL),
    'relevantHosts', count(DISTINCT x ->> 'host') FILTER (WHERE v.verdict = 'relevant'),
    'overridden', count(*) FILTER (WHERE v.overridden))
  FROM jsonb_array_elements(COALESCE(p_verified -> 'items', '[]'::jsonb)) x
  CROSS JOIN LATERAL (
    SELECT (SELECT rv.verdict FROM fleet_experiment_relevance rv WHERE rv.experiment_id = p_exp AND rv.attempt_id = (x ->> 'attemptId')::uuid
              AND rv.content_sha256 = x ->> 'sha256' ORDER BY (rv.assessor_kind = 'owner') DESC LIMIT 1) AS verdict,
           EXISTS (SELECT 1 FROM fleet_experiment_relevance rv WHERE rv.experiment_id = p_exp AND rv.attempt_id = (x ->> 'attemptId')::uuid
              AND rv.assessor_kind = 'owner') AS overridden) v
$$;

-- The registry's evidence level: never the founder's claim, never provenance alone.
CREATE FUNCTION fleet_experiment_evidence_level(p_exp uuid, p_agent text, p_opportunity text, p_verified jsonb) RETURNS smallint LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE rel jsonb := fleet_experiment_relevant_evidence(p_exp, p_verified); n integer; h integer; l smallint := 0;
BEGIN
  n := (rel ->> 'relevant')::integer;
  h := (rel ->> 'relevantHosts')::integer;
  IF n >= 1 THEN l := 1; END IF;
  IF n >= 2 AND h >= 2 THEN l := 2; END IF;
  IF l >= 1 AND EXISTS (SELECT 1 FROM fleet_strategy_registry s WHERE s.agent_id = p_agent AND s.opportunity_key = p_opportunity AND s.outcome = 'succeeded') THEN
    l := 3;
    -- Revenue counts only when attributed to this founder's experiment lineage on this opportunity, and not reversed.
    IF EXISTS (SELECT 1 FROM fleet_opportunity_revenue_attributions ra
                WHERE ra.agent_id = p_agent AND ra.opportunity_key = p_opportunity
                  AND NOT EXISTS (SELECT 1 FROM fleet_ledger_journal rj WHERE rj.reverses_journal_id = ra.journal_id)) THEN
      l := 4;
    END IF;
  END IF;
  RETURN l;
END $$;

-- Deterministic capital/risk decision (FleetController). Inputs: the proposal, the verified level, policy, ladder and the
-- founder's authoritative economics. Never commercial-history scoring of cognition; never the founder's own labels.
CREATE FUNCTION fleet_experiment_evaluate(e fleet_experiments) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_experiment_policy; lad fleet_evidence_ladder; eco jsonb; v_committed bigint; v_head bigint; v_amt bigint; rel jsonb;
BEGIN
  SELECT * INTO p FROM fleet_experiment_policy WHERE id = 1;
  SELECT * INTO lad FROM fleet_evidence_ladder WHERE level = e.verified_level;
  IF e.requested_minor > p.hard_cap_minor THEN
    RETURN jsonb_build_object('decision', 'rejected', 'code', 'FLEET_EXPERIMENT_OVER_CAP', 'reason', format('requested %s above the hard cap %s', e.requested_minor, p.hard_cap_minor));
  END IF;
  -- The controller decides on a complete relevance record only: the order of the owner's assessments never sizes a budget.
  rel := fleet_experiment_relevant_evidence(e.experiment_id, e.verified_evidence);
  IF (rel ->> 'unassessed')::integer > 0 THEN
    RETURN jsonb_build_object('decision', 'watch', 'code', 'FLEET_RELEVANCE_PENDING',
      'reason', format('awaiting the controller''s relevance assessment of %s of %s provenance-verified item(s); provenance alone earns nothing (claimed E%s)',
        rel ->> 'unassessed', rel ->> 'verified', e.claimed_level));
  END IF;
  -- Uncertain evidence (ambiguous, conflicting, unverifiable, or without an artifact) never earns capital automatically:
  -- the proposal stays on WATCH through the controller's own path (more evidence, or an audited owner override).
  IF (rel ->> 'uncertain')::integer > 0 THEN
    RETURN jsonb_build_object('decision', 'watch', 'code', 'FLEET_EVIDENCE_UNCERTAIN',
      'reason', format('%s of %s cited item(s) assessed uncertain (ambiguous, conflicting or unverifiable); relevant %s: watching (claimed E%s)',
        rel ->> 'uncertain', rel ->> 'verified', rel ->> 'relevant', e.claimed_level));
  END IF;
  IF e.verified_level = 0 THEN
    RETURN jsonb_build_object('decision', 'watch', 'code', 'FLEET_EVIDENCE_INSUFFICIENT',
      'reason', format('no relevant verified evidence (claimed E%s, verified E0; provenance-verified %s, assessed relevant %s): watching',
        e.claimed_level, rel ->> 'verified', rel ->> 'relevant'));
  END IF;
  -- Never commit more than the founder could lose without touching protected capital (survival equity >= 0). An active
  -- experiment commits its whole approved maximum loss: founder-reported simulated spend never releases headroom.
  eco := fleet_agent_economics(e.agent_id);
  SELECT COALESCE(sum(COALESCE(approved_max_loss_minor, 0)), 0) INTO v_committed
    FROM fleet_experiments WHERE agent_id = e.agent_id AND status IN ('approved','partially_approved','running') AND experiment_id <> e.experiment_id;
  v_head := GREATEST(0, COALESCE((eco ->> 'expensePurchasingCapacity')::bigint, 0) - v_committed);
  IF e.max_loss_minor > 0 AND v_head = 0 THEN
    RETURN jsonb_build_object('decision', 'rejected', 'code', 'FLEET_PROTECTED_CAPITAL', 'reason', 'no headroom above protected capital and committed experiments');
  END IF;
  IF e.reversibility = 'irreversible' OR lad.auto_cap_minor IS NULL THEN
    RETURN jsonb_build_object('decision', 'proposed', 'code', 'FLEET_OWNER_DECISION_REQUIRED',
      'reason', CASE WHEN e.reversibility = 'irreversible' THEN 'irreversible experiments are decided by the owner' ELSE format('evidence level E%s is decided by the owner', e.verified_level) END);
  END IF;
  -- The budget is capped by the evidence level; the maximum loss (all a founder can spend) by the survival headroom.
  v_amt := LEAST(e.requested_minor, lad.auto_cap_minor);
  IF v_amt < e.requested_minor OR LEAST(e.max_loss_minor, v_amt, v_head) < e.max_loss_minor THEN
    RETURN jsonb_build_object('decision', 'partially_approved', 'code', 'FLEET_EXPERIMENT_PARTIAL', 'approvedMinor', v_amt, 'maxLossMinor', LEAST(e.max_loss_minor, v_amt, v_head),
      'reason', format('E%s cap %s, survival headroom %s: budget %s of %s, maximum loss %s of %s', e.verified_level, lad.auto_cap_minor, v_head, v_amt, e.requested_minor,
        LEAST(e.max_loss_minor, v_amt, v_head), e.max_loss_minor));
  END IF;
  RETURN jsonb_build_object('decision', 'approved', 'code', 'FLEET_EXPERIMENT_APPROVED', 'approvedMinor', e.requested_minor, 'maxLossMinor', e.max_loss_minor,
    'reason', format('E%s within cap %s and survival headroom %s', e.verified_level, lad.auto_cap_minor, v_head));
END $$;

CREATE FUNCTION fleet_experiment_apply(e fleet_experiments, d jsonb, p_actor text, p_kind text) RETURNS fleet_experiments LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_experiments; p fleet_experiment_policy;
BEGIN
  -- No change; or still awaiting the owner. A WATCHed proposal that now has the evidence but needs the owner's decision
  -- (irreversible, or an owner-only level) returns to the owner's queue (watch -> proposed).
  IF d ->> 'decision' = 'watch' AND e.status = 'watch' THEN
    -- Still watching: keep the controller's current reason on record (no state change, no transition).
    IF e.decision_code IS DISTINCT FROM d ->> 'code' THEN
      UPDATE fleet_experiments SET decision_code = d ->> 'code', decision_reason = left(d ->> 'reason', 300) WHERE experiment_id = e.experiment_id RETURNING * INTO r;
      RETURN r;
    END IF;
    RETURN e;
  END IF;
  IF d ->> 'decision' = e.status OR (d ->> 'decision' = 'proposed' AND e.status <> 'watch') THEN RETURN e; END IF;
  SELECT * INTO p FROM fleet_experiment_policy WHERE id = 1;
  PERFORM fleet_experiment_transition(e, d ->> 'decision', p_actor, p_kind, d ->> 'code', d ->> 'reason',
    jsonb_build_object('verifiedLevel', e.verified_level, 'claimedLevel', e.claimed_level, 'requestedMinor', e.requested_minor, 'approvedMinor', d -> 'approvedMinor'));
  UPDATE fleet_experiments SET status = d ->> 'decision', decided_by = CASE WHEN p_kind = 'controller' THEN 'controller' ELSE p_actor END,
         decision_code = d ->> 'code', decision_reason = left(d ->> 'reason', 300),
         approved_minor = CASE WHEN d ->> 'decision' IN ('approved','partially_approved') THEN (d ->> 'approvedMinor')::bigint END,
         approved_max_loss_minor = CASE WHEN d ->> 'decision' IN ('approved','partially_approved') THEN (d ->> 'maxLossMinor')::bigint END,
         approval_expires_at = CASE WHEN d ->> 'decision' IN ('approved','partially_approved') THEN LEAST(e.expires_at, now() + make_interval(secs => p.approval_ttl_s)) END
   WHERE experiment_id = e.experiment_id RETURNING * INTO r;
  RETURN r;
END $$;

CREATE FUNCTION fleet_experiment_json(e fleet_experiments) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('experimentId', e.experiment_id, 'opportunityKey', e.opportunity_key, 'status', e.status,
    'claimedLevel', e.claimed_level, 'verifiedLevel', e.verified_level, 'requestedMinor', e.requested_minor, 'maxLossMinor', e.max_loss_minor,
    'approvedMinor', e.approved_minor, 'approvedMaxLossMinor', e.approved_max_loss_minor, 'approvalExpiresAt', e.approval_expires_at,
    'decidedBy', e.decided_by, 'decisionCode', e.decision_code, 'decisionReason', e.decision_reason, 'expiresAt', e.expires_at,
    'startedAt', e.started_at, 'runDeadline', e.run_deadline, 'endedAt', e.ended_at, 'simSpentMinor', e.sim_spent_minor,
    'financialMode', 'simulated', 'executed', false, 'evidence', fleet_experiment_relevant_evidence(e.experiment_id, e.verified_evidence),
    'result', (SELECT jsonb_build_object('outcome', r.outcome, 'actualSpendMinor', r.actual_spend_minor, 'elapsedS', r.elapsed_s,
                 'simulatedRoi', r.simulated_roi, 'roiAuthority', r.roi_authority, 'spendSource', r.spend_source,
                 'simulatedRevenueMinor', r.simulated_revenue_minor, 'confidenceAfter', r.confidence_after, 'lessons', r.lessons)
                 FROM fleet_experiment_results r WHERE r.experiment_id = e.experiment_id))
$$;

-- Evaluate criteria [{metric, op, value}] against the latest CONTROLLER-RECORDED value of each metric.
CREATE FUNCTION fleet_experiment_criteria(p_exp uuid, p_criteria jsonb) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('metric', c ->> 'metric', 'op', c ->> 'op', 'target', (c ->> 'value')::numeric, 'observed', v.value,
    'met', CASE WHEN v.value IS NULL THEN false ELSE CASE c ->> 'op' WHEN '>=' THEN v.value >= (c ->> 'value')::numeric WHEN '<=' THEN v.value <= (c ->> 'value')::numeric
      WHEN '>' THEN v.value > (c ->> 'value')::numeric WHEN '<' THEN v.value < (c ->> 'value')::numeric ELSE v.value = (c ->> 'value')::numeric END END)), '[]'::jsonb)
  FROM jsonb_array_elements(COALESCE(p_criteria, '[]'::jsonb)) c
  LEFT JOIN LATERAL (SELECT value FROM fleet_experiment_events ev WHERE ev.experiment_id = p_exp AND ev.kind = 'observation'
                       AND ev.verification = 'controller_recorded' AND ev.metric = c ->> 'metric' ORDER BY ev.seq DESC LIMIT 1) v ON true
$$;

-- Conclude: the ONE authoritative result (values derived from the registry's own records), the strategy registry entry and a
-- knowledge proposal (failures are first-class). p_outcome NULL = decide from the criteria; 'stopped' = a stop.
CREATE FUNCTION fleet_experiment_conclude_internal(e fleet_experiments, p_outcome text, p_actor text, p_kind text, p_code text, p_reason text,
  p_lessons text, p_confidence smallint) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE succ jsonb; fail jsonb; v_out text; v_rev bigint; v_roi numeric; v_elapsed integer; v_claim jsonb; v_evid jsonb; v_disc jsonb; v_kp uuid;
        v_conf smallint; v_lessons text; v_cat text; v_exp_rev bigint;
BEGIN
  succ := fleet_experiment_criteria(e.experiment_id, e.proposal -> 'successCriteria');
  fail := fleet_experiment_criteria(e.experiment_id, e.proposal -> 'failureCriteria');
  v_out := COALESCE(p_outcome, CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(fail) f WHERE (f ->> 'met')::boolean) THEN 'failed'
                                    WHEN jsonb_array_length(succ) > 0 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(succ) s WHERE NOT (s ->> 'met')::boolean) THEN 'succeeded'
                                    ELSE 'failed' END);
  SELECT COALESCE((SELECT value FROM fleet_experiment_events WHERE experiment_id = e.experiment_id AND kind = 'observation' AND verification = 'controller_recorded'
                    AND metric = 'simulated_revenue_minor' ORDER BY seq DESC LIMIT 1), 0)::bigint INTO v_rev;
  -- Simulated, non-authoritative (spend is founder-reported): recorded for learning; nothing below derives from it.
  v_roi := CASE WHEN e.sim_spent_minor > 0 THEN round((v_rev - e.sim_spent_minor)::numeric / e.sim_spent_minor, 4) END;
  v_elapsed := GREATEST(0, floor(extract(epoch FROM now() - COALESCE(e.started_at, e.created_at)))::integer);
  SELECT detail INTO v_claim FROM fleet_experiment_events WHERE experiment_id = e.experiment_id AND kind = 'result_claim' ORDER BY seq DESC LIMIT 1;
  v_evid := jsonb_build_object('proposalEvidence', e.verified_evidence -> 'items',
    'controllerObservations', (SELECT COALESCE(jsonb_agg(jsonb_build_object('metric', metric, 'value', value, 'at', at) ORDER BY seq), '[]'::jsonb)
                                 FROM fleet_experiment_events WHERE experiment_id = e.experiment_id AND verification = 'controller_recorded'),
    'founderClaims', (SELECT count(*) FROM fleet_experiment_events WHERE experiment_id = e.experiment_id AND verification <> 'controller_recorded' AND kind = 'observation'),
    'events', (SELECT count(*) FROM fleet_experiment_events WHERE experiment_id = e.experiment_id));
  v_exp_rev := COALESCE((e.proposal #>> '{expectedPayoff,simulatedRevenueMinor}')::bigint, 0);
  v_disc := jsonb_build_object('spendVsApproved', jsonb_build_object('approved', e.approved_minor, 'spent', e.sim_spent_minor),
    'revenueVsForecast', jsonb_build_object('forecast', v_exp_rev, 'observed', v_rev),
    'timeVsSignal', jsonb_build_object('expectedS', e.time_to_signal_s, 'elapsedS', v_elapsed),
    'founderClaimOutcome', v_claim ->> 'outcome', 'founderClaimMatches', CASE WHEN v_claim IS NULL THEN NULL ELSE (v_claim ->> 'outcome') = v_out END,
    'claimedVsVerifiedLevel', jsonb_build_object('claimed', e.claimed_level, 'verified', e.verified_level));
  v_conf := COALESCE(p_confidence, CASE v_out WHEN 'succeeded' THEN LEAST(4, e.verified_level + 1) ELSE GREATEST(0, e.verified_level - 1) END)::smallint;
  v_lessons := left(COALESCE(NULLIF(fleet_scrub_long(p_lessons), ''), format('%s: %s after %s s; spent %s of %s (simulated); revenue %s (simulated, forecast %s).',
    v_out, e.opportunity_key, v_elapsed, e.sim_spent_minor, COALESCE(e.approved_minor, 0), v_rev, v_exp_rev)), 2000);
  INSERT INTO fleet_experiment_results (experiment_id, outcome, actual_spend_minor, elapsed_s, criteria, evidence, simulated_revenue_minor, simulated_roi, discrepancies,
      lessons, confidence_before, confidence_after, founder_claim, concluded_by, concluded_kind, financial_mode)
    VALUES (e.experiment_id, v_out, e.sim_spent_minor, v_elapsed, jsonb_build_object('success', succ, 'failure', fail), v_evid, v_rev, v_roi, v_disc,
      v_lessons, e.verified_level, v_conf, v_claim, left(p_actor, 128), p_kind, 'simulated');
  -- Institutional learning: a knowledge proposal (the owner still promotes), successes and failures alike.
  v_cat := CASE v_out WHEN 'succeeded' THEN 'technique' ELSE 'failure' END;
  v_kp := gen_random_uuid();
  INSERT INTO fleet_knowledge_proposals (proposal_id, agent_id, lineage_root, genesis_id, category, title, content, content_sha256)
    SELECT v_kp, a.agent_id, a.lineage_root, a.genesis_id, v_cat, left(format('[experiment %s] %s', v_out, e.opportunity_key), 200),
      left(format('Controller-recorded experiment result (simulated capital). Opportunity: %s. Hypothesis: %s. Outcome: %s. Spent %s of %s approved (founder-reported); simulated revenue %s; simulated ROI %s (non-authoritative); elapsed %s s. Evidence level E%s. Lessons: %s',
        e.opportunity_key, e.proposal ->> 'hypothesis', v_out, e.sim_spent_minor, COALESCE(e.approved_minor, 0), v_rev, COALESCE(v_roi::text, 'n/a'), v_elapsed, e.verified_level, v_lessons), 8000),
      repeat('0', 64)
    FROM fleet_agents a WHERE a.agent_id = e.agent_id;
  INSERT INTO fleet_strategy_registry (agent_id, opportunity_key, experiment_id, outcome, evidence_level, actual_spend_minor, simulated_revenue_minor, simulated_roi,
      lessons, confidence_after, knowledge_proposal_id, financial_mode)
    VALUES (e.agent_id, e.opportunity_key, e.experiment_id, v_out, e.verified_level, e.sim_spent_minor, v_rev, v_roi, v_lessons, v_conf, v_kp, 'simulated');
  PERFORM fleet_experiment_transition(e, v_out, p_actor, p_kind, p_code, p_reason, jsonb_build_object('criteria', jsonb_build_object('success', succ, 'failure', fail),
    'spentMinor', e.sim_spent_minor, 'simulatedRevenueMinor', v_rev, 'knowledgeProposalId', v_kp));
  UPDATE fleet_experiments SET status = v_out, ended_at = now() WHERE experiment_id = e.experiment_id;
  PERFORM fleet_event('knowledge_proposed', e.agent_id, 'controller', jsonb_build_object('proposalId', v_kp, 'category', v_cat, 'experimentId', e.experiment_id));
  RETURN jsonb_build_object('outcome', v_out, 'knowledgeProposalId', v_kp, 'simulatedRoi', v_roi, 'roiAuthority', 'simulated_non_authoritative', 'simulatedRevenueMinor', v_rev);
END $$;

-- Stop conditions: [{kind:'spend_at_least', value}, {kind:'elapsed_at_least_s', value}, {kind:'metric', metric, op, value}] plus the
-- implicit spend stop at the approved maximum loss. Metric stops may fire on ANY observation (stopping early is conservative).
CREATE FUNCTION fleet_experiment_stop_due(e fleet_experiments) RETURNS text LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c jsonb; v numeric;
BEGIN
  IF e.status <> 'running' THEN RETURN NULL; END IF;
  IF e.approved_max_loss_minor IS NOT NULL AND e.sim_spent_minor >= e.approved_max_loss_minor AND e.approved_max_loss_minor > 0 THEN RETURN 'max loss reached'; END IF;
  IF now() >= e.run_deadline THEN RETURN 'run window elapsed'; END IF;
  FOR c IN SELECT * FROM jsonb_array_elements(COALESCE(e.proposal -> 'stopConditions', '[]'::jsonb)) LOOP
    IF c ->> 'kind' = 'spend_at_least' AND e.sim_spent_minor >= (c ->> 'value')::numeric THEN RETURN format('spend reached %s', c ->> 'value'); END IF;
    IF c ->> 'kind' = 'elapsed_at_least_s' AND extract(epoch FROM now() - e.started_at) >= (c ->> 'value')::numeric THEN RETURN format('elapsed %s s', c ->> 'value'); END IF;
    IF c ->> 'kind' = 'metric' THEN
      SELECT value INTO v FROM fleet_experiment_events WHERE experiment_id = e.experiment_id AND kind = 'observation' AND metric = c ->> 'metric' ORDER BY seq DESC LIMIT 1;
      -- (parenthesised: PL/pgSQL ends an IF condition at the first THEN outside parentheses)
      IF v IS NOT NULL AND (CASE c ->> 'op' WHEN '>=' THEN v >= (c ->> 'value')::numeric WHEN '<=' THEN v <= (c ->> 'value')::numeric WHEN '>' THEN v > (c ->> 'value')::numeric
           WHEN '<' THEN v < (c ->> 'value')::numeric ELSE v = (c ->> 'value')::numeric END) THEN
        RETURN format('%s %s %s', c ->> 'metric', c ->> 'op', c ->> 'value');
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

-- Validate a founder's proposal document (unknown keys refused; bounded; no secret-shaped text). NULL = valid.
CREATE FUNCTION fleet_experiment_validate(p jsonb, pol fleet_experiment_policy) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k text; c jsonb; v_ok boolean;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR length(p::text) > 32768 THEN RETURN 'proposal must be an object'; END IF;
  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF k NOT IN ('opportunityKey','hypothesis','evidence','claimedLevel','uncertainty','objective','requestedMinor','maxLossMinor','timeToSignalS',
                 'successCriteria','failureCriteria','stopConditions','expiresInS','reversibility','dependencies','revenuePath','expectedPayoff','executionSteps') THEN
      RETURN format('field %s is not part of an experiment proposal', left(k, 40));
    END IF;
  END LOOP;
  IF COALESCE(p ->> 'opportunityKey', '') !~ '^[a-z0-9][a-z0-9-]{2,63}$' THEN RETURN 'opportunityKey'; END IF;
  IF length(COALESCE(p ->> 'hypothesis', '')) NOT BETWEEN 10 AND 1000 THEN RETURN 'hypothesis'; END IF;
  IF length(COALESCE(p ->> 'objective', '')) NOT BETWEEN 10 AND 600 THEN RETURN 'objective'; END IF;
  IF length(COALESCE(p ->> 'uncertainty', '')) NOT BETWEEN 3 AND 600 THEN RETURN 'uncertainty'; END IF;
  IF length(COALESCE(p ->> 'revenuePath', '')) NOT BETWEEN 3 AND 600 THEN RETURN 'revenuePath'; END IF;
  IF COALESCE(p ->> 'claimedLevel', '') !~ '^[0-4]$' THEN RETURN 'claimedLevel'; END IF;
  IF COALESCE(p ->> 'requestedMinor', '') !~ '^[0-9]{1,10}$' OR COALESCE(p ->> 'maxLossMinor', '') !~ '^[0-9]{1,10}$'
     OR (p ->> 'maxLossMinor')::bigint > (p ->> 'requestedMinor')::bigint THEN RETURN 'requestedMinor/maxLossMinor'; END IF;
  IF COALESCE(p ->> 'timeToSignalS', '') !~ '^[0-9]{1,9}$' OR (p ->> 'timeToSignalS')::bigint NOT BETWEEN 600 AND pol.max_run_s THEN RETURN 'timeToSignalS'; END IF;
  IF COALESCE(p ->> 'expiresInS', '') !~ '^[0-9]{1,9}$' OR (p ->> 'expiresInS')::bigint NOT BETWEEN 3600 AND pol.max_proposal_ttl_s THEN RETURN 'expiresInS'; END IF;
  IF COALESCE(p ->> 'reversibility', '') NOT IN ('reversible','partially_reversible','irreversible') THEN RETURN 'reversibility'; END IF;
  FOREACH k IN ARRAY ARRAY['successCriteria','failureCriteria'] LOOP
    IF jsonb_typeof(p -> k) IS DISTINCT FROM 'array' OR jsonb_array_length(p -> k) NOT BETWEEN 1 AND 8 THEN RETURN k; END IF;
    FOR c IN SELECT * FROM jsonb_array_elements(p -> k) LOOP
      IF jsonb_typeof(c) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(c) x WHERE x NOT IN ('metric','op','value'))
         OR COALESCE(c ->> 'metric', '') !~ '^[a-z][a-z0-9_]{1,39}$' OR COALESCE(c ->> 'op', '') NOT IN ('>=','<=','>','<','==')
         OR jsonb_typeof(c -> 'value') IS DISTINCT FROM 'number' OR abs((c ->> 'value')::numeric) >= 1e15 THEN RETURN k; END IF;
    END LOOP;
  END LOOP;
  IF jsonb_typeof(p -> 'stopConditions') IS DISTINCT FROM 'array' OR jsonb_array_length(p -> 'stopConditions') NOT BETWEEN 1 AND 8 THEN RETURN 'stopConditions'; END IF;
  FOR c IN SELECT * FROM jsonb_array_elements(p -> 'stopConditions') LOOP
    v_ok := jsonb_typeof(c) = 'object' AND jsonb_typeof(c -> 'value') = 'number' AND abs((c ->> 'value')::numeric) < 1e15 AND (
         (c ->> 'kind' IN ('spend_at_least','elapsed_at_least_s') AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(c) x WHERE x NOT IN ('kind','value')))
      OR (c ->> 'kind' = 'metric' AND COALESCE(c ->> 'metric', '') ~ '^[a-z][a-z0-9_]{1,39}$' AND COALESCE(c ->> 'op', '') IN ('>=','<=','>','<','==')
          AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(c) x WHERE x NOT IN ('kind','metric','op','value'))));
    IF NOT v_ok THEN RETURN 'stopConditions'; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['dependencies','executionSteps'] LOOP
    IF jsonb_typeof(p -> k) IS DISTINCT FROM 'array' OR jsonb_array_length(p -> k) > 12 OR (k = 'executionSteps' AND jsonb_array_length(p -> k) < 1)
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(p -> k) x WHERE jsonb_typeof(x) <> 'string' OR length(x #>> '{}') NOT BETWEEN 1 AND 300) THEN RETURN k; END IF;
  END LOOP;
  IF jsonb_typeof(p -> 'expectedPayoff') IS DISTINCT FROM 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p -> 'expectedPayoff') x WHERE x NOT IN ('simulatedRevenueMinor','learningValue'))
     OR COALESCE(p #>> '{expectedPayoff,simulatedRevenueMinor}', '') !~ '^[0-9]{1,10}$' OR length(COALESCE(p #>> '{expectedPayoff,learningValue}', '')) NOT BETWEEN 3 AND 600 THEN
    RETURN 'expectedPayoff';
  END IF;
  IF p ? 'evidence' AND jsonb_typeof(p -> 'evidence') <> 'array' THEN RETURN 'evidence'; END IF;
  IF fleet_secret_shaped(p::text) THEN RETURN 'secret-shaped text'; END IF;
  RETURN NULL;
END $$;

-- ═══ 4. Founder API (authenticated; own experiments only) ═══
CREATE FUNCTION api_experiment_propose(p_agent text, p_token text, p_idem text, p_proposal jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'experiment_propose'); pol fleet_experiment_policy; e fleet_experiments; v_hash text; v_bad text;
        v_ev jsonb; v_level smallint; d jsonb; v_active integer; v_id uuid := gen_random_uuid();
BEGIN
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  SELECT * INTO pol FROM fleet_experiment_policy WHERE id = 1;
  IF NOT pol.enabled THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_EXPERIMENTS_DISABLED'); END IF;
  IF NOT fleet_agent_can(p_agent, 'spend.request') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CAPABILITY_DENIED'); END IF;
  IF (SELECT status FROM fleet_agents WHERE agent_id = p_agent) <> 'active' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_AGENT_NOT_ACTIVE'); END IF;
  IF p_idem IS NULL OR p_idem !~ '^[A-Za-z0-9:_.-]{8,128}$' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'idempotencyKey'); END IF;
  PERFORM 1 FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE; -- serialise this founder's experiment decisions
  v_hash := encode(sha256(convert_to(p_agent || '|' || COALESCE(p_proposal::text, ''), 'UTF8')), 'hex');
  SELECT * INTO e FROM fleet_experiments WHERE agent_id = p_agent AND idempotency_key = p_idem;
  IF FOUND THEN
    IF e.request_sha256 <> v_hash THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_IDEMPOTENCY_CONFLICT'); END IF;
    RETURN jsonb_build_object('ok', true, 'replay', true, 'experiment', fleet_experiment_json(e));
  END IF;
  v_bad := fleet_experiment_validate(p_proposal, pol);
  IF v_bad IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', v_bad); END IF;
  v_ev := fleet_experiment_verify_evidence(p_agent, p_proposal -> 'evidence');
  IF (v_ev ->> 'ok')::boolean IS NOT TRUE THEN
    PERFORM fleet_event('experiment_evidence_refused', p_agent, 'controller', jsonb_build_object('code', v_ev ->> 'code', 'index', v_ev -> 'index'));
    RETURN jsonb_build_object('ok', false, 'code', v_ev ->> 'code', 'index', v_ev -> 'index');
  END IF;
  SELECT count(*) INTO v_active FROM fleet_experiments WHERE agent_id = p_agent AND status IN ('proposed','watch','approved','partially_approved','running');
  IF v_active >= pol.max_active_per_founder THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_EXPERIMENT_LIMIT'); END IF;
  -- A new proposal has no relevance assessments yet: provenance alone leaves it at E0 (WATCH) until the owner assesses.
  v_level := fleet_experiment_evidence_level(v_id, p_agent, p_proposal ->> 'opportunityKey', v_ev);
  PERFORM fleet_experiment_begin();
  INSERT INTO fleet_experiments (experiment_id, agent_id, idempotency_key, request_sha256, opportunity_key, proposal, claimed_level, verified_level, verified_evidence,
      requested_minor, max_loss_minor, reversibility, time_to_signal_s, expires_at, status)
    VALUES (v_id, p_agent, p_idem, v_hash, p_proposal ->> 'opportunityKey', p_proposal - 'evidence' || jsonb_build_object('evidence', v_ev -> 'items'),
      (p_proposal ->> 'claimedLevel')::smallint, v_level, v_ev, (p_proposal ->> 'requestedMinor')::bigint, (p_proposal ->> 'maxLossMinor')::bigint,
      p_proposal ->> 'reversibility', (p_proposal ->> 'timeToSignalS')::integer, now() + make_interval(secs => (p_proposal ->> 'expiresInS')::integer), 'proposed')
    RETURNING * INTO e;
  PERFORM fleet_experiment_transition(e, 'proposed', p_agent, 'founder', 'FLEET_EXPERIMENT_PROPOSED', NULL,
    jsonb_build_object('claimedLevel', e.claimed_level, 'verifiedLevel', v_level, 'evidenceItems', jsonb_array_length(v_ev -> 'items')));
  d := fleet_experiment_evaluate(e);
  e := fleet_experiment_apply(e, d, 'controller', 'controller');
  RETURN jsonb_build_object('ok', true, 'experiment', fleet_experiment_json(e), 'decision', d);
END $$;

-- More evidence for a proposal the controller is watching (or still considering): re-verified, re-decided.
CREATE FUNCTION api_experiment_add_evidence(p_agent text, p_token text, p_exp uuid, p_idem text, p_items jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'experiment_evidence'); e fleet_experiments; v_ev jsonb; v_all jsonb; v_level smallint; d jsonb; v_hash text;
BEGIN
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  SELECT * INTO e FROM fleet_experiments WHERE experiment_id = p_exp AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF p_idem IS NULL OR p_idem !~ '^[A-Za-z0-9:_.-]{8,128}$' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  v_hash := encode(sha256(convert_to(COALESCE(p_items::text, ''), 'UTF8')), 'hex');
  IF EXISTS (SELECT 1 FROM fleet_experiment_events WHERE experiment_id = e.experiment_id AND idempotency_key = p_idem) THEN
    IF (SELECT request_sha256 FROM fleet_experiment_events WHERE experiment_id = e.experiment_id AND idempotency_key = p_idem) <> v_hash THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_IDEMPOTENCY_CONFLICT');
    END IF;
    RETURN jsonb_build_object('ok', true, 'replay', true, 'experiment', fleet_experiment_json(e));
  END IF;
  IF e.status NOT IN ('proposed','watch') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE', 'experiment', fleet_experiment_json(e)); END IF;
  v_all := COALESCE((SELECT jsonb_agg(jsonb_build_object('attemptId', x ->> 'attemptId', 'sha256', x ->> 'sha256', 'supports', x ->> 'supports', 'rationale', x ->> 'rationale'))
                      FROM jsonb_array_elements(e.verified_evidence -> 'items') x), '[]'::jsonb)
           || CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE jsonb_build_array(p_items) END;
  v_ev := fleet_experiment_verify_evidence(p_agent, v_all);
  IF (v_ev ->> 'ok')::boolean IS NOT TRUE THEN
    PERFORM fleet_event('experiment_evidence_refused', p_agent, 'controller', jsonb_build_object('experimentId', e.experiment_id, 'code', v_ev ->> 'code'));
    RETURN jsonb_build_object('ok', false, 'code', v_ev ->> 'code', 'index', v_ev -> 'index');
  END IF;
  v_level := fleet_experiment_evidence_level(e.experiment_id, p_agent, e.opportunity_key, v_ev);
  PERFORM fleet_experiment_begin();
  INSERT INTO fleet_experiment_events (experiment_id, idempotency_key, request_sha256, kind, verification, detail, actor)
    -- verified by the registry itself against its own research record (not a metric observation: never used by criteria)
    VALUES (e.experiment_id, p_idem, v_hash, 'evidence_added', 'controller_recorded', jsonb_build_object('items', jsonb_array_length(v_ev -> 'items'), 'verifiedLevel', v_level), p_agent);
  -- The verified record grows (the proposal itself never changes); the decision is re-made on it.
  UPDATE fleet_experiments SET verified_evidence = v_ev, verified_level = v_level WHERE experiment_id = e.experiment_id RETURNING * INTO e;
  d := fleet_experiment_evaluate(e);
  e := fleet_experiment_apply(e, d, 'controller', 'controller');
  RETURN jsonb_build_object('ok', true, 'experiment', fleet_experiment_json(e), 'decision', d);
END $$;

CREATE FUNCTION api_experiment_start(p_agent text, p_token text, p_exp uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'experiment_start'); e fleet_experiments; pol fleet_experiment_policy;
BEGIN
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  SELECT * INTO pol FROM fleet_experiment_policy WHERE id = 1;
  IF NOT pol.enabled THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_EXPERIMENTS_DISABLED'); END IF;
  SELECT * INTO e FROM fleet_experiments WHERE experiment_id = p_exp AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF e.status = 'running' THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'experiment', fleet_experiment_json(e)); END IF;
  IF e.status NOT IN ('approved','partially_approved') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE', 'experiment', fleet_experiment_json(e)); END IF;
  PERFORM fleet_experiment_begin();
  -- An expired approval cannot execute: it expires now (its simulated capital reverts), and the start is refused.
  IF e.approval_expires_at <= now() THEN
    PERFORM fleet_experiment_transition(e, 'expired', 'controller', 'controller', 'FLEET_APPROVAL_EXPIRED', 'approval expired before start', '{}'::jsonb);
    UPDATE fleet_experiments SET status = 'expired', ended_at = now() WHERE experiment_id = e.experiment_id RETURNING * INTO e;
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_APPROVAL_EXPIRED', 'experiment', fleet_experiment_json(e));
  END IF;
  IF (SELECT status FROM fleet_agents WHERE agent_id = p_agent) <> 'active' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_AGENT_NOT_ACTIVE'); END IF;
  PERFORM fleet_experiment_transition(e, 'running', p_agent, 'founder', 'FLEET_EXPERIMENT_STARTED', NULL,
    jsonb_build_object('approvedMinor', e.approved_minor, 'approvedMaxLossMinor', e.approved_max_loss_minor));
  UPDATE fleet_experiments SET status = 'running', started_at = now(), run_deadline = now() + make_interval(secs => LEAST(pol.max_run_s, GREATEST(e.time_to_signal_s * 2, 3600)))
   WHERE experiment_id = e.experiment_id RETURNING * INTO e;
  RETURN jsonb_build_object('ok', true, 'experiment', fleet_experiment_json(e));
END $$;

-- A step of a running experiment: simulated spend (never beyond the approved budget), an observation (founder claim, or
-- linked to one of its own verified research pages), a step note, or a result claim. Idempotent per experiment.
CREATE FUNCTION api_experiment_record(p_agent text, p_token text, p_exp uuid, p_idem text, p_kind text, p_amount bigint, p_metric text, p_value numeric,
  p_attempt uuid, p_note text, p_detail jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'experiment_record'); e fleet_experiments; v_hash text; v_ver text := 'founder_claim'; o fleet_experiment_events;
        v_stop text; v_claim jsonb;
BEGIN
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  SELECT * INTO e FROM fleet_experiments WHERE experiment_id = p_exp AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF p_idem IS NULL OR p_idem !~ '^[A-Za-z0-9:_.-]{8,128}$' OR p_kind NOT IN ('sim_spend','observation','step','result_claim')
     OR (p_kind = 'sim_spend' AND (p_amount IS NULL OR p_amount <= 0 OR p_amount > 1000000000))
     OR (p_kind <> 'sim_spend' AND p_amount IS NOT NULL)
     OR (p_kind = 'observation' AND (p_metric IS NULL OR p_metric !~ '^[a-z][a-z0-9_]{1,39}$' OR p_value IS NULL OR abs(p_value) >= 1e15))
     OR length(COALESCE(p_note, '')) > 600 OR fleet_secret_shaped(p_note) OR fleet_secret_shaped(p_detail::text) OR length(COALESCE(p_detail::text, '')) > 4096 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  v_hash := encode(sha256(convert_to(concat_ws('|', p_kind, p_amount, p_metric, p_value, p_attempt, p_note, p_detail::text), 'UTF8')), 'hex');
  SELECT * INTO o FROM fleet_experiment_events WHERE experiment_id = e.experiment_id AND idempotency_key = p_idem;
  IF FOUND THEN
    IF o.request_sha256 <> v_hash THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_IDEMPOTENCY_CONFLICT'); END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_DUPLICATE_EVENT', 'replay', true, 'experiment', fleet_experiment_json(e));
  END IF;
  IF p_kind = 'result_claim' THEN
    IF e.status NOT IN ('running','stopped','succeeded','failed') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE'); END IF;
    IF EXISTS (SELECT 1 FROM fleet_experiment_results WHERE experiment_id = e.experiment_id) THEN
      -- The authoritative result exists: a founder never rewrites it (its later claims are not accepted).
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_RESULT_AUTHORITATIVE');
    END IF;
    IF jsonb_typeof(p_detail) IS DISTINCT FROM 'object' OR COALESCE(p_detail ->> 'outcome', '') NOT IN ('succeeded','failed','stopped') THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
    END IF;
  ELSIF e.status <> 'running' THEN
    RETURN jsonb_build_object('ok', false, 'code', CASE WHEN e.status IN ('approved','partially_approved') THEN 'FLEET_EXPERIMENT_NOT_STARTED' ELSE 'FLEET_INVALID_STATE' END,
      'experiment', fleet_experiment_json(e));
  END IF;
  IF p_kind = 'sim_spend' AND e.sim_spent_minor + p_amount > LEAST(e.approved_minor, COALESCE(e.approved_max_loss_minor, e.approved_minor)) THEN
    PERFORM fleet_event('experiment_budget_refused', p_agent, 'controller', jsonb_build_object('experimentId', e.experiment_id, 'amountMinor', p_amount,
      'spentMinor', e.sim_spent_minor, 'limitMinor', LEAST(e.approved_minor, COALESCE(e.approved_max_loss_minor, e.approved_minor))));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BUDGET_EXCEEDED', 'experiment', fleet_experiment_json(e));
  END IF;
  IF p_attempt IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM fleet_research_attempts a JOIN fleet_research_results r USING (attempt_id)
                    WHERE a.attempt_id = p_attempt AND a.agent_id = p_agent AND a.decision = 'authorized' AND r.outcome = 'fetched') THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_EVIDENCE_UNVERIFIED');
    END IF;
    v_ver := 'evidence_linked';
  END IF;
  PERFORM fleet_experiment_begin();
  INSERT INTO fleet_experiment_events (experiment_id, idempotency_key, request_sha256, kind, amount_minor, metric, value, verification, attempt_id, note, detail, actor)
    VALUES (e.experiment_id, p_idem, v_hash, p_kind, p_amount, p_metric, p_value, v_ver, p_attempt, left(fleet_scrub_long(p_note), 600), COALESCE(p_detail, '{}'::jsonb), p_agent);
  IF p_kind = 'sim_spend' THEN
    UPDATE fleet_experiments SET sim_spent_minor = sim_spent_minor + p_amount WHERE experiment_id = e.experiment_id RETURNING * INTO e;
  END IF;
  v_stop := fleet_experiment_stop_due(e);
  IF v_stop IS NOT NULL THEN
    PERFORM fleet_experiment_conclude_internal(e, 'stopped', 'controller', 'controller', 'FLEET_STOP_CONDITION', v_stop, NULL, NULL);
    SELECT * INTO e FROM fleet_experiments WHERE experiment_id = e.experiment_id;
    RETURN jsonb_build_object('ok', true, 'stopped', v_stop, 'experiment', fleet_experiment_json(e));
  END IF;
  RETURN jsonb_build_object('ok', true, 'experiment', fleet_experiment_json(e));
END $$;

CREATE FUNCTION api_experiment_list(p_agent text, p_token text, p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'experiment_list');
BEGIN
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  RETURN jsonb_build_object('ok', true, 'enabled', (SELECT enabled FROM fleet_experiment_policy WHERE id = 1), 'financialMode', 'simulated',
    'ladder', (SELECT jsonb_agg(jsonb_build_object('level', level, 'code', code, 'description', description, 'autoCapMinor', auto_cap_minor) ORDER BY level) FROM fleet_evidence_ladder),
    'experiments', (SELECT COALESCE(jsonb_agg(fleet_experiment_json(x) ORDER BY x.seq DESC), '[]'::jsonb)
                      FROM (SELECT * FROM fleet_experiments WHERE agent_id = p_agent ORDER BY seq DESC LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50)) x),
    'registry', (SELECT COALESCE(jsonb_agg(jsonb_build_object('opportunityKey', s.opportunity_key, 'outcome', s.outcome, 'simulatedRoi', s.simulated_roi,
                   'roiAuthority', s.roi_authority, 'lessons', s.lessons,
                   'confidenceAfter', s.confidence_after, 'recordedAt', s.recorded_at) ORDER BY s.seq DESC), '[]'::jsonb)
                   FROM (SELECT * FROM fleet_strategy_registry WHERE agent_id = p_agent ORDER BY seq DESC LIMIT 20) s));
END $$;

-- ═══ 5. Controller (service) ═══
-- Expiry and run windows: proposals and WATCH past their expiry, approvals never started in time (capital reverts),
-- running experiments past their window (concluded from the controller's own record).
CREATE FUNCTION svc_experiment_reap(p_limit integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE e fleet_experiments; n integer := 0;
BEGIN
  PERFORM fleet_experiment_begin();
  FOR e IN SELECT * FROM fleet_experiments
            WHERE (status IN ('proposed','watch') AND expires_at <= now())
               OR (status IN ('approved','partially_approved') AND approval_expires_at <= now())
               OR (status = 'running' AND run_deadline <= now())
            ORDER BY seq LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500) FOR UPDATE SKIP LOCKED LOOP
    IF e.status = 'running' THEN
      PERFORM fleet_experiment_conclude_internal(e, NULL, 'controller', 'controller', 'FLEET_RUN_WINDOW_ELAPSED', 'run window elapsed: concluded from recorded observations', NULL, NULL);
    ELSE
      PERFORM fleet_experiment_transition(e, 'expired', 'controller', 'controller', CASE WHEN e.status IN ('approved','partially_approved') THEN 'FLEET_APPROVAL_EXPIRED' ELSE 'FLEET_EXPIRED' END,
        CASE WHEN e.status IN ('approved','partially_approved') THEN 'approval not used in time: simulated capital reverted' ELSE 'proposal expired' END, '{}'::jsonb);
      UPDATE fleet_experiments SET status = 'expired', ended_at = now() WHERE experiment_id = e.experiment_id;
    END IF;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- Evidence artifact (controller, at research-fetch time, only while the pipeline is ON): the bounded, sanitized text the
-- controller keeps of a fetched page for later relevance review. Bound to the research record: this founder's authorized, fetched attempt, the same page hash
-- and the host of the recorded final URL; the fetch time is the registry's own. Never the raw page; never secret-shaped.
CREATE FUNCTION svc_research_artifact_record(p_agent text, p_attempt uuid, p_sha256 text, p_host text, p_title text, p_excerpt text,
  p_source_chars integer, p_truncated boolean, p_redactions integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_research_attempts; r fleet_research_results; v_host text;
BEGIN
  -- Nothing accumulates before the owner activates the pipeline: no artifact is kept while it is off.
  IF NOT COALESCE((SELECT enabled FROM fleet_experiment_policy WHERE id = 1), false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_EXPERIMENTS_DISABLED');
  END IF;
  SELECT * INTO a FROM fleet_research_attempts WHERE attempt_id = p_attempt;
  SELECT * INTO r FROM fleet_research_results WHERE attempt_id = p_attempt;
  IF a.attempt_id IS NULL OR a.agent_id <> p_agent OR a.decision <> 'authorized' OR r.attempt_id IS NULL OR r.outcome <> 'fetched' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ARTIFACT_NO_FETCH');
  END IF;
  IF p_sha256 IS DISTINCT FROM r.content_sha256 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ARTIFACT_HASH_MISMATCH'); END IF;
  v_host := lower(COALESCE(substring(r.final_url FROM '^https://([^/:?#]+)'), a.requested_host));
  IF lower(COALESCE(p_host, '')) IS DISTINCT FROM v_host THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ARTIFACT_SOURCE_MISMATCH'); END IF;
  IF p_excerpt IS NULL OR length(p_excerpt) NOT BETWEEN 1 AND 6000 OR length(COALESCE(p_title, '')) > 200
     OR p_source_chars IS NULL OR p_source_chars < 0 OR p_redactions IS NULL OR p_redactions < 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ARTIFACT_INVALID');
  END IF;
  IF fleet_secret_shaped(p_excerpt) OR fleet_secret_shaped(p_title) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ARTIFACT_SECRET_SHAPED'); END IF;
  IF EXISTS (SELECT 1 FROM fleet_research_evidence_artifacts WHERE attempt_id = p_attempt) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_DUPLICATE_EVENT'); END IF;
  PERFORM fleet_experiment_begin();
  INSERT INTO fleet_research_evidence_artifacts (attempt_id, agent_id, content_sha256, host, fetched_at, title, excerpt, excerpt_sha256, source_chars, truncated, redactions)
    VALUES (p_attempt, p_agent, r.content_sha256, v_host, r.recorded_at, NULLIF(p_title, ''), p_excerpt,
      encode(sha256(convert_to(p_excerpt, 'UTF8')), 'hex'), p_source_chars, COALESCE(p_truncated, false), p_redactions);
  RETURN jsonb_build_object('ok', true, 'attemptId', p_attempt, 'excerptSha256', encode(sha256(convert_to(p_excerpt, 'UTF8')), 'hex'));
END $$;

-- The relevance assessor's work list (controller): items of proposals under consideration that nobody has assessed yet,
-- with the evidence artifact and ONLY the task inputs (hypothesis, objective, claimed support, reversibility, amount vs
-- the E2 cap). No founder id, wealth, history or ROI is ever included: they cannot influence the assessment or its tier.
-- Bounded by the pipeline switch and the hourly inference budget (each job may take up to two calls).
CREATE FUNCTION svc_experiment_relevance_pending(p_limit integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE pol fleet_experiment_policy; v_used integer; v_room integer;
BEGIN
  SELECT * INTO pol FROM fleet_experiment_policy WHERE id = 1;
  -- Every call counts, answered or failed (a failing provider cannot turn retries into an unbounded bill).
  SELECT count(*) INTO v_used FROM fleet_relevance_calls WHERE at > now() - interval '1 hour';
  v_room := CASE WHEN pol.enabled THEN GREATEST(0, (pol.relevance_max_calls_per_hour - v_used) / 2) ELSE 0 END;
  RETURN jsonb_build_object('enabled', pol.enabled, 'callsLastHour', v_used, 'maxCallsPerHour', pol.relevance_max_calls_per_hour,
    'tiers', (SELECT COALESCE(jsonb_agg(jsonb_build_object('tier', t.tier, 'provider', t.provider, 'model', t.model, 'thinking', t.thinking,
                'effort', t.effort, 'maxOutputTokens', t.max_output_tokens, 'enabled', t.enabled, 'verifiedAt', t.verified_at, 'promptCache', 'off',
                'prices', jsonb_build_object('inputMicrocentsPerToken', t.input_microcents_per_token, 'outputMicrocentsPerToken', t.output_microcents_per_token,
                  'cacheWriteMicrocentsPerToken', t.cache_write_microcents_per_token, 'cacheReadMicrocentsPerToken', t.cache_read_microcents_per_token))
                ORDER BY t.tier), '[]'::jsonb) FROM fleet_cognition_tiers t),
    'jobs', (SELECT COALESCE(jsonb_agg(j ORDER BY j ->> 'seq'), '[]'::jsonb) FROM (
      SELECT jsonb_build_object('seq', lpad(e.seq::text, 20, '0') || lpad(x.ord::text, 3, '0'), 'experimentId', e.experiment_id, 'attemptId', x.item ->> 'attemptId',
        'sha256', x.item ->> 'sha256', 'supports', x.item ->> 'supports',
        'proposal', jsonb_build_object('hypothesis', e.proposal ->> 'hypothesis', 'objective', e.proposal ->> 'objective', 'reversibility', e.reversibility,
          'requestedMinor', e.requested_minor),
        'e2CapMinor', (SELECT auto_cap_minor FROM fleet_evidence_ladder WHERE level = 2),
        'artifact', (SELECT jsonb_build_object('contentSha256', ar.content_sha256, 'host', ar.host, 'fetchedAt', ar.fetched_at, 'title', ar.title,
                       'excerpt', ar.excerpt, 'excerptSha256', ar.excerpt_sha256, 'truncated', ar.truncated)
                     FROM fleet_research_evidence_artifacts ar WHERE ar.attempt_id = (x.item ->> 'attemptId')::uuid)) AS j
      FROM fleet_experiments e
      CROSS JOIN LATERAL jsonb_array_elements(e.verified_evidence -> 'items') WITH ORDINALITY AS x(item, ord)
      WHERE pol.enabled AND e.status IN ('proposed','watch')
        AND NOT EXISTS (SELECT 1 FROM fleet_experiment_relevance rv WHERE rv.experiment_id = e.experiment_id AND rv.attempt_id = (x.item ->> 'attemptId')::uuid)
      ORDER BY e.seq, x.ord LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 0), 50, v_room)) q(j)));
END $$;

-- The assessor's verdict (controller). Its inference is recorded as provider-credit consumption (fleet overhead; no
-- ledger posting, no founder charge) even when the verdict itself is refused. A 'relevant' verdict must cite the
-- artifact of the same page hash and quote it verbatim; otherwise it is refused (fail closed). Then the CONTROLLER
-- re-derives the level and re-decides.
CREATE FUNCTION svc_experiment_relevance_record(p_exp uuid, p_attempt uuid, p_verdict text, p_tier text, p_reason text, p_refs jsonb, p_calls jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE e fleet_experiments; x jsonb; ar fleet_research_evidence_artifacts; c jsonb; q jsonb; v_level smallint; d jsonb; v_calls jsonb := '[]'::jsonb;
BEGIN
  IF p_verdict NOT IN ('relevant','irrelevant','uncertain') OR p_tier NOT IN ('T0','T1','T2','T3') OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 3 AND 300
     OR fleet_secret_shaped(p_reason) OR jsonb_typeof(COALESCE(p_refs, '{}'::jsonb)) <> 'object' OR length(COALESCE(p_refs, '{}'::jsonb)::text) > 4096
     OR fleet_secret_shaped(COALESCE(p_refs, '{}'::jsonb)::text)
     OR jsonb_typeof(COALESCE(p_calls, '[]'::jsonb)) <> 'array' OR jsonb_array_length(COALESCE(p_calls, '[]'::jsonb)) > 4
     OR (p_tier = 'T0') <> (jsonb_array_length(COALESCE(p_calls, '[]'::jsonb)) = 0) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  -- Inference already happened: account for it first, whatever becomes of the verdict.
  FOR c IN SELECT * FROM jsonb_array_elements(COALESCE(p_calls, '[]'::jsonb)) LOOP
    IF COALESCE(c ->> 'requestId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR COALESCE(c ->> 'provider', '') !~ '^[a-z][a-z0-9_]{1,39}$'
       OR COALESCE(c ->> 'tier', '') NOT IN ('T1','T2','T3') OR COALESCE(c ->> 'model', '') !~ '^[A-Za-z0-9._:/@-]{1,120}$'
       OR COALESCE(c ->> 'usdMicrocents', '') !~ '^[0-9]{1,15}$' OR COALESCE(c ->> 'inputTokens', '') !~ '^[0-9]{1,9}$' OR COALESCE(c ->> 'outputTokens', '') !~ '^[0-9]{1,9}$' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'calls');
    END IF;
    PERFORM fleet_experiment_begin();
    INSERT INTO fleet_relevance_calls (request_id, experiment_id, attempt_id, provider, tier, model, outcome, charge, input_tokens, output_tokens, usd_microcents, cost_status)
      VALUES ((c ->> 'requestId')::uuid, (SELECT experiment_id FROM fleet_experiments WHERE experiment_id = p_exp), p_attempt, c ->> 'provider', c ->> 'tier', c ->> 'model',
        'ok', 'usage', (c ->> 'inputTokens')::bigint, (c ->> 'outputTokens')::bigint, (c ->> 'usdMicrocents')::bigint, 'known')
      ON CONFLICT (request_id) DO NOTHING;
    INSERT INTO fleet_provider_credit_events (provider, kind, usd_microcents, request_id, recorded_by)
      VALUES (c ->> 'provider', 'consumption', -(c ->> 'usdMicrocents')::bigint, (c ->> 'requestId')::uuid, 'controller:evidence_relevance')
      ON CONFLICT (request_id) DO NOTHING;
    v_calls := v_calls || jsonb_build_array(jsonb_build_object('requestId', c ->> 'requestId', 'tier', c ->> 'tier', 'model', c ->> 'model',
      'inputTokens', (c ->> 'inputTokens')::bigint, 'outputTokens', (c ->> 'outputTokens')::bigint, 'usdMicrocents', (c ->> 'usdMicrocents')::bigint,
      'stance', left(c ->> 'stance', 20), 'route', c -> 'route'));
  END LOOP;
  SELECT * INTO e FROM fleet_experiments WHERE experiment_id = p_exp FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF e.status NOT IN ('proposed','watch') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE'); END IF;
  SELECT i INTO x FROM jsonb_array_elements(e.verified_evidence -> 'items') i WHERE (i ->> 'attemptId')::uuid = p_attempt;
  IF x IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF EXISTS (SELECT 1 FROM fleet_experiment_relevance WHERE experiment_id = p_exp AND attempt_id = p_attempt) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_DUPLICATE_EVENT');
  END IF;
  SELECT * INTO ar FROM fleet_research_evidence_artifacts WHERE attempt_id = p_attempt;
  IF p_verdict = 'relevant' THEN
    -- Relevant only against the preserved artifact of the same page, with verbatim quotes of it.
    IF ar.attempt_id IS NULL OR ar.content_sha256 <> x ->> 'sha256' OR p_refs ->> 'excerptSha256' IS DISTINCT FROM ar.excerpt_sha256
       OR jsonb_typeof(p_refs -> 'quotes') IS DISTINCT FROM 'array' OR jsonb_array_length(p_refs -> 'quotes') NOT BETWEEN 1 AND 3 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_RELEVANCE_UNVERIFIED');
    END IF;
    FOR q IN SELECT * FROM jsonb_array_elements(p_refs -> 'quotes') LOOP
      IF jsonb_typeof(q) <> 'string' OR length(q #>> '{}') NOT BETWEEN 8 AND 300 OR position((q #>> '{}') IN ar.excerpt) = 0 THEN
        RETURN jsonb_build_object('ok', false, 'code', 'FLEET_RELEVANCE_UNVERIFIED');
      END IF;
    END LOOP;
  END IF;
  PERFORM fleet_experiment_begin();
  INSERT INTO fleet_experiment_relevance (experiment_id, attempt_id, content_sha256, supports, verdict, assessed_by, assessor_kind, tier, artifact_excerpt_sha256,
      refs, cognition, reason)
    VALUES (p_exp, p_attempt, x ->> 'sha256', x ->> 'supports', p_verdict, 'controller', 'controller', p_tier,
      CASE WHEN ar.attempt_id IS NOT NULL AND ar.content_sha256 = x ->> 'sha256' THEN ar.excerpt_sha256 END, COALESCE(p_refs, '{}'::jsonb), v_calls, fleet_scrub(p_reason));
  PERFORM fleet_event('experiment_relevance_assessed', e.agent_id, 'controller',
    jsonb_build_object('experimentId', p_exp, 'attemptId', p_attempt, 'sha256', x ->> 'sha256', 'verdict', p_verdict, 'tier', p_tier, 'calls', jsonb_array_length(v_calls)));
  v_level := fleet_experiment_evidence_level(e.experiment_id, e.agent_id, e.opportunity_key, e.verified_evidence);
  UPDATE fleet_experiments SET verified_level = v_level WHERE experiment_id = e.experiment_id RETURNING * INTO e;
  d := fleet_experiment_evaluate(e);
  e := fleet_experiment_apply(e, d, 'controller', 'controller');
  RETURN jsonb_build_object('ok', true, 'experiment', fleet_experiment_json(e), 'decision', d);
END $$;

-- A relevance-assessor call that failed (controller). Recorded whatever happened: actual usage when the provider reported
-- it (→ provider-credit consumption), known zero when the provider billed nothing, otherwise an explicit, audited
-- unknown-cost item that requires the owner's reconciliation (with the upper-bound estimate for guidance).
CREATE FUNCTION svc_relevance_call_failed(p_exp uuid, p_attempt uuid, p_call jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c jsonb := p_call; v_status text; v_usd bigint;
BEGIN
  IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR COALESCE(c ->> 'requestId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(c ->> 'provider', '') !~ '^[a-z][a-z0-9_]{1,39}$' OR COALESCE(c ->> 'tier', '') NOT IN ('T1','T2','T3')
     OR COALESCE(c ->> 'model', '') !~ '^[A-Za-z0-9._:/@-]{1,120}$' OR COALESCE(c ->> 'errorCode', '') !~ '^[A-Z_]{2,64}$'
     OR COALESCE(c ->> 'charge', '') NOT IN ('usage','none','unknown')
     OR (c ->> 'charge' = 'usage' AND COALESCE(c ->> 'usdMicrocents', '') !~ '^[0-9]{1,15}$')
     OR (c ? 'estimateUsdMicrocents' AND COALESCE(c ->> 'estimateUsdMicrocents', '') !~ '^[0-9]{1,15}$') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  v_status := CASE c ->> 'charge' WHEN 'usage' THEN 'known' WHEN 'none' THEN 'none' ELSE 'unknown_reconciliation_required' END;
  v_usd := CASE WHEN v_status = 'known' THEN (c ->> 'usdMicrocents')::bigint END;
  PERFORM fleet_experiment_begin();
  INSERT INTO fleet_relevance_calls (request_id, experiment_id, attempt_id, provider, tier, model, outcome, error_code, charge, input_tokens, output_tokens,
      usd_microcents, estimate_usd_microcents, cost_status)
    VALUES ((c ->> 'requestId')::uuid, (SELECT experiment_id FROM fleet_experiments WHERE experiment_id = p_exp), p_attempt, c ->> 'provider', c ->> 'tier', c ->> 'model',
      'failed', c ->> 'errorCode', c ->> 'charge', (c ->> 'inputTokens')::bigint, (c ->> 'outputTokens')::bigint, v_usd, (c ->> 'estimateUsdMicrocents')::bigint, v_status)
    ON CONFLICT (request_id) DO NOTHING;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', true, 'replay', true); END IF;
  IF v_status = 'known' THEN
    INSERT INTO fleet_provider_credit_events (provider, kind, usd_microcents, request_id, recorded_by)
      VALUES (c ->> 'provider', 'consumption', -v_usd, (c ->> 'requestId')::uuid, 'controller:evidence_relevance')
      ON CONFLICT (request_id) DO NOTHING;
  ELSIF v_status = 'unknown_reconciliation_required' THEN
    PERFORM fleet_event('provider_cost_reconciliation_required', NULL, 'controller',
      jsonb_build_object('requestId', c ->> 'requestId', 'provider', c ->> 'provider', 'model', c ->> 'model', 'tier', c ->> 'tier',
        'errorCode', c ->> 'errorCode', 'estimateUsdMicrocents', (c ->> 'estimateUsdMicrocents')::bigint, 'source', 'evidence_relevance'));
  END IF;
  RETURN jsonb_build_object('ok', true, 'costStatus', v_status);
END $$;

-- ═══ 6. Owner functions (never granted to the service, agent or operator roles) ═══

-- Reconcile one unknown-cost relevance call with the provider's actual charge (0 allowed): a consumption event carrying the
-- call's request id, so each call is reconciled at most once and the provider-credit record stays complete.
CREATE FUNCTION fleet_relevance_call_reconcile(p_request uuid, p_usd_microcents bigint, p_actor text, p_ref text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE k fleet_relevance_calls;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  IF p_usd_microcents IS NULL OR p_usd_microcents < 0 OR p_usd_microcents > 100000000000 OR p_ref IS NULL OR length(p_ref) NOT BETWEEN 3 AND 200 OR fleet_secret_shaped(p_ref) THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: actual USD microcents (>= 0) and a provider reference required';
  END IF;
  SELECT * INTO k FROM fleet_relevance_calls WHERE request_id = p_request;
  IF NOT FOUND OR k.cost_status <> 'unknown_reconciliation_required' THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no unknown-cost relevance call with this id'; END IF;
  IF EXISTS (SELECT 1 FROM fleet_provider_credit_events WHERE request_id = p_request) THEN RAISE EXCEPTION 'FLEET_DUPLICATE_EVENT: already reconciled'; END IF;
  INSERT INTO fleet_provider_credit_events (provider, kind, usd_microcents, request_id, external_ref, recorded_by)
    VALUES (k.provider, 'consumption', -p_usd_microcents, p_request, p_ref, p_actor);
  PERFORM fleet_event('provider_cost_reconciled', NULL, p_actor, jsonb_build_object('requestId', p_request, 'usdMicrocents', p_usd_microcents, 'source', 'evidence_relevance'));
  RETURN jsonb_build_object('ok', true, 'requestId', p_request, 'usdMicrocents', p_usd_microcents, 'balanceUsdMicrocents', fleet_provider_credit_balance(k.provider));
END $$;

-- Relevance calls whose cost is still unknown (owner view): each needs fleet_relevance_call_reconcile.
CREATE FUNCTION fleet_relevance_calls_unreconciled() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(k) ORDER BY k.at), '[]'::jsonb) FROM fleet_relevance_calls k
   WHERE k.cost_status = 'unknown_reconciliation_required' AND NOT EXISTS (SELECT 1 FROM fleet_provider_credit_events e WHERE e.request_id = k.request_id)
$$;
CREATE FUNCTION fleet_experiment_policy_set(p_enabled boolean, p_hard_cap bigint, p_actor text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  UPDATE fleet_experiment_policy SET enabled = COALESCE(p_enabled, enabled), hard_cap_minor = COALESCE(p_hard_cap, hard_cap_minor), updated_at = now(), updated_by = p_actor WHERE id = 1;
  PERFORM fleet_event('experiment_policy_set', NULL, p_actor, jsonb_build_object('enabled', p_enabled, 'hardCapMinor', p_hard_cap));
  RETURN (SELECT to_jsonb(p) FROM fleet_experiment_policy p WHERE id = 1);
END $$;

CREATE FUNCTION fleet_evidence_ladder_set(p_level smallint, p_auto_cap bigint, p_actor text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  IF p_level = 0 AND COALESCE(p_auto_cap, 0) <> 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: an unverified claim (E0) never earns capital'; END IF;
  UPDATE fleet_evidence_ladder SET auto_cap_minor = p_auto_cap, updated_at = now(), updated_by = p_actor WHERE level = p_level;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: level is 0..4'; END IF;
  PERFORM fleet_event('evidence_ladder_set', NULL, p_actor, jsonb_build_object('level', p_level, 'autoCapMinor', p_auto_cap));
  RETURN (SELECT to_jsonb(l) FROM fleet_evidence_ladder l WHERE level = p_level);
END $$;

-- The owner decides what policy left to the owner (or revisits WATCH / revokes an unused approval).
CREATE FUNCTION fleet_experiment_decide(p_exp uuid, p_decision text, p_approved bigint, p_max_loss bigint, p_actor text, p_reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE e fleet_experiments; pol fleet_experiment_policy; eco jsonb;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  IF p_decision NOT IN ('approved','partially_approved','watch','rejected') OR p_reason IS NULL OR length(p_reason) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: decision and reason required'; END IF;
  SELECT * INTO e FROM fleet_experiments WHERE experiment_id = p_exp FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such experiment'; END IF;
  SELECT * INTO pol FROM fleet_experiment_policy WHERE id = 1;
  IF p_decision IN ('approved','partially_approved') THEN
    IF e.status NOT IN ('proposed','watch') THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: experiment is %', e.status; END IF;
    IF p_approved IS NULL OR p_approved < 0 OR p_approved > e.requested_minor OR p_approved > pol.hard_cap_minor
       OR (p_decision = 'approved') <> (p_approved = e.requested_minor) THEN
      RAISE EXCEPTION 'FLEET_BAD_REQUEST: approved amount must be within the request and the hard cap (full = approved, less = partially_approved)';
    END IF;
    eco := fleet_agent_economics(e.agent_id);
    IF COALESCE(p_max_loss, LEAST(e.max_loss_minor, p_approved)) > GREATEST(0, COALESCE((eco ->> 'expensePurchasingCapacity')::bigint, 0)) THEN
      RAISE EXCEPTION 'FLEET_PROTECTED_CAPITAL: the maximum loss exceeds what the founder can lose above its protected capital';
    END IF;
  END IF;
  PERFORM fleet_experiment_begin();
  e := fleet_experiment_apply(e, jsonb_build_object('decision', p_decision, 'code', 'FLEET_OWNER_' || upper(p_decision), 'reason', fleet_scrub(p_reason),
    'approvedMinor', p_approved, 'maxLossMinor', LEAST(COALESCE(p_max_loss, e.max_loss_minor), COALESCE(p_approved, 0))), p_actor, 'owner');
  RETURN fleet_experiment_json(e);
END $$;

-- Relevance override (owner, optional and audited): record the owner's verdict for one provenance-verified evidence item
-- (before or after the controller's). Once per item; the override is the effective verdict; the CONTROLLER re-decides.
-- Never the founder itself (fleet_require_operator_approver). Ordinary evidence never needs this.
CREATE FUNCTION fleet_experiment_assess_relevance(p_exp uuid, p_attempt uuid, p_verdict text, p_actor text, p_reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE e fleet_experiments; x jsonb; v_level smallint; d jsonb; v_ctl text;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  IF p_verdict NOT IN ('relevant','irrelevant','uncertain') OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 3 AND 300 OR fleet_secret_shaped(p_reason) THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: verdict (relevant|irrelevant|uncertain) and a reason (3..300) required';
  END IF;
  SELECT * INTO e FROM fleet_experiments WHERE experiment_id = p_exp FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such experiment'; END IF;
  IF e.status NOT IN ('proposed','watch') THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: relevance is settled before the decision (experiment is %)', e.status; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), e.agent_id);
  SELECT i INTO x FROM jsonb_array_elements(e.verified_evidence -> 'items') i WHERE (i ->> 'attemptId')::uuid = p_attempt;
  IF x IS NULL THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: the attempt is not verified evidence of this experiment'; END IF;
  IF EXISTS (SELECT 1 FROM fleet_experiment_relevance WHERE experiment_id = p_exp AND attempt_id = p_attempt AND assessor_kind = 'owner') THEN
    RAISE EXCEPTION 'FLEET_DUPLICATE_EVENT: this evidence item already has an owner override';
  END IF;
  SELECT verdict INTO v_ctl FROM fleet_experiment_relevance WHERE experiment_id = p_exp AND attempt_id = p_attempt AND assessor_kind = 'controller';
  PERFORM fleet_experiment_begin();
  INSERT INTO fleet_experiment_relevance (experiment_id, attempt_id, content_sha256, supports, verdict, assessed_by, assessor_kind, overrides, reason)
    VALUES (p_exp, p_attempt, x ->> 'sha256', x ->> 'supports', p_verdict, p_actor, 'owner', v_ctl, fleet_scrub(p_reason));
  PERFORM fleet_event('experiment_relevance_overridden', e.agent_id, p_actor,
    jsonb_build_object('experimentId', p_exp, 'attemptId', p_attempt, 'sha256', x ->> 'sha256', 'verdict', p_verdict, 'controllerVerdict', v_ctl));
  v_level := fleet_experiment_evidence_level(e.experiment_id, e.agent_id, e.opportunity_key, e.verified_evidence);
  UPDATE fleet_experiments SET verified_level = v_level WHERE experiment_id = e.experiment_id RETURNING * INTO e;
  d := fleet_experiment_evaluate(e);
  e := fleet_experiment_apply(e, d, 'controller', 'controller');
  RETURN fleet_experiment_json(e) || jsonb_build_object('decision', d);
END $$;

-- E4 lineage (owner): attribute one realized external-revenue journal of a founder to its concluded experiment on the
-- opportunity that earned it. Only this founder's external_revenue journals recorded after that experiment started;
-- once per journal; the amount is what the journal credited to the founder's revenue account. Reads the ledger only.
CREATE FUNCTION fleet_experiment_attribute_revenue(p_journal uuid, p_exp uuid, p_actor text, p_reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE e fleet_experiments; j fleet_ledger_journal; v_amt bigint; ra fleet_opportunity_revenue_attributions;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  IF p_reason IS NULL OR length(p_reason) NOT BETWEEN 3 AND 300 OR fleet_secret_shaped(p_reason) THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a reason (3..300) required'; END IF;
  SELECT * INTO e FROM fleet_experiments WHERE experiment_id = p_exp;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM fleet_experiment_results WHERE experiment_id = p_exp) THEN
    RAISE EXCEPTION 'FLEET_INVALID_STATE: revenue is attributed to a concluded experiment';
  END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), e.agent_id);
  SELECT * INTO j FROM fleet_ledger_journal WHERE journal_id = p_journal;
  IF NOT FOUND OR j.kind <> 'external_revenue' OR j.agent_id IS DISTINCT FROM e.agent_id THEN
    RAISE EXCEPTION 'FLEET_REVENUE_NOT_ATTRIBUTABLE: not an external revenue journal of this founder';
  END IF;
  IF EXISTS (SELECT 1 FROM fleet_ledger_journal WHERE reverses_journal_id = p_journal) THEN
    RAISE EXCEPTION 'FLEET_REVENUE_NOT_ATTRIBUTABLE: the journal was reversed';
  END IF;
  IF e.started_at IS NULL OR j.recorded_at < e.started_at THEN
    RAISE EXCEPTION 'FLEET_REVENUE_NOT_ATTRIBUTABLE: revenue recorded before the experiment started';
  END IF;
  SELECT COALESCE(sum(amount_cents), 0) INTO v_amt FROM fleet_ledger_postings
   WHERE journal_id = p_journal AND side = 'C' AND account_id = fleet_ledger_account(e.agent_id, 'agent_revenue');
  IF v_amt <= 0 THEN RAISE EXCEPTION 'FLEET_REVENUE_NOT_ATTRIBUTABLE: the journal credits no revenue to this founder'; END IF;
  IF EXISTS (SELECT 1 FROM fleet_opportunity_revenue_attributions WHERE journal_id = p_journal) THEN
    RAISE EXCEPTION 'FLEET_DUPLICATE_EVENT: this journal is already attributed';
  END IF;
  PERFORM fleet_experiment_begin();
  INSERT INTO fleet_opportunity_revenue_attributions (journal_id, agent_id, opportunity_key, experiment_id, amount_minor, attributed_by, reason)
    VALUES (p_journal, e.agent_id, e.opportunity_key, p_exp, v_amt, p_actor, fleet_scrub(p_reason)) RETURNING * INTO ra;
  PERFORM fleet_event('experiment_revenue_attributed', e.agent_id, p_actor,
    jsonb_build_object('experimentId', p_exp, 'journalId', p_journal, 'opportunityKey', e.opportunity_key, 'amountMinor', v_amt));
  RETURN to_jsonb(ra);
END $$;

-- A controller-recorded observation (the synthetic executor in R24; later: verified measurement sources).
CREATE FUNCTION fleet_experiment_observe(p_exp uuid, p_idem text, p_metric text, p_value numeric, p_source text, p_actor text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE e fleet_experiments; v_stop text;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  IF p_metric IS NULL OR p_metric !~ '^[a-z][a-z0-9_]{1,39}$' OR p_value IS NULL OR abs(p_value) >= 1e15 OR p_idem !~ '^[A-Za-z0-9:_.-]{8,128}$'
     OR p_source IS NULL OR length(p_source) NOT BETWEEN 3 AND 300 OR fleet_secret_shaped(p_source) THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: metric, value, source and key required'; END IF;
  SELECT * INTO e FROM fleet_experiments WHERE experiment_id = p_exp FOR UPDATE;
  IF NOT FOUND OR e.status <> 'running' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: only a running experiment is observed'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), e.agent_id);
  PERFORM fleet_experiment_begin();
  INSERT INTO fleet_experiment_events (experiment_id, idempotency_key, request_sha256, kind, metric, value, verification, note, actor)
    VALUES (e.experiment_id, p_idem, encode(sha256(convert_to(concat_ws('|', p_metric, p_value, p_source), 'UTF8')), 'hex'), 'observation', p_metric, p_value,
      'controller_recorded', left(fleet_scrub(p_source), 300), p_actor)
    ON CONFLICT (experiment_id, idempotency_key) DO NOTHING;
  v_stop := fleet_experiment_stop_due(e);
  IF v_stop IS NOT NULL THEN
    PERFORM fleet_experiment_conclude_internal(e, 'stopped', 'controller', 'controller', 'FLEET_STOP_CONDITION', v_stop, NULL, NULL);
  END IF;
  SELECT * INTO e FROM fleet_experiments WHERE experiment_id = p_exp;
  RETURN fleet_experiment_json(e) || jsonb_build_object('stopped', v_stop);
END $$;

CREATE FUNCTION fleet_experiment_stop(p_exp uuid, p_actor text, p_reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE e fleet_experiments;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' OR p_reason IS NULL OR length(p_reason) < 3 THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor and reason required'; END IF;
  SELECT * INTO e FROM fleet_experiments WHERE experiment_id = p_exp FOR UPDATE;
  IF NOT FOUND OR e.status <> 'running' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: only a running experiment is stopped'; END IF;
  PERFORM fleet_experiment_begin();
  PERFORM fleet_experiment_conclude_internal(e, 'stopped', p_actor, 'owner', 'FLEET_OWNER_STOP', fleet_scrub(p_reason), NULL, NULL);
  SELECT * INTO e FROM fleet_experiments WHERE experiment_id = p_exp;
  RETURN fleet_experiment_json(e);
END $$;

CREATE FUNCTION fleet_experiment_conclude(p_exp uuid, p_actor text, p_lessons text, p_confidence smallint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE e fleet_experiments;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  IF p_confidence IS NOT NULL AND p_confidence NOT BETWEEN 0 AND 4 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: confidence is 0..4'; END IF;
  SELECT * INTO e FROM fleet_experiments WHERE experiment_id = p_exp FOR UPDATE;
  IF NOT FOUND OR e.status <> 'running' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: only a running experiment is concluded'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), e.agent_id);
  PERFORM fleet_experiment_begin();
  PERFORM fleet_experiment_conclude_internal(e, NULL, p_actor, 'owner', 'FLEET_OWNER_CONCLUDED', 'concluded from the controller-recorded observations', p_lessons, p_confidence);
  SELECT * INTO e FROM fleet_experiments WHERE experiment_id = p_exp;
  RETURN fleet_experiment_json(e);
END $$;

-- Owner view: the full record (proposal, verified evidence, transitions, events, result, registry entry).
CREATE FUNCTION fleet_experiment_view(p_exp uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT to_jsonb(e) - 'request_sha256' || jsonb_build_object(
    'transitions', (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.seq), '[]'::jsonb) FROM fleet_experiment_transitions t WHERE t.experiment_id = e.experiment_id),
    'events', (SELECT COALESCE(jsonb_agg(to_jsonb(v) - 'request_sha256' ORDER BY v.seq), '[]'::jsonb) FROM fleet_experiment_events v WHERE v.experiment_id = e.experiment_id),
    'relevance', (SELECT COALESCE(jsonb_agg(to_jsonb(rv) ORDER BY rv.seq), '[]'::jsonb) FROM fleet_experiment_relevance rv WHERE rv.experiment_id = e.experiment_id),
    'revenueAttributions', (SELECT COALESCE(jsonb_agg(to_jsonb(ra) ORDER BY ra.seq), '[]'::jsonb) FROM fleet_opportunity_revenue_attributions ra WHERE ra.experiment_id = e.experiment_id),
    'result', (SELECT to_jsonb(r) FROM fleet_experiment_results r WHERE r.experiment_id = e.experiment_id),
    'registry', (SELECT to_jsonb(s) FROM fleet_strategy_registry s WHERE s.experiment_id = e.experiment_id))
  FROM fleet_experiments e WHERE e.experiment_id = p_exp
$$;

-- Founders see whether the pipeline is on (the controller advertises the experiment tools only then).
CREATE OR REPLACE FUNCTION api_capabilities(p_agent text, p_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'capabilities'); a fleet_agents; m fleet_capability_manifests;
BEGIN
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent;
  SELECT * INTO m FROM fleet_capability_manifests WHERE manifest_id = a.capability_manifest_id;
  RETURN jsonb_build_object('ok', true, 'origin', a.origin, 'manifestId', m.manifest_id, 'manifestSha256', m.manifest_sha256,
    'allowed', to_jsonb(m.allowed), 'reproductionExecutable', false, 'paymentExecutable', false,
    'experimentsEnabled', COALESCE((SELECT enabled FROM fleet_experiment_policy WHERE id = 1), false));
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
