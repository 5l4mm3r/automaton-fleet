#!/usr/bin/env bash
# Automaton Fleet — decide what to do with a release directory that already exists for the pinned commit (a previous,
# interrupted or rolled-back attempt). Called by scripts/fleet-rollout.sh cutover BEFORE any runtime configuration changes.
#
#   sudo scripts/fleet-release-reuse.sh <releaseDir> <stageDir> <buildId> <lockfileSha256>
#
#   <releaseDir>  /opt/automaton-fleet/releases/<commit>
#   <stageDir>    the operator's verified staged build of the same commit (scripts/fleet-deploy-release.sh build)
#
# exit 0   <releaseDir> is complete and verified: every path, file type, file content (sha256) and symlink target equals
#          the staged verified build (its .git excepted, as install drops it), its own compiled CLI reports the pinned
#          build id and lockfile hash, it is entirely root-owned and nothing in it is writable. It may be reused as is.
# exit 10  it was NOT verified: it is moved (never deleted) to <quarantine>/release-<commit>-<stamp> with an evidence file
#          (<same>.evidence.txt: the reason, the expected and observed identity, the manifest difference). A fresh install
#          may proceed. A leftover <releaseDir>.tmp (an interrupted install) is always quarantined the same way.
# exit 2   refused (bad arguments, no staged build); nothing was moved.
set -euo pipefail
export PATH=/opt/automaton-fleet/node/bin:$PATH
DEST="${1:-}"; STAGE="${2:-}"; B="${3:-}"; L="${4:-}"
die() { echo "REUSE REFUSED: $*" >&2; exit 2; }
QROOT="${FLEET_QUARANTINE_ROOT:-/opt/automaton-fleet/quarantine}"; OWNER="${FLEET_RELEASE_OWNER:-root}"
[[ "$DEST" =~ ^/.+/releases/[0-9a-f]{40}$ ]] || die "release directory must be <…>/releases/<commit>"
[[ "$B" =~ ^[0-9a-f]{64}$ && "$L" =~ ^[0-9a-f]{64}$ ]] || die "build id and lockfile sha256 are 64 hex characters"
[[ -d "$STAGE" && ! -L "$STAGE" && -f "$STAGE/dist/fleet/postgres/cli.js" ]] || die "no staged build at $STAGE"
C=$(basename "$DEST"); STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ts() { date -u +%FT%TZ; }
# Every entry of a tree: type, path, and content hash (files) or target (symlinks); the top-level .git is not part of a release.
manifest() { (cd "$1" && { find . -path ./.git -prune -o ! -type f -printf '%y %p -> %l\n'
  find . -path ./.git -prune -o -type f -print0 | xargs -0 -r sha256sum | sed 's/^/f /'; }) | LC_ALL=C sort; }
identity() { (cd "$1" && node dist/fleet/postgres/cli.js build-identity .) 2>/dev/null |
  node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(j.buildId+" "+j.lockfileSha256)' 2>/dev/null || echo "unreadable"; }
quarantine() { # <path> <reason> <nameSuffix> <evidenceFile>
  local q="$QROOT/release-$C-$STAMP$3"
  install -d -m 0700 "$QROOT"
  [[ ! -e "$q" ]] || die "$q exists"
  mv -T -- "$1" "$q"
  { echo "quarantined $(ts): $1 -> $q"; echo "reason: $2"; echo "expected build $B lockfile $L"; [[ -n "$4" && -f "$4" ]] && cat "$4"; } > "$q.evidence.txt"
  chmod 0600 "$q.evidence.txt"
  echo "QUARANTINED $1 -> $q ($2; evidence $q.evidence.txt)"
}
EV=$(mktemp); trap 'rm -f "$EV"' EXIT
if [[ -e "$DEST.tmp" || -L "$DEST.tmp" ]]; then
  echo "interrupted install found at $DEST.tmp" > "$EV"
  quarantine "$DEST.tmp" "an interrupted install ($DEST.tmp)" ".tmp" "$EV"
fi
[[ -e "$DEST" || -L "$DEST" ]] || { echo "no existing $DEST: install fresh"; exit 10; }

WHY=""; : > "$EV"
if [[ -L "$DEST" || ! -d "$DEST" ]]; then WHY="not a plain directory"
else
  if [[ -n "$(find "$DEST" \( ! -user "$OWNER" -o ! -group "$OWNER" \) -print -quit)" ]]; then WHY="not entirely owned by $OWNER"
  elif [[ -n "$(find "$DEST" ! -type l -perm /0222 -print -quit)" ]]; then WHY="contains writable entries"
  else
    # Contents first: nothing from the existing directory is executed unless it is byte-identical to the verified stage.
    diff <(manifest "$STAGE") <(manifest "$DEST") > "$EV.diff" || true
    if [[ -s "$EV.diff" ]]; then
      WHY="contents differ from the verified staged build ($(grep -c '^[<>]' "$EV.diff") manifest lines)"
      { echo "manifest difference (< staged build, > existing directory; first 200 lines):"; head -200 "$EV.diff"; } > "$EV"
    else
      GOT=$(identity "$DEST")
      [[ "$GOT" == "$B $L" ]] || WHY="its compiled CLI reports '$GOT', not the pinned build"
    fi
    rm -f "$EV.diff"
  fi
fi
if [[ -z "$WHY" ]]; then
  echo "VERIFIED $DEST: identical to the staged build $B (lockfile ${L:0:16}); reuse"
  exit 0
fi
quarantine "$DEST" "$WHY" "" "$EV"
exit 10
