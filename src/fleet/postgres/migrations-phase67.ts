/**
 * Schema v67 — the business foundation in the shared library, and prompt wake-ups for the events agents act on (owner,
 * 2026-10-12).
 *
 * 1. One authoritative business-knowledge source. The library gains `business-foundation` (enduring guidance) and
 *    `fleet-status` (dated capability status, stale after 14 days) entries, generated from
 *    docs/knowledge/business-foundation-v1.md. They are searchable like every library entry (stable ids, versioned:
 *    a correction loads a new version and keeps the old one), and a full read follows one reading path:
 *    `knowledge.library {path: "foundation", part}` returns whole entries in order, in parts of at most 7 000 characters,
 *    never truncated. Reading informs the turn; what persists is what the agent keeps (its facts, notes, journal) and
 *    what it retrieves later.
 * 2. Wake-ups. A hibernating agent compared a digest of its own state and ledger, so inbound customer email, card-request
 *    and spend-review decisions, Fleet Control notices, lesson-review outcomes and dispute changes did not wake it (up to
 *    the 24 h safety re-check). `fleet_agent_attention` now carries `eventsDigest` over exactly those; a runtime that
 *    includes it in its wake digest (this release's founder runtime) wakes on any of them within one thinking slot. The
 *    owner's explicit pause is unchanged: a paused agent wakes for nothing.
 */
import { V50_SQL } from "./migrations-phase50.js";
import { V51_SQL } from "./migrations-phase51.js";
import { V64_SQL } from "./migrations-phase64.js";
import { restate as restateRaw } from "./migrations-phase42.js";
import { KNOWLEDGE_FOUNDATION_V1 } from "./knowledge-foundation-v1.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const lit = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'`;

export const LIBRARY_CATEGORIES_V67 = ["demand-validation", "product-formats-pricing", "sales-channels", "acquisition", "delivery-support",
  "uk-legal-compliance", "unit-economics", "ethics-safety", "business-foundation", "fleet-status"] as const;
export const FOUNDATION_VERSION = KNOWLEDGE_FOUNDATION_V1.version;
export const FOUNDATION_PART_CHARS = 7_000;

const SEARCH = restate(V51_SQL, "fleet_knowledge_library_search", [
  [`'note', 'researched guidance (revision 2, 2026-10-08), not a rule set:`,
   `'note', 'researched guidance (revision 2, 2026-10-08) and the business foundation (${KNOWLEDGE_FOUNDATION_V1.version}, ${KNOWLEDGE_FOUNDATION_V1.lastReviewed}; fleet-status is dated status), not a rule set:`],
]);

const ECON_LIBRARY = restate(V50_SQL, "fleet_econ_knowledge_library", [
  [`  SELECT CASE WHEN a ? 'id' THEN`, `  SELECT CASE WHEN a ? 'path' THEN fleet_knowledge_reading_path(a ->> 'path',
      CASE WHEN jsonb_typeof(a -> 'part') = 'number' THEN (a ->> 'part')::integer ELSE 1 END)
    WHEN a ? 'id' THEN`],
]);

const ATTENTION = restate(V64_SQL, "fleet_agent_attention", [
  [`    'reviewsDigest', (SELECT md5(COALESCE(string_agg(review_id::text || ':' || status, ',' ORDER BY review_id), '')) FROM fleet_spend_reviews
                       WHERE agent_id = p_agent AND created_at > now() - interval '14 days'))`,
   `    'reviewsDigest', (SELECT md5(COALESCE(string_agg(review_id::text || ':' || status, ',' ORDER BY review_id), '')) FROM fleet_spend_reviews
                       WHERE agent_id = p_agent AND created_at > now() - interval '14 days'),
    -- v67: what a hibernating agent acts on beyond its ledger — inbound mail, card requests, spend reviews, Fleet Control
    -- notices, lesson reviews and disputes. A change wakes a runtime that includes it in its wake digest.
    'eventsDigest', md5(concat_ws('|',
      (SELECT count(*) || ':' || COALESCE(max(received_at)::text, '') FROM fleet_agent_mail WHERE agent_id = p_agent AND direction = 'in'),
      (SELECT COALESCE(string_agg(request_id::text || ':' || status, ',' ORDER BY request_id), '') FROM fleet_card_requests
        WHERE agent_id = p_agent AND created_at > now() - interval '30 days'),
      (SELECT COALESCE(string_agg(review_id::text || ':' || status, ',' ORDER BY review_id), '') FROM fleet_spend_reviews
        WHERE agent_id = p_agent AND created_at > now() - interval '30 days'),
      (SELECT count(*) || ':' || COALESCE(max(created_at)::text, '') FROM fleet_agent_messages WHERE agent_id = p_agent AND author = 'fleet_control'),
      (SELECT COALESCE(string_agg(proposal_id::text || ':' || status, ',' ORDER BY proposal_id), '') FROM fleet_knowledge_proposals WHERE agent_id = p_agent),
      (SELECT COALESCE(string_agg(dispute_id::text || ':' || status || ':' || COALESCE(outcome, ''), ',' ORDER BY dispute_id), '') FROM fleet_paypal_disputes
        WHERE agent_id = p_agent))))`],
]);

export const V67_SQL = `
ALTER TABLE fleet_knowledge_library DROP CONSTRAINT fleet_knowledge_library_category_check;
ALTER TABLE fleet_knowledge_library ADD CONSTRAINT fleet_knowledge_library_category_check CHECK (category IN (${q(LIBRARY_CATEGORIES_V67)}));

SELECT fleet_admin_knowledge_library_load(${lit(KNOWLEDGE_FOUNDATION_V1)}::jsonb, 'migration');

-- A full read of the business foundation, in order, whole entries per part (at most ${FOUNDATION_PART_CHARS} characters of
-- body per part; an entry is never split or truncated).
CREATE FUNCTION fleet_knowledge_reading_path(p_path text, p_part integer) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_order text[] := ARRAY[${q(KNOWLEDGE_FOUNDATION_V1.readingPath)}]; k fleet_knowledge_library; v_part integer := 1; v_size integer := 0;
        v_out jsonb := '[]'::jsonb; v_parts integer; i integer;
BEGIN
  IF p_path IS DISTINCT FROM 'foundation' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'path is foundation'); END IF;
  IF p_part IS NULL OR p_part < 1 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'part is 1 or more'); END IF;
  FOR i IN 1 .. array_length(v_order, 1) LOOP
    SELECT * INTO k FROM fleet_knowledge_library WHERE entry_id = v_order[i] AND current;
    CONTINUE WHEN k.entry_id IS NULL;
    IF v_size > 0 AND v_size + length(k.body) > ${FOUNDATION_PART_CHARS} THEN v_part := v_part + 1; v_size := 0; END IF;
    v_size := v_size + length(k.body);
    IF v_part = p_part THEN v_out := v_out || jsonb_build_array(fleet_knowledge_library_entry_json(k, true)); END IF;
  END LOOP;
  v_parts := v_part;
  IF p_part > v_parts THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND', 'reason', format('the foundation has %s parts', v_parts)); END IF;
  RETURN jsonb_build_object('ok', true, 'path', 'foundation', 'version', '${FOUNDATION_VERSION}', 'part', p_part, 'parts', v_parts, 'entries', v_out,
    'note', CASE WHEN p_part = v_parts
      THEN 'end of the foundation: keep a short summary of what will guide your decisions (remember_fact, with this version); retrieve sections by id or query when a decision needs them'
      ELSE format('continue with part %s', p_part + 1) END);
END $$;

${SEARCH}

${ECON_LIBRARY}

${ATTENTION}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
