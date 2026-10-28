#!/usr/bin/env bash
# Stage 1 retry (Agent-1 canary agent1-c1), FINAL PINNED PACKAGE — PREPARED 28 Oct, NOT RUN; needs the owner's Part D approval.
# Deadline: 24 HOURS after the resume (option A), no automatic blocker stop (as approved for the 27 Oct run).
#
#   bash stage1-retry.sh --check    read-only: every gate of every step; writes nothing
#   bash stage1-retry.sh prepare    steps 1–7 (Agent-1 stays PAUSED: no model call can happen)
#   bash stage1-retry.sh resume     step 8: arm the 24 h end + hourly guard, verify armed, THEN resume Agent-1; re-arm at
#                                   exactly STARTED_AT + 24 h
#   bash stage1-retry.sh status     read-only
#
# Two kinds of rollback, never confused:
#   * CONFIGURATION rollback (automatic, inside step 4 = stage1-retry-inference-on.sh): service.env restored from its backup,
#     the AI policy disabled, the controller restarted on the old file. It touches no database row except the policy flag.
#   * DATABASE restoration: NEVER done by this package, on any failure. Ledger, registry and events are kept and fixed forward;
#     a restore needs the owner's separate, explicit approval.
# Kill switch at any time (no restart): `cli cognition-disable` (immediate) and `founder-cognition <A1> pause …`.
set -uo pipefail
R=~/rlc140; MODE=${1:---check}
A1=01M3F50SH7PNX2E3GST13J52AS; A2=01M4C4NXT786Q4E9725N5A15KV; C=c448d98a1c32c63af89288758240fc5787f9f9d6
REL=/opt/automaton-fleet/releases/$C; N=/opt/automaton-fleet/node/bin/node
STEP4=$R/stage1-retry-inference-on.sh; STEP4_SHA=2c2d78cc246c9eaaac31fb3e6db1baade8a300f4268e555df8142e6eefd287e0
PF=$R/fleet-controller-preflight.mjs; PF_SHA=2c6f6c37ad900b92b1d461996040facfcbfb88fbf27989797fe9e1be5594d628
OFFER=d7063a0a-9aab-4d0a-800d-ee2547e89ce7; SLUG=uk-landlord-compliance-tracker-england-g-a9ddde
XLSX_SHA=7793dff2084dd7968019041e7579ecdedafd73529190c14b8a85a39820bc69b5; README_SHA=4494dff2185aeb052df9131199f34e768599e098d93b72394c994f2fe5dfcd89
SRC=$R/tracker-v6; WS=/var/lib/private/automaton-founders/$A1/workspace/ws_01M3F50SH8BHKVHZP1291FN09K; DEST=$WS/from-owner/tracker-v6
FOWNER=fnd-$A1; CANARY=~/canary; CONF=$CANARY/canary.conf; DEADLINE_H=24
TITLE="Adopt the corrected tracker files and review them"
TASK='Adopt the corrected files for your offer "UK Landlord Compliance Tracker (England)" (offer d7063a0a, slug uk-landlord-compliance-tracker-england-g-a9ddde). The corrected workbook is in your workspace at from-owner/tracker-v6/Landlord_Compliance_Tracker.xlsx (sha256 7793dff2084dd7968019041e7579ecdedafd73529190c14b8a85a39820bc69b5). It fixes printing: columns were cut off on printed pages. 1) offer file remove: Landlord_Compliance_Tracker.xlsx (f45c3d00…, the current deliverable). Keep README.txt (4494dff2…, unchanged). 2) offer file: attach the corrected workbook as a deliverable. 3) deliverable inspect both files with your acceptance cases, and look at the printed pages. 4) deliverable review, subject offer, of exactly those two files. If you find a defect, fix it and review your fixed file instead. Do not publish: sales stay closed until the owner'"'"'s next step. When the review is recorded, stop work on this offer and wait (sleep, naming the review), and do not start other paid work. If something blocks you, record the blocker once and wait.'
ts() { date -u +%FT%TZ; }
Q() { sudo -n -u postgres psql -X -q -At -d automaton_fleet -c "SET default_transaction_read_only=on; SET search_path=fleet; $1"; }
cli() { ( cd /opt/automaton-fleet/current && $N dist/fleet/postgres/cli.js "$@" ); }
cog() { Q "SELECT daily_budget_cents||' '||max_turns_per_hour||' paused='||paused||' enabled='||enabled FROM fleet_founder_cognition WHERE agent_id = '$1'"; }
free_credit() { Q "SELECT fleet_provider_credit_balance('anthropic') - (SELECT COALESCE(sum(usd_microcents),0) FROM fleet_provider_credit_holds WHERE status = 'open')"; }
budget() { Q "SELECT COALESCE(fleet_control_ai_state() ->> 'ceilingMinor', 'unset')"; }   # the daily ceiling in pence; unset = no paid call
offer_files() { Q "SELECT string_agg(file_name||':'||left(content_sha256,8), ',' ORDER BY file_name) FROM fleet_offer_files WHERE offer_id = '$OFFER' AND removed_at IS NULL"; }
open_tasks() { Q "SELECT count(*) FROM fleet_owner_tasks WHERE agent_id = '$A1' AND closed_at IS NULL"; }
policy_on() { Q 'SELECT cognition_enabled FROM fleet_cognition_policy WHERE id = 1'; }
die() { echo "!! $*"; echo "== STAGE 1 RETRY STOPPED ($MODE) $(ts): Agent-1 $(cog $A1); policy enabled=$(policy_on); no database was restored"; exit 1; }
for v in "$STEP4:$STEP4_SHA" "$PF:$PF_SHA" "$SRC/Landlord_Compliance_Tracker.xlsx:$XLSX_SHA" "$SRC/README.txt:$README_SHA"; do
  [[ "$(sha256sum < ${v%%:*} 2>/dev/null | cut -c1-64)" == "${v##*:}" ]] || die "pinned file ${v%%:*} does not match its pinned sha256"; done
[[ ${#TASK} -le 1500 ]] || die "task text too long (${#TASK})"

common_gates() {
  [[ "$(readlink -f /opt/automaton-fleet/current | xargs basename)" == "$C" && "$(Q 'SELECT max(version) FROM fleet_schema_migrations')" == 122 ]] || die "not c448d98 on schema 122"
  [[ "$(Q "SELECT string_agg(agent_id||' '||status, ',' ORDER BY agent_id) FROM fleet_agents")" == "$A1 active,$A2 active" ]] || die "both founders must be active"
  [[ "$(cog $A2)" == "3000 60 paused=true enabled=true" ]] || die "Agent-2 is not as recorded (3000p, 60/h, paused): $(cog $A2)"
  [[ "$(Q 'SELECT fleet_sales_open()')" == f ]] || die "sales are open"
  [[ "$(Q 'SELECT count(*) FROM fleet_refund_authorities a WHERE fleet_refund_authority_live(a)') $(Q 'SELECT count(*) FROM fleet_outward_release WHERE expires_at > now()') $(Q 'SELECT card_enabled OR enabled FROM fleet_identity_autonomy') $(Q 'SELECT custody_activation_id IS NULL FROM fleet_economic_model WHERE id = 1')" == "0 0 f t" ]] || die "an authority is open (refund, outward release, card/identity, custody)"
  [[ "$(Q 'SELECT tripped FROM fleet_spend_circuit_breaker WHERE id = 1')" == t ]] || die "the spend breaker is not tripped (it stays tripped for Stage 1)"
  [[ "$(Q "SELECT string_agg(run_id, ',') FROM fleet_provider_credit_holds WHERE status = 'open'")" == canary-agent1-ceiling && "$(free_credit)" == 1500000000 ]] || die "free credit is $(free_credit) µ¢, not exactly \$15 under canary-agent1-ceiling"
  [[ "$(Q "SELECT fleet_ledger_verify()->>'ok'")" == true ]] || die "the ledger does not verify"
  [[ "$(Q "SELECT status||' '||(held_at IS NULL) FROM fleet_offers WHERE offer_id = '$OFFER' AND slug = '$SLUG' AND agent_id = '$A1'")" =~ ^[a-z_]+\ true$ ]] || die "the offer is missing or held"
}
echo "== Stage 1 retry ($MODE) $(ts)"
case "$MODE" in
  --check|status)
    common_gates
    echo "  Agent-1 $(cog $A1); Agent-2 $(cog $A2); policy enabled=$(policy_on); Fleet Control budget $(budget); free credit $(free_credit) µ¢"
    echo "  offer files: $(offer_files); open owner tasks (Agent-1): $(open_tasks); canary conf: $([[ -e $CONF ]] && echo present || echo absent); units: $(ls /etc/systemd/system | grep -c '^automaton-fleet-canary-')"
    [[ $MODE == status ]] && exit 0
    [[ "$(cog $A1)" == "754 120 paused=true enabled=true" ]] || die "Agent-1 is not 754p / 120 per hour / paused: $(cog $A1)"
    [[ "$(offer_files)" == "Landlord_Compliance_Tracker.xlsx:f45c3d00,README.txt:4494dff2" ]] || die "the offer files are not the expected two: $(offer_files)"
    [[ "$(open_tasks)" == 0 && ! -e $CONF && "$(ls /etc/systemd/system | grep -c '^automaton-fleet-canary-')" == 0 ]] || die "a previous Stage 1 attempt left a task, canary.conf or units"
    sudo -n test -d $WS || die "Agent-1 workspace missing"; sudo -n test -e $DEST && die "$DEST already exists"
    for u in check.service check.timer end.service end.timer; do cmp -s $REL/deploy/systemd/automaton-fleet-canary-$u /opt/automaton-fleet/current/deploy/systemd/automaton-fleet-canary-$u || die "unit $u differs from the release"; done
    echo "== step 4 read-only check"; bash $STEP4 --check | tail -1; [[ ${PIPESTATUS[0]} == 0 ]] || die "step 4 check did not pass"
    echo "== CHECK PASSED $(ts): nothing written"; exit 0 ;;

  prepare)
    common_gates
    [[ "$(open_tasks)" == 0 && ! -e $CONF ]] || die "a previous attempt left a task or canary.conf: run 'status' and decide"
    echo "== 1. Agent-1 120 calls/h (paused)"
    [[ "$(cog $A1)" == "754 120 paused=true enabled=true" ]] || { cli founder-cognition $A1 pause --turns-per-hour 120 "canary stage 1 retry: 120 calls/h" > /dev/null; [[ "$(cog $A1)" == "754 120 paused=true enabled=true" ]] || die "Agent-1 read-back $(cog $A1)"; }
    echo "  $(cog $A1)"
    echo "== 2. Fleet Control 30p/day (unfunded treasury: its reservations wait)"
    cli economy-fleet-control-ai-budget 30 "canary stage 1 retry: Fleet Control 30p/day; unfunded calls wait" > /dev/null || die "budget refused"
    [[ "$(budget)" == 30 ]] || die "Fleet Control budget read-back $(budget)"
    echo "== 3. ceiling hold: already in place (exactly \$15 free, verified by SQL: $(free_credit) µ¢)"
    echo "== 4. inference on (pinned step-4 script: preflights, bounded restart, automatic CONFIGURATION rollback)"
    bash $STEP4 2>&1 | tee $R/stage1-step4.log | grep -E "^== |^!! |  ready|PREFLIGHT"
    if [[ ${PIPESTATUS[0]} != 0 ]]; then
      cli economy-fleet-control-ai-budget off "canary stage 1 retry: step 4 failed; back to containment" > /dev/null
      die "step 4 failed (its own configuration rollback ran; see $R/stage1-step4.log); Fleet Control budget off again; Agent-1 paused"
    fi
    echo "== 5. guard: canary.conf (provisional times; fixed at resume) + the four release units (timers NOT enabled yet)"
    mkdir -p -m 700 $CANARY
    P=$(date -u -d '+1 hour' +%FT%TZ); PE=$(date -u -d "$P + $DEADLINE_H hours" +%FT%TZ)
    printf '%s\n' CANARY_ID=agent1-c1 AGENT=$A1 OFFER_SLUG=$SLUG STARTED_AT=$P ENDS_AT=$PE CASH_CEILING_MINOR=1000 CREDIT_CEILING_USD_MICRO=1500000000 HOLD_RUN=canary-agent1-ceiling > $CONF.new && chmod 600 $CONF.new && mv $CONF.new $CONF
    for u in check.service check.timer end.service end.timer; do sudo -n install -o root -g root -m 644 $REL/deploy/systemd/automaton-fleet-canary-$u /etc/systemd/system/; done
    sudo -n systemctl daemon-reload
    FLEET_CANARY_CONF=$CONF /opt/automaton-fleet/current/scripts/fleet-canary.sh check --dry-run | tail -1 | cut -c1-200
    FLEET_CANARY_CONF=$CONF /opt/automaton-fleet/current/scripts/fleet-canary.sh end --dry-run | tail -2 | cut -c1-200
    [[ "$(ls $CANARY)" == canary.conf ]] || die "a dry run wrote into $CANARY"
    echo "== 6. files → $DEST (owner $FOWNER, 0600; hashes verified)"
    sudo -n install -d -o $FOWNER -g $FOWNER -m 700 $WS/from-owner $DEST
    for f in Landlord_Compliance_Tracker.xlsx README.txt; do sudo -n install -o $FOWNER -g $FOWNER -m 600 $SRC/$f $DEST/$f; done
    [[ "$(sudo -n sha256sum $DEST/Landlord_Compliance_Tracker.xlsx | cut -c1-64) $(sudo -n sha256sum $DEST/README.txt | cut -c1-64)" == "$XLSX_SHA $README_SHA" ]] || die "copied file hashes differ"
    echo "== 7. owner task (shown in Agent-1's working turns; Agent-1 is paused, so nothing runs yet)"
    cli founder-task $A1 "$TITLE" "$TASK" > $R/stage1-task.json || die "founder-task refused"
    [[ "$(open_tasks)" == 1 ]] || die "the owner task is not open"
    echo "  task $(Q "SELECT task_id FROM fleet_owner_tasks WHERE agent_id = '$A1' AND closed_at IS NULL")"
    echo "== PREPARED $(ts): inference on, Agent-1 PAUSED, task open, files placed, guard installed (timers not enabled). Next: 'resume'." ;;

  resume)
    common_gates
    [[ "$(policy_on)" == t && "$(open_tasks)" == 1 && -e $CONF && "$(cog $A1)" == "754 120 paused=true enabled=true" && "$(budget)" == 30 ]] || die "run 'prepare' first (policy on, one open task, canary.conf, Agent-1 paused, budget 30)"
    sudo -n test -f $DEST/Landlord_Compliance_Tracker.xlsx || die "files not placed"
    arm() {   # $1 = STARTED_AT
      local s=$1 e; e=$(date -u -d "$s + $DEADLINE_H hours" +%FT%TZ)
      sed -i -e "s/^STARTED_AT=.*/STARTED_AT=$s/" -e "s/^ENDS_AT=.*/ENDS_AT=$e/" $CONF
      sudo -n install -d -m 755 /etc/systemd/system/automaton-fleet-canary-end.timer.d
      printf '[Timer]\nOnCalendar=\nOnCalendar=%s UTC\n' "$(date -u -d "$e" '+%Y-%m-%d %H:%M:%S')" | sudo -n tee /etc/systemd/system/automaton-fleet-canary-end.timer.d/ends-at.conf > /dev/null
      sudo -n systemctl daemon-reload && sudo -n systemctl enable --now automaton-fleet-canary-check.timer automaton-fleet-canary-end.timer > /dev/null 2>&1
      sudo -n systemctl restart automaton-fleet-canary-end.timer
      local next; next=$(systemctl show -p NextElapseUSecRealtime --value automaton-fleet-canary-end.timer)
      [[ "$(date -u -d "$next" +%FT%TZ 2>/dev/null)" == "$e" ]] || die "the end timer is not armed at $e (next: $next)"
      [[ "$(systemctl is-active automaton-fleet-canary-check.timer)" == active ]] || die "the hourly guard timer is not active"
      echo "  armed: STARTED_AT $s, ENDS_AT $e (end timer next elapse $next; hourly guard active)"
    }
    echo "== 8a. arm the end timer BEFORE the resume (provisional start = now)"; arm "$(date -u +%FT%TZ)"
    echo "== 8b. resume Agent-1"
    cli founder-cognition $A1 resume "canary agent1-c1 stage 1 retry (24 h)" > /dev/null || die "resume refused (timers armed; Agent-1 still paused — run 'fleet-canary.sh end' or disable the timers)"
    S=$(Q "SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') FROM fleet_founder_cognition WHERE agent_id = '$A1' AND paused = false")
    [[ -n "$S" ]] || die "Agent-1 is not resumed"
    echo "== 8c. re-arm at exactly STARTED_AT + ${DEADLINE_H} h"; arm "$S"
    echo "== RESUMED $(ts): Stage 1 runs until $(sed -n 's/^ENDS_AT=//p' $CONF) at the latest; hourly guard + 754p/day + 120/h + \$15 hold."
    echo "   Success or a blocker seen by this session → pause Agent-1 first, then close the task. Otherwise the timer ends it." ;;
  *) echo "usage: stage1-retry.sh --check|prepare|resume|status"; exit 2 ;;
esac
