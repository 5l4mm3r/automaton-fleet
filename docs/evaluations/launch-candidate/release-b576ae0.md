# Release b576ae0 — the Agent-1 runtime repair (prepared, NOT installed)

Pins: commit b576ae00465673c731c09c1737b61c9149f098e2 · build ae67895c5c9e72f236f5f37db359b6b1b92a2afc30d96dfa4732b046f9114a5c ·
lockfile 1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1 (unchanged). Schema 110 unchanged; UI 0.26.2 unchanged.
Diagnosis: launch-check-2026-10-21.md. Kit: ~/rlc128 (install.sh, verify.sh, pins.txt, logs, evidence files).

## What it changes (Agent-1's runtime)
1. Inspector (label fleet-qa-3, program sha256 27ec2b1d… — was b854830e… in e151095): a formula whose recalculated result is
   empty text, saved empty, is saved correctly. Nonblank formulas saved blank still warn (and still refuse a review / block a
   sale); error values still fail.
2. Continuity: a routed turn stopped by its 40,000-byte request budget is cut off (not finished); its record carries across
   REPEATED stops — earlier calls (oldest results dropped first by the 6,000-character bound), every platform refusal with its
   reason, and the last plan the founder wrote.
3. Traceability: each review's automated record carries inspectorSha256 and the runtime commit and build id.
4. launch-checks: `checks … [mailSince]` counts the owner's mail already received; success needs a REPLY to it (its thread or
   in-reply-to) sent during the run after that mail — a historical reply or an unrelated mail does not count. The watchdog
   stops only its timer from inside its unit (bce4b93), so its stop is confirmed, reported and filed.
5. The revision rehearsal gains phase 5 (repeated size stops) and saves values in its first build (v109 requires them).

## Why the controller-side release moves too
The registry approves one runtime (fleet_state); `upgrade-runtime` refuses any target but it. So b576ae0 is released for the
controller-side units (a restart, ~1 min outage as before) and Agent-1 is upgraded to it. Behaviour of every controller-side
service is unchanged: the built tree differs from e151095 only in fleet/founder/{continuity,mind,qa/inspector,
revision-rehearsal,runtime,toolbox} and fleet/eval/revision-rehearsal-model; the import graph of each service entry
(service, identity, custody, operator, dashboard, browser, channels, fetcher, bankfeed, push, code, build, media,
chatgpt-adapter, hub and postgres CLIs) reaches none of them (~/rlc128/import-graph.txt). Agent-2 stays on b60e262.

## Evidence (VPS, 2026-10-21, before approval; no paid model call; production untouched)
- Built from the pinned commit with the frozen lockfile; staged and verified; installed beside the others (root-owned,
  read-only, `current` still e151095) for the founder rehearsals; the cutover reuses it only if verified identical.
- Data rehearsal 110 → 110 PASSED 12:41:20Z; services rehearsal PASSED 12:41:56Z (previous release e151095 ready on the same data).
- Founder upgrade rehearsal a0bbf4e → b576ae0 (synthetic founder, real unit, throwaway registry, fake provider): 27/27.
- Revision rehearsal (real units, scripted model): 18/18, complete (renderer phase), including phase 5 — 2 size stops in a
  row; the next turn shown the plan, the refusal FLEET_CAPABILITY_CHECK_REQUIRED with its reason and its results; after the
  second stop turn A's plan and refusal and turn B's results; record consumed, 0 model calls while it then waited.
- The exact offer file f45c3d00… through the founder's own inspect path in a private-/tmp unit (office application on):
  e151095's inspector — cached_values warn (1,194 cells), dates pass, rendering 2/2; b576ae0's — recalc, saved values,
  formula errors, displayed errors, displayed dates and rendering (2/2 pages) all pass. A negative workbook (8d878b0a…):
  B2 and C2 (nonblank results saved blank) warn, D2 #DIV/0! fails, the blank-result template cell passes.
- The email reply query, run as written: PostgreSQL test (a pre-run reply and an unrelated mail do not complete; a reply to
  the counted mail during the run does) and read-only on production (no reply exists yet).
- The watchdog stop with b576ae0's script under the real unit name (agent actions and database reads stubbed): stop
  recorded and filed, no VERIFY flag, the service exited normally.

Install: `ssh -t agentfleet-vps 'bash ~/rlc128/install.sh'`, then `bash ~/rlc128/verify.sh`. The rehearsal gate expires 24 h after
12:41Z (re-rehearse after that).

## Rollback
- Agent-1 only (recommended if the repair misbehaves; the controller on b576ae0 behaves as e151095):
  `sudo /opt/automaton-fleet/current/scripts/fleet-founders.sh rollback-runtime 01M3F50SH7PNX2E3GST13J52AS <upgradeId> <reason>`
  (upgradeId in ~/rlc128/agent1-upgrade-id.txt). Restores a0bbf4e (verified on disk, kept by pruning as the rollback target).
- Controller-side, only immediately after a failed step and only after Agent-1's rollback: `bash ~/rlc128/fleet-rollout.sh
  revert ~/rlc128/pins.txt 110 110 <reason>` — restores the cutover's pre-release dump, the previous runtime.env and e151095.
  It discards database writes made after the cutover (mail, events): once real activity exists, fix forward instead.
- A failure during install.sh rolls itself back where the release tooling does (cutover) and otherwise stops with both
  agents paused; re-running continues from the failed step.
