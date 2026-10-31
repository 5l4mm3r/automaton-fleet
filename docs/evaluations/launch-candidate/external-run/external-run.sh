#!/usr/bin/env bash
# One bounded live attempt: Agent-1 chooses a venture, records why, prepares a private offer and, if it needs an account, asks once and waits.
# PREPARED, NOT RUN. Needs the owner's word and the release in place. Nothing here publishes, sends, pays or accepts an order: the agent stays held from outside work.
#
#   bash external-run.sh --check <usdCeiling> <hours>   read-only: every gate and the hold arithmetic; writes nothing
#   bash external-run.sh start   <usdCeiling> <hours>   holds, run ceiling, independent stop timer, inference on, task, Agent-1 resumed
#   bash external-run.sh stop    <reason…>              pause, inference off; safe to run any number of times
#   bash external-run.sh status                         read-only: what stops it, and what it has cost
#
# Limits, each enforced apart from the agent's instructions:
#   1. Provider credit: free credit is set to exactly the ceiling. A call reserves its worst case first, so spend cannot pass it; the run usually stops short of it.
#   2. Run ceiling in the accounting currency (fleet_cognition_run_budgets), with an end time.
#   3. A one-off timer on this host pauses Agent-1 and turns inference off at the end time, even with no session open.
#   4. Outward hold: no release is granted, so account registration, browser actions that change a page, mail, listings and API jobs are refused.
#   Sales stay closed and the spend breaker stays tripped: customer checkout and card or order spending stay shut. Fleet Control AI and image generation must be off.
#   Reading the public web stays open: a link followed can have an effect on the site it points to. Web search costs 1p each, at most 20 a day.
set -uo pipefail
# ── production identities ──
A1=01M3F50SH7PNX2E3GST13J52AS; AGENTS_PAUSED="01M3F5:true,01M4C4:true"; EXPECT_COMMIT=608624a72728f8b06e94ebdbd17eb33522f84931
# ── host bindings (a rehearsal replaces exactly this block; nothing else) ──
N=/opt/automaton-fleet/node/bin/node; W=/opt/automaton-fleet/current; TIMER=fleet-external-run-stop
Q() { sudo -n -u postgres psql -X -q -At -d automaton_fleet -c "SET default_transaction_read_only=on; SET search_path=fleet; $1"; }
cli() { ( cd "$W" && "$N" dist/fleet/postgres/cli.js "$@" ); }
release_now() { readlink -f "$W" | xargs basename; }
timer_arm() { sudo -n systemd-run --unit="$TIMER" --on-calendar="$1" --timer-property=AccuracySec=1s --uid="$(id -u)" --working-directory="$W" --setenv=HOME="$HOME" /bin/bash -c "$N dist/fleet/postgres/cli.js founder-cognition $A1 pause 'external run time limit'; $N dist/fleet/postgres/cli.js cognition-disable" > /dev/null; }
timer_active() { systemctl show -p ActiveState --value "$TIMER.timer" 2>/dev/null; }
timer_off() { sudo -n systemctl stop "$TIMER.timer" 2>/dev/null; true; }
search_up() { systemctl is-active -q automaton-fleet-media; }
need_sudo() { sudo -v; }
# ── end of host bindings ──
EXPECT_SCHEMA=125; HOLD="external-run-cap-$(date +%s)"; KEEP=stage2-obligation-reserve; OLD_HOLDS="stage1-research-cap stage2-cap"
free() { Q "SELECT fleet_provider_credit_balance('anthropic') - fleet_provider_credit_held('anthropic')"; }
die() { echo "!! $*"; exit 1; }

# Stops first and proves it. The timer and run ceiling go only once the pause and the inference switch read back as stopped: until then they are still protecting.
stop_run() {
  cli founder-cognition "$A1" pause "external run stopped: $*" > /dev/null
  cli cognition-disable > /dev/null
  cli economy-fleet-control-ai-budget off "external run stopped: $*" > /dev/null
  sleep "${SETTLE:-6}"
  local p i; p=$(Q "SELECT paused FROM fleet_founder_cognition WHERE agent_id='$A1'"); i=$(Q 'SELECT cognition_enabled FROM fleet_cognition_policy WHERE id = 1')
  if [[ "$p" != t || "$i" != f ]]; then
    echo "!! NOT STOPPED: Agent-1 paused=$p, inference on=$i. The stop timer and run ceiling are still in place. Use Admin HQ, or run this again."
    return 1
  fi
  timer_off
  cli cognition-run "$A1" end "external run stopped: $*" > /dev/null 2>&1
  echo "stopped: Agent-1 paused, inference off, in flight $(Q 'SELECT count(*) FROM fleet_cognition_inflight')"
}

status() {
  echo "inference $(Q 'SELECT cognition_enabled FROM fleet_cognition_policy'); paused $(Q "SELECT string_agg(left(agent_id,6)||':'||paused,',' ORDER BY agent_id) FROM fleet_founder_cognition"); in flight $(Q 'SELECT count(*) FROM fleet_cognition_inflight'); sales $(Q 'SELECT fleet_sales_open()'); breaker $(Q 'SELECT tripped FROM fleet_spend_circuit_breaker WHERE id = 1')"
  echo "free credit (1e-8 USD) $(free); holds $(Q "SELECT string_agg(run_id||' '||usd_microcents,', ' ORDER BY run_id) FROM fleet_provider_credit_holds WHERE status='open'")"
  echo "outward released: $(Q "SELECT count(*) FROM fleet_outward_release WHERE expires_at > now()"); open owner tasks: $(Q "SELECT count(*) FROM fleet_owner_tasks WHERE agent_id='$A1' AND closed_at IS NULL"); stop timer: $(timer_active)"
  echo "since start: $(Q "SELECT 'calls '||count(*)||', errors '||count(*) FILTER (WHERE outcome<>'ok')||', cost 1e-8 USD '||COALESCE(sum(provider_usd_microcents),0) FROM fleet_cognition_log WHERE agent_id='$A1' AND at > COALESCE((SELECT max(starts_at) FROM fleet_cognition_run_budgets WHERE agent_id='$A1'), now())")"
  echo "accounts $(Q "SELECT count(*) FROM fleet_agent_accounts WHERE agent_id='$A1'"); ventures $(Q "SELECT string_agg(venture_key||':'||state,', ') FROM fleet_ventures WHERE agent_id='$A1'")"
}

gates() {
  local usd=$1 hours=$2
  [[ "$usd" =~ ^[0-9]+(\.[0-9]{1,2})?$ ]] || die "the ceiling is US dollars, e.g. 10"
  [[ "$hours" =~ ^[0-9]+$ ]] && (( hours >= 1 && hours <= 24 )) || die "hours is 1 to 24"
  [[ "$(release_now)" == "$EXPECT_COMMIT" ]] || die "current release is not $EXPECT_COMMIT"
  [[ "$(Q 'SELECT max(version) FROM fleet_schema_migrations')" == "$EXPECT_SCHEMA" ]] || die "schema is not $EXPECT_SCHEMA"
  [[ "$(Q "SELECT string_agg(left(agent_id,6)||':'||paused,',' ORDER BY agent_id) FROM fleet_founder_cognition")" == "$AGENTS_PAUSED" ]] || die "both agents must be paused"
  [[ "$(Q 'SELECT cognition_enabled FROM fleet_cognition_policy WHERE id = 1')" == f ]] || die "inference must be off"
  [[ "$(Q 'SELECT count(*) FROM fleet_cognition_inflight')" == 0 ]] || die "a call is in flight"
  [[ "$(Q 'SELECT fleet_sales_open()')" == f ]] || die "sales must be closed"
  [[ "$(Q 'SELECT tripped FROM fleet_spend_circuit_breaker WHERE id = 1')" == t ]] || die "the spend breaker must be tripped"
  [[ "$(Q 'SELECT count(*) FROM fleet_outward_release WHERE expires_at > now()')" == 0 ]] || die "an outward release is live"
  [[ "$(Q "SELECT daily_limit_per_agent FROM fleet_media_providers WHERE kind='search'")" -le 20 ]] || die "the search limit is above 20 a day"
  [[ "$(Q "SELECT COALESCE(max(daily_limit_per_agent),0) FROM fleet_media_providers WHERE kind='image' AND configured")" == 0 ]] || die "image generation is on: it spends the agent's money outside this ceiling"
  [[ "$(Q "SELECT daily_ceiling_minor IS NULL FROM fleet_control_ai_budget WHERE id = 1")" == t ]] || die "Fleet Control's AI budget is on: it would draw on the same credit"
  [[ "$(Q "SELECT count(*) FROM fleet_provider_credit_holds WHERE status='open' AND run_id='$KEEP'")" == 1 ]] || die "the customer-reply reserve is missing"
  search_up || echo "note: the search service is not running; the agent would have no web search"
  CEIL=$(python3 -c "from decimal import Decimal as D; print(int(D('$usd')*10**8))")
  BAL=$(Q "SELECT fleet_provider_credit_balance('anthropic')")
  RES=$(Q "SELECT usd_microcents FROM fleet_provider_credit_holds WHERE status='open' AND run_id='$KEEP'")
  NEWHOLD=$(( BAL - RES - CEIL )); (( NEWHOLD >= 0 )) || die "the balance does not cover this ceiling"
  (( CEIL >= 74000000 )) || die "a ceiling below one call's reservation (0.74 USD) stops at once"
  RUNMINOR=$(Q "SELECT ceil($CEIL::numeric / 1000000 * CASE WHEN (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1) = 'USD' THEN 1000000 ELSE (SELECT rate_micro FROM fleet_fx_latest('USD', (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1))) END / 1000000)::bigint")
  echo "gates passed. ceiling $usd USD for $hours h; balance $BAL, reserve $RES, new cap hold $NEWHOLD (all 1e-8 USD); run ceiling $RUNMINOR minor units"
}

TASK='Choose the business you will run, for customers outside the Fleet, on whichever platform you judge best. Nothing is pre-selected and any platform may be chosen. Decide from what you can find on the public web. Record your choice with venture create and your reasons in research/venture-decision.md in your workspace: the customer problem, evidence of real demand, why this platform, what it would cost, what you would sell, and what you are unsure of. Then prepare your offer privately in your workspace. You are in preparation: you cannot register, publish, send mail or take orders yet, and attempts are refused, so do not try. If you need an account, record one external dependency of kind non_delegable_credential saying exactly which site, which account type, what it is for and what email it should use. Ask once, then sleep with no timed review: the owner will set it up and you will be told. When the decision and private offer are done, sleep the same way. Do not check back in a loop. Spend carefully: your budget is small and is a hard limit.'

case "${1:-}" in
  --check) gates "${2:-}" "${3:-}"; status ;;
  status) status ;;
  stop) shift; stop_run "${*:-owner}" ;;
  start)
    need_sudo || exit 2
    gates "${2:-}" "${3:-}"; HOURS=$3
    # Inference is off through all of this, so the order of the holds cannot let a call through. A retry replaces an earlier attempt's cap.
    for h in $OLD_HOLDS $(Q "SELECT run_id FROM fleet_provider_credit_holds WHERE status='open' AND run_id LIKE 'external-run-cap-%'"); do
      [[ "$(Q "SELECT count(*) FROM fleet_provider_credit_holds WHERE status='open' AND run_id='$h'")" == 1 ]] || continue
      cli economy-engineering-credit-release "$h" "replaced by $HOLD (owner activation)" > /dev/null || die "could not release $h: stopped; inference is off"
    done
    cli economy-engineering-credit-hold "$HOLD" anthropic "$NEWHOLD" "external run cap: leaves the owner's ceiling free" > /dev/null || die "cap hold refused: stopped; inference is off"
    [[ "$(free)" == "$CEIL" ]] || die "free credit is $(free), expected $CEIL: stopped; inference is off"
    undo() { stop_run "$1" || die "$1, and the stop did not complete: see above"; die "$1: stopped"; }
    cli cognition-run "$A1" start "$RUNMINOR" "$HOURS" "external run: venture selection and private offer" > /dev/null || undo "run ceiling refused"
    AT=$(date -u -d "+$HOURS hours" '+%F %T UTC')
    timer_arm "$AT" || undo "stop timer refused"
    [[ "$(timer_active)" == active ]] || undo "stop timer not active"
    cli cognition-enable anthropic claude-opus-5-5 --max-output 4000 --in-microcents 400 --out-microcents 2000 > /dev/null || undo "inference refused"
    cli founder-task "$A1" "Choose your venture" "$TASK" > /dev/null || undo "task refused"
    cli founder-cognition "$A1" resume "external run approved by the owner: venture selection and private offer" > /dev/null || undo "resume refused"
    echo "== Agent-1 resumed $(date -u +%FT%TZ); stops at $AT at the latest"; status ;;
  *) sed -n 2,8p "$0"; exit 2 ;;
esac
