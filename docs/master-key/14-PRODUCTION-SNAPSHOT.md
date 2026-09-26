# 14 — Production Snapshot (read-only)

Inspection time: 2026-09-25, about 11:30–12:30 UTC. **No production state was changed.**

## 0. How production was inspected, and the limits

| Channel | Status | What it proves |
|---|---|---|
| Signed read-only **Operator API** (principal `bridge-claude`, through the `fleet-op-tunnel` SSH forward, via the `fleet-operator` MCP tools) | **WORKED** — 4 calls: `whoami`, `status`, `list_agents`, `list_events` (all 116 events) | The DB-backed facts in §1–§4. Each call was one audited, read-only request in `fleet_operator_requests` (request count 43 at the time of `status`). |
| Direct SSH as `ubuntu@agentfleet-vps` | **BLOCKED** — the dev VM's ssh-agent refused to sign with the `agentfleet-vps` key (`agent refused operation`; the key needs interactive confirmation that this non-interactive session can't give). | Nothing. A read-only snapshot script was prepared for the operator to run (§6). |

So every fact below is labelled:
- **LIVE** — read from production during this pass through the Operator API.
- **RECORD** — from the operator's deployment records (runbook, commit messages, operator notes dated 2026-09-24/25). Not re-verified in this pass.
- **NOT VERIFIED** — no live evidence in this pass.

Every `<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->` placeholder in files 02–23 points here. Where this file has no LIVE value, the RECORD value applies and is unverified.

## 1. Runtime identity (LIVE)

| Item | Value |
|---|---|
| Runtime repo (registry) | `https://github.com/5l4mm3r/automaton-fleet` |
| Approved runtime commit | `4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790` |
| Build ID | `54beb10104a11888446ed1d09a85f236d87b977558a88514de7600d7dcc83ced` |
| Lockfile SHA-256 | `eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811` |
| Schema version | **8** |
| Last `runtime_approved` event | #74, 2026-09-24T23:33:49.400Z (previous `03f8760` / `955698a6…`) |

The registry approval matches `CLAUDE.md`, the runbook and the dev-VM repo history (`01-GIT-AND-RELEASE-HISTORY.md` §3). The running process's cwd (`releases/4d6a0be…`) and `runtime.env` pins are **RECORD** (PID 40569, NRestarts 0, at B2-8) and **NOT VERIFIED** in this pass.

## 2. Fleet state (LIVE)

| Item | Value |
|---|---|
| `maxAgents` (registry cap) | **2** (event #26 `cap_set` 1→2 at 2026-09-24T18:45:13Z) |
| Operating mode | **DEVELOPMENT** |
| `replicationEnabled` (registry) | **false** |
| Living | 0 |
| Reserved slots | 0 |
| Quarantined | 0 |
| Agents (list_agents) | **none** (empty page, `next: null`) |
| Stale agents / orphans | none: with zero agent rows no agent can be stale. The orphan table isn't reachable through the Operator API; RECORD says 0 orphans. |
| Witness | **RECORD**: user `automaton-fleet-witness` (uid 995/gid 985) and unit installed, disabled, inactive; not enrolled. LIVE corroboration: no `witness`/enrollment events in the 116-event log. |

## 3. Safety switches (LIVE, as the Operator API reads them from `runtime.env`)

| Switch | Value |
|---|---|
| `REAL_REPLICATION_ENABLED` | false |
| `REAL_PAYMENTS_ENABLED` | false |
| `OWNER_SWEEP_ENABLED` | false |
| `FLEET_DRY_RUN_CHILD` | false |
| `FLEET_REMOTE_LISTEN_ENABLED` | RECORD: true (production VPS only). Not in the status payload. |

Caveat returned by the API itself: "runtime.env as read by the Operator API (the controller may also set switches in its own environment)".

## 4. Operator API (LIVE)

| Item | Value |
|---|---|
| Enabled (kill switch) | **true** |
| Readiness | ready; checks database, schema, killSwitch, privileges, clock all `ok:true, warn:false` |
| Request count / cap | 43 / 2,000,000; `auditLevel: ok` |
| Generation | 2 (event #97 `operator_api_enabled_set`, 2026-09-24T23:49:25Z). No later `operator_api_enabled_set` event exists, so enrolling `bridge-chatgpt` (#112) did **not** change the generation. |

### Registered principals (non-secret)

| Principal ID | Name | Kind | Scopes | Enabled | Key ID | Key expiry | Evidence |
|---|---|---|---|---|---|---|---|
| `op_01M3AX56W25JNMQCTBM8HYH474` | bridge-claude | bridge_claude | ops.read.agents, ops.read.events, ops.read.status | yes (authenticates now) | `ec4f06982ae9135fd2b28e928f5a4a61` | 2026-10-24T23:49:04.533Z | LIVE `whoami`; event #96 |
| `op_01M3B18TXVP33S6NQC909DXD57` | bridge-chatgpt | bridge_chatgpt | ops.read.status, ops.read.agents | RECORD: yes | `fe22d91c08f0a0676b4c155ce0d618d3` | 2026-10-25T01:00:57.682Z | LIVE event #112 (kind, keyId, expiry); ID and scopes RECORD |

No `operator_principal_revoked` / key-revoked events exist, so no principal or key has been revoked (LIVE, from the event log).

**Key expiry:** both keys expire within 30 days of this snapshot. Rotation is needed before 2026-10-24 (bridge-claude) and 2026-10-25 (bridge-chatgpt).

## 5. Audit event log (LIVE, events 1–116)

| Type | Count | Notes |
|---|---|---|
| `api_auth_failed` | 91 | Nearly all on `/v1/heartbeat` in pairs: "session required (long-lived credential only opens sessions)" + "request timestamp outside the allowed window". These are the deployment-verification probes (`fleet-verify-deployment.sh` / runbook checks), which fire after each restart or verification. 2× "missing session". None come from a real agent. |
| `runtime_approved` | 5 | #8 241dcf9, #11 11c0c7c, #47 cdfd70c, #59 03f8760, #74 4d6a0be |
| `agent_role_granted` / `service_role_granted` | 4 / 4 | #1/2 (v1–v6 dev VM), #16/17, #45/46 (v7 migrate), #72/73 (v8 migrate) |
| `reaper_resumed` | 5 | #3, #12, #15, #18, #48 (controller starts) |
| `cap_set` | 1 | #26: 1 → 2 |
| `operator_role_granted` | 1 | #82 fleet_operator |
| `operator_disabled` | 1 | #83 probe while the kill switch was off (B2-9) |
| `operator_principal_enrolled` | 2 | #96 bridge_claude, #112 bridge_chatgpt |
| `operator_api_enabled_set` | 1 | #97 enabled, generation 2 |
| `operator_replay_blocked` | 2 | #98, #99 deliberate replay tests (B2-12) |

The last event is #116 at 2026-09-25T01:04:46Z. There are no agent, reservation, provisioning, treasury, spend, custody, orphan, termination, witness or dry-run events: **no agent has ever existed in this database.**

Reading event #83 and the `operator_replay_blocked` events shows that denials are also recorded in `fleet_events` (actor class `operator_api`, detail `{code, route, layer}`), which matches `06-OPERATOR-API-B2.md`.

## 6. Host-level facts: NOT VERIFIED in this pass (RECORD values)

The following need host access (SSH/sudo). The read-only script prepared for the operator is `prod-snapshot.sh` in the session scratchpad. It is reproduced in Appendix A so it can be run later to complete this section.

| Area | RECORD value (operator records, 2026-09-24/25) |
|---|---|
| Controller service | `automaton-fleet.service` active, PID 40569, cwd `releases/4d6a0be…`, NRestarts 0, User `automaton-fleet-service` |
| Operator API service | `automaton-fleet-operator-api.service` active and enabled, PID 42287, uid 994, CapEff 0, NoNewPrivs, seccomp, 127.0.0.1:8788 |
| ChatGPT adapter | `automaton-fleet-chatgpt-adapter` (socket-activated) active, PID 51151, `/run/automaton-fleet-chatgpt/adapter.sock`, artifact `6691b4c`, build `62336fee…`, uid 992 |
| Secure MCP Tunnel | `automaton-fleet-chatgpt-tunnel.service` enabled, **inactive** pending the owner's OpenAI runtime key; `.path` unit active; tunnel id `tunnel_6ab5cd2c7b088191abe137e56b5f35e4`; tunnel user uid 988; tunnel-client v0.0.14 |
| Tunnel ↔ VPS | Proven only in a dry run with a dummy key: MCP session to the adapter over the socket OK, OpenAI egress OK (401 on the dummy key). **Not yet connected with a real key.** |
| ChatGPT product ↔ Fleet tools | **NOT PROVEN / PARKED.** Owner has not yet created the ChatGPT developer-mode app. |
| Witness | user installed, unit disabled and inactive, not enrolled |
| Listeners | 0.0.0.0:443 (controller HTTPS), 127.0.0.1:8787 (controller HTTP), 127.0.0.1:8788 (Operator API), PostgreSQL and Redis loopback-only, sshd :22 |
| Public exposure | From outside, 8788, 8787, 5432, 6379 and 8080 closed (Phase C verification). Public `/healthz` 200, `/readyz` 404. |
| Firewall | OVH edge 22/80/443 IPv4; ufw 22/443 (v4+v6); 80 only opened via `/usr/local/sbin/fleet-certbot-port80` hooks |
| TLS | Let's Encrypt ECDSA certificate for `api.agentfleet.vip`, delivered by `LoadCredential` `tls.key`/`tls.crt` |
| SSH | key-only (`10-fleet-no-passwords.conf`); `fleet-op-tunnel` (uid 993) restricted to `permitopen="127.0.0.1:8788"` |
| Verification | `fleet-verify-deployment.sh` 60 PASS / 0 FAIL; `fleet:verify` 16/16; doctor DEPLOYMENT OK; privilege audit PASS (2 principals, 2 keys) |
| Failed units | none recorded |
| DB lock/transaction health | not recorded |
| Schema object comparison (`03` §5 checklist: 31 tables, 85 functions, 58 triggers, 64 indexes) | **NOT PERFORMED.** Needs `pg_dump -s`. Indirect LIVE evidence: the Operator API `privileges` and `schema` readiness checks pass on v8, and the privilege audit's static function-body checks run over the live catalog. |

### Answers to the Part 13 exposure questions

| Question | Answer | Basis |
|---|---|---|
| Is 8787 public? | **No** (expected and recorded) | RECORD external probe; unit `IPAddressAllow` + bind 127.0.0.1 in repo |
| Is 8788 public? | **No** | RECORD external probe; Operator API refuses non-loopback binds (`06` §listener); reached only via the SSH `permitopen` forward, which worked LIVE in this pass |
| Is PostgreSQL public? | **No** | RECORD |
| Is Redis public? | **No** | RECORD. No fleet code uses Redis. |

## 7. Repository ↔ production drift (known from this pass)

| # | Item | Repo (HEAD efad214) | Production | Status |
|---|---|---|---|---|
| P-1 | Controller runtime | HEAD is 11 commits past 4d6a0be (docs, bridge D/D2, adapter C, helper fixes) | 4d6a0be approved (LIVE) | **No runtime drift.** `git diff 4d6a0be..HEAD -- src/fleet/service src/fleet/postgres src/fleet/operator src/fleet/runtime*.ts src/fleet/redact.ts src/fleet/secret-files.ts` is **empty** (checked in this pass). The later commits change only docs, `src/fleet/bridge`, `src/fleet/chatgpt-adapter`, scripts, deploy units, tests and `package.json`. `package.json` is part of the build input, so a HEAD build gets a different build ID even though the controller code is identical. |
| P-2 | ChatGPT adapter | code unchanged since 6691b4c; `package.json` changed later | artifact 6691b4c (RECORD) | A HEAD build won't reproduce build `62336fee…` byte-for-byte |
| P-3 | Tunnel-key helper | `scripts/fleet-chatgpt-tunnel-key.sh` at efad214 | RECORD installed sha `9c8ff3d6…` = HEAD per operator record | NOT VERIFIED live |
| P-4 | Host-only assets (fleet-op-tunnel account, sshd drop-ins, certbot helpers and hooks, tunnel.env) | not in repo | exist (RECORD) | Drift by omission. See `10`, `12`. |
| P-5 | FLEET.md "current deployment state" | says 11c0c7c / v6 / cap 1 / local VM | 4d6a0be / v8 / cap 2 / VPS (LIVE) | Documentation drift (see `21`) |
| P-6 | **Agent-side guards for Phase D/C** | HEAD `src/agent/policy-rules/command-safety.ts` adds two forbidden-command patterns (bridge: `fleet:bridge`, `fleet/bridge/`, `fleet-op-tunnel`, `bridge-claude*.key/json`; ChatGPT: `automaton-fleet-chatgpt`, `chatgpt-adapter`, `chatgpt-tunnel`, `tunnel-client`, `bridge-chatgpt`, `x-fleet-adapter-token`, `CONTROL_PLANE_(API_KEY\|TUNNEL_ID)`). HEAD `src/self-mod/code.ts` adds 30 `PROTECTED_FILES` entries for `fleet/bridge/*` and `fleet/chatgpt-adapter/*`. Added in `bfb9c62`, `cb42f87`, `6691b4c`. | The **approved agent runtime is 4d6a0be**, which has **neither**. An agent attested to the pinned runtime would run without the Phase D/C command and self-modification guards. | **REAL DRIFT, no current impact**: 0 agents, and replication and dry run are off. Closing it needs a new runtime release (build, pin, approve), which is an operator-gated change. The controller, Operator API and bridge security don't depend on these agent-side guards: they are defence in depth on the agent side. |

## Appendix A — read-only snapshot script (for completing §6)

Run from the dev VM as the operator (the key needs interactive confirmation):

```
ssh agentfleet-vps 'f=$(mktemp) && cat > "$f" && bash "$f"; rm -f "$f"' < prod-snapshot.sh > prod-snapshot.out 2>&1
```

It prints no secret values:
- Secret files are only `stat`ed or have key names listed.
- `runtime.env` is filtered to an allow-list of non-secret keys.
- Unit text is masked.
- The database session is `BEGIN TRANSACTION READ ONLY … ROLLBACK`.
- `pg_dump -s` is schema-only.

### Script text

```bash
#!/usr/bin/env bash
# Master-key production snapshot: READ-ONLY. Changes nothing.
# Never prints secret contents: secret files are stat()ed only; runtime.env and
# tunnel.env are filtered to allow-listed non-secret keys; unit text has any
# credential-looking Environment= values masked. DB access is a READ ONLY
# transaction as the postgres superuser via peer auth (no password involved).
set -u
export LC_ALL=C
sec() { printf '\n######## %s\n' "$*"; }
mask() { sed -E 's/((PASSWORD|SECRET|TOKEN|DATABASE_URL|API_KEY|PRIVATE)[A-Z_]*=)[^ "]*/\1[SECRET REDACTED]/Ig; s#(postgres(ql)?://[^:/@ ]+:)[^@ ]+@#\1[SECRET REDACTED]@#g'; }

sec HOST
hostname; uname -r; lsb_release -ds 2>/dev/null; date -u +%FT%TZ; uptime; id
timedatectl show -p NTPSynchronized -p Timezone 2>/dev/null

sec OS-USERS-GROUPS
getent passwd | awk -F: '$1 ~ /automaton|fleet/ {print}'
getent group  | awk -F: '$1 ~ /automaton|fleet/ {print}'
id ubuntu

sec UNITS
systemctl list-units --all --no-pager --no-legend 'automaton*' 'fleet*'
systemctl list-unit-files --no-pager --no-legend 'automaton*' 'fleet*'
echo "-- failed:"; systemctl --failed --no-pager --no-legend
for u in automaton-fleet automaton-fleet-operator-api automaton-fleet-witness automaton-agent \
         automaton-fleet-chatgpt-adapter automaton-fleet-chatgpt-tunnel; do
  echo "-- show $u.service"
  systemctl show "$u.service" -p Id -p LoadState -p ActiveState -p SubState -p UnitFileState \
    -p MainPID -p NRestarts -p ExecMainStartTimestamp -p User -p Group -p FragmentPath -p DropInPaths --no-pager
done
for u in automaton-fleet-chatgpt-adapter.socket automaton-fleet-chatgpt-tunnel.path; do
  echo "-- show $u"; systemctl show "$u" -p Id -p ActiveState -p SubState -p UnitFileState -p FragmentPath --no-pager
done

sec UNIT-TEXT
for u in $(systemctl list-unit-files --no-pager --no-legend 'automaton*' | awk '{print $1}'); do
  echo "==== systemctl cat $u"; systemctl cat "$u" --no-pager 2>&1 | mask
done
echo "-- unit file hashes"
sha256sum /etc/systemd/system/automaton* /etc/systemd/system/automaton-fleet.service.d/* 2>/dev/null
ls -la /etc/systemd/system/ | grep -i automaton
ls -la /etc/systemd/system/automaton-fleet.service.d/ 2>/dev/null

sec SECURITY-SCORES
for u in automaton-fleet automaton-fleet-operator-api automaton-fleet-chatgpt-adapter automaton-fleet-chatgpt-tunnel automaton-fleet-witness; do
  printf '%s: ' "$u"; systemd-analyze security "$u.service" --no-pager 2>/dev/null | tail -1
done

sec PROCESSES
for u in automaton-fleet automaton-fleet-operator-api automaton-fleet-chatgpt-adapter automaton-fleet-chatgpt-tunnel; do
  pid=$(systemctl show -p MainPID --value "$u.service")
  [[ "$pid" != 0 ]] || { echo "$u: not running"; continue; }
  echo "$u pid=$pid cwd=$(sudo readlink /proc/$pid/cwd) exe=$(sudo readlink /proc/$pid/exe)"
  sudo grep -E '^(Uid|Gid|Groups|CapEff|CapBnd|NoNewPrivs|Seccomp):' /proc/$pid/status
done

sec FILESYSTEM-METADATA
sudo find /opt/automaton-fleet -maxdepth 3 \( -name node_modules -prune \) -o -printf '%M %u:%g %s %TY-%Tm-%Td %p%l\n' 2>/dev/null | grep -v node_modules | head -200
readlink /opt/automaton-fleet/current; readlink /opt/automaton-fleet/chatgpt-adapter/current 2>/dev/null
sudo find /etc/automaton-fleet /var/lib/automaton-fleet* /var/lib/fleet-op-tunnel /var/log/automaton-fleet* /run/automaton-fleet* \
  /usr/local/sbin/fleet-* /etc/logrotate.d/automaton-fleet /etc/ssh/sshd_config.d \
  -printf '%M %u:%g nlink=%n %s %TY-%Tm-%Td %p\n' 2>/dev/null
echo "-- non-secret helper/script hashes"
sudo sha256sum /usr/local/sbin/fleet-* /etc/logrotate.d/automaton-fleet /etc/ssh/sshd_config.d/70-fleet-op-tunnel.conf /etc/ssh/sshd_config.d/10-fleet-no-passwords.conf 2>/dev/null
echo "-- sshd fleet config (public config, no secrets)"
sudo cat /etc/ssh/sshd_config.d/70-fleet-op-tunnel.conf /etc/ssh/sshd_config.d/10-fleet-no-passwords.conf 2>/dev/null
echo "-- tunnel authorized_keys options only (public key material stripped)"
sudo sed -E 's/(ssh-ed25519|ssh-rsa|ecdsa-[^ ]+) [A-Za-z0-9+\/=]+/\1 [PUBLIC KEY OMITTED]/' /var/lib/fleet-op-tunnel/.ssh/authorized_keys 2>/dev/null
sudo sshd -T 2>/dev/null | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|pubkeyauthentication|allowtcpforwarding) '

sec RUNTIME-ENV-ALLOWLISTED
sudo grep -E '^(FLEET_RUNTIME_REPO|FLEET_RUNTIME_COMMIT|FLEET_RUNTIME_BUILD_ID|FLEET_RUNTIME_LOCKFILE_SHA256|REAL_REPLICATION_ENABLED|REAL_PAYMENTS_ENABLED|OWNER_SWEEP_ENABLED|FLEET_DRY_RUN_CHILD|FLEET_API_LISTEN|FLEET_REAPER_INTERVAL_MS|FLEET_REMOTE_LISTEN_ENABLED|FLEET_MAX_AGENTS|FLEET_HTTPS_LISTEN|FLEET_PUBLIC_[A-Z_]+|FLEET_PG_SCHEMA)=' /etc/automaton-fleet/runtime.env
echo "-- key NAMES present in runtime.env (values not shown):"; sudo sed -nE 's/^([A-Z0-9_]+)=.*/\1/p' /etc/automaton-fleet/runtime.env
echo "-- key NAMES present in secret env files (values not shown):"
for f in admin.env service.env operator.env; do printf '%s: ' "$f"; sudo sed -nE 's/^([A-Z0-9_]+)=.*/\1/p' /etc/automaton-fleet/$f 2>/dev/null | tr '\n' ' '; echo; done
sudo sha256sum /etc/automaton-fleet/runtime.env
echo "-- tunnel.env non-secret keys"
sudo sed -nE 's/^([A-Z0-9_]+)=.*/\1/p' /etc/automaton-fleet/chatgpt-tunnel/tunnel.env 2>/dev/null | tr '\n' ' '; echo
sudo grep -E '^[A-Z_]*TUNNEL_ID=' /etc/automaton-fleet/chatgpt-tunnel/tunnel.env 2>/dev/null
echo "-- chatgpt-adapter.json keys (values of token-like keys hidden)"
sudo python3 -c 'import json,sys; d=json.load(open("/etc/automaton-fleet/chatgpt-adapter.json"))
def w(o,p=""):
  for k,v in o.items():
    if isinstance(v,dict): w(v,p+k+".")
    else: print(p+k,"=",("[SECRET REDACTED]" if any(s in k.lower() for s in ("token","secret","password")) and "sha256" not in k.lower() else v))
w(d)' 2>&1

sec NETWORK
sudo ss -ltnpH; sudo ss -lunpH; sudo ss -lxpH | grep -Ei 'fleet|automaton|postgres|redis'
echo "-- established (fleet-related)"; sudo ss -tnpH state established | grep -Ei 'node|tunnel|sshd' | awk '{print $3, $4, $5}' | sort | uniq -c
sudo ufw status verbose
echo "-- DNS"; getent ahosts api.agentfleet.vip | head -4
echo "-- TLS certificate (public metadata)"
for c in /etc/letsencrypt/live/api.agentfleet.vip/cert.pem /etc/automaton-fleet/tls/fleet.crt; do
  echo "$c"; sudo openssl x509 -in "$c" -noout -subject -issuer -dates -serial -fingerprint -sha256 -ext subjectAltName 2>&1
  sudo openssl x509 -in "$c" -noout -text 2>/dev/null | grep -A1 'Public Key Algorithm' | head -2
done
echo "-- probes"
curl -sS -o /dev/null -w 'public healthz %{http_code}\n' https://api.agentfleet.vip/healthz
curl -sS -o /dev/null -w 'public readyz %{http_code}\n' https://api.agentfleet.vip/readyz
curl -sS -o /dev/null -w 'loopback 8787 healthz %{http_code}\n' http://127.0.0.1:8787/healthz
curl -sS -o /dev/null -w 'loopback 8787 readyz %{http_code}\n' http://127.0.0.1:8787/readyz
curl -sS -H 'Host: 127.0.0.1:8788' http://127.0.0.1:8788/readyz; echo

sec TUNNEL-CLIENT
ls -la /opt/automaton-fleet/tunnel-client/ 2>/dev/null
sudo sha256sum /opt/automaton-fleet/tunnel-client/*/tunnel-client-runtime 2>/dev/null
echo "-- tunnel unit log: event lines only (last 30, filtered)"
sudo journalctl -u automaton-fleet-chatgpt-tunnel.service --no-pager -n 30 -o short-iso 2>/dev/null | mask | grep -viE 'sk-|bearer|authorization'
echo "-- adapter unit log (last 15)"
sudo journalctl -u automaton-fleet-chatgpt-adapter.service --no-pager -n 15 -o short-iso 2>/dev/null | mask | grep -viE 'sk-|bearer|authorization'

sec POSTGRES-REDIS
systemctl is-active postgresql redis-server 2>/dev/null; psql --version; redis-server --version 2>/dev/null
sudo -u postgres psql -X -At -c 'SELECT version()' 2>&1
redis-cli ping 2>&1 | head -1; redis-cli info server 2>/dev/null | grep -E 'redis_version|tcp_port'; redis-cli info keyspace 2>/dev/null
sudo grep -E "^\s*(listen_addresses|port|ssl|password_encryption)\s*=" /etc/postgresql/*/main/postgresql.conf
sudo grep -vE '^\s*(#|$)' /etc/postgresql/*/main/pg_hba.conf
sudo grep -E '^\s*(bind|port|protected-mode)\b' /etc/redis/redis.conf

sec DB-READONLY
DB=$(sudo -u postgres psql -X -At -c "SELECT datname FROM pg_database WHERE datname LIKE '%fleet%'" | head -1)
echo "db=$DB"
sudo -u postgres psql -X -d "$DB" -v ON_ERROR_STOP=1 -P pager=off <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT n.nspname AS schema FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname='fleet_schema_migrations';
SELECT set_config('search_path', (SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname='fleet_schema_migrations' LIMIT 1)||',public', true);
TABLE fleet_schema_migrations ORDER BY version;
SELECT * FROM fleet_state;
SELECT operator_api_enabled, generation, request_count, request_cap, updated_at, updated_by FROM fleet_operator_state;
SELECT principal_id, name, kind, scopes, created_at, created_by, revoked_at FROM fleet_operator_principals ORDER BY created_at;
SELECT key_id, principal_id, algorithm, not_before, expires_at, created_at, revoked_at FROM fleet_operator_keys ORDER BY created_at;
SELECT count(*) AS operator_requests, max(created_at) AS last_request FROM fleet_operator_requests;
SELECT principal_id, count(*) FROM fleet_operator_requests GROUP BY 1;
SELECT status, count(*) FROM fleet_agents GROUP BY 1;
SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname;
SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolconnlimit, rolbypassrls, rolconfig FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY 1;
SELECT r.rolname AS member, g.rolname AS role FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member JOIN pg_roles g ON g.oid=m.roleid WHERE g.rolname !~ '^pg_' ORDER BY 1,2;
SELECT datname, datacl FROM pg_database WHERE datname = current_database();
SELECT usename, application_name, state, backend_type, now()-xact_start AS xact_age, wait_event_type FROM pg_stat_activity WHERE datname=current_database();
SELECT mode, granted, count(*) FROM pg_locks GROUP BY 1,2 ORDER BY 1;
SELECT count(*) FILTER (WHERE state LIKE 'idle in transaction%') AS idle_in_tx FROM pg_stat_activity;
ROLLBACK;
SQL
echo "-- schema-only dump (no data, no role passwords) sha256 + text"
sudo -u postgres pg_dump -s -d "$DB" > /tmp/mk-schema.$$.sql 2>&1; sha256sum /tmp/mk-schema.$$.sql; wc -l /tmp/mk-schema.$$.sql
echo "==== BEGIN SCHEMA DUMP"; cat /tmp/mk-schema.$$.sql; echo "==== END SCHEMA DUMP"; rm -f /tmp/mk-schema.$$.sql

sec TOOLING-CHECKS
T=~/automaton-fleet-build
git -C $T rev-parse HEAD; git -C $T status --short | head
cd $T && { pnpm -s fleet:doctor --deployment-only 2>&1 | mask; echo "doctor rc=$?"; }
cd $T && { pnpm -s fleet:verify 2>&1 | mask | tail -40; }
cd $T && { pnpm -s fleet:verify-runtime 2>&1 | mask; }
cd $T && { pnpm -s fleet:audit-privileges 2>&1 | mask | tail -40; }
cd $T && { sudo scripts/fleet-verify-deployment.sh 2>&1 | tail -80; echo "verify-deployment rc=$?"; }
sec END
```
