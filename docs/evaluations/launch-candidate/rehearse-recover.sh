#!/usr/bin/env bash
# Rehearse a recover-c448d98.sh version on a DISPOSABLE copy of the pre-recovery backup (production just before the 28 Oct
# reinstatement), without touching production: the script's database calls go to the copy, its systemd calls to stubs that
# behave like founders (heartbeat + challenge through the release's own code, or a unit failing with exit 3).
#   bash rehearse-recover.sh <script> ok|a2fails|bothfail|a2hangs   (a2hangs: the 15-min checkpoint shortened to 40 s)
set -uo pipefail
SCRIPT=$(readlink -f "$1"); SCEN=$2
A1=01M3F50SH7PNX2E3GST13J52AS; A2=01M4C4NXT786Q4E9725N5A15KV
REL=/opt/automaton-fleet/releases/c448d98a1c32c63af89288758240fc5787f9f9d6; NODE=/opt/automaton-fleet/node/bin/node
DUMP=$(ls -d ~/rlc139/baseline-pre-recovery-c448d98-*/ | tail -1)automaton_fleet-full.dump
DB=fleet_recover_rehearsal
HR=$(mktemp -d /tmp/recover-rehearsal.XXXXXX); chmod 700 $HR
pq() { sudo -n -u postgres psql -X -q -At -d "$1" -c "SET default_transaction_read_only=on; SET search_path=fleet; $2"; }
prod() { echo "$(pq automaton_fleet "SELECT head_seq||' '||(SELECT string_agg(status,',' ORDER BY agent_id) FROM fleet_agents)||' '||(SELECT heartbeat_dead_s||'/'||termination_grace_s FROM fleet_state)||' '||(SELECT count(*) FROM fleet_events) FROM fleet_ledger_head") units $(systemctl show -p MainPID --value automaton-fleet-founder@$A1.service)/$(systemctl show -p MainPID --value automaton-fleet-founder@$A2.service)"; }
P0=$(prod)
echo "== rehearsal of $(basename $SCRIPT) ($(sha256sum < $SCRIPT | cut -c1-16)), scenario $SCEN, copy of $(basename $(dirname $DUMP))"
sudo -n -u postgres dropdb --if-exists $DB 2>/dev/null
trap 'sudo -n -u postgres dropdb --if-exists $DB; rm -rf $HR; echo "copy $DB dropped"' EXIT
sudo -n -u postgres createdb -O fleetadmin $DB; sudo -n -u postgres psql -X -q -d postgres -c "REVOKE ALL ON DATABASE $DB FROM PUBLIC"
sudo -n -u postgres pg_restore -d $DB --exit-on-error < "$DUMP" || exit 1
export HARNESS_URL=$(sed -n 's/^FLEET_ADMIN_DATABASE_URL=//p' /etc/automaton-fleet/admin.env | tr -d '"' | sed -E "s#/automaton_fleet([?]|\$)#/$DB\1#")
[[ "$HARNESS_URL" == *"/$DB"* ]] || { echo "!! URL not pointed at the copy"; exit 1; }
export HARNESS_EMPTY=$HR/empty.env; : > $HARNESS_EMPTY; chmod 600 $HARNESS_EMPTY
export HARNESS_DIR=$HR HARNESS_FAIL=$(case $SCEN in a2fails) echo $A2;; bothfail) echo "$A1 $A2";; *) echo none;; esac) HARNESS_HANG=$([[ $SCEN == a2hangs ]] && echo $A2 || echo none)
echo "copy before: $(pq $DB "SELECT string_agg(agent_id||' '||status, ', ' ORDER BY agent_id) FROM fleet_agents"); head $(pq $DB 'SELECT head_seq FROM fleet_ledger_head'); schema $(pq $DB 'SELECT max(version) FROM fleet_schema_migrations')"

# founder stand-in: one heartbeat, then the issued challenge answered with the agent's approved runtime (release code)
cat > $HR/founder.mjs <<EOT
import { PgFleetStore } from "$REL/dist/fleet/postgres/store.js";
const s = new PgFleetStore({ connectionString: process.env.HARNESS_URL });
const id = process.argv[2]; const one = async (q, p) => (await s.pool.query(q, p)).rows[0];
await one("SELECT fleet.fleet_heartbeat(\$1, \$1)", [id]);
const c = await s.issueChallenge(id);
const a = await one("SELECT runtime_commit FROM fleet.fleet_agents WHERE agent_id = \$1", [id]);
const rt = (await one("SELECT fleet.fleet_founder_runtime_current(\$1) AS r", [id])).r;
const r = c ? await s.answerChallenge(id, { challengeId: c.challengeId, nonce: c.nonce, commit: a.runtime_commit, buildId: rt?.buildId ?? null, policyOk: true }) : null;
console.log(id, "challenge", JSON.stringify(r), "status", (await one("SELECT status FROM fleet.fleet_agents WHERE agent_id = \$1", [id])).status);
await s.close();
EOT
mkdir -p $HR/fake; for a in $A1 $A2; do echo "failed 3 0" > $HR/fake/$a; done
cat > $HR/stubs.sh <<'EOT'
_agent() { local u=${1#automaton-fleet-founder@}; echo ${u%.service}; }
systemctl() {
  local a
  case "$1" in
    show) a=$(_agent "$5"); read -r st code pid < $HARNESS_DIR/fake/$a
          case "$3" in ActiveState) echo $st;; ExecMainStatus) echo $code;; MainPID) echo $pid;; esac ;;
    start) a=$(_agent "$2")
           if [[ " $HARNESS_FAIL " == *" $a "* ]]; then echo "failed 3 0" > $HARNESS_DIR/fake/$a
           elif [[ "$HARNESS_HANG" == "$a" ]]; then echo "active 0 $((40000 + RANDOM))" > $HARNESS_DIR/fake/$a
           else echo "active 0 $((40000 + RANDOM))" > $HARNESS_DIR/fake/$a
             ( sleep 2; cd /tmp && /opt/automaton-fleet/node/bin/node $HARNESS_DIR/founder.mjs $a ) >> $HARNESS_DIR/founder.log 2>&1 & fi ;;
    stop) a=$(_agent "$2"); echo "inactive 0 0" > $HARNESS_DIR/fake/$a ;;
  esac
}
journalctl() { echo "(rehearsal: no journal)"; }
EOT
# the pre-recovery backup step: the copy's own source dump stands in (production is never dumped by the rehearsal)
cat > $HR/baseline.sh <<EOT
d=$HR/baseline-\$1-rehearsal; mkdir -p \$d; ln -sf $DUMP \$d/automaton_fleet-full.dump; echo; echo "  (rehearsal) baseline = \$d"
EOT
sed -e "s#^R=~/rlc139\$#R=$HR#" \
    -e 's#psql -X -q -At -d automaton_fleet #psql -X -q -At -d '"$DB"' #' \
    -e 's#^cli() { ( cd /opt/automaton-fleet/current \&\& /opt/automaton-fleet/node/bin/node#cli() { ( cd /opt/automaton-fleet/current \&\& FLEET_ADMIN_ENV_FILE=$HARNESS_EMPTY FLEET_ADMIN_DATABASE_URL="$HARNESS_URL" /opt/automaton-fleet/node/bin/node#' \
    -e 's#sudo systemctl #systemctl #g; s#sudo journalctl #journalctl #g' \
    -e "s#^unset FLEET_TEELOG\$#unset FLEET_TEELOG; source $HR/stubs.sh#" \
    "$SCRIPT" > $HR/recover.sh
[[ $SCEN == a2hangs ]] && sed -i 's#CHECKPOINT_S=900;#CHECKPOINT_S=40;#' $HR/recover.sh
for want in "R=$HR" "-d $DB " 'FLEET_ADMIN_DATABASE_URL="$HARNESS_URL"' "source $HR/stubs.sh"; do grep -qF -- "$want" $HR/recover.sh || { echo "!! harness substitution missing: $want"; exit 1; }; done
grep -q -E 'sudo systemctl|-d automaton_fleet' $HR/recover.sh && { echo "!! a production call survived the substitution"; exit 1; }
bash $HR/recover.sh > $HR/out.txt 2>&1; rc=$?
grep -E "^== |^!! |RECOVERY|FALLBACK|^  0[1-9A-Z]{25}|^  20" $HR/out.txt | cut -c1-200
echo "-- stand-in founders:"; cat $HR/founder.log 2>/dev/null | cut -c1-160; echo "-- units at the end: A1 $(cat $HR/fake/$A1) | A2 $(cat $HR/fake/$A2) (state pid; inactive = stopped by the script)"
echo "== RESULT rc=$rc; copy after: $(pq $DB "SELECT string_agg(agent_id||' '||status||' hold='||COALESCE(to_char(lifecycle_hold_until,'HH24:MI'),'none'), ', ' ORDER BY agent_id) FROM fleet_agents"); head $(pq $DB 'SELECT head_seq FROM fleet_ledger_head'); timings $(pq $DB "SELECT heartbeat_unresponsive_s||' '||heartbeat_dead_s||' '||termination_grace_s||' '||health_grace_s FROM fleet_state")"
P1=$(prod); [[ "$P1" == "$P0" ]] && echo "production untouched: $P0" || echo "!! PRODUCTION CHANGED: $P0 -> $P1"
