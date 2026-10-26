#!/usr/bin/env bash
# The promotional-credit reconciliation PLAN (v116, 2026-10-24): from the figures the provider console shows, reads
# production READ-ONLY and prints, computed by code (SQL numeric, USD microcents), the reconciliation and the exact owner
# entries in the order they must be made. Nothing is written to any database; no provider is called.
#   bash scripts/fleet-ai-credit-promo-plan.sh <grantUsdCents> <promoRemainingUsdCents> <purchasedRemainingUsdCents> \
#        <grantedAt> <expiresAt> <grantRef> <assumed_cutoff|provider_timestamp> <displayed> [<fleetSince ISO, default 2026-10-23T14:26:00Z>]
# Order: (1) the purchased balance is reconciled first, while only purchased lots exist, so a difference can never land on
# the grant; (2) the grant is recorded with what the console shows left of it, the dates exactly as displayed, and whether
# its expiry instant is the provider's or Fleet's assumed cutoff. The draw order is the provider's published rule (v116
# default: included credit first, soonest expiry first, then purchased) — not an entry.
set -euo pipefail
G=${1:?grant USD cents}; RP=${2:?promotional remaining USD cents}; RB=${3:?purchased remaining USD cents}
GRANTED=${4:?granted at}; EXPIRES=${5:?expires at}; REF=${6:?grant identifier}; BASIS=${7:?assumed_cutoff or provider_timestamp}
DISPLAYED=${8:?the dates exactly as the console displays them}; SINCE=${9:-2026-10-23T14:26:00Z}
[[ "$BASIS" == assumed_cutoff || "$BASIS" == provider_timestamp ]] || { echo "expiry basis: assumed_cutoff or provider_timestamp" >&2; exit 2; }
DISPLAYED_RE='^[A-Za-z0-9 /:,.;=-]{3,120}$'
[[ "$DISPLAYED" =~ $DISPLAYED_RE ]] || { echo "displayed: 3-120 plain characters" >&2; exit 2; }
for n in "$G" "$RP" "$RB"; do [[ "$n" =~ ^[0-9]{1,8}$ ]] || { echo "amounts are whole USD cents" >&2; exit 2; }; done
[[ "$REF" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$ ]] || { echo "grant identifier: [A-Za-z0-9._:-], 3-80 characters" >&2; exit 2; }
(( RP <= G )) || { echo "the promotional remaining cannot exceed the grant" >&2; exit 2; }
sudo -n -u postgres psql -X -q -At -d automaton_fleet -v g="$G" -v rp="$RP" -v rb="$RB" -v granted="$GRANTED" -v expires="$EXPIRES" -v ref="$REF" -v basis="$BASIS" -v displayed="$DISPLAYED" -v since="$SINCE" <<'SQL'
SET default_transaction_read_only = on; SET search_path = fleet;
WITH f AS (
  SELECT fleet_provider_credit_balance('anthropic')::numeric AS recorded,
         (SELECT COALESCE(sum(usd_remaining), 0) FROM fleet_ai_credit_lots WHERE provider = 'anthropic' AND source IN ('owner','treasury'))::numeric AS lb,
         (SELECT count(*) FROM fleet_ai_credit_lots WHERE provider = 'anthropic' AND source = 'treasury' AND usd_remaining > 0) AS treasury_lots,
         (SELECT count(*) FROM fleet_ai_credit_lots WHERE provider = 'anthropic' AND external_ref = 'grant:anthropic:' || :'ref') AS already,
         (SELECT COALESCE(-sum(usd_microcents), 0) FROM fleet_provider_credit_events WHERE provider = 'anthropic' AND kind = 'consumption' AND at >= :'since'::timestamptz)::numeric AS uf,
         (SELECT count(*) FROM fleet_provider_credit_events WHERE provider = 'anthropic' AND kind = 'consumption' AND at >= :'since'::timestamptz) AS uf_calls,
         (SELECT COALESCE(sum(usd_microcents), 0) FROM fleet_provider_credit_holds WHERE provider = 'anthropic' AND status = 'open')::numeric AS held
), c AS (SELECT f.*, :'g'::numeric * 1000000 AS g, :'rp'::numeric * 1000000 AS rp, :'rb'::numeric * 1000000 AS rb FROM f)
SELECT jsonb_pretty(jsonb_build_object(
  'source', 'production read-only ' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'console', jsonb_build_object('grantUsdMicro', c.g::text, 'promoRemainingUsdMicro', c.rp::text, 'purchasedRemainingUsdMicro', c.rb::text,
                                'totalUsdMicro', (c.rp + c.rb)::text, 'grantedAt', :'granted', 'expiresAt', :'expires', 'grantRef', :'ref'),
  'fleet', jsonb_build_object('recordedBalanceUsdMicro', c.recorded::text, 'purchasedRemainingUsdMicro', c.lb::text, 'openHoldsUsdMicro', c.held::text,
                              'fleetConsumptionSince', jsonb_build_object('since', :'since', 'calls', c.uf_calls, 'usdMicro', c.uf::text)),
  'reconciliation', jsonb_build_object(
     'promotionalConsumedUsdMicro', (c.g - c.rp)::text,
     'promotionalConsumedNote', 'G - Rp: usage of the grant Fleet did not record (outside Fleet, or Fleet''s own calls if the provider drew the grant first). Never attributed to an agent.',
     'purchasedDifferenceUsdMicro', (c.rb - c.lb)::text,
     'purchasedDifferenceNote', CASE WHEN c.rb = c.lb THEN 'none: the purchased balance matches Fleet''s record'
          WHEN c.rb > c.lb THEN 'the console shows MORE purchased credit than Fleet recorded: Fleet recorded more usage than the provider charged, or the provider drew the grant for Fleet''s calls. The cause must be demonstrated from the records before entry 1 (scripts/fleet-ai-credit-discrepancy.sh); restored to the lots it was drawn from (v72)'
          ELSE 'the console shows LESS purchased credit than Fleet recorded: purchased credit used outside Fleet (or a purchase/expiry not recorded); drawn as a balance adjustment from the purchased lot (owner-funded: no GBP posting)' END,
     'afterEntriesRecordedUsdMicro', (c.rb + c.rp)::text,
     'afterEntriesMatchesConsole', true),
  'blockers', to_jsonb(array_remove(ARRAY[
     CASE WHEN c.already > 0 THEN 'that grant is already recorded' END,
     CASE WHEN c.treasury_lots > 0 THEN 'a treasury-funded lot has credit left: a negative reconciliation would expense it at cost — review before entry 1' END,
     CASE WHEN c.held > 0 THEN 'an engineering credit hold is open: reconcile after its run is imported and released' END,
     CASE WHEN c.uf > 0 THEN 'Fleet consumed credit since ' || :'since' || ': include those calls (by request id) in the reconciliation note' END,
     CASE WHEN :'expires'::timestamptz <= now() THEN 'the grant has expired: it is not credit' END], NULL)),
  'entriesInOrder', jsonb_build_array(
     CASE WHEN c.rb = c.lb THEN 'entry 1: none (the purchased balance already matches)'
          ELSE 'entry 1: fleet:admin economy-ai-credit-reconcile anthropic ' || :'rb' || '   # before the grant exists; difference ' || (c.rb - c.lb)::text || ' USD microcents; no GBP journal (owner-funded lot)' END,
     'entry 2: fleet:admin economy-ai-credit-promotional-grant anthropic ' || :'ref' || ' ' || :'g' || ' ' || :'rp' || ' ' || :'granted' || ' ' || :'expires'
       || ' ' || :'basis' || ' "' || :'displayed' || '" Console Billing, Promotional credits'
       || '   # promotional lot ' || c.rp::text || ' USD microcents left; ' || (c.g - c.rp)::text || ' drawn as used before recording; no GBP journal'
       || CASE WHEN :'basis' = 'assumed_cutoff' THEN '; expiry ' || :'expires' || ' is Fleet''s assumed conservative cutoff (the console shows a date only), not the provider''s timestamp' ELSE '' END),
  'drawOrder', jsonb_build_object('policy', (SELECT to_jsonb(p) ->> 'draw_order' FROM fleet_ai_credit_policy p WHERE p.provider = 'anthropic'),
     'evidence', (SELECT to_jsonb(p) ->> 'draw_order_evidence' FROM fleet_ai_credit_policy p WHERE p.provider = 'anthropic'),
     'note', 'v116: the provider''s published rule, included credit first (soonest expiry first), then purchased; before v116 is installed this reads null'),
  'notPartOfThisPlan', jsonb_build_array(
     'any internal agent charge or treatment of promotional use (owner decision; a later migration)', 'any provider call, top-up or posting')
)) FROM c;
SQL
