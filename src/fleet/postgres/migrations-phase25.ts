/**
 * Schema v25 — F1-LIVE-01 owner-request liveness (no money, no authority).
 *
 * Founder 1 asked the owner to enable a sales channel through a KNOWLEDGE proposal (62cbe1b7). That queue is for
 * institutional lessons: its only owner action is promote/reject into fleet knowledge, it has no answer path back to the
 * founder, and doctor listed it as an ordinary PASS. The founder then slept for days, correctly believing it was waiting.
 *
 * This adds an explicit queue for what a founder needs from the OWNER before a goal can continue:
 *   fleet_owner_requests   one request: founder, related goal, category, title/detail (founder-written), blocking flag,
 *                          status pending → approved | declined | answered | withdrawn, the owner's response, timestamps
 * Authority
 *   - A founder creates (idempotent, bounded, rate-limited), lists its own and withdraws its own pending request.
 *   - Only the owner (operator:<user>, an approver of that founder) decides. A decision RECORDS the owner's answer for the
 *     founder to read; it grants no capability, account, money or permission — "approved" changes nothing else.
 *   - A row changes only from pending to a terminal status; identity columns never change; rows are never deleted.
 * Liveness
 *   - A pending request is STALE after fleet_owner_request_stale_s() (24 h). Derivation: an idle founder backs off to one
 *     thinking slot per ~33 min (MAX_IDLE_SKIP 32 × the 2-heartbeat, 30 s slot), so 24 h is ≈ 44 sleep-only wakes
 *     (≈ $0.88 at the measured ≈ 2.0 M µ¢ per idle wake) and one full owner-review day. The founder sees age and
 *     staleness in its task packet; doctor warns on stale BLOCKING requests and on knowledge proposals left unreviewed
 *     longer than the same threshold. Nothing is notified externally.
 */

export const V25_SQL = `
CREATE TABLE fleet_owner_requests (
  seq              bigserial   UNIQUE,
  request_id       uuid        PRIMARY KEY,
  agent_id         text        NOT NULL REFERENCES fleet_agents(agent_id),
  idempotency_key  text        NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  category         text        NOT NULL CHECK (category IN ('sales_channel','account_or_identity','capital_or_spend','policy_exception','information','other')),
  goal_ref         text        NULL CHECK (goal_ref ~ '^g[0-9]{1,6}$'),
  title            text        NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  detail           text        NOT NULL CHECK (length(detail) BETWEEN 1 AND 2000),
  blocking         boolean     NOT NULL,
  status           text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','answered','withdrawn')),
  response         text        NULL CHECK (response IS NULL OR length(response) <= 2000),
  decided_by       text        NULL,
  decided_at       timestamptz NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Provenance: filed by the founder, or imported by the owner from a legacy knowledge proposal (whose id it keeps).
  source_kind      text        NOT NULL DEFAULT 'founder' CHECK (source_kind IN ('founder','knowledge_proposal')),
  source_ref       uuid        NULL UNIQUE REFERENCES fleet_knowledge_proposals(proposal_id),
  imported_by      text        NULL,
  imported_at      timestamptz NULL,
  UNIQUE (agent_id, idempotency_key),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK ((source_kind = 'founder') = (source_ref IS NULL) AND (source_ref IS NULL) = (imported_by IS NULL) AND (imported_by IS NULL) = (imported_at IS NULL))
);
CREATE INDEX fleet_owner_requests_pending ON fleet_owner_requests (created_at) WHERE status = 'pending';

-- Only pending → terminal, identity columns immutable, never deleted.
CREATE FUNCTION fleet_owner_requests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'FLEET_IMMUTABLE: owner requests are never deleted'; END IF;
  IF OLD.status <> 'pending' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: owner request already %', OLD.status; END IF;
  IF NEW.request_id <> OLD.request_id OR NEW.agent_id <> OLD.agent_id OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.category <> OLD.category
     OR NEW.goal_ref IS DISTINCT FROM OLD.goal_ref OR NEW.title <> OLD.title OR NEW.detail <> OLD.detail OR NEW.blocking <> OLD.blocking
     OR NEW.created_at <> OLD.created_at OR NEW.seq <> OLD.seq OR NEW.source_kind <> OLD.source_kind OR NEW.source_ref IS DISTINCT FROM OLD.source_ref
     OR NEW.imported_by IS DISTINCT FROM OLD.imported_by OR NEW.imported_at IS DISTINCT FROM OLD.imported_at THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: an owner request is immutable except for its decision';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_owner_requests_guard BEFORE UPDATE OR DELETE ON fleet_owner_requests FOR EACH ROW EXECUTE FUNCTION fleet_owner_requests_guard();
CREATE TRIGGER fleet_owner_requests_no_truncate BEFORE TRUNCATE ON fleet_owner_requests FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_owner_request_stale_s() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 86400 $$;

CREATE FUNCTION fleet_owner_request_json(r fleet_owner_requests) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('requestId', r.request_id, 'category', r.category, 'goalRef', r.goal_ref, 'title', r.title, 'detail', r.detail,
    'blocking', r.blocking, 'status', r.status, 'response', r.response, 'decidedBy', r.decided_by, 'decidedAt', r.decided_at, 'createdAt', r.created_at,
    'ageS', floor(extract(epoch FROM (COALESCE(r.decided_at, now()) - r.created_at)))::bigint,
    'stale', r.status = 'pending' AND now() - r.created_at >= make_interval(secs => fleet_owner_request_stale_s()),
    'staleAfterS', fleet_owner_request_stale_s(), 'source', CASE WHEN r.source_kind = 'founder' THEN NULL
      ELSE jsonb_build_object('kind', r.source_kind, 'ref', r.source_ref, 'importedBy', r.imported_by, 'importedAt', r.imported_at) END)
$$;

-- ═══ Founder side ═══
CREATE FUNCTION api_owner_request_create(p_agent text, p_token text, p_idem text, p_category text, p_goal text, p_title text, p_detail text, p_blocking boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'owner_request_create'); r fleet_owner_requests; v_id uuid := gen_random_uuid();
BEGIN
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  IF NOT fleet_agent_can(p_agent, 'planning') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CAPABILITY_DENIED'); END IF;
  IF p_idem IS NULL OR length(p_idem) NOT BETWEEN 1 AND 128 OR p_category IS NULL
     OR p_category NOT IN ('sales_channel','account_or_identity','capital_or_spend','policy_exception','information','other')
     OR (p_goal IS NOT NULL AND p_goal !~ '^g[0-9]{1,6}$')
     OR p_title IS NULL OR length(p_title) NOT BETWEEN 1 AND 200 OR p_detail IS NULL OR length(p_detail) NOT BETWEEN 1 AND 2000 OR p_blocking IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  SELECT * INTO r FROM fleet_owner_requests WHERE agent_id = p_agent AND idempotency_key = p_idem;
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'replayed', true, 'request', fleet_owner_request_json(r)); END IF;
  IF (SELECT count(*) FROM fleet_owner_requests WHERE agent_id = p_agent AND status = 'pending') >= 5 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_LIMIT_REACHED', 'reason', 'at most 5 pending owner requests: withdraw one first');
  END IF;
  IF (SELECT count(*) FROM fleet_owner_requests WHERE agent_id = p_agent AND created_at > now() - interval '1 day') >= 10 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_RATE_LIMITED');
  END IF;
  INSERT INTO fleet_owner_requests (request_id, agent_id, idempotency_key, category, goal_ref, title, detail, blocking)
    VALUES (v_id, p_agent, p_idem, p_category, p_goal, left(fleet_scrub(p_title), 200), left(fleet_scrub_long(p_detail), 2000), p_blocking)
    RETURNING * INTO r;
  PERFORM fleet_event('owner_request_created', p_agent, p_agent, jsonb_build_object('requestId', v_id, 'category', p_category, 'blocking', p_blocking, 'goalRef', p_goal));
  RETURN jsonb_build_object('ok', true, 'request', fleet_owner_request_json(r),
    'note', 'Recorded for the owner. It grants nothing by itself; its status and the owner''s answer appear in your task packet.');
END $$;

CREATE FUNCTION api_owner_request_withdraw(p_agent text, p_token text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'owner_request_withdraw'); r fleet_owner_requests;
BEGIN
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  SELECT * INTO r FROM fleet_owner_requests WHERE request_id = p_id AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF r.status <> 'pending' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE', 'status', r.status); END IF;
  UPDATE fleet_owner_requests SET status = 'withdrawn', decided_by = p_agent, decided_at = now() WHERE request_id = p_id RETURNING * INTO r;
  PERFORM fleet_event('owner_request_withdrawn', p_agent, p_agent, jsonb_build_object('requestId', p_id));
  RETURN jsonb_build_object('ok', true, 'request', fleet_owner_request_json(r));
END $$;

CREATE FUNCTION api_owner_request_list(p_agent text, p_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'owner_request_list');
BEGIN
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  -- Pending ones first (all of them: at most 5), then the 10 most recent decisions.
  RETURN jsonb_build_object('ok', true, 'staleAfterS', fleet_owner_request_stale_s(), 'requests', (
    SELECT COALESCE(jsonb_agg(fleet_owner_request_json(x) ORDER BY x.status <> 'pending', x.seq DESC), '[]'::jsonb) FROM (
      (SELECT * FROM fleet_owner_requests WHERE agent_id = p_agent AND status = 'pending')
      UNION ALL
      (SELECT * FROM fleet_owner_requests WHERE agent_id = p_agent AND status <> 'pending' ORDER BY decided_at DESC LIMIT 10)) x));
END $$;

-- ═══ Owner side (admin credential; never granted to agent, service or operator roles) ═══
CREATE FUNCTION fleet_owner_request_decide(p_id uuid, p_decision text, p_response text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_owner_requests;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  IF p_decision NOT IN ('approved','declined','answered') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: decision is approved, declined or answered'; END IF;
  IF p_decision = 'answered' AND (p_response IS NULL OR length(trim(p_response)) = 0) THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: an answer needs a response'; END IF;
  SELECT * INTO r FROM fleet_owner_requests WHERE request_id = p_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'pending' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: owner request is not pending'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), r.agent_id);
  UPDATE fleet_owner_requests SET status = p_decision, response = NULLIF(left(fleet_scrub_long(p_response), 2000), ''), decided_by = p_actor, decided_at = now()
   WHERE request_id = p_id RETURNING * INTO r;
  PERFORM fleet_event('owner_request_decided', r.agent_id, p_actor, jsonb_build_object('requestId', p_id, 'decision', p_decision));
  RETURN fleet_owner_request_json(r) || jsonb_build_object('agentId', r.agent_id,
    'note', 'The decision is recorded for the founder; it grants no capability, account, money or permission.');
END $$;

-- Legacy backfill (explicit, owner-run, idempotent): a KNOWLEDGE proposal that was really an operational owner request
-- (Founder 1's 62cbe1b7, filed before this queue existed) becomes a PENDING owner request. Eligible only with the
-- deterministic marker the founder wrote itself (category 'policy', title "Owner request: …"); the migration converts
-- nothing on its own. Deterministic copy: founder,
-- original submission time (its age stays true), title and content (already scrubbed at proposal time), and the proposal
-- id itself as the request id and provenance. The goal is the explicit argument, else the ONE goal id the content names,
-- else none. Category and blocking are never guessed: the owner states them. Nothing is decided or granted; the
-- proposal itself is untouched and stays auditable. Re-running returns the same request.
CREATE FUNCTION fleet_owner_request_import(p_proposal uuid, p_category text, p_blocking boolean, p_goal text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE k fleet_knowledge_proposals; r fleet_owner_requests; v_goal text; v_goal_source text; v_goals text[];
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  SELECT * INTO r FROM fleet_owner_requests WHERE source_ref = p_proposal;
  IF FOUND THEN RETURN fleet_owner_request_json(r) || jsonb_build_object('agentId', r.agent_id, 'replayed', true); END IF;
  IF p_category IS NULL OR p_category NOT IN ('sales_channel','account_or_identity','capital_or_spend','policy_exception','information','other') OR p_blocking IS NULL THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: category and blocking are stated by the owner (never inferred)';
  END IF;
  IF p_goal IS NOT NULL AND p_goal !~ '^g[0-9]{1,6}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: goal is g<n>'; END IF;
  SELECT * INTO k FROM fleet_knowledge_proposals WHERE proposal_id = p_proposal;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such knowledge proposal'; END IF;
  -- Only an unreviewed proposal can still be an open request (a promoted/rejected one was already answered as knowledge).
  IF k.status <> 'proposed' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: the proposal was already reviewed (%)', k.status; END IF;
  -- Never ordinary institutional knowledge: only a proposal the founder itself labelled an owner request.
  IF NOT (k.category = 'policy' AND k.title ~* '^owner request:') THEN
    RAISE EXCEPTION 'FLEET_NOT_AN_OWNER_REQUEST: only a policy proposal titled "Owner request: …" can be imported';
  END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), k.agent_id);
  SELECT array_agg(DISTINCT m[1]) INTO v_goals FROM regexp_matches(k.title || ' ' || k.content, '\\m(g[0-9]{1,6})\\M', 'g') m;
  IF p_goal IS NOT NULL THEN v_goal := p_goal; v_goal_source := 'owner';
  ELSIF COALESCE(array_length(v_goals, 1), 0) = 1 THEN v_goal := v_goals[1]; v_goal_source := 'proposal_text';
  ELSE v_goal := NULL; v_goal_source := CASE WHEN COALESCE(array_length(v_goals, 1), 0) = 0 THEN 'none' ELSE 'ambiguous' END;
  END IF;
  INSERT INTO fleet_owner_requests (request_id, agent_id, idempotency_key, category, goal_ref, title, detail, blocking, created_at, source_kind, source_ref, imported_by, imported_at)
    VALUES (k.proposal_id, k.agent_id, 'legacy-knowledge:' || k.proposal_id, p_category, v_goal, left(k.title, 200), left(k.content, 2000), p_blocking,
            k.submitted_at, 'knowledge_proposal', k.proposal_id, p_actor, now())
    RETURNING * INTO r;
  PERFORM fleet_event('owner_request_imported', k.agent_id, p_actor,
    jsonb_build_object('requestId', r.request_id, 'proposalId', k.proposal_id, 'category', p_category, 'blocking', p_blocking, 'goalRef', v_goal, 'goalSource', v_goal_source));
  RETURN fleet_owner_request_json(r) || jsonb_build_object('agentId', r.agent_id, 'goalSource', v_goal_source,
    'note', 'Imported as an unresolved owner request; nothing was decided or granted. The knowledge proposal is unchanged.');
END $$;

CREATE FUNCTION fleet_owner_requests_overview() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'staleAfterS', fleet_owner_request_stale_s(),
    'pending', (SELECT count(*) FROM fleet_owner_requests WHERE status = 'pending'),
    'blockingPending', (SELECT count(*) FROM fleet_owner_requests WHERE status = 'pending' AND blocking),
    'stalePending', (SELECT count(*) FROM fleet_owner_requests WHERE status = 'pending' AND now() - created_at >= make_interval(secs => fleet_owner_request_stale_s())),
    'staleBlocking', (SELECT count(*) FROM fleet_owner_requests WHERE status = 'pending' AND blocking AND now() - created_at >= make_interval(secs => fleet_owner_request_stale_s())),
    'oldestPendingS', (SELECT floor(extract(epoch FROM now() - min(created_at)))::bigint FROM fleet_owner_requests WHERE status = 'pending'),
    'knowledgePending', (SELECT count(*) FROM fleet_knowledge_proposals WHERE status = 'proposed'),
    -- A proposal imported as an owner request is tracked (and warned about) there, not twice.
    'knowledgeImported', (SELECT count(*) FROM fleet_knowledge_proposals k WHERE k.status = 'proposed' AND EXISTS (SELECT 1 FROM fleet_owner_requests r WHERE r.source_ref = k.proposal_id)),
    'oldestKnowledgePendingS', (SELECT floor(extract(epoch FROM now() - min(k.submitted_at)))::bigint FROM fleet_knowledge_proposals k
                                 WHERE k.status = 'proposed' AND NOT EXISTS (SELECT 1 FROM fleet_owner_requests r WHERE r.source_ref = k.proposal_id)))
$$;

-- Owner view: pending owner requests and knowledge proposals awaiting review, oldest first (titles only; no content).
CREATE FUNCTION fleet_owner_queue(p_all boolean) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'ownerRequests', (SELECT COALESCE(jsonb_agg(fleet_owner_request_json(r) || jsonb_build_object('agentId', r.agent_id) ORDER BY r.seq), '[]'::jsonb)
                        FROM fleet_owner_requests r WHERE p_all OR r.status = 'pending'),
    'knowledgeProposals', (SELECT COALESCE(jsonb_agg(jsonb_build_object('proposalId', k.proposal_id, 'agentId', k.agent_id, 'category', k.category, 'title', k.title,
                             'status', k.status, 'submittedAt', k.submitted_at, 'ageS', floor(extract(epoch FROM now() - k.submitted_at))::bigint,
                             'stale', k.status = 'proposed' AND now() - k.submitted_at >= make_interval(secs => fleet_owner_request_stale_s()),
                             'importedAsRequest', EXISTS (SELECT 1 FROM fleet_owner_requests r WHERE r.source_ref = k.proposal_id),
                             -- Advisory only (the owner converts explicitly): the founder labelled it an owner request.
                             'looksLikeOwnerRequest', k.category = 'policy' AND k.title ~* '^owner request:') ORDER BY k.submitted_at), '[]'::jsonb)
                             FROM fleet_knowledge_proposals k WHERE p_all OR k.status = 'proposed'))
$$;

-- Founders see the pipeline's bounds too (the capability signature covers what they can actually do with it).
CREATE OR REPLACE FUNCTION api_capabilities(p_agent text, p_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'capabilities'); a fleet_agents; m fleet_capability_manifests; p fleet_experiment_policy;
BEGIN
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent;
  SELECT * INTO m FROM fleet_capability_manifests WHERE manifest_id = a.capability_manifest_id;
  SELECT * INTO p FROM fleet_experiment_policy WHERE id = 1;
  RETURN jsonb_build_object('ok', true, 'origin', a.origin, 'manifestId', m.manifest_id, 'manifestSha256', m.manifest_sha256,
    'allowed', to_jsonb(m.allowed), 'reproductionExecutable', false, 'paymentExecutable', false,
    'experimentsEnabled', COALESCE(p.enabled, false), 'experimentFinancialMode', p.financial_mode,
    'experimentHardCapMinor', p.hard_cap_minor, 'experimentMaxActive', p.max_active_per_founder, 'ownerRequests', true);
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
