#!/usr/bin/env bash
# Virtual HQ benchmark on a real hardware GPU (shadows, High, Ultra, reflections, full post-processing; 1/10/25/50 agents).
#
# Runs the LIVE export against real ephemeral Fleets (local PostgreSQL), in Chrome with hardware acceleration.
# Writes performance.json (Fleet / Department / Agent fps per quality and agent count) and the review screenshots to
# the output directory. Local only: no network services, no production access, no money.
#
#   scripts/hq-benchmark.sh [OUTPUT_DIR]
#
# Requirements: Node + the repo's dependencies, PostgreSQL binaries (as for the PG test suite), Chrome/Chromium, and a
# GPU whose driver can build three.js shadow-map shaders (the dev VM's VMware SVGA3D cannot; the scene then turns
# shadow maps off and remembers it, so measure on real hardware for the intended path).
#
# FLEET_HQ_GPU=native lets Chrome pick its platform backend (D3D11 / Metal / Vulkan / GL); FLEET_HQ_GPU=1 forces ANGLE/GL.
set -euo pipefail
OUT="${1:-$(pwd)/hq-benchmark-$(date -u +%Y%m%dT%H%M%SZ)}"
cd "$(dirname "$0")/.."
(cd codex-dashboard && NEXT_TELEMETRY_DISABLED=1 node scripts/build.mjs live >/dev/null)
FLEET_HQ_TESTS=1 FLEET_HQ_MATRIX=1 FLEET_HQ_GPU="${FLEET_HQ_GPU:-native}" FLEET_HQ_SHOTS="$OUT" \
  npx vitest run src/__tests__/fleet/fleet-virtual-hq-pg.test.ts
echo "results: $OUT/performance.json"
