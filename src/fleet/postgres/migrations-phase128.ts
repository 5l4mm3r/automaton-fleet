/**
 * Schema v128 — the agent sees its own runway (9 Nov 2026, SHEET-1 diagnosis).
 * SHEET-1: Agent-1 wrote a correct workbook, then every model call was refused FLEET_COGNITION_CREDITS_EXHAUSTED with $0.76
 * of its $4 cap still free — a call reserves its worst case first (about $0.78 there, 11.7× an average call) — and it never
 * wrote the delivery note. It could not see any of this: the run, the free credit and the daily budget were visible only to
 * the owner. `api_cognition_status.runway` (the founder's own free status read) now carries the figures its next call is
 * checked against, so the runtime can tell it how much work is left and when to finish:
 *   - creditFreeMicro: USD µ¢ of provider credit free for the agent's provider (balance − open holds, which include every
 *     open model-call reservation since v119); null for a local provider (never limited by credit);
 *   - dailyLeftMicro: today's budget left, in accounting µ¢ (the daily budget − the last day's spend);
 *   - run: the agent's open run (ceiling and spend in accounting µ¢, its end time), or null.
 * Read-only figures; they authorise nothing and change no check (the reservation rules stand as they are).
 */
import { restate } from "./migrations-phase42.js";
import { V62_SQL } from "./migrations-phase62.js";

const STATUS = restate(V62_SQL, "api_cognition_status", [
  [`'attention', fleet_agent_attention(p_agent));`, `'attention', fleet_agent_attention(p_agent), 'runway', fleet_cognition_runway(p_agent));`],
]);

export const V128_SQL = `
CREATE FUNCTION fleet_cognition_runway(p_agent text) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  WITH s AS (SELECT fleet_cognition_state(p_agent) AS j), r AS (SELECT fleet_cognition_run_json(p_agent) AS j)
  SELECT jsonb_build_object(
    'creditFreeMicro', CASE WHEN s.j ->> 'provider' IN ('local', 'none') OR s.j ->> 'provider' IS NULL THEN NULL
      ELSE fleet_provider_credit_balance(s.j ->> 'provider') - fleet_provider_credit_held(s.j ->> 'provider') END,
    'dailyLeftMicro', (s.j ->> 'dailyBudgetCents')::bigint * 1000000 - (s.j ->> 'spentTodayMicrocents')::bigint,
    'run', CASE WHEN r.j IS NULL OR NOT (r.j ->> 'open')::boolean THEN NULL ELSE jsonb_build_object(
      'ceilingMicro', (SELECT ceiling_minor FROM fleet_cognition_run_budgets WHERE run_id = (r.j ->> 'runId')::uuid) * 1000000,
      'spentMicro', (r.j ->> 'spentMicro')::bigint + (r.j ->> 'inflightMicro')::bigint,
      'startsAt', r.j -> 'startsAt', 'endsAt', r.j -> 'endsAt') END,
    'at', now())
  FROM s CROSS JOIN r
$$;
REVOKE EXECUTE ON FUNCTION fleet_cognition_runway(text) FROM PUBLIC;
${STATUS}
`;
