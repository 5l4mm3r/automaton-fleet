#!/usr/bin/env bash
# Stage 1 retry, step 4 only — inference on with the controller restart that failed on 27 Oct (PREPARED 28 Oct, NOT RUN;
# needs its own owner approval, after C1 (operator key) and C2 (inference profile) are done).
#
#   bash stage1-retry-inference-on.sh --check   read-only: every gate + both preflights; writes nothing (before C1/C2: they are
#                                               reported PENDING, exit 4, and the new file is checked as it will be after C2)
#   bash stage1-retry-inference-on.sh           gates → policy → service.env → preflight of the LIVE file → restart (≤ 30 s
#                                               to ready, else automatic rollback) → founders re-verified
#
# The 27 Oct failure cannot recur unseen: the exact file the controller will load passes the release's own startup
# validators first (scripts/fleet-controller-preflight.mjs), and the restart is bounded with an automatic rollback.
# Agents stay PAUSED (no model call can happen); Agent-1's resume is a later Stage 1 step. The spend breaker stays tripped
# (it gates payment orders; Stage 1 makes none) and the canary hold stays (it is the Stage 1 ceiling: exactly $15 free).
set -uo pipefail
R=~/rlc140; E=/etc/automaton-fleet; SE=$E/service.env; N=/opt/automaton-fleet/node/bin/node
A1=01M3F50SH7PNX2E3GST13J52AS; A2=01M4C4NXT786Q4E9725N5A15KV; C=c448d98a1c32c63af89288758240fc5787f9f9d6
PF=$R/fleet-controller-preflight.mjs; PF_SHA=2c6f6c37ad900b92b1d461996040facfcbfb88fbf27989797fe9e1be5594d628
KEY=$E/cognition.key; KEY_SRC=$E/recovery/cognition.key.20261023T142625Z
OPERATOR=op_01M3CKG338G2KDJ19FYEKT2T40; READY_S=30
MODE=${1:-apply}; ts() { date -u +%FT%TZ; }
Q() { sudo -n -u postgres psql -X -q -At -d automaton_fleet -c "SET default_transaction_read_only=on; SET search_path=fleet; $1"; }
cli() { ( cd /opt/automaton-fleet/current && $N dist/fleet/postgres/cli.js "$@" ); }
ready() { [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8787/readyz)" == 200 ]]; }
pid() { systemctl show -p MainPID --value "$1"; }
preflight() { (cd /tmp && sudo -n $N $PF --service-env "$1"); }
policy() { Q "SELECT cognition_enabled||' '||provider||' '||model||' '||max_output_tokens||' '||input_microcents_per_token||' '||output_microcents_per_token||' '||cache_read_microcents_per_token||' '||cache_write_microcents_per_token||' '||default_daily_budget_cents||' '||default_max_turns_per_hour FROM fleet_cognition_policy WHERE id = 1"; }
founders() { Q "SELECT string_agg(a.agent_id||' '||a.status||' paused='||c.paused||' '||left(a.runtime_commit,7), ' | ' ORDER BY a.agent_id) FROM fleet_agents a JOIN fleet_founder_cognition c USING (agent_id)"; }
die() { echo "!! $*"; echo "== STAGE 1 STEP 4 NOT DONE $(ts): $(founders); policy $(policy | cut -d' ' -f1-2); controller PID $(pid automaton-fleet.service)"; exit 1; }
echo "== Stage 1 retry, step 4 (inference on) — $MODE — $(ts)"

echo "== gates (read-only)"
[[ "$(sha256sum < $PF | cut -c1-64)" == "$PF_SHA" ]] || die "the preflight script is not $PF_SHA"
[[ "$(readlink -f /opt/automaton-fleet/current | xargs basename)" == "$C" && "$(Q 'SELECT max(version) FROM fleet_schema_migrations')" == 122 ]] || die "not c448d98 on schema 122"
ready || die "controller not ready before the change"
[[ "$(founders)" == "$A1 active paused=true 7c194b8 | $A2 active paused=true b60e262" ]] || die "founders are not both active and paused on their runtimes: $(founders)"
for a in $A1 $A2; do [[ "$(systemctl show -p ActiveState --value automaton-fleet-founder@$a.service)" == active ]] || die "founder unit $a is not running"; done
PENDING=(); pending() { [[ $MODE == --check ]] && { PENDING+=("$1"); echo "  PENDING: $1"; } || die "$1"; }
C2=1; sudo -n grep -qx 'FLEET_INFERENCE_PROFILE=cloud_allowed' $SE || { C2=0; pending "C2 not applied (no FLEET_INFERENCE_PROFILE=cloud_allowed in service.env)"; }
sudo -n grep -qx 'FLEET_COGNITION_PROVIDER=none' $SE || die "the provider is not none before the change"
[[ "$(Q "SELECT count(*) FROM fleet_operator_keys WHERE principal_id = '$OPERATOR' AND revoked_at IS NULL AND expires_at > now() + interval '7 days'")" -ge 1 ]] || pending "C1 not done: claude-operator has no key valid for 7+ days (the incident's R4)"
[[ "$(sudo -n stat -c '%U %a %h' $KEY)" == "automaton-fleet-service 600 1" ]] && sudo -n cmp -s $KEY $KEY_SRC || die "the inference key file is not the 23 Oct key (service user, 0600, one link)"
[[ "$(policy)" == "false anthropic claude-opus-5-5 4000 400 2000 20 500 754 20" ]] || die "the policy is not as recorded on 27 Oct: $(policy)"
[[ "$(Q 'SELECT tripped FROM fleet_spend_circuit_breaker WHERE id = 1')" == t ]] || die "the spend breaker is not tripped"
FREE=$(Q "SELECT fleet_provider_credit_balance('anthropic') - (SELECT COALESCE(sum(usd_microcents),0) FROM fleet_provider_credit_holds WHERE status = 'open')")
[[ "$FREE" == 1500000000 && "$(Q "SELECT string_agg(run_id, ',') FROM fleet_provider_credit_holds WHERE status = 'open'")" == canary-agent1-ceiling ]] || die "free credit is $FREE µ¢, not exactly \$15 under the canary hold"
[[ "$(Q 'SELECT fleet_sales_open()')" == f ]] || die "sales are open"
[[ "$(Q "SELECT heartbeat_unresponsive_s||' '||heartbeat_dead_s||' '||termination_grace_s FROM fleet_state")" == "120 600 480" ]] || die "lifecycle timings are not the production values"
[[ "$(Q "SELECT prosrc LIKE '%lifecycle_hold_until%' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'fleet' AND proname = 'fleet_reap'")" == t ]] || die "the v122 reaper is not installed"
T=$(sudo -n mktemp -d /root/stage1.XXXXXX); trap 'sudo -n rm -rf "$T"' EXIT
sudo -n bash -c "grep -v -E '^FLEET_COGNITION_PROVIDER=|^FLEET_COGNITION_API_KEY_FILE=' $SE > $T/service.env.new; echo FLEET_COGNITION_PROVIDER=anthropic >> $T/service.env.new; echo FLEET_COGNITION_API_KEY_FILE=$KEY >> $T/service.env.new; chmod 600 $T/service.env.new"
(( C2 )) || sudo -n bash -c "echo FLEET_INFERENCE_PROFILE=cloud_allowed >> $T/service.env.new"   # --check before C2: the file as it will be after C2
[[ "$(sudo -n diff $SE $T/service.env.new | grep -c '^[<>]')" == $(( 3 + 1 - C2 )) ]] || die "the new file differs by more than provider none→anthropic and the key-file line"
echo "== preflight: the CURRENT file (the rollback) and the NEW file"
preflight $SE > $R/stage1-preflight-rollback.log; grep -q '^PREFLIGHT PASSED' $R/stage1-preflight-rollback.log || die "the rollback configuration does not pass: $(grep ^FAIL $R/stage1-preflight-rollback.log)"
preflight $T/service.env.new > $R/stage1-preflight-new.log
grep -q '^PASS inference profile and cognition provider — profile cloud_allowed, provider AnthropicProvider' $R/stage1-preflight-new.log && grep -q '^PREFLIGHT PASSED' $R/stage1-preflight-new.log || die "the new configuration does not pass: $(grep ^FAIL $R/stage1-preflight-new.log)"
echo "  both PREFLIGHT PASSED ($(grep -c '^PASS' $R/stage1-preflight-new.log) checks each)"
if [[ $MODE == --check ]]; then (( ${#PENDING[@]} )) && { echo "== CHECK PASSED EXCEPT PENDING PREREQUISITES $(ts): ${PENDING[*]} — nothing written"; exit 4; }; echo "== CHECK PASSED $(ts): nothing written; the step may run"; exit 0; fi

P1=$(pid automaton-fleet-founder@$A1.service); P2=$(pid automaton-fleet-founder@$A2.service); PC=$(pid automaton-fleet.service)
CL0=$(Q "SELECT count(*) FROM fleet_cognition_log")
echo "== 4a. policy enabled (prices unchanged; agents paused, so no call can start) $(ts)"
cli cognition-enable anthropic claude-opus-5-5 --max-output 4000 --in-microcents 400 --out-microcents 2000 > /dev/null || die "cognition-enable refused"
[[ "$(policy)" == "true anthropic claude-opus-5-5 4000 400 2000 20 500 754 20" ]] || { cli cognition-disable > /dev/null; die "the policy read-back differs: $(policy) (disabled again)"; }
echo "== 4b. service.env (backup first) $(ts)"
B=$SE.pre-stage1-retry-$(date -u +%Y%m%dT%H%M%SZ); sudo -n cp -p $SE $B || { cli cognition-disable > /dev/null; die "backup failed"; }
sudo -n install -o root -g root -m 600 $T/service.env.new $SE.s1-tmp && sudo -n mv -f $SE.s1-tmp $SE || { sudo -n cp -p $B $SE; cli cognition-disable > /dev/null; die "install failed (restored)"; }
preflight $SE > $R/stage1-preflight-live.log
grep -q '^PREFLIGHT PASSED' $R/stage1-preflight-live.log || { sudo -n cp -p $B $SE; cli cognition-disable > /dev/null; die "the LIVE file fails the preflight — restored, policy disabled, NO restart"; }
echo "== 4c. controller restart (bounded: ready within ${READY_S} s or automatic rollback) $(ts)"
T0=$(date +%s); sudo -n systemctl restart automaton-fleet.service
until ready || (( $(date +%s) - T0 >= READY_S )); do sleep 1; done
if ! ready; then
  echo "!! not ready after ${READY_S} s — ROLLBACK $(ts)"
  sudo -n journalctl -u automaton-fleet.service --since "@$T0" --no-pager -o cat > $R/stage1-failed-start.log 2>&1
  sudo -n cp -p $SE $SE.failed-stage1-retry-$(date -u +%Y%m%dT%H%M%SZ); sudo -n cp -p $B $SE
  sudo -n systemctl reset-failed automaton-fleet.service 2>/dev/null; sudo -n systemctl restart automaton-fleet.service
  T1=$(date +%s); until ready || (( $(date +%s) - T1 >= READY_S )); do sleep 1; done
  ready && cli cognition-disable > /dev/null
  die "the controller did not become ready with the new configuration (log $R/stage1-failed-start.log); service.env restored from $B; $(ready && echo 'controller READY on the old configuration, policy disabled' || echo 'CONTROLLER STILL NOT READY — owner action now (founders survive outages on v122, but act)'); total outage $(( $(date +%s) - T0 )) s"
fi
echo "  ready after $(( $(date +%s) - T0 )) s; controller PID $PC → $(pid automaton-fleet.service)"
sudo -n journalctl -u automaton-fleet.service --since "@$T0" --no-pager -o cat | grep -q '"startup_failed"' && echo "!! a startup_failed line was logged during the restart (see journal)"
echo "== 4d. founders re-verified (they ride out the outage; heartbeat + challenge) $(ts)"
T2=$(date +%s); until [[ "$(founders)" == "$A1 active paused=true 7c194b8 | $A2 active paused=true b60e262" ]] || (( $(date +%s) - T2 >= 300 )); do sleep 10; done
[[ "$(founders)" == "$A1 active paused=true 7c194b8 | $A2 active paused=true b60e262" ]] || die "founders not both active and paused 5 min after the restart: $(founders) — they are NOT at risk of death for 10+ min (v122); report and decide"
[[ "$(pid automaton-fleet-founder@$A1.service) $(pid automaton-fleet-founder@$A2.service)" == "$P1 $P2" ]] || echo "!! a founder process changed ($P1 $P2 → $(pid automaton-fleet-founder@$A1.service) $(pid automaton-fleet-founder@$A2.service))"
[[ "$(Q "SELECT count(*) FROM fleet_cognition_log")" == "$CL0" ]] || echo "!! a cognition turn was logged (agents should be paused)"
echo "== STEP 4 DONE $(ts): inference available (provider anthropic, profile cloud_allowed), both founders active and PAUSED, breaker"
echo "   tripped, canary hold kept (exactly \$15 free). Rollback: sudo cp -p $B $SE; cognition-disable; restart (preflight first)."
