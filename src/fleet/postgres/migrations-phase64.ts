/**
 * Schema v64 — autonomous agent spending with automated Fleet Control review (owner decision 2026-10-11:
 * "run it uncapped and see how much of the leash we need to tighten").
 *
 * The agent judges its own commitments. Fleet Control does not approve spending; it keeps payment integrity and steps in
 * only on credible evidence. Nothing here moves money: custody execution, the owner's activation and REAL_PAYMENTS stay
 * exactly as they are (initial owner activation and standing authority are preserved).
 *
 * 1. No caps, thresholds or routine owner approvals:
 *    - the card's owner gate (v54, £100) is retired: every properly funded card request is decided by Fleet Control;
 *    - the standing authority's card per-charge / daily maxima become optional (unset = no maximum);
 *    - a custody activation's maxima become optional (unset = no maximum); the activation itself stays the owner's key;
 *    - the per-agent wallet limits (v48) stay an owner-only lever, unset by default (the "leash", not a default).
 *    The spendable rule (an agent spends only its own available funds, never protected capital) is integrity, not a cap.
 * 2. Contextual flagging (`fleet_spend_review_assess`; cheap and deterministic; no model, no cost). A commitment is
 *    REVIEWED when it is material — its size against the agent's available funds, its aggregate with related open
 *    commitments (reserved orders, unspent card approvals, a month of recurring commitments), or the runway left
 *    afterwards — or suspicious: what looks like a duplicate charge, a payee registered moments ago, a payee flagged by
 *    Fleet Control. Everything else proceeds on payment-integrity checks alone. The review triggers are named signals
 *    with their evidence (never a score); their bounds live in `fleet_spend_review_policy`.
 * 3. Review before irreversible execution (`fleet_spend_reviews`): the funds are reserved atomically and the payment
 *    waits only for its review; the agent keeps working. The reviewer (controller-side, src/fleet/spend/review.ts) sees
 *    the evidence pack and the agent's stated case (untrusted text) and may HOLD only with a category — risk
 *    substantially outweighs the opportunity, fraud, an invalid payment, insufficient funds — and evidence. An uncertain,
 *    malformed or unsupported answer is recorded as APPROVED: uncertainty alone never blocks a calculated experiment.
 * 4. A held action: its reservation is released (the order is cancelled FLEET_SPEND_HELD; a card request is declined),
 *    the reason and evidence go to Fleet Command (P1) and the agent's conversation; the agent revises, resubmits or
 *    takes another route. The owner may approve a pending review, hold it, retry it, or allow a held one to be
 *    resubmitted once (7 days) — never manufacturing funds: a resubmission passes every integrity check again.
 * 5. Bounded reviewer handling: a failed or unavailable reviewer (provider error, tier unavailable, treasury unable to
 *    fund the call) retries with backoff up to max_attempts, then stays visibly PENDING and is flagged (P1) — never
 *    silently approved, never freezing the agent (only that action waits; other spending and work continue).
 * 6. Reviews are treasury-paid fleet overhead (ledger kind spend_review_charge: D fleet:expense / C fleet:treasury),
 *    accounted apart from agent operating costs; provider-credit consumption is recorded per call.
 * 7. Revalidation immediately before execution (`cx_claim_instruction`): the order is still executing for exactly the
 *    instructed amount and payee, the agent active / not held / not frozen, the payee active, the review cleared;
 *    otherwise the instruction fails and the reservation is released (FLEET_REVALIDATION_FAILED).
 */
import { V27_SQL } from "./migrations-phase27.js";
import { V32_SQL } from "./migrations-phase32.js";
import { V48_SQL } from "./migrations-phase48.js";
import { V51_SQL } from "./migrations-phase51.js";
import { V54_SQL } from "./migrations-phase54.js";
import { V58_SQL } from "./migrations-phase58.js";
import { V62_SQL } from "./migrations-phase62.js";
import { V63_SQL } from "./migrations-phase63.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

/** What a Fleet Control hold must name (anything else is not a hold). */
export const SPEND_HOLD_CATEGORIES = ["risk_outweighs_opportunity", "fraud", "invalid_payment", "insufficient_funds"] as const;
export const SPEND_REVIEW_KINDS = ["payment_order", "card_request"] as const;
export const EVENT_ROUTES_V64 = Object.freeze({
  P1_HIGH: ["spend_review_held", "spend_review_stalled", "spend_review_cost_unfunded", "payment_revalidation_failed"],
  P2_IMPORTANT: ["spend_review_overridden"],
  P3_SUMMARY: ["spend_review_opened"],
  AGENT_ACTIVITY_ONLY: ["spend_review_approved"],
});
export const DASHBOARD_READ_OPS_V64 = ["spend_reviews"] as const;
/** The owner's decision on a review moves money (or releases it): a fresh step-up, like every other money decision. */
export const DASHBOARD_SENSITIVE_OPS_V64 = ["spend_review_decide"] as const;
export const AGENT_SPEND_OPS_V64 = ["spend.reviews"] as const;

const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');`;
const WORKER = `IF p_worker IS NULL OR p_worker !~ '^[a-z0-9-]{3,40}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: worker name'; END IF;`;

// ── Own-capital orders: assess, reserve, and (when flagged) wait for the review ──
const SPEND_REQUEST = restate(V27_SQL, "api_spend_request", [
  [`        v_hash text; v_refusal text; v_signal text; v_rec bigint := COALESCE(p_recoverable_cents, 0);`,
   `        v_hash text; v_refusal text; v_signal text; v_rec bigint := COALESCE(p_recoverable_cents, 0); v_assess jsonb; v_review uuid;`],
  [`    RETURN jsonb_build_object('ok', o.status IN ('reserved','executing','settled'), 'replay', true, 'order', fleet_order_json(o))`,
   `    RETURN jsonb_build_object('ok', o.status IN ('reserved','executing','settled'), 'replay', true, 'order', fleet_order_json(o) || fleet_order_review_json(o))`],
  [`  o := fleet_order_reserve(o, 'controller', 'controller', 'controller', 'FLEET_CUSTODY_CLEARED', 'own capital, founder-sized; custody checks passed', NULL);
  RETURN jsonb_build_object('ok', true, 'order', fleet_order_json(o));`,
   `  -- v64: contextual flags (before the reservation, so "available" is what the agent had when it decided).
  v_assess := fleet_spend_review_assess(p_agent, 'payment_order', p_amount_cents, p_destination,
    (SELECT enrolled_at FROM fleet_payment_destinations WHERE destination_id = p_destination), true, o.order_id);
  PERFORM fleet_spend_review_use_override(v_assess);
  o := fleet_order_reserve(o, 'controller', 'controller', 'controller', 'FLEET_CUSTODY_CLEARED', 'own capital, founder-sized; custody checks passed', NULL);
  IF (v_assess ->> 'review')::boolean THEN
    v_review := fleet_spend_review_open('payment_order', o.order_id, p_agent, p_amount_cents, p_destination, v_assess,
      jsonb_build_object('purpose', o.purpose, 'category', o.category, 'destinationId', p_destination));
    UPDATE fleet_payment_orders SET review_status = 'pending', review_id = v_review WHERE order_id = o.order_id RETURNING * INTO o;
    RETURN jsonb_build_object('ok', true, 'order', fleet_order_json(o) || fleet_order_review_json(o),
      'note', 'reserved; Fleet Control is reviewing this commitment before it is paid (it is ' || (v_assess ->> 'summary') || '). Keep working: spend_reviews shows the outcome.');
  END IF;
  RETURN jsonb_build_object('ok', true, 'order', fleet_order_json(o) || fleet_order_review_json(o));`],
]);

const ISSUE_DUE = restate(V48_SQL, "svc_issue_due_instructions", [
  [`WHERE status = 'reserved' AND order_type = 'agent_spend' AND expires_at > now()`,
   `WHERE status = 'reserved' AND order_type = 'agent_spend' AND expires_at > now() AND review_status IN ('not_required','approved')`],
]);

const ISSUE = restate(V48_SQL, "svc_issue_payment_instruction", [
  [`  IF o.amount_cents > act.max_instruction_minor THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ACTIVATION_LIMIT'); END IF;`,
   `  -- v64: a payment flagged for review is issued only once Fleet Control (or the owner) cleared it.
  IF o.review_status NOT IN ('not_required','approved') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SPEND_REVIEW_PENDING'); END IF;
  -- v64: an activation's maxima are optional (unset = no maximum).
  IF act.max_instruction_minor IS NOT NULL AND o.amount_cents > act.max_instruction_minor THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ACTIVATION_LIMIT'); END IF;`],
  [`  IF v_day + o.amount_cents > act.max_daily_minor THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ACTIVATION_DAILY_LIMIT'); END IF;`,
   `  IF act.max_daily_minor IS NOT NULL AND v_day + o.amount_cents > act.max_daily_minor THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ACTIVATION_DAILY_LIMIT'); END IF;`],
]);

const CLAIM = restate(V32_SQL, "cx_claim_instruction", [
  [`DECLARE i fleet_payment_instructions; d fleet_payment_destinations; c fleet_credential_refs; v_ref text;`,
   `DECLARE i fleet_payment_instructions; d fleet_payment_destinations; c fleet_credential_refs; v_ref text; o fleet_payment_orders; v_bad text;`],
  [`  SELECT * INTO d FROM fleet_payment_destinations WHERE destination_id = i.destination_id;
  SELECT * INTO c FROM fleet_credential_refs WHERE credential_id = i.credential_id;`,
   `  -- v64: revalidate immediately before execution; a stale instruction fails and its reservation is released.
  SELECT * INTO o FROM fleet_payment_orders WHERE order_id = i.order_id FOR UPDATE;
  v_bad := fleet_execution_revalidate(i, o);
  IF v_bad IS NOT NULL THEN
    UPDATE fleet_payment_instructions SET status = 'failed', failure_code = v_bad, finished_at = now() WHERE instruction_id = i.instruction_id;
    PERFORM fleet_order_release(o, 'failed', 'controller', 'controller', 'FLEET_REVALIDATION_FAILED');
    PERFORM fleet_event('payment_revalidation_failed', o.agent_id, 'controller', jsonb_build_object('orderId', o.order_id, 'instructionId', i.instruction_id,
      'amountMinor', o.amount_cents, 'reason', v_bad, 'note', 'checked again just before payment and no longer valid: nothing was paid and the reservation was released'));
    RETURN jsonb_build_object('ok', true, 'instruction', NULL, 'revalidationFailed', v_bad);
  END IF;
  SELECT * INTO d FROM fleet_payment_destinations WHERE destination_id = i.destination_id;
  SELECT * INTO c FROM fleet_credential_refs WHERE credential_id = i.credential_id;`],
]);

const ACTIVATE = restate(V51_SQL, "fleet_admin_custody_activate", [
  [`  IF p_max_instruction IS NULL OR p_max_daily IS NULL OR p_max_instruction <= 0 OR p_max_daily < p_max_instruction THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: a positive per-instruction maximum and a daily maximum at least as large';
  END IF;`,
   `  -- v64: maxima are optional (unset = no maximum); when given they must be positive and consistent.
  IF (p_max_instruction IS NOT NULL AND p_max_instruction <= 0) OR (p_max_daily IS NOT NULL AND p_max_daily <= 0)
     OR (p_max_instruction IS NOT NULL AND p_max_daily IS NOT NULL AND p_max_daily < p_max_instruction) THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: a maximum, when set, is positive (and the daily one at least the per-payment one)';
  END IF;`],
]);

// ── Card requests: Fleet Control decides every properly funded request (the owner gate is retired) ──
const CARD_TAIL = `  SELECT * INTO p FROM fleet_card_request_policy WHERE id = 1;
  INSERT INTO fleet_card_requests (agent_id, account_id, origin, merchant, amount_minor, envelope_id, paypal_unavailable, purpose, status, decided_by, decided_at, expires_at)
    VALUES (p_agent, acc.account_id, v_origin, left(fleet_scrub(v_merchant), 120), v_amount, v_env, v_reason, v_purpose,
            CASE WHEN v_amount <= p.owner_review_above_minor THEN 'approved' ELSE 'pending_owner' END,
            CASE WHEN v_amount <= p.owner_review_above_minor THEN 'fleet_control' END,
            CASE WHEN v_amount <= p.owner_review_above_minor THEN now() END,
            now() + CASE WHEN v_amount <= p.owner_review_above_minor THEN p.valid_hours * interval '1 hour' ELSE interval '72 hours' END)
    RETURNING * INTO r;
  IF r.status = 'approved' THEN
    PERFORM fleet_event('card_request_approved', p_agent, 'fleet_control', jsonb_build_object('requestId', r.request_id, 'merchant', r.merchant, 'amountMinor', v_amount,
      'paypalUnavailable', v_reason));
    RETURN jsonb_build_object('ok', true, 'request', fleet_card_request_json(r),
      'note', 'approved by Fleet Control: open the hold with card_authorize {requestId, accountId, merchant, maxMinor ≤ the approved amount} before it expires');
  END IF;
  PERFORM fleet_event('card_request_owner_review', p_agent, 'fleet_control', jsonb_build_object('requestId', r.request_id, 'merchant', r.merchant, 'origin', v_origin,
    'amountMinor', v_amount, 'paypalUnavailable', v_reason, 'purpose', v_purpose,
    'note', 'above your card threshold: move the amount from the treasury to the card, then approve with the transfer reference — or decline'));
  RETURN jsonb_build_object('ok', true, 'request', fleet_card_request_json(r),
    'note', 'above the owner''s threshold: the owner decides (and funds the card first); check card_requests — keep working on other things meanwhile');`;
const CARD_REQUEST = restate(V54_SQL, "fleet_econ_card_request", [
  [`        v_env uuid; v_avail bigint;`, `        v_env uuid; v_avail bigint; v_assess jsonb; v_review uuid;`],
  [CARD_TAIL,
   `  SELECT * INTO p FROM fleet_card_request_policy WHERE id = 1;
  -- v64: no owner threshold. Contextual flags decide only whether Fleet Control reviews before the hold can open.
  v_assess := fleet_spend_review_assess(p_agent, 'card_request', v_amount, v_origin,
    (SELECT min(created_at) FROM fleet_card_requests WHERE agent_id = p_agent AND origin = v_origin), false, NULL);
  PERFORM fleet_spend_review_use_override(v_assess);
  INSERT INTO fleet_card_requests (agent_id, account_id, origin, merchant, amount_minor, envelope_id, paypal_unavailable, purpose, status, decided_by, decided_at, expires_at)
    VALUES (p_agent, acc.account_id, v_origin, left(fleet_scrub(v_merchant), 120), v_amount, v_env, v_reason, v_purpose,
            CASE WHEN (v_assess ->> 'review')::boolean THEN 'pending_review' ELSE 'approved' END,
            CASE WHEN (v_assess ->> 'review')::boolean THEN NULL ELSE 'fleet_control' END,
            CASE WHEN (v_assess ->> 'review')::boolean THEN NULL ELSE now() END,
            now() + p.valid_hours * interval '1 hour')
    RETURNING * INTO r;
  IF r.status = 'approved' THEN
    PERFORM fleet_event('card_request_approved', p_agent, 'fleet_control', jsonb_build_object('requestId', r.request_id, 'merchant', r.merchant, 'amountMinor', v_amount,
      'paypalUnavailable', v_reason));
    RETURN jsonb_build_object('ok', true, 'request', fleet_card_request_json(r),
      'note', 'approved by Fleet Control: open the hold with card_authorize {requestId, accountId, merchant, maxMinor ≤ the approved amount} before it expires');
  END IF;
  v_review := fleet_spend_review_open('card_request', r.request_id, p_agent, v_amount, v_origin, v_assess,
    jsonb_build_object('purpose', v_purpose, 'merchant', r.merchant, 'origin', v_origin, 'paypalUnavailable', v_reason));
  RETURN jsonb_build_object('ok', true, 'request', fleet_card_request_json(r), 'reviewId', v_review,
    'note', 'Fleet Control is reviewing this purchase before the hold can open (it is ' || (v_assess ->> 'summary') || '); keep working: card_requests or spend_reviews show the outcome');`],
]);
const CARD_REQUESTS = restate(V54_SQL, "fleet_econ_card_requests", [
  [`    'ownerReviewAboveMinor', (SELECT owner_review_above_minor FROM fleet_card_request_policy WHERE id = 1),\n`, ``],
]);
const CARD_GUARD = restate(V54_SQL, "fleet_card_requests_guard", [
  [`  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'pending_owner' AND NEW.status IN ('approved','declined','expired'))`,
   `  IF NEW.status <> OLD.status AND NOT ((OLD.status IN ('pending_owner','pending_review') AND NEW.status IN ('approved','declined','expired'))`],
]);
const CARD_EXPIRE = restate(V58_SQL, "svc_card_requests_expire", [
  [`WHERE status IN ('approved','pending_owner') AND expires_at <= now()`, `WHERE status IN ('approved','pending_owner','pending_review') AND expires_at <= now()`],
]);
const CARD_AUTHORIZE = restate(V54_SQL, "fleet_econ_card_authorize", [
  [`  IF rq.status IN ('approved','pending_owner') AND rq.expires_at <= now() THEN`, `  IF rq.status IN ('approved','pending_owner','pending_review') AND rq.expires_at <= now() THEN`],
]);

// ── Agents see their reviews; the attention signal wakes a hibernating agent on a decision ──
const ATTENTION = restate(V62_SQL, "fleet_agent_attention", [
  [`    'openTurn', (SELECT turn_id FROM fleet_conversation_turns WHERE agent_id = p_agent AND closed_at IS NULL))`,
   `    'openTurn', (SELECT turn_id FROM fleet_conversation_turns WHERE agent_id = p_agent AND closed_at IS NULL),
    'reviewsDigest', (SELECT md5(COALESCE(string_agg(review_id::text || ':' || status, ',' ORDER BY review_id), '')) FROM fleet_spend_reviews
                       WHERE agent_id = p_agent AND created_at > now() - interval '14 days'))`],
]);
const DISPATCH = restate(V62_SQL, "api_economy", [
  [`WHEN 'order.refund' THEN 'planning'`, `WHEN 'order.refund' THEN 'planning' ${AGENT_SPEND_OPS_V64.map((o) => `WHEN '${o}' THEN 'planning'`).join(" ")}`],
  [`      WHEN 'owner.inbox' THEN fleet_econ_owner_inbox(p_agent, a)`, `      WHEN 'spend.reviews' THEN fleet_econ_spend_reviews(p_agent, a)
      WHEN 'owner.inbox' THEN fleet_econ_owner_inbox(p_agent, a)`],
]);
const MESSAGES_GUARD = restate(V62_SQL, "fleet_agent_messages_guard", [
  [`  IF OLD.author = 'agent' THEN RAISE EXCEPTION 'FLEET_IMMUTABLE: an agent reply is history'; END IF;`,
   `  IF OLD.author IN ('agent','fleet_control') THEN RAISE EXCEPTION 'FLEET_IMMUTABLE: an agent reply or a Fleet Control notice is history'; END IF;`],
]);

// ── Owner dashboard ──
const DASH_CALL = restate(V63_SQL, "dash_call", [
  [`'order_refund');\n  v_write := v_sensitive OR p_op IN (`, `'order_refund',${q(DASHBOARD_SENSITIVE_OPS_V64)});\n  v_write := v_sensitive OR p_op IN (`],
  [`'customer_orders','paypal_disputes',`, `'customer_orders','paypal_disputes',${q(DASHBOARD_READ_OPS_V64)},`],
  [`      WHEN 'mail_summary' THEN fleet_admin_mail_summary()`, `      WHEN 'mail_summary' THEN fleet_admin_mail_summary()
      -- v64: Fleet Control spend reviews; the owner may approve / hold / retry a pending one or allow a held one to be resubmitted.
      WHEN 'spend_reviews' THEN fleet_admin_spend_reviews(a)
      WHEN 'spend_review_decide' THEN fleet_admin_spend_review_decide((a ->> 'reviewId')::uuid, a ->> 'decision', a ->> 'note', 'operator:owner')`],
]);
const EVENT_ROUTE = restate(V63_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V64) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);

const PAYEE_FLAGGED = `EXISTS (SELECT 1 FROM fleet_vendor_destinations v WHERE v.destination_id = p_payee AND v.trust = 'flagged')`;

export const V64_SQL = `
-- ═══ 1. Retire the caps (initial owner activation and standing authority stay) ═══
ALTER TABLE fleet_identity_autonomy DROP CONSTRAINT fleet_identity_autonomy_check;
ALTER TABLE fleet_identity_autonomy ADD CONSTRAINT fleet_identity_autonomy_card_max_order
  CHECK (card_max_charge_minor IS NULL OR card_max_daily_minor IS NULL OR card_max_daily_minor >= card_max_charge_minor);
COMMENT ON COLUMN fleet_identity_autonomy.card_max_charge_minor IS 'v64: optional (unset = no maximum); the owner''s leash, not a default';
COMMENT ON COLUMN fleet_identity_autonomy.card_max_daily_minor IS 'v64: optional (unset = no maximum); the owner''s leash, not a default';
ALTER TABLE fleet_custody_activations ALTER COLUMN max_instruction_minor DROP NOT NULL, ALTER COLUMN max_daily_minor DROP NOT NULL;
COMMENT ON COLUMN fleet_custody_activations.max_instruction_minor IS 'v64: optional (unset = no maximum)';
COMMENT ON COLUMN fleet_custody_activations.max_daily_minor IS 'v64: optional (unset = no maximum)';
COMMENT ON COLUMN fleet_card_request_policy.owner_review_above_minor IS 'LEGACY (retired at v64): no decision reads it; Fleet Control reviews contextually';
ALTER TABLE fleet_card_requests DROP CONSTRAINT fleet_card_requests_status_check;
ALTER TABLE fleet_card_requests ADD CONSTRAINT fleet_card_requests_status_check CHECK (status IN ('approved','pending_owner','pending_review','declined','used','expired'));
DROP INDEX fleet_card_requests_open;
CREATE INDEX fleet_card_requests_open ON fleet_card_requests (expires_at) WHERE status IN ('approved','pending_owner','pending_review');

-- ═══ 2. Review policy (the review triggers' bounds; not weights, not permissions) ═══
CREATE TABLE fleet_spend_review_policy (
  id                    integer     PRIMARY KEY CHECK (id = 1),
  material_share_bp     integer     NOT NULL DEFAULT 2500 CHECK (material_share_bp BETWEEN 1 AND 10000),
  material_aggregate_bp integer     NOT NULL DEFAULT 5000 CHECK (material_aggregate_bp BETWEEN 1 AND 100000),
  low_runway_days       integer     NOT NULL DEFAULT 14 CHECK (low_runway_days BETWEEN 0 AND 365),
  duplicate_window_h    integer     NOT NULL DEFAULT 24 CHECK (duplicate_window_h BETWEEN 1 AND 720),
  new_payee_hours       integer     NOT NULL DEFAULT 24 CHECK (new_payee_hours BETWEEN 0 AND 720),
  review_tier           text        NOT NULL DEFAULT 'T2' CHECK (review_tier IN ('T2','T3')),
  max_attempts          integer     NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  retry_base_s          integer     NOT NULL DEFAULT 60 CHECK (retry_base_s BETWEEN 5 AND 3600),
  estimate_usd_microcents bigint    NOT NULL DEFAULT 3000000 CHECK (estimate_usd_microcents > 0),
  override_days         integer     NOT NULL DEFAULT 7 CHECK (override_days BETWEEN 1 AND 30),
  updated_by            text        NOT NULL DEFAULT 'migration',
  updated_at            timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fleet_spend_review_policy (id) VALUES (1);
CREATE TRIGGER fleet_spend_review_policy_no_delete BEFORE DELETE ON fleet_spend_review_policy FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_spend_review_policy_no_truncate BEFORE TRUNCATE ON fleet_spend_review_policy FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ═══ 3. Reviews ═══
CREATE TABLE fleet_spend_reviews (
  review_id       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind    text        NOT NULL CHECK (subject_kind IN (${q(SPEND_REVIEW_KINDS)})),
  subject_id      uuid        NOT NULL,
  agent_id        text        NOT NULL REFERENCES fleet_agents(agent_id),
  amount_minor    bigint      NOT NULL CHECK (amount_minor > 0),
  payee_key       text        NOT NULL CHECK (length(payee_key) BETWEEN 1 AND 300),
  signals         jsonb       NOT NULL CHECK (jsonb_typeof(signals) = 'object'),
  request         jsonb       NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  status          text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','held','overridden','expired')),
  hold_category   text        CHECK (hold_category IN (${q(SPEND_HOLD_CATEGORIES)}, 'owner')),
  reason          text        CHECK (length(reason) <= 600),
  evidence        jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(evidence) = 'array'),
  decided_by      text,
  decided_at      timestamptz,
  attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  claimed_by      text,
  claimed_until   timestamptz,
  last_error      text        CHECK (length(last_error) <= 200),
  stalled_at      timestamptz,
  cost_usd_microcents bigint  NOT NULL DEFAULT 0 CHECK (cost_usd_microcents >= 0),
  override_until  timestamptz,
  override_used_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_kind, subject_id),
  CHECK ((status IN ('held','overridden')) = (hold_category IS NOT NULL)),
  CHECK ((status = 'overridden') = (override_until IS NOT NULL)),
  CHECK (status = 'pending' OR decided_at IS NOT NULL)
);
CREATE INDEX fleet_spend_reviews_due ON fleet_spend_reviews (next_attempt_at) WHERE status = 'pending';
CREATE INDEX fleet_spend_reviews_agent ON fleet_spend_reviews (agent_id, created_at DESC);
CREATE TRIGGER fleet_spend_reviews_no_delete BEFORE DELETE ON fleet_spend_reviews FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_spend_reviews_no_truncate BEFORE TRUNCATE ON fleet_spend_reviews FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE FUNCTION fleet_spend_reviews_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.review_id <> OLD.review_id OR NEW.subject_kind <> OLD.subject_kind OR NEW.subject_id <> OLD.subject_id OR NEW.agent_id <> OLD.agent_id
     OR NEW.amount_minor <> OLD.amount_minor OR NEW.payee_key <> OLD.payee_key OR NEW.signals <> OLD.signals OR NEW.request <> OLD.request
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a review''s subject and evidence are fixed';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'pending' AND NEW.status IN ('approved','held','expired'))
                                    OR (OLD.status = 'held' AND NEW.status = 'overridden')) THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: spend review % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status <> 'pending' AND NEW.status = OLD.status AND (NEW.reason IS DISTINCT FROM OLD.reason OR NEW.hold_category IS DISTINCT FROM OLD.hold_category
     OR NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.evidence <> OLD.evidence) THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a decided review is history';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_spend_reviews_guard BEFORE UPDATE ON fleet_spend_reviews FOR EACH ROW EXECUTE FUNCTION fleet_spend_reviews_guard();

ALTER TABLE fleet_payment_orders ADD COLUMN review_status text NOT NULL DEFAULT 'not_required'
  CHECK (review_status IN ('not_required','pending','approved','held','expired')), ADD COLUMN review_id uuid REFERENCES fleet_spend_reviews(review_id);

-- Unposted review cost (GBP microcents), posted to the ledger in whole minor units.
CREATE TABLE fleet_spend_review_accrual (
  id                  integer     PRIMARY KEY CHECK (id = 1),
  unposted_microcents bigint      NOT NULL DEFAULT 0 CHECK (unposted_microcents >= 0),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fleet_spend_review_accrual (id) VALUES (1);

INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance) VALUES
  ('spend_review_charge', false, ARRAY['controller'], false, 'Fleet Control spend review: AI assessment of a material or suspicious agent commitment, paid by the treasury (fleet overhead, never the agent)', 'expense');
INSERT INTO fleet_ledger_rules (kind, class, side) VALUES ('spend_review_charge','fleet_expense','D'), ('spend_review_charge','treasury_cash','C');

-- Conversation notices from Fleet Control (informational; never processed as an owner turn).
ALTER TABLE fleet_agent_messages DROP CONSTRAINT fleet_agent_messages_author_check;
ALTER TABLE fleet_agent_messages ADD CONSTRAINT fleet_agent_messages_author_check CHECK (author IN ('owner','agent','fleet_control'));
ALTER TABLE fleet_agent_messages DROP CONSTRAINT fleet_agent_messages_check;
ALTER TABLE fleet_agent_messages ADD CONSTRAINT fleet_agent_messages_delivered_check CHECK ((author IN ('agent','fleet_control')) = (status = 'delivered'));
${MESSAGES_GUARD}

-- ═══ 4. Contextual flags (deterministic; evidence, not a score) ═══
CREATE FUNCTION fleet_spend_review_assess(p_agent text, p_kind text, p_amount bigint, p_payee text, p_payee_since timestamptz, p_irreversible boolean,
  p_exclude uuid) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE pol fleet_spend_review_policy; e jsonb; rc jsonb; v_avail bigint; v_open bigint; v_monthly bigint; v_burn bigint; v_cash bigint;
        v_share integer; v_agg integer; v_runway integer; v_new boolean; v_dup boolean; v_flagged boolean := false; v_overridden uuid;
        sig jsonb := '[]'::jsonb; v_material boolean := false; v_suspicious boolean := false;
BEGIN
  SELECT * INTO pol FROM fleet_spend_review_policy WHERE id = 1;
  e := fleet_agent_economics(p_agent);
  rc := fleet_agent_risk_context(p_agent, p_amount);
  v_cash := COALESCE((e ->> 'cash')::bigint, 0);
  v_avail := GREATEST(0, LEAST(v_cash, COALESCE((e ->> 'survivalEquity')::bigint, 0)));
  v_monthly := COALESCE((rc ->> 'monthlyCommitmentsMinor')::bigint, 0);
  v_burn := COALESCE((rc ->> 'burn30dMinor')::bigint, 0);
  -- Related open commitments: reserved / executing own-capital orders and card approvals not yet used (excluding this one).
  SELECT COALESCE(sum(amount_cents), 0) INTO v_open FROM fleet_payment_orders
   WHERE agent_id = p_agent AND status IN ('reserved','executing') AND order_id IS DISTINCT FROM p_exclude;
  v_open := v_open + COALESCE((SELECT sum(amount_minor) FROM fleet_card_requests WHERE agent_id = p_agent AND status IN ('approved','pending_review')
                                 AND expires_at > now() AND request_id IS DISTINCT FROM p_exclude), 0);
  v_share := LEAST(1000000, p_amount * 10000 / GREATEST(v_avail, 1))::integer;
  v_agg := LEAST(1000000, (p_amount + v_open + v_monthly) * 10000 / GREATEST(v_avail + v_open, 1))::integer;
  v_runway := CASE WHEN v_monthly + v_burn > 0 THEN floor(GREATEST(v_cash - p_amount, 0) * 30.0 / (v_monthly + v_burn))::integer END;
  IF p_kind = 'payment_order' THEN
    v_new := NOT EXISTS (SELECT 1 FROM fleet_payment_orders WHERE agent_id = p_agent AND destination_id = p_payee AND status = 'settled');
    v_dup := EXISTS (SELECT 1 FROM fleet_payment_orders WHERE agent_id = p_agent AND destination_id = p_payee AND amount_cents = p_amount
                      AND status IN ('reserved','executing','settled') AND order_id IS DISTINCT FROM p_exclude
                      AND created_at > now() - make_interval(hours => pol.duplicate_window_h));
    v_flagged := ${PAYEE_FLAGGED};
  ELSE
    v_new := NOT EXISTS (SELECT 1 FROM fleet_card_requests WHERE agent_id = p_agent AND origin = p_payee AND status = 'used');
    v_dup := EXISTS (SELECT 1 FROM fleet_card_requests WHERE agent_id = p_agent AND origin = p_payee AND amount_minor = p_amount
                      AND status IN ('approved','pending_review','used') AND request_id IS DISTINCT FROM p_exclude
                      AND created_at > now() - make_interval(hours => pol.duplicate_window_h));
  END IF;
  -- Material exposure.
  IF v_share >= pol.material_share_bp THEN v_material := true;
    sig := sig || jsonb_build_object('signal', 'large_share_of_funds', 'evidence', format('%s%% of your available funds', round(v_share / 100.0)));
  END IF;
  IF v_open > 0 AND v_agg >= pol.material_aggregate_bp THEN v_material := true;
    sig := sig || jsonb_build_object('signal', 'aggregate_exposure', 'evidence', format('with %s already committed, %s%% of your funds would be tied up', fleet_money_text(v_open), round(v_agg / 100.0)));
  END IF;
  IF v_runway IS NOT NULL AND v_runway < pol.low_runway_days THEN v_material := true;
    sig := sig || jsonb_build_object('signal', 'low_runway_after', 'evidence', format('about %s days of runway left afterwards', v_runway));
  END IF;
  -- Suspicious.
  IF v_dup THEN v_suspicious := true;
    sig := sig || jsonb_build_object('signal', 'possible_duplicate', 'evidence', format('the same amount to the same payee within %s hours', pol.duplicate_window_h));
  END IF;
  IF v_flagged THEN v_suspicious := true;
    sig := sig || jsonb_build_object('signal', 'payee_flagged', 'evidence', 'Fleet Control has flagged this payee');
  END IF;
  IF v_new AND p_payee_since IS NOT NULL AND p_payee_since > now() - make_interval(hours => pol.new_payee_hours) AND v_share >= pol.material_share_bp / 5 THEN
    v_suspicious := true;
    sig := sig || jsonb_build_object('signal', 'brand_new_payee', 'evidence', format('first payment to a payee registered %s minutes ago', floor(extract(epoch FROM now() - p_payee_since) / 60)));
  END IF;
  -- An owner override of an earlier hold: one resubmission to the same payee, up to that amount, passes without review.
  IF v_material OR v_suspicious THEN
    SELECT review_id INTO v_overridden FROM fleet_spend_reviews WHERE agent_id = p_agent AND subject_kind = p_kind AND payee_key = p_payee
       AND status = 'overridden' AND override_until > now() AND override_used_at IS NULL AND amount_minor >= p_amount ORDER BY decided_at DESC LIMIT 1;
  END IF;
  RETURN jsonb_build_object('review', (v_material OR v_suspicious) AND v_overridden IS NULL, 'material', v_material, 'suspicious', v_suspicious,
    'overrideReviewId', v_overridden, 'signals', sig,
    'summary', CASE WHEN v_overridden IS NOT NULL THEN 'allowed by the owner after an earlier hold'
                    WHEN v_suspicious THEN 'flagged: ' || (SELECT string_agg(s ->> 'signal', ', ') FROM jsonb_array_elements(sig) s)
                    WHEN v_material THEN 'material: ' || (SELECT string_agg(s ->> 'signal', ', ') FROM jsonb_array_elements(sig) s) ELSE 'routine' END,
    'context', jsonb_strip_nulls(jsonb_build_object('amountMinor', p_amount, 'availableMinor', v_avail, 'cashMinor', v_cash, 'openCommitmentsMinor', v_open,
      'monthlyCommitmentsMinor', v_monthly, 'burn30dMinor', v_burn, 'shareBp', v_share, 'aggregateBp', v_agg, 'runwayDaysAfter', v_runway,
      'runwayDaysBefore', (rc ->> 'runwayDays')::integer, 'revenue60dMinor', (rc ->> 'revenue60dMinor')::bigint, 'expense60dMinor', (rc ->> 'expense60dMinor')::bigint,
      'agentAgeDays', (rc ->> 'ageDays')::numeric, 'vulnerable', (rc ->> 'vulnerable')::boolean, 'newPayee', v_new, 'irreversible', p_irreversible,
      'ventures', (SELECT jsonb_agg(jsonb_build_object('key', v.venture_key, 'state', v.state, 'model', v.business_model, 'since', v.created_at::date))
                     FROM fleet_ventures v WHERE v.agent_id = p_agent AND v.closed_at IS NULL),
      'currency', (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1))));
END $$;

-- Money in plain words for notices (accounting currency, minor units).
CREATE FUNCTION fleet_money_text(p_minor bigint) RETURNS text LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT CASE m.accounting_currency WHEN 'GBP' THEN '£' WHEN 'USD' THEN '$' WHEN 'EUR' THEN '€' ELSE m.accounting_currency || ' ' END
         || to_char(p_minor / 100.0, 'FM999999999990.00') FROM fleet_economic_model m WHERE m.id = 1
$$;

-- An owner override allows exactly one resubmission.
CREATE FUNCTION fleet_spend_review_use_override(p_assess jsonb) RETURNS void LANGUAGE sql
SET search_path = @@SCHEMA@@, pg_temp AS $$
  UPDATE fleet_spend_reviews SET override_used_at = now()
   WHERE review_id = (p_assess ->> 'overrideReviewId')::uuid AND status = 'overridden' AND override_used_at IS NULL
$$;

-- A Fleet Control notice in the agent's conversation (the owner sees it in the thread).
CREATE FUNCTION fleet_spend_review_notice(p_agent text, p_body text) RETURNS void LANGUAGE sql
SET search_path = @@SCHEMA@@, pg_temp AS $$
  INSERT INTO fleet_agent_messages (agent_id, author, body, status, created_by) VALUES (p_agent, 'fleet_control', left(p_body, 4000), 'delivered', 'fleet_control')
$$;

CREATE FUNCTION fleet_spend_review_open(p_kind text, p_subject uuid, p_agent text, p_amount bigint, p_payee text, p_assess jsonb, p_request jsonb)
RETURNS uuid LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO fleet_spend_reviews (subject_kind, subject_id, agent_id, amount_minor, payee_key, signals, request, next_attempt_at)
    VALUES (p_kind, p_subject, p_agent, p_amount, left(p_payee, 300), jsonb_build_object('summary', p_assess ->> 'summary', 'material', p_assess -> 'material',
              'suspicious', p_assess -> 'suspicious', 'signals', p_assess -> 'signals', 'context', p_assess -> 'context'),
            jsonb_strip_nulls(p_request), now())
    RETURNING review_id INTO v_id;
  PERFORM fleet_event('spend_review_opened', p_agent, 'fleet_control', jsonb_build_object('reviewId', v_id, 'kind', p_kind, 'amountMinor', p_amount,
    'summary', p_assess ->> 'summary'));
  RETURN v_id;
END $$;

-- The order / card-request side of a decision. Returns the reason an approval cannot be applied (the subject is gone), or NULL.
CREATE FUNCTION fleet_spend_review_apply(rv fleet_spend_reviews, p_approve boolean, p_actor text, p_note text) RETURNS text LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_payment_orders; r fleet_card_requests; e jsonb; v_avail bigint; pol fleet_card_request_policy;
BEGIN
  IF rv.subject_kind = 'payment_order' THEN
    SELECT * INTO o FROM fleet_payment_orders WHERE order_id = rv.subject_id FOR UPDATE;
    IF o.status <> 'reserved' OR o.expires_at <= now() THEN
      UPDATE fleet_payment_orders SET review_status = 'expired' WHERE order_id = o.order_id AND review_status = 'pending';
      RETURN 'the order is no longer reserved (' || o.status || ')';
    END IF;
    IF p_approve THEN
      UPDATE fleet_payment_orders SET review_status = 'approved' WHERE order_id = o.order_id;
    ELSE
      UPDATE fleet_payment_orders SET review_status = 'held' WHERE order_id = o.order_id RETURNING * INTO o;
      PERFORM fleet_order_release(o, 'cancelled', left(p_actor, 128), 'controller', 'FLEET_SPEND_HELD');
    END IF;
  ELSE
    SELECT * INTO r FROM fleet_card_requests WHERE request_id = rv.subject_id FOR UPDATE;
    IF r.status <> 'pending_review' OR r.expires_at <= now() THEN RETURN 'the card request is no longer waiting (' || r.status || ')'; END IF;
    IF p_approve THEN
      -- Integrity again: the agent's own funds (or the envelope) still cover the whole amount.
      IF r.envelope_id IS NULL THEN
        e := fleet_agent_economics(r.agent_id);
        v_avail := GREATEST(0, LEAST((e ->> 'cash')::bigint, (e ->> 'survivalEquity')::bigint));
        IF r.amount_minor > v_avail THEN
          UPDATE fleet_card_requests SET status = 'declined', decided_by = 'fleet_control', decided_at = now(),
                 decision_note = 'insufficient funds when the review finished' WHERE request_id = r.request_id;
          RETURN 'insufficient funds';
        END IF;
      END IF;
      SELECT * INTO pol FROM fleet_card_request_policy WHERE id = 1;
      UPDATE fleet_card_requests SET status = 'approved', decided_by = CASE WHEN p_actor LIKE 'operator:%' THEN p_actor ELSE 'fleet_control' END,
             decided_at = now(), decision_note = left(p_note, 300), expires_at = now() + pol.valid_hours * interval '1 hour' WHERE request_id = r.request_id;
    ELSE
      UPDATE fleet_card_requests SET status = 'declined', decided_by = CASE WHEN p_actor LIKE 'operator:%' THEN p_actor ELSE 'fleet_control' END,
             decided_at = now(), decision_note = left(p_note, 300) WHERE request_id = r.request_id;
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- Decide a pending review (Fleet Control's reviewer or the owner). A hold needs a category, a reason and evidence.
CREATE FUNCTION fleet_spend_review_decide_internal(p_review uuid, p_approve boolean, p_category text, p_reason text, p_evidence jsonb, p_actor text)
RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE rv fleet_spend_reviews; v_gone text; v_what text;
BEGIN
  SELECT * INTO rv FROM fleet_spend_reviews WHERE review_id = p_review FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF rv.status <> 'pending' THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'status', rv.status); END IF;
  v_gone := fleet_spend_review_apply(rv, p_approve, p_actor, p_reason);
  v_what := CASE rv.subject_kind WHEN 'payment_order' THEN 'payment' ELSE 'card purchase' END;
  IF v_gone IS NOT NULL THEN
    UPDATE fleet_spend_reviews SET status = 'expired', decided_by = p_actor, decided_at = now(), reason = left('not applied: ' || v_gone, 600),
           claimed_by = NULL, claimed_until = NULL WHERE review_id = rv.review_id;
    RETURN jsonb_build_object('ok', true, 'status', 'expired', 'reason', v_gone);
  END IF;
  UPDATE fleet_spend_reviews SET status = CASE WHEN p_approve THEN 'approved' ELSE 'held' END, hold_category = CASE WHEN p_approve THEN NULL ELSE p_category END,
         reason = left(p_reason, 600), evidence = COALESCE(p_evidence, '[]'::jsonb), decided_by = p_actor, decided_at = now(),
         claimed_by = NULL, claimed_until = NULL, next_attempt_at = NULL WHERE review_id = rv.review_id RETURNING * INTO rv;
  IF p_approve THEN
    PERFORM fleet_event('spend_review_approved', rv.agent_id, left(p_actor, 128), jsonb_build_object('reviewId', rv.review_id, 'kind', rv.subject_kind,
      'amountMinor', rv.amount_minor, 'reason', rv.reason));
    PERFORM fleet_spend_review_notice(rv.agent_id, format('Fleet Control reviewed your %s of %s (%s) and cleared it: %s', v_what, fleet_money_text(rv.amount_minor),
      rv.signals ->> 'summary', COALESCE(rv.reason, 'no grounds to hold')));
  ELSE
    PERFORM fleet_event('spend_review_held', rv.agent_id, left(p_actor, 128), jsonb_build_object('reviewId', rv.review_id, 'kind', rv.subject_kind,
      'amountMinor', rv.amount_minor, 'category', rv.hold_category, 'reason', rv.reason, 'evidence', rv.evidence,
      'note', 'only this action is held; its funds were released and the agent can revise, resubmit or take another route'));
    PERFORM fleet_spend_review_notice(rv.agent_id, format('Fleet Control held your %s of %s (%s): %s. Evidence: %s. Nothing was paid and the funds are free again; revise it, resubmit with what answers this, or take another route — your other work is not affected.',
      v_what, fleet_money_text(rv.amount_minor), replace(rv.hold_category, '_', ' '), rv.reason,
      COALESCE((SELECT string_agg(x #>> '{}', '; ') FROM jsonb_array_elements(rv.evidence) x), 'see the review')));
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', rv.status, 'reviewId', rv.review_id);
END $$;

-- ═══ 5. The controller's reviewer (service role) ═══
CREATE FUNCTION svc_spend_reviews_claim(p_limit integer, p_worker text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE pol fleet_spend_review_policy; rv fleet_spend_reviews; jobs jsonb := '[]'::jsonb; v_est bigint; v_rate bigint; v_avail bigint;
BEGIN
  ${WORKER}
  SELECT * INTO pol FROM fleet_spend_review_policy WHERE id = 1;
  -- Expire reviews whose subject is gone (an expired reservation, an expired card request).
  FOR rv IN SELECT * FROM fleet_spend_reviews WHERE status = 'pending' ORDER BY created_at LIMIT 200 FOR UPDATE SKIP LOCKED LOOP
    IF (rv.subject_kind = 'payment_order' AND NOT EXISTS (SELECT 1 FROM fleet_payment_orders WHERE order_id = rv.subject_id AND status = 'reserved' AND expires_at > now()))
       OR (rv.subject_kind = 'card_request' AND NOT EXISTS (SELECT 1 FROM fleet_card_requests WHERE request_id = rv.subject_id AND status = 'pending_review' AND expires_at > now())) THEN
      PERFORM fleet_spend_review_decide_internal(rv.review_id, true, NULL, 'the action expired before its review finished', '[]'::jsonb, 'fleet_control');
    END IF;
  END LOOP;
  SELECT rate_micro INTO v_rate FROM fleet_fx_rates WHERE base = 'USD' AND quote = (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1)
   ORDER BY observed_on DESC, rate_id DESC LIMIT 1;
  v_est := CEIL(pol.estimate_usd_microcents::numeric * COALESCE(v_rate, 1000000) / 1000000 / 1000000)::bigint;
  v_avail := fleet_ledger_balance('fleet:treasury:unallocated');
  FOR rv IN SELECT * FROM fleet_spend_reviews WHERE status = 'pending' AND stalled_at IS NULL AND next_attempt_at <= now()
               AND (claimed_until IS NULL OR claimed_until < now()) ORDER BY next_attempt_at LIMIT LEAST(GREATEST(COALESCE(p_limit, 5), 1), 20)
               FOR UPDATE SKIP LOCKED LOOP
    IF v_avail < v_est THEN
      -- The treasury cannot pay for the review: never approve silently; retry later, bounded.
      PERFORM fleet_spend_review_failed_internal(rv, 'FLEET_TREASURY_INSUFFICIENT: the treasury cannot fund the review call', pol);
      CONTINUE;
    END IF;
    UPDATE fleet_spend_reviews SET attempts = attempts + 1, claimed_by = p_worker, claimed_until = now() + interval '5 minutes' WHERE review_id = rv.review_id
      RETURNING * INTO rv;
    jobs := jobs || jsonb_build_object('reviewId', rv.review_id, 'kind', rv.subject_kind, 'agentId', rv.agent_id, 'amountMinor', rv.amount_minor,
      'payee', rv.payee_key, 'signals', rv.signals, 'request', rv.request, 'attempt', rv.attempts,
      'payeeDetails', CASE WHEN rv.subject_kind = 'payment_order' THEN (SELECT jsonb_strip_nulls(jsonb_build_object('vendorName', v.vendor_name, 'category', v.category,
                        'website', v.website, 'provider', v.provider, 'trust', v.trust, 'registeredAt', v.registered_at)) FROM fleet_vendor_destinations v WHERE v.destination_id = rv.payee_key) END,
      'history', jsonb_build_object('settledToPayee', (SELECT count(*) FROM fleet_payment_orders WHERE agent_id = rv.agent_id AND destination_id = rv.payee_key AND status = 'settled'),
        'reviews14d', (SELECT count(*) FROM fleet_spend_reviews WHERE agent_id = rv.agent_id AND created_at > now() - interval '14 days'),
        'held14d', (SELECT count(*) FROM fleet_spend_reviews WHERE agent_id = rv.agent_id AND status = 'held' AND created_at > now() - interval '14 days')));
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'reviewTier', pol.review_tier, 'jobs', jobs, 'holdCategories', to_jsonb(ARRAY[${q(SPEND_HOLD_CATEGORIES)}]),
    'tiers', (SELECT COALESCE(jsonb_agg(jsonb_build_object('tier', t.tier, 'provider', t.provider, 'model', t.model, 'thinking', t.thinking,
                'effort', t.effort, 'maxOutputTokens', t.max_output_tokens, 'enabled', t.enabled, 'verifiedAt', t.verified_at, 'promptCache', 'off',
                'prices', jsonb_build_object('inputMicrocentsPerToken', t.input_microcents_per_token, 'outputMicrocentsPerToken', t.output_microcents_per_token,
                  'cacheWriteMicrocentsPerToken', t.cache_write_microcents_per_token, 'cacheReadMicrocentsPerToken', t.cache_read_microcents_per_token))
                ORDER BY t.tier), '[]'::jsonb) FROM fleet_cognition_tiers t));
END $$;

-- Cost of the reviewer's calls: provider-credit consumption per call, and the treasury's ledger charge (fleet overhead).
CREATE FUNCTION fleet_spend_review_charge(p_review uuid, p_calls jsonb) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c jsonb; v_usd bigint := 0; v_rate bigint; v_micro bigint; v_unposted bigint; v_total bigint; v_charge bigint; v_avail bigint; v_unfunded bigint;
BEGIN
  FOR c IN SELECT * FROM jsonb_array_elements(COALESCE(p_calls, '[]'::jsonb)) LOOP
    IF COALESCE((c ->> 'usdMicrocents')::bigint, 0) > 0 AND (c ->> 'requestId') ~ '^[0-9a-f-]{36}$' THEN
      INSERT INTO fleet_provider_credit_events (provider, kind, usd_microcents, request_id, recorded_by)
        VALUES (c ->> 'provider', 'consumption', -(c ->> 'usdMicrocents')::bigint, (c ->> 'requestId')::uuid, 'controller:spend_review')
        ON CONFLICT (request_id) DO NOTHING;
      IF FOUND THEN v_usd := v_usd + (c ->> 'usdMicrocents')::bigint; END IF;
    END IF;
  END LOOP;
  IF v_usd = 0 THEN RETURN; END IF;
  UPDATE fleet_spend_reviews SET cost_usd_microcents = cost_usd_microcents + v_usd WHERE review_id = p_review;
  SELECT rate_micro INTO v_rate FROM fleet_fx_rates WHERE base = 'USD' AND quote = (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1)
   ORDER BY observed_on DESC, rate_id DESC LIMIT 1;
  v_micro := CEIL(v_usd::numeric * COALESCE(v_rate, 1000000) / 1000000)::bigint;
  SELECT unposted_microcents INTO v_unposted FROM fleet_spend_review_accrual WHERE id = 1 FOR UPDATE;
  v_total := v_unposted + v_micro;
  v_charge := v_total / 1000000;
  v_avail := GREATEST(fleet_ledger_balance('fleet:treasury:unallocated'), 0);
  v_unfunded := GREATEST(v_charge - v_avail, 0);
  v_charge := v_charge - v_unfunded;
  IF v_charge > 0 THEN
    PERFORM fleet_ledger_post('spend_review_charge', 'review:' || p_review || ':' || md5(p_calls::text), 'controller', 'Fleet Control spend review (AI assessment)',
      'controller', NULL, NULL, NULL, NULL, NULL, now(), jsonb_build_array(
        jsonb_build_object('account', 'fleet:expense', 'side', 'D', 'amount', v_charge),
        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', v_charge)));
  END IF;
  UPDATE fleet_spend_review_accrual SET unposted_microcents = v_total - (v_charge + v_unfunded) * 1000000, updated_at = now() WHERE id = 1;
  IF v_unfunded > 0 THEN
    PERFORM fleet_event('spend_review_cost_unfunded', NULL, 'controller', jsonb_build_object('reviewId', p_review, 'unfundedMinor', v_unfunded,
      'note', 'the treasury could not cover a spend review in full; the shortfall is recorded, never charged to the agent'));
  END IF;
END $$;

-- A failed attempt: bounded retries with backoff, then visibly stalled (still pending; never approved by default).
CREATE FUNCTION fleet_spend_review_failed_internal(rv fleet_spend_reviews, p_error text, pol fleet_spend_review_policy) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_attempts integer := rv.attempts + CASE WHEN rv.claimed_by IS NULL THEN 1 ELSE 0 END;
BEGIN
  IF v_attempts >= pol.max_attempts THEN
    UPDATE fleet_spend_reviews SET attempts = v_attempts, last_error = left(p_error, 200), claimed_by = NULL, claimed_until = NULL, next_attempt_at = NULL,
           stalled_at = now() WHERE review_id = rv.review_id;
    PERFORM fleet_event('spend_review_stalled', rv.agent_id, 'fleet_control', jsonb_build_object('reviewId', rv.review_id, 'kind', rv.subject_kind,
      'amountMinor', rv.amount_minor, 'attempts', v_attempts, 'error', left(p_error, 200),
      'note', 'the review could not run; this one action stays pending (the agent keeps working). Approve, hold or retry it from Fleet Command.'));
  ELSE
    UPDATE fleet_spend_reviews SET attempts = v_attempts, last_error = left(p_error, 200), claimed_by = NULL, claimed_until = NULL,
           next_attempt_at = now() + make_interval(secs => pol.retry_base_s * power(2, LEAST(v_attempts, 10))) WHERE review_id = rv.review_id;
  END IF;
END $$;

CREATE FUNCTION svc_spend_review_failed(p_review uuid, p_worker text, p_error text, p_calls jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE rv fleet_spend_reviews; pol fleet_spend_review_policy;
BEGIN
  ${WORKER}
  SELECT * INTO rv FROM fleet_spend_reviews WHERE review_id = p_review FOR UPDATE;
  IF NOT FOUND OR rv.status <> 'pending' OR rv.claimed_by IS DISTINCT FROM p_worker THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_CLAIMED'); END IF;
  SELECT * INTO pol FROM fleet_spend_review_policy WHERE id = 1;
  PERFORM fleet_spend_review_charge(p_review, p_calls);
  PERFORM fleet_spend_review_failed_internal(rv, COALESCE(p_error, 'reviewer error'), pol);
  RETURN jsonb_build_object('ok', true);
END $$;

-- The reviewer's answer. A hold must name an allowed category, a reason and at least one piece of evidence; anything less
-- is recorded as an approval (uncertainty is not grounds to block).
CREATE FUNCTION svc_spend_review_record(p_review uuid, p_worker text, p_result jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE rv fleet_spend_reviews; v_hold boolean; v_cat text := p_result ->> 'category'; v_reason text := left(trim(COALESCE(p_result ->> 'reason', '')), 600);
        v_ev jsonb := CASE WHEN jsonb_typeof(p_result -> 'evidence') = 'array' THEN p_result -> 'evidence' ELSE '[]'::jsonb END;
BEGIN
  ${WORKER}
  SELECT * INTO rv FROM fleet_spend_reviews WHERE review_id = p_review FOR UPDATE;
  IF NOT FOUND OR rv.claimed_by IS DISTINCT FROM p_worker THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_CLAIMED'); END IF;
  PERFORM fleet_spend_review_charge(p_review, p_result -> 'calls');
  IF rv.status <> 'pending' THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'status', rv.status); END IF;
  v_ev := (SELECT COALESCE(jsonb_agg(to_jsonb(left(x #>> '{}', 300))), '[]'::jsonb) FROM (SELECT x FROM jsonb_array_elements(v_ev) x LIMIT 8) s);
  v_hold := p_result ->> 'decision' = 'hold' AND v_cat IN (${q(SPEND_HOLD_CATEGORIES)}) AND length(v_reason) >= 10 AND jsonb_array_length(v_ev) >= 1;
  IF p_result ->> 'decision' = 'hold' AND NOT v_hold THEN
    v_reason := 'cleared: the review raised concerns without a stated category and evidence, and uncertainty alone is not grounds to hold'
      || CASE WHEN v_reason <> '' THEN ' (' || left(v_reason, 300) || ')' ELSE '' END;
  ELSIF NOT v_hold AND v_reason = '' THEN
    v_reason := 'no credible evidence that the risk substantially outweighs the opportunity';
  END IF;
  RETURN fleet_spend_review_decide_internal(p_review, NOT v_hold, CASE WHEN v_hold THEN v_cat END, v_reason, CASE WHEN v_hold THEN v_ev ELSE '[]'::jsonb END, 'fleet_control');
END $$;

-- ═══ 6. Owner: see reviews; approve / hold / retry a pending one; allow a held one to be resubmitted ═══
CREATE FUNCTION fleet_spend_review_json(rv fleet_spend_reviews) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('reviewId', rv.review_id, 'kind', rv.subject_kind, 'subjectId', rv.subject_id, 'agentId', rv.agent_id,
    'amountMinor', rv.amount_minor, 'payee', rv.payee_key, 'signals', rv.signals, 'request', rv.request, 'status', rv.status,
    'holdCategory', rv.hold_category, 'reason', rv.reason, 'evidence', rv.evidence, 'decidedBy', rv.decided_by, 'decidedAt', rv.decided_at,
    'attempts', rv.attempts, 'lastError', rv.last_error, 'stalled', rv.stalled_at IS NOT NULL, 'overrideUntil', rv.override_until,
    'overrideUsed', rv.override_used_at IS NOT NULL, 'costUsdMicrocents', rv.cost_usd_microcents, 'createdAt', rv.created_at))
$$;

CREATE FUNCTION fleet_admin_spend_reviews(a jsonb) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('policy', (SELECT to_jsonb(p) - 'id' FROM fleet_spend_review_policy p WHERE p.id = 1),
    'pending', (SELECT count(*) FROM fleet_spend_reviews WHERE status = 'pending'),
    'stalled', (SELECT count(*) FROM fleet_spend_reviews WHERE status = 'pending' AND stalled_at IS NOT NULL),
    'reviews', COALESCE((SELECT jsonb_agg(fleet_spend_review_json(r) ORDER BY r.created_at DESC) FROM (
       SELECT * FROM fleet_spend_reviews WHERE (a ->> 'agentId' IS NULL OR agent_id = a ->> 'agentId')
          AND (a ->> 'status' IS NULL OR status = a ->> 'status') ORDER BY created_at DESC LIMIT LEAST(GREATEST(COALESCE((a ->> 'limit')::integer, 50), 1), 200)) r), '[]'::jsonb))
$$;

CREATE FUNCTION fleet_admin_spend_review_decide(p_review uuid, p_decision text, p_note text, p_actor text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE rv fleet_spend_reviews; pol fleet_spend_review_policy; v_note text := left(trim(COALESCE(p_note, '')), 600);
BEGIN
  ${OWNER_ACTOR}
  SELECT * INTO rv FROM fleet_spend_reviews WHERE review_id = p_review FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such review'; END IF;
  SELECT * INTO pol FROM fleet_spend_review_policy WHERE id = 1;
  IF p_decision = 'retry' AND rv.status = 'pending' THEN
    UPDATE fleet_spend_reviews SET attempts = 0, stalled_at = NULL, last_error = NULL, next_attempt_at = now(), claimed_by = NULL, claimed_until = NULL
     WHERE review_id = rv.review_id;
    RETURN jsonb_build_object('ok', true, 'status', 'pending', 'note', 'the review runs again now');
  ELSIF p_decision IN ('approve','hold') AND rv.status = 'pending' THEN
    RETURN fleet_spend_review_decide_internal(rv.review_id, p_decision = 'approve', CASE WHEN p_decision = 'hold' THEN 'owner' END,
      COALESCE(NULLIF(v_note, ''), CASE WHEN p_decision = 'approve' THEN 'approved by the owner' ELSE 'held by the owner' END),
      CASE WHEN p_decision = 'hold' THEN jsonb_build_array(COALESCE(NULLIF(v_note, ''), 'owner decision')) ELSE '[]'::jsonb END, p_actor);
  ELSIF p_decision = 'approve' AND rv.status = 'held' THEN
    -- The owner allows a resubmission: no funds are created and every integrity check runs again on it.
    UPDATE fleet_spend_reviews SET status = 'overridden', override_until = now() + make_interval(days => pol.override_days) WHERE review_id = rv.review_id;
    PERFORM fleet_event('spend_review_overridden', rv.agent_id, p_actor, jsonb_build_object('reviewId', rv.review_id, 'kind', rv.subject_kind, 'amountMinor', rv.amount_minor,
      'note', COALESCE(NULLIF(v_note, ''), 'the owner allows this to be resubmitted')));
    PERFORM fleet_spend_review_notice(rv.agent_id, format('The owner reviewed Fleet Control''s hold on your %s of %s and allows you to resubmit it (once, within %s days, up to that amount). %s',
      CASE rv.subject_kind WHEN 'payment_order' THEN 'payment' ELSE 'card purchase' END, fleet_money_text(rv.amount_minor), pol.override_days, v_note));
    RETURN jsonb_build_object('ok', true, 'status', 'overridden');
  END IF;
  RAISE EXCEPTION 'FLEET_BAD_REQUEST: decision is approve|hold|retry for a pending review, or approve for a held one (this review is %)', rv.status;
END $$;

-- ═══ 7. Agents: their own reviews ═══
CREATE FUNCTION fleet_econ_spend_reviews(p_agent text, a jsonb) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'reviews', COALESCE((SELECT jsonb_agg(fleet_spend_review_json(r) - 'costUsdMicrocents' - 'attempts' - 'lastError' ORDER BY r.created_at DESC)
    FROM (SELECT * FROM fleet_spend_reviews WHERE agent_id = p_agent ORDER BY created_at DESC LIMIT 30) r), '[]'::jsonb),
    'note', 'Fleet Control reviews only material or suspicious commitments and holds only on credible evidence; a held action''s funds are released — revise, resubmit or take another route')
$$;

CREATE FUNCTION fleet_order_review_json(o fleet_payment_orders) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('reviewStatus', o.review_status, 'reviewId', o.review_id))
$$;

-- ═══ 8. Revalidation immediately before execution ═══
CREATE FUNCTION fleet_execution_revalidate(i fleet_payment_instructions, o fleet_payment_orders) RETURNS text LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE ag fleet_agents; d fleet_payment_destinations;
BEGIN
  IF o.order_id IS NULL OR o.status <> 'executing' THEN RETURN 'order not executing'; END IF;
  IF o.amount_cents <> i.amount_cents OR o.destination_id <> i.destination_id THEN RETURN 'instruction does not match its order'; END IF;
  SELECT * INTO d FROM fleet_payment_destinations WHERE destination_id = i.destination_id;
  IF d.status <> 'active' THEN RETURN 'payee no longer active'; END IF;
  IF o.order_type = 'agent_spend' THEN
    IF o.review_status NOT IN ('not_required','approved') THEN RETURN 'review not cleared'; END IF;
    SELECT * INTO ag FROM fleet_agents WHERE agent_id = o.agent_id;
    IF ag.status <> 'active' THEN RETURN 'agent not active'; END IF;
    IF ag.operator_hold_at IS NOT NULL THEN RETURN 'agent held'; END IF;
    IF EXISTS (SELECT 1 FROM fleet_wallet_custody w WHERE w.agent_id = o.agent_id AND w.spending_frozen) THEN RETURN 'agent spending frozen'; END IF;
  END IF;
  RETURN NULL;
END $$;

-- ═══ 9. Restatements ═══
${SPEND_REQUEST}

${ISSUE_DUE}

${ISSUE}

${CLAIM}

${ACTIVATE}

${CARD_REQUEST}

${CARD_REQUESTS}

${CARD_GUARD}

${CARD_EXPIRE}

${CARD_AUTHORIZE}

${ATTENTION}

${DISPATCH}

${DASH_CALL}

${EVENT_ROUTE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
