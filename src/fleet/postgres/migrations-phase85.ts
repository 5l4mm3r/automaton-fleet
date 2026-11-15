/**
 * Schema v85 — P3 agent capabilities (owner, 2026-10-16: "equip the agents before they make customer commitments").
 *
 * 1. CAPABILITY CHECK (capabilities.check): the agent's runtime sends what it found locally (its toolset, the installed
 *    libraries, rendering and OCR binaries, exec limits); the Fleet adds what only it knows — sales and the agent's
 *    release, money out (refunds and payouts), the card, connected channels, the agent's mailbox, connected search and
 *    image providers, deliverable and upload file types and limits — records the check, and returns both with an explicit
 *    "not available" list. Required within 7 days before enquiry.quote and offer.publish (FLEET_CAPABILITY_CHECK_REQUIRED):
 *    an agent discovers its limits before it commits to a customer's scope or deadline.
 * 2. CAPABILITY REQUEST (capabilities.request): a missing capability, asked for once with its reason, evidence and what it
 *    blocks (fleet_capability_demands, kind 'request'; repeats update it). The owner is told (AMBER CAPABILITY_REQUESTED,
 *    once per agent and capability). A request is information, never a gate on ordinary business.
 * 3. PRESENTATIONS: .pptx is a deliverable, publishable and uploadable type (offer files, staged and delivered order files,
 *    buyers' files) — verified by the inspector's presentation checks (runtime fleet-qa-2).
 * 4. Media providers (search, image): the registry of what is connected (none until the owner configures one); the check
 *    reports it. The provider gateway itself is a separate unit.
 */
import { V76_SQL } from "./migrations-phase76.js";
import { V80_SQL } from "./migrations-phase80.js";
import { V83_SQL } from "./migrations-phase83.js";
import { restate } from "./migrations-phase42.js";
import { KNOWLEDGE_FOUNDATION_V2 } from "./knowledge-foundation-v2.js";
import { STOREFRONT_FILE_TYPES } from "./migrations-phase52.js";
import { CUSTOMER_FILE_TYPES, CUSTOMER_FILE_MAX_BYTES, DELIVERY_FILE_MAX_BYTES, DELIVERY_TOTAL_MAX_BYTES, QA_INSPECTOR_VERSIONS } from "./migrations-phase76.js";

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** Capability status v10 and production tools v4 (the capability check, presentations, search and images, what is not installed). */
export const LIBRARY_ENTRIES_V85 = ["fleet-capability-status", "bf-production-tools"] as const;
export const PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const DELIVERABLE_FILE_TYPES_V85 = [...STOREFRONT_FILE_TYPES, PPTX_TYPE] as const;
export const CUSTOMER_FILE_TYPES_V85 = [...CUSTOMER_FILE_TYPES, PPTX_TYPE] as const;
/** A capability check counts for this many days before a quote or a publication. */
export const CAPABILITY_CHECK_DAYS = 7;
export const AGENT_OPS_V85 = ["capabilities.check", "capabilities.request", "capabilities.requests", "media.request", "media.result"] as const;
/** The provider gateway's whole database surface (role fleet_media: mx_* only). */
export const MEDIA_API_FUNCTIONS_V85 = ["mx_report(text, text, boolean, integer)", "mx_claim(text, integer)", "mx_result(uuid, boolean, jsonb, integer, text)"] as const;
/** Default per-agent daily caps (jobs), until the owner sets others. */
export const MEDIA_DAILY_DEFAULTS = { search: 60, image: 10 } as const;
/** A result kept for the agent at most this long (an image's bytes are dropped once fetched). */
export const MEDIA_RESULT_MAX_BYTES = 8_000_000;
export const DASHBOARD_READ_OPS_V85 = ["capabilities"] as const;
export const MEDIA_PROVIDER_KINDS = ["search", "image"] as const;

/** Replace every occurrence of the old file-type list (and its human-readable form) in one function's latest source. */
function widen(src: string, name: string, from: readonly string[], to: readonly string[]): string {
  const body = restate(src, name, []);
  const out = body.split(q(from)).join(q(to)).split(from.join(", ")).join(to.join(", "));
  if (out === body) throw new Error(`v85: ${name} names no file-type list`);
  return out;
}

const ORDER_DELIVER = widen(V76_SQL, "fleet_econ_order_deliver", STOREFRONT_FILE_TYPES, DELIVERABLE_FILE_TYPES_V85);
const OFFER_FILE = widen(V76_SQL, "fleet_econ_offer_file", STOREFRONT_FILE_TYPES, DELIVERABLE_FILE_TYPES_V85);
const ORDER_STAGE = widen(V76_SQL, "fleet_econ_order_stage_file", STOREFRONT_FILE_TYPES, DELIVERABLE_FILE_TYPES_V85);
const CUSTOMER_FILES = widen(V76_SQL, "fleet_customer_files_add", CUSTOMER_FILE_TYPES, CUSTOMER_FILE_TYPES_V85);
/** fleet-qa-2 (runtime founder-v10): presentation checks, office rendering, OCR, EPUB package checks. fleet-qa-1 stays valid. */
export const QA_INSPECTOR_VERSIONS_V85 = [...QA_INSPECTOR_VERSIONS, "fleet-qa-2"] as const;
const REVIEW_RECORD = restate(V76_SQL, "fleet_econ_review_record", [
  [`(v_auto ->> 'inspector') NOT IN (${q(QA_INSPECTOR_VERSIONS)})`, `(v_auto ->> 'inspector') NOT IN (${q(QA_INSPECTOR_VERSIONS_V85)})`],
]);

// The gate sits in the dispatcher, before the operation runs (an enquiry or offer lookup cannot answer first).
const DISPATCH = restate(V80_SQL, "api_economy", [
  [`    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PREPARATION_HOLD', 'reason', fleet_outward_refusal(p_agent, p_op, a));
  END IF;`, `    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PREPARATION_HOLD', 'reason', fleet_outward_refusal(p_agent, p_op, a));
  END IF;
  -- v85: no quote and no publication without a capability check in the last ${CAPABILITY_CHECK_DAYS} days.
  IF p_op IN ('offer.publish','enquiry.quote')
     AND NOT EXISTS (SELECT 1 FROM fleet_capability_checks WHERE agent_id = p_agent AND checked_at > now() - interval '${CAPABILITY_CHECK_DAYS} days') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CAPABILITY_CHECK_REQUIRED',
      'reason', 'check what you can actually deliver before you quote or publish: capabilities op check (valid ${CAPABILITY_CHECK_DAYS} days)');
  END IF;`],
  [`WHEN 'channel.api_jobs' THEN 'planning'`, `WHEN 'channel.api_jobs' THEN 'planning' ${AGENT_OPS_V85.map((o) => `WHEN '${o}' THEN 'planning'`).join(" ")}`],
  [`      WHEN 'channel.api_jobs' THEN fleet_econ_channel_api_jobs(p_agent, a)`,
   `      WHEN 'channel.api_jobs' THEN fleet_econ_channel_api_jobs(p_agent, a)
      WHEN 'capabilities.check' THEN fleet_econ_capabilities_check(p_agent, a)
      WHEN 'capabilities.request' THEN fleet_econ_capabilities_request(p_agent, a)
      WHEN 'capabilities.requests' THEN fleet_econ_capabilities_requests(p_agent, a)
      WHEN 'media.request' THEN fleet_econ_media_request(p_agent, a)
      WHEN 'media.result' THEN fleet_econ_media_result(p_agent, a)`],
]);

const DASH_CALL = restate(V83_SQL, "dash_call", [
  [`'launch','helpers','push')) THEN`, `'launch','helpers','push',${q(DASHBOARD_READ_OPS_V85)})) THEN`],
  [`      WHEN 'push' THEN fleet_push_json()`, `      WHEN 'push' THEN fleet_push_json()
      WHEN 'capabilities' THEN fleet_capabilities_json()`],
]);

export const V85_SQL = `
-- ═══ 1. Presentations are deliverable, publishable and uploadable ═══
ALTER TABLE fleet_order_delivery_files DROP CONSTRAINT fleet_order_delivery_files_content_type_check;
ALTER TABLE fleet_order_delivery_files ADD CONSTRAINT fleet_order_delivery_files_content_type_check CHECK (content_type IN (${q(DELIVERABLE_FILE_TYPES_V85)}));
ALTER TABLE fleet_offer_files DROP CONSTRAINT fleet_offer_files_content_type_check;
ALTER TABLE fleet_offer_files ADD CONSTRAINT fleet_offer_files_content_type_check CHECK (content_type IN (${q(DELIVERABLE_FILE_TYPES_V85)}));
ALTER TABLE fleet_order_staged_files DROP CONSTRAINT fleet_order_staged_files_content_type_check;
ALTER TABLE fleet_order_staged_files ADD CONSTRAINT fleet_order_staged_files_content_type_check CHECK (content_type IN (${q(DELIVERABLE_FILE_TYPES_V85)}));
ALTER TABLE fleet_customer_files DROP CONSTRAINT fleet_customer_files_content_type_check;
ALTER TABLE fleet_customer_files ADD CONSTRAINT fleet_customer_files_content_type_check CHECK (content_type IN (${q(CUSTOMER_FILE_TYPES_V85)}));
ALTER TABLE fleet_artifact_reviews DROP CONSTRAINT fleet_artifact_reviews_inspector_check;
ALTER TABLE fleet_artifact_reviews ADD CONSTRAINT fleet_artifact_reviews_inspector_check CHECK (inspector IN (${q(QA_INSPECTOR_VERSIONS_V85)}));
${REVIEW_RECORD}
${ORDER_DELIVER}
${OFFER_FILE}
${ORDER_STAGE}
${CUSTOMER_FILES}

-- ═══ 2. Media providers (search, image): what the owner has connected (none until configured) ═══
CREATE TABLE fleet_media_providers (
  kind            text        PRIMARY KEY CHECK (kind IN (${q(MEDIA_PROVIDER_KINDS)})),
  provider        text        NOT NULL CHECK (provider ~ '^[a-z0-9_-]{2,40}$'),
  configured      boolean     NOT NULL DEFAULT false,
  unit_cost_usd_cents integer CHECK (unit_cost_usd_cents >= 0),
  daily_limit_per_agent integer NOT NULL DEFAULT 10 CHECK (daily_limit_per_agent BETWEEN 0 AND 1000),
  last_seen_at    timestamptz,
  note            text        CHECK (length(note) <= 300),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      text        NOT NULL
);

-- Each search or image an agent asks for: a job the provider gateway runs (never the controller: it has no egress).
CREATE TABLE fleet_media_jobs (
  job_id        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      text        NOT NULL REFERENCES fleet_agents(agent_id),
  kind          text        NOT NULL CHECK (kind IN (${q(MEDIA_PROVIDER_KINDS)})),
  request       jsonb       NOT NULL CHECK (jsonb_typeof(request) = 'object' AND length(request::text) <= 4000),
  idempotency_key text      NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  status        text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  provider      text,
  result        jsonb       CHECK (result IS NULL OR length(result::text) <= ${MEDIA_RESULT_MAX_BYTES}),
  cost_usd_cents integer    CHECK (cost_usd_cents >= 0),
  error         text        CHECK (length(error) <= 300),
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  fetched_at    timestamptz,
  UNIQUE (agent_id, idempotency_key)
);
CREATE INDEX fleet_media_jobs_queue ON fleet_media_jobs (kind, created_at) WHERE status = 'queued';
CREATE TRIGGER fleet_media_jobs_no_delete BEFORE DELETE ON fleet_media_jobs FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_econ_media_request(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE k text := a ->> 'kind'; mp fleet_media_providers; n integer; v uuid; r jsonb;
BEGIN
  IF k IS NULL OR k NOT IN (${q(MEDIA_PROVIDER_KINDS)}) THEN PERFORM fleet_econ_bad('kind: search | image'); END IF;
  SELECT * INTO mp FROM fleet_media_providers WHERE kind = k;
  IF NOT FOUND OR NOT mp.configured OR mp.last_seen_at IS NULL OR mp.last_seen_at < now() - interval '10 minutes' THEN
    RETURN fleet_comms_unavailable(p_agent, CASE k WHEN 'search' THEN 'web_search' ELSE 'image_generation' END, 'media.request', a ->> 'purpose', NULL)
      || jsonb_build_object('reason', CASE k WHEN 'search' THEN 'no web search provider is connected' ELSE 'no image provider is connected' END);
  END IF;
  IF k = 'search' THEN
    IF length(btrim(COALESCE(a ->> 'query', ''))) NOT BETWEEN 2 AND 300 THEN PERFORM fleet_econ_bad('query: 2..300 characters'); END IF;
    r := jsonb_build_object('query', btrim(a ->> 'query'), 'count', LEAST(GREATEST(COALESCE((a ->> 'count')::integer, 5), 1), 10), 'purpose', COALESCE(a ->> 'purpose', 'research'));
  ELSE
    IF length(btrim(COALESCE(a ->> 'prompt', ''))) NOT BETWEEN 3 AND 1000 THEN PERFORM fleet_econ_bad('prompt: 3..1000 characters'); END IF;
    IF COALESCE(a ->> 'size', '1024x1024') NOT IN ('1024x1024','1024x1536','1536x1024') THEN PERFORM fleet_econ_bad('size: 1024x1024 | 1024x1536 | 1536x1024'); END IF;
    r := jsonb_build_object('prompt', btrim(a ->> 'prompt'), 'size', COALESCE(a ->> 'size', '1024x1024'));
  END IF;
  SELECT job_id INTO v FROM fleet_media_jobs WHERE agent_id = p_agent AND idempotency_key = a ->> 'idempotencyKey';
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'jobId', v, 'replay', true); END IF;
  SELECT count(*) INTO n FROM fleet_media_jobs WHERE agent_id = p_agent AND kind = k AND created_at > now() - interval '1 day';
  IF n >= mp.daily_limit_per_agent THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_MEDIA_DAILY_LIMIT', 'reason', 'your ' || k || ' allowance for the last 24 hours is used (' || mp.daily_limit_per_agent || ')');
  END IF;
  INSERT INTO fleet_media_jobs (agent_id, kind, request, idempotency_key) VALUES (p_agent, k, r, a ->> 'idempotencyKey') RETURNING job_id INTO v;
  RETURN jsonb_build_object('ok', true, 'jobId', v, 'unitCostUsdCents', mp.unit_cost_usd_cents);
END $$;

CREATE FUNCTION fleet_econ_media_result(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_media_jobs;
BEGIN
  SELECT * INTO j FROM fleet_media_jobs WHERE job_id = fleet_identity_uuid(a, 'jobId') AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF j.status = 'failed' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PROVIDER_FAILED', 'status', 'failed', 'reason', j.error); END IF;
  IF j.status <> 'done' THEN RETURN jsonb_build_object('ok', true, 'status', j.status); END IF;
  -- An image's bytes go to the agent once; the record keeps what it was and what it cost.
  IF j.fetched_at IS NULL THEN UPDATE fleet_media_jobs SET fetched_at = now(), result = CASE WHEN kind = 'image' THEN result - 'imageB64' ELSE result END WHERE job_id = j.job_id; END IF;
  RETURN jsonb_build_object('ok', true, 'status', 'done', 'result', CASE WHEN j.fetched_at IS NULL THEN j.result ELSE j.result - 'imageB64' END, 'costUsdCents', j.cost_usd_cents, 'provider', j.provider);
END $$;

-- The provider gateway (role fleet_media): reports what it holds, claims jobs, records results.
CREATE FUNCTION mx_report(p_kind text, p_provider text, p_configured boolean, p_unit_cost integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_kind NOT IN (${q(MEDIA_PROVIDER_KINDS)}) OR p_provider !~ '^[a-z0-9_-]{2,40}$' OR p_configured IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  INSERT INTO fleet_media_providers (kind, provider, configured, unit_cost_usd_cents, daily_limit_per_agent, last_seen_at, updated_by)
    VALUES (p_kind, p_provider, p_configured, p_unit_cost, CASE p_kind WHEN 'search' THEN ${MEDIA_DAILY_DEFAULTS.search} ELSE ${MEDIA_DAILY_DEFAULTS.image} END, now(), 'media-gateway')
    ON CONFLICT (kind) DO UPDATE SET provider = EXCLUDED.provider, configured = EXCLUDED.configured, unit_cost_usd_cents = EXCLUDED.unit_cost_usd_cents,
      last_seen_at = now(), updated_at = now(), updated_by = 'media-gateway';
  RETURN jsonb_build_object('ok', true, 'schemaVersion', (SELECT max(version) FROM fleet_schema_migrations));
END $$;

CREATE FUNCTION mx_claim(p_kind text, p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE out jsonb := '[]'::jsonb; j record;
BEGIN
  FOR j IN SELECT job_id, kind, request FROM fleet_media_jobs WHERE status = 'queued' AND kind = p_kind ORDER BY created_at
            LIMIT LEAST(GREATEST(COALESCE(p_limit, 4), 1), 20) FOR UPDATE SKIP LOCKED LOOP
    UPDATE fleet_media_jobs SET status = 'running', started_at = now(), provider = (SELECT provider FROM fleet_media_providers WHERE kind = j.kind) WHERE job_id = j.job_id;
    out := out || jsonb_build_object('jobId', j.job_id, 'kind', j.kind, 'request', j.request);
  END LOOP;
  -- A job left running by a gateway that died is failed (the agent may ask again), never silently re-run.
  UPDATE fleet_media_jobs SET status = 'failed', finished_at = now(), error = 'the provider gateway stopped while running it'
   WHERE status = 'running' AND kind = p_kind AND started_at < now() - interval '5 minutes';
  RETURN out;
END $$;

CREATE FUNCTION mx_result(p_job uuid, p_ok boolean, p_result jsonb, p_cost integer, p_error text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  UPDATE fleet_media_jobs SET status = CASE WHEN p_ok THEN 'done' ELSE 'failed' END, finished_at = now(),
    result = CASE WHEN p_ok THEN p_result END, cost_usd_cents = GREATEST(COALESCE(p_cost, 0), 0), error = CASE WHEN p_ok THEN NULL ELSE left(COALESCE(p_error, 'provider error'), 300) END
   WHERE job_id = p_job AND status = 'running';
  RETURN jsonb_build_object('ok', FOUND);
END $$;

-- ═══ 3. Capability checks and requests ═══
CREATE TABLE fleet_capability_checks (
  check_id   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   text        NOT NULL REFERENCES fleet_agents(agent_id),
  checked_at timestamptz NOT NULL DEFAULT now(),
  for_offer  text        CHECK (length(for_offer) <= 200),
  runtime    jsonb       NOT NULL CHECK (jsonb_typeof(runtime) = 'object' AND length(runtime::text) <= 8000),
  fleet      jsonb       NOT NULL CHECK (jsonb_typeof(fleet) = 'object')
);
CREATE INDEX fleet_capability_checks_recent ON fleet_capability_checks (agent_id, checked_at DESC);
CREATE TRIGGER fleet_capability_checks_no_change BEFORE UPDATE OR DELETE ON fleet_capability_checks FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

ALTER TABLE fleet_capability_demands DROP CONSTRAINT fleet_capability_demands_capability_check;
ALTER TABLE fleet_capability_demands ADD CONSTRAINT fleet_capability_demands_capability_check CHECK (capability ~ '^[a-z0-9][a-z0-9_.-]{1,59}$');
ALTER TABLE fleet_capability_demands ADD COLUMN kind text NOT NULL DEFAULT 'dependency' CHECK (kind IN ('dependency','request'));
ALTER TABLE fleet_capability_demands ADD COLUMN reason text CHECK (length(reason) <= 600);
ALTER TABLE fleet_capability_demands ADD COLUMN evidence text CHECK (length(evidence) <= 1200);
ALTER TABLE fleet_capability_demands ADD COLUMN blocks text CHECK (length(blocks) <= 200);
ALTER TABLE fleet_capability_demands ADD COLUMN urgency text CHECK (urgency IN ('low','normal','high'));

-- What only the Fleet knows about this agent's capabilities today (states, never secrets).
CREATE FUNCTION fleet_agent_capability_states(p_agent text) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'salesOpen', COALESCE((SELECT sales_open FROM fleet_public_site LIMIT 1), false),
    'publicSite', EXISTS (SELECT 1 FROM fleet_public_site),
    'outwardActions', CASE WHEN fleet_outward_refusal(p_agent, 'browser.act', '{}'::jsonb) IS NULL THEN 'permitted' ELSE 'held' END,
    'moneyOut', CASE WHEN COALESCE((SELECT custody_execution_enabled FROM fleet_economic_model WHERE id = 1), false) THEN 'active' ELSE 'not_active' END,
    'refunds', CASE WHEN COALESCE((SELECT custody_execution_enabled FROM fleet_economic_model WHERE id = 1), false) THEN 'possible' ELSE 'not_possible_until_money_out_is_active' END,
    'card', CASE WHEN COALESCE((SELECT enabled AND card_enabled FROM fleet_identity_autonomy LIMIT 1), false) THEN 'by_request' ELSE 'not_active' END,
    'mailbox', EXISTS (SELECT 1 FROM fleet_agent_mailboxes WHERE agent_id = p_agent AND status = 'active'),
    'apiChannels', COALESCE((SELECT jsonb_agg(jsonb_build_object('channelId', c.channel_id, 'provider', k.provider, 'status', k.status))
                     FROM fleet_venture_channels c JOIN fleet_channel_connections k ON k.channel_id = c.channel_id WHERE c.agent_id = p_agent), '[]'::jsonb),
    'search', COALESCE((SELECT CASE WHEN configured AND last_seen_at > now() - interval '10 minutes' THEN 'connected' ELSE 'not_connected' END FROM fleet_media_providers WHERE kind = 'search'), 'not_connected'),
    'imageGeneration', COALESCE((SELECT CASE WHEN configured AND last_seen_at > now() - interval '10 minutes' THEN 'connected' ELSE 'not_connected' END FROM fleet_media_providers WHERE kind = 'image'), 'not_connected'),
    'deliverableTypes', jsonb_build_array(${q(DELIVERABLE_FILE_TYPES_V85)}),
    'customerUploadTypes', jsonb_build_array(${q(CUSTOMER_FILE_TYPES_V85)}),
    'limits', jsonb_build_object('deliveryFileBytes', ${DELIVERY_FILE_MAX_BYTES}, 'deliveryTotalBytes', ${DELIVERY_TOTAL_MAX_BYTES}, 'deliveryFiles', 10,
                                 'customerFileBytes', ${CUSTOMER_FILE_MAX_BYTES}, 'downloadDays', 30))
$$;

CREATE FUNCTION fleet_econ_capabilities_check(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st jsonb := fleet_agent_capability_states(p_agent); rt jsonb := COALESCE(a -> 'runtime', '{}'::jsonb); missing jsonb := '[]'::jsonb; v uuid;
BEGIN
  IF jsonb_typeof(rt) <> 'object' OR length(rt::text) > 8000 THEN PERFORM fleet_econ_bad('runtime is an object (your runtime''s own probe, at most 8 KB)'); END IF;
  IF st ->> 'salesOpen' <> 'true' AND st ->> 'outwardActions' = 'held' THEN missing := missing || '["selling to the public: sales are closed and no release names you"]'::jsonb; END IF;
  IF st ->> 'refunds' <> 'possible' THEN missing := missing || '["refunds and paying out: money out is not active"]'::jsonb; END IF;
  IF st ->> 'card' <> 'by_request' THEN missing := missing || '["card purchases"]'::jsonb; END IF;
  IF st ->> 'mailbox' <> 'true' THEN missing := missing || '["delivery mail: you have no routing mailbox yet (identity provision_mailbox)"]'::jsonb; END IF;
  IF st ->> 'search' <> 'connected' THEN missing := missing || '["web_search: no search provider connected (use web_fetch on sites'' own search pages)"]'::jsonb; END IF;
  IF st ->> 'imageGeneration' <> 'connected' THEN missing := missing || '["generate_image: no image provider connected (draw with code: HTML/SVG, Pillow, matplotlib)"]'::jsonb; END IF;
  IF COALESCE(rt ->> 'renderer', '') = '' THEN missing := missing || '["rendering Word and PowerPoint files to images: not installed (PDF pages are rendered)"]'::jsonb; END IF;
  IF COALESCE(rt ->> 'ocr', '') = '' THEN missing := missing || '["OCR of scanned pages: not installed"]'::jsonb; END IF;
  INSERT INTO fleet_capability_checks (agent_id, for_offer, runtime, fleet) VALUES (p_agent, left(fleet_scrub(a ->> 'forOffer'), 200), rt, st) RETURNING check_id INTO v;
  RETURN jsonb_build_object('ok', true, 'checkId', v, 'validDays', ${CAPABILITY_CHECK_DAYS}, 'fleet', st, 'notAvailable', missing);
END $$;

CREATE FUNCTION fleet_econ_capabilities_request(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE cap text := lower(btrim(COALESCE(a ->> 'capability', ''))); v uuid; n integer;
BEGIN
  IF cap !~ '^[a-z0-9][a-z0-9_.-]{1,59}$' THEN PERFORM fleet_econ_bad('capability: a short name (letters, digits, . _ -), e.g. ocr, pptx-render, search, image-generation, network-build-sandbox'); END IF;
  IF length(btrim(COALESCE(a ->> 'reason', ''))) < 10 THEN PERFORM fleet_econ_bad('reason: why you need it (at least a sentence)'); END IF;
  IF length(btrim(COALESCE(a ->> 'evidence', ''))) < 10 THEN PERFORM fleet_econ_bad('evidence: the opportunity, demand or expected value behind it'); END IF;
  IF a ? 'urgency' AND a ->> 'urgency' NOT IN ('low','normal','high') THEN PERFORM fleet_econ_bad('urgency: low | normal | high'); END IF;
  INSERT INTO fleet_capability_demands (demand_id, agent_id, capability, last_op, purpose, kind, reason, evidence, blocks, urgency)
    VALUES (gen_random_uuid(), p_agent, cap, 'capabilities.request', NULL, 'request', left(fleet_scrub(a ->> 'reason'), 600), left(fleet_scrub(a ->> 'evidence'), 1200),
            left(fleet_scrub(a ->> 'blocks'), 200), COALESCE(a ->> 'urgency', 'normal'))
    ON CONFLICT (agent_id, capability) WHERE status = 'open' DO UPDATE SET attempts = fleet_capability_demands.attempts + 1, last_at = now(), kind = 'request',
       reason = EXCLUDED.reason, evidence = EXCLUDED.evidence, blocks = COALESCE(EXCLUDED.blocks, fleet_capability_demands.blocks), urgency = EXCLUDED.urgency
    RETURNING demand_id, attempts INTO v, n;
  IF n = 1 THEN
    PERFORM fleet_event('capability_dependency', p_agent, p_agent, jsonb_build_object('capability', cap, 'op', 'capabilities.request', 'kind', 'request'));
    PERFORM fleet_notify('AMBER', 'CAPABILITY_REQUESTED', p_agent, 'An agent asks for a capability: ' || cap,
      jsonb_build_object('capability', cap, 'urgency', COALESCE(a ->> 'urgency', 'normal'), 'demandId', v), 'capability-request:' || p_agent || ':' || cap);
  END IF;
  RETURN jsonb_build_object('ok', true, 'requestId', v, 'repeat', n > 1,
    'note', 'Recorded for the owner. Keep working on everything that does not depend on it; you will see the capability in capabilities op check once it is connected.');
END $$;

CREATE FUNCTION fleet_econ_capabilities_requests(p_agent text, a jsonb) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'requests', COALESCE(jsonb_agg(jsonb_build_object('requestId', demand_id, 'capability', capability, 'kind', kind, 'status', status,
    'reason', reason, 'blocks', blocks, 'urgency', urgency, 'attempts', attempts, 'firstAt', first_at, 'lastAt', last_at) ORDER BY last_at DESC), '[]'::jsonb))
    FROM fleet_capability_demands WHERE agent_id = p_agent
$$;

-- The owner's view: open requests and each agent's last check.
CREATE FUNCTION fleet_capabilities_json() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'requests', COALESCE((SELECT jsonb_agg(jsonb_build_object('requestId', demand_id, 'agentId', agent_id, 'capability', capability, 'kind', kind, 'reason', reason,
                  'evidence', evidence, 'blocks', blocks, 'urgency', urgency, 'attempts', attempts, 'firstAt', first_at, 'lastAt', last_at) ORDER BY last_at DESC)
                  FROM fleet_capability_demands WHERE status = 'open'), '[]'::jsonb),
    'lastChecks', COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId', c.agent_id, 'checkedAt', c.checked_at, 'forOffer', c.for_offer,
                  'toolset', c.runtime ->> 'toolset', 'renderer', c.runtime ->> 'renderer', 'ocr', c.runtime ->> 'ocr'))
                  FROM (SELECT DISTINCT ON (agent_id) * FROM fleet_capability_checks ORDER BY agent_id, checked_at DESC) c), '[]'::jsonb),
    'mediaProviders', COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', kind, 'provider', provider, 'configured', configured, 'unitCostUsdCents', unit_cost_usd_cents,
                  'dailyLimitPerAgent', daily_limit_per_agent, 'lastSeenAt', last_seen_at, 'alive', last_seen_at > now() - interval '10 minutes')) FROM fleet_media_providers), '[]'::jsonb),
    'mediaUsage30d', COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId', agent_id, 'kind', kind, 'jobs', n, 'failed', nf, 'costUsdCents', c))
                  FROM (SELECT agent_id, kind, count(*) AS n, count(*) FILTER (WHERE status = 'failed') AS nf, COALESCE(sum(cost_usd_cents), 0) AS c
                          FROM fleet_media_jobs WHERE created_at > now() - interval '30 days' GROUP BY agent_id, kind) u), '[]'::jsonb))
$$;

${DISPATCH}

-- ═══ 5. The shared library: capability status v10, production tools v4 ═══
SELECT fleet_admin_knowledge_library_load(${lit(JSON.stringify({ entries: KNOWLEDGE_FOUNDATION_V2.entries.filter((e) => (LIBRARY_ENTRIES_V85 as readonly string[]).includes(e.id)) }))}::jsonb, 'migration');

${DASH_CALL}
`;
