#!/usr/bin/env bash
# Phase C — owner-only entry of the OpenAI tunnel runtime API key.
#
#   sudo fleet-chatgpt-tunnel-key            (run by the owner in their OWN terminal on the VPS)
#
# Secret handling:
#  - read silently from the terminal (never echoed; refuses to run without a TTY,
#    so the key cannot come from a pipe, a file or an AI session's command runner);
#  - never placed in argv, the environment, shell history, logs or the repository;
#  - stored atomically in /etc/automaton-fleet/chatgpt-tunnel/openai-api-key
#    (root 0600, directory root 0700); only the tunnel unit receives it, via
#    systemd LoadCredential.
#
# Validation: no local format allowlist (OpenAI key formats change). Local checks
# are only paste hygiene — strip bracketed-paste markers, CR and surrounding
# whitespace; require printable ASCII without internal whitespace, 20..4096
# characters. The authority is OpenAI itself: the tunnel is restarted with the
# new key and the result is read from THAT unit invocation's own log:
#   "tunnel metadata fetched"  -> accepted (authenticated and authorised for this tunnel)
#   status 401 / 403 / 404     -> rejected (key / permission / tunnel id)
# On rejection or no verdict within the time limit, the previous key (if any)
# is restored — or the new one removed and the tunnel stopped. Only a verdict
# is printed; never the key, part of it, or raw log lines.
set -euo pipefail
export LC_ALL=C

readonly DIR=/etc/automaton-fleet/chatgpt-tunnel
readonly UNIT=automaton-fleet-chatgpt-tunnel.service
readonly KEY="$DIR/openai-api-key"
readonly WAIT_S=60
readonly PASTE_START=$'\e[200~' PASTE_END=$'\e[201~' CR=$'\r'

# Normalise one pasted line: drop bracketed-paste markers and CR, trim spaces/tabs.
normalize_key() {
  local k="$1"
  k="${k//"$PASTE_START"/}"
  k="${k//"$PASTE_END"/}"
  k="${k//"$CR"/}"
  k="${k#"${k%%[![:space:]]*}"}"
  k="${k%"${k##*[![:space:]]}"}"
  printf '%s' "$k"
}

# Paste hygiene only (not a key-format allowlist). Prints a category, never content.
hygiene_problem() {
  local k="$1"
  if [[ ${#k} -lt 20 ]]; then echo "too short (${#k} characters)"; return 0; fi
  if [[ ${#k} -gt 4096 ]]; then echo "too long (${#k} characters)"; return 0; fi
  if [[ ! "$k" =~ ^[!-~]+$ ]]; then echo "contains spaces, control or non-ASCII characters"; return 0; fi
  return 1
}

# Classify the tunnel's log for one systemd invocation: accepted|401|403|404|pending
classify_log() {
  local log="$1"
  if grep -q 'status 401' <<<"$log"; then echo 401; return; fi
  if grep -q 'status 403' <<<"$log"; then echo 403; return; fi
  if grep -q 'status 404' <<<"$log"; then echo 404; return; fi
  if grep -q '"tunnel metadata fetched"' <<<"$log"; then echo accepted; return; fi
  echo pending
}

TTY_STATE=""
STAGED=0
COMMITTED=0
PREV=""

# Undo a staged key: restore the previous one (and restart), or remove it and stop the tunnel.
rollback() {
  if [[ -n "$PREV" && -f "$PREV" ]]; then
    mv -f "$PREV" "$KEY"
    systemctl reset-failed "$UNIT" 2>/dev/null || true
    systemctl restart "$UNIT" 2>/dev/null || true
    echo restored
  else
    rm -f "$KEY"
    systemctl stop "$UNIT" 2>/dev/null || true
    echo removed
  fi
}

# Runs on EVERY exit: terminal restored; a staged but unverified key never survives.
on_exit() {
  [[ -n "$TTY_STATE" ]] && stty "$TTY_STATE" <&3 2>/dev/null || true
  if [[ "$STAGED" == 1 && "$COMMITTED" == 0 ]]; then
    local what
    what="$(rollback)"
    echo "Aborted before OpenAI accepted the key; the key was $what." >&2
  fi
}

main() {
  [[ -t 0 && -t 1 ]] || { echo "refusing: run this in your own interactive terminal (stdin/stdout must be a TTY)" >&2; exit 2; }
  [[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }
  [[ -d "$DIR" && ! -L "$DIR" && "$(stat -c '%U:%G %a' "$DIR")" == "root:root 700" ]] || { echo "refusing: $DIR must be a root:root 0700 directory" >&2; exit 1; }
  [[ -f "$DIR/tunnel.env" ]] || { echo "refusing: $DIR/tunnel.env (tunnel id) is missing" >&2; exit 1; }

  umask 077
  set +x
  local raw K why junk
  # Echo off at once, and drop anything typed/pasted before the prompt: such
  # typeahead would already have been echoed by the terminal (and could be
  # in its scrollback), so it is never used. Terminal state is always restored.
  exec 3</dev/tty
  TTY_STATE="$(stty -g <&3)"
  trap on_exit EXIT
  trap 'exit 130' INT TERM HUP
  stty -echo <&3
  while IFS= read -r -t 0.2 -u 3 junk; do :; done
  unset junk
  IFS= read -rs -u 3 -p "OpenAI runtime API key (input hidden; paste AFTER this prompt): " raw
  echo
  K="$(normalize_key "$raw")"
  unset raw
  if why="$(hygiene_problem "$K")"; then
    unset K
    echo "The input was not stored: it is $why. Paste the key exactly once and press Enter." >&2
    exit 1
  fi

  local tmp
  if [[ -f "$KEY" ]]; then PREV="$(mktemp "$DIR/.prev.XXXXXX")"; cp -p "$KEY" "$PREV"; fi
  tmp="$(mktemp "$KEY.XXXXXX")"
  printf '%s' "$K" > "$tmp"
  unset K
  chown root:root "$tmp"; chmod 0600 "$tmp"
  STAGED=1
  mv -f "$tmp" "$KEY"

  echo "Key stored (root 0600, not displayed). Verifying it with OpenAI through the tunnel (up to ${WAIT_S} s)…"
  # Owner-initiated: clear earlier failures/start-limit counters so the check can run.
  systemctl reset-failed "$UNIT" "${UNIT%.service}.path" 2>/dev/null || true
  systemctl restart "$UNIT" 2>/dev/null || true
  local inv verdict="pending" log
  inv="$(systemctl show -p InvocationID --value "$UNIT" 2>/dev/null || true)"
  for _ in $(seq 1 "$WAIT_S"); do
    [[ -n "$inv" ]] || { verdict=stopped; break; }
    sleep 1
    log="$(journalctl --no-pager -o cat "_SYSTEMD_INVOCATION_ID=$inv" 2>/dev/null || true)"
    verdict="$(classify_log "$log")"
    [[ "$verdict" == pending ]] || break
    systemctl is-active --quiet "$UNIT" || { verdict=stopped; break; }
  done

  if [[ "$verdict" == accepted ]]; then
    COMMITTED=1
    STAGED=0
    [[ -n "$PREV" ]] && rm -f "$PREV"
    echo "Result: accepted — OpenAI authenticated the key for this tunnel; the tunnel is connected."
    exit 0
  fi
  case "$verdict" in
    401) msg="OpenAI rejected the key (401: invalid or revoked key)" ;;
    403) msg="OpenAI refused (403: the key's owner lacks Tunnels Read + Use for this tunnel)" ;;
    404) msg="OpenAI refused (404: tunnel id not found for this key's organization)" ;;
    stopped) msg="the tunnel service stopped before a verdict" ;;
    *) msg="no verdict from OpenAI within ${WAIT_S} s (network or service problem)" ;;
  esac
  local outcome
  outcome="$(rollback)"
  STAGED=0 # rollback ran in a subshell; the EXIT trap must not undo it a second time
  if [[ "$outcome" == restored ]]; then
    echo "Result: NOT accepted — $msg. The previous key was restored." >&2
  else
    echo "Result: NOT accepted — $msg. Nothing was kept; the tunnel is stopped." >&2
  fi
  exit 1
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
