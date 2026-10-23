#!/usr/bin/env bash
# Point the controller at the LOCAL model (owner directive 2026-10-23) — after scripts/fleet-local-inference-setup.sh.
#
#   sudo scripts/fleet-local-cognition.sh <alias> [--apply]        # dry run without --apply
#
#  1. the local server serves <alias> and answers a tool call (the verification reference for the tiers);
#  2. service.env: FLEET_INFERENCE_PROFILE=local_only, FLEET_COGNITION_PROVIDER=local, the alias and the loopback URL;
#     a cloud key setting is commented out (never deleted, never printed); a timestamped backup is kept;
#  3. the registry (schema >= 112, profile local_only): T1–T3 mapped to the local model (zero provider prices), verified
#     and enabled; the global policy enabled for the local provider;
#  4. the controller restarted; it must report cognitionProvider "local".
# It resumes NO agent and changes no founder's pause, budget or authority.
set -euo pipefail
ALIAS=${1:?alias (e.g. qwen3.5-9b)}; APPLY=${2:-}
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }
URL=http://127.0.0.1:8090/v1; E=/etc/automaton-fleet/service.env
CLI="env -C /opt/automaton-fleet/current /opt/automaton-fleet/node/bin/node dist/fleet/postgres/cli.js"
ACT=$([[ "$APPLY" == --apply ]] && echo yes || echo no)

echo "== 1. the local server"
curl -sf -m 5 "$URL/models" | python3 -I -c "import json,sys; ids=[m['id'] for m in json.load(sys.stdin).get('data',[])]; print('  serving', ids); sys.exit(0 if '$ALIAS' in ids else 1)" \
  || { echo "  $ALIAS is not served at $URL (scripts/fleet-local-inference-setup.sh first)" >&2; exit 1; }
T0=$(date +%s%3N)
SMOKE=$(curl -sf -m 300 "$URL/chat/completions" -H 'content-type: application/json' -d "{\"model\":\"$ALIAS\",\"max_tokens\":200,\"chat_template_kwargs\":{\"enable_thinking\":false},
  \"messages\":[{\"role\":\"user\",\"content\":\"Call list_goals now.\"}],\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"list_goals\",\"description\":\"List your goals.\",\"parameters\":{\"type\":\"object\",\"properties\":{}}}}]}")
MS=$(( $(date +%s%3N) - T0 ))
echo "$SMOKE" | python3 -I -c "import json,sys; c=json.load(sys.stdin)['choices'][0]['message'].get('tool_calls') or []; print('  tool call:', [x['function']['name'] for x in c]); sys.exit(0 if any(x['function']['name']=='list_goals' for x in c) else 1)" \
  || { echo "  the model did not produce the tool call — not verified" >&2; exit 1; }
REF="local server $URL serves $ALIAS; tool-call smoke ok in ${MS} ms ($(date -u +%FT%TZ))"; echo "  $REF"

echo "== 2. service.env"
if [[ $ACT == yes ]]; then
  cp -a "$E" "$E.before-local-$(date -u +%Y%m%dT%H%M%SZ)"
  python3 -I - "$E" "$ALIAS" "$URL" <<'PY'
import sys
p, alias, url = sys.argv[1:]
keep, seen = [], set()
want = {"FLEET_INFERENCE_PROFILE": "local_only", "FLEET_COGNITION_PROVIDER": "local", "FLEET_COGNITION_MODEL": alias, "FLEET_COGNITION_BASE_URL": url}
for line in open(p).read().splitlines():
    k = line.split("=", 1)[0].strip()
    if k in want: keep.append(f"{k}={want[k]}"); seen.add(k); continue
    if k in ("FLEET_COGNITION_API_KEY_FILE", "FLEET_COGNITION_THINKING", "FLEET_COGNITION_EFFORT", "FLEET_COGNITION_PROMPT_CACHE", "FLEET_COGNITION_ANTHROPIC_BETA", "FLEET_COGNITION_ANTHROPIC_VERSION"):
        keep.append(f"# local-only: disabled {k}=<kept in the backup>"); continue
    keep.append(line)
keep += [f"{k}={v}" for k, v in want.items() if k not in seen]
open(p, "w").write("\n".join(keep) + "\n")
PY
  grep -E "^(FLEET_INFERENCE_PROFILE|FLEET_COGNITION_(PROVIDER|MODEL|BASE_URL))=" "$E" | sed 's/^/  /'
else echo "(dry) set FLEET_INFERENCE_PROFILE=local_only FLEET_COGNITION_PROVIDER=local FLEET_COGNITION_MODEL=$ALIAS FLEET_COGNITION_BASE_URL=$URL; comment out cloud key settings"; fi

echo "== 3. the registry"
$CLI inference-profile | python3 -I -c "import json,sys; d=json.load(sys.stdin); print('  profile', d.get('profile')); sys.exit(0 if d.get('profile')=='local_only' else 1)" \
  || { echo "  the registry is not local_only (schema >= 112 required; the owner's profile choice is theirs)" >&2; exit 1; }
for T in T1 T2 T3; do
  MAX=$([[ $T == T1 ]] && echo 2000 || echo 8000)
  if [[ $ACT == yes ]]; then
    $CLI cognition-tier-set-local $T "$ALIAS" --max-output $MAX >/dev/null && $CLI cognition-tier-verify $T "$ALIAS" "$REF" >/dev/null && $CLI cognition-tier-enable $T >/dev/null && echo "  $T -> $ALIAS (local, max output $MAX), verified, enabled"
  else echo "(dry) $T -> $ALIAS (local), verify, enable"; fi
done
if [[ $ACT == yes ]]; then $CLI cognition-enable local "$ALIAS" --max-output 8000 --in-microcents 0 --out-microcents 0 >/dev/null && echo "  policy: local $ALIAS enabled"; else echo "(dry) cognition-enable local $ALIAS"; fi

echo "== 4. the controller"
if [[ $ACT == yes ]]; then
  systemctl restart automaton-fleet.service; sleep 6
  journalctl -u automaton-fleet --since "-30s" --no-pager -o cat | grep -o '"cognitionProvider":"[^"]*"' | tail -1 | sed 's/^/  /'
else echo "(dry) restart automaton-fleet; expect cognitionProvider local:$ALIAS"; fi
echo "== done. No agent was resumed."
