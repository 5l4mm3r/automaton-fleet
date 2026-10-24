/**
 * Schema v115 — customer messages after delivery: conversation versus established correction (owner-approved design,
 * docs/design/customer-message-handling.md, with the owner's refinements of 2026-10-24).
 *
 * Replaces v114's temporary rule ("every post-delivery buyer message is owed correction work"):
 *  - A buyer message written after the order's first sent delivery is UNCLASSIFIED until the agent classifies it
 *    (order.classify): "conversation" (a question, acknowledgement or thanks), "correction" (an established change with
 *    acceptance criteria that describe the requested OUTCOME — additions, removals, layout, calculations, other) or
 *    "unclear" (the agent asks the buyer a clarifying question). The source message, decision and reason are recorded,
 *    immutable.
 *  - A "conversation" classification is checked ONCE by Fleet Control (fleet_message_checks, one row per message and
 *    purpose — never a repeated paid review of an unchanged message), within Fleet Control's existing daily AI ceiling.
 *    The verdict is EVIDENCE with its confidence, not certainty: "no_change" at confidence ≥ 0.7 completes the
 *    conversation; "change_requested", "uncertain" or a low confidence returns the message to the agent (classify it as a
 *    correction, or as unclear and ask). While the check is pending — including when Fleet Control's budget has no room or
 *    the provider fails — the message is checkpointed and deferred: not agent work, nothing asked of the buyer. Bounded:
 *    at most 3 failed attempts (5 min, 30 min backoff), then "stalled" with one owner-visible event; a budget refusal
 *    defers 15 minutes and is not an attempt.
 *  - An established correction is owed until (a) a later delivery of changed files whose passing review records every
 *    criterion's outcome as met (visible-phrase checks, where the agent declared them, must also pass — one verification
 *    method among others); (b) the order is refunded, reversed or cancelled; (c) a buyer withdrawal confirmed by Fleet
 *    Control (verdict "withdrawn", confidence ≥ 0.8) on a buyer message written after the correction; or (d) the owner's
 *    recorded withdrawal (v114). resolved: true never closes it.
 *  - Fleet Control's check is fleet overhead paid by the treasury (message_check_charge: the same ledger legs as a
 *    knowledge review, copied from it), never the agent.
 */
import { restate as restateRaw } from "./migrations-phase42.js";
import { V114_SQL } from "./migrations-phase114.js";
import { V111_SQL } from "./migrations-phase111.js";
import { V96_SQL } from "./migrations-phase96.js";
import { V91_SQL } from "./migrations-phase91.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));

export const NO_CHANGE_CONFIDENCE = 0.7;
export const WITHDRAWN_CONFIDENCE = 0.8;
export const MESSAGE_CHECK_MAX_ATTEMPTS = 3;

// The obligation rows carry the agent's message work for an order (what to classify, which corrections are open).
const WORK_OLD = `'revisionOwed', CASE WHEN revision_owed THEN true END,`;
const WORK_NEW = `'revisionOwed', CASE WHEN revision_owed THEN true END,
           'work', CASE WHEN kind = 'order' AND revision_owed THEN fleet_order_message_work(id::uuid) END,`;
const OBLIGATIONS = restate(V114_SQL, "fleet_customer_obligations", [[WORK_OLD, WORK_NEW]]);
const OBLIGATIONS_ALL = restate(V114_SQL, "fleet_customer_obligations_all", [[WORK_OLD, WORK_NEW]]);
const DISPATCH = restate(V111_SQL, "api_economy", [
  [`WHEN 'order.message' THEN 'planning'`, `WHEN 'order.message' THEN 'planning' WHEN 'order.classify' THEN 'planning' WHEN 'order.withdraw_correction' THEN 'planning'`],
  [`      WHEN 'order.message' THEN fleet_econ_order_message(p_agent, a)`, `      WHEN 'order.message' THEN fleet_econ_order_message(p_agent, a)
      WHEN 'order.classify' THEN fleet_econ_order_classify(p_agent, a)
      WHEN 'order.withdraw_correction' THEN fleet_econ_order_withdraw_correction(p_agent, a)`],
]);
const RESERVE = restate(V96_SQL, "svc_fleet_control_ai_reserve", [
  [`p_kind NOT IN ('spend_review','knowledge_review','evidence_relevance')`, `p_kind NOT IN ('spend_review','knowledge_review','evidence_relevance','message_check')`]]);
const BACKING = restate(V91_SQL, "fleet_capital_backing", [
  [`'knowledge_review_charge','ai_credit_owner_payable_opening'`, `'knowledge_review_charge','message_check_charge','ai_credit_owner_payable_opening'`]]);

export const V115_SQL = String.raw`
-- ═══ 1. Records: the agent's decisions, established corrections, closures, Fleet Control's checks ═══
CREATE TABLE fleet_customer_message_decisions (
  decision_id     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        text        NOT NULL REFERENCES fleet_agents(agent_id),
  order_id        uuid        NOT NULL REFERENCES fleet_customer_orders(order_id),
  message_id      uuid        NOT NULL REFERENCES fleet_customer_messages(message_id),
  classification  text        NOT NULL CHECK (classification IN ('conversation','correction','unclear')),
  reason          text        NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, classification)
);
CREATE INDEX fleet_customer_message_decisions_order ON fleet_customer_message_decisions (order_id, created_at);
CREATE TRIGGER fleet_customer_message_decisions_no_change BEFORE UPDATE OR DELETE ON fleet_customer_message_decisions
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_order_corrections (
  correction_id      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id           text        NOT NULL REFERENCES fleet_agents(agent_id),
  order_id           uuid        NOT NULL REFERENCES fleet_customer_orders(order_id),
  source_message_id  uuid        NOT NULL UNIQUE REFERENCES fleet_customer_messages(message_id),
  criteria           jsonb       NOT NULL CHECK (jsonb_typeof(criteria) = 'array' AND jsonb_array_length(criteria) BETWEEN 1 AND 10 AND length(criteria::text) <= 8000),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_order_corrections_order ON fleet_order_corrections (order_id, created_at);
CREATE TRIGGER fleet_order_corrections_no_change BEFORE UPDATE OR DELETE ON fleet_order_corrections
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_message_checks (
  check_id        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        text        NOT NULL REFERENCES fleet_agents(agent_id),
  order_id        uuid        NOT NULL REFERENCES fleet_customer_orders(order_id),
  message_id      uuid        NOT NULL REFERENCES fleet_customer_messages(message_id),
  purpose         text        NOT NULL CHECK (purpose IN ('conversation','withdrawal')),
  correction_id   uuid        REFERENCES fleet_order_corrections(correction_id),
  status          text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','decided','stalled')),
  attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND ${MESSAGE_CHECK_MAX_ATTEMPTS}),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_by      text,
  claimed_until   timestamptz,
  verdict         text        CHECK (verdict IN ('no_change','change_requested','withdrawn','not_withdrawn','uncertain')),
  confidence      numeric(3,2) CHECK (confidence BETWEEN 0 AND 1),
  evidence        text        CHECK (length(evidence) <= 600),
  last_error      text        CHECK (length(last_error) <= 300),
  calls           jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(calls) = 'array'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz,
  UNIQUE (message_id, purpose),                                   -- one paid check per message and purpose, ever
  CHECK ((status = 'decided') = (verdict IS NOT NULL AND confidence IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK ((purpose = 'withdrawal') = (correction_id IS NOT NULL))
);
CREATE INDEX fleet_message_checks_due ON fleet_message_checks (next_attempt_at) WHERE status = 'pending';
CREATE TRIGGER fleet_message_checks_no_delete BEFORE DELETE ON fleet_message_checks FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- ═══ 2. The rules ═══
CREATE FUNCTION fleet_order_live(p_order uuid) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE((SELECT o.payment_status NOT IN ('refunded','reversed','cancelled') AND o.status <> 'cancelled' FROM fleet_customer_orders o WHERE o.order_id = p_order), false)
$$;

CREATE FUNCTION fleet_order_first_delivery_at(p_order uuid) RETURNS timestamptz LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT min(created_at) FROM fleet_order_deliveries WHERE order_id = p_order AND status = 'sent'
$$;

-- The owner's recorded withdrawal (v114) settles everything the buyer wrote up to the cited message.
CREATE FUNCTION fleet_order_owner_withdrawn_at(p_order uuid) RETURNS timestamptz LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT max(m.created_at) FROM fleet_order_correction_withdrawals w JOIN fleet_customer_messages m ON m.message_id = w.buyer_message_id WHERE w.order_id = p_order
$$;

-- A correction is fulfilled by a later sent delivery of CHANGED files whose passing review records every criterion's outcome
-- as met; where the agent declared visible phrases (mustShow), the inspector's required_content check must have passed too.
CREATE FUNCTION fleet_order_correction_fulfilled(c fleet_order_corrections) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM fleet_order_deliveries d JOIN fleet_artifact_reviews r ON r.review_id = d.review_id
     WHERE d.order_id = c.order_id AND d.status = 'sent' AND d.created_at > c.created_at
       AND r.verdict = 'pass' AND r.automated_ok
       AND fleet_order_delivery_digest(d.delivery_id) IS DISTINCT FROM
             (SELECT fleet_order_delivery_digest(e.delivery_id) FROM fleet_order_deliveries e
               WHERE e.order_id = c.order_id AND e.status = 'sent' AND e.created_at < d.created_at ORDER BY e.created_at DESC LIMIT 1)
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(c.criteria) k
                        WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.criteria) = 'array' THEN r.criteria ELSE '[]'::jsonb END) x
                                           WHERE x ->> 'criterion' = k ->> 'outcome' AND x ->> 'met' = 'true'))
       AND (NOT EXISTS (SELECT 1 FROM jsonb_array_elements(c.criteria) k WHERE jsonb_array_length(COALESCE(k -> 'mustShow', '[]'::jsonb)) > 0)
            OR jsonb_path_exists(r.automated, '$.files[*].checks[*] ? (@.id == "required_content" && @.status == "pass")')))
$$;

CREATE FUNCTION fleet_order_correction_open(c fleet_order_corrections) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT fleet_order_live(c.order_id)
     AND NOT EXISTS (SELECT 1 FROM fleet_message_checks k WHERE k.correction_id = c.correction_id AND k.purpose = 'withdrawal'
                      AND k.status = 'decided' AND k.verdict = 'withdrawn' AND k.confidence >= ${WITHDRAWN_CONFIDENCE})
     AND NOT (SELECT m.created_at FROM fleet_customer_messages m WHERE m.message_id = c.source_message_id) <= COALESCE(fleet_order_owner_withdrawn_at(c.order_id), '-infinity'::timestamptz)
     AND NOT fleet_order_correction_fulfilled(c)
$$;

-- Each buyer message after the first delivery: unclassified, done (conversation checked, unclear answered, correction
-- recorded), review_pending (deferred) or disputed (Fleet Control did not confirm "conversation": back to the agent).
CREATE FUNCTION fleet_order_message_state(p_message uuid) RETURNS text LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  WITH d AS (SELECT classification FROM fleet_customer_message_decisions WHERE message_id = p_message ORDER BY created_at DESC, classification LIMIT 1),
       k AS (SELECT * FROM fleet_message_checks WHERE message_id = p_message AND purpose = 'conversation')
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM d) THEN 'unclassified'
    WHEN (SELECT classification FROM d) IN ('correction','unclear') THEN 'done'
    WHEN NOT EXISTS (SELECT 1 FROM k) OR (SELECT status FROM k) <> 'decided' THEN 'review_pending'
    WHEN (SELECT verdict FROM k) = 'no_change' AND (SELECT confidence FROM k) >= ${NO_CHANGE_CONFIDENCE} THEN 'done'
    ELSE 'disputed' END
$$;

-- The agent's message work on an order (null when there is none).
CREATE FUNCTION fleet_order_message_work(p_order uuid) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  WITH msgs AS (
    SELECT b.message_id, b.created_at, fleet_order_message_state(b.message_id) AS st FROM fleet_customer_messages b
     WHERE b.order_id = p_order AND b.author = 'buyer' AND b.created_at > fleet_order_first_delivery_at(p_order)
       AND b.created_at > COALESCE(fleet_order_owner_withdrawn_at(p_order), '-infinity'::timestamptz)),
  corr AS (SELECT c.* FROM fleet_order_corrections c WHERE c.order_id = p_order AND fleet_order_correction_open(c))
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'classify', (SELECT jsonb_agg(message_id ORDER BY created_at) FROM (SELECT * FROM msgs WHERE st IN ('unclassified','disputed') ORDER BY created_at LIMIT 10) x),
    'disputed', (SELECT jsonb_agg(message_id ORDER BY created_at) FROM msgs WHERE st = 'disputed'),
    'reviewPending', (SELECT NULLIF(count(*), 0) FROM msgs WHERE st = 'review_pending'),
    'corrections', (SELECT jsonb_agg(jsonb_build_object('correctionId', correction_id, 'sourceMessageId', source_message_id, 'criteria', criteria) ORDER BY created_at)
                      FROM (SELECT * FROM corr ORDER BY created_at LIMIT 5) y)))
   WHERE fleet_order_live(p_order)
$$;

-- v115: owed = an open correction, or a post-delivery message the agent must (re)classify. Review-pending messages are
-- deferred, not owed. (The name is v113's: order.thread, the obligations and v114's closure rule read it.)
CREATE OR REPLACE FUNCTION fleet_order_revision_owed(p_order uuid) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT fleet_order_live(p_order) AND (
    EXISTS (SELECT 1 FROM fleet_order_corrections c WHERE c.order_id = p_order AND fleet_order_correction_open(c))
    OR EXISTS (SELECT 1 FROM fleet_customer_messages b WHERE b.order_id = p_order AND b.author = 'buyer'
                AND b.created_at > fleet_order_first_delivery_at(p_order)
                AND b.created_at > COALESCE(fleet_order_owner_withdrawn_at(p_order), '-infinity'::timestamptz)
                AND fleet_order_message_state(b.message_id) IN ('unclassified','disputed')))
$$;

-- When the owed work began (the earliest such message or open correction).
CREATE OR REPLACE FUNCTION fleet_order_correction_since(p_order uuid) RETURNS timestamptz LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT LEAST(
    (SELECT min(m.created_at) FROM fleet_order_corrections c JOIN fleet_customer_messages m ON m.message_id = c.source_message_id
      WHERE c.order_id = p_order AND fleet_order_correction_open(c)),
    (SELECT min(b.created_at) FROM fleet_customer_messages b WHERE b.order_id = p_order AND b.author = 'buyer'
      AND b.created_at > fleet_order_first_delivery_at(p_order)
      AND b.created_at > COALESCE(fleet_order_owner_withdrawn_at(p_order), '-infinity'::timestamptz)
      AND fleet_order_message_state(b.message_id) IN ('unclassified','disputed')))
$$;

${OBLIGATIONS}

${OBLIGATIONS_ALL}

-- ═══ 3. The agent's operations ═══
-- order.classify {orderId, messageId, classification, reason, criteria?}
CREATE FUNCTION fleet_econ_order_classify(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_customer_orders; m fleet_customer_messages; v_cls text := a ->> 'classification'; v_reason text := btrim(COALESCE(a ->> 'reason', ''));
        v_crit jsonb := a -> 'criteria'; k jsonb; v_latest text; v_corr uuid; v_check text;
BEGIN
  SELECT * INTO o FROM fleet_customer_orders WHERE order_id = fleet_identity_uuid(a, 'orderId') AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: orderId — one of your orders'; END IF;
  SELECT * INTO m FROM fleet_customer_messages WHERE message_id = fleet_identity_uuid(a, 'messageId') AND order_id = o.order_id AND author = 'buyer';
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: messageId — a buyer message on this order (order_thread lists them)'; END IF;
  IF fleet_order_first_delivery_at(o.order_id) IS NULL OR m.created_at <= fleet_order_first_delivery_at(o.order_id) THEN
    RAISE EXCEPTION 'FLEET_INVALID_STATE: only a buyer message written after the first delivery is classified; answer earlier messages with order_message';
  END IF;
  IF v_cls IS NULL OR v_cls NOT IN ('conversation','correction','unclear') THEN PERFORM fleet_econ_bad('classification is conversation, correction or unclear'); END IF;
  IF length(v_reason) NOT BETWEEN 3 AND 300 THEN PERFORM fleet_econ_bad('reason: 3..300 characters — why this classification'); END IF;
  SELECT classification INTO v_latest FROM fleet_customer_message_decisions WHERE message_id = m.message_id ORDER BY created_at DESC, classification LIMIT 1;
  -- An established correction stands; a message goes from conversation or unclear only to a stricter reading, never back.
  IF v_latest = 'correction' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: this message is an established correction; deliver it (or the buyer withdraws it)'; END IF;
  IF v_latest = v_cls OR (v_latest = 'unclear' AND v_cls = 'conversation') OR (v_latest = 'conversation' AND v_cls = 'conversation') THEN
    RAISE EXCEPTION 'FLEET_ORDER_ALREADY_CLASSIFIED: this message is already classified %', v_latest;
  END IF;
  IF v_cls = 'correction' THEN
    IF jsonb_typeof(v_crit) <> 'array' OR jsonb_array_length(v_crit) NOT BETWEEN 1 AND 10 THEN
      PERFORM fleet_econ_bad('criteria: 1..10 {outcome (the requested result, 5..300), kind (add|remove|change|layout|calculation|other), mustShow? (up to 5 phrases that must be visible)}');
    END IF;
    FOR k IN SELECT * FROM jsonb_array_elements(v_crit) LOOP
      IF length(COALESCE(k ->> 'outcome', '')) NOT BETWEEN 5 AND 300 OR COALESCE(k ->> 'kind', '') NOT IN ('add','remove','change','layout','calculation','other')
         OR (k ? 'mustShow' AND (jsonb_typeof(k -> 'mustShow') <> 'array' OR jsonb_array_length(k -> 'mustShow') > 5
             OR EXISTS (SELECT 1 FROM jsonb_array_elements(k -> 'mustShow') p WHERE jsonb_typeof(p) <> 'string' OR length(p #>> '{}') NOT BETWEEN 2 AND 120))) THEN
        PERFORM fleet_econ_bad('each criterion: outcome (5..300), kind (add|remove|change|layout|calculation|other), mustShow optional (strings, 2..120, at most 5)');
      END IF;
    END LOOP;
    IF (SELECT count(DISTINCT x ->> 'outcome') FROM jsonb_array_elements(v_crit) x) <> jsonb_array_length(v_crit) THEN PERFORM fleet_econ_bad('each outcome once'); END IF;
  ELSIF v_crit IS NOT NULL THEN
    PERFORM fleet_econ_bad('criteria belong to a correction only');
  END IF;
  INSERT INTO fleet_customer_message_decisions (agent_id, order_id, message_id, classification, reason) VALUES (p_agent, o.order_id, m.message_id, v_cls, left(v_reason, 300));
  IF v_cls = 'correction' THEN
    INSERT INTO fleet_order_corrections (agent_id, order_id, source_message_id, criteria)
      VALUES (p_agent, o.order_id, m.message_id, (SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('outcome', x ->> 'outcome', 'kind', x ->> 'kind', 'mustShow', x -> 'mustShow'))) FROM jsonb_array_elements(v_crit) x))
      RETURNING correction_id INTO v_corr;
  ELSIF v_cls = 'conversation' THEN
    INSERT INTO fleet_message_checks (agent_id, order_id, message_id, purpose) VALUES (p_agent, o.order_id, m.message_id, 'conversation')
      ON CONFLICT (message_id, purpose) DO NOTHING;
    v_check := 'Fleet Control checks this classification once; until then the message waits (nothing more to do for it, and nothing to ask the buyer)';
  END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object('ok', true, 'classification', v_cls, 'correctionId', v_corr, 'note', COALESCE(v_check,
    CASE v_cls WHEN 'correction' THEN 'an established correction: it stays owed until changed files whose review records each outcome as met are delivered (resolved: true does not close it)'
               ELSE 'ask the buyer your clarifying question with order_message; their reply is a new message' END),
    'revisionOwed', fleet_order_revision_owed(o.order_id)));
END $$;

-- order.withdraw_correction {orderId, correctionId, messageId, reason}: the buyer's later message withdraws it — Fleet Control confirms.
CREATE FUNCTION fleet_econ_order_withdraw_correction(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_order_corrections; m fleet_customer_messages; v_reason text := btrim(COALESCE(a ->> 'reason', ''));
BEGIN
  SELECT * INTO c FROM fleet_order_corrections WHERE correction_id = fleet_identity_uuid(a, 'correctionId') AND agent_id = p_agent
     AND order_id = fleet_identity_uuid(a, 'orderId');
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: correctionId — an open correction on this order of yours'; END IF;
  IF NOT fleet_order_correction_open(c) THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: this correction is no longer open'; END IF;
  SELECT * INTO m FROM fleet_customer_messages WHERE message_id = fleet_identity_uuid(a, 'messageId') AND order_id = c.order_id AND author = 'buyer'
     AND created_at > (SELECT created_at FROM fleet_customer_messages WHERE message_id = c.source_message_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: messageId — the buyer''s own message on this order written after the correction was requested'; END IF;
  IF length(v_reason) NOT BETWEEN 3 AND 300 THEN PERFORM fleet_econ_bad('reason: 3..300 characters'); END IF;
  INSERT INTO fleet_message_checks (agent_id, order_id, message_id, purpose, correction_id) VALUES (p_agent, c.order_id, m.message_id, 'withdrawal', c.correction_id)
    ON CONFLICT (message_id, purpose) DO NOTHING;
  RETURN jsonb_build_object('ok', true, 'status', 'pending', 'note', 'Fleet Control confirms the withdrawal from the buyer''s message; until then the correction stays owed');
END $$;

-- ═══ 4. Fleet Control's check (the controller's worker) ═══
INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance)
  SELECT 'message_check_charge', requires_external_ref, allowed_sources, multi_agent,
         'Fleet Control''s independent check of a customer message classification or withdrawal, paid by the treasury (fleet overhead, never the agent)', provenance
    FROM fleet_ledger_kinds WHERE kind = 'knowledge_review_charge';
INSERT INTO fleet_ledger_rules (kind, class, side) SELECT 'message_check_charge', class, side FROM fleet_ledger_rules WHERE kind = 'knowledge_review_charge';
ALTER TABLE fleet_control_accrual DROP CONSTRAINT fleet_control_accrual_kind_check;
ALTER TABLE fleet_control_accrual ADD CONSTRAINT fleet_control_accrual_kind_check CHECK (kind IN ('knowledge_review_charge','message_check_charge'));
INSERT INTO fleet_control_accrual (kind) VALUES ('message_check_charge');
ALTER TABLE fleet_control_ai_reservations DROP CONSTRAINT fleet_control_ai_reservations_kind_check;
ALTER TABLE fleet_control_ai_reservations ADD CONSTRAINT fleet_control_ai_reservations_kind_check CHECK (kind IN ('spend_review','knowledge_review','evidence_relevance','message_check'));

${RESERVE}

${BACKING}

${DISPATCH}

CREATE FUNCTION svc_message_checks_claim(p_limit integer, p_worker text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE pol fleet_spend_review_policy; k fleet_message_checks; jobs jsonb := '[]'::jsonb; v_rate bigint; v_est bigint;
BEGIN
  IF p_worker IS NULL OR p_worker !~ '^[a-z0-9-]{3,40}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: worker name'; END IF;
  SELECT * INTO pol FROM fleet_spend_review_policy WHERE id = 1;
  SELECT rate_micro INTO v_rate FROM fleet_fx_rates WHERE base = 'USD' AND quote = (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1)
   ORDER BY observed_on DESC, rate_id DESC LIMIT 1;
  v_est := CEIL(pol.estimate_usd_microcents::numeric * COALESCE(v_rate, 1000000) / 1000000 / 1000000)::bigint;
  FOR k IN SELECT * FROM fleet_message_checks WHERE status = 'pending' AND next_attempt_at <= now() AND (claimed_until IS NULL OR claimed_until < now())
            ORDER BY next_attempt_at LIMIT LEAST(GREATEST(COALESCE(p_limit, 3), 1), 10) FOR UPDATE SKIP LOCKED LOOP
    -- No room: checkpoint and defer (the message waits; nothing is asked of the buyer; not an attempt).
    IF (fleet_control_ai_state() ->> 'roomMinor')::bigint < v_est THEN PERFORM fleet_control_ai_budget_reached(); EXIT; END IF;
    UPDATE fleet_message_checks SET claimed_by = p_worker, claimed_until = now() + interval '5 minutes' WHERE check_id = k.check_id;
    jobs := jobs || jsonb_build_object('checkId', k.check_id, 'purpose', k.purpose, 'agentId', k.agent_id,
      'item', (SELECT item FROM fleet_customer_orders WHERE order_id = k.order_id),
      'message', (SELECT body FROM fleet_customer_messages WHERE message_id = k.message_id),
      'earlier', (SELECT COALESCE(jsonb_agg(jsonb_build_object('author', author, 'body', left(body, 600)) ORDER BY created_at), '[]'::jsonb)
                    FROM (SELECT * FROM fleet_customer_messages WHERE order_id = k.order_id
                           AND created_at < (SELECT created_at FROM fleet_customer_messages WHERE message_id = k.message_id) ORDER BY created_at DESC LIMIT 6) e),
      'criteria', (SELECT criteria FROM fleet_order_corrections WHERE correction_id = k.correction_id));
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'reviewTier', pol.review_tier, 'jobs', jobs,
    'tiers', (SELECT COALESCE(jsonb_agg(jsonb_build_object('tier', t.tier, 'provider', t.provider, 'model', t.model, 'thinking', t.thinking,
                'effort', t.effort, 'maxOutputTokens', t.max_output_tokens, 'enabled', t.enabled, 'verifiedAt', t.verified_at, 'promptCache', 'off',
                'prices', jsonb_build_object('inputMicrocentsPerToken', t.input_microcents_per_token, 'outputMicrocentsPerToken', t.output_microcents_per_token,
                  'cacheWriteMicrocentsPerToken', t.cache_write_microcents_per_token, 'cacheReadMicrocentsPerToken', t.cache_read_microcents_per_token))
                ORDER BY t.tier), '[]'::jsonb) FROM fleet_cognition_tiers t));
END $$;

-- The verdict (evidence and confidence, never certainty). Valid verdicts per purpose; the cost is treasury overhead.
CREATE FUNCTION svc_message_check_record(p_check uuid, p_worker text, p_result jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE k fleet_message_checks; v_verdict text := p_result ->> 'verdict'; v_conf numeric;
BEGIN
  SELECT * INTO k FROM fleet_message_checks WHERE check_id = p_check FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  PERFORM fleet_control_charge('message_check_charge', k.check_id::text, p_result -> 'calls');
  IF k.status <> 'pending' THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'status', k.status); END IF;
  v_conf := CASE WHEN jsonb_typeof(p_result -> 'confidence') = 'number' THEN (p_result ->> 'confidence')::numeric END;
  IF v_conf IS NULL OR v_conf < 0 OR v_conf > 1
     OR NOT ((k.purpose = 'conversation' AND v_verdict IN ('no_change','change_requested','uncertain'))
          OR (k.purpose = 'withdrawal' AND v_verdict IN ('withdrawn','not_withdrawn','uncertain'))) THEN
    RETURN svc_message_check_failed(p_check, p_worker, 'FLEET_REVIEW_UNUSABLE: no valid verdict and confidence', '[]'::jsonb);
  END IF;
  UPDATE fleet_message_checks SET status = 'decided', verdict = v_verdict, confidence = round(v_conf, 2), evidence = left(COALESCE(p_result ->> 'evidence', ''), 600),
         calls = calls || COALESCE(p_result -> 'calls', '[]'::jsonb), decided_at = now(), claimed_until = NULL WHERE check_id = p_check;
  PERFORM fleet_event('message_check_decided', k.agent_id, 'fleet_control', jsonb_build_object('checkId', k.check_id, 'orderId', k.order_id,
    'messageId', k.message_id, 'purpose', k.purpose, 'verdict', v_verdict, 'confidence', round(v_conf, 2)));
  RETURN jsonb_build_object('ok', true, 'status', 'decided', 'verdict', v_verdict);
END $$;

-- A failed attempt. Fleet Control's budget having no room is a deferral (15 minutes, not an attempt); anything else is an
-- attempt: 5 minutes, then 30, then stalled (one owner-visible event). The message stays deferred either way.
CREATE FUNCTION svc_message_check_failed(p_check uuid, p_worker text, p_error text, p_calls jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE k fleet_message_checks; v_budget boolean := COALESCE(p_error, '') ~ '^FLEET_CONTROL_AI_BUDGET';
BEGIN
  SELECT * INTO k FROM fleet_message_checks WHERE check_id = p_check FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  PERFORM fleet_control_charge('message_check_charge', k.check_id::text, p_calls);
  IF k.status <> 'pending' THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'status', k.status); END IF;
  IF v_budget THEN
    UPDATE fleet_message_checks SET next_attempt_at = now() + interval '15 minutes', claimed_until = NULL, last_error = left(p_error, 300) WHERE check_id = p_check;
    RETURN jsonb_build_object('ok', true, 'status', 'deferred');
  END IF;
  UPDATE fleet_message_checks SET attempts = attempts + 1, claimed_until = NULL, last_error = left(COALESCE(p_error, 'error'), 300),
         calls = calls || COALESCE(p_calls, '[]'::jsonb),
         status = CASE WHEN attempts + 1 >= ${MESSAGE_CHECK_MAX_ATTEMPTS} THEN 'stalled' ELSE 'pending' END,
         next_attempt_at = now() + CASE WHEN attempts + 1 = 1 THEN interval '5 minutes' ELSE interval '30 minutes' END
   WHERE check_id = p_check RETURNING * INTO k;
  IF k.status = 'stalled' THEN
    PERFORM fleet_event('message_check_stalled', k.agent_id, 'fleet_control', jsonb_build_object('checkId', k.check_id, 'orderId', k.order_id, 'purpose', k.purpose,
      'error', left(COALESCE(p_error, ''), 200), 'note', 'Fleet Control could not check this customer message after 3 attempts: the message stays deferred (the agent is not asked to act and the buyer is not asked anything)'));
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', k.status, 'attempts', k.attempts);
END $$;

REVOKE ALL ON FUNCTION fleet_order_live(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION fleet_order_first_delivery_at(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION fleet_order_owner_withdrawn_at(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION fleet_order_correction_fulfilled(fleet_order_corrections) FROM PUBLIC;
REVOKE ALL ON FUNCTION fleet_order_correction_open(fleet_order_corrections) FROM PUBLIC;
REVOKE ALL ON FUNCTION fleet_order_message_state(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION fleet_order_message_work(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION fleet_econ_order_classify(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION fleet_econ_order_withdraw_correction(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION svc_message_checks_claim(integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION svc_message_check_record(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION svc_message_check_failed(uuid, text, text, jsonb) FROM PUBLIC;
`;
