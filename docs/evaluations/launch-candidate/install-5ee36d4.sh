#!/usr/bin/env bash
# Install 5ee36d4 (Group B) and move Agent-1 onto it (Group C, Agent-1 only). OWNER-RUN; prepared 2026-10-24, NOT run.
#   schema 111 -> 115, UI 0.26.2 unchanged (no dashboard-web change since 89d7c21), founder unit template unchanged.
#   Rehearsed beside production 2026-10-24 (data, services, founder upgrade 27/27, revision 19/19: ~/rlc134/*.log).
# What it does NOT do: activate cognition (policy stays disabled, FLEET_COGNITION_PROVIDER stays none, the retired key stays
# in /etc/automaton-fleet/recovery untouched), set Fleet Control's AI budget, resume an agent, post credit, start paid work,
# touch Agent-2 (runtime b60e262, unit and process unchanged), or restore any database. Automatic database restoration stays
# OFF (FLEET_ROLLOUT_AUTO_RESTORE must be unset): if the cutover fails, its revert refuses, the controller-side units are
# stopped and the owner decides — no restore happens without the owner's explicit approval.
# Run:   ssh -t agentfleet-vps 'bash ~/rlc134/install.sh'
# Re-running after a failure continues: completed steps are detected and skipped; nothing is restored.
#   0. evidence gate (this build's four rehearsals passed, < 24 h), guards, Agent-2's process recorded, a fresh baseline + dump
#   1. release 89d7c21 -> 5ee36d4, schema 111 -> 115 (scripts/fleet-release.sh; ~45 s controller outage)    (skipped if done)
#   2. Agent-1 runtime 89d7c21 -> 5ee36d4: preflight, upgrade-runtime; rollback id recorded              (skipped if done)
#   3. verification; end state: both agents paused, Agent-2 the same process, inference and Fleet Control off
set -uo pipefail
R=~/rlc134
SELF=$(readlink -f "${BASH_SOURCE[0]}"); ARGS=("$@")
if [[ "${FLEET_TEELOG:-}" != "$SELF" ]]; then FLEET_TEELOG="$SELF" bash "$SELF" "${ARGS[@]}" 2>&1 | tee -a "$R/install.log"; exit "${PIPESTATUS[0]}"; fi
unset FLEET_TEELOG
A1=01M3F50SH7PNX2E3GST13J52AS; A2=01M4C4NXT786Q4E9725N5A15KV
C=5ee36d450646402837f36562d7719a01f3a8c86f; BUILD=09d77dac1bc35b0ae58ece38968ed69b1447728e82c3c2eb5f936f6bbb7fdcee
LOCK=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
PREV=89d7c21be73641f08fd99cbb35abb21f0e91af6e; A2_RT=b60e262bf7393e0ea2cca3b491199987f830cb3b
UI=0.26.2; UITGZ=$R/ui-0.26.2-316b27b.tgz; UISHA=77ce19a4e06814b93705b5ae96c705185c91271ce335e95f1341b854f9f0585d
REL=/opt/automaton-fleet/releases/$C
ts() { date -u +%FT%TZ; }
Q() { sudo -n -u postgres psql -X -q -At -d automaton_fleet -c "SET default_transaction_read_only=on; SET search_path=fleet; $1"; }
paused() { Q "SELECT paused FROM fleet_founder_cognition WHERE agent_id = '$1'"; }
rt() { Q "SELECT runtime_commit FROM fleet_agents WHERE agent_id = '$1'"; }
cur() { readlink -f /opt/automaton-fleet/current | xargs basename; }
schema() { Q 'SELECT max(version) FROM fleet_schema_migrations'; }
mainpid() { systemctl show -p MainPID --value automaton-fleet-founder@$1.service; }
inference_off() {
  [[ "$(Q 'SELECT cognition_enabled FROM fleet_cognition_policy WHERE id = 1')" == f ]] || return 1
  sudo -n grep -qx 'FLEET_COGNITION_PROVIDER=none' /etc/automaton-fleet/service.env || return 1
  [[ "$(Q "SELECT fleet_control_ai_state() ->> 'ceilingMinor'")" == "" ]] || return 1
}
tiers() { Q "SELECT string_agg(tier||':'||model||':'||COALESCE(thinking,'-')||':'||COALESCE(effort,'-')||':'||max_output_tokens||':'||enabled, ' ' ORDER BY tier) FROM fleet_cognition_tiers"; }
state() {
  echo "  -- state $(ts): current $(cur | cut -c1-7); schema $(schema); ledger verify $(Q "SELECT fleet_ledger_verify()->>'ok'")"
  echo "     Agent-1 $(rt $A1 | cut -c1-7) paused=$(paused $A1) pid $(mainpid $A1); Agent-2 $(rt $A2 | cut -c1-7) paused=$(paused $A2) pid $(mainpid $A2)"
  echo "     inference off: $(inference_off && echo yes || echo NO); tiers $(tiers)"
}
die() { echo "!! $*"; state; echo "== INSTALL NOT COMPLETE $(ts) — re-run to continue from the failed step; both agents remain paused; nothing was restored"; exit 1; }
closed() {
  [[ "$(Q 'SELECT count(*) FROM fleet_outward_release WHERE expires_at > now()')" == 0 ]] || return 1
  [[ "$(Q 'SELECT card_enabled OR enabled FROM fleet_identity_autonomy')" == f ]] || return 1
  [[ "$(Q 'SELECT custody_activation_id IS NULL FROM fleet_economic_model WHERE id = 1')" == t ]] || return 1
  [[ "$(Q 'SELECT fleet_sales_open()')" == f ]] || return 1
  [[ "$(Q "SELECT count(*) FROM fleet_refund_authorities a WHERE fleet_refund_authority_live(a)")" == 0 ]] || return 1
}
sudo -v || exit 2
echo "== install ${C:0:7} (release ${PREV:0:7} -> ${C:0:7}; schema 111 -> 115; Agent-1 only) start $(ts)"

echo "== 0. evidence gate + guards + baseline"
[[ -z "${FLEET_ROLLOUT_AUTO_RESTORE:-}" ]] || die "FLEET_ROLLOUT_AUTO_RESTORE is set: automatic database restoration must stay off"
[[ "$(sed -n 's/^FLEET_RUNTIME_COMMIT=//p' $R/pins.txt)" == "$C" && "$(sed -n 's/^FLEET_RUNTIME_BUILD_ID=//p' $R/pins.txt)" == "$BUILD" \
   && "$(sed -n 's/^FLEET_RUNTIME_LOCKFILE_SHA256=//p' $R/pins.txt)" == "$LOCK" ]] || die "the staged pins are not ${C:0:7} / ${BUILD:0:12}"
grep -q "REHEARSAL PASSED" $R/rehearse.log || die "no passed data rehearsal of ${C:0:7}"
grep -q "UPGRADE REHEARSAL PASSED" $R/upgrade-rehearsal.log || die "no passed services rehearsal of ${C:0:7}"
for f in founder-upgrade-rehearsal.log revision-rehearsal.log; do python3 $R/rehearsal-verdict.py $R/$f >/dev/null || die "$f did not pass"; done
grep -q '"complete": true' $R/revision-rehearsal.log || die "the revision rehearsal did not run its renderer phase"
grep -q "$C" $R/founder-upgrade-rehearsal.log && grep -q "$C" $R/revision-rehearsal.log || die "the founder rehearsals are not of ${C:0:7}"
for f in rehearse.log upgrade-rehearsal.log founder-upgrade-rehearsal.log revision-rehearsal.log; do
  age=$(( $(date +%s) - $(stat -c %Y $R/$f) )); (( age < 86400 )) || die "$f is older than 24 h: the rehearsals must be run again (owner approval)"; done
[[ "$(sha256sum $UITGZ | cut -c1-64)" == "$UISHA" ]] || die "UI package checksum differs"
[[ -d $REL ]] || die "the release directory installed beside production is missing"
[[ "$(paused $A1)" == t && "$(paused $A2)" == t ]] || die "both agents must be paused"
[[ "$(rt $A2)" == "$A2_RT" ]] || die "Agent-2 is not on ${A2_RT:0:7}"
[[ "$(rt $A1)" == "$PREV" || "$(rt $A1)" == "$C" ]] || die "Agent-1 is on $(rt $A1 | cut -c1-7)"
inference_off || die "inference is not off (policy disabled, provider none, Fleet Control budget unset)"
closed || die "a permission is open (outward release, card, payouts, sales or a refund authority)"
for k in REAL_REPLICATION_ENABLED REAL_PAYMENTS_ENABLED OWNER_SWEEP_ENABLED FLEET_DRY_RUN_CHILD; do grep -qx "$k=false" /etc/automaton-fleet/runtime.env || die "$k is not false"; done
case "$(schema)" in 111) [[ "$(cur)" == "$PREV" ]] || die "schema 111 without ${PREV:0:7}";; 115) [[ "$(cur)" == "$C" ]] || die "schema 115 without ${C:0:7}";; *) die "live schema is not 111";; esac
cmp -s $REL/deploy/systemd/automaton-fleet-founder@.service /etc/systemd/system/automaton-fleet-founder@.service || die "the founder unit template differs from the release's (not expected)"
[[ -s $R/agent2-pid.txt ]] || mainpid $A2 > $R/agent2-pid.txt
[[ -s $R/tiers-before.txt ]] || tiers > $R/tiers-before.txt
[[ -s $R/settings-pre-install.json ]] || sudo -n -u postgres psql -X -q -At -d automaton_fleet < $R/settings.sql > $R/settings-pre-install.json
if [[ "$(schema)" == 111 ]]; then
  LABEL=pre-install-${C:0:7}
  bash $R/baseline.sh $LABEL 2>&1 | sed -n "2,4p"
  B=$(ls -d $R/baseline-$LABEL-* | tail -1); [[ -d "$B" ]] || die "no baseline"
  n=$(sudo -n -u postgres pg_restore -l < $B/automaton_fleet-full.dump | wc -l); (( n > 4000 )) || die "baseline dump unreadable ($n entries)"
  echo "  baseline $B ($n dump entries; kept, never restored by this script)"
fi
state

echo "== 1. release ${PREV:0:7} -> ${C:0:7}, schema 111 -> 115 ($(ts))"
if [[ "$(cur)" == "$C" && "$(schema)" == 115 ]]; then echo "  already deployed (skipped)"
else
  bash $REL/scripts/fleet-release.sh $R/pins.txt 111 115 $UI $UITGZ $UISHA > $R/release.log 2>&1; rc=$?
  grep -E "OUTAGE|outage|reconciliation|DEPLOYED|FAILED|REFUSED|ROLLED|restore" $R/release.log | cut -c1-200
  [[ $rc == 0 ]] && grep -q "RELEASE ${C:0:7} DEPLOYED" $R/release.log || die "the release did not deploy (see $R/release.log); no database was restored — the owner decides"
fi
[[ "$(cur)" == "$C" && "$(schema)" == 115 ]] || die "current is not ${C:0:7} on schema 115"
[[ "$(mainpid $A2)" == "$(cat $R/agent2-pid.txt)" ]] || die "Agent-2's process changed during the release"

echo "== 2. Agent-1 runtime ${PREV:0:7} -> ${C:0:7} ($(ts))"
F=/opt/automaton-fleet/current/scripts/fleet-founders.sh
if [[ "$(rt $A1)" == "$C" ]]; then echo "  already upgraded (skipped)"
else
  sudo $F upgrade-preflight $A1 > $R/agent1-preflight.log 2>&1 || { tail -25 $R/agent1-preflight.log; die "Agent-1 preflight failed"; }
  echo "  preflight ok"
  sudo $F upgrade-runtime $A1 > $R/agent1-upgrade.log 2>&1; rc=$?
  UPID=$(grep -oE '"upgradeId": ?"[0-9a-f-]{36}"' $R/agent1-upgrade.log | head -1 | grep -oE '[0-9a-f-]{36}')
  echo "  upgradeId ${UPID:-unknown} (rollback, owner gate: sudo $F rollback-runtime $A1 ${UPID:-<upgradeId>} <reason>)"
  [[ -n "${UPID:-}" ]] && echo "$UPID" > $R/agent1-upgrade-id.txt
  [[ $rc == 0 ]] || { grep -E '"outcome"|"why"|"error"' $R/agent1-upgrade.log | head -5 | cut -c1-200; die "Agent-1 upgrade failed (see $R/agent1-upgrade.log)"; }
  grep -qE '"outcome": ?"verified"' $R/agent1-upgrade.log || die "Agent-1's upgrade did not report outcome verified"
fi
[[ "$(rt $A1)" == "$C" ]] || die "Agent-1 is not registered on ${C:0:7}"

echo "== 3. verification ($(ts))"
[[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:8787/readyz)" == 200 ]] || die "controller not ready"
[[ "$(paused $A1)" == t && "$(paused $A2)" == t ]] || die "an agent is not paused"
[[ "$(rt $A2)" == "$A2_RT" && "$(mainpid $A2)" == "$(cat $R/agent2-pid.txt)" ]] || die "Agent-2's runtime or process changed"
inference_off || die "inference is not off after the install"
[[ "$(tiers)" == "$(cat $R/tiers-before.txt)" ]] || die "a model tier changed: $(tiers)"
[[ "$(Q 'SELECT profile FROM fleet_inference_profile WHERE id = 1')" == cloud_allowed ]] || die "v112 did not record the existing cloud configuration as kept"
grep -qE "FOUNDER_STEP_MAX_OUTPUT_TOKENS = (4_000|4000|4e3)\b" $REL/dist/fleet/cognition/routed-gateway.js || die "the release lacks the 4,000-token founder step"
grep -q "FLEET_REVIEW_CLASSIFY_FIRST" $REL/dist/fleet/founder/toolbox.js || die "the release lacks the v115 revision review"
for k in REAL_REPLICATION_ENABLED REAL_PAYMENTS_ENABLED OWNER_SWEEP_ENABLED FLEET_DRY_RUN_CHILD; do grep -qx "$k=false" /etc/automaton-fleet/runtime.env || die "$k is not false"; done
closed || die "a permission is open after the install"
[[ "$(Q "SELECT fleet_ledger_verify()->>'ok'")" == true ]] || die "ledger verification failed"
sudo -n -u postgres psql -X -q -At -d automaton_fleet < $R/settings.sql > $R/settings-post-install.json
state
echo "== INSTALL COMPLETE $(ts): ${C:0:7} on schema 115; Agent-1 on ${C:0:7} PAUSED; Agent-2 on ${A2_RT:0:7} PAUSED (same process); inference off; Fleet Control budget unset"
