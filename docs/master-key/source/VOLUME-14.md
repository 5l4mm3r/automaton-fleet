# SOURCE VOLUME 14 — Scripts, deploy assets, build configuration

Exact, byte-for-byte text of each file at repository commit `efad2148a3460ab881b0ab845fb13c25d1fa3e74` (branch fleet-development).
No file in this volume contains a real secret; test fixtures generate synthetic secrets at runtime.
Each file's SHA-256 is of the file bytes on disk and matches 22-RECONSTRUCTION-MANIFEST.md.

## Files

- `scripts/fleet-build-runtime.sh` — 32 lines, sha256 `1d3bba87eb427e1c8b006e858a939694b51224ec3c003a54f1501da9b71031bc`
- `scripts/fleet-chatgpt-setup.sh` — 135 lines, sha256 `4ce1eadb0d4edc5316830b2067bb5b48b175524ef94de0a07d71b7ce7e1b214d`
- `scripts/fleet-chatgpt-tunnel-key.sh` — 170 lines, sha256 `9c8ff3d69423a1f3898c1de2b4266798d2fff38f675e510714d51c99be5570ff`
- `scripts/fleet-db-roles.sql` — 91 lines, sha256 `fa80e6add2b8e48d39ca0c28f9c22a27d91c1cd4b0ef02c591fcccc4d5c32d95`
- `scripts/fleet-db-setup.sh` — 48 lines, sha256 `15fc1b23843a2a6a4584a76286338c0b16397dd8bd32f7ca7e7a567a33152d76`
- `scripts/fleet-deploy-chatgpt-adapter.sh` — 70 lines, sha256 `60bdca449e266ec50baeddcfe3a69b9dc1b76b44dfa59c407b2230a17ad28d11`
- `scripts/fleet-deploy-release.sh` — 79 lines, sha256 `50d03dbe5440095dbb866b4c4d12d31049b0caf6c5576b06a057048189ee084f`
- `scripts/fleet-os-setup.sh` — 158 lines, sha256 `df7919ad313401cdeb1871e41d5a60aa259ef13ec6fd6d376681778980cd795d`
- `scripts/fleet-verify-deployment.sh` — 185 lines, sha256 `80e80a37784151ec5ecb241ce23f221a7aa145c44fdbb8edd508cba884e9b641`
- `deploy/etc/admin.env.example` — 4 lines, sha256 `57927daa1f938bf8f19c1834e89715f5c69f3df81473d5fd898e6b2ac074b5b8`
- `deploy/etc/operator.env.example` — 8 lines, sha256 `f72d6f55d6925ee9c31b1909b4a5986fb2735ff4c246a8cbf1b2c273d5d8912b`
- `deploy/etc/runtime.env.example` — 35 lines, sha256 `5fa32c4dcc4a3a1cbd038c34c7558e0642e554d5e04cfa2b9b36ab27286aca70`
- `deploy/etc/service.env.example` — 5 lines, sha256 `24acb2e6c6171df9661ff65b352a64321d1b3266b4d6015c694cc71d1ddbd931`
- `deploy/firewall/fleet-firewall.sh` — 27 lines, sha256 `2ddf4372715b1c7230dd06299f4d6366d6ccd8df27264a70b6cb00ced695f1f5`
- `deploy/logrotate/automaton-fleet` — 29 lines, sha256 `6709a5401923f28fde0ca16478d460e62877a31edb7e1eecdceb559ac18f9238`
- `deploy/systemd/automaton-agent.service` — 48 lines, sha256 `e8f90f6dc23bb046419da45dcc66c900a5fb5e70f25c3b136c12f0dd9669205a`
- `deploy/systemd/automaton-fleet-chatgpt-adapter.service` — 79 lines, sha256 `331a1422269b5248d9b3a4949dc83b37dba33865abb1e0eeb74906d32c4d54d7`
- `deploy/systemd/automaton-fleet-chatgpt-adapter.socket` — 22 lines, sha256 `1ef46f613e5d7577f8768b49b81284cf63cf406c9716f1c9bd52be8d4dc3eb67`
- `deploy/systemd/automaton-fleet-chatgpt-tunnel.path` — 12 lines, sha256 `69098a0b01906c4b6e90630a65dd64c03be4ff1fd642889df10a4cfbc2555d07`
- `deploy/systemd/automaton-fleet-chatgpt-tunnel.service` — 90 lines, sha256 `8f2888c4d0b616e23e9e86adbd3721591e826a81b7be0941df50c81a4d04d7fd`
- `deploy/systemd/automaton-fleet-operator-api.service` — 86 lines, sha256 `5f2454cf37accbba401eb5d624561d449360e88b622fe75c7db8789457b2d871`
- `deploy/systemd/automaton-fleet-witness.service` — 85 lines, sha256 `b3447b8c26445f21dce2929ebd65dcd57fae6ae6a1eab22a22b343174e008b58`
- `deploy/systemd/automaton-fleet.service` — 93 lines, sha256 `388f78e9b59bc9d4f7882d080eef2131448078189693c5533c4591428679d760`
- `deploy/systemd/automaton-fleet.service.d/remote.conf.example` — 26 lines, sha256 `a90d9f396efdb8dee08a73cee2c914dacd65b7f84d8ebcc671416366a41991e2`
- `package.json` — 107 lines, sha256 `ca91918749e59afc5ee68cad9b9ebe5ab9d615a2c7ebe7ecacb0546d89713165`
- `pnpm-workspace.yaml` — 2 lines, sha256 `0fb360452b0231d114d0b0ad6cc76bb48fe528382f55827cf93739bf64ec79e1`
- `tsconfig.json` — 20 lines, sha256 `7a9a7c36771fcaaf2ca0f10ce03590d9d1b4e5957b67452630853cbc6184bd57`
- `vitest.config.ts` — 25 lines, sha256 `f85ee8f218fec8c42fd1dd6e1653d63956cae42ece05ed2286404f7a852d6c44`
- `.gitignore` — 14 lines, sha256 `aa30d8abf33a7728dc3e3040eecf588bb90af3753d637b3af6da35829abc466d`

## `scripts/fleet-build-runtime.sh`

sha256 `1d3bba87eb427e1c8b006e858a939694b51224ec3c003a54f1501da9b71031bc` · 1469 bytes · 32 lines

```bash
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
```

## `scripts/fleet-chatgpt-setup.sh`

sha256 `4ce1eadb0d4edc5316830b2067bb5b48b175524ef94de0a07d71b7ce7e1b214d` · 8517 bytes · 135 lines

```bash
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
```

## `scripts/fleet-chatgpt-tunnel-key.sh`

sha256 `9c8ff3d69423a1f3898c1de2b4266798d2fff38f675e510714d51c99be5570ff` · 6871 bytes · 170 lines

```bash
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
```

## `scripts/fleet-db-roles.sql`

sha256 `fa80e6add2b8e48d39ca0c28f9c22a27d91c1cd4b0ef02c591fcccc4d5c32d95` · 6171 bytes · 91 lines

```sql
-- Fleet database role bootstrap (Phase 4). Idempotent: safe to re-run.
-- Run as a PostgreSQL superuser. The fleet owner (e.g. fleetadmin) cannot
-- create roles. Normally invoked by scripts/fleet-db-setup.sh, which feeds
-- the passwords on stdin so they never appear in a process command line:
--
--   { printf '\set agent_password %s\n\set service_password %s\n\set operator_password %s\n' "$AGENT_PW" "$SERVICE_PW" "$OPERATOR_PW"
--     cat scripts/fleet-db-roles.sql; } |
--   sudo -u postgres psql -X -v ON_ERROR_STOP=1 -v dbname=automaton_fleet -v owner=fleetadmin -f -
--
-- Passwords must be hex (openssl rand -hex 32). Each run (re)sets them to
-- the values supplied, so the secret files stay the source of truth.
--
-- Role model
--   :owner               fleet_admin: owns schema "fleet" and every object in it.
--                        Migrations and operator CLI only (FLEET_ADMIN_DATABASE_URL).
--   fleet_service        NOLOGIN group: USAGE on fleet, SELECT on non-secret tables,
--                        EXECUTE on fleet.svc_* (granted by `pnpm fleet:migrate`).
--   fleet_service_login  LOGIN member of fleet_service. Held by the fleet service only
--                        (FLEET_SERVICE_DATABASE_URL).
--   fleet_agent          NOLOGIN group: USAGE on fleet + EXECUTE on fleet.api_* (granted by migrate).
--   fleet_agent_login    LOGIN member of fleet_agent. Held by the fleet service only, for
--                        agent-scoped calls (FLEET_AGENT_DATABASE_URL). Agents get no DB credential.
--   fleet_operator       NOLOGIN group (schema v8): USAGE on fleet + EXECUTE on the read-only
--                        op_* functions only (granted by `pnpm fleet:migrate`).
--   fleet_operator_login LOGIN member of fleet_operator. Held by the Operator API process only
--                        (FLEET_OPERATOR_DATABASE_URL in operator.env). Never an admin credential.

\set ON_ERROR_STOP on
-- Keep the ALTER ROLE ... PASSWORD statements below out of the server log
-- (session-level; this session is a superuser). Statement text can still
-- reach extensions such as pg_stat_statements if installed.
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
SET log_min_duration_statement = -1;

SELECT 'CREATE ROLE fleet_agent NOLOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleet_agent') \gexec
SELECT 'CREATE ROLE fleet_agent_login LOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleet_agent_login') \gexec
SELECT 'CREATE ROLE fleet_service NOLOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleet_service') \gexec
SELECT 'CREATE ROLE fleet_service_login LOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleet_service_login') \gexec
SELECT 'CREATE ROLE fleet_operator NOLOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleet_operator') \gexec
SELECT 'CREATE ROLE fleet_operator_login LOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleet_operator_login') \gexec

-- (Re)assert attributes every run, so a drifted role is corrected.
ALTER ROLE fleet_agent         NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE fleet_service       NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE fleet_agent_login   LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 32;
ALTER ROLE fleet_service_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 16;
ALTER ROLE fleet_operator       NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE fleet_operator_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8;
SELECT format('ALTER ROLE fleet_agent_login PASSWORD %L', :'agent_password') \gexec
SELECT format('ALTER ROLE fleet_service_login PASSWORD %L', :'service_password') \gexec
SELECT format('ALTER ROLE fleet_operator_login PASSWORD %L', :'operator_password') \gexec

GRANT fleet_agent TO fleet_agent_login;
GRANT fleet_service TO fleet_service_login;
GRANT fleet_operator TO fleet_operator_login;

-- The restricted logins must never be members of the owner or of each other.
SELECT format('REVOKE %I FROM %I', r.rolname, m.rolname)
  FROM pg_auth_members am
  JOIN pg_roles r ON r.oid = am.roleid
  JOIN pg_roles m ON m.oid = am.member
 WHERE m.rolname IN ('fleet_agent_login', 'fleet_service_login', 'fleet_agent', 'fleet_service', 'fleet_operator_login', 'fleet_operator')
   AND NOT (m.rolname = 'fleet_agent_login' AND r.rolname = 'fleet_agent')
   AND NOT (m.rolname = 'fleet_service_login' AND r.rolname = 'fleet_service')
   AND NOT (m.rolname = 'fleet_operator_login' AND r.rolname = 'fleet_operator') \gexec

-- Only the owner and the two logins may connect; only the owner gets TEMP
-- (no temporary objects that could shadow names) and nobody else gets CREATE.
REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
REVOKE ALL ON DATABASE :"dbname" FROM fleet_agent, fleet_agent_login, fleet_service, fleet_service_login, fleet_operator, fleet_operator_login;
GRANT CONNECT ON DATABASE :"dbname" TO fleet_agent_login, fleet_service_login, fleet_operator_login;
GRANT CONNECT, TEMPORARY ON DATABASE :"dbname" TO :"owner";

\connect :"dbname"
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER ROLE fleet_agent_login IN DATABASE :"dbname" SET statement_timeout = '10s';
ALTER ROLE fleet_agent_login IN DATABASE :"dbname" SET lock_timeout = '5s';
ALTER ROLE fleet_agent_login IN DATABASE :"dbname" SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE fleet_service_login IN DATABASE :"dbname" SET statement_timeout = '15s';
ALTER ROLE fleet_service_login IN DATABASE :"dbname" SET lock_timeout = '5s';
ALTER ROLE fleet_service_login IN DATABASE :"dbname" SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE fleet_operator_login IN DATABASE :"dbname" SET statement_timeout = '5s';
ALTER ROLE fleet_operator_login IN DATABASE :"dbname" SET lock_timeout = '2s';
ALTER ROLE fleet_operator_login IN DATABASE :"dbname" SET idle_in_transaction_session_timeout = '10s';
```

## `scripts/fleet-db-setup.sh`

sha256 `15fc1b23843a2a6a4584a76286338c0b16397dd8bd32f7ca7e7a567a33152d76` · 2937 bytes · 48 lines

```bash
#!/usr/bin/env bash
# Fleet Phase 4 — PostgreSQL roles (superuser step). Idempotent.
#
#   sudo scripts/fleet-db-setup.sh            # DRY RUN: prints what will run, changes nothing
#   sudo scripts/fleet-db-setup.sh --apply    # runs scripts/fleet-db-roles.sql as postgres
#
# Passwords are taken from /etc/automaton-fleet/service.env and (schema v8)
# /etc/automaton-fleet/operator.env (both written by fleet-os-setup.sh) and
# fed to psql on STDIN via \set, so they never appear
# in any process command line or in shell history. After this, the operator
# (not root) runs the admin-credential steps:
#
#   pnpm fleet:migrate              # v1 -> v3; refuses non-owner credentials; grants agent + service roles
#   pnpm fleet:audit-privileges     # must PASS
#   pnpm fleet:doctor
set -euo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_ENV=/etc/automaton-fleet/service.env
OPERATOR_ENV=/etc/automaton-fleet/operator.env
DB_NAME="${FLEET_DB_NAME:-automaton_fleet}"
DB_OWNER="${FLEET_DB_OWNER:-fleetadmin}"
[[ -f "$SERVICE_ENV" ]] || { echo "$SERVICE_ENV missing — run scripts/fleet-os-setup.sh --apply first" >&2; exit 1; }
[[ -f "$OPERATOR_ENV" && ! -L "$OPERATOR_ENV" ]] || { echo "$OPERATOR_ENV missing — run scripts/fleet-os-setup.sh --apply first (schema v8 Operator API role)" >&2; exit 1; }

pw_of() { # pw_of <KEY> <file>: the password of a login role from its DSN
  sed -n "s#^$1=postgresql://[^:]*:\([0-9a-f]\{64\}\)@.*#\1#p" "$2" | head -1
}
SERVICE_PW="$(pw_of FLEET_SERVICE_DATABASE_URL "$SERVICE_ENV")"
AGENT_PW="$(pw_of FLEET_AGENT_DATABASE_URL "$SERVICE_ENV")"
OPERATOR_PW="$(pw_of FLEET_OPERATOR_DATABASE_URL "$OPERATOR_ENV")"
[[ -n "$SERVICE_PW" && -n "$AGENT_PW" ]] || { echo "service.env must hold 64-hex passwords for both DSNs" >&2; exit 1; }
[[ -n "$OPERATOR_PW" ]] || { echo "operator.env must hold a 64-hex password for FLEET_OPERATOR_DATABASE_URL" >&2; exit 1; }

echo "Will run as the postgres superuser (passwords via stdin, not shown):"
echo "  { printf '\\set agent_password <hex>\\n\\set service_password <hex>\\n\\set operator_password <hex>\\n'; cat $REPO/scripts/fleet-db-roles.sql; } |"
echo "    runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -v dbname=$DB_NAME -v owner=$DB_OWNER -d postgres -f -"
if (( APPLY )); then
  { printf '\\set agent_password %s\n\\set service_password %s\n\\set operator_password %s\n' "$AGENT_PW" "$SERVICE_PW" "$OPERATOR_PW"; cat "$REPO/scripts/fleet-db-roles.sql"; } |
    runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -v dbname="$DB_NAME" -v owner="$DB_OWNER" -d postgres -f -
  echo "Roles applied. Next (as $DB_OWNER operator, not root): pnpm fleet:migrate && pnpm fleet:audit-privileges && pnpm fleet:doctor"
else
  echo "DRY RUN — nothing changed. Re-run with --apply after approval."
fi
unset SERVICE_PW AGENT_PW OPERATOR_PW
```

## `scripts/fleet-deploy-chatgpt-adapter.sh`

sha256 `60bdca449e266ec50baeddcfe3a69b9dc1b76b44dfa59c407b2230a17ad28d11` · 4447 bytes · 70 lines

```bash
#!/usr/bin/env bash
# Phase C — build and install the pinned ChatGPT adapter artifact.
#
#   scripts/fleet-deploy-chatgpt-adapter.sh build <commit> <buildId> <lockfileSha256>   # as the operator (no sudo)
#   sudo scripts/fleet-deploy-chatgpt-adapter.sh install <commit>                       # root: copy, re-verify, switch
#
# The adapter runs from its OWN release tree, /opt/automaton-fleet/chatgpt-adapter/
# releases/<commit> (root-owned, read-only), selected by the "current" symlink
# there. It never touches /opt/automaton-fleet/releases, /opt/automaton-fleet/
# current or runtime.env: the FleetController / Operator API runtime identity is
# unchanged. The build is the same reproducible procedure as the runtime
# (fresh clone of the pinned commit from the fork, lockfile hash checked before
# install, frozen install, build, build-identity must equal the expected pins).
set -euo pipefail
MODE="${1:?usage: build <commit> <buildId> <lockfileSha256> | install <commit>}"
COMMIT="${2:?commit}"
REPO_URL="https://github.com/5l4mm3r/automaton-fleet.git"
OPT=/opt/automaton-fleet/chatgpt-adapter
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "commit must be a full 40-hex SHA" >&2; exit 2; }

identity() { # <dir> -> "buildId lockfileSha256" computed by the tree's own compiled CLI
  (cd "$1" && PATH="/opt/automaton-fleet/node/bin:$PATH" node dist/fleet/postgres/cli.js build-identity .) |
    PATH="/opt/automaton-fleet/node/bin:$PATH" node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(j.buildId+" "+j.lockfileSha256)'
}

case "$MODE" in
  build)
    BUILD_ID="${3:?expected build id}"; LOCK="${4:?expected lockfile sha256}"
    [[ "$BUILD_ID" =~ ^[0-9a-f]{64}$ && "$LOCK" =~ ^[0-9a-f]{64}$ ]] || { echo "build id / lockfile must be 64 hex" >&2; exit 2; }
    [[ $EUID -ne 0 ]] || { echo "build as the operator, not root" >&2; exit 2; }
    STAGE="${XDG_CACHE_HOME:-$HOME/.cache}/automaton-fleet/chatgpt-adapter-stage/$COMMIT"
    rm -rf "$STAGE"; mkdir -p "$STAGE"
    git init -q "$STAGE"; cd "$STAGE"
    git remote add origin "$REPO_URL"
    git fetch -q --depth 1 origin "$COMMIT"
    git checkout -q --detach "$COMMIT"
    test "$(git rev-parse HEAD)" = "$COMMIT"
    echo "$LOCK  pnpm-lock.yaml" | sha256sum -c --quiet -
    CI=true pnpm install --frozen-lockfile
    pnpm build
    test -z "$(git status --porcelain --untracked-files=no)"
    read -r got_build got_lock < <(identity "$STAGE")
    [[ "$got_build" == "$BUILD_ID" && "$got_lock" == "$LOCK" ]] ||
      { echo "BUILD MISMATCH: got $got_build / $got_lock, expected $BUILD_ID / $LOCK" >&2; exit 1; }
    printf '%s %s %s\n' "$COMMIT" "$BUILD_ID" "$LOCK" > "$STAGE/.adapter-pins"
    echo "Verified adapter build $BUILD_ID staged at $STAGE"
    ;;
  install)
    [[ $EUID -eq 0 ]] || { echo "install needs sudo" >&2; exit 2; }
    OPERATOR_HOME="$(getent passwd "${SUDO_USER:?}" | cut -d: -f6)"
    STAGE="$OPERATOR_HOME/.cache/automaton-fleet/chatgpt-adapter-stage/$COMMIT"
    DEST="$OPT/releases/$COMMIT"
    [[ -f "$STAGE/.adapter-pins" ]] || { echo "no verified staged build at $STAGE (run build first)" >&2; exit 1; }
    read -r pin_commit BUILD_ID LOCK < "$STAGE/.adapter-pins"
    [[ "$pin_commit" == "$COMMIT" ]] || { echo "staged pins are for $pin_commit" >&2; exit 1; }
    [[ ! -e "$DEST" ]] || { echo "$DEST already exists; releases are immutable" >&2; exit 1; }
    install -d -m 0755 -o root -g root "$OPT" "$OPT/releases"
    cp -a "$STAGE" "$DEST.tmp"
    rm -rf "$DEST.tmp/.git" "$DEST.tmp/.adapter-pins"
    chown -R root:root "$DEST.tmp"; chmod -R go-w,u-w "$DEST.tmp"; chmod u+w "$DEST.tmp"
    read -r got_build got_lock < <(identity "$DEST.tmp")
    [[ "$got_build" == "$BUILD_ID" && "$got_lock" == "$LOCK" ]] || { rm -rf "$DEST.tmp"; echo "installed tree does not match the verified build" >&2; exit 1; }
    chmod u-w "$DEST.tmp"; mv "$DEST.tmp" "$DEST"
    printf 'FLEET_CHATGPT_ADAPTER_COMMIT=%s\nFLEET_CHATGPT_ADAPTER_BUILD_ID=%s\nFLEET_CHATGPT_ADAPTER_LOCKFILE_SHA256=%s\n' "$COMMIT" "$BUILD_ID" "$LOCK" > "$OPT/pins.tmp"
    chmod 0644 "$OPT/pins.tmp"; mv "$OPT/pins.tmp" "$OPT/pins.env"
    ln -sfn "releases/$COMMIT" "$OPT/current.tmp" && mv -T "$OPT/current.tmp" "$OPT/current"
    echo "Installed ChatGPT adapter $COMMIT (build $BUILD_ID). Restart: systemctl restart automaton-fleet-chatgpt-adapter"
    ;;
  *) echo "usage: build <commit> <buildId> <lockfileSha256> | install <commit>" >&2; exit 2 ;;
esac
```

## `scripts/fleet-deploy-release.sh`

sha256 `50d03dbe5440095dbb866b4c4d12d31049b0caf6c5576b06a057048189ee084f` · 4881 bytes · 79 lines

```bash
#!/usr/bin/env bash
# Fleet Phase 4 — deploy the pinned runtime release for the fleet service.
#
#   scripts/fleet-deploy-release.sh build            # as the operator (no sudo): clean frozen build of the
#                                                    # pinned commit, verified against runtime.env
#   scripts/fleet-deploy-release.sh build --source <git dir>
#                                                    # same, but fetch the pinned commit from a local
#                                                    # clone (before the fork is published); the commit,
#                                                    # lockfile hash and build id are verified identically
#   sudo scripts/fleet-deploy-release.sh install     # copies the verified build to
#                                                    # /opt/automaton-fleet/releases/<commit> (root-owned,
#                                                    # read-only), re-verifies, switches `current`
#
# The release is whatever /etc/automaton-fleet/runtime.env pins
# (FLEET_RUNTIME_REPO / _COMMIT / _BUILD_ID / _LOCKFILE_SHA256): the same
# immutable runtime children are provisioned with. Dependency install
# scripts never run as root (build happens as the operator).
set -euo pipefail
MODE="${1:?usage: fleet-deploy-release.sh build [--source DIR]|install}"
SOURCE=""
[[ "${2:-}" == "--source" ]] && SOURCE="$(cd "${3:?--source needs a directory}" && pwd)"
RUNTIME_ENV="${FLEET_RUNTIME_ENV_FILE:-/etc/automaton-fleet/runtime.env}"
OPT=/opt/automaton-fleet
get() { sed -n "s/^$1=//p" "$RUNTIME_ENV" | tail -1; }
REPO_URL="$(get FLEET_RUNTIME_REPO)"; COMMIT="$(get FLEET_RUNTIME_COMMIT)"
BUILD_ID="$(get FLEET_RUNTIME_BUILD_ID)"; LOCK="$(get FLEET_RUNTIME_LOCKFILE_SHA256)"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ && "$BUILD_ID" =~ ^[0-9a-f]{64}$ && "$LOCK" =~ ^[0-9a-f]{64}$ ]] ||
  { echo "runtime.env does not pin a complete release (commit/build id/lockfile)" >&2; exit 1; }
# The repository must be pinned too, except for a local-source build made before the fork is published.
[[ "$REPO_URL" == https://* || ( "$MODE" == build && -n "$SOURCE" ) || "$MODE" == install ]] ||
  { echo "runtime.env does not pin FLEET_RUNTIME_REPO (https); use 'build --source <clone>' until the fork is published" >&2; exit 1; }

identity() { # <dir> -> "buildId lockfileSha256" computed by the tree's own compiled CLI
  (cd "$1" && node dist/fleet/postgres/cli.js build-identity .) |
    node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(j.buildId+" "+j.lockfileSha256)'
}

case "$MODE" in
  build)
    [[ $EUID -ne 0 ]] || { echo "build as the operator, not root" >&2; exit 2; }
    STAGE="${XDG_CACHE_HOME:-$HOME/.cache}/automaton-fleet/stage/$COMMIT"
    rm -rf "$STAGE"; mkdir -p "$STAGE"
    git init -q "$STAGE"; cd "$STAGE"
    [[ -n "$REPO_URL" ]] && git remote add origin "$REPO_URL"
    if [[ -n "$SOURCE" ]]; then
      git fetch -q "$SOURCE" "$COMMIT"   # objects from the local clone; origin still names the pinned repo
    else
      git fetch -q --depth 1 origin "$COMMIT"
    fi
    git checkout -q --detach "$COMMIT"
    test "$(git rev-parse HEAD)" = "$COMMIT"
    echo "$LOCK  pnpm-lock.yaml" | sha256sum -c --quiet -
    CI=true pnpm install --frozen-lockfile
    pnpm build
    test -z "$(git status --porcelain --untracked-files=no)"
    read -r got_build got_lock < <(identity "$STAGE")
    [[ "$got_build" == "$BUILD_ID" && "$got_lock" == "$LOCK" ]] ||
      { echo "BUILD MISMATCH: got $got_build / $got_lock, runtime.env pins $BUILD_ID / $LOCK" >&2; exit 1; }
    echo "Verified build $BUILD_ID staged at $STAGE"
    ;;
  install)
    [[ $EUID -eq 0 ]] || { echo "install needs sudo" >&2; exit 2; }
    OPERATOR_HOME="$(getent passwd "${SUDO_USER:?}" | cut -d: -f6)"
    STAGE="$OPERATOR_HOME/.cache/automaton-fleet/stage/$COMMIT"
    DEST="$OPT/releases/$COMMIT"
    [[ -d "$STAGE" ]] || { echo "no staged build at $STAGE (run: scripts/fleet-deploy-release.sh build)" >&2; exit 1; }
    [[ ! -e "$DEST" ]] || { echo "$DEST already exists; releases are immutable" >&2; exit 1; }
    install -d -m 0755 -o root -g root "$OPT/releases"
    cp -a "$STAGE" "$DEST.tmp"
    rm -rf "$DEST.tmp/.git"
    chown -R root:root "$DEST.tmp"; chmod -R go-w,u-w "$DEST.tmp"; chmod u+w "$DEST.tmp"
    read -r got_build got_lock < <(PATH="$OPT/node/bin:$PATH" identity "$DEST.tmp")
    [[ "$got_build" == "$BUILD_ID" && "$got_lock" == "$LOCK" ]] || { rm -rf "$DEST.tmp"; echo "installed tree does not match the pinned build" >&2; exit 1; }
    chmod u-w "$DEST.tmp"; mv "$DEST.tmp" "$DEST"
    ln -sfn "releases/$COMMIT" "$OPT/current.tmp" && mv -T "$OPT/current.tmp" "$OPT/current"
    echo "Installed release $COMMIT (build $BUILD_ID). Restart the service to pick it up: systemctl restart automaton-fleet"
    ;;
  *) echo "usage: fleet-deploy-release.sh build|install" >&2; exit 2 ;;
esac
```

## `scripts/fleet-os-setup.sh`

sha256 `df7919ad313401cdeb1871e41d5a60aa259ef13ec6fd6d376681778980cd795d` · 10135 bytes · 158 lines

```bash
#!/usr/bin/env bash
# Fleet Phase 4 — OS-user isolation and secret files.
#
#   sudo scripts/fleet-os-setup.sh            # DRY RUN: prints every command, changes nothing
#   sudo scripts/fleet-os-setup.sh --apply    # performs them (idempotent)
#
# Creates:
#   group  automaton-fleet-admin          operator group; may read admin.env (the operator is added)
#   user   automaton-fleet-service        system, nologin; runs the fleet service
#   user   automaton-agent                runs local agent runtimes; in NO fleet group
#   user   automaton-fleet-witness        system, nologin, in NO group; runs the FLEET-KI-4 root witness
#                                         (state: /var/lib/automaton-fleet-witness 0700 via systemd StateDirectory)
#   user   automaton-fleet-operator-api   system, nologin, in NO other group; runs the read-only Operator API
#                                         (Phase B2; logs: /var/log/automaton-fleet-operator 0700 via LogsDirectory)
#   /etc/automaton-fleet/                 root:root 0755
#     tls/         root:automaton-fleet-admin 0750   Phase 6 certificate + key (not created here; remote stays disabled)
#       fleet.key  root:root 0600                    LoadCredential=tls.key (only if present; never generated here)
#       fleet.crt  root:root 0644                    LoadCredential=tls.crt (only if present; never obtained here)
#     admin.env    root:automaton-fleet-admin 0640   FLEET_ADMIN_DATABASE_URL (moved from repo .env.fleet)
#     service.env  root:root 0600                    FLEET_SERVICE_DATABASE_URL, FLEET_AGENT_DATABASE_URL
#                                                    (fresh hex passwords; read by systemd LoadCredential only)
#     runtime.env  root:root 0644                    non-secret: pinned runtime + safety flags (all false)
#     operator.env root:automaton-fleet-operator-api 0640   FLEET_OPERATOR_DATABASE_URL (fresh hex password;
#                                                    read by the Operator API directly — no LoadCredential)
#   /opt/automaton-fleet/{releases,node/bin}         root-owned; pinned node binary copied in
#   /etc/systemd/system/automaton-fleet.service, automaton-agent.service,
#     automaton-fleet-witness.service, automaton-fleet-operator-api.service  (installed, NOT enabled/started)
#   /etc/logrotate.d/automaton-fleet                 root 0644 (D-9 bounded JSONL audit retention)
# and moves controller secrets out of the repository .env.fleet (backup kept root-only).
#
# It never prints secret values, never starts anything and never touches PostgreSQL
# (that is scripts/fleet-db-setup.sh).
set -euo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1
[[ $EUID -eq 0 ]] || { echo "run with sudo (dry run is safe: it only prints)" >&2; exit 2; }

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OPERATOR="${SUDO_USER:-}"
[[ -n "$OPERATOR" && "$OPERATOR" != root ]] || { echo "run via sudo from the operator account" >&2; exit 2; }
ETC=/etc/automaton-fleet
OPT=/opt/automaton-fleet
DB_NAME="${FLEET_DB_NAME:-automaton_fleet}"
DB_HOST="${FLEET_DB_HOST:-127.0.0.1}"
DB_PORT="${FLEET_DB_PORT:-5432}"
NODE_SRC="${FLEET_NODE_BIN:-$(sudo -u "$OPERATOR" -i bash -c 'command -v node')}"

say() { printf '\n# %s\n' "$*"; }
run() {
  printf '  %s\n' "$*"
  if (( APPLY )); then "$@"; fi
}
# Writes stdin to a file with owner/group/mode atomically; content is never echoed.
put() { # put <mode> <owner:group> <path>  (content on stdin)
  printf '  install -m %s -o %s -g %s <generated content> %s\n' "$1" "${2%%:*}" "${2##*:}" "$3"
  if (( APPLY )); then
    local tmp; tmp="$(mktemp "$3.XXXXXX")"
    cat >"$tmp"; chmod "$1" "$tmp"; chown "$2" "$tmp"; mv -f "$tmp" "$3"
  else
    cat >/dev/null
  fi
}

(( APPLY )) && echo "APPLYING fleet OS setup" || echo "DRY RUN — nothing will change. Re-run with --apply after review."

say "1. Groups and users"
getent group automaton-fleet-admin >/dev/null || run groupadd --system automaton-fleet-admin
id -nG "$OPERATOR" | tr ' ' '\n' | grep -qx automaton-fleet-admin || run usermod -aG automaton-fleet-admin "$OPERATOR"
id automaton-fleet-service >/dev/null 2>&1 || run useradd --system --user-group --home-dir /var/lib/automaton-fleet \
  --no-create-home --shell /usr/sbin/nologin --comment "Automaton fleet control service" automaton-fleet-service
id automaton-agent >/dev/null 2>&1 || run useradd --user-group --create-home --home-dir /home/automaton-agent \
  --shell /usr/sbin/nologin --comment "Automaton agent runtime" automaton-agent
run chmod 0700 /home/automaton-agent
id automaton-fleet-witness >/dev/null 2>&1 || run useradd --system --user-group --home-dir /var/lib/automaton-fleet-witness \
  --no-create-home --shell /usr/sbin/nologin --comment "Automaton fleet root witness" automaton-fleet-witness
id automaton-fleet-operator-api >/dev/null 2>&1 || run useradd --system --user-group --home-dir /var/lib/automaton-fleet-operator-api \
  --no-create-home --shell /usr/sbin/nologin --comment "Automaton fleet Operator API" automaton-fleet-operator-api

say "2. Secret directory (+ tls/ for the Phase 6 certificate; key and cert delivered by LoadCredential only)"
run install -d -m 0755 -o root -g root "$ETC"
[[ -L "$ETC/tls" ]] && { echo "  $ETC/tls is a symlink; refusing" >&2; exit 1; }
run install -d -m 0750 -o root -g automaton-fleet-admin "$ETC/tls"
# Existing TLS files are only re-permissioned; this script never creates, fetches or prints them.
for spec in fleet.key:0600 fleet.crt:0644; do
  f="$ETC/tls/${spec%%:*}"; mode="${spec##*:}"
  [[ -e "$f" || -L "$f" ]] || { echo "  ($f absent — remote HTTPS stays disabled)"; continue; }
  if [[ -L "$f" || ! -f "$f" || "$(stat -c %h "$f")" != 1 ]]; then
    echo "  $f is not a single-link regular file; refusing" >&2; exit 1
  fi
  run chown root:root "$f"; run chmod "$mode" "$f"
done

say "3. admin.env (operator credential, moved from repo .env.fleet)"
if [[ -f "$ETC/admin.env" ]]; then
  echo "  (exists — left unchanged)"; run chown root:automaton-fleet-admin "$ETC/admin.env"; run chmod 0640 "$ETC/admin.env"
else
  admin_url="$(sed -n 's/^[[:space:]]*\(FLEET_ADMIN_DATABASE_URL\|FLEET_CONTROLLER_DATABASE_URL\|DATABASE_URL\)[[:space:]]*=[[:space:]]*//p' "$REPO/.env.fleet" 2>/dev/null | head -1)"
  [[ -n "$admin_url" ]] || { echo "  no DATABASE_URL in $REPO/.env.fleet; create $ETC/admin.env by hand" >&2; exit 1; }
  printf '# Operator/migration credential (schema owner). Never give this to the service or agents.\nFLEET_ADMIN_DATABASE_URL=%s\n' "$admin_url" |
    put 0640 root:automaton-fleet-admin "$ETC/admin.env"
fi

say "4. service.env (restricted DB logins; fresh passwords, applied to PostgreSQL by fleet-db-setup.sh)"
if [[ -f "$ETC/service.env" ]]; then
  echo "  (exists — left unchanged)"; run chown root:root "$ETC/service.env"; run chmod 0600 "$ETC/service.env"
else
  svc_pw="$(openssl rand -hex 32)"; agent_pw="$(openssl rand -hex 32)"
  printf '# Fleet service DB credentials (restricted roles). Delivered via systemd LoadCredential only.\nFLEET_SERVICE_DATABASE_URL=postgresql://fleet_service_login:%s@%s:%s/%s\nFLEET_AGENT_DATABASE_URL=postgresql://fleet_agent_login:%s@%s:%s/%s\n' \
    "$svc_pw" "$DB_HOST" "$DB_PORT" "$DB_NAME" "$agent_pw" "$DB_HOST" "$DB_PORT" "$DB_NAME" |
    put 0600 root:root "$ETC/service.env"
  unset svc_pw agent_pw
fi

say "4b. operator.env (schema v8 Operator API login; fresh password, applied to PostgreSQL by fleet-db-setup.sh)"
if [[ -L "$ETC/operator.env" ]]; then
  echo "  $ETC/operator.env is a symlink; refusing" >&2; exit 1
elif [[ -f "$ETC/operator.env" ]]; then
  echo "  (exists — left unchanged)"; run chown root:automaton-fleet-operator-api "$ETC/operator.env"; run chmod 0640 "$ETC/operator.env"
else
  op_pw="$(openssl rand -hex 32)"
  printf '# Operator API DB credential (restricted, read-only op_* role). Never give this to the service, agents or bridges.\nFLEET_OPERATOR_DATABASE_URL=postgresql://fleet_operator_login:%s@%s:%s/%s\n' \
    "$op_pw" "$DB_HOST" "$DB_PORT" "$DB_NAME" |
    put 0640 root:automaton-fleet-operator-api "$ETC/operator.env"
  unset op_pw
fi

say "5. runtime.env (non-secret; fill FLEET_RUNTIME_* after the fork is published and built)"
if [[ -f "$ETC/runtime.env" ]]; then
  echo "  (exists — left unchanged)"
else
  put 0644 root:root "$ETC/runtime.env" <"$REPO/deploy/etc/runtime.env.example"
fi

say "6. Code and node locations (root-owned, read-only to the service)"
run install -d -m 0755 -o root -g root "$OPT" "$OPT/releases" "$OPT/node" "$OPT/node/bin"
run install -m 0755 -o root -g root "$NODE_SRC" "$OPT/node/bin/node"

say "7. systemd units (installed, NOT enabled or started)"
run install -m 0644 -o root -g root "$REPO/deploy/systemd/automaton-fleet.service" /etc/systemd/system/automaton-fleet.service
run install -m 0644 -o root -g root "$REPO/deploy/systemd/automaton-agent.service" /etc/systemd/system/automaton-agent.service
run install -m 0644 -o root -g root "$REPO/deploy/systemd/automaton-fleet-witness.service" /etc/systemd/system/automaton-fleet-witness.service
run install -m 0644 -o root -g root "$REPO/deploy/systemd/automaton-fleet-operator-api.service" /etc/systemd/system/automaton-fleet-operator-api.service
run systemctl daemon-reload

say "7b. logrotate (D-9 bounded JSONL audit retention)"
run install -m 0644 -o root -g root "$REPO/deploy/logrotate/automaton-fleet" /etc/logrotate.d/automaton-fleet

say "8. Remove controller secrets from the repository .env.fleet (root-only backup kept)"
if grep -qE '^[[:space:]]*(DATABASE_URL|FLEET_CONTROLLER_DATABASE_URL|FLEET_ADMIN_DATABASE_URL|REDIS_URL)[[:space:]]*=' "$REPO/.env.fleet" 2>/dev/null; then
  run install -m 0600 -o root -g root "$REPO/.env.fleet" "$ETC/legacy-env-fleet.bak"
  run sed -i -E '/^[[:space:]]*(DATABASE_URL|FLEET_CONTROLLER_DATABASE_URL|FLEET_ADMIN_DATABASE_URL|REDIS_URL)[[:space:]]*=/d' "$REPO/.env.fleet"
else
  echo "  (no controller secrets in .env.fleet)"
fi

say "Done. Next: sudo scripts/fleet-db-setup.sh (dry run), then --apply after approval."
(( APPLY )) && echo "NOTE: $OPERATOR must log out/in (or run 'newgrp automaton-fleet-admin') to read admin.env."
```

## `scripts/fleet-verify-deployment.sh`

sha256 `80e80a37784151ec5ecb241ce23f221a7aa145c44fdbb8edd508cba884e9b641` · 10915 bytes · 185 lines

```bash
#!/usr/bin/env bash
# Phase 6 — privileged deployment verification (read-only; changes nothing).
#
#   sudo scripts/fleet-verify-deployment.sh
#
# Checks, as the real OS identities, what `pnpm fleet:verify` can only infer
# from file modes:
#   - the agent user and the service user cannot read controller secrets
#   - TLS material: tls/ root:automaton-fleet-admin 0750, fleet.key root:root 0600,
#     fleet.crt root:root 0644 (single-link regular files); the remote drop-in, if
#     installed, maps exactly tls.key/tls.crt and runtime.env sets no FLEET_TLS_KEY_FILE
#   - the fleet service runs as automaton-fleet-service (never root)
#   - PostgreSQL and Redis listen on loopback only; the fleet admin HTTP port
#     is loopback-only; only the HTTPS port (if enabled) is public
#   - Operator API (schema v8, when installed): its user cannot read controller
#     secrets and is in no other group; no other fleet user can read
#     operator.env (root:automaton-fleet-operator-api 0640); port 8788 is
#     loopback-only; the host clock is NTP-synchronized
# Exit 1 on any failure. Never prints secret contents.
set -uo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo (read-only checks)" >&2; exit 2; }
ETC=/etc/automaton-fleet
fail=0
ok()  { printf '  [PASS] %s\n' "$*"; }
bad() { printf '  [FAIL] %s\n' "$*"; fail=1; }

echo "Secrets vs OS identities"
for u in automaton-agent automaton-fleet-service automaton-fleet-witness automaton-fleet-operator-api; do
  if ! id "$u" >/dev/null 2>&1; then
    [[ "$u" == automaton-fleet-witness ]] && { ok "user $u not created (root witness not installed)"; continue; }
    [[ "$u" == automaton-fleet-operator-api ]] && { ok "user $u not created (Operator API not installed)"; continue; }
    bad "user $u missing"; continue
  fi
  for f in "$ETC/admin.env" "$ETC/service.env" "$ETC/tls/fleet.key" "$ETC/legacy-env-fleet.bak"; do
    [[ -e "$f" ]] || continue
    if runuser -u "$u" -- test -r "$f" 2>/dev/null; then bad "$u CAN read $f"; else ok "$u cannot read $f"; fi
  done
done

if id automaton-fleet-witness >/dev/null 2>&1; then
  groups_of="$(id -nG automaton-fleet-witness)"
  [[ "$groups_of" == automaton-fleet-witness ]] && ok "automaton-fleet-witness is in no other group" || bad "automaton-fleet-witness groups: $groups_of"
fi

echo "Operator API isolation (schema v8)"
if id automaton-fleet-operator-api >/dev/null 2>&1; then
  groups_of="$(id -nG automaton-fleet-operator-api)"
  [[ "$groups_of" == automaton-fleet-operator-api ]] && ok "automaton-fleet-operator-api is in no other group" || bad "automaton-fleet-operator-api groups: $groups_of"
  OPENV="$ETC/operator.env"
  if [[ -L "$OPENV" ]]; then bad "$OPENV is a symlink"
  elif [[ -f "$OPENV" ]]; then
    got="$(stat -c '%U:%G %a %h' "$OPENV")"
    [[ "$got" == "root:automaton-fleet-operator-api 640 1" ]] && ok "$OPENV is root:automaton-fleet-operator-api 640 (single link)" || bad "$OPENV is $got (expected root:automaton-fleet-operator-api 640 1)"
    for u in automaton-agent automaton-fleet-service automaton-fleet-witness "${SUDO_USER:-}"; do
      [[ -n "$u" ]] && id "$u" >/dev/null 2>&1 || continue
      if runuser -u "$u" -- test -r "$OPENV" 2>/dev/null; then bad "$u CAN read $OPENV"; else ok "$u cannot read $OPENV"; fi
    done
    # Same list as OPERATOR_FORBIDDEN_ENV (src/fleet/secret-files.ts).
    if grep -qE '^[[:space:]]*(export[[:space:]]+)?(FLEET_ADMIN_DATABASE_URL|FLEET_SERVICE_DATABASE_URL|FLEET_AGENT_DATABASE_URL|FLEET_CONTROLLER_DATABASE_URL|DATABASE_URL|PGPASSWORD|REDIS_URL|CONWAY_API_KEY|WALLET_PRIVATE_KEY|PRIVATE_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|FLEET_CREDENTIALS_FILE|CREDENTIALS_DIRECTORY)[[:space:]]*=' "$OPENV"; then
      bad "$OPENV holds a non-operator credential"
    else
      ok "$OPENV holds only the operator credential"
    fi
  else
    bad "$OPENV missing"
  fi
  if [[ "$(systemctl is-active automaton-fleet-operator-api.service 2>/dev/null)" == active ]]; then
    if ss -ltnH | awk '{print $4}' | grep -E ':8788$' | grep -qvE '^(127\.0\.0\.1|\[::1\]):8788$'; then
      bad "Operator API port 8788 is bound beyond loopback"
    else
      ok "Operator API port 8788 is loopback-only"
    fi
  else
    ok "Operator API unit not active"
  fi
  # Signed operator requests use a ±30 s window; readiness also needs the timesyncd marker.
  if [[ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" == yes ]]; then ok "host clock is NTP-synchronized"; else bad "host clock is not NTP-synchronized (signed operator requests use a ±30 s window)"; fi
  if [[ -e /run/systemd/timesync/synchronized ]]; then ok "systemd-timesyncd synchronized marker present"; else bad "no /run/systemd/timesync/synchronized (Operator API readiness requires it; set FLEET_OPERATOR_TIMESYNC_MARKER for another NTP daemon)"; fi
else
  ok "Operator API not installed"
fi

echo "ChatGPT adapter isolation (Phase C)"
CA=automaton-fleet-chatgpt-adapter; CT=automaton-fleet-chatgpt-tunnel
if id "$CA" >/dev/null 2>&1 || id "$CT" >/dev/null 2>&1; then
  for u in "$CA" "$CT"; do
    if id "$u" >/dev/null 2>&1; then
      [[ "$(id -nG "$u")" == "$u" ]] && ok "$u is in no other group" || bad "$u groups: $(id -nG "$u")"
    else bad "$u missing"; fi
  done
  chk() { # <path> <expected "owner:group mode links">
    if [[ -L "$1" ]]; then bad "$1 is a symlink"; elif [[ -e "$1" ]]; then
      got="$(stat -c '%U:%G %a %h' "$1")"; [[ "$got" == "$2" ]] && ok "$1 is $2" || bad "$1 is $got (expected $2)"
    else bad "$1 missing"; fi
  }
  chk "$ETC/chatgpt-adapter.json" "root:$CA 640 1"
  chk "$ETC/chatgpt-tunnel/adapter-token" "root:root 600 1"
  [[ "$(stat -c '%U:%G %a' "$ETC/chatgpt-tunnel")" == "root:root 700" ]] && ok "$ETC/chatgpt-tunnel is root:root 700" || bad "$ETC/chatgpt-tunnel is $(stat -c '%U:%G %a' "$ETC/chatgpt-tunnel")"
  [[ -e "$ETC/chatgpt-tunnel/openai-api-key" ]] && chk "$ETC/chatgpt-tunnel/openai-api-key" "root:root 600 1" || ok "OpenAI tunnel key not yet provided (tunnel stays off)"
  chk "/var/lib/$CA/bridge-chatgpt.key" "$CA:$CA 600 1"
  SOCK=/run/automaton-fleet-chatgpt/adapter.sock
  if [[ -S "$SOCK" ]]; then
    [[ "$(stat -c '%U:%G %a' "$SOCK")" == "$CA:$CT 660" ]] && ok "$SOCK is $CA:$CT 660" || bad "$SOCK is $(stat -c '%U:%G %a' "$SOCK")"
    for u in automaton-agent automaton-fleet-service automaton-fleet-witness automaton-fleet-operator-api "${SUDO_USER:-}"; do
      [[ -n "$u" ]] && id "$u" >/dev/null 2>&1 || continue
      if runuser -u "$u" -- test -w "$SOCK" 2>/dev/null; then bad "$u CAN connect to $SOCK"; else ok "$u cannot connect to $SOCK"; fi
    done
  else ok "adapter socket not active"; fi
  for pair in "$CT:/var/lib/$CA/bridge-chatgpt.key" "$CT:$ETC/chatgpt-adapter.json" "$CA:$ETC/chatgpt-tunnel/adapter-token" "$CA:$ETC/chatgpt-tunnel/openai-api-key" "$CA:$ETC/operator.env" "$CT:$ETC/operator.env" "$CA:$ETC/admin.env" "$CT:$ETC/admin.env" "$CA:$ETC/service.env" "$CT:$ETC/service.env"; do
    u="${pair%%:*}"; f="${pair#*:}"; [[ -e "$f" ]] || continue
    if runuser -u "$u" -- test -r "$f" 2>/dev/null; then bad "$u CAN read $f"; else ok "$u cannot read $f"; fi
  done
  for u in "$CA" "$CT"; do
    uidn="$(id -u "$u" 2>/dev/null || echo x)"
    if ss -ltneH 2>/dev/null | grep -qE "uid:$uidn( |$)"; then bad "$u holds a TCP listener"; else ok "$u holds no TCP listener"; fi
  done
else
  ok "ChatGPT adapter not installed"
fi

echo "TLS material (LoadCredential sources)"
# expect <path> <owner:group> <octal mode> <kind: d|f>
expect() {
  local f="$1" want="$2 $3" got
  if [[ ! -e "$f" && ! -L "$f" ]]; then ok "$f absent (remote HTTPS disabled)"; return; fi
  if [[ -L "$f" ]]; then bad "$f is a symlink"; return; fi
  if [[ "$4" == d && ! -d "$f" ]] || [[ "$4" == f && ! -f "$f" ]]; then bad "$f has the wrong file type"; return; fi
  if [[ "$4" == f && "$(stat -c %h "$f")" != 1 ]]; then bad "$f has $(stat -c %h "$f") hard links"; return; fi
  got="$(stat -c '%U:%G %a' "$f")"
  [[ "$got" == "$want" ]] && ok "$f is $got" || bad "$f is $got (expected $want)"
}
expect "$ETC/tls" root:automaton-fleet-admin 750 d
expect "$ETC/tls/fleet.key" root:root 600 f
expect "$ETC/tls/fleet.crt" root:root 644 f
DROPIN=/etc/systemd/system/automaton-fleet.service.d/remote.conf
if [[ -e "$DROPIN" ]]; then
  creds="$(grep -E '^[[:space:]]*LoadCredential' "$DROPIN" | tr -d ' ' | sort)"
  want="$(printf '%s\n' 'LoadCredential=tls.crt:/etc/automaton-fleet/tls/fleet.crt' 'LoadCredential=tls.key:/etc/automaton-fleet/tls/fleet.key')"
  [[ "$creds" == "$want" ]] && ok "remote drop-in maps exactly tls.key and tls.crt" || bad "remote drop-in LoadCredential lines are not exactly tls.key/tls.crt"
else
  ok "remote drop-in not installed"
fi
if grep -qE '^[[:space:]]*FLEET_TLS_KEY_FILE[[:space:]]*=' "$ETC/runtime.env" 2>/dev/null; then
  bad "runtime.env sets FLEET_TLS_KEY_FILE (use LoadCredential=tls.key; leave it unset)"
else
  ok "runtime.env leaves FLEET_TLS_KEY_FILE unset"
fi
if grep -qE '^[[:space:]]*FLEET_TLS_CERT_FILE[[:space:]]*=' "$ETC/runtime.env" 2>/dev/null &&
   ! grep -qx 'FLEET_TLS_CERT_FILE=/run/credentials/automaton-fleet.service/tls.crt' "$ETC/runtime.env"; then
  bad "runtime.env FLEET_TLS_CERT_FILE is not /run/credentials/automaton-fleet.service/tls.crt"
fi

op="${SUDO_USER:-}"
if [[ -n "$op" ]] && grep -qE '^[[:space:]]*(DATABASE_URL|FLEET_ADMIN_DATABASE_URL|FLEET_CONTROLLER_DATABASE_URL|REDIS_URL)[[:space:]]*=' "$(dirname "$0")/../.env.fleet" 2>/dev/null; then
  bad "repository .env.fleet still holds controller secrets"
else
  ok "repository .env.fleet holds no controller secrets"
fi

echo "Service identity"
state="$(systemctl is-active automaton-fleet.service 2>/dev/null || true)"
[[ "$state" == active ]] && ok "automaton-fleet.service active" || bad "automaton-fleet.service is ${state:-unknown}"
pid="$(systemctl show -p MainPID --value automaton-fleet.service 2>/dev/null || echo 0)"
if [[ "$pid" =~ ^[0-9]+$ && "$pid" != 0 ]]; then
  user="$(ps -o user= -p "$pid" | tr -d ' ')"
  [[ "$user" == automaton-fleet-service ]] && ok "service process runs as $user" || bad "service process runs as $user"
  if tr '\0' '\n' <"/proc/$pid/environ" | grep -qE '^(FLEET_ADMIN_DATABASE_URL|FLEET_SERVICE_DATABASE_URL|FLEET_AGENT_DATABASE_URL|DATABASE_URL)='; then
    bad "database credentials visible in the service environment (/proc/$pid/environ)"
  else
    ok "no database credential in the service environment"
  fi
fi

echo "Network exposure"
listeners="$(ss -Hltn 2>/dev/null)"
for port in 5432 6379 8787; do
  public="$(awk -v p=":$port" '$4 ~ p"$" && $4 !~ /^(127\.0\.0\.1|\[::1\]):/' <<<"$listeners")"
  [[ -z "$public" ]] && ok "port $port loopback-only (or closed)" || bad "port $port listens publicly: $public"
done
if grep -q '^FLEET_REMOTE_LISTEN_ENABLED=true' "$ETC/runtime.env" 2>/dev/null; then
  ok "remote HTTPS listener enabled by runtime.env"
else
  ok "remote exposure disabled (FLEET_REMOTE_LISTEN_ENABLED is not true)"
fi
exit $fail
```

## `deploy/etc/admin.env.example`

sha256 `57927daa1f938bf8f19c1834e89715f5c69f3df81473d5fd898e6b2ac074b5b8` · 303 bytes · 4 lines

```ini
# /etc/automaton-fleet/admin.env — SECRET, root:automaton-fleet-admin 0640.
# Schema owner credential for migrations and the operator CLI only. The fleet
# service refuses to start if it can see this variable.
FLEET_ADMIN_DATABASE_URL=postgresql://fleetadmin:<password>@localhost:5432/automaton_fleet
```

## `deploy/etc/operator.env.example`

sha256 `f72d6f55d6925ee9c31b1909b4a5986fb2735ff4c246a8cbf1b2c273d5d8912b` · 538 bytes · 8 lines

```ini
# /etc/automaton-fleet/operator.env — root:automaton-fleet-operator-api 0640 (Phase B2).
# Generated on the host by scripts/fleet-os-setup.sh --apply with a fresh
# 64-hex password; applied to PostgreSQL by scripts/fleet-db-setup.sh --apply.
# Read only by the Operator API process. Never commit a real value.
#
# The Operator API refuses to start if ANY admin/service/agent database URL,
# Conway key or wallet key is visible to it.
FLEET_OPERATOR_DATABASE_URL=postgresql://fleet_operator_login:<64-hex>@127.0.0.1:5432/automaton_fleet
```

## `deploy/etc/runtime.env.example`

sha256 `5fa32c4dcc4a3a1cbd038c34c7558e0642e554d5e04cfa2b9b36ab27286aca70` · 1710 bytes · 35 lines

```ini
# /etc/automaton-fleet/runtime.env — NON-SECRET fleet release configuration (0644).
# The pinned runtime of this fleet release. Children run exactly this repo,
# commit and build; the fleet service refuses leases expecting anything else,
# and the registry refuses to change the approved runtime while leases are
# open or children are living. Values come from scripts/fleet-build-runtime.sh.
FLEET_RUNTIME_REPO=
FLEET_RUNTIME_COMMIT=
FLEET_RUNTIME_BUILD_ID=
FLEET_RUNTIME_LOCKFILE_SHA256=

# Safety switches — must remain false. Never flipped by any script.
REAL_REPLICATION_ENABLED=false
REAL_PAYMENTS_ENABLED=false
OWNER_SWEEP_ENABLED=false
# Phase 6: the operator dry-run command refuses unless this is true AND
# --confirm-real-sandbox is passed. Leave false except while running it.
FLEET_DRY_RUN_CHILD=false

FLEET_API_LISTEN=127.0.0.1:8787
FLEET_REAPER_INTERVAL_MS=15000

# Phase 6 remote controller — DISABLED. Enable only after DNS, certificate
# and firewall are in place (deploy/firewall/, deploy/systemd/*.d/remote.conf.example).
# PostgreSQL and Redis are never exposed; only this HTTPS listener is.
FLEET_REMOTE_LISTEN_ENABLED=false
#FLEET_PUBLIC_HOSTNAME=fleet.example.com
#FLEET_PUBLIC_LISTEN=0.0.0.0:443
#FLEET_PUBLIC_URL=https://fleet.example.com
# Cert and key are delivered by the remote drop-in:
#   LoadCredential=tls.crt:/etc/automaton-fleet/tls/fleet.crt  (root:root 0644)
#   LoadCredential=tls.key:/etc/automaton-fleet/tls/fleet.key  (root:root 0600)
# Leave FLEET_TLS_KEY_FILE unset: the service then uses the verified credential
# /run/credentials/automaton-fleet.service/tls.key.
#FLEET_TLS_CERT_FILE=/run/credentials/automaton-fleet.service/tls.crt
#FLEET_ALLOWED_ORIGINS=
```

## `deploy/etc/service.env.example`

sha256 `24acb2e6c6171df9661ff65b352a64321d1b3266b4d6015c694cc71d1ddbd931` · 408 bytes · 5 lines

```ini
# /etc/automaton-fleet/service.env — SECRET, root:root 0600. Delivered to the
# fleet service only through systemd LoadCredential=. Generated by
# scripts/fleet-os-setup.sh (hex passwords); never commit real values.
FLEET_SERVICE_DATABASE_URL=postgresql://fleet_service_login:<hex>@127.0.0.1:5432/automaton_fleet
FLEET_AGENT_DATABASE_URL=postgresql://fleet_agent_login:<hex>@127.0.0.1:5432/automaton_fleet
```

## `deploy/firewall/fleet-firewall.sh`

sha256 `2ddf4372715b1c7230dd06299f4d6366d6ccd8df27264a70b6cb00ced695f1f5` · 1459 bytes · 27 lines

```bash
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
```

## `deploy/logrotate/automaton-fleet`

sha256 `6709a5401923f28fde0ca16478d460e62877a31edb7e1eecdceb559ac18f9238` · 1002 bytes · 29 lines

```
# /etc/logrotate.d/automaton-fleet (root 0644) — D-9 bounded audit retention (Phase B2).
#
# Bounds each JSONL audit file to about 14 x 50 MB (compressed after the first
# rotation). Rotation is by rename: both sinks open the path on every append,
# so the next line lands in the fresh file — no copytruncate, no data loss.
# Rotated files keep the owner and 0600 mode. Nothing here touches the
# database audit (fleet_operator_requests is capped and archived separately).

/var/log/automaton-fleet/audit.jsonl {
    size 50M
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0600 automaton-fleet-service automaton-fleet-service
    su automaton-fleet-service automaton-fleet-service
}

/var/log/automaton-fleet-operator/audit.jsonl {
    size 50M
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0600 automaton-fleet-operator-api automaton-fleet-operator-api
    su automaton-fleet-operator-api automaton-fleet-operator-api
}
```

## `deploy/systemd/automaton-agent.service`

sha256 `e8f90f6dc23bb046419da45dcc66c900a5fb5e70f25c3b136c12f0dd9669205a` · 1681 bytes · 48 lines

```ini
# Local automaton (root agent) runtime — Phase 4 isolation boundary.
# NOT enabled by setup. Real replication/payments/owner sweep stay disabled.
#
# Runs as automaton-agent, which is in no fleet group. It gets no controller
# credential: only its own fleet token file (~automaton-agent/.automaton/
# fleet-credentials.json, 0600) and FLEET_API_URL. The fleet secret
# directory, the service's logs and the operator's home are made
# inaccessible regardless of file modes; `automaton --run` also refuses to
# start if a privileged variable is present in its environment.

[Unit]
Description=Automaton agent runtime (isolated from fleet controller secrets)
Wants=automaton-fleet.service
After=automaton-fleet.service

[Service]
Type=exec
User=automaton-agent
Group=automaton-agent
WorkingDirectory=/home/automaton-agent
ExecStart=/opt/automaton-fleet/node/bin/node /opt/automaton-fleet/current/dist/index.js --run
Environment=HOME=/home/automaton-agent
Environment=FLEET_API_URL=http://127.0.0.1:8787
Environment=REAL_REPLICATION_ENABLED=false
Environment=REAL_PAYMENTS_ENABLED=false
Environment=OWNER_SWEEP_ENABLED=false
Restart=on-failure
RestartSec=10s
UMask=0077

NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/home/automaton-agent
ProtectHome=tmpfs
BindPaths=/home/automaton-agent
InaccessiblePaths=/etc/automaton-fleet -/var/log/automaton-fleet -/var/lib/automaton-fleet
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
# Hide other users' processes (so /proc/<service pid>/environ is unreachable).
ProtectProc=invisible
RestrictSUIDSGID=yes
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
```

## `deploy/systemd/automaton-fleet-chatgpt-adapter.service`

sha256 `331a1422269b5248d9b3a4949dc83b37dba33865abb1e0eeb74906d32c4d54d7` · 3121 bytes · 79 lines

```ini
# Automaton Fleet ChatGPT adapter — read-only MCP tools for ChatGPT (Phase C).
#
#   OpenAI Secure MCP Tunnel -> automaton-fleet-chatgpt-tunnel (outbound only)
#     -> /run/automaton-fleet-chatgpt/adapter.sock (+ static token)
#     -> THIS service -> signed requests -> Operator API 127.0.0.1:8788
#
# Runs as its own user (no other group) from a separately pinned artifact
# (/opt/automaton-fleet/chatgpt-adapter/current); it does not change the
# FleetController runtime. It holds only the bridge-chatgpt Ed25519 key
# (StateDirectory, 0600) and reads the root-owned 0640 config. It can reach
# nothing but loopback (the Operator API) and never sees admin/service/
# operator/TLS/tunnel/witness secrets. Four read-only tools; no events.

[Unit]
Description=Automaton Fleet ChatGPT adapter (read-only, bridge-chatgpt)
Documentation=file:///opt/automaton-fleet/chatgpt-adapter/current/docs/design/phase-c-chatgpt-adapter.md
Requires=automaton-fleet-chatgpt-adapter.socket
After=automaton-fleet-chatgpt-adapter.socket automaton-fleet-operator-api.service
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=exec
User=automaton-fleet-chatgpt-adapter
Group=automaton-fleet-chatgpt-adapter
SupplementaryGroups=
WorkingDirectory=/opt/automaton-fleet/chatgpt-adapter/current
ExecStart=/opt/automaton-fleet/node/bin/node dist/fleet/chatgpt-adapter/main.js
Environment=NODE_ENV=production
Environment=FLEET_CHATGPT_ADAPTER_EXPECTED_USER=automaton-fleet-chatgpt-adapter
Environment=FLEET_CHATGPT_ADAPTER_CONFIG=/etc/automaton-fleet/chatgpt-adapter.json
Environment=FLEET_CHATGPT_ADAPTER_AUDIT_LOG=/var/log/automaton-fleet-chatgpt-adapter/audit.jsonl
StateDirectory=automaton-fleet-chatgpt-adapter
StateDirectoryMode=0700
LogsDirectory=automaton-fleet-chatgpt-adapter
LogsDirectoryMode=0700
UMask=0077

Restart=on-failure
RestartSec=5s
KillSignal=SIGTERM
TimeoutStopSec=15s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=automaton-fleet-chatgpt-adapter

# Network: loopback only (the Operator API); the listener is the systemd Unix socket.
IPAddressDeny=any
IPAddressAllow=localhost
RestrictAddressFamilies=AF_INET AF_UNIX

NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
ProcSubset=pid
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RemoveIPC=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
InaccessiblePaths=-/etc/automaton-fleet/admin.env -/etc/automaton-fleet/service.env -/etc/automaton-fleet/operator.env -/etc/automaton-fleet/tls -/etc/automaton-fleet/legacy-env-fleet.bak -/etc/automaton-fleet/chatgpt-tunnel
InaccessiblePaths=-/home -/var/lib/automaton-fleet -/var/lib/automaton-fleet-witness -/var/lib/automaton-fleet-chatgpt-tunnel -/var/log/automaton-fleet -/var/log/automaton-fleet-operator -/run/credentials

[Install]
WantedBy=multi-user.target
```

## `deploy/systemd/automaton-fleet-chatgpt-adapter.socket`

sha256 `1ef46f613e5d7577f8768b49b81284cf63cf406c9716f1c9bd52be8d4dc3eb67` · 795 bytes · 22 lines

```ini
# Automaton Fleet ChatGPT adapter — private Unix socket (Phase C).
#
# The adapter's ONLY listener. It is not a TCP port: systemd (root) creates the
# socket owned by the adapter user and the tunnel group, mode 0660, so only the
# OpenAI tunnel-client (automaton-fleet-chatgpt-tunnel) and the adapter itself
# can connect. Nothing on the network can reach it.

[Unit]
Description=Automaton Fleet ChatGPT adapter socket (tunnel-client only)
Documentation=file:///opt/automaton-fleet/chatgpt-adapter/current/docs/design/phase-c-chatgpt-adapter.md

[Socket]
ListenStream=/run/automaton-fleet-chatgpt/adapter.sock
SocketUser=automaton-fleet-chatgpt-adapter
SocketGroup=automaton-fleet-chatgpt-tunnel
SocketMode=0660
DirectoryMode=0755
RemoveOnStop=yes
Accept=no

[Install]
WantedBy=sockets.target
```

## `deploy/systemd/automaton-fleet-chatgpt-tunnel.path`

sha256 `69098a0b01906c4b6e90630a65dd64c03be4ff1fd642889df10a4cfbc2555d07` · 378 bytes · 12 lines

```ini
# Automaton Fleet ChatGPT tunnel — start automatically once the owner has
# placed the OpenAI runtime key (Phase C). No secret is involved here.

[Unit]
Description=Start the ChatGPT tunnel when its OpenAI runtime key is present

[Path]
PathExists=/etc/automaton-fleet/chatgpt-tunnel/openai-api-key
Unit=automaton-fleet-chatgpt-tunnel.service

[Install]
WantedBy=paths.target
```

## `deploy/systemd/automaton-fleet-chatgpt-tunnel.service`

sha256 `8f2888c4d0b616e23e9e86adbd3721591e826a81b7be0941df50c81a4d04d7fd` · 3987 bytes · 90 lines

```ini
# Automaton Fleet ChatGPT tunnel — OpenAI Secure MCP Tunnel client (Phase C).
#
# Outbound-only: long-polls api.openai.com:443 for the owner's ChatGPT tool
# calls and forwards them to the adapter's Unix socket. No inbound listener
# (health is served on a private Unix socket, not TCP). Runs the pinned,
# checksum-verified OpenAI tunnel-client-runtime as its own user. It holds only:
#   - the OpenAI runtime API key (Tunnels Read + Use)      LoadCredential
#   - the adapter token (static header to the adapter)     LoadCredential
# It cannot reach loopback or private networks (except the local DNS stub),
# so tunnel traffic can never be pointed at 8787/8788/5432/6379, and it never
# sees any fleet key or database credential.
#
# Starts only once the owner has placed the tunnel id and API key (see
# docs/design/phase-c-chatgpt-adapter.md, "Owner actions").

[Unit]
Description=Automaton Fleet ChatGPT tunnel (OpenAI Secure MCP Tunnel client, outbound only)
Documentation=https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
Wants=network-online.target
After=network-online.target automaton-fleet-chatgpt-adapter.socket
ConditionPathExists=/etc/automaton-fleet/chatgpt-tunnel/openai-api-key
ConditionPathExists=/etc/automaton-fleet/chatgpt-tunnel/tunnel.env
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=exec
User=automaton-fleet-chatgpt-tunnel
Group=automaton-fleet-chatgpt-tunnel
SupplementaryGroups=
# Non-secret: CONTROL_PLANE_TUNNEL_ID=tunnel_<32 hex>
EnvironmentFile=/etc/automaton-fleet/chatgpt-tunnel/tunnel.env
LoadCredential=openai-api-key:/etc/automaton-fleet/chatgpt-tunnel/openai-api-key
LoadCredential=adapter-token:/etc/automaton-fleet/chatgpt-tunnel/adapter-token
Environment=HOME=/var/lib/automaton-fleet-chatgpt-tunnel
StateDirectory=automaton-fleet-chatgpt-tunnel
StateDirectoryMode=0700
RuntimeDirectory=automaton-fleet-chatgpt-tunnel
RuntimeDirectoryMode=0700
ExecStart=/opt/automaton-fleet/tunnel-client/v0.0.14/tunnel-client-runtime run \
  --control-plane.api-key=file:%d/openai-api-key \
  "--mcp.server-url=url=http://localhost/mcp,unix-socket=/run/automaton-fleet-chatgpt/adapter.sock" \
  "--mcp.extra-headers=X-Fleet-Adapter-Token: file:%d/adapter-token" \
  --health.unix-socket=/run/automaton-fleet-chatgpt-tunnel/health.sock \
  --log.format=json --log.level=info
UMask=0077

Restart=on-failure
RestartSec=10s
KillSignal=SIGTERM
TimeoutStopSec=15s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=automaton-fleet-chatgpt-tunnel

# Egress: public internet only (api.openai.com). Loopback and private ranges are
# denied except the systemd-resolved stub, so no local service is reachable.
IPAddressDeny=localhost link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7
IPAddressAllow=127.0.0.53/32 127.0.0.54/32
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK

NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
ProcSubset=pid
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
RemoveIPC=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
InaccessiblePaths=-/etc/automaton-fleet/admin.env -/etc/automaton-fleet/service.env -/etc/automaton-fleet/operator.env -/etc/automaton-fleet/tls -/etc/automaton-fleet/legacy-env-fleet.bak -/etc/automaton-fleet/chatgpt-adapter.json
InaccessiblePaths=-/home -/var/lib/automaton-fleet -/var/lib/automaton-fleet-witness -/var/lib/automaton-fleet-chatgpt-adapter -/var/log/automaton-fleet -/var/log/automaton-fleet-operator -/var/log/automaton-fleet-chatgpt-adapter -/opt/automaton-fleet/releases -/opt/automaton-fleet/chatgpt-adapter

[Install]
WantedBy=multi-user.target
```

## `deploy/systemd/automaton-fleet-operator-api.service`

sha256 `5f2454cf37accbba401eb5d624561d449360e88b622fe75c7db8789457b2d871` · 3261 bytes · 86 lines

```ini
# Automaton Fleet Operator API — Phase B2 (read-only, loopback-only).
#
# NOT enabled or started by any script. Installed by scripts/fleet-os-setup.sh;
# started only in its own approved deployment gate:
#   systemctl start automaton-fleet-operator-api.service
#
# Runs dist/fleet/operator/main.js from the pinned release as its own system
# user (in no other group). It holds only FLEET_OPERATOR_DATABASE_URL, read
# from /etc/automaton-fleet/operator.env (root:automaton-fleet-operator-api 0640)
# under the strict secret-file rules. It deliberately does NOT use
# LoadCredential: the verified systemd-credential exception stays limited to
# automaton-fleet.service. It never sees admin.env, service.env or TLS keys,
# listens on 127.0.0.1:8788 only, and its database role can execute only the
# read-only op_* functions. Bridges reach it through a restricted SSH tunnel.

[Unit]
Description=Automaton Fleet Operator API (read-only, loopback, signed requests)
Documentation=file:///opt/automaton-fleet/current/docs/design/phase-b-operator-api.md
Wants=postgresql.service
After=postgresql.service network-online.target automaton-fleet.service
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=exec
User=automaton-fleet-operator-api
Group=automaton-fleet-operator-api
SupplementaryGroups=
WorkingDirectory=/opt/automaton-fleet/current
ExecStart=/opt/automaton-fleet/node/bin/node dist/fleet/operator/main.js
# Non-secret configuration only; the credential is operator.env (see above).
Environment=NODE_ENV=production
Environment=FLEET_OPERATOR_EXPECTED_USER=automaton-fleet-operator-api
Environment=FLEET_OPERATOR_LISTEN=127.0.0.1:8788
Environment=FLEET_OPERATOR_ENV_FILE=/etc/automaton-fleet/operator.env
Environment=FLEET_RUNTIME_ENV_FILE=/etc/automaton-fleet/runtime.env
Environment=FLEET_OPERATOR_AUDIT_LOG=/var/log/automaton-fleet-operator/audit.jsonl
Environment=FLEET_OPERATOR_REQUIRE_TIMESYNC=true
LogsDirectory=automaton-fleet-operator
LogsDirectoryMode=0700
UMask=0077

Restart=on-failure
RestartSec=5s
KillSignal=SIGTERM
TimeoutStopSec=15s

StandardOutput=journal
StandardError=journal
SyslogIdentifier=automaton-fleet-operator-api

# Network: loopback only (PostgreSQL on 127.0.0.1; clients via SSH tunnel).
IPAddressDeny=any
IPAddressAllow=localhost
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

# Sandboxing
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
ProcSubset=pid
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RemoveIPC=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
# Controller secrets, TLS sources, other services' state/logs and homes are never visible.
InaccessiblePaths=-/etc/automaton-fleet/admin.env -/etc/automaton-fleet/service.env -/etc/automaton-fleet/tls -/etc/automaton-fleet/legacy-env-fleet.bak
InaccessiblePaths=-/home -/var/lib/automaton-fleet -/var/lib/automaton-fleet-witness -/var/log/automaton-fleet -/run/credentials

[Install]
WantedBy=multi-user.target
```

## `deploy/systemd/automaton-fleet-witness.service`

sha256 `b3447b8c26445f21dce2929ebd65dcd57fae6ae6a1eab22a22b343174e008b58` · 3077 bytes · 85 lines

```ini
# Automaton Fleet root witness — FLEET-KI-4 (temporary dry-run root parent).
#
# NOT enabled or started by any script. The operator starts it only for the
# dry run (docs/fleet-production-runbook.md, stage 22) and stops it afterwards:
#   systemctl start automaton-fleet-witness.service
#
# Runs dist/fleet/dry-run/root-main.js from the pinned release as its own
# system user (in no group with any fleet secret). It holds only its own
# witness credential (0600, in its 0700 state directory), talks only to the
# fleet service on loopback, and cannot read admin.env, service.env or TLS
# material. Its authority is limited server-side by capability scope 'witness'
# (session, heartbeat, health challenge, self), not by this unit.

[Unit]
Description=Automaton Fleet root witness (dry-run parent; heartbeat/challenge only)
Documentation=file:///opt/automaton-fleet/current/FLEET.md
Wants=automaton-fleet.service
After=automaton-fleet.service network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=exec
User=automaton-fleet-witness
Group=automaton-fleet-witness
SupplementaryGroups=
WorkingDirectory=/opt/automaton-fleet/current
ExecStart=/opt/automaton-fleet/node/bin/node dist/fleet/dry-run/root-main.js
# Non-secret configuration only; the credential is a 0600 file in the state directory.
Environment=NODE_ENV=production
Environment=HOME=/var/lib/automaton-fleet-witness
Environment=FLEET_API_URL=http://127.0.0.1:8787
Environment=FLEET_CREDENTIALS_FILE=/var/lib/automaton-fleet-witness/fleet-credentials.json
Environment=FLEET_RUNTIME_ENV_FILE=/etc/automaton-fleet/runtime.env
Environment=FLEET_WITNESS_INTERVAL_MS=30000
StateDirectory=automaton-fleet-witness
StateDirectoryMode=0700
UMask=0077

# 3 = the controller no longer accepts this witness; 4 = startup refusal. Never restart those.
Restart=on-failure
RestartSec=5s
RestartPreventExitStatus=3 4
KillSignal=SIGTERM
TimeoutStopSec=30s

StandardOutput=journal
StandardError=journal
SyslogIdentifier=automaton-fleet-witness

# Network: the fleet service on loopback only.
IPAddressDeny=any
IPAddressAllow=localhost
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

# Sandboxing
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
ProcSubset=pid
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RemoveIPC=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
# Controller secrets, TLS sources, other services' state and the agent's home are never visible.
InaccessiblePaths=-/etc/automaton-fleet/admin.env -/etc/automaton-fleet/service.env -/etc/automaton-fleet/tls -/etc/automaton-fleet/legacy-env-fleet.bak
InaccessiblePaths=-/home/automaton-agent -/var/lib/automaton-fleet -/var/log/automaton-fleet -/run/credentials

[Install]
WantedBy=multi-user.target
```

## `deploy/systemd/automaton-fleet.service`

sha256 `388f78e9b59bc9d4f7882d080eef2131448078189693c5533c4591428679d760` · 3385 bytes · 93 lines

```ini
# Automaton Fleet control service — Phase 4/6 (loopback only unless the remote drop-in is installed).
#
# Install (after approval): scripts/fleet-os-setup.sh --apply, then
#   systemctl daemon-reload && systemctl enable --now automaton-fleet.service
#
# Code:     /opt/automaton-fleet/current -> releases/<commit>  (root-owned, read-only)
# Node:     /opt/automaton-fleet/node/bin/node                   (root-owned, pinned copy)
# Secrets:  /etc/automaton-fleet/service.env (root:root 0600) delivered ONLY via
#           LoadCredential= to $CREDENTIALS_DIRECTORY/service.env — never via
#           Environment=/EnvironmentFile= (which would expose it in /proc/<pid>/environ
#           and `systemctl show`).
# Runtime:  /etc/automaton-fleet/runtime.env (non-secret pinned release + flags)

[Unit]
Description=Automaton Fleet control service (loopback only)
Documentation=file:///opt/automaton-fleet/current/FLEET.md
Wants=network-online.target postgresql.service
After=network-online.target postgresql.service
# Restart rate limit: at most 5 starts per 5 minutes, then stay failed for an operator.
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=exec
User=automaton-fleet-service
Group=automaton-fleet-service
WorkingDirectory=/opt/automaton-fleet/current
ExecStart=/opt/automaton-fleet/node/bin/node dist/fleet/service/main.js
LoadCredential=service.env:/etc/automaton-fleet/service.env
# Remote HTTPS (Phase 6) is NOT enabled here. It is a separate drop-in,
# deploy/systemd/automaton-fleet.service.d/remote.conf.example, installed only
# after DNS, certificate and firewall are approved; it also needs
# FLEET_REMOTE_LISTEN_ENABLED=true + FLEET_PUBLIC_* in runtime.env.
Environment=NODE_ENV=production
# The service refuses to start as root or as any other user.
Environment=FLEET_SERVICE_EXPECTED_USER=automaton-fleet-service
Environment=FLEET_RUNTIME_ENV_FILE=/etc/automaton-fleet/runtime.env
Environment=FLEET_AUDIT_LOG=/var/log/automaton-fleet/audit.jsonl
Environment=FLEET_API_LISTEN=127.0.0.1:8787
Environment=FLEET_SHUTDOWN_DRAIN_MS=10000

Restart=on-failure
RestartSec=5s
# Graceful shutdown: SIGTERM -> drain (10 s) -> exit 0; SIGKILL after 30 s.
KillSignal=SIGTERM
KillMode=mixed
TimeoutStopSec=30s
TimeoutStartSec=60s

# Logs: structured JSON lines on stdout -> journald.
StandardOutput=journal
StandardError=journal
SyslogIdentifier=automaton-fleet
LogsDirectory=automaton-fleet
LogsDirectoryMode=0700
StateDirectory=automaton-fleet
StateDirectoryMode=0700
UMask=0077

# Network: loopback only (also enforced in code). PostgreSQL is on localhost.
IPAddressDeny=any
IPAddressAllow=localhost
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

# Sandboxing
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
ProcSubset=pid
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RemoveIPC=yes
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
# Agents' homes and the admin credential are never visible to the service.
InaccessiblePaths=-/home/automaton-agent -/etc/automaton-fleet/admin.env

[Install]
WantedBy=multi-user.target
```

## `deploy/systemd/automaton-fleet.service.d/remote.conf.example`

sha256 `a90d9f396efdb8dee08a73cee2c914dacd65b7f84d8ebcc671416366a41991e2` · 1614 bytes · 26 lines

```ini
# /etc/systemd/system/automaton-fleet.service.d/remote.conf — Phase 6 remote HTTPS.
# NOT installed by any script. Install only after:
#   - DNS for FLEET_PUBLIC_HOSTNAME points at this host
#   - /etc/automaton-fleet/tls (root:automaton-fleet-admin 0750) holds
#     fleet.key (root:root 0600) and fleet.crt (root:root 0644) covering the
#     hostname (pnpm fleet:verify and scripts/fleet-verify-deployment.sh check this)
#   - the firewall allows ONLY 443/tcp inbound (deploy/firewall/fleet-firewall.sh)
#   - runtime.env sets FLEET_REMOTE_LISTEN_ENABLED=true, FLEET_PUBLIC_HOSTNAME,
#     FLEET_PUBLIC_LISTEN=0.0.0.0:443, FLEET_PUBLIC_URL and
#     FLEET_TLS_CERT_FILE=/run/credentials/automaton-fleet.service/tls.crt,
#     and does NOT set FLEET_TLS_KEY_FILE (an explicit key file gets no
#     systemd-credential exception and must be 0600 readable by the service).
# The service reads the key only as /run/credentials/automaton-fleet.service/tls.key,
# verified as the systemd credential of this unit (see src/fleet/secret-files.ts).
# It then serves HTTPS on 443 and keeps plain HTTP on 127.0.0.1:8787
# for local administration only; plain HTTP off loopback is refused in code.
[Service]
LoadCredential=tls.key:/etc/automaton-fleet/tls/fleet.key
LoadCredential=tls.crt:/etc/automaton-fleet/tls/fleet.crt
# Inbound HTTPS from anywhere (the firewall narrows it to 443/tcp);
# PostgreSQL/Redis stay loopback-only and are never proxied.
IPAddressDeny=
IPAddressAllow=any
# Bind 443 without root: only this one capability.
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE
```

## `package.json`

sha256 `ca91918749e59afc5ee68cad9b9ebe5ab9d615a2c7ebe7ecacb0546d89713165` · 3956 bytes · 107 lines

```json
{
  "name": "@conway/automaton",
  "version": "0.2.1",
  "description": "Conway Automaton - Sovereign AI Agent Runtime",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./config.js": {
      "types": "./dist/config.d.ts",
      "default": "./dist/config.js"
    },
    "./state/database.js": {
      "types": "./dist/state/database.d.ts",
      "default": "./dist/state/database.js"
    }
  },
  "bin": {
    "automaton": "dist/index.js",
    "conway-automaton": "dist/index.js"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/Conway-Research/automaton.git"
  },
  "homepage": "https://conway.tech",
  "keywords": [
    "autonomous-agent",
    "sovereign-ai",
    "web4",
    "conway",
    "self-replicating"
  ],
  "license": "MIT",
  "packageManager": "pnpm@10.28.1",
  "scripts": {
    "build": "tsc && pnpm -r build",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "test:coverage": "vitest run --coverage",
    "test:security": "vitest run -t 'security|injection|policy'",
    "test:financial": "vitest run -t 'financial|spend|treasury'",
    "test:fleet": "vitest run src/__tests__/fleet",
    "fleet:migrate": "tsx src/fleet/postgres/cli.ts migrate",
    "fleet:admin": "tsx src/fleet/postgres/cli.ts",
    "fleet:service": "tsx src/fleet/service/main.ts",
    "fleet:doctor": "tsx src/fleet/postgres/cli.ts doctor",
    "fleet:audit-privileges": "tsx src/fleet/postgres/cli.ts audit-privileges",
    "fleet:migrate-check": "tsx src/fleet/postgres/cli.ts migrate-check",
    "fleet:verify-runtime": "tsx src/fleet/postgres/cli.ts verify-runtime",
    "fleet:verify": "tsx src/fleet/postgres/cli.ts doctor --checklist",
    "fleet:operator-keygen": "tsx src/fleet/operator/keygen.ts",
    "fleet:bridge": "tsx src/fleet/bridge/cli.ts",
    "fleet:bridge-mcp": "tsx src/fleet/bridge/mcp.ts",
    "fleet:dry-run-child": "tsx src/fleet/postgres/cli.ts dry-run-child",
    "test:deploy": "vitest run src/__tests__/fleet/fleet-phase4.test.ts",
    "test:phase5": "vitest run src/__tests__/fleet/fleet-phase5.test.ts",
    "test:phase6": "vitest run src/__tests__/fleet/fleet-phase6.test.ts",
    "test:witness": "vitest run src/__tests__/fleet/fleet-witness.test.ts src/__tests__/fleet/fleet-witness-imports.test.ts",
    "test:redact": "vitest run src/__tests__/fleet/redact.test.ts src/__tests__/fleet/redact-sinks.test.ts",
    "test:operator": "vitest run src/__tests__/fleet/operator-canonical.test.ts src/__tests__/fleet/operator-pg.test.ts src/__tests__/fleet/operator-server.test.ts",
    "test:bridge": "vitest run src/__tests__/fleet/bridge-unit.test.ts src/__tests__/fleet/bridge-tunnel.test.ts src/__tests__/fleet/bridge-integration.test.ts src/__tests__/fleet/bridge-mcp.test.ts",
    "test:chatgpt": "vitest run src/__tests__/fleet/chatgpt-adapter.test.ts src/__tests__/fleet/chatgpt-adapter-imports.test.ts src/__tests__/fleet/chatgpt-tunnel-key.test.ts",
    "test:ci": "vitest run --reporter=verbose",
    "clean": "rm -rf dist && pnpm -r clean"
  },
  "dependencies": {
    "@solana/web3.js": "^1.98.0",
    "@types/better-sqlite3": "^7.6.0",
    "better-sqlite3": "^11.0.0",
    "bs58": "^6.0.0",
    "chalk": "^5.3.0",
    "cron-parser": "^4.9.0",
    "gray-matter": "^4.0.3",
    "js-tiktoken": "^1.0.21",
    "openai": "^6.24.0",
    "ora": "^8.0.0",
    "pg": "^8.23.0",
    "simple-git": "^3.24.0",
    "siwe": "^2.3.0",
    "tweetnacl": "^1.0.3",
    "ulid": "^2.3.0",
    "viem": "^2.44.2",
    "yaml": "^2.4.0"
  },
  "devDependencies": {
    "@types/node": "^20.10.0",
    "@types/pg": "^8.23.1",
    "tsx": "^4.7.0",
    "typescript": "^5.9.3",
    "vitest": "^2.0.0"
  },
  "engines": {
    "node": ">=20.0.0"
  },
  "pnpm": {
    "onlyBuiltDependencies": [
      "better-sqlite3",
      "esbuild"
    ]
  }
}
```

## `pnpm-workspace.yaml`

sha256 `0fb360452b0231d114d0b0ad6cc76bb48fe528382f55827cf93739bf64ec79e1` · 27 bytes · 2 lines

```yaml
packages:
  - "packages/*"
```

## `tsconfig.json`

sha256 `7a9a7c36771fcaaf2ca0f10ce03590d9d1b4e5957b67452630853cbc6184bd57` · 477 bytes · 20 lines

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["src/__tests__"]
}
```

## `vitest.config.ts`

sha256 `f85ee8f218fec8c42fd1dd6e1653d63956cae42ece05ed2286404f7a852d6c44` · 551 bytes · 25 lines

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    teardownTimeout: 5_000,
    include: ["src/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/__tests__/**",
        "src/types.ts",
        "node_modules/**",
      ],
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 55,
        lines: 60,
      },
      reporter: ["text", "text-summary", "json-summary"],
    },
  },
});
```

## `.gitignore`

sha256 `aa30d8abf33a7728dc3e3040eecf588bb90af3753d637b3af6da35829abc466d` · 136 bytes · 14 lines

```
node_modules
dist
.env
*.log
.DS_Store
*.db
*.db-journal
*.db-wal
*.db-shm
*.tgz
.automaton/wallet.json
.automaton/state.db

.env.fleet
```
