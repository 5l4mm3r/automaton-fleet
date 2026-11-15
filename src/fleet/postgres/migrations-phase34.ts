/**
 * Schema v34 — agent-owned operational identity + secure owner identity broker. Real payments stay off.
 *
 * Three identity layers, never conflated:
 *  A. FLEET CORE IDENTITY (fleet_agents; unchanged, authoritative).
 *  B. AGENT OPERATIONAL IDENTITY — owned by the agent and created autonomously (no owner step): personas, brands and
 *     venture identities (fleet_agent_identities); platform accounts — email, domain, website, marketplace, storefront,
 *     social, service, API (fleet_agent_accounts); credential REFERENCES (fleet_agent_account_credentials — the secrets
 *     live encrypted in the identity broker's vault, never here, never in cognition); mailboxes and sanitised mail.
 *     Account work that needs a credential or a provider runs as a job (fleet_identity_jobs) executed by the isolated
 *     identity broker (own OS user, own DB role fleet_identity, ix_* only) — the custody executor's pattern.
 *  C. OWNER IDENTITY — optional, voluntarily supplied real-world facts/documents in the OWNER IDENTITY VAULT (sealed to
 *     the broker's key; never in this database, never in an agent's context). The database holds only class metadata,
 *     the owner's STANDING CONSENT and an append-only release log (classes released, never values).
 *
 * Agents receive statuses only (VERIFIED / PENDING / REJECTED / HUMAN_ACTION_REQUIRED). A provider that genuinely needs a
 * non-delegable human act (liveness, biometrics, fresh signature …) or an identity the owner has not provided/consented
 * becomes ONE action-scoped dependency for that account; nothing else waits. Duplicate/ambiguous mappings fail closed.
 *
 * v11 organisation identity facts released RAW values to agents, claim by claim. That release is retired
 * (production held no fact and no claim): owner identity now goes through the broker only.
 */

import { V30_SQL } from "./migrations-phase30.js";

function v30Function(name: string, edits: Array<[string, string]>): string {
  const start = V30_SQL.lastIndexOf(`FUNCTION ${name}(`);
  const head = V30_SQL.lastIndexOf("CREATE", start);
  const end = V30_SQL.indexOf("END $$;", start);
  if (start < 0 || end < 0) throw new Error(`v34: v30 function ${name} not found`);
  let body = "CREATE OR REPLACE " + V30_SQL.slice(V30_SQL.indexOf("FUNCTION", head), end + "END $$;".length);
  for (const [from, to] of edits) {
    if (!body.includes(from)) throw new Error(`v34: expected text not found in ${name}`);
    body = body.replace(from, to);
  }
  return body;
}

export const IDENTITY_OPS = [
  "identity.create", "identity.update", "identity.list",
  "account.create", "account.operate", "account.status", "account.verify_identity", "account.recover", "account.rotate", "account.revoke",
  "account.close", "mailbox.provision", "mail.inbox",
] as const;

const DISPATCH = v30Function("api_economy", [
  [`    WHEN 'brief' THEN 'ledger.read'
  END;`,
   `    WHEN 'brief' THEN 'ledger.read'
    -- v34: the agent's own operational identity (planning: an ordinary autonomous action, no owner step).
    ${IDENTITY_OPS.map((o) => `WHEN '${o}' THEN 'planning'`).join(" ")}
  END;`],
  [`      WHEN 'brief' THEN jsonb_build_object('ok', true, 'brief', fleet_economy_brief(p_agent))`,
   `      WHEN 'brief' THEN jsonb_build_object('ok', true, 'brief', fleet_economy_brief(p_agent))
      ${IDENTITY_OPS.map((o) => `WHEN '${o}' THEN fleet_econ_${o.replace(".", "_")}(p_agent, a)`).join("\n      ")}`],
  ["      IF SQLERRM ~ '^FLEET_(BAD_REQUEST|INFRASTRUCTURE_CEILING|VENTURE_[A-Z]+|IMMUTABLE|INVALID_STATE|ATTRIBUTION_SCOPE):' THEN",
   "      IF SQLERRM ~ '^FLEET_(BAD_REQUEST|INFRASTRUCTURE_CEILING|VENTURE_[A-Z]+|IMMUTABLE|INVALID_STATE|ATTRIBUTION_SCOPE|NOT_FOUND|IDENTITY_[A-Z]+|CREDENTIAL_[A-Z]+):' THEN"],
  [`    WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN`,
   `    WHEN unique_violation THEN
      -- v34: a concurrent claim on the same platform handle / persona name: ambiguous mapping fails closed, as data.
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_IDENTITY_TAKEN', 'reason', 'that name or handle is already mapped');
    WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN`],
]);

const PLATFORM = `'^[a-z0-9][a-z0-9._-]{1,40}$'`;
const ACCOUNT_KINDS = "'email','domain','website','marketplace','storefront','social','service','api','payment_profile','other'";
const OWNER_CLASSES = "'legal_name','date_of_birth','residential_address','contact_email','contact_phone','id_document','proof_of_address','tax_identifier','bank_account_owner','other_fact'";
const PURPOSES = "'account_verification','seller_verification','payment_profile','domain_registration','other_legitimate'";
const JOB_KINDS = "'mailbox.provision','account.create','account.operate','account.verify_identity','account.recover','credential.rotate','credential.revoke','account.close'";

export const V34_SQL = `
-- ═══ 1. Agent operational identities ═══
CREATE TABLE fleet_agent_identities (
  identity_id   uuid        PRIMARY KEY,
  agent_id      text        NOT NULL REFERENCES fleet_agents(agent_id),
  venture_id    uuid        REFERENCES fleet_ventures(venture_id),
  kind          text        NOT NULL CHECK (kind IN ('persona','brand','venture_identity')),
  display_name  text        NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  handle        text        CHECK (handle ~ '^[A-Za-z0-9._-]{2,40}$'),
  bio           text        CHECK (length(bio) <= 500),
  status        text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX fleet_agent_identities_name ON fleet_agent_identities (agent_id, kind, lower(display_name));
CREATE TRIGGER fleet_agent_identities_no_delete BEFORE DELETE ON fleet_agent_identities FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_agent_identities_no_truncate BEFORE TRUNCATE ON fleet_agent_identities FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE FUNCTION fleet_agent_identities_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.identity_id <> OLD.identity_id OR NEW.agent_id <> OLD.agent_id OR NEW.kind <> OLD.kind OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: an identity''s owner and kind are fixed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_agent_identities_guard BEFORE UPDATE ON fleet_agent_identities FOR EACH ROW EXECUTE FUNCTION fleet_agent_identities_guard();

CREATE TABLE fleet_agent_accounts (
  account_id          uuid        PRIMARY KEY,
  agent_id            text        NOT NULL REFERENCES fleet_agents(agent_id),
  identity_id         uuid        REFERENCES fleet_agent_identities(identity_id),
  venture_id          uuid        REFERENCES fleet_ventures(venture_id),
  account_kind        text        NOT NULL CHECK (account_kind IN (${ACCOUNT_KINDS})),
  platform            text        NOT NULL CHECK (platform ~ ${PLATFORM}),
  handle              text        CHECK (handle ~ '^[A-Za-z0-9._@+-]{1,120}$'),
  provider_account_ref text       CHECK (length(provider_account_ref) <= 200),
  status              text        NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','creating','pending_verification','active',
                                    'human_action_required','suspended','banned','closed','failed')),
  verification        text        NOT NULL DEFAULT 'none' CHECK (verification IN ('none','email_pending','email_verified','identity_pending',
                                    'identity_verified','identity_rejected')),
  credential_health   text        NOT NULL DEFAULT 'none' CHECK (credential_health IN ('none','ok','rotating','revoked','compromised')),
  reputation          jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(reputation) = 'object' AND length(reputation::text) <= 2000),
  status_reason       text        CHECK (length(status_reason) <= 300),
  dependency_id       uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz
);
-- One platform handle maps to exactly one account (and so one agent): an ambiguous mapping fails closed.
CREATE UNIQUE INDEX fleet_agent_accounts_platform_handle ON fleet_agent_accounts (platform, lower(handle)) WHERE handle IS NOT NULL;
CREATE INDEX fleet_agent_accounts_agent ON fleet_agent_accounts (agent_id, status);
CREATE TRIGGER fleet_agent_accounts_no_delete BEFORE DELETE ON fleet_agent_accounts FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_agent_accounts_no_truncate BEFORE TRUNCATE ON fleet_agent_accounts FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE FUNCTION fleet_agent_accounts_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.account_id <> OLD.account_id OR NEW.agent_id <> OLD.agent_id OR NEW.platform <> OLD.platform
       OR NEW.account_kind <> OLD.account_kind OR NEW.created_at <> OLD.created_at
       OR (OLD.handle IS NOT NULL AND NEW.handle IS DISTINCT FROM OLD.handle)) THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: an account''s owner, platform, kind and handle are fixed';
  END IF;
  -- Scope: the identity and the venture belong to the same agent as the account.
  IF NEW.identity_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fleet_agent_identities WHERE identity_id = NEW.identity_id AND agent_id = NEW.agent_id) THEN
    RAISE EXCEPTION 'FLEET_IDENTITY_SCOPE: the identity belongs to another agent';
  END IF;
  IF NEW.venture_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fleet_ventures WHERE venture_id = NEW.venture_id AND agent_id = NEW.agent_id) THEN
    RAISE EXCEPTION 'FLEET_IDENTITY_SCOPE: the venture belongs to another agent';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_agent_accounts_guard BEFORE INSERT OR UPDATE ON fleet_agent_accounts FOR EACH ROW EXECUTE FUNCTION fleet_agent_accounts_guard();

-- Credential REFERENCES only: the secret is an encrypted blob in the identity broker's vault (agent + account bound).
CREATE TABLE fleet_agent_account_credentials (
  credential_id uuid        PRIMARY KEY,
  account_id    uuid        NOT NULL REFERENCES fleet_agent_accounts(account_id),
  agent_id      text        NOT NULL REFERENCES fleet_agents(agent_id),
  kind          text        NOT NULL CHECK (kind IN ('password','api_key','oauth_token','session','recovery_codes','totp','other')),
  vault_ref     text        NOT NULL UNIQUE CHECK (vault_ref ~ '^avault:[0-9a-f-]{36}$'),
  status        text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','rotated','revoked','compromised')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  retired_at    timestamptz
);
CREATE TRIGGER fleet_agent_account_credentials_no_delete BEFORE DELETE ON fleet_agent_account_credentials FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_agent_account_credentials_no_truncate BEFORE TRUNCATE ON fleet_agent_account_credentials FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_agent_mailboxes (
  mailbox_id  uuid        PRIMARY KEY,
  agent_id    text        NOT NULL REFERENCES fleet_agents(agent_id),
  account_id  uuid        NOT NULL UNIQUE REFERENCES fleet_agent_accounts(account_id),
  address     text        NOT NULL CHECK (address ~ '^[a-z0-9._+-]{1,64}@[a-z0-9.-]{3,120}$'),
  provider    text        NOT NULL CHECK (provider ~ ${PLATFORM}),
  status      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX fleet_agent_mailboxes_address ON fleet_agent_mailboxes (lower(address));
CREATE TRIGGER fleet_agent_mailboxes_no_delete BEFORE DELETE ON fleet_agent_mailboxes FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- Sanitised mail: verification links and codes are consumed by the broker and redacted before storage.
CREATE TABLE fleet_agent_mail (
  message_id    uuid        PRIMARY KEY,
  mailbox_id    uuid        NOT NULL REFERENCES fleet_agent_mailboxes(mailbox_id),
  agent_id      text        NOT NULL REFERENCES fleet_agents(agent_id),
  sender        text        NOT NULL CHECK (length(sender) BETWEEN 1 AND 200),
  subject       text        NOT NULL CHECK (length(subject) <= 300),
  body          text        NOT NULL CHECK (length(body) <= 4000),
  verification  boolean     NOT NULL DEFAULT false,
  consumed_at   timestamptz,
  received_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_agent_mail_box ON fleet_agent_mail (mailbox_id, received_at DESC);

-- ═══ 2. Identity jobs (controller -> identity broker protocol) ═══
CREATE TABLE fleet_identity_jobs (
  job_id          uuid        PRIMARY KEY,
  agent_id        text        NOT NULL REFERENCES fleet_agents(agent_id),
  account_id      uuid        REFERENCES fleet_agent_accounts(account_id),
  kind            text        NOT NULL CHECK (kind IN (${JOB_KINDS})),
  params          jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params) = 'object' AND length(params::text) <= 4000),
  idempotency_key text        NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_.-]{8,128}$'),
  status          text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','claimed','pending','succeeded','failed','human_action_required')),
  result          jsonb       CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND length(result::text) <= 4000)),
  claimed_by      text,
  claimed_at      timestamptz,
  lease_sha256    text        CHECK (lease_sha256 ~ '^[0-9a-f]{64}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  UNIQUE (agent_id, idempotency_key)
);
CREATE INDEX fleet_identity_jobs_queue ON fleet_identity_jobs (status, created_at);
CREATE TRIGGER fleet_identity_jobs_no_delete BEFORE DELETE ON fleet_identity_jobs FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_identity_jobs_no_truncate BEFORE TRUNCATE ON fleet_identity_jobs FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ═══ 3. Owner identity: metadata, standing consent, release log (values live only in the sealed owner vault) ═══
CREATE TABLE fleet_owner_identity_classes (
  class_key   text        PRIMARY KEY CHECK (class_key IN (${OWNER_CLASSES})),
  vault_ref   text        NOT NULL CHECK (vault_ref ~ '^ovault:[a-z_]{3,30}$'),
  expires_at  timestamptz,
  status      text        NOT NULL DEFAULT 'configured' CHECK (status IN ('configured','removed')),
  updated_by  text        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE fleet_owner_identity_consent (
  consent_id  uuid        PRIMARY KEY,
  purposes    text[]      NOT NULL CHECK (cardinality(purposes) BETWEEN 1 AND 5 AND purposes <@ ARRAY[${PURPOSES}]::text[]),
  providers   text[]      CHECK (providers IS NULL OR (cardinality(providers) BETWEEN 1 AND 50)),
  classes     text[]      NOT NULL CHECK (cardinality(classes) BETWEEN 1 AND 10 AND classes <@ ARRAY[${OWNER_CLASSES}]::text[]),
  statement   text        NOT NULL CHECK (length(statement) BETWEEN 10 AND 500),
  created_by  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_by  text,
  revoked_at  timestamptz,
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE TRIGGER fleet_owner_identity_consent_no_delete BEFORE DELETE ON fleet_owner_identity_consent FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TABLE fleet_identity_releases (
  release_id  uuid        PRIMARY KEY,
  job_id      uuid        NOT NULL REFERENCES fleet_identity_jobs(job_id),
  agent_id    text        NOT NULL REFERENCES fleet_agents(agent_id),
  account_id  uuid        REFERENCES fleet_agent_accounts(account_id),
  venture_id  uuid        REFERENCES fleet_ventures(venture_id),
  provider    text        NOT NULL CHECK (provider ~ ${PLATFORM}),
  purpose     text        NOT NULL CHECK (purpose IN (${PURPOSES})),
  classes     text[]      NOT NULL CHECK (classes <@ ARRAY[${OWNER_CLASSES}]::text[]),
  consent_id  uuid        REFERENCES fleet_owner_identity_consent(consent_id),
  outcome     text        NOT NULL CHECK (outcome IN ('verified','pending','rejected','human_action_required','no_consent','failed')),
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_identity_releases_no_change BEFORE UPDATE OR DELETE ON fleet_identity_releases FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_identity_releases_no_truncate BEFORE TRUNCATE ON fleet_identity_releases FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ═══ 4. Agent operations (economy dispatcher; capability 'planning'; no owner step) ═══
CREATE FUNCTION fleet_identity_uuid(a jsonb, k text) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (a ? k) OR (a ->> k) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN PERFORM fleet_econ_bad(k || ' must be an id'); END IF;
  RETURN (a ->> k)::uuid;
END $$;

CREATE FUNCTION fleet_identity_account_json(x fleet_agent_accounts) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('accountId', x.account_id, 'identityId', x.identity_id,
    'venture', (SELECT venture_key FROM fleet_ventures WHERE venture_id = x.venture_id), 'kind', x.account_kind, 'platform', x.platform,
    'handle', x.handle, 'status', x.status, 'verification', x.verification, 'credentialHealth', x.credential_health,
    'reputation', x.reputation, 'reason', x.status_reason, 'createdAt', x.created_at,
    'mailbox', (SELECT address FROM fleet_agent_mailboxes WHERE account_id = x.account_id),
    'lastJob', (SELECT jsonb_build_object('jobId', j.job_id, 'kind', j.kind, 'status', j.status, 'result', j.result)
                  FROM fleet_identity_jobs j WHERE j.account_id = x.account_id ORDER BY j.created_at DESC LIMIT 1)))
$$;

CREATE FUNCTION fleet_identity_enqueue(p_agent text, p_account uuid, p_kind text, p_params jsonb, p_idem text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_identity_jobs;
BEGIN
  SELECT * INTO j FROM fleet_identity_jobs WHERE agent_id = p_agent AND idempotency_key = p_idem;
  IF FOUND THEN
    IF j.kind <> p_kind OR j.account_id IS DISTINCT FROM p_account THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_IDEMPOTENCY_CONFLICT'); END IF;
    RETURN jsonb_build_object('ok', true, 'replay', true, 'jobId', j.job_id, 'status', j.status);
  END IF;
  IF (SELECT count(*) FROM fleet_identity_jobs WHERE agent_id = p_agent AND created_at > now() - interval '1 day')
     >= (SELECT failsafe_records_per_day FROM fleet_economy_policy WHERE id = 1) THEN
    RAISE EXCEPTION 'FLEET_INFRASTRUCTURE_CEILING: an infrastructure failsafe against runaway loops was hit';
  END IF;
  INSERT INTO fleet_identity_jobs (job_id, agent_id, account_id, kind, params, idempotency_key)
    VALUES (gen_random_uuid(), p_agent, p_account, p_kind, COALESCE(p_params, '{}'::jsonb), p_idem) RETURNING * INTO j;
  PERFORM fleet_event('identity_job_queued', p_agent, p_agent, jsonb_build_object('jobId', j.job_id, 'kind', p_kind, 'accountId', p_account));
  RETURN jsonb_build_object('ok', true, 'jobId', j.job_id, 'status', 'queued');
END $$;

CREATE FUNCTION fleet_identity_idem(a jsonb) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE(a ->> 'idempotencyKey', '') !~ '^[A-Za-z0-9:_.-]{8,128}$' THEN PERFORM fleet_econ_bad('idempotencyKey is required (8-128 of A-Z a-z 0-9 : _ . -)'); END IF;
  RETURN a ->> 'idempotencyKey';
END $$;

-- The agent's own account (scope: another agent's account is simply not found).
CREATE FUNCTION fleet_identity_own_account(p_agent text, a jsonb) RETURNS fleet_agent_accounts LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_agent_accounts;
BEGIN
  SELECT * INTO x FROM fleet_agent_accounts WHERE account_id = fleet_identity_uuid(a, 'accountId') AND agent_id = p_agent;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such account of yours'; END IF;
  RETURN x;
END $$;

CREATE FUNCTION fleet_econ_identity_create(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_kind text := COALESCE(fleet_econ_text(a, 'kind', 20), 'persona'); v_venture uuid; i fleet_agent_identities;
BEGIN
  IF v_kind NOT IN ('persona','brand','venture_identity') THEN PERFORM fleet_econ_bad('kind is persona, brand or venture_identity'); END IF;
  IF a ? 'ventureKey' THEN
    SELECT venture_id INTO v_venture FROM fleet_ventures WHERE agent_id = p_agent AND venture_key = fleet_econ_key(a, 'ventureKey');
    IF v_venture IS NULL THEN PERFORM fleet_econ_bad('no such venture of yours'); END IF;
  END IF;
  IF v_kind = 'venture_identity' AND v_venture IS NULL THEN PERFORM fleet_econ_bad('a venture identity names its ventureKey'); END IF;
  SELECT * INTO i FROM fleet_agent_identities WHERE agent_id = p_agent AND kind = v_kind AND lower(display_name) = lower(fleet_econ_text(a, 'displayName', 80, true));
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'identity', to_jsonb(i) - 'agent_id'); END IF;
  IF (SELECT count(*) FROM fleet_agent_identities WHERE agent_id = p_agent AND created_at > now() - interval '1 day')
     >= (SELECT failsafe_vendors_per_day FROM fleet_economy_policy WHERE id = 1) THEN
    RAISE EXCEPTION 'FLEET_INFRASTRUCTURE_CEILING: an infrastructure failsafe against runaway loops was hit';
  END IF;
  INSERT INTO fleet_agent_identities (identity_id, agent_id, venture_id, kind, display_name, handle, bio)
    VALUES (gen_random_uuid(), p_agent, v_venture, v_kind, fleet_econ_text(a, 'displayName', 80, true), fleet_econ_text(a, 'handle', 40), fleet_econ_text(a, 'bio', 500))
    RETURNING * INTO i;
  PERFORM fleet_event('agent_identity_created', p_agent, p_agent, jsonb_build_object('identityId', i.identity_id, 'kind', v_kind));
  RETURN jsonb_build_object('ok', true, 'identity', to_jsonb(i) - 'agent_id',
    'note', 'Yours: a pseudonym, brand or venture identity (never a claim of a government identity). Accounts can use it.');
END $$;

CREATE FUNCTION fleet_econ_identity_update(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE i fleet_agent_identities;
BEGIN
  UPDATE fleet_agent_identities SET bio = COALESCE(fleet_econ_text(a, 'bio', 500), bio), handle = COALESCE(fleet_econ_text(a, 'handle', 40), handle),
         status = COALESCE(CASE WHEN a ->> 'status' IN ('active','retired') THEN a ->> 'status' END, status), updated_at = now()
   WHERE identity_id = fleet_identity_uuid(a, 'identityId') AND agent_id = p_agent RETURNING * INTO i;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  RETURN jsonb_build_object('ok', true, 'identity', to_jsonb(i) - 'agent_id');
END $$;

CREATE FUNCTION fleet_econ_identity_list(p_agent text, a jsonb) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('ok', true,
    'identities', COALESCE((SELECT jsonb_agg(to_jsonb(i) - 'agent_id' ORDER BY i.created_at) FROM fleet_agent_identities i WHERE i.agent_id = p_agent), '[]'::jsonb),
    'accounts', COALESCE((SELECT jsonb_agg(fleet_identity_account_json(x) ORDER BY x.created_at) FROM fleet_agent_accounts x WHERE x.agent_id = p_agent), '[]'::jsonb),
    'pendingJobs', (SELECT count(*) FROM fleet_identity_jobs WHERE agent_id = p_agent AND status IN ('queued','claimed','pending')))
$$;

CREATE FUNCTION fleet_econ_account_create(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_kind text := fleet_econ_text(a, 'kind', 20, true); v_platform text := lower(fleet_econ_text(a, 'platform', 41, true)); v_handle text := fleet_econ_text(a, 'handle', 120);
        v_identity uuid; v_venture uuid; x fleet_agent_accounts; v_idem text := fleet_identity_idem(a); j fleet_identity_jobs; r jsonb;
BEGIN
  IF v_kind NOT IN (${ACCOUNT_KINDS}) OR v_kind = 'email' THEN PERFORM fleet_econ_bad('kind is domain|website|marketplace|storefront|social|service|api|payment_profile|other (email: mailbox.provision)'); END IF;
  IF v_platform !~ ${PLATFORM} THEN PERFORM fleet_econ_bad('platform is a short provider slug'); END IF;
  SELECT * INTO j FROM fleet_identity_jobs WHERE agent_id = p_agent AND idempotency_key = v_idem;
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'jobId', j.job_id, 'status', j.status, 'accountId', j.account_id); END IF;
  IF a ? 'identityId' THEN
    SELECT identity_id INTO v_identity FROM fleet_agent_identities WHERE identity_id = fleet_identity_uuid(a, 'identityId') AND agent_id = p_agent AND status = 'active';
    IF v_identity IS NULL THEN PERFORM fleet_econ_bad('no such active identity of yours'); END IF;
  END IF;
  IF a ? 'ventureKey' THEN
    SELECT venture_id INTO v_venture FROM fleet_ventures WHERE agent_id = p_agent AND venture_key = fleet_econ_key(a, 'ventureKey');
    IF v_venture IS NULL THEN PERFORM fleet_econ_bad('no such venture of yours'); END IF;
  END IF;
  IF v_handle IS NOT NULL AND EXISTS (SELECT 1 FROM fleet_agent_accounts WHERE platform = v_platform AND lower(handle) = lower(v_handle)) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_IDENTITY_TAKEN', 'reason', 'that handle on that platform is already mapped to an account');
  END IF;
  INSERT INTO fleet_agent_accounts (account_id, agent_id, identity_id, venture_id, account_kind, platform, handle)
    VALUES (gen_random_uuid(), p_agent, v_identity, v_venture, v_kind, v_platform, v_handle) RETURNING * INTO x;
  r := fleet_identity_enqueue(p_agent, x.account_id, 'account.create', jsonb_build_object('platform', v_platform, 'kind', v_kind, 'handle', v_handle,
         'useMailbox', a ->> 'mailboxAddress'), v_idem);
  RETURN r || jsonb_build_object('accountId', x.account_id,
    'note', 'The identity broker creates it, stores its credentials in the vault (never shown to you) and consumes the verification email.');
END $$;

CREATE FUNCTION fleet_econ_mailbox_provision(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_local text := lower(fleet_econ_text(a, 'localPart', 64)); v_identity uuid; x fleet_agent_accounts; v_idem text := fleet_identity_idem(a); j fleet_identity_jobs;
BEGIN
  IF v_local IS NOT NULL AND v_local !~ '^[a-z0-9._+-]{1,64}$' THEN PERFORM fleet_econ_bad('localPart is a-z 0-9 . _ + -'); END IF;
  SELECT * INTO j FROM fleet_identity_jobs WHERE agent_id = p_agent AND idempotency_key = v_idem;
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'jobId', j.job_id, 'status', j.status, 'accountId', j.account_id); END IF;
  IF a ? 'identityId' THEN
    SELECT identity_id INTO v_identity FROM fleet_agent_identities WHERE identity_id = fleet_identity_uuid(a, 'identityId') AND agent_id = p_agent AND status = 'active';
    IF v_identity IS NULL THEN PERFORM fleet_econ_bad('no such active identity of yours'); END IF;
  END IF;
  INSERT INTO fleet_agent_accounts (account_id, agent_id, identity_id, account_kind, platform)
    VALUES (gen_random_uuid(), p_agent, v_identity, 'email', 'fleet-mail') RETURNING * INTO x;
  RETURN fleet_identity_enqueue(p_agent, x.account_id, 'mailbox.provision', jsonb_build_object('localPart', v_local), v_idem) || jsonb_build_object('accountId', x.account_id);
END $$;

-- Jobs on an existing account: refused only for THIS account when its credentials are revoked or it is closed.
CREATE FUNCTION fleet_identity_account_job(p_agent text, a jsonb, p_kind text, p_params jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_agent_accounts := fleet_identity_own_account(p_agent, a);
BEGIN
  IF x.status IN ('closed','banned') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ACCOUNT_CLOSED', 'accountId', x.account_id); END IF;
  IF x.credential_health IN ('revoked','compromised') AND p_kind NOT IN ('account.recover','credential.rotate','account.close','credential.revoke') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CREDENTIAL_REVOKED', 'accountId', x.account_id,
      'reason', 'this account''s credentials are revoked: recover or rotate them; your other accounts are unaffected');
  END IF;
  RETURN fleet_identity_enqueue(p_agent, x.account_id, p_kind, p_params, fleet_identity_idem(a)) || jsonb_build_object('accountId', x.account_id);
END $$;

CREATE FUNCTION fleet_econ_account_operate(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_action text := fleet_econ_text(a, 'action', 40, true);
BEGIN
  IF v_action !~ '^[a-z][a-z0-9_.]{1,39}$' THEN PERFORM fleet_econ_bad('action is a connector action name'); END IF;
  IF a ? 'params' AND jsonb_typeof(a -> 'params') <> 'object' THEN PERFORM fleet_econ_bad('params is an object'); END IF;
  RETURN fleet_identity_account_job(p_agent, a, 'account.operate', jsonb_build_object('action', v_action, 'params', COALESCE(a -> 'params', '{}'::jsonb)));
END $$;

CREATE FUNCTION fleet_econ_account_verify_identity(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_purpose text := COALESCE(fleet_econ_text(a, 'purpose', 30), 'account_verification');
BEGIN
  IF v_purpose NOT IN (${PURPOSES}) THEN PERFORM fleet_econ_bad('purpose is account_verification|seller_verification|payment_profile|domain_registration|other_legitimate'); END IF;
  RETURN fleet_identity_account_job(p_agent, a, 'account.verify_identity', jsonb_build_object('purpose', v_purpose))
    || jsonb_build_object('note', 'You receive only a status (verified, pending, rejected, human action required) — never the account holder''s data.');
END $$;

CREATE FUNCTION fleet_econ_account_recover(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$ BEGIN RETURN fleet_identity_account_job(p_agent, a, 'account.recover', '{}'::jsonb); END $$;
CREATE FUNCTION fleet_econ_account_rotate(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$ BEGIN RETURN fleet_identity_account_job(p_agent, a, 'credential.rotate', '{}'::jsonb); END $$;
CREATE FUNCTION fleet_econ_account_close(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$ BEGIN RETURN fleet_identity_account_job(p_agent, a, 'account.close', '{}'::jsonb); END $$;

-- Revocation is immediate in the registry (no secret is usable for this account from now); the broker shreds the blobs.
CREATE FUNCTION fleet_econ_account_revoke(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_agent_accounts := fleet_identity_own_account(p_agent, a);
BEGIN
  UPDATE fleet_agent_account_credentials SET status = 'revoked', retired_at = now() WHERE account_id = x.account_id AND status = 'active';
  UPDATE fleet_agent_accounts SET credential_health = 'revoked', updated_at = now() WHERE account_id = x.account_id;
  PERFORM fleet_event('agent_account_credentials_revoked', p_agent, p_agent, jsonb_build_object('accountId', x.account_id));
  RETURN fleet_identity_enqueue(p_agent, x.account_id, 'credential.revoke', '{}'::jsonb, fleet_identity_idem(a)) || jsonb_build_object('accountId', x.account_id);
END $$;

CREATE FUNCTION fleet_econ_account_status(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_agent_accounts := fleet_identity_own_account(p_agent, a);
BEGIN
  RETURN jsonb_build_object('ok', true, 'account', fleet_identity_account_json(x),
    'jobs', COALESCE((SELECT jsonb_agg(jsonb_build_object('jobId', j.job_id, 'kind', j.kind, 'status', j.status, 'result', j.result, 'at', j.created_at) ORDER BY j.created_at DESC)
                        FROM (SELECT * FROM fleet_identity_jobs WHERE account_id = x.account_id ORDER BY created_at DESC LIMIT 10) j), '[]'::jsonb));
END $$;

CREATE FUNCTION fleet_econ_mail_inbox(p_agent text, a jsonb) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'messages', COALESCE((SELECT jsonb_agg(jsonb_build_object('messageId', m.message_id, 'to', b.address, 'from', m.sender,
           'subject', m.subject, 'body', m.body, 'verification', m.verification, 'consumed', m.consumed_at IS NOT NULL, 'receivedAt', m.received_at) ORDER BY m.received_at DESC)
           FROM (SELECT * FROM fleet_agent_mail WHERE agent_id = p_agent ORDER BY received_at DESC LIMIT 50) m
           JOIN fleet_agent_mailboxes b ON b.mailbox_id = m.mailbox_id), '[]'::jsonb))
$$;

${DISPATCH}

-- ═══ 5. Identity broker protocol (fleet_identity role only; ix_*) ═══
CREATE FUNCTION ix_ping() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('schemaVersion', (SELECT max(version) FROM fleet_schema_migrations),
    'queued', (SELECT count(*) FROM fleet_identity_jobs WHERE status = 'queued'),
    'pending', (SELECT count(*) FROM fleet_identity_jobs WHERE status IN ('claimed','pending')), 'dbTime', now(),
    'runtimeRepo', f.runtime_repo, 'runtimeCommit', f.runtime_commit, 'runtimeBuildId', f.runtime_build_id, 'runtimeLockfileSha256', f.runtime_lockfile_sha256)
    FROM fleet_state f WHERE f.id = 1
$$;

CREATE FUNCTION ix_job_context(j fleet_identity_jobs) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('jobId', j.job_id, 'agentId', j.agent_id, 'kind', j.kind, 'params', j.params, 'accountId', j.account_id,
    'account', (SELECT jsonb_build_object('platform', x.platform, 'kind', x.account_kind, 'handle', x.handle, 'status', x.status,
                  'providerAccountRef', x.provider_account_ref, 'ventureId', x.venture_id,
                  'displayName', (SELECT display_name FROM fleet_agent_identities WHERE identity_id = x.identity_id))
                  FROM fleet_agent_accounts x WHERE x.account_id = j.account_id),
    'mailboxes', COALESCE((SELECT jsonb_agg(address ORDER BY created_at) FROM fleet_agent_mailboxes WHERE agent_id = j.agent_id AND status = 'active'), '[]'::jsonb),
    -- Credential REFERENCES of this job's account only (the broker decrypts them; nobody else can).
    'credentials', COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', c.kind, 'vaultRef', c.vault_ref) ORDER BY c.created_at)
                  FROM fleet_agent_account_credentials c WHERE c.account_id = j.account_id AND c.status = 'active'), '[]'::jsonb))
$$;

CREATE FUNCTION ix_claim_job(p_worker text, p_lease_sha256 text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_identity_jobs;
BEGIN
  IF p_worker IS NULL OR p_worker !~ '^[a-z0-9_.-]{1,64}$' OR p_lease_sha256 IS NULL OR p_lease_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  SELECT * INTO j FROM fleet_identity_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', true, 'job', NULL); END IF;
  UPDATE fleet_identity_jobs SET status = 'claimed', claimed_by = p_worker, claimed_at = now(), lease_sha256 = p_lease_sha256
   WHERE job_id = j.job_id RETURNING * INTO j;
  IF j.account_id IS NOT NULL THEN UPDATE fleet_agent_accounts SET status = CASE WHEN status = 'requested' THEN 'creating' ELSE status END, updated_at = now() WHERE account_id = j.account_id; END IF;
  RETURN jsonb_build_object('ok', true, 'job', ix_job_context(j));
END $$;

-- A claimed job under its lease (every other ix_* call checks this first).
CREATE FUNCTION ix_leased(p_job uuid, p_lease text) RETURNS fleet_identity_jobs LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_identity_jobs;
BEGIN
  SELECT * INTO j FROM fleet_identity_jobs WHERE job_id = p_job;
  IF NOT FOUND OR j.status NOT IN ('claimed','pending') OR p_lease IS NULL OR encode(sha256(convert_to(p_lease, 'UTF8')), 'hex') <> j.lease_sha256 THEN
    RAISE EXCEPTION 'FLEET_LEASE_INVALID: no claimed job under this lease';
  END IF;
  RETURN j;
END $$;

CREATE FUNCTION ix_pending_jobs(p_worker text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(ix_job_context(j)), '[]'::jsonb) FROM fleet_identity_jobs j WHERE j.status = 'pending' AND j.claimed_by = p_worker
$$;

CREATE FUNCTION ix_credential_record(p_job uuid, p_lease text, p_kind text, p_vault_ref text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_identity_jobs := ix_leased(p_job, p_lease);
BEGIN
  IF j.account_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  UPDATE fleet_agent_account_credentials SET status = 'rotated', retired_at = now() WHERE account_id = j.account_id AND kind = p_kind AND status = 'active';
  INSERT INTO fleet_agent_account_credentials (credential_id, account_id, agent_id, kind, vault_ref) VALUES (gen_random_uuid(), j.account_id, j.agent_id, p_kind, p_vault_ref);
  UPDATE fleet_agent_accounts SET credential_health = 'ok', updated_at = now() WHERE account_id = j.account_id;
  RETURN jsonb_build_object('ok', true);
END $$;

-- Retired references the broker may shred (revoked / rotated / compromised; never an active one).
CREATE FUNCTION ix_retired_credentials(p_job uuid, p_lease text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_identity_jobs := ix_leased(p_job, p_lease);
BEGIN
  RETURN COALESCE((SELECT jsonb_agg(vault_ref) FROM fleet_agent_account_credentials WHERE account_id = j.account_id AND status <> 'active'), '[]'::jsonb);
END $$;

CREATE FUNCTION ix_mailbox_record(p_job uuid, p_lease text, p_address text, p_provider text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_identity_jobs := ix_leased(p_job, p_lease);
BEGIN
  IF j.kind <> 'mailbox.provision' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  INSERT INTO fleet_agent_mailboxes (mailbox_id, agent_id, account_id, address, provider) VALUES (gen_random_uuid(), j.agent_id, j.account_id, lower(p_address), p_provider);
  UPDATE fleet_agent_accounts SET handle = lower(p_address), status = 'active', verification = 'email_verified', updated_at = now() WHERE account_id = j.account_id;
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE FUNCTION ix_mailboxes(p_worker text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('address', address, 'provider', provider,
    'since', COALESCE((SELECT max(m.received_at) FROM fleet_agent_mail m WHERE m.mailbox_id = b.mailbox_id), b.created_at))), '[]'::jsonb)
    FROM fleet_agent_mailboxes b WHERE b.status = 'active'
$$;

-- Mail sync: deliver one sanitised message to the mailbox that owns the address (the broker redacts links/codes first).
CREATE FUNCTION ix_mail_deliver(p_worker text, p_address text, p_sender text, p_subject text, p_body text, p_verification boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE b fleet_agent_mailboxes; v_id uuid := gen_random_uuid();
BEGIN
  SELECT * INTO b FROM fleet_agent_mailboxes WHERE lower(address) = lower(p_address) AND status = 'active';
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  INSERT INTO fleet_agent_mail (message_id, mailbox_id, agent_id, sender, subject, body, verification)
    VALUES (v_id, b.mailbox_id, b.agent_id, left(fleet_scrub(p_sender), 200), left(fleet_scrub(COALESCE(p_subject, '')), 300),
            left(fleet_scrub_long(COALESCE(p_body, '')), 4000), COALESCE(p_verification, false));
  RETURN jsonb_build_object('ok', true, 'messageId', v_id);
END $$;

CREATE FUNCTION ix_mail_consumed(p_job uuid, p_lease text, p_message uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_identity_jobs := ix_leased(p_job, p_lease);
BEGIN
  UPDATE fleet_agent_mail SET consumed_at = now() WHERE message_id = p_message AND agent_id = j.agent_id AND consumed_at IS NULL;
  RETURN jsonb_build_object('ok', FOUND);
END $$;

-- Which owner identity classes may be released for this job (standing consent ∩ configured, unexpired classes).
CREATE FUNCTION ix_identity_authorize(p_job uuid, p_lease text, p_provider text, p_purpose text, p_classes text[]) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_identity_jobs := ix_leased(p_job, p_lease); c fleet_owner_identity_consent; v_allowed text[]; v_missing text[];
BEGIN
  IF j.kind <> 'account.verify_identity' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  SELECT * INTO c FROM fleet_owner_identity_consent
   WHERE revoked_at IS NULL AND p_purpose = ANY(purposes) AND (providers IS NULL OR p_provider = ANY(providers)) AND p_classes <@ classes
   ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NO_STANDING_CONSENT'); END IF;
  SELECT array_agg(k) INTO v_missing FROM unnest(p_classes) k
   WHERE NOT EXISTS (SELECT 1 FROM fleet_owner_identity_classes o WHERE o.class_key = k AND o.status = 'configured' AND (o.expires_at IS NULL OR o.expires_at > now()));
  IF v_missing IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_OWNER_IDENTITY_MISSING', 'classes', to_jsonb(v_missing)); END IF;
  RETURN jsonb_build_object('ok', true, 'consentId', c.consent_id, 'classes', to_jsonb(p_classes),
    'vaultRefs', (SELECT jsonb_object_agg(class_key, vault_ref) FROM fleet_owner_identity_classes WHERE class_key = ANY(p_classes)));
END $$;

CREATE FUNCTION ix_release_record(p_job uuid, p_lease text, p_provider text, p_purpose text, p_classes text[], p_consent uuid, p_outcome text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_identity_jobs := ix_leased(p_job, p_lease);
BEGIN
  INSERT INTO fleet_identity_releases (release_id, job_id, agent_id, account_id, venture_id, provider, purpose, classes, consent_id, outcome)
    VALUES (gen_random_uuid(), j.job_id, j.agent_id, j.account_id, (SELECT venture_id FROM fleet_agent_accounts WHERE account_id = j.account_id),
            p_provider, p_purpose, COALESCE(p_classes, ARRAY[]::text[]), p_consent, p_outcome);
  PERFORM fleet_event('owner_identity_release', j.agent_id, 'identity-broker', jsonb_build_object('jobId', j.job_id, 'provider', p_provider, 'purpose', p_purpose,
    'classes', to_jsonb(COALESCE(p_classes, ARRAY[]::text[])), 'outcome', p_outcome));
  RETURN jsonb_build_object('ok', true);
END $$;

-- Final (or pending) result of a job. Status-only result; an account needing a non-delegable human act gets ONE
-- action-scoped dependency for this account — nothing else waits.
CREATE FUNCTION ix_report_job(p_job uuid, p_lease text, p_outcome text, p_result jsonb, p_account jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_identity_jobs := ix_leased(p_job, p_lease); x fleet_agent_accounts; v_dep uuid; v_res jsonb; acc jsonb := COALESCE(p_account, '{}'::jsonb);
BEGIN
  IF p_outcome NOT IN ('pending','succeeded','failed','human_action_required') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  -- Status-only: a closed set of keys, scrubbed text.
  v_res := jsonb_strip_nulls(jsonb_build_object('status', p_result ->> 'status', 'code', left(p_result ->> 'code', 64), 'note', left(fleet_scrub(p_result ->> 'note'), 300),
             'data', CASE WHEN jsonb_typeof(p_result -> 'data') = 'object' AND length((p_result -> 'data')::text) <= 2000 THEN p_result -> 'data' END));
  UPDATE fleet_identity_jobs SET status = p_outcome, result = v_res, finished_at = CASE WHEN p_outcome = 'pending' THEN NULL ELSE now() END WHERE job_id = j.job_id;
  IF j.account_id IS NOT NULL THEN
    UPDATE fleet_agent_accounts SET
        status = COALESCE(CASE WHEN acc ->> 'status' IN ('creating','pending_verification','active','human_action_required','suspended','banned','closed','failed') THEN acc ->> 'status' END, status),
        verification = COALESCE(CASE WHEN acc ->> 'verification' IN ('none','email_pending','email_verified','identity_pending','identity_verified','identity_rejected') THEN acc ->> 'verification' END, verification),
        credential_health = COALESCE(CASE WHEN acc ->> 'credentialHealth' IN ('none','ok','rotating','revoked','compromised') THEN acc ->> 'credentialHealth' END, credential_health),
        provider_account_ref = COALESCE(left(acc ->> 'providerAccountRef', 200), provider_account_ref),
        handle = CASE WHEN handle IS NULL AND (acc ->> 'handle') ~ '^[A-Za-z0-9._@+-]{1,120}$' THEN acc ->> 'handle' ELSE handle END,
        reputation = CASE WHEN jsonb_typeof(acc -> 'reputation') = 'object' AND length((reputation || (acc -> 'reputation'))::text) <= 2000 THEN reputation || (acc -> 'reputation') ELSE reputation END,
        status_reason = COALESCE(left(fleet_scrub(acc ->> 'reason'), 300), status_reason),
        closed_at = CASE WHEN acc ->> 'status' = 'closed' THEN now() ELSE closed_at END, updated_at = now()
     WHERE account_id = j.account_id RETURNING * INTO x;
    IF p_outcome = 'human_action_required' AND x.dependency_id IS NULL THEN
      v_dep := gen_random_uuid();
      INSERT INTO fleet_owner_requests (request_id, agent_id, idempotency_key, kind, action, title, detail, blocks_action)
        VALUES (v_dep, j.agent_id, 'identity:' || x.account_id, 'human_identity',
                left(format('%s account verification (%s)', x.platform, COALESCE(x.handle, 'new account')), 200),
                left(format('Human identity action required by %s', x.platform), 200),
                left('The provider requires a non-delegable human act or account-holder identity the owner has not provided or consented to. '
                     || 'Only this account''s verification waits; every other account, venture and action continues. ' || COALESCE(fleet_scrub(v_res ->> 'note'), ''), 2000), true)
        ON CONFLICT DO NOTHING;
      UPDATE fleet_agent_accounts SET dependency_id = v_dep WHERE account_id = x.account_id;
      PERFORM fleet_event('external_dependency_recorded', j.agent_id, 'identity-broker', jsonb_build_object('requestId', v_dep, 'kind', 'human_identity', 'accountId', x.account_id));
    ELSIF x.status = 'active' AND x.verification = 'identity_verified' AND x.dependency_id IS NOT NULL THEN
      UPDATE fleet_owner_requests SET status = 'answered', decided_by = 'identity-broker', decided_at = now(), response = 'Identity verification completed.'
       WHERE request_id = x.dependency_id AND status = 'pending';
    END IF;
  END IF;
  PERFORM fleet_event('identity_job_' || p_outcome, j.agent_id, 'identity-broker', jsonb_build_object('jobId', j.job_id, 'kind', j.kind, 'code', v_res ->> 'code'));
  RETURN jsonb_build_object('ok', true);
END $$;

-- ═══ 6. Owner identity administration (metadata and consent only; values are sealed into the owner vault by the CLI) ═══
CREATE FUNCTION fleet_admin_owner_identity_class_set(p_class text, p_vault_ref text, p_expires timestamptz, p_status text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_owner_identity_classes;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_identity');
  INSERT INTO fleet_owner_identity_classes (class_key, vault_ref, expires_at, status, updated_by)
    VALUES (p_class, p_vault_ref, p_expires, COALESCE(p_status, 'configured'), p_actor)
    ON CONFLICT (class_key) DO UPDATE SET vault_ref = EXCLUDED.vault_ref, expires_at = EXCLUDED.expires_at, status = EXCLUDED.status,
      updated_by = EXCLUDED.updated_by, updated_at = now() RETURNING * INTO r;
  PERFORM fleet_event('owner_identity_class_set', NULL, p_actor, jsonb_build_object('class', p_class, 'status', r.status, 'expiresAt', r.expires_at));
  RETURN to_jsonb(r);
END $$;

CREATE FUNCTION fleet_admin_owner_identity_consent_set(p_purposes text[], p_providers text[], p_classes text[], p_statement text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_owner_identity_consent;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_identity');
  INSERT INTO fleet_owner_identity_consent (consent_id, purposes, providers, classes, statement, created_by)
    VALUES (gen_random_uuid(), p_purposes, p_providers, p_classes, fleet_scrub(p_statement), p_actor) RETURNING * INTO c;
  PERFORM fleet_event('owner_identity_consent_set', NULL, p_actor, jsonb_build_object('consentId', c.consent_id, 'purposes', to_jsonb(p_purposes),
    'providers', to_jsonb(p_providers), 'classes', to_jsonb(p_classes)));
  RETURN to_jsonb(c);
END $$;

CREATE FUNCTION fleet_admin_owner_identity_consent_revoke(p_consent uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_owner_identity_consent;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  UPDATE fleet_owner_identity_consent SET revoked_at = now(), revoked_by = p_actor WHERE consent_id = p_consent AND revoked_at IS NULL RETURNING * INTO c;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no active consent'; END IF;
  PERFORM fleet_event('owner_identity_consent_revoked', NULL, p_actor, jsonb_build_object('consentId', p_consent));
  RETURN to_jsonb(c);
END $$;
CREATE FUNCTION fleet_owner_identity_consent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['revoked_by','revoked_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revoked_by','revoked_at']) OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: a consent is only ever revoked';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_owner_identity_consent_guard BEFORE UPDATE ON fleet_owner_identity_consent FOR EACH ROW EXECUTE FUNCTION fleet_owner_identity_consent_guard();

-- ═══ 7. Retire v11's raw release of organisation identity to agents (the broker replaces it) ═══
CREATE OR REPLACE FUNCTION api_identity_fact(p_agent text, p_token text, p_claim uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'identity_fact');
BEGIN
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  RETURN jsonb_build_object('ok', false, 'code', 'FLEET_IDENTITY_BROKERED',
    'reason', 'Owner identity is never released to agents. Use identity: account.verify_identity — the identity broker verifies and you receive a status.');
END $$;
CREATE OR REPLACE FUNCTION api_identity_request(p_agent text, p_token text, p_fact_key text, p_purpose text, p_workflow text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'identity_request');
BEGIN
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  RETURN jsonb_build_object('ok', false, 'code', 'FLEET_IDENTITY_BROKERED',
    'reason', 'Nothing here waits on the owner: create your own identity and accounts (identity tool); where a provider needs a verified account holder, use account.verify_identity.');
END $$;
CREATE OR REPLACE FUNCTION fleet_org_identity_set(p_fact_key text, p_value text, p_sensitivity text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'FLEET_OWNER_VAULT: owner identity is stored only in the sealed owner identity vault (fleet:admin owner-identity-seal, installed by the identity broker), never in the database';
END $$;
CREATE FUNCTION fleet_org_identity_facts_retired() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FLEET_OWNER_VAULT: owner identity is stored only in the sealed owner identity vault';
END $$;
CREATE TRIGGER fleet_org_identity_facts_retired BEFORE INSERT OR UPDATE ON fleet_org_identity_facts FOR EACH ROW EXECUTE FUNCTION fleet_org_identity_facts_retired();

-- ═══ 8. Hub and doctor ═══
CREATE FUNCTION fleet_hub_identity(p_agent text) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'agents', COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId', ag.agent_id, 'name', ag.name, 'status', ag.status, 'generation', ag.generation,
        'identities', COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', i.kind, 'displayName', i.display_name, 'handle', i.handle, 'status', i.status,
                         'venture', (SELECT venture_key FROM fleet_ventures WHERE venture_id = i.venture_id))) FROM fleet_agent_identities i WHERE i.agent_id = ag.agent_id), '[]'::jsonb),
        'accounts', COALESCE((SELECT jsonb_agg(fleet_identity_account_json(x)) FROM fleet_agent_accounts x WHERE x.agent_id = ag.agent_id), '[]'::jsonb)))
      FROM fleet_agents ag WHERE (p_agent IS NULL OR ag.agent_id = p_agent)
        AND (p_agent IS NOT NULL OR EXISTS (SELECT 1 FROM fleet_agent_identities WHERE agent_id = ag.agent_id) OR EXISTS (SELECT 1 FROM fleet_agent_accounts WHERE agent_id = ag.agent_id))), '[]'::jsonb),
    'ownerVault', jsonb_build_object(
      'configured', EXISTS (SELECT 1 FROM fleet_owner_identity_classes WHERE status = 'configured'),
      'classes', COALESCE((SELECT jsonb_agg(jsonb_build_object('class', class_key, 'status', status, 'expiresAt', expires_at, 'updatedAt', updated_at) ORDER BY class_key)
                   FROM fleet_owner_identity_classes), '[]'::jsonb),
      'consents', COALESCE((SELECT jsonb_agg(jsonb_build_object('consentId', consent_id, 'purposes', purposes, 'providers', providers, 'classes', classes,
                   'statement', statement, 'active', revoked_at IS NULL, 'createdAt', created_at) ORDER BY created_at DESC) FROM fleet_owner_identity_consent), '[]'::jsonb),
      'releases', COALESCE((SELECT jsonb_agg(jsonb_build_object('at', r.at, 'agentId', r.agent_id, 'venture', (SELECT venture_key FROM fleet_ventures WHERE venture_id = r.venture_id),
                   'provider', r.provider, 'account', (SELECT handle FROM fleet_agent_accounts WHERE account_id = r.account_id), 'purpose', r.purpose,
                   'classes', r.classes, 'outcome', r.outcome) ORDER BY r.at DESC) FROM (SELECT * FROM fleet_identity_releases ORDER BY at DESC LIMIT 100) r), '[]'::jsonb)),
    'broker', jsonb_build_object(
      'queued', (SELECT count(*) FROM fleet_identity_jobs WHERE status = 'queued'),
      'pending', (SELECT count(*) FROM fleet_identity_jobs WHERE status IN ('claimed','pending')),
      'humanActionRequired', COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId', x.agent_id, 'platform', x.platform, 'account', x.handle,
                   'requestId', x.dependency_id, 'reason', x.status_reason)) FROM fleet_agent_accounts x WHERE x.status = 'human_action_required'), '[]'::jsonb)))
$$;

CREATE FUNCTION fleet_identity_status() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('identities', (SELECT count(*) FROM fleet_agent_identities), 'accounts', (SELECT count(*) FROM fleet_agent_accounts),
    'queued', (SELECT count(*) FROM fleet_identity_jobs WHERE status = 'queued'),
    'queuedStale', (SELECT count(*) FROM fleet_identity_jobs WHERE status = 'queued' AND created_at < now() - interval '1 hour'),
    'claimedStale', (SELECT count(*) FROM fleet_identity_jobs WHERE status IN ('claimed','pending') AND claimed_at < now() - interval '1 day'),
    'humanActionRequired', (SELECT count(*) FROM fleet_agent_accounts WHERE status = 'human_action_required'),
    'ownerVaultConfigured', EXISTS (SELECT 1 FROM fleet_owner_identity_classes WHERE status = 'configured'),
    'activeConsents', (SELECT count(*) FROM fleet_owner_identity_consent WHERE revoked_at IS NULL))
$$;
`;
