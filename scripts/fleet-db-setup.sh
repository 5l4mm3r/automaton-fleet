#!/usr/bin/env bash
# Fleet Phase 4 — PostgreSQL roles (superuser step). Idempotent.
#
#   sudo scripts/fleet-db-setup.sh            # DRY RUN: prints what will run, changes nothing
#   sudo scripts/fleet-db-setup.sh --apply    # runs scripts/fleet-db-roles.sql as postgres
#
# Passwords are taken from /etc/automaton-fleet/service.env (written by
# fleet-os-setup.sh) and fed to psql on STDIN via \set, so they never appear
# in any process command line or in shell history. After this, the operator
# (not root) runs the admin-credential steps:
#
#   pnpm fleet:migrate              # v1 -> v3; refuses non-owner credentials; grants agent + service roles
#   pnpm fleet:audit-privileges     # must PASS
#   pnpm fleet:doctor
set -euo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_ENV=/etc/automaton-fleet/service.env
DB_NAME="${FLEET_DB_NAME:-automaton_fleet}"
DB_OWNER="${FLEET_DB_OWNER:-fleetadmin}"
[[ -f "$SERVICE_ENV" ]] || { echo "$SERVICE_ENV missing — run scripts/fleet-os-setup.sh --apply first" >&2; exit 1; }

pw_of() { # extract the password of a login role from its DSN in service.env
  sed -n "s#^$1=postgresql://[^:]*:\([0-9a-f]\{64\}\)@.*#\1#p" "$SERVICE_ENV" | head -1
}
SERVICE_PW="$(pw_of FLEET_SERVICE_DATABASE_URL)"
AGENT_PW="$(pw_of FLEET_AGENT_DATABASE_URL)"
[[ -n "$SERVICE_PW" && -n "$AGENT_PW" ]] || { echo "service.env must hold 64-hex passwords for both DSNs" >&2; exit 1; }

echo "Will run as the postgres superuser (passwords via stdin, not shown):"
echo "  { printf '\\set agent_password <hex>\\n\\set service_password <hex>\\n'; cat $REPO/scripts/fleet-db-roles.sql; } |"
echo "    runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -v dbname=$DB_NAME -v owner=$DB_OWNER -d postgres -f -"
if (( APPLY )); then
  { printf '\\set agent_password %s\n\\set service_password %s\n' "$AGENT_PW" "$SERVICE_PW"; cat "$REPO/scripts/fleet-db-roles.sql"; } |
    runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -v dbname="$DB_NAME" -v owner="$DB_OWNER" -d postgres -f -
  echo "Roles applied. Next (as $DB_OWNER operator, not root): pnpm fleet:migrate && pnpm fleet:audit-privileges && pnpm fleet:doctor"
else
  echo "DRY RUN — nothing changed. Re-run with --apply after approval."
fi
unset SERVICE_PW AGENT_PW
