#!/usr/bin/env bash
# Automaton Fleet — prune old releases (2026-10-21: every release was kept; the disk filled and a cutover failed).
#
#   bash scripts/fleet-release-prune.sh [--keep N] [--apply]
#
# Keeps, always: the current release; every release a founder unit or a living agent runs; the ROLLBACK TARGETS — the
# controller release the current one replaced (OLD= in ~/rollout-<current>-cutover.state, what `fleet-rollout.sh revert`
# returns to) and each living agent's latest committed/verified runtime upgrade's from_commit (what `fleet-founders.sh
# rollback-runtime` returns to; it verifies that build on disk); and the N most recent other releases (default 3).
# Everything else under /opt/automaton-fleet/releases (40-hex directories only) and the matching build copies in
# ~/.cache/automaton-fleet/stage are listed; with --apply they are deleted. A dry run is the default; --apply refuses when the
# controller's rollback target cannot be read. Never touches the database, backups, logs or the UI directories. A pruned
# release can be rebuilt from git (fleet-stage), never restored from here.
#
# Maintenance procedure (not scheduled — deleting is the owner's step): after each successful release, run the dry run,
# check the keep list names the current release and its rollback targets, then --apply. fleet-release.sh refuses to start
# below FLEET_RELEASE_MIN_FREE_MB (4 GB) free, and the heartbeat alerts at 90 % disk use.
set -euo pipefail
KEEPN=3; APPLY=0
while [[ $# -gt 0 ]]; do case "$1" in --keep) KEEPN="$2"; shift 2;; --apply) APPLY=1; shift;; *) echo "usage: fleet-release-prune.sh [--keep N] [--apply]" >&2; exit 2;; esac; done
[[ "$KEEPN" =~ ^[0-9]+$ ]] || { echo "--keep N" >&2; exit 2; }
ROOT="${FLEET_PRUNE_ROOT:-/opt/automaton-fleet}"; STAGE="${FLEET_PRUNE_STAGE:-$HOME/.cache/automaton-fleet/stage}"
pinned_agents() { sudo -n -u postgres psql -X -q -At -d automaton_fleet -c "SELECT DISTINCT runtime_commit FROM fleet.fleet_agents WHERE status NOT IN ('dead','failed') AND runtime_commit IS NOT NULL"; }
rollback_agents() { sudo -n -u postgres psql -X -q -At -d automaton_fleet -c "SELECT DISTINCT ON (u.agent_id) u.from_commit FROM fleet.fleet_founder_runtime_upgrades u JOIN fleet.fleet_agents a USING (agent_id) WHERE a.status NOT IN ('dead','failed') AND u.status IN ('committed','verified') ORDER BY u.agent_id, u.seq DESC"; }
rollback_controller() { local f="$HOME/rollout-${1:0:7}-cutover.state"; [[ -f "$f" ]] || return 0; sed -n 's/^OLD=\([0-9a-f]\{40\}\)$/\1/p' "$f" | head -1; }
pinned_units() { sudo -n grep -rhoE "releases/[0-9a-f]{40}" /etc/systemd/system /run/systemd/system 2>/dev/null | cut -d/ -f2 | sort -u; }
rm_dir() { sudo -n rm -rf --one-file-system "$1"; }
[[ -n "${FLEET_PRUNE_STUBS:-}" ]] && source "$FLEET_PRUNE_STUBS"
cur=$(basename "$(readlink -f "$ROOT/current")")
[[ "$cur" =~ ^[0-9a-f]{40}$ ]] || { echo "the current release is unreadable: nothing pruned" >&2; exit 1; }
back=$(rollback_controller "$cur")
if [[ ! "$back" =~ ^[0-9a-f]{40}$ ]]; then
  echo "!! the controller's rollback target is unreadable (~/rollout-${cur:0:7}-cutover.state OLD=)" >&2
  (( APPLY )) && { echo "nothing pruned" >&2; exit 1; }
  back=""
fi
pa=$(pinned_agents) || { echo "the agents' releases are unreadable: nothing pruned" >&2; exit 1; }   # fail closed
ra=$(rollback_agents) || { echo "the agents' rollback targets are unreadable: nothing pruned" >&2; exit 1; }
keep=" $cur $back $(tr '\n' ' ' <<< "$pa") $(tr '\n' ' ' <<< "$ra") $(pinned_units | tr '\n' ' ') "
n=0
for b in $(ls -t "$ROOT/releases"); do
  [[ "$b" =~ ^[0-9a-f]{40}$ ]] || continue
  [[ "$keep" == *" $b "* ]] && continue
  if (( n < KEEPN )); then keep="$keep$b "; n=$((n+1)); fi
done
del=()
for b in $(ls "$ROOT/releases"); do [[ "$b" =~ ^[0-9a-f]{40}$ && "$keep" != *" $b "* ]] && del+=("$b"); done
echo "rollback targets: controller ${back:0:7} (replaced by ${cur:0:7}); agents $(cut -c1-7 <<< "$ra" | tr '\n' ' ')"
miss=""; for t in $back $ra; do [[ -d "$ROOT/releases/$t" ]] || miss="$miss${t:0:7} "; done
[[ -n "$miss" ]] && echo "!! rollback target(s) NOT on disk: $miss— rebuild from git (fleet-stage) before relying on that rollback"
echo "keep: $(for k in $keep; do printf '%s\n' "${k:0:7}"; done | awk '!seen[$0]++' | tr '\n' ' ')"
echo "prune ${#del[@]} release(s): $(for d in "${del[@]}"; do printf '%s ' "${d:0:7}"; done)"
if (( APPLY )); then
  for d in "${del[@]}"; do rm_dir "$ROOT/releases/$d"; [[ -d "$STAGE/$d" ]] && rm -rf --one-file-system "${STAGE:?}/$d"; done
  echo "pruned ${#del[@]}; free now $(df -Pm "$ROOT" | awk 'NR == 2 {print $4}') MB"
else
  echo "(dry run: --apply deletes them)"
fi
