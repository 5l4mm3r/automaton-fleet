/**
 * Schema v104 — a bounded run stops cleanly when its next request cannot be reserved (owner, 2026-10-20: "a fixed stop
 * threshold does not guarantee another request fits as prompts grow. Report the next request's actual reservation
 * requirement and stop cleanly when it cannot fit").
 *
 * Every routed and conversation request reserves a true upper bound of its cost (routed-gateway costBoundMicro). When a
 * request's reservation does not fit the open run's ceiling on top of what the run has cost and what is in flight, the
 * refusal now says exactly how much the request needed and how much was left, and the controller brings the run's end time
 * forward to now (recorded with that reason, cognition_run_ended): every further request is refused as the run having
 * ended — never run without a ceiling (a run marked ended would no longer cap anything; its end time passing does).
 */
import { V94_SQL } from "./migrations-phase94.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));

const REFUSAL = restate(V94_SQL, "fleet_cognition_run_refusal", [
  [`    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_RUN_BUDGET_EXHAUSTED',
      'reason', format('the run''s ceiling (%s minor units) does not cover this request''s worst case on top of what the run has cost', b.ceiling_minor));`,
   `    -- v104: the exact figures (minor units ×10⁶): what this request reserves and what the ceiling has left.
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_RUN_BUDGET_EXHAUSTED', 'runId', b.run_id,
      'requiredMicro', v_est_micro, 'leftMicro', b.ceiling_minor * 1000000 - (j ->> 'spentMicro')::bigint - (j ->> 'inflightMicro')::bigint,
      'reason', format('the next request reserves up to %s minor units (a bound of its cost); the run''s ceiling of %s has %s left (spent %s, in flight %s)',
        round(v_est_micro / 1000000.0, 4), b.ceiling_minor, round((b.ceiling_minor * 1000000 - (j ->> 'spentMicro')::bigint - (j ->> 'inflightMicro')::bigint) / 1000000.0, 4),
        round((j ->> 'spentMicro')::bigint / 1000000.0, 4), round((j ->> 'inflightMicro')::bigint / 1000000.0, 4)));`],
]);

// The one writer for this (privilege audit: a run budget is written only by its named functions). It can only bring an
// open run's end time forward to now; it never extends, raises or reopens one.
const END_UNFIT = `
CREATE FUNCTION fleet_cognition_run_end_unfit(p_agent text, p_refusal jsonb) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  UPDATE fleet_cognition_run_budgets SET ends_at = LEAST(ends_at, now()), end_reason = left(p_refusal ->> 'reason', 300)
   WHERE agent_id = p_agent AND ended_at IS NULL AND ends_at > now();
  IF FOUND THEN
    PERFORM fleet_event('cognition_run_ended', p_agent, 'controller', jsonb_build_object('reason', left(p_refusal ->> 'reason', 300),
      'requiredMicro', p_refusal -> 'requiredMicro', 'leftMicro', p_refusal -> 'leftMicro', 'runId', p_refusal -> 'runId'));
  END IF;
END $$;`;

const STOP = `  r := fleet_cognition_run_refusal(p_agent, p_estimate_usd_cents);
  IF r IS NOT NULL THEN
    -- v104: the next request does not fit: the run ends now (its end time, never ended_at — an ended run caps nothing).
    IF r ->> 'code' = 'FLEET_COGNITION_RUN_BUDGET_EXHAUSTED' THEN PERFORM fleet_cognition_run_end_unfit(p_agent, r); END IF;
    RETURN r;
  END IF;`;
const OLD = `  r := fleet_cognition_run_refusal(p_agent, p_estimate_usd_cents);
  IF r IS NOT NULL THEN RETURN r; END IF;`;

const ROUTED = restate(V94_SQL, "svc_cognition_routed_authorize", [[OLD, STOP]]);
const CONVERSATION = restate(V94_SQL, "svc_cognition_conversation_authorize", [[OLD, STOP]]);

export const V104_SQL = `
${END_UNFIT}

${REFUSAL}

${ROUTED}

${CONVERSATION}

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
