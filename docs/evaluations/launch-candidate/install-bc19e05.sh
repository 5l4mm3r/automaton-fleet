#!/usr/bin/env bash
# Install bc19e05 (funding candidate; Group B). OWNER-APPROVED 2026-10-26 for commit bc19e05 / build 721bb15d.
#   release 5ee36d4 -> bc19e05, schema 115 -> 118 (v116 promotional lots + published draw order + T2 price; v117 Fleet Control
#   funded calls; v118 credit source known before the charge). UI 0.26.2 unchanged (no dashboard-web change); founder unit
#   template unchanged; NO agent runtime change and NO founder restart: both agents stay paused on their runtimes and processes.
# What it does NOT do: post any credit entry, activate cognition (policy disabled, provider none), set Fleet Control's budget,
# resume an agent, touch Agent-1's or Agent-2's runtime or process, or restore any database. Automatic database restoration
# stays OFF (FLEET_ROLLOUT_AUTO_RESTORE must be unset): if the cutover fails after the migration, the controller-side units are
# stopped, the pre-install backup is kept and the owner decides.
# Re-running after a failure continues: completed steps are detected and skipped; nothing is restored.
set -uo pipefail
R=~/rlc135
SELF=$(readlink -f "${BASH_SOURCE[0]}"); ARGS=("$@")
if [[ "${FLEET_TEELOG:-}" != "$SELF" ]]; then FLEET_TEELOG="$SELF" bash "$SELF" "${ARGS[@]}" 2>&1 | tee -a "$R/install.log"; exit "${PIPESTATUS[0]}"; fi
unset FLEET_TEELOG
A1=01M3F50SH7PNX2E3GST13J52AS; A2=01M4C4NXT786Q4E9725N5A15KV
C=bc19e05890773199b794a7a4345ed1c77a6467e1; BUILD=721bb15dfa906bb6e1e37af92b6c8425a64a8bbf8d3f87cdd5d24b6b54ca9ee8
LOCK=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
PREV=5ee36d450646402837f36562d7719a01f3a8c86f; A1_RT=5ee36d450646402837f36562d7719a01f3a8c86f; A2_RT=b60e262bf7393e0ea2cca3b491199987f830cb3b
UI=0.26.2; UITGZ=~/rlc134/ui-0.26.2-316b27b.tgz; UISHA=77ce19a4e06814b93705b5ae96c705185c91271ce335e95f1341b854f9f0585d
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
head_() { Q "SELECT head_seq||' '||head_hash FROM fleet_ledger_head"; }
state() {
  echo "  -- state $(ts): current $(cur | cut -c1-7); schema $(schema); ledger head $(head_ | cut -c1-20); verify $(Q "SELECT fleet_ledger_verify()->>'ok'")"
  echo "     Agent-1 $(rt $A1 | cut -c1-7) paused=$(paused $A1) pid $(mainpid $A1); Agent-2 $(rt $A2 | cut -c1-7) paused=$(paused $A2) pid $(mainpid $A2)"
  echo "     inference off: $(inference_off && echo yes || echo NO); credit $(Q "SELECT fleet_provider_credit_balance('anthropic')") µ¢; owner payable $(Q "SELECT fleet_ledger_balance('fleet:owner:payable')")"
}
die() { echo "!! $*"; state; echo "== INSTALL NOT COMPLETE $(ts) — no database was restored; both agents remain paused; stop and ask the owner"; exit 1; }
closed() {
  [[ "$(Q 'SELECT count(*) FROM fleet_outward_release WHERE expires_at > now()')" == 0 ]] || return 1
  [[ "$(Q 'SELECT card_enabled OR enabled FROM fleet_identity_autonomy')" == f ]] || return 1
  [[ "$(Q 'SELECT custody_activation_id IS NULL FROM fleet_economic_model WHERE id = 1')" == t ]] || return 1
  [[ "$(Q 'SELECT fleet_sales_open()')" == f ]] || return 1
  [[ "$(Q "SELECT count(*) FROM fleet_refund_authorities a WHERE fleet_refund_authority_live(a)")" == 0 ]] || return 1
}
sudo -v || exit 2
echo "== install ${C:0:7} (release ${PREV:0:7} -> ${C:0:7}; schema 115 -> 118; no agent change) start $(ts)"

echo "== 0. gates + guards + pre-install backup"
[[ -z "${FLEET_ROLLOUT_AUTO_RESTORE:-}" ]] || die "FLEET_ROLLOUT_AUTO_RESTORE is set: automatic database restoration must stay off"
[[ "$(sed -n 's/^FLEET_RUNTIME_COMMIT=//p' $R/pins.txt)" == "$C" && "$(sed -n 's/^FLEET_RUNTIME_BUILD_ID=//p' $R/pins.txt)" == "$BUILD" \
   && "$(sed -n 's/^FLEET_RUNTIME_LOCKFILE_SHA256=//p' $R/pins.txt)" == "$LOCK" ]] || die "the staged pins are not ${C:0:7} / ${BUILD:0:12}"
grep -q "REHEARSAL PASSED" $R/rehearse.log || die "no passed data rehearsal of ${C:0:7}"
grep -q "rollout rehearse ${C:0:7}" $R/rehearse.log || die "the data rehearsal is not of ${C:0:7}"
grep -q "UPGRADE REHEARSAL PASSED" $R/upgrade-rehearsal.log && grep -q "upgrade rehearsal ${C:0:7}" $R/upgrade-rehearsal.log || die "no passed services rehearsal of ${C:0:7}"
for f in rehearse.log upgrade-rehearsal.log; do
  age=$(( $(date +%s) - $(stat -c %Y $R/$f) )); (( age < 86400 )) || die "$f is older than 24 h: the rehearsals must be run again (owner approval)"; done
[[ "$(sha256sum $UITGZ | cut -c1-64)" == "$UISHA" ]] || die "UI package checksum differs"
[[ -d $REL ]] || die "the release directory installed beside production is missing"
[[ "$(paused $A1)" == t && "$(paused $A2)" == t ]] || die "both agents must be paused"
[[ "$(rt $A1)" == "$A1_RT" && "$(rt $A2)" == "$A2_RT" ]] || die "an agent is not on its expected runtime"
inference_off || die "inference is not off (policy disabled, provider none, Fleet Control budget unset)"
closed || die "a permission is open (outward release, card, payouts, sales or a refund authority)"
for k in REAL_REPLICATION_ENABLED REAL_PAYMENTS_ENABLED OWNER_SWEEP_ENABLED FLEET_DRY_RUN_CHILD; do grep -qx "$k=false" /etc/automaton-fleet/runtime.env || die "$k is not false"; done
case "$(schema)" in 115) [[ "$(cur)" == "$PREV" ]] || die "schema 115 without ${PREV:0:7}";; 118) [[ "$(cur)" == "$C" ]] || die "schema 118 without ${C:0:7}";; *) die "live schema is not 115";; esac
cmp -s $REL/deploy/systemd/automaton-fleet-founder@.service /etc/systemd/system/automaton-fleet-founder@.service || die "the founder unit template differs from the release's (not expected)"
[[ -s $R/agent1-pid.txt ]] || mainpid $A1 > $R/agent1-pid.txt
[[ -s $R/agent2-pid.txt ]] || mainpid $A2 > $R/agent2-pid.txt
[[ -s $R/tiers-before.txt ]] || tiers > $R/tiers-before.txt
[[ -s $R/head-before.txt ]] || head_ > $R/head-before.txt
[[ -s $R/credit-before.txt ]] || Q "SELECT fleet_provider_credit_balance('anthropic')||' '||fleet_ledger_balance('fleet:owner:payable')" > $R/credit-before.txt
[[ -s $R/settings-pre-install.json ]] || sudo -n -u postgres psql -X -q -At -d automaton_fleet < $R/settings.sql > $R/settings-pre-install.json
if [[ "$(schema)" == 115 ]]; then
  LABEL=pre-install-${C:0:7}
  bash $R/baseline.sh $LABEL 2>&1 | sed -n "2,4p"
  B=$(ls -d $R/baseline-$LABEL-* | tail -1); [[ -d "$B" ]] || die "no baseline"
  n=$(pg_restore -l $B/automaton_fleet-full.dump | wc -l); (( n > 4000 )) || die "baseline dump unreadable ($n entries)"
  echo "  pre-install backup $B ($n dump entries; kept, never restored by this script)"
fi
state

echo "== 1. release ${PREV:0:7} -> ${C:0:7}, schema 115 -> 118 ($(ts))"
if [[ "$(cur)" == "$C" && "$(schema)" == 118 ]]; then echo "  already deployed (skipped)"
else
  bash $REL/scripts/fleet-release.sh $R/pins.txt 115 118 $UI $UITGZ $UISHA > $R/release.log 2>&1; rc=$?
  grep -E "OUTAGE|outage|reconciliation|DEPLOYED|FAILED|REFUSED|ROLLED|restore" $R/release.log | cut -c1-200
  [[ $rc == 0 ]] && grep -q "RELEASE ${C:0:7} DEPLOYED" $R/release.log || die "the release did not deploy (see $R/release.log); no database was restored — the owner decides"
fi
[[ "$(cur)" == "$C" && "$(schema)" == 118 ]] || die "current is not ${C:0:7} on schema 118"

echo "== 2. verification ($(ts))"
[[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:8787/readyz)" == 200 ]] || die "controller not ready"
[[ "$(paused $A1)" == t && "$(paused $A2)" == t ]] || die "an agent is not paused"
[[ "$(rt $A1)" == "$A1_RT" && "$(rt $A2)" == "$A2_RT" ]] || die "an agent's runtime changed"
[[ "$(mainpid $A1)" == "$(cat $R/agent1-pid.txt)" && "$(mainpid $A2)" == "$(cat $R/agent2-pid.txt)" ]] || die "an agent's process changed (restarted)"
inference_off || die "inference is not off after the install"
[[ "$(tiers)" == "$(cat $R/tiers-before.txt)" ]] || die "a model tier changed: $(tiers)"
[[ "$(head_)" == "$(cat $R/head-before.txt)" ]] || die "the ledger head moved during the install (the migrations post nothing)"
[[ "$(Q "SELECT fleet_provider_credit_balance('anthropic')||' '||fleet_ledger_balance('fleet:owner:payable')")" == "$(cat $R/credit-before.txt)" ]] || die "the credit balance or the owner payable changed"
[[ "$(Q "SELECT draw_order FROM fleet_ai_credit_policy WHERE provider = 'anthropic'")" == promotional_first ]] || die "draw order is not promotional_first"
Q "SELECT draw_order_evidence FROM fleet_ai_credit_policy WHERE provider = 'anthropic'" | grep -q "Included credits are spent first" || die "the draw order lacks the provider rule as evidence"
[[ "$(Q "SELECT cache_read_microcents_per_token FROM fleet_cognition_tiers WHERE tier = 'T2'")" == 10 ]] || die "T2 cache-read price is not 10"
[[ "$(Q "SELECT fleet_ledger_balance('fleet:treasury:control_reserved')||' '||(SELECT count(*) FROM fleet_ai_credit_lots WHERE source = 'promotional')")" == "0 0" ]] || die "something is held or a promotional lot exists"
[[ "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'fleet' AND prosrc LIKE '%fleet_ai_credit_promotional_drawn%'")" == 3 ]] || die "the credit-source lookup is not in the three charge paths"
for k in REAL_REPLICATION_ENABLED REAL_PAYMENTS_ENABLED OWNER_SWEEP_ENABLED FLEET_DRY_RUN_CHILD; do grep -qx "$k=false" /etc/automaton-fleet/runtime.env || die "$k is not false"; done
closed || die "a permission is open after the install"
[[ "$(Q "SELECT fleet_ledger_verify()->>'ok'")" == true ]] || die "ledger verification failed"
sudo -n -u postgres psql -X -q -At -d automaton_fleet < $R/settings.sql > $R/settings-post-install.json
state
echo "== INSTALL COMPLETE $(ts): ${C:0:7} on schema 118; Agent-1 ${A1_RT:0:7} and Agent-2 ${A2_RT:0:7} PAUSED (same processes); inference off; Fleet Control budget unset; nothing posted"
