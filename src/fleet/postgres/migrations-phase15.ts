/**
 * Schema v15 (pre-Genesis cognition hardening, L1/L4): every inference outcome
 * is recorded, and its charge follows one explicit rule chosen by what is
 * known about the provider call (never by guesswork in the database):
 *
 *   usage_source 'provider' → charge = min(estimate, ceil(reported tokens × price))
 *   usage_source 'estimate' → charge = the authorized estimate (usage absent/invalid,
 *                             timeout, or connection lost after sending: ambiguous)
 *   usage_source 'none'     → charge = 0 (the provider answered with an error status
 *                             or was never reached; it did not bill)
 *
 * An 'ok' outcome can never be 'none' (no free successes). Error codes are
 * letters/underscores; anything else is recorded as PROVIDER_ERROR rather than
 * failing the record (a provider 429 used to violate the constraint, roll back
 * the record and leave the founder BUSY). The log gains attempts, HTTP status,
 * the provider's reported model and latency. One authorization is recorded at
 * most once (request_id UNIQUE, ledger idempotency 'infer:<requestId>', and the
 * in-flight row is consumed), so retries can never charge twice.
 */

export const V15_SQL = `
ALTER TABLE fleet_cognition_log
  ADD COLUMN usage_source    text     NOT NULL DEFAULT 'provider' CHECK (usage_source IN ('provider','estimate','none')),
  ADD COLUMN attempts        smallint NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 5),
  ADD COLUMN provider_status integer  CHECK (provider_status BETWEEN 100 AND 599),
  ADD COLUMN response_model  text     CHECK (response_model ~ '^[A-Za-z0-9._:/@-]{1,120}$'),
  ADD COLUMN latency_ms      integer  CHECK (latency_ms BETWEEN 0 AND 3600000),
  ADD CONSTRAINT fleet_cognition_log_ok_is_charged CHECK (outcome <> 'ok' OR usage_source <> 'none'),
  ADD CONSTRAINT fleet_cognition_log_error_has_code CHECK (outcome = 'ok' OR error_code IS NOT NULL);

DROP FUNCTION svc_cognition_record(text, uuid, text, integer, integer, text, text, jsonb, text);

CREATE FUNCTION svc_cognition_record(p_agent text, p_request uuid, p_outcome text, p_input_tokens integer, p_output_tokens integer,
  p_prompt_sha256 text, p_response_sha256 text, p_tool_calls jsonb, p_error_code text,
  p_usage_source text, p_attempts integer, p_provider_status integer, p_response_model text, p_latency_ms integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE i fleet_cognition_inflight; p fleet_cognition_policy; v_cost bigint; v_charge bigint; v_j uuid;
        v_ok boolean := p_outcome = 'ok';
        v_src text := CASE WHEN p_usage_source IN ('provider','estimate','none') THEN p_usage_source ELSE 'estimate' END;
        v_in bigint := GREATEST(COALESCE(p_input_tokens, 0), 0); v_out bigint := GREATEST(COALESCE(p_output_tokens, 0), 0);
BEGIN
  SELECT * INTO i FROM fleet_cognition_inflight WHERE agent_id = p_agent AND request_id = p_request FOR UPDATE;
  IF NOT FOUND THEN
    -- Already recorded (or never authorized): never a second charge.
    RETURN jsonb_build_object('ok', false, 'code', CASE WHEN EXISTS (SELECT 1 FROM fleet_cognition_log WHERE request_id = p_request)
      THEN 'FLEET_COGNITION_ALREADY_RECORDED' ELSE 'FLEET_COGNITION_NOT_AUTHORIZED' END);
  END IF;
  -- A success must be paid for: usage-less success is charged the estimate.
  IF v_ok AND v_src = 'none' THEN v_src := 'estimate'; END IF;
  SELECT * INTO p FROM fleet_cognition_policy WHERE id = 1;
  v_cost := CASE v_src WHEN 'provider' THEN v_in * p.input_microcents_per_token + v_out * p.output_microcents_per_token
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
      prompt_sha256, response_sha256, tool_calls, error_code, usage_source, attempts, provider_status, response_model, latency_ms)
    VALUES (p_request, p_agent, p.provider, p.model, CASE WHEN v_ok THEN 'ok' ELSE 'error' END,
      CASE WHEN v_src = 'provider' THEN v_in ELSE 0 END, CASE WHEN v_src = 'provider' THEN v_out ELSE 0 END, v_cost, v_charge, v_j,
      p_prompt_sha256, p_response_sha256, CASE WHEN v_ok THEN COALESCE(p_tool_calls, '[]'::jsonb) ELSE '[]'::jsonb END,
      CASE WHEN v_ok THEN NULL WHEN p_error_code ~ '^[A-Z_]{2,64}$' THEN p_error_code ELSE 'PROVIDER_ERROR' END,
      v_src, LEAST(GREATEST(COALESCE(p_attempts, 1), 1), 5),
      CASE WHEN p_provider_status BETWEEN 100 AND 599 THEN p_provider_status END,
      CASE WHEN p_response_model ~ '^[A-Za-z0-9._:/@-]{1,120}$' THEN p_response_model END,
      CASE WHEN p_latency_ms BETWEEN 0 AND 3600000 THEN p_latency_ms END);
  RETURN jsonb_build_object('ok', true, 'chargedCents', v_charge, 'journalId', v_j, 'usageSource', v_src);
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
