#!/usr/bin/env bash
# Detached supervisor for the pinned recover.sh (454ec43e…), owner approval 28 Oct. Launch:
#   setsid nohup bash ~/rlc139/recover-run.sh < /dev/null > /dev/null 2>&1 &
# It survives SSH loss (own session, no tty). recover.sh itself applies the fallback when a unit fails or the 15-minute
# verification times out (exit 3). This supervisor covers the remaining exits: if recover.sh ends any OTHER way (a die()
# after the reinstatement, a kill) while an agent is reinstated but not active, it applies the SAME owner-authorised fallback
# timings (dead=86400, terminationGrace=86400) so no agent dies unattended at its hold's end. It never reinstates, starts,
# stops or posts anything, and changes nothing else.
set -uo pipefail
R=~/rlc139; A1=01M3F50SH7PNX2E3GST13J52AS; A2=01M4C4NXT786Q4E9725N5A15KV; FALLBACK_S=86400
DB=${FLEET_GUARD_DB:-automaton_fleet}; RECOVER=${FLEET_GUARD_RECOVER:-$R/recover.sh}; LOG=${FLEET_GUARD_LOG:-$R/recover-guard.log}
REL=${FLEET_GUARD_REL:-/opt/automaton-fleet/current}
exec >> "$LOG" 2>&1
ts() { date -u +%FT%TZ; }
Q() { sudo -n -u postgres psql -X -q -At -d "$DB" -c "SET default_transaction_read_only=on; SET search_path=fleet; $1"; }
cli() { ( cd "$REL" && /opt/automaton-fleet/node/bin/node dist/fleet/postgres/cli.js "$@" ); }   # admin.env (or the environment)
timings() { Q "SELECT heartbeat_unresponsive_s||' '||heartbeat_dead_s||' '||termination_grace_s||' '||health_grace_s FROM fleet_state"; }
echo "$(ts) supervisor pid $$ sid $(ps -o sid= -p $$ | tr -d ' ') tty $(tty -s && tty || echo none)"
if [[ -z "${FLEET_GUARD_RECOVER:-}" ]]; then
  [[ "$(sha256sum < "$RECOVER" | cut -d' ' -f1)" == 454ec43e2a1d9e7c273944bf8050cdcd093fde28961a8e0049246c06c8a7d5b9 ]] || { echo "$(ts) recover.sh hash mismatch: NOT RUN"; exit 9; }
fi
echo "$(ts) running $RECOVER (console: $R/recover.console; log: $R/recover.log)"
bash "$RECOVER" < /dev/null > "$R/recover.console" 2>&1; rc=$?
echo "$(ts) recover.sh exited $rc ($(tail -1 "$R/recover.console" | cut -c1-160))"
(( rc == 0 )) && { echo "$(ts) COMPLETE — supervisor has nothing to do"; exit 0; }
(( rc == 3 )) && { echo "$(ts) CONTAINED by recover.sh's own fallback (timings $(timings)) — supervisor has nothing to do"; exit 0; }
reinst=$(Q "SELECT count(*) FROM fleet_events WHERE event_type = 'agent_reinstated'")
exposed=$(Q "SELECT count(*) FROM fleet_agents WHERE agent_id IN ('$A1','$A2') AND status NOT IN ('active','dead')")
echo "$(ts) reinstated events $reinst; agents reinstated but not active $exposed; timings $(timings); $(Q "SELECT string_agg(agent_id||' '||status||' hold='||COALESCE(to_char(lifecycle_hold_until,'HH24:MI:SS'),'none'), ' | ' ORDER BY agent_id) FROM fleet_agents WHERE agent_id IN ('$A1','$A2')")"
if [[ "$reinst" == 0 || "$exposed" == 0 ]]; then echo "$(ts) nothing exposed (no reinstatement, or no agent between reinstated and active) — no fallback"; exit 0; fi
if [[ "$(timings)" != "120 $FALLBACK_S $FALLBACK_S 300" ]]; then
  echo "$(ts) FALLBACK (owner-authorised): set-timeouts dead=$FALLBACK_S, lifecycle-policy terminationGrace=$FALLBACK_S"
  cli set-timeouts dead=$FALLBACK_S | tail -1 | cut -c1-200
  cli lifecycle-policy terminationGrace=$FALLBACK_S > /dev/null
fi
[[ "$(timings)" == "120 $FALLBACK_S $FALLBACK_S 300" ]] && echo "$(ts) FALLBACK ACTIVE: timings $(timings); the exposed agent(s) stay alive 24 h past their hold; owner decides next" || echo "$(ts) !! FALLBACK DID NOT APPLY (timings $(timings)) — owner must act before the holds end"
