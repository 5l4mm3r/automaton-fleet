# Release e78ec63 (schema 94 → 95; UI 0.26.2 unchanged) — SUPERSEDED by e1c51e2 (built and rehearsed; never deployed; ~/rlc102 not to be run)

The consolidated package after measured attempt 2 and launch-readiness blocker #19. It contains 995388c's fixes
(validated, not deployed on their own by the owner's decision) and the durable-operations repair. No new feature
scope. Installing it, resuming an agent and any paid run are separate owner decisions.

## What it contains (from 32634bf, the running release)
1. **9f02351, 74e9038, 995388c** — as recorded in release-995388c.md: the repeated-failure cap; a waiting founder
   wakes once on a new runtime (repeat blocks reset, authority unchanged); release scripts log through teelog; the
   versioned measured-attempt script with intended-offer success.
2. **039c0b9 — schema v95, durable operations** (docs/design/durable-operations.md).
   - Every consequential operation is recorded before dispatch, in the same transaction as its effect, under a durable
     identity: agent, kind, business subject, ordinal.
   - A repeat returns the existing result. A new operation names the latest on its subject (`after`). Replies are
     anchored to the message they answer; browser steps continue within a live session.
   - Lost answers are uncertain and are reconciled, never repeated blindly: payouts recorded before PayPal is called;
     refunds retried with the same request id, a refused retry held; mail reconciled from the Proton Sent folder;
     GitHub proposals adopt their own PR or branch; channel, browser and SMS outcomes resolved from the agent's
     recorded observation.
   - One card fill per field per hold.
3. **c76d7e0** — request bodies and stdin decoded as UTF-8 streams (the fake providers and two eval readers corrupted a
   character split across chunks; found by the founder rehearsal's intermittent cache check).

## Evidence
| | |
|---|---|
| Commit | e78ec63814399bc90994e65d420ec84500f67fd8 (pushed to fleet-origin fleet/final-v2.5) |
| Build ID | d4f6e05d70984094bff03499498f47496d1df62012888c4c97dbdfac81c17d48 (VPS = local, both at e78ec63 exactly); lockfile 1df54e35… unchanged |
| Tests (targeted) | Typecheck clean. 44 affected PostgreSQL suites pass on the final code (341 tests; 16 skipped by their own conditions), including fleet-v95-durable-operations-pg (12) with real dispatch counts. Non-database suites for the changed modules pass (fleet-research passed alone; it failed once under CPU contention). Founder upgrade rehearsal with real processes 12/12 six runs in a row |
| Full founder rehearsal (real processes, local) from 32634bf | PASSED (11/11; the eea1932-only check skipped) |
| Data rehearsal 94 → 95 (VPS) | PASSED 2026-10-18 21:46:55Z: migrate-check applies exactly [95] and rolls back; reconciliation OK (921 journals, 3178 events preserved); ledger verifies; re-run a no-op; the pre-migration dump restores schema 94 with the same ledger head. Live untouched |
| Services rehearsal 94 → 95 (VPS) | PASSED 2026-10-18 22:41:38Z: the running 32634bf refuses schema 95 (so a rollback restores the database); the candidate controller, Operator API and dashboard are ready on schema 95; ledger verifies with the head unchanged and no reservation or birth; the rollback restores schema 94 with an identical ledger head and 32634bf runs again. Production untouched |

## Before approval, the owner should know
- The register changes how a further operation is asked for. The same request again is answered from the record. A
  different operation on a subject that already has one needs `after` = the latest operation id (results and refusals
  name it). Examples: a second refund on an order, a second order to one vendor, a second listing on one channel.
  This costs at most one extra tool call when the agent omits it. Replies and the steps of one browser session need
  no `after`.
- After the upgrade, Agent-1's first resume costs one turn (the runtime-upgrade line).
- Nothing activates money or outward actions: sales, custody, card authority and outward releases stay as they are
  (all closed), and both agents stay paused.

## Install (owner-run, on approval; ends with BOTH AGENTS PAUSED; no paid work)
- `ssh -t agentfleet-vps 'bash ~/rlc102/install-fix.sh'`.
  - The same evidence gate, guards and continuation as 32634bf: both rehearsals of THIS commit passed less than 24 h
    ago, the UI checksum, both agents paused, permissions closed, the four safety flags false.
  - Steps: release 94 → 95 (fleet-release.sh), records equal the baseline, the founder upgrade rehearsal from 32634bf
    on the host, then the Agent-1 preflight and runtime upgrade (rollback id recorded). Agent-2 is untouched (b60e262).
  - The log is complete when it returns.
- Then `ssh -t agentfleet-vps 'bash ~/rlc102/verify-install.sh'`. Read-only; it checks schema 95, the register and its
  guard, the dispatcher's and the spend API's recording, the card-fill index, the payout write-ahead, mail
  reconciliation and pull-request adoption in the installed build.
- The rehearsals are valid for 24 h (until 2026-10-19 21:46Z); after that, rehearse again.
