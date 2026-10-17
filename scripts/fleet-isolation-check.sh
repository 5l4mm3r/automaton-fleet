#!/usr/bin/env bash
# v91 — real-host isolation check (read-only; run as root): for every RUNNING Fleet unit, which files under
# /etc/automaton-fleet can it actually read, from inside its own mount namespace and as its own user? Units hide the
# directory (InaccessiblePaths) or list files; files are root:<service user> 0640/0600. Either way the only question that
# matters is what the process can open — this tests exactly that (nsenter into the unit's mount namespace, then
# setpriv to its uid/gid/groups, then `test -r`). Prints file NAMES only, never contents.
#
#   sudo scripts/fleet-isolation-check.sh          exit 0: every unit reads only its own configuration
#
# A unit's own files: those it owns or reads through its own group; the paths its unit file names (EnvironmentFile / LoadCredential are read by systemd, before the
# namespace) and the paths its own environment files name (files the service opens itself, e.g. a TLS key). Units that run as root by design (the edge's
# nginx master, backups) are listed and skipped: root reads by permission everything it can see.
set -uo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }
CONF=/etc/automaton-fleet; bad=0; n=0
mapfile -t FILES < <(find "$CONF" -type f 2>/dev/null | sort)
# Public by design (release pins, safety flags, listen addresses, the public certificate's path — no secret): every
# unit may read them. Any OTHER world-readable file under the directory fails the check.
public_ok() { case "${1#$CONF/}" in runtime.env|runtime.env.*|founders/*.runtime.env) return 0 ;; esac; return 1; }
for f in "${FILES[@]}"; do m=$(stat -c '%a' "$f"); if (( m % 10 >= 4 )) && ! public_ok "$f"; then bad=1; echo "  WORLD-READABLE, NOT PUBLIC: ${f#$CONF/} ($m)"; fi; done
for u in $(systemctl list-units 'automaton-*.service' --state=running --no-legend --plain | awk '{print $1}'); do
  pid=$(systemctl show -p MainPID --value "$u"); [[ "$pid" =~ ^[1-9][0-9]*$ ]] || continue
  uid=$(awk '/^Uid:/{print $2}' /proc/$pid/status); gid=$(awk '/^Gid:/{print $2}' /proc/$pid/status)
  groups=$(awk '/^Groups:/{for(i=2;i<=NF;i++) printf "%s%s", (i>2?",":""), $i}' /proc/$pid/status)
  n=$((n + 1))
  if [[ "$uid" == 0 ]]; then printf '  %-58s %s\n' "$u" "runs as root (by design) — skipped"; continue; fi
  # Its own: paths its unit file names, plus paths its own environment files name (e.g. the controller's TLS key and
  # cognition key, set in service.env). Only path names are extracted; no value is printed.
  envs=$(systemctl show -p EnvironmentFiles --value "$u" | grep -oE "$CONF/[A-Za-z0-9._/-]+")
  own=$( { systemctl cat "$u" 2>/dev/null | grep -vE '^\s*#|^InaccessiblePaths' | grep -oE "$CONF/[A-Za-z0-9._/-]+"
           for e in $envs; do [[ -f "$e" ]] && grep -oE "$CONF/[A-Za-z0-9._/-]+" "$e"; done; } | sort -u)
  if [[ -n "$groups" ]]; then G=(--groups="$groups"); else G=(--clear-groups); fi
  as_unit() { nsenter -t "$pid" -m -- setpriv --reuid="$uid" --regid="$gid" "${G[@]}" "$@"; }
  # The probe itself must work, or every "cannot read" below would be meaningless.
  if ! as_unit true 2>/dev/null; then bad=1; printf '  %-58s %s\n' "$u" "ERROR: cannot enter its namespace as its user — not checked"; continue; fi
  readable=()
  for f in "${FILES[@]}"; do
    if as_unit test -r "$f" 2>/dev/null; then
      mine=0; while read -r o; do [[ -n "$o" && ( "$f" == "$o" || "$f" == "$o"/* ) ]] && mine=1; done <<< "$own"
      # Its own by ownership: the file's owner is the unit's user, or its group is one of the unit's groups
      # (each service's files are root:<its own user> 0640 — e.g. its own earlier backups).
      read -r fu fg fm <<< "$(stat -c '%u %g %a' "$f")"
      [[ "$fu" == "$uid" || "$fg" == "$gid" || ",$groups," == *",$fg,"* ]] && mine=1
      # World-readable files are public configuration; only the known public ones pass (a secret saved with the
      # wrong mode is still reported below, in the public-files section).
      (( fm % 10 >= 4 )) && public_ok "$f" && mine=1
      (( mine )) || readable+=("${f#$CONF/}")
    fi
  done
  if (( ${#readable[@]} )); then bad=1; printf '  %-58s READS FOREIGN: %s\n' "$u" "${readable[*]}"
  else printf '  %-58s %s\n' "$u" "reads none of the other services' configuration"; fi
done
(( n )) || { echo "no running Fleet units found"; exit 2; }
(( bad )) && { echo "ISOLATION CHECK FAILED — a unit can read another service's secrets: stop it and investigate"; exit 1; }
echo "ISOLATION CHECK PASSED: $n running units"
