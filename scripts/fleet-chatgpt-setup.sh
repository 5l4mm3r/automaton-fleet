#!/usr/bin/env bash
# Phase C — provision the ChatGPT adapter and tunnel on the controller host.
#
#   sudo scripts/fleet-chatgpt-setup.sh prepare --tunnel-client-zip <zip> [--apply]
#       users, directories, verified tunnel-client install, adapter token,
#       bridge-chatgpt signing key (generated as the adapter user; prints only
#       the PUBLIC key and key id), systemd units (installed, not started)
#   (operator)  pnpm fleet:admin operator-enroll bridge-chatgpt bridge_chatgpt \
#                   --scopes ops.read.status,ops.read.agents --public-key <pub> --expires-days 30
#   sudo scripts/fleet-chatgpt-setup.sh configure <principalId> [--apply]
#       writes /etc/automaton-fleet/chatgpt-adapter.json (root:adapter 0640),
#       enables + starts the adapter socket and service
#
# Never prints a secret. Never starts the tunnel: that needs the owner's OpenAI
# tunnel id and runtime API key (see the Phase C design, "Owner actions").
# Without --apply it only prints what it would do.
set -euo pipefail
MODE="${1:?usage: prepare --tunnel-client-zip <zip> [--apply] | configure <principalId> [--apply]}"
shift
APPLY=0; ZIP=""; PRINCIPAL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --tunnel-client-zip) ZIP="${2:?}"; shift ;;
    op_*) PRINCIPAL="$1" ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ETC=/etc/automaton-fleet
ADAPTER=automaton-fleet-chatgpt-adapter
TUNNEL=automaton-fleet-chatgpt-tunnel
NODE=/opt/automaton-fleet/node/bin/node
ADAPTER_TREE=/opt/automaton-fleet/chatgpt-adapter/current
KEY=/var/lib/$ADAPTER/bridge-chatgpt.key
TC_VERSION=v0.0.14
TC_ZIP_SHA256=29d29cf860ada54e4d3c82c715f4fbfcff2abcdc2584c0fc26431308dfa2505b
TC_BIN_SHA256=94ae9d0c024753d1b79669152e968eb5d0faaad1e04ccf6c37750d7a3e175c77
TC_DIR=/opt/automaton-fleet/tunnel-client/$TC_VERSION

say() { printf '\n# %s\n' "$*"; }
run() { printf '  %s\n' "$*"; if (( APPLY )); then "$@"; fi; }
(( APPLY )) && echo "APPLYING ChatGPT adapter setup ($MODE)" || echo "DRY RUN ($MODE) — nothing will change. Re-run with --apply."

case "$MODE" in
  prepare)
    [[ -n "$ZIP" && -f "$ZIP" ]] || { echo "--tunnel-client-zip <verified release zip> is required" >&2; exit 2; }
    [[ "$(sha256sum < "$ZIP" | cut -c1-64)" == "$TC_ZIP_SHA256" ]] || { echo "tunnel-client zip sha256 mismatch" >&2; exit 1; }
    [[ -d "$ADAPTER_TREE/dist/fleet/chatgpt-adapter" ]] || { echo "adapter artifact not installed ($ADAPTER_TREE); run fleet-deploy-chatgpt-adapter.sh first" >&2; exit 1; }

    say "1. Service users (system, nologin, own group only)"
    id "$ADAPTER" >/dev/null 2>&1 || run useradd --system --user-group --home-dir "/var/lib/$ADAPTER" --no-create-home --shell /usr/sbin/nologin --comment "Automaton fleet ChatGPT adapter" "$ADAPTER"
    id "$TUNNEL" >/dev/null 2>&1 || run useradd --system --user-group --home-dir "/var/lib/$TUNNEL" --no-create-home --shell /usr/sbin/nologin --comment "Automaton fleet ChatGPT tunnel client" "$TUNNEL"

    say "2. Directories"
    run install -d -m 0700 -o root -g root "$ETC/chatgpt-tunnel"
    run install -d -m 0700 -o "$ADAPTER" -g "$ADAPTER" "/var/lib/$ADAPTER"

    say "3. tunnel-client $TC_VERSION (zip and binary sha256 pinned)"
    if [[ ! -x "$TC_DIR/tunnel-client-runtime" ]]; then
      TMP="$(mktemp -d)"
      run unzip -q -o "$ZIP" tunnel-client-runtime LICENSE NOTICE -d "$TMP"
      if (( APPLY )); then [[ "$(sha256sum < "$TMP/tunnel-client-runtime" | cut -c1-64)" == "$TC_BIN_SHA256" ]] || { echo "binary sha256 mismatch" >&2; exit 1; }; fi
      run install -d -m 0755 -o root -g root "$TC_DIR"
      run install -m 0755 -o root -g root "$TMP/tunnel-client-runtime" "$TC_DIR/tunnel-client-runtime"
      run install -m 0644 -o root -g root "$TMP/LICENSE" "$TMP/NOTICE" "$TC_DIR/"
      rm -rf "$TMP"
    else
      [[ "$(sha256sum < "$TC_DIR/tunnel-client-runtime" | cut -c1-64)" == "$TC_BIN_SHA256" ]] || { echo "installed tunnel-client sha256 mismatch" >&2; exit 1; }
      echo "  (installed, sha256 verified)"
    fi

    say "4. Adapter token (tunnel-client -> adapter static header; root 0600, never printed)"
    if [[ ! -f "$ETC/chatgpt-tunnel/adapter-token" ]]; then
      if (( APPLY )); then
        umask 077
        head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' > "$ETC/chatgpt-tunnel/adapter-token.tmp"
        chown root:root "$ETC/chatgpt-tunnel/adapter-token.tmp"; chmod 0600 "$ETC/chatgpt-tunnel/adapter-token.tmp"
        mv "$ETC/chatgpt-tunnel/adapter-token.tmp" "$ETC/chatgpt-tunnel/adapter-token"
      fi
      echo "  generate $ETC/chatgpt-tunnel/adapter-token (32 random bytes, base64url)"
    else
      echo "  (exists — left unchanged)"
    fi

    say "5. bridge-chatgpt signing key (generated AS the adapter user; stays in /var/lib/$ADAPTER)"
    if [[ ! -f "$KEY" ]]; then
      if (( APPLY )); then
        runuser -u "$ADAPTER" -- "$NODE" "$ADAPTER_TREE/dist/fleet/operator/keygen.js" "$KEY"
      else
        echo "  runuser -u $ADAPTER -- node $ADAPTER_TREE/dist/fleet/operator/keygen.js $KEY"
      fi
    else
      echo "  (exists — its public key and key id:)"
      runuser -u "$ADAPTER" -- "$NODE" --input-type=module -e "import {loadOperatorPrivateKey} from '$ADAPTER_TREE/dist/fleet/operator/keygen.js'; import {keyIdOf, rawPublicKey} from '$ADAPTER_TREE/dist/fleet/operator/canonical.js'; const r = rawPublicKey(loadOperatorPrivateKey('$KEY')); console.log(JSON.stringify({ publicKey: r.toString('base64url'), keyId: keyIdOf(r) }))"
    fi

    say "6. systemd units (installed, NOT enabled or started)"
    run install -m 0644 -o root -g root "$REPO/deploy/systemd/$ADAPTER.socket" "/etc/systemd/system/$ADAPTER.socket"
    run install -m 0644 -o root -g root "$REPO/deploy/systemd/$ADAPTER.service" "/etc/systemd/system/$ADAPTER.service"
    run install -m 0644 -o root -g root "$REPO/deploy/systemd/$TUNNEL.service" "/etc/systemd/system/$TUNNEL.service"
    run install -m 0644 -o root -g root "$REPO/deploy/systemd/$TUNNEL.path" "/etc/systemd/system/$TUNNEL.path"
    run install -m 0755 -o root -g root "$REPO/scripts/fleet-chatgpt-tunnel-key.sh" /usr/local/sbin/fleet-chatgpt-tunnel-key
    run systemctl daemon-reload
    echo
    echo "Next: enrol the PUBLIC key printed above (operator, admin credential):"
    echo "  pnpm fleet:admin operator-enroll bridge-chatgpt bridge_chatgpt --scopes ops.read.status,ops.read.agents --public-key <publicKey> --expires-days 30"
    echo "then: sudo scripts/fleet-chatgpt-setup.sh configure <principalId> --apply"
    ;;

  configure)
    [[ "$PRINCIPAL" =~ ^op_[0-9A-HJKMNP-TV-Z]{26}$ ]] || { echo "configure <op_ principal id>" >&2; exit 2; }
    [[ -f "$KEY" && -f "$ETC/chatgpt-tunnel/adapter-token" ]] || { echo "run prepare --apply first" >&2; exit 1; }
    KEYID="$(runuser -u "$ADAPTER" -- "$NODE" --input-type=module -e "import {loadOperatorPrivateKey} from '$ADAPTER_TREE/dist/fleet/operator/keygen.js'; import {keyIdOf, rawPublicKey} from '$ADAPTER_TREE/dist/fleet/operator/canonical.js'; console.log(keyIdOf(rawPublicKey(loadOperatorPrivateKey('$KEY'))))")"
    [[ "$KEYID" =~ ^[0-9a-f]{32}$ ]] || { echo "could not derive the key id" >&2; exit 1; }
    TOKSHA="$(sha256sum < "$ETC/chatgpt-tunnel/adapter-token" | cut -c1-64)"
    say "1. $ETC/chatgpt-adapter.json (root:$ADAPTER 0640; public identities + token digest only)"
    CFG="$(printf '{\n  "version": 1,\n  "principalId": "%s",\n  "keyFile": "%s",\n  "keyId": "%s",\n  "operator": { "port": 8788, "user": "automaton-fleet-operator-api" },\n  "tunnelTokenSha256": "%s",\n  "limits": { "callsPerMinute": 30, "burst": 10, "maxQueued": 4 }\n}\n' "$PRINCIPAL" "$KEY" "$KEYID" "$TOKSHA")"
    echo "$CFG" | sed 's/^/    /'
    if (( APPLY )); then
      umask 027
      printf '%s' "$CFG" > "$ETC/chatgpt-adapter.json.tmp"
      chown root:"$ADAPTER" "$ETC/chatgpt-adapter.json.tmp"; chmod 0640 "$ETC/chatgpt-adapter.json.tmp"
      mv "$ETC/chatgpt-adapter.json.tmp" "$ETC/chatgpt-adapter.json"
    fi
    say "2. Start the adapter (socket + service); the tunnel stays off until the owner adds the OpenAI credentials"
    run systemctl enable --now "$ADAPTER.socket"
    run systemctl enable --now "$ADAPTER.service"
    run systemctl enable "$TUNNEL.service"
    run systemctl enable --now "$TUNNEL.path"
    ;;
  *) echo "usage: prepare --tunnel-client-zip <zip> [--apply] | configure <principalId> [--apply]" >&2; exit 2 ;;
esac
