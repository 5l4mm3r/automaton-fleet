#!/usr/bin/env bash
# Repair A, steps 6–7 (owner approval 28 Oct): Agent-1 ONLY to runtime dd29a53, preservation proven, then Stage 1 resumed with a
# FRESH 24 h window (the pinned stage1-retry.sh resume: end timer re-armed and verified BEFORE the resume).
#   bash ~/rlc140/upgrade-agent1-resume.sh --check     read-only gates
#   bash ~/rlc140/upgrade-agent1-resume.sh upgrade     snapshot → upgrade-preflight → upgrade-runtime Agent-1 → preservation proof
#   bash ~/rlc140/upgrade-agent1-resume.sh resume      policy on (prices read back) → stage1-retry.sh resume (fresh 24 h)
# On any failed gate: Agent-1 stays paused, the policy stays/returns OFF, nothing else changes; no database restore.
set -uo pipefail
R=~/rlc140; MODE=${1:---check}
A1=01M3F50SH7PNX2E3GST13J52AS; A2=01M4C4NXT786Q4E9725N5A15KV; C=dd29a53ee724657748a93c018734003466ff35fb
N=/opt/automaton-fleet/node/bin/node; OPT=/opt/automaton-fleet
S1=$R/stage1-retry.sh; S1_SHA=848db128237722d5d7ae38f057a9ae3c6c28e8eab556e1dd065506c30259babf
ST=/var/lib/private/automaton-founders/$A1; MEM=$ST/state/st_01M3F50SH8JVSDE1QBRN591114/memory; WS=$ST/workspace/ws_01M3F50SH8BHKVHZP1291FN09K
HOLD=10023033480; TOTAL_FREE=1500000000
ts() { date -u +%FT%TZ; }
Q() { sudo -n -u postgres psql -X -q -At -d automaton_fleet -c "SET default_transaction_read_only=on; SET search_path=fleet; $1"; }
cli() { ( cd $OPT/current && $N dist/fleet/postgres/cli.js "$@" ); }
pid() { systemctl show -p MainPID --value "$1"; }
tree() { sudo -n bash -c "cd '$1' && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16"; }
cog() { Q "SELECT daily_budget_cents||' '||max_turns_per_hour||' paused='||paused FROM fleet_founder_cognition WHERE agent_id = '$1'"; }
policy() { Q "SELECT cognition_enabled||' '||provider||' '||model||' '||max_output_tokens||' '||input_microcents_per_token||' '||output_microcents_per_token||' '||cache_read_microcents_per_token||' '||cache_write_microcents_per_token||' '||default_daily_budget_cents||' '||default_max_turns_per_hour FROM fleet_cognition_policy WHERE id = 1"; }
free() { Q "SELECT fleet_provider_credit_balance('anthropic') - fleet_provider_credit_held('anthropic')"; }
identity() {   # everything that must survive the upgrade (hashes only)
  echo "agent=$(Q "SELECT agent_id||' '||created_at||' '||md5(COALESCE(wallet_address,''))||' '||status FROM fleet_agents WHERE agent_id = '$A1'")"
  echo "credential=$(Q "SELECT left(token_hash,16)||' revoked='||(revoked_at IS NOT NULL) FROM fleet_agent_credentials WHERE agent_id = '$A1'")"
  echo "memory=$(tree $MEM) workspace=$(tree $WS)"
  echo "files=$(sudo -n sha256sum $ST/founder.json $ST/fleet-credentials.json 2>/dev/null | cut -c1-16 | tr '\n' ' ')"
}
agent2() { echo "$(Q "SELECT status||' '||left(runtime_commit,7) FROM fleet_agents WHERE agent_id = '$A2'") $(cog $A2) pid $(pid automaton-fleet-founder@$A2.service)"; }
die() { echo "!! $*"; [[ "$(Q 'SELECT cognition_enabled FROM fleet_cognition_policy WHERE id = 1')" == t ]] && cli cognition-disable > /dev/null && echo "  policy disabled"
        [[ "$(Q "SELECT paused FROM fleet_founder_cognition WHERE agent_id = '$A1'")" == t ]] || { cli founder-cognition $A1 pause "repair A stopped: $1" > /dev/null; echo "  Agent-1 paused"; }
        echo "== STOPPED ($MODE) $(ts): Agent-1 $(Q "SELECT status||' '||left(runtime_commit,7) FROM fleet_agents WHERE agent_id = '$A1'") $(cog $A1); Agent-2 $(agent2); no database restored"; exit 1; }
gates() {
  [[ "$(readlink -f $OPT/current | xargs basename)" == "$C" ]] || die "the installed release is not ${C:0:7}"
  [[ "$(Q 'SELECT tripped FROM fleet_spend_circuit_breaker WHERE id = 1')" == t && "$(Q 'SELECT fleet_sales_open()')" == f ]] || die "breaker not tripped or sales open"
  [[ "$(Q "SELECT string_agg(run_id||' '||usd_microcents, ',') FROM fleet_provider_credit_holds WHERE status = 'open'")" == "canary-agent1-ceiling $HOLD" && "$(free)" == $TOTAL_FREE ]] \
    || die "credit: free $(free) µ¢ (must be exactly \$15 TOTAL, the failed attempt having used 0), hold must be $HOLD"
  [[ "$(Q "SELECT count(*) FROM fleet_cognition_log WHERE agent_id = '$A1' AND at > '2026-10-28T12:12:16Z'")" == 0 ]] || die "Agent-1 consumed calls since the first resume: the \$15 total must be recomputed"
  [[ "$(Q "SELECT (fleet_control_ai_state()->>'ceilingMinor')||' '||(fleet_control_ai_state()->'funding'->>'unallocatedMinor')")" == "30 0" ]] || die "Fleet Control is not 30p and unfunded"
  [[ "$(cog $A2)" == "3000 60 paused=true" ]] || die "Agent-2 is not paused as recorded"
}
echo "== repair A steps 6–7 ($MODE) $(ts)"
[[ "$(sha256sum < $S1 | cut -c1-64)" == "$S1_SHA" ]] || die "stage1-retry.sh is not the approved package"
case "$MODE" in
  --check)
    gates
    echo "  Agent-1: $(Q "SELECT status||' '||left(runtime_commit,7) FROM fleet_agents WHERE agent_id = '$A1'") $(cog $A1); Agent-2: $(agent2); policy $(policy | cut -d' ' -f1)"
    identity | sed 's/^/  /'
    echo "== CHECK PASSED $(ts)"; exit 0 ;;
  upgrade)
    gates
    [[ "$(Q "SELECT status||' '||runtime_commit FROM fleet_agents WHERE agent_id = '$A1'")" == "active 7c194b8c2348baa8fa5d34bd7ef6b201dc4911c2" && "$(cog $A1)" == "754 120 paused=true" ]] || die "Agent-1 is not active, paused, on 7c194b8"
    [[ "$(policy | cut -d' ' -f1)" == false ]] || die "the policy must be off during the upgrade"
    identity > $R/agent1-identity-before.txt; A2_0=$(agent2); P1=$(pid automaton-fleet-founder@$A1.service)
    sed 's/^/  before: /' $R/agent1-identity-before.txt
    echo "== upgrade-preflight (changes nothing)"
    (cd $OPT/current && sudo -n bash scripts/fleet-founders.sh upgrade-preflight $A1) > $R/upgrade-preflight.log 2>&1 || die "upgrade-preflight refused: $(tail -c 400 $R/upgrade-preflight.log)"
    tail -c 300 $R/upgrade-preflight.log; echo
    echo "== upgrade-runtime Agent-1 → ${C:0:7} (OWNER GATE, approved)"
    (cd $OPT/current && sudo -n bash scripts/fleet-founders.sh upgrade-runtime $A1) > $R/upgrade-runtime.log 2>&1; rc=$?
    tail -c 600 $R/upgrade-runtime.log; echo
    (( rc == 0 )) || die "upgrade-runtime failed (rc $rc; the lifecycle's own rollback applies — see $R/upgrade-runtime.log)"
    echo "== preservation proof"
    T2=$(date +%s); until [[ "$(Q "SELECT status FROM fleet_agents WHERE agent_id = '$A1'")" == active ]] || (( $(date +%s) - T2 >= 300 )); do sleep 10; done
    [[ "$(Q "SELECT status||' '||runtime_commit FROM fleet_agents WHERE agent_id = '$A1'")" == "active $C" ]] || die "Agent-1 is not active on ${C:0:7}"
    identity > $R/agent1-identity-after.txt
    diff <(sed 's/ active$//' $R/agent1-identity-before.txt) <(sed 's/ active$//' $R/agent1-identity-after.txt) && echo "  identity, credential, memory, workspace, identity files: IDENTICAL" || die "something Agent-1 owns changed across the upgrade"
    [[ "$(pid automaton-fleet-founder@$A1.service)" != "$P1" ]] && echo "  new process $(pid automaton-fleet-founder@$A1.service) (was $P1)"
    echo "  latest challenge: $(Q "SELECT outcome||' at '||to_char(issued_at,'HH24:MI:SS') FROM fleet_health_challenges WHERE agent_id = '$A1' ORDER BY issued_at DESC LIMIT 1")"
    [[ "$(cog $A1)" == "754 120 paused=true" ]] || die "Agent-1 limits/pause changed"
    [[ "$(agent2)" == "$A2_0" ]] && echo "  Agent-2 unchanged: $A2_0" || die "Agent-2 changed: $A2_0 → $(agent2)"
    echo "== UPGRADED $(ts): Agent-1 on ${C:0:7}, same identity, paused. Next: resume." ;;
  resume)
    gates
    [[ "$(Q "SELECT status||' '||runtime_commit FROM fleet_agents WHERE agent_id = '$A1'")" == "active $C" && "$(cog $A1)" == "754 120 paused=true" ]] || die "Agent-1 must be active, paused, on ${C:0:7}"
    [[ -s $R/agent1-identity-after.txt ]] || die "run 'upgrade' first"
    echo "== policy on (prices unchanged)"
    cli cognition-enable anthropic claude-opus-5-5 --max-output 4000 --in-microcents 400 --out-microcents 2000 > /dev/null || die "cognition-enable refused"
    [[ "$(policy)" == "true anthropic claude-opus-5-5 4000 400 2000 20 500 754 20" ]] || die "policy read-back: $(policy)"
    echo "== stage1-retry.sh resume (fresh 24 h from the actual resume; the previous deadline replaced and verified before)"
    bash $S1 resume 2>&1 | tee $R/resume2.console; [[ ${PIPESTATUS[0]} == 0 ]] || die "stage1-retry.sh resume failed"
    ;;
  *) echo "usage: --check|upgrade|resume"; exit 2 ;;
esac
