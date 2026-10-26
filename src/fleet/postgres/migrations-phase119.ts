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
 */
import { V62_SQL } from "./migrations-phase62.js";
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

export const V119_SQL = `
${STATE}

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
