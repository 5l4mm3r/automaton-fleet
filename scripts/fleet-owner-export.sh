#!/usr/bin/env bash
# The OWNER-INSTANCE EXPORT (owner directive 2026-10-23: move the Fleet onto a self-contained local machine; no data lost).
# READ-ONLY on the running registry: a consistent pg_dump, the founders' durable state and workspaces, the evaluation
# evidence — and, SEPARATELY, the secret material (vaults, custody key) — each archive encrypted with the owner's passphrase
# (gpg, AES-256), with a manifest of checksums, per-table row counts, the ledger head and the schema version that the import
# (scripts/fleet-owner-import.sh) checks before it reports success. Nothing is deleted, stopped or changed here.
#
#   sudo scripts/fleet-owner-export.sh <outDir> <passphraseFile>
#
# The passphrase file is the owner's (0600, never printed, never copied into the export). The generic installer package
# never contains this export: it is the owner's instance, moved by the owner.
set -euo pipefail
OUT=${1:?output directory}; PASS=${2:?passphrase file (0600)}
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }
[[ -f "$PASS" && "$(stat -c %a "$PASS")" == 600 ]] || { echo "the passphrase file must exist with mode 0600" >&2; exit 2; }
command -v gpg >/dev/null || { echo "gpg is required" >&2; exit 2; }
DB=${FLEET_DB_NAME:-automaton_fleet}
STAMP=$(date -u +%Y%m%dT%H%M%SZ); X="$OUT/fleet-owner-export-$STAMP"; install -d -m 700 "$X"; W=$(mktemp -d); chmod 700 "$W"
trap 'rm -rf "$W"' EXIT
Q() { sudo -u postgres psql -X -q -At -d "$DB" -c "SET default_transaction_read_only=on; SET search_path=fleet; $1" | grep -v '^SET$'; }

echo "== 1. the registry (read-only, one consistent snapshot)"
sudo -u postgres pg_dump -Fc --serializable-deferrable "$DB" > "$W/registry.dump"
SCHEMA=$(Q "SELECT max(version) FROM fleet_schema_migrations")
HEAD=$(Q "SELECT head_seq || ' ' || head_hash FROM fleet_ledger_head")
VERIFY=$(Q "SELECT fleet_ledger_verify()->>'ok'")
Q "SELECT string_agg(format('%s %s', c.relname, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM fleet.%I', c.relname), false, true, '')))[1]::text), E'\n' ORDER BY c.relname)
   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'fleet' AND c.relkind = 'r'" > "$W/row-counts.txt"
echo "  schema $SCHEMA, ledger head $HEAD, verify $VERIFY, $(wc -l < "$W/row-counts.txt") tables"

echo "== 2. founders' durable state and workspaces, evaluation evidence"
tar -C / -czf "$W/founders.tgz" var/lib/private/automaton-founders 2>/dev/null || tar -C / -czf "$W/founders.tgz" --files-from /dev/null
[[ -d /var/lib/automaton-fleet-eval ]] && tar -C / -czf "$W/evaluations.tgz" var/lib/automaton-fleet-eval
echo "  founders $(du -h "$W/founders.tgz" | cut -f1); evaluations $(du -h "$W/evaluations.tgz" 2>/dev/null | cut -f1)"

echo "== 3. secret material (separate archive: vaults and custody key; never in the generic package)"
SECRETS=()
for d in /var/lib/automaton-fleet-identity /var/lib/automaton-fleet-custody /etc/automaton-fleet/recovery; do [[ -e "$d" ]] && SECRETS+=("${d#/}"); done
tar -C / -czf "$W/secrets.tgz" "${SECRETS[@]}"
echo "  ${#SECRETS[@]} locations (contents not listed)"

echo "== 4. encrypt (AES-256, the owner's passphrase) and manifest"
for f in registry.dump founders.tgz evaluations.tgz secrets.tgz; do
  [[ -f "$W/$f" ]] || continue
  gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-file "$PASS" --symmetric --cipher-algo AES256 --s2k-digest-algo SHA512 --s2k-count 65011712 \
    -o "$X/$f.gpg" "$W/$f"
done
cp "$W/row-counts.txt" "$X/row-counts.txt"
python3 -I - "$X" "$SCHEMA" "$HEAD" "$VERIFY" "$STAMP" <<'PY'
import hashlib, json, os, sys
x, schema, head, verify, stamp = sys.argv[1:]
def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
    return h.hexdigest()
files = {f: {"bytes": os.path.getsize(os.path.join(x, f)), "sha256": sha(os.path.join(x, f))} for f in sorted(os.listdir(x)) if f != "manifest.json"}
rows = dict(l.split(" ", 1) for l in open(os.path.join(x, "row-counts.txt")).read().split("\n") if l.strip())
json.dump({"exportVersion": 1, "createdAt": stamp, "schema": int(schema), "ledgerHead": head, "ledgerVerified": verify == "true",
  "rowCounts": {k: int(v) for k, v in rows.items()}, "files": files,
  "contents": {"registry.dump.gpg": "the whole registry (pg_dump -Fc)", "founders.tgz.gpg": "founders' durable state and workspaces",
    "evaluations.tgz.gpg": "evaluation evidence", "secrets.tgz.gpg": "vaults and custody key (restore only onto the owner's own machine)"}},
  open(os.path.join(x, "manifest.json"), "w"), indent=1)
PY
chmod 600 "$X"/*
echo "== done: $X"
ls -la "$X" | sed 's/^/  /'
echo "Move this directory to the new machine; restore with scripts/fleet-owner-import.sh. The running registry was not changed."
