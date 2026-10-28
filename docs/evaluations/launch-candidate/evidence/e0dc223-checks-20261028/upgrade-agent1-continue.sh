#!/usr/bin/env bash
# e0dc223 (owner approval 28 Oct, bounded repair + Stage 1 continuation): Agent-1 ONLY to runtime e0dc223 (identity preserved),
# then the EXISTING Stage 1 task continued under a HARD $2 ceiling, within the remaining total, deadline UNCHANGED.
#   bash ~/rlc141/upgrade-agent1-continue.sh --check     read-only gates
#   bash ~/rlc141/upgrade-agent1-continue.sh upgrade     snapshot → upgrade-preflight → upgrade-runtime Agent-1 → preservation proof
#   bash ~/rlc141/upgrade-agent1-continue.sh continue    $2 cap hold (free credit = exactly $2, enforced by the controller before
#                                                        every call and reservation) → policy on (prices read back) → resume
# Not re-armed: the persistent end timer stays at 2026-10-29T13:44:01Z (verified). The $15 TOTAL is reconciled from the
# provider-credit events since the first resume (all attempts and the probe). On any failed gate: Agent-1 paused, policy off.
set -uo pipefail
R=~/rlc141; MODE=${1:---check}
A1=01M3F50SH7PNX2E3GST13J52AS; A2=01M4C4NXT786Q4E9725N5A15KV; C=e0dc22321c0a6633ae74aadef0279074011a5b0a; PREV_RT=dd29a53ee724657748a93c018734003466ff35fb
N=/opt/automaton-fleet/node/bin/node; OPT=/opt/automaton-fleet
ST=/var/lib/private/automaton-founders/$A1; MEM=$ST/state/st_01M3F50SH8JVSDE1QBRN591114/memory; WS=$ST/workspace/ws_01M3F50SH8BHKVHZP1291FN09K
HOLD=10023033480; FIRST_RESUME=2026-10-28T12:12:16Z; TOTAL=1500000000; CAP=200000000; CAP_RUN=stage1-continuation-cap
ENDS_AT=2026-10-29T13:44:01Z; TASK=a11941fe-6a1f-417b-9726-5cdc32b63e62
ts() { date -u +%FT%TZ; }
Q() { sudo -n -u postgres psql -X -q -At -d automaton_fleet -c "SET default_transaction_read_only=on; SET search_path=fleet; $1"; }
cli() { ( cd $OPT/current && $N dist/fleet/postgres/cli.js "$@" ); }
pid() { systemctl show -p MainPID --value "$1"; }
tree() { sudo -n bash -c "cd '$1' && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16"; }
cog() { Q "SELECT daily_budget_cents||' '||max_turns_per_hour||' paused='||paused FROM fleet_founder_cognition WHERE agent_id = '$1'"; }
policy() { Q "SELECT cognition_enabled||' '||provider||' '||model||' '||max_output_tokens||' '||input_microcents_per_token||' '||output_microcents_per_token||' '||cache_read_microcents_per_token||' '||cache_write_microcents_per_token||' '||default_daily_budget_cents||' '||default_max_turns_per_hour FROM fleet_cognition_policy WHERE id = 1"; }
free() { Q "SELECT fleet_provider_credit_balance('anthropic') - fleet_provider_credit_held('anthropic')"; }
used() { Q "SELECT COALESCE(-sum(usd_microcents),0) FROM fleet_provider_credit_events WHERE provider = 'anthropic' AND kind = 'consumption' AND at > '$FIRST_RESUME'"; }
holds() { Q "SELECT COALESCE(string_agg(run_id||' '||usd_microcents, ',' ORDER BY run_id),'') FROM fleet_provider_credit_holds WHERE status = 'open'"; }
identity() {
  echo "agent=$(Q "SELECT agent_id||' '||created_at||' '||md5(COALESCE(wallet_address,''))||' '||status FROM fleet_agents WHERE agent_id = '$A1'")"
  echo "credential=$(Q "SELECT left(token_hash,16)||' revoked='||(revoked_at IS NOT NULL) FROM fleet_agent_credentials WHERE agent_id = '$A1'")"
  echo "memory=$(tree $MEM) workspace=$(tree $WS)"
  echo "files=$(sudo -n sha256sum $ST/founder.json $ST/fleet-credentials.json 2>/dev/null | cut -c1-16 | tr '\n' ' ')"
}
agent2() { echo "$(Q "SELECT status||' '||left(runtime_commit,7) FROM fleet_agents WHERE agent_id = '$A2'") $(cog $A2) pid $(pid automaton-fleet-founder@$A2.service)"; }
die() { echo "!! $*"; [[ "$(Q 'SELECT cognition_enabled FROM fleet_cognition_policy WHERE id = 1')" == t ]] && cli cognition-disable > /dev/null && echo "  policy disabled"
        [[ "$(Q "SELECT paused FROM fleet_founder_cognition WHERE agent_id = '$A1'")" == t ]] || { cli founder-cognition $A1 pause "e0dc223 continuation stopped: $1" > /dev/null; echo "  Agent-1 paused"; }
        echo "== STOPPED ($MODE) $(ts): Agent-1 $(Q "SELECT status||' '||left(runtime_commit,7) FROM fleet_agents WHERE agent_id = '$A1'") $(cog $A1); Agent-2 $(agent2); holds $(holds); free $(free); no database restored"; exit 1; }
gates() {
  [[ "$(readlink -f $OPT/current | xargs basename)" == "$C" ]] || die "the installed release is not ${C:0:7}"
  [[ "$(Q 'SELECT tripped FROM fleet_spend_circuit_breaker WHERE id = 1')" == t && "$(Q 'SELECT fleet_sales_open()')" == f ]] || die "breaker not tripped or sales open"
  [[ "$(Q 'SELECT count(*) FROM fleet_refund_authorities a WHERE fleet_refund_authority_live(a)') $(Q 'SELECT count(*) FROM fleet_outward_release WHERE expires_at > now()')" == "0 0" ]] || die "an authority is open"
  [[ "$(Q "SELECT (fleet_control_ai_state()->>'ceilingMinor')||' '||(fleet_control_ai_state()->'funding'->>'unallocatedMinor')")" == "30 0" ]] || die "Fleet Control is not 30p and unfunded"
  [[ "$(cog $A2)" == "3000 60 paused=true" && "$(Q "SELECT left(runtime_commit,7) FROM fleet_agents WHERE agent_id = '$A2'")" == b60e262 ]] || die "Agent-2 is not paused on b60e262"
  [[ "$(Q "SELECT count(*) FROM fleet_cognition_inflight")" == 0 ]] || die "a model call is in flight"
  # The $15 TOTAL: free credit (the controller's own figure, every hold and reservation subtracted) must equal what is left of it.
  local u; u=$(used); (( u <= TOTAL )) || die "consumption since the first resume ($u µ¢) exceeds the \$15 total"
  [[ "$(sed -n 's/^ENDS_AT=//p' ~/canary/canary.conf)" == "$ENDS_AT" && "$(date -u -d "$(systemctl show -p NextElapseUSecRealtime --value automaton-fleet-canary-end.timer)" +%FT%TZ)" == "$ENDS_AT" ]] || die "the end timer is not armed at the preserved deadline $ENDS_AT"
  [[ "$(systemctl is-active automaton-fleet-canary-check.timer)" == active ]] || die "the hourly guard is not active"
  [[ "$(Q "SELECT count(*) FROM fleet_owner_tasks WHERE task_id = '$TASK' AND closed_at IS NULL")" == 1 ]] || die "the owner task is not open"
  echo "  total: used $u µ¢ since $FIRST_RESUME, left $((TOTAL - u)) µ¢; free now $(free); holds: $(holds)"
}
echo "== e0dc223 Agent-1 upgrade / continuation ($MODE) $(ts)"
case "$MODE" in
  --check)
    gates
    echo "  Agent-1: $(Q "SELECT status||' '||left(runtime_commit,7) FROM fleet_agents WHERE agent_id = '$A1'") $(cog $A1); Agent-2: $(agent2); policy $(policy | cut -d' ' -f1)"
    identity | sed 's/^/  /'; echo "== CHECK PASSED $(ts)"; exit 0 ;;
  upgrade)
    gates
    [[ "$(Q "SELECT status||' '||runtime_commit FROM fleet_agents WHERE agent_id = '$A1'")" == "active $PREV_RT" && "$(cog $A1)" == "754 120 paused=true" ]] || die "Agent-1 is not active, paused, on ${PREV_RT:0:7}"
    [[ "$(policy | cut -d' ' -f1)" == false ]] || die "the policy must be off during the upgrade"
    identity > $R/agent1-identity-before.txt; A2_0=$(agent2); P1=$(pid automaton-fleet-founder@$A1.service)
    sed 's/^/  before: /' $R/agent1-identity-before.txt
    (cd $OPT/current && sudo -n bash scripts/fleet-founders.sh upgrade-preflight $A1) > $R/upgrade-preflight.log 2>&1 || die "upgrade-preflight refused: $(tail -c 400 $R/upgrade-preflight.log)"
    (cd $OPT/current && sudo -n bash scripts/fleet-founders.sh upgrade-runtime $A1) > $R/upgrade-runtime.log 2>&1; rc=$?
    tail -c 500 $R/upgrade-runtime.log; echo
    (( rc == 0 )) || die "upgrade-runtime failed (rc $rc; the lifecycle's own rollback applies — see $R/upgrade-runtime.log)"
    T2=$(date +%s); until [[ "$(Q "SELECT status FROM fleet_agents WHERE agent_id = '$A1'")" == active ]] || (( $(date +%s) - T2 >= 300 )); do sleep 10; done
    [[ "$(Q "SELECT status||' '||runtime_commit FROM fleet_agents WHERE agent_id = '$A1'")" == "active $C" ]] || die "Agent-1 is not active on ${C:0:7}"
    identity > $R/agent1-identity-after.txt
    diff $R/agent1-identity-before.txt $R/agent1-identity-after.txt && echo "  identity, credential, memory, workspace, identity files: IDENTICAL" || die "something Agent-1 owns changed across the upgrade"
    echo "  new process $(pid automaton-fleet-founder@$A1.service) (was $P1); latest challenge: $(Q "SELECT outcome||' at '||to_char(issued_at,'HH24:MI:SS') FROM fleet_health_challenges WHERE agent_id = '$A1' ORDER BY issued_at DESC LIMIT 1")"
    [[ "$(cog $A1)" == "754 120 paused=true" ]] || die "Agent-1 limits/pause changed"
    [[ "$(agent2)" == "$A2_0" ]] && echo "  Agent-2 unchanged: $A2_0" || die "Agent-2 changed"
    echo "== UPGRADED $(ts): Agent-1 on ${C:0:7}, same identity, paused." ;;
  continue)
    gates
    [[ "$(Q "SELECT status||' '||runtime_commit FROM fleet_agents WHERE agent_id = '$A1'")" == "active $C" && "$(cog $A1)" == "754 120 paused=true" ]] || die "Agent-1 must be active, paused, on ${C:0:7}"
    [[ -s $R/agent1-identity-after.txt ]] || die "run 'upgrade' first"
    [[ "$(holds)" == "canary-agent1-ceiling $HOLD" ]] || die "unexpected holds before the cap: $(holds)"
    LEFT=$(( TOTAL - $(used) )); F=$(free)
    [[ "$F" == "$LEFT" ]] || die "free credit $F µ¢ is not what is left of the \$15 total ($LEFT µ¢): reconcile first"
    (( LEFT >= CAP )) || die "less than \$2 is left of the total ($LEFT µ¢)"
    echo "== \$2 hard ceiling: hold the rest ($(( LEFT - CAP )) µ¢) so the controller's free credit is exactly $CAP µ¢ for every call and reservation"
    (( LEFT > CAP )) && { cli economy-engineering-credit-hold $CAP_RUN anthropic $(( LEFT - CAP )) "stage 1 continuation: hard \$2 ceiling (owner 28 Oct); released at closeout" > $R/cap-hold.json || die "the cap hold was refused"; }
    [[ "$(free)" == "$CAP" ]] || die "free credit is $(free) µ¢ after the cap hold, not $CAP"
    echo "  free credit now $(free) µ¢; holds $(holds)"
    cli cognition-enable anthropic claude-opus-5-5 --max-output 4000 --in-microcents 400 --out-microcents 2000 > /dev/null || die "cognition-enable refused"
    [[ "$(policy)" == "true anthropic claude-opus-5-5 4000 400 2000 20 500 754 20" ]] || die "policy read-back: $(policy)"
    cli founder-cognition $A1 resume "stage 1 continuation on ${C:0:7} (cap \$2, deadline $ENDS_AT)" > /dev/null || die "resume refused"
    [[ "$(Q "SELECT paused FROM fleet_founder_cognition WHERE agent_id = '$A1'")" == f ]] || die "Agent-1 not resumed"
    echo "== CONTINUING $(ts): Agent-1 resumed on ${C:0:7}; free credit $(free) µ¢ (hard \$2); deadline $ENDS_AT unchanged; hourly guard active" ;;
  *) echo "usage: --check|upgrade|continue"; exit 2 ;;
esac
