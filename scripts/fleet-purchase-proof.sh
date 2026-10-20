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
#   bash fleet-purchase-proof.sh rerun <aiCeilingPence> <hours> [allInMaxPence]
#       (2026-10-20, owner's revised terms after the ended run) a NEW bounded run of Agent-1 on the SAME paid order: guards →
#       a new run budget (the ceiling and hours approved; checked before every model request, in-flight calls included) →
#       the earlier run's records archived (state/phase-<time>/) → the watchdog → resume Agent-1. No buyer message is sent;
#       nothing is repaired by hand. Success: Agent-1's response to the buyer in this run, a corrected delivery SENT in this
#       run whose files passed fleet-qa-3 (verdict pass, automated checks ok; every spreadsheet's saved values, displayed
#       dates and rendering pass), then — when the owner asks for the refund on the order page — Agent-1's own full refund,
#       Starts only when no paid search, image or purchase can execute (the media gateway stopped, no payout activation or
#       signer, no card authority; it trips the spend circuit breaker, so a purchase is rejected before any reservation, and
#       stop resets it) and the treasury's free cash covers the refund after the run's AI costs (owed to the owner).
#       PayPal's confirmation, Agent-1's confirmation to the buyer after it, and the money checks below. Never raises the
#       ceiling or the time; never restarts itself.
#   … owner-refund [why]  SEPARATE from any agent run (Agent-1 paused, no run open): the owner's own full refund of the
#                    proof order — request it, open the refund window for it (the same order-only authority and switch),
#                    wait for PayPal (≤ 30 min, no AI), verify the money, close the window. Recorded as the owner's.
#   … test-funding <paypalTransactionId>   SEPARATE, owner-run: records a deposit the owner made into the treasury PayPal for
#                    this test as OWNER FUNDING of exactly its verified net (PayPal's own transaction record: completed, GBP,
#                    received, not yet claimed; amount less PayPal's fee) and attributes the transaction to it. It is not
#                    backing for the agents' capital and does not make the Fleet launch-ready.
#   … owner-claim-waits [why]   SEPARATE, owner-run (v106; owner, 2026-10-20: "my claim waits"): records the owner's decision
#                    that what is owed to them for AI credit waits behind the refund of THIS proof order — custody may then
#                    send that refund from cash otherwise committed to the owner's claim. The claim is not forgiven, reduced
#                    or paid; no other refund or payment changes. With it, rerun needs free cash + the owner's claim to
#                    cover the refund (the run's AI costs only add to that claim); without it, a deposit (test-funding).
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
#                    for the buyer never stops it. 2026-10-20: also on an unresolved platform fault (AGENT_TOOL_FAULT), a
#                    cost to Agent-1's cash outside the AI ceiling (anything but its model usage and that credit's tax/fee),
#                    the same refusal 8 times in the run, and (rerun) a completed refund Agent-1 has not confirmed to the
#                    buyer within 30 min.
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
# 2026-10-20 (rerun): paid search and images run only through the media gateway; a request is refused before any reservation
# once its provider has not been seen for 10 minutes (fleet_econ_media_request).
media_active() { systemctl is-active automaton-fleet-media.service 2>/dev/null; }
# The most acquisition tax/fee a run of $1p of AI usage can add: its ceiling at the highest receipt-based ratio of the open
# credit lots it can draw from (a lot without receipt evidence adds nothing), rounded up to a whole penny.
acq_max() { Q "SELECT COALESCE(ceil($1 * max((acq_total_usd_cents * 1000000.0 - usd_purchased) / usd_purchased)), 0)::bigint FROM fleet_ai_credit_lots WHERE usd_remaining > 0 AND acq_total_usd_cents IS NOT NULL"; }
breaker_tripped() { Q "SELECT tripped FROM fleet_spend_circuit_breaker WHERE id = 1"; }
treasury_free() { Q "SELECT (fleet_treasury_liquidity(r.rail_id) ->> 'freeMinor') FROM fleet_payment_rails r WHERE r.provider = 'paypal' AND r.status = 'active' ORDER BY r.created_at LIMIT 1"; }
# v106: what is owed to the owner (AI credit their card paid), and whether the owner let that claim wait behind the proof's refund.
owed_owner() { Q "SELECT (fleet_treasury_liquidity(r.rail_id) #>> '{committed,owedToOwnerMinor}') FROM fleet_payment_rails r WHERE r.provider = 'paypal' AND r.status = 'active' ORDER BY r.created_at LIMIT 1"; }
claim_waits() { Q "SELECT count(*) FROM fleet_owner_claim_waits w JOIN fleet_customer_orders o USING (order_id) WHERE o.owner_proof AND w.ended_at IS NULL" 2>/dev/null || echo 0; }
START() { cat "$D/proof-start.txt" 2>/dev/null; }
# When Agent-1 last resumed under this proof (start, or a continue after an owner pause).
RESUMED() { tail -1 "$D/proof-resumed.txt" 2>/dev/null || START; }
WINDOW() { cat "$D/refund-window.txt" 2>/dev/null; }
AUTH() { cat "$D/refund-authority.txt" 2>/dev/null; }
CEILING=0; SP0=0; T_MAXDEL=""; T_MAXIDLE=""; MODE=""; T_HOURS=""
[[ -f "$D/proof-terms.txt" ]] && read -r CEILING SP0 T_MAXDEL T_MAXIDLE MODE T_HOURS < "$D/proof-terms.txt"
# A rerun's own terms (2026-10-20): one more delivery than it started with, its idle-call allowance, its hours.
MAX_DELIVERIES=${T_MAXDEL:-$MAX_DELIVERIES}; MAX_IDLE_CALLS=${T_MAXIDLE:-$MAX_IDLE_CALLS}; MODE=${MODE:-proof}; HOURS=${T_HOURS:-$HOURS}
MAX_REPEATED_REFUSALS=8
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
# The run's economic cost, kept separate from its charges (µp, GBP): "calls drawn charged exceededCalls exceededBy" — drawn is
# the provider cost at the call's exchange rate (what the AI credit pays and what the tax/fee is computed on); a call is
# charged at most its reservation, so a call that cost more than it reserved shows here and is never hidden by the charge.
economics() {
  Q "SELECT count(*) || ' ' || COALESCE(sum(drawn), 0) || ' ' || COALESCE(sum(charged), 0) || ' ' || count(*) FILTER (WHERE drawn > charged + 1000) || ' '
         || COALESCE(sum(drawn - charged) FILTER (WHERE drawn > charged + 1000), 0)
       FROM (SELECT ceil(cost_microcents::numeric * COALESCE(fx_rate_micro, 1000000) / 1000000)::bigint AS drawn, COALESCE(charged_microcents, charged_cents * 1000000) AS charged
               FROM fleet_cognition_log WHERE agent_id = '$A1' AND at >= '$(START)') x"
}
# The customer journey on the order $1: "replied corrected inspected" (t/f each). replied: an Agent-1 message after the
# buyer's first message; corrected: a delivery SENT after that message; inspected: the latest sent delivery's review is
# fleet-qa-3, pass, automated checks ok (the review gate already binds it to exactly the delivered files).
# Both counted from the later of the buyer's first message and this run's start (a rerun's start is after it). In a rerun the
# files must also show what the buyer sees: at least one spreadsheet delivered as its own file, and every such spreadsheet's
# saved values, displayed dates and rendering pass (the review keeps these per delivered file; a zip's members are
# inspected, but their display checks are not kept in the review record, so they cannot count here).
journey() {
  local strict=false; [[ "$MODE" == rerun ]] && strict=true
  Q "WITH b AS (SELECT GREATEST(min(created_at), '$(START)'::timestamptz) AS at FROM fleet_customer_messages WHERE order_id = '$1' AND author = 'buyer'),
          d AS (SELECT d.* FROM fleet_order_deliveries d WHERE d.order_id = '$1' AND d.status = 'sent' ORDER BY d.created_at DESC LIMIT 1),
          f AS (SELECT x FROM d JOIN fleet_artifact_reviews r ON r.review_id = d.review_id, jsonb_array_elements(r.automated -> 'files') x WHERE x ->> 'detectedType' = 'xlsx')
     SELECT (EXISTS (SELECT 1 FROM fleet_customer_messages m, b WHERE m.order_id = '$1' AND m.author = 'agent' AND m.created_at > b.at))::text || ' '
         || (EXISTS (SELECT 1 FROM fleet_order_deliveries x, b WHERE x.order_id = '$1' AND x.status = 'sent' AND x.created_at > b.at))::text || ' '
         || COALESCE((SELECT (r.inspector = 'fleet-qa-3' AND r.verdict = 'pass' AND r.automated_ok
               AND (NOT $strict OR ((SELECT count(*) FROM f) >= 1 AND (SELECT count(*) FROM f, jsonb_array_elements(f.x -> 'checks') c
                     WHERE c ->> 'id' IN ('cached_values','sheet_displayed_dates','sheet_render') AND c ->> 'status' = 'pass') = 3 * (SELECT count(*) FROM f))))::text
             FROM d JOIN fleet_artifact_reviews r ON r.review_id = d.review_id), 'false')"
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
  if [[ "$MODE" == rerun ]]; then
    echo "    CUSTOMER JOURNEY (this run, since $(START)): Agent-1 answered the buyer: ${jr:-false}; corrected delivery sent: ${jc:-false}; its files passed fleet-qa-3 with saved values, displayed dates and rendering: ${ji:-false}"
    echo "    the corrected delivery's files: $(Q "SELECT COALESCE(string_agg(f.file_name || ' ' || left(f.content_sha256, 16), '; '), 'none') FROM fleet_order_delivery_files f JOIN fleet_order_deliveries d ON d.delivery_id = f.delivery_id WHERE d.order_id = '$o' AND d.created_at >= '$(START)'")"
  else
    echo "    CUSTOMER JOURNEY: Agent-1 answered the fault report: ${jr:-false}; corrected delivery sent after it: ${jc:-false}; delivered files passed fleet-qa-3: ${ji:-false}"
  fi
  now=$(spendable); moved=$(cash_moved)
  echo "    Agent-1 wallet: ${SP0}p at start $( (( moved < 0 )) && echo "− ${moved#-}p" || echo "+ ${moved}p") (the journals above) = $(( SP0 + moved ))p expected; spendable now ${now}p ($( [[ "$now" == "$(( SP0 + moved ))" ]] && echo reconciled || echo "NOT RECONCILED by $(( now - SP0 - moved ))p"))"
}
report() {
  local s o; s=$(START); [[ -n "$s" ]] || { echo "  no proof recorded"; moneyout; return; }; o=$(ORDER)
  echo "  started $s; now $(ts); Agent-1 paused=$(paused $A1); Agent-2 paused=$(paused $A2); sales open=$(Q 'SELECT fleet_sales_open()')"
  moneyout
  echo "  run budget: $(Q "SELECT fleet_admin_cognition_run('$A1')" | jq -c '{ceilingMinor, spentPence: (.spentMicro/1000000), inflightPence: (.inflightMicro/1000000), calls, open, endsAt, endReason}')"
  echo "  model calls since start: $(Q "SELECT count(*)||' ('||COALESCE(sum(input_tokens),0)||' in, '||COALESCE(sum(cache_read_tokens),0)||' cache-read, '||COALESCE(sum(output_tokens),0)||' out), provider \$'||round(COALESCE(sum(provider_usd_microcents),0)/1e8,4)||', charged '||COALESCE(sum(charged_cents),0)||'p (Fleet-recorded, provisional)' FROM fleet_cognition_log WHERE agent_id='$A1' AND at >= '$s'")"
  local n drawn charged xc xb; read -r n drawn charged xc xb <<< "$(economics)"
  echo "  economic cost of the run: credit drawn $(awk -v x="${drawn:-0}" 'BEGIN{printf "%.4f", x/1e6}')p; charged $(awk -v x="${charged:-0}" 'BEGIN{printf "%.4f", x/1e6}')p; calls that cost more than they reserved: ${xc:-0} (+$(awk -v x="${xb:-0}" 'BEGIN{printf "%.4f", x/1e6}')p)$( (( ${xc:-0} > 0 )) && echo " — THE ECONOMIC CEILING IS NOT GUARANTEED")"
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
  # A rerun's spend circuit breaker (purchases rejected before any reservation) is reset only if that run tripped it.
  if [[ -f "$D/breaker-tripped.txt" ]]; then A economy-spend-breaker reset >/dev/null 2>&1 && rm -f "$D/breaker-tripped.txt" || bad=1; fi
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
rerun)
  [[ "${2:-}" =~ ^[0-9]+$ && "${3:-}" =~ ^[0-9]+$ && "${4:-0}" =~ ^[0-9]+$ ]] && (( $2 >= 1 && $2 <= 1000 && $3 >= 1 && $3 <= 24 )) \
    || die "usage: rerun <aiCeilingPence 1..1000> <hours 1..24> [allInMaxPence] (the owner's approved terms)"
  [[ -n "$(START)" ]] || die "no proof was started here: a rerun continues the existing proof order"
  guard
  [[ "$(paused $A1)" == t ]] || die "Agent-1 is already running"
  [[ "$(authorities)" == "[]" && "$(switch_file)" == absent && "$(switch_effective)" != ON && -z "$(WINDOW)" ]] || die "a refund authority, window or custody's refund switch is on"
  [[ "$(Q 'SELECT count(*) FROM fleet_cognition_run_budgets WHERE ended_at IS NULL AND now() < ends_at')" == 0 ]] || die "a run budget is open: end it first (stop)"
  [[ "$(Q 'SELECT count(*) FROM fleet_customer_orders WHERE owner_proof')" == 1 ]] || die "not exactly one proof order"
  o=$(ORDER)
  [[ "$(Q "SELECT payment_status FROM fleet_customer_orders WHERE order_id = '$o'")" == paid ]] || die "the proof order is not paid"
  [[ "$(Q "SELECT count(*) FROM fleet_paypal_refund_requests WHERE order_id = '$o'")" == 0 ]] || die "the proof order already has a refund request"
  sp=$(spendable); [[ "$sp" =~ ^[0-9]+$ ]] || die "Agent-1's spendable cash is unknown"
  base=$(Q "SELECT count(*) FROM fleet_order_deliveries WHERE order_id = '$o'"); [[ "$base" =~ ^[0-9]+$ ]] || die "the order's deliveries are unknown"
  # Paid tools cannot execute under this run: no paid search or image (the media gateway stopped, its providers unseen for
  # over 10 minutes), no purchase (no custody payout activation, no payout signer — guard — and no card authority — guard).
  [[ "$(media_active)" != active ]] || die "the media gateway (paid web search) is running: stop it first (sudo systemctl stop automaton-fleet-media), wait 11 minutes, then rerun"
  [[ "$(Q "SELECT count(*) FROM fleet_media_providers WHERE configured AND last_seen_at > now() - interval '11 minutes'")" == 0 ]] \
    || die "a media provider was seen in the last 11 minutes: a paid request could still be accepted; wait and rerun"
  [[ "$(Q 'SELECT count(*) FROM fleet_custody_activation_live()')" == 0 ]] || die "a custody payout activation is live: purchases could be paid"
  # Only routed requests carry the cost-bounded reservation and the run check (the unrouted path has neither).
  [[ "$(Q "SELECT fleet_routing_active('$A1')")" == t ]] || die "Agent-1's requests are not routed: the run's ceiling would not apply"
  # The refund must be payable after the run: the treasury's free cash covers the refund plus what the run's AI can add to
  # what is owed to the owner (the AI credit is owner-funded: usage and its tax/fee become owner payable).
  acq=$(acq_max "$2"); free=$(treasury_free); need=$(( PRICE_MAX + $2 + acq ))
  [[ "$acq" =~ ^[0-9]+$ && "$free" =~ ^-?[0-9]+$ ]] || die "the AI credit's acquisition cost or the treasury's free cash is unknown"
  # v106: when the owner let their own claim wait behind this refund, the refund's cover is free cash + that claim, and the
  # run's AI costs only add to the claim (they wait too): the refund alone must be covered.
  cover=$free; waits=$(claim_waits)
  if [[ "$waits" == 1 ]]; then
    owed=$(owed_owner); [[ "$owed" =~ ^[0-9]+$ ]] || die "what is owed to the owner is unknown"
    cover=$(( free + owed )); need=$PRICE_MAX
  fi
  # The all-inclusive maximum: the usage ceiling (a hard cap: every request is charged at most its reservation, a true
  # upper bound of its cost) + the most tax/fee that usage can post in whole pence. The same figures as the funding guard.
  allin=$(( $2 + acq ))
  (( ${4:-0} == 0 || allin <= ${4:-0} )) || die "the all-inclusive maximum would be ${allin}p (${2}p usage + up to ${acq}p tax/fee), over the approved ${4}p"
  if [[ "$waits" == 1 ]]; then
    (( cover >= need )) || die "the treasury cannot pay the refund even with the owner's claim waiting: free ${free}p + owed to the owner ${owed}p = ${cover}p, needed ${need}p"
  else
    (( free >= need )) || die "the treasury cannot pay the refund after this run: free ${free}p, needed ${need}p (the ${PRICE_MAX}p refund + up to ${2}p of AI usage + up to ${acq}p of its tax/fee, both owed to the owner). Deposit and record it (test-funding), or record that your claim waits (owner-claim-waits)"
  fi
  echo "  the SAME paid proof order $o: no new order, no buyer message, no repair by hand; Agent-1 works from its own record and files"
  echo "  1. a NEW run budget: $(printf '£%d.%02d' $(($2 / 100)) $(($2 % 100))) of AI for $3 h (checked before every model request, in-flight calls included); never raised, never restarted"
  echo "     at most ${acq}p of the AI credit's acquisition tax/fee on top (its receipts' ratio): ALL-INCLUSIVE MAXIMUM ${allin}p$( (( ${4:-0} > 0 )) && echo " (approved: ${4}p)")"
  if [[ "$waits" == 1 ]]; then
    echo "     your claim waits behind this refund (v106, recorded): free cash ${free}p + owed to you ${owed}p = ${cover}p covers the ${PRICE_MAX}p refund; the run's AI costs (≤ ${allin}p) add to what is owed to you"
  else
    echo "     the treasury's free cash ${free}p covers the refund after the run (needed ${need}p = ${PRICE_MAX}p refund + ${allin}p)"
  fi
  echo "     paid tools: no web search or images (media gateway stopped), no phone or SMS (no provider), no purchase (the spend circuit breaker rejects it before any reservation; no payout activation or signer, no card authority)"
  echo "     each request reserves a true upper bound of its cost; when the NEXT request's reservation does not fit what is left, the controller ends the run at once and records what it needed and what was left (no fixed threshold)"
  A cognition-run $A1 start $2 $3 "purchase proof rerun (owner's revised terms): the outstanding correction, then the buyer's refund; AI ceiling ${2}p" | jq -c '.run | {ceilingMinor, endsAt}' \
    || die "run budget not opened (nothing else changed)"
  P="$D/phase-$(date -u +%Y%m%dT%H%M%SZ)"; mkdir -p "$P"
  for f in proof-start.txt proof-terms.txt proof-resumed.txt refund-authority.txt correction-delivered.txt; do [[ -f "$D/$f" ]] && mv "$D/$f" "$P/"; done
  echo "$2 $sp $((base + 1)) 60 rerun $3" > "$D/proof-terms.txt"; ts > "$D/proof-start.txt"; START > "$D/proof-resumed.txt"
  CEILING=$2; SP0=$sp; MODE=rerun; HOURS=$3
  echo "     the earlier run's records: $P; spendable at this start ${SP0}p; deliveries so far ${base} (this run: one corrected delivery)"
  echo "  2. the spend circuit breaker: every new payment order and envelope spend is rejected before anything is reserved"
  if [[ "$(breaker_tripped)" == t ]]; then echo "     already tripped (kept; not reset by this run)"
  else A economy-spend-breaker trip "purchase proof rerun: purchases are excluded from this run" >/dev/null || { stop_proof "the spend circuit breaker could not be tripped"; exit 1; }
       ts > "$D/breaker-tripped.txt"; [[ "$(breaker_tripped)" == t ]] || { stop_proof "the spend circuit breaker is not tripped"; exit 1; }; fi
  echo "  3. watchdog every minute"
  sudo -n systemd-run --quiet --unit $UNIT --setenv=FLEET_PROOF_DIR="$D" --on-active=1min --on-unit-active=1min /bin/bash "$SELF" watch \
    || { stop_proof "watchdog not armed"; exit 1; }
  echo "  4. resume Agent-1"
  A founder-cognition $A1 resume "purchase proof rerun (owner approval): AI ceiling ${2}p, $3 h; public sales stay closed" | jq -c '{paused}' || { stop_proof "resume failed"; exit 1; }
  echo "== PROOF RERUN STARTED $(START): the same order; sales closed; card authority off; no outward release; money-out off until Agent-1 requests the refund; Agent-2 paused"; report ;;
owner-refund)
  [[ -n "$(START)" ]] || die "no proof was started here"
  guard
  [[ "$(paused $A1)" == t ]] || die "Agent-1 is running: the owner's refund is separate from an agent run (stop it first)"
  [[ "$(Q 'SELECT count(*) FROM fleet_cognition_run_budgets WHERE ended_at IS NULL AND now() < ends_at')" == 0 ]] || die "a run budget is open: stop it first"
  [[ "$(authorities)" == "[]" && "$(switch_file)" == absent && "$(switch_effective)" != ON && -z "$(WINDOW)" ]] || die "a refund authority, window or custody's refund switch is on"
  o=$(ORDER); [[ -n "$o" ]] || die "no proof order"
  [[ "$(Q "SELECT payment_status FROM fleet_customer_orders WHERE order_id = '$o'")" == paid ]] || die "the proof order is not paid"
  [[ "$(Q "SELECT count(*) FROM fleet_paypal_refund_requests WHERE order_id = '$o'")" == 0 ]] || die "the proof order already has a refund request"
  why=${2:-"purchase proof: the owner's own refund of the proof purchase"}
  r=$(A economy-order-refund "$o" all "$why" 2>&1); echo "$r" | jq -c '{ok, replay, refund, code, reason}' 2>/dev/null || echo "$r" | head -5
  [[ "$(jq -r '.ok' <<< "$r" 2>/dev/null)" == true ]] || die "the refund could not be requested (nothing else changed)"
  window_open "$o" || { window_close; die "the refund window could not be opened: the request stays set aside, nothing was sent"; }
  echo "  refund window: $(WINDOW)"
  for i in $(seq 1 "${OWNER_REFUND_POLLS:-90}"); do
    [[ "$(Q "SELECT count(*) FROM fleet_paypal_refund_requests WHERE order_id = '$o' AND status IN ('completed','failed')")" == 1 ]] && break
    sleep "${OWNER_REFUND_POLL_S:-20}"
  done
  st=$(Q "SELECT status FROM fleet_paypal_refund_requests WHERE order_id = '$o'")
  window_close || die "the refund window could not be closed: re-run stop"
  [[ "$st" == completed && "$(Q "SELECT count(*) FROM fleet_offer_proof_returns r JOIN fleet_customer_orders z ON z.checkout_id = r.checkout_id WHERE z.order_id = '$o' AND r.kind = 'refund'")" -ge 1 \
     && "$(Q "SELECT count(*) FROM fleet_paypal_refund_requests WHERE order_id = '$o' AND status IN ('requested','sent','pending')")" == 0 && "$(Q "SELECT fleet_ledger_verify()->>'ok'")" == true ]] \
    || { report; die "the owner's refund is $st: not verified complete (window closed; see status)"; }
  report
  echo "== OWNER REFUND COMPLETE $(ts): PayPal confirmed; owner capital; reservation released; the window closed (no refund authority live, custody's switch off)" ;;
test-funding)
  [[ "${2:-}" =~ ^[A-Za-z0-9-]{5,64}$ ]] || die "usage: test-funding <paypalTransactionId> (from hub-treasury-tx --direction in)"
  rail=$(Q "SELECT rail_id FROM fleet_payment_rails WHERE provider = 'paypal' AND status = 'active' ORDER BY created_at LIMIT 1"); [[ -n "$rail" ]] || die "no active PayPal rail"
  row=$(Q "SELECT event_code || ' ' || status || ' ' || currency || ' ' || amount_minor || ' ' || COALESCE(fee_minor, 0) || ' ' || (checkout_id IS NULL AND attributed_at IS NULL)::text
             FROM fleet_paypal_transactions WHERE rail_id = '$rail' AND transaction_id = '$2' ORDER BY initiated_at DESC LIMIT 1")
  [[ -n "$row" ]] || die "PayPal's transaction record does not show $2 yet (Transaction Search can take a few hours); nothing was recorded"
  read -r code st ccy amt fee free_tx <<< "$row"
  net=$(( amt + fee ))                                                                  # PayPal reports its fee as a negative amount
  [[ "$st" == S ]] || die "PayPal shows $2 as $st, not completed: nothing was recorded"
  [[ "$ccy" == GBP ]] || die "the deposit is in $ccy, not GBP: nothing was recorded"
  [[ "$free_tx" == true ]] || die "$2 is already accounted for (a checkout or an earlier record): nothing was recorded"
  (( amt > 0 && net > 0 )) || die "$2 is not money received into the treasury: nothing was recorded"
  ref="paypal:deposit:$2"
  echo "  the owner's test funding: PayPal $2 ($code) ${amt}p received, PayPal fee ${fee#-}p, net ${net}p — recorded as OWNER FUNDING of exactly ${net}p (not backing for the agents' capital)"
  A ledger-record-funding "$net" "$ref" | jq -c '{journalId}' || die "the owner funding could not be recorded (nothing else changed)"
  A economy-paypal-attribute "$rail" "$2" "$code" owner_funding "$ref" | jq -c '{ok, rows}' || die "recorded, but the transaction could not be attributed: run economy-paypal-attribute $rail $2 $code owner_funding $ref"
  echo "  books vs PayPal (capital backing reconciliation): $(A economy-capital-backing 2>/dev/null | jq -c '{differenceMinor, unbackedMinor, paypal: .paypal.totalMinor}')"
  echo "  the treasury's free cash now: $(treasury_free)p"
  echo "== TEST FUNDING RECORDED $(ts): ${net}p owner funding for this test (PayPal $2)" ;;
owner-claim-waits)
  o=$(ORDER); [[ -n "$o" ]] || die "no proof order"
  [[ "$(Q "SELECT owner_proof FROM fleet_customer_orders WHERE order_id = '$o'")" == t ]] || die "the order is not the owner's proof order"
  why=${2:-"owner, 2026-10-20: my AI-credit claim waits behind the refund of my own proof order (no deposit)"}
  echo "  before: free cash $(treasury_free)p; owed to the owner $(owed_owner)p"
  A economy-owner-claim-wait "$o" "$why" | jq -c '{ok, waitId, already, note}' || die "the decision could not be recorded (nothing changed)"
  [[ "$(claim_waits)" == 1 ]] || die "the decision is not live"
  echo "  the claim is unchanged (still owed in full): owed to the owner $(owed_owner)p; nothing else changed"
  echo "== OWNER CLAIM WAITS $(ts): the refund of proof order $o may use the cash committed to the owner's claim" ;;
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
  (( $(Q "SELECT count(*) FROM fleet_order_deliveries WHERE order_id = '$o'") > MAX_DELIVERIES )) && { stop_proof "FAILURE: more deliveries than $( [[ "$MODE" == rerun ]] && echo "this run's one corrected delivery" || echo "the delivery and one revision")"; exit 0; }
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
    if [[ "$MODE" == rerun ]]; then
      # Agent-1's own refund, and its confirmation to the buyer AFTER PayPal's (an earlier "done" is not a confirmation).
      by=$(Q "SELECT requested_by FROM fleet_paypal_refund_requests WHERE order_id = '$o' ORDER BY created_at LIMIT 1")
      [[ "$by" == agent ]] || { stop_proof "PROOF ENDED — NOT a full proof: the refund was requested by $by, not initiated by Agent-1"; exit 0; }
      if [[ "$(Q "SELECT EXISTS (SELECT 1 FROM fleet_customer_messages m WHERE m.order_id = '$o' AND m.author = 'agent' AND m.created_at > (SELECT max(updated_at) FROM fleet_paypal_refund_requests WHERE order_id = '$o' AND status = 'completed'))")" != t ]]; then
        [[ "$(Q "SELECT (SELECT max(updated_at) FROM fleet_paypal_refund_requests WHERE order_id = '$o' AND status = 'completed') < now() - interval '$QUIET_MIN minutes'")" == t ]] \
          && { stop_proof "PROOF ENDED — NOT a full proof: PayPal completed the refund but Agent-1 did not confirm it to the buyer within $QUIET_MIN minutes"; exit 0; }
        CONFIRM_PENDING=1
      fi
    fi
    if [[ -n "${CONFIRM_PENDING:-}" ]]; then :   # PayPal has confirmed; Agent-1's confirmation to the buyer is awaited
    elif [[ "$jr $jc $ji" == "true true true" && "$MODE" == rerun ]]; then
      stop_proof "PROOF COMPLETE (full, rerun): Agent-1 answered the buyer and sent a corrected delivery whose files passed fleet-qa-3 (saved values, displayed dates, rendering); it initiated the refund itself, PayPal confirmed it, and Agent-1 confirmed it to the buyer after that; refunded once within the order-only refund authority, as owner capital; its reservation released; Agent-1's wallet = start ${moved}p by its journals; the ledger verifies"; exit 0
    elif [[ "$jr $jc $ji" == "true true true" ]]; then
      stop_proof "PROOF COMPLETE (full): Agent-1 answered the fault report and sent a corrected delivery that passed fleet-qa-3; refunded once within the proof's own refund authority, as owner capital; its reservation released; Agent-1's wallet = start ${moved}p by its journals; the ledger verifies"; exit 0
    else
      stop_proof "PROOF ENDED — NOT a full proof: the refund and accounting checks pass, but $( [[ $jr != true ]] && echo 'no Agent-1 answer to the fault report; ')$( [[ $jc != true ]] && echo 'no corrected delivery sent after it; ')$( [[ $ji != true ]] && echo 'the delivered files did not pass fleet-qa-3; ')(Agent-1's wallet = start ${moved}p by its journals; the ledger verifies)"; exit 0
    fi
  fi
  if [[ "$MODE" == rerun && ! -f "$D/correction-delivered.txt" ]]; then
    read -r jr jc ji <<< "$(journey "$o")"
    [[ "$jr $jc $ji" == "true true true" ]] && echo "$(ts): Agent-1 answered and sent a corrected delivery whose files passed fleet-qa-3 (saved values, displayed dates, rendering); the run continues for the refund" > "$D/correction-delivered.txt"
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
  # v104: the controller ends the run the moment its next request's reservation does not fit, and says what it needed.
  [[ "$(jq -r '.open' <<< "$run")" == true ]] || { stop_proof "the run ended: $(jq -r '.endReason // "its end time passed"' <<< "$run")"; exit 0; }
  (( $(jq -r '(.spentMicro + .inflightMicro) / 1000000 | floor' <<< "$run") >= CEILING - 5 )) && { stop_proof "the AI ceiling is (nearly) spent"; exit 0; }
  (( $(Q "SELECT count(*) FROM fleet_notifications WHERE code = 'OPERATION_UNCERTAIN' AND agent_id = '$A1' AND created_at >= '$s'") > 0 )) \
    && { stop_proof "an outcome is uncertain: check it and resolve it (fleet operations-uncertain)"; exit 0; }
  (( $(Q "SELECT count(*) FROM fleet_notifications WHERE code = 'AGENT_CANNOT_THINK' AND agent_id = '$A1' AND created_at >= '$s'") > 0 )) && { stop_proof "FAILURE: the agent cannot think (packet)"; exit 0; }
  [[ "$MODE" == rerun && "$(media_active)" == active ]] && { stop_proof "FAILURE: the media gateway (paid web search) was started during the run"; exit 0; }
  [[ "$MODE" == rerun && "$(breaker_tripped)" != t ]] && { stop_proof "FAILURE: the spend circuit breaker was reset during the run (purchases are excluded)"; exit 0; }
  [[ "$MODE" == rerun && "$(Q "SELECT fleet_routing_active('$A1')")" != t ]] && { stop_proof "FAILURE: Agent-1's requests stopped being routed (the run's ceiling would not apply)"; exit 0; }
  # 2026-10-20: a call that cost more than it reserved breaks the economic bound: stop, and keep the difference on record.
  read -r _n _d _c xc xb <<< "$(economics)"
  (( ${xc:-0} > 0 )) && { stop_proof "FAILURE: ${xc} call(s) cost more than they reserved (+$(awk -v x="${xb:-0}" 'BEGIN{printf "%.4f", x/1e6}')p, kept on record): the economic ceiling is not guaranteed"; exit 0; }
  # 2026-10-20: a platform fault is not the agent's to fix; a cost outside the AI ceiling ends a bounded run; so does a loop.
  (( $(Q "SELECT count(*) FROM fleet_notifications WHERE code = 'AGENT_TOOL_FAULT' AND agent_id = '$A1' AND created_at >= '$s'") > 0 )) \
    && { stop_proof "FAILURE: an unresolved platform fault (AGENT_TOOL_FAULT) — reported to Fleet Control; fix it before any further run"; exit 0; }
  outside=$(journals | awk '$1 != "inference_charge" && $1 != "ai_credit_acquisition_cost" && $2 < 0 {printf "%s %sp; ", $1, $2}')
  [[ -z "$outside" ]] || { stop_proof "FAILURE: Agent-1's cash moved outside the run's AI ceiling: ${outside}"; exit 0; }
  (( $(Q "SELECT COALESCE(max(n), 0) FROM (SELECT x ->> 'code' AS code, count(*) AS n FROM fleet_agent_mind_reports r, jsonb_array_elements(r.refusals) x WHERE r.agent_id = '$A1' AND r.at >= '$s' GROUP BY 1) y") >= MAX_REPEATED_REFUSALS )) \
    && { stop_proof "FAILURE: the same refusal $MAX_REPEATED_REFUSALS times in this run (repeated failure)"; exit 0; }
  last=$(Q "SELECT GREATEST('$(RESUMED)'::timestamptz, COALESCE((SELECT max(created_at) FROM fleet_events WHERE agent_id = '$A1' AND created_at >= '$s'
            AND event_type IN ('offer_proof_captured','customer_message_received','order_refund_requested')), '$s'::timestamptz))")
  (( $(Q "SELECT count(*) FROM fleet_cognition_log WHERE agent_id = '$A1' AND at > '$last'") > MAX_IDLE_CALLS )) \
    && { stop_proof "FAILURE: $MAX_IDLE_CALLS model calls without a new customer event"; exit 0; }
  exit 0 ;;
*) sed -n 2,66p "$0"; exit 2 ;;
esac
