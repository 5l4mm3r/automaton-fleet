#!/usr/bin/env bash
# Automaton Fleet — switch the Admin dashboard to a new, versioned static UI directory (preview or root), with an
# automatic rollback. The UI is static files only: no schema, controller, runtime or money change.
#
#   sudo scripts/fleet-ui-deploy.sh <name> <tree.tgz> <sha256>
#
#   <name>       the new directory under /opt/automaton-fleet/ui/ (must not exist; releases are immutable), e.g. 0.8.2
#   <tree.tgz>   the complete tree to serve: index.html + login/ (+ hq-preview/ when a preview is kept)
#   <sha256>     the tarball's expected SHA-256 (from the validated build)
#
# Steps: verify the tarball → unpack to /opt/automaton-fleet/ui/<name> (root-owned, read-only) → back up dashboard.env
# (dashboard.env.pre-<name>) → change ONLY FLEET_DASHBOARD_STATIC_DIR → restart ONLY automaton-fleet-dashboard → check
# the loopback listener serves the new tree (/, /login/, and /hq-preview/login/ when present, all byte-identical to
# the tree) → on any failure, restore the previous env and restart (the old directory is never touched).
# Rollback later: cp -p /etc/automaton-fleet/dashboard.env.pre-<name> /etc/automaton-fleet/dashboard.env && systemctl restart automaton-fleet-dashboard
set -euo pipefail
NAME="${1:-}"; TGZ="${2:-}"; WANT="${3:-}"
die() { echo "UI DEPLOY REFUSED: $*" >&2; exit 2; }
[[ $EUID -eq 0 ]] || die "run with sudo"
[[ "$NAME" =~ ^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$ ]] || die "name: letters, digits, . + _ -"
[[ -f "$TGZ" && ! -L "$TGZ" ]] || die "tarball missing"
[[ "$WANT" =~ ^[0-9a-f]{64}$ ]] || die "sha256 is 64 hex characters"
UI=/opt/automaton-fleet/ui; DEST="$UI/$NAME"; ENVF=/etc/automaton-fleet/dashboard.env; BK="$ENVF.pre-$NAME"; UNIT=automaton-fleet-dashboard.service
[[ ! -e "$DEST" ]] || die "$DEST exists (UI directories are immutable)"
[[ ! -e "$BK" ]] || die "$BK exists (a previous attempt of this name)"
[[ "$(sha256sum "$TGZ" | cut -c1-64)" == "$WANT" ]] || die "tarball checksum mismatch"
OLD=$(sed -n 's/^FLEET_DASHBOARD_STATIC_DIR=//p' "$ENVF"); [[ -d "$OLD" ]] || die "current static dir unreadable"
ts() { date -u +%FT%TZ; }
echo "== UI deploy $NAME from $(basename "$TGZ") (sha ${WANT:0:16}) replacing $OLD, $(ts)"

# 1. Unpack (never through a symlink or outside the destination), root-owned, read-only.
TMP="$DEST.tmp"; [[ ! -e "$TMP" ]] || die "$TMP exists"
install -d -m 0755 -o root -g root "$TMP"
tar -xzf "$TGZ" -C "$TMP" --no-same-owner --no-same-permissions --no-overwrite-dir
if find "$TMP" -type l | grep -q .; then rm -rf -- "$TMP"; die "the tree contains symlinks"; fi
[[ -f "$TMP/index.html" && -f "$TMP/login/index.html" ]] || { rm -rf -- "$TMP"; die "the tree has no index.html / login/index.html"; }
chown -R root:root "$TMP"; find "$TMP" -type d -exec chmod 0755 {} +; find "$TMP" -type f -exec chmod 0644 {} +
mv -T "$TMP" "$DEST"
echo "unpacked $(find "$DEST" -type f | wc -l) files to $DEST"

# 2. Switch only FLEET_DASHBOARD_STATIC_DIR (backup first).
cp -p "$ENVF" "$BK"
sed -i "s#^FLEET_DASHBOARD_STATIC_DIR=.*#FLEET_DASHBOARD_STATIC_DIR=$DEST#" "$ENVF"
[[ "$(diff "$BK" "$ENVF" | grep -c '^[<>]')" == 2 ]] || { cp -p "$BK" "$ENVF"; die "unexpected env change"; }
PID0=$(systemctl show -p MainPID --value $UNIT)
rollback() {
  echo "!! FAILURE: $1 — restoring $OLD $(ts)"
  cp -p "$BK" "$ENVF"; systemctl restart $UNIT
  for _ in $(seq 1 20); do [[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8790/login/)" == 200 ]] && break; sleep 1; done
  echo "== UI DEPLOY $NAME ROLLED BACK: serving $(sed -n 's/^FLEET_DASHBOARD_STATIC_DIR=//p' "$ENVF"), login $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8790/login/)"
  exit 1
}
systemctl restart $UNIT
OK=0; for _ in $(seq 1 30); do [[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8790/login/)" == 200 ]] && { OK=1; break; }; sleep 1; done
[[ $OK == 1 ]] || rollback "dashboard not serving /login/"
sleep 3; systemctl is-active --quiet $UNIT || rollback "dashboard did not stay up"

# 3. The listener serves exactly the new tree.
same() { [[ "$(curl -s "http://127.0.0.1:8790$1" | sha256sum | cut -c1-64)" == "$(sha256sum "$DEST$2" | cut -c1-64)" ]]; }
same / /index.html || rollback "/ is not the new index.html"
same /login/ /login/index.html || rollback "/login/ is not the new login page"
if [[ -f "$DEST/hq-preview/login/index.html" ]]; then same /hq-preview/login/ /hq-preview/login/index.html || rollback "/hq-preview/login/ is not the new preview"; fi
[[ "$(curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:8790/api/read?op=agents&args=%7B%7D')" == 401 ]] || rollback "unauthenticated read not refused"
echo "dashboard pid $PID0 -> $(systemctl show -p MainPID --value $UNIT); root $(curl -s http://127.0.0.1:8790/ | sha256sum | cut -c1-16)"
echo "rollback: cp -p $BK $ENVF && systemctl restart $UNIT"
echo "== UI DEPLOY $NAME DONE $(ts)"
