#!/usr/bin/env bash
# Stage 2 cost report (read-only), by phase from ~/rlc142/phases.log: Agent-1 calls per phase window, Fleet Control reservations,
# PayPal fees from the transaction evidence. Promotional credit is charged to no one (shown separately).
R=~/rlc142; A1=01M3F50SH7PNX2E3GST13J52AS
Q() { sudo -n -u postgres psql -X -q -At -d automaton_fleet -c "SET default_transaction_read_only=on; SET search_path=fleet; $1"; }
at() { grep -m1 " $1" $R/phases.log | cut -d' ' -f1; }
win() { Q "SELECT count(*)||' calls, '||COALESCE(sum(provider_usd_microcents),0)||' µ¢ (promotional '||COALESCE(sum(promotional_usd_microcents),0)||', charged to the agent '||COALESCE(sum(charged_microcents),0)||')' FROM fleet_cognition_log WHERE agent_id='$A1' AND at >= '$1' AND at < '$2'"; }
P0=$(at "publish: holds"); P1=$(at "publish: verified"); B0=$(at "purchase: guard armed"); B1=$(at "purchase: delivered"); M0=$(at "message: Agent-1 resumed"); M1=$(at "message: verified"); E=$(date -u +%FT%TZ)
echo "== Stage 2 costs ($(date -u +%FT%TZ))"
echo "  publish (setup: capability check + publication): $(win ${P0:-$E} ${P1:-$E})"
echo "  delivery (controller svc_offer_tick, no model call expected): $(win ${B0:-$E} ${B1:-$E}); deliveries: $(Q "SELECT string_agg(status||' automatic='||automatic||' review='||left(review_id::text,8), ', ') FROM fleet_order_deliveries WHERE created_at >= '${B0:-$E}'")"
echo "  reply (Agent-1 answering the buyer + classifying): $(win ${M0:-$E} ${M1:-$E})"
echo "  Fleet Control: $(Q "SELECT COALESCE(string_agg(kind||' '||status||' usd '||COALESCE(actual_usd_microcents,0)||' µ¢ (promo '||COALESCE(promotional_usd_microcents,0)||') posted '||COALESCE(posted_minor,0)||'p max '||max_minor||'p', '; '),'none') FROM fleet_control_ai_reservations WHERE reserved_at >= '${P0:-$E}'")"
echo "  outside the phases (should be 0): $(Q "SELECT count(*) FROM fleet_cognition_log WHERE at >= '${P0:-$E}' AND NOT ((at >= '${P0:-$E}' AND at < '${P1:-$E}') OR (at >= '${B0:-$E}' AND at < '${B1:-$E}') OR (at >= '${M0:-$E}' AND at < '${M1:-$E}'))")"
echo "  PayPal: $(Q "SELECT COALESCE(string_agg(event_code||' '||amount_minor||'p fee '||fee_minor||'p', '; ' ORDER BY initiated_at),'none') FROM fleet_paypal_transactions WHERE rail_id='b71b3f3c-901c-4f22-818b-3e1b1269f420' AND initiated_at >= '${P0:-$E}'::timestamptz - interval '1 day'")"
echo "  MARGINAL cost of serving an existing download = delivery + reply + Fleet Control (+ the PayPal fee of a real sale); setup = publish."
