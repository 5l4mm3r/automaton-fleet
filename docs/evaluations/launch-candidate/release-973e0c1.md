# Release 973e0c1 — schema 63 → 65 + UI 0.16.0 (consolidated: O19 spending review, v65 completion, Charter v6, Field Guide v2)

Status: **rehearsed, not deployed** (2026-10-12 14:16:20Z). Supersedes the 9b62ef1 package (`~/rlc64`, not deployed).
Checklist: `launch-checklist-v65.md`.

## Pins (VPS build `~/rlc65/build.log`; an independent local build is identical)
```
FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
FLEET_RUNTIME_COMMIT=973e0c117da29c90d5dd2648fac09c9c508d326b
FLEET_RUNTIME_BUILD_ID=77284506a0d34a737719df35a940715fe21a97f0cff540ef5692e04b48a39861
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
```
- UI package `~/rlc65/ui-0.16.0-973e0c1.tgz`, sha256 `b7db72fc2d077f728e57b6c43436b437e81367bbfa058f2e1a32dd2c318d2521`
  (two builds byte-identical; tree `c2ac7f02…a673`; verified on the VPS after transfer).
- Scripts unchanged: `fleet-release.sh` fe43b2dd…, `fleet-rollout.sh` 5e007b46…, `fleet-ui-deploy.sh` 5bef3755….
- The `doctrine-v6` marker is in the commit, so the installed tree attests founder-v6 to upgraded runtimes.

## Validation
51 targeted files, 531/534. The 3 failures are pre-existing and identical on 5cebd3f (engine-pg estate + notifications;
f2a-pg structural proof listing the two v62 readers). Dashboard simulation, live build, `tsc` and lint clean.

## Rehearsal (2026-10-12 14:15:55–14:16:20Z) — PASSED
- Dump `automaton_fleet-v63-rollout-973e0c1-20261012T141559Z.dump` (sha `6440b5f3…`); restore row counts identical.
- wouldApply [64, 65]; health check on schema 65; reconciliation OK (805 journals; 2309 events preserved); ledger verifies;
  re-run is a no-op; rollback proof back to 63 with the same ledger head.
- Cut over before 2026-10-13 14:16:20Z, or rehearse again.

## Production state the release touches (read-only, 2026-10-12 ~14:17Z)
- 3 knowledge proposals waiting (the first Fleet Control review pass will decide them; treasury-paid).
- 0 card requests; 0 reserved / executing payment orders; custody execution off; `REAL_PAYMENTS_ENABLED` false.
- Both agents alive and paused on f852888 (founder-v5): after the cutover they are served toolset-1 (no `spend_reviews`,
  no `field_guide all`) until their runtime upgrade.

## Cutover (owner go; ~45 s controller outage; agents stay paused)
```
bash ~/rlc65/fleet-release.sh ~/rlc65/pins.txt 63 65 0.16.0 ~/rlc65/ui-0.16.0-973e0c1.tgz b7db72fc2d077f728e57b6c43436b437e81367bbfa058f2e1a32dd2c318d2521
```
- Rollback: UI `dashboard.env.pre-0.16.0`; backend `bash ~/rlc65/fleet-rollout.sh revert ~/rlc65/pins.txt 63 65 <reason>`.
  v64 and v65 only add — prefer fixing forward; never revert once real money or provider data exists.
- Charter v6, toolset-2 and Field Guide v2 reach the agents only through the founder runtime upgrade (checklist step 2).
