# 11 — Network, firewall, DNS and TLS (PART 13)

> Master-Key archive, reconstruction grade. Repository HEAD `efad214` (branch `fleet-development`).
> Implementation wins over documentation. **DRIFT:** marks disagreements. Host-only artifacts are marked **NOT IN REPOSITORY**.
> No secret values appear here. Public identifiers (IP address, host-key fingerprints, tunnel id, certificate issuer) are already public in `docs/fleet-production-runbook.md`.

Sources: `src/fleet/service/main.ts`, `src/fleet/service/server.ts`, `src/fleet/operator/main.ts`, `src/fleet/operator/server.ts`, `src/fleet/chatgpt-adapter/main.ts`, `src/fleet/bridge/tunnel.ts`, `src/fleet/secret-files.ts`, `src/fleet/doctor.ts`, `deploy/systemd/*`, `deploy/firewall/fleet-firewall.sh`, `deploy/etc/runtime.env.example`, `scripts/fleet-verify-deployment.sh`, `docs/fleet-production-runbook.md`, `docs/design/phase-{b,c,d}-*.md`, `FLEET.md`.

---

## 13.1 Topology

```
                         Internet
                            │
            ┌───────────────┴──────────────────────────────────┐
            │ OVH Edge Network Firewall (IPv4 only)            │
            │   allow TCP 22, 80, 443; ESTABLISHED; ICMP       │
            │   deny everything else                           │
            └───────────────┬──────────────────────────────────┘
                            │  51.195.148.111 (api.agentfleet.vip A, TTL 600)
                            │  2001:41d0:801:2000::7bd1 (present, unused, no AAAA)
            ┌───────────────┴──────────────────────────────────┐
            │ ufw: default deny incoming / allow outgoing      │
            │   22/tcp, 443/tcp (v4 + v6); 80/tcp only while    │
            │   certbot runs (fleet-certbot-port80 hooks)       │
            └───────────────┬──────────────────────────────────┘
      ┌─────────────┬───────┴─────────┬────────────────────────────┐
  sshd :22     node :443 (TLS)   loopback only                 unix sockets
  (key only)   automaton-fleet   127.0.0.1:8787 automaton-fleet (plain HTTP admin)
               .service          127.0.0.1:8788 Operator API
                                 127.0.0.1:5432 PostgreSQL
                                 127.0.0.1:6379 + [::1]:6379 Redis (unused)
                                 /run/automaton-fleet-chatgpt/adapter.sock (0660)
                                 /run/automaton-fleet-chatgpt-tunnel/health.sock
  outbound: tunnel-client → api.openai.com:443 (long-poll; no inbound)
            certbot → Let's Encrypt ACME; git/pnpm → GitHub / npm registry (build time)
```

Development VM (bridge-claude): it opens `ssh -L 127.0.0.1:<local port ≥1024>:127.0.0.1:8788` to `fleet-op-tunnel@51.195.148.111:22`. It has no inbound exposure.

---

## 13.2 Listener table (expected)

| Bind | Proto | Owner process / unit | Exposure | Enforced by | Source |
|---|---|---|---|---|---|
| `0.0.0.0:22`, `[::]:22` | TCP / SSH | `sshd` (`ssh.service`) | **Public** | ufw allow 22, OVH edge allow 22 | runbook `:93` |
| `0.0.0.0:443` | TCP / HTTPS (TLS ≥ 1.2) | `node dist/fleet/service/main.js` (`automaton-fleet.service` + `remote.conf`) | **Public (IPv4 only)** | `FLEET_PUBLIC_LISTEN=0.0.0.0:443`; `CAP_NET_BIND_SERVICE` from the drop-in; ufw allow 443 | `main.ts:279-282`, runbook `:106` |
| `127.0.0.1:8787` | TCP / plain HTTP | same controller process (`listenAdmin`) | Loopback | `parseListen` + `listenAdmin` + `bind()` refuse plain HTTP off loopback; ufw explicit deny 8787 | `main.ts:74-87`, `server.ts:317-326` |
| `127.0.0.1:8788` | TCP / plain HTTP | `node dist/fleet/operator/main.js` (`automaton-fleet-operator-api.service`) | Loopback | `parseOperatorListen` regex; `IPAddressAllow=localhost` | `operator/main.ts:42-49` |
| `127.0.0.1:5432` | TCP / PostgreSQL | `postgres` | Loopback | Ubuntu default `listen_addresses=localhost`; `pg_hba`: local peer, host 127.0.0.1/32 + ::1/128 scram-sha-256; ufw explicit deny 5432 | runbook `:405-411`, `:79` |
| `127.0.0.1:6379`, `[::1]:6379` | TCP / RESP | `redis-server` | Loopback | Ubuntu default `bind 127.0.0.1 -::1`, `protected-mode yes`; ufw explicit deny 6379 | runbook `:407`, `:79` |
| `/run/automaton-fleet-chatgpt/adapter.sock` | Unix stream | systemd socket → `automaton-fleet-chatgpt-adapter.service` | Local, adapter user + tunnel group, 0660 | socket unit | `…adapter.socket:13-16` |
| `/run/automaton-fleet-chatgpt-tunnel/health.sock` | Unix stream | tunnel-client | Local, tunnel user (dir 0700) | `--health.unix-socket=` | `…tunnel.service:44` |
| `0.0.0.0:80` | TCP / HTTP-01 | `certbot --standalone` | **Public, transient** (only during issuance or renewal) | ufw rule added by the pre-hook and removed by the post-hook, plus a `certbot.service` `ExecStopPost=` drop-in, a 15-min fail-safe timer and a boot unit | runbook `:100-102` |
| `127.0.0.53:53`, `127.0.0.54:53` | UDP/TCP DNS | `systemd-resolved` | Loopback | OS default | `…tunnel.service:59` |
| (none) | — | ChatGPT adapter and tunnel users | **No TCP listener** | `fleet-verify-deployment.sh:113-116` (`ss -ltneH` uid match) | — |

Recorded production listeners, after Phase C (runbook `:132`, `:1190`, `:1224`):
- public: `0.0.0.0:443` and 22;
- loopback: `127.0.0.1:8787`, `127.0.0.1:8788`, `127.0.0.1:5432`, `127.0.0.1:6379`, `[::1]:6379`;
- closed from outside: 80, 5432, 6379, 8787, 8788 and 8080.
<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->
(Needed: `sudo ss -Hltnpe` and `sudo ss -Hlxp | grep automaton` on the VPS, and an external `nmap -Pn -p- 51.195.148.111`.)

### 13.2.1 Code-level listener rules

`src/fleet/service/main.ts`:

```ts
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);           // :68
const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(raw);                                // :76  (raw default "127.0.0.1:8787")
if (!LOOPBACK_HOSTS.has(host) && !opts.remoteAllowed) throw …                          // :80-84
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i; // :144
```

Startup sequence (`startFleetServiceFromEnv`, `main.ts:194-329`):
1. `loadTls(e)` loads the certificate from `FLEET_TLS_CERT_FILE`. The key comes from an explicit `FLEET_TLS_KEY_FILE` (strict 0600) **or**, when that is unset and `CREDENTIALS_DIRECTORY` is set, from `$CREDENTIALS_DIRECTORY/tls.key` under `systemdCredentialProblems`. The certificate path may not name a secret credential or a secret source file (`:106-112`).
2. `FLEET_REMOTE_LISTEN_ENABLED=true` without TLS refuses to start (`:212-213`).
3. `loadRemoteConfig`:
   - every `FLEET_ALLOWED_ORIGINS` entry must match `^https:\/\/[^/\s]+$`;
   - `FLEET_PUBLIC_LISTEN` without remote mode is refused;
   - the hostname must match `HOSTNAME_RE`;
   - `tlsProblemsForHost` must be empty (`:153-170`).
4. `tlsProblemsForHost` (`:125-142`):
   - `x509.checkHost(hostname)` (or `checkIP` for an IP);
   - `validFrom ≤ now`;
   - `validTo ≥ now + 86 400 000 ms` (**one day**);
   - `checkPrivateKey`.
5. With `FLEET_PUBLIC_LISTEN` set, the service binds `FLEET_API_LISTEN` through `listenAdmin` (loopback plain HTTP) and `FLEET_PUBLIC_LISTEN` through `listen` (HTTPS) (`:279-282`). The public URL is logged as `https://<hostname>:<port>`.

`src/fleet/service/server.ts`:
- `bind(port, host, tls)` refuses plain HTTP on a non-loopback host (`:322-325`).
- TLS: `https.createServer({ cert, key, minVersion: "TLSv1.2" }, handler)` (`:328`). There is no cipher list, so the Node.js defaults apply. TLS 1.3 and 1.2 are accepted; 1.1 is refused (verified from outside, runbook `:106`).
- Every response carries `cache-control: no-store` and `x-content-type-options: nosniff`. Over TLS it also carries `strict-transport-security: max-age=31536000`, without `includeSubDomains` or `preload` (`:556-559`).
- Origin policy: any request with an `Origin` header not listed in `FLEET_ALLOWED_ORIGINS` gets `403 {code:"FLEET_ORIGIN_DENIED"}` and an `api_origin_denied` audit event (`:561-575`). The default list is empty.
- `GET /healthz` returns `{ok, status:"alive"|"draining", uptimeS}` (200, or 503 while draining) on both listeners.
- `GET /readyz` returns detailed readiness **only to loopback peers**; everyone else gets `404 {code:"FLEET_NOT_FOUND"}` (`:599-607`).

`src/fleet/operator/main.ts:42-49`:

```ts
const m = /^(127\.0\.0\.1|\[::1\]|localhost):([0-9]{1,5})$/.exec(s);   // default "127.0.0.1:8788"
```

The Operator API also requires a loopback `Host` header on `/healthz` and `/readyz`; any other gets 421 `FLEET_OP_BAD_REQUEST` (`operator/server.ts:318-320`).

`src/fleet/chatgpt-adapter/main.ts:162-167`: it listens only on the systemd-passed fd 3 (`LISTEN_FDS === "1" && LISTEN_PID === pid`) or on an explicit Unix socket path (tests). Otherwise startup is refused.

---

## 13.3 Firewall policy

### 13.3.1 Repository script `deploy/firewall/fleet-firewall.sh` (exact rules)

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow "${SSH_PORT}/tcp" comment 'operator SSH'          # SSH_PORT="${FLEET_SSH_PORT:-22}"
ufw allow 443/tcp comment 'automaton fleet controller (HTTPS only)'
ufw deny 5432/tcp comment 'PostgreSQL never exposed'
ufw deny 6379/tcp comment 'Redis never exposed'
ufw deny 8787/tcp comment 'fleet admin HTTP is loopback-only'
ufw --force enable
ufw status verbose
```

- It is a dry run by default. `--apply` executes (`:12-13`).
- It requires root and `ufw` (`:14-15`).
- It changes nothing outbound.
- There is no explicit rule for 8788. Default-deny covers it, and the Operator API binds loopback only.

nftables equivalent documented in `FLEET.md:650-653` (not applied in production; ufw is used):

```
table inet fleet { chain input { type filter hook input priority 0; policy drop;
  ct state established,related accept; iif lo accept; tcp dport { 22, 443 } accept; } }
```

(That snippet has no ICMP accept. **DRIFT (doc):** it is not fully equivalent to ufw, whose default `before.rules` accept ICMP echo and the ICMPv6 neighbour-discovery types.)

### 13.3.2 Baseline (runbook stage 2)

`ufw default deny incoming`, `default allow outgoing`, `allow 22/tcp`, enable. `IPV6=yes` in `/etc/default/ufw`, so the rules cover IPv6 too (runbook `:333-338`).

### 13.3.3 Final production reality (recorded)

| Layer | Policy (runbook `:100`, `:76`) |
|---|---|
| OVH Edge Network Firewall (IPv4) | Allow TCP 22, 80, 443; allow ESTABLISHED; allow ICMP; deny everything else. IPv6 is not covered by this layer |
| Host ufw | Default deny incoming, allow outgoing; allow 22/tcp and 443/tcp for IPv4 and IPv6. **80/tcp only during renewal** |
| Port-80 control | `/usr/local/sbin/fleet-certbot-port80 open\|close` (root 0755), called from `renewal-hooks/pre/10-fleet-open-port80` and `post/90-fleet-close-port80`; a `certbot.service` `ExecStopPost=` drop-in; a 15-minute fail-safe timer armed before opening; `fleet-certbot-port80-boot.service` (enabled). `certbot renew --dry-run` passed with port 80 open for 9 s. **NOT IN REPOSITORY** |

Whether the explicit `deny 5432/6379/8787` rules from `fleet-firewall.sh --apply` are present in production is not stated in the record. The stage 18 procedure applies them (runbook `:885`); the recorded firewall line lists only the allows.
<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->
(Needed: `sudo ufw status verbose` and `sudo ufw show added`, the OVH edge rule export, and the text of `/usr/local/sbin/fleet-certbot-port80` and the three hook/unit files.)

### 13.3.4 Per-unit egress/ingress filters (systemd cgroup BPF)

| Unit | Filter | Consequence |
|---|---|---|
| `automaton-fleet.service` (base) | deny any, allow localhost | Loopback only |
| `automaton-fleet.service` + `remote.conf` | `IPAddressDeny=` (reset), `IPAddressAllow=any` | **No IP filter.** Inbound is narrowed by ufw/OVH only; outbound is unrestricted |
| Operator API, witness | deny any, allow localhost | Loopback only |
| ChatGPT adapter | deny any, allow localhost; families INET+UNIX | 127.0.0.1 only |
| ChatGPT tunnel | deny localhost, link-local, multicast, 10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7; allow 127.0.0.53/32, 127.0.0.54/32 | Public internet plus the DNS stub. It cannot reach 8787/8788/5432/6379/22 on loopback. Verified: "The tunnel sandbox policy blocks 127.0.0.1:{8788, 8787, 5432, 6379, 22} … and allows `api.openai.com`" (runbook `:1223`) |

---

## 13.4 DNS — `api.agentfleet.vip`

| Record | Value | TTL | Notes |
|---|---|---|---|
| `agentfleet.vip` NS | `curitiba`, `fortaleza`, `maceio`, `salvador` `.ns.porkbun.com` | — | Porkbun hosts the zone |
| `api.agentfleet.vip` A | `51.195.148.111` | 600 | Created at stage 14 (S6) after the parking CNAME was deleted (runbook `:99`) |
| `api.agentfleet.vip` AAAA | **none (required)** | — | The service binds `0.0.0.0:443` (IPv4 only), and Let's Encrypt prefers IPv6 when an AAAA exists (runbook `:717-718`) |
| `api.agentfleet.vip` CNAME | none | — | The old `CNAME pixie.porkbun.com` was deleted |
| `agentfleet.vip` A (apex), `*.agentfleet.vip` CNAME | Porkbun parking | 600 | Left in place |
| `agentfleet.vip` CAA | recommended `0 issue "letsencrypt.org"` | — | Record at stage 14: "There is no AAAA and no CAA" (runbook `:99`) |

Read-only verification (runbook `:737-746`):

```bash
ws$ for ns in curitiba fortaleza maceio salvador; do echo "$ns: $(dig +norec +short A api.agentfleet.vip @$ns.ns.porkbun.com) / cname=$(dig +norec +short CNAME api.agentfleet.vip @$ns.ns.porkbun.com)"; done
ws$ for r in 1.1.1.1 8.8.8.8 9.9.9.9; do echo "$r: $(dig +short A api.agentfleet.vip @$r)"; done
ws$ dig +short AAAA api.agentfleet.vip @1.1.1.1      # empty
ws$ dig +short CAA agentfleet.vip @1.1.1.1
```

<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->
(Needed: current answers from the four authoritative servers, and whether a CAA record now exists.)

---

## 13.5 TLS

### 13.5.1 Certificate (recorded)

| Item | Value (runbook `:101`) |
|---|---|
| CA / intermediate | Let's Encrypt `YE2` |
| Key type | ECDSA P-256 (`--key-type ecdsa --elliptic-curve secp256r1`) |
| Challenge | HTTP-01, `certbot --standalone` (certbot 2.9.0, Ubuntu noble) |
| SHA-256 fingerprint | `82:5D:77:7E:…:EA:32` (abbreviated in the record) |
| Validity | 2026-09-24 → 2026-12-23 |
| SAN | `api.agentfleet.vip` |

Why HTTP-01 (runbook `:756-762`):
- Ubuntu 24.04 has no certbot DNS plugin for Porkbun.
- Porkbun API keys are account-wide, so DNS-01 would fail least privilege.
- `--standalone` has no TLS-ALPN, and 443 belongs to the fleet service.

Issuance command (runbook `:784-789`; S7c is the same without `--dry-run`):

```bash
sudo certbot certonly --standalone --preferred-challenges http \
  -d api.agentfleet.vip -m <ops-email> --agree-tos --no-eff-email \
  --key-type ecdsa --elliptic-curve secp256r1 \
  --pre-hook  "ufw allow 80/tcp comment 'certbot http-01 (temporary)'" \
  --post-hook "ufw delete allow 80/tcp"
```

**DRIFT:** the issuance command uses inline `--pre-hook`/`--post-hook` ufw commands. The final production renewal mechanism is the `fleet-certbot-port80` helper with named renewal-hook scripts plus three fail-safes (runbook `:102`). Check which `pre_hook`/`post_hook` entries remain in `/etc/letsencrypt/renewal/api.agentfleet.vip.conf`.
<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->

### 13.5.2 Certificate handling path

```
/etc/letsencrypt/live/api.agentfleet.vip/{privkey,fullchain}.pem   (symlinks into archive/, root 0700 dirs)
        │  install -m 0600 -o root -g root privkey.pem   → /etc/automaton-fleet/tls/fleet.key   (single-link regular file)
        │  install -m 0644 -o root -g root fullchain.pem → /etc/automaton-fleet/tls/fleet.crt
        ▼
systemd LoadCredential (remote.conf), at service START only
        │  tls.key → /run/credentials/automaton-fleet.service/tls.key   (root 0400 + ACL → stat 0440)
        │  tls.crt → /run/credentials/automaton-fleet.service/tls.crt
        ▼
runtime.env: FLEET_TLS_CERT_FILE=/run/credentials/automaton-fleet.service/tls.crt ; FLEET_TLS_KEY_FILE **unset**
        ▼
loadTls → systemdCredentialProblems(tls.key, sourceFile=/etc/automaton-fleet/tls/fleet.key) → tlsProblemsForHost
```

Rules:
- Never point `LoadCredential=` at `/etc/letsencrypt` (runbook `:834`). The sources must be single-link regular files: `fleet-os-setup.sh:88-90` and `fleet-verify-deployment.sh:123-131` refuse symlinks and files with more than one link.
- Never set `FLEET_TLS_KEY_FILE`: `fleet-verify-deployment.sh:143-147` fails if it is set. `FLEET_TLS_CERT_FILE` must be exactly the credential path (`:148-151`).
- The doctor cannot read `/run/credentials`, so it checks the source `tls/fleet.crt` instead (`doctor.ts:500-505`). Its `certificateProblems` test is: covers hostname, not yet valid, expires within one day.
- Key/certificate match check (runbook `:827`):
  `sudo bash -c 'cmp <(openssl pkey -in /etc/automaton-fleet/tls/fleet.key -pubout) <(openssl x509 -in /etc/automaton-fleet/tls/fleet.crt -noout -pubkey)'`.

### 13.5.3 Renewal

- The key facts:
  - `LoadCredential=` copies the files only at service start, so a renewal needs a copy into `tls/` **and a restart**.
  - The service refuses to start when the certificate expires within one day, so an unapplied renewal turns the next restart into an outage (runbook `:1284-1297`).
- `certbot.timer` (package) runs `certbot renew`. The port-80 hooks open and close ufw.
- Deploy hook `/etc/letsencrypt/renewal-hooks/deploy/automaton-fleet.sh` (root 0755). Its text is in the runbook (`:1303-1331`), and the recorded SHA-256 is `197dfe74…1a5f`. It runs only after a **successful** renewal:
  1. exits 0 unless `RENEWED_LINEAGE == /etc/letsencrypt/live/api.agentfleet.vip`;
  2. checks the new key and certificate match; `-checkend 172800` (2 days); SAN contains `DNS:api.agentfleet.vip`;
  3. saves `fleet.key.prev` / `fleet.crt.prev`; installs the new pair via `.new` + `mv -f` (0600 / 0644 root:root);
  4. `systemctl restart automaton-fleet.service || true`;
  5. polls 30 times at 2 s intervals: `curl -fsS -m 3 http://127.0.0.1:8787/healthz` **and** `https://api.agentfleet.vip/healthz`; on success it removes the `.prev` files and exits 0;
  6. otherwise it restores `.prev`, runs `systemctl reset-failed automaton-fleet.service`, restarts, and exits 1.
- Recorded status: "It has not been tested by hand yet" (runbook `:103`). `certbot renew --dry-run` does not run deploy hooks (`:1333-1336`).
- Monitoring:
  - to be set up: alert when the certificate is within 14 days of expiry (`openssl x509 … -checkend 1209600`);
  - to be set up: alert when the timer is not scheduled;
  - to be set up: alert when the hook exits non-zero.
  - **NOT IMPLEMENTED** (runbook `:1340-1344`).
<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->
(Needed: `certbot certificates`, `systemctl list-timers certbot.timer`, the hook SHA-256s, and `openssl x509 -noout -dates -fingerprint -sha256` of `tls/fleet.crt`.)

### 13.5.4 Public validation (runbook stage 19, `:903-917`)

| Probe (from outside) | Expected |
|---|---|
| `curl -fsS https://api.agentfleet.vip/healthz` | 200 `{"ok":true,"status":"alive","uptimeS":…}` |
| `GET https://api.agentfleet.vip/readyz` | **404** (loopback-only detail) |
| `curl -sSI …/healthz` | `strict-transport-security: max-age=31536000`, `cache-control: no-store`, `x-content-type-options: nosniff` |
| `-H 'Origin: https://evil.example'` | 403 |
| `-X POST …/v1/heartbeat` (no credentials) | 401 |
| `--tlsv1.1 --tls-max 1.1` | handshake failure |
| `curl -m 5 http://api.agentfleet.vip/` | connection fails (port 80 closed) |
| `nc -vz … 5432 / 6379 / 8787` (and 8788) | fail |
| `nmap -Pn -p- <VPS_IP>` | open: 22, 443 only |

Doctor probes (`doctor.ts:167-186`, against `FLEET_API_URL`, default `http://127.0.0.1:8787`):
- a `Bearer fa1.<id>.<43×A>` on `POST /v1/heartbeat` must get `401 FLEET_SESSION_REQUIRED`;
- a `FleetSession` with a timestamp one hour old must get `401 FLEET_REQUEST_STALE`.

The "remote controller reachable" check fetches `${FLEET_PUBLIC_URL}/healthz` and requires `r.ok && body.ok === true` (`doctor.ts:507-521`).

---

## 13.6 SSH

### 13.6.1 Host and authentication (recorded, runbook `:65-67`)

| Item | Value |
|---|---|
| Host | OVH VPS `51.195.148.111`, hostname `agentfleet-vps`; IPv6 `2001:41d0:801:2000::7bd1` present but unused |
| Host keys | ED25519 `SHA256:HUuqOfrwidWq3SagFJD3rEavFX29u89cy1vIqun0tRg`; ECDSA `SHA256:Rm5H28vhzH9/hoc82EJ/Gk3jRfCo58prkwzOmfg6NjA`; RSA `SHA256:8wKSAe0hWQVxBhpDQNGGN4xCs6geOz/8jJ5pvfLBmpU` |
| Admin login | `ubuntu`, public key only (dev VM alias `agentfleet-vps`) |
| Password auth | Disabled globally since the B2 closeout by `/etc/ssh/sshd_config.d/10-fleet-no-passwords.conf` (`PasswordAuthentication no`, `KbdInteractiveAuthentication no`). It is read before `50-cloud-init.conf` (`yes`) because sshd keeps the first value it reads |

### 13.6.2 Restricted tunnel account `fleet-op-tunnel` (B2-11, **NOT IN REPOSITORY**)

Recorded (runbook `:1191`; design `docs/design/phase-b-operator-api.md:348-354`):
- The user is uid 993 / gid 983, with `/usr/sbin/nologin`, a locked password and its own group only.
- `/var/lib/fleet-op-tunnel/.ssh/authorized_keys` is root-owned and holds exactly one line:
  `restrict,port-forwarding,permitopen="127.0.0.1:8788",command="/usr/sbin/nologin" <ssh-ed25519 public key of ~/.ssh/fleet_op_tunnel>`
- `/etc/ssh/sshd_config.d/70-fleet-op-tunnel.conf` is a per-user `Match User fleet-op-tunnel` block that ends in `Match all`. A staged `sshd -T` showed no change for other users. It was applied with `sshd -t` and a reload, not a restart.
- Verified behaviour:
  - forwarding works only to `127.0.0.1:8788`;
  - 8787, 5432, 6379, 22, other loopback destinations and external destinations are refused ("administratively prohibited");
  - `-R`, Unix-socket forwards, tun, shell, command, PTY, X11, sftp and scp are refused.
- Transport key fingerprint (dev VM `~/.ssh/fleet_op_tunnel`): `SHA256:wP56E+ziLw3JwnkylaE/AbYX37akdauAcuchUIpK6Ns`.

<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->
(Needed: the exact text of `70-fleet-op-tunnel.conf` and `10-fleet-no-passwords.conf`, `sshd -T -C user=fleet-op-tunnel,host=x,addr=127.0.0.1` output, and `stat` of `authorized_keys`.)

### 13.6.3 Bridge ssh client (dev VM, `src/fleet/bridge/tunnel.ts:55-80`)

The bridge spawns `ssh` with no shell and this fixed argument vector:
- `-F /dev/null -N -T`
- `BatchMode=yes`, `IdentitiesOnly=yes`, `IdentityFile=<~/.ssh/fleet_op_tunnel>`, `IdentityAgent=none`
- `UserKnownHostsFile=<~/.config/automaton-fleet/operator/known_hosts>`, `GlobalKnownHostsFile=/dev/null`
- `StrictHostKeyChecking=yes`, `HostKeyAlgorithms=ssh-ed25519`, `UpdateHostKeys=no`, `CheckHostIP=no`
- `PreferredAuthentications=publickey`, `PasswordAuthentication=no`, `KbdInteractiveAuthentication=no`
- `ForwardAgent=no`, `ForwardX11=no`, `PermitLocalCommand=no`, `ControlMaster=no`, `ControlPath=none`
- exactly one `-L 127.0.0.1:<port>:127.0.0.1:8788`, with the local port in 1024–65535, and `ExitOnForwardFailure=yes` (design `phase-d-claude-bridge.md:55-61`).

The dedicated `known_hosts` must hold exactly one `ssh-ed25519` line whose fingerprint equals the pinned `SHA256:HUuq…` (`bridge/hostkey.ts:28-44`). A mismatch gives `HOST_KEY_MISMATCH`.

---

## 13.7 Outbound OpenAI Secure MCP Tunnel

| Item | Value |
|---|---|
| Client | OpenAI `tunnel-client-runtime` v0.0.14 at `/opt/automaton-fleet/tunnel-client/v0.0.14/`. Zip SHA-256 `29d29cf860ada54e4d3c82c715f4fbfcff2abcdc2584c0fc26431308dfa2505b`, binary SHA-256 `94ae9d0c024753d1b79669152e968eb5d0faaad1e04ccf6c37750d7a3e175c77` (`fleet-chatgpt-setup.sh:38-41`) |
| Direction | Outbound only. It long-polls `api.openai.com:443` (`…tunnel.service:3-5`) |
| Tunnel id | `tunnel_6ab5cd2c7b088191abe137e56b5f35e4` (non-secret, `tunnel.env` → `CONTROL_PLANE_TUNNEL_ID`) |
| Credentials | OpenAI runtime key (`LoadCredential=openai-api-key`), adapter token (`LoadCredential=adapter-token`) |
| Upstream to adapter | `url=http://localhost/mcp,unix-socket=/run/automaton-fleet-chatgpt/adapter.sock` plus the header `X-Fleet-Adapter-Token: file:%d/adapter-token`. The adapter compares SHA-256(token) with `tunnelTokenSha256` in `chatgpt-adapter.json` |
| Adapter → Operator API | Signed GET requests to `127.0.0.1:8788` with the `bridge-chatgpt` key (principal `op_01M3B18TXVP33S6NQC909DXD57`, key id `fe22d91c08f0a0676b4c155ce0d618d3`). The listener's owner uid must be `automaton-fleet-operator-api`'s uid (`chatgpt-adapter/main.ts:116-128`) |
| Harpoon / SSRF | The tunnel's cgroup filter blocks loopback and private ranges. The adapter serves no OAuth protected-resource metadata (`/.well-known/*` gives 404) (design `phase-c-chatgpt-adapter.md:131`) |
| Key entry | `sudo fleet-chatgpt-tunnel-key`: TTY only; echo off; typeahead discarded; hygiene of 20–4096 printable ASCII characters. The verdict is read from that unit invocation's journal: `"tunnel metadata fetched"` means accepted; `status 401/403/404` means rejected. Timeout 60 s (`WAIT_S=60`). On rejection it restores the previous key or removes the new one |
| State | Waiting for the owner's runtime key. The unit is enabled but inactive |

<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->

---

## 13.8 Explicit exposure answers

| Question | Expected answer (code + scripts + record) | Why | Verify with |
|---|---|---|---|
| **Is 8787 public?** | **No.** Loopback plain HTTP only | `FLEET_API_LISTEN=127.0.0.1:8787` (unit `:39`, runtime.env); `parseListen` and `listenAdmin` refuse non-loopback plain HTTP; ufw explicit deny 8787 (script); OVH edge denies it; recorded "8787 filtered" from outside (runbook `:106`, `:1224`) | `ss -Hltn \| grep :8787` → `127.0.0.1:8787` only; `fleet-verify-deployment.sh:176-179`; `nc -vz api.agentfleet.vip 8787` fails |
| **Is 8788 public?** | **No.** Loopback only, reached by the SSH forward (`permitopen` 8788) and the local adapter | `parseOperatorListen` regex; `IPAddressAllow=localhost`; ufw default deny; recorded closed from outside (runbook `:1224`) | `fleet-verify-deployment.sh:67-72` |
| **Is PostgreSQL public?** | **No.** `127.0.0.1:5432` | Ubuntu default `listen_addresses=localhost`; `pg_hba` loopback scram only; ufw explicit deny 5432 | `fleet-verify-deployment.sh:176-179`; `sudo -u postgres psql -XAt -c 'SHOW listen_addresses'` → `localhost` |
| **Is Redis public?** | **No.** `127.0.0.1:6379` and `[::1]:6379`. **Unused by fleet code** | `bind 127.0.0.1 -::1`, `protected-mode yes`; ufw explicit deny 6379 | as above |
| Is 443 public? | **Yes, IPv4.** The only public application port | `FLEET_PUBLIC_LISTEN=0.0.0.0:443` + drop-in; ufw + OVH allow 443 | `curl https://api.agentfleet.vip/healthz` |
| Is 80 public? | **Only while certbot runs** | port-80 hooks + fail-safes | `ufw status \| grep -w 80` → nothing |
| Is the ChatGPT adapter reachable from the network? | **No.** Unix socket 0660; no TCP | socket unit; `fleet-verify-deployment.sh:113-116` | `ss -ltneH` shows no listener for uids 992/988 |
| Does anything on the VPS accept inbound IPv6 application traffic? | **No.** Only sshd listens on `[::]:22`; nothing is on `[::]:443`; there is no AAAA record | `FLEET_PUBLIC_LISTEN=0.0.0.0:443` | `ss -Hltn` |

<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->
(Needed: live `ss` output and an external port scan confirming each row.)

---

## 13.9 Observations and risks (network)

1. **With `remote.conf` the controller has unrestricted egress.** `IPAddressAllow=any` after a reset `IPAddressDeny=` removes the loopback-only filter in both directions. Inbound exposure is limited by ufw/OVH. Outbound (for example after an SSRF-class bug) is limited by nothing. A narrower drop-in (allow `any` for ingress to 443 only) is **NOT IMPLEMENTED**, and systemd's IP filters cannot distinguish direction per port.
2. **HSTS has no `includeSubDomains`.** This matters only if other `agentfleet.vip` subdomains ever serve content.
3. **No CAA record** was present at stage 14. The runbook recommends one; its current state is unknown.
4. **No certificate-expiry monitoring** exists (§13.5.3).
5. **Renewal deploy hook untested** (§13.5.3).
6. **Redis is installed but unused.** The runbook (`:1407`) leaves "whether Redis should be installed at all" open.
7. **OVH edge allows 80 permanently** at the edge (runbook `:100`). Port 80 is still closed at ufw outside renewal windows.
