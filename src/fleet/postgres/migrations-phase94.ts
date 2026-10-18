/**
 * Schema v94 — the agent receives current decisions and Fleet Control's notices, and finished work wakes it (owner,
 * 2026-10-18, after the proof run: Agent-1 kept waiting on an approval the owner had since replaced, and never read the
 * Fleet Control notice that told it so).
 *
 * 1. SUPERSESSION. An answered request stays exactly as it was (immutable history). When a later owner decision replaces
 *    it, `fleet_admin_owner_request_supersede` records the decision once, in the append-only
 *    `fleet_owner_request_supersessions`, and Fleet Control tells the agent. `fleet_owner_request_json` carries
 *    `supersededBy` everywhere the request is shown: the agent's dependency list (the runtime shows the current decision
 *    in its task), the conversation in Fleet HQ, and the CLI.
 * 2. NOTICES. `fleet_agent_attention.notices` holds Fleet Control's notices of the last 14 days (id, time, text; newest first,
 *    at most 5). The runtime puts each one it has not shown yet into the agent's next working turn. A new notice already
 *    changes `eventsDigest` (v67), which wakes a waiting agent.
 * 3. WAKE. `eventsDigest` also changes when one of the agent's requests is superseded, and when one of its jobs finishes
 *    (code, channel, identity, provider and media jobs). `recentEvents` lists notices, supersessions and finished jobs.
 * 4. RUN BUDGET (owner, 2026-10-18: "a run-specific total AI ceiling … enforced before requests, accounting for in-flight
 *    work and retries"; a daily fuse is not a fresh run allowance). The owner opens ONE bounded run for an agent: a
 *    ceiling in the ledger currency and an end time. Before every routed or conversation request, the controller adds
 *    what the run has cost so far (every call logged for this agent since the run began, whoever paid: the agent's own
 *    work and the treasury-paid conversation turns), every request still in flight, and this request's worst-case
 *    estimate. A request that would cross the ceiling, or that comes after the end time, is refused before the provider
 *    (free). It is a pilot control: one run at a time, ended by the owner or by its end time. It is never a standing
 *    limit on the business.
 */
import { V22_SQL } from "./migrations-phase22.js";
import { V26_SQL } from "./migrations-phase26.js";
import { V62_SQL } from "./migrations-phase62.js";
import { V79_SQL } from "./migrations-phase79.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));

export const SUPERSEDE_DECISION_MAX = 1_000;
export const NOTICES_IN_ATTENTION = 5;
/** Jobs whose completion wakes the agent, and the tool that reads each. */
export const WAKE_JOB_TABLES = Object.freeze({ fleet_code_jobs: "code", fleet_channel_jobs: "business", fleet_identity_jobs: "identity", fleet_provider_jobs: "storefront", fleet_media_jobs: "web_search / generate_image" } as const);

const finishedJobs = Object.entries(WAKE_JOB_TABLES).map(([t, tool]) =>
  `SELECT job_id, status, finished_at, '${tool}' AS tool FROM ${t} WHERE agent_id = p_agent AND finished_at > now() - interval '14 days'`).join("\n          UNION ALL ");

const REQUEST_JSON = restate(V26_SQL, "fleet_owner_request_json", [
  [`'importedAt', r.imported_at) END)`, `'importedAt', r.imported_at) END,
    -- v94: the owner's current decision that replaced this resolved request (the request itself stays on record).
    'supersededBy', (SELECT jsonb_build_object('decision', s.decision, 'at', s.superseded_at, 'by', s.superseded_by)
                       FROM fleet_owner_request_supersessions s WHERE s.request_id = r.request_id))`],
]);

const ATTENTION = restate(V79_SQL, "fleet_agent_attention", [
  [`<= now() + interval '24 hours'))),
    -- v68: what happened`, `<= now() + interval '24 hours'),
      -- v94: one of the agent's requests superseded by the owner's current decision; one of its jobs finished.
      (SELECT count(*) || ':' || COALESCE(max(s.superseded_at)::text, '') FROM fleet_owner_request_supersessions s
         JOIN fleet_owner_requests r ON r.request_id = s.request_id WHERE r.agent_id = p_agent),
      (SELECT count(*) || ':' || COALESCE(max(finished_at)::text, '') FROM (
          ${finishedJobs}) j))),
    -- v68: what happened`],
  [`FROM fleet_paypal_disputes WHERE agent_id = p_agent AND updated_at > now() - interval '14 days') x`,
   `FROM fleet_paypal_disputes WHERE agent_id = p_agent AND updated_at > now() - interval '14 days'
        -- v94: Fleet Control notices (their text is in attention.notices), supersessions and finished jobs.
        UNION ALL SELECT jsonb_build_object('kind', 'fleet_notice', 'id', message_id, 'at', created_at, 'tool', '(its text is in your task)')
          FROM fleet_agent_messages WHERE agent_id = p_agent AND author = 'fleet_control' AND created_at > now() - interval '14 days'
        UNION ALL SELECT jsonb_build_object('kind', 'request_superseded', 'id', s.request_id, 'status', 'superseded', 'at', s.superseded_at,
            'tool', '(the current decision is in your task)')
          FROM fleet_owner_request_supersessions s JOIN fleet_owner_requests r ON r.request_id = s.request_id
         WHERE r.agent_id = p_agent AND s.superseded_at > now() - interval '14 days'
        UNION ALL SELECT jsonb_build_object('kind', 'job_finished', 'id', j.job_id, 'status', j.status, 'at', j.finished_at, 'tool', j.tool) FROM (
          ${finishedJobs}) j) x`],
  [`ORDER BY ev ->> 'at' DESC LIMIT 20) y))`, `ORDER BY ev ->> 'at' DESC LIMIT 20) y),
    -- v94: Fleet Control's notices of the last 14 days, newest first (the runtime shows each unseen one in the next working turn).
    'notices', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', m.message_id, 'at', m.created_at, 'body', left(m.body, 1500)) ORDER BY m.created_at DESC), '[]'::jsonb)
      FROM (SELECT message_id, created_at, body FROM fleet_agent_messages WHERE agent_id = p_agent AND author = 'fleet_control'
             AND created_at > now() - interval '14 days' ORDER BY created_at DESC LIMIT ${NOTICES_IN_ATTENTION}) m))`],
]);

export const RUN_BUDGET_MAX_HOURS = 24;
const RUN_CHECK = `  -- v94: an open run budget is checked before the provider: the run's cost so far + requests in flight + this one's worst case.
  r := fleet_cognition_run_refusal(p_agent, p_estimate_usd_cents);
  IF r IS NOT NULL THEN RETURN r; END IF;
`;
const ROUTED_AUTHORIZE = restate(V22_SQL, "svc_cognition_routed_authorize", [
  [`  -- Every legacy circuit breaker (switches, pause, busy, rate, daily budget, FX, cash, protected capital, provider credit).
  r := svc_cognition_authorize(p_agent, p_estimate_usd_cents);`, `${RUN_CHECK}  -- Every legacy circuit breaker (switches, pause, busy, rate, daily budget, FX, cash, protected capital, provider credit).
  r := svc_cognition_authorize(p_agent, p_estimate_usd_cents);`],
]);
const CONVERSATION_AUTHORIZE = restate(V62_SQL, "svc_cognition_conversation_authorize", [
  [`  -- v62: inside an open owner turn of this Agent`, `${RUN_CHECK}  -- v62: inside an open owner turn of this Agent`],
]);

export const V94_SQL = `
CREATE TABLE fleet_owner_request_supersessions (
  request_id    uuid        PRIMARY KEY REFERENCES fleet_owner_requests (request_id),
  decision      text        NOT NULL CHECK (length(decision) BETWEEN 3 AND ${SUPERSEDE_DECISION_MAX}),
  superseded_by text        NOT NULL,
  superseded_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION fleet_owner_request_supersessions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: a supersession is permanent history'; END $$;
CREATE TRIGGER fleet_owner_request_supersessions_guard BEFORE UPDATE OR DELETE ON fleet_owner_request_supersessions FOR EACH ROW
  EXECUTE FUNCTION fleet_owner_request_supersessions_guard();
CREATE TRIGGER fleet_owner_request_supersessions_no_truncate BEFORE TRUNCATE ON fleet_owner_request_supersessions FOR EACH STATEMENT
  EXECUTE FUNCTION fleet_history_immutable();

-- Owner: a resolved request is replaced by a current decision. Once per request; the request itself never changes.
CREATE FUNCTION fleet_admin_owner_request_supersede(p_id uuid, p_decision text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_owner_requests; v_decision text := btrim(COALESCE(fleet_scrub_long(p_decision), '')); s fleet_owner_request_supersessions;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  SELECT * INTO r FROM fleet_owner_requests WHERE request_id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such request'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), r.agent_id);
  IF r.status = 'pending' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: the request is still open: decide it instead'; END IF;
  SELECT * INTO s FROM fleet_owner_request_supersessions WHERE request_id = p_id;
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'requestId', p_id, 'supersededBy', jsonb_build_object('decision', s.decision, 'at', s.superseded_at)); END IF;
  IF length(v_decision) NOT BETWEEN 3 AND ${SUPERSEDE_DECISION_MAX} THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the decision is 3..${SUPERSEDE_DECISION_MAX} characters'; END IF;
  INSERT INTO fleet_owner_request_supersessions (request_id, decision, superseded_by) VALUES (p_id, v_decision, p_actor) RETURNING * INTO s;
  PERFORM fleet_spend_review_notice(r.agent_id, format('Fleet Control: your request “%s” (%s, %s) is superseded by the owner''s current decision: “%s”. The request stays on record; act on the current decision and do not wait on the earlier answer.',
    left(r.title, 160), left(p_id::text, 8), r.status, v_decision));
  PERFORM fleet_event('owner_request_superseded', r.agent_id, p_actor, jsonb_build_object('requestId', p_id, 'previousStatus', r.status));
  RETURN jsonb_build_object('ok', true, 'requestId', p_id, 'title', r.title, 'status', r.status, 'supersededBy', jsonb_build_object('decision', s.decision, 'at', s.superseded_at),
    'note', 'the request stays on record; the agent receives the current decision in its next working turn');
END $$;

${REQUEST_JSON}

${ATTENTION}

-- ═══ 4. Run budget ═══
CREATE TABLE fleet_cognition_run_budgets (
  run_id        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      text        NOT NULL REFERENCES fleet_agents (agent_id),
  ceiling_minor bigint      NOT NULL CHECK (ceiling_minor BETWEEN 1 AND 100000),
  starts_at     timestamptz NOT NULL DEFAULT now(),
  ends_at       timestamptz NOT NULL,
  note          text        NOT NULL CHECK (length(note) BETWEEN 3 AND 300),
  set_by        text        NOT NULL,
  ended_at      timestamptz,
  ended_by      text,
  end_reason    text        CHECK (length(end_reason) <= 300),
  CHECK (ends_at > starts_at)
);
CREATE UNIQUE INDEX fleet_cognition_run_budgets_open ON fleet_cognition_run_budgets (agent_id) WHERE ended_at IS NULL;

-- What the open run of an agent has cost (ledger minor units ×1e6): every logged call of this agent since it began.
CREATE FUNCTION fleet_cognition_run_json(p_agent text) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT CASE WHEN b.run_id IS NULL THEN NULL ELSE jsonb_build_object('runId', b.run_id, 'ceilingMinor', b.ceiling_minor, 'startsAt', b.starts_at, 'endsAt', b.ends_at,
    'note', b.note, 'open', b.ended_at IS NULL AND now() < b.ends_at,
    'spentMicro', (SELECT COALESCE(sum(COALESCE(l.charged_microcents, l.charged_cents * 1000000)), 0) FROM fleet_cognition_log l WHERE l.agent_id = b.agent_id AND l.at >= b.starts_at
                    AND (b.ended_at IS NULL OR l.at <= b.ended_at)),
    'calls', (SELECT count(*) FROM fleet_cognition_log l WHERE l.agent_id = b.agent_id AND l.at >= b.starts_at AND (b.ended_at IS NULL OR l.at <= b.ended_at)),
    'inflightMicro', (SELECT COALESCE(sum(i.estimate_cents), 0) * 1000000 FROM fleet_cognition_inflight i WHERE i.agent_id = b.agent_id),
    'endedAt', b.ended_at, 'endReason', b.end_reason) END
  FROM (SELECT NULL) d LEFT JOIN LATERAL (SELECT * FROM fleet_cognition_run_budgets WHERE agent_id = p_agent ORDER BY starts_at DESC LIMIT 1) b ON true
$$;

-- Null = no open run or within it; otherwise the refusal (before the provider: nothing is spent).
CREATE FUNCTION fleet_cognition_run_refusal(p_agent text, p_estimate_usd_cents bigint) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE b fleet_cognition_run_budgets; j jsonb; v_acct text; fx fleet_fx_rates; v_rate bigint := 1000000; v_est_micro bigint;
BEGIN
  SELECT * INTO b FROM fleet_cognition_run_budgets WHERE agent_id = p_agent AND ended_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF now() >= b.ends_at THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_RUN_ENDED', 'reason', 'the run''s time limit has passed'); END IF;
  SELECT accounting_currency INTO v_acct FROM fleet_economic_model WHERE id = 1;
  IF v_acct IS DISTINCT FROM 'USD' THEN
    fx := fleet_fx_latest('USD', v_acct);
    IF fx.rate_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_FX_UNAVAILABLE'); END IF;
    v_rate := fx.rate_micro;
  END IF;
  v_est_micro := GREATEST(ceil(GREATEST(COALESCE(p_estimate_usd_cents, 0), 1)::numeric * v_rate / 1000000)::bigint, 1) * 1000000;
  j := fleet_cognition_run_json(p_agent);
  IF (j ->> 'spentMicro')::bigint + (j ->> 'inflightMicro')::bigint + v_est_micro > b.ceiling_minor * 1000000 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_RUN_BUDGET_EXHAUSTED',
      'reason', format('the run''s ceiling (%s minor units) does not cover this request''s worst case on top of what the run has cost', b.ceiling_minor));
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION fleet_admin_cognition_run_start(p_agent text, p_ceiling_minor bigint, p_hours numeric, p_note text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), p_agent);
  IF NOT EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = p_agent) THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such agent'; END IF;
  IF p_ceiling_minor IS NULL OR p_ceiling_minor NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the ceiling is 1..100000 minor units'; END IF;
  IF p_hours IS NULL OR p_hours <= 0 OR p_hours > ${RUN_BUDGET_MAX_HOURS} THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: hours is 0..${RUN_BUDGET_MAX_HOURS}'; END IF;
  IF p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 3 AND 300 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: say what the run is (3..300 characters)'; END IF;
  IF EXISTS (SELECT 1 FROM fleet_cognition_run_budgets WHERE agent_id = p_agent AND ended_at IS NULL AND now() < ends_at) THEN
    RAISE EXCEPTION 'FLEET_INVALID_STATE: a run is already open for this agent: end it first';
  END IF;
  UPDATE fleet_cognition_run_budgets SET ended_at = ends_at, ended_by = 'time limit', end_reason = 'the time limit passed'
   WHERE agent_id = p_agent AND ended_at IS NULL;
  INSERT INTO fleet_cognition_run_budgets (agent_id, ceiling_minor, ends_at, note, set_by)
    VALUES (p_agent, p_ceiling_minor, now() + make_interval(secs => p_hours * 3600), btrim(p_note), p_actor) RETURNING run_id INTO v_id;
  PERFORM fleet_event('cognition_run_started', p_agent, p_actor, jsonb_build_object('runId', v_id, 'ceilingMinor', p_ceiling_minor, 'hours', p_hours));
  RETURN jsonb_build_object('ok', true, 'run', fleet_cognition_run_json(p_agent),
    'note', 'every routed and conversation request of this agent is checked against the ceiling before the provider; the run ends at its end time or when you end it');
END $$;

CREATE FUNCTION fleet_admin_cognition_run_end(p_agent text, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE n integer;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), p_agent);
  UPDATE fleet_cognition_run_budgets SET ended_at = LEAST(now(), ends_at), ended_by = p_actor, end_reason = left(COALESCE(NULLIF(btrim(p_reason), ''), 'ended by the owner'), 300)
   WHERE agent_id = p_agent AND ended_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN PERFORM fleet_event('cognition_run_ended', p_agent, p_actor, jsonb_build_object('reason', left(COALESCE(p_reason, ''), 300))); END IF;
  RETURN jsonb_build_object('ok', true, 'ended', n > 0, 'run', fleet_cognition_run_json(p_agent));
END $$;
CREATE FUNCTION fleet_admin_cognition_run(p_agent text) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$ SELECT COALESCE(fleet_cognition_run_json(p_agent), 'null'::jsonb) $$;

${ROUTED_AUTHORIZE}

${CONVERSATION_AUTHORIZE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
