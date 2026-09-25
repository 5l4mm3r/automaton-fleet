#!/usr/bin/env bash
# Phase F.1 — Genesis founder runtime provisioner (root; runs the PINNED release).
#
#   sudo scripts/fleet-founders.sh status
#   sudo scripts/fleet-founders.sh rehearsal                     # real runtimes, THROWAWAY registry
#   sudo scripts/fleet-founders.sh provision <genesisId>         # after the owner's genesis-approve
#   sudo scripts/fleet-founders.sh attest <genesisId>
#   sudo scripts/fleet-founders.sh activate <genesisId> <authSha256>   # OWNER GATE
#   sudo scripts/fleet-founders.sh teardown <genesisId>
#
# Secrets (attestation tokens, founder credentials) are generated inside the
# provisioner and written only to each founder's own 0600 state files; none
# is printed, logged or passed on a command line.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo from the owner's account" >&2; exit 2; }
[[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != root ]] || { echo "run through sudo from the owner's own account" >&2; exit 2; }
REL=/opt/automaton-fleet/current
exec /opt/automaton-fleet/node/bin/node "$REL/dist/fleet/founder/cli.js" "$@"
