# R36: TLS edge with PROXY protocol (networking only), REHEARSED

**Release.**
- Commit `29cde7d6d938fd489c76edc531f7c932aefc459f`
- Build `a85fd089905fd97e39f05c69b6b4166105f83c232ba212a25ab25d3c42c9f5a8`
- Lockfile `1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1` (unchanged from R35)
- Schema 41 (unchanged)

The build is identical locally and on the VPS (`pins-local.txt`, `pins.txt`). Each was built in a fresh clone by
`scripts/fleet-build-runtime.sh`. The VPS received the commit as a git bundle, because the commit is not yet on GitHub
(see "Before the cutover").

**Owner decision (2026-10-03): option B.** `api.agentfleet.vip` and `admin.agentfleet.vip` both use :443 behind nginx.
The real client address is preserved at FleetController. There is no Option A stopgap and no extra public port.

## Change

**Controller** (`src/fleet/service/proxy-protocol.ts`, `server.ts` `listenProxied`, `main.ts`). This is opt-in through
`FLEET_PUBLIC_PROXY_PROTOCOL=true`; with the flag unset, R35 behaviour is unchanged.
- **Binding:** the listener binds to loopback only. A non-loopback `FLEET_PUBLIC_LISTEN` is refused at startup, and the
  listener itself refuses one too.
- **Accepted peers:** connections are accepted only from the peer 127.0.0.1. Every other peer is closed before any byte
  is read.
- **Header:** each connection must open with exactly one strict PROXY v1 `TCP4`/`TCP6` line (at most 107 bytes, within
  5 s). `UNKNOWN`, v2, malformed lines or ports, a family mismatch, or a missing header all close the connection.
- **TLS:** TLS still terminates in the controller, with the same API certificate.
- **Client address:** the header's address replaces the TCP peer for per-IP rate limits and audit.
- **Never local:** a proxied request is never treated as local, whatever address it names. Founder credentials and
  detailed `/readyz` stay on the direct `127.0.0.1:8787` listener. Founder 1 uses `http://127.0.0.1:8787` and is
  unaffected.

**Edge.**
- **Files:** `deploy/nginx/automaton-fleet-edge.conf`, `automaton-fleet-edge.service`, and the renewal hook
  `deploy/letsencrypt/automaton-fleet-edge.sh`.
- **Routing on :443:** stream SNI preread with `proxy_protocol on` (IPv4, as today).
  - `admin.agentfleet.vip` goes to nginx TLS on `127.0.0.1:9443`, which overwrites `X-Forwarded-For` and proxies to the
    dashboard on `127.0.0.1:8790`.
  - Everything else, including requests with no SNI, goes to the controller on `127.0.0.1:8443`.
- **Isolation:** the edge cannot read Fleet secrets or the API private key.
- **Stock nginx:** `nginx.service` is masked, so :80 stays free for certbot.

## Tests

| Area | Result |
|---|---|
| Typecheck | PASS |
| `pnpm build` | PASS |
| New `fleet-proxy-protocol.test.ts` | 6 |
| New R36 PostgreSQL tests in `fleet-cognition.test.ts` | 4 |
| Phase 6 suite | 29/29 |
| Full `vitest run` | 142 files, 2794 passed, 1 skipped, **0 failed** |

The new tests cover:
- **Parser:** fail-closed behaviour and split packets.
- **Configuration:** the flag requires remote listening, an explicit listener and a loopback bind.
- **Listener:** refuses a non-loopback bind and plain HTTP.
- **Founder through the proxy:** refused, even with a PROXY source of 127.0.0.1 or ::1. The audit records the real
  address. The direct loopback path still returns 200.
- **`/readyz` through the proxy:** 404.
- **Per-IP rate limits:** keyed on the header's address, so one client's 429 does not affect another.
- **Rejected connections:** no header, `UNKNOWN`, a bad port, plain HTTP, or a 127.0.0.2 peer all get no service.

## Rehearsals on the VPS (2026-10-03, production untouched)

- **`fleet-rollout.sh rehearse ~/r36-pins.txt 41 41` PASSED** at 19:56:58Z (`r36-rollout-rehearsal.txt`):
  - fresh dump `095c9e2c…`, restore row counts identical;
  - migrate-check showed nothing to apply;
  - privilege audit PASS, ledger verify ok;
  - re-run was a no-op;
  - rollback proof: the dump restores to schema 41 with the same ledger head.
- **`fleet-edge.sh rehearse ~/r36-pins.txt` PASSED, 17 checks**, at 19:57:11Z (`r36-edge-rehearsal.txt`).
  - **Setup:** a throwaway R36 controller ran against a throwaway database with only the restricted logins. A throwaway
    nginx used this release's config and unit, on `51.195.148.111:18443` (no ufw rule) and `127.0.0.1:18443`.
  - **Passthrough:** the controller's certificate was served, including for unknown or absent SNI.
  - **`/readyz`:** 404 through the edge, even from 127.0.0.1; still 200 on the direct listener.
  - **Real client address:** `51.195.148.111` in the controller audit and in the auth-failure events.
  - **Per-IP limit:** after its budget, that address got 16 responses of 429, while 127.0.0.1 still got 401.
  - **Refused connections:** headerless connections and the 127.0.0.2 peer were refused.
  - **Admin backend:** received `X-Forwarded-For` set to the real address only; a client-supplied `6.6.6.6` was dropped.
  - **Admin listener:** returns 421 for a foreign Host and requires the PROXY line.
  - **Edge isolation:** the edge cannot read the API key.
  - **Env-only rollback:** works.
  - **Production:** identical before and after (controller pid, :443 owner, Founder 1 pid, schema, ledger head).
- **Host preparation:**
  - nginx 1.24.0 and `libnginx-mod-stream` were installed with service starts blocked (3 new packages, nothing upgraded).
  - The stock `nginx.service` is masked and never ran.
  - The dashboard and identity broker were provisioned on loopback earlier the same day.

## Before the cutover

`29cde7d` must be on `fleet-origin` first, which needs the owner's approval to push. Both cutovers fetch the commit from
GitHub.

## Owner cutover

Run on the VPS as `ubuntu`, within 24 hours of the rehearsals, that is before 2026-10-04 19:56Z:

```
bash ~/r36-src/scripts/fleet-rollout.sh cutover ~/r36-pins.txt 41 41 && bash /opt/automaton-fleet/current/scripts/fleet-edge.sh cutover ~/r36-pins.txt
```

1. **Code cutover.** The flag is off, so behaviour is identical. Rollback is automatic.
2. **Edge cutover.** It obtains the `admin.agentfleet.vip` certificate, installs the edge, and switches the controller to
   `127.0.0.1:8443` with the flag on. It then verifies externally, with automatic rollback.

Manual rollback:
- `fleet-edge.sh rollback` (env only).
- The R35 release plus `runtime.env.pre-29cde7d` (code).

## Cutover 2026-10-03: code live, edge stopped on a false certificate mismatch (fixed, not yet applied)

- **Code cutover succeeded.** The owner ran `fleet-rollout.sh cutover`, and the controller started at 20:08:04Z.
  - Verified read-only: pin `29cde7d`, installed build `a85fd089…`, schema 41, readyz all ok.
  - Ledger: 503 journals, head `1d3e56f7…`.
  - Founder 1: same process, heartbeat fresh.
  - Flags false, mail and SMS not configured.
- **Edge cutover stopped at its certificate check**, before it changed anything:
  - No edge files were installed, there is no `runtime.env.pre-edge`, and the controller is still on `0.0.0.0:443`.
  - The edge is not installed, and nginx is not running.
  - Port 80 is closed again.
- **The certificate is valid.** Let's Encrypt YE1 issued an ECDSA P-256 certificate, valid until 2027-01-01. Its key
  matches: the certificate's public key and the private key's public key have the same SPKI SHA-256,
  `e4e6db18…84ab`.
- **Cause: a script bug.** The check used `sudo cmp -s <(…) <(…)`. sudo closes descriptors 3 and above, so `cmp` could
  not open `/dev/fd/6x`, exited 2, and the script read that as a mismatch. The rehearsal did not catch it because it uses
  self-signed certificates and never runs the cutover's check.
- **Fix:**
  - `check_cert` hashes each DER public key into a variable, so no descriptors are passed through sudo. It works for RSA
    and EC.
  - The check is also exposed as a read-only `fleet-edge.sh check-cert <lineage> <host>` mode.
  - `fleet-edge-script.test.ts` reproduces the failure with a sudo stand-in that closes descriptors. It accepts matching
    EC and RSA lineages and refuses mismatched keys, a look-alike hostname, an expiring certificate and a missing key.
  - Red/green: the old comparison fails on a matching lineage, and the new one passes.
  - Read-only on production, `check-cert` reports `CERT OK`.
- **No new runtime release.** Scripts are not part of the build identity, so the running R36 runtime is unchanged.
