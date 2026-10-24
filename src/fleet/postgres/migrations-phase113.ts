/**
 * Schema v113 — a buyer's requested change stays owed until a delivery could have answered it (run 6, 2026-10-24).
 *
 * Run 6 (Qwen3.5-9B on the owner's desktop): the buyer asked for a date line on point 7; the agent re-sent the very file
 * the buyer already had, and FleetController counted that delivery as resolving the request (any SENT delivery after the
 * buyer's message did). The runtime now refuses such a resend unless the agent marks it `unchanged` — but the agent's own
 * flag is no evidence that the buyer's request was met or withdrawn. So the record decides, not the agent:
 *
 *  - an order's EFFECTIVE delivery is a sent delivery that can answer a request: the order's first sent delivery, or one
 *    whose files differ from the sent delivery before it AND whose review showed the required change on the page (a
 *    passing `required_content` check in its automated report — the phrases the agent had to state for a revision, checked
 *    by the inspector, not its "met: true");
 *  - a request is resolved by an effective delivery made after it (or, as before, by the agent's resolving answer:
 *    order_message {resolved: true}, its judgement that nothing more is owed); `revisionOwed` and the obligation's
 *    resolution use the same rule. A resend of the same files — recovery, or the same file again on request — still goes
 *    to the buyer, but answers nothing;
 *  - the order thread (order.thread) reports `revisionOwed` from this rule, so the runtime's checks and the obligation agree.
 *
 * Nothing is deleted or rewritten; the functions are restated.
 */
import { restate as restateRaw } from "./migrations-phase42.js";
import { V112_SQL } from "./migrations-phase112.js";
import { V76_SQL } from "./migrations-phase76.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));

const RESOLVED_BY_ANY_SENT = `GREATEST((SELECT max(d.created_at) FROM fleet_order_deliveries d WHERE d.order_id = o.order_id AND d.status = 'sent'),`;
const RESOLVED_BY_EFFECTIVE = `GREATEST(fleet_order_effective_delivery_at(o.order_id),`;
const REVISION_ANY_SENT = `u.last_buyer > (SELECT max(d.created_at) FROM fleet_order_deliveries d
                  WHERE d.order_id::text = u.id AND d.status = 'sent')`;
const REVISION_EFFECTIVE = `u.last_buyer > fleet_order_effective_delivery_at(u.id::uuid)`;
const EDITS: Array<[string, string]> = [[RESOLVED_BY_ANY_SENT, RESOLVED_BY_EFFECTIVE], [REVISION_ANY_SENT, REVISION_EFFECTIVE]];
const OBLIGATIONS = restate(V112_SQL, "fleet_customer_obligations", EDITS);
const OBLIGATIONS_ALL = restate(V112_SQL, "fleet_customer_obligations_all", EDITS);
const ORDER_THREAD = restate(V76_SQL, "fleet_econ_order_thread", [[
  `'thread', fleet_customer_thread_json(NULL, o.order_id, true), 'briefSha256', fleet_brief_sha256(o.order_id, NULL),`,
  `'thread', fleet_customer_thread_json(NULL, o.order_id, true), 'briefSha256', fleet_brief_sha256(o.order_id, NULL),
    'revisionOwed', fleet_order_revision_owed(o.order_id),`]]);

export const V113_SQL = String.raw`
-- The files of one delivery, as one comparable value (their hashes, sorted).
CREATE FUNCTION fleet_order_delivery_digest(p_delivery uuid) RETURNS text LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT string_agg(content_sha256, ',' ORDER BY content_sha256) FROM fleet_order_delivery_files WHERE delivery_id = p_delivery
$$;

-- v113: when an order's latest delivery that can answer a buyer's request was made: its first sent delivery, or a sent
-- delivery whose files differ from the sent one before it and whose review passed the required_content check.
CREATE FUNCTION fleet_order_effective_delivery_at(p_order uuid) RETURNS timestamptz LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT max(d.created_at) FROM fleet_order_deliveries d
   WHERE d.order_id = p_order AND d.status = 'sent'
     AND (NOT EXISTS (SELECT 1 FROM fleet_order_deliveries e WHERE e.order_id = p_order AND e.status = 'sent' AND e.created_at < d.created_at)
          OR (fleet_order_delivery_digest(d.delivery_id) IS DISTINCT FROM
                (SELECT fleet_order_delivery_digest(e.delivery_id) FROM fleet_order_deliveries e
                  WHERE e.order_id = p_order AND e.status = 'sent' AND e.created_at < d.created_at ORDER BY e.created_at DESC LIMIT 1)
              AND EXISTS (SELECT 1 FROM fleet_artifact_reviews r WHERE r.review_id = d.review_id AND r.automated_ok
                            AND jsonb_path_exists(r.automated, '$.files[*].checks[*] ? (@.id == "required_content" && @.status == "pass")'))))
$$;

-- v113: whether a buyer's request (since the agent last resolved the order) is still owed: written after the latest
-- effective delivery. The same rule as the obligation's revisionOwed.
CREATE FUNCTION fleet_order_revision_owed(p_order uuid) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(EXISTS (
    SELECT 1 FROM fleet_customer_messages b
     WHERE b.order_id = p_order AND b.author = 'buyer'
       AND b.created_at > fleet_order_effective_delivery_at(p_order)
       AND b.created_at > COALESCE((SELECT max(m.created_at) FROM fleet_customer_messages m WHERE m.order_id = p_order AND m.author = 'agent' AND m.resolves), '-infinity'::timestamptz)), false)
$$;

${OBLIGATIONS}

${OBLIGATIONS_ALL}

${ORDER_THREAD}

REVOKE ALL ON FUNCTION fleet_order_delivery_digest(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION fleet_order_effective_delivery_at(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION fleet_order_revision_owed(uuid) FROM PUBLIC;
`;
