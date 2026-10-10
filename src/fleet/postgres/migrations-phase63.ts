/**
 * Schema v63 — the owner keeps the fleet's stored mail tidy (owner decision 2026-10-11).
 *
 * The identity broker copies every message of the shared Proton mailbox into `fleet_agent_mail` (one-way: deleting in
 * Proton never removes the fleet's copy, and nothing here touches Proton). On first sync that is the mailbox's whole
 * history — PayPal notices, Proton and sign-up mail — most of it for no agent.
 *
 * 1. Dismiss / restore (`mail_dismiss`): hides messages from the owner's mail views; reversible; the agent's own view
 *    and routing are unchanged. Written as display state only — no event.
 * 2. Delete permanently (`mail_delete`): a hard delete of the fleet's copy, to free storage. An ordinary owner write
 *    (session + CSRF, confirmed in the page; no step-up — owner decision). A message is KEPT, with its reason, when
 *    `fleet_mail_keep_reason` says so: it delivered an order (an order delivery points at it), it is still being sent,
 *    or an agent may still need its verification code (unconsumed, under 24 h). Replies to a deleted message lose
 *    only their direct link (`in_reply_to`); their thread is unchanged. The encrypted verification blob goes with it.
 *    One permanent `mail_deleted` event records when, how many and how much — never the content.
 * 3. Automatic clearing, inside the hourly retention pass (`svc_event_retention`, which writes no event): dismissed
 *    mail and unassigned inbound mail after MAIL_RETENTION_DAYS, verification-code mail after MAIL_CODE_RETENTION_DAYS —
 *    with the same keep rules.
 * 4. `mail_summary` read: counts and stored size, so the owner can see what clearing frees.
 */
import { V41_SQL } from "./migrations-phase41.js";
import { V45_SQL } from "./migrations-phase45.js";
import { V62_SQL, DASHBOARD_WRITE_OPS_V62, DASHBOARD_READ_OPS_V62 } from "./migrations-phase62.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

/** Dismissed mail and unassigned inbound mail are cleared after this many days. */
export const MAIL_RETENTION_DAYS = 30;
/** Verification-code (authentication) mail is cleared after this many days; its code is useless by then. */
export const MAIL_CODE_RETENTION_DAYS = 7;
/** Messages per dismiss / delete request. */
export const MAIL_BATCH_MAX = 500;
/** Messages the hourly pass clears at most. */
export const MAIL_RETENTION_BATCH = 2000;

export const EVENT_ROUTES_V63 = Object.freeze({ P3_SUMMARY: ["mail_deleted"] });
export const DASHBOARD_READ_OPS_V63 = ["mail_summary"] as const;
export const DASHBOARD_WRITE_OPS_V63 = [...DASHBOARD_WRITE_OPS_V62, "mail_dismiss", "mail_delete"] as const;

const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;`;
const IDS_CHECK = `IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: choose at least one message'; END IF;
  IF cardinality(p_ids) > ${MAIL_BATCH_MAX} THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: at most ${MAIL_BATCH_MAX} messages at a time'; END IF;`;

const MAIL_FEED = restate(V41_SQL, "fleet_admin_mail_feed", [
  [`IF v_view NOT IN ('inbox','outbox','unassigned','security','thread','all') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: view is inbox|outbox|unassigned|security|thread|all'; END IF;`,
   `IF v_view NOT IN ('inbox','outbox','unassigned','security','thread','all','dismissed') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: view is inbox|outbox|unassigned|security|thread|all|dismissed'; END IF;`],
  [`'sendStatus', m.send_status,`, `'sendStatus', m.send_status, 'dismissedAt', m.dismissed_at, 'keepReason', fleet_mail_keep_reason(m.message_id),`],
  [`FROM (SELECT * FROM fleet_agent_mail mm WHERE
            CASE v_view WHEN 'inbox'`, `FROM (SELECT * FROM fleet_agent_mail mm WHERE (v_view IN ('thread','dismissed') OR mm.dismissed_at IS NULL) AND
            CASE v_view WHEN 'dismissed' THEN mm.dismissed_at IS NOT NULL
                        WHEN 'inbox'`],
]);

const RETENTION = restate(V45_SQL, "svc_event_retention", [
  [`DECLARE n integer; k integer;`, `DECLARE n integer; k integer; m jsonb;`],
  [`RETURN jsonb_build_object('eventsExpired', n, 'suppressionExpired', k);`,
   `-- v63: the fleet's stored mail (dismissed / unassigned / verification codes past their days; the keep rules apply).
  m := fleet_mail_retention();
  RETURN jsonb_build_object('eventsExpired', n, 'suppressionExpired', k, 'mailCleared', m -> 'deleted', 'mailFreedBytes', m -> 'freedBytes');`],
]);

const DASH_CALL = restate(V62_SQL, "dash_call", [
  [`OR p_op IN (${q(DASHBOARD_WRITE_OPS_V62)})`, `OR p_op IN (${q(DASHBOARD_WRITE_OPS_V63)})`],
  [`'customer_orders','paypal_disputes',${q(DASHBOARD_READ_OPS_V62)})) THEN`, `'customer_orders','paypal_disputes',${q(DASHBOARD_READ_OPS_V62)},${q(DASHBOARD_READ_OPS_V63)})) THEN`],
  [`      WHEN 'agent_thread' THEN fleet_admin_agent_thread(`, `      -- v63: the owner's mail housekeeping (ordinary writes, confirmed in the page)
      WHEN 'mail_summary' THEN fleet_admin_mail_summary()
      WHEN 'mail_dismiss' THEN fleet_admin_mail_dismiss(ARRAY(SELECT jsonb_array_elements_text(COALESCE(a -> 'messageIds', '[]'::jsonb)))::uuid[],
        COALESCE((a ->> 'dismiss')::boolean, true), 'operator:owner')
      WHEN 'mail_delete' THEN fleet_admin_mail_delete(ARRAY(SELECT jsonb_array_elements_text(COALESCE(a -> 'messageIds', '[]'::jsonb)))::uuid[], 'operator:owner')
      WHEN 'agent_thread' THEN fleet_admin_agent_thread(`],
]);

// fleet_event_route as v62 left it (P3_INFO already folded into P3_SUMMARY), plus the v63 event.
const EVENT_ROUTE = restate(V62_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V63) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);

const sizeOf = (t: string) => `octet_length(COALESCE(${t}.body, '')) + octet_length(COALESCE(${t}.subject, '')) + octet_length(COALESCE(${t}.sender, ''))`;

export const V63_SQL = `
-- ── 1. Dismissal (display state only) ──
ALTER TABLE fleet_agent_mail ADD COLUMN dismissed_at timestamptz, ADD COLUMN dismissed_by text CHECK (dismissed_by IS NULL OR length(dismissed_by) <= 80);
CREATE INDEX fleet_agent_mail_dismissed ON fleet_agent_mail (dismissed_at) WHERE dismissed_at IS NOT NULL;

-- Why a stored message must stay; NULL = it may be deleted.
CREATE FUNCTION fleet_mail_keep_reason(p_id uuid) RETURNS text LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM fleet_order_deliveries d WHERE d.message_id = m.message_id) THEN 'it delivered an order'
    WHEN m.direction = 'out' AND m.send_status = 'queued' THEN 'it is still being sent'
    WHEN m.withheld AND m.agent_id IS NOT NULL AND m.consumed_at IS NULL AND m.received_at > now() - interval '24 hours'
      THEN 'an agent may still need its verification code'
    ELSE NULL END
  FROM fleet_agent_mail m WHERE m.message_id = p_id
$$;

-- ── 2. The one place stored mail is deleted (owner request or the retention pass) ──
CREATE FUNCTION fleet_mail_delete_internal(p_ids uuid[]) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_del uuid[]; v_kept jsonb; v_bytes bigint; n integer;
BEGIN
  SELECT COALESCE(array_agg(m.message_id), '{}'::uuid[]) INTO v_del FROM fleet_agent_mail m
   WHERE m.message_id = ANY (p_ids) AND fleet_mail_keep_reason(m.message_id) IS NULL;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('messageId', m.message_id, 'reason', fleet_mail_keep_reason(m.message_id))), '[]'::jsonb) INTO v_kept
    FROM fleet_agent_mail m WHERE m.message_id = ANY (p_ids) AND fleet_mail_keep_reason(m.message_id) IS NOT NULL;
  SELECT COALESCE(sum(${sizeOf("m")}), 0) INTO v_bytes FROM fleet_agent_mail m WHERE m.message_id = ANY (v_del);
  -- A reply keeps its thread; only its direct link to a deleted message goes.
  UPDATE fleet_agent_mail SET in_reply_to = NULL WHERE in_reply_to = ANY (v_del) AND NOT (message_id = ANY (v_del));
  DELETE FROM fleet_auth_message_blobs WHERE kind = 'mail' AND message_id = ANY (v_del);
  DELETE FROM fleet_agent_mail WHERE message_id = ANY (v_del);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('deleted', n, 'freedBytes', v_bytes, 'kept', v_kept);
END $$;

-- ── 3. Owner operations ──
CREATE FUNCTION fleet_admin_mail_dismiss(p_ids uuid[], p_dismiss boolean, p_actor text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE n integer;
BEGIN
  ${OWNER_ACTOR}
  ${IDS_CHECK}
  UPDATE fleet_agent_mail SET dismissed_at = CASE WHEN p_dismiss THEN now() END, dismissed_by = CASE WHEN p_dismiss THEN p_actor END
   WHERE message_id = ANY (p_ids) AND (dismissed_at IS NULL) = COALESCE(p_dismiss, true);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, CASE WHEN COALESCE(p_dismiss, true) THEN 'dismissed' ELSE 'restored' END, n);
END $$;

CREATE FUNCTION fleet_admin_mail_delete(p_ids uuid[], p_actor text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v jsonb;
BEGIN
  ${OWNER_ACTOR}
  ${IDS_CHECK}
  v := fleet_mail_delete_internal(p_ids);
  IF (v ->> 'deleted')::integer > 0 THEN
    PERFORM fleet_event('mail_deleted', NULL, p_actor, jsonb_build_object('count', (v ->> 'deleted')::integer, 'freedBytes', (v ->> 'freedBytes')::bigint,
      'kept', jsonb_array_length(v -> 'kept')));
  END IF;
  RETURN jsonb_build_object('ok', true) || v;
END $$;

CREATE FUNCTION fleet_admin_mail_summary() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('total', count(*), 'storedBytes', COALESCE(sum(${sizeOf("m")}), 0),
    'received', count(*) FILTER (WHERE m.direction = 'in'), 'sent', count(*) FILTER (WHERE m.direction = 'out'),
    'sendFailed', count(*) FILTER (WHERE m.send_status = 'failed'),
    'unassigned', count(*) FILTER (WHERE m.agent_id IS NULL AND m.dismissed_at IS NULL),
    'dismissed', count(*) FILTER (WHERE m.dismissed_at IS NOT NULL), 'verificationCodes', count(*) FILTER (WHERE m.withheld),
    'retentionDays', ${MAIL_RETENTION_DAYS}, 'codeRetentionDays', ${MAIL_CODE_RETENTION_DAYS})
  FROM fleet_agent_mail m
$$;

-- ── 4. Automatic clearing (called by the hourly retention pass; writes no event) ──
CREATE FUNCTION fleet_mail_retention() RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_ids uuid[];
BEGIN
  SELECT COALESCE(array_agg(message_id), '{}'::uuid[]) INTO v_ids FROM (
    SELECT m.message_id FROM fleet_agent_mail m
     WHERE (m.dismissed_at < now() - interval '${MAIL_RETENTION_DAYS} days')
        OR (m.agent_id IS NULL AND m.direction = 'in' AND m.received_at < now() - interval '${MAIL_RETENTION_DAYS} days')
        OR (m.withheld AND m.received_at < now() - interval '${MAIL_CODE_RETENTION_DAYS} days')
     ORDER BY m.received_at LIMIT ${MAIL_RETENTION_BATCH}) x;
  IF cardinality(v_ids) = 0 THEN RETURN jsonb_build_object('deleted', 0, 'freedBytes', 0); END IF;
  RETURN fleet_mail_delete_internal(v_ids) - 'kept';
END $$;

${MAIL_FEED}

${RETENTION}

${DASH_CALL}

${EVENT_ROUTE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
