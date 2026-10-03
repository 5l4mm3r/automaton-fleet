#!/usr/bin/env bash
# /etc/letsencrypt/renewal-hooks/deploy/automaton-fleet-edge.sh (root:root 0755) — R36.
# A renewed admin.agentfleet.vip certificate is served by the TLS edge (nginx): validate it, then reload the edge.
# nginx re-validates the configuration first and keeps serving the previous certificate if the reload fails.
# Other lineages (api.agentfleet.vip: automaton-fleet.sh) are ignored.
set -euo pipefail
[[ "${RENEWED_LINEAGE:-}" == /etc/letsencrypt/live/admin.agentfleet.vip ]] || exit 0
key="$RENEWED_LINEAGE/privkey.pem"; crt="$RENEWED_LINEAGE/fullchain.pem"
cmp -s <(openssl pkey -in "$key" -pubout) <(openssl x509 -in "$crt" -noout -pubkey) || { echo "renewed admin key/cert mismatch" >&2; exit 1; }
openssl x509 -in "$crt" -noout -checkend 172800 >/dev/null || { echo "renewed admin cert expires within 2 days" >&2; exit 1; }
openssl x509 -in "$crt" -noout -ext subjectAltName | grep -qE '(^|[[:space:],])DNS:admin\.agentfleet\.vip([[:space:],]|$)' || { echo "renewed admin cert lacks hostname" >&2; exit 1; }
systemctl is-active --quiet automaton-fleet-edge.service || { echo "edge not running; nothing to reload"; exit 0; }
systemctl reload automaton-fleet-edge.service
for _ in $(seq 1 15); do
  curl -fsS -m 3 -o /dev/null https://admin.agentfleet.vip/login/ && { echo "admin TLS renewed and serving"; exit 0; }
  sleep 2
done
echo "admin.agentfleet.vip not serving after the reload" >&2
exit 1
