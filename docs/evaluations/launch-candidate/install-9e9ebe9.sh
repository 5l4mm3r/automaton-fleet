#!/usr/bin/env bash
# Install 9e9ebe9 (v123 Treasury Watch; schema 122 -> 123; UI 0.27.0 -> 0.28.0). PREPARED 30 Oct, NOT RUN: needs the owner's explicit approval.
#   bash ~/rlc143/install-9e9ebe9.sh --check    read-only: every gate + the preflight of the LIVE config with the CANDIDATE code
#   bash ~/rlc143/install-9e9ebe9.sh            gates → backup → fleet-release.sh → verification
# The migration posts nothing: existing PayPal rows become history, without events, alerts or booking. Auto-booking stays OFF; switching
# it on, the operator read's principal, the agents, inference, sales and the spend breaker are all separate decisions, untouched here.
# Controller, custody, operator API and dashboard restart once. Founders keep running, PAUSED. Never restores a database.
set -uo pipefail
R=~/rlc143; MODE=${1:-apply}
SELF=$(readlink -f "${BASH_SOURCE[0]}"); ARGS=("$@")
if [[ "${FLEET_TEELOG:-}" != "$SELF" ]]; then FLEET_TEELOG="$SELF" bash "$SELF" "${ARGS[@]}" 2>&1 | tee -a "$R/install-9e9ebe9.log"; exit "${PIPESTATUS[0]}"; fi
unset FLEET_TEELOG
A1=01M3F50SH7PNX2E3GST13J52AS; A2=01M4C4NXT786Q4E9725N5A15KV
C=9e9ebe9ee9ca399a368c0fdea2ded7fcf5451323; BUILD=011db0b77c052329730284ec2404cd5010c9c8d7466970dde5e10ba112d80b57
LOCK=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1; PREV=e0dc22321c0a6633ae74aadef0279074011a5b0a
UI=0.28.0; UITGZ=$R/ui-0.28.0-9e9ebe9.tgz; UISHA=1dfdc30b3a02d7bbc4bbe790e34635ebcbb71f499721df37ce978d088fd300f0
REL=/opt/automaton-fleet/releases/$C; N=/opt/automaton-fleet/node/bin/node
PF=$R/fleet-controller-preflight.mjs; PF_SHA=2c6f6c37ad900b92b1d461996040facfcbfb88fbf27989797fe9e1be5594d628
TIMINGS="120 600 480 300"
ts() { date -u +%FT%TZ; }
Q() { sudo -n -u postgres psql -X -q -At -d automaton_fleet -c "SET default_transaction_read_only=on; SET search_path=fleet; $1"; }
cur() { readlink -f /opt/automaton-fleet/current | xargs basename; }
pid() { systemctl show -p MainPID --value "$1"; }
ready() { [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8787/readyz)" == 200 ]]; }
founders() { Q "SELECT string_agg(a.agent_id||' '||a.status||' paused='||c.paused||' '||left(a.runtime_commit,7), ' | ' ORDER BY a.agent_id) FROM fleet_agents a JOIN fleet_founder_cognition c USING (agent_id)"; }
FOUNDERS_OK="$A1 active paused=true e0dc223 | $A2 active paused=true b60e262"
contained() {
  [[ "$(Q 'SELECT cognition_enabled FROM fleet_cognition_policy WHERE id = 1')" == f ]] || return 1
  [[ "$(Q 'SELECT tripped FROM fleet_spend_circuit_breaker WHERE id = 1')" == t ]] || return 1
  [[ "$(Q 'SELECT fleet_sales_open()')" == f ]] || return 1
  [[ "$(Q 'SELECT count(*) FROM fleet_refund_authorities a WHERE fleet_refund_authority_live(a)') $(Q 'SELECT count(*) FROM fleet_outward_release WHERE expires_at > now()')" == "0 0" ]] || return 1
}
state() { echo "  -- $(ts): current $(cur | cut -c1-7); schema $(Q 'SELECT max(version) FROM fleet_schema_migrations'); $(founders); ctl PID $(pid automaton-fleet.service); ledger $(Q 'SELECT head_seq FROM fleet_ledger_head') verify $(Q "SELECT fleet_ledger_verify()->>'ok'"); contained $(contained && echo yes || echo NO)"; }
die() { echo "!! $*"; state; echo "== INSTALL NOT COMPLETE $(ts) — no database was restored; agents paused, policy off; stop and report"; exit 1; }
sudo -v || exit 2
echo "== install ${C:0:7} ($MODE) — release ${PREV:0:7} -> ${C:0:7}, schema 122 -> 123, UI $UI — $(ts)"

echo "== 0. gates"
[[ -z "${FLEET_ROLLOUT_AUTO_RESTORE:-}" ]] || die "FLEET_ROLLOUT_AUTO_RESTORE is set: automatic database restoration must stay off"
[[ "$(sed -n 's/^FLEET_RUNTIME_COMMIT=//p' $R/pins.txt) $(sed -n 's/^FLEET_RUNTIME_BUILD_ID=//p' $R/pins.txt) $(sed -n 's/^FLEET_RUNTIME_LOCKFILE_SHA256=//p' $R/pins.txt)" == "$C $BUILD $LOCK" ]] || die "pins.txt is not ${C:0:7} / ${BUILD:0:12}"
[[ -d $REL && "$(cd $REL && sudo -n $N dist/fleet/postgres/cli.js build-identity . 2>/dev/null | $N -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(j.buildId+" "+j.lockfileSha256)')" == "$BUILD $LOCK" ]] || die "the side-installed tree is not the pinned build"
grep -q "REHEARSAL PASSED" $R/rehearse.log && grep -q "rollout rehearse ${C:0:7}" $R/rehearse.log || die "no passed data rehearsal of ${C:0:7}"
grep -q "UPGRADE REHEARSAL PASSED" ~/upgrade-rehearsal-${C:0:7}.txt && [[ -e ~/upgrade-rehearsal-${C:0:7}.ok ]] || die "no passed services rehearsal of ${C:0:7}"
for f in $R/rehearse.log ~/upgrade-rehearsal-${C:0:7}.txt; do (( $(date +%s) - $(stat -c %Y $f) < 86400 )) || die "$f is older than 24 h"; done
# The founder rehearsals print a JSON report; its checks were parsed into these result files (all ok, none failed).
grep -q "^PASSED 27/27 (founder upgrade rehearsal e0dc223 -> ${C:0:7}" $R/founder-upgrade-rehearsal.result || die "no passed founder upgrade rehearsal (e0dc223 → ${C:0:7})"
grep -q -E "^PASSED ([0-9]+)/\1 \(revision rehearsal ${C:0:7}" $R/revision-rehearsal.result || die "no passed revision rehearsal"
[[ "$(cur)" == "$PREV" && "$(Q 'SELECT max(version) FROM fleet_schema_migrations')" == 122 ]] || die "production is not ${PREV:0:7} on schema 122"
[[ "$(founders)" == "$FOUNDERS_OK" ]] || die "founders are not both active and paused on their runtimes: $(founders)"
contained || die "containment is not as required (policy off, breaker tripped, sales and authorities closed)"
[[ "$(Q "SELECT heartbeat_unresponsive_s||' '||heartbeat_dead_s||' '||termination_grace_s||' '||health_grace_s FROM fleet_state")" == "$TIMINGS" ]] || die "timings are not $TIMINGS"
[[ "$(sha256sum < $UITGZ | cut -c1-64)" == "$UISHA" ]] || die "UI package checksum differs"
for k in REAL_REPLICATION_ENABLED REAL_PAYMENTS_ENABLED OWNER_SWEEP_ENABLED FLEET_DRY_RUN_CHILD; do grep -qx "$k=false" /etc/automaton-fleet/runtime.env || die "$k is not false"; done
[[ "$(sha256sum < $PF | cut -c1-64)" == "$PF_SHA" ]] || die "preflight script hash"
echo "== startup preflight: the LIVE configuration with the CANDIDATE's validators (and pins as they will be)"
T=$(sudo -n mktemp -d /root/inst.XXXXXX); trap 'sudo -n rm -rf "$T"' EXIT
sudo -n bash -c "sed -e 's/^FLEET_RUNTIME_COMMIT=.*/FLEET_RUNTIME_COMMIT=$C/' -e 's/^FLEET_RUNTIME_BUILD_ID=.*/FLEET_RUNTIME_BUILD_ID=$BUILD/' /etc/automaton-fleet/runtime.env > $T/runtime.env"
(cd /tmp && sudo -n $N $PF --release $REL --runtime-env $T/runtime.env) > $R/install-preflight.log 2>&1
FAILS=$(grep '^FAIL' $R/install-preflight.log)
# Before the cutover the registry still approves ${PREV:0:7}: that single, expected mismatch is the cutover's own approval step.
[[ -z "$FAILS" || ( "$(grep -c '^FAIL' $R/install-preflight.log)" == 1 && "$FAILS" == "FAIL runtime pins match the registry's approved runtime"* ) ]] \
  || die "the candidate refuses the live configuration: $FAILS"
echo "  $(grep -c '^PASS' $R/install-preflight.log) checks passed${FAILS:+; expected before the cutover: registry still approves ${PREV:0:7}}"
if [[ $MODE == --check ]]; then state; echo "== CHECK PASSED $(ts): nothing changed"; exit 0; fi

echo "== 1. backup"
LABEL=pre-install-${C:0:7}; bash ~/rlc139/baseline.sh $LABEL 2>&1 | sed -n "2,3p"
B=$(ls -d ~/rlc139/baseline-$LABEL-* | tail -1); n=$(sudo -n -u postgres pg_restore -l < $B/automaton_fleet-full.dump | wc -l); (( n > 4000 )) || die "backup dump unreadable ($n)"
echo "  backup $B ($n entries; kept, never restored by this script)"
H0=$(Q "SELECT head_seq||' '||head_hash FROM fleet_ledger_head"); P1=$(pid automaton-fleet-founder@$A1.service); P2=$(pid automaton-fleet-founder@$A2.service); PC=$(pid automaton-fleet.service)
CL0=$(Q "SELECT count(*) FROM fleet_cognition_log"); state

echo "== 2. release ${PREV:0:7} -> ${C:0:7} ($(ts))"
T0=$(date +%s)
bash $REL/scripts/fleet-release.sh $R/pins.txt 122 123 $UI $UITGZ $UISHA > $R/release.log 2>&1; rc=$?
grep -E "OUTAGE|reconciliation|DEPLOYED|FAILED|REFUSED|ROLLED|restore" $R/release.log | cut -c1-200
[[ $rc == 0 ]] && grep -q "RELEASE ${C:0:7} DEPLOYED" $R/release.log || die "the release did not deploy (see $R/release.log); no database was restored"
echo "  release done in $(( $(date +%s) - T0 )) s"

echo "== 3. verification ($(ts))"
[[ "$(cur)" == "$C" && "$(Q 'SELECT max(version) FROM fleet_schema_migrations')" == 123 ]] || die "current is not ${C:0:7} on 123"
[[ "$(Q 'SELECT auto_book_enabled FROM fleet_treasury_watch_policy WHERE id = 1')" == f ]] || die "auto-booking is not off"
ready || die "controller not ready"
sudo -n journalctl -u automaton-fleet.service --since "@$T0" --no-pager -o cat | grep -q '"startup_failed"' && die "a startup_failed was logged"
T2=$(date +%s); until [[ "$(founders)" == "$FOUNDERS_OK" ]] || (( $(date +%s) - T2 >= 300 )); do sleep 10; done
[[ "$(founders)" == "$FOUNDERS_OK" ]] || die "founders not both active and paused 5 min after the release: $(founders)"
[[ "$(pid automaton-fleet-founder@$A1.service) $(pid automaton-fleet-founder@$A2.service)" == "$P1 $P2" ]] || die "a founder process changed"
[[ "$(Q "SELECT count(*) FROM fleet_events WHERE created_at > to_timestamp($T0) AND event_type ~ 'unresponsive|died|challenge_failed|terminat'")" == 0 ]] || echo "  note: lifecycle events during the outage: $(Q "SELECT string_agg(event_type, ',') FROM fleet_events WHERE created_at > to_timestamp($T0) AND event_type ~ 'unresponsive|died|challenge_failed|terminat'")"
contained || die "containment changed"
[[ "$(Q "SELECT head_seq||' '||head_hash FROM fleet_ledger_head")" == "$H0" && "$(Q "SELECT fleet_ledger_verify()->>'ok'")" == true ]] || die "the ledger moved or does not verify"
[[ "$(Q "SELECT count(*) FROM fleet_cognition_log")" == "$CL0" ]] || die "a cognition turn happened"
[[ "$(Q "SELECT heartbeat_unresponsive_s||' '||heartbeat_dead_s||' '||termination_grace_s||' '||health_grace_s FROM fleet_state")" == "$TIMINGS" ]] || die "timings changed"
(cd /tmp && sudo -n $N $PF) > $R/install-preflight-after.log 2>&1; grep -q '^PREFLIGHT PASSED' $R/install-preflight-after.log || die "the installed release fails the preflight: $(grep ^FAIL $R/install-preflight-after.log)"
state
echo "== INSTALL COMPLETE $(ts): ${C:0:7} (build ${BUILD:0:12}) on schema 123; both founders active and PAUSED on e0dc223 / b60e262 (same processes);"
echo "   policy off; containment unchanged; ledger unchanged. Auto-booking off. Watch: cli economy-treasury-watch."
