#!/usr/bin/env bash
# Phase C — build and install the pinned ChatGPT adapter artifact.
#
#   scripts/fleet-deploy-chatgpt-adapter.sh build <commit> <buildId> <lockfileSha256>   # as the operator (no sudo)
#   sudo scripts/fleet-deploy-chatgpt-adapter.sh install <commit>                       # root: copy, re-verify, switch
#
# The adapter runs from its OWN release tree, /opt/automaton-fleet/chatgpt-adapter/
# releases/<commit> (root-owned, read-only), selected by the "current" symlink
# there. It never touches /opt/automaton-fleet/releases, /opt/automaton-fleet/
# current or runtime.env: the FleetController / Operator API runtime identity is
# unchanged. The build is the same reproducible procedure as the runtime
# (fresh clone of the pinned commit from the fork, lockfile hash checked before
# install, frozen install, build, build-identity must equal the expected pins).
set -euo pipefail
MODE="${1:?usage: build <commit> <buildId> <lockfileSha256> | install <commit>}"
COMMIT="${2:?commit}"
REPO_URL="https://github.com/5l4mm3r/automaton-fleet.git"
OPT=/opt/automaton-fleet/chatgpt-adapter
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "commit must be a full 40-hex SHA" >&2; exit 2; }

identity() { # <dir> -> "buildId lockfileSha256" computed by the tree's own compiled CLI
  (cd "$1" && PATH="/opt/automaton-fleet/node/bin:$PATH" node dist/fleet/postgres/cli.js build-identity .) |
    PATH="/opt/automaton-fleet/node/bin:$PATH" node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(j.buildId+" "+j.lockfileSha256)'
}

case "$MODE" in
  build)
    BUILD_ID="${3:?expected build id}"; LOCK="${4:?expected lockfile sha256}"
    [[ "$BUILD_ID" =~ ^[0-9a-f]{64}$ && "$LOCK" =~ ^[0-9a-f]{64}$ ]] || { echo "build id / lockfile must be 64 hex" >&2; exit 2; }
    [[ $EUID -ne 0 ]] || { echo "build as the operator, not root" >&2; exit 2; }
    STAGE="${XDG_CACHE_HOME:-$HOME/.cache}/automaton-fleet/chatgpt-adapter-stage/$COMMIT"
    rm -rf "$STAGE"; mkdir -p "$STAGE"
    git init -q "$STAGE"; cd "$STAGE"
    git remote add origin "$REPO_URL"
    git fetch -q --depth 1 origin "$COMMIT"
    git checkout -q --detach "$COMMIT"
    test "$(git rev-parse HEAD)" = "$COMMIT"
    echo "$LOCK  pnpm-lock.yaml" | sha256sum -c --quiet -
    CI=true pnpm install --frozen-lockfile
    pnpm build
    test -z "$(git status --porcelain --untracked-files=no)"
    read -r got_build got_lock < <(identity "$STAGE")
    [[ "$got_build" == "$BUILD_ID" && "$got_lock" == "$LOCK" ]] ||
      { echo "BUILD MISMATCH: got $got_build / $got_lock, expected $BUILD_ID / $LOCK" >&2; exit 1; }
    printf '%s %s %s\n' "$COMMIT" "$BUILD_ID" "$LOCK" > "$STAGE/.adapter-pins"
    echo "Verified adapter build $BUILD_ID staged at $STAGE"
    ;;
  install)
    [[ $EUID -eq 0 ]] || { echo "install needs sudo" >&2; exit 2; }
    OPERATOR_HOME="$(getent passwd "${SUDO_USER:?}" | cut -d: -f6)"
    STAGE="$OPERATOR_HOME/.cache/automaton-fleet/chatgpt-adapter-stage/$COMMIT"
    DEST="$OPT/releases/$COMMIT"
    [[ -f "$STAGE/.adapter-pins" ]] || { echo "no verified staged build at $STAGE (run build first)" >&2; exit 1; }
    read -r pin_commit BUILD_ID LOCK < "$STAGE/.adapter-pins"
    [[ "$pin_commit" == "$COMMIT" ]] || { echo "staged pins are for $pin_commit" >&2; exit 1; }
    [[ ! -e "$DEST" ]] || { echo "$DEST already exists; releases are immutable" >&2; exit 1; }
    install -d -m 0755 -o root -g root "$OPT" "$OPT/releases"
    cp -a "$STAGE" "$DEST.tmp"
    rm -rf "$DEST.tmp/.git" "$DEST.tmp/.adapter-pins"
    chown -R root:root "$DEST.tmp"; chmod -R go-w,u-w "$DEST.tmp"; chmod u+w "$DEST.tmp"
    read -r got_build got_lock < <(identity "$DEST.tmp")
    [[ "$got_build" == "$BUILD_ID" && "$got_lock" == "$LOCK" ]] || { rm -rf "$DEST.tmp"; echo "installed tree does not match the verified build" >&2; exit 1; }
    chmod u-w "$DEST.tmp"; mv "$DEST.tmp" "$DEST"
    printf 'FLEET_CHATGPT_ADAPTER_COMMIT=%s\nFLEET_CHATGPT_ADAPTER_BUILD_ID=%s\nFLEET_CHATGPT_ADAPTER_LOCKFILE_SHA256=%s\n' "$COMMIT" "$BUILD_ID" "$LOCK" > "$OPT/pins.tmp"
    chmod 0644 "$OPT/pins.tmp"; mv "$OPT/pins.tmp" "$OPT/pins.env"
    ln -sfn "releases/$COMMIT" "$OPT/current.tmp" && mv -T "$OPT/current.tmp" "$OPT/current"
    echo "Installed ChatGPT adapter $COMMIT (build $BUILD_ID). Restart: systemctl restart automaton-fleet-chatgpt-adapter"
    ;;
  *) echo "usage: build <commit> <buildId> <lockfileSha256> | install <commit>" >&2; exit 2 ;;
esac
