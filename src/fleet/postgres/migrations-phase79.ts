/**
 * Schema v79 — the autonomous business operator (owner brief, 2026-10-15). v78 is deployed (31ffef8) and is never edited;
 * what changes is restated here from the latest definitions.
 *
 * The scope: an agent finds a commercially worthwhile gap and establishes, operates and markets the business that serves
 * it, on whatever channels it chooses — not a storefront agent tied to one platform. Audit (docs §32) found the selling
 * infrastructure built (offers, pages, checkout, review, delivery) and these general capabilities missing; v79 adds them,
 * none tied to a platform:
 *
 *  1. Browser hands: files the agent staged from its workspace are uploaded into any site's file input (`upload_file`);
 *     a page's download, screenshot or printed PDF comes back to the agent (`download`, `screenshot`, `pdf`); an HTML / SVG
 *     file the agent made is rendered (`set_content`, then screenshot / pdf: brand images, listing graphics, mockups); plus
 *     hover, scroll, uncheck, wait_idle, tabs, dialogs and elements inside frames. Files live 24 h (fleet_browser_files).
 *  2. Credentials that cannot lock an account out: a new password for an account that already has one is PENDING until the
 *     agent confirms the site accepted it (account.password_confirm) — the old one keeps working until then; `new_password`
 *     fills the pending one again (a "confirm new password" field). (The broker also recognises sign-in / reset links.)
 *  3. Channels and presence: each venture's channels are the agent's own choice (any marketplace, community, social
 *     network, classifieds site, directory, ad platform, email or its own pages) with the platform rules it checked, fees,
 *     how payouts arrive and an attribution code; what it publishes there (profiles, listings, service ads, posts, pages, ad
 *     campaigns) is recorded with its URL and evidence. No platform list, no level gate, no fixed weighting.
 *  4. Attribution: a link with ?ref=<channel code> to an offer page carries the channel onto the enquiry / order it leads
 *     to; business.performance reports per channel: presence, leads, enquiries, paid orders, revenue, refunds, external
 *     sales and payouts, recorded costs.
 *  5. Leads and obligations: a lead pipeline (source, lawful basis, stage, value, next action and its date — due leads wake
 *     the agent) and recurring / dated obligations (renewals, retainers, follow-ups, deadlines) that wake it when due; paid
 *     orders approaching or past their due date wake it too. Stale contact data of closed leads is erased after a year.
 *  6. Lawful outreach: first-contact marketing mail (mail.send {outreach: true}) names its lawful basis and recipient type
 *     (an individual needs consent or an existing customer relationship), goes to one recipient, states the legal seller
 *     and carries a working opt-out link (/u/<token> on the public site); an address that opted out is never written to
 *     first again by any agent (replies and its own orders excepted).
 *  7. Sales and payouts on other channels: the agent reports each external sale (memo, never cash); a payout is cash only
 *     when matched to a real credit in the treasury PayPal — automatically when the transaction, its amount and its
 *     counterparty (the channel's payout payer) match unambiguously; otherwise the owner decides (a bank receipt must first
 *     reach the treasury PayPal). Booked as provider_revenue_receipt, attributed to the venture.
 *  8. Venture P&L: PayPal refunds count as refunds (not reduced revenue); processor fees are their own category.
 *  9. The shared library: bf-channels v2 (channels are the agent's choice; the browser operates any platform whose terms
 *     permit it — a missing API is not a ban), bf-production-tools v2 (decks, rendering, uploads, view_image) and the dated
 *     capability status v6.
 * Nothing here moves money on its own, changes a live flag, opens sales or grants authority. Outward actions stay under the
 * preparation hold while sales are closed.
 */
import { V28_SQL } from "./migrations-phase28.js";
import { V37_SQL } from "./migrations-phase37.js";
import { V41_SQL } from "./migrations-phase41.js";
import { V49_SQL } from "./migrations-phase49.js";
import { V51_SQL } from "./migrations-phase51.js";
import { V76_SQL } from "./migrations-phase76.js";
import { V78_SQL } from "./migrations-phase78.js";
import { restate as restateRaw } from "./migrations-phase42.js";
import { KNOWLEDGE_FOUNDATION_V2 } from "./knowledge-foundation-v2.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const lit = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'`;
/** v79: the library entries this release corrects (channels are the agent's choice; production tools; dated capability status v6). */
export const LIBRARY_ENTRIES_V79 = ["bf-channels", "bf-production-tools", "fleet-capability-status"] as const;

export const EVENT_ROUTES_V79 = Object.freeze({
  P2_IMPORTANT: ["channel_payout_needs_owner"],
  P3_SUMMARY: ["channel_payout_booked", "outreach_opt_out"],
} as const);

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
/** v79: what an agent may stage for upload to a site (or for rendering: html / svg). */
export const BROWSER_STAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml", "application/pdf", "text/plain", "text/csv",
  "text/html", "text/markdown", "application/json", "application/zip", DOCX, XLSX, PPTX, "video/mp4", "audio/mpeg"] as const;
/** v79: the largest file staged for a page or handed back from one (the same bound as every other file path). */
export const BROWSER_FILE_MAX_BYTES = 15_000_000;
export const BROWSER_FILE_TTL_HOURS = 24;
export const BROWSER_STEPS_V79 = ["upload_file", "set_content", "download", "screenshot", "pdf", "hover", "uncheck", "scroll", "wait_idle", "tab", "dialog"] as const;
const STEPS_ALL = ["goto", "click", "fill", "select", "check", "press", "wait", "wait_for", "open_auth_link", "capture", "back", "upload", ...BROWSER_STEPS_V79];

export const CHANNEL_KINDS = ["own_pages", "marketplace", "social", "classifieds", "community", "email", "ads", "directory", "referral", "direct", "other"] as const;
/** Channels on someone else's platform: the agent records the rules it checked (automation / AI operation, selling) before going live. */
const THIRD_PARTY_KINDS = ["marketplace", "social", "classifieds", "community", "ads", "directory", "other"] as const;
export const PRESENCE_KINDS = ["profile", "listing", "service_ad", "post", "page", "ad_campaign", "message_template", "other"] as const;
export const LEAD_STAGES = ["new", "contacted", "qualified", "quoted", "won", "lost", "dormant"] as const;
export const LEAD_BASES = ["inbound", "enquiry", "existing_customer", "referral", "consent", "b2b_legitimate_interest", "public_listing"] as const;
export const OUTREACH_BASES = ["consent", "existing_customer", "b2b_legitimate_interest"] as const;
export const OBLIGATION_RECUR = ["none", "daily", "weekly", "monthly", "quarterly", "yearly"] as const;
export const LEAD_RETENTION_DAYS = 365;

export const AGENT_OPS_V79 = ["browser.stage_file", "browser.files", "browser.fetch_file", "account.password_confirm", "account.password_discard",
  "channel.add", "channel.update", "channel.list", "channel.link", "presence.record", "presence.update", "presence.list",
  "lead.add", "lead.update", "lead.list", "obligation.add", "obligation.done", "obligation.cancel", "obligation.list",
  "outreach.suppress", "outreach.check", "sale.report", "sale.update", "sale.list", "payout.claim", "payout.list", "business.performance"] as const;
export const FILE_CARRYING_OPS_V79 = ["storefront.file", "order.deliver", "offer.file", "order.stage_file", "browser.stage_file"] as const;

const NAME_RE = `'^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$'`;
const UUID_RE = `'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;
const HTTPS_RE = `'^https://[^[:space:]]{4,255}$'`;
const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;`;
const TOKEN = `replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')`;

// ── 1. Browser: the step grammar ──
const STEPS_VALID = restate(V51_SQL, "fleet_browser_steps_valid", [
  [`    IF v_a NOT IN ('goto','click','fill','select','check','press','wait','wait_for','open_auth_link','capture','back','upload') THEN
      PERFORM fleet_econ_bad('action is goto|click|fill|select|check|press|wait|wait_for|open_auth_link|capture|back|upload');
    END IF;`,
   `    IF v_a NOT IN (${q(STEPS_ALL)}) THEN
      PERFORM fleet_econ_bad('action is ${STEPS_ALL.join("|")}');
    END IF;
    -- v79: an element inside an embedded frame; files the agent staged; rendering its own HTML; page captures.
    IF s ? 'frame' AND (jsonb_typeof(s -> 'frame') <> 'string' OR length(s ->> 'frame') NOT BETWEEN 1 AND 300) THEN
      PERFORM fleet_econ_bad('frame is the selector of the iframe that holds the element');
    END IF;
    IF v_a IN ('hover','download') AND (s ->> 'selector') IS NULL AND (s ->> 'text') IS NULL THEN PERFORM fleet_econ_bad(v_a || ' needs a selector or text'); END IF;
    IF v_a IN ('uncheck','upload_file') AND length(COALESCE(s ->> 'selector', '')) NOT BETWEEN 1 AND 300 THEN PERFORM fleet_econ_bad(v_a || ' needs a selector'); END IF;
    IF v_a = 'upload_file' THEN
      IF (s ? 'fileId') = (s ? 'fileIds') THEN PERFORM fleet_econ_bad('upload_file takes fileId or fileIds (from browser stage_file)'); END IF;
      IF s ? 'fileId' AND COALESCE(s ->> 'fileId', '') !~ ${UUID_RE} THEN PERFORM fleet_econ_bad('fileId is a staged file id'); END IF;
      IF s ? 'fileIds' AND (jsonb_typeof(s -> 'fileIds') <> 'array' OR jsonb_array_length(s -> 'fileIds') NOT BETWEEN 1 AND 10
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(s -> 'fileIds') f WHERE jsonb_typeof(f) <> 'string' OR f #>> '{}' !~ ${UUID_RE})) THEN
        PERFORM fleet_econ_bad('fileIds is 1..10 staged file ids');
      END IF;
    END IF;
    IF v_a = 'set_content' AND (COALESCE(s ->> 'fileId', '') !~ ${UUID_RE} OR p_has_account) THEN
      PERFORM fleet_econ_bad('set_content renders a staged .html or .svg file (fileId) in a session opened without an account');
    END IF;
    IF v_a = 'scroll' AND (s ->> 'selector') IS NULL AND COALESCE(s ->> 'to', '') NOT IN ('top','bottom') THEN PERFORM fleet_econ_bad('scroll needs a selector or to: top|bottom'); END IF;
    IF v_a = 'tab' AND (jsonb_typeof(s -> 'index') <> 'number' OR (s ->> 'index')::numeric NOT IN (0,1,2,3,4,5,6,7,8,9)) THEN PERFORM fleet_econ_bad('tab index is 0..9'); END IF;
    IF v_a = 'dialog' AND (jsonb_typeof(s -> 'accept') IS DISTINCT FROM 'boolean' OR length(COALESCE(s ->> 'text', '')) > 500) THEN
      PERFORM fleet_econ_bad('dialog needs accept: true|false and an optional text (a prompt''s answer, <= 500)');
    END IF;
    IF v_a IN ('screenshot','pdf') AND ((s ? 'fullPage' AND jsonb_typeof(s -> 'fullPage') <> 'boolean') OR (s ? 'landscape' AND jsonb_typeof(s -> 'landscape') <> 'boolean')) THEN
      PERFORM fleet_econ_bad('fullPage / landscape are true|false');
    END IF;`],
  [`      IF s ? 'credential' AND (s ->> 'credential') NOT IN ('password','username','email','totp','email_code','sms_code','api_key','generate_password', 'owner_fact', 'owner_card') THEN
        PERFORM fleet_econ_bad('credential is password|username|email|totp|email_code|sms_code|api_key|generate_password|owner_fact|owner_card');
      END IF;`,
   `      IF s ? 'credential' AND (s ->> 'credential') NOT IN ('password','username','email','totp','email_code','sms_code','api_key','generate_password','new_password', 'owner_fact', 'owner_card') THEN
        PERFORM fleet_econ_bad('credential is password|username|email|totp|email_code|sms_code|api_key|generate_password|new_password|owner_fact|owner_card');
      END IF;`],
]);

// ── 2. Credentials: a new password is pending until the site is confirmed to accept it ──
const CREDENTIAL_RECORD = restate(V37_SQL, "ix_browser_credential_record", [
  [`  UPDATE fleet_agent_account_credentials SET status = 'rotated', retired_at = now() WHERE account_id = r.account_id AND kind = p_kind AND status = 'active';`,
   `  -- v79: a new password for an account that already has one waits as PENDING (the old one keeps working) until the agent
  -- confirms the site accepted it (account.password_confirm) — a rejected change can no longer lock the account out.
  IF p_kind = 'password' AND EXISTS (SELECT 1 FROM fleet_agent_account_credentials WHERE account_id = r.account_id AND kind = 'password' AND status = 'active') THEN
    UPDATE fleet_agent_account_credentials SET status = 'rotated', retired_at = now() WHERE account_id = r.account_id AND kind = 'password' AND status = 'pending';
    INSERT INTO fleet_agent_account_credentials (credential_id, account_id, agent_id, kind, vault_ref, status) VALUES (gen_random_uuid(), r.account_id, r.agent_id, 'password', p_vault_ref, 'pending');
    PERFORM fleet_event('browser_credential_pending', r.agent_id, 'identity-broker', jsonb_build_object('accountId', r.account_id, 'kind', 'password'));
    RETURN jsonb_build_object('ok', true, 'pending', true);
  END IF;
  UPDATE fleet_agent_account_credentials SET status = 'rotated', retired_at = now() WHERE account_id = r.account_id AND kind = p_kind AND status = 'active';`],
]);
const SECRETS_PENDING = restate(V49_SQL, "ix_browser_secrets_pending", [
  [`      'credentials', COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', c.kind, 'vaultRef', c.vault_ref)) FROM fleet_agent_account_credentials c
                                WHERE c.account_id = r.account_id AND c.status = 'active'), '[]'::jsonb),`,
   `      'credentials', COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', c.kind, 'vaultRef', c.vault_ref, 'status', c.status)) FROM fleet_agent_account_credentials c
                                WHERE c.account_id = r.account_id AND c.status IN ('active','pending')), '[]'::jsonb),`],
]);

// ── 6. Lawful outreach: restated mail.send ──
const MAIL_SEND = restate(V41_SQL, "fleet_econ_mail_send", [
  [`        v_venture text := fleet_econ_venture_ref(p_agent, a); v_account uuid; v_thread uuid; ch fleet_comms_providers;`,
   `        v_venture text := fleet_econ_venture_ref(p_agent, a); v_account uuid; v_thread uuid; ch fleet_comms_providers;
        v_outreach boolean := false; v_basis text; v_rtype text; v_lead fleet_leads; v_token text; v_footer text := '';`],
  [`  IF v_body IS NULL OR length(v_body) NOT BETWEEN 1 AND 100000 THEN PERFORM fleet_econ_bad('body is 1..100000 characters'); END IF;`,
   `  IF v_body IS NULL OR length(v_body) NOT BETWEEN 1 AND 100000 THEN PERFORM fleet_econ_bad('body is 1..100000 characters'); END IF;
  -- v79: an address that opted out is never written to first again (by any agent); replying to its own message, and mail
  -- about its own order or brief with this agent, still reach it.
  IF NOT (a ? 'inReplyTo') THEN
    FOREACH x IN ARRAY v_to LOOP
      IF EXISTS (SELECT 1 FROM fleet_outreach_suppressions WHERE address_sha256 = fleet_address_sha(x))
         AND NOT EXISTS (SELECT 1 FROM fleet_customer_orders WHERE agent_id = p_agent AND lower(buyer_email) = x)
         AND NOT EXISTS (SELECT 1 FROM fleet_offer_enquiries WHERE agent_id = p_agent AND lower(buyer_email) = x) THEN
        RAISE EXCEPTION 'FLEET_OUTREACH_SUPPRESSED: % asked not to be contacted; only replies to their own messages and mail about their own orders may reach them', x;
      END IF;
    END LOOP;
  END IF;
  -- v79: first-contact marketing (outreach) is lawful, personal and identifiable, with a working opt-out.
  IF a ? 'outreach' AND jsonb_typeof(a -> 'outreach') <> 'boolean' THEN PERFORM fleet_econ_bad('outreach is true|false'); END IF;
  v_outreach := COALESCE((a ->> 'outreach')::boolean, false);
  IF v_outreach THEN
    v_basis := fleet_econ_text(a, 'basis', 40, true); v_rtype := fleet_econ_text(a, 'recipientType', 20, true);
    IF v_basis NOT IN (${q(OUTREACH_BASES)}) THEN PERFORM fleet_econ_bad('basis is ${OUTREACH_BASES.join("|")}'); END IF;
    IF v_rtype NOT IN ('business','individual') THEN PERFORM fleet_econ_bad('recipientType is business (a company address) | individual (a person, incl. sole traders)'); END IF;
    IF v_rtype = 'individual' AND v_basis = 'b2b_legitimate_interest' THEN
      RAISE EXCEPTION 'FLEET_OUTREACH_BASIS: marketing email to an individual needs their consent or an existing customer relationship (soft opt-in) — UK PECR / EU ePrivacy';
    END IF;
    IF cardinality(v_to) <> 1 THEN RAISE EXCEPTION 'FLEET_OUTREACH_ONE_RECIPIENT: outreach is personal: one recipient per message'; END IF;
    IF v_basis = 'existing_customer' AND NOT EXISTS (SELECT 1 FROM fleet_customer_orders WHERE agent_id = p_agent AND lower(buyer_email) = v_to[1]
        AND payment_status IN ('paid','partially_refunded')) THEN
      RAISE EXCEPTION 'FLEET_OUTREACH_BASIS: % has not bought from you (existing_customer needs a paid order)', v_to[1];
    END IF;
    IF v_venture IS NULL THEN PERFORM fleet_econ_bad('outreach names the venture it is for (ventureKey)'); END IF;
    IF NOT EXISTS (SELECT 1 FROM fleet_seller_identity WHERE id = 1) OR NOT EXISTS (SELECT 1 FROM fleet_public_site WHERE id = 1) THEN
      RAISE EXCEPTION 'FLEET_OUTREACH_IDENTITY: outreach states who is writing and how to opt out: it needs the legal seller and the public site (owner)';
    END IF;
    IF a ? 'leadId' THEN
      SELECT * INTO v_lead FROM fleet_leads WHERE lead_id = fleet_identity_uuid(a, 'leadId') AND agent_id = p_agent;
      IF NOT FOUND THEN PERFORM fleet_econ_bad('leadId is one of your leads'); END IF;
    END IF;
    v_token := ${TOKEN};
    v_footer := E'\\n\\n--\\n' || COALESCE(fleet_seller_notice(v_venture::uuid), '') || E'\\nYou received this message because '
      || CASE v_basis WHEN 'consent' THEN 'you agreed to hear from us' WHEN 'existing_customer' THEN 'you bought from us'
              ELSE 'your business may find this offer useful' END
      || '. To hear nothing more from us: ' || (SELECT base_url FROM fleet_public_site WHERE id = 1) || '/u/' || v_token || E' (or reply "stop").';
  END IF;`],
  [`    VALUES (v_id, b.mailbox_id, p_agent, b.address, v_subject, fleet_scrub_mail(v_body), 'out', v_to, rp.message_id, 'queued',`,
   `    VALUES (v_id, b.mailbox_id, p_agent, b.address, v_subject, fleet_scrub_mail(v_body) || v_footer, 'out', v_to, rp.message_id, 'queued',`],
  [`  r := fleet_identity_enqueue(p_agent, NULL, 'mail.send', jsonb_build_object('messageId', v_id), v_idem);`,
   `  IF v_outreach THEN
    INSERT INTO fleet_outreach_messages (message_id, agent_id, venture_id, lead_id, address_sha256, basis, recipient_type, token_sha256)
      VALUES (v_id, p_agent, v_venture::uuid, v_lead.lead_id, fleet_address_sha(v_to[1]), v_basis, v_rtype, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'));
    IF v_lead.lead_id IS NOT NULL AND v_lead.stage = 'new' THEN UPDATE fleet_leads SET stage = 'contacted', updated_at = now() WHERE lead_id = v_lead.lead_id; END IF;
  END IF;
  r := fleet_identity_enqueue(p_agent, NULL, 'mail.send', jsonb_build_object('messageId', v_id), v_idem);`],
]);

// ── 5. Wake-ups: due leads, due obligations, paid orders near or past their due date ──
const ORDER_DUE = `(SELECT c.captured_at + make_interval(days => o.turnaround_days) FROM fleet_paypal_checkouts c WHERE c.checkout_id = o.checkout_id)`;
const ATTENTION = restate(V76_SQL, "fleet_agent_attention", [
  [`      (SELECT COALESCE(string_agg(order_id::text || ':' || status, ',' ORDER BY order_id), '') FROM fleet_customer_orders
        WHERE agent_id = p_agent AND payment_status = 'paid' AND status IN ('to_fulfil','delivery_failed')))),`,
   `      (SELECT COALESCE(string_agg(order_id::text || ':' || status, ',' ORDER BY order_id), '') FROM fleet_customer_orders
        WHERE agent_id = p_agent AND payment_status = 'paid' AND status IN ('to_fulfil','delivery_failed')),
      -- v79: the dated work coming due changes the digest when it comes due (a lead's next action, an obligation, an order's due date).
      (SELECT count(*) FROM fleet_leads WHERE agent_id = p_agent AND stage NOT IN ('won','lost') AND next_action_at <= now()),
      (SELECT count(*) || ':' || COALESCE(max(due_at)::text, '') FROM fleet_business_obligations WHERE agent_id = p_agent AND status = 'open' AND due_at <= now()),
      (SELECT count(*) FROM fleet_customer_orders o WHERE o.agent_id = p_agent AND o.payment_status = 'paid' AND o.status IN ('to_fulfil','delivery_failed')
        AND ${ORDER_DUE} <= now() + interval '24 hours'))),`],
  [`        UNION ALL SELECT jsonb_build_object('kind', 'dispute', 'id', dispute_id,`,
   `        UNION ALL SELECT jsonb_build_object('kind', 'lead_due', 'id', lead_id, 'status', stage, 'at', next_action_at, 'tool', 'business leads')
          FROM fleet_leads WHERE agent_id = p_agent AND stage NOT IN ('won','lost') AND next_action_at <= now() AND next_action_at > now() - interval '14 days'
        UNION ALL SELECT jsonb_build_object('kind', 'obligation_due', 'id', obligation_id, 'status', recur, 'at', due_at, 'tool', 'business obligations')
          FROM fleet_business_obligations WHERE agent_id = p_agent AND status = 'open' AND due_at <= now() AND due_at > now() - interval '14 days'
        UNION ALL SELECT jsonb_build_object('kind', CASE WHEN ${ORDER_DUE} <= now() THEN 'order_overdue' ELSE 'order_due_soon' END, 'id', o.order_id,
            'status', o.status, 'at', ${ORDER_DUE}, 'tool', 'customers order_thread')
          FROM fleet_customer_orders o WHERE o.agent_id = p_agent AND o.payment_status = 'paid' AND o.status IN ('to_fulfil','delivery_failed')
           AND ${ORDER_DUE} <= now() + interval '24 hours'
        UNION ALL SELECT jsonb_build_object('kind', 'dispute', 'id', dispute_id,`],
]);

// ── 8. Venture P&L: PayPal refunds are refunds; processor fees their own category ──
const VENTURE_FIN = restate(V28_SQL, "fleet_venture_financials", [
  [`FILTER (WHERE class = 'agent_revenue' AND kind <> 'external_refund'), 0) AS revenue,`,
   `FILTER (WHERE class = 'agent_revenue' AND kind NOT IN ('external_refund','paypal_clawback')), 0) AS revenue,`],
  [`FILTER (WHERE class = 'agent_revenue' AND kind = 'external_refund'), 0) AS refunds,`,
   `FILTER (WHERE class = 'agent_revenue' AND kind IN ('external_refund','paypal_clawback')), 0) AS refunds,`],
  [`      SELECT cost_category, sum(CASE WHEN side = 'D' THEN amount_cents ELSE -amount_cents END) AS amt FROM p
       WHERE class IN ('agent_expense','agent_fees') GROUP BY cost_category) x`,
   `      SELECT CASE WHEN class = 'agent_fees' THEN 'processor_fee' ELSE cost_category END AS cost_category,
             sum(CASE WHEN side = 'D' THEN amount_cents ELSE -amount_cents END) AS amt FROM p
       WHERE class IN ('agent_expense','agent_fees') GROUP BY 1) x`],
]);

// ── The dispatcher ──
const DISPATCH = restate(V76_SQL, "api_economy", [
  [`WHEN 'order.refund' THEN 'planning'`, `WHEN 'order.refund' THEN 'planning' ${AGENT_OPS_V79.map((o) => `WHEN '${o}' THEN 'planning'`).join(" ")}`],
  [`CASE WHEN p_op IN ('storefront.file','order.deliver','offer.file','order.stage_file') THEN 21000000`, `CASE WHEN p_op IN (${q(FILE_CARRYING_OPS_V79)}) THEN 21000000`],
  [`CASE WHEN p_op IN ('storefront.file','order.deliver','offer.file','order.stage_file') THEN 'arguments are a JSON object (a file of at most 15 MB)'`,
   `CASE WHEN p_op IN (${q(FILE_CARRYING_OPS_V79)}) THEN 'arguments are a JSON object (a file of at most 15 MB)'`],
  [`      WHEN 'order.refund' THEN fleet_econ_order_refund(p_agent, a)`,
   `      WHEN 'order.refund' THEN fleet_econ_order_refund(p_agent, a)
      ${AGENT_OPS_V79.map((o) => `WHEN '${o}' THEN fleet_econ_${o.replace(".", "_")}(p_agent, a)`).join("\n      ")}`],
  [`|NO_RECEIVING_RAIL|PUBLIC_SITE_[A-Z_]+):'`, `|NO_RECEIVING_RAIL|PUBLIC_SITE_[A-Z_]+|CHANNEL_[A-Z_]+|PRESENCE_[A-Z_]+|LEAD_[A-Z_]+|OBLIGATION_[A-Z_]+|OUTREACH_[A-Z_]+|SALE_[A-Z_]+|PAYOUT_[A-Z_]+|CREDENTIAL_[A-Z_]+):'`],
]);

const EVENT_ROUTE = restate(V78_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V79) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);

export const V79_SQL = `
-- ═══ 1. Browser files: staged by the agent for a page, or produced by a page for the agent (24 h) ═══
CREATE TABLE fleet_browser_files (
  file_id       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      text        NOT NULL REFERENCES fleet_agents(agent_id),
  direction     text        NOT NULL CHECK (direction IN ('to_page','from_page')),
  source        text        NOT NULL CHECK (source IN ('staged','download','screenshot','pdf')),
  session_id    uuid        REFERENCES fleet_browser_sessions(session_id),
  action_id     uuid        REFERENCES fleet_browser_actions(action_id),
  file_name     text        NOT NULL CHECK (file_name ~ ${NAME_RE}),
  content_type  text        NOT NULL CHECK (content_type ~ '^[a-z]+/[a-z0-9.+-]{1,100}$'),
  size_bytes    integer     NOT NULL CHECK (size_bytes BETWEEN 1 AND ${BROWSER_FILE_MAX_BYTES}),
  sha256        text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes         bytea,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '${BROWSER_FILE_TTL_HOURS} hours',
  CHECK ((direction = 'to_page') = (source = 'staged')),
  CHECK (bytes IS NULL OR octet_length(bytes) = size_bytes)
);
CREATE INDEX fleet_browser_files_agent ON fleet_browser_files (agent_id, created_at DESC);
CREATE INDEX fleet_browser_files_live ON fleet_browser_files (expires_at) WHERE bytes IS NOT NULL;

CREATE FUNCTION fleet_browser_files_expire() RETURNS void LANGUAGE sql
SET search_path = @@SCHEMA@@, pg_temp AS $$
  UPDATE fleet_browser_files SET bytes = NULL WHERE bytes IS NOT NULL AND expires_at <= now()
$$;
CREATE FUNCTION fleet_browser_file_json(f fleet_browser_files) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('fileId', f.file_id, 'direction', f.direction, 'source', f.source, 'fileName', f.file_name,
    'contentType', f.content_type, 'sizeBytes', f.size_bytes, 'sha256', f.sha256, 'sessionId', f.session_id, 'createdAt', f.created_at,
    'expiresAt', f.expires_at, 'available', f.bytes IS NOT NULL))
$$;

CREATE FUNCTION fleet_econ_browser_stage_file(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_name text := fleet_econ_text(a, 'fileName', 120, true); v_type text := fleet_econ_text(a, 'contentType', 100, true); v_bytes bytea; f fleet_browser_files;
BEGIN
  PERFORM fleet_browser_files_expire();
  IF v_name !~ ${NAME_RE} THEN PERFORM fleet_econ_bad('fileName is a plain file name (letters, digits, . _ - and spaces)'); END IF;
  IF v_type NOT IN (${q(BROWSER_STAGE_TYPES)}) THEN PERFORM fleet_econ_bad('contentType is an image, PDF, text, CSV, HTML, Markdown, JSON, ZIP, DOCX, XLSX, PPTX, MP4 or MP3 type'); END IF;
  BEGIN
    v_bytes := decode(COALESCE(a ->> 'contentB64', ''), 'base64');
  EXCEPTION WHEN others THEN PERFORM fleet_econ_bad('contentB64 is base64');
  END;
  IF octet_length(v_bytes) NOT BETWEEN 1 AND ${BROWSER_FILE_MAX_BYTES} THEN PERFORM fleet_econ_bad('a staged file is 1 byte .. 15 MB'); END IF;
  IF (SELECT count(*) FROM fleet_browser_files WHERE agent_id = p_agent AND direction = 'to_page' AND bytes IS NOT NULL) >= 50 THEN
    RAISE EXCEPTION 'FLEET_INFRASTRUCTURE_CEILING: an infrastructure failsafe against runaway loops was hit (50 staged files live)';
  END IF;
  INSERT INTO fleet_browser_files (agent_id, direction, source, file_name, content_type, size_bytes, sha256, bytes)
    VALUES (p_agent, 'to_page', 'staged', v_name, v_type, octet_length(v_bytes), encode(sha256(v_bytes), 'hex'), v_bytes) RETURNING * INTO f;
  RETURN jsonb_build_object('ok', true) || fleet_browser_file_json(f)
    || jsonb_build_object('next', 'browser act {sessionId, steps: [{action: "upload_file", selector: <the file input>, fileIds: [fileId]}]} — or set_content {fileId} to render an .html / .svg');
END $$;

CREATE FUNCTION fleet_econ_browser_files(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_browser_files_expire();
  RETURN jsonb_build_object('ok', true, 'files', COALESCE((SELECT jsonb_agg(fleet_browser_file_json(f) ORDER BY f.created_at DESC) FROM (
      SELECT * FROM fleet_browser_files WHERE agent_id = p_agent AND created_at > now() - interval '48 hours' ORDER BY created_at DESC LIMIT 60) f), '[]'::jsonb));
END $$;

CREATE FUNCTION fleet_econ_browser_fetch_file(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE f fleet_browser_files;
BEGIN
  PERFORM fleet_browser_files_expire();
  SELECT * INTO f FROM fleet_browser_files WHERE file_id = fleet_identity_uuid(a, 'fileId') AND agent_id = p_agent;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such browser file of yours'; END IF;
  IF f.bytes IS NULL THEN RAISE EXCEPTION 'FLEET_BROWSER_FILE_EXPIRED: browser files are kept ${BROWSER_FILE_TTL_HOURS} hours; capture it again'; END IF;
  RETURN jsonb_build_object('ok', true) || fleet_browser_file_json(f) || jsonb_build_object('contentB64', encode(f.bytes, 'base64'));
END $$;

-- The worker: read a file the action's agent staged; store one a page produced for that agent.
CREATE FUNCTION bx_file_take(p_action uuid, p_lease text, p_file uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_browser_actions := bx_leased(p_action, p_lease); f fleet_browser_files;
BEGIN
  SELECT * INTO f FROM fleet_browser_files WHERE file_id = p_file AND agent_id = x.agent_id AND direction = 'to_page' AND bytes IS NOT NULL AND expires_at > now();
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BROWSER_FILE_UNAVAILABLE'); END IF;
  RETURN jsonb_build_object('ok', true, 'fileName', f.file_name, 'contentType', f.content_type, 'dataB64', encode(f.bytes, 'base64'));
END $$;

CREATE FUNCTION bx_file_put(p_action uuid, p_lease text, p_kind text, p_name text, p_type text, p_bytes bytea) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_browser_actions := bx_leased(p_action, p_lease); v_id uuid;
BEGIN
  IF p_kind NOT IN ('download','screenshot','pdf') OR p_name IS NULL OR p_name !~ ${NAME_RE} OR p_type IS NULL OR p_type !~ '^[a-z]+/[a-z0-9.+-]{1,100}$'
     OR p_bytes IS NULL OR octet_length(p_bytes) NOT BETWEEN 1 AND ${BROWSER_FILE_MAX_BYTES} THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BROWSER_FILE_INVALID');
  END IF;
  IF (SELECT count(*) FROM fleet_browser_files WHERE agent_id = x.agent_id AND direction = 'from_page' AND created_at > now() - interval '1 day') >= 300 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INFRASTRUCTURE_CEILING');
  END IF;
  INSERT INTO fleet_browser_files (agent_id, direction, source, session_id, action_id, file_name, content_type, size_bytes, sha256, bytes)
    VALUES (x.agent_id, 'from_page', p_kind, x.session_id, x.action_id, p_name, p_type, octet_length(p_bytes), encode(sha256(p_bytes), 'hex'), p_bytes)
    RETURNING file_id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'fileId', v_id);
END $$;

${STEPS_VALID}

-- ═══ 2. Credentials: pending passwords; new_password fills the pending one ═══
ALTER TABLE fleet_agent_account_credentials DROP CONSTRAINT fleet_agent_account_credentials_status_check;
ALTER TABLE fleet_agent_account_credentials ADD CONSTRAINT fleet_agent_account_credentials_status_check
  CHECK (status IN ('active','pending','rotated','revoked','compromised'));
CREATE UNIQUE INDEX fleet_agent_account_credentials_one_pending ON fleet_agent_account_credentials (account_id, kind) WHERE status = 'pending';
ALTER TABLE fleet_browser_secret_requests DROP CONSTRAINT fleet_browser_secret_requests_kind_check;
ALTER TABLE fleet_browser_secret_requests ADD CONSTRAINT fleet_browser_secret_requests_kind_check
  CHECK (kind IN ('password','username','email','totp','email_code','sms_code','api_key','generate_password','new_password','auth_link','capture','owner_fact','owner_card','owner_document'));

${CREDENTIAL_RECORD}
${SECRETS_PENDING}

CREATE FUNCTION fleet_econ_account_password_confirm(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_agent_accounts;
BEGIN
  SELECT * INTO x FROM fleet_agent_accounts WHERE account_id = fleet_identity_uuid(a, 'accountId') AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such account of yours'; END IF;
  IF NOT EXISTS (SELECT 1 FROM fleet_agent_account_credentials WHERE account_id = x.account_id AND kind = 'password' AND status = 'pending') THEN
    RAISE EXCEPTION 'FLEET_CREDENTIAL_NONE_PENDING: no new password is waiting for this account';
  END IF;
  UPDATE fleet_agent_account_credentials SET status = 'rotated', retired_at = now() WHERE account_id = x.account_id AND kind = 'password' AND status = 'active';
  UPDATE fleet_agent_account_credentials SET status = 'active' WHERE account_id = x.account_id AND kind = 'password' AND status = 'pending';
  PERFORM fleet_event('browser_credential_confirmed', p_agent, p_agent, jsonb_build_object('accountId', x.account_id, 'kind', 'password'));
  RETURN jsonb_build_object('ok', true, 'note', 'the new password is now the account''s password');
END $$;

CREATE FUNCTION fleet_econ_account_password_discard(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_agent_accounts; n integer;
BEGIN
  SELECT * INTO x FROM fleet_agent_accounts WHERE account_id = fleet_identity_uuid(a, 'accountId') AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such account of yours'; END IF;
  UPDATE fleet_agent_account_credentials SET status = 'rotated', retired_at = now() WHERE account_id = x.account_id AND kind = 'password' AND status = 'pending';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'discarded', n, 'note', 'the account keeps its current password');
END $$;

-- ═══ 3. Channels and presence (the agent's own choice; any platform) ═══
CREATE TABLE fleet_venture_channels (
  channel_id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id            text        NOT NULL REFERENCES fleet_agents(agent_id),
  venture_id          uuid        NOT NULL REFERENCES fleet_ventures(venture_id),
  name                text        NOT NULL CHECK (length(name) BETWEEN 2 AND 60),
  kind                text        NOT NULL CHECK (kind IN (${q(CHANNEL_KINDS)})),
  account_id          uuid        REFERENCES fleet_agent_accounts(account_id),
  url                 text        CHECK (url ~ ${HTTPS_RE}),
  status              text        NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','paused','dropped')),
  rules_source        text        CHECK (rules_source ~ ${HTTPS_RE}),
  rules_summary       text        CHECK (length(rules_summary) BETWEEN 20 AND 1000),
  fees_summary        text        CHECK (length(fees_summary) <= 600),
  payout_route        text        CHECK (payout_route IN ('own_checkout','treasury_paypal','owner_bank','none')),
  payout_counterparty text        CHECK (length(payout_counterparty) BETWEEN 3 AND 80),
  ref_code            text        NOT NULL UNIQUE CHECK (ref_code ~ '^[0-9a-f]{12}$'),
  note                text        CHECK (length(note) <= 1000),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venture_id, name)
);
CREATE INDEX fleet_venture_channels_agent ON fleet_venture_channels (agent_id, venture_id);

CREATE TABLE fleet_presence_items (
  item_id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id           text        NOT NULL REFERENCES fleet_agents(agent_id),
  venture_id         uuid        NOT NULL REFERENCES fleet_ventures(venture_id),
  channel_id         uuid        NOT NULL REFERENCES fleet_venture_channels(channel_id),
  kind               text        NOT NULL CHECK (kind IN (${q(PRESENCE_KINDS)})),
  title              text        NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  url                text        CHECK (url ~ ${HTTPS_RE}),
  offer_id           uuid        REFERENCES fleet_offers(offer_id),
  status             text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','live','paused','removed','rejected')),
  external_ref       text        CHECK (length(external_ref) <= 200),
  evidence_action_id uuid        REFERENCES fleet_browser_actions(action_id),
  cost_minor         bigint      CHECK (cost_minor >= 0),
  note               text        CHECK (length(note) <= 1000),
  published_at       timestamptz,
  removed_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_presence_items_channel ON fleet_presence_items (channel_id, status);

CREATE FUNCTION fleet_channel_json(c fleet_venture_channels) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('channelId', c.channel_id, 'ventureKey', (SELECT venture_key FROM fleet_ventures WHERE venture_id = c.venture_id),
    'name', c.name, 'kind', c.kind, 'status', c.status, 'accountId', c.account_id, 'url', c.url, 'rulesSource', c.rules_source, 'rulesSummary', c.rules_summary,
    'feesSummary', c.fees_summary, 'payoutRoute', c.payout_route, 'payoutCounterparty', c.payout_counterparty, 'refCode', c.ref_code, 'note', c.note,
    'liveItems', (SELECT count(*) FROM fleet_presence_items p WHERE p.channel_id = c.channel_id AND p.status = 'live'), 'updatedAt', c.updated_at))
$$;
CREATE FUNCTION fleet_presence_json(p fleet_presence_items) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('itemId', p.item_id, 'channelId', p.channel_id, 'kind', p.kind, 'title', p.title, 'url', p.url, 'offerId', p.offer_id,
    'status', p.status, 'externalRef', p.external_ref, 'evidenceActionId', p.evidence_action_id, 'costMinor', p.cost_minor, 'note', p.note,
    'publishedAt', p.published_at, 'removedAt', p.removed_at, 'updatedAt', p.updated_at))
$$;

-- Shared field handling for channel.add / channel.update (the agent's own record of its channel).
CREATE FUNCTION fleet_channel_apply(p_agent text, c fleet_venture_channels, a jsonb) RETURNS fleet_venture_channels LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_acc uuid;
BEGIN
  IF a ? 'name' THEN c.name := fleet_econ_text(a, 'name', 60, true); END IF;
  IF a ? 'kind' THEN c.kind := fleet_econ_text(a, 'kind', 20, true); END IF;
  IF c.kind IS NULL OR c.kind NOT IN (${q(CHANNEL_KINDS)}) THEN PERFORM fleet_econ_bad('kind is ${CHANNEL_KINDS.join("|")}'); END IF;
  IF a ? 'status' THEN c.status := fleet_econ_text(a, 'status', 20, true); END IF;
  IF c.status NOT IN ('planned','active','paused','dropped') THEN PERFORM fleet_econ_bad('status is planned|active|paused|dropped'); END IF;
  IF a ? 'url' THEN c.url := fleet_econ_text(a, 'url', 263); END IF;
  IF a ? 'rulesSource' THEN c.rules_source := fleet_econ_text(a, 'rulesSource', 263); END IF;
  IF a ? 'rulesSummary' THEN c.rules_summary := fleet_econ_text(a, 'rulesSummary', 1000); END IF;
  IF a ? 'feesSummary' THEN c.fees_summary := fleet_econ_text(a, 'feesSummary', 600); END IF;
  IF a ? 'payoutRoute' THEN c.payout_route := fleet_econ_text(a, 'payoutRoute', 20); END IF;
  IF a ? 'payoutCounterparty' THEN c.payout_counterparty := fleet_econ_text(a, 'payoutCounterparty', 80); END IF;
  IF a ? 'note' THEN c.note := fleet_econ_text(a, 'note', 1000); END IF;
  IF a ? 'accountId' THEN
    IF a ->> 'accountId' IS NULL THEN c.account_id := NULL;
    ELSE
      SELECT account_id INTO v_acc FROM fleet_agent_accounts WHERE account_id = fleet_identity_uuid(a, 'accountId') AND agent_id = p_agent;
      IF v_acc IS NULL THEN PERFORM fleet_econ_bad('accountId is one of your accounts'); END IF;
      c.account_id := v_acc;
    END IF;
  END IF;
  IF length(c.name) < 2 OR (c.rules_summary IS NOT NULL AND length(c.rules_summary) < 20) OR (c.payout_counterparty IS NOT NULL AND length(c.payout_counterparty) < 3)
     OR (c.url IS NOT NULL AND c.url !~ ${HTTPS_RE}) OR (c.rules_source IS NOT NULL AND c.rules_source !~ ${HTTPS_RE}) THEN
    PERFORM fleet_econ_bad('name 2..60, rulesSummary 20..1000, payoutCounterparty 3..80, url / rulesSource https://… (<= 263)');
  END IF;
  IF c.payout_route IS NOT NULL AND c.payout_route NOT IN ('own_checkout','treasury_paypal','owner_bank','none') THEN PERFORM fleet_econ_bad('payoutRoute is own_checkout|treasury_paypal|owner_bank|none'); END IF;
  -- Operating on someone else's platform starts from its rules: what it allows of automated / AI-operated accounts, listings
  -- and outreach, and its fees. Lawful operation, not a business gate: own pages, email, direct and referral need no source.
  IF c.status = 'active' AND c.kind IN (${q(THIRD_PARTY_KINDS)}) AND (c.rules_source IS NULL OR c.rules_summary IS NULL) THEN
    RAISE EXCEPTION 'FLEET_CHANNEL_RULES: before operating on % record the platform rules you checked — rulesSource (the terms / seller policy URL) and rulesSummary (what they allow of automated or AI-operated accounts, listings and outreach, and any disclosure they require)', c.name;
  END IF;
  IF c.payout_route = 'treasury_paypal' AND c.payout_counterparty IS NULL THEN
    PERFORM fleet_econ_bad('a channel paying out to the treasury PayPal names its payoutCounterparty (how the platform appears as the payer, e.g. its name)');
  END IF;
  c.updated_at := now();
  RETURN c;
END $$;

CREATE FUNCTION fleet_econ_channel_add(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_venture uuid; c fleet_venture_channels;
BEGIN
  SELECT venture_id INTO v_venture FROM fleet_ventures WHERE venture_id::text = fleet_econ_venture_ref(p_agent, a) AND agent_id = p_agent;
  IF v_venture IS NULL THEN PERFORM fleet_econ_bad('ventureKey is one of your ventures'); END IF;
  IF (SELECT count(*) FROM fleet_venture_channels WHERE agent_id = p_agent) >= 300 THEN
    RAISE EXCEPTION 'FLEET_INFRASTRUCTURE_CEILING: an infrastructure failsafe against runaway loops was hit (300 channels)';
  END IF;
  c.channel_id := gen_random_uuid(); c.agent_id := p_agent; c.venture_id := v_venture; c.status := 'planned';
  c.ref_code := left(replace(gen_random_uuid()::text, '-', ''), 12); c.created_at := now();
  IF NOT (a ? 'name') OR NOT (a ? 'kind') THEN PERFORM fleet_econ_bad('a channel needs a name (e.g. the platform) and a kind'); END IF;
  c := fleet_channel_apply(p_agent, c, a);
  INSERT INTO fleet_venture_channels SELECT (c).*;
  PERFORM fleet_event('channel_added', p_agent, p_agent, jsonb_build_object('channelId', c.channel_id, 'name', c.name, 'kind', c.kind, 'status', c.status));
  RETURN jsonb_build_object('ok', true, 'channel', fleet_channel_json(c),
    'note', 'record what you publish there with presence record; link to your offer pages with channel link (attribution)');
END $$;

CREATE FUNCTION fleet_econ_channel_update(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_venture_channels;
BEGIN
  SELECT * INTO c FROM fleet_venture_channels WHERE channel_id = fleet_identity_uuid(a, 'channelId') AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such channel of yours'; END IF;
  c := fleet_channel_apply(p_agent, c, a);
  UPDATE fleet_venture_channels SET name = c.name, kind = c.kind, account_id = c.account_id, url = c.url, status = c.status, rules_source = c.rules_source,
         rules_summary = c.rules_summary, fees_summary = c.fees_summary, payout_route = c.payout_route, payout_counterparty = c.payout_counterparty,
         note = c.note, updated_at = now() WHERE channel_id = c.channel_id;
  RETURN jsonb_build_object('ok', true, 'channel', fleet_channel_json(c));
END $$;

CREATE FUNCTION fleet_econ_channel_list(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_venture text := fleet_econ_venture_ref(p_agent, a);
BEGIN
  RETURN jsonb_build_object('ok', true, 'channels', COALESCE((SELECT jsonb_agg(fleet_channel_json(c) ORDER BY c.created_at) FROM fleet_venture_channels c
    WHERE c.agent_id = p_agent AND (v_venture IS NULL OR c.venture_id::text = v_venture)), '[]'::jsonb));
END $$;

-- An offer-page link that carries this channel (attribution of enquiries and orders).
CREATE FUNCTION fleet_econ_channel_link(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_venture_channels; o fleet_offers; v_base text := (SELECT base_url FROM fleet_public_site WHERE id = 1);
BEGIN
  SELECT * INTO c FROM fleet_venture_channels WHERE channel_id = fleet_identity_uuid(a, 'channelId') AND agent_id = p_agent;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such channel of yours'; END IF;
  SELECT * INTO o FROM fleet_offers WHERE offer_id = fleet_identity_uuid(a, 'offerId') AND agent_id = p_agent;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such offer of yours'; END IF;
  IF v_base IS NULL THEN RAISE EXCEPTION 'FLEET_PUBLIC_SITE_UNSET: the owner has not set the public site yet'; END IF;
  RETURN jsonb_build_object('ok', true, 'url', v_base || '/o/' || o.slug || '?ref=' || c.ref_code, 'offerStatus', o.status,
    'note', 'enquiries and orders that arrive through this link are attributed to ' || c.name);
END $$;

CREATE FUNCTION fleet_econ_presence_record(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_venture_channels; p fleet_presence_items; v_offer uuid; v_ev uuid; v_status text := COALESCE(fleet_econ_text(a, 'status', 20), 'draft');
        v_kind text := fleet_econ_text(a, 'kind', 30, true);
BEGIN
  SELECT * INTO c FROM fleet_venture_channels WHERE channel_id = fleet_identity_uuid(a, 'channelId') AND agent_id = p_agent;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such channel of yours'; END IF;
  IF v_kind NOT IN (${q(PRESENCE_KINDS)}) THEN PERFORM fleet_econ_bad('kind is ${PRESENCE_KINDS.join("|")}'); END IF;
  IF v_status NOT IN ('draft','live','paused','removed','rejected') THEN PERFORM fleet_econ_bad('status is draft|live|paused|removed|rejected'); END IF;
  IF v_status = 'live' AND c.status <> 'active' THEN RAISE EXCEPTION 'FLEET_PRESENCE_CHANNEL: % is %; make the channel active first (channel update)', c.name, c.status; END IF;
  IF a ? 'offerId' THEN
    SELECT offer_id INTO v_offer FROM fleet_offers WHERE offer_id = fleet_identity_uuid(a, 'offerId') AND agent_id = p_agent;
    IF v_offer IS NULL THEN PERFORM fleet_econ_bad('offerId is one of your offers'); END IF;
  END IF;
  IF a ? 'evidenceActionId' THEN
    SELECT action_id INTO v_ev FROM fleet_browser_actions WHERE action_id = fleet_identity_uuid(a, 'evidenceActionId') AND agent_id = p_agent;
    IF v_ev IS NULL THEN PERFORM fleet_econ_bad('evidenceActionId is one of your browser actions'); END IF;
  END IF;
  IF (SELECT count(*) FROM fleet_presence_items WHERE agent_id = p_agent) >= 5000 THEN
    RAISE EXCEPTION 'FLEET_INFRASTRUCTURE_CEILING: an infrastructure failsafe against runaway loops was hit (5000 presence items)';
  END IF;
  INSERT INTO fleet_presence_items (agent_id, venture_id, channel_id, kind, title, url, offer_id, status, external_ref, evidence_action_id, cost_minor, note, published_at)
    VALUES (p_agent, c.venture_id, c.channel_id, v_kind, fleet_econ_text(a, 'title', 200, true), fleet_econ_text(a, 'url', 263), v_offer, v_status,
            fleet_econ_text(a, 'externalRef', 200), v_ev, fleet_econ_int(a, 'costMinor', 0, 100000000), fleet_econ_text(a, 'note', 1000),
            CASE WHEN v_status = 'live' THEN now() END) RETURNING * INTO p;
  RETURN jsonb_build_object('ok', true, 'item', fleet_presence_json(p));
END $$;

CREATE FUNCTION fleet_econ_presence_update(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_presence_items; c fleet_venture_channels; v_status text; v_ev uuid;
BEGIN
  SELECT * INTO p FROM fleet_presence_items WHERE item_id = fleet_identity_uuid(a, 'itemId') AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such presence item of yours'; END IF;
  v_status := COALESCE(fleet_econ_text(a, 'status', 20), p.status);
  IF v_status NOT IN ('draft','live','paused','removed','rejected') THEN PERFORM fleet_econ_bad('status is draft|live|paused|removed|rejected'); END IF;
  SELECT * INTO c FROM fleet_venture_channels WHERE channel_id = p.channel_id;
  IF v_status = 'live' AND p.status <> 'live' AND c.status <> 'active' THEN RAISE EXCEPTION 'FLEET_PRESENCE_CHANNEL: % is %; make the channel active first', c.name, c.status; END IF;
  IF a ? 'evidenceActionId' THEN
    SELECT action_id INTO v_ev FROM fleet_browser_actions WHERE action_id = fleet_identity_uuid(a, 'evidenceActionId') AND agent_id = p_agent;
    IF v_ev IS NULL THEN PERFORM fleet_econ_bad('evidenceActionId is one of your browser actions'); END IF;
  END IF;
  UPDATE fleet_presence_items SET status = v_status, title = COALESCE(fleet_econ_text(a, 'title', 200), title), url = COALESCE(fleet_econ_text(a, 'url', 263), url),
         external_ref = COALESCE(fleet_econ_text(a, 'externalRef', 200), external_ref), evidence_action_id = COALESCE(v_ev, evidence_action_id),
         cost_minor = COALESCE(fleet_econ_int(a, 'costMinor', 0, 100000000), cost_minor), note = COALESCE(fleet_econ_text(a, 'note', 1000), note),
         published_at = CASE WHEN v_status = 'live' THEN COALESCE(published_at, now()) ELSE published_at END,
         removed_at = CASE WHEN v_status IN ('removed','rejected') THEN COALESCE(removed_at, now()) ELSE removed_at END, updated_at = now()
   WHERE item_id = p.item_id RETURNING * INTO p;
  RETURN jsonb_build_object('ok', true, 'item', fleet_presence_json(p));
END $$;

CREATE FUNCTION fleet_econ_presence_list(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_venture text := fleet_econ_venture_ref(p_agent, a); v_channel text := fleet_econ_text(a, 'channelId', 40); v_status text := fleet_econ_text(a, 'status', 20);
BEGIN
  RETURN jsonb_build_object('ok', true, 'items', COALESCE((SELECT jsonb_agg(fleet_presence_json(p) ORDER BY p.updated_at DESC) FROM (
    SELECT * FROM fleet_presence_items WHERE agent_id = p_agent AND (v_venture IS NULL OR venture_id::text = v_venture)
       AND (v_channel IS NULL OR channel_id::text = v_channel) AND (v_status IS NULL OR status = v_status) ORDER BY updated_at DESC LIMIT 200) p), '[]'::jsonb));
END $$;

-- ═══ 4. Attribution of enquiries and orders to the channel that brought them ═══
ALTER TABLE fleet_customer_orders ADD COLUMN channel_id uuid REFERENCES fleet_venture_channels(channel_id);
ALTER TABLE fleet_offer_enquiries ADD COLUMN channel_id uuid REFERENCES fleet_venture_channels(channel_id);
CREATE FUNCTION svc_attribute(p_kind text, p_token text, p_ref text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_agent text; v_venture uuid; v_channel uuid;
BEGIN
  IF p_ref IS NULL OR p_ref !~ '^[0-9a-f]{12}$' OR p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' OR p_kind NOT IN ('order','enquiry') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  IF p_kind = 'order' THEN SELECT agent_id, venture_id INTO v_agent, v_venture FROM fleet_customer_orders WHERE access_token = p_token;
  ELSE SELECT e.agent_id, o.venture_id INTO v_agent, v_venture FROM fleet_offer_enquiries e JOIN fleet_offers o ON o.offer_id = e.offer_id WHERE e.access_token = p_token;
  END IF;
  -- Only a channel of the same agent and venture: a code cannot attribute another agent's sale.
  SELECT channel_id INTO v_channel FROM fleet_venture_channels WHERE ref_code = p_ref AND agent_id = v_agent AND venture_id = v_venture;
  IF v_channel IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF p_kind = 'order' THEN UPDATE fleet_customer_orders SET channel_id = v_channel WHERE access_token = p_token AND channel_id IS NULL;
  ELSE UPDATE fleet_offer_enquiries SET channel_id = v_channel WHERE access_token = p_token AND channel_id IS NULL;
  END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- ═══ 5. Leads and obligations ═══
CREATE TABLE fleet_leads (
  lead_id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          text        NOT NULL REFERENCES fleet_agents(agent_id),
  venture_id        uuid        NOT NULL REFERENCES fleet_ventures(venture_id),
  channel_id        uuid        REFERENCES fleet_venture_channels(channel_id),
  name              text        CHECK (length(name) <= 120),
  organisation      text        CHECK (length(organisation) <= 120),
  contact           text        CHECK (length(contact) <= 200),
  contact_kind      text        CHECK (contact_kind IN ('email','phone','handle','url','other')),
  basis             text        NOT NULL CHECK (basis IN (${q(LEAD_BASES)})),
  source            text        NOT NULL CHECK (length(source) BETWEEN 3 AND 300),
  stage             text        NOT NULL DEFAULT 'new' CHECK (stage IN (${q(LEAD_STAGES)})),
  value_minor       bigint      CHECK (value_minor >= 0),
  next_action       text        CHECK (length(next_action) <= 300),
  next_action_at    timestamptz,
  enquiry_id        uuid        REFERENCES fleet_offer_enquiries(enquiry_id),
  order_id          uuid        REFERENCES fleet_customer_orders(order_id),
  notes             text        CHECK (length(notes) <= 2000),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz,
  contact_erased_at timestamptz
);
CREATE INDEX fleet_leads_agent ON fleet_leads (agent_id, stage, next_action_at);

CREATE TABLE fleet_business_obligations (
  obligation_id uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      text        NOT NULL REFERENCES fleet_agents(agent_id),
  venture_id    uuid        NOT NULL REFERENCES fleet_ventures(venture_id),
  title         text        NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  detail        text        CHECK (length(detail) <= 2000),
  due_at        timestamptz NOT NULL,
  recur         text        NOT NULL DEFAULT 'none' CHECK (recur IN (${q(OBLIGATION_RECUR)})),
  order_id      uuid        REFERENCES fleet_customer_orders(order_id),
  lead_id       uuid        REFERENCES fleet_leads(lead_id),
  channel_id    uuid        REFERENCES fleet_venture_channels(channel_id),
  status        text        NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  done_count    integer     NOT NULL DEFAULT 0,
  last_done_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_obligations_agent ON fleet_business_obligations (agent_id, status, due_at);

CREATE FUNCTION fleet_lead_json(l fleet_leads) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('leadId', l.lead_id, 'ventureKey', (SELECT venture_key FROM fleet_ventures WHERE venture_id = l.venture_id),
    'channelId', l.channel_id, 'name', l.name, 'organisation', l.organisation, 'contact', l.contact, 'contactKind', l.contact_kind, 'basis', l.basis,
    'source', l.source, 'stage', l.stage, 'valueMinor', l.value_minor, 'nextAction', l.next_action, 'nextActionAt', l.next_action_at,
    'due', l.next_action_at IS NOT NULL AND l.next_action_at <= now() AND l.stage NOT IN ('won','lost'),
    'enquiryId', l.enquiry_id, 'orderId', l.order_id, 'notes', l.notes, 'updatedAt', l.updated_at, 'contactErased', l.contact_erased_at IS NOT NULL))
$$;

-- Closed leads keep their history but not their personal data beyond ${LEAD_RETENTION_DAYS} days.
CREATE FUNCTION fleet_leads_retention(p_agent text) RETURNS void LANGUAGE sql
SET search_path = @@SCHEMA@@, pg_temp AS $$
  UPDATE fleet_leads SET name = NULL, contact = NULL, organisation = NULL, notes = NULL, contact_erased_at = now()
   WHERE agent_id = p_agent AND stage IN ('lost','dormant','won') AND contact_erased_at IS NULL
     AND COALESCE(closed_at, updated_at) < now() - interval '${LEAD_RETENTION_DAYS} days'
$$;

CREATE FUNCTION fleet_lead_apply(p_agent text, l fleet_leads, a jsonb) RETURNS fleet_leads LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_ch uuid; v_e uuid; v_o uuid;
BEGIN
  IF a ? 'name' THEN l.name := fleet_econ_text(a, 'name', 120); END IF;
  IF a ? 'organisation' THEN l.organisation := fleet_econ_text(a, 'organisation', 120); END IF;
  IF a ? 'contact' THEN l.contact := fleet_econ_text(a, 'contact', 200); END IF;
  IF a ? 'contactKind' THEN l.contact_kind := fleet_econ_text(a, 'contactKind', 10); END IF;
  IF l.contact_kind IS NOT NULL AND l.contact_kind NOT IN ('email','phone','handle','url','other') THEN PERFORM fleet_econ_bad('contactKind is email|phone|handle|url|other'); END IF;
  IF a ? 'basis' THEN l.basis := fleet_econ_text(a, 'basis', 40, true); END IF;
  IF l.basis IS NULL OR l.basis NOT IN (${q(LEAD_BASES)}) THEN PERFORM fleet_econ_bad('basis (why you may contact them) is ${LEAD_BASES.join("|")}'); END IF;
  IF a ? 'source' THEN l.source := fleet_econ_text(a, 'source', 300, true); END IF;
  IF l.source IS NULL OR length(l.source) < 3 THEN PERFORM fleet_econ_bad('source (where and how you found them) is required'); END IF;
  IF a ? 'stage' THEN l.stage := fleet_econ_text(a, 'stage', 20, true); END IF;
  IF l.stage NOT IN (${q(LEAD_STAGES)}) THEN PERFORM fleet_econ_bad('stage is ${LEAD_STAGES.join("|")}'); END IF;
  IF a ? 'valueMinor' THEN l.value_minor := fleet_econ_int(a, 'valueMinor', 0, 100000000000); END IF;
  IF a ? 'nextAction' THEN l.next_action := fleet_econ_text(a, 'nextAction', 300); END IF;
  IF a ? 'nextActionAt' THEN l.next_action_at := NULLIF(a ->> 'nextActionAt', '')::timestamptz; END IF;
  IF a ? 'notes' THEN l.notes := fleet_econ_text(a, 'notes', 2000); END IF;
  IF a ? 'channelId' THEN
    SELECT channel_id INTO v_ch FROM fleet_venture_channels WHERE channel_id = fleet_identity_uuid(a, 'channelId') AND agent_id = p_agent AND venture_id = l.venture_id;
    IF v_ch IS NULL THEN PERFORM fleet_econ_bad('channelId is a channel of this venture'); END IF;
    l.channel_id := v_ch;
  END IF;
  IF a ? 'enquiryId' THEN
    SELECT enquiry_id INTO v_e FROM fleet_offer_enquiries WHERE enquiry_id = fleet_identity_uuid(a, 'enquiryId') AND agent_id = p_agent;
    IF v_e IS NULL THEN PERFORM fleet_econ_bad('enquiryId is one of your enquiries'); END IF;
    l.enquiry_id := v_e;
  END IF;
  IF a ? 'orderId' THEN
    SELECT order_id INTO v_o FROM fleet_customer_orders WHERE order_id = fleet_identity_uuid(a, 'orderId') AND agent_id = p_agent;
    IF v_o IS NULL THEN PERFORM fleet_econ_bad('orderId is one of your orders'); END IF;
    l.order_id := v_o;
  END IF;
  l.closed_at := CASE WHEN l.stage IN ('won','lost') THEN COALESCE(l.closed_at, now()) ELSE NULL END;
  l.updated_at := now();
  RETURN l;
END $$;

CREATE FUNCTION fleet_econ_lead_add(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE l fleet_leads;
BEGIN
  SELECT venture_id INTO l.venture_id FROM fleet_ventures WHERE venture_id::text = fleet_econ_venture_ref(p_agent, a) AND agent_id = p_agent;
  IF l.venture_id IS NULL THEN PERFORM fleet_econ_bad('ventureKey is one of your ventures'); END IF;
  PERFORM fleet_leads_retention(p_agent);
  IF (SELECT count(*) FROM fleet_leads WHERE agent_id = p_agent AND stage NOT IN ('won','lost')) >= 5000 THEN
    RAISE EXCEPTION 'FLEET_INFRASTRUCTURE_CEILING: an infrastructure failsafe against runaway loops was hit (5000 open leads)';
  END IF;
  l.lead_id := gen_random_uuid(); l.agent_id := p_agent; l.stage := 'new'; l.created_at := now();
  l := fleet_lead_apply(p_agent, l, a);
  INSERT INTO fleet_leads SELECT (l).*;
  RETURN jsonb_build_object('ok', true, 'lead', fleet_lead_json(l));
END $$;

CREATE FUNCTION fleet_econ_lead_update(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE l fleet_leads;
BEGIN
  SELECT * INTO l FROM fleet_leads WHERE lead_id = fleet_identity_uuid(a, 'leadId') AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such lead of yours'; END IF;
  l := fleet_lead_apply(p_agent, l, a);
  UPDATE fleet_leads SET channel_id = l.channel_id, name = l.name, organisation = l.organisation, contact = l.contact, contact_kind = l.contact_kind,
         basis = l.basis, source = l.source, stage = l.stage, value_minor = l.value_minor, next_action = l.next_action, next_action_at = l.next_action_at,
         enquiry_id = l.enquiry_id, order_id = l.order_id, notes = l.notes, closed_at = l.closed_at, updated_at = now() WHERE lead_id = l.lead_id;
  RETURN jsonb_build_object('ok', true, 'lead', fleet_lead_json(l));
END $$;

CREATE FUNCTION fleet_econ_lead_list(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_venture text := fleet_econ_venture_ref(p_agent, a); v_stage text := fleet_econ_text(a, 'stage', 20); v_due boolean := COALESCE((a ->> 'due')::boolean, false);
BEGIN
  PERFORM fleet_leads_retention(p_agent);
  RETURN jsonb_build_object('ok', true, 'leads', COALESCE((SELECT jsonb_agg(fleet_lead_json(l) ORDER BY l.next_action_at NULLS LAST, l.updated_at DESC) FROM (
    SELECT * FROM fleet_leads WHERE agent_id = p_agent AND (v_venture IS NULL OR venture_id::text = v_venture) AND (v_stage IS NULL OR stage = v_stage)
       AND (NOT v_due OR (next_action_at <= now() AND stage NOT IN ('won','lost'))) ORDER BY next_action_at NULLS LAST, updated_at DESC LIMIT 200) l), '[]'::jsonb),
    'counts', (SELECT jsonb_object_agg(stage, n) FROM (SELECT stage, count(*) n FROM fleet_leads WHERE agent_id = p_agent
       AND (v_venture IS NULL OR venture_id::text = v_venture) GROUP BY stage) z));
END $$;

CREATE FUNCTION fleet_obligation_json(o fleet_business_obligations) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('obligationId', o.obligation_id, 'ventureKey', (SELECT venture_key FROM fleet_ventures WHERE venture_id = o.venture_id),
    'title', o.title, 'detail', o.detail, 'dueAt', o.due_at, 'due', o.status = 'open' AND o.due_at <= now(), 'recur', o.recur, 'status', o.status,
    'orderId', o.order_id, 'leadId', o.lead_id, 'channelId', o.channel_id, 'doneCount', o.done_count, 'lastDoneAt', o.last_done_at))
$$;

CREATE FUNCTION fleet_econ_obligation_add(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_business_obligations; v_recur text := COALESCE(fleet_econ_text(a, 'recur', 12), 'none');
BEGIN
  SELECT venture_id INTO o.venture_id FROM fleet_ventures WHERE venture_id::text = fleet_econ_venture_ref(p_agent, a) AND agent_id = p_agent;
  IF o.venture_id IS NULL THEN PERFORM fleet_econ_bad('ventureKey is one of your ventures'); END IF;
  IF v_recur NOT IN (${q(OBLIGATION_RECUR)}) THEN PERFORM fleet_econ_bad('recur is ${OBLIGATION_RECUR.join("|")}'); END IF;
  IF NULLIF(a ->> 'dueAt', '') IS NULL THEN PERFORM fleet_econ_bad('dueAt (ISO-8601) is required'); END IF;
  IF (SELECT count(*) FROM fleet_business_obligations WHERE agent_id = p_agent AND status = 'open') >= 2000 THEN
    RAISE EXCEPTION 'FLEET_INFRASTRUCTURE_CEILING: an infrastructure failsafe against runaway loops was hit (2000 open obligations)';
  END IF;
  INSERT INTO fleet_business_obligations (agent_id, venture_id, title, detail, due_at, recur, order_id, lead_id, channel_id)
    VALUES (p_agent, o.venture_id, fleet_econ_text(a, 'title', 200, true), fleet_econ_text(a, 'detail', 2000), (a ->> 'dueAt')::timestamptz, v_recur,
      (SELECT order_id FROM fleet_customer_orders WHERE agent_id = p_agent AND order_id::text = a ->> 'orderId'),
      (SELECT lead_id FROM fleet_leads WHERE agent_id = p_agent AND lead_id::text = a ->> 'leadId'),
      (SELECT channel_id FROM fleet_venture_channels WHERE agent_id = p_agent AND channel_id::text = a ->> 'channelId')) RETURNING * INTO o;
  RETURN jsonb_build_object('ok', true, 'obligation', fleet_obligation_json(o), 'note', 'you are woken when it comes due');
END $$;

CREATE FUNCTION fleet_econ_obligation_done(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_business_obligations; v_step interval;
BEGIN
  SELECT * INTO o FROM fleet_business_obligations WHERE obligation_id = fleet_identity_uuid(a, 'obligationId') AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such obligation of yours'; END IF;
  IF o.status <> 'open' THEN RAISE EXCEPTION 'FLEET_OBLIGATION_CLOSED: it is %', o.status; END IF;
  v_step := CASE o.recur WHEN 'daily' THEN interval '1 day' WHEN 'weekly' THEN interval '7 days' WHEN 'monthly' THEN interval '1 month'
                         WHEN 'quarterly' THEN interval '3 months' WHEN 'yearly' THEN interval '1 year' END;
  IF v_step IS NULL THEN
    UPDATE fleet_business_obligations SET status = 'done', done_count = done_count + 1, last_done_at = now(), updated_at = now() WHERE obligation_id = o.obligation_id RETURNING * INTO o;
  ELSE
    -- The next occurrence after now (a missed period is not owed twice).
    o.due_at := o.due_at + v_step;
    WHILE o.due_at <= now() LOOP o.due_at := o.due_at + v_step; END LOOP;
    UPDATE fleet_business_obligations SET due_at = o.due_at, done_count = done_count + 1, last_done_at = now(), updated_at = now() WHERE obligation_id = o.obligation_id RETURNING * INTO o;
  END IF;
  RETURN jsonb_build_object('ok', true, 'obligation', fleet_obligation_json(o));
END $$;

CREATE FUNCTION fleet_econ_obligation_cancel(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_business_obligations;
BEGIN
  UPDATE fleet_business_obligations SET status = 'cancelled', updated_at = now() WHERE obligation_id = fleet_identity_uuid(a, 'obligationId') AND agent_id = p_agent AND status = 'open'
    RETURNING * INTO o;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such open obligation of yours'; END IF;
  RETURN jsonb_build_object('ok', true, 'obligation', fleet_obligation_json(o));
END $$;

CREATE FUNCTION fleet_econ_obligation_list(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_status text := COALESCE(fleet_econ_text(a, 'status', 12), 'open'); v_days bigint := fleet_econ_int(a, 'dueWithinDays', 0, 3650);
BEGIN
  RETURN jsonb_build_object('ok', true, 'obligations', COALESCE((SELECT jsonb_agg(fleet_obligation_json(o) ORDER BY o.due_at) FROM (
    SELECT * FROM fleet_business_obligations WHERE agent_id = p_agent AND status = v_status AND (v_days IS NULL OR due_at <= now() + make_interval(days => v_days::int))
     ORDER BY due_at LIMIT 200) o), '[]'::jsonb),
    'ordersDue', COALESCE((SELECT jsonb_agg(jsonb_build_object('orderId', o.order_id, 'status', o.status, 'dueAt', ${ORDER_DUE},
        'overdue', ${ORDER_DUE} <= now()) ORDER BY ${ORDER_DUE}) FROM fleet_customer_orders o
      WHERE o.agent_id = p_agent AND o.payment_status = 'paid' AND o.status IN ('to_fulfil','delivering','delivery_failed') AND o.turnaround_days IS NOT NULL), '[]'::jsonb));
END $$;

-- ═══ 6. Lawful outreach: opt-outs (fleet-wide) and the outreach record ═══
CREATE FUNCTION fleet_address_sha(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to('fleet-outreach:' || lower(btrim(p)), 'UTF8')), 'hex')
$$;
CREATE TABLE fleet_outreach_suppressions (
  address_sha256 text        PRIMARY KEY CHECK (address_sha256 ~ '^[0-9a-f]{64}$'),
  reason         text        NOT NULL CHECK (reason IN ('unsubscribed','requested','bounced','complaint','owner')),
  source         text        NOT NULL CHECK (source IN ('link','agent','owner')),
  agent_id       text        REFERENCES fleet_agents(agent_id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_outreach_suppressions_no_delete BEFORE UPDATE OR DELETE ON fleet_outreach_suppressions FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TABLE fleet_outreach_messages (
  message_id     uuid        PRIMARY KEY REFERENCES fleet_agent_mail(message_id),
  agent_id       text        NOT NULL REFERENCES fleet_agents(agent_id),
  venture_id     uuid        NOT NULL REFERENCES fleet_ventures(venture_id),
  lead_id        uuid        REFERENCES fleet_leads(lead_id),
  address_sha256 text        NOT NULL CHECK (address_sha256 ~ '^[0-9a-f]{64}$'),
  basis          text        NOT NULL CHECK (basis IN (${q(OUTREACH_BASES)})),
  recipient_type text        NOT NULL CHECK (recipient_type IN ('business','individual')),
  token_sha256   text        NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  opted_out_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_outreach_messages_agent ON fleet_outreach_messages (agent_id, created_at DESC);

${MAIL_SEND}

CREATE FUNCTION fleet_econ_outreach_suppress(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_addr text := lower(fleet_econ_text(a, 'address', 254, true)); v_reason text := COALESCE(fleet_econ_text(a, 'reason', 20), 'requested');
BEGIN
  IF v_addr !~ '^[^@[:space:]<>]{1,64}@[a-z0-9.-]{3,190}$' THEN PERFORM fleet_econ_bad('address is a plain email address'); END IF;
  IF v_reason NOT IN ('requested','bounced','complaint') THEN PERFORM fleet_econ_bad('reason is requested|bounced|complaint'); END IF;
  INSERT INTO fleet_outreach_suppressions (address_sha256, reason, source, agent_id) VALUES (fleet_address_sha(v_addr), v_reason, 'agent', p_agent) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('ok', true, 'note', 'no agent will write to this address first again');
END $$;

CREATE FUNCTION fleet_econ_outreach_check(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_addr text := lower(fleet_econ_text(a, 'address', 254, true));
BEGIN
  RETURN jsonb_build_object('ok', true, 'suppressed', EXISTS (SELECT 1 FROM fleet_outreach_suppressions WHERE address_sha256 = fleet_address_sha(v_addr)),
    'contactedByYou', (SELECT count(*) FROM fleet_outreach_messages WHERE agent_id = p_agent AND address_sha256 = fleet_address_sha(v_addr)));
END $$;

-- The public opt-out page (/u/<token>): GET reads, POST records (a link scanner's GET never opts anyone out).
CREATE FUNCTION svc_outreach_optout(p_token text, p_confirm boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE m fleet_outreach_messages; v_brand text;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  SELECT * INTO m FROM fleet_outreach_messages WHERE token_sha256 = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  v_brand := fleet_storefront(m.venture_id) ->> 'brand';
  IF p_confirm THEN
    INSERT INTO fleet_outreach_suppressions (address_sha256, reason, source, agent_id) VALUES (m.address_sha256, 'unsubscribed', 'link', m.agent_id) ON CONFLICT DO NOTHING;
    UPDATE fleet_outreach_messages SET opted_out_at = COALESCE(opted_out_at, now()) WHERE message_id = m.message_id;
    IF m.lead_id IS NOT NULL THEN UPDATE fleet_leads SET stage = 'lost', next_action = 'opted out', next_action_at = NULL, closed_at = COALESCE(closed_at, now()), updated_at = now()
      WHERE lead_id = m.lead_id; END IF;
    PERFORM fleet_event('outreach_opt_out', m.agent_id, 'public', jsonb_build_object('messageId', m.message_id));
  END IF;
  RETURN jsonb_build_object('ok', true, 'brand', v_brand, 'optedOut', p_confirm OR EXISTS (SELECT 1 FROM fleet_outreach_suppressions WHERE address_sha256 = m.address_sha256));
END $$;

-- ═══ 7. Sales and payouts on other channels ═══
CREATE TABLE fleet_channel_payouts (
  payout_id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id              text        NOT NULL REFERENCES fleet_agents(agent_id),
  venture_id            uuid        NOT NULL REFERENCES fleet_ventures(venture_id),
  channel_id            uuid        NOT NULL REFERENCES fleet_venture_channels(channel_id),
  route                 text        NOT NULL CHECK (route IN ('treasury_paypal','owner_bank')),
  amount_minor          bigint      NOT NULL CHECK (amount_minor > 0),
  currency              text        NOT NULL CHECK (currency = 'GBP'),
  paypal_transaction_id text        CHECK (paypal_transaction_id ~ '^[A-Z0-9]{5,40}$'),
  reference             text        CHECK (length(reference) <= 200),
  status                text        NOT NULL DEFAULT 'pending_match' CHECK (status IN ('pending_match','needs_owner','booked','rejected')),
  journal_id            uuid        REFERENCES fleet_ledger_journal(journal_id),
  reason                text        CHECK (length(reason) <= 500),
  decided_by            text,
  decided_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (route <> 'treasury_paypal' OR paypal_transaction_id IS NOT NULL),
  CHECK ((status = 'booked') = (journal_id IS NOT NULL))
);
CREATE INDEX fleet_channel_payouts_agent ON fleet_channel_payouts (agent_id, status);
CREATE TABLE fleet_channel_sales (
  sale_id        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       text        NOT NULL REFERENCES fleet_agents(agent_id),
  venture_id     uuid        NOT NULL REFERENCES fleet_ventures(venture_id),
  channel_id     uuid        NOT NULL REFERENCES fleet_venture_channels(channel_id),
  external_ref   text        NOT NULL CHECK (length(external_ref) BETWEEN 1 AND 120),
  occurred_at    timestamptz NOT NULL,
  currency       text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  gross_minor    bigint      NOT NULL CHECK (gross_minor > 0),
  fee_minor      bigint      NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  refunded_minor bigint      NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0 AND refunded_minor <= gross_minor),
  status         text        NOT NULL DEFAULT 'reported' CHECK (status IN ('reported','paid_out','refunded','cancelled')),
  evidence       text        CHECK (length(evidence) <= 500),
  offer_id       uuid        REFERENCES fleet_offers(offer_id),
  lead_id        uuid        REFERENCES fleet_leads(lead_id),
  payout_id      uuid        REFERENCES fleet_channel_payouts(payout_id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, external_ref)
);
CREATE UNIQUE INDEX fleet_channel_payouts_txn ON fleet_channel_payouts (paypal_transaction_id) WHERE paypal_transaction_id IS NOT NULL AND status = 'booked';
ALTER TABLE fleet_paypal_transactions DROP CONSTRAINT fleet_paypal_transactions_attributed_as_check;
ALTER TABLE fleet_paypal_transactions ADD CONSTRAINT fleet_paypal_transactions_attributed_as_check
  CHECK (attributed_as IN ('owner_funding','agent_revenue','not_revenue','provider_payout','capital_backing','ai_credit_purchase','owner_withdrawal','channel_payout'));

CREATE FUNCTION fleet_sale_json(s fleet_channel_sales) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('saleId', s.sale_id, 'channelId', s.channel_id, 'externalRef', s.external_ref, 'occurredAt', s.occurred_at,
    'currency', s.currency, 'grossMinor', s.gross_minor, 'feeMinor', s.fee_minor, 'refundedMinor', s.refunded_minor, 'status', s.status, 'evidence', s.evidence,
    'offerId', s.offer_id, 'leadId', s.lead_id, 'payoutId', s.payout_id))
$$;
CREATE FUNCTION fleet_payout_json(p fleet_channel_payouts) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('payoutId', p.payout_id, 'channelId', p.channel_id, 'route', p.route, 'amountMinor', p.amount_minor, 'currency', p.currency,
    'paypalTransactionId', p.paypal_transaction_id, 'reference', p.reference, 'status', p.status, 'journalId', p.journal_id, 'reason', p.reason,
    'sales', (SELECT count(*) FROM fleet_channel_sales s WHERE s.payout_id = p.payout_id), 'createdAt', p.created_at, 'decidedAt', p.decided_at))
$$;

CREATE FUNCTION fleet_econ_sale_report(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_venture_channels; s fleet_channel_sales; v_gross bigint := fleet_econ_int(a, 'grossMinor', 1, 100000000000, true);
        v_fee bigint := COALESCE(fleet_econ_int(a, 'feeMinor', 0, 100000000000), 0); v_ccy text := upper(fleet_econ_text(a, 'currency', 3, true));
BEGIN
  SELECT * INTO c FROM fleet_venture_channels WHERE channel_id = fleet_identity_uuid(a, 'channelId') AND agent_id = p_agent;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such channel of yours'; END IF;
  IF c.kind = 'own_pages' THEN RAISE EXCEPTION 'FLEET_SALE_OWN_PAGES: sales on your own offer pages are recorded automatically'; END IF;
  IF v_ccy !~ '^[A-Z]{3}$' THEN PERFORM fleet_econ_bad('currency is an ISO code (GBP, EUR, USD…)'); END IF;
  IF v_fee > v_gross THEN PERFORM fleet_econ_bad('feeMinor is at most grossMinor'); END IF;
  IF NULLIF(a ->> 'occurredAt', '') IS NULL THEN PERFORM fleet_econ_bad('occurredAt (ISO-8601) is required'); END IF;
  IF (SELECT count(*) FROM fleet_channel_sales WHERE agent_id = p_agent AND created_at > now() - interval '1 day') >= 2000 THEN
    RAISE EXCEPTION 'FLEET_INFRASTRUCTURE_CEILING: an infrastructure failsafe against runaway loops was hit';
  END IF;
  INSERT INTO fleet_channel_sales (agent_id, venture_id, channel_id, external_ref, occurred_at, currency, gross_minor, fee_minor, evidence, offer_id, lead_id)
    VALUES (p_agent, c.venture_id, c.channel_id, fleet_econ_text(a, 'externalRef', 120, true), (a ->> 'occurredAt')::timestamptz, v_ccy, v_gross, v_fee,
      fleet_econ_text(a, 'evidence', 500), (SELECT offer_id FROM fleet_offers WHERE agent_id = p_agent AND offer_id::text = a ->> 'offerId'),
      (SELECT lead_id FROM fleet_leads WHERE agent_id = p_agent AND lead_id::text = a ->> 'leadId'))
    ON CONFLICT (channel_id, external_ref) DO NOTHING RETURNING * INTO s;
  IF s.sale_id IS NULL THEN RAISE EXCEPTION 'FLEET_SALE_DUPLICATE: that sale (externalRef) is already recorded for this channel'; END IF;
  RETURN jsonb_build_object('ok', true, 'sale', fleet_sale_json(s),
    'note', 'a memo, not cash: the money counts when its payout reaches the treasury PayPal (payout claim)');
END $$;

CREATE FUNCTION fleet_econ_sale_update(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE s fleet_channel_sales; v_status text := fleet_econ_text(a, 'status', 20);
BEGIN
  SELECT * INTO s FROM fleet_channel_sales WHERE sale_id = fleet_identity_uuid(a, 'saleId') AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such sale of yours'; END IF;
  IF v_status IS NOT NULL AND v_status NOT IN ('refunded','cancelled','reported') THEN PERFORM fleet_econ_bad('status is reported|refunded|cancelled'); END IF;
  IF s.status = 'paid_out' AND v_status IS NOT NULL THEN RAISE EXCEPTION 'FLEET_SALE_PAID_OUT: a paid-out sale keeps its status (its refund reduces a later payout)'; END IF;
  UPDATE fleet_channel_sales SET refunded_minor = COALESCE(fleet_econ_int(a, 'refundedMinor', 0, s.gross_minor), refunded_minor),
         fee_minor = COALESCE(fleet_econ_int(a, 'feeMinor', 0, s.gross_minor), fee_minor), status = COALESCE(v_status, status),
         evidence = COALESCE(fleet_econ_text(a, 'evidence', 500), evidence), updated_at = now() WHERE sale_id = s.sale_id RETURNING * INTO s;
  RETURN jsonb_build_object('ok', true, 'sale', fleet_sale_json(s));
END $$;

CREATE FUNCTION fleet_econ_sale_list(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_channel text := fleet_econ_text(a, 'channelId', 40); v_status text := fleet_econ_text(a, 'status', 20);
BEGIN
  RETURN jsonb_build_object('ok', true, 'sales', COALESCE((SELECT jsonb_agg(fleet_sale_json(s) ORDER BY s.occurred_at DESC) FROM (
    SELECT * FROM fleet_channel_sales WHERE agent_id = p_agent AND (v_channel IS NULL OR channel_id::text = v_channel) AND (v_status IS NULL OR status = v_status)
     ORDER BY occurred_at DESC LIMIT 300) s), '[]'::jsonb));
END $$;

-- Book a payout against a real treasury PayPal credit (the controller on an unambiguous match, or the owner).
CREATE FUNCTION fleet_channel_payout_book(p_payout uuid, p_txn text, p_actor text, p_source text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_channel_payouts; t fleet_paypal_transactions; c fleet_venture_channels; v_key text; v_fee bigint; v_lines jsonb; v_j uuid;
BEGIN
  SELECT * INTO p FROM fleet_channel_payouts WHERE payout_id = p_payout FOR UPDATE;
  IF p.status IN ('booked','rejected') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PAYOUT_DECIDED'); END IF;
  SELECT * INTO t FROM fleet_paypal_transactions WHERE transaction_id = p_txn AND status = 'S' AND amount_minor > 0 AND currency = 'GBP'
     AND checkout_id IS NULL AND attributed_as IS NULL ORDER BY initiated_at LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PAYOUT_NO_CREDIT'); END IF;
  IF t.amount_minor <> p.amount_minor THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PAYOUT_AMOUNT', 'creditMinor', t.amount_minor); END IF;
  v_key := 'chpayout:' || t.transaction_id;
  IF fleet_claim_taken(v_key) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ALREADY_CLAIMED'); END IF;
  SELECT * INTO c FROM fleet_venture_channels WHERE channel_id = p.channel_id;
  v_fee := LEAST(abs(t.fee_minor), t.amount_minor);
  v_lines := jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(p.agent_id, 'agent_revenue'), 'side', 'C', 'amount', t.amount_minor));
  IF t.amount_minor - v_fee > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(p.agent_id, 'agent_cash'), 'side', 'D', 'amount', t.amount_minor - v_fee)); END IF;
  IF v_fee > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(p.agent_id, 'agent_fees'), 'side', 'D', 'amount', v_fee)); END IF;
  v_j := fleet_ledger_post('provider_revenue_receipt', v_key, p_actor, left('payout from ' || c.name || ' received into the treasury PayPal', 300), p_source, p.agent_id,
    NULL, NULL, v_key, NULL, now(), v_lines);
  INSERT INTO fleet_revenue_claims (claim_key, claim_kind, journal_id, claimed_by) VALUES (v_key, 'provider_payout', v_j, p_actor);
  INSERT INTO fleet_venture_journals (journal_id, venture_id, agent_id, cost_category, attributed_by) VALUES (v_j, p.venture_id, p.agent_id, 'revenue', p_actor);
  UPDATE fleet_paypal_transactions SET attributed_as = 'channel_payout', attributed_ref = 'payout:' || p.payout_id, attributed_by = p_actor, attributed_at = now(), updated_at = now()
   WHERE rail_id = t.rail_id AND transaction_id = t.transaction_id AND event_code = t.event_code AND initiated_at = t.initiated_at;
  UPDATE fleet_channel_payouts SET status = 'booked', journal_id = v_j, paypal_transaction_id = t.transaction_id, decided_by = p_actor, decided_at = now()
   WHERE payout_id = p.payout_id;
  UPDATE fleet_channel_sales SET status = 'paid_out', updated_at = now() WHERE payout_id = p.payout_id AND status = 'reported';
  PERFORM fleet_event('channel_payout_booked', p.agent_id, p_actor, jsonb_build_object('payoutId', p.payout_id, 'channel', c.name, 'amountMinor', t.amount_minor,
    'feeMinor', v_fee, 'journalId', v_j));
  RETURN jsonb_build_object('ok', true, 'status', 'booked', 'journalId', v_j, 'cashMinor', t.amount_minor - v_fee, 'feeMinor', v_fee);
END $$;

-- An unambiguous match books at once; anything else is the owner's decision (never a guess).
CREATE FUNCTION fleet_channel_payout_try(p_payout uuid) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_channel_payouts; c fleet_venture_channels; t fleet_paypal_transactions; v_reason text; r jsonb;
BEGIN
  SELECT * INTO p FROM fleet_channel_payouts WHERE payout_id = p_payout FOR UPDATE;
  IF p.status <> 'pending_match' THEN RETURN fleet_payout_json(p); END IF;
  SELECT * INTO c FROM fleet_venture_channels WHERE channel_id = p.channel_id;
  IF p.route = 'owner_bank' THEN
    v_reason := 'paid to the owner''s bank: the owner moves it into the treasury PayPal and books it against that credit';
  ELSE
    SELECT * INTO t FROM fleet_paypal_transactions WHERE transaction_id = p.paypal_transaction_id AND amount_minor > 0 ORDER BY initiated_at LIMIT 1;
    IF NOT FOUND OR t.status <> 'S' THEN
      IF p.created_at < now() - interval '7 days' THEN v_reason := 'the PayPal credit was not seen as completed within 7 days'; ELSE RETURN fleet_payout_json(p); END IF;
    ELSIF t.attributed_as IS NOT NULL OR t.checkout_id IS NOT NULL THEN v_reason := 'that PayPal transaction is already attributed';
    ELSIF t.currency <> 'GBP' OR t.amount_minor <> p.amount_minor THEN v_reason := format('the credit is %s %s, the claim %s GBP', t.amount_minor, t.currency, p.amount_minor);
    ELSIF c.payout_counterparty IS NULL OR position(lower(c.payout_counterparty) IN lower(COALESCE(t.counterparty, ''))) = 0 THEN
      v_reason := 'the payer PayPal shows does not match the channel''s payout counterparty';
    ELSIF EXISTS (SELECT 1 FROM fleet_venture_channels o WHERE o.agent_id <> p.agent_id AND o.payout_counterparty IS NOT NULL AND o.status <> 'dropped'
                   AND position(lower(o.payout_counterparty) IN lower(COALESCE(t.counterparty, ''))) > 0) THEN
      v_reason := 'another agent receives payouts from the same payer: the owner attributes it';
    ELSIF EXISTS (SELECT 1 FROM fleet_channel_payouts o WHERE o.paypal_transaction_id = p.paypal_transaction_id AND o.payout_id <> p.payout_id AND o.status <> 'rejected') THEN
      v_reason := 'another claim names the same PayPal transaction';
    END IF;
  END IF;
  IF v_reason IS NOT NULL THEN
    UPDATE fleet_channel_payouts SET status = 'needs_owner', reason = left(v_reason, 500) WHERE payout_id = p.payout_id RETURNING * INTO p;
    PERFORM fleet_event('channel_payout_needs_owner', p.agent_id, 'controller', jsonb_build_object('payoutId', p.payout_id, 'channel', c.name, 'amountMinor', p.amount_minor,
      'route', p.route, 'reason', v_reason));
    RETURN fleet_payout_json(p);
  END IF;
  r := fleet_channel_payout_book(p.payout_id, t.transaction_id, 'controller', 'controller');
  SELECT * INTO p FROM fleet_channel_payouts WHERE payout_id = p_payout;
  RETURN fleet_payout_json(p) || CASE WHEN (r ->> 'ok')::boolean THEN '{}'::jsonb ELSE jsonb_build_object('bookError', r ->> 'code') END;
END $$;

CREATE FUNCTION fleet_econ_payout_claim(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_venture_channels; p fleet_channel_payouts; v_route text := fleet_econ_text(a, 'route', 20, true); v_ids uuid[]; v_txn text := upper(fleet_econ_text(a, 'paypalTransactionId', 40));
BEGIN
  SELECT * INTO c FROM fleet_venture_channels WHERE channel_id = fleet_identity_uuid(a, 'channelId') AND agent_id = p_agent;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such channel of yours'; END IF;
  IF v_route NOT IN ('treasury_paypal','owner_bank') THEN PERFORM fleet_econ_bad('route is treasury_paypal (the platform paid the Fleet''s PayPal) | owner_bank'); END IF;
  IF v_route = 'treasury_paypal' AND (v_txn IS NULL OR v_txn !~ '^[A-Z0-9]{5,40}$') THEN PERFORM fleet_econ_bad('paypalTransactionId is the PayPal transaction of the payout'); END IF;
  IF jsonb_typeof(a -> 'saleIds') = 'array' THEN
    SELECT array_agg(s.sale_id) INTO v_ids FROM fleet_channel_sales s WHERE s.agent_id = p_agent AND s.channel_id = c.channel_id AND s.payout_id IS NULL
       AND s.sale_id::text IN (SELECT jsonb_array_elements_text(a -> 'saleIds'));
    IF COALESCE(cardinality(v_ids), 0) <> jsonb_array_length(a -> 'saleIds') THEN PERFORM fleet_econ_bad('saleIds are this channel''s reported sales not yet in a payout'); END IF;
  END IF;
  INSERT INTO fleet_channel_payouts (agent_id, venture_id, channel_id, route, amount_minor, currency, paypal_transaction_id, reference)
    VALUES (p_agent, c.venture_id, c.channel_id, v_route, fleet_econ_int(a, 'amountMinor', 1, 100000000000, true), 'GBP', v_txn, fleet_econ_text(a, 'reference', 200))
    RETURNING * INTO p;
  IF v_ids IS NOT NULL THEN UPDATE fleet_channel_sales SET payout_id = p.payout_id, updated_at = now() WHERE sale_id = ANY (v_ids); END IF;
  RETURN jsonb_build_object('ok', true, 'payout', fleet_channel_payout_try(p.payout_id));
END $$;

CREATE FUNCTION fleet_econ_payout_list(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x uuid;
BEGIN
  -- Pending claims are re-tried (the credit may have arrived since).
  FOR x IN SELECT payout_id FROM fleet_channel_payouts WHERE agent_id = p_agent AND status = 'pending_match' LOOP PERFORM fleet_channel_payout_try(x); END LOOP;
  RETURN jsonb_build_object('ok', true, 'payouts', COALESCE((SELECT jsonb_agg(fleet_payout_json(p) ORDER BY p.created_at DESC) FROM (
    SELECT * FROM fleet_channel_payouts WHERE agent_id = p_agent ORDER BY created_at DESC LIMIT 100) p), '[]'::jsonb));
END $$;

-- Owner: book a payout against a named treasury PayPal credit (a bank receipt first moved into PayPal), or reject it.
CREATE FUNCTION fleet_admin_channel_payout_decide(p_payout uuid, p_decision text, p_txn text, p_note text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_channel_payouts;
BEGIN
  ${OWNER_ACTOR}
  SELECT * INTO p FROM fleet_channel_payouts WHERE payout_id = p_payout FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such payout claim'; END IF;
  IF p.status IN ('booked','rejected') THEN RAISE EXCEPTION 'FLEET_PAYOUT_DECIDED: it is %', p.status; END IF;
  IF p_decision = 'reject' THEN
    UPDATE fleet_channel_payouts SET status = 'rejected', reason = left(COALESCE(p_note, 'rejected by the owner'), 500), decided_by = p_actor, decided_at = now()
     WHERE payout_id = p.payout_id;
    UPDATE fleet_channel_sales SET payout_id = NULL, updated_at = now() WHERE payout_id = p.payout_id;
    PERFORM fleet_event('channel_payout_rejected', p.agent_id, p_actor, jsonb_build_object('payoutId', p.payout_id));
    RETURN jsonb_build_object('ok', true, 'status', 'rejected');
  ELSIF p_decision = 'book' THEN
    IF p_txn IS NULL OR p_txn !~ '^[A-Z0-9]{5,40}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: name the treasury PayPal credit (transaction id) the payout arrived as'; END IF;
    RETURN fleet_channel_payout_book(p.payout_id, p_txn, p_actor, 'owner');
  END IF;
  RAISE EXCEPTION 'FLEET_BAD_REQUEST: decision is book|reject';
END $$;

-- ═══ Performance: per channel, what the agent built there and what it brought ═══
CREATE FUNCTION fleet_business_performance(p_agent text, p_venture uuid) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  WITH ch AS (SELECT * FROM fleet_venture_channels WHERE agent_id = p_agent AND (p_venture IS NULL OR venture_id = p_venture)),
  ord AS (SELECT o.*, COALESCE(o.channel_id, e.channel_id) AS via FROM fleet_customer_orders o LEFT JOIN fleet_offer_enquiries e ON e.enquiry_id = o.enquiry_id
           WHERE o.agent_id = p_agent AND (p_venture IS NULL OR o.venture_id = p_venture) AND NOT o.owner_proof)
  SELECT jsonb_build_object(
    'channels', COALESCE((SELECT jsonb_agg(jsonb_build_object('channelId', c.channel_id, 'name', c.name, 'kind', c.kind, 'status', c.status,
        'presence', jsonb_build_object('live', (SELECT count(*) FROM fleet_presence_items p WHERE p.channel_id = c.channel_id AND p.status = 'live'),
                                       'total', (SELECT count(*) FROM fleet_presence_items p WHERE p.channel_id = c.channel_id),
                                       'recordedCostMinor', (SELECT COALESCE(sum(cost_minor), 0) FROM fleet_presence_items p WHERE p.channel_id = c.channel_id)),
        'leads', (SELECT jsonb_build_object('open', count(*) FILTER (WHERE stage NOT IN ('won','lost')), 'won', count(*) FILTER (WHERE stage = 'won'),
                                            'lost', count(*) FILTER (WHERE stage = 'lost')) FROM fleet_leads l WHERE l.channel_id = c.channel_id),
        'enquiries', (SELECT count(*) FROM fleet_offer_enquiries e WHERE e.channel_id = c.channel_id),
        'ordersPaid', (SELECT count(*) FROM ord WHERE ord.via = c.channel_id AND ord.payment_status IN ('paid','partially_refunded','refunded')),
        'ownPagesGrossMinor', (SELECT COALESCE(sum(amount_minor), 0) FROM ord WHERE ord.via = c.channel_id AND ord.payment_status IN ('paid','partially_refunded','refunded')),
        'ownPagesRefundedMinor', (SELECT COALESCE(sum(refunded_minor), 0) FROM ord WHERE ord.via = c.channel_id),
        'externalSales', (SELECT COALESCE(jsonb_object_agg(currency, jsonb_build_object('count', n, 'grossMinor', g, 'feeMinor', f, 'refundedMinor', r)), '{}'::jsonb) FROM (
            SELECT currency, count(*) n, sum(gross_minor) g, sum(fee_minor) f, sum(refunded_minor) r FROM fleet_channel_sales s
             WHERE s.channel_id = c.channel_id AND s.status <> 'cancelled' GROUP BY currency) z),
        'payoutsBookedMinor', (SELECT COALESCE(sum(amount_minor), 0) FROM fleet_channel_payouts p WHERE p.channel_id = c.channel_id AND p.status = 'booked'),
        'payoutsAwaitingMinor', (SELECT COALESCE(sum(amount_minor), 0) FROM fleet_channel_payouts p WHERE p.channel_id = c.channel_id AND p.status IN ('pending_match','needs_owner')))
      ORDER BY c.created_at) FROM ch c), '[]'::jsonb),
    'unattributed', jsonb_build_object('ordersPaid', (SELECT count(*) FROM ord WHERE via IS NULL AND payment_status IN ('paid','partially_refunded','refunded')),
      'grossMinor', (SELECT COALESCE(sum(amount_minor), 0) FROM ord WHERE via IS NULL AND payment_status IN ('paid','partially_refunded','refunded'))),
    'note', 'own-pages money is captured by the Fleet (ledger); external sales are your memos until their payout is booked; costs are your recorded placement costs — ledger spending is in venture status')
$$;

CREATE FUNCTION fleet_econ_business_performance(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_venture text := fleet_econ_venture_ref(p_agent, a);
BEGIN
  IF v_venture IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fleet_ventures WHERE venture_id::text = v_venture AND agent_id = p_agent) THEN PERFORM fleet_econ_bad('not one of your ventures'); END IF;
  RETURN jsonb_build_object('ok', true) || fleet_business_performance(p_agent, v_venture::uuid);
END $$;

-- Owner view (hub-business).
CREATE FUNCTION fleet_business_admin_json(p_agent text) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'channels', COALESCE((SELECT jsonb_agg(fleet_channel_json(c) || jsonb_build_object('agentId', c.agent_id) ORDER BY c.agent_id, c.created_at) FROM fleet_venture_channels c
       WHERE p_agent IS NULL OR c.agent_id = p_agent), '[]'::jsonb),
    'livePresence', COALESCE((SELECT jsonb_agg(fleet_presence_json(p) || jsonb_build_object('agentId', p.agent_id) ORDER BY p.updated_at DESC) FROM (
       SELECT * FROM fleet_presence_items WHERE status = 'live' AND (p_agent IS NULL OR agent_id = p_agent) ORDER BY updated_at DESC LIMIT 200) p), '[]'::jsonb),
    'leads', (SELECT jsonb_object_agg(stage, n) FROM (SELECT stage, count(*) n FROM fleet_leads WHERE p_agent IS NULL OR agent_id = p_agent GROUP BY stage) z),
    'openObligations', (SELECT count(*) FROM fleet_business_obligations WHERE status = 'open' AND (p_agent IS NULL OR agent_id = p_agent)),
    'outreach30d', (SELECT jsonb_build_object('messages', count(*), 'optedOut', count(*) FILTER (WHERE opted_out_at IS NOT NULL)) FROM fleet_outreach_messages
       WHERE created_at > now() - interval '30 days' AND (p_agent IS NULL OR agent_id = p_agent)),
    'payoutsNeedingOwner', COALESCE((SELECT jsonb_agg(fleet_payout_json(p) || jsonb_build_object('agentId', p.agent_id) ORDER BY p.created_at) FROM fleet_channel_payouts p
       WHERE p.status = 'needs_owner' AND (p_agent IS NULL OR p.agent_id = p_agent)), '[]'::jsonb))
$$;

-- ═══ 8. Venture P&L ═══
${VENTURE_FIN}

${ATTENTION}
${EVENT_ROUTE}
${DISPATCH}

-- ═══ 9. The shared library: channels, production tools and the dated capability status (v6) ═══
SELECT fleet_admin_knowledge_library_load(${lit({ entries: KNOWLEDGE_FOUNDATION_V2.entries.filter((e) => (LIBRARY_ENTRIES_V79 as readonly string[]).includes(e.id)) })}::jsonb, 'migration');
`;
