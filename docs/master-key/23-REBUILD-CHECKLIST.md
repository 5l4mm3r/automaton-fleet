# 23 — Deterministic rebuild checklist (PART 25)

> Master-Key archive, reconstruction grade. Repository HEAD `efad214` (branch `fleet-development`).
> This is the tick-box companion to `12-DEPLOYMENT-RECONSTRUCTION.md`, which has the full commands and reasoning. Each phase lists its **commands** and **pass criteria**. A phase passes only when every criterion holds. **A failure is a stop, never something to fix by editing pins, flags or tests.**
> No secret values appear. Secrets are generated on the target host and verified by metadata (owner, mode, link count), never by content.
> Every `sudo`, `systemctl`, DNS, firewall, database-write and safety-flag step needs explicit operator approval (`CLAUDE.md`).

Pinned identities used throughout:

| Name | Value |
|---|---|
| `REPO` | `https://github.com/5l4mm3r/automaton-fleet.git` |
| `COMMIT` | `4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790` |
| `BUILD` | `54beb10104a11888446ed1d09a85f236d87b977558a88514de7600d7dcc83ced` |
| `LOCK` | `eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811` |
| `ADAPTER_COMMIT` | `6691b4c9db9d5dedb246d4e984b495f7c4cf0251` |
| `ADAPTER_BUILD` | `62336fee32671ea04de3bb18c1552273cd80bc02c1d2bd5f219f1dee3b018057` |
| `TC_ZIP` / `TC_BIN` | `29d29cf860ada54e4d3c82c715f4fbfcff2abcdc2584c0fc26431308dfa2505b` / `94ae9d0c024753d1b79669152e968eb5d0faaad1e04ccf6c37750d7a3e175c77` |
| Schema | v8 (`FLEET_PG_SCHEMA_VERSION = 8`, `src/fleet/postgres/migrations.ts:20`) |

Recommended shell setup for the checklist (all values non-secret):

```bash
vps$ export REPO=https://github.com/5l4mm3r/automaton-fleet.git COMMIT=4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790 \
            BUILD=54beb10104a11888446ed1d09a85f236d87b977558a88514de7600d7dcc83ced \
            LOCK=eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811
```

---

## Phase 1 — CLEAN UBUNTU

| # | Command | Pass criterion |
|---|---|---|
| 1.1 | `lsb_release -ds; uname -m; systemd --version \| head -1` | `Ubuntu 24.04.x LTS`, `x86_64`, systemd ≥ 255 |
| 1.2 | `sudo apt update && sudo apt full-upgrade -y && sudo apt install -y unattended-upgrades ufw curl ca-certificates gnupg xz-utils git openssl jq` | exit 0 |
| 1.3 | `sudo timedatectl set-timezone Etc/UTC; timedatectl show -p NTPSynchronized --value` | `yes` |
| 1.4 | `test -e /run/systemd/timesync/synchronized && echo ok` | `ok` (the Operator API readiness requires it) |
| 1.5 | `grep -R "Automatic-Reboot " /etc/apt/apt.conf.d/` | `false` or absent (the default is false) |
| 1.6 | SSH: install `/etc/ssh/sshd_config.d/10-fleet-no-passwords.conf` (12 §14.3); `sudo sshd -t && sudo systemctl reload ssh` | `sudo sshd -T` shows `passwordauthentication no` and `kbdinteractiveauthentication no`; a **new** key login + `sudo -v` work from a second session |
| 1.7 | `sudo ufw default deny incoming; sudo ufw default allow outgoing; sudo ufw allow 22/tcp comment 'operator SSH'; sudo ufw --force enable` | `ufw status verbose`: default `deny (incoming), allow (outgoing)`, only 22/tcp allowed; `grep ^IPV6= /etc/default/ufw` → `IPV6=yes` |
| 1.8 | Provider edge firewall (OVH, IPv4) | allow TCP 22, 80, 443 + ESTABLISHED + ICMP; deny the rest |
| 1.9 | `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` | On a **rebuilt** host the fingerprint differs from `SHA256:HUuqOfrwidWq3SagFJD3rEavFX29u89cy1vIqun0tRg`. Record the new one: the bridge pin (Phase 12) must then be re-initialised |

## Phase 2 — SOURCE CHECKOUT

| # | Command | Pass criterion |
|---|---|---|
| 2.1 | `git clone "$REPO" ~/automaton-fleet-build && cd ~/automaton-fleet-build && git checkout --detach "$COMMIT"` | exit 0 |
| 2.2 | `test "$(git rev-parse HEAD)" = "$COMMIT" && echo HEAD OK` | `HEAD OK` |
| 2.3 | `echo "$LOCK  pnpm-lock.yaml" \| sha256sum -c -` | `pnpm-lock.yaml: OK` |
| 2.4 | `git status --porcelain --untracked-files=no` | empty |
| 2.5 | `test ! -e .env.fleet && echo ok` | `ok`: no repository secrets on the host |
| 2.6 | `git log -1 --format=%H origin/fleet-development 2>/dev/null; git branch -r --contains "$COMMIT"` | `$COMMIT` is on the published `fleet-development` branch of the fork |

## Phase 3 — DEPENDENCIES

| # | Command | Pass criterion |
|---|---|---|
| 3.1 | Node: apt `nodejs`, or the verified v22.23.2 tarball (12 §14.4) | `node --version` → `v22.x` (production `v22.23.3`) |
| 3.2 | `sudo corepack enable pnpm; cd ~/automaton-fleet-build && pnpm --version` | `10.28.1` (from `packageManager`) |
| 3.3 | `CI=true pnpm install --frozen-lockfile` | exit 0; `git status --porcelain --untracked-files=no` still empty |
| 3.4 | `sudo apt install -y postgresql redis-server; psql --version; redis-server --version` | PostgreSQL 16.x; Redis 7.x |
| 3.5 | `sudo -u postgres psql -XAt -c 'SHOW listen_addresses; SHOW password_encryption;'` | `localhost` / `scram-sha-256` |
| 3.6 | `sudo grep -Ev '^\s*(#\|$)' /etc/postgresql/16/main/pg_hba.conf` | only `local … peer` and `host … 127.0.0.1/32` / `::1/128` `scram-sha-256` lines |
| 3.7 | `sudo grep -Ev '^\s*(#\|$)' /etc/redis/redis.conf \| grep -E '^(bind\|protected-mode\|port) '` | `bind 127.0.0.1 -::1`, `protected-mode yes`, `port 6379` |
| 3.8 | `sudo ss -Hltn \| grep -E ':(5432\|6379)\b'` | loopback addresses only |

## Phase 4 — DATABASE (OS secrets, owner, restricted roles)

| # | Command | Pass criterion |
|---|---|---|
| 4.1 | `sudo groupadd --system automaton-fleet-admin; sudo usermod -aG automaton-fleet-admin "$USER"`, then log out and in | `id -nG` contains `automaton-fleet-admin` |
| 4.2 | Create `admin.env` with the root-shell snippet (12 §14.7.1; `openssl rand -hex 32`, never printed) | `sudo stat -c '%U:%G %a %h' /etc/automaton-fleet/admin.env` → `root:automaton-fleet-admin 640 1` |
| 4.3 | Create `runtime.env`, loopback form (12 §14.7.2) | `stat` → `root:root 644`; `grep -Ev '^\s*(#\|$)' /etc/automaton-fleet/runtime.env \| sort` equals the 11 expected lines; `REAL_*`, `OWNER_SWEEP_ENABLED`, `FLEET_DRY_RUN_CHILD` and `FLEET_REMOTE_LISTEN_ENABLED` all `false` |
| 4.4 | `sudo scripts/fleet-os-setup.sh` (dry run; exits 1, benign), then `sudo scripts/fleet-os-setup.sh --apply` | exit 0 on apply |
| 4.5 | `sudo stat -c '%U:%G %a %h %n' /etc/automaton-fleet /etc/automaton-fleet/{admin,service,operator,runtime}.env /etc/automaton-fleet/tls` | `root:root 755`; `root:automaton-fleet-admin 640 1`; `root:root 600 1`; `root:automaton-fleet-operator-api 640 1`; `root:root 644 1`; `tls` `root:automaton-fleet-admin 750` |
| 4.6 | `for u in automaton-fleet-service automaton-agent automaton-fleet-witness automaton-fleet-operator-api; do getent passwd $u; id -nG $u; done` | shell `/usr/sbin/nologin` for all four; `id -nG` = only the user's own group; `automaton-agent` home `/home/automaton-agent` (0700) |
| 4.7 | `sudo grep -cE '^FLEET_(SERVICE\|AGENT)_DATABASE_URL=postgresql://fleet_(service\|agent)_login:[0-9a-f]{64}@127\.0\.0\.1:5432/automaton_fleet$' /etc/automaton-fleet/service.env` | `2`. Counts only; nothing is printed |
| 4.8 | `sudo grep -cE '^FLEET_OPERATOR_DATABASE_URL=postgresql://fleet_operator_login:[0-9a-f]{64}@127\.0\.0\.1:5432/automaton_fleet$' /etc/automaton-fleet/operator.env` | `1` |
| 4.9 | Owner role + database, root-shell SQL (12 §14.8) | `sudo -u postgres psql -XAt -c "SELECT rolname, rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname='fleetadmin'"` → `fleetadmin\|f\|f\|f`; the database `automaton_fleet` is owned by `fleetadmin` |
| 4.10 | `sudo scripts/fleet-db-setup.sh`, then `--apply` | exit 0; prints "Roles applied." |
| 4.11 | `sudo -u postgres psql -XAt -c "SELECT rolname, rolcanlogin, rolinherit, rolconnlimit FROM pg_roles WHERE rolname LIKE 'fleet\_%' ORDER BY 1"` | `fleet_agent\|f\|f\|-1`, `fleet_agent_login\|t\|t\|32`, `fleet_operator\|f\|f\|-1`, `fleet_operator_login\|t\|t\|8`, `fleet_service\|f\|f\|-1`, `fleet_service_login\|t\|t\|16` |
| 4.12 | `sudo -u postgres psql -XAt -d automaton_fleet -c "SELECT r.rolname, s.setconfig FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole ORDER BY 1"` | agent `{statement_timeout=10s,lock_timeout=5s,idle_in_transaction_session_timeout=30s}`; operator `{5s,2s,10s}`; service `{15s,5s,30s}` |
| 4.13 | `sudo -u postgres psql -XAt -c "SELECT datacl FROM pg_database WHERE datname='automaton_fleet'"` | CONNECT only for the three logins; CONNECT+TEMP for `fleetadmin`; nothing for PUBLIC |

## Phase 5 — MIGRATIONS / REGISTRY

Choose Path A (restore the latest production dump) **or** Path B (fresh). See 12 §14.10.

| # | Command | Pass criterion |
|---|---|---|
| 5.A1 | `sha256sum -c <dump>.sha256` | `OK` |
| 5.A2 | `sudo -u postgres pg_restore --exit-on-error --single-transaction --role=fleetadmin -d automaton_fleet < <dump>` | exit 0 |
| 5.A3 | Row-count query (runbook `:251-255`), `diff` against the source host's counts | identical |
| 5.B1 | `pnpm fleet:migrate-check` (fresh) | `"wouldApply":[1,2,3,4,5,6,7,8]`, `"resultingVersion":8`, `"rolledBack":true`; exit 0 |
| 5.2 | `pnpm fleet:migrate` | Path A: `Schema up to date.`; Path B: `Applied migrations: 1, 2, 3, 4, 5, 6, 7, 8`; then a health JSON with `schemaVersion` 8 |
| 5.3 | `pnpm fleet:migrate-check` | `{"currentVersion":8,"resultingVersion":8,"wouldApply":[],"requiredVersion":8,"rolledBack":true}` |
| 5.4 | `pnpm fleet:admin grant-operator-role` | exit 0 |
| 5.5 | `pnpm fleet:audit-privileges` | PASS, with operator roles **provisioned** |
| 5.6 | `pnpm fleet:admin status \| jq '.state \| {maxAgents, operatingMode, livingAgents, reservedSlots, quarantinedSlots, replicationEnabled}'` | Path A: `maxAgents 2`, `DEVELOPMENT`, zeros, replication `false`. Path B: `maxAgents 1` until Phase 10 step 10.12 |

## Phase 6 — BUILD

| # | Command | Pass criterion |
|---|---|---|
| 6.1 | `scripts/fleet-build-runtime.sh "$REPO" "$COMMIT"` (as the operator, not root) | the four printed lines equal `REPO`/`COMMIT`/`BUILD`/`LOCK` exactly |
| 6.2 | `scripts/fleet-deploy-release.sh build` | last line `Verified build $BUILD staged at …/stage/$COMMIT`; no `BUILD MISMATCH` |
| 6.3 | `node ~/.cache/automaton-fleet/stage/$COMMIT/dist/fleet/postgres/cli.js build-identity ~/.cache/automaton-fleet/stage/$COMMIT \| jq -r '.buildId, .lockfileSha256'` (run from the stage dir) | `$BUILD`, `$LOCK` |

On a mismatch, stop. Compare the Node and pnpm versions and the lockfile. Never edit pins.

## Phase 7 — RELEASE

| # | Command | Pass criterion |
|---|---|---|
| 7.1 | `sudo scripts/fleet-deploy-release.sh install` | `Installed release $COMMIT (build $BUILD)` |
| 7.2 | `readlink /opt/automaton-fleet/current` | `releases/$COMMIT` |
| 7.3 | `sudo find /opt/automaton-fleet ! -user root -print \| head` | no output |
| 7.4 | `sudo find /opt/automaton-fleet/releases/$COMMIT -perm /222 -print \| head` | no output (the tree is read-only) |
| 7.5 | `test ! -e /opt/automaton-fleet/releases/$COMMIT/.git && echo ok` | `ok` |
| 7.6 | `/opt/automaton-fleet/node/bin/node --version; sudo stat -c '%U:%G %a' /opt/automaton-fleet/node/bin/node` | the expected Node version; `root:root 755` |
| 7.7 | `pnpm fleet:admin approve-runtime` (Path B, or when the restored approval differs) | JSON state shows the approved `$COMMIT`/`$BUILD` |
| 7.8 | `pnpm fleet:verify-runtime /opt/automaton-fleet/current` | `RUNTIME IDENTITY: VERIFIED`; exit 0 |

## Phase 8 — SYSTEMD

| # | Command | Pass criterion |
|---|---|---|
| 8.1 | `for u in automaton-fleet.service automaton-agent.service automaton-fleet-witness.service automaton-fleet-operator-api.service; do cmp -s deploy/systemd/$u /etc/systemd/system/$u && echo SAME $u; done` | 4× `SAME` |
| 8.2 | `cmp deploy/logrotate/automaton-fleet /etc/logrotate.d/automaton-fleet && sudo logrotate -d /etc/logrotate.d/automaton-fleet` | identical; no errors |
| 8.3 | `sudo systemd-analyze verify /etc/systemd/system/automaton-fleet.service` | no errors |
| 8.4 | `test ! -e /etc/systemd/system/automaton-fleet.service.d/remote.conf && echo ok` | `ok` (before Phase 10) |
| 8.5 | `systemctl is-enabled automaton-fleet.service automaton-agent.service automaton-fleet-witness.service automaton-fleet-operator-api.service` | all `disabled` before start |
| 8.6 | `sudo systemd-analyze security automaton-fleet.service automaton-fleet-operator-api.service --no-pager \| tail -1` | exposure scores in the "OK" band (production recorded 1.1 for the Operator API) |

## Phase 9 — LOOPBACK VERIFICATION

| # | Command | Pass criterion |
|---|---|---|
| 9.1 | `sudo systemctl enable --now automaton-fleet.service; systemctl is-active automaton-fleet.service` | `active` |
| 9.2 | `sudo journalctl -u automaton-fleet -n 100 --no-pager -o cat \| jq -r .event` | contains `service_started`; no `startup_failed` or `config_warning` |
| 9.3 | `curl -fsS http://127.0.0.1:8787/healthz` | `{"ok":true,"status":"alive",…}` |
| 9.4 | `curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/readyz` | `200` |
| 9.5 | `ps -o user= -p "$(systemctl show -p MainPID --value automaton-fleet)"` | `automaton-fleet-service` |
| 9.6 | `sudo ss -Hltnp` | `127.0.0.1:8787`, `127.0.0.1:5432`, `127.0.0.1:6379`, `[::1]:6379` loopback; `22` public; nothing on 80 or 443 |
| 9.7 | `sudo scripts/fleet-verify-deployment.sh; echo rc=$?` | only `[PASS]` lines; `rc=0` |
| 9.8 | `pnpm fleet:doctor --deployment-only` | `DEPLOYMENT: OK` |
| 9.9 | `pnpm fleet:verify` | FAIL only on `HTTPS valid`, `remote controller reachable` (and `fleet cap = 2` on Path B) |
| 9.10 | `ws$ for p in 443 5432 6379 8787 8788; do nc -vz -w3 <VPS_IP> $p; done` | all fail |

## Phase 10 — TLS / NETWORK

| # | Command | Pass criterion |
|---|---|---|
| 10.1 | DNS: `api.agentfleet.vip A <VPS_IP>` TTL 600; no AAAA; no CNAME | all four Porkbun servers + 1.1.1.1, 8.8.8.8 and 9.9.9.9 return only the A record (11 §13.4); wait ≥ 10 min |
| 10.2 | certbot HTTP-01 staging (`--dry-run`), then real issuance (12 §14.16) | `certbot certificates` lists `api.agentfleet.vip`, ECDSA, about 90 days; `ufw status \| grep -w 80` → nothing afterwards |
| 10.3 | Install the deploy hook (runbook `:1303-1331`) root 0755, and the port-80 helper and hooks (NOT IN REPOSITORY) | `sha256sum` of each equals the value archived in 14-PRODUCTION-SNAPSHOT.md |
| 10.4 | Copy into `tls/` (12 §14.17) | `stat` → `fleet.key root:root 600 1 regular file`, `fleet.crt root:root 644 1 regular file`; the key-matches-certificate `cmp` succeeds |
| 10.5 | `openssl x509 -in /etc/automaton-fleet/tls/fleet.crt -noout -ext subjectAltName -checkend 86400` | `DNS:api.agentfleet.vip`; "Certificate will not expire" |
| 10.6 | Install `remote.conf` from the example; `cmp deploy/systemd/automaton-fleet.service.d/remote.conf.example /etc/systemd/system/automaton-fleet.service.d/remote.conf` | identical |
| 10.7 | Back up and edit `runtime.env` (12 §14.18); `diff runtime.env.pre-remote runtime.env` | only `FLEET_REMOTE_LISTEN_ENABLED` false→true plus the 4 `FLEET_PUBLIC_*`/`FLEET_TLS_CERT_FILE` lines; no `FLEET_TLS_KEY_FILE`, `FLEET_MAX_AGENTS` or `FLEET_ALLOWED_ORIGINS` |
| 10.8 | `sudo deploy/firewall/fleet-firewall.sh --apply` | `ufw status verbose`: allow 22/tcp, 443/tcp (v4+v6); deny 5432, 6379, 8787 |
| 10.9 | `sudo systemctl daemon-reload && sudo systemctl restart automaton-fleet.service` | active; journal `service_started` with `publicUrl` `https://api.agentfleet.vip:443` |
| 10.10 | `sudo ss -Hltnp \| grep -E ':(443\|8787)\b'` | `0.0.0.0:443` and `127.0.0.1:8787`, both `node` |
| 10.11 | External probes (12 §14.20) | `/healthz` 200; `/readyz` 404; foreign Origin 403; unauthenticated POST `/v1/heartbeat` 401; TLS 1.1 refused; HSTS `max-age=31536000`; port 80 closed; `nmap -Pn -p-` shows only 22 and 443 |
| 10.12 | Path B only (safety-gated): `pnpm fleet:admin set-cap 2` | `pnpm fleet:verify` → 16/16, `SAFE FOR DRY RUN: YES` |
| 10.13 | `pnpm fleet:doctor --deployment-only; pnpm fleet:verify; sudo scripts/fleet-verify-deployment.sh` | `DEPLOYMENT: OK`; 16/16 PASS; all PASS including "remote drop-in maps exactly tls.key and tls.crt" |

## Phase 11 — OPERATOR API

| # | Command | Pass criterion |
|---|---|---|
| 11.1 | `sudo scripts/fleet-verify-deployment.sh \| sed -n '/Operator API isolation/,/ChatGPT/p'` | all PASS: own group only; `operator.env` `root:automaton-fleet-operator-api 640 (single link)`; the agent, service, witness and operator users cannot read it; it holds only the operator credential; the clock is NTP-synced and the timesyncd marker is present |
| 11.2 | `sudo systemctl start automaton-fleet-operator-api.service` | active; journal `operator_api_started` |
| 11.3 | `curl -sS http://127.0.0.1:8788/readyz` | Path B before enabling: HTTP 503 `"state":"disabled"`. Path A with the kill switch on: 200 `"ready"` |
| 11.4 | `curl -sS -o /dev/null -w '%{http_code}\n' -H 'Host: evil.example' http://127.0.0.1:8788/readyz` | `421` |
| 11.5 | `sudo ss -Hltnp \| grep :8788` | exactly `127.0.0.1:8788` |
| 11.6 | `sudo stat -c '%U %a %n' /var/log/automaton-fleet-operator /var/log/automaton-fleet-operator/audit.jsonl` | `automaton-fleet-operator-api 700`, `… 600` |
| 11.7 | `grep -E 'CapEff\|NoNewPrivs\|Seccomp:' /proc/$(systemctl show -p MainPID --value automaton-fleet-operator-api)/status` (sudo) | `CapEff: 0000000000000000`, `NoNewPrivs: 1`, `Seccomp: 2` |
| 11.8 | Path B: enrol principals (Phases 12 and 13), then `pnpm fleet:admin operator-api enable "<reason>"` | `/readyz` 200 `"ready"` without a restart |
| 11.9 | `pnpm fleet:admin operator-list` | exactly `bridge-claude` (`bridge_claude`; status/agents/events) and `bridge-chatgpt` (`bridge_chatgpt`; status/agents), one active key each |
| 11.10 | `sudo systemctl enable automaton-fleet-operator-api.service` | `is-enabled` → `enabled` |
| 11.11 | `pnpm fleet:doctor --deployment-only \| grep -E 'operator'` | audit capacity PASS (< 50%); kill switch `enabled (generation N)`; principals PASS (warn if a key expires within 14 days) |

## Phase 12 — CLAUDE BRIDGE

| # | Command | Pass criterion |
|---|---|---|
| 12.1 | Create `fleet-op-tunnel`, its `authorized_keys` and `70-fleet-op-tunnel.conf` (12 §14.24; NOT IN REPOSITORY, reconstructed) | `getent passwd fleet-op-tunnel` → nologin; `sudo passwd -S fleet-op-tunnel` → `L`; `sudo sshd -t` OK; `sshd -T` for `ubuntu` unchanged from before |
| 12.2 | `dev$ ssh -F /dev/null -i ~/.ssh/fleet_op_tunnel -o IdentitiesOnly=yes -N -L 127.0.0.1:18788:127.0.0.1:8788 fleet-op-tunnel@<VPS_IP> & curl -sS http://127.0.0.1:18788/healthz` | 200 from the Operator API |
| 12.3 | Negative tunnel tests: `-L …:127.0.0.1:8787`, `…:5432`, `…:22`, `-R`, a shell (`ssh … fleet-op-tunnel@<VPS_IP>`), `sftp`, `scp` | every one refused ("administratively prohibited", nologin, or a subsystem denial) |
| 12.4 | Keygen, enrol and `pnpm fleet:bridge init …` (12 §14.25) | the key id printed by keygen equals the key id in the enrol output; `bridge-claude.key` 0600, directory 0700 |
| 12.5 | `dev$ pnpm fleet:bridge doctor` | all checks OK; host-key pin matches |
| 12.6 | `dev$ pnpm fleet:bridge whoami; pnpm fleet:bridge status; pnpm fleet:bridge agents; pnpm fleet:bridge events --limit 5` | model-view JSON; `whoami.kind` = `bridge_claude`; agents = 0 |
| 12.7 | `dev$ pnpm fleet:bridge key status --remote` | days left > 14, or rotate now (runbook `:1261-1265`) |
| 12.8 | Claude Code: `claude mcp list` | `fleet-operator` registered (local scope). `fleet_whoami` returns principal `bridge-claude` |

## Phase 13 — CHATGPT ADAPTER

| # | Command | Pass criterion |
|---|---|---|
| 13.1 | `scripts/fleet-deploy-chatgpt-adapter.sh build $ADAPTER_COMMIT $ADAPTER_BUILD $LOCK` | `Verified adapter build $ADAPTER_BUILD staged at …` |
| 13.2 | `sudo scripts/fleet-deploy-chatgpt-adapter.sh install $ADAPTER_COMMIT` | `readlink /opt/automaton-fleet/chatgpt-adapter/current` → `releases/$ADAPTER_COMMIT`; `pins.env` holds the three pins; `/opt/automaton-fleet/current` **unchanged** |
| 13.3 | `sha256sum <tunnel-client zip>` | `$TC_ZIP` |
| 13.4 | `sudo scripts/fleet-chatgpt-setup.sh prepare --tunnel-client-zip <zip> --apply` | prints only `{publicKey, keyId}`; `sha256sum /opt/automaton-fleet/tunnel-client/v0.0.14/tunnel-client-runtime` → `$TC_BIN` |
| 13.5 | `pnpm fleet:admin operator-enroll bridge-chatgpt bridge_chatgpt --scopes ops.read.status,ops.read.agents --public-key <pub> --expires-days 30` | the key id equals the 13.4 output |
| 13.6 | `sudo scripts/fleet-chatgpt-setup.sh configure <op_…> --apply` | `chatgpt-adapter.json` `root:automaton-fleet-chatgpt-adapter 640 1`; socket and adapter active; tunnel service enabled but inactive; path active |
| 13.7 | Create `tunnel.env` (12 §14.26 step 5) | `grep -cE '^CONTROL_PLANE_TUNNEL_ID=tunnel_[a-z0-9]{32}$' /etc/automaton-fleet/chatgpt-tunnel/tunnel.env` → `1` |
| 13.8 | `sudo stat -c '%U:%G %a' /run/automaton-fleet-chatgpt/adapter.sock` | `automaton-fleet-chatgpt-adapter:automaton-fleet-chatgpt-tunnel 660` |
| 13.9 | `sudo ss -ltneH \| grep -E "uid:($(id -u automaton-fleet-chatgpt-adapter)\|$(id -u automaton-fleet-chatgpt-tunnel))( \|$)"` | no output (no TCP listener) |
| 13.10 | Owner only, in their own terminal: `sudo fleet-chatgpt-tunnel-key` | `Result: accepted — …`; `systemctl is-active automaton-fleet-chatgpt-tunnel` → `active` |
| 13.11 | ChatGPT developer-mode app (Tunnel, No authentication), then call `fleet_whoami`, `fleet_status`, `fleet_list_agents` | `whoami` → `bridge_chatgpt` with scopes {status, agents}; the adapter audit log grows; Operator API request rows are attributed to `op_…` of bridge-chatgpt |

## Phase 14 — SECURITY TESTS

Run on the rebuilt host. Every test is read-only or only makes denied requests.

| # | Command | Pass criterion |
|---|---|---|
| 14.1 | `sudo scripts/fleet-verify-deployment.sh; echo rc=$?` (from a tree ≥ `6691b4c`, for the ChatGPT section) | 0 `[FAIL]`; `rc=0`. Production recorded 60 PASS / 0 FAIL (runbook `:1224`) |
| 14.2 | `for u in automaton-agent automaton-fleet-service automaton-fleet-witness automaton-fleet-operator-api automaton-fleet-chatgpt-adapter automaton-fleet-chatgpt-tunnel; do for f in /etc/automaton-fleet/{admin.env,service.env,tls/fleet.key}; do sudo runuser -u $u -- test -r $f && echo "LEAK $u $f"; done; done` | no `LEAK` line |
| 14.3 | `sudo tr '\0' '\n' </proc/$(systemctl show -p MainPID --value automaton-fleet)/environ \| grep -cE '^(FLEET_(ADMIN\|SERVICE\|AGENT)_DATABASE_URL\|DATABASE_URL)='` | `0` |
| 14.4 | Namespace probe of the Operator API: `sudo nsenter -t <pid> -m -S $(id -u automaton-fleet-operator-api) -G $(id -g automaton-fleet-operator-api) -- sh -c 'for f in /etc/automaton-fleet/admin.env /etc/automaton-fleet/service.env /etc/automaton-fleet/tls /var/log/automaton-fleet /run/credentials; do test -e $f && echo VISIBLE $f; done'` | no `VISIBLE` line |
| 14.5 | Tunnel egress policy: `sudo systemd-run --wait -p User=automaton-fleet-chatgpt-tunnel -p IPAddressDeny=127.0.0.0/8 -p 'IPAddressAllow=127.0.0.53/32 127.0.0.54/32' bash -c 'exec 3<>/dev/tcp/127.0.0.1/8788' ; echo rc=$?`, plus a control run without the properties | the filtered run fails; the control connects. Use numeric CIDRs: `systemd-run -p IPAddressDeny` does not accept `localhost` (operator lesson). Add a "unit ran" marker to prove the command executed |
| 14.6 | Replay and staleness: `pnpm fleet:verify` items "replay protection working" and "agent credentials scoped" | both PASS (`FLEET_REQUEST_STALE`, `FLEET_SESSION_REQUIRED`) |
| 14.7 | Operator API negative probes through the tunnel: unsigned GET, bad signature, stale timestamp, a replayed nonce, an unknown key, a non-GET, an unknown route | all fail closed; a replay → 409; `fleet_operator_requests` rows record the denials; the audit JSONL holds no signature, nonce or key material |
| 14.8 | `pnpm fleet:admin audit-scan /var/log/automaton-fleet/audit.jsonl /var/log/automaton-fleet-operator/audit.jsonl` (sudo, or as the file owners) | exit 0, every class count 0 |
| 14.9 | External: `nmap -Pn -p- <VPS_IP>`; `nmap -6 -Pn -p- <VPS_IPv6>` | IPv4: 22, 443 only. IPv6: 22 only |
| 14.10 | Repository suites on a **non-production** machine with a disposable PostgreSQL: `pnpm test:deploy`, `test:phase6`, `test:witness`, `test:redact`, `test:operator`, `test:bridge`, `test:chatgpt` | green. Known pre-existing Phase 2 PostgreSQL concurrency failures (FLEET-KI-1, KI-2) are documented in `docs/fleet-known-issues.md` and are not a pass condition. Never run tests against the production database |

## Phase 15 — FINAL HASH COMPARISON

Compare every value below with **`22-RECONSTRUCTION-MANIFEST.md`**, which holds the authoritative expected hashes and file lists, and with **`14-PRODUCTION-SNAPSHOT.md`**, which holds the live production values. Any difference is a stop.

```bash
vps$ cd ~/automaton-fleet-build
# 15.1 runtime identity (installed tree, pins, approval)
vps$ pnpm fleet:verify-runtime /opt/automaton-fleet/current --json | jq '{ok, pinned, approved, tree: {commit: .tree.commit, buildId: .tree.buildId, lockfileSha256: .tree.lockfileSha256}}'
# 15.2 adapter identity
vps$ (cd /opt/automaton-fleet/chatgpt-adapter/current && /opt/automaton-fleet/node/bin/node dist/fleet/postgres/cli.js build-identity .) | jq '{buildId, lockfileSha256, fileCount}'
vps$ cat /opt/automaton-fleet/chatgpt-adapter/pins.env
# 15.3 tunnel client and node pin
vps$ sha256sum /opt/automaton-fleet/tunnel-client/v0.0.14/tunnel-client-runtime /opt/automaton-fleet/node/bin/node
# 15.4 installed units, drop-in, logrotate, helper vs repository
vps$ for u in automaton-fleet.service automaton-agent.service automaton-fleet-witness.service automaton-fleet-operator-api.service \
             automaton-fleet-chatgpt-adapter.socket automaton-fleet-chatgpt-adapter.service automaton-fleet-chatgpt-tunnel.service \
             automaton-fleet-chatgpt-tunnel.path; do sha256sum deploy/systemd/$u /etc/systemd/system/$u; done
vps$ sha256sum deploy/systemd/automaton-fleet.service.d/remote.conf.example /etc/systemd/system/automaton-fleet.service.d/remote.conf \
               deploy/logrotate/automaton-fleet /etc/logrotate.d/automaton-fleet \
               scripts/fleet-chatgpt-tunnel-key.sh /usr/local/sbin/fleet-chatgpt-tunnel-key
# 15.5 non-secret configuration, values not bytes
vps$ grep -Ev '^\s*(#|$)' /etc/automaton-fleet/runtime.env | sort | sha256sum
vps$ sudo cat /etc/automaton-fleet/chatgpt-adapter.json | jq -S 'del(.tunnelTokenSha256)'      # public ids only
# 15.6 secret files: metadata only, never content
vps$ sudo stat -c '%U:%G %a %h %n' /etc/automaton-fleet/{admin.env,service.env,operator.env,runtime.env,chatgpt-adapter.json} \
       /etc/automaton-fleet/tls /etc/automaton-fleet/tls/fleet.{key,crt} /etc/automaton-fleet/chatgpt-tunnel \
       /etc/automaton-fleet/chatgpt-tunnel/{adapter-token,tunnel.env} /var/lib/automaton-fleet-chatgpt-adapter/bridge-chatgpt.key
# 15.7 registry
vps$ pnpm fleet:admin status | jq '.state | {maxAgents, operatingMode, livingAgents, reservedSlots, quarantinedSlots, replicationEnabled, runtime, build}'
vps$ pnpm fleet:admin operator-list
vps$ pnpm fleet:migrate-check
# 15.8 verdicts
vps$ pnpm fleet:doctor --deployment-only | tail -8; pnpm fleet:verify | grep -c '^\s*\[PASS\]'
```

| # | Item | Expected |
|---|---|---|
| 15.1 | pinned = approved = installed tree | `4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790` / `54beb10104a11888446ed1d09a85f236d87b977558a88514de7600d7dcc83ced` / `eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811`; `ok: true` |
| 15.2 | adapter tree | `62336fee32671ea04de3bb18c1552273cd80bc02c1d2bd5f219f1dee3b018057` / `eee9dc2f…`; `pins.env` commit `6691b4c9db9d5dedb246d4e984b495f7c4cf0251` |
| 15.3 | tunnel-client binary | `94ae9d0c024753d1b79669152e968eb5d0faaad1e04ccf6c37750d7a3e175c77` |
| 15.3b | node pin | equals `sha256sum "$(command -v node)"` of the Node used to build, and the value in 22-RECONSTRUCTION-MANIFEST.md / 14-PRODUCTION-SNAPSHOT.md |
| 15.4 | each installed unit/drop-in/logrotate/helper | hash equal to its repository file at the deployed commit (the tunnel `.path` unit and the helper at `efad214`) |
| 15.5 | runtime.env values | the 15 expected lines: 4 pins, 4 safety flags `false`, `FLEET_API_LISTEN=127.0.0.1:8787`, `FLEET_REAPER_INTERVAL_MS=15000`, `FLEET_REMOTE_LISTEN_ENABLED=true`, `FLEET_PUBLIC_HOSTNAME=api.agentfleet.vip`, `FLEET_PUBLIC_LISTEN=0.0.0.0:443`, `FLEET_PUBLIC_URL=https://api.agentfleet.vip`, `FLEET_TLS_CERT_FILE=/run/credentials/automaton-fleet.service/tls.crt` |
| 15.6 | secret metadata | exactly the owner/mode/link table in 10 §12.2.1 |
| 15.7 | registry | cap 2, DEVELOPMENT, 0/0/0, replication `false`; exactly the two principals; `migrate-check` `wouldApply: []` at v8 |
| 15.8 | verdicts | `DEPLOYMENT: OK`; 16 PASS; `SAFE FOR DRY RUN: YES`; SAFE FOR REAL REPLICATION/PAYMENTS: **NO** (structural blockers, expected) |

<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->
(The production values for 15.3b, 15.4, 15.5 and 15.6 come from the snapshot. The repository-side expected hashes come from 22-RECONSTRUCTION-MANIFEST.md.)

---

## Stop conditions (summary)

- Any `BUILD MISMATCH`, or any `RUNTIME IDENTITY: REFUSED`.
- Any `[FAIL]` from `fleet-verify-deployment.sh`, or `DEPLOYMENT: FAIL`.
- A public listener on 8787, 8788, 5432 or 6379. Any TCP listener owned by a ChatGPT user.
- A secret readable by a user other than its designated reader (14.2), or a database credential in any `/proc/<pid>/environ` (14.3).
- Any safety flag `true` in `runtime.env`, or a `FLEET_TLS_KEY_FILE`/`FLEET_MAX_AGENTS` line.
- Host-key or key-id mismatch in the bridge or the enrolment.
