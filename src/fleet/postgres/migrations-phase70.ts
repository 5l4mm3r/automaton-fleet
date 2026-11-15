/**
 * Schema v70 — AI provider credit by funding source: owner-funded (v69, reimbursable) and treasury-funded (owner, 2026-10-12).
 *
 * Provider credit is one USD balance at the provider, bought in LOTS. Each lot has a funding source:
 *   owner     — bought by the owner (card in the provider console, including the provider's own auto-reload to that card);
 *               consumption is owed to the owner (the v69 legs on every AI charge). Off the GBP books until used.
 *   treasury  — bought with treasury money, evidenced by the treasury PayPal account's own debit (a completed GBP transaction
 *               PayPal reports; one purchase per transaction). Booked as a prepaid asset: D fleet:ai_credits / C treasury.
 * Consumption (every `consumption` provider-credit event, from any AI charge path) draws lots oldest first. A charge always
 * posts the v69 legs (owed to the owner); for the part drawn from a treasury lot, the minutely settlement reclassifies it:
 *   D fleet:owner:payable  /  C fleet:treasury:owner_reimbursable   (not owed to the owner after all)
 *   D fleet:treasury:unallocated  /  C fleet:ai_credits            (the prepaid asset is used up; the agent's cost stays in the treasury)
 * at the same controlled rate the charge used, in whole pence, never beyond what the charges have posted. The expense is
 * recognised once — by the charge; a purchase is never expensed. When a treasury lot is used up, the difference between its
 * GBP cost and what was consumed at charge rates is posted as an explicit cost settlement (FX), so the asset returns to zero.
 * A negative balance adjustment (credit used without a recorded call, or expired) draws lots too; on a treasury lot it is
 * expensed at that lot's cost. A positive adjustment is an owner lot.
 *
 * Nothing here buys credit or tops it up: purchases (and the provider's auto-reload) happen at the provider and are recorded
 * here by the owner. No automatic top-up exists.
 */
import { OWNER_PAYABLE_ACCOUNT, REIMBURSABLE_ACCOUNT } from "./migrations-phase69.js";
import { KNOWLEDGE_FOUNDATION_V1 } from "./knowledge-foundation-v1.js";
import { V69_SQL } from "./migrations-phase69.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const lit = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'`;
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
export const EVENT_ROUTES_V70 = Object.freeze({ P3_SUMMARY: ["ai_credit_treasury_purchase"] });
const EVENT_ROUTE = restateRaw(V69_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V70) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);
export const AI_CREDITS_ACCOUNT = "fleet:ai_credits";
export const AI_CREDIT_KINDS = ["ai_credit_treasury_purchase", "ai_credit_treasury_consumption", "ai_credit_cost_settlement", "ai_credit_unexplained_usage"] as const;
const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');`;
const RATE = `COALESCE((SELECT rate_micro FROM fleet_fx_rates WHERE base = 'USD' AND quote = (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1)
   ORDER BY observed_on DESC, rate_id DESC LIMIT 1), 1000000)`;


export const V70_SQL = `
INSERT INTO fleet_ledger_classes (class, kind, normal_side, scope, non_negative, description) VALUES
  ('ai_credits', 'asset', 'D', 'fleet', false, 'Prepaid AI provider credit bought with treasury money (GBP at cost; settled to zero when a lot is used up)');
INSERT INTO fleet_ledger_accounts (account_id, class, description, created_by) VALUES
  ('${AI_CREDITS_ACCOUNT}', 'ai_credits', 'Prepaid AI provider credit bought with treasury money', 'migration');
ALTER TABLE fleet_ledger_kinds DISABLE TRIGGER fleet_ledger_kinds_no_change;
INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance) VALUES
  ('ai_credit_treasury_purchase', true, ARRAY['owner'], false, 'Treasury money spent on prepaid AI provider credit (evidenced by the treasury PayPal debit)', 'internal_transfer'),
  ('ai_credit_treasury_consumption', false, ARRAY['controller'], false, 'AI credit consumed from a treasury-funded lot: not owed to the owner; the prepaid asset is used up', 'internal_transfer'),
  ('ai_credit_cost_settlement', false, ARRAY['controller'], false, 'A used-up treasury AI-credit lot: its GBP cost against consumption at charge rates (FX difference)', 'expense'),
  ('ai_credit_unexplained_usage', false, ARRAY['owner'], false, 'Treasury-funded AI credit gone without a recorded call (an adjustment, e.g. expiry): expensed at cost', 'expense');
ALTER TABLE fleet_ledger_kinds ENABLE TRIGGER fleet_ledger_kinds_no_change;
INSERT INTO fleet_ledger_rules (kind, class, side) VALUES
  ('ai_credit_treasury_purchase','ai_credits','D'), ('ai_credit_treasury_purchase','treasury_cash','C'),
  ('ai_credit_treasury_consumption','owner_payable','D'), ('ai_credit_treasury_consumption','treasury_cash','C'),
  ('ai_credit_treasury_consumption','treasury_cash','D'), ('ai_credit_treasury_consumption','ai_credits','C'),
  ('ai_credit_cost_settlement','fleet_expense','D'), ('ai_credit_cost_settlement','ai_credits','C'),
  ('ai_credit_cost_settlement','ai_credits','D'), ('ai_credit_cost_settlement','fleet_expense','C'),
  ('ai_credit_unexplained_usage','fleet_expense','D'), ('ai_credit_unexplained_usage','ai_credits','C')
ON CONFLICT DO NOTHING;

ALTER TABLE fleet_paypal_transactions DROP CONSTRAINT fleet_paypal_transactions_attributed_as_check;
ALTER TABLE fleet_paypal_transactions ADD CONSTRAINT fleet_paypal_transactions_attributed_as_check
  CHECK (attributed_as IN ('owner_funding','agent_revenue','not_revenue','provider_payout','capital_backing','ai_credit_purchase'));

CREATE TABLE fleet_ai_credit_lots (
  lot_id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text        NOT NULL CHECK (provider ~ '^[a-z0-9_-]{2,40}$'),
  source            text        NOT NULL CHECK (source IN ('owner','treasury')),
  usd_purchased     bigint      NOT NULL CHECK (usd_purchased > 0),            -- USD microcents
  usd_remaining     bigint      NOT NULL CHECK (usd_remaining >= 0),
  gbp_cost_minor    bigint      CHECK (gbp_cost_minor > 0),                    -- treasury lots only
  reclass_micro     bigint      NOT NULL DEFAULT 0 CHECK (reclass_micro >= 0), -- GBP micro-pence consumed at charge rates
  reclass_posted    bigint      NOT NULL DEFAULT 0 CHECK (reclass_posted >= 0),
  unexplained_posted bigint     NOT NULL DEFAULT 0 CHECK (unexplained_posted >= 0),
  external_ref      text        NOT NULL UNIQUE CHECK (length(external_ref) BETWEEN 3 AND 200),
  claim_key         text        UNIQUE,
  journal_id        uuid        REFERENCES fleet_ledger_journal(journal_id),
  recorded_by       text        NOT NULL,
  purchased_at      timestamptz NOT NULL DEFAULT now(),
  settled_at        timestamptz,
  settlement_journal_id uuid    REFERENCES fleet_ledger_journal(journal_id),
  CHECK (usd_remaining <= usd_purchased),
  CHECK ((source = 'treasury') = (gbp_cost_minor IS NOT NULL AND journal_id IS NOT NULL AND claim_key IS NOT NULL))
);
CREATE INDEX fleet_ai_credit_lots_open ON fleet_ai_credit_lots (provider, purchased_at) WHERE usd_remaining > 0;
CREATE TRIGGER fleet_ai_credit_lots_no_delete BEFORE DELETE ON fleet_ai_credit_lots FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_ai_credit_lots_no_truncate BEFORE TRUNCATE ON fleet_ai_credit_lots FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_ai_credit_draws (
  draw_id      bigserial   PRIMARY KEY,
  lot_id       uuid        NOT NULL REFERENCES fleet_ai_credit_lots(lot_id),
  usd          bigint      NOT NULL CHECK (usd > 0),
  gbp_micro    bigint      NOT NULL CHECK (gbp_micro >= 0),
  cause        text        NOT NULL CHECK (cause IN ('consumption','adjustment')),
  request_id   uuid,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_ai_credit_draws_no_change BEFORE UPDATE OR DELETE ON fleet_ai_credit_draws FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_ai_credit_draws_no_truncate BEFORE TRUNCATE ON fleet_ai_credit_draws FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- Opening: the credit recorded so far was bought by the owner (v69); one owner lot holds its current USD balance.
INSERT INTO fleet_ai_credit_lots (provider, source, usd_purchased, usd_remaining, external_ref, recorded_by)
  SELECT provider, 'owner', bal, bal, 'opening:v70:' || provider, 'migration'
    FROM (SELECT provider, sum(usd_microcents)::bigint AS bal FROM fleet_provider_credit_events GROUP BY provider) b WHERE bal > 0;

-- Draw USD from a provider's lots, oldest first. Owner lots need nothing more (the charge already owes it to the owner);
-- treasury lots accrue the GBP consumed at the controlled rate, settled by svc_ai_credit_settle. USD beyond every recorded
-- lot (a purchase not yet recorded) stays owner-attributed — the v69 default — until a lot is recorded.
CREATE FUNCTION fleet_ai_credit_draw(p_provider text, p_usd bigint, p_cause text, p_request uuid) RETURNS bigint LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE l fleet_ai_credit_lots; v_left bigint := p_usd; v_take bigint; v_rate bigint := ${RATE}; v_micro bigint; v_unexplained bigint := 0;
BEGIN
  FOR l IN SELECT * FROM fleet_ai_credit_lots WHERE provider = p_provider AND usd_remaining > 0 ORDER BY purchased_at, lot_id FOR UPDATE LOOP
    EXIT WHEN v_left <= 0;
    v_take := LEAST(v_left, l.usd_remaining);
    v_micro := CASE WHEN l.source = 'treasury' THEN CEIL(v_take::numeric * v_rate / 1000000)::bigint ELSE 0 END;
    UPDATE fleet_ai_credit_lots SET usd_remaining = usd_remaining - v_take,
           reclass_micro = reclass_micro + CASE WHEN p_cause = 'consumption' THEN v_micro ELSE 0 END WHERE lot_id = l.lot_id;
    IF p_cause = 'adjustment' AND l.source = 'treasury' THEN
      v_unexplained := v_unexplained + (l.gbp_cost_minor::numeric * v_take / l.usd_purchased)::bigint;
      UPDATE fleet_ai_credit_lots SET unexplained_posted = unexplained_posted + (l.gbp_cost_minor::numeric * v_take / l.usd_purchased)::bigint WHERE lot_id = l.lot_id;
    END IF;
    INSERT INTO fleet_ai_credit_draws (lot_id, usd, gbp_micro, cause, request_id) VALUES (l.lot_id, v_take, v_micro, p_cause, p_request);
    v_left := v_left - v_take;
  END LOOP;
  RETURN v_unexplained;
END $$;

CREATE FUNCTION fleet_ai_credit_events_trigger() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_unexplained bigint;
BEGIN
  IF NEW.kind = 'consumption' AND NEW.usd_microcents < 0 THEN
    PERFORM fleet_ai_credit_draw(NEW.provider, -NEW.usd_microcents, 'consumption', NEW.request_id);
  ELSIF NEW.kind = 'purchase' AND NEW.usd_microcents > 0
        AND NOT EXISTS (SELECT 1 FROM fleet_ai_credit_lots WHERE external_ref = COALESCE(NEW.external_ref, '')) THEN
    -- recorded by the owner (provider-credits-record): bought with the owner's own payment method
    INSERT INTO fleet_ai_credit_lots (provider, source, usd_purchased, usd_remaining, external_ref, recorded_by)
      VALUES (NEW.provider, 'owner', NEW.usd_microcents, NEW.usd_microcents, COALESCE(NEW.external_ref, 'event:' || gen_random_uuid()), NEW.recorded_by);
  ELSIF NEW.kind = 'adjustment' AND NEW.usd_microcents > 0 THEN
    INSERT INTO fleet_ai_credit_lots (provider, source, usd_purchased, usd_remaining, external_ref, recorded_by)
      VALUES (NEW.provider, 'owner', NEW.usd_microcents, NEW.usd_microcents, COALESCE(NEW.external_ref, 'adjustment') || ':' || gen_random_uuid(), NEW.recorded_by);
  ELSIF NEW.kind = 'adjustment' AND NEW.usd_microcents < 0 THEN
    v_unexplained := fleet_ai_credit_draw(NEW.provider, -NEW.usd_microcents, 'adjustment', NULL);
    IF v_unexplained > 0 THEN
      PERFORM fleet_ledger_post('ai_credit_unexplained_usage', 'ai-credit-adjustment:' || gen_random_uuid(), NEW.recorded_by,
        'treasury-funded AI credit gone without a recorded call (balance adjustment)', 'owner', NULL, NULL, NULL, NULL, NULL, now(), jsonb_build_array(
          jsonb_build_object('account', 'fleet:expense', 'side', 'D', 'amount', v_unexplained),
          jsonb_build_object('account', '${AI_CREDITS_ACCOUNT}', 'side', 'C', 'amount', v_unexplained)));
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER fleet_ai_credit_events AFTER INSERT ON fleet_provider_credit_events FOR EACH ROW EXECUTE FUNCTION fleet_ai_credit_events_trigger();

-- Owner: a purchase of AI provider credit paid with treasury money, evidenced by the treasury PayPal account's completed GBP
-- debit. Books the prepaid asset; records the USD purchase; closes the PayPal transaction. One purchase per transaction.
CREATE FUNCTION fleet_admin_ai_credit_treasury_purchase(p_provider text, p_usd_cents bigint, p_rail uuid, p_txn text, p_event_code text,
    p_receipt text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t fleet_paypal_transactions; v_gbp bigint; v_key text; v_j uuid; v_lot uuid; v_ccy text;
BEGIN
  ${OWNER_ACTOR}
  IF p_provider IS NULL OR p_provider !~ '^[a-z0-9_-]{2,40}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: provider'; END IF;
  IF p_usd_cents IS NULL OR p_usd_cents <= 0 OR p_usd_cents > 10000000 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: positive USD cents'; END IF;
  IF p_receipt IS NULL OR length(p_receipt) < 3 OR length(p_receipt) > 120 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the provider receipt reference'; END IF;
  SELECT * INTO t FROM fleet_paypal_transactions WHERE rail_id = p_rail AND transaction_id = p_txn AND event_code = p_event_code
   ORDER BY initiated_at DESC LIMIT 1 FOR UPDATE;
  IF t.transaction_id IS NULL THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no PayPal transaction with that key (the treasury debit is the evidence)'; END IF;
  IF t.checkout_id IS NOT NULL OR t.attributed_at IS NOT NULL THEN RAISE EXCEPTION 'FLEET_ALREADY_CLAIMED: that transaction is already accounted for'; END IF;
  IF t.status <> 'S' THEN RAISE EXCEPTION 'FLEET_NOT_SETTLED: PayPal shows that transaction as %', t.status; END IF;
  SELECT accounting_currency INTO v_ccy FROM fleet_economic_model WHERE id = 1;
  IF t.currency <> v_ccy THEN RAISE EXCEPTION 'FLEET_FX_REQUIRED: the debit is in %, the books in %', t.currency, v_ccy; END IF;
  v_gbp := -(t.amount_minor + t.fee_minor);
  IF t.amount_minor >= 0 OR v_gbp <= 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a purchase is money leaving the treasury (a debit)'; END IF;
  v_key := 'paypal:txn:' || t.transaction_id;
  IF fleet_claim_taken(v_key) OR EXISTS (SELECT 1 FROM fleet_ledger_journal WHERE external_ref = v_key) THEN RAISE EXCEPTION 'FLEET_ALREADY_CLAIMED: %', v_key; END IF;
  IF EXISTS (SELECT 1 FROM fleet_ai_credit_lots WHERE external_ref = 'receipt:' || p_provider || ':' || p_receipt) THEN
    RAISE EXCEPTION 'FLEET_ALREADY_CLAIMED: that provider receipt is already recorded';
  END IF;
  IF fleet_ledger_balance('fleet:treasury:unallocated') < v_gbp THEN
    RAISE EXCEPTION 'FLEET_TREASURY_INSUFFICIENT: the treasury holds % unallocated', fleet_ledger_balance('fleet:treasury:unallocated');
  END IF;
  v_j := fleet_ledger_post('ai_credit_treasury_purchase', 'ai-credit:' || v_key, p_actor, 'AI provider credit bought with treasury money', 'owner',
    NULL, NULL, NULL, v_key, NULL, now(), jsonb_build_array(
      jsonb_build_object('account', '${AI_CREDITS_ACCOUNT}', 'side', 'D', 'amount', v_gbp),
      jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', v_gbp)));
  INSERT INTO fleet_ai_credit_lots (provider, source, usd_purchased, usd_remaining, gbp_cost_minor, external_ref, claim_key, journal_id, recorded_by)
    VALUES (p_provider, 'treasury', p_usd_cents * 1000000, p_usd_cents * 1000000, v_gbp, 'receipt:' || p_provider || ':' || p_receipt, v_key, v_j, p_actor)
    RETURNING lot_id INTO v_lot;
  INSERT INTO fleet_provider_credit_events (provider, kind, usd_microcents, external_ref, recorded_by)
    VALUES (p_provider, 'purchase', p_usd_cents * 1000000, 'receipt:' || p_provider || ':' || p_receipt, p_actor);
  UPDATE fleet_paypal_transactions SET attributed_as = 'ai_credit_purchase', attributed_ref = v_key, attributed_by = p_actor, attributed_at = now(), updated_at = now()
   WHERE rail_id = t.rail_id AND transaction_id = t.transaction_id AND event_code = t.event_code AND initiated_at = t.initiated_at;
  PERFORM fleet_event('ai_credit_treasury_purchase', NULL, p_actor, jsonb_build_object('lotId', v_lot, 'provider', p_provider, 'usdCents', p_usd_cents, 'gbpMinor', v_gbp));
  RETURN jsonb_build_object('ok', true, 'lotId', v_lot, 'journalId', v_j, 'gbpMinor', v_gbp, 'usdCents', p_usd_cents);
END $$;

-- Minutely (lifecycle pass): reclassify the AI cost drawn from treasury lots out of the owner payable, in whole pence, never
-- beyond what the charges have posted; settle a used-up lot's cost difference so the asset returns to zero.
CREATE FUNCTION svc_ai_credit_settle(p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE l fleet_ai_credit_lots; v_post bigint; v_room bigint; v_posted bigint := 0; v_settled integer := 0; v_residual bigint; v_j uuid;
BEGIN
  FOR l IN SELECT * FROM fleet_ai_credit_lots WHERE source = 'treasury' AND settled_at IS NULL ORDER BY purchased_at
           LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100) FOR UPDATE SKIP LOCKED LOOP
    v_post := l.reclass_micro / 1000000 - l.reclass_posted;
    v_room := LEAST(fleet_ledger_balance('${OWNER_PAYABLE_ACCOUNT}'), fleet_ledger_balance('${REIMBURSABLE_ACCOUNT}'));
    v_post := LEAST(v_post, v_room);
    IF v_post > 0 THEN
      PERFORM fleet_ledger_post('ai_credit_treasury_consumption', 'ai-credit-consumption:' || l.lot_id || ':' || (l.reclass_posted + v_post), 'controller',
        'AI credit consumed from a treasury-funded lot', 'controller', NULL, NULL, NULL, NULL, NULL, now(), jsonb_build_array(
          jsonb_build_object('account', '${OWNER_PAYABLE_ACCOUNT}', 'side', 'D', 'amount', v_post),
          jsonb_build_object('account', '${REIMBURSABLE_ACCOUNT}', 'side', 'C', 'amount', v_post),
          jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', v_post),
          jsonb_build_object('account', '${AI_CREDITS_ACCOUNT}', 'side', 'C', 'amount', v_post)));
      UPDATE fleet_ai_credit_lots SET reclass_posted = reclass_posted + v_post WHERE lot_id = l.lot_id;
      v_posted := v_posted + v_post;
      l.reclass_posted := l.reclass_posted + v_post;
    END IF;
    -- Used up and fully reclassified: the cost difference (FX between purchase and use) is posted explicitly.
    IF l.usd_remaining = 0 AND l.reclass_posted >= l.reclass_micro / 1000000 THEN
      v_residual := l.gbp_cost_minor - l.reclass_posted - l.unexplained_posted;
      IF v_residual <> 0 THEN
        v_j := fleet_ledger_post('ai_credit_cost_settlement', 'ai-credit-settlement:' || l.lot_id, 'controller',
          'used-up treasury AI-credit lot: cost against consumption at charge rates', 'controller', NULL, NULL, NULL, NULL, NULL, now(),
          CASE WHEN v_residual > 0 THEN jsonb_build_array(
                 jsonb_build_object('account', 'fleet:expense', 'side', 'D', 'amount', v_residual),
                 jsonb_build_object('account', '${AI_CREDITS_ACCOUNT}', 'side', 'C', 'amount', v_residual))
               ELSE jsonb_build_array(
                 jsonb_build_object('account', '${AI_CREDITS_ACCOUNT}', 'side', 'D', 'amount', -v_residual),
                 jsonb_build_object('account', 'fleet:expense', 'side', 'C', 'amount', -v_residual)) END);
      END IF;
      UPDATE fleet_ai_credit_lots SET settled_at = now(), settlement_journal_id = v_j WHERE lot_id = l.lot_id;
      v_settled := v_settled + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'reclassifiedMinor', v_posted, 'lotsSettled', v_settled);
END $$;

CREATE FUNCTION fleet_ai_credit_status() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'providerBalanceUsdMicrocents', (SELECT jsonb_object_agg(provider, bal) FROM (SELECT provider, sum(usd_microcents) AS bal FROM fleet_provider_credit_events GROUP BY 1) b),
    'remainingBySourceUsdMicrocents', (SELECT jsonb_object_agg(source, r) FROM (SELECT source, sum(usd_remaining) AS r FROM fleet_ai_credit_lots GROUP BY 1) x),
    'treasuryCreditAssetMinor', fleet_ledger_balance('${AI_CREDITS_ACCOUNT}'),
    'ownerPayableMinor', fleet_ledger_balance('${OWNER_PAYABLE_ACCOUNT}'),
    'unreclassifiedMicro', (SELECT COALESCE(sum(reclass_micro - reclass_posted * 1000000), 0) FROM fleet_ai_credit_lots WHERE source = 'treasury'),
    'lots', COALESCE((SELECT jsonb_agg(jsonb_build_object('lotId', lot_id, 'provider', provider, 'source', source, 'usdPurchased', usd_purchased,
        'usdRemaining', usd_remaining, 'gbpCostMinor', gbp_cost_minor, 'reclassPostedMinor', reclass_posted, 'purchasedAt', purchased_at, 'settledAt', settled_at)
        ORDER BY purchased_at) FROM fleet_ai_credit_lots), '[]'::jsonb),
    'note', 'Owner-funded credit is owed to the owner as it is used; treasury-funded credit is a prepaid asset used up oldest first. Purchases and the provider''s auto-reload are recorded by the owner; nothing tops up automatically.')
$$;

${EVENT_ROUTE}

-- The dated capability entry, version 2 (agents now on the event-waking runtime; AI credit funding).
SELECT fleet_admin_knowledge_library_load(${lit({ entries: KNOWLEDGE_FOUNDATION_V1.entries.filter((e) => e.id === "fleet-capability-status") })}::jsonb, 'migration');

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
