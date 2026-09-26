# 13 — Fleet Test Inventory (Master Key, PART 15)

Scope: every Fleet-specific automated test in the repository at `fleet-development`
HEAD `efad214` (2026-09-25), the fixtures they depend on, the `package.json`
test scripts, `vitest.config.ts`, and the out-of-band deployment verification
(`scripts/fleet-verify-deployment.sh`, the `fleet:verify` 16-item checklist).

Method (read-only, no tests were run by this pass):
- Test cases were counted with a regex over each file
  (`^\s*(describe|it|test)(\.modifier(args)?)?\(`), then corrected by hand for the
  four loop-generated `it(` call sites (see §2.2). Counts are **static**; a
  PostgreSQL-gated test still counts when it would be skipped.
- Titles in Appendix A were extracted mechanically from the source (line number,
  kind, first string literal). Template-literal titles are shown with their `${…}`
  placeholder.
- Sources: `src/__tests__/fleet/*.test.ts`, `src/__tests__/fleet/fixtures/*`,
  `src/__tests__/replication.test.ts`, `src/__tests__/mocks.ts:365-430`,
  `package.json:40-71`, `vitest.config.ts`, `FLEET.md`, `docs/fleet-known-issues.md`,
  `docs/fleet-production-runbook.md`, `docs/design/phase-{b,c,d}-*.md`,
  `git log baseline-before-fleet..HEAD`, and the operator's session records.

---

## 1. Test runner configuration

### 1.1 `vitest.config.ts` (entire file, 26 lines)

```ts
export default defineConfig({
  test: {
    testTimeout: 30_000,
    teardownTimeout: 5_000,
    include: ["src/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/types.ts", "node_modules/**"],
      thresholds: { statements: 60, branches: 50, functions: 55, lines: 60 },
      reporter: ["text", "text-summary", "json-summary"],
    },
  },
});
```

Consequences:
- Default per-test timeout is 30 s. Long tests override it explicitly
  (for example `fleet.test.ts:333` "20 concurrent OS processes" uses 90 000 ms;
  `fleet-phase3.test.ts:208` opt-in reproducibility test uses 600 000 ms).
- Fixtures under `src/__tests__/fleet/fixtures/` are not `*.test.ts`, so they are
  never collected as tests.
- There is no `globalSetup`, no `setupFiles`, no `pool`/`poolOptions`
  override: vitest's default worker pool runs test **files** in parallel. Every
  PostgreSQL-backed file therefore starts its **own** ephemeral cluster (§3.1).

### 1.2 `package.json` test scripts (`package.json:43-69`)

| Script | Exact command | What it selects |
|---|---|---|
| `test` | `vitest run` | Whole repository suite (hangs — see §9.1) |
| `typecheck` | `tsc --noEmit` | Type check only |
| `test:coverage` | `vitest run --coverage` | Whole suite with v8 coverage and the thresholds above |
| `test:security` | `vitest run -t 'security\|injection\|policy'` | Every test whose full name (describe chain + title) matches the regex, across the whole repo |
| `test:financial` | `vitest run -t 'financial\|spend\|treasury'` | Same mechanism for financial names |
| `test:fleet` | `vitest run src/__tests__/fleet` | All 20 files in `src/__tests__/fleet/` |
| `test:deploy` | `vitest run src/__tests__/fleet/fleet-phase4.test.ts` | Phase 4 only |
| `test:phase5` | `vitest run src/__tests__/fleet/fleet-phase5.test.ts` | Phase 5 only |
| `test:phase6` | `vitest run src/__tests__/fleet/fleet-phase6.test.ts` | Phase 6 only |
| `test:witness` | `vitest run src/__tests__/fleet/fleet-witness.test.ts src/__tests__/fleet/fleet-witness-imports.test.ts` | Witness (FLEET-KI-4) |
| `test:redact` | `vitest run src/__tests__/fleet/redact.test.ts src/__tests__/fleet/redact-sinks.test.ts` | Gate B0 redaction |
| `test:operator` | `vitest run src/__tests__/fleet/operator-canonical.test.ts src/__tests__/fleet/operator-pg.test.ts src/__tests__/fleet/operator-server.test.ts` | Phase B2 Operator API |
| `test:bridge` | `vitest run src/__tests__/fleet/bridge-unit.test.ts src/__tests__/fleet/bridge-tunnel.test.ts src/__tests__/fleet/bridge-integration.test.ts src/__tests__/fleet/bridge-mcp.test.ts` | Phase D bridge + D2 MCP |
| `test:chatgpt` | `vitest run src/__tests__/fleet/chatgpt-adapter.test.ts src/__tests__/fleet/chatgpt-adapter-imports.test.ts src/__tests__/fleet/chatgpt-tunnel-key.test.ts` | Phase C ChatGPT adapter |
| `test:ci` | `vitest run --reporter=verbose` | Whole suite, verbose (hangs — see §9.1) |

Notes:
- `test:security` / `test:financial` rely on **naming conventions**: the fleet test
  file headers state that describe names include "policy", "security",
  "financial" and "treasury" so these scripts pick them up
  (`fleet.test.ts:8-9`, `fleet-phase2.test.ts:8-9`, `fleet-phase3.test.ts:12-13`,
  `fleet-phase4.test.ts:13-15`, `fleet-phase5.test.ts:5-6`, `fleet-phase6.test.ts:6-7`,
  `fleet-witness.test.ts:10-11`). Files whose describe names contain none of the
  words (redact, operator-*, bridge-*, chatgpt-*) are **not** selected by
  `test:security` unless an individual title matches.
- Operator record (memory `preexisting-test-hangs.md`): `test:security` and
  `test:financial` originally used `--grep`, which vitest 2 rejects; they were
  changed to `-t` during fleet Phase 1.
- Fleet operational scripts that are *not* tests but are verification tools:
  `fleet:doctor` (`tsx src/fleet/postgres/cli.ts doctor`), `fleet:verify`
  (`… doctor --checklist`), `fleet:verify-runtime`, `fleet:audit-privileges`,
  `fleet:migrate-check` (see §7.3).

---

## 2. Summary counts

### 2.1 Per file

"PG-gated" = tests inside a `describe.skipIf(!PG_BIN)` (ephemeral cluster) or
`describe.skipIf(!PG_URL)` (external database) block; they are **skipped, not
failed**, when the precondition is missing.

| # | File | Lines | `it` call sites | Effective tests | PG-gated | Other conditional | Group |
|---|---|---:|---:|---:|---:|---|---|
| 1 | `src/__tests__/fleet/fleet.test.ts` | 726 | 42 | **42** | 0 | — | Core Phase 1 |
| 2 | `src/__tests__/fleet/fleet-phase2.test.ts` | 1063 | 49 | **49** | 26 (`PG_URL`) | — | Core Phase 2 |
| 3 | `src/__tests__/fleet/fleet-phase3.test.ts` | 1026 | 44 | **44** | 24 | 1 opt-in (`FLEET_REPRO_TEST=1`) | Core Phase 3 |
| 4 | `src/__tests__/fleet/fleet-phase4.test.ts` | 1267 | 53 | **53** | 26 | 1 skipped when run as root | Core Phase 4 / deployment |
| 5 | `src/__tests__/fleet/fleet-phase5.test.ts` | 947 | 43 | **43** | 23 | — | Core Phase 5 / financial |
| 6 | `src/__tests__/fleet/fleet-phase6.test.ts` | 1039 | 29 | **29** | 16 | 2 host-conditional early returns | Core Phase 6 / deployment |
| 7 | `src/__tests__/fleet/fleet-witness.test.ts` | 760 | 25 | **26** | 13 | — | Witness |
| 8 | `src/__tests__/fleet/fleet-witness-imports.test.ts` | 61 | 2 | **2** | 0 | — | Witness |
| 9 | `src/__tests__/fleet/redact.test.ts` | 503 | 31 | **76** | 0 | — | B0 redaction |
| 10 | `src/__tests__/fleet/redact-sinks.test.ts` | 222 | 12 | **12** | 4 | — | B0 redaction |
| 11 | `src/__tests__/fleet/operator-canonical.test.ts` | 413 | 24 | **41** | 0 | — | B2 Operator API |
| 12 | `src/__tests__/fleet/operator-pg.test.ts` | 848 | 20 | **20** | 20 | — | B2 Operator API |
| 13 | `src/__tests__/fleet/operator-server.test.ts` | 393 | 10 | **10** | 10 | — | B2 Operator API |
| 14 | `src/__tests__/fleet/bridge-unit.test.ts` | 406 | 18 | **18** | 0 | — | Phase D bridge |
| 15 | `src/__tests__/fleet/bridge-tunnel.test.ts` | 270 | 10 | **10** | 0 | — | Phase D bridge |
| 16 | `src/__tests__/fleet/bridge-integration.test.ts` | 259 | 6 | **6** | 6 | — | Phase D bridge |
| 17 | `src/__tests__/fleet/bridge-mcp.test.ts` | 395 | 9 | **9** | 2 | — | D2 MCP |
| 18 | `src/__tests__/fleet/chatgpt-adapter.test.ts` | 312 | 8 | **8** | 8 | — | Phase C ChatGPT |
| 19 | `src/__tests__/fleet/chatgpt-adapter-imports.test.ts` | 47 | 2 | **2** | 0 | — | Phase C ChatGPT |
| 20 | `src/__tests__/fleet/chatgpt-tunnel-key.test.ts` | 94 | 5 | **5** | 0 | — | Phase C ChatGPT |
| | **`src/__tests__/fleet/` total** | 11 051 | 442 | **505** | **178** | | |
| 21 | `src/__tests__/replication.test.ts` (fleet-related, outside `fleet/`) | — | 20 | **20** | 0 | — | Core (spawn gating) |
| | **Fleet-related total** | | 462 | **525** | 178 | | |

Script totals (effective): `test:fleet` 505; `test:operator` 41+20+10 = **71**;
`test:bridge` 18+10+6+9 = **43**; `test:chatgpt` 8+2+5 = **15**; `test:redact`
76+12 = **88**; `test:witness` 26+2 = **28**; `test:deploy` 53; `test:phase5` 43;
`test:phase6` 29.

### 2.2 Loop-generated tests (why "effective" differs from call sites)

| File:line | Generator | Iterations | Source of the list |
|---|---|---:|---|
| `operator-canonical.test.ts:133-135` | `for (const [name, t] of Object.entries(reject)) it(\`rejects ${name}\`, …)` | 18 | `reject` map at `:113-132`: percent, percentQuery, plus, emptyValue, bareKey, trailingAmp, leadingAmp, doubleAmp, duplicate, unsorted, bareQuestion, fragment, upper, trailingSlash, doubleSlash, dotSegment, space, upperKey |
| `redact.test.ts:55-56` | `for (const s of textSecrets) it(\`${s.id}: raw, embedded, zero-width, bidi, NUL and fullwidth forms\`, …)` | 27 | `makeCorpus()` adds 32 synthetic secrets (`fixtures/redaction-corpus.ts:74-154`); the 5 `keyOnly` ones (`key-apikey`, `key-privatekey`, `key-walletseed`, `key-sessiontoken`, `key-zw-password`, `:149-153`) are excluded by `textSecrets = corpus.filter((s) => !s.keyOnly)` (`redact.test.ts:51`) |
| `redact.test.ts:404-405` | `for (const [name, input] of Object.entries(cases)) it(\`${name}: bounded time and output\`, …)` | 20 | 1 MiB inputs at `:382-403`: plain, pemHeaders, tokens, bearer, hexRun, b64Run, kv, envNames, words, urls, evasion, upperRunNoSep, secretUnderscores, apiKeyish, digitsUpper, assignChain, assignPairs, openQuotes, markerSpam, userinfoNoAt |
| `fleet-witness.test.ts:228-229` | `for (const entry of ["fleet/dry-run/root-main.ts", "fleet/dry-run/root-witness.ts"]) it(…)` | 2 | inline array |

The 27 text-secret test IDs (one test each, `redact.test.ts:56`):
`fa1-token`, `fs1-token`, `op1-token`, `bearer`, `fleetsession-header`, `basic-auth`,
`pem-ed25519`, `pem-ec-p256`, `pem-unterminated`, `pem-openssh`, `dsn-url`,
`dsn-libpq`, `env-admin-dsn`, `env-api-key`, `env-pgpassword`, `json-kv-password`,
`json-kv-apikey`, `hex64-0x`, `hex64-bare`, `hex128`, `hex64-upper`,
`base58-solana`, `base64-32`, `base64url-64`, `jwt`, `mnemonic-12`, `mnemonic-24`.
(All values are generated at runtime from `crypto.randomBytes` /
`generateKeyPairSync`; none are fixed literals.)

### 2.3 Documented counts vs code

| Source | Claim | Code at HEAD | Status |
|---|---|---|---|
| `FLEET.md:157` | `fleet.test.ts`, 42 tests | 42 | matches |
| `FLEET.md:335` | `fleet-phase3.test.ts` 43 tests plus 1 opt-in | 44 call sites = 43 + 1 opt-in | matches |
| `FLEET.md:474` | `fleet-phase4.test.ts` 38 tests | 53 | **DRIFT:** 38 was correct at `e5ac7fe`/`2d6d4cf`; `241dcf9` (service.env systemd credential) raised it to 45 and `11c0c7c` (tls.key credential) to 53. FLEET.md was not updated. |
| `FLEET.md:594` | `fleet-phase5.test.ts` 43 tests | 43 | matches |
| `FLEET.md:708` / commit `2d6d4cf` | `fleet-phase6.test.ts` 29 tests | 29 | matches |
| `FLEET.md:794` | witness 26 + imports 2 | 26 + 2 | matches |
| `FLEET.md:475` | Phase 4 privilege audit "fails for 11 over-grant mutations" | The explicit over-grant table in `fleet-phase4.test.ts:731-741` has **8** cases | **DRIFT (unresolved):** 8 in-code cases; the "11" may count other audit tests or an earlier mutation run. Not determinable from the repo. |
| `ARCHITECTURE.md:255,743`, `DOCUMENTATION.md:90` | "24 test files, 897 tests" | Pre-fleet upstream figures | **DRIFT:** upstream documentation predates the fleet; not maintained for fleet tests. |

---

## 3. Fixtures and shared helpers

### 3.1 `src/__tests__/fleet/fixtures/ephemeral-pg.ts` (126 lines) — throwaway PostgreSQL cluster

Purpose (`:1-9`): role/privilege tests need real roles, and the fleet owner role
(like production `fleetadmin`) cannot create roles, so each test file `initdb`s
a private cluster in a temp dir where the test process is the superuser.

**Binary discovery** — `findPgBin()` (`:32-50`). Candidates, in order:
1. `process.env.PG_BIN`;
2. output of `pg_config --bindir` (if `pg_config` is on `PATH`);
3. every `/usr/lib/postgresql/<v>/bin`, highest numeric version first (Debian/Ubuntu layout).

The first candidate containing **all three** of `initdb`, `pg_ctl` and `psql` wins;
otherwise `null`, and every `describe.skipIf(!PG_BIN)` block is skipped.
**Requirement: local PostgreSQL server binaries** (Ubuntu package
`postgresql-<v>` provides `/usr/lib/postgresql/<v>/bin/initdb`). No running
system PostgreSQL service, no network, no root.

**Cluster creation** — `startEphemeralPg(bin)` (`:63-126`):

| Step | Exact action |
|---|---|
| temp dir | `fs.mkdtempSync(os.tmpdir() + "/fleet-pg-")`; data dir `<dir>/data` |
| passwords | superuser, owner, agent, service, operator: each `randomBytes(12).toString("hex")` |
| initdb | `initdb -D <data> -U postgres --pwfile <dir>/pw --auth=scram-sha-256 -E UTF8` (pwfile written mode 0600) |
| port | `freePort()`: listen on `127.0.0.1:0`, read the port, close |
| start | `pg_ctl -D <data> -l <dir>/log -w -o "-p <port> -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c max_connections=200" start` |
| owner | `CREATE ROLE fleet_owner LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB PASSWORD '<ownerPw>'` |
| database | `CREATE DATABASE fleet_t OWNER fleet_owner` |
| roles | `applyRoles()`: `psql <superUrl> -X -v ON_ERROR_STOP=1 -q -v dbname=fleet_t -v owner=fleet_owner -f -` with stdin = `\set agent_password …`, `\set service_password …`, `\set operator_password …` followed by the contents of `scripts/fleet-db-roles.sql` — "Same invocation as scripts/fleet-db-setup.sh: passwords on stdin, never argv" (`:99`). `PGPASSWORD` is set in psql's env for `\connect` inside the role script. |
| stop | `pg_ctl -D <data> -m immediate stop`, then `rm -rf <dir>` (also on any setup failure) |

Returned DSNs (all `127.0.0.1:<port>/fleet_t` except super):
`superUrl` (`postgres@…/postgres`), `ownerUrl` (`fleet_owner`), `agentUrl`
(`fleet_agent_login`), `serviceUrl` (`fleet_service_login`), `operatorUrl`
(`fleet_operator_login`, schema v8). TCP only (Unix sockets disabled), scram-sha-256.

Users: `fleet-phase3`, `fleet-phase4`, `fleet-phase5`, `fleet-phase6`,
`fleet-witness`, `redact-sinks`, `operator-pg` (two clusters: `:110` and `:752`),
`operator-server`, `bridge-integration`, `bridge-mcp`, `chatgpt-adapter`.

### 3.2 `fleet-phase2.test.ts` uses an **external** database, not the ephemeral cluster

`fleet-phase2.test.ts:81-95`:
```ts
const PG_URL =
  process.env.FLEET_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  readEnvFile(path.resolve(".env.fleet")).DATABASE_URL ||
  adminDatabaseUrl() ||   // loadAdminEnv({}).env.FLEET_ADMIN_DATABASE_URL (/etc/automaton-fleet/admin.env)
  "";
```
The PostgreSQL block (`:505`) creates schema `fleet_test_<ulid lowercase>` inside
that database, migrates it with the owner/admin credential, and drops it in
`afterAll` (`DROP SCHEMA IF EXISTS <schema> CASCADE`). It uses a `pg.Pool` with
`max: 25`. It is skipped when no DSN resolves. **Risk:** on a host where the
operator can read `/etc/automaton-fleet/admin.env`, the test silently targets the
**controller's real database** (in a throwaway schema). On the local dev VM the
controller is stopped; on the production VPS this test must not be run. This is also
where FLEET-KI-1 and FLEET-KI-2 surface (§9.2).

### 3.3 `fixtures/wipe.ts` (30 lines) — registry reset between PostgreSQL tests

`wipeRegistry(c, schema)` (test-only, runs inside the caller's transaction, owner connection):
1. `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename` — all tables, **alphabetical**.
2. `LOCK TABLE <all> IN ACCESS EXCLUSIVE MODE` (one statement, alphabetical order; `:17`).
3. `ALTER TABLE <t> DISABLE TRIGGER USER` for every table.
4. `TRUNCATE <all except fleet_state, fleet_schema_migrations, fleet_treasury_policy> RESTART IDENTITY CASCADE`.
5. `UPDATE fleet_state SET living_agents = 0, reserved_slots = 0[, quarantined_slots = 0][, reaper_last_run_at = NULL, reaper_grace_from = NULL]` (columns detected from `information_schema`).
6. `ALTER TABLE <t> ENABLE TRIGGER USER`.

Used by `fleet-phase2` (`:548`, schema `fleet_test_<ulid>`), `fleet-phase3` (`:455`),
`fleet-phase4` (`:618`), `fleet-phase5` (`:398`), `fleet-phase6` (`:416`),
`fleet-witness` (`:286`), all with schema `fleet`. Introduced in `e5ac7fe`.
The comment in `fleet-phase2.test.ts:547` says "Same lock order as reservations
(fleet_state first) to avoid deadlocks", but the alphabetical order places
`fleet_agent_credentials`, `fleet_agents`, … before `fleet_state` — see FLEET-KI-2 in
`18-KNOWN-ISSUES.md`.

### 3.4 `fixtures/reserve-worker.ts` (18 lines) and `fixtures/pg-reserve-worker.ts` (23 lines) — cross-process cap race

- `reserve-worker.ts`: child process run via `node_modules/.bin/tsx`; opens its own
  `better-sqlite3` connection to the file path in `argv[2]`, busy-waits until the
  shared start time `argv[3]`, calls `FleetRegistry.reserveSlot({ parentAgentId: null, requestedBy: "proc-<pid>", name: "worker" })`,
  prints `{"ok":…, "code":…}`. Used by `fleet.test.ts:333` (20 processes, start barrier `Date.now()+6000`).
- `pg-reserve-worker.ts`: same pattern with `PgFleetStore({ connectionString: process.env.FLEET_TEST_DATABASE_URL, schema, poolMax: 1, connectTimeoutMs: 30_000 })`;
  the DSN arrives **via env, never argv** (`:5`). Args: schema, parent agent id, start time, repo, commit.
  Used by `fleet-phase2.test.ts:686` (20 processes, barrier `Date.now()+8000`).

### 3.5 `fixtures/fake-ssh.ts` (107 lines) — Phase D stand-in ssh and fake Operator endpoint

- `writeFakeSsh(dir, baked, name)` writes an executable Node script that parses
  `-L 127.0.0.1:<port>:127.0.0.1:8788`, records its argv to `FAKE_SSH_ARGV_FILE`,
  then behaves per `FAKE_SSH_MODE` (or baked mode):
  `ok` (listen on `<port>`, proxy to `FAKE_SSH_TARGET_PORT`), `hostkey` (prints
  "REMOTE HOST IDENTIFICATION HAS CHANGED … Host key verification failed.", exit 255),
  `auth` ("Permission denied (publickey).", exit 255), `hang` (never listens),
  `ignore-term` (like ok but ignores SIGTERM → forces SIGKILL escalation).
  If the port is taken it prints ssh's "cannot listen" lines and exits 255.
- `fakeOperatorEndpoint(mode)` — local HTTP server that answers `/healthz` and
  `/readyz` as the Operator API (`api`), as something else (`not-api`), or as a
  disabled Operator API (`disabled`).
- `privateTmp(prefix)` — 0700 temp dir; `bridgeFixture(dir, sshBinary, over)` —
  a complete `BridgeConfig` with a generated host key and its pinned fingerprint
  (`fingerprintOfBlob`).
No network, no real ssh, no production host.

### 3.6 `fixtures/redaction-corpus.ts` (309 lines) — synthetic secret corpus (Gate B0)

- `makeCorpus()` → 32 `SyntheticSecret {id, raw, cores[], caseInsensitive?, keyOnly?}`
  generated at runtime (random base64url/alnum/hex/base58, freshly generated
  Ed25519 and P-256 PKCS#8 PEMs, BIP39-shaped mnemonics, JWT-shaped strings).
  No literal secret values exist in the file.
- Evasion helpers: `ZWSP` U+200B, `SOFT_HYPHEN` U+00AD, `RLO` U+202E, `PDF` U+202C,
  `LRI` U+2066, `PDI` U+2069, `NUL` U+0000, `BOM` U+FEFF, `C1_CSI` U+009B,
  `LONE_HIGH` U+D800; `withZeroWidth`, `withBidi`, `withNul`, `fullwidth`
  (shift 0x21-0x7E by +0xFEE0).
- `recoveryForms(s)` (`:190`) and `findLeaks(corpus, sinks, extraCores)` (`:222`):
  a leak = raw secret, any 10-character window of a high-entropy core, hex case
  variant, URL-encoded, JSON-escaped, base64, base64url or hex encoding
  (definition in `redact-sinks.test.ts:10-14`). `digestForms` checks that no
  secret-derived digest is emitted.
- `hostileDetail(corpus)` (`:258`) and `hostileText(corpus, maxLen=4000)` (`:299`) build
  structured / free-text hostile inputs.
Users: `redact.test.ts`, `redact-sinks.test.ts`, `operator-canonical.test.ts`,
`operator-server.test.ts`.

### 3.7 Shared helpers in `src/__tests__/mocks.ts`

- `createTestDb()` (`:321-325`): SQLite file in `mkdtemp(os.tmpdir()/automaton-test-)/test.db` via `createDatabase` (applies the fleet tables/triggers for Phase 1).
- Pinned fleet runtime for Phase 2+ (`:365-430`): a test pin with
  `repo: "https://github.com/example-fleet/automaton-fleet"`; `isFleetSandboxCheck(command)`
  recognises `FLEET_RUNTIME_VERIFY` or `/fleet-attest-[0-9a-f]+\.cjs/`; the mock
  sandbox answers attestation commands with `FLEET_ATTESTATION {json}` echoing the
  64-hex nonce; a helper stubs `FLEET_RUNTIME_REPO`, `FLEET_RUNTIME_COMMIT`,
  `FLEET_RUNTIME_BUILD_ID`, `FLEET_RUNTIME_LOCKFILE_SHA256`.
- `vi.mock("../../registry/erc8004.js", …)` in `fleet.test.ts:51`, `fleet-phase2.test.ts:68`,
  `fleet-phase3.test.ts:72` stubs the on-chain registry.

### 3.8 External programs the tests execute

| Program | Where | Missing-binary behaviour |
|---|---|---|
| `initdb`, `pg_ctl`, `psql` | `ephemeral-pg.ts` | block skipped (`findPgBin()` → null) |
| `node_modules/.bin/tsx` | `fleet.test.ts:342`, `fleet-phase2.test.ts:691` | test fails |
| `node --import tsx` | `bridge-tunnel.test.ts:178`, `bridge-mcp.test.ts:266` | test fails |
| `git` | `fleet-phase2.test.ts:320`, `fleet-phase3.test.ts:211-217,266` | test fails |
| `pnpm` | `fleet-phase3.test.ts:218-219` (opt-in only) | opt-in test fails |
| `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes` | `fleet-phase5.test.ts:797`, `fleet-phase6.test.ts:74` | test fails |
| `/usr/bin/ssh-keygen` (`-lf`, `-H -f`) | `bridge-unit.test.ts:149,171` | test fails |
| `/bin/sleep` | `bridge-tunnel.test.ts:218` (decoy pid) | test fails |
| `mkfifo` | `redact.test.ts:451` | test fails |
| `bash` | `chatgpt-tunnel-key.test.ts` (sources `scripts/fleet-chatgpt-tunnel-key.sh`) | test fails |
| `systemctl`, `ps` | `fleet-phase6.test.ts:283-289` (read-only, only when the unit is active) | early return (passes vacuously) |

---

## 4. Database and network requirements (all files)

| File | Database | Network |
|---|---|---|
| `fleet.test.ts` | SQLite temp files (`createTestDb`, `tmpDbPath`); cross-process test uses WAL | none |
| `fleet-phase2.test.ts` | non-PG part: SQLite; PG part: **external DSN** (§3.2), throwaway schema `fleet_test_<ulid>` | TCP to that DSN only; `UNREACHABLE_URL = "postgresql://nobody:nothing@127.0.0.1:1/none"` for fail-closed tests (`:79`) |
| `fleet-phase3.test.ts` | SQLite + ephemeral PG (schema `fleet`) | loopback HTTP (`FleetService.listen(0,"127.0.0.1")`); opt-in test may use the npm registry (`pnpm install --frozen-lockfile --prefer-offline`) |
| `fleet-phase4.test.ts` | ephemeral PG | loopback HTTP (`/healthz`, `/readyz`, `/v1/*`) |
| `fleet-phase5.test.ts` | ephemeral PG | loopback HTTP and loopback HTTPS with a throwaway self-signed P-256 certificate (`:794-819`) |
| `fleet-phase6.test.ts` | ephemeral PG (+ migration schemas `fleet_mig_v1`) | loopback HTTPS (`caFetch(cert)`), loopback admin HTTP; asserts `listen(0, "0.0.0.0")` over plain HTTP is refused (`:248`) — no socket is opened on 0.0.0.0 |
| `fleet-witness.test.ts` | ephemeral PG (+ `fleet_mig_v6`) | loopback HTTP |
| `fleet-witness-imports.test.ts` | none | none |
| `redact.test.ts` | none (uses a FIFO in a temp dir for scan-mode file safety) | none |
| `redact-sinks.test.ts` | in-process part none; PG part ephemeral | loopback HTTP (`:96`) |
| `operator-canonical.test.ts` | none | none |
| `operator-pg.test.ts` | two ephemeral clusters; schemas `mig_v8`, `mig_fail`, `op_mut`, `op_mut2`, `zz_other`, `fleet` | none |
| `operator-server.test.ts` | ephemeral PG via `fleet_operator_login` | loopback HTTP (OperatorService) |
| `bridge-unit.test.ts` | none | loopback hostile HTTP server (`:295-300`) |
| `bridge-tunnel.test.ts` | none | loopback sockets; fake ssh processes |
| `bridge-integration.test.ts` | ephemeral PG | loopback; fake ssh tunnel to the real OperatorService |
| `bridge-mcp.test.ts` | ephemeral PG (stdio part) | stdio JSON-RPC; fake ssh; asserts **no** listening socket by reading `/proc/net/{tcp,tcp6,unix}` and `/proc/<pid>/fd` (`:216-232`) |
| `chatgpt-adapter.test.ts` | ephemeral PG | Unix-domain socket (`<dir>/<name>.sock`) for the adapter; loopback HTTP for the OperatorService |
| `chatgpt-adapter-imports.test.ts` | none | none |
| `chatgpt-tunnel-key.test.ts` | none | none (log classification from synthetic strings) |
| `replication.test.ts` | SQLite | none |

No Fleet test contacts the Internet, the production VPS, OpenAI, GitHub or Conway
(the Conway client is always a mock). Exception: the opt-in reproducibility
test may reach the package registry if the pnpm store lacks packages.

---

## 5. Per-file inventory, grouped

Legend for each entry: **Feature** (what code is exercised), **Security invariants**
asserted, **DB**, **Network**, **Adversarial / mutation cases**, **Count**. Full
describe/it titles are in Appendix A.

### 5.1 Fleet core — phases 1-6

#### 5.1.1 `fleet.test.ts` — Phase 1 fleet control layer (42 tests)

- **Feature:** `FleetRegistry` (SQLite), `FleetPolicy`, `FleetController`, the
  `fleet` policy-engine rule (`src/agent/policy-rules/fleet.ts`), `spawnChild`
  grant gating, fleet schema migration in `createDatabase`.
- **Security invariants:**
  - defaults: cap 1, mode DEVELOPMENT, every real action disabled (`:130`);
    malformed `FLEET_MAX_AGENTS` values `"0","51","-2","2.5","abc","1e2",""` fail closed (`:140`); registry cap limited to 1..50 (`:151`);
  - state precedence EMERGENCY > DEVELOPMENT > HARVEST > EXPANSION (`:163`); DEVELOPMENT and
    `REAL_REPLICATION_ENABLED=false` both disable replication; HARVEST automatic at cap;
    EMERGENCY blocks non-essential spend but not survival top-ups;
  - global living cap under concurrency: 20 concurrent in-process requests, 20 from
    multiple controllers, and **20 OS processes** (`reserve-worker.ts`) at cap 2 → exactly 2 living (`:298-354`);
  - failed spawn releases its slot; an unclaimed grant cannot leave a dangling slot;
  - dead agents stay recorded, release their slot; terminal lifecycle → dead automatically;
  - financial eligibility: low survival tier, below parent reserve, missing snapshot all reject; child funding blocked while `REAL_PAYMENTS_ENABLED=false`;
  - bypass prevention: `spawnChild()` without a grant fails before any sandbox; forged / reused grants rejected;
    raw SQL inserts cannot exceed the cap (trigger backstop), trigger fails closed with no cap;
    `spawn_child` never touches Conway under defaults and never falls back to a local registry;
    shell tampering with fleet tables/code forbidden; guardrail files protected from self-modification
    (`src/fleet/registry.ts`, `policy.ts`, `controller.ts`, `dist/fleet/config.js`, `src/agent/policy-rules/fleet.ts`, `src/replication/spawn.ts`, `:618`).
  - policy rule denies `spawn_child` (DEVELOPMENT), `fund_child`, `transfer_credits` to members (payments off), EMERGENCY spend, and fails closed when the registry is unavailable.
- **DB:** SQLite temp files. **Network:** none.
- **Adversarial:** multi-process race with a busy-wait start barrier; raw-SQL cap bypass; forged grants; tool list `spawn_child, fund_child, start_child, transfer_credits, x402_fetch, create_sandbox, register_domain` under EMERGENCY (`:249`).

#### 5.1.2 `fleet-phase2.test.ts` — Phase 2 shared registry and pinned runtime (49 tests; 26 need `PG_URL`)

- **Feature:** pinned child runtime (`src/fleet/runtime.ts`), `spawnChild` runtime
  install/verification, child startup refusal, `SharedFleetController` +
  `PgFleetStore` shared registry, PostgreSQL-unavailable fail-closed behaviour.
- **Security invariants:**
  - upstream Conway Research repository rejected "in every spelling"; unsafe repos and non-SHA commits rejected
    (`"main","HEAD","v0.2.1","0123456", PIN.commit+"0", "g"*40, ""`, `:198`);
    an agent cannot pick a different repo/commit than the parent-approved pin;
  - install fetches exactly the pinned commit; verification rejects wrong commit, wrong origin, dirty tree, empty output;
    wrong sandbox commit rejected **before genesis or wallet init**; missing/upstream pin rejected before any sandbox;
  - child refuses to start on wrong commit, upstream manifest, modified sources, or missing manifest (a root needs none);
  - `.env.fleet` keeps `REAL_REPLICATION_ENABLED`, `REAL_PAYMENTS_ENABLED`, `OWNER_SWEEP_ENABLED` false (`:380`);
  - shell tampering with shared registry/runtime files forbidden (`:407` list); audit detail never stores secrets;
  - PostgreSQL down: health reports down, replication denied, no slot, policy denies replication tools only, `spawn_child` never touches Conway;
  - shared registry: migrations idempotent and **concurrent** (KI-1), required columns, no secret columns, `wallet_address` cannot hold a private key,
    schema version mismatch → store unavailable, stable agent ids, no duplicate on duplicate heartbeat;
  - cap 2 under 20 concurrent requests, 20 independent connections, 20 OS processes, randomized churn, and 20 concurrent raw-SQL connections (trigger);
  - counters read-only, history cannot be deleted or revived; slot returned on failed provision / failed activation; double release no-op;
    unclaimed reservations expire; registry outage mid-provision keeps the slot (fail-safe);
    duplicate child registration rejected; modes can only tighten; runtime pin must match the approved runtime; financial eligibility still gates.
- **DB:** SQLite + external PostgreSQL (§3.2). **Network:** TCP to the DSN only.
- **Adversarial:** randomized churn (`:708`), 20 OS processes (`pg-reserve-worker.ts`), raw-SQL bypass.
- **Known failures:** FLEET-KI-1 (`:588`), FLEET-KI-2 (`:611` via `reset()` → `wipe.ts`). See §9.2.

#### 5.1.3 `fleet-phase3.test.ts` — Phase 3 replication hardening (44 tests; 24 PG; 1 opt-in)

- **Feature:** reproducible builds (pnpm, frozen lockfile, `computeBuildIdentity`),
  runtime attestation (`parseAttestation`), child startup verification, privileged-env
  scrubbing, restricted PostgreSQL agent role, reservation leases, reaper,
  fleet service API + `FleetApiClient`.
- **Security invariants:**
  - pnpm with lockfile, no npm lockfile; install verifies the lockfile hash then `pnpm install --frozen-lockfile` (never `npm install`);
    parent-supplied verifier and controller compute the same build identity; the real repo tree hashes identically in both implementations;
  - attestation checks repo, commit, lockfile, build and nonce — not the child's commit alone;
  - child refuses start on missing approved build, lockfile mismatch, built output mismatch, missing lockfile;
  - controller DB, owner wallet, signing and admin secrets classified privileged; child env scrubbed;
    agent shell cannot see `DATABASE_URL`; `automaton --run` refuses admin DB credentials;
    shell guard blocks secret reads, env overrides, service commands, role changes; service URL must be https or loopback http without credentials;
  - PostgreSQL role tests (real roles): owner cannot create roles; agent role holds no table privileges;
    agent cannot modify the cap / any `fleet_state`, another agent, disable triggers, modify schema, create roles, create temp shadows (`CREATE SCHEMA evil`, `:599`),
    or reserve directly; lease columns; expiry releases reserved and stuck-provisioning slots; expired provisioning lease cannot activate;
    ACTIVE → UNRESPONSIVE → DEAD with slot release; recovery on heartbeat; configurable timeouts; outage grace window;
    duplicate cleanup harmless (concurrent reapers, double release, double death);
    activation requires runtime proof; a proof for one reservation cannot activate another; wrong build stopped before wallet init;
  - service API: refuses admin credentials; full flow request → claim → attest → activate → credential → heartbeat;
    service-level `REAL_REPLICATION_ENABLED=false` rejects (audited); bad/foreign credentials rejected and audited;
    reaped agent learns it is dead; self-retire releases slot; DB authorization failure audited.
- **DB:** SQLite + ephemeral PG. **Network:** loopback HTTP.
- **Mutation record:** `FLEET.md:335` "over-granting the agent role or skipping attestation makes 6 tests fail".
- **Opt-in:** `FLEET_REPRO_TEST=1` → two clean clones built with `--frozen-lockfile` yield the same build identity (600 s timeout).

#### 5.1.4 `fleet-phase4.test.ts` — Phase 4 deployment readiness (53 tests; 26 PG)

- **Feature:** secret files (`src/fleet/secret-files.ts`), systemd credential exceptions
  for `service.env` and `tls.key`, deployment artifacts (`deploy/systemd/*`, `scripts/*`),
  least-privilege roles, privilege audit, service role, reaper, doctor.
- **Security invariants (non-PG):**
  - secret files: 0600 KEY=VALUE accepted; world/group-readable and symlinks refused; unreadable fails clearly (skipped as root, `:126`);
    service loader never reads `admin.env`, warns about legacy `.env.fleet`;
  - `service.env` systemd credential: accepted at 0440 and stricter; an ordinary secret file at 0440 still rejected;
    world-readable / group-writable / group-executable rejected; symlink and path escapes rejected; a fake `CREDENTIALS_DIRECTORY` cannot bypass;
    source must stay root-owned 0600; unit name read from `/proc/self/cgroup` (`0::/system.slice/automaton-fleet.service`);
  - `tls.key` credential: implicit `$CREDENTIALS_DIRECTORY/tls.key` accepted at 0440; an **explicit `FLEET_TLS_KEY_FILE` always gets the strict check** (`:316`);
    mode matrix; symlinks, hard links, non-regular files, traversal rejected; requires the `automaton-fleet.service` identity;
    `SYSTEMD_SECRET_CREDENTIALS` keys are exactly `["service.env","tls.key"]`, `tls.key` source `/etc/automaton-fleet/tls/fleet.key` (`:404-405`); `tls.crt` "is not a known secret credential"; `../tls.key` "invalid credential name"; TLS off unless a certificate is configured, a key alone refused;
  - artifacts: service unit runs as its own user, loopback, restart-rate-limited, secrets via LoadCredential; agent unit is another user;
    remote drop-in maps exactly `LoadCredential=tls.crt:/etc/automaton-fleet/tls/fleet.crt` and `LoadCredential=tls.key:/etc/automaton-fleet/tls/fleet.key`;
    setup scripts dry-run by default, DB passwords on stdin not argv; every shipped config keeps REAL_* flags off;
    agents cannot read controller secrets, run deployment commands, change grants, edit Phase 4 code; service binds loopback only;
    JSON-line structured logs scrub credentials; child provisioning uses `pnpm install --frozen-lockfile`.
- **Security invariants (PG):** idempotent migration to the current version; admin-only migrations (service/agent logins refused);
  privilege audit passes for intended grants and **fails for 8 over-grant cases** (`:731-741`: UPDATE `fleet_state` to agent, column UPDATE `max_agents`,
  SELECT `fleet_agent_credentials` to service, INSERT `fleet_agents` to service, EXECUTE `fleet_reserve_slot(…)` to agent, CREATE on schema to agent,
  TEMPORARY on database to service login, EXECUTE `api_fleet_state()` to PUBLIC); agent role and service role negative matrices;
  wrong repo/commit/build prevents activation **even when the controller's own check is bypassed**; missing attestation or replayed nonce refused by the DB;
  approved runtime immutable while a release runs; stale heartbeat/leases cleaned once; parent-reported death rules;
  service refuses wrong DB role / over-broad privileges / missing DB / runtime mismatch; healthz/readyz, graceful drain;
  agents fail closed when the service is unavailable; claims for another runtime release refused; dead agents' sandboxes queued for termination and "unsupported" recorded;
  doctor verdicts (deployment OK but real replication UNSAFE; FAIL on missing DB/service/OS users/legacy secrets/enabled flag; over-privileged agent role is a blocker; runtime mismatch fails).
- **DB:** ephemeral PG. **Network:** loopback HTTP.

#### 5.1.5 `fleet-phase5.test.ts` — Phase 5 lifecycle, remote auth, treasury (43 tests; 23 PG)

- **Feature:** treasury engine (`src/fleet/treasury/*`), sweep waterfall, capital performance, fleet bank,
  rate limiter, remote-listen rules, lifecycle health challenges, signed sessions, custody, FleetAdmin controls.
- **Financial invariants:** base sweep 10% early; mature base 45% at 50 living agents; max 70% and never beyond;
  approved obligations, 30-day runway, current approved growth allocation are never swept (expired allocation stops protecting);
  **owner funding is never revenue/profit and never swept**; only undistributed profit swept (no double sweep);
  temporary opportunity reduction ends at expiry; random-input invariant: retained ≥ protected, rate ∈ [0, max] (`:247`);
  discretionary allocations follow performance; rescue never automatic; owner distribution only above reserve target and obligations, limited to surplus;
  **spend execution never happens with payments disabled or without a controller signer** (`:328`).
- **Security invariants:** rate limiter burst/refill; remote listening needs explicit enablement AND TLS;
  provisioning tracked from claim; another parent cannot report provisioning; health challenges; heartbeat-only zombie → UNRESPONSIVE → TERMINATING → ORPHANED;
  stale health alone makes ACTIVE UNRESPONSIVE; failing policy canary = failed health check; orphan limit blocks replication; quarantine slots count against cap;
  quarantined agent cannot act; long-lived credential only opens sessions, sessions cannot open sessions; token scoped to one agent;
  **replayed request refused — single-use nonce shared across service instances** (`:701-727`, including a second service instance and a tampered nonce);
  stale timestamps / expired sessions refused; requests after death/quarantine/revocation refused; per-agent and per-address failure rate limits;
  audit without secrets; HTTPS served when TLS configured (plain HTTP to the TLS port fails);
  **an agent can propose capital but never approve its own exception** (approvers tried: the kid's agent id, the root's agent id, the kid's wallet, `:838`);
  admin actions recorded, never executed; cross-wallet access refused; frozen/unhealthy/revoked agents cannot spend; approved spends never executed.
- **DB:** ephemeral PG. **Network:** loopback HTTP + HTTPS (openssl self-signed).
- **Mutation record:** `FLEET.md:595` — removing the policy canary check, letting heartbeats restore health, skipping the nonce ledger, or not protecting growth capital each fails tests.

#### 5.1.6 `fleet-phase6.test.ts` — Phase 6 control plane and dry-run child (29 tests; 16 PG)

- **Feature:** runtime identity (`src/fleet/runtime-verify.ts`), HTTPS controller config (`tlsProblemsForHost`),
  OS-identity secret model (`osUserCanRead`), dry-run child (`src/fleet/dry-run/*`), provisioning intents,
  `svc_provision_reconcile`, `runDoctor` readiness levels, migration v1→v5→v6→v7→v8.
- **Security invariants:** pin mismatch (repo/commit) rejected; build-ID mismatch rejected (pin vs approved, installed tree vs pin);
  lockfile hash checked before install and a failing frozen install aborts provisioning; `scripts/fleet-build-runtime.sh` and
  `scripts/fleet-deploy-release.sh` use `pnpm install --frozen-lockfile`;
  remote binding requires TLS + public hostname + covering certificate; plain HTTP on non-loopback rejected
  ("plain-HTTP binding on non-loopback", `:248`); the service starts only under its dedicated user;
  firewall/drop-in expose only HTTPS; agent user cannot read controller secrets (`admin.env`, `service.env`, `tls/fleet.key`);
  dry-run child refuses REAL_* / sweep flags, DB/controller credentials or a wallet key; agents cannot run Phase 6 operator commands;
  (PG) migration verified transactionally then applied with data preserved and least privilege kept; restricted roles cannot migrate;
  duplicate provisioning retry → one logical child; intent durable **before** creation; callback loss → ORPHANED + quarantine + revocation;
  never-created sandbox reconciled as absent only after the activation deadline; provisioning key binds callbacks;
  HTTPS remote + loopback-only plain admin; health exposes no secrets; **PostgreSQL not reachable through the service**
  (paths `/v1/db`, `/v1/sql`, `/v1/query`, `/../../postgres`, `/v1/admin/set-cap`, `:768`; no CONNECT, no PG protocol);
  dry-run child: pinned install → attestation → activation → HTTPS session → heartbeat → challenge → ACTIVE;
  **zero spend authority** (keyless address, custody frozen at 0, no capital, no spend); cannot replicate; can be quarantined;
  fleet stays ≤ 2 living/reserved/quarantined; dry run requires cap ≤ 2 and REAL_* off; doctor reports SAFE FOR DRY RUN / REAL REPLICATION / REAL PAYMENTS independently.
- **Host-conditional tests:** `:280` returns early unless `automaton-fleet.service` is active; `:342` returns early unless `/etc/automaton-fleet` exists. On a host without the deployment they pass without asserting anything.
- **DB:** ephemeral PG. **Network:** loopback HTTPS/HTTP.
- **Mutation record:** `FLEET.md:720` — removing the uncertain→ORPHANED rewrite or the custody freeze each fails tests.

#### 5.1.7 `src/__tests__/replication.test.ts` — spawn path under fleet gating (20 tests)

Fleet relevance: `spawnChild` now requires a FleetController slot reservation
(`fleetGrant(db)` builds a `FleetRegistry` grant, `:29-40`), and children install
the pinned fleet runtime (`isFleetSandboxCheck` in the mock sandbox, `:122-140`).
Tests: `isValidWalletAddress` (10), `spawnChild` error handling (7), `SandboxCleanup` (2), `pruneDeadChildren` (1). SQLite, no network.
`src/__tests__/agent/worker-inference-bridge.test.ts` was checked: it contains no fleet reference and is **not** fleet-related.

### 5.2 Security (cross-cutting)

Security coverage is spread through every file; the `test:security` script selects it by
name. Files whose describe names contain "security"/"policy": `fleet.test.ts`,
`fleet-phase2..6`, `fleet-witness*`. The Operator/bridge/ChatGPT/redaction files carry
security assertions but are **not** selected by `test:security` by describe name.

### 5.3 Financial

Selected by `test:financial` (`financial|spend|treasury`): `fleet.test.ts` "Fleet financial eligibility (treasury)";
`fleet-phase2.test.ts` "Fleet financial safety flags (treasury)"; `fleet-phase3.test.ts` "Fleet financial safety flags remain disabled (treasury)";
`fleet-phase4.test.ts` "financial safety: every shipped config…" (title match);
`fleet-phase5.test.ts` four "Fleet financial: …" describes + "financial safety: spend execution…";
`fleet-phase6.test.ts` "financial: the dry-run child has zero spend authority…";
`fleet-witness.test.ts` "Fleet security financial: witness capability scope (PostgreSQL)".
Plus pre-fleet upstream suites (`financial.test.ts`, `spend-tracker.test.ts`) that match by name.

### 5.4 B0 redaction

#### 5.4.1 `redact.test.ts` (76 effective tests; no DB)

- **Feature:** `src/fleet/redact.ts` (`redactText`, `redactDetail`, `scrubDetail` contract) and `src/fleet/redact-scan.ts`.
- **Invariants:** every text secret class removed in raw, embedded, zero-width, bidi, NUL and fullwidth forms (27 tests);
  rules have no word-boundary anchors; existing markers used as prefix shield nothing and exact markers are idempotent;
  a non-secret `NAME=` never hides a following secret; never throws (Proxy with throwing traps) and never falls back to raw;
  structured secrets under secret key names redacted whatever the shape; Solana byte arrays (≥ 32 integers 0..255);
  real BIP39 mnemonics redacted, prose not, stopwords never BIP39 words;
  no over-redaction (public build identities only under an exact field name and format; phase-2 `scrubDetail` contract kept);
  bounds (depth, width, key/string length, record size); output cuts after matching (a secret straddling the bound never leaks); input cut never reaches output;
  exotic values (circular, binary, dates, errors without stack, bigint, symbols, functions, NaN, Maps, class instances);
  getters never invoked; `__proto__` stored as data (no prototype pollution); NUL/C0/C1/bidi/zero-width removed, NFKC, lone surrogates repaired;
  envelope keys cannot override the log envelope; deterministic and idempotent; scan counts classes without reporting matched text; scan is unbounded;
  static guards: redactor/scanner protected from self-modification; witness/dry-run child log only through the redacting logger; every CLI error line uses `redactText`; the service audit path redacts once and fans out.
- **Adversarial:** 20 × 1 MiB ReDoS-style inputs with bounded time and output (§2.2); FIFO for scan file safety (`:451`).

#### 5.4.2 `redact-sinks.test.ts` (12 tests; 4 PG)

- **Feature:** sink convergence — service stdout logger, JSONL audit file + stdout copy (`createAuditSink`, `src/fleet/service/log.ts:40-47`),
  `FleetService` audit()/recordDb(), HTTP path/Authorization header, witness/dry-run line logger; PG: `recordEvent` (service role), owner store `event()`, treasury store `event()`, reason columns.
- **Invariants:** the same redacted representation in every sink; 100-key detail truncated identically in JSONL, stdout and DB;
  no sink or union of sinks leaks; no getter ran; **detector sanity** (an unredacted serialization is flagged — proves a bypassed sink would fail);
  NUL no longer drops the event (`:184`).

### 5.5 B2 Operator API

#### 5.5.1 `operator-canonical.test.ts` (41 effective; no DB)

- **Feature:** `src/fleet/operator/*` canonical signing FLEET-OP-SIG-V1, target parsing, header rules, route policy, typed responses, keygen, startup refusals.
- **Invariants:** pinned vector reproduced (public key, key id, canonical string, deterministic Ed25519 signature) and verified by an independent WebCrypto implementation;
  the signature binds every field; signatures must be canonical base64url of exactly 64 bytes;
  **reject, never normalize** (18 generated rejection cases + oversize > 3000-char target);
  exactly one of each header; `Authorization` and `Cookie` rejected; missing/duplicate/comma-joined/malformed headers rejected;
  shipped route policy is exactly the v1 read surface; adding a mutating/unknown/out-of-scope route fails verification; agent ids lowercase ULIDs;
  agent service registers no operator route; `untrusted_text` redacted, flattened, stripped of evasion characters, bounded; events rebuilt from the allow-list, IPs and raw actors dropped;
  audit-capacity thresholds `ok < 50% ≤ info < 75% ≤ elevated < 100% ≤ full`;
  keygen writes 0600 exclusively and prints only public material; startup refuses root, foreign credentials, readable controller secrets, safety switches, non-loopback listen, missing pins;
  `operator.env` accepted only root-owned, own-group, single-link, no symlinks (no broadened exception); agents cannot touch the Operator API; operator modules and the v8 migration protected from self-modification.

#### 5.5.2 `operator-pg.test.ts` (20 tests; all PG; two clusters)

- **Feature:** schema v8 (`src/fleet/postgres/migrations-phase8.ts`), `op_*` functions, `PgOperatorGateway`, `PgOperatorAdmin`, `operatorSurfaceProblems` (`src/fleet/postgres/privileges.ts:292`).
- **Invariants:** v7 → v8 on a production-shaped empty registry: exact check (rolled back), apply, idempotent; v8 code refuses v7; failing v8 migration atomic;
  operator role executes exactly the `op_*` allow-list, owns nothing, reads no table;
  **catalog mutations** of the operator surface detected or refused (routes CHECK: `svc_mark_dead`, `op_begin_request`, `op_evil` rejected; route UPDATE → `FLEET_HISTORY_IMMUTABLE`; STABLE write attempts fail);
  static audit catches 11 hidden-write cases (read side: dynamic SQL, quoted call, `nextval`, `pg_advisory_lock`, `set_config`, `pg_notify`, indirect helper, function in another schema; begin side: quoted UPDATE target, dynamic UPDATE, MERGE);
  READ ONLY runtime barrier; principal/key constraints (fingerprint ids, 90-day cap, ≤ 2 active keys, immutability, final revocation, no deletion);
  operator principals can never approve; `op_begin_request` fails closed in every case and accepts one use of a nonce;
  Amendment 3 (accepted read changes only operator bookkeeping); Amendment 1 (50%/75% warnings, fail closed at 100%, no automatic deletion, audited archival);
  archival owner-only and verified before deletion; nonce purge in bounded batches by accepted requests only;
  login identity is exactly the restricted role; key add vs concurrent revocation (lock then check); DB denial events bounded per minute;
  role provisioning states: none = not provisioned (valid across audit, doctor, 16-item checklist), only `fleet_operator` = FAIL, only `fleet_operator_login` = FAIL, both correct = PASS, wrong privileges/attributes = FAIL (added in `4d6a0be`).

#### 5.5.3 `operator-server.test.ts` (10 tests; all PG)

- **Feature:** `OperatorService` over HTTP with the real gateway and real signatures.
- **Invariants:** typed bodies; pages larger than B0's width bound are complete; no corpus secret in any response; agent text always `untrusted_text`;
  **negative matrix** (`:213-253`): unknown route / agent route on the operator listener / POST → 404 `FLEET_OP_NOT_FOUND`; trailing slash, uppercase → 400 `FLEET_OP_NONCANONICAL`;
  Authorization, Cookie, missing header, duplicate header (raw socket), body, chunked → 400 `FLEET_OP_BAD_REQUEST`; ±31 s → 401 `FLEET_OP_STALE`;
  signature for another path, another principal's key, unknown principal, ChatGPT requesting events → 401 `FLEET_OP_AUTH_FAILED`; missing scope → 403 `FLEET_OP_SCOPE_DENIED`;
  replayed nonce → 409 `FLEET_OP_REPLAYED`; bad queries `limit=0`, `limit=201`, `limit=abc`, `after=x`, duplicate, unsorted, `zzz=1`, trailing `&` → 400;
  immediate revocation; kill switch; `FLEET_OP_AUDIT_FULL`; per-principal rate limits with a shared junk-identity budget; `/readyz` loopback Host only and cached;
  denied-request audit lines budgeted and summarised; audit without signatures, nonces, public keys, Authorization values; startup refuses owner/service credentials, runtime mismatch, admin credentials.

### 5.6 Phase D bridge (Claude, dev VM tooling)

#### 5.6.1 `bridge-unit.test.ts` (18 tests; no DB)
Config strictness and atomic 0600 save; refuses group-writable/symlinked/hard-linked config; fixed shell-free ssh argv pinning host key, identity and the single forward
(`-L 127.0.0.1:40001:127.0.0.1:8788`, `:132`); ssh failure classification; fingerprints identical to `ssh-keygen -lf`; only one plain `ssh-ed25519` line with the pinned fingerprint;
pinned line built from a hashed `known_hosts` offline; strict response validation (accepts real server builders, rejects every deviation, accepts only a B0 marker in place of a formatted value);
model view adds provenance + notice and shows invisible/bidi/control characters; key loading (id match, not locally expired) and expiry classes `ok > 21 days, warn, critical ≤ 7, expired, unknown`;
hostile server: exactly one signed GET with five signing headers; every failure → fail-closed code; unsupported targets refused before any byte
(`/v1/operator/treasury`, `/v1/operator/agents/<id>/approve`, `/v1/state`, `/v1/operator/status?x=1`, `:373`); agents may not run or edit the bridge.

#### 5.6.2 `bridge-tunnel.test.ts` (10 tests; no DB; real processes)
Ephemeral tunnel: exact argv, listener ownership proof, endpoint verification, full cleanup; disabled Operator API reported as readiness;
no process left on every ssh failure; foreign port holder never used; wrong pinned host key or unprotected identity never starts ssh; SIGTERM → SIGKILL escalation;
ephemeral tunnel dies with its opener (no orphan). Persistent tunnel: up → reused → down with a 0600 state file; a recorded pid not provably ours (decoy `/bin/sleep 30`) dropped and **never signalled**; endpoint loss tears down.

#### 5.6.3 `bridge-integration.test.ts` (6 tests; PG)
Real OperatorService + gateway; whoami/status/agents (paged)/agent/events strictly validated; server denials mapped to fail-closed codes (scope, kind, replay, clock, wrong/revoked key, not found);
kill switch and audit-full fail closed, CLI sends nothing while disabled; CLI over the fake tunnel; tunnel up/status/down; **key rotation add → verify → switch → revoke → finish**, each step refusing out-of-order execution.

- **Mutation record (commit `bfb9c62`, design `phase-d-claude-bridge.md:172-176`):** 12 security mutations killed — host-key TOFU, no preflight, no listener-ownership proof, no pid-reuse check, unknown fields allowed, untrusted kind unchecked, status/code pairing unchecked, identity unchecked, finishing rotation without revocation proof, sending while disabled, no escaping, no route pre-check.

### 5.7 D2 MCP (`bridge-mcp.test.ts`, 9 tests; 2 PG)

In-process: `initialize` advertises tools only; exactly five read-only tools (`fleet_whoami`, `fleet_status`, `fleet_list_agents`, `fleet_get_agent`, `fleet_list_events`) with closed schemas;
calls before `initialize`, unknown tools (`shell`, `bash`, `fleet_exec`, `fleet_query`, `fleet_set_cap`, `FLEET_WHOAMI`, `"fleet_whoami "`, `fleet_status\0`, `../fleet_status`, `42`, `null`, `:87`) and malformed/out-of-bounds arguments refused;
unsupported methods (`resources/list`, `resources/read`, `prompts/list`, `prompts/get`, `sampling/createMessage`, `completion/complete`, `logging/setLevel`, `shell/exec`, `:78`);
parse errors, batches, oversized lines, malformed envelopes rejected; notifications get no reply; Phase D model view verbatim;
bridge failures (`HOST_KEY_MISMATCH`, `TUNNEL_NOT_OPERATOR_API`, `TUNNEL_AUTH_FAILED`, `API_DISABLED`, `API_NOT_READY`, `AUTH_FAILED`, `KEY_EXPIRED`, `MALFORMED_RESPONSE`, `IDENTITY_MISMATCH`, `REPLAYED`, `TIMEOUT`, `:167`) propagate as structured errors without internals;
calls serialized; validator mirrors the published schema.
Stdio process (PG): stdout protocol only, stderr clean, **no listening socket** (`/proc/net/tcp`, `tcp6`, `unix` + `/proc/<pid>/fd`), untrusted text preserved, clean exit; SIGTERM or stdin close during a hanging tunnel leaves no ssh process.
- **Mutation record (commit `cb42f87`; design `phase-d-claude-bridge.md:283-287`):** 10 MCP boundary mutations killed.

### 5.8 Phase C ChatGPT adapter

#### 5.8.1 `chatgpt-adapter.test.ts` (8 tests; all PG)
Exactly four read-only tools (no events) over a stateless transport (refused names: `fleet_list_events`, `fleet_events`, `fleet_http_get`, `request`, `shell`, `fleet_set_cap`, `:161`);
reads through the real Operator API with hostile agent text kept as `untrusted_text` in text and `structuredContent`; path-injection arguments refused (`{agent_id:"../../v1/operator/events"}`, extra `route`, `?x=1`, `:185`);
HTTP hardening over the Unix socket (`:194-206`): missing/wrong/truncated token → 401; foreign Host → 421; foreign Origin → 403; GET/DELETE → 405; wrong path → 404; `text/plain` → 415; 70 000-byte body → 413; batch → JSON-RPC −32600; parse error → −32700;
rate limit and queue bound; identity gate (Claude principal/key or wrong scopes refused every call); revocation, kill switch and a **foreign 8788 listener** fail closed;
startup refuses foreign credentials, readable secrets, loose config and key; audit log 0600 JSON lines with tool, code, Operator request id — never token, signatures, nonces or keys.

#### 5.8.2 `chatgpt-adapter-imports.test.ts` (2 tests)
`vi.mock` throws for `pg`, `fleet/postgres/store`, `fleet/operator/gateway`, `fleet/operator/admin`, `fleet/treasury/store`, `identity/wallet`, `fleet/bridge/tunnel`, `fleet/bridge/cli`; control proves mocks are live; adapter entry point and dependency tree load without them.

#### 5.8.3 `chatgpt-tunnel-key.test.ts` (5 tests)
Sources `scripts/fleet-chatgpt-tunnel-key.sh` in bash; input travels via stdin never argv (`:18-22`). Synthetic keys only.
No prefix/length allowlist (current and future key shapes pass); paste artefacts stripped (bracketed-paste markers, CR, surrounding spaces/tabs);
garbage refused with a category that never echoes input; OpenAI verdict read only from the tunnel's own log lines; entry point refuses unprivileged or non-TTY execution; sourcing runs nothing.
- **Mutation record:** Phase C code (`6691b4c`): 11 security mutations killed (design `phase-c-chatgpt-adapter.md:184`, incl. A9 audit-completeness); tunnel-key helper (`e49d287`): 6 mutations killed.
- **Not covered by automated tests:** `efad214` (rollback on every exit path) and `aed747e` (echo off / typeahead discard) were found by **manual production pty attack tests**; no automated test for the EXIT-trap rollback or typeahead handling exists in `chatgpt-tunnel-key.test.ts`.

### 5.9 Witness (FLEET-KI-4)

#### 5.9.1 `fleet-witness.test.ts` (26 effective; 13 PG)
Route policy: every route `FleetService.route()` serves has exactly one policy entry and vice versa; witness is exactly session, heartbeat, health challenge, self; unknown routes/scopes fail closed.
Startup refusals: uid 0, true safety switches (`REAL_PAYMENTS_ENABLED`, `REAL_REPLICATION_ENABLED`, `OWNER_SWEEP_ENABLED`, also in `runtime.env`), privileged env vars, wallet files, readable controller secrets, runtime identity mismatch before any network access; challenge answer reports the pinned identity.
Isolation: static import graph of `fleet/dry-run/root-main.ts` and `root-witness.ts` reaches no forbidden module (`identity/`, `conway/`, `inference/`, `ollama/`, `replication/`, `survival/`, `orchestration/`, `heartbeat/`, `memory/`, `soul/`, `social/`, `skills/`, `self-mod/`, `registry/`, `setup/`, `agent/(loop|tools|harnesses)`, `fleet/treasury/`, `fleet/dry-run/operator.ts`, `index.ts`) or package (`viem`, `openai`, `@anthropic-ai/`, `@solana/`, `better-sqlite3`, `ethers`); only four endpoints called; systemd unit hardening.
PG: v6 → v7 migration (existing agents → scope `full`); `enroll-witness-root` keyless root, scope witness, frozen custody, 0600 file, token never returned; scope immutable; session/heartbeat/challenge/self only;
every other `/v1` route → 403 `FLEET_SCOPE_DENIED` with no side effect; invented token → unauthenticated with no scope event; unknown route → 404; `fleet_authenticate` denies non-allowed `api_*`; rotation keeps scope; full agents unchanged;
witness refused by the normal allocator and accepted by the dry-run reservation; live run then UNRESPONSIVE after stop; refuses a full-scope credential and exits once retired.
- **Mutation record:** `FLEET.md:804` — removing `authorize()` or the DB scope check each fails a test.

#### 5.9.2 `fleet-witness-imports.test.ts` (2 tests)
`vi.mock` throws for `identity/wallet`, `identity/provision`, `conway/inference`, `conway/client`, `conway/x402`, `inference/inference-client`, `inference/router`, `ollama/discover`, `agent/loop`, `agent/tools`, `replication/spawn`, `fleet/treasury/store`; the witness still loads.

---

## 6. Mutation / adversarial testing summary

| Area | Evidence | Kind |
|---|---|---|
| Phase 3 | `FLEET.md:335` — over-grant agent role / skip attestation → 6 failing tests | manual mutation run |
| Phase 4 | 8 in-test over-grant mutations (`fleet-phase4.test.ts:731-741`); `FLEET.md:475` claims 11 | in-test mutation (automatic) |
| Phase 5 | `FLEET.md:595` — 4 mutations | manual mutation run |
| Phase 6 | `FLEET.md:720` — 2 mutations | manual mutation run |
| Witness | `FLEET.md:804` — 2 mutations | manual mutation run |
| B0 | detector-sanity tests (`redact.test.ts:373`, `redact-sinks.test.ts:142`); design §18.5 item 6: removing both redaction layers → 40 leaks | in-test + manual |
| B2 | catalog mutations and 11 static-audit hidden-write cases in `operator-pg.test.ts:224-332`; design §18.6 "mutation runs show each test fails without its fix" | in-test + manual |
| Phase D | 12 mutations killed (`bfb9c62`) | manual |
| D2 | 10 mutations killed (`cb42f87`) | manual |
| Phase C | 11 mutations killed (`6691b4c`); tunnel key helper 6 killed (`e49d287`) | manual |
| Concurrency | 20-process cap races (SQLite and PostgreSQL), randomized churn, concurrent reapers, concurrent migration | in-test |
| Parsing / DoS | 20 × 1 MiB redactor inputs, 18 non-canonical targets, oversize bodies/lines, JSON-RPC batch/parse errors | in-test |

"Manual" mutation runs are recorded in commit messages / design docs; the mutated
variants are **not** in the repository and cannot be re-run from it.

---

## 7. Deployment verification (not vitest)

### 7.1 `fleet-phase4.test.ts` / `fleet-phase6.test.ts` static artifact checks
See §5.1.4 and §5.1.6: unit files, drop-in LoadCredential lines, setup scripts dry-run default, stdin passwords, shipped flags, loopback binding, firewall script.

### 7.2 `scripts/fleet-verify-deployment.sh` (185 lines; `sudo`, read-only, exit 1 on any failure, exit 2 when not root)

| Section | Checks (PASS/FAIL lines) |
|---|---|
| Secrets vs OS identities (`:27-43`) | For each of `automaton-agent`, `automaton-fleet-service`, `automaton-fleet-witness`, `automaton-fleet-operator-api` (the last two may be absent → PASS "not created"): cannot read `/etc/automaton-fleet/admin.env`, `service.env`, `tls/fleet.key`, `legacy-env-fleet.bak` (each if present), checked with `runuser -u <u> -- test -r`. Witness is in no other group. |
| Operator API isolation (`:45-81`) | operator user in no other group; `operator.env` not a symlink and exactly `root:automaton-fleet-operator-api 640 1`; `automaton-agent`, service, witness and `$SUDO_USER` cannot read it; it contains none of `FLEET_ADMIN_DATABASE_URL, FLEET_SERVICE_DATABASE_URL, FLEET_AGENT_DATABASE_URL, FLEET_CONTROLLER_DATABASE_URL, DATABASE_URL, PGPASSWORD, REDIS_URL, CONWAY_API_KEY, WALLET_PRIVATE_KEY, PRIVATE_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, FLEET_CREDENTIALS_FILE, CREDENTIALS_DIRECTORY`; port 8788 loopback-only when the unit is active; `timedatectl NTPSynchronized=yes`; `/run/systemd/timesync/synchronized` exists. |
| ChatGPT adapter isolation (`:83-119`) | adapter and tunnel users each in no other group; `chatgpt-adapter.json` `root:automaton-fleet-chatgpt-adapter 640 1`; `chatgpt-tunnel/adapter-token` `root:root 600 1`; `chatgpt-tunnel/` `root:root 700`; `openai-api-key` `root:root 600 1` or PASS "not yet provided"; `/var/lib/automaton-fleet-chatgpt-adapter/bridge-chatgpt.key` `adapter:adapter 600 1`; socket `/run/automaton-fleet-chatgpt/adapter.sock` `adapter:tunnel 660`, not writable by agent/service/witness/operator-api/`$SUDO_USER`; 10 cross-read pairs denied; neither user holds a TCP listener. |
| TLS material (`:121-152`) | `tls/` `root:automaton-fleet-admin 750`; `fleet.key` `root:root 600` single link; `fleet.crt` `root:root 644` single link (absent → PASS "remote HTTPS disabled"); drop-in LoadCredential lines exactly tls.crt/tls.key; `runtime.env` does not set `FLEET_TLS_KEY_FILE`; `FLEET_TLS_CERT_FILE`, if set, is exactly `/run/credentials/automaton-fleet.service/tls.crt` (FAIL only; no PASS line). |
| Repository `.env.fleet` (`:153-158`) | holds none of `DATABASE_URL`, `FLEET_ADMIN_DATABASE_URL`, `FLEET_CONTROLLER_DATABASE_URL`, `REDIS_URL`. |
| Service identity (`:160-172`) | `automaton-fleet.service` active; main PID runs as `automaton-fleet-service`; `/proc/<pid>/environ` has no DB DSN. |
| Network exposure (`:174-184`) | 5432, 6379, 8787 loopback-only or closed; reports whether `FLEET_REMOTE_LISTEN_ENABLED=true`. |

The number of PASS lines depends on installed components (recorded: 17/17, 19/19, 23/23, 36, 60 — §10).

### 7.3 `pnpm fleet:verify` (doctor `--checklist`, `src/fleet/doctor.ts:456-535`) — 16 items

1 PostgreSQL roles correct · 2 schema v8 (`FLEET_PG_SCHEMA_VERSION`) · 3 controller service active ·
4 privileged secrets protected · 5 runtime repo pinned · 6 runtime commit pinned · 7 build ID pinned (and lockfile) ·
8 HTTPS valid · 9 remote controller reachable · 10 replay protection working · 11 agent credentials scoped ·
12 payments disabled · 13 owner sweeps disabled · 14 fleet cap = 2 (literal, `doctor.ts:530`) ·
15 no unresolved orphan · 16 no stuck reservation.
Tested by `fleet-phase6.test.ts:967` and `operator-pg.test.ts:768` (16-item checklist in the not-provisioned state).

---

## 8. How to run (reconstruction guidance)

Prerequisites on a clean Ubuntu host: Node 22 (production records v22.23.3), pnpm
(repository-pinned 10.28.1 per runbook), `pnpm install --frozen-lockfile`, PostgreSQL
server binaries (`postgresql-16` → `/usr/lib/postgresql/16/bin/{initdb,pg_ctl,psql}`), `git`,
`openssl`, `openssh-client` (`/usr/bin/ssh-keygen`), `coreutils` (`mkfifo`, `sleep`), `bash`.
Run as a non-root user (one Phase 4 test is skipped as root; the ephemeral cluster's
`initdb` refuses to run as root).

Recommended per-area commands (all avoid the full-suite hang):
```bash
pnpm test:fleet            # all 20 fleet files (505 tests; 178 need PostgreSQL binaries / PG_URL)
pnpm test:operator         # 71
pnpm test:bridge           # 43
pnpm test:chatgpt          # 15
pnpm test:redact           # 88
pnpm test:witness          # 28
pnpm test:deploy           # 53
pnpm test:phase5           # 43
pnpm test:phase6           # 29
npx vitest run src/__tests__/replication.test.ts
npx tsc --noEmit
```
To exercise the Phase 2 PostgreSQL block without touching a real registry, set
`FLEET_TEST_DATABASE_URL` to a disposable database owned by the connecting role
(it creates and drops `fleet_test_<ulid>`); otherwise the block is skipped or, if
`/etc/automaton-fleet/admin.env` is readable, silently targets that database (§3.2).

Whole-suite workaround recorded by the operator (memory `preexisting-test-hangs.md`):
```bash
npx vitest run --exclude src/__tests__/context-hardening.test.ts
npx vitest run src/__tests__/context-hardening.test.ts -t '^(?!.*buildContextMessages token budget)'
```

---

## 9. Known pre-existing failures and hangs

### 9.1 Full-suite hang — `src/__tests__/context-hardening.test.ts`

- Describe `"buildContextMessages token budget"` at `src/__tests__/context-hardening.test.ts:104`
  (tests at `:105`, `:113`, `:127`, `:144`, `:165`) never finishes: a synchronous CPU spin, so
  `pnpm test` / `pnpm test:ci` / `pnpm test:coverage` never exit.
- Not fleet code. The file was last changed upstream in `2c717cf` (2026-02-19, "Phase 1: Runtime Reliability"),
  before `baseline-before-fleet`. Recorded as pre-existing on 2026-09-23 on a clean worktree (operator memory).
- Workaround: §8.

### 9.2 Fleet Phase 2 PostgreSQL failures (FLEET-KI-1, FLEET-KI-2)

| ID | Test | Symptom | Frequency (records) |
|---|---|---|---|
| FLEET-KI-1 | `fleet-phase2.test.ts:588` "migrations are idempotent and safe to run concurrently" | `error: tuple concurrently updated` from `REVOKE ALL ON ALL TABLES IN SCHEMA … FROM PUBLIC, <role>` in `PgFleetStore.grantAgentRole` (`src/fleet/postgres/store.ts:778`), called from `migrate()` (`store.ts:571-573`) **outside** the migration advisory lock | every run (operator record at `03f8760`) |
| FLEET-KI-2 | `fleet-phase2.test.ts:611` "wallet_address cannot hold a private key" (fails in `reset()` before the body) | `error: deadlock detected` at `TRUNCATE … RESTART IDENTITY CASCADE` in `fixtures/wipe.ts:19` | intermittent |

Both were first confirmed on `2d6d4cf` (fleet-v0.6) with identical results on clean HEAD
(`docs/fleet-known-issues.md:6-35`). Only runs where `PG_URL` resolves are affected; the
ephemeral-cluster files do not run concurrent migrations. Full analysis and current code
verification: `18-KNOWN-ISSUES.md`.

### 9.3 Silent-pass / skip conditions that can hide coverage

- 178 PostgreSQL tests are **skipped** (not failed) if `findPgBin()` finds no binaries or `PG_URL` is empty. A green run without PostgreSQL binaries is not evidence for the DB layer.
- `fleet-phase6.test.ts:280` and `:342` return early (pass) when the deployment is not installed on the test host.
- `fleet-phase4.test.ts:126` is skipped as root; `fleet-phase3.test.ts:208` runs only with `FLEET_REPRO_TEST=1`.

---

## 10. MOST RECENT KNOWN RESULTS (from records)

These are **recorded** results (commit messages, runbook, design docs, operator
session records). They were not re-run by this documentation pass.

### 10.1 Unit / integration test results

| Date (2026) | Commit / state | Command / file | Recorded result | Source |
|---|---|---|---|---|
| 09-23 | `2d6d4cf` | `fleet-phase6.test.ts` | 29 tests (Phase 6), REAL_* stay off | commit `2d6d4cf` message |
| 09-23 | `2d6d4cf` clean HEAD | `fleet-phase2.test.ts` | KI-1 fails; KI-2 can fail (deadlock) | `docs/fleet-known-issues.md:8,23`; commit `2319e57` |
| 09-23 | `d8f8168` (= `baseline-before-fleet`) clean worktree | `pnpm test` | never exits (context-hardening hang) | operator memory `preexisting-test-hangs.md` |
| 09-24 | `03f8760` (B0) | regression | phase2 KI-1 (every run) and KI-2 (intermittent) identical on clean HEAD | operator session record (B0-1R) |
| 09-24 | B2-2 working tree (uncommitted, before B2-3 review and `4d6a0be`) | `pnpm test:operator` | **59/59**; regression green except KI-1 (identical on HEAD) | operator session record (B2-2) |
| 09-25 | `4d6a0be` | operator role provisioning tests | 4 tests added: neither / only group / only login / both correct / both wrong | commit `4d6a0be` message |
| 09-25 | `bfb9c62` (Phase D) | `pnpm test:bridge` | **18 + 10 + 6** (unit + tunnel + integration) = 34; 12 security mutations killed | operator session record; commit `bfb9c62` |
| 09-25 | `cb42f87` (Phase D2) | `bridge-mcp.test.ts` | **9/9**; 10 MCP boundary mutations killed | operator session record; commit `cb42f87` |
| 09-25 | `6691b4c` (Phase C) | ChatGPT adapter tests | pass (count not recorded in the message); 11 security mutations killed | commit `6691b4c` |
| 09-25 | `e49d287` | `chatgpt-tunnel-key.test.ts` | pass with synthetic keys; 6 mutations killed | commit `e49d287` |
| 09-25 | `aed747e`, `efad214` | tunnel key helper | defects found by **production pty attack tests** (manual), then fixed; no new automated test recorded | commit messages |

Reconciliation with current static counts:
- `test:operator` is now **71** effective tests (41 + 20 + 10). At `5a5469e` it was 41 + 16 + 10 = 67; `4d6a0be` added 4 (`operator-pg.test.ts:768-822`). The recorded **59/59** was for the uncommitted B2-2 tree before the B2-3 review additions; the exact per-file split of the 59 is not recorded. **DRIFT (record vs code):** no recorded run of the current 71.
- `test:bridge` now also includes `bridge-mcp.test.ts`, so it is **43** (34 + 9).
- `test:chatgpt` is **15** (8 + 2 + 5); no recorded count.

### 10.2 Deployment verification results (production VPS unless noted)

| Date / stage | Runtime | `fleet-verify-deployment.sh` | `fleet:verify` | Other | Source |
|---|---|---|---|---|---|
| 09-24 S5 (stages 12-13) | `11c0c7c` | 17/17 PASS | — | `audit-privileges` PASS | runbook `:84-89` |
| 09-24 stage 20 | `11c0c7c` | 19/19 PASS | — | doctor: HTTPS valid, remote reachable | runbook `:107` |
| 09-24 S9 (stage 21) | `11c0c7c` | — | SAFE FOR DRY RUN YES | cap 1 → 2, event 26 | runbook `:108` |
| 09-24 S9b | `cdfd70c`, schema v7 | all PASS | 16/16 PASS, SAFE FOR DRY RUN YES | doctor DEPLOYMENT OK (warnings: sandbox termination, wallet custody); verify-runtime VERIFIED; audit PASS | runbook `:123-135` |
| 09-24 B0-6 | `03f8760` | 23/23 | 16/16 | doctor OK | operator session record |
| 09-25 B2-8 | `4d6a0be`, schema v8 | — | 16/16 | verify-runtime VERIFIED | runbook `:1188` |
| 09-25 B2 closeout | `4d6a0be` | **36 PASS** | 16/16, DEPLOYMENT OK, SAFE FOR DRY RUN YES | Operator API `/readyz` 200, kill switch on | runbook `:1199-1201` |
| 09-25 Stage C | `4d6a0be` + adapter `6691b4c` | **60 PASS / 0 FAIL** | 16/16, doctor DEPLOYMENT OK | audit PASS with 2 principals / 2 keys; external: 8788, 8787, 5432, 6379, 8080 closed | runbook `:1224` |

<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->

---

## 11. RESULTS FROM THIS DOCUMENTATION PASS

Run on the dev VM (Node v22.23.2, repository HEAD `efad214`, clean tree) on 2026-09-25 between 11:35 and ~11:50 UTC. Only local, self-contained suites were run. Suites that use the dev VM's fleet database and wipe it (`fleet-phase2`–`fleet-phase6`, `fleet-witness`) were **deliberately not run**: they mutate a persistent local database, and phase2 can fall back to the `admin.env` DSN. Nothing touched production.

| Command | Files | Tests | Result |
|---|---|---|---|
| `npx tsc --noEmit` | — | — | **PASS** (rc 0, no diagnostics) |
| `vitest run fleet.test.ts fleet-witness-imports.test.ts` | 2 | 44 | **44/44 PASS** |
| `vitest run redact.test.ts redact-sinks.test.ts` (= `test:redact`) | 2 | 88 | **88/88 PASS** |
| `vitest run operator-canonical/operator-pg/operator-server` (= `test:operator`, throwaway initdb cluster) | 3 | 71 | **71/71 PASS** |
| `vitest run bridge-unit/bridge-tunnel/bridge-integration/bridge-mcp` (= `test:bridge`, fake ssh + throwaway cluster) | 4 | 43 | **43/43 PASS** |
| `vitest run chatgpt-adapter/chatgpt-adapter-imports/chatgpt-tunnel-key` (= `test:chatgpt`) | 3 | 15 | **15/15 PASS** |
| **Total run** | 14 | 261 | **261/261 PASS** |

This is the first recorded run of the 71-test `test:operator` (the earlier record was 59/59 on the B2-2 tree). Not run in this pass: `fleet-phase2..6` (DB-wiping; the last records show KI-1 failing every run and KI-2 failing intermittently), `fleet-witness.test.ts` (DB), the full suite (hangs on context-hardening), and `scripts/fleet-verify-deployment.sh` (production, sudo).

---

## Appendix A — Complete describe / it titles (mechanically extracted)

Format: `L<line>` **kind[modifier]** — title. Indentation follows source nesting.
Template-literal titles marked *(one test per iteration)* expand as listed in §2.2.

#### `src/__tests__/fleet/fleet.test.ts`

- `L129` **describe** — Fleet policy: configuration defaults
  - `L130` **it** — defaults to a single agent, DEVELOPMENT, and all real actions disabled
  - `L139` **it** — fails closed on malformed values
  - `L151` **it** — registry rejects caps outside 1..50
- `L162` **describe** — Fleet policy: operating states
  - `L163` **it** — computes state precedence EMERGENCY > DEVELOPMENT > HARVEST > EXPANSION
  - `L173` **it** — real replication is disabled in DEVELOPMENT even with REAL_REPLICATION_ENABLED=true
  - `L185` **it** — real replication is disabled when REAL_REPLICATION_ENABLED=false
  - `L194` **it** — HARVEST disables replication (configured)
  - `L206` **it** — HARVEST is selected automatically when the living count reaches the cap
  - `L216` **it** — EMERGENCY disables replication (runtime flag and configured mode)
  - `L239` **it** — EMERGENCY blocks non-essential expenditure tools but not survival top-ups
- `L259` **describe** — Fleet policy: global living-agent cap
  - `L264` **it** — FLEET_MAX_AGENTS=1 rejects reproduction (the root occupies the only slot)
  - `L277` **it** — cap 2 allows one child
  - `L289` **it** — cap 2 rejects the second child
  - `L298` **it** — 20 concurrent requests at cap 2 result in exactly 2 living agents
  - `L310` **it** — 20 concurrent requests from multiple parents/controllers at cap 2 yield exactly 2 living agents
  - `L333` **it** — 20 concurrent OS processes at cap 2 result in exactly 2 living agents
  - `L356` **it** — a failed spawn releases its reserved slot
  - `L371` **it** — a spawn function that never claims its grant cannot leave a dangling slot
- `L382` **describe** — Fleet policy: dead agents
  - `L387` **it** — dead agents remain recorded
  - `L406` **it** — dead agent releases its living slot
  - `L422` **it** — a child reaching a terminal lifecycle state is recorded dead automatically
- `L442` **describe** — Fleet financial eligibility (treasury)
  - `L447` **it** — rejects replication in low survival tiers
  - `L457` **it** — rejects replication below the parent reserve
  - `L464` **it** — fails closed when the financial snapshot is unavailable
  - `L473` **it** — child funding is blocked while REAL_PAYMENTS_ENABLED=false
- `L492` **describe** — Fleet security: replication bypass prevention
  - `L505` **it** — direct spawnChild() without a fleet grant fails before any sandbox is created
  - `L513` **it** — forged and reused grants are rejected
  - `L531` **it** — raw SQL inserts cannot exceed the cap (database trigger backstop)
  - `L544` **it** — the trigger fails closed when no cap has been configured
  - `L556` **it** — spawn_child tool is blocked under default configuration and never touches Conway
  - `L575` **it** — spawn_child tool never falls back to the local registry (Phase 2: shared registry required)
  - `L602` **it** — a child automaton cannot replicate against its own local registry
  - `L609` **it** — shell tampering with fleet tables and fleet code is forbidden
  - `L617` **it** — fleet guardrail files are protected from self-modification
- `L626` **describe** — Fleet policy engine rule
  - `L652` **it** — is registered in the default rule set
  - `L656` **it** — denies spawn_child in DEVELOPMENT
  - `L662` **it** — denies fund_child while real payments are disabled
  - `L668` **it** — denies transfer_credits to a fleet member while real payments are disabled
  - `L680` **it** — denies EMERGENCY expenditure via the policy engine
  - `L687` **it** — fails closed when the registry is unavailable
  - `L694` **it** — denied spawn_child via executeTool never reaches the tool
- `L708` **describe** — Fleet schema migration
  - `L709` **it** — createDatabase applies the fleet tables and triggers

#### `src/__tests__/fleet/fleet-phase2.test.ts`

- `L169` **describe** — Fleet security: pinned child runtime validation
  - `L170` **it** — rejects the upstream Conway Research repository in every spelling
  - `L186` **it** — rejects arbitrary/unsafe repositories and non-SHA commits
  - `L204` **it** — an agent cannot choose a different repo or commit than the parent-approved pin
  - `L212` **it** — install command fetches exactly the pinned commit of the fleet fork
  - `L220` **it** — verification rejects wrong commit, wrong origin, dirty sources and empty output
  - `L228` **it** — FLEET_RUNTIME_REPO/COMMIT are parsed into config; invalid values yield no pin
- `L237` **describe** — Fleet security: spawnChild uses the pinned fleet runtime
  - `L259` **it** — child uses the pinned fleet runtime and never clones upstream (correct commit accepted)
  - `L271` **it** — wrong commit in the sandbox is rejected before genesis or wallet init
  - `L279` **it** — upstream repo pin is rejected before any sandbox is created
  - `L287` **it** — missing pin is rejected before any sandbox is created (both spawn paths)
  - `L296` **it** — start_child refuses a child whose runtime cannot be verified
- `L313` **describe** — Fleet security: child refuses startup on unverifiable runtime
  - `L343` **it** — accepts the correct pinned commit
  - `L349` **it** — refuses a wrong commit
  - `L355` **it** — refuses an upstream manifest
  - `L360` **it** — refuses modified sources
  - `L370` **it** — refuses a child with no manifest; a root needs none
- `L379` **describe** — Fleet financial safety flags (treasury)
  - `L380` **it** — .env.fleet keeps real replication, payments and owner sweep disabled
  - `L393` **it** — shared-registry and runtime tampering via shell is forbidden; new guard files are protected
  - `L412` **it** — audit detail never stores secrets
- `L427` **describe** — Fleet policy: PostgreSQL unavailable fails closed
  - `L448` **it** — health check reports the registry down
  - `L455` **it** — replication is denied and no slot is granted
  - `L463` **it** — policy rule denies replication tools but not ordinary work
  - `L486` **it** — spawn_child tool fails closed without touching Conway
- `L505` **describe.skipIf(!PG_URL)** — Fleet policy: shared PostgreSQL registry
  - `L588` **it** — migrations are idempotent and safe to run concurrently
  - `L595` **it** — schema holds the required columns and no secret columns
  - `L611` **it** — wallet_address cannot hold a private key
  - `L621` **it** — schema version mismatch makes the store unavailable (fail closed)
  - `L630` **it** — agent ids are stable: re-registering the same wallet returns the same agent
  - `L641` **it** — duplicate heartbeat does not duplicate the agent
  - `L657` **it** — 20 concurrent requests at fleet cap 2 yield exactly 2 living/reserved agents
  - `L674` **it** — 20 concurrent requests from 20 independent agent connections at cap 2 yield exactly 2
  - `L686` **it** — 20 concurrent OS processes at cap 2 yield exactly 2 living/reserved agents
  - `L708` **it** — no race can exceed the cap: randomized churn with failures and deaths
  - `L740` **it** — raw SQL cannot exceed the cap even from 20 concurrent connections (trigger backstop)
  - `L759` **it** — counters are read-only and history cannot be deleted or revived
  - `L772` **it** — failed provision returns the slot
  - `L794` **it** — releasing twice is a no-op the second time (no double release)
  - `L815` **it** — a slot whose activation fails (runtime not verified) is returned
  - `L828` **it** — unclaimed reservations expire and free their slot; expired grants cannot be claimed
  - `L842` **it** — registry outage mid-provision keeps the slot occupied (fail-safe)
  - `L860` **it** — duplicate child registration is rejected (same wallet, same request, double activation)
  - `L897` **it** — dead agents stay recorded but do not count toward the cap
  - `L918` **it** — a child reaching a terminal lifecycle state is marked dead in the shared registry
  - `L939` **it** — modes: shared DEVELOPMENT/EMERGENCY and local env can only tighten
  - `L964` **it** — runtime pin must match the fleet-approved runtime (wrong commit / arbitrary repo / cleared)
  - `L986` **it** — financial eligibility still gates shared replication
  - `L1000` **it** — a registered child agent can replicate against the shared cap; unregistered cannot
  - `L1023` **it** — spawn_child tool succeeds only through the shared registry and stops at the shared cap
  - `L1042` **it** — policy rule uses shared counts and a stale snapshot fails closed

#### `src/__tests__/fleet/fleet-phase3.test.ts`

- `L139` **describe** — Fleet security: reproducible child builds (pnpm, frozen lockfile)
  - `L140` **it** — the repository uses pnpm with a lockfile and no npm lockfile
  - `L147` **it** — child install verifies the lockfile hash, then runs pnpm install --frozen-lockfile (never npm install)
  - `L160` **it** — install refuses without an approved build identity
  - `L165` **it** — the parent-supplied verifier computes the same build identity as the controller
  - `L196` **it** — the real repository tree hashes identically in both implementations
  - `L208` **it.runIf(process.env.FLEET_REPRO_TEST === "1")** — two clean clones built with --frozen-lockfile have the same build identity
- `L233` **describe** — Fleet security: runtime attestation checks
  - `L240` **it** — accepts an attestation matching repo, commit, lockfile, build and nonce
  - `L244` **it** — does not rely on the child's commit alone: build, lockfile, nonce, cleanliness and proof are all checked
- `L260` **describe** — Fleet security: child refuses startup when lockfile/build cannot be verified
  - `L288` **it** — starts when lockfile and build identity match
  - `L293` **it** — refuses when the manifest carries no approved build identity
  - `L300` **it** — refuses when the lockfile does not match
  - `L306` **it** — refuses when the built output differs from the approved build
  - `L317` **it** — refuses when the lockfile is missing entirely
- `L330` **describe** — Fleet security: agent processes never receive privileged secrets
  - `L331` **it** — classifies controller DB, owner wallet, signing and admin secrets as privileged
  - `L343` **it** — scrubs privileged variables and builds a clean child env, keeping allowed tools usable
  - `L352` **it** — agent shell commands (local exec) do not see DATABASE_URL even if it is in the process env
  - `L365` **it** — the automaton refuses to --run with admin DB credentials in its environment
  - `L377` **it** — shell guard blocks secret reads, env overrides, service commands and role changes
  - `L398` **it** — the fleet service only accepts https (or loopback http) URLs without credentials
- `L406` **describe** — Fleet financial safety flags remain disabled (treasury)
  - `L407` **it** — .env.fleet keeps real replication, payments and owner sweep disabled
- `L423` **describe.skipIf(!PG_BIN)** — Fleet security policy: restricted PostgreSQL agent role
  - `L531` **it** — the owner cannot create roles (like production fleetadmin); the agent role holds no table privileges
  - `L548` **it** — agent cannot modify the fleet cap (or any fleet_state setting)
  - `L556` **it** — agent cannot change another agent (direct SQL or through the API with its own token)
  - `L583` **it** — agent cannot disable triggers
  - `L594` **it** — restricted credentials cannot modify schema, create roles, or create temp shadows
  - `L618` **it** — agent cannot directly reserve arbitrary slots; only the authenticated API can, within every gate
  - `L651` **it** — reservation lease records reservation_id, agent_id, created_at, expires_at, status and expectations
  - `L666` **it** — expired reservation releases its slot (reserved and stuck-provisioning leases)
  - `L691` **it** — a provisioning lease past expiry cannot be activated even before the reaper runs
  - `L703` **it** — missed heartbeats: ACTIVE -> UNRESPONSIVE -> DEAD, and the dead agent releases its living slot
  - `L737` **it** — an unresponsive agent that heartbeats again recovers to ACTIVE
  - `L748` **it** — heartbeat timeouts are configurable
  - `L759` **it** — a reaper/service outage does not kill agents that could not report (grace window)
  - `L769` **it** — duplicate cleanup is harmless: concurrent reapers, double release, double death
  - `L802` **it** — activation requires runtime proof; failure stops activation, releases the reservation and marks provisioning failed
  - `L828` **it** — controller records expected repo/commit/build per reservation; a proof for one reservation cannot activate another
  - `L846` **it** — spawnChild with a sandbox reporting the wrong build is stopped before wallet init; slot released as failed
  - `L871` **describe** — fleet service API (agents hold no DB credentials)
    - `L905` **it** — the service refuses to run agent calls with the admin credentials
    - `L912` **it** — end to end: request -> claim -> attest -> activate -> child credential -> child heartbeat
    - `L946` **it** — service-level REAL_REPLICATION_ENABLED=false rejects replication (audited)
    - `L957` **it** — bad or foreign credentials are rejected and audited; one parent cannot touch another's reservation
    - `L981` **it** — a reaped agent learns it is dead on its next heartbeat (onDead) and can no longer act
    - `L1002` **it** — agents can retire themselves; the retired slot is released
    - `L1011` **it** — a database authorization failure inside the service is audited

#### `src/__tests__/fleet/fleet-phase4.test.ts`

- `L97` **describe** — Fleet security: secret files
  - `L106` **it** — reads a 0600 secret file and parses KEY=VALUE
  - `L112` **it** — refuses world- or group-readable secret files and symlinks
  - `L126` **it.skipIf(process.getuid?.() === 0)** — an unreadable secret file fails clearly (no silent fallback)
  - `L137` **it** — the service loader never reads admin.env and warns about legacy .env.fleet secrets
- `L149` **describe** — Fleet security: systemd credential exception for service.env
  - `L179` **it** — accepts the systemd credential at 0440 and stricter modes
  - `L187` **it** — an ordinary secret file at 0440 is still rejected
  - `L197` **it** — rejects world-readable, group-writable and group-executable credentials
  - `L210` **it** — rejects symlink and path escapes
  - `L233` **it** — a fake CREDENTIALS_DIRECTORY cannot bypass validation
  - `L252` **it** — requires the source secret to stay root-owned 0600
  - `L262` **it** — reads the unit name from the process cgroup
- `L274` **describe** — Fleet security: systemd credential exception for tls.key
  - `L307` **it** — accepts the implicit tls.key credential at 0440 and stricter modes
  - `L316` **it** — an explicit FLEET_TLS_KEY_FILE always gets the strict check, even inside CREDENTIALS_DIRECTORY
  - `L333` **it** — mode matrix: rejects world bits and group write/execute
  - `L349` **it** — rejects symlinks, hard links, non-regular files and path traversal
  - `L376` **it** — requires the automaton-fleet.service identity and trusted ownership
  - `L403` **it** — credential-name isolation: only service.env and tls.key get the exception, each only at its own path
  - `L430` **it** — TLS stays off unless a certificate is configured; a key alone is refused
- `L440` **describe** — Fleet security: deployment artifacts (systemd, scripts, flags)
  - `L444` **it** — the fleet service unit runs as its own user, loopback only, restart-rate-limited, secrets via LoadCredential
  - `L460` **it** — the agent unit runs as a different user and cannot see the fleet secrets
  - `L470` **it** — TLS credentials: explicit LoadCredential mappings, source permissions, remote still disabled
  - `L514` **it** — setup scripts are dry-run by default and pass DB passwords on stdin, never argv
  - `L527` **it** — financial safety: every shipped config keeps replication, payments and owner sweep disabled
  - `L537` **it** — security: agents cannot read controller secret files, run deployment commands, change grants or edit the Phase 4 code
  - `L559` **it** — the fleet service binds loopback only
  - `L567` **it** — structured logs are JSON lines with level/event and scrub credentials
  - `L576` **it** — child provisioning uses pnpm install --frozen-lockfile and never lets the child pick its runtime
- `L592` **describe.skipIf(!PG_BIN)** — Fleet security policy: least-privilege roles, service, reaper and doctor
  - `L703` **it** — migration is idempotent and reaches the current schema version; the role script is re-runnable
  - `L711` **it** — administrative migrations require the privileged admin credential (service and agent logins refused)
  - `L719` **it** — the effective privilege audit passes for the intended grants
  - `L730` **it** — the audit FAILS when agent or service permissions are too broad
  - `L781` **it** — security: the agent role cannot alter schema, create roles, alter triggers, change the cap, touch another agent, reserve directly or read credentials
  - `L805` **it** — security: the service role operates the fleet but cannot change the cap/mode/runtime/switch, insert agents, issue arbitrary credentials or read hashes
  - `L835` **it** — wrong repo, wrong commit or wrong build id prevents activation — even when the controller's own check is bypassed
  - `L869` **it** — a missing attestation or replayed nonce is refused by the database check
  - `L881` **it** — the approved runtime is immutable while a release is running (clearing is always allowed)
  - `L898` **it** — stale heartbeat: ACTIVE -> UNRESPONSIVE -> DEAD via the service role; the slot is released once
  - `L914` **it** — stale reservation and stale provisioning leases are cleaned up and counted by the doctor query
  - `L929` **it** — idempotent, auditable cleanup: double release, double death, concurrent reapers, duplicate termination results
  - `L948` **it** — parent-reported death: unactivated child released now; quiet child dies now; heartbeating child is deferred until quiet; other parents are refused
  - `L975` **describe** — fleet service (restricted service role, loopback, health, drain)
    - `L993` **it** — refuses the wrong DB role: owner as service DSN, admin credential present, agent DSN = service DSN
    - `L1009` **it** — refuses to start when its privileges are too broad
    - `L1018` **it** — missing database: startup fails closed
    - `L1024` **it** — refuses to start when its runtime release differs from the registry-approved runtime
    - `L1030` **it** — healthz/readyz, replication still disabled, structured logs, and a graceful drain
    - `L1087` **it** — service unavailable: agents fail closed (no heartbeat, no replication)
    - `L1094` **it** — claims/activations for a lease expecting another runtime release are refused and the slot released
    - `L1117` **it** — dead agents' sandboxes are queued for controller termination; unsupported termination is recorded, not hidden
  - `L1141` **describe** — fleet:doctor readiness verdict
    - `L1174` **it** — fully deployed: deployment OK, but real replication UNSAFE (termination + remote networking blockers) and reported facts
    - `L1209` **it** — missing DB, service unavailable, missing OS users, legacy secrets and an enabled flag all FAIL
    - `L1233` **it** — no DB configured and an over-privileged agent role are both blockers
    - `L1246` **it** — stale agents/reservations are reported; a runtime release mismatch fails
  - `L1263` **it** — privilege audit is also usable from any connection (e.g. the service role) and sees the same result

#### `src/__tests__/fleet/fleet-phase5.test.ts`

- `L112` **describe** — Fleet financial: dynamic sweep policy
  - `L113` **it** — 10% base sweep at early fleet size
  - `L124` **it** — the mature-fleet base rate (45%, configurable) applies at 50 living agents
  - `L131` **it** — the rate can reach the configured maximum (70%) for highly capitalised mature agents, never beyond
  - `L150` **it** — the rate reflects maturity, surplus, treasury need, recent losses and productive use
- `L168` **describe** — Fleet financial: waterfall never sweeps protected capital
  - `L169` **it** — approved operating obligations cannot be swept
  - `L180` **it** — protected runway (30 days of burn by default) cannot be swept
  - `L191` **it** — an approved, current growth allocation cannot be swept; an expired one stops protecting capital
  - `L205` **it** — genuine excess capital from profit is swept
  - `L213` **it** — owner funding is never treated as revenue or profit, and is never swept as profit
  - `L225` **it** — only undistributed profit is swept (prior sweeps are not swept twice)
  - `L235` **it** — a strong opportunity can temporarily reduce the sweep; the reduction ends at expiry
  - `L247` **it** — invariant under random inputs: retained capital always covers everything protected; rate within [0, max]
- `L275` **describe** — Fleet financial: capital performance, discretionary capital and rescue
  - `L279` **it** — strong agents earn larger discretionary allocations; weak agents progressively lose them
  - `L296` **it** — the profile is internal: no single public score, but consistency, efficiency and loss ratio are tracked
  - `L303` **it** — emergency rescue is discretionary: never automatic, and advised against for chronic failure
- `L314` **describe** — Fleet financial: fleet bank and owner distributions
  - `L315` **it** — treasury reserve blocks owner distribution
  - `L321` **it** — owner distribution works only above the reserve target (and obligations), limited to the surplus
  - `L328` **it** — financial safety: spend execution never happens with payments disabled or without a controller signer
- `L343` **describe** — Fleet security: remote control plane primitives
  - `L344` **it** — rate limiter enforces burst and refill
  - `L354` **it** — remote listening requires explicit enablement AND TLS
- `L368` **describe.skipIf(!PG_BIN)** — Fleet security policy: lifecycle, remote auth, custody and treasury (PostgreSQL)
  - `L498` **it** — privilege audit still passes with the Phase 5 schema
  - `L505` **it** — provisioning is tracked from claim; a sandbox is recorded the moment it exists; a failed activation stays visible for cleanup
  - `L529` **it** — another parent cannot report provisioning for a reservation; the activation sandbox must match the provisioned one
  - `L542` **it** — health challenges: an honest agent passes; an unresponsive agent recovers only by passing a challenge
  - `L565` **it** — a heartbeat-only zombie cannot remain healthy forever: failed challenges -> UNRESPONSIVE -> TERMINATING -> ORPHANED (capabilities revoked)
  - `L596` **it** — stale health alone (no answers at all) makes an ACTIVE agent UNRESPONSIVE even with fresh heartbeats
  - `L611` **it** — a failing policy canary counts as a failed health check
  - `L621` **it** — orphan policy: unresolved orphans beyond the limit block replication; quarantine slots count against the cap; hold expiry and operator resolution
  - `L643` **it** — a quarantined agent cannot replicate, act or authenticate
  - `L661` **it** — the long-lived credential only opens sessions; sessions cannot open sessions
  - `L675` **it** — forged / wrong-agent identity is refused (token scoped to one agent)
  - `L701` **it** — a replayed request is refused (single-use nonce, shared across service instances)
  - `L729` **it** — stale timestamps and expired sessions are refused; the client transparently opens a new session
  - `L751` **it** — requests after death, quarantine or credential revocation are refused
  - `L771` **it** — rate limiting: per-agent request limit and per-address authentication-failure limit
  - `L784` **it** — every API request is audit-logged without secrets
  - `L794` **it** — the service serves HTTPS when TLS is configured
  - `L819` **it** — an agent can propose capital but can never approve its own exception
  - `L846` **it** — FleetAdmin controls: approve, reject, change, reduce sweep, freeze, custody transfer (recorded, never executed)
  - `L864` **it** — an agent cannot access another agent's wallet; frozen, unhealthy or revoked agents cannot spend; approved spends are never executed
  - `L890` **it** — treasury: separate destinations, reserve target in months, owner distribution only from surplus (planned, never executed)
  - `L909` **it** — sweep plans from registry data respect the waterfall and are recorded as not executed
  - `L930` **it** — discretionary limits are enforced on approval unless explicitly overridden

#### `src/__tests__/fleet/fleet-phase6.test.ts`

- `L146` **describe** — Fleet security: Phase 6 pinned runtime identity
  - `L149` **it** — runtime pin mismatch is rejected (repository or commit differs)
  - `L160` **it** — build ID mismatch is rejected (pin vs approved, and an installed tree vs the pin)
  - `L186` **it** — frozen-lockfile failure is rejected: lockfile hash checked before install; a failing frozen install aborts provisioning
  - `L207` **it** — the runtime uses pnpm install --frozen-lockfile everywhere it is built
- `L216` **describe** — Fleet security: Phase 6 HTTPS controller configuration
  - `L225` **it** — HTTPS is required for remote binding: TLS, a public hostname and a certificate covering it
  - `L244` **it** — HTTP remote binding is rejected everywhere (config, listener, admin listener)
  - `L260` **it** — the service starts only under its dedicated OS user (never root)
  - `L280` **it** — live deployment (when installed): the unit runs as automaton-fleet-service
  - `L292` **it** — firewall and remote drop-in expose only HTTPS; PostgreSQL/Redis/admin HTTP stay closed
- `L310` **describe** — Fleet security: Phase 6 privileged secrets vs OS identities
  - `L317` **it** — the agent user cannot read controller secrets (mode/owner model), and a world-readable secret is detected
  - `L342` **it** — live deployment (when installed): automaton-agent cannot read any controller secret file
  - `L352` **it** — a dry-run child refuses to run with payment/sweep/replication switches, DB or controller credentials, or a wallet key
  - `L368` **it** — agents cannot run the Phase 6 operator commands or flip exposure/safety switches
- `L389` **describe.skipIf(!PG_BIN)** — Fleet security policy: Phase 6 control plane, provisioning intents and dry-run child (PostgreSQL)
  - `L503` **it** — migration v1 -> v5 -> v6 -> v7 -> v8: verified transactionally (rolled back), then applied; data preserved; privileges still least
  - `L536` **it** — migrations (and the transactional check) cannot be performed by the restricted agent or service role
  - `L546` **it** — duplicate provisioning retry creates one logical child (lost create response -> found by provisioning key)
  - `L587` **it** — the intent is durable BEFORE creation: if it cannot be recorded, no sandbox is created; the controller caps create attempts
  - `L600` **it** — provisioning callback loss is reconciled: ORPHANED + quarantine slot + capabilities revoked, found by name, cleanup record kept
  - `L644` **it** — an intent whose sandbox was never created is reconciled as absent only after the activation deadline; the slot is freed
  - `L667` **it** — a known sandbox whose registration never completes keeps the Phase 5 policy: FAILED_PROVISIONING, cleanup queued, no slot
  - `L679` **it** — the provisioning callback over the service carries the provisioning key; another key or parent is refused
  - `L706` **it** — the service serves HTTPS remotely and plain HTTP only on loopback for administration; health exposes no secrets
  - `L744` **it** — PostgreSQL cannot be reached through the fleet service (no proxy, no CONNECT, no PG protocol)
  - `L811` **it** — dry-run child: pinned install, attestation, activation, session over HTTPS, heartbeat and passed challenge -> ACTIVE
  - `L846` **it** — financial: the dry-run child has zero spend authority (keyless address, custody frozen at 0, no capital, no spend)
  - `L874` **it** — the dry-run child cannot replicate (service, registry and database guards)
  - `L908` **it** — the dry-run child can be quarantined: capabilities revoked, heartbeats refused, quarantine slot held within the cap
  - `L934` **it** — the fleet stays at maximum 2 living/reserved/quarantined slots; the dry run requires cap <= 2 and REAL_* flags off
  - `L967` **it** — fleet:doctor reports SAFE FOR DRY RUN / REAL REPLICATION / REAL PAYMENTS as independent levels

#### `src/__tests__/fleet/redact.test.ts`

- `L54` **describe** — B0 redactor: every secret class is removed from free text
    - `L56` **it** — ${s.id}: raw, embedded, zero-width, bidi, NUL and fullwidth forms  *(one test per iteration — see count note)*
  - `L74` **it** — each rule catches its own class on its own, even with characters glued in front (no word-boundary anchors)
  - `L94` **it** — an existing marker used as a prefix shields nothing; exact markers stay (idempotence)
  - `L105` **it** — a non-secret NAME= never hides a following secret assignment (config rule resumes after the name)
  - `L112` **it** — never throws, even for exotic input (Proxy with throwing traps); never falls back to the raw value
  - `L119` **it** — structured secrets under secret key names are redacted whatever the value shape
  - `L133` **it** — Solana-style byte arrays (>= 32 integers 0..255) are redacted
  - `L139` **it** — real BIP39 mnemonics are redacted; ordinary prose is not; stopwords are never BIP39 words
- `L166` **describe** — B0 redactor: no over-redaction of public, non-secret values
  - `L167` **it** — keeps ordinary audit detail unchanged
  - `L188` **it** — public build identities survive only under an exact field name with an exact format
  - `L200` **it** — keeps the phase-2 contract of scrubDetail (key names, 0x64 hex, URL credentials, wallet addresses)
- `L213` **describe** — B0 redactor: structure, bounds and unexpected values
  - `L214` **it** — recurses arrays at any depth within the bound and replaces deeper subtrees whole
  - `L224` **it** — bounds width (arrays and objects), key length, string length and record size
  - `L240` **it** — output cuts happen after matching: a secret straddling the output bound never leaks
  - `L250` **it** — the input cut can never reach the output (maxString is far below maxInput), even for secrets at the cut
  - `L262` **it** — handles circular, binary, dates, errors (no stack), bigint, symbols, functions, NaN, Maps and class instances
  - `L309` **it** — never invokes getters (object or array index) and survives throwing getters
  - `L320` **it** — stores __proto__ keys as data and never pollutes prototypes
  - `L328` **it** — removes NUL, C0/C1 controls, bidi and zero-width characters, normalizes NFKC and repairs lone surrogates
  - `L336` **it** — an envelope key in fields cannot override the log envelope
- `L342` **describe** — B0 redactor: determinism, idempotence and scan consistency
  - `L345` **it** — is deterministic and idempotent over the hostile corpus
  - `L360` **it** — redacted output scans clean (markers are never counted), raw input does not
  - `L367` **it** — the whole hostile detail leaks nothing and emits no secret-derived digest
  - `L373` **it** — detector sanity (stand-in for a bypassed sink): the raw input is flagged for every secret
- `L380` **describe** — B0 redactor: adversarial performance (1 MB inputs)
    - `L405` **it** — ${name}: bounded time and output  *(one test per iteration — see count note)*
- `L416` **describe** — B0 scan mode: count-only, same detection logic, file safety
  - `L417` **it** — counts classes in a JSONL file without ever reporting matched text
  - `L458` **it** — scan mode is unbounded: secrets beyond the redaction depth/width/length bounds are still counted
- `L468` **describe** — B0 protection and sink wiring (static guards)
  - `L471` **it** — the canonical redactor and scanner are protected from agent self-modification
  - `L475` **it** — witness and dry-run child log only through the redacting line logger
  - `L483` **it** — every dynamic CLI error line goes through redactText
  - `L491` **it** — the service audit path redacts once and fans the same redacted detail out

#### `src/__tests__/fleet/redact-sinks.test.ts`

- `L38` **describe** — B0 sinks (in-process): one canonical representation, no leaks
  - `L49` **it** — service stdout logger
  - `L58` **it** — JSONL audit file and its stdout copy carry the identical redacted detail
  - `L74` **it** — FleetService audit()/recordDb(): the audit sink and the database call receive the same redacted detail
  - `L92` **it** — FleetService over HTTP: a secret-shaped path and Authorization header never reach the audit sink raw
  - `L112` **it** — a wide detail (100 keys) is truncated identically in the JSONL, stdout and database copies
  - `L127` **it** — witness / dry-run child line logger
  - `L136` **it** — no sink, and no combination of sinks, leaks any secret; no getter ran
  - `L142` **it** — detector sanity: an unredacted serialization of the same input is flagged (a bypassed sink would fail)
- `L152` **describe.skipIf(!PG_BIN)** — B0 sinks (PostgreSQL): fleet_events and reason columns converge on the canonical redactor
  - `L184` **it** — service role recordEvent: stored detail equals the canonical representation (NUL no longer drops the event)
  - `L196` **it** — owner store event(): root_registered carries the redacted name
  - `L210` **it** — treasury store event(): spending_frozen carries the redacted reason
  - `L218` **it** — no database sink, and no combination of them, leaks any secret

#### `src/__tests__/fleet/operator-canonical.test.ts`

- `L56` **describe** — B2 canonical request signing (FLEET-OP-SIG-V1)
  - `L57` **it** — reproduces the pinned vector: public key, key id, canonical string and deterministic signature
  - `L78` **it** — an independent implementation (WebCrypto) verifies the pinned vector
  - `L84` **it** — the signature binds every field: any change fails verification
  - `L97` **it** — signature encoding must be canonical base64url of exactly 64 bytes
- `L108` **describe** — B2 request-target canonicalization (reject, never normalize)
  - `L109` **it** — accepts canonical targets
    - `L134` **it** — rejects ${name}  *(one test per iteration — see count note)*
  - `L136` **it** — rejects oversize targets
- `L139` **describe** — B2 header rules
  - `L144` **it** — accepts exactly one of each header
  - `L145` **it** — rejects Authorization (agent credentials never cross over) and Cookie
  - `L149` **it** — rejects missing, duplicate, comma-joined and malformed headers
- `L170` **describe** — B2 route policy and the signature-termination invariant
  - `L171` **it** — the shipped policy is exactly the v1 read surface
  - `L180` **it** — adding a mutating, unknown or out-of-scope route fails verification
  - `L195` **it** — matches only exact routes; agent ids must be lowercase ULIDs
  - `L203` **it** — the agent service registers no operator route (disjoint listeners)
- `L209` **describe** — B2 typed responses, untrusted_text and per-item redaction
  - `L214` **it** — untrusted_text is redacted, flattened, stripped of evasion characters and bounded
  - `L227` **it** — agent items validate enums/ids and wrap names; no corpus secret survives
  - `L238` **it** — events are rebuilt from the allow-list; unknown types omit detail; IPs and raw actors are dropped
  - `L250` **it** — status keeps public build identities and never exposes unknown readiness details
- `L261` **describe** — B2 Amendment 1: audit-capacity thresholds
  - `L262` **it** — ok < 50% <= info < 75% <= elevated < 100% <= full
- `L276` **describe** — B2 keygen (bridge side) and startup refusals
  - `L277` **it** — writes a 0600 key exclusively, prints only public material, refuses unsafe locations
  - `L310` **it** — refuses root, foreign credentials, readable controller secrets, safety switches, non-loopback listen, missing pins
  - `L344` **it** — operator.env is accepted only root-owned, own-group, single-link, without symlinks (no broadened exception)
- `L384` **describe** — B2 protections
  - `L385` **it** — agents cannot touch the Operator API, its credential, principals or tooling
  - `L407` **it** — operator modules and the v8 migration are protected from self-modification

#### `src/__tests__/fleet/operator-pg.test.ts`

- `L36` **describe.skipIf(!PG_BIN)** — B2 schema v8 and the operator database surface (PostgreSQL)
  - `L132` **it** — v7 -> v8 on a production-shaped empty registry: exact check (rolled back), apply, idempotent; v8 code refuses v7
  - `L164` **it** — a failing v8 migration is atomic: v7 stays intact with no partial operator objects
  - `L185` **it** — the operator role executes exactly the op_* allow-list (read side STABLE), owns nothing, reads no table
  - `L224` **it** — signature-termination invariant: catalog mutations of the operator surface are detected or refused
  - `L275` **it** — the static audit catches hidden writes (dynamic SQL, quoted names, side-effect builtins, indirect helpers, MERGE, other schemas)
  - `L333` **it** — runtime barrier: reads run READ ONLY, so even a tampered read function cannot write
  - `L358` **it** — principal and key constraints: fingerprint ids, 90-day cap, <= 2 active keys, immutability, final revocation, no deletion
  - `L388` **it** — operator principals can never approve anything (approver rule)
  - `L398` **it** — op_begin_request fails closed in every case and accepts exactly one use of a nonce
  - `L451` **it** — Amendment 3: an accepted read changes only operator security/audit bookkeeping; a denial only adds an event
  - `L474` **it** — Amendment 1: 50% / 75% warnings, fail closed at 100%, no automatic deletion, audited archival
  - `L502` **it** — archival is owner-only, verified before deletion and fail-closed on every error
  - `L672` **it** — expired nonces are purged in bounded batches by accepted requests only
  - `L690` **it** — the operator login's identity is exactly the restricted role (for startup refusal)
  - `L697` **it** — a key cannot be added to a principal whose revocation commits concurrently (lock, then check)
  - `L722` **it** — database-layer denial events are bounded per minute; the denials themselves always stand
- `L734` **describe.skipIf(!PG_BIN)** — B2 operator roles: not provisioned vs provisioned (own cluster)
  - `L768` **it** — neither role exists: a valid not-provisioned state across audit, doctor and the 16-item checklist
  - `L797` **it** — only fleet_operator exists: FAIL
  - `L810` **it** — only fleet_operator_login exists: FAIL
  - `L822` **it** — both exist and are correct: PASS (provisioned); wrong privileges or attributes: FAIL

#### `src/__tests__/fleet/operator-server.test.ts`

- `L87` **describe.skipIf(!PG_BIN)** — B2 Operator API over HTTP (PostgreSQL)
  - `L160` **it** — serves the read routes with typed bodies; pages larger than B0's width bound are complete
  - `L203` **it** — no corpus secret appears in any response; agent text is always untrusted_text
  - `L213` **it** — negative matrix: every case fails closed with the specified status/code
  - `L254` **it** — revocation is immediate; the kill switch disables everything and readiness reports it
  - `L272` **it** — fails closed with FLEET_OP_AUDIT_FULL at the audit cap
  - `L282` **it** — rate limits: per principal; junk identities share one lookup budget and cannot lock out known principals
  - `L306` **it** — /readyz: loopback Host only, cached per poll interval (no database amplification); unknown safety flags are null
  - `L335` **it** — denied-request audit lines are budgeted and the excess is summarised
  - `L353` **it** — audit records every request without signatures, nonces, public keys or Authorization values
  - `L367` **it** — startup refuses the owner or service credential, a runtime mismatch, and admin credentials; starts when all agree

#### `src/__tests__/fleet/bridge-unit.test.ts`

- `L57` **describe** — config
  - `L58` **it** — accepts the exact schema and round-trips through an atomic 0600 save
  - `L65` **it** — rejects unknown/missing fields, relative paths, bad identities and duplicate key files
  - `L88` **it** — refuses a group-writable, symlinked or hard-linked config file
- `L101` **describe** — ssh invocation
  - `L102` **it** — is a fixed, shell-free argument vector that pins host key, identity and the single forward
  - `L138` **it** — classifies ssh failures
- `L147` **describe** — host-key pinning
  - `L148` **it** — fingerprints exactly like ssh-keygen
  - `L154` **it** — accepts only one plain ssh-ed25519 line with the pinned fingerprint
  - `L168` **it** — builds the pinned line from a hashed known_hosts without any network access
- `L178` **describe** — strict response validation
  - `L193` **it** — accepts what the real server builders produce
  - `L202` **it** — rejects every deviation: unknown/missing fields, types, plain-string text, oversized text, enums, cursors, page size
  - `L232` **it** — accepts a B0 redaction marker in place of a formatted value, nothing else
  - `L237` **it** — model view: provenance + notice, untrusted values keep their type and show invisible/bidi/control characters
- `L255` **describe** — signing key handling
  - `L256` **it** — loads only a protected key whose id matches the config and is not locally expired
  - `L272` **it** — classifies expiry: ok > 21 days, warn, critical <= 7, expired, unknown
- `L282` **describe** — client against hostile or broken servers
  - `L316` **it** — sends exactly one signed GET with the five signing headers and nothing else sensitive
  - `L330` **it** — maps every failure to a fail-closed code
  - `L359` **it** — refuses unsupported requests locally, before any byte is sent
- `L380` **describe** — agent-side protections
  - `L381` **it** — agents may not run or edit the bridge, its keys, config or tunnel

#### `src/__tests__/fleet/bridge-tunnel.test.ts`

- `L91` **describe** — ephemeral tunnel
  - `L92` **it** — opens with the exact argv, proves listener ownership, verifies the endpoint, and cleans up completely
  - `L107` **it** — reports a disabled Operator API as readiness, not as success
  - `L113` **it** — fails closed and leaves no process behind on every ssh failure
  - `L128` **it** — refuses a port someone else holds (fixed port: ssh fails; foreign listener: never used)
  - `L145` **it** — preflight: a wrong pinned host key or an unprotected SSH identity never starts ssh
  - `L158` **it** — escalates to SIGKILL when ssh ignores SIGTERM
  - `L166` **it** — an ephemeral tunnel dies with the process that opened it (no orphan)
- `L196` **describe** — persistent tunnel
  - `L197` **it** — up -> reused -> down, tracked by a 0600 state file
  - `L217` **it** — a recorded pid that is not provably ours is dropped and NEVER signalled
  - `L249` **it** — a provably-owned tunnel whose endpoint stops being the Operator API is torn down

#### `src/__tests__/fleet/bridge-integration.test.ts`

- `L44` **describe.skipIf(!PG_BIN)** — Claude bridge against the real Operator API (ephemeral PostgreSQL)
  - `L125` **it** — reads: whoami, status, agents (paged), agent, events — all strictly validated, agent text untrusted
  - `L149` **it** — server-side denials map to fail-closed codes: scope, kind, replay, clock, wrong/revoked key, not found
  - `L172` **it** — kill switch and audit-full fail closed; the CLI sends nothing while the API is disabled
  - `L195` **it** — CLI over the tunnel: model views carry provenance, the notice and typed untrusted text; errors are structured
  - `L213` **it** — CLI tunnel up / status / down
  - `L224` **it** — key rotation through the CLI: add -> verify -> switch -> revoke -> finish, each step refusing to run out of order

#### `src/__tests__/fleet/bridge-mcp.test.ts`

- `L56` **describe** — MCP protocol surface (in-process)
  - `L57` **it** — initialize advertises tools only; exactly five read-only tools with closed schemas
  - `L83` **it** — refuses tool calls before initialize, unknown tools, and every malformed or out-of-bounds argument
  - `L135` **it** — rejects parse errors, batches, oversized lines and malformed envelopes; notifications get no reply
  - `L149` **it** — returns the Phase D model view verbatim: provenance, notice, typed untrusted text with bidi made visible
  - `L166` **it** — propagates every bridge failure as a structured error and never leaks internal details
  - `L187` **it** — serializes tool calls (one tunnel, strictly ordered signed requests)
  - `L204` **it** — the argument validator mirrors each tool's published schema exactly
- `L253` **describe.skipIf(!PG_BIN)** — MCP stdio process against the real Operator API
  - `L340` **it** — end to end over stdio: protocol-only stdout, clean stderr, no listening socket, untrusted text preserved, clean exit
  - `L377` **it** — SIGTERM or stdin close during a hanging tunnel leaves no ssh process behind

#### `src/__tests__/fleet/chatgpt-adapter.test.ts`

- `L52` **describe.skipIf(!PG_BIN)** — ChatGPT adapter against the real Operator API (ephemeral PostgreSQL)
  - `L148` **it** — exposes exactly four read-only tools (no events) over a stateless transport
  - `L167` **it** — reads through the real Operator API; hostile agent text stays typed untrusted_text in text and structuredContent
  - `L191` **it** — HTTP hardening: token, Host, Origin, method, path, content type, size, batch, notification, discovery
  - `L219` **it** — rate limits and bounds queued calls
  - `L229` **it** — identity gate: a Claude principal/key, or a ChatGPT principal with the wrong scopes, is refused on every call
  - `L244` **it** — revocation, kill switch and a foreign 8788 listener all fail closed
  - `L271` **it** — startup refuses foreign credentials, readable secrets, loose config and a loose key
  - `L288` **it** — audit log: 0600 JSON lines with tool, code and Operator request id — never the token, signatures, nonces or keys

#### `src/__tests__/fleet/chatgpt-adapter-imports.test.ts`

- `L35` **describe** — Phase C: the ChatGPT adapter loads no DB, store, treasury, wallet, SSH or CLI module
  - `L36` **it** — control: a mocked forbidden module refuses to load
  - `L41` **it** — the adapter entry point and its whole dependency tree load without any of them

#### `src/__tests__/fleet/chatgpt-tunnel-key.test.ts`

- `L32` **describe** — tunnel key helper
  - `L33` **it** — accepts current and future OpenAI key shapes (no prefix/length allowlist)
  - `L49` **it** — strips paste artefacts: bracketed-paste markers, CR, surrounding spaces and tabs
  - `L58` **it** — refuses garbage with a category that never echoes the input
  - `L77` **it** — reads OpenAI's verdict only from the tunnel's own log messages
  - `L88` **it** — the entry point refuses to run unprivileged or without a terminal; source-only use runs nothing

#### `src/__tests__/fleet/fleet-witness.test.ts`

- `L88` **describe** — Fleet security: witness route policy (default deny)
  - `L89` **it** — route-policy completeness: every route FleetService.route() serves has exactly one policy entry, and vice versa
  - `L97` **it** — witness is opt-in: exactly session, heartbeat, health challenge and self
  - `L104` **it** — unknown future routes and unknown scopes fail closed; 'full' keeps its behaviour
- `L119` **describe** — Fleet security: root witness startup refusals
  - `L138` **it** — a clean environment passes
  - `L142` **it** — refuses uid 0, true safety switches, and privileged/forbidden environment variables
  - `L152` **it** — refuses a switch turned on in runtime.env too
  - `L158` **it** — refuses wallet files and readable controller secrets
  - `L169` **it** — refuses a runtime identity mismatch (tampered tree, other lockfile, missing pins) before any network access
  - `L187` **it** — the challenge answer reports the pinned identity and only pattern-matches the canary
- `L220` **describe** — Fleet security: root witness isolation (no wallet, inference or replication code)
    - `L229` **it** — ${entry}: no wallet modules, no inference modules, no replication code  *(one test per iteration — see count note)*
  - `L237` **it** — the witness source calls no endpoint but the four it needs
  - `L244` **it** — systemd unit: dedicated user, 0700 state, no groups, no capabilities, strict sandbox, loopback only, secrets inaccessible
- `L269` **describe.skipIf(!PG_BIN)** — Fleet security financial: witness capability scope (PostgreSQL)
  - `L400` **it** — migration v6 -> v7: applied transactionally; existing agents become capability_scope 'full'; privileges stay least
  - `L437` **it** — enroll-witness-root: keyless root, scope witness, approved runtime commit, frozen custody, 0600 file, token never returned
  - `L460` **it** — capability scope is immutable (owner cannot change it; restricted roles cannot write it); a witness must be a root
  - `L489` **it** — fa1 opens a session; the fs1 session may heartbeat, answer a challenge and read itself; replay and stale requests are still refused
  - `L528` **it** — every other authenticated /v1 route is denied for the witness (403 FLEET_SCOPE_DENIED), with no side effect and an audit event without secrets
  - `L574` **it** — an invented token for the witness id is rejected as unauthenticated and records no scope_denied event
  - `L583` **it** — an unknown route is never dispatched (404) for witness and full agents alike
  - `L595` **it** — database: fleet_authenticate fails closed for unknown actions; every non-allowed api_* action is denied for a witness session
  - `L640` **it** — credential rotation does not change scope: new credential and new sessions are still witness-restricted
  - `L652` **it** — full agents keep their existing behaviour on every route family
  - `L666` **it** — a witness is refused by the normal allocator and insert guard, and accepted by the operator dry-run reservation and claim
  - `L688` **it** — the witness runs: session, heartbeats, passed challenge, only its four endpoints; stops cleanly; then becomes UNRESPONSIVE
  - `L736` **it** — the witness refuses a full-scope credential and exits as rejected once retired (mark-dead)

#### `src/__tests__/fleet/fleet-witness-imports.test.ts`

- `L50` **describe** — Fleet security: root witness loads no wallet, inference or replication module
  - `L51` **it** — control: a mocked forbidden module refuses to load
  - `L56` **it** — the witness module and its whole dependency tree load without any of them

#### `src/__tests__/replication.test.ts`

- `L60` **describe** — isValidWalletAddress
  - `L61` **it** — accepts a valid 40-hex-char address with 0x prefix
  - `L65` **it** — accepts uppercase hex characters
  - `L69` **it** — accepts mixed-case hex characters
  - `L73` **it** — rejects the zero address
  - `L77` **it** — rejects addresses without 0x prefix
  - `L81` **it** — rejects addresses that are too short
  - `L85` **it** — rejects addresses that are too long
  - `L89` **it** — rejects empty string
  - `L93` **it** — rejects non-hex characters
  - `L97` **it** — rejects 0x prefix alone
- `L104` **describe** — spawnChild
  - `L131` **it** — validates wallet address before creating child record
  - `L149` **it** — throws on zero address from init
  - `L164` **it** — throws when init returns no wallet address
  - `L179` **it** — propagates error on exec failure without calling deleteSandbox
  - `L192` **it** — propagates error on wallet validation failure without calling deleteSandbox
  - `L212` **it** — does not mask original error if deleteSandbox also throws
  - `L223` **it** — does not call deleteSandbox if createSandbox itself fails
- `L236` **describe** — SandboxCleanup
  - `L253` **it** — transitions to cleaned_up even though sandbox deletion is disabled
  - `L272` **it** — transitions to cleaned_up when sandbox deletion succeeds
- `L292` **describe** — pruneDeadChildren
  - `L313` **it** — attempts sandbox cleanup for children with dead status
