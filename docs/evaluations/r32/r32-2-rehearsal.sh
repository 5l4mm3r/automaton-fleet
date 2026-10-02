#!/usr/bin/env bash
# R32-2: fresh backup, Founder 1 state backup, isolated restore, real-data v33 -> v34 rehearsal, idempotency, rollback
# proof, cleanup. NEVER writes to the live database `automaton_fleet` (read-only pg_dump only); production units untouched.
set -euo pipefail
export PATH=/opt/automaton-fleet/node/bin:$PATH
C=27b07e90baccbbb263440b3d8d77d5c040ff1b98
F=01M3F50SH7PNX2E3GST13J52AS
LIVE=automaton_fleet; RH=automaton_fleet_r32rh
TOOL=/var/tmp/r32-tooling
ts() { date -u +%FT%TZ; }
live() { sudo -u postgres psql -X -At -d "$LIVE" -c "$1"; }
rh() { sudo -u postgres psql -X -At -v ON_ERROR_STOP=1 -d "$RH" -c "$1"; }
test "$RH" != "$LIVE"
# Candidate tooling as the postgres OS user over the Unix socket, session role fleetadmin (production ownership);
# no credential file is read.
RHURL="postgresql://postgres@/$RH?host=/var/run/postgresql&options=-c%20role%3Dfleetadmin%20-c%20search_path%3Dfleet"
# An empty, strictly-permissioned env file (no secret): the CLI's secret-file validation stays strict.
EMPTY=/var/tmp/r32-empty.env
sudo rm -f "$EMPTY"; sudo -u postgres bash -c "umask 077; : > $EMPTY"
cli() { sudo -u postgres env -i PATH="$PATH" HOME=/var/tmp FLEET_ADMIN_ENV_FILE=$EMPTY FLEET_RUNTIME_ENV_FILE=$EMPTY \
  FLEET_ADMIN_DATABASE_URL="$RHURL" bash -c "cd $TOOL && node --import tsx src/fleet/postgres/cli.ts $*"; }
counts() { # exact row counts of every fleet table, one per line
  sudo -u postgres psql -X -At -d "$1" -c "SELECT string_agg(format('SELECT %L || ''='' || count(*) FROM fleet.%I', tablename, tablename), ' UNION ALL ' ORDER BY tablename) FROM pg_tables WHERE schemaname='fleet'" |
    sudo -u postgres psql -X -At -d "$1" | sort; }
fp() { sudo -u postgres psql -X -At -d "$1" -c "SELECT fleet.fleet_founder_ledger_fingerprint('$F')"; }
head_() { sudo -u postgres psql -X -At -d "$1" -c "SELECT head_seq || ' ' || head_hash || ' journals ' || (SELECT count(*) FROM fleet.fleet_ledger_journal) FROM fleet.fleet_ledger_head"; }
ident() { sudo -u postgres psql -X -At -d "$1" -c "SELECT md5(row(agent_id, role, generation, origin, genesis_id, lineage_root, workspace_id, state_namespace, capability_manifest_id, name, wallet_address, created_at)::text) || ' ' || (SELECT md5(token_hash || created_at::text || COALESCE(revoked_at::text,'-')) FROM fleet.fleet_agent_credentials WHERE agent_id='$F') FROM fleet.fleet_agents WHERE agent_id='$F'"; }

echo "== R32-2 start $(ts)"
test "$(live 'SELECT max(version) FROM fleet.fleet_schema_migrations')" = 33
# Candidate tooling (public code, no secret): a separate checkout so the production tooling stays on 3aebcc2 until R32-3.
if [[ ! -d $TOOL ]]; then
  git clone -q ~/automaton-fleet-build "$TOOL"
  git -C "$TOOL" fetch -q https://github.com/5l4mm3r/automaton-fleet.git "$C"
  git -C "$TOOL" checkout -q --detach "$C"
  echo "eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811  pnpm-lock.yaml" | (cd "$TOOL" && sha256sum -c --quiet -)
  (cd "$TOOL" && CI=true pnpm install --frozen-lockfile > ~/r32-rh-tooling.log 2>&1)
  chmod 755 "$TOOL"; chmod -R go+rX "$TOOL"
fi
test "$(git -C "$TOOL" rev-parse HEAD)" = "$C"; echo "rehearsal tooling $TOOL at $C"
# A leftover throwaway from an interrupted earlier run (exact name, never the live database) is dropped first.
if [[ -n "$(sudo -u postgres psql -X -At -d postgres -c "SELECT 1 FROM pg_database WHERE datname='$RH'")" ]]; then
  test "$RH" = automaton_fleet_r32rh; sudo -u postgres dropdb "$RH"; echo "dropped leftover throwaway $RH"; fi

# ── 1. backups
STAMP=$(date -u +%Y%m%dT%H%M%SZ); D=~/automaton_fleet-v33-r32-$STAMP.dump
( umask 077; sudo -u postgres pg_dump -Fc -n fleet "$LIVE" > "$D" ); chmod 600 "$D"; sha256sum "$D" > "$D.sha256"
echo "dump $D $(stat -c '%s B mode %a' "$D") sha $(cut -c1-64 "$D.sha256") pg $(sudo -u postgres psql -X -At -c 'SHOW server_version')"
echo "dump contents: $(pg_restore -l "$D" | grep -c 'TABLE DATA') tables with data, $(pg_restore -l "$D" | grep -c ' FUNCTION ') functions"
counts "$LIVE" > ~/r32-counts-live.txt
echo "live at dump: $(head_ $LIVE) | ident $(ident $LIVE)"
B=/var/lib/automaton-fleet-backups/r32-$STAMP
sudo install -d -m 0700 -o root -g root /var/lib/automaton-fleet-backups "$B"
# Founder 1 durable state (memory, workspace, mind state). The agent credential file is left out, as in the R23 upgrade backups.
sudo tar -C /var/lib/private/automaton-founders --exclude="$F/fleet-credentials.json" -cpf "$B/founder-$F.tar" "$F"
sudo chmod 600 "$B/founder-$F.tar"; sudo sha256sum "$B/founder-$F.tar" | sudo tee "$B/founder-$F.tar.sha256" >/dev/null
echo "founder state $B/founder-$F.tar $(sudo stat -c '%s B mode %a' "$B/founder-$F.tar") sha $(sudo cut -c1-64 "$B/founder-$F.tar.sha256") files $(sudo tar -tf "$B/founder-$F.tar" | grep -vc '/$')"
sudo cp -p /etc/automaton-fleet/runtime.env "$B/runtime.env"; sudo cp -p /etc/automaton-fleet/founders/$F.runtime.env "$B/founder.runtime.env"
for u in automaton-fleet automaton-fleet-operator-api automaton-fleet-custody "automaton-fleet-founder@"; do
  p=$(systemctl show -p FragmentPath --value "${u}$( [[ $u == *@ ]] && echo "$F").service"); echo "unit $u $(sha256sum "$p" | cut -c1-16)"; done | sudo tee "$B/units.txt"

# ── 2. isolated restore (same database ACL as production)
sudo -u postgres createdb -O fleetadmin "$RH"
sudo -u postgres psql -X -q -d postgres -c "REVOKE ALL ON DATABASE $RH FROM PUBLIC" \
  -c "GRANT CONNECT ON DATABASE $RH TO fleet_agent_login, fleet_service_login, fleet_operator_login, fleet_custody_login"
test "$(rh 'SELECT current_database()')" = "$RH"
sudo -u postgres pg_restore -d "$RH" --exit-on-error < "$D"
counts "$RH" > ~/r32-counts-restored.txt
diff -q ~/r32-counts-live.txt ~/r32-counts-restored.txt >/dev/null && echo "restore proof: $(wc -l < ~/r32-counts-restored.txt) tables, row counts identical to the live database at dump time" \
  || { echo "RESTORE MISMATCH (live kept running between dump and count?)"; diff ~/r32-counts-live.txt ~/r32-counts-restored.txt | head; }
echo "restored: schema $(rh 'SELECT max(version) FROM fleet.fleet_schema_migrations') | $(head_ $RH) | ident $(ident $RH)"
FP0=$(fp "$RH"); H0=$(head_ "$RH"); I0=$(ident "$RH")

# ── 3. real-data rehearsal v33 -> v34 with the candidate tooling
test "$(git -C "$TOOL" rev-parse HEAD)" = "$C"
GUARD=$(sudo -u postgres psql -X -At "$RHURL" -c "SELECT current_database() || ' ' || current_user")
echo "rehearsal target: $GUARD"; test "$GUARD" = "$RH fleetadmin"
CHK=$(cli migrate-check 2>&1 | tail -1); echo "migrate-check: $CHK"
echo "$CHK" | grep -q '"currentVersion":33,"resultingVersion":34,"wouldApply":\[34\]' || { echo "UNEXPECTED migrate-check: STOP"; exit 2; }
T0=$(date +%s%N); cli migrate 2>&1 | tail -2; echo "migrate took $(( ($(date +%s%N)-T0)/1000000 )) ms"
test "$(rh 'SELECT max(version) FROM fleet.fleet_schema_migrations')" = 34 && echo "schema 34"
cli audit-privileges > ~/r32-rh-audit.txt 2>&1 && echo "audit PASS" || { echo "AUDIT FAILED"; tail -20 ~/r32-rh-audit.txt; exit 3; }
H1=$(head_ "$RH"); FP1=$(fp "$RH"); I1=$(ident "$RH")
[[ "$H0" == "$H1" ]] && echo "ledger head and journal count unchanged by the migration: $H1" || { echo "LEDGER HEAD CHANGED: $H0 -> $H1"; exit 4; }
# Every pre-existing account and field identical; accounts added by v26-v31 (new classes) must all be zero.
FPCMP=$(FP0="$FP0" FP1="$FP1" node -e '
  const a = JSON.parse(process.env.FP0), b = JSON.parse(process.env.FP1);
  const ma = new Map(a.accounts.map((x) => [x.account, x])), mb = new Map(b.accounts.map((x) => [x.account, x]));
  const bad = [];
  for (const [k, x] of ma) { const y = mb.get(k); if (!y || y.balance !== x.balance || y.class !== x.class) bad.push("changed:" + k); }
  const added = [...mb.values()].filter((y) => !ma.has(y.account));
  for (const y of added) if (y.balance !== 0) bad.push("nonzero-new:" + y.account);
  for (const k of Object.keys(a)) if (k !== "accounts" && JSON.stringify(a[k]) !== JSON.stringify(b[k])) bad.push("field:" + k);
  console.log(bad.length ? "BAD " + bad.join(" ") : "OK " + ma.size + " accounts identical; " + added.length + " new zero-balance account(s): " + added.map((y) => y.class).join(","));')
echo "Founder 1 ledger fingerprint: $FPCMP"; [[ "$FPCMP" == OK* ]] || exit 4
[[ "$I0" == "$I1" ]] && echo "Founder 1 identity and credential rows unchanged" || { echo "IDENTITY CHANGED"; exit 4; }
echo "ledger verify (SQL): $(rh "SELECT fleet.fleet_ledger_verify()::text" 2>&1 | head -c 300)"
echo "economy health: $(rh "SELECT (fleet.fleet_economy_health() ->> 'ok') || ' ' || (SELECT string_agg(f ->> 'code' || ':' || (f ->> 'severity'), ' ') FROM jsonb_array_elements(fleet.fleet_economy_health() -> 'findings') f)")"
echo "agent economics: $(rh "SELECT fleet.fleet_agent_economics('$F') ->> 'cash' || ' cash, ' || (fleet.fleet_agent_economics('$F') ->> 'expensePurchasingCapacity') || ' available'")"
echo "wallet runway: $(rh "SELECT fleet.fleet_agent_wallet('$F') -> 'runway'")"
echo "custody (v32): $(rh "SELECT fleet.fleet_custody_status() - 'instructions'") | founder mode $(rh "SELECT custody_mode FROM fleet.fleet_wallet_custody WHERE agent_id = '$F'")"
[[ "$(rh "SELECT custody_mode FROM fleet.fleet_wallet_custody WHERE agent_id = '$F'")" == controller_keyless ]] || { echo "FOUNDER NOT KEYLESS: STOP"; exit 5; }
[[ "$(rh "SELECT (fleet.fleet_custody_status() ->> 'agentHeldKeys')")" == 0 && "$(rh "SELECT (fleet.fleet_custody_status() ->> 'executionEnabled')")" == false ]] || { echo "CUSTODY FACTS UNEXPECTED: STOP"; exit 5; }
echo "v33: tax fallback $(rh "SELECT unprofiled_reserve_bp FROM fleet.fleet_tax_policy") | sale tax without profile $(rh "SELECT fleet.fleet_tax_for_sale(NULL, 1200, 50) ->> 'totalMinor'") | rail entity nullable $(rh "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'fleet' AND table_name = 'fleet_payment_rails' AND column_name = 'legal_entity_id'")"
[[ "$(rh "SELECT unprofiled_reserve_bp FROM fleet.fleet_tax_policy")" == 0 && "$(rh "SELECT fleet.fleet_tax_for_sale(NULL, 1200, 50) ->> 'totalMinor'")" == 0 ]] || { echo "V33 NOT PRESERVED: STOP"; exit 6; }
# v34: identity tables present and empty; the v11 raw release retired; the broker role absent (not provisioned) is accepted.
echo "v34: tables $(rh "SELECT count(*) FROM pg_tables WHERE schemaname = 'fleet' AND tablename IN ('fleet_agent_identities','fleet_agent_accounts','fleet_agent_account_credentials','fleet_agent_mailboxes','fleet_agent_mail','fleet_identity_jobs','fleet_owner_identity_classes','fleet_owner_identity_consent','fleet_identity_releases')")/9 | status $(rh "SELECT fleet.fleet_identity_status()::text") | v11 facts held $(rh "SELECT count(*) FROM fleet.fleet_org_identity_facts") | broker role $(rh "SELECT count(*) FROM pg_roles WHERE rolname = 'fleet_identity'")"
[[ "$(rh "SELECT count(*) FROM pg_tables WHERE schemaname = 'fleet' AND tablename IN ('fleet_agent_identities','fleet_agent_accounts','fleet_agent_account_credentials','fleet_agent_mailboxes','fleet_agent_mail','fleet_identity_jobs','fleet_owner_identity_classes','fleet_owner_identity_consent','fleet_identity_releases')")" == 9 ]] || { echo "V34 TABLES MISSING: STOP"; exit 6; }
RET=$(rh "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'fleet' AND p.proname IN ('api_identity_fact','api_identity_request') AND p.prosrc LIKE '%FLEET_IDENTITY_BROKERED%' AND p.prosrc NOT LIKE '%value%'"); echo "v11 raw-release functions retired: $RET/2"
[[ "$RET" == 2 ]] || { echo "V11 RELEASE NOT RETIRED: STOP"; exit 6; }
RET2=$(rh "SELECT fleet.fleet_org_identity_set('trading_name', 'x', 'public', 'operator:r32-rehearsal')" 2>&1 || true); echo "v11 fleet_org_identity_set -> $(echo "$RET2" | grep -o 'FLEET_[A-Z_]*' | head -1)"
echo "$RET2" | grep -q FLEET_OWNER_VAULT || { echo "OWNER FACTS STILL WRITABLE: STOP"; exit 6; }
echo "withdrawal advice: $(rh "SELECT fleet.fleet_admin_withdrawal_assessment(1) ->> 'recommendedSafeMinor' || ' safe of ' || (fleet.fleet_admin_withdrawal_assessment(1) ->> 'unrestrictedLiquidMinor') || ' liquid, cushion ' || (fleet.fleet_admin_withdrawal_assessment(1) #>> '{cushion,minor}')")"
counts "$RH" > ~/r32-counts-migrated.txt
echo "row-count changes after migration (pre-existing tables):"; join -t= -j1 <(sort ~/r32-counts-restored.txt) <(sort ~/r32-counts-migrated.txt) | awk -F= '$2!=$3{print "  " $0}' | head -20
echo "new tables: $(comm -13 <(cut -d= -f1 ~/r32-counts-restored.txt | sort) <(cut -d= -f1 ~/r32-counts-migrated.txt | sort) | wc -l); dropped tables: $(comm -23 <(cut -d= -f1 ~/r32-counts-restored.txt | sort) <(cut -d= -f1 ~/r32-counts-migrated.txt | sort) | wc -l)"
# idempotency
CHK2=$(cli migrate-check 2>&1 | tail -1); echo "re-check: $CHK2"; cli migrate 2>&1 | tail -1
[[ "$(head_ "$RH")" == "$H1" ]] && echo "re-run is a no-op (head unchanged, schema $(rh 'SELECT max(version) FROM fleet.fleet_schema_migrations'))"
cli audit-privileges > /dev/null 2>&1 && echo "audit PASS after re-run"

# ── 4. rollback proof: restore the pre-upgrade dump again -> schema 25, identical content
sudo -u postgres dropdb "$RH"
sudo -u postgres createdb -O fleetadmin "$RH"
sudo -u postgres psql -X -q -d postgres -c "REVOKE ALL ON DATABASE $RH FROM PUBLIC" \
  -c "GRANT CONNECT ON DATABASE $RH TO fleet_agent_login, fleet_service_login, fleet_operator_login, fleet_custody_login"
sudo -u postgres pg_restore -d "$RH" --exit-on-error < "$D"
counts "$RH" > ~/r32-counts-rollback.txt
[[ "$(rh 'SELECT max(version) FROM fleet.fleet_schema_migrations')" == 33 && "$(head_ "$RH")" == "$H0" && "$(ident "$RH")" == "$I0" ]] && \
  diff -q ~/r32-counts-restored.txt ~/r32-counts-rollback.txt >/dev/null && echo "rollback proof: the pre-upgrade dump restores to schema 33 with identical rows, head and identity"
# the previous release that would serve it is intact
test -x /opt/automaton-fleet/releases/3aebcc22107a0dfebe9123f58df004ccdc1d155b/dist/fleet/postgres/cli.js -o -f /opt/automaton-fleet/releases/3aebcc22107a0dfebe9123f58df004ccdc1d155b/dist/fleet/postgres/cli.js && echo "previous release releases/3aebcc2… present"

# ── 5. cleanup
sudo -u postgres dropdb "$RH"
test -z "$(sudo -u postgres psql -X -At -d postgres -c "SELECT 1 FROM pg_database WHERE datname='$RH'")" && echo "throwaway dropped"
echo "live untouched: schema $(live 'SELECT max(version) FROM fleet.fleet_schema_migrations'), controller $(systemctl is-active automaton-fleet), founder pid $(systemctl show -p MainPID --value automaton-fleet-founder@$F.service)"
sudo rm -f "$EMPTY"
echo "== R32-2 end $(ts)"
