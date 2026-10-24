/**
 * Schema v114 — acknowledging a conversation and fulfilling a correction are separate (owner, 2026-10-24).
 *
 * Until v113 an agent message sent with resolved: true ended a buyer's request after delivery: `revisionOwed` disappeared and
 * the conversation closed 7 days later, with no new file. resolved: true now only ACKNOWLEDGES the conversation (no reply
 * is owed; the state is "acknowledged"). A buyer's request made after the order's latest effective delivery (v113) stays
 * owed work until one of:
 *   - verified fulfilment: a later effective delivery (v113: different files whose review passed required_content);
 *   - the order's end: refunded, reversed or cancelled;
 *   - a genuine buyer withdrawal: the buyer's own message, recorded as a withdrawal by the OWNER
 *     (fleet_admin_order_correction_withdrawn, an operator actor). An agent cannot record one; no agent-quoted text counts.
 * A buyer message after a recorded withdrawal is a new request. While a correction is owed, the order conversation does
 * not close as "resolved". Nothing is deleted or rewritten; the functions are restated (v113's text, v108's closure).
 */
import { restate as restateRaw } from "./migrations-phase42.js";
import { V113_SQL } from "./migrations-phase113.js";
import { V108_SQL, ORDER_CONVERSATION_DAYS } from "./migrations-phase108.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));

// A correction acknowledged with resolved: true leaves order_open (its conversation was resolved); it is still owed work.
const PAID_OB_END = `       AND NOT EXISTS (SELECT 1 FROM order_ob x WHERE x.id = o.order_id::text)),`;
const CORRECTION_OB = `${PAID_OB_END}
  correction_ob AS (
    SELECT 'order' AS kind, o.order_id::text AS id, fleet_order_correction_since(o.order_id) AS since,
           (SELECT max(b.created_at) FROM fleet_customer_messages b WHERE b.order_id = o.order_id AND b.author = 'buyer') AS last_buyer,
           (SELECT count(*) FROM fleet_customer_messages b WHERE b.order_id = o.order_id AND b.author = 'buyer'
              AND b.created_at >= fleet_order_correction_since(o.order_id)) AS messages,
           (SELECT max(a.created_at) FROM fleet_customer_messages a WHERE a.order_id = o.order_id AND a.author = 'agent') AS replied,
           EXISTS (SELECT 1 FROM fleet_order_deliveries d WHERE d.order_id = o.order_id AND d.status = 'queued'
                    AND d.created_at > fleet_order_correction_since(o.order_id)) AS delivering
      FROM fleet_customer_orders o
     WHERE o.agent_id = p_agent AND fleet_order_revision_owed(o.order_id)
       AND NOT EXISTS (SELECT 1 FROM order_ob x WHERE x.id = o.order_id::text)
       AND NOT EXISTS (SELECT 1 FROM paid_ob x WHERE x.id = o.order_id::text)),`;
const UNION_OLD = `FROM (SELECT * FROM order_ob UNION ALL SELECT * FROM enquiry_ob UNION ALL SELECT * FROM paid_ob) u`;
const UNION_NEW = `FROM (SELECT * FROM order_ob UNION ALL SELECT * FROM enquiry_ob UNION ALL SELECT * FROM paid_ob UNION ALL SELECT * FROM correction_ob) u`;
const REVISION_OLD = `COALESCE(u.kind = 'order' AND o.order_id IS NULL AND u.messages > 0 AND u.last_buyer > fleet_order_effective_delivery_at(u.id::uuid), false) AS revision_owed`;
const REVISION_NEW = `COALESCE(u.kind = 'order' AND o.order_id IS NULL AND fleet_order_revision_owed(u.id::uuid), false) AS revision_owed`;
const EDITS: Array<[string, string]> = [[PAID_OB_END, CORRECTION_OB], [UNION_OLD, UNION_NEW], [REVISION_OLD, REVISION_NEW]];
const OBLIGATIONS = restate(V113_SQL, "fleet_customer_obligations", EDITS);
const OBLIGATIONS_ALL = restate(V113_SQL, "fleet_customer_obligations_all", EDITS);
const CONVERSATION = restate(V108_SQL, "fleet_order_conversation", [[
  `WHEN r.at IS NOT NULL AND (b.last IS NULL OR b.last <= r.at) AND r.at < now() - interval '${ORDER_CONVERSATION_DAYS} days' THEN 'resolved'`,
  `WHEN r.at IS NOT NULL AND (b.last IS NULL OR b.last <= r.at) AND r.at < now() - interval '${ORDER_CONVERSATION_DAYS} days'
                     AND NOT fleet_order_revision_owed(o.order_id) THEN 'resolved'`]]);

export const V114_SQL = String.raw`
-- A buyer's withdrawal of a requested correction: the buyer's own message, recorded by the owner. Never by an agent.
CREATE TABLE fleet_order_correction_withdrawals (
  withdrawal_id     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          uuid        NOT NULL REFERENCES fleet_customer_orders(order_id),
  buyer_message_id  uuid        NOT NULL UNIQUE REFERENCES fleet_customer_messages(message_id),
  reason            text        NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  recorded_by       text        NOT NULL CHECK (recorded_by ~ '^operator:[A-Za-z0-9._-]{1,64}$'),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_order_correction_withdrawals_order ON fleet_order_correction_withdrawals (order_id);
CREATE TRIGGER fleet_order_correction_withdrawals_no_change BEFORE UPDATE OR DELETE ON fleet_order_correction_withdrawals
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- After when a buyer message is an owed correction: the latest effective delivery, or a later recorded withdrawal's message.
CREATE FUNCTION fleet_order_correction_floor(p_order uuid) RETURNS timestamptz LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT GREATEST(fleet_order_effective_delivery_at(p_order),
                  (SELECT max(m.created_at) FROM fleet_order_correction_withdrawals w JOIN fleet_customer_messages m ON m.message_id = w.buyer_message_id
                    WHERE w.order_id = p_order))
$$;

-- v114: a correction is owed while the order is live, has an effective delivery, and a buyer message came after the floor.
-- resolved: true is NOT part of this rule (it acknowledges the conversation only).
CREATE OR REPLACE FUNCTION fleet_order_revision_owed(p_order uuid) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE((SELECT o.payment_status NOT IN ('refunded','reversed','cancelled') AND o.status <> 'cancelled'
                     FROM fleet_customer_orders o WHERE o.order_id = p_order), false)
     AND fleet_order_effective_delivery_at(p_order) IS NOT NULL
     AND EXISTS (SELECT 1 FROM fleet_customer_messages b WHERE b.order_id = p_order AND b.author = 'buyer'
                  AND b.created_at > fleet_order_correction_floor(p_order))
$$;

-- When the owed correction was first asked for (the earliest buyer message after the floor), or null.
CREATE FUNCTION fleet_order_correction_since(p_order uuid) RETURNS timestamptz LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT min(b.created_at) FROM fleet_customer_messages b
   WHERE b.order_id = p_order AND b.author = 'buyer' AND b.created_at > fleet_order_correction_floor(p_order)
$$;

-- The owner records a buyer's genuine withdrawal: the buyer's own message on that order, written after the request began.
CREATE FUNCTION fleet_admin_order_correction_withdrawn(p_order uuid, p_buyer_message uuid, p_reason text, p_actor text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE m fleet_customer_messages; v_agent text;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a reason is required'; END IF;
  SELECT agent_id INTO v_agent FROM fleet_customer_orders WHERE order_id = p_order FOR UPDATE;
  IF v_agent IS NULL THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: order'; END IF;
  IF NOT fleet_order_revision_owed(p_order) THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: no correction is owed on this order'; END IF;
  SELECT * INTO m FROM fleet_customer_messages WHERE message_id = p_buyer_message;
  IF NOT FOUND OR m.order_id IS DISTINCT FROM p_order OR m.author <> 'buyer' OR m.created_at < fleet_order_correction_since(p_order) THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: the withdrawal is the buyer''s own message on this order, written since the owed request began';
  END IF;
  INSERT INTO fleet_order_correction_withdrawals (order_id, buyer_message_id, reason, recorded_by) VALUES (p_order, m.message_id, left(trim(p_reason), 300), p_actor);
  PERFORM fleet_event('order_correction_withdrawn', v_agent, p_actor, jsonb_build_object('orderId', p_order, 'buyerMessageId', m.message_id,
    'buyerMessageAt', m.created_at, 'reason', left(trim(p_reason), 300)));
  RETURN jsonb_build_object('ok', true, 'orderId', p_order, 'revisionOwed', fleet_order_revision_owed(p_order));
END $$;

${OBLIGATIONS}

${OBLIGATIONS_ALL}

${CONVERSATION}

REVOKE ALL ON FUNCTION fleet_order_correction_floor(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION fleet_order_correction_since(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION fleet_order_revision_owed(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION fleet_admin_order_correction_withdrawn(uuid, uuid, text, text) FROM PUBLIC;
`;
