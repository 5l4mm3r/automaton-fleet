/**
 * Schema v102 — premium work room and a refusal that names the way forward (owner, 2026-10-20, after the purchase proof:
 * "Opus for delivering customer products or building customer facing anything"; the agent's own job, done fully).
 *
 * 1. Every founder step now runs on the critical tier (router: founder_work, T3, effort high). Its output room grows from
 *    8,000 to 16,000 tokens: deep reasoning and a finished product's build script in one step must not be cut off. Same
 *    model, same prices; the tier stays enabled and verified (fleet_cognition_tier_set would void the model's
 *    verification, which a change of output room does not need). Recorded by the migration itself (updated_by
 *    migration:v102); a rollout appends no events but role grants.
 * 2. `after` naming no operation of the agent's (Agent-1 passed its message's id four times while resending its corrected
 *    file): the refusal now says that `after` takes an operationId and names the latest operation on that subject — or
 *    that there is none and `after` is omitted.
 */
import { V95_SQL } from "./migrations-phase95.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));

export const T3_MAX_OUTPUT_TOKENS_V102 = 16000;

const OP_BEGIN = restate(V95_SQL, "fleet_op_begin", [
  [`    IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_OPERATION_NOT_FOUND: after names no operation of yours'; END IF;`,
   `    IF NOT FOUND THEN
      -- v102: say what after takes and name the operation it should be (the latest on this subject), or that there is none.
      l := fleet_op_latest(p_agent, p_op, v_subject);
      RAISE EXCEPTION 'FLEET_OPERATION_NOT_FOUND: after names no operation of yours — it takes an operationId (from an earlier result or a refusal), not a message, delivery or order id. %',
        CASE WHEN l.operation_id IS NULL THEN format('There is no earlier %s on %s: omit after.', p_op, v_subject)
             ELSE format('The latest %s on %s is #%s (%s): repeat with after: "%s".', p_op, v_subject, l.ordinal, fleet_op_status(l), l.operation_id) END;
    END IF;`],
]);

export const V102_SQL = `
UPDATE fleet_cognition_tiers SET max_output_tokens = ${T3_MAX_OUTPUT_TOKENS_V102}, updated_at = now(), updated_by = 'migration:v102' WHERE tier = 'T3';

${OP_BEGIN}

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
