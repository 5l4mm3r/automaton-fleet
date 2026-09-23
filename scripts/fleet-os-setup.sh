#!/usr/bin/env bash
# Fleet Phase 4 — OS-user isolation and secret files.
#
#   sudo scripts/fleet-os-setup.sh            # DRY RUN: prints every command, changes nothing
#   sudo scripts/fleet-os-setup.sh --apply    # performs them (idempotent)
#
# Creates:
#   group  automaton-fleet-admin          operator group; may read admin.env (the operator is added)
#   user   automaton-fleet-service        system, nologin; runs the fleet service
#   user   automaton-agent                runs local agent runtimes; in NO fleet group
#   /etc/automaton-fleet/                 root:root 0755
#     tls/         root:root 0700                    Phase 6 certificate + key (empty; remote stays disabled)
#     admin.env    root:automaton-fleet-admin 0640   FLEET_ADMIN_DATABASE_URL (moved from repo .env.fleet)
#     service.env  root:root 0600                    FLEET_SERVICE_DATABASE_URL, FLEET_AGENT_DATABASE_URL
#                                                    (fresh hex passwords; read by systemd LoadCredential only)
#     runtime.env  root:root 0644                    non-secret: pinned runtime + safety flags (all false)
#   /opt/automaton-fleet/{releases,node/bin}         root-owned; pinned node binary copied in
#   /etc/systemd/system/automaton-fleet.service, automaton-agent.service (installed, NOT enabled/started)
# and moves controller secrets out of the repository .env.fleet (backup kept root-only).
#
# It never prints secret values, never starts anything and never touches PostgreSQL
# (that is scripts/fleet-db-setup.sh).
set -euo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1
[[ $EUID -eq 0 ]] || { echo "run with sudo (dry run is safe: it only prints)" >&2; exit 2; }

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OPERATOR="${SUDO_USER:-}"
[[ -n "$OPERATOR" && "$OPERATOR" != root ]] || { echo "run via sudo from the operator account" >&2; exit 2; }
ETC=/etc/automaton-fleet
OPT=/opt/automaton-fleet
DB_NAME="${FLEET_DB_NAME:-automaton_fleet}"
DB_HOST="${FLEET_DB_HOST:-127.0.0.1}"
DB_PORT="${FLEET_DB_PORT:-5432}"
NODE_SRC="${FLEET_NODE_BIN:-$(sudo -u "$OPERATOR" -i bash -c 'command -v node')}"

say() { printf '\n# %s\n' "$*"; }
run() {
  printf '  %s\n' "$*"
  if (( APPLY )); then "$@"; fi
}
# Writes stdin to a file with owner/group/mode atomically; content is never echoed.
put() { # put <mode> <owner:group> <path>  (content on stdin)
  printf '  install -m %s -o %s -g %s <generated content> %s\n' "$1" "${2%%:*}" "${2##*:}" "$3"
  if (( APPLY )); then
    local tmp; tmp="$(mktemp "$3.XXXXXX")"
    cat >"$tmp"; chmod "$1" "$tmp"; chown "$2" "$tmp"; mv -f "$tmp" "$3"
  else
    cat >/dev/null
  fi
}

(( APPLY )) && echo "APPLYING fleet OS setup" || echo "DRY RUN — nothing will change. Re-run with --apply after review."

say "1. Groups and users"
getent group automaton-fleet-admin >/dev/null || run groupadd --system automaton-fleet-admin
id -nG "$OPERATOR" | tr ' ' '\n' | grep -qx automaton-fleet-admin || run usermod -aG automaton-fleet-admin "$OPERATOR"
id automaton-fleet-service >/dev/null 2>&1 || run useradd --system --user-group --home-dir /var/lib/automaton-fleet \
  --no-create-home --shell /usr/sbin/nologin --comment "Automaton fleet control service" automaton-fleet-service
id automaton-agent >/dev/null 2>&1 || run useradd --user-group --create-home --home-dir /home/automaton-agent \
  --shell /usr/sbin/nologin --comment "Automaton agent runtime" automaton-agent
run chmod 0700 /home/automaton-agent

say "2. Secret directory (+ tls/ for the Phase 6 certificate; key delivered by LoadCredential only)"
run install -d -m 0755 -o root -g root "$ETC"
run install -d -m 0700 -o root -g root "$ETC/tls"

say "3. admin.env (operator credential, moved from repo .env.fleet)"
if [[ -f "$ETC/admin.env" ]]; then
  echo "  (exists — left unchanged)"; run chown root:automaton-fleet-admin "$ETC/admin.env"; run chmod 0640 "$ETC/admin.env"
else
  admin_url="$(sed -n 's/^[[:space:]]*\(FLEET_ADMIN_DATABASE_URL\|FLEET_CONTROLLER_DATABASE_URL\|DATABASE_URL\)[[:space:]]*=[[:space:]]*//p' "$REPO/.env.fleet" 2>/dev/null | head -1)"
  [[ -n "$admin_url" ]] || { echo "  no DATABASE_URL in $REPO/.env.fleet; create $ETC/admin.env by hand" >&2; exit 1; }
  printf '# Operator/migration credential (schema owner). Never give this to the service or agents.\nFLEET_ADMIN_DATABASE_URL=%s\n' "$admin_url" |
    put 0640 root:automaton-fleet-admin "$ETC/admin.env"
fi

say "4. service.env (restricted DB logins; fresh passwords, applied to PostgreSQL by fleet-db-setup.sh)"
if [[ -f "$ETC/service.env" ]]; then
  echo "  (exists — left unchanged)"; run chown root:root "$ETC/service.env"; run chmod 0600 "$ETC/service.env"
else
  svc_pw="$(openssl rand -hex 32)"; agent_pw="$(openssl rand -hex 32)"
  printf '# Fleet service DB credentials (restricted roles). Delivered via systemd LoadCredential only.\nFLEET_SERVICE_DATABASE_URL=postgresql://fleet_service_login:%s@%s:%s/%s\nFLEET_AGENT_DATABASE_URL=postgresql://fleet_agent_login:%s@%s:%s/%s\n' \
    "$svc_pw" "$DB_HOST" "$DB_PORT" "$DB_NAME" "$agent_pw" "$DB_HOST" "$DB_PORT" "$DB_NAME" |
    put 0600 root:root "$ETC/service.env"
  unset svc_pw agent_pw
fi

say "5. runtime.env (non-secret; fill FLEET_RUNTIME_* after the fork is published and built)"
if [[ -f "$ETC/runtime.env" ]]; then
  echo "  (exists — left unchanged)"
else
  put 0644 root:root "$ETC/runtime.env" <"$REPO/deploy/etc/runtime.env.example"
fi

say "6. Code and node locations (root-owned, read-only to the service)"
run install -d -m 0755 -o root -g root "$OPT" "$OPT/releases" "$OPT/node" "$OPT/node/bin"
run install -m 0755 -o root -g root "$NODE_SRC" "$OPT/node/bin/node"

say "7. systemd units (installed, NOT enabled or started)"
run install -m 0644 -o root -g root "$REPO/deploy/systemd/automaton-fleet.service" /etc/systemd/system/automaton-fleet.service
run install -m 0644 -o root -g root "$REPO/deploy/systemd/automaton-agent.service" /etc/systemd/system/automaton-agent.service
run systemctl daemon-reload

say "8. Remove controller secrets from the repository .env.fleet (root-only backup kept)"
if grep -qE '^[[:space:]]*(DATABASE_URL|FLEET_CONTROLLER_DATABASE_URL|FLEET_ADMIN_DATABASE_URL|REDIS_URL)[[:space:]]*=' "$REPO/.env.fleet" 2>/dev/null; then
  run install -m 0600 -o root -g root "$REPO/.env.fleet" "$ETC/legacy-env-fleet.bak"
  run sed -i -E '/^[[:space:]]*(DATABASE_URL|FLEET_CONTROLLER_DATABASE_URL|FLEET_ADMIN_DATABASE_URL|REDIS_URL)[[:space:]]*=/d' "$REPO/.env.fleet"
else
  echo "  (no controller secrets in .env.fleet)"
fi

say "Done. Next: sudo scripts/fleet-db-setup.sh (dry run), then --apply after approval."
(( APPLY )) && echo "NOTE: $OPERATOR must log out/in (or run 'newgrp automaton-fleet-admin') to read admin.env."
