#!/usr/bin/env bash
# Automaton Fleet — prune old releases (2026-10-21: every release was kept; the disk filled and a cutover failed).
#
#   bash scripts/fleet-release-prune.sh [--keep N] [--apply]
#
# Keeps, always: the current release, every release a founder unit or a registered agent runs, and the N most recent
# other releases (default 3: rollback targets). Everything else under /opt/automaton-fleet/releases (40-hex directories
# only) and the matching build copies in ~/.cache/automaton-fleet/stage are listed; with --apply they are deleted. A dry run
# is the default. Never touches the database, backups, logs or the UI directories. Each pruned release can be rebuilt from git.
set -euo pipefail
KEEPN=3; APPLY=0
while [[ $# -gt 0 ]]; do case "$1" in --keep) KEEPN="$2"; shift 2;; --apply) APPLY=1; shift;; *) echo "usage: fleet-release-prune.sh [--keep N] [--apply]" >&2; exit 2;; esac; done
[[ "$KEEPN" =~ ^[0-9]+$ ]] || { echo "--keep N" >&2; exit 2; }
ROOT="${FLEET_PRUNE_ROOT:-/opt/automaton-fleet}"; STAGE="${FLEET_PRUNE_STAGE:-$HOME/.cache/automaton-fleet/stage}"
pinned_agents() { sudo -n -u postgres psql -X -q -At -d automaton_fleet -c "SELECT DISTINCT runtime_commit FROM fleet.fleet_agents WHERE status NOT IN ('dead','failed') AND runtime_commit IS NOT NULL"; }
pinned_units() { sudo -n grep -rhoE "releases/[0-9a-f]{40}" /etc/systemd/system /run/systemd/system 2>/dev/null | cut -d/ -f2 | sort -u; }
rm_dir() { sudo -n rm -rf --one-file-system "$1"; }
[[ -n "${FLEET_PRUNE_STUBS:-}" ]] && source "$FLEET_PRUNE_STUBS"
cur=$(basename "$(readlink -f "$ROOT/current")")
[[ "$cur" =~ ^[0-9a-f]{40}$ ]] || { echo "the current release is unreadable: nothing pruned" >&2; exit 1; }
keep=" $cur $(pinned_agents | tr '\n' ' ') $(pinned_units | tr '\n' ' ') "
n=0
for b in $(ls -t "$ROOT/releases"); do
  [[ "$b" =~ ^[0-9a-f]{40}$ ]] || continue
  [[ "$keep" == *" $b "* ]] && continue
  if (( n < KEEPN )); then keep="$keep$b "; n=$((n+1)); fi
done
del=()
for b in $(ls "$ROOT/releases"); do [[ "$b" =~ ^[0-9a-f]{40}$ && "$keep" != *" $b "* ]] && del+=("$b"); done
echo "keep: $(for k in $keep; do printf '%s ' "${k:0:7}"; done)"
echo "prune ${#del[@]} release(s): $(for d in "${del[@]}"; do printf '%s ' "${d:0:7}"; done)"
if (( APPLY )); then
  for d in "${del[@]}"; do rm_dir "$ROOT/releases/$d"; [[ -d "$STAGE/$d" ]] && rm -rf --one-file-system "${STAGE:?}/$d"; done
  echo "pruned ${#del[@]}; free now $(df -Pm "$ROOT" | awk 'NR == 2 {print $4}') MB"
else
  echo "(dry run: --apply deletes them)"
fi
