#!/usr/bin/env bash
# Automaton Fleet — routine controller rollout (master handoff §39): BUILD → TEST → REHEARSE → VERIFY → DEPLOY → VERIFY →
# AUTO-ROLLBACK ON FAILURE → AUDIT → REPORT. The R29–R32 procedure, parameterised. Controller-side units only; Founder
# runtimes are never touched (their upgrades stay a separate, explicit step).
#
#   scripts/fleet-rollout.sh rehearse <pinsFile> <fromSchema> <toSchema>
#       fresh read-only dump + Founder state backup, isolated restore, real-data migration of a THROWAWAY database with
#       the candidate tooling, audit, ledger / Founder fingerprints / identity unchanged, re-run no-op, rollback proof,
#       cleanup. Writes ~/rollout-<commit7>-rehearsal.ok on success. Never writes to the live database.
#   scripts/fleet-rollout.sh cutover <pinsFile> <fromSchema> <toSchema>
#       refuses unless a successful rehearsal of the SAME commit exists from the last 24 h; then stage + install the
#       release, stop controller-side units, pre-migration dump, fail-closed migrate-check, migrate, audit, approve,
#       verify-runtime, start, readyz. ANY failure after the dump rolls back automatically: previous runtime.env and
#       release, the pre-migration dump restored into the live database, units restarted — and reports it.
#
#   scripts/fleet-rollout.sh revert <pinsFile> <fromSchema> <toSchema> <reason…>
#       undo a SUCCESSFUL cutover of the same pins (scripts/fleet-release.sh, when a later release step fails): exactly the
#       automatic rollback — controller-side units stopped, the cutover's verified pre-migration dump restored into the
#       live database, the previous runtime.env and release, units started — then ONE production_rolled_back event.
#   FLEET_ROLLOUT_DEFER_EVENT=1 (cutover): do not record production_deployed (the release script records the outcome
#       of the whole release); the cutover still records production_rolled_back if it rolls itself back.
#
# <pinsFile>: the four lines printed by scripts/fleet-build-runtime.sh for the candidate (REPO, COMMIT, BUILD_ID,
# LOCKFILE_SHA256), produced on this host. Runs as the operator account (ubuntu) with sudo for the privileged steps.
# Real payments, owner sweeps, replication and the dry-run child flag are asserted false before and after.
set -euo pipefail
export PATH=/opt/automaton-fleet/node/bin:$PATH
MODE="${1:-}"; PINS="${2:-}"; FROM="${3:-}"; TO="${4:-}"
die() { echo "ROLLOUT REFUSED: $*" >&2; exit 2; }
[[ "$MODE" == rehearse || "$MODE" == cutover || "$MODE" == revert ]] || die "mode is rehearse, cutover or revert"
[[ -f "$PINS" && ! -L "$PINS" ]] || die "pins file missing"
[[ "$FROM" =~ ^[0-9]{1,3}$ && "$TO" =~ ^[0-9]{1,3}$ && "$TO" -ge "$FROM" ]] || die "schemas are integers, to >= from"
grep -qxE 'FLEET_RUNTIME_REPO=https://github\.com/5l4mm3r/automaton-fleet\.git' "$PINS" || die "pins: unexpected repository"
C=$(sed -n 's/^FLEET_RUNTIME_COMMIT=\([0-9a-f]\{40\}\)$/\1/p' "$PINS"); B=$(sed -n 's/^FLEET_RUNTIME_BUILD_ID=\([0-9a-f]\{64\}\)$/\1/p' "$PINS")
L=$(sed -n 's/^FLEET_RUNTIME_LOCKFILE_SHA256=\([0-9a-f]\{64\}\)$/\1/p' "$PINS")
[[ -n "$C" && -n "$B" && -n "$L" && $(wc -l < "$PINS") -eq 4 ]] || die "pins file must hold exactly the four pins"
LIVE=automaton_fleet; RH=automaton_fleet_rollout_rh; F=01M3F50SH7PNX2E3GST13J52AS
ENVF=/etc/automaton-fleet/runtime.env
OLD=$(sudo sed -n 's/^FLEET_RUNTIME_COMMIT=//p' $ENVF); [[ "$OLD" =~ ^[0-9a-f]{40}$ ]] || die "current pin unreadable"
[[ "$MODE" == revert || "$OLD" != "$C" ]] || die "the candidate is already the running release"
WANT="\"currentVersion\":$FROM,\"resultingVersion\":$TO,\"wouldApply\":\[$(seq -s, $((FROM + 1)) "$TO")\]"
REPORT=~/rollout-${C:0:7}-$MODE.txt
exec > >(tee -a "$REPORT") 2>&1
ts() { date -u +%FT%TZ; }
live() { sudo -u postgres psql -X -At -d "$LIVE" -c "$1"; }
# Reconciliation snapshot of <db> as JSON (scripts/fleet-reconcile-snapshot.sql from <tree>); <cutJson>: an earlier snapshot whose
# event / journal / posting high-water marks bound the digests ("" = everything).
ALLV=9223372036854775807
snapshot() { local db=$1 tree=$2 cut=${3:-} e=$ALLV q=$ALLV p=$ALLV
  if [[ -n "$cut" ]]; then read -r e q p < <(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(j.events.maxId,j.ledger.maxSeq,j.ledger.maxPosting)' "$cut"); fi
  sudo -u postgres psql -X -q -At -v ON_ERROR_STOP=1 -v cut_event="$e" -v cut_seq="$q" -v cut_posting="$p" -d "$db" < "$tree/scripts/fleet-reconcile-snapshot.sql"; }
flags() { for k in REAL_REPLICATION_ENABLED REAL_PAYMENTS_ENABLED OWNER_SWEEP_ENABLED FLEET_DRY_RUN_CHILD; do grep -qx "$k=false" <(sudo grep -E "^$k=" $ENVF) || die "$k is not false"; done; }
echo "== rollout $MODE ${C:0:7} (schema $FROM -> $TO) from ${OLD:0:7} start $(ts)"
flags

if [[ "$MODE" == revert ]]; then
  REASON=$(echo "${*:5}" | tr -cd 'A-Za-z0-9 .:_/-' | cut -c1-200); [[ -n "$REASON" ]] || die "revert needs a reason"
  ST=~/rollout-${C:0:7}-cutover.state; [[ -f "$ST" && ! -L "$ST" ]] || die "no cutover state for ${C:0:7} ($ST)"
  get() { sed -n "s/^$1=//p" "$ST" | head -1; }
  SD=$(get DUMP); SOLD=$(get OLD); LATE=$(get LATE)
  [[ "$(get COMMIT)" == "$C" && "$(get FROM)" == "$FROM" && "$(get TO)" == "$TO" ]] || die "the cutover state is for different pins or schemas"
  [[ "$SOLD" =~ ^[0-9a-f]{40}$ && -d /opt/automaton-fleet/releases/$SOLD ]] || die "previous release unknown"
  [[ "$OLD" == "$C" && "$(readlink /opt/automaton-fleet/current)" == "releases/$C" ]] || die "the running release is not ${C:0:7}"
  test "$(live 'SELECT max(version) FROM fleet.fleet_schema_migrations')" = "$TO" || die "live schema is not $TO"
  [[ -f "$SD" && -f "$SD.sha256" ]] && sha256sum -c --quiet "$SD.sha256" || die "the pre-migration dump is missing or does not verify"
  for u in $LATE; do [[ "$u" =~ ^automaton-fleet-(dashboard|identity|browser|gumroad)\.service$ ]] || die "unexpected unit in state"; done
  UNITS="automaton-fleet-operator-api.service automaton-fleet-chatgpt-adapter.socket automaton-fleet-chatgpt-adapter.service automaton-fleet-custody.service automaton-fleet-fetcher.socket automaton-fleet-fetcher.service $LATE automaton-fleet.service"
  START="automaton-fleet.service automaton-fleet-operator-api.service automaton-fleet-custody.service automaton-fleet-fetcher.socket automaton-fleet-chatgpt-adapter.socket $LATE"
  # R41.1: a revert NEVER silently restores an older database over newer state.
  TOOLS=~/automaton-fleet-build; RB0=~/rollout-${C:0:7}-revert-before.json; RB1=~/rollout-${C:0:7}-revert-after.json; RB2=~/rollout-${C:0:7}-revert-reconcile.json
  CUTAFTER=~/rollout-${C:0:7}-cutover-after.json
  echo "REVERT START $(ts): $REASON"; sudo systemctl stop $UNITS
  test "$LIVE" = automaton_fleet
  # Writers are stopped: the state now is everything written since the cutover.
  snapshot $LIVE "$TOOLS" > "$RB0"
  SINCE=$(node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));let c={events:{maxId:0},ledger:{maxSeq:0}};try{c=JSON.parse(require("fs").readFileSync(process.argv[2],"utf8"))}catch{}
    console.log(`${Math.max(0,a.ledger.maxSeq-c.ledger.maxSeq)} ${Math.max(0,a.events.maxId-c.events.maxId)}`)' "$RB0" "$CUTAFTER")
  read -r NJ NE <<< "$SINCE"
  echo "post-cutover writes: $NJ ledger journal(s), $NE event(s) since the cutover"
  if [[ "$FROM" == "$TO" ]]; then
    # Code-only release: switch the code back and re-approve the previous runtime. The database is NOT restored, so every
    # post-cutover write (memory, work, ledger entries, events) is kept — proven by the reconciliation below.
    sudo cp -p $ENVF.pre-${C:0:7} $ENVF
    sudo ln -sfn "releases/$SOLD" /opt/automaton-fleet/current.tmp && sudo mv -T /opt/automaton-fleet/current.tmp /opt/automaton-fleet/current
    (cd "$TOOLS" && pnpm -s fleet:admin approve-runtime > ~/rollout-revert-approve.log 2>&1 && pnpm -s fleet:verify-runtime > ~/rollout-revert-verify.log 2>&1) \
      || die "re-approving the previous runtime failed: INVESTIGATE NOW (units stopped; database untouched)"
    sudo systemctl start $START
    for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:8787/readyz 2>/dev/null && break; sleep 1; done
    snapshot $LIVE "$TOOLS" "$RB0" > "$RB1"
    node "$TOOLS/scripts/fleet-reconcile-compare.mjs" "$RB0" "$RB1" "$FROM" "$TO" "runtime_approved" > "$RB2" || { cat "$RB2"; die "code-only revert lost or changed state: INVESTIGATE NOW"; }
    echo "code-only revert: database untouched; reconciliation OK ($RB2): all $NJ post-cutover journal(s) and $NE event(s) preserved"
    live "SELECT fleet.fleet_event('production_rolled_back', NULL, 'operator:release', jsonb_build_object('commit', '${C:0:12}', 'fromSchema', $FROM, 'toSchema', $TO, 'reason', '$REASON', 'mode', 'code-only', 'preservedJournals', $NJ, 'preservedEvents', $NE))" > /dev/null
    echo "== ROLLOUT ${C:0:7} REVERTED (code only) $(ts): schema $FROM, release $(readlink /opt/automaton-fleet/current), readyz $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/readyz)"
    exit 0
  fi
  # A schema-changing release: the previous release cannot run on the new schema, so a revert means restoring the
  # pre-migration dump. The state written since the cutover is first preserved in its own verified dump, and the discard
  # must be acknowledged explicitly (exact counts) — except inside fleet-release.sh's own immediate revert, which records
  # the counts in the rollback event.
  STAMP=$(date -u +%Y%m%dT%H%M%SZ); PD=~/automaton_fleet-v$TO-post-cutover-${C:0:7}-$STAMP.dump
  ( umask 077; sudo -u postgres pg_dump -Fc -n fleet "$LIVE" > "$PD" ); chmod 600 "$PD"; sha256sum "$PD" > "$PD.sha256"
  echo "post-cutover state preserved: $PD ($(cut -c1-16 "$PD.sha256"))"
  if [[ "${FLEET_REVERT_IN_RELEASE:-0}" != 1 && ( "$NJ" != 0 || "$NE" != 0 ) && "${FLEET_REVERT_DISCARD_ACK:-}" != "$NJ:$NE" ]]; then
    sudo systemctl start $START
    die "restoring the pre-migration dump would discard $NJ journal(s) and $NE event(s) written since the cutover (kept in $PD). Reconcile them, then re-run with FLEET_REVERT_DISCARD_ACK=$NJ:$NE to confirm"
  fi
  # Schema v52 (Gumroad design §11): a downgrade below v46 never drops settlement evidence or provider liabilities silently.
  # When any exist, this run exports them (CSV + sha256) and the revert needs FLEET_REVERT_PROVIDER_EXPORT=<that sha256>.
  if (( FROM < 46 && TO >= 46 )); then
    PROV=$(live "SELECT (SELECT count(*) FROM fleet.fleet_rail_capability_checks) + (SELECT count(*) FROM fleet.fleet_revenue_claims)
      + (SELECT count(*) FROM fleet.fleet_settlement_receipts) + (SELECT count(*) FROM fleet.fleet_provider_sales) + (SELECT count(*) FROM fleet.fleet_provider_payouts)
      + COALESCE((SELECT count(*) FROM fleet.fleet_paypal_transactions), 0)
      + (SELECT count(*) FROM fleet.fleet_ledger_accounts WHERE class IN ('provider_suspense','agent_provider_payable') AND fleet.fleet_ledger_balance(account_id) <> 0)")
    if [[ "$PROV" != 0 ]]; then
      PX=~/automaton_fleet-v$TO-provider-export-${C:0:7}-$STAMP; ( umask 077; mkdir -p "$PX" )
      for t in fleet_rail_capability_checks fleet_revenue_claims fleet_settlement_receipts fleet_settlement_destinations fleet_provider_accounts fleet_provider_sales \
               fleet_provider_payouts fleet_provider_payout_lines fleet_provider_allocations fleet_paypal_transactions fleet_paypal_checkouts fleet_card_charges fleet_card_receipts; do
        sudo -u postgres psql -X -q -d "$LIVE" -c "\\copy (SELECT * FROM fleet.$t) TO STDOUT WITH CSV HEADER" > "$PX/$t.csv" 2>/dev/null || true
      done
      live "SELECT a.account_id || ',' || fleet.fleet_ledger_balance(a.account_id) FROM fleet.fleet_ledger_accounts a WHERE a.class IN ('provider_suspense','agent_provider_payable','card_payable','card_cash_reserve','agent_cash_pending')" > "$PX/liabilities.csv"
      chmod 600 "$PX"/*; PXSHA=$(cat "$PX"/*.csv | sha256sum | cut -c1-64); echo "$PXSHA" > "$PX.sha256"
      echo "provider evidence exported: $PX ($PROV rows / balances; sha256 ${PXSHA:0:16})"
      if [[ "${FLEET_REVERT_PROVIDER_EXPORT:-}" != "$PXSHA" ]]; then
        sudo systemctl start $START
        die "provider settlement evidence or liabilities exist: do not revert below v46 — freeze and fix forward (gumroad / custody units off, rails suspended). If a revert is unavoidable, re-run with FLEET_REVERT_PROVIDER_EXPORT=$PXSHA after re-entering what must survive"
      fi
    fi
  fi
  sudo -u postgres psql -X -q -d $LIVE -c "SET client_min_messages = warning" -c "DROP SCHEMA fleet CASCADE"
  sudo -u postgres pg_restore -d $LIVE --exit-on-error < "$SD"
  sudo cp -p $ENVF.pre-${C:0:7} $ENVF
  sudo ln -sfn "releases/$SOLD" /opt/automaton-fleet/current.tmp && sudo mv -T /opt/automaton-fleet/current.tmp /opt/automaton-fleet/current
  sudo systemctl start $START
  for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:8787/readyz 2>/dev/null && break; sleep 1; done
  [[ "$(live 'SELECT max(version) FROM fleet.fleet_schema_migrations')" == "$FROM" ]] || die "after revert the schema is not $FROM: INVESTIGATE NOW"
  live "SELECT fleet.fleet_event('production_rolled_back', NULL, 'operator:release', jsonb_build_object('commit', '${C:0:12}', 'fromSchema', $FROM, 'toSchema', $TO, 'reason', '$REASON', 'mode', 'restore', 'discardedJournals', $NJ, 'discardedEvents', $NE, 'postCutoverDump', '$PD'))" > /dev/null
  echo "== ROLLOUT ${C:0:7} REVERTED (database restored; $NJ journal(s) / $NE event(s) since the cutover kept in $PD) $(ts): schema $FROM, release $(readlink /opt/automaton-fleet/current), readyz $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/readyz)"
  exit 0
fi
test "$(live 'SELECT max(version) FROM fleet.fleet_schema_migrations')" = "$FROM" || die "live schema is not $FROM"

if [[ "$MODE" == rehearse ]]; then
  TOOL=/var/tmp/rollout-tooling-${C:0:12}
  rh() { sudo -u postgres psql -X -At -v ON_ERROR_STOP=1 -d "$RH" -c "$1"; }
  RHURL="postgresql://postgres@/$RH?host=/var/run/postgresql&options=-c%20role%3Dfleetadmin%20-c%20search_path%3Dfleet"
  EMPTY=/var/tmp/rollout-empty.env; sudo rm -f "$EMPTY"; sudo -u postgres bash -c "umask 077; : > $EMPTY"
  cli() { sudo -u postgres env -i PATH="$PATH" HOME=/var/tmp FLEET_ADMIN_ENV_FILE=$EMPTY FLEET_RUNTIME_ENV_FILE=$EMPTY FLEET_ADMIN_DATABASE_URL="$RHURL" \
    bash -c "cd $TOOL && node --import tsx src/fleet/postgres/cli.ts $*"; }
  counts() { sudo -u postgres psql -X -At -d "$1" -c "SELECT string_agg(format('SELECT %L || ''='' || count(*) FROM fleet.%I', tablename, tablename), ' UNION ALL ' ORDER BY tablename) FROM pg_tables WHERE schemaname='fleet'" | sudo -u postgres psql -X -At -d "$1" | sort; }
  head_() { sudo -u postgres psql -X -At -d "$1" -c "SELECT head_seq || ' ' || head_hash || ' journals ' || (SELECT count(*) FROM fleet.fleet_ledger_journal) FROM fleet.fleet_ledger_head"; }
  ident() { sudo -u postgres psql -X -At -d "$1" -c "SELECT md5(row(agent_id, role, generation, origin, genesis_id, lineage_root, workspace_id, state_namespace, capability_manifest_id, name, wallet_address, created_at)::text) FROM fleet.fleet_agents WHERE agent_id='$F'"; }
  fp() { sudo -u postgres psql -X -At -d "$1" -c "SELECT fleet.fleet_founder_ledger_fingerprint('$F')"; }
  if [[ ! -d $TOOL ]]; then
    git clone -q ~/automaton-fleet-build "$TOOL"; git -C "$TOOL" fetch -q https://github.com/5l4mm3r/automaton-fleet.git "$C"; git -C "$TOOL" checkout -q --detach "$C"
    echo "$L  pnpm-lock.yaml" | (cd "$TOOL" && sha256sum -c --quiet -); (cd "$TOOL" && CI=true pnpm install --frozen-lockfile > ~/rollout-tooling.log 2>&1)
    chmod 755 "$TOOL"; chmod -R go+rX "$TOOL"
  fi
  test "$(git -C "$TOOL" rev-parse HEAD)" = "$C"
  if [[ -n "$(sudo -u postgres psql -X -At -d postgres -c "SELECT 1 FROM pg_database WHERE datname='$RH'")" ]]; then sudo -u postgres dropdb "$RH"; fi
  STAMP=$(date -u +%Y%m%dT%H%M%SZ); D=~/automaton_fleet-v$FROM-rollout-${C:0:7}-$STAMP.dump
  ( umask 077; sudo -u postgres pg_dump -Fc -n fleet "$LIVE" > "$D" ); chmod 600 "$D"; sha256sum "$D" > "$D.sha256"
  echo "dump $D sha $(cut -c1-16 "$D.sha256")"
  BK=/var/lib/automaton-fleet-backups/rollout-${C:0:7}-$STAMP; sudo install -d -m 0700 -o root -g root /var/lib/automaton-fleet-backups "$BK"
  sudo tar -C /var/lib/private/automaton-founders --exclude="$F/fleet-credentials.json" -cpf "$BK/founder-$F.tar" "$F"; sudo chmod 600 "$BK/founder-$F.tar"
  counts "$LIVE" > ~/rollout-counts-live.txt
  sudo -u postgres createdb -O fleetadmin "$RH"
  sudo -u postgres psql -X -q -d postgres -c "REVOKE ALL ON DATABASE $RH FROM PUBLIC"
  sudo -u postgres pg_restore -d "$RH" --exit-on-error < "$D"
  counts "$RH" > ~/rollout-counts-restored.txt
  diff -q ~/rollout-counts-live.txt ~/rollout-counts-restored.txt > /dev/null && echo "restore: row counts identical" || echo "restore: counts moved while dumping (live kept running)"
  H0=$(head_ "$RH"); I0=$(ident "$RH"); FP0=$(fp "$RH")
  RC0=~/rollout-${C:0:7}-rehearsal-before.json; RC1=~/rollout-${C:0:7}-rehearsal-after.json; RC2=~/rollout-${C:0:7}-rehearsal-reconcile.json
  snapshot "$RH" "$TOOL" > "$RC0"
  CHK=$(cli migrate-check 2>&1 | tail -1); echo "migrate-check: $CHK"; echo "$CHK" | grep -q "$WANT" || { sudo -u postgres dropdb "$RH"; die "unexpected migrate-check"; }
  cli migrate 2>&1 | tail -1
  test "$(rh 'SELECT max(version) FROM fleet.fleet_schema_migrations')" = "$TO" || { sudo -u postgres dropdb "$RH"; die "rehearsal schema is not $TO"; }
  cli audit-privileges > ~/rollout-rh-audit.txt 2>&1 || { tail -20 ~/rollout-rh-audit.txt; sudo -u postgres dropdb "$RH"; die "privilege audit failed"; }
  [[ "$(head_ "$RH")" == "$H0" ]] || { sudo -u postgres dropdb "$RH"; die "ledger head changed by the migration"; }
  snapshot "$RH" "$TOOL" "$RC0" > "$RC1"
  node "$TOOL/scripts/fleet-reconcile-compare.mjs" "$RC0" "$RC1" "$FROM" "$TO" > "$RC2" || { cat "$RC2"; sudo -u postgres dropdb "$RH"; die "reconciliation failed"; }
  echo "reconciliation: OK ($(node -e 'const r=require(process.argv[1]);console.log(r.newAccounts.length+" new accounts at zero; "+r.ledger.journals+" journals; events "+r.events.existing+" before, purged "+JSON.stringify(r.events.purged??{})+", preserved "+r.events.preserved+"; appended "+JSON.stringify(r.events.appended??{}))' "$RC2"))"
  [[ "$(ident "$RH")" == "$I0" ]] || { sudo -u postgres dropdb "$RH"; die "Founder 1 identity changed"; }
  FPCMP=$(FP0="$FP0" FP1="$(fp "$RH")" node -e 'const a=JSON.parse(process.env.FP0),b=JSON.parse(process.env.FP1);const mb=new Map(b.accounts.map(x=>[x.account,x]));const bad=[];
    for(const x of a.accounts){const y=mb.get(x.account);if(!y||y.balance!==x.balance||y.class!==x.class)bad.push(x.account)}for(const y of b.accounts)if(!a.accounts.some(x=>x.account===y.account)&&y.balance!==0)bad.push("new:"+y.account);
    console.log(bad.length?"BAD "+bad.join(" "):"OK")')
  [[ "$FPCMP" == OK ]] || { sudo -u postgres dropdb "$RH"; die "Founder 1 ledger fingerprint changed: $FPCMP"; }
  echo "ledger verify: $(rh "SELECT (fleet.fleet_ledger_verify() ->> 'ok')")"; [[ "$(rh "SELECT (fleet.fleet_ledger_verify() ->> 'ok')")" == true ]] || { sudo -u postgres dropdb "$RH"; die "ledger verify failed"; }
  echo "re-run: $(cli migrate-check 2>&1 | tail -1)"; cli migrate > /dev/null 2>&1; [[ "$(head_ "$RH")" == "$H0" ]] || die "re-run changed the ledger"
  snapshot "$RH" "$TOOL" "$RC0" > "$RC1.rerun"; node "$TOOL/scripts/fleet-reconcile-compare.mjs" "$RC0" "$RC1.rerun" "$FROM" "$TO" > /dev/null || die "re-run broke reconciliation"
  test "$(rh 'SELECT count(*) FROM fleet.fleet_schema_migrations')" = "$(node -e 'console.log(require(process.argv[1]).migrations.length)' "$RC1")" || die "re-run applied a migration"
  sudo -u postgres dropdb "$RH"; sudo -u postgres createdb -O fleetadmin "$RH"; sudo -u postgres pg_restore -d "$RH" --exit-on-error < "$D"
  [[ "$(rh 'SELECT max(version) FROM fleet.fleet_schema_migrations')" == "$FROM" && "$(head_ "$RH")" == "$H0" ]] || die "rollback proof failed"
  echo "rollback proof: the dump restores to schema $FROM with the same ledger head"
  sudo -u postgres dropdb "$RH"; sudo rm -f "$EMPTY"
  echo "$C $B $L $FROM $TO $(ts)" > ~/rollout-${C:0:7}-rehearsal.ok
  echo "== REHEARSAL PASSED $(ts) — live untouched (schema $(live 'SELECT max(version) FROM fleet.fleet_schema_migrations'))"
  exit 0
fi

# ── cutover ──
OK=~/rollout-${C:0:7}-rehearsal.ok
[[ -f "$OK" ]] && read -r RC RB RL RF RT RAT < "$OK" || die "no successful rehearsal of ${C:0:7} on this host"
[[ "$RC $RB $RL $RF $RT" == "$C $B $L $FROM $TO" ]] || die "the rehearsal was for different pins or schemas"
(( $(date +%s) - $(date -d "$RAT" +%s) < 86400 )) || die "the rehearsal is older than 24 hours: rehearse again"
# Services provisioned after R35 that also run from `current` and require the exact schema (dashboard, identity broker,
# browser worker): stopped and started with the controller-side units when they are running now, never started otherwise.
LATE=""; for u in automaton-fleet-dashboard.service automaton-fleet-identity.service automaton-fleet-browser.service; do
  systemctl is-active --quiet "$u" && LATE="$LATE $u"; done
UNITS="automaton-fleet-operator-api.service automaton-fleet-chatgpt-adapter.socket automaton-fleet-chatgpt-adapter.service automaton-fleet-custody.service automaton-fleet-fetcher.socket automaton-fleet-fetcher.service$LATE automaton-fleet.service"
START="automaton-fleet.service automaton-fleet-operator-api.service automaton-fleet-custody.service automaton-fleet-fetcher.socket automaton-fleet-chatgpt-adapter.socket$LATE"
echo "also cycled with the controller:${LATE:- none}"
psqlq() { live "$1"; }
sudo test ! -e $ENVF.pre-${C:0:7} || die "a previous cutover attempt of this commit left $ENVF.pre-${C:0:7}"
sudo cp -p $ENVF $ENVF.pre-${C:0:7}
sudo sed -i -e "s/^FLEET_RUNTIME_COMMIT=.*/FLEET_RUNTIME_COMMIT=$C/" -e "s/^FLEET_RUNTIME_BUILD_ID=.*/FLEET_RUNTIME_BUILD_ID=$B/" -e "s/^FLEET_RUNTIME_LOCKFILE_SHA256=.*/FLEET_RUNTIME_LOCKFILE_SHA256=$L/" $ENVF
cd ~/automaton-fleet-build
scripts/fleet-deploy-release.sh build > ~/rollout-stage.log 2>&1; tail -1 ~/rollout-stage.log
git fetch -q origin "$C"; git checkout -q --detach "$C"; test "$(git rev-parse HEAD)" = "$C"; CI=true pnpm install --frozen-lockfile > ~/rollout-tooling.log 2>&1
sudo scripts/fleet-deploy-release.sh install 2>&1 | tail -1
test "$(readlink /opt/automaton-fleet/current)" = "releases/$C"
for i in $(seq 1 90); do [ "$(psqlq 'SELECT count(*) FROM fleet.fleet_cognition_inflight')" = 0 ] && break; sleep 2; done
echo "OUTAGE START $(ts)"; sudo systemctl stop $UNITS
STAMP=$(date -u +%Y%m%dT%H%M%SZ); D=~/automaton_fleet-v$FROM-pre-v$TO-$STAMP.dump
( umask 077; sudo -u postgres pg_dump -Fc -n fleet $LIVE > "$D" ); chmod 600 "$D"; sha256sum "$D" > "$D.sha256"; sha256sum -c --quiet "$D.sha256"
echo "pre-migration dump $D sha $(cut -c1-16 "$D.sha256")"
MIGRATED=0
rollback() {
  echo "!! FAILURE: $1 — automatic rollback $(ts)"
  sudo systemctl stop $UNITS || true
  if [[ $MIGRATED == 1 ]]; then
    test "$LIVE" = automaton_fleet
    sudo -u postgres psql -X -q -d $LIVE -c "DROP SCHEMA fleet CASCADE"
    sudo -u postgres pg_restore -d $LIVE --exit-on-error < "$D"
    echo "database restored from $D: schema $(psqlq 'SELECT max(version) FROM fleet.fleet_schema_migrations')"
  fi
  sudo cp -p $ENVF.pre-${C:0:7} $ENVF
  sudo ln -sfn "releases/$OLD" /opt/automaton-fleet/current.tmp && sudo mv -T /opt/automaton-fleet/current.tmp /opt/automaton-fleet/current
  sudo systemctl start $START
  for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:8787/readyz 2>/dev/null && break; sleep 1; done
  # One operational event for Fleet Command (P0 under the v44 router; any schema has fleet_event).
  live "SELECT fleet.fleet_event('production_rolled_back', NULL, 'operator:rollout', jsonb_build_object('commit', '${C:0:12}', 'fromSchema', $FROM, 'toSchema', $TO, 'reason', left('$(echo "$1" | tr -cd 'A-Za-z0-9 .:_-')', 200)))" > /dev/null 2>&1 || true
  echo "OUTAGE END (ROLLED BACK) $(ts): readyz $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/readyz), release $(readlink /opt/automaton-fleet/current)"
  echo "== ROLLOUT ${C:0:7} ROLLED BACK"
  exit 1
}
RC0=~/rollout-${C:0:7}-cutover-before.json; RC1=~/rollout-${C:0:7}-cutover-after.json; RC2=~/rollout-${C:0:7}-cutover-reconcile.json
snapshot $LIVE "$PWD" > "$RC0" || rollback "pre-migration snapshot failed"
CHK=$(pnpm -s fleet:migrate-check 2>&1 | tail -1); echo "migrate-check: $CHK"
echo "$CHK" | grep -q "$WANT" || rollback "unexpected migrate-check"
MIGRATED=1
pnpm -s fleet:migrate > ~/rollout-migrate.log 2>&1 || rollback "migration failed"
[[ "$(psqlq 'SELECT max(version) FROM fleet.fleet_schema_migrations')" == "$TO" ]] || rollback "schema is not $TO"
pnpm -s fleet:audit-privileges > ~/rollout-audit.txt 2>&1 || rollback "privilege audit failed"
pnpm -s fleet:migrate > ~/rollout-migrate-rerun.log 2>&1 || rollback "migration re-run failed"
[[ "$(psqlq 'SELECT count(*) FROM fleet.fleet_schema_migrations WHERE version > '"$TO")" == 0 ]] || rollback "unexpected migration beyond $TO"
snapshot $LIVE "$PWD" "$RC0" > "$RC1" || rollback "post-migration snapshot failed"
node scripts/fleet-reconcile-compare.mjs "$RC0" "$RC1" "$FROM" "$TO" > "$RC2" || { cat "$RC2"; rollback "reconciliation failed"; }
echo "reconciliation: OK ($RC2: $(node -e 'const r=require(process.argv[1]);console.log("events "+r.events.existing+" before, purged "+JSON.stringify(r.events.purged??{})+", preserved "+r.events.preserved)' "$RC2"))"
pnpm -s fleet:admin approve-runtime > ~/rollout-approve.log 2>&1 || rollback "runtime approval failed"
pnpm -s fleet:verify-runtime > ~/rollout-verify-runtime.log 2>&1 || rollback "runtime verification failed"
sudo systemctl start automaton-fleet.service
READY=0; for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:8787/readyz 2>/dev/null && { READY=1; break; }; sleep 1; done
[[ $READY == 1 ]] || rollback "controller not ready"
sudo systemctl start automaton-fleet-operator-api.service automaton-fleet-custody.service automaton-fleet-fetcher.socket automaton-fleet-chatgpt-adapter.socket$LATE
for u in $LATE; do sleep 2; systemctl is-active --quiet "$u" || rollback "$u did not stay up on the new release"; done
echo "OUTAGE END $(ts)"
[[ "$(pnpm -s fleet:admin ledger-verify 2>&1 | tr -d ' \n' | grep -o '"ok":true' | head -1)" == '"ok":true' ]] || rollback "ledger verify failed after cutover"
( flags ) || rollback "a safety flag is not false after the cutover"
[[ "$(psqlq "SELECT max_agents || ' ' || living_agents || ' ' || reserved_slots FROM fleet.fleet_state")" == "$(node -e 'const s=require(process.argv[1]).state;console.log(s.maxAgents+" "+s.living+" "+s.reserved)' "$RC0")" ]] || rollback "cap or population changed by the cutover"
pnpm -s fleet:doctor > ~/rollout-doctor.txt 2>&1 || true; grep -E "^DEPLOYMENT|^SAFE FOR" ~/rollout-doctor.txt || true
sudo scripts/fleet-verify-deployment.sh > ~/rollout-vdep.txt 2>&1 || true; tail -1 ~/rollout-vdep.txt
# What a later `revert` of this cutover needs (scripts/fleet-release.sh): the verified dump, the previous release, the units.
printf '%s\n' "COMMIT=$C" "FROM=$FROM" "TO=$TO" "OLD=$OLD" "DUMP=$D" "LATE=$LATE" > ~/rollout-${C:0:7}-cutover.state; chmod 600 ~/rollout-${C:0:7}-cutover.state
# One operational event for Fleet Command (P2): the release's approval/pin records stay audit-only. Deferred when the
# release script records the outcome of the whole release (backend + UI + root verification).
if [[ "${FLEET_ROLLOUT_DEFER_EVENT:-}" != 1 ]]; then
  live "SELECT fleet.fleet_event('production_deployed', NULL, 'operator:rollout', jsonb_build_object('commit', '${C:0:12}', 'fromSchema', $FROM, 'toSchema', $TO, 'previous', '${OLD:0:12}'))" > /dev/null
fi
echo "rollback point: $ENVF.pre-${C:0:7}; releases/${OLD:0:7}; dump $D"
echo "== ROLLOUT ${C:0:7} DEPLOYED $(ts): schema $TO, readyz $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/readyz)"
