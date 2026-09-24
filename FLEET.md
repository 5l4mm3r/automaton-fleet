# Automaton Fleet

This file records the fleet layer phase by phase (Phases 1–6 below). The phase
sections describe what each phase built, and their "blockers" lists reflect the time
they were written. **Current state is only in the next section.**

## Current deployment state (2026-09-24)

| Item | State |
|---|---|
| Pinned runtime | `https://github.com/5l4mm3r/automaton-fleet.git` @ `11c0c7c02592d43a2c1350b779eaa795a237f3b7`, build ID `e388571a140f7cb20e289e1e64d152571adea5f207c2290c09888f80f6e3c624`, lockfile `eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811`. Published on the fork, approved in the registry, installed at `/opt/automaton-fleet/releases/11c0c7c…` |
| Database | Schema v6, local PostgreSQL (loopback only); restricted roles in place |
| Controller | `automaton-fleet.service` on the local Ubuntu VM, loopback only (`127.0.0.1:8787`); `/readyz` 200 |
| Remote HTTPS | Disabled (`FLEET_REMOTE_LISTEN_ENABLED=false`). No certificate or key exists; `/etc/automaton-fleet/tls` is root:automaton-fleet-admin 0750. The remote drop-in and firewall are not installed |
| Fleet cap / mode | Cap **1** (registry `maxAgents=1`). It stays 1 until public HTTPS is proven healthy. Mode DEVELOPMENT |
| Agents | None living, none reserved |
| Safety flags | `REAL_REPLICATION_ENABLED`, `REAL_PAYMENTS_ENABLED`, `OWNER_SWEEP_ENABLED`, `FLEET_DRY_RUN_CHILD`: all `false` |
| `fleet:doctor` | DEPLOYMENT: OK (runtime repo, commit, build ID, controller service, approved runtime: PASS) |
| `scripts/fleet-verify-deployment.sh` | Passes, including the TLS systemd-credential checks (FLEET-KI-3, fixed in `11c0c7c`) |
| Production host | OVH VPS (Ubuntu 24.04 LTS) being provisioned; controller hostname `api.agentfleet.vip` |
| In development (not deployed) | FLEET-KI-4 root witness + capability scope, schema **v7** (working tree, pending review). Deploying it needs a new approved runtime pin and the live v6 → v7 migration |

**Remaining SAFE FOR DRY RUN blockers** (`pnpm fleet:verify`), exactly:
1. HTTPS valid
2. remote controller reachable
3. fleet cap = 2

**Further prerequisite for the dry run:** a living root agent (FLEET-KI-4). The root witness that provides it is implemented but not yet deployed (see the FLEET-KI-4 section at the end).

**Still blocking SAFE FOR REAL REPLICATION / REAL PAYMENTS** (structural, unchanged):
- no completed dry-run child;
- Conway has no sandbox stop/delete API (zombie containment);
- sandbox-side attestation trusts the sandbox, and child Node is not pinned;
- no controller custody signer or controller-held wallet keys (payments).

**Documents:**
- Production cutover procedure: [`docs/fleet-production-runbook.md`](docs/fleet-production-runbook.md).
- Open issues: [`docs/fleet-known-issues.md`](docs/fleet-known-issues.md). FLEET-KI-1 and
  KI-2 are pre-existing PostgreSQL concurrency failures in the Phase 2 tests; KI-4 is the
  dry-run root.

---

# Phase 1 — Fleet layer

A bounded fleet layer above Automaton's existing replication system. Phase 1 adds
FleetRegistry, FleetPolicy, FleetController, fleet operating states and a global
living-agent cap. It adds **no** financial automation, owner sweeps, or wallet changes.

## A. Repository architecture map (relevant parts)

| Area | Files | Role |
|---|---|---|
| Runtime entry | `src/index.ts` | Loads config/wallet, opens DB, builds PolicyEngine, starts heartbeat + agent loop |
| Agent loop | `src/agent/loop.ts` | ReAct loop; builds Orchestrator whose `spawnAgent` creates Conway children or local workers |
| Tools | `src/agent/tools.ts` | All LLM tools, incl. `spawn_child`, `fund_child`, `start_child`, `transfer_credits`, `create_sandbox`; `executeTool()` runs PolicyEngine first |
| Policy | `src/agent/policy-engine.ts`, `src/agent/policy-rules/*` | Priority-ordered rules; first deny wins; decisions logged to `policy_decisions` |
| Replication | `src/replication/spawn.ts` | `spawnChild()` — sandbox create, runtime install, genesis, constitution propagation, wallet init |
| | `lifecycle.ts` | `ChildLifecycle` state machine → `child_lifecycle_events` + `children.status` |
| | `genesis.ts`, `constitution.ts`, `health.ts`, `cleanup.ts`, `lineage.ts`, `messaging.ts` | Genesis validation, SHA-256 constitution verify, health checks, cleanup, pruning, relay messaging |
| Survival | `src/survival/*`, `src/conway/credits.ts` | Tiers `high > normal > low_compute > critical > dead` from credit balance; funding strategies |
| Identity / wallet | `src/identity/wallet.ts` | Private key in `~/.automaton/wallet.json` (mode 0600); never exposed to tools |
| State | `src/state/schema.ts`, `src/state/database.ts` | SQLite (better-sqlite3, WAL), versioned migrations |
| CLI | `packages/cli` | Creator CLI: `status`, `logs`, `fund`, `send` |

## B. Existing replication flow (before fleet)

1. LLM calls `spawn_child` (or Orchestrator calls `spawnAgent` for a task).
2. PolicyEngine: `authority.external_tool_restriction` (blocks heartbeat/external input), `rate.spawn_daily` (3/day).
3. `validateGenesisParams` → `generateGenesisConfig`.
4. `spawnChild()`: per-parent `maxChildren` (default 3, **local to that parent only**) → `ChildLifecycle.initChild` (`requested`) → Conway `createSandbox` (or reuse a failed one) → `sandbox_created` → install runtime from **upstream GitHub** → write genesis + propagate constitution → `runtime_ready` → `--init` child wallet, validate address → `wallet_verified`.
5. `fund_child` → `transferCredits` (≤ half balance; treasury rules) → `funded`. `start_child` → `starting` → `healthy`/`failed`.
6. Health monitor moves `healthy ↔ unhealthy → stopped/failed → cleaned_up`. `pruneDeadChildren` **deletes** old dead rows.

Gaps relative to the fleet goal: the cap was per parent (a lineage of depth *d* could reach 3^d agents), dead children were deleted, and nothing tied replication to a global state machine.

Existing protections kept intact: treasury policy (`financial.*` rules), self-preservation guards in tools, constitution hash verification, wallet file protection, injection defenses, path protection.

## C. Fleet architecture

```
Automaton runtime
  └─ spawn_child tool / Orchestrator.spawnAgent
       └─ FleetController.requestReplication()        src/fleet/controller.ts
            ├─ FleetPolicy (pure rules, state machine) src/fleet/policy.ts
            ├─ financial eligibility (EXPANSION only, fails closed)
            ├─ FleetRegistry.reserveSlot()  BEGIN IMMEDIATE  src/fleet/registry.ts
            │     └─ fleet_agents_cap_insert trigger (DB backstop)
            └─ spawnChild(…, grant)  — claims single-use grant before any side effect
PolicyEngine rule fleet.policy_gate (priority 450) — same FleetPolicy, pre-execution
FleetAccounting / FleetTreasury — Phase 2+ (not implemented)
```

### Fleet operating states

| State | How entered | Replication | Other effects |
|---|---|---|---|
| DEVELOPMENT | `FLEET_MODE` default | Denied | `fund_child`, `start_child` denied |
| EXPANSION | `FLEET_MODE=EXPANSION` and below cap | Allowed only if `REAL_REPLICATION_ENABLED=true`, root agent, financial eligibility passes, slot reserved | `fund_child` needs `REAL_PAYMENTS_ENABLED=true` |
| HARVEST | Automatic when living ≥ cap, or `FLEET_MODE=HARVEST` | Denied | — |
| EMERGENCY | `FleetController.enterEmergency()` (persisted) or `FLEET_MODE=EMERGENCY` | Denied | Blocks `spawn_child, fund_child, start_child, transfer_credits, x402_fetch, create_sandbox, register_domain` |

Precedence: EMERGENCY > DEVELOPMENT > HARVEST > EXPANSION.

### Configuration (environment, fail-closed)

| Variable | Default | Notes |
|---|---|---|
| `FLEET_MAX_AGENTS` | `1` | Integer 1..50; anything else → 1. Includes the root agent. |
| `FLEET_MODE` | `DEVELOPMENT` | Unknown → DEVELOPMENT |
| `REAL_REPLICATION_ENABLED` | `false` | Only the literal `true` enables |
| `REAL_PAYMENTS_ENABLED` | `false` | Gates child funding |
| `OWNER_SWEEP_ENABLED` | `false` | Parsed; logs a warning if set; no sweep exists |
| `MIN_AGENT_RESERVE_USD` | `10` | Parent credits required before replication |

`.env.fleet` is **not** auto-loaded; export variables into the process environment.

## D. Changed files

- `src/replication/spawn.ts` — `spawnChild()` takes a 6th arg `fleetGrant` and claims it before any sandbox/DB side effect.
- `src/agent/tools.ts` — `spawn_child` routes through FleetController; shell guard blocks fleet-table writes and `DROP TRIGGER`.
- `src/agent/loop.ts` — Orchestrator Conway spawns route through FleetController (denial falls back to local worker, as before).
- `src/agent/policy-rules/index.ts` — registers `fleet.policy_gate`; `createDefaultRules(treasury, fleetConfig)`.
- `src/agent/policy-rules/command-safety.ts` — forbidden patterns for fleet tables/triggers/code.
- `src/self-mod/code.ts` — fleet files, `replication/spawn.*`, `state/schema.*` added to PROTECTED_FILES.
- `src/state/schema.ts`, `src/state/database.ts` — schema v12 migration.
- `src/index.ts` — initialise fleet (register root, persist cap, log state) at startup.
- `package.json` — `test:security` / `test:financial` used `--grep`, which vitest 2 rejects; now `-t`.
- `src/__tests__/replication.test.ts` — existing `spawnChild` tests now obtain a fleet grant (required by design).

## E. New files

`src/fleet/{types,config,policy,registry,controller,index}.ts`, `src/agent/policy-rules/fleet.ts`,
`src/__tests__/fleet/fleet.test.ts`, `src/__tests__/fleet/fixtures/reserve-worker.ts`, `FLEET.md`.

## F. Database changes (schema v12)

- `fleet_meta(key, value, updated_at)` — `max_agents`, `emergency`.
- `fleet_agents` — one row per agent ever (root + children): role, parent, generation, address, child_id, sandbox_id, status ∈ {reserved, spawning, active, dead, failed}, reason, timestamps.
- `fleet_events` — append-only audit log (reservations, denials, activations, deaths, cap/emergency changes).
- Triggers:
  - `fleet_agents_cap_insert` — aborts any living insert when living ≥ min(max_agents, 50); missing cap ⇒ 0 (fail closed).
  - `fleet_agents_terminal_immutable` — dead/failed rows cannot change status (no revival around the cap).
  - `fleet_agents_no_delete`, `fleet_events_no_delete`, `fleet_events_no_update` — history is permanent.
  - `fleet_sync_child_terminal` — when `children.status` becomes dead/stopped/failed/cleaned_up, the linked fleet agent becomes dead (or failed if never active), freeing its slot. `pruneDeadChildren` may still delete `children` rows; fleet history is unaffected.

## G. Concurrency strategy

1. `reserveSlot()` counts living agents and inserts the reservation inside one `BEGIN IMMEDIATE` transaction. IMMEDIATE takes SQLite's write lock *before* the count, so concurrent connections/processes serialise (with `busy_timeout = 5000`); no two can observe the same free slot.
2. The reservation (status `reserved`) counts as living from the moment it is created, across the whole async spawn.
3. The insert trigger re-checks the cap inside the INSERT statement itself.
4. The grant is consumed with a conditional `UPDATE … WHERE status='reserved'` (exactly-once).
5. Spawn failure → slot released (`failed`). A process crash mid-spawn leaves the slot occupied (fail-safe over-count; needs operator release).

Verified by tests: 20 concurrent in-process requests, 20 separate connections, and 20 separate OS processes at cap 2 all end with exactly 2 living agents. Removing the lock logic and trigger makes these tests fail.

## H. Test plan (`src/__tests__/fleet/fleet.test.ts`, 42 tests)

Config defaults and fail-closed parsing · state precedence · DEVELOPMENT blocks real replication · REAL_REPLICATION_ENABLED=false blocks · HARVEST (configured and automatic at cap) · EMERGENCY (flag and configured; registry-level too; expenditure tools blocked, top-up allowed) · cap 1 rejects · cap 2 allows one child · cap 2 rejects second · 20 concurrent (in-process / multi-connection / multi-process) · failed spawn releases slot · unclaimed grant cannot leak a slot · dead agents recorded, immutable, undeletable · dead agent frees slot · child lifecycle failure marks agent dead · financial eligibility (tier, reserve, snapshot failure) · fund_child gating · bypass: `spawnChild` without grant, forged grant, reused grant, raw SQL insert over cap, trigger without cap, `spawn_child` tool under defaults never touches Conway, tool path at cap, non-root denied, shell tampering patterns, protected files · PolicyEngine rule: registration, spawn/fund/transfer-to-child/EMERGENCY denials, fail-closed without DB, `executeTool` denial · schema migration.

## I. Security risks and residual gaps

1. **Children run upstream code.** `spawnChild` clones `github.com/Conway-Research/automaton`, which has no fleet layer. A real child could spawn up to 3 children of its own, outside the global cap. **This blocks enabling REAL_REPLICATION_ENABLED** until children run a pinned build of this fork.
2. **Registry is local SQLite.** "Global" means global to agents sharing this DB file. Children in other sandboxes cannot see it; Phase 1 fails closed (`NOT_FLEET_ROOT`: only an agent without `parentAddress` may replicate). A true lineage-wide cap needs a shared registry service (Phase 2; e.g. Postgres with `SELECT … FOR UPDATE` or an advisory lock).
3. **Shell access.** An agent with `exec` could, in principle, use the Conway API key via `curl` to create and bootstrap a sandbox manually, or write to `state.db` with an unlisted tool. Pattern blocking is defense in depth, not a boundary. `create_sandbox` stays available outside EMERGENCY.
4. **Stale reservations** after a crash hold a slot until released by an operator (safe direction).
5. **Cap written per process.** Every controller writes `FLEET_MAX_AGENTS` to `fleet_meta`; processes with different env values on one DB overwrite each other (hard ceiling 50 still applies in the trigger).
6. **Local workers** (in-process `LocalWorkerPool` tasks) are not automatons and are not counted.
7. `transfer_credits` to non-fleet addresses remains governed only by the existing treasury rules; REAL_PAYMENTS_ENABLED gates child funding, not all payments.

---

# Phase 2 — Shared fleet registry and pinned child runtime

Real replication, real payments and owner sweeps remain **disabled** (`.env.fleet`: all `false`). No financial automation was added.

## Shared registry (PostgreSQL)

`DATABASE_URL` (from the environment; the operator CLI also reads `.env.fleet`) points every agent process at one registry. Objects live in schema `fleet` (`FLEET_PG_SCHEMA` overrides, used by tests). The local SQLite registry from Phase 1 is no longer used by any production replication path.

### Schema (migration v1, `src/fleet/postgres/migrations.ts`)

| Table | Contents |
|---|---|
| `fleet_state` (single row, `id = 1`) | `living_agents`, `reserved_slots` (trigger-maintained, read-only), `max_agents` (1..50), `operating_mode`, `runtime_repo` / `runtime_commit` (operator-approved pin), `updated_at` |
| `fleet_agents` | `agent_id` (ULID, stable across sandboxes), `parent_agent_id`, `role`, `generation`, `name`, `wallet_address` (public address only, CHECK-constrained, unique forever), `runtime_version`, `runtime_repo`, `runtime_commit`, `sandbox_id`, `local_child_id`, `status` ∈ reserved → provisioning → active → dead, or reserved/provisioning → failed, `request_key` (unique), `created_at`, `updated_at`, `last_heartbeat`, `reservation_expires_at`, `death_time` |
| `fleet_events` | append-only audit log; `detail` is scrubbed of key/secret-like fields |
| `fleet_schema_migrations` | applied versions |

Triggers: counter maintenance and cap check (`FLEET_CAP_EXCEEDED`); forward-only transitions, terminal rows immutable (`FLEET_TERMINAL_STATE_IMMUTABLE`); identity, wallet and child runtime immutable; no DELETE/TRUNCATE on agents/events/state; counters read-only (`FLEET_COUNTERS_READ_ONLY`). Living = `active`; reserved = `reserved` + `provisioning`; the cap applies to their sum. Dead/failed rows are kept forever and don't count.

### Migrations

Operator-only: `pnpm fleet:migrate`. Each version runs in its own transaction under `pg_advisory_xact_lock`, so concurrent runs are safe. Agents never run DDL. They check the schema version on connect, and a mismatch makes the registry "unavailable", which fails closed.

### Locking strategy

1. Every slot-affecting transaction (`reserveSlot`, `registerRoot`, operator changes) starts with `SELECT … FROM fleet_state WHERE id = 1 FOR UPDATE`. That one row is a fleet-wide mutex across processes and hosts. Counts are read after acquiring it, under READ COMMITTED, so they are the latest committed values.
2. The `fleet_agents` counter trigger updates the same row, and raises if a row entering the living/reserved population would exceed `max_agents`. This backstop also catches raw SQL. Verified independently: with the row lock removed, the trigger alone still holds the cap. With both removed, the concurrency tests fail.
3. Transitions are conditional UPDATEs, so claim, activate, release and death each happen exactly once. Double release returns `false` and changes nothing.
4. `lock_timeout` 5s, `statement_timeout` 10s, pool acquire/connect 10s. Any timeout means denial.
5. A reservation that is never claimed expires after 30 min and is reclaimed inside the next reservation transaction. A slot in `provisioning` is never auto-reclaimed (fail-safe): an operator releases it.

### Cap semantics

Effective cap = `min(fleet_state.max_agents, FLEET_MAX_AGENTS)`. Effective mode = the stricter of the shared `operating_mode` and `FLEET_MODE`. The local env can only tighten.

### PostgreSQL unavailable

`SharedFleetController` denies with `FLEET_REGISTRY_UNAVAILABLE`, and no reservation is attempted. The PolicyEngine rule is synchronous, so it reads a snapshot that the 30s fleet heartbeat refreshes. If the snapshot is missing, older than 90s or unhealthy, `spawn_child`, `start_child` and `fund_child` are denied and every other tool is unaffected. If the registry drops mid-provision, the slot stays occupied (over-count, the safe direction).

### Where enforcement lives

- Global cap: `PgFleetStore.reserveSlot()` in `src/fleet/postgres/store.ts` (row lock + check), backed by the `fleet_agents_counters()` trigger in `src/fleet/postgres/migrations.ts`.
- Production entry: `requestSharedReplication()` in `src/fleet/shared.ts`, called by `spawn_child` (`src/agent/tools.ts`) and the orchestrator (`src/agent/loop.ts`).
- Grants: `src/fleet/grants.ts`. Shared grants are bound in a module-private WeakMap, so forged objects can't be claimed.

## Pinned child runtime

`FLEET_RUNTIME_REPO` (https, no credentials, never `Conway-Research/automaton` in any spelling) and `FLEET_RUNTIME_COMMIT` (full 40-hex SHA). The operator approves the pin in the registry with `pnpm fleet:admin approve-runtime`. A reservation requires the local pin to equal the approved pin, and copies the approved pin onto the row. `spawnChild` takes the pin from the claimed grant only; no tool argument reaches it.

Child provisioning (`src/replication/spawn.ts`, both paths): `git init` → `fetch --depth 1 origin <sha>` → `checkout --detach <sha>` → HEAD check → build → **verify** (HEAD, origin, tracked sources pristine) before genesis, constitution or wallet → write `/root/.automaton/fleet-runtime.json` (agent id, parent, generation, repo, commit; no secrets). Activation in the registry requires the verified commit. `start_child` re-verifies against the approved pin. A starting child (`src/index.ts`) refuses to run unless its own HEAD, origin and sources match its manifest.

## Operator CLI

`pnpm fleet:admin health | status | set-cap N | set-mode MODE [reason] | approve-runtime | clear-runtime | release ID | mark-dead ID`. The shell guard blocks agents from running it, and from SQL writes to fleet tables, trigger disabling, `DROP SCHEMA`, and setting `DATABASE_URL` / `FLEET_RUNTIME_*`.

## Remaining blockers before real replication

*Historical (end of Phase 2). Items 1–6 were resolved in Phases 3–6. Item 7 (sandbox trust) remains open; see "Current deployment state".*

1. **DB privilege separation.** The DSN owner can disable triggers and rewrite `fleet_state`. Agents need a role limited to SECURITY DEFINER functions (or row-level GRANTs). `fleetadmin` cannot create roles.
2. **Child DB access.** Children aren't given credentials (the admin DSN must never be forwarded), so they can't heartbeat or replicate yet. That needs (1) and a credential delivery mechanism.
3. **No published fork.** This repo's `origin` is upstream, so there's no valid `FLEET_RUNTIME_REPO` and no approved pin. Replication is blocked until the fork is pushed and a commit approved.
4. **Reproducible child builds.** `package-lock.json` is stale upstream (no `pg`, no `@solana/web3.js`). Children run `npm install` rather than a frozen `pnpm install --frozen-lockfile`.
5. **Stale `provisioning` slots and dead-agent detection.** `last_heartbeat` is recorded but nothing yet marks silent agents dead. That's deliberate for now, because an automatic reaper could free a slot while the agent is still running.
6. **Shell access** (Phase 1 risk 3) still applies: an agent with `exec` could read `DATABASE_URL` from its environment. Pattern blocking isn't a boundary.
7. Sandbox-side verification trusts the sandbox's own `git` output. A compromised sandbox could lie. Real attestation (e.g. an image digest) would be stronger.

---

# Phase 3 — Replication hardening and operational safety

Real replication, real payments and owner sweeps remain **disabled** (`.env.fleet`: `REAL_REPLICATION_ENABLED=false`, `REAL_PAYMENTS_ENABLED=false`, `OWNER_SWEEP_ENABLED=false`). Replication now needs **four** independent switches: the agent's env flag, the fleet service's env flag, the DB-level `fleet_state.replication_enabled` (operator: `fleet:admin set-replication on`), and `operating_mode = EXPANSION`.

## Database role model (schema v2)

| Role | Kind | Privileges | Who holds the credential |
|---|---|---|---|
| `fleetadmin` (owner) | LOGIN | Owns schema `fleet` and every object in it | Operator CLI and the fleet service's controller pool only |
| `fleet_agent` | NOLOGIN group | `USAGE` on schema `fleet` + `EXECUTE` on the seven `fleet.api_*` functions. No table, sequence or internal-function privileges | — |
| `fleet_agent_login` | LOGIN, member of `fleet_agent` | Nothing else. No TEMP, no CREATE, not superuser/createrole/createdb | The fleet service's agent pool only |

Agents (root and children) get **no database credential at all**. They hold a per-agent bearer token (`fa1.<agentId>.<secret>`). The registry stores only its SHA-256 hash (`fleet_agent_credentials`), and the token is revoked on death.

The restricted API (`SECURITY DEFINER`, `search_path = fleet, pg_temp`) is:
`api_fleet_state()`, `api_member_addresses()`, `api_whoami`, `api_heartbeat`, `api_request_replication`, `api_release_reservation` (own reservations only), `api_set_own_status` (`dead` to retire, `active`). Each one authenticates `(agent_id, token)` and acts only on the caller's own row, or on reservations the caller parents. On failure it returns JSON rather than raising, so the audit row commits. Because every mutation goes through these functions, the restricted role cannot:
alter the cap or mode, alter another agent, disable or drop triggers (it doesn't own the tables, and `session_replication_role` is superuser-only), create roles, change schema, create temp shadows, or reserve slots except through `api_request_replication` with every gate applied.

Setup (one-time, superuser, because `fleetadmin` cannot create roles):

```
sudo -u postgres psql -v ON_ERROR_STOP=1 -v dbname=automaton_fleet -v owner=fleetadmin \
  -v agent_password="$(openssl rand -base64 32)" -f scripts/fleet-db-roles.sql
pnpm fleet:migrate            # schema v2; grants the agent API to fleet_agent if the role exists
```

## Service architecture

```
automaton (root/child) ──HTTPS + own token──► fleet service (pnpm fleet:service)
   no DB creds                                   ├─ agent pool  (fleet_agent_login) → api_* only
   FLEET_API_URL                                 │     heartbeat, state, request, release, own status
   ~/.automaton/fleet-credentials.json (0600)    ├─ admin pool  (fleetadmin)
                                                 │     claim lease, verify attestation + activate,
                                                 │     record verification failure, reaper
                                                 └─ audit: fleet_events + JSONL (FLEET_AUDIT_LOG)
```

- `src/fleet/service/server.ts` `FleetService` exposes `/v1/health`, `/v1/state`, `/v1/members`, `/v1/self`, `/v1/heartbeat`, `/v1/status`, `/v1/replication/{request,claim,activate,fail,release}` and `/v1/children/terminal` (audit only: an agent never changes another agent's state).
- `src/fleet/service/client.ts` `FleetApiClient` is the agent's `FleetBackend`. `SharedFleetController` accepts either it or the admin `PgFleetStore` (service/tests) through `src/fleet/backend.ts`.
- At startup the service refuses if the agent DSN uses the admin user, or if `PgAgentGateway.selfCheck()` finds any table privilege, schema ownership, CREATE, superuser/createrole/createdb.
- Roots are enrolled by the operator: `pnpm fleet:admin enroll-root <wallet> <name>` registers the root and writes its credential file (0600, never printed). Children receive their credential from the parent after activation (`deliverChildCredential` writes `/root/.automaton/fleet-credentials.json` and runs `chmod 600`).

Env: `FLEET_CONTROLLER_DATABASE_URL` (legacy `DATABASE_URL`), `FLEET_AGENT_DATABASE_URL`, `FLEET_API_LISTEN` (default `127.0.0.1:8787`), `FLEET_REAPER_INTERVAL_MS` (15000), `FLEET_AUDIT_LOG`, `REAL_REPLICATION_ENABLED`.

## Heartbeat and reaper

- Agents heartbeat every 30 s (`api_heartbeat`). A heartbeat takes only the agent's row lock, never the fleet-wide lock.
- `fleet_reap()` runs every 15 s in the service (also `pnpm fleet:admin reap`). It is idempotent, and it serialises on the `fleet_state` row lock (the same lock order as reservations), so concurrent reapers are harmless. Each pass:
  1. Expires leases past `expires_at`: agent → `failed`, lease → `expired`, slot released.
  2. `UNRESPONSIVE` → `DEAD` when the last heartbeat is older than `heartbeat_dead_s` (default 600). This check runs before step 3, so reaching DEAD needs at least two passes.
  3. `ACTIVE` → `UNRESPONSIVE` when the last heartbeat is older than `heartbeat_unresponsive_s` (default 120). Unresponsive agents keep their slot; a heartbeat restores them to `ACTIVE`.
- Death revokes the credential, closes any open lease and releases the slot. The agent's next heartbeat returns `FLEET_AGENT_DEAD`, its `onDead` fires, and the automaton shuts itself down.
- **Outage grace:** if the reaper hasn't run for longer than the unresponsive timeout (because the service or DB was down), heartbeat ages are measured from when it resumed. An outage therefore can't mass-kill agents that couldn't report.
- Timeouts are configured with `pnpm fleet:admin set-timeouts reservation=S provisioning=S unresponsive=S dead=S`, stored in `fleet_state` with CHECK `dead > unresponsive`.

## Reservation leases

`fleet_reservations`: `reservation_id`, `agent_id`, `parent_agent_id`, `status` (`reserved → provisioning → completed`, or `expired` / `released` / `failed`), `created_at`, `expires_at`, `claimed_at`, `completed_at`, `ended_at`, `end_reason`, `expected_repo`, `expected_commit`, `expected_build_id`, `expected_lockfile_sha256`, `attestation_nonce`, `attested_at`, `attestation`. A guard trigger enforces forward-only transitions, immutable expectations and immutable terminal states; deletes are refused.

- Reserve: a lease with `reservation_ttl_s` (30 min). Claim: `provisioning`, TTL reset to `provisioning_ttl_s` (45 min), single-use nonce issued. **Provisioning slots now expire too.** Activation of an expired lease is refused even before the reaper runs.
- All slot allocation goes through the single SQL allocator `fleet_reserve_slot()`, used by both the admin store and the agent API.
- Release (`fleet_release`) and death (`fleet_mark_dead`) are conditional and idempotent. A second call returns `false` and writes no event.
- Phase 2 reservations/provisioning rows (none existed) are failed by migration v2, because they have no lease and could never attest.

## Runtime verification

The parent/controller records the expected repository, commit and **build identifier** on every lease, copied from the operator-approved runtime (`approve-runtime` now requires `FLEET_RUNTIME_BUILD_ID` and `FLEET_RUNTIME_LOCKFILE_SHA256`).

- **Build identifier:** SHA-256 over sorted `path\0sha256(file)\n` for `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `constitution.md`, `dist/**` and `src/**`. Symlinks are rejected.
- **Proof:** after install, the parent writes its *own* verifier (`ATTEST_SCRIPT`, node builtins only; nothing from the child's build runs) into the child sandbox and runs it with the lease nonce. The verifier hashes the installed tree and reports commit, origin, cleanliness, build ID and lockfile hash.
- **Check:** `spawnChild` checks the proof first to fail fast. `PgFleetStore.activate` then re-checks it authoritatively against the lease: nonce (defeats replay across reservations), commit, repo, lockfile, build ID, clean tree and proof consistency. The child's self-reported commit alone is never accepted.
- **Failure:** activation stops, the reservation is released, the lease is `failed`, the agent is `failed`, events `runtime_verification_failed`, `provisioning_failed` and `slot_released` are written, and no credential is issued.
- **At startup** the child re-hashes its tree against the manifest (`buildId`, `lockfileSha256`). It refuses to run if the lockfile or build doesn't match, or if the manifest has no build identity.

## Child build process

`package-lock.json` is removed; pnpm is the only package manager. In the sandbox: fetch the pinned SHA → verify `pnpm-lock.yaml` with `sha256sum -c` against the approved hash **before** installing → install pnpm `10.28.1` (the `packageManager` version; asserted) → `CI=true pnpm install --frozen-lockfile` → `pnpm build`. Any failure aborts the `&&` chain, and a non-zero exit refuses the child.

The operator produces the approved values with `scripts/fleet-build-runtime.sh <repo> <sha>`, which does the same frozen build in a fresh clone. Verified: two clean clones of `d6302c3` built this way produce byte-identical `dist/`. Opt-in test: `FLEET_REPRO_TEST=1`.

## Secret isolation / shell hardening

- `automaton --run` **refuses to start** if privileged variables are in its environment (`DATABASE_URL`, `FLEET_*DATABASE_URL`, `PG*`, `REDIS_URL`, `OWNER_*` wallet keys, `*SIGNING_*`, `*PRIVATE_KEY`, `*ADMIN_TOKEN` and similar; see `src/fleet/secrets.ts`). Scrubbing isn't enough because `/proc/<pid>/environ` keeps the original environment. Other commands scrub.
- Every agent shell (local `exec`, harness `exec`) runs with `agentChildEnv()`, which strips the same set. The agent keeps its own `CONWAY_API_KEY`, `FLEET_API_URL` and non-secret fleet flags, so allowed tools still work.
- The shell guard blocks: `.env.fleet`, `fleet-credentials.json`, `/proc/*/environ`, overrides of `FLEET_API_URL` / `FLEET_*DATABASE_URL`, `fleet:service`, `CREATE/ALTER/DROP ROLE`, `SET ROLE`, `SECURITY DEFINER`. `.env.fleet` and `fleet-credentials.json` are sensitive reads, and all new fleet files are protected from self-modification.

## Audit log

`fleet_events` (append-only) plus the service JSONL. Event types: `replication_requested`, `replication_granted`, `replication_rejected`, `reservation_denied`, `slot_reserved`, `slot_claimed`, `claim_denied`, `reservation_expired`, `runtime_verified`, `runtime_verification_failed`, `provisioning_failed`, `agent_activated`, `credential_issued`, `agent_unresponsive`, `agent_recovered`, `agent_died`, `slot_released`, `reaper_resumed`, `db_auth_failed`, `api_auth_failed`, `authorization_denied`, `db_authorization_failed`, `child_terminal_reported`, and the operator `*_set` events.

## Tests

`src/__tests__/fleet/fleet-phase3.test.ts` (43 tests, plus 1 opt-in). It runs against a throwaway PostgreSQL cluster that the test itself initialises (`fixtures/ephemeral-pg.ts`), with a non-superuser owner and the real `scripts/fleet-db-roles.sql`, so role restrictions are tested with real roles. Mutation-checked: over-granting the agent role or skipping attestation makes 6 tests fail. Phase 1/2 tests were adapted to the stronger rules: runtime approval now carries a build identity, and spawns must attest.

Known upstream issue: `src/__tests__/context-hardening.test.ts` hangs (no test completes in 120 s) identically on clean `d6302c3` and on Phase 3. It's excluded when running the full suite.

## Remaining blockers before the first real child

*Historical (end of Phase 3). Items 1–3 are done: roles created, schema migrated (now v6), fork published and runtime approved. Item 4 is covered by the production runbook (rate limiting was added in Phase 5). Item 7 was resolved in Phase 4 (parent-reported deaths are effective). Items 5, 6 and 8 remain open; see "Current deployment state".*

1. **Create the roles and migrate the live DB.** `scripts/fleet-db-roles.sql` needs a superuser, then `pnpm fleet:migrate` (the live `fleet` schema is still v1), then `fleet:admin enroll-root`.
2. **Remove `DATABASE_URL` from anything that starts an agent.** Don't source `.env.fleet` before `automaton --run` (it will refuse). Run the fleet service as a **separate OS user**. Today `.env.fleet` is readable by the same user an agent's shell runs as, so the pattern guard is the only thing in the way.
3. **Publish the fork and approve a build.** `origin` is still upstream, so there's no valid `FLEET_RUNTIME_REPO`. Push the fork, run `scripts/fleet-build-runtime.sh`, then `approve-runtime`.
4. **TLS / reachability.** The service listens on loopback HTTP. Remote Conway sandboxes need it behind HTTPS with a public name (the client refuses plain HTTP off loopback). There is no API rate limiting yet.
5. **Sandbox trust.** The verifier runs inside the child sandbox, so a compromised node/kernel there could lie. The nonce proves freshness, not integrity. Strong attestation needs image digests or TEE quotes. Node itself (apt `nodejs`) isn't pinned; only the pnpm and lockfile toolchain is.
6. **Zombie containment.** A reaped child that can't reach the service keeps running; it just can't heartbeat, replicate or authenticate. Stopping its sandbox automatically isn't implemented, because Conway sandbox deletion is disabled upstream.
7. **Parent-reported child deaths are audit-only** in the API path; the slot frees after the heartbeat timeout (≤ ~12 min by default).
8. Phase 1 risks 6–7 (local workers uncounted, non-fleet transfers governed only by treasury rules) are unchanged.

# Phase 4 — Deployment readiness and first-child preparation

Real replication, real payments and owner sweeps remain **disabled**. No child has been spawned. *At the time of Phase 4* nothing privileged had been applied. The database roles, the migration, the OS users and the systemd units have since been applied on the local VM (see "Current deployment state").

## Database roles (schema v3)

| Role | Kind | Effective privileges | Credential holder |
|---|---|---|---|
| `fleetadmin` (= fleet_admin) | LOGIN, schema owner | Owns `fleet` and every object in it. Migrations, cap/mode/runtime/replication switch, enroll/rotate credentials | Operator CLI only (`FLEET_ADMIN_DATABASE_URL` in `/etc/automaton-fleet/admin.env`) |
| `fleet_service` | NOLOGIN group | `USAGE` on `fleet`; `SELECT` on `fleet_schema_migrations`, `fleet_state`, `fleet_agents`, `fleet_reservations`, `fleet_events`, `fleet_sandbox_terminations` (**not** `fleet_agent_credentials`); `EXECUTE` on the 11 `svc_*` functions only | — |
| `fleet_service_login` | LOGIN, member of `fleet_service` | Nothing else. No TEMP or CREATE, not a member of the owner | Fleet service only (`FLEET_SERVICE_DATABASE_URL`) |
| `fleet_agent` | NOLOGIN group | `USAGE` + `EXECUTE` on the 7 `api_*` functions only | — |
| `fleet_agent_login` | LOGIN, member of `fleet_agent` | Nothing else | Fleet service only (`FLEET_AGENT_DATABASE_URL`) |
| PUBLIC | — | No CONNECT/TEMP/CREATE on the DB, nothing in `fleet` | — |

Agents hold **no database credential**, only their own `fa1.` bearer token.

- **Everything the controller writes goes through a `SECURITY DEFINER` `svc_*` function:** `svc_claim`, `svc_activate`, `svc_verification_failed`, `svc_release`, `svc_mark_dead`, `svc_heartbeat`, `svc_reap`, `svc_record_event`, `svc_child_terminal`, `svc_terminations_due`, `svc_termination_result`. Each one pins `search_path`.
- **What the service therefore cannot do:** change the cap, mode, approved runtime, replication switch or timeouts; insert agents; reserve slots directly; issue credentials outside activation; read token hashes; alter tables or triggers; create roles.
- **`svc_activate` re-checks the child's runtime proof itself.** It checks the nonce, reported and attested commit, repo, lockfile, build ID, clean flag and proof hash against the lease under the fleet lock. A bug in, or bypass of, the service's TypeScript check still can't activate an unverified child. A mismatch releases the slot as failed.
- **Migrations are admin-only.** `pnpm fleet:migrate` refuses any credential that doesn't own the schema. It re-grants both restricted roles.
- **`scripts/fleet-db-roles.sql` is idempotent.** It creates missing roles and re-asserts their attributes. It (re)sets passwords from the secret files, strips stray memberships, and revokes PUBLIC's CONNECT/TEMP.

`pnpm fleet:audit-privileges` checks **effective** privileges (`has_*_privilege`, so inherited and column-level grants count). It exits 1 if:
- an agent or service role is superuser, createrole, createdb, replication or bypassrls;
- it owns anything, or is a member of the owner or of the other restricted role;
- it has CREATE or TEMP;
- it has any table privilege beyond the allowlist (agent: none);
- it can execute any function beyond its API;
- an API function isn't `SECURITY DEFINER` with a pinned `search_path`;
- PUBLIC holds anything.

The fleet service runs the same audit at startup (refusing to start on any problem) and re-runs it every 60 s in `/readyz`.

## OS users and secret files

| Account | Purpose | Can read |
|---|---|---|
| `automaton-fleet-service` (system, nologin) | Runs the fleet service | `service.env`, only via systemd `LoadCredential=` (`$CREDENTIALS_DIRECTORY/service.env`) |
| `automaton-agent` (nologin, home 0700) | Runs local agent runtimes | Its own `~/.automaton/fleet-credentials.json` (0600). `/etc/automaton-fleet` is `InaccessiblePaths`, and `ProtectProc=invisible` hides other processes' `/proc/*/environ` |
| group `automaton-fleet-admin` | The operator (`sl4mm3r`) | `admin.env` |

| File | Owner / mode | Contents |
|---|---|---|
| `/etc/automaton-fleet/` | root:root 0755 | — |
| `admin.env` | root:automaton-fleet-admin 0640 | `FLEET_ADMIN_DATABASE_URL` (moved out of the repo `.env.fleet`) |
| `service.env` | root:root 0600 | `FLEET_SERVICE_DATABASE_URL`, `FLEET_AGENT_DATABASE_URL` (fresh 64-hex passwords) |
| `runtime.env` | root:root 0644 | Non-secret: `FLEET_RUNTIME_*`, `REAL_*_ENABLED=false`, listen address |
| `/var/log/automaton-fleet/` | service user 0700 (systemd `LogsDirectory`) | `audit.jsonl` (0600) |

`src/fleet/secret-files.ts` refuses symlinks, non-regular files, world-accessible files, and group-accessible files (except `admin.env`, which may be group-read). An unreadable file is a clear error, never a silent fallback.

The only other exception is the systemd credential copy `$CREDENTIALS_DIRECTORY/service.env`, which `LoadCredential=` creates as root-owned 0400 plus a read ACL for the service user (reported as mode 0440). It is accepted only when the process runs in `automaton-fleet.service` (per `/proc/self/cgroup`), `CREDENTIALS_DIRECTORY` is exactly `/run/credentials/automaton-fleet.service` (no symlinks, root-owned, not group/world-writable), the file is a single-link regular file at exactly that path owned by root or the service user, it has no world bits and at most group read, and `/etc/automaton-fleet/service.env` is still root-owned 0600. An explicit `FLEET_SERVICE_ENV_FILE` never gets the exception. The TLS key gets the same verified handling: `$CREDENTIALS_DIRECTORY/tls.key` (from `LoadCredential=tls.key:/etc/automaton-fleet/tls/fleet.key`) is accepted at 0440 only when `FLEET_TLS_KEY_FILE` is unset, under exactly the same unit/directory/file/ownership/mode checks, with `/etc/automaton-fleet/tls/fleet.key` still root-owned 0600 (or hidden from the service). An explicit `FLEET_TLS_KEY_FILE` always gets the strict 0600 check, even when it points into `CREDENTIALS_DIRECTORY`. Only the credential names `service.env` and `tls.key` get the exception; `tls.crt` is public and needs none, and the certificate path may not name a secret.

- The **service loader never reads `admin.env`**, and the service refuses to start if `FLEET_ADMIN_DATABASE_URL` is visible to it.
- The CLI warns when a controller secret still comes from the repository `.env.fleet`, and the doctor treats that as a blocker.
- Secrets never go through `Environment=` or `EnvironmentFile=`.

## Fleet service deployment

```
automaton-agent ─HTTP(loopback)+own token─► automaton-fleet.service (User=automaton-fleet-service)
                                              ├─ fleet_service_login → svc_* + SELECT (controller)
                                              ├─ fleet_agent_login   → api_*          (agent-scoped calls)
                                              └─ reaper (15 s) → leases, heartbeats, parent reports, sandbox terminations
```

- **Code:** `/opt/automaton-fleet/releases/<commit>` (root-owned, read-only), with `current` pointing to the active release. Node is a root-owned pinned copy at `/opt/automaton-fleet/node/bin/node`.
- **Unit** (`deploy/systemd/automaton-fleet.service`):
  - `Restart=on-failure`, `RestartSec=5s`, `StartLimitBurst=5` per `StartLimitIntervalSec=300`.
  - Shutdown: `KillSignal=SIGTERM`, `TimeoutStopSec=30s`.
  - Network: `IPAddressDeny=any` + `IPAddressAllow=localhost`.
  - Sandboxing: `ProtectSystem=strict`, `ProtectHome`, `NoNewPrivileges`, empty capability set, `SystemCallFilter=@system-service`, `InaccessiblePaths` covering `admin.env` and the agent's home.
- **Loopback only:** `FLEET_API_LISTEN` must be 127.0.0.1 or ::1, enforced in code as well as by systemd.
- **Health:** `GET /healthz` is liveness (no DB). `GET /readyz` checks the database, agent API, privilege audit, runtime release versus the approved runtime, and reaper freshness. It reports sandbox termination as a warning. It returns 503 when not ready or draining.
- **Graceful shutdown:** SIGTERM → stop accepting → new requests get 503 → in-flight requests and any running reaper pass finish (up to `FLEET_SHUTDOWN_DRAIN_MS`, 10 s) → pools close → exit 0. A second signal forces exit 1.
- **Structured logs:** JSON lines (`ts`, `level`, `service`, `event`, …) with credentials scrubbed, on stdout → journald. Audit events also go to `audit.jsonl`.
- **Startup refusals:**
  - the service DSN is the schema owner or a superuser;
  - the agent DSN isn't the restricted agent role;
  - the privilege audit fails;
  - the listen address isn't loopback;
  - `FLEET_ADMIN_DATABASE_URL` is present;
  - the runtime release ≠ the registry-approved runtime.
- `deploy/systemd/automaton-agent.service` is the matching isolation boundary for a local agent runtime. It is installed but **not enabled**.

## Runtime pinning

- **Release definition:** a fleet release is `FLEET_RUNTIME_REPO` + `FLEET_RUNTIME_COMMIT` + `FLEET_RUNTIME_BUILD_ID` + `FLEET_RUNTIME_LOCKFILE_SHA256` in `runtime.env`.
- **Values:** `scripts/fleet-build-runtime.sh` produces them from a clean clone, using `pnpm install --frozen-lockfile`.
- **Approval:** `fleet:admin approve-runtime` copies them into the registry.
- **Immutable while running (DB trigger `fleet_state_runtime_guard`):** the approved runtime can't change while any lease is open or any child is living. Clearing it is always allowed, and blocks replication.
- **Service pin:** the service pins the release at startup, refuses to start if it differs from the approved runtime, and refuses `claim` and `activate` for leases that expect a different release. It releases those slots as failed and records `runtime_release_mismatch`.
- **Fail closed at activation:** a child can't choose its repo or commit (`resolveChildRuntime`, lease expectations). A wrong repo, commit or build ID is refused twice: by the service and by `svc_activate`. No credential is issued.
- **Service code:** `scripts/fleet-deploy-release.sh build` (operator; frozen build; verified against `runtime.env`), then `sudo … install` (root copy, re-verified, immutable directory, atomic `current` switch).

## Heartbeats, leases, deaths, zombies

- States are ACTIVE → UNRESPONSIVE (`unresponsive=` s) → DEAD (`dead=` s), set with `fleet:admin set-timeouts reservation= provisioning= unresponsive= dead= parent-quiet=`.
- Reserved and provisioning leases expire and are reaped (`reservation_expired`, `slot_released`).
- **Parent-reported deaths are now effective** (`svc_child_terminal`, only for the caller's own children):
  - unclaimed or provisioning children are released at once;
  - a living child that has been quiet for `parent_report_quiet_s` (60 s) dies at once;
  - otherwise the child is flagged and the reaper retires it once it has been quiet that long, instead of waiting for `heartbeat_dead_s`;
  - a child that keeps heartbeating is never killed on its parent's word.
- **Sandbox termination queue:** every death with a known sandbox enqueues a row in `fleet_sandbox_terminations`, and the service works the queue through a `SandboxTerminator`. **Conway has no stop or delete API**, so the default terminator records `unsupported` (`sandbox_termination_unsupported`). This stays a **blocker**: the zombie can't authenticate, heartbeat or replicate, but its sandbox may keep running.
- Release, death, reap and termination results are all conditional and idempotent. Each writes its event exactly once.

## Readiness doctor

`pnpm fleet:doctor [--json] [--deployment-only]` reports:
- database connectivity, schema version and privilege audit;
- fleet service readiness (`/readyz`);
- runtime repo, commit and build ID, and whether they match the approved runtime;
- the replication, payments and owner-sweep flags (any `true` fails);
- fleet maximum, living agents, reserved slots, stale agents, stale reservations and unterminated sandboxes;
- OS users and groups, secret-file modes, the systemd unit, and legacy secrets in `.env.fleet`.

It gives two verdicts: **DEPLOYMENT** OK/FAIL and **REAL REPLICATION** SAFE/UNSAFE. The exit code is 1 while any blocker remains. At the end of Phase 4 it reported DEPLOYMENT FAIL and REAL REPLICATION UNSAFE with 11 blockers. It now reports DEPLOYMENT OK; Phase 6 added the readiness levels (see "Current deployment state").

## Tests

`src/__tests__/fleet/fleet-phase4.test.ts` (38 tests, `pnpm test:deploy`) runs on a throwaway cluster that is set up exactly like production (roles script fed on stdin). It covers:
- privilege boundaries, plus an audit that fails for 11 over-grant mutations, and role-script drift repair;
- migrations refused for the service and agent logins;
- wrong DB role; missing DB; unreadable, world-readable or symlinked secret files;
- wrong repo, commit or build ID, both through the store and by calling `svc_activate` directly with a self-consistent forged proof;
- replayed nonce;
- runtime immutability;
- stale heartbeat, stale reservation, idempotent cleanup, and parent-reported deaths;
- the termination queue;
- the service: refusals, loopback, `/healthz` and `/readyz`, replication still disabled, structured logs, drain;
- service unavailable;
- the doctor verdicts;
- unit and script invariants;
- shell-guard and self-modification protection for the new files.

# Phase 5 — Production control plane, lifecycle enforcement, treasury economics

Real replication, real payments and owner sweeps remain **disabled**. No live transfer happens anywhere in this phase. Sweeps, owner distributions, custody transfers and approved spends are recorded as plans only (`planned_not_executed` / `blocked_payments_disabled` / `approved_not_executed`). Schema is now **v5**: v4 covers lifecycle and the remote control plane, v5 covers the treasury.

## Lifecycle

```
RESERVED ─claim─► PROVISIONING ─sandbox reported─► VERIFYING ─attested─► ACTIVE ⇄ UNRESPONSIVE ─► TERMINATING ─► DEAD
      └────────────── any failure ──────────────► FAILED_PROVISIONING (sandbox queued for cleanup)          └─► ORPHANED ─► DEAD
```

- **Provisioning records** (`fleet_provisioning`) are created at claim time, before any sandbox exists. Each has `provisioning_id`, `reservation_id`, `parent_agent_id`, `sandbox_id`, `expected_agent_id`, `expected_runtime_commit`, `created_at`, `activation_deadline`, `status`, `cleanup_status` and `failure_reason`.
  - `spawnChild` reports the sandbox the moment `createSandbox` returns, with 3 retries; a failed report aborts the spawn. It reports `verifying` before the runtime install and attestation.
  - Activation must use the recorded sandbox (`FLEET_SANDBOX_MISMATCH` otherwise).
  - A failed attempt stays visible: `failed_provisioning` with cleanup `pending`, then `terminated` or `unsupported` (orphaned).
- **Capability revocation is a trigger.** Any move into TERMINATING, ORPHANED, DEAD or FAILED revokes the fleet credential and every session, freezes wallet spending, and voids pending challenges. No code path can skip it.
- **Health is not a heartbeat.** The controller issues challenges (short-lived nonce, hash stored, single-use) in heartbeat responses. The agent must answer with its runtime identity (commit, plus build ID for children, checked against its lease) and prove its shell guard refuses a canary command (policy responsiveness). Registration and credential validity are checked on every call.
  - An agent becomes UNRESPONSIVE on any of:
    - a stale heartbeat (`unresponsive_s`);
    - no passed challenge within `health_grace_s` (300);
    - `max_challenge_failures` (3) failed or expired challenges.
  - Heartbeats never restore health. Only a passed challenge does.
  - **Termination eligibility:** an agent UNRESPONSIVE for longer than `termination_grace_s` (480), or with no heartbeat for `heartbeat_dead_s`, moves to TERMINATING. The clock runs from when it *became* unresponsive, so a heartbeat-only zombie can't hold its slot.
- **When the provider can't stop a sandbox** (Conway has no API for it; the terminator reports `unsupported`, or 5 attempts fail), the agent becomes **ORPHANED**:
  - Every capability is already revoked: fleet credential, sessions, wallet spending, replication (parent must be ACTIVE and unfrozen), controller access (`FLEET_AGENT_QUARANTINED`).
  - It is recorded in `fleet_orphans`, the append-only audit of external infrastructure.
  - **Slot policy:**
    - A health-terminated or quarantined orphan keeps a *quarantine slot* (`fleet_state.quarantined_slots`, counted against the cap) until one of: the operator confirms cleanup (`fleet:admin resolve-orphan`), the terminator confirms, or `orphan_slot_hold_s` (72 h; 0 = hold until resolved) elapses.
    - After the hold, the slot is released but the orphan record **stays open**.
    - Replication is blocked fleet-wide (`FLEET_ORPHANS_UNRESOLVED`) while more than `max_open_orphans` (1) remain unresolved.
    - Orphans of failed provisioning and of voluntary deaths are audited but hold no slot: they never held credentials, or they confirmed their own shutdown.
- **Settings:** `fleet:admin lifecycle-policy interval= challengeTtl= healthGrace= maxFailures= terminationGrace= orphanHold= maxOrphans= sessionTtl=`. Operator actions: `quarantine`, `resolve-orphan`, `orphans`, `provisioning [cleanup]`.

## Remote control plane

```
child sandbox ──HTTPS──► fleet service ──► PostgreSQL (loopback only; never exposed)
  fa1 credential ─POST /v1/session─► fs1 session (TTL 600 s, hash in DB, per agent)
  every other request: FleetSession fs1 + x-fleet-timestamp (±60 s) + x-fleet-nonce (single use, DB ledger)
                       + x-fleet-signature = HMAC-SHA256(session, METHOD\nPATH\nTS\nNONCE\nsha256(body))
```

- **Identity:** a session token embeds exactly one agent ID. The database checks each session on every agent-scoped call: it must exist for that agent, be unexpired and unrevoked, belong to a living, non-quarantined agent, and the agent's credential must be valid.
  - Sessions can't mint sessions.
  - Rotating a credential or leaving the living population revokes every session.
  - The long-lived credential is accepted **only** by `POST /v1/session`. `allowLegacyBearer` exists only for the Phase 3 tests.
- **Replay protection:** nonces are recorded in `fleet_request_nonces`, which is shared across service instances and restarts. Stale timestamps are refused, and a tampered body breaks the signature.
- **Rate limits** (in memory, per instance): 60-request burst / 5 per s per agent; 10 sessions/min per agent; 20 auth failures/min per address → 429 with `Retry-After`.
- **Audit:** every request is logged as `api_request` with request ID, agent, method, path, status, latency and IP (no bodies or tokens). Security events go to `fleet_events`.
- **HTTPS:** production sets `FLEET_TLS_CERT_FILE=/run/credentials/automaton-fleet.service/tls.crt` and leaves `FLEET_TLS_KEY_FILE` unset; the remote drop-in delivers `LoadCredential=tls.key:/etc/automaton-fleet/tls/fleet.key` and `LoadCredential=tls.crt:/etc/automaton-fleet/tls/fleet.crt`. An explicit `FLEET_TLS_KEY_FILE` must be a strict 0600 file. The service listens off-loopback only when `FLEET_REMOTE_LISTEN_ENABLED=true` **and** TLS is configured. The shipped unit stays loopback-only with `IPAddressDeny=any`; the TLS lines are commented out. The client refuses plain HTTP off loopback.

## Treasury economics

**Waterfall per agent** (integer cents):

| Concept | Rule |
|---|---|
| GROSS_REVENUE / DIRECT_COSTS / NET_PROFIT | From the agent ledger. **Owner funding (and fleet funding) is never revenue or profit** |
| OPERATING_OBLIGATIONS | Approved, unsettled obligations |
| PROTECTED_RUNWAY | `runway_days` (30) × average daily direct-cost burn (30-day lookback) |
| APPROVED_GROWTH_CAPITAL | Unspent approved allocations that are **current** (start ≤ now < expiry). Expired, proposed or rejected ones protect nothing |
| CONTINGENCY_RESERVE | `max(min_contingency_cents, contingency_pct × 30 days of burn)` |
| EXCESS_CAPITAL | `max(0, cash − all of the above)` |
| FLEET_SWEEP | `floor(min(EXCESS_CAPITAL, undistributed NET_PROFIT) × effective rate)` |
| AGENT_RETAINED_CAPITAL | `cash − FLEET_SWEEP`, which by construction is ≥ everything protected (also asserted at runtime) |

**Dynamic sweep rate** (`src/fleet/treasury/engine.ts`, `computeSweepRate`):

```
base      = population band: 1–10: 10% · 11–20: 12.5% · 21–30: 15% · 31–40: 17.5% · 41–49: 20% · 50: mature_fleet_rate (45%)
maturity  = min(1, age / 180 d) × (0.5 + 0.5 × revenue consistency)
surplus   = clamp((excess / protected − 1) / 3)                 (4× protected ⇒ fully surplus)
uplift    = (max − base) × maturity × surplus                   highly capitalised mature agents
          + 0.05 × treasury reserve shortfall                    fleet treasury needs reserves
          + 0.05 × recent loss ratio                             recent capital losses
          − 0.10 × clamp(ROI / 50%) × forecast accuracy          credible productive use keeps capital
policy    = min(max_sweep_rate (≤ 70%), base + max(0, uplift))
rate      = policy × (1 − combined active temporary reductions)
```

Approved expansion needs reduce the rate by being protected capital, which lowers `excess`, and through temporary reductions.

**Capital allocations** (`fleet_capital_allocations`): `allocation_id`, `agent_id`, `purpose`, requested and approved amounts, `start_date`, `expiry_date`, expected return and duration, `status`, actual return, deployed amount, and who proposed and decided.
- Agents may only **propose**, via `POST /v1/capital/propose`.
- Approve, reject, change, complete, reduce sweep, freeze, quarantine and custody transfer are FleetAdmin-only, through the admin credential and CLI.
- The database refuses **any fleet agent ID or agent wallet** as an approver (`fleet_require_operator_approver`).
- Approvals above the performance-scaled discretionary limit need an explicit override.

**Capital performance profile** (internal, never exposed to agents, no single score): capital deployed and returned, ROI, forecast accuracy, failed and profitable allocations, consecutive failures, revenue consistency, capital efficiency, recent loss ratio.
- It drives the discretionary multiplier: strong agents get up to 2× the base allocation; each consecutive failure and recent losses shrink it toward 0.
- Emergency rescue is advice only (`rescue-advice`) and always needs an operator decision.

**Fleet bank:**
- The treasury ledger is separate from the owner's withdrawal address. The database refuses equal addresses.
- Permitted uses: infrastructure, inference, maintenance, emergency rescue, replacement agents, approved growth, compliance, contingency.
- Reserve target = `reserve_target_months` (3) × monthly operating expense (last 90 days of recorded operating spend).
- Owner distributions are planned only from `balance − reserve target − treasury obligations`; a DB check constraint enforces this. Owner sweeps stay disabled.

**Custody:** a custody record is created for every agent wallet (`fleet_wallet_custody`, supervisor `fleetadmin`).
- Agents request spends from **their own** custody wallet only (`POST /v1/wallet/spend-request`). The request is checked against agent health, the freeze flag, a current approved allocation, or the daily limit.
- Approved spends are **never executed**. `executeApprovedSpend` requires `REAL_PAYMENTS_ENABLED=true` **and** a controller signer, and neither exists.
- Owner and treasury keys never reach agents.

## Tests

- **`src/__tests__/fleet/fleet-phase5.test.ts`** (43 tests, `pnpm test:phase5`), part of `test:fleet`, `test:security` and `test:financial`.
- **Mutation-checked:** removing the policy canary check, letting heartbeats restore health, skipping the nonce ledger, or not protecting growth capital each makes tests fail.
- **Earlier phases:** their tests share `fixtures/wipe.js` for resets. Phase 3's direct-service tests opt into `allowLegacyBearer`. The Phase 4 production-mode test now uses the session client.

# Phase 6 — Real control plane deployment and the first remote child dry run

Real replication, real payments and owner sweeps remain **disabled** (`REAL_REPLICATION_ENABLED=false`, `REAL_PAYMENTS_ENABLED=false`, `OWNER_SWEEP_ENABLED=false`). Nothing in this phase enables them. Schema is now **v6**.

## Untracked sandbox window (schema v6)

The Phase 5 gap: `createSandbox` could succeed while the callback reporting it was lost. The controller then had a provisioning record with no sandbox, and a failed attempt freed its slot.

- **Provisioning key:** the reservation ID is the provisioning key. It is carried through the reservation, sandbox creation (deterministic sandbox name `fleet-<lower(key)>`), the child's runtime manifest (`provisioningKey`), every provisioning callback and activation. A mismatched key is refused by the service and by `PgFleetStore.activate`.
- **Durable intent before creation:** `svc_provision_update('sandbox_intent')` records the sandbox name, `external_state = intent` and the attempt count *before* `createSandbox` is called. If the intent can't be recorded, nothing is created.
- **Idempotent creation** (`createTrackedSandbox`):
  - If the controller already knows the sandbox, it is reused.
  - On a retry, the sandbox is looked up by name first.
  - If absence can't be proven (listing fails, or the provider doesn't report names), creation stops with `FleetProvisioningUncertainError` rather than risk a second sandbox.
  - The database caps attempts at 3.
  - Shared-registry grants never reuse another child's sandbox.
- **Uncertain outcome → ORPHANED, not FAILED:** a provisioning attempt that fails (lease expiry, verification failure, parent report) while its sandbox may exist becomes ORPHANED. This happens through a `BEFORE` trigger, so no code path can skip it.
  - Every capability is revoked (lifecycle trigger).
  - An orphan record is kept (`sandbox_name`, `holds_slot = true`).
  - The provisioning record stays `cleanup_status = pending`.
  - A **quarantine slot** counts against the cap until reconciliation or the orphan hold.
- **Known sandbox:** a failed attempt whose sandbox *is* known keeps the Phase 5 policy (FAILED_PROVISIONING, termination queued, no slot).
- **Reconciliation** (`svc_provision_reconcile`, `pnpm fleet:admin reconcile-provisioning`, `reconcile <key> found <id>|absent|unknown`):
  - `found` records the sandbox and queues it for termination.
  - `absent` is accepted only after the activation deadline, so no create can still be in flight. It resolves the orphan and frees the slot.
  - `unknown` keeps the slot held.
  - A sandbox reported late, even after `absent`, is still captured and queued for cleanup.

## HTTPS controller

| Setting (`runtime.env`, non-secret) | Meaning |
|---|---|
| `FLEET_REMOTE_LISTEN_ENABLED` | `false` (shipped). `true` requires everything below |
| `FLEET_PUBLIC_HOSTNAME` | DNS name children use; the certificate must cover it |
| `FLEET_PUBLIC_LISTEN` | HTTPS bind, e.g. `0.0.0.0:443`. `FLEET_API_LISTEN` then stays the **loopback plain-HTTP admin** listener |
| `FLEET_PUBLIC_URL` | `https://<hostname>` (doctor / dry run) |
| TLS directory | `/etc/automaton-fleet/tls` (root:automaton-fleet-admin 0750) |
| `FLEET_TLS_CERT_FILE` | `/run/credentials/automaton-fleet.service/tls.crt`, from `/etc/automaton-fleet/tls/fleet.crt` (root:root 0644) via `LoadCredential=tls.crt` |
| TLS key | `/run/credentials/automaton-fleet.service/tls.key`, from `/etc/automaton-fleet/tls/fleet.key` (root:root 0600) via `LoadCredential=tls.key`; `FLEET_TLS_KEY_FILE` unset |
| `FLEET_ALLOWED_ORIGINS` | Browser origins (https only). Default: none; any request carrying another `Origin` gets 403 |

- **Startup refusals:**
  - remote exposure without TLS or a hostname;
  - a certificate that doesn't cover the hostname, isn't yet valid, expires within a day, or doesn't match the key;
  - `FLEET_PUBLIC_LISTEN` without `FLEET_REMOTE_LISTEN_ENABLED`;
  - any plain-HTTP listener off loopback (`FleetService.bind`, `listenAdmin`);
  - running as root, or as anyone other than `FLEET_SERVICE_EXPECTED_USER` (the unit sets `automaton-fleet-service`).
- **Endpoints:** `/healthz` returns only `{ok, status, uptimeS}`. `/readyz` (detailed) answers loopback peers only. Responses carry `cache-control: no-store`, `nosniff`, and HSTS over TLS.
- **No database path:** PostgreSQL and Redis are never proxied. There is no DB route and no `CONNECT` tunnelling, and a PG protocol packet gets an HTTP 400 (tested).
- **Certificate renewal needs a restart:** `LoadCredential=` copies `tls.key` and `tls.crt` only when the service starts. A renewed certificate must be copied into `/etc/automaton-fleet/tls/` (single-link, root:root 0600/0644) and the service restarted. Otherwise it keeps serving the old certificate, and once that is within a day of expiry the service refuses to start. The certbot deploy hook and monitoring are in `docs/fleet-production-runbook.md` ("Certificate renewal requires a service restart").
- **Remote drop-in:** `deploy/systemd/automaton-fleet.service.d/remote.conf.example` (not installed) adds `LoadCredential=tls.key` and `LoadCredential=tls.crt`, lifts `IPAddressDeny` and grants only `CAP_NET_BIND_SERVICE`.
- **Firewall:** `deploy/firewall/fleet-firewall.sh` (dry run by default) denies all inbound traffic except SSH and 443/tcp, and explicitly denies 5432, 6379 and 8787. nftables equivalent:
  ```
  table inet fleet { chain input { type filter hook input priority 0; policy drop;
    ct state established,related accept; iif lo accept; tcp dport { 22, 443 } accept; } }
  ```

## Pinned runtime

- **Release definition:** `FLEET_RUNTIME_REPO/_COMMIT/_BUILD_ID/_LOCKFILE_SHA256` in `runtime.env`, produced from a clean clone with `pnpm install --frozen-lockfile` (`scripts/fleet-build-runtime.sh`).
- **Before the fork is published:** `scripts/fleet-deploy-release.sh build --source <local clone>` fetches the pinned commit locally and verifies it identically.
- **`pnpm fleet:verify-runtime [dir]`:** reports the pinned identity, the registry-approved runtime and an installed tree's actual commit, origin, lockfile hash and build ID. It exits 1 if the repository, commit, build ID or lockfile differs. The same comparison refuses service startup and child activation (`svc_activate`).

## DRY_RUN_CHILD

`pnpm fleet:dry-run-child --root <agentId> --api-url https://<host>` runs the preflight only. The real run additionally needs `FLEET_DRY_RUN_CHILD=true`, `--confirm-real-sandbox` and `CONWAY_API_KEY`, and creates **one** real sandbox.

- **Preflight:** payment, owner-sweep and replication flags all false; cap = 2 with a free slot; approved runtime equals the pinned release; no orphan, stuck reservation, uncertain provisioning or existing dry-run child; the https controller is reachable and not loopback.
- **Run:**
  1. `fleet_reserve_dry_run` (operator-only; `dry_run` stored in the DB).
  2. Claim.
  3. Tracked sandbox.
  4. The child fetches the pinned fork, verifies the exact commit and lockfile hash, runs `pnpm install --frozen-lockfile` and `pnpm build`.
  5. Attestation (parent verifier + nonce + build ID).
  6. Activation (double-checked).
  7. Credential (0600) and dry-run manifest delivered.
  8. The sandbox runs `dist/fleet/dry-run/child-main.js`: session over HTTPS, heartbeat, controller challenge.
  9. The operator waits for a **passed challenge**; only the child can produce one.
- **The child cannot:**
  - **Transfer money or sign:** it has no wallet key. Its registered address is keyless (`sha256`-derived; no private key exists). Custody is forced frozen with a zero limit by a DB trigger, even against the owner, and capital allocations are refused.
  - **Create a child:** DB insert guard (`FLEET_DRY_RUN_NO_REPLICATION`), frozen-parent refusal, service replication switch.
  - **Change fleet configuration or sweep rules:** admin-only; there is no agent API for either.
  - **Reach controller secrets or PostgreSQL:** it holds only `{agentId, token, apiUrl}`. `child-main` refuses to run if any DB/controller credential, wallet key or `REAL_*`/`OWNER_SWEEP` switch is present.
- **Quarantine:** `fleet:admin quarantine <id>` revokes everything. The child's next heartbeat is refused and its slot becomes a quarantine slot within the cap.

## Operator verification

- **`pnpm fleet:verify`** (doctor `--checklist`; exit 0 only when SAFE FOR DRY RUN) checks:
  - PostgreSQL roles, schema v6;
  - controller service active (systemd + `/readyz`);
  - privileged secrets protected (modes plus a per-OS-user readability check for the agent and service users; nothing in `.env.fleet`);
  - runtime repo, commit and build ID pinned and matching the approved runtime;
  - HTTPS certificate valid for the hostname; remote controller reachable;
  - replay protection (stale signed request refused, long-lived credential refused outside `/v1/session`, nonce ledger);
  - agent credentials scoped;
  - payments and owner sweeps disabled;
  - fleet cap = 2;
  - no unresolved orphan; no stuck reservation or uncertain provisioning.
- **Three independent readiness levels**, each with its own blockers:
  - **SAFE FOR DRY RUN**
  - **SAFE FOR REAL REPLICATION:** additionally needs a dry-run child that reached ACTIVE with a passed challenge, plus the structural blockers below.
  - **SAFE FOR REAL PAYMENTS:** needs a controller custody signer and controller-held wallet keys; independent of the dry run.
- **`sudo scripts/fleet-verify-deployment.sh`** (read-only) checks the same things as the real OS identities:
  - `runuser -u automaton-agent -- test -r` for every secret;
  - the service process user;
  - no DSN in `/proc/<pid>/environ`;
  - 5432, 6379 and 8787 loopback-only.

## Tests

`src/__tests__/fleet/fleet-phase6.test.ts` (29 tests, `pnpm test:phase6`; part of `test:fleet` and `test:security`, with the spend tests in `test:financial`) covers:
- migration v1 → v6 (transactional check rolled back, then applied); migrations refused for the agent and service roles;
- dedicated service user; agent and service users can't read secrets;
- pin, build ID and frozen-lockfile mismatches refused;
- lost create response → one sandbox and one child; providers without names → no second create;
- callback loss → ORPHANED quarantine slot → found or absent reconciliation;
- HTTPS required; HTTP remote binding refused; no PostgreSQL path through the service;
- the end-to-end dry run over TLS (attest, heartbeat, challenge, ACTIVE);
- zero spend authority, no replication, quarantine;
- population never above 2;
- the three doctor levels.

Mutation checks: removing the uncertain→ORPHANED rewrite or the custody freeze each make tests fail.

# FLEET-KI-4 — Witness capability scope and the root witness (schema v7)

**Status:** implemented in the working tree, not yet reviewed, committed, pinned or deployed. The live registry stays at v6 and the approved runtime stays `11c0c7c` until the operator approves a new release and the v7 migration. Real replication, real payments and owner sweeps remain **disabled**, and nothing here changes a safety switch, the cap or the approved runtime.

The operator dry run needs a living root parent (`fleet_reserve_dry_run`), and a root stays ACTIVE only while it heartbeats and passes health challenges. The **root witness** is the smallest process that does that. Its security does not depend on the witness program: a stolen witness credential can do nothing but open a session, heartbeat, answer a challenge and read itself.

## Capability scope (schema v7, `src/fleet/postgres/migrations-phase7.ts`)

- `fleet_agents.capability_scope text NOT NULL DEFAULT 'full' CHECK IN ('full','witness')`. Every existing agent becomes `full` and behaves exactly as before.
- It belongs to the agent identity, not to a credential or session. `fleet_authenticate` reads the agent row for both `fa1` credentials and `fs1` sessions, so every session inherits it, and credential rotation cannot escape it.
- **Immutable** after insert (trigger `fleet_agents_zz_scope_immutable`, even for the owner). CHECK `fleet_agents_witness_is_root`: a witness is always a parentless, non-dry-run root. No new role.
- Set only by `registerRoot(..., capabilityScope)`, called by the operator's `enroll-witness-root`. Normal `enroll-root` is unchanged (`full`).

## Enforcement

| Layer | Mechanism | Covers |
|---|---|---|
| Fleet service | `ROUTE_POLICY` + `routeDecision()` in `src/fleet/service/server.ts`. `route()` calls `authorize()` before dispatching anything | Every `/v1` route. No policy entry → never dispatched (404). Scope `witness` → only routes marked `witness: true`. Any other non-`full` scope → no authenticated route. A restricted identity on a denied route is authenticated for real (`api_whoami`) first, then gets `403 FLEET_SCOPE_DENIED` and a `scope_denied` event (fleet_events + audit JSONL, no tokens). An invented token gets 401 and records nothing |
| Database | `fleet_authenticate(p_agent, p_token, p_action)` | Every `api_*` function. For `witness` only the actions `open_session`, `heartbeat`, `whoami` pass; any other action, including unknown or future ones, returns `FLEET_SCOPE_DENIED`. `full` is unchanged |
| Allocator | `fleet_reserve_slot` returns `FLEET_PARENT_SCOPE`; BEFORE INSERT guard `fleet_agents_scope_parent_guard` | A witness can never parent a normal child, whatever path inserts it. `fleet_reserve_dry_run` (operator-only) still accepts it |
| Treasury | `fleet_custody_dry_run_guard` (extended), `fleet_allocations_dry_run_guard` (extended) | Custody always frozen with a zero limit, even if the owner unfreezes it. No capital allocation can be written |

`svc_*` functions are unchanged. The operator's dry run (`performDryRunChild`) passes the witness root as `parentAgentId` to `svc_claim`, `svc_activate` and the provisioning callbacks, so a database-level parent check there would break it. The agent-facing lease routes are denied by the route policy instead.

### Witness authorization matrix

| Route | Witness |
|---|---|
| `POST /v1/session` (`fa1` only) | allow |
| `POST /v1/heartbeat` | allow |
| `POST /v1/health/challenge` | allow (ownership, single use, expiry, nonce, commit and canary checks unchanged) |
| `GET /v1/self` | allow |
| `GET /v1/health` | public (no identity, no authority) |
| `GET /v1/state`, `GET /v1/members` | deny |
| `POST /v1/status` | deny |
| `POST /v1/replication/{request,claim,provisioning,activate,fail,reconcile,release}` | deny |
| `POST /v1/children/terminal` | deny |
| `POST /v1/capital/propose` | deny |
| `POST /v1/wallet/spend-request` | deny |
| any route without a policy entry | never dispatched (404) |

Policy, cap, mode, runtime approval and treasury decisions have no agent route at all; they exist only in the admin CLI with the schema-owner credential.

## Root witness process

`dist/fleet/dry-run/root-main.js` (`src/fleet/dry-run/root-witness.ts`) reuses `FleetApiClient`: `fa1` → `fs1`, signed heartbeats, automatic challenge answers.

- **Before any network access** it refuses: uid 0; `REAL_PAYMENTS_ENABLED`, `REAL_REPLICATION_ENABLED` or `OWNER_SWEEP_ENABLED` true (process env or runtime.env); privileged or forbidden variables (database URLs, `PG*`, `REDIS_URL`, wallet keys, `CONWAY_API_KEY`, …); any `~/.automaton/wallet*`; a readable `admin.env`, `service.env`, TLS key or legacy backup; an installed tree whose build ID or lockfile differs from the pinned release.
- **After the first session** it refuses unless `/v1/self` says role `root`, scope `witness`, and the pinned runtime commit.
- **Challenge answer:** the verified pinned commit and build ID, and whether the bundled shell guard blocks the canary. The canary is pattern-matched, never executed.
- **Loads** no wallet, inference, agent-loop, Conway or replication module (static import-graph test plus a runtime test with throwing mocks). It holds no database credential and logs no token.
- **Exit codes:** 0 stopped; 3 rejected by the controller (dead, quarantined, revoked); 4 startup refusal. The unit never restarts 3 or 4.
- **When it stops:** the root becomes UNRESPONSIVE once its heartbeat is older than `unresponsive_s`, and `fleet_reserve_dry_run` then refuses it (`FLEET_PARENT_NOT_LIVING`). It moves to TERMINATING/DEAD after `termination_grace_s`.

**OS identity:** `automaton-fleet-witness` (system, nologin, no supplementary group). Unit `deploy/systemd/automaton-fleet-witness.service` (installed by `fleet-os-setup.sh`, never enabled):
- 0700 `StateDirectory`, holding the 0600 credential;
- `NoNewPrivileges`, empty capability set, `ProtectSystem=strict`, `ProtectHome`;
- loopback-only network;
- `InaccessiblePaths` for `admin.env`, `service.env`, `tls/`, the legacy backup, the agent's home and the service's state/logs.

**Enrollment:** `pnpm fleet:admin enroll-witness-root <name> <credentialFile>`:
- a keyless address (no private key exists);
- role root, scope `witness`;
- `runtime_commit` = the registry-approved commit;
- custody frozen (verified);
- credential written 0600 through a hard link, so an existing file is never replaced;
- prints only the agent ID, scope, commit and path.

If writing the credential fails, the new root is marked dead immediately. Retire it after the dry run with `fleet:admin mark-dead`, which revokes the credential and all sessions.

## Tests

`src/__tests__/fleet/fleet-witness.test.ts` (26 tests, `pnpm test:witness`) and `fleet-witness-imports.test.ts` (2) cover:
- migration v6 → v7, and existing agents becoming `full`;
- scope immutability;
- session, heartbeat, challenge and self allowed; every other route denied with no side effect and an audit event without secrets;
- unknown routes and actions fail closed; replay and stale timestamps still refused;
- rotation keeps the scope; `full` agents unchanged;
- allocator refusal and dry-run acceptance; spend and capital denied;
- no wallet, inference or replication modules; clean shutdown; UNRESPONSIVE after stop;
- route-policy completeness.

Mutation-checked: removing the service's `authorize()` or the database scope check each makes a test fail.
