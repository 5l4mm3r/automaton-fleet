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
#   user   automaton-fleet-witness        system, nologin, in NO group; runs the FLEET-KI-4 root witness
#                                         (state: /var/lib/automaton-fleet-witness 0700 via systemd StateDirectory)
#   user   automaton-fleet-operator-api   system, nologin, in NO other group; runs the read-only Operator API
#                                         (Phase B2; logs: /var/log/automaton-fleet-operator 0700 via LogsDirectory)
#   user   automaton-fleet-custody        system, nologin, in NO other group; runs the custody executor
#                                         (Phase E, schema v10; INERT: no listener, no custody credential)
#   /etc/automaton-fleet/                 root:root 0755
#     tls/         root:automaton-fleet-admin 0750   Phase 6 certificate + key (not created here; remote stays disabled)
#       fleet.key  root:root 0600                    LoadCredential=tls.key (only if present; never generated here)
#       fleet.crt  root:root 0644                    LoadCredential=tls.crt (only if present; never obtained here)
#     admin.env    root:automaton-fleet-admin 0640   FLEET_ADMIN_DATABASE_URL (moved from repo .env.fleet)
#     service.env  root:root 0600                    FLEET_SERVICE_DATABASE_URL, FLEET_AGENT_DATABASE_URL
#                                                    (fresh hex passwords; read by systemd LoadCredential only)
#     runtime.env  root:root 0644                    non-secret: pinned runtime + safety flags (all false)
#     operator.env root:automaton-fleet-operator-api 0640   FLEET_OPERATOR_DATABASE_URL (fresh hex password;
#                                                    read by the Operator API directly — no LoadCredential)
#     custody.env  root:automaton-fleet-custody 0640   FLEET_CUSTODY_DATABASE_URL only (fresh hex password;
#                                                    read by the custody executor directly — no LoadCredential)
#   /opt/automaton-fleet/{releases,node/bin}         root-owned; pinned node binary copied in
#   /etc/systemd/system/automaton-fleet.service, automaton-agent.service,
#     automaton-fleet-witness.service, automaton-fleet-operator-api.service,
#     automaton-fleet-custody.service, automaton-fleet-founder@.service (template; instances only via
#     scripts/fleet-founders.sh)  (installed, NOT enabled/started)
#   /etc/logrotate.d/automaton-fleet                 root 0644 (D-9 bounded JSONL audit retention)
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
id automaton-fleet-witness >/dev/null 2>&1 || run useradd --system --user-group --home-dir /var/lib/automaton-fleet-witness \
  --no-create-home --shell /usr/sbin/nologin --comment "Automaton fleet root witness" automaton-fleet-witness
id automaton-fleet-operator-api >/dev/null 2>&1 || run useradd --system --user-group --home-dir /var/lib/automaton-fleet-operator-api \
  --no-create-home --shell /usr/sbin/nologin --comment "Automaton fleet Operator API" automaton-fleet-operator-api
id automaton-fleet-custody >/dev/null 2>&1 || run useradd --system --user-group --home-dir /var/lib/automaton-fleet-custody \
  --no-create-home --shell /usr/sbin/nologin --comment "Automaton fleet custody executor (inert)" automaton-fleet-custody

say "2. Secret directory (+ tls/ for the Phase 6 certificate; key and cert delivered by LoadCredential only)"
run install -d -m 0755 -o root -g root "$ETC"
[[ -L "$ETC/tls" ]] && { echo "  $ETC/tls is a symlink; refusing" >&2; exit 1; }
run install -d -m 0750 -o root -g automaton-fleet-admin "$ETC/tls"
# Existing TLS files are only re-permissioned; this script never creates, fetches or prints them.
for spec in fleet.key:0600 fleet.crt:0644; do
  f="$ETC/tls/${spec%%:*}"; mode="${spec##*:}"
  [[ -e "$f" || -L "$f" ]] || { echo "  ($f absent — remote HTTPS stays disabled)"; continue; }
  if [[ -L "$f" || ! -f "$f" || "$(stat -c %h "$f")" != 1 ]]; then
    echo "  $f is not a single-link regular file; refusing" >&2; exit 1
  fi
  run chown root:root "$f"; run chmod "$mode" "$f"
done

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

say "4b. operator.env (schema v8 Operator API login; fresh password, applied to PostgreSQL by fleet-db-setup.sh)"
if [[ -L "$ETC/operator.env" ]]; then
  echo "  $ETC/operator.env is a symlink; refusing" >&2; exit 1
elif [[ -f "$ETC/operator.env" ]]; then
  echo "  (exists — left unchanged)"; run chown root:automaton-fleet-operator-api "$ETC/operator.env"; run chmod 0640 "$ETC/operator.env"
else
  op_pw="$(openssl rand -hex 32)"
  printf '# Operator API DB credential (restricted, read-only op_* role). Never give this to the service, agents or bridges.\nFLEET_OPERATOR_DATABASE_URL=postgresql://fleet_operator_login:%s@%s:%s/%s\n' \
    "$op_pw" "$DB_HOST" "$DB_PORT" "$DB_NAME" |
    put 0640 root:automaton-fleet-operator-api "$ETC/operator.env"
  unset op_pw
fi

say "4c. custody.env (schema v10 custody executor login ONLY; fresh password, applied to PostgreSQL by fleet-db-setup.sh)"
if [[ -L "$ETC/custody.env" ]]; then
  echo "  $ETC/custody.env is a symlink; refusing" >&2; exit 1
elif [[ -f "$ETC/custody.env" ]]; then
  echo "  (exists — left unchanged)"; run chown root:automaton-fleet-custody "$ETC/custody.env"; run chmod 0640 "$ETC/custody.env"
else
  cx_pw="$(openssl rand -hex 32)"
  printf '# Custody executor DB credential (restricted cx_* role). No custody provider credential exists in schema v10; never add one here.\nFLEET_CUSTODY_DATABASE_URL=postgresql://fleet_custody_login:%s@%s:%s/%s\n' \
    "$cx_pw" "$DB_HOST" "$DB_PORT" "$DB_NAME" |
    put 0640 root:automaton-fleet-custody "$ETC/custody.env"
  unset cx_pw
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
run install -m 0644 -o root -g root "$REPO/deploy/systemd/automaton-fleet-witness.service" /etc/systemd/system/automaton-fleet-witness.service
run install -m 0644 -o root -g root "$REPO/deploy/systemd/automaton-fleet-operator-api.service" /etc/systemd/system/automaton-fleet-operator-api.service
run install -m 0644 -o root -g root "$REPO/deploy/systemd/automaton-fleet-custody.service" /etc/systemd/system/automaton-fleet-custody.service
run install -m 0644 -o root -g root "$REPO/deploy/systemd/automaton-fleet-founder@.service" "/etc/systemd/system/automaton-fleet-founder@.service"
run systemctl daemon-reload

say "7b. logrotate (D-9 bounded JSONL audit retention)"
run install -m 0644 -o root -g root "$REPO/deploy/logrotate/automaton-fleet" /etc/logrotate.d/automaton-fleet

say "8. Remove controller secrets from the repository .env.fleet (root-only backup kept)"
if grep -qE '^[[:space:]]*(DATABASE_URL|FLEET_CONTROLLER_DATABASE_URL|FLEET_ADMIN_DATABASE_URL|REDIS_URL)[[:space:]]*=' "$REPO/.env.fleet" 2>/dev/null; then
  run install -m 0600 -o root -g root "$REPO/.env.fleet" "$ETC/legacy-env-fleet.bak"
  run sed -i -E '/^[[:space:]]*(DATABASE_URL|FLEET_CONTROLLER_DATABASE_URL|FLEET_ADMIN_DATABASE_URL|REDIS_URL)[[:space:]]*=/d' "$REPO/.env.fleet"
else
  echo "  (no controller secrets in .env.fleet)"
fi

say "Done. Next: sudo scripts/fleet-db-setup.sh (dry run), then --apply after approval."
(( APPLY )) && echo "NOTE: $OPERATOR must log out/in (or run 'newgrp automaton-fleet-admin') to read admin.env."
