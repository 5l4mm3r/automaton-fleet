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
 * 3. CUSTOMER SUPPORT ADDRESS (owner, 2026-10-19: "just make it a shared email and cleaner … with the agent as the subject").
 *    Buyers see the Fleet's shared address (fleet.treasury@proton.me), never a routing tag: on the offer and order pages, in
 *    the seller notice and in every email to a buyer, with the subject to use — "<agent name> - …", the agent's CURRENT
 *    name (the owner's label, so a rename changes it everywhere at once). Mail to buyers (deliveries, order messages,
 *    confirmations, enquiry replies) carries that subject prefix and no routing-tag Reply-To, so a buyer's reply goes to
 *    the shared address and returns through its conversation (In-Reply-To / References) or its subject.
 *    Inbound: after the routing address and the conversation, a subject that begins with exactly one living agent's
 *    current name ("Agent-1 - question", also after Re: / Fwd:) reaches that agent (`routing = 'subject'`); a name several
 *    living agents share, or none, stays unassigned for the owner (never guessed). Authentication mail is never routed by
 *    subject. Agents keep their routing addresses as the login email of accounts they create (that mail is addressed to them).
 */
import { V82_SQL } from "./migrations-phase82.js";
import { V41_SQL } from "./migrations-phase41.js";
import { V76_SQL } from "./migrations-phase76.js";
import { V78_SQL } from "./migrations-phase78.js";
import { V96_SQL } from "./migrations-phase96.js";
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

// ── 3. The customer support address: the shared address, with the agent's current name as the subject ──
const PUBLIC_JSON = restate(V96_SQL, "fleet_offer_public_json", [
  [`'supportEmail', fleet_storefront(o.venture_id) ->> 'supportEmail',`,
   `'supportEmail', fleet_storefront(o.venture_id) ->> 'supportEmail', 'supportSubject', fleet_storefront(o.venture_id) ->> 'supportSubject',`],
]);
const STOREFRONT = restate(V78_SQL, "fleet_storefront", [
  [`    'supportEmail', fleet_venture_mailbox(p_venture)))`,
   `    'supportEmail', fleet_venture_support(p_venture),
    'supportSubject', CASE WHEN fleet_venture_support(p_venture) IS NOT NULL THEN (SELECT fleet_agent_label(v.agent_id) FROM fleet_ventures v WHERE v.venture_id = p_venture) || ' - ' END))`],
]);
const SELLER_NOTICE = restate(V78_SQL, "fleet_seller_notice", [
  [`    'Customer support: ' || (st ->> 'supportEmail'),`,
   `    'Customer support: ' || (st ->> 'supportEmail') || COALESCE(' (email subject: "' || (st ->> 'supportSubject') || 'your question")', ''),`],
]);
const CUSTOMER_MAIL = restate(V78_SQL, "fleet_customer_mail", [
  [`'subject', left(p_subject, 300)`, `'subject', left(fleet_agent_subject(p_agent, p_subject), 300)`],
]);
const DELIVERY_SEND = restate(V78_SQL, "fleet_order_delivery_send", [
  [`'subject', d.subject,`, `'subject', left(fleet_agent_subject(d.agent_id, d.subject), 300),`],
]);
const ORDER_DELIVER = restate(V76_SQL, "fleet_econ_order_deliver", [
  [`(your routing address as Reply-To)`, `(subject prefixed with your name; replies return to you through the conversation)`],
]);
// Mail to a buyer has no routing-tag Reply-To: their reply goes to the shared address and returns by its conversation.
const JOB_CONTEXT = restate(V76_SQL, "ix_job_context", [
  [`'replyTo', CASE WHEN ch.provider_id IS NOT NULL THEN b.address END,`,
   `'replyTo', CASE WHEN ch.provider_id IS NOT NULL AND NOT fleet_mail_to_buyer(m.message_id) THEN b.address END,`],
]);
const MAIL_INGEST = restate(V41_SQL, "ix_mail_ingest", [
  [`  -- 3. An account awaiting verification on the sender's site (exactly one agent).`,
   `  -- 2b. v97: the subject begins with exactly one living agent's current name ("Agent-1 - …"). Never authentication mail.
  IF NOT COALESCE(p_withheld, false) THEN
    v_agents := fleet_mail_subject_agents(m ->> 'subject');
    IF cardinality(v_agents) = 1 THEN
      SELECT * INTO b FROM fleet_agent_mailboxes WHERE agent_id = v_agents[1] AND channel_id = p_channel AND status = 'active'
       ORDER BY (venture_id IS NULL) DESC, created_at DESC LIMIT 1;
      RETURN jsonb_build_object('ok', true, 'deliveries', jsonb_build_array(fleet_mail_store_in(c, m, v_pid, v_ext, v_irt, v_refs, v_rcpts, v_from, v_at, p_withheld,
        v_agents[1], b.mailbox_id, b.venture_id, NULL, NULL, 'subject', 'the subject names this agent')));
    ELSIF cardinality(v_agents) > 1 THEN v_reason := 'the subject names an agent name several living agents share';
    END IF;
  END IF;

  -- 3. An account awaiting verification on the sender's site (exactly one agent).`],
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

-- ═══ 3. Customer support: the shared address, the agent's current name as the subject ═══
-- The address a buyer writes to: the shared mailbox behind the venture's routing address (that address itself when it has no
-- shared channel).
CREATE FUNCTION fleet_venture_support(p_venture uuid) RETURNS text LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(c.address, b.address) FROM fleet_agent_mailboxes b
    LEFT JOIN fleet_comms_providers c ON c.provider_id = b.channel_id AND c.mode = 'shared' AND c.status = 'active'
   WHERE b.address = fleet_venture_mailbox(p_venture) AND b.status = 'active' ORDER BY b.created_at DESC LIMIT 1
$$;

-- "<agent name> - <subject>" (the agent's current name), unless the subject already carries it.
CREATE FUNCTION fleet_agent_subject(p_agent text, p_subject text) RETURNS text LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT CASE WHEN l IS NULL OR l = '' OR position(lower(l || ' - ') IN lower(COALESCE(p_subject, ''))) > 0 THEN COALESCE(p_subject, '')
              ELSE l || ' - ' || COALESCE(p_subject, '') END
    FROM (SELECT fleet_agent_label(p_agent) AS l) x
$$;

-- The living agents whose current name begins the subject (after Re: / Fwd: …), followed by a separator or the end; when
-- several names match, the longest wins; several agents with that name → all of them (the caller then routes to none).
CREATE FUNCTION fleet_mail_subject_agents(p_subject text) RETURNS text[] LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  WITH s AS (SELECT lower(regexp_replace(btrim(COALESCE(p_subject, '')), '^((re|fwd?|aw|wg|sv|tr)([[][0-9]+[]])?[[:space:]]*:[[:space:]]*)+', '', 'i')) AS t),
       c AS (SELECT g.agent_id, lower(btrim(fleet_agent_label(g.agent_id))) AS l FROM fleet_agents g WHERE g.status NOT IN ('dead','failed')),
       hit AS (SELECT c.agent_id, length(c.l) AS n FROM c, s
                WHERE c.l <> '' AND left(s.t, length(c.l)) = c.l AND substr(s.t, length(c.l) + 1) ~ '^[[:space:]]*([-–—:|]|$)')
  SELECT COALESCE(array_agg(agent_id ORDER BY agent_id), '{}') FROM hit WHERE n = (SELECT max(n) FROM hit)
$$;

-- Mail to a buyer: a delivery, a message on an order or enquiry, an order confirmation.
CREATE FUNCTION fleet_mail_to_buyer(p_message uuid) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM fleet_order_deliveries WHERE message_id = p_message)
      OR EXISTS (SELECT 1 FROM fleet_customer_messages WHERE mail_message_id = p_message)
      OR EXISTS (SELECT 1 FROM fleet_customer_orders WHERE confirmation_message_id = p_message)
$$;

ALTER TABLE fleet_agent_mail DROP CONSTRAINT IF EXISTS fleet_agent_mail_routing_check;
ALTER TABLE fleet_agent_mail ADD CONSTRAINT fleet_agent_mail_routing_check
  CHECK (routing IN ('mailbox','recipient_tag','thread','subject','awaiting_verification','correspondent','admin','unassigned','sent'));

${STOREFRONT}

${PUBLIC_JSON}

${SELLER_NOTICE}

${CUSTOMER_MAIL}

${DELIVERY_SEND}

${ORDER_DELIVER}

${JOB_CONTEXT}

${MAIL_INGEST}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
