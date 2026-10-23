#!/usr/bin/env bash
# The OWNER-INSTANCE IMPORT onto a freshly installed local machine (owner directive 2026-10-23) — the counterpart of
# scripts/fleet-owner-export.sh. It refuses unless every check passes; it never touches the machine the export came from.
#
#   sudo scripts/fleet-owner-import.sh <exportDir> <passphraseFile> [--with-secrets] [--apply]     # dry run without --apply
#
# Preconditions (the normal install): scripts/fleet-os-setup.sh --apply and scripts/fleet-db-setup.sh --apply have run on
# THIS machine (its own OS users, its own database roles and freshly generated passwords — none come from the export), and
# its registry database is EMPTY (no migrations applied). Steps:
#  1. every exported file matches the manifest's sha256 (else stop);
#  2. the registry is restored WITHOUT the old owners or grants (this machine's roles own it), then its row counts and its
#     ledger head are checked against the manifest — exactly, table by table (else stop: nothing is reported as imported);
#  3. migrations bring it to this release's schema (v112: local inference only) and re-grant this machine's roles; the ledger
#     is verified again;
#  4. the founders' state and workspaces and the evaluation evidence are restored (only into empty locations);
#  5. secret material only with --with-secrets (the owner's own machine).
# Agents stay as they were exported (paused agents stay paused); nothing is resumed, no payment rail is activated.
set -euo pipefail
X=${1:?export directory}; PASS=${2:?passphrase file}; shift 2
SECRETS=no; APPLY=no; for a in "$@"; do [[ $a == --with-secrets ]] && SECRETS=yes; [[ $a == --apply ]] && APPLY=yes; done
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }
[[ -f "$X/manifest.json" ]] || { echo "no manifest in $X" >&2; exit 2; }
[[ -f "$PASS" && "$(stat -c %a "$PASS")" == 600 ]] || { echo "the passphrase file must exist with mode 0600" >&2; exit 2; }
DB=${FLEET_DB_NAME:-automaton_fleet}; REL=/opt/automaton-fleet/current; NODE=/opt/automaton-fleet/node/bin/node
ADMIN_URL=$(sed -n 's/^FLEET_ADMIN_DATABASE_URL=//p' /etc/automaton-fleet/admin.env)
[[ -n "$ADMIN_URL" ]] || { echo "no FLEET_ADMIN_DATABASE_URL in /etc/automaton-fleet/admin.env (run the install first)" >&2; exit 2; }
OWNER_ROLE=$(python3 -I -c "import sys,urllib.parse; print(urllib.parse.urlparse(sys.argv[1]).username)" "$ADMIN_URL")
W=$(mktemp -d); chmod 700 "$W"; trap 'rm -rf "$W"' EXIT
M() { python3 -I -c "import json,sys; m=json.load(open(sys.argv[1])); exec(sys.argv[2])" "$X/manifest.json" "$1"; }

echo "== 1. checksums"
M "
import hashlib, os
bad = []
for f, v in m['files'].items():
    p = os.path.join(sys.argv[1].rsplit('/',1)[0], f); h = hashlib.sha256(open(p,'rb').read()).hexdigest()
    if h != v['sha256']: bad.append(f)
print('  ', len(m['files']), 'files;', 'ALL MATCH' if not bad else 'MISMATCH: ' + ', '.join(bad)); sys.exit(1 if bad else 0)"
echo "  export of $(M "print(m['createdAt'])"), schema $(M "print(m['schema'])"), ledger head $(M "print(m['ledgerHead'])")"

echo "== 2. the registry"
TABLES=$(sudo -u postgres psql -X -q -At -d "$DB" -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'fleet'" 2>/dev/null || echo "?")
[[ "$TABLES" == 0 ]] || { echo "  the database $DB is not empty ($TABLES fleet tables): import only into a fresh install" >&2; exit 1; }
if [[ $APPLY == no ]]; then echo "(dry) decrypt, pg_restore --no-owner --no-privileges --role=$OWNER_ROLE, verify counts and ledger head, migrate, restore files"; exit 0; fi
gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$PASS" -d -o "$W/registry.dump" "$X/registry.dump.gpg"
chmod 644 "$W/registry.dump"; chmod 711 "$W"
sudo -u postgres pg_restore --no-owner --no-privileges --role="$OWNER_ROLE" --exit-on-error -d "$DB" "$W/registry.dump"
sudo -u postgres psql -X -q -d "$DB" -c "ALTER SCHEMA fleet OWNER TO \"$OWNER_ROLE\"" >/dev/null
Q() { sudo -u postgres psql -X -q -At -d "$DB" -c "SET search_path=fleet; $1" | grep -v '^SET$'; }
Q "SELECT string_agg(format('%s %s', c.relname, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM fleet.%I', c.relname), false, true, '')))[1]::text), E'\n' ORDER BY c.relname)
   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'fleet' AND c.relkind = 'r'" > "$W/rows.txt"
HEAD=$(Q "SELECT head_seq || ' ' || head_hash FROM fleet_ledger_head")
M "
rows = dict(l.split(' ', 1) for l in open('$W/rows.txt').read().split('\n') if l.strip())
diff = [k for k, v in m['rowCounts'].items() if int(rows.get(k, -1)) != v]
ok_head = '$HEAD' == m['ledgerHead']
print('  rows: %d tables, %s; ledger head %s' % (len(m['rowCounts']), 'ALL EQUAL' if not diff else 'DIFFERENT: ' + ', '.join(diff[:8]), 'equal' if ok_head else 'DIFFERENT'))
sys.exit(1 if diff or not ok_head else 0)" || { echo "  the restored registry does not match the export: stop (nothing else done)" >&2; exit 1; }

echo "== 3. migrate to this release (local inference only) and re-grant this machine's roles"
FLEET_ADMIN_DATABASE_URL="$ADMIN_URL" env -C "$REL" "$NODE" dist/fleet/postgres/cli.js migrate | tail -3 | sed 's/^/  /'
echo "  ledger verify: $(Q "SELECT fleet_ledger_verify()->>'ok'"); profile: $(Q "SELECT profile FROM fleet_inference_profile")"

echo "== 4. founders' state and workspaces; evaluation evidence"
for a in founders evaluations; do
  [[ -f "$X/$a.tgz.gpg" ]] || continue
  gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$PASS" -d -o "$W/$a.tgz" "$X/$a.tgz.gpg"
  T=$([[ $a == founders ]] && echo /var/lib/private/automaton-founders || echo /var/lib/automaton-fleet-eval)
  if [[ -d "$T" && -n "$(ls -A "$T" 2>/dev/null)" ]]; then echo "  $T is not empty: left as it is ($a not restored)"; continue; fi
  tar -C / -xzf "$W/$a.tgz"; echo "  $a restored into $T"
done

echo "== 5. secret material"
if [[ $SECRETS == yes ]]; then
  gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$PASS" -d -o "$W/secrets.tgz" "$X/secrets.tgz.gpg"
  tar -C / --keep-old-files -xzf "$W/secrets.tgz" && echo "  restored (existing files were kept, not overwritten)"
else echo "  not restored (add --with-secrets on the owner's own machine)"; fi
echo "== done. No agent was resumed; no rail activated. Next: scripts/fleet-local-inference-setup.sh and scripts/fleet-local-cognition.sh"
