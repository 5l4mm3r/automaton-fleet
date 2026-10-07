# R37: schema v42 (multi-agent team projects) and controller release 94f09a7, DEPLOYED 2026-10-07

**Release.**
- Commit `94f09a7c44f528b8a632e16565e0fedf5ee56d2f` (branch `fleet/final-v2.4`)
- Build `da053d1cd5f333925cd67c66c51ceb652e143e585a2ab9e29048f9191d6cf61c`
- Lockfile `1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1` (unchanged since R35)
- Schema 41 → **42**

The build is identical on the VPS and locally (`pins.txt`, `pins-local.txt`). Each was built in a fresh clone by
`scripts/fleet-build-runtime.sh`.

**What 94f09a7 contains relative to the previous release 29cde7d.**
- Schema v42: multi-agent team projects. It also changes the sweep: each unit of realised profit is swept once.
- The project tool in the Founder toolbox, the planner, and the dashboard's `projects` read.
- V2.4.1 UI source, with no backend effect. The production admin root still serves UI 0.3.0. The V2.4.1 preview stays at
  `/hq-preview/`.
- The release tooling of this stage (below).

Economics are unchanged by the promotion. The v42 order is external revenue → project costs → tax → realised net profit →
Treasury sweep → post-sweep distributable pool → the negotiated distribution. There is no fixed split.

## Release tooling added in this stage

- `pnpm test:security` / `pnpm test:financial` run whole FILES, one at a time (`scripts/test-suite.mjs`). The old `-t`
  name filter skipped the setup steps of stateful suites. The selected `fleet-phase2..5` share the development database,
  so they cannot run in parallel. A parallel trial produced 111 false failures.
- `scripts/fleet-reconcile-snapshot.sql` + `fleet-reconcile-compare.mjs` take a machine-readable before/after
  comparison. They gate both the rehearsal and the cutover, and a mismatch triggers automatic rollback.
- `scripts/fleet-rollout.sh`:
  - re-runs the migrator to prove idempotency;
  - rolls back if a safety flag is not false or the cap or population changed;
  - cycles the dashboard and identity broker with the controller, because they require the exact schema.
- `scripts/fleet-upgrade-rehearsal.sh` exercises the services and the rollback on a throwaway copy of production.

## Validation of 94f09a7 (clean checkout)

| Check | Result |
|---|---|
| Frozen install, root typecheck, `dist`, UI dependency integrity, UI typecheck, UI lint, simulation | all 0 |
| Full suite (`--no-file-parallelism`) | 151 files passed, 4 skipped; **2919 passed, 0 failed**, 30 skipped |
| `pnpm test:security` | 46 files, 1342 passed, 1 skipped |
| `pnpm test:financial` | 31 files, 752 passed, 1 skipped |
| Preview CSRF + page sweep (gated) | 8/8 |
| v42 projects at scale 1/10/25/50 Agents (gated) | 5/5 |
| Virtual HQ scale and navigation (gated, browser) | see "Known limitation" |
| Build reproducibility | VPS = local |

**Known limitation: browser timing checks on the dev VM.** The gated Virtual HQ suites failed frame-cadence and drag-pan
timing checks on this run and on reruns:
- 25 and 50 Agents: 3D cadence 20 and 9 fps against a minimum of 20;
- 1440×900 pan;
- medium cadence.

The load average was 5–7.6, with Firefox and the desktop running on the VM. These are not product changes. `git diff
057ff64 94f09a7` touches no UI or backend source and none of those tests or their fixtures. The same code passed them at
`057ff64`. This release deploys no UI. Re-run them on an idle machine before the UI root promotion.

## Rehearsals on a copy of production (2026-10-07, VPS, production untouched)

- **Backup before the rehearsals:**
  - `~/automaton_fleet-v41-r37-pre-rehearsal-20261007T111657Z.dump`;
  - sha256 `13a22d7a8fef89743f5f9230e630896085263db4784a43b1b66c18098d5adc37`;
  - 5,663,756 bytes; PostgreSQL 16.15; 167 tables;
  - `pg_restore --list` readable.
- **`fleet-rollout.sh rehearse ~/r37-pins.txt 41 42` PASSED** (`r37-rollout-rehearsal.txt`, `r37-rehearsal-reconcile.json`):
  - restore row counts identical;
  - migrate-check would apply `[42]` only;
  - reconciliation OK: 5 new accounts at zero, 503 journals, events preserved;
  - ledger verify true;
  - a re-run applies nothing;
  - the dump restores to 41 with the same ledger head.
- **`fleet-upgrade-rehearsal.sh ~/r37-pins.txt 41 42` PASSED** (`r37-upgrade-rehearsal.txt`):
  1. The copy migrated to 42; the candidate was approved in the throwaway registry only.
  2. The current release 29cde7d **refuses** schema 42 (`schema version 42 != 41`). Rollback is therefore class B:
     restore the database, then the release.
  3. The candidate controller (readyz: all checks ok), Operator API (readyz 200) and dashboard ran on 42.
     - Dashboard: login 200, preview 200, and 401 for a read or a call without a session.
     - The `projects` read returns 0 projects, an all-zero summary, and nothing invented.
     - Ledger unchanged, no reservation and no birth.
  4. The cutover's exact rollback (`DROP SCHEMA fleet CASCADE` plus `pg_restore`) gives schema 41 and an identical ledger
     head.
  5. 29cde7d's controller and dashboard start again on the restored schema.
- **Founder runtime upgrade rehearsal** (`fleet-founders.sh upgrade-rehearsal b949b1c…`, after the cutover; synthetic
  founder, throwaway registry) PASSED:
  - production invariants unchanged;
  - host clean;
  - Founder 1 untouched (same PID).

## Production cutover, 2026-10-07 (owner-run; Claude Code's classifier blocks production deploys)

`bash ~/automaton-fleet-build/scripts/fleet-rollout.sh cutover ~/r37-pins.txt 41 42` (`r37-cutover.txt`):
- **Outage:** 12:26:25Z → 12:26:45Z, 20 s. Migration 42 was applied at 12:26:30Z.
- **Definitive rollback snapshot:**
  - `~/automaton_fleet-v41-pre-v42-20261007T122626Z.dump`;
  - sha256 `c81a560a506986ef989fe70e8fed0d14f4e8a076189d9156fa5d5baf733cdb9a`;
  - 5,669,482 bytes;
  - verified with `sha256sum -c` before the migration.
- **Reconciliation of the stopped database** (`r37-cutover-reconcile.json`): **OK**.
  - Migrations applied: `[42]`.
  - Ledger head `540 / 1d3e56f7…` unchanged; 503 journals, 1006 postings; debits = credits = 20,875 cents.
  - Every existing account balance unchanged.
  - 5 new project / distribution accounts for Founder 1, all at 0.
  - Agents, population (1), cap (2) and mode (DEVELOPMENT) unchanged.
  - Founder 1's economics and computed sweep unchanged (basis 0, amount 0).
  - Treasury ledger, external transactions, owner distributions, payment orders, custody transfers and capital requests
    unchanged.
  - Existing events byte-identical. The only appended events are the migrator's 6 role-grant audit records.
  - Notifications unchanged (6, 1 acknowledged).
  - 0 projects and 0 sweep records.
- **The migrator re-run** applied nothing.
- **Services and checks after the restart:**
  - privilege audit, runtime approval and `verify-runtime` passed;
  - readyz 200;
  - the Operator API, custody, fetcher socket, chatgpt-adapter socket, dashboard and identity broker restarted;
  - ledger verify ok, flags false, cap and population unchanged;
  - `fleet:doctor`: DEPLOYMENT OK, SAFE FOR DRY RUN YES;
  - SAFE FOR REAL REPLICATION NO (3 blockers) and SAFE FOR REAL PAYMENTS NO (1 blocker), both as before.

### Verified after the cutover (read-only)

- **Release state:**
  - `current` → `releases/94f09a7…`;
  - `runtime.env` pins 94f09a7 / da053d1c… / 1df54e35…;
  - the registry approves the same;
  - Operator API: `pinnedMatchesApproved` and `operatorReleaseMatchesApproved` both true; schema 42.
- **Fleet:** cap 2, living 1, reserved 0, quarantined 0, DEVELOPMENT, replication disabled.
  - `REAL_PAYMENTS_ENABLED`, `OWNER_SWEEP_ENABLED`, `REAL_REPLICATION_ENABLED` and `FLEET_DRY_RUN_CHILD` are all **false**.
- **Services:**
  - **New PIDs, 0 restarts:** controller 560298, Operator API 560321, dashboard 560324, identity 560325, custody 560320,
    fetcher 560783 (socket-activated at 12:26:50Z).
  - **Unchanged:** Founder 1 349284, edge 418413, tunnel 112530, PostgreSQL 238867, Redis 547255.
    - Redis restarted at 06:25Z, before this stage. An unattended security upgrade of `redis-server` caused it.
- **Health:** readyz 200, Operator API readyz 200, dashboard 200, Redis PONG, PostgreSQL accepting.
- **Founder 1:**
  - still runtime b949b1c, same process;
  - heartbeat fresh (12:26:56Z, then continuous);
  - re-opened its session after the controller restart: two `api_auth_failed` heartbeats at 12:26:49Z, the routine
    reconnect (90 such events in the previous 7 days).
- **Live comparison with the pre-cutover snapshot** (`r37-post-cutover-live-reconcile.json`). The only differences are:
  - the approved runtime commit and its `runtime_approved` event (expected);
  - the reconnect events;
  - Founder 1's own `inference_charge` journals 541–543 (12:27–12:32Z): 3 + 4 + 1 cents, agent cash → agent expense.
    These are a genuine cost, never revenue, profit, tax or a sweep.

  Every balance existing at the snapshot was unchanged. Treasury accounts were 0 → 0, owner capital −10,000 → −10,000,
  Founder 1 cash 9,125 → 9,125 at the cut.
- **v42 reads on production:**
  - `fleet_admin_projects` gives 0 projects and an all-zero summary;
  - all project and sweep-record tables are empty;
  - `dash_call` serves the `projects` read, so the preview's project panels are no longer "unavailable".
- **UI:**
  - The root page hash `8c125f1b…` is unchanged (UI 0.3.0).
  - The preview `/hq-preview/` serves the "V2.4.1 · UI 0.8.1" badge.
  - Static dir `/opt/automaton-fleet/ui/0.3.0+hq-preview-0.8.1` (unchanged).
  - A session-less read returns 401.

**Observation (not caused by this release).** Founder 1 posted no inference charge from 2026-10-02 10:45Z until the
controller restart, and resumed at 12:27Z. The R36 restart on 10-03 did not produce the same resumption. Follow it in the
stability observation and the Founder runtime upgrade.

## Rollback (proven in the rehearsal)

29cde7d cannot run on schema 42. Rollback restores the database:
1. Stop the controller-side units, the dashboard and the identity broker.
2. `DROP SCHEMA fleet CASCADE` on `automaton_fleet`, then
   `pg_restore -d automaton_fleet ~/automaton_fleet-v41-pre-v42-20261007T122626Z.dump`.
3. `cp -p /etc/automaton-fleet/runtime.env.pre-94f09a7 /etc/automaton-fleet/runtime.env`.
4. Point `current` → `releases/29cde7d6d938fd489c76edc531f7c932aefc459f`.
5. Start the controller, then the Operator API, custody, fetcher socket, chatgpt-adapter socket, dashboard and identity
   broker.

This is exactly what `fleet-rollout.sh`'s automatic rollback does. Activity after the cutover would be lost, so reconcile
first: from 12:26:45Z on, that is Founder 1's own inference charges.
