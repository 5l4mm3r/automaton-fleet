# 06 — Operator API (Phase B2, schema v8)

Master Key, part 7. Forensic reconstruction reference for the read-only, signed,
loopback-only Operator API. Snapshot: repository branch `fleet-development`, HEAD `efad214`.
The Operator API code was introduced in `5a5469e` ("feat: read-only Operator API with schema v8
(B2-2, reviewed in B2-3)") and amended in `4d6a0be` ("fix: treat absent Operator API roles as not
provisioned in the privilege audit"). Production runs `4d6a0be`.

Rules for this document:
- Implementation wins. Every claim is cited as `path:line` to the code at `efad214`.
- Where the design document (`docs/design/phase-b-operator-api.md`), code comments or runbook
  disagree with the code, both are stated and marked **DRIFT:**.
- Planned but absent features are marked **NOT IMPLEMENTED**.
- No secret values appear here. Secret files are named, never read.

---

## Contents

1. [Component summary](#1-component-summary)
2. [Process identity, OS user and systemd unit](#2-process-identity-os-user-and-systemd-unit)
3. [Configuration and credential loading](#3-configuration-and-credential-loading)
4. [Startup refusals (fail-closed)](#4-startup-refusals-fail-closed)
5. [Database roles: `fleet_operator` / `fleet_operator_login`](#5-database-roles-fleet_operator--fleet_operator_login)
6. [Schema v8: tables, constraints, triggers](#6-schema-v8-tables-constraints-triggers)
7. [Schema v8: functions (`op_*` and helpers)](#7-schema-v8-functions-op_-and-helpers)
8. [Listener and HTTP server parameters](#8-listener-and-http-server-parameters)
9. [Principal model, kinds, scopes, keys](#9-principal-model-kinds-scopes-keys)
10. [Signing protocol FLEET-OP-SIG-V1](#10-signing-protocol-fleet-op-sig-v1)
11. [Request verification order and sequence diagram](#11-request-verification-order-and-sequence-diagram)
12. [Routes: policy, parameters, response schemas](#12-routes-policy-parameters-response-schemas)
13. [Unauthenticated endpoints `/healthz`, `/readyz` and the Host check (421)](#13-unauthenticated-endpoints-healthz-readyz-and-the-host-check-421)
14. [Readiness checks](#14-readiness-checks)
15. [Kill switch and generation](#15-kill-switch-and-generation)
16. [Rate limiting and concurrency](#16-rate-limiting-and-concurrency)
17. [READ ONLY transaction enforcement and the signature-termination invariant](#17-read-only-transaction-enforcement-and-the-signature-termination-invariant)
18. [Redaction and `untrusted_text`](#18-redaction-and-untrusted_text)
19. [Audit: JSONL, journald, `fleet_events`, `fleet_operator_requests`](#19-audit-jsonl-journald-fleet_events-fleet_operator_requests)
20. [Request-audit cap, archival and doctor retention warnings](#20-request-audit-cap-archival-and-doctor-retention-warnings)
21. [Full error model](#21-full-error-model)
22. [Operator lifecycle CLI (`fleet:admin operator-*`, `grant-operator-role`)](#22-operator-lifecycle-cli-fleetadmin-operator--grant-operator-role)
23. [Bridge-side key generation and key loading](#23-bridge-side-key-generation-and-key-loading)
24. [Privilege audit (operator parts)](#24-privilege-audit-operator-parts)
25. [Principal table (non-secret)](#25-principal-table-non-secret)
26. [Tests that pin the behaviour](#26-tests-that-pin-the-behaviour)
27. [Design-document vs code drift register](#27-design-document-vs-code-drift-register)
28. [Known limitations (accepted for v1)](#28-known-limitations-accepted-for-v1)

---

## 1. Component summary

| Property | Value | Source |
|---|---|---|
| Process | `node dist/fleet/operator/main.js` (separate from FleetController) | `deploy/systemd/automaton-fleet-operator-api.service:30`, `src/fleet/operator/main.ts:188` |
| OS user / group | `automaton-fleet-operator-api` / `automaton-fleet-operator-api`, no supplementary groups | `deploy/systemd/automaton-fleet-operator-api.service:26-28` |
| Listener | `127.0.0.1:8788` (loopback only, enforced twice) | `src/fleet/operator/main.ts:37`, `:42-49`; `src/fleet/operator/server.ts:197-198` |
| Database login | `fleet_operator_login` (member of NOLOGIN `fleet_operator`) | `scripts/fleet-db-roles.sql:44-62`, `src/fleet/operator/main.ts:136-139` |
| Credential | `FLEET_OPERATOR_DATABASE_URL` in `/etc/automaton-fleet/operator.env`, `root:automaton-fleet-operator-api 0640` | `deploy/etc/operator.env.example:1-8`, `src/fleet/secret-files.ts:42-48` |
| Required schema | exactly v8 | `src/fleet/operator/server.ts:54`, `src/fleet/operator/main.ts:141` |
| API surface | 5 GET routes + `/healthz` + `/readyz` | `src/fleet/operator/route-policy.ts:39-55`, `src/fleet/operator/server.ts:318-331` |
| Authentication | Per-request Ed25519 signature (FLEET-OP-SIG-V1), no sessions, no bearer token | `src/fleet/operator/canonical.ts:1-22` |
| Mutations | None on fleet/business state. Only operator bookkeeping writes in `op_begin_request` | `src/fleet/postgres/migrations-phase8.ts:9-28` |
| Clients | Claude bridge (dev VM, via SSH tunnel account `fleet-op-tunnel`), ChatGPT adapter (VPS, local loopback) | `src/fleet/bridge/client.ts:22,125`, `src/fleet/chatgpt-adapter/main.ts:7` |

The Operator API is classified by the design as a FleetController / control-plane component shipped
from the same approved release but with its own OS identity, process, DB role, unit and privilege
boundary (design D-1/D-2, `docs/design/phase-b-operator-api.md:1165-1166`).

---

## 2. Process identity, OS user and systemd unit

### 2.1 OS user

Created by `scripts/fleet-os-setup.sh:77-78`:

```bash
id automaton-fleet-operator-api >/dev/null 2>&1 || run useradd --system --user-group --home-dir /var/lib/automaton-fleet-operator-api \
  --no-create-home --shell /usr/sbin/nologin --comment "Automaton fleet Operator API" automaton-fleet-operator-api
```

- System user, own primary group only, shell `/usr/sbin/nologin`, home not created.
- `scripts/fleet-verify-deployment.sh:46-48` fails if the user is in any group other than
  `automaton-fleet-operator-api`.
- Production (runbook B2-9, `docs/fleet-production-runbook.md:1189`): uid 994 / gid 984.
  <!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->

### 2.2 systemd unit (`deploy/systemd/automaton-fleet-operator-api.service`)

Installed by `scripts/fleet-os-setup.sh:143` as `/etc/systemd/system/automaton-fleet-operator-api.service`
(root 0644). The header comment states it is NOT enabled or started by any script (`:3-5`).
Production enabled it for boot at B2 closeout (`docs/fleet-production-runbook.md:1193`).

Exact directives (`deploy/systemd/automaton-fleet-operator-api.service:16-86`):

| Section | Directive | Value |
|---|---|---|
| Unit | Description | `Automaton Fleet Operator API (read-only, loopback, signed requests)` |
| Unit | Documentation | `file:///opt/automaton-fleet/current/docs/design/phase-b-operator-api.md` |
| Unit | Wants | `postgresql.service` |
| Unit | After | `postgresql.service network-online.target automaton-fleet.service` |
| Unit | StartLimitIntervalSec / StartLimitBurst | `300` / `5` |
| Service | Type | `exec` |
| Service | User / Group | `automaton-fleet-operator-api` / `automaton-fleet-operator-api` |
| Service | SupplementaryGroups | (empty) |
| Service | WorkingDirectory | `/opt/automaton-fleet/current` |
| Service | ExecStart | `/opt/automaton-fleet/node/bin/node dist/fleet/operator/main.js` |
| Service | Environment | `NODE_ENV=production` |
| Service | Environment | `FLEET_OPERATOR_EXPECTED_USER=automaton-fleet-operator-api` |
| Service | Environment | `FLEET_OPERATOR_LISTEN=127.0.0.1:8788` |
| Service | Environment | `FLEET_OPERATOR_ENV_FILE=/etc/automaton-fleet/operator.env` |
| Service | Environment | `FLEET_RUNTIME_ENV_FILE=/etc/automaton-fleet/runtime.env` |
| Service | Environment | `FLEET_OPERATOR_AUDIT_LOG=/var/log/automaton-fleet-operator/audit.jsonl` |
| Service | Environment | `FLEET_OPERATOR_REQUIRE_TIMESYNC=true` |
| Service | LogsDirectory / LogsDirectoryMode | `automaton-fleet-operator` / `0700` |
| Service | UMask | `0077` |
| Service | Restart / RestartSec | `on-failure` / `5s` |
| Service | KillSignal / TimeoutStopSec | `SIGTERM` / `15s` |
| Service | StandardOutput / StandardError | `journal` / `journal` |
| Service | SyslogIdentifier | `automaton-fleet-operator-api` |
| Service | IPAddressDeny / IPAddressAllow | `any` / `localhost` |
| Service | RestrictAddressFamilies | `AF_INET AF_INET6 AF_UNIX` |
| Service | NoNewPrivileges | `true` |
| Service | CapabilityBoundingSet / AmbientCapabilities | (empty) / (empty) |
| Service | ProtectSystem / ProtectHome | `strict` / `yes` |
| Service | PrivateTmp / PrivateDevices | `yes` / `yes` |
| Service | ProtectKernelTunables / Modules / Logs | `yes` / `yes` / `yes` |
| Service | ProtectControlGroups / ProtectClock / ProtectHostname | `yes` / `yes` / `yes` |
| Service | ProtectProc / ProcSubset | `invisible` / `pid` |
| Service | RestrictNamespaces / RestrictRealtime / RestrictSUIDSGID | `yes` / `yes` / `yes` |
| Service | LockPersonality / RemoveIPC | `yes` / `yes` |
| Service | SystemCallArchitectures | `native` |
| Service | SystemCallFilter | `@system-service`, then `~@privileged @resources` |
| Service | InaccessiblePaths | `-/etc/automaton-fleet/admin.env -/etc/automaton-fleet/service.env -/etc/automaton-fleet/tls -/etc/automaton-fleet/legacy-env-fleet.bak` |
| Service | InaccessiblePaths | `-/home -/var/lib/automaton-fleet -/var/lib/automaton-fleet-witness -/var/log/automaton-fleet -/run/credentials` |
| Install | WantedBy | `multi-user.target` |

The unit deliberately does **not** use `LoadCredential=` (comment `:10-12`), so the verified
systemd-credential 0440 exception stays limited to `automaton-fleet.service`.

### 2.3 Log rotation (`deploy/logrotate/automaton-fleet`)

Installed as `/etc/logrotate.d/automaton-fleet` (root 0644). Block for the operator audit file
(`deploy/logrotate/automaton-fleet:20-29`):

```
/var/log/automaton-fleet-operator/audit.jsonl {
    size 50M
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0600 automaton-fleet-operator-api automaton-fleet-operator-api
    su automaton-fleet-operator-api automaton-fleet-operator-api
}
```

Rotation is by rename (no `copytruncate`); safe because the sink calls `fs.appendFileSync` on the path
for every line (`src/fleet/service/log.ts:45`). The same file also rotates the controller's
`/var/log/automaton-fleet/audit.jsonl` (`:10-18`) with identical parameters but owner
`automaton-fleet-service`. Bound per file set: about 14 × 50 MB.

---

## 3. Configuration and credential loading

### 3.1 Environment variables read by the process

| Variable | Default | Effect | Source |
|---|---|---|---|
| `FLEET_OPERATOR_ENV_FILE` | `/etc/automaton-fleet/operator.env` | Secret file with the DSN | `src/fleet/secret-files.ts:407` |
| `FLEET_RUNTIME_ENV_FILE` | `/etc/automaton-fleet/runtime.env` | Non-secret pins + safety flags | `src/fleet/secret-files.ts:408`, `src/fleet/operator/main.ts:165` |
| `FLEET_OPERATOR_DATABASE_URL` | none (required) | DSN of `fleet_operator_login` | `src/fleet/operator/main.ts:95,132` |
| `FLEET_OPERATOR_DB_LOGIN` | `fleet_operator_login` | Expected `current_user` | `src/fleet/operator/main.ts:136` |
| `FLEET_PG_SCHEMA` | `fleet` | Schema name | `src/fleet/operator/main.ts:131` |
| `FLEET_OPERATOR_LISTEN` | `127.0.0.1:8788` | Listen address (loopback regex) | `src/fleet/operator/main.ts:37,42-49` |
| `FLEET_OPERATOR_EXPECTED_USER` | none; required when `NODE_ENV=production` | OS user check | `src/fleet/operator/main.ts:82-85` |
| `FLEET_OPERATOR_AUDIT_LOG` | none (no JSONL file; journald only) | JSONL audit path | `src/fleet/operator/main.ts:164` |
| `FLEET_OPERATOR_TIMESYNC_MARKER` | `/run/systemd/timesync/synchronized` | Clock readiness marker | `src/fleet/operator/main.ts:38,159` |
| `FLEET_OPERATOR_REQUIRE_TIMESYNC` | `true` (anything but `false`) | Require the marker | `src/fleet/operator/main.ts:160` |
| `FLEET_RUNTIME_REPO` / `_COMMIT` / `_BUILD_ID` / `_LOCKFILE_SHA256` | none (required) | Pinned release, compared with registry approval | `src/fleet/operator/main.ts:97,142-151` |
| `REAL_REPLICATION_ENABLED`, `REAL_PAYMENTS_ENABLED`, `OWNER_SWEEP_ENABLED`, `FLEET_DRY_RUN_CHILD` | — | Any `true` refuses startup | `src/fleet/operator/main.ts:39,96` |

### 3.2 `loadOperatorEnv` (`src/fleet/secret-files.ts:403-418`)

Precedence: process environment > `operator.env` (strict secret file, group read permitted)
> `runtime.env` (non-secret). It never reads `admin.env`, `service.env` or repository `.env.fleet`
(comment `:399-402`).

```ts
export function loadOperatorEnv(processEnv = process.env, fileOpts = {}): LoadedEnv {
  const operatorFile = processEnv.FLEET_OPERATOR_ENV_FILE?.trim() || DEFAULT_OPERATOR_ENV_FILE;
  const runtimeFile = processEnv.FLEET_RUNTIME_ENV_FILE?.trim() || DEFAULT_RUNTIME_ENV_FILE;
  if (!fs.existsSync(operatorFile) && !isDanglingLink(operatorFile)) throw new SecretFileError(`Secret file ${operatorFile} does not exist.`);
  const problems = operatorEnvFileProblems(operatorFile, fileOpts);
  if (problems.length) throw new SecretFileError(`Refusing insecure secret file: ${problems.join("; ")}.`);
  return merge([[runtimeFile, readEnvFile(runtimeFile)],
                [operatorFile, readSecretEnvFile(operatorFile, { allowGroupRead: true, required: true })]], processEnv);
}
```

### 3.3 `operator.env` file rules (`operatorEnvFileProblems`, `src/fleet/secret-files.ts:381-397`)

1. All normal strict secret-file checks with `allowGroupRead: true` (`secretFileProblems`).
2. Owner uid must be `0` (root) so the process cannot rewrite its own credential.
3. If group-readable, group must equal the process's own primary gid.
4. Exactly one hard link (`nlink === 1`).
5. `realpath(file) === path.resolve(file)` (no symlink anywhere in its path).

File contents: exactly one line `FLEET_OPERATOR_DATABASE_URL=postgresql://fleet_operator_login:<64-hex>@127.0.0.1:5432/automaton_fleet`
(`deploy/etc/operator.env.example:8`). Real value: `[SECRET REDACTED — PURPOSE: fleet_operator_login password, 64 hex, generated on the VPS by fleet-os-setup.sh step 4b]`.
Generated by `scripts/fleet-os-setup.sh:115-124` (refuses a symlink; existing file is only re-chowned/chmodded);
applied to PostgreSQL by `scripts/fleet-db-setup.sh` via `fleet-db-roles.sql` (`:58`).
`scripts/fleet-verify-deployment.sh:49-62` checks `root:automaton-fleet-operator-api 640 1` and that the
file holds no non-operator credential.

**DRIFT:** `src/fleet/secret-files.ts:375` comment says "operator.env is the only group-readable secret
file", but `src/fleet/secret-files.ts:7` documents `admin.env` as `root:automaton-fleet-admin 0640`
(also group-readable). The statement is true only for the special own-group rule.

---

## 4. Startup refusals (fail-closed)

Entry point: `src/fleet/operator/main.ts:188-209`. On any failure it logs
`startup_failed` (fatal) and `process.exit(1)`. Uncaught exceptions / unhandled rejections also exit 1
(`:190-197`).

### 4.1 Environment-only checks (`operatorEnvProblems`, `src/fleet/operator/main.ts:75-104`)

Each adds a problem string (names only, never values):

| # | Condition | Message |
|---|---|---|
| 1 | uid 0 | `refusing to run as root (uid 0)` |
| 2 | `FLEET_OPERATOR_EXPECTED_USER` set and ≠ `os.userInfo().username` | `running as <u>, expected <e>` |
| 3 | `FLEET_OPERATOR_EXPECTED_USER` unset and `NODE_ENV=production` | `FLEET_OPERATOR_EXPECTED_USER is required in production` |
| 4 | Any `OPERATOR_FORBIDDEN_ENV` present | `<K> present (the Operator API must hold no admin/service/agent/Conway/wallet credential)` |
| 5 | Any of `OPERATOR_UNREADABLE_FILES` readable (`fs.accessSync R_OK`) | `controller secret <f> is readable by this process` |
| 6 | `FLEET_OPERATOR_DATABASE_URL` empty | `FLEET_OPERATOR_DATABASE_URL is not configured (operator.env)` |
| 7 | Any safety switch `true` (case-insensitive trim) | `<S>=true (the Operator API refuses to run with a safety switch on)` |
| 8 | `loadRuntimeRelease(e)` null | `no complete pinned runtime release (FLEET_RUNTIME_REPO/_COMMIT/_BUILD_ID/_LOCKFILE_SHA256)` |
| 9 | `FLEET_OPERATOR_LISTEN` not matching `^(127\.0\.0\.1|\[::1\]|localhost):([0-9]{1,5})$` or port outside 1..65535 | `FLEET_OPERATOR_LISTEN must be a loopback address (got …)` / `FLEET_OPERATOR_LISTEN port out of range` |

`OPERATOR_FORBIDDEN_ENV` (`src/fleet/secret-files.ts:357-372`):
`FLEET_ADMIN_DATABASE_URL`, `FLEET_SERVICE_DATABASE_URL`, `FLEET_AGENT_DATABASE_URL`,
`FLEET_CONTROLLER_DATABASE_URL`, `DATABASE_URL`, `PGPASSWORD`, `REDIS_URL`, `CONWAY_API_KEY`,
`WALLET_PRIVATE_KEY`, `PRIVATE_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `FLEET_CREDENTIALS_FILE`,
`CREDENTIALS_DIRECTORY`.

`OPERATOR_UNREADABLE_FILES` (`src/fleet/operator/main.ts:64-72`):
`/etc/automaton-fleet/admin.env`, `/etc/automaton-fleet/service.env`, `/etc/automaton-fleet/tls/fleet.key`,
`/etc/automaton-fleet/legacy-env-fleet.bak`, `/run/credentials/automaton-fleet.service/service.env`,
`/run/credentials/automaton-fleet.service/tls.key`, `/var/lib/automaton-fleet-witness/fleet-credentials.json`.

`SAFETY_SWITCHES` (`src/fleet/operator/main.ts:39`): `REAL_REPLICATION_ENABLED`, `REAL_PAYMENTS_ENABLED`,
`OWNER_SWEEP_ENABLED`, `FLEET_DRY_RUN_CHILD`. (`FLEET_REMOTE_LISTEN_ENABLED` is not checked here.)

### 4.2 Database checks (`startOperatorApiFromEnv`, `src/fleet/operator/main.ts:133-157`)

Performed with the operator login's pool, in order; any failure closes the pool and throws
`Operator API startup refused: <redacted message>`:

1. `gateway.identity()` (`src/fleet/operator/gateway.ts:134-142`): refuse if the login owns the current
   schema or is superuser.
2. `current_user` must equal `FLEET_OPERATOR_DB_LOGIN` or `fleet_operator_login`.
3. Role memberships other than `fleet_operator` → refuse (`the operator database login is a member of …`).
4. `op_ping().schemaVersion` must be `8` (`OPERATOR_SCHEMA_VERSION`, `src/fleet/operator/server.ts:54`).
5. Pinned release (`normalizeRepoUrl(repo)`, commit, buildId, lockfileSha256) must equal the registry
   approval returned by `op_ping` (`runtimeRepo`, `runtimeCommit`, `runtimeBuildId`,
   `runtimeLockfileSha256`), else `pinned runtime release differs from the registry-approved runtime`.
6. `gateway.auditOperator(schema)` (privilege audit restricted to operator roles plus the connected login,
   `requireOperatorRoles: true`, `src/fleet/operator/gateway.ts:145-150`) must be `ok`.

Then the service is constructed. `OperatorService`'s constructor itself throws if
`verifyRoutePolicy()` reports any problem (`src/fleet/operator/server.ts:168-170`), and `listen()`
refuses non-loopback hosts (`:197-198`, allowed: `127.0.0.1`, `::1`, `localhost`).
On success it logs `operator_api_started` with `{url, schemaVersion: 8}` (`src/fleet/operator/main.ts:175`).
SIGTERM/SIGINT close the server and pool then exit 0 (`:180-184`).

---

## 5. Database roles: `fleet_operator` / `fleet_operator_login`

### 5.1 Role creation (`scripts/fleet-db-roles.sql`, run as superuser by `scripts/fleet-db-setup.sh`)

```sql
SELECT 'CREATE ROLE fleet_operator NOLOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleet_operator') \gexec
SELECT 'CREATE ROLE fleet_operator_login LOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleet_operator_login') \gexec
ALTER ROLE fleet_operator       NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE fleet_operator_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8;
SELECT format('ALTER ROLE fleet_operator_login PASSWORD %L', :'operator_password') \gexec
GRANT fleet_operator TO fleet_operator_login;
-- (non-own memberships are revoked, lines 65-72)
REVOKE ALL ON DATABASE :"dbname" FROM ..., fleet_operator, fleet_operator_login;
GRANT CONNECT ON DATABASE :"dbname" TO fleet_agent_login, fleet_service_login, fleet_operator_login;
ALTER ROLE fleet_operator_login IN DATABASE :"dbname" SET statement_timeout = '5s';
ALTER ROLE fleet_operator_login IN DATABASE :"dbname" SET lock_timeout = '2s';
ALTER ROLE fleet_operator_login IN DATABASE :"dbname" SET idle_in_transaction_session_timeout = '10s';
```

Sources: `scripts/fleet-db-roles.sql:44-47,54-55,58,62,65-72,77-78,89-91`. Password statements are kept
out of the server log by `SET log_statement = 'none'` etc. (`:30-33`).

### 5.2 Privilege grant (`grantOperatorRole`, `src/fleet/postgres/store.ts:819-834`)

Runs automatically at `fleet:migrate` if the role exists (`store.ts:567-573`), or manually with
`fleet:admin grant-operator-role [role]` (`src/fleet/postgres/cli.ts:541-544`). In one transaction:

```sql
REVOKE ALL ON ALL TABLES    IN SCHEMA "fleet" FROM PUBLIC, "fleet_operator";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA "fleet" FROM PUBLIC, "fleet_operator";
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "fleet" FROM PUBLIC, "fleet_operator";
REVOKE ALL ON SCHEMA "fleet" FROM PUBLIC, "fleet_operator";
GRANT USAGE ON SCHEMA "fleet" TO "fleet_operator";
GRANT EXECUTE ON FUNCTION "fleet".<fn> TO "fleet_operator";   -- for each OPERATOR_API_FUNCTIONS entry
```

then writes event `operator_role_granted` (actor `operator`, detail `{role, functions}`).

`OPERATOR_API_FUNCTIONS` (`src/fleet/postgres/migrations.ts:1180-1189`) — the only 8 functions executable:

```
op_begin_request(text, text, text, bigint, text, text)
op_key_material(text, text)
op_ping()
op_whoami(uuid)
op_fleet_status(uuid)
op_list_agents(uuid, text, integer)
op_get_agent(uuid, text)
op_list_events(uuid, bigint, integer, text)
```

Related constants (`src/fleet/postgres/migrations.ts:1192-1208`):
- `OPERATOR_VOLATILE_FUNCTIONS = ["op_begin_request(text, text, text, bigint, text, text)"]`
- `OPERATOR_READ_FUNCTIONS = ["op_whoami","op_fleet_status","op_list_agents","op_get_agent","op_list_events"]`
- `OPERATOR_BOOKKEEPING_TABLES = ["fleet_operator_nonces","fleet_operator_requests","fleet_operator_state"]`

The role has no table, sequence or other-function privilege. Store constant
`DEFAULT_OPERATOR_ROLE = "fleet_operator"` (`src/fleet/postgres/store.ts:74`), overridable with
`FLEET_OPERATOR_ROLE` (`:445`).

### 5.3 Gateway connection parameters (`PgOperatorGateway`, `src/fleet/operator/gateway.ts:53-66`)

| Parameter | Value |
|---|---|
| `max` | 4 |
| `connectionTimeoutMillis` | 5000 |
| `idleTimeoutMillis` | 10000 |
| `allowExitOnIdle` | true |
| `application_name` | `automaton-fleet-operator-api` |
| `options` | `-c search_path=<schema> -c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=10000` |

The gateway issues only `SELECT <schema>.op_*(...) AS r` calls plus the identity/audit catalog queries;
it never issues table SQL (comment `:1-6`).

---

## 6. Schema v8: tables, constraints, triggers

Migration `{ version: 8, name: "operator_api_read_only", sql: V8_SQL }` (`src/fleet/postgres/migrations.ts:1122`).
`@@SCHEMA@@` is replaced with the schema name. Constant `OPERATOR_REQUEST_CAP = 2_000_000`
(`src/fleet/postgres/migrations-phase8.ts:31`).

### 6.1 `fleet_operator_state` (single row; kill switch, generation, counter) — `migrations-phase8.ts:35-62`

```sql
CREATE TABLE fleet_operator_state (
  id                    integer     PRIMARY KEY CHECK (id = 1),
  operator_api_enabled  boolean     NOT NULL DEFAULT false,
  generation            bigint      NOT NULL DEFAULT 0 CHECK (generation >= 0),
  request_count         bigint      NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  request_cap           bigint      NOT NULL DEFAULT 2000000 CHECK (request_cap = 2000000),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            text        NOT NULL DEFAULT 'migration' CHECK (length(updated_by) BETWEEN 1 AND 128)
);
INSERT INTO fleet_operator_state (id) VALUES (1);
```

Triggers:
- `fleet_operator_state_guard` BEFORE UPDATE: raises `FLEET_HISTORY_IMMUTABLE: the operator request counter only decreases through audited archival`
  when `NEW.request_count < OLD.request_count` unless GUC `fleet.operator_archive = 'on'`; raises
  `FLEET_HISTORY_IMMUTABLE: the operator generation never decreases` when generation decreases.
- `fleet_operator_state_no_delete` (row) and `fleet_operator_state_no_truncate` (statement) →
  `fleet_history_immutable()`.

### 6.2 `fleet_operator_principals` — `migrations-phase8.ts:65-80`

```sql
CREATE TABLE fleet_operator_principals (
  principal_id   text        PRIMARY KEY CHECK (principal_id ~ '^op_[0-9A-HJKMNP-TV-Z]{26}$'),
  name           text        NOT NULL UNIQUE CHECK (name ~ '^[a-z][a-z0-9-]{2,40}$'),
  kind           text        NOT NULL CHECK (kind IN ('bridge_claude','bridge_chatgpt')),
  scopes         text[]      NOT NULL CHECK (
                   cardinality(scopes) BETWEEN 1 AND 3
                   AND scopes <@ ARRAY['ops.read.status','ops.read.agents','ops.read.events']::text[]
                   AND array_position(scopes, NULL) IS NULL),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text        NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  revoked_at     timestamptz,
  revoked_by     text        CHECK (length(revoked_by) <= 128),
  revoke_reason  text        CHECK (length(revoke_reason) <= 200),
  CONSTRAINT fleet_operator_principals_revocation_complete CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CONSTRAINT fleet_operator_principals_chatgpt_no_events CHECK (kind <> 'bridge_chatgpt' OR NOT ('ops.read.events' = ANY (scopes)))
);
```

Trigger `fleet_operator_principals_guard` BEFORE INSERT OR UPDATE (`:101-125`):
- INSERT: duplicate scopes → `FLEET_OPERATOR_INVALID: duplicate scopes`; `revoked_at` set → `FLEET_OPERATOR_INVALID: a principal cannot be created revoked`.
- UPDATE: any change to `principal_id`, `name`, `kind`, `scopes`, `created_at`, `created_by` →
  `FLEET_HISTORY_IMMUTABLE: operator principal identity cannot change`.
- UPDATE on an already-revoked row changing any `revoked_*`/`revoke_reason` →
  `FLEET_HISTORY_IMMUTABLE: operator revocation is final`.

Also `fleet_operator_principals_no_delete` and `_no_truncate` → `fleet_history_immutable()` (`:126-129`).

### 6.3 `fleet_operator_keys` — `migrations-phase8.ts:82-98`

```sql
CREATE TABLE fleet_operator_keys (
  key_id         text        PRIMARY KEY CHECK (key_id ~ '^[0-9a-f]{32}$'),
  principal_id   text        NOT NULL REFERENCES fleet_operator_principals(principal_id),
  algorithm      text        NOT NULL DEFAULT 'ed25519' CHECK (algorithm = 'ed25519'),
  public_key     bytea       NOT NULL UNIQUE CHECK (octet_length(public_key) = 32),
  not_before     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text        NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  revoked_at     timestamptz,
  revoked_by     text        CHECK (length(revoked_by) <= 128),
  revoke_reason  text        CHECK (length(revoke_reason) <= 200),
  CONSTRAINT fleet_operator_keys_id_is_fingerprint CHECK (key_id = left(encode(sha256(public_key), 'hex'), 32)),
  CONSTRAINT fleet_operator_keys_validity CHECK (expires_at > not_before AND expires_at <= not_before + interval '90 days'),
  CONSTRAINT fleet_operator_keys_revocation_complete CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX fleet_operator_keys_principal_idx ON fleet_operator_keys (principal_id) WHERE revoked_at IS NULL;
```

Trigger `fleet_operator_keys_guard` BEFORE INSERT OR UPDATE (`:131-162`):
- INSERT: `revoked_at` set → `FLEET_OPERATOR_INVALID: a key cannot be created revoked`.
  Then `PERFORM 1 FROM fleet_operator_principals WHERE principal_id = NEW.principal_id FOR UPDATE;`
  (lock first), then if the principal is revoked → `FLEET_OPERATOR_INVALID: principal % is revoked`;
  if the principal already has ≥ 2 unrevoked keys → `FLEET_OPERATOR_INVALID: principal % already has 2 active keys (revoke one first)`.
  Note: the 2-key count counts unrevoked keys including expired ones.
- UPDATE: any change to key identity/material/validity/created fields → `FLEET_HISTORY_IMMUTABLE: operator key material cannot change`;
  changing revocation on an already-revoked key → `FLEET_HISTORY_IMMUTABLE: operator key revocation is final`.

Also `_no_delete`, `_no_truncate` (`:163-166`).

### 6.4 `fleet_operator_nonces` — `migrations-phase8.ts:169-177`

```sql
CREATE TABLE fleet_operator_nonces (
  principal_id  text        NOT NULL REFERENCES fleet_operator_principals(principal_id),
  nonce_sha256  text        NOT NULL CHECK (nonce_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at    timestamptz NOT NULL,
  PRIMARY KEY (principal_id, nonce_sha256)
);
CREATE INDEX fleet_operator_nonces_expiry_idx ON fleet_operator_nonces (expires_at);
```

Only TRUNCATE is blocked (`fleet_operator_nonces_no_truncate`). DELETE is allowed (purge inside
`op_begin_request`).

### 6.5 `fleet_operator_routes` — `migrations-phase8.ts:180-196`

```sql
CREATE TABLE fleet_operator_routes (
  route  text   PRIMARY KEY CHECK (route ~ '^GET /v1/operator/[a-z0-9_/{}-]+$'),
  scope  text   CHECK (scope IS NULL OR scope IN ('ops.read.status','ops.read.agents','ops.read.events')),
  fn     text   NOT NULL UNIQUE CHECK (fn IN ('op_whoami','op_fleet_status','op_list_agents','op_get_agent','op_list_events')),
  kinds  text[] NOT NULL CHECK (cardinality(kinds) BETWEEN 1 AND 2
                                AND kinds <@ ARRAY['bridge_claude','bridge_chatgpt']::text[])
);
INSERT INTO fleet_operator_routes (route, scope, fn, kinds) VALUES
  ('GET /v1/operator/whoami',            NULL,              'op_whoami',       ARRAY['bridge_claude','bridge_chatgpt']),
  ('GET /v1/operator/status',            'ops.read.status', 'op_fleet_status', ARRAY['bridge_claude','bridge_chatgpt']),
  ('GET /v1/operator/agents',            'ops.read.agents', 'op_list_agents',  ARRAY['bridge_claude','bridge_chatgpt']),
  ('GET /v1/operator/agents/{agent_id}', 'ops.read.agents', 'op_get_agent',    ARRAY['bridge_claude','bridge_chatgpt']),
  ('GET /v1/operator/events',            'ops.read.events', 'op_list_events',  ARRAY['bridge_claude']);
```

`fleet_operator_routes_no_change` BEFORE UPDATE OR DELETE and `_no_truncate` → immutable. INSERT is
not blocked by a trigger (only the owner could insert; the CHECK confines `fn` to the five reads).

### 6.6 `fleet_operator_requests` — `migrations-phase8.ts:199-225`

```sql
CREATE TABLE fleet_operator_requests (
  request_id    uuid        PRIMARY KEY,
  principal_id  text        NOT NULL REFERENCES fleet_operator_principals(principal_id),
  key_id        text        NOT NULL REFERENCES fleet_operator_keys(key_id),
  route         text        NOT NULL REFERENCES fleet_operator_routes(route),
  scope         text,
  client_ts     timestamptz NOT NULL,
  nonce_sha256  text        NOT NULL CHECK (nonce_sha256 ~ '^[0-9a-f]{64}$'),
  body_sha256   text        NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  received_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_operator_requests_principal_idx ON fleet_operator_requests (principal_id, received_at);
CREATE INDEX fleet_operator_requests_received_idx ON fleet_operator_requests (received_at);
```

Trigger `fleet_operator_requests_guard` BEFORE UPDATE OR DELETE: DELETE allowed only when GUC
`fleet.operator_archive = 'on'`; otherwise raises
`FLEET_HISTORY_IMMUTABLE: <TG_OP> on fleet_operator_requests is not allowed (archive with fleet:admin operator-archive)`.
Plus `_no_truncate`. There is no `method` column (only GET exists; the method is part of `route`).

### 6.7 Grants cleanup at end of V8 (`migrations-phase8.ts:530-531`)

```sql
REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
```

### 6.8 Approver rule extended (`fleet_require_operator_approver`, `migrations-phase8.ts:313-325`)

`CREATE OR REPLACE` of the phase-5 function. It now also raises
`FLEET_SELF_APPROVAL: operator API principals can never approve (approver %)` when the approver
matches `^op[:_]` (case-insensitive) or equals any `principal_id` or `name` in
`fleet_operator_principals`. (Existing checks: empty approver → `FLEET_APPROVAL_REQUIRED`; equal to
subject or an agent id / wallet → `FLEET_SELF_APPROVAL`.)

---

## 7. Schema v8: functions (`op_*` and helpers)

All operator-callable functions are `SECURITY DEFINER` with `SET search_path = <schema>, pg_temp`
and owned by the schema owner.

| Function | Volatility | Security | Granted to `fleet_operator` | Lines |
|---|---|---|---|---|
| `op_begin_request(text,text,text,bigint,text,text) → jsonb` | VOLATILE (plpgsql default) | DEFINER | yes | `migrations-phase8.ts:348-425` |
| `op_key_material(text,text) → jsonb` | STABLE | DEFINER | yes | `:428-443` |
| `op_ping() → jsonb` | STABLE (sql) | DEFINER | yes | `:447-455` |
| `op_whoami(uuid) → jsonb` | STABLE | DEFINER | yes | `:458-468` |
| `op_fleet_status(uuid) → jsonb` | STABLE | DEFINER | yes | `:470-484` |
| `op_list_agents(uuid,text,integer) → jsonb` | STABLE | DEFINER | yes | `:494-503` |
| `op_get_agent(uuid,text) → jsonb` | STABLE | DEFINER | yes | `:505-515` |
| `op_list_events(uuid,bigint,integer,text) → jsonb` | STABLE | DEFINER | yes | `:517-528` |
| `fleet_operator_request_ok(uuid,text) → fleet_operator_requests` | STABLE | invoker | no (owner-only helper) | `:329-344` |
| `fleet_operator_agent_json(fleet_agents) → jsonb` | STABLE (sql) | invoker | no | `:486-492` |
| `fleet_operator_request_line(fleet_operator_requests) → text` | STABLE (sql) | invoker | no | `:236-244` |
| `fleet_operator_archive_check(timestamptz,bigint) → void` | STABLE | invoker | no | `:246-255` |
| `fleet_operator_archive_export(timestamptz,integer) → TABLE(line text)` | STABLE | invoker | no | `:257-263` |
| `fleet_operator_archive_requests(timestamptz,bigint,text,text) → bigint` | VOLATILE | invoker | no (owner only) | `:265-310` |
| trigger functions `fleet_operator_state_guard`, `_principals_guard`, `_keys_guard`, `_requests_guard` | — | invoker | no | see §6 |

### 7.1 `op_begin_request` — the only volatile operator function

Full body at `src/fleet/postgres/migrations-phase8.ts:348-425`. Decision sequence (first matching sets
`v_code` / `v_type`; later stages run only while `v_code IS NULL`):

| Stage | Condition | `code` | Event type |
|---|---|---|---|
| actor | `v_actor := 'op:' || p_principal` if it matches `^op_[0-9A-HJKMNP-TV-Z]{26}$`, else `'op:invalid'` | — | — |
| route | `SELECT * INTO rt FROM fleet_operator_routes WHERE route = p_route`; `v_route := rt.route` or `'unknown'` | — | — |
| 1 format | principal/key/nonce/body regex fail, or `p_client_ts_ms` NULL / `< 1000000000000` / `> 9999999999999` | `FLEET_OP_BAD_REQUEST` | `operator_bad_request` |
| 1 route | `v_route = 'unknown'` | `FLEET_OP_NOT_FOUND` | `operator_bad_request` |
| 2 state | `SELECT * INTO st FROM fleet_operator_state WHERE id = 1 FOR UPDATE`; missing or `NOT operator_api_enabled` | `FLEET_OP_DISABLED` | `operator_disabled` |
| 2 cap | `st.request_count >= st.request_cap` | `FLEET_OP_AUDIT_FULL` | `operator_audit_full` |
| 3 principal | principal missing or revoked | `FLEET_OP_AUTH_FAILED` | `operator_auth_failed` |
| 3 key | key missing for that principal, revoked, `now() < not_before`, or `now() >= expires_at` | `FLEET_OP_AUTH_FAILED` | `operator_auth_failed` |
| 3 policy | `NOT (pr.kind = ANY (rt.kinds))` or (`rt.scope IS NOT NULL` and scope not in `pr.scopes`) | `FLEET_OP_SCOPE_DENIED` | `operator_scope_denied` |
| 4 window | `v_ts := to_timestamp(p_client_ts_ms / 1000.0)`; `abs(extract(epoch FROM (now() - v_ts))) > 30` | `FLEET_OP_STALE` | `operator_stale` |
| 5 nonce | `v_nh := encode(sha256(convert_to(p_nonce,'UTF8')),'hex')`; `INSERT INTO fleet_operator_nonces VALUES (p_principal, v_nh, v_ts + interval '60 seconds') ON CONFLICT DO NOTHING`; 0 rows inserted | `FLEET_OP_REPLAYED` | `operator_replay_blocked` |

On denial (`:406-417`): a bounded denial event, then `RETURN {"ok": false, "code": v_code}`:

```sql
IF (SELECT count(*) FROM fleet_events e
     WHERE e.id > (SELECT COALESCE(max(id), 0) FROM fleet_events) - 1000
       AND e.actor LIKE 'op:%' AND e.created_at > now() - interval '1 minute') < 60 THEN
  PERFORM fleet_event(v_type, NULL, v_actor, jsonb_build_object('code', v_code, 'route', v_route, 'layer', 'database'));
END IF;
RETURN jsonb_build_object('ok', false, 'code', v_code);
```

On acceptance (`:419-424`):

```sql
v_id := gen_random_uuid();
INSERT INTO fleet_operator_requests (request_id, principal_id, key_id, route, scope, client_ts, nonce_sha256, body_sha256)
  VALUES (v_id, p_principal, p_key, rt.route, rt.scope, v_ts, v_nh, p_body_sha256);
UPDATE fleet_operator_state SET request_count = request_count + 1 WHERE id = 1;
DELETE FROM fleet_operator_nonces WHERE ctid IN (SELECT ctid FROM fleet_operator_nonces WHERE expires_at < now() LIMIT 1000);
RETURN jsonb_build_object('ok', true, 'requestId', v_id, 'fn', rt.fn, 'requestCount', st.request_count + 1, 'requestCap', st.request_cap);
```

Properties:
- The `FOR UPDATE` on the state row serialises every request that reaches stage 2.
- Denials do not increment `request_count`; the replay-denied nonce insert did not happen, so a
  denied request writes only (at most) one `fleet_events` row.
- Nonce purge runs only on accepted requests, at most 1000 expired rows (any principal).
- A nonce is retained until `client_ts + 60 s`; since `client_ts` is within ±30 s of `now()`, the
  nonce always outlives the window in which the same timestamp could be accepted.
- The DB order (kill switch → cap → principal/key → scope/kind → window → nonce) differs from the
  process order (§11). Hence a stale request for a revoked key is reported `FLEET_OP_AUTH_FAILED` by
  the DB, but the process rejects it earlier as `FLEET_OP_STALE`.

### 7.2 `op_key_material` (`:428-443`)

Returns `{"ok": false}` for bad formats, unknown/revoked principal, unknown/revoked key, or
`now()` outside `[not_before, expires_at)`. Otherwise:

```json
{ "ok": true, "publicKey": "<base64 (standard, padded) of the 32 raw bytes>", "kind": "bridge_claude|bridge_chatgpt",
  "scopes": ["..."], "expiresAt": "<timestamptz>" }
```

No request id is required (used before authentication to fetch the verification key). Public keys
only.

### 7.3 `op_ping` (`:447-455`)

```sql
SELECT jsonb_build_object('schemaVersion', (SELECT max(version) FROM fleet_schema_migrations),
  'operatorApiEnabled', s.operator_api_enabled, 'generation', s.generation,
  'requestCount', s.request_count, 'requestCap', s.request_cap, 'dbTime', now(),
  'runtimeRepo', f.runtime_repo, 'runtimeCommit', f.runtime_commit, 'runtimeBuildId', f.runtime_build_id,
  'runtimeLockfileSha256', f.runtime_lockfile_sha256)
  FROM fleet_operator_state s CROSS JOIN fleet_state f WHERE s.id = 1 AND f.id = 1
```

### 7.4 `fleet_operator_request_ok` (read gate, `:329-344`)

Every read function first calls `fleet_operator_request_ok(p_request, '<own fn name>')`, which
requires a `fleet_operator_requests` row with:

```sql
JOIN fleet_operator_routes rt ON rt.route = q.route AND rt.fn = p_fn
JOIN fleet_operator_principals p ON p.principal_id = q.principal_id AND p.revoked_at IS NULL
JOIN fleet_operator_keys k ON k.key_id = q.key_id AND k.revoked_at IS NULL AND now() < k.expires_at
JOIN fleet_operator_state s ON s.id = 1 AND s.operator_api_enabled
WHERE q.request_id = p_request AND q.received_at > now() - interval '30 seconds'
  AND (rt.scope IS NULL OR rt.scope = ANY (p.scopes)) AND p.kind = ANY (rt.kinds);
```

else `RAISE EXCEPTION 'FLEET_OP_REQUEST_INVALID'`. A request id is therefore bound to one read
function, valid for 30 s of DB time, and re-checked against revocation, expiry, kill switch, scope and
kind at read time. It is not single-use (see §28).

### 7.5 Read functions

- `op_whoami` (`:458-468`): `{principal: {id, name, kind, scopes (sorted)}, key: {id, expiresAt}}`.
- `op_fleet_status` (`:470-484`):
  `{fleet: {maxAgents, living, reserved, quarantined, mode, replicationEnabled}, runtime: {repo, commit, buildId, lockfileSha256}, schema: {version}, operatorApi: {enabled, requestCount, requestCap}}`
  from `fleet_state` columns `max_agents, living_agents, reserved_slots, quarantined_slots, operating_mode, replication_enabled, runtime_*`.
- `op_list_agents` (`:494-503`): `v_limit := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)`; returns
  up to `v_limit + 1` rows of `fleet_agents` with `agent_id > p_after` (if given), ordered by `agent_id`,
  each via `fleet_operator_agent_json`; `{items: [...], limit: v_limit}`.
- `fleet_operator_agent_json` (`:486-492`): `agentId, role, generation, parentAgentId, status, capabilityScope, dryRun, runtimeCommit, createdAt, lastHeartbeat, deathTime, name`.
  (No wallet, custody, sandbox or credential fields.)
- `op_get_agent` (`:505-515`): `{found: false}` or `{found: true, item: <agent json>}`.
- `op_list_events` (`:517-528`): same clamp; rows of `fleet_events` with `id > p_after` and optional
  `event_type = p_type`, ordered by `id`, `LIMIT v_limit + 1`; each
  `{id: id::text, type, agentId, actor, createdAt, detail}`. Raw `actor` and full `detail` are returned
  to the process, which reduces them (§12.6).

### 7.6 Archival functions — see §20.

---

## 8. Listener and HTTP server parameters

`OperatorService.listen` (`src/fleet/operator/server.ts:197-213`):

```ts
http.createServer(
  { maxHeaderSize: OP_LIMITS.maxHeaderBytes, requestTimeout: 10_000, headersTimeout: 5_000, keepAliveTimeout: 5_000 },
  (req, res) => void this.handle(req, res),
);
```

| Limit | Value | Source |
|---|---|---|
| Address | `127.0.0.1` (only `127.0.0.1`, `::1`, `localhost` accepted) | `server.ts:134-136,198` |
| Port | `8788` | `main.ts:37`, unit `:34` |
| Max header bytes | 8192 | `canonical.ts:38-42` |
| Max request target | 2048 bytes (UTF-8) | `canonical.ts:39,77` |
| Request timeout | 10 s | `server.ts:201` |
| Headers timeout | 5 s | `server.ts:201` |
| Keep-alive timeout | 5 s | `server.ts:201` |
| Max concurrent in-flight signed requests | 16 | `server.ts:77,334` |
| Max response bytes (pages) | 262144 (256 KiB) | `server.ts:80` |
| Poll interval (kill switch/generation, readiness cache) | 5000 ms | `server.ts:79,209` |
| Key cache TTL | 30000 ms | `server.ts:78,276` |

Every response carries headers (`server.ts:305-316`):
`content-type: application/json; charset=utf-8`, `cache-control: no-store`,
`x-content-type-options: nosniff`, `x-request-id: <process UUID>`, `content-length`.

Network reach: only loopback. The Claude bridge on the dev VM reaches it via SSH local forwarding to
the restricted account `fleet-op-tunnel` (`authorized_keys`:
`restrict,port-forwarding,permitopen="127.0.0.1:8788",command="/usr/sbin/nologin"`,
`docs/fleet-production-runbook.md:1191`). The ChatGPT adapter runs on the VPS and connects directly
to loopback 8788 (`src/fleet/chatgpt-adapter/main.ts:7,20`).

**DRIFT:** design §5.2 (`docs/design/phase-b-operator-api.md:197`) says "The request MUST be HTTP/1.1".
The code does not inspect `req.httpVersion` (no reference in `src/fleet/operator/*.ts`). Node's
parser accepts HTTP/1.0 and 1.1. **NOT IMPLEMENTED** as a check.

---

## 9. Principal model, kinds, scopes, keys

### 9.1 Principals are not agents

`src/fleet/postgres/migrations-phase8.ts:4-7`: principals never occupy slots, own no wallet/custody,
have no lifecycle, inherit no agent permission. No foreign key relates principals to agent tables.

### 9.2 Kinds

`OperatorKind = "bridge_claude" | "bridge_chatgpt"` (`src/fleet/operator/route-policy.ts:17,20`);
DB CHECK `kind IN ('bridge_claude','bridge_chatgpt')` (`migrations-phase8.ts:68`).
`operator_console` is design-reserved only: **NOT IMPLEMENTED** (no code or CHECK value).

### 9.3 Scopes

| Scope | Grants route(s) | Kinds allowed by route policy |
|---|---|---|
| (none) | `GET /v1/operator/whoami` | both |
| `ops.read.status` | `GET /v1/operator/status` | both |
| `ops.read.agents` | `GET /v1/operator/agents`, `GET /v1/operator/agents/{agent_id}` | both |
| `ops.read.events` | `GET /v1/operator/events` | `bridge_claude` only |

`OPERATOR_SCOPES` (`route-policy.ts:21`). `RESERVED_SCOPES = ["ops.read.treasury"]` (`route-policy.ts:23`)
is exported but referenced nowhere else in `src/`; `ops.read.treasury` is **NOT IMPLEMENTED** (Phase E).
`ops.propose` does not exist (**NOT IMPLEMENTED**, requires a separate security gate, `route-policy.ts:11-12`).

Scope constraints enforced in three places:
1. DB CHECK `fleet_operator_principals_chatgpt_no_events`: a `bridge_chatgpt` principal can never hold
   `ops.read.events` (`migrations-phase8.ts:79`).
2. DB routes table: `events` route has `kinds = ARRAY['bridge_claude']` (`:192`).
3. Application `verifyRoutePolicy` flags `ChatGPT may not read events in v1 (D-5)` if the events route
   allowed `bridge_chatgpt` (`route-policy.ts:91`).

Other scope rules: 1–3 scopes, subset of the three, no NULL (`migrations-phase8.ts:69-72`), no
duplicates (trigger), immutable after enrollment (trigger). Admin CLI requires `scopes` non-empty and from
`OPERATOR_SCOPES` (`src/fleet/operator/admin.ts:93`).

### 9.4 Identifiers

| Identifier | Format | Derivation | Source |
|---|---|---|---|
| Principal ID | `^op_[0-9A-HJKMNP-TV-Z]{26}$` | `op_` + `ulid()` at enrollment | `admin.ts:97`, `canonical.ts:44` |
| Principal name | `^[a-z][a-z0-9-]{2,40}$`, unique | operator-chosen | `migrations-phase8.ts:67` |
| Key ID | `^[0-9a-f]{32}$` | first 32 lowercase hex chars of SHA-256 of the raw 32-byte Ed25519 public key | `canonical.ts:158-161`, DB CHECK `migrations-phase8.ts:94` |
| Public key (CLI input) | `^[A-Za-z0-9_-]{43}$`, canonical base64url of 32 bytes | printed by keygen | `admin.ts:79-84` |

Key ID derivation (`src/fleet/operator/canonical.ts:158-161`):

```ts
export function keyIdOf(rawPublicKey: Buffer): string {
  return crypto.createHash("sha256").update(rawPublicKey).digest("hex").slice(0, 32);
}
```

DB equivalent: `key_id = left(encode(sha256(public_key), 'hex'), 32)`.

### 9.5 Keys

- Algorithm `ed25519` only (CHECK).
- `not_before` defaults to `now()`; `expires_at = now() + make_interval(days => N)`, N integer 1..90
  (`admin.ts:94,108,120,126`); DB caps validity at 90 days.
- At most 2 unrevoked keys per principal (trigger). Rotation: add second key, switch, revoke old.
- Revocation is final; keys and principals are never deleted.
- An expired key is simply refused; it does not revoke the principal.

---

## 10. Signing protocol FLEET-OP-SIG-V1

### 10.1 Headers (`src/fleet/operator/canonical.ts:28-51`)

| Header (lowercase as read) | Regex | Meaning |
|---|---|---|
| `x-fleet-op-principal` | `^op_[0-9A-HJKMNP-TV-Z]{26}$` | Principal ID |
| `x-fleet-op-key` | `^[0-9a-f]{32}$` | Key ID |
| `x-fleet-op-timestamp` | `^[1-9][0-9]{12}$` | Unix epoch milliseconds, exactly 13 digits |
| `x-fleet-op-nonce` | `^[A-Za-z0-9_-]{22,64}$` | base64url, 22–64 chars (≥ 128 bits) |
| `x-fleet-op-signature` | `^[A-Za-z0-9_-]{86}$` | Ed25519 signature, base64url no padding |

`readOpHeaders` (`canonical.ts:134-148`) reads `req.headersDistinct`:
- If `authorization` or `cookie` is present at all → failure (agent credentials never cross over).
- Each X-Fleet-Op header must be present exactly once (`v.length === 1`) and match its regex. A
  comma-joined value fails the regex. Duplicate header lines produce `length 2`.
- Any failure → `FLEET_OP_BAD_REQUEST` (400).

### 10.2 Request target canonicalization (`parseTarget`, `canonical.ts:76-101`)

Rejects, never normalizes:

```ts
const PATH_RE = /^\/v1\/operator(\/[a-z0-9][a-z0-9_-]{0,63})+$/;
const QUERY_KEY_RE = /^[a-z][a-z_]{0,31}$/;
const QUERY_VALUE_RE = /^[A-Za-z0-9._~-]{1,128}$/;
```

| Check | Result |
|---|---|
| empty, non-string, or `Buffer.byteLength(raw) > 2048` | `FLEET_OP_BAD_REQUEST` |
| any byte outside `\x21-\x7e` (spaces, controls, non-ASCII) or contains `#` | `FLEET_OP_NONCANONICAL` |
| path (before first `?`) fails `PATH_RE` (covers `%`, uppercase, empty/dot segments, trailing slash, `+` in path) | `FLEET_OP_NONCANONICAL` |
| `?` present but query empty (`/x?`) | `FLEET_OP_NONCANONICAL` |
| a part without `=` or with `=` at index 0 | `FLEET_OP_NONCANONICAL` |
| key fails `QUERY_KEY_RE` or value fails `QUERY_VALUE_RE` (empty values, `%`, `+`, leading/trailing/double `&`) | `FLEET_OP_NONCANONICAL` |
| keys not strictly increasing (`!(k > prev)`: unsorted or duplicate) | `FLEET_OP_NONCANONICAL` |

In `server.ts:338-342`, a failed `parseTarget` becomes the returned code only if the raw target starts
with `/v1/operator/`; otherwise `FLEET_OP_NOT_FOUND` (404).

### 10.3 Canonical string (`canonical.ts:114-116`)

```ts
export const OP_SIG_VERSION = "FLEET-OP-SIG-V1";
export function canonicalString(f: SignedFields): string {
  return [OP_SIG_VERSION, f.principal, f.key, f.method, f.path, f.query, f.timestamp, f.nonce, f.bodySha256].join("\n");
}
```

Nine lines, LF-separated, no trailing LF:

```
FLEET-OP-SIG-V1
<principal_id>
<key_id>
<METHOD>             exactly as received (server uses req.method; only "GET" can match a route)
<path>               raw path, already canonical
<query>              raw query without "?", "" if absent
<timestamp>          header value, 13 digits
<nonce>              header value
<body_sha256_hex>    always e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 in v1
```

`EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"` (`canonical.ts:36`).
The server always uses this constant as the body digest (`server.ts:375`), after proving the body empty.

### 10.4 Signature encoding and verification

```ts
export function decodeSignature(sig: string): Buffer | null {
  if (!SIGNATURE_RE.test(sig)) return null;
  const b = Buffer.from(sig, "base64url");
  if (b.length !== 64 || b.toString("base64url") !== sig) return null;   // canonical round-trip
  return b;
}
export function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  return crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
}
export function verifySignature(publicKey: KeyObject, canonical: string, signature: Buffer): boolean {
  try { return crypto.verify(null, Buffer.from(canonical, "utf8"), publicKey, signature); } catch { return false; }
}
```

(`canonical.ts:151-183`.) Pure Ed25519 (RFC 8032), no prehash, Node built-in crypto only. The server
decodes `op_key_material.publicKey` with `Buffer.from(km.publicKey, "base64")` and refuses unless it is
32 bytes (`server.ts:284-285`).

### 10.5 Client side (`signedHeaders`, `canonical.ts:199-223`)

```ts
const fields: SignedFields = {
  principal,
  key: opts.keyId ?? keyIdOf(rawPublicKey(privateKey)),
  method: opts.method ?? "GET",
  path: q < 0 ? target : target.slice(0, q),
  query: q < 0 ? "" : target.slice(q + 1),
  timestamp: String(opts.now ?? Date.now()),
  nonce: opts.nonce ?? newNonce(),              // crypto.randomBytes(18).toString("base64url") = 24 chars, 144 bits
  bodySha256: EMPTY_BODY_SHA256,
};
// returns the 5 x-fleet-op-* headers; signature = crypto.sign(null, utf8(canonical), privateKey).toString("base64url")
```

Used by the Claude bridge (`src/fleet/bridge/client.ts:125`), which sends `host: 127.0.0.1:<port>`
(`:158`), and by the ChatGPT adapter.

### 10.6 Nonce rules

| Rule | Where |
|---|---|
| Format `^[A-Za-z0-9_-]{22,64}$` | header regex `canonical.ts:47`; DB `migrations-phase8.ts:359` |
| Single use per principal | PK `(principal_id, nonce_sha256)`; `INSERT … ON CONFLICT DO NOTHING` → `FLEET_OP_REPLAYED` (409) |
| Stored only as SHA-256 hex of the UTF-8 nonce | `migrations-phase8.ts:397` |
| Retained until `client_ts + 60 s` | `:399` |
| Purged (≤ 1000 expired rows) only by accepted requests | `:423` |
| Same nonce under another principal is independent | PK includes principal |
| Raw nonce never logged or stored | server audit has no nonce field (`server.ts:410-419`) |

### 10.7 Timestamp / skew rules

| Layer | Clock | Window | Code | Source |
|---|---|---|---|---|
| Process | `this.now()` (Date.now) | `abs(now - ts) > 30000` ms rejects | `FLEET_OP_STALE` 401 | `server.ts:361-362`, `canonical.ts:41` |
| Database | `now()` | `abs(epoch(now() - to_timestamp(ts/1000.0))) > 30` s rejects | `FLEET_OP_STALE` | `migrations-phase8.ts:389-394` |
| Readiness | DB `dbTime` vs process | `> 5000` ms skew → clock not ok | readiness only | `main.ts:168-171` |
| DB format | — | `1000000000000 ≤ ts ≤ 9999999999999` | `FLEET_OP_BAD_REQUEST` | `migrations-phase8.ts:360` |

Both past and future timestamps beyond 30 s are rejected (tests `operator-server.test.ts:231-232`:
±31 s → 401 `FLEET_OP_STALE`).

### 10.8 Pinned test vector

`src/__tests__/fleet/operator-canonical.test.ts:22-40`. Public values:

| Field | Value |
|---|---|
| Private key | 32-byte seed at `operator-canonical.test.ts:24` wrapped in PKCS#8 DER prefix `302e020100300506032b657004220420` (`:36`). Synthetic test fixture; not reproduced here. |
| Public key (base64url) | `10SQmfADVttkQCGrKv6Y_pShOrejy7TPmiBWddrwSHg` |
| Key ID | `0f7c35011488d4ff3eb160dc6f526e4e` |
| Principal | `op_01J9ZQ3V7X4K2M8N6P5R0S1T2W` |
| Canonical string | `FLEET-OP-SIG-V1\nop_01J9ZQ3V7X4K2M8N6P5R0S1T2W\n0f7c35011488d4ff3eb160dc6f526e4e\nGET\n/v1/operator/events\nafter=41&limit=20&type=cap_set\n1790000000000\nAbCdEfGhIjKlMnOpQrStUvWx\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| Signature | deterministic Ed25519 signature at `operator-canonical.test.ts:31` (86 base64url chars) |

The test also verifies the vector independently with WebCrypto (`:78-82`).

---

## 11. Request verification order and sequence diagram

### 11.1 Exact order in `OperatorService.handle` (`src/fleet/operator/server.ts:292-421`)

| # | Step | Failure → code (HTTP) | Audit `reason` |
|---|---|---|---|
| 0a | If target is exactly `/healthz` or `/readyz` and Host header fails `LOOPBACK_HOST_HEADER` | `FLEET_OP_BAD_REQUEST` (421) | not audited |
| 0b | `GET /healthz` → 200; `GET /readyz` → 200/503 | — | not audited |
| 1 | `inflight >= 16` | `FLEET_OP_RATE_LIMITED` (429) | `concurrency` |
| 2 | `parseTarget(raw)` | `FLEET_OP_BAD_REQUEST`/`FLEET_OP_NONCANONICAL` (400) under `/v1/operator/`, else `FLEET_OP_NOT_FOUND` (404) | `target` |
| 3 | `matchRoute(method, path)` | `FLEET_OP_NOT_FOUND` (404) | `route` |
| 4 | `readOpHeaders` (exactly one of each, formats, no Authorization/Cookie) | `FLEET_OP_BAD_REQUEST` (400) | `headers` |
| 5 | `content-length` present and ≠ `"0"`, or `transfer-encoding` present | `FLEET_OP_BAD_REQUEST` (400) | `body` |
| 6 | Any body byte actually received | `FLEET_OP_BAD_REQUEST` (400) | `body` |
| 7 | Every query param must be in the route's `params` and match its regex | `FLEET_OP_BAD_PARAM` (400) | `param` |
| 8 | `abs(now − ts) > 30000` | `FLEET_OP_STALE` (401) | `clock window` |
| 9 | Key material: cache hit (≤ 30 s) or, for never-seen-valid pairs, global unknown-lookup budget | `FLEET_OP_RATE_LIMITED` (429) | `unknown key lookups` |
| 10 | `op_key_material` not ok / key not 32 bytes | `FLEET_OP_AUTH_FAILED` (401) | `unknown/revoked/expired principal or key` |
| 11 | Principal kind not in route `kinds` | `FLEET_OP_AUTH_FAILED` (401) | `principal kind not allowed for route` |
| 12 | Signature decode (canonical base64url, 64 bytes) + Ed25519 verify over canonical string | `FLEET_OP_AUTH_FAILED` (401) | `signature` |
| 13 | Route scope not in principal scopes (cached from `op_key_material`) | `FLEET_OP_SCOPE_DENIED` (403) | `scope` |
| 14 | Per-principal token bucket | `FLEET_OP_RATE_LIMITED` (429) | `principal rate` |
| 15 | `op_begin_request(...)` | DB code → status via `STATUS_OF` (unknown codes → `FLEET_OP_INTERNAL`) | `database` |
| 16 | `begun.fn !== route.fn` | `FLEET_OP_INTERNAL` (500) | `route/function mismatch between process and database` |
| 17 | `dispatch` → exactly one read function in READ ONLY tx | `FLEET_OP_INTERNAL` (500) on any error; `FLEET_OP_NOT_FOUND` (404) if `op_get_agent` returns not found | redacted error / `agent not found` |
| 18 | 200 `{ok, requestId, serverTime, data}` | — | `operator_request` |

The step numbering comment in `server.ts:7-23` labels step 5 "unused; auth failures never lock out
other principals".

Unauthenticated input never causes a DB write: steps 1–14 are in-process except `op_key_material`
(STABLE, READ ONLY transaction). The first DB write is `op_begin_request`, reached only after a valid
signature.

### 11.2 Sequence diagram

```
Bridge (dev VM or VPS adapter)        SSH tunnel (dev VM only)      Operator API (127.0.0.1:8788)           PostgreSQL (fleet_operator_login)
 |                                        |                                |                                          |
 | build target (canonical path+query)    |                                |                                          |
 | ts = Date.now(); nonce = 18 random B   |                                |                                          |
 | canonical = 9 lines (FLEET-OP-SIG-V1)  |                                |                                          |
 | sig = Ed25519(privkey, canonical)      |                                |                                          |
 |-- GET target + 5 x-fleet-op-* -------->|------ forwarded to 8788 ------->|                                          |
 |                                        |                                | [1] inflight < 16                         |
 |                                        |                                | [2] parseTarget  [3] matchRoute           |
 |                                        |                                | [4] headers  [5,6] empty body  [7] params |
 |                                        |                                | [8] |now-ts| <= 30 s                      |
 |                                        |                                | [9] key cache? else budget check          |
 |                                        |                                |-- BEGIN READ ONLY; op_key_material ----->|
 |                                        |                                |<- {ok, publicKey, kind, scopes} ---------|
 |                                        |                                | [10,11] key ok, kind allowed              |
 |                                        |                                | [12] Ed25519 verify                       |
 |                                        |                                | [13] scope  [14] per-principal bucket     |
 |                                        |                                |-- op_begin_request (read-write) -------->|
 |                                        |                                |      lock state row; kill switch; cap;   |
 |                                        |                                |      principal/key/kind/scope; ±30 s;    |
 |                                        |                                |      nonce insert; request row; count+1; |
 |                                        |                                |      purge <=1000 expired nonces         |
 |                                        |                                |<- {ok:true, requestId, fn} or            |
 |                                        |                                |   {ok:false, code} (+ bounded event)     |
 |                                        |                                | [16] fn equals route fn                   |
 |                                        |                                |-- BEGIN READ ONLY; op_<read>(requestId) >|
 |                                        |                                |      fleet_operator_request_ok gate      |
 |                                        |                                |<- jsonb ---------------------------------|
 |                                        |                                | typed rebuild + redaction + paging        |
 |                                        |                                | audit line (JSONL + journald)             |
 |<------------- 200 {ok,requestId,serverTime,data} / {ok:false,requestId,code}                              |
```

---

## 12. Routes: policy, parameters, response schemas

### 12.1 Route policy (`src/fleet/operator/route-policy.ts:33-55`)

```ts
const LIMIT = /^(?:[1-9][0-9]?|1[0-9]{2}|200)$/;          // 1..200, no leading zero
const ULID_LOWER = /^[0-9a-hjkmnp-tv-z]{26}$/;
const EVENT_ID = /^[1-9][0-9]{0,18}$/;
const EVENT_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const BOTH = ["bridge_claude", "bridge_chatgpt"];

"GET /v1/operator/whoami":            { scope: null,              kinds: BOTH,              fn: "op_whoami",       params: {} }
"GET /v1/operator/status":            { scope: "ops.read.status", kinds: BOTH,              fn: "op_fleet_status", params: {} }
"GET /v1/operator/agents":            { scope: "ops.read.agents", kinds: BOTH,              fn: "op_list_agents",  params: { after: ULID_LOWER, limit: LIMIT } }
"GET /v1/operator/agents/{agent_id}": { scope: "ops.read.agents", kinds: BOTH,              fn: "op_get_agent",    params: {} }
"GET /v1/operator/events":            { scope: "ops.read.events", kinds: ["bridge_claude"], fn: "op_list_events",  params: { after: EVENT_ID, limit: LIMIT, type: EVENT_TYPE } }
```

Default deny: anything not in the table is 404 and never dispatched.

`matchRoute` (`route-policy.ts:64-74`): exact key `"<METHOD> <path>"`, else
`/^\/v1\/operator\/agents\/([^/]+)$/` with the segment matching `ULID_LOWER`. Non-GET methods never
match (no non-GET keys exist) → 404.

`verifyRoutePolicy` (`route-policy.ts:80-94`), run at `OperatorService` construction; any problem throws:
- key must match `^GET \/v1\/operator\/[a-z0-9_/{}-]+$`;
- `fn` must be in `OPERATOR_READ_FUNCTIONS` (signature-termination invariant);
- no `fn` mapped twice;
- scope null or a v1 scope;
- kinds non-empty and valid;
- events route must not include `bridge_chatgpt`.

The DB route table (§6.5) mirrors this independently; `op_begin_request` returns the DB's `fn` and the
server refuses a mismatch (`server.ts:393`).

### 12.2 Common envelope

Success (`server.ts:398`):

```json
{ "ok": true, "requestId": "<process UUID v4>", "serverTime": "<ISO-8601 UTC ms>", "data": { } }
```

Error (`server.ts:407`):

```json
{ "ok": false, "requestId": "<process UUID v4>", "code": "FLEET_OP_*" }
```

No message field. `x-request-id` header equals `requestId`. Note: `requestId` is generated by the
process (`crypto.randomUUID()`, `server.ts:294`) and is **not** the `fleet_operator_requests.request_id`
(`gen_random_uuid()` in `op_begin_request`); the latter is never returned to the client.

### 12.3 `GET /v1/operator/whoami`

Scope: none. Kinds: both. Params: none (any query → `FLEET_OP_BAD_PARAM`). `data` (`server.ts:426-442`):

```json
{
  "principal": {
    "id": "op_<ULID> | null",
    "name": "<^[a-z][a-z0-9-]{2,40}$> | null",
    "kind": "bridge_claude | bridge_chatgpt | unknown",
    "scopes": ["ops.read.agents", "ops.read.events", "ops.read.status"]
  },
  "key": { "id": "<32 hex> | null", "expiresAt": "<ISO-8601> | null" }
}
```

Scopes are filtered to the three v1 values; order comes from the DB (sorted ascending).

### 12.4 `GET /v1/operator/status`

Scope: `ops.read.status`. Kinds: both. Params: none. `data` = `statusBody(db, flags, readiness)`
(`src/fleet/operator/responses.ts:102-137`, called at `server.ts:443-447`):

```json
{
  "fleet": {
    "maxAgents": "int|null", "living": "int|null", "reserved": "int|null", "quarantined": "int|null",
    "mode": "DEVELOPMENT|EXPANSION|HARVEST|EMERGENCY|unknown",
    "replicationEnabled": "bool|null"
  },
  "runtime": {
    "repo": "<^https:\\/\\/[A-Za-z0-9./_-]{1,200}$> | null",
    "commit": "<40 hex>|null", "buildId": "<64 hex>|null", "lockfileSha256": "<64 hex>|null"
  },
  "schema": { "version": "int|null" },
  "safety": {
    "realReplicationEnabled": "bool|null", "realPaymentsEnabled": "bool|null",
    "ownerSweepEnabled": "bool|null", "dryRunChildEnabled": "bool|null",
    "source": "runtime.env as read by the Operator API (the controller may also set switches in its own environment)"
  },
  "readiness": { "ready": "bool", "checks": { "<name ^[a-zA-Z]{1,32}$>": { "ok": "bool", "warn": "bool" } } },
  "operatorApi": { "enabled": "bool", "requestCount": "int", "requestCap": "int", "auditLevel": "ok|info|elevated|full" }
}
```

- `safety` values are read by this process from `FLEET_RUNTIME_ENV_FILE` at each call
  (`main.ts:107-121,165`); all four are `null` if the file is missing or unreadable (never "off").
- `readiness` is the shared cached readiness (§14).
- `fleet` and `runtime` objects pass through `redactDetail`; public hashes survive because the redactor
  exempts the exact key names `commit`, `buildId`, `lockfileSha256`.
- `auditLevel`: `auditLevel(count, cap)` (§20.3).

### 12.5 `GET /v1/operator/agents?after=<id>&limit=<n>`

Scope: `ops.read.agents`. Kinds: both.

| Param | Regex | Default | Notes |
|---|---|---|---|
| `after` | `^[0-9a-hjkmnp-tv-z]{26}$` (lowercase ULID) | none | converted to uppercase `dbId` before the DB call (`responses.ts:55`, `server.ts:450`) |
| `limit` | `^(?:[1-9][0-9]?|1[0-9]{2}|200)$` | 50 | DB also clamps to 1..200 |

Query must be canonical: keys sorted, so `after` precedes `limit`.

`data`:

```json
{
  "items": [ <AgentItem>, ... ],
  "next": { "after": "<lowercase ULID of last item>" } | null
}
```

`AgentItem` (`agentItem`, `responses.ts:65-80`), each item passed through `redactDetail`:

```json
{
  "agentId": "<lowercase ULID>|null",
  "role": "root|child|unknown",
  "generation": "int|null",
  "parentAgentId": "<lowercase ULID>|null",
  "status": "reserved|provisioning|active|unresponsive|terminating|orphaned|dead|failed|unknown",
  "capabilityScope": "full|witness|unknown",
  "dryRun": "bool (false if not boolean)",
  "runtimeCommit": "<40 hex>|null",
  "createdAt": "<ISO>|null",
  "lastHeartbeat": "<ISO>|null",
  "deathTime": "<ISO>|null",
  "name": { "kind": "untrusted_text", "value": "<string ≤200>", "truncated": "bool" }
}
```

Paging (`server.ts:468-489`): the DB returns up to `limit + 1` rows; `more = rows > limit`; items are
built one by one while `256 + Σ(size+1) ≤ 262144` bytes; if an item would exceed that, the page stops
early and `more = true`. `next = {after: cursorOf(last)}` if more and at least one item, else `null`.
Items are never truncated.

### 12.6 `GET /v1/operator/agents/{agent_id}`

Scope: `ops.read.agents`. Kinds: both. Path segment must match `^[0-9a-hjkmnp-tv-z]{26}$`
(otherwise 404 route not found). No query params. `data = { "item": <AgentItem> }`; not found →
404 `FLEET_OP_NOT_FOUND` (after the request was accepted and counted).

### 12.7 `GET /v1/operator/events?after=<id>&limit=<n>&type=<t>`

Scope: `ops.read.events`. Kinds: `bridge_claude` only (a `bridge_chatgpt` principal gets
401 `FLEET_OP_AUTH_FAILED` from the process kind check, test `operator-server.test.ts:238`).

| Param | Regex | Default |
|---|---|---|
| `after` | `^[1-9][0-9]{0,18}$` | none |
| `limit` | `^(?:[1-9][0-9]?|1[0-9]{2}|200)$` | 50 |
| `type` | `^[a-z][a-z0-9_]{0,63}$` | none |

`data = { items: [<EventItem>...], next: {after: "<id>"} | null }`.

`EventItem` (`eventItem`, `responses.ts:227-250`):

```json
{
  "id": "<^[1-9][0-9]{0,18}$ string>|null",
  "type": "<^[a-z][a-z0-9_]{0,63}$>|unknown",
  "agentId": "<lowercase ULID>|null",
  "actor": { "class": "operator|operator_api|service|agent|database|unknown" },
  "createdAt": "<ISO>|null",
  "detail": { <allow-listed fields only> },
  "detailOmitted": true            // present only when type is not in EVENT_SCHEMAS (detail is then {})
}
```

`actorClass` (`responses.ts:217-225`):

| Raw actor | Class |
|---|---|
| starts with `operator:` or equals `operator` | `operator` |
| starts with `op:` | `operator_api` |
| `fleet-service` | `service` |
| uppercase ULID or `0x` + 40 hex | `agent` |
| `migration`, `reaper`, `system` | `database` |
| anything else | `unknown` |

Detail allow-list `EVENT_SCHEMAS` (`responses.ts:151-182`). Dotted paths are rebuilt as nested objects.
Field kinds: `int` (safe integer or null), `bool`, `hex40`, `hex64`, `ulid` (lowercased), `iso`,
`text` (→ `untrusted_text` or null), `{enum}` (value or `"unknown"`).

| Event type | Fields |
|---|---|
| `cap_set` | `previous: int`, `max: int` |
| `runtime_approved` | `runtime.commit: hex40`, `build.buildId: hex64`, `build.lockfileSha256: hex64`, `previous.commit: hex40`, `previous.buildId: hex64` |
| `agent_role_granted` | `role: text` |
| `service_role_granted` | `role: text` |
| `operator_role_granted` | `role: text` |
| `api_auth_failed` | `why: text`, `path: text` |
| `request_replay_blocked` | `path: text` |
| `scope_denied` | `method: enum[GET,POST]`, `path: text`, `scope: enum[full,witness]`, `layer: enum[service,database]` |
| `session_opened` | (none) |
| `credential_issued` | (none) |
| `root_registered` | `name: text`, `capabilityScope: enum[full,witness]` |
| `slot_reserved` | `living: int`, `reserved: int`, `max: int` |
| `reservation_denied` | `code: text`, `living: int`, `reserved: int`, `quarantined: int`, `max: int` |
| `agent_died` | `reason: text` |
| `agent_quarantined` | `reason: text` |
| `operator_auth_failed`, `operator_scope_denied`, `operator_replay_blocked`, `operator_stale`, `operator_disabled`, `operator_audit_full`, `operator_bad_request` | `code: enum[FLEET_OP_BAD_REQUEST, FLEET_OP_NOT_FOUND, FLEET_OP_DISABLED, FLEET_OP_AUDIT_FULL, FLEET_OP_AUTH_FAILED, FLEET_OP_SCOPE_DENIED, FLEET_OP_STALE, FLEET_OP_REPLAYED]`, `route: enum[5 routes, "unknown"]`, `layer: enum[database]` |
| `operator_principal_enrolled` | `kind: enum[bridge_claude,bridge_chatgpt]`, `keyId: text`, `expiresAt: iso` |
| `operator_key_added` | `keyId: text`, `expiresAt: iso` |
| `operator_key_revoked` | `keyId: text` |
| `operator_principal_revoked` | (none) |
| `operator_revoke_all` | `principals: int`, `keys: int` |
| `operator_api_enabled_set` | `enabled: bool`, `generation: int` |
| `operator_requests_archived` | `rows: int`, `before: iso`, `remaining: int` |
| `operator_requests_archive_failed` | `stage: enum[verify,delete]`, `rows: int`, `before: iso` |

IP addresses and raw actor strings are never returned (design D-11). The `reason` in
`operator_api_enabled_set` and `principalId` in lifecycle events are not in the allow-list and are
dropped. The `keyId` fields are typed `text`, so they appear as `untrusted_text`.

`type` filter: matched exactly against `fleet_events.event_type` in the DB; any regex-valid type is
accepted, including types not in `EVENT_SCHEMAS`.

Edge (inferred from code, not covered by a test): `after` allows 19-digit values up to
`9999999999999999999`, which exceeds PostgreSQL `bigint` max `9223372036854775807`; such a value would
make `op_list_events` raise a cast error after `op_begin_request` has accepted and counted the request,
yielding `FLEET_OP_INTERNAL` (500).

---

## 13. Unauthenticated endpoints `/healthz`, `/readyz` and the Host check (421)

`server.ts:318-331`:

```ts
const LOOPBACK_HOST_HEADER = /^(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?$/;
if ((raw === "/healthz" || raw === "/readyz") && !LOOPBACK_HOST_HEADER.test(req.headers.host ?? "")) {
  send(421, { ok: false, code: "FLEET_OP_BAD_REQUEST" });   // DNS-rebinding guard
  return;
}
if (req.method === "GET" && raw === "/healthz") { send(200, { ok: true, status: "alive" }); return; }
if (req.method === "GET" && raw === "/readyz") { const r = await this.readiness(); send(r.ready ? 200 : 503, r); return; }
```

| Request | Response |
|---|---|
| `/healthz` or `/readyz` with non-loopback or missing Host (any method) | 421 `{"ok":false,"code":"FLEET_OP_BAD_REQUEST"}` |
| `GET /healthz`, loopback Host | 200 `{"ok":true,"status":"alive"}` |
| `GET /readyz`, loopback Host | 200 or 503 `{"ready": bool, "state": "ready|disabled|not_ready", "checks": {<name>: {"ok": bool, "warn"?: bool}}}` |
| non-GET `/healthz`/`/readyz`, loopback Host | falls through to signed-route handling → `parseTarget` path fails, target not under `/v1/operator/` → 404 `FLEET_OP_NOT_FOUND` |
| `/healthz?x=1` etc. (not exact) | 404 `FLEET_OP_NOT_FOUND` |

These endpoints are not audited. The Host check applies **only** to these two exact targets; signed
`/v1/operator/*` routes do not check Host (signatures and loopback-only binding are the controls).

---

## 14. Readiness checks

`computeReadiness` (`server.ts:256-271`) plus `readinessChecks` from `main.ts:166-172`:

| Check | `ok` when | Notes |
|---|---|---|
| `database` | last `op_ping()` succeeded | `poll()` sets `dbOk` |
| `schema` | `schemaVersion === 8` | |
| `killSwitch` | `operator_api_enabled = true` | `warn: !enabled`; excluded from `allOk` |
| `privileges` | `gateway.auditOperator(schema).ok` | cached 60 s (`main.ts:167`) |
| `clock` | `abs(dbTime − Date.now()) ≤ 5000` ms AND (timesync not required OR marker file exists) | marker default `/run/systemd/timesync/synchronized` |
| `readinessChecks` | — | added as `{ok:false}` only if the extra-check function throws |

`allOk = every check ok except killSwitch`; `ready = allOk && enabled`;
`state = ready ? "ready" : allOk ? "disabled" : "not_ready"`.

Caching: result promise cached for `pollMs` (5000 ms) and shared by concurrent callers
(`server.ts:248-254`), so unauthenticated `/readyz` cannot multiply DB work. `refresh()` (every 5 s)
clears the cache.

**DRIFT:** design §12.1 (`docs/design/phase-b-operator-api.md:943-946`) lists readiness at "loopback peer
only" and includes "the principal/key cache generation". Code enforces a loopback **Host header** (the
listener is loopback-bound, so the peer is always loopback) and has no generation readiness check.
Design §5.7 names `timedatectl NTPSynchronized`; code uses the systemd-timesyncd marker file
(acknowledged in design §18.7).

---

## 15. Kill switch and generation

- Storage: `fleet_operator_state.operator_api_enabled` (default `false` after migration) and
  `generation` (monotonic, trigger-enforced).
- Enforcement is in the DB, per request: `op_begin_request` returns `FLEET_OP_DISABLED` (503), and
  `fleet_operator_request_ok` refuses reads while disabled. The process's own `enabled` flag is used
  only for readiness (`server.ts:189,261,269`); the process never short-circuits on it.
- Generation is bumped (`UPDATE … SET generation = generation + 1`, `admin.ts:71-77`) by: `enroll`,
  `addKey`, `revokeKey`, `revokePrincipal`, `revokeAll`, `setEnabled`.
- The process polls `op_ping()` every 5 s (`server.ts:179-195,209`); when `generation` changes it
  clears the key cache (`server.ts:187`). Revocation is effective at the next request regardless of the
  cache, because the DB re-checks principal/key in `op_begin_request` and `fleet_operator_request_ok`.
- Commands: `fleet:admin operator-api enable|disable <reason…>` (event `operator_api_enabled_set`,
  detail `{enabled, generation, reason}`), and `operator-revoke-all` (revokes everything and sets
  `operator_api_enabled = false` in the same transaction).
- Fastest stop outside the DB: `systemctl stop automaton-fleet-operator-api` (requires sudo).

Production: enabled at B2-12, generation 2 at that time (`docs/fleet-production-runbook.md:1192,1200`).
Later enrollment of `bridge-chatgpt` (Phase C) bumped it again.
<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->

---

## 16. Rate limiting and concurrency

`DEFAULT_OPERATOR_LIMITS` (`server.ts:73-81`):

| Limiter | Capacity | Refill | Key | Behaviour |
|---|---|---|---|---|
| `perPrincipal` | 30 | 1 token/s | principal ID | after signature+scope; → 429 `principal rate` |
| `unknownKeyLookups` | 20 | 20/60 tokens/s (20 per minute) | global `"all"` | checked (`retryAfterS > 0` → 429) only for principal/key pairs never seen valid; a token is taken only when such a lookup fails |
| `deniedAudit` | 120 | 2 tokens/s | global `"all"` | limits `operator_request_denied` audit lines; excess counted and later emitted as one `operator_request_denied_suppressed {count}` line |
| `maxConcurrent` | 16 in-flight signed requests | — | — | → 429 `concurrency` |

`RateLimiter` (`src/fleet/service/rate-limit.ts:23-62`): token bucket, refill
`tokens = min(capacity, tokens + elapsed_s × refillPerSec)`, map bounded at 10,000 keys (oldest
dropped). `knownPairs` (pairs that resolved valid once) is capped at 1000 entries (`server.ts:288`).
All state is in memory and resets on restart. There is no per-peer bucket: all tunnel clients share
127.0.0.1.

DB-side: at most 60 denial events per rolling minute from `op:` actors (§7.1).

**DRIFT:** design §9.4 (`docs/design/phase-b-operator-api.md:664`) lists "Auth failures per peer IP 20 per
minute"; superseded in the code and in design §18.6 by the global unknown-lookup budget.

---

## 17. READ ONLY transaction enforcement and the signature-termination invariant

### 17.1 Runtime barrier (`gateway.ts:79-92`)

```ts
private async ro<T>(sql: string, params: unknown[]): Promise<T> {
  const c = await this.pool.connect();
  try {
    await c.query("BEGIN TRANSACTION READ ONLY");
    const r = await c.query<{ r: T }>(sql, params);
    await c.query("COMMIT");
    return r.rows[0].r;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally { c.release(); }
}
```

Used for `op_ping`, `op_key_material`, `op_whoami`, `op_fleet_status`, `op_list_agents`,
`op_get_agent`, `op_list_events`. Only `op_begin_request` uses the plain autocommit `fn()`
(`gateway.ts:68-71,102-111`). A READ ONLY transaction refuses writes, sequence changes, NOTIFY and
large-object writes even through volatile callees or dynamic SQL.

### 17.2 Invariant (Amendment 2)

PostgreSQL cannot verify Ed25519, so the signature terminates in the process. Therefore the operator
role's surface must remain observational (`migrations-phase8.ts:9-24`). Controls:
1. Every `op_*` except `op_begin_request` is STABLE.
2. `op_begin_request` writes only `OPERATOR_BOOKKEEPING_TABLES` plus denial events through `fleet_event`.
3. Route table CHECK confines `fn` to the five reads; table immutable.
4. `verifyRoutePolicy` in-process; `begun.fn` equality check.
5. Static catalog audit `operatorSurfaceProblems` (§24).
6. READ ONLY transactions (§17.1).

**DRIFT:** `src/fleet/postgres/migrations-phase8.ts:23` says the invariant is enforced by "the
operator-surface verifier (operator/surface.ts)". No such file exists; the verifier is
`operatorSurfaceProblems` in `src/fleet/postgres/privileges.ts:292-366`.

---

## 18. Redaction and `untrusted_text`

### 18.1 `untrusted()` (`responses.ts:26-41`)

```ts
export const UNTRUSTED_MAX = 200;
const TRUNC_MARK = "...[truncated]";
export function untrusted(v: unknown): UntrustedText {
  const text = typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
  const red = redactText(text).replace(/[\t\n]+/g, " ");
  let value = red;
  let truncated = red.endsWith(TRUNC_MARK);
  if (truncated) value = value.slice(0, -TRUNC_MARK.length);
  if (value.length > UNTRUSTED_MAX) {
    value = value.slice(0, UNTRUSTED_MAX);
    if (/[\uD800-\uDBFF]$/.test(value)) value = value.slice(0, -1);
    truncated = true;
  }
  return { kind: "untrusted_text", value, truncated };
}
```

Pipeline for each untrusted string:
1. `redactText` (B0 canonical redactor, `src/fleet/redact.ts:330-332`): cut at 65,536 chars
   (`maxInput`), replace lone surrogates with U+FFFD, NFKC normalize, strip evasion characters
   (`EVASION_RE`, `redact.ts:137-138`: C0 except `\t`/`\n`, DEL, C1, soft hyphen, U+034F, Hangul fillers,
   U+17B4/5, U+180E, U+200B–U+200F, U+202A–U+202E, U+2060–U+2064, U+2066–U+2069, U+3164, U+FEFF, U+FFA0),
   map U+2028/U+2029 to space, apply secret patterns, cap at 500 chars with `...[truncated]`.
2. Replace runs of tab/LF with one space.
3. Strip a trailing `...[truncated]` marker and set `truncated = true`.
4. Cut to 200 UTF-16 code units (dropping a dangling high surrogate), `truncated = true`.

Where used: agent `name`; event detail fields typed `text`; unmapped function names in internal errors.

### 18.2 Where `untrusted_text` wrapping applies

- Agent-influenced or free-form strings: agent `name`, event `why`, `path`, `reason`, `role`, `code`
  (in `reservation_denied`), `keyId` fields in lifecycle events.
- Never used as a JSON key; never interpolated. Server adds no prose/Markdown (`responses.ts:15`).
- Enums outside the known set become `"unknown"`; malformed IDs/hashes become `null`.

### 18.3 Per-item redaction

Each finished agent/event item, plus the `fleet` and `runtime` status objects, passes through
`redactDetail` (B0) per item, never over the whole response (whole-response redaction would hit the
64-entry width bound, `REDACT_LIMITS.maxWidth`, `redact.ts:37`, and truncate pages). The audit sink
separately redacts every audit record (`redactAuditRecord`, `src/fleet/service/log.ts:40-47`), and the
server passes `redactDetail(detail)` into it (`server.ts:237`).

Clients (bridges) must render `untrusted_text` as data and never follow instructions inside it (MCP
server instruction for `fleet-operator`; design §8.4 / §13.3).

**DRIFT:** design §8.4 (`docs/design/phase-b-operator-api.md:571-576`) specifies NFC normalization; the
code uses NFKC via `redactText`. Design says newlines are replaced by a space; code does that for tab
and LF (other C0 controls are removed, U+2028/2029 become spaces).

---

## 19. Audit: JSONL, journald, `fleet_events`, `fleet_operator_requests`

### 19.1 Process audit (every signed-route request)

Sink: `createAuditSink(log, FLEET_OPERATOR_AUDIT_LOG)` (`main.ts:164`, `log.ts:40-47`). At creation the
file is opened with mode `0o600` (create/append). Each entry is redacted once; the same record goes
to stdout/journald (JSON logger, `service: "automaton-fleet-operator-api"`, level `info`, field
`audit: true`) and, if configured, appended to the JSONL file (mode 0600).

Record (`server.ts:408-420`):

```json
{
  "ts": "<ISO>",
  "event": "operator_request | operator_request_denied | operator_request_denied_suppressed",
  "agentId": null,
  "detail": {
    "requestId": "<process UUID>",
    "principal": "op_<ULID> | none",
    "route": "GET /v1/operator/... | unknown",
    "status": 200,
    "code": "FLEET_OP_* (errors only)",
    "reason": "<audit-only reason, errors only>",
    "items": 3,
    "ms": 12,
    "peer": "loopback | other"
  }
}
```

- `operator_request`: status < 400. `operator_request_denied`: status ≥ 400, subject to the
  `deniedAudit` budget. `operator_request_denied_suppressed`: `{count}`.
- `principal` is recorded only once the headers parsed and the principal matched `PRINCIPAL_RE`;
  otherwise `none`.
- Never logged: private keys, signatures, raw nonces, public keys, Authorization values, request bodies
  (`server.ts:29-31`; test `operator-server.test.ts:353`).
- `/healthz` and `/readyz` are not audited.
- Other process log events: `operator_api_started`, `startup_failed`, `uncaught_exception`,
  `unhandled_rejection`.

Location in production: `/var/log/automaton-fleet-operator/audit.jsonl` (file 0600, directory 0700 via
`LogsDirectoryMode`), rotated by logrotate (§2.3).

### 19.2 Database audit

| Table | Written by | Content |
|---|---|---|
| `fleet_operator_requests` | `op_begin_request` on acceptance | request_id (DB UUID), principal_id, key_id, route, scope, client_ts, nonce_sha256, body_sha256, received_at |
| `fleet_events` (denials) | `op_begin_request` via `fleet_event(...)` | type `operator_*` (see §7.1), agent_id NULL, actor `op:<principal>` or `op:invalid`, detail `{code, route, layer:"database"}`; ≤ 60/min |
| `fleet_events` (lifecycle) | `PgOperatorAdmin` (`admin.ts:63-69`) | actor `operator:<os user>` (≤ 128 chars), detail redacted |
| `fleet_events` (`operator_role_granted`) | `grantOperatorRole` | `{role, functions}` |
| `fleet_events` (`operator_requests_archived`) | `fleet_operator_archive_requests` | `{before, rows, remaining, exportSha256}` |

Process-layer denials (malformed, noncanonical, bad signature, stale at process, rate limited) are
recorded only in the JSONL/journald audit, not in `fleet_events` (design §18.5 item 4).

There is no shared identifier between a JSONL `requestId` and a `fleet_operator_requests.request_id`.
Correlation is only by principal + time + route.

**DRIFT:** design §9.2 (`docs/design/phase-b-operator-api.md:645`) lists a `method` field in
`fleet_operator_requests` and a "reason enum, peer class" in denial events. Code: no `method` column
(method is embedded in `route`); DB denial events carry `{code, route, layer}` only, no peer class.

---

## 20. Request-audit cap, archival and doctor retention warnings

### 20.1 Cap

- `request_cap` fixed at 2,000,000 by CHECK (`migrations-phase8.ts:40`).
- Counter incremented per accepted request; at `request_count >= request_cap` every request fails
  with `FLEET_OP_AUDIT_FULL` (503). Tested in `operator-server.test.ts:272` and `operator-pg.test.ts:474`.
- Counter decreases only inside archival (GUC `fleet.operator_archive = 'on'`).
- Nothing deletes rows automatically.

### 20.2 Archival (`fleet:admin operator-archive --before <ISO> --out <new file> [--max-rows N]`)

`PgOperatorAdmin.archive` (`src/fleet/operator/admin.ts:227-261`) with the admin (schema-owner)
credential:

1. Actor must match `^operator:[A-Za-z0-9_.-]{1,64}$`.
2. `before` at least 60 s in the past; `maxRows` integer 1..100,000 (`OPERATOR_ARCHIVE_MAX_ROWS`, `admin.ts:27`).
3. Output directory must pass `requirePrivateDirectory` (real dir, no symlink in path, owned by the
   current uid, not group/world-writable).
4. `SELECT line FROM fleet_operator_archive_export($before, $maxRows)`: canonical JSON lines, oldest
   first (`ORDER BY received_at, request_id`). If 0 rows → `{archived: 0, exportFile: null, exportSha256: null}`.
5. Bytes = lines joined with `\n` terminators; SHA-256 computed.
6. `open(O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0600)`, write, fsync; on failure remove own partial file and
   throw `archival aborted at export; no request rows were deleted`.
7. `verifyExport`: re-open `O_RDONLY|O_NOFOLLOW`; must be regular file, mode exactly 0600, owned by
   current uid, `nlink === 1`, expected size, expected line count and final byte LF, expected SHA-256.
8. `SELECT fleet_operator_archive_requests($before, $n, $sha, $actor)`.
9. On failure at verify/delete: event `operator_requests_archive_failed` `{stage, rows, before}` and throw
   `archival aborted at <stage>; no request rows were deleted (export left at <file>)`.

Canonical line (`fleet_operator_request_line`, `migrations-phase8.ts:236-244`):

```sql
jsonb_build_object(
  'requestId', r.request_id, 'principalId', r.principal_id, 'keyId', r.key_id, 'route', r.route,
  'scope', r.scope,
  'clientTs', to_char(r.client_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'nonceSha256', r.nonce_sha256, 'bodySha256', r.body_sha256,
  'receivedAt', to_char(r.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text
```

`fleet_operator_archive_requests` (`migrations-phase8.ts:265-310`):
- actor must match `^operator:[A-Za-z0-9._-]{1,64}$` else `FLEET_APPROVAL_REQUIRED: archival requires an operator actor`;
- digest must be 64 hex else `FLEET_OPERATOR_INVALID: export digest required`;
- `fleet_operator_archive_check`: cutoff ≥ 1 minute old, rows 1..100000;
- locks the state row, re-selects the same rows `FOR UPDATE`, recomputes
  `sha256(string_agg(line || E'\n' ORDER BY received_at, request_id))`;
- count mismatch → `FLEET_OPERATOR_INVALID: archival matched % rows, export had %`;
  digest mismatch → `FLEET_OPERATOR_INVALID: archival digest does not match the export`;
- sets GUC on (transaction-local), deletes by id array, verifies deleted count, decrements
  `request_count` by `n` (floored at 0), sets GUC off;
- emits `operator_requests_archived` `{before, rows, remaining, exportSha256}`; returns `n`.

None of the archival functions is granted to any restricted role.

Runbook: repeat with a new `--out` until `remaining: 0`; each run needs its own approval
(`docs/fleet-production-runbook.md:1156-1165`).

### 20.3 Audit level and doctor warnings

`auditLevel` (`responses.ts:85-92`):

```ts
if (!(cap > 0)) return "full";
const r = count / cap;
if (r >= 1) return "full";
if (r >= 0.75) return "elevated";
if (r >= 0.5) return "info";
return "ok";
```

Doctor (`src/fleet/doctor.ts:311-333`), using `store.operatorOverview()` (admin credential,
`src/fleet/postgres/store.ts:840-880`; returns null if tables are not visible). These are detailed checks
outside the 16-item checklist (`doctor.ts:311-312`):

| Check | Severity | Message |
|---|---|---|
| `operator audit capacity` | `pass` (ok) / `warn` (info, elevated) / `fail` (full) | `<count>/<cap> request rows (<pct>%)` + ` — early warning (>= 50%): plan an archive (fleet:admin operator-archive)` / ` — ELEVATED (>= 75%): archive soon` / ` — FULL: the Operator API fails closed (FLEET_OP_AUDIT_FULL); archive required` |
| `operator kill switch` | always `pass` | `enabled (generation N)` or `disabled (generation N); the Operator API refuses every request` |
| `operator principals` | `warn` if any active key expires within 14 days | `<n> active principal(s), <k> active key(s)[; <x> key(s) expire within 14 days]` |
| `operator denials` | `warn` if > 20 | `<n> denied operator request(s) in the last 10 minutes` (counts `operator_auth_failed`, `operator_scope_denied`, `operator_replay_blocked`, `operator_stale`) |

**DRIFT:** design §9.3 (`docs/design/phase-b-operator-api.md:653-658`) specifies WARN on "any
`operator_scope_denied`" and "any `operator_replay_blocked`". Code warns only when the combined count of
four denial types exceeds 20 in 10 minutes. `operator_disabled`, `operator_audit_full` and
`operator_bad_request` are not counted. Design §11.2 D-9 required disk-usage monitoring (table sizes,
JSONL directory size, filesystem free space with WARN/FAIL thresholds): **NOT IMPLEMENTED** in doctor;
the implemented bound is the 2,000,000-row cap plus logrotate (design §18.4 records Amendment 1 as the
chosen policy).

---

## 21. Full error model

### 21.1 Codes and HTTP status (`STATUS_OF`, `server.ts:102-115`; type `OpErrorCode`, `canonical.ts:53-65`)

| Code | HTTP | Raised by (layer) | Triggers |
|---|---|---|---|
| `FLEET_OP_BAD_REQUEST` | 400 | process | target > 2048 bytes / empty; header set invalid (missing, duplicate, malformed, Authorization or Cookie present); Content-Length ≠ 0; Transfer-Encoding present; body bytes received |
| `FLEET_OP_BAD_REQUEST` | 421 | process | `/healthz` or `/readyz` with non-loopback Host (special status; same code) |
| `FLEET_OP_BAD_REQUEST` | 400 | database | parameter format failure in `op_begin_request` (unreachable from a correct process) |
| `FLEET_OP_NONCANONICAL` | 400 | process | non-canonical target under `/v1/operator/` (§10.2) |
| `FLEET_OP_BAD_PARAM` | 400 | process | query key not allowed for the route, or value fails the route regex (includes `limit=0`, `limit=201`, `after` uppercase) |
| `FLEET_OP_STALE` | 401 | process, database | timestamp outside ±30 s |
| `FLEET_OP_AUTH_FAILED` | 401 | process | unknown/revoked/expired principal or key; kind not allowed for route; bad signature encoding; signature verify failure |
| `FLEET_OP_AUTH_FAILED` | 401 | database | principal/key missing, revoked, not yet valid, expired |
| `FLEET_OP_SCOPE_DENIED` | 403 | process | route scope not in principal scopes |
| `FLEET_OP_SCOPE_DENIED` | 403 | database | kind not in DB route kinds, or scope missing |
| `FLEET_OP_NOT_FOUND` | 404 | process | target outside `/v1/operator/`; non-GET; unknown route; bad `agent_id` segment; agent not found |
| `FLEET_OP_NOT_FOUND` | 404 | database | route not in `fleet_operator_routes` |
| `FLEET_OP_REPLAYED` | 409 | database | nonce already used by the principal |
| `FLEET_OP_RATE_LIMITED` | 429 | process | concurrency > 16; unknown-lookup budget empty; per-principal bucket empty |
| `FLEET_OP_INTERNAL` | 500 | process | any non-`OpFailure` exception (DB unavailable, `FLEET_OP_REQUEST_INVALID` from the read gate, cast errors); fn mismatch; unmapped fn; unknown DB code |
| `FLEET_OP_DISABLED` | 503 | database | kill switch off |
| `FLEET_OP_AUDIT_FULL` | 503 | database | request cap reached |

Other statuses:
- `/readyz` 503 with readiness body (not an error envelope).
- No `Retry-After` header is sent on 429.

401 bodies never reveal which check failed; `reason` goes to the audit only (`server.ts:29-30,117-125`).

### 21.2 Database raise strings (not HTTP-visible; appear as `FLEET_OP_INTERNAL` or CLI errors)

| String | Where |
|---|---|
| `FLEET_OP_REQUEST_INVALID` | `fleet_operator_request_ok` |
| `FLEET_HISTORY_IMMUTABLE: …` | state/principal/key/request guards; `fleet_history_immutable()` |
| `FLEET_OPERATOR_INVALID: …` | principal/key guards, archival |
| `FLEET_APPROVAL_REQUIRED: …` | archival actor; approver rule |
| `FLEET_SELF_APPROVAL: operator API principals can never approve (approver %)` | approver rule |

### 21.3 CLI errors (`fleet:admin operator-*`)

Exit 1 with a redacted message on stderr (`src/fleet/postgres/cli.ts:318-322`). Messages include:
`operator lifecycle actions require an operator:<user> actor`, `kind must be one of …`,
`scopes must be from …`, `expires-days must be 1..90`, `--expires-days N (1..90) is required`,
`public key must be 43 base64url characters (32 raw bytes)`,
`public key is not canonical base64url of 32 bytes`, `no active key <id>`,
`no active principal <id>`, `--before must be at least one minute in the past`,
`--max-rows must be 1..100000`, usage strings per command, `unknown operator command <cmd>`.

---

## 22. Operator lifecycle CLI (`fleet:admin operator-*`, `grant-operator-role`)

Invocation: `pnpm fleet:admin <cmd>` = `tsx src/fleet/postgres/cli.ts` (`package.json:50`). Requires
`FLEET_ADMIN_DATABASE_URL` (falls back to `FLEET_CONTROLLER_DATABASE_URL`, then `DATABASE_URL`;
`cli.ts:314-316`). Actor is `operator:<os username>` (`cli.ts:312`). Pool: max 2,
`application_name=automaton-fleet-admin`, `statement_timeout=30000`, `lock_timeout=5000`
(`admin.ts:35-40`). Output is JSON on stdout.

| Command | Arguments | Effect | Generation bump | Event |
|---|---|---|---|---|
| `grant-operator-role [role]` | optional role (default `fleet_operator`) | §5.2 | no | `operator_role_granted` |
| `operator-enroll <name> <bridge_claude\|bridge_chatgpt> --scopes a,b --public-key <b64url> --expires-days N` | N 1..90 | insert principal (`op_`+ULID) + key | yes | `operator_principal_enrolled` `{principalId, kind, keyId, expiresAt}` |
| `operator-add-key <principalId> --public-key <b64url> --expires-days N` | | insert key (≤ 2 active) | yes | `operator_key_added` `{principalId, keyId, expiresAt}` |
| `operator-revoke-key <keyId> <reason…>` | reason default `operator decision`, truncated to 200 | revoke one key | yes | `operator_key_revoked` `{keyId}` |
| `operator-revoke <principalId> <reason…>` | | revoke principal and all its active keys | yes | `operator_principal_revoked` `{principalId, keys}` |
| `operator-revoke-all <reason…>` | | revoke all principals and keys; set kill switch off | yes | `operator_revoke_all` `{principals, keys}` |
| `operator-api enable\|disable <reason…>` | | set kill switch | yes | `operator_api_enabled_set` `{enabled, generation, reason}` |
| `operator-list` | | state row + principals with key IDs/expiry/revocation (no public keys) | no | none |
| `operator-archive --before <ISO> --out <new file> [--max-rows N]` | | §20.2 | no | `operator_requests_archived` / `_archive_failed` |

Enrollment return value: `{principalId, name, kind, scopes (sorted), keyId, expiresAt, generation}`
(`admin.ts:114`). The operator compares `keyId` out of band with keygen output.

**DRIFT:** design §10.2 (`docs/design/phase-b-operator-api.md:696-701`) uses `--expires <days>` and says
enrollment writes both `operator_principal_enrolled` and `operator_key_added`. Code uses
`--expires-days` and writes only `operator_principal_enrolled` at enrollment.

---

## 23. Bridge-side key generation and key loading

`pnpm fleet:operator-keygen <private-key-file>` (`package.json:57`, `src/fleet/operator/keygen.ts:65-78`),
run on the bridge host as the bridge user, never on the controller and never with a DB credential.

`generateOperatorKey` (`keygen.ts:29-43`):
1. `requirePrivateDirectory(dirname)` (`keygen.ts:21-27`): `lstat` is a directory, not a symlink;
   `realpath(dir) === dir`; owned by current uid; `mode & 0o022 === 0`.
2. `crypto.generateKeyPairSync("ed25519")`; private key exported as PKCS#8 PEM.
3. `open(O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0600)`, write, `fchmod 0600`.
4. stdout: `{"publicKey": "<43-char base64url>", "keyId": "<32 hex>", "privateKeyFile": "<abs path>"}`.
   The private key is never printed.

`loadOperatorPrivateKey` (`keygen.ts:46-63`): open `O_RDONLY|O_NOFOLLOW`; on the same fd require a
regular file, `mode & 0o077 === 0`, owner = current uid, `nlink === 1`; key type must be `ed25519`.

Private key locations (paths only, contents secret):
- `bridge-claude`: dev VM `~/.config/automaton-fleet/operator/bridge-claude.key` (0600)
  `[SECRET REDACTED — PURPOSE: bridge-claude Ed25519 signing key]`.
- `bridge-chatgpt`: VPS `/var/lib/automaton-fleet-chatgpt-adapter/bridge-chatgpt.key` (0600, adapter user)
  `[SECRET REDACTED — PURPOSE: bridge-chatgpt Ed25519 signing key]`.

**DRIFT:** design §10.1 names a tool `scripts/fleet-op-keygen` with "parent directory 0700"; code is
`src/fleet/operator/keygen.ts` (`pnpm fleet:operator-keygen`) and accepts any directory that is owned by
the user and not group/world-writable (e.g. 0755 passes). Design §10.1's systemd `LoadCredential=`
delivery for bridge keys is not used by the Operator API itself.

---

## 24. Privilege audit (operator parts)

`auditPrivileges` (`src/fleet/postgres/privileges.ts`), used by `fleet:admin audit-privileges`, doctor,
controller startup and Operator API startup/readiness.

Role state (`privileges.ts:91-99`):
- `provisioned`: both `fleet_operator` and `fleet_operator_login` exist.
- `not_provisioned`: neither exists and `requireOperatorRoles` is false → no problem.
- `incomplete`: one exists (or none but required) → problems.

For each operator role (`privileges.ts:112-220`):
- not superuser / createrole / createdb / replication / bypassrls;
- not member of the schema owner, not member of another restricted role (except `*_login` → its group),
  not member of `pg_write_all_data`, `pg_read_all_data`, `pg_database_owner`, `pg_execute_server_program`,
  `pg_read_server_files`, `pg_write_server_files`;
- owns no schema, relation or function;
- no CREATE or TEMPORARY on the database; no CREATE on the schema or `public`;
- no table/sequence privilege of any kind in the schema;
- EXECUTE only on `OPERATOR_API_FUNCTIONS`; each must be SECURITY DEFINER with a pinned `search_path`;
- each executable except `op_begin_request` must have `provolatile` `s` or `i`.

`operatorSurfaceProblems` (`privileges.ts:292-366`, runs whenever the audit connection owns the schema
and `fleet_operator_routes` exists):
- no operator-surface body uses `EXECUTE` (dynamic SQL) or a quoted identifier;
- no call to side-effecting built-ins (`nextval`, `setval`, `set_config`, `pg_notify`, advisory locks,
  `lo_*`, `dblink*`, `pg_terminate_backend`, `pg_cancel_backend`, `pg_sleep*`, `pg_reload_conf`,
  `pg_rotate_logfile`, `pg_file_*`, `pg_read_*file`, `pg_ls_*`, `pg_stat_reset*`, `pg_switch_wal`,
  `pg_create_*`, `pg_drop_replication_slot`, `pg_logical_emit_message`, `txid_current`,
  `pg_current_xact_id`; regex `privileges.ts:273`);
- no call to functions in other user schemas;
- `op_begin_request` writes only bookkeeping tables and calls no volatile fleet function except `fleet_event`;
- read-side functions (op_* + helpers `fleet_operator_request_ok`, `fleet_operator_agent_json`) are
  non-volatile, contain no write statement (`writeTargets`: INSERT/UPDATE/DELETE/MERGE/TRUNCATE/COPY),
  call no volatile function, and call no fleet function outside the read helpers;
- no unexpected `op_*` function exists;
- every route's `fn` is a read function that exists and is not volatile.

---

## 25. Principal table (non-secret)

From the operator's records as of 2026-09-25 (public identifiers only):

| Name | Principal ID | Kind | Scopes | Active key ID | Key expires | Private key location |
|---|---|---|---|---|---|---|
| `bridge-claude` | `op_01M3AX56W25JNMQCTBM8HYH474` | `bridge_claude` | `ops.read.status`, `ops.read.agents`, `ops.read.events` | `ec4f06982ae9135fd2b28e928f5a4a61` | 2026-10-24T23:49:04.533Z | dev VM only |
| `bridge-chatgpt` | `op_01M3B18TXVP33S6NQC909DXD57` | `bridge_chatgpt` | `ops.read.status`, `ops.read.agents` | `fe22d91c08f0a0676b4c155ce0d618d3` | 2026-10-25T01:00:57.682Z | VPS, adapter state dir |

<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->

What the repository expects in production: both principals active, one unrevoked key each, kill switch
enabled, request count well below 50% of 2,000,000, doctor `operator principals` check passing until
14 days before 2026-10-24 (then `warn`). Enrollment events: `bridge-claude` event 96, kill-switch enable
event 97 (generation 2), `bridge-chatgpt` event 112 (`docs/fleet-production-runbook.md:1192,1220`).
Rotation is required before each key's expiry (`operator-add-key`, switch the bridge, `operator-revoke-key`).

---

## 26. Tests that pin the behaviour

`pnpm test:operator` runs the three files (`package.json:66`).

| File | Lines | Covers |
|---|---|---|
| `src/__tests__/fleet/operator-canonical.test.ts` | 413 | pinned vector and WebCrypto cross-check; every-field binding; signature encoding; 18 non-canonical target cases + oversize; header rules; route policy and signature-termination invariant; operator routes absent from the agent service; `untrusted_text`, agent/event/status builders; audit thresholds; keygen; startup refusals; `operator.env` rules; agent/self-modification protections |
| `src/__tests__/fleet/operator-pg.test.ts` | 848 | v7→v8 migration (check, apply, idempotent, v8 code refuses v7); atomic failure; role executes exactly the allow-list; catalog mutations detected; static audit catches hidden writes; READ ONLY barrier; principal/key constraints; approver rule; `op_begin_request` fail-closed matrix and single-use nonce; Amendment 3 table diff; Amendment 1 thresholds; archival fail-closed matrix; bounded nonce purge; login identity; concurrent revocation vs key add; bounded denial events; not-provisioned/partial/provisioned role states |
| `src/__tests__/fleet/operator-server.test.ts` | 393 | typed route bodies and complete pages; no corpus secret in responses; negative matrix (status/code per case, `operator-server.test.ts:213-253`); immediate revocation and kill switch; AUDIT_FULL; rate limits and lookup budget; `/readyz` Host rule, caching, null safety flags; denied-audit budget; audit contents; startup refusal combinations |

Negative matrix (`operator-server.test.ts:220-252`), exact expectations:

| Case | Status | Code |
|---|---|---|
| `/v1/operator/nope` | 404 | `FLEET_OP_NOT_FOUND` |
| `/v1/state` (agent route) | 404 | `FLEET_OP_NOT_FOUND` |
| POST to `/v1/operator/status` | 404 | `FLEET_OP_NOT_FOUND` |
| `/v1/operator/status/` | 400 | `FLEET_OP_NONCANONICAL` |
| `/v1/operator/Status` | 400 | `FLEET_OP_NONCANONICAL` |
| Authorization header | 400 | `FLEET_OP_BAD_REQUEST` |
| Cookie header | 400 | `FLEET_OP_BAD_REQUEST` |
| missing nonce header | 400 | `FLEET_OP_BAD_REQUEST` |
| duplicate nonce header | 400 | `FLEET_OP_BAD_REQUEST` |
| `content-length: 2` body | 400 | `FLEET_OP_BAD_REQUEST` |
| `transfer-encoding: chunked` | 400 | `FLEET_OP_BAD_REQUEST` |
| ts −31 s / +31 s | 401 | `FLEET_OP_STALE` |
| signature for another path | 401 | `FLEET_OP_AUTH_FAILED` |
| signed with another principal's key | 401 | `FLEET_OP_AUTH_FAILED` |
| unknown principal | 401 | `FLEET_OP_AUTH_FAILED` |
| ChatGPT → events (kind) | 401 | `FLEET_OP_AUTH_FAILED` |
| status-only principal → agents | 403 | `FLEET_OP_SCOPE_DENIED` |
| replayed nonce | 409 | `FLEET_OP_REPLAYED` |
| agents with `limit=0`, `limit=201`, `limit=abc`, `after=x`, duplicate `limit`, uppercase-order issue, `zzz=1`, trailing `&` | 400 | (any 400 code) |

---

## 27. Design-document vs code drift register

Design document: `docs/design/phase-b-operator-api.md` (1460 lines). Its §18 records the B2-2/B2-3
reconciliation; items already acknowledged there are marked "(acknowledged §18)". Code is authoritative.

| # | Topic | Design says | Code does | Source |
|---|---|---|---|---|
| D1 | Credential delivery | §12.1: `operator.env` root:root 0600 via `LoadCredential=operator.env` | root:automaton-fleet-operator-api 0640 read directly, no LoadCredential (acknowledged §18.5.1) | unit `:10-12`; `secret-files.ts:381-418` |
| D2 | Verification order | §5.4: headers/body (step 3) before canonical target (step 4) | canonical target and route first, then headers, body, params | `server.ts:338-356` |
| D3 | Per-peer auth-failure limit | §9.4: 20/min per peer IP | global unknown-lookup budget 20/min; no per-peer bucket (acknowledged §18.6) | `server.ts:73-81` |
| D4 | HTTP/1.1 requirement | §5.2: MUST be HTTP/1.1 | not checked — **NOT IMPLEMENTED** | `server.ts` (no `httpVersion`) |
| D5 | Events `after` regex | §8.2: `^[0-9]{1,19}$` | `^[1-9][0-9]{0,18}$` | `route-policy.ts:35` |
| D6 | Events `type` param | §8.2: single value from the allow-listed event types | any `^[a-z][a-z0-9_]{0,63}$` | `route-policy.ts:36,53` |
| D7 | `api_auth_failed.path` | §8.3: enum of known paths or `"other"` | `text` (`untrusted_text`) | `responses.ts:157` |
| D8 | Event allow-list | §8.3: 13 initial types | 29 types incl. `agent_quarantined`, `operator_role_granted` and all `operator_*` | `responses.ts:151-182` |
| D9 | Actor classes | §8.2: `operator|service|agent|database|unknown` | adds `operator_api` (`op:` actors) | `responses.ts:215-225` |
| D10 | Status `operatorApi` | §8.2: `{enabled}` | `{enabled, requestCount, requestCap, auditLevel}`; `safety.source` added; safety null when unreadable (acknowledged §18.4/§18.6) | `responses.ts:133-135` |
| D11 | Untrusted text normalization | §8.4: NFC | NFKC (via `redactText`) | `redact.ts:292` |
| D12 | `op_ping` fields | §11.3: `{schemaVersion, operatorApiEnabled, generation}` | adds `requestCount, requestCap, dbTime, runtimeRepo, runtimeCommit, runtimeBuildId, runtimeLockfileSha256` | `migrations-phase8.ts:447-455` |
| D13 | Nonce purge | §11.1: ≤ 100 expired rows for the calling principal | ≤ 1000 expired rows, any principal (acknowledged §18.3) | `migrations-phase8.ts:423` |
| D14 | `fleet_operator_state` columns | §11.1: no counter/cap | `request_count`, `request_cap` (Amendment 1) | `migrations-phase8.ts:39-40` |
| D15 | Route table CHECKs | §11.1: `route ~ '^GET /v1/operator/'`, `fn ~ '^op_[a-z_]+$'`, `kinds` unconstrained | stricter: full route regex, `fn IN (5 reads)`, kinds constrained | `migrations-phase8.ts:180-186` |
| D16 | `fleet_operator_requests` | §9.2: includes `method` | no `method` column | `migrations-phase8.ts:199-209` |
| D17 | Requests immutability | §11.1: via `fleet_history_immutable` | dedicated guard permitting archival DELETE (Amendment 1) | `migrations-phase8.ts:214-225` |
| D18 | Denial event detail | §9.2: claimed principal, route, reason enum, peer class | detail `{code, route, layer}`; principal only in actor | `migrations-phase8.ts:414` |
| D19 | Enroll events | §10.2: `operator_principal_enrolled` + `operator_key_added` | only `operator_principal_enrolled` | `admin.ts:113` |
| D20 | Enroll flag | §10.2: `--expires <days>` | `--expires-days N` | `cli.ts:198-203` |
| D21 | Keygen tool | §10.1: `scripts/fleet-op-keygen`, parent dir 0700 | `pnpm fleet:operator-keygen`; dir owned by user, not group/world-writable | `keygen.ts:21-27` |
| D22 | Doctor alerting | §9.3: WARN on any scope_denied / replay_blocked; auth_failed > 20/10 min | WARN only if 4-type combined count > 20 in 10 min | `doctor.ts:332`, `store.ts:862-863` |
| D23 | Disk-usage monitoring | §11.2 D-9: table/JSONL/filesystem sizes with thresholds | **NOT IMPLEMENTED**; replaced by the 2M-row cap + logrotate (Amendment 1) | `doctor.ts:311-333` |
| D24 | Clock readiness | §5.7: `timedatectl NTPSynchronized` in readiness; doctor warns on > 5 s app-DB skew | readiness uses timesyncd marker + 5 s skew; doctor has no skew check; `fleet-verify-deployment.sh:77` checks `NTPSynchronized` | `main.ts:159-171` |
| D25 | Readiness items | §12.1: loopback peer only; includes cache generation | loopback Host header; no generation check | `server.ts:318-331` |
| D26 | Error code list | §8.5: 11 codes | 12 codes (`FLEET_OP_AUDIT_FULL` 503, acknowledged §18.4) + 421 on health endpoints | `server.ts:102-115,320` |
| D27 | Response size | §8.1: exceeding 256 KiB is a 500 | pages stop early (`next` set); non-page bodies unchecked | `server.ts:468-489` |
| D28 | Request ID | §8.1/§9.2 imply one request id | process UUID in response/JSONL differs from DB `request_id` | `server.ts:294`, `migrations-phase8.ts:419` |
| D29 | Verifier file | migration comment: `operator/surface.ts` | file does not exist; `operatorSurfaceProblems` in `privileges.ts` | `migrations-phase8.ts:23` |
| D30 | `operator.env` uniqueness | `secret-files.ts:375` comment: only group-readable secret file | `admin.env` is also 0640 group-readable | `secret-files.ts:7` |
| D31 | `operator_console` kind, `ops.read.treasury`, `ops.propose` | reserved / future | **NOT IMPLEMENTED** (`RESERVED_SCOPES` exported but unused) | `route-policy.ts:23` |
| D32 | Design §5.4 step 11 lists 401/403 from DB | — | consistent; but DB order puts principal/key before window, process puts window first | `migrations-phase8.ts:366-394` |

---

## 28. Known limitations (accepted for v1)

From design §18.7 (`docs/design/phase-b-operator-api.md:1438-1460`) and verified in code:

1. Signature verification exists only in the process. Anyone holding the `fleet_operator_login` password
   can call `op_begin_request` claiming any active principal (IDs are not secret) and then read what that
   principal's scopes expose, without a signature. A request ID can be reused for its own read function
   for 30 s with any parameters (`fleet_operator_request_ok` is not single-use). No write access to fleet
   state results. Tracked as FLEET-KI-5.
2. The login can take advisory locks, create large objects, override its per-role timeouts, and connect
   to other databases unless `pg_hba` restricts it (pre-existing for all fleet logins; FLEET-KI-5).
3. While junk identities have exhausted the unknown-lookup budget, a principal never seen valid by this
   process gets 429 until refill (20/min).
4. Rate limiters and the known-pair set are in memory and reset on restart.
5. Clock readiness depends on the systemd-timesyncd marker unless `FLEET_OPERATOR_TIMESYNC_MARKER` is set.
6. Password statements in `fleet-db-roles.sql` can still reach `pg_stat_statements` if installed.
7. `op_begin_request` serialises accepted requests on the single state row lock.
8. Events `after` values above the bigint range produce a 500 after a counted request (§12.7).

---

> **Phase D3 extension (IMPLEMENTED LOCALLY - NOT DEPLOYED):** schema v9 adds controlled operator actions on top of what this chapter describes. Production is still as documented here (v8, read-only). See `24-PHASE-D3-OPERATOR-ACTIONS.md`.
