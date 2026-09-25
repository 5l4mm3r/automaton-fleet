/**
 * Schema v13 — Phase F.2: founder cognition, metered and controlled by FleetController.
 *
 * A founder thinks only through the controller's inference gateway: founders
 * never hold an inference provider credential. Before every model call the
 * controller asks the database for authorization (svc_cognition_authorize):
 *
 *   - the owner's global switch (fleet_cognition_policy.cognition_enabled,
 *     default OFF) and a configured provider;
 *   - the founder's own switch and pause (fleet_founder_cognition; the per-
 *     founder kill switch), its origin, status and holds;
 *   - one call in flight per founder; a turns-per-hour limit;
 *   - a daily budget, the founder's own cash AND its survival equity (thinking
 *     can never consume protected principal), and the fleet's prepaid
 *     inference credits.
 *
 * After the call the actual cost is charged to the founder's ledger
 * (inference_charge: the founder's cash reimburses the treasury for prepaid
 * credits consumed; the founder's realized net profit falls) and the decision
 * is recorded in an append-only log the founder cannot write
 * (fleet_cognition_log: model, token counts, cost, prompt/response digests and
 * the tool calls the model requested).
 */

export const V13_SQL = `
-- ═══ Policy and per-founder controls ════════════════════════════════════
CREATE TABLE fleet_cognition_policy (
  id                              smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cognition_enabled               boolean     NOT NULL DEFAULT false,
  provider                        text        NOT NULL DEFAULT 'none' CHECK (provider IN ('none','scripted','openai_compatible')),
  model                           text        NOT NULL DEFAULT 'none' CHECK (model ~ '^[A-Za-z0-9._:/-]{1,100}$'),
  max_output_tokens               integer     NOT NULL DEFAULT 1024 CHECK (max_output_tokens BETWEEN 16 AND 16384),
  input_microcents_per_token      bigint      NOT NULL DEFAULT 0 CHECK (input_microcents_per_token >= 0),
  output_microcents_per_token     bigint      NOT NULL DEFAULT 0 CHECK (output_microcents_per_token >= 0),
  default_daily_budget_cents      bigint      NOT NULL DEFAULT 100 CHECK (default_daily_budget_cents >= 0),
  default_max_turns_per_hour      integer     NOT NULL DEFAULT 30 CHECK (default_max_turns_per_hour BETWEEN 1 AND 3600),
  updated_by                      text        NOT NULL DEFAULT 'migration',
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT cognition_enabled OR provider <> 'none')
);
INSERT INTO fleet_cognition_policy (id) VALUES (1);
CREATE TRIGGER fleet_cognition_policy_no_delete BEFORE DELETE ON fleet_cognition_policy
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_founder_cognition (
  agent_id            text        PRIMARY KEY REFERENCES fleet_agents(agent_id),
  enabled             boolean     NOT NULL DEFAULT false,
  paused              boolean     NOT NULL DEFAULT false,
  daily_budget_cents  bigint      CHECK (daily_budget_cents >= 0),
  max_turns_per_hour  integer     CHECK (max_turns_per_hour BETWEEN 1 AND 3600),
  reason              text        CHECK (length(reason) <= 200),
  updated_by          text        NOT NULL CHECK (updated_by ~ '^(operator:[A-Za-z0-9._-]{1,64}|lifecycle)$'),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_founder_cognition_no_delete BEFORE DELETE ON fleet_founder_cognition
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_cognition_inflight (
  agent_id         text        PRIMARY KEY REFERENCES fleet_agents(agent_id),
  request_id       uuid        NOT NULL UNIQUE,
  estimate_cents   bigint      NOT NULL CHECK (estimate_cents >= 0),
  started_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fleet_cognition_log (
  seq              bigserial   PRIMARY KEY,
  request_id       uuid        NOT NULL UNIQUE,
  agent_id         text        NOT NULL REFERENCES fleet_agents(agent_id),
  provider         text        NOT NULL,
  model            text        NOT NULL,
  outcome          text        NOT NULL CHECK (outcome IN ('ok','error')),
  input_tokens     integer     NOT NULL CHECK (input_tokens >= 0),
  output_tokens    integer     NOT NULL CHECK (output_tokens >= 0),
  cost_microcents  bigint      NOT NULL CHECK (cost_microcents >= 0),
  charged_cents    bigint      NOT NULL CHECK (charged_cents >= 0),
  journal_id       uuid        REFERENCES fleet_ledger_journal(journal_id),
  prompt_sha256    text        NOT NULL CHECK (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  response_sha256  text        NOT NULL CHECK (response_sha256 ~ '^[0-9a-f]{64}$'),
  tool_calls       jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tool_calls) = 'array' AND length(tool_calls::text) <= 16384),
  error_code       text        CHECK (error_code ~ '^[A-Z_]{2,64}$'),
  at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_cognition_log_agent_idx ON fleet_cognition_log (agent_id, at);
CREATE TRIGGER fleet_cognition_log_no_change BEFORE UPDATE OR DELETE ON fleet_cognition_log
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_cognition_log_no_truncate BEFORE TRUNCATE ON fleet_cognition_log
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ═══ Ledger: inference is an expense the founder pays from its own cash ══
ALTER TABLE fleet_ledger_kinds DISABLE TRIGGER fleet_ledger_kinds_no_change;
INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance) VALUES
  ('inference_charge', false, ARRAY['controller'], false, 'Founder inference: its cash reimburses the treasury for prepaid credits consumed', 'expense');
ALTER TABLE fleet_ledger_kinds ENABLE TRIGGER fleet_ledger_kinds_no_change;
INSERT INTO fleet_ledger_rules (kind, class, side) VALUES
  ('inference_charge','agent_expense','D'), ('inference_charge','agent_cash','C'),
  ('inference_charge','treasury_cash','D'), ('inference_charge','conway_credits','C');

-- ═══ Owner controls (never granted) ═════════════════════════════════════
CREATE FUNCTION fleet_cognition_set_policy(p_enabled boolean, p_provider text, p_model text, p_max_output_tokens integer,
  p_input_microcents bigint, p_output_microcents bigint, p_daily_budget_cents bigint, p_max_turns integer, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_cognition_policy;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_cognition');
  UPDATE fleet_cognition_policy SET cognition_enabled = p_enabled, provider = COALESCE(p_provider, provider), model = COALESCE(p_model, model),
         max_output_tokens = COALESCE(p_max_output_tokens, max_output_tokens),
         input_microcents_per_token = COALESCE(p_input_microcents, input_microcents_per_token),
         output_microcents_per_token = COALESCE(p_output_microcents, output_microcents_per_token),
         default_daily_budget_cents = COALESCE(p_daily_budget_cents, default_daily_budget_cents),
         default_max_turns_per_hour = COALESCE(p_max_turns, default_max_turns_per_hour),
         updated_by = p_actor, updated_at = now()
   WHERE id = 1 RETURNING * INTO p;
  PERFORM fleet_event(CASE WHEN p_enabled THEN 'cognition_enabled' ELSE 'cognition_disabled' END, NULL, p_actor,
    jsonb_build_object('provider', p.provider, 'model', p.model));
  RETURN to_jsonb(p);
END $$;

-- Per-founder switch, pause (kill switch) and limits. Pausing is immediate: the next authorization refuses.
CREATE FUNCTION fleet_founder_cognition_set(p_agent text, p_enabled boolean, p_paused boolean, p_daily_budget_cents bigint, p_max_turns integer,
  p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; r fleet_founder_cognition;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent;
  IF NOT FOUND OR a.origin NOT IN ('genesis_founder','reseed_founder') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: cognition is controlled per founder'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), p_agent);
  INSERT INTO fleet_founder_cognition (agent_id, enabled, paused, daily_budget_cents, max_turns_per_hour, reason, updated_by)
    VALUES (p_agent, COALESCE(p_enabled, false), COALESCE(p_paused, false), p_daily_budget_cents, p_max_turns, left(fleet_scrub(p_reason), 200), p_actor)
    ON CONFLICT (agent_id) DO UPDATE SET enabled = COALESCE(p_enabled, fleet_founder_cognition.enabled), paused = COALESCE(p_paused, fleet_founder_cognition.paused),
      daily_budget_cents = COALESCE(p_daily_budget_cents, fleet_founder_cognition.daily_budget_cents),
      max_turns_per_hour = COALESCE(p_max_turns, fleet_founder_cognition.max_turns_per_hour),
      reason = left(fleet_scrub(p_reason), 200), updated_by = p_actor, updated_at = now()
    RETURNING * INTO r;
  PERFORM fleet_event(CASE WHEN r.paused THEN 'founder_cognition_paused' WHEN r.enabled THEN 'founder_cognition_enabled' ELSE 'founder_cognition_disabled' END,
    p_agent, p_actor, jsonb_build_object('enabled', r.enabled, 'paused', r.paused, 'reason', r.reason));
  RETURN to_jsonb(r);
END $$;

-- Economic death or quarantine stops cognition at once (belt and braces: dead agents cannot authenticate anyway).
CREATE FUNCTION fleet_agents_cognition_stop() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF NEW.status IN ('dead','failed','terminating','orphaned') AND OLD.status NOT IN ('dead','failed','terminating','orphaned') THEN
    UPDATE fleet_founder_cognition SET enabled = false, paused = true, reason = 'lifecycle: ' || NEW.status, updated_by = 'lifecycle', updated_at = now()
     WHERE agent_id = NEW.agent_id;
    DELETE FROM fleet_cognition_inflight WHERE agent_id = NEW.agent_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER fleet_agents_cognition_stop AFTER UPDATE OF status ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_cognition_stop();

-- ═══ Controller (service role) ══════════════════════════════════════════
-- Effective limits and today's usage for one founder (no side effects).
CREATE FUNCTION fleet_cognition_state(p_agent text) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'policyEnabled', p.cognition_enabled, 'provider', p.provider, 'model', p.model, 'maxOutputTokens', p.max_output_tokens,
    'inputMicrocentsPerToken', p.input_microcents_per_token, 'outputMicrocentsPerToken', p.output_microcents_per_token,
    'founderEnabled', COALESCE(f.enabled, false), 'paused', COALESCE(f.paused, false),
    'dailyBudgetCents', COALESCE(f.daily_budget_cents, p.default_daily_budget_cents),
    'maxTurnsPerHour', COALESCE(f.max_turns_per_hour, p.default_max_turns_per_hour),
    'spentTodayCents', (SELECT COALESCE(sum(charged_cents), 0) FROM fleet_cognition_log WHERE agent_id = p_agent AND at > now() - interval '1 day'),
    'turnsLastHour', (SELECT count(*) FROM fleet_cognition_log WHERE agent_id = p_agent AND at > now() - interval '1 hour'),
    'inFlight', EXISTS (SELECT 1 FROM fleet_cognition_inflight WHERE agent_id = p_agent AND started_at > now() - interval '5 minutes'))
  FROM fleet_cognition_policy p LEFT JOIN fleet_founder_cognition f ON f.agent_id = p_agent WHERE p.id = 1
$$;

CREATE FUNCTION svc_cognition_authorize(p_agent text, p_estimate_cents bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; s jsonb; e jsonb; v_id uuid := gen_random_uuid(); v_est bigint := GREATEST(COALESCE(p_estimate_cents, 0), 1);
BEGIN
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR a.origin NOT IN ('genesis_founder','reseed_founder') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_NOT_FOUNDER'); END IF;
  IF a.status NOT IN ('active','unresponsive') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_AGENT_NOT_ACTIVE'); END IF;
  IF a.operator_hold_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_AGENT_HELD'); END IF;
  s := fleet_cognition_state(p_agent);
  IF NOT (s ->> 'policyEnabled')::boolean OR s ->> 'provider' = 'none' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_DISABLED'); END IF;
  IF NOT (s ->> 'founderEnabled')::boolean THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_FOUNDER_DISABLED'); END IF;
  IF (s ->> 'paused')::boolean THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_PAUSED'); END IF;
  DELETE FROM fleet_cognition_inflight WHERE agent_id = p_agent AND started_at <= now() - interval '5 minutes';
  IF EXISTS (SELECT 1 FROM fleet_cognition_inflight WHERE agent_id = p_agent) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_BUSY'); END IF;
  IF (s ->> 'turnsLastHour')::integer >= (s ->> 'maxTurnsPerHour')::integer THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_RATE_LIMITED'); END IF;
  IF (s ->> 'spentTodayCents')::bigint + v_est > (s ->> 'dailyBudgetCents')::bigint THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_BUDGET_EXHAUSTED'); END IF;
  PERFORM 1 FROM fleet_ledger_accounts WHERE account_id = fleet_ledger_account(p_agent, 'agent_cash') FOR UPDATE;
  e := fleet_agent_economics(p_agent);
  IF (e ->> 'cash')::bigint < v_est THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INSUFFICIENT_ALLOCATION'); END IF;
  IF (e ->> 'survivalEquity')::bigint < v_est THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PROTECTED_CAPITAL'); END IF;
  IF fleet_ledger_balance('fleet:conway_credits') < v_est THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_CREDITS_EXHAUSTED'); END IF;
  INSERT INTO fleet_cognition_inflight (agent_id, request_id, estimate_cents) VALUES (p_agent, v_id, v_est);
  RETURN jsonb_build_object('ok', true, 'requestId', v_id, 'estimateCents', v_est, 'provider', s ->> 'provider', 'model', s ->> 'model',
    'maxOutputTokens', s -> 'maxOutputTokens');
END $$;

-- Record the outcome and charge the founder (never more than the authorized estimate).
CREATE FUNCTION svc_cognition_record(p_agent text, p_request uuid, p_outcome text, p_input_tokens integer, p_output_tokens integer,
  p_prompt_sha256 text, p_response_sha256 text, p_tool_calls jsonb, p_error_code text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE i fleet_cognition_inflight; p fleet_cognition_policy; v_cost bigint; v_charge bigint; v_j uuid;
BEGIN
  SELECT * INTO i FROM fleet_cognition_inflight WHERE agent_id = p_agent AND request_id = p_request FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_NOT_AUTHORIZED'); END IF;
  SELECT * INTO p FROM fleet_cognition_policy WHERE id = 1;
  v_cost := GREATEST(COALESCE(p_input_tokens, 0), 0)::bigint * p.input_microcents_per_token + GREATEST(COALESCE(p_output_tokens, 0), 0)::bigint * p.output_microcents_per_token;
  v_charge := LEAST(i.estimate_cents, ceil(v_cost / 1000000.0)::bigint);
  IF v_charge > 0 THEN
    v_j := fleet_ledger_post('inference_charge', 'infer:' || p_request, 'controller', 'founder inference', 'controller', p_agent, NULL, NULL, NULL, NULL, now(),
      jsonb_build_array(
        jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_expense'), 'side', 'D', 'amount', v_charge),
        jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'C', 'amount', v_charge),
        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', v_charge),
        jsonb_build_object('account', 'fleet:conway_credits', 'side', 'C', 'amount', v_charge)));
  END IF;
  DELETE FROM fleet_cognition_inflight WHERE agent_id = p_agent;
  INSERT INTO fleet_cognition_log (request_id, agent_id, provider, model, outcome, input_tokens, output_tokens, cost_microcents, charged_cents, journal_id,
      prompt_sha256, response_sha256, tool_calls, error_code)
    VALUES (p_request, p_agent, p.provider, p.model, CASE WHEN p_outcome = 'ok' THEN 'ok' ELSE 'error' END, GREATEST(COALESCE(p_input_tokens, 0), 0),
      GREATEST(COALESCE(p_output_tokens, 0), 0), v_cost, v_charge, v_j, p_prompt_sha256, p_response_sha256, COALESCE(p_tool_calls, '[]'::jsonb),
      CASE WHEN p_outcome = 'ok' THEN NULL ELSE left(COALESCE(p_error_code, 'PROVIDER_ERROR'), 64) END);
  RETURN jsonb_build_object('ok', true, 'chargedCents', v_charge, 'journalId', v_j);
END $$;

-- ═══ Agent API ══════════════════════════════════════════════════════════
CREATE FUNCTION api_cognition_status(p_agent text, p_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'cognition_status');
BEGIN
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  RETURN jsonb_build_object('ok', true) || fleet_cognition_state(p_agent);
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
