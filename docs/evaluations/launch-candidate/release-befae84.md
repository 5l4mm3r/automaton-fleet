# Release befae84 — schema 65 → 66 + UI 0.17.0 (capital backing)

Status: **SUPERSEDED — not to be deployed separately** (owner, 2026-10-12): v66 ships in the coordinated 65 → 68 release. Rehearsed 2026-10-12 15:07:02Z; no money moved.

## Contents
- **Schema v66.** `fleet_admin_capital_back` / `fleet_capital_backing()`: a real PayPal deposit backs the capital recorded
  without money (no second credit; any excess is ordinary owner funding); spec §21.
- **UI 0.17.0.** Treasury → *Capital backing* panel; "My deposit: back the existing capital" on unmatched PayPal money (step-up).

## Pins (VPS build `~/rlc66/build.log`; an independent local build is identical)
```
FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
FLEET_RUNTIME_COMMIT=befae84856877bfd94d7031c1eca6c3a9e9f7c24
FLEET_RUNTIME_BUILD_ID=9be85bb2d60e9b4cfa97ec9226b86cd837a474b7d5ddc1882bec3b0711978176
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
```
- UI package `~/rlc66/ui-0.17.0-befae84.tgz`, sha256 `5c00add080a156b81b96724db311464347eaf88d63c49b52a84da43138fc029a`
  (two builds byte-identical; tree `a0b3c8bf…d358a`; verified on the VPS after transfer).
- Scripts unchanged: `fleet-release.sh` fe43b2dd…, `fleet-rollout.sh` 5e007b46…, `fleet-ui-deploy.sh` 5bef3755….

## Validation (focused; reused, not repeated)
`fleet-v66-capital-backing-pg` 5/5; 15 files 140/140 (event routing, live contract, real-Chrome e2e, PayPal treasury,
receiving test, statements, clawbacks, ledger, static audit, v65, allocation, storefront accounting) after aligning the
stale v58 route expectation with v62 (it failed identically on fba3b26). Dashboard simulation, live build, `tsc`, lint clean.

## Rehearsal (2026-10-12 15:06:39–15:07:02Z) — PASSED
- Dump `automaton_fleet-v65-rollout-befae84-20261012T150643Z.dump` (sha `56c2be5f…`); restore row counts identical.
- wouldApply [66]; health on schema 66; reconciliation OK (806 journals; 2351 events preserved); ledger verifies; re-run
  no-op; rollback proof back to 65 with the same ledger head.
- Cut over before 2026-10-13 15:07:02Z, or rehearse again.

## Backing amount (live, read-only, 2026-10-12 15:06Z — the v66 formula)
Virtual capital 20,000 − provider-paid 1,824 = **unbacked 18,176 (£181.76)**; books 18,243; PayPal 67 (14:20:37Z);
difference 0. No AI call since 2026-10-10 12:19Z. Refresh again immediately before the deposit (the panel shows it live).

## Cutover (owner go; ~45 s controller outage; agents stay paused)
```
bash ~/rlc66/fleet-release.sh ~/rlc66/pins.txt 65 66 0.17.0 ~/rlc66/ui-0.17.0-befae84.tgz 5c00add080a156b81b96724db311464347eaf88d63c49b52a84da43138fc029a
```
- Rollback: UI `dashboard.env.pre-0.17.0`; backend `bash ~/rlc66/fleet-rollout.sh revert ~/rlc66/pins.txt 65 66 <reason>`.
  v66 only adds; once a backing is recorded, fix forward.
- The agents' runtime is unaffected (controller-only change); no founder upgrade is needed.
