#!/usr/bin/env bash
# v80 — provision the channel gateway (official-API channels) on the controller host. Mirrors fleet-browser-setup.sh.
#
#   sudo scripts/fleet-channels-setup.sh check            read-only: what is present, what is missing
#   sudo scripts/fleet-channels-setup.sh install          print the plan (nothing changes)
#   sudo scripts/fleet-channels-setup.sh install --apply
#       1. OS user automaton-fleet-channels (system, nologin, no other group)
#       2. DB roles fleet_channels / fleet_channels_login — ONLY the channels block of scripts/fleet-db-roles.sql, the password
#          fed on stdin; written only to /etc/automaton-fleet/channels.env (root:automaton-fleet-channels 0640) as a unix-socket
#          URL; one pg_hba line (local <db> fleet_channels_login scram-sha-256) + reload (no PostgreSQL restart)
#       3. fleet:admin grant-channels-role (EXECUTE on chx_* only), from the INSTALLED release; fleet:audit-privileges
#       4. the unit (deploy/systemd/automaton-fleet-channels.service: no loopback, no private ranges), enabled and started;
#          waits for channel_gateway_started
# Never prints a secret. Connecting an account is separate and the owner's: oauth-url / oauth-exchange (as the gateway user),
# then economy-channel-connect. Undo: systemctl disable --now automaton-fleet-channels (no job runs without it).
set -euo pipefail
MODE="${1:?usage: check | install [--apply]}"; shift || true
APPLY=0; [[ "${1:-}" == "--apply" ]] && APPLY=1
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OPERATOR="${SUDO_USER:?run with sudo from the operator account}"
ETC=/etc/automaton-fleet; OPT=/opt/automaton-fleet; NODE=$OPT/node/bin/node; CUR=$OPT/current
USER_=automaton-fleet-channels; UNIT=automaton-fleet-channels.service; ENVF=$ETC/channels.env
DB_NAME="${FLEET_DB_NAME:-automaton_fleet}"; SOCK=/var/run/postgresql
say() { printf '\n# %s\n' "$*"; }
run() { printf '  %s\n' "$*"; if (( APPLY )); then "$@"; fi; }
admin() { runuser -u "$OPERATOR" -- env -C "$CUR" "$NODE" dist/fleet/postgres/cli.js "$@"; }
psql_su() { runuser -u postgres -- psql -X -tA -v ON_ERROR_STOP=1 "$@"; }
role_exists() { [[ "$(psql_su -d postgres -c "SELECT count(*) FROM pg_roles WHERE rolname IN ('fleet_channels','fleet_channels_login')")" == 2 ]]; }

if [[ "$MODE" == check ]]; then
  bad=0; ok() { printf '  %-44s %s\n' "$1" "$2"; }
  id "$USER_" >/dev/null 2>&1 && ok "OS user $USER_" "present (groups: $(id -nG "$USER_"))" || { ok "OS user $USER_" "MISSING"; bad=1; }
  role_exists && ok "DB roles fleet_channels(_login)" "present" || { ok "DB roles fleet_channels(_login)" "MISSING"; bad=1; }
  [[ -f "$ENVF" ]] && ok "$ENVF" "$(stat -c '%U:%G %a' "$ENVF")" || { ok "$ENVF" "MISSING"; bad=1; }
  [[ -f /etc/systemd/system/$UNIT ]] && ok "$UNIT" "$(systemctl is-enabled "$UNIT" 2>/dev/null || true) / $(systemctl is-active "$UNIT" 2>/dev/null || true)" || { ok "$UNIT" "NOT INSTALLED"; bad=1; }
  exit "$bad"
fi
[[ "$MODE" == install ]] || { echo "unknown mode $MODE" >&2; exit 2; }
(( APPLY )) || echo "(plan only — nothing changes without --apply)"
grep -q "grant-channels-role" "$CUR/dist/fleet/postgres/cli.js" || { echo "the installed release has no grant-channels-role — deploy v80 first" >&2; exit 1; }
[[ -S $SOCK/.s.PGSQL.5432 ]] || { echo "PostgreSQL socket missing in $SOCK" >&2; exit 1; }
SRC_UNIT="$REPO/deploy/systemd/$UNIT"; [[ -f "$CUR/deploy/systemd/$UNIT" ]] && SRC_UNIT="$CUR/deploy/systemd/$UNIT"

say "1. OS user $USER_"
id "$USER_" >/dev/null 2>&1 && echo "  (exists — left unchanged)" || run useradd --system --user-group --home-dir /var/lib/$USER_ --no-create-home --shell /usr/sbin/nologin \
  --comment "Automaton fleet channel gateway" "$USER_"

say "2. DB roles (channels block of fleet-db-roles.sql), channels.env (socket URL), pg_hba line"
if [[ -f "$ENVF" ]]; then
  pw="$(sed -n 's/^FLEET_CHANNELS_DATABASE_URL=postgresql:\/\/fleet_channels_login:\([0-9a-f]\{64\}\)@.*/\1/p' "$ENVF" | head -1)"
  [[ -n "$pw" ]] || { echo "$ENVF holds no 64-hex fleet_channels_login password — fix it by hand" >&2; exit 1; }
  echo "  (channels.env exists — its password is kept)"
else pw="$(openssl rand -hex 32)"; fi
block="$(awk '/^\\if :\{\?channels_password\}/ {on=1} on {print} on && /^\\endif/ {exit}' "$REPO/scripts/fleet-db-roles.sql")"
[[ "$block" == *"fleet_channels_login"* ]] || { echo "channels block not found in fleet-db-roles.sql" >&2; exit 1; }
echo "  { \\set channels_password <hex>; <channels block> } | psql -d postgres -f -"
if (( APPLY )); then
  { printf '\\set ON_ERROR_STOP on\n\\set channels_password %s\n' "$pw"; printf '%s\n' "$block"; } | runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -v dbname="$DB_NAME" -d postgres -f - >/dev/null
  if [[ ! -f "$ENVF" ]]; then
    tmp="$(mktemp "$ENVF.XXXXXX")"
    printf '# Channel gateway DB credential (fleet_channels_login: chx_* only). Never give this to agents or other services.\nFLEET_CHANNELS_DATABASE_URL=postgresql://fleet_channels_login:%s@/%s?host=%s\n' "$pw" "$DB_NAME" "$SOCK" > "$tmp"
    chmod 0640 "$tmp"; chown "root:$USER_" "$tmp"; mv -f "$tmp" "$ENVF"
  fi
  HBA="$(psql_su -d postgres -c 'SHOW hba_file')"
  if ! grep -Eq "^\s*local\s+$DB_NAME\s+fleet_channels_login\s+scram-sha-256" "$HBA"; then
    cp -p "$HBA" "$HBA.pre-channels-$(date -u +%Y%m%dT%H%M%SZ)"
    python3 -I - "$HBA" "$DB_NAME" <<'PY'
import re, sys
f, db = sys.argv[1:3]
lines = open(f).read().splitlines(keepends=True)
i = next((k for k, l in enumerate(lines) if re.match(r"^\s*local\s", l)), len(lines))
lines.insert(i, f"local   {db}   fleet_channels_login   scram-sha-256   # v80 channel gateway over the unix socket\n")
open(f, "w").write("".join(lines))
PY
    [[ "$(psql_su -d postgres -c 'SELECT pg_reload_conf()')" == t && "$(psql_su -d postgres -c 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL')" == 0 ]] \
      || { echo "pg_hba reload failed — restore the .pre-channels backup" >&2; exit 1; }
  fi
fi
unset pw

say "3. grant chx_* to fleet_channels (installed release's admin CLI, as $OPERATOR)"
(( APPLY )) && { admin grant-channels-role >/dev/null; admin audit-privileges >/dev/null || { echo "fleet:audit-privileges FAILED" >&2; exit 1; }; echo "  granted; audit ok"; } || echo "  grant-channels-role; audit-privileges"

say "4. unit $UNIT (no loopback, no private ranges; enabled, started)"
run install -m 0644 -o root -g root "$SRC_UNIT" "/etc/systemd/system/$UNIT"
run systemctl daemon-reload
if (( APPLY )); then
  since="$(date '+%Y-%m-%d %H:%M:%S')"; systemctl enable --now "$UNIT" >/dev/null 2>&1
  for _ in $(seq 1 30); do journalctl -u "$UNIT" --since "$since" -o cat --no-pager | grep -q channel_gateway_started && break; sleep 1; done
  journalctl -u "$UNIT" --since "$since" -o cat --no-pager | grep -q channel_gateway_started || { echo "not started — last lines:" >&2; journalctl -u "$UNIT" --since "$since" -o cat --no-pager | tail -n 15 >&2; exit 1; }
  echo "  channel_gateway_started; $(systemctl is-active "$UNIT")"
fi
say "done$( (( APPLY )) || echo ' (plan only)')"
