/**
 * Schema v97 — the customer's order page is a complete checkout (2026-10-19, owner: "there is no information of what's being
 * purchased or any security or confidence in making the purchase").
 *
 * Read functions only; no table, no money movement, no permission changes beyond one new service read.
 * 1. ORDER PAGE. `svc_order_page` also returns what the order buys, from the offer the buyer bought: brand, title, summary,
 *    audience, the agent's description and promised deliverables, its previews and its deliverable files (name, type,
 *    size), its storefront and support address — whatever the offer's sale status (a buyer with an order keeps seeing what
 *    they bought). The receipt facts once PayPal has captured: when, and PayPal's transaction id (the buyer sees the same id
 *    in their PayPal account); a short order reference; the amount refunded.
 * 2. SAMPLES. `svc_order_sample(token, kind, n)` — by the order's access code only: `preview` → the offer's n-th preview
 *    image (as the offer page shows it); `contents` → the n-th deliverable file of at most 2 MB, which the controller reads
 *    to show what is inside it (member names, sizes, sheet columns, the first lines of a text file). The controller never
 *    serves a `contents` file's bytes before payment: downloads remain `svc_order_file` (paid, consent recorded).
 */
import { V82_SQL } from "./migrations-phase82.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));

/** The largest deliverable the order page reads to show its contents (bytes). */
export const ORDER_CONTENTS_MAX_BYTES = 2_000_000;

const ORDER_PAGE = restate(V82_SQL, "svc_order_page", [
  [`      'offer', (SELECT jsonb_build_object('title', o.title, 'slug', o.slug, 'terms', o.terms) FROM fleet_offers o WHERE o.offer_id = x.offer_id),`,
   `      'offer', (SELECT fleet_order_offer_json(o) FROM fleet_offers o WHERE o.offer_id = x.offer_id),
      'reference', upper(left(replace(x.order_id::text, '-', ''), 8)),
      'paidAt', CASE WHEN c.status = 'captured' THEN c.captured_at END,
      'paypalTransactionId', CASE WHEN c.status = 'captured' THEN c.capture_id END,
      'refundedMinor', NULLIF(x.refunded_minor, 0),`],
]);

export const V97_SQL = `
-- ═══ 1. What the order buys, as the buyer's order page shows it ═══
CREATE FUNCTION fleet_order_offer_json(o fleet_offers) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT (fleet_offer_public_json(o) - 'available' - 'atCapacity' - 'files') || jsonb_strip_nulls(jsonb_build_object('slug', o.slug,
    'files', CASE WHEN o.kind = 'product' THEN (SELECT jsonb_agg(jsonb_build_object('n', rn, 'fileName', file_name, 'contentType', content_type, 'sizeBytes', size_bytes, 'sha256', content_sha256) ORDER BY rn)
               FROM (SELECT f.*, row_number() OVER (ORDER BY f.file_name) AS rn FROM fleet_offer_files f
                      WHERE f.offer_id = o.offer_id AND f.role = 'deliverable' AND f.removed_at IS NULL) d) END))
$$;

${ORDER_PAGE}

-- ═══ 2. The order's preview images and the contents of its (small) deliverables, by the order's access code only ═══
CREATE FUNCTION svc_order_sample(p_token text, p_kind text, p_n integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r record;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('preview','contents') OR p_n IS NULL OR p_n < 1 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  SELECT f.file_name, f.content_type, f.size_bytes, f.content_sha256, f.blob INTO r
    FROM (SELECT f.*, row_number() OVER (ORDER BY f.file_name) AS rn
            FROM fleet_customer_orders x JOIN fleet_offer_files f ON f.offer_id = x.offer_id
           WHERE x.access_token = p_token AND f.removed_at IS NULL
             AND f.role = CASE p_kind WHEN 'preview' THEN 'preview' ELSE 'deliverable' END) f
   WHERE f.rn = p_n AND (p_kind = 'preview' OR f.size_bytes <= ${ORDER_CONTENTS_MAX_BYTES});
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  RETURN jsonb_build_object('ok', true, 'fileName', r.file_name, 'contentType', r.content_type, 'sha256', r.content_sha256, 'contentB64', encode(r.blob, 'base64'));
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
