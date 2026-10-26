#!/usr/bin/env bash
# The Agent-1 canary's persistent guard (prepared 2026-10-26; owner-installed at activation; runs without any Claude session).
#   fleet-canary.sh check [--dry-run]   hourly (automaton-fleet-canary-check.timer): read-only checks; on a stop condition, the safe stop
#   fleet-canary.sh end   [--dry-run]   at the deadline (automaton-fleet-canary-end.timer), or by check once ENDS_AT has passed
#   fleet-canary.sh status              read-only summary
# Configuration: ${FLEET_CANARY_CONF:-$HOME/canary/canary.conf} (KEY=VALUE, no secret):
#   CANARY_ID, AGENT, OFFER_SLUG, STARTED_AT, ENDS_AT (ISO, UTC), CASH_CEILING_MINOR, CREDIT_CEILING_USD_MICRO, HOLD_RUN
# Safe stop (owner actions, pre-authorised by installing this): pause the agent's cognition, hold its offer, close sales, clear
# Fleet Control's budget. Each emits a Fleet Command event (offer_held and budget changes are P2: the owner is notified).
# Provider `none` / key back to recovery needs root and a controller restart: never done here. Nothing is restored or posted.
# The provider-credit ceiling hold is released only at the end, and only when no reservation is open.
set -uo pipefail
MODE=${1:?check|end|status}; DRY=false; [[ "${2:-}" == "--dry-run" ]] && DRY=true
CONF=${FLEET_CANARY_CONF:-$HOME/canary/canary.conf}
[[ -r "$CONF" ]] || { echo "no canary configuration at $CONF" >&2; exit 2; }
get() { sed -n "s/^$1=//p" "$CONF" | tail -1; }
CANARY_ID=$(get CANARY_ID); AGENT=$(get AGENT); SLUG=$(get OFFER_SLUG); START=$(get STARTED_AT); ENDS=$(get ENDS_AT)
CASH_MAX=$(get CASH_CEILING_MINOR); CREDIT_MAX=$(get CREDIT_CEILING_USD_MICRO); HOLD_RUN=$(get HOLD_RUN)
[[ "$CANARY_ID" =~ ^[A-Za-z0-9._:-]{3,64}$ && "$AGENT" =~ ^[0-9A-HJKMNP-TV-Z]{26}$ && "$SLUG" =~ ^[a-z0-9-]{3,80}$ \
   && "$START" =~ ^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$ && "$ENDS" =~ ^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$ \
   && "$CASH_MAX" =~ ^[0-9]{1,9}$ && "$CREDIT_MAX" =~ ^[0-9]{1,13}$ && "$HOLD_RUN" =~ ^[A-Za-z0-9._:-]{3,64}$ ]] || { echo "invalid canary configuration" >&2; exit 2; }
STATE=$(dirname "$CONF"); LOG=$STATE/canary-$CANARY_ID.jsonl; STOPPED=$STATE/STOPPED-$CANARY_ID
DB=${FLEET_CANARY_DB:-automaton_fleet}
# Read-only, with the configuration passed as psql variables (stdin: psql interpolates variables only in scripts, not -c).
PSQL=${FLEET_CANARY_PSQL:-sudo -n -u postgres psql}   # (overridable for tests only)
Q() { printf 'SET default_transaction_read_only=on; SET search_path=fleet;\n%s\n' "$1" | $PSQL -X -q -At -v ON_ERROR_STOP=1 -d "$DB" -v agent="$AGENT" -v start="$START" -f -; }
# The owner CLI of the installed release (overridable for tests only).
CLI_DIR=${FLEET_CANARY_CLI_DIR:-/opt/automaton-fleet/current}; CLI_NODE=${FLEET_CANARY_NODE:-/opt/automaton-fleet/node/bin/node}
cli() { if $DRY; then echo "DRY-RUN would run: fleet:admin $*"; else ( cd "$CLI_DIR" && "$CLI_NODE" dist/fleet/postgres/cli.js "$@" ); fi; }
ts() { date -u +%FT%TZ; }
# A dry run writes nothing anywhere (stdout only): no log line, no STOPPED marker, no owner action.
note() { local line; line=$(printf '{"at":"%s","canary":"%s","mode":"%s","dryRun":%s,%s}' "$(ts)" "$CANARY_ID" "$MODE" "$DRY" "$1"); echo "$line"; $DRY || echo "$line" >> "$LOG"; }

safe_stop() {
  local why=$1
  [[ -e "$STOPPED" ]] && { note "\"skipped\":\"already stopped\""; return 0; }
  note "\"stop\":\"$why\""
  cli founder-cognition "$AGENT" pause "canary $CANARY_ID stopped: $why"
  cli economy-offer-hold "$SLUG" "canary $CANARY_ID stopped: $why"
  cli economy-sales closed
  cli economy-fleet-control-ai-budget off "canary $CANARY_ID stopped: $why"
  $DRY || date -u +%FT%TZ > "$STOPPED"
}

measures() {
  # scripts/fleet-canary-measures.sql (read-only): all values since STARTED_AT; duplicate EXECUTION, not duplicate content.
  local sqlf; sqlf=${FLEET_CANARY_MEASURES_SQL:-$(dirname "$(readlink -f "$0")")/fleet-canary-measures.sql}
  [[ -r "$sqlf" ]] || { echo "measures SQL missing: $sqlf" >&2; return 1; }
  $PSQL -X -q -At -v ON_ERROR_STOP=1 -d "$DB" -v agent="$AGENT" -v start="$START" -v hold="$HOLD_RUN" -f - < "$sqlf" | tail -1
}

case "$MODE" in
  status) m=$(measures); note "\"measures\":$m" ;;
  check)
    [[ -e "$STOPPED" ]] && { note "\"skipped\":\"stopped at $(cat "$STOPPED")\""; exit 0; }
    if [[ "$(date -u +%s)" -ge "$(date -u -d "$ENDS" +%s)" ]]; then exec "$0" end $($DRY && echo --dry-run); fi
    m=$(measures) || { note "\"error\":\"measures unavailable\""; exit 1; }
    note "\"measures\":$m"
    j() { python3 -c "import json,sys; print(json.loads(sys.argv[1])[sys.argv[2]])" "$m" "$1"; }
    [[ "$(j ledgerOk)" == True ]] || { safe_stop "ledger verification failed"; exit 0; }
    (( $(j agentChargedMinor) <= CASH_MAX )) || { safe_stop "agent cash charges $(j agentChargedMinor)p exceed ${CASH_MAX}p"; exit 0; }
    (( $(j creditConsumedUsdMicro) <= CREDIT_MAX )) || { safe_stop "provider credit consumed $(j creditConsumedUsdMicro) µ¢ exceeds $CREDIT_MAX µ¢"; exit 0; }
    (( $(j repeatedDeliveries) == 0 )) || { safe_stop "an order has more than one delivery without a declared resend reason (repeated execution)"; exit 0; }
    (( $(j repeatedMessages) == 0 )) || { safe_stop "a message to a buyer was sent again within 30 minutes without a buyer message between (repeated execution)"; exit 0; }
    (( $(j fleetControlOpenOver30m) == 0 && $(j fleetControlUnknown) == 0 )) || note "\"warn\":\"a Fleet Control reservation is open over 30 min or of unknown cost: reconcile it\""
    ;;
  end)
    safe_stop "the canary period ended ($ENDS)"
    m=$(measures); note "\"measures\":$m"
    open=$(Q "SELECT (SELECT count(*) FROM fleet_cognition_inflight WHERE agent_id = :'agent') + (SELECT count(*) FROM fleet_control_ai_reservations WHERE status IN ('open','unknown'))")
    if [[ "$open" == 0 ]]; then cli economy-engineering-credit-release "$HOLD_RUN" "canary $CANARY_ID ended; no reservation open"
    else note "\"hold\":\"kept: $open reservation(s) still open — the owner reconciles them, then releases $HOLD_RUN\""; fi
    ;;
  *) echo "usage: fleet-canary.sh check|end|status [--dry-run]" >&2; exit 2 ;;
esac
