/**
 * Schema v61 — the owner's receiving test on a rail that is not yet ready.
 *
 * Until v60 the owner's PayPal receiving test (v53) required a rail that was already active with `receive_payments`
 * ready, i.e. `sale_ingestion` verified — the very thing the test exists to establish. v61 opens one narrow path:
 *
 * - A new readiness check, `webhook_configuration`, for PayPal rails that receive payments. Verified only from a probe
 *   (`evidence_kind = 'probe'`), only while the rail has a webhook id, and the check is bound to that id (stored in its
 *   evidence by the registry). It is no capability's requirement: it never makes a capability ready, never activates a
 *   rail and never shows the rail as able to ingest sales.
 * - `fleet_rail_owner_test_ready(rail)`: a shared live/sandbox PayPal rail that receives payments, `pending_setup` or
 *   `active`, its credential active, `account_access` verified and `webhook_configuration` verified for the webhook id
 *   the rail has now.
 * - The owner's test (`fleet_admin_paypal_test_checkout`) uses an active ready rail as before, else such a rail. It is
 *   still the owner's alone (owner actor + fleet_treasury approver), at most 10.00, one at a time, booked as owner
 *   capital (never revenue) exactly once per capture (unchanged v53 / v48 claim keys).
 * - Custody processes it: `cx_paypal_work` hands over owner-test checkouts on a `pending_setup` rail (and only those),
 *   and `cx_paypal_rails` includes such a rail (`testOnly`) while a test on it is in flight or was captured within seven
 *   days — so its webhooks are signature-verified with the rail's webhook id and Transaction Search can reconcile it.
 *
 * Unchanged: agents' checkouts still need an active rail with `receive_payments` ready; activation still needs an
 * evidenced capability; refunds, payouts and money-out are untouched.
 */
import { V46_SQL, READINESS_CHECKS, CAPABILITY_CHECKS } from "./migrations-phase46.js";
import { V48_SQL } from "./migrations-phase48.js";
import { V49_SQL } from "./migrations-phase49.js";
import { V53_SQL } from "./migrations-phase53.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

export const OWNER_TEST_CHECKS = ["webhook_configuration"] as const;
/** How long a captured owner test keeps a not-yet-active rail in custody's view (reconciliation of that receipt). */
export const OWNER_TEST_RECONCILE_DAYS = 7;

const IN_FLIGHT = `('requested','open','approved','capture_pending')`;

const RAIL_VERIFY = restate(V46_SQL, "fleet_admin_rail_verify", [
  [`  IF p_check NOT IN (SELECT DISTINCT x FROM unnest(r.capabilities) cap, unnest(fleet_rail_required_checks(cap)) x)
     AND p_check NOT IN ('identity_verification','receipt_verification') THEN`,
   `  -- v61: the webhook a PayPal receiving rail delivers to — from a probe only, bound to the rail's webhook id now.
  IF p_check = 'webhook_configuration' THEN
    IF r.provider <> 'paypal' OR NOT ('receive_payments' = ANY(r.capabilities)) THEN
      RAISE EXCEPTION 'FLEET_BAD_REQUEST: webhook_configuration is a check of PayPal rails that receive payments';
    END IF;
    IF r.webhook_id IS NULL THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: the rail has no PayPal webhook id yet'; END IF;
    IF p_status = 'verified' AND p_evidence_kind <> 'probe' THEN
      RAISE EXCEPTION 'FLEET_BAD_REQUEST: webhook_configuration is verified only from a probe of PayPal''s webhook';
    END IF;
    p_evidence := COALESCE(p_evidence, '{}'::jsonb) || jsonb_build_object('webhookId', r.webhook_id);
  ELSIF p_check NOT IN (SELECT DISTINCT x FROM unnest(r.capabilities) cap, unnest(fleet_rail_required_checks(cap)) x)
     AND p_check NOT IN ('identity_verification','receipt_verification') THEN`],
]);

const TEST_CHECKOUT = restate(V53_SQL, "fleet_admin_paypal_test_checkout", [
  [`  SELECT x.* INTO r FROM fleet_payment_rails x
   WHERE x.provider = 'paypal' AND x.status = 'active' AND x.mode IN ('live','sandbox') AND x.rail_kind = 'shared' AND 'receive_payments' = ANY(x.capabilities)
     AND fleet_rail_capability_ready(x.rail_id, 'receive_payments')
   ORDER BY (x.mode = 'live') DESC, x.rail_id LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NO_RECEIVING_RAIL: no shared PayPal treasury rail is active and ready to receive payments'; END IF;`,
   `  -- v61: an active rail ready to receive; else a configured rail whose account access and webhook are verified.
  SELECT x.* INTO r FROM fleet_payment_rails x
   WHERE x.provider = 'paypal' AND x.mode IN ('live','sandbox') AND x.rail_kind = 'shared' AND 'receive_payments' = ANY(x.capabilities)
     AND ((x.status = 'active' AND fleet_rail_capability_ready(x.rail_id, 'receive_payments')) OR fleet_rail_owner_test_ready(x.rail_id))
   ORDER BY (x.status = 'active') DESC, (x.mode = 'live') DESC, x.rail_id LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NO_RECEIVING_RAIL: no shared PayPal treasury rail is ready to receive payments, nor configured for the owner''s test (account_access and webhook_configuration verified)'; END IF;`],
  [`  PERFORM fleet_event('paypal_test_checkout_requested', NULL, p_actor, jsonb_build_object('checkoutId', c.checkout_id, 'amountMinor', p_amount, 'railId', r.rail_id,
    'mode', r.mode));`,
   `  PERFORM fleet_event('paypal_test_checkout_requested', NULL, p_actor, jsonb_build_object('checkoutId', c.checkout_id, 'amountMinor', p_amount, 'railId', r.rail_id,
    'mode', r.mode, 'railStatus', r.status));`],
]);

const WORK = restate(V48_SQL, "cx_paypal_work", [
  [`   WHERE r.status = 'active' AND k.status IN ('active','rotating');`,
   `   WHERE (r.status = 'active' OR (r.status = 'pending_setup' AND c.purpose = 'owner_test')) AND k.status IN ('active','rotating');`],
]);

const RAILS = restate(V49_SQL, "cx_paypal_rails", [
  [`           'webhookId', x.webhook_id,`, `           'webhookId', x.webhook_id, 'testOnly', x.status <> 'active',`],
  [`   WHERE x.provider = 'paypal' AND x.status = 'active' AND x.mode IN ('live','sandbox') AND k.status IN ('active','rotating');`,
   `   WHERE x.provider = 'paypal' AND x.mode IN ('live','sandbox') AND k.status IN ('active','rotating')
     AND (x.status = 'active' OR (x.status = 'pending_setup' AND EXISTS (SELECT 1 FROM fleet_paypal_checkouts c WHERE c.rail_id = x.rail_id AND c.purpose = 'owner_test'
          AND (c.status IN ${IN_FLIGHT} OR (c.status = 'captured' AND c.captured_at > now() - interval '${OWNER_TEST_RECONCILE_DAYS} days')))));`],
]);

export const V61_SQL = `
ALTER TABLE fleet_rail_capability_checks DROP CONSTRAINT fleet_rail_capability_checks_check_name_check;
ALTER TABLE fleet_rail_capability_checks ADD CONSTRAINT fleet_rail_capability_checks_check_name_check
  CHECK (check_name IN (${q([...READINESS_CHECKS, ...CAPABILITY_CHECKS, ...OWNER_TEST_CHECKS])}));

-- The rail the owner may test receiving on before it is ready (see the header).
CREATE FUNCTION fleet_rail_owner_test_ready(p_rail uuid) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE((
    SELECT x.provider = 'paypal' AND x.mode IN ('live','sandbox') AND x.rail_kind = 'shared' AND 'receive_payments' = ANY(x.capabilities)
       AND x.status IN ('pending_setup','active') AND x.webhook_id IS NOT NULL AND k.status IN ('active','rotating')
       AND fleet_rail_check_verified(x.rail_id, 'account_access')
       AND EXISTS (SELECT 1 FROM (SELECT * FROM fleet_rail_capability_checks w WHERE w.rail_id = x.rail_id AND w.check_name = 'webhook_configuration'
                                  ORDER BY w.check_id DESC LIMIT 1) w
                   WHERE w.status = 'verified' AND w.evidence_kind = 'probe' AND (w.expires_at IS NULL OR w.expires_at > now())
                     AND w.evidence ->> 'webhookId' = x.webhook_id)
      FROM fleet_payment_rails x JOIN fleet_credential_refs k ON k.credential_id = x.credential_id WHERE x.rail_id = p_rail), false)
$$;

${RAIL_VERIFY}

${TEST_CHECKOUT}

${WORK}

${RAILS}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
