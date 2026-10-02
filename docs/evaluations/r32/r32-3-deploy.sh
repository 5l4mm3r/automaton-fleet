#!/usr/bin/env bash
# R32-3: controller + schema v34 (agent operational identity + owner identity broker), adapted from r31-3. The broker unit is NOT installed. NEVER touches the founder unit.
# Fail closed: an unexpected migrate-check restores the previous release with the schema untouched.
set -euo pipefail
export PATH=/opt/automaton-fleet/node/bin:$PATH
C=27b07e90baccbbb263440b3d8d77d5c040ff1b98; B=1c430ef8ebec0ec72b25b6bd35eee2a4a3e3c04dcfcfbf48424eafbd60c60ba4
L=eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811
OLD=3aebcc22107a0dfebe9123f58df004ccdc1d155b
F=automaton-fleet-founder@01M3F50SH7PNX2E3GST13J52AS.service
MEM=/var/lib/private/automaton-founders/01M3F50SH7PNX2E3GST13J52AS/state/st_01M3F50SH8JVSDE1QBRN591114/memory
f=/etc/automaton-fleet/runtime.env
UNITS_STOP="automaton-fleet-operator-api.service automaton-fleet-chatgpt-adapter.socket automaton-fleet-chatgpt-adapter.service automaton-fleet-custody.service automaton-fleet-fetcher.socket automaton-fleet-fetcher.service automaton-fleet.service"
psqlq() { sudo -u postgres psql -X -At -d automaton_fleet -c "$1"; }
ts() { date -u +%FT%TZ; }
grep -qx "FLEET_RUNTIME_COMMIT=$C" ~/r32-pins.txt && grep -qx "FLEET_RUNTIME_BUILD_ID=$B" ~/r32-pins.txt && grep -qx "FLEET_RUNTIME_LOCKFILE_SHA256=$L" ~/r32-pins.txt
grep -qx "FLEET_RUNTIME_COMMIT=$OLD" <(sudo grep -E "^FLEET_RUNTIME_COMMIT=" $f)
grep -qx "FLEET_RUNTIME_LOCKFILE_SHA256=$L" <(sudo grep -E "^FLEET_RUNTIME_LOCKFILE_SHA256=" $f)
test "$(readlink /opt/automaton-fleet/current)" = "releases/$OLD"
test "$(psqlq 'SELECT max(version) FROM fleet.fleet_schema_migrations')" = 33
for k in REAL_REPLICATION_ENABLED REAL_PAYMENTS_ENABLED OWNER_SWEEP_ENABLED FLEET_DRY_RUN_CHILD; do grep -qx "$k=false" <(sudo grep -E "^$k=" $f); done
PID0=$(systemctl show -p MainPID --value $F); NR0=$(systemctl show -p NRestarts --value $F); PIN0=$(sudo sha256sum /etc/automaton-fleet/founders/01M3F50SH7PNX2E3GST13J52AS.runtime.env | cut -c1-16)
FACTS0=$(sudo sha256sum $MEM/facts.json | cut -c1-64)
echo "founder before: pid $PID0 restarts $NR0 pin-sha $PIN0 facts $FACTS0"
echo "pins before: $(sudo grep -E '^FLEET_RUNTIME_(COMMIT|BUILD_ID)=' $f | tr '\n' ' ') current $(readlink /opt/automaton-fleet/current)"
# ── preparation (no outage)
sudo test ! -e $f.pre-r32
sudo cp -p $f $f.pre-r32
sudo sed -i -e "s/^FLEET_RUNTIME_COMMIT=.*/FLEET_RUNTIME_COMMIT=$C/" -e "s/^FLEET_RUNTIME_BUILD_ID=.*/FLEET_RUNTIME_BUILD_ID=$B/" $f
echo "pins: $(sudo grep -E '^FLEET_RUNTIME_(COMMIT|BUILD_ID|LOCKFILE_SHA256)=' $f | tr '\n' ' ') (pre-r32 sha $(sudo sha256sum $f.pre-r32 | cut -c1-16))"
cd ~/automaton-fleet-build
scripts/fleet-deploy-release.sh build > ~/r32-stage.log 2>&1; tail -1 ~/r32-stage.log
git fetch -q origin "$C"; git checkout -q --detach $C; test "$(git rev-parse HEAD)" = $C; CI=true pnpm install --frozen-lockfile > ~/r32-tooling.log 2>&1
sudo scripts/fleet-deploy-release.sh install 2>&1 | tail -1
test "$(readlink /opt/automaton-fleet/current)" = "releases/$C"
# ── outage
for i in $(seq 1 90); do [ "$(psqlq 'SELECT count(*) FROM fleet.fleet_cognition_inflight')" = 0 ] && break; sleep 2; done
echo "inflight: $(psqlq 'SELECT count(*) FROM fleet.fleet_cognition_inflight')"
echo "OUTAGE START $(ts)"
sudo systemctl stop $UNITS_STOP
STAMP=$(date -u +%Y%m%dT%H%M%SZ); D=~/automaton_fleet-v33-pre-v34-$STAMP.dump
( umask 077; sudo -u postgres pg_dump -Fc -n fleet automaton_fleet > "$D" )
chmod 600 "$D"; sha256sum "$D" > "$D.sha256"
echo "dump $D $(stat -c '%s B mode %a owner %U' "$D") sha $(cut -c1-64 "$D.sha256")"
echo "dump readable: $(pg_restore -l "$D" | grep -c 'TABLE DATA') tables with data, $(pg_restore -l "$D" | grep -c ' FUNCTION ') functions"
sha256sum -c --quiet "$D.sha256" && echo "dump sha verified"
echo "ledger head at cutover: $(psqlq "SELECT head_seq || ' ' || head_hash || ' journals ' || (SELECT count(*) FROM fleet.fleet_ledger_journal) FROM fleet.fleet_ledger_head")"
CHK=$(pnpm -s fleet:migrate-check 2>&1 | tail -1); echo "migrate-check: $CHK"
if ! echo "$CHK" | grep -q '"currentVersion":33,"resultingVersion":34,"wouldApply":\[34\]'; then
  echo "UNEXPECTED migrate-check: restoring the previous release (schema untouched)"; sudo cp -p $f.pre-r32 $f
  sudo ln -sfn "releases/$OLD" /opt/automaton-fleet/current.tmp && sudo mv -T /opt/automaton-fleet/current.tmp /opt/automaton-fleet/current
  sudo systemctl start automaton-fleet.service automaton-fleet-operator-api.service automaton-fleet-custody.service automaton-fleet-fetcher.socket automaton-fleet-chatgpt-adapter.socket
  echo "OUTAGE END (rolled back) $(ts)"; exit 1
fi
pnpm -s fleet:migrate 2>&1 | tail -2
SV=$(psqlq 'SELECT max(version) FROM fleet.fleet_schema_migrations'); echo "migrated $(ts): schema $SV"
test "$SV" = 34 || { echo "SCHEMA NOT 34: STOP (services left stopped; restore the pre-v34 dump)"; exit 2; }
pnpm -s fleet:audit-privileges > ~/r32-audit.txt 2>&1 && echo "audit PASS" || { echo "AUDIT FAILED: STOP (services left stopped)"; tail -15 ~/r32-audit.txt; exit 3; }
pnpm -s fleet:admin approve-runtime > ~/r32-approve.log 2>&1 && echo "approved" || { echo "APPROVE FAILED: STOP"; tail -5 ~/r32-approve.log; exit 4; }
pnpm -s fleet:verify-runtime 2>&1 | tail -1
sudo systemctl start automaton-fleet.service
for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:8787/readyz 2>/dev/null && break; sleep 1; done
sudo systemctl start automaton-fleet-operator-api.service automaton-fleet-custody.service automaton-fleet-fetcher.socket automaton-fleet-chatgpt-adapter.socket
echo "OUTAGE END $(ts)"
echo "readyz $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/readyz)"
echo "controller cwd $(sudo readlink /proc/$(systemctl show -p MainPID --value automaton-fleet)/cwd)"
echo "founder after: pid $(systemctl show -p MainPID --value $F) restarts $(systemctl show -p NRestarts --value $F) pin-sha $(sudo sha256sum /etc/automaton-fleet/founders/01M3F50SH7PNX2E3GST13J52AS.runtime.env | cut -c1-16) facts $(sudo sha256sum $MEM/facts.json | cut -c1-64)"
for u in automaton-fleet automaton-fleet-operator-api automaton-fleet-custody automaton-fleet-fetcher.socket automaton-fleet-chatgpt-adapter.socket automaton-fleet-chatgpt-tunnel "$F"; do echo "$u: $(systemctl is-active $u)"; done
# ── post-cutover verification (read-only)
pnpm -s fleet:doctor > ~/r32-doctor-after.txt 2>&1 || true
grep -E "\[(FAIL|WARN)\]|^DEPLOYMENT|^SAFE FOR" ~/r32-doctor-after.txt
pnpm -s fleet:verify > ~/r32-verify-after.txt 2>&1 || true; grep -E "^SAFE FOR|PASS|FAIL" ~/r32-verify-after.txt | tail -4
sudo scripts/fleet-verify-deployment.sh > ~/r32-vdep.txt 2>&1 || true; tail -3 ~/r32-vdep.txt
pnpm -s fleet:admin ledger-verify 2>&1 | tail -3
pnpm -s fleet:admin hub-health > ~/r32-hub-health.json 2>&1 || true; node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log("hub-health ok="+j.ok+" "+j.findings.map(f=>f.code+":"+f.severity).join(" "))' ~/r32-hub-health.json || head -5 ~/r32-hub-health.json
pnpm -s fleet:admin hub reconcile > ~/r32-hub-reconcile.json 2>&1 || true; head -c 600 ~/r32-hub-reconcile.json; echo
echo "custody: $(pnpm -s fleet:admin hub-custody 2>&1 | tr -d '\n ' | head -c 400)"
echo "v34 identity: $(psqlq "SELECT fleet.fleet_identity_status()::text") | broker unit $(systemctl is-enabled automaton-fleet-identity.service 2>/dev/null || echo not-installed)"
echo "v33: tax fallback $(psqlq "SELECT unprofiled_reserve_bp FROM fleet.fleet_tax_policy"), sale tax without profile $(psqlq "SELECT fleet.fleet_tax_for_sale(NULL, 1200, 50) ->> 'totalMinor'")"
echo "flags: $(sudo grep -E '^(REAL_REPLICATION_ENABLED|REAL_PAYMENTS_ENABLED|OWNER_SWEEP_ENABLED|FLEET_DRY_RUN_CHILD)=' $f | tr '\n' ' ')"
echo "== R32-3 end $(ts)"
