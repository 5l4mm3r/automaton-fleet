/**
 * Schema v16 (Pre-Genesis step 2.1, native Anthropic cognition):
 *
 *  - provider 'anthropic' (native Messages API) joins 'openai_compatible'/'scripted';
 *  - cache-aware usage: the log records cache-read and cache-write input tokens
 *    separately (canonical input_tokens EXCLUDE cached input), the provider's
 *    response id (invoice/log reconciliation) and the stop reason;
 *  - cache prices are optional policy fields. When unset they fall back
 *    CONSERVATIVELY: cache reads at the input price (providers bill them below
 *    it), cache writes at the OUTPUT price (above any provider's cache-write
 *    rate). A founder is never undercharged because a price was not configured.
 *
 * Charge rule (usage_source 'provider'), still capped at the authorized estimate:
 *   in·p_in + out·p_out + cache_write·COALESCE(p_cw, p_out) + cache_read·COALESCE(p_cr, p_in)
 * 'estimate' and 'none' are unchanged from v15.
 */

export const V16_SQL = `
ALTER TABLE fleet_cognition_policy DROP CONSTRAINT fleet_cognition_policy_provider_check;
ALTER TABLE fleet_cognition_policy ADD CONSTRAINT fleet_cognition_policy_provider_check CHECK (provider IN ('none','scripted','openai_compatible','anthropic'));
ALTER TABLE fleet_cognition_policy
  ADD COLUMN cache_write_microcents_per_token bigint CHECK (cache_write_microcents_per_token >= 0),
  ADD COLUMN cache_read_microcents_per_token  bigint CHECK (cache_read_microcents_per_token >= 0);

ALTER TABLE fleet_cognition_log
  ADD COLUMN cache_read_tokens   integer NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  ADD COLUMN cache_write_tokens  integer NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  ADD COLUMN provider_request_id text CHECK (provider_request_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  ADD COLUMN stop_reason         text CHECK (stop_reason ~ '^[a-z_]{1,40}$');

DROP FUNCTION fleet_cognition_set_policy(boolean, text, text, integer, bigint, bigint, bigint, integer, text);
CREATE FUNCTION fleet_cognition_set_policy(p_enabled boolean, p_provider text, p_model text, p_max_output_tokens integer,
  p_input_microcents bigint, p_output_microcents bigint, p_daily_budget_cents bigint, p_max_turns integer, p_actor text,
  p_cache_write_microcents bigint, p_cache_read_microcents bigint) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_cognition_policy;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_cognition');
  UPDATE fleet_cognition_policy SET cognition_enabled = p_enabled, provider = COALESCE(p_provider, provider), model = COALESCE(p_model, model),
         max_output_tokens = COALESCE(p_max_output_tokens, max_output_tokens),
         input_microcents_per_token = COALESCE(p_input_microcents, input_microcents_per_token),
         output_microcents_per_token = COALESCE(p_output_microcents, output_microcents_per_token),
         cache_write_microcents_per_token = COALESCE(p_cache_write_microcents, cache_write_microcents_per_token),
         cache_read_microcents_per_token = COALESCE(p_cache_read_microcents, cache_read_microcents_per_token),
         default_daily_budget_cents = COALESCE(p_daily_budget_cents, default_daily_budget_cents),
         default_max_turns_per_hour = COALESCE(p_max_turns, default_max_turns_per_hour),
         updated_by = p_actor, updated_at = now()
   WHERE id = 1 RETURNING * INTO p;
  PERFORM fleet_event(CASE WHEN p_enabled THEN 'cognition_enabled' ELSE 'cognition_disabled' END, NULL, p_actor,
    jsonb_build_object('provider', p.provider, 'model', p.model));
  RETURN to_jsonb(p);
END $$;

CREATE OR REPLACE FUNCTION fleet_cognition_state(p_agent text) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'policyEnabled', p.cognition_enabled, 'provider', p.provider, 'model', p.model, 'maxOutputTokens', p.max_output_tokens,
    'inputMicrocentsPerToken', p.input_microcents_per_token, 'outputMicrocentsPerToken', p.output_microcents_per_token,
    'cacheWriteMicrocentsPerToken', p.cache_write_microcents_per_token, 'cacheReadMicrocentsPerToken', p.cache_read_microcents_per_token,
    'founderEnabled', COALESCE(f.enabled, false), 'paused', COALESCE(f.paused, false),
    'dailyBudgetCents', COALESCE(f.daily_budget_cents, p.default_daily_budget_cents),
    'maxTurnsPerHour', COALESCE(f.max_turns_per_hour, p.default_max_turns_per_hour),
    'spentTodayCents', (SELECT COALESCE(sum(charged_cents), 0) FROM fleet_cognition_log WHERE agent_id = p_agent AND at > now() - interval '1 day'),
    'turnsLastHour', (SELECT count(*) FROM fleet_cognition_log WHERE agent_id = p_agent AND at > now() - interval '1 hour'),
    'inFlight', EXISTS (SELECT 1 FROM fleet_cognition_inflight WHERE agent_id = p_agent AND started_at > now() - interval '5 minutes'))
  FROM fleet_cognition_policy p LEFT JOIN fleet_founder_cognition f ON f.agent_id = p_agent WHERE p.id = 1
$$;

DROP FUNCTION svc_cognition_record(text, uuid, text, integer, integer, text, text, jsonb, text, text, integer, integer, text, integer);
CREATE FUNCTION svc_cognition_record(p_agent text, p_request uuid, p_outcome text, p_input_tokens integer, p_output_tokens integer,
  p_prompt_sha256 text, p_response_sha256 text, p_tool_calls jsonb, p_error_code text,
  p_usage_source text, p_attempts integer, p_provider_status integer, p_response_model text, p_latency_ms integer,
  p_cache_read_tokens integer, p_cache_write_tokens integer, p_provider_request_id text, p_stop_reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE i fleet_cognition_inflight; p fleet_cognition_policy; v_cost bigint; v_charge bigint; v_j uuid;
        v_ok boolean := p_outcome = 'ok';
        v_src text := CASE WHEN p_usage_source IN ('provider','estimate','none') THEN p_usage_source ELSE 'estimate' END;
        v_in bigint := GREATEST(COALESCE(p_input_tokens, 0), 0); v_out bigint := GREATEST(COALESCE(p_output_tokens, 0), 0);
        v_cr bigint := GREATEST(COALESCE(p_cache_read_tokens, 0), 0); v_cw bigint := GREATEST(COALESCE(p_cache_write_tokens, 0), 0);
BEGIN
  SELECT * INTO i FROM fleet_cognition_inflight WHERE agent_id = p_agent AND request_id = p_request FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', CASE WHEN EXISTS (SELECT 1 FROM fleet_cognition_log WHERE request_id = p_request)
      THEN 'FLEET_COGNITION_ALREADY_RECORDED' ELSE 'FLEET_COGNITION_NOT_AUTHORIZED' END);
  END IF;
  IF v_ok AND v_src = 'none' THEN v_src := 'estimate'; END IF;
  SELECT * INTO p FROM fleet_cognition_policy WHERE id = 1;
  v_cost := CASE v_src
    WHEN 'provider' THEN v_in * p.input_microcents_per_token + v_out * p.output_microcents_per_token
                       + v_cw * COALESCE(p.cache_write_microcents_per_token, p.output_microcents_per_token)
                       + v_cr * COALESCE(p.cache_read_microcents_per_token, p.input_microcents_per_token)
    WHEN 'estimate' THEN i.estimate_cents * 1000000 ELSE 0 END;
  v_charge := CASE v_src WHEN 'provider' THEN LEAST(i.estimate_cents, ceil(v_cost / 1000000.0)::bigint)
                         WHEN 'estimate' THEN i.estimate_cents ELSE 0 END;
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
      prompt_sha256, response_sha256, tool_calls, error_code, usage_source, attempts, provider_status, response_model, latency_ms,
      cache_read_tokens, cache_write_tokens, provider_request_id, stop_reason)
    VALUES (p_request, p_agent, p.provider, p.model, CASE WHEN v_ok THEN 'ok' ELSE 'error' END,
      CASE WHEN v_src = 'provider' THEN v_in ELSE 0 END, CASE WHEN v_src = 'provider' THEN v_out ELSE 0 END, v_cost, v_charge, v_j,
      p_prompt_sha256, p_response_sha256, CASE WHEN v_ok THEN COALESCE(p_tool_calls, '[]'::jsonb) ELSE '[]'::jsonb END,
      CASE WHEN v_ok THEN NULL WHEN p_error_code ~ '^[A-Z_]{2,64}$' THEN p_error_code ELSE 'PROVIDER_ERROR' END,
      v_src, LEAST(GREATEST(COALESCE(p_attempts, 1), 1), 5),
      CASE WHEN p_provider_status BETWEEN 100 AND 599 THEN p_provider_status END,
      CASE WHEN p_response_model ~ '^[A-Za-z0-9._:/@-]{1,120}$' THEN p_response_model END,
      CASE WHEN p_latency_ms BETWEEN 0 AND 3600000 THEN p_latency_ms END,
      CASE WHEN v_src = 'provider' THEN v_cr ELSE 0 END, CASE WHEN v_src = 'provider' THEN v_cw ELSE 0 END,
      CASE WHEN p_provider_request_id ~ '^[A-Za-z0-9_.:-]{1,128}$' THEN p_provider_request_id END,
      CASE WHEN p_stop_reason ~ '^[a-z_]{1,40}$' THEN p_stop_reason END);
  RETURN jsonb_build_object('ok', true, 'chargedCents', v_charge, 'journalId', v_j, 'usageSource', v_src);
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
