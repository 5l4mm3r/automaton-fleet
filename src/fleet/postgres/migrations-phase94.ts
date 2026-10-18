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
 */
import { V26_SQL } from "./migrations-phase26.js";
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

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
