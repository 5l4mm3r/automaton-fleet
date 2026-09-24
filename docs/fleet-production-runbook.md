# Fleet production VPS deployment and cutover runbook

Target: one OVH VPS running Ubuntu 24.04 LTS, which becomes the fleet control
plane (FleetController, PostgreSQL, Redis) behind `https://api.agentfleet.vip`.
Source: the local Ubuntu development VM, which runs the same release loopback-only.

**Status (2026-09-24):** stages 0–21 are complete. Public HTTPS has been live at
`https://api.agentfleet.vip` since 18:25:59 UTC, and the fleet cap has been 2 since
18:45:13 UTC. `fleet:doctor` reports DEPLOYMENT OK and **SAFE FOR DRY RUN: YES**.
Stage 21b (witness release) and stage 22 (dry-run child) have not started. See [Deployment record](#deployment-record-2026-09-24) for what
was run, the deviations the operator accepted, and the live state at the end of STOP S5.

## Conventions

- **STOP** marks an operator approval point. Do not continue past it without
  explicit approval. Every privileged command (`sudo`) is run by the operator.
  Claude may prepare, explain and verify, but runs no `sudo`, no `systemctl`
  changes, no DNS or firewall changes and no live database writes.
- `<operator>`: the operator's login on the VPS (in group `automaton-fleet-admin`).
  `<VPS_IP>`: the VPS public IPv4. `<ops-email>`: the Let's Encrypt account email.
- Commands prefixed `local$` run on the development VM. Commands prefixed `vps$`
  run on the VPS as `<operator>`. Commands prefixed `ws$` run on the operator's
  workstation (outside both hosts).
- Never paste a secret into a command line, `Environment=`, a repository file or
  shell history. Where a secret must be typed, use `read -rs`.

## Fixed values

| Item | Value |
|---|---|
| Runtime repository | `https://github.com/5l4mm3r/automaton-fleet.git` |
| Runtime commit | `11c0c7c02592d43a2c1350b779eaa795a237f3b7` |
| Build ID | `e388571a140f7cb20e289e1e64d152571adea5f207c2290c09888f80f6e3c624` |
| Lockfile SHA-256 | `eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811` |
| Database schema | v6 |
| Database / owner | `automaton_fleet` / `fleetadmin` |
| Controller hostname | `api.agentfleet.vip` (domain `agentfleet.vip`) |
| Toolchain on the local VM (match it) | Ubuntu 24.04.5, Node v22.23.2, pnpm 10.28.1 (from `packageManager`), PostgreSQL 16.15, Redis 7.0.15 |

## Invariants for the whole cutover

- `REAL_REPLICATION_ENABLED=false`, `REAL_PAYMENTS_ENABLED=false`,
  `OWNER_SWEEP_ENABLED=false` and `FLEET_DRY_RUN_CHILD=false` in `runtime.env` throughout.
  `FLEET_DRY_RUN_CHILD=true` is only ever set in the environment of the single
  dry-run command (stage 22), never in a file.
- `FLEET_REMOTE_LISTEN_ENABLED=false` until stage 17 (STOP).
- Fleet cap stays **1** until stage 21 (STOP), after public HTTPS has been proven healthy.
  Do not add `FLEET_MAX_AGENTS` to `runtime.env`; the registry cap is the control.
- The runtime identity above does not change during the cutover (stages 0–21). Any mismatch is a stop, not something to fix by editing pins. Only stage 21b replaces it, with its own explicit approval.
- **Only one controller may be live at a time.** Once stage 0 freezes the local
  registry, the local `automaton-fleet.service` stays stopped and disabled. Two
  controllers on diverging copies of the registry would each accept tokens, allocate
  slots and reap agents independently.
- PostgreSQL (5432), Redis (6379) and the admin HTTP port (8787) are never publicly reachable.

## Deployment record (2026-09-24)

### Host
| Item | Value |
|---|---|
| VPS | OVH, `51.195.148.111` (public IPv4 /32), IPv6 `2001:41d0:801:2000::7bd1` present but unused; hostname `agentfleet-vps` |
| Login | `ubuntu`, key only (`PasswordAuthentication no`, `KbdInteractiveAuthentication no`); SSH alias `agentfleet-vps` |
| Host keys | ED25519 `SHA256:HUuqOfrwidWq3SagFJD3rEavFX29u89cy1vIqun0tRg`, ECDSA `SHA256:Rm5H28vhzH9/hoc82EJ/Gk3jRfCo58prkwzOmfg6NjA`, RSA `SHA256:8wKSAe0hWQVxBhpDQNGGN4xCs6geOz/8jJ5pvfLBmpU` |
| Platform | Ubuntu 24.04.4 LTS, kernel 6.8.0-136, x86_64, systemd 255.4; 4 vCPU, 7.6 GiB, 72 GB disk |
| Toolchain | Node **v22.23.3** (apt, `/usr/bin/node`), global pnpm 10.34.5 (the repo workflow uses 10.28.1 via `packageManager`), PostgreSQL 16.15, Redis 7.0.15 |
| Build clone | `~ubuntu/automaton-fleet-build` at `11c0c7c`, clean |

### Stages completed
| Stage | Done by | Result |
|---|---|---|
| 0 | Operator | Local controller stopped and disabled. The final frozen dump was taken after shutdown, SHA-256 verified (`7473a22f…e06b`), transferred and restored. After the restore: 0 agents, 0 reservations, 0 orphans |
| 1–2 | Operator | SSH access and key-only authentication; ufw active. The ufw rules have not been reviewed, and 130 package upgrades are pending |
| 3 | Operator | `automaton-fleet-admin` (member: `ubuntu`), `automaton-fleet-service`, `automaton-agent` |
| 4 | Operator | Node v22.23.3 from apt (see the deviations below) |
| 5 | Operator | PostgreSQL on `127.0.0.1:5432`, Redis on `127.0.0.1`/`::1:6379` |
| 6, 10, 11 | Operator | The build reproduced build ID `e388571a…`, and the lockfile hash matches. The release is installed read-only at `/opt/automaton-fleet/releases/11c0c7c…`, with `current` pointing to it |
| 7 | Claude (approved) | `runtime.env` installed byte-for-byte from the local VM (SHA-256 `010d31439cdfa7d53d092e015e8318b8beba9e49856f222c3bae952fdf14ad6e`; it adds `FLEET_API_LISTEN` and `FLEET_REAPER_INTERVAL_MS` to the hand-made file). `admin.env` was freshly generated. `fleet-os-setup.sh --apply` created `service.env`, made `/opt/automaton-fleet` root-owned, installed the Node pin `/opt/automaton-fleet/node/bin/node` (a copy of `/usr/bin/node`) and installed both units without enabling them |
| 8 | Claude (approved) | The `fleetadmin` password was rotated to the `admin.env` value, without the `CREATE ROLE`/`CREATE DATABASE` branches. `fleet-db-setup.sh --apply` corrected drift in the hand-created roles: PUBLIC had CONNECT and TEMP on the database; `fleet_agent` and `fleet_service` were INHERIT; the logins had no timeouts |
| 9 | Operator | The restore was done at stage 0, so no dump was taken or restored again |
| 12–13 (S5) | Claude (approved) | `migrate-check` showed v6 with `wouldApply=[]`; `migrate` reported "Schema up to date"; `audit-privileges` PASS. Then `systemctl enable --now automaton-fleet.service` |

### State at the end of STOP S5 (2026-09-24 16:51 UTC)
- `automaton-fleet.service` is enabled and active, running as `automaton-fleet-service` with 0 restarts. `automaton-agent.service` is disabled and inactive.
- `/healthz` and `/readyz` both return 200. The reaper runs every 15 s.
- `sudo scripts/fleet-verify-deployment.sh`: 17/17 PASS.
- `pnpm fleet:verify-runtime /opt/automaton-fleet/current`: VERIFIED. The registry approves `11c0c7c` / `e388571a…` / `eee9dc2f…`.
- `pnpm fleet:doctor`: DEPLOYMENT OK. The only SAFE FOR DRY RUN blockers are HTTPS valid, remote controller reachable, and fleet cap = 2.
- Registry: schema v6 (6 migration rows), `maxAgents=1`, 0 living, 0 reserved, 0 quarantined, mode DEVELOPMENT, replication off.
- Listeners: `0.0.0.0:22` and `[::]:22` public. `127.0.0.1:8787`, `127.0.0.1:5432`, `127.0.0.1:6379` and `[::1]:6379` on loopback. From outside, 80, 443, 5432, 6379 and 8787 are all closed or filtered.
- All five safety flags are `false`.

### Stages 14–21 (2026-09-24)
| Stage | Result |
|---|---|
| 14 (S6) | The operator deleted the `api` CNAME to parking and added `api A 51.195.148.111`, TTL 600. There is no AAAA and no CAA. All four Porkbun nameservers and 1.1.1.1, 8.8.8.8 and 9.9.9.9 return only the A record |
| Firewall | OVH Edge Network Firewall (IPv4): allow TCP 22, 80 and 443, ESTABLISHED and ICMP; deny everything else. Host ufw: default deny incoming; allows 22/tcp and 443/tcp for IPv4 and IPv6. **80/tcp is opened only during renewal** (see below) |
| 15 (S7) | The operator issued an ECDSA P-256 certificate with certbot 2.9.0 (standalone HTTP-01): Let's Encrypt `YE2`, SHA-256 `82:5D:77:7E:…:EA:32`, valid 2026-09-24 → 2026-12-23 |
| Renewal port 80 | `/usr/local/sbin/fleet-certbot-port80 open\|close` (root 0755) is called by `renewal-hooks/pre/10-fleet-open-port80` and `post/90-fleet-close-port80`. Port 80 is also closed by an `ExecStopPost=` drop-in on `certbot.service`, a 15-minute fail-safe timer armed before opening, and `fleet-certbot-port80-boot.service` (enabled). `certbot renew --dry-run` passed, with port 80 open for 9 s |
| Deploy hook | `renewal-hooks/deploy/automaton-fleet.sh` (root 0755) is the version in "Certificate renewal requires a service restart", SHA-256 `197dfe74…1a5f`. **It has not been tested by hand yet** |
| 16 | `tls/fleet.key` (root:root 0600) and `tls/fleet.crt` (root:root 0644), each a single-link regular file |
| 17 | The `remote.conf` drop-in is byte-identical to the `11c0c7c` example. `runtime.env` is now SHA-256 `66e55b23ce1e7374a9a2db9ac2a8e8b9a6a0b281bad6612f95ac7860c2b8a557`; the backup `runtime.env.pre-remote` is `010d3143…` |
| 19 (S8) | Restarted at 18:25:59 UTC with 0 restarts. `0.0.0.0:443` is public and `127.0.0.1:8787` is loopback. From outside: `/healthz` 200, `/readyz` 404, unauthenticated POST 401, foreign Origin 403, TLS 1.2 and 1.3 accepted, TLS 1.1 refused. 80, 5432, 6379 and 8787 are filtered |
| 20 | `fleet-verify-deployment.sh` 19/19 PASS. `fleet:doctor`: HTTPS valid and remote controller reachable |
| 21 (S9) | `pnpm fleet:admin set-cap 2` at 18:45:13 UTC wrote event 26, `cap_set {"previous":1,"max":2}`. 0 living, 0 reserved, 0 quarantined; mode DEVELOPMENT. `SAFE FOR DRY RUN: YES` |

### Deviations accepted by the operator
- **Node v22.23.3 instead of v22.23.2.** The approved build ID reproduced exactly with it. Do not downgrade Node just to match stage 4.
- **Global pnpm 10.34.5.** It is left alone, because the pinned workflow ran with 10.28.1 and reproduced the build.
- **Stages 3–6 and 10–11 were done by hand, not with the scripts.** The scripts were then run over the result and made it consistent (the drift is listed at stage 7 and stage 8 above).

### Open items
- **`ubuntu` has broad passwordless sudo** (`sudo -n` succeeds). Every sudo is still approval-gated by policy. See [Cleanup](#cleanup-after-cutover).
- **Two dumps are still in `~ubuntu`** (`automaton-fleet-final-frozen.dump`, `automaton-fleet-pre-vps.dump`), mode 0664. See [Cleanup](#cleanup-after-cutover).
- **`ubuntu` can't read the journal** (it isn't in `adm` or `systemd-journal`), so `journalctl -u automaton-fleet` needs sudo.
- **130 package upgrades pending.** Unattended-upgrades is active.
- **`/etc/automaton-fleet/runtime.env.pre-remote`** (the loopback-only config) is kept for rollback.
- **Doctor's repository check:** the registry records the runtime repository without `.git`, and `runtime.env` has it with `.git`. The two are normalized and match.

## Stop points (summary)

| # | Stage | Approval needed for |
|---|---|---|
| S0 | 0 | Stopping and disabling the local controller; taking the registry backup |
| S1 | 2 | SSH hardening reload; reboot after upgrades; enabling the baseline firewall |
| S2 | 3–7 | Creating OS users, groups, `/etc/automaton-fleet` and secrets on the VPS |
| S3 | 8–9 | Creating PostgreSQL roles and the database; restoring the backup |
| S4 | 11 | Installing the release into `/opt/automaton-fleet` |
| S5 | 12–13 | Enabling and starting `automaton-fleet.service` (loopback only) |
| S6 | 14 | Publishing the DNS record |
| S7 | 15 | Requesting the certificate (briefly opens port 80 when using HTTP-01) |
| S8 | 17–19 | Setting `FLEET_REMOTE_LISTEN_ENABLED=true`, installing the drop-in, opening 443, restarting |
| S9 | 21 | Changing the fleet cap from 1 to 2 |
| S9b | 21b | Deploying the witness release: new runtime pin, live v6 → v7 migration, witness user and unit |
| S10 | 22 | Enrolling and starting the root witness; creating one real (paid) Conway sandbox |
| S11 | 22 | Retiring the dry-run child and deciding whether the cap returns to 1 |

## Order of stages and deviations from the requested order

The stages follow the requested order except in two places, where a later step is a
hard dependency of an earlier one:

- **The repository is cloned (stage 6) before the database stages**, because the
  role setup, restore checks and every later stage run scripts and `pnpm fleet:*`
  commands from it.
- **`/etc/automaton-fleet` and its secrets are created (stage 7) before the database
  roles (stage 8)**, because `scripts/fleet-db-setup.sh` reads the restricted-role
  passwords from `/etc/automaton-fleet/service.env`, and the release install
  (stage 11) needs `runtime.env` and the pinned Node copy under `/opt/automaton-fleet/node`.

The secret strategy is written out once, as a reference, before the stages.

## Secret migration and rotation strategy

**Principle: rotate everything; migrate only data.** The only thing copied from the
local VM is the registry contents (the v6 database dump) and the non-secret
`runtime.env`. The local VM's secret files are never copied.

| Secret | Production source | Notes |
|---|---|---|
| `fleetadmin` password (`/etc/automaton-fleet/admin.env`, root:automaton-fleet-admin 0640) | Fresh `openssl rand -hex 32` on the VPS (stage 7) | Operator CLI and migrations only. The service refuses to start if it can see it |
| `fleet_service_login`, `fleet_agent_login` passwords (`service.env`, root:root 0600) | Fresh, generated by `scripts/fleet-os-setup.sh` (stage 7) and applied by `scripts/fleet-db-setup.sh` (stage 8) | Delivered to the service only through `LoadCredential=service.env` |
| TLS private key (`/etc/automaton-fleet/tls/fleet.key`, root:root 0600) | Generated on the VPS by certbot (stage 15) | Never leaves the VPS. Delivered only through `LoadCredential=tls.key`; `FLEET_TLS_KEY_FILE` stays unset |
| Agent bearer tokens (`fa1.`) and sessions (`fs1`) | Only SHA-256 hashes live in the database | No living agents exist. Any root needed for the dry run is enrolled fresh on the VPS (stage 22), with the VPS URL |
| `CONWAY_API_KEY` | Operator's environment for the one dry-run command only (`read -rs`) | Never in a file, the service, or `runtime.env`. A dedicated key for production is recommended |
| DNS API credential (only with DNS-01, stage 15) | Scoped to the `agentfleet.vip` zone, root 0600 under `/etc/letsencrypt/` | Not needed with HTTP-01 |
| SSH | Operator's own key; password authentication disabled | No SSH key or `known_hosts` is copied from the local VM |

- **What the database dump contains:** schema `fleet` only. That means registry state, the
  audit history, token and session **hashes**, and nonce ledgers. It does **not** contain
  PostgreSQL role passwords, because `pg_dump -n fleet` dumps no roles. Treat it as
  confidential anyway: mode 0600, operator-owned, verified by SHA-256, transferred only
  over SSH, and deleted from both hosts once stage 9 is verified. If the operator keeps an
  off-host copy, it is encrypted.
- **The repository `.env.fleet`** must not exist on the VPS. `fleet:doctor` and
  `fleet-verify-deployment.sh` fail if it holds controller secrets.
- **After cutover** the local VM's secrets are inert, because its controller stays
  stopped. Retiring or rotating them is part of decommissioning the local VM, which is
  out of scope here.

---

## Stage 0 — Freeze the local registry and take the v6 backup (local VM)

Preconditions: the local fleet has no living agents, no reserved slots, no open orphans
and no open leases.

```bash
local$ cd ~/projects/automaton-fleet
local$ pnpm fleet:admin status > ~/fleet-status-before.json      # keep for comparison
local$ pnpm fleet:admin orphans; pnpm fleet:admin reservations; pnpm fleet:admin provisioning
```

**STOP S0.** With approval, quiesce the local controller so the reaper stops writing,
and keep it from starting again:

```bash
local$ sudo systemctl disable --now automaton-fleet.service
local$ systemctl is-active automaton-fleet.service        # expect: inactive
```

Dump the fleet schema as the superuser. Peer authentication means no password is
involved; the redirect writes the file as the operator.

```bash
local$ umask 077
local$ sudo -u postgres pg_dump -Fc -n fleet automaton_fleet > ~/automaton_fleet-v6.dump
local$ sha256sum ~/automaton_fleet-v6.dump > ~/automaton_fleet-v6.dump.sha256
local$ pg_restore -l ~/automaton_fleet-v6.dump | head -20   # table of contents; sanity check only
local$ sha256sum /etc/automaton-fleet/runtime.env            # record; the VPS copy must match
```

Record per-table row counts for comparison after the restore:

```bash
local$ sudo -u postgres psql -X -d automaton_fleet -At -c "
  SELECT table_name || ' ' || (xpath('/row/c/text()',
         query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text
    FROM information_schema.tables
   WHERE table_schema = 'fleet' AND table_type = 'BASE TABLE' ORDER BY 1" > ~/fleet-rowcounts-before.txt
```

**Rollback:** `sudo systemctl enable --now automaton-fleet.service` on the local VM.
This is valid until the VPS registry has accepted any change: any enrollment, cap
change or issued credential. After that, the VPS is the source of truth. Rolling back
then means dumping the VPS registry back to the local VM with this same procedure.

## Stage 1 — Initial SSH access

1. From the OVH panel, record `<VPS_IP>`, the default login (normally `ubuntu`), and
   the host key fingerprints if OVH shows them.
2. `ws$ ssh ubuntu@<VPS_IP>`. Compare the host key fingerprint with the one OVH shows
   (or with `ssh-keyscan` from the rescue console) before accepting it.
3. Confirm the platform:
   ```bash
   vps$ lsb_release -ds; uname -m; systemd --version | head -1   # expect Ubuntu 24.04.x, x86_64
   ```
4. Create the operator account, and install the workstation's public key for it:
   ```bash
   vps$ sudo adduser <operator>
   vps$ sudo usermod -aG sudo <operator>
   vps$ sudo install -d -m 0700 -o <operator> -g <operator> /home/<operator>/.ssh
   vps$ sudo install -m 0600 -o <operator> -g <operator> /dev/stdin /home/<operator>/.ssh/authorized_keys   # paste the public key, then Ctrl-D
   ```
5. In a **second** terminal, confirm `ws$ ssh <operator>@<VPS_IP>` and `sudo -v` work.
   Keep one working session open through stage 2.

**Rollback:** the OVH KVM or rescue console is the recovery path if SSH access is lost.
Confirm it works before stage 2.

## Stage 2 — OS update and hardening

**STOP S1** covers the reboot, the sshd reload and enabling the firewall.

```bash
vps$ sudo apt update && sudo apt full-upgrade -y
vps$ sudo apt install -y unattended-upgrades ufw curl ca-certificates gnupg xz-utils git openssl jq
vps$ sudo timedatectl set-timezone Etc/UTC
vps$ timedatectl        # "System clock synchronized: yes", "NTP service: active"
vps$ sudo reboot        # if the upgrade asked for one
```

Clock sync is required, not optional. Signed requests are refused outside ±60 s,
and certificate validity checks depend on the clock.

**Unattended security upgrades:** enable them without automatic reboots, because every
reboot is an operator decision.

```bash
vps$ sudo dpkg-reconfigure -plow unattended-upgrades
vps$ grep -R "Automatic-Reboot " /etc/apt/apt.conf.d/   # must be "false" (the default)
```

**SSH hardening.** Files in `sshd_config.d` are read in lexical order, and the first
value set for a keyword wins. `10-` therefore wins over OVH/cloud-init's `50-cloud-init.conf`.

```bash
vps$ sudo install -m 0644 /dev/stdin /etc/ssh/sshd_config.d/10-fleet-hardening.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowUsers <operator>
X11Forwarding no
AllowAgentForwarding no
MaxAuthTries 3
EOF
vps$ sudo sshd -t && sudo systemctl reload ssh
vps$ sudo sshd -T | grep -Ei '^(permitrootlogin|passwordauthentication|allowusers)'
```

Test a **new** SSH login before closing the existing session. Then lock the default
account's password (`sudo passwd -l ubuntu`). Removing the account is left for later.

**Baseline firewall: SSH only.** Port 443 is opened at stage 18.

```bash
vps$ sudo ufw default deny incoming
vps$ sudo ufw default allow outgoing
vps$ sudo ufw allow 22/tcp comment 'operator SSH'
vps$ sudo ufw --force enable && sudo ufw status verbose
vps$ grep '^IPV6=' /etc/default/ufw     # expect IPV6=yes, so the rules cover IPv6 too
vps$ sudo ss -Hltnup                    # note every listener; anything unexpected gets explained or removed
```

**Rollback:** delete `/etc/ssh/sshd_config.d/10-fleet-hardening.conf` and reload ssh
(through the console if needed). `sudo ufw disable`.

## Stage 3 — Service accounts and groups

**STOP S2** covers stages 3–7.

These are the same accounts, with the same flags, that `scripts/fleet-os-setup.sh`
creates. That script is idempotent and skips them when it runs at stage 7.

```bash
vps$ getent group automaton-fleet-admin || sudo groupadd --system automaton-fleet-admin
vps$ sudo usermod -aG automaton-fleet-admin <operator>
vps$ id automaton-fleet-service || sudo useradd --system --user-group --home-dir /var/lib/automaton-fleet \
       --no-create-home --shell /usr/sbin/nologin --comment "Automaton fleet control service" automaton-fleet-service
vps$ id automaton-agent || sudo useradd --user-group --create-home --home-dir /home/automaton-agent \
       --shell /usr/sbin/nologin --comment "Automaton agent runtime" automaton-agent
vps$ sudo chmod 0700 /home/automaton-agent
vps$ id automaton-fleet-service; id automaton-agent; getent group automaton-fleet-admin
```

- `automaton-agent` must be in **no** fleet group.
- `automaton-fleet-service` must not be in `automaton-fleet-admin`.
- Log out and back in, then check `id` shows `automaton-fleet-admin` for the operator.

**Rollback:** `sudo userdel automaton-agent && sudo rm -rf /home/automaton-agent`,
`sudo userdel automaton-fleet-service`, `sudo gpasswd -d <operator> automaton-fleet-admin`,
`sudo groupdel automaton-fleet-admin`. This is safe only before later stages own files as these users.

## Stage 4 — Node 22 and pnpm

Install the **same** Node version as the local VM (v22.23.2) from the official tarball,
verified against the published checksums. This keeps the operator toolchain and the
service's pinned Node copy identical to what was verified locally. Using a different
patch version is allowed by `engines` (`>=20`), but it needs a reason.

```bash
vps$ V=v22.23.2; A=linux-x64      # use linux-arm64 if `uname -m` said aarch64
vps$ cd /tmp && curl -fsSLO https://nodejs.org/dist/$V/node-$V-$A.tar.xz && curl -fsSLO https://nodejs.org/dist/$V/SHASUMS256.txt
vps$ grep " node-$V-$A.tar.xz\$" SHASUMS256.txt | sha256sum -c -        # must print OK
vps$ sudo install -d -m 0755 /usr/local/lib/nodejs
vps$ sudo tar -xJf node-$V-$A.tar.xz -C /usr/local/lib/nodejs
vps$ for b in node npm npx corepack; do sudo ln -sfn /usr/local/lib/nodejs/node-$V-$A/bin/$b /usr/local/bin/$b; done
vps$ node --version                     # v22.23.2
vps$ sudo corepack enable pnpm          # shim in /usr/local/bin; pnpm version then comes from packageManager
```

Optional but recommended: verify `SHASUMS256.txt.sig` against the Node.js release keys.

Check pnpm after cloning (stage 6): `pnpm --version` inside the repository must print `10.28.1`.

> **Production deviation (accepted 2026-09-24):** the VPS runs Node v22.23.3 from apt
> (`/usr/bin/node`), which reproduced build ID `e388571a…` exactly. That Node is the pinned
> copy at `/opt/automaton-fleet/node/bin/node`.

**Rollback:** remove `/usr/local/lib/nodejs/node-$V-$A` and the four `/usr/local/bin` symlinks.

## Stage 5 — PostgreSQL and Redis

Ubuntu 24.04 ships PostgreSQL 16, the same major version as the local VM.

```bash
vps$ sudo apt install -y postgresql redis-server
vps$ psql --version                                  # 16.x
vps$ sudo -u postgres psql -XAt -c 'SHOW listen_addresses; SHOW password_encryption;'   # localhost / scram-sha-256
vps$ sudo grep -Ev '^\s*(#|$)' /etc/postgresql/16/main/pg_hba.conf  # local peer; host 127.0.0.1/32 + ::1/128 scram-sha-256; nothing else
vps$ sudo grep -Ev '^\s*(#|$)' /etc/redis/redis.conf | grep -E '^(bind|protected-mode|port) '   # bind 127.0.0.1 -::1, protected-mode yes
vps$ sudo ss -Hltnp | grep -E ':(5432|6379)\b'      # 127.0.0.1 / [::1] only
```

- Do not change `listen_addresses`, `bind` or `pg_hba.conf` to anything wider.
- **Redis:** the fleet code does not use Redis today. Nothing reads `REDIS_URL`; it is
  only stripped from agent environments. Install it loopback-only as requested, and
  record whether it should run at all (see "Assumptions").

**Rollback:** `sudo apt purge postgresql-16 redis-server`. This loses all database data,
so do it only before stage 9, or after taking a dump.

## Stage 6 — Clone the fleet repository and check out the exact commit

This clone is the operator's tooling checkout. It is used for the deployment scripts
and `pnpm fleet:*`. The service itself runs from `/opt/automaton-fleet/current` (stage 11).

```bash
vps$ git clone https://github.com/5l4mm3r/automaton-fleet.git ~/automaton-fleet
vps$ cd ~/automaton-fleet
vps$ git checkout --detach 11c0c7c02592d43a2c1350b779eaa795a237f3b7
vps$ test "$(git rev-parse HEAD)" = 11c0c7c02592d43a2c1350b779eaa795a237f3b7 && echo HEAD OK
vps$ echo "eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811  pnpm-lock.yaml" | sha256sum -c -
vps$ pnpm --version                                   # 10.28.1
vps$ CI=true pnpm install --frozen-lockfile
vps$ test ! -e .env.fleet && echo "no .env.fleet (correct)"
```

**Rollback:** `rm -rf ~/automaton-fleet`.

## Stage 7 — Recreate `/etc/automaton-fleet` securely

Create `admin.env` and `runtime.env` **before** running `fleet-os-setup.sh`. The script
leaves existing files unchanged, and it would otherwise:
- fail looking for a `.env.fleet` secret, which must not exist here;
- or install an empty `runtime.env` from the example.

1. Directory and admin credential. The fresh password is generated in a root shell, and
   the file is created atomically with its final mode. Nothing is printed.

   ```bash
   vps$ sudo install -d -m 0755 -o root -g root /etc/automaton-fleet
   vps$ sudo bash -s <<'EOF'
   set -euo pipefail
   umask 077
   f=/etc/automaton-fleet/admin.env
   [[ ! -e $f ]] || { echo "$f exists; left unchanged"; exit 0; }
   pw=$(openssl rand -hex 32)
   tmp=$(mktemp "$f.XXXXXX")
   printf '# Operator/migration credential (schema owner). Never give this to the service or agents.\nFLEET_ADMIN_DATABASE_URL=postgresql://fleetadmin:%s@127.0.0.1:5432/automaton_fleet\n' "$pw" >"$tmp"
   chown root:automaton-fleet-admin "$tmp"; chmod 0640 "$tmp"; mv -f "$tmp" "$f"
   EOF
   ```

2. `runtime.env`: a byte-for-byte copy of the local VM's file, which is non-secret. Copy
   it over SSH, check its hash against the one recorded in stage 0, then install it:

   ```bash
   ws$  scp local-vm:/etc/automaton-fleet/runtime.env <operator>@<VPS_IP>:runtime.env.from-local
   vps$ sha256sum ~/runtime.env.from-local                       # must equal the stage 0 value
   vps$ grep -Ev '^\s*(#|$)' ~/runtime.env.from-local
   ```

   Expected content, exactly:

   ```
   FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
   FLEET_RUNTIME_COMMIT=11c0c7c02592d43a2c1350b779eaa795a237f3b7
   FLEET_RUNTIME_BUILD_ID=e388571a140f7cb20e289e1e64d152571adea5f207c2290c09888f80f6e3c624
   FLEET_RUNTIME_LOCKFILE_SHA256=eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811
   REAL_REPLICATION_ENABLED=false
   REAL_PAYMENTS_ENABLED=false
   OWNER_SWEEP_ENABLED=false
   FLEET_DRY_RUN_CHILD=false
   FLEET_API_LISTEN=127.0.0.1:8787
   FLEET_REAPER_INTERVAL_MS=15000
   FLEET_REMOTE_LISTEN_ENABLED=false
   ```

   Install it:

   ```bash
   vps$ sudo install -m 0644 -o root -g root ~/runtime.env.from-local /etc/automaton-fleet/runtime.env && rm ~/runtime.env.from-local
   ```

3. Run the OS setup: dry run first, then apply. It will:
   - create `service.env` with fresh restricted-role passwords;
   - create `tls/` (root:automaton-fleet-admin 0750);
   - create `/opt/automaton-fleet/{releases,node/bin}` and copy the pinned `node` binary;
   - install both systemd units **without enabling them**.

   ```bash
   vps$ cd ~/automaton-fleet
   vps$ sudo scripts/fleet-os-setup.sh            # read every printed command
   vps$ sudo scripts/fleet-os-setup.sh --apply
   vps$ sudo stat -c '%U:%G %a %n' /etc/automaton-fleet /etc/automaton-fleet/* /etc/automaton-fleet/tls
   ```

   Expected: `/etc/automaton-fleet` root:root 755, `admin.env` root:automaton-fleet-admin
   640, `service.env` root:root 600, `runtime.env` root:root 644, `tls` root:automaton-fleet-admin 750.

   ```bash
   vps$ /opt/automaton-fleet/node/bin/node --version      # v22.23.2 (production VPS: v22.23.3, accepted)
   vps$ systemctl is-enabled automaton-fleet.service automaton-agent.service   # both "disabled"
   ```

**Rollback:** `sudo rm -rf /etc/automaton-fleet /opt/automaton-fleet
/etc/systemd/system/automaton-{fleet,agent}.service && sudo systemctl daemon-reload`.
This throws away the generated passwords. Stage 8 must then be redone with the new ones.

## Stage 8 — Least-privilege database roles

**STOP S3** covers stages 8–9.

1. **Owner role and database** (superuser; the password is read from `admin.env` in a
   root shell and passed to psql on stdin):

   ```bash
   vps$ sudo bash -s <<'EOF'
   set -euo pipefail
   pw=$(sed -n 's#^FLEET_ADMIN_DATABASE_URL=postgresql://fleetadmin:\([0-9a-f]\{64\}\)@.*#\1#p' /etc/automaton-fleet/admin.env)
   [[ ${#pw} -eq 64 ]] || { echo "admin.env holds no 64-hex fleetadmin password" >&2; exit 1; }
   { printf '\\set pw %s\n' "$pw"; cat <<'SQL'
   SELECT 'CREATE ROLE fleetadmin LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleetadmin') \gexec
   ALTER ROLE fleetadmin LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
   SELECT format('ALTER ROLE fleetadmin PASSWORD %L', :'pw') \gexec
   SELECT 'CREATE DATABASE automaton_fleet OWNER fleetadmin' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'automaton_fleet') \gexec
   SQL
   } | runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d postgres -f -
   EOF
   ```

2. **Restricted roles:** `fleet_agent`, `fleet_agent_login`, `fleet_service` and
   `fleet_service_login`, with their passwords taken from `service.env`. They must exist
   **before** the restore, because the dump's GRANTs name them.

   ```bash
   vps$ sudo scripts/fleet-db-setup.sh            # dry run
   vps$ sudo scripts/fleet-db-setup.sh --apply
   ```

Do **not** run `pnpm fleet:migrate` yet. On an empty database it would create a fresh
schema, and the restore would then collide with it.

**Rollback:** `sudo -u postgres psql -c 'DROP DATABASE automaton_fleet'`. Then drop the
roles `fleet_agent_login`, `fleet_service_login`, `fleet_agent`, `fleet_service` and
`fleetadmin` (`DROP ROLE …`).

## Stage 9 — Restore the v6 database backup

1. Transfer and verify the dump:

   ```bash
   ws$  scp local-vm:automaton_fleet-v6.dump local-vm:automaton_fleet-v6.dump.sha256 <operator>@<VPS_IP>:
   vps$ chmod 0600 ~/automaton_fleet-v6.dump && sha256sum -c ~/automaton_fleet-v6.dump.sha256
   ```

2. Restore as the superuser, but with `--role=fleetadmin`, so every object (including the
   `SECURITY DEFINER` functions) is owned by `fleetadmin`. It runs in one transaction and
   stops at the first error.

   ```bash
   vps$ sudo -u postgres pg_restore --exit-on-error --single-transaction --role=fleetadmin \
          -d automaton_fleet < ~/automaton_fleet-v6.dump
   ```

3. Verify:

   ```bash
   vps$ cd ~/automaton-fleet
   vps$ pnpm fleet:migrate-check           # schema v6, nothing pending
   vps$ pnpm fleet:migrate                 # expect "Schema up to date."; re-asserts both restricted grants
   vps$ pnpm fleet:audit-privileges        # must PASS
   vps$ pnpm fleet:admin health
   vps$ pnpm fleet:admin status > ~/fleet-status-after.json
   ```

   - Re-run the stage 0 row-count query on the VPS. `diff` it against
     `fleet-rowcounts-before.txt`; it must be identical.
   - Compare `fleet-status-after.json` with `fleet-status-before.json`. Expect `maxAgents`
     = 1, the same approved runtime (commit, build ID and lockfile above), no living or
     reserved agents, the same mode, and `replication_enabled` false.

4. Delete the dump from both hosts once everything matches. If the operator keeps an
   off-host copy, it is encrypted.

**Rollback:** drop and recreate the database (stage 8 step 1), then restore again.

## Stage 10 — Reproducible build and Build ID verification

Run as the operator, not root. Dependency install scripts never run as root.

```bash
vps$ cd ~/automaton-fleet
vps$ scripts/fleet-deploy-release.sh build
```

This fetches the pinned commit from GitHub (no `--source`), checks the lockfile hash
before installing, runs `pnpm install --frozen-lockfile` and `pnpm build`, and refuses
unless the build ID and lockfile hash equal `runtime.env`. The expected last line is
`Verified build e388571a… staged at ~/.cache/automaton-fleet/stage/11c0c7c…`.

Independent second build (recommended): a fresh temporary clone, whose values must match exactly:

```bash
vps$ scripts/fleet-build-runtime.sh https://github.com/5l4mm3r/automaton-fleet.git 11c0c7c02592d43a2c1350b779eaa795a237f3b7
```

A `BUILD MISMATCH` is a **stop**. Do not edit pins. Investigate, and compare the Node,
pnpm and lockfile versions with the local VM.

**Rollback:** `rm -rf ~/.cache/automaton-fleet/stage/11c0c7c02592d43a2c1350b779eaa795a237f3b7`.

## Stage 11 — Install the `/opt/automaton-fleet` release

**STOP S4.**

```bash
vps$ sudo scripts/fleet-deploy-release.sh install
vps$ readlink /opt/automaton-fleet/current      # releases/11c0c7c02592d43a2c1350b779eaa795a237f3b7
vps$ sudo find /opt/automaton-fleet ! -user root -print | head   # expect no output
vps$ pnpm fleet:verify-runtime /opt/automaton-fleet/current     # exit 0: repo, commit, build ID, lockfile all match
```

What `install` does:
- copies the staged tree to `releases/<commit>` owned by root;
- removes write permission;
- re-verifies the build ID with the pinned Node;
- switches `current` atomically;
- refuses to overwrite an existing release.

**Rollback:** `sudo rm -f /opt/automaton-fleet/current`, then
`sudo rm -rf /opt/automaton-fleet/releases/11c0c7c02592d43a2c1350b779eaa795a237f3b7`.
There is no earlier release on the VPS to switch back to.

## Stage 12 — systemd installation

The units were installed but not enabled at stage 7. Verify them before enabling:

```bash
vps$ diff deploy/systemd/automaton-fleet.service /etc/systemd/system/automaton-fleet.service && echo unit matches repo
vps$ sudo systemd-analyze verify /etc/systemd/system/automaton-fleet.service
vps$ systemctl cat automaton-fleet.service | grep -E '^(User|LoadCredential|IPAddress|Environment=FLEET_API_LISTEN)'
vps$ test ! -e /etc/systemd/system/automaton-fleet.service.d/remote.conf && echo "no remote drop-in (correct)"
```

`automaton-agent.service` stays installed and **disabled**.

**Rollback:** `sudo systemctl disable automaton-fleet.service`.

## Stage 13 — Loopback-only controller startup, and `/readyz` before any public exposure

**STOP S5.**

```bash
vps$ sudo systemctl enable --now automaton-fleet.service
vps$ systemctl is-active automaton-fleet.service
vps$ journalctl -u automaton-fleet -n 100 --no-pager      # no refusal, no error
vps$ curl -fsS http://127.0.0.1:8787/healthz
vps$ curl -sS -w '\nHTTP %{http_code}\n' http://127.0.0.1:8787/readyz | tail -3
```

`/readyz` must return **HTTP 200**. It checks:
- the database;
- the agent API;
- the privilege audit;
- the release against the approved runtime;
- reaper freshness.

Check exposure and the readiness verdicts:

```bash
vps$ sudo ss -Hltnp                           # 8787, 5432, 6379 on loopback only; 22 public; nothing on 443/80
vps$ sudo scripts/fleet-verify-deployment.sh  # all PASS
vps$ pnpm fleet:doctor                        # DEPLOYMENT: OK
vps$ pnpm fleet:verify
ws$  for p in 5432 6379 8787 443; do nc -vz -w3 <VPS_IP> $p; done   # all must fail
```

`pnpm fleet:verify` must be blocked by exactly these three items:
- HTTPS valid
- remote controller reachable
- fleet cap = 2

That matches the local VM before the cutover.

Do not continue to DNS until all of the above hold.

**Rollback:** `sudo systemctl disable --now automaton-fleet.service`.

## Stage 14 — DNS for `api.agentfleet.vip`

**STOP S6.** The operator makes this change in the Porkbun DNS panel. Nothing on the VPS changes.

### Current state (read 2026-09-24 from authoritative `curitiba.ns.porkbun.com`)
| Name | Record | TTL | Meaning |
|---|---|---|---|
| `agentfleet.vip` | NS `curitiba`/`fortaleza`/`maceio`/`salvador.ns.porkbun.com` | — | Porkbun hosts the zone |
| `agentfleet.vip` | A `207.207.210.107`, `207.207.210.229` | — | Porkbun parking (the apex resolves to `pixie.porkbun.com`) |
| **`api.agentfleet.vip`** | **CNAME `pixie.porkbun.com.`** | 600 | Parking. **Conflicts:** a CNAME cannot coexist with an A record at the same name |
| `*.agentfleet.vip` | CNAME `pixie.porkbun.com.` | 600 | Wildcard parking. Once `api` has its own record, the wildcard no longer applies to it |
| `agentfleet.vip` | CAA | — | none (any CA may issue) |
| `api.agentfleet.vip` | AAAA | — | none of its own. The CNAME target has no AAAA either |

The SOA minimum (negative-caching TTL) is 1800 s.

### Required change
1. **Delete** `api.agentfleet.vip CNAME pixie.porkbun.com`. This is required. Also delete
   any Porkbun "URL forwarding" entry for `api` if the panel shows one, because it creates hidden records.
2. **Create** `api.agentfleet.vip A 51.195.148.111`, TTL 600 (Porkbun's minimum).
3. **Do not create** an AAAA for `api`. The service binds `0.0.0.0:443` (IPv4 only), and
   Let's Encrypt prefers IPv6 when an AAAA exists, so an AAAA would break HTTP-01 validation.
4. **Recommended:** `agentfleet.vip CAA 0 issue "letsencrypt.org"`. It also covers `api`.
   Optionally add `0 iodef "mailto:<ops-email>"`.
5. **Leave** the apex A records and the `*` wildcard alone. They don't conflict with an
   explicit `api` record. Removing parking is a separate, optional clean-up.

Deleting the CNAME and adding the A can happen in either order. While `api` has no record,
it matches the wildcard and still resolves to parking; it never becomes NXDOMAIN.

### Propagation
- Porkbun's authoritative servers normally serve the change within a minute or two.
- Recursive resolvers that cached the old CNAME keep it for up to its **600 s TTL**.
  After that, every resolver returns the A record.
- Let's Encrypt validates through its own recursive resolvers, which respect the TTL.
  **Wait at least 10 minutes after all four authoritative servers return the A record
  before stage 15**, otherwise validation may reach parking.
- Nothing listens on 80 or 443 yet, so publishing the record exposes nothing.

### Read-only verification (from the local VM or a workstation)
```bash
ws$ for ns in curitiba fortaleza maceio salvador; do echo "$ns: $(dig +norec +short A api.agentfleet.vip @$ns.ns.porkbun.com) / cname=$(dig +norec +short CNAME api.agentfleet.vip @$ns.ns.porkbun.com)"; done
     # each: 51.195.148.111 / cname=  (empty)
ws$ for r in 1.1.1.1 8.8.8.8 9.9.9.9; do echo "$r: $(dig +short A api.agentfleet.vip @$r)"; done   # 51.195.148.111 only (after <=600 s)
ws$ dig +short AAAA api.agentfleet.vip @1.1.1.1          # empty
ws$ dig +short CNAME api.agentfleet.vip @1.1.1.1         # empty
ws$ dig +short CAA agentfleet.vip @1.1.1.1               # 0 issue "letsencrypt.org" (if added)
ws$ dig +noall +answer A api.agentfleet.vip @curitiba.ns.porkbun.com   # shows TTL 600
vps$ getent ahostsv4 api.agentfleet.vip | head -1         # 51.195.148.111 (the VPS's own resolver)
ws$ for p in 80 443; do timeout 5 bash -c "</dev/tcp/api.agentfleet.vip/$p" && echo "$p OPEN (unexpected)" || echo "$p closed"; done
```

**Rollback:** delete the A record, and recreate `api CNAME pixie.porkbun.com` if parking is wanted back.

## Stage 15 — TLS certificate acquisition

**STOP S7.** Approve it in three separate steps: S7a (install certbot), S7b (staging dry run),
S7c (real issuance).

### Challenge choice: HTTP-01 standalone
- Ubuntu 24.04 packages no certbot DNS plugin for Porkbun (checked with `apt-cache search certbot-dns`).
- Porkbun API keys are **account-wide**, not scoped to one zone. DNS-01 would put a
  credential for the whole account on the VPS, which fails least privilege.
- HTTP-01 needs port 80 **only while certbot runs**. The ufw hooks open and close it.
- Port 443 can't be used for the challenge: `certbot --standalone` supports no TLS-ALPN,
  and 443 belongs to the fleet service.

### Preconditions (read-only)
1. Stage 14 verification is green on all four Porkbun servers and three public resolvers,
   and has been for at least 10 minutes. `api` has no AAAA.
2. `sudo ufw status verbose` shows default incoming `deny`, 22/tcp allowed, and nothing on 80 or 443.
   (Needs a read-only sudo, which must be approved.)
3. The OVH Edge Network Firewall is off for `51.195.148.111`, or it allows 80/tcp during issuance.
   Check this in the OVH panel.
4. Nothing listens on :80 (`ss -Hltn | grep ':80 '` shows nothing).
5. `<ops-email>` has been chosen for the Let's Encrypt account.

### S7a: install certbot
```bash
vps$ sudo apt-get install -y certbot            # candidate 2.9.0-1 (Ubuntu noble)
vps$ certbot --version
vps$ systemctl list-timers certbot.timer        # the package enables a renewal timer. Renewal reuses the hooks,
                                                # but also needs the stage 16 copy and a restart (see "Certificate renewal")
```

### S7b: staging dry run (port 80 opens for about a minute)
```bash
vps$ sudo certbot certonly --standalone --preferred-challenges http \
       -d api.agentfleet.vip -m <ops-email> --agree-tos --no-eff-email \
       --key-type ecdsa --elliptic-curve secp256r1 \
       --pre-hook  "ufw allow 80/tcp comment 'certbot http-01 (temporary)'" \
       --post-hook "ufw delete allow 80/tcp" \
       --dry-run
vps$ sudo ufw status | grep -w 80 || echo "port 80 closed again (correct)"
ws$  timeout 5 bash -c '</dev/tcp/51.195.148.111/80' && echo "80 OPEN (stop)" || echo "80 closed"
```
The dry run uses Let's Encrypt staging, so it doesn't count against production rate limits.

### S7c: real issuance
Run the same command without `--dry-run`, then:
```bash
vps$ sudo certbot certificates                  # api.agentfleet.vip, ECDSA, expiry about 90 days
vps$ sudo openssl x509 -in /etc/letsencrypt/live/api.agentfleet.vip/fullchain.pem -noout -subject -issuer -dates -ext subjectAltName
vps$ sudo ufw status | grep -w 80 || echo "port 80 closed again (correct)"
vps$ sudo grep -E 'pre_hook|post_hook|authenticator' /etc/letsencrypt/renewal/api.agentfleet.vip.conf
```
The private key stays under `/etc/letsencrypt` (root 0700) and is never printed or copied off the VPS.
Stage 16 (copying it into `tls/`) is a separate step.

**What S7 does not do:** it doesn't change `runtime.env`, install the drop-in, open 443,
restart the service or change the cap.

**Rollback:** `sudo certbot delete --cert-name api.agentfleet.vip`, then confirm with
`sudo ufw status` that 80 isn't open. Optionally `sudo apt-get remove certbot`.

## Stage 16 — `tls.key` / `tls.crt` source permissions

`/etc/letsencrypt/live/…` holds symlinks into `archive/`. The service's credential
sources must instead be **single-link regular files**:
- `fleet.key` root:root 0600;
- `fleet.crt` root:root 0644;
- in `tls/` root:automaton-fleet-admin 0750.

`install` follows the symlink and writes a new regular file.

```bash
vps$ L=/etc/letsencrypt/live/api.agentfleet.vip; T=/etc/automaton-fleet/tls
vps$ sudo install -m 0600 -o root -g root "$L/privkey.pem"   "$T/fleet.key"
vps$ sudo install -m 0644 -o root -g root "$L/fullchain.pem" "$T/fleet.crt"
vps$ sudo stat -c '%U:%G %a %h %F %n' "$T" "$T/fleet.key" "$T/fleet.crt"
vps$ sudo bash -c 'cmp <(openssl pkey -in /etc/automaton-fleet/tls/fleet.key -pubout) <(openssl x509 -in /etc/automaton-fleet/tls/fleet.crt -noout -pubkey)' && echo "key matches certificate"
vps$ openssl x509 -in "$T/fleet.crt" -noout -subject -issuer -dates -ext subjectAltName
vps$ sudo scripts/fleet-verify-deployment.sh   # TLS section: all PASS; agent and service users cannot read fleet.key
```

- Never set `FLEET_TLS_KEY_FILE`. The key reaches the service only as
  `/run/credentials/automaton-fleet.service/tls.key`, verified as this unit's systemd credential.
- Never point `LoadCredential=` at `/etc/letsencrypt`.

**Rollback:** `sudo rm -f /etc/automaton-fleet/tls/fleet.key /etc/automaton-fleet/tls/fleet.crt`.

## Stage 17 — Remote systemd drop-in installation

**STOP S8** covers stages 17–19: enabling the remote listener.

1. Install the drop-in. It lifts `IPAddressDeny`, grants only `CAP_NET_BIND_SERVICE`,
   and adds exactly `LoadCredential=tls.key` and `LoadCredential=tls.crt`.

   ```bash
   vps$ sudo install -d -m 0755 -o root -g root /etc/systemd/system/automaton-fleet.service.d
   vps$ sudo install -m 0644 -o root -g root deploy/systemd/automaton-fleet.service.d/remote.conf.example \
          /etc/systemd/system/automaton-fleet.service.d/remote.conf
   ```

2. Edit `runtime.env`. **This flips a safety-gated flag.** Change
   `FLEET_REMOTE_LISTEN_ENABLED=false` to `true`, and add the lines below. Set no
   `FLEET_TLS_KEY_FILE`, `FLEET_MAX_AGENTS` or `FLEET_ALLOWED_ORIGINS`, and change no other line.

   ```
   FLEET_REMOTE_LISTEN_ENABLED=true
   FLEET_PUBLIC_HOSTNAME=api.agentfleet.vip
   FLEET_PUBLIC_LISTEN=0.0.0.0:443
   FLEET_PUBLIC_URL=https://api.agentfleet.vip
   FLEET_TLS_CERT_FILE=/run/credentials/automaton-fleet.service/tls.crt
   ```

   ```bash
   vps$ sudo cp -p /etc/automaton-fleet/runtime.env /etc/automaton-fleet/runtime.env.pre-remote   # 0644, non-secret
   vps$ sudoedit /etc/automaton-fleet/runtime.env
   vps$ diff /etc/automaton-fleet/runtime.env.pre-remote /etc/automaton-fleet/runtime.env         # only the lines above
   vps$ sudo systemctl daemon-reload            # no restart yet
   vps$ systemctl cat automaton-fleet.service | grep -E 'LoadCredential|IPAddress|Capabilit'
   ```

   The running service is unaffected until the restart in stage 19. If it restarts early
   (for example after a crash), the baseline firewall still blocks 443.

**Rollback:** `sudo rm /etc/systemd/system/automaton-fleet.service.d/remote.conf`,
`sudo mv /etc/automaton-fleet/runtime.env.pre-remote /etc/automaton-fleet/runtime.env`,
`sudo systemctl daemon-reload && sudo systemctl restart automaton-fleet.service`.

## Stage 18 — Firewall: only the required public ports

Public inbound traffic ends up as **22/tcp (SSH) and 443/tcp (HTTPS) only**. Port 80 is
open only during HTTP-01 issuance and renewal.

```bash
vps$ sudo deploy/firewall/fleet-firewall.sh          # dry run: prints the ufw rules
vps$ sudo deploy/firewall/fleet-firewall.sh --apply  # adds 443, explicit denies for 5432/6379/8787, keeps 22
vps$ sudo ufw status verbose
```

If OVH's network firewall is enabled for this IP, mirror the same allow-list there, and
add port 80 only for HTTP-01.

**Rollback:** `sudo ufw delete allow 443/tcp`. That returns the host to the SSH-only baseline.

## Stage 19 — Restart, and public HTTPS validation

```bash
vps$ sudo systemctl restart automaton-fleet.service
vps$ journalctl -u automaton-fleet -n 100 --no-pager      # HTTPS listener up, no refusal
vps$ sudo ss -Hltnp | grep -E ':(443|8787)\b'              # 0.0.0.0:443 and 127.0.0.1:8787, both node
vps$ curl -sS -w '\nHTTP %{http_code}\n' http://127.0.0.1:8787/readyz | tail -2   # still 200
```

From **outside** the VPS:

```bash
ws$ curl -fsS https://api.agentfleet.vip/healthz                          # {"ok":true,...}; nothing more
ws$ curl -sS -o /dev/null -w '%{http_code}\n' https://api.agentfleet.vip/readyz          # 404: detail is loopback-only
ws$ curl -sSI https://api.agentfleet.vip/healthz | grep -Ei 'strict-transport|cache-control|x-content-type'
ws$ curl -sS -o /dev/null -w '%{http_code}\n' -H 'Origin: https://evil.example' https://api.agentfleet.vip/healthz   # 403
ws$ curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://api.agentfleet.vip/v1/heartbeat                       # 401: unauthenticated
ws$ curl -sS --tlsv1.1 --tls-max 1.1 https://api.agentfleet.vip/healthz; echo "exit $?"      # must fail
ws$ openssl s_client -connect api.agentfleet.vip:443 -servername api.agentfleet.vip </dev/null 2>/dev/null \
      | openssl x509 -noout -subject -issuer -dates -ext subjectAltName
ws$ curl -m 5 http://api.agentfleet.vip/; echo "exit $?"                  # must fail (no port 80)
ws$ for p in 5432 6379 8787; do nc -vz -w3 api.agentfleet.vip $p; done    # all must fail
ws$ nmap -Pn -p- <VPS_IP>                                                  # open: 22, 443 only
```

**Rollback:** follow stages 18 → 17, in that order: close 443, remove the drop-in,
restore `runtime.env`, restart. The service is then loopback-only again.

## Stage 20 — `fleet:doctor` validation

```bash
vps$ pnpm fleet:doctor                       # DEPLOYMENT: OK
vps$ pnpm fleet:verify                       # the only remaining SAFE FOR DRY RUN blocker: fleet cap = 2
vps$ sudo scripts/fleet-verify-deployment.sh # all PASS, including "remote drop-in maps exactly tls.key and tls.crt"
```

"HTTPS valid" and "remote controller reachable" must both be PASS.

**Soak.** Leave public HTTPS running and observe it before the cap change. A soak of 24 h
is recommended.
- Check `/healthz` from outside periodically.
- Watch the journal for restarts or errors (`systemctl show -p NRestarts automaton-fleet`).
- Confirm certbot's timer is scheduled (`systemctl list-timers certbot.timer`).
- Install the renewal hook from "Certificate renewal" below, and run `certbot renew --dry-run`.

"Public HTTPS proven healthy" means: every stage 19 check passes, `fleet:verify` shows
only the cap blocker, and the soak shows no restarts or errors.

## Stage 21 — Operator-controlled cap change from 1 to 2

**STOP S9.** Only after stage 20 is fully green.

```bash
vps$ pnpm fleet:admin status | jq '.state | {maxAgents, livingAgents, reservedSlots, quarantinedSlots}'
vps$ pnpm fleet:admin set-cap 2
vps$ pnpm fleet:verify                       # SAFE FOR DRY RUN: yes
```

This changes only the registry cap. `runtime.env` gets no `FLEET_MAX_AGENTS`. Agent-side
replication stays off through four independent switches:
- `REAL_REPLICATION_ENABLED=false`;
- `replication_enabled` is false in the registry;
- DEVELOPMENT mode;
- no living agent can request replication.

**Rollback:** `pnpm fleet:admin set-cap 1`, possible while at most one slot is in use.

## Stage 21b — Witness release (schema v7)

**STOP S9b.** FLEET-KI-4 (the root witness and the `witness` capability scope) is
not in `11c0c7c`. The dry run therefore needs a newer approved release. Each
step below changes the runtime identity or the live schema, so each needs
explicit approval.

1. **Pin the release.** The operator reviews, commits and publishes the witness
   change. Then produce the new pins from a clean clone (the stage 10 procedure):
   ```bash
   vps$ scripts/fleet-build-runtime.sh https://github.com/5l4mm3r/automaton-fleet.git <newCommit>
   ```
   The approved runtime may change only while no lease is open and no child is
   living, which is the case here.
2. **Install the release.** Set the four `FLEET_RUNTIME_*` pins in `runtime.env`
   (`sudoedit`, then `diff` against a backup). Then:
   ```bash
   vps$ scripts/fleet-deploy-release.sh build
   vps$ sudo scripts/fleet-deploy-release.sh install
   ```
3. **Migrate**, with the new tooling checkout at the same commit:
   ```bash
   vps$ pnpm fleet:migrate-check     # {"currentVersion":6,"resultingVersion":7,"wouldApply":[7]}, rolled back
   vps$ pnpm fleet:migrate           # applies v7; every existing agent becomes capability_scope 'full'
   vps$ pnpm fleet:audit-privileges  # PASS
   ```
4. **Approve and restart:** `pnpm fleet:admin approve-runtime` (the new pins), then
   `sudo systemctl restart automaton-fleet.service`. Check `/readyz` returns 200, and
   `pnpm fleet:doctor` and `pnpm fleet:verify` show the same results as before.
5. **Create the witness user and unit.** `sudo scripts/fleet-os-setup.sh` (dry run),
   then `--apply`. It creates `automaton-fleet-witness` (system, nologin, no groups)
   and installs `automaton-fleet-witness.service`, **not enabled**.
   `sudo scripts/fleet-verify-deployment.sh` must show the witness user cannot read
   any secret and is in no other group.

**Rollback:**
- Before step 3: reinstall the previous release (`current` → `releases/11c0c7c…`),
  restore `runtime.env`, restart.
- After the migration: v7 is additive (one column, triggers, replaced functions),
  and v6 code refuses a v7 registry. Rolling back therefore means restoring the
  pre-migration dump, taken with the stage 0 procedure immediately before step 3.

## Stage 22 — Zero-money dry-run child

"Zero-money" means the fleet moves no money:
- no transfer, payment or signing;
- the child has a keyless wallet address;
- custody is frozen at a zero limit by a database trigger;
- capital allocations are refused.

It does **not** mean zero cost. The run creates **one real Conway sandbox** (1 vCPU,
1 GB, 10 GB), which consumes Conway credits. Conway has no API to stop or delete it
afterwards, so the sandbox must be removed by hand.

### Prerequisites (STOP S10)

1. **Stage 21b complete:** the witness release is approved and the registry is at v7.
2. **A living root: the root witness (FLEET-KI-4).** The preflight (and
   `fleet_reserve_dry_run`) requires `--root` to be an ACTIVE root, which means one
   that heartbeats *and* passes controller challenges.
   - The witness does exactly that and nothing else. It has no agent loop, no
     inference and no wallet.
   - Its identity has capability scope `witness`, so the fleet service and the
     database refuse it every other route and action.
   - Enrolling it takes one slot, so the cap of 2 leaves exactly one slot for the child.

   Enroll it and start it **within 2 minutes**; an enrolled root without heartbeats
   becomes UNRESPONSIVE after 120 s:
   ```bash
   vps$ umask 077; d=$(mktemp -d)
   vps$ pnpm fleet:admin enroll-witness-root dry-run-witness-$(date -u +%Y%m%d) "$d/witness.json"
          # prints {agentId, role:"root", capabilityScope:"witness", runtimeCommit, custodyFrozen:true, credentialFile}; never the token
   vps$ sudo install -d -m 0700 -o automaton-fleet-witness -g automaton-fleet-witness /var/lib/automaton-fleet-witness
   vps$ sudo install -m 0600 -o automaton-fleet-witness -g automaton-fleet-witness "$d/witness.json" /var/lib/automaton-fleet-witness/fleet-credentials.json
   vps$ rm -rf "$d"
   vps$ sudo systemctl start automaton-fleet-witness.service       # start only; never enable
   ```
   Verify it is ACTIVE:
   ```bash
   vps$ journalctl -u automaton-fleet-witness -n 20 --no-pager      # witness_started, witness_heartbeat with a passed challenge
   vps$ pnpm fleet:admin status | jq '.agents[] | select(.agentId=="<rootAgentId>") | {status, capabilityScope}'   # active, witness
   ```
   If the witness exits with code 4 (startup refusal), read the journal: it names
   the refused condition. Exit code 3 means the controller no longer accepts it.
3. SAFE FOR DRY RUN (stage 21). No open orphan, stuck reservation or uncertain provisioning.
4. `CONWAY_API_KEY` available to the operator, with enough Conway credit for one small
   sandbox for the duration of the run.

### Preflight (no side effects)

```bash
vps$ pnpm fleet:dry-run-child --root <rootAgentId> --api-url https://api.agentfleet.vip   # "ok": true, "problems": []
```

### Real run (STOP S10: creates one paid sandbox)

```bash
vps$ read -rs CONWAY_API_KEY && export CONWAY_API_KEY
vps$ FLEET_DRY_RUN_CHILD=true pnpm fleet:dry-run-child --root <rootAgentId> \
       --api-url https://api.agentfleet.vip --confirm-real-sandbox | tee ~/dry-run-report.json
vps$ unset CONWAY_API_KEY
```

`FLEET_DRY_RUN_CHILD=true` exists only in that one command's environment. `runtime.env`
keeps `false`.

**Success criteria (all required):**
- `"ok": true`, with every step `ok` in the report: reserve → claim → tracked sandbox →
  install (pinned commit, lockfile, frozen install, build) → attest → activate →
  credential → start → verify.
- `pnpm fleet:admin status`: the child is ACTIVE and `dry_run`, and a challenge has been
  passed. The population is at most 2.
- The report's `authority` shows zero spend, frozen custody and no replication.
- The service journal and `/var/log/automaton-fleet/audit.jsonl` show the session,
  heartbeats and the passed challenge.
- `pnpm fleet:verify` shows SAFE FOR REAL REPLICATION still blocked only by its
  structural blockers. The dry run itself counts as satisfied.

**On failure:**
- After activation, the command quarantines the child itself.
- Before activation, the attempt becomes FAILED_PROVISIONING or ORPHANED, per policy.
- Inspect it with `pnpm fleet:admin provisioning`, `pnpm fleet:admin orphans` and
  `pnpm fleet:admin reconcile-provisioning`.
- Do not retry until the attempt is reconciled.

### Retire the dry-run child (STOP S11)

```bash
vps$ pnpm fleet:admin quarantine <childAgentId> "dry run complete"   # revokes everything; the child becomes ORPHANED with a quarantine slot
```

1. Delete the sandbox by hand in Conway: the sandbox named `fleet-<provisioning key>`.
2. Then record the evidence:
   ```bash
   vps$ pnpm fleet:admin resolve-orphan <childAgentId> "sandbox <id> deleted manually in Conway on <date>"
   ```
3. Stop and retire the root witness. It revokes nothing by itself; the operator
   does that:
   ```bash
   vps$ sudo systemctl stop automaton-fleet-witness.service
   vps$ pnpm fleet:admin mark-dead <rootAgentId> "dry-run witness retired"   # revokes its credential and every session
   vps$ sudo rm /var/lib/automaton-fleet-witness/fleet-credentials.json
   ```
   Its keyless address is used up permanently. A later dry run enrolls a new witness.
4. The operator decides whether the cap returns to 1: `pnpm fleet:admin set-cap 1`.
   Returning it is recommended until real replication has been reviewed.

---

## Certificate renewal requires a service restart

`LoadCredential=` copies `fleet.key` and `fleet.crt` into
`/run/credentials/automaton-fleet.service/` **only when the service starts**. Renewing
the certificate therefore changes nothing the service uses until:
1. the new files are copied into `/etc/automaton-fleet/tls/` (single-link, root:root 0600/0644), and
2. the service is restarted.

There are two further constraints:
- The service **refuses to start** if the certificate expires within one day, doesn't
  cover the hostname or doesn't match the key. A renewal that is never applied therefore
  turns the next restart into an outage.
- Let's Encrypt certificates last at most 90 days, and shorter lifetimes are being phased
  in. Certbot's timer renews once about a third of the lifetime remains.

Install this deploy hook (root 0755) as
`/etc/letsencrypt/renewal-hooks/deploy/automaton-fleet.sh`. Certbot runs it only after a
**successful** renewal.

```bash
#!/usr/bin/env bash
# Copy a renewed api.agentfleet.vip certificate into the LoadCredential sources and
# restart the fleet service; restore the previous pair if the service does not come back.
set -euo pipefail
[[ "${RENEWED_LINEAGE:-}" == /etc/letsencrypt/live/api.agentfleet.vip ]] || exit 0
T=/etc/automaton-fleet/tls; umask 077
key="$RENEWED_LINEAGE/privkey.pem"; crt="$RENEWED_LINEAGE/fullchain.pem"
cmp -s <(openssl pkey -in "$key" -pubout) <(openssl x509 -in "$crt" -noout -pubkey) || { echo "renewed key/cert mismatch" >&2; exit 1; }
openssl x509 -in "$crt" -noout -checkend 172800 >/dev/null || { echo "renewed cert expires within 2 days" >&2; exit 1; }
openssl x509 -in "$crt" -noout -ext subjectAltName | grep -qE '(^|[[:space:],])DNS:api\.agentfleet\.vip([[:space:],]|$)' || { echo "renewed cert lacks hostname" >&2; exit 1; }
install -m 0600 -o root -g root "$T/fleet.key" "$T/fleet.key.prev"
install -m 0644 -o root -g root "$T/fleet.crt" "$T/fleet.crt.prev"
install -m 0600 -o root -g root "$key" "$T/fleet.key.new" && mv -f "$T/fleet.key.new" "$T/fleet.key"
install -m 0644 -o root -g root "$crt" "$T/fleet.crt.new" && mv -f "$T/fleet.crt.new" "$T/fleet.crt"
# A failed restart must not abort the script before the health check / rollback below.
systemctl restart automaton-fleet.service || true
for _ in $(seq 1 30); do
  curl -fsS -m 3 http://127.0.0.1:8787/healthz >/dev/null 2>&1 && curl -fsS -m 3 https://api.agentfleet.vip/healthz >/dev/null 2>&1 \
    && { rm -f "$T/fleet.key.prev" "$T/fleet.crt.prev"; echo "fleet TLS renewed and serving"; exit 0; }
  sleep 2
done
echo "service not healthy after renewal; restoring previous certificate" >&2
mv -f "$T/fleet.key.prev" "$T/fleet.key"; mv -f "$T/fleet.crt.prev" "$T/fleet.crt"
# A crash loop on the bad pair may have hit StartLimitBurst; clear it so the restore can start.
systemctl reset-failed automaton-fleet.service || true
systemctl restart automaton-fleet.service
exit 1
```

- **Test:** `sudo certbot renew --dry-run` exercises issuance and the pre/post hooks, but
  **does not run deploy hooks**. Test the hook once by hand:
  `sudo RENEWED_LINEAGE=/etc/letsencrypt/live/api.agentfleet.vip /etc/letsencrypt/renewal-hooks/deploy/automaton-fleet.sh`.
  It restarts the service, so schedule the test.
- **Impact of a restart:** in-flight requests drain for up to 10 s, and new requests get
  503 until the service is up. Sessions, nonces and leases live in PostgreSQL, so they
  survive. Agents retry, and one missed heartbeat is well inside `unresponsive_s`.
- **Monitoring (to be set up):**
  - alert when `fleet.crt` is within 14 days of expiry
    (`openssl x509 -in /etc/automaton-fleet/tls/fleet.crt -noout -checkend 1209600`);
  - alert when `certbot.timer` is not scheduled;
  - alert when the deploy hook exits non-zero. It logs to `/var/log/letsencrypt/letsencrypt.log`.
- After any renewal, `sudo scripts/fleet-verify-deployment.sh` must still pass. `.prev`
  files exist only during the hook.

## Cleanup after cutover

### Database dumps
| Copy | SHA-256 | Mode | Recommendation |
|---|---|---|---|
| VPS `~ubuntu/automaton-fleet-final-frozen.dump` | `7473a22f…e06b` | 0664 | **Delete.** The restore is verified, and an identical copy exists on the local VM |
| VPS `~ubuntu/automaton-fleet-pre-vps.dump` | `9e479159…0b0c` | 0664 | **Delete.** The final frozen dump supersedes it |
| Local `~/backups/automaton-fleet/automaton-fleet-final-frozen.dump` | `7473a22f…e06b` | 0664 | Keep as the cutover backup. `chmod 0600` it now. Keep an encrypted off-host copy (for example `age` or `gpg -c`), then delete the plaintext once public HTTPS is proven |
| Local `~/backups/automaton-fleet/automaton-fleet-pre-vps.dump`, `pre-v6-*.dump` | — | 0664 | Superseded: delete, or encrypt and archive |

The dumps contain registry state, the audit history and token and session **hashes**.
Treat them as confidential. The VPS copies belong to `ubuntu`, so deleting them needs no sudo:
```bash
vps$ sha256sum ~/automaton-fleet-*.dump                  # re-confirm they match the local copies first
vps$ rm -f ~/automaton-fleet-final-frozen.dump ~/automaton-fleet-final-frozen.dump.sha256 \
           ~/automaton-fleet-pre-vps.dump ~/automaton-fleet-pre-vps.dump.sha256
```
(`shred` gives no guarantee on journaled ext4 or virtual disks, so a plain `rm` is used.)

### Passwordless sudo for `ubuntu`
`sudo -n true` currently succeeds. The cloud image's default is normally
`/etc/sudoers.d/90-cloud-init-users` with `ubuntu ALL=(ALL) NOPASSWD:ALL`. Anyone holding
the `ubuntu` SSH key therefore has root without a second factor.

Plan (operator-run, approval-gated). Do it after S8 has been verified, or earlier if preferred.
Keep a second SSH session open, and have the OVH KVM console ready as the recovery path.
1. `sudo passwd ubuntu`. Set a strong password, or create the named operator account from
   stage 1 and move the `automaton-fleet-admin` membership to it.
2. `sudo grep -rn NOPASSWD /etc/sudoers /etc/sudoers.d/`. Find the exact source.
3. Replace it with a password-requiring rule:
   `echo 'ubuntu ALL=(ALL:ALL) ALL' | sudo install -m 0440 -o root -g root /dev/stdin /etc/sudoers.d/90-cloud-init-users.new`,
   then `sudo visudo -cf /etc/sudoers.d/90-cloud-init-users.new`, then `sudo mv` it over the original.
4. Check it from the **second** session: `sudo -k; sudo -n true` must fail, and `sudo -v` must succeed with the password.
5. Check that cloud-init won't write it back on a new instance ID: look at `/etc/cloud/cloud.cfg`,
   `default_user.sudo`, or set it in `/etc/cloud/cloud.cfg.d/99-fleet-sudo.cfg`.

After this, privileged steps go back to the operator typing sudo, as on the local VM.

## Full cutover rollback

1. `vps$ sudo systemctl disable --now automaton-fleet.service` (and `sudo ufw delete allow 443/tcp`).
2. Remove the `api.agentfleet.vip` A record.
3. If the VPS registry accepted any change after stage 9 (enrollment, cap change,
   dry run), dump it (the stage 0 procedure, on the VPS) and restore it onto the local VM.
   The VPS is the source of truth from that point.
4. `local$ sudo systemctl enable --now automaton-fleet.service`, then check `/readyz`,
   `pnpm fleet:doctor` and `pnpm fleet:admin status`.
5. Keep the VPS database until the operator decides otherwise.

## Assumptions to confirm on the live VPS

- Ubuntu 24.04 LTS on x86_64, with systemd ≥ 255 (for `LoadCredential=` and ACL
  behaviour identical to the local VM).
- OVH's default login (`ubuntu`), the cloud-init sshd drop-in, and whether an OVH network
  firewall or anti-DDoS profile sits in front of the IP.
- The VPS has a public IPv4 address (IPv6-only is not supported by the current `FLEET_PUBLIC_LISTEN`).
- ~~Who hosts DNS for `agentfleet.vip`~~ Porkbun (2026-09-24). Its API keys are account-wide, so the plan uses HTTP-01 (stage 15).
- Ubuntu's PostgreSQL 16 package defaults (`listen_addresses=localhost`, scram `pg_hba`)
  and Redis defaults (`bind 127.0.0.1 -::1`, `protected-mode yes`).
- Whether Redis should be installed at all while no fleet code uses it.
- The local database name is `automaton_fleet`, owned by `fleetadmin`, with every
  fleet object in schema `fleet`. `pg_restore --role=fleetadmin` succeeds without
  extensions or objects outside that schema.
- GitHub is reachable from the VPS, and `11c0c7c` is still on the published
  `fleet-development` branch of the fork.
- ~~The build ID reproduces on the VPS~~ Confirmed 2026-09-24 with Node v22.23.3 and the repository's pnpm 10.28.1.
- `certbot` from Ubuntu 24.04 issues ECDSA keys by default. The service's key/certificate
  checks accept them; this is expected but still to be confirmed at stage 19.
- The operator account can run `pnpm fleet:*` with `admin.env` group access, and
  `automaton-fleet-service` cannot read it (`fleet-verify-deployment.sh`).
- That the witness release (stage 21b) builds reproducibly on the VPS, and the live v6 → v7 migration applies cleanly to the restored registry.
