#!/usr/bin/env bash
# Where a Console purchased-credit difference comes from (2026-10-26, owner: "investigate … from existing records; do not
# label it rounding or over-recorded usage until demonstrated; account for Console display precision"). Reads production
# READ-ONLY and recomputes, by code (SQL numeric, USD microcents), every Fleet-recorded consumption since the last Console
# reconciliation from its own token counts at the PUBLISHED prices, by recorder and model, next to what Fleet recorded.
# Nothing is written; no provider is called.
#   bash scripts/fleet-ai-credit-discrepancy.sh <consoleAtLastReconcileUsdCents> <consoleNowUsdCents>
# Published prices (platform.claude.com/docs/en/about-claude/pricing, read 2026-10-26), USD microcents per token
# (input / 5-minute cache write / cache read / output): Opus 5.5 400/500/20/2000; Sonnet 5.5 200/250/10/1000 (cache hits
# 0.05× input on both); Haiku 4.5 100/125/10/500. Fleet requests use 5-minute cache writes only (cache_control ephemeral, no ttl).
set -euo pipefail
C0=${1:?Console balance at the last reconciliation, USD cents}; C1=${2:?Console balance now, USD cents}
for n in "$C0" "$C1"; do [[ "$n" =~ ^[0-9]{1,9}$ ]] || { echo "whole USD cents" >&2; exit 2; }; done
sudo -n -u postgres psql -X -q -At -d automaton_fleet -v c0="$C0" -v c1="$C1" <<'SQL'
SET default_transaction_read_only = on; SET search_path = fleet;
WITH pub(model, i, cw, cr, o) AS (VALUES ('claude-opus-5-5', 400, 500, 20, 2000), ('claude-sonnet-5-5', 200, 250, 10, 1000),
                                         ('claude-haiku-4-5-20251001', 100, 125, 10, 500)),
last AS (SELECT max(seq) AS seq FROM fleet_provider_credit_events WHERE provider = 'anthropic' AND kind = 'adjustment' AND external_ref LIKE 'reconcile:console:%'),
ev AS (SELECT e.* FROM fleet_provider_credit_events e, last WHERE e.provider = 'anthropic' AND e.kind = 'consumption' AND e.seq > last.seq),
calls AS (
  SELECT e.recorded_by, l.model, -e.usd_microcents AS recorded, l.input_tokens AS i, l.output_tokens AS o, l.cache_read_tokens AS cr, l.cache_write_tokens AS cw
    FROM ev e JOIN fleet_cognition_log l ON l.request_id = e.request_id
  UNION ALL
  SELECT e.recorded_by, k.model, -e.usd_microcents, k.input_tokens, k.output_tokens, k.cache_read_tokens, k.cache_write_tokens
    FROM ev e JOIN fleet_engineering_cognition_calls k ON k.call_id = e.request_id),
unmatched AS (SELECT count(*) AS n, COALESCE(-sum(usd_microcents), 0) AS usd FROM ev e
               WHERE NOT EXISTS (SELECT 1 FROM fleet_cognition_log l WHERE l.request_id = e.request_id)
                 AND NOT EXISTS (SELECT 1 FROM fleet_engineering_cognition_calls k WHERE k.call_id = e.request_id)),
by_model AS (
  SELECT c.model, split_part(c.recorded_by, ':', 1) || CASE WHEN c.recorded_by LIKE 'controller:engineering%' THEN ':engineering' ELSE '' END AS source,
         count(*) AS calls, sum(c.recorded) AS recorded, sum(c.i::numeric * p.i + c.cw::numeric * p.cw + c.cr::numeric * p.cr + c.o::numeric * p.o) AS published,
         sum(c.cr) AS cache_read_tokens
    FROM calls c LEFT JOIN pub p ON p.model = c.model GROUP BY 1, 2),
tot AS (SELECT sum(recorded) AS recorded, sum(published) AS published FROM by_model)
SELECT jsonb_pretty(jsonb_build_object(
  'source', 'production read-only ' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'sinceReconcileSeq', (SELECT seq FROM last),
  'byModel', (SELECT jsonb_agg(jsonb_build_object('model', model, 'source', source, 'calls', calls, 'recordedUsdMicro', recorded::text,
                 'atPublishedUsdMicro', published::text, 'differenceUsdMicro', (recorded - published)::text, 'cacheReadTokens', cache_read_tokens::text) ORDER BY model, source) FROM by_model),
  'unmatchedConsumption', (SELECT jsonb_build_object('events', n, 'usdMicro', usd::text) FROM unmatched),
  'fleetRecordedUsdMicro', (SELECT recorded::text FROM tot),
  'fleetAtPublishedUsdMicro', (SELECT published::text FROM tot),
  'recordedMinusPublishedUsdMicro', (SELECT (recorded - published)::text FROM tot),
  'consoleImpliedUsageUsdMicro', ((:'c0'::numeric - :'c1'::numeric) * 1000000)::text,
  'consoleDisplayPrecision', 'each Console figure is shown to the cent: the usage between two readings is known to within ±1,000,000 µ¢ ($0.01) whether the display rounds or truncates',
  'residualAfterPublishedUsdMicro', ((:'c0'::numeric - :'c1'::numeric) * 1000000 - (SELECT published FROM tot))::text,
  'residualWithinDisplayPrecision', abs((:'c0'::numeric - :'c1'::numeric) * 1000000 - (SELECT published FROM tot)) < 1000000));
SQL
