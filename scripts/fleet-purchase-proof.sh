#!/usr/bin/env bash
# Automaton Fleet — the owner's purchase proof of Agent-1's private offer (2026-10-19; launch-readiness §2, "Purchase proof"):
# one £5 purchase, its delivery, one support / revision request and a full refund, with PUBLIC SALES CLOSED. A test of the
# transaction system, not demand, revenue or approval of the product. Agent-1 only; Agent-2 stays paused. Starts ONLY on the
# owner's approval of its terms.
#
#   bash fleet-purchase-proof.sh start <aiCeilingPence>
#       guards (no refund queued anywhere, no other refundable sale, Agent-1 can bear the £5 refund hold) → Agent-1's run
#       budget (24 h) → the watchdog (every minute) → resume Agent-1. Money-out stays OFF.
#   … buy            open the £5 proof purchase (prints the order page: pay it in PayPal yourself, from an account other
#                    than the treasury's, as for the £1 receiving test)
#   … refund [why]   the owner's override: refund the proof order in full (recorded as an OWNER OVERRIDE, not as the agent's
#                    refund handling)
#   … status         read-only progress, the effective money-out setting and the acceptance results
#   … stop [why]     pause Agent-1, end the run budget, close the refund window, the watchdog off
#   (watch)          the watchdog. The REFUND WINDOW opens only when exactly one refund is queued in the whole Fleet and it is
#                    this proof order's, for at most what was paid: custody money-out (2 h) and custody's refund switch
#                    (REAL_PAYMENTS_ENABLED=true for the custody unit only; runtime.env is unchanged, so Fleet HQ and the
#                    Operator API keep showing false — never read that as "money-out is off"). It closes at the stop.
#                    Stops on: completion (refund recorded once as owner capital, the agent's wallet hold released, ledger
#                    verified); any refund on another order; a second proof order, refund or PayPal refund; a third
#                    delivery; an uncertain outcome; a buyer message unanswered 30 min; 40 model calls without a new
#                    customer event; a refund not sent 30 min after the window opened; the AI ceiling; 24 h. Waiting for
#                    the buyer never stops it.
# Never: public sales, card authority, an outward release, payouts, Agent-2, sweep, sizing, the cap, the fuses, runtime.env.
# The exit status is the real one; the log is complete when the script returns. State and log: $FLEET_PROOF_DIR.
set -uo pipefail
export PATH=/opt/automaton-fleet/node/bin:$PATH
D="${FLEET_PROOF_DIR:-$HOME/fleet-proof}"; mkdir -p "$D"
SELF=$(readlink -f "${BASH_SOURCE[0]}"); ARGS=("$@")
if [[ "${FLEET_TEELOG:-}" != "$SELF" ]]; then set +e; FLEET_TEELOG="$SELF" bash "$SELF" "${ARGS[@]}" 2>&1 | tee -a "$D/proof.log"; exit "${PIPESTATUS[0]}"; fi
unset FLEET_TEELOG

A1=01M3F50SH7PNX2E3GST13J52AS; A2=01M4C4NXT786Q4E9725N5A15KV
REL=e1c51e28a70a6d482887f32838524dec1885e71b
SLUG=uk-landlord-compliance-tracker-england-g-a9ddde
HOURS=24; WINDOW_HOURS=2; PRICE_MAX=500; QUIET_MIN=30; MAX_IDLE_CALLS=40; MAX_DELIVERIES=2
UNIT=fleet-proof-watch; CUSTODY=automaton-fleet-custody.service
DROPIN=/etc/systemd/system/$CUSTODY.d/60-purchase-proof-refund.conf
CUR=/opt/automaton-fleet/current; NODE=/opt/automaton-fleet/node/bin/node; ENVF=/etc/automaton-fleet/runtime.env
ts() { date -u +%FT%TZ; }
A() { if [[ $EUID -eq 0 ]]; then runuser -u ubuntu -- env -C $CUR $NODE dist/fleet/postgres/cli.js "$@"; else env -C $CUR $NODE dist/fleet/postgres/cli.js "$@"; fi; }
Q() { sudo -n -u postgres psql -X -q -At -d automaton_fleet -c "SET default_transaction_read_only=on; SET search_path=fleet; $1"; }
die() { echo "!! $*"; echo "== PROOF STEP NOT COMPLETE $(ts)"; exit 1; }
pinned() { sudo -n grep -m1 '^FLEET_RUNTIME_COMMIT=' $ENVF | cut -d= -f2; }
flag_false() { sudo -n grep -qx "$1=false" $ENVF; }
current() { readlink -f $CUR; }
paused() { Q "SELECT paused FROM fleet_founder_cognition WHERE agent_id = '$1'"; }
custody() { A hub-custody 2>/dev/null; }
live_signers() { custody | jq -r '.liveSigners // "?"'; }
activation_live() { custody | jq -r '.activation != null'; }
switch_file() { [[ -f $DROPIN ]] && echo present || echo absent; }
# What the running custody process actually has (only this key is read; nothing else of its environment is printed).
switch_effective() {
  local pid; pid=$(sudo -n systemctl show -p MainPID --value $CUSTODY 2>/dev/null)
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || { echo "custody not running"; return; }
  if sudo -n cat /proc/$pid/environ 2>/dev/null | tr '\0' '\n' | grep -qx 'REAL_PAYMENTS_ENABLED=true'; then echo ON; else echo off; fi
}
spendable() { Q "SELECT (fleet_agent_wallet_measure('$A1') ->> 'spendableMinor')"; }
START() { cat "$D/proof-start.txt" 2>/dev/null; }
WINDOW() { cat "$D/refund-window.txt" 2>/dev/null; }
CEILING=0; SP0=0; [[ -f "$D/proof-terms.txt" ]] && read -r CEILING SP0 < "$D/proof-terms.txt"
ORDER() { Q "SELECT order_id FROM fleet_customer_orders WHERE owner_proof AND agent_id = '$A1' AND created_at >= '$(START)' ORDER BY created_at LIMIT 1"; }
QUEUED() { Q "SELECT count(*) FROM fleet_paypal_refund_requests WHERE status IN ('requested','sent')"; }
OTHER_REFUNDS() { Q "SELECT count(*) FROM fleet_paypal_refund_requests WHERE order_id IS DISTINCT FROM NULLIF('$1','')::uuid AND (status IN ('requested','sent') OR created_at >= '$(START)')"; }
closed() {
  [[ "$(Q 'SELECT count(*) FROM fleet_outward_release WHERE expires_at > now()')" == 0 && "$(Q 'SELECT card_enabled OR enabled FROM fleet_identity_autonomy')" == f \
     && "$(Q 'SELECT fleet_sales_open()')" == f ]]
}
guard() {
  [[ "$(current)" == */$REL && "$(pinned)" == "$REL" ]] || die "the installed and pinned release is not ${REL:0:7}"
  [[ "$(Q "SELECT runtime_commit FROM fleet_agents WHERE agent_id='$A1'")" == "$REL" ]] || die "Agent-1 is not on ${REL:0:7}"
  for k in REAL_REPLICATION_ENABLED REAL_PAYMENTS_ENABLED OWNER_SWEEP_ENABLED FLEET_DRY_RUN_CHILD; do flag_false $k || die "$k is not false in runtime.env"; done
  [[ "$(paused $A2)" == t ]] || die "Agent-2 is NOT paused"
  closed || die "sales, card authority or an outward release is open"
  [[ "$(live_signers)" == 0 ]] || die "a payout signer is configured"
}
moneyout() {
  echo "  ┌ EFFECTIVE MONEY-OUT (this, not Fleet HQ's realPaymentsEnabled=false, says whether a refund can leave)"
  echo "  │ custody refund switch: running process $(switch_effective); drop-in $(switch_file)"
  echo "  │ custody money-out activation: $(custody | jq -c '.activation')"
  echo "  │ refund window: $(WINDOW)$( [[ -z "$(WINDOW)" ]] && echo 'not open')"
  echo "  └ refunds queued in the whole Fleet: $(QUEUED)"
}
results() {
  local o=$1 by
  [[ -n "$o" ]] || { echo "  ACCEPTANCE: no proof order yet"; return; }
  echo "  ACCEPTANCE RESULTS"
  echo "    purchase: captured $(Q "SELECT count(*) FROM fleet_events WHERE event_type = 'offer_proof_captured' AND agent_id = '$A1' AND created_at >= '$(START)'")× as owner funding (not revenue); order $(Q "SELECT payment_status || ' / ' || status FROM fleet_customer_orders WHERE order_id = '$o'")"
  echo "    delivery: $(Q "SELECT count(*) FROM fleet_order_deliveries WHERE order_id = '$o'") delivery record(s)"
  echo "    support: buyer messages $(Q "SELECT count(*) FROM fleet_customer_messages WHERE order_id = '$o' AND author = 'buyer'"), Agent-1 replies $(Q "SELECT count(*) FROM fleet_customer_messages WHERE order_id = '$o' AND author = 'agent'"); revision delivered: $(Q "SELECT CASE WHEN count(*) >= 2 THEN 'yes' ELSE 'no' END FROM fleet_order_deliveries WHERE order_id = '$o'")"
  by=$(Q "SELECT requested_by FROM fleet_paypal_refund_requests WHERE order_id = '$o' ORDER BY created_at LIMIT 1")
  case "$by" in
    agent) echo "    refund handling: AGENT-APPROVED (Agent-1 requested it: order.refund)";;
    operator:*) echo "    refund handling: OWNER OVERRIDE ($by) — Agent-1's refund handling NOT shown; its replies above are the record of what it did";;
    "") echo "    refund handling: none yet";;
    *) echo "    refund handling: requested by $by";;
  esac
  echo "    refund executed: $(Q "SELECT COALESCE(jsonb_agg(jsonb_build_object('status', status, 'amountMinor', amount_minor, 'paypal', paypal_refund_id IS NOT NULL)), '[]') FROM fleet_paypal_refund_requests WHERE order_id = '$o'"); returned as owner capital: $(Q "SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', kind, 'amountMinor', amount_minor)), '[]') FROM fleet_offer_proof_returns r JOIN fleet_customer_orders z ON z.checkout_id = r.checkout_id WHERE z.order_id = '$o'")"
  echo "    PayPal's fee on the capture (actual, from the books): $(Q "SELECT c.amount_minor - COALESCE((SELECT sum(p.amount_cents) FROM fleet_ledger_postings p WHERE p.journal_id = c.journal_id AND p.account_id = 'fleet:owner:capital'), c.amount_minor) FROM fleet_paypal_checkouts c JOIN fleet_customer_orders z ON z.checkout_id = c.checkout_id WHERE z.order_id = '$o' AND c.journal_id IS NOT NULL")p"
  local now; now=$(spendable)
  echo "    Agent-1 wallet hold: spendable at start ${SP0}p, now ${now}p ($( [[ "$now" == "$SP0" ]] && echo released || echo HELD))"
}
report() {
  local s o; s=$(START); [[ -n "$s" ]] || { echo "  no proof recorded"; moneyout; return; }; o=$(ORDER)
  echo "  started $s; now $(ts); Agent-1 paused=$(paused $A1); Agent-2 paused=$(paused $A2); sales open=$(Q 'SELECT fleet_sales_open()')"
  moneyout
  echo "  run budget: $(Q "SELECT fleet_admin_cognition_run('$A1')" | jq -c '{ceilingMinor, spentPence: (.spentMicro/1000000), inflightPence: (.inflightMicro/1000000), calls, open, endsAt, endReason}')"
  echo "  model calls since start: $(Q "SELECT count(*)||' ('||COALESCE(sum(input_tokens),0)||' in, '||COALESCE(sum(cache_read_tokens),0)||' cache-read, '||COALESCE(sum(output_tokens),0)||' out), provider \$'||round(COALESCE(sum(provider_usd_microcents),0)/1e8,4)||', charged '||COALESCE(sum(charged_cents),0)||'p (Fleet-recorded, provisional)' FROM fleet_cognition_log WHERE agent_id='$A1' AND at >= '$s'")"
  results "$o"
  echo "  uncertain outcomes: $(Q "SELECT count(*) FROM fleet_notifications WHERE code = 'OPERATION_UNCERTAIN' AND agent_id = '$A1' AND created_at >= '$s'"); AGENT_CANNOT_THINK: $(Q "SELECT count(*) FROM fleet_notifications WHERE code='AGENT_CANNOT_THINK' AND agent_id='$A1' AND created_at >= '$s'")"
  echo "  its closing notes (last 5):"; Q "SELECT '    '||to_char(at,'HH24:MI')||' '||left(regexp_replace(COALESCE(outcome,''),'\s+',' ','g'),160) FROM fleet_agent_mind_reports WHERE agent_id='$A1' AND at >= '$s' AND COALESCE(outcome,'') <> '' ORDER BY at DESC LIMIT 5"
  echo "  ledger verify $(Q "SELECT fleet_ledger_verify()->>'ok'")"
}
# The refund window: money-out and custody's refund switch, opened only for the one bound refund.
window_open() {
  local o=$1 rid; rid=$(Q "SELECT request_id FROM fleet_paypal_refund_requests WHERE order_id = '$o' AND status = 'requested' ORDER BY created_at LIMIT 1")
  A economy-custody-activate $PRICE_MAX $PRICE_MAX $WINDOW_HOURS "purchase proof: refund request $rid of the owner's £5 proof purchase only" >/dev/null 2>&1 || return 1
  printf '%s\n' "# purchase proof $(START): refund window for request $rid — removed by fleet-purchase-proof.sh stop" "[Service]" "Environment=REAL_PAYMENTS_ENABLED=true" \
    | { sudo -n mkdir -p "$(dirname $DROPIN)" && sudo -n tee $DROPIN >/dev/null; } && sudo -n chmod 0644 $DROPIN && sudo -n systemctl daemon-reload \
    && sudo -n systemctl restart $CUSTODY && sudo -n systemctl is-active --quiet $CUSTODY || return 1
  echo "opened $(ts) for refund request $rid (order $o); money-out ${WINDOW_HOURS} h" > "$D/refund-window.txt"
}
window_close() {
  A economy-custody-deactivate "purchase proof: refund window closed" >/dev/null 2>&1 || true
  if [[ -f $DROPIN ]]; then sudo -n rm -f $DROPIN && sudo -n systemctl daemon-reload && sudo -n systemctl restart $CUSTODY || return 1; fi
  if [[ -f "$D/refund-window.txt" ]]; then mv "$D/refund-window.txt" "$D/refund-window.closed-$(date -u +%Y%m%dT%H%M%SZ).txt"; fi
  return 0
}
stop_proof() {
  local why="$1" bad=0
  A founder-cognition $A1 pause "purchase proof stopped: $why" >/dev/null 2>&1 || bad=1
  A cognition-run $A1 end "$why" >/dev/null 2>&1 || true
  window_close || bad=1
  sudo -n systemctl stop $UNIT.timer $UNIT.service >/dev/null 2>&1 || true
  [[ "$(paused $A1)" == t ]] || bad=1
  [[ "$(activation_live)" == false ]] || bad=1
  [[ "$(switch_file)" == absent && "$(switch_effective)" != ON ]] || bad=1
  report
  [[ $bad == 0 ]] || die "a stop step failed — Agent-1 paused=$(paused $A1); money-out $(activation_live); refund switch $(switch_effective); re-run stop"
  echo "== PROOF STOPPED $(ts): $why — Agent-1 paused; run budget ended; money-out OFF; custody refund switch OFF (process and drop-in)"
}
if [[ -n "${FLEET_PROOF_STUBS:-}" ]]; then source "$FLEET_PROOF_STUBS"; fi
[[ $EUID -eq 0 ]] || sudo -v || exit 2

case "${1:-}" in
start)
  [[ "${2:-}" =~ ^[0-9]+$ ]] && (( $2 > 0 && $2 <= 1000 )) || die "usage: start <aiCeilingPence> (1..1000; the owner's approved AI ceiling)"
  guard
  [[ "$(paused $A1)" == t ]] || die "Agent-1 is already running"
  [[ "$(activation_live)" == false && "$(switch_file)" == absent && "$(switch_effective)" != ON ]] || die "money-out or custody's refund switch is already on"
  [[ "$(Q 'SELECT count(*) FROM fleet_cognition_run_budgets WHERE ended_at IS NULL')" == 0 ]] || die "a run budget is already open"
  [[ "$(Q 'SELECT count(*) FROM fleet_customer_orders WHERE owner_proof')" == 0 ]] || die "a proof purchase already exists"
  [[ "$(QUEUED)" == 0 ]] || die "refunds are already queued: the window must serve only this proof's refund"
  [[ "$(Q "SELECT count(*) FROM fleet_paypal_checkouts c WHERE c.status = 'captured' AND c.purpose = 'agent_sale' AND fleet_paypal_refundable(c.checkout_id) > 0")" == 0 ]] \
    || die "another refundable sale exists: the window must serve only this proof's refund"
  sp=$(spendable); [[ "$sp" =~ ^[0-9]+$ ]] && (( sp >= PRICE_MAX )) || die "Agent-1's spendable cash (${sp:-?}p) cannot bear the £5 refund hold (limit 21)"
  [[ "$(Q "SELECT count(*) FROM fleet_offers o JOIN fleet_artifact_reviews r ON r.review_id = o.review_id
          WHERE o.slug = '$SLUG' AND o.agent_id = '$A1' AND o.status = 'published' AND o.kind = 'product' AND o.price_minor <= $PRICE_MAX
            AND r.verdict = 'pass' AND r.files_digest = fleet_files_digest(fleet_offer_deliverables(o.offer_id))")" == 1 ]] \
    || die "the offer $SLUG is not Agent-1's published product at most £5 on a passing review of its current files"
  echo "$2 $sp" > "$D/proof-terms.txt"; CEILING=$2; SP0=$sp; ts > "$D/proof-start.txt"
  echo "  money-out stays OFF: the refund window opens only for this proof order's refund (the watchdog checks it is the only one)"
  echo "  1. Agent-1's run budget $(printf '£%d.%02d' $((CEILING / 100)) $((CEILING % 100))) for ${HOURS} h (checked before every model request); spendable at start ${SP0}p"
  A cognition-run $A1 start $CEILING $HOURS "purchase proof: AI ceiling ${CEILING}p" | jq -c '.run | {ceilingMinor, endsAt}' || die "run budget not opened (nothing else changed)"
  echo "  2. watchdog every minute"
  sudo -n systemd-run --quiet --unit $UNIT --setenv=FLEET_PROOF_DIR="$D" --on-active=1min --on-unit-active=1min /bin/bash "$SELF" watch \
    || { stop_proof "watchdog not armed"; exit 1; }
  echo "  3. resume Agent-1"
  A founder-cognition $A1 resume "purchase proof (owner approval): AI ceiling ${CEILING}p, ${HOURS} h; public sales stay closed" | jq -c '{paused}' || { stop_proof "resume failed"; exit 1; }
  echo "== PROOF STARTED $(START): sales closed; card authority off; no outward release; money-out off; Agent-2 paused. Next: buy"; report ;;
buy)
  [[ -n "$(START)" && "$(paused $A1)" == f ]] || die "start the proof first"
  guard
  r=$(A economy-offer-proof $SLUG 2>&1); echo "$r" | jq -c '{ok, replay, page, amountMinor, currency, note}' 2>/dev/null || echo "$r" | head -5
  [[ "$(jq -r '.ok' <<< "$r" 2>/dev/null)" == true ]] || die "the proof purchase could not be opened"
  echo "== OPEN THE ORDER PAGE ABOVE AND PAY WITH PAYPAL ($(ts)). Then write your change request on the order page; then ask there for a refund." ;;
refund)
  [[ -n "$(START)" ]] || die "start the proof first"
  guard; o=$(ORDER); [[ -n "$o" ]] || die "no proof order yet"
  why=${2:-"purchase proof: OWNER OVERRIDE refund of the proof purchase"}
  r=$(A economy-order-refund "$o" all "$why" 2>&1); echo "$r" | jq -c '{ok, replay, refund, code, reason}' 2>/dev/null || echo "$r" | head -5
  [[ "$(jq -r '.ok' <<< "$r" 2>/dev/null)" == true ]] || die "the refund could not be requested"
  echo "== OWNER OVERRIDE REFUND REQUESTED $(ts): recorded as the owner's, not Agent-1's; the watchdog opens the refund window for it" ;;
status) report ;;
stop) stop_proof "${2:-stopped by the owner}" ;;
watch)
  s=$(START); [[ -n "$s" && "$(paused $A1)" == f ]] || { sudo -n systemctl stop $UNIT.timer >/dev/null 2>&1; exit 0; }
  o=$(ORDER)
  (( $(OTHER_REFUNDS "$o") > 0 )) && { stop_proof "FAILURE: a refund on another order — the window serves only this proof's refund"; exit 0; }
  (( $(Q "SELECT count(*) FROM fleet_customer_orders WHERE owner_proof AND created_at >= '$s'") > 1 )) && { stop_proof "FAILURE: a second proof order"; exit 0; }
  if [[ -n "$o" ]]; then
    (( $(Q "SELECT count(*) FROM fleet_paypal_refund_requests WHERE order_id = '$o'") > 1 )) && { stop_proof "FAILURE: a second refund request on the proof order"; exit 0; }
    (( $(Q "SELECT count(DISTINCT paypal_refund_id) FROM fleet_paypal_refund_requests WHERE order_id = '$o'") > 1 )) && { stop_proof "FAILURE: a second PayPal refund"; exit 0; }
    (( $(Q "SELECT count(*) FROM fleet_order_deliveries WHERE order_id = '$o'") > MAX_DELIVERIES )) && { stop_proof "FAILURE: more deliveries than the delivery and one revision"; exit 0; }
    if [[ "$(Q "SELECT count(*) FROM fleet_paypal_refund_requests WHERE order_id = '$o' AND status = 'completed'")" == 1 \
          && "$(Q "SELECT count(*) FROM fleet_offer_proof_returns r JOIN fleet_customer_orders z ON z.checkout_id = r.checkout_id WHERE z.order_id = '$o' AND r.kind = 'refund'")" -ge 1 \
          && "$(Q "SELECT fleet_ledger_verify()->>'ok'")" == true ]]; then
      [[ "$(spendable)" == "$SP0" ]] || { stop_proof "FAILURE: the refund is recorded but Agent-1's wallet hold is not released (spendable $(spendable)p, ${SP0}p at start)"; exit 0; }
      stop_proof "PROOF COMPLETE: purchase, delivery and refund recorded once; Agent-1's wallet hold released; the ledger verifies"; exit 0
    fi
    # The refund window: only for the one bound refund (this order's, at most what was paid, the only one queued anywhere).
    if [[ -z "$(WINDOW)" && "$(QUEUED)" == 1 \
          && "$(Q "SELECT count(*) FROM fleet_paypal_refund_requests x JOIN fleet_customer_orders z ON z.order_id = x.order_id WHERE x.order_id = '$o' AND x.status = 'requested' AND x.amount_minor <= z.amount_minor AND z.owner_proof")" == 1 ]]; then
      window_open "$o" || { stop_proof "FAILURE: the refund window could not be opened"; exit 0; }
    fi
    if [[ -n "$(WINDOW)" && -n "$(find "$D/refund-window.txt" -mmin +$QUIET_MIN 2>/dev/null)" \
          && "$(Q "SELECT count(*) FROM fleet_paypal_refund_requests WHERE order_id = '$o' AND status IN ('requested','sent')")" != 0 ]]; then
      stop_proof "FAILURE: the refund was not completed $QUIET_MIN minutes after the window opened"; exit 0
    fi
    [[ "$(Q "SELECT EXISTS (SELECT 1 FROM fleet_customer_messages b WHERE b.order_id = '$o' AND b.author = 'buyer' AND b.created_at < now() - interval '$QUIET_MIN minutes'
             AND NOT EXISTS (SELECT 1 FROM fleet_customer_messages a WHERE a.order_id = '$o' AND a.author = 'agent' AND a.created_at > b.created_at)
             AND NOT EXISTS (SELECT 1 FROM fleet_cognition_log c WHERE c.agent_id = '$A1' AND c.at > b.created_at))")" == t ]] \
      && { stop_proof "FAILURE: a buyer message unanswered for $QUIET_MIN minutes"; exit 0; }
  fi
  run=$(Q "SELECT fleet_admin_cognition_run('$A1')")
  [[ "$(jq -r '.open' <<< "$run")" == true ]] || { stop_proof "the AI ceiling is spent or ${HOURS} h are up"; exit 0; }
  (( $(jq -r '(.spentMicro + .inflightMicro) / 1000000 | floor' <<< "$run") >= CEILING - 5 )) && { stop_proof "the AI ceiling is (nearly) spent"; exit 0; }
  (( $(Q "SELECT count(*) FROM fleet_notifications WHERE code = 'OPERATION_UNCERTAIN' AND agent_id = '$A1' AND created_at >= '$s'") > 0 )) \
    && { stop_proof "an outcome is uncertain: check it and resolve it (fleet operations-uncertain)"; exit 0; }
  (( $(Q "SELECT count(*) FROM fleet_notifications WHERE code = 'AGENT_CANNOT_THINK' AND agent_id = '$A1' AND created_at >= '$s'") > 0 )) && { stop_proof "FAILURE: the agent cannot think (packet)"; exit 0; }
  last=$(Q "SELECT GREATEST('$s'::timestamptz, COALESCE((SELECT max(created_at) FROM fleet_events WHERE agent_id = '$A1' AND created_at >= '$s'
              AND event_type IN ('offer_proof_captured','customer_message_received','order_refund_requested')), '$s'::timestamptz))")
  (( $(Q "SELECT count(*) FROM fleet_cognition_log WHERE agent_id = '$A1' AND at > '$last'") > MAX_IDLE_CALLS )) \
    && { stop_proof "FAILURE: $MAX_IDLE_CALLS model calls without a new customer event"; exit 0; }
  exit 0 ;;
*) sed -n 2,27p "$0"; exit 2 ;;
esac
