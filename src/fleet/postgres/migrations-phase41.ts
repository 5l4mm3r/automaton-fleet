/**
 * Schema v41 — communications providers READY but DORMANT; one shared Fleet mailbox with internal ownership; cost-aware
 * programmable numbers (owner decisions 2026-10-02: Proton for mail, Twilio for SMS, neither activated until a real
 * operating need or the economics justify it).
 *
 *  • PROVIDER REGISTRY (`fleet_comms_providers`): the identity broker registers exactly the providers its configuration
 *    holds. No row = NOT CONFIGURED, which is a deliberate state, never a failure: an agent operation that needs mail or
 *    SMS answers FLEET_CAPABILITY_NOT_CONFIGURED for that one action, records the agent's capability dependency
 *    (`fleet_capability_demands`, the evidence Admin uses to decide activation) and every other operation continues.
 *    Founder runtimes never depend on either capability.
 *  • SHARED MAILBOX: one Fleet-controlled external mailbox (mode 'shared'); each agent holds internal ROUTING addresses
 *    on it (base+tag@domain — the same mailbox, never presented as a distinct mailbox). Outgoing mail is sent From the
 *    shared address with the agent's routing address as Reply-To and a Fleet Message-ID. Every message is attributed to
 *    agent / venture / account / identity / platform / job / thread, with its routing and the reason. Inbound routing is
 *    deterministic: routing address → conversation (In-Reply-To / References) → an account awaiting verification from
 *    that sender's domain → (ordinary mail only) an established correspondent. Anything else, and any authentication
 *    message without a deterministic owner, stays UNASSIGNED for Admin; nothing is guessed.
 *  • NUMBERS: an agent asks for a live QUOTE (available numbers, monthly rental, per-message prices, regulatory needs,
 *    converted at the Fleet FX rate), then provisions only if it judges the cost justified from its own capital, with a
 *    ceiling the broker re-checks before buying. Rental and usage are charged to the agent through the ledger (the
 *    prepaid-provider-credit pattern of inference: `provider_usage_charge`). Idle numbers are flagged for the agent's
 *    review; unpaid numbers are released after 7 days; a dead agent's numbers follow the accounts that depend on them or
 *    are released; release is refused while accounts verify with the number (unless the agent forces it).
 *  • PROVIDER SECRETS: held only by the broker, encrypted at rest; the registry knows names and fingerprints only. Admin
 *    reveals one through the existing step-up Reveal (sealed to the Admin session's key).
 */

import { V36_SQL } from "./migrations-phase36.js";
import { V37_SQL } from "./migrations-phase37.js";
import { DASHBOARD_SENSITIVE_OPS, DASHBOARD_WRITE_OPS } from "./migrations-phase38.js";
import { DASHBOARD_READ_OPS_V40, V40_SQL } from "./migrations-phase40.js";

function restate(src: string, name: string, edits: Array<[string, string]>): string {
  const head = Math.max(src.lastIndexOf(`CREATE FUNCTION ${name}(`), src.lastIndexOf(`CREATE OR REPLACE FUNCTION ${name}(`));
  if (head < 0) throw new Error(`v41: function ${name} not found`);
  const end = src.indexOf("$$;", src.indexOf("AS $$", head) + 5);
  let body = "CREATE OR REPLACE " + src.slice(src.indexOf("FUNCTION", head), end + 3);
  for (const [from, to] of edits) {
    if (body.split(from).length !== 2) throw new Error(`v41: expected text not found exactly once in ${name}: ${from.slice(0, 60)}`);
    body = body.replace(from, to);
  }
  return body;
}

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const E164 = `'^\\+[1-9][0-9]{6,14}$'`;
const ADDRESS = `'^[a-z0-9._-]{1,64}@[a-z0-9.-]{3,190}$'`;

/** v41 agent operations: a live number quote. */
export const COMMS3_OPS = ["phone.quote"] as const;
export const DASHBOARD_READ_OPS_V41 = [...DASHBOARD_READ_OPS_V40, "mail_feed", "comms_status"] as const;
export const DASHBOARD_WRITE_OPS_V41 = [...DASHBOARD_WRITE_OPS, "mail_assign"] as const;
export const DASHBOARD_SENSITIVE_OPS_V41 = [...DASHBOARD_SENSITIVE_OPS, "provider_credits_record"] as const;

const DISPATCH = restate(V37_SQL, "api_economy", [
  [`WHEN 'account.mark' THEN 'planning'`, `WHEN 'account.mark' THEN 'planning' WHEN 'phone.quote' THEN 'planning'`],
  [`WHEN 'account.mark' THEN fleet_econ_account_mark(p_agent, a)`, `WHEN 'account.mark' THEN fleet_econ_account_mark(p_agent, a)
      WHEN 'phone.quote' THEN fleet_econ_phone_quote(p_agent, a)`],
  ["BROWSER_[A-Z_]+|", "BROWSER_[A-Z_]+|CAPABILITY_[A-Z_]+|"],
]);

const JOB_CONTEXT = restate(V36_SQL, "ix_job_context", [
  [`'from', b.address, 'to', m.recipients,`,
   `'from', COALESCE(ch.address, b.address), 'replyTo', CASE WHEN ch.provider_id IS NOT NULL THEN b.address END, 'shared', ch.provider_id IS NOT NULL,
                  'to', m.recipients,`],
  [`'inReplyTo', (SELECT provider_message_id FROM fleet_agent_mail r WHERE r.message_id = m.in_reply_to))`,
   `'inReplyTo', (SELECT COALESCE(r.external_message_id, r.provider_message_id) FROM fleet_agent_mail r WHERE r.message_id = m.in_reply_to),
                  'references', (SELECT to_jsonb(array_remove(COALESCE(r.references_external, '{}') || COALESCE(r.external_message_id, r.provider_message_id), NULL))
                                   FROM fleet_agent_mail r WHERE r.message_id = m.in_reply_to))`],
  [`FROM fleet_agent_mail m JOIN fleet_agent_mailboxes b ON b.mailbox_id = m.mailbox_id`,
   `FROM fleet_agent_mail m JOIN fleet_agent_mailboxes b ON b.mailbox_id = m.mailbox_id
                  LEFT JOIN fleet_comms_providers ch ON ch.provider_id = m.channel_id AND ch.mode = 'shared'`],
]);

// Authentication-message blobs may belong to an UNASSIGNED message (Admin routes it later; nobody can use it before).
const AUTH_BLOB_STORE = restate(V37_SQL, "ix_auth_blob_store", [
  [`DECLARE v_agent text; v_addr text;`, `DECLARE v_agent text; v_addr text; v_found boolean := false;`],
  [`IF p_kind = 'mail' THEN SELECT m.agent_id, b.address INTO v_agent, v_addr FROM fleet_agent_mail m JOIN fleet_agent_mailboxes b ON b.mailbox_id = m.mailbox_id WHERE m.message_id = p_message AND m.withheld;`,
   `IF p_kind = 'mail' THEN SELECT m.agent_id, COALESCE(b.address, m.recipients[1], c.address), true INTO v_agent, v_addr, v_found
       FROM fleet_agent_mail m LEFT JOIN fleet_agent_mailboxes b ON b.mailbox_id = m.mailbox_id LEFT JOIN fleet_comms_providers c ON c.provider_id = m.channel_id
      WHERE m.message_id = p_message AND m.withheld;`],
  [`ELSIF p_kind = 'sms' THEN SELECT s.agent_id, n.e164 INTO v_agent, v_addr`, `ELSIF p_kind = 'sms' THEN SELECT s.agent_id, n.e164, true INTO v_agent, v_addr, v_found`],
  [`IF v_agent IS NULL THEN RETURN`, `IF NOT v_found OR v_addr IS NULL THEN RETURN`],
]);

// A number whose SMS code completed an account's verification becomes that account's dependency.
const SECRET_SERVE = restate(V37_SQL, "ix_browser_secret_serve", [
  [`IF p_used_message IS NOT NULL THEN UPDATE fleet_auth_message_blobs SET used_at = now(), blob = NULL WHERE message_id = p_used_message; END IF;`,
   `IF p_used_message IS NOT NULL THEN UPDATE fleet_auth_message_blobs SET used_at = now(), blob = NULL WHERE message_id = p_used_message; END IF;
  IF p_used_message IS NOT NULL THEN
    INSERT INTO fleet_phone_number_dependencies (number_id, account_id)
      SELECT s.number_id, r.account_id FROM fleet_agent_sms s, fleet_browser_secret_requests r
       WHERE s.sms_id = p_used_message AND r.request_id = p_request AND r.account_id IS NOT NULL
      ON CONFLICT (number_id, account_id) DO UPDATE SET last_used_at = now();
  END IF;`],
]);

const REVEAL_REQUEST = restate(V36_SQL, "fleet_admin_reveal_request", [
  [`  ELSE
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: kind is agent_credential or owner_identity';`,
   `  ELSIF p_kind = 'provider_secret' THEN
    IF NOT EXISTS (SELECT 1 FROM fleet_provider_secrets WHERE name = p_target AND status = 'present') THEN
      RAISE EXCEPTION 'FLEET_NOT_FOUND: the broker holds no provider secret of that name';
    END IF;
    INSERT INTO fleet_reveal_requests (request_id, kind, provider_name, ephemeral_pub, stepup_ref, requested_by)
      VALUES (gen_random_uuid(), p_kind, p_target, p_ephemeral_pub, p_stepup_ref, p_actor) RETURNING * INTO r;
  ELSE
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: kind is agent_credential, owner_identity or provider_secret';`],
]);
const REVEAL_LOG = restate(V36_SQL, "fleet_reveal_log_write", [
  [`COALESCE(r.credential_id::text, r.class_key)`, `COALESCE(r.credential_id::text, r.class_key, r.provider_name)`],
]);
const REVEAL_PENDING = restate(V36_SQL, "ix_reveal_pending", [
  [`'class', r.class_key,`, `'class', r.class_key, 'secretName', r.provider_name,`],
]);

const DASH_CALL = restate(V40_SQL, "dash_call", [
  [`p_op IN (${q(DASHBOARD_READ_OPS_V40)})`, `p_op IN (${q(DASHBOARD_READ_OPS_V41)})`],
  [`v_sensitive := p_op IN (${q(DASHBOARD_SENSITIVE_OPS)});`, `v_sensitive := p_op IN (${q(DASHBOARD_SENSITIVE_OPS_V41)});`],
  [`OR p_op IN (${q(DASHBOARD_WRITE_OPS)})`, `OR p_op IN (${q(DASHBOARD_WRITE_OPS_V41)})`],
  [`      WHEN 'births_pending' THEN fleet_admin_births_pending()`, `      WHEN 'births_pending' THEN fleet_admin_births_pending()
      WHEN 'mail_feed' THEN fleet_admin_mail_feed(a)
      WHEN 'comms_status' THEN fleet_admin_comms_status()`],
  [`      WHEN 'session_revoke_all' THEN dash_sessions_revoke_all(p_session_sha, p_ip)`, `      WHEN 'session_revoke_all' THEN dash_sessions_revoke_all(p_session_sha, p_ip)
      WHEN 'mail_assign' THEN fleet_admin_mail_assign((a ->> 'messageId')::uuid, a ->> 'agentId', (a ->> 'ventureId')::uuid, (a ->> 'accountId')::uuid, 'operator:owner')
      WHEN 'provider_credits_record' THEN fleet_admin_provider_credits_record((a ->> 'amountMinor')::bigint, a ->> 'externalRef', a ->> 'reason', 'operator:owner')`],
]);

export const V41_SQL = `
-- Hardening: the v37 origins trigger resolves its helper through a pinned search path (as every function here does).
ALTER FUNCTION fleet_agent_accounts_origins_guard() SET search_path = @@SCHEMA@@, pg_temp;

-- ═══ 1. Communications providers: what the broker is configured with (empty = NOT CONFIGURED) ═══
CREATE TABLE fleet_comms_providers (
  provider_id           uuid        PRIMARY KEY,
  capability            text        NOT NULL CHECK (capability IN ('mail','sms')),
  provider              text        NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9._-]{1,40}$'),
  mode                  text        NOT NULL CHECK (mode IN ('shared','dedicated','numbers')),
  address               text        CHECK (address ~ ${ADDRESS}),
  status                text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  registered_by         text        NOT NULL CHECK (registered_by ~ '^[a-z0-9_.-]{1,64}$'),
  registered_at         timestamptz NOT NULL DEFAULT now(),
  retired_at            timestamptz,
  last_sync_at          timestamptz,
  last_ok_at            timestamptz,
  last_error            text        CHECK (length(last_error) <= 120),
  last_error_at         timestamptz,
  consecutive_failures  integer     NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  CHECK ((mode = 'shared') = (address IS NOT NULL)),
  CHECK ((capability = 'sms') = (mode = 'numbers'))
);
CREATE UNIQUE INDEX fleet_comms_providers_active ON fleet_comms_providers (capability, provider, COALESCE(address, '')) WHERE status = 'active';
CREATE TRIGGER fleet_comms_providers_no_delete BEFORE DELETE ON fleet_comms_providers FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_comms_configured(p_cap text) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM fleet_comms_providers WHERE capability = p_cap AND status = 'active')
$$;

-- The mail channel new routing addresses use: the most recently registered active shared mailbox, else a dedicated provider.
CREATE FUNCTION fleet_mail_default_channel() RETURNS fleet_comms_providers LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT * FROM fleet_comms_providers WHERE capability = 'mail' AND status = 'active' ORDER BY (mode = 'shared') DESC, registered_at DESC LIMIT 1
$$;

-- ═══ 2. Capability dependencies: an agent needed mail / SMS while it is not configured (activation evidence) ═══
CREATE TABLE fleet_capability_demands (
  demand_id     uuid        PRIMARY KEY,
  agent_id      text        NOT NULL REFERENCES fleet_agents(agent_id),
  capability    text        NOT NULL CHECK (capability IN ('mail','sms')),
  last_op       text        NOT NULL CHECK (length(last_op) BETWEEN 1 AND 40),
  purpose       text        CHECK (length(purpose) <= 300),
  venture_id    uuid        REFERENCES fleet_ventures(venture_id),
  attempts      integer     NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  status        text        NOT NULL DEFAULT 'open' CHECK (status IN ('open','satisfied')),
  first_at      timestamptz NOT NULL DEFAULT now(),
  last_at       timestamptz NOT NULL DEFAULT now(),
  satisfied_at  timestamptz
);
CREATE UNIQUE INDEX fleet_capability_demands_open ON fleet_capability_demands (agent_id, capability) WHERE status = 'open';

CREATE FUNCTION fleet_comms_unavailable(p_agent text, p_cap text, p_op text, p_purpose text, p_venture text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_attempts integer; v_venture uuid;
BEGIN
  IF p_venture ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT venture_id INTO v_venture FROM fleet_ventures WHERE venture_id = p_venture::uuid AND agent_id = p_agent;
  END IF;
  INSERT INTO fleet_capability_demands (demand_id, agent_id, capability, last_op, purpose, venture_id)
    VALUES (gen_random_uuid(), p_agent, p_cap, left(p_op, 40), left(fleet_scrub(p_purpose), 300), v_venture)
    ON CONFLICT (agent_id, capability) WHERE status = 'open' DO UPDATE SET attempts = fleet_capability_demands.attempts + 1, last_at = now(),
       last_op = EXCLUDED.last_op, purpose = COALESCE(EXCLUDED.purpose, fleet_capability_demands.purpose),
       venture_id = COALESCE(EXCLUDED.venture_id, fleet_capability_demands.venture_id)
    RETURNING attempts INTO v_attempts;
  IF v_attempts = 1 THEN
    PERFORM fleet_event('capability_dependency', p_agent, p_agent, jsonb_build_object('capability', p_cap, 'op', p_op));
  END IF;
  RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CAPABILITY_NOT_CONFIGURED', 'capability', p_cap,
    'reason', CASE p_cap WHEN 'mail' THEN 'Fleet email is not activated yet' ELSE 'Fleet SMS / phone numbers are not activated yet' END,
    'note', 'A deliberate cost decision, not a failure: only this action is unavailable. Continue your other work or use another '
            || 'channel. Your need is recorded for Admin, who activates the capability when a real operating requirement justifies it.');
END $$;

-- ═══ 3. Shared mailbox: routing addresses and attributed mail ═══
ALTER TABLE fleet_agent_mailboxes
  ADD COLUMN channel_id       uuid REFERENCES fleet_comms_providers(provider_id),
  ADD COLUMN route_tag        text CHECK (route_tag ~ '^[a-z0-9]{6,24}$'),
  ADD COLUMN venture_id       uuid REFERENCES fleet_ventures(venture_id),
  ADD COLUMN idempotency_key  text CHECK (idempotency_key ~ '^[A-Za-z0-9:_.-]{8,128}$'),
  ADD CONSTRAINT fleet_agent_mailboxes_route CHECK ((channel_id IS NULL) = (route_tag IS NULL));
CREATE UNIQUE INDEX fleet_agent_mailboxes_route_tag ON fleet_agent_mailboxes (channel_id, route_tag) WHERE channel_id IS NOT NULL;
CREATE UNIQUE INDEX fleet_agent_mailboxes_idem ON fleet_agent_mailboxes (agent_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE fleet_agent_mail ALTER COLUMN mailbox_id DROP NOT NULL;
ALTER TABLE fleet_agent_mail ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE fleet_agent_mail
  ADD COLUMN channel_id            uuid REFERENCES fleet_comms_providers(provider_id),
  ADD COLUMN venture_id            uuid REFERENCES fleet_ventures(venture_id),
  ADD COLUMN account_id            uuid REFERENCES fleet_agent_accounts(account_id),
  ADD COLUMN identity_id           uuid REFERENCES fleet_agent_identities(identity_id),
  ADD COLUMN job_id                uuid REFERENCES fleet_identity_jobs(job_id),
  ADD COLUMN platform              text CHECK (length(platform) <= 60),
  ADD COLUMN thread_id             uuid,
  ADD COLUMN external_message_id   text CHECK (length(external_message_id) <= 300),
  ADD COLUMN in_reply_to_external  text CHECK (length(in_reply_to_external) <= 300),
  ADD COLUMN references_external   text[] CHECK (cardinality(references_external) <= 50),
  ADD COLUMN sender_address        text CHECK (length(sender_address) <= 254),
  ADD COLUMN routing               text NOT NULL DEFAULT 'mailbox' CHECK (routing IN ('mailbox','recipient_tag','thread','awaiting_verification','correspondent','admin','unassigned','sent')),
  ADD COLUMN routing_reason        text CHECK (length(routing_reason) <= 300),
  ADD COLUMN assigned_by           text,
  ADD COLUMN assigned_at           timestamptz,
  ADD COLUMN send_error            text CHECK (length(send_error) <= 120),
  ADD COLUMN sent_at               timestamptz,
  ADD CONSTRAINT fleet_agent_mail_owner CHECK (agent_id IS NOT NULL OR (direction = 'in' AND routing = 'unassigned')),
  ADD CONSTRAINT fleet_agent_mail_where CHECK (mailbox_id IS NOT NULL OR channel_id IS NOT NULL);
CREATE UNIQUE INDEX fleet_agent_mail_channel_in ON fleet_agent_mail (channel_id, provider_message_id, COALESCE(agent_id, ''))
  WHERE channel_id IS NOT NULL AND direction = 'in' AND provider_message_id IS NOT NULL;
CREATE INDEX fleet_agent_mail_ext ON fleet_agent_mail (channel_id, external_message_id) WHERE external_message_id IS NOT NULL;
CREATE INDEX fleet_agent_mail_unassigned ON fleet_agent_mail (received_at DESC) WHERE agent_id IS NULL;
CREATE INDEX fleet_agent_mail_thread ON fleet_agent_mail (thread_id);
ALTER TABLE fleet_auth_message_blobs ALTER COLUMN agent_id DROP NOT NULL;

CREATE FUNCTION fleet_mail_addr(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(COALESCE(substring(t FROM '<([^<>[:space:]]+@[^<>[:space:]]+)>'), substring(t FROM '([^<>[:space:]"'',;]+@[^<>[:space:]"'',;]+)')))
$$;
-- The registrable part of a host name (two labels, or three under a generic second level such as co.uk).
CREATE FUNCTION fleet_domain_base(d text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN lower(d) ~ '\\.(co|com|org|net|ac|gov|edu|ltd|plc|me)\\.[a-z]{2}$' THEN substring(lower(d) FROM '([^.]+\\.[^.]+\\.[^.]+)$')
              ELSE substring(lower(d) FROM '([^.]+\\.[^.]+)$') END
$$;
CREATE FUNCTION fleet_origin_host(o text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT lower(substring(o FROM '^https://([^:/]+)')) $$;

-- Agent's routing address: on the shared mailbox it is created at once (no provider call); a dedicated provider keeps
-- the v34 broker job.
CREATE OR REPLACE FUNCTION fleet_econ_mailbox_provision(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_local text := lower(fleet_econ_text(a, 'localPart', 64)); v_identity uuid; x fleet_agent_accounts; v_idem text := fleet_identity_idem(a); j fleet_identity_jobs;
        c fleet_comms_providers := fleet_mail_default_channel(); b fleet_agent_mailboxes; v_venture text := fleet_econ_venture_ref(p_agent, a); v_tag text; v_addr text;
BEGIN
  SELECT * INTO b FROM fleet_agent_mailboxes WHERE agent_id = p_agent AND idempotency_key = v_idem;
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'mailboxId', b.mailbox_id, 'accountId', b.account_id, 'address', b.address); END IF;
  SELECT * INTO j FROM fleet_identity_jobs WHERE agent_id = p_agent AND idempotency_key = v_idem;
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'jobId', j.job_id, 'status', j.status, 'accountId', j.account_id); END IF;
  IF c.provider_id IS NULL THEN RETURN fleet_comms_unavailable(p_agent, 'mail', 'mailbox.provision', a ->> 'purpose', v_venture); END IF;
  IF v_local IS NOT NULL AND v_local !~ '^[a-z0-9._+-]{1,64}$' THEN PERFORM fleet_econ_bad('localPart is a-z 0-9 . _ + -'); END IF;
  IF a ? 'identityId' THEN
    SELECT identity_id INTO v_identity FROM fleet_agent_identities WHERE identity_id = fleet_identity_uuid(a, 'identityId') AND agent_id = p_agent AND status = 'active';
    IF v_identity IS NULL THEN PERFORM fleet_econ_bad('no such active identity of yours'); END IF;
  END IF;
  IF v_venture IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fleet_ventures WHERE venture_id::text = v_venture AND agent_id = p_agent) THEN
    PERFORM fleet_econ_bad('ventureId is one of your ventures');
  END IF;
  INSERT INTO fleet_agent_accounts (account_id, agent_id, identity_id, account_kind, platform)
    VALUES (gen_random_uuid(), p_agent, v_identity, 'email', 'fleet-mail') RETURNING * INTO x;
  IF c.mode <> 'shared' THEN
    RETURN fleet_identity_enqueue(p_agent, x.account_id, 'mailbox.provision', jsonb_build_object('localPart', v_local), v_idem) || jsonb_build_object('accountId', x.account_id);
  END IF;
  v_tag := left(replace(gen_random_uuid()::text, '-', ''), 10);
  v_addr := split_part(c.address, '@', 1) || '+' || v_tag || '@' || split_part(c.address, '@', 2);
  IF length(split_part(v_addr, '@', 1)) > 64 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the shared address is too long for routing tags'; END IF;
  INSERT INTO fleet_agent_mailboxes (mailbox_id, agent_id, account_id, address, provider, channel_id, route_tag, venture_id, idempotency_key)
    VALUES (gen_random_uuid(), p_agent, x.account_id, v_addr, c.provider, c.provider_id, v_tag, v_venture::uuid, v_idem) RETURNING * INTO b;
  UPDATE fleet_agent_accounts SET handle = v_addr, status = 'active', verification = 'email_verified', venture_id = v_venture::uuid, updated_at = now()
   WHERE account_id = x.account_id;
  PERFORM fleet_event('mail_route_created', p_agent, p_agent, jsonb_build_object('mailboxId', b.mailbox_id, 'channel', c.provider));
  RETURN jsonb_build_object('ok', true, 'mailboxId', b.mailbox_id, 'accountId', x.account_id, 'address', v_addr, 'sharedAddress', c.address, 'mode', 'shared',
    'note', 'A routing address on the Fleet''s shared mailbox (the same mailbox, not a separate one). Mail sent to it, and replies to '
            || 'mail you send, reach you. Your outgoing mail is sent From ' || c.address || ' with this address as Reply-To. '
            || 'Use it as the login email of accounts you create so their mail routes to you deterministically.');
END $$;

CREATE OR REPLACE FUNCTION fleet_econ_mail_send(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_from text := lower(fleet_econ_text(a, 'from', 190)); b fleet_agent_mailboxes; v_to text[]; v_subject text := fleet_econ_text(a, 'subject', 300, true);
        v_body text := a ->> 'body'; rp fleet_agent_mail; v_id uuid := gen_random_uuid(); v_idem text := fleet_econ_text(a, 'idempotencyKey', 128, true); r jsonb; x text;
        v_venture text := fleet_econ_venture_ref(p_agent, a); v_account uuid; v_thread uuid; ch fleet_comms_providers;
BEGIN
  IF EXISTS (SELECT 1 FROM fleet_identity_jobs WHERE agent_id = p_agent AND idempotency_key = v_idem) THEN
    RETURN fleet_identity_enqueue(p_agent, NULL, 'mail.send', '{}'::jsonb, v_idem);
  END IF;
  IF NOT fleet_comms_configured('mail') THEN RETURN fleet_comms_unavailable(p_agent, 'mail', 'mail.send', v_subject, v_venture); END IF;
  IF a ? 'inReplyTo' THEN
    SELECT * INTO rp FROM fleet_agent_mail WHERE message_id = fleet_identity_uuid(a, 'inReplyTo') AND agent_id = p_agent;
    IF NOT FOUND THEN PERFORM fleet_econ_bad('inReplyTo is one of your messages'); END IF;
    v_thread := COALESCE(rp.thread_id, rp.message_id);
  END IF;
  IF v_from IS NOT NULL THEN
    SELECT * INTO b FROM fleet_agent_mailboxes WHERE lower(address) = v_from AND agent_id = p_agent AND status = 'active';
  ELSIF rp.mailbox_id IS NOT NULL THEN
    SELECT * INTO b FROM fleet_agent_mailboxes WHERE mailbox_id = rp.mailbox_id AND agent_id = p_agent AND status = 'active';
  END IF;
  IF b.mailbox_id IS NULL AND v_from IS NULL THEN
    SELECT * INTO b FROM fleet_agent_mailboxes mb WHERE mb.agent_id = p_agent AND mb.status = 'active'
       AND (mb.channel_id IS NULL OR EXISTS (SELECT 1 FROM fleet_comms_providers p WHERE p.provider_id = mb.channel_id AND p.status = 'active'))
     ORDER BY (v_venture IS NOT NULL AND mb.venture_id::text = v_venture) DESC, mb.created_at DESC LIMIT 1;
  END IF;
  IF b.mailbox_id IS NULL THEN RAISE EXCEPTION 'FLEET_MAIL_MAILBOX: from is one of your active mailboxes (create a routing address with mailbox.provision)'; END IF;
  IF b.channel_id IS NOT NULL THEN
    SELECT * INTO ch FROM fleet_comms_providers WHERE provider_id = b.channel_id;
    IF ch.status <> 'active' THEN RETURN fleet_comms_unavailable(p_agent, 'mail', 'mail.send', v_subject, v_venture); END IF;
  END IF;
  IF jsonb_typeof(a -> 'to') = 'string' THEN v_to := ARRAY[lower(a ->> 'to')];
  ELSIF jsonb_typeof(a -> 'to') = 'array' THEN SELECT array_agg(lower(e)) INTO v_to FROM jsonb_array_elements_text(a -> 'to') e;
  END IF;
  IF v_to IS NULL OR cardinality(v_to) NOT BETWEEN 1 AND 10 THEN PERFORM fleet_econ_bad('to is 1..10 addresses'); END IF;
  FOREACH x IN ARRAY v_to LOOP
    IF x !~ '^[^@[:space:]<>]{1,64}@[a-z0-9.-]{3,190}$' THEN PERFORM fleet_econ_bad('to holds plain email addresses'); END IF;
  END LOOP;
  IF v_body IS NULL OR length(v_body) NOT BETWEEN 1 AND 100000 THEN PERFORM fleet_econ_bad('body is 1..100000 characters'); END IF;
  IF v_venture IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fleet_ventures WHERE venture_id::text = v_venture AND agent_id = p_agent) THEN
    PERFORM fleet_econ_bad('ventureId is one of your ventures');
  END IF;
  IF a ? 'accountId' THEN
    SELECT account_id INTO v_account FROM fleet_agent_accounts WHERE account_id = fleet_identity_uuid(a, 'accountId') AND agent_id = p_agent;
    IF v_account IS NULL THEN PERFORM fleet_econ_bad('accountId is one of your accounts'); END IF;
  END IF;
  -- Infrastructure failsafe (runaway loop / shared-mailbox reputation), not a budget.
  IF (SELECT count(*) FROM fleet_agent_mail WHERE agent_id = p_agent AND direction = 'out' AND received_at > now() - interval '1 day') >= 500 THEN
    RAISE EXCEPTION 'FLEET_INFRASTRUCTURE_CEILING: an infrastructure failsafe against runaway loops was hit';
  END IF;
  INSERT INTO fleet_agent_mail (message_id, mailbox_id, agent_id, sender, subject, body, direction, recipients, in_reply_to, send_status,
      channel_id, venture_id, account_id, identity_id, thread_id, routing, sender_address)
    VALUES (v_id, b.mailbox_id, p_agent, b.address, v_subject, fleet_scrub_mail(v_body), 'out', v_to, rp.message_id, 'queued',
      b.channel_id, COALESCE(v_venture::uuid, rp.venture_id, b.venture_id), COALESCE(v_account, rp.account_id),
      (SELECT identity_id FROM fleet_agent_accounts WHERE account_id = b.account_id), COALESCE(v_thread, v_id), 'sent', COALESCE(ch.address, b.address));
  r := fleet_identity_enqueue(p_agent, NULL, 'mail.send', jsonb_build_object('messageId', v_id), v_idem);
  RETURN r || jsonb_build_object('messageId', v_id, 'threadId', COALESCE(v_thread, v_id))
    || CASE WHEN ch.provider_id IS NOT NULL THEN jsonb_build_object('note', 'Sent From the Fleet''s shared address ' || ch.address
         || ' with your routing address ' || b.address || ' as Reply-To; replies come back to you.') ELSE '{}'::jsonb END;
END $$;

CREATE OR REPLACE FUNCTION fleet_econ_mail_inbox(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_box text := lower(fleet_econ_text(a, 'mailbox', 190)); v_since timestamptz; v_limit integer := COALESCE(fleet_econ_int(a, 'limit', 1, 50), 20)::integer;
        v_thread uuid;
BEGIN
  BEGIN v_since := (a ->> 'since')::timestamptz; EXCEPTION WHEN OTHERS THEN PERFORM fleet_econ_bad('since is an ISO timestamp'); END;
  IF a ? 'threadId' THEN v_thread := fleet_identity_uuid(a, 'threadId'); END IF;
  RETURN jsonb_build_object('ok', true, 'mailConfigured', fleet_comms_configured('mail'), 'messages', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('messageId', m.message_id,
           'direction', m.direction, 'mailbox', COALESCE(b.address, c.address), 'from', CASE m.direction WHEN 'in' THEN m.sender ELSE COALESCE(c.address, b.address) END,
           'to', CASE m.direction WHEN 'in' THEN COALESCE(to_jsonb(m.recipients), to_jsonb(b.address)) ELSE to_jsonb(m.recipients) END, 'subject', m.subject,
           'preview', left(m.body, 1500), 'truncated', length(m.body) > 1500, 'authenticationMessage', m.withheld,
           'consumedByBroker', m.consumed_at IS NOT NULL, 'sendStatus', m.send_status, 'threadId', m.thread_id, 'ventureId', m.venture_id,
           'accountId', m.account_id, 'routing', m.routing, 'at', m.received_at)) ORDER BY m.received_at DESC)
           FROM (SELECT * FROM fleet_agent_mail WHERE agent_id = p_agent AND (v_since IS NULL OR received_at > v_since)
                    AND (v_thread IS NULL OR thread_id = v_thread) ORDER BY received_at DESC LIMIT v_limit) m
           LEFT JOIN fleet_agent_mailboxes b ON b.mailbox_id = m.mailbox_id LEFT JOIN fleet_comms_providers c ON c.provider_id = m.channel_id
          WHERE v_box IS NULL OR lower(b.address) = v_box), '[]'::jsonb),
    'note', CASE WHEN fleet_comms_configured('mail') THEN 'Your own business mail, complete. Use mail.read for a whole message and mail.send to reply.'
                 ELSE 'Fleet email is not activated yet (a cost decision); nothing can arrive until it is.' END);
END $$;

CREATE OR REPLACE FUNCTION fleet_econ_mail_read(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE m fleet_agent_mail; v_box text; v_shared text;
BEGIN
  SELECT * INTO m FROM fleet_agent_mail WHERE message_id = fleet_identity_uuid(a, 'messageId') AND agent_id = p_agent;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_MAIL_NONE: no such message of yours'; END IF;
  SELECT address INTO v_box FROM fleet_agent_mailboxes WHERE mailbox_id = m.mailbox_id;
  SELECT address INTO v_shared FROM fleet_comms_providers WHERE provider_id = m.channel_id;
  RETURN jsonb_build_object('ok', true, 'message', jsonb_strip_nulls(jsonb_build_object('messageId', m.message_id, 'direction', m.direction,
    'mailbox', COALESCE(v_box, v_shared), 'from', CASE m.direction WHEN 'in' THEN m.sender ELSE COALESCE(v_shared, v_box) END,
    'to', CASE m.direction WHEN 'in' THEN COALESCE(to_jsonb(m.recipients), to_jsonb(v_box)) ELSE to_jsonb(m.recipients) END,
    'subject', m.subject, 'body', m.body, 'inReplyTo', m.in_reply_to, 'threadId', m.thread_id, 'ventureId', m.venture_id, 'accountId', m.account_id,
    'routing', m.routing, 'routingReason', m.routing_reason, 'sendStatus', m.send_status, 'at', m.received_at, 'authenticationMessage', m.withheld,
    'note', CASE WHEN m.withheld THEN 'An account authentication message: its link/code is used by the identity broker on your behalf.' END)));
END $$;

${JOB_CONTEXT}

CREATE FUNCTION ix_mail_sent2(p_job uuid, p_lease text, p_provider_id text, p_external_id text, p_ok boolean, p_error text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_identity_jobs := ix_leased(p_job, p_lease);
BEGIN
  IF j.kind <> 'mail.send' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  UPDATE fleet_agent_mail SET send_status = CASE WHEN p_ok THEN 'sent' ELSE 'failed' END, provider_message_id = left(p_provider_id, 300),
         external_message_id = COALESCE(left(p_external_id, 300), external_message_id), send_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 120) END,
         sent_at = CASE WHEN p_ok THEN now() END, job_id = j.job_id
   WHERE message_id::text = j.params ->> 'messageId' AND agent_id = j.agent_id AND direction = 'out';
  RETURN jsonb_build_object('ok', true);
END $$;

-- One stored copy of an inbound message (attributed, or unassigned).
CREATE FUNCTION fleet_mail_store_in(c fleet_comms_providers, m jsonb, p_pid text, p_ext text, p_irt text, p_refs text[], p_rcpts text[], p_from text,
  p_at timestamptz, p_withheld boolean, p_agent text, p_mailbox uuid, p_venture uuid, p_account uuid, p_thread uuid, p_routing text, p_reason text)
  RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_id uuid := gen_random_uuid(); v_box uuid := p_mailbox; v_platform text; v_identity uuid; v_job uuid; v_venture uuid := p_venture; v_addr text;
BEGIN
  IF p_agent IS NOT NULL AND v_box IS NULL THEN
    SELECT mailbox_id INTO v_box FROM fleet_agent_mailboxes WHERE agent_id = p_agent AND channel_id = c.provider_id AND status = 'active' ORDER BY created_at DESC LIMIT 1;
  END IF;
  IF v_box IS NOT NULL THEN
    SELECT b.address, COALESCE(v_venture, b.venture_id), x.identity_id INTO v_addr, v_venture, v_identity
      FROM fleet_agent_mailboxes b JOIN fleet_agent_accounts x ON x.account_id = b.account_id WHERE b.mailbox_id = v_box;
  END IF;
  IF p_account IS NOT NULL THEN
    SELECT platform, COALESCE(identity_id, v_identity), COALESCE(v_venture, venture_id) INTO v_platform, v_identity, v_venture FROM fleet_agent_accounts WHERE account_id = p_account;
    SELECT job_id INTO v_job FROM fleet_identity_jobs WHERE account_id = p_account AND status IN ('queued','claimed','pending') ORDER BY created_at DESC LIMIT 1;
  END IF;
  INSERT INTO fleet_agent_mail (message_id, mailbox_id, agent_id, channel_id, venture_id, account_id, identity_id, job_id, platform, thread_id,
      external_message_id, in_reply_to_external, references_external, recipients, sender, sender_address, subject, body, verification, withheld,
      provider_message_id, routing, routing_reason, received_at)
    VALUES (v_id, v_box, p_agent, c.provider_id, v_venture, p_account, v_identity, v_job, v_platform, COALESCE(p_thread, v_id),
      p_ext, p_irt, NULLIF(p_refs, '{}'), NULLIF(p_rcpts[1:10], '{}'), COALESCE(NULLIF(left(fleet_scrub(COALESCE(m ->> 'from', '')), 200), ''), '(unknown sender)'),
      left(p_from, 254), left(fleet_scrub(COALESCE(m ->> 'subject', '')), 300), fleet_scrub_mail(m ->> 'body'), COALESCE(p_withheld, false), COALESCE(p_withheld, false),
      p_pid, p_routing, left(p_reason, 300), p_at);
  RETURN jsonb_build_object('messageId', v_id, 'agentId', p_agent, 'routing', p_routing, 'address', v_addr);
END $$;

-- Inbound mail from a SHARED mailbox: deterministic attribution, else UNASSIGNED (never guessed).
CREATE FUNCTION ix_mail_ingest(p_worker text, p_channel uuid, m jsonb, p_withheld boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_comms_providers; v_pid text := left(m ->> 'providerId', 300); v_ext text := left(m ->> 'messageId', 300); v_irt text := left(m ->> 'inReplyTo', 300);
        v_refs text[]; v_rcpts text[]; v_from text := fleet_mail_addr(m ->> 'from'); v_dom text; v_at timestamptz; deliveries jsonb := '[]'::jsonb;
        b fleet_agent_mailboxes; p fleet_agent_mail; v_agents text[]; v_accounts uuid[]; v_reason text := 'no deterministic owner';
BEGIN
  SELECT * INTO c FROM fleet_comms_providers WHERE provider_id = p_channel AND capability = 'mail' AND mode = 'shared' AND status = 'active';
  IF NOT FOUND OR v_pid IS NULL OR jsonb_typeof(m) <> 'object' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  IF EXISTS (SELECT 1 FROM fleet_agent_mail WHERE channel_id = p_channel AND direction = 'in' AND provider_message_id = v_pid) THEN
    RETURN jsonb_build_object('ok', true, 'replay', true, 'deliveries', (SELECT jsonb_agg(jsonb_build_object('messageId', message_id, 'agentId', agent_id, 'routing', routing))
      FROM fleet_agent_mail WHERE channel_id = p_channel AND direction = 'in' AND provider_message_id = v_pid));
  END IF;
  SELECT COALESCE(array_agg(DISTINCT a) FILTER (WHERE a IS NOT NULL), '{}') INTO v_rcpts
    FROM (SELECT fleet_mail_addr(e) a FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(m -> 'to') = 'array' THEN m -> 'to' ELSE '[]' END) e
          UNION ALL SELECT fleet_mail_addr(e) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(m -> 'cc') = 'array' THEN m -> 'cc' ELSE '[]' END) e LIMIT 50) x;
  SELECT COALESCE(array_agg(left(e, 300)), '{}') INTO v_refs
    FROM (SELECT e FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(m -> 'references') = 'array' THEN m -> 'references' ELSE '[]' END) e LIMIT 50) x;
  v_dom := NULLIF(split_part(COALESCE(v_from, ''), '@', 2), '');
  BEGIN v_at := COALESCE((m ->> 'at')::timestamptz, now()); EXCEPTION WHEN OTHERS THEN v_at := now(); END;
  IF v_at > now() + interval '1 hour' THEN v_at := now(); END IF;

  -- 1. Addressed to an agent's routing address (each addressed living agent gets its copy).
  FOR b IN SELECT mb.* FROM fleet_agent_mailboxes mb JOIN fleet_agents g ON g.agent_id = mb.agent_id AND g.status NOT IN ('dead','failed')
            WHERE mb.channel_id = p_channel AND mb.status = 'active' AND lower(mb.address) = ANY(v_rcpts) ORDER BY mb.created_at LOOP
    deliveries := deliveries || fleet_mail_store_in(c, m, v_pid, v_ext, v_irt, v_refs, v_rcpts, v_from, v_at, p_withheld, b.agent_id, b.mailbox_id, b.venture_id,
                                                    NULL, NULL, 'recipient_tag', 'addressed to the routing address ' || b.address);
  END LOOP;
  IF jsonb_array_length(deliveries) > 0 THEN RETURN jsonb_build_object('ok', true, 'deliveries', deliveries); END IF;
  IF EXISTS (SELECT 1 FROM fleet_agent_mailboxes WHERE channel_id = p_channel AND lower(address) = ANY(v_rcpts)) THEN
    v_reason := 'addressed to the routing address of an agent that is no longer living';
  END IF;

  -- 2. A reply in a conversation of one agent.
  IF v_irt IS NOT NULL THEN
    SELECT mm.* INTO p FROM fleet_agent_mail mm JOIN fleet_agents g ON g.agent_id = mm.agent_id AND g.status NOT IN ('dead','failed')
     WHERE mm.channel_id = p_channel AND mm.external_message_id = v_irt ORDER BY mm.received_at DESC LIMIT 1;
  END IF;
  IF p.message_id IS NULL AND cardinality(v_refs) > 0 THEN
    SELECT array_agg(DISTINCT mm.agent_id) INTO v_agents FROM fleet_agent_mail mm JOIN fleet_agents g ON g.agent_id = mm.agent_id AND g.status NOT IN ('dead','failed')
     WHERE mm.channel_id = p_channel AND mm.external_message_id = ANY(v_refs);
    IF cardinality(v_agents) = 1 THEN
      SELECT * INTO p FROM fleet_agent_mail WHERE channel_id = p_channel AND agent_id = v_agents[1] AND external_message_id = ANY(v_refs) ORDER BY received_at DESC LIMIT 1;
    ELSIF cardinality(v_agents) > 1 THEN v_reason := 'the conversation involves several agents';
    END IF;
  END IF;
  IF p.message_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'deliveries', jsonb_build_array(fleet_mail_store_in(c, m, v_pid, v_ext, v_irt, v_refs, v_rcpts, v_from, v_at, p_withheld,
      p.agent_id, p.mailbox_id, p.venture_id, p.account_id, COALESCE(p.thread_id, p.message_id), 'thread', 'a reply in a conversation of this agent')));
  END IF;

  -- 3. An account awaiting verification on the sender's site (exactly one agent).
  IF v_dom IS NOT NULL THEN
    SELECT array_agg(DISTINCT x.agent_id), array_agg(DISTINCT x.account_id) INTO v_agents, v_accounts
      FROM fleet_agent_accounts x JOIN fleet_agents g ON g.agent_id = x.agent_id AND g.status NOT IN ('dead','failed')
     WHERE x.status NOT IN ('closed','banned','failed')
       AND (x.status IN ('requested','creating','pending_verification') OR x.verification = 'email_pending'
            OR EXISTS (SELECT 1 FROM fleet_browser_secret_requests r WHERE r.account_id = x.account_id AND r.kind IN ('email_code','auth_link')
                         AND r.created_at > now() - interval '30 minutes'))
       AND (EXISTS (SELECT 1 FROM unnest(x.origins) o WHERE fleet_domain_base(fleet_origin_host(o)) = fleet_domain_base(v_dom))
            OR fleet_domain_base(x.platform) = fleet_domain_base(v_dom));
    IF cardinality(v_agents) = 1 THEN
      RETURN jsonb_build_object('ok', true, 'deliveries', jsonb_build_array(fleet_mail_store_in(c, m, v_pid, v_ext, v_irt, v_refs, v_rcpts, v_from, v_at, p_withheld,
        v_agents[1], NULL, NULL, CASE WHEN cardinality(v_accounts) = 1 THEN v_accounts[1] END, NULL, 'awaiting_verification',
        'the only account awaiting verification on ' || fleet_domain_base(v_dom))));
    ELSIF cardinality(v_agents) > 1 THEN v_reason := 'several agents await verification on ' || fleet_domain_base(v_dom);
    END IF;
  END IF;

  -- 4. Ordinary mail from an established correspondent of exactly one agent. Never for authentication mail.
  IF NOT COALESCE(p_withheld, false) AND v_from IS NOT NULL THEN
    SELECT array_agg(DISTINCT mm.agent_id) INTO v_agents FROM fleet_agent_mail mm JOIN fleet_agents g ON g.agent_id = mm.agent_id AND g.status NOT IN ('dead','failed')
     WHERE mm.channel_id = p_channel AND mm.received_at > now() - interval '180 days'
       AND ((mm.direction = 'out' AND v_from = ANY(mm.recipients)) OR (mm.direction = 'in' AND mm.sender_address = v_from AND mm.routing <> 'unassigned'));
    IF cardinality(v_agents) = 1 THEN
      SELECT * INTO p FROM fleet_agent_mail WHERE channel_id = p_channel AND agent_id = v_agents[1]
         AND ((direction = 'out' AND v_from = ANY(recipients)) OR (direction = 'in' AND sender_address = v_from)) ORDER BY received_at DESC LIMIT 1;
      RETURN jsonb_build_object('ok', true, 'deliveries', jsonb_build_array(fleet_mail_store_in(c, m, v_pid, v_ext, v_irt, v_refs, v_rcpts, v_from, v_at, p_withheld,
        p.agent_id, p.mailbox_id, p.venture_id, p.account_id, NULL, 'correspondent', 'an established correspondent of this agent')));
    ELSIF cardinality(v_agents) > 1 THEN v_reason := 'the sender corresponds with several agents';
    END IF;
  END IF;

  -- 5. Unassigned: kept for Admin, never handed to an arbitrary agent.
  IF COALESCE(p_withheld, false) THEN v_reason := 'authentication mail without a deterministic owner (never guessed): ' || v_reason; END IF;
  RETURN jsonb_build_object('ok', true, 'deliveries', jsonb_build_array(fleet_mail_store_in(c, m, v_pid, v_ext, v_irt, v_refs, v_rcpts, v_from, v_at, p_withheld,
    NULL, NULL, NULL, NULL, NULL, 'unassigned', v_reason)));
END $$;

${AUTH_BLOB_STORE}

-- The broker's configuration becomes the registry's (removed providers retire; open dependencies of an activated
-- capability are satisfied).
CREATE FUNCTION ix_comms_configure(p_worker text, p_config jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE e jsonb; v_keep uuid[] := '{}'; v_id uuid; v_cap text;
BEGIN
  IF p_worker IS NULL OR p_worker !~ '^[a-z0-9_.-]{1,64}$' OR jsonb_typeof(p_config) <> 'array' OR jsonb_array_length(p_config) > 10 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  FOR e IN SELECT * FROM jsonb_array_elements(p_config) LOOP
    IF e ->> 'capability' NOT IN ('mail','sms') OR COALESCE(e ->> 'provider', '') !~ '^[a-z0-9][a-z0-9._-]{1,40}$'
       OR e ->> 'mode' NOT IN ('shared','dedicated','numbers') THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
    END IF;
    SELECT provider_id INTO v_id FROM fleet_comms_providers WHERE status = 'active' AND capability = e ->> 'capability' AND provider = e ->> 'provider'
       AND mode = e ->> 'mode' AND COALESCE(address, '') = lower(COALESCE(e ->> 'address', ''));
    IF NOT FOUND THEN
      INSERT INTO fleet_comms_providers (provider_id, capability, provider, mode, address, registered_by)
        VALUES (gen_random_uuid(), e ->> 'capability', e ->> 'provider', e ->> 'mode', lower(e ->> 'address'), p_worker) RETURNING provider_id INTO v_id;
      PERFORM fleet_event('comms_provider_registered', NULL, 'identity-broker', jsonb_build_object('capability', e ->> 'capability', 'provider', e ->> 'provider', 'mode', e ->> 'mode'));
    END IF;
    v_keep := v_keep || v_id;
  END LOOP;
  UPDATE fleet_comms_providers SET status = 'retired', retired_at = now() WHERE status = 'active' AND NOT (provider_id = ANY(v_keep));
  FOREACH v_cap IN ARRAY ARRAY['mail','sms'] LOOP
    IF fleet_comms_configured(v_cap) THEN
      UPDATE fleet_capability_demands SET status = 'satisfied', satisfied_at = now() WHERE capability = v_cap AND status = 'open';
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'providers', COALESCE((SELECT jsonb_agg(jsonb_build_object('providerId', provider_id, 'capability', capability,
    'provider', provider, 'mode', mode, 'address', address)) FROM fleet_comms_providers WHERE status = 'active'), '[]'::jsonb));
END $$;

CREATE FUNCTION ix_comms_health(p_worker text, p_provider uuid, p_ok boolean, p_error text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  UPDATE fleet_comms_providers SET last_sync_at = now(), last_ok_at = CASE WHEN p_ok THEN now() ELSE last_ok_at END,
         last_error = CASE WHEN p_ok THEN last_error ELSE left(p_error, 120) END, last_error_at = CASE WHEN p_ok THEN last_error_at ELSE now() END,
         consecutive_failures = CASE WHEN p_ok THEN 0 ELSE consecutive_failures + 1 END
   WHERE provider_id = p_provider AND status = 'active';
  RETURN jsonb_build_object('ok', FOUND);
END $$;

CREATE FUNCTION fleet_admin_mail_assign(p_message uuid, p_agent text, p_venture uuid, p_account uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE mm fleet_agent_mail; v_box uuid; v_addr text;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_comms');
  SELECT * INTO mm FROM fleet_agent_mail WHERE message_id = p_message FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such message'; END IF;
  IF mm.agent_id IS NOT NULL OR mm.direction <> 'in' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: the message is already attributed to %', mm.agent_id; END IF;
  IF NOT EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = p_agent AND status NOT IN ('dead','failed')) THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such living agent'; END IF;
  IF p_venture IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fleet_ventures WHERE venture_id = p_venture AND agent_id = p_agent) THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: the venture is not that agent''s';
  END IF;
  IF p_account IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fleet_agent_accounts WHERE account_id = p_account AND agent_id = p_agent) THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: the account is not that agent''s';
  END IF;
  SELECT mailbox_id, address INTO v_box, v_addr FROM fleet_agent_mailboxes WHERE agent_id = p_agent AND channel_id = mm.channel_id AND status = 'active' ORDER BY created_at DESC LIMIT 1;
  UPDATE fleet_agent_mail SET agent_id = p_agent, mailbox_id = v_box, venture_id = p_venture, account_id = p_account, routing = 'admin',
         routing_reason = 'routed by Admin', assigned_by = p_actor, assigned_at = now(),
         platform = COALESCE((SELECT platform FROM fleet_agent_accounts WHERE account_id = p_account), platform)
   WHERE message_id = p_message;
  UPDATE fleet_auth_message_blobs SET agent_id = p_agent, address = COALESCE(v_addr, address) WHERE kind = 'mail' AND message_id = p_message;
  PERFORM fleet_event('mail_assigned', p_agent, p_actor, jsonb_build_object('messageId', p_message, 'ventureId', p_venture, 'accountId', p_account));
  RETURN jsonb_build_object('ok', true, 'messageId', p_message, 'agentId', p_agent);
END $$;

CREATE FUNCTION fleet_admin_mail_feed(a jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_view text := COALESCE(a ->> 'view', 'inbox'); v_limit integer := LEAST(GREATEST(COALESCE((a ->> 'limit')::integer, 100), 1), 500); v_thread uuid;
BEGIN
  IF v_view NOT IN ('inbox','outbox','unassigned','security','thread','all') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: view is inbox|outbox|unassigned|security|thread|all'; END IF;
  IF v_view = 'thread' THEN v_thread := (a ->> 'threadId')::uuid; END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('messageId', m.message_id, 'direction', m.direction, 'agentId', m.agent_id,
      'ventureId', m.venture_id, 'ventureKey', (SELECT venture_key FROM fleet_ventures v WHERE v.venture_id = m.venture_id),
      'accountId', m.account_id, 'platform', m.platform, 'identityId', m.identity_id, 'jobId', m.job_id, 'threadId', m.thread_id,
      'mailbox', COALESCE(b.address, c.address), 'channel', c.provider, 'from', CASE m.direction WHEN 'in' THEN m.sender ELSE COALESCE(c.address, b.address) END,
      'to', CASE m.direction WHEN 'in' THEN COALESCE(to_jsonb(m.recipients), to_jsonb(b.address)) ELSE to_jsonb(m.recipients) END,
      'subject', m.subject, 'body', left(m.body, 20000), 'authenticationMessage', m.withheld, 'consumedByBroker', m.consumed_at IS NOT NULL,
      'routing', m.routing, 'routingReason', m.routing_reason, 'assignedBy', m.assigned_by, 'externalMessageId', m.external_message_id,
      'sendStatus', m.send_status, 'sendError', m.send_error, 'sentAt', m.sent_at, 'at', m.received_at)) ORDER BY m.received_at DESC)
    FROM (SELECT * FROM fleet_agent_mail mm WHERE
            CASE v_view WHEN 'inbox' THEN mm.direction = 'in' AND mm.agent_id IS NOT NULL
                        WHEN 'outbox' THEN mm.direction = 'out'
                        WHEN 'unassigned' THEN mm.agent_id IS NULL
                        WHEN 'security' THEN mm.withheld
                        WHEN 'thread' THEN mm.thread_id = v_thread
                        ELSE true END
            AND (a ->> 'agentId' IS NULL OR mm.agent_id = a ->> 'agentId')
          ORDER BY mm.received_at DESC LIMIT v_limit) m
    LEFT JOIN fleet_agent_mailboxes b ON b.mailbox_id = m.mailbox_id LEFT JOIN fleet_comms_providers c ON c.provider_id = m.channel_id), '[]'::jsonb);
END $$;

-- ═══ 4. Provider secrets: names and fingerprints only (the values live encrypted in the broker) ═══
CREATE TABLE fleet_provider_secrets (
  name          text        PRIMARY KEY CHECK (name ~ '^[a-z0-9][a-z0-9._-]{1,40}$'),
  fields        text[]      NOT NULL CHECK (cardinality(fields) BETWEEN 1 AND 10),
  fingerprint   text        NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{16}$'),
  status        text        NOT NULL CHECK (status IN ('present','absent')),
  published_at  timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION ix_provider_secrets_publish(p_worker text, p_list jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE e jsonb; v_names text[] := '{}';
BEGIN
  IF jsonb_typeof(p_list) <> 'array' OR jsonb_array_length(p_list) > 20 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  FOR e IN SELECT * FROM jsonb_array_elements(p_list) LOOP
    INSERT INTO fleet_provider_secrets (name, fields, fingerprint, status) VALUES (e ->> 'name', ARRAY(SELECT jsonb_array_elements_text(e -> 'fields')), e ->> 'fingerprint', 'present')
      ON CONFLICT (name) DO UPDATE SET fields = EXCLUDED.fields, fingerprint = EXCLUDED.fingerprint, status = 'present',
        published_at = CASE WHEN fleet_provider_secrets.fingerprint = EXCLUDED.fingerprint AND fleet_provider_secrets.status = 'present'
                            THEN fleet_provider_secrets.published_at ELSE now() END;
    v_names := v_names || (e ->> 'name');
  END LOOP;
  UPDATE fleet_provider_secrets SET status = 'absent', published_at = now() WHERE status = 'present' AND NOT (name = ANY(v_names));
  RETURN jsonb_build_object('ok', true);
END $$;

ALTER TABLE fleet_reveal_requests ADD COLUMN provider_name text CHECK (provider_name ~ '^[a-z0-9][a-z0-9._-]{1,40}$');
ALTER TABLE fleet_reveal_requests DROP CONSTRAINT fleet_reveal_requests_kind_check;
ALTER TABLE fleet_reveal_requests ADD CONSTRAINT fleet_reveal_requests_kind_check CHECK (kind IN ('agent_credential','owner_identity','provider_secret'));
ALTER TABLE fleet_reveal_requests ADD CONSTRAINT fleet_reveal_requests_secret CHECK ((kind = 'provider_secret') = (provider_name IS NOT NULL));
${REVEAL_LOG}
${REVEAL_REQUEST}
${REVEAL_PENDING}

-- ═══ 5. Numbers: quotes, cost, charging, review ═══
ALTER TABLE fleet_identity_jobs DROP CONSTRAINT fleet_identity_jobs_kind_check;
ALTER TABLE fleet_identity_jobs ADD CONSTRAINT fleet_identity_jobs_kind_check CHECK (kind IN ('mailbox.provision','account.create','account.operate',
  'account.verify_identity','account.recover','credential.rotate','credential.revoke','account.close','credential.rebind',
  'mail.send','phone.provision','phone.release','sms.send','phone.quote'));

CREATE TABLE fleet_phone_quotes (
  quote_id           uuid        PRIMARY KEY,
  agent_id           text        NOT NULL REFERENCES fleet_agents(agent_id),
  venture_id         uuid        REFERENCES fleet_ventures(venture_id),
  country            text        NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  purpose            text        NOT NULL CHECK (length(purpose) BETWEEN 3 AND 200),
  number_types       text[]      NOT NULL CHECK (number_types <@ ARRAY['mobile','local','toll_free','national']::text[] AND cardinality(number_types) BETWEEN 1 AND 4),
  status             text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','ready','failed')),
  provider           text,
  provider_currency  text        CHECK (provider_currency ~ '^[A-Z]{3}$'),
  fx_rate_micro      bigint,
  options            jsonb       CHECK (length(options::text) <= 20000),
  messaging          jsonb       CHECK (length(messaging::text) <= 8000),
  regulation         jsonb       CHECK (length(regulation::text) <= 4000),
  error              text        CHECK (length(error) <= 120),
  job_id             uuid        REFERENCES fleet_identity_jobs(job_id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  ready_at           timestamptz,
  expires_at         timestamptz NOT NULL DEFAULT now() + interval '1 day'
);

ALTER TABLE fleet_agent_phone_numbers
  ADD COLUMN number_type             text   CHECK (number_type IN ('mobile','local','toll_free','national')),
  ADD COLUMN quote_id                uuid   REFERENCES fleet_phone_quotes(quote_id),
  ADD COLUMN monthly_minor           bigint CHECK (monthly_minor > 0),
  ADD COLUMN provider_monthly_micro  bigint CHECK (provider_monthly_micro > 0),
  ADD COLUMN provider_currency       text   CHECK (provider_currency ~ '^[A-Z]{3}$'),
  ADD COLUMN payment_due_since       timestamptz,
  ADD COLUMN review_state            text   NOT NULL DEFAULT 'ok' CHECK (review_state IN ('ok','idle','unpaid')),
  ADD COLUMN reviewed_at             timestamptz;

CREATE TABLE fleet_phone_number_dependencies (
  number_id      uuid        NOT NULL REFERENCES fleet_agent_phone_numbers(number_id),
  account_id     uuid        NOT NULL REFERENCES fleet_agent_accounts(account_id),
  first_used_at  timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (number_id, account_id)
);

ALTER TABLE fleet_agent_sms
  ADD COLUMN price_micro     bigint CHECK (price_micro >= 0),
  ADD COLUMN price_currency  text   CHECK (price_currency ~ '^[A-Z]{3}$'),
  ADD COLUMN cost_minor      bigint CHECK (cost_minor >= 0),
  ADD COLUMN charge_status   text   CHECK (charge_status IN ('pending','charged','unpaid','awaiting_credits','none')),
  ADD COLUMN journal_id      uuid,
  ADD COLUMN priced_at       timestamptz;

CREATE TABLE fleet_phone_charges (
  charge_key     text        PRIMARY KEY CHECK (charge_key ~ '^[A-Za-z0-9:_.-]{8,128}$'),
  number_id      uuid        NOT NULL REFERENCES fleet_agent_phone_numbers(number_id),
  agent_id       text        NOT NULL REFERENCES fleet_agents(agent_id),
  kind           text        NOT NULL CHECK (kind IN ('rental','usage')),
  amount_minor   bigint      NOT NULL CHECK (amount_minor > 0),
  status         text        NOT NULL CHECK (status IN ('charged','unpaid','awaiting_credits')),
  journal_id     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_phone_charges_no_delete BEFORE DELETE ON fleet_phone_charges FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- Ledger: prepaid provider credit (the owner tops the provider account up; agents reimburse what they use) — the
-- inference / Conway-credit pattern, applied to communications providers.
INSERT INTO fleet_ledger_classes (class, kind, normal_side, scope, non_negative, description) VALUES
  ('provider_credits', 'asset', 'D', 'fleet', true, 'Prepaid communications-provider credit (e.g. a programmable-numbers account balance)');
INSERT INTO fleet_ledger_accounts (account_id, class, description, created_by) VALUES
  ('fleet:provider_credits', 'provider_credits', 'Prepaid communications-provider credit', 'migration');
ALTER TABLE fleet_ledger_kinds DISABLE TRIGGER fleet_ledger_kinds_no_change;
INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance) VALUES
  ('provider_credits_purchase', true, ARRAY['owner','executor'], false, 'Treasury cash spent on prepaid communications-provider credit', 'expense'),
  ('provider_usage_charge', false, ARRAY['controller'], false, 'An agent reimburses the Treasury for provider credit its numbers and messages consumed', 'expense');
ALTER TABLE fleet_ledger_kinds ENABLE TRIGGER fleet_ledger_kinds_no_change;
INSERT INTO fleet_ledger_rules (kind, class, side) VALUES
  ('provider_credits_purchase','provider_credits','D'), ('provider_credits_purchase','treasury_cash','C'),
  ('provider_usage_charge','agent_expense','D'), ('provider_usage_charge','agent_cash','C'),
  ('provider_usage_charge','treasury_cash','D'), ('provider_usage_charge','provider_credits','C');

CREATE FUNCTION fleet_admin_provider_credits_record(p_amount bigint, p_external text, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_j uuid;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_treasury');
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the amount is positive'; END IF;
  IF COALESCE(p_external, '') !~ '^[A-Za-z0-9:_./-]{4,120}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the provider''s receipt / top-up reference is required'; END IF;
  IF p_amount > fleet_ledger_balance('fleet:treasury:unallocated') THEN
    RAISE EXCEPTION 'FLEET_TREASURY_INSUFFICIENT: the Treasury holds % unallocated', fleet_ledger_balance('fleet:treasury:unallocated');
  END IF;
  v_j := fleet_ledger_post('provider_credits_purchase', 'provider-credits:' || p_external, p_actor, left(COALESCE(p_reason, 'provider top-up'), 200), 'owner', NULL,
    NULL, NULL, p_external, NULL, now(), jsonb_build_array(
      jsonb_build_object('account', 'fleet:provider_credits', 'side', 'D', 'amount', p_amount),
      jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', p_amount)));
  RETURN jsonb_build_object('ok', true, 'journalId', v_j, 'creditsMinor', fleet_ledger_balance('fleet:provider_credits'));
END $$;

-- One charge (rental or usage) from the agent's own cash; idempotent per key.
CREATE FUNCTION fleet_comms_charge(p_agent text, p_number uuid, p_kind text, p_amount bigint, p_key text, p_reason text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE ch fleet_phone_charges; v_status text; v_j uuid;
BEGIN
  SELECT * INTO ch FROM fleet_phone_charges WHERE charge_key = p_key FOR UPDATE;
  IF FOUND AND ch.status = 'charged' THEN RETURN jsonb_build_object('status', 'charged', 'journalId', ch.journal_id); END IF;
  IF fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_cash')) < p_amount THEN v_status := 'unpaid';
  ELSIF fleet_ledger_balance('fleet:provider_credits') < p_amount THEN v_status := 'awaiting_credits';
  ELSE
    v_j := fleet_ledger_post('provider_usage_charge', p_key, 'controller', left(p_reason, 200), 'controller', p_agent, NULL, NULL, NULL, NULL, now(),
      jsonb_build_array(
        jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_expense'), 'side', 'D', 'amount', p_amount),
        jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'C', 'amount', p_amount),
        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', p_amount),
        jsonb_build_object('account', 'fleet:provider_credits', 'side', 'C', 'amount', p_amount)));
    v_status := 'charged';
  END IF;
  INSERT INTO fleet_phone_charges (charge_key, number_id, agent_id, kind, amount_minor, status, journal_id)
    VALUES (p_key, p_number, p_agent, p_kind, p_amount, v_status, v_j)
    ON CONFLICT (charge_key) DO UPDATE SET status = EXCLUDED.status, journal_id = EXCLUDED.journal_id, updated_at = now();
  RETURN jsonb_build_object('status', v_status, 'journalId', v_j);
END $$;

-- Accounting-currency minor units for a provider-currency amount in micro-units (rounded up; NULL without a fresh rate).
CREATE FUNCTION fleet_comms_to_minor(p_micro bigint, p_currency text) RETURNS bigint LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_cur text := (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1); fx fleet_fx_rates;
BEGIN
  IF p_micro IS NULL OR p_currency IS NULL THEN RETURN NULL; END IF;
  IF p_micro = 0 THEN RETURN 0; END IF;
  IF upper(p_currency) = v_cur THEN RETURN ceil(p_micro / 10000.0)::bigint; END IF;
  fx := fleet_fx_latest(upper(p_currency), v_cur);
  IF fx.rate_micro IS NULL THEN RETURN NULL; END IF;
  RETURN GREATEST(1, ceil(p_micro / 10000.0 * fx.rate_micro / 1000000.0))::bigint;
END $$;

CREATE FUNCTION fleet_phone_quote_json(qq fleet_phone_quotes) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('quoteId', qq.quote_id, 'status', qq.status, 'country', qq.country, 'purpose', qq.purpose, 'provider', qq.provider,
    'providerCurrency', qq.provider_currency, 'options', qq.options, 'messaging', qq.messaging, 'regulation', qq.regulation, 'error', qq.error,
    'expiresAt', qq.expires_at, 'yourCashMinor', fleet_ledger_balance(fleet_ledger_account(qq.agent_id, 'agent_cash')),
    'note', CASE WHEN qq.status = 'ready' THEN 'Your decision: provision only if the number is commercially justified from your own capital. '
      || 'The monthly rental becomes your recurring commitment and is charged to you (the first month at once); each SMS sent or received is '
      || 'charged at the provider''s price. Pass quoteId, numberType and your maxMonthlyMinor to phone.provision. Release numbers you no longer need.' END))
$$;

CREATE FUNCTION fleet_econ_phone_quote(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE qq fleet_phone_quotes; v_country text; v_purpose text; v_types text[]; v_venture text; v_idem text; r jsonb; v_id uuid := gen_random_uuid();
BEGIN
  IF a ? 'quoteId' THEN
    SELECT * INTO qq FROM fleet_phone_quotes WHERE quote_id = fleet_identity_uuid(a, 'quoteId') AND agent_id = p_agent;
    IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_PHONE_NONE: no such quote of yours'; END IF;
    RETURN jsonb_build_object('ok', true, 'quote', fleet_phone_quote_json(qq));
  END IF;
  v_purpose := fleet_econ_text(a, 'purpose', 200, true);
  v_venture := fleet_econ_venture_ref(p_agent, a);
  IF NOT fleet_comms_configured('sms') THEN RETURN fleet_comms_unavailable(p_agent, 'sms', 'phone.quote', v_purpose, v_venture); END IF;
  v_idem := fleet_econ_text(a, 'idempotencyKey', 128, true);
  SELECT * INTO qq FROM fleet_phone_quotes q WHERE q.agent_id = p_agent AND q.job_id = (SELECT job_id FROM fleet_identity_jobs WHERE agent_id = p_agent AND idempotency_key = v_idem);
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'quoteId', qq.quote_id, 'status', qq.status); END IF;
  v_country := upper(fleet_econ_text(a, 'country', 2, true));
  IF v_country !~ '^[A-Z]{2}$' THEN PERFORM fleet_econ_bad('country is an ISO 3166 alpha-2 code'); END IF;
  IF jsonb_typeof(a -> 'numberTypes') = 'array' THEN SELECT array_agg(DISTINCT e) INTO v_types FROM jsonb_array_elements_text(a -> 'numberTypes') e;
  ELSE v_types := ARRAY['mobile','local']; END IF;
  IF v_types IS NULL OR NOT (v_types <@ ARRAY['mobile','local','toll_free','national']) THEN PERFORM fleet_econ_bad('numberTypes are mobile|local|toll_free|national'); END IF;
  IF v_venture IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fleet_ventures WHERE venture_id::text = v_venture AND agent_id = p_agent) THEN
    PERFORM fleet_econ_bad('ventureId is one of your ventures');
  END IF;
  INSERT INTO fleet_phone_quotes (quote_id, agent_id, venture_id, country, purpose, number_types) VALUES (v_id, p_agent, v_venture::uuid, v_country, v_purpose, v_types);
  r := fleet_identity_enqueue(p_agent, NULL, 'phone.quote', jsonb_build_object('quoteId', v_id, 'country', v_country, 'numberTypes', to_jsonb(v_types)), v_idem);
  UPDATE fleet_phone_quotes SET job_id = (r ->> 'jobId')::uuid WHERE quote_id = v_id;
  RETURN r || jsonb_build_object('quoteId', v_id, 'note', 'The broker fetches live availability and prices; read it with phone.quote {quoteId}.');
END $$;

CREATE FUNCTION ix_phone_quote_record(p_job uuid, p_lease text, p_quote jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_identity_jobs := ix_leased(p_job, p_lease); qq fleet_phone_quotes; v_cur text := upper(p_quote ->> 'currency'); o jsonb; v_opts jsonb := '[]'::jsonb;
        v_msg jsonb := '{}'::jsonb; k text; v jsonb;
BEGIN
  IF j.kind <> 'phone.quote' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  SELECT * INTO qq FROM fleet_phone_quotes WHERE quote_id::text = j.params ->> 'quoteId' AND agent_id = j.agent_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF p_quote ? 'error' THEN
    UPDATE fleet_phone_quotes SET status = 'failed', error = left(p_quote ->> 'error', 120), ready_at = now() WHERE quote_id = qq.quote_id;
    RETURN jsonb_build_object('ok', true, 'status', 'failed');
  END IF;
  IF v_cur !~ '^[A-Z]{3}$' OR jsonb_typeof(p_quote -> 'options') <> 'array' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  FOR o IN SELECT * FROM jsonb_array_elements(p_quote -> 'options') LIMIT 4 LOOP
    v_opts := v_opts || jsonb_strip_nulls(jsonb_build_object('numberType', o ->> 'numberType',
      'monthlyProvider', CASE WHEN (o ->> 'monthlyMicro') ~ '^[0-9]{1,12}$' THEN to_char((o ->> 'monthlyMicro')::numeric / 1000000, 'FM999999990.00') || ' ' || v_cur END,
      'monthlyMicro', CASE WHEN (o ->> 'monthlyMicro') ~ '^[0-9]{1,12}$' THEN (o ->> 'monthlyMicro')::bigint END,
      'monthlyMinor', CASE WHEN (o ->> 'monthlyMicro') ~ '^[0-9]{1,12}$' THEN fleet_comms_to_minor((o ->> 'monthlyMicro')::bigint, v_cur) END,
      'available', CASE WHEN jsonb_typeof(o -> 'available') = 'array' THEN (SELECT jsonb_agg(x) FROM (SELECT x FROM jsonb_array_elements(o -> 'available') x LIMIT 3) y) END,
      'smsCapable', (o ->> 'smsCapable')::boolean, 'voiceCapable', (o ->> 'voiceCapable')::boolean));
  END LOOP;
  IF jsonb_typeof(p_quote -> 'messaging') = 'object' THEN
    FOR k, v IN SELECT * FROM jsonb_each(p_quote -> 'messaging') LOOP
      IF k ~ '^(outbound|inbound)_(mobile|local|toll_free|national)$' AND (v #>> '{}') ~ '^[0-9]{1,12}$' THEN
        v_msg := v_msg || jsonb_build_object(k, jsonb_strip_nulls(jsonb_build_object('micro', (v #>> '{}')::bigint, 'minor', fleet_comms_to_minor((v #>> '{}')::bigint, v_cur))));
      END IF;
    END LOOP;
  END IF;
  UPDATE fleet_phone_quotes SET status = 'ready', provider = left(p_quote ->> 'provider', 40), provider_currency = v_cur,
         fx_rate_micro = CASE WHEN v_cur = (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1) THEN 1000000
                              ELSE (fleet_fx_latest(v_cur, (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1))).rate_micro END,
         options = v_opts, messaging = v_msg,
         regulation = CASE WHEN jsonb_typeof(p_quote -> 'regulation') = 'object' AND length((p_quote -> 'regulation')::text) <= 4000 THEN p_quote -> 'regulation' END,
         ready_at = now() WHERE quote_id = qq.quote_id;
  RETURN jsonb_build_object('ok', true, 'status', 'ready');
END $$;

-- Provision only against a ready quote, under the agent's own price ceiling, with its first month affordable.
CREATE OR REPLACE FUNCTION fleet_econ_phone_provision(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_purpose text := fleet_econ_text(a, 'purpose', 200, true); v_venture text := fleet_econ_venture_ref(p_agent, a); v_id uuid := gen_random_uuid();
        v_idem text := fleet_econ_text(a, 'idempotencyKey', 128, true); r jsonb; qq fleet_phone_quotes; v_type text := fleet_econ_text(a, 'numberType', 12, true);
        v_max bigint := fleet_econ_int(a, 'maxMonthlyMinor', 1, 100000000, true); opt jsonb; v_cash bigint; v_pref text := fleet_econ_text(a, 'phoneNumber', 16);
BEGIN
  IF EXISTS (SELECT 1 FROM fleet_identity_jobs WHERE agent_id = p_agent AND idempotency_key = v_idem) THEN
    RETURN fleet_identity_enqueue(p_agent, NULL, 'phone.provision', '{}'::jsonb, v_idem);
  END IF;
  IF NOT fleet_comms_configured('sms') THEN RETURN fleet_comms_unavailable(p_agent, 'sms', 'phone.provision', v_purpose, v_venture); END IF;
  SELECT * INTO qq FROM fleet_phone_quotes WHERE quote_id = fleet_identity_uuid(a, 'quoteId') AND agent_id = p_agent;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_PHONE_QUOTE: quoteId is one of your quotes (phone.quote first: price before you buy)'; END IF;
  IF qq.status <> 'ready' OR qq.expires_at <= now() THEN RAISE EXCEPTION 'FLEET_PHONE_QUOTE: the quote is % — request a fresh one', CASE WHEN qq.expires_at <= now() THEN 'expired' ELSE qq.status END; END IF;
  SELECT o INTO opt FROM jsonb_array_elements(qq.options) o WHERE o ->> 'numberType' = v_type;
  IF opt IS NULL THEN PERFORM fleet_econ_bad('numberType is one of the quoted options'); END IF;
  IF (opt ->> 'monthlyMinor') IS NULL THEN RAISE EXCEPTION 'FLEET_PHONE_QUOTE: that option has no price in the accounting currency (no fresh FX rate) — it cannot be charged, so it is not provisioned'; END IF;
  IF (opt ->> 'monthlyMinor')::bigint > v_max THEN
    RAISE EXCEPTION 'FLEET_PHONE_PRICE: the quoted monthly rental % exceeds your maxMonthlyMinor %', opt ->> 'monthlyMinor', v_max;
  END IF;
  v_cash := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_cash'));
  IF v_cash < (opt ->> 'monthlyMinor')::bigint THEN
    RAISE EXCEPTION 'FLEET_PHONE_FUNDS: your cash % does not cover the first month %', v_cash, opt ->> 'monthlyMinor';
  END IF;
  IF v_pref IS NOT NULL AND v_pref !~ ${E164} THEN PERFORM fleet_econ_bad('phoneNumber is E.164'); END IF;
  INSERT INTO fleet_agent_phone_numbers (number_id, agent_id, venture_id, country, purpose, number_type, quote_id)
    VALUES (v_id, p_agent, COALESCE(v_venture::uuid, qq.venture_id), qq.country, v_purpose, v_type, qq.quote_id);
  r := fleet_identity_enqueue(p_agent, NULL, 'phone.provision', jsonb_build_object('numberId', v_id, 'country', qq.country, 'numberType', v_type,
         'phoneNumber', v_pref, 'currency', qq.provider_currency,
         -- The broker refuses to buy above this (the agent's ceiling in the provider's currency, at the quote's rate).
         'maxMonthlyMicro', CASE WHEN qq.fx_rate_micro > 0 THEN floor(v_max * 10000.0 * 1000000.0 / qq.fx_rate_micro)::bigint END), v_idem);
  RETURN r || jsonb_build_object('numberId', v_id, 'note', 'The monthly rental becomes your recurring commitment, charged to you (first month at once); SMS are charged per message.');
END $$;

CREATE FUNCTION ix_phone_record2(p_job uuid, p_lease text, p_e164 text, p_provider text, p_provider_ref text, p_monthly_micro bigint, p_currency text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_identity_jobs := ix_leased(p_job, p_lease); n fleet_agent_phone_numbers; v_amount bigint; v_c uuid; qq fleet_phone_quotes;
BEGIN
  IF j.kind <> 'phone.provision' OR p_e164 !~ ${E164} THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  SELECT * INTO n FROM fleet_agent_phone_numbers WHERE number_id::text = j.params ->> 'numberId' AND agent_id = j.agent_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  v_amount := fleet_comms_to_minor(p_monthly_micro, p_currency);
  IF v_amount IS NULL AND n.quote_id IS NOT NULL THEN
    SELECT * INTO qq FROM fleet_phone_quotes WHERE quote_id = n.quote_id;
    SELECT (o ->> 'monthlyMinor')::bigint INTO v_amount FROM jsonb_array_elements(qq.options) o WHERE o ->> 'numberType' = n.number_type;
  END IF;
  IF v_amount IS NOT NULL AND v_amount > 0 THEN
    v_c := gen_random_uuid();
    -- Due at once: the first month is charged on the controller's next pass.
    INSERT INTO fleet_agent_commitments (commitment_id, agent_id, venture_id, vendor, description, amount_minor, period, next_due_at, idempotency_key)
      VALUES (v_c, j.agent_id, n.venture_id, p_provider, 'phone number ' || p_e164 || ' (' || n.purpose || ')', v_amount, 'monthly', now(), 'phone:' || n.number_id);
  END IF;
  UPDATE fleet_agent_phone_numbers SET e164 = p_e164, provider = p_provider, provider_ref = left(p_provider_ref, 120), status = 'active', commitment_id = v_c,
         monthly_minor = v_amount, provider_monthly_micro = NULLIF(p_monthly_micro, 0), provider_currency = upper(p_currency)
   WHERE number_id = n.number_id;
  RETURN jsonb_build_object('ok', true, 'commitmentId', v_c, 'monthlyMinor', v_amount);
END $$;

-- Release (the agent's, or the controller's for an unpaid / abandoned number): commitment cancelled, provider job queued.
CREATE FUNCTION fleet_phone_release_internal(p_number uuid, p_reason text, p_idem text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE n fleet_agent_phone_numbers;
BEGIN
  SELECT * INTO n FROM fleet_agent_phone_numbers WHERE number_id = p_number FOR UPDATE;
  IF n.status NOT IN ('active','human_action_required','failed','requested') THEN
    RETURN fleet_identity_enqueue(n.agent_id, NULL, 'phone.release', jsonb_build_object('numberId', n.number_id), p_idem);
  END IF;
  UPDATE fleet_agent_phone_numbers SET status = CASE WHEN n.status = 'active' THEN 'releasing' ELSE 'released' END,
         released_at = CASE WHEN n.status = 'active' THEN NULL ELSE now() END, status_reason = left(COALESCE(p_reason, status_reason), 300)
   WHERE number_id = n.number_id;
  IF n.commitment_id IS NOT NULL THEN
    UPDATE fleet_agent_commitments SET status = 'cancelled', cancelled_at = now(), cancel_reason = left('number released: ' || COALESCE(p_reason, ''), 300)
     WHERE commitment_id = n.commitment_id AND status = 'active';
  END IF;
  IF n.status <> 'active' THEN RETURN jsonb_build_object('ok', true, 'status', 'released'); END IF;
  RETURN fleet_identity_enqueue(n.agent_id, NULL, 'phone.release', jsonb_build_object('numberId', n.number_id), p_idem);
END $$;

CREATE OR REPLACE FUNCTION fleet_econ_phone_release(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE n fleet_agent_phone_numbers; v_idem text := fleet_econ_text(a, 'idempotencyKey', 128, true); v_deps text;
BEGIN
  SELECT * INTO n FROM fleet_agent_phone_numbers WHERE number_id = fleet_identity_uuid(a, 'numberId') AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_PHONE_NONE: no such number of yours'; END IF;
  SELECT string_agg(x.platform || ':' || COALESCE(x.handle, x.account_id::text), ', ') INTO v_deps
    FROM fleet_phone_number_dependencies d JOIN fleet_agent_accounts x ON x.account_id = d.account_id
   WHERE d.number_id = n.number_id AND x.status NOT IN ('closed','banned','failed');
  IF v_deps IS NOT NULL AND n.status = 'active' AND NOT COALESCE((a ->> 'force')::boolean, false) THEN
    RAISE EXCEPTION 'FLEET_PHONE_IN_USE: these accounts verify with this number: % — move their recovery / verification first, or pass force:true', left(v_deps, 400);
  END IF;
  RETURN fleet_phone_release_internal(n.number_id, COALESCE(fleet_econ_text(a, 'reason', 200), 'released by the agent'), v_idem);
END $$;

CREATE OR REPLACE FUNCTION fleet_econ_phone_list(p_agent text, a jsonb) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'smsConfigured', fleet_comms_configured('sms'), 'numbers', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'numberId', n.number_id, 'e164', n.e164, 'country', n.country, 'numberType', n.number_type, 'purpose', n.purpose, 'status', n.status, 'reason', n.status_reason,
      'monthlyMinor', n.monthly_minor, 'commitmentId', n.commitment_id, 'createdAt', n.created_at, 'reviewState', n.review_state,
      'paymentDueSince', n.payment_due_since,
      'lastActivityAt', (SELECT max(s.at) FROM fleet_agent_sms s WHERE s.number_id = n.number_id),
      'messages30d', (SELECT count(*) FROM fleet_agent_sms s WHERE s.number_id = n.number_id AND s.at > now() - interval '30 days'),
      'usage30dMinor', (SELECT COALESCE(sum(s.cost_minor), 0) FROM fleet_agent_sms s WHERE s.number_id = n.number_id AND s.at > now() - interval '30 days'),
      'dependentAccounts', (SELECT jsonb_agg(jsonb_build_object('accountId', x.account_id, 'platform', x.platform)) FROM fleet_phone_number_dependencies d
                              JOIN fleet_agent_accounts x ON x.account_id = d.account_id WHERE d.number_id = n.number_id AND x.status NOT IN ('closed','banned','failed')),
      'advice', CASE n.review_state WHEN 'idle' THEN 'No messages for 30 days: release it unless an account still depends on it.'
                                     WHEN 'unpaid' THEN 'Its charges are unpaid: it is released after 7 days unpaid.' END)) ORDER BY n.created_at)
      FROM fleet_agent_phone_numbers n WHERE n.agent_id = p_agent), '[]'::jsonb))
$$;

CREATE FUNCTION ix_sms_costs_pending(p_worker text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('smsId', s.sms_id, 'providerMessageId', s.provider_message_id, 'provider', n.provider)), '[]'::jsonb)
    FROM (SELECT * FROM fleet_agent_sms WHERE price_micro IS NULL AND provider_message_id IS NOT NULL AND at > now() - interval '7 days' AND at < now() - interval '1 minute'
           ORDER BY at LIMIT 50) s JOIN fleet_agent_phone_numbers n ON n.number_id = s.number_id
$$;

CREATE FUNCTION ix_sms_cost(p_worker text, p_sms uuid, p_price_micro bigint, p_currency text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_minor bigint;
BEGIN
  IF p_price_micro IS NULL OR p_price_micro < 0 OR p_price_micro > 100000000 OR upper(p_currency) !~ '^[A-Z]{3}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  v_minor := fleet_comms_to_minor(p_price_micro, p_currency);
  UPDATE fleet_agent_sms SET price_micro = p_price_micro, price_currency = upper(p_currency), cost_minor = v_minor, priced_at = now(),
         charge_status = CASE WHEN v_minor IS NULL THEN 'pending' WHEN v_minor = 0 THEN 'none' ELSE 'pending' END
   WHERE sms_id = p_sms AND price_micro IS NULL;
  RETURN jsonb_build_object('ok', FOUND, 'costMinor', v_minor);
END $$;

-- FleetController's pass: rentals due, usage, unpaid numbers, idle review, numbers of dead agents.
CREATE FUNCTION svc_comms_tick(p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE n fleet_agent_phone_numbers; cm fleet_agent_commitments; s fleet_agent_sms; r jsonb; v_lim integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
        v_charged integer := 0; v_unpaid integer := 0; v_released integer := 0; v_idle integer := 0; v_moved integer := 0; v_heir text; v_last timestamptz;
BEGIN
  -- Rentals due.
  FOR n IN SELECT * FROM fleet_agent_phone_numbers WHERE status = 'active' AND commitment_id IS NOT NULL ORDER BY created_at LIMIT v_lim LOOP
    SELECT * INTO cm FROM fleet_agent_commitments WHERE commitment_id = n.commitment_id AND status = 'active';
    CONTINUE WHEN NOT FOUND OR cm.next_due_at > now();
    r := fleet_comms_charge(n.agent_id, n.number_id, 'rental', cm.amount_minor, 'phone-rent:' || n.number_id || ':' || to_char(cm.next_due_at, 'YYYYMMDD'),
                            'number ' || n.e164 || ' monthly rental');
    IF r ->> 'status' = 'charged' THEN
      UPDATE fleet_agent_commitments SET next_due_at = next_due_at + interval '1 month' WHERE commitment_id = cm.commitment_id;
      v_charged := v_charged + 1;
    ELSE v_unpaid := v_unpaid + 1;
    END IF;
  END LOOP;
  -- Usage (priced messages).
  FOR s IN SELECT * FROM fleet_agent_sms WHERE charge_status IN ('pending','unpaid','awaiting_credits') AND cost_minor IS NOT NULL AND cost_minor > 0
             ORDER BY at LIMIT v_lim LOOP
    r := fleet_comms_charge(s.agent_id, s.number_id, 'usage', s.cost_minor, 'sms-cost:' || s.sms_id, 'SMS ' || s.direction);
    UPDATE fleet_agent_sms SET charge_status = r ->> 'status', journal_id = (r ->> 'journalId')::uuid WHERE sms_id = s.sms_id;
    IF r ->> 'status' = 'charged' THEN v_charged := v_charged + 1; ELSE v_unpaid := v_unpaid + 1; END IF;
  END LOOP;
  -- Payment state: an agent that cannot pay its own number for 7 days loses it (the Fleet does not carry abandoned costs).
  FOR n IN SELECT * FROM fleet_agent_phone_numbers WHERE status = 'active' LOOP
    IF EXISTS (SELECT 1 FROM fleet_phone_charges c WHERE c.number_id = n.number_id AND c.status = 'unpaid') THEN
      UPDATE fleet_agent_phone_numbers SET payment_due_since = COALESCE(payment_due_since, now()), review_state = 'unpaid' WHERE number_id = n.number_id;
      IF n.payment_due_since IS NOT NULL AND n.payment_due_since < now() - interval '7 days' THEN
        PERFORM fleet_phone_release_internal(n.number_id, 'released by FleetController: charges unpaid for 7 days', 'auto-release:' || n.number_id);
        PERFORM fleet_event('phone_released_unpaid', n.agent_id, 'controller', jsonb_build_object('numberId', n.number_id));
        v_released := v_released + 1;
      END IF;
    ELSIF n.payment_due_since IS NOT NULL THEN
      UPDATE fleet_agent_phone_numbers SET payment_due_since = NULL, review_state = 'ok' WHERE number_id = n.number_id;
    END IF;
  END LOOP;
  -- Idle review (advice to the agent; it decides).
  FOR n IN SELECT * FROM fleet_agent_phone_numbers WHERE status = 'active' AND review_state <> 'unpaid' AND created_at < now() - interval '30 days' LOOP
    SELECT max(at) INTO v_last FROM fleet_agent_sms WHERE number_id = n.number_id;
    IF (v_last IS NULL OR v_last < now() - interval '30 days') AND n.review_state = 'ok' THEN
      UPDATE fleet_agent_phone_numbers SET review_state = 'idle', reviewed_at = now() WHERE number_id = n.number_id;
      PERFORM fleet_event('phone_idle', n.agent_id, 'controller', jsonb_build_object('numberId', n.number_id, 'monthlyMinor', n.monthly_minor));
      v_idle := v_idle + 1;
    ELSIF v_last >= now() - interval '30 days' AND n.review_state = 'idle' THEN
      UPDATE fleet_agent_phone_numbers SET review_state = 'ok', reviewed_at = now() WHERE number_id = n.number_id;
    END IF;
  END LOOP;
  -- A dead agent's numbers follow the living heir of the accounts that verify with them; otherwise they are released.
  FOR n IN SELECT pn.* FROM fleet_agent_phone_numbers pn JOIN fleet_agents g ON g.agent_id = pn.agent_id
            WHERE pn.status IN ('active','human_action_required','requested') AND g.status IN ('dead','failed') LOOP
    SELECT x.agent_id INTO v_heir FROM fleet_phone_number_dependencies d JOIN fleet_agent_accounts x ON x.account_id = d.account_id
      JOIN fleet_agents h ON h.agent_id = x.agent_id AND h.status NOT IN ('dead','failed') WHERE d.number_id = n.number_id ORDER BY d.last_used_at DESC LIMIT 1;
    IF v_heir IS NOT NULL THEN
      UPDATE fleet_agent_phone_numbers SET agent_id = v_heir, venture_id = NULL WHERE number_id = n.number_id;
      UPDATE fleet_agent_commitments SET agent_id = v_heir, venture_id = NULL WHERE commitment_id = n.commitment_id AND status = 'active';
      PERFORM fleet_event('phone_inherited', v_heir, 'controller', jsonb_build_object('numberId', n.number_id, 'from', n.agent_id));
      v_moved := v_moved + 1;
    ELSE
      PERFORM fleet_phone_release_internal(n.number_id, 'released by FleetController: its agent died', 'estate-release:' || n.number_id);
      v_released := v_released + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('charged', v_charged, 'unpaid', v_unpaid, 'released', v_released, 'idle', v_idle, 'inherited', v_moved);
END $$;

${SECRET_SERVE}

CREATE FUNCTION fleet_admin_comms_status() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'mail', jsonb_build_object('configured', fleet_comms_configured('mail'),
      'state', CASE WHEN NOT fleet_comms_configured('mail') THEN 'NOT_CONFIGURED' ELSE 'CONFIGURED' END,
      'preferredProvider', 'proton-bridge',
      'channels', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('providerId', p.provider_id, 'provider', p.provider, 'mode', p.mode, 'address', p.address,
          'status', p.status, 'registeredAt', p.registered_at, 'lastSyncAt', p.last_sync_at, 'lastOkAt', p.last_ok_at, 'lastError', p.last_error,
          'lastErrorAt', p.last_error_at, 'consecutiveFailures', p.consecutive_failures,
          'health', CASE WHEN p.last_sync_at IS NULL THEN 'never_synced' WHEN p.consecutive_failures >= 5 THEN 'down'
                         WHEN p.consecutive_failures > 0 THEN 'degraded' WHEN p.last_ok_at < now() - interval '30 minutes' THEN 'stale' ELSE 'ok' END,
          'in24h', (SELECT count(*) FROM fleet_agent_mail m WHERE m.channel_id = p.provider_id AND m.direction = 'in' AND m.received_at > now() - interval '1 day'),
          'out24h', (SELECT count(*) FROM fleet_agent_mail m WHERE m.channel_id = p.provider_id AND m.direction = 'out' AND m.received_at > now() - interval '1 day'),
          'sendFailures24h', (SELECT count(*) FROM fleet_agent_mail m WHERE m.channel_id = p.provider_id AND m.send_status = 'failed' AND m.received_at > now() - interval '1 day'),
          'routingAddresses', (SELECT count(*) FROM fleet_agent_mailboxes b WHERE b.channel_id = p.provider_id AND b.status = 'active')
        )) ORDER BY p.registered_at DESC) FROM fleet_comms_providers p WHERE p.capability = 'mail' AND p.status = 'active'), '[]'::jsonb),
      'unassigned', (SELECT count(*) FROM fleet_agent_mail WHERE agent_id IS NULL),
      'unassignedSecurity', (SELECT count(*) FROM fleet_agent_mail WHERE agent_id IS NULL AND withheld),
      'securityHandled24h', (SELECT count(*) FROM fleet_agent_mail WHERE withheld AND received_at > now() - interval '1 day')),
    'sms', jsonb_build_object('configured', fleet_comms_configured('sms'),
      'state', CASE WHEN NOT fleet_comms_configured('sms') THEN 'NOT_CONFIGURED' ELSE 'CONFIGURED' END,
      'preferredProvider', 'twilio',
      'providers', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('provider', p.provider, 'registeredAt', p.registered_at, 'lastSyncAt', p.last_sync_at,
          'lastError', p.last_error, 'consecutiveFailures', p.consecutive_failures))) FROM fleet_comms_providers p WHERE p.capability = 'sms' AND p.status = 'active'), '[]'::jsonb),
      'activeNumbers', (SELECT count(*) FROM fleet_agent_phone_numbers WHERE status = 'active'),
      'monthlyCommittedMinor', (SELECT COALESCE(sum(monthly_minor), 0) FROM fleet_agent_phone_numbers WHERE status = 'active'),
      'usage30dMinor', (SELECT COALESCE(sum(cost_minor), 0) FROM fleet_agent_sms WHERE at > now() - interval '30 days'),
      'unpaidMinor', (SELECT COALESCE(sum(amount_minor), 0) FROM fleet_phone_charges WHERE status IN ('unpaid','awaiting_credits')),
      'providerCreditsMinor', fleet_ledger_balance('fleet:provider_credits'),
      'numbers', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('numberId', n.number_id, 'agentId', n.agent_id, 'ventureId', n.venture_id, 'e164', n.e164,
          'country', n.country, 'numberType', n.number_type, 'purpose', n.purpose, 'status', n.status, 'reason', n.status_reason, 'monthlyMinor', n.monthly_minor,
          'reviewState', n.review_state, 'paymentDueSince', n.payment_due_since, 'createdAt', n.created_at,
          'lastActivityAt', (SELECT max(s.at) FROM fleet_agent_sms s WHERE s.number_id = n.number_id),
          'dependentAccounts', (SELECT count(*) FROM fleet_phone_number_dependencies d WHERE d.number_id = n.number_id))) ORDER BY n.created_at DESC)
        FROM fleet_agent_phone_numbers n), '[]'::jsonb),
      'quotes', COALESCE((SELECT jsonb_agg(fleet_phone_quote_json(qq) || jsonb_build_object('agentId', qq.agent_id) ORDER BY qq.created_at DESC)
        FROM (SELECT * FROM fleet_phone_quotes ORDER BY created_at DESC LIMIT 20) qq), '[]'::jsonb)),
    'demands', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('agentId', d.agent_id, 'capability', d.capability, 'lastOp', d.last_op, 'purpose', d.purpose,
        'ventureId', d.venture_id, 'attempts', d.attempts, 'status', d.status, 'firstAt', d.first_at, 'lastAt', d.last_at)) ORDER BY d.last_at DESC)
      FROM (SELECT * FROM fleet_capability_demands ORDER BY last_at DESC LIMIT 100) d), '[]'::jsonb),
    'providerSecrets', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', s.name, 'fields', to_jsonb(s.fields), 'fingerprint', s.fingerprint, 'status', s.status,
        'publishedAt', s.published_at) ORDER BY s.name) FROM fleet_provider_secrets s), '[]'::jsonb))
$$;

${DISPATCH}

${DASH_CALL}
`;
