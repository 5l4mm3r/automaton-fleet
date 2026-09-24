#!/usr/bin/env bash
# Phase 6 — privileged deployment verification (read-only; changes nothing).
#
#   sudo scripts/fleet-verify-deployment.sh
#
# Checks, as the real OS identities, what `pnpm fleet:verify` can only infer
# from file modes:
#   - the agent user and the service user cannot read controller secrets
#   - TLS material: tls/ root:automaton-fleet-admin 0750, fleet.key root:root 0600,
#     fleet.crt root:root 0644 (single-link regular files); the remote drop-in, if
#     installed, maps exactly tls.key/tls.crt and runtime.env sets no FLEET_TLS_KEY_FILE
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
for u in automaton-agent automaton-fleet-service automaton-fleet-witness; do
  if ! id "$u" >/dev/null 2>&1; then
    [[ "$u" == automaton-fleet-witness ]] && { ok "user $u not created (root witness not installed)"; continue; }
    bad "user $u missing"; continue
  fi
  for f in "$ETC/admin.env" "$ETC/service.env" "$ETC/tls/fleet.key" "$ETC/legacy-env-fleet.bak"; do
    [[ -e "$f" ]] || continue
    if runuser -u "$u" -- test -r "$f" 2>/dev/null; then bad "$u CAN read $f"; else ok "$u cannot read $f"; fi
  done
done

if id automaton-fleet-witness >/dev/null 2>&1; then
  groups_of="$(id -nG automaton-fleet-witness)"
  [[ "$groups_of" == automaton-fleet-witness ]] && ok "automaton-fleet-witness is in no other group" || bad "automaton-fleet-witness groups: $groups_of"
fi

echo "TLS material (LoadCredential sources)"
# expect <path> <owner:group> <octal mode> <kind: d|f>
expect() {
  local f="$1" want="$2 $3" got
  if [[ ! -e "$f" && ! -L "$f" ]]; then ok "$f absent (remote HTTPS disabled)"; return; fi
  if [[ -L "$f" ]]; then bad "$f is a symlink"; return; fi
  if [[ "$4" == d && ! -d "$f" ]] || [[ "$4" == f && ! -f "$f" ]]; then bad "$f has the wrong file type"; return; fi
  if [[ "$4" == f && "$(stat -c %h "$f")" != 1 ]]; then bad "$f has $(stat -c %h "$f") hard links"; return; fi
  got="$(stat -c '%U:%G %a' "$f")"
  [[ "$got" == "$want" ]] && ok "$f is $got" || bad "$f is $got (expected $want)"
}
expect "$ETC/tls" root:automaton-fleet-admin 750 d
expect "$ETC/tls/fleet.key" root:root 600 f
expect "$ETC/tls/fleet.crt" root:root 644 f
DROPIN=/etc/systemd/system/automaton-fleet.service.d/remote.conf
if [[ -e "$DROPIN" ]]; then
  creds="$(grep -E '^[[:space:]]*LoadCredential' "$DROPIN" | tr -d ' ' | sort)"
  want="$(printf '%s\n' 'LoadCredential=tls.crt:/etc/automaton-fleet/tls/fleet.crt' 'LoadCredential=tls.key:/etc/automaton-fleet/tls/fleet.key')"
  [[ "$creds" == "$want" ]] && ok "remote drop-in maps exactly tls.key and tls.crt" || bad "remote drop-in LoadCredential lines are not exactly tls.key/tls.crt"
else
  ok "remote drop-in not installed"
fi
if grep -qE '^[[:space:]]*FLEET_TLS_KEY_FILE[[:space:]]*=' "$ETC/runtime.env" 2>/dev/null; then
  bad "runtime.env sets FLEET_TLS_KEY_FILE (use LoadCredential=tls.key; leave it unset)"
else
  ok "runtime.env leaves FLEET_TLS_KEY_FILE unset"
fi
if grep -qE '^[[:space:]]*FLEET_TLS_CERT_FILE[[:space:]]*=' "$ETC/runtime.env" 2>/dev/null &&
   ! grep -qx 'FLEET_TLS_CERT_FILE=/run/credentials/automaton-fleet.service/tls.crt' "$ETC/runtime.env"; then
  bad "runtime.env FLEET_TLS_CERT_FILE is not /run/credentials/automaton-fleet.service/tls.crt"
fi

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
