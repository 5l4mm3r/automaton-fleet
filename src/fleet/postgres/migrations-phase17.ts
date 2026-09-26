/**
 * Schema v17 (pre-Step-4 accounting hardening, L13): sub-cent inference accounting.
 *
 * Until v16 every inference call was rounded UP to a whole cent (the real L14 probe: $0.0367 of provider cost
 * would have been charged $0.07). The ledger stays in integer cents, but each founder now carries an exact
 * integer MICROCENT accrual (1¢ = 1,000,000 µ¢; no floating point anywhere):
 *
 *   charged_µ¢  = provider usage: min(estimate·10⁶, cost_µ¢); estimate: estimate·10⁶; none: 0
 *   total       = unposted_µ¢ + charged_µ¢
 *   post        = floor(total / 10⁶) whole cents → one ledger journal (idempotent 'infer:<requestId>') when > 0
 *   unposted_µ¢ = total − post·10⁶   (0 ≤ unposted < 10⁶, carried, never forgiven, never rounded up)
 *
 * Invariant per founder: Σ posted·10⁶ + unposted = Σ charged_µ¢ (exact). The ledger lags the true cost by
 * less than one cent and never exceeds it. Gates stay fail closed and exact in µ¢, counting the unposted
 * remainder as already spent:
 *   - daily budget: Σ charged_µ¢ (24 h) + estimate·10⁶ ≤ budget·10⁶;
 *   - cash / survival equity: value·10⁶ − unposted ≥ estimate·10⁶;
 *   - prepaid credits: balance·10⁶ − Σ all founders' unposted ≥ estimate·10⁶.
 * Pre-v17 log rows have charged_microcents NULL; their exact value is charged_cents·10⁶ (they were posted in
 * whole cents), so history is read, never rewritten.
 */

export const V17_SQL = `
CREATE TABLE fleet_cognition_accrual (
  agent_id             text        PRIMARY KEY REFERENCES fleet_agents(agent_id),
  unposted_microcents  bigint      NOT NULL DEFAULT 0 CHECK (unposted_microcents >= 0 AND unposted_microcents < 1000000),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_cognition_accrual_no_delete BEFORE DELETE ON fleet_cognition_accrual
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_cognition_accrual_no_truncate BEFORE TRUNCATE ON fleet_cognition_accrual
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

ALTER TABLE fleet_cognition_log ADD COLUMN charged_microcents bigint CHECK (charged_microcents >= 0);

CREATE OR REPLACE FUNCTION fleet_cognition_state(p_agent text) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  WITH spent AS (
    SELECT COALESCE(sum(COALESCE(charged_microcents, charged_cents * 1000000)), 0)::bigint AS micro
      FROM fleet_cognition_log WHERE agent_id = p_agent AND at > now() - interval '1 day')
  SELECT jsonb_build_object(
    'policyEnabled', p.cognition_enabled, 'provider', p.provider, 'model', p.model, 'maxOutputTokens', p.max_output_tokens,
    'inputMicrocentsPerToken', p.input_microcents_per_token, 'outputMicrocentsPerToken', p.output_microcents_per_token,
    'cacheWriteMicrocentsPerToken', p.cache_write_microcents_per_token, 'cacheReadMicrocentsPerToken', p.cache_read_microcents_per_token,
    'founderEnabled', COALESCE(f.enabled, false), 'paused', COALESCE(f.paused, false),
    'dailyBudgetCents', COALESCE(f.daily_budget_cents, p.default_daily_budget_cents),
    'maxTurnsPerHour', COALESCE(f.max_turns_per_hour, p.default_max_turns_per_hour),
    'spentTodayMicrocents', spent.micro,
    'spentTodayCents', ceil(spent.micro / 1000000.0)::bigint,
    'unpostedMicrocents', COALESCE((SELECT unposted_microcents FROM fleet_cognition_accrual WHERE agent_id = p_agent), 0),
    'turnsLastHour', (SELECT count(*) FROM fleet_cognition_log WHERE agent_id = p_agent AND at > now() - interval '1 hour'),
    'inFlight', EXISTS (SELECT 1 FROM fleet_cognition_inflight WHERE agent_id = p_agent AND started_at > now() - interval '5 minutes'))
  FROM fleet_cognition_policy p LEFT JOIN fleet_founder_cognition f ON f.agent_id = p_agent CROSS JOIN spent WHERE p.id = 1
$$;

CREATE OR REPLACE FUNCTION svc_cognition_authorize(p_agent text, p_estimate_cents bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; s jsonb; e jsonb; v_id uuid := gen_random_uuid(); v_est bigint := GREATEST(COALESCE(p_estimate_cents, 0), 1);
        v_est_micro bigint; v_unposted bigint; v_all_unposted bigint;
BEGIN
  v_est_micro := v_est * 1000000;
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
  -- Exact, in µ¢: today's spend (including the unposted remainder) plus this call's reservation.
  IF (s ->> 'spentTodayMicrocents')::bigint + v_est_micro > (s ->> 'dailyBudgetCents')::bigint * 1000000 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_BUDGET_EXHAUSTED');
  END IF;
  PERFORM 1 FROM fleet_ledger_accounts WHERE account_id = fleet_ledger_account(p_agent, 'agent_cash') FOR UPDATE;
  v_unposted := (s ->> 'unpostedMicrocents')::bigint;
  e := fleet_agent_economics(p_agent);
  IF (e ->> 'cash')::bigint * 1000000 - v_unposted < v_est_micro THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INSUFFICIENT_ALLOCATION'); END IF;
  IF (e ->> 'survivalEquity')::bigint * 1000000 - v_unposted < v_est_micro THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PROTECTED_CAPITAL'); END IF;
  SELECT COALESCE(sum(unposted_microcents), 0) INTO v_all_unposted FROM fleet_cognition_accrual;
  IF fleet_ledger_balance('fleet:conway_credits') * 1000000 - v_all_unposted < v_est_micro THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_CREDITS_EXHAUSTED'); END IF;
  INSERT INTO fleet_cognition_inflight (agent_id, request_id, estimate_cents) VALUES (p_agent, v_id, v_est);
  RETURN jsonb_build_object('ok', true, 'requestId', v_id, 'estimateCents', v_est, 'provider', s ->> 'provider', 'model', s ->> 'model',
    'maxOutputTokens', s -> 'maxOutputTokens');
END $$;

CREATE OR REPLACE FUNCTION svc_cognition_record(p_agent text, p_request uuid, p_outcome text, p_input_tokens integer, p_output_tokens integer,
  p_prompt_sha256 text, p_response_sha256 text, p_tool_calls jsonb, p_error_code text,
  p_usage_source text, p_attempts integer, p_provider_status integer, p_response_model text, p_latency_ms integer,
  p_cache_read_tokens integer, p_cache_write_tokens integer, p_provider_request_id text, p_stop_reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE i fleet_cognition_inflight; p fleet_cognition_policy; v_cost bigint; v_micro bigint; v_charge bigint; v_j uuid;
        v_unposted bigint; v_total bigint;
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
  -- Exact µ¢ attributed to this call (never more than the reservation).
  v_micro := CASE v_src WHEN 'provider' THEN LEAST(i.estimate_cents * 1000000, v_cost) WHEN 'estimate' THEN i.estimate_cents * 1000000 ELSE 0 END;
  INSERT INTO fleet_cognition_accrual (agent_id) VALUES (p_agent) ON CONFLICT (agent_id) DO NOTHING;
  SELECT unposted_microcents INTO v_unposted FROM fleet_cognition_accrual WHERE agent_id = p_agent FOR UPDATE;
  v_total := v_unposted + v_micro;
  v_charge := v_total / 1000000;             -- whole cents to post (integer division: floor for non-negative)
  v_unposted := v_total - v_charge * 1000000; -- carried remainder, 0 ≤ r < 1¢
  IF v_charge > 0 THEN
    v_j := fleet_ledger_post('inference_charge', 'infer:' || p_request, 'controller', 'founder inference', 'controller', p_agent, NULL, NULL, NULL, NULL, now(),
      jsonb_build_array(
        jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_expense'), 'side', 'D', 'amount', v_charge),
        jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'C', 'amount', v_charge),
        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', v_charge),
        jsonb_build_object('account', 'fleet:conway_credits', 'side', 'C', 'amount', v_charge)));
  END IF;
  UPDATE fleet_cognition_accrual SET unposted_microcents = v_unposted, updated_at = now() WHERE agent_id = p_agent;
  DELETE FROM fleet_cognition_inflight WHERE agent_id = p_agent;
  INSERT INTO fleet_cognition_log (request_id, agent_id, provider, model, outcome, input_tokens, output_tokens, cost_microcents, charged_cents, journal_id,
      prompt_sha256, response_sha256, tool_calls, error_code, usage_source, attempts, provider_status, response_model, latency_ms,
      cache_read_tokens, cache_write_tokens, provider_request_id, stop_reason, charged_microcents)
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
      CASE WHEN p_stop_reason ~ '^[a-z_]{1,40}$' THEN p_stop_reason END, v_micro);
  RETURN jsonb_build_object('ok', true, 'chargedCents', v_charge, 'chargedMicrocents', v_micro, 'unpostedMicrocents', v_unposted,
    'journalId', v_j, 'usageSource', v_src);
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
