# 10 — systemd units, OS identities and filesystem map (PART 11 + PART 12)

> Master-Key archive, reconstruction grade. Repository state: branch `fleet-development`, HEAD `efad214`.
> Implementation wins over documentation. Each deviation is marked **DRIFT:**. Anything that exists only on the production host and is not in the repository is marked **NOT IN REPOSITORY**. Planned but unbuilt behaviour is marked **NOT IMPLEMENTED**.
> No secret values appear in this file. Secret files are described by path, owner, mode and purpose only.

Sources used: `deploy/systemd/*`, `deploy/systemd/automaton-fleet.service.d/remote.conf.example`, `deploy/etc/*.example`, `deploy/logrotate/automaton-fleet`, `deploy/firewall/fleet-firewall.sh`, `scripts/fleet-os-setup.sh`, `scripts/fleet-db-setup.sh`, `scripts/fleet-deploy-release.sh`, `scripts/fleet-deploy-chatgpt-adapter.sh`, `scripts/fleet-chatgpt-setup.sh`, `scripts/fleet-chatgpt-tunnel-key.sh`, `scripts/fleet-verify-deployment.sh`, `src/fleet/secret-files.ts`, `src/fleet/service/main.ts`, `src/fleet/operator/main.ts`, `src/fleet/chatgpt-adapter/{main,config}.ts`, `src/fleet/operator/keygen.ts`, `src/fleet/bridge/{cli,config,tunnel,hostkey}.ts`, `src/fleet/doctor.ts`, `docs/fleet-production-runbook.md`, `docs/design/phase-{b,c,d}-*.md`, `FLEET.md`.

---

# PART 11 — systemd

## 11.0 Unit inventory

The repository ships nine systemd files. All of them live under `deploy/systemd/`.

| # | Repo file | Type | Installed to (by) | Enabled by a script? | Runs as |
|---|---|---|---|---|---|
| 1 | `automaton-fleet.service` | service | `/etc/systemd/system/automaton-fleet.service`, root 0644 (`scripts/fleet-os-setup.sh:140`) | No. The operator runs `systemctl enable --now` (runbook stage 13) | `automaton-fleet-service` |
| 2 | `automaton-fleet.service.d/remote.conf.example` | drop-in | `/etc/systemd/system/automaton-fleet.service.d/remote.conf`, root 0644, **by hand** (runbook stage 17) | n/a (drop-in) | (modifies #1) |
| 3 | `automaton-agent.service` | service | `/etc/systemd/system/automaton-agent.service`, root 0644 (`fleet-os-setup.sh:141`) | No. Never enabled in production | `automaton-agent` |
| 4 | `automaton-fleet-witness.service` | service | `/etc/systemd/system/automaton-fleet-witness.service`, root 0644 (`fleet-os-setup.sh:142`) | No. Start-only for the dry run, never enable (runbook stage 22) | `automaton-fleet-witness` |
| 5 | `automaton-fleet-operator-api.service` | service | `/etc/systemd/system/automaton-fleet-operator-api.service`, root 0644 (`fleet-os-setup.sh:143`) | No. The operator started it at B2-10 and enabled it at the B2 closeout | `automaton-fleet-operator-api` |
| 6 | `automaton-fleet-chatgpt-adapter.socket` | socket | `/etc/systemd/system/…`, root 0644 (`fleet-chatgpt-setup.sh:101`) | Yes: `configure --apply` runs `systemctl enable --now` (`fleet-chatgpt-setup.sh:129`) | socket owned by adapter user / tunnel group |
| 7 | `automaton-fleet-chatgpt-adapter.service` | service | `/etc/systemd/system/…`, root 0644 (`fleet-chatgpt-setup.sh:102`) | Yes: `enable --now` (`fleet-chatgpt-setup.sh:130`) | `automaton-fleet-chatgpt-adapter` |
| 8 | `automaton-fleet-chatgpt-tunnel.service` | service | `/etc/systemd/system/…`, root 0644 (`fleet-chatgpt-setup.sh:103`) | `enable` **without** `--now` (`fleet-chatgpt-setup.sh:131`) | `automaton-fleet-chatgpt-tunnel` |
| 9 | `automaton-fleet-chatgpt-tunnel.path` | path | `/etc/systemd/system/…`, root 0644 (`fleet-chatgpt-setup.sh:104`) | Yes: `enable --now` (`fleet-chatgpt-setup.sh:132`) | (triggers #8) |

`fleet-os-setup.sh` and `fleet-chatgpt-setup.sh` both finish with `systemctl daemon-reload` (`fleet-os-setup.sh:144`, `fleet-chatgpt-setup.sh:106`). Every `install` into `/etc/systemd/system` uses `install -m 0644 -o root -g root`.

**Units that run on the production host but are NOT IN REPOSITORY** (recorded in `docs/fleet-production-runbook.md:102`). Their exact text is not archived in the repo:

| Host unit / file | Purpose (as recorded) |
|---|---|
| `certbot.service` + an `ExecStopPost=` drop-in | Ubuntu certbot package unit. The drop-in closes port 80 whenever certbot stops |
| `certbot.timer` | Ubuntu certbot package renewal timer |
| a 15-minute fail-safe timer (unit name not recorded) | Armed before port 80 is opened; closes it if nothing else did |
| `fleet-certbot-port80-boot.service` (enabled) | Closes port 80 at boot |
| `ssh.service` (reloaded, never restarted, after sshd config changes) | OpenSSH |
| `postgresql.service`, `redis-server.service` | Ubuntu packages |
| `systemd-timesyncd.service` | Provides `/run/systemd/timesync/synchronized` (Operator API readiness) |

<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->
(Needed from production: the exact text of the certbot drop-in, the fail-safe timer, `fleet-certbot-port80-boot.service` and `/usr/local/sbin/fleet-certbot-port80`, with SHA-256 of each.)

---

## 11.1 `automaton-fleet.service` (FleetController)

Exact repository text (`deploy/systemd/automaton-fleet.service`, 93 lines):

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

### Directive analysis

| Directive | Value | Effect and reason |
|---|---|---|
| `Wants=` / `After=` | `network-online.target postgresql.service` (`:17-18`) | Start after the network and PostgreSQL. `Wants`, not `Requires`: a PostgreSQL restart does not stop the controller. The code then fails readiness (`/readyz` checks the DB) |
| `StartLimitIntervalSec=300`, `StartLimitBurst=5` | `:20-21` | At most 5 starts in 300 s. After that the unit stays `failed` until an operator runs `systemctl reset-failed` (the runbook's certbot deploy hook does exactly this, runbook `:1328`) |
| `Type=exec` | `:24` | "Started" once `execve` of node succeeded. Readiness is reported by `/readyz`, not by systemd |
| `User=` / `Group=` | `automaton-fleet-service` (`:25-26`) | Dedicated system user. The code also refuses uid 0 and any user other than `FLEET_SERVICE_EXPECTED_USER` (`src/fleet/service/main.ts:173-178`) |
| `SupplementaryGroups=` | **not set** | The unit does not clear supplementary groups (units 4, 5, 7 and 8 do). The user is created with `--user-group` only (`fleet-os-setup.sh:70`), so it has no other group unless someone adds one. It must never be in `automaton-fleet-admin` (runbook `:363`) |
| `WorkingDirectory=` | `/opt/automaton-fleet/current` (`:27`) | Symlink to `releases/<commit>`. It is resolved when the process starts, so switching `current` affects only the next start |
| `ExecStart=` | `/opt/automaton-fleet/node/bin/node dist/fleet/service/main.js` (`:28`) | Pinned root-owned Node copy plus the compiled entry point. `main.ts:331` runs only when `argv[1]` matches `fleet/service/main.(ts|js)` |
| `LoadCredential=` | `service.env:/etc/automaton-fleet/service.env` (`:29`) | systemd (as root) copies the root:root 0600 file to `/run/credentials/automaton-fleet.service/service.env` and sets `CREDENTIALS_DIRECTORY`. The service reads it through `loadServiceEnv` (`secret-files.ts:327-354`) under `systemdCredentialProblems` (`secret-files.ts:205-262`) |
| `Environment=NODE_ENV` | `production` (`:34`) | — |
| `Environment=FLEET_SERVICE_EXPECTED_USER` | `automaton-fleet-service` (`:36`) | Enforced at `main.ts:173-178` |
| `Environment=FLEET_RUNTIME_ENV_FILE` | `/etc/automaton-fleet/runtime.env` (`:37`) | Non-secret release pins and flags, read with `readEnvFile` (no permission check, `secret-files.ts:92-95`) |
| `Environment=FLEET_AUDIT_LOG` | `/var/log/automaton-fleet/audit.jsonl` (`:38`) | JSONL audit sink. The file is created with mode 0600 and appended per record (`src/fleet/service/log.ts:40-47`) |
| `Environment=FLEET_API_LISTEN` | `127.0.0.1:8787` (`:39`) | Loopback listener. `parseListen` (`main.ts:74-87`) refuses non-loopback unless remote mode and TLS are configured |
| `Environment=FLEET_SHUTDOWN_DRAIN_MS` | `10000` (`:40`) | Drain window on SIGTERM (`server.ts` `close()`, default 10 000) |
| `Restart=on-failure`, `RestartSec=5s` | `:42-43` | Restart after a non-zero exit, signal or timeout, 5 s apart |
| `KillSignal=SIGTERM`, `KillMode=mixed`, `TimeoutStopSec=30s` | `:45-47` | SIGTERM goes to the main process only; after 30 s everything left in the cgroup gets SIGKILL. The code exits 0 after draining, and a second signal forces exit 1 (`main.ts:305-323`) |
| `TimeoutStartSec=60s` | `:48` | With `Type=exec` this only covers the exec step |
| `StandardOutput/Error=journal`, `SyslogIdentifier=automaton-fleet` | `:51-53` | JSON log lines go to journald |
| `LogsDirectory=automaton-fleet`, `LogsDirectoryMode=0700` | `:54-55` | systemd creates `/var/log/automaton-fleet` owned by the unit user, mode 0700 |
| `StateDirectory=automaton-fleet`, `StateDirectoryMode=0700` | `:56-57` | systemd creates `/var/lib/automaton-fleet`, owner = unit user, mode 0700. This is also the user's home (`fleet-os-setup.sh:70`) |
| `UMask=0077` | `:58` | New files are private |
| `IPAddressDeny=any`, `IPAddressAllow=localhost` | `:61-62` | eBPF socket filter: only 127.0.0.0/8 and ::1 in either direction. **The remote drop-in replaces this** (§11.2) |
| `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX` | `:63` | No netlink, packet or other families |
| `NoNewPrivileges=yes` … `RemoveIPC=yes` | `:66-83` | See the protection matrix in §11.10 |
| `CapabilityBoundingSet=` (empty), `AmbientCapabilities=` (empty) | `:84-85` | No capabilities at all. **The remote drop-in grants `CAP_NET_BIND_SERVICE`** |
| `SystemCallArchitectures=native`, `SystemCallFilter=@system-service`, `SystemCallFilter=~@privileged @resources` | `:86-88` | seccomp allow-list, then deny the privileged and resource-control groups |
| `InaccessiblePaths=` | `-/home/automaton-agent -/etc/automaton-fleet/admin.env` (`:90`) | The leading `-` makes a missing path non-fatal. The admin credential and the agent's home are hidden from the service's mount namespace |
| `WantedBy=multi-user.target` | `:93` | Boot start once enabled |

---

## 11.2 Remote HTTPS drop-in (`automaton-fleet.service.d/remote.conf`)

Exact repository text (`deploy/systemd/automaton-fleet.service.d/remote.conf.example`, 26 lines):

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

| Directive | Effect on the merged unit |
|---|---|
| `LoadCredential=tls.key:/etc/automaton-fleet/tls/fleet.key` | Adds a second secret credential. The code accepts it only as `$CREDENTIALS_DIRECTORY/tls.key` while `FLEET_TLS_KEY_FILE` is unset (`main.ts:96-118`, `secret-files.ts:58-61`) |
| `LoadCredential=tls.crt:/etc/automaton-fleet/tls/fleet.crt` | Public certificate. `runtime.env` must set `FLEET_TLS_CERT_FILE=/run/credentials/automaton-fleet.service/tls.crt` (`fleet-verify-deployment.sh:148-151`) |
| `IPAddressDeny=` (empty) | **Resets** the base unit's `IPAddressDeny=any` list to empty |
| `IPAddressAllow=any` | Allows every address. With the reset above, the controller has **no IP filter at all, inbound or outbound**. Inbound is then narrowed only by the host firewall (ufw) and the OVH edge firewall. Outbound is unrestricted (`ufw default allow outgoing`, `fleet-firewall.sh:20`) |
| `CapabilityBoundingSet=CAP_NET_BIND_SERVICE`, `AmbientCapabilities=CAP_NET_BIND_SERVICE` | Only the capability needed to bind 443 as a non-root user |

The drop-in does not change `User=`, `RestrictAddressFamilies=`, the `SystemCallFilter=` lines or any other directive.

`scripts/fleet-verify-deployment.sh:135-142` checks that the installed drop-in's `LoadCredential` lines, whitespace stripped and sorted, are exactly the two above.

Recorded production state: "The `remote.conf` drop-in is byte-identical to the `11c0c7c` example" (runbook `:105`). The example has not changed since `11c0c7c` (`git log -- deploy/systemd/automaton-fleet.service.d/remote.conf.example`).
<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->
(Needed: SHA-256 of `/etc/systemd/system/automaton-fleet.service.d/remote.conf` and of the repo example, compared.)

---

## 11.3 `automaton-agent.service` (local agent runtime isolation boundary)

Exact repository text (`deploy/systemd/automaton-agent.service`, 48 lines):

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

| Directive | Effect |
|---|---|
| `Wants=`/`After=automaton-fleet.service` | Pulls in and orders after the controller |
| `User=automaton-agent`, `Group=automaton-agent` | Regular (non-system) user with a real home, `/home/automaton-agent` (0700) |
| `ExecStart=… /opt/automaton-fleet/current/dist/index.js --run` | The upstream automaton runtime from the pinned release. `--run` refuses to start if a privileged variable is present (unit comment `:8-9`) |
| `Environment=FLEET_API_URL=http://127.0.0.1:8787` | Plain HTTP to the loopback controller |
| `Environment=REAL_*_ENABLED=false`, `OWNER_SWEEP_ENABLED=false` | Hard-coded off in the unit |
| `ProtectSystem=strict` + `ReadWritePaths=/home/automaton-agent` | Only its home is writable |
| `ProtectHome=tmpfs` + `BindPaths=/home/automaton-agent` | Every other home is replaced by an empty tmpfs; its own home is bind-mounted back |
| `InaccessiblePaths=/etc/automaton-fleet -/var/log/automaton-fleet -/var/lib/automaton-fleet` | The **entire** secret directory is hidden, without a `-` prefix, so the unit fails if `/etc/automaton-fleet` is missing. The controller's logs and state are hidden too |
| `ProtectProc=invisible` | Hides other users' processes (so `/proc/<service pid>/environ` is unreachable) |
| `CapabilityBoundingSet=` (empty) | No capabilities |
| Not set | `IPAddressDeny`, `RestrictAddressFamilies`, `SystemCallFilter`, `ProtectKernelLogs`, `ProtectClock`, `ProtectHostname`, `LockPersonality`, `RestrictNamespaces`, `MemoryDenyWriteExecute`, `SupplementaryGroups=`. The agent needs outbound internet (inference and the Conway API), so there is no IP allow-list |

Production state: installed, **disabled, inactive** (runbook `:87`).
<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->

---

## 11.4 `automaton-fleet-witness.service` (FLEET-KI-4 root witness)

Exact repository text (`deploy/systemd/automaton-fleet-witness.service`, 85 lines):

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

| Directive | Effect |
|---|---|
| `SupplementaryGroups=` (empty) | Explicitly no supplementary groups |
| `ExecStart=… dist/fleet/dry-run/root-main.js` | Heartbeat and challenge loop only |
| `Environment=FLEET_CREDENTIALS_FILE=/var/lib/automaton-fleet-witness/fleet-credentials.json` | Its own agent credential (0600) inside its 0700 `StateDirectory` |
| `Environment=FLEET_WITNESS_INTERVAL_MS=30000` | Heartbeat period, 30 s |
| `RestartPreventExitStatus=3 4` | Exit 3 means the controller no longer accepts this witness; exit 4 is a startup refusal. Neither is restarted |
| `IPAddressDeny=any` / `IPAddressAllow=localhost` | Loopback only (controller on `127.0.0.1:8787`) |
| `InaccessiblePaths=` | `admin.env`, `service.env`, `tls/`, `legacy-env-fleet.bak`, `/home/automaton-agent`, `/var/lib/automaton-fleet`, `/var/log/automaton-fleet`, `/run/credentials` |

Production state: the OS user and the unit are installed; the unit is **disabled and inactive**; no witness is enrolled and no credential file exists (runbook `:125`, `:133`).
<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->

---

## 11.5 `automaton-fleet-operator-api.service` (Operator API, schema v8)

Exact repository text (`deploy/systemd/automaton-fleet-operator-api.service`, 86 lines):

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

| Directive | Effect |
|---|---|
| `Wants=postgresql.service`; `After=postgresql.service network-online.target automaton-fleet.service` | Ordered after the controller, but no dependency on it |
| `SupplementaryGroups=` (empty) | No other groups. `fleet-verify-deployment.sh:46-48` requires `id -nG` to be exactly `automaton-fleet-operator-api` |
| `WorkingDirectory=/opt/automaton-fleet/current` | **The same pinned release as the controller.** It refuses to start if its pins differ from the registry approval (`operator/main.ts:141-150`) |
| `ExecStart=… dist/fleet/operator/main.js` | — |
| No `LoadCredential=` | Deliberate. The unit comment (`:10-12`) and `secret-files.ts:41-48` say the systemd-credential 0440 exception stays limited to `automaton-fleet.service` |
| `Environment=FLEET_OPERATOR_ENV_FILE=/etc/automaton-fleet/operator.env` | Read directly under `operatorEnvFileProblems` (`secret-files.ts:381-396`): root-owned, group = the process's own primary gid, 0640 or stricter, one link, no symlink in the path |
| `Environment=FLEET_OPERATOR_LISTEN=127.0.0.1:8788` | `parseOperatorListen` accepts only `127.0.0.1`, `[::1]` or `localhost` (`operator/main.ts:42-49`) |
| `Environment=FLEET_OPERATOR_AUDIT_LOG=/var/log/automaton-fleet-operator/audit.jsonl` | Audit JSONL, 0600, inside the 0700 `LogsDirectory` |
| `Environment=FLEET_OPERATOR_REQUIRE_TIMESYNC=true` | Readiness also needs `/run/systemd/timesync/synchronized`, unless `FLEET_OPERATOR_TIMESYNC_MARKER` names another marker (`operator/main.ts:38`, `:159-171`) |
| `LogsDirectory=automaton-fleet-operator` 0700 | `/var/log/automaton-fleet-operator` |
| No `StateDirectory=` | The user's home `/var/lib/automaton-fleet-operator-api` (`fleet-os-setup.sh:77`) is created by nothing. It is `--no-create-home` and has no StateDirectory |
| `IPAddressDeny=any` / `IPAddressAllow=localhost` | Loopback only |
| `InaccessiblePaths=` | `admin.env`, `service.env`, `tls/`, `legacy-env-fleet.bak`, `/home`, `/var/lib/automaton-fleet`, `/var/lib/automaton-fleet-witness`, `/var/log/automaton-fleet`, `/run/credentials` |

Observation (not drift): the Operator API unit's `InaccessiblePaths=` does not list `/etc/automaton-fleet/chatgpt-tunnel`, `/etc/automaton-fleet/chatgpt-adapter.json`, `/var/lib/automaton-fleet-chatgpt-*` or `/var/log/automaton-fleet-chatgpt-adapter` (the unit predates Phase C). File modes still deny them: `chatgpt-tunnel/` is root:root 0700; `chatgpt-adapter.json` is root:automaton-fleet-chatgpt-adapter 0640; the StateDirectory and LogsDirectory are 0700 and owned by other users.

Production state: started at B2-10 (2026-09-24 23:40:04 UTC, PID 42287) and enabled for boot at the B2 closeout (runbook `:1190`, `:1193`, `:1200`).
<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->

---

## 11.6 `automaton-fleet-chatgpt-adapter.socket`

Exact repository text (`deploy/systemd/automaton-fleet-chatgpt-adapter.socket`, 22 lines):

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

| Directive | Effect |
|---|---|
| `ListenStream=/run/automaton-fleet-chatgpt/adapter.sock` | Unix stream socket, **not TCP** |
| `SocketUser=automaton-fleet-chatgpt-adapter`, `SocketGroup=automaton-fleet-chatgpt-tunnel`, `SocketMode=0660` | Only the adapter user (owner) and members of the tunnel group can `connect()`. The tunnel user's primary group is `automaton-fleet-chatgpt-tunnel` (`fleet-chatgpt-setup.sh:55`, `--user-group`) |
| `DirectoryMode=0755` | Mode of the created parent `/run/automaton-fleet-chatgpt` (root-owned) |
| `RemoveOnStop=yes` | The socket node is removed when the socket unit stops |
| `Accept=no` | One service instance receives the listening fd. The adapter checks `LISTEN_FDS === "1"` and `LISTEN_PID === process.pid`, then listens on fd 3 (`chatgpt-adapter/main.ts:162-167`) |
| `WantedBy=sockets.target` | Created at boot |

`fleet-verify-deployment.sh:101-107` checks the socket is `automaton-fleet-chatgpt-adapter:automaton-fleet-chatgpt-tunnel 660`, and that none of `automaton-agent`, `automaton-fleet-service`, `automaton-fleet-witness`, `automaton-fleet-operator-api` or the operator (`$SUDO_USER`) can write to it.

---

## 11.7 `automaton-fleet-chatgpt-adapter.service`

Exact repository text (`deploy/systemd/automaton-fleet-chatgpt-adapter.service`, 79 lines):

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

| Directive | Effect |
|---|---|
| `Requires=automaton-fleet-chatgpt-adapter.socket` | The service cannot run without its socket |
| `After=… automaton-fleet-operator-api.service` | Ordering only. There is no `Wants=` on the Operator API: the adapter re-proves the 8788 listener's owner uid on every call (`chatgpt-adapter/main.ts:20`, `:116-128`) |
| `WorkingDirectory=/opt/automaton-fleet/chatgpt-adapter/current` | **Separate pinned artifact** (commit `6691b4c`, build `62336fee…`), not `/opt/automaton-fleet/current` |
| `Environment=FLEET_CHATGPT_ADAPTER_EXPECTED_USER` | `automaton-fleet-chatgpt-adapter` |
| `Environment=FLEET_CHATGPT_ADAPTER_CONFIG` | `/etc/automaton-fleet/chatgpt-adapter.json`, validated with `operatorEnvFileProblems` (`chatgpt-adapter/config.ts:73-80`) |
| `Environment=FLEET_CHATGPT_ADAPTER_AUDIT_LOG` | `/var/log/automaton-fleet-chatgpt-adapter/audit.jsonl`, appended with mode 0600 (`chatgpt-adapter/main.ts:121-125`) |
| `StateDirectory=` 0700 | `/var/lib/automaton-fleet-chatgpt-adapter`, which holds `bridge-chatgpt.key` (0600) |
| `IPAddressDeny=any` / `IPAddressAllow=localhost`; `RestrictAddressFamilies=AF_INET AF_UNIX` | Loopback IPv4 plus Unix only. There is no `AF_INET6`, so the adapter can reach the Operator API only at `127.0.0.1:8788` |
| `InaccessiblePaths=` (two lines) | All controller, operator and TLS secrets, the tunnel's secret directory, every home, other services' state and logs, and `/run/credentials` |

**NOT IMPLEMENTED:** `deploy/logrotate/automaton-fleet` does not rotate `/var/log/automaton-fleet-chatgpt-adapter/audit.jsonl`. That file has no bounded retention.

---

## 11.8 `automaton-fleet-chatgpt-tunnel.service`

Exact repository text (`deploy/systemd/automaton-fleet-chatgpt-tunnel.service`, 90 lines):

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

| Directive | Effect |
|---|---|
| `Wants=`/`After=network-online.target` | Needs outbound internet |
| `ConditionPathExists=` ×2 | `openai-api-key` **and** `tunnel.env` must both exist, or the start is skipped as "condition failed" (not a failure) |
| `EnvironmentFile=/etc/automaton-fleet/chatgpt-tunnel/tunnel.env` | **Non-secret**, `CONTROL_PLANE_TUNNEL_ID=tunnel_<32 hex>`. This is the only `EnvironmentFile=` in the whole repository, and it is not a secret |
| `LoadCredential=openai-api-key:…`, `LoadCredential=adapter-token:…` | Both secrets reach the process only as `%d/<name>`, i.e. `/run/credentials/automaton-fleet-chatgpt-tunnel.service/<name>` |
| `ExecStart=/opt/automaton-fleet/tunnel-client/v0.0.14/tunnel-client-runtime run …` | `--control-plane.api-key=file:%d/openai-api-key`; `--mcp.server-url=url=http://localhost/mcp,unix-socket=/run/automaton-fleet-chatgpt/adapter.sock`; `--mcp.extra-headers=X-Fleet-Adapter-Token: file:%d/adapter-token`; `--health.unix-socket=/run/automaton-fleet-chatgpt-tunnel/health.sock`; `--log.format=json --log.level=info` |
| `RuntimeDirectory=automaton-fleet-chatgpt-tunnel` 0700 | `/run/automaton-fleet-chatgpt-tunnel` (health socket) |
| `StateDirectory=automaton-fleet-chatgpt-tunnel` 0700, `HOME=` there | tunnel-client's own state |
| `IPAddressDeny=localhost link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7` | No loopback, link-local, multicast, RFC 1918, CGNAT or ULA destinations |
| `IPAddressAllow=127.0.0.53/32 127.0.0.54/32` | Except the systemd-resolved stub listeners (DNS) |
| `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK` | `AF_NETLINK` for Go runtime interface discovery; `AF_UNIX` for the adapter and health sockets |
| `MemoryDenyWriteExecute=yes` | Only in this unit. Safe for a static Go binary; the Node units cannot use it (JIT) |
| `InaccessiblePaths=` | All fleet secrets, `chatgpt-adapter.json`, every home, other services' state and logs, `/opt/automaton-fleet/releases`, `/opt/automaton-fleet/chatgpt-adapter` |
| `SupplementaryGroups=` (empty) | Socket access comes from the **primary** group `automaton-fleet-chatgpt-tunnel` |

Recorded state: enabled, **inactive**, waiting for the owner's OpenAI runtime key (runbook `:1221`). The tunnel id `tunnel_6ab5cd2c7b088191abe137e56b5f35e4` is in `tunnel.env` (`docs/design/phase-c-chatgpt-adapter.md:202-203`).
<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->

---

## 11.9 `automaton-fleet-chatgpt-tunnel.path`

Exact repository text (`deploy/systemd/automaton-fleet-chatgpt-tunnel.path`, 12 lines):

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

`PathExists=` activates `automaton-fleet-chatgpt-tunnel.service` once `/etc/automaton-fleet/chatgpt-tunnel/openai-api-key` exists. Added in `d22f517` (after the `6691b4c` adapter artifact). The runbook's Phase C record (`ac343c7`) predates it.

**DRIFT:** `docs/fleet-production-runbook.md:1226-1230` ("Owner actions") says to run `systemctl start automaton-fleet-chatgpt-tunnel` by hand. Current code: the owner runs `sudo fleet-chatgpt-tunnel-key` (`scripts/fleet-chatgpt-tunnel-key.sh`), which stores the key and restarts the unit itself, and the `.path` unit starts it automatically. `docs/design/phase-c-chatgpt-adapter.md:216-226` describes the current flow, but says the helper prints `Result: connected`. The script actually prints `Result: accepted — OpenAI authenticated the key for this tunnel; the tunnel is connected.` (`fleet-chatgpt-tunnel-key.sh:149`).

---

## 11.10 Cross-cutting analysis

### 11.10.1 User, Group, SupplementaryGroups

| Unit | `User=` | `Group=` | `SupplementaryGroups=` | In-code identity check |
|---|---|---|---|---|
| automaton-fleet | automaton-fleet-service | automaton-fleet-service | not set | `FLEET_SERVICE_EXPECTED_USER`, refuses uid 0 (`service/main.ts:173-178`) |
| automaton-agent | automaton-agent | automaton-agent | not set | `automaton --run` refuses privileged environment variables |
| witness | automaton-fleet-witness | automaton-fleet-witness | empty | exit 4 on startup refusal |
| operator-api | automaton-fleet-operator-api | automaton-fleet-operator-api | empty | `FLEET_OPERATOR_EXPECTED_USER`, refuses root (`operator/main.ts:6-7`) |
| chatgpt-adapter | automaton-fleet-chatgpt-adapter | automaton-fleet-chatgpt-adapter | empty | `FLEET_CHATGPT_ADAPTER_EXPECTED_USER` |
| chatgpt-tunnel | automaton-fleet-chatgpt-tunnel | automaton-fleet-chatgpt-tunnel | empty | none (third-party binary) |

### 11.10.2 ExecStart and WorkingDirectory

| Unit | Interpreter / binary | Entry | WorkingDirectory | Code tree |
|---|---|---|---|---|
| automaton-fleet | `/opt/automaton-fleet/node/bin/node` | `dist/fleet/service/main.js` | `/opt/automaton-fleet/current` | runtime release (`4d6a0be`) |
| automaton-agent | same Node | `/opt/automaton-fleet/current/dist/index.js --run` | `/home/automaton-agent` | runtime release |
| witness | same Node | `dist/fleet/dry-run/root-main.js` | `/opt/automaton-fleet/current` | runtime release |
| operator-api | same Node | `dist/fleet/operator/main.js` | `/opt/automaton-fleet/current` | runtime release |
| chatgpt-adapter | same Node | `dist/fleet/chatgpt-adapter/main.js` | `/opt/automaton-fleet/chatgpt-adapter/current` | adapter artifact (`6691b4c`) |
| chatgpt-tunnel | `/opt/automaton-fleet/tunnel-client/v0.0.14/tunnel-client-runtime` | `run …` | not set (`/` by default) | OpenAI tunnel-client v0.0.14 (sha256 pinned in `fleet-chatgpt-setup.sh:39-40`) |

### 11.10.3 LoadCredential and environment handling

| Unit | Secrets delivered via | Non-secret configuration |
|---|---|---|
| automaton-fleet | `LoadCredential=service.env` (+ `tls.key`, `tls.crt` with the drop-in) | `Environment=` lines + `runtime.env` read by the code |
| operator-api | **No LoadCredential.** The process reads `operator.env` (0640, its own group) | `Environment=` + `runtime.env` |
| witness | Its own credential file in `StateDirectory` (0600) | `Environment=` + `runtime.env` |
| chatgpt-adapter | Its own key file in `StateDirectory` (0600) | `Environment=` + `chatgpt-adapter.json` (0640) |
| chatgpt-tunnel | `LoadCredential=openai-api-key`, `LoadCredential=adapter-token` | `EnvironmentFile=tunnel.env` (tunnel id, non-secret) |
| automaton-agent | none. Its own token file in its home | `Environment=` |

Rules enforced by code:
- **No secret is ever passed through `Environment=` or `EnvironmentFile=`.** The comment in `automaton-fleet.service:8-11` gives the reason: they would appear in `/proc/<pid>/environ` and `systemctl show`. `fleet-verify-deployment.sh:167-171` checks the controller's `/proc/<pid>/environ` for `FLEET_ADMIN_DATABASE_URL`, `FLEET_SERVICE_DATABASE_URL`, `FLEET_AGENT_DATABASE_URL` and `DATABASE_URL`.
- **The 0440 systemd-credential exception** applies only when *all* of these hold (`secret-files.ts:193-262`):
  - the credential name is `service.env` or `tls.key` (`SYSTEMD_SECRET_CREDENTIALS`, `:58-61`);
  - the process's cgroup leaf is exactly `automaton-fleet.service` (`currentSystemdUnit`, `:169-181`, regex `^[A-Za-z0-9:_.@\\-]+\.service$`);
  - `CREDENTIALS_DIRECTORY` is exactly `/run/credentials/automaton-fleet.service`, normalized, with no symlink;
  - that directory is owned by root or the process's own uid and is not group/world-writable;
  - the file is exactly `<dir>/<name>`, a regular file with one link, owned by root or self, with no world bits and no group write or execute;
  - the source (`/etc/automaton-fleet/service.env` or `tls/fleet.key`) is root-owned with no group or world bits, or is hidden from the process (EACCES).
- An explicitly configured `FLEET_SERVICE_ENV_FILE` or `FLEET_TLS_KEY_FILE` always gets the strict `secretFileProblems` check (`:111-127`): no symlink, regular file, no world bits, and no group bits unless `allowGroupRead` is set.
- The Operator API refuses to start if any of `OPERATOR_FORBIDDEN_ENV` is in its environment (`secret-files.ts:357-372`): `FLEET_ADMIN_DATABASE_URL`, `FLEET_SERVICE_DATABASE_URL`, `FLEET_AGENT_DATABASE_URL`, `FLEET_CONTROLLER_DATABASE_URL`, `DATABASE_URL`, `PGPASSWORD`, `REDIS_URL`, `CONWAY_API_KEY`, `WALLET_PRIVATE_KEY`, `PRIVATE_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `FLEET_CREDENTIALS_FILE` and `CREDENTIALS_DIRECTORY`. It also refuses if it can read `admin.env`, `service.env` or the TLS key.

Environment precedence (`secret-files.ts`):
- Service (`loadServiceEnv`, `:327-354`): `.env.fleet` (cwd, legacy) < `runtime.env` < service secret < process environment.
- Admin CLI (`loadAdminEnv`, `:307-319`): `.env.fleet` < `runtime.env` < `admin.env` (group-read allowed) < process environment.
- Operator (`loadOperatorEnv`, `:403-419`): `runtime.env` < `operator.env` < process environment. It never reads `.env.fleet`.
- Parsing (`parseEnv`, `:82-89`): the regex `^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$`; comment lines are skipped; one level of matching surrounding quotes is stripped.

### 11.10.4 Filesystem protection matrix

`Y` = set. `—` = not set.

| Directive | fleet | agent | witness | operator-api | adapter | tunnel |
|---|---|---|---|---|---|---|
| NoNewPrivileges | Y | Y | Y | Y | Y | Y |
| ProtectSystem | strict | strict | strict | strict | strict | strict |
| ProtectHome | yes | tmpfs (+BindPaths own home) | yes | yes | yes | yes |
| PrivateTmp | Y | Y | Y | Y | Y | Y |
| PrivateDevices | Y | Y | Y | Y | Y | Y |
| ProtectKernelTunables / Modules | Y | Y | Y | Y | Y | Y |
| ProtectKernelLogs | Y | — | Y | Y | Y | Y |
| ProtectControlGroups | Y | Y | Y | Y | Y | Y |
| ProtectClock / ProtectHostname | Y | — | Y | Y | Y | Y |
| ProtectProc=invisible | Y | Y | Y | Y | Y | Y |
| ProcSubset=pid | Y | — | Y | Y | Y | Y |
| RestrictNamespaces / RestrictRealtime | Y | — | Y | Y | Y | Y |
| RestrictSUIDSGID | Y | Y | Y | Y | Y | Y |
| LockPersonality | Y | — | Y | Y | Y | Y |
| MemoryDenyWriteExecute | — | — | — | — | — | Y |
| RemoveIPC | Y | — | Y | Y | Y | Y |
| SystemCallArchitectures=native | Y | — | Y | Y | Y | Y |
| SystemCallFilter @system-service, ~@privileged @resources | Y | — | Y | Y | Y | Y |
| UMask | 0077 | 0077 | 0077 | 0077 | 0077 | 0077 |

`InaccessiblePaths=` per unit (a `-` prefix means a missing path is ignored):

| Path | fleet | agent | witness | operator-api | adapter | tunnel |
|---|---|---|---|---|---|---|
| `/etc/automaton-fleet` (whole dir) | — | **Y** (no `-`) | — | — | — | — |
| `/etc/automaton-fleet/admin.env` | Y | (dir) | Y | Y | Y | Y |
| `/etc/automaton-fleet/service.env` | — (it is the owner, via credential) | (dir) | Y | Y | Y | Y |
| `/etc/automaton-fleet/operator.env` | — | (dir) | — | — (it reads it) | Y | Y |
| `/etc/automaton-fleet/tls` | — | (dir) | Y | Y | Y | Y |
| `/etc/automaton-fleet/legacy-env-fleet.bak` | — | (dir) | Y | Y | Y | Y |
| `/etc/automaton-fleet/chatgpt-tunnel` | — | (dir) | — | — | Y | — (it uses it) |
| `/etc/automaton-fleet/chatgpt-adapter.json` | — | (dir) | — | — | — (it reads it) | Y |
| `/home` | — | tmpfs | `/home/automaton-agent` only | Y | Y | Y |
| `/var/lib/automaton-fleet` | — | Y | Y | Y | Y | Y |
| `/var/lib/automaton-fleet-witness` | — | — | — | Y | Y | Y |
| `/var/lib/automaton-fleet-chatgpt-adapter` | — | — | — | — | — | Y |
| `/var/lib/automaton-fleet-chatgpt-tunnel` | — | — | — | — | Y | — |
| `/var/log/automaton-fleet` | — | Y | Y | Y | Y | Y |
| `/var/log/automaton-fleet-operator` | — | — | — | — | Y | Y |
| `/var/log/automaton-fleet-chatgpt-adapter` | — | — | — | — | — | Y |
| `/run/credentials` | — | — | Y | Y | Y | — (needs its own) |
| `/opt/automaton-fleet/releases`, `/opt/automaton-fleet/chatgpt-adapter` | — | — | — | — | — | Y |

Observation: the controller's `InaccessiblePaths=` hides only `admin.env` and the agent home. Mode bits alone keep `operator.env` (root:automaton-fleet-operator-api 0640), `chatgpt-tunnel/` (root 0700) and `chatgpt-adapter.json` (root:adapter 0640) from the `automaton-fleet-service` uid. `fleet-verify-deployment.sh:54-57` checks this for `operator.env` as the real service uid.

### 11.10.5 Capability bounding

Every unit sets `CapabilityBoundingSet=` empty. Every unit except `automaton-agent` also sets `AmbientCapabilities=` empty. The only capability granted anywhere is `CAP_NET_BIND_SERVICE`, to `automaton-fleet.service`, through the remote drop-in (bounding and ambient).

### 11.10.6 Network restrictions

| Unit | IPAddressDeny | IPAddressAllow | RestrictAddressFamilies |
|---|---|---|---|
| automaton-fleet (base) | any | localhost | INET INET6 UNIX |
| automaton-fleet + remote drop-in | (reset: none) | any | INET INET6 UNIX |
| automaton-agent | — | — | — |
| witness | any | localhost | INET INET6 UNIX |
| operator-api | any | localhost | INET INET6 UNIX |
| chatgpt-adapter | any | localhost | INET UNIX |
| chatgpt-tunnel | localhost, link-local, multicast, 10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7 | 127.0.0.53/32, 127.0.0.54/32 | INET INET6 UNIX NETLINK |

systemd's `IPAddressAllow`/`IPAddressDeny` apply to both ingress and egress of the unit's sockets (cgroup BPF). systemd evaluates the allow list first, so an address on it overrides the deny list.

### 11.10.7 Restart policy

| Unit | Restart | RestartSec | StartLimit | Stop | Notes |
|---|---|---|---|---|---|
| automaton-fleet | on-failure | 5s | 5 / 300 s | SIGTERM, KillMode=mixed, 30 s | TimeoutStartSec=60s |
| automaton-agent | on-failure | 10s | default | default | — |
| witness | on-failure | 5s | 5 / 300 s | SIGTERM, 30 s | RestartPreventExitStatus=3 4 |
| operator-api | on-failure | 5s | 5 / 300 s | SIGTERM, 15 s | — |
| chatgpt-adapter | on-failure | 5s | 5 / 300 s | SIGTERM, 15 s | — |
| chatgpt-tunnel | on-failure | 10s | 5 / 300 s | SIGTERM, 15 s | `fleet-chatgpt-tunnel-key` runs `reset-failed` on the service and the path before its restart (`:132`) |

### 11.10.8 Dependencies and ordering

```
network-online.target ─┬─> automaton-fleet.service <── Wants+After ── automaton-agent.service
postgresql.service ────┤          ▲                   <── Wants+After ── automaton-fleet-witness.service
                       │          │ After only
                       └─> automaton-fleet-operator-api.service (Wants postgresql)
                                  ▲ After only
automaton-fleet-chatgpt-adapter.socket ──Requires+After──> automaton-fleet-chatgpt-adapter.service
            ▲ After
automaton-fleet-chatgpt-tunnel.service (Wants network-online; Conditions on key + tunnel.env)
            ▲ Unit= (PathExists=/etc/automaton-fleet/chatgpt-tunnel/openai-api-key)
automaton-fleet-chatgpt-tunnel.path
```

### 11.10.9 Socket permissions

| Socket | Created by | Owner:Group | Mode | Parent dir | Who may connect |
|---|---|---|---|---|---|
| `/run/automaton-fleet-chatgpt/adapter.sock` | systemd (socket unit) | automaton-fleet-chatgpt-adapter:automaton-fleet-chatgpt-tunnel | 0660 | `/run/automaton-fleet-chatgpt` root 0755 | adapter user, tunnel user (group) |
| `/run/automaton-fleet-chatgpt-tunnel/health.sock` | tunnel-client | tunnel user | (by UMask 0077: 0600 or stricter) | RuntimeDirectory 0700 | tunnel user only |
| TCP `127.0.0.1:8787`, `0.0.0.0:443` | controller | — | — | — | loopback / public |
| TCP `127.0.0.1:8788` | Operator API | — | — | — | loopback (SSH forward from `fleet-op-tunnel`; the adapter) |

### 11.10.10 Service-to-service relationships

```
                    public Internet (443/tcp only)                      dev VM (bridge-claude)
                              │                                             │ ssh -L 127.0.0.1:<p>:127.0.0.1:8788
                              ▼                                             ▼  as fleet-op-tunnel (permitopen 8788 only)
 automaton-agent ──HTTP──► automaton-fleet.service ◄─ HTTP loopback ─ witness     sshd ──► 127.0.0.1:8788
 (disabled)          127.0.0.1:8787 / 0.0.0.0:443                                         │
                              │ fleet_service_login, fleet_agent_login                    ▼
                              ▼                                           automaton-fleet-operator-api.service
                         PostgreSQL 127.0.0.1:5432 ◄──── fleet_operator_login ─────────┘   ▲ signed GET (bridge-chatgpt key)
                                                                                           │ 127.0.0.1:8788
 api.openai.com:443 ◄── outbound ── automaton-fleet-chatgpt-tunnel ──unix 0660──► automaton-fleet-chatgpt-adapter
                         (LoadCredential: openai-api-key, adapter-token)   X-Fleet-Adapter-Token
```

- The controller holds `fleet_service_login` and `fleet_agent_login` (both from `service.env`).
- The Operator API holds only `fleet_operator_login` (`operator.env`). It has no path to the controller's HTTP API.
- The ChatGPT adapter holds no database credential. It holds only the `bridge-chatgpt` Ed25519 key and signs requests to the Operator API.
- The tunnel holds only the OpenAI runtime key and the adapter token. It cannot reach any loopback TCP port (§11.8).
- Redis is not used by any fleet code (runbook `:412-414`).

---

## 11.11 REPO TEMPLATE ↔ INSTALLED UNIT

The scripts install every repository unit **byte-for-byte**: `install -m 0644 -o root -g root <repo file> /etc/systemd/system/<name>`. No templating or substitution happens. The only host-edited systemd artifact is `remote.conf`, copied by hand from the example. Expected equality:

| Installed path | Repo source | Expected relation | Recorded evidence |
|---|---|---|---|
| `/etc/systemd/system/automaton-fleet.service` | `deploy/systemd/automaton-fleet.service` | identical | "the existing units and node binary were byte-identical" (B2-9, runbook `:1189`). Stage 12 `diff` (runbook `:647`) |
| `/etc/systemd/system/automaton-fleet.service.d/remote.conf` | `…/remote.conf.example` | identical | runbook `:105` |
| `/etc/systemd/system/automaton-agent.service` | `deploy/systemd/automaton-agent.service` | identical | B2-9 re-apply |
| `/etc/systemd/system/automaton-fleet-witness.service` | `deploy/systemd/automaton-fleet-witness.service` | identical | S9b gate 9 |
| `/etc/systemd/system/automaton-fleet-operator-api.service` | `deploy/systemd/automaton-fleet-operator-api.service` | identical | B2-9 |
| `/etc/systemd/system/automaton-fleet-chatgpt-adapter.{socket,service}` | the repo files **at the commit the operator ran `prepare` from** | identical to that commit | Phase C (runbook `:1219`) |
| `/etc/systemd/system/automaton-fleet-chatgpt-tunnel.service` | same | identical to that commit | Phase C |
| `/etc/systemd/system/automaton-fleet-chatgpt-tunnel.path` | added in `d22f517` | installed after `d22f517` (operator record) | not in the runbook |
| `/etc/logrotate.d/automaton-fleet` | `deploy/logrotate/automaton-fleet` | identical | B2-9 |
| `/usr/local/sbin/fleet-chatgpt-tunnel-key` | `scripts/fleet-chatgpt-tunnel-key.sh` | identical to the latest helper (`efad214`) | operator record: "installed sha 9c8ff3d6…" (partial hash, not in the runbook) |

How to compare on the host (read-only):

```bash
vps$ cd ~/automaton-fleet-build            # tooling checkout at the pinned commit (see 12 §0)
vps$ for u in automaton-fleet.service automaton-agent.service automaton-fleet-witness.service \
             automaton-fleet-operator-api.service automaton-fleet-chatgpt-adapter.socket \
             automaton-fleet-chatgpt-adapter.service automaton-fleet-chatgpt-tunnel.service \
             automaton-fleet-chatgpt-tunnel.path; do
       cmp -s "deploy/systemd/$u" "/etc/systemd/system/$u" && echo "SAME $u" || echo "DIFF $u"; done
vps$ cmp deploy/systemd/automaton-fleet.service.d/remote.conf.example /etc/systemd/system/automaton-fleet.service.d/remote.conf && echo SAME remote.conf
vps$ cmp deploy/logrotate/automaton-fleet /etc/logrotate.d/automaton-fleet && echo SAME logrotate
vps$ cmp scripts/fleet-chatgpt-tunnel-key.sh /usr/local/sbin/fleet-chatgpt-tunnel-key && echo SAME helper
vps$ sha256sum /etc/systemd/system/automaton-fleet*.{service,socket,path} /etc/systemd/system/automaton-agent.service \
               /etc/systemd/system/automaton-fleet.service.d/remote.conf /etc/logrotate.d/automaton-fleet /usr/local/sbin/fleet-chatgpt-tunnel-key
vps$ systemctl is-enabled automaton-fleet.service automaton-agent.service automaton-fleet-witness.service \
       automaton-fleet-operator-api.service automaton-fleet-chatgpt-adapter.socket automaton-fleet-chatgpt-adapter.service \
       automaton-fleet-chatgpt-tunnel.service automaton-fleet-chatgpt-tunnel.path
vps$ systemctl show -p FragmentPath -p DropInPaths automaton-fleet.service
```

Expected enable/active state (from the recorded history):

| Unit | is-enabled | is-active |
|---|---|---|
| automaton-fleet.service | enabled | active |
| automaton-agent.service | disabled | inactive |
| automaton-fleet-witness.service | disabled | inactive |
| automaton-fleet-operator-api.service | enabled | active |
| automaton-fleet-chatgpt-adapter.socket | enabled | active (listening) |
| automaton-fleet-chatgpt-adapter.service | enabled | active |
| automaton-fleet-chatgpt-tunnel.service | enabled | inactive (condition: no key) |
| automaton-fleet-chatgpt-tunnel.path | enabled | active (waiting) |

<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->
(Needed: the `cmp`/`sha256sum` results, `is-enabled`/`is-active`, `DropInPaths`, `NRestarts` and the MainPID of each unit.)

---

# PART 12 — OS identities and filesystem map

## 12.1 OS users and groups

| Account / group | Kind | Created by (exact command) | Shell | Home | Groups | Purpose | Recorded uid/gid (production VPS) | Dev VM (observed 2026-09-25) |
|---|---|---|---|---|---|---|---|---|
| `automaton-fleet-admin` | **group only** (system) | `groupadd --system automaton-fleet-admin` (`fleet-os-setup.sh:68`) | — | — | members: the operator (`usermod -aG`, `:69`) | Group read of `admin.env`; group of `tls/` | gid not recorded; member `ubuntu` (runbook `:77`) | gid 983, member `sl4mm3r` |
| `automaton-fleet-service` | system user | `useradd --system --user-group --home-dir /var/lib/automaton-fleet --no-create-home --shell /usr/sbin/nologin --comment "Automaton fleet control service"` (`:70-71`) | nologin | `/var/lib/automaton-fleet` (StateDirectory) | own group only | Runs `automaton-fleet.service` | not recorded | uid 997 / gid 982 |
| `automaton-agent` | **regular** user | `useradd --user-group --create-home --home-dir /home/automaton-agent --shell /usr/sbin/nologin --comment "Automaton agent runtime"`; `chmod 0700 /home/automaton-agent` (`:72-74`) | nologin | `/home/automaton-agent` 0700 | own group; **no fleet group** | Local agent runtime (unit disabled) | not recorded | uid 1001 / gid 1001 |
| `automaton-fleet-witness` | system user | `useradd --system --user-group --home-dir /var/lib/automaton-fleet-witness --no-create-home --shell /usr/sbin/nologin --comment "Automaton fleet root witness"` (`:75-76`) | nologin | `/var/lib/automaton-fleet-witness` (StateDirectory) | own group only | Dry-run root witness | **uid 995 / gid 985** (runbook `:125`) | not created |
| `automaton-fleet-operator-api` | system user | `useradd --system --user-group --home-dir /var/lib/automaton-fleet-operator-api --no-create-home --shell /usr/sbin/nologin --comment "Automaton fleet Operator API"` (`:77-78`) | nologin | `/var/lib/automaton-fleet-operator-api` (never created) | own group only | Read-only Operator API | **uid 994 / gid 984** (runbook `:1189`) | not created |
| `fleet-op-tunnel` | system user | **NOT IN REPOSITORY.** Created by hand at B2-11 | `/usr/sbin/nologin`, password locked | `/var/lib/fleet-op-tunnel` | own group only | SSH account that can only forward to `127.0.0.1:8788` | **uid 993 / gid 983** (runbook `:1191`) | not created |
| `automaton-fleet-chatgpt-adapter` | system user | `useradd --system --user-group --home-dir /var/lib/automaton-fleet-chatgpt-adapter --no-create-home --shell /usr/sbin/nologin --comment "Automaton fleet ChatGPT adapter"` (`fleet-chatgpt-setup.sh:54`) | nologin | `/var/lib/automaton-fleet-chatgpt-adapter` (0700, created at `:59` and by StateDirectory) | own group only | ChatGPT adapter (bridge-chatgpt key) | **uid 992** (runbook `:1219`); gid not recorded | not created |
| `automaton-fleet-chatgpt-tunnel` | system user | `useradd --system --user-group --home-dir /var/lib/automaton-fleet-chatgpt-tunnel --no-create-home --shell /usr/sbin/nologin --comment "Automaton fleet ChatGPT tunnel client"` (`fleet-chatgpt-setup.sh:55`) | nologin | `/var/lib/automaton-fleet-chatgpt-tunnel` (StateDirectory) | own group only; its group is the adapter socket's group | OpenAI tunnel client | **uid 988** (runbook `:1219`); gid not recorded | not created |
| `ubuntu` (operator, VPS) | cloud-image default | OVH image | bash | `/home/ubuntu` | `sudo`, `automaton-fleet-admin` | Operator login; key-only SSH; passwordless sudo (open item, runbook `:143`) | not recorded | — |
| `sl4mm3r` (operator, dev VM) | human | — | bash | `/home/sl4mm3r` | `sudo`, `adm`, `automaton-fleet-admin` (983), `docker`, … | Dev VM operator, bridge-claude host | — | uid 1000 |
| `postgres` | package | Ubuntu `postgresql` | — | — | — | PostgreSQL superuser; runs `fleet-db-roles.sql` via `runuser -u postgres` (`fleet-db-setup.sh:43`) | — | — |

<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->
(Needed: `getent passwd`/`getent group` for every account above on the VPS, and `id -nG` for each.)

Isolation invariants, checked by `scripts/fleet-verify-deployment.sh`:
- None of `automaton-agent`, `automaton-fleet-service`, `automaton-fleet-witness` or `automaton-fleet-operator-api` can read `admin.env`, `service.env`, `tls/fleet.key` or `legacy-env-fleet.bak` (`:28-38`).
- `automaton-fleet-witness`, `automaton-fleet-operator-api`, `automaton-fleet-chatgpt-adapter` and `automaton-fleet-chatgpt-tunnel` each belong only to their own group (`:40-48`, `:86-90`).
- The adapter user and the tunnel user cannot read each other's secrets, `operator.env`, `admin.env` or `service.env` (`:109-112`).
- Neither ChatGPT user holds a TCP listener (`:113-116`).

## 12.2 Filesystem map — production VPS

Legend:
- **P/R**: P = persistent; R = runtime (tmpfs, recreated at boot or start).
- **Secret**: S = secret; N = not secret; C = confidential (not a credential, but sensitive).
- "Script" is the file:line that sets the owner and mode.
- "Readers/writers" lists the processes that open the path in normal operation.

### 12.2.1 `/etc/automaton-fleet`

```
/etc/automaton-fleet/                           root:root 0755
├── admin.env                                   root:automaton-fleet-admin 0640   S
├── service.env                                 root:root 0600                    S
├── operator.env                                root:automaton-fleet-operator-api 0640  S
├── runtime.env                                 root:root 0644                    N
├── runtime.env.pre-remote / .pre-witness / .pre-b0 / .pre-b2 / .pre-b2-fix   root:root 0644  N (rollback copies)
├── legacy-env-fleet.bak                        root:root 0600                    S (only if a repo .env.fleet held secrets)
├── chatgpt-adapter.json                        root:automaton-fleet-chatgpt-adapter 0640  N (public ids + token digest)
├── chatgpt-tunnel/                             root:root 0700
│   ├── tunnel.env                              (see below)                       N
│   ├── adapter-token                           root:root 0600                    S
│   └── openai-api-key                          root:root 0600                    S (owner-provided; may be absent)
└── tls/                                        root:automaton-fleet-admin 0750
    ├── fleet.key                               root:root 0600                    S
    └── fleet.crt                               root:root 0644                    N
```

| Path | Owner:group mode | Set by | Purpose | Readers / writers | P/R | Secret |
|---|---|---|---|---|---|---|
| `/etc/automaton-fleet/` | root:root 0755 | `fleet-os-setup.sh:81` | Configuration root. 0755 lets the service `stat` the credential sources (`secret-files.ts:250-251`) | — | P | N |
| `admin.env` | root:automaton-fleet-admin 0640 | `fleet-os-setup.sh:96`, `:100-101`; production created by hand first (runbook `:449-458`) | `FLEET_ADMIN_DATABASE_URL` (schema owner `fleetadmin`) | read: operator CLI (`pnpm fleet:*`) through group membership. Hidden from every unit | P | S |
| `service.env` | root:root 0600 | `fleet-os-setup.sh:106`, `:108-111` (passwords `openssl rand -hex 32`) | `FLEET_SERVICE_DATABASE_URL` (`fleet_service_login`), `FLEET_AGENT_DATABASE_URL` (`fleet_agent_login`), both `@127.0.0.1:5432/automaton_fleet` | read: systemd (root) for LoadCredential; `fleet-db-setup.sh` (root) extracts passwords with `sed` | P | S |
| `operator.env` | root:automaton-fleet-operator-api 0640, 1 link | `fleet-os-setup.sh:116-126` (refuses a symlink) | `FLEET_OPERATOR_DATABASE_URL` (`fleet_operator_login`) | read: Operator API process; `fleet-db-setup.sh` (root) | P | S |
| `runtime.env` | root:root 0644 | `fleet-os-setup.sh:129-133` (from the example only if absent); production installed byte-for-byte from the dev VM (runbook `:489`), then `sudoedit` | Pins + safety flags + listen/remote settings | read: controller, Operator API, witness, operator CLI, `fleet-deploy-release.sh` | P | N |
| `runtime.env.pre-*` | root:root 0644 (`cp -p`) | by hand (runbook `:864`, `:118`, `:1185-1186`) | Rollback copies | operator | P | N |
| `legacy-env-fleet.bak` | root:root 0600 | `fleet-os-setup.sh:151` (only if `.env.fleet` held controller secrets) | Backup of the old repository `.env.fleet` | none | P | S |
| `chatgpt-adapter.json` | root:automaton-fleet-chatgpt-adapter 0640, 1 link | `fleet-chatgpt-setup.sh:122-127` (umask 027, tmp + mv) | `{version:1, principalId, keyFile, keyId, operator:{port:8788,user:"automaton-fleet-operator-api"}, tunnelTokenSha256, limits:{callsPerMinute:30, burst:10, maxQueued:4}}` | read: adapter | P | N (holds the token's SHA-256, not the token) |
| `chatgpt-tunnel/` | root:root 0700 | `fleet-chatgpt-setup.sh:58`; the helper refuses anything else (`fleet-chatgpt-tunnel-key.sh:95`) | Tunnel secrets | root / systemd only | P | S (dir) |
| `chatgpt-tunnel/adapter-token` | root:root 0600, 1 link | `fleet-chatgpt-setup.sh:76-86` (`head -c 32 /dev/urandom \| base64 \| tr '+/' '-_' \| tr -d '=\n'`) | Static header the tunnel sends to the adapter | systemd LoadCredential → tunnel; `configure` hashes it (`:118`) | P | S |
| `chatgpt-tunnel/openai-api-key` | root:root 0600, 1 link | `fleet-chatgpt-tunnel-key.sh:121-128` (umask 077, mktemp, chown, chmod, mv) | OpenAI runtime API key (Tunnels Read + Use) | systemd LoadCredential → tunnel | P | S |
| `chatgpt-tunnel/tunnel.env` | **NOT IN REPOSITORY**: no script creates it | written by hand | `CONTROL_PLANE_TUNNEL_ID=tunnel_6ab5cd2c7b088191abe137e56b5f35e4` | systemd EnvironmentFile → tunnel | P | N |
| `chatgpt-tunnel/.prev.XXXXXX` | root 0600 | `fleet-chatgpt-tunnel-key.sh:122` (transient, during verification only) | Previous key kept for rollback | helper | transient | S |
| `tls/` | root:automaton-fleet-admin 0750 | `fleet-os-setup.sh:82-83` (refuses a symlink) | LoadCredential sources | systemd; operator (group) can list it | P | S (dir) |
| `tls/fleet.key` | root:root 0600, single link | re-permissioned by `fleet-os-setup.sh:85-92`; created by `install -m 0600` (runbook `:824`) and the certbot deploy hook | TLS private key (ECDSA P-256) | systemd LoadCredential → controller | P | S |
| `tls/fleet.crt` | root:root 0644, single link | as above (runbook `:825`) | Full chain | systemd LoadCredential; doctor reads it (`doctor.ts:502`) | P | N |
| `tls/fleet.{key,crt}.prev`, `.new` | as the originals | certbot deploy hook (runbook `:1314-1317`) | Transient during renewal | hook | transient | S/N |

<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->
(Needed: `stat -c '%U:%G %a %h %n'` for every entry above, the owner/mode of `tunnel.env`, and whether `legacy-env-fleet.bak` exists on the VPS.)

### 12.2.2 `/opt/automaton-fleet`

```
/opt/automaton-fleet/                          root:root 0755
├── node/                                      root:root 0755
│   └── bin/                                   root:root 0755
│       └── node                               root:root 0755   (pinned copy of the operator's node)
├── releases/                                  root:root 0755
│   ├── 4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790/   root, dirs 0555, files r--/r-x  (current)
│   ├── 5a5469e…/ 03f8760…/ cdfd70c…/ 11c0c7c…/     rollback releases
├── current -> releases/4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790   (symlink)
├── chatgpt-adapter/                           root:root 0755
│   ├── releases/6691b4c…/                     root, 0555 (no .git, no .adapter-pins)
│   ├── current -> releases/6691b4c…
│   └── pins.env                               0644
└── tunnel-client/
    └── v0.0.14/                               root:root 0755
        ├── tunnel-client-runtime              root:root 0755 (sha256 94ae9d0c…5c77)
        ├── LICENSE                            root:root 0644
        └── NOTICE                             root:root 0644
```

| Path | Owner:group mode | Set by | Purpose | Readers / writers | P/R | Secret |
|---|---|---|---|---|---|---|
| `/opt/automaton-fleet`, `releases`, `node`, `node/bin` | root:root 0755 | `fleet-os-setup.sh:136` | Code root | read by every fleet unit | P | N |
| `node/bin/node` | root:root 0755 | `fleet-os-setup.sh:137` (`install` of `$FLEET_NODE_BIN`, or the operator's `command -v node`) | Pinned interpreter. Production: a copy of apt `/usr/bin/node` v22.23.3 (runbook `:81`, `:392-394`) | ExecStart of 5 units | P | N |
| `releases/<commit>/` | root:root. After `chmod -R go-w,u-w` and a final `chmod u-w`: dirs 0555, files 0444 (0555 if executable) | `fleet-deploy-release.sh:68-75` | Immutable release tree, `.git` removed (`:70`) | read by the units; build identity re-verified at install (`:72-73`) | P | N |
| `current` | root symlink, atomic (`ln -sfn … current.tmp && mv -T`) | `fleet-deploy-release.sh:75` | Active release | WorkingDirectory | P | N |
| `chatgpt-adapter/`, `chatgpt-adapter/releases` | root:root 0755 | `fleet-deploy-chatgpt-adapter.sh:57` | Adapter artifact root | adapter | P | N |
| `chatgpt-adapter/releases/<commit>/` | root, read-only (same chmod recipe) | `fleet-deploy-chatgpt-adapter.sh:58-63` | Separate pinned artifact; `.git` and `.adapter-pins` removed | adapter; `fleet-chatgpt-setup.sh` runs `keygen.js` and `canonical.js` from it | P | N |
| `chatgpt-adapter/pins.env` | root 0644 | `fleet-deploy-chatgpt-adapter.sh:64-65` | `FLEET_CHATGPT_ADAPTER_COMMIT/_BUILD_ID/_LOCKFILE_SHA256` | operator | P | N |
| `chatgpt-adapter/current` | root symlink | `fleet-deploy-chatgpt-adapter.sh:66` | Active adapter | adapter WorkingDirectory | P | N |
| `tunnel-client/v0.0.14/` | root:root 0755 | `fleet-chatgpt-setup.sh:66-68` | OpenAI tunnel-client | tunnel ExecStart | P | N |

Recorded: `releases/cdfd70c…` has 887 files (runbook `:120`); `releases/03f8760…` has 900 files; `releases/5a5469e…` and `releases/4d6a0be…` have 948 files each (operator record).
<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->

### 12.2.3 `/var/lib/*` (state)

| Path | Owner:group mode | Set by | Contents | Writer | P/R | Secret |
|---|---|---|---|---|---|---|
| `/var/lib/automaton-fleet` | automaton-fleet-service, 0700 | systemd `StateDirectory` (`automaton-fleet.service:56-57`) | (service home; the code writes no state there) | controller | P | N |
| `/var/lib/automaton-fleet-witness` | automaton-fleet-witness, 0700 | `StateDirectory` (`witness.service:36-37`); runbook `:1033` `install -d -m 0700` | `fleet-credentials.json` (0600) once enrolled | witness (reads), operator installs it | P | S (when present) |
| `/var/lib/automaton-fleet-operator-api` | **not created** | — | (home in passwd only) | — | — | — |
| `/var/lib/automaton-fleet-chatgpt-adapter` | adapter:adapter 0700 | `fleet-chatgpt-setup.sh:59` + `StateDirectory` | `bridge-chatgpt.key` adapter:adapter 0600, 1 link (checked at `fleet-verify-deployment.sh:100`); written by `keygen.js` with `O_CREAT\|O_EXCL\|O_NOFOLLOW`, 0600 (`operator/keygen.ts:28-41`) | adapter | P | S |
| `/var/lib/automaton-fleet-chatgpt-tunnel` | tunnel user, 0700 | `StateDirectory` | tunnel-client state (`HOME`) | tunnel | P | C |
| `/var/lib/fleet-op-tunnel/.ssh/authorized_keys` | root:root 0644 (operator record; runbook `:1191` says "Root-owned") | **NOT IN REPOSITORY** (B2-11, by hand) | one line: `restrict,port-forwarding,permitopen="127.0.0.1:8788",command="/usr/sbin/nologin" <tunnel public key>` | sshd | P | N (public key) |
| `/var/lib/postgresql/16/main` | postgres | package | Registry database `automaton_fleet`, schema `fleet` | PostgreSQL | P | C |

### 12.2.4 `/var/log/*`

| Path | Owner mode | Set by | Rotation | P/R | Secret |
|---|---|---|---|---|---|
| `/var/log/automaton-fleet/` | automaton-fleet-service 0700 | `LogsDirectory` | — | P | C |
| `/var/log/automaton-fleet/audit.jsonl` | automaton-fleet-service 0600 | `log.ts:41` (`openSync(…, "a", 0o600)`) | logrotate: `size 50M`, `rotate 14`, `compress`, `delaycompress`, `create 0600 automaton-fleet-service automaton-fleet-service`, `su …` | P | C (redacted by `redactAuditRecord` since `03f8760`) |
| `/var/log/automaton-fleet/audit.jsonl.pre-b0-20260924T215651Z` | service user | renamed by hand at B0-6 (operator record) | — | P | C |
| `/var/log/automaton-fleet-operator/` | automaton-fleet-operator-api 0700 | `LogsDirectory` | — | P | C |
| `/var/log/automaton-fleet-operator/audit.jsonl` | 0600 | Operator API audit sink | logrotate, same policy, owner automaton-fleet-operator-api | P | C |
| `/var/log/automaton-fleet-chatgpt-adapter/` | adapter 0700 | `LogsDirectory` | **none** (NOT IMPLEMENTED) | P | C |
| `/var/log/automaton-fleet-chatgpt-adapter/audit.jsonl` | 0600 | `chatgpt-adapter/main.ts:125` | none | P | C |
| `/var/log/letsencrypt/letsencrypt.log` | root | certbot | certbot's own | P | N |
| journald (`SyslogIdentifier=` automaton-fleet, automaton-fleet-operator-api, automaton-fleet-witness, automaton-fleet-chatgpt-adapter, automaton-fleet-chatgpt-tunnel) | root / `systemd-journal` | journald | journald limits | P | C |

**DRIFT:** runbook open item `:152` says "The JSONL audit file is written without `scrubDetail` (`src/fleet/service/main.ts:258`) … not fixed yet". The code now routes every JSONL line through `redactAuditRecord` (`src/fleet/service/log.ts:40-47`), since commit `03f8760` ("security: centralize fleet audit redaction", deployed at B0 and included in `4d6a0be`). The open item is stale.

### 12.2.5 `/run/*` (runtime, tmpfs)

| Path | Owner mode | Created by | Contents | Secret |
|---|---|---|---|---|
| `/run/credentials/automaton-fleet.service/` | root, not group/world-writable (checked, `secret-files.ts:229-232`) | systemd | `service.env` (+ `tls.key`, `tls.crt` with the drop-in). Files are root 0400 plus a read ACL for the unit user, which `stat` shows as 0440 (`secret-files.ts:16-22`) | S |
| `/run/credentials/automaton-fleet-chatgpt-tunnel.service/` | root | systemd | `openai-api-key`, `adapter-token` | S |
| `/run/automaton-fleet-chatgpt/` | root 0755 | socket unit `DirectoryMode=0755` | `adapter.sock` (adapter:tunnel 0660) | N |
| `/run/automaton-fleet-chatgpt-tunnel/` | tunnel user 0700 | `RuntimeDirectory` | `health.sock` | N |
| `/run/systemd/timesync/synchronized` | root | systemd-timesyncd | Marker required by Operator API readiness | N |

### 12.2.6 systemd, logrotate, sbin, sshd, letsencrypt

| Path | Owner mode | Set by | Notes |
|---|---|---|---|
| `/etc/systemd/system/automaton-fleet.service` | root 0644 | `fleet-os-setup.sh:140` | §11.1 |
| `/etc/systemd/system/automaton-fleet.service.d/` | root 0755 | runbook `:846` | — |
| `/etc/systemd/system/automaton-fleet.service.d/remote.conf` | root 0644 | runbook `:847-848` | §11.2 |
| `/etc/systemd/system/automaton-agent.service` | root 0644 | `fleet-os-setup.sh:141` | — |
| `/etc/systemd/system/automaton-fleet-witness.service` | root 0644 | `:142` | — |
| `/etc/systemd/system/automaton-fleet-operator-api.service` | root 0644 | `:143` | — |
| `/etc/systemd/system/automaton-fleet-chatgpt-adapter.{socket,service}`, `automaton-fleet-chatgpt-tunnel.{service,path}` | root 0644 | `fleet-chatgpt-setup.sh:101-104` | — |
| `/etc/systemd/system/multi-user.target.wants/automaton-fleet.service`, `…/automaton-fleet-operator-api.service`, `…/automaton-fleet-chatgpt-adapter.service`, `…/automaton-fleet-chatgpt-tunnel.service`; `sockets.target.wants/…adapter.socket`; `paths.target.wants/…tunnel.path` | symlinks | `systemctl enable` | enable state |
| `/etc/logrotate.d/automaton-fleet` | root 0644 | `fleet-os-setup.sh:147` | §12.2.4 |
| `/usr/local/sbin/fleet-chatgpt-tunnel-key` | root:root 0755 | `fleet-chatgpt-setup.sh:105` | Owner-only key entry (TTY required) |
| `/usr/local/sbin/fleet-certbot-port80` | root 0755 | **NOT IN REPOSITORY** (runbook `:102`) | `open\|close` port 80 in ufw |
| `/etc/letsencrypt/` (live/, archive/, renewal/api.agentfleet.vip.conf) | root, 0700 for keys | certbot | The key never leaves the VPS (runbook `:803`) |
| `/etc/letsencrypt/renewal-hooks/pre/10-fleet-open-port80`, `post/90-fleet-close-port80` | root 0755 | **NOT IN REPOSITORY** | call `fleet-certbot-port80` |
| `/etc/letsencrypt/renewal-hooks/deploy/automaton-fleet.sh` | root 0755 | Text in the runbook (`:1303-1331`); recorded SHA-256 `197dfe74…1a5f`; "not tested by hand yet" (runbook `:103`) | Copies the renewed pair into `tls/`, restarts, and rolls back if unhealthy |
| `/etc/ssh/sshd_config.d/10-fleet-no-passwords.conf` | root (mode not recorded) | **NOT IN REPOSITORY** (B2 closeout) | `PasswordAuthentication no`, `KbdInteractiveAuthentication no` (runbook `:66`) |
| `/etc/ssh/sshd_config.d/50-cloud-init.conf`, `60-cloudimg-settings.conf` | root | OVH image | `50-` sets `PasswordAuthentication yes`, which `10-` overrides (first value wins) |
| `/etc/ssh/sshd_config.d/70-fleet-op-tunnel.conf` | root | **NOT IN REPOSITORY** (B2-11) | `Match User fleet-op-tunnel` block ending in `Match all` (runbook `:1191`) |

**DRIFT:** runbook stage 2 (`:309-325`) prescribes `/etc/ssh/sshd_config.d/10-fleet-hardening.conf`, including `AllowUsers <operator>`. The production record shows that file's effect was never in force: until the B2 closeout the effective `PasswordAuthentication` was `yes` (runbook `:66`). An `AllowUsers <operator>` line would also block `fleet-op-tunnel`. The final reality is `10-fleet-no-passwords.conf` plus `70-fleet-op-tunnel.conf`.
<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->
(Needed: `ls -l /etc/ssh/sshd_config.d/` and the text of `10-fleet-no-passwords.conf` and `70-fleet-op-tunnel.conf`; these contain no secrets.)

### 12.2.7 Operator home on the VPS (`~ubuntu`)

| Path | Mode | Purpose | Secret |
|---|---|---|---|
| `~ubuntu/automaton-fleet-build/` | operator | **Tooling checkout**, detached at `4d6a0be` since B2 (runbook `:70`), used for `pnpm fleet:*` and the scripts | N |
| `~ubuntu/.cache/automaton-fleet/stage/<commit>/` | operator (keeps `.git`) | `fleet-deploy-release.sh build` staging (`:41`) | N |
| `~ubuntu/.cache/automaton-fleet/chatgpt-adapter-stage/<commit>/` | operator, plus `.adapter-pins` | `fleet-deploy-chatgpt-adapter.sh build` staging (`:31`, `:45`) | N |
| `~ubuntu/automaton_fleet-v6-pre-v7.dump` (+ `.sha256`, `fleet-rowcounts-pre-v7.txt`) | 0600 | S9b rollback to v6 (SHA-256 `ccde45b5…0e10`, runbook `:122`) | C |
| `~ubuntu/automaton_fleet-v7-pre-v8.dump` (+ `.sha256`, `fleet-rowcounts-pre-v8.txt`, `b2-7-dump-toc.txt`) | 0600 | B2 rollback to v7 (SHA-256 `e76f50c9b22193b061048ee005448aa25f810d18167e8380642cde01418b96dd`, runbook `:1187`) | C |
| `~ubuntu/automaton_fleet-v8-pre-chatgpt-20260925T005947Z.dump` | 0600 | Pre-Phase C backup (SHA-256 `4bd240fbd24d06acf05eb8f64603f4af1e762a7e8967dd4d4d5574b947212634`, runbook `:1216`) | C |
| `~ubuntu/automaton-fleet-final-frozen.dump`, `automaton-fleet-pre-vps.dump` | **0664** | Cutover dumps; recommended for deletion (runbook `:1353-1354`) | C |
| `~ubuntu/s9b-*.{txt,log}`, `b2-5-*` | 0664 | Build and install logs, no secrets | N |

**DRIFT:** runbook stage 6 (`:425-426`) clones the tooling checkout to `~/automaton-fleet`. The production host record (`:70`) names it `~ubuntu/automaton-fleet-build`.
<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->

## 12.3 Filesystem map — development VM

The dev VM is not a live registry. Its controller is stopped and disabled. It holds the only copies of the bridge-claude signing key and of the SSH tunnel transport key.

| Path | Owner mode (observed 2026-09-25) | Created by | Purpose | Secret |
|---|---|---|---|---|
| `~/.config/automaton-fleet/` | sl4mm3r 0700 | `fleet:bridge init` (`bridge/cli.ts:91`, `mkdirSync(…, 0o700)`) | — | — |
| `~/.config/automaton-fleet/operator/` | sl4mm3r 0700 (`requirePrivateDirectory`, `operator/keygen.ts:20-26`) | `init`/keygen | Bridge directory (`DEFAULT_BRIDGE_DIR`, `bridge/config.ts:21`) | — |
| `…/operator/bridge-claude.key` | sl4mm3r 0600, 1 link | `pnpm fleet:operator-keygen` (`O_EXCL\|O_NOFOLLOW`, 0600) | Ed25519 PKCS#8 signing key for `op_01M3AX56W25JNMQCTBM8HYH474` (key id `ec4f06982ae9135fd2b28e928f5a4a61`) | S |
| `…/operator/bridge-claude.json` | sl4mm3r 0600 | `init` (`bridge/cli.ts:115`, `flag:"wx"`) | Public identities and paths: principal, key file + key id, pending/previous key, ssh `{host 51.195.148.111, port 22, user fleet-op-tunnel, identityFile, knownHostsFile, hostKeyFingerprint, binary /usr/bin/ssh}` | N |
| `…/operator/known_hosts` | sl4mm3r 0600 | `init` (`bridge/cli.ts:95-98`) | Exactly one `ssh-ed25519` line whose fingerprint must equal `SHA256:HUuqOfrwidWq3SagFJD3rEavFX29u89cy1vIqun0tRg` (`bridge/hostkey.ts:28-44`) | N |
| `~/.ssh/fleet_op_tunnel` (+ `.pub` 0644) | sl4mm3r 0600 | by hand (B2-11) | SSH transport key for `fleet-op-tunnel`, fingerprint `SHA256:wP56E+ziLw3JwnkylaE/AbYX37akdauAcuchUIpK6Ns` (runbook `:1191`). Not a signing key | S |
| `~/.ssh/known_hosts` | sl4mm3r 0600 | ssh | Source for `init --from-known-hosts` only. The tunnel never reads it (`GlobalKnownHostsFile=/dev/null`, `UserKnownHostsFile=<dedicated>`, `bridge/tunnel.ts:67-68`) | N |
| `~/.ssh/agentfleet_vps` (+ `.pub`), `~/.ssh/config` | 0600 | by hand | Operator admin SSH (`ssh agentfleet-vps` = `ubuntu@51.195.148.111`) | S |
| `$XDG_RUNTIME_DIR/automaton-fleet-bridge/` (`/run/user/1000/…`) | sl4mm3r 0700 | `bridge/tunnel.ts:207-216` (fallback `~/.config/automaton-fleet/operator/run`) | Persistent-tunnel state file (0600, `flag:"wx"`) and ssh log (0600) | N |
| `/etc/automaton-fleet/` (dev VM) | root:root 0755. Observed: `admin.env` root:automaton-fleet-admin 640; `service.env` root 600; `runtime.env` 644; `runtime.env.pre-241dcf9` 644; `legacy-env-fleet.bak` 600; `tls/` root:automaton-fleet-admin 750 (contents not listed) | `fleet-os-setup.sh` | Inert local controller configuration (secrets are local-only, never copied to the VPS, runbook `:190-192`) | S |
| `/opt/automaton-fleet/` (dev VM) | root 0755; `current -> releases/11c0c7c…`; releases `11c0c7c…` (0555), `241dcf9…` (0555), `2d6d4cf…` (**0775**) | `fleet-deploy-release.sh` / by hand | Old local releases | N |
| Claude Code local-scope MCP registration `fleet-operator` | stored by Claude Code (`claude mcp add --scope local`) | runbook `:1267-1272` | Absolute node/tsx/script/config paths, no secrets (operator record) | N |

Observations on the dev VM:
- `/opt/automaton-fleet/releases/2d6d4cf…` is mode 0775. It predates `fleet-deploy-release.sh install`, which makes release directories 0555.
- `/etc/logrotate.d/automaton-fleet` is absent on the dev VM. `fleet-os-setup.sh` has not been re-run there since B2.
- `automaton-fleet.service` is disabled and inactive, as required by "only one controller may be live" (runbook `:54-57`).

## 12.4 Script defects found while mapping (not fixed; documentation only)

| Script | Issue |
|---|---|
| `fleet-os-setup.sh:158` | The last line `(( APPLY )) && echo …` makes a **dry run exit 1** (the script's status is that of its last command). Benign, recorded by the operator |
| `fleet-db-setup.sh:13` | The header comment says `pnpm fleet:migrate  # v1 -> v3`. The current target is v8 (`FLEET_PG_SCHEMA_VERSION = 8`, `src/fleet/postgres/migrations.ts:20`). **DRIFT (comment only)** |
| `fleet-os-setup.sh:77` | Home `/var/lib/automaton-fleet-operator-api` is never created (no StateDirectory). Harmless for a nologin system user |
| `fleet-chatgpt-setup.sh` | Does not create `chatgpt-tunnel/tunnel.env`. The tunnel unit's `ConditionPathExists=` and the helper (`fleet-chatgpt-tunnel-key.sh:96`) both require it. **NOT IMPLEMENTED** in scripts; created by hand |
| `fleet-verify-deployment.sh` | Does not check `tunnel.env`, `/usr/local/sbin/fleet-chatgpt-tunnel-key`, the `.path` unit or `/etc/logrotate.d/automaton-fleet` |
| (none) | No script creates `fleet-op-tunnel`, its `authorized_keys`, `70-fleet-op-tunnel.conf` or `10-fleet-no-passwords.conf`. **NOT IN REPOSITORY** |
