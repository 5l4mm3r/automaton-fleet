#!/usr/bin/env bash
# Automaton Fleet — ONE production release, atomic at release level: backend cutover + UI promotion + root verification.
#
#   bash scripts/fleet-release.sh <pinsFile> <fromSchema> <toSchema> <uiName> <ui.tgz> <uiSha256>
#
#   0. preflight, before anything changes: enough free disk for the release (FLEET_RELEASE_MIN_FREE_MB, default 4096 —
#      2026-10-21 a cutover failed with "No space left on device": prune old releases with fleet-release-prune.sh), the UI step's own checks (fleet-ui-deploy.sh --check: an unchanged UI that is
#      already served or present byte-identical is a success; a served directory that differs is refused), then a
#      snapshot of dashboard.env exactly as it is live now (dashboard.env.before-release-<commit7>-<stamp>).
#   1. backend: scripts/fleet-rollout.sh cutover (fresh verified dump, migrate, re-run, reconciliation, approval,
#      services; it rolls itself back on any failure and then records production_rolled_back). Its own
#      production_deployed is DEFERRED: the release is not done yet.
#   2. UI: scripts/fleet-ui-deploy.sh <uiName> (an immutable directory, only FLEET_DASHBOARD_STATIC_DIR changes, only
#      the dashboard restarts; it restores the previous UI itself if the dashboard does not serve the new tree; an
#      unchanged, already-served UI is verified and nothing is switched).
#   3. root verification through the PUBLIC edge (https://admin.agentfleet.vip via the local nginx): /, /login/ and
#      /hq-preview/login/ are byte-identical to the new tree, an unauthenticated read is refused, the controller is
#      ready on schema <toSchema>.
#   4. ONLY THEN one production_deployed event (P2 in Fleet Command).
# If step 2 or 3 fails after the backend succeeded: the UI that was live immediately before this release (the step-0
# snapshot — never an older dashboard.env.pre-<name> from an earlier deployment) is restored and verified, then the
# backend is reverted with the rehearsed restore (fleet-rollout.sh revert: the cutover's verified pre-migration dump, the previous runtime.env and
# release), and only after that completes ONE production_rolled_back event is recorded (P0). Fleet Command sees exactly
# one outcome per release.
set -euo pipefail
PINS="${1:-}"; FROM="${2:-}"; TO="${3:-}"; UINAME="${4:-}"; UITGZ="${5:-}"; UISHA="${6:-}"
die() { echo "RELEASE REFUSED: $*" >&2; exit 2; }
[[ -f "$PINS" && "$FROM" =~ ^[0-9]{1,3}$ && "$TO" =~ ^[0-9]{1,3}$ ]] || die "usage: fleet-release.sh <pinsFile> <from> <to> <uiName> <ui.tgz> <uiSha256>"
[[ "$UINAME" =~ ^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$ && -f "$UITGZ" && "$UISHA" =~ ^[0-9a-f]{64}$ ]] || die "UI name, tarball and sha256 are required"
[[ "$(sha256sum "$UITGZ" | cut -c1-64)" == "$UISHA" ]] || die "UI tarball checksum mismatch (nothing was changed)"
C=$(sed -n 's/^FLEET_RUNTIME_COMMIT=\([0-9a-f]\{40\}\)$/\1/p' "$PINS"); [[ -n "$C" ]] || die "pins: no commit"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROLLOUT="${FLEET_RELEASE_ROLLOUT:-$HERE/fleet-rollout.sh}"; UIDEPLOY="${FLEET_RELEASE_UIDEPLOY:-$HERE/fleet-ui-deploy.sh}"
UIDIR=/opt/automaton-fleet/ui/$UINAME; ENVD=/etc/automaton-fleet/dashboard.env; ORIGIN=https://admin.agentfleet.vip
ts() { date -u +%FT%TZ; }
free_mb() { df -Pm /opt/automaton-fleet | awk 'NR == 2 {print $4}'; }
record() { sudo -u postgres psql -X -At -d automaton_fleet -c "SELECT fleet.fleet_event('$1', NULL, 'operator:release', jsonb_build_object('commit', '${C:0:12}', 'fromSchema', $FROM, 'toSchema', $TO, 'ui', '$UINAME'$2))" > /dev/null; }
edge_sha() { curl -s --max-time 10 --resolve admin.agentfleet.vip:443:127.0.0.1 "$ORIGIN$1" | sha256sum | cut -c1-64; }
verify_root() {
  [[ "$(edge_sha /)" == "$(sha256sum "$UIDIR/index.html" | cut -c1-64)" ]] || { echo "root / is not the new UI"; return 1; }
  [[ "$(edge_sha /login/)" == "$(sha256sum "$UIDIR/login/index.html" | cut -c1-64)" ]] || { echo "/login/ is not the new UI"; return 1; }
  if [[ -f "$UIDIR/hq-preview/login/index.html" ]]; then [[ "$(edge_sha /hq-preview/login/)" == "$(sha256sum "$UIDIR/hq-preview/login/index.html" | cut -c1-64)" ]] || { echo "/hq-preview/ is not the new UI"; return 1; }; fi
  [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve admin.agentfleet.vip:443:127.0.0.1 "$ORIGIN/api/read?op=agents&args=%7B%7D")" == 401 ]] || { echo "unauthenticated read not refused"; return 1; }
  [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:8787/readyz)" == 200 ]] || { echo "controller not ready"; return 1; }
  [[ "$(sudo -u postgres psql -X -At -d automaton_fleet -c 'SELECT max(version) FROM fleet.fleet_schema_migrations')" == "$TO" ]] || { echo "schema is not $TO"; return 1; }
}
# The UI exactly as it was live before this release: the step-0 snapshot of dashboard.env is put back (only if it changed;
# then only the dashboard restarts) and the loopback listener must serve that directory's index.html again.
served_sha() { curl -s --max-time 10 http://127.0.0.1:8790/ | sha256sum | cut -c1-64; }
ui_restore() {
  if ! sudo cmp -s "$ENV_BEFORE" "$ENVD"; then sudo cp -p "$ENV_BEFORE" "$ENVD"; sudo systemctl restart automaton-fleet-dashboard.service; fi
  local ok=0; for _ in $(seq 1 20); do [[ "$(served_sha)" == "$(sudo sha256sum "$UI_BEFORE/index.html" | cut -c1-64)" ]] && { ok=1; break; }; sleep 1; done
  if [[ $ok == 1 ]]; then echo "UI restored to $UI_BEFORE (live immediately before this release)"; else echo "!! the dashboard does not serve $UI_BEFORE after the restore — INVESTIGATE"; fi
}
# (tests only: replace the functions above with stubs)
if [[ -n "${FLEET_RELEASE_STUBS:-}" ]]; then source "$FLEET_RELEASE_STUBS"; fi

echo "== RELEASE ${C:0:7} (schema $FROM -> $TO, UI $UINAME) start $(ts)"
# 0. Preflight (nothing changes if refused), then the snapshot of the UI live now.
MINFREE="${FLEET_RELEASE_MIN_FREE_MB:-4096}"; FREE="$(free_mb)"
[[ "$FREE" =~ ^[0-9]+$ ]] && (( FREE >= MINFREE )) || die "only ${FREE:-?} MB free on /opt/automaton-fleet (needs $MINFREE MB): prune old releases first (scripts/fleet-release-prune.sh); nothing was changed"
sudo bash "$UIDEPLOY" --check "$UINAME" "$UITGZ" "$UISHA" || die "the UI step would refuse (nothing was changed)"
UI_BEFORE=$(sudo sed -n 's/^FLEET_DASHBOARD_STATIC_DIR=//p' "$ENVD"); [[ -n "$UI_BEFORE" ]] || die "the live UI directory is unreadable"
ENV_BEFORE="$ENVD.before-release-${C:0:7}-$(date -u +%Y%m%dT%H%M%SZ)"; sudo test ! -e "$ENV_BEFORE" || die "$ENV_BEFORE exists"
sudo cp -p "$ENVD" "$ENV_BEFORE"; echo "UI live now: $UI_BEFORE (dashboard.env snapshot $ENV_BEFORE)"
# 1. Backend (rolls itself back and records production_rolled_back on its own failure).
if ! FLEET_ROLLOUT_DEFER_EVENT=1 bash "$ROLLOUT" cutover "$PINS" "$FROM" "$TO"; then
  echo "== RELEASE ${C:0:7} FAILED at the backend cutover (it rolled back by itself); UI unchanged $(ts)"; exit 1
fi
backend_revert() {
  echo "!! $1 — restoring the previous UI, then reverting the backend $(ts)"
  ui_restore
  if FLEET_REVERT_IN_RELEASE=1 bash "$ROLLOUT" revert "$PINS" "$FROM" "$TO" "release step failed: $1"; then
    echo "== RELEASE ${C:0:7} ROLLED BACK $(ts): UI and backend restored (production_rolled_back recorded)"; exit 1
  fi
  echo "== RELEASE ${C:0:7}: BACKEND REVERT FAILED $(ts) — INVESTIGATE NOW (rollback point in ~/rollout-${C:0:7}-cutover.state)"; exit 3
}
# 2. UI promotion (restores the previous UI itself on its own failure).
sudo bash "$UIDEPLOY" "$UINAME" "$UITGZ" "$UISHA" || backend_revert "UI promotion failed"
# 3. The public root serves the new release.
WHY=$(verify_root) || backend_revert "root verification failed: $WHY"
# 4. One outcome for Fleet Command.
record production_deployed ", 'previous', '$(sed -n 's/^OLD=//p' ~/rollout-${C:0:7}-cutover.state 2>/dev/null | cut -c1-12)'"
echo "UI rollback (to the UI live before this release): sudo cp -p $ENV_BEFORE $ENVD && sudo systemctl restart automaton-fleet-dashboard.service"
echo "backend rollback: bash $ROLLOUT revert $PINS $FROM $TO <reason>  (pre-migration dump: $(sed -n 's/^DUMP=//p' ~/rollout-${C:0:7}-cutover.state 2>/dev/null))"
echo "== RELEASE ${C:0:7} DEPLOYED $(ts): schema $TO, root UI $UINAME (production_deployed recorded)"
