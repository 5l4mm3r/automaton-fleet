# 12 — Production deployment reconstruction from clean Ubuntu (PART 14)

> Master-Key archive, reconstruction grade. Repository HEAD `efad214` (branch `fleet-development`).
> This document rebuilds the production control plane **as it finally exists** (after Phase C, 2026-09-25) using the repository's scripts and the production runbook. Where the runbook's step-by-step text differs from what production ended up with, the final reality is stated and marked **DRIFT:**.
> **No secret value appears here.** Secrets are always generated on the target host, never printed, and never passed on a command line. Their generation commands are shown without output.
> Every privileged step is an operator approval point under `CLAUDE.md`. Nothing here authorizes running it.

Prompts:
- `vps$` runs on the production host as the operator (`ubuntu` in production), who is a member of `automaton-fleet-admin`.
- `dev$` runs on the development VM (the bridge-claude host).
- `ws$` runs on any external workstation.

---

## 14.0 Fixed values of the final production state

| Item | Value |
|---|---|
| Host | Ubuntu 24.04 LTS x86_64, systemd ≥ 255 (production: 24.04.4, kernel 6.8.0-136, systemd 255.4, 4 vCPU, 7.6 GiB, 72 GB) |
| Public IPv4 / hostname | `51.195.148.111` / `api.agentfleet.vip` |
| Runtime repository | `https://github.com/5l4mm3r/automaton-fleet.git` |
| Runtime commit | `4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790` |
| Runtime build ID | `54beb10104a11888446ed1d09a85f236d87b977558a88514de7600d7dcc83ced` |
| Lockfile SHA-256 | `eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811` |
| Database / owner / schema | `automaton_fleet` / `fleetadmin` / schema `fleet`, version **v8** |
| ChatGPT adapter artifact | commit `6691b4c9db9d5dedb246d4e984b495f7c4cf0251`, build `62336fee32671ea04de3bb18c1552273cd80bc02c1d2bd5f219f1dee3b018057`, lockfile `eee9dc2f…` |
| Tunnel client | OpenAI `tunnel-client-runtime` v0.0.14 (zip `29d29cf8…505b`, binary `94ae9d0c…5c77`) |
| Node | production: v22.23.3 from apt, pinned copy at `/opt/automaton-fleet/node/bin/node`. The build ID also reproduces with v22.23.2 |
| pnpm | `packageManager: pnpm@10.28.1` (`package.json:39`), via corepack. The production global pnpm 10.34.5 was left installed |
| PostgreSQL / Redis | 16.15 / 7.0.15 |
| Registry | cap 2, DEVELOPMENT, replication off, 0 agents |
| Principals | `bridge-claude` `op_01M3AX56W25JNMQCTBM8HYH474`, key `ec4f06982ae9135fd2b28e928f5a4a61` (expires 2026-10-24T23:49:04.533Z); `bridge-chatgpt` `op_01M3B18TXVP33S6NQC909DXD57`, key `fe22d91c08f0a0676b4c155ce0d618d3` (expires 2026-10-25T01:00:57.682Z) |
| Safety flags | `REAL_REPLICATION_ENABLED=false`, `REAL_PAYMENTS_ENABLED=false`, `OWNER_SWEEP_ENABLED=false`, `FLEET_DRY_RUN_CHILD=false`, `FLEET_REMOTE_LISTEN_ENABLED=true` |

Rollback releases kept on the host: `5a5469e`, `03f8760` (B0), `cdfd70c`, `11c0c7c`.
<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->

---

## 14.1 Order of operations (dependency graph)

```
1 base OS ─► 2 SSH/ufw baseline ─► 3 Node+pnpm ─► 4 PostgreSQL+Redis ─► 5 tooling checkout
   ─► 6 /etc/automaton-fleet (admin.env, runtime.env by hand; then fleet-os-setup.sh)
   ─► 7 DB owner + database ─► 8 fleet-db-setup.sh (all 6 restricted roles)
   ─► 9 registry: A) restore latest v8 dump  or  B) fresh fleet:migrate
   ─► 10 reproducible build ─► 11 install release ─► 12 approve/verify runtime
   ─► 13 systemd verify + loopback start + /readyz ─► 14 DNS ─► 15 certificate
   ─► 16 tls/ sources ─► 17 remote drop-in + runtime.env ─► 18 firewall 443
   ─► 19 restart + public validation ─► 20 doctor/verify ─► 21 cap 2 (path B only)
   ─► 22 Operator API ─► 23 fleet-op-tunnel SSH account ─► 24 Claude bridge (dev VM)
   ─► 25 ChatGPT adapter + tunnel ─► 26 final verification + hash comparison (23-REBUILD-CHECKLIST.md)
```

Hard ordering constraints, taken from the code:
- `fleet-os-setup.sh` needs `admin.env` to exist first. Otherwise it looks for a secret in the repo `.env.fleet`, which must not exist on the VPS (`fleet-os-setup.sh:95-102`).
- It also needs `runtime.env` to exist first. Otherwise it installs the empty example (`:129-133`).
- `fleet-db-setup.sh` needs both `service.env` and `operator.env` (`fleet-db-setup.sh:26-27`), so it runs after `fleet-os-setup.sh`.
- The restricted roles must exist **before** a dump restore, because the dump's GRANTs name them (runbook `:539-541`). Roles are cluster-global and `pg_dump -n fleet` does not include them.
- `pnpm fleet:migrate` grants the agent, service and operator roles **only if they exist** (`src/fleet/postgres/store.ts:571-573`).
- `fleet-deploy-release.sh` reads the pins from `runtime.env` (`:22-28`). `install` re-verifies with the pinned Node (`:72`), so step 6 must precede steps 10 and 11.
- The service refuses to start if its pins differ from the registry approval (`service/main.ts:245-252`). The Operator API refuses the same (`operator/main.ts:141-150`).
- `fleet-chatgpt-setup.sh prepare` needs the adapter artifact installed first (`:51`).

---

## 14.2 Step 1 — Clean Ubuntu base

```bash
ws$  ssh ubuntu@<VPS_IP>     # compare the host-key fingerprint with the provider console first
vps$ lsb_release -ds; uname -m; systemd --version | head -1     # Ubuntu 24.04.x, x86_64, systemd >= 255
vps$ sudo apt update && sudo apt full-upgrade -y
vps$ sudo apt install -y unattended-upgrades ufw curl ca-certificates gnupg xz-utils git openssl jq
vps$ sudo timedatectl set-timezone Etc/UTC
vps$ timedatectl                                  # "System clock synchronized: yes", "NTP service: active"
vps$ test -e /run/systemd/timesync/synchronized && echo timesync-marker-present   # Operator API readiness needs it
vps$ sudo dpkg-reconfigure -plow unattended-upgrades
vps$ grep -R "Automatic-Reboot " /etc/apt/apt.conf.d/   # must be "false"
```

Clock sync is mandatory:
- agent signed requests are refused outside ±60 s (runbook `:298-299`);
- operator signed requests use a ±30 s window (`fleet-verify-deployment.sh:76-78`);
- the Operator API readiness also needs `|db time − now| ≤ 5 s` (`operator/main.ts:168-171`).

## 14.3 Step 2 — SSH hardening and baseline firewall

Final production reality. **DRIFT:** runbook stage 2 prescribes `10-fleet-hardening.conf`, but production ended with the file below (runbook `:66`, `:1193`).

```bash
vps$ sudo install -m 0644 -o root -g root /dev/stdin /etc/ssh/sshd_config.d/10-fleet-no-passwords.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
vps$ sudo sshd -t && sudo systemctl reload ssh      # reload, never restart
vps$ sudo sshd -T | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin)'
```

(The production file's exact text is **NOT IN REPOSITORY**. The two directives above are the recorded effect.)
<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->

Do **not** add `AllowUsers <operator>` without also listing `fleet-op-tunnel` (step 23).

Baseline firewall (SSH only; 443 is opened at step 18):

```bash
vps$ sudo ufw default deny incoming
vps$ sudo ufw default allow outgoing
vps$ sudo ufw allow 22/tcp comment 'operator SSH'
vps$ sudo ufw --force enable && sudo ufw status verbose
vps$ grep '^IPV6=' /etc/default/ufw        # IPV6=yes
```

Provider edge firewall (OVH, IPv4): allow TCP 22, 80 and 443, ESTABLISHED and ICMP; deny the rest (runbook `:100`).

## 14.4 Step 3 — Node 22 and pnpm

Either route reproduces the build ID. Production used apt.

```bash
# Route used in production (accepted deviation, runbook :392-394):
vps$ sudo apt install -y nodejs            # Ubuntu noble: v22.x; production v22.23.3 at /usr/bin/node
# Route prescribed by the runbook (:377-385), verified tarball:
vps$ V=v22.23.2; A=linux-x64
vps$ cd /tmp && curl -fsSLO https://nodejs.org/dist/$V/node-$V-$A.tar.xz && curl -fsSLO https://nodejs.org/dist/$V/SHASUMS256.txt
vps$ grep " node-$V-$A.tar.xz\$" SHASUMS256.txt | sha256sum -c -
vps$ sudo install -d -m 0755 /usr/local/lib/nodejs && sudo tar -xJf node-$V-$A.tar.xz -C /usr/local/lib/nodejs
vps$ for b in node npm npx corepack; do sudo ln -sfn /usr/local/lib/nodejs/node-$V-$A/bin/$b /usr/local/bin/$b; done
# pnpm from packageManager:
vps$ sudo corepack enable pnpm
```

Whichever `node` is first on the operator's `PATH` is what `fleet-os-setup.sh` copies to `/opt/automaton-fleet/node/bin/node`: `sudo -u "$OPERATOR" -i bash -c 'command -v node'`, or `$FLEET_NODE_BIN` if set (`fleet-os-setup.sh:47`, `:137`).

## 14.5 Step 4 — PostgreSQL 16 and Redis

```bash
vps$ sudo apt install -y postgresql redis-server
vps$ sudo -u postgres psql -XAt -c 'SHOW listen_addresses; SHOW password_encryption;'   # localhost / scram-sha-256
vps$ sudo grep -Ev '^\s*(#|$)' /etc/postgresql/16/main/pg_hba.conf   # local peer; host 127.0.0.1/32 and ::1/128 scram-sha-256 only
vps$ sudo grep -Ev '^\s*(#|$)' /etc/redis/redis.conf | grep -E '^(bind|protected-mode|port) '   # bind 127.0.0.1 -::1; protected-mode yes
vps$ sudo ss -Hltnp | grep -E ':(5432|6379)\b'     # loopback only
```

Redis is not used by any fleet code. Nothing reads `REDIS_URL`; it is only stripped from agent environments (runbook `:412-414`).

## 14.6 Step 5 — Operator tooling checkout at the pinned commit

```bash
vps$ git clone https://github.com/5l4mm3r/automaton-fleet.git ~/automaton-fleet-build
vps$ cd ~/automaton-fleet-build
vps$ git checkout --detach 4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790
vps$ test "$(git rev-parse HEAD)" = 4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790 && echo HEAD OK
vps$ echo "eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811  pnpm-lock.yaml" | sha256sum -c -
vps$ pnpm --version                      # 10.28.1
vps$ CI=true pnpm install --frozen-lockfile
vps$ test ! -e .env.fleet && echo "no .env.fleet (correct)"
```

**DRIFT:** the runbook clones to `~/automaton-fleet` (`:425`). Production uses `~ubuntu/automaton-fleet-build` (`:70`).

The tooling runs `pnpm fleet:*` from `src/` via `tsx` (`package.json:49-60`). It must be at the **same commit as the schema** it talks to: a v8 tree refuses a v7 registry and the reverse (runbook `:1145-1147`).

Caveat for the ChatGPT section of `fleet-verify-deployment.sh`: it exists only from `6691b4c` onward. Production ran that script "from the adapter tree" (runbook `:1224`).

## 14.7 Step 6 — `/etc/automaton-fleet` and host secrets

### 14.7.1 Directory and `admin.env` (by hand, before the script)

The fresh schema-owner password is generated in a root shell and never printed (runbook `:447-458`):

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

The `chown` needs the group `automaton-fleet-admin`. On a fresh host, run `sudo groupadd --system automaton-fleet-admin && sudo usermod -aG automaton-fleet-admin ubuntu` first. These are the same commands as `fleet-os-setup.sh:68-69`, which skips them if already done. Log out and back in, then confirm with `id`.

### 14.7.2 `runtime.env` (non-secret, by hand)

First write the **loopback-only** form. The remote lines are added at step 17.

```bash
vps$ sudo install -m 0644 -o root -g root /dev/stdin /etc/automaton-fleet/runtime.env <<'EOF'
FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
FLEET_RUNTIME_COMMIT=4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790
FLEET_RUNTIME_BUILD_ID=54beb10104a11888446ed1d09a85f236d87b977558a88514de7600d7dcc83ced
FLEET_RUNTIME_LOCKFILE_SHA256=eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811
REAL_REPLICATION_ENABLED=false
REAL_PAYMENTS_ENABLED=false
OWNER_SWEEP_ENABLED=false
FLEET_DRY_RUN_CHILD=false
FLEET_API_LISTEN=127.0.0.1:8787
FLEET_REAPER_INTERVAL_MS=15000
FLEET_REMOTE_LISTEN_ENABLED=false
EOF
```

This is the runbook's stage 7 content (`:473-484`) with the pins moved to `4d6a0be`. Production's `runtime.env` evolved by two-line pin edits (`11c0c7c → cdfd70c → 03f8760 → 5a5469e → 4d6a0be`) plus the stage 17 remote lines. The byte layout (comments, line order) of the production file is therefore not reproducible from the repository. Compare **values** (`grep -Ev '^\s*(#|$)' | sort`), not file hashes.
<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->
(Needed: the non-comment lines of production `runtime.env`, sorted, and its SHA-256. Recorded after B2-7: `c3d872ea…`.)

Never add `FLEET_MAX_AGENTS` (the registry cap is the control), `FLEET_TLS_KEY_FILE` or `FLEET_ALLOWED_ORIGINS`.

### 14.7.3 `fleet-os-setup.sh`

```bash
vps$ cd ~/automaton-fleet-build
vps$ sudo scripts/fleet-os-setup.sh            # DRY RUN, prints every command. Exits 1 because of its last line; benign
vps$ sudo scripts/fleet-os-setup.sh --apply
```

What `--apply` does, in order (`scripts/fleet-os-setup.sh`):

| Step | Lines | Action |
|---|---|---|
| 1 | `:68-78` | Group `automaton-fleet-admin` and operator membership. Users `automaton-fleet-service`, `automaton-agent` (home 0700), `automaton-fleet-witness`, `automaton-fleet-operator-api`, each created with the exact `useradd` flags in 10 §12.1 |
| 2 | `:81-92` | `/etc/automaton-fleet` root:root 0755. `tls/` root:automaton-fleet-admin 0750 (refuses a symlink). Existing `fleet.key`/`fleet.crt` are re-permissioned to root:root 0600/0644 and must be single-link regular files |
| 3 | `:95-102` | `admin.env`: if it exists, only chown `root:automaton-fleet-admin` and chmod 0640 |
| 4 | `:105-113` | `service.env`: if absent, `svc_pw="$(openssl rand -hex 32)"; agent_pw="$(openssl rand -hex 32)"`, written through `put 0600 root:root` (mktemp → chmod → chown → mv). Holds `FLEET_SERVICE_DATABASE_URL=postgresql://fleet_service_login:<hex>@127.0.0.1:5432/automaton_fleet` and `FLEET_AGENT_DATABASE_URL=postgresql://fleet_agent_login:<hex>@…` |
| 4b | `:116-126` | `operator.env`: refuses a symlink. If absent, `op_pw="$(openssl rand -hex 32)"`, written 0640 root:automaton-fleet-operator-api with `FLEET_OPERATOR_DATABASE_URL=postgresql://fleet_operator_login:<hex>@127.0.0.1:5432/automaton_fleet` |
| 5 | `:129-133` | `runtime.env`: only if absent, a copy of the example |
| 6 | `:136-137` | `/opt/automaton-fleet/{releases,node,node/bin}` root 0755; `install -m 0755` of the operator's `node` |
| 7 | `:140-144` | Installs 4 units (fleet, agent, witness, operator-api) root 0644, then `daemon-reload`. **Nothing is enabled or started** |
| 7b | `:147` | `/etc/logrotate.d/automaton-fleet` root 0644 |
| 8 | `:150-155` | If the repo `.env.fleet` holds controller secrets, backs it up to `legacy-env-fleet.bak` (0600) and deletes those lines |

`DB_HOST`, `DB_PORT` and `DB_NAME` default to `127.0.0.1`, `5432` and `automaton_fleet`. Override with `FLEET_DB_HOST`, `FLEET_DB_PORT` and `FLEET_DB_NAME` (`:44-46`).

Check:

```bash
vps$ sudo stat -c '%U:%G %a %h %n' /etc/automaton-fleet /etc/automaton-fleet/* /etc/automaton-fleet/tls
# /etc/automaton-fleet root:root 755; admin.env root:automaton-fleet-admin 640; service.env root:root 600;
# operator.env root:automaton-fleet-operator-api 640 1; runtime.env root:root 644; tls root:automaton-fleet-admin 750
vps$ /opt/automaton-fleet/node/bin/node --version
vps$ systemctl is-enabled automaton-fleet.service automaton-agent.service automaton-fleet-witness.service automaton-fleet-operator-api.service   # all disabled
```

## 14.8 Step 7 — Database owner and database

The password is read from `admin.env` in a root shell and fed to psql on stdin (runbook `:524-537`):

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

## 14.9 Step 8 — Restricted roles (`fleet-db-setup.sh` + `fleet-db-roles.sql`)

```bash
vps$ sudo scripts/fleet-db-setup.sh            # dry run
vps$ sudo scripts/fleet-db-setup.sh --apply
```

Mechanics:
- `pw_of` extracts each password with ``sed -n "s#^$1=postgresql://[^:]*:\([0-9a-f]\{64\}\)@.*#\1#p"`` (`fleet-db-setup.sh:29-31`). **Passwords must be exactly 64 lowercase hex characters**, or it aborts (`:35-36`).
- It pipes `\set agent_password …`, `\set service_password …`, `\set operator_password …` and then `fleet-db-roles.sql` into `runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -v dbname=automaton_fleet -v owner=fleetadmin -d postgres -f -` (`:42-43`). Passwords never appear in argv.

Result (`scripts/fleet-db-roles.sql`):

| Role | Attributes | Member of | Connection limit | Timeouts in `automaton_fleet` (statement / lock / idle-in-tx) |
|---|---|---|---|---|
| `fleet_agent` | NOLOGIN NOINHERIT, no super/createdb/createrole/replication/bypassrls | — | — | — |
| `fleet_agent_login` | LOGIN INHERIT | `fleet_agent` only | 32 | 10s / 5s / 30s |
| `fleet_service` | NOLOGIN NOINHERIT | — | — | — |
| `fleet_service_login` | LOGIN INHERIT | `fleet_service` only | 16 | 15s / 5s / 30s |
| `fleet_operator` | NOLOGIN NOINHERIT | — | — | — |
| `fleet_operator_login` | LOGIN INHERIT | `fleet_operator` only | 8 | 5s / 2s / 10s |

Database ACL:
- `REVOKE ALL ON DATABASE automaton_fleet FROM PUBLIC` and from all six roles.
- `GRANT CONNECT` to the three logins.
- `GRANT CONNECT, TEMPORARY` to the owner.
- `REVOKE CREATE ON SCHEMA public FROM PUBLIC`.

Any other membership among these roles is revoked on every run (`:65-72`). The session sets `log_statement='none'`, `log_min_error_statement='panic'` and `log_min_duration_statement=-1`, so the `ALTER ROLE … PASSWORD` statements stay out of the server log (`:32-34`). Re-running the script re-sets the passwords to the file values; the files are the source of truth.

## 14.10 Step 9 — Registry contents

Choose **one** path.

### Path A — restore the latest production dump (production-equivalent)

This preserves registry history: events, approvals, principals and keys (public keys and hashes only), the cap and the mode. The latest recorded dump is `~ubuntu/automaton_fleet-v8-pre-chatgpt-20260925T005947Z.dump` (SHA-256 `4bd240fbd24d06acf05eb8f64603f4af1e762a7e8967dd4d4d5574b947212634`). It **predates** the `bridge-chatgpt` enrolment (event 112). A newer dump is needed for exact equivalence.
<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->

Take a dump on the source host (runbook stage 0 procedure):

```bash
src$ umask 077
src$ sudo -u postgres pg_dump -Fc -n fleet automaton_fleet > ~/automaton_fleet-v8-<ts>.dump
src$ sha256sum ~/automaton_fleet-v8-<ts>.dump > ~/automaton_fleet-v8-<ts>.dump.sha256
```

Restore it on the target:

```bash
vps$ chmod 0600 ~/automaton_fleet-v8-<ts>.dump && sha256sum -c ~/automaton_fleet-v8-<ts>.dump.sha256
vps$ sudo -u postgres pg_restore --exit-on-error --single-transaction --role=fleetadmin -d automaton_fleet < ~/automaton_fleet-v8-<ts>.dump
vps$ cd ~/automaton-fleet-build
vps$ pnpm fleet:migrate-check            # {"currentVersion":8,"resultingVersion":8,"wouldApply":[],"requiredVersion":8,"rolledBack":true}; exit 0
vps$ pnpm fleet:migrate                  # "Schema up to date." — re-grants agent/service/operator roles
vps$ pnpm fleet:admin grant-operator-role
vps$ pnpm fleet:audit-privileges         # PASS
vps$ pnpm fleet:admin health
```

Then compare row counts with the source (the runbook's row-count query, `:251-255`). The dump holds token, session and key **hashes and public keys only**; role passwords are not in it. Treat it as confidential: 0600, SSH transfer only, delete after verification.

### Path B — fresh registry

This creates a new, empty registry. Events restart, and principals must be re-enrolled with new keys.

```bash
vps$ cd ~/automaton-fleet-build
vps$ pnpm fleet:migrate-check            # {"currentVersion":null,"resultingVersion":8,"wouldApply":[1,2,3,4,5,6,7,8],"requiredVersion":8,"rolledBack":true}
vps$ pnpm fleet:migrate                  # applies v1..v8; grants agent/service/operator roles (they exist since step 8)
vps$ pnpm fleet:audit-privileges         # PASS
vps$ pnpm fleet:admin status | jq '.state | {maxAgents, operatingMode}'   # {maxAgents:1, operatingMode:"DEVELOPMENT"} (schema defaults)
```

`fleet_state` defaults: `max_agents DEFAULT 1 CHECK (1..FLEET_PG_HARD_MAX_AGENTS)`, `operating_mode DEFAULT 'DEVELOPMENT'` (`src/fleet/postgres/migrations.ts:35-37`).

## 14.11 Step 10 — Reproducible build and build-ID algorithm

### 14.11.1 Commands

Independent build from a fresh temporary clone. It prints the four pin lines:

```bash
vps$ cd ~/automaton-fleet-build
vps$ scripts/fleet-build-runtime.sh https://github.com/5l4mm3r/automaton-fleet.git 4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790
# FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
# FLEET_RUNTIME_COMMIT=4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790
# FLEET_RUNTIME_BUILD_ID=54beb10104a11888446ed1d09a85f236d87b977558a88514de7600d7dcc83ced
# FLEET_RUNTIME_LOCKFILE_SHA256=eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811
```

`fleet-build-runtime.sh`, step by step (`:11-32`):
1. The commit must match `^[0-9a-f]{40}$`.
2. `git init` in a `mktemp -d`, `remote add origin <url>`, `fetch --depth 1 origin <commit>`, `checkout --detach`.
3. Assert `HEAD == commit`, and that `pnpm-lock.yaml` exists.
4. `CI=true pnpm install --frozen-lockfile`, then `pnpm build` (`tsc && pnpm -r build`, `package.json:41`).
5. Assert `git status --porcelain --untracked-files=no` is empty.
6. Run the **tooling checkout's** `node --import tsx src/fleet/postgres/cli.ts build-identity <clone>` and print the four lines.

Staged build that is verified against `runtime.env` (as the operator, never root):

```bash
vps$ scripts/fleet-deploy-release.sh build
# … Verified build 54beb101… staged at ~/.cache/automaton-fleet/stage/4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790
```

`fleet-deploy-release.sh build`, step by step (`:39-60`):
1. Reads the pins from `runtime.env` and requires a 40-hex commit, 64-hex build id, 64-hex lockfile and an `https://` repo (`:24-31`).
2. Uses a fresh staging repo at `${XDG_CACHE_HOME:-$HOME/.cache}/automaton-fleet/stage/<commit>`.
3. `fetch --depth 1 origin <commit>`, or `git fetch <SOURCE> <commit>` with `--source`.
4. **Checks the lockfile hash before install**: `echo "$LOCK  pnpm-lock.yaml" | sha256sum -c --quiet -`.
5. Frozen install, build, clean-tree check.
6. Computes the identity with **the tree's own compiled CLI**: `node dist/fleet/postgres/cli.js build-identity .` (`:33-36`).
7. Any mismatch prints `BUILD MISMATCH` and exits 1. A mismatch is a **stop**: never edit the pins to make it pass (runbook `:615-616`).

### 14.11.2 Build-ID algorithm (exact, `src/fleet/attestation.ts:30-36`, `:101-142`)

```ts
export const BUILD_IDENTITY_FILES = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "constitution.md"];
export const BUILD_IDENTITY_DIRS  = ["dist", "src"];

files = []
for f of BUILD_IDENTITY_FILES:
    lstat(dir/f); missing → error only for package.json / pnpm-lock.yaml, else skip
    not a regular file → error
    files.push(f)
for d of BUILD_IDENTITY_DIRS:
    must exist and be a directory, else error
    walk d recursively: symlink → error; directory → recurse; regular file → push "d/…/name"; other types ignored
files.sort(by Buffer.compare of UTF-8 bytes)
h = sha256()
for f of files: h.update(`${f}\0${sha256hex(read(dir/f))}\n`)
buildId        = h.hex()
lockfileSha256 = sha256hex(read(dir/"pnpm-lock.yaml"))
```

Consequences:
- `docs/`, `scripts/`, `deploy/`, `node_modules/`, `packages/*` (including the workspace package build output) and `.git` are **not** covered. A docs-only commit keeps the build ID and changes only the commit (runbook `:117`, `:1210`).
- A symlink anywhere under `dist/` or `src/` makes the identity fail.
- The same algorithm is embedded as a standalone CommonJS verifier (`ATTEST_SCRIPT`, `attestation.ts:151-191`) for child sandboxes. A test keeps the two in lockstep.
- Repository comparison uses `normalizeRepoUrl` (`runtime.ts:42-53`): regex `^https:\/\/([a-z0-9.-]+(?::\d{1,5})?)\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$`, lowercased host, `.git` and trailing slash removed. So `…/automaton-fleet.git` and `…/automaton-fleet` compare equal (runbook `:153`). The upstream `conway-research/automaton` is refused (`runtime.ts:38`, `:55-60`).

## 14.12 Step 11 — Install the release

```bash
vps$ sudo scripts/fleet-deploy-release.sh install
vps$ readlink /opt/automaton-fleet/current      # releases/4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790
vps$ sudo find /opt/automaton-fleet ! -user root -print | head   # no output
```

`install`, step by step (`:61-77`):
1. Requires root and `$SUDO_USER`. The staging path is `<operator home>/.cache/automaton-fleet/stage/<commit>`.
2. Refuses if `releases/<commit>` exists: releases are immutable.
3. `cp -a` to `<dest>.tmp`, removes `.git`, `chown -R root:root`, `chmod -R go-w,u-w`, `chmod u+w <dest>.tmp`.
4. Re-verifies the identity with `PATH=/opt/automaton-fleet/node/bin:$PATH`. On mismatch it deletes the tmp tree and exits 1.
5. `chmod u-w`, `mv <dest>.tmp <dest>`, then `ln -sfn releases/<commit> current.tmp && mv -T current.tmp current` (atomic switch).
6. **It does not restart anything.** The running service keeps its old code in memory until a restart.

## 14.13 Step 12 — Approve and verify the runtime

```bash
vps$ pnpm fleet:admin approve-runtime      # Path B always; Path A only if the restored approval differs from runtime.env
vps$ pnpm fleet:verify-runtime /opt/automaton-fleet/current    # RUNTIME IDENTITY: VERIFIED
```

- `approve-runtime` validates `FLEET_RUNTIME_REPO`/`_COMMIT` (`validateRuntimePin`) and `_BUILD_ID`/`_LOCKFILE_SHA256` (64 hex), then writes the approval (`postgres/cli.ts:467-478`).
- The DB trigger `fleet_state_runtime_guard` refuses a change while any lease is open or any child is living (`FLEET.md:443`).
- `verify-runtime` compares the pins in `runtime.env`, the registry approval and the installed tree:
  - the tree's commit comes from its directory name when there is no `.git` (`runtime-verify.ts:63-65`);
  - any difference in repo, commit, build ID or lockfile exits 1.

## 14.14 Step 13 — systemd verification, loopback start, readiness

```bash
vps$ diff deploy/systemd/automaton-fleet.service /etc/systemd/system/automaton-fleet.service && echo unit matches repo
vps$ sudo systemd-analyze verify /etc/systemd/system/automaton-fleet.service
vps$ test ! -e /etc/systemd/system/automaton-fleet.service.d/remote.conf && echo "no remote drop-in yet (correct)"
vps$ sudo systemctl enable --now automaton-fleet.service
vps$ sudo journalctl -u automaton-fleet -n 100 --no-pager     # service_started; no startup_failed
vps$ curl -fsS http://127.0.0.1:8787/healthz
vps$ curl -sS -w '\nHTTP %{http_code}\n' http://127.0.0.1:8787/readyz | tail -3     # HTTP 200
vps$ sudo ss -Hltnp          # 8787, 5432, 6379 on loopback; 22 public; nothing on 80/443
vps$ sudo scripts/fleet-verify-deployment.sh        # every line [PASS]; exit 0
vps$ pnpm fleet:doctor --deployment-only            # DEPLOYMENT: OK
```

- `/readyz` checks the database, the agent API, the privilege audit (cached 60 s, `service/main.ts:269-275`), the release against the approved runtime, and reaper freshness.
- At this point `pnpm fleet:verify` must be blocked only by "HTTPS valid", "remote controller reachable" and, on Path B, "fleet cap = 2" (runbook `:686-689`).
- `pnpm fleet:doctor` without `--deployment-only` exits 1 by design while real replication is unsafe.
- The journal needs sudo: `ubuntu` is not in `adm` or `systemd-journal` (runbook `:145`).

Startup refusals (`service/main.ts:32-36`, `:194-253`):
- running as root, or as a user other than `automaton-fleet-service`;
- `FLEET_ADMIN_DATABASE_URL` is visible;
- the service DSN is the schema owner or a superuser;
- the agent DSN user is missing or equals the service user;
- the agent self-check or the privilege audit fails;
- the listen address is not loopback;
- the release differs from the approval.

## 14.15 Step 14 — DNS

At the registrar (Porkbun):
- delete any `api` CNAME or URL-forward;
- create `api.agentfleet.vip A 51.195.148.111`, TTL 600;
- **do not** create an AAAA;
- recommended: `agentfleet.vip CAA 0 issue "letsencrypt.org"`.

Wait at least 10 minutes after all four authoritative servers return the A record before step 15 (runbook `:732-733`). The verification commands are in 11 §13.4.

## 14.16 Step 15 — Certificate (HTTP-01 standalone)

Preconditions:
- DNS is green;
- ufw has nothing on 80 or 443;
- the OVH edge allows 80;
- nothing listens on :80.

Final production mechanism: port 80 is opened and closed by `/usr/local/sbin/fleet-certbot-port80` from renewal hooks, with three fail-safes. These files are **NOT IN REPOSITORY** (runbook `:102`). The repository-documented equivalent uses inline hooks:

```bash
vps$ sudo apt-get install -y certbot
vps$ sudo certbot certonly --standalone --preferred-challenges http \
       -d api.agentfleet.vip -m <ops-email> --agree-tos --no-eff-email \
       --key-type ecdsa --elliptic-curve secp256r1 \
       --pre-hook  "ufw allow 80/tcp comment 'certbot http-01 (temporary)'" \
       --post-hook "ufw delete allow 80/tcp" --dry-run          # S7b: staging
vps$ # same without --dry-run (S7c)
vps$ sudo certbot certificates
vps$ sudo ufw status | grep -w 80 || echo "port 80 closed again (correct)"
```

Install the deploy hook `/etc/letsencrypt/renewal-hooks/deploy/automaton-fleet.sh` (root 0755). Its exact text is in `docs/fleet-production-runbook.md:1303-1331`, and the recorded SHA-256 is `197dfe74…1a5f`.
<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->

## 14.17 Step 16 — TLS credential sources

```bash
vps$ L=/etc/letsencrypt/live/api.agentfleet.vip; T=/etc/automaton-fleet/tls
vps$ sudo install -m 0600 -o root -g root "$L/privkey.pem"   "$T/fleet.key"
vps$ sudo install -m 0644 -o root -g root "$L/fullchain.pem" "$T/fleet.crt"
vps$ sudo stat -c '%U:%G %a %h %F %n' "$T" "$T/fleet.key" "$T/fleet.crt"    # 750 dir; 600/644, 1 link, regular file
vps$ sudo bash -c 'cmp <(openssl pkey -in /etc/automaton-fleet/tls/fleet.key -pubout) <(openssl x509 -in /etc/automaton-fleet/tls/fleet.crt -noout -pubkey)' && echo "key matches certificate"
vps$ sudo scripts/fleet-verify-deployment.sh     # TLS section PASS
```

`install` follows the `live/` symlinks and writes new regular files.

## 14.18 Step 17 — Remote drop-in and `runtime.env` remote lines (safety-gated: `FLEET_REMOTE_LISTEN_ENABLED`)

```bash
vps$ sudo install -d -m 0755 -o root -g root /etc/systemd/system/automaton-fleet.service.d
vps$ sudo install -m 0644 -o root -g root deploy/systemd/automaton-fleet.service.d/remote.conf.example \
       /etc/systemd/system/automaton-fleet.service.d/remote.conf
vps$ sudo cp -p /etc/automaton-fleet/runtime.env /etc/automaton-fleet/runtime.env.pre-remote
vps$ sudoedit /etc/automaton-fleet/runtime.env
```

The edit changes `FLEET_REMOTE_LISTEN_ENABLED=false` to `true` and adds exactly these lines:

```
FLEET_REMOTE_LISTEN_ENABLED=true
FLEET_PUBLIC_HOSTNAME=api.agentfleet.vip
FLEET_PUBLIC_LISTEN=0.0.0.0:443
FLEET_PUBLIC_URL=https://api.agentfleet.vip
FLEET_TLS_CERT_FILE=/run/credentials/automaton-fleet.service/tls.crt
```

```bash
vps$ diff /etc/automaton-fleet/runtime.env.pre-remote /etc/automaton-fleet/runtime.env
vps$ sudo systemctl daemon-reload
vps$ systemctl cat automaton-fleet.service | grep -E 'LoadCredential|IPAddress|Capabilit'
```

## 14.19 Step 18 — Firewall: open 443

```bash
vps$ sudo deploy/firewall/fleet-firewall.sh           # dry run: prints the rules
vps$ sudo deploy/firewall/fleet-firewall.sh --apply   # deny-in default, allow 22 + 443, explicit deny 5432/6379/8787
vps$ sudo ufw status verbose
```

Mirror the rules at the provider edge (OVH: allow 22, 80, 443, ESTABLISHED, ICMP).

## 14.20 Step 19 — Restart and public validation

```bash
vps$ sudo systemctl restart automaton-fleet.service
vps$ sudo ss -Hltnp | grep -E ':(443|8787)\b'         # 0.0.0.0:443 and 127.0.0.1:8787, both node
vps$ curl -sS -w '\nHTTP %{http_code}\n' http://127.0.0.1:8787/readyz | tail -2   # 200
ws$  curl -fsS https://api.agentfleet.vip/healthz
ws$  curl -sS -o /dev/null -w '%{http_code}\n' https://api.agentfleet.vip/readyz                 # 404
ws$  curl -sS -o /dev/null -w '%{http_code}\n' -H 'Origin: https://evil.example' https://api.agentfleet.vip/healthz   # 403
ws$  curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://api.agentfleet.vip/v1/heartbeat   # 401
ws$  curl -sS --tlsv1.1 --tls-max 1.1 https://api.agentfleet.vip/healthz; echo "exit $?"       # non-zero
ws$  for p in 80 5432 6379 8787 8788; do nc -vz -w3 api.agentfleet.vip $p; done                  # all fail
ws$  nmap -Pn -p- 51.195.148.111                                                                # 22, 443 only
```

## 14.21 Step 20 — Doctor and verification

```bash
vps$ pnpm fleet:doctor --deployment-only     # DEPLOYMENT: OK
vps$ pnpm fleet:verify                        # 16 checklist items; Path A: 16/16 PASS, SAFE FOR DRY RUN: YES
vps$ sudo scripts/fleet-verify-deployment.sh  # all PASS incl. "remote drop-in maps exactly tls.key and tls.crt"
```

The 16 checklist items (`doctor.ts:461-534`), in order:
1. PostgreSQL roles correct
2. schema v8
3. controller service active
4. privileged secrets protected
5. runtime repo pinned
6. runtime commit pinned
7. build ID pinned
8. HTTPS valid
9. remote controller reachable
10. replay protection working
11. agent credentials scoped
12. payments disabled
13. owner sweeps disabled
14. fleet cap = 2
15. no unresolved orphan
16. no stuck reservation

Recommended soak before any cap change: 24 h (runbook `:932-937`).

## 14.22 Step 21 — Cap 1 → 2 (Path B only; safety-gated: fleet cap)

```bash
vps$ pnpm fleet:admin set-cap 2
vps$ pnpm fleet:verify        # SAFE FOR DRY RUN: YES
```

Production did this at 2026-09-24 18:45:13 UTC (event 26, `cap_set {"previous":1,"max":2}`). On Path A the restored registry already has cap 2.

## 14.23 Step 22 — Operator API (schema v8, B2-9 … B2-12 and closeout)

`operator.env` and the roles already exist from steps 6 and 8.

```bash
vps$ pnpm fleet:admin grant-operator-role          # EXECUTE on the 8 op_* functions; no tables
vps$ pnpm fleet:audit-privileges                   # PASS, operator roles provisioned
vps$ sudo scripts/fleet-verify-deployment.sh       # Operator API isolation section PASS
vps$ sudo systemctl start automaton-fleet-operator-api.service
vps$ curl -sS http://127.0.0.1:8788/readyz     # 503, state "disabled" (kill switch off); Host must match ^(127\.0\.0\.1|localhost|\[::1\])(:port)?$ else 421
vps$ sudo ss -Hltnp | grep 8788                    # 127.0.0.1:8788 only
vps$ sudo stat -c '%U %a %n' /var/log/automaton-fleet-operator /var/log/automaton-fleet-operator/audit.jsonl   # 700 / 600
```

Enrolment and enablement:
- **Path A:** the principals and keys are already in the restored registry. Check `pnpm fleet:admin operator-list`, then enable if the kill switch is off.
- **Path B:** enrol new keys (step 24 and step 25), then enable:

```bash
vps$ pnpm fleet:admin operator-api enable "<reason>"        # /readyz → 200 "ready"; no restart needed
vps$ sudo systemctl enable automaton-fleet-operator-api.service     # boot persistence (B2 closeout)
```

Startup refusals (`operator/main.ts:6-16`):
- running as root or the wrong user;
- a forbidden environment variable is present, or `admin.env`, `service.env` or the TLS key is readable;
- no DSN;
- a non-loopback listen address;
- any safety switch is true, including `FLEET_DRY_RUN_CHILD`;
- incomplete pins, or pins that differ from the approval;
- the login is the owner, a superuser, not `fleet_operator_login`, or a member of anything but `fleet_operator`;
- the schema is not v8;
- the operator privilege audit fails.

Audit capacity:
- the request table is capped at 2,000,000 rows;
- the doctor warns at 50% and 75% and fails at 100%, where requests fail closed with `FLEET_OP_AUDIT_FULL`;
- the only removal path is `fleet:admin operator-archive --before <ts> --out <new file> [--max-rows N]` (≤100,000 rows per call, verified before deleting). It needs its own approval (runbook `:1156-1165`).

## 14.24 Step 23 — Restricted SSH tunnel account `fleet-op-tunnel`

**NOT IN REPOSITORY.** No script creates it. The commands below are reconstructed from the recorded end state (runbook `:1191`, design `phase-b-operator-api.md:348-354`). They are **not** the archived production commands.

```bash
vps$ sudo useradd --system --user-group --home-dir /var/lib/fleet-op-tunnel --create-home --shell /usr/sbin/nologin \
       --comment "Automaton fleet operator tunnel" fleet-op-tunnel
vps$ sudo passwd -l fleet-op-tunnel
vps$ sudo install -d -m 0755 -o root -g root /var/lib/fleet-op-tunnel/.ssh
vps$ printf 'restrict,port-forwarding,permitopen="127.0.0.1:8788",command="/usr/sbin/nologin" %s\n' "<contents of dev VM ~/.ssh/fleet_op_tunnel.pub>" \
       | sudo install -m 0644 -o root -g root /dev/stdin /var/lib/fleet-op-tunnel/.ssh/authorized_keys
vps$ sudo install -m 0644 -o root -g root /dev/stdin /etc/ssh/sshd_config.d/70-fleet-op-tunnel.conf <<'EOF'
Match User fleet-op-tunnel
    AllowTcpForwarding local
    PermitOpen 127.0.0.1:8788
    AllowStreamLocalForwarding no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTunnel no
    PermitTTY no
    ForceCommand /usr/sbin/nologin
    AuthenticationMethods publickey
Match all
EOF
vps$ sudo sshd -t && sudo sshd -T -C user=fleet-op-tunnel,host=x,addr=127.0.0.1 | grep -Ei 'permitopen|allowtcpforwarding|forcecommand|permittty'
vps$ sudo sshd -T -C user=ubuntu,host=x,addr=127.0.0.1 > /tmp/after; # compare with a pre-change capture: no change for other users
vps$ sudo systemctl reload ssh
```

The `Match` block contents above are a **reconstruction**. The recorded fact is only "a per-user `Match` block ending in `Match all`". The production text must be archived from the host.
<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->

Expected behaviour (recorded):
- `-L`/`-W` to `127.0.0.1:8788` work.
- Every other destination, `-R`, Unix-socket forwards, tun, shell, command, PTY, X11, sftp and scp are refused.

## 14.25 Step 24 — Claude bridge (dev VM)

```bash
dev$ install -d -m 0700 ~/.config/automaton-fleet/operator
dev$ pnpm fleet:operator-keygen ~/.config/automaton-fleet/operator/bridge-claude.key   # prints ONLY publicKey + keyId
dev$ ssh-keygen -t ed25519 -f ~/.ssh/fleet_op_tunnel -N '' -C fleet-op-tunnel         # transport key (not a signing key)
vps$ pnpm fleet:admin operator-enroll bridge-claude bridge_claude \
       --scopes ops.read.status,ops.read.agents,ops.read.events --public-key <publicKey> --expires-days 30
       # verify the key id out of band (keygen output == enrol output)
dev$ pnpm fleet:bridge init --principal <op_…> \
       --key-file ~/.config/automaton-fleet/operator/bridge-claude.key \
       --ssh-host 51.195.148.111 --ssh-identity ~/.ssh/fleet_op_tunnel \
       --host-key-fingerprint SHA256:HUuqOfrwidWq3SagFJD3rEavFX29u89cy1vIqun0tRg \
       --from-known-hosts ~/.ssh/known_hosts
dev$ pnpm fleet:bridge doctor
dev$ pnpm fleet:bridge whoami && pnpm fleet:bridge status
dev$ claude mcp add --scope local fleet-operator -- <absolute node> <absolute tsx> <absolute src/fleet/bridge/mcp.ts> --config ~/.config/automaton-fleet/operator/bridge-claude.json
```

- `--expires-days` must be an integer 1..90 (`postgres/cli.ts:193-197`).
- Production key: `ec4f06982ae9135fd2b28e928f5a4a61`, expires 2026-10-24. Rotate it before then: `key rotate-prepare` → (VPS) `operator-add-key` → `key rotate-verify` → `key rotate-switch` → (VPS) `operator-revoke-key` → `key rotate-finish` (runbook `:1261-1265`).
- The exact `claude mcp add` argument vector is not archived in the repository.
<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->

## 14.26 Step 25 — ChatGPT adapter and tunnel (Phase C)

```bash
# 1. Separate pinned artifact (as the operator, then root)
vps$ scripts/fleet-deploy-chatgpt-adapter.sh build 6691b4c9db9d5dedb246d4e984b495f7c4cf0251 62336fee32671ea04de3bb18c1552273cd80bc02c1d2bd5f219f1dee3b018057 eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811
vps$ sudo scripts/fleet-deploy-chatgpt-adapter.sh install 6691b4c9db9d5dedb246d4e984b495f7c4cf0251
vps$ readlink /opt/automaton-fleet/chatgpt-adapter/current; cat /opt/automaton-fleet/chatgpt-adapter/pins.env

# 2. Verified tunnel-client zip, obtained from OpenAI's tunnel-client release v0.0.14 and checked against its SHA256SUMS.txt
vps$ sha256sum tunnel-client-*.zip         # 29d29cf860ada54e4d3c82c715f4fbfcff2abcdc2584c0fc26431308dfa2505b
vps$ sudo scripts/fleet-chatgpt-setup.sh prepare --tunnel-client-zip <zip>            # dry run
vps$ sudo scripts/fleet-chatgpt-setup.sh prepare --tunnel-client-zip <zip> --apply    # prints PUBLIC key + key id only

# 3. Enrol (admin credential)
vps$ pnpm fleet:admin operator-enroll bridge-chatgpt bridge_chatgpt \
       --scopes ops.read.status,ops.read.agents --public-key <publicKey> --expires-days 30

# 4. Configure and start the adapter; the tunnel stays off
vps$ sudo scripts/fleet-chatgpt-setup.sh configure <op_… principal id> --apply

# 5. Tunnel id (non-secret; not created by any script)
vps$ printf 'CONTROL_PLANE_TUNNEL_ID=%s\n' tunnel_6ab5cd2c7b088191abe137e56b5f35e4 \
       | sudo install -m 0644 -o root -g root /dev/stdin /etc/automaton-fleet/chatgpt-tunnel/tunnel.env
       # (mode chosen here: production owner/mode not recorded; the directory itself is root 0700)

# 6. OWNER ONLY, in the owner's own terminal on the VPS (never through an AI session):
vps$ sudo fleet-chatgpt-tunnel-key
```

- The adapter must run from `/opt/automaton-fleet/chatgpt-adapter/current`. It never changes `/opt/automaton-fleet/current` or `runtime.env` (`fleet-deploy-chatgpt-adapter.sh:7-13`).
- The `REPO_URL` for the adapter build is hard-coded to `https://github.com/5l4mm3r/automaton-fleet.git` (`:17`).
- `prepare --apply` (`fleet-chatgpt-setup.sh:48-111`):
  - verifies the zip SHA-256 and the adapter tree;
  - creates both users;
  - creates `chatgpt-tunnel/` (root 0700) and `/var/lib/automaton-fleet-chatgpt-adapter` (0700);
  - installs tunnel-client (it checks the binary SHA-256);
  - generates the adapter token (`head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'`, root 0600);
  - generates the `bridge-chatgpt` key **as the adapter user** (`runuser -u automaton-fleet-chatgpt-adapter -- node …/keygen.js …`);
  - installs the four units and `/usr/local/sbin/fleet-chatgpt-tunnel-key`, then `daemon-reload`.
- `configure --apply` (`:113-133`):
  - validates `^op_[0-9A-HJKMNP-TV-Z]{26}$`;
  - derives the key id (`^[0-9a-f]{32}$`) and the token SHA-256;
  - writes `chatgpt-adapter.json` (root:adapter 0640);
  - `enable --now` on the socket and the adapter, `enable` on the tunnel service, `enable --now` on the `.path` unit.
- The ChatGPT side (owner, design `phase-c-chatgpt-adapter.md:227-232`): Developer mode on; Plugins → + → Connection **Tunnel** → `tunnel_6ab5…` → **No authentication**.

## 14.27 Secret inventory: creation and rotation

| Secret | Location | Generated by | Rotation procedure | Consumers to restart |
|---|---|---|---|---|
| `fleetadmin` password | `admin.env` | `openssl rand -hex 32` in a root shell (14.7.1) | Write a new `admin.env` atomically (same snippet without the exists-guard), then re-run the 14.8 SQL (it re-sets the password from the file) | none (CLI only) |
| `fleet_service_login`, `fleet_agent_login` passwords | `service.env` | `fleet-os-setup.sh:108` (`openssl rand -hex 32`) | Replace `service.env` atomically, root:root 0600, with new 64-hex values; `sudo scripts/fleet-db-setup.sh --apply` | `automaton-fleet.service` (LoadCredential copies at start) |
| `fleet_operator_login` password | `operator.env` | `fleet-os-setup.sh:121` | Replace `operator.env` atomically, root:automaton-fleet-operator-api 0640; `fleet-db-setup.sh --apply` | `automaton-fleet-operator-api.service` |
| TLS private key | `tls/fleet.key` (+ `/etc/letsencrypt`) | certbot | Renewal + deploy hook (11 §13.5.3) | controller (the hook restarts it) |
| `bridge-claude` signing key | dev VM `~/.config/automaton-fleet/operator/bridge-claude.key` | `fleet:operator-keygen` | `fleet:bridge key rotate-*` + `operator-add-key` / `operator-revoke-key` | none |
| `bridge-chatgpt` signing key | `/var/lib/automaton-fleet-chatgpt-adapter/bridge-chatgpt.key` | `keygen.js` as the adapter user | **No scripted rotation (NOT IMPLEMENTED).** Manual: generate a new key as the adapter user, `operator-add-key`, update `keyFile`/`keyId` in `chatgpt-adapter.json`, restart the adapter, `operator-revoke-key` the old one | adapter |
| Adapter token | `chatgpt-tunnel/adapter-token` | `fleet-chatgpt-setup.sh:76-86` | Delete it and re-run `prepare --apply` (regenerates only when absent), then `configure --apply` (new `tunnelTokenSha256`), then restart the adapter and the tunnel. No dedicated script | adapter, tunnel |
| OpenAI runtime key | `chatgpt-tunnel/openai-api-key` | owner (OpenAI Platform) | `sudo fleet-chatgpt-tunnel-key` (verifies with OpenAI and rolls back on failure) | tunnel (the helper restarts it) |
| SSH tunnel transport key | dev VM `~/.ssh/fleet_op_tunnel` | `ssh-keygen` | Replace the line in `/var/lib/fleet-op-tunnel/.ssh/authorized_keys` | none |
| Witness credential | `/var/lib/automaton-fleet-witness/fleet-credentials.json` | `fleet:admin enroll-witness-root` (not issued yet) | `mark-dead` + re-enrol | witness |

Rules:
- Never paste a secret into argv, `Environment=`, a repository file or shell history.
- Where one must be typed, use `read -rs` or the TTY helper.
- The local VM's secrets are never copied to the VPS (runbook `:188-214`).

## 14.28 Rollback matrix

| Change | Rollback | Destructive? |
|---|---|---|
| Release switch (no schema change) | `sudo ln -sfn releases/<prev> /opt/automaton-fleet/current.tmp && sudo mv -T /opt/automaton-fleet/current.tmp /opt/automaton-fleet/current`; restore the matching `runtime.env.pre-*`; `approve-runtime`; restart the controller and the Operator API | no |
| Remote listener (steps 17–19) | `sudo ufw delete allow 443/tcp`; `sudo rm /etc/systemd/system/automaton-fleet.service.d/remote.conf`; `sudo mv runtime.env.pre-remote runtime.env`; `daemon-reload`; restart | no |
| Cap 2 → 1 | `pnpm fleet:admin set-cap 1` (possible while at most one slot is in use) | no |
| Operator API | `operator-api disable` (no restart), or `operator-revoke-all` (also turns the kill switch off); `systemctl disable --now automaton-fleet-operator-api` | no |
| ChatGPT adapter | `systemctl disable --now automaton-fleet-chatgpt-tunnel.path automaton-fleet-chatgpt-tunnel.service automaton-fleet-chatgpt-adapter.service automaton-fleet-chatgpt-adapter.socket`; `fleet:admin operator-revoke op_01M3B18TXVP33S6NQC909DXD57`; optionally remove `/opt/automaton-fleet/{chatgpt-adapter,tunnel-client}`, the units and the two users (runbook `:1232-1235`) | no |
| **v8 → v7** | Needs the **pre-v8 dump** `~ubuntu/automaton_fleet-v7-pre-v8.dump` (SHA-256 `e76f50c9b22193b061048ee005448aa25f810d18167e8380642cde01418b96dd`, 459277 bytes, 0600). The v8 build refuses a v7 registry and the reverse (runbook `:1145-1147`, `:1198`) | **yes** |
| v7 → v6 | Pre-v7 dump `~ubuntu/automaton_fleet-v6-pre-v7.dump` (SHA-256 `ccde45b5d05bf0973cb35b2b56a0275c59d8b993df104f6d8cd70c3c0c069e10`) + `releases/11c0c7c…` + `runtime.env.pre-witness` | **yes** |
| Full cutover | Runbook `:1386-1395` (disable the VPS controller, remove DNS, move the registry back, re-enable the local controller) | yes |

v8 → v7 procedure, derived from the runbook's rollback shape. It is not scripted and needs its own approval.
1. Stop `automaton-fleet-chatgpt-*` (tunnel, adapter, socket), `automaton-fleet-operator-api` and `automaton-fleet`. The v7 schema has no `op_*` functions, and the Operator API refuses any schema other than v8.
2. Take a fresh v8 dump first (stage 0 procedure).
3. Drop and recreate `automaton_fleet` (14.8), re-run `fleet-db-setup.sh --apply`, then `pg_restore --exit-on-error --single-transaction --role=fleetadmin` of the pre-v8 dump.
4. Point `current` at `releases/03f8760…` (the release running on v7 immediately before B2). Restore `runtime.env.pre-b2` (recorded `ce306628…`, B0 pins `03f8760`/`955698a6…`). Move the tooling checkout to `03f8760`.
5. Run `pnpm fleet:migrate-check` (v7, nothing pending), `fleet:audit-privileges` and `fleet:verify-runtime`. The restored registry approves `03f8760`.
6. Start `automaton-fleet`; check `/readyz`, doctor and verify.

The operator roles (cluster-global) survive the restore. The `03f8760` privilege audit predates the operator roles.
<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->
(Needed: presence and SHA-256 of each rollback release directory, each `runtime.env.pre-*` and each dump.)

## 14.29 Where production history differs from the runbook's steps (final reality)

| Runbook step | What production actually has |
|---|---|
| Stage 2 `10-fleet-hardening.conf` | `10-fleet-no-passwords.conf` (B2 closeout). Password auth was effectively **on** until 2026-09-24 ~23:55 UTC (runbook `:66`) |
| Stages 3–6, 10–11 by the scripts | Done **by hand**, then the scripts were run over the result to make it consistent (runbook `:140`). Drift corrected by `fleet-db-setup.sh`: PUBLIC had CONNECT/TEMP; `fleet_agent`/`fleet_service` were INHERIT; the logins had no timeouts (runbook `:82`) |
| Stage 4 Node v22.23.2 tarball | Node v22.23.3 from apt (accepted) |
| Stage 6 `~/automaton-fleet` | `~ubuntu/automaton-fleet-build` |
| Stage 7 "install both systemd units" | `fleet-os-setup.sh` now installs 4 units plus logrotate |
| Stage 9 restore of a v6 dump | Done at stage 0 from the frozen local registry. Then migrated live v6 → v7 (S9b, 20:00:47 UTC) → v8 (B2-7, 23:33:26 UTC) |
| Runtime pin `11c0c7c` | `11c0c7c` → `cdfd70c` (S9b) → `03f8760` (B0) → `5a5469e` (B2-6, never run) → `4d6a0be` (B2-7 fix) |
| **B0 stage** | **DRIFT:** the runbook has no B0 section. Per operator records: build `955698a66bf777d8c4bc2ccbdfd37d882bfd733e90dd33e568f079a6c729ae12` (900 files), `runtime.env.pre-b0` = `447b5929…`, outage 21:56:43Z → 21:57:38Z, the historical audit file renamed to `audit.jsonl.pre-b0-20260924T215651Z`, verified by a synthetic canary |
| Stage 15 inline `--pre-hook/--post-hook` | `fleet-certbot-port80` helper + named hooks + 3 fail-safes (NOT IN REPOSITORY) |
| Stage B2-10 "unit installed not enabled" | Enabled for boot at the B2 closeout |
| Phase C owner action "`systemctl start` the tunnel" | `sudo fleet-chatgpt-tunnel-key` + the `.path` unit (`d22f517`, `e49d287`, `aed747e`, `efad214`) |
| Runbook open item "JSONL audit without scrubDetail" | Fixed in `03f8760` (`log.ts:40-47`, `redactAuditRecord`) |
| `FLEET.md` "Current deployment state (2026-09-24)" | **DRIFT:** stale. It says `11c0c7c`, v6, cap 1, local VM controller. `CLAUDE.md` and the runbook "State after B2" / Stage C are current |
