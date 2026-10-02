/**
 * Schema v36 — identity II: business mail, outbound mail, phone numbers and SMS, Admin reveal through the broker, owner
 * identity vault upload, Admin notification email (master handoff §§9–13, 15, 37–38; owner decisions 2026-10-02).
 *
 *  • MAIL: agents read the FULL content of their own business mail (customers, suppliers, platforms) and SEND mail from
 *    their own addresses (mail.send → the broker → the provider adapter). Only an authentication message (a sign-up
 *    link / one-time code the broker consumes for credential execution) is stored with its link/code withheld.
 *    Provider message ids make delivery idempotent across broker restarts.
 *  • PHONE / SMS: agents provision legitimate virtual numbers (the monthly fee becomes their own recurring commitment),
 *    read and send SMS, release numbers to stop the cost. A provider that refuses a number (regulatory bundle, VoIP
 *    rejection) fails only that action.
 *  • ADMIN REVEAL: nothing is hidden from Admin. A reveal request names a credential or an owner identity class and an
 *    ephemeral X25519 public key; the broker (the only process holding the vaults) seals the plaintext to that key; the
 *    Admin session takes it once (the sealed copy is then erased). The web process never touches a vault; every reveal
 *    is permanently logged (never the value).
 *  • OWNER VAULT UPLOAD: the dashboard seals an uploaded fact/document to the broker's public key immediately; the broker
 *    installs it into its owner vault and the database keeps only metadata (the sealed upload is erased on install).
 *  • NOTIFICATION EMAIL: the broker (holder of the mail provider credential) emails Admin the classes the policy selects.
 */

import { V34_SQL } from "./migrations-phase34.js";
import { V35_SQL } from "./migrations-phase35.js";

function restate(src: string, srcTag: string, name: string, edits: Array<[string, string]>): string {
  const head = Math.max(src.lastIndexOf(`CREATE FUNCTION ${name}(`), src.lastIndexOf(`CREATE OR REPLACE FUNCTION ${name}(`));
  if (head < 0) throw new Error(`v36: ${srcTag} function ${name} not found`);
  const end = src.indexOf("$$;", src.indexOf("AS $$", head) + 5);
  if (end < 0) throw new Error(`v36: ${srcTag} function ${name} has no body end`);
  let body = "CREATE OR REPLACE " + src.slice(src.indexOf("FUNCTION", head), end + 3);
  for (const [from, to] of edits) {
    if (body.split(from).length !== 2) throw new Error(`v36: expected text not found exactly once in ${name}: ${from.slice(0, 60)}`);
    body = body.replace(from, to);
  }
  return body;
}

export const IDENTITY2_OPS = ["mail.send", "mail.read", "phone.provision", "phone.release", "phone.list", "sms.send", "sms.inbox"] as const;

const DISPATCH = restate(V35_SQL, "v35", "api_economy", [
  [`WHEN 'estate.claim' THEN 'planning'`,
   `WHEN 'estate.claim' THEN 'planning'
    -- v36: business mail and SMS are the agent's own communication (planning; no approval step).
    ${IDENTITY2_OPS.map((o) => `WHEN '${o}' THEN 'planning'`).join(" ")}`],
  [`WHEN 'estate.claim' THEN fleet_econ_estate_claim(p_agent, a)`,
   `WHEN 'estate.claim' THEN fleet_econ_estate_claim(p_agent, a)
      ${IDENTITY2_OPS.map((o) => `WHEN '${o}' THEN fleet_econ_${o.replace(".", "_")}(p_agent, a)`).join("\n      ")}`],
  ["COMMITMENT_[A-Z_]+):", "COMMITMENT_[A-Z_]+|MAIL_[A-Z_]+|PHONE_[A-Z_]+):"],
]);

// Communication jobs have their own failsafe (sends per day) instead of the account-work ceiling.
const ENQUEUE = restate(V34_SQL, "v34", "fleet_identity_enqueue", [
  ["IF (SELECT count(*) FROM fleet_identity_jobs WHERE agent_id = p_agent AND created_at > now() - interval '1 day')",
   "IF p_kind NOT IN ('mail.send','sms.send') AND (SELECT count(*) FROM fleet_identity_jobs WHERE agent_id = p_agent AND created_at > now() - interval '1 day' AND kind NOT IN ('mail.send','sms.send'))"],
]);

// Job context: the message to send / the number concerned (the agent's own content, no secret).
const JOB_CONTEXT = restate(V34_SQL, "v34", "ix_job_context", [
  [`'mailboxes', COALESCE(`, `'message', (SELECT jsonb_build_object('messageId', m.message_id, 'from', b.address, 'to', m.recipients, 'subject', m.subject, 'body', m.body,
                  'inReplyTo', (SELECT provider_message_id FROM fleet_agent_mail r WHERE r.message_id = m.in_reply_to))
                  FROM fleet_agent_mail m JOIN fleet_agent_mailboxes b ON b.mailbox_id = m.mailbox_id
                 WHERE j.kind = 'mail.send' AND m.message_id::text = j.params ->> 'messageId' AND m.agent_id = j.agent_id),
    'sms', (SELECT jsonb_build_object('smsId', s.sms_id, 'from', n.e164, 'to', s.counterparty, 'body', s.body)
                  FROM fleet_agent_sms s JOIN fleet_agent_phone_numbers n ON n.number_id = s.number_id
                 WHERE j.kind = 'sms.send' AND s.sms_id::text = j.params ->> 'smsId' AND s.agent_id = j.agent_id),
    'number', (SELECT jsonb_build_object('numberId', n.number_id, 'e164', n.e164, 'providerRef', n.provider_ref, 'country', n.country)
                  FROM fleet_agent_phone_numbers n WHERE j.kind IN ('phone.provision','phone.release') AND n.number_id::text = j.params ->> 'numberId' AND n.agent_id = j.agent_id),
    'mailboxes', COALESCE(`],
]);

const OWNER_CLASSES = "'legal_name','date_of_birth','residential_address','contact_email','contact_phone','id_document','proof_of_address','tax_identifier','bank_account_owner','other_fact','passport','driving_licence'";
const E164 = `'^\\+[1-9][0-9]{6,14}$'`;

export const V36_SQL = `
-- ═══ 1. Mail: full business content, outbound, idempotent delivery ═══
ALTER TABLE fleet_agent_mail DROP CONSTRAINT fleet_agent_mail_body_check;
ALTER TABLE fleet_agent_mail ADD CONSTRAINT fleet_agent_mail_body_check CHECK (length(body) <= 100000);
ALTER TABLE fleet_agent_mail
  ADD COLUMN direction            text   NOT NULL DEFAULT 'in' CHECK (direction IN ('in','out')),
  ADD COLUMN recipients           text[] CHECK (recipients IS NULL OR cardinality(recipients) BETWEEN 1 AND 10),
  ADD COLUMN provider_message_id  text   CHECK (length(provider_message_id) <= 300),
  ADD COLUMN in_reply_to          uuid   REFERENCES fleet_agent_mail(message_id),
  ADD COLUMN send_status          text   CHECK (send_status IN ('queued','sent','failed')),
  ADD COLUMN withheld             boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT fleet_agent_mail_out CHECK ((direction = 'out') = (send_status IS NOT NULL AND recipients IS NOT NULL));
CREATE UNIQUE INDEX fleet_agent_mail_provider_id ON fleet_agent_mail (mailbox_id, provider_message_id) WHERE provider_message_id IS NOT NULL;

CREATE FUNCTION fleet_scrub_mail(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  -- Business content stays whole; only private-key material and credentials embedded in URLs are removed.
  SELECT left(regexp_replace(regexp_replace(COALESCE(t, ''),
           '0x[0-9a-fA-F]{64}', '[redacted]', 'g'),
           '[a-zA-Z][a-zA-Z0-9+.-]*://[^[:space:]:@/]+:[^[:space:]@/]+@', '[redacted]@', 'g'), 100000)
$$;

CREATE FUNCTION ix_mail_deliver2(p_worker text, p_address text, p_sender text, p_subject text, p_body text, p_withheld boolean, p_provider_id text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE b fleet_agent_mailboxes; v_id uuid := gen_random_uuid(); v_prior uuid;
BEGIN
  SELECT * INTO b FROM fleet_agent_mailboxes WHERE lower(address) = lower(p_address) AND status = 'active';
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF p_provider_id IS NOT NULL THEN
    SELECT message_id INTO v_prior FROM fleet_agent_mail WHERE mailbox_id = b.mailbox_id AND provider_message_id = p_provider_id;
    IF FOUND THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'messageId', v_prior); END IF;
  END IF;
  INSERT INTO fleet_agent_mail (message_id, mailbox_id, agent_id, sender, subject, body, verification, withheld, provider_message_id)
    VALUES (v_id, b.mailbox_id, b.agent_id, left(fleet_scrub(p_sender), 200), left(fleet_scrub(COALESCE(p_subject, '')), 300),
            fleet_scrub_mail(p_body), COALESCE(p_withheld, false), COALESCE(p_withheld, false), left(p_provider_id, 300));
  RETURN jsonb_build_object('ok', true, 'messageId', v_id);
END $$;

CREATE FUNCTION ix_mail_sent(p_job uuid, p_lease text, p_provider_id text, p_ok boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_identity_jobs := ix_leased(p_job, p_lease);
BEGIN
  IF j.kind <> 'mail.send' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  UPDATE fleet_agent_mail SET send_status = CASE WHEN p_ok THEN 'sent' ELSE 'failed' END, provider_message_id = left(p_provider_id, 300)
   WHERE message_id::text = j.params ->> 'messageId' AND agent_id = j.agent_id AND direction = 'out';
  RETURN jsonb_build_object('ok', true);
END $$;

${ENQUEUE}

CREATE OR REPLACE FUNCTION fleet_econ_mail_inbox(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_box text := lower(fleet_econ_text(a, 'mailbox', 190)); v_since timestamptz; v_limit integer := COALESCE(fleet_econ_int(a, 'limit', 1, 50), 20)::integer;
BEGIN
  BEGIN v_since := (a ->> 'since')::timestamptz; EXCEPTION WHEN OTHERS THEN PERFORM fleet_econ_bad('since is an ISO timestamp'); END;
  RETURN jsonb_build_object('ok', true, 'messages', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('messageId', m.message_id,
           'direction', m.direction, 'mailbox', b.address, 'from', CASE m.direction WHEN 'in' THEN m.sender ELSE b.address END,
           'to', CASE m.direction WHEN 'in' THEN to_jsonb(b.address) ELSE to_jsonb(m.recipients) END, 'subject', m.subject,
           'preview', left(m.body, 1500), 'truncated', length(m.body) > 1500, 'authenticationMessage', m.withheld,
           'consumedByBroker', m.consumed_at IS NOT NULL, 'sendStatus', m.send_status, 'at', m.received_at)) ORDER BY m.received_at DESC)
           FROM (SELECT * FROM fleet_agent_mail WHERE agent_id = p_agent AND (v_since IS NULL OR received_at > v_since) ORDER BY received_at DESC LIMIT v_limit) m
           JOIN fleet_agent_mailboxes b ON b.mailbox_id = m.mailbox_id WHERE v_box IS NULL OR lower(b.address) = v_box), '[]'::jsonb),
    'note', 'Your own business mail, complete. Use mail.read for a whole message and mail.send to reply.');
END $$;

CREATE FUNCTION fleet_econ_mail_read(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE m fleet_agent_mail; b fleet_agent_mailboxes;
BEGIN
  SELECT * INTO m FROM fleet_agent_mail WHERE message_id = fleet_identity_uuid(a, 'messageId') AND agent_id = p_agent;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_MAIL_NONE: no such message of yours'; END IF;
  SELECT * INTO b FROM fleet_agent_mailboxes WHERE mailbox_id = m.mailbox_id;
  RETURN jsonb_build_object('ok', true, 'message', jsonb_strip_nulls(jsonb_build_object('messageId', m.message_id, 'direction', m.direction,
    'mailbox', b.address, 'from', CASE m.direction WHEN 'in' THEN m.sender ELSE b.address END, 'to', CASE m.direction WHEN 'in' THEN to_jsonb(b.address) ELSE to_jsonb(m.recipients) END,
    'subject', m.subject, 'body', m.body, 'inReplyTo', m.in_reply_to, 'sendStatus', m.send_status, 'at', m.received_at,
    'authenticationMessage', m.withheld,
    'note', CASE WHEN m.withheld THEN 'An account authentication message: its link/code is used by the identity broker on your behalf.' END)));
END $$;

CREATE FUNCTION fleet_econ_mail_send(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_from text := lower(fleet_econ_text(a, 'from', 190, true)); b fleet_agent_mailboxes; v_to text[]; v_subject text := fleet_econ_text(a, 'subject', 300, true);
        v_body text := a ->> 'body'; v_reply uuid; v_id uuid := gen_random_uuid(); v_idem text := fleet_econ_text(a, 'idempotencyKey', 128, true); r jsonb; x text;
BEGIN
  IF EXISTS (SELECT 1 FROM fleet_identity_jobs WHERE agent_id = p_agent AND idempotency_key = v_idem) THEN
    RETURN fleet_identity_enqueue(p_agent, NULL, 'mail.send', '{}'::jsonb, v_idem);
  END IF;
  SELECT * INTO b FROM fleet_agent_mailboxes WHERE lower(address) = v_from AND agent_id = p_agent AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_MAIL_MAILBOX: from is one of your active mailboxes'; END IF;
  IF jsonb_typeof(a -> 'to') = 'string' THEN v_to := ARRAY[lower(a ->> 'to')];
  ELSIF jsonb_typeof(a -> 'to') = 'array' THEN SELECT array_agg(lower(e)) INTO v_to FROM jsonb_array_elements_text(a -> 'to') e;
  END IF;
  IF v_to IS NULL OR cardinality(v_to) NOT BETWEEN 1 AND 10 THEN PERFORM fleet_econ_bad('to is 1..10 addresses'); END IF;
  FOREACH x IN ARRAY v_to LOOP
    IF x !~ '^[^@[:space:]<>]{1,64}@[a-z0-9.-]{3,190}$' THEN PERFORM fleet_econ_bad('to holds plain email addresses'); END IF;
  END LOOP;
  IF v_body IS NULL OR length(v_body) NOT BETWEEN 1 AND 100000 THEN PERFORM fleet_econ_bad('body is 1..100000 characters'); END IF;
  IF a ? 'inReplyTo' THEN
    SELECT message_id INTO v_reply FROM fleet_agent_mail WHERE message_id = fleet_identity_uuid(a, 'inReplyTo') AND agent_id = p_agent;
    IF v_reply IS NULL THEN PERFORM fleet_econ_bad('inReplyTo is one of your messages'); END IF;
  END IF;
  -- Infrastructure failsafe (runaway loop / shared-domain reputation), not a budget.
  IF (SELECT count(*) FROM fleet_agent_mail WHERE agent_id = p_agent AND direction = 'out' AND received_at > now() - interval '1 day') >= 500 THEN
    RAISE EXCEPTION 'FLEET_INFRASTRUCTURE_CEILING: an infrastructure failsafe against runaway loops was hit';
  END IF;
  INSERT INTO fleet_agent_mail (message_id, mailbox_id, agent_id, sender, subject, body, direction, recipients, in_reply_to, send_status)
    VALUES (v_id, b.mailbox_id, p_agent, b.address, v_subject, fleet_scrub_mail(v_body), 'out', v_to, v_reply, 'queued');
  r := fleet_identity_enqueue(p_agent, NULL, 'mail.send', jsonb_build_object('messageId', v_id), v_idem);
  RETURN r || jsonb_build_object('messageId', v_id);
END $$;

-- ═══ 2. Phone numbers and SMS ═══
CREATE TABLE fleet_agent_phone_numbers (
  number_id          uuid        PRIMARY KEY,
  agent_id           text        NOT NULL REFERENCES fleet_agents(agent_id),
  venture_id         uuid        REFERENCES fleet_ventures(venture_id),
  country            text        NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  purpose            text        NOT NULL CHECK (length(purpose) BETWEEN 3 AND 200),
  e164               text        CHECK (e164 ~ ${E164}),
  provider           text        CHECK (provider ~ '^[a-z0-9][a-z0-9._-]{1,40}$'),
  provider_ref       text        CHECK (length(provider_ref) <= 120),
  status             text        NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','active','releasing','released','failed','human_action_required')),
  commitment_id      uuid        REFERENCES fleet_agent_commitments(commitment_id),
  status_reason      text        CHECK (length(status_reason) <= 300),
  created_at         timestamptz NOT NULL DEFAULT now(),
  released_at        timestamptz
);
CREATE UNIQUE INDEX fleet_agent_phone_numbers_e164 ON fleet_agent_phone_numbers (e164) WHERE e164 IS NOT NULL AND status IN ('active','releasing');
CREATE TRIGGER fleet_agent_phone_numbers_no_delete BEFORE DELETE ON fleet_agent_phone_numbers FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_agent_sms (
  sms_id               uuid        PRIMARY KEY,
  number_id            uuid        NOT NULL REFERENCES fleet_agent_phone_numbers(number_id),
  agent_id             text        NOT NULL REFERENCES fleet_agents(agent_id),
  direction            text        NOT NULL CHECK (direction IN ('in','out')),
  counterparty         text        NOT NULL CHECK (counterparty ~ ${E164} OR counterparty ~ '^[A-Za-z0-9 ._-]{2,40}$'),
  body                 text        NOT NULL CHECK (length(body) BETWEEN 1 AND 1600),
  withheld             boolean     NOT NULL DEFAULT false,
  provider_message_id  text        CHECK (length(provider_message_id) <= 120),
  send_status          text        CHECK (send_status IN ('queued','sent','failed')),
  at                   timestamptz NOT NULL DEFAULT now(),
  CHECK ((direction = 'out') = (send_status IS NOT NULL))
);
CREATE UNIQUE INDEX fleet_agent_sms_provider_id ON fleet_agent_sms (number_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX fleet_agent_sms_agent ON fleet_agent_sms (agent_id, at DESC);
CREATE TRIGGER fleet_agent_sms_no_delete BEFORE DELETE ON fleet_agent_sms FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

ALTER TABLE fleet_identity_jobs DROP CONSTRAINT fleet_identity_jobs_kind_check;
ALTER TABLE fleet_identity_jobs ADD CONSTRAINT fleet_identity_jobs_kind_check CHECK (kind IN ('mailbox.provision','account.create','account.operate',
  'account.verify_identity','account.recover','credential.rotate','credential.revoke','account.close','credential.rebind',
  'mail.send','phone.provision','phone.release','sms.send'));

CREATE FUNCTION fleet_econ_phone_provision(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_country text := upper(fleet_econ_text(a, 'country', 2, true)); v_purpose text := fleet_econ_text(a, 'purpose', 200, true);
        v_venture text := fleet_econ_venture_ref(p_agent, a); v_id uuid := gen_random_uuid(); v_idem text := fleet_econ_text(a, 'idempotencyKey', 128, true); r jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM fleet_identity_jobs WHERE agent_id = p_agent AND idempotency_key = v_idem) THEN
    RETURN fleet_identity_enqueue(p_agent, NULL, 'phone.provision', '{}'::jsonb, v_idem);
  END IF;
  IF v_country !~ '^[A-Z]{2}$' THEN PERFORM fleet_econ_bad('country is an ISO 3166 alpha-2 code'); END IF;
  INSERT INTO fleet_agent_phone_numbers (number_id, agent_id, venture_id, country, purpose) VALUES (v_id, p_agent, v_venture::uuid, v_country, v_purpose);
  r := fleet_identity_enqueue(p_agent, NULL, 'phone.provision', jsonb_build_object('numberId', v_id, 'country', v_country), v_idem);
  RETURN r || jsonb_build_object('numberId', v_id, 'note', 'the number''s monthly fee becomes your own recurring commitment');
END $$;

CREATE FUNCTION fleet_econ_phone_release(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE n fleet_agent_phone_numbers; v_idem text := fleet_econ_text(a, 'idempotencyKey', 128, true);
BEGIN
  SELECT * INTO n FROM fleet_agent_phone_numbers WHERE number_id = fleet_identity_uuid(a, 'numberId') AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_PHONE_NONE: no such number of yours'; END IF;
  IF n.status NOT IN ('active','human_action_required','failed') THEN
    RETURN fleet_identity_enqueue(p_agent, NULL, 'phone.release', jsonb_build_object('numberId', n.number_id), v_idem);
  END IF;
  UPDATE fleet_agent_phone_numbers SET status = CASE WHEN n.status = 'active' THEN 'releasing' ELSE 'released' END,
         released_at = CASE WHEN n.status = 'active' THEN NULL ELSE now() END WHERE number_id = n.number_id;
  IF n.commitment_id IS NOT NULL THEN
    UPDATE fleet_agent_commitments SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'number released' WHERE commitment_id = n.commitment_id AND status = 'active';
  END IF;
  IF n.status <> 'active' THEN RETURN jsonb_build_object('ok', true, 'status', 'released'); END IF;
  RETURN fleet_identity_enqueue(p_agent, NULL, 'phone.release', jsonb_build_object('numberId', n.number_id), v_idem);
END $$;

CREATE FUNCTION fleet_econ_phone_list(p_agent text, a jsonb) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'numbers', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('numberId', n.number_id, 'e164', n.e164,
      'country', n.country, 'purpose', n.purpose, 'status', n.status, 'reason', n.status_reason, 'commitmentId', n.commitment_id, 'createdAt', n.created_at)) ORDER BY n.created_at)
      FROM fleet_agent_phone_numbers n WHERE n.agent_id = p_agent), '[]'::jsonb))
$$;

CREATE FUNCTION fleet_econ_sms_send(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE n fleet_agent_phone_numbers; v_to text := fleet_econ_text(a, 'to', 16, true); v_body text := fleet_econ_text(a, 'body', 1600, true);
        v_id uuid := gen_random_uuid(); v_idem text := fleet_econ_text(a, 'idempotencyKey', 128, true);
BEGIN
  IF EXISTS (SELECT 1 FROM fleet_identity_jobs WHERE agent_id = p_agent AND idempotency_key = v_idem) THEN
    RETURN fleet_identity_enqueue(p_agent, NULL, 'sms.send', '{}'::jsonb, v_idem);
  END IF;
  SELECT * INTO n FROM fleet_agent_phone_numbers WHERE number_id = fleet_identity_uuid(a, 'numberId') AND agent_id = p_agent AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_PHONE_NONE: numberId is one of your active numbers'; END IF;
  IF v_to !~ ${E164} THEN PERFORM fleet_econ_bad('to is an E.164 number (+447700900123)'); END IF;
  IF (SELECT count(*) FROM fleet_agent_sms WHERE agent_id = p_agent AND direction = 'out' AND at > now() - interval '1 day') >= 200 THEN
    RAISE EXCEPTION 'FLEET_INFRASTRUCTURE_CEILING: an infrastructure failsafe against runaway loops was hit';
  END IF;
  INSERT INTO fleet_agent_sms (sms_id, number_id, agent_id, direction, counterparty, body, send_status) VALUES (v_id, n.number_id, p_agent, 'out', v_to, v_body, 'queued');
  RETURN fleet_identity_enqueue(p_agent, NULL, 'sms.send', jsonb_build_object('smsId', v_id), v_idem) || jsonb_build_object('smsId', v_id);
END $$;

CREATE FUNCTION fleet_econ_sms_inbox(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_number uuid; v_limit integer := COALESCE(fleet_econ_int(a, 'limit', 1, 50), 20)::integer;
BEGIN
  IF a ? 'numberId' THEN v_number := fleet_identity_uuid(a, 'numberId'); END IF;
  RETURN jsonb_build_object('ok', true, 'messages', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('smsId', s.sms_id, 'number', n.e164,
      'direction', s.direction, 'counterparty', s.counterparty, 'body', s.body, 'authenticationMessage', s.withheld, 'sendStatus', s.send_status, 'at', s.at)) ORDER BY s.at DESC)
      FROM (SELECT * FROM fleet_agent_sms WHERE agent_id = p_agent AND (v_number IS NULL OR number_id = v_number) ORDER BY at DESC LIMIT v_limit) s
      JOIN fleet_agent_phone_numbers n ON n.number_id = s.number_id), '[]'::jsonb));
END $$;

-- Broker side.
CREATE FUNCTION ix_phone_record(p_job uuid, p_lease text, p_e164 text, p_provider text, p_provider_ref text, p_monthly_minor bigint, p_currency text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_identity_jobs := ix_leased(p_job, p_lease); n fleet_agent_phone_numbers; v_cur text; v_amount bigint; fx fleet_fx_rates; v_c uuid;
BEGIN
  IF j.kind <> 'phone.provision' OR p_e164 !~ ${E164} THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  SELECT * INTO n FROM fleet_agent_phone_numbers WHERE number_id::text = j.params ->> 'numberId' AND agent_id = j.agent_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  SELECT accounting_currency INTO v_cur FROM fleet_economic_model LIMIT 1;
  IF p_monthly_minor IS NOT NULL AND p_monthly_minor > 0 THEN
    IF upper(p_currency) = v_cur THEN v_amount := p_monthly_minor;
    ELSE fx := fleet_fx_latest(upper(p_currency), v_cur);
      IF fx.rate_micro IS NOT NULL THEN v_amount := GREATEST(1, ceil(p_monthly_minor * fx.rate_micro / 1000000.0))::bigint; END IF;
    END IF;
  END IF;
  IF v_amount IS NOT NULL THEN
    v_c := gen_random_uuid();
    INSERT INTO fleet_agent_commitments (commitment_id, agent_id, venture_id, vendor, description, amount_minor, period, next_due_at, idempotency_key)
      VALUES (v_c, j.agent_id, n.venture_id, p_provider, 'phone number ' || p_e164 || ' (' || n.purpose || ')', v_amount, 'monthly', now() + interval '1 month', 'phone:' || n.number_id);
  END IF;
  UPDATE fleet_agent_phone_numbers SET e164 = p_e164, provider = p_provider, provider_ref = left(p_provider_ref, 120), status = 'active', commitment_id = v_c
   WHERE number_id = n.number_id;
  RETURN jsonb_build_object('ok', true, 'commitmentId', v_c, 'monthlyMinor', v_amount);
END $$;

CREATE FUNCTION ix_phone_status(p_job uuid, p_lease text, p_status text, p_reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_identity_jobs := ix_leased(p_job, p_lease);
BEGIN
  IF j.kind NOT IN ('phone.provision','phone.release') OR p_status NOT IN ('released','failed','human_action_required') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  UPDATE fleet_agent_phone_numbers SET status = p_status, status_reason = left(fleet_scrub(p_reason), 300),
         released_at = CASE WHEN p_status = 'released' THEN now() ELSE released_at END
   WHERE number_id::text = j.params ->> 'numberId' AND agent_id = j.agent_id;
  -- A provider needing an account-holder identity act (e.g. a regulatory bundle) becomes ONE action-scoped dependency for
  -- this number: Admin is notified (IDENTITY); everything else the agent does continues.
  IF p_status = 'human_action_required' THEN
    INSERT INTO fleet_owner_requests (request_id, agent_id, idempotency_key, kind, action, title, detail, blocks_action)
      VALUES (gen_random_uuid(), j.agent_id, 'identity-phone:' || (j.params ->> 'numberId'), 'human_identity',
              left(format('phone number in %s', COALESCE(j.params ->> 'country', '?')), 200), 'Human identity action required for a phone number',
              left('The number provider requires an account-holder identity step. Only this number waits. ' || COALESCE(fleet_scrub(p_reason), ''), 2000), true)
      ON CONFLICT DO NOTHING;
  END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE FUNCTION ix_numbers(p_worker text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('numberId', n.number_id, 'e164', n.e164, 'provider', n.provider,
    'since', COALESCE((SELECT max(s.at) FROM fleet_agent_sms s WHERE s.number_id = n.number_id AND s.direction = 'in'), n.created_at))), '[]'::jsonb)
    FROM fleet_agent_phone_numbers n WHERE n.status IN ('active','releasing') AND n.e164 IS NOT NULL
$$;

CREATE FUNCTION ix_sms_deliver(p_worker text, p_to text, p_from text, p_body text, p_withheld boolean, p_provider_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE n fleet_agent_phone_numbers; v_id uuid := gen_random_uuid(); v_prior uuid;
BEGIN
  SELECT * INTO n FROM fleet_agent_phone_numbers WHERE e164 = p_to AND status IN ('active','releasing');
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  SELECT sms_id INTO v_prior FROM fleet_agent_sms WHERE number_id = n.number_id AND provider_message_id = p_provider_id;
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'smsId', v_prior); END IF;
  INSERT INTO fleet_agent_sms (sms_id, number_id, agent_id, direction, counterparty, body, withheld, provider_message_id)
    VALUES (v_id, n.number_id, n.agent_id, 'in', left(p_from, 40), left(fleet_scrub_mail(p_body), 1600), COALESCE(p_withheld, false), left(p_provider_id, 120));
  RETURN jsonb_build_object('ok', true, 'smsId', v_id);
END $$;

CREATE FUNCTION ix_sms_sent(p_job uuid, p_lease text, p_provider_id text, p_ok boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_identity_jobs := ix_leased(p_job, p_lease);
BEGIN
  IF j.kind <> 'sms.send' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  UPDATE fleet_agent_sms SET send_status = CASE WHEN p_ok THEN 'sent' ELSE 'failed' END, provider_message_id = left(p_provider_id, 120)
   WHERE sms_id::text = j.params ->> 'smsId' AND agent_id = j.agent_id AND direction = 'out';
  RETURN jsonb_build_object('ok', true);
END $$;

${JOB_CONTEXT}

-- ═══ 3. Owner identity classes: passports and driving licences as their own classes ═══
ALTER TABLE fleet_owner_identity_classes DROP CONSTRAINT fleet_owner_identity_classes_class_key_check;
ALTER TABLE fleet_owner_identity_classes ADD CONSTRAINT fleet_owner_identity_classes_class_key_check CHECK (class_key IN (${OWNER_CLASSES}));
ALTER TABLE fleet_owner_identity_consent DROP CONSTRAINT fleet_owner_identity_consent_classes_check;
ALTER TABLE fleet_owner_identity_consent ADD CONSTRAINT fleet_owner_identity_consent_classes_check CHECK (cardinality(classes) BETWEEN 1 AND 12 AND classes <@ ARRAY[${OWNER_CLASSES}]::text[]);
ALTER TABLE fleet_identity_releases DROP CONSTRAINT fleet_identity_releases_classes_check;
ALTER TABLE fleet_identity_releases ADD CONSTRAINT fleet_identity_releases_classes_check CHECK (classes <@ ARRAY[${OWNER_CLASSES}]::text[]);

-- ═══ 4. Owner vault upload (sealed at the dashboard; installed by the broker; erased from the database on install) ═══
CREATE TABLE fleet_owner_vault_inbox (
  upload_id     uuid        PRIMARY KEY,
  class_key     text        NOT NULL CHECK (class_key IN (${OWNER_CLASSES})),
  sealed        bytea       CHECK (octet_length(sealed) BETWEEN 32 AND 16000000),
  content_type  text        NOT NULL CHECK (content_type IN ('text/plain','application/pdf','image/jpeg','image/png','image/webp')),
  expires_at    timestamptz,
  status        text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','installed','failed')),
  error         text        CHECK (length(error) <= 200),
  uploaded_by   text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  installed_at  timestamptz,
  CHECK ((status = 'pending') = (sealed IS NOT NULL))
);
CREATE TRIGGER fleet_owner_vault_inbox_no_delete BEFORE DELETE ON fleet_owner_vault_inbox FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_admin_owner_vault_upload(p_class text, p_sealed bytea, p_content_type text, p_expires timestamptz, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_owner_identity');
  IF p_sealed IS NULL OR substring(p_sealed FROM 1 FOR 4) <> '\\x46534231'::bytea THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the upload must be sealed to the broker key (FSB1)'; END IF;
  INSERT INTO fleet_owner_vault_inbox (upload_id, class_key, sealed, content_type, expires_at, uploaded_by) VALUES (v_id, p_class, p_sealed, p_content_type, p_expires, p_actor);
  PERFORM fleet_event('owner_identity_uploaded', NULL, p_actor, jsonb_build_object('uploadId', v_id, 'class', p_class, 'contentType', p_content_type, 'bytes', octet_length(p_sealed)));
  RETURN jsonb_build_object('ok', true, 'uploadId', v_id, 'status', 'pending', 'next', 'the identity broker installs it into the sealed owner vault');
END $$;

CREATE FUNCTION ix_vault_inbox(p_worker text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('uploadId', upload_id, 'class', class_key, 'sealedB64', encode(sealed, 'base64'), 'contentType', content_type,
    'expiresAt', expires_at) ORDER BY created_at), '[]'::jsonb) FROM fleet_owner_vault_inbox WHERE status = 'pending'
$$;

CREATE FUNCTION ix_vault_installed(p_upload uuid, p_worker text, p_ok boolean, p_error text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE u fleet_owner_vault_inbox;
BEGIN
  SELECT * INTO u FROM fleet_owner_vault_inbox WHERE upload_id = p_upload AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  UPDATE fleet_owner_vault_inbox SET sealed = NULL, status = CASE WHEN p_ok THEN 'installed' ELSE 'failed' END, error = left(p_error, 200), installed_at = now()
   WHERE upload_id = p_upload;
  IF p_ok THEN
    INSERT INTO fleet_owner_identity_classes (class_key, vault_ref, expires_at, status, updated_by) VALUES (u.class_key, 'ovault:' || u.class_key, u.expires_at, 'configured', u.uploaded_by)
      ON CONFLICT (class_key) DO UPDATE SET vault_ref = EXCLUDED.vault_ref, expires_at = EXCLUDED.expires_at, status = 'configured', updated_by = EXCLUDED.updated_by, updated_at = now();
  END IF;
  PERFORM fleet_event('owner_identity_installed', NULL, 'identity-broker', jsonb_build_object('uploadId', p_upload, 'class', u.class_key, 'ok', p_ok));
  RETURN jsonb_build_object('ok', true);
END $$;

-- The broker publishes its owner-vault PUBLIC key (not secret) so uploads can be sealed to it; Admin pins its fingerprint.
CREATE TABLE fleet_identity_broker_keys (
  id            smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  owner_pub     text        NOT NULL CHECK (owner_pub ~ '^[A-Za-z0-9+/=]{40,120}$'),
  fingerprint   text        NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  published_at  timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION ix_publish_owner_key(p_worker text, p_pub text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_fp text := encode(sha256(decode(p_pub, 'base64')), 'hex'); v_prev text;
BEGIN
  SELECT fingerprint INTO v_prev FROM fleet_identity_broker_keys WHERE id = 1;
  IF v_prev IS NOT DISTINCT FROM v_fp THEN RETURN jsonb_build_object('ok', true, 'fingerprint', v_fp, 'changed', false); END IF;
  INSERT INTO fleet_identity_broker_keys (id, owner_pub, fingerprint) VALUES (1, p_pub, v_fp)
    ON CONFLICT (id) DO UPDATE SET owner_pub = EXCLUDED.owner_pub, fingerprint = EXCLUDED.fingerprint, published_at = now();
  PERFORM fleet_event('identity_broker_key_published', NULL, 'identity-broker', jsonb_build_object('fingerprint', v_fp, 'previous', v_prev));
  IF v_prev IS NOT NULL THEN
    PERFORM fleet_notify('RED', 'BROKER_KEY_CHANGED', NULL, 'The identity broker''s owner-vault key changed: verify before uploading',
      jsonb_build_object('fingerprint', v_fp, 'previous', v_prev), 'broker-key:' || v_fp);
  END IF;
  RETURN jsonb_build_object('ok', true, 'fingerprint', v_fp, 'changed', true);
END $$;
CREATE FUNCTION fleet_admin_broker_owner_key() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE((SELECT jsonb_build_object('ownerPub', owner_pub, 'fingerprint', fingerprint, 'publishedAt', published_at) FROM fleet_identity_broker_keys WHERE id = 1),
                  jsonb_build_object('ownerPub', NULL))
$$;

-- ═══ 5. Admin reveal (sealed to the Admin session's ephemeral key; taken once; permanently logged) ═══
CREATE TABLE fleet_reveal_requests (
  request_id     uuid        PRIMARY KEY,
  kind           text        NOT NULL CHECK (kind IN ('agent_credential','owner_identity')),
  credential_id  uuid        REFERENCES fleet_agent_account_credentials(credential_id),
  class_key      text        CHECK (class_key IN (${OWNER_CLASSES})),
  ephemeral_pub  text        NOT NULL CHECK (ephemeral_pub ~ '^[A-Za-z0-9+/=]{40,120}$'),
  stepup_ref     text        NOT NULL CHECK (stepup_ref ~ '^[A-Za-z0-9:_.-]{8,128}$'),
  requested_by   text        NOT NULL,
  status         text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','served','delivered','failed','expired')),
  sealed         bytea       CHECK (octet_length(sealed) <= 16000100),
  error          text        CHECK (length(error) <= 200),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL DEFAULT now() + interval '2 minutes',
  served_at      timestamptz,
  delivered_at   timestamptz,
  CHECK ((kind = 'agent_credential') = (credential_id IS NOT NULL)),
  CHECK ((kind = 'owner_identity') = (class_key IS NOT NULL)),
  CHECK (sealed IS NULL OR status = 'served')
);
CREATE TRIGGER fleet_reveal_requests_no_delete BEFORE DELETE ON fleet_reveal_requests FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_reveal_log (
  seq          bigserial   PRIMARY KEY,
  request_id   uuid        NOT NULL,
  kind         text        NOT NULL,
  target       text        NOT NULL,
  agent_id     text,
  actor        text        NOT NULL,
  outcome      text        NOT NULL CHECK (outcome IN ('requested','served','delivered','failed','expired')),
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_reveal_log_no_change BEFORE UPDATE OR DELETE ON fleet_reveal_log FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_reveal_log_no_truncate BEFORE TRUNCATE ON fleet_reveal_log FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_reveal_log_write(r fleet_reveal_requests, p_actor text, p_outcome text) RETURNS void LANGUAGE sql
SET search_path = @@SCHEMA@@, pg_temp AS $$
  INSERT INTO fleet_reveal_log (request_id, kind, target, agent_id, actor, outcome)
    VALUES (r.request_id, r.kind, COALESCE(r.credential_id::text, r.class_key),
            (SELECT agent_id FROM fleet_agent_account_credentials WHERE credential_id = r.credential_id), p_actor, p_outcome)
$$;

CREATE FUNCTION fleet_admin_reveal_request(p_kind text, p_target text, p_ephemeral_pub text, p_stepup_ref text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_reveal_requests;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_reveal');
  IF p_kind = 'agent_credential' THEN
    IF p_target !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR NOT EXISTS (SELECT 1 FROM fleet_agent_account_credentials WHERE credential_id = p_target::uuid) THEN
      RAISE EXCEPTION 'FLEET_NOT_FOUND: no such credential';
    END IF;
    INSERT INTO fleet_reveal_requests (request_id, kind, credential_id, ephemeral_pub, stepup_ref, requested_by)
      VALUES (gen_random_uuid(), p_kind, p_target::uuid, p_ephemeral_pub, p_stepup_ref, p_actor) RETURNING * INTO r;
  ELSIF p_kind = 'owner_identity' THEN
    IF NOT EXISTS (SELECT 1 FROM fleet_owner_identity_classes WHERE class_key = p_target AND status = 'configured') THEN
      RAISE EXCEPTION 'FLEET_NOT_FOUND: that owner identity class is not in the vault';
    END IF;
    INSERT INTO fleet_reveal_requests (request_id, kind, class_key, ephemeral_pub, stepup_ref, requested_by)
      VALUES (gen_random_uuid(), p_kind, p_target, p_ephemeral_pub, p_stepup_ref, p_actor) RETURNING * INTO r;
  ELSE
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: kind is agent_credential or owner_identity';
  END IF;
  PERFORM fleet_reveal_log_write(r, p_actor, 'requested');
  RETURN jsonb_build_object('ok', true, 'requestId', r.request_id, 'expiresAt', r.expires_at);
END $$;

-- The Admin session takes the sealed reveal ONCE; the stored copy is erased.
CREATE FUNCTION fleet_admin_reveal_take(p_request uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_reveal_requests; v bytea;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_reveal');
  SELECT * INTO r FROM fleet_reveal_requests WHERE request_id = p_request FOR UPDATE;
  IF NOT FOUND OR r.requested_by <> p_actor THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such reveal of yours'; END IF;
  IF r.status = 'pending' AND r.expires_at > now() THEN RETURN jsonb_build_object('ok', true, 'status', 'pending'); END IF;
  IF r.status IN ('pending','served') AND r.expires_at <= now() THEN
    UPDATE fleet_reveal_requests SET status = 'expired', sealed = NULL WHERE request_id = p_request;
    PERFORM fleet_reveal_log_write(r, p_actor, 'expired');
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_REVEAL_EXPIRED');
  END IF;
  IF r.status <> 'served' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_REVEAL_' || upper(r.status), 'error', r.error); END IF;
  v := r.sealed;
  UPDATE fleet_reveal_requests SET status = 'delivered', sealed = NULL, delivered_at = now() WHERE request_id = p_request;
  PERFORM fleet_reveal_log_write(r, p_actor, 'delivered');
  RETURN jsonb_build_object('ok', true, 'status', 'delivered', 'sealedB64', encode(v, 'base64'));
END $$;

CREATE FUNCTION ix_reveal_pending(p_worker text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x record;
BEGIN
  FOR x IN SELECT * FROM fleet_reveal_requests WHERE status IN ('pending','served') AND expires_at <= now() FOR UPDATE LOOP
    UPDATE fleet_reveal_requests SET status = 'expired', sealed = NULL WHERE request_id = x.request_id;
    PERFORM fleet_reveal_log_write(x::fleet_reveal_requests, 'identity-broker', 'expired');
  END LOOP;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('requestId', r.request_id, 'kind', r.kind, 'ephemeralPub', r.ephemeral_pub,
      'class', r.class_key, 'vaultRef', c.vault_ref, 'agentId', c.agent_id, 'accountId', c.account_id, 'credentialKind', c.kind)) ORDER BY r.created_at)
    FROM fleet_reveal_requests r LEFT JOIN fleet_agent_account_credentials c ON c.credential_id = r.credential_id
   WHERE r.status = 'pending' AND r.expires_at > now()), '[]'::jsonb);
END $$;

CREATE FUNCTION ix_reveal_serve(p_request uuid, p_worker text, p_sealed bytea, p_error text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_reveal_requests;
BEGIN
  SELECT * INTO r FROM fleet_reveal_requests WHERE request_id = p_request AND status = 'pending' AND expires_at > now() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF p_sealed IS NOT NULL THEN
    UPDATE fleet_reveal_requests SET status = 'served', sealed = p_sealed, served_at = now() WHERE request_id = p_request;
    PERFORM fleet_reveal_log_write(r, 'identity-broker', 'served');
  ELSE
    UPDATE fleet_reveal_requests SET status = 'failed', error = left(p_error, 200), served_at = now() WHERE request_id = p_request;
    PERFORM fleet_reveal_log_write(r, 'identity-broker', 'failed');
  END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE FUNCTION fleet_admin_reveal_log(p_limit integer) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.seq DESC), '[]'::jsonb) FROM (SELECT * FROM fleet_reveal_log ORDER BY seq DESC LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 1000))) l
$$;

-- ═══ 6. Notification email (sent by the broker, which holds the mail provider credential) ═══
CREATE FUNCTION ix_notifications_unsent(p_worker text, p_limit integer) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('to', p.admin_email, 'notifications', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', n.notification_id, 'class', n.class,
      'code', n.code, 'agentId', n.agent_id, 'title', n.title, 'detail', n.detail, 'at', n.created_at) ORDER BY n.created_at)
    FROM (SELECT * FROM fleet_notifications WHERE emailed_at IS NULL AND email_attempts < 5 AND class = ANY (p.email_classes)
           ORDER BY created_at LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100))) n), '[]'::jsonb))
    FROM fleet_notification_policy p WHERE p.id = 1 AND p.admin_email IS NOT NULL
$$;

CREATE FUNCTION ix_notification_emailed(p_id uuid, p_worker text, p_ok boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  UPDATE fleet_notifications SET emailed_at = CASE WHEN p_ok THEN now() END, email_attempts = email_attempts + 1 WHERE notification_id = p_id AND emailed_at IS NULL;
  RETURN jsonb_build_object('ok', FOUND);
END $$;

${DISPATCH}

-- Hub: communication and reveal views (metadata; values only through a reveal).
CREATE FUNCTION fleet_hub_comms(p_agent text) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'mailboxes', COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId', b.agent_id, 'address', b.address, 'status', b.status,
        'in', (SELECT count(*) FROM fleet_agent_mail m WHERE m.mailbox_id = b.mailbox_id AND m.direction = 'in'),
        'out', (SELECT count(*) FROM fleet_agent_mail m WHERE m.mailbox_id = b.mailbox_id AND m.direction = 'out')) ORDER BY b.created_at)
      FROM fleet_agent_mailboxes b WHERE p_agent IS NULL OR b.agent_id = p_agent), '[]'::jsonb),
    'numbers', COALESCE((SELECT jsonb_agg(to_jsonb(n) ORDER BY n.created_at) FROM fleet_agent_phone_numbers n WHERE p_agent IS NULL OR n.agent_id = p_agent), '[]'::jsonb),
    'credentials', COALESCE((SELECT jsonb_agg(jsonb_build_object('credentialId', c.credential_id, 'agentId', c.agent_id, 'accountId', c.account_id,
        'platform', x.platform, 'handle', x.handle, 'kind', c.kind, 'status', c.status, 'createdAt', c.created_at) ORDER BY c.created_at)
      FROM fleet_agent_account_credentials c JOIN fleet_agent_accounts x ON x.account_id = c.account_id
     WHERE c.status = 'active' AND (p_agent IS NULL OR c.agent_id = p_agent)), '[]'::jsonb),
    'ownerVault', COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.class_key) FROM fleet_owner_identity_classes o), '[]'::jsonb),
    'uploads', COALESCE((SELECT jsonb_agg(to_jsonb(u) - 'sealed' ORDER BY u.created_at DESC) FROM (SELECT * FROM fleet_owner_vault_inbox ORDER BY created_at DESC LIMIT 50) u), '[]'::jsonb),
    'reveals', fleet_admin_reveal_log(50))
$$;
`;
