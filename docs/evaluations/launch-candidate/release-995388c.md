# Release 995388c (code only: schema 94 → 94; UI 0.26.2 unchanged) — VALIDATED, NOT DEPLOYED: superseded by the v95 durable-operations package

One consolidated candidate of the existing fixes after measured attempt 2 (2026-10-18). No new feature scope. Installing
it and authorising any further paid run are separate owner decisions.

## What it contains (from 32634bf, the running release)
1. **9f02351: repeated-failure cap.** An identical call that failed 3 times in a row is refused (`FLEET_REPEATED_FAILURE`)
   even after other successful calls. 32634bf allowed 8 of 8 when an unrelated write sat between failing publishes.
2. **74e9038: a waiting founder notices an upgrade.** Attempt 2's Agent-1 waited through its 32634bf upgrade (which had
   fixed the refusal it was waiting on) until the owner sent a Fleet Control notice by hand.
   - The runtime commit is now recorded with each closing note (`mind-continuity.json` `runtime`).
   - When the commit changes, the founder gets one full turn with a factual line, then waits again. A restart on the same
     runtime still costs nothing.
   - The release scripts `fleet-rollout.sh`, `fleet-upgrade-rehearsal.sh` and `fleet-edge.sh` log through `teelog`, so a
     log is complete when the script returns. The 32634bf install lost its final lines.
3. **995388c: attempt-script and authority corrections.**
   - `scripts/fleet-measured-attempt.sh` is now versioned. It runs from the installed release only and takes the owner's
     terms as `start` arguments.
   - Success means the INTENDED offer: published during the attempt (an `offer_published` event), on a passing review of
     its current files.
   - The upgrade line says only repeat blocks were reset. Permissions, limits and approvals are unchanged and checked on
     every action. Tested: across an upgrade, a carried completed action stays `FLEET_ALREADY_DONE`, a non-grantable tool
     and a controller refusal are still refused.

## Evidence
| | |
|---|---|
| Commit | 995388cabd7c3f53d020988bb50824e2b4f26bbd (pushed to fleet-origin fleet/final-v2.5) |
| Build ID | 7d0c868794d6054ddb9683e5efbfedf3c3501f93734111982090f082d99e7464 (VPS = local, both at 995388c exactly) |
| Lockfile | 1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1 (unchanged) |
| UI | 0.26.2 unchanged (`ui-0.26.2-316b27b.tgz`, sha 77ce19a4…) |
| Tests (targeted) | typecheck clean. Work continuity 12/12 (9: upgrade wake; 10: authority across an upgrade). Retry-after-fix 4/4. Measured-attempt script 7/7 (stubbed host). Release tooling 20/20 (teelog against a slow tee: the old pattern loses the last line, the new one does not). Release script 8/8, edge script 4/4 |
| Full founder rehearsal (real processes, local) | PASSED from eea1932 (12/12) and from 32634bf, Agent-1's runtime (11/11; the eea1932-only check skipped) |
| Data rehearsal 94 → 94 (VPS) | PASSED 2026-10-18 19:43:07Z (921 journals; ledger verifies; re-run a no-op; rollback proof). Live untouched |
| Services rehearsal 94 → 94 (VPS) | PASSED 2026-10-18 20:41:37Z: candidate controller, Operator API and dashboard ready on schema 94; ledger head unchanged; code-only rollback re-approves 32634bf with every candidate-era write kept; production untouched |
| Success rule checked read-only on attempt 2's records | intended slug 1 · other slug 0 · no slug (created during) 0 · attempt-1 window 0 |

## Decision (owner, 2026-10-18)
Not deployed by itself: blocker #19 (durable duplicate protection) is repaired first, and this candidate's fixes ship in
the consolidated next package with it (schema 95). The staged `~/rlc101` installer is not to be run.

## Install (as prepared; NOT to be run — superseded)
- `ssh -t agentfleet-vps 'bash ~/rlc101/install-fix.sh'`.
  - The same evidence gate, guards and continuation as 32634bf: both rehearsals of THIS commit passed less than 24 h ago,
    the UI checksum, both agents paused, permissions closed, safety flags false.
  - Steps: release 94 → 94, records equal the baseline, founder upgrade rehearsal from 32634bf on the host, then the
    Agent-1 preflight and runtime upgrade (its rollback id is recorded).
  - Agent-2 is untouched (b60e262).
- Then `ssh -t agentfleet-vps 'bash ~/rlc101/verify-install.sh'`. Read-only; it also checks each correction in the
  installed build.
- **After the upgrade, Agent-1's first resume costs one turn.** Its continuity record has no runtime yet, so it counts as
  upgraded: it wakes once, is told, then waits again.
- A further measured attempt only on the owner's separate approval:
  `bash /opt/automaton-fleet/current/scripts/fleet-measured-attempt.sh start <ceilingPence> <priorPence> <totalPence> [<offerSlug>]`.

## Remaining gap (reported, not in scope here)
Duplicate protection that survives a founder restart or upgrade is missing for several money and outward actions. See
launch-readiness §1 row 19. It is held closed today (sales closed, custody off, card authority off, no outward release,
both agents paused). It is a blocker before any of those open; it is not a blocker for a private-publishing test.
