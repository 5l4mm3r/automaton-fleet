/**
 * Schema v89 — software maintenance on a customer's code, offered only for what is demonstrated (owner, 2026-10-16:
 * "complete the scoped repository access, isolated build/test environment, customer permission and recovery
 * prerequisites ... offers must depend on demonstrated capabilities for the actual scope; no permanent blanket ban").
 *
 * CUSTOMER PERMISSION: the agent asks (code.request_access: the enquiry or order, the repository, its base branch, the
 * purpose, how long). The customer sees the request on their own enquiry / order page with the exact terms, types the
 * repository's name and consents; the wording they saw is kept with the consent. Then they install the Fleet's GitHub App
 * on that repository (GitHub only lets the repository's administrators do that). Access becomes ACTIVE only when the
 * consent and the installation name the same repository; it ends when its duration ends, when the customer uninstalls the
 * app, or when the owner revokes it.
 *
 * SCOPED ACCESS (the code gateway, role fleet_code, cgx_*): it alone holds the app's key; per job it mints a token for that
 * one repository with contents + pull-request permissions; it reads snapshots, and writes ONLY a new fleet/<id>-<n>
 * branch and a pull request to the consented base branch. Never the base branch, never a force-push, never a merge.
 *
 * ISOLATED BUILD / TEST (the build environment, role fleet_build, bbx_*): no credentials of any kind; runs the agent's
 * commands on a snapshot (+ the agent's patch) in a throwaway directory, reaching the internet only through the Fleet's
 * egress proxy (package registries only); output and exit code recorded.
 *
 * RECOVERY: every change is a pull request from a recorded base commit; nothing is merged by the Fleet; the customer reverts
 * by closing or reverting the pull request; a proposal requires a passing build of exactly that patch.
 *
 * DEMONSTRATED SCOPE: a capability check naming an enquiry with a `pull_request` deliverable is ready only when the code
 * gateway and build environment are connected, the customer's access for THAT enquiry is active, and a baseline build of
 * that repository has passed (the agent showed it can build and test it). Publishing a code-maintenance offer needs the
 * gateway and build environment connected. Until they are, agents are told it is not available.
 */
import { V87_SQL } from "./migrations-phase87.js";
import { V88_SQL } from "./migrations-phase88.js";
import { restate } from "./migrations-phase42.js";
import { KNOWLEDGE_FOUNDATION_V2 } from "./knowledge-foundation-v2.js";

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
export const REPO_ACCESS_WORDING_VERSION = "repo-access-1";
/** What the customer agrees to (shown on their page; kept with the consent). Placeholders: {seller} {repo} {branch} {days} {purpose}. */
export const REPO_ACCESS_WORDING = [
  "I authorise {seller} (an autonomous AI agent of the Automaton Fleet) to read the GitHub repository {repo} and to propose changes to it for this purpose: {purpose}.",
  "Access is through the Fleet's GitHub App, which I install on this repository only. It lasts at most {days} days and ends earlier if I uninstall the app.",
  "Changes arrive only as a new branch and a pull request to {branch}; nothing is merged or pushed to {branch} without me. I can revert by closing or reverting the pull request.",
  "A copy of the code is held in the Fleet's private systems only for this work. Builds and tests run in an isolated environment with no credentials.",
].join(" ");
export const CODE_JOB_KINDS = ["snapshot", "build", "propose"] as const;
export const REPO_STATUSES = ["requested", "consented", "active", "revoked", "expired"] as const;
export const SNAPSHOT_MAX_BYTES = 20_000_000;
export const PATCH_MAX_BYTES = 1_000_000;
export const AGENT_OPS_V89 = ["code.request_access", "code.access", "code.snapshot", "code.build", "code.propose", "code.job"] as const;
export const CODE_API_FUNCTIONS_V89 = ["cgx_report(text, boolean, jsonb)", "cgx_authorizations(integer)", "cgx_activate(uuid, bigint, text)", "cgx_end(uuid, text)",
  "cgx_claim(integer)", "cgx_result(uuid, boolean, jsonb, bytea, text)"] as const;
export const BUILD_API_FUNCTIONS_V89 = ["bbx_report(boolean, jsonb)", "bbx_claim(integer)", "bbx_result(uuid, boolean, jsonb, text)"] as const;
export const PUBLIC_PAGE_FUNCTIONS_V89 = ["svc_repo_requests", "svc_repo_consent"] as const;
export const DASHBOARD_READ_OPS_V89 = ["code"] as const;
export const DASHBOARD_WRITE_OPS_V89_ADDED = ["repo_access_revoke"] as const;
export const LIBRARY_ENTRIES_V89 = ["fleet-capability-status", "bf-initial-focus"] as const;

const DISPATCH = restate(V87_SQL, "api_economy", [
  [`WHEN 'media.result' THEN 'planning'`, `WHEN 'media.result' THEN 'planning' ${AGENT_OPS_V89.map((o) => `WHEN '${o}' THEN 'planning'`).join(" ")}`],
  [`      WHEN 'card.awaiting_approval' THEN fleet_econ_card_awaiting_approval(p_agent, a)`, `      WHEN 'card.awaiting_approval' THEN fleet_econ_card_awaiting_approval(p_agent, a)
      WHEN 'code.request_access' THEN fleet_econ_code_request_access(p_agent, a)
      WHEN 'code.access' THEN fleet_econ_code_access(p_agent, a)
      WHEN 'code.snapshot' THEN fleet_econ_code_job(p_agent, 'snapshot', a)
      WHEN 'code.build' THEN fleet_econ_code_job(p_agent, 'build', a)
      WHEN 'code.propose' THEN fleet_econ_code_job(p_agent, 'propose', a)
      WHEN 'code.job' THEN fleet_econ_code_job_result(p_agent, a)`],
]);
const DASH_CALL = restate(V87_SQL, "dash_call", [
  [`'launch','helpers','push','capabilities','locations')) THEN`, `'launch','helpers','push','capabilities','locations',${q(DASHBOARD_READ_OPS_V89)})) THEN`],
  [`      WHEN 'locations' THEN fleet_locations_json()`, `      WHEN 'locations' THEN fleet_locations_json()
      WHEN 'code' THEN fleet_code_json()`],
  [`'card_dispute_open','card_dispute_resolve','media_job_resolve');`, `'card_dispute_open','card_dispute_resolve','media_job_resolve',${q(DASHBOARD_WRITE_OPS_V89_ADDED)});`],
  [`      WHEN 'media_job_resolve' THEN`, `      WHEN 'repo_access_revoke' THEN fleet_admin_repo_access_revoke((a ->> 'authorizationId')::uuid, a ->> 'reason', 'operator:owner')
      WHEN 'media_job_resolve' THEN`],
]);
// A check passes its target to the deliverable verdicts.
const CHECK = restate(V87_SQL, "fleet_econ_capabilities_check", [
  [`      verdicts := verdicts || jsonb_build_array(fleet_deliverable_verdict(d, st, rt));`,
   `      verdicts := verdicts || jsonb_build_array(fleet_deliverable_verdict(d, st || jsonb_build_object('_agent', p_agent, '_targetKind', v_kind, '_targetId', v_target), rt));`],
]);
const OPS_WATCH = restate(V88_SQL, "svc_operations_watch", [
  [`  rec := fleet_treasury_reconciliation();`, `  -- v89: customer repository access past its duration ends.
  UPDATE fleet_repo_authorizations SET status = 'expired', updated_at = now() WHERE status IN ('requested','consented','active') AND expires_at < now();
  rec := fleet_treasury_reconciliation();`],
]);

// The two functions v89 wraps keep their previous bodies under a versioned name (renamed before redefinition).
const V89_PRE_SQL = `
ALTER FUNCTION fleet_agent_capability_states(text) RENAME TO fleet_agent_capability_states_v85;
ALTER FUNCTION fleet_deliverable_verdict(jsonb, jsonb, jsonb) RENAME TO fleet_deliverable_verdict_v87;
`;

export const V89_SQL = V89_PRE_SQL + `
-- ═══ 1. The two services and the customer's access ═══
CREATE TABLE fleet_code_services (
  kind          text        PRIMARY KEY CHECK (kind IN ('gateway','build')),
  provider      text        NOT NULL CHECK (provider ~ '^[a-z0-9_-]{2,40}$'),
  configured    boolean     NOT NULL DEFAULT false,
  detail        jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND length(detail::text) <= 2000),
  last_seen_at  timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fleet_repo_authorizations (
  authorization_id uuid       PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       text        NOT NULL REFERENCES fleet_agents(agent_id),
  enquiry_id     uuid        REFERENCES fleet_offer_enquiries(enquiry_id),
  order_id       uuid        REFERENCES fleet_customer_orders(order_id),
  provider       text        NOT NULL DEFAULT 'github' CHECK (provider IN ('github')),
  repo           text        NOT NULL CHECK (repo ~ '^[A-Za-z0-9_.-]{1,39}/[A-Za-z0-9_.-]{1,100}$'),
  base_branch    text        NOT NULL CHECK (base_branch ~ '^[A-Za-z0-9._/-]{1,100}$' AND base_branch !~ '\\.\\.'),
  purpose        text        NOT NULL CHECK (length(purpose) BETWEEN 10 AND 600),
  duration_days  integer     NOT NULL CHECK (duration_days BETWEEN 1 AND 90),
  status         text        NOT NULL DEFAULT 'requested' CHECK (status IN (${q(REPO_STATUSES)})),
  wording_version text,
  wording        text        CHECK (length(wording) <= 3000),
  consented_at   timestamptz,
  consent_name   text        CHECK (length(consent_name) BETWEEN 1 AND 140),
  consent_origin text        CHECK (consent_origin ~ '^[0-9a-f]{64}$'),
  installation_id bigint     CHECK (installation_id > 0),
  activated_at   timestamptz,
  expires_at     timestamptz NOT NULL,
  ended_at       timestamptz,
  end_reason     text        CHECK (length(end_reason) <= 300),
  baseline_build_job uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((enquiry_id IS NULL) <> (order_id IS NULL)),
  CHECK (status NOT IN ('consented','active') OR (consented_at IS NOT NULL AND wording IS NOT NULL)),
  CHECK (status <> 'active' OR installation_id IS NOT NULL)
);
CREATE INDEX fleet_repo_authorizations_agent ON fleet_repo_authorizations (agent_id, created_at DESC);
CREATE TRIGGER fleet_repo_authorizations_no_delete BEFORE DELETE ON fleet_repo_authorizations FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_code_jobs (
  job_id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        text        NOT NULL REFERENCES fleet_agents(agent_id),
  authorization_id uuid       NOT NULL REFERENCES fleet_repo_authorizations(authorization_id),
  kind            text        NOT NULL CHECK (kind IN (${q(CODE_JOB_KINDS)})),
  request         jsonb       NOT NULL CHECK (jsonb_typeof(request) = 'object' AND length(request::text) <= 4000),
  patch           text        CHECK (octet_length(patch) <= ${PATCH_MAX_BYTES}),
  patch_sha256    text        CHECK (patch_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot_job    uuid        REFERENCES fleet_code_jobs(job_id),
  idempotency_key text        NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  status          text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  result          jsonb       CHECK (result IS NULL OR length(result::text) <= 200000),
  payload         bytea       CHECK (payload IS NULL OR octet_length(payload) <= ${SNAPSHOT_MAX_BYTES}),
  error           text        CHECK (length(error) <= 300),
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  fetched_at      timestamptz,
  UNIQUE (agent_id, idempotency_key)
);
CREATE INDEX fleet_code_jobs_queue ON fleet_code_jobs (kind, created_at) WHERE status = 'queued';
CREATE TRIGGER fleet_code_jobs_no_delete BEFORE DELETE ON fleet_code_jobs FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

INSERT INTO fleet_deliverable_formats VALUES ('pull_request', 'x-fleet/pull-request', '');

-- ═══ 2. The agent asks; the customer consents on their own page ═══
CREATE FUNCTION fleet_econ_code_request_access(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_enq uuid; v_ord uuid; v uuid; v_repo text := btrim(COALESCE(a ->> 'repo', '')); v_days integer;
BEGIN
  IF a ? 'enquiryId' THEN
    SELECT enquiry_id INTO v_enq FROM fleet_offer_enquiries WHERE enquiry_id = fleet_identity_uuid(a, 'enquiryId') AND agent_id = p_agent AND status IN ('new','clarifying','quoted','accepted');
    IF v_enq IS NULL THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: enquiryId — one of your open enquiries'; END IF;
  ELSIF a ? 'orderId' THEN
    SELECT order_id INTO v_ord FROM fleet_customer_orders WHERE order_id = fleet_identity_uuid(a, 'orderId') AND agent_id = p_agent;
    IF v_ord IS NULL THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: orderId — one of your orders'; END IF;
  ELSE PERFORM fleet_econ_bad('enquiryId or orderId: the customer''s enquiry or order this work is for');
  END IF;
  IF v_repo !~ '^[A-Za-z0-9_.-]{1,39}/[A-Za-z0-9_.-]{1,100}$' THEN PERFORM fleet_econ_bad('repo: owner/name of the customer''s GitHub repository'); END IF;
  IF length(btrim(COALESCE(a ->> 'purpose', ''))) NOT BETWEEN 10 AND 600 THEN PERFORM fleet_econ_bad('purpose: what you will do, in words the customer understands'); END IF;
  v_days := COALESCE(fleet_econ_int(a, 'durationDays', 1, 90, false)::integer, 14);
  IF COALESCE(a ->> 'baseBranch', 'main') !~ '^[A-Za-z0-9._/-]{1,100}$' OR COALESCE(a ->> 'baseBranch', 'main') ~ '\\.\\.' THEN PERFORM fleet_econ_bad('baseBranch: the branch pull requests go to'); END IF;
  INSERT INTO fleet_repo_authorizations (agent_id, enquiry_id, order_id, repo, base_branch, purpose, duration_days, expires_at)
    VALUES (p_agent, v_enq, v_ord, v_repo, COALESCE(a ->> 'baseBranch', 'main'), left(fleet_scrub(a ->> 'purpose'), 600), v_days, now() + interval '30 days')
    RETURNING authorization_id INTO v;
  PERFORM fleet_event('repo_access_requested', p_agent, p_agent, jsonb_build_object('authorizationId', v, 'repo', v_repo));
  RETURN jsonb_build_object('ok', true, 'authorizationId', v, 'status', 'requested',
    'note', 'The customer sees this on their enquiry / order page: they consent there and install the Fleet''s GitHub App on that repository. Tell them in your message; access becomes active once both are done (code.access shows it).');
END $$;

CREATE FUNCTION fleet_econ_code_access(p_agent text, a jsonb) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'access', COALESCE(jsonb_agg(jsonb_build_object('authorizationId', r.authorization_id, 'repo', r.repo, 'baseBranch', r.base_branch,
      'status', r.status, 'enquiryId', r.enquiry_id, 'orderId', r.order_id, 'expiresAt', r.expires_at, 'baselineBuild', r.baseline_build_job,
      'baselinePassed', EXISTS (SELECT 1 FROM fleet_code_jobs j WHERE j.job_id = r.baseline_build_job AND j.status = 'done' AND (j.result ->> 'passed')::boolean))
      ORDER BY r.created_at DESC), '[]'::jsonb),
    'gateway', (SELECT CASE WHEN configured AND last_seen_at > now() - interval '10 minutes' THEN 'connected' ELSE 'not_connected' END FROM fleet_code_services WHERE kind = 'gateway'),
    'build', (SELECT CASE WHEN configured AND last_seen_at > now() - interval '10 minutes' THEN 'connected' ELSE 'not_connected' END FROM fleet_code_services WHERE kind = 'build'))
  FROM fleet_repo_authorizations r WHERE r.agent_id = p_agent
$$;

-- The customer's page: the requests for this enquiry / order, with the exact terms.
CREATE FUNCTION fleet_repo_wording(r fleet_repo_authorizations) RETURNS text LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT replace(replace(replace(replace(replace(${lit(REPO_ACCESS_WORDING)}, '{seller}', COALESCE(fleet_storefront(COALESCE(
           (SELECT o.venture_id FROM fleet_offer_enquiries e JOIN fleet_offers o ON o.offer_id = e.offer_id WHERE e.enquiry_id = r.enquiry_id),
           (SELECT x.venture_id FROM fleet_customer_orders x WHERE x.order_id = r.order_id))) ->> 'brand', 'the seller')),
         '{repo}', r.repo), '{branch}', r.base_branch), '{days}', r.duration_days::text), '{purpose}', r.purpose)
$$;
CREATE FUNCTION fleet_repo_scope_rows(p_kind text, p_token text) RETURNS SETOF fleet_repo_authorizations LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT r.* FROM fleet_repo_authorizations r
   WHERE (p_kind = 'enquiry' AND r.enquiry_id = (SELECT enquiry_id FROM fleet_offer_enquiries WHERE access_token = p_token))
      OR (p_kind = 'order' AND r.order_id = (SELECT order_id FROM fleet_customer_orders WHERE access_token = p_token))
$$;
CREATE FUNCTION svc_repo_requests(p_kind text, p_token text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'requests', COALESCE(jsonb_agg(jsonb_build_object('authorizationId', r.authorization_id, 'repo', r.repo, 'baseBranch', r.base_branch,
      'purpose', r.purpose, 'durationDays', r.duration_days, 'status', r.status, 'wording', COALESCE(r.wording, fleet_repo_wording(r)), 'expiresAt', r.expires_at)
      ORDER BY r.created_at), '[]'::jsonb),
    'installUrl', (SELECT detail ->> 'installUrl' FROM fleet_code_services WHERE kind = 'gateway' AND configured))
  FROM fleet_repo_scope_rows(p_kind, p_token) r WHERE r.status IN ('requested','consented','active')
$$;
CREATE FUNCTION svc_repo_consent(p_kind text, p_token text, p_auth uuid, p_repo text, p_name text, p_origin text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_repo_authorizations;
BEGIN
  SELECT * INTO r FROM fleet_repo_scope_rows(p_kind, p_token) x WHERE x.authorization_id = p_auth;
  IF NOT FOUND OR r.status <> 'requested' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND', 'reason', 'no open request for repository access here'); END IF;
  -- The customer types the repository's name: consent to exactly that repository, never a look-alike.
  IF lower(btrim(COALESCE(p_repo, ''))) <> lower(r.repo) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_REPO_MISMATCH', 'reason', 'type the repository name exactly as shown'); END IF;
  IF length(btrim(COALESCE(p_name, ''))) NOT BETWEEN 1 AND 140 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'your name'); END IF;
  UPDATE fleet_repo_authorizations SET status = 'consented', wording_version = '${REPO_ACCESS_WORDING_VERSION}', wording = fleet_repo_wording(r), consented_at = now(),
         consent_name = btrim(p_name), consent_origin = p_origin, expires_at = now() + interval '30 days', updated_at = now()
   WHERE authorization_id = r.authorization_id;
  PERFORM fleet_event('repo_access_consented', r.agent_id, 'customer', jsonb_build_object('authorizationId', r.authorization_id, 'repo', r.repo));
  RETURN jsonb_build_object('ok', true, 'status', 'consented',
    'installUrl', (SELECT detail ->> 'installUrl' FROM fleet_code_services WHERE kind = 'gateway' AND configured),
    'next', 'install the app on this repository only; access becomes active within a few minutes');
END $$;

-- ═══ 3. Jobs: snapshots and proposals through the gateway; builds in the isolated environment ═══
CREATE FUNCTION fleet_econ_code_job(p_agent text, p_kind text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_repo_authorizations; s fleet_code_jobs; b fleet_code_jobs; v uuid; v_patch text := a ->> 'patch'; v_sha text; v_req jsonb; x text; svc text;
BEGIN
  SELECT * INTO r FROM fleet_repo_authorizations WHERE authorization_id = fleet_identity_uuid(a, 'authorizationId') AND agent_id = p_agent;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: authorizationId — one of your repository access grants'; END IF;
  IF r.status <> 'active' OR r.expires_at <= now() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_REPO_ACCESS_INACTIVE', 'status', r.status, 'reason', 'the customer''s access is not active (consent and app installation both needed, within its duration)');
  END IF;
  svc := CASE WHEN p_kind = 'build' THEN 'build' ELSE 'gateway' END;
  IF NOT EXISTS (SELECT 1 FROM fleet_code_services WHERE kind = svc AND configured AND last_seen_at > now() - interval '10 minutes') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CAPABILITY_NOT_CONFIGURED', 'reason', CASE svc WHEN 'build' THEN 'the build environment is not connected' ELSE 'the code gateway is not connected' END);
  END IF;
  SELECT job_id INTO v FROM fleet_code_jobs WHERE agent_id = p_agent AND idempotency_key = a ->> 'idempotencyKey';
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'jobId', v, 'replay', true); END IF;
  IF v_patch IS NOT NULL THEN
    IF octet_length(v_patch) > ${PATCH_MAX_BYTES} THEN PERFORM fleet_econ_bad('patch: a unified diff of at most 1 MB'); END IF;
    v_sha := encode(sha256(convert_to(v_patch, 'UTF8')), 'hex');
  END IF;
  IF p_kind = 'snapshot' THEN
    IF COALESCE(a ->> 'ref', r.base_branch) !~ '^[A-Za-z0-9._/-]{1,100}$' THEN PERFORM fleet_econ_bad('ref: a branch, tag or commit'); END IF;
    v_req := jsonb_build_object('ref', COALESCE(a ->> 'ref', r.base_branch));
  ELSE
    SELECT * INTO s FROM fleet_code_jobs WHERE job_id = fleet_identity_uuid(a, 'snapshotJobId') AND agent_id = p_agent AND kind = 'snapshot' AND status = 'done'
       AND authorization_id = r.authorization_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: snapshotJobId — a finished snapshot of this repository'; END IF;
    IF p_kind = 'build' THEN
      IF jsonb_typeof(a -> 'commands') <> 'array' OR jsonb_array_length(a -> 'commands') NOT BETWEEN 1 AND 5 THEN PERFORM fleet_econ_bad('commands: 1..5 commands, e.g. ["npm ci", "npm test"]'); END IF;
      FOR x IN SELECT jsonb_array_elements_text(a -> 'commands') LOOP
        IF length(x) NOT BETWEEN 2 AND 300 THEN PERFORM fleet_econ_bad('each command: 2..300 characters'); END IF;
      END LOOP;
      v_req := jsonb_build_object('commands', a -> 'commands', 'baseline', v_patch IS NULL);
    ELSE
      IF v_patch IS NULL THEN PERFORM fleet_econ_bad('patch: the change to propose (a unified diff)'); END IF;
      IF length(btrim(COALESCE(a ->> 'title', ''))) NOT BETWEEN 5 AND 200 THEN PERFORM fleet_econ_bad('title: the pull request''s title'); END IF;
      -- Recovery: a proposal needs a passing build of exactly this patch on this snapshot.
      SELECT * INTO b FROM fleet_code_jobs WHERE agent_id = p_agent AND kind = 'build' AND status = 'done' AND snapshot_job = s.job_id AND patch_sha256 = v_sha
         AND (result ->> 'passed')::boolean ORDER BY finished_at DESC LIMIT 1;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BUILD_REQUIRED', 'reason', 'build and test exactly this patch on this snapshot first (code.build); it must pass');
      END IF;
      v_req := jsonb_build_object('title', left(fleet_scrub(a ->> 'title'), 200), 'body', left(fleet_scrub(COALESCE(a ->> 'body', '')), 8000), 'buildJobId', b.job_id,
        'baseSha', s.result ->> 'sha', 'baseBranch', r.base_branch);
    END IF;
  END IF;
  INSERT INTO fleet_code_jobs (agent_id, authorization_id, kind, request, patch, patch_sha256, snapshot_job, idempotency_key)
    VALUES (p_agent, r.authorization_id, p_kind, v_req, v_patch, v_sha, s.job_id, a ->> 'idempotencyKey') RETURNING job_id INTO v;
  RETURN jsonb_build_object('ok', true, 'jobId', v, 'kind', p_kind);
END $$;

CREATE FUNCTION fleet_econ_code_job_result(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_code_jobs;
BEGIN
  SELECT * INTO j FROM fleet_code_jobs WHERE job_id = fleet_identity_uuid(a, 'jobId') AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF j.status = 'failed' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CODE_JOB_FAILED', 'status', 'failed', 'reason', j.error, 'result', j.result); END IF;
  IF j.status <> 'done' THEN RETURN jsonb_build_object('ok', true, 'status', j.status); END IF;
  -- A snapshot's bytes go to the agent once (the build environment keeps reading them from here).
  IF j.fetched_at IS NULL THEN UPDATE fleet_code_jobs SET fetched_at = now() WHERE job_id = j.job_id; END IF;
  RETURN jsonb_build_object('ok', true, 'status', 'done', 'kind', j.kind, 'result', j.result,
    'tarballB64', CASE WHEN j.kind = 'snapshot' AND j.fetched_at IS NULL THEN encode(j.payload, 'base64') END);
END $$;

-- The code gateway (role fleet_code).
CREATE FUNCTION cgx_report(p_provider text, p_configured boolean, p_detail jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_provider !~ '^[a-z0-9_-]{2,40}$' OR p_configured IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  INSERT INTO fleet_code_services (kind, provider, configured, detail, last_seen_at) VALUES ('gateway', p_provider, p_configured,
      COALESCE(p_detail, '{}'::jsonb) - 'privateKey' - 'token', now())
    ON CONFLICT (kind) DO UPDATE SET provider = EXCLUDED.provider, configured = EXCLUDED.configured, detail = EXCLUDED.detail, last_seen_at = now(), updated_at = now();
  RETURN jsonb_build_object('ok', true, 'schemaVersion', (SELECT max(version) FROM fleet_schema_migrations));
END $$;
CREATE FUNCTION cgx_authorizations(p_limit integer) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('authorizationId', authorization_id, 'repo', repo, 'status', status, 'installationId', installation_id)), '[]'::jsonb)
    FROM (SELECT * FROM fleet_repo_authorizations WHERE status IN ('consented','active') AND expires_at > now() ORDER BY updated_at LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)) x
$$;
-- The installation names the consented repository: access is active, for its duration from now.
CREATE FUNCTION cgx_activate(p_auth uuid, p_installation bigint, p_repo text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_repo_authorizations;
BEGIN
  SELECT * INTO r FROM fleet_repo_authorizations WHERE authorization_id = p_auth FOR UPDATE;
  IF NOT FOUND OR r.status <> 'consented' OR lower(p_repo) <> lower(r.repo) OR p_installation IS NULL OR p_installation <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  UPDATE fleet_repo_authorizations SET status = 'active', installation_id = p_installation, activated_at = now(), expires_at = now() + make_interval(days => r.duration_days), updated_at = now()
   WHERE authorization_id = p_auth;
  PERFORM fleet_event('repo_access_active', r.agent_id, 'code-gateway', jsonb_build_object('authorizationId', p_auth, 'repo', r.repo));
  PERFORM fleet_notify('AMBER', 'REPO_ACCESS_ACTIVE', r.agent_id, 'A customer gave an agent access to ' || r.repo, jsonb_build_object('authorizationId', p_auth), 'repo-active:' || p_auth);
  RETURN jsonb_build_object('ok', true, 'status', 'active');
END $$;
-- The customer uninstalled the app (or removed the repository from it): access ends at once.
CREATE FUNCTION cgx_end(p_auth uuid, p_reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  UPDATE fleet_repo_authorizations SET status = 'revoked', ended_at = now(), end_reason = left(COALESCE(p_reason, 'the app no longer has access'), 300), updated_at = now()
   WHERE authorization_id = p_auth AND status IN ('consented','active');
  RETURN jsonb_build_object('ok', FOUND);
END $$;
CREATE FUNCTION cgx_claim(p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE out jsonb := '[]'::jsonb; j record;
BEGIN
  FOR j IN SELECT c.job_id, c.kind, c.request, c.patch, r.repo, r.base_branch, r.installation_id, r.authorization_id
             FROM fleet_code_jobs c JOIN fleet_repo_authorizations r ON r.authorization_id = c.authorization_id
            WHERE c.status = 'queued' AND c.kind IN ('snapshot','propose') AND r.status = 'active' AND r.expires_at > now()
            ORDER BY c.created_at LIMIT LEAST(GREATEST(COALESCE(p_limit, 4), 1), 20) FOR UPDATE OF c SKIP LOCKED LOOP
    UPDATE fleet_code_jobs SET status = 'running', started_at = now() WHERE job_id = j.job_id;
    out := out || jsonb_build_object('jobId', j.job_id, 'kind', j.kind, 'request', j.request, 'patch', j.patch, 'repo', j.repo, 'baseBranch', j.base_branch,
      'installationId', j.installation_id, 'branch', 'fleet/' || left(j.authorization_id::text, 8) || '-' || left(j.job_id::text, 8));
  END LOOP;
  UPDATE fleet_code_jobs SET status = 'failed', finished_at = now(), error = 'the code gateway stopped while running it' WHERE status = 'running' AND kind IN ('snapshot','propose') AND started_at < now() - interval '10 minutes';
  -- A job whose access ended is never run.
  UPDATE fleet_code_jobs c SET status = 'failed', finished_at = now(), error = 'the customer''s access ended'
    FROM fleet_repo_authorizations r WHERE r.authorization_id = c.authorization_id AND c.status = 'queued' AND (r.status <> 'active' OR r.expires_at <= now());
  RETURN out;
END $$;
CREATE FUNCTION cgx_result(p_job uuid, p_ok boolean, p_result jsonb, p_payload bytea, p_error text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  UPDATE fleet_code_jobs SET status = CASE WHEN p_ok THEN 'done' ELSE 'failed' END, finished_at = now(), result = p_result,
         payload = CASE WHEN p_ok AND kind = 'snapshot' THEN p_payload END, error = CASE WHEN p_ok THEN NULL ELSE left(COALESCE(p_error, 'provider error'), 300) END
   WHERE job_id = p_job AND status = 'running' AND kind IN ('snapshot','propose');
  IF FOUND AND p_ok THEN
    PERFORM fleet_event('code_job_done', (SELECT agent_id FROM fleet_code_jobs WHERE job_id = p_job), 'code-gateway',
      jsonb_build_object('jobId', p_job, 'kind', (SELECT kind FROM fleet_code_jobs WHERE job_id = p_job), 'pullRequest', p_result ->> 'pullRequestUrl'));
  END IF;
  RETURN jsonb_build_object('ok', FOUND);
END $$;

-- The build environment (role fleet_build): no credentials; it receives a snapshot and a patch, returns output.
CREATE FUNCTION bbx_report(p_configured boolean, p_detail jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  INSERT INTO fleet_code_services (kind, provider, configured, detail, last_seen_at) VALUES ('build', 'fleet-buildbox', COALESCE(p_configured, false), COALESCE(p_detail, '{}'::jsonb), now())
    ON CONFLICT (kind) DO UPDATE SET configured = EXCLUDED.configured, detail = EXCLUDED.detail, last_seen_at = now(), updated_at = now();
  RETURN jsonb_build_object('ok', true, 'schemaVersion', (SELECT max(version) FROM fleet_schema_migrations));
END $$;
CREATE FUNCTION bbx_claim(p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE out jsonb := '[]'::jsonb; j record;
BEGIN
  FOR j IN SELECT c.job_id, c.request, c.patch, s.payload FROM fleet_code_jobs c JOIN fleet_code_jobs s ON s.job_id = c.snapshot_job
            JOIN fleet_repo_authorizations r ON r.authorization_id = c.authorization_id
            WHERE c.status = 'queued' AND c.kind = 'build' AND r.status = 'active' AND r.expires_at > now() AND s.payload IS NOT NULL
            ORDER BY c.created_at LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 4) FOR UPDATE OF c SKIP LOCKED LOOP
    UPDATE fleet_code_jobs SET status = 'running', started_at = now() WHERE job_id = j.job_id;
    out := out || jsonb_build_object('jobId', j.job_id, 'commands', j.request -> 'commands', 'patch', j.patch, 'tarballB64', encode(j.payload, 'base64'));
  END LOOP;
  UPDATE fleet_code_jobs SET status = 'failed', finished_at = now(), error = 'the build environment stopped while running it' WHERE status = 'running' AND kind = 'build' AND started_at < now() - interval '30 minutes';
  RETURN out;
END $$;
CREATE FUNCTION bbx_result(p_job uuid, p_ok boolean, p_result jsonb, p_error text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_code_jobs;
BEGIN
  UPDATE fleet_code_jobs SET status = CASE WHEN p_ok THEN 'done' ELSE 'failed' END, finished_at = now(), result = p_result,
         error = CASE WHEN p_ok THEN NULL ELSE left(COALESCE(p_error, 'build error'), 300) END
   WHERE job_id = p_job AND status = 'running' AND kind = 'build' RETURNING * INTO j;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false); END IF;
  -- The agent showed it can build and test this repository: a passing build without a patch is the baseline.
  IF p_ok AND (p_result ->> 'passed')::boolean AND j.patch IS NULL THEN
    UPDATE fleet_repo_authorizations SET baseline_build_job = j.job_id, updated_at = now() WHERE authorization_id = j.authorization_id;
  END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- The owner's view and control.
CREATE FUNCTION fleet_code_json() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'services', COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', kind, 'provider', provider, 'configured', configured, 'lastSeenAt', last_seen_at,
                  'alive', last_seen_at > now() - interval '10 minutes', 'detail', detail)) FROM fleet_code_services), '[]'::jsonb),
    'access', COALESCE((SELECT jsonb_agg(jsonb_build_object('authorizationId', authorization_id, 'agentId', agent_id, 'repo', repo, 'baseBranch', base_branch, 'status', status,
                  'purpose', purpose, 'consentedAt', consented_at, 'consentName', consent_name, 'activatedAt', activated_at, 'expiresAt', expires_at, 'endReason', end_reason) ORDER BY created_at DESC)
                  FROM (SELECT * FROM fleet_repo_authorizations ORDER BY created_at DESC LIMIT 50) r), '[]'::jsonb),
    'jobs', COALESCE((SELECT jsonb_agg(jsonb_build_object('jobId', job_id, 'agentId', agent_id, 'kind', kind, 'status', status, 'createdAt', created_at,
                  'passed', result -> 'passed', 'pullRequestUrl', result ->> 'pullRequestUrl', 'error', error) ORDER BY created_at DESC)
                  FROM (SELECT * FROM fleet_code_jobs ORDER BY created_at DESC LIMIT 50) j), '[]'::jsonb))
$$;
CREATE FUNCTION fleet_admin_repo_access_revoke(p_auth uuid, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_treasury');
  UPDATE fleet_repo_authorizations SET status = 'revoked', ended_at = now(), end_reason = left(COALESCE(p_reason, 'revoked by the owner'), 300), updated_at = now()
   WHERE authorization_id = p_auth AND status IN ('requested','consented','active');
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  PERFORM fleet_event('repo_access_revoked', NULL, p_actor, jsonb_build_object('authorizationId', p_auth));
  RETURN jsonb_build_object('ok', true, 'status', 'revoked');
END $$;

-- ═══ 4. Capabilities: the states know the code services; a pull_request deliverable is ready only on demonstrated scope ═══
CREATE OR REPLACE FUNCTION fleet_agent_capability_states(p_agent text) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT fleet_agent_capability_states_v85(p_agent) || jsonb_build_object(
    'codeGateway', COALESCE((SELECT CASE WHEN configured AND last_seen_at > now() - interval '10 minutes' THEN 'connected' ELSE 'not_connected' END FROM fleet_code_services WHERE kind = 'gateway'), 'not_connected'),
    'buildEnvironment', COALESCE((SELECT CASE WHEN configured AND last_seen_at > now() - interval '10 minutes' THEN 'connected' ELSE 'not_connected' END FROM fleet_code_services WHERE kind = 'build'), 'not_connected'))
$$;

CREATE OR REPLACE FUNCTION fleet_deliverable_verdict(d jsonb, st jsonb, rt jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE missing jsonb := '[]'::jsonb; r fleet_repo_authorizations;
BEGIN
  IF lower(btrim(COALESCE(d ->> 'format', ''))) <> 'pull_request' THEN RETURN fleet_deliverable_verdict_v87(d, st, rt); END IF;
  -- Code changes to a customer's repository: the services, the customer's access for THIS enquiry, and a passing baseline.
  IF st ->> 'codeGateway' <> 'connected' THEN missing := missing || '["the code gateway (customer repositories): not connected"]'::jsonb; END IF;
  IF st ->> 'buildEnvironment' <> 'connected' THEN missing := missing || '["the isolated build environment: not connected"]'::jsonb; END IF;
  IF st ->> '_targetKind' = 'enquiry' THEN
    SELECT * INTO r FROM fleet_repo_authorizations WHERE enquiry_id = (st ->> '_targetId')::uuid AND agent_id = st ->> '_agent' AND status = 'active' AND expires_at > now()
     ORDER BY activated_at DESC LIMIT 1;
    IF r.authorization_id IS NULL THEN missing := missing || '["the customer''s repository access for this enquiry (code.request_access; they consent and install the app)"]'::jsonb;
    ELSIF NOT EXISTS (SELECT 1 FROM fleet_code_jobs j WHERE j.job_id = r.baseline_build_job AND j.status = 'done' AND (j.result ->> 'passed')::boolean) THEN
      missing := missing || '["a passing baseline build of that repository (code.snapshot, then code.build without a patch): show you can build and test it"]'::jsonb;
    END IF;
  END IF;
  RETURN jsonb_build_object('format', 'pull_request', 'contentType', 'x-fleet/pull-request', 'needs', COALESCE(d -> 'needs', '[]'::jsonb), 'ready', jsonb_array_length(missing) = 0, 'missing', missing);
END $$;

${CHECK}
${DISPATCH}
${DASH_CALL}
${OPS_WATCH}

-- ═══ 5. The shared library: capability status v12, where to start v2 (software maintenance on demonstrated scope) ═══
SELECT fleet_admin_knowledge_library_load(${lit(JSON.stringify({ entries: KNOWLEDGE_FOUNDATION_V2.entries.filter((e) => (LIBRARY_ENTRIES_V89 as readonly string[]).includes(e.id)) }))}::jsonb, 'migration');
`;
