#!/usr/bin/env bash
# Founder recovery after INCIDENT 2026-10-27 (Group B, part 2). PREPARED 2026-10-27, NOT RUN — needs the owner's explicit
# approval, and runs only after install-c448d98.sh completed (c448d98 on schema 122).
#
#   bash ~/rlc139/recover.sh                  reinstate → start → verify (with the containment fallback)
#   bash ~/rlc139/recover.sh restore-timings  after a fallback, once BOTH agents are active: the production timings again
#
# The order is fixed by evidence: a founder process started against its DEAD record refuses itself (exit 3, which the unit's
# RestartPreventExitStatus never restarts) without a heartbeat — so the registry is reinstated FIRST, the units are started
# SECOND, and each agent becomes active only by its own heartbeat and a passed health challenge.
#   1. `founder-reinstate` (one atomic owner transaction, the release's own command): both agents dead → unresponsive, same
#      identity and credential, paused, wallets unfrozen, estates reversed (mirrored journals; originals and the death history
#      kept), the acquisition cost 1179 back to waiting, a 60-minute verification hold (no automatic termination meanwhile).
#   2. `systemctl start` of the two founder units (their state directories untouched since the incident).
#   3. watch up to 15 minutes: heartbeat → challenge → active (the hold ends at active).
#   4. FALLBACK, automatically, at 15 minutes (45 minutes before the hold would end) for any agent not active, or at once if a
#      unit fails: the lifecycle death timings are raised to 24 h with the existing audited owner commands (set-timeouts
#      dead=86400, lifecycle-policy terminationGrace=86400; the v122 reaper counts them from the hold's end), the failing
#      agent's unit is stopped (no restart loop), its journal and registry rows are kept as evidence. The agent stays
#      unresponsive, paused, without inference, spending blocked (breaker tripped) — alive and contained, not dying. The
#      owner then fixes and starts it (it becomes active by heartbeat + challenge), and `restore-timings` returns the
#      timings once both are active. If more time is needed, the same commands may be re-applied before the window ends
#      (bounded by the registry: at most 7 days per setting; every change audited).
# It does NOT: end containment (spend breaker stays tripped, Fleet Control budget unset, the canary credit hold kept), enable
# inference, resume an agent, post anything other than the three mirrored reversals, rotate a key, or restore a database.
set -uo pipefail
R=~/rlc139
SELF=$(readlink -f "${BASH_SOURCE[0]}"); ARGS=("$@")
if [[ "${FLEET_TEELOG:-}" != "$SELF" ]]; then FLEET_TEELOG="$SELF" bash "$SELF" "${ARGS[@]}" 2>&1 | tee -a "$R/recover.log"; exit "${PIPESTATUS[0]}"; fi
unset FLEET_TEELOG
A1=01M3F50SH7PNX2E3GST13J52AS; A2=01M4C4NXT786Q4E9725N5A15KV
C=c448d98a1c32c63af89288758240fc5787f9f9d6; BUILD=48c0015ed443e23e835eed697ff5bc01275509d23fd13783a21f2422ad7c5725
INCIDENT="INCIDENT 2026-10-27 controller outage"; J1179=3cb79f23-c4fa-4aaa-a090-a5dfe1a2c0fd
HOLD_MIN=60; CHECKPOINT_S=900; FALLBACK_S=86400; TIMINGS="120 600 480 300"; HOLD=10023033480
ts() { date -u +%FT%TZ; }
Q() { sudo -n -u postgres psql -X -q -At -d automaton_fleet -c "SET default_transaction_read_only=on; SET search_path=fleet; $1"; }
cli() { ( cd /opt/automaton-fleet/current && /opt/automaton-fleet/node/bin/node dist/fleet/postgres/cli.js "$@" ); }   # actor operator:<you>
unit() { echo "automaton-fleet-founder@$1.service"; }
ustate() { echo "$(systemctl show -p ActiveState --value $(unit $1))/$(systemctl show -p ExecMainStatus --value $(unit $1)) pid $(systemctl show -p MainPID --value $(unit $1))"; }
status() { Q "SELECT status FROM fleet_agents WHERE agent_id = '$1'"; }
timings() { Q "SELECT heartbeat_unresponsive_s||' '||heartbeat_dead_s||' '||termination_grace_s||' '||health_grace_s FROM fleet_state"; }
head_() { Q "SELECT head_seq||' '||head_hash FROM fleet_ledger_head"; }
contained() {
  [[ "$(Q 'SELECT tripped FROM fleet_spend_circuit_breaker WHERE id = 1')" == t ]] || return 1
  [[ "$(Q "SELECT string_agg(run_id||' '||usd_microcents, ',') FROM fleet_provider_credit_holds WHERE status = 'open'")" == "canary-agent1-ceiling $HOLD" ]] || return 1
  [[ "$(Q 'SELECT cognition_enabled FROM fleet_cognition_policy WHERE id = 1')" == f ]] || return 1
  sudo -n grep -qx 'FLEET_COGNITION_PROVIDER=none' /etc/automaton-fleet/service.env || return 1
  [[ "$(Q "SELECT fleet_control_ai_state() ->> 'ceilingMinor'")" == "" ]] || return 1
  [[ "$(Q "SELECT bool_and(paused) FROM fleet_founder_cognition WHERE agent_id IN ('$A1','$A2')")" == t ]] || return 1
}
state() {
  echo "  -- $(ts): $(Q "SELECT string_agg(agent_id||' '||status||' hold='||COALESCE(to_char(lifecycle_hold_until,'HH24:MI:SS'),'none')||' hb='||COALESCE(to_char(last_heartbeat,'HH24:MI:SS'),'-'), ' | ' ORDER BY agent_id) FROM fleet_agents WHERE agent_id IN ('$A1','$A2')")"
  echo "     units: A1 $(ustate $A1); A2 $(ustate $A2); timings $(timings); ledger head $(head_ | cut -c1-20) verify $(Q "SELECT fleet_ledger_verify()->>'ok'"); contained $(contained && echo yes || echo NO)"
}
die() { echo "!! $*"; state; echo "== RECOVERY STOPPED $(ts) — no database was restored; containment unchanged; stop and ask the owner"; exit 1; }
sudo -v || exit 2

if [[ "${1:-}" == restore-timings ]]; then
  echo "== restore the production lifecycle timings ($(ts))"
  [[ "$(status $A1) $(status $A2)" == "active active" ]] || die "both agents must be active before the timings return to $TIMINGS (an unresponsive agent past the normal grace would die at once)"
  read -r _ HD TG _ <<< "$TIMINGS"
  cli set-timeouts dead=$HD | tail -1 | cut -c1-200; cli lifecycle-policy terminationGrace=$TG > /dev/null
  [[ "$(timings)" == "$TIMINGS" ]] || die "timings are $(timings), not $TIMINGS"
  state; echo "== TIMINGS RESTORED $(ts)"; exit 0
fi

echo "== founder recovery on ${C:0:7} start $(ts)"
echo "== 0. gates + pre-recovery backup"
[[ "$(readlink -f /opt/automaton-fleet/current | xargs basename)" == "$C" && "$(Q 'SELECT max(version) FROM fleet_schema_migrations')" == 122 ]] || die "c448d98 on schema 122 is not installed"
[[ "$(cd /opt/automaton-fleet/current && sudo -n /opt/automaton-fleet/node/bin/node dist/fleet/postgres/cli.js build-identity . 2>/dev/null | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).buildId)')" == "$BUILD" ]] || die "the installed build is not ${BUILD:0:12}"
[[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:8787/readyz)" == 200 ]] || die "controller not ready"
[[ "$(Q "SELECT string_agg(agent_id||' '||status, ',' ORDER BY agent_id) FROM fleet_agents")" == "$A1 dead,$A2 dead" ]] || die "the registry is not the incident's (both dead, nothing else)"
[[ "$(Q "SELECT count(*) FROM fleet_events WHERE event_type = 'agent_died' AND detail ->> 'cause' = 'health_timeout' AND agent_id IN ('$A1','$A2')")" == 2 ]] || die "the deaths are not the incident's health_timeout deaths"
[[ "$(Q "SELECT count(*) FROM fleet_events WHERE event_type = 'agent_reinstated'")" == 0 ]] || die "a reinstatement already happened (re-running is refused; the owner decides)"
for a in $A1 $A2; do [[ "$(ustate $a)" == "failed/3 pid 0" ]] || die "founder unit $a is not failed/3 ($(ustate $a))"; sudo -n test -d /var/lib/private/automaton-founders/$a || die "founder state $a is missing"; done
[[ "$(Q "SELECT journal_id||' '||kind FROM fleet_ledger_journal WHERE seq = 1179")" == "$J1179 ai_credit_acquisition_cost" ]] || die "journal 1179 is not the acquisition cost"
[[ "$(timings)" == "$TIMINGS" ]] || die "lifecycle timings are $(timings), not $TIMINGS"
contained || die "containment is not as left (breaker tripped, budget unset, canary hold kept, inference off, both paused)"
(cd ~/incident-20261027 && sha256sum --quiet -c SHA256SUMS) || die "the incident evidence does not verify"
[[ "$(Q "SELECT max_agents||' '||living_agents FROM fleet_state")" == "2 0" ]] || die "cap 2 with 0 living expected"
LABEL=pre-recovery-${C:0:7}; bash $R/baseline.sh $LABEL 2>&1 | sed -n "2,3p"
B=$(ls -d $R/baseline-$LABEL-* | tail -1); n=$(sudo -n -u postgres pg_restore -l < $B/automaton_fleet-full.dump | wc -l); (( n > 4000 )) || die "pre-recovery dump unreadable ($n entries)"
echo "  pre-recovery backup $B ($n dump entries; kept, never restored by this script)"
CL0=$(Q "SELECT count(*) FROM fleet_cognition_log WHERE agent_id IN ('$A1','$A2')"); H0=$(head_)
mkdir -p -m 700 $R/recover-evidence; state

echo "== 1. reinstate (one atomic owner transaction; hold $HOLD_MIN min) $(ts)"
cli founder-reinstate "$INCIDENT" "$A1,$A2" "$J1179" $HOLD_MIN > $R/recover-evidence/reinstate.json 2>&1 || die "founder-reinstate refused (atomic: nothing changed): $(head -c 400 $R/recover-evidence/reinstate.json)"
[[ "$(status $A1) $(status $A2)" == "unresponsive unresponsive" ]] || die "not both unresponsive after the reinstatement"
[[ "$(Q "SELECT count(*) FROM fleet_agents WHERE agent_id IN ('$A1','$A2') AND lifecycle_hold_until BETWEEN now() + interval '55 minutes' AND now() + interval '61 minutes'")" == 2 ]] || die "the verification holds are not ~$HOLD_MIN min"
[[ "$(Q "SELECT count(*) FROM fleet_agent_credentials WHERE revoked_at IS NOT NULL AND agent_id IN ('$A1','$A2')")" == 0 ]] || die "a credential is still revoked"
[[ "$(Q "SELECT string_agg(status, ',') FROM fleet_estates WHERE agent_id IN ('$A1','$A2')")" == "reverted,reverted" ]] || die "the estates are not reverted"
[[ "$(Q "SELECT string_agg(r.seq||'>'||o.seq, ',' ORDER BY r.seq) FROM fleet_ledger_journal r JOIN fleet_ledger_journal o ON o.journal_id = r.reverses_journal_id WHERE r.seq > 1179")" == "1180>1179,1181>1177,1182>1178" ]] || die "the corrections are not exactly the three mirrored reversals"
[[ "$(Q "SELECT count(*) FROM fleet_ledger_journal WHERE seq BETWEEN 1177 AND 1179") $(Q "SELECT count(*) FROM fleet_events WHERE event_type = 'agent_died'")" == "3 2" ]] || die "an original journal or death event is missing"
[[ "$(Q "SELECT fleet_ledger_balance('fleet:treasury:unallocated')") $(Q "SELECT fleet_ledger_balance('fleet:treasury:unbacked_estates')") $(Q "SELECT fleet_ledger_verify()->>'ok'")" == "0 0 true" ]] || die "unallocated / unbacked / ledger not as rehearsed"
contained || die "containment changed"
state

echo "== 2. start the founder units (state untouched since the incident) $(ts)"
T0=$(date +%s)
for a in $A1 $A2; do sudo systemctl start $(unit $a) || echo "  start of $a returned non-zero"; done

echo "== 3. verification: heartbeat → challenge → active (up to $((CHECKPOINT_S / 60)) min; the hold ends at active)"
declare -A FAILED=()
while :; do
  done_=1
  for a in $A1 $A2; do
    [[ "$(status $a)" == active ]] && continue
    done_=0
    [[ "$(systemctl show -p ActiveState --value $(unit $a))" == failed ]] && FAILED[$a]="unit failed ($(ustate $a))"
  done
  (( done_ )) && break
  (( ${#FAILED[@]} > 0 || $(date +%s) - T0 >= CHECKPOINT_S )) && break
  sleep 10
done
state

FALLBACK=0
for a in $A1 $A2; do [[ "$(status $a)" == active ]] || { FALLBACK=1; FAILED[$a]="${FAILED[$a]:-not active after $(( ($(date +%s) - T0) / 60 )) min}"; }; done
if (( FALLBACK )); then
  echo "== 4. FALLBACK (before the holds end at $(Q "SELECT to_char(min(lifecycle_hold_until),'HH24:MI:SS') FROM fleet_agents WHERE lifecycle_hold_until IS NOT NULL")) $(ts)"
  for a in "${!FAILED[@]}"; do echo "  $a: ${FAILED[$a]}"; done
  cli set-timeouts dead=$FALLBACK_S | tail -1 | cut -c1-200
  cli lifecycle-policy terminationGrace=$FALLBACK_S > /dev/null
  [[ "$(timings)" == "120 $FALLBACK_S $FALLBACK_S 300" ]] || die "THE FALLBACK TIMINGS DID NOT APPLY ($(timings)) — the owner must act before the holds end"
  for a in "${!FAILED[@]}"; do
    sudo systemctl stop $(unit $a) 2>/dev/null
    sudo journalctl -u $(unit $a) --since "@$T0" --no-pager > $R/recover-evidence/journal-$a.txt 2>&1
    Q "SELECT to_jsonb(a) - 'wallet_address' FROM fleet_agents a WHERE agent_id = '$a'" > $R/recover-evidence/registry-$a.json
    Q "SELECT jsonb_agg(c ORDER BY issued_at) FROM fleet_health_challenges c WHERE agent_id = '$a' AND issued_at > to_timestamp($T0)" > $R/recover-evidence/challenges-$a.json
  done
  contained || die "containment changed"
  state
  echo "== RECOVERY CONTAINED, NOT COMPLETE $(ts): failing agent(s) ${!FAILED[*]} are ALIVE (unresponsive, paused, no inference, spending"
  echo "   blocked), their units stopped; no automatic death for 24 h after the hold ends (audited timings $(timings))."
  echo "   Evidence: $R/recover-evidence/. Next, with the owner: diagnose, fix, 'sudo systemctl start <unit>', watch it become active,"
  echo "   then 'bash ~/rlc139/recover.sh restore-timings'. Agents already active stay as they are."
  exit 3
fi

echo "== 5. verified $(ts)"
for a in $A1 $A2; do
  [[ "$(Q "SELECT lifecycle_hold_until IS NULL FROM fleet_agents WHERE agent_id = '$a'")" == t ]] || die "$a: the hold did not end at active"
  [[ "$(Q "SELECT outcome FROM fleet_health_challenges WHERE agent_id = '$a' ORDER BY issued_at DESC LIMIT 1")" == passed ]] || die "$a: the latest challenge did not pass"
done
contained || die "containment changed"
[[ "$(Q "SELECT count(*) FROM fleet_cognition_log WHERE agent_id IN ('$A1','$A2')")" == "$CL0" ]] || die "a cognition turn happened (none may while paused)"
[[ "$(head_)" == "$H0" ]] || die "the ledger moved after the reinstatement"
[[ "$(timings)" == "$TIMINGS" ]] || die "timings changed"
state
echo "== RECOVERY COMPLETE $(ts): Agent-1 and Agent-2 ACTIVE (same identities, new processes), PAUSED, inference off; containment"
echo "   unchanged (breaker tripped, budget unset, canary hold kept); corrections 1180-1182 (mirrored); history kept."
