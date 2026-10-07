#!/usr/bin/env bash
# Automaton Fleet — backend upgrade + rollback rehearsal on a THROWAWAY copy of production (schema upgrades).
#
#   bash scripts/fleet-upgrade-rehearsal.sh <pinsFile> <fromSchema> <toSchema>
#
# Complements `fleet-rollout.sh rehearse` (migration, reconciliation, re-run): this one proves the SERVICES and the
# ROLLBACK. Production is never written: a fresh read-only dump is restored into a throwaway database; every service
# runs as its own production OS user from the candidate tooling tree (/var/tmp/rollout-tooling-<commit12>, left by
# `fleet-rollout.sh rehearse`) or the current release, on loopback test ports, with copies of its env files re-pointed
# at the throwaway database (DSNs never printed), no public listener, no reaper, no cognition provider.
#
#   1. candidate migration of the copy; candidate runtime approved in the THROWAWAY registry only
#   2. the current release REFUSES the new schema (why the rollback restores the database)
#   3. candidate controller, Operator API and dashboard start and answer on the new schema; the v42 reads work and
#      invent nothing; the ledger is unchanged
#   4. the cutover's exact rollback: DROP SCHEMA fleet + pg_restore of the pre-migration dump into the same database
#   5. the current release's controller and dashboard start again on the restored schema; ledger unchanged
#
# Writes ~/upgrade-rehearsal-<commit7>.ok on success. Ports 28787 / 28788 / 28790 must be free.
set -euo pipefail
export PATH=/opt/automaton-fleet/node/bin:$PATH
PINS="${1:-}"; FROM="${2:-}"; TO="${3:-}"
die() { echo "UPGRADE REHEARSAL FAILED: $*" >&2; exit 2; }
[[ -f "$PINS" && ! -L "$PINS" ]] || die "pins file missing"
[[ "$FROM" =~ ^[0-9]{1,3}$ && "$TO" =~ ^[0-9]{1,3}$ && "$TO" -gt "$FROM" ]] || die "schemas are integers, to > from"
C=$(sed -n 's/^FLEET_RUNTIME_COMMIT=\([0-9a-f]\{40\}\)$/\1/p' "$PINS"); B=$(sed -n 's/^FLEET_RUNTIME_BUILD_ID=\([0-9a-f]\{64\}\)$/\1/p' "$PINS")
L=$(sed -n 's/^FLEET_RUNTIME_LOCKFILE_SHA256=\([0-9a-f]\{64\}\)$/\1/p' "$PINS")
[[ -n "$C" && -n "$B" && -n "$L" ]] || die "pins file must hold the commit, build id and lockfile"
LIVE=automaton_fleet; RH=automaton_fleet_upgrade_rh; R=/run/fleet-upgrade-rh; ETC=/etc/automaton-fleet; ENVF=$ETC/runtime.env
SVCU=automaton-fleet-service; OPU=automaton-fleet-operator-api; DASHU=automaton-fleet-dashboard
TOOL=/var/tmp/rollout-tooling-${C:0:12}
OLD=$(sudo sed -n 's/^FLEET_RUNTIME_COMMIT=//p' $ENVF); OLDDIR=/opt/automaton-fleet/releases/$OLD
[[ "$OLD" =~ ^[0-9a-f]{40}$ && -d "$OLDDIR" && "$OLD" != "$C" ]] || die "current release unreadable or already the candidate"
[[ -d "$TOOL" && "$(git -C "$TOOL" rev-parse HEAD)" == "$C" ]] || die "no candidate tooling tree at $TOOL (run fleet-rollout.sh rehearse first)"
UI=$(sudo sed -n 's/^FLEET_DASHBOARD_STATIC_DIR=//p' $ETC/dashboard.env); [[ -d "$UI" ]] || die "dashboard static dir unreadable"
for p in 28787 28788 28790; do [[ -z "$(ss -Hltn "sport = :$p")" ]] || die "port $p is in use"; done
REPORT=~/upgrade-rehearsal-${C:0:7}.txt
exec > >(tee "$REPORT") 2>&1
ts() { date -u +%FT%TZ; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@" || true; }
UNITS="fleet-upgrade-rh-controller fleet-upgrade-rh-operator fleet-upgrade-rh-dashboard"
stopall() { for u in $UNITS; do sudo systemctl stop "$u.service" 2>/dev/null || true; sudo systemctl reset-failed "$u.service" 2>/dev/null || true; done; }
cleanup() {
  stopall; sudo rm -rf -- "$R"
  if [[ -n "$(sudo -u postgres psql -X -At -d postgres -c "SELECT 1 FROM pg_database WHERE datname='$RH'")" ]]; then sudo -u postgres dropdb --force "$RH"; fi
}
trap cleanup EXIT
cleanup
live() { sudo -u postgres psql -X -At -d "$LIVE" -c "$1"; }
rh() { sudo -u postgres psql -X -At -v ON_ERROR_STOP=1 -d "$RH" -c "$1"; }
head_() { rh "SELECT head_seq || ' ' || head_hash FROM fleet.fleet_ledger_head"; }
RHURL="postgresql://postgres@/$RH?host=/var/run/postgresql&options=-c%20role%3Dfleetadmin%20-c%20search_path%3Dfleet"
sudo install -d -m 0711 -o root -g root $R
EMPTY=$R/empty.env; sudo install -m 0600 -o postgres -g postgres /dev/null $EMPTY
cli() { sudo -u postgres env -i PATH="$PATH" HOME=/var/tmp FLEET_ADMIN_ENV_FILE=$EMPTY FLEET_RUNTIME_ENV_FILE=$EMPTY FLEET_ADMIN_DATABASE_URL="$RHURL" \
  FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git FLEET_RUNTIME_COMMIT=$C FLEET_RUNTIME_BUILD_ID=$B FLEET_RUNTIME_LOCKFILE_SHA256=$L \
  bash -c "cd $TOOL && node --import tsx src/fleet/postgres/cli.ts $*"; }
echo "== upgrade rehearsal ${C:0:7} (schema $FROM -> $TO), rollback to ${OLD:0:7}, start $(ts)"
test "$(live 'SELECT max(version) FROM fleet.fleet_schema_migrations')" = "$FROM" || die "live schema is not $FROM"
LIVEPIDS=$(systemctl show -p MainPID --value automaton-fleet.service automaton-fleet-operator-api.service automaton-fleet-dashboard.service | tr '\n' ' ')

# 0. Throwaway database from a fresh dump; only the restricted logins of the services under test may connect.
D=$R/live.dump; sudo -u postgres pg_dump -Fc -n fleet "$LIVE" | sudo install -m 0600 -o postgres -g postgres /dev/stdin $D
dsn() { sudo grep -E "^$2=" "$1" | head -1 | sed -E "s#(@[^/@]+/)$LIVE([?]|\$)#\1$RH\2#"; }
loginof() { sudo grep -E "^$2=" "$1" | head -1 | sed -E 's#^[A-Z_]+=postgres(ql)?://([^:@/]+).*#\2#'; }
LOGINS=$(for x in "$ETC/service.env FLEET_SERVICE_DATABASE_URL" "$ETC/service.env FLEET_AGENT_DATABASE_URL" "$ETC/operator.env FLEET_OPERATOR_DATABASE_URL" "$ETC/dashboard.env FLEET_DASHBOARD_DATABASE_URL"; do loginof $x; done | sort -u | tr '\n' ' ')
for l in $LOGINS; do [[ "$l" =~ ^[a-z_]+$ ]] || die "unexpected login name in a DSN"; done
sudo -u postgres createdb -O fleetadmin "$RH"
sudo -u postgres psql -X -q -d postgres -c "REVOKE ALL ON DATABASE $RH FROM PUBLIC" -c "GRANT CONNECT ON DATABASE $RH TO $(echo $LOGINS | sed 's/ /, /g')"
sudo -u postgres pg_restore -d "$RH" --exit-on-error < <(sudo cat $D)
H0=$(head_); echo "throwaway copy restored: schema $(rh 'SELECT max(version) FROM fleet.fleet_schema_migrations'), ledger head ${H0:0:24}…, logins: $LOGINS"

# Env copies (0600, owned by each service user; DSNs re-pointed, never printed).
sudo install -d -m 0700 -o $SVCU -g $SVCU $R/svc; sudo install -d -m 0750 -o root -g $OPU $R/op; sudo install -d -m 0700 -o $DASHU -g $DASHU $R/dash
runtime_env() { # <commit> <build> <lock> -> runtime.env for a throwaway controller (no public listener, no reaper, no cognition provider)
  sudo grep -vE '^(FLEET_RUNTIME_(COMMIT|BUILD_ID|LOCKFILE_SHA256)|FLEET_API_LISTEN|FLEET_PUBLIC_LISTEN|FLEET_PUBLIC_PROXY_PROTOCOL|FLEET_REMOTE_LISTEN_ENABLED|FLEET_REAPER_INTERVAL_MS|FLEET_TLS_(CERT|KEY)_FILE|FLEET_COGNITION_[A-Z_]*)=' $ENVF
  printf '%s\n' "FLEET_RUNTIME_COMMIT=$1" "FLEET_RUNTIME_BUILD_ID=$2" "FLEET_RUNTIME_LOCKFILE_SHA256=$3" FLEET_API_LISTEN=127.0.0.1:28787 FLEET_REMOTE_LISTEN_ENABLED=false FLEET_REAPER_INTERVAL_MS=0
}
{ dsn $ETC/service.env FLEET_SERVICE_DATABASE_URL; dsn $ETC/service.env FLEET_AGENT_DATABASE_URL; } | sudo install -m 0600 -o $SVCU -g $SVCU /dev/stdin $R/svc/service.env
# operator.env keeps its production ownership (root:<operator group> 0640; the Operator API refuses anything else).
{ sudo grep -vE '^FLEET_OPERATOR_DATABASE_URL=' $ETC/operator.env; dsn $ETC/operator.env FLEET_OPERATOR_DATABASE_URL; } | sudo install -m 0640 -o root -g $OPU /dev/stdin $R/op/operator.env
{ dsn $ETC/dashboard.env FLEET_DASHBOARD_DATABASE_URL; echo "FLEET_DASHBOARD_STATIC_DIR=$UI"; } | sudo install -m 0600 -o $DASHU -g $DASHU /dev/stdin $R/dash/dashboard.env
head -c 32 /dev/urandom | base64 | sudo install -m 0600 -o $DASHU -g $DASHU /dev/stdin $R/dash/dashboard.key
for f in $R/svc/service.env $R/op/operator.env $R/dash/dashboard.env; do
  [[ "$(sudo grep -c "/$LIVE\([?]\|\$\)" $f)" == 0 && "$(sudo grep -c "/$RH" $f)" -ge 1 ]] || die "a throwaway DSN was not re-pointed ($f)"; done

ctl() { # <dir> <entry> <commit> <build> <lock>: start a throwaway controller; echoes ready|refused
  runtime_env "$3" "$4" "$5" | sudo install -m 0644 -o root -g root /dev/stdin $R/runtime.env
  sudo systemctl reset-failed fleet-upgrade-rh-controller.service 2>/dev/null || true
  sudo systemd-run --quiet --unit=fleet-upgrade-rh-controller -p User=$SVCU -p Group=$SVCU -p WorkingDirectory="$1" -p UMask=0077 -p Restart=no \
    --setenv=NODE_ENV=production --setenv=FLEET_SERVICE_EXPECTED_USER=$SVCU --setenv=FLEET_RUNTIME_ENV_FILE=$R/runtime.env \
    --setenv=FLEET_SERVICE_ENV_FILE=$R/svc/service.env --setenv=FLEET_AUDIT_LOG=$R/svc/audit.jsonl /opt/automaton-fleet/node/bin/node $2
  for _ in $(seq 1 60); do
    [[ "$(code http://127.0.0.1:28787/readyz)" == 200 ]] && { echo ready; return 0; }
    systemctl is-active --quiet fleet-upgrade-rh-controller.service || { echo refused; return 0; }; sleep 1; done
  echo refused
}
dash() { # <dir> <entry>: start a throwaway dashboard
  sudo systemctl reset-failed fleet-upgrade-rh-dashboard.service 2>/dev/null || true
  sudo systemd-run --quiet --unit=fleet-upgrade-rh-dashboard -p User=$DASHU -p Group=$DASHU -p WorkingDirectory="$1" -p UMask=0077 -p Restart=no \
    -p EnvironmentFile=$R/dash/dashboard.env --setenv=NODE_ENV=production --setenv=FLEET_DASHBOARD_EXPECTED_USER=$DASHU \
    --setenv=FLEET_DASHBOARD_ORIGIN=https://admin.agentfleet.vip --setenv=FLEET_DASHBOARD_LISTEN=127.0.0.1:28790 --setenv=FLEET_DASHBOARD_STATE_DIR=$R/dash \
    /opt/automaton-fleet/node/bin/node $2
  for _ in $(seq 1 40); do [[ "$(code http://127.0.0.1:28790/login/)" == 200 ]] && { echo ready; return 0; }
    systemctl is-active --quiet fleet-upgrade-rh-dashboard.service || { echo refused; return 0; }; sleep 1; done
  echo refused
}

# 1. Candidate migration of the copy; candidate runtime approved in the throwaway registry.
cli migrate 2>&1 | tail -1
[[ "$(rh 'SELECT max(version) FROM fleet.fleet_schema_migrations')" == "$TO" ]] || die "copy is not at schema $TO"
cli approve-runtime 2>&1 | tail -1 | grep -q "$B" || die "candidate not approved in the throwaway registry"
[[ "$(head_)" == "$H0" ]] || die "the migration moved the ledger head"
echo "1. copy migrated to $TO; candidate ${C:0:7} approved in the THROWAWAY registry; ledger head unchanged"

# 2. The current release refuses the new schema (its reason read from THIS run's journal only).
T2=$(date -u '+%Y-%m-%d %H:%M:%S')
r=$(ctl "$OLDDIR" dist/fleet/service/main.js "$OLD" "$(sudo sed -n 's/^FLEET_RUNTIME_BUILD_ID=//p' $ENVF)" "$(sudo sed -n 's/^FLEET_RUNTIME_LOCKFILE_SHA256=//p' $ENVF)")
why=$(sudo journalctl -u fleet-upgrade-rh-controller --since "$T2" -o cat --no-pager | grep -oE "schema version [0-9a-z]+ != (required )?[0-9]+|schema v[0-9]+ != required v[0-9]+" | head -1 || true)
stopall
[[ "$r" == refused ]] || die "the current release ${OLD:0:7} ran on schema $TO: an application-only rollback would be possible; re-plan"
echo "2. current release ${OLD:0:7} on schema $TO: REFUSED (${why:-not ready}) — rollback must restore the database (class B)"

# 3. Candidate services on the migrated copy.
r=$(ctl "$TOOL" "--import tsx src/fleet/service/main.ts" "$C" "$B" "$L"); [[ "$r" == ready ]] || { sudo journalctl -u fleet-upgrade-rh-controller -o cat --no-pager | tail -8; die "candidate controller not ready"; }
RZ=$(curl -s --max-time 5 http://127.0.0.1:28787/readyz)
echo "3a. candidate controller ready on schema $TO: $(echo "$RZ" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(JSON.stringify({ok:j.ok,checks:Object.fromEntries(Object.entries(j.checks??{}).map(([k,v])=>[k,v?.ok??v]))}))}catch{console.log(s.slice(0,200))}})')"
sudo systemctl reset-failed fleet-upgrade-rh-operator.service 2>/dev/null || true
sudo install -d -m 0700 -o $OPU -g $OPU $R/svc-op-audit
sudo systemd-run --quiet --unit=fleet-upgrade-rh-operator -p User=$OPU -p Group=$OPU -p WorkingDirectory=$TOOL -p UMask=0077 -p Restart=no \
  --setenv=NODE_ENV=production --setenv=FLEET_OPERATOR_EXPECTED_USER=$OPU --setenv=FLEET_OPERATOR_LISTEN=127.0.0.1:28788 \
  --setenv=FLEET_OPERATOR_ENV_FILE=$R/op/operator.env --setenv=FLEET_RUNTIME_ENV_FILE=$R/runtime.env --setenv=FLEET_OPERATOR_AUDIT_LOG=$R/svc-op-audit/audit.jsonl \
  --setenv=FLEET_OPERATOR_REQUIRE_TIMESYNC=true /opt/automaton-fleet/node/bin/node --import tsx src/fleet/operator/main.ts
OK=0; for _ in $(seq 1 40); do [[ "$(code http://127.0.0.1:28788/readyz)" == 200 ]] && { OK=1; break; }; sleep 1; done
[[ $OK == 1 ]] || { sudo journalctl -u fleet-upgrade-rh-operator -o cat --no-pager | tail -8; die "candidate Operator API not ready"; }
echo "3b. candidate Operator API ready on schema $TO (readyz 200)"
r=$(dash "$TOOL" "--import tsx src/fleet/dashboard/main.ts"); [[ "$r" == ready ]] || { sudo journalctl -u fleet-upgrade-rh-dashboard -o cat --no-pager | tail -8; die "candidate dashboard not ready"; }
echo "3c. candidate dashboard ready on schema $TO: login $(code http://127.0.0.1:28790/login/), preview $(code http://127.0.0.1:28790/hq-preview/login/), read without session $(code 'http://127.0.0.1:28790/api/read?op=projects'), call without session $(code -X POST -H 'Origin: https://admin.agentfleet.vip' -H 'Content-Type: application/json' --data '{}' http://127.0.0.1:28790/api/call)"
PJ=$(rh "SELECT fleet.fleet_admin_projects('{}'::jsonb)::text")
echo "3d. v42 projects read (the dashboard 'projects' op): $(echo "$PJ" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=j.result??j;console.log(JSON.stringify({projects:(r.projects??[]).length,summary:r.summary}))})')"
[[ "$(echo "$PJ" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=j.result??j;console.log((r.projects??[]).length)})')" == "$(rh 'SELECT count(*) FROM fleet.fleet_projects')" ]] || die "projects read disagrees with the table"
if [[ -n "$(rh "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'fleet' AND p.proname = 'fleet_command_events'")" ]]; then
  # v44+: Fleet Command's read returns only P0–P3; the raw history stays complete; notification housekeeping never routes in.
  CE=$(rh "SELECT jsonb_build_object('rows', jsonb_array_length(r), 'nonOperational', (SELECT count(*) FROM jsonb_array_elements(r) x WHERE x ->> 'priority' NOT IN ('P0_CRITICAL','P1_HIGH','P2_IMPORTANT','P3_SUMMARY')),
    'housekeeping', (SELECT count(*) FROM jsonb_array_elements(r) x WHERE x ->> 'type' IN ('notifications_deleted','session_opened','ledger_journal_posted','runtime_approved')),
    'rawEvents', (SELECT count(*) FROM fleet.fleet_events)) FROM fleet.fleet_command_events(1000) r")
  [[ "$(echo "$CE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.nonOperational===0&&j.housekeeping===0?"ok":"bad")})')" == ok ]] || die "command_events returned non-operational rows: $CE"
  echo "3f. Fleet Command read on the copy: $CE (only P0–P3; no housekeeping; the raw history is untouched)"
fi
if [[ -n "$(rh "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'fleet' AND p.proname = 'fleet_event_in_history'")" ]]; then
  # v45: no routine copy survives the purge; the history read holds no plumbing; the retention pass runs and writes no event.
  HC=$(rh "SELECT jsonb_build_object('events', (SELECT count(*) FROM fleet.fleet_events),
    'copies', (SELECT count(*) FROM fleet.fleet_events WHERE fleet.fleet_event_retention_days(event_type, detail) = 7 AND created_at < now() - interval '1 hour'),
    'history', (SELECT count(*) FROM fleet.fleet_events WHERE fleet.fleet_event_in_history(event_type, detail)),
    'temporary7d', (SELECT count(*) FROM fleet.fleet_events WHERE fleet.fleet_event_retention_days(event_type, detail) = 7),
    'diagnostics', (SELECT count(*) FROM fleet.fleet_events WHERE fleet.fleet_event_retention_days(event_type, detail) = 30),
    'hiddenPermanent', (SELECT count(*) FROM fleet.fleet_events WHERE NOT fleet.fleet_event_in_history(event_type, detail) AND fleet.fleet_event_retention_days(event_type, detail) IS NULL),
    'feed', (SELECT count(*) FROM fleet.fleet_command_feed), 'notifications', (SELECT count(*) FROM fleet.fleet_notifications))")
  M0=$(rh 'SELECT max(id) FROM fleet.fleet_events'); RET=$(rh 'SELECT fleet.svc_event_retention()'); M1=$(rh 'SELECT max(id) FROM fleet.fleet_events')
  [[ "$(echo "$HC" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.copies===0&&j.hiddenPermanent===0&&j.history+j.temporary7d+j.diagnostics===j.events?"ok":"bad")})')" == ok && "$M0" == "$M1" ]] || die "v45 history check failed: $HC (retention $RET, max id $M0 -> $M1)"
  echo "3g. Fleet history on the copy: $HC; retention pass $RET, no event written"
fi
[[ "$(rh "SELECT (fleet.fleet_ledger_verify() ->> 'ok')")" == true && "$(head_)" == "$H0" ]] || die "ledger changed or failed verification while the candidate ran"
[[ "$(rh "SELECT count(*) FROM fleet.fleet_agents WHERE status IN ('reserved','provisioning')")" == 0 ]] || die "a reservation appeared"
echo "3e. ledger verify ok, head unchanged, no reservation or birth while the candidate services ran"
stopall

# 4. The cutover's exact rollback, on the copy: drop the migrated schema, restore the pre-migration dump.
sudo -u postgres psql -X -q -d "$RH" -c "SET client_min_messages = warning" -c "DROP SCHEMA fleet CASCADE"
sudo -u postgres pg_restore -d "$RH" --exit-on-error < <(sudo cat $D)
[[ "$(rh 'SELECT max(version) FROM fleet.fleet_schema_migrations')" == "$FROM" && "$(head_)" == "$H0" ]] || die "rollback restore is not schema $FROM with the same ledger head"
echo "4. rollback restore: schema $FROM, ledger head identical"

# 5. The current release runs again on the restored schema.
r=$(ctl "$OLDDIR" dist/fleet/service/main.js "$OLD" "$(sudo sed -n 's/^FLEET_RUNTIME_BUILD_ID=//p' $ENVF)" "$(sudo sed -n 's/^FLEET_RUNTIME_LOCKFILE_SHA256=//p' $ENVF)")
[[ "$r" == ready ]] || { sudo journalctl -u fleet-upgrade-rh-controller -o cat --no-pager | tail -8; die "current release not ready after the rollback"; }
r2=$(dash "$OLDDIR" dist/fleet/dashboard/main.js); [[ "$r2" == ready ]] || die "current dashboard not ready after the rollback"
[[ "$(head_)" == "$H0" ]] || die "ledger moved after the rollback"
echo "5. current release ${OLD:0:7}: controller ready, dashboard ready on the restored schema $FROM; ledger head identical"
stopall

[[ "$(systemctl show -p MainPID --value automaton-fleet.service automaton-fleet-operator-api.service automaton-fleet-dashboard.service | tr '\n' ' ')" == "$LIVEPIDS" ]] || die "a production PID changed during the rehearsal"
[[ "$(live 'SELECT max(version) FROM fleet.fleet_schema_migrations')" == "$FROM" ]] || die "live schema changed"
echo "$C $B $L $FROM $TO $(ts)" > ~/upgrade-rehearsal-${C:0:7}.ok
echo "== UPGRADE REHEARSAL PASSED $(ts) — production untouched (PIDs $LIVEPIDS, schema $FROM)"
