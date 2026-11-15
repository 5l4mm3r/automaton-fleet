/**
 * Schema v103 — an agent can complete a refund honestly (owner, 2026-10-20: "Agent-1 must read and answer that request,
 * initiate the refund itself, and confirm completion only after PayPal verifies it").
 *
 * 1. WAKE. A refund of the agent's that PayPal completed — or that failed — changes `eventsDigest`, and is listed in
 *    `recentEvents` (kind refund, its status, the tool that reads it). Its own request being created or sent is not news
 *    (the agent did it; v101's rule for its own messages). Before v103 nothing woke an agent when PayPal confirmed a
 *    refund: it could only poll (paid) or tell the buyer before it was true.
 * 2. TRUTH. A refund request's note said "custody sends it to PayPal once money-out is activated (refunds use the same
 *    authority as payments)" — untrue since v96: a refund leaves under a refund authority the owner grants (custody
 *    enforces it), not the payout activation. It now says so, and that the agent is woken when PayPal confirms or fails
 *    it: tell the buyer the refund is complete only then.
 */
import { V101_SQL, wakeJobs } from "./migrations-phase101.js";
import { V59_SQL } from "./migrations-phase59.js";
import { finishedJobs } from "./migrations-phase94.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));

/** Refund statuses that are news to the agent (PayPal's outcome). */
export const REFUND_NEWS_STATUSES = ["completed", "failed"] as const;
const NEWS = REFUND_NEWS_STATUSES.map((s) => `'${s}'`).join(", ");

const ATTENTION = restate(V101_SQL, "fleet_agent_attention", [
  [`          ${wakeJobs}) j)`, `          ${wakeJobs}) j),
      -- v103: PayPal's outcome for one of the agent's refunds (completed or failed) — not its own request or its sending.
      (SELECT COALESCE(string_agg(request_id::text || ':' || status, ',' ORDER BY request_id), '') FROM fleet_paypal_refund_requests
        WHERE agent_id = p_agent AND status IN (${NEWS}) AND updated_at > now() - interval '30 days')`],
  [`'tool', j.tool) FROM (
          ${finishedJobs}) j) x`, `'tool', j.tool) FROM (
          ${finishedJobs}) j
        -- v103: PayPal's outcome for one of the agent's refunds.
        UNION ALL SELECT jsonb_build_object('kind', 'refund', 'id', request_id, 'status', status, 'at', updated_at, 'tool', 'wallet orders')
          FROM fleet_paypal_refund_requests WHERE agent_id = p_agent AND status IN (${NEWS}) AND updated_at > now() - interval '14 days') x`],
]);

const REFUND_REQUEST = restate(V59_SQL, "fleet_order_refund_request", [
  [`    'note', CASE WHEN EXISTS (SELECT 1 FROM fleet_custody_activation_live())
                 THEN 'custody sends it to PayPal shortly; the amount is set aside now and posted when PayPal confirms it'
                 ELSE 'set aside now; custody sends it to PayPal once money-out is activated (refunds use the same authority as payments)' END);`,
   `    -- v103: refunds leave under a refund authority (v96), not the payout activation; the agent is woken by PayPal's outcome.
    'note', 'set aside now; custody sends it to PayPal under a refund authority the owner grants, and it is booked when PayPal confirms it. You are woken when PayPal completes or fails it (wallet orders shows its status): tell the buyer it is complete only then.');`],
]);

export const V103_SQL = `
${ATTENTION}

${REFUND_REQUEST}

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
