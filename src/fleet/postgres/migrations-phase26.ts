/**
 * Schema v26 — F2 Phase A: autonomy doctrine in the registry.
 *
 * 1. Owner requests (v25) become ACTION-SCOPED EXTERNAL DEPENDENCIES. A dependency records that ONE action needs
 *    something only a human or legal identity can provide (or a Fleet constitutional change). It never blocks the
 *    founder, a goal or other work, and nothing escalates it toward the owner over time.
 *    - Valid kinds: human_identity, kyc, legal_signature, constitutional_change, non_delegable_credential. Ordinary
 *      business — niche, product, channel, marketing, pivot, experiment, spending, capital — is not a dependency
 *      (refused with FLEET_NOT_AN_EXCEPTION). A CHECK makes an OPEN record of any other kind impossible.
 *    - `blocking` → `blocks_action` (always true: it is the unavailable action); `action` names it; `goal_ref` is context.
 *    - The known live record 62cbe1b7 (Founder 1's Gumroad seller account) is re-scoped explicitly, by id, to the one
 *      Gumroad listing action (kind kyc). Any other OPEN legacy row of an ordinary category is RETIRED (not decided):
 *      ordinary decisions belong to the founder or FleetController.
 *    - API responses keep `blocking: false` and `stale: false` so an older founder runtime never renders a dependency as
 *      blocking or stale.
 * 2. A DISCOVERY ALLOWANCE (constitutional policy, per founder, computed — never owner-decided). An idle founder whose
 *    allowance permits turns its idle wake into autonomous opportunity discovery instead of sleep. The allowance is a
 *    bound on the founder's own inference spend (already charged to its ledger): no new financial authority.
 *      budget/day  = min(max_daily_cents, survival equity × daily_fraction_bp / 10 000)
 *      runway days = survival equity ÷ (cognition charged over the last burn_window_days ÷ window)
 *      allowed     = enabled ∧ survival equity > 0 ∧ runway ≥ min_runway_days (or no burn yet) ∧ spent today < budget
 *    "Spent today" is ALL of the founder's inference in the last 24 h (from fleet_cognition_log), so the allowance bounds
 *    idle exploration on top of ordinary work, never beyond it. A missing policy row means no allowance (fail closed).
 */

const EXCEPTION_KINDS = "'human_identity','kyc','legal_signature','constitutional_change','non_delegable_credential'";
const GUMROAD = "62cbe1b7-8642-4bf4-a6a7-b41c1dcc09e3";

export const V26_SQL = `
-- ═══ 1. Owner requests → action-scoped external dependencies ═══
ALTER TABLE fleet_owner_requests DISABLE TRIGGER fleet_owner_requests_guard;
ALTER TABLE fleet_owner_requests RENAME COLUMN blocking TO blocks_action;
ALTER TABLE fleet_owner_requests ADD COLUMN kind text, ADD COLUMN action text;
ALTER TABLE fleet_owner_requests ALTER COLUMN category DROP NOT NULL;
ALTER TABLE fleet_owner_requests DROP CONSTRAINT fleet_owner_requests_status_check;
ALTER TABLE fleet_owner_requests ADD CONSTRAINT fleet_owner_requests_status_check CHECK (status IN ('pending','approved','declined','answered','withdrawn','retired'));

-- The known live blocker, re-scoped explicitly by id to its one action (no decision; it stays pending).
UPDATE fleet_owner_requests SET kind = 'kyc',
       action = 'List the landlord compliance tracker on Gumroad (a Gumroad seller account needs a human identity/KYC)', blocks_action = true
 WHERE request_id = '${GUMROAD}';
-- Other legacy rows: the exceptional categories map deterministically; an ordinary category is not an owner dependency.
UPDATE fleet_owner_requests SET kind = CASE category WHEN 'account_or_identity' THEN 'kyc' WHEN 'policy_exception' THEN 'constitutional_change' END,
       action = left(title, 200), blocks_action = true
 WHERE kind IS NULL AND category IN ('account_or_identity','policy_exception');
UPDATE fleet_owner_requests SET kind = 'legacy_ordinary', action = left(title, 200), status = 'retired', decided_by = 'migration', decided_at = now(),
       response = 'Ordinary business decisions are the founder''s own (or FleetController''s): no owner decision is needed, and nothing waits on this.'
 WHERE kind IS NULL AND status = 'pending';
UPDATE fleet_owner_requests SET kind = 'legacy_ordinary', action = left(title, 200) WHERE kind IS NULL;
ALTER TABLE fleet_owner_requests ALTER COLUMN kind SET NOT NULL, ALTER COLUMN action SET NOT NULL;
ALTER TABLE fleet_owner_requests ADD CONSTRAINT fleet_owner_requests_kind_check CHECK (kind IN (${EXCEPTION_KINDS}, 'legacy_ordinary') AND length(action) BETWEEN 1 AND 200);
-- The invariant: an OPEN record is always a genuine exception, and always scoped to one action.
ALTER TABLE fleet_owner_requests ADD CONSTRAINT fleet_owner_requests_open_is_exception CHECK (status <> 'pending' OR (kind IN (${EXCEPTION_KINDS}) AND blocks_action));

CREATE OR REPLACE FUNCTION fleet_owner_requests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'FLEET_IMMUTABLE: dependency records are never deleted'; END IF;
  IF OLD.status <> 'pending' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: dependency already %', OLD.status; END IF;
  IF NEW.request_id <> OLD.request_id OR NEW.agent_id <> OLD.agent_id OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.category IS DISTINCT FROM OLD.category OR NEW.kind <> OLD.kind OR NEW.action <> OLD.action
     OR NEW.goal_ref IS DISTINCT FROM OLD.goal_ref OR NEW.title <> OLD.title OR NEW.detail <> OLD.detail OR NEW.blocks_action <> OLD.blocks_action
     OR NEW.created_at <> OLD.created_at OR NEW.seq <> OLD.seq OR NEW.source_kind <> OLD.source_kind OR NEW.source_ref IS DISTINCT FROM OLD.source_ref
     OR NEW.imported_by IS DISTINCT FROM OLD.imported_by OR NEW.imported_at IS DISTINCT FROM OLD.imported_at THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a dependency record is immutable except for its resolution';
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE fleet_owner_requests ENABLE TRIGGER fleet_owner_requests_guard;

CREATE OR REPLACE FUNCTION fleet_owner_request_json(r fleet_owner_requests) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('requestId', r.request_id, 'kind', r.kind, 'action', r.action, 'blocksAction', r.blocks_action AND r.status = 'pending',
    'goalRef', r.goal_ref, 'title', r.title, 'detail', r.detail, 'status', r.status, 'response', r.response, 'decidedBy', r.decided_by, 'decidedAt', r.decided_at,
    'createdAt', r.created_at, 'ageS', floor(extract(epoch FROM (COALESCE(r.decided_at, now()) - r.created_at)))::bigint,
    -- Compatibility for founder runtimes older than F2-A: never blocking, never stale (nothing escalates).
    'category', COALESCE(r.category, r.kind), 'blocking', false, 'stale', false,
    'source', CASE WHEN r.source_kind = 'founder' THEN NULL
      ELSE jsonb_build_object('kind', r.source_kind, 'ref', r.source_ref, 'importedBy', r.imported_by, 'importedAt', r.imported_at) END)
$$;

DROP FUNCTION api_owner_request_create(text, text, text, text, text, text, text, boolean);
CREATE FUNCTION api_owner_request_create(p_agent text, p_token text, p_idem text, p_kind text, p_action text, p_goal text, p_title text, p_detail text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'owner_request_create'); r fleet_owner_requests; v_id uuid := gen_random_uuid();
BEGIN
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  IF NOT fleet_agent_can(p_agent, 'planning') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CAPABILITY_DENIED'); END IF;
  IF p_kind IS NULL OR p_kind NOT IN (${EXCEPTION_KINDS}) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_AN_EXCEPTION',
      'reason', 'Only an action that needs a human or legal identity (human_identity, kyc, legal_signature, non_delegable_credential) or a constitutional change is a dependency. Niche, product, channel, marketing, pivot, experiment, spending and capital decisions are yours or FleetController''s.');
  END IF;
  IF p_idem IS NULL OR length(p_idem) NOT BETWEEN 1 AND 128 OR (p_goal IS NOT NULL AND p_goal !~ '^g[0-9]{1,6}$')
     OR p_action IS NULL OR length(p_action) NOT BETWEEN 1 AND 200
     OR p_title IS NULL OR length(p_title) NOT BETWEEN 1 AND 200 OR p_detail IS NULL OR length(p_detail) NOT BETWEEN 1 AND 2000 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  SELECT * INTO r FROM fleet_owner_requests WHERE agent_id = p_agent AND idempotency_key = p_idem;
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'replayed', true, 'request', fleet_owner_request_json(r)); END IF;
  IF (SELECT count(*) FROM fleet_owner_requests WHERE agent_id = p_agent AND status = 'pending') >= 5 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_LIMIT_REACHED', 'reason', 'at most 5 open dependencies: withdraw one first');
  END IF;
  IF (SELECT count(*) FROM fleet_owner_requests WHERE agent_id = p_agent AND created_at > now() - interval '1 day') >= 10 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_RATE_LIMITED');
  END IF;
  INSERT INTO fleet_owner_requests (request_id, agent_id, idempotency_key, kind, action, goal_ref, title, detail, blocks_action)
    VALUES (v_id, p_agent, p_idem, p_kind, left(fleet_scrub(p_action), 200), p_goal, left(fleet_scrub(p_title), 200), left(fleet_scrub_long(p_detail), 2000), true)
    RETURNING * INTO r;
  PERFORM fleet_event('external_dependency_recorded', p_agent, p_agent, jsonb_build_object('requestId', v_id, 'kind', p_kind, 'goalRef', p_goal));
  RETURN jsonb_build_object('ok', true, 'request', fleet_owner_request_json(r),
    'note', 'Recorded: only this action is unavailable. Keep working — alternatives, other products, services or ventures are not blocked.');
END $$;

-- Legacy import (v25) re-expressed: a kind and the one action, never a goal-blocking category.
DROP FUNCTION fleet_owner_request_import(uuid, text, boolean, text, text);
CREATE FUNCTION fleet_owner_request_import(p_proposal uuid, p_kind text, p_action text, p_goal text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE k fleet_knowledge_proposals; r fleet_owner_requests; v_goal text; v_goal_source text; v_goals text[];
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  SELECT * INTO r FROM fleet_owner_requests WHERE source_ref = p_proposal;
  IF FOUND THEN RETURN fleet_owner_request_json(r) || jsonb_build_object('agentId', r.agent_id, 'replayed', true); END IF;
  IF p_kind IS NULL OR p_kind NOT IN (${EXCEPTION_KINDS}) THEN RAISE EXCEPTION 'FLEET_NOT_AN_EXCEPTION: only an identity/legal/constitutional dependency can be imported'; END IF;
  IF p_action IS NULL OR length(p_action) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the one unavailable action is required'; END IF;
  IF p_goal IS NOT NULL AND p_goal !~ '^g[0-9]{1,6}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: goal is g<n>'; END IF;
  SELECT * INTO k FROM fleet_knowledge_proposals WHERE proposal_id = p_proposal;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such knowledge proposal'; END IF;
  IF k.status <> 'proposed' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: the proposal was already reviewed (%)', k.status; END IF;
  IF NOT (k.category = 'policy' AND k.title ~* '^owner request:') THEN
    RAISE EXCEPTION 'FLEET_NOT_AN_OWNER_REQUEST: only a policy proposal titled "Owner request: …" can be imported';
  END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), k.agent_id);
  SELECT array_agg(DISTINCT m[1]) INTO v_goals FROM regexp_matches(k.title || ' ' || k.content, '\\m(g[0-9]{1,6})\\M', 'g') m;
  IF p_goal IS NOT NULL THEN v_goal := p_goal; v_goal_source := 'owner';
  ELSIF COALESCE(array_length(v_goals, 1), 0) = 1 THEN v_goal := v_goals[1]; v_goal_source := 'proposal_text';
  ELSE v_goal := NULL; v_goal_source := CASE WHEN COALESCE(array_length(v_goals, 1), 0) = 0 THEN 'none' ELSE 'ambiguous' END;
  END IF;
  INSERT INTO fleet_owner_requests (request_id, agent_id, idempotency_key, kind, action, goal_ref, title, detail, blocks_action, created_at, source_kind, source_ref, imported_by, imported_at)
    VALUES (k.proposal_id, k.agent_id, 'legacy-knowledge:' || k.proposal_id, p_kind, left(p_action, 200), v_goal, left(k.title, 200), left(k.content, 2000), true,
            k.submitted_at, 'knowledge_proposal', k.proposal_id, p_actor, now())
    RETURNING * INTO r;
  PERFORM fleet_event('owner_request_imported', k.agent_id, p_actor,
    jsonb_build_object('requestId', r.request_id, 'proposalId', k.proposal_id, 'kind', p_kind, 'goalRef', v_goal, 'goalSource', v_goal_source));
  RETURN fleet_owner_request_json(r) || jsonb_build_object('agentId', r.agent_id, 'goalSource', v_goal_source,
    'note', 'Imported as an action-scoped dependency; nothing was decided or granted, and the founder is not blocked. The knowledge proposal is unchanged.');
END $$;

-- Doctor: open dependencies are information (actions unavailable), never "the owner must act for the agent to proceed".
CREATE OR REPLACE FUNCTION fleet_owner_requests_overview() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'open', (SELECT count(*) FROM fleet_owner_requests WHERE status = 'pending'),
    'openByKind', (SELECT COALESCE(jsonb_object_agg(kind, n), '{}'::jsonb) FROM (SELECT kind, count(*) n FROM fleet_owner_requests WHERE status = 'pending' GROUP BY kind) x),
    'constitutionalOpen', (SELECT count(*) FROM fleet_owner_requests WHERE status = 'pending' AND kind = 'constitutional_change'),
    'oldestOpenS', (SELECT floor(extract(epoch FROM now() - min(created_at)))::bigint FROM fleet_owner_requests WHERE status = 'pending'),
    'knowledgePending', (SELECT count(*) FROM fleet_knowledge_proposals WHERE status = 'proposed'),
    'knowledgeImported', (SELECT count(*) FROM fleet_knowledge_proposals k WHERE k.status = 'proposed' AND EXISTS (SELECT 1 FROM fleet_owner_requests r WHERE r.source_ref = k.proposal_id)))
$$;

-- ═══ 2. Discovery allowance (constitutional policy; computed per founder) ═══
CREATE TABLE fleet_discovery_policy (
  id                 smallint    PRIMARY KEY CHECK (id = 1),
  enabled            boolean     NOT NULL DEFAULT true,
  daily_fraction_bp  integer     NOT NULL DEFAULT 200 CHECK (daily_fraction_bp BETWEEN 0 AND 2000),
  max_daily_cents    integer     NOT NULL DEFAULT 300 CHECK (max_daily_cents BETWEEN 0 AND 100000),
  min_runway_days    integer     NOT NULL DEFAULT 14 CHECK (min_runway_days BETWEEN 0 AND 365),
  burn_window_days   integer     NOT NULL DEFAULT 7 CHECK (burn_window_days BETWEEN 1 AND 90),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         text        NOT NULL DEFAULT 'migration'
);
INSERT INTO fleet_discovery_policy (id) VALUES (1);
CREATE TRIGGER fleet_discovery_policy_no_delete BEFORE DELETE OR TRUNCATE ON fleet_discovery_policy FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_discovery_allowance(p_agent text) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_discovery_policy; v_eq bigint; v_spent bigint; v_burn numeric; v_runway numeric; v_budget bigint; v_reason text;
BEGIN
  SELECT * INTO p FROM fleet_discovery_policy WHERE id = 1;
  -- Fail closed: without its policy row there is no allowance (NULL arithmetic must never read as "allowed").
  IF NOT FOUND THEN
    RETURN jsonb_build_object('allowed', false, 'budgetCents', 0, 'spentTodayCents', 0, 'runwayDays', NULL, 'reason', 'no discovery policy');
  END IF;
  v_eq := GREATEST(COALESCE((fleet_agent_economics(p_agent) ->> 'survivalEquity')::bigint, 0), 0);
  v_spent := (SELECT ceil(COALESCE(sum(COALESCE(charged_microcents, charged_cents * 1000000)), 0) / 1000000.0)::bigint
                FROM fleet_cognition_log WHERE agent_id = p_agent AND at > now() - interval '1 day');
  v_burn := (SELECT COALESCE(sum(COALESCE(charged_microcents, charged_cents * 1000000)), 0) / 1000000.0
               FROM fleet_cognition_log WHERE agent_id = p_agent AND at > now() - make_interval(days => p.burn_window_days)) / p.burn_window_days;
  v_runway := CASE WHEN v_burn > 0 THEN v_eq / v_burn END;
  v_budget := LEAST(p.max_daily_cents::bigint, (v_eq * p.daily_fraction_bp) / 10000);
  v_reason := CASE WHEN NOT p.enabled THEN 'discovery disabled by policy'
                   WHEN v_eq <= 0 THEN 'no survival equity'
                   WHEN v_runway IS NOT NULL AND v_runway < p.min_runway_days THEN 'runway below the discovery floor: revenue-first'
                   WHEN v_spent >= v_budget THEN 'today''s discovery allowance is spent'
                   ELSE 'allowed' END;
  RETURN jsonb_build_object('allowed', v_reason = 'allowed', 'budgetCents', v_budget, 'spentTodayCents', v_spent,
    'runwayDays', CASE WHEN v_runway IS NULL THEN NULL ELSE round(v_runway, 1) END, 'reason', v_reason);
END $$;

CREATE OR REPLACE FUNCTION api_cognition_status(p_agent text, p_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'cognition_status');
BEGIN
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  RETURN jsonb_build_object('ok', true) || fleet_cognition_state(p_agent) || jsonb_build_object('discovery', fleet_discovery_allowance(p_agent));
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
