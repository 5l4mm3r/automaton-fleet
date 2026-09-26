# PART 5 — FleetController (the fleet service): process start to shutdown

> Master Key volume 04. Forensic, implementation-grade description of the FleetController
> ("fleet service", systemd unit `automaton-fleet.service`) as implemented at
> branch `fleet-development`, HEAD `efad214`.
> Implementation wins over documentation: every statement below is taken from code and cited as
> `path:line`. Where docs disagree, a `DRIFT:` line records both. Anything designed but absent from
> code is marked **NOT IMPLEMENTED**.

---

## 0. Terminology and file map

The name "FleetController" is used three ways in the repository. This volume documents all three,
and they are not the same thing:

| Name in code | File | What it is | Runs where |
|---|---|---|---|
| `FleetService` class | `src/fleet/service/server.ts:212` | **The FleetController HTTP service.** The only process that holds fleet DB credentials. This is the production control plane. | `automaton-fleet.service` (VPS) |
| `startFleetServiceFromEnv` | `src/fleet/service/main.ts:194` | Process entry point: config, privilege refusals, DB checks, listeners, reaper, signals. | same process |
| `SharedFleetController` class | `src/fleet/shared-controller.ts:74` | **Agent-side** replication orchestrator. Talks to the FleetService over HTTP through `FleetApiClient`. | inside each automaton (agent) |
| `FleetController` class | `src/fleet/controller.ts:52` | **Phase 1 local SQLite controller.** Not used by any production replication path (`src/fleet/index.ts:274-278`). | legacy/tests only |

Source files covered:

| File | Lines | Role |
|---|---|---|
| `src/fleet/service/main.ts` | 353 | entry point, env/TLS/remote config, privilege refusals, startup checks, signals |
| `src/fleet/service/server.ts` | 908 | HTTP(S) server, route policy, authentication, handlers, reaper loop, readiness, drain |
| `src/fleet/service/server-signing.ts` | 18 | request canonical string + HMAC (shared with the agent client) |
| `src/fleet/service/client.ts` | 487 | `FleetApiClient` (agent side of the protocol) |
| `src/fleet/service/rate-limit.ts` | 62 | in-memory token-bucket rate limiter |
| `src/fleet/service/log.ts` | 47 | JSON logger and audit sink (redacted) |
| `src/fleet/service/terminator.ts` | 34 | sandbox terminator (default: unsupported) |
| `src/fleet/postgres/store.ts` | 1653 | `PgFleetStore` (service role / admin role DB access) |
| `src/fleet/postgres/agent-gateway.ts` | 213 | `PgAgentGateway` (restricted agent role DB access) |
| `src/fleet/postgres/migrations*.ts` | 3699 | schema v1–v8, SQL functions that implement every lifecycle transition |
| `src/fleet/secret-files.ts` | 419 | env file loading, secret-file and systemd-credential validation |
| `src/fleet/runtime.ts`, `attestation.ts`, `runtime-verify.ts` | 371/249/126 | runtime pinning, build identity, attestation |
| `src/fleet/shared-controller.ts`, `shared.ts`, `backend.ts`, `grants.ts` | 377/137/53/99 | agent-side replication path |
| `src/fleet/controller.ts`, `registry.ts`, `policy.ts`, `config.ts`, `types.ts` | 194/392/195/91/250 | Phase 1 local controller, pure policy, config parsing, types |
| `src/fleet/secrets.ts`, `redact.ts` | 71/622 | agent env scrubbing; canonical redactor used by every sink |

---

## 1. Process entry point

### 1.1 How the process is started

| Context | Command | Source |
|---|---|---|
| Production | `ExecStart=/opt/automaton-fleet/node/bin/node dist/fleet/service/main.js`, `User=automaton-fleet-service`, `WorkingDirectory=/opt/automaton-fleet/current` | `deploy/systemd/automaton-fleet.service` |
| Development | `pnpm fleet:service` → `tsx src/fleet/service/main.ts` | `package.json:51` |

The module only self-starts when `process.argv[1]` matches `/fleet[\\/]service[\\/]main\.(ts|js)$/`
(`src/fleet/service/main.ts:331`). Importing it (tests) does not start anything.

### 1.2 Top-level bootstrap (`src/fleet/service/main.ts:331-353`)

Order of operations:

1. `createJsonLogger()` (stdout JSON lines, `src/fleet/service/log.ts:129-140`).
2. `process.on("uncaughtException")` → log `fatal uncaught_exception {error}` → `process.exit(1)` (`main.ts:333-336`).
3. `process.on("unhandledRejection")` → log `fatal unhandled_rejection` → `process.exit(1)` (`main.ts:337-340`).
4. `loadServiceEnv()` (`src/fleet/secret-files.ts:327-354`). Any throw → log `fatal startup_failed` → exit 1 (`main.ts:342-347`).
5. Each `loaded.warnings` entry → log `warn config_warning {warning}` (`main.ts:348`).
6. `startFleetServiceFromEnv(loaded.env, { log, installSignalHandlers: true })`; a rejection → log `fatal startup_failed` → exit 1 (`main.ts:349-352`).

### 1.3 Environment loading: `loadServiceEnv` (`src/fleet/secret-files.ts:327-354`)

Layers are merged in this order, **later layers override earlier ones**, and the process environment
overrides everything (`merge`, `secret-files.ts:279-301`):

| Precedence (low → high) | Source | Validation |
|---|---|---|
| 1 | `<cwd>/.env.fleet` (legacy) | plain read (`readEnvFile`); if it supplies a controller secret a warning is emitted (`secret-files.ts:295-299`) |
| 2 | `FLEET_RUNTIME_ENV_FILE` or `/etc/automaton-fleet/runtime.env` | plain read, missing = empty |
| 3 | service secret file (see below) | strict secret-file checks **or** systemd-credential checks |
| 4 | process environment (systemd `Environment=` lines) | none |

Service secret file selection (`secret-files.ts:332-339`):

- `FLEET_SERVICE_ENV_FILE` set → that file, **strict** checks (`secretFileProblems`, no group bits, no world bits, not a symlink, regular file) and `required: true`.
- else `CREDENTIALS_DIRECTORY` set → `$CREDENTIALS_DIRECTORY/service.env`, validated by `systemdCredentialProblems` (section 1.5), `required: true`.
- else `/etc/automaton-fleet/service.env`, strict checks, not required (missing = skipped).

`loadServiceEnv` **never reads `admin.env`** (`secret-files.ts:325`). If `FLEET_ADMIN_DATABASE_URL` reached
the merged env from any layer, a warning is added (`secret-files.ts:350-352`); `startFleetServiceFromEnv`
then refuses to start (section 1.6).

Controller secret keys tracked for provenance (names only, values never logged): `FLEET_ADMIN_DATABASE_URL`,
`FLEET_OPERATOR_DATABASE_URL`, `FLEET_SERVICE_DATABASE_URL`, `FLEET_AGENT_DATABASE_URL`,
`FLEET_CONTROLLER_DATABASE_URL`, `DATABASE_URL`, `REDIS_URL` (`secret-files.ts:64-72`).

`parseEnv` regex: `/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/`; lines starting with `#` ignored; one layer of matching
`'…'` or `"…"` quotes stripped (`secret-files.ts:82-89`).

### 1.4 Environment variables consumed by the service

| Variable | Default | Meaning | Parsed at |
|---|---|---|---|
| `FLEET_SERVICE_DATABASE_URL` | — (required) | restricted controller DSN (`fleet_service_login`). Fallbacks, in order: `FLEET_CONTROLLER_DATABASE_URL`, `DATABASE_URL` | `main.ts:204-206` |
| `FLEET_AGENT_DATABASE_URL` | — (required) | restricted agent DSN (`fleet_agent_login`) | `main.ts:205-210` |
| `FLEET_ADMIN_DATABASE_URL` | must be absent/empty | presence (non-blank) refuses startup | `main.ts:201-203` |
| `FLEET_API_LISTEN` | `127.0.0.1:8787` | `host:port`; loopback only unless remote + TLS | `main.ts:74-87, 216` |
| `FLEET_TLS_CERT_FILE` | unset | PEM certificate path | `main.ts:100` |
| `FLEET_TLS_KEY_FILE` | unset | explicit key path → strict 0600 checks | `main.ts:101, 113-114` |
| `CREDENTIALS_DIRECTORY` | set by systemd | when cert set and explicit key unset, key = `$CREDENTIALS_DIRECTORY/tls.key` | `main.ts:102-103` |
| `FLEET_REMOTE_LISTEN_ENABLED` | false | exactly `"true"` (trimmed, case-insensitive) enables remote | `main.ts:154, 212` |
| `FLEET_PUBLIC_HOSTNAME` | — | required DNS name when remote enabled; regex in 1.7 | `main.ts:165-166` |
| `FLEET_PUBLIC_LISTEN` | unset | HTTPS bind `host:port`; requires remote enabled | `main.ts:155, 161, 169` |
| `FLEET_ALLOWED_ORIGINS` | none | comma list; each must match `/^https:\/\/[^/\s]+$/` | `main.ts:156-159` |
| `FLEET_SERVICE_EXPECTED_USER` | unset | OS user the process must run as | `main.ts:175-176` |
| `FLEET_REAPER_INTERVAL_MS` | `15000` | reaper period; `0` disables | `main.ts:263`, `server.ts:295` |
| `FLEET_SHUTDOWN_DRAIN_MS` | `10000` | drain window on close | `main.ts:264`, `server.ts:348` |
| `FLEET_AUDIT_LOG` | unset | JSONL audit file (created `0600`, append) | `main.ts:255`, `log.ts:155-159` |
| `FLEET_RUNTIME_REPO` / `_COMMIT` / `_BUILD_ID` / `_LOCKFILE_SHA256` | unset | pinned runtime release | `runtime.ts:350-354` |
| `REAL_REPLICATION_ENABLED` | false | exactly `"true"` enables the service-level replication switch | `main.ts:258` |
| `FLEET_PG_SCHEMA` | `fleet` | schema name (must match `/^[a-z_][a-z0-9_]{0,62}$/`) | `main.ts:220`, `migrations.ts:1210-1215` |
| `FLEET_SERVICE_ROLE` | `fleet_service` | group role audited for the service login | `main.ts:221` |
| `FLEET_AGENT_ROLE` | `fleet_agent` | group role audited for the agent login | `main.ts:222` |
| `FLEET_SERVICE_ENV_FILE` | unset | explicit service secret file | `secret-files.ts:332` |
| `FLEET_RUNTIME_ENV_FILE` | `/etc/automaton-fleet/runtime.env` | non-secret env file | `secret-files.ts:340` |

The production unit sets in process env (these override `runtime.env`): `NODE_ENV=production`,
`FLEET_SERVICE_EXPECTED_USER=automaton-fleet-service`, `FLEET_RUNTIME_ENV_FILE=/etc/automaton-fleet/runtime.env`,
`FLEET_AUDIT_LOG=/var/log/automaton-fleet/audit.jsonl`, `FLEET_API_LISTEN=127.0.0.1:8787`,
`FLEET_SHUTDOWN_DRAIN_MS=10000` (`deploy/systemd/automaton-fleet.service`).

Observation (input validation): `FLEET_REAPER_INTERVAL_MS` and `FLEET_SHUTDOWN_DRAIN_MS` are parsed with
`Number(...)` with no range/NaN check (`main.ts:263-264`). A non-numeric value yields `NaN`:
`startReaper` does not treat `NaN` as `<= 0` (`server.ts:296`) so `setInterval(fn, NaN)` fires at Node's
minimum delay (single-flighted by `this.reaping`), and readiness reports the reaper as not OK because
`age <= Math.max(NaN, 60000)` is false (`server.ts:385`). A `NaN` drain makes `close()` skip the drain wait
(`server.ts:348-351`). No code path guards this.

<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->
Repo expectation for production `runtime.env`: `FLEET_REMOTE_LISTEN_ENABLED=true`, `FLEET_PUBLIC_HOSTNAME`,
`FLEET_PUBLIC_LISTEN=0.0.0.0:443`, `FLEET_PUBLIC_URL`, `FLEET_TLS_CERT_FILE=/run/credentials/automaton-fleet.service/tls.crt`,
**no** `FLEET_TLS_KEY_FILE` (`deploy/systemd/automaton-fleet.service.d/remote.conf.example`), plus the four
`FLEET_RUNTIME_*` values and `REAL_REPLICATION_ENABLED=false`.

### 1.5 systemd credential validation (`systemdCredentialProblems`, `secret-files.ts:205-262`)

Applies only to `$CREDENTIALS_DIRECTORY/service.env` (via `loadServiceEnv`) and
`$CREDENTIALS_DIRECTORY/tls.key` (via `loadTls` when `FLEET_TLS_KEY_FILE` is unset). Every condition must hold:

1. `CREDENTIALS_DIRECTORY` set (`:212-213`).
2. Process runs as a systemd service: unit name from `/proc/self/cgroup` (line `0::…` or `…:name=systemd:…`, leaf must match `/^[A-Za-z0-9:_.@\\-]+\.service$/`) (`:169-181`).
3. Unit name equals `automaton-fleet.service` (`FLEET_SYSTEMD_UNIT`, `:33, :215`).
4. `CREDENTIALS_DIRECTORY` is absolute, normalized, and exactly `/run/credentials/automaton-fleet.service` (`:216-219`).
5. Credential name is a bare name and one of `SYSTEMD_SECRET_CREDENTIALS` = `{service.env → /etc/automaton-fleet/service.env, tls.key → /etc/automaton-fleet/tls/fleet.key}` (`:58-61, :220-221`).
6. File path is exactly `<dir>/<name>` (`:222-223`).
7. Directory: `realpath` equals itself (no symlink), is a directory, owned by uid 0 or the process uid, not group/world-writable (`mode & 0o022`) (`:227-235`).
8. File: not a symlink, regular file, `realpath` equals expected, `nlink === 1`, owned by uid 0 or process uid, no world bits (`mode & 0o007`), no group write/exec (`mode & 0o030`) — so `0440`, `0400`, `0600` accepted; `0444`, `0460`, `0660`, `0450` refused (`:236-249`).
9. Source file (`/etc/automaton-fleet/service.env` or `/etc/automaton-fleet/tls/fleet.key`): regular, not symlink, owned by uid 0, `mode & 0o077 == 0`; `EACCES` on stat is tolerated (source hidden from the process) (`:252-260`).

Strict secret-file rule (`secretFileProblems`, `secret-files.ts:111-127`): symlink refused, non-regular refused,
any world bit refused, any group bit refused unless `allowGroupRead` (then group write/exec refused).
The service never passes `allowGroupRead`.

### 1.6 `startFleetServiceFromEnv` — ordered startup refusals (`main.ts:194-329`)

Every step either passes or throws; a throw ends in `startup_failed` + exit 1. Database pools created in step 11
are closed on any later failure (`main.ts:325-328`).

| # | Check | Refusal message (exact prefix) | Source |
|---|---|---|---|
| 1 | effective uid 0 | `The fleet service must not run as root.` | `main.ts:173-174, 199-200` |
| 2 | `FLEET_SERVICE_EXPECTED_USER` set and `os.userInfo().username` differs | `The fleet service must run as <expected> (running as <user>).` | `main.ts:175-176` |
| 3 | `FLEET_ADMIN_DATABASE_URL` non-blank | `The fleet service must not hold FLEET_ADMIN_DATABASE_URL (admin credentials are for the operator CLI only).` | `main.ts:201-203` |
| 4 | no service DSN | `FLEET_SERVICE_DATABASE_URL (restricted controller role) is not configured.` | `main.ts:206` |
| 5 | no agent DSN | `FLEET_AGENT_DATABASE_URL (restricted agent role) is not configured.` | `main.ts:207` |
| 6 | agent DSN username unparsable, or equal to service DSN username | `FLEET_AGENT_DATABASE_URL must use the restricted agent role, not the controller/admin user.` | `main.ts:208-210` |
| 7 | TLS material (`loadTls`, section 1.7) | `Both FLEET_TLS_CERT_FILE and FLEET_TLS_KEY_FILE are required for TLS.` / `Refusing TLS certificate: …` / `Refusing TLS key: …` | `main.ts:96-118, 211` |
| 8 | remote requested without TLS | `FLEET_REMOTE_LISTEN_ENABLED=true requires FLEET_TLS_CERT_FILE and FLEET_TLS_KEY_FILE.` | `main.ts:212-213` |
| 9 | remote config (`loadRemoteConfig`, section 1.7) | various | `main.ts:153-170, 214` |
| 10 | listen address (`parseListen`) | `FLEET_API_LISTEN must be host:port …` / `must be a loopback address …` / `port out of range` | `main.ts:74-87, 216` |
| 11 | construct `PgFleetStore` (service DSN, `applicationName: "automaton-fleet-service"`) and `PgAgentGateway` (agent DSN) | — | `main.ts:223-224` |
| 12 | `controller.health()` not ok (schema ≠ 8, counters inconsistent, unreachable) | `Fleet registry unhealthy: <error> (run pnpm fleet:migrate).` | `main.ts:231-232` |
| 13 | service DSN is schema owner or superuser | `FLEET_SERVICE_DATABASE_URL must use the restricted service role (fleet_service_login), not the schema owner|a superuser <user>.` | `main.ts:233-238`, `store.ts:609-617` |
| 14 | agent role self-check (`PgAgentGateway.selfCheck`) non-empty | `Agent DB role is not restricted: …` | `main.ts:239-240`, `agent-gateway.ts:119-145` |
| 15 | effective privilege audit (`auditPrivileges` + `problemsFor`) for roles `[FLEET_AGENT_ROLE, agent login, FLEET_SERVICE_ROLE, service login]` | `Database privileges are too broad: …` | `main.ts:241-243`, `privileges.ts:374-376` |
| 16 | pinned release present and registry-approved runtime present and `!sameRelease` | `Runtime release mismatch: service pins <repo>@<commit> (build <id>) but the registry approves … Refusing to start.` | `main.ts:245-252` |
| 17 | pinned release absent | **not a refusal**: log `warn runtime_release_unpinned {reason, effect: "claims and activations are refused"}` | `main.ts:253` |

Agent self-check detail (`agent-gateway.ts:119-145`): problems if the connected role is superuser, has
`CREATEROLE`, has `CREATEDB`, owns the schema, holds any of `SELECT/INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER/REFERENCES`
on any relation (`relkind IN ('r','v','m','p','S')`) in the schema, or has `CREATE` on the schema.

`problemsFor` filter (`privileges.ts:374-376`): keeps audit problems that start with `PUBLIC`, start with
`"<role> "` or `"role <role> "` for any of the four roles, or contain `" is not SECURITY DEFINER"` or
`" does not pin search_path"`.

**Question from the brief — "refuses if admin.env readable?"** The service code does **not** test whether
`/etc/automaton-fleet/admin.env` is readable. It refuses only if `FLEET_ADMIN_DATABASE_URL` appears in its merged
environment (step 3), and `loadServiceEnv` never reads `admin.env`. Readability is prevented by the unit:
`InaccessiblePaths=-/home/automaton-agent -/etc/automaton-fleet/admin.env` (`deploy/systemd/automaton-fleet.service`).
(The root witness, by contrast, does test readability of `admin.env`, `service.env`, `tls/fleet.key` and
`legacy-env-fleet.bak`: `src/fleet/dry-run/root-witness.ts:145-158`.)

After the refusals (`main.ts:255-294`):

18. `createAuditSink(log, FLEET_AUDIT_LOG)`: if a file is given it is opened with `fs.openSync(file, "a", 0o600)` and closed (creates it `0600` if missing) (`log.ts:154-160`).
19. `FleetService` constructed with `realReplicationEnabled`, `reaperIntervalMs`, `drainMs`, audit sink, `release`, `tls`, `allowedOrigins` and a `readinessChecks` closure that re-runs the privilege audit at most every **60 000 ms** (cached `privCache`) (`main.ts:257-276`).
20. Listeners (section 3). 21. `service.startReaper()` (section 8). 22. log `info service_started {url, publicUrl, dbUser, realReplicationEnabled, runtimeRelease: "<repo>@<commit>"|null, pid}` (`main.ts:287-294`).
23. Signal handlers (section 13).

### 1.7 TLS and remote configuration

`loadTls(e)` (`main.ts:96-118`):

- `certFile = FLEET_TLS_CERT_FILE`, `explicitKey = FLEET_TLS_KEY_FILE`, `keyFile = explicitKey || (CREDENTIALS_DIRECTORY && certFile ? $CREDENTIALS_DIRECTORY/tls.key : "")`.
- Neither → `null` (no TLS). Only one → throw.
- The certificate path must not equal `$CREDENTIALS_DIRECTORY/service.env` or `…/tls.key`, nor `/etc/automaton-fleet/service.env` or `/etc/automaton-fleet/tls/fleet.key` (a public cert must never name a secret) (`main.ts:106-112`).
- Explicit key → `secretFileProblems` (strict 0600); implicit key → `systemdCredentialProblems(keyFile, "tls.key", credDir, "/etc/automaton-fleet/tls/fleet.key")` (`main.ts:113-116`).
- Returns `{cert, key}` buffers.

`loadRemoteConfig(e, tls)` (`main.ts:153-170`):

- `FLEET_ALLOWED_ORIGINS` entries must match `/^https:\/\/[^/\s]+$/` (checked even when remote is off).
- Remote off and `FLEET_PUBLIC_LISTEN` set → throw `FLEET_PUBLIC_LISTEN requires FLEET_REMOTE_LISTEN_ENABLED=true.`
- Remote on: TLS required; `FLEET_PUBLIC_HOSTNAME` must match
  `/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i` (`main.ts:144`).
- `tlsProblemsForHost(tls, hostname)` (`main.ts:125-142`): certificate parses; `checkHost`/`checkIP` covers the hostname;
  `validFrom <= now`; `validTo >= now + 86 400 000 ms` (at least one day left); `checkPrivateKey` matches. Any problem →
  `Refusing remote listener: …`.
- Returns `{hostname, publicListen: parseListen(FLEET_PUBLIC_LISTEN, {remoteAllowed: true}) | null, allowedOrigins}`.

Observation: certificate validity is checked **only at startup**. There is no reload or periodic re-check; a
running process keeps serving the certificate it loaded.

`parseListen(value, {remoteAllowed})` (`main.ts:74-87`): default `127.0.0.1:8787`; regex
`/^(\[[^\]]+\]|[^:]+):(\d{1,5})$/`; host must be in `{"127.0.0.1","::1","[::1]","localhost"}` unless
`remoteAllowed`; port `0..65535`; `localhost` normalized to `127.0.0.1`; brackets stripped.
For `FLEET_API_LISTEN`, `remoteAllowed = remoteRequested && !!tls && !remote?.publicListen` (`main.ts:216`): when a
separate public listener exists, `FLEET_API_LISTEN` is forced to loopback.

---

## 2. Database connections

| Pool | Class | DSN | Pool settings | Source |
|---|---|---|---|---|
| controller | `PgFleetStore` | `FLEET_SERVICE_DATABASE_URL` | `max 4`, `connectionTimeoutMillis 10000`, `idleTimeoutMillis 10000`, `allowExitOnIdle`, `application_name automaton-fleet-service`, options `-c search_path=<schema> -c lock_timeout=5000 -c statement_timeout=10000 -c idle_in_transaction_session_timeout=30000` | `store.ts:405-430`, `main.ts:223` |
| agent | `PgAgentGateway` | `FLEET_AGENT_DATABASE_URL` | `max 8`, `connectionTimeoutMillis 10000`, `idleTimeoutMillis 10000`, `allowExitOnIdle`, `application_name automaton-fleet-agent-api`, options `-c statement_timeout=10000 -c lock_timeout=5000`; functions called schema-qualified | `agent-gateway.ts:88-112` |

Both pools swallow idle-client `error` events (`store.ts:429`, `agent-gateway.ts:101`).

`PgFleetStore` transaction discipline (`store.ts:485-527`): every call checks `max(version)` of
`fleet_schema_migrations` equals `FLEET_PG_SCHEMA_VERSION = 8` once per store (`store.ts:467-482`,
`migrations.ts:20`); writes run in `BEGIN … COMMIT` (READ COMMITTED); connection-class errors (SQLSTATE `08*`,
`57P0*`, `53*`, `55P03`, `57014`, errnos `ECONNREFUSED ECONNRESET ETIMEDOUT ENOTFOUND EHOSTUNREACH EAI_AGAIN EPIPE`,
or message matching `/timeout|Connection terminated|ECONNREFUSED|connection is closed/i`) become
`FleetRegistryUnavailableError` and the client is discarded (`store.ts:376-387`).

What each role can do (granted by `pnpm fleet:migrate` / `grant-*-role`):

| Role | Grants | Source |
|---|---|---|
| service (`fleet_service`) | `USAGE` on schema; `SELECT` on `fleet_schema_migrations, fleet_state, fleet_agents, fleet_reservations, fleet_events, fleet_sandbox_terminations, fleet_provisioning, fleet_orphans, fleet_wallet_custody, fleet_health_challenges` (not `fleet_agent_credentials`); `EXECUTE` on the 16 `svc_*` functions | `store.ts:793-812`, `migrations.ts:1126-1157` |
| agent (`fleet_agent`) | `USAGE`; `EXECUTE` on the 10 `api_*` functions only | `store.ts:772-786`, `migrations.ts:1160-1171` |

`SERVICE_API_FUNCTIONS` (`migrations.ts:1126-1143`): `svc_claim(text,text,text,bigint,text)`,
`svc_activate(text,text,text,text,text,text,jsonb,text,text)`, `svc_verification_failed(text,text,text)`,
`svc_release(text,text,text)`, `svc_mark_dead(text,text,text,text)`, `svc_heartbeat(text)`, `svc_reap(text)`,
`svc_record_event(text,text,text,jsonb)`, `svc_child_terminal(text,text,text)`, `svc_terminations_due(integer)`,
`svc_termination_result(text,text,text,text)`, `svc_consume_nonce(text,text,integer)`,
`svc_provision_update(text,text,text,text)`, `svc_provision_reconcile(text,text,text,text)`,
`svc_issue_challenge(text,text,text,text)`, `svc_answer_challenge(text,text,text,text,text,boolean)`.

`AGENT_API_FUNCTIONS` (`migrations.ts:1160-1171`): `api_fleet_state()`, `api_member_addresses()`,
`api_whoami(text,text)`, `api_heartbeat(text,text)`, `api_request_replication(text,text,text,text,text,text)`,
`api_release_reservation(text,text,text,text)`, `api_set_own_status(text,text,text,text)`,
`api_open_session(text,text,text)`, `api_propose_allocation(text,text,text,text,bigint,bigint,integer)`,
`api_request_spend(text,text,text,text,text,bigint,text,text)`.

Consequence: the `PgFleetStore` methods that write tables directly with `INSERT`/`UPDATE` (e.g. `setMaxAgents`,
`setOperatingMode`, `registerRoot`, `issueCredential`, `quarantine` → `fleet_begin_termination`, `resolveOrphan`,
`setLifecyclePolicy`, `reserveSlot`→`fleet_reserve_slot`, `reserveDryRunSlot`) fail with the service role
(no table write privilege, no `EXECUTE` on internal functions). They are operator-CLI methods and only work with
`FLEET_ADMIN_DATABASE_URL` (`src/fleet/postgres/cli.ts`). The service only calls `svc_*` and `api_*`.

---

## 3. HTTP and HTTPS listeners

### 3.1 Binding (`server.ts:309-338`, `main.ts:277-285`)

| Mode | `FLEET_API_LISTEN` listener | Public listener |
|---|---|---|
| No TLS | plain HTTP on `FLEET_API_LISTEN` (loopback enforced twice: `parseListen` and `bind`) | none |
| TLS, remote off | **HTTPS** on `FLEET_API_LISTEN` (loopback only) | none |
| TLS, remote on, no `FLEET_PUBLIC_LISTEN` | HTTPS on `FLEET_API_LISTEN` (may be non-loopback) | — |
| TLS, remote on, `FLEET_PUBLIC_LISTEN` set | `listenAdmin`: plain HTTP, **must be loopback** (`server.ts:317-320`) | `listen`: HTTPS on `FLEET_PUBLIC_LISTEN`; `publicUrl = https://<FLEET_PUBLIC_HOSTNAME>:<port>` |

`bind()` refuses plain HTTP on any non-loopback host: `Refusing plain-HTTP binding on non-loopback address <host>: remote access requires TLS.`
(`server.ts:322-325`). Loopback test: host (brackets stripped) ∈ `{127.0.0.1, ::1, ::ffff:127.0.0.1}` or `localhost`
(`server.ts:205-210`). HTTPS servers: `https.createServer({cert, key, minVersion: "TLSv1.2"})` (`server.ts:327-329`).
No `maxVersion`, cipher list, `requestTimeout`, `headersTimeout` or `keepAliveTimeout` is set; Node defaults apply.

systemd layer: `IPAddressDeny=any`, `IPAddressAllow=localhost` in the base unit; the remote drop-in resets them
to `IPAddressAllow=any` and grants `CAP_NET_BIND_SERVICE` only, and adds `LoadCredential=tls.key:/etc/automaton-fleet/tls/fleet.key`
and `LoadCredential=tls.crt:/etc/automaton-fleet/tls/fleet.crt` (`deploy/systemd/automaton-fleet.service.d/remote.conf.example`).

<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->
Repo expectation for production (per CLAUDE.md/runbook): HTTPS on `0.0.0.0:443` (Let's Encrypt cert for
`api.agentfleet.vip`), plain HTTP admin on `127.0.0.1:8787`, `FLEET_REMOTE_LISTEN_ENABLED=true`.

### 3.2 Per-request pipeline (`server.ts:555-632`)

1. `path = req.url.split("?")[0]` — query strings are ignored for routing **and for signing**.
2. Headers on every response: `cache-control: no-store`, `x-content-type-options: nosniff`; on TLS listeners also
   `strict-transport-security: max-age=31536000` (`server.ts:557-559`).
3. **Origin check** (`server.ts:561-576`): if an `Origin` header is present and not in `allowedOrigins` → audit
   `api_origin_denied {path, ip}` → `403 {"ok":false,"code":"FLEET_ORIGIN_DENIED","reason":"origin not allowed"}`.
   This runs before `/healthz`. Allowed origin → `access-control-allow-origin: <origin>`, `vary: origin`; an
   `OPTIONS` request then gets `204` with `access-control-allow-methods: GET, POST` and
   `access-control-allow-headers: authorization, content-type, x-fleet-timestamp, x-fleet-nonce, x-fleet-signature`.
   Requests without `Origin` (all agents) skip this block.
4. **Host header check: NOT IMPLEMENTED.** No code reads `req.headers.host`; any Host value is accepted.
5. `GET /healthz` (section 4).
6. Draining → `connection: close`, `503 {"ok":false,"code":"FLEET_SERVICE_DRAINING","reason":"fleet service is shutting down"}`.
7. `inFlight++`, `handleInner`, `inFlight--`.
8. `handleInner`: `GET /readyz` (section 4); otherwise a request context `{raw, ip, requestId: crypto.randomUUID(), agentId: null, status: 200}`;
   body read with a **64 KiB** limit (`maxBodyBytes ?? 65536`, over-limit → `413 FLEET_BAD_REQUEST "request body too large"`) (`server.ts:407-417`);
   `route()`; success → `200 {"ok":true, ...handlerResult}`; every response carries `x-request-id`.
9. `finally`: audit `api_request {requestId, method, path, status, ms, ip}` (no bodies, no tokens) (`server.ts:621-631`).

JSON body rules (`server.ts:419-428`): empty body → `{}`; otherwise must parse to a non-array object, else
`400 FLEET_BAD_REQUEST "body must be a JSON object"`. Only POST routes parse the body.

String field validator `str(body, key, max, required=true)` (`server.ts:191-198`): value must be a string of length
`1..max`; optional fields may be `undefined` (returns `""`); anything else → `400 FLEET_BAD_REQUEST "<key> must be a string of 1..<max> characters"`.

### 3.3 Error mapping (`sendError`, `server.ts:634-661`)

| Thrown | HTTP | Body `code` | Body `reason` |
|---|---|---|---|
| `HttpError(status, code, msg)` | `status` (+ `retry-after` header if set) | `code` | `msg` |
| `FleetRuntimeError` | 409 | `FLEET_RUNTIME_UNVERIFIED` | message |
| `FleetBypassError` | 403 | `FLEET_NOT_AUTHORIZED` | message |
| `FleetDuplicateRegistrationError` | 409 | `FLEET_DUPLICATE_REGISTRATION` | message |
| `FleetRegistryUnavailableError` | 503 | `FLEET_REGISTRY_UNAVAILABLE` | `registry unavailable` |
| PG SQLSTATE `42501` or `42883` | 500 | `FLEET_DB_AUTHORIZATION_FAILED` | `database refused the operation` (+ DB event `db_authorization_failed {path, pgCode, message}`) |
| other, message matches `/ECONNREFUSED|timeout|terminated|connect/i` | 503 | `FLEET_REGISTRY_UNAVAILABLE` | `registry unavailable` |
| other | 400 | `FLEET_REQUEST_FAILED` | first 300 chars of the message (+ audit `api_error`) |

All error bodies have the shape `{"ok":false,"code":…,"reason":…}`.

---

## 4. `/healthz` and `/readyz`

### 4.1 `GET /healthz` (`server.ts:577-584`)

- Any peer, any listener, no authentication, no DB access. Subject only to the Origin check (a foreign `Origin` gets 403).
- Not draining: `200 {"ok":true,"status":"alive","uptimeS":<round((now-startedAt)/1000)>}`.
- Draining: `503 {"ok":false,"status":"draining","uptimeS":…}`.
- Served even while draining (checked before the draining gate). No `api_request` audit line (it returns before `handleInner`).

### 4.2 `GET /readyz` (`server.ts:599-608, 361-394`)

- Only when `req.socket.remoteAddress ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1}`; any other peer gets
  `404 {"ok":false,"code":"FLEET_NOT_FOUND","reason":"no such endpoint"}` (so it is 404 on the public listener from outside).
- Returns `200` when ready, `503` otherwise, body `{"ok":ready, "ready", "draining", "realReplicationEnabled", "checks":{…}}`.
- `ready = !draining && every check.ok`. Checks:

| Check | ok / warn / detail |
|---|---|
| `database` | `admin.health()`; detail `schema v<N>` or the error (health requires schema 8 and consistent counters, `store.ts:626-669`) |
| `agentApi` | `api_fleet_state()` via the agent role succeeds |
| `runtimeRelease` | state unavailable → not ok; no release and none approved → ok+warn "no runtime release pinned and none approved (replication impossible)"; approved but no release → **not ok**; release but none approved → ok+warn; both → ok iff `sameRelease` (detail `<repo>@<commit>` or the mismatch) |
| `reaper` | interval ≤ 0 → ok+warn "background reaper disabled"; else ok iff last successful pass age ≤ `max(3 × interval, 60 000 ms)` (= 60 s at the default 15 s) |
| `sandboxTermination` | always ok; warn with "sandbox termination is not supported; dead agents' sandboxes may keep running" unless `terminator.guaranteed` |
| `privileges` | from `readinessChecks`: privilege audit, cached 60 s (`main.ts:269-275`) |

Counter consistency SQL (`store.ts:648-654`):

```sql
SELECT s.living_agents = (SELECT count(*) FROM fleet_agents WHERE status IN ('active','unresponsive','terminating'))
   AND s.reserved_slots = (SELECT count(*) FROM fleet_agents WHERE status IN ('reserved','provisioning'))
   AND s.quarantined_slots = (SELECT count(*) FROM fleet_agents WHERE status = 'orphaned')
   AS consistent
  FROM fleet_state s WHERE s.id = 1
```

---

## 5. Route table (`ROUTE_POLICY`, `server.ts:83-102`)

Route authorization is default-deny: `route()` first calls `authorize()`, which looks up `"METHOD /path"` in a frozen
policy table; no entry → `404 FLEET_NOT_FOUND "no such endpoint"` (`server.ts:523-527`). `routeDecision`
(`server.ts:109-116`): public → allow; scope `full` → allow; scope `witness` → allow only if `witness: true`; any other
scope → deny.

| Method + path | Auth | Witness scope | Credential check in handler | DB function(s) |
|---|---|---|---|---|
| `GET /v1/health` | public | n/a | none | `admin.health()` (service role SELECTs) |
| `GET /v1/state` | session | denied | `authenticate` (`api_whoami`) | `api_fleet_state()` |
| `GET /v1/members` | session | denied | `authenticate` | `api_member_addresses()` |
| `GET /v1/self` | session | **allowed** | `authenticate(allowDead=true)` | `api_whoami` |
| `POST /v1/session` | bearer (`fa1.`) | **allowed** | `bearer` | `api_open_session` |
| `POST /v1/heartbeat` | session | **allowed** | `credentials` | `api_heartbeat`, then `svc_issue_challenge` |
| `POST /v1/health/challenge` | session | **allowed** | `authenticate` | `svc_answer_challenge` |
| `POST /v1/status` | session | denied | `credentials` | `api_set_own_status` |
| `POST /v1/replication/request` | session | denied | `credentials` | service switch, then `api_request_replication` |
| `POST /v1/replication/claim` | session | denied | `authenticate` | `svc_claim` |
| `POST /v1/replication/provisioning` | session | denied | `authenticate` | `svc_provision_update` |
| `POST /v1/replication/activate` | session | denied | `authenticate` | `svc_activate` |
| `POST /v1/replication/fail` | session | denied | `authenticate` | `svc_verification_failed` |
| `POST /v1/replication/reconcile` | session | denied | `authenticate` | `svc_provision_reconcile` |
| `POST /v1/replication/release` | session | denied | `credentials` | `api_release_reservation` |
| `POST /v1/children/terminal` | session | denied | `authenticate` | `svc_child_terminal` |
| `POST /v1/capital/propose` | session | denied | `credentials` | `api_propose_allocation` |
| `POST /v1/wallet/spend-request` | session | denied | `credentials` | `api_request_spend` |

`/healthz` and `/readyz` are handled before the route table (section 4) and are not in `ROUTE_POLICY`.

Scope enforcement in `authorize` (`server.ts:523-540`): after the caller is identified (bearer or signed session),
`capabilityScope(agentId)` is read with the service role (`store.ts:1609-1614`). Unknown agent → return (the handler
rejects). Allowed → continue. Denied → the credential is verified for real with `api_whoami` (so an invented token
cannot forge `scope_denied` events); gone agent → 410; bad credential → 401; valid → DB event
`scope_denied {method, path, scope, layer: "service", ip}` and `403 FLEET_SCOPE_DENIED`.

### 5.1 Per-route request and response schemas

All responses are `200 {"ok":true, …}` on success. Field limits are `str()` maximum lengths.

**`GET /v1/health`** → `{health: {ok, latencyMs, schemaVersion, countersConsistent, error?}}`. The outer status is 200
even when `health.ok` is false.

**`GET /v1/state`** → `{state: {livingAgents, reservedSlots, quarantinedSlots, maxAgents (min(max,50)), operatingMode, runtime: {repo, commit}|null, updatedAt, replicationEnabled, build: {buildId, lockfileSha256}|null}}` (`agent-gateway.ts:41-53`).

**`GET /v1/members`** → `{addresses: string[]}` — lower-cased wallet addresses of **every** agent, any status (`migrations.ts:645-648`).

**`GET /v1/self`** → `{agent: SharedAgentRecord, dead: boolean}`; dead/quarantined agents get their record with `dead: true`.

**`POST /v1/session`** — header `Authorization: Bearer fa1.<agentId>.<43 base64url>`; body ignored.
Rate limit `sessions` per agent id. `sessionToken = mintSessionToken(agentId)`; only `sha256(sessionToken)` is sent to
`api_open_session`. Response `{sessionToken: "fs1.<agentId>.<43 base64url>", expiresAt: ISO}`.
Refusal: `FLEET_AGENT_DEAD`/`FLEET_AGENT_QUARANTINED` → `410`; any other code → `authFailure` → `401 FLEET_AUTH_FAILED "session refused (<code>)"` (`server.ts:702-714`).

**`POST /v1/heartbeat`** — body ignored. Response `{alive: boolean, status: string|null, code: string|null, challenge: {challengeId, nonce, canary, expiresAt}|null}`.
`FLEET_AUTH_FAILED` / `FLEET_SESSION_EXPIRED` → `401`. `FLEET_AGENT_DEAD` / `FLEET_AGENT_QUARANTINED` are returned as
`200` with `alive:false` and `code` set. A challenge is issued (best effort, errors swallowed) only when `alive` (`server.ts:796-805`).

**`POST /v1/health/challenge`** — body `{challengeId (1..26), nonce (1..64), commit? (≤40), buildId? (≤64), policyOk: boolean (only literal true counts)}`.
Response `{passed: true}`. Failure → `409` with code `FLEET_NOT_AUTHORIZED` | `FLEET_CHALLENGE_USED` | `FLEET_CHALLENGE_EXPIRED` | `FLEET_CHALLENGE_FAILED` (`server.ts:716-727`).

**`POST /v1/status`** — body `{status (1..32), reason? (≤300)}`. `status == "dead"` → retirement (`fleet_mark_dead`, cause `self_reported`, audit `agent_died`); `"active"` → heartbeat; anything else → `FLEET_INVALID_TRANSITION`. Refusal `401` for `FLEET_AUTH_FAILED`, else `403`. Response `{changed}`.

**`POST /v1/replication/request`** — body `{name (1..128), requestKey? (≤64; default ulid())}`.
If service `REAL_REPLICATION_ENABLED` is false: DB event `replication_rejected {parentAgentId, code: "REAL_REPLICATION_DISABLED", by: "service"}` and
`403 REAL_REPLICATION_DISABLED "The fleet service has REAL_REPLICATION_ENABLED=false."` (`server.ts:817-835`). Otherwise
`api_request_replication(agent, token, name, requestKey, ulid(), ulid())`; refusal status `401` (`FLEET_AUTH_FAILED`), `410` (`FLEET_AGENT_DEAD`), else `409`.
Response `{reservation: {ok, agentId, reservationId, parentAgentId, generation, expiresAt, runtime, build}}`.

**`POST /v1/replication/claim`** — body `{reservationId (1..26, must match ULID /^[0-9A-HJKMNP-TV-Z]{26}$/), localChildId (1..64)}`.
Unknown or non-matching reservation → `404`. If the caller is the lease parent, `enforceRelease` (section 9.3). Then
`svc_claim(lease.agentId, localChildId, parent=caller, ttl=null, nonce=newAttestationNonce())`; refusal → DB event
`claim_denied` and `403 FLEET_NOT_AUTHORIZED`. Response `{claimed: {agentId, parentAgentId, generation, runtime: {repo, commit}, expectedBuild: {buildId, lockfileSha256}, nonce, reservationId, provisioningKey, backend: "postgres"}}` (function members are dropped by JSON).

**`POST /v1/replication/provisioning`** — body `{reservationId (1..26), phase ∈ {sandbox_intent, sandbox_created, verifying}, provisioningKey? (≤26, must equal reservationId), sandboxName (1..64, intent only), sandboxId? (≤128)}`.
`ownLease` check (caller is the lease parent, key matches) else DB event `authorization_denied` and `403` (`server.ts:664-672`).
Intent response `{recorded: true, intent: {sandboxName, sandboxId, attempts}}`; others `{recorded: true}`.

**`POST /v1/replication/reconcile`** — body `{reservationId, outcome ∈ {found, absent, unknown} (≤16), sandboxId?, provisioningKey?}`; `ownLease`; response `{reconciled: true, agentStatus}`.

**`POST /v1/replication/activate`** — body `{reservationId, provisioningKey? (must equal reservationId, else 403), walletAddress (1..64), sandboxId? (≤128), runtimeCommit? (≤40), runtimeVersion? (≤64), attestation? (object, passed through sanitizeAttestation)}`.
Response `{agent: SharedAgentRecord, credential: {agentId, token: "fa1.…"}}` — the **child's** long-lived credential is returned to the parent, which delivers it into the child sandbox (`src/replication/spawn.ts:560-573`). Audit `agent_activated {parentAgentId}`.

**`POST /v1/replication/fail`** — body `{reservationId, reason (1..500)}`; the caller must be the lease parent, else DB event `authorization_denied` + `403`; response `{released: boolean}`.

**`POST /v1/replication/release`** — body `{reservationId, reason? (≤300)}`; response `{released}`; refusal `401`/`403`.

**`POST /v1/children/terminal`** — body `{localChildId (1..64), state? (≤32)}`; response `{recorded: true, outcome: "released"|"dead"|"deferred"|"already_terminal", changed: boolean}`; not own child → `403`.

**`POST /v1/capital/propose`** — body `{purpose (1..500), requestedCents (safe int > 0), expectedReturnCents (safe int ≥ 0, default 0), expectedDurationDays (safe int; no sign check in the service)}`; response `{allocation: {ok, allocationId, status: "proposed"}}`; refusal `401`/`403`.

**`POST /v1/wallet/spend-request`** — body `{fromWallet (1..64), toAddress (1..64), amountCents (safe int > 0), purpose (1..300), allocationId? (≤26)}`; response `{decision: "denied"|"approved_not_executed", reason, executed: false}`. A `denied` decision is a `200`. Nothing is signed or sent (`server.ts:792-793`).

---

## 6. Authentication, sessions, request signing, replay protection

### 6.1 Token formats (`src/fleet/postgres/store.ts:93-118`)

| Token | Regex | Minted by | Stored |
|---|---|---|---|
| long-lived credential | `/^fa1\.([0-9A-HJKMNP-TV-Z]{26})\.[A-Za-z0-9_-]{43}$/` | `fa1.<agentId>.<randomBytes(32) base64url>` | `sha256(token)` hex in `fleet_agent_credentials.token_hash` |
| short-lived session | `/^fs1\.([0-9A-HJKMNP-TV-Z]{26})\.[A-Za-z0-9_-]{43}$/` | `fs1.<agentId>.<randomBytes(32) base64url>` | `sha256(token)` hex in `fleet_agent_sessions.session_hash` |

The agent id is embedded in the token; the service extracts it with the regex **before** any DB lookup.

### 6.2 Credential paths in the service

- `bearer()` (`server.ts:457-466`): header must match `/^Bearer (\S{1,256})$/` and the token the `fa1` regex; else `authFailure` "missing bearer token" / "malformed token". Used only by `POST /v1/session` (unless `allowLegacyBearer`, default `false`, `server.ts:151`).
- `credentials()` (`server.ts:476-512`), used by every session route:
  1. header `/^FleetSession (\S{1,256})$/`; absent → `authFailure(... "FLEET_SESSION_REQUIRED")` (a `Bearer` header gets reason "session required (long-lived credential only opens sessions)").
  2. `agentIdFromSessionToken` (fs1 regex) else "malformed session token".
  3. `rateLimit(perAgent, agentId)` — **before** signature verification.
  4. `x-fleet-timestamp` must match `/^\d{10,16}$/` and `|now − ts| ≤ maxSkewMs` (**60 000 ms**) else `authFailure(... "FLEET_REQUEST_STALE")` (401).
  5. `x-fleet-nonce` must match `/^[A-Za-z0-9_-]{16,64}$/` and `x-fleet-signature` `/^[0-9a-f]{64}$/` else "missing request signature".
  6. `expected = signRequest(sessionToken, method, path, ts, nonce, rawBody)`; compared with `crypto.timingSafeEqual` else "bad request signature".
  7. `consumeNonce(agentId, nonce, ceil(2 × skew / 1000) = 120 s)`; already used → DB event `request_replay_blocked {path, ip}` and `409 FLEET_REQUEST_REPLAYED "request nonce already used"`.
  8. Memoised in `ctx.cred` so `authorize` and the handler consume the nonce exactly once per request.
- `authenticate()` (`server.ts:543-553`): `credentials()` + `api_whoami(agentId, sessionToken)`; `FLEET_AGENT_DEAD`/`FLEET_AGENT_QUARANTINED` → `410` (or the record when `allowDead`); other failure → audit `api_auth_failed {path, code}` and `401`.
- The DB then validates the session itself in `fleet_authenticate` (section 6.5).

`authFailure` (`server.ts:441-447`): writes DB event `api_auth_failed {path, why, ip}`, then takes one token from the
per-IP `authFailures` bucket; bucket empty → `429 FLEET_RATE_LIMITED "too many failed authentications"`; otherwise the
given status/code (default `401 FLEET_AUTH_FAILED`).

### 6.3 Canonical request string and HMAC (`src/fleet/service/server-signing.ts:8-18`)

```ts
export const SIG_HEADERS = Object.freeze({ ts: "x-fleet-timestamp", nonce: "x-fleet-nonce", sig: "x-fleet-signature" });

export function canonicalRequest(method, path, ts, nonce, body): string {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  return `${method.toUpperCase()}\n${path}\n${ts}\n${nonce}\n${bodyHash}`;
}

export function signRequest(sessionToken, method, path, ts, nonce, body): string {
  return crypto.createHmac("sha256", sessionToken).update(canonicalRequest(method, path, ts, nonce, body)).digest("hex");
}
```

- Key: the full session token string `fs1.<agentId>.<secret>` (UTF-8).
- `path`: request path **without** query string (server: `req.url.split("?")[0]`; client signs the literal path it requests).
- `ts`: decimal milliseconds since epoch (client: `String(Date.now())`).
- `nonce`: client uses `randomBytes(24).toString("base64url")` (32 chars) (`client.ts:174`).
- `body`: the exact raw request bytes (server) / the exact JSON string sent (client; `""` for no body) — SHA-256 of an empty body for GETs.
- Output: lowercase hex HMAC-SHA256.

### 6.4 Server response signing

**NOT IMPLEMENTED.** The FleetService does not sign responses. `server-signing.ts` contains only request signing;
no response signature header exists in the service or the client (`grep` for `signResponse|x-fleet-response|responseSig`
in `src/` returns no match). Response authenticity rests on TLS (client refuses non-https except loopback,
`client.ts:93-105`, and uses `redirect: "error"`, `client.ts:199`).

### 6.5 Database authentication (`fleet_authenticate`, final version v7: `src/fleet/postgres/migrations-phase7.ts:93-144`)

Returns `NULL` (ok) or a code. Order:

1. `p_agent`/`p_token` null, `length(token) > 256` or `length(agent) > 64` → event `db_auth_failed {action, why: "malformed"}` → `FLEET_AUTH_FAILED`.
2. `v_hash = encode(sha256(convert_to(p_token,'UTF8')),'hex')`; read `status, capability_scope` of the agent.
3. Token `LIKE 'fs1.%'` → session row by hash, must belong to the agent (else `db_auth_failed … why: "bad session"`); otherwise credential row by agent id with matching hash (else `why: "bad credential"`).
4. status `dead`/`failed` → `FLEET_AGENT_DEAD` (no event).
5. status `terminating`/`orphaned` → event `why: "quarantined"` → `FLEET_AGENT_QUARANTINED`.
6. session revoked or credential revoked → event `why: "revoked"` → `FLEET_AUTH_FAILED`.
7. session expired → `FLEET_SESSION_EXPIRED`; a session is also refused (`FLEET_AUTH_FAILED`) if the agent's long-lived credential has been revoked.
8. scope ≠ `full` and not (`witness` and action ∈ `{open_session, heartbeat, whoami}`) → event `scope_denied {action, scope, layer: "database"}` → `FLEET_SCOPE_DENIED`.

### 6.6 Session creation (`api_open_session`, `migrations-phase5.ts:382-404`)

- Refuses a token `LIKE 'fs1.%'` (sessions cannot mint sessions), a null token, or a session hash not matching `^[0-9a-f]{64}$` → event `db_auth_failed {action:"open_session", why:"session tokens cannot open sessions"}`.
- `fleet_authenticate(agent, token, 'open_session')`.
- `expires_at = now() + session_ttl_s` (default **600 s**, CHECK 30..3600).
- At most **8** live sessions per agent: sessions beyond the 7 newest live ones are revoked (`ORDER BY created_at DESC OFFSET 7`) before inserting the new one.
- Event `session_opened {expiresAt}`; returns `{ok, expiresAt, ttlS}`.

Client behaviour (`client.ts:162-189`): reuses a session until less than **30 000 ms** remain; on `401` with code
`FLEET_SESSION_EXPIRED`, `FLEET_AUTH_FAILED` or `FLEET_SESSION_REQUIRED` it drops the session and retries once with a
fresh one; timeout per request **15 000 ms**.

Session revocation: credential rotation (`store.ts:970-977`), any transition into `terminating/orphaned/dead/failed`
(`fleet_agents_lifecycle_effects`, `migrations-phase5.ts:256-263`), the 8-session cap. Purge: reaper deletes sessions
expired more than 1 day (`migrations-phase5.ts:859`).

### 6.7 Replay protection (`svc_consume_nonce`, `migrations-phase5.ts:407-421`)

```sql
INSERT INTO fleet_request_nonces (agent_id, nonce, expires_at)
VALUES (left(p_agent, 64), p_nonce, now() + make_interval(secs => GREATEST(LEAST(p_ttl_s, 3600), 1)))
ON CONFLICT DO NOTHING;
```

`(agent_id, nonce)` is the primary key (`migrations-phase5.ts:170-175`); a conflict writes event
`request_replayed {nonce: first 16 chars}` (actor = agent) and returns false. The ledger is in PostgreSQL, so replay is
refused across service instances and restarts. Expired nonces are deleted by every reaper pass
(`migrations-phase5.ts:858`). The service passes TTL = 120 s (twice the 60 s skew), which covers the whole window in
which a timestamp is still accepted.

### 6.8 Rate limiting (`src/fleet/service/rate-limit.ts`, `server.ts:230-232`)

Token bucket per key, in memory, per service instance; buckets refill continuously; at most **10 000** keys (oldest
evicted).

| Limiter | Key | Capacity | Refill | Applied |
|---|---|---|---|---|
| `perAgent` | agent id from the session token | 60 | 5 / s | every session request, before signature check (`server.ts:493`); legacy bearer path (`:483`) |
| `sessions` | agent id | 10 | 10 / 60 s | `POST /v1/session` (`:705`) |
| `authFailures` | remote IP | 20 | 20 / 60 s | every `authFailure` (`:443`) |

Exceeding `perAgent`/`sessions` → audit `rate_limited {key}` and `429 FLEET_RATE_LIMITED "rate limit exceeded"` with
`retry-after: ceil((1 − tokens) / refill)` seconds.

Observations (risk, not fixed):
- The `perAgent` bucket is keyed by the agent id parsed from an **unverified** session token and is charged before the
  HMAC is verified. Any client that knows an agent id can drain that agent's bucket (60 burst, 5/s) with garbage
  signatures, causing 429s for the real agent on that instance.
- `authFailure` writes a DB event (`api_auth_failed`) **before** consulting the per-IP bucket, so rate-limited
  failures still cost one `fleet_events` insert each.

---

## 7. Registration, enrollment, attestation, heartbeat, health challenges, reservation, activation

### 7.1 Root registration (operator only)

Roots are not self-registering through the API. `FleetApiClient.registerRoot` only confirms an existing identity via
`GET /v1/self` (`client.ts:252-272`). Enrollment is `pnpm fleet:admin enroll-root <wallet> <name> [credentialFile]`
with the admin credential (`src/fleet/postgres/cli.ts:504-514`): `PgFleetStore.registerRoot` then `issueCredential`,
credential written `0600` (`cli.ts:97-103`).

`registerRoot` (`store.ts:892-948`) under the `fleet_state` lock:
- existing wallet (case-insensitive): must be a root with the same capability scope and status `active|unresponsive`
  (else `FLEET_IDENTITY_MISMATCH` / `FLEET_AGENT_DEAD` "the dead are not revived"); then `fleet_heartbeat` and runtime fields update.
- new wallet: `living + reserved + quarantined ≥ min(max_agents, localMax ?? 50)` → event `registration_denied` and
  `FLEET_CAP_REACHED`; else `INSERT … status 'active', generation 0, last_heartbeat now(), capability_scope` and event `root_registered`.

Witness roots: section in volume 16 (`enroll-witness-root`, `cli.ts:140-173`).

### 7.2 Heartbeat (`api_heartbeat` v4 `migrations-phase5.ts:592-604`; `fleet_heartbeat` v4 `:566-587`)

- Authenticates; dead/quarantined → `{ok:false, code, status}`.
- `fleet_heartbeat` locks the agent row only (no fleet-wide lock), never inserts. For `active|unresponsive`:
  - `unresponsive` recovers to `active` (event `agent_recovered`) only if `COALESCE(last_challenge_ok_at, activated_at, created_at) >= now() − health_grace_s` **and** `challenge_failures < max_challenge_failures`.
  - otherwise only `last_heartbeat = now()`.
- API result `ok` is true for `active` and `unresponsive` (an unhealthy agent keeps answering challenges).

Client-side cadence: `SharedFleetController.startHeartbeat(intervalMs = 30 000)` (`shared-controller.ts:200-204`);
root witness 30 000 ms clamped to 10 000..60 000 (`root-main.ts:20-21`); dry-run child 30 000 ms default
(`child-main.ts:16`).

### 7.3 Health challenge (`svc_issue_challenge`, `svc_answer_challenge`, `migrations-phase5.ts:607-698`)

Issue (on every successful heartbeat, `server.ts:803`; `store.ts:1227-1235`):
- nonce `randomBytes(32).toString("base64url")`, only `sha256(nonce)` stored; `challengeId = ulid()`; canary chosen with
  `crypto.randomInt` from `HEALTH_CANARIES` (`store.ts:121-127`):
  `cat /etc/automaton-fleet/service.env`, `cat ~/.automaton/fleet-credentials.json`,
  `psql -c 'GRANT fleet_service TO fleet_agent_login'`, `cat /proc/1/environ`, `sudo scripts/fleet-db-setup.sh --apply`.
- Not issued if the agent is not `active|unresponsive`; if a pending challenge is unexpired ("pending"); if the last
  challenge passed less than `health_challenge_interval_s` (default **60 s**) ago ("not due"). An expired pending challenge is
  expired first (counts as a failure).
- `expires_at = now() + challenge_ttl_s` (default **60 s**, CHECK 5..3600). One pending challenge per agent (unique partial index, `:244`).

Answer (`svc_answer_challenge`):
- wrong agent / unknown id → event `authorization_denied` → `FLEET_NOT_AUTHORIZED`; not pending → `FLEET_CHALLENGE_USED`; expired → expire + `FLEET_CHALLENGE_EXPIRED`.
- Failure reasons in order: agent not living; `sha256(nonce)` mismatch; child: no lease or commit ≠ `expected_commit`; child: buildId ≠ `expected_build_id`; root with `runtime_commit` set: commit ≠ it; `policyOk` not true ("policy canary not blocked").
- Failure → challenge `failed`, `fleet_challenge_failed` (increments `challenge_failures`, event `health_challenge_failed`; at `≥ max_challenge_failures` (default **3**) an `active` agent becomes `unresponsive`, event `agent_unresponsive {cause: "health_challenge"}`), response `FLEET_CHALLENGE_FAILED`.
- Pass → challenge `passed`, `last_challenge_ok_at = now()`, `challenge_failures = 0`; an `unresponsive` agent whose heartbeat is fresh (`≤ heartbeat_unresponsive_s`) returns to `active` (event `agent_recovered {via: "health_challenge"}`).

Client answer (`defaultHealthResponder`, `client.ts:55-68`): commit/buildId from `/root/.automaton/fleet-runtime.json`
(children) or `git rev-parse HEAD` of the running tree (roots); `policyOk = getForbiddenCommandMatch(canary) !== null`
(the canary is pattern-matched, never executed).

### 7.4 Reservation (`fleet_reserve_slot`, final v7 `migrations-phase7.ts:165-236`)

Called by `api_request_replication` (`migrations.ts:681-701`) with `p_local_max = NULL`, `p_ttl_ms = NULL`, `p_match_pin = false`.
Under `fleet_lock_state()` (row lock on `fleet_state`), after `fleet_expire_leases`:

`mx = LEAST(max_agents, COALESCE(p_local_max, 50), 50)`; `occupancy = living + reserved + quarantined`;
`open orphans = count(fleet_orphans WHERE resolved_at IS NULL)`.

| Order | Condition | Code |
|---|---|---|
| 1 | mode `EMERGENCY` or not in (DEVELOPMENT, EXPANSION, HARVEST) | `FLEET_EMERGENCY` |
| 2 | mode `DEVELOPMENT` | `FLEET_DEVELOPMENT_MODE` |
| 3 | mode `HARVEST` | `FLEET_HARVEST` |
| 4 | `NOT replication_enabled` | `REAL_REPLICATION_DISABLED` |
| 5 | `runtime_repo IS NULL OR runtime_build_id IS NULL` | `FLEET_RUNTIME_UNVERIFIED` |
| 6 | `p_match_pin` and pin ≠ approved | `FLEET_RUNTIME_UNVERIFIED` |
| 7 | `open orphans > max_open_orphans` (default 1) | `FLEET_ORPHANS_UNRESOLVED` |
| 8 | parent missing or `status <> 'active'` | `FLEET_PARENT_NOT_LIVING` |
| 9 | parent `capability_scope <> 'full'` | `FLEET_PARENT_SCOPE` |
| 10 | parent custody `spending_frozen` | `FLEET_PARENT_FROZEN` |
| 11 | `request_key` already used | `FLEET_DUPLICATE_REQUEST` |
| 12 | `occupancy >= mx` | `FLEET_CAP_REACHED` |

Denial → event `reservation_denied {code, living, reserved, quarantined, max}`, JSON `{ok:false, code, reason, living, reserved, max}`.
Grant → `INSERT fleet_agents (…, role 'child', generation parent+1, runtime_repo/commit = approved, status 'reserved', request_key, reservation_expires_at)`
and `INSERT fleet_reservations (…, status 'reserved', expires_at, expected_repo/commit/build_id/lockfile = approved)`,
`expires_at = now() + reservation_ttl_s` (default **1800 s**); event `slot_reserved`. `api_request_replication` also writes
`replication_requested` before and `replication_granted` / `replication_rejected` after.

### 7.5 Claim (`svc_claim`, `migrations.ts:897-931`)

- Malformed nonce (`!~ '^[0-9a-f]{64}$'`), null/`>64` local child id → refusal.
- Lock state; lease `FOR UPDATE`; must be `reserved` and unexpired; parent must match.
- Agent `reserved → provisioning`, `local_child_id` set, `reservation_expires_at = now() + provisioning_ttl_s` (default **2700 s**).
- Lease `reserved → provisioning`, `claimed_at`, `attestation_nonce = p_nonce`, `expires_at` reset.
- Trigger `fleet_reservations_provisioning` inserts the `fleet_provisioning` row (`provisioning_id = reservation_id`, `activation_deadline = lease expires_at`) and event `provisioning_started` (`migrations-phase5.ts:463-477`).
- Event `slot_claimed`. Returns expected repo/commit/buildId/lockfile.

### 7.6 Attestation and activation

TypeScript pre-check (`PgFleetStore.activate`, `store.ts:1331-1418`), reading with the DB clock:
agent `provisioning`; lease `provisioning`; lease parent = caller; `provisioningKey` (if given) = reservation id; lease
unexpired; `runtimeCommit === expected_commit`; `checkAttestation` (`attestation.ts:229-249`):
nonce equals lease nonce (64 hex); commit 40-hex equals expected; `normalizeRepoUrl(att.repo) === expected_repo`;
lockfile equal; buildId equal; `clean === true`; `proof === sha256("<nonce>:<commit>:<buildId>:<lockfileSha256>")`.
Any failure → `svc_verification_failed` (slot released as failed) and rethrow.

Then a new `fa1` token is minted and `svc_activate` is called with `sha256(token)` (`store.ts:1385-1400`).
Authoritative SQL re-check (`svc_activate`, `migrations.ts:937-1002`) under the fleet lock, first failing test wins:

```sql
IF jsonb_typeof(att) IS DISTINCT FROM 'object' THEN v_fail := 'no attestation';
ELSIF p_runtime_commit IS DISTINCT FROM l.expected_commit THEN v_fail := 'reported commit does not match the lease';
ELSIF l.attestation_nonce IS NULL OR att->>'nonce' IS DISTINCT FROM l.attestation_nonce THEN v_fail := 'nonce does not match the lease';
ELSIF att->>'commit' IS DISTINCT FROM l.expected_commit THEN v_fail := 'attested commit does not match the lease';
ELSIF att->>'repo' IS DISTINCT FROM l.expected_repo THEN v_fail := 'attested repository does not match the lease';
ELSIF att->>'lockfileSha256' IS DISTINCT FROM l.expected_lockfile_sha256 THEN v_fail := 'attested lockfile does not match the lease';
ELSIF att->>'buildId' IS DISTINCT FROM l.expected_build_id THEN v_fail := 'attested build id does not match the lease';
ELSIF att->'clean' IS DISTINCT FROM 'true'::jsonb THEN v_fail := 'attested runtime tree is not clean';
ELSIF att->>'proof' IS DISTINCT FROM encode(sha256(convert_to(
        (att->>'nonce') || ':' || (att->>'commit') || ':' || (att->>'buildId') || ':' || (att->>'lockfileSha256'), 'UTF8')), 'hex') THEN
  v_fail := 'attestation proof is inconsistent';
END IF;
```

Failure → event `runtime_verification_failed {reason: "controller check: …"}`, `fleet_release(... 'failed')`,
`{ok:false, code:"FLEET_RUNTIME_UNVERIFIED"}` → HTTP 409.
Success → agent `provisioning → active` (wallet, sandbox, `runtime_version = COALESCE(att.version, p_runtime_version)`,
`last_heartbeat = now()`); lease `completed` with `attested_at` and the attestation JSON; events `runtime_verified`,
`agent_activated`; credential upserted (`revoked_at = NULL`); event `credential_issued`. Lifecycle-effects trigger:
provisioning row → `active`/`not_required`, raises `FLEET_SANDBOX_MISMATCH` if the activation sandbox differs from the
provisioned sandbox, and creates the custody record (`migrations-phase5.ts:279-292`). SQLSTATE `23505` (unique wallet /
sandbox / local child id) → `FleetDuplicateRegistrationError` → 409.

Observation: a `FLEET_SANDBOX_MISMATCH` exception rolls back `svc_activate` and surfaces as `400 FLEET_REQUEST_FAILED`;
the lease stays `provisioning` until it expires (no immediate release).

Attestation limits (documented in code): the verifier runs inside the child sandbox, so a compromised sandbox can
report false hashes; the nonce proves freshness, not sandbox integrity (`attestation.ts:20-22`).

---

## 8. Reaper

### 8.1 Loop (`server.ts:256-305`)

- `startReaper()`: interval `reaperIntervalMs ?? 15 000`; `≤ 0` disables; one immediate pass, then `setInterval`, `unref()`.
- `reapOnce()` single-flight (`this.reaping`): `admin.reap("reaper")` → `svc_reap('reaper')` → `fleet_reap`; if `expired || unresponsive || dead` is non-zero → audit `reaper_pass {…}`; then `processTerminations()`; success records `lastReapOkAt`. Errors → audit `reaper_error {error}` and `lastReapError`.
- Observation: `ReapResult` (`types.ts:196-201`) and the `reaper_pass` condition ignore the `terminating`, `orphanSlotsReleased` and `challengesExpired` counters that `fleet_reap` returns, so a pass that only moves agents to `terminating` produces no `reaper_pass` audit line (DB events are still written).

### 8.2 `fleet_reap` (final v4, `migrations-phase5.ts:781-863`) — order per pass

Runs under `fleet_lock_state()`.

0. **Outage grace**: if `reaper_last_run_at` is null, or `reaper_grace_from` is null, or `now() − reaper_last_run_at > heartbeat_unresponsive_s`, set `v_grace = now()` and write event `reaper_resumed {lastRunAt}`; else keep `reaper_grace_from`. Every age below is measured as `GREATEST(<timestamp>, v_grace)`, so a controller or DB outage cannot kill agents that could not report.
1. **Leases**: `fleet_expire_leases` — every `reserved|provisioning` lease with `expires_at <= now()` → lease `expired`, agent `failed` (or `orphaned` via the uncertain trigger), events `reservation_expired`, `slot_released` (`migrations.ts:417-437`).
2. **Challenges**: every pending challenge with `expires_at <= now()` → `fleet_expire_challenge` (outcome `expired`, counts as a failure).
3. **Parent-reported quiet children**: `active|unresponsive` with `terminal_reported_at` set and heartbeat older than `parent_report_quiet_s` (default **60 s**) → `fleet_mark_dead(..., 'parent_reported')`.
4. **Unresponsive → terminating/dead**: `unresponsive` with heartbeat older than `heartbeat_dead_s` (default **600 s**) **or** `unresponsive_since` older than `termination_grace_s` (default **480 s**) → `fleet_begin_termination` with cause `heartbeat_timeout` or `health_timeout`.
5. **Active → unresponsive**: `active` with heartbeat older than `heartbeat_unresponsive_s` (default **120 s**), **or** `COALESCE(last_challenge_ok_at, activated_at, created_at)` older than `health_grace_s` (default **300 s**), **or** `challenge_failures >= max_challenge_failures` (default **3**) → `unresponsive`, `health_reason` `heartbeat stale` / `health challenge stale or failing`, event `agent_unresponsive {lastHeartbeat, timeoutS, cause: heartbeat|health, challengeFailures}`.
6. **Orphan hold**: if `orphan_slot_hold_s > 0` (default **259 200 s** = 3 days), `orphaned` agents with `quarantined_at` older than the hold → `dead` (reason suffix "orphan slot hold elapsed (sandbox not confirmed stopped)"), `fleet_orphans.slot_released_at = now()` (orphan stays **open**), event `orphan_slot_released {holdS}`.
7. **Purge**: `DELETE FROM fleet_request_nonces WHERE expires_at < now()`; `DELETE FROM fleet_agent_sessions WHERE expires_at < now() − 1 day`.

Returns `{expired, unresponsive, dead, terminating, orphanSlotsReleased, challengesExpired, graceFrom}`.
Step 4 runs before step 5, so an agent needs at least two passes to go `active → unresponsive → terminating`.

### 8.3 Timeouts and their storage (`fleet_state` columns)

| Column | Default | CHECK | Set by |
|---|---|---|---|
| `reservation_ttl_s` | 1800 | 1..86400 | `set-timeouts reservation=` |
| `provisioning_ttl_s` | 2700 | 1..86400 | `set-timeouts provisioning=` |
| `heartbeat_unresponsive_s` | 120 | 1..86400 | `set-timeouts unresponsive=` |
| `heartbeat_dead_s` | 600 | 2..604800, `> heartbeat_unresponsive_s` | `set-timeouts dead=` |
| `parent_report_quiet_s` | 60 | 1..86400 | `set-timeouts parent-quiet=` |
| `health_challenge_interval_s` | 60 | 1..86400 | `lifecycle-policy interval=` |
| `challenge_ttl_s` | 60 | 5..3600 | `lifecycle-policy challengeTtl=` |
| `health_grace_s` | 300 | 10..86400 | `lifecycle-policy healthGrace=` |
| `max_challenge_failures` | 3 | 1..100 | `lifecycle-policy maxFailures=` |
| `termination_grace_s` | 480 | 1..604800 | `lifecycle-policy terminationGrace=` |
| `orphan_slot_hold_s` | 259200 | ≥ 0 (0 disables auto release) | `lifecycle-policy orphanHold=` |
| `max_open_orphans` | 1 | ≥ 0 | `lifecycle-policy maxOrphans=` |
| `session_ttl_s` | 600 | 30..3600 | `lifecycle-policy sessionTtl=` |

Sources: `migrations.ts:286-298, 765`, `migrations-phase5.ts:45-55`, `cli.ts:365-382, 487-503`.

<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->
Repo expectation: defaults above unless the operator changed them with `set-timeouts` / `lifecycle-policy` (each change writes `timeouts_set` / `lifecycle_policy_set`).

---

## 9. Termination, orphans, provisioning reconciliation, release enforcement

### 9.1 Termination (`fleet_begin_termination`, `migrations-phase5.ts:480-502`; `terminator.ts`)

`fleet_begin_termination(agent, reason, actor, cause)` (owner-only; called by the reaper step 4 and by operator `quarantine`):
- agent must be `active|unresponsive`, else returns `NULL`;
- no `sandbox_id` → `fleet_mark_dead` → returns `'dead'`;
- else status `terminating`, `health_reason = left(cause,64)`, enqueue `fleet_sandbox_terminations (pending)`, events `agent_terminating {…, capabilitiesRevoked: true}` and `sandbox_termination_requested`; returns `'terminating'`.

Entering `terminating` fires `fleet_agents_lifecycle_effects`: credential revoked, sessions revoked, custody
`spending_frozen = true`, pending challenges expired (`migrations-phase5.ts:256-263`).

Queue work (`processTerminations`, `server.ts:276-292`): `svc_terminations_due(20)` returns rows with `status = 'pending'`,
or `status = 'failed' AND attempts < 5 AND last_attempt_at < now() − 60 s`, oldest first, limit clamped to `1..100`
(`migrations.ts:1079-1086`). Each is passed to the terminator; the result goes to `svc_termination_result`; audit
`sandbox_termination_<status> {sandboxId, terminator, error}`.

Default terminator (`terminator.ts:46-52`): `UnsupportedSandboxTerminator`, `name "unsupported"`, `guaranteed false`,
always returns `{status: "unsupported", reason: CONWAY_TERMINATION_UNSUPPORTED}` — "Conway API has no sandbox
stop/delete endpoint (deleteSandbox is a no-op); the sandbox may still be running." No other terminator
implementation exists in `src/` (FleetService constructor default, `server.ts:228`; `main.ts` passes none).

`svc_termination_result` (v4, `migrations-phase5.ts:509-561`), under the fleet lock:
- updates the queue row (`attempts + 1`, `completed_at` for `terminated|unsupported`), event `sandbox_terminated` | `sandbox_termination_unsupported` | `sandbox_termination_failed`;
- `v_orphan = status = 'unsupported' OR (status = 'failed' AND attempts >= 5)`;
- non-active provisioning row: `cleanup_status` → `terminated|unsupported|failed`, provisioning `status → orphaned` when `v_orphan`;
- agent `terminating` + `terminated` → `dead`, events `agent_died {cause:"terminated"}`, `slot_released`;
- agent `terminating` + orphan → `orphaned`, `fleet_orphans (holds_slot = true)`, event `agent_orphaned`;
- agent not terminating (already dead/failed) + orphan → `fleet_orphans (holds_slot = false)`, event `infrastructure_orphaned`.

Consequence with the only terminator available: every agent that is terminated **with a known sandbox** ends in
`orphaned`, holding a quarantine slot until the operator resolves it or `orphan_slot_hold_s` elapses.

Trigger `fleet_terminations_resolve_orphan` (`migrations-phase6.ts:173-186`): a queue row becoming `terminated`
resolves the open orphan ("sandbox termination confirmed") and moves an `orphaned` agent to `dead`.

### 9.2 Orphans

| Path | Effect | Source |
|---|---|---|
| terminating + unsupported/failed×5 | agent `orphaned`, orphan `holds_slot = true` | `migrations-phase5.ts:545-552` |
| provisioning fails with intent recorded and no sandbox id | agent forced `orphaned` (instead of `failed`), orphan `holds_slot = true`, provisioning `orphaned/uncertain/pending` | `migrations-phase6.ts:130-169` |
| already dead + unsupported | orphan `holds_slot = false` | `migrations-phase5.ts:553-559` |
| operator `resolve-orphan <agentId> <resolution>` | orphan resolved, agent `orphaned → dead`, terminations `terminated`, provisioning cleanup `terminated`, event `orphan_resolved` (owner only) | `store.ts:1260-1285` |
| reaper orphan hold | agent `dead`, orphan open with `slot_released_at` | `migrations-phase5.ts:845-856` |

Open orphans gate reservations (`> max_open_orphans` → `FLEET_ORPHANS_UNRESOLVED`) and the dry run (`> 0`).

### 9.3 Runtime release enforcement on claim/activate (`enforceRelease`, `server.ts:397-405`)

If the calling parent owns the lease and the service's pinned release is not `sameRelease` as the lease's
`expected` (repo, commit, buildId, lockfile): `svc_verification_failed` (slot released as failed), DB event
`runtime_release_mismatch {reservationId, reason}`, `409 FLEET_RUNTIME_UNVERIFIED`. A service without a pinned
release refuses every claim and activation this way.

### 9.4 Provisioning reconciliation

`POST /v1/replication/provisioning` → `svc_provision_update` (v6, `migrations-phase6.ts:189-254`):

| Phase | Preconditions | Effect / event |
|---|---|---|
| `sandbox_intent` | `p_sandbox` must equal `'fleet-' \|\| lower(provisioning_key)`; if `sandbox_id` known → return it (reuse); provisioning and agent both `provisioning`; `create_attempts < 3` else `FLEET_PROVISIONING_UNCERTAIN` | `sandbox_name` set, `external_state = 'intent'`, `intent_at`, `create_attempts + 1`; event `provisioning_sandbox_intent {provisioningKey, sandboxName, attempt}` |
| `sandbox_created` | id 1..128 chars; must equal an already-recorded id (`FLEET_SANDBOX_MISMATCH`) | `sandbox_id`, `external_state = 'created'`; if the attempt already failed/orphaned: cleanup `pending`, orphan gets the id, termination queued; event `provisioning_sandbox_created` |
| `verifying` | provisioning and agent `provisioning` | provisioning `verifying`; event `provisioning_verifying` |

Any caller other than the lease parent → event `authorization_denied {action: "provision_update"}`, `FLEET_NOT_AUTHORIZED`.

`POST /v1/replication/reconcile` → `svc_provision_reconcile(key, outcome, sandboxId, actor)` (`migrations-phase6.ts:262-323`), under the fleet lock:
- `found`: record `sandbox_id` (`external_state 'created'`, `reconcile_note 'found by provisioning key'`); if the agent is no longer reserved/provisioning/active/unresponsive: cleanup `pending`, orphan gets the id, termination queued, event `sandbox_termination_requested {phase: 'reconciled'}`.
- `absent`: refused if a sandbox id is known (`FLEET_SANDBOX_KNOWN`) or while the agent is still reserved/provisioning before `activation_deadline` (`FLEET_PROVISIONING_IN_FLIGHT`); else `external_state 'absent'`, cleanup `not_required`, provisioning `orphaned → failed_provisioning`, open orphan without sandbox resolved, `orphaned` agent → `dead` with event `slot_released`.
- `unknown`: `external_state 'uncertain'` when no sandbox id; slot stays held.
- Always event `provisioning_reconciled {provisioningKey, outcome, sandboxId}`; returns `agentStatus`.

Operator equivalents: `fleet:admin reconcile <key> found <id>|absent|unknown` and `reconcile-provisioning`
(looks each uncertain row up by deterministic name when `CONWAY_API_KEY` is set) (`cli.ts:388-416`).

### 9.5 Parent-reported child end (`svc_child_terminal`, `migrations.ts:1045-1076`)

Child found by `local_child_id`; parent must match (else `authorization_denied`, `FLEET_NOT_AUTHORIZED`).
`reserved|provisioning` → `fleet_release(... 'failed')` (`released`); `active|unresponsive` → `terminal_reported_at` set,
and `fleet_mark_dead(... 'parent_reported')` only if already quiet for `parent_report_quiet_s` (`dead`), else `deferred`
(the reaper retires it later, step 3); other statuses → `already_terminal`. Event `child_terminal_reported`.
A child that keeps heartbeating is never killed on its parent's word.

---

## 10. Replication gates (every gate between an agent's `spawn_child` and a new living child)

| # | Layer | Gate | Where | Current gate value |
|---|---|---|---|---|
| 1 | agent process | privileged env present → agent refuses `--run` | `src/index.ts:56-64` | n/a |
| 2 | agent process | `localReplicationPreflight`: agent `FLEET_MODE` (default DEVELOPMENT) and agent `REAL_REPLICATION_ENABLED` | `shared.ts:394-397`, `policy.ts:96-133` | no agent exists |
| 3 | agent process | PolicyEngine rule `fleet.policy_gate` on `spawn_child`/`start_child`/`fund_child` | `src/agent/policy-rules/fleet.ts:41-107` | — |
| 4 | agent process | `SharedFleetController.evaluateReplication`: strictest(local, shared) mode, cap, registration, local pin = approved pin, financial eligibility (tier `normal|high`, credits ≥ `MIN_AGENT_RESERVE_USD` default 10 USD) | `shared-controller.ts:235-282`, `policy.ts:64-89`, `config.ts:218-273` | — |
| 5 | fleet service | route policy: scope `full` | `server.ts:109-116` | — |
| 6 | fleet service | service `REAL_REPLICATION_ENABLED` | `server.ts:821-824` | **false** |
| 7 | database | `fleet_authenticate` (session, scope) | `migrations-phase7.ts:93-144` | — |
| 8 | database | `fleet_reserve_slot` table in 7.4 (mode, DB switch, runtime, orphans, parent, scope, frozen, duplicate, cap) | `migrations-phase7.ts:165-236` | mode **DEVELOPMENT** → `FLEET_DEVELOPMENT_MODE` |
| 9 | fleet service | `enforceRelease` on claim | `server.ts:845` | — |
| 10 | database | `svc_claim` (lease reserved, unexpired, parent) | `migrations.ts:897-931` | — |
| 11 | agent + DB | durable sandbox intent, deterministic name, ≤ 3 create attempts | `spawn.ts:105-149`, `migrations-phase6.ts:199-224` | — |
| 12 | agent + service + DB | attestation (TS then SQL) | sections 7.6 | — |
| 13 | database | a dry-run agent cannot be a parent; a non-`full` scope cannot parent a normal child | `migrations-phase6.ts:383-397`, `migrations-phase7.ts:48-58` | — |
| 14 | database | cap trigger `FLEET_CAP_EXCEEDED` | section 11 | cap 2 |

<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->
Repo expectation: service `REAL_REPLICATION_ENABLED=false`, `fleet_state.operating_mode = 'DEVELOPMENT'`,
`fleet_state.max_agents = 2`; `fleet_state.replication_enabled` value to be confirmed from the snapshot. With
gates 6 and 8 each closed, no replication request can create a reservation.

---

## 11. Cap enforcement (race safety)

1. **Fleet-wide mutex**: every slot-affecting function begins with `fleet_lock_state()` =
   `SELECT * FROM fleet_state WHERE id = 1 FOR UPDATE` (`migrations.ts:391-400`); TS equivalent `lockState` (`store.ts:529-533`).
   Concurrent reservations from any process/host serialise on that row and read counters only after the previous transaction committed. `lock_timeout = 5000 ms` bounds the wait; a timeout is a failure (fail closed).
2. **Counters maintained by trigger** `fleet_agents_counters` (v4, `migrations-phase5.ts:65-91`), `AFTER INSERT` and `AFTER UPDATE OF status` on `fleet_agents`. Buckets (`fleet_bucket`, `:58-63`): `reserved|provisioning → reserved`, `active|unresponsive|terminating → living`, `orphaned → quarantined`, others `NULL`. On a bucket change it updates `fleet_state` (taking the same row lock). When a row **enters** the population (`old bucket NULL`, new bucket not NULL) and `living + reserved + quarantined > max_agents` it raises `FLEET_CAP_EXCEEDED: % living + % reserved + % quarantined > max %`.
3. **Counters are read-only** except from triggers: `fleet_state_counter_guard` raises `FLEET_COUNTERS_READ_ONLY` when `pg_trigger_depth() = 1` and a counter changes (`migrations-phase5.ts:93-100`).
4. **Hard ceiling**: `max_agents CHECK BETWEEN 1 AND 50` (`migrations.ts:35`); `fleet_state_population CHECK (living + reserved + quarantined <= 50)` (`migrations-phase5.ts:55`); `FLEET_PG_HARD_MAX_AGENTS = 50` (`migrations.ts:21`); `setMaxAgents` rejects outside `1..50` (`store.ts:682-691`); `toState` reports `min(max_agents, 50)` (`store.ts:308`).
5. **Pre-insert check** in `fleet_reserve_slot` (`occupancy >= mx`), `fleet_reserve_dry_run`, and `registerRoot`.
6. **Mapping**: `store.reserveSlot` turns a `FLEET_CAP_EXCEEDED` exception into `FLEET_CAP_REACHED` (`store.ts:1039-1049`).
7. **Terminal immutability**: `dead|failed` rows can never change status (transition guard), so a revived row cannot bypass the insert-time cap. Rows cannot be deleted (`fleet_history_immutable` triggers).

Bucket moves that do not enter the population (e.g. `reserved → living`, `living → quarantined`,
`provisioning → orphaned`) are not re-checked against the cap; they never increase total occupancy.
Lowering `max_agents` below current occupancy is allowed; it only blocks new entries.

---

## 12. Agent lifecycle state machine

### 12.1 Diagram (`fleet_agents.status`)

```
                         INSERT (operator: registerRoot / enroll-root / enroll-witness-root)
                         ─────────────────────────────────────────────────────────────┐
                                                                                        v
 INSERT (fleet_reserve_slot /        svc_claim                svc_activate         +--------+
 fleet_reserve_dry_run)                                                             |        |
 ───────────────> [reserved] ───────────────> [provisioning] ───────────────────────> | active |<──────┐
                     │                            │    │                              |        |       │ fleet_heartbeat (health fresh,
                     │ fleet_release /            │    │ fail with intent,            +--------+       │   failures < max) or
                     │ fleet_expire_leases /      │    │ no sandbox id                 │  │   │         │ svc_answer_challenge pass
                     │ fleet_mark_dead            │    │ (BEFORE trigger rewrites      │  │   │         │ (heartbeat fresh)
                     v                            │    │  failed -> orphaned)          │  │   v         │
                 [failed]* <──────────────────────┘    │                               │  │ [unresponsive]
                                                       │     fleet_reap step 5 /       │  │   │  │
                                                       │     fleet_challenge_failed ───┼──┘   │  │
                                                       │                               │      │  │
                                                       │  fleet_begin_termination      │      │  │ fleet_begin_termination
                                                       │  (quarantine; sandbox known)  v      │  │ (reaper step 4 / quarantine)
                                                       │                        [terminating]<┘  │
                                                       │                           │    │        │
                                                       │ svc_termination_result    │    │ svc_termination_result
                                                       │ unsupported / failed x5   │    │ terminated
                                                       v                           v    v
                                                   [orphaned] <────────────────────┘  [dead]*
                                                       │                                ^  ^
                                                       │ reaper orphan hold / resolveOrphan /
                                                       │ terminations_resolve_orphan trigger /
                                                       └─ svc_provision_reconcile 'absent' ─┘  │
                                                                                                │
   active|unresponsive ── fleet_mark_dead (self-retire, operator mark-dead, parent-reported quiet,
                          begin_termination with no sandbox) ──────────────────────────────────┘

   * terminal: dead and failed never change status again (FLEET_TERMINAL_STATE_IMMUTABLE).
```

### 12.2 Allowed transitions (enforced by `fleet_agents_transition_guard`, final v6 `migrations-phase6.ts:84-124`)

```sql
IF TG_OP = 'INSERT' THEN
  IF NEW.status NOT IN ('reserved','active') THEN RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: cannot insert agent in status %', NEW.status; END IF;
  RETURN NEW;
END IF;
-- identity columns immutable: agent_id, role, generation, parent_agent_id, created_at, dry_run
-- wallet_address immutable once set; child runtime_commit immutable once set
IF OLD.status IN ('dead','failed') THEN RAISE EXCEPTION 'FLEET_TERMINAL_STATE_IMMUTABLE: agent % is %', OLD.agent_id, OLD.status; END IF;
IF NOT (
     (OLD.status = 'reserved'     AND NEW.status IN ('provisioning','failed'))
  OR (OLD.status = 'provisioning' AND NEW.status IN ('active','failed','orphaned'))
  OR (OLD.status = 'active'       AND NEW.status IN ('unresponsive','terminating','dead'))
  OR (OLD.status = 'unresponsive' AND NEW.status IN ('active','terminating','dead'))
  OR (OLD.status = 'terminating'  AND NEW.status IN ('orphaned','dead'))
  OR (OLD.status = 'orphaned'     AND NEW.status = 'dead')
) THEN RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: % -> %', OLD.status, NEW.status; END IF;
```

Additional row constraints (`migrations.ts:46-74`, `migrations-phase5.ts:29-34`, `migrations-phase7.ts:31-34`):
`(status IN ('dead','failed')) = (death_time IS NOT NULL)`; roots have no parent and generation 0, children have a parent
and generation ≥ 1; `reserved|provisioning` only for children; `active`/`unresponsive` require a wallet; children require
`runtime_commit`; `capability_scope ∈ {full, witness}` and `witness` only for a non-dry-run root; `capability_scope`
immutable (`fleet_agents_zz_scope_immutable`, `migrations-phase7.ts:36-44`); unique wallet (case-insensitive), unique
`local_child_id`, unique live `sandbox_id`.

### 12.3 Transition table with the enforcing code

| From → To | Performed by (SQL function / TS) | Trigger side effects |
|---|---|---|
| (none) → `active` (root) | `registerRoot` INSERT (`store.ts:939-944`) | custody row created (`fleet_agents_custody_on_insert`); frozen with zero limit for witness/dry-run (`migrations-phase7.ts:62-76`); `activated_at` stamped |
| (none) → `reserved` (child) | `fleet_reserve_slot` (`migrations-phase7.ts:221-224`), `fleet_reserve_dry_run` (`migrations-phase6.ts:365-368`) | cap trigger; dry-run/scope parent guards |
| `reserved → provisioning` | `svc_claim` (`migrations.ts:915-918`) | lease trigger creates `fleet_provisioning` |
| `reserved → failed` | `fleet_release` (`migrations.ts:448-449`), `fleet_expire_leases` (`:427-429`), `fleet_mark_dead` (`:821-825`) | lifecycle effects: revoke credential/sessions, freeze custody, expire challenges; provisioning `failed_provisioning` |
| `provisioning → active` | `svc_activate` (`migrations.ts:986-990`) | provisioning `active`; sandbox mismatch check; custody created |
| `provisioning → failed` | same as `reserved → failed` | as above; termination queued if a sandbox id is known |
| `provisioning → orphaned` | any `→ failed` write, rewritten by `fleet_agents_a_provisioning_uncertain` when intent recorded and `sandbox_id IS NULL` (`migrations-phase6.ts:130-146`) | orphan (holds slot), event `provisioning_uncertain` |
| `active → unresponsive` | `fleet_reap` step 5 (`migrations-phase5.ts:836-838`), `fleet_challenge_failed` (`:640-644`) | `unresponsive_since` stamped |
| `unresponsive → active` | `fleet_heartbeat` (`:578-583`), `svc_answer_challenge` (`:693-696`) | `unresponsive_since` cleared |
| `active/unresponsive → terminating` | `fleet_begin_termination` (`migrations-phase5.ts:494-495`) | capabilities revoked; `quarantined_at` stamped; termination queued |
| `active/unresponsive → dead` | `fleet_mark_dead` (`migrations.ts:816-842`) via `api_set_own_status('dead')`, `svc_mark_dead`, `svc_child_terminal`, reaper step 3, `fleet_begin_termination` without sandbox | capabilities revoked; lease released; termination queued if sandbox known; events `agent_died`, `slot_released` |
| `terminating → dead` | `svc_termination_result('terminated')` (`migrations-phase5.ts:539-544`) | — |
| `terminating → orphaned` | `svc_termination_result('unsupported' | 'failed' ×5)` (`:545-552`) | orphan holds slot |
| `orphaned → dead` | reaper step 6 (`:846-855`), `resolveOrphan` (`store.ts:1268-1273`), `fleet_terminations_resolve_orphan` (`migrations-phase6.ts:179-181`), `svc_provision_reconcile('absent')` (`:309-313`) | — |

`fleet_agents_lifecycle_stamps` (`migrations-phase5.ts:145-158`): `activated_at` on first `active`;
`unresponsive_since` set on entering `unresponsive`, cleared on `active`; `quarantined_at` on first `terminating|orphaned`.

### 12.4 Reservation lease state machine (`fleet_reservations.status`, guard `migrations.ts:328-360`)

```
 INSERT ──> [reserved] ──svc_claim──> [provisioning] ──svc_activate──> [completed]*
               │                            │
               ├── fleet_expire_leases ──> [expired]*   <──┤
               ├── fleet_release('released') / fleet_mark_dead ──> [released]*  <──┤
               └── fleet_release('failed') ──> [failed]*  <──┘
```

Lease identity and expectations (`reservation_id, agent_id, parent_agent_id, created_at, expected_*`, set nonce) are
immutable; terminal leases never change; rows cannot be deleted. CHECKs: `ended_at` set iff `expired|released|failed`;
`provisioning|completed` require `claimed_at` and a nonce; `completed` requires `attested_at` and `completed_at`.

### 12.5 Provisioning record (`fleet_provisioning`)

`status`: `provisioning → verifying → active` | `failed_provisioning` | `orphaned` (`orphaned → failed_provisioning` on
reconcile `absent`). `external_state`: `none → intent → created | uncertain | absent`. `cleanup_status`:
`none → not_required | pending → terminated | unsupported | failed`. No transition-guard trigger exists for these
columns; only `provisioning_key`, `sandbox_name` (once set), `sandbox_id` (once set) and `dry_run` are immutable
(`migrations-phase6.ts:70-80`); `provisioning_key` must equal `provisioning_id` (= reservation id) (`:57-68`); rows cannot be deleted.

---

## 13. Audit and event generation

### 13.1 Sinks

| Sink | Writer | Redaction | Source |
|---|---|---|---|
| stdout JSON lines (journald) | `createJsonLogger` | `redactLogLine` (envelope `ts, level, service, event` cannot be overridden) | `log.ts:129-140` |
| JSONL audit file (`FLEET_AUDIT_LOG`) + stdout copy with `audit: true` | `createAuditSink` | `redactAuditRecord`, one canonical redacted record for both copies | `log.ts:154-160` |
| `fleet_events` table | `FleetService.recordDb` → `svc_record_event` (event type must match `^[a-z][a-z0-9_]{0,63}$`) and SQL `fleet_event()` | `redactDetail` in TS; `fleet_scrub` in SQL for reasons | `server.ts:248-252`, `store.ts:1494-1498`, `migrations.ts:1031-1038, 379-389` |

`FleetService.audit()` redacts the detail with `redactDetail` before the sink, and swallows sink errors
(`server.ts:236-242`). `fleet_events` rows are immutable (`fleet_events_no_change`, `fleet_events_no_truncate`).
`fleet_scrub` replaces `0x` + 64 hex with `[redacted]`, strips URL userinfo passwords, truncates to 500 chars
(`migrations.ts:379-383`).

### 13.2 Events written by the service process (TypeScript)

| Event | DB (`fleet_events`) | Audit sink only | Emitted at |
|---|---|---|---|
| `api_request` | | yes | every routed request (`server.ts:623`) |
| `api_auth_failed` | yes (via `authFailure`) | also audit-only variant from `authorize`/`authenticate` | `server.ts:442, 535, 549` |
| `api_origin_denied` | | yes | `server.ts:564` |
| `api_error` | | yes | `server.ts:652` |
| `rate_limited` | | yes | `server.ts:451` |
| `request_replay_blocked` | yes | yes | `server.ts:507` |
| `scope_denied` (layer `service`) | yes | yes | `server.ts:538` |
| `db_authorization_failed` | yes | yes | `server.ts:648` |
| `authorization_denied` | yes | yes | `server.ts:668, 878` |
| `runtime_release_mismatch` | yes | yes | `server.ts:403` |
| `replication_rejected` (`by: service`) | yes | yes | `server.ts:822` |
| `replication_granted` / `replication_rejected` | | yes | `server.ts:826` |
| `agent_activated` | | yes (DB copy written by `svc_activate`) | `server.ts:868` |
| `agent_died` (`cause: self_reported`) | | yes (DB copy by `fleet_mark_dead`) | `server.ts:813` |
| `child_terminal_reported` | | yes (DB copy by `svc_child_terminal`) | `server.ts:900` |
| `claim_denied` | yes | yes | `store.ts:1097` |
| `reaper_pass`, `reaper_error` | | yes | `server.ts:261, 267` |
| `sandbox_termination_terminated` / `_unsupported` / `_failed` | | yes | `server.ts:290` |

Process log events (`main.ts`): `service_started`, `runtime_release_unpinned`, `shutdown_started`,
`shutdown_complete`, `shutdown_forced`, `shutdown_failed`, `uncaught_exception`, `unhandled_rejection`,
`startup_failed`, `config_warning`.

### 13.3 Events written by SQL functions reachable from the service (`svc_*`, `api_*`, triggers)

| Event | Function(s) |
|---|---|
| `db_auth_failed` | `fleet_authenticate`, `api_open_session` |
| `scope_denied` (layer `database`) | `fleet_authenticate` |
| `session_opened` | `api_open_session` |
| `request_replayed` | `svc_consume_nonce` |
| `replication_requested`, `replication_granted`, `replication_rejected` | `api_request_replication`; `replication_rejected` also `fleet_agents_dry_run_guard` |
| `reservation_denied`, `slot_reserved` | `fleet_reserve_slot` |
| `reservation_expired` | `fleet_expire_leases` |
| `slot_released` | `fleet_expire_leases`, `fleet_release`, `fleet_mark_dead`, `svc_termination_result`, `svc_provision_reconcile` |
| `provisioning_failed` | `fleet_release('failed')` |
| `slot_claimed` | `svc_claim` |
| `provisioning_started` | trigger `fleet_reservations_provisioning` |
| `provisioning_sandbox_intent`, `provisioning_sandbox_created`, `provisioning_verifying` | `svc_provision_update` |
| `provisioning_uncertain` | trigger `fleet_agents_uncertain_effects` |
| `provisioning_reconciled` | `svc_provision_reconcile` |
| `runtime_verification_failed`, `runtime_verified` | `svc_activate`, `svc_verification_failed` |
| `agent_activated`, `credential_issued` | `svc_activate` |
| `agent_recovered` | `fleet_heartbeat`, `svc_answer_challenge` |
| `agent_unresponsive` | `fleet_reap`, `fleet_challenge_failed` |
| `health_challenge_failed` | `fleet_challenge_failed` |
| `agent_terminating` | `fleet_begin_termination` |
| `sandbox_termination_requested` | `fleet_mark_dead`, `fleet_begin_termination`, `fleet_agents_lifecycle_effects`, `svc_provision_reconcile` |
| `sandbox_terminated`, `sandbox_termination_unsupported`, `sandbox_termination_failed` | `svc_termination_result` |
| `agent_orphaned`, `infrastructure_orphaned` | `svc_termination_result` |
| `agent_died` | `fleet_mark_dead`, `svc_termination_result` |
| `orphan_slot_released`, `reaper_resumed` | `fleet_reap` |
| `child_terminal_reported` | `svc_child_terminal` |
| `authorization_denied` | `api_release_reservation`, `api_set_own_status`, `svc_activate`, `svc_child_terminal`, `svc_provision_update`, `svc_answer_challenge`, `api_request_spend` |
| `capital_requested` | `api_propose_allocation` |
| `spend_denied`, `spend_approved_not_executed` | `api_request_spend` |

Events written only by operator-CLI (admin credential) methods, never by the service: `cap_set`, `mode_set`,
`runtime_approved`, `replication_switch_set`, `timeouts_set`, `lifecycle_policy_set`, `agent_role_granted`,
`service_role_granted`, `operator_role_granted`, `registration_denied`, `root_registered`, `credential_issued`
(rotation), `agent_quarantined`, `orphan_resolved` (`store.ts:682-1318`). Treasury and Operator API events are documented
in their own volumes.

---

## 14. Treasury functions reachable from the controller

Only two, both agent-initiated, both through the restricted agent role:

| Route | SQL | Effect |
|---|---|---|
| `POST /v1/capital/propose` | `api_propose_allocation` (`migrations-phase5.ts:1137-1159`) | requires status `active`; at most 5 `proposed` allocations per agent (`FLEET_TOO_MANY_PROPOSALS`); inserts a `proposed` allocation with `proposed_by = agent`; event `capital_requested`. Approval is operator-only (`fleet_require_operator_approver` refuses any fleet agent id or wallet as approver, `:912-…`). Dry-run and witness identities are refused by triggers (`FLEET_DRY_RUN_NO_SPEND`, `FLEET_SCOPE_DENIED`). |
| `POST /v1/wallet/spend-request` | `api_request_spend` (`:1164-1204`) | `from_wallet` must be the caller's custody wallet; denied if not `active`, custody frozen, allocation not approved/current/owned or over its approved amount, or (no allocation) today's approved total + amount > `daily_limit_cents` (default 0). Inserts an immutable `fleet_spend_requests` row with decision `denied` or `approved_not_executed`. **Nothing is signed or sent** (`executed: false`). |

No sweep, distribution or transfer function is reachable from the FleetService. `REAL_PAYMENTS_ENABLED` is not read
by the service at all (`grep` of `src/fleet/service/` finds it only in a comment at `server.ts:792`).

---

## 15. Shutdown

### 15.1 Signals (`main.ts:296-323`)

- `SIGTERM` or `SIGINT` → first signal: `stop()`; success → `process.exit(0)`; failure → log `error shutdown_failed` → `process.exit(1)`.
- Second signal (any of the two) → log `warn shutdown_forced {signal}` → `process.exit(1)`.
- `stop()` is idempotent (memoised promise): log `shutdown_started`; `service.close()`; close agent pool then controller pool; log `shutdown_complete`.

### 15.2 Drain (`FleetService.close`, `server.ts:340-354`)

1. `draining = true`: `/healthz` returns `503 {"ok":false,"status":"draining",…}`; every other request, including `/readyz`, gets `503 FLEET_SERVICE_DRAINING` with `connection: close` (the draining gate in `handle` runs before `handleInner`, `server.ts:585-589`).
2. `stopReaper()` (clears the interval; a running pass continues).
3. `server.close()` on every listener (stop accepting), `closeIdleConnections()`.
4. Poll every **25 ms** until `inFlight == 0` and no reaper pass is running, or `drainMs` (default **10 000 ms**) elapses.
5. `closeAllConnections()`; await the close callbacks.

systemd: `KillSignal=SIGTERM`, `KillMode=mixed`, `TimeoutStopSec=30s` (SIGKILL after 30 s), `Restart=on-failure`,
`RestartSec=5s`, `StartLimitIntervalSec=300`, `StartLimitBurst=5`, `TimeoutStartSec=60s`
(`deploy/systemd/automaton-fleet.service`).

---

## 16. Agent-side counterpart (for completeness)

`SharedFleetController` (`shared-controller.ts`), created per automaton by `getSharedFleetForContext`
(`shared.ts:352-382`) when `FLEET_API_URL` (or `apiUrl` in the credential file) and
`~/.automaton/fleet-credentials.json` (`FLEET_CREDENTIALS_FILE`; must be a regular file with `mode & 0o077 == 0`,
`client.ts:108-122`) exist; otherwise every replication path fails closed with `FLEET_REGISTRY_UNAVAILABLE`.

- `init()`: root → `registerRoot` (confirm only), child → `attachAgent(selfAgentId from manifest)`; never throws.
- Snapshot for the synchronous policy rule; stale after **90 000 ms** (`shared-controller.ts:72, 158-161`).
- `heartbeat()` every 30 s; if the registry reports `dead|failed`, `onDead` fires once; `src/index.ts:355-358` sends the process `SIGTERM`.
- `requestReplication`: evaluate → `reserveSlot` (`POST /v1/replication/request`) → `spawn(grant)` → `activate` → deliver the child's credential into its sandbox; spawn failure → `recordVerificationFailure` (for `FleetRuntimeError`) or `releaseReservation`; activation failure → release; delivery failure is only logged (the child then cannot heartbeat and is reaped).
- Child-end forwarding: `ChildLifecycle` transitions to `failed|stopped|cleaned_up` call `markDeadByLocalChildId` → `POST /v1/children/terminal` (`shared.ts:316-329`, `src/replication/lifecycle.ts:21, 86`).

Phase 1 `FleetController` (`controller.ts`) and `FleetRegistry` (`registry.ts`) operate on the agent's local SQLite
(`fleet_agents` with statuses `reserved|spawning|active|dead|failed`, `BEGIN IMMEDIATE`, busy timeout 5000 ms). No
production replication path uses them (`index.ts:274-278`); `spawnChild` falls back to the local registry only for a
grant that has no shared binding (`grants.ts:74-97`).

---

## 17. DRIFT and NOT IMPLEMENTED summary for this volume

- **DRIFT:** `CLAUDE.md` ("Known architecture") lists Redis as owned by the Fleet Control Plane. No code uses Redis; `REDIS_URL` appears only as a forbidden/secret env name (`secret-files.ts:71, 364`, `secrets.ts:21`, `dry-run/child.ts:31`). The runbook agrees with code ("the fleet code does not use Redis today", `docs/fleet-production-runbook.md:412`).
- **DRIFT:** `FLEET.md` "Current deployment state (2026-09-24)" (`FLEET.md:7-20`) records runtime `11c0c7c`, schema v6, controller on the local VM loopback-only, remote HTTPS disabled, cap 1. `CLAUDE.md` records production `4d6a0be`, schema v8, VPS, public HTTPS, cap 2. Code requires schema v8 (`migrations.ts:20`). FLEET.md's section is stale.
- **DRIFT:** `FLEET.md:236` ("nothing yet marks silent agents dead") is a historical Phase 2 blocker; code has had the reaper since schema v2 (`migrations.ts:599-636`, final `migrations-phase5.ts:781-863`). FLEET.md labels the list as historical (`FLEET.md:229`).
- **NOT IMPLEMENTED:** server response signing (section 6.4).
- **NOT IMPLEMENTED:** Host header validation (section 3.2).
- **NOT IMPLEMENTED:** a working sandbox terminator; only `UnsupportedSandboxTerminator` exists (section 9.1).
- **NOT IMPLEMENTED:** TLS certificate reload / runtime expiry re-check (section 1.7).
- **NOT IMPLEMENTED:** HTTP server timeouts configured in code (Node defaults only).
- Observations recorded above (not fixed): unvalidated `FLEET_REAPER_INTERVAL_MS` / `FLEET_SHUTDOWN_DRAIN_MS`; per-agent rate-limit bucket chargeable with unverified tokens; DB event write before auth-failure throttling; `reaper_pass` audit ignores `terminating`/orphan counters; `FLEET_SANDBOX_MISMATCH` surfaces as 400 without releasing the lease.
