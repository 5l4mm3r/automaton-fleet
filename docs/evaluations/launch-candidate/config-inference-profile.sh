#!/usr/bin/env bash
# Incident close-out, part C2 (PREPARED 28 Oct, NOT RUN — owner approval required): record the owner's explicit cloud choice
# in the controller configuration, WITHOUT a restart and WITHOUT enabling inference.
#
#   bash config-inference-profile.sh --check    read-only: gates + the preflight of the would-be file (temp, root 0600)
#   bash config-inference-profile.sh            backup → install → preflight of the LIVE file (automatic restore on failure)
#
# Adds exactly one line to /etc/automaton-fleet/service.env: FLEET_INFERENCE_PROFILE=cloud_allowed. The provider stays
# `none`, so nothing changes until a later, separately approved restart (Stage 1 retry): the line only removes the 27 Oct
# failure (a cloud provider under the default local_only profile) from that restart. The registry's own profile is already
# cloud_allowed (v112, 24 Oct). The running controller is not touched: its PID is checked before and after.
set -uo pipefail
R=~/rlc140; E=/etc/automaton-fleet; SE=$E/service.env; N=/opt/automaton-fleet/node/bin/node
PF=$R/fleet-controller-preflight.mjs; PF_SHA=2c6f6c37ad900b92b1d461996040facfcbfb88fbf27989797fe9e1be5594d628
MODE=${1:-apply}; ts() { date -u +%FT%TZ; }
Q() { sudo -n -u postgres psql -X -q -At -d automaton_fleet -c "SET default_transaction_read_only=on; SET search_path=fleet; $1"; }
die() { echo "!! $*"; echo "== C2 NOT APPLIED $(ts): $SE as before (sha $(sudo -n sha256sum $SE | cut -c1-16)); controller untouched"; exit 1; }
pid() { systemctl show -p MainPID --value automaton-fleet.service; }
preflight() { (cd /tmp && sudo -n $N $PF --service-env "$1"); }
echo "== C2 inference profile ($MODE) $(ts)"
[[ "$(sha256sum < $PF | cut -c1-64)" == "$PF_SHA" ]] || die "the preflight script is not $PF_SHA"
[[ "$(readlink -f /opt/automaton-fleet/current | xargs basename)" == c448d98a1c32c63af89288758240fc5787f9f9d6 ]] || die "release is not c448d98"
[[ "$(Q 'SELECT profile FROM fleet_inference_profile WHERE id = 1')" == cloud_allowed ]] || die "the registry profile is not cloud_allowed"
sudo -n grep -qx 'FLEET_COGNITION_PROVIDER=none' $SE || die "the provider is not none (C2 runs only while inference is contained)"
[[ "$(Q 'SELECT cognition_enabled FROM fleet_cognition_policy WHERE id = 1')" == f ]] || die "the cognition policy is enabled"
if sudo -n grep -q '^FLEET_INFERENCE_PROFILE=' $SE; then
  sudo -n grep -qx 'FLEET_INFERENCE_PROFILE=cloud_allowed' $SE && { echo "  already present: nothing to do"; exit 0; } || die "a different FLEET_INFERENCE_PROFILE line exists"
fi
P0=$(pid); echo "  controller PID $P0; service.env sha $(sudo -n sha256sum $SE | cut -c1-16)"
echo "== preflight of the CURRENT file (must pass: it is the rollback)"; preflight $SE | tail -1; [[ ${PIPESTATUS[0]} == 0 ]] || die "the current configuration does not pass the preflight"
T=$(sudo -n mktemp -d /root/c2.XXXXXX); trap 'sudo -n rm -rf "$T"' EXIT
sudo -n bash -c "cp -p $SE $T/service.env.new && echo FLEET_INFERENCE_PROFILE=cloud_allowed >> $T/service.env.new && chmod 600 $T/service.env.new"
[[ "$(sudo -n diff $SE $T/service.env.new | grep -c '^>')" == 1 && "$(sudo -n diff $SE $T/service.env.new | grep -c '^<')" == 0 ]] || die "the new file differs by more than the one added line"
echo "== preflight of the NEW file"; preflight $T/service.env.new > $R/c2-preflight-new.log; tail -1 $R/c2-preflight-new.log
grep -q '^PASS inference profile and cognition provider — profile cloud_allowed, provider none' $R/c2-preflight-new.log && grep -q '^PREFLIGHT PASSED' $R/c2-preflight-new.log || die "the new file does not pass the preflight"
if [[ $MODE == --check ]]; then echo "== C2 CHECK PASSED $(ts) (read-only; nothing written)"; exit 0; fi

B=$SE.pre-inference-profile-$(date -u +%Y%m%dT%H%M%SZ)
sudo -n cp -p $SE $B || die "backup failed"
sudo -n install -o root -g root -m 600 $T/service.env.new $SE.c2-tmp && sudo -n mv -f $SE.c2-tmp $SE || { sudo -n cp -p $B $SE; die "install failed (restored from $B)"; }
echo "  installed; backup $B"
echo "== preflight of the LIVE file"
if ! preflight $SE > $R/c2-preflight-live.log || ! grep -q 'profile cloud_allowed, provider none' $R/c2-preflight-live.log; then
  sudo -n cp -p $B $SE; die "the live file failed the preflight — RESTORED from $B ($(tail -1 $R/c2-preflight-live.log))"
fi
tail -1 $R/c2-preflight-live.log
[[ "$(pid)" == "$P0" ]] || echo "!! the controller PID changed ($P0 → $(pid)): it was not restarted by this script — investigate"
echo "== C2 APPLIED $(ts): FLEET_INFERENCE_PROFILE=cloud_allowed in $SE (provider still none; takes effect at the next approved restart)."
echo "   Rollback (no restart needed while the controller has not restarted): sudo cp -p $B $SE"
