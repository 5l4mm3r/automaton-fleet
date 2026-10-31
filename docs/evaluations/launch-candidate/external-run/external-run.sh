#!/usr/bin/env bash
# PREPARATION RUN ONLY, not the external pilot. Deliverable: one selected venture, the evidence for it, an actionable offer, and the exact account or setup request needed to proceed.
# It reuses Agent-1's existing research and is stopped once the deliverable is written or a human dependency is reached.
# PREPARED, NOT RUN. Needs the owner's word and the release in place. Nothing here registers, publishes, sends, pays or accepts an order: the agent stays held from outside work.
# The later external pilot is a separate approval and is not started by anything in this script.
#
#   bash external-run.sh --check <hours>    read-only: every gate, actual usage and the allowance arithmetic; writes nothing
#   bash external-run.sh start   <hours>    holds, run ceiling, durable stop timer, inference on, task, Agent-1 resumed
#   bash external-run.sh stop    <reason…>  pause, inference off; safe to run any number of times
#   bash external-run.sh status             read-only: what stops it, what it has cost, what it has produced
#   bash external-run.sh tick               what the stop timer runs; free (database reads only)
#
# One cumulative ceiling (TOTAL_USD below, fixed in this file): the allowance is that total minus what the provider-credit log shows consumed since ANCHOR_HOLD was placed, read
# afresh on every --check and start. A retry or a second start cannot reset it or count anything twice: the log is append-only and the anchor does not move.
# Limits, each enforced apart from the agent's instructions:
#   1. Provider credit: free credit is set to exactly the allowance, by a hold that stays after a stop. A call reserves its worst case first, so spend cannot pass it; the run usually stops short of it.
#   2. Run ceiling and end time in the database (fleet_cognition_run_budgets): past the end time every paid call is refused, with or without any timer.
#   3. A durable timer on this host (unit files, Persistent=true) runs `tick` every 5 minutes: at the end time, once Agent-1 has asked for something only a person can do, once its latest call slept, or after IDLE_MINUTES without a call,
#      it pauses Agent-1 and turns inference off. So waiting costs nothing: there is no paid wake to poll with. A tick that fails exits non-zero and the next tick tries again.
#   4. Outward hold: no release is granted, so account registration, browser actions that change a page, mail, listings and API jobs are refused.
#   Sales stay closed and the spend breaker stays tripped: customer checkout and card or order spending stay shut. Fleet Control AI and image generation must be off.
#   Reading the public web stays open: a link followed can have an effect on the site it points to. Web search costs 1p each, at most 20 a day, outside the USD ceiling.
set -uo pipefail
SELF=$(readlink -f "$0")
# ── production identities ──
A1=01M3F50SH7PNX2E3GST13J52AS; AGENTS_PAUSED="01M3F5:true,01M4C4:true"; EXPECT_COMMIT=c69c8322f3f23ed2a240bf8bf07005962589cfa2
TOTAL_USD=11.511769; ANCHOR_HOLD=stage2-cap; RECORDED_USED=151176860
# ── host bindings (a rehearsal replaces exactly this block; nothing else) ──
N=/opt/automaton-fleet/node/bin/node; W=/opt/automaton-fleet/current
Q() { sudo -n -u postgres psql -X -q -At -d automaton_fleet -c "SET default_transaction_read_only=on; SET search_path=fleet; $1"; }
cli() { ( cd "$W" && "$N" dist/fleet/postgres/cli.js "$@" ); }
release_now() { readlink -f "$W" | xargs basename; }
UNITDIR=/etc/systemd/system; UNIT_IDENTITY="User=$(id -un)
Environment=HOME=$HOME"; TICK_CAL='*:0/5'
sc() { sudo -n systemctl "$@"; }
unit_write() { printf '%s\n' "$2" | sudo -n tee "$UNITDIR/$1" > /dev/null; }
unit_rm() { sudo -n rm -f -- "$UNITDIR/$1"; }
search_up() { systemctl is-active -q automaton-fleet-media; }
need_sudo() { sudo -v; }
# ── end of host bindings ──
TIMER=fleet-external-run-stop; IDLE_MINUTES=${IDLE_MINUTES:-15}
EXPECT_SCHEMA=125; HOLD="external-run-cap-$(date +%s)"; KEEP=stage2-obligation-reserve; OLD_HOLDS="stage1-research-cap stage2-cap"
free() { Q "SELECT fleet_provider_credit_balance('anthropic') - fleet_provider_credit_held('anthropic')"; }
die() { echo "!! $*"; exit 1; }

timer_arm() {
  unit_write "$TIMER.service" "[Unit]
Description=Automaton Fleet: stop the external run when it is due
[Service]
Type=oneshot
WorkingDirectory=$W
$UNIT_IDENTITY
ExecStart=/bin/bash $SELF tick" || return 1
  unit_write "$TIMER.timer" "[Unit]
Description=Automaton Fleet: external run stop check
[Timer]
OnCalendar=$TICK_CAL
AccuracySec=1s
Persistent=true
[Install]
WantedBy=timers.target" || return 1
  sc daemon-reload && sc enable --now "$TIMER.timer" > /dev/null 2>&1
}
timer_active() { sc is-active "$TIMER.timer" 2>/dev/null; }
tick_now() { sc start "$TIMER.service" > /dev/null 2>&1; }
timer_off() { sc disable --now "$TIMER.timer" > /dev/null 2>&1; unit_rm "$TIMER.timer"; unit_rm "$TIMER.service"; sc daemon-reload > /dev/null 2>&1; true; }

# Actual consumption since the anchor, in 1e-8 USD. Empty if the anchor is missing; the callers refuse that.
used() { Q "SELECT COALESCE(-sum(e.usd_microcents), 0)::bigint FROM fleet_provider_credit_holds h LEFT JOIN fleet_provider_credit_events e ON e.provider = 'anthropic' AND e.kind = 'consumption' AND e.at >= h.created_at WHERE h.run_id = '$ANCHOR_HOLD' GROUP BY h.run_id"; }
total_units() { python3 -c "from decimal import Decimal as D; print(int(D('$TOTAL_USD')*10**8))"; }

# Free: reads only, unless a stop is due. The time limit always applies; the waiting rules wait for a call in flight.
tick() {
  local row rc due slept idle inflight human why=""
  row=$(Q "WITH b AS (SELECT starts_at, ends_at FROM fleet_cognition_run_budgets WHERE agent_id = '$A1' AND ended_at IS NULL),
    l AS (SELECT at, tool_calls FROM fleet_cognition_log WHERE agent_id = '$A1' AND at >= (SELECT starts_at FROM b) ORDER BY seq DESC LIMIT 1)
    SELECT COALESCE((SELECT now() >= ends_at FROM b), true), COALESCE((SELECT tool_calls::text ~ '\"sleep\"' FROM l), false),
      COALESCE(now() - GREATEST((SELECT starts_at FROM b), (SELECT at FROM l)) > make_interval(mins => $IDLE_MINUTES), true),
      (SELECT count(*) FROM fleet_cognition_inflight WHERE agent_id = '$A1'),
      (SELECT count(*) FROM fleet_owner_requests WHERE agent_id = '$A1' AND status = 'pending' AND created_at >= (SELECT starts_at FROM b))"); rc=$?
  (( rc == 0 )) && [[ -n "$row" ]] || { echo "tick: the database cannot be read; the next tick tries again"; return 1; }
  IFS='|' read -r due slept idle inflight human <<< "$row"
  if [[ "$due" == t ]]; then why="time limit reached or no run open"
  elif [[ "$inflight" == 0 && "$human" != 0 ]]; then why="a human dependency has been reached"
  elif [[ "$inflight" == 0 && "$slept" == t ]]; then why="Agent-1 has finished and is waiting"
  elif [[ "$inflight" == 0 && "$idle" == t ]]; then why="no paid call for $IDLE_MINUTES minutes"
  fi
  [[ -z "$why" ]] && return 0
  stop_run "$why"
}

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
  cli cognition-run "$A1" end "$*" > /dev/null 2>&1
  timer_off   # last: until here a failed or interrupted stop is retried by the next tick
  echo "stopped: Agent-1 paused, inference off, in flight $(Q 'SELECT count(*) FROM fleet_cognition_inflight')"
}

status() {
  echo "inference $(Q 'SELECT cognition_enabled FROM fleet_cognition_policy'); paused $(Q "SELECT string_agg(left(agent_id,6)||':'||paused,',' ORDER BY agent_id) FROM fleet_founder_cognition"); in flight $(Q 'SELECT count(*) FROM fleet_cognition_inflight'); sales $(Q 'SELECT fleet_sales_open()'); breaker $(Q 'SELECT tripped FROM fleet_spend_circuit_breaker WHERE id = 1')"
  local u t; u=$(used); t=$(total_units)
  echo "cumulative ceiling (1e-8 USD) $t; consumed since $ANCHOR_HOLD ${u:-UNKNOWN}; left ${u:+$(( t - u ))}"
  echo "free credit (1e-8 USD) $(free); holds $(Q "SELECT string_agg(run_id||' '||usd_microcents,', ' ORDER BY run_id) FROM fleet_provider_credit_holds WHERE status='open'")"
  echo "outward released: $(Q "SELECT count(*) FROM fleet_outward_release WHERE expires_at > now()"); open owner tasks: $(Q "SELECT count(*) FROM fleet_owner_tasks WHERE agent_id='$A1' AND closed_at IS NULL"); stop timer: $(timer_active)"
  echo "since start: $(Q "SELECT 'calls '||count(*)||', errors '||count(*) FILTER (WHERE outcome<>'ok')||', cost 1e-8 USD '||COALESCE(sum(provider_usd_microcents),0) FROM fleet_cognition_log WHERE agent_id='$A1' AND at > COALESCE((SELECT max(starts_at) FROM fleet_cognition_run_budgets WHERE agent_id='$A1'), now())")"
  echo "account requests pending: $(Q "SELECT count(*) FROM fleet_owner_requests WHERE agent_id='$A1' AND status='pending' AND kind='non_delegable_credential'")"
  echo "accounts $(Q "SELECT count(*) FROM fleet_agent_accounts WHERE agent_id='$A1'"); ventures $(Q "SELECT string_agg(venture_key||':'||state,', ') FROM fleet_ventures WHERE agent_id='$A1'")"
}

gates() {
  local hours=$1
  [[ "$hours" =~ ^[0-9]+$ ]] && (( hours >= 1 && hours <= 24 )) || die "hours is 1 to 24"
  [[ "$(release_now)" == "$EXPECT_COMMIT" ]] || die "current release is not $EXPECT_COMMIT"
  [[ "$(Q 'SELECT max(version) FROM fleet_schema_migrations')" == "$EXPECT_SCHEMA" ]] || die "schema is not $EXPECT_SCHEMA"
  [[ "$(Q "SELECT string_agg(left(agent_id,6)||':'||paused,',' ORDER BY agent_id) FROM fleet_founder_cognition")" == "$AGENTS_PAUSED" ]] || die "both agents must be paused"
  [[ "$(Q 'SELECT cognition_enabled FROM fleet_cognition_policy WHERE id = 1')" == f ]] || die "inference must be off"
  [[ "$(Q 'SELECT count(*) FROM fleet_cognition_inflight')" == 0 ]] || die "a call is in flight"
  [[ "$(Q 'SELECT fleet_account_handover_enabled()')" == f ]] || die "account handover must be disabled"
  [[ "$(Q 'SELECT fleet_sales_open()')" == f ]] || die "sales must be closed"
  [[ "$(Q 'SELECT tripped FROM fleet_spend_circuit_breaker WHERE id = 1')" == t ]] || die "the spend breaker must be tripped"
  [[ "$(Q 'SELECT count(*) FROM fleet_outward_release WHERE expires_at > now()')" == 0 ]] || die "an outward release is live"
  [[ "$(Q "SELECT daily_limit_per_agent FROM fleet_media_providers WHERE kind='search'")" -le 20 ]] || die "the search limit is above 20 a day"
  [[ "$(Q "SELECT COALESCE(max(daily_limit_per_agent),0) FROM fleet_media_providers WHERE kind='image' AND configured")" == 0 ]] || die "image generation is on: it spends the agent's money outside this ceiling"
  [[ "$(Q "SELECT daily_ceiling_minor IS NULL FROM fleet_control_ai_budget WHERE id = 1")" == t ]] || die "Fleet Control's AI budget is on: it would draw on the same credit"
  [[ "$(Q "SELECT count(*) FROM fleet_provider_credit_holds WHERE status='open' AND run_id='$KEEP'")" == 1 ]] || die "the customer-reply reserve is missing"
  search_up || echo "note: the search service is not running; the agent would have no web search"
  USED=$(used); [[ "$USED" =~ ^[0-9]+$ ]] || die "actual usage cannot be read: the anchor $ANCHOR_HOLD is missing"
  (( USED >= RECORDED_USED )) || die "the log shows $USED consumed, below the $RECORDED_USED read on 31 Oct: the anchor is wrong; stopped"
  TOTAL=$(total_units); CEIL=$(( TOTAL - USED ))
  (( CEIL >= 74000000 )) || die "what is left of the ceiling ($CEIL) is below one call's reservation (0.74 USD)"
  BAL=$(Q "SELECT fleet_provider_credit_balance('anthropic')")
  RES=$(Q "SELECT usd_microcents FROM fleet_provider_credit_holds WHERE status='open' AND run_id='$KEEP'")
  NEWHOLD=$(( BAL - RES - CEIL )); (( NEWHOLD >= 0 )) || die "the balance does not cover this allowance"
  RUNMINOR=$(Q "SELECT ceil($CEIL::numeric / 1000000 * CASE WHEN (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1) = 'USD' THEN 1000000 ELSE (SELECT rate_micro FROM fleet_fx_latest('USD', (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1))) END / 1000000)::bigint")
  echo "gates passed for $hours h. Cumulative ceiling $TOTAL_USD USD; actually consumed since $ANCHOR_HOLD: $USED; allowance now: $CEIL; balance $BAL, reserve $RES, new cap hold $NEWHOLD (all 1e-8 USD); run ceiling $RUNMINOR minor units"
}

TASK='This is a preparation run, not the launch. Deliver four things, reusing what is already in research/ (including external-opportunities.md) instead of repeating it; search only for what your decision still depends on. 1. One selected venture and platform: record it with venture create. Nothing is pre-selected. 2. The evidence for it, in research/venture-decision.md: the customer problem, real demand, cost, your doubts, and what the terms of the platform let an automated operator do, with sources. 3. An actionable offer, in research/offer.md, complete enough to act on without asking you: who it is for, what they get, price, delivery, the listing or outreach text as it would appear, and the first week of actions once you have access. 4. The exact account or setup request needed to proceed: site, account type, purpose, email, and the actions you need permitted. Put it at the end of research/offer.md. Nothing goes outside in this run: registering, publishing, mail and orders are refused, so do not try. Write the files first. Then, as your last step, record that request once as an external dependency of kind non_delegable_credential if a person must do it, and call sleep with no review time. Either one ends your run, at no cost while it waits. The owner reads your work and decides what happens next. Your budget is small and a hard limit.'

case "${1:-}" in
  --check) gates "${2:-}"; status ;;
  status) status ;;
  tick) tick ;;
  stop) shift; stop_run "${*:-owner}" ;;
  start)
    need_sudo || exit 2
    gates "${2:-}"; HOURS=$2
    # Inference is off through all of this, so the order of the holds cannot let a call through. A retry replaces an earlier attempt's cap, from the usage just read.
    for h in $OLD_HOLDS $(Q "SELECT run_id FROM fleet_provider_credit_holds WHERE status='open' AND run_id LIKE 'external-run-cap-%'"); do
      [[ "$(Q "SELECT count(*) FROM fleet_provider_credit_holds WHERE status='open' AND run_id='$h'")" == 1 ]] || continue
      cli economy-engineering-credit-release "$h" "replaced by $HOLD (owner activation)" > /dev/null || die "could not release $h: stopped; inference is off"
    done
    cli economy-engineering-credit-hold "$HOLD" anthropic "$NEWHOLD" "external run cap: leaves only what is left of the owner's ceiling free" > /dev/null || die "cap hold refused: stopped; inference is off"
    [[ "$(free)" == "$CEIL" ]] || die "free credit is $(free), expected $CEIL: stopped; inference is off"
    undo() { stop_run "$1" || die "$1, and the stop did not complete: see above"; die "$1: stopped"; }
    cli cognition-run "$A1" start "$RUNMINOR" "$HOURS" "preparation run: venture, evidence, offer, setup request" > /dev/null || undo "run ceiling refused"
    timer_arm || undo "stop timer refused"
    [[ "$(timer_active)" == active ]] || undo "stop timer not active"
    # The tick must have worked from inside its own unit before Agent-1 can spend anything.
    tick_now || undo "the stop tick failed in its unit"
    cli cognition-enable anthropic claude-opus-5-5 --max-output 4000 --in-microcents 400 --out-microcents 2000 > /dev/null || undo "inference refused"
    [[ "$(Q "SELECT count(*) FROM fleet_owner_tasks WHERE agent_id='$A1' AND closed_at IS NULL AND title='Preparation: venture, evidence, offer, setup request'")" != 0 ]] \
      || cli founder-task "$A1" "Preparation: venture, evidence, offer, setup request" "$TASK" > /dev/null || undo "task refused"
    cli founder-cognition "$A1" resume "preparation run approved by the owner: venture, evidence, offer, setup request" > /dev/null || undo "resume refused"
    echo "== Agent-1 resumed $(date -u +%FT%TZ); it stops within 5 minutes of finishing and at $HOURS h at the latest"; status ;;
  *) sed -n 2,11p "$0"; exit 2 ;;
esac
