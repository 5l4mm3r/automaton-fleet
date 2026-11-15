/**
 * Schema v110 — order closure applies to the closed order's conversation, not to the buyer's address (owner, 2026-10-21:
 * "Closing one order should not prevent that customer from contacting Agent-1 about a new enquiry … Replies reliably
 * linked to the closed order stay closed and are preserved for owner review. A genuinely new enquiry from the same customer
 * must reach Agent-1 through normal enquiry routing. Ambiguous messages go to owner review without exposing another order or
 * reopening the refunded one").
 *
 * v109 re-routed ALL mail from a buyer whose orders with the agent were all closed to the owner — a returning customer could
 * never reach the agent again. fleet_mail_to_order now decides per message, in the transaction that stores it:
 *  1. LINKED — a reply in a thread that holds the agent's mail about an order (delivery, order message, confirmation): from
 *     the buyer's own address it joins that order if its conversation is open; if closed it is kept for the owner
 *     (unassigned, closed_order_mail P2), as v109. Anyone else replying in the thread: ordinary mail, as before.
 *  2. AMBIGUOUS — no reliable link, but it points at one of the sender's CLOSED orders with this agent: it quotes that
 *     order's page link or its reference (shown on the order page and in refund mail), or repeats the subject of the agent's
 *     mail about it (a reply whose headers were lost). Kept for the owner the same way, marked ambiguous; it never joins
 *     another (open) order of the buyer and never reopens the closed one.
 *  3. The buyer's only open order (v108).
 *  4. Otherwise a NEW ENQUIRY: the ordinary mail the agent received it as (subject or mailbox routing) — unchanged, nothing
 *     about the closed order attached.
 * The owner can still hand kept mail to the agent (fleet_admin_mail_assign).
 *
 * Also — Fleet Control's AI budget can be cleared again (owner, 2026-10-21: "an unset Fleet Control budget must be described
 * as a potential blocking dependency … Resolve the required authority and budget in the concrete proof package"): v96 let
 * the owner SET a positive daily budget but never unset it, so a budget set only for a bounded proof would stay. The owner
 * may now clear it (back to unset: no paid Fleet Control call; a triggered review waits, never approved).
 */

// The subject without reply/forward prefixes (fleet_mail_subject_agents, v97).
const BARE = (x: string) => `lower(regexp_replace(btrim(COALESCE(${x}, '')), '^((re|fwd?|aw|wg|sv|tr)([[][0-9]+[]])?[[:space:]]*:[[:space:]]*)+', '', 'i'))`;

export const V110_SQL = `
-- Mail that is not reliably in an order's thread but points at one of the sender's CLOSED orders with this agent.
CREATE FUNCTION fleet_mail_closed_order_hint(mm fleet_agent_mail) RETURNS uuid LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  WITH s AS (SELECT ${BARE("mm.subject")} AS bare, COALESCE(mm.subject, '') || E'\\n' || COALESCE(mm.body, '') AS txt)
  SELECT z.order_id FROM fleet_customer_orders z, s
   WHERE z.agent_id = mm.agent_id AND lower(z.buyer_email) = lower(mm.sender_address)
     AND NOT (fleet_order_conversation(z) ->> 'open')::boolean
     AND ((z.access_token IS NOT NULL AND strpos(s.txt, z.access_token) > 0)
          OR s.txt ~* ('(^|[^0-9a-z])' || left(replace(z.order_id::text, '-', ''), 8) || '([^0-9a-z]|$)')
          OR (s.bare <> '' AND EXISTS (SELECT 1 FROM fleet_agent_mail t
                WHERE t.agent_id = mm.agent_id AND t.direction = 'out' AND t.message_id <> mm.message_id AND ${BARE("t.subject")} = s.bare
                  AND (t.message_id = z.confirmation_message_id
                       OR EXISTS (SELECT 1 FROM fleet_order_deliveries d WHERE d.order_id = z.order_id AND d.message_id = t.message_id)
                       OR EXISTS (SELECT 1 FROM fleet_customer_messages c WHERE c.order_id = z.order_id AND c.mail_message_id = t.message_id)))))
   ORDER BY z.created_at DESC LIMIT 1
$$;

-- Keep a closed order's mail for the owner: never the agent's ordinary (waking) mail.
CREATE FUNCTION fleet_mail_keep_for_owner(mm fleet_agent_mail, o fleet_customer_orders, p_link text) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  UPDATE fleet_agent_mail SET agent_id = NULL, mailbox_id = NULL, venture_id = NULL, account_id = NULL, routing = 'unassigned',
         routing_reason = left(CASE p_link WHEN 'thread'
           THEN 'a buyer''s message about a closed order (' || (fleet_order_conversation(o) ->> 'reason') || '): kept for the owner''s review, not agent work'
           ELSE 'a buyer''s message that may be about a closed order (' || (fleet_order_conversation(o) ->> 'reason') || '; no reply headers link it): kept for the owner''s review, not agent work' END, 300)
   WHERE message_id = mm.message_id;
  PERFORM fleet_event('closed_order_mail', NULL, 'controller', jsonb_build_object('messageId', mm.message_id, 'orderId', o.order_id, 'agentId', o.agent_id,
    'reason', fleet_order_conversation(o) ->> 'reason', 'link', p_link,
    'note', CASE p_link WHEN 'thread' THEN 'a buyer replied about a closed order' ELSE 'a buyer''s mail may be about a closed order (no reply headers)' END
            || ': the mail is with you (Mail, unassigned); hand it to the agent only if it needs work'));
END $$;

CREATE OR REPLACE FUNCTION fleet_mail_to_order(p_mail uuid) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE mm fleet_agent_mail; v_order uuid; v_closed uuid; o fleet_customer_orders; v_body text; m fleet_customer_messages;
BEGIN
  SELECT * INTO mm FROM fleet_agent_mail WHERE message_id = p_mail;
  IF mm.message_id IS NULL OR mm.direction <> 'in' OR mm.agent_id IS NULL OR mm.withheld OR mm.sender_address IS NULL THEN RETURN; END IF;
  -- 1. Linked: the order of the conversation this mail continues (an order message, delivery or confirmation in the thread).
  IF mm.routing = 'thread' THEN
    SELECT x.order_id INTO v_order FROM fleet_agent_mail t,
      LATERAL (SELECT c.order_id FROM fleet_customer_messages c WHERE c.mail_message_id = t.message_id AND c.order_id IS NOT NULL
               UNION ALL SELECT d.order_id FROM fleet_order_deliveries d WHERE d.message_id = t.message_id
               UNION ALL SELECT z.order_id FROM fleet_customer_orders z WHERE z.confirmation_message_id = t.message_id) x
     WHERE t.thread_id = mm.thread_id AND t.message_id <> mm.message_id AND t.agent_id = mm.agent_id LIMIT 1;
  END IF;
  IF v_order IS NOT NULL THEN
    SELECT * INTO o FROM fleet_customer_orders WHERE order_id = v_order;
    IF lower(COALESCE(o.buyer_email, '')) <> lower(mm.sender_address) OR o.agent_id <> mm.agent_id THEN RETURN; END IF;   -- only the buyer's own address
    IF NOT (fleet_order_conversation(o) ->> 'open')::boolean THEN PERFORM fleet_mail_keep_for_owner(mm, o, 'thread'); RETURN; END IF;
  ELSE
    -- 2. Ambiguous: no reliable link, but it points at one of the sender's closed orders — the owner's, never another order's.
    v_closed := fleet_mail_closed_order_hint(mm);
    IF v_closed IS NOT NULL THEN
      SELECT * INTO o FROM fleet_customer_orders WHERE order_id = v_closed;
      PERFORM fleet_mail_keep_for_owner(mm, o, 'ambiguous'); RETURN;
    END IF;
    -- 3. The agent's only open order from this buyer address.
    SELECT CASE WHEN count(*) = 1 THEN (array_agg(z.order_id))[1] END INTO v_order FROM fleet_customer_orders z
     WHERE z.agent_id = mm.agent_id AND lower(z.buyer_email) = lower(mm.sender_address) AND z.payment_status IN ('paid','partially_refunded')
       AND (fleet_order_conversation(z) ->> 'open')::boolean;
    -- 4. Otherwise a new enquiry: the agent's ordinary mail, unchanged.
    IF v_order IS NULL THEN RETURN; END IF;
    SELECT * INTO o FROM fleet_customer_orders WHERE order_id = v_order;
  END IF;
  IF (SELECT count(*) FROM fleet_customer_messages WHERE author = 'buyer' AND order_id = o.order_id AND created_at > now() - interval '1 day') >= 20 THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM fleet_customer_messages WHERE mail_message_id = mm.message_id) THEN RETURN; END IF;
  v_body := left(fleet_mail_reply_text(mm.body), 8000);
  IF length(btrim(COALESCE(v_body, ''))) < 1 THEN RETURN; END IF;
  INSERT INTO fleet_customer_messages (agent_id, order_id, author, body, mail_message_id) VALUES (o.agent_id, o.order_id, 'buyer', v_body, mm.message_id) RETURNING * INTO m;
  PERFORM fleet_event('customer_message_received', o.agent_id, 'buyer', jsonb_build_object('orderId', o.order_id, 'messageId', m.message_id, 'via', 'email'));
END $$;

-- The owner clears Fleet Control's daily AI budget (unset = no paid Fleet Control call). Reservations already made settle as usual.
CREATE FUNCTION fleet_admin_fleet_control_ai_budget_clear(p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a reason is required'; END IF;
  UPDATE fleet_control_ai_budget SET daily_ceiling_minor = NULL, set_by = p_actor, reason = left('cleared: ' || fleet_scrub(trim(p_reason)), 300), set_at = now() WHERE id = 1;
  PERFORM fleet_event('fleet_control_ai_budget_set', NULL, p_actor, jsonb_build_object('dailyMinor', NULL, 'cleared', true));
  RETURN jsonb_build_object('ok', true) || fleet_control_ai_state();
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
