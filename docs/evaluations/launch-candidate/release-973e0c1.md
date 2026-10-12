# Release 973e0c1 — schema 63 → 65 + UI 0.16.0 (consolidated: O19 spending review, v65 completion, Charter v6, Field Guide v2)

Status: **DEPLOYED 2026-10-12 14:20:53Z** (rehearsed 14:16:20Z; outage 14:19:57–14:20:41Z, 44 s). Supersedes the 9b62ef1 package (`~/rlc64`, not deployed).
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

## Deployment (2026-10-12 14:19:06–14:20:53Z, owner go)
- Pre-migration dump `~/automaton_fleet-v63-pre-v65-20261012T142018Z.dump` (sha `4688be81…`); migrate 63 → 65; reconciliation
  OK (2311 events preserved); readyz 200; UI 0.16.0 at root (52 files); one `production_deployed` event.
- Post-checks: schema 65; runtime 973e0c1 / build 77284506…; all four safety flags false; cap 2, DEVELOPMENT, replication
  off; controller, dashboard, identity, browser and custody units active; both agents alive and **still paused** on f852888.
- First Fleet Control lesson review ran at 14:20:52Z: the 3 waiting proposals were rejected with reasons (single anecdotes,
  an owner request rather than knowledge, overlap with the library); cost 6176 (knowledge_review_charge, treasury overhead).
- Rollback point: `runtime.env.pre-973e0c1`, `releases/ad92320`, the dump above; UI `dashboard.env.pre-0.16.0`.

## Agents' runtime upgrade f852888 → 973e0c1 (2026-10-12, owner-authorised): DONE, both still paused
- Rehearsal `fleet-founders.sh upgrade-rehearsal f852888…` (throwaway registry, fake provider), 14:25–14:36Z: **pass, 27/27**,
  including "R41.1 / v6": the upgraded founder was served founder-v6 (8 v6 / 0 v4 routed steps), `field_guide` and
  `field_journal` ran, journal written, wake condition declared; rollback after v6 use kept the journal; re-upgrade verified;
  no credential in logs or records. The three `ok: false` lines in the log are the deliberate mis-pinned-runtime case
  (fails closed, rolled back). Production unchanged; living founders untouched.
- Agent-2 (`01M4C4NXT786Q4E9725N5A15KV`): preflight ok (13 state files); `upgrade-runtime` **verified**, upgrade
  `4352d6e9-7c57-465f-b927-81498d4a71fc`; pid 757524 → 852468, same uid 62577; downtime 2,022 ms; 1 challenge passed;
  state identical.
- Agent-1 (`01M3F50SH7PNX2E3GST13J52AS`): preflight ok (26 state files); `upgrade-runtime` **verified**, upgrade
  `48dbdb79-73cc-49df-94bb-895036af38ea`; pid 757816 → 852716, same uid 65037; downtime 2,022 ms; 1 challenge passed;
  state identical.
- Preservation (baseline 14:25:07Z vs 14:38Z): identity hashes, ledger fingerprints and cash (8,641 / 9,536) identical;
  ledger verifies; 806 journals, none posted since the baseline; one registry credential each; memory (facts, goals,
  decisions, continuity, mind log) and workspace files carried byte-identical (backups exclude the credential). Neither
  agent has written a field journal yet (awaits live activity).
- Compatibility: the release tree carries `dist/fleet/founder/doctrine-v6.js`, `mind.js` asks for founder-v6 and the guide
  is survival-field-guide-v2.0, so the controller serves Charter v6 with toolset-2 (`spend_reviews`, `field_guide all`).
- After: both paused, 0 in flight, no AI call since 10-10; AI budgets unchanged (754 / 3000 pence a day; no new caps);
  survival protection on; custody execution off; cap 2/2 DEVELOPMENT; all safety flags unchanged. Events: upgrade
  prepared / committed / verified ×2, session_opened ×2.
- Lesson-review charge (14:20:52Z): 3 reviews, 464,800 + 431,400 + 434,000 = 1,330,200 USD microcents = **US$0.0133**;
  at the recorded USD→GBP rate = 1,006,176 GBP microcents = 1.006p, of which **£0.01 posted** (D `fleet:expense` /
  C `fleet:treasury:unallocated`) and 0.006p carried in the accrual until it reaches a whole penny.
