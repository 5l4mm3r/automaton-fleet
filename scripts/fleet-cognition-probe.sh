#!/usr/bin/env bash
# L14 provider compatibility probe (run on the controller host with sudo):
#
#   sudo scripts/fleet-cognition-probe.sh [--prices <in>,<out>[,<cacheWrite>,<cacheRead>]]   (microcents per token)
#
# Reads ONLY the FLEET_COGNITION_* settings from the controller's service.env
# (never its database URLs) and runs the probe from the installed release as
# the fleet service user, the only user that can read the inference credential.
# No founder, no Genesis, no database, no ledger. Prints classified results only;
# the credential and provider response bodies are never printed.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }
ENVF=${FLEET_SERVICE_ENV_FILE:-/etc/automaton-fleet/service.env}
REL=${FLEET_RELEASE_DIR:-/opt/automaton-fleet/current}
NODE=${FLEET_NODE:-/opt/automaton-fleet/node/bin/node}
USER_=${FLEET_SERVICE_USER:-automaton-fleet-service}
prices=""
if [[ "${1:-}" == "--prices" ]]; then
  [[ "${2:-}" =~ ^[0-9]{1,9},[0-9]{1,9}(,[0-9]{1,9},[0-9]{1,9})?$ ]] || { echo "--prices wants <in>,<out>[,<cacheWrite>,<cacheRead>] microcents per token" >&2; exit 2; }
  prices="$2"
fi
[[ -f "$ENVF" ]] || { echo "missing $ENVF" >&2; exit 2; }
args=()
while IFS= read -r line; do
  [[ "$line" =~ ^(FLEET_COGNITION_(PROVIDER|BASE_URL|MODEL|API_KEY_FILE|MAX_TOKENS_PARAM|ATTEMPT_TIMEOUT_MS|MAX_ATTEMPTS|DEADLINE_MS|ANTHROPIC_VERSION|ANTHROPIC_BETA|THINKING|EFFORT))=([A-Za-z0-9._:/@,-]{0,512})$ ]] || continue
  args+=("${BASH_REMATCH[1]}=${BASH_REMATCH[3]}")
done < <(grep -E '^FLEET_COGNITION_' "$ENVF" || true)
[[ -n "$prices" ]] && args+=("FLEET_PROBE_PRICES=$prices")
# Post-Genesis diagnosis mode (structure-only output): FLEET_PROBE_MODE=context-repro [FLEET_REPRO_TURNS=N]
[[ "${FLEET_PROBE_MODE:-}" == "context-repro" ]] && args+=("FLEET_PROBE_MODE=context-repro")
[[ "${FLEET_REPRO_TURNS:-}" =~ ^[1-8]$ ]] && args+=("FLEET_REPRO_TURNS=$FLEET_REPRO_TURNS")
exec runuser -u "$USER_" -- env -i PATH=/usr/bin:/bin HOME=/nonexistent NODE_ENV=production "${args[@]}" \
  "$NODE" "$REL/dist/fleet/cognition/probe-main.js"
