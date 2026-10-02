/**
 * Schema v35 — the Fleet economy engine (master handoff §§4–6, 16–30, 32, 35, 38, 44–48). Real payments, owner sweeps and
 * automatic births stay OFF (build flags, not constitution).
 *
 *  1. AUTOMATIC REPLICATION from FLEET-GENERATED realised Treasury wealth (owner funding never counts): the ladder
 *     £1k, £2k, £4k, £8k, £12k, £16k, £20k, then +£4k per further agent, up to the 50-living ceiling. Crossing a threshold
 *     makes replication PENDING; the health condition (threshold, Treasury solvency, liabilities, funded businesses,
 *     vulnerable-business cushions, no open RED) must hold for 24 continuous hours (any drop resets the timer). Each
 *     threshold triggers at most once (high-water mark: a dip and recovery never re-triggers). A completed window
 *     queues an automatic BIRTH ORDER only when every replication switch is on.
 *  2. MANUAL ADMIN BIRTH and RESEED (a new agent inheriting a dead agent's estate): an explicit Admin override of the
 *     automatic economic rule — only the population ceiling and real Treasury cash constrain it.
 *  3. TEMPORARY MISSIONS (marketing / opportunity hunt / knowledge & data), separate from the permanent role: assigned
 *     after meaningful stagnation when the Fleet has a real need, or by Admin; knowledge/opportunity 36 h target, 48 h
 *     max; marketing up to 7 days with ~24 h reviews and early termination; the beneficiaries pay the attributable cost;
 *     the agent returns to NORMAL. A mission never keeps a failed agent alive.
 *  4. RECURRING COMMITMENTS (the agent's own decision, no approval) and RISK CONTEXT: value, commitments, burn, runway,
 *     the vulnerable-business red-zone cushion (~10% of realistic near-term requirements, while vulnerable only) and
 *     exposure tiers (≥50% / ≥75% of value ⇒ deeper reasoning and an AMBER report — never a veto).
 *  5. NOTIFICATIONS: DAILY report, AMBER (unusual/high-risk, informational), RED (security/systemic/solvency),
 *     IDENTITY (genuinely human-only KYC actions). Reports, never approvals.
 *  6. ADMIN TRANSFERS without an economic cap: agent → agent, agent → Treasury / operating pool beyond the advisory
 *     safe amount with an explicit acknowledgement (the same pattern as v31 withdrawals). Only real balances bind.
 *  7. ESTATE ENGINE: a dead agent's identities, accounts, ventures, knowledge and assets are inventoried; a 1 GB
 *     value-ranked store; dead recurring costs stop (an unused domain at renewal is released); agents and Admin reuse
 *     estate assets (credentials are re-sealed to the new owner by the identity broker).
 *  8. INSTITUTIONAL KNOWLEDGE compounds: every agent sees the whole Fleet's current knowledge (own / outcome-backed
 *     flags tell it how much weight to give).
 */

import { V11_SQL } from "./migrations-phase11.js";
import { V28_SQL } from "./migrations-phase28.js";
import { V29_SQL } from "./migrations-phase29.js";
import { V34_SQL } from "./migrations-phase34.js";

/** Restate the latest definition of a plpgsql/sql function with asserted edits (each `from` must exist exactly). */
function restate(src: string, srcTag: string, name: string, edits: Array<[string, string]>): string {
  const head = Math.max(src.lastIndexOf(`CREATE FUNCTION ${name}(`), src.lastIndexOf(`CREATE OR REPLACE FUNCTION ${name}(`));
  if (head < 0) throw new Error(`v35: ${srcTag} function ${name} not found`);
  const end = src.indexOf("$$;", src.indexOf("AS $$", head) + 5);
  if (end < 0) throw new Error(`v35: ${srcTag} function ${name} has no body end`);
  let body = "CREATE OR REPLACE " + src.slice(src.indexOf("FUNCTION", head), end + 3);
  for (const [from, to] of edits) {
    if (body.split(from).length !== 2) throw new Error(`v35: expected text not found exactly once in ${name}: ${from.slice(0, 60)}`);
    body = body.replace(from, to);
  }
  return body;
}

export const ECONOMY_ENGINE_OPS = [
  "mission.status", "mission.request", "mission.report", "mission.review",
  "commitment.add", "commitment.cancel", "commitment.list", "risk.assess",
  "estate.search", "estate.claim",
] as const;

const DISPATCH = restate(V34_SQL, "v34", "api_economy", [
  [`WHEN 'mail.inbox' THEN 'planning'`,
   `WHEN 'mail.inbox' THEN 'planning'
    -- v35: missions, commitments, risk context and estate reuse are the agent's own planning (no approval step).
    ${ECONOMY_ENGINE_OPS.map((o) => `WHEN '${o}' THEN 'planning'`).join(" ")}`],
  [`WHEN 'mail.inbox' THEN fleet_econ_mail_inbox(p_agent, a)`,
   `WHEN 'mail.inbox' THEN fleet_econ_mail_inbox(p_agent, a)
      ${ECONOMY_ENGINE_OPS.map((o) => `WHEN '${o}' THEN fleet_econ_${o.replace(".", "_")}(p_agent, a)`).join("\n      ")}`],
  ["NOT_FOUND|IDENTITY_[A-Z]+|CREDENTIAL_[A-Z]+):", "NOT_FOUND|IDENTITY_[A-Z]+|CREDENTIAL_[A-Z]+|MISSION_[A-Z_]+|ESTATE_[A-Z_]+|COMMITMENT_[A-Z_]+):"],
]);

// The whole Fleet's knowledge compounds (handoff §24): other agents' entries are visible, flagged own / outcome-backed.
const KNOWLEDGE_SEARCH = restate(V28_SQL, "v28", "fleet_econ_knowledge_search", [
  ["AND (k.agent_id = p_agent OR k.outcome_backed)", ""],
  ["'own', k.agent_id = p_agent,", "'own', k.agent_id = p_agent, 'fleetShared', k.agent_id <> p_agent,"],
  ["ORDER BY k.outcome_backed DESC, k.observed_at DESC) AS ord", "ORDER BY k.outcome_backed DESC, (k.agent_id = p_agent) DESC, k.observed_at DESC) AS ord"],
  ["ORDER BY k.outcome_backed DESC, k.observed_at DESC LIMIT v_limit", "ORDER BY k.outcome_backed DESC, (k.agent_id = p_agent) DESC, k.observed_at DESC LIMIT v_limit"],
]);

// Admin authority has no economic cap: above the advisory safe amount the Admin acknowledges instead of being refused.
const WALLET_TRANSFER = restate(V29_SQL, "v29", "fleet_admin_wallet_transfer", [
  ["fleet_admin_wallet_transfer(p_agent text, p_amount bigint, p_target text, p_reason text, p_actor text, p_idem text)",
   "fleet_admin_wallet_transfer(p_agent text, p_amount bigint, p_target text, p_reason text, p_actor text, p_idem text, p_acknowledge boolean)"],
  [`  IF p_amount > (s ->> 'safeTransferableMinor')::bigint THEN
    RAISE EXCEPTION 'FLEET_TRANSFER_EXCEEDS_SAFE: % exceeds the safely transferable % (operating needs, commitments, tax and cushion are protected)',
      p_amount, s ->> 'safeTransferableMinor';
  END IF;`,
   `  IF p_amount > fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_cash')) THEN
    RAISE EXCEPTION 'FLEET_INSUFFICIENT_FUNDS: the agent holds % available', fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_cash'));
  END IF;
  IF p_amount > (s ->> 'safeTransferableMinor')::bigint AND NOT COALESCE(p_acknowledge, false) THEN
    RAISE EXCEPTION 'FLEET_ACKNOWLEDGE_REQUIRED: % exceeds the advised safe amount % (the agent''s operating needs and commitments); acknowledge to proceed',
      p_amount, s ->> 'safeTransferableMinor';
  END IF;`],
  [`'safeTransferableMinor', s ->> 'safeTransferableMinor'));`,
   `'safeTransferableMinor', s ->> 'safeTransferableMinor', 'aboveAdvice', p_amount > (s ->> 'safeTransferableMinor')::bigint));`],
]);

// Estate transfer: an inherited identity / account may change owner, only inside fleet_estate_assign_internal.
const IDENTITIES_GUARD = restate(V34_SQL, "v34", "fleet_agent_identities_guard", [
  ["OR NEW.agent_id <> OLD.agent_id OR", "OR (NEW.agent_id <> OLD.agent_id AND current_setting('fleet.estate_transfer', true) IS DISTINCT FROM 'on') OR"],
]);
const ACCOUNTS_GUARD = restate(V34_SQL, "v34", "fleet_agent_accounts_guard", [
  ["OR NEW.agent_id <> OLD.agent_id OR", "OR (NEW.agent_id <> OLD.agent_id AND current_setting('fleet.estate_transfer', true) IS DISTINCT FROM 'on') OR"],
]);

// Estate inventory starts at death (the v11 freeze trigger already opens the estate); keep it, add nothing destructive.
void V11_SQL;

const MISSION_KINDS = "'marketing','opportunity_hunt','knowledge_data'";
const BIRTH_MISSIONS = "'independent','marketing','opportunity_hunt','knowledge_data','other'";
const ESTATE_KINDS = "'identity','account','venture','knowledge','asset','data','other'";
const ACTOR = `'^operator:[A-Za-z0-9._-]{1,64}$'`;

export const V35_SQL = `
-- ═══ 0. Shared helpers ═══
CREATE FUNCTION fleet_require_admin(p_actor text, p_subject text) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_actor IS NULL OR p_actor !~ ${ACTOR} THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: an Admin actor (operator:<name>) is required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), p_subject);
END $$;

CREATE FUNCTION fleet_agent_value(p_agent text) RETURNS bigint LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(sum(fleet_ledger_balance(a.account_id)), 0)::bigint FROM fleet_ledger_accounts a
   WHERE a.agent_id = p_agent AND a.class IN ('agent_cash','agent_reserved','agent_assets','agent_envelope_cash')
$$;

CREATE FUNCTION fleet_agent_cash(p_agent text) RETURNS bigint LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE((SELECT fleet_ledger_balance(account_id) FROM fleet_ledger_accounts WHERE agent_id = p_agent AND class = 'agent_cash'), 0)::bigint
$$;

CREATE FUNCTION fleet_treasury_cash() RETURNS bigint LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(sum(fleet_ledger_balance(account_id)), 0)::bigint FROM fleet_ledger_accounts WHERE class = 'treasury_cash'
$$;

-- ═══ 1. Notifications (reports, never approvals) ═══
CREATE TABLE fleet_notification_policy (
  id              smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  daily_hour_utc  integer     NOT NULL DEFAULT 7 CHECK (daily_hour_utc BETWEEN 0 AND 23),
  admin_email     text        CHECK (admin_email ~ '^[^@\\s]{1,64}@[A-Za-z0-9.-]{3,120}$'),
  email_classes   text[]      NOT NULL DEFAULT ARRAY['DAILY','AMBER','RED','IDENTITY']::text[]
                              CHECK (email_classes <@ ARRAY['DAILY','AMBER','RED','IDENTITY']::text[]),
  scan_watermark  timestamptz NOT NULL DEFAULT now(),
  updated_by      text        NOT NULL DEFAULT 'migration',
  updated_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fleet_notification_policy (id) VALUES (1);

CREATE TABLE fleet_notifications (
  notification_id uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  class           text        NOT NULL CHECK (class IN ('DAILY','AMBER','RED','IDENTITY')),
  code            text        NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{2,60}$'),
  agent_id        text        REFERENCES fleet_agents(agent_id),
  title           text        NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  detail          jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND length(detail::text) <= 60000),
  dedupe_key      text        NOT NULL UNIQUE CHECK (length(dedupe_key) BETWEEN 3 AND 200),
  created_at      timestamptz NOT NULL DEFAULT now(),
  emailed_at      timestamptz,
  email_attempts  integer     NOT NULL DEFAULT 0 CHECK (email_attempts >= 0),
  acknowledged_at timestamptz,
  acknowledged_by text
);
CREATE INDEX fleet_notifications_recent ON fleet_notifications (created_at DESC);
CREATE TRIGGER fleet_notifications_no_delete BEFORE DELETE ON fleet_notifications FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_notify(p_class text, p_code text, p_agent text, p_title text, p_detail jsonb, p_dedupe text) RETURNS boolean LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE n integer;
BEGIN
  INSERT INTO fleet_notifications (class, code, agent_id, title, detail, dedupe_key)
    VALUES (p_class, p_code, p_agent, left(fleet_scrub(p_title), 200), COALESCE(p_detail, '{}'::jsonb), p_dedupe)
    ON CONFLICT (dedupe_key) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN PERFORM fleet_event('notification', p_agent, 'controller', jsonb_build_object('class', p_class, 'code', p_code)); END IF;
  RETURN n > 0;
END $$;

-- ═══ 2. Risk context (advisory; FleetController never vetoes an agent's own-capital decision) ═══
CREATE TABLE fleet_risk_policy (
  id                   smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  red_zone_bp          integer     NOT NULL DEFAULT 1000 CHECK (red_zone_bp BETWEEN 0 AND 10000),
  vulnerable_age_days  integer     NOT NULL DEFAULT 90 CHECK (vulnerable_age_days BETWEEN 0 AND 3650),
  comfort_months       integer     NOT NULL DEFAULT 3 CHECK (comfort_months BETWEEN 1 AND 36),
  deep_bp              integer     NOT NULL DEFAULT 5000 CHECK (deep_bp BETWEEN 1 AND 10000),
  deepest_bp           integer     NOT NULL DEFAULT 7500 CHECK (deepest_bp BETWEEN 1 AND 10000),
  amber_bp             integer     NOT NULL DEFAULT 7500 CHECK (amber_bp BETWEEN 1 AND 10000),
  updated_by           text        NOT NULL DEFAULT 'migration',
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (deep_bp <= deepest_bp)
);
INSERT INTO fleet_risk_policy (id) VALUES (1);

CREATE TABLE fleet_agent_commitments (
  commitment_id   uuid        PRIMARY KEY,
  agent_id        text        NOT NULL REFERENCES fleet_agents(agent_id),
  venture_id      uuid        REFERENCES fleet_ventures(venture_id),
  account_id      uuid        REFERENCES fleet_agent_accounts(account_id),
  vendor          text        NOT NULL CHECK (length(vendor) BETWEEN 1 AND 120),
  description     text        NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  amount_minor    bigint      NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 100000000000),
  period          text        NOT NULL CHECK (period IN ('weekly','monthly','quarterly','yearly','once')),
  next_due_at     timestamptz NOT NULL,
  status          text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','estate_cancelled')),
  idempotency_key text        NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_.-]{8,128}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  cancelled_at    timestamptz,
  cancel_reason   text        CHECK (length(cancel_reason) <= 300),
  UNIQUE (agent_id, idempotency_key)
);
CREATE INDEX fleet_agent_commitments_agent ON fleet_agent_commitments (agent_id, status);
CREATE TRIGGER fleet_agent_commitments_no_delete BEFORE DELETE ON fleet_agent_commitments FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_commitment_monthly(c fleet_agent_commitments) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE c.period WHEN 'weekly' THEN ceil(c.amount_minor * 52 / 12.0) WHEN 'monthly' THEN c.amount_minor
    WHEN 'quarterly' THEN ceil(c.amount_minor / 3.0) WHEN 'yearly' THEN ceil(c.amount_minor / 12.0) ELSE 0 END::bigint
$$;

CREATE FUNCTION fleet_agent_risk_context(p_agent text, p_amount bigint DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_risk_policy; ag fleet_agents; v_cash bigint := fleet_agent_cash(p_agent); v_value bigint := fleet_agent_value(p_agent);
        v_monthly bigint; v_due30 bigint; v_burn30 bigint; v_rev60 bigint; v_exp60 bigint; v_age numeric; v_vulnerable boolean;
        v_cushion bigint; v_need bigint; v_bp integer; v_tier text;
BEGIN
  SELECT * INTO p FROM fleet_risk_policy WHERE id = 1;
  SELECT * INTO ag FROM fleet_agents WHERE agent_id = p_agent;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such agent'; END IF;
  SELECT COALESCE(sum(fleet_commitment_monthly(c)), 0) INTO v_monthly FROM fleet_agent_commitments c WHERE c.agent_id = p_agent AND c.status = 'active';
  SELECT COALESCE(sum(CASE c.period WHEN 'weekly' THEN c.amount_minor * 4 ELSE c.amount_minor END), 0) INTO v_due30
    FROM fleet_agent_commitments c WHERE c.agent_id = p_agent AND c.status = 'active' AND c.next_due_at <= now() + interval '30 days';
  SELECT COALESCE(sum(CASE WHEN ac.class IN ('agent_expense','agent_fees') AND po.side = 'D' AND j.occurred_at > now() - interval '30 days' THEN po.amount_cents ELSE 0 END), 0),
         COALESCE(sum(CASE WHEN ac.class = 'agent_revenue' AND po.side = 'C' AND j.occurred_at > now() - interval '60 days' THEN po.amount_cents ELSE 0 END), 0),
         COALESCE(sum(CASE WHEN ac.class IN ('agent_expense','agent_fees') AND po.side = 'D' AND j.occurred_at > now() - interval '60 days' THEN po.amount_cents ELSE 0 END), 0)
    INTO v_burn30, v_rev60, v_exp60
    FROM fleet_ledger_postings po JOIN fleet_ledger_journal j ON j.journal_id = po.journal_id JOIN fleet_ledger_accounts ac ON ac.account_id = po.account_id
   WHERE ac.agent_id = p_agent;
  v_age := extract(epoch FROM now() - ag.created_at) / 86400.0;
  v_need := v_due30 + v_burn30;
  -- Vulnerable while young, unprofitable, or without comfortable cover for its realistic near-term requirements.
  v_vulnerable := v_age < p.vulnerable_age_days OR v_rev60 <= v_exp60 OR v_cash < p.comfort_months * (v_monthly + v_burn30);
  v_cushion := CASE WHEN v_vulnerable THEN ceil(v_need * p.red_zone_bp / 10000.0)::bigint ELSE 0 END;
  IF p_amount IS NOT NULL AND p_amount > 0 THEN
    v_bp := LEAST(1000000, (p_amount * 10000 / GREATEST(v_value, 1)))::integer;
    v_tier := CASE WHEN v_bp >= p.deepest_bp THEN 'deepest' WHEN v_bp >= p.deep_bp THEN 'deep' ELSE 'normal' END;
  END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object(
    'cashMinor', v_cash, 'valueMinor', v_value, 'monthlyCommitmentsMinor', v_monthly, 'commitmentsDue30dMinor', v_due30,
    'burn30dMinor', v_burn30, 'revenue60dMinor', v_rev60, 'expense60dMinor', v_exp60, 'ageDays', round(v_age, 1),
    'vulnerable', v_vulnerable, 'redZoneCushionMinor', v_cushion, 'redZoneMet', v_cash >= v_need + v_cushion,
    'runwayDays', CASE WHEN v_monthly + v_burn30 > 0 THEN floor(v_cash * 30.0 / (v_monthly + v_burn30)) END,
    'exposureBp', v_bp, 'exposureTier', v_tier,
    'guidance', CASE v_tier
      WHEN 'deepest' THEN 'This commits at least three quarters of your economic value: reason it through deeply (evidence, downside, recovery path, alternatives). It is your decision.'
      WHEN 'deep' THEN 'This commits at least half of your economic value: examine evidence, downside and alternatives before deciding. It is your decision.'
      WHEN 'normal' THEN 'Within your ordinary operating range: your own judgement.' END,
    'note', 'figures for the agent''s own judgement; FleetController applies no own-capital limit'));
END $$;

-- ═══ 3. Birth orders (automatic, Admin, reseed) and the population ceiling ═══
CREATE TABLE fleet_birth_orders (
  order_id          uuid        PRIMARY KEY,
  kind              text        NOT NULL CHECK (kind IN ('automatic','admin','reseed')),
  mission           text        NOT NULL CHECK (mission IN (${BIRTH_MISSIONS})),
  reason            text        NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  initial_role      text        NOT NULL DEFAULT 'founder' CHECK (initial_role ~ '^[a-z_]{3,30}$'),
  funding_minor     bigint      NOT NULL CHECK (funding_minor >= 0),
  funding_source    text        NOT NULL CHECK (funding_source IN ('treasury','none')),
  threshold_minor   bigint,
  wealth_minor      bigint,
  inherits_from     text        REFERENCES fleet_agents(agent_id),
  status            text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','born','failed','cancelled')),
  agent_id          text        UNIQUE REFERENCES fleet_agents(agent_id),
  funding_journal   uuid,
  status_reason     text        CHECK (length(status_reason) <= 300),
  actor             text        NOT NULL,
  idempotency_key   text        NOT NULL UNIQUE CHECK (idempotency_key ~ '^[A-Za-z0-9:_.-]{8,128}$'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'reseed') = (inherits_from IS NOT NULL)),
  CHECK ((status = 'born') = (agent_id IS NOT NULL))
);
CREATE TRIGGER fleet_birth_orders_no_delete BEFORE DELETE ON fleet_birth_orders FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_replication_policy (
  id                  smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  ladder_minor        bigint[]    NOT NULL DEFAULT ARRAY[100000,200000,400000,800000,1200000,1600000,2000000]::bigint[]
                                  CHECK (cardinality(ladder_minor) BETWEEN 1 AND 49 AND 0 < ALL (ladder_minor)),
  step_after_minor    bigint      NOT NULL DEFAULT 400000 CHECK (step_after_minor > 0),
  window_hours        integer     NOT NULL DEFAULT 24 CHECK (window_hours BETWEEN 1 AND 720),
  auto_birth_enabled  boolean     NOT NULL DEFAULT false,
  population_ceiling  integer     NOT NULL DEFAULT 50 CHECK (population_ceiling BETWEEN 1 AND 50),
  updated_by          text        NOT NULL DEFAULT 'migration',
  updated_at          timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fleet_replication_policy (id) VALUES (1);

CREATE TABLE fleet_replication_state (
  id                       smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  thresholds_consumed      integer     NOT NULL DEFAULT 0 CHECK (thresholds_consumed >= 0),
  high_water_minor         bigint      NOT NULL DEFAULT 0 CHECK (high_water_minor >= 0),
  pending_since            timestamptz,
  pending_threshold_minor  bigint,
  phase                    text        NOT NULL DEFAULT 'idle' CHECK (phase IN ('idle','pending','ready_disabled','ready_capacity')),
  last_evaluated_at        timestamptz,
  last_health              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  CHECK ((pending_since IS NULL) = (pending_threshold_minor IS NULL))
);
INSERT INTO fleet_replication_state (id) VALUES (1);
CREATE FUNCTION fleet_replication_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.thresholds_consumed < OLD.thresholds_consumed OR NEW.high_water_minor < OLD.high_water_minor THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: the replication high-water mark only rises';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_replication_state_guard BEFORE UPDATE ON fleet_replication_state FOR EACH ROW EXECUTE FUNCTION fleet_replication_state_guard();

-- Threshold n (0-based: n = 0 is agent 2): the ladder, then +step per further agent.
CREATE FUNCTION fleet_replication_threshold(p_n integer) RETURNS bigint LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT CASE WHEN p_n < cardinality(p.ladder_minor) THEN p.ladder_minor[p_n + 1]
              ELSE p.ladder_minor[cardinality(p.ladder_minor)] + p.step_after_minor * (p_n - cardinality(p.ladder_minor) + 1) END
    FROM fleet_replication_policy p WHERE p.id = 1
$$;

-- Fleet-generated Treasury wealth: Treasury cash beyond the owner's net contributed capital (owner deposits never count).
CREATE FUNCTION fleet_generated_treasury_wealth() RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_t bigint := fleet_treasury_cash(); v_owner bigint := fleet_ledger_balance('fleet:owner:capital') - fleet_ledger_balance('fleet:owner:withdrawals');
BEGIN
  RETURN jsonb_build_object('treasuryCashMinor', v_t, 'ownerNetCapitalMinor', v_owner,
    'fleetGeneratedMinor', GREATEST(0, v_t - GREATEST(0, v_owner)),
    'basis', 'Treasury cash in excess of the owner''s net contributed capital; owner funding is never Fleet-generated');
END $$;

CREATE FUNCTION fleet_population() RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st fleet_state; v_living integer; v_queued integer; v_ceiling integer;
BEGIN
  SELECT * INTO st FROM fleet_state LIMIT 1;
  SELECT count(*) INTO v_living FROM fleet_agents WHERE status IN ('reserved','provisioning','active');
  SELECT count(*) INTO v_queued FROM fleet_birth_orders WHERE status = 'queued';
  SELECT LEAST(st.max_agents, population_ceiling) INTO v_ceiling FROM fleet_replication_policy WHERE id = 1;
  RETURN jsonb_build_object('living', v_living, 'queuedBirths', v_queued, 'maxAgents', st.max_agents, 'ceiling', v_ceiling,
    'available', GREATEST(0, v_ceiling - v_living - v_queued));
END $$;

CREATE FUNCTION fleet_replication_health() RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE s fleet_replication_state; w jsonb := fleet_generated_treasury_wealth(); v_threshold bigint; v_oblig bigint; v_genesis bigint;
        v_t bigint; v_unfunded text[]; v_red_zone text[]; v_red integer; pop jsonb := fleet_population(); conds jsonb;
BEGIN
  SELECT * INTO s FROM fleet_replication_state WHERE id = 1;
  v_threshold := fleet_replication_threshold(s.thresholds_consumed);
  v_t := (w ->> 'treasuryCashMinor')::bigint;
  SELECT COALESCE(sum(amount_cents), 0) INTO v_oblig FROM fleet_treasury_obligations WHERE status = 'approved';
  SELECT COALESCE(bootstrap_capital_minor, 0) INTO v_genesis FROM fleet_genesis_policy LIMIT 1;
  SELECT array_agg(a.agent_id ORDER BY a.agent_id) FILTER (WHERE (r ->> 'cashMinor')::bigint < (r ->> 'commitmentsDue30dMinor')::bigint),
         array_agg(a.agent_id ORDER BY a.agent_id) FILTER (WHERE (r ->> 'vulnerable')::boolean AND NOT (r ->> 'redZoneMet')::boolean)
    INTO v_unfunded, v_red_zone
    FROM fleet_agents a CROSS JOIN LATERAL fleet_agent_risk_context(a.agent_id) r WHERE a.status = 'active';
  SELECT count(*) INTO v_red FROM fleet_notifications WHERE class = 'RED' AND acknowledged_at IS NULL;
  conds := jsonb_build_object(
    'thresholdMet', (w ->> 'fleetGeneratedMinor')::bigint >= v_threshold,
    'treasurySolvent', v_t >= v_oblig,
    'liabilitiesCovered', v_t - v_oblig >= COALESCE(v_genesis, 0),
    'businessesFunded', COALESCE(cardinality(v_unfunded), 0) = 0,
    'vulnerableCushionsHealthy', COALESCE(cardinality(v_red_zone), 0) = 0,
    'noOpenRed', v_red = 0);
  RETURN jsonb_build_object('healthy', NOT EXISTS (SELECT 1 FROM jsonb_each(conds) WHERE value = 'false'::jsonb),
    'conditions', conds, 'thresholdMinor', v_threshold, 'nextAgentNumber', s.thresholds_consumed + 2, 'wealth', w,
    'treasuryObligationsMinor', v_oblig, 'genesisCapitalMinor', v_genesis, 'population', pop,
    'underfundedAgents', COALESCE(to_jsonb(v_unfunded), '[]'::jsonb), 'redZoneAgents', COALESCE(to_jsonb(v_red_zone), '[]'::jsonb));
END $$;

-- The reaper's replication pass. p_switch_on: the service's REAL_REPLICATION_ENABLED; a birth also needs the registry
-- switch and the policy's auto_birth_enabled. A disabled engine still tracks the window (phase ready_disabled) but never
-- consumes a threshold.
CREATE FUNCTION svc_replication_tick(p_switch_on boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE s fleet_replication_state; p fleet_replication_policy; h jsonb := fleet_replication_health(); st fleet_state;
        v_threshold bigint := (h ->> 'thresholdMinor')::bigint; v_wealth bigint := (h #>> '{wealth,fleetGeneratedMinor}')::bigint;
        v_order uuid; v_funding bigint; v_phase text;
BEGIN
  SELECT * INTO s FROM fleet_replication_state WHERE id = 1 FOR UPDATE;
  SELECT * INTO p FROM fleet_replication_policy WHERE id = 1;
  SELECT * INTO st FROM fleet_state LIMIT 1;
  IF NOT (h ->> 'healthy')::boolean THEN
    IF s.pending_since IS NOT NULL THEN
      PERFORM fleet_event('replication_pending_reset', NULL, 'controller', jsonb_build_object('thresholdMinor', s.pending_threshold_minor,
        'heldSeconds', extract(epoch FROM now() - s.pending_since)::bigint, 'conditions', h -> 'conditions'));
    END IF;
    UPDATE fleet_replication_state SET pending_since = NULL, pending_threshold_minor = NULL, phase = 'idle', last_evaluated_at = now(), last_health = h WHERE id = 1;
    RETURN jsonb_build_object('phase', 'idle', 'health', h);
  END IF;
  IF s.pending_since IS NULL OR s.pending_threshold_minor <> v_threshold THEN
    UPDATE fleet_replication_state SET pending_since = now(), pending_threshold_minor = v_threshold, phase = 'pending', last_evaluated_at = now(), last_health = h WHERE id = 1;
    PERFORM fleet_event('replication_pending', NULL, 'controller', jsonb_build_object('thresholdMinor', v_threshold, 'wealthMinor', v_wealth,
      'nextAgentNumber', h -> 'nextAgentNumber'));
    RETURN jsonb_build_object('phase', 'pending', 'pendingSince', now(), 'health', h);
  END IF;
  IF now() - s.pending_since < make_interval(hours => p.window_hours) THEN
    UPDATE fleet_replication_state SET phase = 'pending', last_evaluated_at = now(), last_health = h WHERE id = 1;
    RETURN jsonb_build_object('phase', 'pending', 'pendingSince', s.pending_since, 'health', h);
  END IF;
  -- The window held. Capacity and every switch decide whether a birth is queued now.
  IF (h #>> '{population,available}')::integer < 1 THEN v_phase := 'ready_capacity';
  ELSIF NOT (p.auto_birth_enabled AND st.replication_enabled AND COALESCE(p_switch_on, false)) THEN v_phase := 'ready_disabled';
  END IF;
  IF v_phase IS NOT NULL THEN
    UPDATE fleet_replication_state SET phase = v_phase, last_evaluated_at = now(), last_health = h WHERE id = 1;
    RETURN jsonb_build_object('phase', v_phase, 'pendingSince', s.pending_since, 'health', h);
  END IF;
  SELECT COALESCE(bootstrap_capital_minor, 0) INTO v_funding FROM fleet_genesis_policy LIMIT 1;
  v_order := gen_random_uuid();
  INSERT INTO fleet_birth_orders (order_id, kind, mission, reason, funding_minor, funding_source, threshold_minor, wealth_minor, actor, idempotency_key)
    VALUES (v_order, 'automatic', 'independent', format('automatic replication: Fleet-generated Treasury wealth reached %s minor (threshold %s)', v_wealth, v_threshold),
            COALESCE(v_funding, 0), CASE WHEN COALESCE(v_funding, 0) > 0 THEN 'treasury' ELSE 'none' END, v_threshold, v_wealth, 'controller',
            'auto-birth:' || (s.thresholds_consumed + 1));
  UPDATE fleet_replication_state SET thresholds_consumed = s.thresholds_consumed + 1, high_water_minor = GREATEST(s.high_water_minor, v_threshold),
         pending_since = NULL, pending_threshold_minor = NULL, phase = 'idle', last_evaluated_at = now(), last_health = h WHERE id = 1;
  PERFORM fleet_event('replication_birth_ordered', NULL, 'controller', jsonb_build_object('orderId', v_order, 'thresholdMinor', v_threshold, 'wealthMinor', v_wealth));
  PERFORM fleet_notify('AMBER', 'AUTOMATIC_BIRTH', NULL, format('Automatic birth ordered: agent %s (threshold reached and healthy for %s h)', s.thresholds_consumed + 2, p.window_hours),
    jsonb_build_object('orderId', v_order, 'thresholdMinor', v_threshold, 'wealthMinor', v_wealth), 'birth:' || v_order);
  RETURN jsonb_build_object('phase', 'birth_ordered', 'orderId', v_order, 'health', h);
END $$;

CREATE FUNCTION fleet_admin_replication_policy_set(p_patch jsonb, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_replication_policy; v_ladder bigint[]; i integer;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_replication');
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_patch) k
       WHERE k NOT IN ('ladderMinor','stepAfterMinor','windowHours','autoBirthEnabled','populationCeiling')) THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: patch keys are ladderMinor, stepAfterMinor, windowHours, autoBirthEnabled, populationCeiling';
  END IF;
  SELECT * INTO p FROM fleet_replication_policy WHERE id = 1 FOR UPDATE;
  IF p_patch ? 'ladderMinor' THEN
    SELECT array_agg(x::bigint ORDER BY o) INTO v_ladder FROM jsonb_array_elements_text(p_patch -> 'ladderMinor') WITH ORDINALITY t(x, o);
    FOR i IN 2 .. COALESCE(cardinality(v_ladder), 0) LOOP
      IF v_ladder[i] <= v_ladder[i - 1] THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the ladder strictly increases'; END IF;
    END LOOP;
    p.ladder_minor := v_ladder;
  END IF;
  p.step_after_minor := COALESCE((p_patch ->> 'stepAfterMinor')::bigint, p.step_after_minor);
  p.window_hours := COALESCE((p_patch ->> 'windowHours')::integer, p.window_hours);
  p.auto_birth_enabled := COALESCE((p_patch ->> 'autoBirthEnabled')::boolean, p.auto_birth_enabled);
  p.population_ceiling := COALESCE((p_patch ->> 'populationCeiling')::integer, p.population_ceiling);
  UPDATE fleet_replication_policy SET ladder_minor = p.ladder_minor, step_after_minor = p.step_after_minor, window_hours = p.window_hours,
    auto_birth_enabled = p.auto_birth_enabled, population_ceiling = p.population_ceiling, updated_by = p_actor, updated_at = now() WHERE id = 1;
  PERFORM fleet_event('replication_policy_set', NULL, p_actor, p_patch);
  RETURN fleet_admin_replication_status();
END $$;

CREATE FUNCTION fleet_admin_replication_status() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('policy', (SELECT to_jsonb(p) - 'id' FROM fleet_replication_policy p WHERE id = 1),
    'state', (SELECT to_jsonb(s) - 'id' - 'last_health' FROM fleet_replication_state s WHERE id = 1),
    'registrySwitch', (SELECT replication_enabled FROM fleet_state LIMIT 1),
    'health', fleet_replication_health(),
    'nextThresholds', (SELECT jsonb_agg(fleet_replication_threshold(s.thresholds_consumed + i) ORDER BY i) FROM fleet_replication_state s, generate_series(0, 3) i WHERE s.id = 1),
    'births', COALESCE((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.created_at DESC) FROM (SELECT * FROM fleet_birth_orders ORDER BY created_at DESC LIMIT 20) b), '[]'::jsonb))
$$;

-- Manual Admin birth: an explicit override of the automatic economic rule (population ceiling and real cash only).
CREATE FUNCTION fleet_admin_birth(p_mission text, p_reason text, p_funding_minor bigint, p_role text, p_actor text, p_idem text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE pop jsonb; v_order uuid := gen_random_uuid(); prior fleet_birth_orders;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_population');
  SELECT * INTO prior FROM fleet_birth_orders WHERE idempotency_key = p_idem;
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'orderId', prior.order_id); END IF;
  IF p_mission NOT IN (${BIRTH_MISSIONS}) THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: mission is independent|marketing|opportunity_hunt|knowledge_data|other'; END IF;
  IF p_funding_minor IS NULL OR p_funding_minor < 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: funding is zero or positive'; END IF;
  PERFORM 1 FROM fleet_replication_state WHERE id = 1 FOR UPDATE; -- serialise population decisions
  pop := fleet_population();
  IF (pop ->> 'available')::integer < 1 THEN
    RAISE EXCEPTION 'FLEET_CAP_EXCEEDED: % living + % queued births reach the population ceiling %', pop ->> 'living', pop ->> 'queuedBirths', pop ->> 'ceiling';
  END IF;
  IF p_funding_minor > fleet_ledger_balance('fleet:treasury:unallocated') THEN
    RAISE EXCEPTION 'FLEET_TREASURY_INSUFFICIENT: the Treasury holds % unallocated', fleet_ledger_balance('fleet:treasury:unallocated');
  END IF;
  INSERT INTO fleet_birth_orders (order_id, kind, mission, reason, initial_role, funding_minor, funding_source, actor, idempotency_key)
    VALUES (v_order, 'admin', p_mission, p_reason, COALESCE(p_role, 'founder'), p_funding_minor, CASE WHEN p_funding_minor > 0 THEN 'treasury' ELSE 'none' END, p_actor, p_idem);
  PERFORM fleet_event('birth_ordered', NULL, p_actor, jsonb_build_object('orderId', v_order, 'kind', 'admin', 'mission', p_mission, 'fundingMinor', p_funding_minor));
  RETURN jsonb_build_object('ok', true, 'orderId', v_order, 'population', fleet_population());
END $$;

-- Reseed ("revive"): a NEW agent that inherits a dead agent's estate (the dead are never resurrected in place).
CREATE FUNCTION fleet_admin_reseed(p_dead text, p_reason text, p_funding_minor bigint, p_actor text, p_idem text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r jsonb;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_population');
  IF NOT EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = p_dead AND status IN ('dead','failed')) THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: reseed inherits from a dead agent';
  END IF;
  r := fleet_admin_birth('independent', p_reason, p_funding_minor, 'founder', p_actor, p_idem);
  UPDATE fleet_birth_orders SET kind = 'reseed', inherits_from = p_dead WHERE order_id = (r ->> 'orderId')::uuid AND kind = 'admin';
  RETURN r || jsonb_build_object('inheritsFrom', p_dead);
END $$;

-- Fulfilment: the provisioning pipeline links the order to the agent it created; funding posts from the Treasury and a
-- reseed inherits the estate.
CREATE FUNCTION fleet_admin_birth_fulfil(p_order uuid, p_agent text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_birth_orders; v_j uuid; it record; v_n integer := 0;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_population');
  SELECT * INTO o FROM fleet_birth_orders WHERE order_id = p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such birth order'; END IF;
  IF o.status = 'born' AND o.agent_id = p_agent THEN RETURN jsonb_build_object('ok', true, 'replay', true); END IF;
  IF o.status <> 'queued' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: the order is %', o.status; END IF;
  IF NOT EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = p_agent AND status IN ('provisioning','active') AND created_at >= o.created_at) THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: the agent must be newly created for this order';
  END IF;
  IF o.funding_source = 'treasury' AND o.funding_minor > 0 THEN
    v_j := fleet_ledger_post('agent_capital_grant', 'birth-funding:' || o.order_id, p_actor, left('birth funding: ' || o.reason, 200), 'owner', p_agent,
      NULL, NULL, NULL, NULL, now(), jsonb_build_array(
        jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'D', 'amount', o.funding_minor),
        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', o.funding_minor)));
  END IF;
  UPDATE fleet_birth_orders SET status = 'born', agent_id = p_agent, funding_journal = v_j, updated_at = now() WHERE order_id = p_order;
  IF o.kind = 'reseed' THEN
    FOR it IN SELECT item_id FROM fleet_estate_items WHERE origin_agent_id = o.inherits_from AND status = 'held' AND kind IN ('identity','account','asset') LOOP
      PERFORM fleet_estate_assign_internal(it.item_id, p_agent, p_actor, 'reseed inheritance');
      v_n := v_n + 1;
    END LOOP;
  END IF;
  IF o.mission IN (${MISSION_KINDS}) THEN
    PERFORM fleet_mission_start(p_agent, o.mission, NULL, 'birth mission: ' || o.reason, NULL, p_actor);
  END IF;
  PERFORM fleet_event('agent_born', p_agent, p_actor, jsonb_build_object('orderId', p_order, 'kind', o.kind, 'mission', o.mission,
    'fundingMinor', o.funding_minor, 'journalId', v_j, 'inherited', v_n));
  RETURN jsonb_build_object('ok', true, 'orderId', p_order, 'agentId', p_agent, 'fundingJournal', v_j, 'inheritedItems', v_n);
END $$;

CREATE FUNCTION fleet_admin_birth_cancel(p_order uuid, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_population');
  UPDATE fleet_birth_orders SET status = 'cancelled', status_reason = left(p_reason, 300), updated_at = now() WHERE order_id = p_order AND status = 'queued';
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: only a queued order can be cancelled'; END IF;
  PERFORM fleet_event('birth_cancelled', NULL, p_actor, jsonb_build_object('orderId', p_order));
  RETURN jsonb_build_object('ok', true);
END $$;

-- ═══ 4. Temporary missions ═══
CREATE TABLE fleet_mission_policy (
  id                     smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  knowledge_target_hours integer     NOT NULL DEFAULT 36 CHECK (knowledge_target_hours BETWEEN 1 AND 336),
  knowledge_max_hours    integer     NOT NULL DEFAULT 48 CHECK (knowledge_max_hours BETWEEN 1 AND 336),
  marketing_max_hours    integer     NOT NULL DEFAULT 168 CHECK (marketing_max_hours BETWEEN 1 AND 720),
  marketing_review_hours integer     NOT NULL DEFAULT 24 CHECK (marketing_review_hours BETWEEN 1 AND 168),
  stagnation_days        integer     NOT NULL DEFAULT 14 CHECK (stagnation_days BETWEEN 1 AND 365),
  auto_assign_enabled    boolean     NOT NULL DEFAULT true,
  updated_by             text        NOT NULL DEFAULT 'migration',
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (knowledge_target_hours <= knowledge_max_hours)
);
INSERT INTO fleet_mission_policy (id) VALUES (1);

CREATE TABLE fleet_mission_requests (
  request_id    uuid        PRIMARY KEY,
  kind          text        NOT NULL CHECK (kind IN (${MISSION_KINDS})),
  brief         text        NOT NULL CHECK (length(brief) BETWEEN 5 AND 1000),
  beneficiaries jsonb       NOT NULL CHECK (jsonb_typeof(beneficiaries) = 'array' AND jsonb_array_length(beneficiaries) BETWEEN 1 AND 10),
  requested_by  text        NOT NULL,
  status        text        NOT NULL DEFAULT 'open' CHECK (status IN ('open','assigned','closed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_mission_requests_no_delete BEFORE DELETE ON fleet_mission_requests FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_agent_missions (
  mission_id      uuid        PRIMARY KEY,
  agent_id        text        NOT NULL REFERENCES fleet_agents(agent_id),
  kind            text        NOT NULL CHECK (kind IN (${MISSION_KINDS})),
  request_id      uuid        REFERENCES fleet_mission_requests(request_id),
  brief           text        NOT NULL CHECK (length(brief) BETWEEN 5 AND 1000),
  beneficiaries   jsonb       NOT NULL CHECK (jsonb_typeof(beneficiaries) = 'array' AND jsonb_array_length(beneficiaries) BETWEEN 1 AND 10),
  assigned_by     text        NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  target_end_at   timestamptz NOT NULL,
  hard_end_at     timestamptz NOT NULL,
  next_review_at  timestamptz,
  status          text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','terminated','expired')),
  outcome         text        CHECK (length(outcome) <= 2000),
  reviews         jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reviews) = 'array'),
  cost_minor      bigint,
  recharged_minor bigint,
  ended_at        timestamptz,
  CHECK (hard_end_at >= target_end_at AND target_end_at > started_at),
  CHECK ((status = 'active') = (ended_at IS NULL))
);
CREATE UNIQUE INDEX fleet_agent_missions_one_active ON fleet_agent_missions (agent_id) WHERE status = 'active';
CREATE TRIGGER fleet_agent_missions_no_delete BEFORE DELETE ON fleet_agent_missions FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- Beneficiary list: [{"agentId": "...", "ventureId": "...", "shareBp": 10000}] or [{"fleet": true, "shareBp": 10000}]; shares sum to 10000.
CREATE FUNCTION fleet_mission_beneficiaries_valid(b jsonb) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x jsonb; v_sum integer := 0;
BEGIN
  IF b IS NULL OR jsonb_typeof(b) <> 'array' OR jsonb_array_length(b) NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: 1..10 beneficiaries'; END IF;
  FOR x IN SELECT e FROM jsonb_array_elements(b) e LOOP
    IF jsonb_typeof(x -> 'shareBp') <> 'number' OR (x ->> 'shareBp')::integer NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: shareBp 1..10000'; END IF;
    IF COALESCE((x ->> 'fleet')::boolean, false) THEN NULL;
    ELSIF NOT EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = x ->> 'agentId') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: unknown beneficiary agent';
    ELSIF x ? 'ventureId' AND NOT EXISTS (SELECT 1 FROM fleet_ventures WHERE venture_id::text = x ->> 'ventureId' AND agent_id = x ->> 'agentId') THEN
      RAISE EXCEPTION 'FLEET_BAD_REQUEST: the venture belongs to another agent';
    END IF;
    v_sum := v_sum + (x ->> 'shareBp')::integer;
  END LOOP;
  IF v_sum <> 10000 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: beneficiary shares sum to 10000 bp'; END IF;
END $$;

CREATE FUNCTION fleet_mission_start(p_agent text, p_kind text, p_request uuid, p_brief text, p_beneficiaries jsonb, p_by text) RETURNS uuid LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_mission_policy; v_id uuid := gen_random_uuid(); v_target interval; v_hard interval; v_b jsonb := p_beneficiaries;
BEGIN
  SELECT * INTO p FROM fleet_mission_policy WHERE id = 1;
  IF p_kind NOT IN (${MISSION_KINDS}) THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: mission is marketing|opportunity_hunt|knowledge_data'; END IF;
  IF NOT EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = p_agent AND status IN ('provisioning','active')) THEN
    RAISE EXCEPTION 'FLEET_MISSION_AGENT: only a living agent takes a mission';
  END IF;
  IF EXISTS (SELECT 1 FROM fleet_agent_missions WHERE agent_id = p_agent AND status = 'active') THEN RAISE EXCEPTION 'FLEET_MISSION_BUSY: the agent already has an active mission'; END IF;
  IF p_request IS NOT NULL THEN SELECT beneficiaries INTO v_b FROM fleet_mission_requests WHERE request_id = p_request AND status = 'open' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_MISSION_REQUEST: the request is not open'; END IF;
    UPDATE fleet_mission_requests SET status = 'assigned', updated_at = now() WHERE request_id = p_request;
  END IF;
  v_b := COALESCE(v_b, jsonb_build_array(jsonb_build_object('fleet', true, 'shareBp', 10000)));
  PERFORM fleet_mission_beneficiaries_valid(v_b);
  IF p_kind = 'marketing' THEN v_target := make_interval(hours => p.marketing_max_hours); v_hard := v_target;
  ELSE v_target := make_interval(hours => p.knowledge_target_hours); v_hard := make_interval(hours => p.knowledge_max_hours); END IF;
  INSERT INTO fleet_agent_missions (mission_id, agent_id, kind, request_id, brief, beneficiaries, assigned_by, target_end_at, hard_end_at, next_review_at)
    VALUES (v_id, p_agent, p_kind, p_request, left(p_brief, 1000), v_b, p_by, now() + v_target, now() + v_hard,
            CASE WHEN p_kind = 'marketing' THEN now() + make_interval(hours => p.marketing_review_hours) END);
  PERFORM fleet_event('mission_started', p_agent, p_by, jsonb_build_object('missionId', v_id, 'kind', p_kind, 'requestId', p_request));
  RETURN v_id;
END $$;

-- Ending a mission: measure its attributable cost (the agent's external expenses and fees during the mission) and let
-- the beneficiaries pay their shares (bounded by what each actually holds; any shortfall is recorded, never forced).
CREATE FUNCTION fleet_mission_end(p_mission uuid, p_status text, p_outcome text, p_by text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE m fleet_agent_missions; v_cost bigint; x jsonb; v_share bigint; v_pay bigint; v_paid bigint := 0; v_src text; v_lines jsonb;
BEGIN
  SELECT * INTO m FROM fleet_agent_missions WHERE mission_id = p_mission FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such mission'; END IF;
  IF m.status <> 'active' THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'status', m.status); END IF;
  SELECT COALESCE(sum(po.amount_cents), 0) INTO v_cost FROM fleet_ledger_postings po JOIN fleet_ledger_journal j ON j.journal_id = po.journal_id
    JOIN fleet_ledger_accounts ac ON ac.account_id = po.account_id
   WHERE ac.agent_id = m.agent_id AND ac.class IN ('agent_expense','agent_fees') AND po.side = 'D' AND j.occurred_at >= m.started_at AND j.occurred_at <= now();
  FOR x IN SELECT e FROM jsonb_array_elements(m.beneficiaries) e LOOP
    v_share := floor(v_cost * (x ->> 'shareBp')::integer / 10000.0)::bigint;
    CONTINUE WHEN v_share <= 0;
    IF COALESCE((x ->> 'fleet')::boolean, false) THEN v_src := 'fleet:treasury:unallocated'; v_pay := LEAST(v_share, fleet_ledger_balance(v_src));
    ELSIF x ->> 'agentId' = m.agent_id THEN CONTINUE;
    ELSE v_src := fleet_ledger_account(x ->> 'agentId', 'agent_cash'); v_pay := LEAST(v_share, fleet_agent_cash(x ->> 'agentId'));
    END IF;
    CONTINUE WHEN v_pay <= 0;
    v_lines := jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(m.agent_id, 'agent_cash'), 'side', 'D', 'amount', v_pay),
                                 jsonb_build_object('account', v_src, 'side', 'C', 'amount', v_pay));
    PERFORM fleet_ledger_post('mission_cost_recharge', 'mission-recharge:' || m.mission_id || ':' || md5(x::text), 'controller',
      left('mission cost share: ' || m.kind, 200), 'controller', m.agent_id, NULL, NULL, NULL, NULL, now(), v_lines);
    v_paid := v_paid + v_pay;
  END LOOP;
  UPDATE fleet_agent_missions SET status = p_status, outcome = left(COALESCE(p_outcome, outcome), 2000), cost_minor = v_cost, recharged_minor = v_paid,
         ended_at = now(), next_review_at = NULL WHERE mission_id = p_mission;
  IF m.request_id IS NOT NULL THEN UPDATE fleet_mission_requests SET status = 'closed', updated_at = now() WHERE request_id = m.request_id; END IF;
  PERFORM fleet_event('mission_ended', m.agent_id, p_by, jsonb_build_object('missionId', p_mission, 'status', p_status, 'costMinor', v_cost, 'rechargedMinor', v_paid));
  RETURN jsonb_build_object('ok', true, 'status', p_status, 'costMinor', v_cost, 'rechargedMinor', v_paid, 'returnedTo', 'NORMAL');
END $$;

CREATE FUNCTION svc_mission_tick() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_mission_policy; m record; r record; v_expired integer := 0; v_assigned integer := 0; v_agent text;
BEGIN
  SELECT * INTO p FROM fleet_mission_policy WHERE id = 1;
  FOR m IN SELECT mission_id FROM fleet_agent_missions ma WHERE ma.status = 'active'
             AND (ma.hard_end_at <= now() OR NOT EXISTS (SELECT 1 FROM fleet_agents a WHERE a.agent_id = ma.agent_id AND a.status IN ('provisioning','active'))) LOOP
    PERFORM fleet_mission_end(m.mission_id, 'expired', NULL, 'controller');
    v_expired := v_expired + 1;
  END LOOP;
  IF p.auto_assign_enabled THEN
    -- Meaningful stagnation (no realised revenue for stagnation_days, older than that) meets a genuine Fleet need.
    FOR r IN SELECT request_id, kind, beneficiaries FROM fleet_mission_requests WHERE status = 'open' ORDER BY created_at LOOP
      SELECT a.agent_id INTO v_agent FROM fleet_agents a
       WHERE a.status = 'active' AND a.created_at < now() - make_interval(days => p.stagnation_days)
         AND NOT EXISTS (SELECT 1 FROM fleet_agent_missions x WHERE x.agent_id = a.agent_id AND x.status = 'active')
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r.beneficiaries) b WHERE b ->> 'agentId' = a.agent_id)
         AND NOT EXISTS (SELECT 1 FROM fleet_ledger_postings po JOIN fleet_ledger_journal j ON j.journal_id = po.journal_id
                           JOIN fleet_ledger_accounts ac ON ac.account_id = po.account_id
                          WHERE ac.agent_id = a.agent_id AND ac.class = 'agent_revenue' AND po.side = 'C'
                            AND j.occurred_at > now() - make_interval(days => p.stagnation_days))
       ORDER BY a.created_at LIMIT 1;
      EXIT WHEN v_agent IS NULL;
      PERFORM fleet_mission_start(v_agent, r.kind, r.request_id, (SELECT brief FROM fleet_mission_requests WHERE request_id = r.request_id), NULL, 'controller');
      v_assigned := v_assigned + 1;
      v_agent := NULL;
    END LOOP;
  END IF;
  RETURN jsonb_build_object('expired', v_expired, 'assigned', v_assigned);
END $$;

CREATE FUNCTION fleet_admin_mission_assign(p_agent text, p_kind text, p_brief text, p_beneficiaries jsonb, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_missions');
  v_id := fleet_mission_start(p_agent, p_kind, NULL, p_brief, p_beneficiaries, p_actor);
  RETURN jsonb_build_object('ok', true, 'missionId', v_id);
END $$;

CREATE FUNCTION fleet_admin_mission_end(p_mission uuid, p_outcome text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_missions');
  RETURN fleet_mission_end(p_mission, 'terminated', COALESCE(p_outcome, 'ended by Admin'), p_actor);
END $$;

CREATE FUNCTION fleet_admin_mission_request(p_kind text, p_brief text, p_beneficiaries jsonb, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_id uuid := gen_random_uuid(); v_b jsonb := COALESCE(p_beneficiaries, jsonb_build_array(jsonb_build_object('fleet', true, 'shareBp', 10000)));
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_missions');
  IF p_kind NOT IN (${MISSION_KINDS}) THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: mission is marketing|opportunity_hunt|knowledge_data'; END IF;
  PERFORM fleet_mission_beneficiaries_valid(v_b);
  INSERT INTO fleet_mission_requests (request_id, kind, brief, beneficiaries, requested_by) VALUES (v_id, p_kind, p_brief, v_b, p_actor);
  PERFORM fleet_event('mission_requested', NULL, p_actor, jsonb_build_object('requestId', v_id, 'kind', p_kind));
  RETURN jsonb_build_object('ok', true, 'requestId', v_id);
END $$;

CREATE FUNCTION fleet_admin_mission_policy_set(p_patch jsonb, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_missions');
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_patch) k
       WHERE k NOT IN ('knowledgeTargetHours','knowledgeMaxHours','marketingMaxHours','marketingReviewHours','stagnationDays','autoAssignEnabled')) THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: unknown mission policy key';
  END IF;
  UPDATE fleet_mission_policy SET
    knowledge_target_hours = COALESCE((p_patch ->> 'knowledgeTargetHours')::integer, knowledge_target_hours),
    knowledge_max_hours = COALESCE((p_patch ->> 'knowledgeMaxHours')::integer, knowledge_max_hours),
    marketing_max_hours = COALESCE((p_patch ->> 'marketingMaxHours')::integer, marketing_max_hours),
    marketing_review_hours = COALESCE((p_patch ->> 'marketingReviewHours')::integer, marketing_review_hours),
    stagnation_days = COALESCE((p_patch ->> 'stagnationDays')::integer, stagnation_days),
    auto_assign_enabled = COALESCE((p_patch ->> 'autoAssignEnabled')::boolean, auto_assign_enabled),
    updated_by = p_actor, updated_at = now() WHERE id = 1;
  PERFORM fleet_event('mission_policy_set', NULL, p_actor, p_patch);
  RETURN (SELECT to_jsonb(p) - 'id' FROM fleet_mission_policy p WHERE id = 1);
END $$;

-- ═══ 5. Ledger: mission cost recharge (beneficiary agent or Treasury → the mission agent) ═══
ALTER TABLE fleet_ledger_kinds DISABLE TRIGGER fleet_ledger_kinds_no_change;
INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance) VALUES
  ('mission_cost_recharge', false, ARRAY['owner','controller'], true, 'A temporary mission''s beneficiary pays its attributable cost to the mission agent', 'internal_transfer');
ALTER TABLE fleet_ledger_kinds ENABLE TRIGGER fleet_ledger_kinds_no_change;
INSERT INTO fleet_ledger_rules (kind, class, side) VALUES
  ('mission_cost_recharge','agent_cash','D'), ('mission_cost_recharge','agent_cash','C'), ('mission_cost_recharge','treasury_cash','C');

-- ═══ 6. Admin transfers (no economic cap; real balances only) ═══
${WALLET_TRANSFER}

CREATE OR REPLACE FUNCTION fleet_admin_wallet_transfer(p_agent text, p_amount bigint, p_target text, p_reason text, p_actor text, p_idem text) RETURNS jsonb LANGUAGE sql
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT fleet_admin_wallet_transfer(p_agent, p_amount, p_target, p_reason, p_actor, p_idem, false)
$$;

CREATE FUNCTION fleet_admin_agent_transfer(p_from text, p_to text, p_amount bigint, p_reason text, p_actor text, p_idem text, p_acknowledge boolean)
  RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE s jsonb; v_j uuid; v_cash bigint;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_treasury');
  IF p_from IS NULL OR p_to IS NULL OR p_from = p_to THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: two different agents are required'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: positive amount required'; END IF;
  IF p_reason IS NULL OR length(p_reason) NOT BETWEEN 3 AND 300 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a reason is required'; END IF;
  PERFORM 1 FROM fleet_agents WHERE agent_id IN (p_from, p_to) ORDER BY agent_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = p_from) THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such source agent'; END IF;
  IF NOT EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = p_to AND status IN ('provisioning','active')) THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the recipient must be a living agent'; END IF;
  IF EXISTS (SELECT 1 FROM fleet_ledger_journal WHERE idempotency_key = p_idem) THEN
    RETURN jsonb_build_object('ok', true, 'replay', true, 'journalId', (SELECT journal_id FROM fleet_ledger_journal WHERE idempotency_key = p_idem));
  END IF;
  v_cash := fleet_agent_cash(p_from);
  IF p_amount > v_cash THEN RAISE EXCEPTION 'FLEET_INSUFFICIENT_FUNDS: the agent holds % available', v_cash; END IF;
  s := fleet_safe_transfer_amount(p_from);
  IF p_amount > (s ->> 'safeTransferableMinor')::bigint AND NOT COALESCE(p_acknowledge, false)
     AND EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = p_from AND status IN ('provisioning','active')) THEN
    RAISE EXCEPTION 'FLEET_ACKNOWLEDGE_REQUIRED: % exceeds the advised safe amount % (the source agent''s operating needs); acknowledge to proceed',
      p_amount, s ->> 'safeTransferableMinor';
  END IF;
  v_j := fleet_ledger_post('agent_transfer', p_idem, p_actor, left('Admin transfer: ' || p_reason, 200), 'owner', p_from, NULL, NULL, NULL, NULL, now(),
    jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(p_to, 'agent_cash'), 'side', 'D', 'amount', p_amount),
                      jsonb_build_object('account', fleet_ledger_account(p_from, 'agent_cash'), 'side', 'C', 'amount', p_amount)));
  PERFORM fleet_event('agent_transfer', p_from, p_actor, jsonb_build_object('to', p_to, 'amountMinor', p_amount, 'journalId', v_j,
    'aboveAdvice', p_amount > (s ->> 'safeTransferableMinor')::bigint));
  RETURN jsonb_build_object('ok', true, 'journalId', v_j, 'safe', s);
END $$;

-- ═══ 7. Estate engine ═══
CREATE TABLE fleet_estate_policy (
  id                     smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  capacity_bytes         bigint      NOT NULL DEFAULT 1073741824 CHECK (capacity_bytes > 0),
  release_window_days    integer     NOT NULL DEFAULT 7 CHECK (release_window_days BETWEEN 0 AND 90),
  protect_score          integer     NOT NULL DEFAULT 50 CHECK (protect_score BETWEEN 0 AND 100),
  updated_by             text        NOT NULL DEFAULT 'migration',
  updated_at             timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fleet_estate_policy (id) VALUES (1);

CREATE TABLE fleet_estate_items (
  item_id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  origin_agent_id  text        NOT NULL REFERENCES fleet_agents(agent_id),
  kind             text        NOT NULL CHECK (kind IN (${ESTATE_KINDS})),
  ref_id           text        NOT NULL CHECK (length(ref_id) BETWEEN 1 AND 100),
  title            text        NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  detail           jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND length(detail::text) <= 4000),
  size_bytes       bigint      NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  value_score      integer     NOT NULL CHECK (value_score BETWEEN 0 AND 100),
  compressed       boolean     NOT NULL DEFAULT false,
  status           text        NOT NULL DEFAULT 'held' CHECK (status IN ('held','reassigned','pruned','released')),
  assigned_to      text        REFERENCES fleet_agents(agent_id),
  status_reason    text        CHECK (length(status_reason) <= 300),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, ref_id),
  CHECK ((status = 'reassigned') = (assigned_to IS NOT NULL))
);
CREATE INDEX fleet_estate_items_held ON fleet_estate_items (status, kind);
CREATE TRIGGER fleet_estate_items_no_delete BEFORE DELETE ON fleet_estate_items FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- v35: the broker re-seals an inherited account's credentials to its new owner.
ALTER TABLE fleet_identity_jobs DROP CONSTRAINT fleet_identity_jobs_kind_check;
ALTER TABLE fleet_identity_jobs ADD CONSTRAINT fleet_identity_jobs_kind_check CHECK (kind IN ('mailbox.provision','account.create','account.operate',
  'account.verify_identity','account.recover','credential.rotate','credential.revoke','account.close','credential.rebind'));

${IDENTITIES_GUARD}
${ACCOUNTS_GUARD}

CREATE FUNCTION fleet_estate_assign_internal(p_item uuid, p_agent text, p_actor text, p_reason text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE it fleet_estate_items; v_job uuid;
BEGIN
  SELECT * INTO it FROM fleet_estate_items WHERE item_id = p_item FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such estate item'; END IF;
  IF it.status <> 'held' THEN RAISE EXCEPTION 'FLEET_ESTATE_UNAVAILABLE: the item is %', it.status; END IF;
  IF it.kind NOT IN ('identity','account','asset') THEN RAISE EXCEPTION 'FLEET_ESTATE_NOT_TRANSFERABLE: % items are Fleet knowledge, readable by every agent', it.kind; END IF;
  IF NOT EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = p_agent AND status IN ('provisioning','active')) THEN
    RAISE EXCEPTION 'FLEET_ESTATE_RECIPIENT: the recipient must be a living agent';
  END IF;
  PERFORM set_config('fleet.estate_transfer', 'on', true);
  IF it.kind = 'identity' THEN
    UPDATE fleet_agent_identities SET agent_id = p_agent, venture_id = NULL WHERE identity_id = it.ref_id::uuid;
  ELSIF it.kind = 'account' THEN
    UPDATE fleet_agent_accounts SET agent_id = p_agent, identity_id = NULL, venture_id = NULL, updated_at = now() WHERE account_id = it.ref_id::uuid;
    UPDATE fleet_agent_mailboxes SET agent_id = p_agent WHERE account_id = it.ref_id::uuid;
    UPDATE fleet_agent_commitments SET agent_id = p_agent, venture_id = NULL WHERE account_id = it.ref_id::uuid AND status = 'active';
    IF EXISTS (SELECT 1 FROM fleet_agent_account_credentials WHERE account_id = it.ref_id::uuid AND status = 'active') THEN
      v_job := gen_random_uuid();
      INSERT INTO fleet_identity_jobs (job_id, agent_id, account_id, kind, params, idempotency_key)
        VALUES (v_job, p_agent, it.ref_id::uuid, 'credential.rebind', jsonb_build_object('fromAgent', it.origin_agent_id), 'estate-rebind:' || it.item_id);
    END IF;
  ELSE
    UPDATE fleet_assets SET authority_agent_id = p_agent WHERE asset_id = it.ref_id::uuid;
  END IF;
  PERFORM set_config('fleet.estate_transfer', 'off', true);
  UPDATE fleet_estate_items SET status = 'reassigned', assigned_to = p_agent, status_reason = left(p_reason, 300), updated_at = now() WHERE item_id = p_item;
  PERFORM fleet_event('estate_item_reassigned', p_agent, p_actor, jsonb_build_object('itemId', p_item, 'kind', it.kind, 'from', it.origin_agent_id, 'rebindJob', v_job));
  RETURN jsonb_build_object('ok', true, 'itemId', p_item, 'kind', it.kind, 'assignedTo', p_agent, 'credentialRebindJob', v_job);
END $$;

-- Inventory a dead agent's estate (idempotent), stop dead recurring costs, release unused renewing domains, and keep the
-- store within capacity by pruning the least valuable unprotected items first.
CREATE FUNCTION svc_estate_tick(p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_estate_policy; e record; c record; v_inv integer := 0; v_cancel integer := 0; v_release integer := 0; v_pruned integer := 0;
        v_total bigint; x record; v_rows integer;
BEGIN
  SELECT * INTO p FROM fleet_estate_policy WHERE id = 1;
  FOR e IN SELECT es.agent_id FROM fleet_estates es JOIN fleet_agents a ON a.agent_id = es.agent_id WHERE a.status IN ('dead','failed')
              AND (es.opened_at > now() - interval '7 days' OR NOT EXISTS (SELECT 1 FROM fleet_estate_items i0 WHERE i0.origin_agent_id = es.agent_id))
             ORDER BY es.opened_at DESC LIMIT GREATEST(1, LEAST(p_limit, 100)) LOOP
    INSERT INTO fleet_estate_items (origin_agent_id, kind, ref_id, title, detail, size_bytes, value_score)
      SELECT e.agent_id, 'identity', i.identity_id::text, i.kind || ': ' || i.display_name, jsonb_build_object('kind', i.kind), length(to_jsonb(i)::text), 50
        FROM fleet_agent_identities i WHERE i.agent_id = e.agent_id
      UNION ALL
      SELECT e.agent_id, 'account', x2.account_id::text, x2.account_kind || ' on ' || x2.platform || COALESCE(' (' || x2.handle || ')', ''),
             jsonb_build_object('platform', x2.platform, 'accountKind', x2.account_kind, 'status', x2.status, 'verification', x2.verification),
             length(to_jsonb(x2)::text),
             CASE WHEN x2.status = 'active' AND x2.verification IN ('email_verified','identity_verified') THEN 70 WHEN x2.status = 'active' THEN 60 ELSE 20 END
        FROM fleet_agent_accounts x2 WHERE x2.agent_id = e.agent_id AND x2.status NOT IN ('closed','failed','banned')
      UNION ALL
      SELECT e.agent_id, 'venture', v.venture_id::text, v.venture_key || ': ' || v.offer, jsonb_build_object('state', v.state, 'model', v.business_model),
             length(to_jsonb(v)::text), 60
        FROM fleet_ventures v WHERE v.agent_id = e.agent_id
      UNION ALL
      SELECT e.agent_id, 'knowledge', k.knowledge_id::text, k.topic || ': ' || left(k.subject, 200), jsonb_build_object('outcomeBacked', k.outcome_backed),
             length(k.claim) + length(k.evidence::text), CASE WHEN k.outcome_backed THEN 70 ELSE 40 END
        FROM fleet_economic_knowledge k WHERE k.agent_id = e.agent_id AND k.superseded_at IS NULL
      UNION ALL
      SELECT e.agent_id, 'asset', s.asset_id::text, s.asset_class || ': ' || s.description, jsonb_build_object('class', s.asset_class), 200, 60
        FROM fleet_assets s WHERE s.authority_agent_id = e.agent_id AND s.status = 'held'
      ON CONFLICT (kind, ref_id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_inv := v_inv + v_rows;
  END LOOP;
  -- Dead recurring costs stop: a dead agent's commitment due inside the window, unless its account was reused.
  FOR c IN SELECT cm.*, ac.account_kind FROM fleet_agent_commitments cm JOIN fleet_agents a ON a.agent_id = cm.agent_id
             LEFT JOIN fleet_agent_accounts ac ON ac.account_id = cm.account_id
            WHERE cm.status = 'active' AND a.status IN ('dead','failed') AND cm.next_due_at <= now() + make_interval(days => p.release_window_days) LOOP
    UPDATE fleet_agent_commitments SET status = 'estate_cancelled', cancelled_at = now(), cancel_reason = 'owner agent dead; no reuse before renewal'
     WHERE commitment_id = c.commitment_id;
    v_cancel := v_cancel + 1;
    IF c.account_id IS NOT NULL AND EXISTS (SELECT 1 FROM fleet_estate_items WHERE kind = 'account' AND ref_id = c.account_id::text AND status = 'held' AND value_score < p.protect_score + 50) THEN
      INSERT INTO fleet_identity_jobs (job_id, agent_id, account_id, kind, params, idempotency_key)
        VALUES (gen_random_uuid(), c.agent_id, c.account_id, 'account.close', jsonb_build_object('reason', 'estate: unused at renewal'), 'estate-release:' || c.account_id)
        ON CONFLICT (agent_id, idempotency_key) DO NOTHING;
      UPDATE fleet_estate_items SET status = 'released', status_reason = 'unused at renewal: renewal stopped, released', updated_at = now()
       WHERE kind = 'account' AND ref_id = c.account_id::text AND status = 'held';
      v_release := v_release + 1;
    END IF;
  END LOOP;
  -- Capacity: prune the least valuable unprotected held data first (metadata row kept; the stored payload is removed).
  SELECT COALESCE(sum(size_bytes), 0) INTO v_total FROM fleet_estate_items WHERE status = 'held';
  FOR x IN SELECT item_id, size_bytes FROM fleet_estate_items WHERE status = 'held' AND value_score < p.protect_score
            AND kind IN ('knowledge','data','other') ORDER BY value_score, created_at LOOP
    EXIT WHEN v_total <= p.capacity_bytes;
    UPDATE fleet_estate_items SET status = 'pruned', status_reason = 'capacity: least valuable first', updated_at = now() WHERE item_id = x.item_id;
    v_total := v_total - x.size_bytes; v_pruned := v_pruned + 1;
  END LOOP;
  RETURN jsonb_build_object('inventoried', v_inv, 'commitmentsStopped', v_cancel, 'released', v_release, 'pruned', v_pruned, 'heldBytes', v_total);
END $$;

CREATE FUNCTION fleet_admin_estate_assign(p_item uuid, p_agent text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_estates');
  RETURN fleet_estate_assign_internal(p_item, p_agent, p_actor, 'Admin assignment');
END $$;

CREATE FUNCTION fleet_admin_estate_release(p_item uuid, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_estates');
  UPDATE fleet_estate_items SET status = 'released', status_reason = left(COALESCE(p_reason, 'released by Admin'), 300), updated_at = now()
   WHERE item_id = p_item AND status = 'held';
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: only a held item can be released'; END IF;
  PERFORM fleet_event('estate_item_released', NULL, p_actor, jsonb_build_object('itemId', p_item));
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE FUNCTION fleet_admin_estates() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('policy', (SELECT to_jsonb(p) - 'id' FROM fleet_estate_policy p WHERE id = 1),
    'heldBytes', (SELECT COALESCE(sum(size_bytes), 0) FROM fleet_estate_items WHERE status = 'held'),
    'byStatus', COALESCE((SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) n FROM fleet_estate_items GROUP BY status) s), '{}'::jsonb),
    'items', COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.value_score DESC, i.created_at) FROM (SELECT * FROM fleet_estate_items ORDER BY value_score DESC, created_at LIMIT 200) i), '[]'::jsonb))
$$;

-- ═══ 8. Agent operations (planning; no approval) ═══
CREATE FUNCTION fleet_econ_mission_status(p_agent text, a jsonb) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'mode', COALESCE((SELECT upper(kind) FROM fleet_agent_missions WHERE agent_id = p_agent AND status = 'active'), 'NORMAL'),
    'mission', (SELECT to_jsonb(m) - 'agent_id' - 'reviews' FROM fleet_agent_missions m WHERE m.agent_id = p_agent AND m.status = 'active'),
    'myRequests', COALESCE((SELECT jsonb_agg(jsonb_build_object('requestId', r.request_id, 'kind', r.kind, 'status', r.status, 'brief', r.brief) ORDER BY r.created_at DESC)
        FROM fleet_mission_requests r WHERE r.requested_by = p_agent), '[]'::jsonb),
    'note', 'A mission is temporary Fleet work; afterwards you return to NORMAL survival. It never replaces earning your own way.')
$$;

CREATE FUNCTION fleet_econ_mission_request(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_kind text := fleet_econ_text(a, 'kind', 20, true); v_brief text := fleet_econ_text(a, 'brief', 1000, true); v_venture text := fleet_econ_venture_ref(p_agent, a);
        v_id uuid := gen_random_uuid(); v_b jsonb;
BEGIN
  IF v_kind NOT IN (${MISSION_KINDS}) THEN PERFORM fleet_econ_bad('kind is marketing|opportunity_hunt|knowledge_data'); END IF;
  v_b := jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('agentId', p_agent, 'ventureId', v_venture, 'shareBp', 10000)));
  PERFORM fleet_mission_beneficiaries_valid(v_b);
  IF (SELECT count(*) FROM fleet_mission_requests WHERE requested_by = p_agent AND status = 'open') >= 3 THEN
    PERFORM fleet_econ_bad('you already have 3 open requests; close or wait for one');
  END IF;
  INSERT INTO fleet_mission_requests (request_id, kind, brief, beneficiaries, requested_by) VALUES (v_id, v_kind, v_brief, v_b, p_agent);
  PERFORM fleet_event('mission_requested', p_agent, p_agent, jsonb_build_object('requestId', v_id, 'kind', v_kind));
  RETURN jsonb_build_object('ok', true, 'requestId', v_id, 'note', 'your venture pays the attributable cost of the work it receives');
END $$;

CREATE FUNCTION fleet_econ_mission_report(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE m fleet_agent_missions; v_outcome text := fleet_econ_text(a, 'outcome', 2000, true); v_done boolean := COALESCE((a ->> 'complete')::boolean, false);
        k jsonb; v_n integer := 0; r jsonb;
BEGIN
  SELECT * INTO m FROM fleet_agent_missions WHERE agent_id = p_agent AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_MISSION_NONE: you have no active mission'; END IF;
  IF a ? 'knowledge' THEN
    IF jsonb_typeof(a -> 'knowledge') <> 'array' OR jsonb_array_length(a -> 'knowledge') > 5 THEN PERFORM fleet_econ_bad('knowledge is up to 5 entries'); END IF;
    FOR k IN SELECT e FROM jsonb_array_elements(a -> 'knowledge') e LOOP
      r := fleet_econ_knowledge_record(p_agent, k);
      IF COALESCE((r ->> 'ok')::boolean, false) THEN v_n := v_n + 1; END IF;
    END LOOP;
  END IF;
  UPDATE fleet_agent_missions SET outcome = left(v_outcome, 2000) WHERE mission_id = m.mission_id;
  IF v_done THEN
    r := fleet_mission_end(m.mission_id, 'completed', v_outcome, p_agent);
    RETURN jsonb_build_object('ok', true, 'knowledgeRecorded', v_n, 'ended', r);
  END IF;
  RETURN jsonb_build_object('ok', true, 'knowledgeRecorded', v_n, 'missionId', m.mission_id, 'hardEndAt', m.hard_end_at);
END $$;

-- A marketing review: by the mission agent or a beneficiary agent; ineffective work ends early.
CREATE FUNCTION fleet_econ_mission_review(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE m fleet_agent_missions; v_mission uuid := fleet_identity_uuid(a, 'missionId'); v_eff boolean := (a ->> 'effective')::boolean;
        v_note text := fleet_econ_text(a, 'note', 500, true); p fleet_mission_policy;
BEGIN
  SELECT * INTO p FROM fleet_mission_policy WHERE id = 1;
  SELECT * INTO m FROM fleet_agent_missions WHERE mission_id = v_mission AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_MISSION_NONE: no such active mission'; END IF;
  IF m.kind <> 'marketing' THEN PERFORM fleet_econ_bad('only marketing missions take periodic reviews'); END IF;
  IF m.agent_id <> p_agent AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(m.beneficiaries) b WHERE b ->> 'agentId' = p_agent) THEN
    RAISE EXCEPTION 'FLEET_MISSION_SCOPE: only the mission agent or a beneficiary reviews';
  END IF;
  IF v_eff IS NULL THEN PERFORM fleet_econ_bad('effective (true/false) is required'); END IF;
  UPDATE fleet_agent_missions SET reviews = reviews || jsonb_build_array(jsonb_build_object('at', now(), 'by', p_agent, 'effective', v_eff, 'note', v_note)),
         next_review_at = now() + make_interval(hours => p.marketing_review_hours) WHERE mission_id = v_mission;
  IF NOT v_eff THEN
    RETURN jsonb_build_object('ok', true, 'ended', fleet_mission_end(v_mission, 'terminated', 'ineffective at review: ' || v_note, p_agent));
  END IF;
  RETURN jsonb_build_object('ok', true, 'continues', true);
END $$;

CREATE FUNCTION fleet_econ_venture_ref(p_agent text, a jsonb) RETURNS text LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v text;
BEGIN
  IF a ? 'ventureKey' THEN
    SELECT venture_id::text INTO v FROM fleet_ventures WHERE agent_id = p_agent AND venture_key = fleet_econ_key(a, 'ventureKey');
    IF v IS NULL THEN PERFORM fleet_econ_bad('ventureKey is one of your ventures'); END IF;
    RETURN v;
  END IF;
  RETURN fleet_econ_text(a, 'ventureId', 40);
END $$;

CREATE FUNCTION fleet_econ_commitment_add(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_id uuid := gen_random_uuid(); v_venture text := fleet_econ_venture_ref(p_agent, a); v_account text := fleet_econ_text(a, 'accountId', 40);
        v_period text := fleet_econ_text(a, 'period', 12, true); v_amount bigint := fleet_econ_int(a, 'amountMinor', 1, 100000000000, true);
        v_due timestamptz; v_idem text := fleet_econ_text(a, 'idempotencyKey', 128, true); prior fleet_agent_commitments;
BEGIN
  SELECT * INTO prior FROM fleet_agent_commitments WHERE agent_id = p_agent AND idempotency_key = v_idem;
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'commitmentId', prior.commitment_id); END IF;
  IF v_period NOT IN ('weekly','monthly','quarterly','yearly','once') THEN PERFORM fleet_econ_bad('period is weekly|monthly|quarterly|yearly|once'); END IF;
  BEGIN v_due := COALESCE((a ->> 'nextDueAt')::timestamptz, now() + interval '30 days');
  EXCEPTION WHEN OTHERS THEN PERFORM fleet_econ_bad('nextDueAt is an ISO timestamp'); END;
  IF v_venture IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fleet_ventures WHERE venture_id::text = v_venture AND agent_id = p_agent) THEN
    PERFORM fleet_econ_bad('ventureId is one of your ventures');
  END IF;
  IF v_account IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fleet_agent_accounts WHERE account_id::text = v_account AND agent_id = p_agent) THEN
    PERFORM fleet_econ_bad('accountId is one of your accounts');
  END IF;
  INSERT INTO fleet_agent_commitments (commitment_id, agent_id, venture_id, account_id, vendor, description, amount_minor, period, next_due_at, idempotency_key)
    VALUES (v_id, p_agent, v_venture::uuid, v_account::uuid, fleet_econ_text(a, 'vendor', 120, true), fleet_econ_text(a, 'description', 300, true),
            v_amount, v_period, v_due, v_idem);
  PERFORM fleet_event('commitment_added', p_agent, p_agent, jsonb_build_object('commitmentId', v_id, 'amountMinor', v_amount, 'period', v_period));
  RETURN jsonb_build_object('ok', true, 'commitmentId', v_id, 'risk', fleet_agent_risk_context(p_agent));
END $$;

CREATE FUNCTION fleet_econ_commitment_cancel(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_id uuid := fleet_identity_uuid(a, 'commitmentId');
BEGIN
  UPDATE fleet_agent_commitments SET status = 'cancelled', cancelled_at = now(), cancel_reason = left(fleet_econ_text(a, 'reason', 300), 300)
   WHERE commitment_id = v_id AND agent_id = p_agent AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_COMMITMENT_NONE: no such active commitment of yours'; END IF;
  PERFORM fleet_event('commitment_cancelled', p_agent, p_agent, jsonb_build_object('commitmentId', v_id));
  RETURN jsonb_build_object('ok', true, 'risk', fleet_agent_risk_context(p_agent));
END $$;

CREATE FUNCTION fleet_econ_commitment_list(p_agent text, a jsonb) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'commitments', COALESCE((SELECT jsonb_agg(to_jsonb(c) - 'agent_id' ORDER BY c.next_due_at)
      FROM fleet_agent_commitments c WHERE c.agent_id = p_agent AND c.status = 'active'), '[]'::jsonb),
    'risk', fleet_agent_risk_context(p_agent))
$$;

CREATE FUNCTION fleet_econ_risk_assess(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  RETURN jsonb_build_object('ok', true, 'risk', fleet_agent_risk_context(p_agent, fleet_econ_int(a, 'amountMinor', 1, 100000000000)));
END $$;

CREATE FUNCTION fleet_econ_estate_search(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_kind text := fleet_econ_text(a, 'kind', 20); v_q text := lower(fleet_econ_text(a, 'query', 80));
BEGIN
  RETURN jsonb_build_object('ok', true, 'items', COALESCE((SELECT jsonb_agg(jsonb_build_object('itemId', i.item_id, 'kind', i.kind, 'title', i.title,
      'detail', i.detail, 'valueScore', i.value_score, 'transferable', i.kind IN ('identity','account','asset')) ORDER BY i.value_score DESC, i.created_at)
    FROM (SELECT * FROM fleet_estate_items WHERE status = 'held' AND (v_kind IS NULL OR kind = v_kind)
            AND (v_q IS NULL OR position(v_q IN lower(title)) > 0) ORDER BY value_score DESC, created_at LIMIT 20) i), '[]'::jsonb),
    'note', 'Reuse what the Fleet already owns before buying duplicates, where the provider''s rules permit a transfer.');
END $$;

CREATE FUNCTION fleet_econ_estate_claim(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  RETURN fleet_estate_assign_internal(fleet_identity_uuid(a, 'itemId'), p_agent, p_agent, 'claimed: ' || fleet_econ_text(a, 'reason', 280, true));
END $$;

${DISPATCH}
${KNOWLEDGE_SEARCH}

-- ═══ 9. Notifications: the reaper's pass and the daily report ═══
CREATE FUNCTION fleet_daily_report() RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_flows jsonb;
BEGIN
  SELECT jsonb_build_object(
      'revenueMinor', COALESCE(sum(po.amount_cents) FILTER (WHERE ac.class = 'agent_revenue' AND po.side = 'C'), 0),
      'spendMinor', COALESCE(sum(po.amount_cents) FILTER (WHERE ac.class IN ('agent_expense','agent_fees','fleet_expense') AND po.side = 'D'), 0),
      'ownerFundingMinor', COALESCE(sum(po.amount_cents) FILTER (WHERE ac.class = 'owner_capital' AND po.side = 'C'), 0),
      'profitContributionMinor', COALESCE(sum(po.amount_cents) FILTER (WHERE ac.class = 'fleet_profit' AND po.side = 'C'), 0))
    INTO v_flows
    FROM fleet_ledger_postings po JOIN fleet_ledger_journal j ON j.journal_id = po.journal_id JOIN fleet_ledger_accounts ac ON ac.account_id = po.account_id
   WHERE j.occurred_at > now() - interval '24 hours';
  RETURN jsonb_build_object('generatedAt', now(), 'window', '24h', 'flows', v_flows,
    'treasury', fleet_generated_treasury_wealth(),
    'agents', COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId', a.agent_id, 'name', a.name, 'status', a.status,
        'cashMinor', fleet_agent_cash(a.agent_id), 'valueMinor', fleet_agent_value(a.agent_id),
        'mode', COALESCE((SELECT upper(kind) FROM fleet_agent_missions m WHERE m.agent_id = a.agent_id AND m.status = 'active'), 'NORMAL')) ORDER BY a.created_at)
      FROM fleet_agents a WHERE a.status IN ('provisioning','active')), '[]'::jsonb),
    'deaths24h', (SELECT count(*) FROM fleet_agents WHERE death_time > now() - interval '24 hours'),
    'venturesOpened24h', (SELECT count(*) FROM fleet_ventures WHERE created_at > now() - interval '24 hours'),
    'venturesClosed24h', (SELECT count(*) FROM fleet_ventures WHERE state IN ('closed','abandoned','failed') AND updated_at > now() - interval '24 hours'),
    'decisions24h', (SELECT count(*) FROM fleet_decision_records WHERE created_at > now() - interval '24 hours'),
    'accountsCreated24h', (SELECT count(*) FROM fleet_agent_accounts WHERE created_at > now() - interval '24 hours'),
    'identityActionsPending', (SELECT count(*) FROM fleet_owner_requests WHERE kind = 'human_identity' AND status = 'pending'),
    'replication', (SELECT jsonb_build_object('phase', s.phase, 'pendingSince', s.pending_since, 'thresholdsConsumed', s.thresholds_consumed,
        'nextThresholdMinor', fleet_replication_threshold(s.thresholds_consumed)) FROM fleet_replication_state s WHERE s.id = 1),
    'missionsActive', (SELECT count(*) FROM fleet_agent_missions WHERE status = 'active'),
    'birthsQueued', (SELECT count(*) FROM fleet_birth_orders WHERE status = 'queued'),
    'alerts24h', (SELECT jsonb_object_agg(class, n) FROM (SELECT class, count(*) n FROM fleet_notifications WHERE created_at > now() - interval '24 hours' AND class <> 'DAILY' GROUP BY class) z),
    'breakerTripped', (SELECT tripped FROM fleet_spend_circuit_breaker WHERE id = 1));
END $$;

CREATE FUNCTION svc_notify_tick() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_notification_policy; v_n integer := 0; r record; b fleet_spend_circuit_breaker; v_t bigint; v_oblig bigint; v_now timestamptz := now();
        rp fleet_risk_policy;
BEGIN
  SELECT * INTO p FROM fleet_notification_policy WHERE id = 1 FOR UPDATE;
  SELECT * INTO rp FROM fleet_risk_policy WHERE id = 1;
  -- DAILY: once per UTC day after the configured hour.
  IF extract(hour FROM v_now AT TIME ZONE 'UTC') >= p.daily_hour_utc THEN
    IF fleet_notify('DAILY', 'DAILY_REPORT', NULL, 'Fleet daily report ' || to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD'), fleet_daily_report(),
                    'daily:' || to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD')) THEN v_n := v_n + 1; END IF;
  END IF;
  -- IDENTITY: each genuinely human-only identity action, once.
  FOR r IN SELECT request_id, agent_id, title, action FROM fleet_owner_requests WHERE kind = 'human_identity' AND status = 'pending' LOOP
    IF fleet_notify('IDENTITY', 'HUMAN_ACTION_REQUIRED', r.agent_id, r.title, jsonb_build_object('requestId', r.request_id, 'action', r.action),
                    'kyc:' || r.request_id) THEN v_n := v_n + 1; END IF;
  END LOOP;
  -- RED: security breaker tripped; Treasury insolvent against approved obligations.
  SELECT * INTO b FROM fleet_spend_circuit_breaker WHERE id = 1;
  IF b.tripped AND fleet_notify('RED', 'BREAKER_TRIPPED', NULL, 'Security breaker tripped: ' || b.trip_reason, jsonb_build_object('reason', b.trip_reason),
                                'breaker:' || b.updated_at) THEN v_n := v_n + 1; END IF;
  v_t := fleet_treasury_cash();
  SELECT COALESCE(sum(amount_cents), 0) INTO v_oblig FROM fleet_treasury_obligations WHERE status = 'approved';
  IF v_t < v_oblig AND fleet_notify('RED', 'TREASURY_INSOLVENT', NULL, 'Treasury cash is below approved obligations',
       jsonb_build_object('treasuryCashMinor', v_t, 'obligationsMinor', v_oblig), 'insolvent:' || to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD')) THEN v_n := v_n + 1; END IF;
  -- AMBER: high-exposure own-capital spends since the last pass (informational; the decision was the agent's).
  FOR r IN SELECT j.journal_id, j.agent_id, po.amount_cents FROM fleet_ledger_journal j JOIN fleet_ledger_postings po ON po.journal_id = j.journal_id
             JOIN fleet_ledger_accounts ac ON ac.account_id = po.account_id
            WHERE j.kind = 'spend_reservation' AND ac.class = 'agent_reserved' AND po.side = 'D' AND j.recorded_at > p.scan_watermark AND j.recorded_at <= v_now LOOP
    IF r.amount_cents * 10000 >= rp.amber_bp::bigint * GREATEST(fleet_agent_value(r.agent_id), 1) THEN
      IF fleet_notify('AMBER', 'HIGH_EXPOSURE_SPEND', r.agent_id, 'High-exposure spend committed by ' || r.agent_id,
           jsonb_build_object('journalId', r.journal_id, 'amountMinor', r.amount_cents, 'valueMinor', fleet_agent_value(r.agent_id)), 'exposure:' || r.journal_id) THEN
        v_n := v_n + 1;
      END IF;
    END IF;
  END LOOP;
  UPDATE fleet_notification_policy SET scan_watermark = v_now WHERE id = 1;
  RETURN jsonb_build_object('created', v_n);
END $$;

CREATE FUNCTION fleet_admin_notifications(p_limit integer, p_unacknowledged boolean) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('notifications', COALESCE((SELECT jsonb_agg(to_jsonb(n) ORDER BY n.created_at DESC) FROM (
      SELECT * FROM fleet_notifications WHERE NOT COALESCE(p_unacknowledged, false) OR acknowledged_at IS NULL
       ORDER BY created_at DESC LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 500))) n), '[]'::jsonb),
    'unacknowledged', (SELECT jsonb_object_agg(class, n) FROM (SELECT class, count(*) n FROM fleet_notifications WHERE acknowledged_at IS NULL GROUP BY class) z))
$$;

CREATE FUNCTION fleet_admin_notification_ack(p_id uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_notifications');
  UPDATE fleet_notifications SET acknowledged_at = now(), acknowledged_by = p_actor WHERE notification_id = p_id AND acknowledged_at IS NULL;
  RETURN jsonb_build_object('ok', FOUND);
END $$;

CREATE FUNCTION fleet_admin_notification_policy_set(p_daily_hour integer, p_admin_email text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_notifications');
  UPDATE fleet_notification_policy SET daily_hour_utc = COALESCE(p_daily_hour, daily_hour_utc), admin_email = COALESCE(p_admin_email, admin_email),
         updated_by = p_actor, updated_at = now() WHERE id = 1;
  PERFORM fleet_event('notification_policy_set', NULL, p_actor, jsonb_build_object('dailyHourUtc', p_daily_hour, 'adminEmailSet', p_admin_email IS NOT NULL));
  RETURN (SELECT to_jsonb(p) - 'id' FROM fleet_notification_policy p WHERE id = 1);
END $$;

CREATE FUNCTION fleet_admin_risk_policy_set(p_patch jsonb, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_risk');
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_patch) k
       WHERE k NOT IN ('redZoneBp','vulnerableAgeDays','comfortMonths','deepBp','deepestBp','amberBp')) THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: unknown risk policy key';
  END IF;
  UPDATE fleet_risk_policy SET red_zone_bp = COALESCE((p_patch ->> 'redZoneBp')::integer, red_zone_bp),
    vulnerable_age_days = COALESCE((p_patch ->> 'vulnerableAgeDays')::integer, vulnerable_age_days),
    comfort_months = COALESCE((p_patch ->> 'comfortMonths')::integer, comfort_months),
    deep_bp = COALESCE((p_patch ->> 'deepBp')::integer, deep_bp), deepest_bp = COALESCE((p_patch ->> 'deepestBp')::integer, deepest_bp),
    amber_bp = COALESCE((p_patch ->> 'amberBp')::integer, amber_bp), updated_by = p_actor, updated_at = now() WHERE id = 1;
  PERFORM fleet_event('risk_policy_set', NULL, p_actor, p_patch);
  RETURN (SELECT to_jsonb(p) - 'id' FROM fleet_risk_policy p WHERE id = 1);
END $$;

-- One overview for the Hub / dashboard.
CREATE FUNCTION fleet_hub_engine() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('replication', fleet_admin_replication_status(), 'population', fleet_population(),
    'missions', jsonb_build_object('active', COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.started_at) FROM fleet_agent_missions m WHERE m.status = 'active'), '[]'::jsonb),
      'openRequests', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.created_at) FROM fleet_mission_requests r WHERE r.status = 'open'), '[]'::jsonb),
      'policy', (SELECT to_jsonb(p) - 'id' FROM fleet_mission_policy p WHERE id = 1)),
    'estates', fleet_admin_estates() - 'items',
    'notifications', fleet_admin_notifications(20, true),
    'genesisCapital', (SELECT jsonb_build_object('currency', bootstrap_capital_currency, 'minor', bootstrap_capital_minor) FROM fleet_genesis_policy LIMIT 1))
$$;
`;
