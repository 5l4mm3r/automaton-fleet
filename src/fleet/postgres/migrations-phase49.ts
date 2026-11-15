/**
 * Schema v49 — standing identity authority, owner-fact and card fills, card holds, the agent footprint with freeze, and
 * PayPal credentials sealed to the custody executor (docs/design/master-launch-specification.md §§5, 7, 10.2).
 *
 * Owner decision (2026-10-08): agents may use everything — the owner's identity facts and payment card — without
 * waiting for a click, because an owner's delay must not put an agent's life at risk; agents never see a decrypted value;
 * every use is logged in the event list and the agent's footprint, and each account the agent operates can be frozen from
 * there (its credentials revealed to the owner through the existing step-up reveal).
 *
 * 1. STANDING AUTHORITY (fleet_identity_autonomy, one owner row, default OFF): which owner fact classes agents may have
 *    filled into forms, whether the card may be used, the card's per-charge and fleet-wide 24 h maxima, excluded origins.
 *    Revocable at any moment; every change is history.
 * 2. FILLS, NEVER DISCLOSURE. A browser `fill` step may name {credential: "owner_fact", class, field?} or
 *    {credential: "owner_card", field}. The worker asks for it on the session's pinned origin; the registry checks the
 *    authority, the origin and (for the card) an open card hold for that origin; the identity broker seals the value to the
 *    worker's one-time key; the worker fills it and forgets it; snapshots redact it; the agent never receives it. Each
 *    release is one fleet_identity_uses row and an `owner_identity_used` event. Identity documents are not fillable (no
 *    upload action; document submission stays the owner's).
 * 3. CARD HOLDS. Before the card can be filled the agent opens a hold (merchant, origin, maximum) within its wallet card
 *    limits and the owner's maxima; afterwards it declares the charged amount (booked as v48 card clearing: its own cash
 *    first, the treasury for any shortfall) or voids an unused hold. An undeclared hold that was used is booked at its
 *    maximum by the reaper (the owner corrects it from the statement); an unused one is voided.
 * 4. FOOTPRINT AND FREEZE. fleet_agent_footprint: the agent's accounts (platform, origins, login email, status, credential
 *    kinds, the freeze link = the account's first origin), mailboxes, and a timeline of its browser actions, identity uses,
 *    card charges and account events. The owner can freeze an account: no credential or owner value is served for it, no
 *    new browser session opens on it, the agent cannot change its status; unfreezing is the owner's.
 * 5. SEALED CUSTODY CREDENTIALS. The custody executor publishes an X25519 key; the dashboard seals a PayPal app credential
 *    ("clientId:clientSecret") to it in the browser; the registry stores only the ciphertext; only custody can open it.
 *    A rail's PayPal webhook id is a (non-secret) rail property the owner sets.
 */
import { V37_SQL } from "./migrations-phase37.js";
import { V48_SQL } from "./migrations-phase48.js";
import { restate as restateRaw } from "./migrations-phase42.js";

/** restate() applies String.replace: every literal "$" of a replacement is escaped ("$'" would splice in the text after the match). */
const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));

export const EVENT_ROUTES_V49 = Object.freeze({
  P1_HIGH: ["account_frozen", "identity_autonomy_set", "custody_credential_uploaded", "custody_credential_revoked", "card_hold_booked_at_maximum"],
  P2_IMPORTANT: ["account_unfrozen", "card_hold_opened", "rail_webhook_set"],
  AUDIT_ONLY: ["owner_identity_used", "identity_fill_refused", "custody_key_published"],
  AGENT_ACTIVITY_ONLY: ["card_hold_voided"],
} as const);

export const OWNER_CLASSES_V49 = ["legal_name", "date_of_birth", "residential_address", "contact_email", "contact_phone", "id_document", "proof_of_address",
  "tax_identifier", "bank_account_owner", "other_fact", "passport", "driving_licence", "payment_card"] as const;
/** Owner classes a form may be filled from (text facts; documents are never filled). */
export const FILLABLE_CLASSES = ["legal_name", "date_of_birth", "residential_address", "contact_email", "contact_phone", "tax_identifier",
  "bank_account_owner", "other_fact"] as const;
export const CARD_FIELDS = ["number", "expiry", "exp_month", "exp_year", "cvc", "name", "postcode"] as const;
export const CARD_OPS = ["card.authorize", "card.declare", "card.void", "card.list", "identity.uses"] as const;
export const DASHBOARD_READ_OPS_V49 = ["footprint", "identity_autonomy", "identity_uses", "custody_key"] as const;
export const DASHBOARD_SENSITIVE_OPS_V49 = ["identity_autonomy_set", "account_freeze", "account_unfreeze", "custody_credential_upload", "custody_credential_revoke",
  "rail_webhook_set"] as const;

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;`;
const WORKER = `IF p_worker IS NULL OR p_worker !~ '^[a-z0-9-]{3,40}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: worker name'; END IF;`;
const CREDENTIAL_KINDS = "'password','username','email','totp','email_code','sms_code','api_key','generate_password'";

// ── Restatements ──
const STEPS_VALID = restate(V37_SQL, "fleet_browser_steps_valid", [
  [`      IF s ? 'credential' AND (s ->> 'credential') NOT IN (${CREDENTIAL_KINDS}) THEN
        PERFORM fleet_econ_bad('credential is password|username|email|totp|email_code|sms_code|api_key|generate_password');
      END IF;`,
   `      IF s ? 'credential' AND (s ->> 'credential') NOT IN (${CREDENTIAL_KINDS}, 'owner_fact', 'owner_card') THEN
        PERFORM fleet_econ_bad('credential is password|username|email|totp|email_code|sms_code|api_key|generate_password|owner_fact|owner_card');
      END IF;
      -- v49: the owner's facts and card are filled by the broker (never shown); the class / field are named, never a value.
      IF s ->> 'credential' = 'owner_fact' AND (COALESCE(s ->> 'class', '') NOT IN (${q(FILLABLE_CLASSES)})
          OR (s ? 'field' AND COALESCE(s ->> 'field', '') !~ '^[a-z_]{1,30}$')) THEN
        PERFORM fleet_econ_bad('owner_fact needs class ${FILLABLE_CLASSES.join("|")} and an optional field (a key of a structured fact)');
      END IF;
      IF s ->> 'credential' = 'owner_card' AND COALESCE(s ->> 'field', '') NOT IN (${q(CARD_FIELDS)}) THEN
        PERFORM fleet_econ_bad('owner_card needs field ${CARD_FIELDS.join("|")}');
      END IF;`],
]);

const SECRET_REQUEST = restate(V37_SQL, "bx_secret_request", [
  [`DECLARE x fleet_browser_actions := bx_leased(p_action, p_lease); s fleet_browser_sessions; acc fleet_agent_accounts; v_id uuid := gen_random_uuid(); v_kind text := p_kind; v_capture text;`,
   `DECLARE x fleet_browser_actions := bx_leased(p_action, p_lease); s fleet_browser_sessions; acc fleet_agent_accounts; v_id uuid := gen_random_uuid(); v_kind text := p_kind; v_capture text;
        au fleet_identity_autonomy; v_class text; v_field text; v_charge uuid;`],
  [`  IF p_kind LIKE 'capture:%' THEN v_capture := substr(p_kind, 9); v_kind := 'capture'; END IF;`,
   `  -- v49: a frozen account serves nothing.
  IF acc.status = 'frozen' THEN
    PERFORM fleet_event('browser_credential_refused', x.agent_id, 'browser-worker', jsonb_build_object('accountId', acc.account_id, 'reason', 'frozen'));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ACCOUNT_FROZEN');
  END IF;
  -- v49: the owner's facts and card, under the owner's standing authority only (never shown to the agent).
  IF p_kind LIKE 'owner_fact:%' OR p_kind LIKE 'owner_card:%' THEN
    SELECT * INTO au FROM fleet_identity_autonomy WHERE id = 1;
    v_kind := split_part(p_kind, ':', 1);
    v_class := CASE WHEN v_kind = 'owner_card' THEN 'payment_card' ELSE split_part(p_kind, ':', 2) END;
    v_field := NULLIF(CASE WHEN v_kind = 'owner_card' THEN split_part(p_kind, ':', 2) ELSE split_part(p_kind, ':', 3) END, '');
    IF NOT au.enabled OR lower(p_origin) = ANY (au.excluded_origins)
       OR (v_kind = 'owner_fact' AND NOT (v_class = ANY (au.classes))) OR (v_kind = 'owner_card' AND NOT au.card_enabled) THEN
      PERFORM fleet_event('identity_fill_refused', x.agent_id, 'browser-worker', jsonb_build_object('accountId', acc.account_id, 'class', v_class,
        'origin', left(p_origin, 200), 'reason', 'no standing authority'));
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NO_STANDING_AUTHORITY');
    END IF;
    IF (v_kind = 'owner_fact' AND (v_class NOT IN (${q(FILLABLE_CLASSES)}) OR (v_field IS NOT NULL AND v_field !~ '^[a-z_]{1,30}$')))
       OR (v_kind = 'owner_card' AND COALESCE(v_field, '') NOT IN (${q(CARD_FIELDS)})) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM fleet_owner_identity_classes WHERE class_key = v_class AND status = 'configured' AND (expires_at IS NULL OR expires_at > now())) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_OWNER_FACT_UNAVAILABLE');
    END IF;
    IF v_kind = 'owner_card' THEN
      SELECT charge_id INTO v_charge FROM fleet_card_charges WHERE agent_id = x.agent_id AND status = 'held' AND declare_by > now() AND origin = lower(p_origin)
       ORDER BY created_at DESC LIMIT 1;
      IF v_charge IS NULL THEN
        PERFORM fleet_event('identity_fill_refused', x.agent_id, 'browser-worker', jsonb_build_object('accountId', acc.account_id, 'class', v_class,
          'origin', left(p_origin, 200), 'reason', 'no open card hold for this origin'));
        RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CARD_HOLD_REQUIRED');
      END IF;
    END IF;
    INSERT INTO fleet_browser_secret_requests (request_id, action_id, agent_id, account_id, kind, origin, worker_pub, owner_class, owner_field, charge_id)
      VALUES (v_id, x.action_id, x.agent_id, acc.account_id, v_kind, lower(p_origin), p_worker_pub, v_class, v_field, v_charge);
    INSERT INTO fleet_identity_uses (agent_id, account_id, session_id, action_id, request_id, class_key, field, origin, charge_id)
      VALUES (x.agent_id, acc.account_id, x.session_id, x.action_id, v_id, v_class, v_field, lower(p_origin), v_charge);
    PERFORM fleet_event('owner_identity_used', x.agent_id, 'browser-worker', jsonb_build_object('accountId', acc.account_id, 'class', v_class, 'field', v_field,
      'origin', lower(p_origin), 'chargeId', v_charge));
    RETURN jsonb_build_object('ok', true, 'requestId', v_id);
  END IF;
  IF p_kind LIKE 'capture:%' THEN v_capture := substr(p_kind, 9); v_kind := 'capture'; END IF;`],
]);

const SECRETS_PENDING = restate(V37_SQL, "ix_browser_secrets_pending", [
  [`  RETURN COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('requestId', r.request_id, 'kind', r.kind, 'captureKind', r.capture_kind,`,
   `  RETURN COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('requestId', r.request_id, 'kind', r.kind, 'captureKind', r.capture_kind,
      'ownerClass', r.owner_class, 'ownerField', r.owner_field,`],
]);

const BROWSER_OPEN = restate(V37_SQL, "fleet_econ_browser_open", [
  [`       AND status NOT IN ('closed','banned');
    IF v_account IS NULL THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such open account of yours'; END IF;`,
   `       AND status NOT IN ('closed','banned');
    IF v_account IS NULL THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such open account of yours'; END IF;
    IF EXISTS (SELECT 1 FROM fleet_agent_accounts WHERE account_id = v_account AND status = 'frozen') THEN
      RAISE EXCEPTION 'FLEET_ACCOUNT_FROZEN: the owner froze this account';
    END IF;`],
]);

const ACCOUNT_MARK = restate(V37_SQL, "fleet_econ_account_mark", [
  [`  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such account of yours'; END IF;
  IF v_status NOT IN`,
   `  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such account of yours'; END IF;
  IF x.status = 'frozen' THEN RAISE EXCEPTION 'FLEET_ACCOUNT_FROZEN: the owner froze this account'; END IF;
  IF v_status NOT IN`],
]);

const DISPATCH = restate(V48_SQL, "api_economy", [
  // v49: account freezes, card holds and identity refusals come back as data.
  ["PROJECT_[A-Z_]+|ORIGIN_[A-Z_]+):", "PROJECT_[A-Z_]+|ORIGIN_[A-Z_]+|ACCOUNT_[A-Z_]+|CARD_[A-Z_]+|OWNER_[A-Z_]+|NO_STANDING_AUTHORITY|INSUFFICIENT_[A-Z_]+|LEDGER_[A-Z_]+):"],
  [`WHEN 'paypal.checkout' THEN 'planning' WHEN 'paypal.checkouts' THEN 'planning' WHEN 'paypal.cancel' THEN 'planning'`,
   `WHEN 'paypal.checkout' THEN 'planning' WHEN 'paypal.checkouts' THEN 'planning' WHEN 'paypal.cancel' THEN 'planning'
    -- v49: the owner's card as a bypass under the standing authority, and the agent's own record of identity use.
    ${CARD_OPS.map((o) => `WHEN '${o}' THEN 'planning'`).join(" ")}`],
  [`      WHEN 'paypal.cancel' THEN fleet_econ_paypal_cancel(p_agent, a)`,
   `      WHEN 'paypal.cancel' THEN fleet_econ_paypal_cancel(p_agent, a)
      ${CARD_OPS.map((o) => `WHEN '${o}' THEN fleet_econ_${o.replace(".", "_")}(p_agent, a)`).join("\n      ")}`],
]);

const DASH_CALL = restate(V48_SQL, "dash_call", [
  [`'card_receipt_record','card_receipt_resolve');`, `'card_receipt_record','card_receipt_resolve',${q(DASHBOARD_SENSITIVE_OPS_V49)});`],
  [`'paypal','custody')) THEN`, `'paypal','custody',${q(DASHBOARD_READ_OPS_V49)})) THEN`],
  [`      WHEN 'custody' THEN fleet_custody_status()`,
   `      WHEN 'custody' THEN fleet_custody_status()
      -- v49: footprint, standing authority, identity uses, the custody key
      WHEN 'footprint' THEN fleet_agent_footprint(a ->> 'agentId', COALESCE((a ->> 'limit')::integer, 200))
      WHEN 'identity_autonomy' THEN fleet_identity_autonomy_json()
      WHEN 'identity_uses' THEN fleet_identity_uses_json(a ->> 'agentId', COALESCE((a ->> 'limit')::integer, 200))
      WHEN 'custody_key' THEN fleet_custody_key_json()`],
  [`      WHEN 'card_receipt_resolve' THEN`,
   `      WHEN 'identity_autonomy_set' THEN fleet_admin_identity_autonomy_set(COALESCE((a ->> 'enabled')::boolean, false),
          ARRAY(SELECT jsonb_array_elements_text(COALESCE(a -> 'classes', '[]'::jsonb))), COALESCE((a ->> 'cardEnabled')::boolean, false),
          (a ->> 'cardMaxChargeMinor')::bigint, (a ->> 'cardMaxDailyMinor')::bigint,
          ARRAY(SELECT jsonb_array_elements_text(COALESCE(a -> 'excludedOrigins', '[]'::jsonb))), a ->> 'statement', 'operator:owner')
      WHEN 'account_freeze' THEN fleet_admin_account_freeze((a ->> 'accountId')::uuid, a ->> 'reason', 'operator:owner')
      WHEN 'account_unfreeze' THEN fleet_admin_account_unfreeze((a ->> 'accountId')::uuid, COALESCE(a ->> 'status', 'active'), 'operator:owner')
      WHEN 'custody_credential_upload' THEN fleet_admin_custody_credential_upload(a ->> 'vaultRef', decode(a ->> 'sealedB64', 'base64'), 'operator:owner')
      WHEN 'custody_credential_revoke' THEN fleet_admin_custody_credential_revoke(a ->> 'vaultRef', 'operator:owner')
      WHEN 'rail_webhook_set' THEN fleet_admin_rail_webhook_set((a ->> 'railId')::uuid, a ->> 'webhookId', 'operator:owner')
      WHEN 'card_receipt_resolve' THEN`],
]);

const EVENT_ROUTE = restate(V48_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V49) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);

const PAYPAL_RAILS = restate(V48_SQL, "cx_paypal_rails", [
  [`  SELECT COALESCE(jsonb_agg(jsonb_build_object('railId', x.rail_id, 'railMode', x.mode, 'credentialId', x.credential_id, 'vaultRef', k.vault_ref,`,
   `  SELECT COALESCE(jsonb_agg(jsonb_build_object('railId', x.rail_id, 'railMode', x.mode, 'credentialId', x.credential_id, 'vaultRef', k.vault_ref,
           'webhookId', x.webhook_id,`],
]);

export const V49_SQL = `
-- ═══ 1. Owner classes: the payment card ═══
ALTER TABLE fleet_owner_identity_classes DROP CONSTRAINT fleet_owner_identity_classes_class_key_check;
ALTER TABLE fleet_owner_identity_classes ADD CONSTRAINT fleet_owner_identity_classes_class_key_check CHECK (class_key IN (${q(OWNER_CLASSES_V49)}));
ALTER TABLE fleet_owner_identity_consent DROP CONSTRAINT fleet_owner_identity_consent_classes_check;
ALTER TABLE fleet_owner_identity_consent ADD CONSTRAINT fleet_owner_identity_consent_classes_check CHECK (cardinality(classes) BETWEEN 1 AND 13 AND classes <@ ARRAY[${q(OWNER_CLASSES_V49)}]::text[]);
ALTER TABLE fleet_identity_releases DROP CONSTRAINT fleet_identity_releases_classes_check;
ALTER TABLE fleet_identity_releases ADD CONSTRAINT fleet_identity_releases_classes_check CHECK (classes <@ ARRAY[${q(OWNER_CLASSES_V49)}]::text[]);
ALTER TABLE fleet_owner_vault_inbox DROP CONSTRAINT fleet_owner_vault_inbox_class_key_check;
ALTER TABLE fleet_owner_vault_inbox ADD CONSTRAINT fleet_owner_vault_inbox_class_key_check CHECK (class_key IN (${q(OWNER_CLASSES_V49)}));
ALTER TABLE fleet_reveal_requests DROP CONSTRAINT fleet_reveal_requests_class_key_check;
ALTER TABLE fleet_reveal_requests ADD CONSTRAINT fleet_reveal_requests_class_key_check CHECK (class_key IN (${q(OWNER_CLASSES_V49)}));

-- ═══ 2. The owner's standing authority ═══
CREATE TABLE fleet_identity_autonomy (
  id                    smallint    PRIMARY KEY CHECK (id = 1),
  enabled               boolean     NOT NULL DEFAULT false,
  classes               text[]      NOT NULL DEFAULT '{}' CHECK (classes <@ ARRAY[${q(FILLABLE_CLASSES)}]::text[]),
  card_enabled          boolean     NOT NULL DEFAULT false,
  card_max_charge_minor bigint      CHECK (card_max_charge_minor > 0),
  card_max_daily_minor  bigint      CHECK (card_max_daily_minor > 0),
  excluded_origins      text[]      NOT NULL DEFAULT '{}' CHECK (cardinality(excluded_origins) <= 100),
  statement             text        CHECK (length(statement) <= 1000),
  set_by                text        NOT NULL DEFAULT 'migration',
  set_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT card_enabled OR (card_max_charge_minor IS NOT NULL AND card_max_daily_minor IS NOT NULL AND card_max_daily_minor >= card_max_charge_minor))
);
INSERT INTO fleet_identity_autonomy (id) VALUES (1);
CREATE TRIGGER fleet_identity_autonomy_no_delete BEFORE DELETE ON fleet_identity_autonomy FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_identity_autonomy_no_truncate BEFORE TRUNCATE ON fleet_identity_autonomy FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE TABLE fleet_identity_autonomy_history (
  change_id   bigserial   PRIMARY KEY,
  snapshot    jsonb       NOT NULL,
  changed_by  text        NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_identity_autonomy_history_no_change BEFORE UPDATE OR DELETE ON fleet_identity_autonomy_history FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_identity_autonomy_history_no_truncate BEFORE TRUNCATE ON fleet_identity_autonomy_history FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_identity_autonomy_json() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('enabled', a.enabled, 'classes', to_jsonb(a.classes), 'cardEnabled', a.card_enabled, 'cardMaxChargeMinor', a.card_max_charge_minor,
    'cardMaxDailyMinor', a.card_max_daily_minor, 'excludedOrigins', to_jsonb(a.excluded_origins), 'statement', a.statement, 'setBy', a.set_by, 'setAt', a.set_at,
    'fillableClasses', to_jsonb(ARRAY[${q(FILLABLE_CLASSES)}]::text[]),
    'configured', COALESCE((SELECT jsonb_object_agg(class_key, jsonb_build_object('status', status, 'expiresAt', expires_at)) FROM fleet_owner_identity_classes), '{}'::jsonb),
    'history', COALESCE((SELECT jsonb_agg(jsonb_build_object('at', h.changed_at, 'by', h.changed_by, 'snapshot', h.snapshot) ORDER BY h.change_id DESC)
                         FROM (SELECT * FROM fleet_identity_autonomy_history ORDER BY change_id DESC LIMIT 20) h), '[]'::jsonb))
  FROM fleet_identity_autonomy a WHERE a.id = 1
$$;

CREATE FUNCTION fleet_admin_identity_autonomy_set(p_enabled boolean, p_classes text[], p_card_enabled boolean, p_card_max bigint, p_card_daily bigint,
  p_excluded text[], p_statement text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_identity_autonomy; o text;
BEGIN
  ${OWNER_ACTOR}
  IF p_enabled IS NULL OR p_card_enabled IS NULL THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: enabled and cardEnabled are true or false'; END IF;
  IF NOT (COALESCE(p_classes, '{}') <@ ARRAY[${q(FILLABLE_CLASSES)}]::text[]) THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: classes are among ${FILLABLE_CLASSES.join(", ")}';
  END IF;
  FOREACH o IN ARRAY COALESCE(p_excluded, '{}') LOOP
    IF NOT fleet_origin_ok(lower(o)) THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: excluded origins are https://host[:port]'; END IF;
  END LOOP;
  UPDATE fleet_identity_autonomy SET enabled = p_enabled, classes = COALESCE(p_classes, '{}'), card_enabled = p_card_enabled,
         card_max_charge_minor = p_card_max, card_max_daily_minor = p_card_daily,
         excluded_origins = ARRAY(SELECT DISTINCT lower(x) FROM unnest(COALESCE(p_excluded, '{}')) x), statement = left(fleet_scrub(p_statement), 1000),
         set_by = p_actor, set_at = now()
   WHERE id = 1 RETURNING * INTO r;
  INSERT INTO fleet_identity_autonomy_history (snapshot, changed_by) VALUES (to_jsonb(r) - 'id', p_actor);
  PERFORM fleet_event('identity_autonomy_set', NULL, p_actor, jsonb_build_object('enabled', r.enabled, 'classes', to_jsonb(r.classes), 'cardEnabled', r.card_enabled,
    'cardMaxChargeMinor', r.card_max_charge_minor, 'cardMaxDailyMinor', r.card_max_daily_minor));
  RETURN jsonb_build_object('ok', true, 'autonomy', fleet_identity_autonomy_json());
END $$;

-- ═══ 3. Accounts the owner can freeze ═══
ALTER TABLE fleet_agent_accounts DROP CONSTRAINT fleet_agent_accounts_status_check;
ALTER TABLE fleet_agent_accounts ADD CONSTRAINT fleet_agent_accounts_status_check CHECK (status IN ('requested','creating','pending_verification','active',
  'human_action_required','suspended','banned','closed','failed','frozen'));
ALTER TABLE fleet_agent_accounts
  ADD COLUMN frozen_at     timestamptz,
  ADD COLUMN frozen_by     text,
  ADD COLUMN frozen_reason text CHECK (length(frozen_reason) <= 300);

CREATE FUNCTION fleet_admin_account_freeze(p_account uuid, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_agent_accounts; n integer;
BEGIN
  ${OWNER_ACTOR}
  SELECT * INTO x FROM fleet_agent_accounts WHERE account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such account'; END IF;
  IF x.status = 'frozen' THEN RETURN jsonb_build_object('ok', true, 'replay', true); END IF;
  UPDATE fleet_agent_accounts SET status = 'frozen', frozen_at = now(), frozen_by = p_actor,
         frozen_reason = left(COALESCE(NULLIF(trim(fleet_scrub(p_reason)), ''), 'frozen by the owner'), 300), updated_at = now()
   WHERE account_id = p_account;
  UPDATE fleet_browser_sessions SET status = 'closed', closed_at = now() WHERE account_id = p_account AND status = 'open';
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM fleet_event('account_frozen', x.agent_id, p_actor, jsonb_build_object('accountId', p_account, 'platform', x.platform, 'previousStatus', x.status,
    'sessionsClosed', n));
  RETURN jsonb_build_object('ok', true, 'accountId', p_account, 'previousStatus', x.status, 'sessionsClosed', n,
    'note', 'nothing is served for this account any more; close it at the provider with the revealed credentials if needed');
END $$;

CREATE FUNCTION fleet_admin_account_unfreeze(p_account uuid, p_status text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_agent_accounts;
BEGIN
  ${OWNER_ACTOR}
  IF p_status NOT IN ('active','suspended','closed') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: active, suspended or closed'; END IF;
  SELECT * INTO x FROM fleet_agent_accounts WHERE account_id = p_account FOR UPDATE;
  IF NOT FOUND OR x.status <> 'frozen' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: not a frozen account'; END IF;
  UPDATE fleet_agent_accounts SET status = p_status, closed_at = CASE WHEN p_status = 'closed' THEN now() ELSE closed_at END, updated_at = now()
   WHERE account_id = p_account;
  PERFORM fleet_event('account_unfrozen', x.agent_id, p_actor, jsonb_build_object('accountId', p_account, 'status', p_status));
  RETURN jsonb_build_object('ok', true, 'accountId', p_account, 'status', p_status);
END $$;

${BROWSER_OPEN}

${ACCOUNT_MARK}

-- ═══ 4. Owner fills: the request grammar, the log ═══
ALTER TABLE fleet_browser_secret_requests DROP CONSTRAINT fleet_browser_secret_requests_kind_check;
ALTER TABLE fleet_browser_secret_requests ADD CONSTRAINT fleet_browser_secret_requests_kind_check
  CHECK (kind IN (${CREDENTIAL_KINDS}, 'auth_link', 'capture', 'owner_fact', 'owner_card'));
ALTER TABLE fleet_browser_secret_requests
  ADD COLUMN owner_class text CHECK (owner_class IN (${q([...FILLABLE_CLASSES, "payment_card"])})),
  ADD COLUMN owner_field text CHECK (owner_field ~ '^[a-z_]{1,30}$'),
  ADD COLUMN charge_id   uuid REFERENCES fleet_card_charges(charge_id),
  ADD CONSTRAINT fleet_browser_secret_requests_owner CHECK ((kind IN ('owner_fact','owner_card')) = (owner_class IS NOT NULL)
    AND (kind <> 'owner_card' OR (owner_class = 'payment_card' AND charge_id IS NOT NULL AND owner_field IS NOT NULL)));

CREATE TABLE fleet_identity_uses (
  use_id      bigserial   PRIMARY KEY,
  agent_id    text        NOT NULL REFERENCES fleet_agents(agent_id),
  account_id  uuid        NOT NULL REFERENCES fleet_agent_accounts(account_id),
  session_id  uuid        NOT NULL REFERENCES fleet_browser_sessions(session_id),
  action_id   uuid        NOT NULL REFERENCES fleet_browser_actions(action_id),
  request_id  uuid        NOT NULL UNIQUE REFERENCES fleet_browser_secret_requests(request_id),
  class_key   text        NOT NULL,
  field       text,
  origin      text        NOT NULL,
  charge_id   uuid        REFERENCES fleet_card_charges(charge_id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_identity_uses_agent ON fleet_identity_uses (agent_id, created_at DESC);
CREATE TRIGGER fleet_identity_uses_no_change BEFORE UPDATE OR DELETE ON fleet_identity_uses FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_identity_uses_no_truncate BEFORE TRUNCATE ON fleet_identity_uses FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

${STEPS_VALID}

${SECRET_REQUEST}

${SECRETS_PENDING}

CREATE FUNCTION fleet_identity_uses_json(p_agent text, p_limit integer) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('at', u.created_at, 'agentId', u.agent_id, 'accountId', u.account_id,
      'platform', (SELECT platform FROM fleet_agent_accounts WHERE account_id = u.account_id), 'class', u.class_key, 'field', u.field, 'origin', u.origin,
      'chargeId', u.charge_id, 'served', (SELECT status FROM fleet_browser_secret_requests r WHERE r.request_id = u.request_id) IN ('served','taken')))
    ORDER BY u.use_id DESC), '[]'::jsonb)
  FROM (SELECT * FROM fleet_identity_uses WHERE p_agent IS NULL OR agent_id = p_agent ORDER BY use_id DESC LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000)) u
$$;

-- ═══ 5. Card holds (the agent's side of the card bypass) ═══
CREATE FUNCTION fleet_card_charges_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.charge_id <> OLD.charge_id OR NEW.agent_id <> OLD.agent_id OR NEW.created_at <> OLD.created_at OR NEW.source <> OLD.source
     OR NEW.origin IS DISTINCT FROM OLD.origin OR NEW.hold_max_minor IS DISTINCT FROM OLD.hold_max_minor THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a card charge''s agent, source, origin and hold are fixed';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'held' AND NEW.status IN ('booked','void','confirmed')) OR (OLD.status = 'booked' AND NEW.status = 'confirmed')) THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: card charge % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_card_charges_guard BEFORE UPDATE ON fleet_card_charges FOR EACH ROW EXECUTE FUNCTION fleet_card_charges_guard();

CREATE FUNCTION fleet_card_charge_json(c fleet_card_charges) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('chargeId', c.charge_id, 'merchant', c.merchant, 'origin', c.origin, 'status', c.status, 'holdMaxMinor', c.hold_max_minor,
    'amountMinor', c.amount_minor, 'fromYourCashMinor', c.agent_part_minor, 'treasuryCoveredMinor', c.treasury_part_minor, 'declareBy', c.declare_by,
    'used', EXISTS (SELECT 1 FROM fleet_identity_uses u WHERE u.charge_id = c.charge_id), 'createdAt', c.created_at))
$$;

CREATE FUNCTION fleet_econ_card_authorize(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE au fleet_identity_autonomy; acc fleet_agent_accounts; lim fleet_agent_wallet_limits; c fleet_card_charges; v_max bigint; v_origin text;
        v_merchant text := fleet_econ_text(a, 'merchant', 120, true); v_agent_day bigint; v_fleet_day bigint;
BEGIN
  SELECT * INTO au FROM fleet_identity_autonomy WHERE id = 1;
  IF NOT au.enabled OR NOT au.card_enabled THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NO_STANDING_AUTHORITY', 'reason', 'the owner has not enabled the card bypass; use a vendor payout or another payment path');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fleet_owner_identity_classes WHERE class_key = 'payment_card' AND status = 'configured' AND (expires_at IS NULL OR expires_at > now())) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_OWNER_FACT_UNAVAILABLE', 'reason', 'no card is on file');
  END IF;
  SELECT * INTO acc FROM fleet_agent_accounts WHERE account_id = fleet_identity_uuid(a, 'accountId') AND agent_id = p_agent;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: accountId — one of your accounts (the merchant site you pay on)'; END IF;
  IF acc.status IN ('frozen','closed','banned') THEN RAISE EXCEPTION 'FLEET_ACCOUNT_FROZEN: that account cannot be used'; END IF;
  v_origin := lower(COALESCE(a ->> 'origin', acc.origins[1]));
  IF v_origin IS NULL OR NOT (v_origin = ANY (acc.origins)) THEN PERFORM fleet_econ_bad('origin is one of the account''s pinned origins (add_origin first)'); END IF;
  IF v_origin = ANY (au.excluded_origins) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ORIGIN_EXCLUDED'); END IF;
  v_max := CASE WHEN jsonb_typeof(a -> 'maxMinor') = 'number' THEN (a ->> 'maxMinor')::bigint END;
  IF v_max IS NULL OR v_max <= 0 THEN PERFORM fleet_econ_bad('maxMinor — the most this purchase may cost, in minor units'); END IF;
  SELECT * INTO lim FROM fleet_agent_wallet_limits WHERE agent_id = p_agent;
  IF v_max > au.card_max_charge_minor OR (lim.card_max_charge_minor IS NOT NULL AND v_max > lim.card_max_charge_minor) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CARD_LIMIT', 'maxMinor', LEAST(au.card_max_charge_minor, COALESCE(lim.card_max_charge_minor, au.card_max_charge_minor)));
  END IF;
  SELECT COALESCE(sum(COALESCE(amount_minor, hold_max_minor)), 0) INTO v_agent_day FROM fleet_card_charges
   WHERE agent_id = p_agent AND status <> 'void' AND created_at > now() - interval '24 hours';
  SELECT COALESCE(sum(COALESCE(amount_minor, hold_max_minor)), 0) INTO v_fleet_day FROM fleet_card_charges WHERE status <> 'void' AND created_at > now() - interval '24 hours';
  IF v_fleet_day + v_max > au.card_max_daily_minor OR (lim.card_max_daily_minor IS NOT NULL AND v_agent_day + v_max > lim.card_max_daily_minor) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CARD_DAILY_LIMIT');
  END IF;
  IF EXISTS (SELECT 1 FROM fleet_card_charges WHERE agent_id = p_agent AND status = 'held' AND origin = v_origin AND declare_by > now()) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CARD_HOLD_OPEN', 'reason', 'declare or void your open hold on this site first');
  END IF;
  INSERT INTO fleet_card_charges (agent_id, merchant, origin, status, source, hold_max_minor, declare_by)
    VALUES (p_agent, left(fleet_scrub(v_merchant), 120), v_origin, 'held', 'agent', v_max, now() + interval '24 hours') RETURNING * INTO c;
  PERFORM fleet_event('card_hold_opened', p_agent, p_agent, jsonb_build_object('chargeId', c.charge_id, 'merchant', c.merchant, 'origin', v_origin, 'holdMaxMinor', v_max,
    'purpose', left(fleet_scrub(a ->> 'purpose'), 200)));
  RETURN jsonb_build_object('ok', true, 'charge', fleet_card_charge_json(c),
    'note', 'fill the card with browser fill steps {credential:"owner_card", field:number|expiry|exp_month|exp_year|cvc|name|postcode} on this origin; '
         || 'then declare the amount charged (or void the hold if you did not pay) within 24 hours');
END $$;

CREATE FUNCTION fleet_econ_card_declare(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_card_charges; v_amount bigint; r jsonb;
BEGIN
  SELECT * INTO c FROM fleet_card_charges WHERE charge_id = fleet_identity_uuid(a, 'chargeId') AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such card hold of yours'; END IF;
  IF c.status <> 'held' THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'charge', fleet_card_charge_json(c)); END IF;
  v_amount := CASE WHEN jsonb_typeof(a -> 'amountMinor') = 'number' THEN (a ->> 'amountMinor')::bigint END;
  IF v_amount IS NULL OR v_amount <= 0 THEN PERFORM fleet_econ_bad('amountMinor — what the merchant charged (void the hold if nothing was charged)'); END IF;
  IF v_amount > c.hold_max_minor THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CARD_OVER_HOLD', 'reason', 'more than the hold: declare the hold maximum; the owner books the rest from the statement');
  END IF;
  r := fleet_card_charge_post(c.charge_id, v_amount, 'card:' || c.charge_id || ':book', 'controller', 'agent:' || p_agent);
  SELECT * INTO c FROM fleet_card_charges WHERE charge_id = c.charge_id;
  PERFORM fleet_event('card_charge_booked', p_agent, p_agent, jsonb_build_object('chargeId', c.charge_id, 'amountMinor', v_amount,
    'agentPartMinor', c.agent_part_minor, 'treasuryPartMinor', c.treasury_part_minor, 'merchant', c.merchant));
  RETURN jsonb_build_object('ok', true, 'charge', fleet_card_charge_json(c));
END $$;

CREATE FUNCTION fleet_econ_card_void(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_card_charges;
BEGIN
  SELECT * INTO c FROM fleet_card_charges WHERE charge_id = fleet_identity_uuid(a, 'chargeId') AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such card hold of yours'; END IF;
  IF c.status <> 'held' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE', 'status', c.status); END IF;
  IF EXISTS (SELECT 1 FROM fleet_identity_uses u WHERE u.charge_id = c.charge_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CARD_USED', 'reason', 'the card was filled for this hold: declare what was charged');
  END IF;
  UPDATE fleet_card_charges SET status = 'void' WHERE charge_id = c.charge_id RETURNING * INTO c;
  PERFORM fleet_event('card_hold_voided', p_agent, p_agent, jsonb_build_object('chargeId', c.charge_id));
  RETURN jsonb_build_object('ok', true, 'charge', fleet_card_charge_json(c));
END $$;

CREATE FUNCTION fleet_econ_card_list(p_agent text, a jsonb) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'authority', (SELECT jsonb_build_object('cardEnabled', au.enabled AND au.card_enabled, 'maxChargeMinor', au.card_max_charge_minor)
      FROM fleet_identity_autonomy au WHERE au.id = 1),
    'charges', COALESCE((SELECT jsonb_agg(fleet_card_charge_json(c) ORDER BY c.created_at DESC)
      FROM fleet_card_charges c WHERE c.charge_id IN (SELECT x.charge_id FROM fleet_card_charges x WHERE x.agent_id = p_agent ORDER BY x.created_at DESC LIMIT 50)), '[]'::jsonb))
$$;

CREATE FUNCTION fleet_econ_identity_uses(p_agent text, a jsonb) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'authority', (SELECT jsonb_build_object('enabled', au.enabled, 'classes', to_jsonb(au.classes), 'cardEnabled', au.card_enabled)
      FROM fleet_identity_autonomy au WHERE au.id = 1),
    'uses', fleet_identity_uses_json(p_agent, 50))
$$;

-- Reaper: a hold past its declaration time is booked at its maximum when the card was filled for it, else voided.
CREATE FUNCTION svc_card_holds_expire(p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_card_charges; nb integer := 0; nv integer := 0;
BEGIN
  FOR c IN SELECT * FROM fleet_card_charges WHERE status = 'held' AND declare_by <= now() ORDER BY declare_by LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500) FOR UPDATE SKIP LOCKED LOOP
    IF EXISTS (SELECT 1 FROM fleet_identity_uses u WHERE u.charge_id = c.charge_id) THEN
      PERFORM fleet_card_charge_post(c.charge_id, c.hold_max_minor, 'card:' || c.charge_id || ':book', 'controller', 'controller');
      PERFORM fleet_event('card_hold_booked_at_maximum', c.agent_id, 'controller', jsonb_build_object('chargeId', c.charge_id, 'amountMinor', c.hold_max_minor,
        'merchant', c.merchant, 'note', 'undeclared after use: confirm the statement amount'));
      nb := nb + 1;
    ELSE
      UPDATE fleet_card_charges SET status = 'void' WHERE charge_id = c.charge_id;
      PERFORM fleet_event('card_hold_voided', c.agent_id, 'controller', jsonb_build_object('chargeId', c.charge_id, 'reason', 'expired unused'));
      nv := nv + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'bookedAtMaximum', nb, 'voided', nv);
END $$;

-- ═══ 6. The agent footprint ═══
CREATE FUNCTION fleet_agent_footprint(p_agent text, p_limit integer) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  WITH acc AS (SELECT * FROM fleet_agent_accounts WHERE agent_id = p_agent),
  tl AS (
    SELECT a.created_at AS at, 'browser' AS kind, jsonb_strip_nulls(jsonb_build_object('actionId', a.action_id, 'action', a.kind, 'status', a.status,
        'accountId', s.account_id, 'platform', x.platform,
        'url', COALESCE((SELECT st ->> 'url' FROM jsonb_array_elements(a.steps) st WHERE st ->> 'action' = 'goto' LIMIT 1), s.url),
        'steps', (SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('action', st ->> 'action', 'selector', left(st ->> 'selector', 120), 'text', left(st ->> 'text', 80),
                    'url', st ->> 'url', 'credential', st ->> 'credential', 'class', st ->> 'class', 'field', st ->> 'field'))) FROM jsonb_array_elements(a.steps) st),
        'pageUrl', a.result ->> 'url', 'error', a.result ->> 'error')) AS detail
      FROM fleet_browser_actions a JOIN fleet_browser_sessions s ON s.session_id = a.session_id LEFT JOIN fleet_agent_accounts x ON x.account_id = s.account_id
     WHERE a.agent_id = p_agent
    UNION ALL
    SELECT u.created_at, 'identity_use', jsonb_strip_nulls(jsonb_build_object('class', u.class_key, 'field', u.field, 'origin', u.origin, 'accountId', u.account_id,
        'chargeId', u.charge_id, 'platform', (SELECT platform FROM fleet_agent_accounts WHERE account_id = u.account_id)))
      FROM fleet_identity_uses u WHERE u.agent_id = p_agent
    UNION ALL
    SELECT c.created_at, 'card', fleet_card_charge_json(c) FROM fleet_card_charges c WHERE c.agent_id = p_agent
    UNION ALL
    SELECT e.created_at, 'event', jsonb_build_object('type', e.event_type, 'detail', e.detail) FROM fleet_events e
     WHERE e.agent_id = p_agent AND e.event_type IN ('account_registered','account_origin_added','account_marked','account_frozen','account_unfrozen',
           'agent_identity_created','mail_route_created','browser_credential_stored','browser_credential_refused','identity_fill_refused','paypal_checkout_requested',
           'paypal_receipt_posted','vendor_registered','payment_order_reserved','payment_instruction_issued')
  )
  SELECT jsonb_build_object('agentId', p_agent,
    'accounts', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('accountId', a.account_id, 'platform', a.platform, 'kind', a.account_kind, 'handle', a.handle,
        'loginEmail', a.login_email, 'origins', to_jsonb(a.origins), 'status', a.status, 'verification', a.verification, 'credentialHealth', a.credential_health,
        'credentials', (SELECT jsonb_agg(jsonb_build_object('credentialId', k.credential_id, 'kind', k.kind) ORDER BY k.created_at)
                        FROM fleet_agent_account_credentials k WHERE k.account_id = a.account_id AND k.status = 'active'),
        'freezeUrl', a.origins[1], 'frozenAt', a.frozen_at, 'frozenReason', a.frozen_reason, 'createdAt', a.created_at,
        'lastUsedAt', (SELECT max(s.last_used_at) FROM fleet_browser_sessions s WHERE s.account_id = a.account_id))) ORDER BY a.created_at DESC) FROM acc a), '[]'::jsonb),
    'mailboxes', COALESCE((SELECT jsonb_agg(jsonb_build_object('mailboxId', m.mailbox_id, 'address', m.address, 'provider', m.provider, 'status', m.status,
        'accountId', m.account_id, 'createdAt', m.created_at) ORDER BY m.created_at) FROM fleet_agent_mailboxes m WHERE m.agent_id = p_agent), '[]'::jsonb),
    'timeline', COALESCE((SELECT jsonb_agg(jsonb_build_object('at', t.at, 'kind', t.kind, 'detail', t.detail) ORDER BY t.at DESC)
        FROM (SELECT * FROM tl ORDER BY at DESC LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000)) t), '[]'::jsonb))
$$;

-- ═══ 7. PayPal credentials sealed to the custody executor; webhook ids ═══
CREATE TABLE fleet_custody_keys (
  id           smallint    PRIMARY KEY CHECK (id = 1),
  public_key   text        NOT NULL CHECK (public_key ~ '^[A-Za-z0-9+/=]{40,120}$'),
  fingerprint  text        NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  published_by text        NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE fleet_custody_sealed_credentials (
  vault_ref    text        PRIMARY KEY CHECK (vault_ref ~ '^vault:paypal/[a-z0-9/._-]{1,100}$'),
  sealed       bytea       CHECK (octet_length(sealed) BETWEEN 32 AND 8000),
  key_fingerprint text     NOT NULL CHECK (key_fingerprint ~ '^[0-9a-f]{64}$'),
  status       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  uploaded_by  text        NOT NULL,
  uploaded_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL AND sealed IS NULL))
);
CREATE TRIGGER fleet_custody_sealed_credentials_no_delete BEFORE DELETE ON fleet_custody_sealed_credentials FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION cx_publish_key(p_worker text, p_public_key text, p_fingerprint text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE k fleet_custody_keys;
BEGIN
  ${WORKER}
  IF p_public_key !~ '^[A-Za-z0-9+/=]{40,120}$' OR p_fingerprint !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  SELECT * INTO k FROM fleet_custody_keys WHERE id = 1;
  IF FOUND AND k.fingerprint = p_fingerprint THEN RETURN jsonb_build_object('ok', true, 'unchanged', true); END IF;
  INSERT INTO fleet_custody_keys (id, public_key, fingerprint, published_by) VALUES (1, p_public_key, p_fingerprint, 'custody:' || p_worker)
  ON CONFLICT (id) DO UPDATE SET public_key = EXCLUDED.public_key, fingerprint = EXCLUDED.fingerprint, published_by = EXCLUDED.published_by, published_at = now();
  PERFORM fleet_event('custody_key_published', NULL, 'custody', jsonb_build_object('fingerprint', p_fingerprint, 'previous', k.fingerprint));
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE FUNCTION cx_sealed_credentials(p_worker text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  ${WORKER}
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('vaultRef', c.vault_ref, 'sealedB64', encode(c.sealed, 'base64'), 'fingerprint', c.key_fingerprint))
    FROM fleet_custody_sealed_credentials c WHERE c.status = 'active'), '[]'::jsonb);
END $$;

CREATE FUNCTION fleet_custody_key_json() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('publicKey', k.public_key, 'fingerprint', k.fingerprint, 'publishedAt', k.published_at,
    'credentials', COALESCE((SELECT jsonb_agg(jsonb_build_object('vaultRef', c.vault_ref, 'status', c.status, 'uploadedAt', c.uploaded_at, 'revokedAt', c.revoked_at,
        'currentKey', c.key_fingerprint = k.fingerprint) ORDER BY c.uploaded_at DESC) FROM fleet_custody_sealed_credentials c), '[]'::jsonb))
  FROM (SELECT 1) one LEFT JOIN fleet_custody_keys k ON k.id = 1
$$;

CREATE FUNCTION fleet_admin_custody_credential_upload(p_vault_ref text, p_sealed bytea, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE k fleet_custody_keys;
BEGIN
  ${OWNER_ACTOR}
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  SELECT * INTO k FROM fleet_custody_keys WHERE id = 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_CUSTODY_KEY_UNAVAILABLE: the custody executor has not published its key yet'; END IF;
  IF p_vault_ref IS NULL OR p_vault_ref !~ '^vault:paypal/[a-z0-9/._-]{1,100}$' OR p_sealed IS NULL OR octet_length(p_sealed) NOT BETWEEN 32 AND 8000 THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: vault:paypal/<name> and a sealed credential';
  END IF;
  INSERT INTO fleet_custody_sealed_credentials (vault_ref, sealed, key_fingerprint, uploaded_by) VALUES (p_vault_ref, p_sealed, k.fingerprint, p_actor)
  ON CONFLICT (vault_ref) DO UPDATE SET sealed = EXCLUDED.sealed, key_fingerprint = EXCLUDED.key_fingerprint, status = 'active', revoked_at = NULL,
    uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now();
  PERFORM fleet_event('custody_credential_uploaded', NULL, p_actor, jsonb_build_object('vaultRef', p_vault_ref, 'keyFingerprint', k.fingerprint));
  RETURN jsonb_build_object('ok', true, 'vaultRef', p_vault_ref,
    'next', 'register it as a credential reference (economy-credential-register paypal ' || p_vault_ref || ' …) and use it on the PayPal rail');
END $$;

CREATE FUNCTION fleet_admin_custody_credential_revoke(p_vault_ref text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  ${OWNER_ACTOR}
  UPDATE fleet_custody_sealed_credentials SET status = 'revoked', sealed = NULL, revoked_at = now() WHERE vault_ref = p_vault_ref AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no active sealed credential with that reference'; END IF;
  PERFORM fleet_event('custody_credential_revoked', NULL, p_actor, jsonb_build_object('vaultRef', p_vault_ref));
  RETURN jsonb_build_object('ok', true, 'vaultRef', p_vault_ref);
END $$;

ALTER TABLE fleet_payment_rails ADD COLUMN webhook_id text CHECK (webhook_id ~ '^[A-Z0-9]{8,40}$');
CREATE FUNCTION fleet_admin_rail_webhook_set(p_rail uuid, p_webhook text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  ${OWNER_ACTOR}
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  UPDATE fleet_payment_rails SET webhook_id = p_webhook WHERE rail_id = p_rail AND provider = 'paypal' AND status <> 'revoked';
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no PayPal rail with that id'; END IF;
  PERFORM fleet_event('rail_webhook_set', NULL, p_actor, jsonb_build_object('railId', p_rail, 'webhookId', p_webhook));
  RETURN jsonb_build_object('ok', true, 'railId', p_rail, 'webhookId', p_webhook);
END $$;

${PAYPAL_RAILS}

-- ═══ 8. Agent operations, dashboard, routing ═══
${DISPATCH}

${DASH_CALL}

${EVENT_ROUTE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
