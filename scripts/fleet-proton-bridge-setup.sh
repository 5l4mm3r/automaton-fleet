#!/usr/bin/env bash
# Proton Mail Bridge for the Fleet's shared mailbox, on the controller host (deploy/proposed/proton-bridge/README.md).
# Bridge runs as its own system user with its own headless keychain (pass + a GPG key in its 0700 home), loopback only.
# Nothing here signs in to Proton: the login is the owner's, interactive, once.
#
#   sudo scripts/fleet-proton-bridge-setup.sh check             read-only: what is present, what is missing
#   sudo scripts/fleet-proton-bridge-setup.sh install           print the plan (nothing changes)
#   sudo scripts/fleet-proton-bridge-setup.sh install --apply
#       1. OS user automaton-fleet-mailbridge (system, nologin, no other group), home /var/lib/automaton-fleet-mailbridge 0700
#       2. its keychain: a passphrase-less GPG key that never leaves that home, and `pass init` with it (Bridge stores
#          its own vault key there; a headless host has no other secret service)
#       3. the unit automaton-fleet-proton-bridge.service installed, NOT enabled (it cannot run before the login)
#   Then the owner, interactively (Proton password + 2FA typed into Bridge only, never into the Fleet):
#       sudo -u automaton-fleet-mailbridge -H protonmail-bridge --cli
#         >>> login        (the shared Fleet address)
#         >>> info         (note the Bridge-GENERATED username and password; ports 1143 IMAP / 1025 SMTP, STARTTLS)
#         >>> exit
#   sudo scripts/fleet-proton-bridge-setup.sh enable --apply      enable + start the unit (loopback only), wait for IMAP
#   sudo scripts/fleet-proton-bridge-setup.sh cert                print Bridge's certificate (PEM) as its IMAP port presents it
#   Finally paste the address, the Bridge-generated username/password and that certificate into the dashboard:
#   Money & identity → 5 · Mail and SMS (sealed in your browser to the identity broker; the broker starts mail itself).
#
# Prerequisites (the owner installs OS packages): Proton's official Bridge package for Ubuntu, signature verified as
# https://proton.me/support/bridge-for-linux describes, plus `pass` and `gnupg` (apt). A PAID Proton plan (Mail Plus or
# above) — the free plan has no Bridge.
# Undo: systemctl disable --now automaton-fleet-proton-bridge; mail then shows NOT CONFIGURED / unhealthy, nothing else
# depends on it (agents get an action-scoped FLEET_CAPABILITY_NOT_CONFIGURED).
set -euo pipefail
MODE="${1:?usage: check | install [--apply] | enable [--apply] | cert}"
shift
APPLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in --apply) APPLY=1 ;; *) echo "unknown argument $1" >&2; exit 2 ;; esac
  shift
done
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
USER_=automaton-fleet-mailbridge
HOME_=/var/lib/$USER_
UNIT=automaton-fleet-proton-bridge.service
BRIDGE="${FLEET_BRIDGE_BIN:-/usr/bin/protonmail-bridge}"
IMAP_PORT="${FLEET_MAIL_BRIDGE_IMAP_PORT:-1143}"
SRC_UNIT="$REPO/deploy/proposed/proton-bridge/$UNIT"
[[ -f /opt/automaton-fleet/current/deploy/proposed/proton-bridge/$UNIT ]] && SRC_UNIT=/opt/automaton-fleet/current/deploy/proposed/proton-bridge/$UNIT

say() { printf '\n# %s\n' "$*"; }
run() { printf '  %s\n' "$*"; if (( APPLY )); then "$@"; fi; }
as_user() { runuser -u "$USER_" -- env HOME="$HOME_" GNUPGHOME="$HOME_/.gnupg" PASSWORD_STORE_DIR="$HOME_/.password-store" "$@"; }
key_fpr() { as_user gpg --batch --with-colons --list-secret-keys 2>/dev/null | awk -F: '/^fpr:/ {print $10; exit}'; }
imap_up() { timeout 3 bash -c "exec 3<>/dev/tcp/127.0.0.1/$IMAP_PORT" 2>/dev/null; }

if [[ "$MODE" == check ]]; then
  bad=0
  ok() { printf '  %-44s %s\n' "$1" "$2"; }
  [[ -x "$BRIDGE" ]] && ok "Bridge binary $BRIDGE" "present" || { ok "Bridge binary $BRIDGE" "MISSING (install Proton's signed package)"; bad=1; }
  for b in pass gpg; do command -v "$b" >/dev/null && ok "$b" "present" || { ok "$b" "MISSING (apt install pass gnupg)"; bad=1; }; done
  id "$USER_" >/dev/null 2>&1 && ok "OS user $USER_" "present (groups: $(id -nG "$USER_"))" || { ok "OS user $USER_" "MISSING"; bad=1; }
  [[ -d "$HOME_" ]] && ok "$HOME_" "$(stat -c '%U:%G %a' "$HOME_")" || { ok "$HOME_" "MISSING"; bad=1; }
  if id "$USER_" >/dev/null 2>&1 && [[ -d "$HOME_" ]]; then
    [[ -n "$(key_fpr)" ]] && ok "keychain GPG key" "present" || { ok "keychain GPG key" "MISSING"; bad=1; }
    [[ -f "$HOME_/.password-store/.gpg-id" ]] && ok "pass store" "initialised" || { ok "pass store" "NOT INITIALISED"; bad=1; }
  fi
  [[ -f /etc/systemd/system/$UNIT ]] && ok "$UNIT" "$(systemctl is-enabled "$UNIT" 2>/dev/null || true) / $(systemctl is-active "$UNIT" 2>/dev/null || true)" || { ok "$UNIT" "NOT INSTALLED"; bad=1; }
  imap_up && ok "IMAP 127.0.0.1:$IMAP_PORT" "listening" || ok "IMAP 127.0.0.1:$IMAP_PORT" "not listening (login + enable pending)"
  if command -v ss >/dev/null; then
    pub="$(ss -Hltn "( sport = :$IMAP_PORT or sport = :1025 )" 2>/dev/null | awk '{print $4}' | grep -Ev '^(127\.0\.0\.1|\[::1\]):' || true)"
    [[ -z "$pub" ]] && ok "Bridge ports exposure" "loopback only" || { ok "Bridge ports exposure" "EXPOSED on: $pub — stop the unit and fix Bridge's listener"; bad=1; }
  fi
  exit "$bad"
fi

if [[ "$MODE" == cert ]]; then
  imap_up || { echo "Bridge is not listening on 127.0.0.1:$IMAP_PORT (run enable first)" >&2; exit 1; }
  # The certificate Bridge presents on its loopback IMAP port (STARTTLS) is the one the broker pins.
  openssl s_client -starttls imap -connect "127.0.0.1:$IMAP_PORT" -servername 127.0.0.1 </dev/null 2>/dev/null | openssl x509 -outform PEM
  exit 0
fi

if [[ "$MODE" == enable ]]; then
  (( APPLY )) || echo "(plan only — nothing changes without --apply)"
  [[ -f /etc/systemd/system/$UNIT ]] || { echo "$UNIT is not installed — run install --apply first" >&2; exit 1; }
  [[ -n "$(find "$HOME_" -mindepth 2 -path '*protonmail*' -print -quit 2>/dev/null)" ]] || { echo "no Bridge state under $HOME_ — the owner's interactive login comes first" >&2; exit 1; }
  pgrep -u "$USER_" -f "protonmail-bridge.*--cli" >/dev/null && { echo "an interactive Bridge session is still running as $USER_ — exit it first" >&2; exit 1; }
  say "enable and start $UNIT"
  run systemctl enable --now "$UNIT"
  if (( APPLY )); then
    for _ in $(seq 1 30); do imap_up && break; sleep 2; done
    imap_up && echo "  IMAP 127.0.0.1:$IMAP_PORT listening — next: sudo $0 cert" || { echo "  Bridge did not open 127.0.0.1:$IMAP_PORT — journalctl -u $UNIT" >&2; exit 1; }
  fi
  exit 0
fi

[[ "$MODE" == install ]] || { echo "unknown mode $MODE" >&2; exit 2; }
(( APPLY )) || echo "(plan only — nothing changes without --apply)"
[[ -x "$BRIDGE" ]] || { echo "Proton Mail Bridge is not installed at $BRIDGE — install Proton's signed package first (https://proton.me/support/bridge-for-linux)" >&2; exit 1; }
for b in pass gpg; do command -v "$b" >/dev/null || { echo "$b is missing — apt install pass gnupg" >&2; exit 1; }; done
[[ -f "$SRC_UNIT" ]] || { echo "unit file $SRC_UNIT not found" >&2; exit 1; }

say "1. OS user $USER_ (home $HOME_, 0700)"
id "$USER_" >/dev/null 2>&1 && echo "  (exists — left unchanged)" || run useradd --system --user-group --home-dir "$HOME_" \
  --no-create-home --shell /usr/sbin/nologin --comment "Automaton fleet Proton Mail Bridge" "$USER_"
if (( APPLY )); then [[ "$(id -nG "$USER_")" == "$USER_" ]] || { echo "$USER_ is in other groups: $(id -nG "$USER_") — refusing" >&2; exit 1; }; fi
run install -d -m 0700 -o "$USER_" -g "$USER_" "$HOME_"

say "2. keychain: GPG key + pass store, owned by $USER_ only"
if (( APPLY )) && [[ -n "$(key_fpr)" ]]; then
  echo "  (GPG key exists — kept)"
else
  printf '  %s\n' "gpg --batch --passphrase '' --quick-gen-key 'Automaton Fleet Bridge keychain <bridge@localhost>' default default never   (as $USER_)"
  if (( APPLY )); then
    as_user install -d -m 0700 "$HOME_/.gnupg"
    as_user gpg --batch --passphrase '' --quick-gen-key 'Automaton Fleet Bridge keychain <bridge@localhost>' default default never >/dev/null 2>&1
  fi
fi
if (( APPLY )); then
  fpr="$(key_fpr)"; [[ -n "$fpr" ]] || { echo "GPG key generation failed" >&2; exit 1; }
  [[ -f "$HOME_/.password-store/.gpg-id" ]] && echo "  (pass store exists — kept)" || { as_user pass init "$fpr" >/dev/null; echo "  pass init (key ${fpr: -16})"; }
else
  printf '  %s\n' "pass init <that key's fingerprint>   (as $USER_)"
fi

say "3. unit $UNIT (installed, NOT enabled until the owner's login)"
run install -m 0644 -o root -g root "$SRC_UNIT" "/etc/systemd/system/$UNIT"
run systemctl daemon-reload

say "next (owner, interactive): sudo -u $USER_ -H $BRIDGE --cli   then login / info / exit; then: sudo $0 enable --apply"
say "done$( (( APPLY )) || echo ' (plan only)')"
