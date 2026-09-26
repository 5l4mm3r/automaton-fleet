# 19 — Configuration Reference (PART 21)

Scope: every environment variable, env-file key, JSON configuration field, systemd
credential name and script variable that configures the Automaton Fleet layer. It covers
the repository at `fleet-development` HEAD `efad214`, which is the source for production
runtime commit `4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790` plus Phase C adapter artifact
`6691b4c`.

Rules used in this chapter:

- **Implementation wins.** Every row cites the line where the code *reads* the value. When
  documentation or an `.example` template says something else, the row has a `DRIFT:` note,
  and §16 lists all of them.
- **Secret values are never shown.** A secret production value is written as
  `[SECRET REDACTED — PURPOSE: …]`. A non-secret production value is given only when it is
  a known operator fact: CLAUDE.md, the rules file, or the runbook's recorded edits.
  Otherwise the row has the production placeholder.
- "Flag semantics `true`-only" means the value enables only when `value.trim().toLowerCase() === "true"`.
  Any other value, including `1`, `yes`, `TRUE # comment` or empty, counts as **false**.

---

## 1. Configuration sources and precedence

### 1.1 The env-file parser (shared by every Node component)

`src/fleet/secret-files.ts:82-89`:

```ts
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}
```

How it parses a line:

- Keys must match `[A-Z0-9_]+`. A line like `export FOO=1` is **ignored**, because the
  lower-case `export` does not match the key pattern.
- Inline comments are **not** stripped. For example, `REAL_REPLICATION_ENABLED=false # note`
  gives the value `false # note`. Because flags are `true`-only, the flag still reads as
  disabled, so this fails safe. `FLEET_REMOTE_LISTEN_ENABLED=true # x` reads as **disabled**.
- One pair of matching outer quotes (`'…'` or `"…"`) is removed. No escape processing happens.
- When a key appears more than once, the last occurrence wins.
- `readEnvFile(file)` (`secret-files.ts:92-95`) returns `{}` for a missing file. It does no
  permission checks, and is used only for non-secret files (`runtime.env`, legacy `.env.fleet`).
- `readSecretEnvFile(file, opts)` (`secret-files.ts:130-152`) first runs `secretFileProblems`
  or `systemdCredentialProblems` and throws `SecretFileError` (code `FLEET_SECRET_FILE`) on
  any problem.

systemd's `EnvironmentFile=` (used only for the ChatGPT tunnel's `tunnel.env`) follows
**systemd** parsing rules, not `parseEnv`.

### 1.2 Layering per process (last layer wins)

`merge()` (`secret-files.ts:279-301`) applies the file layers in order and then applies
**the process environment last**. The process environment therefore overrides every file,
so a systemd `Environment=` line overrides the same key in `runtime.env`.

| Process | Loader | Layer order, lowest to highest priority | Source |
|---|---|---|---|
| FleetController service (`dist/fleet/service/main.js`) | `loadServiceEnv()` | repo-relative `.env.fleet` (legacy) → `runtime.env` (`FLEET_RUNTIME_ENV_FILE` or `/etc/automaton-fleet/runtime.env`) → service secret (`FLEET_SERVICE_ENV_FILE`, else `$CREDENTIALS_DIRECTORY/service.env`, else `/etc/automaton-fleet/service.env`) → process env | `secret-files.ts:327-354`, `service/main.ts:343` |
| Admin CLI (`fleet:admin`, `fleet:migrate`, `fleet:doctor`, `fleet:verify`, …) | `loadAdminEnv()` | `.env.fleet` (cwd, legacy) → `runtime.env` → `admin.env` (`FLEET_ADMIN_ENV_FILE` or `/etc/automaton-fleet/admin.env`, group-read allowed) → process env | `secret-files.ts:307-319`, `postgres/cli.ts:267` |
| Operator API (`dist/fleet/operator/main.js`) | `loadOperatorEnv()` | `runtime.env` → `operator.env` (`FLEET_OPERATOR_ENV_FILE` or `/etc/automaton-fleet/operator.env`, **must exist**) → process env. It never reads `admin.env`, `service.env` or `.env.fleet` | `secret-files.ts:403-419`, `operator/main.ts:200` |
| Root witness (`dist/fleet/dry-run/root-main.js`) | `runtimeEnv()` | `runtime.env` (`FLEET_RUNTIME_ENV_FILE` or default), then **only** the keys `FLEET_RUNTIME_REPO/_COMMIT/_BUILD_ID/_LOCKFILE_SHA256` and `REAL_PAYMENTS_ENABLED/REAL_REPLICATION_ENABLED/OWNER_SWEEP_ENABLED` are overridden from the process env. Everything else is read from the process env directly | `dry-run/root-witness.ts:107-113` |
| Dry-run child (`dist/fleet/dry-run/child-main.js`) | process env only | — | `dry-run/child.ts:67-99` |
| Agent runtime (`dist/index.js --run`) | process env only. `.env.fleet` is never loaded | — | `src/index.ts:56-65, 335` |
| ChatGPT adapter (`dist/fleet/chatgpt-adapter/main.js`) | process env + JSON config file | — | `chatgpt-adapter/main.ts:111-121` |
| Claude bridge CLI / MCP (`src/fleet/bridge/cli.ts`, `mcp.ts`) | JSON config file (`--config` or default). The MCP entry point also reads `FLEET_BRIDGE_CONFIG` | — | `bridge/cli.ts:120`, `bridge/mcp.ts:82-83` |

Warnings emitted by `merge()`:

- If any `CONTROLLER_SECRET_KEYS` entry comes from the legacy `.env.fleet`, `merge()` warns
  "`<K>` is read from the repository .env.fleet (legacy); move it to a secret file under
  /etc/automaton-fleet." (`secret-files.ts:295-299`).
- `loadServiceEnv` also warns when `FLEET_ADMIN_DATABASE_URL` is visible
  (`secret-files.ts:350-352`). The service then **refuses to start** at `service/main.ts:201-203`.

`CONTROLLER_SECRET_KEYS` (`secret-files.ts:64-72`) = `FLEET_ADMIN_DATABASE_URL`,
`FLEET_OPERATOR_DATABASE_URL`, `FLEET_SERVICE_DATABASE_URL`, `FLEET_AGENT_DATABASE_URL`,
`FLEET_CONTROLLER_DATABASE_URL`, `DATABASE_URL`, `REDIS_URL`.

Repository note: a gitignored `.env.fleet` file exists in the working tree
(`.gitignore` line `.env.fleet`). This chapter does not read it because it may contain
secrets. The admin CLI and the service still read it as their lowest layer. `fleet:doctor`
warns and adds a blocker when it holds controller secrets (`doctor.ts:416-422`).

### 1.3 File permission rules applied to configuration files

| File | Validator | Accepted | Refused (exact message fragment) |
|---|---|---|---|
| `admin.env` | `secretFileProblems(file, {allowGroupRead:true})` `secret-files.ts:111-127` | regular file, no world bits, group read-only (0640/0600) | `is a symlink`, `is not a regular file`, `is world-accessible (mode …)`, `is group-writable/executable (mode …)` |
| `service.env` (explicit `FLEET_SERVICE_ENV_FILE` or `/etc/...`) | `secretFileProblems(file)` | 0600/0400 | the same, plus `is group-accessible (mode …)` |
| `$CREDENTIALS_DIRECTORY/service.env`, `$CREDENTIALS_DIRECTORY/tls.key` | `systemdCredentialProblems` `secret-files.ts:205-262` | process unit is exactly `automaton-fleet.service` (from `/proc/self/cgroup`); `CREDENTIALS_DIRECTORY` is exactly `/run/credentials/automaton-fleet.service` (normalized, no symlink); directory owned by root or self and not g/o-writable; file is exactly `<dir>/<name>`, regular, `nlink==1`, owner root or self, no world bits, group at most read (0440 allowed); source `/etc/automaton-fleet/service.env` or `/etc/automaton-fleet/tls/fleet.key` root-owned and not g/o-accessible (an EACCES on the source is tolerated) | `CREDENTIALS_DIRECTORY is not set`, `process is not running as a systemd service`, `process runs as X, not automaton-fleet.service`, `… is not the systemd credential directory …`, `… is not a known secret credential`, `… has N hard links`, `source … is owned by uid N, not root`, and others |
| `operator.env`, `chatgpt-adapter.json` | `operatorEnvFileProblems` `secret-files.ts:381-396` | `secretFileProblems(allowGroupRead)` + owner uid 0 (or injected `ownerUid`) + group-read only if the file's gid is the process's own gid + `nlink==1` + `realpath == resolve` (no symlink anywhere in the path) | `must be owned by uid 0 (is N)`, `is readable by group N, not this service's own group`, `has N hard links`, `resolves through a symlink` |
| Agent/witness credential `fleet-credentials.json` | `readCredentialFile` `service/client.ts:108-122` | regular file (lstat), mode `& 0o077 == 0` | `is not a regular file`, `must not be readable by group/others (chmod 600)`, `holds no valid fleet token`, `agentId does not match token` |
| Bridge config `bridge-claude.json` | `readOwnedFile(file,"config")` `bridge/config.ts:118-139` | opened with `O_NOFOLLOW`, regular, owned by the current uid, `nlink==1`, not g/o-**writable** (mode `& 0o022 == 0`), at most 64 KiB | `cannot be opened (ELOOP…)`, `is not owned by this user`, `has extra hard links`, `has unsafe mode …`, `is too large` → `BridgeError CONFIG_INVALID` |
| `runtime.env`, `.env.fleet` | none (`readEnvFile`) | any | — |

---

## 2. Global safety switches

These four switches are named in CLAUDE.md, and they must not change without explicit
operator approval. Each one is read independently by several processes. There is **no
single source of truth**: each process reads its own environment or `runtime.env`.

| Name | Component (read at) | Type | Default | Required? | Safe/secret | Validation (exact) | Production value | Effect | Dangerous combinations |
|---|---|---|---|---|---|---|---|---|---|
| `REAL_REPLICATION_ENABLED` | agent `loadFleetConfig` `src/fleet/config.ts:70`; service `service/main.ts:258`; doctor `doctor.ts:219`; operator API refusal `operator/main.ts:39,96` and view `:116`; witness refusal `root-witness.ts:66,128-130`; dry-run child refusal `dry-run/child.ts:38,70` | flag | false | no | safe | `true`-only (`config.ts:37-39`; `service/main.ts:258` uses the same trim/lowercase check) | `false` (CLAUDE.md posture). Set in `runtime.env` (runbook l.47) and in `automaton-agent.service` `Environment=` (l.24) | **Service:** when false, `POST /v1/replication/request` returns HTTP 403 `REAL_REPLICATION_DISABLED` and writes a `replication_rejected` DB event with `code:"REAL_REPLICATION_DISABLED", by:"service"` (`service/server.ts:821-824`). `/readyz` reports it (`server.ts:393`). **Agent:** local policy denies when false (`src/fleet/policy.ts:121`). **Doctor:** a check fails when true (`doctor.ts:226-228`). **Operator API, witness and dry-run child refuse to start when true** | Enabling it only in `runtime.env` also needs the registry switch `fleet_state.replication_enabled` (`fleet:admin set-replication on`, checked in SQL at `migrations.ts:550`, `migrations-phase5.ts:721`, `migrations-phase7.ts:184`), EXPANSION mode, cap headroom, an approved runtime and a *living* parent. Enabling it in `runtime.env` stops the Operator API and the witness at their next restart |
| `REAL_PAYMENTS_ENABLED` | agent `config.ts:71`; custody `treasury/custody.ts:36`; doctor `doctor.ts:220`; operator API refusal `operator/main.ts:39,96`; witness refusal `root-witness.ts:66`; dry-run child `child.ts:38` | flag | false | no | safe | `true`-only | `false` (CLAUDE.md), in `runtime.env` and the agent unit (l.25) | **Agent:** when false, `fund_child` is denied (`policy.ts:170`). `executeApprovedSpend` returns `{executed:false, reason:"REAL_PAYMENTS_ENABLED=false"}` (`custody.ts:36`). **Not read by the FleetController service at all** | When true, `executeApprovedSpend` still refuses unless a `ControllerSigner` is supplied (`custody.ts:37`). **NOT IMPLEMENTED:** no ControllerSigner exists in the repository (`doctor.ts:552` blocker text). Combined with `FLEET_MODE=EXPANSION`, agent-side child funding becomes allowed by local policy |
| `OWNER_SWEEP_ENABLED` | agent `config.ts:72`, warning at `src/index.ts:374-376`; doctor `doctor.ts:221`; operator API refusal `operator/main.ts:39,96`; witness refusal `root-witness.ts:66`; dry-run child `child.ts:38` | flag | false | no | safe (explicitly allow-listed as non-secret despite matching `^OWNER_…` patterns: `secrets.ts:136`) | `true`-only | `false` (CLAUDE.md), in `runtime.env` and the agent unit (l.26) | The agent logs `OWNER_SWEEP_ENABLED is set but owner sweeps are not implemented; ignoring.` (`index.ts:375`). The doctor flag check fails. **NOT IMPLEMENTED:** owner sweeps do not exist | True stops the Operator API, the witness and the dry-run child. It has no functional effect otherwise |
| `FLEET_DRY_RUN_CHILD` | admin CLI dry run `dry-run/operator.ts:163`; operator API refusal `operator/main.ts:39,96` and view `:119` | flag | false | no | safe | `flagOn` = `true`-only | `false` in `runtime.env` (runbook l.47, l.1064: `true` exists only in the environment of the single dry-run command) | `performDryRunChild` throws `DRY_RUN_CHILD mode is off: set FLEET_DRY_RUN_CHILD=true for this command.` unless it is true. The real sandbox also needs `--confirm-real-sandbox` and `CONWAY_API_KEY` (`postgres/cli.ts:428-435`) | If set in `runtime.env`, the Operator API refuses to start. When true in the operator's shell together with `--confirm-real-sandbox` and `CONWAY_API_KEY`, the dry run creates **one real remote sandbox** |

---

## 3. FleetController service (`automaton-fleet.service`)

Entry point: `src/fleet/service/main.ts:331-353`, which uses `loadServiceEnv()` and then
`startFleetServiceFromEnv(env)`. The unit is at `deploy/systemd/automaton-fleet.service`.

| Name | Component (read at) | Type | Default | Required? | Safe/secret | Validation (exact) | Production value | Effect | Dangerous combinations |
|---|---|---|---|---|---|---|---|---|---|
| `FLEET_SERVICE_DATABASE_URL` | `service/main.ts:204` | PostgreSQL URL | — | **yes** (or a legacy fallback) | **secret** | The first non-empty value of `FLEET_SERVICE_DATABASE_URL` → `FLEET_CONTROLLER_DATABASE_URL` → `DATABASE_URL`, else `FLEET_SERVICE_DATABASE_URL (restricted controller role) is not configured.` At startup the connection must not be the schema owner or a superuser (`main.ts:233-238`: `…must use the restricted service role (fleet_service_login), not the schema owner|a superuser <user>`). The privilege audit of `[FLEET_SERVICE_ROLE, <login>]` must pass (`main.ts:241-243`) | [SECRET REDACTED — PURPOSE: login `fleet_service_login` to `automaton_fleet` on 127.0.0.1:5432; delivered only via `LoadCredential=service.env`] | Pool `application_name=automaton-fleet-service` (`main.ts:223`); all `svc_*` calls | If it is the admin/owner DSN, the service refuses to start. If the same user is used as `FLEET_AGENT_DATABASE_URL`, the service refuses to start (`main.ts:208-210`) |
| `FLEET_AGENT_DATABASE_URL` | `service/main.ts:205` | PostgreSQL URL | — | **yes** | **secret** | Missing gives `FLEET_AGENT_DATABASE_URL (restricted agent role) is not configured.` The username must be parseable and different from the service DSN user (`main.ts:208-210`). `PgAgentGateway.selfCheck()` must return no problems (`main.ts:239-240`) | [SECRET REDACTED — PURPOSE: login `fleet_agent_login`, the restricted agent gateway role] | Agent-facing DB gateway | The agent refuses to start if this is present in its own environment (it matches `secrets.ts:110,125`) |
| `FLEET_CONTROLLER_DATABASE_URL` | `service/main.ts:204` (fallback), `store.ts:438` (admin fallback) | PostgreSQL URL | — | legacy | **secret** | same as above | not set (runbook: service.env holds only the two keys; `deploy/etc/service.env.example`) | Legacy alias | Privileged for agents (`secrets.ts:109`). Forbidden for the Operator API, the adapter and the dry-run child |
| `DATABASE_URL` | `service/main.ts:204`, `store.ts:438`, test `fleet-phase2.test.ts:83` | PostgreSQL URL | — | legacy | **secret** | same | not set | Legacy alias | Privileged for agents (`secrets.ts:108`) |
| `FLEET_ADMIN_DATABASE_URL` (negative) | `service/main.ts:201-203` | — | — | **must be absent** | secret | Any non-empty value gives `The fleet service must not hold FLEET_ADMIN_DATABASE_URL (admin credentials are for the operator CLI only).` | absent | Startup refusal | — |
| `FLEET_SERVICE_ENV_FILE` | `secret-files.ts:332` | absolute path | unset. Then `$CREDENTIALS_DIRECTORY/service.env`, else `/etc/automaton-fleet/service.env` | no | safe (it is a path) | When set, the file is **required** (`required: !!(explicit \|\| credDir)`) and gets the **strict** 0600 checks, never the systemd-credential exception (`secret-files.ts:336-339`) | unset (the unit uses LoadCredential) | Overrides the source of the service secret | Setting it under systemd disables the verified-credential path. The file must then be 0600 and readable by the service user |
| `CREDENTIALS_DIRECTORY` | `secret-files.ts:333`; `service/main.ts:102`; `doctor.ts:440` | path (set by systemd) | set by systemd when `LoadCredential=` is used | yes in production | safe | Must equal exactly `/run/credentials/automaton-fleet.service` (`secret-files.ts:216-219`) | `/run/credentials/automaton-fleet.service` (systemd-provided) | Enables the `service.env` and `tls.key` credential paths | Forbidden in the Operator API and adapter environments (`secret-files.ts:371`). Matched by the agent shell guard `command-safety.ts:86` |
| `FLEET_RUNTIME_ENV_FILE` | `secret-files.ts:309,340,408`; `operator/main.ts:165`; `root-witness.ts:109`; `scripts/fleet-deploy-release.sh:22` | absolute path | `/etc/automaton-fleet/runtime.env` | no | safe | none (`readEnvFile`, missing file = `{}`) | `/etc/automaton-fleet/runtime.env` (unit l.37) | Source of the non-secret layer | Pointing it at a writable file lets whoever writes that file change safety flags and pins |
| `FLEET_API_LISTEN` | `service/main.ts:216` → `parseListen` `:74-87` | `host:port` | `127.0.0.1:8787` | no | safe | Regex `^(\[[^\]]+\]\|[^:]+):(\d{1,5})$`. The host must be in `{127.0.0.1, ::1, [::1], localhost}` unless `remoteAllowed` (= remote requested **and** TLS loaded **and** no `FLEET_PUBLIC_LISTEN`). Port `0..65535` (port **0 is accepted**, meaning ephemeral). `localhost` becomes `127.0.0.1`. Errors: `FLEET_API_LISTEN must be host:port (got …)`, `FLEET_API_LISTEN must be a loopback address (127.0.0.1 / ::1) unless FLEET_REMOTE_LISTEN_ENABLED=true and TLS is configured (got …)`, `FLEET_API_LISTEN port out of range: …` | `127.0.0.1:8787` (unit `Environment=` l.39, which overrides the same key in runtime.env) | Plain-HTTP admin/local listener (or the TLS listener when there is no separate public listener) | When remote is enabled without `FLEET_PUBLIC_LISTEN`, this address serves HTTPS and may be non-loopback |
| `FLEET_REMOTE_LISTEN_ENABLED` | `service/main.ts:154,212`; `doctor.ts:441`; `scripts/fleet-verify-deployment.sh:180` | flag | false | no | safe | `true`-only. When true, TLS must be loaded (`main.ts:213`: `FLEET_REMOTE_LISTEN_ENABLED=true requires FLEET_TLS_CERT_FILE and FLEET_TLS_KEY_FILE.`). `FLEET_PUBLIC_HOSTNAME` must match `HOSTNAME_RE` (`main.ts:144`). The certificate must cover the hostname, be valid now, have at least 1 day (86 400 000 ms) left, and match the key (`tlsProblemsForHost` `:125-142`) | `true` on the production VPS only (CLAUDE.md, operator-approved at S8) | Enables the public HTTPS listener for remote children | Safety-gated per CLAUDE.md. It needs DNS, the certificate, the `remote.conf` drop-in (LoadCredential, `IPAddressAllow=any`, `CAP_NET_BIND_SERVICE`) and the firewall (443 only) |
| `FLEET_PUBLIC_HOSTNAME` | `service/main.ts:165-166`; `doctor.ts:500` | DNS name | — | yes if remote | safe | `HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i`. Error: `FLEET_REMOTE_LISTEN_ENABLED=true requires FLEET_PUBLIC_HOSTNAME (a DNS name).` | `api.agentfleet.vip` (runbook l.857; CLAUDE.md controller domain) | Certificate host check; `publicUrl` in logs; doctor checklist | — |
| `FLEET_PUBLIC_LISTEN` | `service/main.ts:155,169` | `host:port` | unset | no | safe | Parsed with `parseListen(…, {remoteAllowed:true})`. If set while remote is off: `FLEET_PUBLIC_LISTEN requires FLEET_REMOTE_LISTEN_ENABLED=true.` | `0.0.0.0:443` (runbook l.858) | Separate public HTTPS listener. `FLEET_API_LISTEN` then stays plain HTTP on loopback (`service.listenAdmin`, `main.ts:279-282`) | Port 443 needs `AmbientCapabilities=CAP_NET_BIND_SERVICE` (remote.conf.example l.25-26) |
| `FLEET_PUBLIC_URL` | `doctor.ts:507`; admin CLI `dry-run-child` default `--api-url` `postgres/cli.ts:419` | https URL | derived as `https://<FLEET_PUBLIC_HOSTNAME>[:<FLEET_PUBLIC_PORT>]` | no | safe | Trailing slashes stripped. The doctor probes `<url>/healthz` only if it starts with `https://` (timeout 5000 ms) | `https://api.agentfleet.vip` (runbook l.859) | Doctor "remote reachable" checklist item; dry-run default controller URL | **Not read by the service itself** |
| `FLEET_PUBLIC_PORT` | `doctor.ts:507` | port string | unset | no | safe | none (string-interpolated) | not set <!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md --> | Used only by doctor to derive `FLEET_PUBLIC_URL` | DRIFT: undocumented (§10) |
| `FLEET_TLS_CERT_FILE` | `service/main.ts:100`; `doctor.ts:439-440,502`; verify script `:148-150` | path | — | yes if TLS | safe (public certificate) | Both the cert and a key must be present, else `Both FLEET_TLS_CERT_FILE and FLEET_TLS_KEY_FILE are required for TLS.` The cert must not be a secret credential (`Refusing TLS certificate: … is a secret credential.` / `… is a secret file.`, `main.ts:106-112`). The verify script requires exactly `/run/credentials/automaton-fleet.service/tls.crt` when it is set in `runtime.env` | `/run/credentials/automaton-fleet.service/tls.crt` (runbook l.860) | TLS certificate for the HTTPS listener | — |
| `FLEET_TLS_KEY_FILE` | `service/main.ts:101`; `doctor.ts:440,479`; verify script `:143-146` | path | unset, which means `$CREDENTIALS_DIRECTORY/tls.key` when `CREDENTIALS_DIRECTORY` and the cert are set | no — **must be unset in production** | safe as a name (it points at a secret) | When set: strict `secretFileProblems` (0600, no group) **even inside `CREDENTIALS_DIRECTORY`** (`main.ts:113-115`). When unset: `systemdCredentialProblems(…, "tls.key", credDir, "/etc/automaton-fleet/tls/fleet.key")` | **unset** (runbook l.853; the verify script fails if it is set) | Selects the TLS private key | Setting it bypasses the verified-credential path and requires a 0600 key readable by the service user. CLAUDE.md forbids broadening this |
| `FLEET_ALLOWED_ORIGINS` | `service/main.ts:156-159` | comma list | empty | no | safe | Every entry must match `^https:\/\/[^/\s]+$`, else `FLEET_ALLOWED_ORIGINS entries must be https origins (got …).` This is validated **even when remote is disabled** | unset (runbook l.853) | Browser origins accepted by the service's origin check (`service/server.ts:563`) | Adding origins widens browser-reachable surface |
| `FLEET_SERVICE_EXPECTED_USER` | `service/main.ts:175-176` | OS user name | unset (then only uid 0 is refused) | no (recommended) | safe | `The fleet service must not run as root.` (uid 0 is always refused). A mismatch gives `The fleet service must run as <X> (running as <Y>).` | `automaton-fleet-service` (unit l.36) | Identity pin | — |
| `FLEET_REAPER_INTERVAL_MS` | `service/main.ts:263` → `server.ts:295,381` | integer ms | 15000 | no | safe | **No validation.** A truthy string goes through `Number(...)`. `"0"` or a negative value disables the reaper (the readiness check shows a warning but stays ok). A non-numeric value gives `NaN`: `NaN <= 0` is false, so `setInterval(fn, NaN)` runs, which Node clamps to **1 ms** (a hot loop), and the readiness reaper check becomes permanently false because `Math.max(3*NaN, 60000)` is `NaN` | `15000` (runtime.env, runbook l.81; `deploy/etc/runtime.env.example:20`) | Background reaper period (heartbeat expiry, lease expiry, termination) | `0` disables automatic reaping, so dead agents keep their slots until an admin runs `reap`. A malformed value causes CPU spin and a not-ready service |
| `FLEET_SHUTDOWN_DRAIN_MS` | `service/main.ts:264` → `server.ts:348` | integer ms | 10000 | no | safe | No validation. `NaN` means no drain wait | `10000` (unit l.40) | Graceful drain window on SIGTERM | — |
| `FLEET_AUDIT_LOG` | `service/main.ts:255` → `createAuditSink` `service/log.ts:40-47` | path | unset (stdout/journald only) | no | safe | The file is opened or created in append mode with mode `0o600` at startup (`log.ts:41`). Each line is the canonical redacted record | `/var/log/automaton-fleet/audit.jsonl` (unit l.38) | JSONL audit copy | — |
| `FLEET_PG_SCHEMA` | `service/main.ts:220`; `store.ts:442`; `postgres/cli.ts:316,332`; `operator/main.ts:131` | identifier | `fleet` (`store.ts:68`; `operator/main.ts:131`) | no | safe | `quoteIdent`: `^[a-z_][a-z0-9_]{0,62}$`, else `Invalid fleet schema name: …` (`migrations.ts:1210-1215`). It is interpolated into `search_path` | `fleet` (default) | Registry schema | An agent shell assignment is blocked (`command-safety.ts:79`) |
| `FLEET_SERVICE_ROLE` | `service/main.ts:221`; `store.ts:444` | role name | `fleet_service` | no | safe | `quoteIdent` in `PgFleetStore` (`store.ts:413`) | default | Role name used by the privilege audit and grants | Pointing the audit at the wrong role hides privilege problems |
| `FLEET_AGENT_ROLE` | `service/main.ts:222`; `store.ts:443` | role name | `fleet_agent` | no | safe | `quoteIdent` | default | same | Agent shell assignment blocked (`command-safety.ts:82`) |
| `NODE_ENV` | set by unit l.34. **Not read by service code** | string | — | no | safe | — | `production` | none for the service | — |
| `FLEET_RUNTIME_*` | see §4 | | | | | | | | |

The FleetController also depends on registry-held configuration in the database (§11).

---

## 4. Runtime pinning (release identity)

These four keys live in `runtime.env` (non-secret, 0644) and are printed by
`scripts/fleet-build-runtime.sh` (l.28-31).

| Name | Component (read at) | Type | Default | Required? | Safe/secret | Validation (exact) | Production value | Effect | Dangerous combinations |
|---|---|---|---|---|---|---|---|---|---|
| `FLEET_RUNTIME_REPO` | `runtime.ts:84,352,358` (`validateRuntimePin`); `config.ts:77`; `doctor.ts:348,496`; admin `approve-runtime` `postgres/cli.ts` (`validateRuntimePin(e.FLEET_RUNTIME_REPO, e.FLEET_RUNTIME_COMMIT)`); `fleet-deploy-release.sh:25` | https URL | none | yes for a complete release | safe | Must not be empty: `FLEET_RUNTIME_REPO is not set.` It is refused if the owner/name ends with `conway-research/automaton` in any case, scheme or `.git` spelling: `Upstream Conway Research runtime is not allowed; children must run the fleet fork.` It must match `REPO_RE = /^https:\/\/([a-z0-9.-]+(?::\d{1,5})?)\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/` with owner/name not `.` or `..`, else `FLEET_RUNTIME_REPO must be an https://host/owner/repo URL without credentials.` It is normalized to `https://<lower host>/<owner>/<name>` (no `.git`, no trailing slash) | `https://github.com/5l4mm3r/automaton-fleet.git` in runtime.env (runbook l.153: runtime.env keeps `.git`, the registry stores it without; the two normalize equal) | Pin compared with the registry approval (`fleet_state.runtime_repo`) | An agent shell assignment is blocked (`command-safety.ts:79`, `tools.ts:85`) |
| `FLEET_RUNTIME_COMMIT` | same | 40-hex | none | yes | safe | trim, lowercase, `^[0-9a-f]{40}$`, else `FLEET_RUNTIME_COMMIT must be a full 40-character commit SHA.` / `FLEET_RUNTIME_COMMIT is not set.` | `4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790` | Commit pin | Changing it while the registry approves another commit makes the service refuse to start (`service/main.ts:247-252`) and the Operator API refuse to start (`operator/main.ts:143-151`) |
| `FLEET_RUNTIME_BUILD_ID` | `attestation.ts:85` (`validateRuntimeBuild`); `runtime.ts:352,360`; `doctor.ts:350,498`; admin `approve-runtime` (required: `FLEET_RUNTIME_BUILD_ID and FLEET_RUNTIME_LOCKFILE_SHA256 are required (scripts/fleet-build-runtime.sh prints them).` `postgres/cli.ts:473`) | 64-hex | none | yes | safe | trim, lowercase, `HEX64` (`^[0-9a-f]{64}$`); `runtimeReleaseProblem` reports `FLEET_RUNTIME_BUILD_ID / FLEET_RUNTIME_LOCKFILE_SHA256 are missing or not 64-hex.` | `54beb10104a11888446ed1d09a85f236d87b977558a88514de7600d7dcc83ced` | Build identity pin, compared with `fleet_state.runtime_build_id` | **Service:** an incomplete release does not stop startup. It logs `runtime_release_unpinned` with `effect: "claims and activations are refused"` (`service/main.ts:253`). **Operator API:** refuses to start (`operator/main.ts:97`). **Witness:** refuses to start and also recomputes the installed tree's build id (`root-witness.ts:162-175`) |
| `FLEET_RUNTIME_LOCKFILE_SHA256` | same | 64-hex | none | yes | safe | same | `eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811` | Lockfile hash pin | same |

`sameRelease` (`runtime.ts:365-371`) compares repo, commit, buildId and lockfileSha256
exactly, using normalized repos.

Hard-coded runtime constants (not configurable): `CHILD_RUNTIME_DIR = "/root/automaton"`,
`CHILD_RUNTIME_MANIFEST = "/root/.automaton/fleet-runtime.json"` (`runtime.ts:21-22`).

---

## 5. Admin CLI / PostgreSQL (`pnpm fleet:admin`, `fleet:migrate`, `fleet:doctor`, `fleet:verify`, `fleet:verify-runtime`, `fleet:audit-privileges`, `fleet:migrate-check`, `fleet:dry-run-child`)

| Name | Component (read at) | Type | Default | Required? | Safe/secret | Validation (exact) | Production value | Effect | Dangerous combinations |
|---|---|---|---|---|---|---|---|---|---|
| `FLEET_ADMIN_DATABASE_URL` | `store.ts:438` (`PgFleetStore.fromEnv`, which chooses `FLEET_ADMIN_DATABASE_URL \|\| FLEET_CONTROLLER_DATABASE_URL \|\| DATABASE_URL`); `postgres/cli.ts:315` (operator admin gateway) | PostgreSQL URL | — | **yes** for every DB command | **secret** | Missing gives `FLEET_ADMIN_DATABASE_URL is not configured (environment, /etc/automaton-fleet/admin.env, or legacy .env.fleet).` and exit 2 (`cli.ts:308-311`). The `doctor` command still runs with `store: null` | [SECRET REDACTED — PURPOSE: schema-owner login `fleetadmin` for migrations and the operator CLI; `/etc/automaton-fleet/admin.env` root:automaton-fleet-admin 0640] | Pool `application_name=automaton-fleet-admin` | Visible to the service → refusal. Visible to the Operator API, adapter, dry-run child or witness → refusal. Visible to an agent → refusal (`secrets.ts:128` pattern `^FLEET_(CONTROLLER\|ADMIN\|SIGNING\|SERVICE)_`) |
| `FLEET_ADMIN_ENV_FILE` | `secret-files.ts:308,315` | path | `/etc/automaton-fleet/admin.env` | no | safe | When set, the file is **required** and `allowGroupRead` checks apply | unset | Alternate admin secret file | — |
| `FLEET_OPERATOR_ROLE` | `store.ts:445` | role name | `fleet_operator` (`store.ts:74`) | no | safe | `quoteIdent` | default | Operator role name for the privilege audit and grants | — |
| `FLEET_API_URL` (doctor) | `doctor.ts:372,428` | URL | `http://127.0.0.1:8787` | no | safe | Trailing slashes stripped. The doctor probes `<url>/readyz` (timeout 3000 ms). It adds a security warning when the URL is set and is neither `^http:\/\/(127\.0\.0\.1\|\[::1\]\|localhost)(:\d+)?$` nor https | unset in admin.env/runtime.env <!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md --> | The service the doctor checks | — |
| `CONWAY_API_KEY` | `postgres/cli.ts:83-86` (`operatorConway`); used by `dry-run-child --confirm-real-sandbox` (`:433-434`) and provisioning reconciliation (`:398-407`) | API key | — | only for those commands | **secret** | Missing gives `CONWAY_API_KEY is required for the real dry run (it creates one remote sandbox).` | [SECRET REDACTED — PURPOSE: Conway API key, in the operator's shell for one command only, read with `read -rs` (runbook l.200); never in a file] | Creates or looks up Conway sandboxes | Forbidden in the Operator API, adapter and dry-run child environments |
| `CONWAY_API_URL` | `postgres/cli.ts:86` | URL | `https://api.conway.tech` | no | safe | none | default | Conway endpoint | — |
| `FLEET_DRY_RUN_CHILD` | see §2 | | | | | | | | |
| CLI `--api-url` / `FLEET_PUBLIC_URL` | `postgres/cli.ts:419-420` | https URL | `FLEET_PUBLIC_URL` | yes for `dry-run-child` | safe | usage error `usage: dry-run-child --root <agentId> --api-url https://<controller> [--confirm-real-sandbox]` | `https://api.agentfleet.vip` | Controller URL handed to the dry-run child | — |

`fleet-db-roles.sql` psql variables: `:dbname`, `:owner`. They are supplied by
`scripts/fleet-db-setup.sh` from `FLEET_DB_NAME` and `FLEET_DB_OWNER` (§12.1).

---

## 6. Operator API (`automaton-fleet-operator-api.service`)

Entry point: `src/fleet/operator/main.ts:188-209`. The unit sets
`User=automaton-fleet-operator-api`.

| Name | Component (read at) | Type | Default | Required? | Safe/secret | Validation (exact) | Production value | Effect | Dangerous combinations |
|---|---|---|---|---|---|---|---|---|---|
| `FLEET_OPERATOR_DATABASE_URL` | `operator/main.ts:95,132` | PostgreSQL URL | — | **yes** | **secret** | Missing gives `FLEET_OPERATOR_DATABASE_URL is not configured (operator.env)`. The login must not be the owner or a superuser, must equal `FLEET_OPERATOR_DB_LOGIN` (default `fleet_operator_login`), and must be a member of nothing but `fleet_operator` (`main.ts:134-139`). Schema version must be `OPERATOR_SCHEMA_VERSION` (8), and `auditOperator` must be ok | [SECRET REDACTED — PURPOSE: `fleet_operator_login` 64-hex password; `/etc/automaton-fleet/operator.env` root:automaton-fleet-operator-api 0640] | `PgOperatorGateway` (`search_path=<schema>`, `statement_timeout=5000`, `lock_timeout=2000`, `idle_in_transaction_session_timeout=10000`, `gateway.ts:63`) | Forbidden to the ChatGPT adapter (`chatgpt-adapter/main.ts:40`) and to agents (pattern `(^\|_)DATABASE_URL$`) |
| `FLEET_OPERATOR_ENV_FILE` | `secret-files.ts:407` | path | `/etc/automaton-fleet/operator.env` | the file must exist | safe | `Secret file … does not exist.` plus the `operatorEnvFileProblems` messages | `/etc/automaton-fleet/operator.env` (unit l.35) | Secret source | — |
| `FLEET_OPERATOR_EXPECTED_USER` | `operator/main.ts:82-85` | user name | unset | **yes when `NODE_ENV=production`** | safe | uid 0 gives `refusing to run as root (uid 0)`. A mismatch gives `running as X, expected Y`. Missing under production gives `FLEET_OPERATOR_EXPECTED_USER is required in production` | `automaton-fleet-operator-api` (unit l.33) | Identity pin | — |
| `NODE_ENV` | `operator/main.ts:85` | string | — | — | safe | exact `production` | `production` (unit l.32) | Makes `FLEET_OPERATOR_EXPECTED_USER` mandatory | — |
| `FLEET_OPERATOR_LISTEN` | `operator/main.ts:42-49,99,130` | `host:port` | `127.0.0.1:8788` (`DEFAULT_OPERATOR_LISTEN`, `:37`) | no | safe | `^(127\.0\.0\.1\|\[::1\]\|localhost):([0-9]{1,5})$` → `FLEET_OPERATOR_LISTEN must be a loopback address (got <redacted>)`; port `1..65535` → `FLEET_OPERATOR_LISTEN port out of range`. **Non-loopback is impossible** | `127.0.0.1:8788` (unit l.34; rules file) | Listener | — |
| `FLEET_OPERATOR_DB_LOGIN` | `operator/main.ts:136-137` | role name | `fleet_operator_login` | no | safe | Exact match against `current_user`: `the operator database login is X, expected Y` | default | Login identity pin | — |
| `FLEET_OPERATOR_AUDIT_LOG` | `operator/main.ts:164` | path | unset | no | safe | `createAuditSink` creates the file 0600 | `/var/log/automaton-fleet-operator/audit.jsonl` (unit l.37) | JSONL audit copy | — |
| `FLEET_OPERATOR_REQUIRE_TIMESYNC` | `operator/main.ts:160` | flag (inverted) | true | no | safe | Only a literal `false` (after trim and lowercase) disables the check | `true` (unit l.38) | `/readyz` `clock.ok` requires the marker file **and** DB clock skew ≤ 5000 ms (`main.ts:169-171`) | `false` removes the NTP-sync requirement from readiness (skew is still checked) |
| `FLEET_OPERATOR_TIMESYNC_MARKER` | `operator/main.ts:159` | path | `/run/systemd/timesync/synchronized` (`:38`) | no | safe | `?.trim() ?? default`. An **empty string** is kept (because `??` does not fall back), and `fs.existsSync("")` is false, so the clock is never ready | default (unset) | Marker for the NTP-synced state | Setting it to an always-present file defeats the NTP check |
| `FLEET_RUNTIME_ENV_FILE` | `secret-files.ts:408`; `operator/main.ts:165` | path | `/etc/automaton-fleet/runtime.env` | no | safe | — | `/etc/automaton-fleet/runtime.env` (unit l.36) | Layer + live `runtimeFlags()` view (re-read per request; unreadable gives `null` flags) | — |
| `FLEET_PG_SCHEMA` | `operator/main.ts:131` | identifier | `fleet` | no | safe | `quoteIdent` in `PgOperatorGateway` (`gateway.ts:55`) | default | — | — |
| `FLEET_RUNTIME_*` (4) | `operator/main.ts:97,142-151` | see §4 | — | **yes** | safe | `no complete pinned runtime release (FLEET_RUNTIME_REPO/_COMMIT/_BUILD_ID/_LOCKFILE_SHA256)`. Must equal the registry exactly: `pinned runtime release differs from the registry-approved runtime` | §4 values | — | — |
| Safety switches (4) | `operator/main.ts:39,96` | flags | — | must be false | safe | `<NAME>=true (the Operator API refuses to run with a safety switch on)` | all false | Startup refusal | — |
| Forbidden env (`OPERATOR_FORBIDDEN_ENV`) | `secret-files.ts:357-372`, `operator/main.ts:86` | — | — | **must be absent** | — | Any non-empty value of `FLEET_ADMIN_DATABASE_URL`, `FLEET_SERVICE_DATABASE_URL`, `FLEET_AGENT_DATABASE_URL`, `FLEET_CONTROLLER_DATABASE_URL`, `DATABASE_URL`, `PGPASSWORD`, `REDIS_URL`, `CONWAY_API_KEY`, `WALLET_PRIVATE_KEY`, `PRIVATE_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `FLEET_CREDENTIALS_FILE`, `CREDENTIALS_DIRECTORY` gives `<K> present (the Operator API must hold no admin/service/agent/Conway/wallet credential)` | none present | Startup refusal | — |
| Unreadable files (`OPERATOR_UNREADABLE_FILES`) | `operator/main.ts:64-72,87-94` | — | — | must be unreadable | — | If `fs.accessSync(R_OK)` succeeds on `/etc/automaton-fleet/admin.env`, `/etc/automaton-fleet/service.env`, `/etc/automaton-fleet/tls/fleet.key`, `/etc/automaton-fleet/legacy-env-fleet.bak`, `/run/credentials/automaton-fleet.service/service.env`, `/run/credentials/automaton-fleet.service/tls.key` or `/var/lib/automaton-fleet-witness/fleet-credentials.json`, the result is `controller secret <f> is readable by this process` | all unreadable | Startup refusal | — |

The Operator API has no environment switch to enable or disable it. It is controlled by
the DB kill switch `fleet_operator_state.operator_api_enabled` (default `false`,
`migrations-phase8.ts:37`). Production: enabled (rules file).

---

## 7. Claude bridge (Phase D, dev VM only)

### 7.1 Environment

| Name | Component (read at) | Type | Default | Required? | Safe/secret | Validation | Production value | Effect | Dangerous combinations |
|---|---|---|---|---|---|---|---|---|---|
| `FLEET_BRIDGE_CONFIG` | `bridge/mcp.ts:83` (**MCP entry only**; `--config` wins) | path | `DEFAULT_CONFIG_FILE` = `~/.config/automaton-fleet/operator/bridge-claude.json` (`bridge/config.ts:21-22`, from `os.homedir()`) | no | safe | the file checks in §1.3 | unset. The MCP registration passes `--config /home/sl4mm3r/.config/automaton-fleet/operator/bridge-claude.json` (`docs/design/phase-d-claude-bridge.md:253`) | Config path | DRIFT: `bridge/cli.ts:120` ignores `FLEET_BRIDGE_CONFIG` (only `--config`) |
| `XDG_RUNTIME_DIR` | `bridge/tunnel.ts:208-210` | path | fallback `<DEFAULT_BRIDGE_DIR>/run` | no | safe | Used only if absolute and it exists. The run dir is `<XDG_RUNTIME_DIR>/automaton-fleet-bridge`, created 0700 and checked by `requirePrivateDirectory` | dev VM session value | Persistent-tunnel control/state directory | — |
| `HOME` | `bridge/config.ts:21` (via `os.homedir()`); `bridge/tunnel.ts:270` (passed to ssh) | path | — | — | safe | — | the dev VM operator home | Default config location; ssh child `HOME` | The ssh child environment is fixed: `PATH=/usr/bin:/bin`, `HOME`, `LANG=C` plus explicit additions (`tunnel.ts:270`) |

### 7.2 `bridge-claude.json` fields (`parseBridgeConfig`, `bridge/config.ts:81-109`; unknown fields are rejected by `exactKeys`)

| Field | Type | Validation (exact) | Production (dev VM) value | Effect |
|---|---|---|---|---|
| `version` | number | must be `1` (`config.version must be 1`) | `1` | Schema version |
| `principalId` | string | `PRINCIPAL_RE = /^op_[0-9A-HJKMNP-TV-Z]{26}$/` (`operator/canonical.ts:44`) | `op_01M3AX56W25JNMQCTBM8HYH474` (bridge-claude) | Signing principal |
| `key.keyFile` | abs path | `path.isAbsolute`, `path.normalize(v)===v`, no NUL | <!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md --> (dev VM path; the key itself is [SECRET REDACTED — PURPOSE: Ed25519 operator signing key for bridge-claude]) | Private key file (read `secret`: no g/o bits) |
| `key.keyId` | string | `KEY_ID_RE = /^[0-9a-f]{32}$/` | `ec4f06982ae9135fd2b28e928f5a4a61` | Key id header |
| `key.expiresAt` | ISO or null | `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/` | `2026-10-24T23:49:04.533Z` | Learned from whoami |
| `pendingKey` / `previousKey` | KeyRef or null | same as `key`. All key files must be distinct (`key files must be distinct`) | <!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md --> | Rotation state |
| `ssh.host` | string | IPv4 or lowercase hostname (`HOST_RE`, `config.ts:51`) | <!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md --> (the VPS; ssh alias `agentfleet-vps`) | Tunnel host |
| `ssh.port` | int | 1..65535 | <!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md --> (`init` default 22, `bridge/cli.ts:89`) | — |
| `ssh.user` | string | `^[a-z_][a-z0-9_-]{0,31}$` | `fleet-op-tunnel` (`init` default, `cli.ts:107`; CLAUDE.md) | Restricted SSH account |
| `ssh.identityFile` | abs path | normalized absolute | <!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md --> ([SECRET REDACTED — PURPOSE: SSH tunnel private key; dev VM only]) | — |
| `ssh.knownHostsFile` | abs path | normalized absolute; the pinned line is verified (`verifyPinnedKnownHosts`) | `<config dir>/known_hosts` (`init`, `cli.ts:95`) | Host-key pin file |
| `ssh.hostKeyFingerprint` | string | `^SHA256:[A-Za-z0-9+/]{43}$` | <!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md --> | Pinned ssh-ed25519 host key |
| `ssh.binary` | abs path | normalized absolute | `/usr/bin/ssh` (`init` default, `cli.ts:111`) | SSH executable |

Fixed (not configurable): `OPERATOR_REMOTE = {host:"127.0.0.1", port:8788}` (`bridge/config.ts:19`).

---

## 8. ChatGPT adapter and tunnel (Phase C, production VPS)

### 8.1 Adapter environment (`automaton-fleet-chatgpt-adapter.service`)

| Name | Component (read at) | Type | Default | Required? | Safe/secret | Validation (exact) | Production value | Effect | Dangerous combinations |
|---|---|---|---|---|---|---|---|---|---|
| `FLEET_CHATGPT_ADAPTER_CONFIG` | `chatgpt-adapter/main.ts:115` | path | `/etc/automaton-fleet/chatgpt-adapter.json` (`config.ts:18`) | no | safe | `loadAdapterConfig`: the file must exist (`<file> does not exist`), `operatorEnvFileProblems` must pass (`refusing insecure config: …`), and the content must be valid JSON | `/etc/automaton-fleet/chatgpt-adapter.json` (unit l.31) | Config path | — |
| `FLEET_CHATGPT_ADAPTER_EXPECTED_USER` | `main.ts:84-86` | user | unset | **yes when `NODE_ENV=production`** | safe | uid 0 gives `refusing to run as root`. A mismatch gives `running as X, expected Y`. Missing under production gives `FLEET_CHATGPT_ADAPTER_EXPECTED_USER is required in production` | `automaton-fleet-chatgpt-adapter` (unit l.30) | Identity pin | — |
| `NODE_ENV` | `main.ts:86` | string | — | — | safe | exact `production` | `production` (unit l.29) | — | — |
| `FLEET_CHATGPT_ADAPTER_AUDIT_LOG` | `main.ts:121-126` | path | unset | no | safe | Created with `fs.openSync(file,"a",0o600)`. Lines pass through `redactDetail` | `/var/log/automaton-fleet-chatgpt-adapter/audit.jsonl` (unit l.32) | Audit JSONL | — |
| `LISTEN_FDS`, `LISTEN_PID` | `main.ts:162` | systemd socket activation | — | yes in production | safe | Exactly `LISTEN_FDS === "1"` and `LISTEN_PID === String(process.pid)` → listen on fd 3. Otherwise a test `socketPath` is needed, else `no listener: expected a systemd socket (LISTEN_FDS=1) or an explicit socket path` | set by `automaton-fleet-chatgpt-adapter.socket` (`ListenStream=/run/automaton-fleet-chatgpt/adapter.sock`, `SocketUser=automaton-fleet-chatgpt-adapter`, `SocketGroup=automaton-fleet-chatgpt-tunnel`, `SocketMode=0660`) | Private Unix socket, no TCP | — |
| Forbidden env (`ADAPTER_FORBIDDEN_ENV`) | `main.ts:38-44,87` | — | — | must be absent | — | `OPERATOR_FORBIDDEN_ENV` + `FLEET_OPERATOR_DATABASE_URL`, `CONTROL_PLANE_API_KEY`, `OPENAI_ADMIN_KEY`, `OPENAI_API_KEY` → `<K> present (the ChatGPT adapter must hold no other credential)` | none | Startup refusal | — |
| Unreadable files (`ADAPTER_UNREADABLE_FILES`) | `main.ts:45-55,88-95` | — | — | must be unreadable | — | `admin.env`, `service.env`, `operator.env`, `tls/fleet.key`, `legacy-env-fleet.bak`, `chatgpt-tunnel/openai-api-key`, `chatgpt-tunnel/adapter-token`, `/run/credentials/automaton-fleet.service/service.env`, `/var/lib/automaton-fleet-witness/fleet-credentials.json` → `secret <f> is readable by this process` | all unreadable | Startup refusal | — |

### 8.2 `chatgpt-adapter.json` fields (`parseAdapterConfig`, `chatgpt-adapter/config.ts:44-67`; exact key set required)

The file is root:automaton-fleet-chatgpt-adapter 0640. `scripts/fleet-chatgpt-setup.sh configure <principalId> --apply` writes it (l.116-120).

| Field | Validation (exact) | Production value | Effect |
|---|---|---|---|
| `version` | `=== 1` | `1` | — |
| `principalId` | `PRINCIPAL_RE` | `op_01M3B18TXVP33S6NQC909DXD57` (bridge-chatgpt) | Signing principal; `identityProblems` requires signed whoami to return this id, kind `bridge_chatgpt`, scopes exactly `["ops.read.agents","ops.read.status"]` (`main.ts:37,100-108`), re-verified at most every `IDENTITY_TTL_MS = 300000` ms |
| `keyFile` | absolute and normalized | `/var/lib/automaton-fleet-chatgpt-adapter/bridge-chatgpt.key` (setup script l.37). The key is [SECRET REDACTED — PURPOSE: Ed25519 signing key for bridge-chatgpt] | Operator request signing key |
| `keyId` | `^[0-9a-f]{32}$` | `fe22d91c08f0a0676b4c155ce0d618d3` (expires 2026-10-25T01:00:57.682Z) | — |
| `operator.port` | integer 1024..65535 | `8788` (setup script l.120) | Operator API loopback port (direct client) |
| `operator.user` | `^[a-z_][a-z0-9_-]{0,31}$`; must resolve to a uid (`unknown Operator API user …`) | `automaton-fleet-operator-api` | The listener socket must belong to this uid (checked by the direct client) |
| `tunnelTokenSha256` | `^[0-9a-f]{64}$` | <!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md --> (SHA-256 of `chatgpt-tunnel/adapter-token`; the token itself is [SECRET REDACTED — PURPOSE: static `X-Fleet-Adapter-Token` header from tunnel client to adapter]) | Adapter authenticates the tunnel client |
| `limits.callsPerMinute` | integer 1..600 | `30` | Token-bucket refill = `callsPerMinute/60` per second |
| `limits.burst` | integer 1..100 | `10` | Bucket capacity |
| `limits.maxQueued` | integer 0..32 | `4` | MCP queue bound |

### 8.3 Tunnel (`automaton-fleet-chatgpt-tunnel.service` + `.path`)

The tunnel runs the pinned OpenAI `tunnel-client-runtime` v0.0.14 binary. No fleet code
reads these values.

| Name | Where | Type | Required? | Safe/secret | Validation | Production value | Effect |
|---|---|---|---|---|---|---|---|
| `CONTROL_PLANE_TUNNEL_ID` | `/etc/automaton-fleet/chatgpt-tunnel/tunnel.env` via `EnvironmentFile=` (unit l.32; format comment l.31 `tunnel_<32 hex>`) | string | yes (`ConditionPathExists=…/tunnel.env`, l.22; `fleet-chatgpt-tunnel-key.sh:96` refuses without it) | safe (public identifier) | No local validation. OpenAI answers 404 for a wrong id (key script `classify_log`) | `tunnel_6ab5cd2c7b088191abe137e56b5f35e4` | Selects the tunnel on OpenAI's control plane |
| credential `openai-api-key` | `LoadCredential=openai-api-key:/etc/automaton-fleet/chatgpt-tunnel/openai-api-key` (l.33), passed as `--control-plane.api-key=file:%d/openai-api-key` | secret file | yes (`ConditionPathExists`, l.21; `.path` unit `PathExists=` starts the service when it appears) | **secret** | Written only by `fleet-chatgpt-tunnel-key.sh` (TTY-only, silent read). Paste hygiene: 20..4096 chars, `^[!-~]+$`. Accepted only when the tunnel logs `"tunnel metadata fetched"` within `WAIT_S=60`; 401/403/404 cause a rollback | [SECRET REDACTED — PURPOSE: OpenAI runtime API key (Tunnels Read + Use)]. **Not yet provided by the owner** (rules file: tunnel unit waiting on owner runtime key) | Authenticates the tunnel client to OpenAI |
| credential `adapter-token` | `LoadCredential=adapter-token:…/adapter-token` (l.34), sent as header `X-Fleet-Adapter-Token: file:%d/adapter-token` | secret file | yes | **secret** | The adapter compares its SHA-256 with `tunnelTokenSha256` | [SECRET REDACTED — PURPOSE: shared static token tunnel→adapter] | Adapter authentication |
| `HOME` | `Environment=HOME=/var/lib/automaton-fleet-chatgpt-tunnel` (l.35) | path | — | safe | — | as shown | State dir |
| CLI flags | `ExecStart` l.40-45 | — | — | safe | — | `--mcp.server-url=url=http://localhost/mcp,unix-socket=/run/automaton-fleet-chatgpt/adapter.sock`, `--health.unix-socket=/run/automaton-fleet-chatgpt-tunnel/health.sock`, `--log.format=json --log.level=info` | Forward target and health socket |

Script-embedded pins in `scripts/fleet-chatgpt-setup.sh` (l.38-41), which are constants, not
configuration: `TC_VERSION=v0.0.14`,
`TC_ZIP_SHA256=29d29cf860ada54e4d3c82c715f4fbfcff2abcdc2584c0fc26431308dfa2505b`,
`TC_BIN_SHA256=94ae9d0c024753d1b79669152e968eb5d0faaad1e04ccf6c37750d7a3e175c77`,
`TC_DIR=/opt/automaton-fleet/tunnel-client/$TC_VERSION`.

### 8.4 Adapter release pins (`/opt/automaton-fleet/chatgpt-adapter/pins.env`)

`scripts/fleet-deploy-chatgpt-adapter.sh install` writes this file (l.64-65), mode 0644.

| Key | Validation at write | Production value | Read by |
|---|---|---|---|
| `FLEET_CHATGPT_ADAPTER_COMMIT` | `^[0-9a-f]{40}$` (script l.19) | full SHA of `6691b4c…` <!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md --> | **No code reads it** (documentation/rollback record only) |
| `FLEET_CHATGPT_ADAPTER_BUILD_ID` | `^[0-9a-f]{64}$` (l.29) | `62336fee…` (CLAUDE.md; full value <!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->) | none |
| `FLEET_CHATGPT_ADAPTER_LOCKFILE_SHA256` | `^[0-9a-f]{64}$` | <!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md --> | none |

---

## 9. Dry run and root witness

| Name | Component (read at) | Type | Default | Required? | Safe/secret | Validation (exact) | Production value | Effect | Dangerous combinations |
|---|---|---|---|---|---|---|---|---|---|
| `FLEET_API_URL` (witness / dry-run child) | `root-witness.ts:205`; `dry-run/child.ts:99` | URL | the credential file's `apiUrl` | yes (one of the two) | safe | `validateServiceUrl` (`service/client.ts:93-105`): valid URL (`FLEET_API_URL is not a valid URL`), no userinfo (`FLEET_API_URL must not contain credentials`), https, or http only for host in `{127.0.0.1, localhost, [::1], ::1}` (`FLEET_API_URL must use https (plain http is allowed only on loopback)`). It is reduced to the origin | witness: `http://127.0.0.1:8787` (unit l.32) | Controller endpoint | — |
| `FLEET_CREDENTIALS_FILE` | `root-witness.ts:199`; `dry-run/child.ts:95`; `service/client.ts:154` | path | `~/.automaton/fleet-credentials.json` (`HOME` or `os.homedir()`) | yes (the file) | the path is safe; **the file is secret** | `readCredentialFile` (§1.3) | witness: `/var/lib/automaton-fleet-witness/fleet-credentials.json` (unit l.33). The file holds [SECRET REDACTED — PURPOSE: witness `fa1.` bearer token]. Witness not enrolled (CLAUDE.md), so the file is absent or unused <!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md --> | Agent identity | Forbidden in the Operator API environment. Agent shell assignment blocked (`command-safety.ts:82`) |
| `FLEET_WITNESS_INTERVAL_MS` | `dry-run/root-main.ts:45-46` | integer ms | 30000 | no | safe | `Math.min(60000, Math.max(10000, finite && >0 ? v : 30000))`, so it is clamped to **[10000, 60000]** | `30000` (unit l.35) | Heartbeat period | Agent shell assignment blocked (`command-safety.ts:96`) |
| `FLEET_DRY_RUN_INTERVAL_MS` | `dry-run/child-main.ts:16` | integer ms | 30000 | no | safe | `Number(v) \|\| 30000`: NaN or 0 give 30000. **Negative values are not rejected** (a negative `setTimeout` delay fires after about 1 ms) | n/a (runs only in the dry-run sandbox) | Heartbeat period | — |
| `FLEET_RUNTIME_ENV_FILE` | `root-witness.ts:109` | path | `/etc/automaton-fleet/runtime.env` | no | safe | read errors add `runtime env unreadable (…)` | `/etc/automaton-fleet/runtime.env` (unit l.34) | Pins + refused flags | — |
| `HOME` | `root-witness.ts:103-105`; `dry-run/child.ts:62-64` | path | `os.homedir()`, then `/` (witness) or `/root` (child) | — | safe | The witness refuses any `~/.automaton/wallet*` file. The child refuses `~/.automaton/wallet.json` | witness `/var/lib/automaton-fleet-witness` (unit l.31) | Wallet and credential lookup | — |
| Refused true flags | witness `REAL_PAYMENTS_ENABLED`, `REAL_REPLICATION_ENABLED`, `OWNER_SWEEP_ENABLED` (env **or** runtime.env) `root-witness.ts:66,128-130`; child the same three from env `child.ts:38,70` | — | — | must be false | — | `<K>=true` | false | `WitnessRefusedError` (exit 4) | — |
| Forbidden env | witness: `findPrivilegedEnv(env)` ∪ `DRY_RUN_FORBIDDEN_ENV`; child: `DRY_RUN_FORBIDDEN_ENV` = `FLEET_ADMIN_DATABASE_URL`, `FLEET_SERVICE_DATABASE_URL`, `FLEET_AGENT_DATABASE_URL`, `FLEET_CONTROLLER_DATABASE_URL`, `DATABASE_URL`, `REDIS_URL`, `PGPASSWORD`, `WALLET_PRIVATE_KEY`, `PRIVATE_KEY`, `CONWAY_API_KEY`, … (`child.ts:25-36`) | — | — | must be absent | — | `<K> present in the environment` | none | Refusal | — |
| `FLEET_RUNTIME_*` (witness) | `root-witness.ts:67,110-111,162-175` | §4 | — | **yes** | safe | complete release + installed tree `computeBuildIdentity(dir)` must equal the pins: `installed runtime build X differs from the pinned Y`, `installed runtime lockfile differs from the pinned release` | §4 values | Refusal | — |

---

## 10. Agent-side configuration (`src/index.ts`, `automaton-agent.service`)

The agent reads **only its own process environment** for fleet configuration, using
`loadFleetConfig()` (`src/fleet/config.ts:66-79`). The places that call it are
`src/index.ts:335`, `src/agent/policy-rules/index.ts:26`,
`src/agent/policy-rules/fleet.ts:109` and `src/agent/tools.ts:1879-1884`.

| Name | Component (read at) | Type | Default | Required? | Safe/secret | Validation (exact) | Production value | Effect | Dangerous combinations |
|---|---|---|---|---|---|---|---|---|---|
| `FLEET_MAX_AGENTS` | `config.ts:68` → `parseMaxAgents` `:41-50` | integer | **1** | no | safe | empty → 1; not `^\d+$` → 1; not a safe integer or outside `1..FLEET_HARD_MAX_AGENTS (50)` (`src/state/schema.ts:693`) → 1 | **not set** (runbook l.52, l.952: "Do not add FLEET_MAX_AGENTS to runtime.env"; the agent unit does not set it), so the agent-local value is **1** | Agent-local cap. `SharedFleetController.getStatus` uses `effectiveMaxAgents = Math.min(shared.maxAgents, config.maxAgents)` (`shared-controller.ts:224`) | **Latent effect:** with the default 1 and the root agent occupying one slot, the agent-local gate always computes HARVEST/`FLEET_CAP_REACHED`. Raising the registry cap to 2 (S9) does not let an agent pass its local gate unless its environment sets `FLEET_MAX_AGENTS≥2`, and CLAUDE.md lists that as safety-gated. This is fail-closed. Agent shell assignment blocked (`command-safety.ts:93`) |
| `FLEET_MODE` | `config.ts:69` → `parseMode` `:52-57` | enum | `DEVELOPMENT` | no | safe | upper-cased; must be one of `DEVELOPMENT\|EXPANSION\|HARVEST\|EMERGENCY` (`FLEET_STATES`), else DEVELOPMENT | not set, which means DEVELOPMENT | The local mode can only **tighten**: effective = `strictestMode(local, shared)` with strictness EMERGENCY 3 > DEVELOPMENT 2 > HARVEST 1 > EXPANSION 0 (`config.ts:82-87`; `shared-controller.ts:227`) | Agent-side replication needs `EXPANSION` both locally **and** in the registry |
| `MIN_AGENT_RESERVE_USD` | `config.ts:73-76` → `parseUsdToCents` `:59-64` | decimal USD | 10 (1000 cents) | no | safe | empty, non-finite or negative → 1000 cents; otherwise `Math.round(n*100)` | not set (1000 cents) | Parent credits floor before replication (`policy.ts:80-84`) | `0` removes the local financial floor (the registry still enforces its own gates). **Not** in the shell-guard assignment patterns |
| `REAL_REPLICATION_ENABLED`, `REAL_PAYMENTS_ENABLED`, `OWNER_SWEEP_ENABLED` | see §2 | | | | | | `false` (agent unit l.24-26) | | |
| `FLEET_API_URL` | `service/client.ts:156` (`FleetApiClient.fromEnv`); `src/fleet/shared.ts:49` (`activeFleetServiceUrl`) | URL | the credential file's `apiUrl` | yes for shared-fleet mode | safe | `validateServiceUrl` (§9) | agent unit `http://127.0.0.1:8787` (l.23). Remote children get `apiUrl` in their credential file (the public https URL) | Controller endpoint. If the URL or the credential is missing, `fromEnv` returns `null`, so replication is denied with `FLEET_REGISTRY_UNAVAILABLE` "fleet service (FLEET_API_URL + credential) not configured" (`shared.ts:133-135`) | Agent shell assignment blocked (`command-safety.ts:82`, `tools.ts:88`) |
| `FLEET_CREDENTIALS_FILE` | `service/client.ts:154` | path | `DEFAULT_CREDENTIALS_FILE = path.join(os.homedir() \|\| "/root", ".automaton", "fleet-credentials.json")` (`client.ts:39`) | yes (the file) | the path is safe; **the file is secret** | `readCredentialFile` | default. Children receive `/root/.automaton/fleet-credentials.json` (`src/replication/spawn.ts:43,567-572`, created with umask 077 and chmod 600) | Agent bearer credential (`fa1.` token) | Agent reads of `fleet-credentials.json` are blocked by the shell guard (`command-safety.ts:81`) |
| `HOME` | `src/index.ts:339` | path | `/root` | — | safe | — | agent unit `/home/automaton-agent` (l.22) | Manifest path `~/.automaton/fleet-runtime.json` for `verifyOwnRuntime` (a child refuses to start on mismatch, `index.ts:337-345`) | — |
| Privileged env (refusal) | `src/index.ts:56-65` using `secrets.ts:107-141` | — | — | must be absent for `--run` | — | Exact names: `DATABASE_URL`, `FLEET_CONTROLLER_DATABASE_URL`, `FLEET_AGENT_DATABASE_URL`, `FLEET_TEST_DATABASE_URL`, `REDIS_URL`, `PGPASSWORD`, `PGPASSFILE`, `PGSERVICEFILE`, `PGUSER`, `PGHOST`, `PGHOSTADDR`, `PGDATABASE`, `PGSERVICE`. Patterns: `/(^\|_)DATABASE_URL$/`, `/^PG[A-Z]+$/`, `/^OWNER_(WALLET\|PRIVATE\|KEY\|MNEMONIC\|SEED\|SECRET\|SIGN\|TOKEN\|PASS)/`, `/^FLEET_(CONTROLLER\|ADMIN\|SIGNING\|SERVICE)_/`, `/(^\|_)SIGNING_(KEY\|SECRET)$/`, `/(^\|_)PRIVATE_KEY$/`, `/(^\|_)(MNEMONIC\|SEED_PHRASE)$/`, `/(^\|_)ADMIN_(TOKEN\|KEY\|SECRET\|PASSWORD\|API_KEY)$/`. Allow-list: `OWNER_SWEEP_ENABLED`. With `--run`, the agent logs `Refusing to start: privileged fleet/owner secrets are present in the agent environment (<names>)…` and exits 1. Other commands scrub the variables | none | Secret isolation. Shell children get `agentChildEnv()` (`src/conway/client.ts:10,120`) | Note: `FLEET_SERVICE_EXPECTED_USER`, `FLEET_SERVICE_ENV_FILE` and `FLEET_SERVICE_ROLE` also match `^FLEET_(…\|SERVICE)_`, so an agent started with them refuses too. This is harmless because the agent unit does not set them |

### 10.1 Values the agent shell guard forbids assigning (`src/agent/policy-rules/command-safety.ts`)

An agent shell command matching any of the following is refused. These are exact regexes:

- l.79 `/\b(FLEET_RUNTIME_REPO|FLEET_RUNTIME_COMMIT|FLEET_PG_SCHEMA|DATABASE_URL)\s*=/`
- l.82 `/\b(FLEET_API_URL|FLEET_CREDENTIALS_FILE|FLEET_[A-Z_]*DATABASE_URL|FLEET_AGENT_ROLE)\s*=/`
- l.86 `/\/etc\/automaton-fleet|CREDENTIALS_DIRECTORY|\b(admin|service)\.env\b/`
- l.93 `/\b(FLEET_DRY_RUN_CHILD|FLEET_REMOTE_LISTEN_ENABLED|FLEET_PUBLIC_(HOSTNAME|LISTEN|URL)|FLEET_TLS_\w+|FLEET_ALLOWED_ORIGINS|REAL_(PAYMENTS|REPLICATION)_ENABLED|OWNER_SWEEP_ENABLED|FLEET_MAX_AGENTS)\s*=/`
- l.96 `/automaton-fleet-witness|\bFLEET_WITNESS_\w+\s*=|\bcapability_scope\b/i`
- l.98 `…|operator\.env\b|\bFLEET_OPERATOR_\w+\s*=|…` (Operator API surface)
- The same l.79/l.82 patterns are duplicated in `src/agent/tools.ts:85,88`.

`FLEET_MODE=` and `MIN_AGENT_RESERVE_USD=` are **not** in these lists. An agent-spawned
shell child could set them, but they affect only that child's own process and cannot
change the running agent's configuration.

---

## 11. Database-held configuration (not environment)

This is listed so that a rebuild does not look for these values in env files. They are
changed only through `fleet:admin` commands, and each change writes an audit event. The
database chapter has the full column semantics.

| Setting | Table.column (migration) | Default | CHECK | Production |
|---|---|---|---|---|
| Fleet cap | `fleet_state.max_agents` (`migrations.ts:35`) | 1 | `BETWEEN 1 AND 50` (`FLEET_PG_HARD_MAX_AGENTS = 50`, `migrations.ts:21`) | **2** (operator-approved S9) |
| Operating mode | `fleet_state.operating_mode` (`migrations.ts:36-37`) | `DEVELOPMENT` | one of the four modes | `DEVELOPMENT` |
| Registry replication switch | `fleet_state.replication_enabled` (`migrations.ts:287`) | false | — | false (runbook l.952-956) |
| Approved runtime | `fleet_state.runtime_repo/_commit/_build_id/_lockfile_sha256` (`migrations.ts:38-39,288-289`) | NULL | 40-hex / 64-hex | the §4 values |
| Lease/heartbeat timings | `reservation_ttl_s` 1800, `provisioning_ttl_s` 2700, `heartbeat_unresponsive_s` 120, `heartbeat_dead_s` 600 (`migrations.ts:290-293`) | as listed | as in migration | <!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md --> |
| Health/session timings | `health_challenge_interval_s` 60, `challenge_ttl_s` 60, `health_grace_s` 300, `max_challenge_failures` 3, `termination_grace_s` 480, `orphan_slot_hold_s` 259200, `max_open_orphans` 1, `session_ttl_s` 600 (`migrations-phase5.ts:47-54`) | as listed | as in migration | <!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md --> |
| Operator API kill switch | `fleet_operator_state.operator_api_enabled` (`migrations-phase8.ts:37`) | false | — | **true** (enabled at boot, rules file) |
| Operator request cap | `fleet_operator_state.request_cap` | 2 000 000 | `= OPERATOR_REQUEST_CAP` (`migrations-phase8.ts:31,40`) | 2 000 000 |
| Treasury policy | `fleet_treasury_policy` (`migrations-phase5.ts:889`) | — | — | <!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md --> |

---

## 12. Deployment script and firewall variables

### 12.1 Environment variables read by scripts

| Name | Script (line) | Default | Safe/secret | Effect |
|---|---|---|---|---|
| `FLEET_DB_NAME` | `fleet-os-setup.sh:44`; `fleet-db-setup.sh:24` | `automaton_fleet` | safe | Database name written into DSNs and passed as psql `:dbname` |
| `FLEET_DB_HOST` | `fleet-os-setup.sh:45` | `127.0.0.1` | safe | Host in generated `service.env` / `operator.env` DSNs |
| `FLEET_DB_PORT` | `fleet-os-setup.sh:46` | `5432` | safe | Port in generated DSNs |
| `FLEET_DB_OWNER` | `fleet-db-setup.sh:25` | `fleetadmin` | safe | psql `:owner` for `fleet-db-roles.sql` |
| `FLEET_NODE_BIN` | `fleet-os-setup.sh:47` | `$(sudo -u "$SUDO_USER" -i bash -c 'command -v node')` | safe | Source copied to `/opt/automaton-fleet/node/bin/node` |
| `FLEET_RUNTIME_ENV_FILE` | `fleet-deploy-release.sh:22` | `/etc/automaton-fleet/runtime.env` | safe | Source of the pins the release is built from |
| `FLEET_SSH_PORT` | `deploy/firewall/fleet-firewall.sh:16` | `22` | safe | `ufw allow <port>/tcp` |
| `SUDO_USER` | `fleet-os-setup.sh:40`; `fleet-deploy-release.sh:63`; `fleet-deploy-chatgpt-adapter.sh:50`; `fleet-verify-deployment.sh:54,104,153` | — (`:?` makes it required in deploy scripts) | safe | Operator identity (home dir, group membership, exposure checks) |
| `XDG_CACHE_HOME` | `fleet-deploy-release.sh:41`; `fleet-deploy-chatgpt-adapter.sh:31` | `$HOME/.cache` | safe | Stage dir `…/automaton-fleet/stage/<commit>` or `…/chatgpt-adapter-stage/<commit>` |
| `EUID` | all scripts | — | safe | Root checks |

`fleet-deploy-release.sh` also reads the four `FLEET_RUNTIME_*` keys from the runtime env
file (l.25-26) and refuses a non-https repo (l.31).

### 12.2 Keys written by scripts (generated configuration)

| File | Keys | Written by | Mode/owner |
|---|---|---|---|
| `/etc/automaton-fleet/admin.env` | `FLEET_ADMIN_DATABASE_URL` (migrated from `.env.fleet`'s first `FLEET_ADMIN_DATABASE_URL\|FLEET_CONTROLLER_DATABASE_URL\|DATABASE_URL`) | `fleet-os-setup.sh:98-100` | root:automaton-fleet-admin 0640 |
| `/etc/automaton-fleet/service.env` | `FLEET_SERVICE_DATABASE_URL`, `FLEET_AGENT_DATABASE_URL` (fresh hex passwords) | `fleet-os-setup.sh:109` | root:root 0600 |
| `/etc/automaton-fleet/operator.env` | `FLEET_OPERATOR_DATABASE_URL` (fresh 64-hex password) | `fleet-os-setup.sh:122` | root:automaton-fleet-operator-api 0640 |
| `/etc/automaton-fleet/runtime.env` | installed from the template / by hand; pins from `fleet-build-runtime.sh` | operator (`sudoedit`) | root:root 0644 |
| `/etc/automaton-fleet/chatgpt-adapter.json` | §8.2 fields | `fleet-chatgpt-setup.sh configure --apply` (l.116-120) | root:automaton-fleet-chatgpt-adapter 0640 |
| `/etc/automaton-fleet/chatgpt-tunnel/openai-api-key` | raw key | `fleet-chatgpt-tunnel-key.sh` | root 0600, dir root 0700 |
| `/opt/automaton-fleet/chatgpt-adapter/pins.env` | §8.4 | `fleet-deploy-chatgpt-adapter.sh install` | root 0644 |

`fleet-os-setup.sh:150-152` deletes `DATABASE_URL|FLEET_CONTROLLER_DATABASE_URL|FLEET_ADMIN_DATABASE_URL|REDIS_URL`
lines from the repository `.env.fleet` after migrating them.

### 12.3 systemd credential names (LoadCredential)

| Unit | Credential name | Source | Consumer validation |
|---|---|---|---|
| `automaton-fleet.service` | `service.env` | `/etc/automaton-fleet/service.env` (unit l.29) | `systemdCredentialProblems` (0440 allowed only here) |
| `automaton-fleet.service` (remote drop-in) | `tls.key` | `/etc/automaton-fleet/tls/fleet.key` (remote.conf l.18) | `systemdCredentialProblems` |
| `automaton-fleet.service` (remote drop-in) | `tls.crt` | `/etc/automaton-fleet/tls/fleet.crt` (l.19) | public. Must not be a secret credential path (`service/main.ts:106-112`) |
| `automaton-fleet-chatgpt-tunnel.service` | `openai-api-key`, `adapter-token` | `/etc/automaton-fleet/chatgpt-tunnel/…` (l.33-34) | consumed by the OpenAI binary, not fleet code |

`SYSTEMD_SECRET_CREDENTIALS` (`secret-files.ts:58-61`) = `{ "service.env": "/etc/automaton-fleet/service.env", "tls.key": "/etc/automaton-fleet/tls/fleet.key" }`.
These are the only names the 0440 exception accepts, and only in the unit `automaton-fleet.service`.

---

## 13. Test-only variables

| Name | Read at | Default | Effect |
|---|---|---|---|
| `FLEET_TEST_DATABASE_URL` | `src/__tests__/fleet/fleet-phase2.test.ts:82`; `fixtures/pg-reserve-worker.ts:10` | fallback chain `DATABASE_URL` → `.env.fleet` `DATABASE_URL` → `loadAdminEnv({}).env.FLEET_ADMIN_DATABASE_URL` → `""` (`fleet-phase2.test.ts:81-95`) | PostgreSQL for the phase-2 tests. It is privileged for agents (`secrets.ts:111`) |
| `DATABASE_URL` | `fleet-phase2.test.ts:83` | — | fallback |
| `PG_BIN` | `fixtures/ephemeral-pg.ts:33` | then `pg_config --bindir`, then `/usr/lib/postgresql/<highest>/bin` | Binaries for the ephemeral cluster |
| `FLEET_REPRO_TEST` | `fleet-phase3.test.ts:208` (`it.runIf(process.env.FLEET_REPRO_TEST === "1")`) | unset (skipped) | Enables a reproduction test |
| `FAKE_SSH_ARGV_FILE`, `FAKE_SSH_MODE`, `FAKE_SSH_TARGET_PORT` | `fixtures/fake-ssh.ts:28-33` | mode `ok` / baked values | Fake ssh behaviour for bridge tests |
| `HOME` | tests (4 reads) | — | Sandboxed homes |

---

## 14. Fail-closed behaviour (summary)

| Situation | Behaviour | Source |
|---|---|---|
| Malformed `FLEET_MAX_AGENTS` | 1 | `config.ts:41-50` |
| Unknown `FLEET_MODE` | DEVELOPMENT | `config.ts:52-57` |
| Any flag not exactly `true` | disabled | `config.ts:37-39` and per-component checks |
| `FLEET_OPERATOR_REQUIRE_TIMESYNC` anything but `false` | required | `operator/main.ts:160` |
| Missing, invalid or upstream runtime pin | agent: pin `null`, so children are refused (`FLEET_RUNTIME_UNVERIFIED`). Service: starts, but claims and activations are refused. Operator API and witness: refuse to start | `runtime.ts:83-86`; `service/main.ts:253`; `operator/main.ts:97`; `root-witness.ts:161-163` |
| Service release ≠ registry approval | service refuses to start | `service/main.ts:247-252` |
| Missing `FLEET_API_URL`/credential on an agent | shared fleet `null`, replication denied `FLEET_REGISTRY_UNAVAILABLE`, agent keeps running | `shared.ts:78-79,133-135`; `index.ts:360-363` |
| Non-loopback listen without remote + TLS | refused | `service/main.ts:80-84`; `operator/main.ts:44-45` (never allowed) |
| Remote on without TLS or hostname, or with a bad certificate | refused | `service/main.ts:164-168,213` |
| Secret file insecure or unreadable | `SecretFileError` → exit 1 | `secret-files.ts:130-152` |
| `service.env` credential outside the exact unit or path | refused | `secret-files.ts:205-262` |
| Admin credential visible to the service, Operator API, adapter, witness or agent | refused | §3, §6, §8, §9, §10 |
| Registry `fleet_state` missing | SQL `FLEET_REGISTRY_UNAVAILABLE` / `FLEET_CAP_EXCEEDED: fleet_state missing (fail closed)` | `migrations.ts:125,397` |

Places where the code **does not** fail closed (validation gaps):

1. `FLEET_REAPER_INTERVAL_MS` non-numeric gives a 1 ms reaper loop plus a permanently
   failing readiness reaper check (`service/main.ts:263`, `server.ts:295-298,381-384`).
2. `FLEET_SHUTDOWN_DRAIN_MS` non-numeric gives no drain.
3. `FLEET_DRY_RUN_INTERVAL_MS` negative gives an about-1 ms heartbeat loop in the dry-run child.
4. `FLEET_API_LISTEN` port `0` is accepted (ephemeral port).
5. `FLEET_OPERATOR_TIMESYNC_MARKER=""` gives a clock that is never ready. This one is
   fail-closed, but unexpected.
6. `FLEET_PUBLIC_PORT` is unvalidated (doctor only).

---

## 15. Dangerous-combinations matrix

"Refuses" means that process exits at startup.

| Change | Service | Operator API | Witness | Dry-run child | Agent | Doctor / verify |
|---|---|---|---|---|---|---|
| `REAL_REPLICATION_ENABLED=true` in `runtime.env` | replication endpoint opens (other gates still apply) | **refuses** | **refuses** | n/a (env only) | unaffected (reads its own env) | flag check FAIL |
| `REAL_REPLICATION_ENABLED=true` in the agent env + `FLEET_MODE=EXPANSION` + `FLEET_MAX_AGENTS≥2` | — | — | — | — | local gate may allow; the service still needs its flag, `replication_enabled`, EXPANSION in the registry, cap headroom and an approved runtime | — |
| `REAL_PAYMENTS_ENABLED=true` | not read | **refuses** | **refuses** | **refuses** | `fund_child` allowed by policy in non-DEVELOPMENT modes; `executeApprovedSpend` still needs a signer (none exists) | flag FAIL |
| `OWNER_SWEEP_ENABLED=true` | not read | **refuses** | **refuses** | **refuses** | warning only | flag FAIL |
| `FLEET_DRY_RUN_CHILD=true` in `runtime.env` | not read | **refuses** | not read | — | — | — |
| `FLEET_REMOTE_LISTEN_ENABLED=true` without the drop-in (no `CREDENTIALS_DIRECTORY` tls.key, no cert) | **refuses** | — | — | — | — | "HTTPS valid" item fails |
| `FLEET_REMOTE_LISTEN_ENABLED=true` + `FLEET_TLS_KEY_FILE` set | key must be strict 0600 and readable by the service; the verify script fails | — | — | — | — | — |
| `FLEET_REMOTE_LISTEN_ENABLED=true` without `FLEET_PUBLIC_LISTEN` | `FLEET_API_LISTEN` may bind non-loopback **over TLS**; there is no separate plain admin listener | — | — | — | — | — |
| `FLEET_PUBLIC_LISTEN` set while remote is false | **refuses** | — | — | — | — | — |
| `FLEET_ALLOWED_ORIGINS` with a non-https entry | **refuses** (even when remote is off) | — | — | — | — | — |
| `FLEET_ADMIN_DATABASE_URL` in `runtime.env` (non-secret file) | **refuses** | **refuses** | refused as privileged env only if exported into the process env; runtime.env keys other than pins/flags are not merged | — | — | doctor legacy/secret checks |
| `FLEET_SERVICE_ENV_FILE` set under systemd | strict 0600 path replaces the credential exception | — | — | — | — | — |
| Runtime pins changed in `runtime.env` without `approve-runtime` | **refuses** at restart (release mismatch) | **refuses** | **refuses** (tree mismatch) | — | — | runtime items FAIL |
| `approve-runtime` while leases are open or children living | SQL `FLEET_RUNTIME_IMMUTABLE` (`migrations.ts:779`) | — | — | — | — | — |
| `FLEET_REAPER_INTERVAL_MS=0` | reaper disabled; dead agents keep slots until manual `reap` | — | — | — | — | readiness warns |
| `FLEET_OPERATOR_REQUIRE_TIMESYNC=false` | — | readiness ignores the NTP marker (skew ≤ 5 s still checked) | — | — | — | — |
| Registry cap raised (`set-cap`) without the agent-side `FLEET_MAX_AGENTS` | — | — | — | — | agent-local cap stays `min(registry, 1)` = 1, so the local gate keeps denying | — |

---

## 16. DRIFT

1. **DRIFT: `.env.fleet` loading.** `FLEET.md` (after its configuration table) says "`.env.fleet`
   is **not** auto-loaded". That is true for the agent (`src/index.ts`). It is false for the
   admin CLI and the FleetController service, which read `<cwd>/.env.fleet` as their lowest
   layer (`secret-files.ts:310-313,341-345`) and warn when secrets come from it.
2. **DRIFT: `FLEET.md` §Configuration** lists only six variables and says the cap is
   "written per process" to `fleet_meta` (FLEET.md l.167). That describes the Phase 1
   SQLite registry (`src/fleet/registry.ts`, `controller.ts:58`). In production the cap is
   `fleet_state.max_agents` in PostgreSQL, set only with `fleet:admin set-cap`, and the
   agent's `FLEET_MAX_AGENTS` can only lower the *local* evaluation cap
   (`shared-controller.ts:224`).
3. **DRIFT: `secret-files.ts:10` header** lists `FLEET_API_LISTEN` as a `runtime.env` key.
   Production does put it there (runbook l.81), but the unit `Environment=FLEET_API_LISTEN=127.0.0.1:8787`
   (automaton-fleet.service l.39) takes precedence, because the process env wins over files.
   Editing it in `runtime.env` has **no effect** under systemd.
4. **DRIFT: `service/main.ts:22` header** gives `FLEET_PUBLIC_LISTEN` example `0.0.0.0:8443`.
   Production and `runtime.env.example:27` use `0.0.0.0:443`, which needs
   `CAP_NET_BIND_SERVICE` from the remote drop-in.
5. **DRIFT: `src/fleet/config.ts:11` header** says `OWNER_SWEEP_ENABLED` is a "no-op in
   Phase 1". The code confirms it is still a no-op in every phase: warning only, and a doctor
   FAIL when true.
6. **DRIFT: Claude bridge config source.** `bridge/mcp.ts:83` honours `FLEET_BRIDGE_CONFIG`,
   but `bridge/cli.ts:120` does not (only `--config`). No document mentions `FLEET_BRIDGE_CONFIG`.
7. **DRIFT: `deploy/etc/runtime.env.example`** omits `FLEET_TLS_KEY_FILE` on purpose, and
   also omits the service-read keys `FLEET_SERVICE_EXPECTED_USER`, `FLEET_AUDIT_LOG` and
   `FLEET_SHUTDOWN_DRAIN_MS` (all set in the unit), the doctor-read `FLEET_PUBLIC_PORT`, and
   the agent keys `FLEET_MAX_AGENTS`, `FLEET_MODE` and `MIN_AGENT_RESERVE_USD`. It lists
   `FLEET_DRY_RUN_CHILD=false`, which the service never reads (only the admin CLI and the
   Operator API read it).
8. **DRIFT: adapter release pins.** `pins.env` (`FLEET_CHATGPT_ADAPTER_*`) is described in the
   runbook (l.1217) as the adapter's pins, but no code verifies the running adapter against
   it. The adapter has no runtime-identity self-check comparable to the witness's
   `computeBuildIdentity` check.
9. **DRIFT (latent semantics): cap raise to 2.** Runbook l.952-956 says "This changes only
   the registry cap … Agent-side replication stays off through four independent switches".
   There is a fifth switch that the runbook does not list: any agent without `FLEET_MAX_AGENTS`
   computes an effective cap of 1 (`shared-controller.ts:224`) and cannot pass its local gate
   while it occupies the only local slot.

## 17. Variables referenced in docs/deploy but not read by code

| Name | Where referenced | Status |
|---|---|---|
| `FLEET_DB_HOST`, `FLEET_DB_NAME`, `FLEET_DB_OWNER`, `FLEET_DB_PORT`, `FLEET_NODE_BIN` | `scripts/fleet-os-setup.sh`, `scripts/fleet-db-setup.sh` | script-only (valid; no TypeScript reader) |
| `FLEET_SSH_PORT` | `deploy/firewall/fleet-firewall.sh:16` | script-only |
| `FLEET_CHATGPT_ADAPTER_COMMIT`, `_BUILD_ID`, `_LOCKFILE_SHA256` | written to `pins.env` by `fleet-deploy-chatgpt-adapter.sh:64` | **read by nothing** |
| `CONTROL_PLANE_TUNNEL_ID` | `tunnel.env`, tunnel unit l.31, runbook l.1228 | read only by the OpenAI tunnel binary |
| `OWNER_SWEEP` (bare, prose) | docs | not a variable |
| `NODE_ENV` in `automaton-fleet.service` and `automaton-fleet-witness.service` | units | not read by service or witness code (read only by the Operator API and the adapter) |

## 18. Variables read by code but undocumented (no mention in FLEET.md, docs/*.md, docs/design/*.md or deploy/)

| Name | Read at |
|---|---|
| `FLEET_ADMIN_ENV_FILE` | `secret-files.ts:308` |
| `FLEET_AGENT_ROLE`, `FLEET_SERVICE_ROLE`, `FLEET_OPERATOR_ROLE` | `store.ts:443-445`, `service/main.ts:221-222` |
| `FLEET_PUBLIC_PORT` | `doctor.ts:507` |
| `FLEET_DRY_RUN_INTERVAL_MS` | `dry-run/child-main.ts:16` |
| `FLEET_BRIDGE_CONFIG` | `bridge/mcp.ts:83` |
| `FLEET_TEST_DATABASE_URL` | tests only |
| `CONWAY_API_URL` (admin CLI use) | `postgres/cli.ts:86` |
| `XDG_RUNTIME_DIR` (bridge run dir) | `bridge/tunnel.ts:208` |
| `LISTEN_FDS` / `LISTEN_PID` | `chatgpt-adapter/main.ts:162` (systemd convention; documented only implicitly by the `.socket` unit) |

## 19. NOT IMPLEMENTED (configuration-related)

- **Owner sweeps:** `OWNER_SWEEP_ENABLED` has no implementation (`src/index.ts:374-376`).
- **Real payment execution:** `REAL_PAYMENTS_ENABLED=true` cannot execute anything, because
  no `ControllerSigner` implementation exists (`treasury/custody.ts:23-39`; `doctor.ts:552`).
- **Redis:** `REDIS_URL` appears only in refusal lists (`secrets.ts:112`,
  `secret-files.ts:71,364`, `dry-run/child.ts:31`). No fleet code connects to Redis.
- **Controller custody of agent wallet keys:** the doctor permanently reports "Agent wallet
  keys are still generated and held by the agent runtime" (`doctor.ts:450-451`).

<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->
