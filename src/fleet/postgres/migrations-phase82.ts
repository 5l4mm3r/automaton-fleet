/**
 * Schema v82 — owner sign-in recovery, the buyer's consent to immediate digital supply, and the helpers read (owner
 * decisions, 2026-10-16). v81 is not edited; v82 restates only what it names.
 *
 * 1. SIGN-IN RECOVERY (nothing here grants a session — every route ends at the normal sign-in, and each needs TWO factors):
 *    - Recovery codes: ten one-time codes, issued from a full session with a fresh confirmation ('recovery_codes_issue',
 *      args '{}'). Only a keyed digest of each code is stored (the dashboard derives it; a database copy alone cannot
 *      be checked against a guess). Issuing a new set retires every unused code of the old set.
 *    - Forgot password: a current authenticator code AND an unused recovery code set a new password. Every session ends.
 *      (With a passkey at hand, the passkey + code sign-in followed by Security → Change password still works.)
 *    - Lost authenticator: the password OR a passkey AND an unused recovery code start a replacement; the new
 *      authenticator replaces the old one only when a code from it is confirmed. Every session ends.
 *    - Each use spends the code, ends every session and raises a RED notification (emailed). Failures count towards the
 *      existing sign-in lockout (logged as failed 'login' attempts). Losing every factor stays a host recovery.
 * 2. BUYER CONSENT (Consumer Contracts Regulations 2013, regs 36 and 37) on every purchase route the Fleet runs itself:
 *    - offer page (product): the buyer's express request for immediate supply and acknowledgement that the right to cancel is
 *      lost once the download is made available, given with the purchase;
 *    - quoted service, the owner's proof purchase, and any checkout an agent makes (paypal.checkout): every such order now has
 *      an order page; the consent is given there before the payment link appears (the agent is given the page, never the raw
 *      PayPal link: no agent read carries the approval link of a checkout that has a page).
 *    The wording is versioned and immutable; each order records which version, when, and from which (hashed) origin. Without
 *    a record: no payment link, no download, no attachment. The durable confirmation: a delivery mail made after the consent
 *    repeats it; otherwise the offer pass sends an "Order confirmation" mail once the order is paid (contract summary, the
 *    consent, the page). Platform checkouts (Etsy, Gumroad) are the platform's own pages: the Fleet cannot add the boxes.
 * 3. HELPER JOBS: each helper call's kind, the purpose the agent stated with it (research, marketing, production,
 *    customer_support; a critical question is a decision, an independent review a quality review, an evidence check Fleet
 *    Control's), and its start and end (running → finished / failed, or ended with no result) are recorded as the call is
 *    reserved and recorded (fleet_helper_jobs, by triggers on the reservation and the log). The dashboard read `helpers`
 *    shows the last ten minutes — classes, purposes and times only, never prompts or content. A chore from an older agent
 *    runtime that states no purpose is recorded with none — never guessed. The Virtual desks are a picture of these jobs; an
 *    idle desk is never a running model session.
 */
import { V48_SQL } from "./migrations-phase48.js";
import { V58_SQL } from "./migrations-phase58.js";
import { V76_SQL } from "./migrations-phase76.js";
import { V78_SQL } from "./migrations-phase78.js";
import { V81_SQL } from "./migrations-phase81.js";
import { restate as restateRaw } from "./migrations-phase42.js";
import { PASSWORD_VERIFIER_RE } from "./migrations-phase43.js";
import { ROUTINE_TASK_CLASSES } from "../cognition/types.js";
import { HELPER_PURPOSES, ROUTINE_PURPOSES } from "../cognition/router.js";
import { BUYER_CONSENT_VERSION, BUYER_CONSENT_WORDING } from "../storefront/consent.js";

export { BUYER_CONSENT_VERSION, BUYER_CONSENT_WORDING };

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

export const DASHBOARD_READ_OPS_V82 = ["helpers"] as const;
/** The step-up operation that issues a new set of recovery codes (args '{}'). */
export const RECOVERY_CODES_OP = "recovery_codes_issue";
export const RECOVERY_CODE_COUNT = 10;
/** Every purpose a helper job can carry (founder-stated, route-proven, or the reviews' own kind). */
export const HELPER_JOB_PURPOSES = [...HELPER_PURPOSES, "evidence_check"] as const;
/** How far back the helpers read looks (seconds). */
export const HELPERS_WINDOW_S = 600;

const DASH_CALL = restate(V81_SQL, "dash_call", [
  [`'agent_thread','agent_mind','mail_summary','launch')) THEN`, `'agent_thread','agent_mind','mail_summary','launch',${q(DASHBOARD_READ_OPS_V82)})) THEN`],
  [`      WHEN 'launch' THEN fleet_launch_status_json()`, `      WHEN 'launch' THEN fleet_launch_status_json()
      WHEN 'helpers' THEN fleet_helpers_json()`],
]);

// The order page: consent state and wording; no payment link and no downloads until the buyer's consent is recorded.
const ORDER_PAGE = restate(V78_SQL, "svc_order_page", [
  [`'approvalUrl', CASE WHEN c.status = 'open' THEN c.approval_url END,`,
   `'approvalUrl', CASE WHEN c.status = 'open' AND x.consent_at IS NOT NULL THEN c.approval_url END,
      'consent', fleet_order_consent_json(x),`],
  [`'downloads', CASE WHEN x.payment_status IN ('paid','partially_refunded') THEN`,
   `'downloads', CASE WHEN x.payment_status IN ('paid','partially_refunded') AND x.consent_at IS NOT NULL THEN`],
]);
const ORDER_FILE = restate(V76_SQL, "svc_order_file", [
  [`     AND x.payment_status IN ('paid','partially_refunded');`, `     AND x.payment_status IN ('paid','partially_refunded') AND x.consent_at IS NOT NULL;`],
]);
// A delivery mail attaches files only when the buyer's consent is recorded; otherwise the files wait on the order page,
// behind the same consent. (An order without an order page — a checkout the agent sent outside the offer and quote pages —
// has nowhere to ask: it is delivered as before, and its buyer keeps the 14-day right to cancel.)
const DELIVERY_DISPATCH = restate(V76_SQL, "fleet_order_delivery_dispatch", [
  [`  IF (SELECT sum(size_bytes) FROM fleet_order_delivery_files WHERE delivery_id = d.delivery_id) > `,
   `  IF (o.consent_at IS NULL AND o.access_token IS NOT NULL) OR (SELECT sum(size_bytes) FROM fleet_order_delivery_files WHERE delivery_id = d.delivery_id) > `],
]);
// The delivery mail repeats the recorded consent (or says the order page will ask for it before the first download).
const DELIVERY_BODY = restate(V78_SQL, "fleet_order_delivery_body", [
  [`    '--' || E'\\n' || fleet_seller_notice(o.venture_id))`, `    fleet_order_consent_text(o),
    '--' || E'\\n' || fleet_seller_notice(o.venture_id))`],
]);

// Every order an agent makes for a buyer gets an order page (the consent step lives there); the agent gives the buyer that
// page, never the raw PayPal link.
const CHECKOUT_ORDER = restate(V58_SQL, "fleet_econ_paypal_checkout_order", [
  [`  INSERT INTO fleet_customer_orders (agent_id, venture_id, checkout_id, item, amount_minor, currency, fulfilment)
    VALUES (c.agent_id, c.venture_id, c.checkout_id, c.description, c.amount_minor, c.currency, v_kind)
    ON CONFLICT (checkout_id) DO NOTHING;`,
   `  INSERT INTO fleet_customer_orders (agent_id, venture_id, checkout_id, item, amount_minor, currency, fulfilment, access_token)
    VALUES (c.agent_id, c.venture_id, c.checkout_id, c.description, c.amount_minor, c.currency, v_kind,
            replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
    ON CONFLICT (checkout_id) DO NOTHING;`],
  [`  RETURN r || jsonb_build_object('order', fleet_customer_order_json(o, true));`,
   `  RETURN (r - 'note') || jsonb_build_object('order', fleet_customer_order_json(o, true),
    'note', 'give the buyer the order page (order.page), not a PayPal link: it asks for the buyer''s consent the law requires, then shows the PayPal payment');`],
]);
// The raw PayPal link of a checkout that has an order page is never handed out (only the page shows it, after consent).
const CHECKOUT_JSON = restate(V48_SQL, "fleet_paypal_checkout_json", [
  [`    'approvalUrl', CASE WHEN c.status = 'open' THEN c.approval_url END,`,
   `    'approvalUrl', CASE WHEN c.status = 'open' AND NOT EXISTS (SELECT 1 FROM fleet_customer_orders z WHERE z.checkout_id = c.checkout_id AND z.access_token IS NOT NULL)
                        THEN c.approval_url END,`],
]);
// The offer pass also sends each paid order's confirmation (the consent repeated on a durable medium) when no delivery mail
// has carried it yet.
const OFFER_TICK = restate(V76_SQL, "svc_offer_tick", [
  [`n integer := 0; nb integer := 0; ofile record; k integer;`, `n integer := 0; nb integer := 0; ofile record; k integer; nc integer := 0;`],
  [`  RETURN jsonb_build_object('ok', true, 'delivered', n, 'blocked', nb);`,
   `  nc := fleet_order_confirmations(LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100));
  RETURN jsonb_build_object('ok', true, 'delivered', n, 'blocked', nb, 'confirmed', nc);`],
]);

export const V82_SQL = `
-- ═══ 1. Owner sign-in recovery ═══
ALTER TABLE fleet_admin_password DROP CONSTRAINT IF EXISTS fleet_admin_password_set_via_check;
ALTER TABLE fleet_admin_password ADD CONSTRAINT fleet_admin_password_set_via_check CHECK (set_via IN ('session','enrollment','recovery'));
ALTER TABLE fleet_admin_challenges DROP CONSTRAINT IF EXISTS fleet_admin_challenges_purpose_check;
ALTER TABLE fleet_admin_challenges ADD CONSTRAINT fleet_admin_challenges_purpose_check CHECK (purpose IN ('enroll','login','stepup','passkey_add','recover'));

CREATE TABLE fleet_admin_recovery_codes (
  code_sha   text        PRIMARY KEY CHECK (code_sha ~ '^[0-9a-f]{64}$'),
  batch_id   uuid        NOT NULL,
  issued_at  timestamptz NOT NULL DEFAULT now(),
  used_at    timestamptz,
  used_for   text        CHECK (used_for IN ('password_reset','authenticator_reset')),
  used_ip    text        CHECK (length(used_ip) <= 64),
  revoked_at timestamptz,
  CHECK ((used_at IS NULL) = (used_for IS NULL)),
  CHECK (used_at IS NULL OR revoked_at IS NULL)
);
CREATE TRIGGER fleet_admin_recovery_codes_no_delete BEFORE DELETE ON fleet_admin_recovery_codes FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- A replacement authenticator waits here until a code from it is confirmed (the old one stays until then).
CREATE TABLE fleet_admin_totp_pending (
  ticket_sha        text        PRIMARY KEY CHECK (ticket_sha ~ '^[0-9a-f]{64}$'),
  factor_ciphertext bytea       NOT NULL CHECK (octet_length(factor_ciphertext) BETWEEN 32 AND 512),
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
  used_at           timestamptz
);

CREATE FUNCTION dash_recovery_valid(p_code_sha text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM fleet_admin_recovery_codes WHERE code_sha = p_code_sha AND used_at IS NULL AND revoked_at IS NULL)
$$;

-- Spend one code (internal): true when an unused, unretired code matched.
CREATE FUNCTION fleet_admin_recovery_spend(p_code_sha text, p_for text, p_ip text) RETURNS boolean LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  UPDATE fleet_admin_recovery_codes SET used_at = now(), used_for = p_for, used_ip = left(p_ip, 64)
   WHERE code_sha = p_code_sha AND used_at IS NULL AND revoked_at IS NULL;
  RETURN FOUND;
END $$;

CREATE FUNCTION fleet_admin_recovery_remaining() RETURNS integer LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT count(*)::integer FROM fleet_admin_recovery_codes WHERE used_at IS NULL AND revoked_at IS NULL
$$;

-- Issue a new set (a full session with a fresh confirmation): the old set's unused codes stop working.
CREATE FUNCTION dash_recovery_codes_issue(p_session_sha text, p_stepup_sha text, p_code_shas text[], p_ip text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_batch uuid := gen_random_uuid(); n integer;
BEGIN
  IF (dash_session_live(p_session_sha, true)).session_sha IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SESSION_INVALID'); END IF;
  IF p_code_shas IS NULL OR cardinality(p_code_shas) <> ${RECOVERY_CODE_COUNT}
     OR (SELECT count(DISTINCT x) FROM unnest(p_code_shas) x WHERE x ~ '^[0-9a-f]{64}$') <> ${RECOVERY_CODE_COUNT} THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  IF NOT dash_stepup_consume(p_session_sha, p_stepup_sha, '${RECOVERY_CODES_OP}', encode(sha256(convert_to('{}', 'UTF8')), 'hex')) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_STEPUP_REQUIRED');
  END IF;
  UPDATE fleet_admin_recovery_codes SET revoked_at = now() WHERE used_at IS NULL AND revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO fleet_admin_recovery_codes (code_sha, batch_id) SELECT x, v_batch FROM unnest(p_code_shas) x;
  PERFORM fleet_admin_auth_log_write('recovery_codes_issued', true, NULL, NULL, p_ip, jsonb_build_object('count', ${RECOVERY_CODE_COUNT}, 'retired', n));
  PERFORM fleet_notify('AMBER', 'ADMIN_RECOVERY_CODES_ISSUED', NULL, 'New Admin recovery codes were issued; any earlier unused codes no longer work',
    jsonb_build_object('ip', p_ip, 'retired', n), 'recovery-codes:' || v_batch);
  RETURN jsonb_build_object('ok', true, 'count', ${RECOVERY_CODE_COUNT}, 'retired', n);
END $$;

CREATE FUNCTION dash_recovery_codes_state(p_session_sha text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF (dash_session_live(p_session_sha, false)).session_sha IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SESSION_INVALID'); END IF;
  RETURN jsonb_build_object('ok', true, 'remaining', fleet_admin_recovery_remaining(),
    'issuedAt', (SELECT max(issued_at) FROM fleet_admin_recovery_codes),
    'lastUsedAt', (SELECT max(used_at) FROM fleet_admin_recovery_codes));
END $$;

-- Forgot password: the dashboard has checked a current authenticator code (accepted once); the recovery code is spent here.
CREATE FUNCTION dash_recovery_password_reset(p_code_sha text, p_verifier text, p_ip text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE n integer;
BEGIN
  IF p_verifier IS NULL OR p_verifier !~ '${PASSWORD_VERIFIER_RE}' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fleet_admin_totp WHERE confirmed_at IS NOT NULL) OR NOT fleet_admin_recovery_spend(p_code_sha, 'password_reset', p_ip) THEN
    PERFORM fleet_admin_auth_log_write('login', false, NULL, 'FLEET_RECOVERY_INVALID', p_ip, jsonb_build_object('method', 'recovery', 'for', 'password_reset'));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_RECOVERY_INVALID');
  END IF;
  INSERT INTO fleet_admin_password (id, verifier, set_at, set_via) VALUES (1, p_verifier, now(), 'recovery')
    ON CONFLICT (id) DO UPDATE SET verifier = EXCLUDED.verifier, set_at = EXCLUDED.set_at, set_via = EXCLUDED.set_via;
  UPDATE fleet_admin_sessions SET ended_at = now() WHERE ended_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM fleet_admin_auth_log_write('password_reset', true, NULL, 'recovery_code', p_ip, jsonb_build_object('sessionsEnded', n, 'codesLeft', fleet_admin_recovery_remaining()));
  PERFORM fleet_notify('RED', 'ADMIN_PASSWORD_RESET_RECOVERY', NULL,
    'The Admin password was reset with a recovery code and every session was signed out. If this was not you, sign in and replace your recovery codes and authenticator at once.',
    jsonb_build_object('ip', p_ip, 'codesLeft', fleet_admin_recovery_remaining()), 'password-recovery:' || now());
  RETURN jsonb_build_object('ok', true, 'codesLeft', fleet_admin_recovery_remaining());
END $$;

-- Lost authenticator, step 1: the dashboard has checked the password or a passkey; the recovery code is spent here and
-- the new authenticator waits (sealed) until a code from it is confirmed.
CREATE FUNCTION dash_recovery_totp_begin(p_code_sha text, p_ticket_sha text, p_secret_enc bytea, p_ip text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_ticket_sha IS NULL OR p_ticket_sha !~ '^[0-9a-f]{64}$' OR p_secret_enc IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  IF NOT fleet_admin_recovery_spend(p_code_sha, 'authenticator_reset', p_ip) THEN
    PERFORM fleet_admin_auth_log_write('login', false, NULL, 'FLEET_RECOVERY_INVALID', p_ip, jsonb_build_object('method', 'recovery', 'for', 'authenticator_reset'));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_RECOVERY_INVALID');
  END IF;
  UPDATE fleet_admin_totp_pending SET expires_at = LEAST(expires_at, now()) WHERE used_at IS NULL;
  INSERT INTO fleet_admin_totp_pending (ticket_sha, factor_ciphertext) VALUES (p_ticket_sha, p_secret_enc);
  PERFORM fleet_admin_auth_log_write('totp_replacement_started', true, NULL, 'recovery_code', p_ip, jsonb_build_object('codesLeft', fleet_admin_recovery_remaining()));
  PERFORM fleet_notify('RED', 'ADMIN_AUTHENTICATOR_RECOVERY_STARTED', NULL,
    'A recovery code was used to start replacing the Admin authenticator. If this was not you, sign in and replace your password and recovery codes at once.',
    jsonb_build_object('ip', p_ip, 'codesLeft', fleet_admin_recovery_remaining()), 'totp-recovery:' || p_ticket_sha);
  RETURN jsonb_build_object('ok', true, 'codesLeft', fleet_admin_recovery_remaining());
END $$;

CREATE FUNCTION dash_recovery_totp_pending(p_ticket_sha text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT (SELECT jsonb_build_object('secretEncB64', encode(factor_ciphertext, 'base64')) FROM fleet_admin_totp_pending
           WHERE ticket_sha = p_ticket_sha AND used_at IS NULL AND expires_at > now())
$$;

-- Lost authenticator, step 2: a code from the new authenticator was checked by the dashboard; it replaces the old one.
CREATE FUNCTION dash_recovery_totp_confirm(p_ticket_sha text, p_counter bigint, p_ip text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_admin_totp_pending; n integer;
BEGIN
  SELECT * INTO p FROM fleet_admin_totp_pending WHERE ticket_sha = p_ticket_sha AND used_at IS NULL AND expires_at > now() FOR UPDATE;
  IF NOT FOUND OR p_counter IS NULL OR p_counter < 1 THEN
    PERFORM fleet_admin_auth_log_write('login', false, NULL, 'FLEET_RECOVERY_INVALID', p_ip, jsonb_build_object('method', 'recovery', 'for', 'authenticator_confirm'));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_RECOVERY_INVALID');
  END IF;
  UPDATE fleet_admin_totp_pending SET used_at = now() WHERE ticket_sha = p_ticket_sha;
  INSERT INTO fleet_admin_totp (id, factor_ciphertext, confirmed_at, last_counter, updated_at) VALUES (1, p.factor_ciphertext, now(), p_counter, now())
    ON CONFLICT (id) DO UPDATE SET factor_ciphertext = EXCLUDED.factor_ciphertext, confirmed_at = now(), last_counter = EXCLUDED.last_counter, updated_at = now();
  UPDATE fleet_admin_sessions SET ended_at = now() WHERE ended_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM fleet_admin_auth_log_write('totp_replaced', true, NULL, 'recovery_code', p_ip, jsonb_build_object('sessionsEnded', n));
  PERFORM fleet_notify('RED', 'ADMIN_AUTHENTICATOR_REPLACED', NULL,
    'The Admin authenticator was replaced using a recovery code and every session was signed out. If this was not you, sign in and replace your password and recovery codes at once.',
    jsonb_build_object('ip', p_ip), 'totp-replaced:' || p_ticket_sha);
  RETURN jsonb_build_object('ok', true);
END $$;

-- HOST recovery (owner connection: fleet:admin hub-dashboard-totp-reset / hub-dashboard-enroll) ends the old access as part
-- of the operation, so nothing depends on the owner remembering a clean-up afterwards: every signed-in session is ended,
-- every unused recovery code is retired, and an unfinished authenticator replacement and any earlier unused set-up link stop
-- working. Keeping sessions or codes is an exceptional, explicit choice (--keep-sessions / --keep-recovery-codes), recorded
-- in the sign-in log and the notification.
CREATE FUNCTION fleet_admin_host_recovery_end_access(p_actor text, p_op text, p_keep_sessions boolean, p_keep_codes boolean) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE ns integer := 0; nc integer := 0; kept text[] := '{}';
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_dashboard');
  IF p_keep_sessions IS NULL OR p_keep_codes IS NULL THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: keep choices must be explicit'; END IF;
  IF p_keep_sessions THEN kept := kept || 'sessions'::text;
  ELSE UPDATE fleet_admin_sessions SET ended_at = now() WHERE ended_at IS NULL; GET DIAGNOSTICS ns = ROW_COUNT; END IF;
  IF p_keep_codes THEN kept := kept || 'recovery_codes'::text;
  ELSE UPDATE fleet_admin_recovery_codes SET revoked_at = now() WHERE used_at IS NULL AND revoked_at IS NULL; GET DIAGNOSTICS nc = ROW_COUNT; END IF;
  UPDATE fleet_admin_totp_pending SET expires_at = LEAST(expires_at, now()) WHERE used_at IS NULL;
  UPDATE fleet_admin_enrollment SET expires_at = LEAST(expires_at, now()) WHERE used_at IS NULL;
  PERFORM fleet_admin_auth_log_write('host_recovery_access_ended', true, NULL, 'host', NULL,
    jsonb_build_object('by', p_actor, 'op', p_op, 'sessionsEnded', ns, 'recoveryCodesRetired', nc, 'kept', to_jsonb(kept)));
  RETURN jsonb_build_object('sessionsEnded', ns, 'recoveryCodesRetired', nc, 'kept', to_jsonb(kept));
END $$;

CREATE FUNCTION fleet_admin_host_recovery_summary(e jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT (e->>'sessionsEnded') || ' session(s) signed out, ' || (e->>'recoveryCodesRetired') || ' unused recovery code(s) retired'
    || CASE WHEN jsonb_array_length(e->'kept') > 0
            THEN ' (KEPT on purpose: ' || (SELECT string_agg(k, ', ') FROM jsonb_array_elements_text(e->'kept') k) || ')' ELSE '' END
$$;

-- Host recovery commands, as before plus the step above (the keep choices default to false: everything ends).
DROP FUNCTION fleet_admin_dashboard_totp_reset(text);
CREATE FUNCTION fleet_admin_dashboard_totp_reset(p_actor text, p_keep_sessions boolean DEFAULT false, p_keep_codes boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE e jsonb;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_dashboard');
  DELETE FROM fleet_admin_totp WHERE id = 1;
  PERFORM fleet_admin_auth_log_write('totp_reset', true, NULL, 'host', NULL, jsonb_build_object('by', p_actor));
  e := fleet_admin_host_recovery_end_access(p_actor, 'totp_reset', p_keep_sessions, p_keep_codes);
  PERFORM fleet_notify(CASE WHEN jsonb_array_length(e->'kept') > 0 THEN 'RED' ELSE 'AMBER' END, 'ADMIN_TOTP_RESET', NULL,
    'Authenticator reset on the Fleet host: ' || fleet_admin_host_recovery_summary(e),
    e || jsonb_build_object('next', 'enroll a new authenticator with a set-up link, then create new recovery codes'), 'totp-reset:' || now());
  RETURN jsonb_build_object('ok', true, 'next', 'issue an enrollment link (fleet:admin hub-dashboard-enroll) and register the new authenticator') || e;
END $$;

DROP FUNCTION fleet_admin_dashboard_enroll(text, text);
CREATE FUNCTION fleet_admin_dashboard_enroll(p_token_sha text, p_actor text, p_keep_sessions boolean DEFAULT false, p_keep_codes boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE e jsonb;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_dashboard');
  e := fleet_admin_host_recovery_end_access(p_actor, 'enroll', p_keep_sessions, p_keep_codes);
  INSERT INTO fleet_admin_enrollment (token_sha, created_by, expires_at) VALUES (p_token_sha, p_actor, now() + interval '15 minutes');
  PERFORM fleet_admin_auth_log_write('enroll_issued', true, NULL, NULL, NULL, jsonb_build_object('by', p_actor));
  PERFORM fleet_notify(CASE WHEN jsonb_array_length(e->'kept') > 0 THEN 'RED' ELSE 'AMBER' END, 'ADMIN_ENROLLMENT_LINK_ISSUED', NULL,
    'Sign-in set-up link issued on the Fleet host: ' || fleet_admin_host_recovery_summary(e),
    e || jsonb_build_object('next', 'once signed in, create new recovery codes'), 'enroll-issued:' || gen_random_uuid());
  RETURN jsonb_build_object('ok', true, 'expiresAt', now() + interval '15 minutes') || e;
END $$;

-- ═══ 2. The buyer's consent to immediate supply (CCR 2013 regs 36 and 37) ═══
CREATE TABLE fleet_buyer_consent_wordings (
  version    text        NOT NULL CHECK (version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[.]v[0-9]{1,3}$'),
  kind       text        NOT NULL CHECK (kind IN ('digital_immediate','service_start')),
  statements jsonb       NOT NULL CHECK (jsonb_typeof(statements) = 'array' AND jsonb_array_length(statements) BETWEEN 1 AND 4 AND length(statements::text) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (version, kind)
);
CREATE TRIGGER fleet_buyer_consent_wordings_no_change BEFORE UPDATE OR DELETE ON fleet_buyer_consent_wordings FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
INSERT INTO fleet_buyer_consent_wordings (version, kind, statements) VALUES
  (${lit(BUYER_CONSENT_VERSION)}, 'digital_immediate', jsonb_build_array(${BUYER_CONSENT_WORDING.digital_immediate.map(lit).join(", ")})),
  (${lit(BUYER_CONSENT_VERSION)}, 'service_start', jsonb_build_array(${BUYER_CONSENT_WORDING.service_start.map(lit).join(", ")}));

ALTER TABLE fleet_customer_orders
  ADD COLUMN consent_kind    text        CHECK (consent_kind IN ('digital_immediate','service_start')),
  ADD COLUMN consent_version text,
  ADD COLUMN consent_at      timestamptz,
  ADD COLUMN consent_origin  text        CHECK (consent_origin ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT fleet_customer_orders_consent_wording FOREIGN KEY (consent_version, consent_kind) REFERENCES fleet_buyer_consent_wordings (version, kind),
  ADD CONSTRAINT fleet_customer_orders_consent_whole CHECK ((consent_at IS NULL) = (consent_kind IS NULL) AND (consent_at IS NULL) = (consent_version IS NULL)),
  ADD CONSTRAINT fleet_customer_orders_consent_kind CHECK (consent_kind IS NULL OR consent_kind = CASE fulfilment WHEN 'digital_file' THEN 'digital_immediate' ELSE 'service_start' END);

-- A recorded consent is evidence: it is never changed or removed.
CREATE FUNCTION fleet_customer_orders_consent_fixed() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF OLD.consent_at IS NOT NULL AND (NEW.consent_at, NEW.consent_kind, NEW.consent_version, NEW.consent_origin)
       IS DISTINCT FROM (OLD.consent_at, OLD.consent_kind, OLD.consent_version, OLD.consent_origin) THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a buyer''s recorded consent is evidence and cannot change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_customer_orders_consent_fixed BEFORE UPDATE ON fleet_customer_orders FOR EACH ROW EXECUTE FUNCTION fleet_customer_orders_consent_fixed();

CREATE FUNCTION fleet_order_consent_kind(o fleet_customer_orders) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE o.fulfilment WHEN 'digital_file' THEN 'digital_immediate' ELSE 'service_start' END
$$;

CREATE FUNCTION fleet_order_consent_json(o fleet_customer_orders) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('kind', fleet_order_consent_kind(o), 'recorded', o.consent_at IS NOT NULL, 'at', o.consent_at,
    'version', COALESCE(o.consent_version, ${lit(BUYER_CONSENT_VERSION)}),
    'statements', (SELECT w.statements FROM fleet_buyer_consent_wordings w
                    WHERE w.version = COALESCE(o.consent_version, ${lit(BUYER_CONSENT_VERSION)}) AND w.kind = fleet_order_consent_kind(o)))
$$;

-- The confirmation repeated in the delivery mail.
CREATE FUNCTION fleet_order_consent_text(o fleet_customer_orders) RETURNS text LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT CASE WHEN o.consent_at IS NULL AND o.access_token IS NULL THEN NULL
    WHEN o.consent_at IS NULL THEN
      'Before your first download, your order page asks you to confirm that you want immediate access to it.'
    ELSE 'Your confirmation (recorded ' || to_char(o.consent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC): '
      || (SELECT string_agg(s, ' ') FROM fleet_buyer_consent_wordings w, jsonb_array_elements_text(w.statements) s
           WHERE w.version = o.consent_version AND w.kind = o.consent_kind) END
$$;

-- Offer page purchase: the buyer's consent (the current wording's version) is part of the request.
DROP FUNCTION svc_offer_buy(text, text);
CREATE FUNCTION svc_offer_buy(p_slug text, p_origin text, p_consent text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_offers; r jsonb; c fleet_paypal_checkouts; x fleet_customer_orders; v_token text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
BEGIN
  IF p_origin IS NULL OR p_origin !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  IF NOT fleet_sales_open() THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SALES_CLOSED'); END IF;
  SELECT * INTO o FROM fleet_offers WHERE slug = p_slug AND status = 'published' AND kind = 'product' FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_OFFER_UNAVAILABLE'); END IF;
  IF p_consent IS DISTINCT FROM ${lit(BUYER_CONSENT_VERSION)} THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CONSENT_REQUIRED', 'version', ${lit(BUYER_CONSENT_VERSION)});
  END IF;
  IF (SELECT count(*) FROM fleet_customer_orders z JOIN fleet_paypal_checkouts k ON k.checkout_id = z.checkout_id
       WHERE z.origin_hash = p_origin AND k.status IN ('requested','open') AND z.created_at > now() - interval '1 day') >= 5
     OR (SELECT count(*) FROM fleet_customer_orders z JOIN fleet_paypal_checkouts k ON k.checkout_id = z.checkout_id
          WHERE z.offer_id = o.offer_id AND k.status IN ('requested','open')) >= 50 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BUSY');
  END IF;
  r := fleet_econ_paypal_checkout(o.agent_id, jsonb_build_object('venture', (SELECT venture_key FROM fleet_ventures WHERE venture_id = o.venture_id),
         'amountMinor', o.price_minor, 'description', left(o.title, 127), 'idempotencyKey', 'offer:' || left(v_token, 32)));
  IF NOT COALESCE((r ->> 'ok')::boolean, false) THEN RETURN jsonb_build_object('ok', false, 'code', COALESCE(r ->> 'code', 'FLEET_OFFER_UNAVAILABLE')); END IF;
  SELECT * INTO c FROM fleet_paypal_checkouts WHERE checkout_id = (r #>> '{checkout,checkoutId}')::uuid;
  INSERT INTO fleet_customer_orders (agent_id, venture_id, checkout_id, item, amount_minor, currency, fulfilment, offer_id, access_token, origin_hash,
                                     consent_kind, consent_version, consent_at, consent_origin)
    VALUES (o.agent_id, c.venture_id, c.checkout_id, c.description, c.amount_minor, c.currency, 'digital_file', o.offer_id, v_token, p_origin,
            'digital_immediate', ${lit(BUYER_CONSENT_VERSION)}, now(), p_origin) RETURNING * INTO x;
  RETURN jsonb_build_object('ok', true, 'token', x.access_token);
END $$;

-- An order without a recorded consent (a quoted service, or a checkout made outside the offer page): the buyer gives it on
-- the order page. Repeating it changes nothing.
CREATE FUNCTION svc_order_consent(p_token text, p_origin text, p_version text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_customer_orders;
BEGIN
  IF p_origin IS NULL OR p_origin !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  SELECT * INTO x FROM fleet_customer_orders WHERE access_token = p_token FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF x.consent_at IS NOT NULL THEN RETURN jsonb_build_object('ok', true, 'replay', true); END IF;
  IF p_version IS DISTINCT FROM ${lit(BUYER_CONSENT_VERSION)} THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CONSENT_REQUIRED', 'version', ${lit(BUYER_CONSENT_VERSION)});
  END IF;
  IF x.payment_status IN ('refunded','reversed','cancelled') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ORDER_CLOSED'); END IF;
  UPDATE fleet_customer_orders SET consent_kind = fleet_order_consent_kind(x), consent_version = p_version, consent_at = now(), consent_origin = p_origin, updated_at = now()
   WHERE order_id = x.order_id;
  RETURN jsonb_build_object('ok', true);
END $$;

${ORDER_PAGE}
${ORDER_FILE}
${DELIVERY_DISPATCH}
${DELIVERY_BODY}
${CHECKOUT_ORDER}
${CHECKOUT_JSON}

-- The order confirmation (a durable record of the contract and the buyer's consent), once per paid order with a page.
ALTER TABLE fleet_customer_orders ADD COLUMN confirmation_message_id uuid, ADD COLUMN confirmed_at timestamptz;
CREATE FUNCTION fleet_order_confirmations(p_limit integer) RETURNS integer LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_customer_orders; n integer := 0; v_mail uuid; v_due timestamptz;
BEGIN
  FOR x IN SELECT z.* FROM fleet_customer_orders z
            WHERE z.payment_status IN ('paid','partially_refunded') AND z.buyer_email IS NOT NULL AND z.access_token IS NOT NULL
              AND z.consent_at IS NOT NULL AND z.confirmed_at IS NULL
              -- a delivery mail made after the consent already carried it (fleet_order_delivery_body)
              AND NOT EXISTS (SELECT 1 FROM fleet_order_deliveries y WHERE y.order_id = z.order_id AND y.created_at >= z.consent_at)
            ORDER BY z.updated_at LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
    BEGIN
      v_due := (SELECT c.captured_at + make_interval(days => x.turnaround_days) FROM fleet_paypal_checkouts c WHERE c.checkout_id = x.checkout_id AND x.turnaround_days IS NOT NULL);
      v_mail := fleet_customer_mail(x.agent_id, x.buyer_email, 'Order confirmation — ' || x.item,
        concat_ws(E'\n\n',
          'Thank you for your order: ' || x.item || ' — ' || x.currency || ' ' || to_char(x.amount_minor / 100.0, 'FM999999990.00') || ', paid by PayPal.',
          CASE WHEN x.scope IS NOT NULL THEN 'Agreed scope: ' || x.scope END,
          CASE WHEN v_due IS NOT NULL THEN 'Due by: ' || to_char(v_due AT TIME ZONE 'UTC', 'YYYY-MM-DD') END,
          fleet_order_consent_text(x),
          'Your order page (status, files and messages): ' || fleet_public_url('/order/' || x.access_token)),
        x.venture_id, 'order-confirmation:' || x.order_id);
      UPDATE fleet_customer_orders SET confirmation_message_id = v_mail, confirmed_at = now() WHERE order_id = x.order_id;
      n := n + 1;
    EXCEPTION WHEN raise_exception THEN
      NULL; -- mail unavailable right now: the confirmation is sent on a later pass
    END;
  END LOOP;
  RETURN n;
END $$;
${OFFER_TICK}

-- ═══ 3. Helper jobs: each helper call's recorded kind, stated purpose, start and end (classes and times only) ═══
CREATE TABLE fleet_helper_jobs (
  request_id  uuid        PRIMARY KEY,
  agent_id    text        NOT NULL REFERENCES fleet_agents(agent_id),
  kind        text        NOT NULL CHECK (kind IN ('routine','escalation','review','fleet_review')),
  purpose     text        CHECK (purpose IN (${q(HELPER_JOB_PURPOSES)})),
  task_class  text        CHECK (task_class ~ '^[a-z_]{3,48}$'),
  tier        text        CHECK (tier IN ('T1','T2','T3')),
  started_at  timestamptz NOT NULL,
  finished_at timestamptz,
  state       text        NOT NULL DEFAULT 'running' CHECK (state IN ('running','finished','failed','ended')),
  CHECK ((state = 'running') = (finished_at IS NULL)),
  CHECK (kind <> 'routine' OR purpose IS NULL OR purpose IN (${q(ROUTINE_PURPOSES)}))
);
CREATE INDEX fleet_helper_jobs_started ON fleet_helper_jobs (started_at DESC);
CREATE INDEX fleet_helper_jobs_running ON fleet_helper_jobs (request_id) WHERE state = 'running';
CREATE TRIGGER fleet_helper_jobs_no_delete BEFORE DELETE ON fleet_helper_jobs FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- The three triggers run as the schema owner (SECURITY DEFINER, fixed search_path): the roles that reserve and record calls
-- have no access to fleet_helper_jobs, and the end check runs at commit, outside any definer function. They write only
-- fleet_helper_jobs, from the triggering row.
-- Opened when FleetController reserves the call (its route snapshot): the kind and purpose the founder stated, or what the
-- route itself proves (an escalation is a decision question; evidence_relevance is Fleet Control's evidence check). A
-- routine chore from an older runtime that stated no purpose is recorded with purpose NULL — never guessed.
CREATE FUNCTION fleet_helper_job_open() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r jsonb := NEW.route; v_kind text; v_purpose text;
BEGIN
  IF r IS NULL OR OLD.route IS NOT DISTINCT FROM NEW.route THEN RETURN NEW; END IF;
  v_kind := CASE WHEN r -> 'helper' ->> 'kind' IN ('routine','escalation','review') THEN r -> 'helper' ->> 'kind'
                 WHEN r ->> 'escalationReason' IS NOT NULL OR r ->> 'scope' = 'question' THEN 'escalation'
                 WHEN r ->> 'taskClass' = 'evidence_relevance' THEN 'fleet_review'
                 WHEN r ->> 'taskClass' IN (${q(ROUTINE_TASK_CLASSES)}) THEN 'routine' END;
  IF v_kind IS NULL THEN RETURN NEW; END IF;
  v_purpose := CASE v_kind WHEN 'escalation' THEN 'decision' WHEN 'review' THEN 'quality_review' WHEN 'fleet_review' THEN 'evidence_check'
                 ELSE CASE WHEN r -> 'helper' ->> 'purpose' IN (${q(ROUTINE_PURPOSES)}) THEN r -> 'helper' ->> 'purpose' END END;
  INSERT INTO fleet_helper_jobs (request_id, agent_id, kind, purpose, task_class, tier, started_at)
    VALUES (NEW.request_id, NEW.agent_id, v_kind, v_purpose, CASE WHEN r ->> 'taskClass' ~ '^[a-z_]{3,48}$' THEN r ->> 'taskClass' END,
            CASE WHEN NEW.route_tier IN ('T1','T2','T3') THEN NEW.route_tier END, NEW.started_at)
    ON CONFLICT (request_id) DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_helper_job_open AFTER UPDATE OF route ON fleet_cognition_inflight FOR EACH ROW EXECUTE FUNCTION fleet_helper_job_open();

-- Closed by the call's recorded result.
CREATE FUNCTION fleet_helper_job_close() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  UPDATE fleet_helper_jobs SET finished_at = NEW.at, state = CASE WHEN NEW.outcome = 'ok' THEN 'finished' ELSE 'failed' END
   WHERE request_id = NEW.request_id AND state = 'running';
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_helper_job_close AFTER INSERT ON fleet_cognition_log FOR EACH ROW EXECUTE FUNCTION fleet_helper_job_close();

-- A reservation that ended with no recorded result (expired, released): checked at commit, after any result was written.
CREATE FUNCTION fleet_helper_job_end() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  UPDATE fleet_helper_jobs SET finished_at = now(), state = 'ended' WHERE request_id = OLD.request_id AND state = 'running';
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER fleet_helper_job_end AFTER DELETE ON fleet_cognition_inflight DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fleet_helper_job_end();

CREATE FUNCTION fleet_helpers_json() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  WITH w AS (SELECT now() - make_interval(secs => ${HELPERS_WINDOW_S}) AS since),
  jobs AS (
    -- The recorded helper calls: running, or started / ended in the window.
    SELECT h.request_id::text AS id, h.agent_id, h.kind, h.purpose, h.task_class, h.tier, h.started_at, h.finished_at,
           COALESCE(h.finished_at, h.started_at) AS known_at, h.state,
           CASE h.state WHEN 'running' THEN 'running' WHEN 'finished' THEN 'ok' WHEN 'failed' THEN 'error' ELSE 'ended' END AS outcome
      FROM fleet_helper_jobs h, w
     WHERE h.state = 'running' OR h.started_at > w.since OR h.finished_at > w.since
    UNION ALL
    -- An independent review from an older runtime (not recorded as a helper call): known once the review citing it is filed.
    SELECT l.request_id::text, r.agent_id, 'review', 'quality_review', 'deliverable_review', l.tier,
           l.at - COALESCE(l.latency_ms, 0) * interval '1 millisecond', l.at, r.created_at,
           CASE WHEN l.outcome = 'ok' THEN 'finished' ELSE 'failed' END, r.independent_verdict
      FROM fleet_artifact_reviews r JOIN fleet_cognition_log l ON l.request_id = r.independent_request_id, w
     WHERE r.created_at > w.since AND NOT EXISTS (SELECT 1 FROM fleet_helper_jobs h WHERE h.request_id = l.request_id)
    UNION ALL
    -- The QA inspector's checks of the files a review covers (software, no model).
    SELECT r.review_id::text, r.agent_id, 'inspection', 'inspection', r.subject || '_inspection', NULL, r.created_at, r.created_at, r.created_at,
           'finished', CASE WHEN r.automated_ok THEN 'pass' ELSE 'fail' END
      FROM fleet_artifact_reviews r, w
     WHERE r.created_at > w.since
    UNION ALL
    -- Fleet Control's automated spend reviews (not the owner's own decisions): claimed = running; decided = finished.
    SELECT s.review_id::text, s.agent_id, 'fleet_review', 'spend_review', s.subject_kind || '_review', NULL, s.created_at, s.decided_at,
           COALESCE(s.decided_at, s.created_at), CASE WHEN s.decided_at IS NULL THEN 'running' ELSE 'finished' END, s.status
      FROM fleet_spend_reviews s, w
     WHERE ((s.status = 'pending' AND s.claimed_until > now()) OR s.decided_at > w.since)
       AND (s.decided_by IS NULL OR s.decided_by NOT LIKE 'operator:%')
  ),
  today AS (SELECT date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS t0)
  SELECT jsonb_build_object('asOf', now(), 'windowS', ${HELPERS_WINDOW_S},
    'jobs', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', j.id, 'agentId', j.agent_id, 'kind', j.kind, 'purpose', j.purpose, 'taskClass', j.task_class,
              'tier', j.tier, 'startedAt', j.started_at, 'finishedAt', j.finished_at, 'knownAt', j.known_at, 'state', j.state, 'outcome', j.outcome) ORDER BY j.known_at DESC)
            FROM (SELECT * FROM jobs ORDER BY known_at DESC LIMIT 200) j), '[]'::jsonb),
    'today', jsonb_build_object(
      'routine', (SELECT count(*) FROM fleet_helper_jobs, today WHERE started_at >= today.t0 AND kind = 'routine' AND purpose IS NOT NULL),
      'unrecorded', (SELECT count(*) FROM fleet_helper_jobs, today WHERE started_at >= today.t0 AND kind = 'routine' AND purpose IS NULL),
      'escalation', (SELECT count(*) FROM fleet_helper_jobs, today WHERE started_at >= today.t0 AND kind = 'escalation'),
      'review', (SELECT count(*) FROM fleet_helper_jobs, today WHERE started_at >= today.t0 AND kind = 'review')
                + (SELECT count(*) FROM fleet_artifact_reviews r, today WHERE r.created_at >= today.t0 AND r.independent_request_id IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM fleet_helper_jobs h WHERE h.request_id = r.independent_request_id)),
      'inspection', (SELECT count(*) FROM fleet_artifact_reviews, today WHERE created_at >= today.t0),
      'fleetReview', (SELECT count(*) FROM fleet_spend_reviews, today WHERE decided_at >= today.t0 AND (decided_by IS NULL OR decided_by NOT LIKE 'operator:%'))
                     + (SELECT count(*) FROM fleet_helper_jobs, today WHERE started_at >= today.t0 AND kind = 'fleet_review')))
$$;

${DASH_CALL}
`;
