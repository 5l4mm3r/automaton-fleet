#!/usr/bin/env bash
# Local-machine readiness (owner directive 2026-10-23): is this Fleet running its reasoning on THIS machine, with no cloud
# inference path left? Read-only; prints PASS/FAIL per check and exits non-zero on any FAIL. Prints no secret.
#
#   sudo scripts/fleet-local-readiness.sh            # all checks
#   sudo scripts/fleet-local-readiness.sh --offline  # also: one model call with the default route removed (run it with the
#                                                     network cable out / Wi-Fi off — the stronger, physical check)
set -uo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }
DB=${FLEET_DB_NAME:-automaton_fleet}; URL=http://127.0.0.1:8090/v1; FAIL=0
pass() { echo "PASS  $*"; }; fail() { echo "FAIL  $*"; FAIL=1; }
Q() { sudo -u postgres psql -X -q -At -d "$DB" -c "SET default_transaction_read_only=on; SET search_path=fleet; $1" 2>/dev/null | grep -v '^SET$'; }

systemctl is-active --quiet automaton-fleet-inference && pass "inference service active" || fail "inference service not active"
MODELS=$(curl -sf -m 5 "$URL/models" | python3 -I -c "import json,sys; print(' '.join(m['id'] for m in json.load(sys.stdin).get('data',[])))" 2>/dev/null)
[[ -n "$MODELS" ]] && pass "local model served: $MODELS" || fail "no model served at $URL"
LISTEN=$(ss -ltnH 'sport = :8090' | awk '{print $4}')
[[ -n "$LISTEN" && "$LISTEN" =~ ^(127\.0\.0\.1|\[::1\]):8090$ ]] && pass "model server bound to loopback only ($LISTEN)" || fail "model server listening on: ${LISTEN:-nothing}"
[[ "$(systemctl show -p IPAddressDeny --value automaton-fleet-inference)" == *"0.0.0.0/0"* || "$(systemctl show -p IPAddressDeny --value automaton-fleet-inference)" == *"::/0"* ]] \
  && pass "inference unit: all network egress denied (IPAddressDeny=any)" || fail "inference unit egress not denied"
E=/etc/automaton-fleet/service.env
grep -q '^FLEET_COGNITION_PROVIDER=local$' "$E" && pass "controller provider: local" || fail "controller provider is not local ($(grep -o '^FLEET_COGNITION_PROVIDER=.*' "$E"))"
grep -q '^FLEET_INFERENCE_PROFILE=cloud_allowed' "$E" && fail "controller profile: cloud_allowed" || pass "controller profile: local_only"
grep -q '^FLEET_COGNITION_API_KEY_FILE=' "$E" && fail "a cognition key file is still configured for the controller" || pass "no cognition key configured for the controller"
LIVE=$(journalctl -u automaton-fleet --since "-2d" --no-pager -o cat | grep -o '"cognitionProvider":"[^"]*"' | tail -1)
[[ "$LIVE" == *'"local:'* ]] && pass "running controller reports $LIVE" || fail "running controller reports ${LIVE:-nothing} (restart it after changing service.env)"
for f in /etc/automaton-fleet/*.key /etc/automaton-fleet/*/cognition*; do
  [[ -e "$f" ]] || continue
  [[ "$f" == /etc/automaton-fleet/recovery/* && "$(stat -c '%U %a' "$f")" == "root 600" ]] && continue
  [[ "$f" == /etc/automaton-fleet/tls/* ]] && continue
  fail "a key file outside the root-only recovery folder: $f"
done
PROFILE=$(Q "SELECT profile FROM fleet_inference_profile WHERE id = 1"); [[ "${PROFILE:-local_only}" == local_only ]] && pass "registry profile: local_only" || fail "registry profile: $PROFILE"
NONLOCAL=$(Q "SELECT count(*) FROM fleet_cognition_tiers WHERE enabled AND provider <> 'local'"); [[ "$NONLOCAL" == 0 ]] && pass "no enabled non-local tier" || fail "$NONLOCAL enabled non-local tier(s)"
POL=$(Q "SELECT cognition_enabled || ' ' || provider FROM fleet_cognition_policy WHERE id = 1"); [[ "$POL" == "t local" || "$POL" == f* ]] && pass "cognition policy: $POL" || fail "cognition policy: $POL"
if [[ "${1:-}" == --offline ]]; then
  DEF=$(ip route show default | head -1)
  [[ -z "$DEF" ]] && pass "no default route (offline)" || echo "NOTE  a default route exists ($DEF): unplug the network for the physical offline test"
  T0=$(date +%s%3N)
  curl -sf -m 300 "$URL/chat/completions" -H 'content-type: application/json' -d "{\"model\":\"${MODELS%% *}\",\"max_tokens\":40,\"chat_template_kwargs\":{\"enable_thinking\":false},\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the word ready.\"}]}" >/dev/null \
    && pass "a model call answered offline in $(( $(date +%s%3N) - T0 )) ms" || fail "the model did not answer offline"
fi
exit $FAIL
