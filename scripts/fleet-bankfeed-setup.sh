#!/usr/bin/env bash
# v86 — provision the bank feed (read-only bank evidence into the money locations) on the controller host. Mirrors
# fleet-push-setup.sh.
#
#   sudo scripts/fleet-bankfeed-setup.sh check            read-only: what is present, what is missing
#   sudo scripts/fleet-bankfeed-setup.sh install          print the plan (nothing changes)
#   sudo scripts/fleet-bankfeed-setup.sh install --apply
#       1. OS user automaton-fleet-bankfeed (system, nologin, no other group)
#       2. DB roles fleet_bankfeed / fleet_bankfeed_login — ONLY the bank-feed block of scripts/fleet-db-roles.sql, the
#          password generated here; written only to /etc/automaton-fleet/bankfeed.env (root:automaton-fleet-bankfeed 0640) as
#          a unix-socket URL, with FLEET_LOCATION_FEED_ACCOUNTS=[] (edit it: which bank account feeds which location); one
#          pg_hba line (local <db> fleet_bankfeed_login scram-sha-256) + reload (no PostgreSQL restart)
#       3. fleet:admin grant-bankfeed-role (EXECUTE on rx_* only), from the INSTALLED release; fleet:audit-privileges
#       4. the unit (deploy/systemd/automaton-fleet-bankfeed.service: no loopback, no private ranges), enabled and started;
#          waits for bankfeed_started. Without a token a location is skipped (statement imports only).
#   sudo scripts/fleet-bankfeed-setup.sh set-token <locationId> --apply   read the account's READ-ONLY token from stdin (never
#          as an argument), write it root-only (0600) as /etc/automaton-fleet/bankfeed/<locationId> (handed to the unit as
#          the credential bank_<locationId>), restart the unit. The feed refuses a token with any non-read scope.
# Never prints a secret. Undo: systemctl disable --now automaton-fleet-bankfeed (the locations then take statement imports only).
set -euo pipefail
MODE="${1:?usage: check | install [--apply] | set-token <locationId> --apply}"; shift || true
LOC=""; [[ "$MODE" == set-token ]] && { LOC="${1:?set-token <locationId> --apply}"; shift; }
APPLY=0; [[ "${1:-}" == "--apply" ]] && APPLY=1
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OPERATOR="${SUDO_USER:?run with sudo from the operator account}"
ETC=/etc/automaton-fleet; OPT=/opt/automaton-fleet; NODE=$OPT/node/bin/node; CUR=$OPT/current
USER_=automaton-fleet-bankfeed; UNIT=automaton-fleet-bankfeed.service; ENVF=$ETC/bankfeed.env; KEYS=$ETC/bankfeed
DB_NAME="${FLEET_DB_NAME:-automaton_fleet}"; SOCK=/var/run/postgresql
say() { printf '\n# %s\n' "$*"; }
run() { printf '  %s\n' "$*"; if (( APPLY )); then "$@"; fi; }
admin() { runuser -u "$OPERATOR" -- env -C "$CUR" "$NODE" dist/fleet/postgres/cli.js "$@"; }
psql_su() { runuser -u postgres -- psql -X -tA -v ON_ERROR_STOP=1 "$@"; }
role_exists() { [[ "$(psql_su -d postgres -c "SELECT count(*) FROM pg_roles WHERE rolname IN ('fleet_bankfeed','fleet_bankfeed_login')")" == 2 ]]; }

if [[ "$MODE" == check ]]; then
  bad=0; ok() { printf '  %-44s %s\n' "$1" "$2"; }
  id "$USER_" >/dev/null 2>&1 && ok "OS user $USER_" "present (groups: $(id -nG "$USER_"))" || { ok "OS user $USER_" "MISSING"; bad=1; }
  role_exists && ok "DB roles fleet_bankfeed(_login)" "present" || { ok "DB roles fleet_bankfeed(_login)" "MISSING"; bad=1; }
  [[ -f "$ENVF" ]] && ok "$ENVF" "$(stat -c '%U:%G %a' "$ENVF")" || { ok "$ENVF" "MISSING"; bad=1; }
  [[ -f /etc/systemd/system/$UNIT ]] && ok "$UNIT" "$(systemctl is-enabled "$UNIT" 2>/dev/null || true) / $(systemctl is-active "$UNIT" 2>/dev/null || true)" || { ok "$UNIT" "NOT INSTALLED"; bad=1; }
  n=$(find "$KEYS" -maxdepth 1 -type f 2>/dev/null | wc -l); ok "read-only tokens" "$n (a location without one takes statement imports only)"
  exit "$bad"
fi
if [[ "$MODE" == set-token ]]; then
  (( APPLY )) || { echo "set-token reads the token from stdin and writes it: run with --apply" >&2; exit 2; }
  [[ "$LOC" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || { echo "locationId must be a UUID (hub-locations)" >&2; exit 1; }
  read -r token
  [[ "$token" =~ ^[A-Za-z0-9._~+/=-]{20,4096}$ ]] || { echo "expected one line: the account's read-only token" >&2; exit 1; }
  install -d -m 0700 -o root -g root "$KEYS"
  umask 077
  printf '%s' "$token" > "$KEYS/$LOC.tmp" && mv -f "$KEYS/$LOC.tmp" "$KEYS/$LOC"
  chmod 0600 "$KEYS/$LOC"; unset token
  echo "  token written (root 0600); restarting $UNIT (it refuses a token that can do more than read)"
  systemctl restart "$UNIT"
  exit 0
fi
[[ "$MODE" == install ]] || { echo "unknown mode $MODE" >&2; exit 2; }
(( APPLY )) || echo "(plan only — nothing changes without --apply)"
[[ -f "$CUR/dist/fleet/settlement/location-feed-main.js" ]] || { echo "the installed release has no bank feed — deploy v86 first" >&2; exit 1; }
[[ -S $SOCK/.s.PGSQL.5432 ]] || { echo "PostgreSQL socket missing in $SOCK" >&2; exit 1; }
SRC_UNIT="$REPO/deploy/systemd/$UNIT"; [[ -f "$CUR/deploy/systemd/$UNIT" ]] && SRC_UNIT="$CUR/deploy/systemd/$UNIT"

say "1. OS user $USER_"
id "$USER_" >/dev/null 2>&1 && echo "  (exists — left unchanged)" || run useradd --system --user-group --home-dir /var/lib/$USER_ --no-create-home --shell /usr/sbin/nologin \
  --comment "Automaton fleet bank feed (read-only)" "$USER_"

say "2. DB roles (bank-feed block of fleet-db-roles.sql), bankfeed.env (socket URL), pg_hba line"
if [[ -f "$ENVF" ]]; then
  pw="$(sed -n 's/^FLEET_BANKFEED_DATABASE_URL=postgresql:\/\/fleet_bankfeed_login:\([0-9a-f]\{64\}\)@.*/\1/p' "$ENVF" | head -1)"
  [[ -n "$pw" ]] || { echo "$ENVF holds no 64-hex fleet_bankfeed_login password — fix it by hand" >&2; exit 1; }
  echo "  (bankfeed.env exists — its password is kept)"
else pw="$(openssl rand -hex 32)"; fi
block="$(awk '/^\\if :\{\?bankfeed_password\}/ {on=1} on {print} on && /^\\endif/ {exit}' "$REPO/scripts/fleet-db-roles.sql")"
[[ "$block" == *"fleet_bankfeed_login"* ]] || { echo "bank-feed block not found in fleet-db-roles.sql" >&2; exit 1; }
echo "  { \\set bankfeed_password <hex>; <bank-feed block> } | psql -d postgres -f -"
if (( APPLY )); then
  { printf '\\set ON_ERROR_STOP on\n\\set bankfeed_password %s\n' "$pw"; printf '%s\n' "$block"; } | runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -v dbname="$DB_NAME" -d postgres -f - >/dev/null
  if [[ ! -f "$ENVF" ]]; then
    tmp="$(mktemp "$ENVF.XXXXXX")"
    printf '# Bank feed DB credential (fleet_bankfeed_login: rx_* only). Never give this to agents or other services.\nFLEET_BANKFEED_DATABASE_URL=postgresql://fleet_bankfeed_login:%s@/%s?host=%s\n# Which bank account feeds which money location (ids only): [{"locationId":"…","provider":"starling","accountUid":"…","categoryUid":"…"}]\nFLEET_LOCATION_FEED_ACCOUNTS=[]\n' "$pw" "$DB_NAME" "$SOCK" > "$tmp"
    chmod 0640 "$tmp"; chown "root:$USER_" "$tmp"; mv -f "$tmp" "$ENVF"
  fi
  HBA="$(psql_su -d postgres -c 'SHOW hba_file')"
  if ! grep -Eq "^\s*local\s+$DB_NAME\s+fleet_bankfeed_login\s+scram-sha-256" "$HBA"; then
    cp -p "$HBA" "$HBA.pre-bankfeed-$(date -u +%Y%m%dT%H%M%SZ)"
    python3 -I - "$HBA" "$DB_NAME" <<'PY'
import re, sys
f, db = sys.argv[1:3]
lines = open(f).read().splitlines(keepends=True)
i = next((k for k, l in enumerate(lines) if re.match(r"^\s*local\s", l)), len(lines))
lines.insert(i, f"local   {db}   fleet_bankfeed_login   scram-sha-256   # v86 bank feed over the unix socket\n")
open(f, "w").write("".join(lines))
PY
    [[ "$(psql_su -d postgres -c 'SELECT pg_reload_conf()')" == t && "$(psql_su -d postgres -c 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL')" == 0 ]] \
      || { echo "pg_hba reload failed — restore the .pre-bankfeed backup" >&2; exit 1; }
  fi
fi
unset pw

say "3. grant rx_* to fleet_bankfeed (installed release's admin CLI, as $OPERATOR)"
(( APPLY )) && { admin grant-bankfeed-role >/dev/null; admin audit-privileges >/dev/null || { echo "fleet:audit-privileges FAILED" >&2; exit 1; }; echo "  granted; audit ok"; } || echo "  grant-bankfeed-role; audit-privileges"

say "4. unit $UNIT (no loopback, no private ranges; enabled, started)"
# The unit loads its tokens from this directory (LoadCredential=bank:<dir>): systemd refuses to start (243/CREDENTIALS)
# while it does not exist, so it is created (empty, root 0700) before the first start; set-token adds files to it.
run install -d -m 0700 -o root -g root "$KEYS"
run install -m 0644 -o root -g root "$SRC_UNIT" "/etc/systemd/system/$UNIT"
run systemctl daemon-reload
if (( APPLY )); then
  since="$(date '+%Y-%m-%d %H:%M:%S')"; systemctl enable "$UNIT" >/dev/null 2>&1; systemctl restart "$UNIT" || true  # restart: a re-run must see a fresh start line
  for _ in $(seq 1 30); do journalctl -u "$UNIT" --since "$since" -o cat --no-pager | grep -q bankfeed_started && break; sleep 1; done
  journalctl -u "$UNIT" --since "$since" -o cat --no-pager | grep -q bankfeed_started || { echo "not started — last lines:" >&2; journalctl -u "$UNIT" --since "$since" -o cat --no-pager | tail -n 15 >&2; exit 1; }
  echo "  bankfeed_started; $(systemctl is-active "$UNIT")"
fi
say "done$( (( APPLY )) || echo ' (plan only)')"
