/**
 * Schema v100 — a buyer's message is an obligation until it is resolved, and an agent's refusals carry their reasons
 * (2026-10-19, the purchase proof: the owner sent a fault report on the paid order's page at 19:13; Agent-1 made 23 model
 * calls, was refused seven inspections as "bad request" — the inspector had been killed by the unit's system-call filter —
 * and from its next turn on no longer saw the message at all: customer messages reached it only as "since your last turn"
 * events. It never answered.)
 *
 * 1. OBLIGATIONS. `fleet_customer_obligations(agent)` is the state of every buyer request, derived from the record:
 *    - an ORDER thread is open from the first buyer message after its last resolution — a delivery created after that
 *      message and sent, or an agent message marked `resolves` (order_message {resolved: true}: nothing more is owed);
 *      it is UNANSWERED while its newest buyer message has no agent message after it, ACKNOWLEDGED (answered, not yet
 *      resolved) once one has; `delivering` while a delivery made after it is still queued;
 *    - an ENQUIRY thread (before a sale) is UNANSWERED while its newest buyer message has no agent message after it.
 *    `fleet_agent_attention.customerObligations` carries them (90 days, at most 10, oldest first). The runtime shows them
 *    in every packet until they are resolved and refuses a sleep while one is unanswered. They are deliberately NOT in
 *    `eventsDigest` (a new buyer message already changes it): the agent's own answer must not wake it again. The
 *    purchase-proof watchdog stops a run on exactly this definition (scripts/fleet-purchase-proof.sh).
 * 2. REFUSAL REASONS. The runtime's closing note (`mind.report`) carries the turn's refusals — tool, code and a bounded,
 *    redacted reason (≤ 10; reasons scrubbed again here, ≤ 300 characters) — in `fleet_agent_mind_reports.refusals`. A
 *    FLEET_PLATFORM_FAULT among them (a tool the platform could not run: the sandbox, the inspector) raises one AMBER
 *    notification per agent per day (AGENT_TOOL_FAULT), with the reason.
 */
import { V94_SQL } from "./migrations-phase94.js";
import { V76_SQL } from "./migrations-phase76.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));

export const AGENT_TOOL_FAULT = "AGENT_TOOL_FAULT";
export const OBLIGATIONS_MAX = 10;

const ATTENTION = restate(V94_SQL, "fleet_agent_attention", [
  [`    -- v94: Fleet Control's notices of the last 14 days`, `    -- v100: every buyer request still owed an answer or a resolution (state; never only "news since the last turn").
    'customerObligations', fleet_customer_obligations(p_agent),
    -- v94: Fleet Control's notices of the last 14 days`],
]);

const ORDER_MESSAGE = restate(V76_SQL, "fleet_econ_order_message", [
  [`  INSERT INTO fleet_customer_messages (agent_id, order_id, author, body, mail_message_id)
    VALUES (p_agent, o.order_id, 'agent', v_body,`, `  IF a ? 'resolved' AND jsonb_typeof(a -> 'resolved') <> 'boolean' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: resolved is true or false'; END IF;
  INSERT INTO fleet_customer_messages (agent_id, order_id, author, body, resolves, mail_message_id)
    VALUES (p_agent, o.order_id, 'agent', v_body, COALESCE((a ->> 'resolved')::boolean, false),`],
  [`  RETURN jsonb_build_object('ok', true, 'messageId', m.message_id);`,
   `  RETURN jsonb_build_object('ok', true, 'messageId', m.message_id, 'resolves', m.resolves,
    'obligation', (SELECT x FROM jsonb_array_elements(fleet_customer_obligations(p_agent)) x WHERE x ->> 'id' = o.order_id::text));`],
]);

const MIND_REPORT = restate(V94_SQL, "fleet_econ_mind_report", [
  [`  INSERT INTO fleet_agent_mind_reports (agent_id, request_id, packet, outcome, wake_on, review_at, tools)`,
   `  -- v100: the turn's refusals with their reasons (bounded and scrubbed again here).
  SELECT COALESCE(jsonb_agg(jsonb_build_object('tool', left(COALESCE(x ->> 'tool', '?'), 64),
           'code', CASE WHEN x ->> 'code' ~ '^[A-Z][A-Z0-9_]{2,63}$' THEN x ->> 'code' ELSE 'FLEET_UNKNOWN' END,
           'reason', left(fleet_scrub(COALESCE(x ->> 'reason', '')), 300)) ORDER BY n), '[]'::jsonb)
    INTO v_refusals
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a -> 'refusals') = 'array' THEN a -> 'refusals' ELSE '[]'::jsonb END) WITH ORDINALITY t(x, n)
   WHERE n <= 10 AND jsonb_typeof(x) = 'object';
  INSERT INTO fleet_agent_mind_reports (agent_id, request_id, packet, outcome, wake_on, review_at, tools, refusals)`],
  [`            COALESCE((SELECT array_agg(left(t, 64)) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(a -> 'tools') = 'array' THEN a -> 'tools' ELSE '[]'::jsonb END) t), '{}'));`,
   `            COALESCE((SELECT array_agg(left(t, 64)) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(a -> 'tools') = 'array' THEN a -> 'tools' ELSE '[]'::jsonb END) t), '{}'),
            v_refusals);
  -- v100: a tool the platform could not run is the Fleet's fault: the owner is told (once a day per agent), with the reason.
  SELECT x INTO v_fault FROM jsonb_array_elements(v_refusals) x WHERE x ->> 'code' = 'FLEET_PLATFORM_FAULT' LIMIT 1;
  IF v_fault IS NOT NULL THEN
    PERFORM fleet_notify('AMBER', '${AGENT_TOOL_FAULT}', p_agent,
      'An agent''s tool failed on the platform (' || (v_fault ->> 'tool') || '): the agent was told it is not its fault; the Fleet must fix it',
      jsonb_build_object('tool', v_fault ->> 'tool', 'reason', v_fault ->> 'reason'), 'agent-tool-fault:' || p_agent || ':' || to_char(now(), 'YYYY-MM-DD'));
  END IF;`],
  [`DECLARE v_review timestamptz;`, `DECLARE v_review timestamptz; v_refusals jsonb; v_fault jsonb;`],
]);

export const V100_SQL = `
ALTER TABLE fleet_customer_messages ADD COLUMN resolves boolean NOT NULL DEFAULT false;
ALTER TABLE fleet_customer_messages ADD CONSTRAINT fleet_customer_messages_resolves_agent CHECK (NOT resolves OR (author = 'agent' AND order_id IS NOT NULL));
ALTER TABLE fleet_agent_mind_reports ADD COLUMN refusals jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(refusals) = 'array' AND jsonb_array_length(refusals) <= 10);

-- v100: every buyer request still owed an answer (unanswered) or a resolution (acknowledged), from the record itself.
CREATE FUNCTION fleet_customer_obligations(p_agent text) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  WITH orders AS (
    SELECT o.order_id,
           GREATEST((SELECT max(d.created_at) FROM fleet_order_deliveries d WHERE d.order_id = o.order_id AND d.status = 'sent'),
                    (SELECT max(m.created_at) FROM fleet_customer_messages m WHERE m.order_id = o.order_id AND m.author = 'agent' AND m.resolves)) AS resolved_at
      FROM fleet_customer_orders o
     WHERE o.agent_id = p_agent
       AND EXISTS (SELECT 1 FROM fleet_customer_messages b WHERE b.order_id = o.order_id AND b.author = 'buyer' AND b.created_at > now() - interval '90 days')),
  order_open AS (
    SELECT x.order_id, min(b.created_at) AS since, max(b.created_at) AS last_buyer, count(*) AS messages
      FROM orders x JOIN fleet_customer_messages b ON b.order_id = x.order_id AND b.author = 'buyer'
     WHERE x.resolved_at IS NULL OR b.created_at > x.resolved_at
     GROUP BY x.order_id),
  order_ob AS (
    SELECT 'order' AS kind, oo.order_id::text AS id, oo.since, oo.last_buyer, oo.messages,
           (SELECT max(a.created_at) FROM fleet_customer_messages a WHERE a.order_id = oo.order_id AND a.author = 'agent' AND a.created_at > oo.since) AS replied,
           EXISTS (SELECT 1 FROM fleet_order_deliveries d WHERE d.order_id = oo.order_id AND d.status = 'queued' AND d.created_at > oo.since) AS delivering
      FROM order_open oo),
  enquiry_ob AS (
    SELECT 'enquiry' AS kind, b.enquiry_id::text AS id, min(b.created_at) AS since, max(b.created_at) AS last_buyer, count(*) AS messages,
           NULL::timestamptz AS replied, false AS delivering
      FROM fleet_customer_messages b
     WHERE b.agent_id = p_agent AND b.author = 'buyer' AND b.order_id IS NULL AND b.created_at > now() - interval '90 days'
       AND NOT EXISTS (SELECT 1 FROM fleet_customer_messages a WHERE a.enquiry_id = b.enquiry_id AND a.author = 'agent' AND a.created_at > b.created_at)
     GROUP BY b.enquiry_id),
  ob AS (SELECT * FROM order_ob UNION ALL SELECT * FROM enquiry_ob)
  SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('kind', kind, 'id', id,
           'state', CASE WHEN replied IS NULL OR replied < last_buyer THEN 'unanswered' ELSE 'acknowledged' END,
           'since', since, 'lastBuyerAt', last_buyer, 'buyerMessages', messages, 'repliedAt', replied,
           'delivering', CASE WHEN delivering THEN true END)) ORDER BY since), '[]'::jsonb)
    FROM (SELECT * FROM ob ORDER BY since LIMIT ${OBLIGATIONS_MAX}) y
$$;

${ATTENTION}

${ORDER_MESSAGE}

${MIND_REPORT}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
