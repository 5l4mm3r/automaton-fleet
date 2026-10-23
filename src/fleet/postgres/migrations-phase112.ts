/**
 * Schema v112 — local inference only (owner directive, 2026-10-23: "Make Automaton Fleet a self-contained, portable machine
 * with a locally running AI model … Routine reasoning … must not consume third-party AI API credit. There must be no
 * automatic cloud fallback.")
 *
 *  - The registry's INFERENCE PROFILE (one row): local_only (the default, for new and existing registries) or cloud_allowed
 *    (the owner's explicit choice, recorded with a reason). Under local_only a tier or the global policy cannot be enabled
 *    for any provider but the local one — checked by trigger, so no code path (routing, Fleet Control review, relevance
 *    scoring, an owner conversation) can authorise a cloud call. Existing cloud tiers are disabled by this migration.
 *  - A tier can be mapped to the LOCAL model (provider local): zero provider prices — a local call is no provider invoice
 *    and draws no AI-credit lot (consumption is drawn only when negative, v70). The prices stay exactly as before for the
 *    historical cloud records (nothing here rewrites a past charge).
 *  - Local compute is NOT called free: the profile records the owner's local-compute policy, "unpriced" until the owner
 *    chooses one; the controller's log keeps each local call's tokens and latency for resource metering.
 */
import { restate as restateRaw } from "./migrations-phase42.js";
import { V111_SQL } from "./migrations-phase111.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const CREDIT_HELD = `  -- v111: less what open engineering holds have set aside (a scenario run spends the same credit before its import).
  v_credits := fleet_provider_credit_balance(s ->> 'provider') - fleet_provider_credit_held(s ->> 'provider');`;
// A LOCAL model call is no provider invoice: no provider credit is drawn or needed (its resource use is metered by the
// controller's log). Every other check stays: the founder's daily budget, its cash and protected capital, one live call.
const CREDIT_LOCAL = `  -- v112: a local model call needs no provider credit (no invoice); cloud providers keep v111's rule.
  IF s ->> 'provider' = 'local' THEN v_credits := 4611686018427387903;
  ELSE v_credits := fleet_provider_credit_balance(s ->> 'provider') - fleet_provider_credit_held(s ->> 'provider');
  END IF;`;
const AUTHORIZE = restate(V111_SQL, "svc_cognition_authorize", [[CREDIT_HELD, CREDIT_LOCAL]]);
// 2026-10-23 (the first real local-model run: a PAID order with no buyer message was in no packet — an obligation existed only
// once the buyer wrote; a cloud model found the order by checking, a smaller model never did): a paid order that still
// awaits its delivery (to_fulfil, or a failed delivery) is an obligation too, state to_deliver, at the top with the
// unanswered ones. It never blocks a sleep (owner: no new blocks); it is shown until the order is delivered or fulfilled.
// Review 2026-10-23: "delivery obligations must derive from paid/undelivered status, regardless of whether the buyer has sent
// messages" — every order obligation carries deliveryOwed from the order's own status; a buyer's message changes the
// conversation state (unanswered / acknowledged), never whether the delivery is owed.
const PAID_OB = [
  [`  ob AS (SELECT * FROM order_ob UNION ALL SELECT * FROM enquiry_ob)`,
   `  paid_ob AS (
    SELECT 'order' AS kind, o.order_id::text AS id, o.created_at AS since, o.created_at AS last_buyer, 0::bigint AS messages,
           NULL::timestamptz AS replied, EXISTS (SELECT 1 FROM fleet_order_deliveries d WHERE d.order_id = o.order_id AND d.status = 'queued') AS delivering
      FROM fleet_customer_orders o
     WHERE o.agent_id = p_agent AND o.payment_status = 'paid' AND o.status IN ('to_fulfil','delivery_failed')
       AND NOT EXISTS (SELECT 1 FROM order_ob x WHERE x.id = o.order_id::text)),
  ob AS (SELECT u.*, (u.kind = 'order' AND EXISTS (SELECT 1 FROM fleet_customer_orders o WHERE o.order_id::text = u.id AND o.agent_id = p_agent
                 AND o.payment_status = 'paid' AND o.status IN ('to_fulfil','delivery_failed'))) AS owed
          FROM (SELECT * FROM order_ob UNION ALL SELECT * FROM enquiry_ob UNION ALL SELECT * FROM paid_ob) u)`],
  [`'state', CASE WHEN replied IS NULL OR replied < last_buyer THEN 'unanswered' ELSE 'acknowledged' END,`,
   `'state', CASE WHEN messages = 0 THEN 'to_deliver' WHEN replied IS NULL OR replied < last_buyer THEN 'unanswered' ELSE 'acknowledged' END,
           'deliveryOwed', CASE WHEN owed THEN true END,`],
] as Array<[string, string]>;
const OBLIGATIONS = restate(V111_SQL, "fleet_customer_obligations", PAID_OB);
const OBLIGATIONS_ALL = restate(V111_SQL, "fleet_customer_obligations_all", PAID_OB);
const AUTHORIZE_TREASURY = restate(V111_SQL, "fleet_cognition_authorize_treasury", [[CREDIT_HELD, CREDIT_LOCAL]]);

export const V112_SQL = String.raw`
ALTER TABLE fleet_cognition_tiers DROP CONSTRAINT IF EXISTS fleet_cognition_tiers_provider_check;
ALTER TABLE fleet_cognition_tiers ADD CONSTRAINT fleet_cognition_tiers_provider_check CHECK (provider IN ('anthropic','local'));
ALTER TABLE fleet_cognition_tiers ADD CONSTRAINT fleet_cognition_tiers_local_unpriced CHECK (provider <> 'local'
  OR (input_microcents_per_token = 0 AND output_microcents_per_token = 0 AND cache_write_microcents_per_token = 0 AND cache_read_microcents_per_token = 0
      AND thinking IS NULL AND effort IS NULL AND prompt_cache = 'off'));
ALTER TABLE fleet_cognition_policy DROP CONSTRAINT IF EXISTS fleet_cognition_policy_provider_check;
ALTER TABLE fleet_cognition_policy ADD CONSTRAINT fleet_cognition_policy_provider_check CHECK (provider IN ('none','scripted','openai_compatible','anthropic','local'));

CREATE TABLE fleet_inference_profile (
  id                    integer     PRIMARY KEY CHECK (id = 1),
  profile               text        NOT NULL CHECK (profile IN ('local_only','cloud_allowed')),
  local_compute_policy  text        NOT NULL DEFAULT 'unpriced' CHECK (local_compute_policy IN ('unpriced')),
  reason                text        NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  set_by                text        NOT NULL,
  set_at                timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fleet_inference_profile (id, profile, reason, set_by)
  VALUES (1, 'local_only', 'owner directive 2026-10-23: local inference only; no automatic cloud fallback', 'migration');

CREATE FUNCTION fleet_inference_local_only() RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE((SELECT profile = 'local_only' FROM fleet_inference_profile WHERE id = 1), true)
$$;

-- Under local_only nothing non-local can be enabled: the guard is on the rows themselves.
CREATE FUNCTION fleet_inference_tier_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF NEW.enabled AND NEW.provider <> 'local' AND fleet_inference_local_only() THEN
    RAISE EXCEPTION 'FLEET_INFERENCE_LOCAL_ONLY: tier % cannot be enabled for provider % (the inference profile is local_only)', NEW.tier, NEW.provider;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_cognition_tiers_local_only BEFORE INSERT OR UPDATE ON fleet_cognition_tiers FOR EACH ROW EXECUTE FUNCTION fleet_inference_tier_guard();

CREATE FUNCTION fleet_inference_policy_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF NEW.cognition_enabled AND NEW.provider NOT IN ('local','scripted') AND fleet_inference_local_only() THEN
    RAISE EXCEPTION 'FLEET_INFERENCE_LOCAL_ONLY: cognition cannot be enabled for provider % (the inference profile is local_only)', NEW.provider;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_cognition_policy_local_only BEFORE INSERT OR UPDATE ON fleet_cognition_policy FOR EACH ROW EXECUTE FUNCTION fleet_inference_policy_guard();

-- Existing cloud tiers and an enabled cloud policy stop here (the directive's containment, made durable).
UPDATE fleet_cognition_tiers SET enabled = false, updated_at = now(), updated_by = 'migration' WHERE enabled AND provider <> 'local';
UPDATE fleet_cognition_policy SET cognition_enabled = false, updated_at = now(), updated_by = 'migration' WHERE cognition_enabled AND provider NOT IN ('local','scripted');

-- Map a tier to the local model (zero provider prices; verification voided, as for any mapping change).
CREATE FUNCTION fleet_cognition_tier_set_local(p_tier text, p_model text, p_max_output_tokens integer, p_actor text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_actor IS NULL OR length(p_actor) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: actor required'; END IF;
  UPDATE fleet_cognition_tiers SET provider = 'local', model = p_model, thinking = NULL, effort = NULL, prompt_cache = 'off', max_output_tokens = p_max_output_tokens,
      input_microcents_per_token = 0, output_microcents_per_token = 0, cache_write_microcents_per_token = 0, cache_read_microcents_per_token = 0,
      enabled = false, verified_at = NULL, verified_ref = NULL, updated_at = now(), updated_by = p_actor
    WHERE tier = p_tier;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: tier is T1, T2 or T3'; END IF;
  PERFORM fleet_event('cognition_tier_set', NULL, p_actor, jsonb_build_object('tier', p_tier, 'model', p_model, 'provider', 'local'));
  RETURN (SELECT to_jsonb(x) FROM fleet_cognition_tiers x WHERE tier = p_tier);
END $$;

-- The owner's explicit profile choice (owner actor; recorded; a permanent event).
CREATE FUNCTION fleet_admin_inference_profile_set(p_profile text, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  IF p_profile NOT IN ('local_only','cloud_allowed') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: profile is local_only or cloud_allowed'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a reason is required'; END IF;
  INSERT INTO fleet_inference_profile (id, profile, reason, set_by) VALUES (1, p_profile, left(trim(p_reason), 300), p_actor)
    ON CONFLICT (id) DO UPDATE SET profile = EXCLUDED.profile, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = now();
  IF p_profile = 'local_only' THEN
    UPDATE fleet_cognition_tiers SET enabled = false, updated_at = now(), updated_by = p_actor WHERE enabled AND provider <> 'local';
    UPDATE fleet_cognition_policy SET cognition_enabled = false, updated_at = now(), updated_by = p_actor WHERE cognition_enabled AND provider NOT IN ('local','scripted');
  END IF;
  PERFORM fleet_event('inference_profile_set', NULL, p_actor, jsonb_build_object('profile', p_profile, 'reason', left(trim(p_reason), 300)));
  RETURN (SELECT to_jsonb(x) FROM fleet_inference_profile x WHERE id = 1);
END $$;

CREATE FUNCTION fleet_inference_profile_state() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('profile', p.profile, 'localComputePolicy', p.local_compute_policy, 'reason', p.reason, 'setBy', p.set_by, 'setAt', p.set_at,
    'tiers', (SELECT jsonb_agg(jsonb_build_object('tier', t.tier, 'provider', t.provider, 'model', t.model, 'enabled', t.enabled, 'verified', t.verified_at IS NOT NULL) ORDER BY t.tier) FROM fleet_cognition_tiers t),
    'policy', (SELECT jsonb_build_object('enabled', c.cognition_enabled, 'provider', c.provider, 'model', c.model) FROM fleet_cognition_policy c WHERE c.id = 1))
  FROM (SELECT * FROM fleet_inference_profile WHERE id = 1
        UNION ALL SELECT 1, 'local_only', 'unpriced', 'no profile row: local_only applies', 'default', now() WHERE NOT EXISTS (SELECT 1 FROM fleet_inference_profile)) p
$$;

${AUTHORIZE}

${AUTHORIZE_TREASURY}

${OBLIGATIONS}

${OBLIGATIONS_ALL}

REVOKE ALL ON FUNCTION fleet_cognition_tier_set_local(text, text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fleet_admin_inference_profile_set(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fleet_inference_profile_state() FROM PUBLIC;
`;
