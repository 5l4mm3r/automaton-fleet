#!/usr/bin/env bash
# STAGE 2 — controlled purchase → delivery → buyer message → Fleet Control check → manual refund. EXECUTION PROOF ONLY.
# PREPARED 28 Oct, NOT RUN: needs the owner's approval of the consolidated package. Runs on e0dc223 (schema 122).
#
#   bash stage2-proof.sh --check                 read-only: reconciliation, hold arithmetic, every gate; writes nothing
#   bash stage2-proof.sh fund <paypalTxnId>      record the owner's ACTUAL net receipt once (evidence: the PayPal transaction)
#   bash stage2-proof.sh publish                 holds ($3 TOTAL), Fleet Control 30p, policy on, owner task, Agent-1 resumed
#   bash stage2-proof.sh publish-verify          publication bound to review 17a35f88 + digest; offer HELD; Agent-1 paused
#   bash stage2-proof.sh purchase                ONLY after the owner says "ready": guard armed, owner-proof order, 15-minute
#                                                 operator window, capture, fee from evidence, auto-delivery verified (no AI).
#                                                 Re-runnable: an unpaid order is reused (same page); a paid one is verified.
#   bash stage2-proof.sh message                 after the owner's ONE buyer message: Agent-1 resumed; reply + Fleet Control check
#   bash stage2-proof.sh message-verify          one reply, one check settled exactly once; Agent-1 paused
#   bash stage2-proof.sh refund-check            BEFORE the owner's manual PayPal refund: coverage, no refund authority
#   bash stage2-proof.sh refund-verify           AFTER it: waits (up to 24 h) until observed, then booked exactly once
#   bash stage2-proof.sh cleanup                 agent paused → task closed → cognition off → FC off → holds released only if
#                                                 nothing is unresolved → guard off → final reconciliation + cost report.
#                                                 Refused while a real (non-owner) buyer is still owed a delivery or an answer.
#   bash stage2-proof.sh unexpected              ONLY if a non-owner order appears: the proof stops; the $0.50 reserve is released
#                                                 for that buyer; Agent-1 is resumed to answer them (delivery is automatic)
#   bash stage2-proof.sh guard                   run by the guard timer every minute: re-asserts sales closed + offer held
#   bash stage2-proof.sh status                  read-only
#
# Design (code facts, verified 28 Oct): the owner-proof order (economy-offer-proof) needs the offer PUBLISHED, but neither sales
# open nor the offer un-held; the buyer's order page, payment, delivery (controller svc_offer_tick, no AI), buyer messages and
# Fleet Control's message check are not gated by sales or the hold. So SALES ARE NEVER OPENED and the offer is HELD as soon as
# it is published: the public order route refuses every new order (sales closed AND held). The guard timer re-asserts both.
# TWO DIFFERENT CLOCKS: the 15-minute window is the OPERATOR's watch window. The checkout itself stays payable server-side for
# 72 h from its creation (fleet_paypal_checkouts.expires_at default; no owner route shortens it); a payment after the window is
# still the owner's own proof order — re-run 'purchase' to verify it.
# Kill switch any time: cli founder-cognition <A1> pause …; cli cognition-disable. No database restore, ever.
set -uo pipefail
MODE=${1:---check}
# ── production identities ──
A1=01M3F50SH7PNX2E3GST13J52AS; A2=01M4C4NXT786Q4E9725N5A15KV; C=e0dc22321c0a6633ae74aadef0279074011a5b0a
OFFER=d7063a0a-9aab-4d0a-800d-ee2547e89ce7; SLUG=uk-landlord-compliance-tracker-england-g-a9ddde
REVIEW=17a35f88-f38f-482f-9e02-65664495781b; DIGEST=f3e6193aafe44a8d5cf55809082cd7efb1aa8c9abd7c8514e4f3ceb7710d6c69
RAIL=b71b3f3c-901c-4f22-818b-3e1b1269f420; SINCE=2026-10-28T17:00Z; SCHEMA=122
AGENTS="active e0dc223,active b60e262"; POLICY="true anthropic claude-opus-5-5 4000 400 2000 20 500 754 20"
# ── host bindings (a rehearsal replaces exactly this block; nothing else) ──
R=~/rlc142; N=/opt/automaton-fleet/node/bin/node; OPT=/opt/automaton-fleet; GUARD=automaton-fleet-stage2-guard
Q() { sudo -n -u postgres psql -X -q -At -d automaton_fleet -c "SET default_transaction_read_only=on; SET search_path=fleet; $1"; }
cli() { ( cd $OPT/current && $N dist/fleet/postgres/cli.js "$@" ); }
release_now() { readlink -f $OPT/current | xargs basename; }
guard_arm() { sudo -n install -m 644 $R/$GUARD.service $R/$GUARD.timer /etc/systemd/system/ && sudo -n systemctl daemon-reload && sudo -n systemctl start $GUARD.timer; }
guard_active() { systemctl is-active $GUARD.timer; }
guard_fire() { sudo -n systemctl start $GUARD.service; }
guard_off() { sudo -n systemctl stop $GUARD.timer 2>/dev/null; sudo -n systemctl disable $GUARD.timer 2>/dev/null; true; }
WAIT_PAY=900; WAIT_EVIDENCE=3600; WAIT_DELIVERY=900; WAIT_REFUND=86400; POLL=10
# ── end of host bindings ──
TOTAL=300000000; RESERVE=50000000; FC_PENCE=30; PRICE=500; MIN_NET_FUNDING=75
CAP_RUN=stage2-cap; RESERVE_RUN=stage2-obligation-reserve; PHASES=$R/phases.log
ts() { date -u +%FT%TZ; }
phase() { echo "$(ts) $1" >> $PHASES; echo "  [phase] $1"; }
waitfor() { local t0; t0=$(date +%s); until eval "$2"; do (( $(date +%s) - t0 >= $1 )) && return 1; sleep $POLL; done; }
free() { Q "SELECT fleet_provider_credit_balance('anthropic') - fleet_provider_credit_held('anthropic')"; }
holds() { Q "SELECT COALESCE(string_agg(run_id||' '||usd_microcents, ',' ORDER BY run_id),'') FROM fleet_provider_credit_holds WHERE status = 'open'"; }
unalloc() { Q "SELECT fleet_ledger_balance('fleet:treasury:unallocated')"; }
cog() { Q "SELECT paused FROM fleet_founder_cognition WHERE agent_id = '$1'"; }
policy() { Q "SELECT cognition_enabled||' '||provider||' '||model||' '||max_output_tokens||' '||input_microcents_per_token||' '||output_microcents_per_token||' '||cache_read_microcents_per_token||' '||cache_write_microcents_per_token||' '||default_daily_budget_cents||' '||default_max_turns_per_hour FROM fleet_cognition_policy WHERE id = 1"; }
proof_order() { Q "SELECT order_id FROM fleet_customer_orders WHERE owner_proof AND offer_id = '$OFFER' AND created_at > '$SINCE' ORDER BY created_at DESC LIMIT 1"; }
paystatus() { Q "SELECT payment_status FROM fleet_customer_orders WHERE order_id = '$1'"; }
# Non-owner orders made, or paid through an earlier link, since Stage 2 began.
others() { Q "SELECT count(*) FROM fleet_customer_orders o LEFT JOIN fleet_paypal_checkouts c USING (checkout_id) WHERE NOT o.owner_proof AND (o.created_at > '$SINCE' OR c.captured_at > '$SINCE')"; }
# Previously issued links: any checkout other than an owner-proof order that can still take a payment (closing sales does not close it).
payable_other() { Q "SELECT count(*) FROM fleet_paypal_checkouts c LEFT JOIN fleet_customer_orders o USING (checkout_id) WHERE NOT COALESCE(o.owner_proof, false) AND (c.status IN ('approved','capture_pending') OR (c.status IN ('requested','open') AND c.expires_at > now()))"; }
# A real buyer is owed while their paid order has no sent delivery, or their latest message is unanswered.
owed() { Q "SELECT COALESCE(string_agg(left(o.order_id::text,8)||CASE WHEN o.payment_status = 'paid' AND NOT EXISTS (SELECT 1 FROM fleet_order_deliveries d WHERE d.order_id = o.order_id AND d.status = 'sent') THEN ':delivery' ELSE '' END||CASE WHEN (SELECT author FROM fleet_customer_messages m WHERE m.order_id = o.order_id ORDER BY created_at DESC LIMIT 1) = 'buyer' THEN ':answer' ELSE '' END, ' '),'') FROM fleet_customer_orders o LEFT JOIN fleet_paypal_checkouts c USING (checkout_id) WHERE NOT o.owner_proof AND (o.created_at > '$SINCE' OR c.captured_at > '$SINCE') AND ((o.payment_status = 'paid' AND NOT EXISTS (SELECT 1 FROM fleet_order_deliveries d WHERE d.order_id = o.order_id AND d.status = 'sent')) OR (SELECT author FROM fleet_customer_messages m WHERE m.order_id = o.order_id ORDER BY created_at DESC LIMIT 1) = 'buyer')"; }
unresolved() { echo "$(Q 'SELECT count(*) FROM fleet_cognition_inflight') $(Q "SELECT count(*) FROM fleet_control_ai_reservations WHERE status IN ('open','unknown')") $(Q "SELECT count(*) FROM fleet_cognition_log WHERE at > '$SINCE' AND NOT (outcome='ok' AND usage_source='provider') AND NOT (outcome='error' AND COALESCE(provider_usd_microcents,0)=0 AND COALESCE(input_tokens,0)=0)")"; }
stopall() {  # the kill switch: never leaves a failing step running; no database restore
  echo "!! STOP: $*"
  [[ "$(cog $A1)" == t ]] || { cli founder-cognition $A1 pause "stage 2 stopped: $1" > /dev/null; echo "  Agent-1 paused"; }
  [[ "$(Q 'SELECT cognition_enabled FROM fleet_cognition_policy WHERE id = 1')" == f ]] || { cli cognition-disable > /dev/null; echo "  cognition disabled"; }
  [[ "$(Q 'SELECT fleet_sales_open()')" == f ]] || { cli economy-sales closed > /dev/null; echo "  sales closed"; }
  [[ "$(Q "SELECT held_at IS NOT NULL FROM fleet_offers WHERE offer_id = '$OFFER'")" == t || "$(Q "SELECT status FROM fleet_offers WHERE offer_id = '$OFFER'")" != published ]] || { cli economy-offer-hold $SLUG "stage 2 stopped: $1" > /dev/null; echo "  offer held"; }
  echo "== STAGE 2 STOPPED ($MODE) $(ts): holds kept ($(holds)); unresolved [inflight fcOpen cog] $(unresolved); report"; exit 1; }
base_gates() {  # ${1:-} = allow-others: only 'unexpected' and 'cleanup' run with a non-owner order present
  [[ "$(release_now)" == "$C" && "$(Q 'SELECT max(version) FROM fleet_schema_migrations')" == "$SCHEMA" ]] || stopall "not e0dc223 on schema 122"
  [[ "$(Q "SELECT string_agg(status||' '||left(runtime_commit,7), ',' ORDER BY agent_id) FROM fleet_agents")" == "$AGENTS" ]] || stopall "agents are not Agent-1 e0dc223 / Agent-2 b60e262, both active"
  [[ "$(cog $A2)" == t ]] || stopall "Agent-2 is not paused (it stays unchanged and paused)"
  [[ "$(Q 'SELECT tripped FROM fleet_spend_circuit_breaker WHERE id = 1')" == t ]] || stopall "the spend breaker is not tripped"
  [[ "$(Q 'SELECT fleet_sales_open()')" == f ]] || stopall "sales are open (Stage 2 never opens them)"
  [[ "$(Q 'SELECT count(*) FROM fleet_refund_authorities a WHERE fleet_refund_authority_live(a)') $(Q 'SELECT count(*) FROM fleet_outward_release WHERE expires_at > now()')" == "0 0" ]] || stopall "a refund authority or outward release is live"
  [[ "${1:-}" == allow-others || "$(others)" == 0 ]] || stopall "a NON-owner order exists: the proof is over — run 'unexpected' (that buyer is served; nothing is refunded automatically)"
  [[ "${1:-}" == allow-others || "$(payable_other)" == 0 ]] || stopall "a checkout other than the proof order is payable (an earlier link): wait for its expiry, or the agent cancels it"
  [[ "$(Q "SELECT verdict||' '||automated_ok||' '||files_digest FROM fleet_artifact_reviews WHERE review_id = '$REVIEW'")" == "pass true $DIGEST" ]] || stopall "review $REVIEW is not pass/automated-ok/$DIGEST"
  [[ "$(Q "SELECT fleet_files_digest(fleet_offer_deliverables('$OFFER'))")" == "$DIGEST" ]] || stopall "the offer's files changed since review $REVIEW"
  [[ "$(Q "SELECT fleet_ledger_verify()->>'ok'")" == true ]] || stopall "ledger verification failed"
}
echo "== Stage 2 ($MODE) $(ts)"; mkdir -p -m 700 $R
case "$MODE" in
--check|status)
  base_gates
  BAL=$(Q "SELECT fleet_provider_credit_balance('anthropic')"); PROMO=$(Q "SELECT usd_remaining FROM fleet_ai_credit_lots WHERE provider='anthropic' AND source='promotional'"); OWN=$(Q "SELECT usd_remaining FROM fleet_ai_credit_lots WHERE provider='anthropic' AND source='owner'")
  echo "  credit: balance $BAL µ¢ = promotional $PROMO + purchased $OWN (sum ok: $(( PROMO + OWN == BAL )) ); held $(Q "SELECT fleet_provider_credit_held('anthropic')"); free $(free); holds [$(holds)]"
  echo "  unresolved [inflight fcOpen/unknown cognition]: $(unresolved)"
  F=$(free); echo "  hold arithmetic: $CAP_RUN = free − \$3.00 = $(( F - TOTAL )) µ¢ → free \$3.00 TOTAL; of which $RESERVE_RUN = $RESERVE µ¢ kept for an unexpected real order → \$2.50 usable by the proof (Agent-1 + Fleet Control + any call)"
  echo "  treasury: unallocated $(unalloc)p; PayPal $(Q "SELECT (fleet_capital_backing()->'paypal'->>'availableMinor')")p; fee evidence: $(Q "SELECT string_agg(amount_minor||'p→fee '||fee_minor||'p ('||to_char(initiated_at,'MM-DD')||')', ', ' ORDER BY initiated_at) FROM fleet_paypal_transactions WHERE rail_id = '$RAIL' AND event_code = 'T0006'")"
  echo "  Fleet Control: $(Q "SELECT (fleet_control_ai_state()->>'set')||' ceiling '||COALESCE(fleet_control_ai_state()->>'ceilingMinor','-')||'p'") (tier $(Q 'SELECT review_tier FROM fleet_spend_review_policy') = $(Q "SELECT model FROM fleet_cognition_tiers WHERE tier = (SELECT review_tier FROM fleet_spend_review_policy)"))"
  echo "  offer: $(Q "SELECT status||' held='||(held_at IS NOT NULL)||' linked review '||left(review_id::text,8)||' files v'||files_version FROM fleet_offers WHERE offer_id = '$OFFER'"); latest capability check $(Q "SELECT to_char(max(checked_at),'MM-DD HH24:MI') FROM fleet_capability_checks WHERE agent_id = '$A1'") (publish needs one ≤ 7 days old: Agent-1 runs it in the publish turn)"
  echo "  checkouts payable now (any offer, any order): $(Q "SELECT count(*) FROM fleet_paypal_checkouts WHERE status IN ('requested','open','approved','capture_pending')")"
  echo "  agents: $(Q "SELECT string_agg(left(a.agent_id,6)||' '||a.status||' paused='||c.paused, ' | ' ORDER BY a.agent_id) FROM fleet_agents a JOIN fleet_founder_cognition c USING (agent_id)"); policy $(policy | cut -d' ' -f1); open owner tasks $(Q 'SELECT count(*) FROM fleet_owner_tasks WHERE closed_at IS NULL')"
  echo "  funding recorded since $SINCE: $(Q "SELECT COALESCE(string_agg(external_ref||' '||kind, ', '),'none') FROM fleet_ledger_journal WHERE kind = 'owner_funding' AND recorded_at > '$SINCE'")"
  [[ -s $PHASES ]] && { echo "  phases so far:"; sed 's/^/    /' $PHASES; }
  echo "== ${MODE#--} done $(ts) (nothing written)"; exit 0 ;;

guard)  # every minute while armed, independent of the operator's session: re-assert, never relax; record what it saw
  O=$(Q 'SELECT fleet_sales_open()'); [[ "$O" == f ]] || cli economy-sales closed > /dev/null
  H=$(Q "SELECT held_at IS NOT NULL OR status <> 'published' FROM fleet_offers WHERE offer_id = '$OFFER'"); [[ "$H" == t ]] || cli economy-offer-hold $SLUG "stage 2 guard" > /dev/null
  echo "{\"at\":\"$(ts)\",\"salesOpenBefore\":\"$O\",\"heldOrUnpublishedBefore\":\"$H\",\"salesOpenAfter\":\"$(Q 'SELECT fleet_sales_open()')\",\"heldOrUnpublishedAfter\":\"$(Q "SELECT held_at IS NOT NULL OR status <> 'published' FROM fleet_offers WHERE offer_id = '$OFFER'")\",\"nonOwnerOrders\":$(others)}" >> $R/guard.jsonl ;;

fund)
  TXN=${2:?usage: fund <paypalTxnId>}; base_gates
  [[ "$TXN" =~ ^[A-Z0-9]{8,24}$ ]] || stopall "not a PayPal transaction id"
  ROW=$(Q "SELECT event_code||' '||amount_minor||' '||fee_minor||' '||currency||' '||status||' '||(checkout_id IS NULL)||' '||(attributed_at IS NULL) FROM fleet_paypal_transactions WHERE rail_id = '$RAIL' AND transaction_id = '$TXN'")
  [[ -n "$ROW" ]] || stopall "transaction $TXN is not (yet) in the treasury rail's records (wait for Transaction Search, then retry this command)"
  read -r CODE AMT FEE CUR ST NOCHK UNATT <<< "$ROW"
  REF="paypal:${RAIL:0:8}:$TXN"
  # Idempotency: one funding per transaction — the ref must be unused (journal, claims) and the receipt unattributed before anything is posted.
  # (Booleans concatenated into text by SQL read 'true'/'false', never 't'/'f'; a standalone boolean reads 't'/'f'.)
  SEEN="$(Q "SELECT count(*) FROM fleet_ledger_journal WHERE external_ref = '$REF'") $(Q "SELECT fleet_claim_taken('$REF')") $UNATT"
  [[ "$SEEN" == "0 f true" ]] || stopall "transaction $TXN is already recorded or attributed ($REF; journals, claimed, unattributed: $SEEN): no second funding entry"
  [[ "$CUR $ST $NOCHK" == "GBP S true" && "$AMT" -gt 0 ]]   # booleans concatenated in SQL read 'true'/'false'  || stopall "transaction $TXN is not a settled, unmatched GBP receipt ($ROW)"
  NET=$(( AMT + FEE ))   # fee_minor is negative
  (( NET >= MIN_NET_FUNDING )) || stopall "net receipt ${NET}p is below the ${MIN_NET_FUNDING}p minimum (gross ${AMT}p, fee ${FEE}p)"
  U0=$(unalloc); phase "fund $TXN gross ${AMT}p fee ${FEE}p net ${NET}p ($CODE)"
  cli ledger-record-funding $NET $REF > $R/fund-record.json || stopall "ledger-record-funding refused: $(head -c 300 $R/fund-record.json)"
  cli economy-paypal-attribute $RAIL $TXN $CODE owner_funding $REF > $R/fund-attribute.json || stopall "attribution refused (the funding IS recorded once: $REF) — report"
  [[ "$(unalloc)" == "$(( U0 + NET ))" && "$(Q "SELECT count(*) FROM fleet_ledger_journal WHERE external_ref = '$REF'")" == 1 ]] || stopall "unallocated did not rise by exactly ${NET}p once"
  echo "== FUNDED $(ts): ${NET}p net recorded once as owner funding ($REF); unallocated $(unalloc)p" ;;

publish)
  base_gates
  [[ "$(Q "SELECT status FROM fleet_offers WHERE offer_id = '$OFFER'")" == paused ]] || stopall "the offer is not in its closed Stage 1 state (paused)"
  [[ "$(unalloc)" -ge "$MIN_NET_FUNDING" ]] || stopall "unallocated $(unalloc)p: fund first (≥ ${MIN_NET_FUNDING}p net)"
  [[ "$(holds)" == "" && "$(unresolved)" == "0 0 0" ]] || stopall "holds or unresolved costs exist before the cap: $(holds) / $(unresolved)"
  F=$(free); (( F > TOTAL )) || stopall "free credit $F is not above the \$3 total"
  phase "publish: holds"
  cli economy-engineering-credit-hold $CAP_RUN anthropic $(( F - TOTAL )) "stage 2: \$3.00 TOTAL API ceiling (owner 28 Oct)" > /dev/null || stopall "cap hold refused"
  cli economy-engineering-credit-hold $RESERVE_RUN anthropic $RESERVE "stage 2: \$0.50 of the \$3 kept for an unexpected real order's obligations" > /dev/null || stopall "reserve hold refused"
  [[ "$(free)" == "$(( TOTAL - RESERVE ))" ]] || stopall "free credit is $(free), not \$2.50 usable"
  cli economy-fleet-control-ai-budget $FC_PENCE "stage 2: Fleet Control sublimit ${FC_PENCE}p/day inside the \$3 total" > /dev/null || stopall "Fleet Control budget refused"
  [[ "$(Q "SELECT fleet_control_ai_state()->>'ceilingMinor'")" == "$FC_PENCE" ]] || stopall "Fleet Control sublimit not ${FC_PENCE}p"
  cli cognition-enable anthropic claude-opus-5-5 --max-output 4000 --in-microcents 400 --out-microcents 2000 > /dev/null || stopall "cognition-enable refused"
  [[ "$(policy)" == "$POLICY" ]] || stopall "policy read-back $(policy)"
  cli founder-task $A1 "Publish the reviewed tracker (private: sales stay closed)" "Publish your offer \"UK Landlord Compliance Tracker (England)\" (offer d7063a0a) on your passing review 17a35f88-f38f-482f-9e02-65664495781b, which covers exactly the current files (digest f3e6193a…). If publishing asks for a current capability check, run it first. Do not change the offer's files, price or text. Sales stay closed: publishing makes nothing public yet. When it is published, stop and wait (sleep, naming the publication); do no other paid work." > $R/task-publish.json || stopall "founder-task refused"
  phase "publish: Agent-1 resumed"
  cli founder-cognition $A1 resume "stage 2: publish on review 17a35f88" > /dev/null || stopall "resume refused"
  echo "== PUBLISH STARTED $(ts): free \$2.50 usable (+\$0.50 reserve) of \$3; watch, then 'publish-verify'" ;;

publish-verify)
  base_gates
  [[ "$(Q "SELECT status||' '||review_id FROM fleet_offers WHERE offer_id = '$OFFER'")" == "published $REVIEW" ]] || stopall "the offer is not published on review $REVIEW: $(Q "SELECT status||' '||review_id FROM fleet_offers WHERE offer_id = '$OFFER'")"
  cli economy-offer-hold $SLUG "stage 2: published privately; held so no public buyer can order (owner-proof purchase only)" > /dev/null || stopall "offer hold refused"
  cli founder-cognition $A1 pause "stage 2: published on review 17a35f88; paused until the owner's purchase" > /dev/null || stopall "pause refused"
  [[ "$(cog $A1)" == t ]] || stopall "Agent-1 not paused"
  TID=$(Q "SELECT task_id FROM fleet_owner_tasks WHERE agent_id = '$A1' AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1"); [[ -z "$TID" ]] || cli founder-task-close $TID "published on review $REVIEW; offer held privately" > /dev/null
  [[ "$(Q "SELECT held_at IS NOT NULL FROM fleet_offers WHERE offer_id = '$OFFER'")" == t && "$(Q 'SELECT fleet_sales_open()')" == f ]] || stopall "offer not held / sales open"
  phase "publish: verified (published on $REVIEW, digest $DIGEST, held, sales closed); Agent-1 paused; task closed"
  echo "== PUBLISHED PRIVATELY $(ts). Next: the owner says 'ready', then 'purchase'." ;;

purchase)
  base_gates
  [[ "$(Q "SELECT status||' '||review_id||' '||(held_at IS NOT NULL) FROM fleet_offers WHERE offer_id = '$OFFER'")" == "published $REVIEW true" && "$(cog $A1)" == t ]] || stopall "run publish-verify first (published on $REVIEW, held, Agent-1 paused)"
  ORD=$(proof_order)
  if [[ -n "$ORD" && "$(paystatus $ORD)" != awaiting_payment ]]; then
    phase "purchase: resumed on order $ORD ($(paystatus $ORD))"
  else
    # Guard armed BEFORE any purchase: every minute it re-asserts sales closed + offer held (independent of this script).
    [[ "$(guard_active)" == active ]] || guard_arm || stopall "guard timer could not be armed"
    [[ "$(guard_active)" == active ]] || stopall "guard timer not active"
    phase "purchase: guard armed"
    cli economy-offer-proof $SLUG > $R/proof.json || stopall "economy-offer-proof refused: $(head -c 300 $R/proof.json)"
    ORD=$(proof_order); [[ -n "$ORD" && "$(Q "SELECT owner_proof FROM fleet_customer_orders WHERE order_id = '$ORD'")" == t ]] || stopall "no owner-proof order designated"
    phase "purchase: owner-proof order $ORD designated before payment ($(grep -q '"replay": *true' $R/proof.json && echo 'same order, reused' || echo new))"
    echo "  OWNER: open the order page below, state your country (United Kingdom), consent, pay £5.00 with PayPal:"; grep -o '"page": *"[^"]*"' $R/proof.json | head -1
    echo "  Operator window: $(( WAIT_PAY / 60 )) minutes from now. The checkout itself stays payable server-side until $(Q "SELECT to_char(c.expires_at,'YYYY-MM-DD HH24:MI\"Z\"') FROM fleet_paypal_checkouts c JOIN fleet_customer_orders o USING (checkout_id) WHERE o.order_id = '$ORD'") (72 h)."
    if ! waitfor $WAIT_PAY "[[ \"\$(paystatus $ORD)\" != awaiting_payment ]]"; then
      phase "purchase: window closed unpaid (order $ORD; guard stays armed)"
      echo "== WINDOW CLOSED $(ts): order $ORD is unpaid. Do NOT pay now. Its checkout stays payable until it expires (see above): to try again, run 'purchase' (same order, new window); if you paid anyway, run 'purchase' — it verifies it."
      exit 3
    fi
  fi
  [[ "$(paystatus $ORD)" == paid ]] || stopall "order $ORD is $(paystatus $ORD), not paid"
  guard_fire; guard_off   # one final re-assert, then disarm
  [[ "$(Q "SELECT held_at IS NOT NULL FROM fleet_offers WHERE offer_id = '$OFFER'") $(Q 'SELECT fleet_sales_open()')" == "t f" ]] || stopall "offer not held / sales open after the purchase"
  phase "purchase: captured; sales closed + offer held re-asserted; guard disarmed"
  CK=$(Q "SELECT checkout_id FROM fleet_customer_orders WHERE order_id = '$ORD'")
  waitfor $WAIT_EVIDENCE "[[ -n \"\$(Q \"SELECT transaction_id FROM fleet_paypal_transactions WHERE checkout_id = '$CK' AND event_code = 'T0006'\")\" ]]" || echo "  capture evidence not yet in Transaction Search (the capture itself is booked; the fee is read again at refund-check)"
  echo "  capture evidence: $(Q "SELECT transaction_id||' gross '||amount_minor||'p fee '||fee_minor||'p' FROM fleet_paypal_transactions WHERE checkout_id = '$CK' AND event_code = 'T0006'")  (the 45p estimate is replaced by this)"
  echo "  booked: $(Q "SELECT string_agg(j.kind||' '||p.account_id||' '||p.side||' '||p.amount_cents, '; ') FROM fleet_ledger_journal j JOIN fleet_ledger_postings p USING (journal_id) WHERE j.journal_id = (SELECT journal_id FROM fleet_paypal_checkouts WHERE checkout_id = '$CK')")"
  waitfor $WAIT_DELIVERY "[[ \"\$(Q \"SELECT count(*) FROM fleet_order_deliveries WHERE order_id = '$ORD' AND status = 'sent'\")\" -ge 1 ]]"
  [[ "$(Q "SELECT count(*) FROM fleet_order_deliveries WHERE order_id = '$ORD' AND status = 'sent'")" == 1 ]] || stopall "not exactly one sent delivery"
  [[ "$(Q "SELECT review_id FROM fleet_order_deliveries WHERE order_id = '$ORD' AND status = 'sent'")" == "$REVIEW" ]] || stopall "the delivery is not bound to review $REVIEW (files ≠ the reviewed bytes)"
  phase "purchase: delivered once by the controller (no AI) — $(Q "SELECT to_char(created_at,'HH24:MI:SS') FROM fleet_order_deliveries WHERE order_id = '$ORD' AND status = 'sent'")"
  echo "== PURCHASED + DELIVERED $(ts): order $ORD. Next: the owner sends ONE buyer message on the order page, then 'message'." ;;

message)
  base_gates; ORD=$(proof_order); [[ -n "$ORD" ]] || stopall "no owner-proof order"
  [[ "$(Q "SELECT count(*) FROM fleet_customer_messages WHERE order_id = '$ORD' AND author = 'buyer'")" == 1 ]] || stopall "expected exactly one buyer message"
  [[ "$(unalloc)" -ge "$FC_PENCE" ]] || stopall "unallocated $(unalloc)p cannot fund Fleet Control's check"
  phase "message: Agent-1 resumed for the buyer message"
  cli founder-cognition $A1 resume "stage 2: answer the buyer's message on order ${ORD:0:8}" > /dev/null || stopall "resume refused"
  echo "== MESSAGE STARTED $(ts): watch for the reply + Fleet Control check; then 'message-verify'" ;;

message-verify)
  base_gates; ORD=$(proof_order)
  [[ "$(Q "SELECT count(*) FROM fleet_customer_messages WHERE order_id = '$ORD' AND author = 'agent'")" == 1 ]] || stopall "not exactly one agent reply"
  MC=$(Q "SELECT string_agg(check_id::text, ',') FROM fleet_message_checks WHERE message_id IN (SELECT message_id FROM fleet_customer_messages WHERE order_id = '$ORD' AND author = 'buyer')")
  [[ -n "$MC" && "$MC" != *,* ]] || stopall "not exactly one Fleet Control check ($MC)"
  RES=$(Q "SELECT reservation_id||' '||status FROM fleet_control_ai_reservations WHERE ref = '$MC'")
  [[ "$(echo "$RES" | wc -l) $(echo "$RES" | awk '{print $2}')" == "1 settled" ]] || stopall "the check's reservation is not exactly one, settled ($RES)"
  RID=${RES%% *}
  [[ "$(Q "SELECT count(*) FROM fleet_ledger_journal WHERE idempotency_key = 'fcai:charge:$RID'") $(Q "SELECT count(*) FROM fleet_provider_credit_events WHERE request_id = (SELECT request_id FROM fleet_control_ai_reservations WHERE reservation_id = '$RID')")" =~ ^[01]\ 1$ ]] || stopall "Fleet Control settlement not exactly once"
  cli founder-cognition $A1 pause "stage 2: buyer answered; Fleet Control check settled; paused before the refund" > /dev/null; [[ "$(cog $A1)" == t ]] || stopall "Agent-1 not paused"
  phase "message: verified (1 reply, check $MC settled once, reservation $RID); Agent-1 paused"
  echo "== MESSAGE VERIFIED $(ts). Next: 'refund-check', then the owner refunds £5 IN THE PAYPAL APP, then 'refund-verify'." ;;

refund-check)
  base_gates; ORD=$(proof_order); CAP=$(Q "SELECT capture_id FROM fleet_paypal_checkouts WHERE checkout_id = (SELECT checkout_id FROM fleet_customer_orders WHERE order_id = '$ORD')")
  [[ -n "$ORD" && "$(paystatus $ORD)" == paid ]] || stopall "the proof order is not paid ($(paystatus $ORD))"
  [[ "$(unalloc)" -ge "$PRICE" ]] || stopall "unallocated $(unalloc)p < ${PRICE}p: the refund booking would fail — do NOT refund yet"
  [[ "$(Q 'SELECT count(*) FROM fleet_refund_authorities a WHERE fleet_refund_authority_live(a)')" == 0 ]] || stopall "a refund authority is live"
  phase "refund: covered (unallocated $(unalloc)p ≥ ${PRICE}p); owner may refund capture $CAP in the PayPal app"
  echo "== READY FOR THE OWNER'S MANUAL REFUND $(ts): refund £5.00 in the PayPal app on capture $CAP. Then run refund-verify (it waits up to 24 h)." ;;

refund-verify)
  base_gates; ORD=$(proof_order); [[ -n "$ORD" ]] || stopall "no owner-proof order"
  grep -q " refund: covered" $PHASES 2>/dev/null || stopall "run refund-check first"
  waitfor $WAIT_REFUND "[[ \"\$(paystatus $ORD)\" == refunded ]]" || stopall "refund not observed and booked within 24 h"
  [[ "$(Q "SELECT count(*)||' '||sum(amount_minor) FROM fleet_offer_proof_returns WHERE checkout_id = (SELECT checkout_id FROM fleet_customer_orders WHERE order_id = '$ORD') AND kind = 'refund'")" == "1 $PRICE" ]] || stopall "the proof return is not exactly one ${PRICE}p"
  phase "refund: observed ($(Q "SELECT string_agg(DISTINCT source, '+') FROM fleet_paypal_clawback_evidence WHERE checkout_id = (SELECT checkout_id FROM fleet_customer_orders WHERE order_id = '$ORD')")) and booked once; order refunded"
  echo "== REFUND BOOKED $(ts)" ;;

unexpected)  # a real buyer ordered despite the closures: the proof is over; their order is served, never dropped at the cap
  base_gates allow-others
  [[ "$(others)" -ge 1 ]] || stopall "no non-owner order: nothing to do"
  phase "unexpected: non-owner orders $(Q "SELECT string_agg(left(o.order_id::text,8)||' '||o.payment_status, ', ') FROM fleet_customer_orders o LEFT JOIN fleet_paypal_checkouts c USING (checkout_id) WHERE NOT o.owner_proof AND (o.created_at > '$SINCE' OR c.captured_at > '$SINCE')")"
  [[ "$(Q "SELECT held_at IS NOT NULL OR status <> 'published' FROM fleet_offers WHERE offer_id = '$OFFER'")" == t ]] || cli economy-offer-hold $SLUG "stage 2: unexpected order — no further public orders" > /dev/null
  # The proof's own work stops; the $0.50 reserve becomes free for THIS buyer (the $3 cap hold stays). Delivery needs no AI.
  [[ "$(Q "SELECT count(*) FROM fleet_provider_credit_holds WHERE run_id = '$RESERVE_RUN' AND status = 'open'")" == 0 ]] || cli economy-engineering-credit-release $RESERVE_RUN "stage 2: unexpected real order — reserve released for that buyer's obligations" > /dev/null || stopall "reserve release refused"
  # The kill switch that stopped the proof turned cognition off: back on with the same policy (and the same $3 cap hold) for this buyer.
  [[ "$(Q 'SELECT cognition_enabled FROM fleet_cognition_policy WHERE id = 1')" == t ]] || cli cognition-enable anthropic claude-opus-5-5 --max-output 4000 --in-microcents 400 --out-microcents 2000 > /dev/null || stopall "cognition-enable refused"
  [[ "$(policy)" == "$POLICY" ]] || stopall "policy read-back $(policy)"
  for t in $(Q "SELECT task_id FROM fleet_owner_tasks WHERE agent_id = '$A1' AND closed_at IS NULL"); do cli founder-task-close $t "stage 2: superseded by a real customer order" > /dev/null; done
  cli founder-task $A1 "A real customer ordered: serve them" "A real customer bought your tracker while sales were closed (orders: $(Q "SELECT string_agg(left(o.order_id::text,8), ', ') FROM fleet_customer_orders o LEFT JOIN fleet_paypal_checkouts c USING (checkout_id) WHERE NOT o.owner_proof AND (o.created_at > '$SINCE' OR c.captured_at > '$SINCE')")). Their download is delivered automatically. Answer their messages on the order as you would any customer; do no other paid work." > $R/task-unexpected.json || stopall "founder-task refused"
  [[ "$(cog $A1)" == f ]] || cli founder-cognition $A1 resume "stage 2: serve the unexpected customer's order" > /dev/null || stopall "resume refused"
  phase "unexpected: reserve released (free $(free) µ¢); Agent-1 resumed for the customer; owed: [$(owed)]"
  echo "== UNEXPECTED ORDER HANDLED $(ts): delivery is automatic; Agent-1 answers the buyer; the proof does not continue. Report to the owner; refund only by the owner." ;;

cleanup)
  base_gates allow-others
  [[ -z "$(owed)" ]] || { echo "!! CLEANUP REFUSED $(ts): a real buyer is still owed [$(owed)] — nothing changed; serve them first ('unexpected'), then cleanup"; exit 1; }
  [[ "$(cog $A1)" == t ]] || cli founder-cognition $A1 pause "stage 2 cleanup" > /dev/null
  [[ "$(cog $A1)" == t ]] || stopall "Agent-1 could not be paused"
  for t in $(Q "SELECT task_id FROM fleet_owner_tasks WHERE agent_id = '$A1' AND closed_at IS NULL"); do cli founder-task-close $t "stage 2 cleanup (Agent-1 paused first)" > /dev/null; done
  cli cognition-disable > /dev/null; cli economy-fleet-control-ai-budget off "stage 2 complete" > /dev/null
  [[ "$(Q "SELECT held_at IS NOT NULL OR status <> 'published' FROM fleet_offers WHERE offer_id = '$OFFER'")" == t ]] || cli economy-offer-hold $SLUG "stage 2 complete" > /dev/null
  guard_off
  if [[ "$(unresolved)" == "0 0 0" ]]; then
    for h in $CAP_RUN $RESERVE_RUN; do [[ "$(Q "SELECT count(*) FROM fleet_provider_credit_holds WHERE run_id = '$h' AND status = 'open'")" == 1 ]] && cli economy-engineering-credit-release $h "stage 2 complete; nothing unresolved" > /dev/null; done
    phase "cleanup: holds released (nothing unresolved)"
  else
    phase "cleanup: holds KEPT — unresolved [inflight fcOpen/unknown cognition] $(unresolved)"
  fi
  phase "cleanup: done"
  [[ -f $R/stage2-costs.sh ]] && bash $R/stage2-costs.sh; echo "== STAGE 2 CLEANED UP $(ts)" ;;
*) echo "usage: --check|status|fund <txn>|publish|publish-verify|purchase|message|message-verify|refund-check|refund-verify|unexpected|cleanup|guard"; exit 2 ;;
esac
