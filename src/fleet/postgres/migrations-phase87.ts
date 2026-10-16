/**
 * Schema v87 — P3 (owner, 2026-10-16): paid search / images are charged, and a capability check covers the actual work.
 *
 * PAID MEDIA follows the existing operating model:
 *   - the requesting agent pays. Before a job runs its most possible cost (the provider's per-job limit the gateway
 *     reports, in USD, at the controlled USD rate, rounded up) is RESERVED from the agent's own cash — not enough cash, no
 *     job (no automatic rescue, no advance);
 *   - Fleet-benefiting work names its beneficiary explicitly: a job done for one of the agent's ACTIVE missions records that
 *     mission, and the mission's own beneficiaries (another agent, or the Fleet) pay their share through the existing
 *     mission cost recharge when it ends (v35) — nothing new decides who pays;
 *   - the job settles ONCE at its ACTUAL cost (the provider's usage where it reports it — OpenAI image tokens — else its
 *     flat price, else the owner's estimate, each labelled): the agent's expense, the unused reservation back; the provider
 *     is paid on the owner's card, so the cost is owed to the owner like AI credit (v69: treasury cash held for the owner,
 *     owner payable). A cost beyond the reservation is a Fleet expense owed to the owner and an alert — never more taken
 *     from the agent than it reserved;
 *   - a failed job the provider did not charge releases its reservation; a job whose gateway stopped mid-run keeps its
 *     reservation (the provider may have charged) until the owner resolves it from the provider's own usage page;
 *   - the owner records each provider statement: the difference to what the Fleet recorded is posted (spend the Fleet did
 *     not track is still on the books) and alerted.
 *
 * CAPABILITY CHECKS name the work: an offer or an enquiry and its deliverables (format and what each needs: search,
 * images, rendering, OCR, refunds, card). Each deliverable gets a verdict from the agent's own runtime probe (its
 * libraries, renderer, OCR) and the Fleet's current states; the check keeps a fingerprint of those states and of the
 * agent's runtime build. Publishing an offer or quoting an enquiry needs a check, in the last 7 days, that names it, whose
 * deliverables are all ready, cover the offer's deliverable files, and whose fingerprint still matches — a recent generic
 * check, or one taken before a provider dropped or the runtime changed, is not enough.
 */
import { V85_SQL, CAPABILITY_CHECK_DAYS, MEDIA_PROVIDER_KINDS } from "./migrations-phase85.js";
import { V86_SQL } from "./migrations-phase86.js";
import { restate } from "./migrations-phase42.js";
import { KNOWLEDGE_FOUNDATION_V2 } from "./knowledge-foundation-v2.js";

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
/** v87 reloads the capability status (v11: checks name the work; paid media; the bank debit card). */
export const LIBRARY_ENTRIES_V87 = ["fleet-capability-status"] as const;
export const MEDIA_COST_BASES = ["usage", "flat", "estimate", "owner"] as const;
export const MEDIA_COST_STATES = ["reserved", "charged", "released", "unknown"] as const;
/** The media gateway's surface (v87: mx_result also says how the cost was measured). */
export const MEDIA_API_FUNCTIONS_V87 = ["mx_report(text, text, boolean, integer)", "mx_claim(text, integer)", "mx_result(uuid, boolean, jsonb, integer, text, text)"] as const;
export const MEDIA_LEDGER_KINDS = ["media_reserve", "media_release", "media_charge", "media_provider_statement"] as const;
export const DASHBOARD_READ_OPS_V87 = [] as const;
export const DASHBOARD_SENSITIVE_OPS_V87 = ["media_statement"] as const;
export const DASHBOARD_WRITE_OPS_V87_ADDED = ["media_job_resolve"] as const;
/** Deliverable formats an agent can name in a check: extension → content type and the runtime library area it needs. */
export const DELIVERABLE_FORMATS = {
  pdf: ["application/pdf", "pdf"], docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "documents"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "spreadsheets"],
  pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "presentations"], epub: ["application/epub+zip", "ebooks"],
  png: ["image/png", "images"], jpg: ["image/jpeg", "images"], jpeg: ["image/jpeg", "images"], csv: ["text/csv", ""], txt: ["text/plain", ""], zip: ["application/zip", ""],
} as const;
export const DELIVERABLE_NEEDS = ["web_search", "generate_image", "render", "ocr", "refunds", "card", "mailbox"] as const;

const RATE = `COALESCE((SELECT rate_micro FROM fleet_fx_rates WHERE base = 'USD' AND quote = (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1)
   ORDER BY observed_on DESC, rate_id DESC LIMIT 1), 1000000)`;
const FORMATS_SQL = Object.entries(DELIVERABLE_FORMATS).map(([k, [ct, area]]) => `('${k}', '${ct}', '${area}')`).join(", ");

// ── The dispatcher: the v85 "any check in 7 days" gate becomes "a check that covers THIS work, still true" ──
const DISPATCH = restate(V86_SQL, "api_economy", [
  [`DECLARE v_code text; v_class text;`, `DECLARE cov jsonb; v_code text; v_class text;`],
  [`  -- v85: no quote and no publication without a capability check in the last ${CAPABILITY_CHECK_DAYS} days.
  IF p_op IN ('offer.publish','enquiry.quote')
     AND NOT EXISTS (SELECT 1 FROM fleet_capability_checks WHERE agent_id = p_agent AND checked_at > now() - interval '${CAPABILITY_CHECK_DAYS} days') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CAPABILITY_CHECK_REQUIRED',
      'reason', 'check what you can actually deliver before you quote or publish: capabilities op check (valid ${CAPABILITY_CHECK_DAYS} days)');
  END IF;`,
   `  -- v87: no quote and no publication without a capability check that names this offer / enquiry, finds every deliverable
  -- ready, covers the offer's files, and still matches the Fleet's states and the agent's runtime.
  IF p_op IN ('offer.publish','enquiry.quote') THEN
    cov := fleet_capability_check_covers(p_agent, p_op, a);
    IF NOT (cov ->> 'ok')::boolean THEN RETURN cov; END IF;
  END IF;`],
]);

const DASH_CALL = restate(V86_SQL, "dash_call", [
  [`'location_contribution','card_hold_release');`, `'location_contribution','card_hold_release',${q(DASHBOARD_SENSITIVE_OPS_V87)});`],
  [`'card_dispute_open','card_dispute_resolve');`, `'card_dispute_open','card_dispute_resolve',${q(DASHBOARD_WRITE_OPS_V87_ADDED)});`],
  [`      WHEN 'transfer_arrival' THEN`, `      WHEN 'media_job_resolve' THEN fleet_admin_media_job_resolve((a ->> 'jobId')::uuid, NULLIF(a ->> 'costUsdCents', '')::integer, a ->> 'note', 'operator:owner')
      WHEN 'transfer_arrival' THEN`],
  [`      WHEN 'card_hold_release' THEN`, `      WHEN 'media_statement' THEN fleet_admin_media_statement(a ->> 'provider', (a ->> 'periodStart')::date, (a ->> 'periodEnd')::date, (a ->> 'billedUsdCents')::integer, a ->> 'note', 'operator:owner')
      WHEN 'card_hold_release' THEN`],
]);

const OPS_WATCH = restate(V86_SQL, "svc_operations_watch", [
  [`  rec := fleet_treasury_reconciliation();`, `  -- v87: paid media whose cost is unknown (the gateway stopped mid-run): their reservations stay until resolved.
  SELECT count(*) INTO k FROM fleet_media_jobs WHERE cost_state = 'unknown';
  IF k > 0 AND fleet_notify('AMBER', 'MEDIA_COST_UNKNOWN', NULL, k || ' search / image job(s) stopped mid-run: check the provider''s usage page and resolve them',
       jsonb_build_object('count', k), 'media-unknown:' || day) THEN n := n + 1; END IF;
  rec := fleet_treasury_reconciliation();`],
]);

export const V87_SQL = `
-- ═══ 1. The ledger grammar for paid media ═══
ALTER TABLE fleet_ledger_kinds DISABLE TRIGGER fleet_ledger_kinds_no_change;
INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance) VALUES
  ('media_reserve', false, ARRAY['controller'], false, 'A search / image job''s most possible cost reserved from the requesting agent''s cash before it runs', 'reservation'),
  ('media_release', false, ARRAY['controller','owner'], false, 'A media reservation released (the provider did not charge)', 'reservation'),
  ('media_charge', false, ARRAY['controller','owner'], false, 'A search / image job settled at its actual cost: the agent''s expense, the provider paid on the owner''s card (owed to the owner); any cost beyond the reservation a Fleet expense', 'expense'),
  ('media_provider_statement', false, ARRAY['owner'], false, 'A media provider''s statement against what the Fleet recorded: the difference, owed to (or by) the owner', 'expense');
ALTER TABLE fleet_ledger_kinds ENABLE TRIGGER fleet_ledger_kinds_no_change;
INSERT INTO fleet_ledger_rules (kind, class, side) VALUES
  ('media_reserve','agent_reserved','D'), ('media_reserve','agent_cash','C'),
  ('media_release','agent_cash','D'), ('media_release','agent_reserved','C'),
  ('media_charge','agent_expense','D'), ('media_charge','agent_reserved','C'), ('media_charge','agent_cash','D'),
  ('media_charge','treasury_cash','D'), ('media_charge','owner_payable','C'), ('media_charge','fleet_expense','D'),
  ('media_provider_statement','fleet_expense','D'), ('media_provider_statement','owner_payable','C'),
  ('media_provider_statement','fleet_expense','C'), ('media_provider_statement','owner_payable','D');

-- USD cents at the controlled USD rate, in the accounting currency's minor units, rounded up (never under-reserved).
CREATE FUNCTION fleet_media_usd_to_minor(p_cents integer) RETURNS bigint LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT CASE WHEN p_cents IS NULL THEN NULL ELSE ceil(p_cents::numeric * ${RATE} / 1000000)::bigint END
$$;

ALTER TABLE fleet_media_jobs ADD COLUMN reserved_minor bigint CHECK (reserved_minor >= 0);
ALTER TABLE fleet_media_jobs ADD COLUMN charged_minor bigint CHECK (charged_minor >= 0);
ALTER TABLE fleet_media_jobs ADD COLUMN overrun_minor bigint CHECK (overrun_minor >= 0);
ALTER TABLE fleet_media_jobs ADD COLUMN cost_basis text CHECK (cost_basis IN (${q(MEDIA_COST_BASES)}));
ALTER TABLE fleet_media_jobs ADD COLUMN cost_state text CHECK (cost_state IN (${q(MEDIA_COST_STATES)}));
ALTER TABLE fleet_media_jobs ADD COLUMN mission_id uuid REFERENCES fleet_agent_missions(mission_id);
ALTER TABLE fleet_media_jobs ADD COLUMN settle_journal uuid;
ALTER TABLE fleet_media_jobs ADD COLUMN resolved_note text CHECK (length(resolved_note) <= 300);
COMMENT ON COLUMN fleet_media_jobs.mission_id IS 'v87: done for this active mission of the agent; the mission''s beneficiaries pay their share at its end (v35 recharge)';

-- One settlement per job (whatever calls it, however often): the reservation becomes the actual cost.
CREATE FUNCTION fleet_media_settle(p_job uuid, p_cost_cents integer, p_basis text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_media_jobs; v_cost bigint; v_charge bigint; v_over bigint; v_back bigint; v_lines jsonb; v_j uuid; v_src text;
BEGIN
  SELECT * INTO j FROM fleet_media_jobs WHERE job_id = p_job FOR UPDATE;
  IF j.cost_state IS NULL OR j.cost_state IN ('charged','released') THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'costState', j.cost_state); END IF;
  v_src := CASE WHEN p_actor LIKE 'operator:%' THEN 'owner' ELSE 'controller' END;
  PERFORM 1 FROM fleet_ledger_accounts WHERE account_id IN (fleet_ledger_account(j.agent_id, 'agent_cash'), fleet_ledger_account(j.agent_id, 'agent_reserved')) ORDER BY account_id FOR UPDATE;
  IF COALESCE(p_cost_cents, 0) <= 0 THEN
    IF j.reserved_minor > 0 THEN
      v_j := fleet_ledger_post('media_release', 'media:' || j.job_id || ':settle', left(p_actor, 128), 'media job not charged by the provider', v_src, j.agent_id, NULL, NULL, NULL, NULL, now(),
        jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(j.agent_id, 'agent_cash'), 'side', 'D', 'amount', j.reserved_minor),
                          jsonb_build_object('account', fleet_ledger_account(j.agent_id, 'agent_reserved'), 'side', 'C', 'amount', j.reserved_minor)));
    END IF;
    UPDATE fleet_media_jobs SET cost_state = 'released', charged_minor = 0, cost_usd_cents = 0, cost_basis = COALESCE(p_basis, cost_basis), settle_journal = v_j WHERE job_id = j.job_id;
    RETURN jsonb_build_object('ok', true, 'costState', 'released', 'releasedMinor', j.reserved_minor);
  END IF;
  v_cost := fleet_media_usd_to_minor(p_cost_cents);
  v_charge := LEAST(v_cost, j.reserved_minor);   -- never more from the agent than it reserved
  v_over := v_cost - v_charge;                    -- beyond the reservation: a Fleet expense, alerted
  v_back := j.reserved_minor - v_charge;
  v_lines := jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(j.agent_id, 'agent_reserved'), 'side', 'C', 'amount', j.reserved_minor));
  IF v_charge > 0 THEN v_lines := v_lines || jsonb_build_array(
    jsonb_build_object('account', fleet_ledger_account(j.agent_id, 'agent_expense'), 'side', 'D', 'amount', v_charge),
    jsonb_build_object('account', 'fleet:treasury:owner_reimbursable', 'side', 'D', 'amount', v_charge)); END IF;
  IF v_back > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(j.agent_id, 'agent_cash'), 'side', 'D', 'amount', v_back)); END IF;
  IF v_over > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'fleet:expense', 'side', 'D', 'amount', v_over)); END IF;
  v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'fleet:owner:payable', 'side', 'C', 'amount', v_cost));
  v_j := fleet_ledger_post('media_charge', 'media:' || j.job_id || ':settle', left(p_actor, 128), left(j.kind || ' job (' || COALESCE(j.provider, '?') || ')', 200), v_src, j.agent_id,
    NULL, NULL, NULL, NULL, now(), v_lines);
  UPDATE fleet_media_jobs SET cost_state = 'charged', cost_usd_cents = p_cost_cents, cost_basis = p_basis, charged_minor = v_charge, overrun_minor = v_over, settle_journal = v_j
   WHERE job_id = j.job_id;
  IF v_over > 0 THEN
    PERFORM fleet_notify('AMBER', 'MEDIA_COST_OVERRUN', j.agent_id, 'A ' || j.kind || ' job cost more than its limit; the Fleet bears the difference',
      jsonb_build_object('jobId', j.job_id, 'reservedMinor', j.reserved_minor, 'costMinor', v_cost, 'basis', p_basis), 'media-overrun:' || j.job_id);
  END IF;
  RETURN jsonb_build_object('ok', true, 'costState', 'charged', 'chargedMinor', v_charge, 'overrunMinor', v_over, 'returnedMinor', v_back);
END $$;

-- ═══ 2. Requests reserve first; results settle once ═══
CREATE OR REPLACE FUNCTION fleet_econ_media_request(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE k text := a ->> 'kind'; mp fleet_media_providers; n integer; v uuid; r jsonb; v_res bigint; v_cash bigint; m fleet_agent_missions; v_j uuid;
BEGIN
  IF k IS NULL OR k NOT IN (${q(MEDIA_PROVIDER_KINDS)}) THEN PERFORM fleet_econ_bad('kind: search | image'); END IF;
  SELECT * INTO mp FROM fleet_media_providers WHERE kind = k;
  IF NOT FOUND OR NOT mp.configured OR mp.last_seen_at IS NULL OR mp.last_seen_at < now() - interval '10 minutes' THEN
    RETURN fleet_comms_unavailable(p_agent, CASE k WHEN 'search' THEN 'web_search' ELSE 'image_generation' END, 'media.request', a ->> 'purpose', NULL)
      || jsonb_build_object('reason', CASE k WHEN 'search' THEN 'no web search provider is connected' ELSE 'no image provider is connected' END);
  END IF;
  -- No cost limit known, no job: spend the Fleet cannot bound or record is not started.
  IF COALESCE(mp.unit_cost_usd_cents, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_MEDIA_COST_UNKNOWN', 'reason', 'the owner has not set this provider''s cost limit yet; no job can be paid for');
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
  -- Fleet-benefiting work is named: one of your ACTIVE missions (its beneficiaries pay their share when it ends).
  IF a ? 'missionId' THEN
    SELECT * INTO m FROM fleet_agent_missions WHERE mission_id = fleet_identity_uuid(a, 'missionId') AND agent_id = p_agent AND status = 'active';
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND', 'reason', 'missionId: one of your active missions'); END IF;
  END IF;
  SELECT count(*) INTO n FROM fleet_media_jobs WHERE agent_id = p_agent AND kind = k AND created_at > now() - interval '1 day';
  IF n >= mp.daily_limit_per_agent THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_MEDIA_DAILY_LIMIT', 'reason', 'your ' || k || ' allowance for the last 24 hours is used (' || mp.daily_limit_per_agent || ')');
  END IF;
  v_res := fleet_media_usd_to_minor(mp.unit_cost_usd_cents);
  PERFORM 1 FROM fleet_ledger_accounts WHERE account_id IN (fleet_ledger_account(p_agent, 'agent_cash'), fleet_ledger_account(p_agent, 'agent_reserved')) ORDER BY account_id FOR UPDATE;
  v_cash := fleet_agent_cash(p_agent);
  IF v_res > v_cash THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INSUFFICIENT_FUNDS', 'reservedMinor', v_res, 'availableMinor', v_cash,
      'reason', 'this job may cost up to the reserved amount and your cash does not cover it (nothing is advanced)');
  END IF;
  INSERT INTO fleet_media_jobs (agent_id, kind, request, idempotency_key, reserved_minor, cost_state, mission_id)
    VALUES (p_agent, k, r, a ->> 'idempotencyKey', v_res, 'reserved', m.mission_id) RETURNING job_id INTO v;
  v_j := fleet_ledger_post('media_reserve', 'media:' || v || ':reserve', 'agent:' || p_agent, left('reserve: ' || k || ' job', 200), 'controller', p_agent, NULL, NULL, NULL, NULL, now(),
    jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_reserved'), 'side', 'D', 'amount', v_res),
                      jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'C', 'amount', v_res)));
  RETURN jsonb_build_object('ok', true, 'jobId', v, 'reservedMinor', v_res, 'missionId', m.mission_id,
    'note', 'up to this amount is reserved from your cash; you pay the actual cost when the job finishes, the rest comes back');
END $$;

CREATE OR REPLACE FUNCTION fleet_econ_media_result(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_media_jobs;
BEGIN
  SELECT * INTO j FROM fleet_media_jobs WHERE job_id = fleet_identity_uuid(a, 'jobId') AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF j.status = 'failed' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PROVIDER_FAILED', 'status', 'failed', 'reason', j.error,
    'costState', j.cost_state, 'chargedMinor', j.charged_minor); END IF;
  IF j.status <> 'done' THEN RETURN jsonb_build_object('ok', true, 'status', j.status, 'reservedMinor', j.reserved_minor); END IF;
  IF j.fetched_at IS NULL THEN UPDATE fleet_media_jobs SET fetched_at = now(), result = CASE WHEN kind = 'image' THEN result - 'imageB64' ELSE result END WHERE job_id = j.job_id; END IF;
  RETURN jsonb_build_object('ok', true, 'status', 'done', 'result', CASE WHEN j.fetched_at IS NULL THEN j.result ELSE j.result - 'imageB64' END,
    'costUsdCents', j.cost_usd_cents, 'chargedMinor', j.charged_minor, 'costBasis', j.cost_basis, 'provider', j.provider);
END $$;

-- The gateway: a job left running by a gateway that stopped is failed and its cost UNKNOWN (the provider may have charged):
-- the reservation stays until the owner resolves it.
CREATE OR REPLACE FUNCTION mx_claim(p_kind text, p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE out jsonb := '[]'::jsonb; j record;
BEGIN
  FOR j IN SELECT job_id, kind, request FROM fleet_media_jobs WHERE status = 'queued' AND kind = p_kind ORDER BY created_at
            LIMIT LEAST(GREATEST(COALESCE(p_limit, 4), 1), 20) FOR UPDATE SKIP LOCKED LOOP
    UPDATE fleet_media_jobs SET status = 'running', started_at = now(), provider = (SELECT provider FROM fleet_media_providers WHERE kind = j.kind) WHERE job_id = j.job_id;
    out := out || jsonb_build_object('jobId', j.job_id, 'kind', j.kind, 'request', j.request);
  END LOOP;
  UPDATE fleet_media_jobs SET status = 'failed', finished_at = now(), error = 'the provider gateway stopped while running it (cost unknown until resolved)',
         cost_state = CASE WHEN cost_state = 'reserved' THEN 'unknown' ELSE cost_state END
   WHERE status = 'running' AND kind = p_kind AND started_at < now() - interval '5 minutes';
  RETURN out;
END $$;

DROP FUNCTION mx_result(uuid, boolean, jsonb, integer, text);
CREATE FUNCTION mx_result(p_job uuid, p_ok boolean, p_result jsonb, p_cost integer, p_error text, p_basis text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE s jsonb;
BEGIN
  IF p_basis IS NOT NULL AND p_basis NOT IN ('usage','flat','estimate') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  UPDATE fleet_media_jobs SET status = CASE WHEN p_ok THEN 'done' ELSE 'failed' END, finished_at = now(),
    result = CASE WHEN p_ok THEN p_result END, error = CASE WHEN p_ok THEN NULL ELSE left(COALESCE(p_error, 'provider error'), 300) END
   WHERE job_id = p_job AND status = 'running';
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false); END IF;
  -- A provider that did not charge (an error before generation) is 0: the reservation comes back.
  s := fleet_media_settle(p_job, GREATEST(COALESCE(p_cost, 0), 0), COALESCE(p_basis, 'estimate'), 'media-gateway');
  RETURN jsonb_build_object('ok', true, 'settlement', s);
END $$;

-- The owner resolves a job whose cost is unknown, from the provider's own usage page: its cost, or nothing (released).
CREATE FUNCTION fleet_admin_media_job_resolve(p_job uuid, p_cost_usd_cents integer, p_note text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_media_jobs; s jsonb;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_treasury');
  SELECT * INTO j FROM fleet_media_jobs WHERE job_id = p_job FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF j.cost_state <> 'unknown' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE', 'costState', j.cost_state); END IF;
  IF p_cost_usd_cents IS NOT NULL AND p_cost_usd_cents < 0 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  IF length(btrim(COALESCE(p_note, ''))) < 5 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'say where the cost comes from (the provider''s usage page)'); END IF;
  s := fleet_media_settle(p_job, COALESCE(p_cost_usd_cents, 0), 'owner', p_actor);
  UPDATE fleet_media_jobs SET resolved_note = left(p_note, 300) WHERE job_id = p_job;
  RETURN jsonb_build_object('ok', true, 'settlement', s);
END $$;

-- ═══ 3. Provider statements: what the provider billed against what the Fleet recorded ═══
CREATE TABLE fleet_media_provider_statements (
  statement_id      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text        NOT NULL CHECK (provider ~ '^[a-z0-9_-]{2,40}$'),
  period_start      date        NOT NULL,
  period_end        date        NOT NULL,
  billed_usd_cents  integer     NOT NULL CHECK (billed_usd_cents >= 0),
  recorded_usd_cents integer    NOT NULL,
  difference_minor  bigint      NOT NULL,
  journal_id        uuid,
  note              text        CHECK (length(note) <= 300),
  recorded_by       text        NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  UNIQUE (provider, period_start, period_end)
);
CREATE TRIGGER fleet_media_provider_statements_no_change BEFORE UPDATE OR DELETE ON fleet_media_provider_statements FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_admin_media_statement(p_provider text, p_start date, p_end date, p_billed integer, p_note text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_rec integer; v_unknown integer; v_diff bigint; v_j uuid; v uuid;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_treasury');
  IF p_provider IS NULL OR p_start IS NULL OR p_end IS NULL OR p_end < p_start OR p_billed IS NULL OR p_billed < 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'provider, period (start ≤ end) and the billed amount in USD cents');
  END IF;
  IF EXISTS (SELECT 1 FROM fleet_media_provider_statements WHERE provider = p_provider AND daterange(period_start, period_end, '[]') && daterange(p_start, p_end, '[]')) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ALREADY_RECORDED', 'reason', 'a statement for an overlapping period is recorded');
  END IF;
  SELECT count(*) INTO v_unknown FROM fleet_media_jobs WHERE provider = p_provider AND cost_state = 'unknown' AND created_at::date BETWEEN p_start AND p_end;
  IF v_unknown > 0 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_MEDIA_COST_UNKNOWN', 'count', v_unknown, 'reason', 'resolve the jobs of unknown cost in this period first'); END IF;
  SELECT COALESCE(sum(cost_usd_cents), 0) INTO v_rec FROM fleet_media_jobs WHERE provider = p_provider AND cost_state = 'charged' AND created_at::date BETWEEN p_start AND p_end;
  v_diff := fleet_media_usd_to_minor(p_billed) - fleet_media_usd_to_minor(v_rec);
  v := gen_random_uuid();
  IF v_diff <> 0 THEN
    v_j := fleet_ledger_post('media_provider_statement', 'media-statement:' || v, p_actor, left('provider statement ' || p_provider || ' ' || p_start || '..' || p_end, 200), 'owner',
      NULL, NULL, NULL, NULL, NULL, now(), CASE WHEN v_diff > 0 THEN
        jsonb_build_array(jsonb_build_object('account', 'fleet:expense', 'side', 'D', 'amount', v_diff), jsonb_build_object('account', 'fleet:owner:payable', 'side', 'C', 'amount', v_diff))
      ELSE
        jsonb_build_array(jsonb_build_object('account', 'fleet:owner:payable', 'side', 'D', 'amount', -v_diff), jsonb_build_object('account', 'fleet:expense', 'side', 'C', 'amount', -v_diff)) END);
  END IF;
  INSERT INTO fleet_media_provider_statements (statement_id, provider, period_start, period_end, billed_usd_cents, recorded_usd_cents, difference_minor, journal_id, note, recorded_by)
    VALUES (v, p_provider, p_start, p_end, p_billed, v_rec, v_diff, v_j, left(p_note, 300), p_actor);
  IF v_diff > 0 THEN
    PERFORM fleet_notify('AMBER', 'MEDIA_PROVIDER_UNRECORDED', NULL, p_provider || ' billed more than the Fleet recorded (' || v_diff || ' minor units): booked as a Fleet expense',
      jsonb_build_object('statementId', v, 'billedUsdCents', p_billed, 'recordedUsdCents', v_rec), 'media-statement:' || v);
  END IF;
  RETURN jsonb_build_object('ok', true, 'statementId', v, 'billedUsdCents', p_billed, 'recordedUsdCents', v_rec, 'differenceMinor', v_diff, 'journalId', v_j);
END $$;

-- ═══ 4. Capability checks that name the work ═══
ALTER TABLE fleet_capability_checks ADD COLUMN target_kind text CHECK (target_kind IN ('offer','enquiry'));
ALTER TABLE fleet_capability_checks ADD COLUMN target_id uuid;
ALTER TABLE fleet_capability_checks ADD COLUMN deliverables jsonb CHECK (deliverables IS NULL OR (jsonb_typeof(deliverables) = 'array' AND jsonb_array_length(deliverables) <= 10));
ALTER TABLE fleet_capability_checks ADD COLUMN state_hash text CHECK (state_hash ~ '^[0-9a-f]{32}$');
ALTER TABLE fleet_capability_checks ADD CONSTRAINT fleet_capability_checks_target CHECK ((target_kind IS NULL) = (target_id IS NULL));
CREATE INDEX fleet_capability_checks_target ON fleet_capability_checks (agent_id, target_kind, target_id, checked_at DESC);

CREATE TABLE fleet_deliverable_formats (format text PRIMARY KEY, content_type text NOT NULL, library_area text NOT NULL);
INSERT INTO fleet_deliverable_formats VALUES ${FORMATS_SQL};
CREATE TRIGGER fleet_deliverable_formats_no_change BEFORE UPDATE OR DELETE ON fleet_deliverable_formats FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- The states a check depends on, as a fingerprint: the Fleet's (selling, money out, card, mailbox, providers, channels,
-- deliverable types) and this agent's runtime build. A change after the check makes it stale.
CREATE FUNCTION fleet_capability_state_hash(p_agent text) RETURNS text LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT md5((fleet_agent_capability_states(p_agent) - 'limits')::text || '|' ||
             COALESCE((SELECT runtime_commit FROM fleet_agents WHERE agent_id = p_agent), ''))
$$;

-- One deliverable's verdict: its format is deliverable and the runtime has its library; each thing it needs is there.
CREATE FUNCTION fleet_deliverable_verdict(d jsonb, st jsonb, rt jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE f fleet_deliverable_formats; missing jsonb := '[]'::jsonb; nd text; lib jsonb;
BEGIN
  SELECT * INTO f FROM fleet_deliverable_formats WHERE format = lower(btrim(COALESCE(d ->> 'format', '')));
  IF NOT FOUND THEN RETURN jsonb_build_object('format', d ->> 'format', 'ready', false, 'missing', jsonb_build_array('a deliverable format the Fleet knows (${Object.keys(DELIVERABLE_FORMATS).join(", ")})')); END IF;
  IF NOT (st -> 'deliverableTypes') ? f.content_type THEN missing := missing || jsonb_build_array('delivering ' || f.format || ' files'); END IF;
  IF f.library_area <> '' THEN
    lib := rt -> 'libraries' -> f.library_area;
    IF lib IS NULL OR jsonb_typeof(lib) <> 'array' OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(lib) x WHERE x !~ 'MISSING$') THEN
      missing := missing || jsonb_build_array('the ' || f.library_area || ' library in your runtime (your probe shows it missing)');
    END IF;
  END IF;
  FOR nd IN SELECT jsonb_array_elements_text(COALESCE(d -> 'needs', '[]'::jsonb)) LOOP
    IF nd NOT IN (${q(DELIVERABLE_NEEDS)}) THEN missing := missing || jsonb_build_array('unknown need "' || left(nd, 40) || '" (${DELIVERABLE_NEEDS.join(", ")})');
    ELSIF nd = 'web_search' AND st ->> 'search' <> 'connected' THEN missing := missing || '["web_search: no search provider connected"]'::jsonb;
    ELSIF nd = 'generate_image' AND st ->> 'imageGeneration' <> 'connected' THEN missing := missing || '["generate_image: no image provider connected"]'::jsonb;
    ELSIF nd = 'render' AND COALESCE(rt ->> 'renderer', '') = '' THEN missing := missing || '["render: no office renderer installed"]'::jsonb;
    ELSIF nd = 'ocr' AND COALESCE(rt ->> 'ocr', '') = '' THEN missing := missing || '["ocr: not installed"]'::jsonb;
    ELSIF nd = 'refunds' AND st ->> 'refunds' <> 'possible' THEN missing := missing || '["refunds: money out is not active"]'::jsonb;
    ELSIF nd = 'card' AND st ->> 'card' <> 'by_request' THEN missing := missing || '["card purchases: not active"]'::jsonb;
    ELSIF nd = 'mailbox' AND st ->> 'mailbox' <> 'true' THEN missing := missing || '["mailbox: you have no routing mailbox yet"]'::jsonb;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('format', f.format, 'contentType', f.content_type, 'needs', COALESCE(d -> 'needs', '[]'::jsonb), 'ready', jsonb_array_length(missing) = 0, 'missing', missing);
END $$;

CREATE OR REPLACE FUNCTION fleet_econ_capabilities_check(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st jsonb := fleet_agent_capability_states(p_agent); rt jsonb := COALESCE(a -> 'runtime', '{}'::jsonb); missing jsonb := '[]'::jsonb; v uuid;
        v_kind text; v_target uuid; dl jsonb := NULL; d jsonb; verdicts jsonb := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(rt) <> 'object' OR length(rt::text) > 8000 THEN PERFORM fleet_econ_bad('runtime is an object (your runtime''s own probe, at most 8 KB)'); END IF;
  IF a ? 'offerId' AND a ? 'enquiryId' THEN PERFORM fleet_econ_bad('name one offerId or one enquiryId'); END IF;
  IF a ? 'offerId' THEN
    v_kind := 'offer'; v_target := fleet_identity_uuid(a, 'offerId');
    IF NOT EXISTS (SELECT 1 FROM fleet_offers WHERE offer_id = v_target AND agent_id = p_agent) THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: offerId — one of your offers'; END IF;
  ELSIF a ? 'enquiryId' THEN
    v_kind := 'enquiry'; v_target := fleet_identity_uuid(a, 'enquiryId');
    IF NOT EXISTS (SELECT 1 FROM fleet_offer_enquiries WHERE enquiry_id = v_target AND agent_id = p_agent) THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: enquiryId — one of your enquiries'; END IF;
  END IF;
  IF a ? 'deliverables' THEN
    dl := a -> 'deliverables';
    IF jsonb_typeof(dl) <> 'array' OR jsonb_array_length(dl) NOT BETWEEN 1 AND 10 THEN PERFORM fleet_econ_bad('deliverables: 1..10 of {format, needs?}'); END IF;
    FOR d IN SELECT jsonb_array_elements(dl) LOOP
      IF jsonb_typeof(d) <> 'object' OR (d ? 'needs' AND jsonb_typeof(d -> 'needs') <> 'array') THEN PERFORM fleet_econ_bad('each deliverable: {format, needs?: [...]}'); END IF;
      verdicts := verdicts || jsonb_build_array(fleet_deliverable_verdict(d, st, rt));
    END LOOP;
  ELSIF v_kind IS NOT NULL THEN
    PERFORM fleet_econ_bad('deliverables: what this ' || v_kind || ' delivers — [{format (pdf, docx, xlsx, pptx, epub, png, jpg, csv, txt, zip), needs?: [web_search, generate_image, render, ocr, refunds, card, mailbox]}]');
  END IF;
  IF st ->> 'salesOpen' <> 'true' AND st ->> 'outwardActions' = 'held' THEN missing := missing || '["selling to the public: sales are closed and no release names you"]'::jsonb; END IF;
  IF st ->> 'refunds' <> 'possible' THEN missing := missing || '["refunds and paying out: money out is not active"]'::jsonb; END IF;
  IF st ->> 'card' <> 'by_request' THEN missing := missing || '["card purchases"]'::jsonb; END IF;
  IF st ->> 'mailbox' <> 'true' THEN missing := missing || '["delivery mail: you have no routing mailbox yet (identity provision_mailbox)"]'::jsonb; END IF;
  IF st ->> 'search' <> 'connected' THEN missing := missing || '["web_search: no search provider connected (use web_fetch on sites'' own search pages)"]'::jsonb; END IF;
  IF st ->> 'imageGeneration' <> 'connected' THEN missing := missing || '["generate_image: no image provider connected (draw with code: HTML/SVG, Pillow, matplotlib)"]'::jsonb; END IF;
  IF COALESCE(rt ->> 'renderer', '') = '' THEN missing := missing || '["rendering Word and PowerPoint files to images: not installed (PDF pages are rendered)"]'::jsonb; END IF;
  IF COALESCE(rt ->> 'ocr', '') = '' THEN missing := missing || '["OCR of scanned pages: not installed"]'::jsonb; END IF;
  INSERT INTO fleet_capability_checks (agent_id, for_offer, runtime, fleet, target_kind, target_id, deliverables, state_hash)
    VALUES (p_agent, left(fleet_scrub(a ->> 'forOffer'), 200), rt, st, v_kind, v_target, CASE WHEN dl IS NULL THEN NULL ELSE verdicts END, fleet_capability_state_hash(p_agent))
    RETURNING check_id INTO v;
  RETURN jsonb_build_object('ok', true, 'checkId', v, 'validDays', ${CAPABILITY_CHECK_DAYS}, 'fleet', st, 'notAvailable', missing,
    'target', CASE WHEN v_kind IS NULL THEN NULL ELSE jsonb_build_object(v_kind || 'Id', v_target) END, 'deliverables', CASE WHEN dl IS NULL THEN NULL ELSE verdicts END,
    'allReady', CASE WHEN dl IS NULL THEN NULL ELSE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(verdicts) x WHERE NOT (x ->> 'ready')::boolean) END,
    'note', 'publishing an offer or quoting an enquiry needs a check that names it, finds every deliverable ready and is still true (a provider dropping or your runtime changing makes it stale)');
END $$;

-- The gate: the latest check naming this offer / enquiry, in 7 days, all deliverables ready, covering the offer's files,
-- the Fleet's states and the runtime unchanged since.
CREATE FUNCTION fleet_capability_check_covers(p_agent text, p_op text, a jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_capability_checks; v_kind text; v_target uuid; v_offer uuid; v_files text[]; v_have text[]; v_bad jsonb;
        bad jsonb := jsonb_build_object('ok', false, 'code', 'FLEET_CAPABILITY_CHECK_REQUIRED');
BEGIN
  IF p_op = 'offer.publish' THEN v_kind := 'offer'; v_target := NULLIF(a ->> 'offerId', '')::uuid; v_offer := v_target;
  ELSE v_kind := 'enquiry'; v_target := NULLIF(a ->> 'enquiryId', '')::uuid;
       SELECT offer_id INTO v_offer FROM fleet_offer_enquiries WHERE enquiry_id = v_target AND agent_id = p_agent;
  END IF;
  SELECT * INTO c FROM fleet_capability_checks WHERE agent_id = p_agent AND target_kind = v_kind AND target_id = v_target
   ORDER BY checked_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN bad || jsonb_build_object('reason', 'check this ' || v_kind || ' first: capabilities op check {' || v_kind || 'Id, deliverables: [{format, needs}]} — a generic check is not enough');
  END IF;
  IF c.checked_at <= now() - interval '${CAPABILITY_CHECK_DAYS} days' THEN
    RETURN bad || jsonb_build_object('reason', 'your check of this ' || v_kind || ' is older than ${CAPABILITY_CHECK_DAYS} days: check it again', 'checkedAt', c.checked_at);
  END IF;
  SELECT jsonb_agg(x) INTO v_bad FROM jsonb_array_elements(c.deliverables) x WHERE NOT (x ->> 'ready')::boolean;
  IF v_bad IS NOT NULL THEN
    RETURN bad || jsonb_build_object('reason', 'your check found deliverables you cannot deliver yet: change the ' || v_kind || ' or obtain the capability (capabilities op request)', 'notReady', v_bad);
  END IF;
  IF c.state_hash IS DISTINCT FROM fleet_capability_state_hash(p_agent) THEN
    RETURN bad || jsonb_build_object('reason', 'something you depend on changed since your check (a provider, money out, the card, your mailbox, channels or your runtime): check again', 'checkedAt', c.checked_at);
  END IF;
  -- A product offer's deliverable files: every file type is one the check found ready.
  IF v_offer IS NOT NULL THEN
    SELECT array_agg(DISTINCT f.content_type) INTO v_files FROM fleet_offer_files f WHERE f.offer_id = v_offer AND f.role = 'deliverable' AND f.removed_at IS NULL;
    SELECT array_agg(DISTINCT x ->> 'contentType') INTO v_have FROM jsonb_array_elements(c.deliverables) x;
    IF v_files IS NOT NULL AND NOT (v_files <@ COALESCE(v_have, '{}')) THEN
      RETURN bad || jsonb_build_object('reason', 'the offer''s files include types your check did not cover: name every deliverable format in the check',
        'uncovered', (SELECT jsonb_agg(t) FROM unnest(v_files) t WHERE NOT (t = ANY (COALESCE(v_have, '{}')))));
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'checkId', c.check_id);
END $$;

-- The owner's view: what each agent last checked (with its target and verdicts), and paid media by agent and state.
CREATE OR REPLACE FUNCTION fleet_capabilities_json() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'requests', COALESCE((SELECT jsonb_agg(jsonb_build_object('requestId', demand_id, 'agentId', agent_id, 'capability', capability, 'kind', kind, 'reason', reason,
                  'evidence', evidence, 'blocks', blocks, 'urgency', urgency, 'attempts', attempts, 'firstAt', first_at, 'lastAt', last_at) ORDER BY last_at DESC)
                  FROM fleet_capability_demands WHERE status = 'open'), '[]'::jsonb),
    'lastChecks', COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId', c.agent_id, 'checkedAt', c.checked_at, 'forOffer', c.for_offer,
                  'target', c.target_kind, 'targetId', c.target_id, 'deliverables', c.deliverables, 'stillTrue', c.state_hash = fleet_capability_state_hash(c.agent_id),
                  'toolset', c.runtime ->> 'toolset', 'renderer', c.runtime ->> 'renderer', 'ocr', c.runtime ->> 'ocr'))
                  FROM (SELECT DISTINCT ON (agent_id) * FROM fleet_capability_checks ORDER BY agent_id, checked_at DESC) c), '[]'::jsonb),
    'mediaProviders', COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', kind, 'provider', provider, 'configured', configured, 'unitCostUsdCents', unit_cost_usd_cents,
                  'dailyLimitPerAgent', daily_limit_per_agent, 'lastSeenAt', last_seen_at, 'alive', last_seen_at > now() - interval '10 minutes')) FROM fleet_media_providers), '[]'::jsonb),
    'mediaUsage30d', COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId', agent_id, 'kind', kind, 'jobs', n, 'failed', nf, 'costUsdCents', c, 'chargedMinor', ch,
                  'reservedMinor', rs, 'unknownCost', nu))
                  FROM (SELECT agent_id, kind, count(*) AS n, count(*) FILTER (WHERE status = 'failed') AS nf, COALESCE(sum(cost_usd_cents), 0) AS c,
                               COALESCE(sum(charged_minor), 0) AS ch, COALESCE(sum(reserved_minor) FILTER (WHERE cost_state IN ('reserved','unknown')), 0) AS rs,
                               count(*) FILTER (WHERE cost_state = 'unknown') AS nu
                          FROM fleet_media_jobs WHERE created_at > now() - interval '30 days' GROUP BY agent_id, kind) u), '[]'::jsonb),
    'mediaUnknown', COALESCE((SELECT jsonb_agg(jsonb_build_object('jobId', job_id, 'agentId', agent_id, 'kind', kind, 'provider', provider, 'reservedMinor', reserved_minor,
                  'startedAt', started_at) ORDER BY started_at) FROM fleet_media_jobs WHERE cost_state = 'unknown'), '[]'::jsonb),
    'mediaStatements', COALESCE((SELECT jsonb_agg(jsonb_build_object('statementId', statement_id, 'provider', provider, 'periodStart', period_start, 'periodEnd', period_end,
                  'billedUsdCents', billed_usd_cents, 'recordedUsdCents', recorded_usd_cents, 'differenceMinor', difference_minor, 'recordedAt', recorded_at) ORDER BY period_end DESC)
                  FROM (SELECT * FROM fleet_media_provider_statements ORDER BY period_end DESC LIMIT 24) s), '[]'::jsonb))
$$;

${DISPATCH}
${DASH_CALL}
${OPS_WATCH}

-- ═══ 5. The shared library: capability status v11 ═══
SELECT fleet_admin_knowledge_library_load(${lit(JSON.stringify({ entries: KNOWLEDGE_FOUNDATION_V2.entries.filter((e) => (LIBRARY_ENTRIES_V87 as readonly string[]).includes(e.id)) }))}::jsonb, 'migration');
`;
