#!/usr/bin/env bash
# v22 routed-cognition verification (run on the controller host with sudo; request JSON on stdin):
#
#   echo '{"mode":"models"}' | sudo scripts/fleet-routing-verify.sh
#   echo '{"mode":"verify","budgetMicrocents":25000000}' | sudo scripts/fleet-routing-verify.sh
#
# Like the L14 probe: only the FLEET_COGNITION_* settings from service.env (never database URLs), the INSTALLED
# release (/opt/automaton-fleet/current, i.e. the deployed code), as the fleet service user — the only user that can
# read the inference credential. No founder, registry, cognition log or ledger is touched; spend is engineering spend.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }
ENVF=${FLEET_SERVICE_ENV_FILE:-/etc/automaton-fleet/service.env}
REL=${FLEET_RELEASE_DIR:-/opt/automaton-fleet/current}
NODE=${FLEET_NODE:-/opt/automaton-fleet/node/bin/node}
USER_=${FLEET_SERVICE_USER:-automaton-fleet-service}
[[ -f "$REL/dist/fleet/eval/routing-verify-main.js" ]] || { echo "the installed release has no routing verifier" >&2; exit 2; }
[[ -f "$ENVF" ]] || { echo "missing $ENVF" >&2; exit 2; }
args=()
while IFS= read -r line; do
  [[ "$line" =~ ^(FLEET_COGNITION_(PROVIDER|BASE_URL|MODEL|API_KEY_FILE|ATTEMPT_TIMEOUT_MS|MAX_ATTEMPTS|DEADLINE_MS|ANTHROPIC_VERSION|ANTHROPIC_BETA|THINKING|EFFORT|PROMPT_CACHE))=([A-Za-z0-9._:/@,+-]{0,512})$ ]] || continue
  args+=("${BASH_REMATCH[1]}=${BASH_REMATCH[3]}")
done < <(grep -E '^FLEET_COGNITION_' "$ENVF" || true)
cd /
exec runuser -u "$USER_" -- env -i PATH=/usr/bin:/bin HOME=/nonexistent NODE_ENV=production "${args[@]}" \
  "$NODE" "$REL/dist/fleet/eval/routing-verify-main.js"
