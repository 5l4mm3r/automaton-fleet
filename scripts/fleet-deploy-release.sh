#!/usr/bin/env bash
# Fleet Phase 4 — deploy the pinned runtime release for the fleet service.
#
#   scripts/fleet-deploy-release.sh build            # as the operator (no sudo): clean frozen build of the
#                                                    # pinned commit, verified against runtime.env
#   sudo scripts/fleet-deploy-release.sh install     # copies the verified build to
#                                                    # /opt/automaton-fleet/releases/<commit> (root-owned,
#                                                    # read-only), re-verifies, switches `current`
#
# The release is whatever /etc/automaton-fleet/runtime.env pins
# (FLEET_RUNTIME_REPO / _COMMIT / _BUILD_ID / _LOCKFILE_SHA256): the same
# immutable runtime children are provisioned with. Dependency install
# scripts never run as root (build happens as the operator).
set -euo pipefail
MODE="${1:?usage: fleet-deploy-release.sh build|install}"
RUNTIME_ENV="${FLEET_RUNTIME_ENV_FILE:-/etc/automaton-fleet/runtime.env}"
OPT=/opt/automaton-fleet
get() { sed -n "s/^$1=//p" "$RUNTIME_ENV" | tail -1; }
REPO_URL="$(get FLEET_RUNTIME_REPO)"; COMMIT="$(get FLEET_RUNTIME_COMMIT)"
BUILD_ID="$(get FLEET_RUNTIME_BUILD_ID)"; LOCK="$(get FLEET_RUNTIME_LOCKFILE_SHA256)"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ && "$BUILD_ID" =~ ^[0-9a-f]{64}$ && "$LOCK" =~ ^[0-9a-f]{64}$ && "$REPO_URL" == https://* ]] ||
  { echo "runtime.env does not pin a complete release (repo/commit/build id/lockfile)" >&2; exit 1; }

identity() { # <dir> -> "buildId lockfileSha256" computed by the tree's own compiled CLI
  (cd "$1" && node dist/fleet/postgres/cli.js build-identity .) |
    node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(j.buildId+" "+j.lockfileSha256)'
}

case "$MODE" in
  build)
    [[ $EUID -ne 0 ]] || { echo "build as the operator, not root" >&2; exit 2; }
    STAGE="${XDG_CACHE_HOME:-$HOME/.cache}/automaton-fleet/stage/$COMMIT"
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
      { echo "BUILD MISMATCH: got $got_build / $got_lock, runtime.env pins $BUILD_ID / $LOCK" >&2; exit 1; }
    echo "Verified build $BUILD_ID staged at $STAGE"
    ;;
  install)
    [[ $EUID -eq 0 ]] || { echo "install needs sudo" >&2; exit 2; }
    OPERATOR_HOME="$(getent passwd "${SUDO_USER:?}" | cut -d: -f6)"
    STAGE="$OPERATOR_HOME/.cache/automaton-fleet/stage/$COMMIT"
    DEST="$OPT/releases/$COMMIT"
    [[ -d "$STAGE" ]] || { echo "no staged build at $STAGE (run: scripts/fleet-deploy-release.sh build)" >&2; exit 1; }
    [[ ! -e "$DEST" ]] || { echo "$DEST already exists; releases are immutable" >&2; exit 1; }
    install -d -m 0755 -o root -g root "$OPT/releases"
    cp -a "$STAGE" "$DEST.tmp"
    rm -rf "$DEST.tmp/.git"
    chown -R root:root "$DEST.tmp"; chmod -R go-w,u-w "$DEST.tmp"; chmod u+w "$DEST.tmp"
    read -r got_build got_lock < <(PATH="$OPT/node/bin:$PATH" identity "$DEST.tmp")
    [[ "$got_build" == "$BUILD_ID" && "$got_lock" == "$LOCK" ]] || { rm -rf "$DEST.tmp"; echo "installed tree does not match the pinned build" >&2; exit 1; }
    chmod u-w "$DEST.tmp"; mv "$DEST.tmp" "$DEST"
    ln -sfn "releases/$COMMIT" "$OPT/current.tmp" && mv -T "$OPT/current.tmp" "$OPT/current"
    echo "Installed release $COMMIT (build $BUILD_ID). Restart the service to pick it up: systemctl restart automaton-fleet"
    ;;
  *) echo "usage: fleet-deploy-release.sh build|install" >&2; exit 2 ;;
esac
