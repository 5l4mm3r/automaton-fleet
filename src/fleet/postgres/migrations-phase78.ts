/**
 * Schema v78 — the legal seller and the agents' storefronts (owner brief, 2026-10-15). v77 is deployed (12c9f67) and is never
 * edited; what changes is restated here from the latest definitions.
 *
 *  1. The legal seller (owner, once; changeable): the facts that cannot be invented — legal form (individual or company), legal
 *     name, the owner's own registered trading name if any, the business postal address, the VAT number if VAT-registered, and for
 *     a company its number and registered office. Set with `economy-seller-set <json>`; the event records which fields changed,
 *     never their values. The same legal seller stands behind every agent brand.
 *  2. Storefronts are the agents' own: each venture's brand name and description come from the agent's venture identity
 *     (identity create_persona {kind: venture_identity, ventureKey, displayName, bio}); customer support is that venture's own
 *     routing address on the shared mailbox (the existing per-agent routing — mail to it reaches that agent). The owner writes no
 *     profile and chooses no business name.
 *  3. Every public page and every buyer email states who the buyer is dealing with: "Sold by <legal seller>", the agent's brand
 *     as the trading style, the postal address, the support address and the VAT / company details — composed from 1 and 2
 *     (fleet_seller_notice). The owner's optional free-text notice (economy-public-site) is appended, no longer required.
 *  4. Publishing an offer needs the legal seller recorded (FLEET_PUBLIC_SITE_SELLER_UNSET) and the venture's storefront identity with a real
 *     description (FLEET_STOREFRONT_PROFILE); a brand name cannot carry a legal-entity suffix (FLEET_STOREFRONT_NAME): the legal
 *     seller is shown separately, and a brand must not claim to be a company it is not.
 * Nothing here moves money, changes a live flag, opens sales or grants authority.
 */
import { V76_SQL } from "./migrations-phase76.js";
import { V77_SQL } from "./migrations-phase77.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

export const EVENT_ROUTES_V78 = Object.freeze({
  P3_SUMMARY: ["seller_identity_set"],
} as const);
/** v78: the legal seller's fields (owner facts; values never leave the table except on public pages and buyer emails). */
export const SELLER_FIELDS = ["legalForm", "legalName", "tradingName", "postalAddress", "vatNumber", "companyNumber", "registeredOffice"] as const;
/** v78: a storefront description shorter than this is not a profile. */
export const STOREFRONT_MIN_BIO = 40;
/** v78: legal-entity suffixes a brand (trading style) may not carry — the legal seller is stated separately. */
export const LEGAL_SUFFIX_RE = "(^|[^a-z])(ltd|limited|llp|plc|inc|incorporated|llc|gmbh|corp|corporation|cic|lp|sarl|bv|pty)\\.?$";

const PUBLISH = restate(V76_SQL, "fleet_econ_offer_publish", [
  [`  IF NOT EXISTS (SELECT 1 FROM fleet_public_site WHERE id = 1) THEN RAISE EXCEPTION 'FLEET_PUBLIC_SITE_UNSET: the owner has not set the public site yet; prepare everything else and publish later'; END IF;
`, `  IF NOT EXISTS (SELECT 1 FROM fleet_public_site WHERE id = 1) THEN RAISE EXCEPTION 'FLEET_PUBLIC_SITE_UNSET: the owner has not set the public site yet; prepare everything else and publish later'; END IF;
  -- v78: the legal seller behind every brand (owner facts), and this venture's own storefront (yours).
  IF NOT EXISTS (SELECT 1 FROM fleet_seller_identity WHERE id = 1) THEN
    RAISE EXCEPTION 'FLEET_PUBLIC_SITE_SELLER_UNSET: the owner has not recorded the legal seller details yet; prepare everything else and publish later';
  END IF;
  v_store := fleet_storefront(o.venture_id);
  IF v_store ->> 'brand' IS NULL OR length(COALESCE(v_store ->> 'about', '')) < ${STOREFRONT_MIN_BIO} THEN
    RAISE EXCEPTION 'FLEET_STOREFRONT_PROFILE: give this venture its storefront first — identity create_persona {kind: venture_identity, ventureKey, displayName (your brand name), bio (who it serves and what it offers, ${STOREFRONT_MIN_BIO}+ characters)}; update_persona changes the bio';
  END IF;
  IF lower(trim(v_store ->> 'brand')) ~ '${LEGAL_SUFFIX_RE}' THEN
    RAISE EXCEPTION 'FLEET_STOREFRONT_NAME: a brand name cannot carry a legal-entity suffix (Ltd, Limited, LLP, PLC, Inc, LLC, GmbH…): the legal seller is stated separately on every page; create a venture identity without it';
  END IF;
`],
  [`  IF NOT EXISTS (SELECT 1 FROM fleet_agent_mailboxes WHERE agent_id = p_agent AND status = 'active') THEN`,
   `  IF v_store ->> 'supportEmail' IS NULL THEN`],
]);

// The public pages: the composed seller notice of the offer's venture (was: the owner's free text only).
const OFFER_PAGE = restate(V76_SQL, "svc_offer_page", [
  [`'seller', (SELECT seller_notice FROM fleet_public_site WHERE id = 1))`, `'seller', fleet_seller_notice(o.venture_id))`],
]);
const ENQUIRY_PAGE = restate(V76_SQL, "svc_enquiry_page", [
  [`'seller', (SELECT seller_notice FROM fleet_public_site WHERE id = 1))`, `'seller', fleet_seller_notice((SELECT venture_id FROM fleet_offers WHERE offer_id = e.offer_id)))`],
]);
const ORDER_PAGE = restate(V76_SQL, "svc_order_page", [
  [`'seller', (SELECT seller_notice FROM fleet_public_site WHERE id = 1))`, `'seller', fleet_seller_notice(x.venture_id))`],
]);
const OFFER_PUBLIC_JSON = restate(V76_SQL, "fleet_offer_public_json", [
  [`    'brand', (SELECT initcap(translate(v.venture_key, '-_.', '   ')) FROM fleet_ventures v WHERE v.venture_id = o.venture_id),`,
   `    'brand', COALESCE(fleet_storefront(o.venture_id) ->> 'brand', (SELECT initcap(translate(v.venture_key, '-_.', '   ')) FROM fleet_ventures v WHERE v.venture_id = o.venture_id)),
    'about', fleet_storefront(o.venture_id) ->> 'about', 'supportEmail', fleet_storefront(o.venture_id) ->> 'supportEmail',`],
]);
// Buyer emails carry the same seller statement (a durable record of who sold what).
const CUSTOMER_MAIL = restate(V76_SQL, "fleet_customer_mail", [
  [`'body', p_body, 'ventureId'`, `'body', p_body || COALESCE(E'\\n\\n--\\n' || fleet_seller_notice(p_venture), ''), 'ventureId'`],
]);
const DELIVERY_BODY = restate(V76_SQL, "fleet_order_delivery_body", [
  [`      || fleet_public_url('/order/' || o.access_token) END)`, `      || fleet_public_url('/order/' || o.access_token) END,
    '--' || E'\\n' || fleet_seller_notice(o.venture_id))`],
]);
const EVENT_ROUTE = restate(V77_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V78) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);

export const V78_SQL = `
-- ═══ 1. The legal seller (owner facts) ═══
CREATE TABLE fleet_seller_identity (
  id                integer     PRIMARY KEY CHECK (id = 1),
  legal_form        text        NOT NULL CHECK (legal_form IN ('individual','company')),
  legal_name        text        NOT NULL CHECK (length(legal_name) BETWEEN 2 AND 140),
  trading_name      text        CHECK (length(trading_name) BETWEEN 2 AND 140),
  postal_address    text        NOT NULL CHECK (length(postal_address) BETWEEN 10 AND 400),
  vat_number        text        CHECK (vat_number ~ '^[A-Z]{2}[0-9A-Z]{5,13}$'),
  company_number    text        CHECK (company_number ~ '^[0-9A-Z]{6,10}$'),
  registered_office text        CHECK (length(registered_office) BETWEEN 10 AND 400),
  version           integer     NOT NULL DEFAULT 1,
  set_by            text        NOT NULL,
  set_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (legal_form <> 'company' OR (company_number IS NOT NULL AND registered_office IS NOT NULL)),
  CHECK (legal_form <> 'individual' OR (company_number IS NULL AND registered_office IS NULL))
);

-- ═══ 2. A venture's storefront: the agent's own venture identity and its routing address ═══
CREATE FUNCTION fleet_storefront(p_venture uuid) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'brand', i.display_name, 'about', i.bio,
    'supportEmail', COALESCE(
      (SELECT b.address FROM fleet_agent_mailboxes b WHERE b.venture_id = p_venture AND b.status = 'active' ORDER BY b.created_at DESC LIMIT 1),
      (SELECT b.address FROM fleet_agent_mailboxes b JOIN fleet_ventures v ON v.agent_id = b.agent_id
        WHERE v.venture_id = p_venture AND b.status = 'active' ORDER BY b.created_at DESC LIMIT 1))))
  FROM (SELECT 1) one
  LEFT JOIN LATERAL (SELECT x.display_name, x.bio FROM fleet_agent_identities x JOIN fleet_ventures v ON v.venture_id = x.venture_id AND v.agent_id = x.agent_id
                      WHERE x.venture_id = p_venture AND x.status = 'active' AND x.kind IN ('venture_identity','brand')
                      ORDER BY (x.kind = 'venture_identity') DESC, x.updated_at DESC LIMIT 1) i ON true
$$;

-- ═══ 3. Who the buyer is dealing with (pages and buyer emails) ═══
-- Without the legal seller recorded, the owner's v76 free-text notice stands alone (nothing can publish then anyway).
CREATE FUNCTION fleet_seller_notice(p_venture uuid) RETURNS text LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE s fleet_seller_identity; st jsonb := CASE WHEN p_venture IS NULL THEN '{}'::jsonb ELSE fleet_storefront(p_venture) END;
        v_extra text := (SELECT seller_notice FROM fleet_public_site WHERE id = 1);
BEGIN
  SELECT * INTO s FROM fleet_seller_identity WHERE id = 1;
  IF NOT FOUND THEN RETURN v_extra; END IF;
  RETURN concat_ws(E'\\n',
    'Sold by ' || s.legal_name || COALESCE(' trading as ' || s.trading_name, '')
      || CASE WHEN s.legal_form = 'company' THEN ' (company no. ' || s.company_number || ')' ELSE '' END
      || COALESCE(' under the brand ' || (st ->> 'brand'), '') || '.',
    'Address: ' || s.postal_address,
    CASE WHEN s.legal_form = 'company' AND s.registered_office IS DISTINCT FROM s.postal_address THEN 'Registered office: ' || s.registered_office END,
    'Customer support: ' || (st ->> 'supportEmail'),
    'VAT no. ' || s.vat_number,
    v_extra);
END $$;

-- ═══ 1b. The owner sets and reads the legal seller ═══
CREATE FUNCTION fleet_admin_seller_set(p jsonb, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE k text; s fleet_seller_identity; v_old jsonb; v_new jsonb; v_changed text[];
        v_form text; v_name text; v_trading text; v_addr text; v_vat text; v_co text; v_office text;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^(operator|owner):[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a JSON object of seller fields'; END IF;
  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF k NOT IN (${q(SELLER_FIELDS)}) THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: unknown field % (fields: ${SELLER_FIELDS.join(", ")})', k; END IF;
    IF jsonb_typeof(p -> k) NOT IN ('string','null') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: % is text', k; END IF;
  END LOOP;
  SELECT * INTO s FROM fleet_seller_identity WHERE id = 1 FOR UPDATE;
  -- A field left out keeps its value; null clears an optional one.
  v_form    := CASE WHEN p ? 'legalForm' THEN lower(trim(p ->> 'legalForm')) ELSE s.legal_form END;
  v_name    := CASE WHEN p ? 'legalName' THEN NULLIF(trim(p ->> 'legalName'), '') ELSE s.legal_name END;
  v_trading := CASE WHEN p ? 'tradingName' THEN NULLIF(trim(p ->> 'tradingName'), '') ELSE s.trading_name END;
  v_addr    := CASE WHEN p ? 'postalAddress' THEN NULLIF(trim(p ->> 'postalAddress'), '') ELSE s.postal_address END;
  v_vat     := CASE WHEN p ? 'vatNumber' THEN NULLIF(upper(regexp_replace(p ->> 'vatNumber', '[\\s.-]', '', 'g')), '') ELSE s.vat_number END;
  v_co      := CASE WHEN p ? 'companyNumber' THEN NULLIF(upper(regexp_replace(p ->> 'companyNumber', '\\s', '', 'g')), '') ELSE s.company_number END;
  v_office  := CASE WHEN p ? 'registeredOffice' THEN NULLIF(trim(p ->> 'registeredOffice'), '') ELSE s.registered_office END;
  IF v_form IS NULL OR v_form NOT IN ('individual','company') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: legalForm is individual or company'; END IF;
  IF v_name IS NULL OR length(v_name) NOT BETWEEN 2 AND 140 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: legalName (2..140): your own full legal name, or the company''s registered name'; END IF;
  IF v_addr IS NULL OR length(v_addr) NOT BETWEEN 10 AND 400 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: postalAddress (10..400): a geographic address where you can be reached'; END IF;
  IF v_trading IS NOT NULL AND length(v_trading) NOT BETWEEN 2 AND 140 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: tradingName (2..140) or null'; END IF;
  IF v_vat IS NOT NULL AND v_vat !~ '^[A-Z]{2}[0-9A-Z]{5,13}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: vatNumber with its country prefix (e.g. GB123456789), or null if not VAT-registered'; END IF;
  IF v_form = 'company' AND (v_co IS NULL OR v_co !~ '^[0-9A-Z]{6,10}$' OR v_office IS NULL OR length(v_office) NOT BETWEEN 10 AND 400) THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: a company needs companyNumber and registeredOffice';
  END IF;
  IF v_form = 'individual' THEN v_co := NULL; v_office := NULL; END IF;
  v_old := CASE WHEN s.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('legalForm', s.legal_form, 'legalName', s.legal_name, 'tradingName', s.trading_name,
             'postalAddress', s.postal_address, 'vatNumber', s.vat_number, 'companyNumber', s.company_number, 'registeredOffice', s.registered_office) END;
  v_new := jsonb_build_object('legalForm', v_form, 'legalName', v_name, 'tradingName', v_trading, 'postalAddress', v_addr, 'vatNumber', v_vat,
             'companyNumber', v_co, 'registeredOffice', v_office);
  SELECT COALESCE(array_agg(f ORDER BY f), '{}') INTO v_changed FROM unnest(ARRAY[${q(SELLER_FIELDS)}]) f WHERE (v_old -> f) IS DISTINCT FROM (v_new -> f);
  IF s.id IS NOT NULL AND cardinality(v_changed) = 0 THEN RETURN jsonb_build_object('ok', true, 'changed', false, 'version', s.version); END IF;
  INSERT INTO fleet_seller_identity (id, legal_form, legal_name, trading_name, postal_address, vat_number, company_number, registered_office, set_by)
    VALUES (1, v_form, v_name, v_trading, v_addr, v_vat, v_co, v_office, p_actor)
    ON CONFLICT (id) DO UPDATE SET legal_form = EXCLUDED.legal_form, legal_name = EXCLUDED.legal_name, trading_name = EXCLUDED.trading_name,
      postal_address = EXCLUDED.postal_address, vat_number = EXCLUDED.vat_number, company_number = EXCLUDED.company_number,
      registered_office = EXCLUDED.registered_office, version = fleet_seller_identity.version + 1, set_by = EXCLUDED.set_by, set_at = now()
    RETURNING * INTO s;
  -- Which fields, never their values (the address is personal data).
  PERFORM fleet_event('seller_identity_set', NULL, p_actor, jsonb_build_object('version', s.version, 'legalForm', s.legal_form, 'changed', to_jsonb(v_changed)));
  RETURN jsonb_build_object('ok', true, 'changed', true, 'version', s.version, 'fields', to_jsonb(v_changed),
    'example', fleet_seller_notice(NULL));
END $$;

CREATE FUNCTION fleet_admin_seller() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'seller', (SELECT jsonb_strip_nulls(jsonb_build_object('legalForm', s.legal_form, 'legalName', s.legal_name,
      'tradingName', s.trading_name, 'postalAddress', s.postal_address, 'vatNumber', s.vat_number, 'companyNumber', s.company_number,
      'registeredOffice', s.registered_office, 'version', s.version, 'setBy', s.set_by, 'setAt', s.set_at)) FROM fleet_seller_identity s WHERE id = 1),
    'storefronts', COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId', v.agent_id, 'venture', v.venture_key) || fleet_storefront(v.venture_id) ORDER BY v.agent_id, v.venture_key)
      FROM fleet_ventures v WHERE EXISTS (SELECT 1 FROM fleet_offers o WHERE o.venture_id = v.venture_id)), '[]'::jsonb))
$$;

-- ═══ 4. Restated from the latest definitions ═══
${PUBLISH.replace("DECLARE ", "DECLARE v_store jsonb; ")}
${OFFER_PUBLIC_JSON}
${OFFER_PAGE}
${ENQUIRY_PAGE}
${ORDER_PAGE}
${CUSTOMER_MAIL}
${DELIVERY_BODY}
${EVENT_ROUTE}
`;
