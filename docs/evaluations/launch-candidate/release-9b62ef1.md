# Release 9b62ef1 — schema 63 → 64 + UI 0.15.0 (autonomous spending, O19)

Status: **rehearsed, not deployed** (2026-10-11 12:03:47Z).

## Contents
- **Schema v64.** No caps or owner gates; flags only material or suspicious commitments; automated Fleet Control review
  that holds only on credible evidence; a stalled reviewer never approves; reviews are treasury-paid; revalidation
  immediately before execution. See `docs/design/autonomous-spending-review.md` and spec O19.
- **Controller.** `SpendReviewer` in the reaper loop.
- **UI 0.15.0.** Spend reviews panel (Treasury); Fleet Control notices in agent conversations; optional custody and card
  maxima.

## Pins (VPS build `~/rlc64/build.log`; an independent local build is identical)
```
FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
FLEET_RUNTIME_COMMIT=9b62ef1c343b64cd5f77cc6a1e7cd485f556c332
FLEET_RUNTIME_BUILD_ID=3582215ed9c04885075a060265a48a259ffe13628c5cca56c8d7726c3a3b3d4d
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
```
- UI package `~/rlc64/ui-0.15.0-9b62ef1.tgz`, sha256 `664ca0b9ab67c312b1e88aafc912aac436e96debcfd4d6336129bca2c6e2dd81`. Two
  builds were byte-identical (tree `b2d00838…21d5`).
- Scripts are unchanged: `fleet-release.sh` fe43b2dd…, `fleet-rollout.sh` 5e007b46…, `fleet-ui-deploy.sh` 5bef3755….

## Validation
- `fleet-spend-review-v64-pg` 11/11.
- Affected suites: 33 files, 30 green. The 3 remaining failures are pre-existing and identical on 5cebd3f:
  - engine-pg estate and notifications;
  - the f2a-pg structural proof (v62 readers).
- Tool and capital suites 9 files 95/95; dashboard + contract + real Chrome e2e 37/37 with 0 CSP violations; `tsc` and lint
  clean.

## Rehearsal (2026-10-11 12:03:47Z)
- Dump `automaton_fleet-v63-rollout-9b62ef1-20261011T120328Z.dump` (sha `34cfa266…`); restore row counts identical.
- wouldApply [64]; health check on schema 64; reconciliation OK (805 journals, 1978 events preserved); ledger verifies;
  re-run is a no-op; rollback proof back to 63.
- Cut over before 2026-10-12 12:03:47Z.

## Production state that v64 touches (read 2026-10-11)
- 0 card requests (none waiting on the owner); 0 reserved / executing orders.
- Card authority off; custody execution off.
- Nothing is stranded by retiring the £100 gate, and no money can move after the cutover (custody off, REAL_PAYMENTS
  false).

## Cutover (owner go; ~45 s controller outage; agents stay paused)
```
bash ~/rlc64/fleet-release.sh ~/rlc64/pins.txt 63 64 0.15.0 ~/rlc64/ui-0.15.0-9b62ef1.tgz 664ca0b9ab67c312b1e88aafc912aac436e96debcfd4d6336129bca2c6e2dd81
```
- Rollback:
  - UI: `dashboard.env.pre-0.15.0`.
  - Backend: `bash ~/rlc64/fleet-rollout.sh revert ~/rlc64/pins.txt 63 64 <reason>`.
- The agents' new tool text and the `spend_reviews` op need a founder runtime upgrade afterwards (a separate step).
