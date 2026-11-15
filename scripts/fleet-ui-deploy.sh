#!/usr/bin/env bash
# Automaton Fleet — switch the Admin dashboard to a new, versioned static UI directory (preview or root), with an
# automatic rollback. The UI is static files only: no schema, controller, runtime or money change.
#
#   sudo scripts/fleet-ui-deploy.sh [--check] <name> <tree.tgz> <sha256>
#
#   <name>       the directory under /opt/automaton-fleet/ui/, e.g. 0.8.2
#   <tree.tgz>   the complete tree to serve: index.html + login/ (+ hq-preview/ when a preview is kept)
#   <sha256>     the tarball's expected SHA-256 (from the validated build)
#   --check      run every check and report the decision; change nothing (scripts/fleet-release.sh runs this first)
#
# Steps: verify the tarball → unpack it to a scratch directory and normalise it (root-owned, read-only, no symlinks) →
#   * /opt/automaton-fleet/ui/<name> does not exist: the scratch tree becomes it;
#   * it exists and is byte-identical to the tarball (same paths, types, contents, root-owned 0755/0644): it is REUSED
#     (UI directories are immutable; an unchanged UI is a success, not a refusal);
#   * it exists and differs: it is moved (never deleted) to /opt/automaton-fleet/quarantine/ui-<name>-<stamp> with an
#     evidence file and the scratch tree replaces it — unless it is the directory being served now (then: refused).
# Then, when <name> is already the served directory: nothing is switched or restarted; the listener is only verified.
# Otherwise: back up dashboard.env (dashboard.env.pre-<name>, or .pre-<name>.<stamp> when that exists) → change ONLY
# FLEET_DASHBOARD_STATIC_DIR → restart ONLY automaton-fleet-dashboard → check the loopback listener serves the tree
# (/, /login/, and /hq-preview/login/ when present, all byte-identical) → on any failure, restore the env exactly as it
# was before this run and restart (the old directory is never touched).
set -euo pipefail
CHECK=0; [[ "${1:-}" == --check ]] && { CHECK=1; shift; }
NAME="${1:-}"; TGZ="${2:-}"; WANT="${3:-}"
die() { echo "UI DEPLOY REFUSED: $*" >&2; exit 2; }
UI=/opt/automaton-fleet/ui; QROOT=/opt/automaton-fleet/quarantine; ENVF=/etc/automaton-fleet/dashboard.env; UNIT=automaton-fleet-dashboard.service
OWNER=root; LISTEN=http://127.0.0.1:8790
# (tests only: replace the paths / commands above with stubs; sudo resets the environment, so never in production)
if [[ -n "${FLEET_UI_DEPLOY_STUBS:-}" ]]; then source "$FLEET_UI_DEPLOY_STUBS"; else [[ $EUID -eq 0 ]] || die "run with sudo"; fi
[[ "$NAME" =~ ^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$ ]] || die "name: letters, digits, . + _ -"
[[ -f "$TGZ" && ! -L "$TGZ" ]] || die "tarball missing"
[[ "$WANT" =~ ^[0-9a-f]{64}$ ]] || die "sha256 is 64 hex characters"
DEST="$UI/$NAME"; STAMP=$(date -u +%Y%m%dT%H%M%SZ)
[[ "$(sha256sum "$TGZ" | cut -c1-64)" == "$WANT" ]] || die "tarball checksum mismatch"
OLD=$(sed -n 's/^FLEET_DASHBOARD_STATIC_DIR=//p' "$ENVF"); [[ -d "$OLD" ]] || die "current static dir unreadable"
ts() { date -u +%FT%TZ; }
echo "== UI deploy $NAME from $(basename "$TGZ") (sha ${WANT:0:16}); serving now: $OLD; $(ts)"

# 1. Unpack to a scratch directory (never through a symlink or outside it), root-owned, read-only.
EVD=""; TMP=$(mktemp -d "$UI/.unpack-$NAME-XXXXXX"); trap 'rm -rf -- "$TMP"; [[ -z "$EVD" ]] || rm -f -- "$EVD"' EXIT
chmod 0755 "$TMP"
tar -xzf "$TGZ" -C "$TMP" --no-same-owner --no-same-permissions --no-overwrite-dir
if find "$TMP" -type l | grep -q .; then die "the tree contains symlinks"; fi
[[ -f "$TMP/index.html" && -f "$TMP/login/index.html" ]] || die "the tree has no index.html / login/index.html"
chown -R "$OWNER:$OWNER" "$TMP"; find "$TMP" -type d -exec chmod 0755 {} +; find "$TMP" -type f -exec chmod 0644 {} +
# Every entry: type, mode, owner, path, content hash.
manifest() { (cd "$1" && { find . -printf '%y %m %u:%g %p\n'; find . -type f -print0 | xargs -0 -r sha256sum | sed 's/^/h /'; }) | LC_ALL=C sort; }
ACTION=new
if [[ -e "$DEST" || -L "$DEST" ]]; then
  EVD=$(mktemp); diff <(manifest "$TMP") <(manifest "$DEST") > "$EVD" 2>&1 || true
  if [[ ! -L "$DEST" && -d "$DEST" && ! -s "$EVD" ]]; then ACTION=reuse; echo "$DEST exists and is byte-identical to the tarball: reuse"
  else
    [[ "$(realpath -m "$DEST")" != "$(realpath -m "$OLD")" ]] || { die "$DEST is served now and differs from the tarball (not quarantined; investigate)"; }
    ACTION=quarantine; echo "$DEST exists and differs from the tarball ($(grep -c '^[<>]' "$EVD") manifest lines): quarantine it"
  fi
fi
SERVED=0; [[ "$(realpath -m "$DEST")" == "$(realpath -m "$OLD")" ]] && SERVED=1
if [[ $CHECK == 1 ]]; then
  echo "UI CHECK OK: $NAME would be $ACTION$([[ $SERVED == 1 ]] && echo ', already served (no switch, no restart)'); nothing changed"; exit 0
fi
if [[ $ACTION == quarantine ]]; then
  install -d -m 0700 "$QROOT"; Q="$QROOT/ui-$NAME-$STAMP"; [[ ! -e "$Q" ]] || die "$Q exists"
  mv -T -- "$DEST" "$Q"
  { echo "quarantined $(ts): $DEST -> $Q"; echo "reason: differs from $(basename "$TGZ") sha256 $WANT"; echo "manifest difference (< tarball, > existing; first 200 lines):"; head -200 "$EVD"; } > "$Q.evidence.txt"
  chmod 0600 "$Q.evidence.txt"; echo "QUARANTINED $DEST -> $Q (evidence $Q.evidence.txt)"
fi
if [[ $ACTION != reuse ]]; then mv -T "$TMP" "$DEST"; echo "unpacked $(find "$DEST" -type f | wc -l) files to $DEST"; fi

# The listener serves exactly the tree.
same() { [[ "$(curl -s "$LISTEN$1" | sha256sum | cut -c1-64)" == "$(sha256sum "$DEST$2" | cut -c1-64)" ]]; }
serves() {
  same / /index.html || { echo "/ is not $NAME's index.html"; return 1; }
  same /login/ /login/index.html || { echo "/login/ is not $NAME's login page"; return 1; }
  if [[ -f "$DEST/hq-preview/login/index.html" ]]; then same /hq-preview/login/ /hq-preview/login/index.html || { echo "/hq-preview/login/ is not $NAME's preview"; return 1; }; fi
  [[ "$(curl -s -o /dev/null -w '%{http_code}' "$LISTEN/api/read?op=agents&args=%7B%7D")" == 401 ]] || { echo "unauthenticated read not refused"; return 1; }
}
if [[ $SERVED == 1 ]]; then
  WHY=$(serves) || die "$NAME is already served but the listener does not serve it: $WHY (nothing was changed)"
  echo "== UI DEPLOY $NAME: already served and verified (unchanged UI; no switch, no restart) $(ts)"; exit 0
fi

# 2. Switch only FLEET_DASHBOARD_STATIC_DIR (backup first; a new name per attempt, never overwriting an older backup).
BK="$ENVF.pre-$NAME"; [[ ! -e "$BK" ]] || BK="$ENVF.pre-$NAME.$STAMP"; [[ ! -e "$BK" ]] || die "$BK exists"
cp -p "$ENVF" "$BK"
sed -i "s#^FLEET_DASHBOARD_STATIC_DIR=.*#FLEET_DASHBOARD_STATIC_DIR=$DEST#" "$ENVF"
[[ "$(diff "$BK" "$ENVF" | grep -c '^[<>]')" == 2 ]] || { cp -p "$BK" "$ENVF"; die "unexpected env change"; }
PID0=$(systemctl show -p MainPID --value $UNIT)
rollback() {
  echo "!! FAILURE: $1 — restoring $OLD $(ts)"
  cp -p "$BK" "$ENVF"; systemctl restart $UNIT
  for _ in $(seq 1 20); do [[ "$(curl -s -o /dev/null -w '%{http_code}' $LISTEN/login/)" == 200 ]] && break; sleep 1; done
  echo "== UI DEPLOY $NAME ROLLED BACK: serving $(sed -n 's/^FLEET_DASHBOARD_STATIC_DIR=//p' "$ENVF"), login $(curl -s -o /dev/null -w '%{http_code}' $LISTEN/login/)"
  exit 1
}
systemctl restart $UNIT
OK=0; for _ in $(seq 1 30); do [[ "$(curl -s -o /dev/null -w '%{http_code}' $LISTEN/login/)" == 200 ]] && { OK=1; break; }; sleep 1; done
[[ $OK == 1 ]] || rollback "dashboard not serving /login/"
sleep 3; systemctl is-active --quiet $UNIT || rollback "dashboard did not stay up"

# 3. The listener serves exactly the new tree.
WHY=$(serves) || rollback "$WHY"
echo "dashboard pid $PID0 -> $(systemctl show -p MainPID --value $UNIT); root $(curl -s $LISTEN/ | sha256sum | cut -c1-16)"
echo "rollback: cp -p $BK $ENVF && systemctl restart $UNIT"
echo "== UI DEPLOY $NAME DONE $(ts)"
