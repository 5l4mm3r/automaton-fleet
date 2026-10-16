#!/usr/bin/env bash
# Encrypted off-site backup of the Fleet (owner instruction 2026-10-16). restic: client-side encryption (AES-256 + Poly1305),
# deduplication, any S3-compatible target (recommended: Backblaze B2 with Object Lock, docs/operations/backup-and-recovery.md).
#
#   fleet-backup.sh init     create the encrypted repository (explicit, once; never automatic)
#   fleet-backup.sh run      one backup: database dump + roles (no passwords) + manifest + the file trees; retention; a
#                            weekly integrity check; reports to the outside monitor (start / success / failure + exit code)
#   fleet-backup.sh drill    restore the newest backup's database into a scratch database, check schema version and the
#                            ledger's own verification, drop the scratch database; reports the result to the monitor
#
# Configuration (environment; the unit reads /etc/automaton-fleet/backup.env). Secrets are FILES (systemd credentials),
# never variables or arguments, and never printed:
#   RESTIC_REPOSITORY              e.g. s3:https://s3.eu-central-003.backblazeb2.com/<bucket>/fleet
#   FLEET_BACKUP_SECRETS           directory holding restic-password, and for S3 s3-key-id + s3-key (default $CREDENTIALS_DIRECTORY)
#   FLEET_BACKUP_DB                database name (default automaton_fleet)
#   FLEET_BACKUP_PATHS             space-separated directories to back up (see the runbook for the default set)
#   FLEET_BACKUP_EXCLUDES          space-separated paths never backed up (key material held in separate escrow)
#   FLEET_BACKUP_PING_URL          the outside monitor's check URL for backups (optional; Healthchecks.io style)
#   FLEET_BACKUP_STAGING           working directory (default /var/lib/automaton-fleet-backup/staging, 0700)
#   FLEET_BACKUP_PSQL / _PG_DUMP / _PG_DUMPALL / _PG_RESTORE   command prefixes (default: as the postgres user)
#   FLEET_BACKUP_RESTIC            restic binary (default restic)
set -Eeuo pipefail
umask 077
CMD="${1:?usage: init | run | drill}"
RESTIC="${FLEET_BACKUP_RESTIC:-restic}"
SECRETS="${FLEET_BACKUP_SECRETS:-${CREDENTIALS_DIRECTORY:-}}"
DB="${FLEET_BACKUP_DB:-automaton_fleet}"
STAGING="${FLEET_BACKUP_STAGING:-/var/lib/automaton-fleet-backup/staging}"
PSQL="${FLEET_BACKUP_PSQL:-runuser -u postgres -- psql -X -tA -v ON_ERROR_STOP=1}"
PG_DUMP="${FLEET_BACKUP_PG_DUMP:-runuser -u postgres -- pg_dump}"
PG_DUMPALL="${FLEET_BACKUP_PG_DUMPALL:-runuser -u postgres -- pg_dumpall}"
PG_RESTORE="${FLEET_BACKUP_PG_RESTORE:-runuser -u postgres -- pg_restore}"
PING="${FLEET_BACKUP_PING_URL:-}"
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { trap - ERR; log "FAILED: $*"; ping_monitor fail "$*"; exit 1; }
ping_monitor() { # start | ok | fail <text>: the monitor gets the outcome and, on failure, the step that failed (no secret)
  [[ -n "$PING" ]] || return 0
  local suffix=""; case "$1" in start) suffix=/start ;; fail) suffix=/fail ;; esac
  curl -fsS -m 15 --retry 3 -o /dev/null --data-raw "${2:-}" "$PING$suffix" || log "monitor ping failed (continuing)"
}

[[ -n "${RESTIC_REPOSITORY:-}" ]] || { echo "RESTIC_REPOSITORY is not configured" >&2; exit 2; }
[[ -n "$SECRETS" && -r "$SECRETS/restic-password" ]] || { echo "the restic password file is missing (FLEET_BACKUP_SECRETS/restic-password)" >&2; exit 2; }
export RESTIC_PASSWORD_FILE="$SECRETS/restic-password"
if [[ "$RESTIC_REPOSITORY" == s3:* ]]; then
  [[ -r "$SECRETS/s3-key-id" && -r "$SECRETS/s3-key" ]] || { echo "S3 key files missing (s3-key-id, s3-key)" >&2; exit 2; }
  AWS_ACCESS_KEY_ID="$(cat "$SECRETS/s3-key-id")"; AWS_SECRET_ACCESS_KEY="$(cat "$SECRETS/s3-key")"; export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
fi

# Safety net: any step that fails without its own message still reaches the monitor as a failure (never a silent exit).
trap 'die "unexpected failure at line $LINENO"' ERR

case "$CMD" in
init)
  if "$RESTIC" cat config >/dev/null 2>&1; then log "repository already initialised (unchanged)"; exit 0; fi
  "$RESTIC" init >/dev/null && log "repository initialised. Add the owner's second, offline password now: restic key add"
  ;;

run)
  ping_monitor start
  "$RESTIC" cat config >/dev/null 2>&1 || die "repository not reachable or not initialised"
  install -d -m 0700 "$STAGING"
  work="$(mktemp -d "$STAGING/run.XXXXXX")"; trap 'rm -rf "$work"' EXIT
  chmod 0755 "$work"   # pg_dump runs as postgres and writes into it; the staging parent stays 0700
  ver="$($PSQL -d "$DB" -c "SELECT max(version) FROM fleet.fleet_schema_migrations")" || die "database not reachable"
  [[ "$ver" =~ ^[0-9]+$ ]] || die "no schema version"
  $PG_DUMP -Fc -Z0 -d "$DB" -f "$work/db.dump" || die "pg_dump"
  $PG_DUMPALL --globals-only --no-role-passwords > "$work/globals.sql" || die "pg_dumpall globals"
  chmod 0700 "$work"
  { printf 'created=%s\nschema=%s\ndatabase=%s\nhost=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ver" "$DB" "$(hostname)"
    (cd "$work" && sha256sum db.dump globals.sql); } > "$work/MANIFEST"
  read -r -a paths <<< "${FLEET_BACKUP_PATHS:-}"
  existing=(); for p in "${paths[@]}"; do [[ -e "$p" ]] && existing+=("$p") || log "skipping absent path $p"; done
  excl=(); read -r -a ex <<< "${FLEET_BACKUP_EXCLUDES:-}"; for p in "${ex[@]}"; do excl+=(--exclude "$p"); done
  # A checksum of every file backed up (excluded paths left out), so a drill can prove files come back byte for byte.
  if (( ${#existing[@]} )); then
    find "${existing[@]}" -type f -print0 2>/dev/null | xargs -0 -r sha256sum 2>/dev/null \
      | awk -v ex="${FLEET_BACKUP_EXCLUDES:-}" 'BEGIN { n = split(ex, X, " ") } { p = substr($0, 67); skip = 0; for (i = 1; i <= n; i++) if (X[i] != "" && index(p, X[i]) == 1) skip = 1; if (!skip) print }' \
      > "$work/FILES.sha256"
  else : > "$work/FILES.sha256"; fi
  "$RESTIC" backup --quiet --tag fleet --tag "schema-$ver" --host fleet "${excl[@]}" "$work" "${existing[@]}" || die "restic backup"
  "$RESTIC" forget --quiet --tag fleet --host fleet --keep-daily 14 --keep-weekly 8 --keep-monthly 12 $( [[ "$(date -u +%u)" == 7 ]] && echo --prune ) >/dev/null || die "restic forget"
  if [[ "$(date -u +%u)" == 7 ]]; then "$RESTIC" check --read-data-subset=5% >/dev/null 2>&1 || die "restic check"; fi
  log "backup ok: schema $ver, $(du -sh "$work/db.dump" | cut -f1) database, ${#existing[@]} trees"
  ping_monitor ok "schema $ver"
  ;;

drill)
  ping_monitor start
  install -d -m 0700 "$STAGING"
  work="$(mktemp -d "$STAGING/drill.XXXXXX")"; scratch="fleet_restore_drill_$(date -u +%Y%m%d%H%M%S)"
  cleanup() { $PSQL -d postgres -c "DROP DATABASE IF EXISTS $scratch" >/dev/null 2>&1 || true; rm -rf "$work"; }
  trap cleanup EXIT
  snap="$("$RESTIC" snapshots --json --tag fleet --host fleet --latest 1 | python3 -I -c 'import json,sys; s=json.load(sys.stdin); print(s[-1]["short_id"] if s else "")')" \
    || die "repository not readable (password or repository)"
  [[ -n "$snap" ]] || die "no snapshot to restore"
  "$RESTIC" restore "$snap" --target "$work" --include '**/db.dump' --include '**/MANIFEST' --include '**/FILES.sha256' >/dev/null || die "restic restore"
  dump="$(find "$work" -name db.dump | head -1)"; man="$(dirname "$dump")/MANIFEST"
  [[ -f "$dump" && -f "$man" ]] || die "dump or manifest missing in snapshot $snap"
  (cd "$(dirname "$dump")" && grep ' db.dump$' MANIFEST | sha256sum -c --quiet -) || die "dump checksum mismatch"
  want="$(sed -n 's/^schema=//p' "$man")"
  chmod 0755 "$work" "$(dirname "$dump")"; chmod 0644 "$dump"
  find "$work" -type d -exec chmod 0755 {} +
  $PSQL -d postgres -c "CREATE DATABASE $scratch" >/dev/null || die "create scratch database"
  $PG_RESTORE --no-owner --no-privileges -d "$scratch" "$dump" >/dev/null 2>&1 || die "pg_restore"
  got="$($PSQL -d "$scratch" -c "SELECT max(version) FROM fleet.fleet_schema_migrations")"
  [[ "$got" == "$want" ]] || die "restored schema $got != manifest $want"
  [[ "$($PSQL -d "$scratch" -c "SELECT (fleet.fleet_ledger_verify() ->> 'ok')")" == true ]] || die "the restored ledger does not verify"
  journals="$($PSQL -d "$scratch" -c "SELECT count(*) FROM fleet.fleet_ledger_journal")"
  # Files: restore a random sample (up to 40) of the backed-up workspace / product / configuration files and check each
  # against the checksum taken at backup time.
  fman="$(find "$work" -name FILES.sha256 | head -1)"; nf=0
  if [[ -n "$fman" && -s "$fman" ]]; then
    sample="$work/sample.sha256"; shuf -n 40 "$fman" > "$sample"
    inc=(); while IFS= read -r line; do inc+=(--include "${line:66}"); done < "$sample"
    "$RESTIC" restore "$snap" --target "$work/files" "${inc[@]}" >/dev/null || die "restic restore of sample files"
    while IFS= read -r line; do
      want_sum="${line:0:64}"; f="${line:66}"
      [[ -f "$work/files$f" ]] || die "sample file missing after restore: $f"
      [[ "$(sha256sum "$work/files$f" | cut -c1-64)" == "$want_sum" ]] || die "sample file differs after restore: $f"
      nf=$((nf + 1))
    done < "$sample"
  fi
  log "drill ok: snapshot $snap restored, schema $got, ledger verifies ($journals journals), $nf sample files verified"
  ping_monitor ok "drill $snap schema $got journals $journals files $nf"
  ;;
*) echo "unknown command $CMD" >&2; exit 2 ;;
esac
