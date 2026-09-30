#!/usr/bin/env bash
# Living-founder restart protection against host maintenance (needrestart via apt / unattended-upgrades).
#
#   sudo scripts/fleet-maintenance-guard.sh install    # install deploy/needrestart/50-automaton-fleet-founders.conf, then check
#   sudo scripts/fleet-maintenance-guard.sh check      # verify (read-only)
#   sudo scripts/fleet-maintenance-guard.sh rehearse   # prove it with the real needrestart + systemd, touching no founder
#
# Invariant: security updates keep installing automatically and needrestart keeps DETECTING outdated founder code,
# but a living automaton-fleet-founder@*.service is never restarted as a side effect of host maintenance. A founder
# restart is an explicit Fleet lifecycle/maintenance operation (scripts/fleet-founders.sh).
#
# check:    the guard file is installed, root-owned, not group/world-writable and identical to this tree's copy;
#           needrestart's OWN configuration (main file + conf.d, evaluated by perl as needrestart does) maps every
#           running founder unit to "do not restart" and leaves the controller units restartable; unattended
#           security upgrades are still enabled; needrestart's apt hook is still present; unattended-upgrades does not
#           reboot automatically.
# rehearse: creates two throwaway units (a runtime unit file for the instance automaton-fleet-founder@NRREHEARSAL,
#           which matches the protected pattern, and fleet-nr-rehearsal-control.service), makes both run a deleted
#           (outdated) binary, and runs needrestart in AUTOMATIC mode (-r a) with the installed configuration plus a
#           rehearsal-only blacklist so that nothing but these two units can be a candidate (verified in list mode
#           first; the run aborts if anything else is listed). PASS = the control was restarted, the founder-pattern
#           unit was deferred with its PID unchanged, and every living founder's MainPID is unchanged. Everything it
#           created is removed on exit (daemon-reload only; nothing else is restarted).
set -euo pipefail
MODE="${1:?usage: fleet-maintenance-guard.sh install|check|rehearse}"
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/deploy/needrestart/50-automaton-fleet-founders.conf"
DST=/etc/needrestart/conf.d/50-automaton-fleet-founders.conf
NRCONF=/etc/needrestart/needrestart.conf
PATTERN='automaton-fleet-founder@*'
fail=0
ok()  { printf 'PASS  %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; fail=1; }

living_units() { systemctl list-units --type=service --state=running --plain --no-legend "$PATTERN" | awk '{print $1}'; }
mainpid() { systemctl show -p MainPID --value "$1"; }

# Decision needrestart's configuration gives each unit name: 0 (do not restart), 1, or "default" (no override).
# Every matching override key must agree (needrestart takes the first match in hash order).
decide() { # decide <conf> <unit>...
  perl -e '
    our %nrconf = (blacklist_rc => [], override_rc => {}, blacklist_mappings => []);
    my $conf = shift @ARGV;
    do $conf; die "config error: $@" if $@;
    for my $u (@ARGV) {
      my @v = map { $nrconf{override_rc}->{$_} } grep { $u =~ /$_/ } keys %{$nrconf{override_rc}};
      my %d = map { ($_ ? 1 : 0) => 1 } @v;
      print "$u ", (!@v ? "default" : keys(%d) > 1 ? "conflict" : (keys %d)[0]), "\n";
    }' "$@"
}

check() {
  if [[ -f "$DST" ]]; then
    [[ "$(stat -c %U:%G "$DST")" == root:root && $(( 0$(stat -c %a "$DST") & 022 )) -eq 0 ]] && ok "guard file root-owned, not group/world-writable" || bad "guard file ownership/mode ($(stat -c '%U:%G %a' "$DST"))"
    cmp -s "$SRC" "$DST" && ok "guard file identical to $SRC ($(sha256sum "$DST" | cut -c1-16)…)" || bad "guard file differs from $SRC"
  else
    bad "guard file missing: $DST"
  fi
  local units dec n=0
  units="$(living_units)"
  # Fail closed: a configuration needrestart cannot evaluate is a failure, never "no founders".
  if dec="$(decide "$NRCONF" $units automaton-fleet.service automaton-fleet-operator-api.service automaton-fleet-fetcher.service unattended-upgrades.service)"; then
    while read -r u d; do
      case "$u" in
        automaton-fleet-founder@*) n=$((n+1)); [[ "$d" == 0 ]] && ok "needrestart will not restart $u (override 0)" || bad "needrestart decision for $u is '$d' (must be 0)" ;;
        *) [[ "$d" == default ]] && ok "$u keeps needrestart's default behaviour (the guard is narrow)" || bad "$u unexpectedly overridden ($d)" ;;
      esac
    done <<<"$dec"
    [[ $n -gt 0 ]] || echo "INFO  no living founder units are running"
  else
    bad "needrestart configuration could not be evaluated"
  fi
  [[ "$(apt-config dump APT::Periodic::Unattended-Upgrade | sed -n 's/.*"\(.*\)";/\1/p')" == 1 ]] && ok "unattended upgrades enabled (APT::Periodic::Unattended-Upgrade 1)" || bad "unattended upgrades are not enabled"
  apt-config dump | grep -q 'Unattended-Upgrade::Allowed-Origins:: "${distro_id}:${distro_codename}-security"' && ok "security origin allowed" || bad "security origin not allowed"
  systemctl is-enabled --quiet apt-daily-upgrade.timer && ok "apt-daily-upgrade.timer enabled" || bad "apt-daily-upgrade.timer not enabled"
  grep -q needrestart /etc/apt/apt.conf.d/99needrestart 2>/dev/null && ok "needrestart apt hook present (outdated code is still detected and reported)" || bad "needrestart apt hook missing"
  local reboot; reboot="$(apt-config dump Unattended-Upgrade::Automatic-Reboot | sed -n 's/.*"\(.*\)";/\1/p')"
  [[ "$reboot" != true && "$reboot" != 1 ]] && ok "unattended-upgrades does not reboot automatically (Automatic-Reboot=${reboot:-unset})" || bad "Unattended-Upgrade::Automatic-Reboot is enabled"
  return $fail
}

case "$MODE" in
  install)
    install -d -m 0755 -o root -g root /etc/needrestart/conf.d
    install -m 0644 -o root -g root "$SRC" "$DST.tmp" && mv -f "$DST.tmp" "$DST"
    echo "installed $DST"
    check
    ;;
  check)
    check
    ;;
  rehearse)
    check >/dev/null || { check; echo "refusing to rehearse: check fails" >&2; exit 1; }
    R=/run/fleet-nr-rehearsal
    P=automaton-fleet-founder@NRREHEARSAL.service
    C=fleet-nr-rehearsal-control.service
    U=/run/systemd/system
    [[ ! -e "$R" && ! -e "$U/$P" && ! -e "$U/$C" ]] || { echo "rehearsal leftovers exist; remove them first" >&2; exit 1; }
    systemctl list-units --all --plain --no-legend "$P" | grep -q . && { echo "$P already known to systemd" >&2; exit 1; }
    declare -A before
    for u in $(living_units); do before[$u]="$(mainpid "$u")"; done
    cleanup() {
      systemctl stop "$P" "$C" >/dev/null 2>&1 || true
      rm -f "$U/$P" "$U/$C"; systemctl daemon-reload; rm -rf "$R"
    }
    trap cleanup EXIT
    mkdir -m 0755 "$R"
    cp /usr/bin/sleep "$R/rehearsal-sleep"
    for f in "$P" "$C"; do
      printf '[Unit]\nDescription=fleet maintenance-guard rehearsal (NOT a founder; removed on exit)\n[Service]\nExecStart=%s infinity\nDynamicUser=yes\n' "$R/rehearsal-sleep" >"$U/$f"
    done
    systemctl daemon-reload
    systemctl start "$P" "$C"
    p0="$(mainpid "$P")"; c0="$(mainpid "$C")"
    [[ "$p0" -gt 0 && "$c0" -gt 0 ]] || { echo "rehearsal units did not start" >&2; exit 1; }
    # Make both outdated exactly as a package upgrade would: the running binary is replaced on disk.
    rm -f "$R/rehearsal-sleep"; cp /usr/bin/sleep "$R/rehearsal-sleep"
    echo "== detection with the installed configuration (list mode, nothing restarted)"
    nr_all="$(needrestart -r l -b -l </dev/null 2>/dev/null | sed -n 's/^NEEDRESTART-SVC: //p' | sort)"
    echo "$nr_all" | sed 's/^/  /'
    grep -qx "$P" <<<"$nr_all" && ok "installed needrestart still DETECTS the outdated founder-pattern unit" || bad "founder-pattern unit not detected"
    grep -qx "$C" <<<"$nr_all" && ok "installed needrestart detects the outdated control unit" || bad "control unit not detected"
    # Rehearsal configuration: the installed one (which includes conf.d, i.e. the guard) + a blacklist of every
    # service except the two rehearsal units, so the automatic run cannot touch anything real.
    cp "$NRCONF" "$R/needrestart.conf"
    printf '\n# rehearsal only\n$nrconf{blacklist_rc} = [ qr(^(?!(automaton-fleet-founder\\@NRREHEARSAL|fleet-nr-rehearsal-control)\\.service$)) ];\n' >>"$R/needrestart.conf"
    cand="$(needrestart -c "$R/needrestart.conf" -r l -b -l </dev/null 2>/dev/null | sed -n 's/^NEEDRESTART-SVC: //p' | sort | tr '\n' ' ')"
    [[ "$cand" == "$(printf '%s\n' "$P" "$C" | sort | tr '\n' ' ')" ]] || { echo "ABORT: rehearsal candidates are '$cand' (must be exactly the two rehearsal units)" >&2; exit 1; }
    ok "rehearsal candidates are exactly the two rehearsal units"
    [[ "$(decide "$R/needrestart.conf" "$P" | awk '{print $2}')" == 0 ]] && ok "the installed guard entry covers $P" || bad "guard does not cover $P"
    echo "== automatic restart (needrestart -r a), as the apt/unattended-upgrades hook does"
    DEBIAN_FRONTEND=noninteractive needrestart -c "$R/needrestart.conf" -r a -l </dev/null 2>&1 | sed 's/^/  /' || true
    p1="$(mainpid "$P")"; c1="$(mainpid "$C")"
    [[ "$c1" -gt 0 && "$c1" != "$c0" ]] && ok "control unit WAS restarted automatically (PID $c0 -> $c1): automatic restarts still work" || bad "control unit was not restarted (PID $c0 -> $c1)"
    [[ "$p1" == "$p0" ]] && ok "founder-pattern unit was NOT restarted (PID $p0 unchanged)" || bad "founder-pattern unit was restarted (PID $p0 -> $p1)"
    for u in "${!before[@]}"; do
      [[ "$(mainpid "$u")" == "${before[$u]}" ]] && ok "living founder $u untouched (MainPID ${before[$u]})" || bad "living founder $u MainPID changed"
    done
    [[ $fail -eq 0 ]] && echo "REHEARSAL PASS" || echo "REHEARSAL FAIL"
    exit $fail
    ;;
  *) echo "usage: fleet-maintenance-guard.sh install|check|rehearse" >&2; exit 2 ;;
esac
