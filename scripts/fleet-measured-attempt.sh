#!/usr/bin/env bash
# Automaton Fleet — a measured live attempt for Agent-1 (launch-readiness §2b). Starts ONLY on the owner's separate approval
# of its terms. Agent-1 only; Agent-2 must stay paused. Run from the INSTALLED release (never a hand-staged copy):
#
#   bash /opt/automaton-fleet/current/scripts/fleet-measured-attempt.sh start <ceilingPence> <priorPence> <totalPence> [<offerSlug>]
#       the owner's approved terms: this run's AI ceiling, what earlier attempts of the same allowance used, and the total;
#       the ceiling must be positive and fit total − prior. <offerSlug>: the offer the attempt is for (an existing offer of
#       Agent-1's); without it, success needs an offer CREATED during the attempt. Guards (controller, Agent-1 and the
#       pinned runtime are the same commit; both agents paused; outward release, card authority, custody and sales closed;
#       no open run budget; the four safety flags false) → the run budget (6 h) → the watchdog (every minute) → resume.
#   … status          read-only progress (calls, cost, searches, Fleet Control reviews, offers, Agent-1's waiting state)
#   … stop [why]      pause Agent-1, end the run budget, disarm the watchdog, print the report
#   (watch)           the watchdog: pauses Agent-1 on success, a stated failure, the budget, the time or a stall
#
# Success: the intended offer is published DURING the attempt (an offer_published event since the start — a republish keeps
# the first published_at), its review passed, and for a product that review covers exactly its current files. Another
# offer's publication never completes the attempt.
# What the attempt may do: research, build, inspect and publish a private offer (sales stay closed). What it cannot do: no
# outward release (mail, posting, registration), card authority off, custody off, no purchase. It never touches Agent-2,
# sales, sweep, sizing, the cap, the fuses or the safety flags. State and log: $FLEET_ATTEMPT_DIR (default ~/fleet-attempt).
# The exit status is the real one; the log is complete when the script returns.
set -uo pipefail
export PATH=/opt/automaton-fleet/node/bin:$PATH
D="${FLEET_ATTEMPT_DIR:-$HOME/fleet-attempt}"; mkdir -p "$D"
# Log to <report> as well as the terminal, and finish only once the log is complete: teelog re-runs this script with its
# output piped through tee, and a pipeline waits for tee; an exec redirection into a tee process substitution does not (the
# 32634bf install lost its final lines when the SSH session closed, 2026-10-18). The exit status is the script's own.
# Everything before the call is read-only.
SELF=$(readlink -f "${BASH_SOURCE[0]}"); ARGS=("$@")
teelog() {  # teelog <report> [tee options]
  if [[ "${FLEET_TEELOG:-}" == "$SELF" ]]; then unset FLEET_TEELOG; return 0; fi
  set +e; FLEET_TEELOG="$SELF" bash "$SELF" "${ARGS[@]}" 2>&1 | tee "${@:2}" "$1"; exit "${PIPESTATUS[0]}"
}
teelog "$D/attempt.log" -a

A1=01M3F50SH7PNX2E3GST13J52AS; A2=01M4C4NXT786Q4E9725N5A15KV
HOURS=6; MAX_SEARCHES=40; STALL_MIN=30; MAX_FAILED_OFFER=4; UNIT=fleet-attempt-watch
CUR=/opt/automaton-fleet/current; NODE=/opt/automaton-fleet/node/bin/node; ENVF=/etc/automaton-fleet/runtime.env
FOUNDERS=/var/lib/private/automaton-founders
ts() { date -u +%FT%TZ; }
A() { if [[ $EUID -eq 0 ]]; then runuser -u ubuntu -- env -C $CUR $NODE dist/fleet/postgres/cli.js "$@"; else env -C $CUR $NODE dist/fleet/postgres/cli.js "$@"; fi; }
Q() { sudo -n -u postgres psql -X -q -At -d automaton_fleet -c "SET default_transaction_read_only=on; SET search_path=fleet; $1"; }
die() { echo "!! $*"; echo "== ATTEMPT STEP NOT COMPLETE $(ts)"; exit 1; }
pounds() { echo "£$(($1 / 100)).$(printf %02d $(($1 % 100)))"; }
pinned() { sudo -n grep -m1 '^FLEET_RUNTIME_COMMIT=' $ENVF | cut -d= -f2; }
flag_false() { sudo -n grep -qx "$1=false" $ENVF; }
current() { readlink -f $CUR; }
state_dir() { sudo -n find $FOUNDERS/$A1/state -mindepth 1 -maxdepth 1 -type d -name 'st_*' 2>/dev/null; }
# Agent-1's own continuity record (read-only): whether it is waiting, for what, and on which runtime it last thought.
waiting() {
  local s; s=$(state_dir); [[ $(wc -w <<< "$s") -eq 1 ]] || { echo '{"waiting":"unknown"}'; return; }
  sudo -n cat "$s/mind-continuity.json" 2>/dev/null | jq -c '{waiting: (.waiting // false), wakeOn, reviewAt, runtime: ((.runtime // "unrecorded") | if test("^[0-9a-f]{40}$") then .[0:7] else . end), at}' 2>/dev/null || echo '{"waiting":"unknown"}'
}
paused() { Q "SELECT paused FROM fleet_founder_cognition WHERE agent_id = '$1'"; }
START() { cat "$D/attempt-start.txt" 2>/dev/null; }
# The owner's terms of THIS attempt, written once by `start` (a stale budget cannot carry over to the next attempt).
CEILING=0; PRIOR_PENCE=0; TOTAL_PENCE=0; SLUG=-
terms() { [[ -f "$D/attempt-terms.txt" ]] && read -r CEILING PRIOR_PENCE TOTAL_PENCE SLUG < "$D/attempt-terms.txt"; true; }
closed() {
  [[ "$(Q 'SELECT count(*) FROM fleet_outward_release WHERE expires_at > now()')" == 0 && "$(Q 'SELECT card_enabled OR enabled FROM fleet_identity_autonomy')" == f \
     && "$(Q 'SELECT custody_activation_id IS NULL FROM fleet_economic_model WHERE id = 1')" == t && "$(Q 'SELECT fleet_sales_open()')" == f ]]
}
# The success rule: the intended offer, published during this attempt, on a passing review of its current files.
succeeded() {
  local s=$1 which
  if [[ "$SLUG" != - ]]; then which="o.slug = '$SLUG'"; else which="o.created_at >= '$s'"; fi
  Q "SELECT count(*) FROM fleet_offers o JOIN fleet_artifact_reviews r ON r.review_id = o.review_id
      WHERE o.agent_id = '$A1' AND o.status = 'published' AND r.verdict = 'pass' AND $which
        AND (o.kind <> 'product' OR r.files_digest = fleet_files_digest(fleet_offer_deliverables(o.offer_id)))
        AND EXISTS (SELECT 1 FROM fleet_events e WHERE e.event_type = 'offer_published' AND e.agent_id = '$A1'
                      AND e.created_at >= '$s' AND e.detail ->> 'offerId' = o.offer_id::text)"
}
# The intended offer as it already stands (before <ts>): published on a passing review of its current files. A product-creation
# attempt with it in place has nothing to make, and an agent waiting beside it for customers is not stalled (attempt 3).
published_offer() {
  local before=$1 which
  if [[ "$SLUG" != - ]]; then which="o.slug = '$SLUG'"; else which="true"; fi
  Q "SELECT o.slug FROM fleet_offers o JOIN fleet_artifact_reviews r ON r.review_id = o.review_id
      WHERE o.agent_id = '$A1' AND o.status = 'published' AND r.verdict = 'pass' AND $which AND o.published_at < '$before'
        AND (o.kind <> 'product' OR r.files_digest = fleet_files_digest(fleet_offer_deliverables(o.offer_id)))
      ORDER BY o.published_at LIMIT 1"
}
failed_offer() {
  local s st; s=$(START); st=$(state_dir); [[ $(wc -w <<< "$st") -eq 1 ]] || { echo 0; return; }
  sudo -n cat "$st/mind-log.jsonl" 2>/dev/null | python3 -I -c "
import json, sys
n = 0
for l in sys.stdin:
    try: o = json.loads(l)
    except Exception: continue
    if not isinstance(o, dict) or str(o.get('at', '')) < sys.argv[1]: continue
    n += sum(1 for t in o.get('tools', []) if isinstance(t, dict) and t.get('name') == 'offer' and t.get('refused'))
print(n)" "$s"
}
product() {
  echo "  PRODUCT — Agent-1's offers, files and inspection:"
  Q "SELECT '    offer '||slug||' · '||status||' · £'||to_char(price_minor/100.0,'FM990.00')||' · '||title||chr(10)||'      summary: '||left(regexp_replace(COALESCE(summary,''),'\s+',' ','g'),300)||chr(10)||'      published: '||COALESCE(published_at::text,'not yet')||' · review '||COALESCE(left(review_id::text,8),'none') FROM fleet_offers WHERE agent_id='$A1' ORDER BY created_at"
  Q "SELECT '      file '||f.file_name||' ('||f.content_type||', '||f.size_bytes||' bytes, sha '||left(f.content_sha256,12)||')' FROM fleet_offer_files f JOIN fleet_offers o ON o.offer_id=f.offer_id WHERE o.agent_id='$A1' AND f.removed_at IS NULL ORDER BY f.added_at"
  Q "SELECT '    review '||left(review_id::text,8)||' · '||verdict||' · inspector '||COALESCE(inspector,'?')||' · automated '||COALESCE(automated_ok::text,'?')||' · independent '||COALESCE(independent_verdict,'none')||' · '||to_char(created_at,'HH24:MI:SS')||chr(10)||'      notes: '||left(regexp_replace(COALESCE(notes,''),'\s+',' ','g'),300) FROM fleet_artifact_reviews WHERE agent_id='$A1' ORDER BY created_at DESC LIMIT 3"
}
report() {
  local s spent; s=$(START); [[ -n "$s" ]] || { echo "  no attempt recorded"; return; }
  echo "  started $s; now $(ts); Agent-1 paused=$(paused $A1); Agent-2 paused=$(paused $A2); intended offer: $([[ "$SLUG" != - ]] && echo "$SLUG" || echo "one created during the attempt")"
  echo "  run budget: $(Q "SELECT fleet_admin_cognition_run('$A1')" | jq -c '{ceilingMinor, spentPence: (.spentMicro/1000000), inflightPence: (.inflightMicro/1000000), calls, open, endsAt, endReason}')"
  echo "  model calls since start: $(Q "SELECT count(*)||' ('||COALESCE(sum(input_tokens),0)||' in, '||COALESCE(sum(cache_read_tokens),0)||' cache-read, '||COALESCE(sum(output_tokens),0)||' out), provider \$'||round(COALESCE(sum(provider_usd_microcents),0)/1e8,4)||', charged '||COALESCE(sum(charged_cents),0)||'p (Fleet-recorded, provisional)' FROM fleet_cognition_log WHERE agent_id='$A1' AND at >= '$s'")"
  spent=$(Q "SELECT COALESCE(sum(charged_cents),0) FROM fleet_cognition_log WHERE agent_id='$A1' AND at >= '$s'")
  echo "  CUMULATIVE across attempts: ${PRIOR_PENCE}p (earlier attempts) + ${spent}p (this run) = $((PRIOR_PENCE + spent))p of the $(pounds $TOTAL_PENCE) total"
  echo "  Agent-1 waiting state: $(waiting)"
  echo "  failed offer actions this run: $(failed_offer)"
  echo "  searches since start: $(Q "SELECT count(*)||' ('||COALESCE(sum(charged_minor),0)||'p)' FROM fleet_media_jobs WHERE agent_id='$A1' AND created_at >= '$s'")"
  echo "  Fleet Control reviews since start (treasury-paid, outside the ceiling): spend $(Q "SELECT count(*) FROM fleet_spend_reviews WHERE agent_id='$A1' AND created_at >= '$s'"), lessons $(Q "SELECT count(*) FROM fleet_knowledge_proposals WHERE agent_id='$A1' AND submitted_at >= '$s'")"
  echo "  offers published since start:"; Q "SELECT '    '||o.slug||' · '||o.status||' · '||o.price_minor||'p · '||left(o.title,80) FROM fleet_offers o WHERE o.agent_id='$A1' AND EXISTS (SELECT 1 FROM fleet_events e WHERE e.event_type='offer_published' AND e.agent_id='$A1' AND e.created_at >= '$s' AND e.detail->>'offerId' = o.offer_id::text) ORDER BY o.created_at"
  echo "  its closing notes (last 5):"; Q "SELECT '    '||to_char(at,'HH24:MI')||' '||left(regexp_replace(COALESCE(outcome,''),'\s+',' ','g'),160) FROM fleet_agent_mind_reports WHERE agent_id='$A1' AND at >= '$s' AND COALESCE(outcome,'') <> '' ORDER BY at DESC LIMIT 5"
  echo "  AGENT_CANNOT_THINK since start: $(Q "SELECT count(*) FROM fleet_notifications WHERE code='AGENT_CANNOT_THINK' AND agent_id='$A1' AND created_at >= '$s'")"
  product
}
stop_attempt() {
  local why="$1"
  A founder-cognition $A1 pause "measured attempt stopped: $why" >/dev/null 2>&1 || true
  A cognition-run $A1 end "$why" >/dev/null 2>&1 || true
  sudo -n systemctl stop $UNIT.timer $UNIT.service >/dev/null 2>&1 || true
  [[ "$(paused $A1)" == t ]] || { echo "!! Agent-1 is NOT paused: run stop again"; exit 1; }
  echo "== ATTEMPT STOPPED $(ts): $why"; report
}
# Tests replace the host commands (Q, A, sudo, …) here; production never sets it.
if [[ -n "${FLEET_ATTEMPT_STUBS:-}" ]]; then source "$FLEET_ATTEMPT_STUBS"; fi
[[ $EUID -eq 0 ]] || sudo -v || exit 2
terms

case "${1:-}" in
start)
  [[ "${2:-}" =~ ^[0-9]+$ && "${3:-}" =~ ^[0-9]+$ && "${4:-}" =~ ^[0-9]+$ ]] || die "usage: start <ceilingPence> <priorPence> <totalPence> [<offerSlug>] (the owner's approved terms)"
  (( $2 > 0 && $2 + $3 <= $4 )) || die "the ceiling ($2p) must be positive and within the total ($4p) less earlier attempts ($3p)"
  slug="${5:--}"; [[ "$slug" == - || "$slug" =~ ^[a-z0-9][a-z0-9-]{0,119}$ ]] || die "the offer slug is not a slug"
  C=$(pinned); [[ "$C" =~ ^[0-9a-f]{40}$ ]] || die "the pinned runtime commit is unreadable"
  [[ "$(current)" == */$C ]] || die "the controller is not on the pinned ${C:0:7}"
  [[ "$SELF" == */$C/scripts/fleet-measured-attempt.sh ]] || die "run this from the installed release (${C:0:7}), not a copy"
  [[ "$(Q "SELECT runtime_commit FROM fleet_agents WHERE agent_id='$A1'")" == "$C" ]] || die "Agent-1 is not on ${C:0:7} (upgrade it first)"
  [[ "$(paused $A1)" == t && "$(paused $A2)" == t ]] || die "both agents must be paused"
  closed || die "an outward release, card authority, custody or sales is open"
  [[ "$(Q 'SELECT count(*) FROM fleet_cognition_run_budgets WHERE ended_at IS NULL')" == 0 ]] || die "a run budget is already open"
  for k in REAL_REPLICATION_ENABLED REAL_PAYMENTS_ENABLED OWNER_SWEEP_ENABLED FLEET_DRY_RUN_CHILD; do flag_false $k || die "$k is not false"; done
  [[ "$slug" == - || "$(Q "SELECT count(*) FROM fleet_offers WHERE agent_id='$A1' AND slug='$slug'")" == 1 ]] || die "Agent-1 has no offer $slug"
  [[ $(wc -w <<< "$(state_dir)") -eq 1 ]] || die "Agent-1's state directory is not unique"
  SLUG=$slug; have=$(published_offer "$(ts)")
  [[ -z "$have" ]] || die "nothing to create: Agent-1's offer $have is already published on a passing review. A product-creation attempt would only watch it wait (attempt 3, 2026-10-19); the next useful event is a customer order (the owner's proof purchase)"
  CEILING=$2; PRIOR_PENCE=$3; TOTAL_PENCE=$4; SLUG=$slug
  echo "$CEILING $PRIOR_PENCE $TOTAL_PENCE $SLUG" > "$D/attempt-terms.txt"
  ts > "$D/attempt-start.txt"
  echo "  1. run budget $(pounds $CEILING) for ${HOURS} h — of the $(pounds $TOTAL_PENCE) total (earlier attempts used ${PRIOR_PENCE}p); checked before every model request"
  A cognition-run $A1 start $CEILING $HOURS "measured attempt: $(pounds $CEILING) of $(pounds $TOTAL_PENCE) total (${PRIOR_PENCE}p used before)" | jq -c '.run | {ceilingMinor, endsAt}' || die "run budget not opened"
  echo "  2. watchdog every minute (backup to the run budget: success, refusal, search, stall and fault checks)"
  sudo systemd-run --quiet --unit $UNIT --setenv=FLEET_ATTEMPT_DIR="$D" --on-active=1min --on-unit-active=1min /bin/bash "$SELF" watch \
    || { A cognition-run $A1 end "watchdog not armed" >/dev/null; die "watchdog not armed (nothing resumed)"; }
  echo "  3. resume Agent-1"
  A founder-cognition $A1 resume "measured attempt (owner approval): $(pounds $CEILING) run budget, ${HOURS} h" | jq -c '{paused}' || { stop_attempt "resume failed"; exit 1; }
  # A waiting founder thinks again only when something changes (a new runtime does: it wakes once and is told). Say so now
  # rather than after STALL_MIN minutes: an attempt on the same runtime with nothing new for it may stall, at no cost.
  w=$(waiting); if [[ "$(jq -r '.waiting' <<< "$w")" == true && "$(jq -r '.runtime' <<< "$w")" == "${C:0:7}" ]]; then
    echo "  NOTE: Agent-1 is waiting on this same runtime ($w): it thinks again only when something it waits for changes; with nothing new the watchdog stops the attempt as STALLED after ${STALL_MIN} min (no cost)."
  fi
  echo "== ATTEMPT STARTED $(START): Agent-2 paused; sales closed; no outward release; card and custody off"; report ;;
status) report ;;
stop) stop_attempt "${2:-stopped by the owner}" ;;
watch)
  s=$(START); [[ -n "$s" && "$(paused $A1)" == f ]] || { sudo -n systemctl stop $UNIT.timer >/dev/null 2>&1; exit 0; }
  run=$(Q "SELECT fleet_admin_cognition_run('$A1')")
  [[ "$(succeeded "$s")" =~ ^[1-9][0-9]*$ ]] && { stop_attempt "SUCCESS: the intended private offer is published on a passing review of its current files"; exit 0; }
  [[ "$(jq -r '.open' <<< "$run")" == true ]] || { stop_attempt "the run budget is spent or its time is up"; exit 0; }
  (( $(jq -r '(.spentMicro + .inflightMicro) / 1000000 | floor' <<< "$run") >= CEILING - 5 )) && { stop_attempt "the run budget is (nearly) spent"; exit 0; }
  (( $(Q "SELECT count(*) FROM fleet_media_jobs WHERE agent_id='$A1' AND created_at >= '$s'") >= MAX_SEARCHES )) && { stop_attempt "the search limit ($MAX_SEARCHES) is reached"; exit 0; }
  (( $(failed_offer) >= MAX_FAILED_OFFER )) && { stop_attempt "FAILURE: offer actions refused $MAX_FAILED_OFFER times (repeated failed publication)"; exit 0; }
  (( $(Q "SELECT count(*) FROM fleet_notifications WHERE code='AGENT_CANNOT_THINK' AND agent_id='$A1' AND created_at >= '$s'") > 0 )) && { stop_attempt "FAILURE: the agent cannot think (packet)"; exit 0; }
  last=$(Q "SELECT COALESCE(max(at), '$s'::timestamptz) FROM fleet_cognition_log WHERE agent_id='$A1' AND at >= '$s'")
  if [[ "$(Q "SELECT '$last'::timestamptz < now() - interval '$STALL_MIN minutes'")" == t ]]; then
    have=$(published_offer "$s")
    [[ -n "$have" && "$(jq -r '.waiting' <<< "$(waiting)")" == true ]] \
      && { stop_attempt "WAITING, NOT A FAILURE: the intended offer $have was already published; Agent-1 waits for customer work (none while sales are closed) — nothing to create"; exit 0; }
    stop_attempt "STALLED: no model call for $STALL_MIN minutes and no offer (waiting with nothing to act on)"; exit 0
  fi
  exit 0 ;;
*) sed -n 2,22p "$0"; exit 2 ;;
esac
