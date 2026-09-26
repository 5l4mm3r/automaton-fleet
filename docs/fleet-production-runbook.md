# Fleet production VPS deployment and cutover runbook

Target: one OVH VPS running Ubuntu 24.04 LTS, which becomes the fleet control
plane (FleetController, PostgreSQL, Redis) behind `https://api.agentfleet.vip`.
Source: the local Ubuntu development VM, which runs the same release loopback-only.

**Status (2026-09-24):** stages 0–21 and stage 21b (S9b) are complete. Public HTTPS has been live at
`https://api.agentfleet.vip` since 18:25:59 UTC, and the fleet cap has been 2 since
18:45:13 UTC. Since S9b the runtime is `cdfd70c` (build `6d0eee34…`) on schema v7, after a
planned outage of about 19:57–20:10 UTC. The witness OS user and unit are installed, but
no witness is enrolled or started. `fleet:doctor` reports DEPLOYMENT OK and **SAFE FOR DRY RUN: YES**.
Stage 22 (dry-run child) has not started. See [Deployment record](#deployment-record-2026-09-24) for what
was run, the deviations the operator accepted, and the [live state after S9b](#state-after-s9b-2026-09-24-2020-utc).

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
| Runtime commit (cutover, stages 0–21) | `11c0c7c02592d43a2c1350b779eaa795a237f3b7` |
| Build ID (cutover, stages 0–21) | `e388571a140f7cb20e289e1e64d152571adea5f207c2290c09888f80f6e3c624` |
| Runtime commit (current, since stage 21b) | `cdfd70c842f43c8e3b8576ac07ebcd80cc3d4633` |
| Build ID (current, since stage 21b) | `6d0eee3427415918d91d5a88b4fa8814cf1574c141226fb15bc6c7d41ac70d0c` |
| Lockfile SHA-256 (both) | `eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811` |
| Database schema | v6 for the cutover; **v7** since stage 21b |
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
| Login | `ubuntu`, key only; SSH alias `agentfleet-vps`. **Correction (B2 closeout):** until 2026-09-24 ~23:55 UTC the *effective* setting was `PasswordAuthentication yes`, because sshd keeps the first value it reads and `50-cloud-init.conf` (`yes`) sorts before `60-cloudimg-settings.conf` (`no`). `/etc/ssh/sshd_config.d/10-fleet-no-passwords.conf` now sets `PasswordAuthentication no` / `KbdInteractiveAuthentication no` first; `sshd -T` confirms both are `no` |
| Host keys | ED25519 `SHA256:HUuqOfrwidWq3SagFJD3rEavFX29u89cy1vIqun0tRg`, ECDSA `SHA256:Rm5H28vhzH9/hoc82EJ/Gk3jRfCo58prkwzOmfg6NjA`, RSA `SHA256:8wKSAe0hWQVxBhpDQNGGN4xCs6geOz/8jJ5pvfLBmpU` |
| Platform | Ubuntu 24.04.4 LTS, kernel 6.8.0-136, x86_64, systemd 255.4; 4 vCPU, 7.6 GiB, 72 GB disk |
| Toolchain | Node **v22.23.3** (apt, `/usr/bin/node`), global pnpm 10.34.5 (the repo workflow uses 10.28.1 via `packageManager`), PostgreSQL 16.15, Redis 7.0.15 |
| Build clone | `~ubuntu/automaton-fleet-build`, clean; at `11c0c7c` for stages 0–21, `cdfd70c` from stage 21b, `03f8760` from B0, and detached at `4d6a0be` since B2 (it is also the operator tooling checkout) |

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

### Stage 21b (S9b): witness release and schema v7 (2026-09-24)
Each gate was approved separately. The operator chose a planned outage: the controller was stopped
before the backup and started only once the release, pins, registry approval and schema all agreed.

| Gate | Result |
|---|---|
| 1 | Runbook edits committed as `eadb842` (docs only). `fleet-development` fast-forwarded `11c0c7c..eadb842` on fleet-origin. The runtime pin is `cdfd70c`, not the docs commit |
| 2 | `scripts/fleet-build-runtime.sh … cdfd70c…` on the VPS: build `6d0eee34…0d0c`, lockfile `eee9dc2f…` (the same as a local preview build) |
| 3 | `runtime.env.pre-witness` = `66e55b23…` (backup). `sudoedit` changed exactly two lines (`FLEET_RUNTIME_COMMIT`, `FLEET_RUNTIME_BUILD_ID`). `runtime.env` is now SHA-256 `447b5929a6503f2ff9f780cf8897eed32c352df60e954b22d0ca2b9966883f3c`, root:root 0644 |
| 4a | `fleet-deploy-release.sh build`: verified build staged at `~/.cache/automaton-fleet/stage/cdfd70c…` |
| 4b | `sudo fleet-deploy-release.sh install`: `current` → `releases/cdfd70c…` (887 files, root-owned, read-only). `releases/11c0c7c…` is kept for rollback. The running controller was not restarted |
| 5 | The tooling checkout was moved to `cdfd70c`; `pnpm install --frozen-lockfile`; clean |
| 6 | **Outage start 19:57 UTC:** `systemctl stop automaton-fleet`. Pre-v7 backup `~ubuntu/automaton_fleet-v6-pre-v7.dump`: 450857 bytes, SHA-256 `ccde45b5d05bf0973cb35b2b56a0275c59d8b993df104f6d8cd70c3c0c069e10`, 0600. `pg_restore -l` shows 25 tables with data, 65 functions, 42 triggers. Row counts are in `~ubuntu/fleet-rowcounts-pre-v7.txt` (52 rows) |
| 7 | `migrate-check` gave exactly `{"currentVersion":6,"resultingVersion":7,"wouldApply":[7]}`. `fleet:migrate` applied v7 (`capability_scope_witness`, 20:00:47 UTC). `audit-privileges` PASS. The ACL diff against the dump is only 2 new `REVOKE … FROM PUBLIC`. Row-count changes: migrations 6 → 7, events +2 (role re-grants) |
| 8 | `approve-runtime` wrote event 47, `runtime_approved` (previous: `11c0c7c`/`e388571a…`). `verify-runtime` VERIFIED and schema v7 healthy before the start. **Outage end 20:10:24 UTC:** `systemctl start automaton-fleet` |
| 9 | `fleet-os-setup.sh` (dry run, then `--apply`): created `automaton-fleet-witness` (uid 995 / gid 985, nologin, no other groups) and installed `automaton-fleet-witness.service` (root 0644, **disabled, inactive**). All other steps re-applied values that were already in place. `fleet-verify-deployment.sh` 23/23 PASS; the witness user cannot read `admin.env`, `service.env` or `tls/fleet.key` |

### State after S9b (2026-09-24 ~20:20 UTC)
- `automaton-fleet.service` is active from `releases/cdfd70c…`, started 20:10:24 UTC, 0 restarts.
- Runtime `cdfd70c842f43c8e3b8576ac07ebcd80cc3d4633` / build `6d0eee3427415918d91d5a88b4fa8814cf1574c141226fb15bc6c7d41ac70d0c` /
  lockfile `eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811`, which `runtime.env`, the registry approval and the installed tree all match.
- Schema v7 (7 migration rows). Registry: `maxAgents=2`, mode DEVELOPMENT, replication off, 0 living / 0 reserved / 0 quarantined, zero agents.
- Listeners: `0.0.0.0:443` (FleetController HTTPS) and 22 public; `127.0.0.1:8787`, `127.0.0.1:5432`, `127.0.0.1:6379`, `[::1]:6379` loopback. From outside, 80, 5432, 6379 and 8787 are unreachable, and `/healthz` returns 200.
- Root witness: OS user and unit installed. **Not enrolled, activated or started**, and no witness credential exists.
- `REAL_REPLICATION_ENABLED`, `REAL_PAYMENTS_ENABLED`, `OWNER_SWEEP_ENABLED` and `FLEET_DRY_RUN_CHILD` are `false`. `FLEET_REMOTE_LISTEN_ENABLED=true`.
- `fleet:doctor` DEPLOYMENT OK (warnings only: sandbox termination, wallet custody). `fleet:verify` 16/16 PASS, SAFE FOR DRY RUN: YES. `fleet:verify-runtime` VERIFIED. `audit-privileges` PASS.

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
- **S9b rollback material:** `/etc/automaton-fleet/runtime.env.pre-witness` (`66e55b23…`),
  `/opt/automaton-fleet/releases/11c0c7c…`, and the pre-v7 dump `~ubuntu/automaton_fleet-v6-pre-v7.dump`
  (0600, with `.sha256` and `fleet-rowcounts-pre-v7.txt`). Returning to v6 needs that dump restored (destructive, separate approval).
- **S9b working files in `~ubuntu`** (`s9b-cdfd70c-pins.txt`, `s9b-cdfd70c-build.log`, `s9b-gate4a-build.log`, `s9b-gate5-install.log`) are mode 0664. They hold no secrets.
- **The JSONL audit file is written without `scrubDetail`** (`src/fleet/service/main.ts:258`); only the stdout and database copies are scrubbed. Found during the post-S9b design review; not fixed yet.
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

## Stage B2 — Operator API, schema v8 (completed 2026-09-24)

Each gate below was approved separately and has been run; the completion record
and the resulting production state follow the procedure. Design and
reconciliation: `docs/design/phase-b-operator-api.md` §15 and §18.

Invariants for the whole stage:
- The safety flags, fleet cap and mode do not change.
- The Operator API stays loopback-only (127.0.0.1:8788) and is reached through an
  SSH tunnel. No firewall change.
- Every database secret is generated on the VPS and never printed or copied off it.
- The operator kill switch stays **off** until B2-12.

| Gate | Action | Production change | sudo |
|---|---|---|---|
| B2-3 | Local review of the B2-2 diff; fix findings; local commit (no push) | no | no |
| B2-4 | Push the reviewed commit to `fleet-origin` (never `origin`) | no (GitHub) | no |
| B2-5 | VPS reproducible build of the commit; record commit, build ID, lockfile SHA | no | no |
| B2-6 | `runtime.env` pin update (backup, `sudoedit`, 2-line diff); stage and install the release; move the tooling checkout | yes | yes |
| B2-7 | **Planned outage:** stop the controller; verified 0600 pre-v8 dump; `migrate-check` (exactly v7→v8) → `migrate` → `audit-privileges` | yes, **database** | yes |
| B2-8 | `approve-runtime` → `verify-runtime` → start the controller → post-start verification (16/16) and the B0 canary | yes | yes |
| B2-9 | `fleet-os-setup.sh` (user `automaton-fleet-operator-api`, `operator.env` root:automaton-fleet-operator-api 0640 with a fresh password, unit installed **not enabled**, logrotate); then `fleet-db-setup.sh` (creates `fleet_operator` / `fleet_operator_login`); then `grant-operator-role` and `audit-privileges`; `fleet-verify-deployment.sh` | yes, **new database secret** | yes |
| B2-10 | Start `automaton-fleet-operator-api.service`; `/readyz` must say `disabled`; doctor shows the operator checks; the audit file is 0600 | yes | yes |
| B2-11 | Tunnel account `fleet-op-tunnel`, restricted `authorized_keys` (permitopen=127.0.0.1:8788 only), `sshd -t` | yes (SSH configuration) | yes |
| B2-12 | Key generated on the dev VM (`fleet:operator-keygen`, private key never leaves it); `operator-enroll bridge-claude` with the public key; fingerprint checked out of band; `operator-api enable`; `whoami` / `status` smoke test through the tunnel; audit rows checked | **database** | no |

Order notes:
- **Operator-role sequencing rule (found at the B2-7 preflight, fixed in `4d6a0be`).**
  Schema v8 reaches production before the operator roles exist.
  - *Neither* `fleet_operator` nor `fleet_operator_login` existing is the valid
    **not provisioned** state: `audit-privileges`, doctor and the "PostgreSQL
    roles correct" checklist item PASS and say "operator roles: not provisioned".
  - A *partial* state (only one of the two roles) **fails** the audit.
  - Once both exist (B2-9 onward), every strict operator check applies. The
    Operator API's own startup check always requires both roles.
- The v8 build refuses a v7 registry and the v7 build refuses v8, so B2-6 to B2-8
  are one coordinated cutover with the same rollback shape as S9b (restore the
  pre-v8 dump and the previous `current` release).
- `fleet-db-setup.sh` now requires `/etc/automaton-fleet/operator.env`. Run
  `fleet-os-setup.sh` first (B2-9).
- `migrate` grants the operator role only if it exists. After the roles are
  created in B2-9, run `fleet:admin grant-operator-role`.
- The Operator API refuses to start if it can read `admin.env`, `service.env` or
  TLS files, if its DSN is the owner or service login, if the schema is not 8, or
  if its pins differ from the approved runtime.

Retention (Amendment 1): doctor warns at 50% (early warning) and 75% (ELEVATED)
of the 2,000,000-row request cap and fails at 100%, where requests fail closed
with `FLEET_OP_AUDIT_FULL`. Nothing is deleted automatically. The only removal
is `fleet:admin operator-archive --before <ts> --out <new file> [--max-rows N]`.
It handles at most 100,000 of the oldest rows per call. It writes a 0600 export
into a private directory, reads it back to verify it, and deletes the rows only
if the database recomputes the same row count and SHA-256. On any failure, no
rows are deleted. Repeat the command, with a new `--out` each time, until the
`operator_requests_archived` event reports `remaining: 0`. It needs its own
approval.

Clock: readiness needs `/run/systemd/timesync/synchronized` (systemd-timesyncd).
If the VPS uses another NTP daemon, decide in B2-10 whether to set
`FLEET_OPERATOR_TIMESYNC_MARKER` (a drop-in, approved separately). The
logrotate file installed in B2-9 also starts rotating the controller's existing
`/var/log/automaton-fleet/audit.jsonl` (50 MB × 14, by rename, which is safe
because the sink reopens the file on every append).

Emergency controls (no restart needed; the database checks every request):
`operator-revoke-key`, `operator-revoke`, `operator-revoke-all` (which also turns
the kill switch off), and `operator-api disable`.

### B2 completion record (2026-09-24, times UTC)

| Gate | Result |
|---|---|
| B2-2/B2-3 | Operator API implemented and security-reviewed locally. Reviewed commit `5a5469e` ("feat: read-only Operator API with schema v8") |
| B2-4 | `fleet-development` fast-forwarded `03f8760..5a5469e` on fleet-origin (never `origin`) |
| B2-5 | `5a5469e` reproduced locally (Node 22.23.2) and on the VPS (22.23.3): build `1c6b985f…1b74`, lockfile `eee9dc2f…a811` |
| B2-6 | `runtime.env.pre-b2` backup (`ce306628…`, the B0 pins). Pins moved to `5a5469e`; release staged, verified and installed at `releases/5a5469e…`; tooling moved. The controller kept running B0 from memory |
| B2-7 preflight **STOP** | Before the outage: the `5a5469e` privilege audit reported the not-yet-created operator roles as failures, so after the cutover `audit-privileges` would have FAILED and verify would have been 15/16. The fix is commit `4d6a0be` ("fix: treat absent Operator API roles as not provisioned in the privilege audit"; see the sequencing rule above), pushed `5a5469e..4d6a0be`. It reproduced locally and on the VPS: build `54beb10104a11888446ed1d09a85f236d87b977558a88514de7600d7dcc83ced`, lockfile unchanged. The pins were moved to `4d6a0be` (backup `runtime.env.pre-b2-fix` = `12f3fc6e…`), then staged, installed and moved into tooling. `runtime.env` is now `c3d872ea…` |
| B2-7 | **Outage start 23:33:09**: controller stopped. Pre-v8 dump `~ubuntu/automaton_fleet-v7-pre-v8.dump`: 459277 bytes, 0600, SHA-256 `e76f50c9b22193b061048ee005448aa25f810d18167e8380642cde01418b96dd` (plus `.sha256`). `pg_restore -l` lists 25 tables with data. Row counts are in `~ubuntu/fleet-rowcounts-pre-v8.txt` (0 agents, 71 events, 7 migrations). `migrate-check` gave exactly `{"currentVersion":7,"resultingVersion":8,"wouldApply":[8],"rolledBack":true}`. v8 (`operator_api_read_only`) applied at 23:33:26. `audit-privileges` PASS with "operator roles: not provisioned"; events 72/73 are the role re-grants |
| B2-8 | `approve-runtime` wrote event 74 (`4d6a0be` / `54beb101…` / `eee9dc2f…`); `verify-runtime` VERIFIED. **Outage end 23:33:57** (~48 s): controller PID 40569, running from `releases/4d6a0be…` (checked via the process's cwd). Doctor DEPLOYMENT OK, `fleet:verify` 16/16, `fleet-verify-deployment.sh` clean; public `/healthz` 200, `/readyz` 404, unauthenticated POST 401, foreign Origin 403 |
| B2-9 | `fleet-os-setup.sh --apply` (the existing units and node binary were byte-identical): user `automaton-fleet-operator-api` (uid 994 / gid 984, nologin, own group only); `operator.env` root:automaton-fleet-operator-api 0640 with one DSN and a fresh password generated on the VPS, never displayed; unit installed (disabled); `/etc/logrotate.d/automaton-fleet`. `fleet-db-setup.sh --apply` created `fleet_operator` (NOLOGIN) and `fleet_operator_login` (LOGIN, limit 8, 5 s / 2 s / 10 s timeouts); agent/service passwords were re-set to their existing values. `grant-operator-role` wrote event 82 (EXECUTE on the 8 `op_*` functions, no tables). Strict audit PASS with operator roles provisioned. Probes as the login: no table access, no `svc_*` / `fleet_event` / archival functions, no CREATE or TEMP |
| B2-10 | Operator API started at 23:40:04 as PID 42287. It listens on `127.0.0.1:8788` only; `/readyz` 503 `disabled`; requests fail closed. Audit log `/var/log/automaton-fleet-operator/audit.jsonl` is 0600 (directory 0700). Inside the service's mount namespace, as its uid, `admin.env`, `service.env`, TLS, the witness and the controller logs are denied or hidden. No capabilities, `NoNewPrivs`, seccomp; systemd exposure score 1.1 |
| B2-11 | Tunnel account `fleet-op-tunnel` (uid 993 / gid 983, nologin, locked password). Root-owned `/var/lib/fleet-op-tunnel/.ssh/authorized_keys` holds `restrict,port-forwarding,permitopen="127.0.0.1:8788",command="/usr/sbin/nologin"`. `/etc/ssh/sshd_config.d/70-fleet-op-tunnel.conf` is a per-user `Match` block ending in `Match all`. Staged `sshd -T` showed no change for other users; `sshd -t` passed; SSH reloaded, not restarted. Tunnel transport key (dev VM) `SHA256:wP56E+ziLw3JwnkylaE/AbYX37akdauAcuchUIpK6Ns`. Forwarding works only to `127.0.0.1:8788`; 8787, 5432, 6379, 22, other loopback and external destinations, `-R`, Unix sockets, tun, shell, command, PTY, X11, sftp and scp are all refused |
| B2-12 | `bridge-claude` signing key generated on the dev VM (never on the VPS). Enrolled principal `op_01M3AX56W25JNMQCTBM8HYH474`, kind `bridge_claude`, scopes `ops.read.status`, `ops.read.agents`, `ops.read.events`, key `ec4f06982ae9135fd2b28e928f5a4a61`, expires 2026-10-24 (event 96). The key ID was verified three ways (keygen, openssl on the dev VM, PostgreSQL SHA-256 of the stored key). `operator-api enable` wrote event 97 (generation 2); `/readyz` 200 `ready`; no restart. Signed smoke tests through the tunnel passed: whoami, status, agents (0), events (allow-listed shape; text typed `untrusted_text`). Unsigned, bad-signature, stale, future, replayed (409; events 98/99), unknown-key/principal, non-GET and unknown-route requests all failed closed. The audit log holds no signatures, nonces or key material |
| Closeout | `automaton-fleet-operator-api.service` enabled for boot (`multi-user.target.wants` symlink) without a restart. Global SSH hardened (see Host above): staged `sshd -T` showed that `passwordauthentication yes→no` was the only effective change and that the tunnel block was identical; live `sshd -t` passed, then a reload; a fresh public-key admin login plus sudo worked; password attempts for `ubuntu` and `root` now return `Permission denied (publickey)` |

### State after B2 (2026-09-24 ~23:58 UTC)
- Runtime `4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790` / build `54beb10104a11888446ed1d09a85f236d87b977558a88514de7600d7dcc83ced` /
  lockfile `eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811`. `runtime.env`, the registry approval, the installed tree and the running processes all match. Schema **v8**.
- Releases kept for rollback: `5a5469e`, `03f8760` (B0), `cdfd70c`, `11c0c7c`. Returning to v7 requires restoring the pre-v8 dump (destructive; needs its own approval).
- `automaton-fleet.service`: PID 40569, running from `releases/4d6a0be…`, 0 restarts. `fleet:verify` 16/16; DEPLOYMENT OK; SAFE FOR DRY RUN YES; `fleet-verify-deployment.sh` 36 PASS.
- `automaton-fleet-operator-api.service`: enabled and active, PID 42287, `127.0.0.1:8788` only, kill switch **on** (generation 2), `/readyz` 200.
- Operator principals: exactly one (`bridge-claude`, read-only scopes above) with one active key. **Rotate the key (`operator-add-key`, then `operator-revoke-key`) before 2026-10-24.**
- Registry: cap 2, DEVELOPMENT, replication off; 0 agents. Witness user and unit are installed, disabled and inactive.
- Safety flags: replication, payments, owner sweep and dry-run child are false; remote listen is true.
- Bridge-side material on the dev VM (never on the VPS): `~/.config/automaton-fleet/operator/bridge-claude.key` (0600) and the tunnel transport key `~/.ssh/fleet_op_tunnel` (0600).

## Stage C — ChatGPT read-only adapter (deployed 2026-09-25, times UTC)

Design: `docs/design/phase-c-chatgpt-adapter.md`. The adapter ships as a separately
pinned artifact. The FleetController / Operator API runtime pin, its approval and
`current` are unchanged (`4d6a0be` / `54beb101…`).

| Step | Result |
|---|---|
| Code | `6691b4c` ("feat: read-only ChatGPT adapter over OpenAI Secure MCP Tunnel (Phase C)"), pushed `cb42f87..6691b4c` |
| Reproducible build | Local and VPS builds are identical: build `62336fee32671ea04de3bb18c1552273cd80bc02c1d2bd5f219f1dee3b018057`, lockfile `eee9dc2f…` |
| Backup | Before any change: `~ubuntu/automaton_fleet-v8-pre-chatgpt-20260925T005947Z.dump` (0600, 567517 bytes, SHA-256 `4bd240fbd24d06acf05eb8f64603f4af1e762a7e8967dd4d4d5574b947212634`, 31 tables with data) |
| Artifact | `fleet-deploy-chatgpt-adapter.sh build` + `install`: `/opt/automaton-fleet/chatgpt-adapter/releases/6691b4c…` (root 555, no `.git`), `current` points to it, pins in `/opt/automaton-fleet/chatgpt-adapter/pins.env` |
| tunnel-client | OpenAI `tunnel-client-runtime` v0.0.14. Zip SHA-256 `29d29cf8…505b` matches the release `SHA256SUMS.txt`; binary SHA-256 `94ae9d0c…5c77`. Installed at `/opt/automaton-fleet/tunnel-client/v0.0.14/` (root) |
| `prepare --apply` | Users `automaton-fleet-chatgpt-adapter` (uid 992) and `automaton-fleet-chatgpt-tunnel` (uid 988), nologin, own group only. `/etc/automaton-fleet/chatgpt-tunnel` root 0700; adapter token root 0600 (never printed). Signing key generated **on the VPS as the adapter user**: `/var/lib/automaton-fleet-chatgpt-adapter/bridge-chatgpt.key` 0600, key id `fe22d91c08f0a0676b4c155ce0d618d3` (verified independently from the public key). Units installed |
| Enrolment | `fleet:admin operator-enroll bridge-chatgpt bridge_chatgpt --scopes ops.read.status,ops.read.agents` gave principal `op_01M3B18TXVP33S6NQC909DXD57` (event 112; key expires 2026-10-25). `bridge-claude` is unchanged |
| `configure --apply` | `/etc/automaton-fleet/chatgpt-adapter.json` root:adapter 0640. Adapter socket and service enabled and started (PID 51151); tunnel unit enabled but **inactive** until the owner provides OpenAI credentials |
| Proof (MCP over the adapter socket, as `tunnel-client` sends it) | initialize; exactly 4 read-only tools; whoami gives `bridge_chatgpt` with scopes {agents, status}; status and agents (0) work. Events, path injection, unknown tools and `resources/list` are refused. No token or a wrong token gives 401; OAuth discovery gives 404. The rate limit gives 10 calls, then `RATE_LIMITED`. Only the tunnel user can connect to the socket |
| Isolation | Inside the adapter's namespace only its config, key and `/proc/self/net` are readable. The tunnel sandbox policy blocks 127.0.0.1:{8788, 8787, 5432, 6379, 22} (each reachable without the policy) and allows `api.openai.com`. Neither new user holds a TCP listener. systemd exposure 1.1 / 1.3 |
| Verification | `fleet-verify-deployment.sh` (from the adapter tree): 60 PASS / 0 FAIL. `fleet:verify` 16/16; doctor DEPLOYMENT OK; audit PASS with 2 principals / 2 keys. From outside, 8788, 8787, 5432, 6379 and 8080 are closed. Controller PID 40569 and Operator API PID 42287, both 0 restarts. A fresh Claude MCP session still works as `bridge-claude` |

**Owner actions to finish** (design §8):
1. Create an OpenAI Secure MCP tunnel tied to the ChatGPT workspace, and a runtime key.
2. Put the key and `CONTROL_PLANE_TUNNEL_ID` in `/etc/automaton-fleet/chatgpt-tunnel/`.
3. `systemctl start automaton-fleet-chatgpt-tunnel`.
4. In ChatGPT: create a developer-mode app, Connection → Tunnel, No authentication.

**Rollback:**
- Stop and disable `automaton-fleet-chatgpt-{tunnel,adapter}.service` and `automaton-fleet-chatgpt-adapter.socket`.
- `fleet:admin operator-revoke op_01M3B18TXVP33S6NQC909DXD57`.
- Optionally remove `/opt/automaton-fleet/chatgpt-adapter`, `/opt/automaton-fleet/tunnel-client`, the units and the two users.

Nothing else was changed.

## Stage D3 — Controlled operator actions, schema v9 (DEPLOYED 2026-09-25, times UTC)

D3 is live. Design and current state: `docs/design/phase-d3-operator-actions.md`.
The gate table below was the plan; the record after it is what ran.

| Gate | Action | Privileged | Outage |
|---|---|---|---|
| D3-1 | Review, then a local commit of the D3 work; push to `fleet-origin` | no | no |
| D3-2 | VPS reproducible build of the D3 commit (`fleet-build-runtime.sh`); record the build ID; the lockfile must stay `eee9dc2f…` | no | no |
| D3-3 | `runtime.env`: new commit/build pins (sudoedit; keep `runtime.env.pre-d3`); stage and install `releases/<commit>`; tooling checkout to the commit | yes | no |
| D3-4 | **Planned outage:** stop the Operator API, the ChatGPT adapter, then the controller; take a verified 0600 pre-v9 dump; `migrate-check` must be exactly `{"currentVersion":8,"resultingVersion":9,"wouldApply":[9]}`; `migrate` (re-grants agent/service/operator roles); `audit-privileges` PASS | yes, **database** | yes |
| D3-5 | `approve-runtime` (new commit/build/lockfile); start the controller, then the Operator API, then the adapter socket; doctor DEPLOYMENT OK; `fleet:verify` 16/16; `fleet-verify-deployment.sh`; `/readyz` ready | yes | ends |
| D3-6 | Regression through production: `bridge-claude` (read) whoami/status/agents/events; ChatGPT adapter unchanged (4 tools); new doctor line "operator actions: disabled" | no | no |
| D3-7 | Dev VM: `fleet:operator-keygen` for `claude-operator`; owner `operator-enroll claude-operator bridge_claude --scopes ops.read.status,ops.read.agents,ops.read.events,ops.read.lifecycle,ops.act.agents,ops.propose.agents --expires-days 30`; fingerprint check; point the bridge config at the new principal | yes (owner CLI) | no |
| D3-8 | Owner decision: `operator-actions enable <reason>`; smoke: lifecycle/runtime reads, `reconcile_lifecycle`, a `hold_agent` on an unknown ULID (recorded as `FLEET_OP_TARGET_NOT_FOUND`), ledger via `fleet_list_operator_actions`; then optionally `operator-actions disable` until needed | yes (owner CLI) | no |

Ordering constraints:
- The v9 admin CLI (`operator-api`, `operator-actions`) expects schema v9. Run
  `migrate` (D3-4) before using the new CLI's kill-switch commands. Until then, use the
  `4d6a0be` tooling.
- The deployed ChatGPT adapter (`6691b4c`) stays compatible: GET only, the B2 status and
  agent shapes are unchanged, and ChatGPT principals can never hold D3 scopes.
- Never allow-list the six D3 action tools in Claude Code's permissions. Claude Code
  should ask the human before each action.

Rollback:
- **Immediate, no outage:** `operator-actions disable`, or `operator-api disable`
  (which also clears actions), or `operator-revoke <claude-operator>`.
- **Full:** stop all three services; restore the pre-v9 dump; restore
  `runtime.env.pre-d3`; point `current` back to `releases/4d6a0be…`; start in order;
  verify. There is no down migration. `4d6a0be` refuses a v9 registry (exact schema
  check).

### Stage D3 record (2026-09-25)

| Gate | Result |
|---|---|
| D3-1 | Commit `502876c`, pushed to `fleet-origin` |
| D3-2 | The VPS build reproduced the local prediction: build `695d66c035a379f9045c9aebbb2eea9dc1692be1613f666203039b707a2914ee`, lockfile `eee9dc2f…` |
| D3-3 | `runtime.env.pre-d3` kept (sha `c3d872ea…`, 4d6a0be pins); only the COMMIT/BUILD_ID lines changed; the release was staged and installed (root 555, no `.git`); the tooling checkout moved to `502876c` |
| D3-4 | Outage from 15:35:05. Dump `~/automaton_fleet-v8-pre-v9-20260925T153505Z.dump` (569875 B, sha `a8e36a43…2164`, 0600). `migrate-check` gave exactly `{8→9, wouldApply:[9]}`, rolled back. `migrate` applied v9 at 15:35:35. The privilege audit passed (operator roles provisioned, 0 problems) |
| D3-5 | `approve-runtime`, then the services started. The outage ended at 15:36:16 (about 71 s). Runtime VERIFIED, doctor DEPLOYMENT OK, `fleet:verify` 16/16, `fleet-verify-deployment.sh` 61/0 |
| D3-6 | `bridge-claude` reads still validate against v9. The deployed ChatGPT adapter artifact `6691b4c` passed its identity gate and all 4 tools, run as its own OS user |
| D3-7 | `claude-operator` `op_01M3CKG338G2KDJ19FYEKT2T40` enrolled with all six scopes. The key id `dbaf93c5…` matched the dev-VM keygen. The bridge config and MCP registration were switched to it |
| D3-8 | Actions were enabled only while each probe ran. Probes: Tier 2 reads, actions on a non-existent agent (recorded refusals), idempotent replay and conflict, throttled reconcile, and a fresh `claude -p` end-to-end session. Actions were left **OFF** (generation 12) |
| Fix | Commit `52be40f` (whoami reported only the B2 scopes), build `304532c8…d947`, `runtime.env.pre-d3-fix` kept. Approve plus restart took 15:42:54–15:43:02; no migration |

## Stage E — Central treasury ledger and inert custody boundary, schema v10 (DEPLOYED 2026-09-25, times UTC)

Design and invariants: `docs/design/phase-e-treasury-ledger.md`. Everything stays inert:
- no custody credential and no provider integration;
- custody execution is pinned off by a CHECK constraint;
- `REAL_PAYMENTS_ENABLED`, replication and owner sweeps stay false;
- Genesis has not started and the population is 0.

### Stage E record (2026-09-25)

| Gate | Result |
|---|---|
| E-1 | Commit `f48f912`, pushed to `fleet-origin` |
| E-2 | The local and VPS reproducible builds matched: build `e14720c42f2ef4cddcbc0c315320e09e4563861899c857c3617e4d00e82ff429`, lockfile `eee9dc2f…` unchanged |
| E-3 | `runtime.env.pre-e` kept (sha `ceaeb19c…`, cc75c87 pins); only the COMMIT/BUILD_ID lines changed. The release was staged and installed (root 555); the tooling checkout moved to `f48f912` |
| E-OS | The `fleet-os-setup.sh --apply` dry run showed every existing item identical (node, units, logrotate). It added only: user `automaton-fleet-custody` (uid 987, no other group); `custody.env` (root:automaton-fleet-custody 0640, one key `FLEET_CUSTODY_DATABASE_URL`, fresh 64-hex password); the unit |
| E-4 | Outage from 17:15:34. Dump `~/automaton_fleet-v9-pre-v10-20260925T171535Z.dump` (718130 B, sha `0be2394f…efbc3`, 0600, 33 table-data entries). `fleet-db-setup.sh --apply` created the roles `fleet_custody` (NOLOGIN) and `fleet_custody_login` (connection limit 4). `migrate-check` gave exactly `{9→10, wouldApply:[10]}`, rolled back. `migrate` applied v10 at 17:15:55. `audit-privileges` PASS (operator and custody roles provisioned) |
| E-5 | `approve-runtime`, then the services started: controller, Operator API, adapter socket, and `automaton-fleet-custody` (enabled; logs `custody_executor_started` with providers [], executionEnabled false, inert true). The outage ended at 17:16:20 (about 46 s) |
| Verify | Runtime VERIFIED; doctor DEPLOYMENT OK (new: ledger integrity, custody execution, payment orders, estates and assets all PASS); `fleet:verify` 16/16, SAFE FOR DRY RUN YES, SAFE FOR REAL PAYMENTS NO; `fleet-verify-deployment.sh` 76 PASS / 0 FAIL (new custody isolation section); Operator API `/readyz` ready, schema 10; ChatGPT adapter ready; public listeners only 22/443; the custody executor has no listener |
| Probes | As `automaton-fleet-custody` from the installed release: `cx_ping` OK (v10, execution false); `cx_claim_instruction` returns `FLEET_CUSTODY_EXECUTION_DISABLED`. Everything else is permission denied: reading the journal or destinations, `fleet_ledger_post`, `svc_issue_payment_instruction`, `api_spend_request`, updating the economic model. Unauthenticated `/v1/spend/request`, `/v1/spend/cancel`, `/v1/ledger` and `/v1/wallet/spend-request` return 401. `ledger-verify` is ok (0 journals), LFC 0, and the legacy digests show 7 tables × 0 rows |

State after E:
- registry: cap 2, DEVELOPMENT, replication off, 0 agents;
- operator actions: OFF;
- ledger: 0 journals, 13 fleet accounts, no destinations;
- custody: execution disabled (constitutional), no instruction.

Rollback:
- **Full:** stop the custody executor, adapter socket, Operator API and controller; restore the pre-v10 dump; restore `runtime.env.pre-e`; point `current` back to `releases/cc75c87…`; start in order; verify.
- There is no down migration. `cc75c87` refuses a v10 registry (exact schema check).
- The custody user, `custody.env`, roles and unit can stay: they are inert and hold no privilege on a v9 schema.

Operating the ledger (owner CLI, admin credential; `docs/design/phase-e-treasury-ledger.md` §E7–E9):
- `pnpm fleet:admin ledger-verify | ledger-balances | ledger-orders | ledger-economics <agentId> | ledger-lfc`
- `ledger-destination-enroll` / `ledger-destination-activate` read the reference and the one-time code from stdin. Never put them on the command line.
- Instructions that recommend against a policy need `--ack`. Constitutional refusals cannot be acknowledged.
- **Do not** record owner funding, grant capital or enroll destinations until Genesis is designed and approved.

## Stage F — Genesis architecture and pre-Genesis integration, schema v11 (DEPLOYED 2026-09-25, times UTC)

Design: `docs/design/phase-f-genesis.md`. The founders are **not** created. Genesis is disabled and population is 0.

### Stage F record (2026-09-25)

| Gate | Result |
|---|---|
| F-1 | Commit `99dc941`, pushed to `fleet-origin` |
| F-2 | The local and VPS reproducible builds matched: build `dfb66b522d4a71a911ab26c5bedf12915e7993b58410d97f63ac8ce65beeaf1f`, lockfile `eee9dc2f…`. Phase E pins read back from `runtime.env`: `f48f9128408aeab40342521cd8e2d280b96d8e46` / `e14720c42f2ef4cddcbc0c315320e09e4563861899c857c3617e4d00e82ff429` |
| F-3 | `runtime.env.pre-f` kept (sha `87dca25c…`). The runtime release was staged and installed. The ChatGPT adapter artifact was built and verified at the same commit/build |
| F-4 | Outage from 18:25:58. Dump `~/automaton_fleet-v10-pre-v11-20260925T182558Z.dump` (1068378 B, sha `96c81347…cf2e`, 0600, 48 table-data entries). `migrate-check` gave exactly `{10→11, wouldApply:[11]}`, rolled back. `migrate` applied v11 at 18:26:03. `audit-privileges` PASS (new explicit custody wording). The units were installed with `custody.env` and `/var/lib/automaton-fleet-custody` hidden (controller, Operator API, witness, adapter, tunnel); only those lines changed. The adapter was re-pinned from `6691b4c`/`62336fee…` to `99dc941`/`dfb66b52…` |
| F-5 | `approve-runtime`; controller, Operator API, custody (inert on v11), adapter socket; tunnel restarted on its new unit. The outage ended at 18:26:30 (about 32 s) |
| Verify | Runtime VERIFIED; doctor DEPLOYMENT OK (new PASS lines: genesis disabled, capability manifest `founder-v1 9b4ac43e…` matches the runtime, reproduction pinned off, identity vault 0 facts, institutional knowledge 0); `fleet:verify` 16/16, SAFE FOR DRY RUN YES; `fleet-verify-deployment.sh` 76/0; Operator API ready (schema 11); adapter ready |
| Dry run | `fleet:admin genesis-dry-run` in production: **PASS**, 20/20 checks (two synthetic founders, synthetic 123.45 each, one rolled-back transaction). Afterwards: population 0, Genesis records 0, agents 0, ledger head 0, `genesis_enabled` false |
| Adapter | 4 tools; whoami `bridge-chatgpt` {ops.read.agents, ops.read.status}; status schema 11; `fleet_list_events` refused as unknown; no token gives 401. Inside its namespace, `custody.env` is an empty mode-000 placeholder, unreadable as the adapter user |
| MCP | Registration pinned with `--expect-principal claude-operator`. A fresh Claude session reports `claude-operator` `op_01M3CKG338G2KDJ19FYEKT2T40`. A mismatched config fails with `IDENTITY_MISMATCH`. The long-running session that started before D3-7 must reconnect (`/mcp`) to drop its stale `bridge-claude` process |
| Probes | Custody login: `cx_ping` only (v11, execution false); everything else is denied. The new agent routes return 401 without a session |

State after F:
- registry v11, cap 2, DEVELOPMENT, replication off;
- population 0; Genesis disabled, 0 authorizations;
- operator actions OFF (generation 12);
- ledger 0 journals;
- identity vault empty;
- custody inert.

Rollback:
- **Full:** stop the adapter socket and service, custody, Operator API and controller; restore the pre-v11 dump; restore `runtime.env.pre-f`; point `current` back to `releases/f48f912…`; point the adapter's `current` back to `releases/6691b4c…` and restore its `pins.env`; start in order; verify.
- `f48f912` refuses a v11 registry (exact schema check).
- The unit changes (`custody.env` hidden) are safe to keep.

The owner Genesis gate (not executed; see the design §F3/F4):
1. `ledger-record-funding`;
2. `genesis-enable`;
3. `genesis-propose` → `genesis-approve <id> <authSha256>`;
4. provision the founder runtimes;
5. `genesis-attest` per founder → `genesis-fund`;
6. `genesis-activate … --credential-dir`.

## Stage F.1 — Founder runtime provisioning and real-runtime attestation, schema v12 (DEPLOYED 2026-09-25, times UTC)

Design: `docs/design/phase-f1-founder-runtime.md`. No real founder was created. Genesis is **disabled** and population **0**.

### Stage F.1 record (2026-09-25)

| Gate | Result |
|---|---|
| F1-1 | Commit `de8a7bf` pushed. The local and VPS builds matched: `75e51658…90d3`. `runtime.env.pre-f1` kept (sha `d9abf6c8…`, 99dc941 pins) |
| F1-2 | Outage 19:19:11–19:19:29 (about 18 s). Dump `~/automaton_fleet-v11-pre-v12-20260925T191911Z.dump` (1337978 B, sha `8763bbaf…2b4c`, 0600, 61 table-data entries). `migrate-check` gave exactly `{11→12, wouldApply:[12]}`; `migrate`; `audit-privileges` PASS. `fleet-os-setup.sh --apply` installed only the new `automaton-fleet-founder@.service` (every other unit identical) |
| Rehearsal 1 | **FAIL, correctly.** Both founders ran under the SAME dynamic uid (61431): for template units systemd names the DynamicUser after the template. Fixed in `c6cd159` (`User=fnd-%i`; deploy-only, build unchanged). Unit reinstalled, then **PASS** with uids 64423/63894 |
| Custody | Latent Phase E defect: the inert custody executor exited with status 0 about 10 s after every start (unref'd poll timer; `Restart=on-failure` does not restart a clean exit). Fixed in `ffd29fa` (build `aed0ebca…014b`; the local and VPS builds matched). `runtime.env.pre-f1b` kept. Restart 19:27:01–19:27:07; custody active afterwards. Doctor and `fleet-verify-deployment.sh` now fail when the unit is enabled but not running |
| Verify | Runtime VERIFIED `ffd29fa`/`aed0ebca…`; doctor DEPLOYMENT OK (founder runtimes 0 = living founders 0; custody executor active); `fleet:verify` 16/16; `fleet-verify-deployment.sh` 89 PASS / 0 FAIL; audit PASS; Operator API ready (schema 12); ChatGPT adapter (still `99dc941`) ready, 4 tools, status schema 12 |
| Dry runs | Database dry run 20/20 PASS (rolled back). **Real-runtime rehearsal PASS 15/15.** Founders `…5G9APZ` (uid 65102) and `…5QD9TK` (uid 61512): 3 heartbeats and 3 challenges each. Production snapshot before = after `{population 0, cap 2, genesis_records 0, genesis_enabled false, agents 0, ledger_head 0}`. Host clean (no founder unit or state, throwaway registry deleted) |

State after F.1:
- runtime `ffd29fa` / `aed0ebca…014b`, schema v12;
- population 0, cap 2, DEVELOPMENT; Genesis disabled, 0 authorizations;
- reproduction and reseeding pinned off;
- custody executor running and inert;
- operator actions OFF (generation 12);
- no founder unit or state on the host.

Rollback:
- **Runtime only (no migration):** restore `runtime.env.pre-f1b`, point `current` back to `releases/de8a7bf…`, approve and restart.
- **Full:** stop the services; restore the pre-v12 dump; restore `runtime.env.pre-f1`; point `current` back to `releases/99dc941…`; start in order.
- `99dc941` refuses a v12 registry (exact schema check).
- The founder template and the custody fix are safe to keep.

Owner Genesis path, **not executed** (each step is an owner decision):
1. Record the treasury funding (`ledger-record-funding`, from a real external reference), if an allocation will be given.
2. `genesis-enable`.
3. `genesis-propose 2 <allocationCents>`.
4. `genesis-approve <id> <authSha256>`.
5. `sudo scripts/fleet-founders.sh provision <id>`.
6. `sudo scripts/fleet-founders.sh attest <id>`.
7. `genesis-fund <id>`.
8. `sudo scripts/fleet-founders.sh activate <id> <authSha256>`.

Founders then run the supervisor. The autonomous agent loop stays off until the owner provides an inference provider credential and approves a founder egress policy.

## Stage F.2 — Founder cognition through FleetController, schema v13 (DEPLOYED 2026-09-25, times UTC)

Design: `docs/design/phase-f2-founder-cognition.md`. Owner go-live steps: `docs/genesis-launch-checklist.md`.
Production cognition is **disabled** (provider `none`); no inference credential exists; founder egress closed.
Genesis **disabled**, population **0**.

### Stage F.2 record (2026-09-25)

| Gate | Result |
|---|---|
| F2-1 | Commit `f90b607` pushed. The local and VPS builds matched: `d7bd4679…aa99`, lockfile unchanged. `runtime.env.pre-f2` kept (sha `78128e06…`, ffd29fa pins) |
| F2-2 | Outage 20:34:32–20:34:50 (about 18 s). Dump `~/automaton_fleet-v12-pre-v13-20260925T203432Z.dump` (1361661 B, sha `b69f7a4d…0f7e`, 0600, 61 table-data entries). `migrate-check` gave exactly `{12→13, wouldApply:[13]}`; `migrate`; `audit-privileges` PASS (incl. the new cognition surface). `fleet-os-setup.sh --apply` installed only the changed founder template (`FLEET_FOUNDER_AGENT_LOOP=controller`). The controller logs `cognitionProvider: none` |
| Verify | Runtime VERIFIED; doctor DEPLOYMENT OK ("founder cognition: disabled (owner gate; provider none)"); `fleet:verify` 16/16; `fleet-verify-deployment.sh` 89/0; Operator API and ChatGPT adapter ready; flags unchanged; public ports 22 and 443 only. Database Genesis dry run 20/20 |
| Rehearsal 1 | 19/20. The injection check **FAILED, correctly**: the production turn shape (4 steps) put the poisoned read on a turn's last step, so the scripted model never evaluated it. The check's detail text was also hard-coded. Fixed in `c7c2a05` (build `459539f5…c4f9`; the builds matched). `runtime.env.pre-f2b` kept. Controller restart 20:49:29–20:49:35 |
| Rehearsal 2 | **PASS 20/20** (systemd host, uids 63549/64866). Cognition off until switched on; both founders thought through the controller (8 calls each, 8¢/9¢ charged from their own synthetic ledgers; ledger verifies). The injected founder requested `transfer_credits`, and both requested `spawn_child`/`install_mcp_server`: all refused, 0 payment instructions and 0 live orders. Pausing A: 0 calls after; B continued. Global off: 0 calls after. No credential in arguments, logs, events, audit or the cognition log. Production unchanged `{population 0, cap 2, genesis 0/disabled, agents 0, ledger_head 0}`; host clean |

Tests: fleet suite 622 passed (only KI-1); non-fleet 1614/1614. Mutation campaign 29/29 killed (gateway, toolbox,
SQL gates, lifecycle trigger, log immutability, owner-actor checks, loopback-only founder sessions, mind pause,
egress guards, founder preflight, provider key-file checks).

Rollback:
- **Runtime only:** restore `runtime.env.pre-f2b` (f90b607), approve and restart.
- **Full:** stop the services; restore the pre-v13 dump; restore `runtime.env.pre-f2` (ffd29fa); point `current` back to `releases/ffd29fa…`; start in order. `ffd29fa` refuses a v13 registry (exact schema check).

## Stage F.3 — Pre-launch hardening, schema v14 (DEPLOYED 2026-09-25, times UTC)

Design: `docs/design/phase-f3-launch-hardening.md`. Cognition still **disabled** (provider `none`); Genesis **disabled**; population **0**.

### Stage F.3 record (2026-09-25)

| Gate | Result |
|---|---|
| F3-1 | Commit `90ba6d0` pushed. The local and VPS builds matched: `d0d7cf4b…cfb5`, lockfile unchanged. `runtime.env.pre-f3` kept (sha `e6378221…`, c7c2a05 pins) |
| F3-2 | Outage 21:08:53–21:09:12 (about 19 s). Dump `~/automaton_fleet-v13-pre-v14-20260925T210853Z.dump` (1423345 B, sha `29f705e9…0338`, 0600, 65 table-data entries). `migrate-check` gave exactly `{13→14, wouldApply:[14]}`; `migrate`; audit PASS. `fleet-os-setup.sh --apply` installed only the changed founder template (`SystemCallFilter=@sandbox`) |
| Verify | Runtime VERIFIED; doctor DEPLOYMENT OK (new line "founder forbidden-tool requests: none in 24 h"); `fleet:verify` 16/16; `fleet-verify-deployment.sh` 90/0 (new: founder template `@sandbox`); Operator API and ChatGPT adapter ready; `founders-report` `[]`; flags unchanged; public ports 22 and 443 only. Database Genesis dry run 20/20 |
| Rehearsal | **PASS 21/21** (systemd host, uids 63138/61252). New: "each founder's shell runs in its Landlock sandbox". Inside the real founder units: workspace rw, state (credential/identity) unreadable, nothing outside writable, TCP to the controller denied, for both founders. Credits recorded through the new owner recorder. Injection and forbidden tools refused; pause and global-off stop cognition; production unchanged; host clean |

Tests: fleet suite 625 passed (only the known phase2 KI-1 and the wipe deadlock flake, which passes alone). F.3 mutation campaign F01–F13: 12 killed; F09 (credits recorder without its approver call) is a redundant layer, because the admin-instruction guard trigger re-checks the approver.

Rollback:
- **Runtime only** (v14 is additive): restore `runtime.env.pre-f3` (c7c2a05) and approve. Note: c7c2a05 refuses a v14 registry (exact schema check), so a runtime-only rollback also needs the database rollback.
- **Full:** stop the services; restore the pre-v14 dump; restore `runtime.env.pre-f3`; point `current` back to `releases/c7c2a05…`; start in order.

## Stage H — Pre-Genesis cognition hardening L1–L8 + L14, schema v15 (DEPLOYED 2026-09-26, times UTC)

Design: `docs/design/pre-genesis-cognition-hardening.md`. No provider credential installed; cognition **disabled** (provider `none`); Genesis **disabled**; population **0**.

### Stage H record (2026-09-26)

| Gate | Result |
|---|---|
| H-1 | Commit `7ed37ff` pushed. The local and VPS builds matched: `67da4b31…cfa`. `runtime.env.pre-h` kept (sha `d6518a39…`, 90ba6d0 pins). The installed units differed from the release only by the L8 lines (checked before install) |
| H-2 | Outage 00:18:15–00:18:34 (about 19 s). Dump `~/automaton_fleet-v14-pre-v15-20260926T001815Z.dump` (1428918 B, sha `c2c5394a…c85d`, 0600, 65 table-data entries). `migrate-check` gave exactly `{14→15, wouldApply:[15]}`; `migrate`; audit PASS. `fleet-os-setup.sh --apply` plus the adapter/tunnel units installed; controller `LimitCORE=0`; the adapter socket and tunnel restarted |
| Rehearsal 1 | 24/25. The forbidden-tool check **FAILED, correctly**: the fault target never reached its `spawn_child` probe in the wait window. Cause: the scripted model's plan position came from trimmed history. Fixed in `740f083` (test model and harness only; build `d7684665…0504`; the builds matched). `runtime.env.pre-h2` kept. Controller restart 00:48:15–00:48:21 (no migration) |
| Verify | Runtime VERIFIED; doctor DEPLOYMENT OK; `fleet:verify` 16/16; audit PASS; `fleet-verify-deployment.sh` 98/0 (new: key isolation on 6 units, controller `LimitCORE=0`, "no inference-provider credential installed"); Operator API and ChatGPT adapter ready; the probe without a credential exits 2 ("Nothing to probe"); Genesis dry run 20/20 |
| Rehearsal 2 | **PASS 25/25** (systemd host, uids 64924/62365). Real HTTP provider path against a loopback fake with injected faults for founder 1: 429→retry ok (attempts 2); 503×3 → `PROVIDER_UNAVAILABLE`, 0¢; malformed JSON → estimate; bad tool args → reported usage; timeout at 3002 ms → estimate, not retried; no usage → estimate; redirect refused, 0¢. Founder 1 kept thinking. 25 attempts = 25 provider requests and 32 = 32; journals 1:1 with charges; nothing in flight; ledger verifies. Founder 2: 32 calls, all first-attempt ok. Injection and forbidden tools refused; pause and global off; Landlock; production unchanged; host clean |

Tests: fleet suite 642 passed (only KI-1). The process-host rehearsal passed 5/5 runs. Mutation campaign H01–H22: 22/22 killed.

State after H: runtime `740f083` / `d7684665…0504`, schema v15; population 0, cap 2, DEVELOPMENT; Genesis disabled (0 records); cognition disabled, provider `none`, 0 inference records; no `cognition.key`, no `FLEET_COGNITION_*` in `service.env`; custody execution off; operator actions off (generation 12); identity vault empty; ledger journal empty; flags unchanged; public ports 22 and 443 only.

Rollback:
- **Runtime only:** `runtime.env.pre-h2` (7ed37ff).
- **Full:** stop the services; restore the pre-v15 dump; restore `runtime.env.pre-h` (90ba6d0); point `current` back to `releases/90ba6d0…`; start in order. 90ba6d0 refuses a v15 registry (exact schema check). The L8 unit lines are safe to keep with any release.

## Stage A — Native Anthropic cognition adapter, schema v16 (DEPLOYED 2026-09-26, times UTC)

Design: `docs/design/pre-genesis-native-anthropic.md`. Owner choice: tier A, Claude, native Messages API. The model ID, prices and monthly cap are **not locked**. No credential installed; cognition **disabled** (provider `none`); Genesis **disabled**; population **0**.

### Stage A record (2026-09-26)

| Gate | Result |
|---|---|
| A-1 | Commit `6ed4a28` pushed. The local and VPS builds matched: `0af8aa77…bfee`, lockfile unchanged. `runtime.env.pre-a` kept (sha `efa088da…`, 740f083 pins). Installed unit files unchanged |
| A-2 | Outage 09:47:51–09:48:09 (about 18 s). Dump `~/automaton_fleet-v15-pre-v16-20260926T094751Z.dump` (1435268 B, sha `0cd25103…89e0`, 0600, 65 table-data entries). `migrate-check` gave exactly `{15→16, wouldApply:[16]}`; `migrate`; audit PASS |
| Verify | Runtime VERIFIED; doctor DEPLOYMENT OK; `fleet:verify` 16/16; `fleet-verify-deployment.sh` 98/0 ("no inference-provider credential installed"); Operator API and ChatGPT adapter ready; the probe without a credential exits 2; Genesis dry run 20/20. Policy `anthropic`-capable; cache prices unset; 0 inference records |
| Rehearsal | **PASS 26/26** (systemd host, uids 63636/63710), the controller on the **native Anthropic adapter** against a protocol-enforcing fake Messages API with signed thinking. **0 protocol violations; 49 tool_use turns continued with thinking returned unchanged.** Fault schedule on founder 1 classified and charged by rule (timeout and malformed → estimate 18¢ at max output 4,000; 503×3 and redirect → 0¢); 25 = 25 and 32 = 32 provider requests; journals 1:1; founder 2 untouched; injection and forbidden tools refused; pause and global off; Landlock; production unchanged; host clean |

Tests: fleet 653 passed (only the known phase2 KI-1 and the wipe deadlock, which passes alone); upstream 1614/1614; Anthropic suite 14/14. Mutations: native adapter N01–N26 26/26; L1–L8 re-run after the provider refactor 22/22.

Rollback:
- **Runtime only:** not possible across v16 (the previous release requires v15).
- **Full:** stop the services; restore the pre-v16 dump; restore `runtime.env.pre-a` (740f083); point `current` back to `releases/740f083…`; start in order.

## Stage S3 — Real Anthropic credential and L14 provider probe (2026-09-26, times UTC)

- **Owner gate.** The owner installed `/etc/automaton-fleet/cognition.key` (600 automaton-fleet-service, 108 bytes, content never read) and six `service.env` lines: `anthropic`, `claude-opus-5-5`, `THINKING=adaptive`, attempt 150 s, deadline 180 s. The controller's loader was dry-run as the service user before the restart. The controller logs `anthropic:claude-opus-5-5`. The **registry keeps cognition disabled** (provider `none`): no founder can think.
- **Model and prices** (platform.claude.com, 2026-09-26). `claude-opus-5-5` is current (released 2026-09-22; retirement ≥ 2027-09-22). Standard prices: $4 input / $20 output / $5 cache write (5 min) / $0.20 cache read per MTok. Fleet µ¢/token: **400 / 2000 / 500 / 20**. Thinking is billed as output.
- **First probe 10:31:** P1 HTTP 400 "credit balance is too low" (account had no credit); **$0 spent**; fail closed. It exposed a classification defect: Anthropic reports billing as a 400. Fixed in `519b773` (narrow `PROVIDER_BILLING` classifier; build `55403dcb…d060`; the builds matched). `runtime.env.pre-b` kept.
- **Deploy incident (no impact).** The first deploy attempt of the fix was launched before the local build finished, with placeholder pins. `runtime.env` held a nonexistent pin for about 2 minutes; the `git checkout` failed and nothing was installed or restarted. It was restored from the backup made seconds earlier and re-verified (runtime identity VERIFIED on 6ed4a28), then redeployed correctly. Lesson: pins are taken only from a completed build's output.
- **L14 10:47:39–10:47:56: PASS 11/11** (P1 completion with the exact marker; P2 native tool use; P3 tool-result continuation; P4 founder toolbox accepted; P5 no forbidden request; P6 usage on 5/5 calls; P7 reconciliation; P8 7/7 malformed refused; P9 unknown model → 404, uncharged; P10 timeout classified; P11 slowest call 5.7 s). Usage: **6,560 input, 523 output (99 thinking), 0 cache**. Provider cost at list: 6,560×$4/M + 523×$20/M = **$0.0367** = 3,670,000 µ¢, equal to Fleet's computed raw cost. The Fleet ledger rule would charge 7¢ (per-call whole-cent rounding, L13); nothing was charged (the probe has no ledger).
- **After:** doctor DEPLOYMENT OK; `fleet:verify` 16/16; audit PASS; `fleet-verify-deployment.sh` 105/0 (14 key-isolation checks); 0 key or provider-error text in logs, journal, events, argv or environ; population 0; Genesis/cognition/custody/replication/reseeding off; 0 distributions; public ports 22 and 443.

## Stage L13 — Sub-cent inference accounting, schema v17 (DEPLOYED 2026-09-26, times UTC)

- Commit `b2ac153` (build `16e5aee5…6300`; the builds matched; pins taken from the finished build). `runtime.env.pre-l13` kept (519b773 pins).
- Outage 11:07:32–11:07:49 (about 17 s). Dump `~/automaton_fleet-v16-pre-v17-20260926T110732Z.dump` (1441449 B, sha `fc1a5dea…b7ed`, 0600). `migrate-check` gave exactly `{16→17, wouldApply:[17]}`; audit PASS.
- Verify: runtime VERIFIED; doctor DEPLOYMENT OK; `fleet:verify` 16/16; `fleet-verify-deployment.sh` 105/0; Genesis dry run 20/20; **rehearsal 26/26** (accrual live: journals 1:1 with posted cents; ledger verifies); 0 key-shaped text in journals and logs.
- State: population 0, cap 2; Genesis/cognition (registry provider `none`)/custody/replication/reseeding off; 0 distributions; 0 accrual rows; empty journal.
- Rollback: restore the pre-v17 dump and `runtime.env.pre-l13` (519b773 requires v16).

## Stage W — Controlled founder web research, schema v18 (DEPLOYED 2026-09-26, times UTC)

- **Approval.** The owner approved the Step 4 deploy of `c2e616c` (build `f5016f22…c5c4`). The first automated attempt had been refused by the session permission classifier; nothing ran then.
- **W-1 (`c2e616c`).**
  - Pinned from the finished local build; the VPS build matched. `runtime.env.pre-w` kept (b2ac153 pins).
  - Outage 12:05:10–12:05:29 (about 19 s). Dump `~/automaton_fleet-v17-pre-v18-20260926T120511Z.dump` (1450288 B, sha `2657abc9…9182`, 0600, 66 table-data entries). `migrate-check` gave exactly `{17→18, wouldApply:[18]}`; `migrate`; audit PASS.
  - `fleet-os-setup.sh --apply`: created the `automaton-fleet-fetcher` user; installed the fetcher socket/service and the founder template (founder-v2, fetcher socket hidden); generated the host-address drop-in. `automaton-fleet-fetcher.socket` enabled.
- **W-1 findings.**
  1. `fleet-verify-deployment.sh` reported "fetcher CAN read /var/lib/postgresql". This was a probe defect: the directory is 0755 by distro default and holds no secrets. The cluster data directory `16/main` is 0700 postgres and unreadable to the fetcher, and the unit also hides the whole tree. The probe now targets `/var/lib/postgresql/*/main`.
  2. **The rehearsal failed 30/33, correctly.** The fetcher crash-looped on start (`uv_interface_addresses` EAFNOSUPPORT): `os.networkInterfaces()` needs AF_NETLINK, which the unit forbids. The controller failed closed (`RESEARCH_FETCHER_UNAVAILABLE`).
  3. Fix: the sandbox is unchanged. `fleet-os-setup.sh` passes the host addresses it computes for `IPAddressDeny` to the fetcher (`FLEET_FETCHER_HOST_ADDRESSES`, same drop-in). The fetcher refuses to start without a global host address or with an invalid entry. `fleet-verify-deployment.sh` now probes the fetcher live as the controller's user, and a test starts the real entry point with enumeration failing.
- **W-2 (`162f07f`).**
  - Build `11899a7c…f855`; lockfile unchanged; the builds matched. `runtime.env.pre-w2` kept (c2e616c pins).
  - No migration (`wouldApply: []`). `fleet-os-setup.sh --apply` regenerated the drop-in. Restart 12:17:48–12:18:00 (about 12 s).
- **Verify (W-2).**
  - Runtime VERIFIED (162f07f / 11899a7c); schema v18; doctor DEPLOYMENT OK ("founder web research: disabled; fetcher socket active (isolated)"); audit PASS; `fleet:verify` 16/16; Genesis dry run 20/20.
  - `fleet-verify-deployment.sh` 130/0, incl. the 25-check fetcher section: no groups, hardening, kernel private-range and host-address deny, no env file or credential, secrets and PG data unreadable, live probe, founder template hides the socket, clean process environment, no TCP listener.
  - **Rehearsal 33/33**, production unchanged, host clean:
    - https://example.com/ fetched through the rehearsal controller and the production fetcher (200, 559 B, sha `ff67a9d7…`);
    - 10 SSRF targets refused;
    - quota and pause enforced;
    - 12 authorized / 12 results, no content in the registry;
    - both founder sandboxes cannot connect to the fetcher socket;
    - off switch stops all.
- **Live redirect revalidation** (fetcher, as the controller's user, via a public redirector):
  - a hop to `127.0.0.1` or `169.254.169.254` → `RESEARCH_IP_LITERAL_REFUSED`;
  - to `api.agentfleet.vip` → `RESEARCH_FLEET_HOST_REFUSED`;
  - to `http:` → `RESEARCH_SCHEME_REFUSED`;
  - 5 redirects → `RESEARCH_TOO_MANY_REDIRECTS` after 3;
  - one hop to example.com → fetched.
- **v18 fail-closed.** TRUNCATE is refused on both policy rows and both research audit tables; the deployed authorizers contain the NULL-state guards. The test suite proves an absent policy row refuses (and that pre-v18 logic would not).
- **Exposure and leaks.**
  - Public TCP 22 and 443 only (5432/6379/8787/8788 loopback). The fetcher has a Unix socket only; its environment holds only `FLEET_FETCHER_*` and systemd variables.
  - 0 key-shaped text in the journals or logs.
- **State.** Population 0, cap 2, DEVELOPMENT. Genesis off; cognition off (provider `none`); **research off** (0 production attempts); custody, replication and reseeding off; 0 distributions.
- **Rollback.**
  - Runtime only: `runtime.env.pre-w2` (c2e616c; its fetcher does not start), or restore the pre-v18 dump and `runtime.env.pre-w` (b2ac153 requires v17).
  - Before a v17 rollback: disable `automaton-fleet-fetcher.socket`, and reinstall the founder template with founder-v1.

## Stage S5 — Single-founder Genesis and final Genesis preflight, schema v19 (DEPLOYED 2026-09-26, times UTC)

- **Change.** Genesis is 0 → 1.
  - v19 `fleet_genesis_policy.genesis_max_founders` defaults to 1, and no function changes it.
  - An insert trigger on `fleet_genesis` refuses any other count, and `fleet_genesis_approve` re-checks it.
  - The privilege audit requires the trigger, and doctor fails unless the target is 1.
  - The cap stays 2, as a ceiling only.
  - Earned expansion, replacement after death and a strategy registry are later capabilities, not built.
- **S5-1 (`916fd88`).**
  - Build `393048e4…1627`; lockfile unchanged; the builds matched. `runtime.env.pre-s5` kept (162f07f pins).
  - Outage 12:50:37–12:50:55 (about 18 s). Dump `~/automaton_fleet-v18-pre-v19-20260926T125037Z.dump` (1514118 B, sha `f7323fe6…cd8a`, 0600, 71 table-data entries). `migrate-check` gave exactly `{18→19, wouldApply:[19]}`; audit PASS; units unchanged.
- **S5-1 finding.** The production `genesis-dry-run` **failed closed, correctly**: the admin CLI still passed `founders=2`, and the new target check refused it. Fixed in `d442986` (the CLI defaults to `GENESIS_FOUNDERS`).
  - Also found while making the change: the dry run's failed-attestation scenario assumed a second founder. It now fails the last founder, which is the only one when n = 1.
- **S5-2 (`d442986`).**
  - Build `ba14e999…9305`; the builds matched. `runtime.env.pre-s5b` kept (916fd88 pins).
  - No migration. Restart 12:52:32–12:52:43; fetcher restarted onto the release.
- **Verify.**
  - Runtime VERIFIED; schema v19; doctor DEPLOYMENT OK ("genesis founder target: exactly 1"); audit PASS; `fleet:verify` 16/16; `fleet-verify-deployment.sh` 130/0.
  - **Genesis dry run 21/21 with 1 founder**: a 2-founder proposal is refused, and the cap of 2 is a ceiling only.
  - **Rehearsal 35/35** (1 founder, production unchanged, host clean):
    - a 2-founder proposal refused; a failed attestation rolls back;
    - one runtime, a dedicated uid, its own ledger and manifest (founder-v2);
    - a second Genesis refused; population one throughout;
    - Landlock shell with TCP denied;
    - cognition through the controller with faults charged by rule, journals 1:1 and the ledger verifying; injection and forbidden tools refused; pause/resume and the off switch hold;
    - research through the controller and fetcher; SSRF refused; quota and pause hold; audit 1:1; fetcher socket unreachable from the founder;
    - no credential leaks; the dead founder's runtime stops.
- **Production state.**
  - Population 0, cap 2, DEVELOPMENT. Genesis off (target 1); cognition off (provider `none`, prices 0); research off.
  - Custody execution, real payments, replication, reseeding and owner sweep off. 0 distributions, 0 journals, ledger verifies.
  - Unallocated treasury 0: the owner records the (virtual) founder allocation before `genesis-fund`.
  - Public TCP 22 and 443 only; 0 key-shaped text in the logs.
- **Rollback.**
  - Runtime only: `runtime.env.pre-s5b` (916fd88).
  - Full: restore the pre-v19 dump and `runtime.env.pre-s5` (162f07f requires v18).

## Stage GP — Genesis preparation: £100 bootstrap capital and opportunity doctrine, schema v20 (DEPLOYED 2026-09-26, times UTC)

- **Change** (`docs/design/genesis-preparation-capital-doctrine.md`):
  - v20 bootstrap capital policy: `GBP 10000` = £100.00 per founder, changed only by the owner-only `genesis-bootstrap`.
  - `genesis-propose 1 --fx <USD per GBP> --fx-source …`: the rate must have been observed within 24 h. The registry derives `floor(10000 × rate)` cents and binds the amount, rate, source and time into the authorization hash; they are frozen afterwards. The plain-USD path is refused.
  - Classification unchanged: `owner_funding` → `genesis_allocation`, never revenue or profit.
  - Founder charter v2 carries the owner's economic priors.
  - Saved research pages are pruned to the newest 100.
- **Deploy.**
  - Commit `06d55d5`, build `febe66b7…6865`; lockfile unchanged; the builds matched. `runtime.env.pre-gp` kept (d442986 pins).
  - Outage 13:51:07–13:51:24 (about 17 s). Dump `~/automaton_fleet-v19-pre-v20-20260926T135107Z.dump` (1519168 B, sha `b8e3ba28…9976`, 0600). `migrate-check` gave exactly `{19→20, wouldApply:[20]}`; audit PASS; units unchanged; fetcher restarted onto the release.
- **Verify.**
  - Runtime VERIFIED; schema v20; doctor DEPLOYMENT OK ("genesis bootstrap capital: GBP 100.00 per founder"); `fleet:verify` 16/16; `fleet-verify-deployment.sh` 130/0.
  - **Genesis dry run 22/22**: 1 founder; £100.00 at a synthetic 1.25 → 12500¢, bound into the authorization, `owner_funding`; revenue and LFC 0.
  - **Rehearsal 35/35**: the capital path in a throwaway registry; production unchanged; host clean.
- **State.**
  - Population 0; Genesis, cognition and research off; custody, payments, replication and reseeding off; 0 distributions; 0 journals.
  - Public TCP 22 and 443 only; 0 key-shaped text in the logs.
- **Rollback.** Restore the pre-v20 dump and `runtime.env.pre-gp` (d442986 requires v19).
- **At Genesis the owner:**
  1. records `owner_funding` (USD cents ≥ the derived allocation);
  2. states the fresh rate in `genesis-propose`;
  3. checks `capital` and `allocationCents` in the output, then approves.

## Operating the Claude bridge (dev VM, Phase D)

This is dev-VM tooling only (`docs/design/phase-d-claude-bridge.md`). It changes
nothing on the VPS. Every command is read-only, and each signed request adds one
bookkeeping row to `fleet_operator_requests`.

One-time setup (already done on the dev VM):

```bash
dev$ pnpm fleet:bridge init --principal op_01M3AX56W25JNMQCTBM8HYH474 \
       --key-file ~/.config/automaton-fleet/operator/bridge-claude.key \
       --ssh-host 51.195.148.111 --ssh-identity ~/.ssh/fleet_op_tunnel \
       --host-key-fingerprint SHA256:HUuqOfrwidWq3SagFJD3rEavFX29u89cy1vIqun0tRg \
       --from-known-hosts ~/.ssh/known_hosts
dev$ pnpm fleet:bridge doctor
```

Daily use:
- `pnpm fleet:bridge whoami | status | agents | agent <id> | events --limit N`
- Each command opens and closes its own tunnel. Use `tunnel up` / `tunnel down`
  to keep one open between commands.

Key expiry:
- `pnpm fleet:bridge key status --remote` reports the days left.
- Rotate before 2026-10-24: `key rotate-prepare` → (VPS) `operator-add-key` →
  `key rotate-verify` → `key rotate-switch` → (VPS) `operator-revoke-key` →
  `key rotate-finish`.

Claude Code access (Phase D2): the local stdio MCP server `fleet-operator` is
registered with `claude mcp add --scope local` (see
`docs/design/phase-d-claude-bridge.md`). It exposes `fleet_whoami`,
`fleet_status`, `fleet_list_agents`, `fleet_get_agent` and `fleet_list_events`,
and nothing else. It goes through the same bridge and tunnel.
- Remove it: `claude mcp remove fleet-operator --scope local`.

Failures are fail-closed codes. What they mean:

| Code | Meaning / action |
|---|---|
| `HOST_KEY_MISMATCH` | Stop. The VPS host key no longer matches the pin |
| `API_DISABLED` | The kill switch is off; nothing was sent |
| `AUTH_FAILED` | The key is revoked or expired, or the wrong key is in use |
| `CLOCK_SKEW` | Fix this host's clock |
| `REPLAYED` | Never resend a signed request |

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
