#!/usr/bin/env bash
# Phase C — owner-only entry of the OpenAI tunnel runtime API key.
#
#   sudo fleet-chatgpt-tunnel-key            (run by the owner in their OWN terminal on the VPS)
#
# The key is read silently from the terminal (never echoed, never in argv,
# environment files, shell history or logs) and written atomically to
# /etc/automaton-fleet/chatgpt-tunnel/openai-api-key (root 0600, directory
# root 0700). Only the tunnel unit receives it, through systemd LoadCredential.
# The script then (re)starts the tunnel and reports whether OpenAI accepted the
# key — from the tunnel's own log classification, without printing the key or
# raw log lines. Refuses to run without a terminal (so the key cannot come
# from a pipe, a file, or an AI session's command runner).
set -euo pipefail
DIR=/etc/automaton-fleet/chatgpt-tunnel
KEY="$DIR/openai-api-key"
UNIT=automaton-fleet-chatgpt-tunnel.service

[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }
[[ -t 0 && -t 1 ]] || { echo "refusing: run this in your own interactive terminal (stdin/stdout must be a TTY)" >&2; exit 2; }
[[ -d "$DIR" && ! -L "$DIR" && "$(stat -c '%U:%G %a' "$DIR")" == "root:root 700" ]] || { echo "refusing: $DIR must be a root:root 0700 directory" >&2; exit 1; }
[[ -f "$DIR/tunnel.env" ]] || { echo "refusing: $DIR/tunnel.env (tunnel id) is missing" >&2; exit 1; }

umask 077
set +x
IFS= read -rs -p "OpenAI runtime API key (input hidden): " K </dev/tty
echo
if [[ ! "$K" =~ ^sk-[A-Za-z0-9_-]{20,300}$ ]]; then
  unset K
  echo "That does not look like an OpenAI API key (sk-…). Nothing was written." >&2
  exit 1
fi
TMP="$(mktemp "$KEY.XXXXXX")"
printf '%s' "$K" > "$TMP"
unset K
chown root:root "$TMP"; chmod 0600 "$TMP"
mv -f "$TMP" "$KEY"
echo "Stored $KEY (root 0600). The key was not displayed or logged."

START="$(date --iso-8601=seconds)"
systemctl restart "$UNIT"
echo "Tunnel restarted; checking the connection to OpenAI (up to 40 s)…"
verdict="connected"
for _ in $(seq 1 20); do
  sleep 2
  log="$(journalctl -u "$UNIT" --since "$START" --no-pager -o cat 2>/dev/null || true)"
  if grep -q 'status 401' <<<"$log"; then verdict="rejected: OpenAI returned 401 (key invalid or revoked)"; break; fi
  if grep -q 'status 403' <<<"$log"; then verdict="rejected: OpenAI returned 403 (the key's owner lacks Tunnels Read + Use)"; break; fi
  if grep -q 'status 404' <<<"$log"; then verdict="rejected: OpenAI returned 404 (tunnel id not found for this organization)"; break; fi
  systemctl is-active --quiet "$UNIT" || { verdict="the tunnel service stopped (see: journalctl -u $UNIT)"; break; }
done
echo "Result: $verdict"
[[ "$verdict" == connected ]]
