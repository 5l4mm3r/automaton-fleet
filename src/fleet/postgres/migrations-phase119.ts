/**
 * Schema v119 — an agent's daily AI limit counts its usage whichever credit pays (owner, 2026-10-26: "Daily AI limits must
 * count usage regardless of promotional or purchased funding, while promotional calls remain charged to no one. Do not
 * rewrite historical charges or create owner payable.").
 *
 * Since v118 a call's charge (`charged_microcents`) is its purchased part only, and the daily limit summed exactly that: calls
 * on promotional credit did not count, so the limit could not stop a runaway while the grant lasted. Now the rolling-24-hour
 * usage is, for the agent-paid calls:
 *   each recorded call's INTENDED charge (`charged_intended_microcents`: the cost at the call's own controlled rate, whichever
 *   credit paid; older rows fall back to what they were charged)
 *   + every reservation of the agent still unresolved (`fleet_cognition_inflight`, at its reserved estimate), so an expired,
 *     unrecorded call cannot let the next one through.
 * The authorisation (unchanged) refuses a call whose estimate does not fit, under the agent row's lock (one authorisation at
 * a time per agent). The state also reports what was actually charged, separately. Nothing is posted, charged, refunded or
 * rewritten; promotional use stays charged to no one and owed to no one.
 *
 * One measure of provider credit in use (owner, 2026-10-26: "Make Fleet Control and agent authorisation account for the same
 * in-flight provider-credit reservations atomically"). Fleet Control's reservation subtracted `fleet_provider_credit_held`
 * (engineering holds, its own open calls, expiring promotional credit) but not the agents' open model-call reservations, which
 * the agent authorisations and the engineering hold subtracted separately. So a Fleet Control call could take credit an agent's
 * call in flight had reserved, and a ceiling was not hard. Now `fleet_provider_credit_held` also counts every open model-call
 * reservation (live or expired, at its USD estimate), and the agent authorisations (agent-paid and treasury-paid) and the
 * engineering hold no longer subtract them a second time. Every consumer takes the same provider-credit advisory lock before
 * reading it, so concurrent reservations of any kind are serialised against one figure.
 */
import { V62_SQL } from "./migrations-phase62.js";
import { V111_SQL } from "./migrations-phase111.js";
import { V112_SQL } from "./migrations-phase112.js";
import { V118_SQL } from "./migrations-phase118.js";
import { restate } from "./migrations-phase42.js";

const STATE = restate(V62_SQL, "fleet_cognition_state", [
  [`  WITH spent AS (
    SELECT COALESCE(sum(COALESCE(charged_microcents, charged_cents * 1000000)), 0)::bigint AS micro
      FROM fleet_cognition_log WHERE agent_id = p_agent AND payer = 'agent' AND at > now() - interval '1 day')`,
   `  WITH used AS (
    SELECT COALESCE(sum(COALESCE(charged_intended_microcents, charged_microcents, charged_cents * 1000000)), 0)::bigint AS intended,
           COALESCE(sum(COALESCE(charged_microcents, charged_cents * 1000000)), 0)::bigint AS charged
      FROM fleet_cognition_log WHERE agent_id = p_agent AND payer = 'agent' AND at > now() - interval '1 day'),
  held AS (
    SELECT COALESCE(sum(estimate_cents), 0)::bigint * 1000000 AS micro
      FROM fleet_cognition_inflight WHERE agent_id = p_agent AND payer IS DISTINCT FROM 'treasury'),
  spent AS (SELECT used.intended + held.micro AS micro, used.intended, used.charged, held.micro AS held FROM used CROSS JOIN held)`],
  [`    'spentTodayCents', ceil(spent.micro / 1000000.0)::bigint,`,
   `    'spentTodayCents', ceil(spent.micro / 1000000.0)::bigint,
    -- v119: the limit's parts — usage at charge rates whichever credit paid, reservations still open — and what was charged.
    'usageTodayMicrocents', spent.intended, 'reservedOpenMicrocents', spent.held, 'chargedTodayMicrocents', spent.charged,`],
]);

const INFLIGHT_USD = `(SELECT COALESCE(sum(COALESCE(i.estimate_usd_cents, 0)), 0) FROM fleet_cognition_inflight i
            WHERE COALESCE(i.route_provider, (SELECT provider FROM fleet_cognition_policy WHERE id = 1)) = p_provider)::bigint * 1000000`;
const HELD = restate(V118_SQL, "fleet_provider_credit_held", [
  [`            AND expires_at > now() AND expires_at <= now() + interval '60 minutes')::bigint;`,
   `            AND expires_at > now() AND expires_at <= now() + interval '60 minutes')::bigint
       -- v119: every open model-call reservation (live or expired) at its USD estimate — the same figure for every consumer.
       + ${INFLIGHT_USD};`],
]);
const NOT_TWICE = `  v_reserved := 0;   -- v119: open model-call reservations are counted in fleet_provider_credit_held (never twice)`;
const AUTHORIZE = restate(V112_SQL, "svc_cognition_authorize", [
  [`  SELECT COALESCE(sum(COALESCE(estimate_usd_cents, 0)), 0) * 1000000 INTO v_reserved FROM fleet_cognition_inflight;`, NOT_TWICE],
]);
const AUTHORIZE_TREASURY = restate(V112_SQL, "fleet_cognition_authorize_treasury", [
  [`  SELECT COALESCE(sum(COALESCE(estimate_usd_cents, 0)), 0) * 1000000 INTO v_reserved FROM fleet_cognition_inflight;`, NOT_TWICE],
]);
const ENGINEERING_HOLD = restate(V111_SQL, "fleet_admin_engineering_credit_hold", [
  [`  v_free := fleet_provider_credit_balance(p_provider) - fleet_provider_credit_held(p_provider)
            - COALESCE((SELECT sum(COALESCE(estimate_usd_cents, 0)) FROM fleet_cognition_inflight), 0) * 1000000;`,
   `  v_free := fleet_provider_credit_balance(p_provider) - fleet_provider_credit_held(p_provider);   -- v119: open reservations included once`],
]);

export const V119_SQL = `
${STATE}

${HELD}

${AUTHORIZE}

${AUTHORIZE_TREASURY}

${ENGINEERING_HOLD}

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
