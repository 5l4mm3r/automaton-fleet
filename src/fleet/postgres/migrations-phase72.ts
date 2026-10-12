/**
 * Schema v72 — the full, unrecoverable acquisition cost of AI credit, allocated by consumption (owner option (a), 2026-10-12).
 *
 * Provider prices are before tax; buying credit also costs tax (and any fees) the Fleet cannot reclaim. Each lot carries its
 * acquisition cost from evidence — the receipt's total against the credit bought (`acq_total_usd_cents` / `usd_purchased`);
 * no rate is assumed: a lot without such evidence adds nothing until the owner records it (`fleet_admin_ai_credit_lot_cost`).
 * The minutely settlement prices every consumption draw's share of that extra cost (its GBP value × (total − credit) /
 * credit) and posts it, in whole pence, to whoever made the call:
 *   autonomous agent work      → D agent expense / C agent cash   (the responsible agent)
 *   owner conversation turns,
 *   Fleet Control reviews      → D Fleet expense / C treasury     (overhead)
 * with the funding side of the lot it came from:
 *   owner-funded lot   → D treasury owner-reimbursable / C owner payable   (the owner paid that tax: owed to the owner)
 *   treasury-funded    → D treasury unallocated / C prepaid AI credit      (the asset's tax part is used up)
 * so the cost is recognised once (charge = credit price; this = the tax/fees on it) and a treasury lot's cost settlement is
 * left with the exchange-rate difference only.
 *
 * `fleet_admin_ai_credit_balance_reconcile` reconciles the recorded balance with the provider's console balance: a positive
 * difference is usage the Fleet over-recorded (it rounds each call up), restored to the lots it was drawn from (newest first;
 * before v70, the opening pool); a negative one is drawn like a balance adjustment. What cannot be placed is reported, never
 * assigned a funding source.
 */
import { V71_SQL } from "./migrations-phase71.js";
import { V70_SQL as V70_SQL_FOR_TRIGGER } from "./migrations-phase70.js";
import { OWNER_PAYABLE_ACCOUNT, REIMBURSABLE_ACCOUNT } from "./migrations-phase69.js";
import { AI_CREDITS_ACCOUNT } from "./migrations-phase70.js";
import { restate as restateRaw } from "./migrations-phase42.js";
import { KNOWLEDGE_FOUNDATION_V1 } from "./knowledge-foundation-v1.js";
const lit = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'`;

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
export const EVENT_ROUTES_V72 = Object.freeze({ P3_SUMMARY: ["ai_credit_balance_reconciled", "ai_credit_lot_cost_set"] });
const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');`;

// The receipt's total becomes the promoted lot's acquisition cost.
const PROMOTE = restateRaw(V71_SQL, "fleet_ai_credit_promote", [
  [`  INSERT INTO fleet_ai_credit_lots (provider, source, usd_purchased, usd_remaining, gbp_cost_minor, external_ref, claim_key, journal_id, recorded_by, purchased_at)
    VALUES (r.provider, p_source, r.usd_cents * 1000000, r.usd_cents * 1000000, CASE WHEN p_source = 'treasury' THEN v_gbp END, v_ref,
            CASE WHEN p_source = 'treasury' THEN v_key END, v_j, p_actor, r.observed_at)`,
   `  INSERT INTO fleet_ai_credit_lots (provider, source, usd_purchased, usd_remaining, gbp_cost_minor, external_ref, claim_key, journal_id, recorded_by, purchased_at,
      acq_total_usd_cents, acq_evidence)
    VALUES (r.provider, p_source, r.usd_cents * 1000000, r.usd_cents * 1000000, CASE WHEN p_source = 'treasury' THEN v_gbp END, v_ref,
            CASE WHEN p_source = 'treasury' THEN v_key END, v_j, p_actor, r.observed_at,
            CASE WHEN r.total_cents >= r.usd_cents THEN r.total_cents END, CASE WHEN r.total_cents >= r.usd_cents THEN 'receipt ' || r.receipt_no END)`],
]);

// The used-up treasury lot's settlement also counts the acquisition cost already allocated (leaving the FX difference).
const SETTLE = restateRaw(V71_SQL, "svc_ai_credit_settle", [
  [`  v_detect := fleet_ai_credit_match();`, `  v_detect := fleet_ai_credit_match();
  v_detect := v_detect || jsonb_build_object('acquisitionCost', fleet_ai_credit_cost_pass());`],
  [`    IF l.usd_remaining = 0 AND l.reclass_posted >= l.reclass_micro / 1000000 THEN
      v_residual := l.gbp_cost_minor - l.reclass_posted - l.unexplained_posted;`,
   `    IF l.usd_remaining = 0 AND l.reclass_posted >= l.reclass_micro / 1000000
       AND NOT EXISTS (SELECT 1 FROM fleet_ai_credit_cost_accrual a WHERE a.lot_id = l.lot_id AND a.unposted_micro >= 1000000) THEN
      v_residual := l.gbp_cost_minor - l.reclass_posted - l.unexplained_posted
                    - COALESCE((SELECT sum(posted_minor) FROM fleet_ai_credit_cost_accrual a WHERE a.lot_id = l.lot_id), 0);`],
]);

export const V72_SQL = `
ALTER TABLE fleet_ai_credit_lots
  ADD COLUMN acq_total_usd_cents bigint CHECK (acq_total_usd_cents > 0),
  ADD COLUMN acq_evidence text CHECK (length(acq_evidence) <= 200),
  ADD CONSTRAINT fleet_ai_credit_lots_acq_ge_credit CHECK (acq_total_usd_cents IS NULL OR acq_total_usd_cents * 1000000 >= usd_purchased);

-- Which draws have been priced (once), and the accrual per lot and payer (GBP micro-pence; posted in whole pence).
CREATE TABLE fleet_ai_credit_draw_costs (
  draw_id     bigint      PRIMARY KEY REFERENCES fleet_ai_credit_draws(draw_id),
  lot_id      uuid        NOT NULL REFERENCES fleet_ai_credit_lots(lot_id),
  payer       text        NOT NULL,                        -- 'agent:<id>' or 'treasury'
  cost_micro  bigint      NOT NULL CHECK (cost_micro >= 0),
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_ai_credit_draw_costs_no_change BEFORE UPDATE OR DELETE ON fleet_ai_credit_draw_costs FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TABLE fleet_ai_credit_cost_accrual (
  lot_id         uuid    NOT NULL REFERENCES fleet_ai_credit_lots(lot_id),
  payer          text    NOT NULL,
  unposted_micro bigint  NOT NULL DEFAULT 0 CHECK (unposted_micro >= 0),
  posted_minor   bigint  NOT NULL DEFAULT 0 CHECK (posted_minor >= 0),
  PRIMARY KEY (lot_id, payer)
);

ALTER TABLE fleet_ledger_kinds DISABLE TRIGGER fleet_ledger_kinds_no_change;
INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance) VALUES
  ('ai_credit_acquisition_cost', false, ARRAY['controller'], false,
   'The unrecoverable tax / fees on AI credit used, allocated to whoever made the calls (agent or treasury), funded as its lot was', 'expense');
ALTER TABLE fleet_ledger_kinds ENABLE TRIGGER fleet_ledger_kinds_no_change;
INSERT INTO fleet_ledger_rules (kind, class, side) VALUES
  ('ai_credit_acquisition_cost','agent_expense','D'), ('ai_credit_acquisition_cost','agent_cash','C'),
  ('ai_credit_acquisition_cost','fleet_expense','D'), ('ai_credit_acquisition_cost','treasury_cash','C'),
  ('ai_credit_acquisition_cost','treasury_cash','D'), ('ai_credit_acquisition_cost','owner_payable','C'),
  ('ai_credit_acquisition_cost','ai_credits','C')
ON CONFLICT DO NOTHING;

-- Price every consumption draw whose lot has its acquisition cost and whose caller is known; post whole pence per lot and payer.
CREATE FUNCTION fleet_ai_credit_cost_pass() RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE d record; v_payer text; v_micro bigint; a fleet_ai_credit_cost_accrual; l fleet_ai_credit_lots; v_post bigint; v_agent text; v_lines jsonb;
        v_priced integer := 0; v_posted bigint := 0; v_waiting integer := 0;
BEGIN
  FOR d IN SELECT x.draw_id, COALESCE(x.lot_id, ab.lot_id) AS lot_id, x.gbp_micro, x.request_id, k.usd_purchased, k.acq_total_usd_cents
             FROM fleet_ai_credit_draws x
             LEFT JOIN fleet_ai_credit_absorptions ab ON ab.draw_id = x.draw_id
             JOIN fleet_ai_credit_lots k ON k.lot_id = COALESCE(x.lot_id, ab.lot_id)
            WHERE x.cause = 'consumption' AND k.acq_total_usd_cents IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM fleet_ai_credit_draw_costs c WHERE c.draw_id = x.draw_id)
            ORDER BY x.draw_id LIMIT 500 LOOP
    -- who made the call: the cognition record (agent work or a treasury-paid owner turn), else a Fleet Control review
    SELECT CASE WHEN g.payer = 'treasury' THEN 'treasury' ELSE 'agent:' || g.agent_id END INTO v_payer
      FROM fleet_cognition_log g WHERE g.request_id = d.request_id LIMIT 1;
    IF v_payer IS NULL AND EXISTS (SELECT 1 FROM fleet_provider_credit_events e WHERE e.request_id = d.request_id AND e.kind = 'consumption'
                                     AND e.recorded_by LIKE 'controller:%') THEN
      v_payer := 'treasury';
    END IF;
    IF v_payer IS NULL THEN v_waiting := v_waiting + 1; CONTINUE; END IF;
    v_micro := (d.gbp_micro::numeric * (d.acq_total_usd_cents * 1000000 - d.usd_purchased) / d.usd_purchased)::bigint;
    INSERT INTO fleet_ai_credit_draw_costs (draw_id, lot_id, payer, cost_micro) VALUES (d.draw_id, d.lot_id, v_payer, v_micro);
    INSERT INTO fleet_ai_credit_cost_accrual (lot_id, payer, unposted_micro) VALUES (d.lot_id, v_payer, v_micro)
      ON CONFLICT (lot_id, payer) DO UPDATE SET unposted_micro = fleet_ai_credit_cost_accrual.unposted_micro + EXCLUDED.unposted_micro;
    v_priced := v_priced + 1;
  END LOOP;
  FOR a IN SELECT * FROM fleet_ai_credit_cost_accrual WHERE unposted_micro >= 1000000 ORDER BY lot_id, payer FOR UPDATE LOOP
    SELECT * INTO l FROM fleet_ai_credit_lots WHERE lot_id = a.lot_id;
    v_post := a.unposted_micro / 1000000;
    v_agent := CASE WHEN a.payer LIKE 'agent:%' THEN substr(a.payer, 7) END;
    -- the payer can cover it (an agent never goes below zero for this; it waits)
    IF v_agent IS NOT NULL AND fleet_ledger_balance(fleet_ledger_account(v_agent, 'agent_cash')) < v_post THEN CONTINUE; END IF;
    IF v_agent IS NULL AND fleet_ledger_balance('fleet:treasury:unallocated') < v_post THEN CONTINUE; END IF;
    v_lines := CASE WHEN v_agent IS NOT NULL THEN jsonb_build_array(
        jsonb_build_object('account', fleet_ledger_account(v_agent, 'agent_expense'), 'side', 'D', 'amount', v_post),
        jsonb_build_object('account', fleet_ledger_account(v_agent, 'agent_cash'), 'side', 'C', 'amount', v_post))
      ELSE jsonb_build_array(
        jsonb_build_object('account', 'fleet:expense', 'side', 'D', 'amount', v_post),
        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', v_post)) END
      || CASE WHEN l.source = 'owner' THEN jsonb_build_array(
        jsonb_build_object('account', '${REIMBURSABLE_ACCOUNT}', 'side', 'D', 'amount', v_post),
        jsonb_build_object('account', '${OWNER_PAYABLE_ACCOUNT}', 'side', 'C', 'amount', v_post))
      ELSE jsonb_build_array(
        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', v_post),
        jsonb_build_object('account', '${AI_CREDITS_ACCOUNT}', 'side', 'C', 'amount', v_post)) END;
    PERFORM fleet_ledger_post('ai_credit_acquisition_cost', 'ai-credit-cost:' || a.lot_id || ':' || a.payer || ':' || (a.posted_minor + v_post), 'controller',
      'tax / fees on AI credit used (' || COALESCE(l.acq_evidence, 'lot evidence') || ')', 'controller', v_agent, NULL, NULL, NULL, NULL, now(), v_lines);
    UPDATE fleet_ai_credit_cost_accrual SET unposted_micro = unposted_micro - v_post * 1000000, posted_minor = posted_minor + v_post
     WHERE lot_id = a.lot_id AND payer = a.payer;
    v_posted := v_posted + v_post;
  END LOOP;
  RETURN jsonb_build_object('priced', v_priced, 'postedMinor', v_posted, 'waitingForCaller', v_waiting);
END $$;

-- Owner: a lot's acquisition cost from evidence (e.g. the receipts that bought the opening balance): total charged vs credit.
CREATE FUNCTION fleet_admin_ai_credit_lot_cost(p_lot uuid, p_credit_usd_cents bigint, p_total_usd_cents bigint, p_evidence text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE l fleet_ai_credit_lots;
BEGIN
  ${OWNER_ACTOR}
  IF p_credit_usd_cents IS NULL OR p_total_usd_cents IS NULL OR p_credit_usd_cents <= 0 OR p_total_usd_cents < p_credit_usd_cents THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: the total charged (with tax and fees) is at least the credit bought';
  END IF;
  IF p_evidence IS NULL OR length(p_evidence) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: name the receipts or statement'; END IF;
  SELECT * INTO l FROM fleet_ai_credit_lots WHERE lot_id = p_lot FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such lot'; END IF;
  IF l.acq_total_usd_cents IS NOT NULL THEN RAISE EXCEPTION 'FLEET_ALREADY_CLAIMED: this lot already has its acquisition cost (%)', l.acq_evidence; END IF;
  -- the lot's ratio from the evidence (a pooled lot, such as the opening one, takes the ratio of the purchases that formed it)
  UPDATE fleet_ai_credit_lots SET acq_total_usd_cents = CEIL(l.usd_purchased::numeric / 1000000 * p_total_usd_cents / p_credit_usd_cents)::bigint,
         acq_evidence = left(p_evidence, 200) WHERE lot_id = p_lot;
  PERFORM fleet_event('ai_credit_lot_cost_set', NULL, p_actor, jsonb_build_object('lotId', p_lot, 'creditUsdCents', p_credit_usd_cents, 'totalUsdCents', p_total_usd_cents));
  RETURN jsonb_build_object('ok', true, 'lotId', p_lot, 'ratio', round(p_total_usd_cents::numeric / p_credit_usd_cents, 4));
END $$;

-- Restore credit the Fleet over-recorded as used: to the lots it was drawn from (newest first), then — for usage before v70 —
-- the opening pool. Anything left is reported, never given a funding source.
CREATE FUNCTION fleet_ai_credit_restore(p_provider text, p_usd bigint, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_left bigint := p_usd; d record; v_take bigint; o fleet_ai_credit_lots; v_restored bigint := 0; v_opening bigint := 0;
BEGIN
  FOR d IN SELECT x.lot_id, sum(x.usd) AS drawn FROM fleet_ai_credit_draws x JOIN fleet_ai_credit_lots k ON k.lot_id = x.lot_id
            WHERE k.provider = p_provider AND x.cause = 'consumption' GROUP BY x.lot_id ORDER BY max(x.draw_id) DESC LOOP
    EXIT WHEN v_left <= 0;
    SELECT * INTO o FROM fleet_ai_credit_lots WHERE lot_id = d.lot_id FOR UPDATE;
    v_take := LEAST(v_left, o.usd_purchased - o.usd_remaining, d.drawn);
    CONTINUE WHEN v_take <= 0;
    UPDATE fleet_ai_credit_lots SET usd_remaining = usd_remaining + v_take WHERE lot_id = o.lot_id;
    v_left := v_left - v_take; v_restored := v_restored + v_take;
  END LOOP;
  IF v_left > 0 THEN
    SELECT * INTO o FROM fleet_ai_credit_lots WHERE provider = p_provider AND external_ref = 'opening:v70:' || p_provider FOR UPDATE;
    IF o.lot_id IS NOT NULL THEN
      UPDATE fleet_ai_credit_lots SET usd_purchased = usd_purchased + v_left, usd_remaining = usd_remaining + v_left WHERE lot_id = o.lot_id;
      v_opening := v_left; v_left := 0;
    END IF;
  END IF;
  IF v_left > 0 THEN
    PERFORM fleet_event('ai_credit_reconcile', NULL, p_actor, jsonb_build_object('provider', p_provider, 'reason', 'unplaced_credit',
      'usdMicrocents', v_left, 'note', 'credit above the recorded balance that no lot can account for: not assigned to any funding source'));
  END IF;
  RETURN jsonb_build_object('restoredToLots', v_restored, 'restoredToOpening', v_opening, 'unplaced', v_left);
END $$;

-- Owner: reconcile the recorded balance with the provider console's balance.
CREATE FUNCTION fleet_admin_ai_credit_balance_reconcile(p_provider text, p_console_usd_cents bigint, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_recorded bigint; v_diff bigint; r jsonb := '{}'::jsonb; v_ref text;
BEGIN
  ${OWNER_ACTOR}
  IF p_console_usd_cents IS NULL OR p_console_usd_cents < 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the console balance in USD cents'; END IF;
  v_recorded := fleet_provider_credit_balance(p_provider);
  v_diff := p_console_usd_cents * 1000000 - v_recorded;
  IF v_diff = 0 THEN RETURN jsonb_build_object('ok', true, 'differenceUsdMicrocents', 0); END IF;
  v_ref := 'reconcile:console:' || p_console_usd_cents || ':' || gen_random_uuid();
  INSERT INTO fleet_ai_credit_reconciliations (provider, console_usd_cents, recorded_usd_microcents, difference_usd_microcents, recorded_by)
    VALUES (p_provider, p_console_usd_cents, v_recorded, v_diff, p_actor);
  -- a negative difference is drawn by the event trigger (v70: treasury lots expensed at cost); a positive one is restored here
  INSERT INTO fleet_provider_credit_events (provider, kind, usd_microcents, external_ref, recorded_by) VALUES (p_provider, 'adjustment', v_diff, v_ref, p_actor);
  IF v_diff > 0 THEN r := fleet_ai_credit_restore(p_provider, v_diff, p_actor); END IF;
  PERFORM fleet_event('ai_credit_balance_reconciled', NULL, p_actor, jsonb_build_object('provider', p_provider, 'consoleUsdCents', p_console_usd_cents,
    'differenceUsdMicrocents', v_diff) || r);
  RETURN jsonb_build_object('ok', true, 'differenceUsdMicrocents', v_diff) || r;
END $$;
CREATE TABLE fleet_ai_credit_reconciliations (
  seq bigserial PRIMARY KEY, provider text NOT NULL, console_usd_cents bigint NOT NULL, recorded_usd_microcents bigint NOT NULL,
  difference_usd_microcents bigint NOT NULL, recorded_by text NOT NULL, at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_ai_credit_reconciliations_no_change BEFORE UPDATE OR DELETE ON fleet_ai_credit_reconciliations FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

${restateRaw(V70_SQL_FOR_TRIGGER, "fleet_ai_credit_events_trigger", [
  [`  ELSIF NEW.kind = 'adjustment' AND NEW.usd_microcents > 0 THEN
    INSERT INTO fleet_ai_credit_lots (provider, source, usd_purchased, usd_remaining, external_ref, recorded_by)
      VALUES (NEW.provider, 'owner', NEW.usd_microcents, NEW.usd_microcents, COALESCE(NEW.external_ref, 'adjustment') || ':' || gen_random_uuid(), NEW.recorded_by);`,
   `  ELSIF NEW.kind = 'adjustment' AND NEW.usd_microcents > 0 THEN
    -- v72: more credit than recorded is usage over-recorded, restored to where it was drawn — never a lot of assumed funding
    IF COALESCE(NEW.external_ref, '') NOT LIKE 'reconcile:%' THEN PERFORM fleet_ai_credit_restore(NEW.provider, NEW.usd_microcents, NEW.recorded_by); END IF;`],
])}

${PROMOTE}

${SETTLE}

${restateRaw(V71_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V72) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
])}

-- Agents learn that their AI cost includes the tax / fees on the credit (capability entry v4; bf-ai-costs v2).
SELECT fleet_admin_knowledge_library_load(${lit({ entries: KNOWLEDGE_FOUNDATION_V1.entries.filter((e) => ["fleet-capability-status", "bf-ai-costs"].includes(e.id)) })}::jsonb, 'migration');

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
