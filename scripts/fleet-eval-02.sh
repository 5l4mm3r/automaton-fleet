#!/usr/bin/env bash
# F1-EVAL-02 evaluation runner (run on the controller host with sudo; request JSON on stdin):
#
#   sudo scripts/fleet-eval-02.sh < request.json
#
# Like the L14 probe: reads ONLY the FLEET_COGNITION_* settings from the controller's service.env (never its
# database URLs) and runs the evaluation code of the tree this script belongs to (a root-owned, read-only
# evaluation tree; never /opt/automaton-fleet/current, never the founder's release) as the fleet service user,
# the only user that can read the inference credential. No founder, registry, database or ledger is involved.
# The controller's own configuration is not changed: evaluation model/effort apply to this process only.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }
ENVF=${FLEET_SERVICE_ENV_FILE:-/etc/automaton-fleet/service.env}
TREE="$(cd "$(dirname "$0")/.." && pwd)"
NODE=${FLEET_NODE:-/opt/automaton-fleet/node/bin/node}
USER_=${FLEET_SERVICE_USER:-automaton-fleet-service}
case "$TREE" in /opt/automaton-fleet/eval/*) ;; *) echo "refusing: not an evaluation tree ($TREE)" >&2; exit 2 ;; esac
[[ "$(stat -c %U "$TREE")" == root ]] || { echo "refusing: the evaluation tree must be root-owned" >&2; exit 2; }
[[ -f "$TREE/dist/fleet/eval/f1-eval-02-main.js" ]] || { echo "missing compiled evaluation code" >&2; exit 2; }
[[ -f "$ENVF" ]] || { echo "missing $ENVF" >&2; exit 2; }
args=()
while IFS= read -r line; do
  [[ "$line" =~ ^(FLEET_COGNITION_(PROVIDER|BASE_URL|MODEL|API_KEY_FILE|ATTEMPT_TIMEOUT_MS|MAX_ATTEMPTS|DEADLINE_MS|ANTHROPIC_VERSION|ANTHROPIC_BETA|THINKING|EFFORT))=([A-Za-z0-9._:/@,-]{0,512})$ ]] || continue
  args+=("${BASH_REMATCH[1]}=${BASH_REMATCH[3]}")
done < <(grep -E '^FLEET_COGNITION_' "$ENVF" || true)
cd /
exec runuser -u "$USER_" -- env -i PATH=/usr/bin:/bin HOME=/nonexistent NODE_ENV=production "${args[@]}" \
  "$NODE" "$TREE/dist/fleet/eval/f1-eval-02-main.js"
