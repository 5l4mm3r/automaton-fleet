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
 *     provenance alone never elevates an opportunity. Relevance is an explicit, immutable assessment per evidence item by
 *     the owner (never the founder), referencing the attempt and page hash (fleet_experiment_relevance).
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

-- Relevance, separate from provenance: the owner's explicit assessment of one verified evidence item for one proposal,
-- referencing the research attempt and the page hash it was verified against. One immutable assessment per item.
CREATE TABLE fleet_experiment_relevance (
  seq            bigserial   PRIMARY KEY,
  experiment_id  uuid        NOT NULL REFERENCES fleet_experiments(experiment_id),
  attempt_id     uuid        NOT NULL REFERENCES fleet_research_attempts(attempt_id),
  content_sha256 text        NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  supports       text        NOT NULL,
  verdict        text        NOT NULL CHECK (verdict IN ('relevant','irrelevant')),
  assessed_by    text        NOT NULL CHECK (assessed_by ~ '^operator:[A-Za-z0-9._-]{1,64}$'),
  assessor_kind  text        NOT NULL CHECK (assessor_kind = 'owner'),
  reason         text        NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, attempt_id)
);

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

-- Relevant, provenance-verified evidence of one proposal: {items, hosts, assessed, unassessed}. An item counts only when
-- the owner assessed it relevant for THIS experiment against the same page hash that verified its provenance.
CREATE FUNCTION fleet_experiment_relevant_evidence(p_exp uuid, p_verified jsonb) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'verified', count(*),
    'relevant', count(*) FILTER (WHERE rv.verdict = 'relevant'),
    'irrelevant', count(*) FILTER (WHERE rv.verdict = 'irrelevant'),
    'unassessed', count(*) FILTER (WHERE rv.verdict IS NULL),
    'relevantHosts', count(DISTINCT x ->> 'host') FILTER (WHERE rv.verdict = 'relevant'))
  FROM jsonb_array_elements(COALESCE(p_verified -> 'items', '[]'::jsonb)) x
  LEFT JOIN fleet_experiment_relevance rv ON rv.experiment_id = p_exp AND rv.attempt_id = (x ->> 'attemptId')::uuid AND rv.content_sha256 = x ->> 'sha256'
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
      'reason', format('awaiting relevance assessment of %s of %s provenance-verified item(s); provenance alone earns nothing (claimed E%s)',
        rel ->> 'unassessed', rel ->> 'verified', e.claimed_level));
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

-- ═══ 6. Owner functions (never granted to the service, agent or operator roles) ═══
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

-- Relevance (owner): assess one provenance-verified evidence item of a proposal as relevant or irrelevant to it. The
-- assessment is final for that item; the evidence level is recomputed and the CONTROLLER re-decides (the owner's
-- assessment is an input, not an approval). Never the founder itself (fleet_require_operator_approver).
CREATE FUNCTION fleet_experiment_assess_relevance(p_exp uuid, p_attempt uuid, p_verdict text, p_actor text, p_reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE e fleet_experiments; x jsonb; v_level smallint; d jsonb;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  IF p_verdict NOT IN ('relevant','irrelevant') OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 3 AND 300 OR fleet_secret_shaped(p_reason) THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: verdict (relevant|irrelevant) and a reason (3..300) required';
  END IF;
  SELECT * INTO e FROM fleet_experiments WHERE experiment_id = p_exp FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such experiment'; END IF;
  IF e.status NOT IN ('proposed','watch') THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: relevance is assessed before the decision (experiment is %)', e.status; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), e.agent_id);
  SELECT i INTO x FROM jsonb_array_elements(e.verified_evidence -> 'items') i WHERE (i ->> 'attemptId')::uuid = p_attempt;
  IF x IS NULL THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: the attempt is not verified evidence of this experiment'; END IF;
  IF EXISTS (SELECT 1 FROM fleet_experiment_relevance WHERE experiment_id = p_exp AND attempt_id = p_attempt) THEN
    RAISE EXCEPTION 'FLEET_DUPLICATE_EVENT: this evidence item is already assessed';
  END IF;
  PERFORM fleet_experiment_begin();
  INSERT INTO fleet_experiment_relevance (experiment_id, attempt_id, content_sha256, supports, verdict, assessed_by, assessor_kind, reason)
    VALUES (p_exp, p_attempt, x ->> 'sha256', x ->> 'supports', p_verdict, p_actor, 'owner', fleet_scrub(p_reason));
  PERFORM fleet_event('experiment_relevance_assessed', e.agent_id, p_actor,
    jsonb_build_object('experimentId', p_exp, 'attemptId', p_attempt, 'sha256', x ->> 'sha256', 'supports', x ->> 'supports', 'verdict', p_verdict));
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
