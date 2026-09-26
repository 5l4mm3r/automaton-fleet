/**
 * Schema v21 — GBP-native founder capital and controlled FX (Genesis authorization, owner correction of v20).
 *
 * The owner's model: Founder 1 is born holding GBP £100.00; nothing converts it at Genesis. Currency conversion
 * happens only where an economic operation needs it, at a rate FleetController obtains and validates (never the
 * founder), recorded with the operation.
 *
 * 1. Accounting currency. The ledger remains single-currency, integer minor units (the v10 design), but its
 *    currency becomes explicit policy: fleet_economic_model.accounting_currency = 'GBP' (part of the economic
 *    policy hash every Genesis binds). It may only be set on an EMPTY ledger (this migration refuses otherwise,
 *    and the column cannot change once journals exist). Every ledger account takes that currency. Amount columns
 *    keep their historical *_cents names; they are minor units of the accounting currency (pence).
 * 2. Genesis. Capital in the accounting currency needs no rate: allocation = capital (GBP 10000 → 10000 pence).
 *    Capital in another currency still needs a sourced, dated rate (v20 path, generalised).
 * 3. Controlled FX. fleet_fx_rates (append-only): base, quote, rate (quote units per base unit × 10^6), source,
 *    source URL + SHA-256, reference date, recorder (the controller's ECB feed via the isolated fetcher, or the
 *    owner). Plausibility-checked; the latest rate at most 5 days old is authoritative; none → fail closed.
 * 4. Provider credits are a USD operating resource OUTSIDE the GBP ledger: fleet_provider_credit_events
 *    (append-only; owner-recorded purchases/adjustments in USD, per-call consumption in exact USD µ¢). They are
 *    not founder capital and not treasury GBP.
 * 5. Inference. Provider cost stays exact USD µ¢ (v17). At authorization the USD estimate is converted at the
 *    current controlled rate (rounded UP, against the founder) for the founder's GBP gates, and the rate is
 *    reserved with the call. At record the exact USD cost is converted at that same rate (rounded UP) into GBP
 *    micro-pence, accrued exactly (L13) and posted in whole pence (agent_expense D / agent_cash C). The USD cost
 *    is consumed from provider credits. Every call records rate id, rate, USD cost and GBP charge.
 */

export const V21_SQL = `
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM fleet_ledger_journal) THEN
    RAISE EXCEPTION 'FLEET_LEDGER_NOT_EMPTY: the accounting currency can only be set on an empty ledger';
  END IF;
END $$;

-- ═══ 1. Accounting currency ═══
ALTER TABLE fleet_economic_model ADD COLUMN accounting_currency text NOT NULL DEFAULT 'GBP' CHECK (accounting_currency ~ '^[A-Z]{3}$');
CREATE FUNCTION fleet_economic_model_currency_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF NEW.accounting_currency IS DISTINCT FROM OLD.accounting_currency AND EXISTS (SELECT 1 FROM fleet_ledger_journal) THEN
    RAISE EXCEPTION 'FLEET_LEDGER_NOT_EMPTY: the accounting currency cannot change once journals exist';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_economic_model_currency_guard BEFORE UPDATE ON fleet_economic_model
  FOR EACH ROW EXECUTE FUNCTION fleet_economic_model_currency_guard();

DO $$ DECLARE c text; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'fleet_ledger_accounts'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) ~ 'currency' LOOP
    EXECUTE format('ALTER TABLE fleet_ledger_accounts DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE fleet_ledger_accounts ALTER COLUMN currency DROP DEFAULT;
ALTER TABLE fleet_ledger_accounts ADD CONSTRAINT fleet_ledger_accounts_currency_iso CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE fleet_ledger_accounts DISABLE TRIGGER fleet_ledger_accounts_no_change;
UPDATE fleet_ledger_accounts SET currency = (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1);
ALTER TABLE fleet_ledger_accounts ENABLE TRIGGER fleet_ledger_accounts_no_change;
CREATE FUNCTION fleet_ledger_accounts_currency() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  NEW.currency := (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1);
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_ledger_accounts_currency BEFORE INSERT ON fleet_ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION fleet_ledger_accounts_currency();

CREATE OR REPLACE FUNCTION fleet_economic_policy_sha256() RETURNS text LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT encode(sha256(convert_to(
    (SELECT string_agg(kind || ':' || class || ':' || side, ',' ORDER BY kind, class, side) FROM fleet_ledger_rules) || '|' ||
    (SELECT string_agg(kind || ':' || provenance, ',' ORDER BY kind) FROM fleet_ledger_kinds) || '|' ||
    (SELECT concat_ws(':', owner_approval_threshold_cents, agent_daily_spend_cents, reservation_ttl_s, strong_auth_threshold_cents,
                      destination_cooldown_s, confirmation_ttl_s, custody_execution_enabled, accounting_currency) FROM fleet_economic_model WHERE id = 1),
    'UTF8')), 'hex')
$$;

-- ═══ 2. Genesis capital in the accounting currency needs no rate ═══
ALTER TABLE fleet_genesis DROP CONSTRAINT fleet_genesis_capital_complete;
ALTER TABLE fleet_genesis ADD CONSTRAINT fleet_genesis_capital_complete CHECK (
  (capital_minor IS NULL AND capital_currency IS NULL AND fx_usd_micro IS NULL AND fx_source IS NULL AND fx_observed_at IS NULL)
  OR (capital_minor IS NOT NULL AND capital_currency IS NOT NULL AND fx_usd_micro IS NULL AND fx_source IS NULL AND fx_observed_at IS NULL
      AND allocation_cents = capital_minor)
  OR (capital_minor IS NOT NULL AND capital_currency IS NOT NULL AND fx_usd_micro IS NOT NULL AND fx_source IS NOT NULL AND fx_observed_at IS NOT NULL
      AND allocation_cents = floor(capital_minor::numeric * fx_usd_micro / 1000000)::bigint));
COMMENT ON COLUMN fleet_genesis.fx_usd_micro IS 'v21: accounting-currency units per capital-currency unit × 10^6; NULL when the capital is in the accounting currency';

CREATE OR REPLACE FUNCTION fleet_genesis_capital_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE pol fleet_genesis_policy; v_acct text := (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1);
BEGIN
  SELECT * INTO pol FROM fleet_genesis_policy WHERE id = 1;
  IF pol.bootstrap_capital_minor IS NOT NULL AND (NEW.capital_minor IS DISTINCT FROM pol.bootstrap_capital_minor
       OR NEW.capital_currency IS DISTINCT FROM pol.bootstrap_capital_currency) THEN
    RAISE EXCEPTION 'FLEET_GENESIS_CAPITAL: Genesis capital is % % (minor units) per founder; use fleet_genesis_propose_capital',
      pol.bootstrap_capital_currency, pol.bootstrap_capital_minor;
  END IF;
  IF NEW.capital_minor IS NOT NULL AND NEW.fx_usd_micro IS NULL AND NEW.capital_currency IS DISTINCT FROM v_acct THEN
    RAISE EXCEPTION 'FLEET_GENESIS_FX_INVALID: % capital needs a rate into the ledger currency %', NEW.capital_currency, v_acct;
  END IF;
  IF NEW.fx_usd_micro IS NOT NULL AND (NEW.fx_observed_at > now() + interval '5 minutes' OR NEW.fx_observed_at < now() - interval '24 hours') THEN
    RAISE EXCEPTION 'FLEET_GENESIS_FX_STALE: the exchange rate must have been observed within 24 hours';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION fleet_genesis_propose_capital(p_idem text, p_founder_count integer, p_manifest_id text, p_fx_usd_micro bigint,
  p_fx_source text, p_fx_observed_at timestamptz, p_ttl_s integer, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p_kind text := 'genesis'; p_allocation_cents bigint; g fleet_genesis; pol fleet_genesis_policy; st fleet_state; m fleet_capability_manifests; v_id uuid := gen_random_uuid(); prior fleet_genesis;
BEGIN
  PERFORM fleet_genesis_owner(p_actor);
  IF p_idem IS NULL OR p_idem !~ '^[A-Za-z0-9:_.-]{8,128}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: idempotency key required'; END IF;
  SELECT * INTO pol FROM fleet_genesis_policy WHERE id = 1;
  IF pol.bootstrap_capital_minor IS NULL THEN RAISE EXCEPTION 'FLEET_GENESIS_CAPITAL: no bootstrap capital is configured'; END IF;
  IF pol.bootstrap_capital_currency = (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1) THEN
    -- v21: the founder is born holding its capital in the ledger's own currency: no exchange rate at Genesis.
    IF p_fx_usd_micro IS NOT NULL OR p_fx_source IS NOT NULL THEN
      RAISE EXCEPTION 'FLEET_GENESIS_FX_NOT_APPLICABLE: % capital needs no exchange rate (the ledger is %)', pol.bootstrap_capital_currency, pol.bootstrap_capital_currency;
    END IF;
    p_allocation_cents := pol.bootstrap_capital_minor;
    p_fx_observed_at := NULL;
  ELSE
    -- Capital in another currency: rate = ledger-currency units per capital unit × 10^6 (column name kept from v20).
    IF p_fx_usd_micro IS NULL OR p_fx_usd_micro < 1 OR p_fx_usd_micro > 1000000000 OR p_fx_source IS NULL OR p_fx_observed_at IS NULL THEN
      RAISE EXCEPTION 'FLEET_GENESIS_FX_INVALID: % capital needs a positive, sourced, dated rate (micro-units)', pol.bootstrap_capital_currency;
    END IF;
    p_allocation_cents := floor(pol.bootstrap_capital_minor::numeric * p_fx_usd_micro / 1000000)::bigint;
  END IF;
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  SELECT * INTO m FROM fleet_capability_manifests WHERE manifest_id = COALESCE(p_manifest_id, pol.default_manifest_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_MANIFEST_INVALID: unknown manifest'; END IF;
  IF p_kind = 'reseeding' AND NOT pol.refounding_enabled THEN RAISE EXCEPTION 'FLEET_RESEEDING_NOT_ENABLED: reseeding is modelled but not enabled'; END IF;
  IF p_kind <> 'genesis' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: kind is genesis'; END IF;
  IF p_founder_count IS NULL OR p_founder_count < 1 OR p_founder_count > 50 THEN
    RAISE EXCEPTION 'FLEET_CAP_EXCEEDED: founder count must be 1..50 (constitutional maximum)';
  END IF;
  IF p_allocation_cents IS NULL OR p_allocation_cents < 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: allocation must be >= 0'; END IF;
  IF st.runtime_commit IS NULL OR st.runtime_build_id IS NULL OR st.runtime_lockfile_sha256 IS NULL THEN
    RAISE EXCEPTION 'FLEET_RUNTIME_NOT_APPROVED: approve a runtime before Genesis';
  END IF;
  SELECT * INTO prior FROM fleet_genesis WHERE idempotency_key = p_idem;
  IF FOUND THEN
    IF prior.founder_count = p_founder_count AND prior.manifest_id = m.manifest_id AND prior.allocation_cents = p_allocation_cents AND prior.kind = p_kind
       AND prior.fx_usd_micro IS NOT DISTINCT FROM p_fx_usd_micro AND prior.fx_source IS NOT DISTINCT FROM p_fx_source THEN
      RETURN fleet_genesis_json(prior) || jsonb_build_object('replay', true);
    END IF;
    RAISE EXCEPTION 'FLEET_IDEMPOTENCY_CONFLICT: key % belongs to a different Genesis', p_idem;
  END IF;
  PERFORM fleet_genesis_begin(v_id, p_actor);
  g.genesis_id := v_id; g.kind := p_kind; g.idempotency_key := p_idem; g.founder_count := p_founder_count;
  g.template_version := pol.template_version; g.manifest_id := m.manifest_id; g.manifest_sha256 := m.manifest_sha256;
  g.runtime_repo := st.runtime_repo; g.runtime_commit := st.runtime_commit; g.runtime_build_id := st.runtime_build_id;
  g.runtime_lockfile_sha256 := st.runtime_lockfile_sha256; g.economic_policy_sha256 := fleet_economic_policy_sha256();
  g.allocation_cents := p_allocation_cents;
  g.capital_currency := pol.bootstrap_capital_currency; g.capital_minor := pol.bootstrap_capital_minor; g.fx_usd_micro := p_fx_usd_micro;
  g.fx_source := p_fx_source; g.fx_observed_at := date_trunc('milliseconds', p_fx_observed_at);
  g.expires_at := date_trunc('milliseconds', now() + make_interval(secs => LEAST(GREATEST(COALESCE(p_ttl_s, 86400), 600), pol.max_ttl_s)));
  g.requested_by := p_actor;
  g.auth_sha256 := encode(sha256(convert_to(fleet_genesis_canonical(g), 'UTF8')), 'hex');
  INSERT INTO fleet_genesis (genesis_id, kind, idempotency_key, founder_count, template_version, manifest_id, manifest_sha256, runtime_repo,
      runtime_commit, runtime_build_id, runtime_lockfile_sha256, economic_policy_sha256, allocation_cents, expires_at, requested_by, auth_sha256,
      capital_currency, capital_minor, fx_usd_micro, fx_source, fx_observed_at)
    VALUES (g.genesis_id, g.kind, g.idempotency_key, g.founder_count, g.template_version, g.manifest_id, g.manifest_sha256, g.runtime_repo,
      g.runtime_commit, g.runtime_build_id, g.runtime_lockfile_sha256, g.economic_policy_sha256, g.allocation_cents, g.expires_at, g.requested_by, g.auth_sha256,
      g.capital_currency, g.capital_minor, g.fx_usd_micro, g.fx_source, g.fx_observed_at)
    RETURNING * INTO g;
  PERFORM fleet_event('genesis_proposed', NULL, p_actor, jsonb_build_object('genesisId', v_id, 'founderCount', p_founder_count, 'capitalCurrency', g.capital_currency, 'capitalMinor', g.capital_minor, 'fxUsdMicro', g.fx_usd_micro,
    'authSha256', g.auth_sha256, 'allocationCents', p_allocation_cents));
  PERFORM fleet_genesis_end();
  RETURN fleet_genesis_json(g);
END $$;

-- ═══ 3. Controlled FX ═══
CREATE TABLE fleet_fx_rates (
  rate_id        bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  base           text        NOT NULL CHECK (base ~ '^[A-Z]{3}$'),
  quote          text        NOT NULL CHECK (quote ~ '^[A-Z]{3}$'),
  rate_micro     bigint      NOT NULL CHECK (rate_micro BETWEEN 1 AND 1000000000),
  source         text        NOT NULL CHECK (length(source) BETWEEN 3 AND 200),
  source_url     text        CHECK (length(source_url) <= 2048),
  source_sha256  text        CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  observed_on    date        NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  recorded_by    text        NOT NULL CHECK (recorded_by = 'controller' OR recorded_by ~ '^operator:[A-Za-z0-9._-]{1,64}$'),
  CHECK (base <> quote),
  UNIQUE (base, quote, source, observed_on)
);
COMMENT ON COLUMN fleet_fx_rates.rate_micro IS 'quote-currency units per 1 base-currency unit × 10^6 (integer; no floating point)';
CREATE TRIGGER fleet_fx_rates_no_change BEFORE UPDATE OR DELETE ON fleet_fx_rates FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_fx_rates_no_truncate BEFORE TRUNCATE ON fleet_fx_rates FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- The authoritative rate for base→quote: the newest reference date within 5 days (weekends/holidays), newest record first.
CREATE FUNCTION fleet_fx_latest(p_base text, p_quote text) RETURNS fleet_fx_rates LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT * FROM fleet_fx_rates WHERE base = p_base AND quote = p_quote AND observed_on >= (now() AT TIME ZONE 'UTC')::date - 5
   ORDER BY observed_on DESC, rate_id DESC LIMIT 1
$$;

CREATE FUNCTION fleet_fx_insert(p_base text, p_quote text, p_rate_micro bigint, p_source text, p_url text, p_sha text, p_observed date, p_by text,
  p_check_jump boolean) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE prev fleet_fx_rates; v_id bigint;
BEGIN
  IF p_observed IS NULL OR p_observed > (now() AT TIME ZONE 'UTC')::date + 1 OR p_observed < (now() AT TIME ZONE 'UTC')::date - 10 THEN
    RAISE EXCEPTION 'FLEET_FX_INVALID: reference date % is not current', p_observed;
  END IF;
  IF p_rate_micro IS NULL OR p_rate_micro < 1 OR p_rate_micro > 1000000000 THEN RAISE EXCEPTION 'FLEET_FX_INVALID: rate out of range'; END IF;
  SELECT * INTO prev FROM fleet_fx_rates WHERE base = p_base AND quote = p_quote ORDER BY observed_on DESC, rate_id DESC LIMIT 1;
  -- A parser or source fault must not move the books: more than a 20 % jump from the last rate is refused (owner may override).
  IF p_check_jump AND prev.rate_id IS NOT NULL AND abs(p_rate_micro - prev.rate_micro)::numeric > prev.rate_micro * 0.2 THEN
    RAISE EXCEPTION 'FLEET_FX_IMPLAUSIBLE: % → % moved more than 20%% (% → %)', p_base, p_quote, prev.rate_micro, p_rate_micro;
  END IF;
  INSERT INTO fleet_fx_rates (base, quote, rate_micro, source, source_url, source_sha256, observed_on, recorded_by)
    VALUES (p_base, p_quote, p_rate_micro, p_source, p_url, p_sha, p_observed, p_by)
    ON CONFLICT (base, quote, source, observed_on) DO NOTHING RETURNING rate_id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'rateId', v_id, 'duplicate', v_id IS NULL);
END $$;

-- FleetController (service role): its reference-rate feed.
CREATE FUNCTION svc_fx_record(p_base text, p_quote text, p_rate_micro bigint, p_source text, p_url text, p_sha text, p_observed date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  RETURN fleet_fx_insert(p_base, p_quote, p_rate_micro, p_source, p_url, p_sha, p_observed, 'controller', true);
END $$;

-- Owner: a rate recorded by hand (no jump check: the owner's own statement), audited as an event.
CREATE FUNCTION fleet_fx_record(p_base text, p_quote text, p_rate_micro bigint, p_source text, p_observed date, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r jsonb;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_fx');
  r := fleet_fx_insert(p_base, p_quote, p_rate_micro, p_source, NULL, NULL, p_observed, p_actor, false);
  PERFORM fleet_event('fx_rate_recorded', NULL, p_actor, jsonb_build_object('base', p_base, 'quote', p_quote, 'rateMicro', p_rate_micro, 'observedOn', p_observed));
  RETURN r;
END $$;

-- Current conversion view for FleetController and the owner (read-only).
CREATE FUNCTION fleet_fx_status() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('accountingCurrency', m.accounting_currency,
    'usd', (SELECT to_jsonb(x) FROM fleet_fx_latest('USD', m.accounting_currency) x WHERE x.rate_id IS NOT NULL),
    'latestAny', (SELECT to_jsonb(r) FROM fleet_fx_rates r WHERE r.base = 'USD' AND r.quote = m.accounting_currency ORDER BY observed_on DESC, rate_id DESC LIMIT 1))
  FROM fleet_economic_model m WHERE m.id = 1
$$;
CREATE FUNCTION svc_fx_status() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$ SELECT fleet_fx_status() $$;

-- ═══ 4. Provider credits: a USD operating resource outside the GBP ledger ═══
CREATE TABLE fleet_provider_credit_events (
  seq             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider        text        NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  kind            text        NOT NULL CHECK (kind IN ('purchase','adjustment','consumption')),
  usd_microcents  bigint      NOT NULL,
  request_id      uuid        UNIQUE,
  external_ref    text        CHECK (length(external_ref) BETWEEN 3 AND 200),
  recorded_by     text        NOT NULL,
  at              timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'consumption') = (request_id IS NOT NULL)),
  CHECK (kind <> 'purchase' OR usd_microcents > 0),
  CHECK (kind <> 'consumption' OR usd_microcents <= 0),
  CHECK (kind = 'consumption' OR external_ref IS NOT NULL)
);
CREATE INDEX fleet_provider_credit_events_provider_idx ON fleet_provider_credit_events (provider);
CREATE TRIGGER fleet_provider_credit_events_no_change BEFORE UPDATE OR DELETE ON fleet_provider_credit_events FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_provider_credit_events_no_truncate BEFORE TRUNCATE ON fleet_provider_credit_events FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_provider_credit_balance(p_provider text) RETURNS bigint LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(sum(usd_microcents), 0)::bigint FROM fleet_provider_credit_events WHERE provider = p_provider
$$;

-- Owner: real, verified provider credit (USD cents) — a purchase, or an adjustment to reconcile with the provider's own balance.
CREATE FUNCTION fleet_provider_credits_record(p_provider text, p_kind text, p_usd_cents bigint, p_external_ref text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_provider_credits');
  IF p_kind NOT IN ('purchase','adjustment') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: kind is purchase or adjustment'; END IF;
  IF p_usd_cents IS NULL OR p_usd_cents = 0 OR abs(p_usd_cents) > 10000000 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: amount must be non-zero USD cents'; END IF;
  IF p_external_ref IS NULL OR length(p_external_ref) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: an external reference is required'; END IF;
  INSERT INTO fleet_provider_credit_events (provider, kind, usd_microcents, external_ref, recorded_by)
    VALUES (p_provider, p_kind, p_usd_cents * 1000000, p_external_ref, p_actor);
  PERFORM fleet_event('provider_credits_recorded', NULL, p_actor, jsonb_build_object('provider', p_provider, 'kind', p_kind, 'usdCents', p_usd_cents));
  RETURN jsonb_build_object('ok', true, 'provider', p_provider, 'balanceUsdMicrocents', fleet_provider_credit_balance(p_provider));
END $$;

-- ═══ 5. Inference: USD provider cost → GBP founder charge at the reserved controlled rate ═══
ALTER TABLE fleet_cognition_inflight
  ADD COLUMN estimate_usd_cents bigint CHECK (estimate_usd_cents >= 0),
  ADD COLUMN fx_rate_id bigint REFERENCES fleet_fx_rates(rate_id),
  ADD COLUMN fx_rate_micro bigint CHECK (fx_rate_micro BETWEEN 1 AND 1000000000);
ALTER TABLE fleet_cognition_log
  ADD COLUMN ledger_currency text CHECK (ledger_currency ~ '^[A-Z]{3}$'),
  ADD COLUMN fx_rate_id bigint REFERENCES fleet_fx_rates(rate_id),
  ADD COLUMN fx_rate_micro bigint CHECK (fx_rate_micro BETWEEN 1 AND 1000000000),
  ADD COLUMN provider_usd_microcents bigint CHECK (provider_usd_microcents >= 0);
COMMENT ON COLUMN fleet_cognition_log.cost_microcents IS 'exact provider cost in USD µ¢ (provider currency)';
COMMENT ON COLUMN fleet_cognition_log.charged_microcents IS 'v21: charge to the founder in micro-minor-units of ledger_currency (GBP µp)';

CREATE OR REPLACE FUNCTION svc_cognition_authorize(p_agent text, p_estimate_cents bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; s jsonb; e jsonb; v_id uuid := gen_random_uuid();
        v_est_usd bigint := GREATEST(COALESCE(p_estimate_cents, 0), 1);   -- provider estimate, USD cents
        v_acct text; fx fleet_fx_rates; v_rate bigint; v_rate_id bigint;
        v_est bigint; v_est_micro bigint; v_unposted bigint; v_credits bigint; v_reserved bigint;
BEGIN
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR a.origin NOT IN ('genesis_founder','reseed_founder') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_NOT_FOUNDER'); END IF;
  IF a.status NOT IN ('active','unresponsive') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_AGENT_NOT_ACTIVE'); END IF;
  IF a.operator_hold_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_AGENT_HELD'); END IF;
  s := fleet_cognition_state(p_agent);
  IF s IS NULL OR (s ->> 'policyEnabled')::boolean IS NOT TRUE OR COALESCE(s ->> 'provider', 'none') = 'none' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_DISABLED'); END IF;
  IF (s ->> 'founderEnabled')::boolean IS NOT TRUE THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_FOUNDER_DISABLED'); END IF;
  IF (s ->> 'paused')::boolean IS NOT FALSE THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_PAUSED'); END IF;
  DELETE FROM fleet_cognition_inflight WHERE agent_id = p_agent AND started_at <= now() - interval '5 minutes';
  IF EXISTS (SELECT 1 FROM fleet_cognition_inflight WHERE agent_id = p_agent) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_BUSY'); END IF;
  IF (s ->> 'turnsLastHour')::integer >= (s ->> 'maxTurnsPerHour')::integer THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_RATE_LIMITED'); END IF;
  -- Controlled FX: the provider bills USD; the founder's books are in the accounting currency.
  SELECT accounting_currency INTO v_acct FROM fleet_economic_model WHERE id = 1;
  IF v_acct IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_FX_UNAVAILABLE'); END IF;
  IF v_acct = 'USD' THEN
    v_rate := 1000000; v_rate_id := NULL;
  ELSE
    fx := fleet_fx_latest('USD', v_acct);
    IF fx.rate_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_FX_UNAVAILABLE'); END IF;
    v_rate := fx.rate_micro; v_rate_id := fx.rate_id;
  END IF;
  -- The founder's reservation in its own currency, rounded up (never under-reserve).
  v_est := GREATEST(ceil(v_est_usd::numeric * v_rate / 1000000)::bigint, 1);
  v_est_micro := v_est * 1000000;
  IF (s ->> 'spentTodayMicrocents')::bigint + v_est_micro > (s ->> 'dailyBudgetCents')::bigint * 1000000 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_BUDGET_EXHAUSTED');
  END IF;
  PERFORM 1 FROM fleet_ledger_accounts WHERE account_id = fleet_ledger_account(p_agent, 'agent_cash') FOR UPDATE;
  v_unposted := (s ->> 'unpostedMicrocents')::bigint;
  e := fleet_agent_economics(p_agent);
  IF (e ->> 'cash')::bigint * 1000000 - v_unposted < v_est_micro THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INSUFFICIENT_ALLOCATION'); END IF;
  IF (e ->> 'survivalEquity')::bigint * 1000000 - v_unposted < v_est_micro THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PROTECTED_CAPITAL'); END IF;
  -- Real provider credit (USD, outside the ledger) must cover this call's USD reservation plus every other open reservation.
  PERFORM pg_advisory_xact_lock(hashtext('fleet_provider_credits:' || (s ->> 'provider')));
  v_credits := fleet_provider_credit_balance(s ->> 'provider');
  SELECT COALESCE(sum(COALESCE(estimate_usd_cents, 0)), 0) * 1000000 INTO v_reserved FROM fleet_cognition_inflight;
  IF v_credits - v_reserved < v_est_usd * 1000000 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_CREDITS_EXHAUSTED'); END IF;
  INSERT INTO fleet_cognition_inflight (agent_id, request_id, estimate_cents, estimate_usd_cents, fx_rate_id, fx_rate_micro)
    VALUES (p_agent, v_id, v_est, v_est_usd, v_rate_id, v_rate);
  RETURN jsonb_build_object('ok', true, 'requestId', v_id, 'estimateCents', v_est, 'estimateUsdCents', v_est_usd, 'currency', v_acct,
    'fxRateMicro', v_rate, 'provider', s ->> 'provider', 'model', s ->> 'model', 'maxOutputTokens', s -> 'maxOutputTokens');
END $$;

CREATE OR REPLACE FUNCTION svc_cognition_record(p_agent text, p_request uuid, p_outcome text, p_input_tokens integer, p_output_tokens integer,
  p_prompt_sha256 text, p_response_sha256 text, p_tool_calls jsonb, p_error_code text,
  p_usage_source text, p_attempts integer, p_provider_status integer, p_response_model text, p_latency_ms integer,
  p_cache_read_tokens integer, p_cache_write_tokens integer, p_provider_request_id text, p_stop_reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE i fleet_cognition_inflight; p fleet_cognition_policy; v_cost bigint; v_used_usd bigint; v_cost_l bigint; v_micro bigint; v_charge bigint; v_j uuid;
        v_unposted bigint; v_total bigint; v_rate bigint; v_acct text;
        v_ok boolean := p_outcome = 'ok';
        v_src text := CASE WHEN p_usage_source IN ('provider','estimate','none') THEN p_usage_source ELSE 'estimate' END;
        v_in bigint := GREATEST(COALESCE(p_input_tokens, 0), 0); v_out bigint := GREATEST(COALESCE(p_output_tokens, 0), 0);
        v_cr bigint := GREATEST(COALESCE(p_cache_read_tokens, 0), 0); v_cw bigint := GREATEST(COALESCE(p_cache_write_tokens, 0), 0);
BEGIN
  SELECT * INTO i FROM fleet_cognition_inflight WHERE agent_id = p_agent AND request_id = p_request FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', CASE WHEN EXISTS (SELECT 1 FROM fleet_cognition_log WHERE request_id = p_request)
      THEN 'FLEET_COGNITION_ALREADY_RECORDED' ELSE 'FLEET_COGNITION_NOT_AUTHORIZED' END);
  END IF;
  IF v_ok AND v_src = 'none' THEN v_src := 'estimate'; END IF;
  SELECT * INTO p FROM fleet_cognition_policy WHERE id = 1;
  SELECT accounting_currency INTO v_acct FROM fleet_economic_model WHERE id = 1;
  v_rate := COALESCE(i.fx_rate_micro, 1000000);
  -- Exact provider cost, USD µ¢ (provider currency).
  v_cost := CASE v_src
    WHEN 'provider' THEN v_in * p.input_microcents_per_token + v_out * p.output_microcents_per_token
                       + v_cw * COALESCE(p.cache_write_microcents_per_token, p.output_microcents_per_token)
                       + v_cr * COALESCE(p.cache_read_microcents_per_token, p.input_microcents_per_token)
    WHEN 'estimate' THEN COALESCE(i.estimate_usd_cents, i.estimate_cents) * 1000000 ELSE 0 END;
  -- USD consumed from the provider credit (actual usage; the reservation when usage is unknown).
  v_used_usd := v_cost;
  -- The founder's charge: the USD cost at the reserved controlled rate, rounded up, in µ of the ledger currency;
  -- never more than the reservation (v17 rule).
  v_cost_l := ceil(v_cost::numeric * v_rate / 1000000)::bigint;
  v_micro := CASE v_src WHEN 'provider' THEN LEAST(i.estimate_cents * 1000000, v_cost_l) WHEN 'estimate' THEN i.estimate_cents * 1000000 ELSE 0 END;
  INSERT INTO fleet_cognition_accrual (agent_id) VALUES (p_agent) ON CONFLICT (agent_id) DO NOTHING;
  SELECT unposted_microcents INTO v_unposted FROM fleet_cognition_accrual WHERE agent_id = p_agent FOR UPDATE;
  v_total := v_unposted + v_micro;
  v_charge := v_total / 1000000;
  v_unposted := v_total - v_charge * 1000000;
  IF v_charge > 0 THEN
    -- The founder's own books only: its cash becomes expense. Provider credit is USD, outside the ledger.
    v_j := fleet_ledger_post('inference_charge', 'infer:' || p_request, 'controller', 'founder inference', 'controller', p_agent, NULL, NULL, NULL, NULL, now(),
      jsonb_build_array(
        jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_expense'), 'side', 'D', 'amount', v_charge),
        jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'C', 'amount', v_charge)));
  END IF;
  UPDATE fleet_cognition_accrual SET unposted_microcents = v_unposted, updated_at = now() WHERE agent_id = p_agent;
  IF v_used_usd > 0 THEN
    INSERT INTO fleet_provider_credit_events (provider, kind, usd_microcents, request_id, recorded_by)
      VALUES (p.provider, 'consumption', -v_used_usd, p_request, 'controller');
  END IF;
  DELETE FROM fleet_cognition_inflight WHERE agent_id = p_agent;
  INSERT INTO fleet_cognition_log (request_id, agent_id, provider, model, outcome, input_tokens, output_tokens, cost_microcents, charged_cents, journal_id,
      prompt_sha256, response_sha256, tool_calls, error_code, usage_source, attempts, provider_status, response_model, latency_ms,
      cache_read_tokens, cache_write_tokens, provider_request_id, stop_reason, charged_microcents,
      ledger_currency, fx_rate_id, fx_rate_micro, provider_usd_microcents)
    VALUES (p_request, p_agent, p.provider, p.model, CASE WHEN v_ok THEN 'ok' ELSE 'error' END,
      CASE WHEN v_src = 'provider' THEN v_in ELSE 0 END, CASE WHEN v_src = 'provider' THEN v_out ELSE 0 END, v_cost, v_charge, v_j,
      p_prompt_sha256, p_response_sha256, CASE WHEN v_ok THEN COALESCE(p_tool_calls, '[]'::jsonb) ELSE '[]'::jsonb END,
      CASE WHEN v_ok THEN NULL WHEN p_error_code ~ '^[A-Z_]{2,64}$' THEN p_error_code ELSE 'PROVIDER_ERROR' END,
      v_src, LEAST(GREATEST(COALESCE(p_attempts, 1), 1), 5),
      CASE WHEN p_provider_status BETWEEN 100 AND 599 THEN p_provider_status END,
      CASE WHEN p_response_model ~ '^[A-Za-z0-9._:/@-]{1,120}$' THEN p_response_model END,
      CASE WHEN p_latency_ms BETWEEN 0 AND 3600000 THEN p_latency_ms END,
      CASE WHEN v_src = 'provider' THEN v_cr ELSE 0 END, CASE WHEN v_src = 'provider' THEN v_cw ELSE 0 END,
      CASE WHEN p_provider_request_id ~ '^[A-Za-z0-9_.:-]{1,128}$' THEN p_provider_request_id END,
      CASE WHEN p_stop_reason ~ '^[a-z_]{1,40}$' THEN p_stop_reason END, v_micro,
      v_acct, i.fx_rate_id, v_rate, v_used_usd);
  RETURN jsonb_build_object('ok', true, 'chargedCents', v_charge, 'chargedMicrocents', v_micro, 'unpostedMicrocents', v_unposted,
    'journalId', v_j, 'usageSource', v_src, 'currency', v_acct, 'fxRateMicro', v_rate, 'providerUsdMicrocents', v_used_usd);
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
