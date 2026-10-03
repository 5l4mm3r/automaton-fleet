#!/usr/bin/env bash
# Automaton Fleet — R36 TLS edge: nginx on :443 in front of FleetController (PROXY protocol v1) and the Admin dashboard.
#
#   scripts/fleet-edge.sh rehearse <pinsFile>
#       Production untouched. A fresh read-only dump is restored into a THROWAWAY database; a throwaway controller from
#       the candidate tooling (/var/tmp/rollout-tooling-<commit12>, made by fleet-rollout.sh rehearse) runs against it on
#       loopback ports with FLEET_PUBLIC_PROXY_PROTOCOL=true; a throwaway nginx (this release's edge config and unit,
#       re-pointed to test ports, self-signed certificates, an echo backend in place of the dashboard) listens on
#       <public IPv4>:18443 (closed by ufw) and 127.0.0.1:18443. Proves: TLS passthrough; the real client address reaches
#       the controller and the admin backend; client-supplied X-Forwarded-For is overwritten; proxied clients are never
#       local (/readyz 404, even from 127.0.0.1 through the edge); per-IP rate limits key on the real client; headerless
#       or forged-peer connections get nothing; the env-only rollback restores the direct listener. Writes
#       ~/fleet-edge-<commit7>-rehearsal.ok.
#   scripts/fleet-edge.sh cutover <pinsFile>
#       Refuses unless the running release IS the candidate (cut over by fleet-rollout.sh) and a passing edge rehearsal
#       of the same commit and edge files exists from the last 24 h. Then: admin.agentfleet.vip certificate (certbot
#       --standalone through the existing port-80 hooks; skipped if present), edge config + unit + renewal hook,
#       runtime.env backup, FLEET_PUBLIC_LISTEN=127.0.0.1:8443 + FLEET_PUBLIC_PROXY_PROTOCOL=true, controller restart,
#       edge start, verification. ANY failure after the env change rolls back automatically.
#   scripts/fleet-edge.sh rollback
#       Edge stopped and disabled, runtime.env.pre-edge restored, controller restarted on 0.0.0.0:443 (direct TLS).
#   scripts/fleet-edge.sh check-cert <lineage dir> <hostname>
#       Read-only: the lineage's private key matches its certificate (SHA-256 of the DER SubjectPublicKeyInfo, RSA or
#       EC), the certificate names <hostname> and is valid for 30 more days. Prints only public-key hashes.
#
# Runs as the operator account with sudo. Founder runtimes are never touched (they use http://127.0.0.1:8787, which
# this does not change). Real payments, owner sweeps, replication and the dry-run child flag are asserted false.
set -euo pipefail
export PATH=/opt/automaton-fleet/node/bin:$PATH
MODE="${1:-}"; PINS="${2:-}"
die() { echo "EDGE REFUSED: $*" >&2; exit 2; }
[[ "$MODE" == rehearse || "$MODE" == cutover || "$MODE" == rollback || "$MODE" == check-cert ]] || die "mode is rehearse, cutover, rollback or check-cert"
# Each public key is hashed into a variable. Never `sudo cmp <(…) <(…)`: sudo closes descriptors >= 3, so cmp cannot open
# /dev/fd/6x and fails as if the keys differed (the R36 edge cutover's false "admin key/cert mismatch", 2026-10-03).
spki_key() { sudo openssl pkey -in "$1" -pubout -outform DER | sha256sum | cut -d' ' -f1; }
spki_crt() { sudo openssl x509 -in "$1" -noout -pubkey | openssl pkey -pubin -outform DER | sha256sum | cut -d' ' -f1; }
check_cert() {
  local dir="$1" host="$2" kh ch
  sudo test -f "$dir/privkey.pem" && sudo test -f "$dir/fullchain.pem" || die "$dir: privkey.pem or fullchain.pem missing"
  kh=$(spki_key "$dir/privkey.pem") || die "$dir: private key unreadable"
  ch=$(spki_crt "$dir/fullchain.pem") || die "$dir: certificate unreadable"
  echo "certificate public key sha256 $ch; private key's public key sha256 $kh"
  [[ "$kh" =~ ^[0-9a-f]{64}$ && "$kh" != "$(printf '' | sha256sum | cut -d' ' -f1)" && "$kh" == "$ch" ]] || die "$host key/cert mismatch"
  sudo openssl x509 -in "$dir/fullchain.pem" -noout -checkend 2592000 > /dev/null || die "$host certificate expires within 30 days"
  sudo openssl x509 -in "$dir/fullchain.pem" -noout -ext subjectAltName | grep -qE "DNS:${host//./\\.}([,[:space:]]|\$)" || die "$host certificate lacks the hostname"
}
if [[ "$MODE" == check-cert ]]; then
  check_cert "${2:?lineage dir}" "${3:?hostname}"; echo "CERT OK $3"; exit 0
fi
ENVF=/etc/automaton-fleet/runtime.env; LIVE=automaton_fleet; F=01M3F50SH7PNX2E3GST13J52AS
ts() { date -u +%FT%TZ; }
live() { sudo -u postgres psql -X -At -d "$LIVE" -c "$1"; }
flags() { for k in REAL_REPLICATION_ENABLED REAL_PAYMENTS_ENABLED OWNER_SWEEP_ENABLED FLEET_DRY_RUN_CHILD; do grep -qx "$k=false" <(sudo grep -E "^$k=" $ENVF) || die "$k is not false"; done; }
FAKE="fa1.$(printf '0%.0s' {1..26}).$(printf 'A%.0s' {1..43})"
PUBIP=$(getent ahostsv4 api.agentfleet.vip | awk 'NR==1{print $1}'); [[ "$PUBIP" =~ ^[0-9.]+$ ]] || die "api.agentfleet.vip does not resolve"
code() { curl -s -o /dev/null -w '%{http_code}' -m 10 "$@" || true; }
fpr() { openssl s_client -connect "$1" -servername "$2" </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256 | cut -d= -f2; }
ctlpid() { systemctl show -p MainPID --value automaton-fleet.service; }
fpid() { systemctl show -p MainPID --value "automaton-fleet-founder@$F.service"; }
on443() { sudo ss -Hltnp 'sport = :443' | grep -oE 'users:\(\("[a-z]+",pid=[0-9]+' | sed -E 's/users:\(\("([a-z]+)",pid=([0-9]+)/\1:\2/' | sort -u | tr '\n' ' '; }

if [[ "$MODE" == rollback ]]; then
  REPORT=~/fleet-edge-rollback-$(date -u +%Y%m%dT%H%M%SZ).txt; exec > >(tee -a "$REPORT") 2>&1
  sudo test -f $ENVF.pre-edge || die "no $ENVF.pre-edge to restore"
  echo "== edge rollback $(ts)"
  sudo systemctl disable --now automaton-fleet-edge.service 2>/dev/null || true
  sudo cp -p $ENVF.pre-edge $ENVF
  sudo systemctl restart automaton-fleet.service
  for _ in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:8787/readyz 2>/dev/null && break; sleep 1; done
  sleep 1
  echo "public healthz $(code https://api.agentfleet.vip/healthz); :443 $(on443); controller pid $(ctlpid)"
  echo "== EDGE ROLLED BACK $(ts) (runtime.env.pre-edge kept for the record)"
  exit 0
fi

[[ -f "$PINS" && ! -L "$PINS" ]] || die "pins file missing"
grep -qxE 'FLEET_RUNTIME_REPO=https://github\.com/5l4mm3r/automaton-fleet\.git' "$PINS" || die "pins: unexpected repository"
C=$(sed -n 's/^FLEET_RUNTIME_COMMIT=\([0-9a-f]\{40\}\)$/\1/p' "$PINS"); B=$(sed -n 's/^FLEET_RUNTIME_BUILD_ID=\([0-9a-f]\{64\}\)$/\1/p' "$PINS")
L=$(sed -n 's/^FLEET_RUNTIME_LOCKFILE_SHA256=\([0-9a-f]\{64\}\)$/\1/p' "$PINS")
[[ -n "$C" && -n "$B" && -n "$L" && $(wc -l < "$PINS") -eq 4 ]] || die "pins file must hold exactly the four pins"
REPORT=~/fleet-edge-${C:0:7}-$MODE.txt
exec > >(tee -a "$REPORT") 2>&1
echo "== edge $MODE ${C:0:7} start $(ts) (public $PUBIP)"
flags
[[ -x /usr/sbin/nginx && -f /usr/lib/nginx/modules/ngx_stream_module.so ]] || die "nginx with the stream module is not installed"
! systemctl is-active --quiet nginx.service || die "the stock nginx.service is running (it must stay disabled: :80 belongs to certbot)"
edgesha() { (cd "$1" && sha256sum deploy/nginx/automaton-fleet-edge.conf deploy/systemd/automaton-fleet-edge.service deploy/letsencrypt/automaton-fleet-edge.sh) | awk '{print $1}' | sha256sum | cut -c1-64; }
PROD0="controller $(ctlpid) :443 $(on443)founder $(fpid) schema $(live 'SELECT max(version) FROM fleet.fleet_schema_migrations') head $(live 'SELECT head_seq FROM fleet.fleet_ledger_head')"
echo "production before: $PROD0"

if [[ "$MODE" == rehearse ]]; then
  TOOL=/var/tmp/rollout-tooling-${C:0:12}
  [[ -d $TOOL && "$(git -C $TOOL rev-parse HEAD)" == "$C" ]] || die "candidate tooling $TOOL missing (run fleet-rollout.sh rehearse first)"
  grep -q "listenProxied" $TOOL/src/fleet/service/server.ts || die "the candidate has no PROXY-protocol listener"
  RH=automaton_fleet_edge_rh; R=/run/fleet-edge-rh; SVCU=automaton-fleet-service
  for p in 18443 28443 28787 29443 28790; do [[ -z "$(ss -Hltn "sport = :$p")" ]] || die "port $p is in use"; done
  ! sudo ufw status | grep -qE '^(18443|28443|29443)' || die "ufw has a rule for a rehearsal port"
  cleanup() {
    sudo systemctl stop fleet-edge-rh.service fleet-edge-rh-controller.service fleet-edge-rh-echo.service 2>/dev/null || true
    sudo systemctl reset-failed fleet-edge-rh.service fleet-edge-rh-controller.service fleet-edge-rh-echo.service 2>/dev/null || true
    sudo rm -f /run/systemd/system/fleet-edge-rh.service; sudo systemctl daemon-reload
    sudo rm -rf "$R"
    if [[ -n "$(sudo -u postgres psql -X -At -d postgres -c "SELECT 1 FROM pg_database WHERE datname='$RH'")" ]]; then sudo -u postgres dropdb --force "$RH"; fi
  }
  trap cleanup EXIT
  cleanup
  rh() { sudo -u postgres psql -X -At -v ON_ERROR_STOP=1 -d "$RH" -c "$1"; }
  RHURL="postgresql://postgres@/$RH?host=/var/run/postgresql&options=-c%20role%3Dfleetadmin%20-c%20search_path%3Dfleet"
  sudo install -d -m 0711 -o root -g root $R; sudo install -d -m 0700 -o $SVCU -g $SVCU $R/svc; sudo install -d -m 0700 -o root -g root $R/nginx
  EMPTY=$R/empty.env; sudo install -m 0600 -o postgres -g postgres /dev/null $EMPTY
  cli() { sudo -u postgres env -i PATH="$PATH" HOME=/var/tmp FLEET_ADMIN_ENV_FILE=$EMPTY FLEET_RUNTIME_ENV_FILE=$EMPTY FLEET_ADMIN_DATABASE_URL="$RHURL" \
    FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git FLEET_RUNTIME_COMMIT=$C FLEET_RUNTIME_BUILD_ID=$B FLEET_RUNTIME_LOCKFILE_SHA256=$L \
    bash -c "cd $TOOL && node --import tsx src/fleet/postgres/cli.ts $*"; }

  # 1. Throwaway database from a fresh dump; only the controller's two restricted logins may connect.
  D=$R/live.dump; sudo -u postgres pg_dump -Fc -n fleet "$LIVE" | sudo install -m 0600 -o postgres -g postgres /dev/stdin $D
  sudo -u postgres createdb -O fleetadmin "$RH"
  sudo -u postgres psql -X -q -d postgres -c "REVOKE ALL ON DATABASE $RH FROM PUBLIC" -c "GRANT CONNECT ON DATABASE $RH TO fleet_service_login, fleet_agent_login"
  sudo -u postgres pg_restore -d "$RH" --exit-on-error < <(sudo cat $D)
  echo "throwaway database restored: schema $(rh 'SELECT max(version) FROM fleet.fleet_schema_migrations'), head $(rh 'SELECT head_seq FROM fleet.fleet_ledger_head')"
  cli approve-runtime 2>&1 | tail -1 | grep -q "$B" || die "candidate not approved in the throwaway registry"
  echo "throwaway registry approves ${C:0:7} (build ${B:0:12})"

  # 2. Self-signed certificates (the production API key is never copied).
  sslgen() { sudo openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 -subj "/CN=$1" -addext "subjectAltName=DNS:$1" -keyout "$2.key" -out "$2.crt" 2>/dev/null; }
  sslgen api.agentfleet.vip $R/svc/api; sudo chown $SVCU:$SVCU $R/svc/api.key $R/svc/api.crt; sudo chmod 0600 $R/svc/api.key; sudo chmod 0644 $R/svc/api.crt
  sslgen admin.agentfleet.vip $R/nginx/admin; sudo chmod 0600 $R/nginx/admin.key
  APIFP=$(sudo openssl x509 -in $R/svc/api.crt -noout -fingerprint -sha256 | cut -d= -f2)

  # 3. Throwaway controller env: the live runtime.env re-pointed (candidate pins, test ports, PROXY on, no reaper), and only
  #    the two restricted DSNs from service.env with the database name replaced (never printed).
  sudo grep -vE '^(FLEET_RUNTIME_(COMMIT|BUILD_ID|LOCKFILE_SHA256)|FLEET_API_LISTEN|FLEET_PUBLIC_LISTEN|FLEET_PUBLIC_PROXY_PROTOCOL|FLEET_REAPER_INTERVAL_MS|FLEET_TLS_(CERT|KEY)_FILE|FLEET_COGNITION_[A-Z_]*)=' $ENVF \
    | { cat; printf '%s\n' "FLEET_RUNTIME_COMMIT=$C" "FLEET_RUNTIME_BUILD_ID=$B" "FLEET_RUNTIME_LOCKFILE_SHA256=$L" FLEET_API_LISTEN=127.0.0.1:28787 \
        FLEET_PUBLIC_LISTEN=127.0.0.1:28443 FLEET_PUBLIC_PROXY_PROTOCOL=true FLEET_REAPER_INTERVAL_MS=0 FLEET_TLS_CERT_FILE=$R/svc/api.crt FLEET_TLS_KEY_FILE=$R/svc/api.key; } \
    | sudo install -m 0600 -o $SVCU -g $SVCU /dev/stdin $R/svc/runtime.env
  sudo grep -E '^(FLEET_SERVICE_DATABASE_URL|FLEET_AGENT_DATABASE_URL)=' /etc/automaton-fleet/service.env \
    | sed -E "s#(@[^/@]+/)$LIVE([?]|\$)#\1$RH\2#" | sudo install -m 0600 -o $SVCU -g $SVCU /dev/stdin $R/svc/service.env
  [[ "$(sudo grep -c "/$RH" $R/svc/service.env)" == 2 && "$(sudo grep -c "/$LIVE\([?]\|\$\)" $R/svc/service.env)" == 0 ]] || die "throwaway DSNs not re-pointed"
  ctl() {
    sudo systemctl reset-failed fleet-edge-rh-controller.service 2>/dev/null || true
    sudo systemd-run --quiet --unit=fleet-edge-rh-controller -p User=$SVCU -p Group=$SVCU -p WorkingDirectory=$TOOL -p UMask=0077 \
      --setenv=NODE_ENV=production --setenv=FLEET_SERVICE_EXPECTED_USER=$SVCU --setenv=FLEET_RUNTIME_ENV_FILE=$R/svc/runtime.env \
      --setenv=FLEET_SERVICE_ENV_FILE=$R/svc/service.env /opt/automaton-fleet/node/bin/node --import tsx src/fleet/service/main.ts
    for _ in $(seq 1 60); do [[ "$(code http://127.0.0.1:28787/readyz)" == 200 ]] && return 0; sleep 1; done
    sudo journalctl -u fleet-edge-rh-controller -o cat --no-pager | tail -5; die "throwaway controller not ready"
  }
  T0=$(date -u '+%F %T'); ctl
  echo "throwaway controller ready (R36 ${C:0:7}, PROXY listener 127.0.0.1:28443, direct 127.0.0.1:28787)"

  # 4. Echo backend in place of the dashboard (shows exactly the headers the edge forwards).
  sudo systemd-run --quiet --unit=fleet-edge-rh-echo -p DynamicUser=yes /usr/bin/python3 -c '
import http.server, json
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        b = json.dumps({"xff": self.headers.get_all("X-Forwarded-For"), "proto": self.headers.get("X-Forwarded-Proto"), "host": self.headers.get("Host"), "peer": self.client_address[0]}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", 28790), H).serve_forever()'
  for _ in $(seq 1 20); do [[ -n "$(ss -Hltn 'sport = :28790')" ]] && break; sleep 0.5; done

  # 5. This release's edge config and unit, re-pointed to the test ports and files.
  sed -e "s#^    listen 443;#    listen $PUBIP:18443;\n    listen 127.0.0.1:18443;#" -e 's#127\.0\.0\.1:8443;#127.0.0.1:28443;#' -e 's#127\.0\.0\.1:9443#127.0.0.1:29443#g' \
      -e 's#http://127\.0\.0\.1:8790;#http://127.0.0.1:28790;#' -e 's#/run/automaton-fleet-edge\.pid#/run/fleet-edge-rh.pid#' \
      -e 's#automaton-fleet-edge\.error\.log#fleet-edge-rh.error.log#' -e 's#zone=fleet_admin#zone=fleet_edge_rh#g' \
      -e "s#/etc/letsencrypt/live/admin.agentfleet.vip/fullchain.pem#$R/nginx/admin.crt#" -e "s#/etc/letsencrypt/live/admin.agentfleet.vip/privkey.pem#$R/nginx/admin.key#" \
      $TOOL/deploy/nginx/automaton-fleet-edge.conf | sudo install -m 0600 /dev/stdin $R/nginx/edge.conf
  ! sudo grep -nE 'listen 443;|:8443;|:9443|:8790;|automaton-fleet-edge\.pid|letsencrypt' $R/nginx/edge.conf || die "rehearsal config still names a production port or file"
  sed -e "s#/etc/nginx/automaton-fleet-edge\.conf#$R/nginx/edge.conf#g" -e 's#/run/automaton-fleet-edge\.pid#/run/fleet-edge-rh.pid#g' -e 's#SyslogIdentifier=automaton-fleet-edge#SyslogIdentifier=fleet-edge-rh#' \
      -e 's#^Restart=on-failure#Restart=no#' $TOOL/deploy/systemd/automaton-fleet-edge.service | sudo install -m 0644 /dev/stdin /run/systemd/system/fleet-edge-rh.service
  sudo /usr/sbin/nginx -t -q -c $R/nginx/edge.conf
  sudo systemctl daemon-reload; sudo systemctl start fleet-edge-rh.service
  echo "throwaway edge running (this release's config and unit): $(ss -Hltn 'sport = :18443' | awk '{print $4}' | tr '\n' ' ')"

  # 6. Proofs.
  P=0; pass() { echo "  PASS $*"; P=$((P + 1)); }; fail() { echo "  FAIL $*"; exit 1; }
  API="--resolve api.agentfleet.vip:18443:$PUBIP https://api.agentfleet.vip:18443"; APILO="--resolve api.agentfleet.vip:18443:127.0.0.1 https://api.agentfleet.vip:18443"
  ADM="--resolve admin.agentfleet.vip:18443:$PUBIP https://admin.agentfleet.vip:18443"
  [[ "$(fpr $PUBIP:18443 api.agentfleet.vip)" == "$APIFP" ]] && pass "TLS passthrough: the edge serves the controller's own certificate for api.agentfleet.vip" || fail "api certificate is not the controller's"
  [[ "$(fpr $PUBIP:18443 unknown.example)" == "$APIFP" && "$(openssl s_client -connect $PUBIP:18443 </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256 | cut -d= -f2)" == "$APIFP" ]] \
    && pass "unknown or absent SNI still reaches the controller (as today)" || fail "default route"
  [[ "$(code -k $API/healthz)" == 200 && "$(code -k $APILO/healthz)" == 200 ]] && pass "api /healthz 200 through the edge (public address and loopback)" || fail "api healthz"
  [[ "$(code -k $API/readyz)" == 404 && "$(code -k $APILO/readyz)" == 404 ]] && pass "/readyz is 404 through the edge, even for a client at 127.0.0.1" || fail "/readyz exposed"
  [[ "$(code http://127.0.0.1:28787/readyz)" == 200 ]] && pass "/readyz still 200 on the direct loopback listener" || fail "direct readyz"
  [[ "$(code -k -H 'Origin: https://evil.example' $API/healthz)" == 403 ]] || fail "origin refusal"
  sleep 1
  IPS=$(sudo journalctl -u fleet-edge-rh-controller --since "$T0" -o cat --no-pager | grep '"api_origin_denied"' | grep -oE '"ip":"[^"]*"' | sort -u | tr '\n' ' ')
  [[ "$IPS" == *"\"ip\":\"$PUBIP\""* ]] && pass "real client address reaches the controller (audit ip $PUBIP, not 127.0.0.1)" || fail "controller saw: $IPS"
  [[ "$(code -k -X POST -H "Authorization: Bearer $FAKE" $APILO/v1/session)" == 401 ]] || fail "loopback-sourced proxied session"
  N429=0; for _ in $(seq 1 36); do [[ "$(code -k -X POST -H "Authorization: Bearer $FAKE" $API/v1/session)" == 429 ]] && N429=$((N429 + 1)); done
  OTHER=$(code -k -X POST -H "Authorization: Bearer $FAKE" $APILO/v1/session)
  (( N429 > 0 )) && [[ "$OTHER" == 401 ]] && pass "per-IP limit: $PUBIP got $N429 x 429 after its budget; another client (127.0.0.1) still got 401, not 429" || fail "rate limit ($N429 x 429, other $OTHER)"
  EV=$(rh "SELECT string_agg(DISTINCT detail->>'ip', ' ') FROM fleet.fleet_events WHERE event_type = 'api_auth_failed' AND created_at > now() - interval '10 minutes'" 2>/dev/null || true)
  [[ "$EV" == *"$PUBIP"* ]] && pass "auth-failure events carry the real client address ($EV)" || echo "  note: auth-failure event addresses: ${EV:-none recorded}"
  [[ "$(code -k --http1.1 --connect-to ::127.0.0.1:28443 https://api.agentfleet.vip/healthz)" == 000 ]] && pass "the controller's PROXY listener gives nothing to a client without a PROXY header" || fail "headerless connection served"
  R2=$(python3 -c '
import socket, ssl
s = socket.socket(); s.settimeout(5); s.bind(("127.0.0.2", 0)); s.connect(("127.0.0.1", 28443))
s.sendall(b"PROXY TCP4 203.0.113.9 10.0.0.1 1 443\r\n")
try:
    ssl._create_unverified_context().wrap_socket(s, server_hostname="api.agentfleet.vip"); print("served")
except Exception:
    print("refused")' 2>/dev/null || echo refused)
  [[ "$R2" == refused ]] && pass "a peer other than 127.0.0.1 (127.0.0.2) is refused before any header is read" || fail "forged-peer connection served"
  J=$(curl -sk -m 10 -H 'X-Forwarded-For: 6.6.6.6' -H 'X-Forwarded-Proto: http' $ADM/login/)
  [[ "$J" == *"\"xff\": [\"$PUBIP\"]"* && "$J" == *'"proto": "https"'* && "$J" == *'"host": "admin.agentfleet.vip"'* && "$J" != *6.6.6.6* ]] \
    && pass "admin backend receives X-Forwarded-For=$PUBIP only (client-supplied 6.6.6.6 dropped), proto https" || fail "admin headers: $J"
  [[ "$(code -k --resolve admin.agentfleet.vip:18443:$PUBIP -H 'Host: api.agentfleet.vip' https://admin.agentfleet.vip:18443/)" == 421 ]] && pass "admin TLS with another Host header is refused (421)" || fail "host mismatch"
  [[ "$(code -k --resolve admin.agentfleet.vip:29443:127.0.0.1 https://admin.agentfleet.vip:29443/)" == 000 ]] && pass "the admin TLS listener requires the PROXY line (direct connections fail)" || fail "admin listener without PROXY"
  [[ "$(sudo nsenter -t "$(systemctl show -p MainPID --value fleet-edge-rh.service)" -m test -r /etc/letsencrypt/live/api.agentfleet.vip/privkey.pem && echo y || echo n)" == n ]] \
    && pass "the edge unit cannot read the API certificate's private key" || fail "edge can read the API key"
  ! sudo ufw status | grep -qE '^(18443|28443|29443)' && pass "ufw has no rule for any rehearsal port (18443 is not reachable from outside)" || fail "ufw rule"

  # 7. Rollback proof (env only): the same R36 code, PROXY off and a direct TLS listener, serves the controller certificate.
  sudo systemctl stop fleet-edge-rh.service fleet-edge-rh-controller.service
  sudo sed -i -e '/^FLEET_PUBLIC_PROXY_PROTOCOL=/d' $R/svc/runtime.env
  ctl
  [[ "$(fpr 127.0.0.1:28443 api.agentfleet.vip)" == "$APIFP" && "$(code -k --resolve api.agentfleet.vip:28443:127.0.0.1 https://api.agentfleet.vip:28443/healthz)" == 200 ]] \
    && pass "rollback (env only): PROXY off, direct TLS listener serves /healthz 200 with the controller certificate" || fail "env rollback"
  echo "rollback (code): R35 f4be395 stays in /opt/automaton-fleet/releases; fleet-rollout.sh restores it with runtime.env.pre-<commit7>"

  PROD1="controller $(ctlpid) :443 $(on443)founder $(fpid) schema $(live 'SELECT max(version) FROM fleet.fleet_schema_migrations') head $(live 'SELECT head_seq FROM fleet.fleet_ledger_head')"
  [[ "$PROD1" == "$PROD0" ]] && pass "production untouched: $PROD1" || fail "production changed: $PROD0 -> $PROD1"
  flags
  echo "$C $(edgesha $TOOL) $(ts)" > ~/fleet-edge-${C:0:7}-rehearsal.ok
  echo "== EDGE REHEARSAL PASSED $(ts): $P checks"
  exit 0
fi

# ── cutover ──
OK=~/fleet-edge-${C:0:7}-rehearsal.ok
[[ -f "$OK" ]] && read -r RC RS RAT < "$OK" || die "no passing edge rehearsal of ${C:0:7} on this host"
[[ "$(sudo sed -n 's/^FLEET_RUNTIME_COMMIT=//p' $ENVF)" == "$C" && "$(readlink /opt/automaton-fleet/current)" == "releases/$C" ]] || die "the running release is not ${C:0:7} (cut it over with fleet-rollout.sh first)"
REL=/opt/automaton-fleet/current
[[ "$RC" == "$C" && "$RS" == "$(edgesha $REL)" ]] || die "the rehearsal was for a different commit or edge files"
(( $(date +%s) - $(date -d "$RAT" +%s) < 86400 )) || die "the edge rehearsal is older than 24 hours: rehearse again"
grep -q "listenProxied" $REL/dist/fleet/service/server.js || die "the running release has no PROXY-protocol listener"
sudo grep -qx 'FLEET_PUBLIC_LISTEN=0.0.0.0:443' $ENVF || die "runtime.env is not in the expected pre-edge state (FLEET_PUBLIC_LISTEN=0.0.0.0:443)"
! sudo grep -q '^FLEET_PUBLIC_PROXY_PROTOCOL=' $ENVF || die "runtime.env already names FLEET_PUBLIC_PROXY_PROTOCOL"
sudo test ! -e $ENVF.pre-edge || die "a previous edge attempt left $ENVF.pre-edge (run rollback, then move it aside)"
systemctl is-active --quiet automaton-fleet-dashboard.service && [[ -n "$(ss -Hltn 'src 127.0.0.1 and sport = :8790')" ]] || die "the dashboard is not running on 127.0.0.1:8790"
[[ -z "$(ss -Hltn 'sport = :80')" ]] || die ":80 is in use (certbot --standalone needs it)"
for p in 8443 9443; do [[ -z "$(ss -Hltn "sport = :$p")" ]] || die "port $p is in use"; done

# 1. Admin certificate (no outage). The port-80 hooks only run for renewals, so they are called explicitly here.
LIN=/etc/letsencrypt/live/admin.agentfleet.vip
if ! sudo test -f $LIN/fullchain.pem; then
  sudo /usr/local/sbin/fleet-certbot-port80 open
  trap 'sudo /usr/local/sbin/fleet-certbot-port80 close' EXIT
  sudo certbot certonly --standalone --preferred-challenges http -d admin.agentfleet.vip --non-interactive --agree-tos --keep-until-expiring
  sudo /usr/local/sbin/fleet-certbot-port80 close; trap - EXIT
fi
check_cert $LIN admin.agentfleet.vip
echo "admin certificate: $(sudo openssl x509 -in $LIN/fullchain.pem -noout -enddate -issuer | tr '\n' ' ')"

# 2. Edge files (no outage).
sudo install -m 0644 -o root -g root $REL/deploy/nginx/automaton-fleet-edge.conf /etc/nginx/automaton-fleet-edge.conf
sudo install -m 0644 -o root -g root $REL/deploy/systemd/automaton-fleet-edge.service /etc/systemd/system/automaton-fleet-edge.service
sudo install -m 0755 -o root -g root $REL/deploy/letsencrypt/automaton-fleet-edge.sh /etc/letsencrypt/renewal-hooks/deploy/automaton-fleet-edge.sh
sudo systemctl daemon-reload
sudo /usr/sbin/nginx -t -q -c /etc/nginx/automaton-fleet-edge.conf
APIFP0=$(fpr $PUBIP:443 api.agentfleet.vip); echo "api certificate before: ${APIFP0:0:23}…"

# 3. Switch (short outage of the public listener only; Founder 1 uses the unchanged 127.0.0.1:8787).
sudo cp -p $ENVF $ENVF.pre-edge
rollback() {
  echo "!! FAILURE: $1 — automatic rollback $(ts)"
  sudo systemctl disable --now automaton-fleet-edge.service 2>/dev/null || true
  sudo cp -p $ENVF.pre-edge $ENVF
  sudo systemctl restart automaton-fleet.service
  for _ in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:8787/readyz 2>/dev/null && break; sleep 1; done
  sleep 1
  echo "OUTAGE END (ROLLED BACK) $(ts): public healthz $(code https://api.agentfleet.vip/healthz), :443 $(on443)"
  echo "== EDGE ${C:0:7} ROLLED BACK"
  exit 1
}
sudo sed -i -e 's/^FLEET_PUBLIC_LISTEN=.*/FLEET_PUBLIC_LISTEN=127.0.0.1:8443/' $ENVF
echo "FLEET_PUBLIC_PROXY_PROTOCOL=true" | sudo tee -a $ENVF > /dev/null
for _ in $(seq 1 90); do [ "$(live 'SELECT count(*) FROM fleet.fleet_cognition_inflight')" = 0 ] && break; sleep 2; done
echo "OUTAGE START $(ts)"
sudo systemctl restart automaton-fleet.service || rollback "controller restart failed"
READY=0; for _ in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:8787/readyz 2>/dev/null && { READY=1; break; }; sleep 1; done
[[ $READY == 1 ]] || rollback "controller not ready"
[[ -n "$(ss -Hltn 'src 127.0.0.1 and sport = :8443')" && -z "$(on443)" ]] || rollback "controller is not on 127.0.0.1:8443 only"
sudo systemctl start automaton-fleet-edge.service || rollback "edge did not start"
OKH=0; for _ in $(seq 1 20); do [[ "$(code https://api.agentfleet.vip/healthz)" == 200 ]] && { OKH=1; break; }; sleep 1; done
echo "OUTAGE END $(ts)"
[[ $OKH == 1 ]] || rollback "api.agentfleet.vip/healthz is not 200 through the edge"

# 4. Verification (any failure rolls back).
[[ "$(fpr $PUBIP:443 api.agentfleet.vip)" == "$APIFP0" ]] || rollback "the API certificate served changed"
[[ "$(code https://api.agentfleet.vip/readyz)" == 404 ]] || rollback "/readyz is reachable publicly"
[[ "$(code https://admin.agentfleet.vip/login/)" == 200 ]] || rollback "admin /login/ is not 200 with a valid certificate"
curl -sS -m 10 -D - -o /dev/null https://admin.agentfleet.vip/login/ | grep -qi "^content-security-policy: default-src 'none'" || rollback "admin CSP missing"
[[ "$(code -X POST -H 'Origin: https://admin.agentfleet.vip' -H 'Content-Type: application/json' -d '{}' https://admin.agentfleet.vip/api/call)" == 401 ]] || rollback "unauthenticated admin API not rejected"
T1=$(date -u '+%F %T'); [[ "$(code -H 'Origin: https://evil.example' https://api.agentfleet.vip/healthz)" == 403 ]] || rollback "origin refusal"; sleep 1
sudo journalctl -u automaton-fleet.service --since "$T1" -o cat --no-pager | grep '"api_origin_denied"' | grep -q "\"ip\":\"$PUBIP\"" || rollback "the controller did not see the real client address"
[[ -z "$(ss -Hltn 'sport = :8790' | grep -v '127.0.0.1:8790')" ]] || rollback "the dashboard listens beyond loopback"
systemctl is-active --quiet "automaton-fleet-founder@$F.service" || rollback "Founder 1 is not active"
flags
sudo systemctl enable automaton-fleet-edge.service 2>&1 | tail -1 || true
echo "verified: api /healthz 200 (same certificate), /readyz 404, admin /login/ 200 with CSP, admin API 401 unauthenticated, real client address $PUBIP at the controller"
echo "production after: controller $(ctlpid) founder $(fpid) :443 $(on443)edge $(systemctl is-active automaton-fleet-edge.service)"
echo "rollback: scripts/fleet-edge.sh rollback (restores $ENVF.pre-edge)"
echo "== EDGE ${C:0:7} DEPLOYED $(ts)"
