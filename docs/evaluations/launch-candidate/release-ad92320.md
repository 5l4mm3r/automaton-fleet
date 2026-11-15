# Release ad92320 — schema 62 → 63 + UI 0.14.0 (mail housekeeping)

Status: **DEPLOYED 2026-10-10 23:52:28Z** (owner-run; rehearsed 23:42:46Z).

## Contents
- **Schema v63:**
  - Mail dismiss / restore.
  - Permanent delete of the fleet's stored mail: an ordinary owner write, confirmed in the page, no step-up (owner
    decision 2026-10-11).
  - Keep rules: mail that delivered an order, mail still being sent, and unconsumed verification codes under 24 h.
  - Automatic clearing inside the hourly retention pass: dismissed and unassigned mail after 30 days, verification codes
    after 7 days.
  - The `mail_summary` read; `mail_deleted` (permanent, counts only) → P3_SUMMARY.
  - See `src/fleet/postgres/migrations-phase63.ts`.
- **Identity broker:** a sealed provider login that cannot start its provider is refused with its reason and the
  running provider is kept; a usable login replaces the running provider without a restart.
- **UI 0.14.0:** Mail page selection, Dismiss / Restore, Delete permanently with an in-page confirmation, and the
  stored total.

## Pins (from the VPS build output, `~/rlc63/build.log`; an independent local build is identical)
```
FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
FLEET_RUNTIME_COMMIT=ad92320179b9740c2186993bbad100aed028c11d
FLEET_RUNTIME_BUILD_ID=0b79500a895e15028d59408684453823081cdedef3d2e97d88384cda805cefa4
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
```
- Dashboard: `~/rlc63/ui-0.14.0-ad92320.tgz`, sha256 `91599da2c4475cc73c320dbfd31f8efbbfcd6237bf844348566e00be31dd4abe`;
  two builds byte-identical (tree `0634ab3a…a258`).
- Scripts in `~/rlc63/` are unchanged since f852888: `fleet-release.sh` fe43b2dd…, `fleet-rollout.sh` 5e007b46…,
  `fleet-ui-deploy.sh` 5bef3755….

## Validation
- New tests: v63 PG 4/4 and identity 2/2.
- Affected suites: comms (shared, pg, adapters), event routing / history, codex contract / mapping, conversations v62,
  completion v51, static audit, migration paths and identity vault — 101/101 across 14 files. The only change to an
  existing test is the retention assertion, extended for the new `mailCleared` / `mailFreedBytes` fields.
- Dashboard: unit + contract 23/23, simulation tests; real Chrome against the live 0.14.0 export (e2e) 14/14 with 0 CSP
  violations.
- `tsc` and lint are clean (backend and dashboard).

## Rehearsal (2026-10-10 23:42:46Z; `bash ~/rlc63/fleet-rollout.sh rehearse ~/rlc63/pins.txt 62 63`)
- Dump `automaton_fleet-v62-rollout-ad92320-20261010T234230Z.dump` (sha `441e3a17…`); restore row counts identical.
- `migrate-check` wouldApply [63]; health check on schema 63.
- Reconciliation OK: 805 journals; 1805 events preserved; role-grant copies only.
- Ledger verifies; re-run no-op; rollback proof back to 62 with the same ledger head.
- Cut over before 2026-10-11 23:42:46Z, or re-rehearse.

## Cutover (owner go; ~45 s controller outage; agents stay paused; Proton Bridge unit untouched)
```
bash ~/rlc63/fleet-release.sh ~/rlc63/pins.txt 62 63 0.14.0 ~/rlc63/ui-0.14.0-ad92320.tgz 91599da2c4475cc73c320dbfd31f8efbbfcd6237bf844348566e00be31dd4abe
```
- Expected first retention pass (within an hour): stored verification-code mails older than 7 days are cleared (all
  unassigned PayPal / Proton messages; none belongs to an agent).
- Rollback:
  - UI: `dashboard.env.pre-0.14.0`.
  - Backend: `bash ~/rlc63/fleet-rollout.sh revert ~/rlc63/pins.txt 62 63 <reason>`, using the cutover's verified
    pre-migration dump.

## Deployment (2026-10-10, owner-run `fleet-release.sh`)
- Cutover from f852888.
  - Outage 23:51:36Z → 23:52:18Z (42 s).
  - Pre-migration dump `automaton_fleet-v62-pre-v63-20261010T235156Z.dump` (sha `8659918e…`).
  - Reconciliation OK: 1807 events preserved.
  - Rollback point: `runtime.env.pre-ad92320`, `releases/f852888`.
- UI 0.14.0 at 23:52:28Z; one `production_deployed`.
- Post-checks:
  - Operator API: runtime ad92320 / build 0b79500a…, schema 63, all four safety switches false, readiness green.
  - Lifecycle: 2 active, 0 held or stale.
  - Live `/` and `/login/` are byte-identical to the build.
  - Services active: controller, identity, dashboard, custody, browser, Proton Bridge.
  - The ledger verifies.
  - Mail `fleet.treasury@proton.me` active (re-registered 23:52:27Z).
  - Both agents still paused; PayPal rail active.
  - The first retention pass ran at start: stored mail went 28 → 24, verification codes 5 → 2 (older than 7 days;
    all unassigned).
- Next on the owner's word: resume the agents, rail assignment, funding.
