#!/usr/bin/env bash
# Automaton Fleet — ONE production release, atomic at release level: backend cutover + UI promotion + root verification.
#
#   bash scripts/fleet-release.sh <pinsFile> <fromSchema> <toSchema> <uiName> <ui.tgz> <uiSha256>
#
#   1. backend: scripts/fleet-rollout.sh cutover (fresh verified dump, migrate, re-run, reconciliation, approval,
#      services; it rolls itself back on any failure and then records production_rolled_back). Its own
#      production_deployed is DEFERRED: the release is not done yet.
#   2. UI: scripts/fleet-ui-deploy.sh <uiName> (a new immutable directory, only FLEET_DASHBOARD_STATIC_DIR changes, only
#      the dashboard restarts; it restores the previous UI itself if the dashboard does not serve the new tree).
#   3. root verification through the PUBLIC edge (https://admin.agentfleet.vip via the local nginx): /, /login/ and
#      /hq-preview/login/ are byte-identical to the new tree, an unauthenticated read is refused, the controller is
#      ready on schema <toSchema>.
#   4. ONLY THEN one production_deployed event (P2 in Fleet Command).
# If step 2 or 3 fails after the backend succeeded: the previous UI is restored, then the backend is reverted with the
# rehearsed restore (fleet-rollout.sh revert: the cutover's verified pre-migration dump, the previous runtime.env and
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
ui_restore() { if sudo test -f "$ENVD.pre-$UINAME" && sudo grep -qx "FLEET_DASHBOARD_STATIC_DIR=$UIDIR" "$ENVD"; then sudo cp -p "$ENVD.pre-$UINAME" "$ENVD"; sudo systemctl restart automaton-fleet-dashboard.service; echo "previous UI restored ($(sudo sed -n 's/^FLEET_DASHBOARD_STATIC_DIR=//p' "$ENVD"))"; fi; }
# (tests only: replace the functions above with stubs)
if [[ -n "${FLEET_RELEASE_STUBS:-}" ]]; then source "$FLEET_RELEASE_STUBS"; fi

echo "== RELEASE ${C:0:7} (schema $FROM -> $TO, UI $UINAME) start $(ts)"
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
echo "UI rollback: sudo cp -p $ENVD.pre-$UINAME $ENVD && sudo systemctl restart automaton-fleet-dashboard.service"
echo "backend rollback: bash $ROLLOUT revert $PINS $FROM $TO <reason>  (pre-migration dump: $(sed -n 's/^DUMP=//p' ~/rollout-${C:0:7}-cutover.state 2>/dev/null))"
echo "== RELEASE ${C:0:7} DEPLOYED $(ts): schema $TO, root UI $UINAME (production_deployed recorded)"
