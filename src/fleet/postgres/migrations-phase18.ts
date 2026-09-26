/**
 * Schema v18 (Pre-Genesis step 4): controlled founder web research.
 *
 *  - Capability class `research.web` (grantable) and manifest `founder-v2` = founder-v1 + research.web. New
 *    Genesis defaults to founder-v2; founder-v1 stays valid and unchanged.
 *  - Owner switch `fleet_research_policy.research_enabled` (default FALSE) plus quotas: per founder 60/h and
 *    300/day, fleet-wide 120/h and 600/day by default. Per-founder pause and tighter limits in
 *    `fleet_founder_research`.
 *  - Quota semantics (deliberate, so failure paths cannot bypass limits): every AUTHORIZED attempt counts,
 *    whatever happens next (URL-policy refusal, DNS/SSRF refusal, timeout, error, success). Attempts refused
 *    BEFORE authorization (switch off, paused, over quota, not a founder, no capability) do not count, but are
 *    logged. After 120 refused rows in an hour, refusals are aggregated into a per-hour counter so the audit
 *    stays bounded.
 *  - Append-only audit: `fleet_research_attempts` (founder, requested URL and host, purpose, decision, refusal
 *    code, time) and `fleet_research_results` (outcome, failure class, final URL, redirects, HTTP status, content
 *    type, bytes, text length, truncation, content hash, latency). Never bodies, never secrets (URLs are scrubbed).
 *  - The database authorizes and records. The network operation happens only in the isolated fetcher.
 */

export const V18_SQL = `
INSERT INTO fleet_capability_classes (class, grantable, description) VALUES
  ('research.web', true, 'Public web research through FleetController''s isolated fetcher (HTTPS GET, extracted text only)');
INSERT INTO fleet_capability_manifests (manifest_id, version, allowed, manifest_sha256, description, created_by) VALUES
  ('founder-v2', 2, ARRAY['liveness','planning','memory.private','research.read','workspace.fs','code.build','deployment',
     'communication','website.domain','external.publish','spend.request','ledger.read','asset.manage','identity.claim_request',
     'knowledge.propose','knowledge.read','research.web'], repeat('0', 64),
   'Genesis founder v2: founder-v1 plus controlled public web research through FleetController (research.web)',
   'migration');
UPDATE fleet_genesis_policy SET default_manifest_id = 'founder-v2', updated_at = now(), updated_by = 'migration' WHERE id = 1;

CREATE TABLE fleet_research_policy (
  id                smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  research_enabled  boolean     NOT NULL DEFAULT false,
  founder_hourly    integer     NOT NULL DEFAULT 60  CHECK (founder_hourly BETWEEN 1 AND 600),
  founder_daily     integer     NOT NULL DEFAULT 300 CHECK (founder_daily BETWEEN 1 AND 5000),
  fleet_hourly      integer     NOT NULL DEFAULT 120 CHECK (fleet_hourly BETWEEN 1 AND 6000),
  fleet_daily       integer     NOT NULL DEFAULT 600 CHECK (fleet_daily BETWEEN 1 AND 50000),
  updated_by        text        NOT NULL DEFAULT 'migration',
  updated_at        timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fleet_research_policy (id) VALUES (1);
CREATE TRIGGER fleet_research_policy_no_delete BEFORE DELETE ON fleet_research_policy FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_research_policy_no_truncate BEFORE TRUNCATE ON fleet_research_policy FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_founder_research (
  agent_id        text        PRIMARY KEY REFERENCES fleet_agents(agent_id),
  paused          boolean     NOT NULL DEFAULT false,
  hourly_limit    integer     CHECK (hourly_limit BETWEEN 1 AND 600),
  daily_limit     integer     CHECK (daily_limit BETWEEN 1 AND 5000),
  reason          text        CHECK (length(reason) <= 200),
  updated_by      text        NOT NULL CHECK (updated_by ~ '^operator:[A-Za-z0-9._-]{1,64}$'),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_founder_research_no_delete BEFORE DELETE ON fleet_founder_research FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_research_attempts (
  seq             bigserial   UNIQUE,
  attempt_id      uuid        PRIMARY KEY,
  agent_id        text        NOT NULL REFERENCES fleet_agents(agent_id),
  requested_url   text        NOT NULL CHECK (length(requested_url) <= 2048),
  requested_host  text        CHECK (length(requested_host) <= 253),
  purpose         text        NOT NULL CHECK (length(purpose) <= 300),
  decision        text        NOT NULL CHECK (decision IN ('authorized','refused')),
  refusal_code    text        CHECK (refusal_code ~ '^[A-Z_]{2,64}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((decision = 'refused') = (refusal_code IS NOT NULL))
);
CREATE INDEX fleet_research_attempts_agent_idx ON fleet_research_attempts (agent_id, created_at);
CREATE INDEX fleet_research_attempts_time_idx ON fleet_research_attempts (created_at) WHERE decision = 'authorized';
CREATE TRIGGER fleet_research_attempts_no_change BEFORE UPDATE OR DELETE ON fleet_research_attempts FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_research_attempts_no_truncate BEFORE TRUNCATE ON fleet_research_attempts FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_research_results (
  attempt_id      uuid        PRIMARY KEY REFERENCES fleet_research_attempts(attempt_id),
  outcome         text        NOT NULL CHECK (outcome IN ('fetched','failed')),
  failure_code    text        CHECK (failure_code ~ '^[A-Z_]{2,64}$'),
  final_url       text        CHECK (length(final_url) <= 2048),
  redirects       smallint    NOT NULL DEFAULT 0 CHECK (redirects BETWEEN 0 AND 10),
  http_status     integer     CHECK (http_status BETWEEN 100 AND 599),
  content_type    text        CHECK (content_type ~ '^[a-z0-9.+/-]{1,100}$'),
  bytes           integer     CHECK (bytes >= 0),
  text_chars      integer     CHECK (text_chars >= 0),
  truncated       boolean     NOT NULL DEFAULT false,
  content_sha256  text        CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  latency_ms      integer     CHECK (latency_ms BETWEEN 0 AND 600000),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((outcome = 'failed') = (failure_code IS NOT NULL))
);
CREATE TRIGGER fleet_research_results_no_change BEFORE UPDATE OR DELETE ON fleet_research_results FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_research_results_no_truncate BEFORE TRUNCATE ON fleet_research_results FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- Bounded audit of refusals beyond the per-hour individual-row allowance.
CREATE TABLE fleet_research_refusals_suppressed (
  agent_id   text        NOT NULL REFERENCES fleet_agents(agent_id),
  hour       timestamptz NOT NULL,
  refused    integer     NOT NULL CHECK (refused >= 1),
  PRIMARY KEY (agent_id, hour)
);

-- ═══ Owner controls (never granted) ═════════════════════════════════════
CREATE FUNCTION fleet_research_set_policy(p_enabled boolean, p_founder_hourly integer, p_founder_daily integer, p_fleet_hourly integer,
  p_fleet_daily integer, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_research_policy;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_research');
  UPDATE fleet_research_policy SET research_enabled = p_enabled,
         founder_hourly = COALESCE(p_founder_hourly, founder_hourly), founder_daily = COALESCE(p_founder_daily, founder_daily),
         fleet_hourly = COALESCE(p_fleet_hourly, fleet_hourly), fleet_daily = COALESCE(p_fleet_daily, fleet_daily),
         updated_by = p_actor, updated_at = now()
   WHERE id = 1 RETURNING * INTO p;
  PERFORM fleet_event(CASE WHEN p_enabled THEN 'research_enabled' ELSE 'research_disabled' END, NULL, p_actor, to_jsonb(p) - 'updated_at');
  RETURN to_jsonb(p);
END $$;

CREATE FUNCTION fleet_founder_research_set(p_agent text, p_paused boolean, p_hourly integer, p_daily integer, p_reason text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; r fleet_founder_research;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent;
  IF NOT FOUND OR a.origin NOT IN ('genesis_founder','reseed_founder') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: research is controlled per founder'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), p_agent);
  INSERT INTO fleet_founder_research (agent_id, paused, hourly_limit, daily_limit, reason, updated_by)
    VALUES (p_agent, COALESCE(p_paused, false), p_hourly, p_daily, left(fleet_scrub(p_reason), 200), p_actor)
    ON CONFLICT (agent_id) DO UPDATE SET paused = COALESCE(p_paused, fleet_founder_research.paused),
      hourly_limit = COALESCE(p_hourly, fleet_founder_research.hourly_limit), daily_limit = COALESCE(p_daily, fleet_founder_research.daily_limit),
      reason = left(fleet_scrub(p_reason), 200), updated_by = p_actor, updated_at = now()
    RETURNING * INTO r;
  PERFORM fleet_event(CASE WHEN r.paused THEN 'founder_research_paused' ELSE 'founder_research_updated' END, p_agent, p_actor, to_jsonb(r) - 'updated_at');
  RETURN to_jsonb(r);
END $$;

-- ═══ Controller (service role) ══════════════════════════════════════════
CREATE FUNCTION fleet_research_state(p_agent text) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'enabled', p.research_enabled,
    'paused', COALESCE(f.paused, false),
    'capability', COALESCE(fleet_agent_can(p_agent, 'research.web'), false),
    'hourlyLimit', LEAST(p.founder_hourly, COALESCE(f.hourly_limit, p.founder_hourly)),
    'dailyLimit', LEAST(p.founder_daily, COALESCE(f.daily_limit, p.founder_daily)),
    'usedLastHour', (SELECT count(*) FROM fleet_research_attempts WHERE agent_id = p_agent AND decision = 'authorized' AND created_at > now() - interval '1 hour'),
    'usedLastDay', (SELECT count(*) FROM fleet_research_attempts WHERE agent_id = p_agent AND decision = 'authorized' AND created_at > now() - interval '1 day'),
    'fleetUsedLastHour', (SELECT count(*) FROM fleet_research_attempts WHERE decision = 'authorized' AND created_at > now() - interval '1 hour'),
    'fleetUsedLastDay', (SELECT count(*) FROM fleet_research_attempts WHERE decision = 'authorized' AND created_at > now() - interval '1 day'),
    'fleetHourlyLimit', p.fleet_hourly, 'fleetDailyLimit', p.fleet_daily)
  FROM fleet_research_policy p LEFT JOIN fleet_founder_research f ON f.agent_id = p_agent WHERE p.id = 1
$$;

CREATE FUNCTION svc_research_authorize(p_agent text, p_url text, p_host text, p_purpose text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; s jsonb; v_code text; v_id uuid := gen_random_uuid(); v_refused integer;
        v_url text := left(fleet_scrub_long(regexp_replace(COALESCE(p_url, ''), '[[:cntrl:]]', '', 'g')), 2048);
        v_host text := left(lower(COALESCE(p_host, '')), 253);
        v_purpose text := left(fleet_scrub(regexp_replace(COALESCE(p_purpose, ''), '[[:cntrl:]]', ' ', 'g')), 300);
BEGIN
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR a.origin NOT IN ('genesis_founder','reseed_founder') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_RESEARCH_NOT_FOUNDER'); END IF;
  -- Serialize fleet-wide quota accounting (research is low-rate; correctness over concurrency).
  PERFORM 1 FROM fleet_research_policy WHERE id = 1 FOR UPDATE;
  s := fleet_research_state(p_agent);
  -- Fail closed: a missing policy/state or any NULL comparison refuses (never authorizes).
  v_code := CASE
    WHEN s IS NULL THEN 'FLEET_RESEARCH_DISABLED'
    WHEN a.status NOT IN ('active','unresponsive') THEN 'FLEET_AGENT_NOT_ACTIVE'
    WHEN a.operator_hold_at IS NOT NULL THEN 'FLEET_AGENT_HELD'
    WHEN (s ->> 'capability')::boolean IS NOT TRUE THEN 'FLEET_CAPABILITY_DENIED'
    WHEN (s ->> 'enabled')::boolean IS NOT TRUE THEN 'FLEET_RESEARCH_DISABLED'
    WHEN (s ->> 'paused')::boolean IS NOT FALSE THEN 'FLEET_RESEARCH_PAUSED'
    WHEN ((s ->> 'usedLastHour')::integer < (s ->> 'hourlyLimit')::integer) IS NOT TRUE THEN 'FLEET_RESEARCH_QUOTA_HOURLY'
    WHEN ((s ->> 'usedLastDay')::integer < (s ->> 'dailyLimit')::integer) IS NOT TRUE THEN 'FLEET_RESEARCH_QUOTA_DAILY'
    WHEN ((s ->> 'fleetUsedLastHour')::integer < (s ->> 'fleetHourlyLimit')::integer) IS NOT TRUE THEN 'FLEET_RESEARCH_FLEET_QUOTA'
    WHEN ((s ->> 'fleetUsedLastDay')::integer < (s ->> 'fleetDailyLimit')::integer) IS NOT TRUE THEN 'FLEET_RESEARCH_FLEET_QUOTA'
    ELSE NULL END;
  IF v_code IS NOT NULL THEN
    -- Refusals are audited: individually up to 120 per founder per hour, then aggregated (bounded).
    SELECT count(*) INTO v_refused FROM fleet_research_attempts WHERE agent_id = p_agent AND decision = 'refused' AND created_at > now() - interval '1 hour';
    IF v_refused < 120 THEN
      INSERT INTO fleet_research_attempts (attempt_id, agent_id, requested_url, requested_host, purpose, decision, refusal_code)
        VALUES (v_id, p_agent, v_url, v_host, v_purpose, 'refused', v_code);
    ELSE
      INSERT INTO fleet_research_refusals_suppressed (agent_id, hour, refused) VALUES (p_agent, date_trunc('hour', now()), 1)
        ON CONFLICT (agent_id, hour) DO UPDATE SET refused = fleet_research_refusals_suppressed.refused + 1;
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;
  INSERT INTO fleet_research_attempts (attempt_id, agent_id, requested_url, requested_host, purpose, decision)
    VALUES (v_id, p_agent, v_url, v_host, v_purpose, 'authorized');
  RETURN jsonb_build_object('ok', true, 'attemptId', v_id, 'usedLastHour', (s ->> 'usedLastHour')::integer + 1, 'hourlyLimit', s -> 'hourlyLimit');
END $$;

CREATE FUNCTION svc_research_record(p_agent text, p_attempt uuid, p_outcome text, p_failure_code text, p_final_url text, p_redirects integer,
  p_status integer, p_content_type text, p_bytes integer, p_text_chars integer, p_truncated boolean, p_sha256 text, p_latency_ms integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t fleet_research_attempts;
BEGIN
  SELECT * INTO t FROM fleet_research_attempts WHERE attempt_id = p_attempt;
  IF NOT FOUND OR t.agent_id <> p_agent OR t.decision <> 'authorized' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_RESEARCH_NOT_AUTHORIZED'); END IF;
  IF EXISTS (SELECT 1 FROM fleet_research_results WHERE attempt_id = p_attempt) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_RESEARCH_ALREADY_RECORDED'); END IF;
  INSERT INTO fleet_research_results (attempt_id, outcome, failure_code, final_url, redirects, http_status, content_type, bytes, text_chars, truncated, content_sha256, latency_ms)
    VALUES (p_attempt, CASE WHEN p_outcome = 'fetched' THEN 'fetched' ELSE 'failed' END,
      CASE WHEN p_outcome = 'fetched' THEN NULL WHEN p_failure_code ~ '^[A-Z_]{2,64}$' THEN p_failure_code ELSE 'RESEARCH_FAILED' END,
      CASE WHEN p_final_url IS NULL THEN NULL ELSE left(fleet_scrub_long(regexp_replace(p_final_url, '[[:cntrl:]]', '', 'g')), 2048) END,
      LEAST(GREATEST(COALESCE(p_redirects, 0), 0), 10),
      CASE WHEN p_status BETWEEN 100 AND 599 THEN p_status END,
      CASE WHEN p_content_type ~ '^[a-z0-9.+/-]{1,100}$' THEN p_content_type END,
      GREATEST(COALESCE(p_bytes, 0), 0), GREATEST(COALESCE(p_text_chars, 0), 0), COALESCE(p_truncated, false),
      CASE WHEN p_sha256 ~ '^[0-9a-f]{64}$' THEN p_sha256 END,
      CASE WHEN p_latency_ms BETWEEN 0 AND 600000 THEN p_latency_ms END);
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE FUNCTION api_research_status(p_agent text, p_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'research_status');
BEGIN
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  RETURN jsonb_build_object('ok', true) || fleet_research_state(p_agent);
END $$;

-- ═══ Fail-closed hardening of the cognition gate (found while testing research: a missing policy row) ═══
CREATE TRIGGER fleet_cognition_policy_no_truncate BEFORE TRUNCATE ON fleet_cognition_policy FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
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
  -- v18: fail closed on a missing policy row (a NULL state must never authorize).
  IF s IS NULL OR (s ->> 'policyEnabled')::boolean IS NOT TRUE OR COALESCE(s ->> 'provider', 'none') = 'none' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_DISABLED'); END IF;
  IF (s ->> 'founderEnabled')::boolean IS NOT TRUE THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_FOUNDER_DISABLED'); END IF;
  IF (s ->> 'paused')::boolean IS NOT FALSE THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_PAUSED'); END IF;
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


REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
