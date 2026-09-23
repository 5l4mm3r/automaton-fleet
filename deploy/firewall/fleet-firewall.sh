#!/usr/bin/env bash
# Phase 6 — host firewall for the remote fleet controller (ufw).
#
#   sudo deploy/firewall/fleet-firewall.sh            # DRY RUN: prints the rules, changes nothing
#   sudo deploy/firewall/fleet-firewall.sh --apply    # applies them
#
# Inbound policy: deny everything except SSH (so the operator is not locked
# out) and HTTPS 443/tcp for the fleet controller. PostgreSQL (5432), Redis
# (6379) and the loopback admin port (8787) are explicitly denied as well,
# even though they already listen on loopback only. Outbound is unchanged.
set -euo pipefail
APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1
[[ $EUID -eq 0 ]] || { echo "run with sudo (dry run only prints)" >&2; exit 2; }
command -v ufw >/dev/null || { echo "ufw not installed; see FLEET.md (Phase 6, firewall) for nftables rules" >&2; exit 1; }
SSH_PORT="${FLEET_SSH_PORT:-22}"
run() { printf '  %s\n' "$*"; if (( APPLY )); then "$@"; fi; }
(( APPLY )) && echo "APPLYING fleet firewall" || echo "DRY RUN — nothing will change. Re-run with --apply after review."
run ufw default deny incoming
run ufw default allow outgoing
run ufw allow "${SSH_PORT}/tcp" comment 'operator SSH'
run ufw allow 443/tcp comment 'automaton fleet controller (HTTPS only)'
run ufw deny 5432/tcp comment 'PostgreSQL never exposed'
run ufw deny 6379/tcp comment 'Redis never exposed'
run ufw deny 8787/tcp comment 'fleet admin HTTP is loopback-only'
run ufw --force enable
run ufw status verbose
