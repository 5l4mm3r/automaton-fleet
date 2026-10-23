#!/usr/bin/env bash
# The scenario suite's FROZEN TERMS (2026-10-23): production's FX, cognition tiers and the dearest AI-credit lot with credit
# left, read READ-ONLY, with the per-scenario caps of plan A, B or C. Prints the terms JSON and its ceiling and sha256; nothing
# is written to any database. The suite refuses to run unless its operator repeats this ceiling.
#   bash scripts/fleet-scenario-terms.sh <runId> <A|B|C> > terms.json
# Plan C (2026-10-23, after scen-89d7c21-b1): the targeted demonstrations — S1 to its revised delivery, S2, S3 parts B and C
# only (A carried forward), S4, S5 after its repair; S6 carried forward (run with --only s1,s2,s3,s4,s5). Each cap is the
# spend measured in scen-89d7c21-b1 for that work plus one worst-case reservation (95p: the largest was 90.48p, an image
# step adds ~1.3p), so the cap never starves the last call it should allow.
set -euo pipefail
RUN=${1:?runId}; PLAN=${2:?plan A, B or C}
[[ "$RUN" =~ ^[A-Za-z0-9._:-]{3,64}$ ]] || { echo "runId must match [A-Za-z0-9._:-]{3,64}" >&2; exit 2; }
case "$PLAN" in
  A) CAPS='{"s1-order-and-correction":400,"s2-interrupted-twice":400,"s3-valid-blanks-and-blocked-inspection":300,"s4-economical-sleep":150,"s5-lesson-application":200,"s6-opportunity-choice":300}' ;;
  B) CAPS='{"s1-order-and-correction":300,"s2-interrupted-twice":250,"s3-valid-blanks-and-blocked-inspection":200,"s4-economical-sleep":100,"s5-lesson-application":150,"s6-opportunity-choice":200}' ;;
  C) CAPS='{"s1-order-and-correction":360,"s2-interrupted-twice":250,"s3-valid-blanks-and-blocked-inspection":220,"s4-economical-sleep":170,"s5-lesson-application":150,"s6-opportunity-choice":0}' ;;
  *) echo "plan is A, B or C" >&2; exit 2 ;;
esac
S3PARTS='["A","B","C"]'; [[ "$PLAN" == C ]] && S3PARTS='["B","C"]'
MINUTES='{"s1-order-and-correction":45,"s2-interrupted-twice":45,"s3-valid-blanks-and-blocked-inspection":45,"s4-economical-sleep":45,"s5-lesson-application":30,"s6-opportunity-choice":30}'
sudo -n -u postgres psql -X -q -At -d automaton_fleet -v run="$RUN" -v caps="$CAPS" -v minutes="$MINUTES" -v s3parts="$S3PARTS" <<'SQL'
SET default_transaction_read_only = on; SET search_path = fleet;
SELECT jsonb_pretty(jsonb_build_object(
  'runId', :'run',
  'capsPence', :'caps'::jsonb,
  'timeoutMinutes', :'minutes'::jsonb,
  's3Parts', :'s3parts'::jsonb,
  'fxRateMicro', (SELECT rate_micro::text FROM fleet_fx_rates WHERE base = 'USD' AND quote = (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1) ORDER BY rate_id DESC LIMIT 1),
  'acquisition', (SELECT jsonb_build_object('totalUsdCents', acq_total_usd_cents::text, 'usdPurchasedMicro', usd_purchased::text, 'lot', lot_id::text)
                    FROM fleet_ai_credit_lots WHERE provider = 'anthropic' AND usd_remaining > 0 AND acq_total_usd_cents IS NOT NULL
                   ORDER BY acq_total_usd_cents::numeric * 1000000 / usd_purchased DESC LIMIT 1),
  'tiers', (SELECT jsonb_agg(jsonb_build_object('tier', tier, 'model', model, 'maxOutputTokens', max_output_tokens, 'prices', jsonb_build_object(
              'inputMicrocentsPerToken', input_microcents_per_token, 'outputMicrocentsPerToken', output_microcents_per_token,
              'cacheWriteMicrocentsPerToken', cache_write_microcents_per_token, 'cacheReadMicrocentsPerToken', cache_read_microcents_per_token)) ORDER BY tier)
              FROM fleet_cognition_tiers WHERE enabled AND verified_at IS NOT NULL),
  'source', 'production read-only ' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '; credit left (USD µ¢) ' || fleet_provider_credit_balance('anthropic')));
SQL
