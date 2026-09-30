/**
 * Schema v22 — neutral cognition routing (INERT until the owner verifies and enables it).
 *
 * Additive only. The legacy single-model path (svc_cognition_authorize / svc_cognition_record, fleet_cognition_policy)
 * is unchanged and remains the path of every founder that has not been opted in, including Founder 1.
 *
 *   fleet_cognition_routing   singleton: routing switch (default OFF), major-spend threshold, guard windows
 *   fleet_cognition_tiers     T1..T3 → provider/model/thinking/effort/max output/prices (policy DATA; seeded
 *                             disabled and unverified; a tier cannot be enabled unless verified)
 *   fleet_founder_routing     per-founder opt-in (absent = legacy path)
 *   fleet_action_min_tier     consequential action class → minimum tier of the producing cognition
 *   fleet_action_cognition_links  single-use links action ↔ producing cognition call (append-only)
 *   fleet_cognition_inflight  + the route snapshot reserved at authorization (tier, model, prices)
 *   fleet_cognition_log       + routing observability columns (NULL on legacy rows)
 *
 * svc_cognition_routed_authorize wraps the legacy authorize (so every switch, pause, rate limit, budget, cash,
 * protected-capital and provider-credit circuit breaker still applies) and then snapshots the route; it also refuses
 * an identical prompt after a non-transient failure (duplicate-failure guard). svc_cognition_routed_record charges at
 * the snapshot prices and writes the routing columns. svc_action_cognition_verify enforces the consequential-action
 * boundary from the controller's own record (never the founder's label). Nothing here reads commercial history.
 */

export const V22_SQL = `
-- ═══ 1. Policy data ═══
CREATE TABLE fleet_cognition_routing (
  id                          smallint    PRIMARY KEY CHECK (id = 1),
  routing_enabled             boolean     NOT NULL DEFAULT false,
  major_spend_threshold_minor bigint      NOT NULL DEFAULT 2000 CHECK (major_spend_threshold_minor > 0),
  duplicate_failure_window_s  integer     NOT NULL DEFAULT 600 CHECK (duplicate_failure_window_s BETWEEN 0 AND 86400),
  action_link_window_s        integer     NOT NULL DEFAULT 1800 CHECK (action_link_window_s BETWEEN 60 AND 86400),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  updated_by                  text        NOT NULL DEFAULT 'migration'
);
INSERT INTO fleet_cognition_routing (id) VALUES (1);
CREATE TRIGGER fleet_cognition_routing_no_delete BEFORE DELETE OR TRUNCATE ON fleet_cognition_routing
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_cognition_tiers (
  tier                              text        PRIMARY KEY CHECK (tier IN ('T1','T2','T3')),
  provider                          text        NOT NULL CHECK (provider IN ('anthropic')),
  model                             text        NOT NULL CHECK (model ~ '^[A-Za-z0-9._:/@-]{1,120}$'),
  thinking                          text        CHECK (thinking IN ('adaptive')),
  effort                            text        CHECK (effort IN ('low','medium','high','max')),
  max_output_tokens                 integer     NOT NULL CHECK (max_output_tokens BETWEEN 256 AND 64000),
  input_microcents_per_token        bigint      NOT NULL CHECK (input_microcents_per_token >= 0),
  output_microcents_per_token       bigint      NOT NULL CHECK (output_microcents_per_token >= 0),
  cache_write_microcents_per_token  bigint      NOT NULL CHECK (cache_write_microcents_per_token >= 0),
  cache_read_microcents_per_token   bigint      NOT NULL CHECK (cache_read_microcents_per_token >= 0),
  enabled                           boolean     NOT NULL DEFAULT false,
  verified_at                       timestamptz,
  verified_ref                      text        CHECK (length(verified_ref) BETWEEN 3 AND 300),
  updated_at                        timestamptz NOT NULL DEFAULT now(),
  updated_by                        text        NOT NULL DEFAULT 'migration',
  CONSTRAINT fleet_cognition_tiers_enabled_requires_verified CHECK (NOT enabled OR verified_at IS NOT NULL)
);
-- Baseline candidates (FleetAdmin 2026-09-30). Prices: platform.claude.com pricing, fetched 2026-09-30, USD µ¢/token.
-- Seeded DISABLED and UNVERIFIED: each must be verified against the Fleet provider account before it can be enabled.
INSERT INTO fleet_cognition_tiers (tier, provider, model, thinking, effort, max_output_tokens,
    input_microcents_per_token, output_microcents_per_token, cache_write_microcents_per_token, cache_read_microcents_per_token) VALUES
  ('T1', 'anthropic', 'claude-haiku-4-5-20251001', NULL,       NULL,     2000, 100,  500, 125, 10),
  ('T2', 'anthropic', 'claude-sonnet-5-5',         'adaptive', 'medium', 8000, 200, 1000, 250, 20),
  ('T3', 'anthropic', 'claude-opus-5-5',           'adaptive', 'medium', 8000, 400, 2000, 500, 20);
CREATE TRIGGER fleet_cognition_tiers_no_delete BEFORE DELETE OR TRUNCATE ON fleet_cognition_tiers
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_founder_routing (
  agent_id   text        PRIMARY KEY REFERENCES fleet_agents(agent_id),
  enabled    boolean     NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text        NOT NULL
);

CREATE TABLE fleet_action_min_tier (
  action_class text PRIMARY KEY CHECK (action_class ~ '^[a-z_]{3,48}$'),
  min_tier     text NOT NULL CHECK (min_tier IN ('T1','T2','T3')),
  description  text NOT NULL
);
INSERT INTO fleet_action_min_tier VALUES
  ('spend_request',             'T2', 'a spend order below the major-spend threshold'),
  ('major_spend_request',       'T3', 'a spend order at or above the major-spend threshold'),
  ('knowledge_policy_proposal', 'T2', 'a proposed fleet knowledge item of category policy'),
  ('reproduction_request',      'T3', 'any reproduction request (reproduction itself remains OFF)');
CREATE TRIGGER fleet_action_min_tier_no_change BEFORE UPDATE OR DELETE ON fleet_action_min_tier
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_action_min_tier_no_truncate BEFORE TRUNCATE ON fleet_action_min_tier
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_action_cognition_links (
  request_id    uuid        NOT NULL,
  tool_call_id  text        NOT NULL CHECK (tool_call_id ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  agent_id      text        NOT NULL REFERENCES fleet_agents(agent_id),
  action_class  text        NOT NULL REFERENCES fleet_action_min_tier(action_class),
  action_sha256 text        NOT NULL CHECK (action_sha256 ~ '^[0-9a-f]{64}$'),
  tier          text        NOT NULL CHECK (tier IN ('T1','T2','T3')),
  linked_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, tool_call_id)
);
CREATE TRIGGER fleet_action_cognition_links_no_change BEFORE UPDATE OR DELETE ON fleet_action_cognition_links
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_action_cognition_links_no_truncate BEFORE TRUNCATE ON fleet_action_cognition_links
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ═══ 2. Route snapshot and observability ═══
ALTER TABLE fleet_cognition_inflight
  ADD COLUMN route_tier     text   CHECK (route_tier IN ('T1','T2','T3')),
  ADD COLUMN route_provider text,
  ADD COLUMN route_model    text,
  ADD COLUMN route_prices   jsonb,
  ADD COLUMN route          jsonb  CHECK (route IS NULL OR length(route::text) <= 4096);

ALTER TABLE fleet_cognition_log
  ADD COLUMN route_version     smallint CHECK (route_version = 1),
  ADD COLUMN task_id           text     CHECK (task_id ~ '^[A-Za-z0-9:_.-]{1,64}$'),
  ADD COLUMN task_class        text     CHECK (task_class ~ '^[a-z_]{3,48}$'),
  ADD COLUMN tier              text     CHECK (tier IN ('T1','T2','T3')),
  ADD COLUMN requested_tier    text     CHECK (requested_tier IN ('T1','T2','T3')),
  ADD COLUMN escalation_reason text     CHECK (escalation_reason ~ '^[A-Z_]{3,40}$'),
  ADD COLUMN router_decision   jsonb    CHECK (router_decision IS NULL OR length(router_decision::text) <= 2048),
  ADD COLUMN parent_request_id uuid,
  ADD COLUMN reasoning         jsonb    CHECK (reasoning IS NULL OR length(reasoning::text) <= 256),
  ADD COLUMN packet_bytes      integer  CHECK (packet_bytes BETWEEN 0 AND 1000000),
  ADD COLUMN thinking_tokens   integer  CHECK (thinking_tokens >= 0);
CREATE INDEX fleet_cognition_log_prompt_idx ON fleet_cognition_log (agent_id, prompt_sha256, at);

-- ═══ 3. Controller (service) functions ═══
CREATE FUNCTION fleet_routing_active(p_agent text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE((SELECT routing_enabled FROM fleet_cognition_routing WHERE id = 1), false)
     AND COALESCE((SELECT enabled FROM fleet_founder_routing WHERE agent_id = p_agent), false)
$$;

CREATE FUNCTION svc_cognition_routing_state(p_agent text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'routingEnabled', fleet_routing_active(p_agent),
    'globalEnabled', r.routing_enabled,
    'majorSpendThresholdMinor', r.major_spend_threshold_minor,
    -- The model behind this founder's most recent call: provider-bound thinking is only handed back to the same model.
    'lastModel', (SELECT l.model FROM fleet_cognition_log l WHERE l.agent_id = p_agent ORDER BY l.seq DESC LIMIT 1),
    'tiers', (SELECT COALESCE(jsonb_agg(jsonb_build_object('tier', t.tier, 'provider', t.provider, 'model', t.model, 'thinking', t.thinking,
                'effort', t.effort, 'maxOutputTokens', t.max_output_tokens, 'enabled', t.enabled, 'verifiedAt', t.verified_at,
                'prices', jsonb_build_object('inputMicrocentsPerToken', t.input_microcents_per_token, 'outputMicrocentsPerToken', t.output_microcents_per_token,
                  'cacheWriteMicrocentsPerToken', t.cache_write_microcents_per_token, 'cacheReadMicrocentsPerToken', t.cache_read_microcents_per_token))
                ORDER BY t.tier), '[]'::jsonb) FROM fleet_cognition_tiers t))
  FROM fleet_cognition_routing r WHERE r.id = 1
$$;

CREATE FUNCTION svc_cognition_routed_authorize(p_agent text, p_estimate_usd_cents bigint, p_route jsonb, p_prompt_sha256 text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE rt fleet_cognition_routing; t fleet_cognition_tiers; r jsonb; v_tier text := p_route ->> 'tier';
BEGIN
  SELECT * INTO rt FROM fleet_cognition_routing WHERE id = 1;
  IF NOT fleet_routing_active(p_agent) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ROUTING_DISABLED'); END IF;
  IF p_route IS NULL OR jsonb_typeof(p_route) <> 'object' OR length(p_route::text) > 4096 OR v_tier IS NULL OR v_tier NOT IN ('T1','T2','T3')
     OR COALESCE(p_route ->> 'taskClass', '') !~ '^[a-z_]{3,48}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ROUTE_INVALID');
  END IF;
  SELECT * INTO t FROM fleet_cognition_tiers WHERE tier = v_tier;
  IF NOT FOUND OR NOT t.enabled THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_TIER_UNAVAILABLE'); END IF;
  IF t.verified_at IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_TIER_UNVERIFIED'); END IF;
  -- The controller's candidate must be exactly the owner's mapping (no silent substitution).
  IF (p_route ->> 'model') IS DISTINCT FROM t.model OR (p_route ->> 'provider') IS DISTINCT FROM t.provider THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_MODEL_MISMATCH');
  END IF;
  -- Loop economics: the identical prompt after a non-transient failure is refused before the provider (uncharged).
  IF p_prompt_sha256 ~ '^[0-9a-f]{64}$' AND rt.duplicate_failure_window_s > 0 AND EXISTS (
       SELECT 1 FROM fleet_cognition_log WHERE agent_id = p_agent AND prompt_sha256 = p_prompt_sha256 AND outcome = 'error'
         AND error_code IN ('PROVIDER_BAD_REQUEST','PROVIDER_CONFIG_INVALID','PROVIDER_MALFORMED_RESPONSE')
         AND at > now() - make_interval(secs => rt.duplicate_failure_window_s)) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_DUPLICATE_FAILURE');
  END IF;
  -- Every legacy circuit breaker (switches, pause, busy, rate, daily budget, FX, cash, protected capital, provider credit).
  r := svc_cognition_authorize(p_agent, p_estimate_usd_cents);
  IF (r ->> 'ok')::boolean IS NOT TRUE THEN RETURN r; END IF;
  UPDATE fleet_cognition_inflight SET route_tier = t.tier, route_provider = t.provider, route_model = t.model,
    route_prices = jsonb_build_object('in', t.input_microcents_per_token, 'out', t.output_microcents_per_token,
                                      'cw', t.cache_write_microcents_per_token, 'cr', t.cache_read_microcents_per_token),
    route = p_route
   WHERE agent_id = p_agent AND request_id = (r ->> 'requestId')::uuid;
  RETURN r || jsonb_build_object('tier', t.tier, 'provider', t.provider, 'model', t.model, 'maxOutputTokens', t.max_output_tokens);
END $$;

CREATE FUNCTION svc_cognition_routed_record(p_agent text, p_request uuid, p_outcome text, p_input_tokens integer, p_output_tokens integer,
  p_prompt_sha256 text, p_response_sha256 text, p_tool_calls jsonb, p_error_code text,
  p_usage_source text, p_attempts integer, p_provider_status integer, p_response_model text, p_latency_ms integer,
  p_cache_read_tokens integer, p_cache_write_tokens integer, p_provider_request_id text, p_stop_reason text,
  p_obs jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE i fleet_cognition_inflight; v_cost bigint; v_used_usd bigint; v_cost_l bigint; v_micro bigint; v_charge bigint; v_j uuid;
        v_unposted bigint; v_total bigint; v_rate bigint; v_acct text;
        v_ok boolean := p_outcome = 'ok';
        v_src text := CASE WHEN p_usage_source IN ('provider','estimate','none') THEN p_usage_source ELSE 'estimate' END;
        v_in bigint := GREATEST(COALESCE(p_input_tokens, 0), 0); v_out bigint := GREATEST(COALESCE(p_output_tokens, 0), 0);
        v_cr bigint := GREATEST(COALESCE(p_cache_read_tokens, 0), 0); v_cw bigint := GREATEST(COALESCE(p_cache_write_tokens, 0), 0);
        rp jsonb; ro jsonb; v_obs jsonb := COALESCE(p_obs, '{}'::jsonb);
BEGIN
  SELECT * INTO i FROM fleet_cognition_inflight WHERE agent_id = p_agent AND request_id = p_request FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', CASE WHEN EXISTS (SELECT 1 FROM fleet_cognition_log WHERE request_id = p_request)
      THEN 'FLEET_COGNITION_ALREADY_RECORDED' ELSE 'FLEET_COGNITION_NOT_AUTHORIZED' END);
  END IF;
  -- Only a routed authorization is recorded here (its prices are the snapshot, not the legacy policy's).
  IF i.route_tier IS NULL OR i.route_prices IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ROUTE_NOT_AUTHORIZED'); END IF;
  IF v_ok AND v_src = 'none' THEN v_src := 'estimate'; END IF;
  rp := i.route_prices; ro := COALESCE(i.route, '{}'::jsonb);
  SELECT accounting_currency INTO v_acct FROM fleet_economic_model WHERE id = 1;
  v_rate := COALESCE(i.fx_rate_micro, 1000000);
  v_cost := CASE v_src
    WHEN 'provider' THEN v_in * (rp ->> 'in')::bigint + v_out * (rp ->> 'out')::bigint + v_cw * (rp ->> 'cw')::bigint + v_cr * (rp ->> 'cr')::bigint
    WHEN 'estimate' THEN COALESCE(i.estimate_usd_cents, i.estimate_cents) * 1000000 ELSE 0 END;
  v_used_usd := v_cost;
  v_cost_l := ceil(v_cost::numeric * v_rate / 1000000)::bigint;
  v_micro := CASE v_src WHEN 'provider' THEN LEAST(i.estimate_cents * 1000000, v_cost_l) WHEN 'estimate' THEN i.estimate_cents * 1000000 ELSE 0 END;
  INSERT INTO fleet_cognition_accrual (agent_id) VALUES (p_agent) ON CONFLICT (agent_id) DO NOTHING;
  SELECT unposted_microcents INTO v_unposted FROM fleet_cognition_accrual WHERE agent_id = p_agent FOR UPDATE;
  v_total := v_unposted + v_micro;
  v_charge := v_total / 1000000;
  v_unposted := v_total - v_charge * 1000000;
  IF v_charge > 0 THEN
    v_j := fleet_ledger_post('inference_charge', 'infer:' || p_request, 'controller', 'founder inference', 'controller', p_agent, NULL, NULL, NULL, NULL, now(),
      jsonb_build_array(
        jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_expense'), 'side', 'D', 'amount', v_charge),
        jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'C', 'amount', v_charge)));
  END IF;
  UPDATE fleet_cognition_accrual SET unposted_microcents = v_unposted, updated_at = now() WHERE agent_id = p_agent;
  IF v_used_usd > 0 THEN
    INSERT INTO fleet_provider_credit_events (provider, kind, usd_microcents, request_id, recorded_by)
      VALUES (i.route_provider, 'consumption', -v_used_usd, p_request, 'controller');
  END IF;
  DELETE FROM fleet_cognition_inflight WHERE agent_id = p_agent;
  INSERT INTO fleet_cognition_log (request_id, agent_id, provider, model, outcome, input_tokens, output_tokens, cost_microcents, charged_cents, journal_id,
      prompt_sha256, response_sha256, tool_calls, error_code, usage_source, attempts, provider_status, response_model, latency_ms,
      cache_read_tokens, cache_write_tokens, provider_request_id, stop_reason, charged_microcents,
      ledger_currency, fx_rate_id, fx_rate_micro, provider_usd_microcents,
      route_version, task_id, task_class, tier, requested_tier, escalation_reason, router_decision, parent_request_id, reasoning, packet_bytes, thinking_tokens)
    VALUES (p_request, p_agent, i.route_provider, i.route_model, CASE WHEN v_ok THEN 'ok' ELSE 'error' END,
      CASE WHEN v_src = 'provider' THEN v_in ELSE 0 END, CASE WHEN v_src = 'provider' THEN v_out ELSE 0 END, v_cost, v_charge, v_j,
      p_prompt_sha256, p_response_sha256, CASE WHEN v_ok THEN COALESCE(p_tool_calls, '[]'::jsonb) ELSE '[]'::jsonb END,
      CASE WHEN v_ok THEN NULL WHEN p_error_code ~ '^[A-Z_]{2,64}$' THEN p_error_code ELSE 'PROVIDER_ERROR' END,
      v_src, LEAST(GREATEST(COALESCE(p_attempts, 1), 1), 5),
      CASE WHEN p_provider_status BETWEEN 100 AND 599 THEN p_provider_status END,
      CASE WHEN p_response_model ~ '^[A-Za-z0-9._:/@-]{1,120}$' THEN p_response_model END,
      CASE WHEN p_latency_ms BETWEEN 0 AND 3600000 THEN p_latency_ms END,
      CASE WHEN v_src = 'provider' THEN v_cr ELSE 0 END, CASE WHEN v_src = 'provider' THEN v_cw ELSE 0 END,
      CASE WHEN p_provider_request_id ~ '^[A-Za-z0-9_.:-]{1,128}$' THEN p_provider_request_id END,
      CASE WHEN p_stop_reason ~ '^[a-z_]{1,40}$' THEN p_stop_reason END, v_micro,
      v_acct, i.fx_rate_id, v_rate, v_used_usd,
      1,
      CASE WHEN ro ->> 'taskId' ~ '^[A-Za-z0-9:_.-]{1,64}$' THEN ro ->> 'taskId' END,
      CASE WHEN ro ->> 'taskClass' ~ '^[a-z_]{3,48}$' THEN ro ->> 'taskClass' END,
      i.route_tier,
      CASE WHEN ro ->> 'requestedTier' IN ('T1','T2','T3') THEN ro ->> 'requestedTier' END,
      CASE WHEN ro ->> 'escalationReason' ~ '^[A-Z_]{3,40}$' THEN ro ->> 'escalationReason' END,
      jsonb_build_object('source', ro ->> 'source', 'scope', ro ->> 'scope', 'minTier', ro ->> 'minTier', 'maxTier', ro ->> 'maxTier'),
      CASE WHEN ro ->> 'parentRequestId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (ro ->> 'parentRequestId')::uuid END,
      jsonb_build_object('thinking', ro ->> 'thinking', 'effort', ro ->> 'effort', 'promptCache', v_obs ->> 'promptCache'),
      CASE WHEN (v_obs ->> 'packetBytes') ~ '^[0-9]{1,7}$' THEN (v_obs ->> 'packetBytes')::integer END,
      CASE WHEN (v_obs ->> 'thinkingTokens') ~ '^[0-9]{1,9}$' THEN (v_obs ->> 'thinkingTokens')::integer END);
  RETURN jsonb_build_object('ok', true, 'chargedCents', v_charge, 'chargedMicrocents', v_micro, 'unpostedMicrocents', v_unposted,
    'journalId', v_j, 'usageSource', v_src, 'currency', v_acct, 'fxRateMicro', v_rate, 'providerUsdMicrocents', v_used_usd,
    'tier', i.route_tier, 'model', i.route_model);
END $$;

-- Consequential-action boundary: the cognition that produced an action must have run at the action class's minimum
-- tier. Decided from the controller's own log (tier recorded by the router), never from the founder's label; each
-- link is single-use; the action digest must match. Founders not on routing: not enforced (legacy path, unchanged).
CREATE FUNCTION svc_action_cognition_verify(p_agent text, p_action_class text, p_amount_minor bigint, p_tool_call_id text, p_action_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE rt fleet_cognition_routing; v_class text := p_action_class; v_min text; l fleet_cognition_log;
BEGIN
  IF NOT fleet_routing_active(p_agent) THEN RETURN jsonb_build_object('ok', true, 'enforced', false); END IF;
  SELECT * INTO rt FROM fleet_cognition_routing WHERE id = 1;
  IF v_class = 'spend_request' AND COALESCE(p_amount_minor, 0) >= rt.major_spend_threshold_minor THEN v_class := 'major_spend_request'; END IF;
  SELECT min_tier INTO v_min FROM fleet_action_min_tier WHERE action_class = v_class;
  IF v_min IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ACTION_CLASS_UNKNOWN'); END IF;
  IF p_tool_call_id IS NULL OR p_tool_call_id !~ '^[A-Za-z0-9_.:-]{1,64}$' OR p_action_sha256 IS NULL OR p_action_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ACTION_COGNITION_MISSING', 'actionClass', v_class, 'minTier', v_min);
  END IF;
  SELECT * INTO l FROM fleet_cognition_log
   WHERE agent_id = p_agent AND outcome = 'ok' AND tier IS NOT NULL
     AND at > now() - make_interval(secs => rt.action_link_window_s)
     AND tool_calls @> jsonb_build_array(jsonb_build_object('id', p_tool_call_id, 'actionSha256', p_action_sha256))
   ORDER BY seq DESC LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ACTION_COGNITION_MISSING', 'actionClass', v_class, 'minTier', v_min); END IF;
  IF array_position(ARRAY['T1','T2','T3'], l.tier) < array_position(ARRAY['T1','T2','T3'], v_min) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ACTION_COGNITION_TIER', 'actionClass', v_class, 'minTier', v_min, 'tier', l.tier, 'requestId', l.request_id);
  END IF;
  IF EXISTS (SELECT 1 FROM fleet_action_cognition_links WHERE request_id = l.request_id AND tool_call_id = p_tool_call_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ACTION_COGNITION_REUSED', 'actionClass', v_class);
  END IF;
  INSERT INTO fleet_action_cognition_links (request_id, tool_call_id, agent_id, action_class, action_sha256, tier)
    VALUES (l.request_id, p_tool_call_id, p_agent, v_class, p_action_sha256, l.tier);
  RETURN jsonb_build_object('ok', true, 'enforced', true, 'actionClass', v_class, 'minTier', v_min, 'tier', l.tier, 'requestId', l.request_id);
END $$;

-- ═══ 4. Owner functions (not granted to the service or agent roles) ═══
CREATE FUNCTION fleet_cognition_routing_set(p_enabled boolean, p_major_spend_threshold_minor bigint, p_actor text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_actor IS NULL OR length(p_actor) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: actor required'; END IF;
  IF p_enabled AND NOT EXISTS (SELECT 1 FROM fleet_cognition_tiers WHERE enabled) THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: enable and verify at least one tier first'; END IF;
  UPDATE fleet_cognition_routing SET routing_enabled = p_enabled,
    major_spend_threshold_minor = COALESCE(p_major_spend_threshold_minor, major_spend_threshold_minor), updated_at = now(), updated_by = p_actor WHERE id = 1;
  PERFORM fleet_event('cognition_routing_set', NULL, p_actor, jsonb_build_object('enabled', p_enabled, 'majorSpendThresholdMinor', p_major_spend_threshold_minor));
  RETURN (SELECT to_jsonb(r) FROM fleet_cognition_routing r WHERE id = 1);
END $$;

CREATE FUNCTION fleet_cognition_tier_set(p_tier text, p_model text, p_thinking text, p_effort text, p_max_output_tokens integer,
  p_in bigint, p_out bigint, p_cw bigint, p_cr bigint, p_actor text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t fleet_cognition_tiers;
BEGIN
  IF p_actor IS NULL OR length(p_actor) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: actor required'; END IF;
  SELECT * INTO t FROM fleet_cognition_tiers WHERE tier = p_tier FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: tier is T1, T2 or T3'; END IF;
  -- Any change of the mapping voids its verification and disables it until re-verified.
  UPDATE fleet_cognition_tiers SET model = p_model, thinking = p_thinking, effort = p_effort, max_output_tokens = p_max_output_tokens,
      input_microcents_per_token = p_in, output_microcents_per_token = p_out, cache_write_microcents_per_token = p_cw, cache_read_microcents_per_token = p_cr,
      enabled = false, verified_at = NULL, verified_ref = NULL, updated_at = now(), updated_by = p_actor
    WHERE tier = p_tier;
  PERFORM fleet_event('cognition_tier_set', NULL, p_actor, jsonb_build_object('tier', p_tier, 'model', p_model, 'thinking', p_thinking, 'effort', p_effort));
  RETURN (SELECT to_jsonb(x) FROM fleet_cognition_tiers x WHERE tier = p_tier);
END $$;

CREATE FUNCTION fleet_cognition_tier_verify(p_tier text, p_model text, p_ref text, p_actor text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_actor IS NULL OR length(p_actor) < 3 OR p_ref IS NULL OR length(p_ref) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: actor and verification reference required'; END IF;
  -- The owner names the model verified: a stale verification of another mapping cannot be applied.
  UPDATE fleet_cognition_tiers SET verified_at = now(), verified_ref = left(p_ref, 300), updated_at = now(), updated_by = p_actor
    WHERE tier = p_tier AND model = p_model;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: no tier % mapped to model %', p_tier, p_model; END IF;
  PERFORM fleet_event('cognition_tier_verified', NULL, p_actor, jsonb_build_object('tier', p_tier, 'model', p_model, 'ref', left(p_ref, 300)));
  RETURN (SELECT to_jsonb(x) FROM fleet_cognition_tiers x WHERE tier = p_tier);
END $$;

CREATE FUNCTION fleet_cognition_tier_enable(p_tier text, p_enabled boolean, p_actor text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_actor IS NULL OR length(p_actor) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: actor required'; END IF;
  UPDATE fleet_cognition_tiers SET enabled = p_enabled, updated_at = now(), updated_by = p_actor WHERE tier = p_tier;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: tier is T1, T2 or T3'; END IF;
  PERFORM fleet_event('cognition_tier_enabled', NULL, p_actor, jsonb_build_object('tier', p_tier, 'enabled', p_enabled));
  RETURN (SELECT to_jsonb(x) FROM fleet_cognition_tiers x WHERE tier = p_tier);
END $$;

CREATE FUNCTION fleet_founder_routing_set(p_agent text, p_enabled boolean, p_actor text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_actor IS NULL OR length(p_actor) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: actor required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = p_agent AND origin IN ('genesis_founder','reseed_founder')) THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: not a founder';
  END IF;
  INSERT INTO fleet_founder_routing (agent_id, enabled, updated_by) VALUES (p_agent, p_enabled, p_actor)
    ON CONFLICT (agent_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now(), updated_by = EXCLUDED.updated_by;
  PERFORM fleet_event('founder_routing_set', p_agent, p_actor, jsonb_build_object('enabled', p_enabled));
  RETURN jsonb_build_object('agentId', p_agent, 'enabled', p_enabled, 'routingActive', fleet_routing_active(p_agent));
END $$;

-- Observability: cost and outcome per task class × tier (the data the Fleet learns the cheapest reliable route from).
CREATE FUNCTION fleet_cognition_report(p_since timestamptz) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('since', p_since, 'rows', COALESCE(jsonb_agg(x ORDER BY x.tier NULLS FIRST, x.task_class NULLS FIRST), '[]'::jsonb))
  FROM (SELECT COALESCE(task_class, '(legacy)') AS task_class, tier, model,
               count(*) AS calls, count(*) FILTER (WHERE outcome = 'error') AS errors,
               count(*) FILTER (WHERE escalation_reason IS NOT NULL) AS escalations,
               sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
               sum(cache_read_tokens) AS cache_read_tokens, sum(cache_write_tokens) AS cache_write_tokens,
               sum(COALESCE(thinking_tokens, 0)) AS thinking_tokens, sum(COALESCE(packet_bytes, 0)) AS packet_bytes,
               sum(cost_microcents) AS provider_usd_microcents, sum(COALESCE(charged_microcents, 0)) AS charged_microcents,
               sum(attempts - 1) AS retries
          FROM fleet_cognition_log WHERE at >= p_since GROUP BY 1, 2, 3) x
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
