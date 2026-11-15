/**
 * Schema v65 — completion of the owner's 2026-10-12 decisions (one candidate with v64; docs/design/field-guide-v2-draft.md).
 *
 * 1. Contextual advertising review (no percentage gate). Advertising is recognised deterministically (a vendor of category
 *    `advertising`, or a card purchase on a known ad platform). Advertising beyond the experiment range for unproven
 *    campaigns (`ad_experiment_bp`, default 5% of available funds over 30 days — the upper end of the owner's 2.5–5%
 *    starting guidance) while the agent shows no profit yet is MATERIAL: it is reviewed, never refused by the number.
 *    The review weighs campaign evidence, aggregate commitment, profitability, downside and runway. A profitable agent's
 *    advertising is reviewed only under the general materiality signals.
 * 2. The shared-lesson review loop. Agents' knowledge proposals were never reviewed (owner-only, by CLI). Fleet Control
 *    now reviews them automatically against the promotion rule (repeated evidence, reliable sources or a clearly
 *    generalisable mechanism — never one anecdote; nothing unlawful, unsafe or secret): promoted lessons join the shared
 *    knowledge (`fleet_knowledge_entries`, promoted_by `fleet_control`), rejected ones keep a reason. Bounded like spend
 *    reviews (backoff, then visibly stalled; never decided by default). The owner's own review (CLI) still works and the
 *    owner can see every proposal (`knowledge_proposals`). Treasury-paid (`knowledge_review_charge`).
 * 3. Gumroad unlocks per agent the first time its wallet (agent_cash) reaches £500, permanently (owner decision
 *    2026-10-10). Recorded on observation (current or historical peak balance); checked before any storefront job.
 * 4. Owner-visible business project folders (`business_folders`): per agent and venture — balance and venture financials,
 *    brand, accounts (platform, handle, login email, sites, status), credentials as ids and kinds only (values only through
 *    the protected owner reveal), mail addresses, products, orders, payees, card charges, unlocks. Nothing secret is read.
 */
import { V11_SQL } from "./migrations-phase11.js";
import { V52_SQL } from "./migrations-phase52.js";
import { V64_SQL } from "./migrations-phase64.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

/** Card origins recognised as advertising platforms (a deterministic signal for the review, not a list of permitted sites). */
export const AD_PLATFORM_HOSTS = ["ads.google.com", "adwords.google.com", "business.facebook.com", "www.facebook.com", "facebook.com", "ads.tiktok.com",
  "ads.reddit.com", "ads.x.com", "ads.twitter.com", "www.linkedin.com", "ads.linkedin.com", "ads.microsoft.com", "ads.pinterest.com", "ads.snapchat.com",
  "advertising.amazon.com"] as const;
export const GUMROAD_UNLOCK_MINOR = 50_000;
export const KNOWLEDGE_DECISIONS = ["promote", "reject"] as const;
export const EVENT_ROUTES_V65 = Object.freeze({
  P1_HIGH: ["knowledge_review_stalled"],
  P3_SUMMARY: ["channel_unlocked"],
});
export const DASHBOARD_READ_OPS_V65 = ["business_folders", "knowledge_proposals"] as const;

const WORKER = `IF p_worker IS NULL OR p_worker !~ '^[a-z0-9-]{3,40}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: worker name'; END IF;`;

// ── 1. Advertising in the contextual flags ──
const ASSESS = restate(V64_SQL, "fleet_spend_review_assess", [
  [`        sig jsonb := '[]'::jsonb; v_material boolean := false; v_suspicious boolean := false;`,
   `        sig jsonb := '[]'::jsonb; v_material boolean := false; v_suspicious boolean := false;
        v_ad boolean := false; v_ad30 bigint := 0; v_profit boolean;`],
  [`    v_flagged := EXISTS (SELECT 1 FROM fleet_vendor_destinations v WHERE v.destination_id = p_payee AND v.trust = 'flagged');`,
   `    v_flagged := EXISTS (SELECT 1 FROM fleet_vendor_destinations v WHERE v.destination_id = p_payee AND v.trust = 'flagged');
    v_ad := EXISTS (SELECT 1 FROM fleet_vendor_destinations v WHERE v.destination_id = p_payee AND v.category = 'advertising');`],
  [`                      AND created_at > now() - make_interval(hours => pol.duplicate_window_h));
  END IF;`,
   `                      AND created_at > now() - make_interval(hours => pol.duplicate_window_h));
    v_ad := fleet_is_ad_origin(p_payee);
  END IF;
  -- v65: advertising over the last 30 days (orders to advertising vendors, card purchases on ad platforms).
  IF v_ad THEN
    SELECT COALESCE(sum(o.amount_cents), 0) INTO v_ad30 FROM fleet_payment_orders o JOIN fleet_vendor_destinations v ON v.destination_id = o.destination_id
     WHERE o.agent_id = p_agent AND v.category = 'advertising' AND o.status IN ('reserved','executing','settled') AND o.created_at > now() - interval '30 days'
       AND o.order_id IS DISTINCT FROM p_exclude;
    v_ad30 := v_ad30 + COALESCE((SELECT sum(amount_minor) FROM fleet_card_requests WHERE agent_id = p_agent AND status IN ('approved','pending_review','used')
                                    AND created_at > now() - interval '30 days' AND fleet_is_ad_origin(origin) AND request_id IS DISTINCT FROM p_exclude), 0);
  END IF;`],
  [`  -- Suspicious.`,
   `  -- v65: advertising beyond the experiment range for an agent without profit evidence (guidance, reviewed — never a gate).
  v_profit := COALESCE((rc ->> 'revenue60dMinor')::bigint, 0) > COALESCE((rc ->> 'expense60dMinor')::bigint, 0);
  IF v_ad AND NOT v_profit AND (p_amount + v_ad30) * 10000 / GREATEST(v_avail, 1) > pol.ad_experiment_bp THEN v_material := true;
    sig := sig || jsonb_build_object('signal', 'advertising_beyond_experiment', 'evidence', format('advertising of %s over 30 days (%s%% of available funds) before any profit',
      fleet_money_text(p_amount + v_ad30), round((p_amount + v_ad30) * 100.0 / GREATEST(v_avail, 1), 1)));
  END IF;
  -- Suspicious.`],
  [`'newPayee', v_new, 'irreversible', p_irreversible,`, `'newPayee', v_new, 'irreversible', p_irreversible, 'advertising', v_ad, 'adSpend30dMinor', CASE WHEN v_ad THEN v_ad30 + p_amount END, 'profitable60d', v_profit,`],
]);

// ── 3. Gumroad unlock before any storefront job ──
const ENQUEUE = restate(V52_SQL, "fleet_storefront_enqueue", [
  [`  IF p_agent IS NOT NULL AND (SELECT count(*) FROM fleet_provider_jobs WHERE agent_id = p_agent AND created_at > now() - interval '1 day')`,
   `  -- v65: Gumroad opens for an agent the first time its wallet reaches the unlock line, and stays open.
  IF p_agent IS NOT NULL AND NOT fleet_channel_unlocked(p_agent, 'gumroad') THEN
    RAISE EXCEPTION 'FLEET_STOREFRONT_LOCKED: Gumroad opens for you the first time your wallet reaches %; it then stays open', fleet_money_text(${GUMROAD_UNLOCK_MINOR});
  END IF;
  IF p_agent IS NOT NULL AND (SELECT count(*) FROM fleet_provider_jobs WHERE agent_id = p_agent AND created_at > now() - interval '1 day')`],
]);

// ── Owner dashboard and routing ──
const DASH_CALL = restate(V64_SQL, "dash_call", [
  [`'customer_orders','paypal_disputes','spend_reviews',`, `'customer_orders','paypal_disputes','spend_reviews',${q(DASHBOARD_READ_OPS_V65)},`],
  [`      WHEN 'spend_reviews' THEN fleet_admin_spend_reviews(a)`, `      WHEN 'spend_reviews' THEN fleet_admin_spend_reviews(a)
      -- v65: business project folders (no secret values) and the shared-lesson reviews.
      WHEN 'business_folders' THEN fleet_admin_business_folders(a ->> 'agentId')
      WHEN 'knowledge_proposals' THEN fleet_admin_knowledge_proposals(a)`],
]);
const EVENT_ROUTE = restate(V64_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V65) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);
// V11 is only referenced to keep the knowledge provenance rules in one place (the owner's review is unchanged).
void V11_SQL;

export const V65_SQL = `
-- ═══ 1. Advertising ═══
ALTER TABLE fleet_spend_review_policy ADD COLUMN ad_experiment_bp integer NOT NULL DEFAULT 500 CHECK (ad_experiment_bp BETWEEN 1 AND 10000);
COMMENT ON COLUMN fleet_spend_review_policy.ad_experiment_bp IS 'v65: advertising beyond this share of available funds over 30 days, before profit, is reviewed (guidance upper end; never a gate)';

CREATE FUNCTION fleet_is_ad_origin(p_origin text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(regexp_replace(COALESCE(p_origin, ''), '^https?://([^/:]+).*$', '\\1')) IN (${q(AD_PLATFORM_HOSTS)})
$$;

${ASSESS}

-- ═══ 2. Shared-lesson review ═══
ALTER TABLE fleet_knowledge_entries DROP CONSTRAINT fleet_knowledge_entries_promoted_by_check;
ALTER TABLE fleet_knowledge_entries ADD CONSTRAINT fleet_knowledge_entries_promoted_by_check
  CHECK (promoted_by ~ '^operator:[A-Za-z0-9._-]{1,64}$' OR promoted_by = 'fleet_control');

CREATE TABLE fleet_knowledge_review_state (
  proposal_id     uuid        PRIMARY KEY REFERENCES fleet_knowledge_proposals(proposal_id),
  attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_by      text,
  claimed_until   timestamptz,
  last_error      text        CHECK (length(last_error) <= 200),
  stalled_at      timestamptz,
  reason          text        CHECK (length(reason) <= 600),
  cost_usd_microcents bigint  NOT NULL DEFAULT 0 CHECK (cost_usd_microcents >= 0),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_knowledge_review_state_no_delete BEFORE DELETE ON fleet_knowledge_review_state FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- Fleet Control review costs other than spend reviews (per kind; GBP microcents not yet posted).
CREATE TABLE fleet_control_accrual (
  kind                text        PRIMARY KEY CHECK (kind IN ('knowledge_review_charge')),
  unposted_microcents bigint      NOT NULL DEFAULT 0 CHECK (unposted_microcents >= 0),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fleet_control_accrual (kind) VALUES ('knowledge_review_charge');
INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance) VALUES
  ('knowledge_review_charge', false, ARRAY['controller'], false, 'Fleet Control review of an agent''s proposed lesson for the shared knowledge, paid by the treasury (fleet overhead, never the agent)', 'expense');
INSERT INTO fleet_ledger_rules (kind, class, side) VALUES ('knowledge_review_charge','fleet_expense','D'), ('knowledge_review_charge','treasury_cash','C');

CREATE FUNCTION fleet_control_charge(p_kind text, p_ref text, p_calls jsonb) RETURNS bigint LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c jsonb; v_usd bigint := 0; v_rate bigint; v_micro bigint; v_unposted bigint; v_total bigint; v_charge bigint; v_avail bigint; v_unfunded bigint;
BEGIN
  FOR c IN SELECT * FROM jsonb_array_elements(COALESCE(p_calls, '[]'::jsonb)) LOOP
    IF COALESCE((c ->> 'usdMicrocents')::bigint, 0) > 0 AND (c ->> 'requestId') ~ '^[0-9a-f-]{36}$' THEN
      INSERT INTO fleet_provider_credit_events (provider, kind, usd_microcents, request_id, recorded_by)
        VALUES (c ->> 'provider', 'consumption', -(c ->> 'usdMicrocents')::bigint, (c ->> 'requestId')::uuid, 'controller:' || p_kind)
        ON CONFLICT (request_id) DO NOTHING;
      IF FOUND THEN v_usd := v_usd + (c ->> 'usdMicrocents')::bigint; END IF;
    END IF;
  END LOOP;
  IF v_usd = 0 THEN RETURN 0; END IF;
  SELECT rate_micro INTO v_rate FROM fleet_fx_rates WHERE base = 'USD' AND quote = (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1)
   ORDER BY observed_on DESC, rate_id DESC LIMIT 1;
  v_micro := CEIL(v_usd::numeric * COALESCE(v_rate, 1000000) / 1000000)::bigint;
  SELECT unposted_microcents INTO v_unposted FROM fleet_control_accrual WHERE kind = p_kind FOR UPDATE;
  v_total := v_unposted + v_micro;
  v_charge := v_total / 1000000;
  v_avail := GREATEST(fleet_ledger_balance('fleet:treasury:unallocated'), 0);
  v_unfunded := GREATEST(v_charge - v_avail, 0);
  v_charge := v_charge - v_unfunded;
  IF v_charge > 0 THEN
    PERFORM fleet_ledger_post(p_kind, p_kind || ':' || p_ref || ':' || md5(p_calls::text), 'controller', 'Fleet Control review (AI assessment)',
      'controller', NULL, NULL, NULL, NULL, NULL, now(), jsonb_build_array(
        jsonb_build_object('account', 'fleet:expense', 'side', 'D', 'amount', v_charge),
        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', v_charge)));
  END IF;
  UPDATE fleet_control_accrual SET unposted_microcents = v_total - (v_charge + v_unfunded) * 1000000, updated_at = now() WHERE kind = p_kind;
  RETURN v_usd;
END $$;

CREATE FUNCTION fleet_knowledge_review_failed_internal(p_proposal uuid, p_error text, p_was_claimed boolean) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st fleet_knowledge_review_state; pol fleet_spend_review_policy; v_attempts integer;
BEGIN
  SELECT * INTO pol FROM fleet_spend_review_policy WHERE id = 1;
  SELECT * INTO st FROM fleet_knowledge_review_state WHERE proposal_id = p_proposal FOR UPDATE;
  v_attempts := st.attempts + CASE WHEN p_was_claimed THEN 0 ELSE 1 END;
  IF v_attempts >= pol.max_attempts THEN
    UPDATE fleet_knowledge_review_state SET attempts = v_attempts, last_error = left(p_error, 200), claimed_by = NULL, claimed_until = NULL,
           stalled_at = now(), updated_at = now() WHERE proposal_id = p_proposal;
    PERFORM fleet_event('knowledge_review_stalled', (SELECT agent_id FROM fleet_knowledge_proposals WHERE proposal_id = p_proposal), 'fleet_control',
      jsonb_build_object('proposalId', p_proposal, 'attempts', v_attempts, 'error', left(p_error, 200),
        'note', 'the shared-lesson review could not run; the proposal stays pending (review it with knowledge-review, or retry later)'));
  ELSE
    UPDATE fleet_knowledge_review_state SET attempts = v_attempts, last_error = left(p_error, 200), claimed_by = NULL, claimed_until = NULL,
           next_attempt_at = now() + make_interval(secs => pol.retry_base_s * power(2, LEAST(v_attempts, 10))), updated_at = now() WHERE proposal_id = p_proposal;
  END IF;
END $$;

CREATE FUNCTION svc_knowledge_proposals_claim(p_limit integer, p_worker text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE pol fleet_spend_review_policy; st fleet_knowledge_review_state; p fleet_knowledge_proposals; jobs jsonb := '[]'::jsonb; v_rate bigint; v_est bigint;
BEGIN
  ${WORKER}
  SELECT * INTO pol FROM fleet_spend_review_policy WHERE id = 1;
  INSERT INTO fleet_knowledge_review_state (proposal_id) SELECT proposal_id FROM fleet_knowledge_proposals WHERE status = 'proposed' ON CONFLICT (proposal_id) DO NOTHING;
  SELECT rate_micro INTO v_rate FROM fleet_fx_rates WHERE base = 'USD' AND quote = (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1)
   ORDER BY observed_on DESC, rate_id DESC LIMIT 1;
  v_est := CEIL(pol.estimate_usd_microcents::numeric * COALESCE(v_rate, 1000000) / 1000000 / 1000000)::bigint;
  FOR st IN SELECT s.* FROM fleet_knowledge_review_state s JOIN fleet_knowledge_proposals kp ON kp.proposal_id = s.proposal_id
             WHERE kp.status = 'proposed' AND s.stalled_at IS NULL AND s.next_attempt_at <= now() AND (s.claimed_until IS NULL OR s.claimed_until < now())
             ORDER BY s.next_attempt_at LIMIT LEAST(GREATEST(COALESCE(p_limit, 3), 1), 10) FOR UPDATE OF s SKIP LOCKED LOOP
    IF fleet_ledger_balance('fleet:treasury:unallocated') < v_est THEN
      PERFORM fleet_knowledge_review_failed_internal(st.proposal_id, 'FLEET_TREASURY_INSUFFICIENT: the treasury cannot fund the review call', false);
      CONTINUE;
    END IF;
    UPDATE fleet_knowledge_review_state SET attempts = attempts + 1, claimed_by = p_worker, claimed_until = now() + interval '5 minutes', updated_at = now()
     WHERE proposal_id = st.proposal_id;
    SELECT * INTO p FROM fleet_knowledge_proposals WHERE proposal_id = st.proposal_id;
    jobs := jobs || jsonb_build_object('proposalId', p.proposal_id, 'category', p.category, 'title', p.title, 'content', p.content, 'agentId', p.agent_id,
      'submittedAt', p.submitted_at,
      'existing', (SELECT COALESCE(jsonb_agg(jsonb_build_object('category', e.category, 'title', e.title) ORDER BY e.seq DESC), '[]'::jsonb)
                     FROM (SELECT * FROM fleet_knowledge_entries ORDER BY seq DESC LIMIT 40) e),
      'library', (SELECT COALESCE(jsonb_agg(l.title ORDER BY l.title), '[]'::jsonb) FROM fleet_knowledge_library l WHERE l.current));
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'reviewTier', pol.review_tier, 'jobs', jobs,
    'tiers', (SELECT COALESCE(jsonb_agg(jsonb_build_object('tier', t.tier, 'provider', t.provider, 'model', t.model, 'thinking', t.thinking,
                'effort', t.effort, 'maxOutputTokens', t.max_output_tokens, 'enabled', t.enabled, 'verifiedAt', t.verified_at, 'promptCache', 'off',
                'prices', jsonb_build_object('inputMicrocentsPerToken', t.input_microcents_per_token, 'outputMicrocentsPerToken', t.output_microcents_per_token,
                  'cacheWriteMicrocentsPerToken', t.cache_write_microcents_per_token, 'cacheReadMicrocentsPerToken', t.cache_read_microcents_per_token))
                ORDER BY t.tier), '[]'::jsonb) FROM fleet_cognition_tiers t));
END $$;

CREATE FUNCTION svc_knowledge_review_failed(p_proposal uuid, p_worker text, p_error text, p_calls jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st fleet_knowledge_review_state; v_usd bigint;
BEGIN
  ${WORKER}
  SELECT * INTO st FROM fleet_knowledge_review_state WHERE proposal_id = p_proposal FOR UPDATE;
  IF NOT FOUND OR st.claimed_by IS DISTINCT FROM p_worker THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_CLAIMED'); END IF;
  v_usd := fleet_control_charge('knowledge_review_charge', p_proposal::text, p_calls);
  UPDATE fleet_knowledge_review_state SET cost_usd_microcents = cost_usd_microcents + v_usd WHERE proposal_id = p_proposal;
  PERFORM fleet_knowledge_review_failed_internal(p_proposal, COALESCE(p_error, 'reviewer error'), true);
  RETURN jsonb_build_object('ok', true);
END $$;

-- The reviewer's decision: promote (the lesson joins the shared knowledge) or reject (with its reason). A decision that is
-- neither, or a rejection without a reason, is a failed attempt (bounded retry) — never a silent outcome.
CREATE FUNCTION svc_knowledge_review_record(p_proposal uuid, p_worker text, p_result jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st fleet_knowledge_review_state; p fleet_knowledge_proposals; v_usd bigint; v_promote boolean; v_reason text := left(trim(COALESCE(p_result ->> 'reason', '')), 600);
        v_entry uuid;
BEGIN
  ${WORKER}
  SELECT * INTO st FROM fleet_knowledge_review_state WHERE proposal_id = p_proposal FOR UPDATE;
  IF NOT FOUND OR st.claimed_by IS DISTINCT FROM p_worker THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_CLAIMED'); END IF;
  v_usd := fleet_control_charge('knowledge_review_charge', p_proposal::text, p_result -> 'calls');
  UPDATE fleet_knowledge_review_state SET cost_usd_microcents = cost_usd_microcents + v_usd WHERE proposal_id = p_proposal;
  SELECT * INTO p FROM fleet_knowledge_proposals WHERE proposal_id = p_proposal FOR UPDATE;
  IF p.status <> 'proposed' THEN
    UPDATE fleet_knowledge_review_state SET claimed_by = NULL, claimed_until = NULL, updated_at = now() WHERE proposal_id = p_proposal;
    RETURN jsonb_build_object('ok', true, 'replay', true, 'status', p.status);
  END IF;
  IF COALESCE(p_result ->> 'decision', '') NOT IN (${q(KNOWLEDGE_DECISIONS)}) OR length(v_reason) < 10 THEN
    PERFORM fleet_knowledge_review_failed_internal(p_proposal, 'FLEET_REVIEW_UNUSABLE: the review gave no clear decision and reason', true);
    RETURN jsonb_build_object('ok', true, 'status', 'retry');
  END IF;
  v_promote := p_result ->> 'decision' = 'promote';
  UPDATE fleet_knowledge_proposals SET status = CASE WHEN v_promote THEN 'promoted' ELSE 'rejected' END, reviewed_by = 'fleet_control', reviewed_at = now()
   WHERE proposal_id = p_proposal;
  IF v_promote THEN
    v_entry := gen_random_uuid();
    INSERT INTO fleet_knowledge_entries (entry_id, proposal_id, origin_agent_id, origin_lineage_root, origin_genesis_id, category, title, content,
        content_sha256, promoted_by, note)
      VALUES (v_entry, p.proposal_id, p.agent_id, p.lineage_root, p.genesis_id, p.category, p.title, p.content, p.content_sha256, 'fleet_control',
              left(fleet_scrub(v_reason), 300));
  END IF;
  UPDATE fleet_knowledge_review_state SET reason = v_reason, claimed_by = NULL, claimed_until = NULL, updated_at = now() WHERE proposal_id = p_proposal;
  PERFORM fleet_event(CASE WHEN v_promote THEN 'knowledge_promoted' ELSE 'knowledge_rejected' END, p.agent_id, 'fleet_control',
    jsonb_build_object('proposalId', p_proposal, 'entryId', v_entry, 'reason', v_reason));
  RETURN jsonb_build_object('ok', true, 'status', CASE WHEN v_promote THEN 'promoted' ELSE 'rejected' END, 'entryId', v_entry);
END $$;

CREATE FUNCTION fleet_admin_knowledge_proposals(a jsonb) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('proposals', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('proposalId', p.proposal_id, 'agentId', p.agent_id,
      'category', p.category, 'title', p.title, 'content', left(p.content, 4000), 'status', p.status, 'reviewedBy', p.reviewed_by, 'reviewedAt', p.reviewed_at,
      'reason', s.reason, 'attempts', s.attempts, 'stalled', s.stalled_at IS NOT NULL, 'lastError', s.last_error, 'submittedAt', p.submitted_at)) ORDER BY p.submitted_at DESC)
    FROM (SELECT * FROM fleet_knowledge_proposals WHERE (a ->> 'status' IS NULL OR status = a ->> 'status') ORDER BY submitted_at DESC
           LIMIT LEAST(GREATEST(COALESCE((a ->> 'limit')::integer, 50), 1), 200)) p
    LEFT JOIN fleet_knowledge_review_state s ON s.proposal_id = p.proposal_id), '[]'::jsonb),
    'shared', (SELECT count(*) FROM fleet_knowledge_entries))
$$;

-- ═══ 3. Channel unlocks ═══
CREATE TABLE fleet_channel_unlocks (
  agent_id      text        NOT NULL REFERENCES fleet_agents(agent_id),
  channel       text        NOT NULL CHECK (channel IN ('gumroad')),
  unlocked_at   timestamptz NOT NULL DEFAULT now(),
  wallet_minor  bigint      NOT NULL CHECK (wallet_minor >= 0),
  PRIMARY KEY (agent_id, channel)
);
CREATE TRIGGER fleet_channel_unlocks_no_change BEFORE UPDATE OR DELETE ON fleet_channel_unlocks FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- The agent's peak wallet (agent_cash) balance over its history: a permanent unlock follows the first time it was reached.
CREATE FUNCTION fleet_agent_peak_cash(p_agent text) RETURNS bigint LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT GREATEST(COALESCE(max(running), 0), fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_cash'))) FROM (
    SELECT sum(CASE WHEN po.side = 'D' THEN po.amount_cents ELSE -po.amount_cents END) OVER (ORDER BY j.occurred_at, j.journal_id) AS running
      FROM fleet_ledger_postings po JOIN fleet_ledger_journal j ON j.journal_id = po.journal_id
     WHERE po.account_id = fleet_ledger_account(p_agent, 'agent_cash')) x
$$;

CREATE FUNCTION fleet_channel_unlocked(p_agent text, p_channel text) RETURNS boolean LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_peak bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM fleet_channel_unlocks WHERE agent_id = p_agent AND channel = p_channel) THEN RETURN true; END IF;
  IF p_channel <> 'gumroad' THEN RETURN false; END IF;
  v_peak := fleet_agent_peak_cash(p_agent);
  IF v_peak < ${GUMROAD_UNLOCK_MINOR} THEN RETURN false; END IF;
  INSERT INTO fleet_channel_unlocks (agent_id, channel, wallet_minor) VALUES (p_agent, p_channel, v_peak) ON CONFLICT DO NOTHING;
  PERFORM fleet_event('channel_unlocked', p_agent, 'fleet_control', jsonb_build_object('channel', p_channel, 'walletMinor', v_peak,
    'note', 'unlocked permanently: the wallet reached the unlock line'));
  RETURN true;
END $$;

${ENQUEUE}

-- ═══ 4. Business project folders (owner; no secret values — credentials are ids and kinds, revealed only by the owner's
--        protected reveal flow) ═══
CREATE FUNCTION fleet_admin_business_folders(p_agent text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  WITH v AS (SELECT * FROM fleet_ventures WHERE agent_id = p_agent),
  acct AS (SELECT a.*, (SELECT COALESCE(jsonb_agg(jsonb_build_object('credentialId', c.credential_id, 'kind', c.kind, 'status', c.status) ORDER BY c.created_at), '[]'::jsonb)
                          FROM fleet_agent_account_credentials c WHERE c.account_id = a.account_id) AS creds
             FROM fleet_agent_accounts a WHERE a.agent_id = p_agent)
  SELECT jsonb_build_object('agentId', p_agent,
    'wallet', (SELECT jsonb_build_object('cashMinor', (e ->> 'cash')::bigint, 'availableMinor', GREATEST(0, LEAST((e ->> 'cash')::bigint, (e ->> 'survivalEquity')::bigint)),
                 'reservedMinor', (e ->> 'reserved')::bigint, 'peakMinor', fleet_agent_peak_cash(p_agent)) FROM (SELECT fleet_agent_economics(p_agent) e) x),
    'unlocks', (SELECT COALESCE(jsonb_agg(jsonb_build_object('channel', channel, 'unlockedAt', unlocked_at)), '[]'::jsonb) FROM fleet_channel_unlocks WHERE agent_id = p_agent),
    'folders', COALESCE((SELECT jsonb_agg(f ORDER BY f ->> 'createdAt') FROM (
      SELECT jsonb_strip_nulls(jsonb_build_object(
        'ventureId', v.venture_id, 'name', v.venture_key, 'businessModel', v.business_model, 'offer', v.offer, 'market', v.target_market, 'channels', to_jsonb(v.channels),
        'state', v.state, 'createdAt', v.created_at, 'closedAt', v.closed_at,
        'financials', fleet_venture_financials(v.venture_id, NULL),
        'accounts', (SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('accountId', a.account_id, 'platform', a.platform, 'handle', a.handle, 'kind', a.account_kind,
                       'status', a.status, 'loginEmail', a.login_email, 'sites', to_jsonb(a.origins), 'credentials', a.creds, 'createdAt', a.created_at)) ORDER BY a.created_at), '[]'::jsonb)
                       FROM acct a WHERE a.venture_id = v.venture_id),
        'mail', (SELECT COALESCE(jsonb_agg(jsonb_build_object('address', m.address, 'status', m.status) ORDER BY m.created_at), '[]'::jsonb)
                   FROM fleet_agent_mailboxes m WHERE m.agent_id = p_agent AND m.venture_id = v.venture_id),
        'products', (SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('name', pr.name, 'state', pr.state, 'priceMinor', pr.price_minor, 'currency', pr.currency,
                       'permalink', pr.permalink)) ORDER BY pr.created_at), '[]'::jsonb) FROM fleet_provider_products pr WHERE pr.venture_id = v.venture_id),
        'orders', (SELECT jsonb_build_object('count', count(*), 'paidMinor', COALESCE(sum(o.amount_minor) FILTER (WHERE o.payment_status = 'paid'), 0),
                     'refundedMinor', COALESCE(sum(o.refunded_minor), 0)) FROM fleet_customer_orders o WHERE o.venture_id = v.venture_id),
        'payees', (SELECT COALESCE(jsonb_agg(jsonb_build_object('destinationId', d.destination_id, 'name', d.vendor_name, 'category', d.category, 'website', d.website,
                     'trust', d.trust) ORDER BY d.registered_at), '[]'::jsonb) FROM fleet_vendor_destinations d WHERE d.venture_id = v.venture_id))) AS f
      FROM v) z), '[]'::jsonb),
    'general', jsonb_build_object(
      'accounts', (SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('accountId', a.account_id, 'platform', a.platform, 'handle', a.handle, 'kind', a.account_kind,
                     'status', a.status, 'loginEmail', a.login_email, 'sites', to_jsonb(a.origins), 'credentials', a.creds)) ORDER BY a.created_at), '[]'::jsonb)
                     FROM acct a WHERE a.venture_id IS NULL),
      'mail', (SELECT COALESCE(jsonb_agg(jsonb_build_object('address', m.address, 'status', m.status) ORDER BY m.created_at), '[]'::jsonb)
                 FROM fleet_agent_mailboxes m WHERE m.agent_id = p_agent AND m.venture_id IS NULL),
      'cardCharges', (SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('merchant', c.merchant, 'origin', c.origin, 'status', c.status,
                        'amountMinor', COALESCE(c.amount_minor, c.hold_max_minor), 'at', c.created_at)) ORDER BY c.created_at DESC), '[]'::jsonb)
                        FROM (SELECT * FROM fleet_card_charges WHERE agent_id = p_agent ORDER BY created_at DESC LIMIT 50) c)))
$$;

${DASH_CALL}

${EVENT_ROUTE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
