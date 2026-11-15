#!/usr/bin/env bash
# Schema v52 — provision the Gumroad storefront gateway (G3) on the controller host. Receive-only; installs DORMANT: with no
# token in its vault the gateway runs nothing (every account must pass its account check first).
#
#   sudo scripts/fleet-gumroad-setup.sh check              read-only: what is present, what is missing
#   sudo scripts/fleet-gumroad-setup.sh install            print the plan (nothing changes)
#   sudo scripts/fleet-gumroad-setup.sh install --apply
#       1. OS user automaton-fleet-gumroad (system, nologin, no other group)
#       2. DB roles fleet_provider / fleet_provider_login — ONLY the provider block of scripts/fleet-db-roles.sql, the
#          password fed on stdin; written only to /etc/automaton-fleet/gumroad.env (root:automaton-fleet-gumroad 0640)
#       3. fleet:admin grant-provider-role (USAGE + EXECUTE on gx_* only), from the INSTALLED release
#       4. the unit (deploy/systemd/automaton-fleet-gumroad.service), enabled and started; then fleet:audit-privileges
#
# Onboarding the token (the owner, after this script; stdin only, never printed):
#   sudo -u automaton-fleet-gumroad env FLEET_STOREFRONT_VAULT_DIR=/var/lib/automaton-fleet-gumroad/vault \
#     /opt/automaton-fleet/node/bin/node /opt/automaton-fleet/current/dist/fleet/storefront/main.js oauth-url <clientId> <redirectUri>
#   … authorise in the browser, then:
#   echo '{"clientId":"…","clientSecret":"…","code":"…","redirectUri":"…"}' | sudo -u automaton-fleet-gumroad env FLEET_STOREFRONT_VAULT_DIR=… \
#     node …/dist/fleet/storefront/main.js oauth-exchange vault:gumroad/owner
# Undo: systemctl disable --now automaton-fleet-gumroad. Sales and payouts already recorded are kept (they are history).
set -euo pipefail
MODE="${1:?usage: check | install [--apply]}"
shift
APPLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in --apply) APPLY=1 ;; *) echo "unknown argument $1" >&2; exit 2 ;; esac
  shift
done
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OPERATOR="${SUDO_USER:?run with sudo from the operator account}"
ETC=/etc/automaton-fleet
OPT=/opt/automaton-fleet
USER_=automaton-fleet-gumroad
UNIT=automaton-fleet-gumroad.service
ENVF=$ETC/gumroad.env
DB_NAME="${FLEET_DB_NAME:-automaton_fleet}"
DB_HOST="${FLEET_DB_HOST:-127.0.0.1}"
DB_PORT="${FLEET_DB_PORT:-5432}"
NODE=$OPT/node/bin/node
CUR=$OPT/current

say() { printf '\n# %s\n' "$*"; }
run() { printf '  %s\n' "$*"; if (( APPLY )); then "$@"; fi; }
put() {
  printf '  install -m %s -o %s -g %s <generated content> %s\n' "$1" "${2%%:*}" "${2##*:}" "$3"
  if (( APPLY )); then local tmp; tmp="$(mktemp "$3.XXXXXX")"; cat >"$tmp"; chmod "$1" "$tmp"; chown "$2" "$tmp"; mv -f "$tmp" "$3"; else cat >/dev/null; fi
}
admin() { runuser -u "$OPERATOR" -- env -C "$CUR" "$NODE" dist/fleet/postgres/cli.js "$@"; }
role_exists() { [[ "$(runuser -u postgres -- psql -X -tA -d postgres -c "SELECT count(*) FROM pg_roles WHERE rolname IN ('fleet_provider','fleet_provider_login')")" == 2 ]]; }

if [[ "$MODE" == check ]]; then
  bad=0
  ok() { printf '  %-44s %s\n' "$1" "$2"; }
  id "$USER_" >/dev/null 2>&1 && ok "OS user $USER_" "present (groups: $(id -nG "$USER_"))" || { ok "OS user $USER_" "MISSING"; bad=1; }
  role_exists && ok "DB roles fleet_provider(_login)" "present" || { ok "DB roles fleet_provider(_login)" "MISSING"; bad=1; }
  [[ -f "$ENVF" ]] && ok "$ENVF" "$(stat -c '%U:%G %a' "$ENVF")" || { ok "$ENVF" "MISSING"; bad=1; }
  [[ -f /etc/systemd/system/$UNIT ]] && ok "$UNIT" "$(systemctl is-enabled "$UNIT" 2>/dev/null || true) / $(systemctl is-active "$UNIT" 2>/dev/null || true)" || { ok "$UNIT" "NOT INSTALLED"; bad=1; }
  [[ -f /var/lib/$USER_/vault/gumroad~owner ]] && ok "token vault:gumroad/owner" "present ($(stat -c '%a' /var/lib/$USER_/vault/gumroad~owner))" || ok "token vault:gumroad/owner" "not onboarded (dormant)"
  exit "$bad"
fi
[[ "$MODE" == install ]] || { echo "unknown mode $MODE" >&2; exit 2; }
(( APPLY )) || echo "(plan only — nothing changes without --apply)"
grep -q "grant-provider-role" "$CUR/dist/fleet/postgres/cli.js" || { echo "the installed release ($(readlink -f "$CUR")) has no grant-provider-role — cut over to the v52 candidate first" >&2; exit 1; }
SRC_UNIT="$REPO/deploy/systemd/$UNIT"
[[ -f "$CUR/deploy/systemd/$UNIT" ]] && SRC_UNIT="$CUR/deploy/systemd/$UNIT"

say "1. OS user $USER_"
id "$USER_" >/dev/null 2>&1 && echo "  (exists — left unchanged)" || run useradd --system --user-group --home-dir /var/lib/$USER_ \
  --no-create-home --shell /usr/sbin/nologin --comment "Automaton fleet storefront gateway" "$USER_"
if (( APPLY )); then [[ "$(id -nG "$USER_")" == "$USER_" ]] || { echo "$USER_ is in other groups: $(id -nG "$USER_") — refusing" >&2; exit 1; }; fi

say "2. DB roles fleet_provider / fleet_provider_login (provider block of fleet-db-roles.sql only)"
pw=""
if [[ -f "$ENVF" ]]; then
  pw="$(sed -n 's/^FLEET_PROVIDER_DATABASE_URL=postgresql:\/\/fleet_provider_login:\([0-9a-f]\{64\}\)@.*/\1/p' "$ENVF" | head -1)"
  [[ -n "$pw" ]] || { echo "$ENVF exists but holds no 64-hex fleet_provider_login password — fix it by hand" >&2; exit 1; }
  echo "  (gumroad.env exists — its password is kept)"
else
  pw="$(openssl rand -hex 32)"
fi
block="$(awk '/^\\if :\{\?provider_password\}/ {on=1} on {print} on && /^\\endif/ {exit}' "$REPO/scripts/fleet-db-roles.sql")"
[[ "$block" == *"fleet_provider_login"* && "$block" == *'\endif'* ]] || { echo "provider block not found in fleet-db-roles.sql" >&2; exit 1; }
if (( APPLY )); then
  { printf '\\set ON_ERROR_STOP on\n\\set provider_password %s\n' "$pw"; printf '%s\n' "$block"; } |
    runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -v dbname="$DB_NAME" -d postgres -f - >/dev/null
fi
if [[ ! -f "$ENVF" ]]; then
  printf '# Storefront gateway DB credential (fleet_provider_login: gx_* only). Never give this to agents or other services.\nFLEET_PROVIDER_DATABASE_URL=postgresql://fleet_provider_login:%s@%s:%s/%s\n' \
    "$pw" "$DB_HOST" "$DB_PORT" "$DB_NAME" | put 0640 "root:$USER_" "$ENVF"
else
  run chown "root:$USER_" "$ENVF"; run chmod 0640 "$ENVF"
fi
unset pw

say "3. grant gx_* to fleet_provider (installed release's admin CLI, as $OPERATOR)"
(( APPLY )) && admin grant-provider-role >/dev/null

say "4. unit $UNIT (enabled, started)"
run install -m 0644 -o root -g root "$SRC_UNIT" "/etc/systemd/system/$UNIT"
run systemctl daemon-reload
run systemctl enable --now "$UNIT"
if (( APPLY )); then
  admin audit-privileges >/dev/null || { echo "fleet:audit-privileges FAILED after the provider grant" >&2; exit 1; }
  echo "  fleet:audit-privileges ok"
fi
say "done$( (( APPLY )) || echo ' (plan only)')"
