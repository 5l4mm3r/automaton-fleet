#!/usr/bin/env bash
# v89 — provision software maintenance on customers' code: the code gateway (GitHub App), the isolated build environment
# and its egress proxy. Mirrors fleet-bankfeed-setup.sh.
#
#   sudo scripts/fleet-code-setup.sh check            read-only: what is present, what is missing
#   sudo scripts/fleet-code-setup.sh install          print the plan (nothing changes)
#   sudo scripts/fleet-code-setup.sh install --apply
#       1. OS users automaton-fleet-code, automaton-fleet-build, automaton-fleet-build-proxy (system, nologin, no other group)
#       2. DB roles fleet_code(_login) and fleet_build(_login) — ONLY their blocks of scripts/fleet-db-roles.sql, passwords
#          generated here, written only to /etc/automaton-fleet/code.env and build.env (root:<user> 0640) as unix-socket
#          URLs; one pg_hba line each (local <db> <login> scram-sha-256) + reload (no PostgreSQL restart)
#       3. fleet:admin grant-code-role (cgx_*) and grant-build-role (bbx_*) from the INSTALLED release; fleet:audit-privileges
#       4. the three units (code: public internet, GitHub only in code; build: loopback only, no credentials; proxy: loopback
#          listener, registries only), enabled and started. Without the app key the gateway runs "not configured".
#   sudo scripts/fleet-code-setup.sh set-key --apply   read the GitHub App's private key (PEM) from stdin, write it root-only
#          (0600) as /etc/automaton-fleet/code/github-app-key (a systemd credential of the code unit only), restart the unit.
#          Set FLEET_CODE_GITHUB_APP_ID and FLEET_CODE_GITHUB_APP_SLUG in code.env first.
# Never prints a secret. Undo: systemctl disable --now automaton-fleet-code automaton-fleet-build automaton-fleet-build-proxy.
# Toolchains inside builds are what the host provides under /usr (python3 today; Node/npm need the distribution's nodejs
# package — an OS install, its own approval).
set -euo pipefail
MODE="${1:?usage: check | install [--apply] | set-key --apply}"; shift || true
APPLY=0; [[ "${1:-}" == "--apply" ]] && APPLY=1
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OPERATOR="${SUDO_USER:?run with sudo from the operator account}"
ETC=/etc/automaton-fleet; OPT=/opt/automaton-fleet; NODE=$OPT/node/bin/node; CUR=$OPT/current
DB_NAME="${FLEET_DB_NAME:-automaton_fleet}"; SOCK=/var/run/postgresql; KEYS=$ETC/code
UNITS=(automaton-fleet-build-proxy.service automaton-fleet-build.service automaton-fleet-code.service)
say() { printf '\n# %s\n' "$*"; }
run() { printf '  %s\n' "$*"; if (( APPLY )); then "$@"; fi; }
admin() { runuser -u "$OPERATOR" -- env -C "$CUR" "$NODE" dist/fleet/postgres/cli.js "$@"; }
psql_su() { runuser -u postgres -- psql -X -tA -v ON_ERROR_STOP=1 "$@"; }

if [[ "$MODE" == check ]]; then
  bad=0; ok() { printf '  %-48s %s\n' "$1" "$2"; }
  for u in automaton-fleet-code automaton-fleet-build automaton-fleet-build-proxy; do id "$u" >/dev/null 2>&1 && ok "OS user $u" "present" || { ok "OS user $u" "MISSING"; bad=1; }; done
  [[ "$(psql_su -d postgres -c "SELECT count(*) FROM pg_roles WHERE rolname IN ('fleet_code','fleet_code_login','fleet_build','fleet_build_login')")" == 4 ]] && ok "DB roles code + build" "present" || { ok "DB roles code + build" "MISSING"; bad=1; }
  for f in code.env build.env; do [[ -f "$ETC/$f" ]] && ok "$ETC/$f" "$(stat -c '%U:%G %a' "$ETC/$f")" || { ok "$ETC/$f" "MISSING"; bad=1; }; done
  for u in "${UNITS[@]}"; do [[ -f /etc/systemd/system/$u ]] && ok "$u" "$(systemctl is-enabled "$u" 2>/dev/null || true) / $(systemctl is-active "$u" 2>/dev/null || true)" || { ok "$u" "NOT INSTALLED"; bad=1; }; done
  [[ -s $KEYS/github-app-key ]] && ok "GitHub App key" "present ($(stat -c '%U:%G %a' "$KEYS/github-app-key"))" || ok "GitHub App key" "not set (gateway runs not configured)"
  for b in python3 node npm; do command -v "$b" >/dev/null && [[ "$(command -v "$b")" == /usr/* ]] && ok "build toolchain $b" "$(command -v "$b")" || ok "build toolchain $b" "not under /usr (not available inside builds)"; done
  exit "$bad"
fi
if [[ "$MODE" == set-key ]]; then
  (( APPLY )) || { echo "set-key reads the key from stdin and writes it: run with --apply" >&2; exit 2; }
  key="$(cat)"
  [[ "$key" =~ ^-----BEGIN\ (RSA\ )?PRIVATE\ KEY----- && "$key" == *"-----END"*"PRIVATE KEY-----"* ]] || { echo "expected the GitHub App's private key (PEM)" >&2; exit 1; }
  install -d -m 0700 -o root -g root "$KEYS"
  umask 077
  printf '%s\n' "$key" > "$KEYS/github-app-key.tmp" && mv -f "$KEYS/github-app-key.tmp" "$KEYS/github-app-key"
  chmod 0600 "$KEYS/github-app-key"; unset key
  echo "  key written (root 0600); restarting automaton-fleet-code"
  systemctl restart automaton-fleet-code.service
  exit 0
fi
[[ "$MODE" == install ]] || { echo "unknown mode $MODE" >&2; exit 2; }
(( APPLY )) || echo "(plan only — nothing changes without --apply)"
[[ -f "$CUR/dist/fleet/code/main.js" && -f "$CUR/dist/fleet/build/main.js" ]] || { echo "the installed release has no code gateway / build environment — deploy v89 first" >&2; exit 1; }
[[ -S $SOCK/.s.PGSQL.5432 ]] || { echo "PostgreSQL socket missing in $SOCK" >&2; exit 1; }

say "1. OS users"
for u in automaton-fleet-code automaton-fleet-build automaton-fleet-build-proxy; do
  id "$u" >/dev/null 2>&1 && echo "  $u (exists — left unchanged)" || run useradd --system --user-group --home-dir "/var/lib/$u" --no-create-home --shell /usr/sbin/nologin --comment "Automaton fleet ${u#automaton-fleet-}" "$u"
done

# One DB role pair + env file + pg_hba line (the bank-feed script's procedure, per role).
provision() { # $1 role (code|build)  $2 env file  $3 user  $4 env var
  local role=$1 envf=$2 user=$3 var=$4 pw block tmp HBA
  if [[ -f "$envf" ]]; then
    pw="$(sed -n "s/^$var=postgresql:\/\/fleet_${role}_login:\([0-9a-f]\{64\}\)@.*/\1/p" "$envf" | head -1)"
    [[ -n "$pw" ]] || { echo "$envf holds no 64-hex fleet_${role}_login password — fix it by hand" >&2; exit 1; }
    echo "  ($(basename "$envf") exists — its password is kept)"
  else pw="$(openssl rand -hex 32)"; fi
  block="$(awk "/^\\\\if :\\{\\?${role}_password\\}/ {on=1} on {print} on && /^\\\\endif/ {exit}" "$REPO/scripts/fleet-db-roles.sql")"
  [[ "$block" == *"fleet_${role}_login"* ]] || { echo "$role block not found in fleet-db-roles.sql" >&2; exit 1; }
  echo "  { \\set ${role}_password <hex>; <$role block> } | psql -d postgres -f -"
  if (( APPLY )); then
    { printf '\\set ON_ERROR_STOP on\n\\set %s_password %s\n' "$role" "$pw"; printf '%s\n' "$block"; } | runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -v dbname="$DB_NAME" -d postgres -f - >/dev/null
    if [[ ! -f "$envf" ]]; then
      tmp="$(mktemp "$envf.XXXXXX")"
      printf '# %s DB credential (fleet_%s_login only). Never give this to agents or other services.\n%s=postgresql://fleet_%s_login:%s@/%s?host=%s\n' "$role" "$role" "$var" "$role" "$pw" "$DB_NAME" "$SOCK" > "$tmp"
      [[ "$role" == code ]] && printf '# The Fleet GitHub App (public ids): set both, then set-key.\nFLEET_CODE_GITHUB_APP_ID=\nFLEET_CODE_GITHUB_APP_SLUG=\n' >> "$tmp"
      chmod 0640 "$tmp"; chown "root:$user" "$tmp"; mv -f "$tmp" "$envf"
    fi
    HBA="$(psql_su -d postgres -c 'SHOW hba_file')"
    if ! grep -Eq "^\s*local\s+$DB_NAME\s+fleet_${role}_login\s+scram-sha-256" "$HBA"; then
      cp -p "$HBA" "$HBA.pre-$role-$(date -u +%Y%m%dT%H%M%SZ)"
      python3 -I - "$HBA" "$DB_NAME" "fleet_${role}_login" <<'PY'
import re, sys
f, db, login = sys.argv[1:4]
lines = open(f).read().splitlines(keepends=True)
i = next((k for k, l in enumerate(lines) if re.match(r"^\s*local\s", l)), len(lines))
lines.insert(i, f"local   {db}   {login}   scram-sha-256   # v89 over the unix socket\n")
open(f, "w").write("".join(lines))
PY
      [[ "$(psql_su -d postgres -c 'SELECT pg_reload_conf()')" == t && "$(psql_su -d postgres -c 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL')" == 0 ]] \
        || { echo "pg_hba reload failed — restore the .pre-$role backup" >&2; exit 1; }
    fi
  fi
  unset pw
}
say "2. DB roles, env files (socket URLs), pg_hba lines"
provision code "$ETC/code.env" automaton-fleet-code FLEET_CODE_DATABASE_URL
provision build "$ETC/build.env" automaton-fleet-build FLEET_BUILD_DATABASE_URL

say "3. grants (installed release's admin CLI, as $OPERATOR)"
if (( APPLY )); then admin grant-code-role >/dev/null; admin grant-build-role >/dev/null; admin audit-privileges >/dev/null || { echo "fleet:audit-privileges FAILED" >&2; exit 1; }; echo "  granted; audit ok"
else echo "  grant-code-role; grant-build-role; audit-privileges"; fi

say "4. units (enabled, started)"
for u in "${UNITS[@]}"; do
  src="$REPO/deploy/systemd/$u"; [[ -f "$CUR/deploy/systemd/$u" ]] && src="$CUR/deploy/systemd/$u"
  run install -m 0644 -o root -g root "$src" "/etc/systemd/system/$u"
done
run systemctl daemon-reload
if (( APPLY )); then
  for u in "${UNITS[@]}"; do systemctl enable "$u" >/dev/null 2>&1; systemctl restart "$u"; done  # restart: a re-run picks up the new unit
  sleep 5
  for u in "${UNITS[@]}"; do printf '  %-40s %s\n' "$u" "$(systemctl is-active "$u")"; done
  say "5. proof: inside each unit the configuration directory is empty (its env file and key were read by systemd first)"
  for u in "${UNITS[@]}"; do
    pid="$(systemctl show -p MainPID --value "$u")"
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || { echo "  $u is not running — cannot prove its view" >&2; exit 1; }
    seen="$(ls -A "/proc/$pid/root/etc/automaton-fleet" 2>/dev/null | wc -l)"
    [[ "$seen" == 0 ]] && printf '  %-40s %s\n' "$u" "/etc/automaton-fleet hidden" || { echo "  $u SEES $seen entries in /etc/automaton-fleet — stop it and investigate" >&2; exit 1; }
  done
fi
say "done$( (( APPLY )) || echo ' (plan only)')"
