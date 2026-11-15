/**
 * Schema v62 — the owner talks to the Agents; names are the owner's; Fleet Command sees every routed event.
 *
 * 1. Display names. One validation (`fleet_display_name_clean`): NFC, whitespace collapsed and trimmed, 1–200
 *    characters, any language, punctuation and emoji; hidden control and text-direction characters are refused.
 *    - Agents (v60 labels): the 40-character bound and the uniqueness rule are lifted — two Agents may share a name;
 *      the dashboard tells them apart. The registry name and the identity never change.
 *    - PayPal keys and payment accounts (rails): an owner label (`fleet_owner_labels`) over the fixed vault reference /
 *      rail id. Renaming changes the label only: no credential, secret, reference or link is touched.
 * 2. Conversations. Per Agent: owner messages (with working files) and the Agent's replies (`fleet_agent_messages`,
 *    `fleet_agent_files`), processed in turns (`fleet_conversation_turns`). Owner messages are information or
 *    instructions — they grant nothing; approvals keep their own flows. Sending is idempotent per client key; a likely
 *    secret (private key, card number, known API-key formats) is refused (detection is not exhaustive). Messages wait
 *    while the Agent is paused and are processed by its normal runtime after an authorised resume; the Agent never
 *    sees another Agent's conversation, and nothing here enters the shared knowledge library.
 *    - Agents read, claim, reply, release and fetch files through api_economy (`owner.*`); a free status read carries
 *      the attention signal (`api_cognition_status.attention`) so a hibernating Agent wakes for the owner without a paid
 *      turn to find out.
 * 3. Who pays. A model call made inside an owner conversation turn is paid by the treasury (fleet operating expense:
 *    D fleet:expense / C fleet:treasury:unallocated) — authorised only while treasury cash, less other owner-paid
 *    reservations, covers its estimate; recorded once per request (retries never charge twice); never the Agent's
 *    wallet, never its daily budget; it adds no capital to the Agent. Beyond OWNER_TURN_MAX_CALLS calls in one turn the
 *    Agent's own authorisation applies again (an anti-abuse bound, not a message cap). A shortfall discovered at record
 *    time is booked as far as cash allows and reported (`conversation_cost_unfunded`), never left to fail.
 * 4. The Mind panel: recorded calls (model, tokens, provider USD, ledger charge, payer, tools) and the Agent's own
 *    stated outcome / wake condition / review time (`fleet_agent_mind_reports`, sent by the runtime). No model
 *    reasoning is stored or shown.
 * 5. P3_INFO: thirteen event kinds were routed to a class Fleet Command does not accept (since v56) and never reached
 *    it. They now route to P3_SUMMARY; any already in the history are copied into the feed once (idempotent; newest
 *    COMMAND_FEED_CAP).
 */
import { V17_SQL } from "./migrations-phase17.js";
import { V21_SQL } from "./migrations-phase21.js";
import { V22_SQL } from "./migrations-phase22.js";
import { V23_SQL } from "./migrations-phase23.js";
import { V26_SQL } from "./migrations-phase26.js";
import { V48_SQL } from "./migrations-phase48.js";
import { V49_SQL } from "./migrations-phase49.js";
import { V59_SQL } from "./migrations-phase59.js";
import { V60_SQL, DASHBOARD_WRITE_OPS_V60 } from "./migrations-phase60.js";
import { COMMAND_FEED_CAP } from "./migrations-phase45.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

/** The technical bound of every owner-chosen name (characters). */
export const DISPLAY_NAME_MAX = 200;
/** Owner message size (characters) and working files per message (count, total bytes). */
export const MESSAGE_MAX_CHARS = 20000;
export const MESSAGE_FILES_MAX = 5;
export const MESSAGE_FILES_MAX_BYTES = 10 * 1024 * 1024;
export const MESSAGE_FILE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/csv", "text/plain", "text/markdown",
  "application/json", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"] as const;
/** Treasury-paid model calls per owner turn before the Agent's own authorisation applies (anti-abuse, not a cap on messages). */
export const OWNER_TURN_MAX_CALLS = 24;
/** An unfinished turn is released back to pending after this long (a crashed or restarted runtime). */
export const OWNER_TURN_STALE_MINUTES = 30;

export const P3_INFO_FIXED = ["order_delivered", "order_fulfilled", "order_delivery_failed", "estate_late_money", "paypal_clawback_reconciled",
  "paypal_debit_classified", "paypal_evidence_over_principal", "card_credit_recorded", "card_credit_applied", "card_credit_returned",
  "order_refund_requested", "order_refund_completed", "agent_renamed"] as const;

export const EVENT_ROUTES_V62 = Object.freeze({
  P1_HIGH: ["conversation_cost_unfunded"],
  P2_IMPORTANT: ["agent_replied"],
  P3_SUMMARY: ["owner_label_set"],
  AGENT_ACTIVITY_ONLY: ["owner_message_sent"],
});
export const DASHBOARD_READ_OPS_V62 = ["agent_thread", "agent_mind"] as const;
export const DASHBOARD_WRITE_OPS_V62 = [...DASHBOARD_WRITE_OPS_V60, "agent_message_send", "agent_message_retry", "owner_request_reply", "label_set",
  "agent_cognition_set"] as const;
export const AGENT_OWNER_OPS_V62 = ["owner.inbox", "owner.claim", "owner.reply", "owner.release", "owner.file", "mind.report"] as const;

const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;`;

// ── 1. Names ──
const AGENT_RENAME = restate(V60_SQL, "fleet_admin_agent_rename", [
  [`v_label text := btrim(regexp_replace(COALESCE(p_name, ''), '[[:cntrl:]]', '', 'g'));`, `v_label text := fleet_display_name_clean(p_name);`],
  [`  IF length(v_label) > 40 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: an agent name is at most 40 characters'; END IF;\n`, ``],
  [`  IF EXISTS (SELECT 1 FROM fleet_agents o WHERE o.agent_id <> p_agent AND lower(fleet_agent_label(o.agent_id)) = lower(v_to)) THEN
    RAISE EXCEPTION 'FLEET_CONFLICT: another agent is already called %', v_to;
  END IF;\n`, ``],
]);
const CUSTODY_KEY = restate(V49_SQL, "fleet_custody_key_json", [
  [`'credentials', COALESCE((SELECT jsonb_agg(jsonb_build_object('vaultRef', c.vault_ref, 'status', c.status,`,
   `'credentials', COALESCE((SELECT jsonb_agg(jsonb_build_object('vaultRef', c.vault_ref, 'label', fleet_owner_label('paypal_credential', c.vault_ref), 'status', c.status,`],
]);
const PAYPAL_STATUS = restate(V48_SQL, "fleet_paypal_status", [
  [`jsonb_build_object('railId', r.rail_id, 'label', r.label, 'mode', r.mode,`,
   `jsonb_build_object('railId', r.rail_id, 'label', COALESCE(fleet_owner_label('payment_rail', r.rail_id::text), r.label), 'registryLabel', r.label,
               'webhookId', r.webhook_id, 'mode', r.mode,`],
]);

// ── 3. Who pays ──
const AUTHORIZE_TREASURY = restate(V21_SQL, "svc_cognition_authorize", [
  [`FUNCTION svc_cognition_authorize(p_agent text, p_estimate_cents bigint)`, `FUNCTION fleet_cognition_authorize_treasury(p_agent text, p_estimate_cents bigint, p_turn uuid)`],
  [`        v_est bigint; v_est_micro bigint; v_unposted bigint; v_credits bigint; v_reserved bigint;`,
   `        v_est bigint; v_est_micro bigint; v_unposted bigint; v_credits bigint; v_reserved bigint; v_avail bigint;`],
  [`  IF (s ->> 'spentTodayMicrocents')::bigint + v_est_micro > (s ->> 'dailyBudgetCents')::bigint * 1000000 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_BUDGET_EXHAUSTED');
  END IF;
  PERFORM 1 FROM fleet_ledger_accounts WHERE account_id = fleet_ledger_account(p_agent, 'agent_cash') FOR UPDATE;
  v_unposted := (s ->> 'unpostedMicrocents')::bigint;
  e := fleet_agent_economics(p_agent);
  IF (e ->> 'cash')::bigint * 1000000 - v_unposted < v_est_micro THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INSUFFICIENT_ALLOCATION'); END IF;
  IF (e ->> 'survivalEquity')::bigint * 1000000 - v_unposted < v_est_micro THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PROTECTED_CAPITAL'); END IF;`,
   `  -- v62: the treasury pays an owner conversation turn: no Agent wallet, budget or protected-capital check; treasury cash
  -- less every other owner-paid reservation and the unposted conversation accrual must cover the estimate.
  PERFORM pg_advisory_xact_lock(hashtext('fleet_treasury_conversation'));
  v_avail := fleet_ledger_balance('fleet:treasury:unallocated') * 1000000
    - COALESCE((SELECT sum(estimate_cents) FROM fleet_cognition_inflight WHERE payer = 'treasury'), 0) * 1000000
    - COALESCE((SELECT unposted_microcents FROM fleet_conversation_accrual WHERE id = 1), 0);
  IF v_avail < v_est_micro THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_TREASURY_INSUFFICIENT', 'availableMinor', GREATEST(v_avail / 1000000, 0), 'neededMinor', v_est);
  END IF;`],
  [`  INSERT INTO fleet_cognition_inflight (agent_id, request_id, estimate_cents, estimate_usd_cents, fx_rate_id, fx_rate_micro)
    VALUES (p_agent, v_id, v_est, v_est_usd, v_rate_id, v_rate);`,
   `  INSERT INTO fleet_cognition_inflight (agent_id, request_id, estimate_cents, estimate_usd_cents, fx_rate_id, fx_rate_micro, payer, conversation_turn)
    VALUES (p_agent, v_id, v_est, v_est_usd, v_rate_id, v_rate, 'treasury', p_turn);`],
  [`'maxOutputTokens', s -> 'maxOutputTokens');`, `'maxOutputTokens', s -> 'maxOutputTokens', 'payer', 'treasury');`],
]);
const AUTHORIZE_CONVERSATION = restate(V22_SQL, "svc_cognition_routed_authorize", [
  [`FUNCTION svc_cognition_routed_authorize(p_agent text, p_estimate_usd_cents bigint, p_route jsonb, p_prompt_sha256 text)`,
   `FUNCTION svc_cognition_conversation_authorize(p_agent text, p_estimate_usd_cents bigint, p_route jsonb, p_prompt_sha256 text, p_turn uuid)`],
  [`  r := svc_cognition_authorize(p_agent, p_estimate_usd_cents);`,
   `  -- v62: inside an open owner turn of this Agent (and within its anti-abuse bound) the treasury pays; otherwise the Agent.
  IF EXISTS (SELECT 1 FROM fleet_conversation_turns ct WHERE ct.turn_id = p_turn AND ct.agent_id = p_agent AND ct.closed_at IS NULL
               AND ct.calls < ${OWNER_TURN_MAX_CALLS}) THEN
    r := fleet_cognition_authorize_treasury(p_agent, p_estimate_usd_cents, p_turn);
  ELSE
    r := svc_cognition_authorize(p_agent, p_estimate_usd_cents);
  END IF;`],
]);
const RECORD = restate(V23_SQL, "svc_cognition_routed_record", [
  [`        v_unposted bigint; v_total bigint; v_rate bigint; v_acct text; v_saving bigint;`,
   `        v_unposted bigint; v_total bigint; v_rate bigint; v_acct text; v_saving bigint; v_avail bigint; v_unfunded bigint := 0;`],
  [`  INSERT INTO fleet_cognition_accrual (agent_id) VALUES (p_agent) ON CONFLICT (agent_id) DO NOTHING;
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
  UPDATE fleet_cognition_accrual SET unposted_microcents = v_unposted, updated_at = now() WHERE agent_id = p_agent;`,
   `  IF i.payer = 'treasury' THEN
    -- v62: an owner conversation turn: the treasury pays (fleet operating expense), never the Agent.
    INSERT INTO fleet_conversation_accrual (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
    SELECT unposted_microcents INTO v_unposted FROM fleet_conversation_accrual WHERE id = 1 FOR UPDATE;
    v_total := v_unposted + v_micro;
    v_charge := v_total / 1000000;
    v_unposted := v_total - v_charge * 1000000;
    v_avail := GREATEST(fleet_ledger_balance('fleet:treasury:unallocated'), 0);
    v_unfunded := GREATEST(v_charge - v_avail, 0);
    v_charge := v_charge - v_unfunded;
    IF v_charge > 0 THEN
      v_j := fleet_ledger_post('owner_conversation_charge', 'convo:' || p_request, 'controller', 'owner conversation (AI processing)', 'controller', NULL, NULL, NULL, NULL, NULL, now(),
        jsonb_build_array(
          jsonb_build_object('account', 'fleet:expense', 'side', 'D', 'amount', v_charge),
          jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', v_charge)));
    END IF;
    UPDATE fleet_conversation_accrual SET unposted_microcents = v_unposted, updated_at = now() WHERE id = 1;
    UPDATE fleet_conversation_turns SET calls = calls + 1, provider_usd_microcents = provider_usd_microcents + v_used_usd,
           charged_microcents = charged_microcents + v_micro, charged_cents = charged_cents + v_charge, unfunded_cents = unfunded_cents + v_unfunded
     WHERE turn_id = i.conversation_turn;
    IF v_unfunded > 0 THEN
      PERFORM fleet_event('conversation_cost_unfunded', p_agent, 'controller', jsonb_build_object('unfundedMinor', v_unfunded,
        'note', 'the treasury could not cover this owner conversation turn in full; the shortfall is recorded, not charged to the agent'));
    END IF;
  ELSE
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
  END IF;`],
  [`  INSERT INTO fleet_cognition_log (request_id, agent_id, provider,`, `  INSERT INTO fleet_cognition_log (payer, conversation_turn, request_id, agent_id, provider,`],
  [`    VALUES (p_request, p_agent, i.route_provider,`, `    VALUES (i.payer, i.conversation_turn, p_request, p_agent, i.route_provider,`],
  [`  RETURN jsonb_build_object('ok', true, 'chargedCents', v_charge,`, `  RETURN jsonb_build_object('ok', true, 'payer', i.payer, 'unfundedCents', v_unfunded, 'chargedCents', v_charge,`],
]);
const STATE = restate(V17_SQL, "fleet_cognition_state", [
  [`      FROM fleet_cognition_log WHERE agent_id = p_agent AND at > now() - interval '1 day')`,
   `      FROM fleet_cognition_log WHERE agent_id = p_agent AND payer = 'agent' AND at > now() - interval '1 day')`],
]);

// ── 2. The free attention signal on the per-slot status read ──
const COGNITION_STATUS = restate(V26_SQL, "api_cognition_status", [
  [`|| jsonb_build_object('survival', fleet_survival_observation(p_agent));`,
   `|| jsonb_build_object('survival', fleet_survival_observation(p_agent), 'attention', fleet_agent_attention(p_agent));`],
]);
const DISPATCH = restate(V59_SQL, "api_economy", [
  [`WHEN 'order.refund' THEN 'planning'`, `WHEN 'order.refund' THEN 'planning' ${AGENT_OWNER_OPS_V62.map((o) => `WHEN '${o}' THEN 'planning'`).join(" ")}`],
  [`      WHEN 'order.refund' THEN fleet_econ_order_refund(p_agent, a)`,
   `      WHEN 'order.refund' THEN fleet_econ_order_refund(p_agent, a)
      WHEN 'owner.inbox' THEN fleet_econ_owner_inbox(p_agent, a)
      WHEN 'owner.claim' THEN fleet_econ_owner_claim(p_agent, a)
      WHEN 'owner.reply' THEN fleet_econ_owner_reply(p_agent, a)
      WHEN 'owner.release' THEN fleet_econ_owner_release(p_agent, a)
      WHEN 'owner.file' THEN fleet_econ_owner_file(p_agent, a)
      WHEN 'mind.report' THEN fleet_econ_mind_report(p_agent, a)`],
]);
const DASH_CALL = restate(V60_SQL, "dash_call", [
  [`OR p_op IN (${q(DASHBOARD_WRITE_OPS_V60)})`, `OR p_op IN (${q(DASHBOARD_WRITE_OPS_V62)})`],
  [`'customer_orders','paypal_disputes')) THEN`, `'customer_orders','paypal_disputes',${q(DASHBOARD_READ_OPS_V62)})) THEN`],
  [`      WHEN 'agent_rename' THEN fleet_admin_agent_rename(a ->> 'agentId', a ->> 'name', 'operator:owner')`,
   `      WHEN 'agent_rename' THEN fleet_admin_agent_rename(a ->> 'agentId', a ->> 'name', 'operator:owner')
      -- v62: conversations, request replies, labels, pause / resume (ordinary writes; nothing here moves money)
      WHEN 'agent_thread' THEN fleet_admin_agent_thread(a ->> 'agentId', COALESCE((a ->> 'limit')::integer, 100))
      WHEN 'agent_mind' THEN fleet_admin_agent_mind(a ->> 'agentId')
      WHEN 'agent_message_send' THEN fleet_admin_agent_message_send(a ->> 'agentId', a ->> 'body', a -> 'files', a ->> 'clientKey', 'operator:owner')
      WHEN 'agent_message_retry' THEN fleet_admin_agent_message_retry((a ->> 'messageId')::uuid, 'operator:owner')
      WHEN 'owner_request_reply' THEN fleet_owner_request_decide((a ->> 'requestId')::uuid, a ->> 'decision', a ->> 'response', 'operator:owner')
      WHEN 'label_set' THEN fleet_admin_label_set(a ->> 'kind', a ->> 'id', a ->> 'name', 'operator:owner')
      WHEN 'agent_cognition_set' THEN fleet_founder_cognition_set(a ->> 'agentId', NULL, (a ->> 'paused')::boolean, NULL, NULL,
        COALESCE(NULLIF(a ->> 'reason', ''), CASE WHEN (a ->> 'paused')::boolean THEN 'Paused by the owner from the dashboard' ELSE 'Resumed by the owner from the dashboard' END), 'operator:owner')`],
]);

// ── 5. Routing: P3_INFO → P3_SUMMARY, plus the v62 events ──
const EVENT_ROUTE = restate(V60_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V62) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]).replace(/THEN 'P3_INFO'/g, "THEN 'P3_SUMMARY'");

const FILE_TYPES = q(MESSAGE_FILE_TYPES);

export const V62_SQL = `
-- ── 1. Names ──
CREATE FUNCTION fleet_display_name_clean(p text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v text := btrim(regexp_replace(normalize(COALESCE(p, ''), NFC), '\\s+', ' ', 'g'));
BEGIN
  IF v ~ '[[:cntrl:]]' OR v ~ '[\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]' THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: a name cannot contain hidden control or text-direction characters';
  END IF;
  IF char_length(v) > ${DISPLAY_NAME_MAX} THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a name can be up to ${DISPLAY_NAME_MAX} characters'; END IF;
  RETURN v;
END $$;

ALTER TABLE fleet_agent_labels DROP CONSTRAINT fleet_agent_labels_label_check;
ALTER TABLE fleet_agent_labels ADD CONSTRAINT fleet_agent_labels_label_check CHECK (char_length(label) BETWEEN 1 AND ${DISPLAY_NAME_MAX});
DROP INDEX fleet_agent_labels_unique;

CREATE TABLE fleet_owner_labels (
  subject_kind text        NOT NULL CHECK (subject_kind IN ('paypal_credential','payment_rail')),
  subject_id   text        NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 200),
  label        text        NOT NULL CHECK (char_length(label) BETWEEN 1 AND ${DISPLAY_NAME_MAX}),
  set_by       text        NOT NULL,
  set_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_kind, subject_id)
);
CREATE FUNCTION fleet_owner_label(p_kind text, p_id text) RETURNS text LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT label FROM fleet_owner_labels WHERE subject_kind = p_kind AND subject_id = p_id
$$;
-- The owner's label for a PayPal key set or a payment account (empty = back to the default). The vault reference,
-- rail id, sealed secret and every link stay exactly as they are.
CREATE FUNCTION fleet_admin_label_set(p_kind text, p_id text, p_name text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v text := fleet_display_name_clean(p_name); v_from text;
BEGIN
  ${OWNER_ACTOR}
  IF p_kind = 'paypal_credential' THEN
    IF NOT EXISTS (SELECT 1 FROM fleet_custody_sealed_credentials WHERE vault_ref = p_id) THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no saved PayPal keys with that reference'; END IF;
  ELSIF p_kind = 'payment_rail' THEN
    IF p_id IS NULL OR p_id !~ '^[0-9a-f-]{36}$' OR NOT EXISTS (SELECT 1 FROM fleet_payment_rails WHERE rail_id = p_id::uuid) THEN
      RAISE EXCEPTION 'FLEET_NOT_FOUND: no payment account with that id';
    END IF;
  ELSE RAISE EXCEPTION 'FLEET_BAD_REQUEST: a label is for saved PayPal keys or a payment account'; END IF;
  v_from := fleet_owner_label(p_kind, p_id);
  IF v = '' THEN DELETE FROM fleet_owner_labels WHERE subject_kind = p_kind AND subject_id = p_id;
  ELSE
    INSERT INTO fleet_owner_labels (subject_kind, subject_id, label, set_by) VALUES (p_kind, p_id, v, p_actor)
    ON CONFLICT (subject_kind, subject_id) DO UPDATE SET label = EXCLUDED.label, set_by = EXCLUDED.set_by, set_at = now();
  END IF;
  IF v_from IS DISTINCT FROM NULLIF(v, '') THEN
    PERFORM fleet_event('owner_label_set', NULL, p_actor, jsonb_build_object('kind', p_kind, 'from', v_from, 'to', NULLIF(v, '')));
  END IF;
  RETURN jsonb_build_object('ok', true, 'kind', p_kind, 'id', p_id, 'label', NULLIF(v, ''));
END $$;

${AGENT_RENAME}

${CUSTODY_KEY}

${PAYPAL_STATUS}

-- ── 2. Conversations ──
CREATE TABLE fleet_conversation_turns (
  turn_id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id                text        NOT NULL REFERENCES fleet_agents(agent_id),
  opened_at               timestamptz NOT NULL DEFAULT now(),
  closed_at               timestamptz,
  outcome                 text        CHECK (outcome IN ('replied','no_reply','released','failed','expired')),
  release_code            text        CHECK (release_code ~ '^[A-Z0-9_]{2,64}$'),
  calls                   integer     NOT NULL DEFAULT 0,
  provider_usd_microcents bigint      NOT NULL DEFAULT 0,
  charged_microcents      bigint      NOT NULL DEFAULT 0,
  charged_cents           bigint      NOT NULL DEFAULT 0,
  unfunded_cents          bigint      NOT NULL DEFAULT 0,
  CHECK ((closed_at IS NULL) = (outcome IS NULL))
);
CREATE UNIQUE INDEX fleet_conversation_turns_open ON fleet_conversation_turns (agent_id) WHERE closed_at IS NULL;
CREATE TRIGGER fleet_conversation_turns_no_delete BEFORE DELETE ON fleet_conversation_turns FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_agent_messages (
  message_id  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    text        NOT NULL REFERENCES fleet_agents(agent_id),
  author      text        NOT NULL CHECK (author IN ('owner','agent')),
  body        text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND ${MESSAGE_MAX_CHARS}),
  reply_to    uuid        REFERENCES fleet_agent_messages(message_id),
  status      text        NOT NULL CHECK (status IN ('pending','processing','answered','read','failed','delivered')),
  turn_id     uuid        REFERENCES fleet_conversation_turns(turn_id),
  block_code  text        CHECK (block_code ~ '^[A-Z0-9_]{2,64}$'),
  client_key  text        CHECK (client_key ~ '^[A-Za-z0-9:_.-]{8,128}$'),
  created_by  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((author = 'agent') = (status = 'delivered')),
  UNIQUE (agent_id, client_key)
);
CREATE INDEX fleet_agent_messages_thread ON fleet_agent_messages (agent_id, created_at DESC);
CREATE INDEX fleet_agent_messages_pending ON fleet_agent_messages (agent_id, created_at) WHERE status IN ('pending','processing');
CREATE TRIGGER fleet_agent_messages_no_delete BEFORE DELETE ON fleet_agent_messages FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE FUNCTION fleet_agent_messages_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.agent_id <> OLD.agent_id OR NEW.author <> OLD.author OR NEW.body <> OLD.body OR NEW.created_at <> OLD.created_at
     OR NEW.created_by <> OLD.created_by OR NEW.reply_to IS DISTINCT FROM OLD.reply_to OR NEW.client_key IS DISTINCT FROM OLD.client_key THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a message''s author, text and time are fixed';
  END IF;
  IF OLD.author = 'agent' THEN RAISE EXCEPTION 'FLEET_IMMUTABLE: an agent reply is history'; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_agent_messages_guard BEFORE UPDATE ON fleet_agent_messages FOR EACH ROW EXECUTE FUNCTION fleet_agent_messages_guard();

CREATE TABLE fleet_agent_files (
  file_id      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     text        NOT NULL REFERENCES fleet_agents(agent_id),
  message_id   uuid        NOT NULL REFERENCES fleet_agent_messages(message_id),
  name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND ${DISPLAY_NAME_MAX}),
  content_type text        NOT NULL CHECK (content_type IN (${FILE_TYPES})),
  size_bytes   integer     NOT NULL CHECK (size_bytes BETWEEN 1 AND ${MESSAGE_FILES_MAX_BYTES}),
  sha256       text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  data         bytea       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  fetched_at   timestamptz
);
CREATE INDEX fleet_agent_files_message ON fleet_agent_files (message_id);
CREATE TRIGGER fleet_agent_files_no_delete BEFORE DELETE ON fleet_agent_files FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_agent_mind_reports (
  report_id   bigserial   PRIMARY KEY,
  agent_id    text        NOT NULL REFERENCES fleet_agents(agent_id),
  request_id  uuid,
  packet      text        CHECK (packet IN ('full','slim','owner','question','decision')),
  outcome     text        CHECK (char_length(outcome) <= 500),
  wake_on     text        CHECK (char_length(wake_on) <= 300),
  review_at   timestamptz,
  tools       text[]      NOT NULL DEFAULT '{}',
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_agent_mind_reports_agent ON fleet_agent_mind_reports (agent_id, at DESC);

CREATE TABLE fleet_conversation_accrual (
  id                  integer     PRIMARY KEY CHECK (id = 1),
  unposted_microcents bigint      NOT NULL DEFAULT 0,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance) VALUES
  ('owner_conversation_charge', false, ARRAY['controller'], false, 'Owner conversation: AI processing of the owner''s messages, paid by the treasury (a Fleet operating expense, never the agent)', 'expense');
INSERT INTO fleet_ledger_rules (kind, class, side) VALUES ('owner_conversation_charge','fleet_expense','D'), ('owner_conversation_charge','treasury_cash','C');

-- Who paid each model call (v62): the Agent, or the treasury for an owner conversation turn.
ALTER TABLE fleet_cognition_inflight ADD COLUMN payer text NOT NULL DEFAULT 'agent' CHECK (payer IN ('agent','treasury'));
ALTER TABLE fleet_cognition_inflight ADD COLUMN conversation_turn uuid REFERENCES fleet_conversation_turns(turn_id);
ALTER TABLE fleet_cognition_log ADD COLUMN payer text NOT NULL DEFAULT 'agent' CHECK (payer IN ('agent','treasury'));
ALTER TABLE fleet_cognition_log ADD COLUMN conversation_turn uuid REFERENCES fleet_conversation_turns(turn_id);

-- A likely secret in owner text (not exhaustive: a hint, never a guarantee). NULL when none is recognised.
CREATE FUNCTION fleet_secret_hint(p text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE m text[]; d text; s integer; x integer; i integer;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  IF p ~ '-----BEGIN [A-Z ]*PRIVATE KEY-----' THEN RETURN 'a private key'; END IF;
  IF p ~ '(sk|rk)_live_[A-Za-z0-9]{10,}' OR p ~ 'AKIA[0-9A-Z]{16}' OR p ~ 'xox[abposr]-[A-Za-z0-9-]{10,}' OR p ~ 'gh[pousr]_[A-Za-z0-9]{30,}'
     OR p ~ 'AIza[0-9A-Za-z_-]{35}' OR p ~ 'sk-(ant|proj)-[A-Za-z0-9_-]{20,}' THEN RETURN 'an API key or access token'; END IF;
  FOR m IN SELECT regexp_matches(p, '(?:[0-9][ -]?){12,18}[0-9]', 'g') LOOP
    d := regexp_replace(m[1], '[^0-9]', '', 'g');
    IF length(d) BETWEEN 13 AND 19 THEN
      s := 0;
      FOR i IN 1..length(d) LOOP
        x := substr(d, length(d) - i + 1, 1)::integer;
        IF i % 2 = 0 THEN x := x * 2; IF x > 9 THEN x := x - 9; END IF; END IF;
        s := s + x;
      END LOOP;
      IF s % 10 = 0 THEN RETURN 'a card number'; END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

-- Free for the runtime: what is waiting for this Agent's attention (no model call to find out).
CREATE FUNCTION fleet_agent_attention(p_agent text) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'ownerPending', (SELECT count(*) FROM fleet_agent_messages WHERE agent_id = p_agent AND author = 'owner' AND status = 'pending'),
    'ownerDigest', (SELECT md5(COALESCE(string_agg(message_id::text, ',' ORDER BY created_at), '')) FROM fleet_agent_messages
                     WHERE agent_id = p_agent AND author = 'owner' AND status IN ('pending','processing')),
    'requestsDigest', (SELECT md5(COALESCE(string_agg(request_id::text || ':' || status || ':' || COALESCE(decided_at::text, ''), ',' ORDER BY request_id), ''))
                        FROM fleet_owner_requests WHERE agent_id = p_agent),
    'openTurn', (SELECT turn_id FROM fleet_conversation_turns WHERE agent_id = p_agent AND closed_at IS NULL))
$$;

CREATE FUNCTION fleet_message_files_json(p_message uuid) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('fileId', f.file_id, 'name', f.name, 'contentType', f.content_type, 'sizeBytes', f.size_bytes,
           'sha256', f.sha256, 'fetchedAt', f.fetched_at) ORDER BY f.created_at), '[]'::jsonb)
    FROM fleet_agent_files f WHERE f.message_id = p_message
$$;

CREATE FUNCTION fleet_message_json(m fleet_agent_messages) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('itemType', 'message', 'messageId', m.message_id, 'author', m.author, 'body', m.body, 'status', m.status,
    'replyTo', m.reply_to, 'blockCode', m.block_code, 'at', m.created_at, 'updatedAt', m.updated_at, 'files', fleet_message_files_json(m.message_id),
    'turn', (SELECT jsonb_build_object('turnId', t.turn_id, 'outcome', t.outcome, 'calls', t.calls, 'providerUsdMicrocents', t.provider_usd_microcents,
               'chargedCents', t.charged_cents, 'unfundedCents', t.unfunded_cents, 'openedAt', t.opened_at, 'closedAt', t.closed_at)
             FROM fleet_conversation_turns t WHERE t.turn_id = m.turn_id)))
$$;

-- Release turns a crashed or restarted runtime left open (their messages wait again; nothing was charged twice).
CREATE FUNCTION fleet_conversation_release_stale(p_agent text) RETURNS integer LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t fleet_conversation_turns; n integer := 0;
BEGIN
  FOR t IN SELECT * FROM fleet_conversation_turns WHERE agent_id = p_agent AND closed_at IS NULL
             AND opened_at < now() - interval '${OWNER_TURN_STALE_MINUTES} minutes' FOR UPDATE LOOP
    UPDATE fleet_conversation_turns SET closed_at = now(), outcome = 'expired' WHERE turn_id = t.turn_id;
    UPDATE fleet_agent_messages SET status = 'pending', block_code = 'TURN_EXPIRED' WHERE turn_id = t.turn_id AND status = 'processing';
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- The owner sends a message (and working files) to one Agent. Idempotent per client key; a likely secret is refused.
CREATE FUNCTION fleet_admin_agent_message_send(p_agent text, p_body text, p_files jsonb, p_client_key text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE ag fleet_agents; m fleet_agent_messages; f jsonb; v_body text := btrim(COALESCE(p_body, '')); v_data bytea; v_total bigint := 0; v_hint text;
        v_name text; v_type text; n integer := 0;
BEGIN
  ${OWNER_ACTOR}
  SELECT * INTO ag FROM fleet_agents WHERE agent_id = p_agent;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such agent'; END IF;
  IF ag.status = 'dead' THEN RAISE EXCEPTION 'FLEET_AGENT_DEAD: this agent has died; its conversation is history'; END IF;
  IF p_client_key IS NULL OR p_client_key !~ '^[A-Za-z0-9:_.-]{8,128}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a client key'; END IF;
  SELECT * INTO m FROM fleet_agent_messages WHERE agent_id = p_agent AND client_key = p_client_key;
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'message', fleet_message_json(m)); END IF;
  IF p_files IS NOT NULL AND jsonb_typeof(p_files) <> 'array' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: files is a list'; END IF;
  IF v_body = '' AND COALESCE(jsonb_array_length(p_files), 0) = 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: write a message or attach a file'; END IF;
  IF v_body = '' THEN v_body := '(files attached)'; END IF;
  IF char_length(v_body) > ${MESSAGE_MAX_CHARS} THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a message can be up to ${MESSAGE_MAX_CHARS} characters'; END IF;
  IF v_body ~ '[\\x01-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the message contains hidden control characters'; END IF;
  v_hint := fleet_secret_hint(v_body);
  IF v_hint IS NOT NULL THEN
    RAISE EXCEPTION 'FLEET_SECRET_DETECTED: the message looks like it contains %. Chat is not a vault: use Money & identity for keys, cards, bank details and documents', v_hint;
  END IF;
  IF COALESCE(jsonb_array_length(p_files), 0) > ${MESSAGE_FILES_MAX} THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: up to ${MESSAGE_FILES_MAX} files per message'; END IF;
  INSERT INTO fleet_agent_messages (agent_id, author, body, status, client_key, created_by) VALUES (p_agent, 'owner', v_body, 'pending', p_client_key, p_actor)
    RETURNING * INTO m;
  FOR f IN SELECT * FROM jsonb_array_elements(COALESCE(p_files, '[]'::jsonb)) LOOP
    v_name := fleet_display_name_clean(f ->> 'name');
    v_type := f ->> 'contentType';
    IF v_name = '' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: every file needs a name'; END IF;
    IF v_type IS NULL OR v_type NOT IN (${FILE_TYPES}) THEN
      RAISE EXCEPTION 'FLEET_BAD_REQUEST: % is not a supported file type (images, PDF, CSV, text, Markdown, JSON, Excel and Word files)', COALESCE(v_type, 'this');
    END IF;
    BEGIN v_data := decode(f ->> 'dataB64', 'base64'); EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a file could not be read'; END;
    IF v_data IS NULL OR octet_length(v_data) = 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: % is empty', v_name; END IF;
    v_total := v_total + octet_length(v_data);
    IF v_total > ${MESSAGE_FILES_MAX_BYTES} THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: files can be up to 10 MB in total per message'; END IF;
    IF v_type IN ('text/csv','text/plain','text/markdown','application/json') THEN
      BEGIN v_hint := fleet_secret_hint(convert_from(v_data, 'UTF8')); EXCEPTION WHEN OTHERS THEN v_hint := NULL; END;
      IF v_hint IS NOT NULL THEN
        RAISE EXCEPTION 'FLEET_SECRET_DETECTED: % looks like it contains %. Use Money & identity for keys, cards, bank details and documents', v_name, v_hint;
      END IF;
    END IF;
    INSERT INTO fleet_agent_files (agent_id, message_id, name, content_type, size_bytes, sha256, data)
      VALUES (p_agent, m.message_id, v_name, v_type, octet_length(v_data), encode(sha256(v_data), 'hex'), v_data);
    n := n + 1;
  END LOOP;
  PERFORM fleet_event('owner_message_sent', p_agent, p_actor, jsonb_build_object('messageId', m.message_id, 'files', n));
  RETURN jsonb_build_object('ok', true, 'message', fleet_message_json(m));
END $$;

-- A failed message is offered to the Agent again (the owner's explicit retry).
CREATE FUNCTION fleet_admin_agent_message_retry(p_message uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE m fleet_agent_messages;
BEGIN
  ${OWNER_ACTOR}
  UPDATE fleet_agent_messages SET status = 'pending', block_code = NULL WHERE message_id = p_message AND author = 'owner' AND status IN ('failed','read')
    RETURNING * INTO m;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: only a message that failed or got no reply can be sent again'; END IF;
  RETURN jsonb_build_object('ok', true, 'message', fleet_message_json(m));
END $$;

-- One Agent's conversation: messages, replies, its requests to the owner and its card requests (with their status) — in time order.
CREATE FUNCTION fleet_admin_agent_thread(p_agent text, p_limit integer) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'agentId', p_agent,
    'cognition', (SELECT jsonb_build_object('enabled', c.enabled, 'paused', c.paused, 'reason', c.reason, 'updatedAt', c.updated_at)
                  FROM fleet_founder_cognition c WHERE c.agent_id = p_agent),
    'attention', fleet_agent_attention(p_agent),
    'items', COALESCE((SELECT jsonb_agg(x.j ORDER BY x.at) FROM (
        SELECT * FROM (
          SELECT fleet_message_json(m) AS j, m.created_at AS at FROM fleet_agent_messages m WHERE m.agent_id = p_agent
          UNION ALL
          SELECT fleet_owner_request_json(r) || jsonb_build_object('itemType', 'request', 'at', r.created_at), r.created_at FROM fleet_owner_requests r WHERE r.agent_id = p_agent
          UNION ALL
          SELECT jsonb_build_object('itemType', 'card_request', 'requestId', cr.request_id, 'merchant', cr.merchant, 'amountMinor', cr.amount_minor,
                   'purpose', cr.purpose, 'status', cr.status, 'expiresAt', cr.expires_at, 'at', cr.created_at), cr.created_at
            FROM fleet_card_requests cr WHERE cr.agent_id = p_agent
        ) u ORDER BY at DESC LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)) x), '[]'::jsonb))
$$;

-- The Mind panel: recorded calls and the Agent's own stated outcomes (no model reasoning is stored or shown).
CREATE FUNCTION fleet_admin_agent_mind(p_agent text) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'agentId', p_agent,
    'cognition', (SELECT jsonb_build_object('enabled', c.enabled, 'paused', c.paused, 'reason', c.reason, 'updatedAt', c.updated_at)
                  FROM fleet_founder_cognition c WHERE c.agent_id = p_agent),
    'calls', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('at', l.at, 'model', l.model, 'tier', l.tier, 'outcome', l.outcome,
               'inputTokens', l.input_tokens, 'outputTokens', l.output_tokens, 'providerUsdMicrocents', l.provider_usd_microcents,
               'chargedCents', l.charged_cents, 'currency', l.ledger_currency, 'fxRateMicro', l.fx_rate_micro, 'payer', l.payer,
               'tools', (SELECT jsonb_agg(t ->> 'name') FROM jsonb_array_elements(COALESCE(l.tool_calls, '[]'::jsonb)) t), 'errorCode', l.error_code))
               ORDER BY l.at DESC)
             FROM (SELECT * FROM fleet_cognition_log WHERE agent_id = p_agent ORDER BY at DESC LIMIT 30) l), '[]'::jsonb),
    'reports', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('at', r.at, 'packet', r.packet, 'outcome', r.outcome, 'wakeOn', r.wake_on,
               'reviewAt', r.review_at, 'tools', to_jsonb(r.tools))) ORDER BY r.at DESC)
             FROM (SELECT * FROM fleet_agent_mind_reports WHERE agent_id = p_agent ORDER BY at DESC LIMIT 30) r), '[]'::jsonb),
    'costs', (SELECT jsonb_build_object(
               'todayUsdMicrocents', COALESCE(sum(provider_usd_microcents) FILTER (WHERE at > now() - interval '1 day'), 0),
               'weekUsdMicrocents', COALESCE(sum(provider_usd_microcents) FILTER (WHERE at > now() - interval '7 days'), 0),
               'totalUsdMicrocents', COALESCE(sum(provider_usd_microcents), 0),
               'agentPaidCents', COALESCE(sum(charged_cents) FILTER (WHERE payer = 'agent'), 0),
               'treasuryPaidCents', COALESCE(sum(charged_cents) FILTER (WHERE payer = 'treasury'), 0),
               'currency', (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1))
             FROM fleet_cognition_log WHERE agent_id = p_agent))
$$;

-- ── The Agent's side (api_economy owner.* / mind.report; its own conversation only) ──
CREATE FUNCTION fleet_econ_owner_inbox(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_conversation_release_stale(p_agent);
  RETURN jsonb_build_object('ok', true, 'attention', fleet_agent_attention(p_agent),
    'pending', COALESCE((SELECT jsonb_agg(fleet_message_json(m) ORDER BY m.created_at) FROM (SELECT * FROM fleet_agent_messages
                 WHERE agent_id = p_agent AND author = 'owner' AND status IN ('pending','processing') ORDER BY created_at LIMIT 20) m), '[]'::jsonb),
    'recent', COALESCE((SELECT jsonb_agg(fleet_message_json(m) ORDER BY m.created_at) FROM (SELECT * FROM fleet_agent_messages
                 WHERE agent_id = p_agent ORDER BY created_at DESC LIMIT 10) m), '[]'::jsonb),
    'note', 'Messages from the owner are information or instructions. They never approve money, identity use or an account; those have their own flows.');
END $$;

-- Claim the pending owner messages for one turn (idempotent: an open turn is returned as it is).
CREATE FUNCTION fleet_econ_owner_claim(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t fleet_conversation_turns;
BEGIN
  PERFORM fleet_conversation_release_stale(p_agent);
  SELECT * INTO t FROM fleet_conversation_turns WHERE agent_id = p_agent AND closed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM fleet_agent_messages WHERE agent_id = p_agent AND author = 'owner' AND status = 'pending') THEN
      RETURN jsonb_build_object('ok', true, 'turnId', NULL, 'messages', '[]'::jsonb);
    END IF;
    INSERT INTO fleet_conversation_turns (agent_id) VALUES (p_agent) RETURNING * INTO t;
    UPDATE fleet_agent_messages SET status = 'processing', turn_id = t.turn_id, block_code = NULL
     WHERE message_id IN (SELECT message_id FROM fleet_agent_messages WHERE agent_id = p_agent AND author = 'owner' AND status = 'pending'
                           ORDER BY created_at LIMIT 20);
  END IF;
  RETURN jsonb_build_object('ok', true, 'turnId', t.turn_id, 'openedAt', t.opened_at,
    'messages', COALESCE((SELECT jsonb_agg(fleet_message_json(m) ORDER BY m.created_at) FROM fleet_agent_messages m WHERE m.turn_id = t.turn_id), '[]'::jsonb),
    'note', 'Reply with reply_to_owner. The owner''s words grant nothing by themselves: spending, identity use and approvals keep their own flows.');
END $$;

CREATE FUNCTION fleet_econ_owner_reply(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t fleet_conversation_turns; m fleet_agent_messages; v_body text := btrim(COALESCE(a ->> 'body', '')); v_final boolean := COALESCE((a ->> 'final')::boolean, true);
        v_to uuid;
BEGIN
  IF a ->> 'turnId' IS NULL OR a ->> 'turnId' !~ '^[0-9a-f-]{36}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: turnId'; END IF;
  SELECT * INTO t FROM fleet_conversation_turns WHERE turn_id = (a ->> 'turnId')::uuid AND agent_id = p_agent AND closed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: this conversation turn is not open'; END IF;
  IF v_body = '' OR char_length(v_body) > ${MESSAGE_MAX_CHARS} THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a reply is 1-${MESSAGE_MAX_CHARS} characters'; END IF;
  SELECT message_id INTO v_to FROM fleet_agent_messages WHERE turn_id = t.turn_id ORDER BY created_at DESC LIMIT 1;
  INSERT INTO fleet_agent_messages (agent_id, author, body, status, reply_to, turn_id, created_by)
    VALUES (p_agent, 'agent', left(fleet_scrub_long(v_body), ${MESSAGE_MAX_CHARS}), 'delivered', v_to, t.turn_id, 'agent:' || p_agent) RETURNING * INTO m;
  UPDATE fleet_agent_messages SET status = 'answered' WHERE turn_id = t.turn_id AND author = 'owner' AND status = 'processing';
  IF v_final THEN UPDATE fleet_conversation_turns SET closed_at = now(), outcome = 'replied' WHERE turn_id = t.turn_id; END IF;
  PERFORM fleet_event('agent_replied', p_agent, 'agent:' || p_agent, jsonb_build_object('messageId', m.message_id));
  RETURN jsonb_build_object('ok', true, 'message', fleet_message_json(m), 'turnClosed', v_final);
END $$;

-- The runtime ends a turn without a reply: released (back to pending, with the reason the owner sees), no_reply or failed.
CREATE FUNCTION fleet_econ_owner_release(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t fleet_conversation_turns; v_outcome text := COALESCE(a ->> 'outcome', 'released');
        v_code text := CASE WHEN a ->> 'code' ~ '^[A-Z0-9_]{2,64}$' THEN regexp_replace(a ->> 'code', '^FLEET_', '') END;
BEGIN
  IF v_outcome NOT IN ('released','no_reply','failed') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: outcome is released, no_reply or failed'; END IF;
  IF a ->> 'turnId' IS NULL OR a ->> 'turnId' !~ '^[0-9a-f-]{36}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: turnId'; END IF;
  SELECT * INTO t FROM fleet_conversation_turns WHERE turn_id = (a ->> 'turnId')::uuid AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such conversation turn'; END IF;
  IF t.closed_at IS NOT NULL THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'outcome', t.outcome); END IF;
  UPDATE fleet_conversation_turns SET closed_at = now(), outcome = v_outcome, release_code = v_code WHERE turn_id = t.turn_id;
  UPDATE fleet_agent_messages SET status = CASE v_outcome WHEN 'released' THEN 'pending' WHEN 'no_reply' THEN 'read' ELSE 'failed' END, block_code = v_code
   WHERE turn_id = t.turn_id AND author = 'owner' AND status = 'processing';
  RETURN jsonb_build_object('ok', true, 'outcome', v_outcome);
END $$;

CREATE FUNCTION fleet_econ_owner_file(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE f fleet_agent_files;
BEGIN
  IF a ->> 'fileId' IS NULL OR a ->> 'fileId' !~ '^[0-9a-f-]{36}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: fileId'; END IF;
  UPDATE fleet_agent_files SET fetched_at = COALESCE(fetched_at, now()) WHERE file_id = (a ->> 'fileId')::uuid AND agent_id = p_agent RETURNING * INTO f;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such file in your conversation'; END IF;
  RETURN jsonb_build_object('ok', true, 'fileId', f.file_id, 'name', f.name, 'contentType', f.content_type, 'sizeBytes', f.size_bytes, 'sha256', f.sha256,
    'dataB64', encode(f.data, 'base64'));
END $$;

CREATE FUNCTION fleet_econ_mind_report(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_review timestamptz;
BEGIN
  BEGIN v_review := (a ->> 'reviewAt')::timestamptz; EXCEPTION WHEN OTHERS THEN v_review := NULL; END;
  INSERT INTO fleet_agent_mind_reports (agent_id, request_id, packet, outcome, wake_on, review_at, tools)
    VALUES (p_agent, CASE WHEN a ->> 'requestId' ~ '^[0-9a-f-]{36}$' THEN (a ->> 'requestId')::uuid END,
            CASE WHEN a ->> 'packet' IN ('full','slim','owner','question','decision') THEN a ->> 'packet' END,
            left(fleet_scrub(a ->> 'outcome'), 500), left(fleet_scrub(a ->> 'wakeOn'), 300), v_review,
            COALESCE((SELECT array_agg(left(t, 64)) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(a -> 'tools') = 'array' THEN a -> 'tools' ELSE '[]'::jsonb END) t), '{}'));
  RETURN jsonb_build_object('ok', true);
END $$;

-- ── 3. Who pays ──

${STATE}

${AUTHORIZE_TREASURY}

${AUTHORIZE_CONVERSATION}

${RECORD}

${COGNITION_STATUS}

${DISPATCH}

${DASH_CALL}

-- ── 5. Routing ──
${EVENT_ROUTE}

-- The events the old P3_INFO class kept out of Fleet Command: copied in once, newest first, never twice.
CREATE FUNCTION fleet_command_feed_backfill_p3() RETURNS integer LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE n integer;
BEGIN
  INSERT INTO fleet_command_feed (event_id, priority, at, type, agent_id, actor, detail)
    SELECT id, 'P3_SUMMARY', created_at, event_type, agent_id, actor, detail FROM (
      SELECT * FROM fleet_events WHERE event_type IN (${q(P3_INFO_FIXED)}) ORDER BY created_at DESC LIMIT ${COMMAND_FEED_CAP}) e
    ON CONFLICT (event_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
SELECT fleet_command_feed_backfill_p3();

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
