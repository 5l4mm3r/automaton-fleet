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
#   - custody executor (schema v10, when installed): its user reads no other
#     secret and is in no other group; custody.env (root:automaton-fleet-custody
#     0640) is readable by no other fleet user and holds only the custody DB
#     login; the executor holds no TCP listener
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

echo "Custody executor isolation (Phase E, schema v10; inert)"
CX=automaton-fleet-custody
if id "$CX" >/dev/null 2>&1; then
  [[ "$(id -nG "$CX")" == "$CX" ]] && ok "$CX is in no other group" || bad "$CX groups: $(id -nG "$CX")"
  for f in "$ETC/admin.env" "$ETC/service.env" "$ETC/operator.env" "$ETC/tls/fleet.key" "$ETC/legacy-env-fleet.bak"; do
    [[ -e "$f" ]] || continue
    if runuser -u "$CX" -- test -r "$f" 2>/dev/null; then bad "$CX CAN read $f"; else ok "$CX cannot read $f"; fi
  done
  CXENV="$ETC/custody.env"
  if [[ -L "$CXENV" ]]; then bad "$CXENV is a symlink"
  elif [[ -f "$CXENV" ]]; then
    got="$(stat -c '%U:%G %a %h' "$CXENV")"
    [[ "$got" == "root:$CX 640 1" ]] && ok "$CXENV is root:$CX 640 (single link)" || bad "$CXENV is $got (expected root:$CX 640 1)"
    for u in automaton-agent automaton-fleet-service automaton-fleet-witness automaton-fleet-operator-api automaton-fleet-chatgpt-adapter automaton-fleet-chatgpt-tunnel "${SUDO_USER:-}"; do
      [[ -n "$u" ]] && id "$u" >/dev/null 2>&1 || continue
      if runuser -u "$u" -- test -r "$CXENV" 2>/dev/null; then bad "$u CAN read $CXENV"; else ok "$u cannot read $CXENV"; fi
    done
    # v10 is inert: exactly one key, the restricted DB login; never a custody/provider credential.
    keys="$(grep -E '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=' "$CXENV" | sed -E 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*).*/\2/' | sort -u | tr '\n' ' ')"
    [[ "$keys" == "FLEET_CUSTODY_DATABASE_URL " ]] && ok "$CXENV holds only the custody DB login (no custody credential)" || bad "$CXENV holds unexpected keys: $keys"
  else
    bad "$CXENV missing"
  fi
  uidn="$(id -u "$CX")"
  if ss -ltneH 2>/dev/null | grep -qE "uid:$uidn( |$)"; then bad "$CX holds a TCP listener"; else ok "$CX holds no TCP listener"; fi
  if [[ "$(systemctl is-enabled automaton-fleet-custody.service 2>/dev/null)" == enabled ]]; then
    [[ "$(systemctl is-active automaton-fleet-custody.service 2>/dev/null)" == active ]] && ok "custody executor is running (inert)" || bad "custody executor is enabled but not running"
  fi
else
  ok "custody executor not installed"
fi

echo "Genesis founder runtimes (Phase F.1)"
FT=/etc/systemd/system/automaton-fleet-founder@.service
if [[ -f "$FT" ]]; then
  for prop in "DynamicUser=yes" "User=fnd-%i" "IPAddressDeny=any" "IPAddressAllow=localhost" "NoNewPrivileges=true" "ProtectSystem=strict" "StateDirectoryMode=0700" "Environment=FLEET_CAPABILITY_MANIFEST=founder-v2" "Environment=FLEET_FOUNDER_AGENT_LOOP=controller" "SystemCallFilter=@sandbox"; do
    grep -qx "$prop" "$FT" && ok "founder template: $prop" || bad "founder template lacks $prop"
  done
  grep -q -- "-/etc/automaton-fleet/custody.env" "$FT" && grep -q -- "-/etc/automaton-fleet/admin.env" "$FT" && ok "founder template hides fleet secrets" || bad "founder template does not hide fleet secrets"
  active="$(systemctl list-units --all --plain --no-legend 'automaton-fleet-founder@*' 2>/dev/null | awk '$3 != "inactive" {print $1}' | wc -l)"
  living="$(runuser -u postgres -- psql -X -At -d "${FLEET_DB_NAME:-automaton_fleet}" -c "SELECT count(*) FROM fleet.fleet_agents WHERE origin IN ('genesis_founder','reseed_founder') AND status IN ('active','unresponsive')" 2>/dev/null || echo "?")"
  [[ "$active" == "$living" ]] && ok "founder runtime units active: $active (living founders: $living)" || bad "founder runtime units active: $active, living founders: $living"
  # Live-update safety: no start limit (an outage is retried), refusals never restart.
  grep -qx "StartLimitIntervalSec=0" "$FT" && grep -qx "RestartPreventExitStatus=3 4" "$FT" && ok "founder template: outages are retried, refusals never restart" || bad "founder template restart policy is not live-update safe"
  # Every living founder runs ONLY its registered release (never /opt/automaton-fleet/current).
  while IFS='|' read -r fid fcommit; do
    [[ -n "$fid" ]] || continue
    unit="automaton-fleet-founder@$fid.service"
    wd="$(systemctl show -p WorkingDirectory --value "$unit" 2>/dev/null)"
    pin="/etc/automaton-fleet/founders/$fid.runtime.env"
    pc="$(grep -oP '^FLEET_RUNTIME_COMMIT=\K[0-9a-f]{40}$' "$pin" 2>/dev/null)"
    envf="$(systemctl show -p Environment --value "$unit" 2>/dev/null | tr ' ' '\n' | grep -oP '^FLEET_RUNTIME_ENV_FILE=\K.*')"
    if [[ "$wd" == "/opt/automaton-fleet/releases/$fcommit" && "$pc" == "$fcommit" && "$envf" == "$pin" && -d "$wd" ]]; then
      ok "founder ${fid: -6} pinned to its registered release ${fcommit:0:7}"
    else
      bad "founder ${fid: -6} not pinned to its registered release ${fcommit:0:7} (WorkingDirectory=$wd, pin=${pc:-none}, env=${envf:-?})"
    fi
  done < <(runuser -u postgres -- psql -X -At -F '|' -d "${FLEET_DB_NAME:-automaton_fleet}" -c "SELECT agent_id, runtime_commit FROM fleet.fleet_agents WHERE origin IN ('genesis_founder','reseed_founder') AND status IN ('active','unresponsive') ORDER BY agent_id" 2>/dev/null)
  left="$(ls -A /var/lib/private/automaton-founders 2>/dev/null | wc -l)"
  [[ "$left" -le "$living" || "$living" == "?" ]] && ok "founder state directories: $left" || bad "founder state directories: $left (living founders: $living)"
else
  ok "founder runtime template not installed"
fi

echo "Inference-provider credential isolation (pre-Genesis hardening L8)"
CK=/etc/automaton-fleet/cognition.key
for u in automaton-fleet-witness automaton-fleet-custody automaton-fleet-founder@ automaton-fleet-operator-api automaton-fleet-chatgpt-tunnel automaton-fleet-chatgpt-adapter; do
  UF="/etc/systemd/system/$u.service"
  [[ -f "$UF" ]] || continue
  grep -qx "InaccessiblePaths=-$CK" "$UF" && ok "$u hides $CK" || bad "$u does not hide $CK"
done
grep -qx "LimitCORE=0" /etc/systemd/system/automaton-fleet.service && ok "controller: no core dumps (LimitCORE=0)" || bad "controller allows core dumps"
if [[ -e "$CK" || -L "$CK" ]]; then
  if [[ -L "$CK" ]]; then bad "$CK is a symlink"
  else
    m="$(stat -c '%a %U:%G' "$CK")"
    [[ "$m" == "600 automaton-fleet-service:automaton-fleet-service" ]] && ok "$CK is 600 automaton-fleet-service (content not read)" || bad "$CK is $m (want 600 automaton-fleet-service:automaton-fleet-service)"
  fi
  for u in automaton-agent automaton-fleet-witness automaton-fleet-operator-api automaton-fleet-chatgpt-adapter automaton-fleet-chatgpt-tunnel automaton-fleet-custody "${SUDO_USER:-}"; do
    [[ -n "$u" ]] && id "$u" >/dev/null 2>&1 || continue
    if runuser -u "$u" -- test -r "$CK" 2>/dev/null; then bad "$u CAN read $CK"; else ok "$u cannot read $CK"; fi
  done
else
  ok "no inference-provider credential installed"
fi

echo "Research fetcher isolation (Pre-Genesis step 4)"
FU=automaton-fleet-fetcher; FS=/etc/systemd/system/automaton-fleet-fetcher.service; FK=/etc/systemd/system/automaton-fleet-fetcher.socket
if [[ -f "$FS" ]]; then
  if id "$FU" >/dev/null 2>&1; then
    [[ "$(id -nG "$FU")" == "$FU" ]] && ok "$FU is in no other group" || bad "$FU groups: $(id -nG "$FU")"
  else bad "$FU user missing"; fi
  for prop in "User=$FU" "NoNewPrivileges=true" "ProtectSystem=strict" "ProtectHome=yes" "CapabilityBoundingSet=" "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX"; do
    grep -qx "$prop" "$FS" && ok "fetcher unit: $prop" || bad "fetcher unit lacks $prop"
  done
  grep -q "^IPAddressDeny=localhost link-local multicast 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 172.16.0.0/12" "$FS" && ok "fetcher unit: kernel egress denies loopback/private/link-local/CGNAT" || bad "fetcher unit: private-destination deny missing"
  [[ -f /etc/systemd/system/automaton-fleet-fetcher.service.d/host-addresses.conf ]] && ok "fetcher unit: this host's own addresses denied ($(grep -oP '^IPAddressDeny=\K.*' /etc/systemd/system/automaton-fleet-fetcher.service.d/host-addresses.conf | wc -w) address(es))" || bad "fetcher host-address deny drop-in missing"
  HD=/etc/systemd/system/automaton-fleet-fetcher.service.d/host-addresses.conf
  [[ -f "$HD" ]] && [[ "$(grep -oP '^IPAddressDeny=\K.*' "$HD" | tr ' ' ',')" == "$(grep -oP '^Environment=FLEET_FETCHER_HOST_ADDRESSES=\K.*' "$HD")" ]] \
    && ok "fetcher knows the same host addresses the kernel denies" || bad "fetcher host-address list missing or differs from the kernel deny"
  grep -q -- "-/etc/automaton-fleet " "$FS" && grep -q -- "-/var/lib/postgresql" "$FS" && grep -q -- "-/var/lib/private" "$FS" && ok "fetcher unit hides fleet secrets, PostgreSQL and founder state" || bad "fetcher unit does not hide secrets/state"
  grep -qE "^(EnvironmentFile|LoadCredential|SetCredential)" "$FS" && bad "fetcher unit loads files/credentials" || ok "fetcher unit loads no environment file or credential"
  grep -qx "SocketGroup=automaton-fleet-service" "$FK" && grep -qx "SocketMode=0660" "$FK" && ok "fetcher socket: controller group only, 0660" || bad "fetcher socket permissions wrong"
  if [[ -S /run/automaton-fleet-fetcher/fetch.sock ]]; then
    m="$(stat -c '%a %U:%G' /run/automaton-fleet-fetcher/fetch.sock)"
    [[ "$m" == "660 $FU:automaton-fleet-service" ]] && ok "fetcher socket on disk: $m" || bad "fetcher socket on disk: $m"
  fi
  for f in /etc/automaton-fleet/service.env /etc/automaton-fleet/admin.env /etc/automaton-fleet/operator.env /etc/automaton-fleet/custody.env /etc/automaton-fleet/cognition.key /etc/automaton-fleet/tls/fleet.key /var/lib/postgresql/*/main; do
    # /var/lib/postgresql itself is world-listable by distro default (no secrets); its cluster data directories are what matter.
    [[ -e "$f" ]] || continue
    if runuser -u "$FU" -- test -r "$f" 2>/dev/null || runuser -u "$FU" -- test -x "$f" 2>/dev/null; then bad "$FU CAN read $f"; else ok "$FU cannot read $f"; fi
  done
  # Live probe (no network): the controller's user reaches the fetcher, and the fetcher refuses a loopback literal itself.
  if systemctl is-active -q automaton-fleet-fetcher.socket; then
    PR="$(runuser -u automaton-fleet-service -- curl -s --max-time 10 --unix-socket /run/automaton-fleet-fetcher/fetch.sock -H 'content-type: application/json' -d '{"url":"https://127.0.0.1/"}' http://fetcher/fetch 2>/dev/null)"
    [[ "$PR" == *'"code":"RESEARCH_IP_LITERAL_REFUSED"'* ]] && ok "fetcher answers the controller and refuses a loopback literal" || bad "fetcher live probe failed: ${PR:0:120}"
  else
    bad "fetcher socket is not active"
  fi
  grep -qx "InaccessiblePaths=-/run/automaton-fleet-fetcher" /etc/systemd/system/automaton-fleet-founder@.service && ok "founder template hides the fetcher socket" || bad "founder template does not hide the fetcher socket"
  FP="$(systemctl show -p MainPID --value automaton-fleet-fetcher.service 2>/dev/null)"
  if [[ -n "$FP" && "$FP" != "0" ]]; then
    tr '\0' '\n' < /proc/$FP/environ | cut -d= -f1 | grep -qiE "DATABASE_URL|API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE|COGNITION" && bad "fetcher process environment holds credential-like variables" || ok "fetcher process environment holds no credential-like variables"
  fi
  fuid="$(id -u "$FU" 2>/dev/null || echo x)"
  if ss -ltnH -e 2>/dev/null | grep -qE "uid:$fuid( |$)"; then bad "$FU holds a TCP listener"; else ok "$FU holds no TCP listener"; fi
else
  ok "research fetcher not installed"
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
