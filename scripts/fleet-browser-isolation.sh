#!/usr/bin/env bash
# v79 — browser network isolation: the browser worker reaches PostgreSQL over its unix socket, and loopback is denied to
# the whole unit (Chromium included). Closes the last path from a web page to the host's loopback services (controller
# 8787, edge 8443, operator API 8788, dashboard 8790, PostgreSQL 5432, Redis 6379) — the worker's own name check already
# refuses names that resolve there, but not a DNS answer that changes between that check and Chromium's own lookup.
#
#   sudo scripts/fleet-browser-isolation.sh plan       read-only: what would change (never prints a secret)
#   sudo scripts/fleet-browser-isolation.sh apply      backups → pg_hba line + reload (no PostgreSQL restart) → socket
#                                                      probe as the browser login → browser.env to the socket → drop-in →
#                                                      daemon-reload → restart the browser unit → verify
#   sudo scripts/fleet-browser-isolation.sh verify     focused verification (read-only; a throwaway probe unit)
#   sudo scripts/fleet-browser-isolation.sh rollback   restore browser.env and pg_hba.conf from the latest backups, remove
#        the drop-in, reload, restart the unit
#   scripts/fleet-browser-isolation.sh selftest        no root: the file transforms against temporary fixtures
#
# verify passes only if: the unit's effective policy allows no address and denies 127.0.0.0/8 and ::1/128; a probe run
# under exactly that policy as the browser user cannot open TCP to any loopback service (v4 and v6) but can reach the
# public internet, and reaches PostgreSQL through the socket as fleet_browser_login (bx_ping); the restarted worker logged
# its Chromium self-test and started. Touches nothing else: no other unit, env file, role or rule.
set -euo pipefail
MODE="${1:?usage: plan | apply | verify | rollback | selftest}"
UNIT=automaton-fleet-browser
ENVF=/etc/automaton-fleet/browser.env
DROPIN_DIR=/etc/systemd/system/$UNIT.service.d
DROPIN=$DROPIN_DIR/20-no-loopback.conf
SOCKDIR=/var/run/postgresql
NODE=/opt/automaton-fleet/node/bin/node
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DROPIN=$REPO/deploy/systemd/$UNIT.service.d/20-no-loopback.conf
TS=$(date -u +%Y%m%dT%H%M%SZ)
PROBE_PORTS="5432 6379 8443 8787 8788 8790"

# ── pure transforms (python3 -I; values never printed) ──
url_to_socket() { # $1 env file in, $2 out; FLEET_BROWSER_DATABASE_URL host:port → unix socket; prints the database name
  python3 -I - "$1" "$2" "$SOCKDIR" <<'PY'
import re, sys
src, dst, sock = sys.argv[1:4]
lines = open(src).read().splitlines(keepends=True)
pat = re.compile(r'^FLEET_BROWSER_DATABASE_URL=postgresql://fleet_browser_login:([0-9a-f]{64})@([^/?\s]*)/([A-Za-z0-9_]+)(\?[^\s]*)?\s*$')
out, db, n = [], None, 0
for l in lines:
    m = pat.match(l.rstrip("\n"))
    if m:
        n += 1; db = m.group(3)
        l = f"FLEET_BROWSER_DATABASE_URL=postgresql://fleet_browser_login:{m.group(1)}@/{db}?host={sock}\n"
    out.append(l)
if n != 1: sys.exit("browser.env must hold exactly one fleet_browser_login URL (found %d)" % n)
open(dst, "w").write("".join(out))
print(db)
PY
}
hba_insert() { # $1 hba in, $2 out, $3 database; inserts the browser login's socket rule before the first local rule
  python3 -I - "$1" "$2" "$3" <<'PY'
import re, sys
src, dst, db = sys.argv[1:4]
rule = f"local   {db}   fleet_browser_login   scram-sha-256   # v79 browser worker over the unix socket\n"
lines = open(src).read().splitlines(keepends=True)
if any(re.match(rf"^\s*local\s+{re.escape(db)}\s+fleet_browser_login\s+scram-sha-256\b", l) for l in lines):
    open(dst, "w").write("".join(lines)); print("present"); sys.exit(0)
i = next((k for k, l in enumerate(lines) if re.match(r"^\s*local\s", l)), len(lines))
lines.insert(i, rule)
open(dst, "w").write("".join(lines)); print("inserted")
PY
}

if [[ "$MODE" == selftest ]]; then
  T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
  pw=$(printf 'a%.0s' {1..64})
  printf '# browser\nFLEET_BROWSER_DATABASE_URL=postgresql://fleet_browser_login:%s@127.0.0.1:5432/automaton_fleet\n' "$pw" > "$T/env"
  db=$(url_to_socket "$T/env" "$T/env.out")
  [[ "$db" == automaton_fleet ]] && grep -qx "FLEET_BROWSER_DATABASE_URL=postgresql://fleet_browser_login:$pw@/automaton_fleet?host=$SOCKDIR" "$T/env.out" \
    && grep -q '^# browser$' "$T/env.out" || { echo "selftest: url rewrite FAILED"; exit 1; }
  printf 'FLEET_BROWSER_DATABASE_URL=postgresql://other:x@h/db\n' > "$T/bad"
  if url_to_socket "$T/bad" "$T/bad.out" >/dev/null 2>&1; then echo "selftest: a foreign URL was accepted"; exit 1; fi
  printf '# TYPE DATABASE USER ADDRESS METHOD\nlocal   all   postgres   peer\nlocal   all   all   peer\nhost all all 127.0.0.1/32 scram-sha-256\n' > "$T/hba"
  [[ "$(hba_insert "$T/hba" "$T/hba.out" automaton_fleet)" == inserted ]] || { echo "selftest: hba insert FAILED"; exit 1; }
  [[ "$(sed -n 2p "$T/hba.out")" == local*automaton_fleet*fleet_browser_login*scram-sha-256* ]] || { echo "selftest: rule not first local line"; exit 1; }
  [[ "$(hba_insert "$T/hba.out" "$T/hba.2" automaton_fleet)" == present ]] && cmp -s "$T/hba.out" "$T/hba.2" || { echo "selftest: not idempotent"; exit 1; }
  grep -q '^IPAddressAllow=$' "$SRC_DROPIN" && grep -q '^IPAddressDeny=127.0.0.0/8 ::1/128$' "$SRC_DROPIN" || { echo "selftest: drop-in content"; exit 1; }
  echo "SELFTEST PASSED"; exit 0
fi

[[ $EUID -eq 0 ]] || { echo "run as root (sudo)"; exit 1; }
WD=$(systemctl show "$UNIT" -p WorkingDirectory --value)
psql_su() { sudo -u postgres psql -X -At -v ON_ERROR_STOP=1 "$@"; }
HBA=$(psql_su -c 'SHOW hba_file')

# A probe under the unit's own address policy, as the browser user (a transient unit: same cgroup BPF filter).
probe() { # $1 = effective allow, $2 = effective deny → prints one JSON line
  local url; url=$(sed -n 's/^FLEET_BROWSER_DATABASE_URL=//p' "$ENVF")
  systemd-run --quiet --wait --pipe --collect -p User="$UNIT" -p Group="$UNIT" -p "IPAddressAllow=$1" -p "IPAddressDeny=$2" \
    -p WorkingDirectory="$WD" -E PROBE_URL="$url" -E PROBE_PORTS="$PROBE_PORTS" "$NODE" -e '
const net = require("net"); const pg = require("pg");
const tcp = (host, port) => new Promise((r) => { const s = net.connect({ host, port, timeout: 3000 }); const done = (ok, why) => { s.destroy(); r({ host, port, ok, why }); };
  s.on("connect", () => done(true)); s.on("timeout", () => done(false, "timeout")); s.on("error", (e) => done(false, e.code)); });
(async () => {
  const loop = []; for (const p of process.env.PROBE_PORTS.split(" ")) { loop.push(await tcp("127.0.0.1", Number(p))); loop.push(await tcp("::1", Number(p))); }
  const pub = await tcp("1.1.1.1", 443);
  let db = { ok: false };
  try { const c = new pg.Client({ connectionString: process.env.PROBE_URL }); await c.connect(); const r = await c.query("SELECT fleet.bx_ping() AS r"); await c.end();
        db = { ok: true, schemaVersion: r.rows[0].r.schemaVersion, socket: String(c.host).startsWith("/") }; } catch (e) { db = { ok: false, why: String(e.code || e.message).slice(0, 80) }; }
  console.log(JSON.stringify({ loopbackOpen: loop.filter((x) => x.ok).map((x) => x.host + ":" + x.port), loopbackChecked: loop.length, publicOk: pub.ok, db }));
})();'
}

do_verify() {
  local allow deny since out ok=1
  allow=$(systemctl show "$UNIT" -p IPAddressAllow --value); deny=$(systemctl show "$UNIT" -p IPAddressDeny --value)
  echo "effective policy: allow=[${allow}] deny includes loopback: $([[ " $deny " == *" 127.0.0.0/8 "* && " $deny " == *" ::1/128 "* ]] && echo yes || echo NO)"
  [[ -z "$allow" && " $deny " == *" 127.0.0.0/8 "* && " $deny " == *" ::1/128 "* ]] || ok=0
  out=$(probe "$allow" "$deny"); echo "probe under that policy: $out"
  python3 -I -c 'import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if (not d["loopbackOpen"] and d["loopbackChecked"]>0 and d["publicOk"] and d["db"]["ok"] and d["db"].get("socket")) else 1)' "$out" || ok=0
  since=$(systemctl show "$UNIT" -p ActiveEnterTimestamp --value)
  echo "unit: $(systemctl is-active "$UNIT") since $since"
  if journalctl -u "$UNIT" --since "$since" --no-pager -o cat 2>/dev/null | grep -q '"browser_selftest_ok"' \
     && journalctl -u "$UNIT" --since "$since" --no-pager -o cat 2>/dev/null | grep -q '"browser_worker_started"'; then echo "worker: Chromium self-test passed, worker started (registry reached)"; else echo "worker: self-test / start NOT seen"; ok=0; fi
  [[ $ok -eq 1 ]] && echo "== ISOLATION VERIFIED $(date -u +%FT%TZ)" || { echo "== ISOLATION VERIFY FAILED"; return 1; }
}

case "$MODE" in
  plan)
    [[ -S $SOCKDIR/.s.PGSQL.5432 ]] && echo "socket: present" || echo "socket: MISSING"
    echo "hba file: $HBA"; echo "browser.env URL: $(sed -n 's/^FLEET_BROWSER_DATABASE_URL=postgresql:\/\/\([a-z_]*\):[0-9a-f]\{64\}@\([^/]*\)\/.*/\1@\2 (password hidden)/p' "$ENVF")"
    echo "login password stored as SCRAM: $(psql_su -c "SELECT rolpassword LIKE 'SCRAM-SHA-256%' FROM pg_authid WHERE rolname = 'fleet_browser_login'")"
    echo "current policy: allow=[$(systemctl show "$UNIT" -p IPAddressAllow --value)]"
    echo "drop-in: $([[ -f $DROPIN ]] && echo installed || echo "not installed (would install $SRC_DROPIN)")"
    ;;
  apply)
    [[ -S $SOCKDIR/.s.PGSQL.5432 ]] || { echo "PostgreSQL socket missing in $SOCKDIR"; exit 1; }
    [[ "$(psql_su -c "SELECT rolpassword LIKE 'SCRAM-SHA-256%' FROM pg_authid WHERE rolname = 'fleet_browser_login'")" == t ]] || { echo "fleet_browser_login has no SCRAM password"; exit 1; }
    cp -p "$ENVF" "$ENVF.pre-isolation-$TS"; cp -p "$HBA" "$HBA.pre-isolation-$TS"
    echo "backups: $ENVF.pre-isolation-$TS $HBA.pre-isolation-$TS"
    T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
    DB=$(url_to_socket "$ENVF" "$T/env")
    echo "pg_hba: $(hba_insert "$HBA" "$T/hba" "$DB")"
    install -m "$(stat -c %a "$HBA")" -o "$(stat -c %U "$HBA")" -g "$(stat -c %G "$HBA")" "$T/hba" "$HBA"
    [[ "$(psql_su -c 'SELECT pg_reload_conf()')" == t ]] && [[ "$(psql_su -c 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL')" == 0 ]] \
      || { echo "pg_hba reload failed — restoring"; cp -p "$HBA.pre-isolation-$TS" "$HBA"; psql_su -c 'SELECT pg_reload_conf()' >/dev/null; exit 1; }
    # The socket works for the browser login BEFORE the worker is switched to it (current policy still allows loopback).
    install -m 0640 -o root -g "$UNIT" "$T/env" "$T/env.socket"; ENVF_SAVED=$ENVF; ENVF=$T/env.socket
    p=$(probe "$(systemctl show "$UNIT" -p IPAddressAllow --value)" "$(systemctl show "$UNIT" -p IPAddressDeny --value)"); ENVF=$ENVF_SAVED
    python3 -I -c 'import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if d["db"]["ok"] and d["db"].get("socket") else 1)' "$p" \
      || { echo "socket login failed ($p) — browser.env unchanged, pg_hba line kept (harmless); rollback restores it"; exit 1; }
    install -m 0640 -o root -g "$UNIT" "$T/env" "$ENVF"
    install -d -m 0755 "$DROPIN_DIR"; install -m 0644 "$SRC_DROPIN" "$DROPIN"
    systemctl daemon-reload; systemctl restart "$UNIT"
    for _ in $(seq 1 60); do journalctl -u "$UNIT" --since "$(systemctl show "$UNIT" -p ActiveEnterTimestamp --value)" -o cat --no-pager 2>/dev/null | grep -q '"browser_worker_started"' && break; sleep 2; done
    do_verify
    ;;
  verify) do_verify ;;
  rollback)
    E=$(ls -1t "$ENVF".pre-isolation-* 2>/dev/null | head -1); H=$(ls -1t "$HBA".pre-isolation-* 2>/dev/null | head -1)
    [[ -n "$E" && -n "$H" ]] || { echo "no backups found"; exit 1; }
    cp -p "$E" "$ENVF"; cp -p "$H" "$HBA"; psql_su -c 'SELECT pg_reload_conf()' >/dev/null
    rm -f "$DROPIN"; systemctl daemon-reload; systemctl restart "$UNIT"
    echo "rolled back to $E / $H; policy allow=[$(systemctl show "$UNIT" -p IPAddressAllow --value)]"
    ;;
  *) echo "usage: plan | apply | verify | rollback | selftest" >&2; exit 2 ;;
esac
