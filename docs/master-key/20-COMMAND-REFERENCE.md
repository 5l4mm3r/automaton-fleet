# PART 22 — Command Reference (every Fleet CLI command, package script, service entry point and deployment script)

Scope: this reference covers every command an operator, a deployment script or systemd
can run against the Automaton Fleet. It was compiled read-only from the repository at
`fleet-development` HEAD `efad214`. The production runtime is commit `4d6a0be`. No command
was executed to write it. Every row cites its dispatch site as `path:line`.

Conventions used in the tables:

| Column | Meaning |
|---|---|
| Command | The exact invocation as written by the operator. `pnpm fleet:admin X` = `tsx src/fleet/postgres/cli.ts X` (package.json:50). |
| Entry (file:line) | The `case` / branch that handles it. |
| Role | OS user and group, PostgreSQL login role, and host (dev VM / VPS). |
| R/W | **R** read-only, **W** writes the database or files, **X** creates external infrastructure. |
| Prod-safe? | **yes**: safe to run on production at any time. **gated**: needs explicit operator approval under CLAUDE.md. **no**: never run on production (dev or test only). |
| Side effects | `fleet_events.event_type` rows written (table `fleet.fleet_events`), other tables, files, processes. |

---

## 1. How commands are run on production (documented procedure)

The operator workflow is documented in `docs/fleet-production-runbook.md`, Stage 6
(lines 418–425) and Stages 9–21. It works like this:

- The operator's own login account on the VPS keeps a **tooling checkout** at
  `~/automaton-fleet` (runbook:421–422). The operator runs every `pnpm fleet:*` command
  from that checkout with `tsx`. The account must be a member of the group
  `automaton-fleet-admin` (created by `scripts/fleet-os-setup.sh:68-69`). That membership
  lets `loadAdminEnv()` (`src/fleet/secret-files.ts:307-319`) read
  `/etc/automaton-fleet/admin.env` (root:automaton-fleet-admin 0640), which holds
  `FLEET_ADMIN_DATABASE_URL`. That credential is `[SECRET REDACTED — PURPOSE: schema-owner
  (fleetadmin) PostgreSQL DSN]`. The runbook states this assumption at
  runbook:1416–1417.
- Load order for the admin CLI (`secret-files.ts:311-318`): the process environment wins,
  then `admin.env` (`FLEET_ADMIN_ENV_FILE` overrides the path, and the file is then
  required), then `runtime.env` (`FLEET_RUNTIME_ENV_FILE` overrides the path), then the
  legacy `./.env.fleet` in the current directory. Any warning is printed to stderr through
  `redactText`.
- The long-running services are **not** started by the operator. systemd runs each one as
  its own system user from the immutable release tree `/opt/automaton-fleet/current`
  (the ChatGPT adapter runs from `/opt/automaton-fleet/chatgpt-adapter/current`) with
  `/opt/automaton-fleet/node/bin/node dist/...` (see §7).
- Commands that need root (every `scripts/fleet-*.sh` step marked `sudo`) are run by the
  operator with `sudo` from the same checkout. They print a dry run by default and change
  things only with `--apply` (the exceptions are listed per script).
- The Claude bridge commands (`pnpm fleet:bridge`, `pnpm fleet:bridge-mcp`) run **only on
  the dev VM** as the operator's user. They reach the VPS through the restricted SSH
  account `fleet-op-tunnel` (runbook:1248–1262).

DRIFT: the coordinator's brief refers to a "systemd-run / sudo -u pattern" for running
commands on production. No such pattern exists anywhere in the repository. `grep -rn
systemd-run docs FLEET.md CLAUDE.md deploy scripts` finds nothing. The only `sudo -u` uses
are `sudo -u postgres pg_dump/psql/pg_restore` for backup and restore (runbook:242, 251,
405, 551, 569) and `runuser -u postgres` inside `fleet-db-setup.sh:75`. `pnpm fleet:*` is
documented as running directly under the operator's login account.

<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->
(Expected by the repo: the operator is in `automaton-fleet-admin`, and the tooling checkout
is at `4d6a0be` or a later tooling commit. Production facts from the operator's records:
runtime commit `4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790`, schema v8, cap 2, DEVELOPMENT.)

---

## 2. package.json scripts (package.json:40-70)

| Script | Expands to (package.json line) | Purpose | Role | R/W | Prod-safe? | Notes / side effects |
|---|---|---|---|---|---|---|
| `pnpm build` | `tsc && pnpm -r build` (41) | Compiles `src/` to `dist/`, including `dist/fleet/**`, which systemd runs | operator (never root; `fleet-deploy-release.sh:120`) | W (dist/) | yes (staging dir) | Used by the release scripts inside a fresh clone |
| `pnpm typecheck` | `tsc --noEmit` (44) | Type check | any | R | yes | — |
| `pnpm test` | `vitest run` (43) | Whole suite | dev | R (ephemeral PG) | **no** | Never exits because of a pre-existing hang in `src/__tests__/context-hardening.test.ts` ("buildContextMessages token budget"). CLAUDE.md "Testing policy" says not to run it |
| `pnpm test:ci` | `vitest run --reporter=verbose` (69) | Whole suite, verbose output | dev | R | **no** | Same hang as `test` |
| `pnpm test:coverage` | `vitest run --coverage` (45) | Coverage with v8. Thresholds in vitest.config.ts: statements 60, branches 50, functions 55, lines 60 | dev | R | **no** | Same hang |
| `pnpm test:security` | `vitest run -t 'security\|injection\|policy'` (46) | Tests selected by name | dev | R | dev only | — |
| `pnpm test:financial` | `vitest run -t 'financial\|spend\|treasury'` (47) | Tests selected by name | dev | R | dev only | — |
| `pnpm test:fleet` | `vitest run src/__tests__/fleet` (48) | All Fleet tests (26 files). PG tests start an ephemeral cluster (`src/__tests__/fleet/fixtures/ephemeral-pg.ts`, `PG_BIN`) | dev | W (temp PG, temp dirs) | dev only | Pre-existing: in `fleet-phase2`, "migrations are idempotent and safe to run concurrently" can fail with `tuple concurrently updated`, and the wipe fixture can deadlock |
| `pnpm test:deploy` | `vitest run src/__tests__/fleet/fleet-phase4.test.ts` (61) | Phase 4 deployment and secret-file tests | dev | temp | dev only | — |
| `pnpm test:phase5` | `…/fleet-phase5.test.ts` (62) | Lifecycle, treasury, schema v5 | dev | temp PG | dev only | — |
| `pnpm test:phase6` | `…/fleet-phase6.test.ts` (63) | Remote controller, dry run, schema v6 | dev | temp PG | dev only | — |
| `pnpm test:witness` | `…/fleet-witness.test.ts …/fleet-witness-imports.test.ts` (64) | Root witness (FLEET-KI-4) | dev | temp PG | dev only | — |
| `pnpm test:redact` | `…/redact.test.ts …/redact-sinks.test.ts` (65) | Canonical redactor | dev | R | dev only | — |
| `pnpm test:operator` | `…/operator-canonical.test.ts …/operator-pg.test.ts …/operator-server.test.ts` (66) | Operator API (Phase B) | dev | temp PG | dev only | — |
| `pnpm test:bridge` | `…/bridge-unit …/bridge-tunnel …/bridge-integration …/bridge-mcp` (67) | Claude bridge (Phase D); uses `fixtures/fake-ssh.ts` | dev | temp | dev only | — |
| `pnpm test:chatgpt` | `…/chatgpt-adapter …/chatgpt-adapter-imports …/chatgpt-tunnel-key` (68) | ChatGPT adapter (Phase C) and the tunnel-key helper | dev | temp | dev only | — |
| `pnpm fleet:migrate` | `tsx src/fleet/postgres/cli.ts migrate` (49) | See §3 `migrate` | operator + admin.env | W (DDL) | **gated** | — |
| `pnpm fleet:admin <cmd>` | `tsx src/fleet/postgres/cli.ts` (50) | Admin CLI dispatcher (§3, §4, §5) | operator + admin.env | per command | per command | — |
| `pnpm fleet:service` | `tsx src/fleet/service/main.ts` (51) | Runs FleetController in the foreground (development) | see §7.1 | W | **no** on production (systemd runs it as `automaton-fleet-service`) | Refuses the admin credential |
| `pnpm fleet:doctor` | `cli.ts doctor` (52) | Readiness report | operator + admin.env | R | yes | §3 |
| `pnpm fleet:audit-privileges` | `cli.ts audit-privileges` (53) | Effective-privilege audit | operator + admin.env | R | yes | §3 |
| `pnpm fleet:migrate-check` | `cli.ts migrate-check` (54) | Applies pending migrations in one transaction, then rolls back | operator + admin.env | R (rolled back) | yes | §3 |
| `pnpm fleet:verify-runtime` | `cli.ts verify-runtime` (55) | Compares the pinned runtime identity with the approved one | operator + admin.env | R | yes | §3 |
| `pnpm fleet:verify` | `cli.ts doctor --checklist` (56) | Operator checklist plus the SAFE FOR … levels | operator + admin.env | R | yes | §3 |
| `pnpm fleet:operator-keygen <file>` | `tsx src/fleet/operator/keygen.ts` (57) | Generates an Ed25519 operator key | bridge user on the bridge host | W (key file) | yes (on the bridge host) | §6 |
| `pnpm fleet:bridge …` | `tsx src/fleet/bridge/cli.ts` (58) | Claude bridge CLI | dev-VM operator | R (remote) / W (local config) | yes (read-only against prod) | §8 |
| `pnpm fleet:bridge-mcp` | `tsx src/fleet/bridge/mcp.ts` (59) | stdio MCP server for Claude | dev-VM operator | R | yes | §8.3 |
| `pnpm fleet:dry-run-child …` | `cli.ts dry-run-child` (60) | DRY_RUN_CHILD preflight, or a real run | operator + admin.env (+ CONWAY_API_KEY) | R / **X** | preflight yes; real run **gated (S10)** | §3 |

Not Fleet: `dev` (42) and `clean` (70).

---

## 3. `src/fleet/postgres/cli.ts` — admin CLI (registry commands)

Dispatch: `main(argv)` at `cli.ts:237`. The file runs only when `process.argv[1]` matches
`/fleet[\\/]postgres[\\/]cli\.(ts|js)$/` (`cli.ts:596-598`), and the process then exits with
the code `main` returns.

### 3.1 Dispatch order and global behaviour

The dispatcher checks in this order:

1. `build-identity` (`cli.ts:239-244`) needs **no credential** and runs before any env file
   is loaded.
2. `audit-scan` (`cli.ts:245-264`) needs **no credential**.
3. `loadAdminEnv()` (`cli.ts:265-276`). On failure, `doctor` still runs with
   `configError` and exits 1. Every other command prints the redacted error and exits
   **2**.
4. `doctor` (`cli.ts:279-293`) and `verify-runtime` (`cli.ts:294-306`) tolerate a
   missing store: `PgFleetStore.fromEnv` may return null.
5. `PgFleetStore.fromEnv(e)`. If it returns null, the CLI prints `FLEET_ADMIN_DATABASE_URL
   is not configured (environment, /etc/automaton-fleet/admin.env, or legacy .env.fleet).`
   and exits **2** (`cli.ts:307-311`).
6. `actor = "operator:" + os.userInfo().username` (`cli.ts:312`). This string is written to
   `fleet_events.actor` for every write.
7. Operator commands (the `OPERATOR_COMMANDS` set, `cli.ts:177-186`) go to
   `PgOperatorAdmin` (`cli.ts:313-328`). Output is JSON (2-space indent). Exit 0 on
   success; on error the CLI prints the redacted message and exits 1.
8. Treasury commands (the `TREASURY_COMMANDS` set, `treasury/cli.ts:29-34`) go to
   `PgTreasuryStore` (`cli.ts:329-344`). Output is JSON (2-space indent). Exit 0, or 1 on
   error.
9. The `switch (cmd)` at `cli.ts:346-587`. A thrown error prints the redacted message and
   exits 1 (`cli.ts:588-590`). Unknown commands print the usage line and exit **2**
   (`cli.ts:579-586`).

The DSN for the operator and treasury paths is `FLEET_ADMIN_DATABASE_URL ||
FLEET_CONTROLLER_DATABASE_URL || DATABASE_URL` (`cli.ts:315`, `cli.ts:331`). The schema
comes from `FLEET_PG_SCHEMA` (default `fleet`).

Exit-code summary for `cli.ts`:

| Code | Meaning |
|---|---|
| 0 | Success. For `doctor`: `replicationSafe` (default mode), or `deploymentOk` (`--deployment-only`), or `readiness.dryRun.safe` (`--checklist`). For `verify-runtime`: identity OK. For `migrate-check`: the resulting version equals `FLEET_PG_SCHEMA_VERSION` (8). For `audit-privileges`: no problems. For `health`: `ok`. For `audit-scan`: nothing detected. For `dry-run-child`: `ok` |
| 1 | Command failed, check failed, or `audit-scan` found matches |
| 2 | Usage error, or the admin env could not be loaded or configured (not for `doctor`), or `audit-scan` had no files or hit a file error |

Important: plain `pnpm fleet:doctor` returns `replicationSafe ? 0 : 1` (`cli.ts:289`).
While real replication is (deliberately) unsafe, it therefore **exits 1 on production even
when it prints `DEPLOYMENT: OK`**. Use `--deployment-only` when you want an exit code that
reflects deployment health alone.

### 3.2 Registry, lifecycle and deployment subcommands

Store methods are in `src/fleet/postgres/store.ts`. SQL functions are in
`src/fleet/postgres/migrations*.ts`.

| Command | Entry | Purpose | Role | R/W | Prod-safe? | Required args / flags | Side effects (events → `fleet_events`; files) | Output |
|---|---|---|---|---|---|---|---|---|
| `fleet:admin build-identity [dir]` | cli.ts:239 | Build ID and lockfile SHA-256 of a built tree (`computeBuildIdentity`, attestation.ts:112) | any user; no DB, no credential | R | yes | `dir` (default `.`) | none | one JSON line `{dir, buildId, lockfileSha256, …}`; exit 0 |
| `fleet:admin audit-scan <file…>` | cli.ts:245 | Count-only secret scan of audit and log files (`scanAuditFile`, redact-scan.ts:40). Refuses symlinks (realpath check), non-regular files, and files with more than one hard link | any user; no DB | R | yes | ≥1 file | none. Never prints matched text | one JSON report per file; exit 1 if anything is detected, 2 on usage or file error |
| `fleet:migrate` / `fleet:admin migrate` | cli.ts:440 | Applies every pending schema migration (v1…v8), then re-grants the agent, service and operator roles **if those roles exist** (store.ts:558-575). `assertAdminConnection` refuses any login that does not own schema `fleet` (store.ts:588-603) | operator; admin DSN = schema owner (`fleetadmin`) | **W (DDL)** | **gated** (CLAUDE.md: "applying database migrations to a live database") | none | Migration rows in `fleet_schema_migrations`; events `agent_role_granted`, `service_role_granted`, `operator_role_granted` (actor `"operator"`, store.ts:787, 810, 834) | text `Applied migrations: …` or `Schema up to date.`, then a `health()` JSON line; exit 0 |
| `fleet:migrate-check` / `fleet:admin migrate-check` | cli.ts:383 | Applies the pending migrations in ONE transaction and rolls back (store.ts:578-586) | operator; admin DSN (owner) | R (rolled back) | yes | none | none persisted | JSON `{currentVersion, resultingVersion, wouldApply, requiredVersion: 8, rolledBack: true}`; exit 0 iff resultingVersion = 8 |
| `fleet:admin health` | cli.ts:446 | `SELECT 1`, schema version = 8, `fleet_state` counters match `fleet_agents` (store.ts:626-670) | operator; admin DSN | R | yes | none | none | JSON `{ok, latencyMs, schemaVersion, countersConsistent, error?}`; exit 0 iff ok |
| `fleet:admin status` | cli.ts:451 | `getState()` plus `listAgents()` | operator; admin DSN | R | yes | none | none | JSON `{state, agents}` (pretty) |
| `fleet:admin set-cap <N>` | cli.ts:455 | Sets `fleet_state.max_agents`. Validation: `Number.isSafeInteger`, 1 ≤ N ≤ `FLEET_PG_HARD_MAX_AGENTS` (50) (store.ts:682-691) | operator; admin DSN | W | **gated** (fleet cap is a safety control) | N | `cap_set {previous, max}` | JSON state |
| `fleet:admin set-mode <MODE> [reason…]` | cli.ts:460 | Sets `fleet_state.operating_mode`. MODE is upper-cased and must be `DEVELOPMENT\|EXPANSION\|HARVEST\|EMERGENCY` (`isFleetState`) | operator; admin DSN | W | **gated** (operating mode) | MODE; reason default `"operator"` | `mode_set {previous, mode, reason}` | JSON state |
| `fleet:admin approve-runtime` | cli.ts:467 | Writes the approved runtime to `fleet_state.runtime_repo/_commit/_build_id/_lockfile_sha256`. Reads `FLEET_RUNTIME_REPO` and `FLEET_RUNTIME_COMMIT` (validated by `validateRuntimePin`), plus `FLEET_RUNTIME_BUILD_ID` and `FLEET_RUNTIME_LOCKFILE_SHA256` (`loadRuntimeBuild`; missing values throw with the message pointing to `scripts/fleet-build-runtime.sh`) | operator; admin DSN; env from runtime.env | W | **gated** (approved runtime identity) | env vars only | `runtime_approved {previous, runtime, build}` | JSON state |
| `fleet:admin clear-runtime` | cli.ts:566 | Sets every runtime column to NULL, which blocks all replication and activation | operator; admin DSN | W | **gated** | none | `runtime_approved {previous, runtime: null, build: null}` | JSON state |
| `fleet:admin set-replication on\|off` | cli.ts:480 | DB-level replication switch `fleet_state.replication_enabled` (store.ts:721-727) | operator; admin DSN | W | **gated** (`on` is never allowed without approval; CLAUDE.md "Never enable real replication") | `on` or `off` | `replication_switch_set {previous, enabled}` | JSON state |
| `fleet:admin set-timeouts k=S…` | cli.ts:487 | Keys: `reservation`→reservationTtlS, `provisioning`→provisioningTtlS, `unresponsive`→heartbeatUnresponsiveS, `dead`→heartbeatDeadS, `parent-quiet`→parentReportQuietS. Values must match `/^\d+$/`; each must be a safe integer ≥ 1; the DB CHECK requires dead > unresponsive | operator; admin DSN | W | gated (lifecycle policy) | ≥0 `k=S` pairs (none = rewrite the current values) | `timeouts_set {…all five}` | JSON timeouts |
| `fleet:admin lifecycle-policy [k=S…]` | cli.ts:365 | No args: prints the policy. With args: keys `interval`→healthChallengeIntervalS, `challengeTtl`→challengeTtlS, `healthGrace`→healthGraceS, `maxFailures`→maxChallengeFailures, `terminationGrace`→terminationGraceS, `orphanHold`→orphanSlotHoldS, `maxOrphans`→maxOpenOrphans, `sessionTtl`→sessionTtlS; values `/^\d+$/` | operator; admin DSN | R / W | read yes; set gated | optional | set: `lifecycle_policy_set {…all eight}` (store.ts:1318) | JSON |
| `fleet:admin enroll-root <wallet> <name> [credFile]` | cli.ts:504 | Registers (or re-attaches) a root, subject to the cap, and issues its bearer token. The token is stored only as SHA-256 and written to the file, never to stdout | operator; admin DSN | W + file | **gated** (creates a living agent; uses a slot) | wallet, name; file default `~/.automaton/fleet-credentials.json` | `root_registered` (or `registration_denied` at cap), `credential_issued`; revokes existing sessions. File: 0600, dir 0700, tmp+rename (`writeCredentialFile`, cli.ts:97-103), contents `{agentId, token, apiUrl}` with `apiUrl = FLEET_API_URL` or null | JSON `{agentId, created, credentialFile}` |
| `fleet:admin enroll-witness-root <name> <credFile>` | cli.ts:515 → `enrollWitnessRoot` cli.ts:140-173 | FLEET-KI-4 witness root: keyless wallet address derived from 32 random bytes, `capabilityScope: 'witness'`, runtime commit = the registry-approved commit, custody must be frozen with `dailyLimitCents === 0`. Refuses an existing file (lstat), refuses if no runtime is approved | operator; admin DSN | W + file | **gated** (runbook stage 21b) | name, file | `root_registered {capabilityScope:'witness'}`, `credential_issued`; on failure `markDead` → `agent_died`, `slot_released`. File: exclusive create via hard link (`writeCredentialFileExclusive`, cli.ts:109-122) 0600; `apiUrl` default `http://127.0.0.1:8787` | JSON `{agentId, role, capabilityScope, runtimeCommit, custodyFrozen, credentialFile}` |
| `fleet:admin rotate-credential <agentId> [credFile]` | cli.ts:522 | Issues a new token for a living agent; revokes every open session (store.ts:970-978) | operator; admin DSN | W + file | gated | agentId | `credential_issued`; `fleet_agent_sessions.revoked_at` set; file as for enroll-root (overwrites via rename) | JSON `{agentId, credentialFile}` |
| `fleet:admin grant-agent-role [role]` | cli.ts:531 | REVOKE ALL, then GRANT USAGE on the schema and EXECUTE on `AGENT_API_FUNCTIONS` (store.ts:772-788) | operator; admin DSN (owner) | W (privileges) | **gated** (PostgreSQL permissions) | role default `fleet_agent` (`FLEET_AGENT_ROLE`) | `agent_role_granted` | text |
| `fleet:admin grant-service-role [role]` | cli.ts:536 | REVOKE ALL, then USAGE, SELECT on `SERVICE_READ_TABLES`, EXECUTE on `SERVICE_API_FUNCTIONS` (store.ts:793-814) | same | W | **gated** | default `fleet_service` | `service_role_granted` | text |
| `fleet:admin grant-operator-role [role]` | cli.ts:541 | REVOKE ALL, then USAGE and EXECUTE on `OPERATOR_API_FUNCTIONS` only (store.ts:819-836) | same | W | **gated** | default `fleet_operator` | `operator_role_granted` | text |
| `fleet:audit-privileges` / `fleet:admin audit-privileges` | cli.ts:546 | Effective-privilege audit of the agent, service and operator roles (privileges.ts) | operator; admin DSN | R | yes | none | none | JSON result on stdout; `PASS …` / `FAIL: N privilege problem(s)` on stderr; exit 0 iff ok. Operator roles absent → "operator roles: not provisioned" |
| `fleet:doctor [--json] [--deployment-only]` | cli.ts:279 | Full readiness report (`runDoctor`, doctor.ts). Also GETs `${FLEET_PUBLIC_URL}/healthz` (5 s timeout, doctor.ts:512) and reads the operator overview (store.ts:846) | operator; admin DSN (runs with configError if absent) | R (+1 outbound HTTPS GET) | yes | none | none | text (`formatDoctorReport`) or `--json`; exit per §3.1 |
| `fleet:verify [--json]` = `doctor --checklist` | cli.ts:283 | Operator checklist and `SAFE FOR DRY RUN / REAL REPLICATION / REAL PAYMENTS` | same | R | yes | — | none | text (`formatChecklist`) or JSON `{checklist, readiness}`; exit 0 iff `readiness.dryRun.safe` |
| `fleet:verify-runtime [dir] [--json]` | cli.ts:294 | `verifyRuntimeIdentity`: env pins against the registry approval and against the tree identity of `dir` (runtime-verify.ts) | operator; admin DSN optional | R | yes | optional dir (first non-`--` arg) | none | text (`formatRuntimeIdentity`) or JSON; exit 0 iff ok |
| `fleet:admin reap` | cli.ts:558 | One reaper pass: `svc_reap(actor)` → `fleet_reap` (migrations-phase5.ts:781) | operator; admin DSN | W | yes (idempotent; the service runs the same pass every 15 s) | none | possible `reaper_resumed`, `slot_released` / `provisioning_failed` (lease expiry via `fleet_release`), `agent_unresponsive`, `agent_died`, `agent_terminating`, `sandbox_termination_requested`, `orphan_slot_released` | JSON `{expired, unresponsive, dead, graceFrom}` |
| `fleet:admin reservations [all]` | cli.ts:562 | Lists reservation leases (open only unless `all`) | operator | R | yes | — | none | JSON |
| `fleet:admin release <agentId> [reason…]` | cli.ts:571 | reserved/provisioning → failed: `svc_release` → `fleet_release(…,'released')` (migrations.ts:440, 1011) | operator | W | gated (changes a slot) | agentId; reason default `"operator release"` | `slot_released` (plus `provisioning_failed` when it was provisioning) | text `released` / `not releasable` (exit 0 either way) |
| `fleet:admin mark-dead <agentId> [reason…]` | cli.ts:575 | `svc_mark_dead` → `fleet_mark_dead` (migrations.ts:816). Revokes the credential and sessions; the row is kept | operator | W | **gated** (kills an agent) | agentId; reason default `"operator"` | `agent_died`, `slot_released`, `sandbox_termination_requested` (when a sandbox is known) | text `marked dead` / `not living` |
| `fleet:admin quarantine <agentId> [reason…]` | cli.ts:347 | `fleet_begin_termination(…,'quarantine')` (migrations-phase5.ts:480). No sandbox → dead now. Otherwise → `terminating` and a `fleet_sandbox_terminations` row | operator | W | **gated** | agentId; reason default `"operator quarantine"` | `agent_terminating`, `sandbox_termination_requested` (or `agent_died` + `slot_released`), then `agent_quarantined {reason, result}` (store.ts:1255) | JSON `{agentId, result: 'terminating'\|'dead'\|null}` |
| `fleet:admin resolve-orphan <agentId> <resolution…>` | cli.ts:352 | Closes an open `fleet_orphans` row; orphaned → dead; termination → terminated; provisioning cleanup → terminated (store.ts:1260-1285) | operator | W | gated (only after external cleanup is confirmed) | both | `orphan_resolved {resolution}` | JSON `{resolved: bool}` |
| `fleet:admin orphans [all]` | cli.ts:357 | Lists orphans (open unless `all`) | operator | R | yes | — | none | JSON |
| `fleet:admin provisioning [cleanup]` | cli.ts:361 | Lists provisioning rows (`cleanup` = only those that need cleanup) | operator | R | yes | — | none | JSON |
| `fleet:admin terminations` | cli.ts:554 | Sandbox termination queue | operator | R | yes | — | none | JSON |
| `fleet:admin reconcile <key> found <sandboxId>\|absent\|unknown` | cli.ts:388 | `svc_provision_reconcile` (migrations-phase6.ts:262). Refusals throw `FleetBypassError` with codes `FLEET_BAD_REQUEST`, `FLEET_NOT_FOUND`, `FLEET_SANDBOX_MISMATCH`, `FLEET_SANDBOX_KNOWN`, `FLEET_PROVISIONING_IN_FLIGHT` | operator | W | gated | key, outcome (+ sandboxId for found) | `provisioning_reconciled`; `found` on a dead agent → `sandbox_termination_requested`; `absent` on an orphan → `slot_released` | JSON |
| `fleet:admin reconcile-provisioning` | cli.ts:396 | For every uncertain provisioning row: without `CONWAY_API_KEY`, lists it; with the key, looks the sandbox up by name (`findSandboxByName`, replication/spawn.ts) and reconciles it | operator (+ optional `CONWAY_API_KEY`, `CONWAY_API_URL` default `https://api.conway.tech`, cli.ts:83-87) | R, or W + outbound Conway API | list mode yes; lookup mode gated | — | as for `reconcile`, per row | JSON array |
| `fleet:dry-run-child --root <id> --api-url <https>` (preflight) | cli.ts:417-432 | `dryRunPreflight` (dry-run/operator.ts:83). Checks: REAL_PAYMENTS/OWNER_SWEEP/REAL_REPLICATION all false; URL https and not loopback; `GET <origin>/healthz` OK; cap == 2; a free slot; no open orphans, stale reservations, uncertain provisioning or existing dry-run child; runtime approved and equal to the pinned release; root is a living root | operator; admin DSN | R (+ outbound GET /healthz) | yes | `--root`; `--api-url` (default `FLEET_PUBLIC_URL`); optional `--name` | none | JSON `{mode:"preflight-only …", ok, problems, facts}`; exit 0 iff ok; step logs on stderr are redacted |
| `FLEET_DRY_RUN_CHILD=true CONWAY_API_KEY=… fleet:dry-run-child --root <id> --api-url <https> --confirm-real-sandbox` | cli.ts:434-438 → `performDryRunChild` (dry-run/operator.ts:154) | Creates **one real paid Conway sandbox**. Steps: reserve (`reserveDryRunSlot` → `fleet_reserve_dry_run`), claim, sandbox, install+attest, activate, credential, write `CHILD_RUNTIME_MANIFEST`, start `dist/fleet/dry-run/child-main.js`, heartbeat+challenge, zero-authority check | operator; admin DSN; `CONWAY_API_KEY` [SECRET REDACTED — PURPOSE: Conway sandbox API] | **X** | **gated — STOP S10** (runbook:1055-1063) | `--confirm-real-sandbox`; env `FLEET_DRY_RUN_CHILD=true` (otherwise throws, operator.ts:163) | `slot_reserved`, claim/activation events, `credential_issued`; on failure `runtime_verification_failed` or `agent_quarantined`; one remote sandbox | JSON report; exit 0 iff ok |

### 3.3 Operator principal lifecycle (schema v8) — `runOperatorCommand` (cli.ts:189-235) → `PgOperatorAdmin` (src/fleet/operator/admin.ts)

Every call runs `requireActor`: the actor must match `/^operator:[A-Za-z0-9_.-]{1,64}$/`
(admin.ts:86-88). Positional arguments are the args that do not start with `--` and do not
follow a `--flag` (cli.ts:190). A reason is the remaining positionals joined by spaces,
default `"operator decision"` (cli.ts:196). Every mutating call bumps
`fleet_operator_state.generation`, which invalidates the Operator API's cached key
material.

| Command | Entry | Purpose | Validation | R/W | Prod-safe? | Side effects |
|---|---|---|---|---|---|---|
| `fleet:admin operator-enroll <name> <bridge_claude\|bridge_chatgpt> --scopes a,b --public-key <b64url> --expires-days N` | cli.ts:198 → admin.ts:90 | New principal `op_<ULID>` and its first key | kind ∈ `OPERATOR_KINDS`; scopes non-empty ⊆ `OPERATOR_SCOPES` (`ops.read.status`, `ops.read.agents`, `ops.read.events`); `--expires-days` integer 1..90; public key `/^[A-Za-z0-9_-]{43}$/` and canonical 32 raw bytes; `keyId = keyIdOf(raw)` | W | **gated** (operator principals and keys) | INSERT `fleet_operator_principals` and `fleet_operator_keys`; generation+1; event `operator_principal_enrolled {principalId, kind, keyId, expiresAt}`. Output JSON `{principalId, name, kind, scopes, keyId, expiresAt, generation}` |
| `fleet:admin operator-add-key <principalId> --public-key <b64url> --expires-days N` | cli.ts:205 → admin.ts:118 | Adds a key (rotation step 1; `fleet:bridge key rotate-prepare` prints this command, keys.ts:63) | as above | W | **gated** | INSERT key; generation+1; `operator_key_added` |
| `fleet:admin operator-revoke-key <keyId> <reason…>` | cli.ts:210 → admin.ts:136 | Revokes one key | must be active (otherwise `no active key …`) | W | **gated** | `revoked_at/by/reason` (reason capped at 200 chars); generation+1; `operator_key_revoked` |
| `fleet:admin operator-revoke <principalId> <reason…>` | cli.ts:213 → admin.ts:150 | Revokes a principal and all of its keys | must be active | W | **gated** | `operator_principal_revoked {principalId, keys}` |
| `fleet:admin operator-revoke-all <reason…>` | cli.ts:216 → admin.ts:169 | **Emergency**: revokes every principal and key AND sets `operator_api_enabled=false` in one transaction | — | W | **gated** (kill switch) | `operator_revoke_all {principals, keys}` |
| `fleet:admin operator-api enable\|disable <reason…>` | cli.ts:218 → admin.ts:187 | Operator API kill switch (`fleet_operator_state.operator_api_enabled`) | mode must be `enable` or `disable` | W | **gated** (kill switch) | generation+1; `operator_api_enabled_set {enabled, generation, reason}` |
| `fleet:admin operator-list` | cli.ts:223 → admin.ts:198 | State plus principals with key metadata (never the public-key bytes) | — | R | yes | none |
| `fleet:admin operator-archive --before <ISO> --out <new file> [--max-rows N]` | cli.ts:225 → admin.ts:227 | Audited archival of the oldest `fleet_operator_requests` rows | `--before` parses and is ≥ 60 s in the past; `--max-rows` 1..`OPERATOR_ARCHIVE_MAX_ROWS` (100 000); the output directory must pass `requirePrivateDirectory` (real directory, no symlink, owned by the caller, not group- or world-writable) | W (**DELETE** of audit rows) + file | **gated** (runbook:1159-1165: "It needs its own approval") | Export file created 0600 with O_EXCL\|O_NOFOLLOW and fsynced, then re-verified (mode, owner, nlink 1, size, line count, SHA-256). Then `fleet_operator_archive_requests` re-derives the digest and deletes the rows; `request_count` is decremented; event `operator_requests_archived {before, rows, remaining, exportSha256}` (migrations-phase8.ts:307). On failure: `operator_requests_archive_failed {stage, rows, before}` and no rows deleted |

### 3.4 Treasury commands — `src/fleet/treasury/cli.ts` (dispatched through `fleet:admin`, cli.ts:329)

"Nothing here moves money" (treasury/cli.ts:3). The integer parser `int()` requires
`/^\d+$/` (treasury/cli.ts:38-41). `kv()` parses `name=value` pairs with
`/^([A-Za-z]+)=(.*)$/` (43-52). DAY = 86 400 000 ms. The DB-side
`fleet_require_operator_approver` refuses approvals from operator principals
(migrations-phase8.ts:312).

| Command | Entry (treasury/cli.ts) | Store method (treasury/store.ts) | R/W | Prod-safe? | Events written |
|---|---|---|---|---|---|
| `treasury-policy [k=v…]` (keys: `runwayDays contingencyPct minContingencyCents matureFleetRate maxSweepRate reserveTargetMonths maturityAgeDays treasuryAddress ownerWithdrawalAddress`; unknown key throws) | 56 | getPolicy (121) / setPolicy (137) | R / W | read yes; set **gated** (economic policy = architecture change) | `treasury_policy_set` |
| `treasury-position` | 68 | treasuryPosition (404) | R | yes | none |
| `treasury-record <kind> <cents> [agentId]` | 70 | recordTreasury (381): INSERT `fleet_treasury_ledger` | W | gated | none written by the TS path |
| `ledger <agentId> <kind> <cents> [reference]` | 73 | recordAgentLedger (159): INSERT `fleet_agent_ledger` | W | gated | none by the TS path |
| `balance <agentId> <cents>` | 76 | recordBalance (170): INSERT `fleet_balance_observations` source `operator` | W | gated | none |
| `obligation <agentId> <cents> <dueInDays> <description…>` | 79 | addObligation (177) | W | gated | `obligation_approved` |
| `capital-list [agentId]` | 86 | listAllocations (192) | R | yes | none |
| `capital-approve <allocationId> <cents> <days> <reason…> [--override]` | 88 | approveAllocation (218) | W | **gated** | `capital_approved {override}` |
| `capital-reject <allocationId> <reason…>` | 99 | rejectAllocation (245) | W | gated | `capital_rejected` |
| `capital-change <allocationId> [cents=N] [expiryDays=N] <reason…>` | 102 | changeAllocation (257) | W | gated | `capital_changed` |
| `capital-complete <allocationId> <actualReturnCents>` | 115 | completeAllocation (287) | W | gated | ledger `allocation_returned`; `capital_completed` |
| `sweep-reduce <agentId> <pct 0..1> <days> <reason…>` | 118 | reduceSweep (319) | W | **gated** (sweep rates) | `sweep_reduced` |
| `sweep-plan <agentId> [cashCents]` | 127 | planSweep (521): INSERT `fleet_sweep_plans` (plan only) | W | gated | `sweep_planned {executed:false}` |
| `spending-freeze <agentId> <reason…>` / `spending-unfreeze <agentId> <reason…>` | 129 | freezeSpending (335) | W | gated | `spending_frozen` / `spending_unfrozen` |
| `spending-limit <agentId> <cents>` | 133 | setDailySpendLimit (351) | W | gated | `spend_limit_set` |
| `custody-transfer <fromAgentId> <treasury\|agentId> <cents> <policy> <reason…>` (policy ∈ `quarantine_recovery death_recovery rebalance sweep`) | 136 | planCustodyTransfer (359): INSERT `fleet_custody_transfers` | W (plan only; `executed:false`) | **gated** | `custody_transfer_planned` |
| `owner-distribute <cents>` | 153 | planOwnerDistribution (426): INSERT `fleet_owner_distributions` + ledger row `status 'planned_not_executed'` | W (plan only) | **gated** (owner sweep) | `owner_distribution_planned` / `owner_distribution_rejected` |
| `profile <agentId>` | 155 | performanceProfile (479) | R | yes | none |
| `rescue-advice <agentId> [cashCents]` | 157 | rescueAdvice (537) | R | yes | none |

**NOT IMPLEMENTED:** execution of any money movement. `custody-transfer`,
`owner-distribute` and `sweep-plan` only record plans (`executed: false`,
`planned_not_executed`). No code path executes a transfer.

---

## 4. Usage-string drift inside cli.ts

DRIFT: `set-timeouts` accepts a fifth key, `parent-quiet=S` (cli.ts:493). The header
comment at cli.ts:13 lists only four keys, and so does the default usage line
(cli.ts:581-584). FLEET.md:450 does document `parent-quiet=`, but FLEET.md:296 does not.

DRIFT: the default usage line (cli.ts:580-585) leaves out `migrate-check`,
`verify-runtime`, `reconcile`, `reconcile-provisioning`, `dry-run-child`,
`enroll-witness-root`, `quarantine`, `resolve-orphan`, `orphans`, `provisioning`,
`lifecycle-policy`, `terminations` and every treasury command. All of them are handled by
the dispatcher.

DRIFT: `fleet-db-setup.sh:13` (comment) says `pnpm fleet:migrate  # v1 -> v3`. The code
migrates to `FLEET_PG_SCHEMA_VERSION` = 8. FLEET.md:265 likewise says "schema v2". Both
comments are historical.

---

## 5. Safety-gated commands (CLAUDE.md "Actions requiring explicit approval")

Never run these on production without explicit operator approval. CLAUDE.md lists the
safety controls; the table maps each one to the commands that change it.

| Control (CLAUDE.md) | Commands that change it |
|---|---|
| `fleet registry maxAgents` / `FLEET_MAX_AGENTS` / cap = 2 | `fleet:admin set-cap N` (event `cap_set`) |
| `fleet operating mode` | `fleet:admin set-mode MODE` (`mode_set`) |
| `approved runtime identity` | `fleet:admin approve-runtime`, `fleet:admin clear-runtime` (`runtime_approved`); `scripts/fleet-deploy-release.sh install` (switches `/opt/automaton-fleet/current`) |
| DB-level replication (in addition to `REAL_REPLICATION_ENABLED`) | `fleet:admin set-replication on\|off` (`replication_switch_set`) |
| `REAL_REPLICATION_ENABLED`, `REAL_PAYMENTS_ENABLED`, `OWNER_SWEEP_ENABLED`, `FLEET_DRY_RUN_CHILD`, `FLEET_REMOTE_LISTEN_ENABLED` | No CLI command sets them. They live in `/etc/automaton-fleet/runtime.env` (root-owned; editing it requires sudo and approval). `FLEET_DRY_RUN_CHILD=true` is set only in the environment of the single S10 `fleet:dry-run-child` command (runbook:1059-1065) |
| Economic policy (sweeps, treasury policy, capital, owner distributions) | `treasury-policy k=v`, `sweep-reduce`, `sweep-plan`, `capital-approve/reject/change/complete`, `custody-transfer`, `owner-distribute`, `spending-*` |
| Operator principals and keys | `operator-enroll`, `operator-add-key`, `operator-revoke-key`, `operator-revoke`, `operator-revoke-all` |
| Operator API kill switch | `operator-api enable\|disable`, `operator-revoke-all` (also disables) |
| PostgreSQL roles and permissions | `grant-agent-role`, `grant-service-role`, `grant-operator-role`, `fleet:migrate` (re-grants), `scripts/fleet-db-setup.sh --apply` (creates and alters roles, resets passwords) |
| Live migrations | `fleet:migrate` |
| Destructive DB actions | `operator-archive` (DELETEs audit rows), `mark-dead`, `quarantine`, `release`, `resolve-orphan` |
| Agents and credentials | `enroll-root`, `enroll-witness-root`, `rotate-credential` |
| Real infrastructure / money | `fleet:dry-run-child … --confirm-real-sandbox` (creates a paid sandbox; STOP S10); `reconcile-provisioning` with `CONWAY_API_KEY` (outbound provider calls) |
| Privileged host changes | every `sudo scripts/fleet-*.sh … --apply` / `install` / `configure`, and `deploy/firewall/fleet-firewall.sh --apply` |
| Secrets | `fleet-chatgpt-tunnel-key` (owner only, in the owner's own TTY; the AI must never run it) |

Always safe (read-only): `status`, `health`, `doctor`, `verify`, `verify-runtime`,
`audit-privileges`, `migrate-check`, `reservations`, `orphans`, `provisioning`,
`terminations`, `lifecycle-policy` (no args), `operator-list`, `treasury-position`,
`capital-list`, `profile`, `rescue-advice`, `treasury-policy` (no args),
`build-identity`, `audit-scan`, `dry-run-child` without `--confirm-real-sandbox`, every
read command of `fleet:bridge`, and `sudo scripts/fleet-verify-deployment.sh`. `reap` is
idempotent but writes lifecycle transitions.

---

## 6. `src/fleet/operator/keygen.ts` — `pnpm fleet:operator-keygen <private-key-file>`

| Item | Value |
|---|---|
| Entry | keygen.ts:65-78 (runs when argv[1] matches `/fleet[\\/]operator[\\/]keygen\.(ts\|js)$/`) |
| Where | **The bridge host**, as the bridge's own user. Never on the controller, never with a DB credential (keygen.ts:2-4). Production uses: bridge-claude on the dev VM; bridge-chatgpt on the VPS as `automaton-fleet-chatgpt-adapter` via `runuser -u automaton-fleet-chatgpt-adapter -- node …/dist/fleet/operator/keygen.js /var/lib/automaton-fleet-chatgpt-adapter/bridge-chatgpt.key` (fleet-chatgpt-setup.sh:91) |
| Validation | Parent directory passes `requirePrivateDirectory` (keygen.ts:21-27): lstat shows a directory that is not a symlink, `realpath === dir`, owned by the current uid, `mode & 0o022 == 0` |
| File write | `open(O_WRONLY\|O_CREAT\|O_EXCL\|O_NOFOLLOW, 0o600)`, PKCS#8 PEM Ed25519, `fchmod 0600` |
| Output | One JSON line `{publicKey (base64url of 32 raw bytes), keyId, privateKeyFile}`. The private key is never printed |
| Exit | 0 ok; 2 no argument; 1 any error (message on stderr) |
| DB / network | none |
| Prod-safe? | yes, when run as the bridge user on the bridge host. The public key is enrolled with `operator-enroll` or `operator-add-key` (gated) |

---

## 7. Service entry points (long-running, started by systemd)

### 7.1 FleetController — `src/fleet/service/main.ts`

| Item | Value |
|---|---|
| Production | `automaton-fleet.service`: `User=automaton-fleet-service`, `WorkingDirectory=/opt/automaton-fleet/current`, `ExecStart=/opt/automaton-fleet/node/bin/node dist/fleet/service/main.js`, `LoadCredential=service.env:/etc/automaton-fleet/service.env` (deploy/systemd/automaton-fleet.service:25-29). Remote drop-in adds `LoadCredential=tls.key:/etc/automaton-fleet/tls/fleet.key` and `tls.crt` (remote.conf.example:18-19) |
| Dev | `pnpm fleet:service` |
| Entry | main.ts:331-353: installs `uncaughtException`/`unhandledRejection` handlers (fatal log, exit 1) → `loadServiceEnv()` (failure: `startup_failed`, exit 1) → `startFleetServiceFromEnv(env, {installSignalHandlers:true})` (main.ts:193) |
| Startup refusals (all exit 1) | wrong OS user (`FLEET_SERVICE_EXPECTED_USER`); `FLEET_ADMIN_DATABASE_URL` present; no service DSN or no agent DSN; agent DSN user missing or equal to the service user; remote requested without TLS; non-loopback listen without remote+TLS; unhealthy registry; service login is the schema owner or a superuser; agent role self-check fails; privilege audit problems; runtime release ≠ registry approval. An unpinned release only logs `runtime_release_unpinned` (claims and activations are then refused) |
| Listeners | Without `FLEET_PUBLIC_LISTEN`: one listener on `FLEET_API_LISTEN` (default `127.0.0.1:8787`). With remote enabled and `FLEET_PUBLIC_LISTEN`: admin plain HTTP on the loopback listen address, plus a public HTTPS listener (production: `0.0.0.0:443`, `https://api.agentfleet.vip`) |
| Timers | Reaper every `FLEET_REAPER_INTERVAL_MS` (default 15000; 0 = off); privilege re-audit cached for 60 s on readiness |
| Signals | SIGTERM/SIGINT → graceful drain (`FLEET_SHUTDOWN_DRAIN_MS`, default 10000) → exit 0. A second signal → `shutdown_forced`, exit 1 |
| Output | JSON log lines (`createJsonLogger`); audit sink to `FLEET_AUDIT_LOG` when set (0600) |
| Prod-safe? | Start, stop and restart are `systemctl` actions and need approval (CLAUDE.md) |

### 7.2 Operator API — `src/fleet/operator/main.ts`

| Item | Value |
|---|---|
| Production | `automaton-fleet-operator-api.service`: `User=automaton-fleet-operator-api`, `SupplementaryGroups=` (empty), `ExecStart=/opt/automaton-fleet/node/bin/node dist/fleet/operator/main.js` (unit lines 26-30) |
| Entry | main.ts:188-209: `loadOperatorEnv()` → `startOperatorApiFromEnv` |
| Listen | `FLEET_OPERATOR_LISTEN`, default `127.0.0.1:8788`. Regex `/^(127\.0\.0\.1\|\[::1\]\|localhost):([0-9]{1,5})$/`, port 1..65535 (main.ts:42-49) |
| Refusals | runs as root or not as `FLEET_OPERATOR_EXPECTED_USER`; any variable in `OPERATOR_FORBIDDEN_ENV` is set; admin.env, service.env or the TLS key is readable; `FLEET_OPERATOR_DATABASE_URL` missing; any of `REAL_REPLICATION_ENABLED`, `REAL_PAYMENTS_ENABLED`, `OWNER_SWEEP_ENABLED`, `FLEET_DRY_RUN_CHILD` is true (main.ts:39); incomplete or mismatched pinned release; DB login is the owner, a superuser, or a member of anything other than `fleet_operator`; schema ≠ 8; operator privilege audit problems |
| Readiness | Also needs the time-sync marker `/run/systemd/timesync/synchronized` (`FLEET_OPERATOR_TIMESYNC_MARKER`) |
| Side effects | Each accepted signed request inserts a `fleet_operator_requests` row (`op_begin_request`, migrations-phase8.ts:348-420). Denials write rate-limited `operator_auth_failed / operator_scope_denied / operator_replay_blocked / operator_stale` events (layer `database`). Process audit lines `operator_request`, `operator_request_denied`, `operator_request_denied_suppressed` (server.ts:229-232, 410) |
| Signals | SIGTERM/SIGINT → close → exit 0; fatal → exit 1 |

### 7.3 ChatGPT adapter — `src/fleet/chatgpt-adapter/main.ts`

| Item | Value |
|---|---|
| Production | `automaton-fleet-chatgpt-adapter.service`: `User=automaton-fleet-chatgpt-adapter`, `WorkingDirectory=/opt/automaton-fleet/chatgpt-adapter/current`, `ExecStart=/opt/automaton-fleet/node/bin/node dist/fleet/chatgpt-adapter/main.js`. Socket unit `ListenStream=/run/automaton-fleet-chatgpt/adapter.sock` (mode 660 `automaton-fleet-chatgpt-adapter:automaton-fleet-chatgpt-tunnel`, checked by fleet-verify-deployment.sh:103). Pinned artifact `6691b4c` |
| Entry | main.ts:180-193. Redirects `console.log/info/debug` to stderr. `startAdapter()`; on failure prints one JSON `startup_failed` line on stderr and exits 1 |
| Config | `/etc/automaton-fleet/chatgpt-adapter.json` (`DEFAULT_ADAPTER_CONFIG`, config.ts:18), root:adapter 0640 |
| Listener | Only the systemd socket (`LISTEN_FDS=1` and `LISTEN_PID` = own pid → fd 3) or an explicit socket path in tests. Otherwise it rejects with `no listener …` (main.ts:162-167). No TCP |
| Refusals | root or wrong user; any variable in `ADAPTER_FORBIDDEN_ENV` (= `OPERATOR_FORBIDDEN_ENV` + `FLEET_OPERATOR_DATABASE_URL`, `CONTROL_PLANE_API_KEY`, `OPENAI_ADMIN_KEY`, `OPENAI_API_KEY`); any of `ADAPTER_UNREADABLE_FILES` readable (admin.env, service.env, operator.env, TLS key, `legacy-env-fleet.bak`, …); identity gate: a signed whoami must return exactly this principal and key, kind `bridge_chatgpt`, scopes exactly `{ops.read.agents, ops.read.status}`; re-checked every 5 minutes |
| Tools | 4 read tools (no events tool) |
| Signals | SIGTERM/SIGINT → close → exit 0 |

### 7.4 Root witness — `src/fleet/dry-run/root-main.ts`

| Item | Value |
|---|---|
| Production | `automaton-fleet-witness.service`: `User=automaton-fleet-witness`, `ExecStart=/opt/automaton-fleet/node/bin/node dist/fleet/dry-run/root-main.js`, `RestartPreventExitStatus=3 4` (unit lines 24-43). Installed, **not enrolled, not started** (CLAUDE.md) |
| Interval | `FLEET_WITNESS_INTERVAL_MS`, clamped to 10 000 ≤ ms ≤ 60 000, default 30 000 (root-main.ts:45-46) |
| Credential | `FLEET_CREDENTIALS_FILE`, else `$HOME/.automaton/fleet-credentials.json` (root-witness.ts:199), written by `enroll-witness-root` |
| Exit codes | 0 stopped by signal; 3 the controller no longer accepts this witness; 4 startup refusal; 1 other (root-main.ts:31-33, 54-56) |
| Logs | Redacted JSON lines (`createRedactedLineLogger("fleet-root-witness")`); `witness_stopped` / `witness_failed` |

### 7.5 Dry-run child — `src/fleet/dry-run/child-main.ts`

| Item | Value |
|---|---|
| Where | Inside the dry-run child sandbox only. Started by `performDryRunChild` as `node dist/fleet/dry-run/child-main.js` (dry-run/operator.ts:227) |
| Interval | `FLEET_DRY_RUN_INTERVAL_MS` or 30 000 (child-main.ts:16) |
| Exit | 0 once the controller stops accepting it (`dry_run_child_stopped`); 1 on error (`dry_run_child_failed`) |
| Prod-safe? | Never run it on the controller host |

### 7.6 Agent runtime (not a Fleet CLI; listed for completeness)

`automaton-agent.service`: `User=automaton-agent`, `ExecStart=/opt/automaton-fleet/node/bin/node /opt/automaton-fleet/current/dist/index.js --run` (unit lines 18-21). Installed by `fleet-os-setup.sh`, not enabled.

---

## 8. Claude bridge — `src/fleet/bridge/cli.ts` (`pnpm fleet:bridge [--config FILE] <command>`)

Runs on the dev VM as the operator's user. The config file defaults to
`~/.config/automaton-fleet/operator/bridge-claude.json` (`DEFAULT_CONFIG_FILE`,
bridge/config.ts:21-22). `--config FILE` may appear anywhere in the arguments
(cli.ts:120-121). Output is always pretty JSON on stdout (cli.ts:245).

Exit codes: 0 ok; **2** usage (`{"ok":false,"error":{"code":"USAGE",…}}`); **3**
`BridgeError` `{code, message, requestId}` or `INTERNAL`. `doctor` exits 3 when any check
fails (cli.ts:225-241). Flag values must not start with `--`. Integer flags must match
`/^[0-9]{1,4}$/` (cli.ts:46-51).

Remote path for every read command: `withClient` (cli.ts:54-76) → `acquireTunnel`
(reuses the persistent tunnel or opens an ephemeral one) → `ssh -N -T … -o
ExitOnForwardFailure=yes -L 127.0.0.1:<local>:127.0.0.1:8788` as `fleet-op-tunnel` with
the pinned `known_hosts` (tunnel.ts:59-89) → a signed `FLEET-OP-SIG-V1` request. If the API
readiness is not `ready`, the command throws `API_DISABLED` / `API_NOT_READY` **before**
signing. SIGINT or SIGTERM releases the tunnel and exits 130.

| Command | Entry | Purpose | R/W | Prod-safe? | Required flags | Side effects |
|---|---|---|---|---|---|---|
| `init` | cli.ts:80-117 | Creates the config and a pinned `known_hosts` | W (local) | yes | `--principal op_<ULID>` (`PRINCIPAL_RE`), `--key-file`, `--ssh-host`, `--ssh-identity`, `--host-key-fingerprint SHA256:…`, `--from-known-hosts PATH`; optional `--ssh-user` (default `fleet-op-tunnel`), `--ssh-port` (22), `--ssh-binary` (`/usr/bin/ssh`) | Config dir created 0700 and checked with `requirePrivateDirectory`; refuses an existing config (`CONFIG_INVALID`); loads the key (0600, own uid, nlink 1, Ed25519); writes `known_hosts` 0600 `wx` with only the pinned line; config JSON 0600 `wx` `{version:1, principalId, key{keyFile,keyId,expiresAt:null}, pendingKey:null, previousKey:null, ssh{…}}` |
| `doctor` | cli.ts:190-226 | Checks: pinned host key, signing key, tunnel, then identity via whoami | R | yes | — | Opens and closes a tunnel; one signed request (one `fleet_operator_requests` row) |
| `whoami` | cli.ts:134 | `GET` whoami | R | yes | — | one request row on the VPS |
| `status` | cli.ts:137 | fleet_status | R | yes | — | one request row |
| `agents [--after ULID] [--limit N]` | cli.ts:140 | list_agents | R | yes | — | one request row |
| `agent <ULID>` | cli.ts:143 | get_agent | R | yes | ULID positional | one request row |
| `events [--after ID] [--limit N] [--type TYPE]` | cli.ts:147 | list_events (needs `ops.read.events`; bridge-claude only) | R | yes | — | one request row |
| `tunnel up` | cli.ts:151 | Persistent tunnel (`openPersistentTunnel`) | local process + state file | yes | — | ssh child process; state file (0600, `wx`+rename) in the run dir: `$XDG_RUNTIME_DIR/automaton-fleet-bridge`, else `~/.config/automaton-fleet/operator/run` (tunnel.ts:207-211) |
| `tunnel down` | cli.ts:154 | Closes the owned tunnel | local | yes | — | kills the ssh child, removes the state file |
| `tunnel status` | cli.ts:158 | Shows the owned tunnel | R | yes | — | none |
| `key status [--remote]` | cli.ts:165 | Key id, file key id, expiry level (warn at 21 days, keys.ts). `--remote` refreshes the expiry through whoami and saves the config | R / W (config) | yes | — | `--remote`: one request row plus a config save |
| `key rotate-prepare [--expires-days N]` | cli.ts:175 → keys.ts | Generates `bridge-claude.<stamp>.key` (0600, exclusive) as the pending key; prints the VPS command `pnpm fleet:admin operator-add-key <principal> --public-key <pub> --expires-days <N>` (keys.ts:63) | W (local) | yes locally; the printed VPS command is **gated** | — | new key file; config saved |
| `key rotate-verify` | cli.ts:178 | A signed whoami with the PENDING key must succeed and report that key id | R / W config | yes | — | one request row; config saved |
| `key rotate-switch` | cli.ts:181 | pending → current, current → previous; prints `pnpm fleet:admin operator-revoke-key <oldKeyId> rotated to <newKeyId>` (keys.ts:83) | W (local) | yes locally; the printed command is gated | — | config saved |
| `key rotate-finish` | cli.ts:184 | The previous key must now fail `AUTH_FAILED` and the current key must work; then deletes the old key file (keys.ts:102) | W (local) | yes | — | 2 request attempts; `rmSync(prev.keyFile)`; config saved |

### 8.3 `pnpm fleet:bridge-mcp` — `src/fleet/bridge/mcp.ts`

| Item | Value |
|---|---|
| Entry | mcp.ts:81-84; `--config FILE`, else `FLEET_BRIDGE_CONFIG`, else the default config |
| Protocol | newline-delimited JSON-RPC 2.0 on stdio: `initialize`, `ping`, `tools/list`, `tools/call`; anything else is "method not found". Server name `fleet-operator-bridge` |
| Tools | `fleet_whoami`, `fleet_status`, `fleet_list_agents`, `fleet_get_agent`, `fleet_list_events` (mcp-core.ts:43-88); `limit` 1..200 (default 50), `additionalProperties:false` |
| Output | stdout carries protocol messages only; `console.log/info/debug` are forced to stderr; diagnostic JSON lines go to stderr (`started`, tool name, code, duration) |
| Shutdown | stdin close or SIGTERM/SIGINT → drain in-flight calls, at most 3 s → exit 0 |
| Side effects | Same as the matching `fleet:bridge` read commands (one request row per call) |

---

## 9. Deployment and host scripts

### 9.1 `scripts/fleet-build-runtime.sh <https repo url> <40-hex commit>`

| Item | Value |
|---|---|
| Role | operator (no sudo) |
| Steps (lines) | Validates the commit `^[0-9a-f]{40}$` (12; exit 2 otherwise) → `mktemp -d` clone (14-19, removed on EXIT) → `test HEAD = commit` → `test -f pnpm-lock.yaml` → `CI=true pnpm install --frozen-lockfile` → `pnpm build` → clean-tree check → `node --import tsx src/fleet/postgres/cli.ts build-identity <dir>` (26) |
| Output | Four lines: `FLEET_RUNTIME_REPO=…`, `FLEET_RUNTIME_COMMIT=…`, `FLEET_RUNTIME_BUILD_ID=…`, `FLEET_RUNTIME_LOCKFILE_SHA256=…` (the input to runtime.env and `approve-runtime`) |
| Network | `git fetch` from the repo; the pnpm registry |
| Prod-safe? | yes (only writes a temp dir) |

### 9.2 `scripts/fleet-os-setup.sh [--apply]`

| Item | Value |
|---|---|
| Role | `sudo` from the operator account (`SUDO_USER` must be set and not root; exit 2 otherwise) |
| Default | **DRY RUN**: prints every command; `--apply` performs them (idempotent) |
| Env overrides | `FLEET_DB_NAME` (automaton_fleet), `FLEET_DB_HOST` (127.0.0.1), `FLEET_DB_PORT` (5432), `FLEET_NODE_BIN` (operator's `node`) |
| Creates | group `automaton-fleet-admin` (+ operator); users `automaton-fleet-service` (system, nologin), `automaton-agent` (home 0700), `automaton-fleet-witness`, `automaton-fleet-operator-api`; `/etc/automaton-fleet` 0755; `tls/` root:automaton-fleet-admin 0750 (refuses a symlink; only re-permissions existing fleet.key 0600 and fleet.crt 0644 single-link files); `admin.env` 0640 root:automaton-fleet-admin (copied from the repo `.env.fleet` DSN); `service.env` 0600 root:root with two fresh `openssl rand -hex 32` passwords (`fleet_service_login`, `fleet_agent_login`); `operator.env` 0640 root:automaton-fleet-operator-api (`fleet_operator_login`, fresh password); `runtime.env` 0644 from `deploy/etc/runtime.env.example`; `/opt/automaton-fleet/{releases,node/bin}` with the node binary copied in; installs 4 units (fleet, agent, witness, operator-api) and runs `systemctl daemon-reload` (not enable/start); `/etc/logrotate.d/automaton-fleet`; moves controller secrets out of the repo `.env.fleet` (backup `/etc/automaton-fleet/legacy-env-fleet.bak` 0600) |
| Existing files | left unchanged (only chown/chmod) |
| Secrets | generated, never printed (`put()` shows `<generated content>`) |
| Prod-safe? | **gated** (sudo, /etc, users) |

### 9.3 `scripts/fleet-db-setup.sh [--apply]` and `scripts/fleet-db-roles.sql`

| Item | Value |
|---|---|
| Role | `sudo` (exit 2 otherwise); psql runs as `postgres` via `runuser -u postgres` |
| Default | DRY RUN prints the pipeline; `--apply` runs it |
| Env | `FLEET_DB_NAME` (automaton_fleet), `FLEET_DB_OWNER` (fleetadmin) |
| Preconditions | `/etc/automaton-fleet/service.env` exists; `operator.env` exists and is not a symlink; each DSN password matches `[0-9a-f]{64}` (sed at line 30); exit 1 otherwise |
| Action | `{ printf '\set agent_password …\n\set service_password …\n\set operator_password …\n'; cat scripts/fleet-db-roles.sql; } \| runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -v dbname=… -v owner=… -d postgres -f -`. Passwords travel only on stdin |
| fleet-db-roles.sql effects | Sets `log_statement='none'` for the session; creates (if absent) `fleet_agent`, `fleet_agent_login`, `fleet_service`, `fleet_service_login`, `fleet_operator`, `fleet_operator_login`; ALTER ROLE attributes (NOLOGIN groups NOINHERIT; logins INHERIT with CONNECTION LIMIT 32 / 16 / 8); sets the passwords; GRANT group → login; `GRANT CONNECT` on the database to the three logins; `CONNECT, TEMPORARY` to the owner; per-database `statement_timeout` / `lock_timeout` / `idle_in_transaction_session_timeout`: agent 10s/5s/30s, service 15s/5s/30s, operator 5s/2s/10s (sql lines 36-91) |
| Next step printed | `pnpm fleet:migrate && pnpm fleet:audit-privileges && pnpm fleet:doctor` as the owner operator |
| Prod-safe? | **gated** (PostgreSQL roles; resets passwords to the secret-file values) |

### 9.4 `scripts/fleet-deploy-release.sh build [--source DIR] | install`

| Mode | Role | Behaviour | Side effects |
|---|---|---|---|
| `build` | operator, **not root** (exit 2 if root) | Reads `FLEET_RUNTIME_REPO/_COMMIT/_BUILD_ID/_LOCKFILE_SHA256` from `${FLEET_RUNTIME_ENV_FILE:-/etc/automaton-fleet/runtime.env}` (commit 40 hex, build and lock 64 hex; the repo must be https unless `--source`). Fresh `git init` in `${XDG_CACHE_HOME:-~/.cache}/automaton-fleet/stage/<commit>`, fetch (depth 1 from origin, or from the `--source` clone), checkout, `sha256sum -c` of the lockfile BEFORE install, frozen install, build, clean-tree check, and build-identity must equal the pins (`BUILD MISMATCH` → exit 1) | stage dir |
| `install` | `sudo` (exit 2 otherwise) | Stage from `$SUDO_USER`'s cache. Refuses if `/opt/automaton-fleet/releases/<commit>` exists ("releases are immutable"). `cp -a` to `.tmp`, removes `.git`, `chown -R root:root`, strips write bits, re-verifies the identity with `/opt/automaton-fleet/node/bin` node, `mv`, then atomic `current` symlink switch (`ln -sfn` + `mv -T`) | new release dir; `current` repointed; prints "Restart the service…" (the restart is NOT performed) |

Prod-safe? `build`: yes. `install`: **gated** (it changes the runtime that production runs
after the next restart).

### 9.5 `scripts/fleet-deploy-chatgpt-adapter.sh build <commit> <buildId> <lockfileSha256> | install <commit>`

| Mode | Role | Behaviour | Side effects |
|---|---|---|---|
| `build` | operator, not root | Commit 40 hex; build and lock 64 hex (exit 2). Clones from the hard-coded `https://github.com/5l4mm3r/automaton-fleet.git` into `~/.cache/automaton-fleet/chatgpt-adapter-stage/<commit>`, checks the lockfile hash, frozen install, build, identity check (uses `/opt/automaton-fleet/node/bin` node) | stage dir + `.adapter-pins` (`commit buildId lock`) |
| `install` | `sudo` | Requires `.adapter-pins` for the same commit; refuses an existing `/opt/automaton-fleet/chatgpt-adapter/releases/<commit>`; root-owned read-only copy; re-verify; writes `/opt/automaton-fleet/chatgpt-adapter/pins.env` (0644: `FLEET_CHATGPT_ADAPTER_COMMIT/_BUILD_ID/_LOCKFILE_SHA256`); switches `…/chatgpt-adapter/current` | never touches `/opt/automaton-fleet/current` or runtime.env |

Prod-safe? `build` yes; `install` **gated**. The production artifact is `6691b4c` (build
`62336fee…`).

### 9.6 `scripts/fleet-chatgpt-setup.sh prepare --tunnel-client-zip <zip> [--apply] | configure <op_principalId> [--apply]`

The script parses its arguments with `--apply`, `--tunnel-client-zip <zip>` and a
positional `op_*` value. Any other argument exits 2. It must run as root (exit 2
otherwise). Without `--apply` it only prints what it would do.

| Mode | Behaviour | Side effects (with --apply) |
|---|---|---|
| `prepare` | Checks the zip SHA-256 = `29d29cf860ada54e4d3c82c715f4fbfcff2abcdc2584c0fc26431308dfa2505b` (exit 1 otherwise). Requires the adapter tree `/opt/automaton-fleet/chatgpt-adapter/current/dist/fleet/chatgpt-adapter`. Creates users `automaton-fleet-chatgpt-adapter` and `automaton-fleet-chatgpt-tunnel` (system, nologin, own group); dirs `/etc/automaton-fleet/chatgpt-tunnel` root 0700 and `/var/lib/automaton-fleet-chatgpt-adapter` adapter 0700. Installs tunnel-client `v0.0.14`, binary SHA-256 `94ae9d0c024753d1b79669152e968eb5d0faaad1e04ccf6c37750d7a3e175c77`, into `/opt/automaton-fleet/tunnel-client/v0.0.14/`. Generates `adapter-token` (32 random bytes, base64url, root 0600, never printed). Generates the bridge-chatgpt key as the adapter user via `keygen.js` (prints only the public key and key id). Installs the adapter .socket/.service and tunnel .service/.path units and `/usr/local/sbin/fleet-chatgpt-tunnel-key` (0755); `daemon-reload` | users, dirs, binary, token, key, units |
| `configure` | Principal must match `^op_[0-9A-HJKMNP-TV-Z]{26}$`. Derives the key id (`^[0-9a-f]{32}$`) as the adapter user. Token digest = sha256 of adapter-token. Writes `/etc/automaton-fleet/chatgpt-adapter.json` root:adapter 0640 `{version:1, principalId, keyFile, keyId, operator:{port:8788,user:"automaton-fleet-operator-api"}, tunnelTokenSha256, limits:{callsPerMinute:30, burst:10, maxQueued:4}}`. Then `systemctl enable --now` the adapter socket and service, `enable` the tunnel service, and `enable --now` the tunnel path unit | config file; services started |

Prod-safe? **gated** (sudo, users, systemctl). The operator step between the two modes is
`pnpm fleet:admin operator-enroll bridge-chatgpt bridge_chatgpt --scopes
ops.read.status,ops.read.agents --public-key <pub> --expires-days 30` (gated).

### 9.7 `fleet-chatgpt-tunnel-key` (source `scripts/fleet-chatgpt-tunnel-key.sh`; installed to `/usr/local/sbin/fleet-chatgpt-tunnel-key`)

| Item | Value |
|---|---|
| Role | **The owner only**, `sudo`, in the owner's OWN interactive terminal. Refuses unless both stdin and stdout are TTYs (exit 2). Never run it from an AI session |
| Preconditions | `/etc/automaton-fleet/chatgpt-tunnel` is a root:root 0700 directory and not a symlink; `tunnel.env` (tunnel id) exists (exit 1 otherwise) |
| Input | Reads from `/dev/tty` with echo off. Typeahead entered before the prompt is discarded. Normalisation strips bracketed-paste markers, CR and surrounding whitespace. Hygiene: 20..4096 chars, `^[!-~]+$`. No key-format allowlist |
| Write | Backs up the previous key to `.prev.XXXXXX`, then atomic tmp → `/etc/automaton-fleet/chatgpt-tunnel/openai-api-key` root 0600 |
| Verification | `systemctl reset-failed` + `restart automaton-fleet-chatgpt-tunnel.service`, then polls `journalctl _SYSTEMD_INVOCATION_ID=<id>` for up to `WAIT_S=60` s: `"tunnel metadata fetched"` = accepted; `status 401/403/404` = rejected; the unit stopping = stopped |
| Exit | 0 accepted (previous key removed). 1 not accepted: rollback restores the previous key and restarts, or removes the key and stops the tunnel. 130 on INT/TERM/HUP. The EXIT trap always restores the TTY and rolls back an unverified staged key |
| Output | A verdict only; never the key or raw log lines |
| Prod-safe? | owner action (secret entry); **gated** |

<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->
(The operator's records say the tunnel unit is waiting for the owner's runtime key. Tunnel
id `tunnel_6ab5cd2c7b088191abe137e56b5f35e4`.)

### 9.8 `scripts/fleet-verify-deployment.sh`

| Item | Value |
|---|---|
| Role | `sudo` (exit 2 otherwise). **Read-only**: it uses `runuser -u <user> -- test -r/-w`, `stat`, `ss`, `systemctl is-active/show`, `timedatectl`, and reads `/proc/<pid>/environ` |
| Checks | Each of automaton-agent, -fleet-service, -fleet-witness and -fleet-operator-api cannot read admin.env, service.env, tls/fleet.key or legacy-env-fleet.bak. Witness and operator-api users are in no other group. `operator.env` = `root:automaton-fleet-operator-api 640 1` and unreadable by the other users, and holds no forbidden credential key. 8788 is loopback-only when the unit is active. NTP is synchronized and `/run/systemd/timesync/synchronized` exists. ChatGPT: both users are in their own group only; `chatgpt-adapter.json` `root:adapter 640 1`; `adapter-token` `root:root 600 1`; the `chatgpt-tunnel` dir is `root:root 700`; `openai-api-key` (if present) `root:root 600 1`; `/var/lib/…/bridge-chatgpt.key` `adapter:adapter 600 1`; the socket `adapter:tunnel 660` and not writable by other users; cross-read matrix; neither user holds a TCP listener. TLS: `tls/` 750 root:automaton-fleet-admin, key 600, cert 644; the remote drop-in maps exactly `tls.crt`/`tls.key`; runtime.env does not set `FLEET_TLS_KEY_FILE`; `FLEET_TLS_CERT_FILE` (if set) is `/run/credentials/automaton-fleet.service/tls.crt`. The repo `.env.fleet` holds no controller secrets. The service is active, runs as automaton-fleet-service, and has no DSN in its environ. Ports 5432, 6379 and 8787 are loopback-only |
| Output | `[PASS]` / `[FAIL]` lines; exit 1 on any failure, 0 otherwise |
| Prod-safe? | yes (read-only, but needs sudo, so still ask per CLAUDE.md "sudo") |

### 9.9 `deploy/firewall/fleet-firewall.sh [--apply]`

| Item | Value |
|---|---|
| Role | `sudo` (exit 2); requires `ufw` (exit 1 if absent) |
| Default | DRY RUN prints the rules; `--apply` applies them |
| Rules | `ufw default deny incoming`; `default allow outgoing`; `allow ${FLEET_SSH_PORT:-22}/tcp`; `allow 443/tcp`; `deny 5432/tcp`; `deny 6379/tcp`; `deny 8787/tcp`; `ufw --force enable`; `ufw status verbose` |
| Prod-safe? | **gated** (firewall rules) |

Observation (not a drift): the script has no explicit `deny 8788/tcp` rule for the Operator
API. That port is loopback-bound by code (main.ts:42-49) and is covered by `default deny
incoming`. The explicit deny list simply predates Phase B.

---

## 10. Non-Fleet scripts (checked and excluded)

`scripts/automaton.sh`, `scripts/backup-restore.sh` and `scripts/soak-test.sh` contain no
reference to the fleet (`grep -ci fleet` = 0). `scripts/conways-rules.txt` is data, not a
command.

---

## 11. DRIFT and NOT IMPLEMENTED summary

- DRIFT: the brief assumes a "systemd-run / sudo -u" pattern for production commands. No
  such pattern is documented. The documented pattern is the operator's login account
  (group `automaton-fleet-admin`) running `pnpm fleet:*` from `~/automaton-fleet` (§1).
- DRIFT: `set-timeouts parent-quiet=` is implemented but missing from the cli.ts header,
  the usage line and FLEET.md:296 (§4).
- DRIFT: the cli.ts default usage line omits 13 implemented subcommands and all treasury
  commands (§4).
- DRIFT: `fleet-db-setup.sh:13` says "v1 -> v3" and FLEET.md:265 says "schema v2"; the code
  migrates to v8 (§4).
- Behaviour note (documentation gap): plain `fleet:doctor` exits 1 whenever real
  replication is unsafe, which is always the case in production today, even when it prints
  `DEPLOYMENT: OK`. The runbook quotes only the printed text.
- NOT IMPLEMENTED: execution of custody transfers, owner distributions and sweeps. The
  treasury commands record plans only (§3.4).
- NOT IMPLEMENTED: any CLI command that sets `REAL_*`, `OWNER_SWEEP_ENABLED`,
  `FLEET_DRY_RUN_CHILD` or `FLEET_REMOTE_LISTEN_ENABLED`. They are file and env settings
  only (§5).
