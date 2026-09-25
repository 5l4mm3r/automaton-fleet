/**
 * Schema v9 — Phase D3: controlled operator actions (extends the B2 Operator API).
 *
 * The B2 read path is unchanged in substance: read routes map only to STABLE
 * read functions, which the Operator API runs in READ ONLY transactions and
 * which accept only a fresh GET request id for themselves.
 *
 * D3 adds a separate, explicitly allow-listed ACTION path:
 *  - op_begin_action accepts only POST routes, and only while BOTH kill
 *    switches are on (operator_api_enabled AND operator_actions_enabled,
 *    default off). It applies the same principal/key/scope/nonce/clock checks
 *    as op_begin_request, plus hourly caps (per principal and global).
 *  - Each POST route maps to exactly one named op_act_* / op_propose_*
 *    function with a closed JSON body schema. The function re-validates the
 *    request (fresh, unexecuted, POST, scope, kind, both switches) and
 *    requires sha256(body) to equal the digest bound into the signed request,
 *    then re-validates every field in SQL.
 *  - Every accepted action writes exactly one immutable fleet_operator_actions
 *    row (request id, principal, kind, scope, target, parameters, previous
 *    state, requested state, decision, result, failure code) and one
 *    operator_action event, in the same transaction as its effect.
 *  - Idempotency: (principal, action, idempotencyKey) is unique; a retry with
 *    identical parameters returns the recorded result, different parameters
 *    are refused.
 *
 * Authority (READ / PROPOSE / EXECUTE / OWNER-GATED):
 *  EXECUTE (scope ops.act.agents; reversible or policy-driven only):
 *    hold_agent, release_agent_hold (only a hold this principal placed),
 *    request_health_challenge, revoke_agent_sessions, reconcile_lifecycle.
 *  PROPOSE (scope ops.propose.agents): quarantine_agent, terminate_agent,
 *    revoke_agent_credential. Proposals are executed only by
 *    fleet_operator_proposal_decide, an owner-only function that is never
 *    granted, refuses operator-principal approvers and re-validates state.
 *  OWNER-GATED (not representable here at all): payments, replication,
 *    Genesis/founders/reseeding, the cap, treasury, custody, credentials
 *    export, owner identity, constitution, auth/audit/isolation weakening.
 *
 * A "hold" is the D3 pause: the agent keeps only liveness (session,
 * heartbeat, health challenge, whoami) - the same allow-list as the witness
 * scope - enforced here in fleet_authenticate and by the fleet service's
 * route policy. Compute inside the sandbox is not stopped (no provider API).
 */

export const OPERATOR_ACTION_HOURLY_CAP_PER_PRINCIPAL = 30;
export const OPERATOR_ACTION_HOURLY_CAP_GLOBAL = 60;
export const OPERATOR_MAX_PENDING_PROPOSALS = 10;
export const OPERATOR_PROPOSAL_TTL_HOURS = 24;
export const OPERATOR_RECONCILE_MIN_INTERVAL_S = 30;

export const V9_SQL = `
-- ── Scopes: three new operator scopes; ChatGPT stays read-only (status + agents)
ALTER TABLE fleet_operator_principals DROP CONSTRAINT fleet_operator_principals_scopes_check;
ALTER TABLE fleet_operator_principals ADD CONSTRAINT fleet_operator_principals_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 6
  AND scopes <@ ARRAY['ops.read.status','ops.read.agents','ops.read.events',
                      'ops.read.lifecycle','ops.act.agents','ops.propose.agents']::text[]
  AND array_position(scopes, NULL) IS NULL);
ALTER TABLE fleet_operator_principals ADD CONSTRAINT fleet_operator_principals_chatgpt_read_only
  CHECK (kind <> 'bridge_chatgpt' OR scopes <@ ARRAY['ops.read.status','ops.read.agents']::text[]);

-- ── Mutation kill switch (separate from the read kill switch; default OFF)
-- (No CHECK tying it to operator_api_enabled: turning the API off must never fail.
-- Admission requires both switches; the owner CLI turns actions off with the API.)
ALTER TABLE fleet_operator_state ADD COLUMN operator_actions_enabled boolean NOT NULL DEFAULT false;

-- ── Routes: GET -> read function, POST -> action function (bridge_claude only)
ALTER TABLE fleet_operator_routes DROP CONSTRAINT fleet_operator_routes_route_check;
ALTER TABLE fleet_operator_routes DROP CONSTRAINT fleet_operator_routes_scope_check;
ALTER TABLE fleet_operator_routes DROP CONSTRAINT fleet_operator_routes_fn_check;
ALTER TABLE fleet_operator_routes ADD CONSTRAINT fleet_operator_routes_route_check
  CHECK (route ~ '^(GET|POST) /v1/operator/[a-z0-9_/{}-]+$');
ALTER TABLE fleet_operator_routes ADD CONSTRAINT fleet_operator_routes_scope_check
  CHECK (scope IS NULL OR scope IN ('ops.read.status','ops.read.agents','ops.read.events',
                                    'ops.read.lifecycle','ops.act.agents','ops.propose.agents'));
ALTER TABLE fleet_operator_routes ADD CONSTRAINT fleet_operator_routes_fn_check CHECK (fn IN (
  'op_whoami','op_fleet_status','op_list_agents','op_get_agent','op_list_events',
  'op_lifecycle_health','op_runtime_status','op_list_reservations','op_list_orphans','op_list_proposals','op_list_actions',
  'op_act_hold_agent','op_act_release_agent_hold','op_act_request_health_challenge','op_act_revoke_agent_sessions',
  'op_act_reconcile_lifecycle','op_propose_agent_action'));
ALTER TABLE fleet_operator_routes ADD CONSTRAINT fleet_operator_routes_method_matches_fn CHECK (
  (route LIKE 'GET %') = (fn IN ('op_whoami','op_fleet_status','op_list_agents','op_get_agent','op_list_events',
    'op_lifecycle_health','op_runtime_status','op_list_reservations','op_list_orphans','op_list_proposals','op_list_actions')));
ALTER TABLE fleet_operator_routes ADD CONSTRAINT fleet_operator_routes_post_scoped CHECK (
  route LIKE 'GET %' OR (scope IN ('ops.act.agents','ops.propose.agents') AND kinds = ARRAY['bridge_claude']::text[]));
INSERT INTO fleet_operator_routes (route, scope, fn, kinds) VALUES
  ('GET /v1/operator/lifecycle',    'ops.read.lifecycle', 'op_lifecycle_health',  ARRAY['bridge_claude']),
  ('GET /v1/operator/runtime',      'ops.read.status',    'op_runtime_status',    ARRAY['bridge_claude']),
  ('GET /v1/operator/reservations', 'ops.read.lifecycle', 'op_list_reservations', ARRAY['bridge_claude']),
  ('GET /v1/operator/orphans',      'ops.read.lifecycle', 'op_list_orphans',      ARRAY['bridge_claude']),
  ('GET /v1/operator/proposals',    'ops.read.lifecycle', 'op_list_proposals',    ARRAY['bridge_claude']),
  ('GET /v1/operator/actions',      'ops.read.lifecycle', 'op_list_actions',      ARRAY['bridge_claude']),
  ('POST /v1/operator/actions/hold-agent',               'ops.act.agents',     'op_act_hold_agent',               ARRAY['bridge_claude']),
  ('POST /v1/operator/actions/release-agent-hold',       'ops.act.agents',     'op_act_release_agent_hold',       ARRAY['bridge_claude']),
  ('POST /v1/operator/actions/request-health-challenge', 'ops.act.agents',     'op_act_request_health_challenge', ARRAY['bridge_claude']),
  ('POST /v1/operator/actions/revoke-agent-sessions',    'ops.act.agents',     'op_act_revoke_agent_sessions',    ARRAY['bridge_claude']),
  ('POST /v1/operator/actions/reconcile-lifecycle',      'ops.act.agents',     'op_act_reconcile_lifecycle',      ARRAY['bridge_claude']),
  ('POST /v1/operator/proposals',                        'ops.propose.agents', 'op_propose_agent_action',         ARRAY['bridge_claude']);

-- ── Agent hold (pause) and operator-requested health challenge
ALTER TABLE fleet_agents
  ADD COLUMN operator_hold_at       timestamptz,
  ADD COLUMN operator_hold_by       text CHECK (operator_hold_by ~ '^(op:op_[0-9A-HJKMNP-TV-Z]{26}|operator:[A-Za-z0-9._-]{1,64})$'),
  ADD COLUMN operator_hold_reason   text CHECK (length(operator_hold_reason) <= 200),
  ADD COLUMN challenge_requested_at timestamptz;
ALTER TABLE fleet_agents ADD CONSTRAINT fleet_agents_hold_complete
  CHECK ((operator_hold_at IS NULL) = (operator_hold_by IS NULL));

-- ── Action ledger (append-only; one row per executed/refused action request)
CREATE TABLE fleet_operator_actions (
  seq               bigserial   UNIQUE,
  action_id         uuid        PRIMARY KEY,
  request_id        uuid        NOT NULL UNIQUE,
  principal_id      text        NOT NULL REFERENCES fleet_operator_principals(principal_id),
  principal_kind    text        NOT NULL CHECK (principal_kind IN ('bridge_claude','bridge_chatgpt')),
  key_id            text        NOT NULL CHECK (key_id ~ '^[0-9a-f]{32}$'),
  action            text        NOT NULL CHECK (action IN ('hold_agent','release_agent_hold','request_health_challenge',
                                  'revoke_agent_sessions','reconcile_lifecycle','propose_agent_action')),
  scope             text        NOT NULL CHECK (scope IN ('ops.act.agents','ops.propose.agents')),
  target_agent_id   text        CHECK (target_agent_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  params            jsonb       NOT NULL CHECK (jsonb_typeof(params) = 'object'),
  idempotency_key   text        NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{16,64}$'),
  previous_state    jsonb,
  requested_state   text        CHECK (length(requested_state) <= 64),
  decision          text        NOT NULL CHECK (decision IN ('executed','noop','rejected')),
  failure_code      text        CHECK (failure_code ~ '^FLEET_OP_[A-Z_]{1,48}$'),
  result            jsonb       NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  proposal_id       uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (principal_id, action, idempotency_key),
  CHECK ((decision = 'rejected') = (failure_code IS NOT NULL))
);
CREATE INDEX fleet_operator_actions_principal_idx ON fleet_operator_actions (principal_id, created_at);
CREATE TRIGGER fleet_operator_actions_no_change BEFORE UPDATE OR DELETE ON fleet_operator_actions
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_operator_actions_no_truncate BEFORE TRUNCATE ON fleet_operator_actions
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ── Proposals (owner-gated execution; operators can only create them)
CREATE TABLE fleet_operator_proposals (
  seq               bigserial   UNIQUE,
  proposal_id       uuid        PRIMARY KEY,
  action_id         uuid        NOT NULL UNIQUE REFERENCES fleet_operator_actions(action_id),
  principal_id      text        NOT NULL REFERENCES fleet_operator_principals(principal_id),
  kind              text        NOT NULL CHECK (kind IN ('quarantine_agent','terminate_agent','revoke_agent_credential')),
  target_agent_id   text        NOT NULL REFERENCES fleet_agents(agent_id),
  reason            text        NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  status            text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  decided_at        timestamptz,
  decided_by        text        CHECK (decided_by ~ '^(operator:[A-Za-z0-9._-]{1,64}|system:expiry)$'),
  decision_note     text        CHECK (length(decision_note) <= 200),
  execution         jsonb,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days'),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK ((status = 'pending') = (decided_by IS NULL)),
  CHECK (status <> 'approved' OR execution IS NOT NULL)
);
CREATE INDEX fleet_operator_proposals_open_idx ON fleet_operator_proposals (kind, target_agent_id) WHERE status = 'pending';

-- Only fleet_operator_proposal_decide may change a proposal, once, pending -> final.
CREATE FUNCTION fleet_operator_proposals_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.decided_at IS NOT NULL THEN
      RAISE EXCEPTION 'FLEET_OPERATOR_INVALID: a proposal is created pending';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: % on fleet_operator_proposals is not allowed', TG_OP;
  END IF;
  IF COALESCE(current_setting('fleet.proposal_decision', true), '') <> 'on' THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: proposals change only through the owner decision function';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: proposal % is already %', OLD.proposal_id, OLD.status;
  END IF;
  IF NEW.proposal_id IS DISTINCT FROM OLD.proposal_id OR NEW.action_id IS DISTINCT FROM OLD.action_id
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.target_agent_id IS DISTINCT FROM OLD.target_agent_id OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.seq IS DISTINCT FROM OLD.seq THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: proposal identity cannot change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_operator_proposals_guard BEFORE INSERT OR UPDATE OR DELETE ON fleet_operator_proposals
  FOR EACH ROW EXECUTE FUNCTION fleet_operator_proposals_guard();
CREATE TRIGGER fleet_operator_proposals_no_truncate BEFORE TRUNCATE ON fleet_operator_proposals
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ── Request admission (owner-only internal; never granted). The v8 body of
-- op_begin_request, parameterised by mode: 'read' admits only GET routes,
-- 'action' only POST routes, and only while actions are enabled and under
-- the hourly caps. Writes: operator bookkeeping only (+ denial events).
CREATE FUNCTION fleet_operator_begin(p_mode text, p_principal text, p_key text, p_route text, p_client_ts_ms bigint, p_nonce text, p_body_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE
  st fleet_operator_state; pr fleet_operator_principals; k fleet_operator_keys; rt fleet_operator_routes;
  v_actor text; v_route text; v_ts timestamptz; v_nh text; v_ins integer; v_id uuid; v_code text; v_type text;
BEGIN
  v_actor := CASE WHEN p_principal ~ '^op_[0-9A-HJKMNP-TV-Z]{26}$' THEN 'op:' || p_principal ELSE 'op:invalid' END;
  SELECT * INTO rt FROM fleet_operator_routes WHERE route = p_route
     AND ((p_mode = 'read' AND route LIKE 'GET %') OR (p_mode = 'action' AND route LIKE 'POST %'));
  v_route := CASE WHEN FOUND THEN rt.route ELSE 'unknown' END;

  IF p_principal IS NULL OR p_principal !~ '^op_[0-9A-HJKMNP-TV-Z]{26}$' OR p_key IS NULL OR p_key !~ '^[0-9a-f]{32}$'
     OR p_nonce IS NULL OR p_nonce !~ '^[A-Za-z0-9_-]{22,64}$' OR p_body_sha256 IS NULL OR p_body_sha256 !~ '^[0-9a-f]{64}$'
     OR p_client_ts_ms IS NULL OR p_client_ts_ms < 1000000000000 OR p_client_ts_ms > 9999999999999
     OR p_mode IS NULL OR p_mode NOT IN ('read','action') THEN
    v_code := 'FLEET_OP_BAD_REQUEST'; v_type := 'operator_bad_request';
  ELSIF v_route = 'unknown' THEN
    v_code := 'FLEET_OP_NOT_FOUND'; v_type := 'operator_bad_request';
  END IF;

  IF v_code IS NULL THEN
    SELECT * INTO st FROM fleet_operator_state WHERE id = 1 FOR UPDATE;
    IF NOT FOUND OR NOT st.operator_api_enabled THEN
      v_code := 'FLEET_OP_DISABLED'; v_type := 'operator_disabled';
    ELSIF p_mode = 'action' AND NOT st.operator_actions_enabled THEN
      v_code := 'FLEET_OP_ACTIONS_DISABLED'; v_type := 'operator_actions_disabled';
    ELSIF st.request_count >= st.request_cap THEN
      v_code := 'FLEET_OP_AUDIT_FULL'; v_type := 'operator_audit_full';
    END IF;
  END IF;

  IF v_code IS NULL THEN
    SELECT * INTO pr FROM fleet_operator_principals WHERE principal_id = p_principal;
    IF NOT FOUND OR pr.revoked_at IS NOT NULL THEN
      v_code := 'FLEET_OP_AUTH_FAILED'; v_type := 'operator_auth_failed';
    ELSE
      SELECT * INTO k FROM fleet_operator_keys WHERE key_id = p_key AND principal_id = p_principal;
      IF NOT FOUND OR k.revoked_at IS NOT NULL OR now() < k.not_before OR now() >= k.expires_at THEN
        v_code := 'FLEET_OP_AUTH_FAILED'; v_type := 'operator_auth_failed';
      ELSIF NOT (pr.kind = ANY (rt.kinds)) OR (rt.scope IS NOT NULL AND NOT (rt.scope = ANY (pr.scopes))) THEN
        v_code := 'FLEET_OP_SCOPE_DENIED'; v_type := 'operator_scope_denied';
      END IF;
    END IF;
  END IF;

  IF v_code IS NULL THEN
    v_ts := to_timestamp(p_client_ts_ms / 1000.0);
    IF abs(extract(epoch FROM (now() - v_ts))) > 30 THEN
      v_code := 'FLEET_OP_STALE'; v_type := 'operator_stale';
    END IF;
  END IF;

  IF v_code IS NULL AND p_mode = 'action' THEN
    IF (SELECT count(*) FROM fleet_operator_requests q WHERE q.principal_id = p_principal AND q.route LIKE 'POST %'
          AND q.received_at > now() - interval '1 hour') >= ${OPERATOR_ACTION_HOURLY_CAP_PER_PRINCIPAL}
       OR (SELECT count(*) FROM fleet_operator_requests q WHERE q.route LIKE 'POST %'
          AND q.received_at > now() - interval '1 hour') >= ${OPERATOR_ACTION_HOURLY_CAP_GLOBAL} THEN
      v_code := 'FLEET_OP_RATE_LIMITED'; v_type := 'operator_action_rate_limited';
    END IF;
  END IF;

  IF v_code IS NULL THEN
    v_nh := encode(sha256(convert_to(p_nonce, 'UTF8')), 'hex');
    INSERT INTO fleet_operator_nonces (principal_id, nonce_sha256, expires_at)
      VALUES (p_principal, v_nh, v_ts + interval '60 seconds') ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_ins = ROW_COUNT;
    IF v_ins = 0 THEN
      v_code := 'FLEET_OP_REPLAYED'; v_type := 'operator_replay_blocked';
    END IF;
  END IF;

  IF v_code IS NOT NULL THEN
    IF (SELECT count(*) FROM fleet_events e
         WHERE e.id > (SELECT COALESCE(max(id), 0) FROM fleet_events) - 1000
           AND e.actor LIKE 'op:%' AND e.created_at > now() - interval '1 minute') < 60 THEN
      PERFORM fleet_event(v_type, NULL, v_actor, jsonb_build_object('code', v_code, 'route', v_route, 'layer', 'database'));
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;

  v_id := gen_random_uuid();
  INSERT INTO fleet_operator_requests (request_id, principal_id, key_id, route, scope, client_ts, nonce_sha256, body_sha256)
    VALUES (v_id, p_principal, p_key, rt.route, rt.scope, v_ts, v_nh, p_body_sha256);
  UPDATE fleet_operator_state SET request_count = request_count + 1 WHERE id = 1;
  DELETE FROM fleet_operator_nonces WHERE ctid IN (SELECT ctid FROM fleet_operator_nonces WHERE expires_at < now() LIMIT 1000);
  RETURN jsonb_build_object('ok', true, 'requestId', v_id, 'fn', rt.fn, 'requestCount', st.request_count + 1, 'requestCap', st.request_cap);
END $$;

-- op_begin_request keeps its v8 signature and behaviour, and now admits GET routes only.
CREATE OR REPLACE FUNCTION op_begin_request(p_principal text, p_key text, p_route text, p_client_ts_ms bigint, p_nonce text, p_body_sha256 text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT fleet_operator_begin('read', p_principal, p_key, p_route, p_client_ts_ms, p_nonce, p_body_sha256)
$$;

CREATE FUNCTION op_begin_action(p_principal text, p_key text, p_route text, p_client_ts_ms bigint, p_nonce text, p_body_sha256 text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT fleet_operator_begin('action', p_principal, p_key, p_route, p_client_ts_ms, p_nonce, p_body_sha256)
$$;

-- ── Action admission helpers (owner-only; never granted)

-- A fresh (<= 30 s), not yet executed POST request for exactly this function,
-- from a live principal/key holding the route's scope and kind, with both
-- switches on, whose signed body digest equals sha256(p_body).
CREATE FUNCTION fleet_operator_action_ok(p_request uuid, p_fn text, p_body text) RETURNS fleet_operator_requests LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_operator_requests;
BEGIN
  SELECT q.* INTO r FROM fleet_operator_requests q
    JOIN fleet_operator_routes rt ON rt.route = q.route AND rt.fn = p_fn AND rt.route LIKE 'POST %'
    JOIN fleet_operator_principals p ON p.principal_id = q.principal_id AND p.revoked_at IS NULL
    JOIN fleet_operator_keys k ON k.key_id = q.key_id AND k.revoked_at IS NULL AND now() < k.expires_at
    JOIN fleet_operator_state s ON s.id = 1 AND s.operator_api_enabled AND s.operator_actions_enabled
   WHERE q.request_id = p_request AND q.received_at > now() - interval '30 seconds'
     AND rt.scope = ANY (p.scopes) AND p.kind = ANY (rt.kinds)
     AND q.body_sha256 = encode(sha256(convert_to(COALESCE(p_body, ''), 'UTF8')), 'hex')
     AND NOT EXISTS (SELECT 1 FROM fleet_operator_actions a WHERE a.request_id = q.request_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FLEET_OP_REQUEST_INVALID';
  END IF;
  RETURN r;
END $$;

-- Closed JSON object: only the listed keys, all strings, required ones present.
CREATE FUNCTION fleet_operator_body(p_body text, p_required text[], p_optional text[]) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j jsonb; k text;
BEGIN
  IF p_body IS NULL OR octet_length(p_body) < 2 OR octet_length(p_body) > 4096 THEN
    RAISE EXCEPTION 'FLEET_OP_BAD_PARAM: body size';
  END IF;
  BEGIN
    j := p_body::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'FLEET_OP_BAD_PARAM: body is not JSON';
  END;
  IF jsonb_typeof(j) <> 'object' THEN
    RAISE EXCEPTION 'FLEET_OP_BAD_PARAM: body is not an object';
  END IF;
  FOR k IN SELECT jsonb_object_keys(j) LOOP
    IF NOT (k = ANY (p_required) OR k = ANY (p_optional)) THEN
      RAISE EXCEPTION 'FLEET_OP_BAD_PARAM: unknown field';
    END IF;
    IF jsonb_typeof(j -> k) <> 'string' THEN
      RAISE EXCEPTION 'FLEET_OP_BAD_PARAM: fields are strings';
    END IF;
  END LOOP;
  FOREACH k IN ARRAY p_required LOOP
    IF NOT (j ? k) THEN
      RAISE EXCEPTION 'FLEET_OP_BAD_PARAM: missing field';
    END IF;
  END LOOP;
  RETURN j;
END $$;

-- Validated, normalised parameters (reason scrubbed); raises FLEET_OP_BAD_PARAM.
CREATE FUNCTION fleet_operator_params(j jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v jsonb := '{}'::jsonb;
BEGIN
  IF j ? 'agentId' THEN
    IF (j ->> 'agentId') !~ '^[0-9A-HJKMNP-TV-Z]{26}$' THEN RAISE EXCEPTION 'FLEET_OP_BAD_PARAM: agentId'; END IF;
    v := v || jsonb_build_object('agentId', j ->> 'agentId');
  END IF;
  IF j ? 'reason' THEN
    IF length(j ->> 'reason') NOT BETWEEN 1 AND 200 OR (j ->> 'reason') ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION 'FLEET_OP_BAD_PARAM: reason';
    END IF;
    v := v || jsonb_build_object('reason', left(fleet_scrub(j ->> 'reason'), 200));
  END IF;
  IF j ? 'kind' THEN
    IF (j ->> 'kind') NOT IN ('quarantine_agent','terminate_agent','revoke_agent_credential') THEN
      RAISE EXCEPTION 'FLEET_OP_BAD_PARAM: kind';
    END IF;
    v := v || jsonb_build_object('kind', j ->> 'kind');
  END IF;
  IF NOT (j ? 'idempotencyKey') OR (j ->> 'idempotencyKey') !~ '^[A-Za-z0-9_-]{16,64}$' THEN
    RAISE EXCEPTION 'FLEET_OP_BAD_PARAM: idempotencyKey';
  END IF;
  RETURN v;
END $$;

-- The recorded result of an earlier identical request, a conflict marker, or NULL.
CREATE FUNCTION fleet_operator_idempotent(p_principal text, p_action text, p_key text, p_params jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_operator_actions;
BEGIN
  SELECT * INTO a FROM fleet_operator_actions WHERE principal_id = p_principal AND action = p_action AND idempotency_key = p_key;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF a.params IS DISTINCT FROM p_params THEN
    RETURN jsonb_build_object('conflict', true, 'actionId', a.action_id);
  END IF;
  RETURN a.result || jsonb_build_object('idempotentReplay', true);
END $$;

CREATE FUNCTION fleet_operator_agent_state(a fleet_agents) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('status', a.status, 'held', a.operator_hold_at IS NOT NULL,
    'holdBy', CASE WHEN a.operator_hold_by LIKE 'op:%' THEN 'operator_principal' WHEN a.operator_hold_by IS NOT NULL THEN 'owner' END)
$$;

-- Append the ledger row and the operator_action event; returns the response.
CREATE FUNCTION fleet_operator_record_action(r fleet_operator_requests, p_action text, p_target text, p_params jsonb,
  p_idem text, p_prev jsonb, p_requested text, p_decision text, p_code text, p_result jsonb, p_proposal uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE pr fleet_operator_principals; v_out jsonb;
BEGIN
  SELECT * INTO pr FROM fleet_operator_principals WHERE principal_id = r.principal_id;
  v_out := jsonb_build_object('actionId', r.request_id, 'action', p_action, 'decision', p_decision, 'code', p_code,
    'targetAgentId', p_target, 'previousState', p_prev, 'requestedState', p_requested,
    'result', COALESCE(p_result, '{}'::jsonb), 'proposalId', p_proposal, 'idempotentReplay', false);
  INSERT INTO fleet_operator_actions (action_id, request_id, principal_id, principal_kind, key_id, action, scope, target_agent_id,
      params, idempotency_key, previous_state, requested_state, decision, failure_code, result, proposal_id)
    VALUES (r.request_id, r.request_id, r.principal_id, pr.kind, r.key_id, p_action, r.scope, p_target,
      p_params, p_idem, p_prev, p_requested, p_decision, p_code, v_out, p_proposal);
  PERFORM fleet_event('operator_action', p_target, 'op:' || r.principal_id,
    jsonb_build_object('action', p_action, 'decision', p_decision, 'code', p_code, 'actionId', r.request_id,
      'kind', pr.kind, 'scope', r.scope, 'proposalId', p_proposal));
  RETURN v_out;
END $$;

-- Idempotency conflict: nothing executes; the refusal is an event (the request row is the audit).
CREATE FUNCTION fleet_operator_conflict(r fleet_operator_requests, p_action text, p_prior jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_event('operator_action', NULL, 'op:' || r.principal_id,
    jsonb_build_object('action', p_action, 'decision', 'rejected', 'code', 'FLEET_OP_IDEMPOTENCY_CONFLICT',
      'actionId', r.request_id, 'scope', r.scope, 'priorActionId', p_prior ->> 'actionId'));
  RETURN jsonb_build_object('actionId', r.request_id, 'action', p_action, 'decision', 'rejected',
    'code', 'FLEET_OP_IDEMPOTENCY_CONFLICT', 'targetAgentId', NULL, 'previousState', NULL, 'requestedState', NULL,
    'result', jsonb_build_object('priorActionId', p_prior ->> 'actionId'), 'proposalId', NULL, 'idempotentReplay', false);
END $$;

-- ── EXECUTE actions (scope ops.act.agents). Lock order: principal row, then
-- fleet_state (reconcile only), then the agent row.

CREATE FUNCTION op_act_hold_agent(p_request uuid, p_body text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_operator_requests; j jsonb; v jsonb; v_prior jsonb; a fleet_agents; v_prev jsonb; v_n integer;
BEGIN
  r := fleet_operator_action_ok(p_request, 'op_act_hold_agent', p_body);
  PERFORM 1 FROM fleet_operator_principals WHERE principal_id = r.principal_id FOR UPDATE;
  j := fleet_operator_body(p_body, ARRAY['agentId','idempotencyKey','reason'], ARRAY[]::text[]);
  v := fleet_operator_params(j);
  v_prior := fleet_operator_idempotent(r.principal_id, 'hold_agent', j ->> 'idempotencyKey', v);
  IF v_prior ? 'conflict' THEN RETURN fleet_operator_conflict(r, 'hold_agent', v_prior); END IF;
  IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = v ->> 'agentId' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN fleet_operator_record_action(r, 'hold_agent', NULL, v, j ->> 'idempotencyKey', NULL, 'held', 'rejected', 'FLEET_OP_TARGET_NOT_FOUND', NULL, NULL);
  END IF;
  v_prev := fleet_operator_agent_state(a);
  IF a.status NOT IN ('active','unresponsive') THEN
    RETURN fleet_operator_record_action(r, 'hold_agent', a.agent_id, v, j ->> 'idempotencyKey', v_prev, 'held', 'rejected', 'FLEET_OP_INVALID_STATE', NULL, NULL);
  END IF;
  IF a.operator_hold_at IS NOT NULL THEN
    RETURN fleet_operator_record_action(r, 'hold_agent', a.agent_id, v, j ->> 'idempotencyKey', v_prev, 'held', 'noop', NULL,
      jsonb_build_object('held', true, 'note', 'already held'), NULL);
  END IF;
  UPDATE fleet_agents SET operator_hold_at = now(), operator_hold_by = 'op:' || r.principal_id, operator_hold_reason = v ->> 'reason'
   WHERE agent_id = a.agent_id;
  UPDATE fleet_agent_sessions SET revoked_at = now() WHERE agent_id = a.agent_id AND revoked_at IS NULL AND expires_at > now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM fleet_event('agent_hold_set', a.agent_id, 'op:' || r.principal_id, jsonb_build_object('reason', v ->> 'reason', 'sessionsRevoked', v_n));
  RETURN fleet_operator_record_action(r, 'hold_agent', a.agent_id, v, j ->> 'idempotencyKey', v_prev, 'held', 'executed', NULL,
    jsonb_build_object('held', true, 'status', a.status, 'sessionsRevoked', v_n), NULL);
END $$;

CREATE FUNCTION op_act_release_agent_hold(p_request uuid, p_body text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_operator_requests; j jsonb; v jsonb; v_prior jsonb; a fleet_agents; v_prev jsonb;
BEGIN
  r := fleet_operator_action_ok(p_request, 'op_act_release_agent_hold', p_body);
  PERFORM 1 FROM fleet_operator_principals WHERE principal_id = r.principal_id FOR UPDATE;
  j := fleet_operator_body(p_body, ARRAY['agentId','idempotencyKey','reason'], ARRAY[]::text[]);
  v := fleet_operator_params(j);
  v_prior := fleet_operator_idempotent(r.principal_id, 'release_agent_hold', j ->> 'idempotencyKey', v);
  IF v_prior ? 'conflict' THEN RETURN fleet_operator_conflict(r, 'release_agent_hold', v_prior); END IF;
  IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = v ->> 'agentId' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN fleet_operator_record_action(r, 'release_agent_hold', NULL, v, j ->> 'idempotencyKey', NULL, 'not_held', 'rejected', 'FLEET_OP_TARGET_NOT_FOUND', NULL, NULL);
  END IF;
  v_prev := fleet_operator_agent_state(a);
  IF a.operator_hold_at IS NULL THEN
    RETURN fleet_operator_record_action(r, 'release_agent_hold', a.agent_id, v, j ->> 'idempotencyKey', v_prev, 'not_held', 'noop', NULL,
      jsonb_build_object('held', false, 'note', 'not held'), NULL);
  END IF;
  -- Only the principal that placed a hold may lift it; owner holds are owner-gated.
  IF a.operator_hold_by IS DISTINCT FROM 'op:' || r.principal_id THEN
    RETURN fleet_operator_record_action(r, 'release_agent_hold', a.agent_id, v, j ->> 'idempotencyKey', v_prev, 'not_held', 'rejected',
      CASE WHEN a.operator_hold_by LIKE 'op:%' THEN 'FLEET_OP_HOLD_NOT_OWNED' ELSE 'FLEET_OP_OWNER_GATED' END, NULL, NULL);
  END IF;
  UPDATE fleet_agents SET operator_hold_at = NULL, operator_hold_by = NULL, operator_hold_reason = NULL WHERE agent_id = a.agent_id;
  PERFORM fleet_event('agent_hold_released', a.agent_id, 'op:' || r.principal_id, jsonb_build_object('reason', v ->> 'reason'));
  RETURN fleet_operator_record_action(r, 'release_agent_hold', a.agent_id, v, j ->> 'idempotencyKey', v_prev, 'not_held', 'executed', NULL,
    jsonb_build_object('held', false, 'status', a.status), NULL);
END $$;

CREATE FUNCTION op_act_request_health_challenge(p_request uuid, p_body text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_operator_requests; j jsonb; v jsonb; v_prior jsonb; a fleet_agents; v_prev jsonb;
BEGIN
  r := fleet_operator_action_ok(p_request, 'op_act_request_health_challenge', p_body);
  PERFORM 1 FROM fleet_operator_principals WHERE principal_id = r.principal_id FOR UPDATE;
  j := fleet_operator_body(p_body, ARRAY['agentId','idempotencyKey'], ARRAY['reason']);
  v := fleet_operator_params(j);
  v_prior := fleet_operator_idempotent(r.principal_id, 'request_health_challenge', j ->> 'idempotencyKey', v);
  IF v_prior ? 'conflict' THEN RETURN fleet_operator_conflict(r, 'request_health_challenge', v_prior); END IF;
  IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = v ->> 'agentId' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN fleet_operator_record_action(r, 'request_health_challenge', NULL, v, j ->> 'idempotencyKey', NULL, 'challenge_due', 'rejected', 'FLEET_OP_TARGET_NOT_FOUND', NULL, NULL);
  END IF;
  v_prev := fleet_operator_agent_state(a);
  IF a.status NOT IN ('active','unresponsive') THEN
    RETURN fleet_operator_record_action(r, 'request_health_challenge', a.agent_id, v, j ->> 'idempotencyKey', v_prev, 'challenge_due', 'rejected', 'FLEET_OP_INVALID_STATE', NULL, NULL);
  END IF;
  IF EXISTS (SELECT 1 FROM fleet_health_challenges WHERE agent_id = a.agent_id AND outcome = 'pending' AND expires_at > now()) THEN
    RETURN fleet_operator_record_action(r, 'request_health_challenge', a.agent_id, v, j ->> 'idempotencyKey', v_prev, 'challenge_due', 'noop', NULL,
      jsonb_build_object('note', 'a challenge is already pending'), NULL);
  END IF;
  UPDATE fleet_agents SET challenge_requested_at = now() WHERE agent_id = a.agent_id;
  PERFORM fleet_event('health_challenge_requested', a.agent_id, 'op:' || r.principal_id, jsonb_build_object('reason', v ->> 'reason'));
  RETURN fleet_operator_record_action(r, 'request_health_challenge', a.agent_id, v, j ->> 'idempotencyKey', v_prev, 'challenge_due', 'executed', NULL,
    jsonb_build_object('challengeDue', true, 'note', 'issued with the agent''s next heartbeat'), NULL);
END $$;

CREATE FUNCTION op_act_revoke_agent_sessions(p_request uuid, p_body text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_operator_requests; j jsonb; v jsonb; v_prior jsonb; a fleet_agents; v_prev jsonb; v_n integer;
BEGIN
  r := fleet_operator_action_ok(p_request, 'op_act_revoke_agent_sessions', p_body);
  PERFORM 1 FROM fleet_operator_principals WHERE principal_id = r.principal_id FOR UPDATE;
  j := fleet_operator_body(p_body, ARRAY['agentId','idempotencyKey','reason'], ARRAY[]::text[]);
  v := fleet_operator_params(j);
  v_prior := fleet_operator_idempotent(r.principal_id, 'revoke_agent_sessions', j ->> 'idempotencyKey', v);
  IF v_prior ? 'conflict' THEN RETURN fleet_operator_conflict(r, 'revoke_agent_sessions', v_prior); END IF;
  IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = v ->> 'agentId' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN fleet_operator_record_action(r, 'revoke_agent_sessions', NULL, v, j ->> 'idempotencyKey', NULL, 'sessions_revoked', 'rejected', 'FLEET_OP_TARGET_NOT_FOUND', NULL, NULL);
  END IF;
  v_prev := fleet_operator_agent_state(a);
  UPDATE fleet_agent_sessions SET revoked_at = now() WHERE agent_id = a.agent_id AND revoked_at IS NULL AND expires_at > now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RETURN fleet_operator_record_action(r, 'revoke_agent_sessions', a.agent_id, v, j ->> 'idempotencyKey', v_prev, 'sessions_revoked', 'noop', NULL,
      jsonb_build_object('sessionsRevoked', 0), NULL);
  END IF;
  PERFORM fleet_event('agent_sessions_revoked', a.agent_id, 'op:' || r.principal_id, jsonb_build_object('reason', v ->> 'reason', 'sessionsRevoked', v_n));
  RETURN fleet_operator_record_action(r, 'revoke_agent_sessions', a.agent_id, v, j ->> 'idempotencyKey', v_prev, 'sessions_revoked', 'executed', NULL,
    jsonb_build_object('sessionsRevoked', v_n, 'note', 'the long-lived credential still opens new sessions'), NULL);
END $$;

-- Runs the controller's own reaper policy now (at most every ${OPERATOR_RECONCILE_MIN_INTERVAL_S} s).
CREATE FUNCTION op_act_reconcile_lifecycle(p_request uuid, p_body text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_operator_requests; j jsonb; v jsonb; v_prior jsonb; st fleet_state; v_res jsonb;
BEGIN
  r := fleet_operator_action_ok(p_request, 'op_act_reconcile_lifecycle', p_body);
  PERFORM 1 FROM fleet_operator_principals WHERE principal_id = r.principal_id FOR UPDATE;
  j := fleet_operator_body(p_body, ARRAY['idempotencyKey'], ARRAY['reason']);
  v := fleet_operator_params(j);
  v_prior := fleet_operator_idempotent(r.principal_id, 'reconcile_lifecycle', j ->> 'idempotencyKey', v);
  IF v_prior ? 'conflict' THEN RETURN fleet_operator_conflict(r, 'reconcile_lifecycle', v_prior); END IF;
  IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
  st := fleet_lock_state();
  IF st.reaper_last_run_at IS NOT NULL AND st.reaper_last_run_at > now() - interval '${OPERATOR_RECONCILE_MIN_INTERVAL_S} seconds' THEN
    RETURN fleet_operator_record_action(r, 'reconcile_lifecycle', NULL, v, j ->> 'idempotencyKey',
      jsonb_build_object('reaperLastRunAt', st.reaper_last_run_at), 'reconciled', 'noop', NULL,
      jsonb_build_object('note', 'the reaper ran within the last ${OPERATOR_RECONCILE_MIN_INTERVAL_S} seconds'), NULL);
  END IF;
  v_res := fleet_reap('op:' || r.principal_id);
  RETURN fleet_operator_record_action(r, 'reconcile_lifecycle', NULL, v, j ->> 'idempotencyKey',
    jsonb_build_object('reaperLastRunAt', st.reaper_last_run_at), 'reconciled', 'executed', NULL, jsonb_build_object('reap', v_res), NULL);
END $$;

-- ── PROPOSE (scope ops.propose.agents): records a pending proposal; executes nothing.
CREATE FUNCTION op_propose_agent_action(p_request uuid, p_body text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_operator_requests; j jsonb; v jsonb; v_prior jsonb; a fleet_agents; v_prev jsonb; v_open uuid; v_id uuid; v_code text;
BEGIN
  r := fleet_operator_action_ok(p_request, 'op_propose_agent_action', p_body);
  PERFORM 1 FROM fleet_operator_principals WHERE principal_id = r.principal_id FOR UPDATE;
  j := fleet_operator_body(p_body, ARRAY['agentId','idempotencyKey','kind','reason'], ARRAY[]::text[]);
  v := fleet_operator_params(j);
  v_prior := fleet_operator_idempotent(r.principal_id, 'propose_agent_action', j ->> 'idempotencyKey', v);
  IF v_prior ? 'conflict' THEN RETURN fleet_operator_conflict(r, 'propose_agent_action', v_prior); END IF;
  IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = v ->> 'agentId' FOR SHARE;
  IF NOT FOUND THEN
    RETURN fleet_operator_record_action(r, 'propose_agent_action', NULL, v, j ->> 'idempotencyKey', NULL, 'proposal_pending', 'rejected', 'FLEET_OP_TARGET_NOT_FOUND', NULL, NULL);
  END IF;
  v_prev := fleet_operator_agent_state(a);
  IF (v ->> 'kind' IN ('quarantine_agent','terminate_agent') AND a.status NOT IN ('active','unresponsive'))
     OR (v ->> 'kind' = 'revoke_agent_credential' AND (a.status IN ('dead','failed')
         OR NOT EXISTS (SELECT 1 FROM fleet_agent_credentials c WHERE c.agent_id = a.agent_id AND c.revoked_at IS NULL))) THEN
    v_code := 'FLEET_OP_INVALID_STATE';
  ELSIF (SELECT count(*) FROM fleet_operator_proposals p WHERE p.principal_id = r.principal_id AND p.status = 'pending' AND p.expires_at > now())
        >= ${OPERATOR_MAX_PENDING_PROPOSALS} THEN
    v_code := 'FLEET_OP_TOO_MANY_PROPOSALS';
  END IF;
  IF v_code IS NOT NULL THEN
    RETURN fleet_operator_record_action(r, 'propose_agent_action', a.agent_id, v, j ->> 'idempotencyKey', v_prev, 'proposal_pending', 'rejected', v_code, NULL, NULL);
  END IF;
  SELECT proposal_id INTO v_open FROM fleet_operator_proposals
   WHERE kind = v ->> 'kind' AND target_agent_id = a.agent_id AND status = 'pending' AND expires_at > now();
  IF FOUND THEN
    RETURN fleet_operator_record_action(r, 'propose_agent_action', a.agent_id, v, j ->> 'idempotencyKey', v_prev, 'proposal_pending', 'noop', NULL,
      jsonb_build_object('note', 'an identical proposal is already pending', 'existingProposalId', v_open), NULL);
  END IF;
  v_id := gen_random_uuid();
  v_prior := fleet_operator_record_action(r, 'propose_agent_action', a.agent_id, v, j ->> 'idempotencyKey', v_prev, 'proposal_pending', 'executed', NULL,
    jsonb_build_object('kind', v ->> 'kind', 'status', 'pending', 'expiresAt', now() + interval '${OPERATOR_PROPOSAL_TTL_HOURS} hours',
      'note', 'owner approval required (fleet:admin proposal-approve); operators cannot approve'), v_id);
  INSERT INTO fleet_operator_proposals (proposal_id, action_id, principal_id, kind, target_agent_id, reason, expires_at)
    VALUES (v_id, r.request_id, r.principal_id, v ->> 'kind', a.agent_id, v ->> 'reason', now() + interval '${OPERATOR_PROPOSAL_TTL_HOURS} hours');
  PERFORM fleet_event('operator_proposal_created', a.agent_id, 'op:' || r.principal_id,
    jsonb_build_object('proposalId', v_id, 'kind', v ->> 'kind', 'reason', v ->> 'reason'));
  RETURN v_prior;
END $$;

-- ── OWNER-ONLY (never granted): decide a proposal. Re-validates current state
-- (no stale authorization), refuses operator principals and agents as
-- approvers, refuses proposals from revoked principals, and executes the
-- mapped lifecycle operation in the same transaction.
CREATE FUNCTION fleet_operator_proposal_decide(p_proposal uuid, p_decision text, p_actor text, p_note text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_operator_proposals; pr fleet_operator_principals; v_exec jsonb; v_res text; v_n integer; v_note text := left(fleet_scrub(p_note), 200);
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN
    RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: proposals are decided by the owner (operator:<name>)';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approve','reject') THEN
    RAISE EXCEPTION 'FLEET_OPERATOR_INVALID: decision must be approve or reject';
  END IF;
  PERFORM fleet_lock_state();
  SELECT * INTO p FROM fleet_operator_proposals WHERE proposal_id = p_proposal FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FLEET_OPERATOR_INVALID: no such proposal';
  END IF;
  IF p.status <> 'pending' THEN
    RAISE EXCEPTION 'FLEET_OPERATOR_INVALID: proposal is already %', p.status;
  END IF;
  SELECT * INTO pr FROM fleet_operator_principals WHERE principal_id = p.principal_id;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), p.principal_id);
  PERFORM set_config('fleet.proposal_decision', 'on', true);
  IF p.expires_at <= now() THEN
    UPDATE fleet_operator_proposals SET status = 'expired', decided_at = now(), decided_by = 'system:expiry' WHERE proposal_id = p.proposal_id;
    PERFORM set_config('fleet.proposal_decision', 'off', true);
    PERFORM fleet_event('operator_proposal_expired', p.target_agent_id, p_actor, jsonb_build_object('proposalId', p.proposal_id, 'kind', p.kind));
    RETURN jsonb_build_object('proposalId', p.proposal_id, 'status', 'expired');
  END IF;
  IF p_decision = 'reject' THEN
    UPDATE fleet_operator_proposals SET status = 'rejected', decided_at = now(), decided_by = p_actor, decision_note = v_note WHERE proposal_id = p.proposal_id;
    PERFORM set_config('fleet.proposal_decision', 'off', true);
    PERFORM fleet_event('operator_proposal_rejected', p.target_agent_id, p_actor, jsonb_build_object('proposalId', p.proposal_id, 'kind', p.kind));
    RETURN jsonb_build_object('proposalId', p.proposal_id, 'status', 'rejected');
  END IF;
  IF pr.revoked_at IS NOT NULL THEN
    PERFORM set_config('fleet.proposal_decision', 'off', true);
    RAISE EXCEPTION 'FLEET_OPERATOR_INVALID: the proposing principal has been revoked; reject the proposal instead';
  END IF;
  IF p.kind IN ('quarantine_agent','terminate_agent') THEN
    v_res := fleet_begin_termination(p.target_agent_id, p.reason, p_actor, CASE WHEN p.kind = 'quarantine_agent' THEN 'quarantine' ELSE 'operator_termination' END);
    IF v_res IS NOT NULL AND p.kind = 'quarantine_agent' THEN
      PERFORM fleet_event('agent_quarantined', p.target_agent_id, p_actor, jsonb_build_object('reason', p.reason, 'result', v_res, 'proposalId', p.proposal_id));
    END IF;
    v_exec := jsonb_build_object('applied', v_res IS NOT NULL, 'result', COALESCE(v_res, 'not applicable (agent no longer living)'));
  ELSE
    UPDATE fleet_agent_credentials SET revoked_at = now() WHERE agent_id = p.target_agent_id AND revoked_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    UPDATE fleet_agent_sessions SET revoked_at = now() WHERE agent_id = p.target_agent_id AND revoked_at IS NULL;
    IF v_n > 0 THEN
      PERFORM fleet_event('agent_credential_revoked', p.target_agent_id, p_actor, jsonb_build_object('reason', p.reason, 'proposalId', p.proposal_id));
    END IF;
    v_exec := jsonb_build_object('applied', v_n > 0, 'result', CASE WHEN v_n > 0 THEN 'credential revoked' ELSE 'not applicable (already revoked)' END);
  END IF;
  UPDATE fleet_operator_proposals SET status = 'approved', decided_at = now(), decided_by = p_actor, decision_note = v_note, execution = v_exec
   WHERE proposal_id = p.proposal_id;
  PERFORM set_config('fleet.proposal_decision', 'off', true);
  PERFORM fleet_event('operator_proposal_approved', p.target_agent_id, p_actor,
    jsonb_build_object('proposalId', p.proposal_id, 'kind', p.kind, 'proposedBy', 'op:' || p.principal_id, 'applied', v_exec -> 'applied'));
  RETURN jsonb_build_object('proposalId', p.proposal_id, 'status', 'approved', 'execution', v_exec);
END $$;

-- ── OWNER-ONLY (never granted): owner holds, which operators cannot release.
CREATE FUNCTION fleet_agent_hold_set(p_agent text, p_reason text, p_actor text) RETURNS text LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; v_n integer;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN
    RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner holds need an operator actor';
  END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR a.status NOT IN ('active','unresponsive') THEN
    RETURN 'not living';
  END IF;
  -- An owner hold replaces an operator hold (and cannot then be lifted by the operator).
  UPDATE fleet_agents SET operator_hold_at = now(), operator_hold_by = p_actor, operator_hold_reason = left(fleet_scrub(p_reason), 200)
   WHERE agent_id = p_agent;
  UPDATE fleet_agent_sessions SET revoked_at = now() WHERE agent_id = p_agent AND revoked_at IS NULL AND expires_at > now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM fleet_event('agent_hold_set', p_agent, p_actor, jsonb_build_object('reason', left(fleet_scrub(p_reason), 200), 'sessionsRevoked', v_n, 'owner', true));
  RETURN 'held';
END $$;

CREATE FUNCTION fleet_agent_hold_release(p_agent text, p_actor text) RETURNS text LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN
    RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner hold release needs an operator actor';
  END IF;
  UPDATE fleet_agents SET operator_hold_at = NULL, operator_hold_by = NULL, operator_hold_reason = NULL
   WHERE agent_id = p_agent AND operator_hold_at IS NOT NULL;
  IF NOT FOUND THEN
    RETURN 'not held';
  END IF;
  PERFORM fleet_event('agent_hold_released', p_agent, p_actor, jsonb_build_object('owner', true));
  RETURN 'released';
END $$;

-- ── Hold enforcement in the agent authentication path (v7 + one clause):
-- a held agent keeps liveness only (session, heartbeat, whoami) plus the
-- two authority-reducing self reports (own status, release reservation).
CREATE OR REPLACE FUNCTION fleet_authenticate(p_agent text, p_token text, p_action text) RETURNS text LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_agent_credentials; s fleet_agent_sessions; v_status text; v_scope text; v_hash text; v_held timestamptz;
BEGIN
  IF p_agent IS NULL OR p_token IS NULL OR length(p_token) > 256 OR length(p_agent) > 64 THEN
    PERFORM fleet_event('db_auth_failed', NULL, NULL, jsonb_build_object('action', p_action, 'why', 'malformed'));
    RETURN 'FLEET_AUTH_FAILED';
  END IF;
  v_hash := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  SELECT status, capability_scope, operator_hold_at INTO v_status, v_scope, v_held FROM fleet_agents WHERE agent_id = p_agent;
  IF p_token LIKE 'fs1.%' THEN
    SELECT * INTO s FROM fleet_agent_sessions WHERE session_hash = v_hash;
    IF NOT FOUND OR s.agent_id <> p_agent THEN
      PERFORM fleet_event('db_auth_failed', NULL, NULL,
        jsonb_build_object('action', p_action, 'claimedAgentId', left(p_agent, 64), 'why', 'bad session'));
      RETURN 'FLEET_AUTH_FAILED';
    END IF;
  ELSE
    SELECT * INTO c FROM fleet_agent_credentials WHERE agent_id = p_agent;
    IF NOT FOUND OR c.token_hash <> v_hash THEN
      PERFORM fleet_event('db_auth_failed', NULL, NULL,
        jsonb_build_object('action', p_action, 'claimedAgentId', left(p_agent, 64), 'why', 'bad credential'));
      RETURN 'FLEET_AUTH_FAILED';
    END IF;
  END IF;
  IF v_status IN ('dead','failed') THEN
    RETURN 'FLEET_AGENT_DEAD';
  END IF;
  IF v_status IN ('terminating','orphaned') THEN
    PERFORM fleet_event('db_auth_failed', p_agent, p_agent, jsonb_build_object('action', p_action, 'why', 'quarantined'));
    RETURN 'FLEET_AGENT_QUARANTINED';
  END IF;
  IF (s.session_hash IS NOT NULL AND s.revoked_at IS NOT NULL) OR (c.agent_id IS NOT NULL AND c.revoked_at IS NOT NULL) THEN
    PERFORM fleet_event('db_auth_failed', p_agent, p_agent, jsonb_build_object('action', p_action, 'why', 'revoked'));
    RETURN 'FLEET_AUTH_FAILED';
  END IF;
  IF s.session_hash IS NOT NULL THEN
    IF s.expires_at <= now() THEN
      RETURN 'FLEET_SESSION_EXPIRED';
    END IF;
    IF EXISTS (SELECT 1 FROM fleet_agent_credentials WHERE agent_id = p_agent AND revoked_at IS NOT NULL) THEN
      RETURN 'FLEET_AUTH_FAILED';
    END IF;
  END IF;
  IF v_held IS NOT NULL AND (p_action IS NULL OR p_action NOT IN ('open_session','heartbeat','whoami','set_own_status','release_reservation')) THEN
    PERFORM fleet_event('scope_denied', p_agent, p_agent,
      jsonb_build_object('action', left(COALESCE(p_action, ''), 64), 'scope', 'held', 'layer', 'database'));
    RETURN 'FLEET_AGENT_HELD';
  END IF;
  IF v_scope IS DISTINCT FROM 'full'
     AND NOT (v_scope = 'witness' AND p_action IN ('open_session','heartbeat','whoami')) THEN
    PERFORM fleet_event('scope_denied', p_agent, p_agent,
      jsonb_build_object('action', left(COALESCE(p_action, ''), 64), 'scope', v_scope, 'layer', 'database'));
    RETURN 'FLEET_SCOPE_DENIED';
  END IF;
  RETURN NULL;
END $$;

-- ── Challenge issuance (v5 + operator request): an operator-requested
-- challenge is due even inside the normal interval.
CREATE OR REPLACE FUNCTION svc_issue_challenge(p_agent text, p_challenge_id text, p_nonce_hash text, p_canary text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; st fleet_state; last fleet_health_challenges; v_exp timestamptz;
BEGIN
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR a.status NOT IN ('active','unresponsive') THEN
    RETURN jsonb_build_object('issued', false, 'reason', 'not living');
  END IF;
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  SELECT * INTO last FROM fleet_health_challenges WHERE agent_id = p_agent ORDER BY issued_at DESC LIMIT 1;
  IF FOUND AND last.outcome = 'pending' THEN
    IF last.expires_at > now() THEN
      RETURN jsonb_build_object('issued', false, 'reason', 'pending');
    END IF;
    PERFORM fleet_expire_challenge(last.challenge_id);
  ELSIF FOUND AND last.outcome = 'passed' AND last.issued_at > now() - make_interval(secs => st.health_challenge_interval_s)
        AND (a.challenge_requested_at IS NULL OR a.challenge_requested_at <= last.issued_at) THEN
    RETURN jsonb_build_object('issued', false, 'reason', 'not due');
  END IF;
  v_exp := now() + make_interval(secs => st.challenge_ttl_s);
  INSERT INTO fleet_health_challenges (challenge_id, agent_id, nonce_hash, canary, expires_at)
  VALUES (p_challenge_id, p_agent, p_nonce_hash, left(p_canary, 200), v_exp);
  RETURN jsonb_build_object('issued', true, 'expiresAt', v_exp);
END $$;

-- ── Tier 2 read functions (STABLE; a fresh GET request id for themselves)

CREATE FUNCTION op_lifecycle_health(p_request uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_operator_requests; s fleet_state; o fleet_operator_state;
BEGIN
  r := fleet_operator_request_ok(p_request, 'op_lifecycle_health');
  SELECT * INTO s FROM fleet_state WHERE id = 1;
  SELECT * INTO o FROM fleet_operator_state WHERE id = 1;
  RETURN jsonb_build_object(
    'fleet', jsonb_build_object('maxAgents', s.max_agents, 'living', s.living_agents, 'reserved', s.reserved_slots,
      'quarantined', s.quarantined_slots, 'mode', s.operating_mode, 'replicationEnabled', s.replication_enabled),
    'agentsByStatus', COALESCE((SELECT jsonb_object_agg(x.status, x.n) FROM (SELECT status, count(*) AS n FROM fleet_agents GROUP BY status) x), '{}'::jsonb),
    'held', (SELECT count(*) FROM fleet_agents WHERE operator_hold_at IS NOT NULL AND status IN ('active','unresponsive')),
    'staleHeartbeats', (SELECT count(*) FROM fleet_agents a WHERE a.status = 'active'
                          AND COALESCE(a.last_heartbeat, a.updated_at) < now() - make_interval(secs => s.heartbeat_unresponsive_s)),
    'pendingChallenges', (SELECT count(*) FROM fleet_health_challenges WHERE outcome = 'pending'),
    'overdueChallenges', (SELECT count(*) FROM fleet_health_challenges WHERE outcome = 'pending' AND expires_at <= now()),
    'openReservations', (SELECT count(*) FROM fleet_reservations WHERE status IN ('reserved','provisioning')),
    'expiredOpenReservations', (SELECT count(*) FROM fleet_reservations WHERE status IN ('reserved','provisioning') AND expires_at <= now()),
    'openOrphans', (SELECT count(*) FROM fleet_orphans WHERE resolved_at IS NULL),
    'orphansHoldingSlots', (SELECT count(*) FROM fleet_orphans WHERE resolved_at IS NULL AND holds_slot AND slot_released_at IS NULL),
    'pendingTerminations', (SELECT count(*) FROM fleet_sandbox_terminations WHERE status IN ('pending','failed')),
    'provisioningNeedingCleanup', (SELECT count(*) FROM fleet_provisioning WHERE cleanup_status IN ('pending','unsupported','failed')),
    'pendingProposals', (SELECT count(*) FROM fleet_operator_proposals WHERE status = 'pending' AND expires_at > now()),
    'reaper', jsonb_build_object('lastRunAt', s.reaper_last_run_at,
      'overdue', s.reaper_last_run_at IS NULL OR s.reaper_last_run_at < now() - make_interval(secs => s.heartbeat_unresponsive_s)),
    'policy', jsonb_build_object('heartbeatUnresponsiveS', s.heartbeat_unresponsive_s, 'healthChallengeIntervalS', s.health_challenge_interval_s,
      'challengeTtlS', s.challenge_ttl_s, 'healthGraceS', s.health_grace_s, 'maxChallengeFailures', s.max_challenge_failures,
      'terminationGraceS', s.termination_grace_s, 'orphanSlotHoldS', s.orphan_slot_hold_s, 'maxOpenOrphans', s.max_open_orphans,
      'sessionTtlS', s.session_ttl_s),
    'operatorApi', jsonb_build_object('enabled', o.operator_api_enabled, 'actionsEnabled', o.operator_actions_enabled,
      'generation', o.generation),
    'dbTime', now());
END $$;

CREATE FUNCTION op_runtime_status(p_request uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_operator_requests; s fleet_state;
BEGIN
  r := fleet_operator_request_ok(p_request, 'op_runtime_status');
  SELECT * INTO s FROM fleet_state WHERE id = 1;
  RETURN jsonb_build_object('approved', jsonb_build_object('repo', s.runtime_repo, 'commit', s.runtime_commit,
      'buildId', s.runtime_build_id, 'lockfileSha256', s.runtime_lockfile_sha256),
    'schemaVersion', (SELECT max(version) FROM fleet_schema_migrations), 'dbTime', now());
END $$;

CREATE FUNCTION op_list_reservations(p_request uuid, p_after text, p_limit integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_operator_requests; v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
BEGIN
  r := fleet_operator_request_ok(p_request, 'op_list_reservations');
  RETURN jsonb_build_object('items', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('reservationId', x.reservation_id, 'agentId', x.agent_id, 'parentAgentId', x.parent_agent_id,
             'status', x.status, 'dryRun', x.dry_run, 'createdAt', x.created_at, 'expiresAt', x.expires_at, 'claimedAt', x.claimed_at,
             'completedAt', x.completed_at, 'endedAt', x.ended_at, 'endReason', x.end_reason, 'expectedCommit', x.expected_commit)
           ORDER BY x.reservation_id)
      FROM (SELECT * FROM fleet_reservations WHERE p_after IS NULL OR reservation_id > p_after ORDER BY reservation_id LIMIT v_limit + 1) x
  ), '[]'::jsonb), 'limit', v_limit);
END $$;

CREATE FUNCTION op_list_orphans(p_request uuid, p_after bigint, p_limit integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_operator_requests; v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
BEGIN
  r := fleet_operator_request_ok(p_request, 'op_list_orphans');
  RETURN jsonb_build_object('items', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('orphanId', x.orphan_id::text, 'agentId', x.agent_id, 'reason', x.reason, 'holdsSlot', x.holds_slot,
             'detectedAt', x.detected_at, 'slotReleasedAt', x.slot_released_at, 'resolvedAt', x.resolved_at)
           ORDER BY x.orphan_id)
      FROM (SELECT * FROM fleet_orphans WHERE p_after IS NULL OR orphan_id > p_after ORDER BY orphan_id LIMIT v_limit + 1) x
  ), '[]'::jsonb), 'limit', v_limit);
END $$;

CREATE FUNCTION op_list_proposals(p_request uuid, p_after bigint, p_limit integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_operator_requests; v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
BEGIN
  r := fleet_operator_request_ok(p_request, 'op_list_proposals');
  RETURN jsonb_build_object('items', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('seq', x.seq::text, 'proposalId', x.proposal_id, 'principalId', x.principal_id, 'kind', x.kind,
             'targetAgentId', x.target_agent_id, 'reason', x.reason,
             'status', CASE WHEN x.status = 'pending' AND x.expires_at <= now() THEN 'expired' ELSE x.status END,
             'createdAt', x.created_at, 'expiresAt', x.expires_at, 'decidedAt', x.decided_at,
             'decidedBy', CASE WHEN x.decided_by LIKE 'operator:%' THEN 'owner' ELSE x.decided_by END,
             'applied', x.execution -> 'applied')
           ORDER BY x.seq)
      FROM (SELECT * FROM fleet_operator_proposals WHERE p_after IS NULL OR seq > p_after ORDER BY seq LIMIT v_limit + 1) x
  ), '[]'::jsonb), 'limit', v_limit);
END $$;

CREATE FUNCTION op_list_actions(p_request uuid, p_after bigint, p_limit integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_operator_requests; v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
BEGIN
  r := fleet_operator_request_ok(p_request, 'op_list_actions');
  RETURN jsonb_build_object('items', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('seq', x.seq::text, 'actionId', x.action_id, 'principalId', x.principal_id,
             'principalKind', x.principal_kind, 'action', x.action, 'scope', x.scope, 'targetAgentId', x.target_agent_id,
             'decision', x.decision, 'code', x.failure_code, 'requestedState', x.requested_state, 'previousState', x.previous_state,
             'reason', x.params ->> 'reason', 'proposalId', x.proposal_id, 'createdAt', x.created_at)
           ORDER BY x.seq)
      FROM (SELECT * FROM fleet_operator_actions WHERE p_after IS NULL OR seq > p_after ORDER BY seq LIMIT v_limit + 1) x
  ), '[]'::jsonb), 'limit', v_limit);
END $$;

-- The B2 agent view (fleet_operator_agent_json) is deliberately unchanged: deployed
-- clients validate its exact key set. Hold state is exposed by lifecycle reads and action results.

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
