# R41.1: survival instinct and blocked-action continuation, PREPARED (not deployed)

**Candidate**
- Commit `ae84c5bfa043149027bf0f72f9a6b0836c05fef3`
- Build `66384fd964cc70f05dd34f4801ecae13e5307fb5aecc2a581f44d4287b860e50`
- Lockfile `1df54e35…` (unchanged)
- Schema 45 (unchanged)
- No UI change (0.8.4)

**Design:** `docs/design/r41-1/README.md`, from the owner's Birth Charter & Survival Field Guide v1.2.

**Targeted tests:** 31 suites touching the changed modules, 528 of 530 passing.
- The 2 failures already fail on the unchanged code: the F2 static audit and the own-capital v27 audit. Both flag the
  v44 event-type name `payment_order_awaiting_owner` in the routing table (released in R39). That is a false positive,
  unrelated to R41.1.
- **New:** `fleet-r41-1-continuation.test.ts`, 15 tests.
- **Gateway:** the doctrine test in `fleet-cognition-routing.test.ts`.
- **Updated to R41.1 semantics:** f2a-autonomy, f2a-pg, live-01, live-01-pg, cognition (`set_goal` output kept), and
  the routed rehearsal model (it completes its goals before resting).

**Rehearsals: all passed.**
- **Founder runtime upgrade, local, real founder processes, 136c4bd → candidate:** upgrade, rollback, re-upgrade and
  routed cognition kept the same founder (identity, memory, workspace, books).
- **Fresh production copy (23:37Z):** `fleet-rollout.sh rehearse 45 45` and `fleet-upgrade-rehearsal.sh 45 45`.
  - No migration to apply; reconciliation OK.
  - Candidate controller, Operator API and dashboard ready.
  - Fleet Command 49 rows, all P0–P3.
  - History check: 542 = 88 + 97 + 357, with 0 hidden-permanent rows and 0 copies past retention.
  - Rollback restore and the previous release both proven.
