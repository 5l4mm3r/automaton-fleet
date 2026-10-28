#!/usr/bin/env bash
# Install c448d98 (v122 founder recovery; Group B, part 1 of the recovery package). PREPARED 2026-10-27, NOT RUN — needs the
#   owner's explicit approval. release 1116576 -> c448d98, schema 121 -> 122 (v122: founders recover from unresponsive (R1);
#   controller downtime never counts against agents (R2); the owner's incident reinstatement + bounded verification hold +
#   founder-hold-end (R3); unbacked estate cash parked apart from unallocated, customer earnings kept backed (R4)).
#   UI 0.27.0 UNCHANGED (verified and reused; no switch). Founder unit template unchanged.
# Production is in INCIDENT CONTAINMENT: both founders are DEAD (21:23:07Z, health_timeout), their units failed (exit 3).
#   This install does NOT reinstate anyone, start or touch a founder unit or its state, change a timing, end containment
#   (Fleet Control budget stays unset, spend breaker stays tripped, the canary credit hold stays open), activate inference,
#   post anything (the v122 migration posts nothing: ledger head unchanged), or restore any database. The reinstatement is
#   a SEPARATE script (recover-c448d98.sh) with its own approval.
# Automatic database restoration stays OFF (FLEET_ROLLOUT_AUTO_RESTORE must be unset): if the cutover fails after the
# migration, the controller-side units are stopped, the pre-install backup is kept and the owner decides. With both agents
# dead, a controller outage during the cutover cannot cost an agent its life.
# Re-running after a failure continues: completed steps are detected and skipped; nothing is restored.
set -uo pipefail
R=~/rlc139
SELF=$(readlink -f "${BASH_SOURCE[0]}"); ARGS=("$@")
if [[ "${FLEET_TEELOG:-}" != "$SELF" ]]; then FLEET_TEELOG="$SELF" bash "$SELF" "${ARGS[@]}" 2>&1 | tee -a "$R/install.log"; exit "${PIPESTATUS[0]}"; fi
unset FLEET_TEELOG
A1=01M3F50SH7PNX2E3GST13J52AS; A2=01M4C4NXT786Q4E9725N5A15KV
C=c448d98a1c32c63af89288758240fc5787f9f9d6; BUILD=48c0015ed443e23e835eed697ff5bc01275509d23fd13783a21f2422ad7c5725
LOCK=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
PREV=1116576f3663a9f2289422b226b7e12232ff57ee; A1_RT=7c194b8c2348baa8fa5d34bd7ef6b201dc4911c2; A2_RT=b60e262bf7393e0ea2cca3b491199987f830cb3b
UI=0.27.0; UITGZ=~/rlc138/ui-0.27.0-1116576.tgz; UISHA=bccb6e667859dcaa270477e9f00328c61e8c8aeeb089e2f95f24922de8ff2558   # the UI served now (reused, not switched)
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
HOLD=10023033480
TIMINGS="120 600 480 300"
contained() {   # the containment of 27 Oct 21:37Z, unchanged
  [[ "$(Q 'SELECT tripped FROM fleet_spend_circuit_breaker WHERE id = 1')" == t ]] || return 1
  [[ "$(Q "SELECT string_agg(run_id||' '||usd_microcents, ',') FROM fleet_provider_credit_holds WHERE status = 'open'")" == "canary-agent1-ceiling $HOLD" ]] || return 1
}
dead_untouched() {   # both founders dead from the incident; units failed (exit 3); credentials revoked; wallets frozen; estates settled
  [[ "$(Q "SELECT string_agg(agent_id||' '||status, ',' ORDER BY agent_id) FROM fleet_agents")" == "$A1 dead,$A2 dead" ]] || return 1
  [[ "$(Q "SELECT count(*) FROM fleet_events WHERE event_type = 'agent_died' AND detail ->> 'cause' = 'health_timeout' AND agent_id IN ('$A1','$A2')")" == 2 ]] || return 1
  [[ "$(Q "SELECT count(*) FROM fleet_agent_credentials WHERE revoked_at IS NOT NULL AND agent_id IN ('$A1','$A2')")" == 2 ]] || return 1
  [[ "$(Q "SELECT bool_and(spending_frozen) FROM fleet_wallet_custody WHERE agent_id IN ('$A1','$A2')")" == t ]] || return 1
  [[ "$(Q "SELECT string_agg(status, ',') FROM fleet_estates WHERE agent_id IN ('$A1','$A2')")" == "settled,settled" ]] || return 1
  for a in $A1 $A2; do [[ "$(systemctl show -p ActiveState --value automaton-fleet-founder@$a.service) $(systemctl show -p ExecMainStatus --value automaton-fleet-founder@$a.service)" == "failed 3" ]] || return 1; done
}
tiers() { Q "SELECT string_agg(tier||':'||model||':'||COALESCE(thinking,'-')||':'||COALESCE(effort,'-')||':'||max_output_tokens||':'||enabled, ' ' ORDER BY tier) FROM fleet_cognition_tiers"; }
head_() { Q "SELECT head_seq||' '||head_hash FROM fleet_ledger_head"; }
state() {
  echo "  -- state $(ts): current $(cur | cut -c1-7); schema $(schema); ledger head $(head_ | cut -c1-20); verify $(Q "SELECT fleet_ledger_verify()->>'ok'")"
  echo "     Agent-1 $(rt $A1 | cut -c1-7) paused=$(paused $A1) pid $(mainpid $A1); Agent-2 $(rt $A2 | cut -c1-7) paused=$(paused $A2) pid $(mainpid $A2)"
  echo "     inference off: $(inference_off && echo yes || echo NO); credit $(Q "SELECT fleet_provider_credit_balance('anthropic')") µ¢; owner payable $(Q "SELECT fleet_ledger_balance('fleet:owner:payable')")"
}
die() { echo "!! $*"; state; echo "== INSTALL NOT COMPLETE $(ts) — no database was restored; both agents remain dead and untouched; containment unchanged; stop and ask the owner"; exit 1; }
closed() {
  [[ "$(Q 'SELECT count(*) FROM fleet_outward_release WHERE expires_at > now()')" == 0 ]] || return 1
  [[ "$(Q 'SELECT card_enabled OR enabled FROM fleet_identity_autonomy')" == f ]] || return 1
  [[ "$(Q 'SELECT custody_activation_id IS NULL FROM fleet_economic_model WHERE id = 1')" == t ]] || return 1
  [[ "$(Q 'SELECT fleet_sales_open()')" == f ]] || return 1
  [[ "$(Q "SELECT count(*) FROM fleet_refund_authorities a WHERE fleet_refund_authority_live(a)")" == 0 ]] || return 1
}
sudo -v || exit 2
echo "== install ${C:0:7} (release ${PREV:0:7} -> ${C:0:7}; schema 121 -> 122; UI 0.27.0 reused; no agent change, no reinstatement) start $(ts)"

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
dead_untouched || die "the incident state differs (both dead from health_timeout, units failed 3, credentials revoked, wallets frozen, estates settled)"
contained || die "containment is not as left (spend breaker tripped; only the canary credit hold open at $HOLD)"
[[ "$(Q "SELECT heartbeat_unresponsive_s||' '||heartbeat_dead_s||' '||termination_grace_s||' '||health_grace_s FROM fleet_state")" == "$TIMINGS" ]] || die "lifecycle timings are not $TIMINGS"
(cd ~/incident-20261027 && sha256sum --quiet -c SHA256SUMS) || die "the incident evidence does not verify"
inference_off || die "inference is not off (policy disabled, provider none, Fleet Control budget unset)"
closed || die "a permission is open (outward release, card, payouts, sales or a refund authority)"
for k in REAL_REPLICATION_ENABLED REAL_PAYMENTS_ENABLED OWNER_SWEEP_ENABLED FLEET_DRY_RUN_CHILD; do grep -qx "$k=false" /etc/automaton-fleet/runtime.env || die "$k is not false"; done
case "$(schema)" in 121) [[ "$(cur)" == "$PREV" ]] || die "schema 121 without ${PREV:0:7}";; 122) [[ "$(cur)" == "$C" ]] || die "schema 122 without ${C:0:7}";; *) die "live schema is not 121";; esac
ls /etc/systemd/system/automaton-fleet-canary-* >/dev/null 2>&1 && die "a canary unit is installed (not expected before activation)"
[[ -s $R/unit-files-before.txt ]] || systemctl list-unit-files 'automaton-*' --no-legend > $R/unit-files-before.txt
cmp -s $REL/deploy/systemd/automaton-fleet-founder@.service /etc/systemd/system/automaton-fleet-founder@.service || die "the founder unit template differs from the release's (not expected)"
[[ -s $R/agent1-pid.txt ]] || mainpid $A1 > $R/agent1-pid.txt
[[ -s $R/agent2-pid.txt ]] || mainpid $A2 > $R/agent2-pid.txt
[[ -s $R/tiers-before.txt ]] || tiers > $R/tiers-before.txt
[[ -s $R/head-before.txt ]] || head_ > $R/head-before.txt
[[ -s $R/unallocated-before.txt ]] || Q "SELECT fleet_ledger_balance('fleet:treasury:unallocated')" > $R/unallocated-before.txt
[[ -s $R/credit-before.txt ]] || Q "SELECT fleet_provider_credit_balance('anthropic')||' '||fleet_ledger_balance('fleet:owner:payable')" > $R/credit-before.txt
[[ -s $R/settings-pre-install.json ]] || sudo -n -u postgres psql -X -q -At -d automaton_fleet < $R/settings.sql > $R/settings-pre-install.json
if [[ "$(schema)" == 121 ]]; then
  LABEL=pre-install-${C:0:7}
  bash $R/baseline.sh $LABEL 2>&1 | sed -n "2,4p"
  B=$(ls -d $R/baseline-$LABEL-* | tail -1); [[ -d "$B" ]] || die "no baseline"
  n=$(sudo -n -u postgres pg_restore -l < $B/automaton_fleet-full.dump | wc -l); (( n > 4000 )) || die "baseline dump unreadable ($n entries)"
  echo "  pre-install backup $B ($n dump entries; kept, never restored by this script)"
fi
state

echo "== 1. release ${PREV:0:7} -> ${C:0:7}, schema 121 -> 122, UI $UI reused ($(ts))"
if [[ "$(cur)" == "$C" && "$(schema)" == 122 ]]; then echo "  already deployed (skipped)"
else
  bash $REL/scripts/fleet-release.sh $R/pins.txt 121 122 $UI $UITGZ $UISHA > $R/release.log 2>&1; rc=$?
  grep -E "OUTAGE|outage|reconciliation|DEPLOYED|FAILED|REFUSED|ROLLED|restore" $R/release.log | cut -c1-200
  [[ $rc == 0 ]] && grep -q "RELEASE ${C:0:7} DEPLOYED" $R/release.log || die "the release did not deploy (see $R/release.log); no database was restored — the owner decides"
fi
[[ "$(cur)" == "$C" && "$(schema)" == 122 ]] || die "current is not ${C:0:7} on schema 122"

echo "== 2. verification ($(ts))"
[[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:8787/readyz)" == 200 ]] || die "controller not ready"
[[ "$(paused $A1)" == t && "$(paused $A2)" == t ]] || die "an agent is not paused"
[[ "$(rt $A1)" == "$A1_RT" && "$(rt $A2)" == "$A2_RT" ]] || die "an agent's runtime changed"
[[ "$(mainpid $A1)" == "$(cat $R/agent1-pid.txt)" && "$(mainpid $A2)" == "$(cat $R/agent2-pid.txt)" ]] || die "an agent's process changed"
dead_untouched || die "the incident state changed during the install (nothing may be reinstated, started or settled differently)"
contained || die "containment changed during the install"
[[ "$(Q "SELECT count(*) FROM fleet_events WHERE event_type IN ('agent_reinstated','estate_reverted','ai_cost_unwound','lifecycle_hold_ended')")" == 0 ]] || die "a recovery event exists (the install reinstates nothing)"
[[ "$(Q "SELECT heartbeat_unresponsive_s||' '||heartbeat_dead_s||' '||termination_grace_s||' '||health_grace_s FROM fleet_state")" == "$TIMINGS" ]] || die "lifecycle timings changed"
inference_off || die "inference is not off after the install"
[[ "$(tiers)" == "$(cat $R/tiers-before.txt)" ]] || die "a model tier changed: $(tiers)"
[[ "$(head_)" == "$(cat $R/head-before.txt)" ]] || die "the ledger head moved during the install (the migrations post nothing)"
[[ "$(Q "SELECT fleet_provider_credit_balance('anthropic')||' '||fleet_ledger_balance('fleet:owner:payable')")" == "$(cat $R/credit-before.txt)" ]] || die "the credit balance or the owner payable changed"
[[ "$(Q "SELECT draw_order FROM fleet_ai_credit_policy WHERE provider = 'anthropic'")" == promotional_first ]] || die "draw order is not promotional_first"
Q "SELECT draw_order_evidence FROM fleet_ai_credit_policy WHERE provider = 'anthropic'" | grep -q "Included credits are spent first" || die "the draw order lacks the provider rule as evidence"
[[ "$(Q "SELECT cache_read_microcents_per_token FROM fleet_cognition_tiers WHERE tier = 'T2'")" == 10 ]] || die "T2 cache-read price is not 10"
[[ "$(Q "SELECT fleet_ledger_balance('fleet:treasury:control_reserved')||' '||(SELECT string_agg(external_ref, ',') FROM fleet_ai_credit_lots WHERE source = 'promotional')")" == "0 grant:anthropic:max-included-20261024" ]] || die "something is held, or the promotional lots are not exactly the recorded grant"
[[ "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'fleet' AND prosrc LIKE '%fleet_ai_credit_promotional_drawn%'")" == 3 ]] || die "the credit-source lookup is not in the three charge paths"
# v119: one figure of credit in use; the daily limit counts usage and open reservations.
[[ "$(Q "SELECT prosrc LIKE '%fleet_cognition_inflight%' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'fleet' AND proname = 'fleet_provider_credit_held'")" == t ]] || die "held credit does not include open model-call reservations"
[[ "$(Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'fleet' AND proname IN ('svc_cognition_authorize','fleet_cognition_authorize_treasury','fleet_admin_engineering_credit_hold') AND prosrc LIKE '%INTO v_reserved FROM fleet_cognition_inflight%'")" == 0 ]] || die "a path still subtracts open reservations twice"
[[ "$(Q "SELECT fleet_cognition_state('$A1') ? 'usageTodayMicrocents'")" == t ]] || die "the daily limit does not report usage"
[[ "$(Q "SELECT fleet_provider_credit_held('anthropic')")" == "$HOLD" ]] || die "held credit is not exactly the kept canary hold"
[[ -x $REL/scripts/fleet-canary.sh && -r $REL/scripts/fleet-canary-measures.sql ]] || die "the release lacks the canary guard"
# v120: owner tasks exist, none is sent, and both agents' attention carries an empty task list.
[[ "$(Q "SELECT count(*) FROM fleet_owner_tasks")" == 0 ]] || die "an owner task exists (none is sent by this install)"
for a in $A1 $A2; do [[ "$(Q "SELECT (fleet_agent_attention('$a') -> 'ownerTasks')::text || ' ' || (fleet_agent_attention('$a') ->> 'ownerTasksDigest')")" == "[] d41d8cd98f00b204e9800998ecf8427e" ]] || die "attention of $a does not carry an empty owner-task list"; done
[[ "$(Q "SELECT count(*) FROM fleet_events WHERE event_type LIKE 'owner_task_%'")" == 0 ]] || die "an owner-task event exists"
# v121: the treasury reads (read-only) — GBP balance, the position, the legacy figure unchanged, the gateway op, the UI served.
[[ "$(Q "SELECT fleet_treasury_health() #>> '{paypal,latestBalance,currency}'")" == GBP ]] || die "Treasury health does not show the GBP balance"
[[ "$(Q "SELECT fleet_treasury_position() #>> '{reconciliation,status}'")" =~ ^(reconciled|unresolved|unavailable)$ ]] || die "the treasury position does not read"
[[ "$(Q "SELECT (fleet_generated_treasury_wealth() ->> 'treasuryCashMinor')::bigint = fleet_treasury_cash()")" == t ]] || die "the legacy treasuryCashMinor changed (it must not)"
[[ "$(Q "SELECT prosrc LIKE '%''treasury_position''%' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'fleet' AND proname = 'dash_call'")" == t ]] || die "the gateway lacks the treasury_position read"
sudo -n grep -qx "FLEET_DASHBOARD_STATIC_DIR=/opt/automaton-fleet/ui/$UI" /etc/automaton-fleet/dashboard.env || die "the dashboard does not serve UI $UI"
# v122: the recovery surfaces exist and are inert until the owner uses them.
fn() { Q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'fleet' AND proname = '$1'"; }
[[ "$(fn fleet_admin_incident_reinstate) $(fn fleet_admin_lifecycle_hold_end)" == "1 1" ]] || die "the v122 owner functions are missing"
[[ "$(Q "SELECT count(*) FROM fleet_agents WHERE lifecycle_hold_until IS NOT NULL")" == 0 ]] || die "a lifecycle hold exists (only a reinstatement sets one)"
[[ "$(Q "SELECT prosrc LIKE '%lifecycle_hold_until%' AND prosrc LIKE '%LEAST(st.heartbeat_unresponsive_s, 45)%' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'fleet' AND proname = 'fleet_reap'")" == t ]] || die "the reaper lacks the v122 hold / resume gap"
[[ "$(Q "SELECT fleet_ledger_balance('fleet:treasury:unbacked_estates')")" == 0 ]] || die "the unbacked-estates account is not at zero"
[[ "$(Q "SELECT fleet_ledger_balance('fleet:treasury:unallocated')")" == "$(cat $R/unallocated-before.txt)" ]] || die "unallocated changed (the migration moves no money)"
for t in agent_reinstated estate_reverted ai_cost_unwound lifecycle_hold_ended; do [[ -n "$(Q "SELECT fleet_event_route('$t', '{}'::jsonb)")" ]] || die "event $t is not routed"; done
ls /etc/systemd/system/automaton-fleet-canary-* >/dev/null 2>&1 && die "a canary unit got installed (must not)"
cmp -s <(systemctl list-unit-files 'automaton-*' --no-legend) $R/unit-files-before.txt || die "the installed unit files changed"
for k in REAL_REPLICATION_ENABLED REAL_PAYMENTS_ENABLED OWNER_SWEEP_ENABLED FLEET_DRY_RUN_CHILD; do grep -qx "$k=false" /etc/automaton-fleet/runtime.env || die "$k is not false"; done
closed || die "a permission is open after the install"
[[ "$(Q "SELECT fleet_ledger_verify()->>'ok'")" == true ]] || die "ledger verification failed"
sudo -n -u postgres psql -X -q -At -d automaton_fleet < $R/settings.sql > $R/settings-post-install.json
state
echo "== INSTALL COMPLETE $(ts): ${C:0:7} on schema 122 (v122 recovery surfaces, inert) with UI $UI (reused); Agent-1 ${A1_RT:0:7} and Agent-2 ${A2_RT:0:7} still DEAD and untouched (units failed, state kept); containment unchanged (breaker tripped, budget unset, canary hold kept); inference off; nothing posted. NEXT (separate approval): recover-c448d98.sh"
