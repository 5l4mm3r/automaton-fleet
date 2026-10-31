/**
 * Schema v126 — the owner's account handover, redesigned after two reviews (docs/evaluations/launch-candidate/external-run/ACTIVATION.md and owner-account-handover.md).
 * The login never enters the agent's browser. A single `sign_in` step, alone in its action, runs in a separate context on the login URL the owner pinned (browser/worker.ts); only the
 * session it produces reaches the agent. Here:
 *   - the login URL is pinned with the account, and a new URL or site takes effect only when the new login is installed: a failed or pending re-seal changes nothing;
 *   - the registry serves an owner's account only its name and email to a normal step, and its password or code only to an action that is one `sign_in`, a few times an hour;
 *   - verifying identity joins the operations an agent cannot run on the owner's account;
 *   - the broker is told which old logins to destroy.
 * The gate of v125 stays: fleet_account_handover_enabled() and its triggers remain the way to switch this off again.
 */
import { restate } from "./migrations-phase42.js";
import { V79_SQL } from "./migrations-phase79.js";
import { V80_SQL } from "./migrations-phase80.js";
import { V95_SQL } from "./migrations-phase95.js";
import { V125_SQL } from "./migrations-phase125.js";

const GATE = `(p_op IN ('account.revoke','account.rotate','account.recover','account.close','account.operate','account.password_discard')`;
export const SIGN_INS_PER_HOUR = 5;

const HANDOVER = restate(V125_SQL, "fleet_admin_account_handover", [
  [`DECLARE x fleet_agent_accounts; v_id uuid;`, `DECLARE x fleet_agent_accounts; v_id uuid; v_url text := btrim(p_origin); v_origin text;`],
  [`  IF NOT fleet_origin_ok(lower(p_origin)) THEN RAISE EXCEPTION 'FLEET_ORIGIN_INVALID: origin is https://host[:port] of the site''s login pages'; END IF;`,
   `  v_origin := lower(substring(v_url from '^[A-Za-z]+://[^/?#]+'));
  IF v_origin IS NULL OR NOT fleet_origin_ok(v_origin) OR v_url ~ '[?#[:space:]]' OR length(v_url) > 300 THEN RAISE EXCEPTION 'FLEET_ORIGIN_INVALID: this is the https address of the site''s sign-in page, with no query'; END IF;
  IF substr(v_url, length(v_origin) + 1) !~ '^/.' OR v_origin LIKE '%:443' THEN RAISE EXCEPTION 'FLEET_ORIGIN_INVALID: give the sign-in page itself, such as https://www.example.com/login, without a default port'; END IF;
  v_url := v_origin || substr(v_url, length(v_origin) + 1);`],
  [`ARRAY[lower(p_origin)], true) RETURNING * INTO x;`, `ARRAY[v_origin], true) RETURNING * INTO x;`],
  [`    UPDATE fleet_agent_accounts SET origins = ARRAY[lower(p_origin)], updated_at = now() WHERE account_id = x.account_id RETURNING * INTO x;`,
   `    NULL; -- the account keeps its site and sign-in page until the new login is installed.`],
  [`INSERT INTO fleet_account_handover_inbox (account_id, agent_id, sealed, uploaded_by) VALUES (x.account_id, p_agent, p_sealed, p_actor)`,
   `INSERT INTO fleet_account_handover_inbox (account_id, agent_id, sealed, uploaded_by, login_url) VALUES (x.account_id, p_agent, p_sealed, p_actor, v_url)`],
  [`'origin', lower(p_origin), 'uploadId', v_id`, `'origin', v_origin, 'uploadId', v_id`],
]);

export const V126_SQL = `
ALTER TABLE fleet_account_handover_inbox ADD COLUMN login_url text CHECK (login_url IS NULL OR length(login_url) <= 300);
ALTER TABLE fleet_agent_accounts ADD COLUMN login_url text CHECK (login_url IS NULL OR length(login_url) <= 300);

${HANDOVER}

${restate(V125_SQL, "ix_account_handover_inbox", [
  [`  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('uploadId', upload_id, 'accountId', account_id, 'agentId', agent_id, 'sealedB64', encode(sealed, 'base64')) ORDER BY created_at)
    FROM fleet_account_handover_inbox WHERE status = 'pending'), '[]'::jsonb);`,
   `  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('uploadId', i.upload_id, 'accountId', i.account_id, 'agentId', i.agent_id, 'sealedB64', encode(i.sealed, 'base64'),
      'platform', x.platform, 'handle', x.handle, 'loginUrl', i.login_url) ORDER BY i.created_at)
    FROM fleet_account_handover_inbox i JOIN fleet_agent_accounts x USING (account_id) WHERE i.status = 'pending'), '[]'::jsonb);`],
])}

${restate(V125_SQL, "ix_account_handover_installed", [
  [`DECLARE r fleet_account_handover_inbox; x fleet_agent_accounts;`, `DECLARE r fleet_account_handover_inbox; x fleet_agent_accounts; v_retired jsonb;`],
  [`  UPDATE fleet_agent_account_credentials SET status = 'rotated', retired_at = now() WHERE account_id = r.account_id AND kind IN ('password','totp') AND status = 'active';`,
   `  WITH u AS (UPDATE fleet_agent_account_credentials SET status = 'rotated', retired_at = now() WHERE account_id = r.account_id AND kind IN ('password','totp') AND status = 'active' RETURNING vault_ref)
    SELECT COALESCE(jsonb_agg(vault_ref), '[]'::jsonb) INTO v_retired FROM u;`],
  [`UPDATE fleet_agent_accounts SET status = CASE WHEN status = 'creating' THEN 'active' ELSE status END, updated_at = now() WHERE account_id = r.account_id RETURNING * INTO x;`,
   `UPDATE fleet_agent_accounts SET status = CASE WHEN status = 'creating' THEN 'active' ELSE status END, login_url = r.login_url,
         origins = ARRAY[lower(substring(r.login_url from '^[A-Za-z]+://[^/?#]+'))], updated_at = now() WHERE account_id = r.account_id RETURNING * INTO x;`],
  [`Log in through the browser with {credential: "username"} and {credential: "password"}; you will never see the password.`,
   `Sign in with a browser act of exactly one step, {action: "sign_in"}, in a session opened with this accountId: the system signs in where you cannot see the login, and your session is then signed in. If it reports FLEET_SIGNIN_HUMAN, a person is needed: record that. You can work in that session as usual.`],
  [`  END;
  RETURN jsonb_build_object('ok', true);`, `  END;
  RETURN jsonb_build_object('ok', true, 'retired', v_retired);`],
])}

${restate(V125_SQL, "api_economy", [[GATE, `(p_op IN ('account.revoke','account.rotate','account.recover','account.close','account.operate','account.password_discard','account.verify_identity')`],
  [`  IF (p_op IN ('account.revoke',`, `  -- v126: a frozen account stops work, including in a session already signed in.
  IF p_op IN ('browser.act','browser.observe') AND EXISTS (SELECT 1 FROM fleet_browser_sessions bs JOIN fleet_agent_accounts x ON x.account_id = bs.account_id
       WHERE bs.session_id::text = a ->> 'sessionId' AND bs.agent_id = p_agent AND x.owner_provided AND x.status = 'frozen') THEN
    RAISE EXCEPTION 'FLEET_ACCOUNT_FROZEN: the owner froze this account';
  END IF;
  IF (p_op IN ('account.revoke',`]])}

${restate(V80_SQL, "bx_claim_action", [
  [`'accountId', s.account_id, 'origins', to_jsonb(acc.origins),`, `'accountId', s.account_id, 'origins', to_jsonb(acc.origins), 'ownerAccount', CASE WHEN acc.owner_provided THEN true END, 'loginUrl', CASE WHEN acc.owner_provided THEN acc.login_url END,`],
])}

${restate(V95_SQL, "bx_secret_request", [
  [`  IF p_kind LIKE 'capture:%' THEN v_capture`, `  -- v126: this does not rely on the worker. An owner's login goes only to an action that is one sign_in, a few times an hour (a site locks an account out); nothing is generated, captured or opened from a link.
  IF acc.owner_provided THEN
    IF p_kind NOT IN ('password','username','email','totp')
       OR (p_kind IN ('password','totp') AND NOT (jsonb_array_length(x.steps) = 1 AND x.steps -> 0 ->> 'action' = 'sign_in')) THEN
      PERFORM fleet_event('browser_credential_refused', x.agent_id, 'browser-worker', jsonb_build_object('accountId', acc.account_id, 'origin', left(p_origin, 200), 'kind', left(p_kind, 40)));
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_OWNER_ACCOUNT');
    END IF;
    IF acc.status = 'frozen' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ACCOUNT_FROZEN'); END IF;
    IF p_kind = 'password' AND (SELECT count(*) FROM fleet_browser_secret_requests q WHERE q.account_id = acc.account_id AND q.kind = 'password' AND q.created_at > now() - interval '1 hour') >= ${SIGN_INS_PER_HOUR} THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SIGNIN_LIMIT');
    END IF;
  END IF;
  IF p_kind LIKE 'capture:%' THEN v_capture`],
])}

${restate(V79_SQL, "fleet_browser_steps_valid", [
  [`'tab','dialog') THEN`, `'tab','dialog','sign_in') THEN`],
  [`    IF v_a = 'set_content' AND`, `    IF v_a = 'sign_in' AND (NOT p_has_account OR jsonb_array_length(p_steps) <> 1) THEN
      PERFORM fleet_econ_bad('sign_in is the only step of an action, in a session opened with an account');
    END IF;
    IF v_a = 'set_content' AND`],
])}

CREATE OR REPLACE FUNCTION fleet_account_handover_enabled() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
`;
