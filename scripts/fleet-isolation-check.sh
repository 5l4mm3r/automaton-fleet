#!/usr/bin/env bash
# v91 — real-host isolation check. Read-only except `canary-test`, which creates and always removes three throwaway files.
# Prints file NAMES only, never contents or values.
#
#   sudo scripts/fleet-isolation-check.sh                 exit 0: every running unit reads only what it depends on
#   sudo scripts/fleet-isolation-check.sh canary-test     exit 0: the check FAILS on planted canaries, as it must
#   scripts/fleet-isolation-check.sh validate-pins <f>…   the public-pin schema alone (no root; used by tests)
#
# What a unit may read under /etc/automaton-fleet (explicit dependencies — never "whoever owns the file"):
#   1. the paths its own unit file names (EnvironmentFile, LoadCredential, …; a directory covers what is inside it), and
#      backups of exactly those files (<file>.<suffix>);
#   2. the paths its own environment files name;
#   3. paths the code opens by default (CODE_DEFAULTS below, reviewed one by one);
#   4. the public pins: runtime.env, its backups and founders/<id>.runtime.env — and only while every line passes the
#      approved non-secret schema (PIN_SCHEMA: names AND value shapes). A pin file with any other line fails.
# Any other readable file is reported as READS FOREIGN; any other world-readable file as WORLD-READABLE, NOT PUBLIC.
# How it tests "can read": nsenter into the unit's mount namespace, setpriv to its uid / gid / groups, `test -r`.
set -uo pipefail
CONF=${FLEET_ISOLATION_CONF:-/etc/automaton-fleet}

# Approved non-secret pin lines: NAME → the only value shape allowed (optionally quoted).
declare -A PIN_SCHEMA=(
  [FLEET_RUNTIME_REPO]='https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+(\.git)?'
  [FLEET_RUNTIME_COMMIT]='[0-9a-f]{40}'
  [FLEET_RUNTIME_BUILD_ID]='[0-9a-f]{64}'
  [FLEET_RUNTIME_LOCKFILE_SHA256]='[0-9a-f]{64}'
  [REAL_REPLICATION_ENABLED]='true|false'
  [REAL_PAYMENTS_ENABLED]='true|false'
  [OWNER_SWEEP_ENABLED]='true|false'
  [FLEET_DRY_RUN_CHILD]='true|false'
  [FLEET_REMOTE_LISTEN_ENABLED]='true|false'
  [FLEET_PUBLIC_PROXY_PROTOCOL]='true|false'
  [FLEET_API_LISTEN]='[0-9a-fA-F.:]+:[0-9]{1,5}|\[[0-9a-fA-F:]+\]:[0-9]{1,5}'
  [FLEET_PUBLIC_LISTEN]='[0-9a-fA-F.:]+:[0-9]{1,5}|\[[0-9a-fA-F:]+\]:[0-9]{1,5}'
  [FLEET_REAPER_INTERVAL_MS]='[0-9]{1,9}'
  [FLEET_PUBLIC_HOSTNAME]='[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?'
  [FLEET_PUBLIC_URL]='https://[a-z0-9.-]+(:[0-9]{1,5})?/?'
  [FLEET_TLS_CERT_FILE]='/[A-Za-z0-9._/-]+\.crt'
)
# Paths the code opens without naming them in the unit or its env files (reviewed: the controller's cognition key).
declare -A CODE_DEFAULTS=([automaton-fleet.service]="$CONF/cognition.key")

is_pin_name() { case "${1#$CONF/}" in runtime.env|runtime.env.*|founders/*.runtime.env) return 0 ;; esac; return 1; }
# 0 when every line is blank, a comment, or an approved NAME=VALUE; else prints "<file>: line N <reason>" (no value).
validate_pin() {
  local f=$1 n=0 bad=0 line name val re
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1)); [[ "$line" =~ ^[[:space:]]*(#.*)?$ ]] && continue
    if [[ ! "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then echo "  PIN SCHEMA: ${f#$CONF/}: line $n is not NAME=VALUE"; bad=1; continue; fi
    name=${BASH_REMATCH[1]}; val=${BASH_REMATCH[2]}
    if [[ "$val" =~ ^\"(.*)\"$ ]]; then val=${BASH_REMATCH[1]}; elif [[ "$val" =~ ^\'(.*)\'$ ]]; then val=${BASH_REMATCH[1]}; fi
    re=${PIN_SCHEMA[$name]:-}
    if [[ -z "$re" ]]; then echo "  PIN SCHEMA: ${f#$CONF/}: line $n name $name is not an approved public pin"; bad=1
    elif [[ ! "$val" =~ ^($re)$ ]]; then echo "  PIN SCHEMA: ${f#$CONF/}: line $n $name has a value outside its approved shape"; bad=1; fi
  done < "$f"
  return $bad
}

if [[ "${1:-}" == validate-pins ]]; then
  shift; rc=0; for f in "$@"; do validate_pin "$f" || rc=1; done; exit $rc
fi
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }

if [[ "${1:-}" == canary-test ]]; then
  # Three throwaway files (random hex, not a secret), removed on ANY exit. The check must fail on each.
  C1="$CONF/zz-isolation-canary-group.env"; C2="$CONF/zz-isolation-canary-world.env"; C3="$CONF/runtime.env.zz-isolation-canary"
  cleanup() { rm -f "$C1" "$C2" "$C3"; }
  for c in "$C1" "$C2" "$C3"; do [[ ! -e "$c" ]] || { echo "canary path already exists: $c — refusing"; exit 2; }; done
  trap cleanup EXIT INT TERM HUP
  getent group automaton-fleet-media >/dev/null || { echo "no automaton-fleet-media group: cannot plant the group canary"; exit 2; }
  systemctl is-active --quiet automaton-fleet-media.service || { echo "automaton-fleet-media is not running"; exit 2; }
  rnd() { head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
  # C1: readable by an UNRELATED service through its group (media depends on no such file).
  printf 'CANARY_SECRET=%s\n' "$(rnd)" | install -m 0640 -o root -g automaton-fleet-media /dev/stdin "$C1"
  # C2: world-readable, not a public pin.
  printf 'CANARY_SECRET=%s\n' "$(rnd)" | install -m 0644 -o root -g root /dev/stdin "$C2"
  # C3: named like a public pin, but carrying an unapproved name and a malformed approved one.
  printf 'FLEET_RUNTIME_COMMIT=%s%s\nAPI_SECRET=%s\nREAL_PAYMENTS_ENABLED=maybe\n' "$(rnd)" "$(rnd | cut -c1-8)" "$(rnd)" | install -m 0644 -o root -g root /dev/stdin "$C3"
  out=$(bash "$0" 2>&1); rc=$?
  ok=1
  expect() { if grep -qE "$1" <<< "$out"; then echo "  caught: $2"; else echo "  NOT CAUGHT: $2"; ok=0; fi; }
  expect 'automaton-fleet-media\.service +READS FOREIGN:.*zz-isolation-canary-group\.env' "media reading a group-readable file it does not depend on"
  expect 'WORLD-READABLE, NOT PUBLIC: zz-isolation-canary-world\.env' "a world-readable non-pin file"
  expect 'PIN SCHEMA: runtime\.env\.zz-isolation-canary: line 2 name API_SECRET is not an approved public pin' "an unapproved name in a public pin"
  expect 'PIN SCHEMA: runtime\.env\.zz-isolation-canary: line 3 REAL_PAYMENTS_ENABLED has a value outside its approved shape' "a malformed value in a public pin"
  if [[ $rc -ne 0 ]]; then echo "  check exit status $rc (failure, as required)"; else echo "  the check EXITED 0 with canaries present"; ok=0; fi
  cleanup; trap - EXIT INT TERM HUP
  for c in "$C1" "$C2" "$C3"; do [[ ! -e "$c" ]] || { echo "  canary NOT removed: $c"; ok=0; }; done
  (( ok )) && { echo "CANARY TEST PASSED: every planted canary was caught; canaries removed"; exit 0; }
  echo "CANARY TEST FAILED (canaries removed)"; exit 1
fi

bad=0; n=0
mapfile -t FILES < <(find "$CONF" -type f 2>/dev/null | sort)
declare -A PIN_OK=()
for f in "${FILES[@]}"; do
  if is_pin_name "$f"; then if validate_pin "$f"; then PIN_OK[$f]=1; else bad=1; fi; fi
  m=$(stat -c '%a' "$f")
  if (( m % 10 >= 4 )) && [[ -z "${PIN_OK[$f]:-}" ]]; then bad=1; echo "  WORLD-READABLE, NOT PUBLIC: ${f#$CONF/} ($m)"; fi
done
for u in $(systemctl list-units 'automaton-*.service' --state=running --no-legend --plain | awk '{print $1}'); do
  pid=$(systemctl show -p MainPID --value "$u"); [[ "$pid" =~ ^[1-9][0-9]*$ ]] || continue
  uid=$(awk '/^Uid:/{print $2}' /proc/$pid/status); gid=$(awk '/^Gid:/{print $2}' /proc/$pid/status)
  groups=$(awk '/^Groups:/{for(i=2;i<=NF;i++) printf "%s%s", (i>2?",":""), $i}' /proc/$pid/status)
  n=$((n + 1))
  if [[ "$uid" == 0 ]]; then printf '  %-58s %s\n' "$u" "runs as root (by design) — skipped"; continue; fi
  # Its declared dependencies: unit-file paths, paths its own env files name, reviewed code defaults.
  envs=$(systemctl show -p EnvironmentFiles --value "$u" | grep -oE "$CONF/[A-Za-z0-9._/-]+")
  deps=$( { systemctl cat "$u" 2>/dev/null | grep -vE '^\s*#|^InaccessiblePaths' | grep -oE "$CONF/[A-Za-z0-9._/-]+"
            for e in $envs; do [[ -f "$e" ]] && grep -oE "$CONF/[A-Za-z0-9._/-]+" "$e"; done
            for d in ${CODE_DEFAULTS[$u]:-}; do echo "$d"; done; } | sed 's#/$##' | sort -u)
  if [[ -n "$groups" ]]; then G=(--groups="$groups"); else G=(--clear-groups); fi
  as_unit() { nsenter -t "$pid" -m -- setpriv --reuid="$uid" --regid="$gid" "${G[@]}" "$@"; }
  # The probe itself must work, or every "cannot read" below would be meaningless.
  if ! as_unit true 2>/dev/null; then bad=1; printf '  %-58s %s\n' "$u" "ERROR: cannot enter its namespace as its user — not checked"; continue; fi
  readable=()
  for f in "${FILES[@]}"; do
    as_unit test -r "$f" 2>/dev/null || continue
    [[ -n "${PIN_OK[$f]:-}" ]] && continue                     # a validated public pin
    dep=0
    while read -r d; do
      [[ -z "$d" ]] && continue
      # the dependency itself, a file inside a dependency directory, or a backup of exactly that file
      if [[ "$f" == "$d" || "$f" == "$d"/* ]]; then dep=1; break; fi
      if [[ -f "$d" && "$f" == "$d".* ]]; then dep=1; break; fi
    done <<< "$deps"
    (( dep )) || readable+=("${f#$CONF/}")
  done
  if (( ${#readable[@]} )); then bad=1; printf '  %-58s READS FOREIGN: %s\n' "$u" "${readable[*]}"
  else printf '  %-58s %s\n' "$u" "reads only what it depends on"; fi
done
(( n )) || { echo "no running Fleet units found"; exit 2; }
(( bad )) && { echo "ISOLATION CHECK FAILED — stop and investigate (names above; no contents printed)"; exit 1; }
echo "ISOLATION CHECK PASSED: $n running units; public pins match the approved schema"
