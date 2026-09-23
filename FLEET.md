# Fleet Layer — Phase 1

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
