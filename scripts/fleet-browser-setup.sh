#!/usr/bin/env bash
# R41.1 — provision the isolated browser worker (schema v37 unit, never installed until now) on the controller host.
#
#   sudo scripts/fleet-browser-setup.sh check                 read-only: what is present, what is missing
#   sudo scripts/fleet-browser-setup.sh install [--zip <f>]   print the plan (nothing changes)
#   sudo scripts/fleet-browser-setup.sh install [--zip <f>] --apply
#       1. the shared libraries headless Chromium needs (apt, --no-install-recommends)
#       2. the pinned Chrome for Testing headless shell (sha256-verified zip) under /opt/automaton-fleet/chromium,
#          root-owned; /opt/automaton-fleet/chromium/chrome → that binary
#       3. OS user automaton-fleet-browser (system, nologin, no other group)
#       4. DB roles fleet_browser / fleet_browser_login — ONLY the browser block of scripts/fleet-db-roles.sql, the
#          password fed on stdin; it is written only to /etc/automaton-fleet/browser.env (root:automaton-fleet-browser
#          0640, FLEET_BROWSER_DATABASE_URL only); an existing browser.env keeps its password
#       5. fleet:admin grant-browser-role (USAGE + EXECUTE on bx_* only), run from the INSTALLED release
#       6. the unit (deploy/systemd/automaton-fleet-browser.service), enabled and started; waits for the worker's own
#          Chromium self-test (browser_selftest_ok); then fleet:audit-privileges must pass
#
# Never prints a secret. Touches no other role, env file or unit. Mail/SMS providers stay dormant (not this script).
# Undo: systemctl disable --now automaton-fleet-browser; the worker holds no vault and no state worth keeping.
set -euo pipefail
MODE="${1:?usage: check | install [--zip <chrome-headless-shell-linux64.zip>] [--apply]}"
shift
APPLY=0; ZIP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --zip) ZIP="${2:?}"; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OPERATOR="${SUDO_USER:?run with sudo from the operator account}"
ETC=/etc/automaton-fleet
OPT=/opt/automaton-fleet
USER_=automaton-fleet-browser
UNIT=automaton-fleet-browser.service
ENVF=$ETC/browser.env
DB_NAME="${FLEET_DB_NAME:-automaton_fleet}"
DB_HOST="${FLEET_DB_HOST:-127.0.0.1}"
DB_PORT="${FLEET_DB_PORT:-5432}"
NODE=$OPT/node/bin/node
CUR=$OPT/current
# Chrome for Testing headless shell matching playwright-core 1.63.0 (chromium 153.0.8010.12).
CFT_VERSION=153.0.8010.12
CFT_URL=https://storage.googleapis.com/chrome-for-testing-public/$CFT_VERSION/linux64/chrome-headless-shell-linux64.zip
CFT_ZIP_SHA256=a9da028861a0cf789ff25c2fed45f5f1aaf969ed9247835b6a7821a4f7af9d1d
CDIR=$OPT/chromium/$CFT_VERSION
BIN=$CDIR/chrome-headless-shell-linux64/chrome-headless-shell
LINK=$OPT/chromium/chrome
LIBS=(libatk1.0-0t64 libatk-bridge2.0-0t64 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 libatspi2.0-0t64
      libnss3 libnspr4 libcups2t64 libdrm2 libxkbcommon0 libpango-1.0-0 libcairo2 libdbus-1-3 libexpat1 libx11-6 libxcb1 libxext6 fonts-liberation)

say() { printf '\n# %s\n' "$*"; }
run() { printf '  %s\n' "$*"; if (( APPLY )); then "$@"; fi; }
# Writes stdin to a file with owner/group/mode atomically; content is never echoed.
put() {
  printf '  install -m %s -o %s -g %s <generated content> %s\n' "$1" "${2%%:*}" "${2##*:}" "$3"
  if (( APPLY )); then
    local tmp; tmp="$(mktemp "$3.XXXXXX")"
    cat >"$tmp"; chmod "$1" "$tmp"; chown "$2" "$tmp"; mv -f "$tmp" "$3"
  else
    cat >/dev/null
  fi
}
# The admin CLI of the INSTALLED release, as the operator (who reads admin.env), never as root.
admin() { runuser -u "$OPERATOR" -- env -C "$CUR" "$NODE" dist/fleet/postgres/cli.js "$@"; }
missing_libs() { [[ -x "$BIN" ]] && ldd "$BIN" 2>/dev/null | awk '/not found/ {print $1}' | sort -u | tr '\n' ' '; }
role_exists() { [[ "$(runuser -u postgres -- psql -X -tA -d postgres -c "SELECT count(*) FROM pg_roles WHERE rolname IN ('fleet_browser','fleet_browser_login')")" == 2 ]]; }

if [[ "$MODE" == check ]]; then
  bad=0
  ok() { printf '  %-44s %s\n' "$1" "$2"; }
  [[ -x "$BIN" ]] && ok "chromium $CFT_VERSION" "present" || { ok "chromium $CFT_VERSION" "MISSING"; bad=1; }
  [[ "$(readlink -f "$LINK" 2>/dev/null)" == "$BIN" ]] && ok "$LINK" "→ pinned binary" || { ok "$LINK" "MISSING or not the pinned binary"; bad=1; }
  m="$(missing_libs || true)"; [[ -x "$BIN" && -z "$m" ]] && ok "shared libraries" "complete" || { ok "shared libraries" "missing: ${m:-unknown (no binary)}"; bad=1; }
  id "$USER_" >/dev/null 2>&1 && ok "OS user $USER_" "present (groups: $(id -nG "$USER_"))" || { ok "OS user $USER_" "MISSING"; bad=1; }
  role_exists && ok "DB roles fleet_browser(_login)" "present" || { ok "DB roles fleet_browser(_login)" "MISSING"; bad=1; }
  [[ -f "$ENVF" ]] && ok "$ENVF" "$(stat -c '%U:%G %a' "$ENVF")" || { ok "$ENVF" "MISSING"; bad=1; }
  [[ -f /etc/systemd/system/$UNIT ]] && ok "$UNIT" "$(systemctl is-enabled "$UNIT" 2>/dev/null || true) / $(systemctl is-active "$UNIT" 2>/dev/null || true)" || { ok "$UNIT" "NOT INSTALLED"; bad=1; }
  journalctl -u "$UNIT" -o cat --no-pager 2>/dev/null | grep -q browser_selftest_ok && ok "worker self-test" "browser_selftest_ok seen" || { ok "worker self-test" "not seen"; bad=1; }
  exit "$bad"
fi
[[ "$MODE" == install ]] || { echo "unknown mode $MODE" >&2; exit 2; }
(( APPLY )) || echo "(plan only — nothing changes without --apply)"

# Preconditions: the installed release carries the R41.1 grant command and the unit file matches it.
grep -q "grant-browser-role" "$CUR/dist/fleet/postgres/cli.js" || { echo "the installed release ($(readlink -f "$CUR")) has no grant-browser-role — cut over to the R41.1 candidate first" >&2; exit 1; }
SRC_UNIT="$REPO/deploy/systemd/$UNIT"
[[ -f "$CUR/deploy/systemd/$UNIT" ]] && SRC_UNIT="$CUR/deploy/systemd/$UNIT"

say "1. shared libraries for headless Chromium"
run apt-get install -y --no-install-recommends "${LIBS[@]}"

say "2. Chrome for Testing headless shell $CFT_VERSION (sha256-pinned)"
if [[ -x "$BIN" ]]; then
  echo "  (present — left unchanged)"
else
  if [[ -z "$ZIP" ]]; then
    ZIP="$(mktemp -d)/chrome-headless-shell-linux64.zip"
    run curl -fsSL --proto '=https' -o "$ZIP" "$CFT_URL"
  fi
  if (( APPLY )); then
    got="$(sha256sum "$ZIP" | cut -d' ' -f1)"
    [[ "$got" == "$CFT_ZIP_SHA256" ]] || { echo "zip sha256 $got ≠ pinned $CFT_ZIP_SHA256 — refusing" >&2; exit 1; }
    echo "  zip sha256 verified"
  fi
  run install -d -m 0755 -o root -g root "$OPT/chromium" "$CDIR"
  run unzip -q -o "$ZIP" -d "$CDIR"
  run chown -R root:root "$CDIR"
  run chmod -R go-w "$CDIR"
fi
run ln -sfn "$BIN" "$LINK"
if (( APPLY )); then
  m="$(missing_libs)"; [[ -z "$m" ]] || { echo "Chromium still misses shared libraries: $m" >&2; exit 1; }
  echo "  libraries complete; $("$BIN" --version 2>/dev/null || echo "version unreadable")"
fi

say "3. OS user $USER_"
id "$USER_" >/dev/null 2>&1 && echo "  (exists — left unchanged)" || run useradd --system --user-group --home-dir /var/lib/$USER_ \
  --no-create-home --shell /usr/sbin/nologin --comment "Automaton fleet browser worker" "$USER_"
if (( APPLY )); then [[ "$(id -nG "$USER_")" == "$USER_" ]] || { echo "$USER_ is in other groups: $(id -nG "$USER_") — refusing" >&2; exit 1; }; fi

say "4. DB roles fleet_browser / fleet_browser_login (browser block of fleet-db-roles.sql only)"
pw=""
if [[ -f "$ENVF" ]]; then
  pw="$(sed -n 's/^FLEET_BROWSER_DATABASE_URL=postgresql:\/\/fleet_browser_login:\([0-9a-f]\{64\}\)@.*/\1/p' "$ENVF" | head -1)"
  [[ -n "$pw" ]] || { echo "$ENVF exists but holds no 64-hex fleet_browser_login password — fix it by hand" >&2; exit 1; }
  echo "  (browser.env exists — its password is kept)"
else
  pw="$(openssl rand -hex 32)"
fi
block="$(awk '/^\\if :\{\?browser_password\}/ {on=1} on {print} on && /^\\endif/ {exit}' "$REPO/scripts/fleet-db-roles.sql")"
[[ "$block" == *"fleet_browser_login"* && "$block" == *'\endif'* ]] || { echo "browser block not found in fleet-db-roles.sql" >&2; exit 1; }
echo "  { \\set browser_password <hex>; <browser block> } | runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -v dbname=$DB_NAME -d postgres -f -"
if (( APPLY )); then
  { printf '\\set ON_ERROR_STOP on\n\\set browser_password %s\n' "$pw"; printf '%s\n' "$block"; } |
    runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -v dbname="$DB_NAME" -d postgres -f - >/dev/null
fi
if [[ ! -f "$ENVF" ]]; then
  printf '# Browser worker DB credential (fleet_browser_login: bx_* only). Never give this to agents or other services.\nFLEET_BROWSER_DATABASE_URL=postgresql://fleet_browser_login:%s@%s:%s/%s\n' \
    "$pw" "$DB_HOST" "$DB_PORT" "$DB_NAME" | put 0640 "root:$USER_" "$ENVF"
else
  run chown "root:$USER_" "$ENVF"; run chmod 0640 "$ENVF"
fi
unset pw

say "5. grant bx_* to fleet_browser (installed release's admin CLI, as $OPERATOR)"
echo "  $NODE dist/fleet/postgres/cli.js grant-browser-role   (in $CUR)"
(( APPLY )) && admin grant-browser-role >/dev/null

say "6. unit $UNIT (enabled, started; waits for the worker's Chromium self-test)"
run install -m 0644 -o root -g root "$SRC_UNIT" "/etc/systemd/system/$UNIT"
run systemctl daemon-reload
if (( APPLY )); then
  since="$(date '+%Y-%m-%d %H:%M:%S')"
  systemctl enable --now "$UNIT" >/dev/null 2>&1
  for _ in $(seq 1 60); do
    journalctl -u "$UNIT" --since "$since" -o cat --no-pager | grep -q browser_selftest_ok && break
    sleep 1
  done
  journalctl -u "$UNIT" --since "$since" -o cat --no-pager | grep -q browser_selftest_ok \
    || { echo "no browser_selftest_ok within 60 s — last log lines:" >&2; journalctl -u "$UNIT" --since "$since" -o cat --no-pager | tail -n 15 >&2; exit 1; }
  echo "  browser_selftest_ok; $(systemctl is-active "$UNIT")"
  admin audit-privileges >/dev/null || { echo "fleet:audit-privileges FAILED after the browser grant" >&2; exit 1; }
  echo "  fleet:audit-privileges ok"
else
  echo "  systemctl enable --now $UNIT; wait for browser_selftest_ok; fleet:audit-privileges"
fi
say "done$( (( APPLY )) || echo ' (plan only)')"
