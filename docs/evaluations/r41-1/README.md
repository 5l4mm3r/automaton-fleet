# R41.1: survival instinct and blocked-action continuation, completed and PREPARED (not deployed)

**Candidate**
- Commit `92c691c6850ea1b90d30922a2ac7dae6689c395a`
- Build `3de3d329329f2e479aed942da0f6823d1c49a1a4e64a955ed10ed0367dfa84b7`
- Lockfile `1df54e35…` (unchanged)
- **Schema:** 45. The rehearsal's `migrate-check` reports `wouldApply: []`.
- **UI:** no change (0.8.4).

**Design and acceptance:** `docs/design/r41-1/README.md` and `docs/design/r41-1/acceptance-matrix.md`. The 13 original
cases are recovered verbatim; supplemental checks S1–S12 are added.

**Tests:** targeted; no full suite.
- **Touched-module suites:** 31 files, 535 of 540 at the last full pass. After fixing 3 tests to the clarified rule,
  every touched suite passes except the 2 pre-existing failures.
- **`pnpm test:security`:** 48 files, 1,378 passed, 1 skipped, 1 failed.
- **`pnpm test:financial`:** 31 files, 753 passed, 1 skipped, 1 failed.
- **The failures:** the only failing tests are the pre-existing F2 static audit and own-capital (1, 2, 5) audit. They
  fail on the unchanged code too, and flag the v44 event-type name `payment_order_awaiting_owner` (a false positive
  from R39).
- **Real-process upgrade rehearsals, local:** real founder processes, the real gateway and the fake Messages API.
  - Run from `eea1932`, `94f09a7` (Founder 1's release) and `136c4bd` (Agent 2's release).
  - All passed: upgrade, rollback, re-upgrade and routed cognition, with identity, memory, workspace and books
    preserved.
  - The new check also passed: the founder was served founder-v5 on every routed step, the field guide and journal
    dispatched end to end, and the hibernation was declared.

**Production copy (2026-10-08 00:18Z):**
- **`fleet-rollout.sh rehearse 45 45`:** PASSED.
- **`fleet-upgrade-rehearsal.sh 45 45`:** PASSED.
  - Candidate services ready.
  - Fleet Command 49 rows, all P0–P3.
  - History 553 = 88 + 108 + 357, with 0 hidden-permanent rows.
  - Rollback restore and the previous release both proven.

**Not yet run:** the on-host systemd founder upgrade rehearsal (`fleet-founders.sh upgrade-rehearsal`). It needs the
candidate installed as the pinned release, so it can only run after the controller cutover.
