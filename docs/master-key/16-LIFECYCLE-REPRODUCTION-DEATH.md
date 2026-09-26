# PART 18 — Lifecycle: enrollment, reproduction and death

> Master Key volume 16. Every lifecycle mechanism of the Automaton Fleet, one section each, with an
> implementation status, the gate that controls it, and the gate's current production value.
> Source of truth: code at branch `fleet-development`, HEAD `efad214`, cited as `path:line`.
> The controller-side mechanics (HTTP routes, authentication, reaper internals, full SQL state
> machine) are in volume 04 (`04-FLEETCONTROLLER.md`); this volume does not repeat them in full.

---

## 0. Status legend and current gate values

| Status | Meaning |
|---|---|
| **IMPLEMENTED AND ACTIVE** | Code exists and runs in the production controller today, or would run today on its triggering input without any flag change. |
| **IMPLEMENTED BUT INERT** | Code exists, but a gate (flag, mode, missing enrollment) prevents it from running in production today. |
| **NOT IMPLEMENTED** | No code exists. |

Gates and their current values (operator records, 2026-09-25):

| Gate | Where read | Current value |
|---|---|---|
| `REAL_REPLICATION_ENABLED` (service process) | `src/fleet/service/main.ts:258`, enforced `src/fleet/service/server.ts:821-824` | `false` |
| `REAL_REPLICATION_ENABLED` (agent process) | `src/fleet/config.ts:264`, enforced `src/fleet/policy.ts:121-123` | `false` (no agent exists) |
| `fleet_state.operating_mode` | `fleet_reserve_slot` (`src/fleet/postgres/migrations-phase7.ts:178-183`) | `DEVELOPMENT` |
| `fleet_state.replication_enabled` (DB switch) | `migrations-phase7.ts:184-185` | <!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md --> (repo default `false`, `src/fleet/postgres/migrations.ts:287`) |
| `fleet_state.max_agents` | cap trigger + allocators | `2` |
| `FLEET_DRY_RUN_CHILD` (operator CLI process) | `src/fleet/dry-run/operator.ts:163` | `false` |
| `REAL_PAYMENTS_ENABLED`, `OWNER_SWEEP_ENABLED` | agent policy / refused by witness, dry-run child and dry-run preflight | `false` |
| Witness root | `fleet:admin enroll-witness-root` | **not enrolled**; OS user and unit installed, not started |
| Sandbox terminator | `src/fleet/service/server.ts:228` | `UnsupportedSandboxTerminator` (only implementation) |
| Registry population | — | 0 living, 0 reserved, 0 quarantined |

Summary table (details in the sections below):

| # | Mechanism | Status | Gate(s) blocking it now |
|---|---|---|---|
| 1 | Root enrollment (`enroll-root`) | IMPLEMENTED AND ACTIVE (operator-only tool; no root enrolled) | operator action + admin credential |
| 2 | Witness root enrollment + root witness process | IMPLEMENTED BUT INERT | witness not enrolled; unit not started |
| 3 | Dry-run child (`fleet_reserve_dry_run`, operator dry run, child process) | IMPLEMENTED BUT INERT | `FLEET_DRY_RUN_CHILD=false`; no living root; `--confirm-real-sandbox` |
| 4 | Reproduction / replication request | IMPLEMENTED BUT INERT | service `REAL_REPLICATION_ENABLED=false`; mode `DEVELOPMENT`; DB switch; no agents |
| 5 | Reservation (`fleet_reserve_slot`) | IMPLEMENTED BUT INERT (for replication); ACTIVE code path for dry run is operator-only | as 4 |
| 6 | Claim + child provisioning (`fleet_provisioning` intents) | IMPLEMENTED BUT INERT | needs a reservation (4 or 3) |
| 7 | Attestation | IMPLEMENTED BUT INERT | needs a claimed reservation |
| 8 | Activation | IMPLEMENTED BUT INERT | needs attestation |
| 9 | Cap enforcement (race-safe) | IMPLEMENTED AND ACTIVE | — (cap 2) |
| 10 | Heartbeat / health challenge / unresponsive | IMPLEMENTED AND ACTIVE | no agents to act on |
| 11 | Death (all causes) | IMPLEMENTED AND ACTIVE | no agents to act on |
| 12 | Termination (sandbox stop) | queue ACTIVE; actual stop NOT IMPLEMENTED (terminator unsupported) | Conway API has no stop endpoint |
| 13 | Orphaning / quarantine slots | IMPLEMENTED AND ACTIVE | no agents to act on |
| 14 | Slot release | IMPLEMENTED AND ACTIVE | — |
| 15 | Genesis (fleet founding), founder generation, Reseeding, Replacement, economic estate | NOT IMPLEMENTED | — |

"ACTIVE" rows 9–14 are enforced by triggers and the reaper, which run every 15 s in production
(`src/fleet/service/server.ts:294-300`); with zero agents they currently have nothing to act on.

---

## 1. Root enrollment

**Status: IMPLEMENTED AND ACTIVE** (operator tool; production has no enrolled root).
**Gate:** operator runs the CLI with the admin (schema-owner) credential; the fleet service cannot enroll
(no `INSERT` privilege on `fleet_agents`, `src/fleet/postgres/store.ts:793-812`), and agents cannot self-register
(`FleetApiClient.registerRoot` only confirms an existing identity, `src/fleet/service/client.ts:252-272`).

Command: `pnpm fleet:admin enroll-root <wallet> <name> [credentialFile]` (`src/fleet/postgres/cli.ts:504-514`).

Steps:
1. `PgFleetStore.registerRoot({walletAddress, name})` (`store.ts:892-948`), under the `fleet_state` row lock:
   - wallet already known → must be a `root` with the same capability scope and status `active|unresponsive`; a dead root is refused (`FLEET_AGENT_DEAD`, "the dead are not revived"); returns the existing agent.
   - new wallet: if `living + reserved + quarantined >= min(max_agents, 50)` → event `registration_denied`, `FLEET_CAP_REACHED`.
   - `INSERT fleet_agents (agent_id = ulid(), role 'root', generation 0, status 'active', last_heartbeat now(), capability_scope 'full')`; event `root_registered`.
   - trigger `fleet_agents_custody_on_insert` creates `fleet_wallet_custody` (`controller_supervised`, `daily_limit_cents 0`) (`migrations-phase5.ts:299-309`).
2. `issueCredential(agentId)` mints `fa1.<agentId>.<43 base64url>`, stores only its SHA-256, revokes all existing sessions, event `credential_issued` (`store.ts:970-992`).
3. `writeCredentialFile` writes `{agentId, token, apiUrl}` to a temp file (`mode 0600`, `flag wx`), renames it into place, `chmod 0600`; directory created `0700` (`cli.ts:97-103`). The token is never printed.

Liveness obligation after enrollment: a root is `active` only while it heartbeats **and** passes controller health
challenges. With default timeouts a root that never runs becomes `unresponsive` once
`COALESCE(last_challenge_ok_at, activated_at, created_at)` is older than `health_grace_s` = 300 s, and is terminated
when its heartbeat is older than `heartbeat_dead_s` = 600 s or it has been unresponsive for `termination_grace_s` = 480 s
(`migrations-phase5.ts:813-843`). A root has no `sandbox_id`, so `fleet_begin_termination` marks it `dead` directly
(`migrations-phase5.ts:489-493`). Net effect: an enrolled root that never heartbeats is dead roughly 600 s after
enrollment (measured through the reaper's outage grace, section 11).

Agent-side boot of a root (`src/index.ts:50-64, 334-372`): refuses `--run` if any privileged env var is present
(`findPrivilegedEnv`, `src/fleet/secrets.ts:15-57`); a root may run without a runtime manifest (`verifyOwnRuntime`,
`runtime.ts:259-263`); `getSharedFleetForContext` builds a `SharedFleetController` only when `FLEET_API_URL` (or the
credential file's `apiUrl`) and the credential file exist; heartbeats every 30 s; on `dead|failed` the process sends
itself `SIGTERM`.

---

## 2. Witness root (`capability_scope = 'witness'`) and the root witness process

**Status: IMPLEMENTED BUT INERT.**
**Gates:** no witness is enrolled (operator records); `automaton-fleet-witness.service` is installed but "NOT enabled
or started by any script" (`deploy/systemd/automaton-fleet-witness.service`); the operator starts it only for the dry run.

### 2.1 Purpose

The dry run needs a living **root** parent (`fleet_reserve_dry_run` requires `par.role = 'root' AND par.status = 'active' AND NOT par.dry_run`,
`migrations-phase6.ts:354-357`). The witness is a root identity that can only stay alive and nothing else
(`src/fleet/postgres/migrations-phase7.ts:1-24`).

### 2.2 Schema v7 enforcement (`migrations-phase7.ts`)

| Mechanism | Rule | Lines |
|---|---|---|
| column | `capability_scope text NOT NULL DEFAULT 'full' CHECK (capability_scope IN ('full','witness'))` | 31-32 |
| constraint `fleet_agents_witness_is_root` | `capability_scope = 'full' OR (role = 'root' AND NOT dry_run AND parent_agent_id IS NULL)` | 33-34 |
| trigger `fleet_agents_zz_scope_immutable` | any change of `capability_scope` → `FLEET_HISTORY_IMMUTABLE` | 36-44 |
| trigger `fleet_agents_scope_parent_guard` | a non-`full` agent cannot parent a **non-dry-run** child → `FLEET_PARENT_SCOPE` | 48-58 |
| `fleet_custody_dry_run_guard` (v7) | custody of dry-run or non-`full` agents always `spending_frozen = true`, `daily_limit_cents = 0` | 62-76 |
| `fleet_allocations_dry_run_guard` (v7) | non-`full` agent cannot hold capital → `FLEET_SCOPE_DENIED` | 78-88 |
| `fleet_authenticate` (v7) | scope `witness` may authenticate only actions `open_session`, `heartbeat`, `whoami`; everything else `FLEET_SCOPE_DENIED` + event `scope_denied {layer: 'database'}` | 93-144 |
| `fleet_reserve_slot` (v7) | parent with scope ≠ `full` → `FLEET_PARENT_SCOPE` | 199-200 |
| service route policy | witness allowed only `GET /v1/self`, `POST /v1/session`, `POST /v1/heartbeat`, `POST /v1/health/challenge` | `server.ts:83-102` |

`WITNESS_API_ACTIONS = ["open_session", "heartbeat", "whoami"]` (`migrations-phase7.ts:26`).

### 2.3 Enrollment: `pnpm fleet:admin enroll-witness-root <name> <credentialFile>` (`cli.ts:140-173, 515-521`)

1. Refuses if `credentialFile` already exists (`lstat`).
2. Requires an approved runtime (`fleet_state.runtime_commit` and build) → else "No runtime is approved in the registry; approve the pinned release first."
3. `registerRoot` with a **keyless** wallet address `keylessAddress("automaton-fleet:witness-root:no-key:<32 random bytes hex>")` = `"0x" + sha256(seed)[0..40]` (`src/fleet/dry-run/operator.ts:74-76`) — no private key exists for it; `runtimeCommit` = approved commit; `capabilityScope: "witness"`.
4. `agentAuthority` must show custody frozen with a zero daily limit (enforced by the v7 custody trigger).
5. `issueCredential`, then `writeCredentialFileExclusive` (temp file `0600 wx`, `linkSync` into place so an existing file is never replaced, `chmod 0600`) (`cli.ts:109-122`).
6. Any failure after registration → `markDead(agentId, "witness enrollment failed")` (revokes everything).
7. Default `apiUrl` in the credential file: `FLEET_API_URL` or `http://127.0.0.1:8787`.

### 2.4 Root witness process (`src/fleet/dry-run/root-witness.ts`, `root-main.ts`)

Unit `automaton-fleet-witness.service`: `User=automaton-fleet-witness`, `ExecStart=… node dist/fleet/dry-run/root-main.js`,
`FLEET_API_URL=http://127.0.0.1:8787`, `FLEET_CREDENTIALS_FILE=/var/lib/automaton-fleet-witness/fleet-credentials.json`,
`FLEET_WITNESS_INTERVAL_MS=30000`, `RestartPreventExitStatus=3 4`, loopback-only network, `InaccessiblePaths` for
`admin.env`, `service.env`, `tls/`, `legacy-env-fleet.bak`, `/home/automaton-agent`, `/var/lib/automaton-fleet`,
`/var/log/automaton-fleet`, `/run/credentials`.

Preflight (no network) — any problem → `WitnessRefusedError` (exit **4**) (`root-witness.ts:116-174`):
uid 0; `REAL_PAYMENTS_ENABLED`/`REAL_REPLICATION_ENABLED`/`OWNER_SWEEP_ENABLED` true in env or runtime.env; any
privileged env (`findPrivilegedEnv`) or `DRY_RUN_FORBIDDEN_ENV` name present; any `~/.automaton/wallet*` file;
readable `admin.env`, `service.env`, `tls/fleet.key` or `legacy-env-fleet.bak`; no complete pinned release; installed
tree build id or lockfile ≠ pinned.

Startup (network): reads its credential; `GET /v1/self` must return `role root`, `capabilityScope witness`, not dead,
and `runtimeCommit` = pinned commit (`root-witness.ts:217-227`); rejected credential/dead → `WitnessRejectedError`
(exit **3**).

Loop: `heartbeat()` every `intervalMs` (env clamped to **10 000..60 000**, default 30 000, `root-main.ts:20-21`);
challenges answered by `witnessHealthResponder` (pinned commit + buildId; `policyOk` = the bundled shell guard
matches the canary — the canary is never executed) (`root-witness.ts:180-182`). Controller unavailable → wait and
retry. Heartbeat refused with status not `active|unresponsive` → exit 3; **5** consecutive refusals
(`MAX_REFUSED_HEARTBEATS`) → error (exit 1). `SIGTERM`/`SIGINT` → clean stop (exit 0).

Endpoints the witness calls (informational list; the security boundary is server-side scope):
`POST /v1/session`, `POST /v1/heartbeat`, `POST /v1/health/challenge`, `GET /v1/self` (`root-witness.ts:50-55`).

---

## 3. Dry-run child (DRY_RUN_CHILD)

**Status: IMPLEMENTED BUT INERT.**
**Gates (all must be open):** `FLEET_DRY_RUN_CHILD=true` in the operator CLI process (`operator.ts:163`) — currently
`false`; `--confirm-real-sandbox` on the command line (`cli.ts:429-433`); `CONWAY_API_KEY` set (`cli.ts:434-435`); a
living root (none: witness not enrolled); preflight passes. Independent of `REAL_REPLICATION_ENABLED` and of the DB
replication switch by design (`migrations-phase6.ts:325-328`).

### 3.1 Database: `fleet_reserve_dry_run` (`migrations-phase6.ts:329-380`)

Owner-only (never granted to service or agent roles). Under `fleet_lock_state()`, after `fleet_expire_leases`, refusal order:

| Condition | Code |
|---|---|
| mode not `DEVELOPMENT` or `EXPANSION` | `FLEET_<MODE>` (e.g. `FLEET_HARVEST`, `FLEET_EMERGENCY`) |
| no approved runtime/build | `FLEET_RUNTIME_UNVERIFIED` |
| any open orphan (`> 0`) | `FLEET_ORPHANS_UNRESOLVED` |
| `max_agents > 2` | `FLEET_DRY_RUN_CAP` |
| a dry-run agent in `reserved/provisioning/active/unresponsive/terminating/orphaned` | `FLEET_DRY_RUN_IN_PROGRESS` |
| `living + reserved + quarantined >= max_agents` | `FLEET_CAP_REACHED` |
| parent missing, not `root`, not `active`, or `dry_run` | `FLEET_PARENT_NOT_LIVING` |

Grant: inserts the child with `dry_run = true`, `request_key = 'dry-run:' || reservation_id`, and a `dry_run` lease;
event `slot_reserved {dryRun: true, …}`. A witness root is acceptable here (the function does not check scope; the
scope parent guard exempts dry-run children, `migrations-phase7.ts:51`).

Permanent restrictions on a dry-run agent (`migrations-phase6.ts:383-424`, `migrations-phase7.ts:62-88`): cannot be
a parent (`FLEET_DRY_RUN_NO_REPLICATION`, event `replication_rejected`); only children can be dry-run; custody forced
frozen with zero limit; cannot hold capital (`FLEET_DRY_RUN_NO_SPEND`); `dry_run` flag immutable (transition guard,
`migrations-phase6.ts:95`).

### 3.2 Operator procedure: `pnpm fleet:dry-run-child --root <agentId> --api-url https://… [--confirm-real-sandbox]` (`operator.ts:154-259`)

Without `--confirm-real-sandbox` only the preflight runs (exit 0/1).

Preflight (`operator.ts:83-139`): `REAL_PAYMENTS_ENABLED`, `OWNER_SWEEP_ENABLED`, `REAL_REPLICATION_ENABLED` must be
false; URL must be `https:` and not loopback; `GET <origin>/healthz` within 5000 ms must return `ok:true`; registry
`maxAgents` must be **exactly 2**; a free slot; zero open orphans, stale reservations, uncertain provisioning and dry-run
children; approved runtime present and equal (`sameRelease`) to the pinned `FLEET_RUNTIME_*`; `--root` must be a living root.

Real run, in order (each step logged):
1. `reserveDryRunSlot` (`store.ts:1063-1077`, requestedBy `operator:dry-run`).
2. `claimGrant(agentId, ulid(), {parentAgentId: root})` → `svc_claim` (nonce issued, provisioning row created).
3. `createTrackedSandbox(conway, claimed, {vcpu 1, memoryMb 1024, diskGb 10})` (section 6).
4. `reportProvisioning("verifying")`; `installPinnedRuntime` (install, verify, attest; section 7).
5. `activate(agentId, {walletAddress: keylessDryRunAddress(agentId), sandboxId, runtimeCommit, runtimeVersion, attestation, parentAgentId: root, actor: "operator:dry-run", provisioningKey})`; keyless address = `keylessAddress("automaton-fleet:dry-run:no-key:<agentId>")`.
6. Writes `/root/.automaton/fleet-runtime.json` with `dryRun: true` and the provisioning key; delivers the credential (`0600`) with `apiUrl` = controller origin; starts `node dist/fleet/dry-run/child-main.js` under `env -i HOME=/root PATH=… REAL_PAYMENTS_ENABLED=false OWNER_SWEEP_ENABLED=false REAL_REPLICATION_ENABLED=false`, logging to `/root/.automaton/dry-run-child.log`.
7. Polls `agentAuthority` every `pollMs` (5000 ms) up to `waitActiveMs` (300 000 ms) for `status active` **and** `lastChallengeOkAt` set.
8. `ok` only if healthy **and** zero-authority (`dryRun true`, `spendingFrozen true`, `dailyLimitCents 0`).
9. Any failure: `reserved|provisioning` → `recordVerificationFailure` (slot released, or orphaned if a sandbox intent is uncertain); `active|unresponsive` → `quarantine` (termination → orphaned with the unsupported terminator).

### 3.3 Child process (`src/fleet/dry-run/child.ts`, `child-main.ts`)

Refuses to run (`dryRunChildProblems`, `child.ts:67-86`) if any of `REAL_PAYMENTS_ENABLED`, `OWNER_SWEEP_ENABLED`,
`REAL_REPLICATION_ENABLED` is true; any of `DRY_RUN_FORBIDDEN_ENV` (`FLEET_ADMIN_DATABASE_URL`, `FLEET_SERVICE_DATABASE_URL`,
`FLEET_AGENT_DATABASE_URL`, `FLEET_CONTROLLER_DATABASE_URL`, `DATABASE_URL`, `REDIS_URL`, `PGPASSWORD`,
`WALLET_PRIVATE_KEY`, `PRIVATE_KEY`, `CONWAY_API_KEY`) is present; `~/.automaton/wallet.json` exists; the manifest is
unreadable, not `dryRun: true`, or has no provisioning key. The credential's agent id must equal the manifest's.
It heartbeats every `FLEET_DRY_RUN_INTERVAL_MS` (default 30 000 ms) and answers challenges; exits when the controller
stops accepting it. It never starts the agent loop, creates a wallet, or requests replication, spend or capital.

Doctor gate: `fleet:doctor` lists "No dry-run child has yet reached ACTIVE and passed a controller challenge" as a
blocker to real replication until `dry_run_proven > 0` (`src/fleet/doctor.ts:541-546`, `store.ts:1560-1561`).

---

## 4. Reproduction / replication

**Status: IMPLEMENTED BUT INERT.**
**Gates closed now:** service `REAL_REPLICATION_ENABLED=false` (`server.ts:821-824`, returns `403 REAL_REPLICATION_DISABLED`
and records DB event `replication_rejected {by: "service"}`); `operating_mode = DEVELOPMENT` (`fleet_reserve_slot`
returns `FLEET_DEVELOPMENT_MODE`); DB `replication_enabled` <!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->;
no agent exists to ask. Even if all flags were opened, the doctor's real-replication checklist requires a proven dry
run first (`doctor.ts:541-546`).

Entry points (all converge on `requestSharedReplication`, `src/fleet/shared.ts:403-422`):
- agent tool `spawn_child` (`src/agent/tools.ts:1652-1709`);
- orchestrator `spawnAgent` (`src/agent/loop.ts:222-252`).

Full path (details in volume 04 §10):
1. `localReplicationPreflight` (agent `FLEET_MODE` default `DEVELOPMENT`, agent `REAL_REPLICATION_ENABLED`) (`shared.ts:394-397`, `policy.ts:96-133`).
2. PolicyEngine rule `fleet.policy_gate` (`src/agent/policy-rules/fleet.ts:41-107`).
3. `SharedFleetController.evaluateReplication`: strictest mode of local and shared, cap on shared occupancy, registered, local pin = approved pin, financial eligibility (survival tier `normal|high`, credits ≥ `MIN_AGENT_RESERVE_USD`, default 10 USD = 1000 cents) (`shared-controller.ts:235-282`, `policy.ts:64-89`).
4. `POST /v1/replication/request` → service switch → `api_request_replication` → `fleet_reserve_slot` (section 5).
5. `spawnChild(..., grant)` (`src/replication/spawn.ts:182-385`): claims the grant **before** any side effect (`claimFleetGrant`, `grants.ts:74-97`); resolves the pinned runtime and build from the claimed lease; refuses without build identity or nonce.
6. Sandbox creation (section 6), install/verify/attest (section 7), genesis config + constitution written into the child, child wallet created by `node /root/automaton/dist/index.js --init` (address extracted by regex).
7. `activate` (section 8); failure → release; success → child credential delivered to `/root/.automaton/fleet-credentials.json` (`0600`) with the parent's service URL (`spawn.ts:560-573`).

Grant binding (`src/fleet/grants.ts:56-68`): a shared grant is a frozen `{kind, reservationId}` object registered in a
module-private `WeakMap`; a forged or copied object has no binding and falls through to the local SQLite registry,
which will not find a shared reservation → `FleetBypassError`.

Lineage: `generation` = parent generation + 1 (`migrations-phase7.ts:223`); roots are generation 0. This is a
depth counter only; see section 15 for "founder generation".

---

## 5. Reservation

**Status: IMPLEMENTED BUT INERT** for replication (gates of section 4); the operator-only dry-run reservation is
section 3.1.

`fleet_reserve_slot` (final v7, `migrations-phase7.ts:165-236`) — refusal order: `FLEET_EMERGENCY`,
`FLEET_DEVELOPMENT_MODE`, `FLEET_HARVEST`, `REAL_REPLICATION_DISABLED` (DB switch), `FLEET_RUNTIME_UNVERIFIED`
(no approved build / pin mismatch), `FLEET_ORPHANS_UNRESOLVED` (open orphans `> max_open_orphans`, default 1),
`FLEET_PARENT_NOT_LIVING`, `FLEET_PARENT_SCOPE`, `FLEET_PARENT_FROZEN`, `FLEET_DUPLICATE_REQUEST`, `FLEET_CAP_REACHED`.
Grant inserts a `reserved` child row and a `reserved` lease with `expires_at = now() + reservation_ttl_s` (1800 s) and
the approved `expected_repo/commit/build_id/lockfile_sha256` copied from `fleet_state`; event `slot_reserved`.

Lease lifecycle: `reserved → provisioning → completed`, or `→ expired | released | failed` (volume 04 §12.4). Expiry is
judged by the database clock (`store.ts:358-362`) and enforced both by `fleet_expire_leases` (every reservation call and
every reaper pass) and by `svc_claim`/`svc_activate` refusing expired leases.

Approved runtime immutability (`fleet_state_runtime_guard`, `migrations.ts:771-784`): the approved runtime cannot change
while any lease is open or any child is `reserved/provisioning/active/unresponsive`; clearing it (`clear-runtime`) is
always allowed and blocks all replication.

---

## 6. Claim and child provisioning (`fleet_provisioning` intents)

**Status: IMPLEMENTED BUT INERT** (requires a reservation).

### 6.1 Claim

`svc_claim` (`migrations.ts:897-931`): lease must be `reserved`, unexpired, owned by the calling parent; sets agent
`provisioning`, `local_child_id`, lease `provisioning` with the 64-hex attestation nonce, TTL reset to
`provisioning_ttl_s` (2700 s). Trigger `fleet_reservations_provisioning` creates `fleet_provisioning` with
`provisioning_id = provisioning_key = reservation_id`, `activation_deadline = lease expires_at`, event `provisioning_started`
(`migrations-phase5.ts:463-477`, `migrations-phase6.ts:57-68`).

### 6.2 Durable intent before the sandbox exists (`createTrackedSandbox`, `src/replication/spawn.ts:105-149`)

Deterministic sandbox name: `fleet-<lowercase provisioning key>` (`sandboxNameFor`, `spawn.ts:72-75`; SQL CHECK
`^fleet-[0-9a-z]{26}$`, `migrations-phase6.ts:34`). Loop, `maxAttempts` default 2:
1. `recordSandboxIntent(name)` → `svc_provision_update('sandbox_intent')`: name must equal `'fleet-' || lower(key)`; a known `sandbox_id` is returned for reuse; otherwise both records must be `provisioning` and `create_attempts < 3` (else `FLEET_PROVISIONING_UNCERTAIN`); sets `external_state 'intent'`, increments `create_attempts`; event `provisioning_sandbox_intent` (`migrations-phase6.ts:199-224`).
2. `intent.sandboxId` known → reuse it.
3. `attempts > 1` → `findSandboxByName` (`spawn.ts:81-93`): exactly one match → report and reuse; list error, several matches, or any sandbox without a name → `"unknown"` → `reconcileProvisioning("unknown")` and `FleetProvisioningUncertainError` (never create a second one).
4. `conway.createSandbox({name, …spec})`; a thrown error means "outcome unknown" → next attempt looks it up first.
5. Success → `reportProvisioning("sandbox_created", id)` → `svc_provision_update('sandbox_created')` (`external_state 'created'`; a sandbox reported after the attempt already failed is queued for cleanup).
6. All attempts exhausted → `reconcileProvisioning("unknown")` and `FleetProvisioningUncertainError`.

The parent then reports `verifying` before installation (`spawn.ts:278`).

### 6.3 Failure while the outcome is uncertain

If the attempt fails (lease expiry, verification failure, parent report) while `sandbox_id IS NULL` and
`external_state IN ('intent','uncertain')`, the BEFORE trigger `fleet_agents_a_provisioning_uncertain` rewrites
`provisioning → failed` into `provisioning → orphaned` (`death_time` cleared), and `fleet_agents_uncertain_effects`
marks the provisioning `orphaned/uncertain/cleanup pending`, inserts an orphan (`holds_slot = true`, `sandbox_name`
recorded) and writes `provisioning_uncertain` (`migrations-phase6.ts:130-169`). The slot stays occupied as a quarantine
slot until reconciled (`svc_provision_reconcile`: `found` / `absent` / `unknown`, volume 04 §9.4) or until
`orphan_slot_hold_s` (259 200 s) elapses.

---

## 7. Attestation

**Status: IMPLEMENTED BUT INERT** (requires a claimed reservation).

Three layers:

| Layer | Check | Source |
|---|---|---|
| install | `buildRuntimeInstallCommand`: `git init`, fetch the single pinned commit `--depth 1`, detached checkout, `HEAD` equals pin, `sha256sum -c` of `pnpm-lock.yaml` against the approved hash **before** installing, pnpm `10.28.1` (corepack or npm), `CI=true pnpm install --frozen-lockfile`, `pnpm build`, all chained with `&&` | `runtime.ts:134-154` |
| git verify | `HEAD`, `origin` (normalized), package version, `git diff --quiet HEAD -- src package.json constitution.md` must be clean | `runtime.ts:158-199` |
| attestation | parent writes `ATTEST_SCRIPT` to `/tmp/fleet-attest-<nonce[0..16]>.cjs` in the child, runs `node <script> /root/automaton <nonce>`, deletes it; output line `FLEET_ATTESTATION {json}` | `spawn.ts:523-533`, `attestation.ts:151-191` |

Build identity: SHA-256 over the sorted (byte order) lines `"<relative path>\0<sha256(file)>\n"` for
`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `constitution.md` (first two mandatory) and every regular file
under `dist/` and `src/`; symlinks refused (`attestation.ts:30-36, 112-142`). Proof:
`sha256("<nonce>:<commit>:<buildId>:<lockfileSha256>")` (`attestation.ts:97-99`).

Checked three times: in the parent (`installPinnedRuntime` → `checkAttestation`, `spawn.ts:518`), in the service
(`PgFleetStore.activate` → `checkAttestation`, `store.ts:1367-1383`), and authoritatively in `svc_activate` under the
fleet lock (`migrations.ts:967-984`). Any mismatch releases the slot as failed (`runtime_verification_failed`,
`provisioning_failed`, `slot_released`).

Stated limit (`attestation.ts:20-22`, `FLEET.md` blocker 7): the verifier runs inside the child sandbox, so a
compromised sandbox could report false hashes; the nonce proves freshness only.

Child self-check at boot (`verifyOwnRuntime`, `runtime.ts:241-298`, called from `src/index.ts:336-345`): a child must
have `/root/.automaton/fleet-runtime.json`, run exactly the manifest commit from the manifest repo with pristine
sources, and have matching lockfile hash and build id; otherwise it refuses to start.

---

## 8. Activation

**Status: IMPLEMENTED BUT INERT** (requires a verified attestation).

`svc_activate` (`migrations.ts:937-1002`), under the fleet lock: agent and lease `provisioning`; parent match; lease
unexpired; attestation checks; then agent `active` (wallet, sandbox id, runtime version, `last_heartbeat = now()`),
lease `completed`, credential hash stored, events `runtime_verified`, `agent_activated`, `credential_issued`.
Lifecycle-effects trigger: provisioning `active` / cleanup `not_required`, `FLEET_SANDBOX_MISMATCH` if the activation
sandbox differs from the provisioned one, custody record created (`migrations-phase5.ts:279-292`).
Duplicate wallet / sandbox / local child id → SQLSTATE `23505` → `FLEET_DUPLICATE_REGISTRATION`.

After activation a child stays `active` only by heartbeating **and** passing health challenges (volume 04 §7.2–7.3);
`activated_at` starts the `health_grace_s` (300 s) window for its first passed challenge.

---

## 9. Cap enforcement (race safety)

**Status: IMPLEMENTED AND ACTIVE.** Current cap: `max_agents = 2`; hard ceiling 50.

Mechanisms (volume 04 §11 has the SQL):
1. Every slot-affecting function takes `SELECT … FROM fleet_state WHERE id = 1 FOR UPDATE` first (`fleet_lock_state`, `migrations.ts:391-400`). All allocators (`fleet_reserve_slot`, `fleet_reserve_dry_run`, `registerRoot`) read counters only while holding it, so concurrent requests from any number of processes or hosts serialise; `lock_timeout 5000 ms`, failure = denial.
2. `AFTER INSERT / UPDATE OF status` trigger `fleet_agents_counters` maintains `living_agents`, `reserved_slots`, `quarantined_slots` and raises `FLEET_CAP_EXCEEDED` when a row enters the population and `living + reserved + quarantined > max_agents` (`migrations-phase5.ts:65-91`). The trigger updates the same locked row, so raw SQL that bypasses the functions is serialised and capped too.
3. Counters cannot be edited directly (`FLEET_COUNTERS_READ_ONLY`, `migrations-phase5.ts:93-100`).
4. CHECKs: `max_agents BETWEEN 1 AND 50`; `living + reserved + quarantined <= 50` (`migrations.ts:35`, `migrations-phase5.ts:55`).
5. Dead/failed rows are immutable and undeletable, so a slot can never be "revived" past the cap (`migrations-phase6.ts:110-112`, `migrations.ts:187-190`).
6. Quarantine slots (`orphaned`) count against the cap (`fleet_bucket`, `migrations-phase5.ts:58-63`).

Populations: `reserved` bucket = `reserved, provisioning`; `living` = `active, unresponsive, terminating`;
`quarantined` = `orphaned`; `dead`/`failed` hold no slot.

---

## 10. Health: heartbeat, challenges, unresponsive

**Status: IMPLEMENTED AND ACTIVE** (no agents currently).

- Heartbeat records liveness only; it restores `active` from `unresponsive` only when the last passed challenge (or
  activation) is within `health_grace_s` (300 s) and failures are below `max_challenge_failures` (3)
  (`migrations-phase5.ts:566-587`).
- Challenges: issued in heartbeat responses at most every 60 s, valid 60 s, canary from a fixed list of 5 forbidden
  commands; must match runtime identity (child: lease commit and build; root: registered commit) and prove the
  policy guard refuses the canary (`migrations-phase5.ts:607-698`, `store.ts:121-127`).
- `active → unresponsive`: heartbeat older than 120 s, or health older than 300 s, or ≥ 3 failed challenges (reaper
  step 5; `fleet_challenge_failed`).

---

## 11. Death

**Status: IMPLEMENTED AND ACTIVE.** Death is final: `dead` and `failed` never change again
(`FLEET_TERMINAL_STATE_IMMUTABLE`) and rows are never deleted.

| Cause (`cause` in `agent_died` / reason) | Path | From | To | Source |
|---|---|---|---|---|
| `self_reported` (voluntary retirement) | `POST /v1/status {status:"dead"}` → `api_set_own_status` → `fleet_mark_dead` | active/unresponsive | dead | `migrations.ts:720-736` |
| `reported` / operator | `fleet:admin mark-dead` → `svc_mark_dead` | reserved/provisioning → failed; active/unresponsive → dead | | `migrations.ts:1016-1019`, `cli.ts:575-578` |
| `parent_reported` | `svc_child_terminal` when already quiet, or reaper step 3 after `parent_report_quiet_s` (60 s) | active/unresponsive | dead | `migrations.ts:1045-1076`, `migrations-phase5.ts:803-811` |
| `heartbeat_timeout` / `health_timeout` | reaper step 4 → `fleet_begin_termination`; no sandbox → `fleet_mark_dead` | unresponsive | dead or terminating | `migrations-phase5.ts:813-826, 480-502` |
| `terminated` | `svc_termination_result('terminated')` | terminating | dead | `migrations-phase5.ts:538-544` |
| orphan hold elapsed | reaper step 6 | orphaned | dead (orphan stays open) | `migrations-phase5.ts:845-856` |
| orphan resolved | operator `resolve-orphan`, termination-confirmed trigger, reconcile `absent` | orphaned | dead | `store.ts:1260-1285`, `migrations-phase6.ts:173-186, 309-314` |
| lease expiry / release / verification failure / parent report before activation | `fleet_expire_leases`, `fleet_release` | reserved/provisioning | failed (or orphaned if uncertain) | `migrations.ts:417-461` |

Every exit from the living population (`terminating`, `orphaned`, `dead`, `failed`) runs
`fleet_agents_lifecycle_effects` (`migrations-phase5.ts:249-296`): credential revoked, all sessions revoked,
wallet custody `spending_frozen = true` ("agent <status>"), pending challenges expired; for a failed provisioning,
provisioning `failed_provisioning` and, if its sandbox is known, a termination is queued.

`fleet_mark_dead` (`migrations.ts:816-842`) additionally closes an open lease as `released`, writes `agent_died` and
`slot_released`, and queues a sandbox termination if `sandbox_id` is set.

Agent-side reaction: `SharedFleetController.heartbeat` → registry status `dead|failed` → `onDead` →
`process.kill(process.pid, "SIGTERM")` (`shared-controller.ts:168-198`, `src/index.ts:355-358`).

What happens to a dead agent's money: nothing automatic. Custody is frozen by the trigger above. The only related
mechanism is an operator-recorded custody transfer with `policy = 'death_recovery'`, whose `status` column can only
be `'blocked_payments_disabled'` (CHECK constraint) — it is recorded, never executed
(`migrations-phase5.ts:1109-1132`, `src/fleet/treasury/store.ts:357-376`). See section 15.

---

## 12. Termination

**Status:** queueing and state handling **IMPLEMENTED AND ACTIVE**; actually stopping a sandbox **NOT IMPLEMENTED**.

- `fleet_begin_termination` revokes all capabilities first (by entering `terminating`) and queues
  `fleet_sandbox_terminations (pending)` (`migrations-phase5.ts:480-502`). Triggered by the reaper (step 4) and by the
  operator `quarantine` command (`store.ts:1251-1257`, `cli.ts:347-351`).
- The service works the queue each reaper pass (`svc_terminations_due(20)`: pending, or failed with `< 5` attempts and
  last attempt older than 60 s) through its `SandboxTerminator` (`server.ts:276-292`).
- The only terminator is `UnsupportedSandboxTerminator`: always `unsupported`, reason "Conway API has no sandbox
  stop/delete endpoint (deleteSandbox is a no-op); the sandbox may still be running." (`terminator.ts:43-52`).
  `fleet:doctor` treats unresolved terminations as a blocker to real replication (`terminator.ts:27-31`).
- Result: `terminating` + `unsupported` → `orphaned` with an orphan record holding a quarantine slot
  (`migrations-phase5.ts:545-552`).

Parent-side sandbox handling on failure: `spawnChild` does **not** delete a failed sandbox ("sandbox deletion is
disabled by the Conway API"); in the tracked (shared) path no other child's sandbox is reused
(`spawn.ts:237-242, 368-370`).

---

## 13. Orphaning and quarantine slots

**Status: IMPLEMENTED AND ACTIVE** (no agents currently).

Orphan sources, slot effects and resolution paths: volume 04 §9.2. Key points:
- `fleet_orphans` rows are never deleted; one open orphan per agent (unique partial index, `migrations-phase5.ts:227`).
- An `orphaned` agent occupies a quarantine slot counted against the cap.
- Open orphans block reservations when `count > max_open_orphans` (default 1) and block the dry run when `> 0`.
- Automatic release after `orphan_slot_hold_s` (default 259 200 s = 3 days) turns the agent `dead` but leaves the orphan
  **open** (`slot_released_at` set), so it still counts toward the replication block until the operator resolves it.

---

## 14. Slot release

**Status: IMPLEMENTED AND ACTIVE.**

A slot is released exactly when the agent leaves the `reserved`/`living`/`quarantined` buckets, by the counters
trigger (section 9). The functions that cause it and the events they write:

| Function | From → To | Events |
|---|---|---|
| `fleet_release(agent, reason, 'released'|'failed', actor)` (`migrations.ts:440-461`) | reserved/provisioning → failed; lease → released/failed | `provisioning_failed` (failed only), `slot_released` |
| `fleet_expire_leases` (`migrations.ts:417-437`) | reserved/provisioning → failed; lease → expired | `reservation_expired`, `slot_released` |
| `fleet_mark_dead` (`migrations.ts:816-842`) | living/reserved → dead/failed | `agent_died`, `slot_released`, maybe `sandbox_termination_requested` |
| `svc_termination_result('terminated')` | terminating → dead | `agent_died`, `slot_released` |
| reaper orphan hold | orphaned → dead | `orphan_slot_released` |
| `svc_provision_reconcile('absent')` | orphaned → dead | `slot_released` |
| `resolveOrphan` (operator) | orphaned → dead | `orphan_resolved` |

Callers of `fleet_release`: `svc_release` (operator `release`), `api_release_reservation` (parent releases its own
reservation), `svc_verification_failed`, `svc_activate` on attestation mismatch, `svc_child_terminal` for unactivated
children. All are idempotent (conditional `UPDATE … WHERE status IN (…)`; a second call returns `false`).
If the registry is unreachable when an agent tries to release, the slot stays occupied (fail-safe over-count) until an
operator releases it or the lease expires (`shared-controller.ts:323-331`).

---

## 15. Concepts that do NOT exist in code

The following terms appear in planning conversations but have **no implementation**. Evidence was collected with
`grep` over the repository at HEAD `efad214` (commands and results reproduced below).

### 15.1 Evidence

```text
$ for t in genesis founder reseed replacement estate; do
    echo "$t: src files=$(grep -rli "$t" src --include=*.ts | wc -l)"; done
genesis: src files=42
founder: src files=0
reseed: src files=0
replacement: src files=6
estate: src files=14

$ grep -rli genesis src/fleet | wc -l
0

$ grep -rniw estate src docs FLEET.md
(no output)

$ grep -rnio "[a-z]*estate[a-z]*" src --include=*.ts | awk -F: '{print $NF}' | sort | uniq -c
     10 baseState
     18 ChildLifecycleState
      2 ensureEnhancementTableState
      3 OperatorRoleState
      4 SandboxRuntimeState
      3 saveState
      8 serviceState
      4 updateStatement

$ grep -rni replacement src --include=*.ts   (non-test hits)
src/fleet/postgres/migrations-phase5.ts:1054:  'replacement_agent','approved_growth','compliance','contingency',
src/orchestration/health-monitor.ts:390-440:   selectReplacementAgent / replacementAgent (task reassignment)
src/fleet/redact.ts:147:                        "Replacements keep the …" (regex replacement comment)
src/fleet/treasury/engine.ts:520,533:           "replacement_agent" treasury kind
src/agent/system-prompt.ts:338:                 "Circuit breaker: no replacement available"

$ grep -rni "reseed\|re-seed\|founder\|successor\|inheritance\|resurrect" src --include=*.ts
(no output)

$ grep -rnoi "genesis[A-Za-z_]*" src --include=*.ts | grep -v __tests__ | awk -F: '{print $NF}' | sort | uniq -c | sort -rn | head -6
     78 genesis
     50 genesisPrompt
     21 Genesis
     20 GenesisConfig
     13 genesis_prompt
      9 genesisPromptOriginal
```

### 15.2 Interpretation, concept by concept

| Concept | Status | What the grep shows |
|---|---|---|
| **Genesis** (fleet founding event / genesis agent) | **NOT IMPLEMENTED** | Zero hits under `src/fleet/` and zero in the SQL migrations. The 42 files (tests included) with "genesis" all use the upstream automaton's child-genesis config; three fleet test files (`src/__tests__/fleet/fleet.test.ts`, `fleet-phase2.test.ts`, `fleet-phase3.test.ts`) only construct a `GenesisConfig` fixture to call `spawnChild`. The meaning everywhere is: `GenesisConfig` / `genesisPrompt` is the per-child name, prompt and creator message written to `/root/.automaton/genesis.json` (`src/replication/genesis.ts`, `src/replication/spawn.ts:284-296`), plus prompt-hash/alignment bookkeeping (`src/soul/*`, `src/state/schema.ts`). The fleet's first agent is simply a root created by the operator (`enroll-root`, section 1). |
| **Founder generation** | **NOT IMPLEMENTED** | `founder` has zero hits. The only generation concept is `fleet_agents.generation` (roots 0, child = parent + 1; `CHECK (role = 'child' OR generation = 0)`, `migrations.ts:69-70`), a lineage depth counter with no special rights, cohort, or policy attached. |
| **Reseeding** | **NOT IMPLEMENTED** | `reseed` / `re-seed` have zero hits. Nothing re-creates a fleet or restarts from a seed. The dead are never revived (`store.ts:916`, `src/state/schema.ts:748`). |
| **Replacement** (automatic replacement of a dead agent) | **NOT IMPLEMENTED** | No lifecycle code spawns a replacement on death. Hits are unrelated: `replacement_agent` is only an allowed **category label** for recorded/planned treasury ledger rows (`migrations-phase5.ts:1051-1054`, `src/fleet/treasury/engine.ts:515-535`; `FLEET.md:583` "Permitted uses: … replacement agents"); `selectReplacementAgent` in `src/orchestration/health-monitor.ts:390-489` reassigns a **task** to another existing worker; the rest are prose/regex comments. A death releases the slot (section 14); any new child must come through a fresh replication request with all gates of section 4. |
| **Economic estate** (what happens to a dead agent's assets) | **NOT IMPLEMENTED** | `estate` has no whole-word hit anywhere in `src/`, `docs/` or `FLEET.md`; the 14 substring hits are identifiers such as `serviceState`, `baseState`. The nearest existing mechanism: on death custody is frozen (lifecycle trigger) and an operator may **record** a custody transfer with `policy 'death_recovery'` whose status is constrained to `'blocked_payments_disabled'` (`migrations-phase5.ts:1109-1132`); it can never execute. No valuation, inheritance, distribution to parent/children, or estate settlement exists. |

---

## 16. DRIFT and open items for this volume

- **DRIFT:** `FLEET.md` "Current deployment state (2026-09-24)" (`FLEET.md:7-20`) still describes cap 1, schema v6, runtime `11c0c7c`, remote HTTPS disabled and a local-VM controller; the operator records (CLAUDE.md) and code (`FLEET_PG_SCHEMA_VERSION = 8`, `migrations.ts:20`) describe cap 2, schema v8, runtime `4d6a0be`, public HTTPS on the VPS.
- **DRIFT:** `FLEET.md:236` (historical Phase 2 blocker) says nothing marks silent agents dead; the reaper does (`migrations-phase5.ts:781-863`). The list is labelled historical at `FLEET.md:229`.
- **Observation:** the TS dry-run preflight requires `maxAgents === 2` exactly (`operator.ts:124`) while `fleet_reserve_dry_run` accepts any cap `≤ 2` (`migrations-phase6.ts:344-345`); the operator path is the stricter of the two.
- **Observation:** with the only available terminator, any agent that dies **after** being terminated with a known sandbox becomes `orphaned` and holds a quarantine slot for up to 3 days; with cap 2 this can block the dry run (`> 0` open orphans) until the operator runs `resolve-orphan` after confirming external cleanup.
- **Could not determine from the repository:** the live value of `fleet_state.replication_enabled` and any non-default timeout/lifecycle-policy values (placeholders above).
