#!/usr/bin/env bash
# Reproducible build of a pinned fleet runtime commit, printing the values the
# operator approves:  FLEET_RUNTIME_BUILD_ID / FLEET_RUNTIME_LOCKFILE_SHA256.
#
#   scripts/fleet-build-runtime.sh <https repo url> <40-hex commit>
#
# Builds in a fresh temporary clone exactly as a child sandbox does:
# lockfile hash printed before install, `pnpm install --frozen-lockfile`,
# `pnpm build`, then the build identity of the tree (dist + src + manifests).
set -euo pipefail
repo="${1:?repo url}"; commit="${2:?commit sha}"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "commit must be a full 40-hex SHA" >&2; exit 2; }
here="$(cd "$(dirname "$0")/.." && pwd)"
dir="$(mktemp -d)"; trap 'rm -rf "$dir"' EXIT
git init -q "$dir/automaton"
cd "$dir/automaton"
git remote add origin "$repo"
git fetch -q --depth 1 origin "$commit"
git checkout -q --detach "$commit"
test "$(git rev-parse HEAD)" = "$commit"
test -f pnpm-lock.yaml
CI=true pnpm install --frozen-lockfile >&2
pnpm build >&2
test -z "$(git status --porcelain --untracked-files=no)"
cd "$here"
node --import tsx src/fleet/postgres/cli.ts build-identity "$dir/automaton" | node -e '
  const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
  console.log(`FLEET_RUNTIME_REPO=${process.argv[1]}`);
  console.log(`FLEET_RUNTIME_COMMIT=${process.argv[2]}`);
  console.log(`FLEET_RUNTIME_BUILD_ID=${j.buildId}`);
  console.log(`FLEET_RUNTIME_LOCKFILE_SHA256=${j.lockfileSha256}`);
' "$repo" "$commit"
