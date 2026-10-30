#!/usr/bin/env bash
# Group A (9e9ebe9): Treasury Watch on a DISPOSABLE copy of production (dropped at the end). Fake PayPal; no provider call, no live write.
# Auto-booking is switched on IN THE COPY ONLY, to exercise an interrupted booking. Exit 0 only if every check holds.
set -uo pipefail
export PATH=/opt/automaton-fleet/node/bin:$PATH
DB=fleet_rlc143_check; C=9e9ebe9ee9ca399a368c0fdea2ded7fcf5451323; REL=/opt/automaton-fleet/releases/$C; TOOL=/var/tmp/rollout-tooling-${C:0:12}; DIR=/var/tmp/rlc143-check
DUMP=$(ls -t ~/automaton_fleet-v122-rollout-9e9ebe9-*.dump | head -1); ACT=operator:ubuntu; RAIL=b71b3f3c-901c-4f22-818b-3e1b1269f420; REF="paypal:b71b3f3c:79T2209859237554T"
fails=0; ok() { echo "  PASS $1"; }; bad() { echo "  FAIL $1"; fails=$((fails+1)); }
expect() { if [[ "$2" == "$3" ]]; then ok "$1 ($2)"; else bad "$1: got [$2], expected [$3]"; fi; }
q() { sudo -n -u postgres psql -X -q -At -v ON_ERROR_STOP=1 -d "$DB" -c "SET search_path = fleet; $1"; }
live() { sudo -n -u postgres psql -X -q -At -d automaton_fleet -c "SET default_transaction_read_only=on; SET search_path=fleet; $1"; }
URL="postgresql://postgres@/$DB?host=/var/run/postgresql&options=-c%20role%3Dfleetadmin%20-c%20search_path%3Dfleet"
CXURL="postgresql://postgres@/$DB?host=/var/run/postgresql&options=-c%20role%3Dfleet_custody_login%20-c%20search_path%3Dfleet"
EMPTY=/var/tmp/rollout-empty.env; sudo -n rm -f "$EMPTY"; sudo -n -u postgres bash -c "umask 077; : > $EMPTY"
cli() { sudo -n -u postgres env -i PATH="$PATH" HOME=/var/tmp FLEET_ADMIN_ENV_FILE=$EMPTY FLEET_RUNTIME_ENV_FILE=$EMPTY FLEET_ADMIN_DATABASE_URL="$URL" bash -c "cd $TOOL && node --import tsx src/fleet/postgres/cli.ts $*"; }
worker() { sudo -n -u postgres node "$DIR/copy-check-worker.mjs" "$REL" "$CXURL" "$1" "$2" 2>&1 | cut -c1-200; }
LIVE0="$(live 'SELECT head_seq||chr(32)||head_hash FROM fleet_ledger_head') $(live 'SELECT max(version) FROM fleet_schema_migrations') $(readlink -f /opt/automaton-fleet/current)"
trap 'sudo -n -u postgres dropdb --if-exists "$DB"; sudo -n rm -f "$EMPTY"; echo "copy $DB dropped"' EXIT
sudo -n -u postgres dropdb --if-exists "$DB"; sudo -n -u postgres createdb -O fleetadmin "$DB"; sudo -n -u postgres psql -X -q -d postgres -c "REVOKE ALL ON DATABASE $DB FROM PUBLIC"
sudo -n -u postgres pg_restore -d "$DB" --exit-on-error < "$DUMP" || { echo "restore failed"; exit 1; }
J0=$(q "SELECT count(*) FROM fleet_ledger_journal"); H0=$(q "SELECT head_seq||' '||head_hash FROM fleet_ledger_head"); E0=$(q "SELECT count(*) FROM fleet_events"); N0=$(q "SELECT count(*) FROM fleet_notifications")
U0=$(q "SELECT fleet_ledger_balance('fleet:treasury:unallocated')")
echo "== copy of production at schema $(q 'SELECT max(version) FROM fleet_schema_migrations'): $J0 journals, unallocated ${U0}p"
cli migrate 2>&1 | tail -1 | cut -c1-120

echo "== 1. seeded historical movements"
expect "schema" "$(q 'SELECT max(version) FROM fleet_schema_migrations')" 123
expect "every PayPal row has one movement" "$(q 'SELECT count(*) FROM fleet_treasury_movements')" "$(q 'SELECT count(*) FROM fleet_paypal_transactions')"
expect "all seeded" "$(q 'SELECT count(*) FROM fleet_treasury_movements WHERE NOT seeded')" 0
q "SELECT transaction_id||' '||event_code||' '||amount_minor||' '||classification||' '||accounting_status FROM fleet_treasury_movements ORDER BY initiated_at" | sed 's/^/     /'
expect "the £2.50: recorded, on its one journal" "$(q "SELECT classification||' '||accounting_status||' '||(journal_id = (SELECT journal_id FROM fleet_ledger_journal WHERE external_ref = '$REF')) FROM fleet_treasury_movements WHERE transaction_id = '79T2209859237554T'")" "attributed_owner_funding recorded true"
expect "migration posted no journal" "$(q 'SELECT count(*) FROM fleet_ledger_journal') $(q 'SELECT head_seq||chr(32)||head_hash FROM fleet_ledger_head')" "$J0 $H0"
expect "migration raised no notification" "$(q 'SELECT count(*) FROM fleet_notifications')" "$N0"
expect "migration emitted no treasury event" "$(q "SELECT count(*) FROM fleet_events WHERE event_type LIKE 'treasury\_%'")" 0
expect "auto-booking off after migration" "$(q 'SELECT auto_book_enabled FROM fleet_treasury_watch_policy')" f
expect "ledger verifies" "$(q "SELECT fleet_ledger_verify()->>'ok'")" true

echo "== 2. watch ticks over history change no money"
for i in 1 2 3; do q "SELECT svc_treasury_watch_tick()" >/dev/null; done
expect "no journal, same head" "$(q 'SELECT count(*) FROM fleet_ledger_journal') $(q 'SELECT head_seq||chr(32)||head_hash FROM fleet_ledger_head')" "$J0 $H0"
expect "the £2.50 still has one journal" "$(q "SELECT count(*) FROM fleet_ledger_journal WHERE external_ref LIKE '%79T2209859237554T%'")" 1
expect "no treasury movement event for history" "$(q "SELECT count(*) FROM fleet_events WHERE event_type IN ('treasury_movement_recorded','treasury_funding_booked','treasury_movement_needs_review')")" 0
expect "unallocated unchanged" "$(q "SELECT fleet_ledger_balance('fleet:treasury:unallocated')")" "$U0"
echo "     notifications from these ticks: $(q "SELECT COALESCE(string_agg(code||':'||left(title,60), ' | '),'none') FROM fleet_notifications WHERE code LIKE 'TREASURY%'")"
echo "     state: $(q "SELECT fleet_provider_sync_visibility()->>'state'")"

echo "== 3. the release's worker: every real row re-delivered, then a partial page"
TX=FAKETOPUP0000001; VAULT=$(q "SELECT c.vault_ref FROM fleet_payment_rails r JOIN fleet_credentials c ON c.credential_id = r.credential_id WHERE r.rail_id = '$RAIL'" 2>/dev/null); [[ -n "$VAULT" ]] || VAULT=vault:paypal/treasury
AT=$(date -u -d '-2 hours' +%Y-%m-%dT%H:%M:%S+0000)
existing=$(q "SELECT COALESCE(json_agg(json_build_object('transaction_info', json_build_object('transaction_id', transaction_id, 'transaction_event_code', event_code, 'transaction_status', status, 'transaction_initiation_date', to_char(initiated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS')||'+0000', 'transaction_amount', json_build_object('currency_code', currency, 'value', to_char(amount_minor/100.0,'FM999990.00')), 'fee_amount', json_build_object('currency_code', currency, 'value', to_char(fee_minor/100.0,'FM999990.00'))))), '[]') FROM fleet_paypal_transactions")
new="{\"transaction_info\":{\"transaction_id\":\"$TX\",\"transaction_event_code\":\"T0700\",\"transaction_status\":\"S\",\"transaction_initiation_date\":\"$AT\",\"transaction_amount\":{\"currency_code\":\"GBP\",\"value\":\"3.00\"},\"fee_amount\":{\"currency_code\":\"GBP\",\"value\":\"0.00\"}}}"
CASH=$(q "SELECT (fleet_capital_backing()#>>'{paypal,totalMinor}')")
state() { printf '{"vaultRef":"%s","cashMinor":%s,"rows":%s%s}' "$VAULT" "$1" "$2" "${3:-}"; }
worker normal "$(state "$CASH" "$existing")"
q "SELECT svc_treasury_watch_tick()" >/dev/null
expect "re-delivery created no row" "$(q 'SELECT count(*) FROM fleet_treasury_movements')" "$(q 'SELECT count(*) FROM fleet_paypal_transactions')"
expect "re-delivery posted nothing" "$(q 'SELECT count(*) FROM fleet_ledger_journal')" "$J0"
worker normal "$(state "$CASH" "$existing" ",\"page2\":[$new],\"page2Status\":500")"
q "SELECT svc_treasury_watch_tick()" >/dev/null
expect "partial page: shown as failing, HTTP 500" "$(q "SELECT (fleet_provider_sync_visibility()->>'state')||' '||(fleet_provider_sync_visibility()#>>'{search,lastHttp}')")" "failing 500"
expect "partial page: the unread row is not there" "$(q "SELECT count(*) FROM fleet_paypal_transactions WHERE transaction_id = '$TX'")" 0
expect "partial page: an alert" "$(q "SELECT count(*) FROM fleet_notifications WHERE code = 'TREASURY_SYNC_PROBLEM' AND title LIKE '%failing%'")" 1
worker normal "$(state "$CASH" "$existing" ",\"page2\":[$new],\"page2Status\":200")"
q "SELECT svc_treasury_watch_tick()" >/dev/null
expect "recovery: the row arrives on the next pass" "$(q "SELECT classification||' '||accounting_status FROM fleet_treasury_movements WHERE transaction_id = '$TX'")" "top_up needs_review"
expect "recovery: auto-booking off, so nothing booked" "$(q 'SELECT count(*) FROM fleet_ledger_journal')" "$J0"
q "UPDATE fleet_paypal_transactions SET attributed_as = 'not_revenue', attributed_ref = 'copy', attributed_by = 'operator:copy', attributed_at = now() WHERE transaction_id = '$TX'" >/dev/null; q "SELECT svc_treasury_watch_tick()" >/dev/null

echo "== 4. the worker process killed mid-read, then restarted"
TX2=FAKETOPUP0000002; new2=${new//$TX/$TX2}; new2=${new2//3.00/4.00}
LOG=$DIR/hang.log; sudo -n -u postgres bash -c "node $DIR/copy-check-worker.mjs '$REL' '$CXURL' hang '$(state "$CASH" "$existing" ",\"page2\":[$new2]")' > $LOG 2>&1 & echo \$! > $DIR/hang.pid"
for i in $(seq 1 60); do grep -q READY-TO-KILL "$LOG" 2>/dev/null && break; sleep 1; done
grep -q READY-TO-KILL "$LOG" && ok "worker reached page 2 and hung" || bad "worker did not reach page 2"
sudo -n -u postgres kill -9 "$(cat $DIR/hang.pid)"; sleep 1
expect "killed: the unread row is not there, nothing half-written" "$(q "SELECT count(*) FROM fleet_paypal_transactions WHERE transaction_id = '$TX2'")" 0
worker normal "$(state "$((CASH + 400))" "$existing" ",\"page2\":[$new2],\"page2Status\":200")"
expect "restart: the row is read once" "$(q "SELECT count(*) FROM fleet_paypal_transactions WHERE transaction_id = '$TX2'")" 1

echo "== 5. an interrupted booking (auto-booking on IN THIS COPY ONLY)"
q "SELECT fleet_admin_treasury_watch_policy_set(true, '$RAIL', NULL, NULL, NULL, '$ACT')" >/dev/null
q "UPDATE fleet_treasury_watch_policy SET auto_book_from = now() - interval '1 day'; UPDATE fleet_paypal_transactions SET first_seen_at = now() - interval '2 hours' WHERE transaction_id = '$TX2'" >/dev/null
q "CREATE FUNCTION boom_pause() RETURNS trigger LANGUAGE plpgsql AS \$f\$ BEGIN PERFORM pg_sleep(30); RETURN NEW; END \$f\$; CREATE TRIGGER boom_pause BEFORE INSERT ON fleet_treasury_movement_history FOR EACH ROW EXECUTE FUNCTION boom_pause()" >/dev/null
sudo -n -u postgres psql -X -q -At -d "$DB" -c "SET search_path = fleet; SELECT svc_treasury_watch_tick()" > /dev/null 2>&1 &
sleep 4
expect "a second tick skips while the first runs" "$(q "SELECT svc_treasury_watch_tick()->>'skipped'")" true
expect "killed the tick's backend" "$(sudo -n -u postgres psql -X -q -At -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB' AND query LIKE '%svc_treasury_watch_tick%' AND pid <> pg_backend_pid()" | head -1)" t
wait; sleep 1
expect "interrupted: nothing booked (one transaction)" "$(q "SELECT count(*) FROM fleet_ledger_journal WHERE external_ref LIKE '%$TX2%'") $(q 'SELECT count(*) FROM fleet_ledger_journal')" "0 $J0"
q "DROP TRIGGER boom_pause ON fleet_treasury_movement_history; DROP FUNCTION boom_pause()" >/dev/null
q "SELECT svc_treasury_watch_tick()" >/dev/null; q "SELECT svc_treasury_watch_tick()" >/dev/null
expect "recovery: booked exactly once" "$(q "SELECT count(*) FROM fleet_ledger_journal WHERE external_ref LIKE '%$TX2%'") $(q "SELECT accounting_status FROM fleet_treasury_movements WHERE transaction_id = '$TX2'")" "1 booked"
expect "unallocated rose by the 4.00 only" "$(q "SELECT fleet_ledger_balance('fleet:treasury:unallocated')")" "$((U0 + 400))"
expect "the £2.50 still has one journal, and was not re-booked by the switch" "$(q "SELECT count(*) FROM fleet_ledger_journal WHERE external_ref LIKE '%79T2209859237554T%'")" 1
expect "reconciled afterwards" "$(q "SELECT fleet_capital_backing()->>'differenceMinor'")" 0
expect "ledger verifies" "$(q "SELECT fleet_ledger_verify()->>'ok'")" true
expect "funding alert once" "$(q "SELECT count(*) FROM fleet_notifications WHERE code = 'TREASURY_FUNDING_RECEIVED'")" 1

echo "== 6. production"
expect "live unchanged by this check" "$(live 'SELECT head_seq||chr(32)||head_hash FROM fleet_ledger_head') $(live 'SELECT max(version) FROM fleet_schema_migrations') $(readlink -f /opt/automaton-fleet/current)" "$LIVE0"
echo "== RESULT: $fails failed"; [[ $fails == 0 ]]
