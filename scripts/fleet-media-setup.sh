#!/usr/bin/env bash
# v85 — provision the media provider gateway on the controller host. Mirrors fleet-channels-setup.sh.
#
#   sudo scripts/fleet-media-setup.sh check            read-only: what is present, what is missing
#   sudo scripts/fleet-media-setup.sh install          print the plan (nothing changes)
#   sudo scripts/fleet-media-setup.sh install --apply
#       1. OS user automaton-fleet-media (system, nologin, no other group)
#       2. DB roles fleet_media / fleet_media_login — ONLY the media block of scripts/fleet-db-roles.sql, the password generated
#          here; written only to /etc/automaton-fleet/media.env (root:automaton-fleet-media 0640) as a unix-socket URL; one
#          pg_hba line (local <db> fleet_media_login scram-sha-256) + reload (no PostgreSQL restart)
#       3. fleet:admin grant-media-role (EXECUTE on mx_* only), from the INSTALLED release; fleet:audit-privileges
#       4. the unit (deploy/systemd/automaton-fleet-media.service: no loopback, no private ranges), enabled and started;
#          waits for media_gateway_started. Without keys it runs "not configured" and sends nothing.
#   sudo scripts/fleet-media-setup.sh set-keys --apply --search|--image   read ONE provider API key from stdin (never as an
#          argument), write it root-only (0600) under /etc/automaton-fleet/media/ (a systemd credential of the unit); then set
#          FLEET_MEDIA_SEARCH_PROVIDER / FLEET_MEDIA_IMAGE_PROVIDER and the per-job cost in media.env and restart the unit.
# Never prints a secret. Undo: systemctl disable --now automaton-fleet-media (agents are then told search and images are not connected).
set -euo pipefail
MODE="${1:?usage: check | install [--apply] | set-keys --apply --search|--image}"; shift || true
APPLY=0; [[ "${1:-}" == "--apply" ]] && APPLY=1
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OPERATOR="${SUDO_USER:?run with sudo from the operator account}"
ETC=/etc/automaton-fleet; OPT=/opt/automaton-fleet; NODE=$OPT/node/bin/node; CUR=$OPT/current
USER_=automaton-fleet-media; UNIT=automaton-fleet-media.service; ENVF=$ETC/media.env; KEYS=$ETC/media
DB_NAME="${FLEET_DB_NAME:-automaton_fleet}"; SOCK=/var/run/postgresql
say() { printf '\n# %s\n' "$*"; }
run() { printf '  %s\n' "$*"; if (( APPLY )); then "$@"; fi; }
admin() { runuser -u "$OPERATOR" -- env -C "$CUR" "$NODE" dist/fleet/postgres/cli.js "$@"; }
psql_su() { runuser -u postgres -- psql -X -tA -v ON_ERROR_STOP=1 "$@"; }
role_exists() { [[ "$(psql_su -d postgres -c "SELECT count(*) FROM pg_roles WHERE rolname IN ('fleet_media','fleet_media_login')")" == 2 ]]; }

if [[ "$MODE" == check ]]; then
  bad=0; ok() { printf '  %-44s %s\n' "$1" "$2"; }
  id "$USER_" >/dev/null 2>&1 && ok "OS user $USER_" "present (groups: $(id -nG "$USER_"))" || { ok "OS user $USER_" "MISSING"; bad=1; }
  role_exists && ok "DB roles fleet_media(_login)" "present" || { ok "DB roles fleet_media(_login)" "MISSING"; bad=1; }
  [[ -f "$ENVF" ]] && ok "$ENVF" "$(stat -c '%U:%G %a' "$ENVF")" || { ok "$ENVF" "MISSING"; bad=1; }
  [[ -f /etc/systemd/system/$UNIT ]] && ok "$UNIT" "$(systemctl is-enabled "$UNIT" 2>/dev/null || true) / $(systemctl is-active "$UNIT" 2>/dev/null || true)" || { ok "$UNIT" "NOT INSTALLED"; bad=1; }
  for k in search-key image-key; do [[ -s $KEYS/$k ]] && ok "$k" "present" || ok "$k" "not set (that provider reports not connected)"; done
  exit "$bad"
fi
if [[ "$MODE" == set-keys ]]; then
  # Reads ONE line from stdin: the API key of the provider named by --search or --image; writes it root-only (0600).
  (( APPLY )) || { echo "set-keys reads a key from stdin and writes it: run with --apply" >&2; exit 2; }
  which="${2:-}"; [[ "$which" == --search || "$which" == --image ]] || { echo "set-keys --apply --search|--image  (key on stdin)" >&2; exit 2; }
  read -r key
  [[ "$key" =~ ^[A-Za-z0-9_.-]{16,300}$ ]] || { echo "expected one line: the provider's API key" >&2; exit 1; }
  install -d -m 0700 -o root -g root "$KEYS"
  umask 077
  f="$KEYS/$([[ "$which" == --search ]] && echo search-key || echo image-key)"
  printf '%s' "$key" > "$f.tmp" && mv -f "$f.tmp" "$f"; chmod 0600 "$f"; unset key
  echo "  key written (root 0600); set the provider and its per-job cost in $ENVF, then: systemctl restart $UNIT"
  exit 0
fi
[[ "$MODE" == install ]] || { echo "unknown mode $MODE" >&2; exit 2; }
(( APPLY )) || echo "(plan only — nothing changes without --apply)"
grep -q "grant-media-role" "$CUR/dist/fleet/postgres/cli.js" || { echo "the installed release has no grant-media-role — deploy v85 first" >&2; exit 1; }
[[ -S $SOCK/.s.PGSQL.5432 ]] || { echo "PostgreSQL socket missing in $SOCK" >&2; exit 1; }
SRC_UNIT="$REPO/deploy/systemd/$UNIT"; [[ -f "$CUR/deploy/systemd/$UNIT" ]] && SRC_UNIT="$CUR/deploy/systemd/$UNIT"

say "1. OS user $USER_"
id "$USER_" >/dev/null 2>&1 && echo "  (exists — left unchanged)" || run useradd --system --user-group --home-dir /var/lib/$USER_ --no-create-home --shell /usr/sbin/nologin \
  --comment "Automaton fleet media provider gateway" "$USER_"

say "2. DB roles (media block of fleet-db-roles.sql), media.env (socket URL), pg_hba line"
if [[ -f "$ENVF" ]]; then
  pw="$(sed -n 's/^FLEET_MEDIA_DATABASE_URL=postgresql:\/\/fleet_media_login:\([0-9a-f]\{64\}\)@.*/\1/p' "$ENVF" | head -1)"
  [[ -n "$pw" ]] || { echo "$ENVF holds no 64-hex fleet_media_login password — fix it by hand" >&2; exit 1; }
  echo "  (media.env exists — its password is kept)"
else pw="$(openssl rand -hex 32)"; fi
block="$(awk '/^\\if :\{\?media_password\}/ {on=1} on {print} on && /^\\endif/ {exit}' "$REPO/scripts/fleet-db-roles.sql")"
[[ "$block" == *"fleet_media_login"* ]] || { echo "media block not found in fleet-db-roles.sql" >&2; exit 1; }
echo "  { \\set media_password <hex>; <media block> } | psql -d postgres -f -"
if (( APPLY )); then
  { printf '\\set ON_ERROR_STOP on\n\\set media_password %s\n' "$pw"; printf '%s\n' "$block"; } | runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -v dbname="$DB_NAME" -d postgres -f - >/dev/null
  if [[ ! -f "$ENVF" ]]; then
    tmp="$(mktemp "$ENVF.XXXXXX")"
    printf '# Media provider gateway DB credential (fleet_media_login: mx_* only). Never give this to agents or other services.\nFLEET_MEDIA_DATABASE_URL=postgresql://fleet_media_login:%s@/%s?host=%s\n' "$pw" "$DB_NAME" "$SOCK" > "$tmp"
    chmod 0640 "$tmp"; chown "root:$USER_" "$tmp"; mv -f "$tmp" "$ENVF"
  fi
  HBA="$(psql_su -d postgres -c 'SHOW hba_file')"
  if ! grep -Eq "^\s*local\s+$DB_NAME\s+fleet_media_login\s+scram-sha-256" "$HBA"; then
    cp -p "$HBA" "$HBA.pre-media-$(date -u +%Y%m%dT%H%M%SZ)"
    python3 -I - "$HBA" "$DB_NAME" <<'PY'
import re, sys
f, db = sys.argv[1:3]
lines = open(f).read().splitlines(keepends=True)
i = next((k for k, l in enumerate(lines) if re.match(r"^\s*local\s", l)), len(lines))
lines.insert(i, f"local   {db}   fleet_media_login   scram-sha-256   # v85 media provider gateway over the unix socket\n")
open(f, "w").write("".join(lines))
PY
    [[ "$(psql_su -d postgres -c 'SELECT pg_reload_conf()')" == t && "$(psql_su -d postgres -c 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL')" == 0 ]] \
      || { echo "pg_hba reload failed — restore the .pre-media backup" >&2; exit 1; }
  fi
fi
unset pw

say "3. grant mx_* to fleet_media (installed release's admin CLI, as $OPERATOR)"
(( APPLY )) && { admin grant-media-role >/dev/null; admin audit-privileges >/dev/null || { echo "fleet:audit-privileges FAILED" >&2; exit 1; }; echo "  granted; audit ok"; } || echo "  grant-media-role; audit-privileges"

say "4. unit $UNIT (no loopback, no private ranges; enabled, started)"
run install -m 0644 -o root -g root "$SRC_UNIT" "/etc/systemd/system/$UNIT"
run systemctl daemon-reload
if (( APPLY )); then
  since="$(date '+%Y-%m-%d %H:%M:%S')"; systemctl enable --now "$UNIT" >/dev/null 2>&1
  for _ in $(seq 1 30); do journalctl -u "$UNIT" --since "$since" -o cat --no-pager | grep -q media_gateway_started && break; sleep 1; done
  journalctl -u "$UNIT" --since "$since" -o cat --no-pager | grep -q media_gateway_started || { echo "not started — last lines:" >&2; journalctl -u "$UNIT" --since "$since" -o cat --no-pager | tail -n 15 >&2; exit 1; }
  echo "  media_gateway_started; $(systemctl is-active "$UNIT")"
fi
say "done$( (( APPLY )) || echo ' (plan only)')"
