#!/usr/bin/env bash
# Automaton Fleet — the owner-approved live checks before launch (2026-10-20, after v108). Agent-1 only; public sales stay
# CLOSED; Agent-2 stays paused; each command starts only on the owner's approval of its terms. Nothing here repairs an
# agent's work or tells it what to do: Agent-1 sees the platform's own notices and its record.
#
#   bash fleet-launch-checks.sh checks <aiCeilingPence> <hours> <ownerEmail> [mailSince]
#       ONE bounded run of Agent-1 for two checks:
#       - the WORKBOOK: its offer is not sold publicly while a spreadsheet saves formulas without their values (v108 sale
#         block; Fleet Control told Agent-1 at the install). Success = Agent-1's own new passing review of its offer's current
#         files with cached_values, displayed dates and rendering passing, and no sale block;
#       - the CUSTOMER EMAIL: the owner writes to fleet.treasury@proton.me (subject "Agent-1 - …") from <ownerEmail>; Agent-1
#         may mail that address only (an outward release for mail to it, expiring with the run). Success = the owner's mail
#         routed to Agent-1 and Agent-1's reply SENT to that address after it. [mailSince] (UTC, e.g. 2026-10-21T11:00:00Z,
#         not in the future): the owner's mail already received since then counts — a continuation answers the mail
#         already sent instead of asking the owner to write again. The reply must still be sent during this run.
#       Purchases excluded (the spend circuit breaker is tripped; stop resets it); no paid search (the media gateway stopped).
#   bash fleet-launch-checks.sh card <aiCeilingPence> <hours> <reviewBudgetPence> <maxPence ≤ 500> <accountId|register> <origin> <merchant…>
#       ONE card purchase by Agent-1 on owner-paid card 1, at the agreed merchant, at most <maxPence>: the owner's card
#       authority switched on with that cap (per charge and per day) and a card-proof release naming the merchant (v108:
#       one card request, that origin and account, ≤ 24 h, with the browser fill); the reservation comes from Agent-1's own
#       cash; Fleet Control reviews it only if its contextual signals call for it — and a review needs Fleet Control's AI
#       budget: <reviewBudgetPence> > 0 sets that daily budget for the proof (only when none is set) and clears it at the end
#       (v110); 0 sets none, so a triggered review waits (no call, never approved) and the purchase cannot go ahead. Stops at its first outcome (the card used or declined, the request expired, the hold
#       voided), the release's expiry or the run's end — and then switches card authority OFF, ends the release and clears the
#       review budget it set.
#       The statement match follows when the owner records the card statement (economy-card-charge … once).
#       `register` (v109): Agent-1 has no account at the merchant yet — the release also allows registering one there, and only
#       the account it registers under this release may be used for the fill and the one purchase.
#   bash fleet-launch-checks.sh status | stop [why]
#   (watch)  every minute while a check runs; stops it at its outcome or the run's end.
# Never: public sales, payouts, refunds, Agent-2, sweeps, runtime.env.
set -uo pipefail
export PATH=/opt/automaton-fleet/node/bin:$PATH
D="${FLEET_CHECKS_DIR:-$HOME/fleet-checks}"; mkdir -p "$D"
SELF=$(readlink -f "${BASH_SOURCE[0]}"); ARGS=("$@")
if [[ "${FLEET_TEELOG:-}" != "$SELF" ]]; then set +e; FLEET_TEELOG="$SELF" bash "$SELF" "${ARGS[@]}" 2>&1 | tee -a "$D/checks.log"; exit "${PIPESTATUS[0]}"; fi
unset FLEET_TEELOG

A1=01M3F50SH7PNX2E3GST13J52AS; A2=01M4C4NXT786Q4E9725N5A15KV
REL=0000000000000000000000000000000000000000   # Agent-1's runtime; set when staged
CTRL=$REL                                       # the installed controller release; set when staged
SLUG=uk-landlord-compliance-tracker-england-g-a9ddde
CARD_MAX=500; UNIT=fleet-checks-watch
CUR=/opt/automaton-fleet/current; NODE=/opt/automaton-fleet/node/bin/node; ENVF=/etc/automaton-fleet/runtime.env
ts() { date -u +%FT%TZ; }
A() { if [[ $EUID -eq 0 ]]; then runuser -u ubuntu -- env -C $CUR $NODE dist/fleet/postgres/cli.js "$@"; else env -C $CUR $NODE dist/fleet/postgres/cli.js "$@"; fi; }
Q() { sudo -n -u postgres psql -X -q -At -d automaton_fleet -c "SET default_transaction_read_only=on; SET search_path=fleet; $1"; }
die() { echo "!! $*"; echo "== CHECK STEP NOT COMPLETE $(ts)"; exit 1; }
pinned() { sudo -n grep -m1 '^FLEET_RUNTIME_COMMIT=' $ENVF | cut -d= -f2; }
flag_false() { sudo -n grep -qx "$1=false" $ENVF; }
current() { readlink -f $CUR; }
paused() { Q "SELECT paused FROM fleet_founder_cognition WHERE agent_id = '$1'"; }
media_active() { systemctl is-active automaton-fleet-media.service 2>/dev/null; }
breaker_tripped() { Q "SELECT tripped FROM fleet_spend_circuit_breaker WHERE id = 1"; }
card_on() { Q "SELECT enabled AND card_enabled FROM fleet_identity_autonomy WHERE id = 1"; }
release_live() { Q "SELECT count(*) FROM fleet_outward_release WHERE agent_id = '$A1' AND expires_at > now()"; }
run_open() { Q "SELECT count(*) FROM fleet_cognition_run_budgets WHERE agent_id = '$A1' AND ended_at IS NULL AND ends_at > now()"; }
START() { cat "$D/start.txt" 2>/dev/null; }
fc_set() { Q "SELECT fleet_control_ai_state() ->> 'set'"; }
MODE=""; EMAIL=""; MAILSINCE=""; [[ -f "$D/terms.txt" ]] && read -r MODE EMAIL MAILSINCE < "$D/terms.txt"
[[ -n "${FLEET_CHECKS_STUBS:-}" ]] && source "$FLEET_CHECKS_STUBS"

guard() {
  [[ "$(current)" == */$CTRL && "$(pinned)" == "$CTRL" ]] || die "the installed and pinned release is not ${CTRL:0:7}"
  [[ "$(Q "SELECT runtime_commit FROM fleet_agents WHERE agent_id='$A1'")" == "$REL" ]] || die "Agent-1 is not on ${REL:0:7}"
  for k in REAL_REPLICATION_ENABLED REAL_PAYMENTS_ENABLED OWNER_SWEEP_ENABLED FLEET_DRY_RUN_CHILD; do flag_false $k || die "$k is not false in runtime.env"; done
  [[ "$(paused $A2)" == t ]] || die "Agent-2 is NOT paused"
  [[ "$(paused $A1)" == t ]] || die "Agent-1 is running: a check starts from a paused Agent-1"
  [[ "$(Q "SELECT fleet_sales_open()")" == f ]] || die "public sales are open (these checks run with sales closed)"
  [[ -z "$(START)" ]] || die "a check is already recorded here ($(START)): status / stop it"
  [[ "$(run_open)" == 0 ]] || die "Agent-1 has an open run budget"
  [[ "$(release_live)" == 0 ]] || die "an outward release is live for Agent-1"
  [[ "$(card_on)" == f ]] || die "card authority is already on (the card proof switches it on and off itself)"
  [[ "$(Q 'SELECT count(*) FROM fleet_custody_activation_live()')" == 0 ]] || die "a custody payout activation is live"
  [[ "$(Q "SELECT count(*) FROM fleet_refund_authorities a WHERE fleet_refund_authority_live(a)")" == 0 ]] || die "a refund authority is live"
  [[ "$(media_active)" != active ]] || die "the media gateway (paid search) is running: these checks exclude paid search — stop it first"
}
watchdog_on() {
  sudo -n systemd-run --quiet --unit $UNIT --setenv=FLEET_CHECKS_DIR="$D" --on-active=1min --on-unit-active=1min /bin/bash "$SELF" watch \
    || echo "  (the watchdog could not be scheduled: run 'bash $SELF watch' every few minutes, or stop when done)"
}
offer_state() {
  Q "SELECT json_build_object('saleBlock', fleet_offer_sale_block(o), 'reviewAt', r.created_at, 'checks',
       (SELECT json_object_agg(c ->> 'id', c ->> 'status') FROM jsonb_array_elements(COALESCE(r.automated -> 'files', '[]')) f, jsonb_array_elements(COALESCE(f -> 'checks', '[]')) c
         WHERE f ->> 'detectedType' = 'xlsx' AND c ->> 'id' IN ('cached_values','sheet_displayed_dates','sheet_render')))
       FROM fleet_offers o LEFT JOIN fleet_artifact_reviews r ON r.review_id = o.review_id WHERE o.slug = '$SLUG'"
}
workbook_done() {
  [[ "$(Q "SELECT (fleet_offer_sale_block(o) IS NULL AND r.created_at >= '$(START)'
       AND (SELECT count(*) FROM jsonb_array_elements(COALESCE(r.automated -> 'files', '[]')) f, jsonb_array_elements(COALESCE(f -> 'checks', '[]')) c
             WHERE f ->> 'detectedType' = 'xlsx' AND c ->> 'id' IN ('cached_values','sheet_displayed_dates','sheet_render') AND c ->> 'status' = 'pass') >= 3)::text
       FROM fleet_offers o JOIN fleet_artifact_reviews r ON r.review_id = o.review_id WHERE o.slug = '$SLUG'")" == true ]]
}
mail_in() { Q "SELECT max(received_at) FROM fleet_agent_mail WHERE agent_id = '$A1' AND direction = 'in' AND lower(sender_address) = lower('$EMAIL') AND received_at >= '${MAILSINCE:-$(START)}'"; }
mail_out() { Q "SELECT max(received_at) FROM fleet_agent_mail WHERE agent_id = '$A1' AND direction = 'out' AND send_status = 'sent' AND lower('$EMAIL') = ANY (recipients) AND received_at >= '$(START)'"; }
email_done() { local i o; i=$(mail_in); o=$(mail_out); [[ -n "$i" && -n "$o" && "$o" > "$i" ]]; }
card_req() { Q "SELECT request_id || ' ' || status || ' ' || amount_minor || ' ' || COALESCE(charge_id::text, '-') FROM fleet_card_requests WHERE agent_id = '$A1' AND created_at >= '$(START)' ORDER BY created_at DESC LIMIT 1"; }
card_charge() { Q "SELECT status || ' ' || COALESCE(amount_minor, hold_max_minor) || ' ' || COALESCE(evidence_status, '-') FROM fleet_card_charges WHERE charge_id = '$1'"; }

report() {
  echo "  started $(START); now $(ts); mode ${MODE:-none}; Agent-1 paused=$(paused $A1); Agent-2 paused=$(paused $A2); sales open=$(Q 'SELECT fleet_sales_open()')"
  echo "  run budget: $(Q "SELECT fleet_admin_cognition_run('$A1')" | jq -c '{ceilingMinor, spentMicro, inflightMicro, calls, open, endsAt, endReason}' 2>/dev/null)"
  echo "  release live: $(release_live); card authority on: $(card_on); spend breaker tripped: $(breaker_tripped); media: $(media_active); Fleet Control AI budget set: $(fc_set)"
  echo "  workbook (Agent-1's offer): $(offer_state)"
  [[ "$MODE" == checks ]] && echo "  email: the owner's mail to Agent-1 (since ${MAILSINCE:-the start}) at $(mail_in); Agent-1's reply sent at $(mail_out)"
  if [[ "$MODE" == card ]]; then
    local r; r=$(card_req); echo "  card request: ${r:-none}"
    [[ -n "$r" && "$(awk '{print $4}' <<< "$r")" != - ]] && echo "  card charge: $(card_charge "$(awk '{print $4}' <<< "$r")")"
    echo "  Agent-1's cash since the start: $(Q "SELECT COALESCE(string_agg(j.kind || ' ' || s, '; '), 'none') FROM (SELECT j.kind, sum(CASE p.side WHEN 'D' THEN p.amount_cents ELSE -p.amount_cents END) s FROM fleet_ledger_postings p JOIN fleet_ledger_journal j ON j.journal_id = p.journal_id WHERE p.account_id = fleet_ledger_account('$A1', 'agent_cash') AND j.recorded_at >= '$(START)' GROUP BY j.kind) j")"
  fi
  echo "  ledger verify $(Q "SELECT fleet_ledger_verify()->>'ok'")"
}
stop_check() {
  local why=$1 bad=0
  A founder-cognition $A1 pause "launch check ended: $why" >/dev/null 2>&1 || bad=1
  A cognition-run $A1 end "$why" >/dev/null 2>&1 || true
  [[ "$(release_live)" != 0 ]] && { A economy-outward $A1 hold >/dev/null 2>&1 || bad=1; }
  if [[ "$MODE" == card && "$(card_on)" == t ]]; then A owner-identity-autonomy off "card proof ended: $why" >/dev/null 2>&1 || bad=1; fi
  if [[ -f "$D/review-budget-set.txt" && "$(fc_set)" == true ]]; then A economy-fleet-control-ai-budget off "card proof ended: $why" >/dev/null 2>&1 || bad=1; fi
  if [[ -f "$D/breaker-tripped.txt" && "$(breaker_tripped)" == t ]]; then A economy-spend-breaker reset >/dev/null 2>&1 || bad=1; fi
  # From the watchdog's own unit: stop only its timer — stopping the running service would kill this script before the
  # stop is confirmed, reported and filed (2026-10-21 11:02Z: the cleanup ran, its record did not). The service ends on exit.
  if [[ -n "${IN_WATCH:-}" ]]; then sudo -n systemctl stop $UNIT.timer >/dev/null 2>&1 || true
  else sudo -n systemctl stop $UNIT.timer $UNIT.service >/dev/null 2>&1 || true; fi
  [[ "$(paused $A1)" == t && "$(release_live)" == 0 && "$(card_on)" == f ]] || bad=1
  [[ -f "$D/review-budget-set.txt" && "$(fc_set)" != false ]] && bad=1
  echo "== CHECK STOPPED $(ts): $why — Agent-1 paused; run ended; release ended; card authority $( [[ "$(card_on)" == f ]] && echo OFF || echo 'STILL ON')$( (( bad )) && echo ' — VERIFY: a step did not confirm')"
  report
  mkdir -p "$D/done-$(date -u +%Y%m%dT%H%M%SZ)" && mv -f "$D/start.txt" "$D/terms.txt" "$D/breaker-tripped.txt" "$D/review-budget-set.txt" "$D"/done-*/ 2>/dev/null || true
}

case "${1:-}" in
checks)
  [[ "${2:-}" =~ ^[0-9]+$ && "${3:-}" =~ ^[0-9]+$ && "${4:-}" =~ ^[^@[:space:]]{1,64}@[a-z0-9.-]{3,190}$ ]] && (( $2 >= 1 && $2 <= 1000 && $3 >= 1 && $3 <= 12 )) \
    && [[ -z "${5:-}" || ( "$5" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ && ! "$5" > "$(ts)" ) ]] \
    || die "usage: checks <aiCeilingPence 1..1000> <hours 1..12> <ownerEmail (lower case)> [mailSince YYYY-MM-DDTHH:MM:SSZ, not in the future]"
  guard
  [[ "$(Q "SELECT count(*) FROM fleet_offers WHERE slug = '$SLUG' AND agent_id = '$A1'")" == 1 ]] || die "Agent-1's offer $SLUG is not found"
  s=$(ts); echo "$s" > "$D/start.txt"; echo "checks $4 ${5:-}" > "$D/terms.txt"; MODE=checks; EMAIL=$4; MAILSINCE=${5:-}
  echo "  the workbook now: $(offer_state)"
  A economy-spend-breaker trip "launch checks: purchases are excluded from this run" | jq -c '{tripped}' || { stop_check "breaker not tripped"; exit 1; }
  echo "$s" > "$D/breaker-tripped.txt"
  A cognition-run $A1 start $2 $3 "launch checks: Agent-1's own work and the live customer email; AI ceiling ${2}p" | jq -c '.run | {ceilingMinor, endsAt}' || { stop_check "run budget not opened"; exit 1; }
  A economy-outward $A1 release "{\"actions\":[\"mail\"],\"mailTo\":[\"$4\"],\"expiresHours\":$3}" "launch check: replying to the owner's email to support" | jq -c '{ok, expiresAt}' \
    || { stop_check "the mail release was not recorded"; exit 1; }
  watchdog_on
  A founder-cognition $A1 resume "launch checks (owner approval): AI ceiling ${2}p, $3 h; public sales stay closed" | jq -c '{paused}' || { stop_check "resume failed"; exit 1; }
  echo "== CHECKS STARTED $s: now write to fleet.treasury@proton.me from $4 with the subject \"Agent-1 - …\" (your own question)"; report ;;
card)
  [[ "${2:-}" =~ ^[0-9]+$ && "${3:-}" =~ ^[0-9]+$ && "${4:-}" =~ ^[0-9]+$ && "${5:-}" =~ ^[0-9]+$ && "${6:-}" =~ ^([0-9a-f-]{36}|register)$ && "${7:-}" =~ ^https://[a-z0-9.-]+(:[0-9]+)?$ && -n "${8:-}" ]] \
    && (( $2 >= 1 && $2 <= 1000 && $3 >= 1 && $3 <= 24 && $4 <= 100 && $5 >= 1 && $5 <= CARD_MAX )) \
    || die "usage: card <aiCeilingPence 1..1000> <hours 1..24> <reviewBudgetPence 0..100> <maxPence 1..$CARD_MAX> <accountId|register> <https://merchant-origin> <merchant name…>"
  guard
  RB=$4; set -- "${@:1:3}" "${@:5}"   # the rest as before: $4 max, $5 account, $6 origin, $7… merchant
  (( RB == 0 )) || [[ "$(fc_set)" == false ]] || die "Fleet Control's AI budget is already set: run with reviewBudgetPence 0 (it is left as it is)"
  [[ "$(breaker_tripped)" == f ]] || die "the spend circuit breaker is tripped: a card purchase could not be reserved"
  if [[ "$5" != register ]]; then
    [[ "$(Q "SELECT count(*) FROM fleet_agent_accounts WHERE account_id = '$5' AND agent_id = '$A1' AND '$6' = ANY (origins) AND status NOT IN ('frozen','closed','banned')")" == 1 ]] \
      || die "account $5 is not one of Agent-1's usable accounts with origin $6"
  fi
  [[ "$(Q "SELECT count(*) FROM fleet_owner_identity_classes WHERE class_key = 'payment_card' AND status = 'configured' AND (expires_at IS NULL OR expires_at > now())")" == 1 ]] || die "card 1 is not on file"
  merchant="${*:7}"
  s=$(ts); echo "$s" > "$D/start.txt"; echo "card -" > "$D/terms.txt"; MODE=card
  if (( RB > 0 )); then
    A economy-fleet-control-ai-budget $RB "card proof: a review of the one purchase, if its signals call for one (cleared at the end)" | jq -c '{ok, ceilingMinor}' \
      || { stop_check "the review budget was not set"; exit 1; }
    echo "$s" > "$D/review-budget-set.txt"
  fi
  A owner-identity-autonomy on --card on --card-max $4 --card-daily $4 "card proof: one purchase at $merchant, at most ${4}p (switched off at the end)" | jq -c '{cardEnabled, cardMaxChargeMinor, cardMaxDailyMinor}' \
    || { stop_check "card authority not set"; exit 1; }
  if [[ "$5" == register ]]; then acts='"browser","card","account_register"'; accts=''; else acts='"browser","card"'; accts="\"accounts\":[\"$5\"],"; fi
  A economy-outward $A1 release "{\"actions\":[$acts],$accts\"origins\":[\"$6\"],\"cardMerchant\":$(jq -Rn --arg m "$merchant" '$m'),\"cardMaxMinor\":$4,\"expiresHours\":$3}" \
    "card proof: one purchase at $merchant, at most ${4}p" | jq -c '{ok, expiresAt}' || { stop_check "the card-proof release was not recorded"; exit 1; }
  A cognition-run $A1 start $2 $3 "card proof: one purchase at $merchant, at most ${4}p; AI ceiling ${2}p" | jq -c '.run | {ceilingMinor, endsAt}' || { stop_check "run budget not opened"; exit 1; }
  watchdog_on
  A founder-cognition $A1 resume "card proof (owner approval): one purchase at $merchant, at most ${4}p; AI ceiling ${2}p, $3 h; sales stay closed" | jq -c '{paused}' || { stop_check "resume failed"; exit 1; }
  echo "== CARD PROOF STARTED $s: Agent-1 may make ONE purchase at $merchant ($6), at most ${4}p, on card 1; approve any 3-D Secure prompt in your bank's app"; report ;;
watch)
  IN_WATCH=1
  [[ -n "$(START)" && "$(paused $A1)" == f ]] || { sudo -n systemctl stop $UNIT.timer >/dev/null 2>&1; exit 0; }
  [[ "$(run_open)" == 0 ]] && { stop_check "the run ended ($(Q "SELECT fleet_admin_cognition_run('$A1')" | jq -r '.endReason // "its time or ceiling"'))"; exit 0; }
  if [[ "$MODE" == checks ]]; then
    workbook_done && email_done && { stop_check "CHECKS COMPLETE: Agent-1's corrected workbook passed inspection (saved values, displayed dates, rendering; no sale block) and it answered the owner's email"; exit 0; }
  fi
  if [[ "$MODE" == card ]]; then
    r=$(card_req)
    if [[ -n "$r" ]]; then
      read -r rid rst ramt rch <<< "$r"
      case "$rst" in declined|expired) stop_check "CARD PROOF ENDED: the card request was $rst"; exit 0;; esac
      if [[ "$rch" != - ]]; then
        case "$(card_charge "$rch" | awk '{print $1}')" in
          booked|confirmed) stop_check "CARD PROOF: the purchase is charged (${ramt}p reserved) — the statement match follows when the card statement is recorded"; exit 0;;
          void) stop_check "CARD PROOF ENDED: the card hold was voided"; exit 0;;
        esac
      fi
    fi
    [[ "$(release_live)" == 0 ]] && { stop_check "the card-proof release expired"; exit 0; }
  fi
  exit 0 ;;
status) report ;;
stop) [[ -n "$(START)" ]] || die "no check is running"; stop_check "${2:-owner stopped the check}" ;;
*) sed -n 2,31p "$0"; exit 2 ;;
esac
