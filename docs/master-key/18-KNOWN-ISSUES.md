# 18 — Known Issues, Reconciled (Master Key, PART 20)

Scope: reconciles `docs/fleet-known-issues.md` (last changed in `a48949a`, 2026-09-25)
with the code at `fleet-development` HEAD `efad214`, the tests, and the recorded
production state (runbook, commit messages, operator records as of 2026-09-25).
It also collects the other open issues recorded in the runbook, `FLEET.md`, commit
messages and code comments.

Rules applied:
- The source document `docs/fleet-known-issues.md` was **not edited**. Where its text no
  longer matches reality, the entry is flagged **`STALE:`** here with the evidence.
- "Introduced" is taken from `git log -S` / `git blame` on the exact code.
- Code wins over documents. Disagreements are marked **`DRIFT:`**.
- Nothing was run against a database or a host. Production facts come from records; live
  values must be confirmed from the production snapshot.

<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->

---

## 0. Index

| ID | Title | Source | Current status (this pass) | Production impact |
|---|---|---|---|---|
| FLEET-KI-1 | Concurrent migration REVOKE race | known-issues doc | **OPEN**, confirmed in code; surface widened by `5a5469e` | None under the runbook's single manual `fleet:migrate`; see §1 |
| FLEET-KI-2 | PostgreSQL test cleanup deadlock | known-issues doc | **OPEN**, fixture unchanged; doc's cause text partly **STALE** | Test-only |
| FLEET-KI-3 | TLS key via LoadCredential | known-issues doc | **RESOLVED**; status text **STALE** (now in production with a real certificate) | Resolved |
| FLEET-KI-4 | Dry-run root / witness | known-issues doc | **STALE** status: committed `cdfd70c`, deployed (schema v7, user and unit installed); **enrolment and start still pending** | Dry run blocked until the operator enrols and starts the witness |
| FLEET-KI-5 | Operator signatures end at the Operator API process | known-issues doc | **ACCEPTED LIMITATION**, current | Contained (read-only surface) |
| MK-OPS-1 | `fleet-os-setup.sh` dry run always exits 1 | operator record | **OPEN**, confirmed `scripts/fleet-os-setup.sh:158` | Cosmetic, but breaks `&&` chaining and CI |
| MK-OPS-2 | `bridge-claude` key expires 2026-10-24T23:49:04.533Z | runbook / records | **OPEN, time-bound** | Claude bridge + `fleet-operator` MCP stop working at expiry |
| MK-OPS-3 | `bridge-chatgpt` key expires 2026-10-25T01:00:57.682Z | runbook / records | **OPEN, time-bound** | ChatGPT adapter reads fail at expiry |
| MK-OPS-4 | ChatGPT tunnel runtime key not provided; ChatGPT app not created | runbook Stage C / records | **OPEN (owner action)** | Tunnel unit inactive; ChatGPT has no access |
| MK-OPS-5 | ChatGPT product ↔ tools end-to-end unproven | records | **OPEN** | Unknown until MK-OPS-4 is done |
| MK-OPS-6 | Certbot deploy hook never tested by hand; expiry monitoring not set up | runbook | **OPEN** | Next renewal (cert valid to 2026-12-23) may cause an outage |
| MK-OPS-7 | `ubuntu` has passwordless sudo | runbook | **OPEN** (approval-gated fix planned) | Root = possession of the `ubuntu` SSH key |
| MK-OPS-8 | Two registry dumps 0664 in `~ubuntu` | runbook | **OPEN** | Confidential data (token/session hashes) readable by other local users |
| MK-OPS-9 | `ubuntu` cannot read the journal; 130 package upgrades pending | runbook | **OPEN** | Operability / patch level |
| MK-OPS-10 | JSONL audit file written without `scrubDetail` | runbook open item | **STALE: fixed** by `03f8760` | None |
| MK-ARCH-1 | Conway cannot stop/delete sandboxes | code + FLEET.md | **OPEN (structural)** | Blocks SAFE FOR REAL REPLICATION |
| MK-ARCH-2 | Sandbox-side attestation trusts the sandbox; child Node not pinned | FLEET.md | **OPEN (structural)** | Blocks SAFE FOR REAL REPLICATION |
| MK-ARCH-3 | No controller custody signer; agents hold their own keys | code + FLEET.md | **OPEN (structural)** | Blocks SAFE FOR REAL PAYMENTS |
| MK-ARCH-4 | No completed dry-run child | FLEET.md / runbook | **OPEN** | Blocks real replication readiness |
| MK-ARCH-5 | Checklist item "fleet cap = 2" is a literal | code | **OPEN (design constraint)** | `fleet:verify` becomes 15/16 whenever the cap ≠ 2 |
| MK-ARCH-6 | Redactor does not detect deliberate re-encoding | code comment | **ACCEPTED LIMITATION** | Redaction targets accidental inclusion only |
| MK-TEST-1 | Full-suite hang in `context-hardening.test.ts` | operator record | **OPEN (upstream, pre-fleet)** | Test-only |
| MK-TEST-2 | Phase 2 PG tests fall back to `admin.env` DSN | code | **OPEN (test-safety)** | Could run test DDL on a real registry database |
| MK-TEST-3 | Host-conditional Phase 6 tests pass vacuously | code | **OPEN (coverage)** | Test-only |
| MK-TEST-4 | Tunnel-key helper fixes `aed747e`/`efad214` have no automated tests | commits + tests | **OPEN (coverage)** | Regression risk on a root-run script |
| MK-DOC-1 | `FLEET.md` "Current deployment state" describes 2026-09-24 pre-VPS state | FLEET.md | **DRIFT** | Misleading for rebuilders |
| MK-DOC-2 | `FLEET.md:474` Phase 4 test count 38 (code 53) | FLEET.md | **DRIFT** | Documentation only |
| MK-DOC-3 | Charter says the control plane owns Redis; no fleet code uses Redis | CLAUDE.md / code | **DRIFT** | Redis installed but unused |

`TODO` / `FIXME` / `XXX` / `HACK` markers: **none** in `src/fleet/`, `scripts/`, `deploy/`,
`src/__tests__/fleet/`, `src/agent/policy-rules/fleet.ts` or `src/replication/`
(`grep -rnE '\b(TODO|FIXME|XXX|HACK)\b'` returned no match). There are also no
`TODO`/`FIXME`/`XXX` lines anywhere under `src/` that mention "fleet".

---

## 1. FLEET-KI-1 — concurrent migration REVOKE race

| Field | Value |
|---|---|
| Source doc | `docs/fleet-known-issues.md:6-19` |
| Description | Two concurrent `PgFleetStore.migrate()` calls fail with `error: tuple concurrently updated` from `REVOKE ALL ON ALL TABLES IN SCHEMA … FROM PUBLIC, <role>` |
| Test | `src/__tests__/fleet/fleet-phase2.test.ts:588-593` "migrations are idempotent and safe to run concurrently": `Promise.all([newStore().migrate(), newStore().migrate(), newStore().migrate()])` |
| Introduced | Test: `d6302c3` (Phase 2). `grantAgentRole` with the REVOKE: `443f035` (Phase 3). Grant calls moved into `migrate()` after the locked migration: `e5ac7fe` (Phase 4/5; `git blame src/fleet/postgres/store.ts:567-572`). `grantOperatorRole` added to `migrate()`: `5a5469e` (`store.ts:568,573`). First confirmed failing on `2d6d4cf` (fleet-v0.6). |
| Current status | **OPEN. Verified present in code at HEAD.** |
| Affected files | `src/fleet/postgres/store.ts:558-575` (`migrate`), `:772-785` (`grantAgentRole`), `:793-811` (`grantServiceRole`), `:819-833` (`grantOperatorRole`), `:485-…` (`tx`); `src/fleet/postgres/migrations.ts:1216-1250` (`migrate`) |

### 1.1 Code verification

`migrations.ts` serialises every schema migration behind a transaction-scoped advisory lock:
```ts
const MIGRATION_LOCK_KEY = 0x464c4545; // "FLEE"                  (migrations.ts:22)
await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]); // :1223, :1238, :1268
```
But `PgFleetStore.migrate()` runs the grants **after** releasing that lock, each in its own
transaction via `this.tx()` (which runs `ensureSchema`, `BEGIN`, fn, `COMMIT`; no advisory lock):
```ts
// store.ts:558-575
async migrate(): Promise<number[]> {
  const client = await this.connect();
  let applied: number[];
  try {
    await this.assertAdminConnection(client);
    applied = await migrate(client, this.schema);          // locked, per-version transactions
  } finally {
    client.release();
  }
  const roles = await this.pool
    .query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname = ANY($1)", [[this.agentRole, this.serviceRole, this.operatorRole]])
    .catch(() => null);
  const present = new Set(roles?.rows.map((r) => r.rolname) ?? []);
  if (present.has(this.agentRole)) await this.grantAgentRole(this.agentRole);       // unlocked
  if (present.has(this.serviceRole)) await this.grantServiceRole(this.serviceRole); // unlocked
  if (present.has(this.operatorRole)) await this.grantOperatorRole(this.operatorRole); // unlocked (since 5a5469e)
  return applied;
}
```
```ts
// store.ts:772-785 (grantAgentRole); grantOperatorRole :819-833 is the same shape
await c.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${s} FROM PUBLIC, ${r}`);
await c.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${s} FROM PUBLIC, ${r}`);
await c.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${s} FROM PUBLIC, ${r}`);
await c.query(`REVOKE ALL ON SCHEMA ${s} FROM PUBLIC, ${r}`);
await c.query(`GRANT USAGE ON SCHEMA ${s} TO ${r}`);
for (const fn of AGENT_API_FUNCTIONS) await c.query(`GRANT EXECUTE ON FUNCTION ${s}.${fn} TO ${r}`);
```
Concurrent GRANT/REVOKE on the same `pg_class.relacl` / `pg_proc.proacl` / `pg_namespace.nspacl`
rows is not serialised by PostgreSQL, so the second writer gets `tuple concurrently updated`.
The in-migration `REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC` statements
(`migrations.ts:740,1110`, `migrations-phase5.ts:881,1206`, `migrations-phase6.ts:426`,
`migrations-phase7.ts:238`, `migrations-phase8.ts:530`) run **inside** the advisory lock
and are not part of the race.

**Doc accuracy:** the doc names only `grantAgentRole`. Since `5a5469e` the same race also
applies to `grantServiceRole` and `grantOperatorRole` (three unlocked grant transactions
per `migrate()`), and the CLI exposes each grant separately (`src/fleet/postgres/cli.ts:532,537,542`).

| Field | Value |
|---|---|
| Production impact | None observed. The runbook runs `pnpm fleet:migrate` once, by hand, with the controller stopped (e.g. B2-7/B2-8 v8 cutover, S9b gate 7). No production component calls `migrate()` automatically. A second operator running `fleet:migrate` or a `grant-*` CLI command at the same moment would fail with an error; the failing transaction rolls back, so no partial ACL state is committed by that transaction. |
| Workaround | Never run two migrators or grant commands concurrently; re-run `fleet:migrate` (idempotent) if it fails; verify with `pnpm fleet:audit-privileges`. |
| Required future fix | Take `pg_advisory_xact_lock(MIGRATION_LOCK_KEY)` inside each `grant*Role` transaction (or run migration + grants in one locked transaction), or skip re-granting when the ACL already matches. Then un-quarantine `fleet-phase2.test.ts:588`. Interaction with FLEET-KI-5: every fleet login can take advisory locks, including this key, so a restricted login could block migrations while holding it. |

---

## 2. FLEET-KI-2 — PostgreSQL test cleanup deadlock

| Field | Value |
|---|---|
| Source doc | `docs/fleet-known-issues.md:21-35` |
| Description | `error: deadlock detected` at the `TRUNCATE … RESTART IDENTITY CASCADE` in the test wipe fixture |
| Test | `fleet-phase2.test.ts:611` "wallet_address cannot hold a private key" (fails inside `reset()` → `wipeRegistry`, before the test body); intermittent |
| Introduced | `src/__tests__/fleet/fixtures/wipe.ts`: `e5ac7fe` (entire file by `git blame`). The `reset()` caller in `fleet-phase2.test.ts:539-560` also from the phase 2/4 commits. First confirmed failing on `2d6d4cf`. |
| Current status | **OPEN. Fixture unchanged since `e5ac7fe`.** |
| Affected files | `src/__tests__/fleet/fixtures/wipe.ts:9-30`; `src/__tests__/fleet/fleet-phase2.test.ts:539-560` (`reset`), `:588-593` (preceding KI-1 test) |
| Production impact | None (test-only fixture; disables triggers only in throwaway schemas). |

### 2.1 Code verification and doc accuracy

```ts
// wipe.ts:11-19
const r = await c.query("SELECT tablename AS t FROM pg_tables WHERE schemaname = $1 ORDER BY tablename", [schema]);
const all  = r.rows.map((x) => `"${schema}"."${x.t}"`);
const wipe = r.rows.filter((x) => !keep.has(x.t)).map((x) => `"${schema}"."${x.t}"`);
await c.query(`LOCK TABLE ${all.join(", ")} IN ACCESS EXCLUSIVE MODE`);
for (const t of all) await c.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
await c.query(`TRUNCATE ${wipe.join(", ")} RESTART IDENTITY CASCADE`);
```
- **STALE (cause text):** the doc says the wipe "takes `ACCESS EXCLUSIVE` locks table by
  table". The code takes them in **one** `LOCK TABLE` statement (`wipe.ts:17`). PostgreSQL
  still acquires the listed locks one after another, in the listed (alphabetical) order.
- **STALE (direction text):** the doc proposes "lock every table in one statement in a fixed
  order". That is already done (alphabetical). The remaining gap is *which* order.
- **Additional finding:** `fleet-phase2.test.ts:547` comments "Same lock order as reservations
  (fleet_state first) to avoid deadlocks", but alphabetical order puts `fleet_agent_credentials`,
  `fleet_agents`, … before `fleet_state`. Reservations lock `fleet_state` first
  (`SELECT * INTO st FROM fleet_state WHERE id = 1 FOR UPDATE`, `migrations.ts:395`;
  `FLEET.md:198`). A lingering connection from the previous test (for example the KI-1
  concurrent migrators, or 25-connection pool clients) holding or waiting on `fleet_state`
  and a table later in the list can deadlock with the wipe. The doc's hypothesis that it
  cascades from KI-1 is consistent with this: KI-2 is the test right after KI-1 in execution order
  (`:588` then `:595`, `:611`).

| Field | Value |
|---|---|
| Workaround | Re-run; or run `fleet-phase2.test.ts` alone after KI-1 is fixed; ephemeral-cluster files (phase3-6, witness) use the same fixture on schema `fleet` without the KI-1 test and are not recorded as deadlocking. |
| Required future fix | Lock `fleet_state` first, then the rest in a fixed order (matching the application's order); await/end all pool clients from the previous test before wiping; add `SET lock_timeout` + retry. Recheck after KI-1 is fixed. |

---

## 3. FLEET-KI-3 (resolved) — TLS key via LoadCredential

| Field | Value |
|---|---|
| Source doc | `docs/fleet-known-issues.md:37-56` |
| Description | systemd presents `$CREDENTIALS_DIRECTORY/tls.key` as 0440 (0400 + ACL mask); strict `secretFileProblems()` refused it |
| Introduced | Latent since remote HTTPS support (`2d6d4cf`, Phase 6) combined with `LoadCredential=tls.key`; same class as the `service.env` defect fixed in `241dcf9` |
| Fixed in | `11c0c7c` "fix: securely support TLS systemd credentials" |
| Current status | **RESOLVED. Verified in code.** `loadTls()` (`src/fleet/service/main.ts:96-…`) validates the implicit key with `systemdCredentialProblems(keyFile, TLS_KEY_CREDENTIAL, credDir, systemd.sourceFile ?? DEFAULT_TLS_KEY_FILE, systemd.host)` (`main.ts:115`); `systemdCredentialProblems` at `src/fleet/secret-files.ts:205`. Test matrix: `fleet-phase4.test.ts:274-438` (8 tests incl. explicit `FLEET_TLS_KEY_FILE` strictness `:316`, name isolation `:403`). |
| Affected files | `src/fleet/service/main.ts`, `src/fleet/secret-files.ts`, `deploy/systemd/…/remote.conf`, `scripts/fleet-verify-deployment.sh:121-152` |

- **STALE:** "Not yet exercised with a real certificate: remote HTTPS is still disabled, no key
  or certificate exists, and the remote drop-in is not installed (production runbook stages 15-19)."
  Per the runbook (`docs/fleet-production-runbook.md:101-107`), on 2026-09-24 a Let's Encrypt ECDSA P-256
  certificate (valid 2026-09-24 → 2026-12-23) was installed as `tls/fleet.key` (root:root 0600) and
  `tls/fleet.crt` (root:root 0644), the `remote.conf` drop-in was installed, and the service has
  served `0.0.0.0:443` since 18:25:59 UTC with `fleet-verify-deployment.sh` 19/19 PASS. The fix is
  therefore exercised in production.
- **STALE:** "installed on the local VM, where `scripts/fleet-verify-deployment.sh` passes" — the
  local VM controller is now stopped and disabled; production is the OVH VPS.
- Production impact: none (resolved). Workaround: n/a. Future: see MK-OPS-6 (renewal requires a restart).

---

## 4. FLEET-KI-4 — dry-run root / witness capability scope

| Field | Value |
|---|---|
| Source doc | `docs/fleet-known-issues.md:58-88` |
| Description | The dry run (`dryRunPreflight`, `src/fleet/dry-run/operator.ts`; `fleet_reserve_dry_run`, `migrations-phase6.ts`) needs an ACTIVE root; the only runtime that could stay ACTIVE was the full agent. Solution: root witness (`dist/fleet/dry-run/root-main.js`) + capability scope `witness` (schema v7) |
| Introduced | Design gap from Phase 6 (`2d6d4cf`); solution committed in `cdfd70c` "feat: add scoped root witness for dry-run" (`src/fleet/dry-run/root-main.ts` added there; `src/fleet/postgres/migrations-phase7.ts`) |
| Affected files | `src/fleet/dry-run/root-main.ts`, `root-witness.ts`, `operator.ts`, `src/fleet/postgres/migrations-phase7.ts`, `src/fleet/postgres/cli.ts:47,134` (`enroll-witness-root`), `src/fleet/service/server.ts` route policy, `deploy/systemd/automaton-fleet-witness.service`; tests `fleet-witness.test.ts`, `fleet-witness-imports.test.ts` |

- **STALE:** "implemented in the working tree, pending review (not committed, not pinned, not deployed)".
  Evidence: committed `cdfd70c` (2026-09-24); runbook S9b: runtime `cdfd70c` approved and
  running, live v6 → v7 migration applied 20:00:47 UTC (`migrate-check` exactly
  `{"currentVersion":6,"resultingVersion":7,"wouldApply":[7]}`), user `automaton-fleet-witness`
  (uid 995 / gid 985) and `automaton-fleet-witness.service` installed, **disabled, inactive**
  (`fleet-production-runbook.md:123-135`). Production now runs `4d6a0be` (schema v8), which contains it.
- Of the doc's four prerequisites: 1 (review), 2 (runtime pin), 3 (v6 → v7 migration), 4 (user and unit) are **done**.
- **Still open:** the witness is **not enrolled** (`fleet:admin enroll-witness-root` not run), its
  credential is not installed in `/var/lib/automaton-fleet-witness/`, the unit is not started, and
  stage 22 (dry-run child) has not started. All need operator approval (runbook stage 21b/22, "S10").

| Field | Value |
|---|---|
| Current status | Code **resolved and deployed**; operational step **pending** |
| Production impact | `SAFE FOR DRY RUN: YES` is reported, but a dry run cannot actually run until an ACTIVE root exists. Enrolled witness must be started promptly (records: "enroll the witness and start it within 2 minutes") so it does not go UNRESPONSIVE. |
| Workaround | None needed while no dry run is attempted. |
| Required future action | Approval-gated: `enroll-witness-root`, install credential `sudo install -m 0600 -o automaton-fleet-witness`, start the unit, verify heartbeats and a passed challenge (`journalctl -u automaton-fleet-witness`), then stage 22. |

---

## 5. FLEET-KI-5 — operator signatures end at the Operator API process

| Field | Value |
|---|---|
| Source doc | `docs/fleet-known-issues.md:90-118` |
| Description | PostgreSQL cannot verify the Ed25519 request signature; it trusts `fleet_operator_login`. Whoever controls the Operator API process or that login can call `op_*` reads without a valid signature, still subject to `op_begin_request` checks (principal, key, scope, kill switch, nonce, audit cap) |
| Introduced | `5a5469e` (B2-2, reviewed in B2-3); deployed `4d6a0be` (schema v8) on 2026-09-24/25 |
| Current status | **ACCEPTED LIMITATION — current.** Verified: every read runs `BEGIN TRANSACTION READ ONLY` (`src/fleet/operator/gateway.ts:74-82`); request-id reuse window `interval '30 seconds'` (`migrations-phase8.ts:338`); static surface audit `operatorSurfaceProblems` (`src/fleet/postgres/privileges.ts:292`) with `SIDE_EFFECT_BUILTINS` (`privileges.ts:273`, includes `pg_advisory_\w+`, `lo_\w+`, `set_config`, `nextval`, `dblink\w*`). |
| Affected files | `src/fleet/operator/{gateway,server}.ts`, `src/fleet/postgres/migrations-phase8.ts`, `src/fleet/postgres/privileges.ts`, `scripts/fleet-db-roles.sql` |
| Production impact | Contained: operator role and `op_*` are read-only; tested by `operator-pg.test.ts:185-357`. |
| Sub-issue (pre-existing, all logins) | Agent, service and operator logins can take advisory locks (including `MIGRATION_LOCK_KEY` 0x464c4545), call `lo_create`, override per-role `statement_timeout` / `idle_in_transaction_session_timeout`, and have CONNECT on other databases unless `pg_hba` restricts. **Verified still present:** `scripts/fleet-db-roles.sql` and `src/fleet/postgres/*.ts` contain no `REVOKE … lo_*`, no revocation of advisory-lock functions, and no `REVOKE CONNECT ON DATABASE postgres`. Production `pg_hba.conf` (runbook `:406`): local peer, `host 127.0.0.1/32 + ::1/128 scram-sha-256`, nothing else — so CONNECT to other databases is not blocked by pg_hba. |
| Workaround | None required for read-only v1. |
| Required future fix | Own security gate: `REVOKE EXECUTE` on `lo_*` / advisory functions from PUBLIC (database-wide), `REVOKE CONNECT ON DATABASE postgres FROM PUBLIC`, per-login `pg_hba` rules. Rule retained: no mutating operator scope (e.g. `ops.propose`) by extending the scope/route tables. |

---

## 6. Operational issues (runbook, commit messages, operator records)

### MK-OPS-1 — `scripts/fleet-os-setup.sh` dry run always exits 1

| Field | Value |
|---|---|
| Description | The script's last line is a `&&` list guarded by `APPLY`. In a dry run `(( APPLY ))` evaluates false (status 1); `set -e` does not abort on a failing `&&` list element, but the script's exit status is that of its last command, so every **dry run exits 1** after printing "Done." |
| Evidence | `scripts/fleet-os-setup.sh:33` `set -euo pipefail`; `:158` `(( APPLY )) && echo "NOTE: $OPERATOR must log out/in (or run 'newgrp automaton-fleet-admin') to read admin.env."`. Operator record (S9b gate 9): "The dry run of fleet-os-setup.sh always exits 1 because of its last line `(( APPLY )) &&`; that's benign." Only script in `scripts/*.sh` ending this way. |
| Introduced | `e5ac7fe` (`git log -S'(( APPLY )) &&'`) |
| Status | **OPEN** |
| Production impact | None on state (dry run changes nothing). Breaks `dry-run && --apply` chaining, automation and any test asserting exit 0. `fleet-phase4.test.ts:514` checks dry-run default and stdin passwords, not the exit code. |
| Workaround | Ignore exit 1 after a dry run that printed "Done."; inspect output. |
| Future fix | `if (( APPLY )); then echo …; fi` or append `exit 0`. |

### MK-OPS-2 — `bridge-claude` signing key expiry

| Field | Value |
|---|---|
| Facts | Principal `op_01M3AX56W25JNMQCTBM8HYH474` (kind `bridge_claude`; scopes `ops.read.status`, `ops.read.agents`, `ops.read.events`), key id `ec4f06982ae9135fd2b28e928f5a4a61`, expires **2026-10-24T23:49:04.533Z**. Key file lives only on the dev VM. |
| Evidence | Runbook `:1192`, `:1201` ("Rotate the key … before 2026-10-24"), `:1261-1265`; DB constraint: 90-day cap on key lifetime (`operator-pg.test.ts:358`); bridge expiry classes `ok > 21 days, warn, critical ≤ 7, expired` (`bridge-unit.test.ts:272`). |
| Status | **OPEN, time-bound.** As of 2026-09-25: ~30 days left; the bridge status turns `warn` at ≤ 21 days (≈ 2026-10-03) and `critical` at ≤ 7 days (≈ 2026-10-17). |
| Production impact | At expiry: `AUTH_FAILED` / `KEY_EXPIRED`; the Claude bridge CLI and the `fleet-operator` MCP server lose access. Fleet runtime unaffected. |
| Procedure | Dev VM `key rotate-prepare` → VPS `fleet:admin operator-add-key` → `key rotate-verify` → `key rotate-switch` → VPS `operator-revoke-key` → `key rotate-finish` (tested end to end in `bridge-integration.test.ts:224`). VPS steps need approval. |

### MK-OPS-3 — `bridge-chatgpt` signing key expiry

| Field | Value |
|---|---|
| Facts | Principal `op_01M3B18TXVP33S6NQC909DXD57` (kind `bridge_chatgpt`; scopes `ops.read.status`, `ops.read.agents`; the DB forbids events for this kind), key id `fe22d91c08f0a0676b4c155ce0d618d3`, expires **2026-10-25T01:00:57.682Z** (first key: 30 days after enrolment). Key at `/var/lib/automaton-fleet-chatgpt-adapter/bridge-chatgpt.key` (adapter user, 0600, VPS). |
| Evidence | Runbook `:1218-1220` (event 112); design `phase-c-chatgpt-adapter.md` §7 (rotation ≤ 90 days: `sudo mv` old key aside, `runuser -u automaton-fleet-chatgpt-adapter -- node …/keygen.js <new key>`, add/revoke via `fleet:admin`). |
| Status | **OPEN, time-bound.** |
| Production impact | At expiry the adapter's identity gate fails (`IDENTITY_MISMATCH`/`AUTH_FAILED`); ChatGPT reads stop. |

### MK-OPS-4 — ChatGPT tunnel runtime key and ChatGPT app pending (owner action)

| Field | Value |
|---|---|
| Facts | Tunnel id `tunnel_6ab5cd2c7b088191abe137e56b5f35e4` configured (the owner typed `tnnel_6ab5…`; `tunnel-client` requires `^tunnel_[a-z0-9]{32}$`, operator record). `automaton-fleet-chatgpt-tunnel.service` enabled but **inactive**; `automaton-fleet-chatgpt-tunnel.path` (from `d22f517`) starts it once `/etc/automaton-fleet/chatgpt-tunnel/openai-api-key` exists. |
| Pending | Owner creates an OpenAI Platform runtime API key (Tunnels Read+Use), runs `sudo fleet-chatgpt-tunnel-key` in their own terminal (hidden TTY entry; commits `d22f517`, `e49d287`, `aed747e`, `efad214`), and creates the ChatGPT developer-mode app (Connection: Tunnel, No authentication). |
| Status | **OPEN (owner)**. `fleet-verify-deployment.sh:101` reports PASS "OpenAI tunnel key not yet provided (tunnel stays off)". |
| Production impact | None on the controller; ChatGPT integration non-functional. |

### MK-OPS-5 — ChatGPT product ↔ tools end-to-end unproven

| Field | Value |
|---|---|
| Facts | Proven: MCP over the adapter socket as `tunnel-client` would send it (4 tools, whoami as `bridge_chatgpt`, refusals, 401/404, rate limit 10 calls then `RATE_LIMITED`; runbook `:1222`); a `tunnel-client` dry run in the unit sandbox with a dummy key (MCP session OK, Harpoon 0 targets, OAuth discovery absent, OpenAI egress OK with 401 on the dummy key; operator record). **Not proven:** ChatGPT → OpenAI tunnel → tunnel-client → adapter with a real key; whether ChatGPT's developer-mode app lists and calls the four tools; `structuredContent` rendering; DB attribution of real ChatGPT calls to `bridge-chatgpt`. |
| Status | **OPEN** — blocked by MK-OPS-4. |
| Planned verification (records) | Tunnel connected; adapter audit shows ChatGPT calls; DB attribution to `bridge-chatgpt`; `fleet:verify` 16/16. |

### MK-OPS-6 — certificate renewal path untested; monitoring absent

| Field | Value |
|---|---|
| Facts | `LoadCredential` copies `fleet.key`/`fleet.crt` only at service start, so renewal needs a copy + restart. Deploy hook `/etc/letsencrypt/renewal-hooks/deploy/automaton-fleet.sh` installed (SHA-256 `197dfe74…1a5f`); "**It has not been tested by hand yet**" (runbook `:103`). `certbot renew --dry-run` does not run deploy hooks (`:1334`). Monitoring (14-day expiry alert, `certbot.timer` scheduled, hook exit status) is "to be set up" (`:1340-1344`). The service refuses to start if the certificate expires within one day (`:1293`). |
| Status | **OPEN** |
| Production impact | A failed or never-applied renewal turns the next restart into an outage. Current certificate valid until 2026-12-23. |
| Future action | Scheduled manual hook test (restarts the service; approval), then monitoring. |

### MK-OPS-7 — `ubuntu` passwordless sudo on the VPS

Runbook `:143`, `:1367-1383`: `sudo -n true` succeeds (cloud-init `90-cloud-init-users` `NOPASSWD:ALL`).
Anyone with the `ubuntu` SSH key has root without a second factor. Status **OPEN**; plan documented
(password rule, `visudo -cf`, second-session check, cloud-init override); approval-gated.

### MK-OPS-8 — plaintext registry dumps with mode 0664

Runbook `:144`, `:1350-1363`: VPS `~ubuntu/automaton-fleet-final-frozen.dump` and
`automaton-fleet-pre-vps.dump` (0664); local copies also 0664. They contain registry state,
audit history and token/session **hashes**. Recommendation: delete VPS copies (no sudo needed),
`chmod 0600` and encrypt the local cutover backup. Status **OPEN**. Also recorded: S9b working files
in `~ubuntu` are 0664 but hold no secrets (`:151`); later dumps (`automaton_fleet-v6-pre-v7.dump`,
`automaton_fleet-v7-pre-v8.dump`, `automaton_fleet-v8-pre-chatgpt-20260925T005947Z.dump`) are 0600.

### MK-OPS-9 — journal access and pending upgrades

Runbook `:145-146`: `ubuntu` is not in `adm`/`systemd-journal` (journal reads need sudo);
130 package upgrades pending (unattended-upgrades active). Also `:76`: ufw rules not reviewed at stage 1-2.
Status **OPEN**. <!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->

### MK-OPS-10 — "JSONL audit file is written without `scrubDetail`" — STALE

- Runbook open item `:152`: "The JSONL audit file is written without `scrubDetail` (`src/fleet/service/main.ts:258`); only the stdout and database copies are scrubbed … not fixed yet."
- **STALE:** fixed by `03f8760` "security: centralize fleet audit redaction" (Gate B0). `main.ts:255` now builds the sink with
  `createAuditSink(log, e.FLEET_AUDIT_LOG?.trim() || undefined)`, and `src/fleet/service/log.ts:40-47` writes
  the **same** `redactAuditRecord(entry)` output to stdout and the JSONL file:
  ```ts
  return (entry) => {
    const { record, line } = redactAuditRecord(entry);
    log("info", record.event, { agentId: record.agentId, ...record.detail, audit: true });
    if (auditFile) fs.appendFileSync(auditFile, line + "\n", { mode: 0o600 });
  };
  ```
  Tested by `redact-sinks.test.ts:58` ("JSONL audit file and its stdout copy carry the identical redacted detail").
  The historical pre-B0 file was scanned in production with the B0 scanner (84 lines, 0 findings; operator record B0-5) and preserved as `audit.jsonl.pre-b0-20260924T215651Z`.

---

## 7. Structural / architectural open issues

### MK-ARCH-1 — sandboxes cannot be terminated (Conway)

- Code: `src/fleet/service/terminator.ts:9-33` — "The Conway API currently offers no way to stop or delete a sandbox (ConwayClient.deleteSandbox is a no-op upstream)"; `CONWAY_TERMINATION_UNSUPPORTED = "Conway API has no sandbox stop/delete endpoint (deleteSandbox is a no-op); the sandbox may still be running."`; `UnsupportedSandboxTerminator.guaranteed = false`.
- Recorded in DB as `fleet_sandbox_terminations.status = 'unsupported'` → event `sandbox_termination_unsupported` (`migrations.ts:787-798,1092-1104`); Phase 5 provisioning cleanup: `unsupported` or 5 failed attempts → ORPHANED (`migrations-phase5.ts:505-534`).
- Doctor: `add("sandbox termination", "warn", "not supported by the Conway API; dead agents' sandboxes may keep running")` (`src/fleet/doctor.ts:434`); a blocker for SAFE FOR REAL REPLICATION.
- Introduced: Phase 4 (`e5ac7fe`). Status **OPEN (structural)**. Production impact now: none (0 agents). Future fix: a provider with a guaranteed stop/delete API, or a controller-owned sandbox lifecycle.

### MK-ARCH-2 — attestation trusts the sandbox; child Node not pinned

- `FLEET.md:33`, `FLEET.md:238` ("Sandbox-side verification trusts the sandbox's own `git` output. A compromised sandbox could lie. Real attestation (e.g. an image digest) would be stronger.").
- Status **OPEN (structural)**; blocks SAFE FOR REAL REPLICATION. No code change since Phase 2/3.

### MK-ARCH-3 — no controller custody signer; agents hold wallet keys

- Doctor: `add("wallet custody", "warn", "agent wallets are controller-supervised (freeze, spend requests) but keys are still generated and held by each agent runtime")` (`src/fleet/doctor.ts:450`).
- `fleet-phase5.test.ts:328`: spend execution never happens with payments disabled **or without a controller signer**. `src/fleet/types.ts:39`: "Owner sweeps are not implemented in Phase 1" (parsed for visibility only).
- CLAUDE.md: "never create a controller signer unless explicitly requested and reviewed". Operator records: a central treasury + per-agent virtual ledger replacing agent-held wallets is being planned — **NOT IMPLEMENTED**.
- Status **OPEN (structural)**; blocks SAFE FOR REAL PAYMENTS.

### MK-ARCH-4 — no completed dry-run child

`FLEET.md:31`. Depends on FLEET-KI-4 enrolment (§4) and stage 22 (paid sandbox; approval). Status **OPEN**.

### MK-ARCH-5 — checklist item "fleet cap = 2" is hard-coded

`src/fleet/doctor.ts:530`: `item("fleet cap = 2", facts.fleetMaximum === 2, …)`. The 16-item
`fleet:verify` checklist is deliberately frozen (B2 F10, `doctor.ts:312`). It is correct for the
dry-run posture (dry run requires cap ≤ 2, `fleet-phase6.test.ts:934`), but any approved cap change
(target 50) will make `fleet:verify` report 15/16. Status **OPEN (design constraint)**; future fix:
make the expected cap a parameter of the checklist level (dry-run vs expansion).

### MK-ARCH-6 — redactor does not detect deliberate re-encoding

`src/fleet/redact.ts:256-257`: "Limitation: deliberate re-encoding (e.g. dots between words, reversed
words) is not detected; redaction targets accidental inclusion." Status **ACCEPTED LIMITATION**.
Mitigation: secrets are never placed in agent-reachable text by design; B0 scan of historical logs.

---

## 8. Test-suite issues

### MK-TEST-1 — full-suite hang (upstream)

`src/__tests__/context-hardening.test.ts:104` describe "buildContextMessages token budget" never
finishes (synchronous CPU spin), so `pnpm test`, `test:ci` and `test:coverage` never exit. Last
changed upstream `2c717cf` (2026-02-19), before `baseline-before-fleet` (`d8f8168`). Recorded
2026-09-23 on a clean worktree. Workaround: exclude the file, then run it with
`-t '^(?!.*buildContextMessages token budget)'` (see `13-TEST-INVENTORY.md` §8). Status **OPEN**, not fleet code.

### MK-TEST-2 — Phase 2 PostgreSQL tests may target a real registry database

`src/__tests__/fleet/fleet-phase2.test.ts:81-95`: `PG_URL` falls back from `FLEET_TEST_DATABASE_URL`
→ `DATABASE_URL` → `.env.fleet` `DATABASE_URL` → `loadAdminEnv({}).env.FLEET_ADMIN_DATABASE_URL`
(`/etc/automaton-fleet/admin.env`). On a host where the operator can read `admin.env`, the suite
creates and drops schema `fleet_test_<ulid>` **in the controller's database** with the owner
credential, and — via `migrate()` → `grant*Role` — issues REVOKE/GRANT statements for the real
restricted roles on that throwaway schema, and writes `*_role_granted` events into it. Introduced with the
admin.env fallback in `e5ac7fe` (Phase 4 moved the DSN to `admin.env`). Status **OPEN (test-safety)**.
Production impact: none as long as tests are never run on the VPS (CLAUDE.md forbids running
unscoped suites against production). Future fix: require an explicit `FLEET_TEST_DATABASE_URL`, or
switch Phase 2 to `fixtures/ephemeral-pg.ts`.

### MK-TEST-3 — vacuous passes and skips

- `fleet-phase6.test.ts:280-290` returns early unless `automaton-fleet.service` is active; `:342-350` returns early unless `/etc/automaton-fleet` exists.
- 178 PostgreSQL tests are skipped when `findPgBin()` finds no `initdb`/`pg_ctl`/`psql` or `PG_URL` is empty.
Status **OPEN (coverage)**; mitigation: `scripts/fleet-verify-deployment.sh` covers the host checks.

### MK-TEST-4 — tunnel-key helper regressions without automated tests

`aed747e` (echo off immediately, pre-prompt typeahead discarded) and `efad214` (EXIT/INT/TERM/HUP trap
restores the terminal and rolls back a staged-but-unaccepted key; start-limit counters reset;
rollback flag reset in the parent) were found by manual **production pty attack tests**.
`chatgpt-tunnel-key.test.ts` (5 tests) covers normalization, hygiene categories, log classification
and TTY/privilege refusal, but not the trap-based rollback or typeahead handling. Status **OPEN (coverage)**.

---

## 9. Documentation drift

| ID | Document | Claim | Reality | Evidence |
|---|---|---|---|---|
| MK-DOC-1 | `FLEET.md:7-27` "Current deployment state (2026-09-24)" | runtime `11c0c7c`, schema v6, controller on the local VM, remote HTTPS disabled, cap 1, witness "In development (not deployed)" | Production: VPS, runtime `4d6a0be` / build `54beb101…`, schema v8, public HTTPS on 443, cap 2, witness deployed (not enrolled), Operator API + ChatGPT adapter | CLAUDE.md, runbook `:1196-1224`. **DRIFT.** `FLEET.md:28` ("root witness … implemented but not yet deployed") and `FLEET.md:25-27` (blockers HTTPS valid / remote reachable / cap = 2, all since cleared) are also stale. |
| MK-DOC-2 | `FLEET.md:474` | `fleet-phase4.test.ts` 38 tests | 53 (`241dcf9` +7, `11c0c7c` +8) | **DRIFT** |
| MK-DOC-3 | `CLAUDE.md` "The Fleet Control Plane owns: … Redis" | Redis is part of the control plane | No Redis client exists in fleet code; `REDIS_URL` only appears as a secret name to scrub/forbid (`src/fleet/secrets.ts`, `src/fleet/secret-files.ts`, `src/fleet/dry-run/child.ts`); runbook `:1407` "Whether Redis should be installed at all while no fleet code uses it" | **DRIFT**; Redis is installed, loopback-only, unused |
| MK-DOC-4 | `docs/fleet-known-issues.md` KI-3, KI-4 | see §3, §4 | see §3, §4 | **STALE** entries (source not edited) |
| MK-DOC-5 | Runbook open item `:152` | JSONL audit unscrubbed | fixed in `03f8760` | **STALE** (§6 MK-OPS-10) |
| MK-DOC-6 | `ARCHITECTURE.md:255,743`, `DOCUMENTATION.md:90` | "24 test files, 897 tests" | upstream pre-fleet numbers | **DRIFT** (not maintained) |

---

## 10. What requires operator approval next (from this reconciliation)

Approval-gated (per CLAUDE.md): rotating `bridge-claude` (VPS `operator-add-key`/`operator-revoke-key`) before
2026-10-24; rotating `bridge-chatgpt` before 2026-10-25; witness enrolment/start and the dry-run
child (stage 21b/22); the certbot deploy-hook test (service restart); sudoers hardening; VPS dump
deletion is non-privileged but destructive. Owner-only: OpenAI runtime key entry and ChatGPT app
creation (MK-OPS-4). Code fixes for KI-1, KI-2, MK-OPS-1 and MK-TEST-2 are local, reversible and
not yet made (this pass is read-only).
