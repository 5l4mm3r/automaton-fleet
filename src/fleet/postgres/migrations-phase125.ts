/**
 * Schema v125 — what a signed operator read can see of a live run. To watch an agent and know it has stopped, the engineer needs the state that actually
 * stops it: pause, inference switch, hold, calls in flight, credit and its holds, the run's ceiling, sales, the spend breaker and the outward state. Read only:
 * its own route for Claude's bridge alone under the existing `ops.read.status` scope, so no new key and no new authority; `fleet_status` is unchanged.
 */
import { V37_SQL } from "./migrations-phase37.js";
import { V79_SQL } from "./migrations-phase79.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const IXWORKER = `IF p_worker IS NULL OR p_worker !~ '^[a-z0-9-]{3,40}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: worker name'; END IF;`;

export const V125_SQL = `
-- ═══ The owner hands an account to an agent ═══
-- The owner made the account; the login is sealed to the identity broker's key before it leaves the owner's hands, and the broker alone opens it. The agent can
-- use the account through the browser worker and never sees the password. Its origins are the owner's: an agent cannot add one, or replace the password.
ALTER TABLE fleet_agent_accounts ADD COLUMN owner_provided boolean NOT NULL DEFAULT false;

CREATE TABLE fleet_account_handover_inbox (
  upload_id    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid        NOT NULL REFERENCES fleet_agent_accounts(account_id),
  agent_id     text        NOT NULL REFERENCES fleet_agents(agent_id),
  sealed       bytea       CHECK (octet_length(sealed) BETWEEN 32 AND 64000),
  status       text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','installed','failed')),
  error        text        CHECK (length(error) <= 200),
  uploaded_by  text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  installed_at timestamptz,
  CHECK ((status = 'pending') = (sealed IS NOT NULL))
);
CREATE TRIGGER fleet_account_handover_inbox_no_delete BEFORE DELETE ON fleet_account_handover_inbox FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_admin_account_handover(p_agent text, p_kind text, p_platform text, p_origin text, p_handle text, p_sealed bytea, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_agent_accounts; v_id uuid;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_ACTOR_INVALID: an owner operation names its operator'; END IF;
  IF NOT EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = p_agent) THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such agent'; END IF;
  IF p_kind NOT IN ('domain','website','marketplace','storefront','social','service','api','payment_profile','other') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: kind'; END IF;
  IF lower(p_platform) !~ '^[a-z0-9][a-z0-9._-]{1,40}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: platform is a short slug such as the site''s host'; END IF;
  IF NOT fleet_origin_ok(lower(p_origin)) THEN RAISE EXCEPTION 'FLEET_ORIGIN_INVALID: origin is https://host[:port] of the site''s login pages'; END IF;
  IF p_sealed IS NULL OR octet_length(p_sealed) NOT BETWEEN 32 AND 64000 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a sealed login'; END IF;
  INSERT INTO fleet_agent_accounts (account_id, agent_id, account_kind, platform, handle, status, origins, owner_provided)
    VALUES (gen_random_uuid(), p_agent, p_kind, lower(p_platform), p_handle, 'creating', ARRAY[lower(p_origin)], true) RETURNING * INTO x;
  INSERT INTO fleet_account_handover_inbox (account_id, agent_id, sealed, uploaded_by) VALUES (x.account_id, p_agent, p_sealed, p_actor) RETURNING upload_id INTO v_id;
  PERFORM fleet_event('account_handed_over', p_agent, p_actor, jsonb_build_object('accountId', x.account_id, 'platform', x.platform, 'origin', lower(p_origin), 'uploadId', v_id));
  RETURN jsonb_build_object('ok', true, 'accountId', x.account_id, 'uploadId', v_id, 'note', 'the identity broker installs it within a minute; the agent is told when it is ready');
END $$;

CREATE FUNCTION ix_account_handover_inbox(p_worker text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  ${IXWORKER}
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('uploadId', upload_id, 'accountId', account_id, 'agentId', agent_id, 'sealedB64', encode(sealed, 'base64')) ORDER BY created_at)
    FROM fleet_account_handover_inbox WHERE status = 'pending'), '[]'::jsonb);
END $$;

-- The broker reports what it stored: references only. The sealed copy is erased either way; the owner hears of a failure, and the agent of a success.
CREATE FUNCTION ix_account_handover_installed(p_upload uuid, p_worker text, p_ok boolean, p_error text, p_refs jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_account_handover_inbox; x fleet_agent_accounts;
BEGIN
  ${IXWORKER}
  UPDATE fleet_account_handover_inbox SET status = CASE WHEN p_ok THEN 'installed' ELSE 'failed' END, sealed = NULL, error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 200) END, installed_at = now()
   WHERE upload_id = p_upload AND status = 'pending' RETURNING * INTO r;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF NOT p_ok THEN
    PERFORM fleet_notify('AMBER', 'ACCOUNT_HANDOVER_FAILED', r.agent_id, 'An account login you handed over could not be installed', jsonb_build_object('accountId', r.account_id, 'error', left(p_error, 200),
      'action', 'seal it again with economy-account-handover'), 'account-handover-failed:' || p_upload);
    RETURN jsonb_build_object('ok', true);
  END IF;
  INSERT INTO fleet_agent_account_credentials (credential_id, account_id, agent_id, kind, vault_ref)
    SELECT gen_random_uuid(), r.account_id, r.agent_id, e ->> 'kind', e ->> 'vaultRef' FROM jsonb_array_elements(p_refs) e WHERE e ->> 'kind' IN ('password','totp');
  UPDATE fleet_agent_accounts SET status = 'active', updated_at = now() WHERE account_id = r.account_id RETURNING * INTO x;
  PERFORM fleet_event('account_handover_installed', r.agent_id, 'identity-broker', jsonb_build_object('accountId', r.account_id, 'platform', x.platform));
  PERFORM fleet_admin_owner_task_send(r.agent_id, left('Your account on ' || x.platform || ' is ready', 120),
    format('The owner set up your account on %s (accountId %s, origin %s). Log in through the browser with {credential: "username"} and {credential: "password"}; you will never see the password. Outside work there needs the owner''s release first. Its login and origins are the owner''s: you cannot change them.', x.platform, x.account_id, x.origins[1]), r.uploaded_by);
  RETURN jsonb_build_object('ok', true);
END $$;

${restate(V37_SQL, "fleet_econ_account_add_origin", [[`  IF NOT fleet_origin_ok(v_origin) THEN RAISE EXCEPTION 'FLEET_ORIGIN_INVALID: origin is https://host[:port]'; END IF;`,
  `  IF x.owner_provided THEN RAISE EXCEPTION 'FLEET_OWNER_ACCOUNT: this account''s sites are the owner''s to set; your login is only ever filled on them'; END IF;
  IF NOT fleet_origin_ok(v_origin) THEN RAISE EXCEPTION 'FLEET_ORIGIN_INVALID: origin is https://host[:port]'; END IF;`]])}

${restate(V79_SQL, "fleet_econ_account_password_confirm", [[`  IF NOT EXISTS (SELECT 1 FROM fleet_agent_account_credentials WHERE account_id = x.account_id AND kind = 'password' AND status = 'pending') THEN`,
  `  IF x.owner_provided THEN RAISE EXCEPTION 'FLEET_OWNER_ACCOUNT: this account''s password is the owner''s: ask the owner to change it'; END IF;
  IF NOT EXISTS (SELECT 1 FROM fleet_agent_account_credentials WHERE account_id = x.account_id AND kind = 'password' AND status = 'pending') THEN`]])}

CREATE FUNCTION fleet_operator_containment() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'actionsEnabled', (SELECT operator_actions_enabled FROM fleet_operator_state WHERE id = 1),
    'cognitionEnabled', (SELECT cognition_enabled FROM fleet_cognition_policy WHERE id = 1),
    'salesOpen', fleet_sales_open(),
    'spendBreakerTripped', (SELECT tripped FROM fleet_spend_circuit_breaker WHERE id = 1),
    'inflightCalls', (SELECT count(*) FROM fleet_cognition_inflight),
    'credit', jsonb_build_object('provider', 'anthropic', 'balanceUsd1e8', fleet_provider_credit_balance('anthropic'), 'heldUsd1e8', fleet_provider_credit_held('anthropic'),
      'freeUsd1e8', fleet_provider_credit_balance('anthropic') - fleet_provider_credit_held('anthropic'),
      'holds', COALESCE((SELECT jsonb_agg(jsonb_build_object('runId', run_id, 'usd1e8', usd_microcents) ORDER BY run_id) FROM fleet_provider_credit_holds WHERE status = 'open'), '[]'::jsonb)),
    'agents', COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId', a.agent_id, 'paused', COALESCE(c.paused, false), 'held', a.operator_hold_at IS NOT NULL, 'outwardHeld', fleet_outward_held(a.agent_id),
        'calls24h', (SELECT count(*) FROM fleet_cognition_log l WHERE l.agent_id = a.agent_id AND l.at > now() - interval '1 day'),
        'lastCallAt', (SELECT max(l.at) FROM fleet_cognition_log l WHERE l.agent_id = a.agent_id),
        'openOwnerTasks', (SELECT count(*) FROM fleet_owner_tasks t WHERE t.agent_id = a.agent_id AND t.closed_at IS NULL),
        'run', (SELECT jsonb_build_object('ceilingMinor', b.ceiling_minor, 'endsAt', b.ends_at, 'spentMicro', (fleet_cognition_run_json(a.agent_id) ->> 'spentMicro')::bigint)
                  FROM fleet_cognition_run_budgets b WHERE b.agent_id = a.agent_id AND b.ended_at IS NULL)) ORDER BY a.agent_id)
      FROM fleet_agents a LEFT JOIN fleet_founder_cognition c ON c.agent_id = a.agent_id WHERE a.status IN ('active','unresponsive')), '[]'::jsonb))
$$;

ALTER TABLE fleet_operator_routes DROP CONSTRAINT fleet_operator_routes_fn_check;
ALTER TABLE fleet_operator_routes ADD CONSTRAINT fleet_operator_routes_fn_check CHECK (fn IN (
  'op_whoami','op_fleet_status','op_list_agents','op_get_agent','op_list_events',
  'op_lifecycle_health','op_runtime_status','op_list_reservations','op_list_orphans','op_list_proposals','op_list_actions','op_treasury_watch','op_containment',
  'op_act_hold_agent','op_act_release_agent_hold','op_act_request_health_challenge','op_act_revoke_agent_sessions',
  'op_act_reconcile_lifecycle','op_propose_agent_action'));
ALTER TABLE fleet_operator_routes DROP CONSTRAINT fleet_operator_routes_method_matches_fn;
ALTER TABLE fleet_operator_routes ADD CONSTRAINT fleet_operator_routes_method_matches_fn CHECK (
  (route LIKE 'GET %') = (fn IN ('op_whoami','op_fleet_status','op_list_agents','op_get_agent','op_list_events',
    'op_lifecycle_health','op_runtime_status','op_list_reservations','op_list_orphans','op_list_proposals','op_list_actions','op_treasury_watch','op_containment')));
-- Claude's bridge only: credit figures and agent state never go to the ChatGPT bridge, which shares the status scope.
INSERT INTO fleet_operator_routes (route, scope, fn, kinds) VALUES
  ('GET /v1/operator/containment', 'ops.read.status', 'op_containment', ARRAY['bridge_claude']);

CREATE FUNCTION op_containment(p_request uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_operator_requests;
BEGIN
  r := fleet_operator_request_ok(p_request, 'op_containment');
  RETURN fleet_operator_containment();
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
