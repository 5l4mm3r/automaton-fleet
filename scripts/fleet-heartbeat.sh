#!/usr/bin/env bash
# The Fleet's heartbeat to an OUTSIDE monitor (owner instruction 2026-10-16: "an external monitor must be able to alert
# when the VPS itself is unavailable"). Run every 5 minutes by automaton-fleet-heartbeat.timer, and at once when a critical
# unit gives up restarting (OnFailure=). The monitor (recommended: Healthchecks.io, alerting the owner's phone through
# Pushover) alerts when a ping says "fail" — or when pings STOP, which is how a dead server is noticed: nothing on the
# server has to work for that alert.
#
# Checks (local, read-only): controller, dashboard and Operator API answer on loopback; PostgreSQL accepts connections;
# Redis answers; the admin certificate has >= 14 days left; the root disk is < 90 % full; no Fleet unit is in "failed".
# The ping carries only the names of failed checks — never a secret, a customer or an address.
#
#   FLEET_HB_PING_FILE   file holding the monitor's check URL (systemd credential; default $CREDENTIALS_DIRECTORY/heartbeat-url)
#   FLEET_HB_*           endpoint / command overrides (tests)
set -uo pipefail
URL_FILE="${FLEET_HB_PING_FILE:-${CREDENTIALS_DIRECTORY:-/nonexistent}/heartbeat-url}"
CONTROLLER="${FLEET_HB_CONTROLLER:-http://127.0.0.1:8787/readyz}"
DASHBOARD="${FLEET_HB_DASHBOARD:-http://127.0.0.1:8790/login/}"
OPERATOR="${FLEET_HB_OPERATOR:-http://127.0.0.1:8788/readyz}"
PG_READY="${FLEET_HB_PG_READY:-pg_isready -q -h /var/run/postgresql}"
REDIS_PING="${FLEET_HB_REDIS_PING:-redis-cli -h 127.0.0.1 ping}"
TLS_HOST="${FLEET_HB_TLS_HOST:-admin.agentfleet.vip}"
TLS_CONNECT="${FLEET_HB_TLS_CONNECT:-127.0.0.1:443}"
DISK_PATH="${FLEET_HB_DISK_PATH:-/}"
FAILED_UNITS="${FLEET_HB_FAILED_UNITS:-systemctl --failed --no-legend --plain automaton-fleet*}"
failed=()
http_ok() { curl -fsS -m 5 -o /dev/null "$1" 2>/dev/null; }
http_ok "$CONTROLLER" || failed+=(controller)
http_ok "$DASHBOARD"  || failed+=(dashboard)
http_ok "$OPERATOR"   || failed+=(operator-api)
$PG_READY >/dev/null 2>&1 || failed+=(postgresql)
r="$($REDIS_PING 2>&1 | head -1)"; [[ "$r" == PONG || "$r" == NOAUTH* ]] || failed+=(redis)
if [[ "$TLS_CONNECT" != none ]]; then
  end="$(echo | timeout 8 openssl s_client -connect "$TLS_CONNECT" -servername "$TLS_HOST" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
  if [[ -z "$end" ]]; then failed+=(tls-unreadable)
  else left=$(( ( $(date -d "$end" +%s) - $(date +%s) ) / 86400 )); (( left >= 14 )) || failed+=("tls-expires-in-${left}d"); fi
fi
use="$(df --output=pcent "$DISK_PATH" 2>/dev/null | tail -1 | tr -dc 0-9)"; [[ -n "$use" ]] && (( use < 90 )) || failed+=("disk-${use:-unknown}pct")
units="$($FAILED_UNITS 2>/dev/null | awk '{print $1}' | tr '\n' ' ')"; [[ -z "${units// /}" ]] || failed+=("failed-units:${units% }")

url=""; [[ -r "$URL_FILE" ]] && url="$(head -1 "$URL_FILE" | tr -d '[:space:]')"
if (( ${#failed[@]} )); then body="FAIL ${failed[*]}"; suffix=/fail; else body="ok"; suffix=""; fi
echo "$body"
if [[ -n "$url" ]]; then
  [[ "$url" =~ ^https?:// ]] || { echo "heartbeat URL is not a URL" >&2; exit 2; }
  curl -fsS -m 15 --retry 3 -o /dev/null --data-raw "$body" "$url$suffix" || { echo "monitor ping failed" >&2; exit 3; }
fi
(( ${#failed[@]} == 0 ))
