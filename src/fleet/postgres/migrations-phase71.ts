/**
 * Schema v71 — automatic detection and accounting of AI-credit purchases (owner, 2026-10-12).
 *
 * The provider (Anthropic) exposes no interface for its credit balance, purchases or auto-reloads: its Admin API reports
 * usage and cost only (and is unavailable to individual accounts). Purchases are therefore detected from the two signals
 * the Fleet already receives:
 *   1. the provider's purchase RECEIPT e-mailed to a Fleet mailbox (the Console's billing address set to it) — gives the
 *      USD amount and the receipt number; one purchase per receipt number. A receipt is unauthenticated text: it can only
 *      ever create OWNER-funded credit (no money in the books moves on it);
 *   2. the treasury PayPal account's own DEBIT, read hourly from PayPal Transaction Search with its counterparty — the only
 *      evidence that treasury money paid; it alone creates TREASURY-funded credit (a prepaid asset).
 * The owner's policy per provider names the funding route:
 *   owner_card       — purchases (incl. the provider's auto-reload) are charged to the owner's own card: each receipt is
 *                      owner-funded credit, owed to the owner as it is used (v69). Fully automatic; settling the payable
 *                      (reimbursement) is a separate, authorised step.
 *   treasury_paypal  — purchases are paid from the treasury PayPal balance (directly, or by a card drawing on it): a receipt
 *                      waits for its matching debit (counterparty pattern, within the window, implied rate within the
 *                      tolerance of the controlled rate); matched → the lot becomes treasury-funded (asset at the debit's
 *                      GBP; consumption already drawn is reclassified). A debit with no receipt after the window becomes a
 *                      treasury lot with its USD estimated at the controlled rate (flagged). A receipt with no debit after
 *                      the window stays owner-funded and raises P1 for the owner (fleet_admin_ai_credit_attribute resolves it).
 * Nothing buys or tops up credit: purchasing (manual or the provider's auto-reload) happens at the provider.
 */
import { V70_SQL } from "./migrations-phase70.js";
import { OWNER_PAYABLE_ACCOUNT, REIMBURSABLE_ACCOUNT } from "./migrations-phase69.js";
import { AI_CREDITS_ACCOUNT } from "./migrations-phase70.js";
import { KNOWLEDGE_FOUNDATION_V1 } from "./knowledge-foundation-v1.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const lit = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'`;
export const AI_CREDIT_ROUTES = ["owner_card", "treasury_paypal"] as const;
export const EVENT_ROUTES_V71 = Object.freeze({
  P1_HIGH: ["ai_credit_evidence_missing"],
  P2_IMPORTANT: ["ai_credit_receipt_unparsed", "ai_credit_treasury_insufficient"],
  P3_SUMMARY: ["ai_credit_purchase_detected", "ai_credit_policy_set"],
});
const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');`;
const WORKER = `IF p_worker IS NULL OR p_worker !~ '^[a-z0-9-]{3,40}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: worker name'; END IF;`;
const RATE = `COALESCE((SELECT rate_micro FROM fleet_fx_rates WHERE base = 'USD' AND quote = (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1)
   ORDER BY observed_on DESC, rate_id DESC LIMIT 1), 1000000)`;

// Every draw records its GBP value at the controlled rate (so an owner-funded lot later shown to be treasury-paid can be
// reclassified exactly); only treasury lots accrue reclassification.
const DRAW = restateRaw(V70_SQL, "fleet_ai_credit_draw", [
  [`    v_micro := CASE WHEN l.source = 'treasury' THEN CEIL(v_take::numeric * v_rate / 1000000)::bigint ELSE 0 END;
    UPDATE fleet_ai_credit_lots SET usd_remaining = usd_remaining - v_take,
           reclass_micro = reclass_micro + CASE WHEN p_cause = 'consumption' THEN v_micro ELSE 0 END WHERE lot_id = l.lot_id;`,
   `    v_micro := CEIL(v_take::numeric * v_rate / 1000000)::bigint;
    UPDATE fleet_ai_credit_lots SET usd_remaining = usd_remaining - v_take,
           reclass_micro = reclass_micro + CASE WHEN p_cause = 'consumption' AND l.source = 'treasury' THEN v_micro ELSE 0 END WHERE lot_id = l.lot_id;`],
]);

// The lifecycle pass also detects and matches purchases before settling.
const SETTLE = restateRaw(V70_SQL, "svc_ai_credit_settle", [
  [`DECLARE l fleet_ai_credit_lots; v_post bigint;`, `DECLARE v_detect jsonb; l fleet_ai_credit_lots; v_post bigint;`],
  [`BEGIN
  FOR l IN SELECT * FROM fleet_ai_credit_lots WHERE source = 'treasury' AND settled_at IS NULL`,
   `BEGIN
  v_detect := fleet_ai_credit_match();
  FOR l IN SELECT * FROM fleet_ai_credit_lots WHERE source = 'treasury' AND settled_at IS NULL`],
  [`  RETURN jsonb_build_object('ok', true, 'reclassifiedMinor', v_posted, 'lotsSettled', v_settled);`,
   `  RETURN jsonb_build_object('ok', true, 'reclassifiedMinor', v_posted, 'lotsSettled', v_settled, 'detection', v_detect);`],
]);

export const V71_SQL = `
CREATE TABLE fleet_ai_credit_policy (
  provider              text        PRIMARY KEY CHECK (provider ~ '^[a-z0-9_-]{2,40}$'),
  funding_route         text        NOT NULL CHECK (funding_route IN (${q(AI_CREDIT_ROUTES)})),
  receipt_sender        text        CHECK (receipt_sender ~ '^[a-z0-9._%+@-]{3,120}$'),      -- an address or '@domain', lower case
  counterparty_pattern  text        CHECK (length(counterparty_pattern) BETWEEN 3 AND 80),  -- substring of the PayPal counterparty
  match_window_hours    integer     NOT NULL DEFAULT 72 CHECK (match_window_hours BETWEEN 1 AND 720),
  rate_tolerance_bp     integer     NOT NULL DEFAULT 800 CHECK (rate_tolerance_bp BETWEEN 50 AND 3000),
  auto_reload_threshold_usd_cents bigint CHECK (auto_reload_threshold_usd_cents > 0),         -- the owner's declaration (information)
  auto_reload_to_usd_cents        bigint CHECK (auto_reload_to_usd_cents > 0),
  enabled               boolean     NOT NULL DEFAULT true,
  set_by                text        NOT NULL,
  set_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (funding_route <> 'treasury_paypal' OR counterparty_pattern IS NOT NULL)
);
CREATE TABLE fleet_ai_credit_policy_history (
  seq bigserial PRIMARY KEY, provider text NOT NULL, policy jsonb NOT NULL, set_by text NOT NULL, set_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_ai_credit_policy_history_no_change BEFORE UPDATE OR DELETE ON fleet_ai_credit_policy_history FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

ALTER TABLE fleet_paypal_transactions ADD COLUMN counterparty text CHECK (length(counterparty) <= 200);
ALTER TABLE fleet_ai_credit_lots
  ADD COLUMN receipt_message_id uuid,
  ADD COLUMN awaiting_debit_until timestamptz,
  ADD COLUMN usd_estimated boolean NOT NULL DEFAULT false;

-- Custody: the counterparty PayPal reports for a transaction (names / e-mail / subject; scrubbed and bounded).
CREATE FUNCTION cx_paypal_txn_counterparty(p_worker text, p_rail uuid, p_txn text, p_event_code text, p_counterparty text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  ${WORKER}
  UPDATE fleet_paypal_transactions SET counterparty = left(regexp_replace(COALESCE(p_counterparty, ''), '[[:cntrl:]]', ' ', 'g'), 200), updated_at = now()
   WHERE rail_id = p_rail AND transaction_id = p_txn AND event_code = p_event_code AND counterparty IS DISTINCT FROM left(p_counterparty, 200);
  RETURN jsonb_build_object('ok', true);
END $$;

-- Owner: the funding route and detection settings for a provider (the owner's authorisation of how credit is bought).
CREATE FUNCTION fleet_admin_ai_credit_policy_set(p_provider text, p_route text, p_receipt_sender text, p_counterparty text,
    p_threshold_usd_cents bigint, p_reload_to_usd_cents bigint, p_enabled boolean, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_ai_credit_policy;
BEGIN
  ${OWNER_ACTOR}
  IF p_route IS NULL OR p_route NOT IN (${q(AI_CREDIT_ROUTES)}) THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: route is owner_card or treasury_paypal'; END IF;
  INSERT INTO fleet_ai_credit_policy (provider, funding_route, receipt_sender, counterparty_pattern, auto_reload_threshold_usd_cents, auto_reload_to_usd_cents, enabled, set_by)
    VALUES (p_provider, p_route, lower(p_receipt_sender), p_counterparty, p_threshold_usd_cents, p_reload_to_usd_cents, COALESCE(p_enabled, true), p_actor)
  ON CONFLICT (provider) DO UPDATE SET funding_route = EXCLUDED.funding_route, receipt_sender = EXCLUDED.receipt_sender,
    counterparty_pattern = EXCLUDED.counterparty_pattern, auto_reload_threshold_usd_cents = EXCLUDED.auto_reload_threshold_usd_cents,
    auto_reload_to_usd_cents = EXCLUDED.auto_reload_to_usd_cents, enabled = EXCLUDED.enabled, set_by = EXCLUDED.set_by, set_at = now()
  RETURNING * INTO r;
  INSERT INTO fleet_ai_credit_policy_history (provider, policy, set_by) VALUES (p_provider, to_jsonb(r), p_actor);
  PERFORM fleet_event('ai_credit_policy_set', NULL, p_actor, jsonb_build_object('provider', p_provider, 'route', p_route, 'enabled', r.enabled));
  RETURN jsonb_build_object('ok', true, 'policy', to_jsonb(r));
END $$;

-- A provider receipt in a Fleet mailbox: parsed conservatively; one purchase per receipt number; owner-funded until (on the
-- treasury route) a matching treasury debit is found. Unparseable receipts are reported, never guessed.
CREATE FUNCTION fleet_ai_credit_receipt_trigger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_ai_credit_policy; v_from text := lower(COALESCE(NEW.sender_address, NEW.sender, '')); v_amt text; v_no text; v_usd bigint; v_ref text;
BEGIN
  IF NEW.direction <> 'in' THEN RETURN NULL; END IF;
  FOR p IN SELECT * FROM fleet_ai_credit_policy WHERE enabled AND receipt_sender IS NOT NULL LOOP
    CONTINUE WHEN NOT (CASE WHEN left(p.receipt_sender, 1) = '@' THEN v_from LIKE '%' || p.receipt_sender || '%' ELSE position(p.receipt_sender IN v_from) > 0 END);
    CONTINUE WHEN NOT (NEW.subject ~* '(receipt|invoice|payment)');
    v_no := substring(NEW.subject || ' ' || NEW.body FROM '(?i)(?:receipt|invoice)\\s*(?:number|no\\.?|#)\\s*[:#]?\\s*([A-Z0-9][A-Z0-9-]{3,39})');
    v_amt := substring(NEW.body FROM '(?i)(?:amount paid|total|amount)[^$0-9]{0,40}\\$\\s?([0-9]{1,6}(?:,[0-9]{3})*\\.[0-9]{2})');
    IF v_no IS NULL OR v_amt IS NULL THEN
      PERFORM fleet_event('ai_credit_receipt_unparsed', NULL, 'identity', jsonb_build_object('provider', p.provider, 'messageId', NEW.message_id,
        'note', 'a mail from the provider''s receipt sender could not be read as a purchase: record it with provider-credits-record if it is one'));
      CONTINUE;
    END IF;
    v_usd := (replace(v_amt, ',', '')::numeric * 100)::bigint;
    v_ref := 'receipt:' || p.provider || ':' || upper(v_no);
    CONTINUE WHEN EXISTS (SELECT 1 FROM fleet_ai_credit_lots WHERE external_ref = v_ref) OR v_usd <= 0 OR v_usd > 10000000;
    INSERT INTO fleet_provider_credit_events (provider, kind, usd_microcents, external_ref, recorded_by)
      VALUES (p.provider, 'purchase', v_usd * 1000000, v_ref, 'identity:receipt');
    UPDATE fleet_ai_credit_lots SET receipt_message_id = NEW.message_id,
           awaiting_debit_until = CASE WHEN p.funding_route = 'treasury_paypal' THEN now() + make_interval(hours => p.match_window_hours) END
     WHERE external_ref = v_ref;
    PERFORM fleet_event('ai_credit_purchase_detected', NULL, 'identity', jsonb_build_object('provider', p.provider, 'receipt', upper(v_no),
      'usdCents', v_usd, 'route', p.funding_route, 'source', 'receipt'));
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER fleet_ai_credit_receipts AFTER INSERT ON fleet_agent_mail FOR EACH ROW EXECUTE FUNCTION fleet_ai_credit_receipt_trigger();

-- Turn a lot into treasury-funded credit with a treasury debit as evidence (used by the matcher and by the owner).
CREATE FUNCTION fleet_ai_credit_lot_to_treasury(p_lot uuid, t fleet_paypal_transactions, p_actor text, p_source text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE l fleet_ai_credit_lots; v_gbp bigint := -(t.amount_minor + t.fee_minor); v_key text := 'paypal:txn:' || t.transaction_id; v_j uuid; v_drawn bigint;
BEGIN
  SELECT * INTO l FROM fleet_ai_credit_lots WHERE lot_id = p_lot FOR UPDATE;
  IF l.source <> 'owner' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ALREADY_CLAIMED'); END IF;
  IF fleet_claim_taken(v_key) OR EXISTS (SELECT 1 FROM fleet_ledger_journal WHERE external_ref = v_key) OR EXISTS (SELECT 1 FROM fleet_ai_credit_lots WHERE claim_key = v_key) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ALREADY_CLAIMED');
  END IF;
  IF fleet_ledger_balance('fleet:treasury:unallocated') < v_gbp THEN
    PERFORM fleet_event('ai_credit_treasury_insufficient', NULL, 'controller', jsonb_build_object('lotId', p_lot, 'gbpMinor', v_gbp, 'transactionId', t.transaction_id));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_TREASURY_INSUFFICIENT');
  END IF;
  v_j := fleet_ledger_post('ai_credit_treasury_purchase', 'ai-credit:' || v_key, p_actor, 'AI provider credit bought with treasury money', p_source,
    NULL, NULL, NULL, v_key, NULL, now(), jsonb_build_array(
      jsonb_build_object('account', '${AI_CREDITS_ACCOUNT}', 'side', 'D', 'amount', v_gbp),
      jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', v_gbp)));
  -- consumption already drawn from this lot (owed to the owner so far) is reclassified at the rates it was charged at
  SELECT COALESCE(sum(gbp_micro), 0) INTO v_drawn FROM fleet_ai_credit_draws WHERE lot_id = p_lot AND cause = 'consumption';
  UPDATE fleet_ai_credit_lots SET source = 'treasury', gbp_cost_minor = v_gbp, claim_key = v_key, journal_id = v_j, reclass_micro = v_drawn,
         awaiting_debit_until = NULL WHERE lot_id = p_lot;
  UPDATE fleet_paypal_transactions SET attributed_as = 'ai_credit_purchase', attributed_ref = v_key, attributed_by = p_actor, attributed_at = now(), updated_at = now()
   WHERE rail_id = t.rail_id AND transaction_id = t.transaction_id AND event_code = t.event_code AND initiated_at = t.initiated_at;
  RETURN jsonb_build_object('ok', true, 'lotId', p_lot, 'journalId', v_j, 'gbpMinor', v_gbp);
END $$;
ALTER TABLE fleet_ledger_kinds DISABLE TRIGGER fleet_ledger_kinds_no_change;
UPDATE fleet_ledger_kinds SET allowed_sources = ARRAY['owner','controller'] WHERE kind = 'ai_credit_treasury_purchase';
ALTER TABLE fleet_ledger_kinds ENABLE TRIGGER fleet_ledger_kinds_no_change;

-- Match receipts waiting on the treasury route with treasury debits; time out the ones without; turn unexplained matching
-- debits into estimated treasury lots. Idempotent; called by the minutely settlement.
CREATE FUNCTION fleet_ai_credit_match() RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_ai_credit_policy; l fleet_ai_credit_lots; t fleet_paypal_transactions; v_rate bigint := ${RATE}; r jsonb;
        v_matched integer := 0; v_expired integer := 0; v_estimated integer := 0; v_lot uuid; v_ccy text;
BEGIN
  SELECT accounting_currency INTO v_ccy FROM fleet_economic_model WHERE id = 1;
  FOR p IN SELECT * FROM fleet_ai_credit_policy WHERE enabled AND funding_route = 'treasury_paypal' LOOP
    -- 1. receipts waiting for their debit
    FOR l IN SELECT * FROM fleet_ai_credit_lots WHERE provider = p.provider AND source = 'owner' AND awaiting_debit_until IS NOT NULL ORDER BY purchased_at LOOP
      SELECT x.* INTO t FROM fleet_paypal_transactions x
       WHERE x.status = 'S' AND x.currency = v_ccy AND x.amount_minor < 0 AND x.attributed_at IS NULL AND x.checkout_id IS NULL
         AND position(lower(p.counterparty_pattern) IN lower(COALESCE(x.counterparty, ''))) > 0
         AND x.initiated_at BETWEEN l.purchased_at - make_interval(hours => p.match_window_hours) AND l.purchased_at + make_interval(hours => p.match_window_hours)
         AND abs((-(x.amount_minor + x.fee_minor))::numeric * 1000000000000 / l.usd_purchased - v_rate)   -- implied rate (GBP per USD × 10⁶) vs the controlled rate
             <= v_rate::numeric * p.rate_tolerance_bp / 10000
       ORDER BY abs(extract(epoch FROM x.initiated_at - l.purchased_at)) LIMIT 1;
      IF t.transaction_id IS NOT NULL THEN
        r := fleet_ai_credit_lot_to_treasury(l.lot_id, t, 'controller', 'controller');
        IF (r ->> 'ok')::boolean THEN v_matched := v_matched + 1; END IF;
      ELSIF l.awaiting_debit_until < now() THEN
        UPDATE fleet_ai_credit_lots SET awaiting_debit_until = NULL WHERE lot_id = l.lot_id;
        PERFORM fleet_event('ai_credit_evidence_missing', NULL, 'controller', jsonb_build_object('lotId', l.lot_id, 'provider', p.provider,
          'usdMicrocents', l.usd_purchased, 'note', 'no matching treasury debit: this purchase stays owner-funded (owed to you as used). If the treasury paid it, attribute the debit (economy-ai-credit-attribute).'));
        v_expired := v_expired + 1;
      END IF;
    END LOOP;
    -- 2. matching treasury debits with no receipt after the window: treasury credit with USD estimated at the controlled rate
    FOR t IN SELECT x.* FROM fleet_paypal_transactions x
              WHERE x.status = 'S' AND x.currency = v_ccy AND x.amount_minor < 0 AND x.attributed_at IS NULL AND x.checkout_id IS NULL
                AND position(lower(p.counterparty_pattern) IN lower(COALESCE(x.counterparty, ''))) > 0
                AND x.initiated_at < now() - make_interval(hours => p.match_window_hours) LIMIT 20 LOOP
      INSERT INTO fleet_ai_credit_lots (provider, source, usd_purchased, usd_remaining, external_ref, recorded_by, usd_estimated)
        VALUES (p.provider, 'owner', GREATEST(CEIL((-(t.amount_minor + t.fee_minor))::numeric * 1000000000000 / v_rate)::bigint, 1),
                GREATEST(CEIL((-(t.amount_minor + t.fee_minor))::numeric * 1000000000000 / v_rate)::bigint, 1), 'debit:' || t.transaction_id, 'controller', true)
        RETURNING lot_id INTO v_lot;
      INSERT INTO fleet_provider_credit_events (provider, kind, usd_microcents, external_ref, recorded_by)
        SELECT p.provider, 'purchase', usd_purchased, 'debit:' || t.transaction_id, 'controller:estimated' FROM fleet_ai_credit_lots WHERE lot_id = v_lot;
      r := fleet_ai_credit_lot_to_treasury(v_lot, t, 'controller', 'controller');
      IF (r ->> 'ok')::boolean THEN v_estimated := v_estimated + 1; END IF;
    END LOOP;
  END LOOP;
  RETURN jsonb_build_object('matched', v_matched, 'expired', v_expired, 'estimated', v_estimated);
END $$;

-- Owner: this treasury debit paid for that purchase (resolves a missing-evidence alert or an unmatched debit).
CREATE FUNCTION fleet_admin_ai_credit_attribute(p_lot uuid, p_rail uuid, p_txn text, p_event_code text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t fleet_paypal_transactions; v_ccy text;
BEGIN
  ${OWNER_ACTOR}
  SELECT * INTO t FROM fleet_paypal_transactions WHERE rail_id = p_rail AND transaction_id = p_txn AND event_code = p_event_code ORDER BY initiated_at DESC LIMIT 1 FOR UPDATE;
  IF t.transaction_id IS NULL THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no PayPal transaction with that key'; END IF;
  SELECT accounting_currency INTO v_ccy FROM fleet_economic_model WHERE id = 1;
  IF t.status <> 'S' OR t.currency <> v_ccy OR t.amount_minor >= 0 OR t.attributed_at IS NOT NULL OR t.checkout_id IS NOT NULL THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: a completed, unattributed treasury debit in % is required', v_ccy;
  END IF;
  RETURN fleet_ai_credit_lot_to_treasury(p_lot, t, p_actor, 'owner');
END $$;

${DRAW}

${SETTLE}

${restateRaw(V70_SQL, "fleet_ai_credit_status", [
  [`    'note', 'Owner-funded credit is owed`, `    'policy', (SELECT jsonb_object_agg(provider, to_jsonb(p) - 'provider') FROM fleet_ai_credit_policy p),
    'awaitingDebit', (SELECT count(*) FROM fleet_ai_credit_lots WHERE awaiting_debit_until IS NOT NULL),
    'estimatedLots', (SELECT count(*) FROM fleet_ai_credit_lots WHERE usd_estimated),
    'note', 'Owner-funded credit is owed`],
])}

${restateRaw(V70_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V71) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
])}

-- The dated capability entry, version 3 (AI cost attribution corrected: owner conversations are paid by the treasury).
SELECT fleet_admin_knowledge_library_load(${lit({ entries: KNOWLEDGE_FOUNDATION_V1.entries.filter((e) => e.id === "fleet-capability-status") })}::jsonb, 'migration');

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
void OWNER_PAYABLE_ACCOUNT; void REIMBURSABLE_ACCOUNT;
