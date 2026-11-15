/**
 * Schema v80 — the acquisition channels and scoped outward releases (owner brief, 2026-10-15). v79 (96016c9, the prepared
 * package) is not edited; what changes is restated here from the latest definitions.
 *
 *  1. A release is a specific authorisation, not a general one. `economy-outward release` permits EXTERNAL actions: sales
 *     staying closed does not stop a post, a listing or a message becoming public. A release therefore names exactly what it
 *     allows and expires (≤ 72 h): the actions (browser | account_register | account_connector | mail | sms | storefront |
 *     channel_api), the accounts and origins for browser work, the recipients for mail, the channels for API publishing.
 *     Anything outside the scope stays held (FLEET_PREPARATION_HOLD with the reason); spending (card requests) is never part
 *     of a release. The browser worker enforces the origins too: an outward step on a page outside them is refused.
 *     v79's unscoped releases (if any) end at this migration.
 *  2. Search discovery of the agent's own offer pages: a sitemap and robots.txt (published offers, sales open only), structured
 *     data on each offer page, and IndexNow notifications of new / changed offer pages (free; the key file is served at the
 *     site root; sent by the channel gateway — the controller has no internet egress). Nothing is submitted while sales are
 *     closed.
 *  3. Official-API channels (the platforms that permit automation only through their API): a channel gateway (its own OS user,
 *     DB role fleet_channels, chx_* only, its own token vault) runs agents' jobs against the account the OWNER connected for
 *     one of the agent's channels — Etsy Open API v3 (the owner's own shop: draft listing, images, files, activate /
 *     deactivate, update; receipts and payouts read back) and Pinterest API v5 (the owner's business account: boards, Pins).
 *     The agent never holds a token. Each connection is checked (exact provider account, exact scopes) before any job runs.
 *     A listing on Etsy carries the AI-use disclosure Etsy's Creativity Standards ask for (added by the gateway, not optional).
 *     Published listings and Pins are recorded as the channel's presence automatically; Etsy sales become sale memos and
 *     Etsy payouts become payout claims (route owner_bank: Etsy pays a bank) — cash only through v79's evidence chain.
 * Nothing here moves money, opens sales, changes a live flag or grants authority. API jobs are outward actions: held unless
 * sales are open or a release names that channel.
 */
import { V37_SQL } from "./migrations-phase37.js";
import { V79_SQL } from "./migrations-phase79.js";
import { restate as restateRaw } from "./migrations-phase42.js";
import { KNOWLEDGE_FOUNDATION_V2 } from "./knowledge-foundation-v2.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const lit = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'`;
/** v80: library entries this release corrects (API channels, releases, discovery). */
export const LIBRARY_ENTRIES_V80 = ["bf-channels", "fleet-capability-status"] as const;
const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;`;
const WORKER = `IF p_worker IS NULL OR p_worker !~ '^[a-z0-9-]{3,40}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: worker name'; END IF;`;
const UUID_RE = `'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;

export const EVENT_ROUTES_V80 = Object.freeze({
  P2_IMPORTANT: ["channel_connection_failed"],
  P3_SUMMARY: ["channel_connected", "channel_api_published"],
} as const);

/** v80: what a release may permit (never spending). */
export const RELEASE_ACTIONS = ["browser", "account_register", "account_connector", "mail", "sms", "storefront", "channel_api"] as const;
export const RELEASE_MAX_HOURS = 72;
/** v80: the official-API channels and their operations. */
export const API_PROVIDERS = ["etsy", "pinterest"] as const;
export const CHANNEL_API_OPS = ["etsy.listing.create", "etsy.listing.update", "etsy.listing.image", "etsy.listing.file", "etsy.listing.activate", "etsy.listing.deactivate",
  "pinterest.board.create", "pinterest.pin.create"] as const;
/** Scopes each connection must carry exactly (the gateway refuses a token with fewer or more). */
export const PROVIDER_SCOPES: Record<string, readonly string[]> = {
  etsy: ["listings_r", "listings_w", "shops_r", "transactions_r"],
  pinterest: ["boards:read", "boards:write", "pins:read", "pins:write", "user_accounts:read"],
};
/** Etsy Creativity Standards: AI use is disclosed in the listing (the gateway appends this when the agent did not). */
export const ETSY_AI_DISCLOSURE = "Designed by our studio with the help of AI tools; every file is checked before it is listed.";
export const AGENT_OPS_V80 = ["channel.api", "channel.api_jobs"] as const;
export const FILE_CARRYING_OPS_V80 = ["storefront.file", "order.deliver", "offer.file", "order.stage_file", "browser.stage_file", "channel.api"] as const;
const OUTWARD_OPS = ["mail.send", "sms.send", "phone.provision", "browser.act", "account.create", "account.operate", "account.register", "storefront.product.create",
  "storefront.product.update", "storefront.product.publish", "storefront.file", "card.request", "channel.api"] as const;

// ── 1. Scoped releases: the dispatcher asks fleet_outward_refusal (null = permitted) ──
const DISPATCH = restate(V79_SQL, "api_economy", [
  [`WHEN 'order.refund' THEN 'planning'`, `WHEN 'order.refund' THEN 'planning' ${AGENT_OPS_V80.map((o) => `WHEN '${o}' THEN 'planning'`).join(" ")}`],
  [`CASE WHEN p_op IN ('storefront.file','order.deliver','offer.file','order.stage_file','browser.stage_file') THEN 21000000`, `CASE WHEN p_op IN (${q(FILE_CARRYING_OPS_V80)}) THEN 21000000`],
  [`CASE WHEN p_op IN ('storefront.file','order.deliver','offer.file','order.stage_file','browser.stage_file') THEN 'arguments are a JSON object (a file of at most 15 MB)'`,
   `CASE WHEN p_op IN (${q(FILE_CARRYING_OPS_V80)}) THEN 'arguments are a JSON object (a file of at most 15 MB)'`],
  [`      WHEN 'order.refund' THEN fleet_econ_order_refund(p_agent, a)`,
   `      WHEN 'order.refund' THEN fleet_econ_order_refund(p_agent, a)
      WHEN 'channel.api' THEN fleet_econ_channel_api(p_agent, a)
      WHEN 'channel.api_jobs' THEN fleet_econ_channel_api_jobs(p_agent, a)`],
  [`  IF p_op IN ('mail.send','sms.send','phone.provision','browser.act','account.create','account.operate','account.register','storefront.product.create','storefront.product.update','storefront.product.publish','storefront.file','card.request') AND fleet_outward_held(p_agent) AND NOT (p_op = 'browser.act' AND fleet_browser_steps_read_only(a -> 'steps')) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PREPARATION_HOLD',
      'reason', 'outward actions are held until the owner opens sales or releases you for a controlled proof: sending mail or SMS, acting on websites (clicking, filling, uploading, downloading), creating or operating accounts, storefront publishing, card requests wait; reading and rendering in the browser, research, building, reviewing, publishing private offers and fulfilling orders continue');
  END IF;`,
   `  IF p_op IN (${q(OUTWARD_OPS)}) AND fleet_outward_refusal(p_agent, p_op, a) IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PREPARATION_HOLD', 'reason', fleet_outward_refusal(p_agent, p_op, a));
  END IF;`],
  [`|SALE_[A-Z_]+|PAYOUT_[A-Z_]+|CREDENTIAL_[A-Z_]+):'`, `|SALE_[A-Z_]+|PAYOUT_[A-Z_]+|CREDENTIAL_[A-Z_]+|CHANNEL_API_[A-Z_]+):'`],
]);

// The worker also enforces a release's origins (a click can navigate anywhere): the claim carries them.
const CLAIM = restate(V37_SQL, "bx_claim_action", [
  [`    'kind', x.kind, 'steps', x.steps, 'sessionStatus', s.status, 'accountId', s.account_id, 'origins', to_jsonb(acc.origins))));`,
   `    'kind', x.kind, 'steps', x.steps, 'sessionStatus', s.status, 'accountId', s.account_id, 'origins', to_jsonb(acc.origins),
    -- v80: under a scoped release (sales closed) outward steps run only on these origins; absent = sales open (unrestricted).
    'outwardOrigins', CASE WHEN fleet_sales_open() THEN NULL ELSE COALESCE((SELECT r.scope -> 'origins' FROM fleet_outward_release r
       WHERE r.agent_id = x.agent_id AND r.expires_at > now()), '[]'::jsonb) END)));`],
]);

const EVENT_ROUTE = restate(V79_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V80) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);

export const V80_SQL = `
-- ═══ 1. Scoped, expiring releases ═══
DELETE FROM fleet_outward_release;  -- v79 releases carried no scope: they end here (held again)
ALTER TABLE fleet_outward_release ADD COLUMN scope jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'object' AND length(scope::text) <= 8000),
  ADD COLUMN expires_at timestamptz NOT NULL;
DROP FUNCTION fleet_admin_outward_set(text, boolean, text, text);
CREATE OR REPLACE FUNCTION fleet_outward_held(p_agent text) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT NOT fleet_sales_open() AND NOT EXISTS (SELECT 1 FROM fleet_outward_release WHERE agent_id = p_agent AND expires_at > now())
$$;

-- Null = permitted; otherwise the reason it is held (shown to the agent).
CREATE FUNCTION fleet_outward_refusal(p_agent text, p_op text, a jsonb) RETURNS text LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_outward_release; s fleet_browser_sessions; v_need text; v_origin text; x text; v_orig jsonb;
BEGIN
  IF p_op = 'card.request' AND NOT fleet_sales_open() THEN
    RETURN 'spending waits for launch: a card request is never part of a controlled-proof release';
  END IF;
  IF fleet_sales_open() THEN RETURN NULL; END IF;
  IF p_op = 'browser.act' AND fleet_browser_steps_read_only(a -> 'steps') THEN RETURN NULL; END IF;
  SELECT * INTO r FROM fleet_outward_release WHERE agent_id = p_agent AND expires_at > now();
  IF NOT FOUND THEN
    RETURN 'outward actions are held until the owner opens sales or releases you for a named controlled proof: sending mail or SMS, acting on websites (clicking, filling, uploading, downloading), creating or operating accounts, API publishing, storefront publishing and card requests wait; reading and rendering in the browser, research, building, reviewing, private publishing and fulfilling orders continue';
  END IF;
  v_need := CASE p_op WHEN 'mail.send' THEN 'mail' WHEN 'sms.send' THEN 'sms' WHEN 'phone.provision' THEN 'sms' WHEN 'browser.act' THEN 'browser'
    WHEN 'account.register' THEN 'account_register' WHEN 'account.create' THEN 'account_connector' WHEN 'account.operate' THEN 'account_connector'
    WHEN 'channel.api' THEN 'channel_api' ELSE 'storefront' END;
  IF NOT (r.scope -> 'actions') ? v_need THEN
    RETURN format('the owner''s release (until %s) does not include %s: %s', r.expires_at, v_need, r.note);
  END IF;
  v_orig := COALESCE(r.scope -> 'origins', '[]'::jsonb);
  IF p_op = 'browser.act' THEN
    SELECT * INTO s FROM fleet_browser_sessions WHERE session_id::text = a ->> 'sessionId' AND agent_id = p_agent;
    IF s.account_id IS NULL OR NOT COALESCE(r.scope -> 'accounts', '[]'::jsonb) ? s.account_id::text THEN
      RETURN 'the release covers website actions only in a session opened with one of its accounts';
    END IF;
    v_origin := lower(substring(COALESCE(s.url, '') FROM '^(https://[^/?#]+)'));
    IF v_origin IS NOT NULL AND NOT v_orig ? v_origin THEN RETURN format('the release does not cover %s', v_origin); END IF;
    FOR x IN SELECT e ->> 'url' FROM jsonb_array_elements(COALESCE(a -> 'steps', '[]'::jsonb)) e WHERE e ->> 'action' = 'goto' LOOP
      IF NOT v_orig ? lower(substring(x FROM '^(https://[^/?#]+)')) THEN RETURN format('the release does not cover %s', left(x, 120)); END IF;
    END LOOP;
  ELSIF p_op = 'account.register' THEN
    IF NOT v_orig ? lower(COALESCE(a ->> 'origin', '')) THEN RETURN format('the release does not cover registering on %s', left(a ->> 'origin', 120)); END IF;
  ELSIF p_op IN ('account.create','account.operate') THEN
    IF NOT COALESCE(r.scope -> 'accounts', '[]'::jsonb) ? COALESCE(a ->> 'accountId', '') THEN RETURN 'the release does not cover that account'; END IF;
  ELSIF p_op = 'mail.send' THEN
    FOR x IN SELECT lower(e) FROM jsonb_array_elements_text(CASE jsonb_typeof(a -> 'to') WHEN 'array' THEN a -> 'to' ELSE jsonb_build_array(a ->> 'to') END) e LOOP
      IF NOT (COALESCE(r.scope -> 'mailTo', '[]'::jsonb) ? x OR COALESCE(r.scope -> 'mailTo', '[]'::jsonb) ? ('@' || split_part(x, '@', 2))) THEN
        RETURN format('the release does not cover mail to %s', left(x, 120));
      END IF;
    END LOOP;
  ELSIF p_op = 'channel.api' THEN
    IF NOT COALESCE(r.scope -> 'channels', '[]'::jsonb) ? COALESCE(a ->> 'channelId', '') THEN RETURN 'the release does not cover that channel'; END IF;
    IF r.scope ? 'apiOps' AND NOT (r.scope -> 'apiOps') ? COALESCE(a ->> 'op', '') THEN RETURN format('the release does not cover %s', a ->> 'op'); END IF;
  END IF;
  RETURN NULL;
END $$;

-- Owner: a release names the actions, accounts, origins, recipients and channels it allows, and expires (≤ ${RELEASE_MAX_HOURS} h).
CREATE FUNCTION fleet_admin_outward_release(p_agent text, p_scope jsonb, p_note text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_hours numeric; v_acts jsonb; x text; v_scope jsonb;
BEGIN
  ${OWNER_ACTOR}
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  IF NOT EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = p_agent) THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such agent'; END IF;
  IF p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 3 AND 300 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: say what the proof is (3..300 characters)'; END IF;
  IF p_scope IS NULL OR jsonb_typeof(p_scope) <> 'object' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the scope is a JSON object'; END IF;
  FOR x IN SELECT jsonb_object_keys(p_scope) LOOP
    IF x NOT IN ('actions','accounts','origins','mailTo','channels','apiOps','expiresHours') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: unknown scope field %', x; END IF;
  END LOOP;
  v_hours := (p_scope ->> 'expiresHours')::numeric;
  IF v_hours IS NULL OR v_hours <= 0 OR v_hours > ${RELEASE_MAX_HOURS} THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: expiresHours is 1..${RELEASE_MAX_HOURS}'; END IF;
  v_acts := p_scope -> 'actions';
  IF jsonb_typeof(v_acts) <> 'array' OR jsonb_array_length(v_acts) = 0
     OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_acts) e WHERE e NOT IN (${q(RELEASE_ACTIONS)})) THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: actions is a non-empty list of ${RELEASE_ACTIONS.join("|")} (spending is never released)';
  END IF;
  -- Each action names exactly where it applies.
  IF (v_acts ? 'browser' OR v_acts ? 'account_register') AND jsonb_array_length(COALESCE(p_scope -> 'origins', '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: browser / account_register name their origins (https://host)';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(p_scope -> 'origins', '[]'::jsonb)) e WHERE NOT fleet_origin_ok(e)) OR jsonb_array_length(COALESCE(p_scope -> 'origins', '[]'::jsonb)) > 10 THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: origins are 1..10 https://host[:port] (lower case)';
  END IF;
  IF (v_acts ? 'browser' OR v_acts ? 'account_connector') AND jsonb_array_length(COALESCE(p_scope -> 'accounts', '[]'::jsonb)) = 0 AND NOT v_acts ? 'account_register' THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: browser / account_connector name the agent''s accounts they may use';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(p_scope -> 'accounts', '[]'::jsonb)) e
              WHERE e !~ ${UUID_RE} OR NOT EXISTS (SELECT 1 FROM fleet_agent_accounts c WHERE c.account_id::text = e AND c.agent_id = p_agent)) THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: accounts are this agent''s account ids';
  END IF;
  IF v_acts ? 'mail' AND (jsonb_array_length(COALESCE(p_scope -> 'mailTo', '[]'::jsonb)) = 0
      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_scope -> 'mailTo') e WHERE e !~ '^([^@[:space:]<>]{1,64})?@[a-z0-9.-]{3,190}$')) THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: mail names its recipients (addresses or @domains, lower case)';
  END IF;
  IF v_acts ? 'channel_api' AND (jsonb_array_length(COALESCE(p_scope -> 'channels', '[]'::jsonb)) = 0
      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_scope -> 'channels') e WHERE e !~ ${UUID_RE}
                  OR NOT EXISTS (SELECT 1 FROM fleet_venture_channels c WHERE c.channel_id::text = e AND c.agent_id = p_agent))) THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: channel_api names this agent''s channels';
  END IF;
  IF p_scope ? 'apiOps' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_scope -> 'apiOps') e WHERE e NOT IN (${q(CHANNEL_API_OPS)})) THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: apiOps are ${CHANNEL_API_OPS.join("|")}';
  END IF;
  v_scope := p_scope - 'expiresHours';
  INSERT INTO fleet_outward_release (agent_id, note, released_by, scope, expires_at) VALUES (p_agent, btrim(p_note), p_actor, v_scope, now() + make_interval(secs => v_hours * 3600))
    ON CONFLICT (agent_id) DO UPDATE SET note = EXCLUDED.note, released_by = EXCLUDED.released_by, released_at = now(), scope = EXCLUDED.scope, expires_at = EXCLUDED.expires_at;
  PERFORM fleet_event('outward_released', p_agent, p_actor, jsonb_build_object('note', left(p_note, 300), 'scope', v_scope, 'hours', v_hours));
  RETURN jsonb_build_object('ok', true, 'agentId', p_agent, 'scope', v_scope, 'expiresAt', now() + make_interval(secs => v_hours * 3600), 'salesOpen', fleet_sales_open(),
    'warning', 'this permits EXTERNAL actions: anything the agent publishes within this scope (accounts, listings, posts, messages) is public at once — closed sales only keep the Fleet''s own offer pages private');
END $$;
CREATE FUNCTION fleet_admin_outward_hold(p_agent text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE n integer;
BEGIN
  ${OWNER_ACTOR}
  DELETE FROM fleet_outward_release WHERE agent_id = p_agent;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM fleet_event('outward_held', p_agent, p_actor, jsonb_build_object('ended', n));
  RETURN jsonb_build_object('ok', true, 'agentId', p_agent, 'ended', n > 0, 'outwardHeld', fleet_outward_held(p_agent));
END $$;
CREATE FUNCTION fleet_admin_outward_list() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('salesOpen', fleet_sales_open(), 'releases', COALESCE(jsonb_agg(jsonb_build_object('agentId', agent_id, 'note', note, 'scope', scope,
    'releasedBy', released_by, 'releasedAt', released_at, 'expiresAt', expires_at, 'active', expires_at > now()) ORDER BY released_at), '[]'::jsonb))
  FROM fleet_outward_release
$$;

${CLAIM}

-- ═══ 2. Search discovery of the own offer pages ═══
CREATE TABLE fleet_discovery (
  id            integer     PRIMARY KEY CHECK (id = 1),
  indexnow_key  text        NOT NULL CHECK (indexnow_key ~ '^[0-9a-f]{32}$'),
  last_ping_at  timestamptz,
  last_status   integer,
  pinged_total  bigint      NOT NULL DEFAULT 0
);
INSERT INTO fleet_discovery (id, indexnow_key) VALUES (1, replace(gen_random_uuid()::text, '-', ''));
-- The key (created on first use if the row is missing, e.g. a wiped test registry).
CREATE FUNCTION fleet_discovery_key() RETURNS text LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  INSERT INTO fleet_discovery (id, indexnow_key) VALUES (1, replace(gen_random_uuid()::text, '-', '')) ON CONFLICT (id) DO NOTHING;
  RETURN (SELECT indexnow_key FROM fleet_discovery WHERE id = 1);
END $$;
CREATE TABLE fleet_discovery_pings (
  offer_id    uuid        PRIMARY KEY REFERENCES fleet_offers(offer_id),
  seen_update timestamptz NOT NULL,
  pinged_at   timestamptz NOT NULL DEFAULT now()
);
-- The public sitemap: published offers, only while sales are open (closed sales serve no offer page).
CREATE FUNCTION svc_sitemap() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'open', fleet_sales_open(), 'base', (SELECT base_url FROM fleet_public_site WHERE id = 1),
    'offers', CASE WHEN fleet_sales_open() THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('slug', slug, 'lastmod', updated_at) ORDER BY published_at)
       FROM fleet_offers WHERE status = 'published'), '[]'::jsonb) ELSE '[]'::jsonb END)
$$;
CREATE FUNCTION svc_indexnow_key() RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$ SELECT jsonb_build_object('ok', true, 'key', fleet_discovery_key()) $$;
-- Offer pages new or changed since their last notification (sales open, public site set).
CREATE FUNCTION chx_indexnow_due(p_worker text, p_limit integer) RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'key', fleet_discovery_key(), 'base', (SELECT base_url FROM fleet_public_site WHERE id = 1),
    'offers', CASE WHEN fleet_sales_open() THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('offerId', o.offer_id, 'slug', o.slug, 'updatedAt', o.updated_at)) FROM (
       SELECT o.* FROM fleet_offers o LEFT JOIN fleet_discovery_pings p ON p.offer_id = o.offer_id
        WHERE o.status = 'published' AND (p.offer_id IS NULL OR o.updated_at > p.seen_update) ORDER BY o.updated_at LIMIT LEAST(GREATEST(p_limit, 1), 1000)) o), '[]'::jsonb)
      ELSE '[]'::jsonb END)
$$;
CREATE FUNCTION chx_indexnow_done(p_worker text, p_offers jsonb, p_status integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE n integer := 0; e jsonb;
BEGIN
  IF jsonb_typeof(p_offers) <> 'array' OR p_status IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  PERFORM fleet_discovery_key();
  UPDATE fleet_discovery SET last_ping_at = now(), last_status = p_status WHERE id = 1;
  IF p_status IN (200, 202) THEN
    FOR e IN SELECT * FROM jsonb_array_elements(p_offers) LOOP
      INSERT INTO fleet_discovery_pings (offer_id, seen_update) SELECT o.offer_id, (e ->> 'updatedAt')::timestamptz FROM fleet_offers o WHERE o.offer_id::text = e ->> 'offerId'
        ON CONFLICT (offer_id) DO UPDATE SET seen_update = EXCLUDED.seen_update, pinged_at = now();
      n := n + 1;
    END LOOP;
    UPDATE fleet_discovery SET pinged_total = pinged_total + n WHERE id = 1;
  END IF;
  RETURN jsonb_build_object('ok', true, 'recorded', n);
END $$;

-- ═══ 3. Official-API channels: owner-connected accounts, agent jobs, the channel gateway (chx_*) ═══
CREATE TABLE fleet_channel_connections (
  connection_id    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id       uuid        NOT NULL UNIQUE REFERENCES fleet_venture_channels(channel_id),
  agent_id         text        NOT NULL REFERENCES fleet_agents(agent_id),
  provider         text        NOT NULL CHECK (provider IN (${q(API_PROVIDERS)})),
  vault_ref        text        NOT NULL UNIQUE CHECK (vault_ref ~ '^vault:(etsy|pinterest)/[a-z0-9_-]{1,40}$'),
  expected_account text        NOT NULL CHECK (expected_account ~ '^[A-Za-z0-9_-]{1,64}$'),
  shop_id          text        CHECK (shop_id ~ '^[0-9]{1,20}$'),
  status           text        NOT NULL DEFAULT 'pending_check' CHECK (status IN ('pending_check','active','failed','disconnected')),
  check_error      text        CHECK (length(check_error) <= 300),
  checked_at       timestamptz,
  created_by       text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (vault_ref LIKE 'vault:' || provider || '/%'),
  CHECK (provider <> 'etsy' OR shop_id IS NOT NULL)
);
CREATE TABLE fleet_channel_jobs (
  job_id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        text        NOT NULL REFERENCES fleet_agents(agent_id),
  connection_id   uuid        NOT NULL REFERENCES fleet_channel_connections(connection_id),
  channel_id      uuid        NOT NULL REFERENCES fleet_venture_channels(channel_id),
  op              text        NOT NULL CHECK (op IN (${q(CHANNEL_API_OPS)})),
  payload         jsonb       NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND length(payload::text) <= 32000),
  blob            bytea       CHECK (octet_length(blob) <= 15000000),
  blob_name       text        CHECK (blob_name ~ '^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$'),
  blob_type       text        CHECK (blob_type ~ '^[a-z]+/[a-z0-9.+-]{1,100}$'),
  idempotency_key text        NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  status          text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','claimed','done','failed')),
  attempts        integer     NOT NULL DEFAULT 0,
  claimed_by      text,
  lease_sha256    text        CHECK (lease_sha256 ~ '^[0-9a-f]{64}$'),
  result          jsonb       CHECK (result IS NULL OR length(result::text) <= 20000),
  external_id     text        CHECK (length(external_id) <= 64),
  external_url    text        CHECK (external_url ~ '^https://[^[:space:]]{4,255}$'),
  presence_item_id uuid       REFERENCES fleet_presence_items(item_id),
  error           text        CHECK (length(error) <= 300),
  created_at      timestamptz NOT NULL DEFAULT now(),
  claimed_at      timestamptz,
  finished_at     timestamptz,
  UNIQUE (agent_id, idempotency_key)
);
CREATE INDEX fleet_channel_jobs_queue ON fleet_channel_jobs (status, created_at);
CREATE TABLE fleet_channel_cursors (
  connection_id uuid NOT NULL REFERENCES fleet_channel_connections(connection_id),
  kind          text NOT NULL CHECK (kind IN ('receipts','ledger')),
  cursor        text NOT NULL CHECK (length(cursor) <= 200),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, kind)
);
ALTER TABLE fleet_channel_sales ADD COLUMN source text NOT NULL DEFAULT 'agent' CHECK (source IN ('agent','provider'));

CREATE FUNCTION fleet_channel_job_json(j fleet_channel_jobs) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('jobId', j.job_id, 'channelId', j.channel_id, 'op', j.op, 'status', j.status, 'attempts', j.attempts,
    'externalId', j.external_id, 'externalUrl', j.external_url, 'presenceItemId', j.presence_item_id, 'error', j.error, 'result', j.result,
    'createdAt', j.created_at, 'finishedAt', j.finished_at))
$$;

-- Owner: connect one of an agent's channels to the account the owner authorised (the token is in the gateway's vault).
CREATE FUNCTION fleet_admin_channel_connect(p_channel uuid, p_provider text, p_vault_ref text, p_expected_account text, p_shop_id text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_venture_channels; x fleet_channel_connections;
BEGIN
  ${OWNER_ACTOR}
  SELECT * INTO c FROM fleet_venture_channels WHERE channel_id = p_channel;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such channel'; END IF;
  IF c.rules_source IS NULL OR c.rules_summary IS NULL THEN
    RAISE EXCEPTION 'FLEET_CHANNEL_RULES: the agent records the platform''s rules on this channel before it is connected';
  END IF;
  INSERT INTO fleet_channel_connections (channel_id, agent_id, provider, vault_ref, expected_account, shop_id, created_by)
    VALUES (c.channel_id, c.agent_id, p_provider, p_vault_ref, p_expected_account, NULLIF(p_shop_id, ''), p_actor)
    ON CONFLICT (channel_id) DO UPDATE SET provider = EXCLUDED.provider, vault_ref = EXCLUDED.vault_ref, expected_account = EXCLUDED.expected_account,
      shop_id = EXCLUDED.shop_id, status = 'pending_check', check_error = NULL, checked_at = NULL, created_by = EXCLUDED.created_by, created_at = now()
    RETURNING * INTO x;
  PERFORM fleet_event('channel_connected', c.agent_id, p_actor, jsonb_build_object('channelId', c.channel_id, 'provider', p_provider));
  RETURN jsonb_build_object('ok', true, 'connectionId', x.connection_id, 'status', x.status, 'note', 'the gateway checks the account and its scopes before any job runs');
END $$;
CREATE FUNCTION fleet_admin_channel_disconnect(p_channel uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE n integer;
BEGIN
  ${OWNER_ACTOR}
  UPDATE fleet_channel_connections SET status = 'disconnected' WHERE channel_id = p_channel AND status <> 'disconnected';
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE fleet_channel_jobs SET status = 'failed', error = 'FLEET_CHANNEL_API_DISCONNECTED', finished_at = now()
   WHERE channel_id = p_channel AND status = 'queued';
  RETURN jsonb_build_object('ok', true, 'disconnected', n > 0);
END $$;
CREATE FUNCTION fleet_channel_api_admin_json() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('connections', COALESCE((SELECT jsonb_agg(jsonb_build_object('connectionId', connection_id, 'channelId', channel_id, 'agentId', agent_id,
      'provider', provider, 'vaultRef', vault_ref, 'expectedAccount', expected_account, 'shopId', shop_id, 'status', status, 'checkError', check_error,
      'checkedAt', checked_at) ORDER BY created_at) FROM fleet_channel_connections), '[]'::jsonb),
    'jobs24h', (SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) n FROM fleet_channel_jobs WHERE created_at > now() - interval '24 hours' GROUP BY 1) z))
$$;

-- Agent: queue an API job on one of its connected channels (an outward action: held unless sales are open or released).
CREATE FUNCTION fleet_econ_channel_api(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_channel_connections; c fleet_venture_channels; v_op text := fleet_econ_text(a, 'op', 40, true); p jsonb := COALESCE(a -> 'args', '{}'::jsonb);
        v_idem text := fleet_econ_text(a, 'idempotencyKey', 128, true); v_blob bytea; v_name text; v_type text; j fleet_channel_jobs; v_brand text;
BEGIN
  SELECT * INTO c FROM fleet_venture_channels WHERE channel_id = fleet_identity_uuid(a, 'channelId') AND agent_id = p_agent;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such channel of yours'; END IF;
  SELECT * INTO x FROM fleet_channel_connections WHERE channel_id = c.channel_id AND status IN ('pending_check','active');
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_CHANNEL_API_NOT_CONNECTED: the owner has not connected an API account for this channel (it needs the platform account in the owner''s name)'; END IF;
  IF v_op NOT IN (${q(CHANNEL_API_OPS)}) OR split_part(v_op, '.', 1) <> x.provider THEN PERFORM fleet_econ_bad('op is one of ' || x.provider || '''s: ${CHANNEL_API_OPS.join("|")}'); END IF;
  IF c.status <> 'active' THEN RAISE EXCEPTION 'FLEET_CHANNEL_API_INACTIVE: make the channel active first (its rules recorded)'; END IF;
  SELECT jobs.* INTO j FROM fleet_channel_jobs jobs WHERE jobs.agent_id = p_agent AND jobs.idempotency_key = v_idem;
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'job', fleet_channel_job_json(j)); END IF;
  IF jsonb_typeof(p) <> 'object' THEN PERFORM fleet_econ_bad('args is an object'); END IF;
  -- Per-operation fields (the gateway maps them to the provider's API; nothing else is sent).
  IF v_op = 'etsy.listing.create' THEN
    IF length(COALESCE(p ->> 'title', '')) NOT BETWEEN 3 AND 140 OR length(COALESCE(p ->> 'description', '')) NOT BETWEEN 20 AND 30000
       OR jsonb_typeof(p -> 'priceMinor') <> 'number' OR (p ->> 'priceMinor')::bigint NOT BETWEEN 20 AND 5000000 OR jsonb_typeof(p -> 'taxonomyId') <> 'number'
       OR (p ? 'tags' AND (jsonb_typeof(p -> 'tags') <> 'array' OR jsonb_array_length(p -> 'tags') > 13)) THEN
      PERFORM fleet_econ_bad('etsy.listing.create: title 3..140, description 20+, priceMinor (shop currency, minor units), taxonomyId, tags? (≤ 13)');
    END IF;
    -- Etsy Creativity Standards: AI use is disclosed in the listing.
    IF p ->> 'description' !~* '\\mAI\\M|artificial intelligence' THEN p := jsonb_set(p, '{description}', to_jsonb((p ->> 'description') || E'\\n\\n' || '${ETSY_AI_DISCLOSURE}')); END IF;
    p := p || jsonb_build_object('type', 'download', 'whoMade', 'i_did', 'whenMade', COALESCE(p ->> 'whenMade', 'made_to_order'), 'isSupply', false, 'quantity', COALESCE((p ->> 'quantity')::int, 999));
  ELSIF v_op IN ('etsy.listing.update','etsy.listing.image','etsy.listing.file','etsy.listing.activate','etsy.listing.deactivate') THEN
    IF COALESCE(p ->> 'listingId', '') !~ '^[0-9]{1,20}$' THEN PERFORM fleet_econ_bad(v_op || ' needs listingId'); END IF;
  ELSIF v_op = 'pinterest.board.create' THEN
    IF length(COALESCE(p ->> 'name', '')) NOT BETWEEN 2 AND 180 THEN PERFORM fleet_econ_bad('pinterest.board.create needs name'); END IF;
  ELSIF v_op = 'pinterest.pin.create' THEN
    IF COALESCE(p ->> 'boardId', '') !~ '^[0-9]{1,30}$' OR length(COALESCE(p ->> 'title', '')) NOT BETWEEN 2 AND 100 OR length(COALESCE(p ->> 'description', '')) > 800
       OR COALESCE(p ->> 'link', '') !~ '^https://[^[:space:]]+$' OR length(p ->> 'link') > 2000 OR length(COALESCE(p ->> 'altText', '')) NOT BETWEEN 5 AND 500 THEN
      PERFORM fleet_econ_bad('pinterest.pin.create: boardId, title 2..100, description ≤ 800, link (https — your offer page via channel link, or your listing), altText 5..500');
    END IF;
  END IF;
  IF v_op IN ('etsy.listing.image','etsy.listing.file','pinterest.pin.create') THEN
    v_name := fleet_econ_text(a, 'fileName', 120, true); v_type := fleet_econ_text(a, 'contentType', 100, true);
    BEGIN v_blob := decode(COALESCE(a ->> 'contentB64', ''), 'base64'); EXCEPTION WHEN others THEN PERFORM fleet_econ_bad('contentB64 is base64'); END;
    IF octet_length(v_blob) NOT BETWEEN 1 AND 15000000 THEN PERFORM fleet_econ_bad('the file is 1 byte .. 15 MB (path: a workspace file)'); END IF;
    IF v_op <> 'etsy.listing.file' AND v_type NOT IN ('image/png','image/jpeg') THEN PERFORM fleet_econ_bad('an image is png or jpeg'); END IF;
  END IF;
  IF (SELECT count(*) FROM fleet_channel_jobs WHERE agent_id = p_agent AND created_at > now() - interval '1 day') >= 300 THEN
    RAISE EXCEPTION 'FLEET_INFRASTRUCTURE_CEILING: an infrastructure failsafe against runaway loops was hit (300 API jobs a day)';
  END IF;
  SELECT (fleet_storefront(c.venture_id) ->> 'brand') INTO v_brand;
  INSERT INTO fleet_channel_jobs (agent_id, connection_id, channel_id, op, payload, blob, blob_name, blob_type, idempotency_key)
    VALUES (p_agent, x.connection_id, c.channel_id, v_op, p || jsonb_strip_nulls(jsonb_build_object('brand', v_brand)), v_blob, v_name, v_type, v_idem) RETURNING * INTO j;
  RETURN jsonb_build_object('ok', true, 'job', fleet_channel_job_json(j), 'note', 'the channel gateway runs it against the owner-connected account; channel api_jobs shows the result');
END $$;

CREATE FUNCTION fleet_econ_channel_api_jobs(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_ch text := fleet_econ_text(a, 'channelId', 40);
BEGIN
  RETURN jsonb_build_object('ok', true, 'connections', COALESCE((SELECT jsonb_agg(jsonb_build_object('channelId', x.channel_id, 'provider', x.provider, 'status', x.status,
      'checkError', x.check_error)) FROM fleet_channel_connections x WHERE x.agent_id = p_agent AND x.status <> 'disconnected'), '[]'::jsonb),
    'jobs', COALESCE((SELECT jsonb_agg(fleet_channel_job_json(j) ORDER BY j.created_at DESC) FROM (SELECT * FROM fleet_channel_jobs WHERE agent_id = p_agent
      AND (v_ch IS NULL OR channel_id::text = v_ch) ORDER BY created_at DESC LIMIT 100) j), '[]'::jsonb));
END $$;

-- ── The channel gateway's protocol (role fleet_channels) ──
CREATE FUNCTION chx_ping() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('schemaVersion', (SELECT max(version) FROM fleet_schema_migrations), 'queued', (SELECT count(*) FROM fleet_channel_jobs WHERE status = 'queued'))
$$;
CREATE FUNCTION chx_connections(p_worker text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  ${WORKER}
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('connectionId', connection_id, 'channelId', channel_id, 'agentId', agent_id, 'provider', provider, 'vaultRef', vault_ref,
    'expectedAccount', expected_account, 'shopId', shop_id, 'status', status) ORDER BY created_at) FROM fleet_channel_connections WHERE status IN ('pending_check','active','failed')), '[]'::jsonb);
END $$;
CREATE FUNCTION chx_connection_check(p_worker text, p_connection uuid, p_account text, p_scopes text[], p_error text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_channel_connections; v_ok boolean; v_err text;
BEGIN
  ${WORKER}
  SELECT * INTO x FROM fleet_channel_connections WHERE connection_id = p_connection FOR UPDATE;
  IF NOT FOUND OR x.status = 'disconnected' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  v_ok := p_error IS NULL AND p_account = x.expected_account
    AND (SELECT array_agg(s ORDER BY s) FROM unnest(p_scopes) s) = (SELECT array_agg(s ORDER BY s) FROM unnest(CASE x.provider WHEN 'etsy' THEN ARRAY[${q(PROVIDER_SCOPES.etsy)}]
         ELSE ARRAY[${q(PROVIDER_SCOPES.pinterest)}] END) s);
  v_err := CASE WHEN v_ok THEN NULL WHEN p_error IS NOT NULL THEN left(p_error, 300) WHEN p_account IS DISTINCT FROM x.expected_account THEN 'the token reaches a different account'
    ELSE 'the token carries other scopes than exactly the required ones' END;
  UPDATE fleet_channel_connections SET status = CASE WHEN v_ok THEN 'active' ELSE 'failed' END, check_error = v_err, checked_at = now() WHERE connection_id = x.connection_id;
  IF NOT v_ok AND x.status <> 'failed' THEN
    PERFORM fleet_event('channel_connection_failed', x.agent_id, 'channel-gateway', jsonb_build_object('channelId', x.channel_id, 'provider', x.provider, 'reason', v_err));
  END IF;
  RETURN jsonb_build_object('ok', true, 'active', v_ok);
END $$;
CREATE FUNCTION chx_claim_job(p_worker text, p_lease_sha256 text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_channel_jobs; x fleet_channel_connections;
BEGIN
  ${WORKER}
  IF p_lease_sha256 !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  -- Expired leases return to the queue (at most 3 attempts).
  UPDATE fleet_channel_jobs SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'queued' END, error = CASE WHEN attempts >= 3 THEN 'FLEET_CHANNEL_API_ATTEMPTS' END,
         finished_at = CASE WHEN attempts >= 3 THEN now() END WHERE status = 'claimed' AND claimed_at < now() - interval '10 minutes';
  SELECT jobs.* INTO j FROM fleet_channel_jobs jobs JOIN fleet_channel_connections c ON c.connection_id = jobs.connection_id
   WHERE jobs.status = 'queued' AND c.status = 'active' ORDER BY jobs.created_at LIMIT 1 FOR UPDATE OF jobs SKIP LOCKED;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', true, 'job', NULL); END IF;
  UPDATE fleet_channel_jobs SET status = 'claimed', claimed_by = p_worker, claimed_at = now(), lease_sha256 = p_lease_sha256, attempts = attempts + 1 WHERE job_id = j.job_id;
  SELECT * INTO x FROM fleet_channel_connections WHERE connection_id = j.connection_id;
  RETURN jsonb_build_object('ok', true, 'job', jsonb_build_object('jobId', j.job_id, 'connectionId', j.connection_id, 'provider', x.provider, 'shopId', x.shop_id,
    'op', j.op, 'payload', j.payload, 'hasBlob', j.blob IS NOT NULL, 'blobName', j.blob_name, 'blobType', j.blob_type));
END $$;
CREATE FUNCTION chx_leased(p_job uuid, p_lease text) RETURNS fleet_channel_jobs LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_channel_jobs;
BEGIN
  SELECT * INTO j FROM fleet_channel_jobs WHERE job_id = p_job;
  IF NOT FOUND OR j.status <> 'claimed' OR p_lease IS NULL OR encode(sha256(convert_to(p_lease, 'UTF8')), 'hex') <> j.lease_sha256 THEN
    RAISE EXCEPTION 'FLEET_LEASE_INVALID: no claimed channel job under this lease';
  END IF;
  RETURN j;
END $$;
CREATE FUNCTION chx_job_blob(p_job uuid, p_lease text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_channel_jobs := chx_leased(p_job, p_lease);
BEGIN
  RETURN jsonb_build_object('ok', j.blob IS NOT NULL, 'dataB64', encode(j.blob, 'base64'));
END $$;
-- A finished job; a public result (an active listing, a Pin) is recorded as the channel's presence.
CREATE FUNCTION chx_job_report(p_job uuid, p_lease text, p_ok boolean, p_result jsonb, p_external_id text, p_external_url text, p_error text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_channel_jobs := chx_leased(p_job, p_lease); c fleet_venture_channels; v_item uuid; v_kind text; v_status text;
BEGIN
  UPDATE fleet_channel_jobs SET status = CASE WHEN p_ok THEN 'done' ELSE 'failed' END, finished_at = now(),
         result = CASE WHEN p_result IS NOT NULL AND length(p_result::text) <= 20000 THEN p_result END, error = left(p_error, 300),
         external_id = left(p_external_id, 64), external_url = CASE WHEN p_external_url ~ '^https://[^[:space:]]{4,255}$' THEN p_external_url END,
         blob = NULL
   WHERE job_id = j.job_id;
  IF p_ok AND j.op IN ('etsy.listing.create','etsy.listing.activate','etsy.listing.deactivate','pinterest.pin.create') THEN
    SELECT * INTO c FROM fleet_venture_channels WHERE channel_id = j.channel_id;
    v_kind := CASE WHEN j.op LIKE 'pinterest.%' THEN 'post' ELSE 'listing' END;
    v_status := CASE j.op WHEN 'etsy.listing.create' THEN 'draft' WHEN 'etsy.listing.deactivate' THEN 'paused' ELSE 'live' END;
    SELECT item_id INTO v_item FROM fleet_presence_items WHERE channel_id = c.channel_id AND external_ref = COALESCE(p_external_id, j.payload ->> 'listingId');
    IF v_item IS NULL THEN
      INSERT INTO fleet_presence_items (agent_id, venture_id, channel_id, kind, title, url, status, external_ref, note, published_at)
        VALUES (j.agent_id, c.venture_id, c.channel_id, v_kind, left(COALESCE(j.payload ->> 'title', j.op), 200),
                CASE WHEN p_external_url ~ '^https://[^[:space:]]{4,255}$' THEN p_external_url END, v_status, COALESCE(p_external_id, j.payload ->> 'listingId'),
                'published by the channel gateway (job ' || j.job_id || ')', CASE WHEN v_status = 'live' THEN now() END) RETURNING item_id INTO v_item;
    ELSE
      UPDATE fleet_presence_items SET status = v_status, url = COALESCE(CASE WHEN p_external_url ~ '^https://[^[:space:]]{4,255}$' THEN p_external_url END, url),
             published_at = CASE WHEN v_status = 'live' THEN COALESCE(published_at, now()) ELSE published_at END, updated_at = now() WHERE item_id = v_item;
    END IF;
    UPDATE fleet_channel_jobs SET presence_item_id = v_item WHERE job_id = j.job_id;
    IF v_status = 'live' THEN
      PERFORM fleet_event('channel_api_published', j.agent_id, 'channel-gateway', jsonb_build_object('channelId', j.channel_id, 'op', j.op, 'externalId', p_external_id));
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', true);
END $$;
-- Provider evidence: a sale (memo) and a payout (a claim on the bank route; cash only through the owner's evidence chain).
CREATE FUNCTION chx_sale_record(p_worker text, p_connection uuid, p_sale jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_channel_connections; c fleet_venture_channels; v_id uuid;
BEGIN
  ${WORKER}
  SELECT * INTO x FROM fleet_channel_connections WHERE connection_id = p_connection AND status = 'active';
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  SELECT * INTO c FROM fleet_venture_channels WHERE channel_id = x.channel_id;
  IF COALESCE(p_sale ->> 'ref', '') !~ '^[A-Za-z0-9:_-]{1,120}$' OR COALESCE(p_sale ->> 'currency', '') !~ '^[A-Z]{3}$' OR jsonb_typeof(p_sale -> 'grossMinor') <> 'number'
     OR (p_sale ->> 'grossMinor')::bigint <= 0 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  INSERT INTO fleet_channel_sales (agent_id, venture_id, channel_id, external_ref, occurred_at, currency, gross_minor, fee_minor, evidence, source)
    VALUES (x.agent_id, c.venture_id, c.channel_id, p_sale ->> 'ref', COALESCE((p_sale ->> 'occurredAt')::timestamptz, now()), p_sale ->> 'currency',
            (p_sale ->> 'grossMinor')::bigint, LEAST(GREATEST(COALESCE((p_sale ->> 'feeMinor')::bigint, 0), 0), (p_sale ->> 'grossMinor')::bigint),
            left('read from the ' || x.provider || ' API (' || (p_sale ->> 'ref') || ')', 500), 'provider')
    ON CONFLICT (channel_id, external_ref) DO NOTHING RETURNING sale_id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'recorded', v_id IS NOT NULL);
END $$;
CREATE FUNCTION chx_payout_record(p_worker text, p_connection uuid, p_payout jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_channel_connections; c fleet_venture_channels; v_id uuid;
BEGIN
  ${WORKER}
  SELECT * INTO x FROM fleet_channel_connections WHERE connection_id = p_connection AND status = 'active';
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  SELECT * INTO c FROM fleet_venture_channels WHERE channel_id = x.channel_id;
  IF COALESCE(p_payout ->> 'ref', '') !~ '^[A-Za-z0-9:_-]{1,120}$' OR jsonb_typeof(p_payout -> 'amountMinor') <> 'number' OR (p_payout ->> 'amountMinor')::bigint <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  IF p_payout ->> 'currency' IS DISTINCT FROM 'GBP' THEN RETURN jsonb_build_object('ok', true, 'recorded', false, 'reason', 'only GBP payouts are claimed automatically'); END IF;
  IF EXISTS (SELECT 1 FROM fleet_channel_payouts WHERE channel_id = c.channel_id AND lower(platform_payout_ref) = lower(p_payout ->> 'ref') AND status <> 'rejected') THEN
    RETURN jsonb_build_object('ok', true, 'recorded', false);
  END IF;
  INSERT INTO fleet_channel_payouts (agent_id, venture_id, channel_id, route, platform_payout_ref, platform_paid_on, amount_minor, currency, status, reason)
    VALUES (x.agent_id, c.venture_id, c.channel_id, 'owner_bank', p_payout ->> 'ref', (p_payout ->> 'paidOn')::date, (p_payout ->> 'amountMinor')::bigint, 'GBP', 'needs_owner',
            'read from the ' || x.provider || ' API: the owner records the bank line (economy-channel-payout-bank) and the treasury transfer (economy-channel-payout-transfer)')
    RETURNING payout_id INTO v_id;
  PERFORM fleet_event('channel_payout_needs_owner', x.agent_id, 'channel-gateway', jsonb_build_object('payoutId', v_id, 'channel', c.name, 'amountMinor', p_payout ->> 'amountMinor', 'route', 'owner_bank'));
  RETURN jsonb_build_object('ok', true, 'recorded', true, 'payoutId', v_id);
END $$;
CREATE FUNCTION chx_cursor(p_worker text, p_connection uuid, p_kind text) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  ${WORKER}
  RETURN (SELECT cursor FROM fleet_channel_cursors WHERE connection_id = p_connection AND kind = p_kind);
END $$;
CREATE FUNCTION chx_cursor_set(p_worker text, p_connection uuid, p_kind text, p_cursor text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  ${WORKER}
  IF p_kind NOT IN ('receipts','ledger') OR p_cursor IS NULL OR length(p_cursor) > 200 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  INSERT INTO fleet_channel_cursors (connection_id, kind, cursor) VALUES (p_connection, p_kind, p_cursor)
    ON CONFLICT (connection_id, kind) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now();
  RETURN jsonb_build_object('ok', true);
END $$;

${EVENT_ROUTE}
${DISPATCH}

-- ═══ 4. The shared library: bf-channels v3, capability status v7 ═══
SELECT fleet_admin_knowledge_library_load(${lit({ entries: KNOWLEDGE_FOUNDATION_V2.entries.filter((e) => (LIBRARY_ENTRIES_V80 as readonly string[]).includes(e.id)) })}::jsonb, 'migration');
`;
