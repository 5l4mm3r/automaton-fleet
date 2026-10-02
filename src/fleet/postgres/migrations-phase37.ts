/**
 * Schema v37 — the general browser / account operator and credential execution (master handoff §§2, 8, 41).
 *
 * Agents use the ordinary web: any legitimate website, sign-ups, logins, forms, dashboards, listings — no bespoke adapter
 * per site. An agent drives a browser session (browser.open / act / observe / close); a separate BROWSER WORKER (own OS
 * user, own DB role fleet_browser, bx_* only, public internet only, no vault) executes the steps.
 *
 * use_credentials(account): a step may fill a credential ({credential: "password" | "username" | "email" | "totp" |
 * "email_code" | "sms_code" | "api_key" | "generate_password"}), open the account's latest authentication link, or
 * CAPTURE a secret shown on a page into the vault. The worker asks for it; the identity broker (the only vault holder)
 * seals it to the worker's one-time key; the worker fills it and forgets it; page snapshots never contain it; the agent
 * never sees it. Credential steps work only on the account's PINNED ORIGINS — a defence against a page that tries to
 * steer an agent into typing its password elsewhere (the agent pins origins itself, audited; no approval step).
 *
 * Authentication messages (sign-up links, login/one-time codes) are stored encrypted by the broker (agent-vault key) so
 * the broker can serve a code to a fill step; erased after use or 24 h.
 */

import { V36_SQL } from "./migrations-phase36.js";

function restate(src: string, srcTag: string, name: string, edits: Array<[string, string]>): string {
  const head = Math.max(src.lastIndexOf(`CREATE FUNCTION ${name}(`), src.lastIndexOf(`CREATE OR REPLACE FUNCTION ${name}(`));
  if (head < 0) throw new Error(`v37: ${srcTag} function ${name} not found`);
  const end = src.indexOf("$$;", src.indexOf("AS $$", head) + 5);
  if (end < 0) throw new Error(`v37: ${srcTag} function ${name} has no body end`);
  let body = "CREATE OR REPLACE " + src.slice(src.indexOf("FUNCTION", head), end + 3);
  for (const [from, to] of edits) {
    if (body.split(from).length !== 2) throw new Error(`v37: expected text not found exactly once in ${name}: ${from.slice(0, 60)}`);
    body = body.replace(from, to);
  }
  return body;
}

export const BROWSER_OPS = ["browser.open", "browser.act", "browser.observe", "browser.close", "browser.result",
  "account.register", "account.add_origin", "account.mark"] as const;

const DISPATCH = restate(V36_SQL, "v36", "api_economy", [
  [`WHEN 'sms.inbox' THEN 'planning'`,
   `WHEN 'sms.inbox' THEN 'planning'
    -- v37: the general browser / account operator (the agent's own outward action; no approval step).
    ${BROWSER_OPS.map((o) => `WHEN '${o}' THEN 'planning'`).join(" ")}`],
  [`WHEN 'sms.inbox' THEN fleet_econ_sms_inbox(p_agent, a)`,
   `WHEN 'sms.inbox' THEN fleet_econ_sms_inbox(p_agent, a)
      ${BROWSER_OPS.map((o) => `WHEN '${o}' THEN fleet_econ_${o.replace(".", "_")}(p_agent, a)`).join("\n      ")}`],
  ["PHONE_[A-Z_]+):", "PHONE_[A-Z_]+|BROWSER_[A-Z_]+|ORIGIN_[A-Z_]+):"],
]);

const CREDENTIAL_KINDS = "'password','username','email','totp','email_code','sms_code','api_key','generate_password'";
const CAPTURE_KINDS = "'api_key','password','recovery_codes','totp'";
const ORIGIN = `'^https://[a-z0-9.-]{3,190}(:[0-9]{2,5})?$'`;

export const V37_SQL = `
-- ═══ 1. Accounts gain pinned origins and a login email ═══
ALTER TABLE fleet_agent_accounts
  ADD COLUMN origins     text[] NOT NULL DEFAULT '{}' CHECK (cardinality(origins) <= 10),
  ADD COLUMN login_email text   CHECK (login_email ~ '^[a-z0-9._+-]{1,64}@[a-z0-9.-]{3,190}$');
CREATE FUNCTION fleet_origin_ok(o text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT o ~ ${ORIGIN} $$;
CREATE FUNCTION fleet_agent_accounts_origins_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(NEW.origins) o WHERE NOT fleet_origin_ok(o)) THEN RAISE EXCEPTION 'FLEET_ORIGIN_INVALID: origins are https://host[:port]'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_agent_accounts_origins_guard BEFORE INSERT OR UPDATE OF origins ON fleet_agent_accounts FOR EACH ROW EXECUTE FUNCTION fleet_agent_accounts_origins_guard();

-- ═══ 2. Browser sessions and actions ═══
CREATE TABLE fleet_browser_sessions (
  session_id    uuid        PRIMARY KEY,
  agent_id      text        NOT NULL REFERENCES fleet_agents(agent_id),
  account_id    uuid        REFERENCES fleet_agent_accounts(account_id),
  status        text        NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','expired')),
  url           text        CHECK (length(url) <= 2000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz
);
CREATE INDEX fleet_browser_sessions_agent ON fleet_browser_sessions (agent_id, status);
CREATE TRIGGER fleet_browser_sessions_no_delete BEFORE DELETE ON fleet_browser_sessions FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_browser_actions (
  action_id     uuid        PRIMARY KEY,
  session_id    uuid        NOT NULL REFERENCES fleet_browser_sessions(session_id),
  agent_id      text        NOT NULL REFERENCES fleet_agents(agent_id),
  kind          text        NOT NULL CHECK (kind IN ('open','act','observe','close')),
  steps         jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(steps) = 'array' AND length(steps::text) <= 60000),
  status        text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','claimed','done','failed')),
  result        jsonb       CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND length(result::text) <= 200000)),
  claimed_by    text,
  lease_sha256  text        CHECK (lease_sha256 ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  claimed_at    timestamptz,
  finished_at   timestamptz
);
CREATE INDEX fleet_browser_actions_queue ON fleet_browser_actions (status, created_at);
CREATE TRIGGER fleet_browser_actions_no_delete BEFORE DELETE ON fleet_browser_actions FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_browser_secret_requests (
  request_id    uuid        PRIMARY KEY,
  action_id     uuid        NOT NULL REFERENCES fleet_browser_actions(action_id),
  agent_id      text        NOT NULL REFERENCES fleet_agents(agent_id),
  account_id    uuid        NOT NULL REFERENCES fleet_agent_accounts(account_id),
  kind          text        NOT NULL CHECK (kind IN (${CREDENTIAL_KINDS}, 'auth_link', 'capture')),
  capture_kind  text        CHECK (capture_kind IN (${CAPTURE_KINDS})),
  origin        text        NOT NULL CHECK (origin ~ ${ORIGIN}),
  worker_pub    text        NOT NULL CHECK (worker_pub ~ '^[A-Za-z0-9+/=]{40,120}$'),
  sealed_in     bytea       CHECK (octet_length(sealed_in) <= 64000),
  status        text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','served','failed','taken','expired')),
  sealed        bytea       CHECK (octet_length(sealed) <= 64000),
  error         text        CHECK (length(error) <= 120),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '1 minute',
  CHECK ((kind = 'capture') = (capture_kind IS NOT NULL)),
  CHECK (kind <> 'capture' OR sealed_in IS NOT NULL OR status <> 'pending'),
  CHECK (sealed IS NULL OR status = 'served')
);
CREATE TRIGGER fleet_browser_secret_requests_no_delete BEFORE DELETE ON fleet_browser_secret_requests FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- Authentication messages, encrypted by the broker (agent-vault key, scope authmsg:<kind>:<id>), for credential execution.
CREATE TABLE fleet_auth_message_blobs (
  kind         text        NOT NULL CHECK (kind IN ('mail','sms')),
  message_id   uuid        NOT NULL,
  agent_id     text        NOT NULL REFERENCES fleet_agents(agent_id),
  address      text        NOT NULL,
  blob         bytea       CHECK (octet_length(blob) <= 200000),
  created_at   timestamptz NOT NULL DEFAULT now(),
  used_at      timestamptz,
  PRIMARY KEY (kind, message_id)
);

-- ═══ 3. Step grammar (validated before anything reaches the worker) ═══
CREATE FUNCTION fleet_browser_steps_valid(p_steps jsonb, p_has_account boolean) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE s jsonb; v_a text;
BEGIN
  IF p_steps IS NULL OR jsonb_typeof(p_steps) <> 'array' OR jsonb_array_length(p_steps) NOT BETWEEN 1 AND 25 THEN PERFORM fleet_econ_bad('steps is an array of 1..25 steps'); END IF;
  FOR s IN SELECT e FROM jsonb_array_elements(p_steps) e LOOP
    IF jsonb_typeof(s) <> 'object' THEN PERFORM fleet_econ_bad('each step is an object'); END IF;
    v_a := s ->> 'action';
    IF v_a NOT IN ('goto','click','fill','select','check','press','wait','wait_for','open_auth_link','capture','back') THEN
      PERFORM fleet_econ_bad('action is goto|click|fill|select|check|press|wait|wait_for|open_auth_link|capture|back');
    END IF;
    IF v_a = 'goto' AND (COALESCE(s ->> 'url', '') !~ '^https?://[^[:space:]]+$' OR length(s ->> 'url') > 2000) THEN PERFORM fleet_econ_bad('goto needs an http(s) url'); END IF;
    IF v_a IN ('click') AND (s ->> 'selector') IS NULL AND (s ->> 'text') IS NULL THEN PERFORM fleet_econ_bad('click needs a selector or text'); END IF;
    IF v_a IN ('fill','select','check','wait_for','capture') AND length(COALESCE(s ->> 'selector', '')) NOT BETWEEN 1 AND 300 THEN
      PERFORM fleet_econ_bad(v_a || ' needs a selector');
    END IF;
    IF v_a = 'fill' THEN
      IF (s ? 'value') = (s ? 'credential') THEN PERFORM fleet_econ_bad('fill takes exactly one of value or credential'); END IF;
      IF s ? 'value' AND length(s ->> 'value') > 5000 THEN PERFORM fleet_econ_bad('a value is at most 5000 characters'); END IF;
      IF s ? 'credential' AND (s ->> 'credential') NOT IN (${CREDENTIAL_KINDS}) THEN
        PERFORM fleet_econ_bad('credential is password|username|email|totp|email_code|sms_code|api_key|generate_password');
      END IF;
      IF s ? 'credential' AND NOT p_has_account THEN PERFORM fleet_econ_bad('credential steps need a session opened with an accountId'); END IF;
    END IF;
    IF v_a = 'capture' AND (NOT p_has_account OR COALESCE(s ->> 'kind', '') NOT IN (${CAPTURE_KINDS})) THEN
      PERFORM fleet_econ_bad('capture needs an account session and kind api_key|password|recovery_codes|totp');
    END IF;
    IF v_a = 'open_auth_link' AND NOT p_has_account THEN PERFORM fleet_econ_bad('open_auth_link needs an account session'); END IF;
    IF v_a = 'press' AND length(COALESCE(s ->> 'key', '')) NOT BETWEEN 1 AND 30 THEN PERFORM fleet_econ_bad('press needs a key'); END IF;
    IF v_a = 'wait' AND (jsonb_typeof(s -> 'ms') <> 'number' OR (s ->> 'ms')::numeric NOT BETWEEN 1 AND 10000) THEN PERFORM fleet_econ_bad('wait ms is 1..10000'); END IF;
  END LOOP;
END $$;

CREATE FUNCTION fleet_browser_enqueue(p_agent text, s fleet_browser_sessions, p_kind text, p_steps jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  IF (SELECT count(*) FROM fleet_browser_actions WHERE agent_id = p_agent AND created_at > now() - interval '1 day') >= 2000 THEN
    RAISE EXCEPTION 'FLEET_INFRASTRUCTURE_CEILING: an infrastructure failsafe against runaway loops was hit';
  END IF;
  INSERT INTO fleet_browser_actions (action_id, session_id, agent_id, kind, steps) VALUES (v_id, s.session_id, p_agent, p_kind, COALESCE(p_steps, '[]'::jsonb));
  UPDATE fleet_browser_sessions SET last_used_at = now() WHERE session_id = s.session_id;
  RETURN jsonb_build_object('ok', true, 'sessionId', s.session_id, 'actionId', v_id, 'status', 'queued');
END $$;

-- ═══ 4. Agent operations ═══
CREATE FUNCTION fleet_econ_browser_open(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE s fleet_browser_sessions; v_account uuid; v_url text := fleet_econ_text(a, 'url', 2000, true);
BEGIN
  IF a ? 'accountId' THEN
    SELECT account_id INTO v_account FROM fleet_agent_accounts WHERE account_id = fleet_identity_uuid(a, 'accountId') AND agent_id = p_agent
       AND status NOT IN ('closed','banned');
    IF v_account IS NULL THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such open account of yours'; END IF;
    IF EXISTS (SELECT 1 FROM fleet_agent_account_credentials WHERE account_id = v_account AND status = 'revoked')
       AND NOT EXISTS (SELECT 1 FROM fleet_agent_account_credentials WHERE account_id = v_account AND status = 'active') THEN
      RAISE EXCEPTION 'FLEET_CREDENTIAL_REVOKED: the account''s credentials are revoked; recover or rotate first';
    END IF;
  END IF;
  -- Old idle sessions expire; at most 3 open per agent (an infrastructure bound on browser resources).
  UPDATE fleet_browser_sessions SET status = 'expired', closed_at = now() WHERE agent_id = p_agent AND status = 'open' AND last_used_at < now() - interval '30 minutes';
  IF (SELECT count(*) FROM fleet_browser_sessions WHERE agent_id = p_agent AND status = 'open') >= 3 THEN
    RAISE EXCEPTION 'FLEET_BROWSER_SESSIONS: close one of your 3 open browser sessions first';
  END IF;
  INSERT INTO fleet_browser_sessions (session_id, agent_id, account_id, url) VALUES (gen_random_uuid(), p_agent, v_account, v_url) RETURNING * INTO s;
  PERFORM fleet_browser_steps_valid(jsonb_build_array(jsonb_build_object('action', 'goto', 'url', v_url)), v_account IS NOT NULL);
  RETURN fleet_browser_enqueue(p_agent, s, 'open', jsonb_build_array(jsonb_build_object('action', 'goto', 'url', v_url)));
END $$;

CREATE FUNCTION fleet_browser_session_of(p_agent text, a jsonb) RETURNS fleet_browser_sessions LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE s fleet_browser_sessions;
BEGIN
  SELECT * INTO s FROM fleet_browser_sessions WHERE session_id = fleet_identity_uuid(a, 'sessionId') AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_BROWSER_NONE: no such session of yours'; END IF;
  IF s.status <> 'open' THEN RAISE EXCEPTION 'FLEET_BROWSER_CLOSED: the session is %; open a new one', s.status; END IF;
  RETURN s;
END $$;

CREATE FUNCTION fleet_econ_browser_act(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE s fleet_browser_sessions := fleet_browser_session_of(p_agent, a);
BEGIN
  PERFORM fleet_browser_steps_valid(a -> 'steps', s.account_id IS NOT NULL);
  RETURN fleet_browser_enqueue(p_agent, s, 'act', a -> 'steps');
END $$;

CREATE FUNCTION fleet_econ_browser_observe(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  RETURN fleet_browser_enqueue(p_agent, fleet_browser_session_of(p_agent, a), 'observe', '[]'::jsonb);
END $$;

CREATE FUNCTION fleet_econ_browser_close(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE s fleet_browser_sessions := fleet_browser_session_of(p_agent, a); r jsonb;
BEGIN
  r := fleet_browser_enqueue(p_agent, s, 'close', '[]'::jsonb);
  UPDATE fleet_browser_sessions SET status = 'closed', closed_at = now() WHERE session_id = s.session_id;
  RETURN r;
END $$;

CREATE FUNCTION fleet_econ_browser_result(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_browser_actions;
BEGIN
  SELECT * INTO x FROM fleet_browser_actions WHERE action_id = fleet_identity_uuid(a, 'actionId') AND agent_id = p_agent;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_BROWSER_NONE: no such action of yours'; END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object('ok', true, 'actionId', x.action_id, 'sessionId', x.session_id, 'status', x.status, 'result', x.result));
END $$;

-- Register an account the agent is creating on any website through the browser (no adapter needed).
CREATE FUNCTION fleet_econ_account_register(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_kind text := fleet_econ_text(a, 'kind', 20, true); v_platform text := lower(fleet_econ_text(a, 'platform', 41, true)); v_handle text := fleet_econ_text(a, 'handle', 120);
        v_origin text := lower(fleet_econ_text(a, 'origin', 200, true)); v_email text := lower(fleet_econ_text(a, 'loginEmail', 190)); v_identity uuid; v_venture uuid;
        x fleet_agent_accounts;
BEGIN
  IF v_kind NOT IN ('domain','website','marketplace','storefront','social','service','api','payment_profile','other') THEN
    PERFORM fleet_econ_bad('kind is domain|website|marketplace|storefront|social|service|api|payment_profile|other');
  END IF;
  IF v_platform !~ '^[a-z0-9][a-z0-9._-]{1,40}$' THEN PERFORM fleet_econ_bad('platform is a short provider slug (e.g. the site''s host)'); END IF;
  IF NOT fleet_origin_ok(v_origin) THEN RAISE EXCEPTION 'FLEET_ORIGIN_INVALID: origin is https://host[:port] of the site''s login pages'; END IF;
  IF v_email IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fleet_agent_mailboxes WHERE lower(address) = v_email AND agent_id = p_agent AND status = 'active') THEN
    PERFORM fleet_econ_bad('loginEmail is one of your mailboxes');
  END IF;
  IF a ? 'identityId' THEN
    SELECT identity_id INTO v_identity FROM fleet_agent_identities WHERE identity_id = fleet_identity_uuid(a, 'identityId') AND agent_id = p_agent;
    IF v_identity IS NULL THEN PERFORM fleet_econ_bad('no such identity of yours'); END IF;
  END IF;
  IF fleet_econ_venture_ref(p_agent, a) IS NOT NULL THEN v_venture := fleet_econ_venture_ref(p_agent, a)::uuid; END IF;
  INSERT INTO fleet_agent_accounts (account_id, agent_id, identity_id, venture_id, account_kind, platform, handle, status, origins, login_email)
    VALUES (gen_random_uuid(), p_agent, v_identity, v_venture, v_kind, v_platform, v_handle, 'creating', ARRAY[v_origin], v_email) RETURNING * INTO x;
  PERFORM fleet_event('account_registered', p_agent, p_agent, jsonb_build_object('accountId', x.account_id, 'platform', v_platform, 'origin', v_origin));
  RETURN jsonb_build_object('ok', true, 'accountId', x.account_id, 'origins', x.origins,
    'next', 'browser.open {url, accountId}; fill the password with {credential: "generate_password"}; then account.mark');
END $$;

CREATE FUNCTION fleet_econ_account_add_origin(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_agent_accounts; v_origin text := lower(fleet_econ_text(a, 'origin', 200, true));
BEGIN
  SELECT * INTO x FROM fleet_agent_accounts WHERE account_id = fleet_identity_uuid(a, 'accountId') AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such account of yours'; END IF;
  IF NOT fleet_origin_ok(v_origin) THEN RAISE EXCEPTION 'FLEET_ORIGIN_INVALID: origin is https://host[:port]'; END IF;
  IF v_origin = ANY (x.origins) THEN RETURN jsonb_build_object('ok', true, 'origins', x.origins); END IF;
  IF cardinality(x.origins) >= 10 THEN PERFORM fleet_econ_bad('an account has at most 10 origins'); END IF;
  UPDATE fleet_agent_accounts SET origins = origins || v_origin, updated_at = now() WHERE account_id = x.account_id RETURNING * INTO x;
  PERFORM fleet_event('account_origin_added', p_agent, p_agent, jsonb_build_object('accountId', x.account_id, 'origin', v_origin,
    'reason', left(fleet_econ_text(a, 'reason', 300), 300)));
  RETURN jsonb_build_object('ok', true, 'origins', x.origins);
END $$;

-- The one action-scoped human dependency of an account (opened on human_action_required, answered when it is active).
CREATE FUNCTION fleet_account_human_dependency(p_account uuid, p_status text, p_note text) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_agent_accounts; v_dep uuid;
BEGIN
  SELECT * INTO x FROM fleet_agent_accounts WHERE account_id = p_account;
  IF p_status = 'human_action_required' AND x.dependency_id IS NULL THEN
    v_dep := gen_random_uuid();
    INSERT INTO fleet_owner_requests (request_id, agent_id, idempotency_key, kind, action, title, detail, blocks_action)
      VALUES (v_dep, x.agent_id, 'identity:' || x.account_id, 'human_identity', left(format('%s account (%s)', x.platform, COALESCE(x.handle, 'new account')), 200),
              left(format('Human action required on %s', x.platform), 200),
              left('A step only a human can do. Only this account waits; every other account and action continues. ' || COALESCE(fleet_scrub(p_note), ''), 2000), true)
      ON CONFLICT DO NOTHING;
    UPDATE fleet_agent_accounts SET dependency_id = v_dep WHERE account_id = x.account_id;
  ELSIF p_status = 'active' AND x.dependency_id IS NOT NULL THEN
    UPDATE fleet_owner_requests SET status = 'answered', decided_by = x.agent_id, decided_at = now(), response = 'Completed.'
     WHERE request_id = x.dependency_id AND status = 'pending';
  END IF;
END $$;

-- The agent records what its browser work established about its own account.
CREATE FUNCTION fleet_econ_account_mark(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_agent_accounts; v_status text := fleet_econ_text(a, 'status', 30, true); v_ver text := fleet_econ_text(a, 'verification', 30);
        v_note text := fleet_econ_text(a, 'note', 300);
BEGIN
  SELECT * INTO x FROM fleet_agent_accounts WHERE account_id = fleet_identity_uuid(a, 'accountId') AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such account of yours'; END IF;
  IF v_status NOT IN ('active','pending_verification','human_action_required','suspended','closed','failed') THEN
    PERFORM fleet_econ_bad('status is active|pending_verification|human_action_required|suspended|closed|failed');
  END IF;
  IF v_ver IS NOT NULL AND v_ver NOT IN ('none','email_pending','email_verified','identity_pending','identity_verified','identity_rejected') THEN
    PERFORM fleet_econ_bad('verification is none|email_pending|email_verified|identity_pending|identity_verified|identity_rejected');
  END IF;
  UPDATE fleet_agent_accounts SET status = v_status, verification = COALESCE(v_ver, verification), status_reason = COALESCE(left(fleet_scrub(v_note), 300), status_reason),
         closed_at = CASE WHEN v_status = 'closed' THEN now() ELSE closed_at END, updated_at = now() WHERE account_id = x.account_id RETURNING * INTO x;
  -- A genuinely human-only step (CAPTCHA, liveness, a fresh signature) becomes ONE action-scoped dependency; Admin is told.
  PERFORM fleet_account_human_dependency(x.account_id, v_status, v_note);
  PERFORM fleet_event('account_marked', p_agent, p_agent, jsonb_build_object('accountId', x.account_id, 'status', v_status, 'verification', v_ver));
  RETURN jsonb_build_object('ok', true, 'account', fleet_identity_account_json(x));
END $$;

${DISPATCH}

-- ═══ 5. Browser worker protocol (bx_*; role fleet_browser) ═══
CREATE FUNCTION bx_ping() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('schemaVersion', (SELECT max(version) FROM fleet_schema_migrations),
    'queued', (SELECT count(*) FROM fleet_browser_actions WHERE status = 'queued'))
$$;

CREATE FUNCTION bx_claim_action(p_worker text, p_lease_sha256 text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_browser_actions; s fleet_browser_sessions; acc fleet_agent_accounts;
BEGIN
  IF p_worker !~ '^[a-z0-9_.-]{1,64}$' OR p_lease_sha256 !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  -- Actions of the same session run in order: only the oldest queued action of a session with nothing claimed.
  SELECT a.* INTO x FROM fleet_browser_actions a WHERE a.status = 'queued'
     AND NOT EXISTS (SELECT 1 FROM fleet_browser_actions b WHERE b.session_id = a.session_id AND b.status = 'claimed')
     AND NOT EXISTS (SELECT 1 FROM fleet_browser_actions c WHERE c.session_id = a.session_id AND c.status = 'queued' AND c.created_at < a.created_at)
   ORDER BY a.created_at LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', true, 'action', NULL); END IF;
  UPDATE fleet_browser_actions SET status = 'claimed', claimed_by = p_worker, claimed_at = now(), lease_sha256 = p_lease_sha256 WHERE action_id = x.action_id;
  SELECT * INTO s FROM fleet_browser_sessions WHERE session_id = x.session_id;
  SELECT * INTO acc FROM fleet_agent_accounts WHERE account_id = s.account_id;
  RETURN jsonb_build_object('ok', true, 'action', jsonb_strip_nulls(jsonb_build_object('actionId', x.action_id, 'sessionId', x.session_id, 'agentId', x.agent_id,
    'kind', x.kind, 'steps', x.steps, 'sessionStatus', s.status, 'accountId', s.account_id, 'origins', to_jsonb(acc.origins))));
END $$;

CREATE FUNCTION bx_leased(p_action uuid, p_lease text) RETURNS fleet_browser_actions LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_browser_actions;
BEGIN
  SELECT * INTO x FROM fleet_browser_actions WHERE action_id = p_action;
  IF NOT FOUND OR x.status <> 'claimed' OR p_lease IS NULL OR encode(sha256(convert_to(p_lease, 'UTF8')), 'hex') <> x.lease_sha256 THEN
    RAISE EXCEPTION 'FLEET_LEASE_INVALID: no claimed browser action under this lease';
  END IF;
  RETURN x;
END $$;

CREATE FUNCTION bx_report_action(p_action uuid, p_lease text, p_ok boolean, p_result jsonb, p_url text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_browser_actions := bx_leased(p_action, p_lease);
BEGIN
  UPDATE fleet_browser_actions SET status = CASE WHEN p_ok THEN 'done' ELSE 'failed' END, finished_at = now(),
         result = CASE WHEN jsonb_typeof(p_result) = 'object' AND length(p_result::text) <= 200000 THEN p_result ELSE jsonb_build_object('error', 'result too large') END
   WHERE action_id = x.action_id;
  UPDATE fleet_browser_sessions SET url = COALESCE(left(p_url, 2000), url), last_used_at = now(),
         status = CASE WHEN x.kind = 'close' OR (p_result ->> 'code') = 'FLEET_BROWSER_SESSION_LOST' THEN CASE WHEN x.kind = 'close' THEN 'closed' ELSE 'expired' END ELSE status END,
         closed_at = CASE WHEN x.kind = 'close' OR (p_result ->> 'code') = 'FLEET_BROWSER_SESSION_LOST' THEN COALESCE(closed_at, now()) ELSE closed_at END
   WHERE session_id = x.session_id;
  RETURN jsonb_build_object('ok', true);
END $$;

-- A credential request is answered only for the session's account and only on one of its pinned origins.
CREATE FUNCTION bx_secret_request(p_action uuid, p_lease text, p_kind text, p_origin text, p_worker_pub text, p_sealed_in bytea) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_browser_actions := bx_leased(p_action, p_lease); s fleet_browser_sessions; acc fleet_agent_accounts; v_id uuid := gen_random_uuid(); v_kind text := p_kind; v_capture text;
BEGIN
  SELECT * INTO s FROM fleet_browser_sessions WHERE session_id = x.session_id;
  IF s.account_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BROWSER_NO_ACCOUNT'); END IF;
  SELECT * INTO acc FROM fleet_agent_accounts WHERE account_id = s.account_id;
  IF acc.agent_id <> x.agent_id THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CREDENTIAL_SCOPE'); END IF;
  IF NOT (lower(p_origin) = ANY (acc.origins)) THEN
    PERFORM fleet_event('browser_credential_refused', x.agent_id, 'browser-worker', jsonb_build_object('accountId', acc.account_id, 'origin', left(p_origin, 200), 'kind', p_kind));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ORIGIN_NOT_PINNED');
  END IF;
  IF p_kind LIKE 'capture:%' THEN v_capture := substr(p_kind, 9); v_kind := 'capture'; END IF;
  INSERT INTO fleet_browser_secret_requests (request_id, action_id, agent_id, account_id, kind, capture_kind, origin, worker_pub, sealed_in)
    VALUES (v_id, x.action_id, x.agent_id, acc.account_id, v_kind, v_capture, lower(p_origin), p_worker_pub, p_sealed_in);
  RETURN jsonb_build_object('ok', true, 'requestId', v_id);
END $$;

CREATE FUNCTION bx_secret_take(p_request uuid, p_action uuid, p_lease text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_browser_actions := bx_leased(p_action, p_lease); r fleet_browser_secret_requests; v bytea;
BEGIN
  SELECT * INTO r FROM fleet_browser_secret_requests WHERE request_id = p_request AND action_id = x.action_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF r.status = 'pending' AND r.expires_at > now() THEN RETURN jsonb_build_object('ok', true, 'status', 'pending'); END IF;
  IF r.status IN ('pending','served') AND r.expires_at <= now() THEN
    UPDATE fleet_browser_secret_requests SET status = 'expired', sealed = NULL, sealed_in = NULL WHERE request_id = p_request;
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SECRET_EXPIRED');
  END IF;
  IF r.status <> 'served' THEN RETURN jsonb_build_object('ok', false, 'code', COALESCE(r.error, 'FLEET_SECRET_' || upper(r.status))); END IF;
  v := r.sealed;
  UPDATE fleet_browser_secret_requests SET status = 'taken', sealed = NULL, sealed_in = NULL WHERE request_id = p_request;
  RETURN jsonb_build_object('ok', true, 'status', 'served', 'sealedB64', encode(v, 'base64'));
END $$;

-- The broker's published owner-vault public key (not secret): captured page secrets are sealed to it.
CREATE FUNCTION bx_broker_key() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE((SELECT jsonb_build_object('ownerPub', owner_pub, 'fingerprint', fingerprint) FROM fleet_identity_broker_keys WHERE id = 1), jsonb_build_object('ownerPub', NULL))
$$;

-- ═══ 6. Broker side (ix_*) ═══
CREATE FUNCTION ix_auth_blob_store(p_kind text, p_message uuid, p_worker text, p_blob bytea) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_agent text; v_addr text;
BEGIN
  IF p_kind = 'mail' THEN SELECT m.agent_id, b.address INTO v_agent, v_addr FROM fleet_agent_mail m JOIN fleet_agent_mailboxes b ON b.mailbox_id = m.mailbox_id WHERE m.message_id = p_message AND m.withheld;
  ELSIF p_kind = 'sms' THEN SELECT s.agent_id, n.e164 INTO v_agent, v_addr FROM fleet_agent_sms s JOIN fleet_agent_phone_numbers n ON n.number_id = s.number_id WHERE s.sms_id = p_message AND s.withheld;
  END IF;
  IF v_agent IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  INSERT INTO fleet_auth_message_blobs (kind, message_id, agent_id, address, blob) VALUES (p_kind, p_message, v_agent, v_addr, p_blob) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE FUNCTION ix_browser_secrets_pending(p_worker text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  UPDATE fleet_browser_secret_requests SET status = 'expired', sealed = NULL, sealed_in = NULL WHERE status IN ('pending','served') AND expires_at <= now();
  UPDATE fleet_auth_message_blobs SET blob = NULL WHERE blob IS NOT NULL AND created_at < now() - interval '24 hours';
  RETURN COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('requestId', r.request_id, 'kind', r.kind, 'captureKind', r.capture_kind,
      'agentId', r.agent_id, 'accountId', r.account_id, 'workerPub', r.worker_pub, 'sealedInB64', encode(r.sealed_in, 'base64'),
      'handle', x.handle, 'loginEmail', x.login_email,
      'credentials', COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', c.kind, 'vaultRef', c.vault_ref)) FROM fleet_agent_account_credentials c
                                WHERE c.account_id = r.account_id AND c.status = 'active'), '[]'::jsonb),
      'authMessages', CASE WHEN r.kind IN ('email_code','sms_code','auth_link') THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', b.kind, 'messageId', b.message_id,
            'blobB64', encode(b.blob, 'base64')) ORDER BY b.created_at DESC) FROM (
          SELECT * FROM fleet_auth_message_blobs b WHERE b.agent_id = r.agent_id AND b.blob IS NOT NULL AND b.used_at IS NULL AND b.created_at > now() - interval '30 minutes'
             AND ((r.kind IN ('email_code','auth_link') AND b.kind = 'mail' AND (x.login_email IS NULL OR lower(b.address) = x.login_email))
               OR (r.kind = 'sms_code' AND b.kind = 'sms'))
           ORDER BY b.created_at DESC LIMIT 3) b), '[]'::jsonb) END)) ORDER BY r.created_at)
    FROM fleet_browser_secret_requests r JOIN fleet_agent_accounts x ON x.account_id = r.account_id
   WHERE r.status = 'pending' AND r.expires_at > now()), '[]'::jsonb);
END $$;

CREATE FUNCTION ix_browser_secret_serve(p_request uuid, p_worker text, p_sealed bytea, p_error text, p_used_message uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  UPDATE fleet_browser_secret_requests SET status = CASE WHEN p_sealed IS NULL THEN 'failed' ELSE 'served' END, sealed = p_sealed, sealed_in = NULL,
         error = left(p_error, 120) WHERE request_id = p_request AND status = 'pending' AND expires_at > now();
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF p_used_message IS NOT NULL THEN UPDATE fleet_auth_message_blobs SET used_at = now(), blob = NULL WHERE message_id = p_used_message; END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- A generated password or a captured secret becomes the account's credential (the previous one of that kind retires).
CREATE FUNCTION ix_browser_credential_record(p_request uuid, p_worker text, p_kind text, p_vault_ref text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_browser_secret_requests;
BEGIN
  SELECT * INTO r FROM fleet_browser_secret_requests WHERE request_id = p_request AND status = 'pending' AND kind IN ('generate_password','capture');
  IF NOT FOUND OR p_kind NOT IN ('password','api_key','recovery_codes','totp') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  UPDATE fleet_agent_account_credentials SET status = 'rotated', retired_at = now() WHERE account_id = r.account_id AND kind = p_kind AND status = 'active';
  INSERT INTO fleet_agent_account_credentials (credential_id, account_id, agent_id, kind, vault_ref) VALUES (gen_random_uuid(), r.account_id, r.agent_id, p_kind, p_vault_ref);
  UPDATE fleet_agent_accounts SET credential_health = 'ok', updated_at = now() WHERE account_id = r.account_id;
  PERFORM fleet_event('browser_credential_stored', r.agent_id, 'identity-broker', jsonb_build_object('accountId', r.account_id, 'kind', p_kind));
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE FUNCTION fleet_hub_browser(p_agent text) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'sessions', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.created_at DESC) FROM (SELECT * FROM fleet_browser_sessions WHERE p_agent IS NULL OR agent_id = p_agent
        ORDER BY created_at DESC LIMIT 50) s), '[]'::jsonb),
    'actions24h', (SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) n FROM fleet_browser_actions WHERE created_at > now() - interval '24 hours'
        AND (p_agent IS NULL OR agent_id = p_agent) GROUP BY status) z),
    'credentialRequests24h', (SELECT jsonb_object_agg(kind || ':' || status, n) FROM (SELECT kind, status, count(*) n FROM fleet_browser_secret_requests
        WHERE created_at > now() - interval '24 hours' AND (p_agent IS NULL OR agent_id = p_agent) GROUP BY kind, status) z),
    'refusedOrigins', COALESCE((SELECT jsonb_agg(e.detail ORDER BY e.created_at DESC) FROM (SELECT * FROM fleet_events WHERE event_type = 'browser_credential_refused'
        AND (p_agent IS NULL OR agent_id = p_agent) ORDER BY created_at DESC LIMIT 20) e), '[]'::jsonb))
$$;
`;
