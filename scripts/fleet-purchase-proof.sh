#!/usr/bin/env bash
# Automaton Fleet — the owner's purchase proof of Agent-1's private offer, CONTINUED on the existing unpaid proof order
# (opened 2026-10-19 11:04:57Z, blocked by the order-page defect, row 23; launch-readiness §2, "Purchase proof").
# payment → delivery → the customer's fault report → Agent-1's response → corrected delivery → refund → provider and
# ledger reconciliation, with PUBLIC SALES CLOSED. A test of the transaction system, not demand, revenue or approval of the
# product. Agent-1 only; Agent-2 stays paused. Starts ONLY on the owner's approval of its terms. NEVER creates another order.
#
#   bash fleet-purchase-proof.sh start <aiCeilingPence>
#       guards (the release, flags, Agent-2, sales / card / releases closed, no payout signer, no standing refund authority,
#       exactly the one existing proof order, unpaid, its checkout still open) → Agent-1's run budget (24 h) → the watchdog
#       (every minute) → resume Agent-1. Money-out stays OFF.
#   bash fleet-purchase-proof.sh continue
#       (2026-10-19, after the repair release) resumes the SAME proof on its paid order within the run budget it already has —
#       never a new budget, ceiling or end time: guards → the run is still open with ceiling and time left → the watchdog →
#       resume Agent-1. The quiet periods the watchdog measures start again at the resume (time Agent-1 was paused by the
#       owner is not time it left a buyer unanswered).
#   … buy            prints the EXISTING order's page (no new order, no new payment): pay it with PayPal yourself, from an
#                    account other than the treasury's
#   … refund [why]   the owner's override: refund the proof order in full (recorded as an OWNER OVERRIDE, not as the agent's
#                    refund handling)
#   … status         read-only progress, the effective money-out setting and the acceptance results
#   … stop [why]     pause Agent-1, end the run budget, end the proof's refund authority, custody's refund switch off, the
#                    watchdog off; verified
#   (watch)          the watchdog. When the proof order's refund is requested it opens the REFUND WINDOW: a refund
#                    authority for THIS ORDER ONLY (custody enforces it when it sends: at most £5, £5 in total, 2 h —
#                    schema v96) and custody's own refund switch (REAL_PAYMENTS_ENABLED=true for the custody unit only;
#                    runtime.env is unchanged, so Fleet HQ keeps showing false — never read that as "money-out is off").
#                    Stops when the refund is done. FULL SUCCESS needs all of: the customer journey — Agent-1 answered
#                    after the buyer's fault report, a corrected delivery was SENT after it, and the files of that delivery
#                    passed inspector fleet-qa-3 (verdict pass, automated checks ok) — and the money — the refund recorded
#                    once, bound to the proof's authority, as owner capital; its reservation released; PayPal holds none
#                    of Agent-1's money; Agent-1's wallet reconciled journal by journal; the ledger verifies. A refund
#                    without the journey ends the proof as NOT a full proof (named what is missing).
#                    Also stops on: a second proof order, refund request or PayPal refund; a third
#                    delivery; an uncertain outcome; a buyer message unanswered 30 min; 40 model calls without a new
#                    customer event; a refund not completed 30 min after the window opened; the AI ceiling; 24 h. Waiting
#                    for the buyer never stops it.
# Never: public sales, card authority, an outward release, payouts, a standing refund authority, Agent-2, sweep, sizing,
# the cap, the fuses, runtime.env. The exit status is the real one; the log is complete when the script returns.
set -uo pipefail
export PATH=/opt/automaton-fleet/node/bin:$PATH
D="${FLEET_PROOF_DIR:-$HOME/fleet-proof2}"; mkdir -p "$D"
SELF=$(readlink -f "${BASH_SOURCE[0]}"); ARGS=("$@")
if [[ "${FLEET_TEELOG:-}" != "$SELF" ]]; then set +e; FLEET_TEELOG="$SELF" bash "$SELF" "${ARGS[@]}" 2>&1 | tee -a "$D/proof.log"; exit "${PIPESTATUS[0]}"; fi
unset FLEET_TEELOG

A1=01M3F50SH7PNX2E3GST13J52AS; A2=01M4C4NXT786Q4E9725N5A15KV
REL=0000000000000000000000000000000000000000   # Agent-1's runtime; set when staged
CTRL=$REL                                       # the installed controller release (a controller-only fix may follow REL); set when staged
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
authorities() { custody | jq -c '.refundAuthorities // []'; }
switch_file() { [[ -f $DROPIN ]] && echo present || echo absent; }
# What the running custody process actually has (only this key is read; nothing else of its environment is printed).
switch_effective() {
  local pid; pid=$(sudo -n systemctl show -p MainPID --value $CUSTODY 2>/dev/null)
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || { echo "custody not running"; return; }
  if sudo -n cat /proc/$pid/environ 2>/dev/null | tr '\0' '\n' | grep -qx 'REAL_PAYMENTS_ENABLED=true'; then echo ON; else echo off; fi
}
spendable() { Q "SELECT (fleet_agent_wallet_measure('$A1') ->> 'spendableMinor')"; }
START() { cat "$D/proof-start.txt" 2>/dev/null; }
# When Agent-1 last resumed under this proof (start, or a continue after an owner pause).
RESUMED() { tail -1 "$D/proof-resumed.txt" 2>/dev/null || START; }
WINDOW() { cat "$D/refund-window.txt" 2>/dev/null; }
AUTH() { cat "$D/refund-authority.txt" 2>/dev/null; }
CEILING=0; SP0=0; [[ -f "$D/proof-terms.txt" ]] && read -r CEILING SP0 < "$D/proof-terms.txt"
# The one proof order there is (opened 2026-10-19 11:04:57Z); never a new one.
ORDER() { Q "SELECT order_id FROM fleet_customer_orders WHERE owner_proof AND agent_id = '$A1' ORDER BY created_at LIMIT 1"; }
closed() {
  [[ "$(Q 'SELECT count(*) FROM fleet_outward_release WHERE expires_at > now()')" == 0 && "$(Q 'SELECT card_enabled OR enabled FROM fleet_identity_autonomy')" == f \
     && "$(Q 'SELECT fleet_sales_open()')" == f ]]
}
guard() {
  [[ "$(current)" == */$CTRL && "$(pinned)" == "$CTRL" ]] || die "the installed and pinned release is not ${CTRL:0:7}"
  [[ "$(Q "SELECT runtime_commit FROM fleet_agents WHERE agent_id='$A1'")" == "$REL" ]] || die "Agent-1 is not on ${REL:0:7}"
  for k in REAL_REPLICATION_ENABLED REAL_PAYMENTS_ENABLED OWNER_SWEEP_ENABLED FLEET_DRY_RUN_CHILD; do flag_false $k || die "$k is not false in runtime.env"; done
  [[ "$(paused $A2)" == t ]] || die "Agent-2 is NOT paused"
  closed || die "sales, card authority or an outward release is open"
  [[ "$(live_signers)" == 0 ]] || die "a payout signer is configured"
  [[ "$(Q "SELECT count(*) FROM fleet_refund_authorities a WHERE a.scope = 'standing' AND fleet_refund_authority_live(a)")" == 0 ]] || die "a standing refund authority is live"
}
moneyout() {
  echo "  ┌ EFFECTIVE MONEY-OUT (this, not Fleet HQ's realPaymentsEnabled=false, says whether a refund can leave)"
  echo "  │ custody refund switch: running process $(switch_effective); drop-in $(switch_file)"
  echo "  │ live refund authorities (custody enforces them when it sends): $(authorities)"
  echo "  │ refund window: $(WINDOW)$( [[ -z "$(WINDOW)" ]] && echo 'not open')"
  echo "  └ payouts: live payout signers $(live_signers) (none: no payout can leave)"
}
# Agent-1's cash since the start, journal by journal: "kind amount" lines (+ in, − out).
journals() {
  Q "SELECT j.kind || ' ' || sum(CASE p.side WHEN 'D' THEN p.amount_cents ELSE -p.amount_cents END) || ' ' || count(DISTINCT j.journal_id)
       FROM fleet_ledger_postings p JOIN fleet_ledger_journal j ON j.journal_id = p.journal_id
      WHERE p.account_id = fleet_ledger_account('$A1', 'agent_cash') AND j.recorded_at >= '$(START)' GROUP BY j.kind ORDER BY j.kind"
}
cash_moved() { journals | awk '{s += $2} END {print s + 0}'; }
# The customer journey on the order $1: "replied corrected inspected" (t/f each). replied: an Agent-1 message after the
# buyer's first message; corrected: a delivery SENT after that message; inspected: the latest sent delivery's review is
# fleet-qa-3, pass, automated checks ok (the review gate already binds it to exactly the delivered files).
journey() {
  Q "WITH b AS (SELECT min(created_at) AS at FROM fleet_customer_messages WHERE order_id = '$1' AND author = 'buyer'),
          d AS (SELECT d.* FROM fleet_order_deliveries d WHERE d.order_id = '$1' AND d.status = 'sent' ORDER BY d.created_at DESC LIMIT 1)
     SELECT (EXISTS (SELECT 1 FROM fleet_customer_messages m, b WHERE m.order_id = '$1' AND m.author = 'agent' AND m.created_at > b.at))::text || ' '
         || (EXISTS (SELECT 1 FROM fleet_order_deliveries x, b WHERE x.order_id = '$1' AND x.status = 'sent' AND x.created_at > b.at))::text || ' '
         || COALESCE((SELECT (r.inspector = 'fleet-qa-3' AND r.verdict = 'pass' AND r.automated_ok)::text FROM d JOIN fleet_artifact_reviews r ON r.review_id = d.review_id), 'false')"
}
results() {
  local o=$1 by k
  [[ -n "$o" ]] || { echo "  ACCEPTANCE: no proof order"; return; }
  echo "  ACCEPTANCE RESULTS"
  echo "    purchase: captured $(Q "SELECT count(*) FROM fleet_events WHERE event_type = 'offer_proof_captured' AND agent_id = '$A1'")× as owner funding (not revenue); order $(Q "SELECT payment_status || ' / ' || status FROM fleet_customer_orders WHERE order_id = '$o'")"
  echo "    delivery: $(Q "SELECT count(*) FROM fleet_order_deliveries WHERE order_id = '$o'") delivery record(s): $(Q "SELECT COALESCE(string_agg(to_char(created_at,'HH24:MI') || ' ' || status || COALESCE(' (' || left(resend_reason, 60) || ')', ''), '; ' ORDER BY created_at), '') FROM fleet_order_deliveries WHERE order_id = '$o'")"
  echo "    support: buyer messages $(Q "SELECT count(*) FROM fleet_customer_messages WHERE order_id = '$o' AND author = 'buyer'"), Agent-1 replies $(Q "SELECT count(*) FROM fleet_customer_messages WHERE order_id = '$o' AND author = 'agent'"); revision delivered: $(Q "SELECT CASE WHEN count(*) >= 2 THEN 'yes' ELSE 'no' END FROM fleet_order_deliveries WHERE order_id = '$o'")"
  echo "    reviews of the delivered files: $(Q "SELECT COALESCE(string_agg(r.inspector || ' ' || r.verdict || ' (automated ' || r.automated_ok || ')', '; ' ORDER BY r.created_at), 'none') FROM fleet_artifact_reviews r WHERE r.order_id = '$o' OR (r.offer_id = (SELECT offer_id FROM fleet_customer_orders WHERE order_id = '$o') AND r.created_at >= '$(START)')")"
  by=$(Q "SELECT requested_by FROM fleet_paypal_refund_requests WHERE order_id = '$o' ORDER BY created_at LIMIT 1")
  case "$by" in
    agent) echo "    refund handling: AGENT-APPROVED (Agent-1 requested it: order.refund)";;
    operator:*) echo "    refund handling: OWNER OVERRIDE ($by) — this proves the refund infrastructure, not Agent-1's refund judgement; its replies above are the record of what it did";;
    "") echo "    refund handling: none yet";;
    *) echo "    refund handling: requested by $by";;
  esac
  echo "    THIS proof's refund reservation: $(Q "SELECT COALESCE(jsonb_agg(jsonb_build_object('requestId', x.request_id, 'status', x.status, 'amountMinor', x.amount_minor, 'authorityId', x.authority_id,
        'boundToProofAuthority', x.authority_id IS NOT DISTINCT FROM NULLIF('$(AUTH)', '')::uuid, 'paypalRefund', x.paypal_refund_id IS NOT NULL,
        'stillSetAside', x.status IN ('requested','sent','pending')) ORDER BY x.created_at), '[]') FROM fleet_paypal_refund_requests x WHERE x.order_id = '$o'")"
  echo "    returned as owner capital: $(Q "SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', r.kind, 'amountMinor', r.amount_minor)), '[]') FROM fleet_offer_proof_returns r JOIN fleet_customer_orders z ON z.checkout_id = r.checkout_id WHERE z.order_id = '$o'")"
  echo "    PayPal's fee on the capture (actual, from the books): $(Q "SELECT c.amount_minor - COALESCE((SELECT sum(p.amount_cents) FROM fleet_ledger_postings p WHERE p.journal_id = c.journal_id AND p.account_id = 'fleet:owner:capital'), c.amount_minor) FROM fleet_paypal_checkouts c JOIN fleet_customer_orders z ON z.checkout_id = c.checkout_id WHERE z.order_id = '$o' AND c.journal_id IS NOT NULL")p (PayPal sets it; what it returns on the refund is in the returns above)"
  echo "    PayPal-held money of Agent-1 (its own sales; separate from this refund): $(Q "SELECT (fleet_agent_wallet_measure('$A1') -> 'ownHeldMinor')::text || ', exposure ' || (fleet_agent_wallet_measure('$A1') ->> 'paypalDisputeExposureMinor')")"
  echo "    Agent-1's cash since the start, journal by journal (+ in / − out, journals):"
  journals | sed 's/^/      /'
  local ai acq now moved; ai=$(journals | awk '$1 == "inference_charge" {print -$2}'); acq=$(journals | awk '$1 == "ai_credit_acquisition_cost" {print -$2}')
  echo "    AI: model usage at the credit's price ${ai:-0}p + the unrecoverable tax / fees on that credit ${acq:-0}p (receipt-based ratio of its lot) — one cost in two parts, never the same cost twice; Fleet-recorded, provisional until reconciled with Anthropic"
  local jr jc ji; read -r jr jc ji <<< "$(journey "$o")"
  echo "    CUSTOMER JOURNEY: Agent-1 answered the fault report: ${jr:-false}; corrected delivery sent after it: ${jc:-false}; delivered files passed fleet-qa-3: ${ji:-false}"
  now=$(spendable); moved=$(cash_moved)
  echo "    Agent-1 wallet: ${SP0}p at start $( (( moved < 0 )) && echo "− ${moved#-}p" || echo "+ ${moved}p") (the journals above) = $(( SP0 + moved ))p expected; spendable now ${now}p ($( [[ "$now" == "$(( SP0 + moved ))" ]] && echo reconciled || echo "NOT RECONCILED by $(( now - SP0 - moved ))p"))"
}
report() {
  local s o; s=$(START); [[ -n "$s" ]] || { echo "  no proof recorded"; moneyout; return; }; o=$(ORDER)
  echo "  started $s; now $(ts); Agent-1 paused=$(paused $A1); Agent-2 paused=$(paused $A2); sales open=$(Q 'SELECT fleet_sales_open()')"
  moneyout
  echo "  run budget: $(Q "SELECT fleet_admin_cognition_run('$A1')" | jq -c '{ceilingMinor, spentPence: (.spentMicro/1000000), inflightPence: (.inflightMicro/1000000), calls, open, endsAt, endReason}')"
  echo "  model calls since start: $(Q "SELECT count(*)||' ('||COALESCE(sum(input_tokens),0)||' in, '||COALESCE(sum(cache_read_tokens),0)||' cache-read, '||COALESCE(sum(output_tokens),0)||' out), provider \$'||round(COALESCE(sum(provider_usd_microcents),0)/1e8,4)||', charged '||COALESCE(sum(charged_cents),0)||'p (Fleet-recorded, provisional)' FROM fleet_cognition_log WHERE agent_id='$A1' AND at >= '$s'")"
  echo "  Fleet Control's own AI (treasury-paid, its own budget): $(A hub-fleet-control-ai 2>/dev/null | jq -c '{ceilingMinor, spentMinor, inflightMinor}')"
  results "$o"
  echo "  uncertain outcomes: $(Q "SELECT count(*) FROM fleet_notifications WHERE code = 'OPERATION_UNCERTAIN' AND agent_id = '$A1' AND created_at >= '$s'"); AGENT_CANNOT_THINK: $(Q "SELECT count(*) FROM fleet_notifications WHERE code='AGENT_CANNOT_THINK' AND agent_id='$A1' AND created_at >= '$s'")"
  echo "  its closing notes (last 5):"; Q "SELECT '    '||to_char(at,'HH24:MI')||' '||left(regexp_replace(COALESCE(outcome,''),'\s+',' ','g'),160) FROM fleet_agent_mind_reports WHERE agent_id='$A1' AND at >= '$s' AND COALESCE(outcome,'') <> '' ORDER BY at DESC LIMIT 5"
  echo "  ledger verify $(Q "SELECT fleet_ledger_verify()->>'ok'")"
}
# The refund window: a refund authority for the proof order ONLY (custody enforces scope, amount, total and expiry) and
# custody's own refund switch.
window_open() {
  local o=$1 r id
  r=$(A economy-refund-authority-grant "$o" $PRICE_MAX $PRICE_MAX $PRICE_MAX $WINDOW_HOURS "purchase proof: the owner's £5 proof order only" 2>&1)
  id=$(jq -r '.authorityId // empty' <<< "$r" 2>/dev/null); [[ -n "$id" ]] || return 1
  echo "$id" > "$D/refund-authority.txt"
  printf '%s\n' "# purchase proof $(START): refunds within refund authority $id (order $o) — removed by fleet-purchase-proof.sh stop" "[Service]" "Environment=REAL_PAYMENTS_ENABLED=true" \
    | { sudo -n mkdir -p "$(dirname $DROPIN)" && sudo -n tee $DROPIN >/dev/null; } && sudo -n chmod 0644 $DROPIN && sudo -n systemctl daemon-reload \
    && sudo -n systemctl restart $CUSTODY && sudo -n systemctl is-active --quiet $CUSTODY || return 1
  echo "opened $(ts): refund authority $id for order $o only (≤ ${PRICE_MAX}p, ${PRICE_MAX}p in total, ${WINDOW_HOURS} h)" > "$D/refund-window.txt"
}
window_close() {
  local id; id=$(AUTH)
  if [[ -n "$id" ]]; then A economy-refund-authority-end "$id" "purchase proof: refund window closed" >/dev/null 2>&1 || return 1; fi
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
  [[ "$(authorities)" == "[]" ]] || bad=1
  [[ "$(switch_file)" == absent && "$(switch_effective)" != ON ]] || bad=1
  report
  [[ $bad == 0 ]] || die "a stop step failed — Agent-1 paused=$(paused $A1); refund authorities $(authorities); refund switch $(switch_effective); re-run stop"
  echo "== PROOF STOPPED $(ts): $why — Agent-1 paused; run budget ended; no refund authority live; custody refund switch OFF (process and drop-in)"
}
# A buyer message on the proof order ($1) with no message from Agent-1 to the buyer after it, unanswered for QUIET_MIN minutes of
# Agent-1's running time (counted from the later of the message and the last resume, $2). Only a message Agent-1 sent to the
# buyer answers it (an acknowledgement counts; a refusal, a delivery attempt or model calls do not — 2026-10-19: 23 model calls
# and no reply had counted as answered). It is "unanswered" in schema v100's fleet_customer_obligations too. Kept as one
# definition: fleet-v100-obligations-pg.test.ts runs exactly this text.
unanswered_sql() {
  echo "SELECT EXISTS (SELECT 1 FROM fleet_customer_messages b WHERE b.order_id = '$1' AND b.author = 'buyer'
          AND GREATEST(b.created_at, '$2'::timestamptz) < now() - interval '$QUIET_MIN minutes'
          AND NOT EXISTS (SELECT 1 FROM fleet_customer_messages a WHERE a.order_id = '$1' AND a.author = 'agent' AND a.created_at > b.created_at))"
}
if [[ -n "${FLEET_PROOF_STUBS:-}" ]]; then source "$FLEET_PROOF_STUBS"; fi
[[ $EUID -eq 0 ]] || sudo -v || exit 2

case "${1:-}" in
start)
  [[ "${2:-}" =~ ^[0-9]+$ ]] && (( $2 > 0 && $2 <= 1000 )) || die "usage: start <aiCeilingPence> (1..1000; the owner's approved AI ceiling)"
  guard
  [[ -z "$(START)" ]] || die "a proof was already started here ($(START)); status / stop it"
  [[ "$(paused $A1)" == t ]] || die "Agent-1 is already running"
  [[ "$(authorities)" == "[]" && "$(switch_file)" == absent && "$(switch_effective)" != ON ]] || die "a refund authority or custody's refund switch is already on"
  [[ "$(Q 'SELECT count(*) FROM fleet_cognition_run_budgets WHERE ended_at IS NULL')" == 0 ]] || die "a run budget is already open"
  [[ "$(Q 'SELECT count(*) FROM fleet_customer_orders WHERE owner_proof')" == 1 ]] || die "not exactly one proof order: this continues the existing one and never makes another"
  o=$(ORDER)
  [[ "$(Q "SELECT z.payment_status || ' ' || c.status || ' ' || (c.expires_at > now() + interval '${HOURS} hours') FROM fleet_customer_orders z JOIN fleet_paypal_checkouts c ON c.checkout_id = z.checkout_id WHERE z.order_id = '$o'")" == "awaiting_payment open true" ]] \
    || die "the proof order is not unpaid with its checkout open for the next ${HOURS} h"
  [[ "$(Q "SELECT count(*) FROM fleet_paypal_refund_requests WHERE order_id = '$o'")" == 0 ]] || die "the proof order already has a refund request"
  sp=$(spendable); [[ "$sp" =~ ^[0-9]+$ ]] || die "Agent-1's spendable cash is unknown"
  [[ "$(Q "SELECT count(*) FROM fleet_offers o WHERE o.slug = '$SLUG' AND o.agent_id = '$A1' AND o.status = 'published' AND o.kind = 'product' AND o.price_minor <= $PRICE_MAX")" == 1 ]] \
    || die "the offer $SLUG is not Agent-1's published product at most £5"
  echo "$2 $sp" > "$D/proof-terms.txt"; CEILING=$2; SP0=$sp; ts > "$D/proof-start.txt"; START > "$D/proof-resumed.txt"
  echo "  the existing proof order $o (unpaid) is continued; no new order or payment is made. Money-out stays OFF until its refund is requested"
  echo "  the offer is not sold publicly: $(Q "SELECT COALESCE(fleet_offer_sale_block(o), 'SOLD PUBLICLY (unexpected)') FROM fleet_offers o WHERE o.slug = '$SLUG'")"
  echo "  1. Agent-1's run budget $(printf '£%d.%02d' $((CEILING / 100)) $((CEILING % 100))) for ${HOURS} h (checked before every model request); spendable at start ${SP0}p"
  A cognition-run $A1 start $CEILING $HOURS "purchase proof (continued): AI ceiling ${CEILING}p" | jq -c '.run | {ceilingMinor, endsAt}' || die "run budget not opened (nothing else changed)"
  echo "  2. watchdog every minute"
  sudo -n systemd-run --quiet --unit $UNIT --setenv=FLEET_PROOF_DIR="$D" --on-active=1min --on-unit-active=1min /bin/bash "$SELF" watch \
    || { stop_proof "watchdog not armed"; exit 1; }
  echo "  3. resume Agent-1"
  A founder-cognition $A1 resume "purchase proof (owner approval): AI ceiling ${CEILING}p, ${HOURS} h; public sales stay closed" | jq -c '{paused}' || { stop_proof "resume failed"; exit 1; }
  echo "== PROOF STARTED $(START): sales closed; card authority off; no outward release; money-out off; Agent-2 paused. Next: buy (prints the existing order page)"; report ;;
continue)
  [[ -n "$(START)" ]] || die "no proof was started here: nothing to continue"
  guard
  [[ "$(paused $A1)" == t ]] || die "Agent-1 is already running"
  [[ "$(authorities)" == "[]" && "$(switch_file)" == absent && "$(switch_effective)" != ON && -z "$(WINDOW)" ]] || die "a refund authority, window or custody's refund switch is on"
  [[ "$(Q 'SELECT count(*) FROM fleet_customer_orders WHERE owner_proof')" == 1 ]] || die "not exactly one proof order"
  o=$(ORDER)
  [[ "$(Q "SELECT payment_status FROM fleet_customer_orders WHERE order_id = '$o'")" == paid ]] || die "the proof order is not paid"
  [[ "$(Q "SELECT count(*) FROM fleet_paypal_refund_requests WHERE order_id = '$o'")" == 0 ]] || die "the proof order already has a refund request"
  run=$(Q "SELECT fleet_admin_cognition_run('$A1')")
  [[ "$(jq -r '.open' <<< "$run")" == true ]] || die "the proof's run budget is not open (ended or expired): continuing needs the owner's revised terms"
  left=$(jq -r '(.ceilingMinor - (.spentMicro + .inflightMicro) / 1000000) | floor' <<< "$run")
  (( left > 5 )) || die "the run budget has ${left}p left: continuing needs the owner's revised terms"
  echo "  the SAME run budget, unchanged: $(jq -c '{ceilingMinor, spentPence: (.spentMicro/1000000), endsAt}' <<< "$run"); ${left}p left. No new budget, ceiling or end time"
  echo "  buyer requests open on the proof order: $(Q "SELECT COALESCE(jsonb_agg(x - 'id'), '[]') FROM jsonb_array_elements(fleet_customer_obligations('$A1')) x WHERE x ->> 'id' = '$o'")"
  ts >> "$D/proof-resumed.txt"
  echo "  1. watchdog every minute (quiet periods from now: $(RESUMED))"
  sudo -n systemd-run --quiet --unit $UNIT --setenv=FLEET_PROOF_DIR="$D" --on-active=1min --on-unit-active=1min /bin/bash "$SELF" watch \
    || { stop_proof "watchdog not armed"; exit 1; }
  echo "  2. resume Agent-1"
  A founder-cognition $A1 resume "purchase proof continued (owner approval): the same run budget and end time; public sales stay closed" | jq -c '{paused}' || { stop_proof "resume failed"; exit 1; }
  echo "== PROOF CONTINUED $(RESUMED): the same order and run budget; sales closed; card authority off; no outward release; money-out off; Agent-2 paused"; report ;;
buy)
  [[ -n "$(START)" && "$(paused $A1)" == f ]] || die "start the proof first"
  guard; o=$(ORDER)
  [[ "$(Q "SELECT payment_status FROM fleet_customer_orders WHERE order_id = '$o'")" == awaiting_payment ]] || die "the proof order is no longer awaiting payment: $(Q "SELECT payment_status FROM fleet_customer_orders WHERE order_id = '$o'")"
  echo "  the existing order page (no new order, no new payment): $(Q "SELECT fleet_public_url('/order/' || access_token) FROM fleet_customer_orders WHERE order_id = '$o'")"
  echo "== OPEN IT, CONFIRM THE TWO 'BEFORE YOU PAY' BOXES, PAY £5 WITH PAYPAL ($(ts)). After delivery report the date fault there, ask for a correction, then for a refund." ;;
refund)
  [[ -n "$(START)" ]] || die "start the proof first"
  guard; o=$(ORDER); [[ -n "$o" ]] || die "no proof order"
  why=${2:-"purchase proof: OWNER OVERRIDE refund of the proof purchase"}
  r=$(A economy-order-refund "$o" all "$why" 2>&1); echo "$r" | jq -c '{ok, replay, refund, code, reason}' 2>/dev/null || echo "$r" | head -5
  [[ "$(jq -r '.ok' <<< "$r" 2>/dev/null)" == true ]] || die "the refund could not be requested"
  echo "== OWNER OVERRIDE REFUND REQUESTED $(ts): recorded as the owner's, not Agent-1's; the watchdog opens the refund window for it" ;;
status) report ;;
stop) stop_proof "${2:-stopped by the owner}" ;;
watch)
  s=$(START); [[ -n "$s" && "$(paused $A1)" == f ]] || { sudo -n systemctl stop $UNIT.timer >/dev/null 2>&1; exit 0; }
  o=$(ORDER)
  (( $(Q "SELECT count(*) FROM fleet_customer_orders WHERE owner_proof") > 1 )) && { stop_proof "FAILURE: a second proof order"; exit 0; }
  (( $(Q "SELECT count(*) FROM fleet_paypal_refund_requests WHERE order_id IS DISTINCT FROM '$o'::uuid AND created_at >= '$s'") > 0 )) \
    && { stop_proof "FAILURE: a refund was requested on another order (custody would not send it: no authority covers it)"; exit 0; }
  (( $(Q "SELECT count(*) FROM fleet_paypal_refund_requests WHERE order_id = '$o'") > 1 )) && { stop_proof "FAILURE: a second refund request on the proof order"; exit 0; }
  (( $(Q "SELECT count(DISTINCT paypal_refund_id) FROM fleet_paypal_refund_requests WHERE order_id = '$o'") > 1 )) && { stop_proof "FAILURE: a second PayPal refund"; exit 0; }
  (( $(Q "SELECT count(*) FROM fleet_order_deliveries WHERE order_id = '$o'") > MAX_DELIVERIES )) && { stop_proof "FAILURE: more deliveries than the delivery and one revision"; exit 0; }
  if [[ "$(Q "SELECT count(*) FROM fleet_paypal_refund_requests WHERE order_id = '$o' AND status = 'completed' AND authority_id IS NOT DISTINCT FROM NULLIF('$(AUTH)', '')::uuid")" == 1 \
        && "$(Q "SELECT count(*) FROM fleet_offer_proof_returns r JOIN fleet_customer_orders z ON z.checkout_id = r.checkout_id WHERE z.order_id = '$o' AND r.kind = 'refund'")" -ge 1 \
        && "$(Q "SELECT fleet_ledger_verify()->>'ok'")" == true ]]; then
    # Its reservation is released (nothing set aside for it), PayPal holds none of Agent-1's money, and Agent-1's wallet is
    # the start moved by exactly the journals on its cash since then (its own AI costs among them), to the penny.
    [[ "$(Q "SELECT count(*) FROM fleet_paypal_refund_requests WHERE order_id = '$o' AND status IN ('requested','sent','pending')")" == 0 ]] \
      || { stop_proof "FAILURE: the refund is recorded but its reservation is still set aside"; exit 0; }
    [[ "$(Q "SELECT fleet_agent_wallet_measure('$A1') ->> 'paypalDisputeExposureMinor'")" == 0 ]] \
      || { stop_proof "FAILURE: PayPal exposure is held from Agent-1's money after the refund"; exit 0; }
    now=$(spendable); moved=$(cash_moved)
    [[ "$now" == "$(( SP0 + moved ))" ]] || { stop_proof "FAILURE: Agent-1's wallet does not reconcile: spendable ${now}p, expected $(( SP0 + moved ))p (${SP0}p + journals ${moved}p)"; exit 0; }
    read -r jr jc ji <<< "$(journey "$o")"
    if [[ "$jr $jc $ji" == "true true true" ]]; then
      stop_proof "PROOF COMPLETE (full): Agent-1 answered the fault report and sent a corrected delivery that passed fleet-qa-3; refunded once within the proof's own refund authority, as owner capital; its reservation released; Agent-1's wallet = start ${moved}p by its journals; the ledger verifies"; exit 0
    fi
    stop_proof "PROOF ENDED — NOT a full proof: the refund and accounting checks pass, but $( [[ $jr != true ]] && echo 'no Agent-1 answer to the fault report; ')$( [[ $jc != true ]] && echo 'no corrected delivery sent after it; ')$( [[ $ji != true ]] && echo 'the delivered files did not pass fleet-qa-3; ')(Agent-1's wallet = start ${moved}p by its journals; the ledger verifies)"; exit 0
  fi
  # The refund window: when the proof order's refund is requested (custody enforces the order-only authority).
  if [[ -z "$(WINDOW)" && "$(Q "SELECT count(*) FROM fleet_paypal_refund_requests x WHERE x.order_id = '$o' AND x.status = 'requested'")" == 1 ]]; then
    window_open "$o" || { stop_proof "FAILURE: the refund window could not be opened"; exit 0; }
  fi
  if [[ -n "$(WINDOW)" && -n "$(find "$D/refund-window.txt" -mmin +$QUIET_MIN 2>/dev/null)" \
        && "$(Q "SELECT count(*) FROM fleet_paypal_refund_requests WHERE order_id = '$o' AND status IN ('requested','sent','pending')")" != 0 ]]; then
    stop_proof "FAILURE: the refund was not completed $QUIET_MIN minutes after the window opened"; exit 0
  fi
  [[ "$(Q "$(unanswered_sql "$o" "$(RESUMED)")")" == t ]] && { stop_proof "FAILURE: a buyer message unanswered for $QUIET_MIN minutes"; exit 0; }
  run=$(Q "SELECT fleet_admin_cognition_run('$A1')")
  [[ "$(jq -r '.open' <<< "$run")" == true ]] || { stop_proof "the AI ceiling is spent or ${HOURS} h are up"; exit 0; }
  (( $(jq -r '(.spentMicro + .inflightMicro) / 1000000 | floor' <<< "$run") >= CEILING - 5 )) && { stop_proof "the AI ceiling is (nearly) spent"; exit 0; }
  (( $(Q "SELECT count(*) FROM fleet_notifications WHERE code = 'OPERATION_UNCERTAIN' AND agent_id = '$A1' AND created_at >= '$s'") > 0 )) \
    && { stop_proof "an outcome is uncertain: check it and resolve it (fleet operations-uncertain)"; exit 0; }
  (( $(Q "SELECT count(*) FROM fleet_notifications WHERE code = 'AGENT_CANNOT_THINK' AND agent_id = '$A1' AND created_at >= '$s'") > 0 )) && { stop_proof "FAILURE: the agent cannot think (packet)"; exit 0; }
  last=$(Q "SELECT GREATEST('$(RESUMED)'::timestamptz, COALESCE((SELECT max(created_at) FROM fleet_events WHERE agent_id = '$A1' AND created_at >= '$s'
            AND event_type IN ('offer_proof_captured','customer_message_received','order_refund_requested')), '$s'::timestamptz))")
  (( $(Q "SELECT count(*) FROM fleet_cognition_log WHERE agent_id = '$A1' AND at > '$last'") > MAX_IDLE_CALLS )) \
    && { stop_proof "FAILURE: $MAX_IDLE_CALLS model calls without a new customer event"; exit 0; }
  exit 0 ;;
*) sed -n 2,39p "$0"; exit 2 ;;
esac
