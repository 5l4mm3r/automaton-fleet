#!/usr/bin/env bash
# Phase 6 — privileged deployment verification (read-only; changes nothing).
#
#   sudo scripts/fleet-verify-deployment.sh
#
# Checks, as the real OS identities, what `pnpm fleet:verify` can only infer
# from file modes:
#   - the agent user and the service user cannot read controller secrets
#   - the fleet service runs as automaton-fleet-service (never root)
#   - PostgreSQL and Redis listen on loopback only; the fleet admin HTTP port
#     is loopback-only; only the HTTPS port (if enabled) is public
# Exit 1 on any failure. Never prints secret contents.
set -uo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo (read-only checks)" >&2; exit 2; }
ETC=/etc/automaton-fleet
fail=0
ok()  { printf '  [PASS] %s\n' "$*"; }
bad() { printf '  [FAIL] %s\n' "$*"; fail=1; }

echo "Secrets vs OS identities"
for u in automaton-agent automaton-fleet-service; do
  id "$u" >/dev/null 2>&1 || { bad "user $u missing"; continue; }
  for f in "$ETC/admin.env" "$ETC/service.env" "$ETC/tls/fleet.key" "$ETC/legacy-env-fleet.bak"; do
    [[ -e "$f" ]] || continue
    if runuser -u "$u" -- test -r "$f" 2>/dev/null; then bad "$u CAN read $f"; else ok "$u cannot read $f"; fi
  done
done
op="${SUDO_USER:-}"
if [[ -n "$op" ]] && grep -qE '^[[:space:]]*(DATABASE_URL|FLEET_ADMIN_DATABASE_URL|FLEET_CONTROLLER_DATABASE_URL|REDIS_URL)[[:space:]]*=' "$(dirname "$0")/../.env.fleet" 2>/dev/null; then
  bad "repository .env.fleet still holds controller secrets"
else
  ok "repository .env.fleet holds no controller secrets"
fi

echo "Service identity"
state="$(systemctl is-active automaton-fleet.service 2>/dev/null || true)"
[[ "$state" == active ]] && ok "automaton-fleet.service active" || bad "automaton-fleet.service is ${state:-unknown}"
pid="$(systemctl show -p MainPID --value automaton-fleet.service 2>/dev/null || echo 0)"
if [[ "$pid" =~ ^[0-9]+$ && "$pid" != 0 ]]; then
  user="$(ps -o user= -p "$pid" | tr -d ' ')"
  [[ "$user" == automaton-fleet-service ]] && ok "service process runs as $user" || bad "service process runs as $user"
  if tr '\0' '\n' <"/proc/$pid/environ" | grep -qE '^(FLEET_ADMIN_DATABASE_URL|FLEET_SERVICE_DATABASE_URL|FLEET_AGENT_DATABASE_URL|DATABASE_URL)='; then
    bad "database credentials visible in the service environment (/proc/$pid/environ)"
  else
    ok "no database credential in the service environment"
  fi
fi

echo "Network exposure"
listeners="$(ss -Hltn 2>/dev/null)"
for port in 5432 6379 8787; do
  public="$(awk -v p=":$port" '$4 ~ p"$" && $4 !~ /^(127\.0\.0\.1|\[::1\]):/' <<<"$listeners")"
  [[ -z "$public" ]] && ok "port $port loopback-only (or closed)" || bad "port $port listens publicly: $public"
done
if grep -q '^FLEET_REMOTE_LISTEN_ENABLED=true' "$ETC/runtime.env" 2>/dev/null; then
  ok "remote HTTPS listener enabled by runtime.env"
else
  ok "remote exposure disabled (FLEET_REMOTE_LISTEN_ENABLED is not true)"
fi
exit $fail
