# Release 126723c (schema 101 → 102; UI 0.26.2 unchanged) + Agent-1 runtime d2a2e7a → 126723c — premium work; INSTALLED 2026-10-20 11:21Z

**Why (owner, 2026-10-20, after the purchase proof):** "Opus for delivering customer products or building customer facing
anything"; no new blocks — the agent verifies, revises and refines its own work to premium quality. The proof's record:
all 62 of Agent-1's calls ran on Sonnet (T2) with at most ~220 reasoning tokens; the first tracker shipped without a
passing inspection (the platform's inspector could not run then); the revision fixed only what the buyer reported
(1,194 formulas still without saved values: blank in previews); its reply asked the buyer to check; four calls were lost
to an `after` naming its message instead of the delivery's operation.

## Change (1f44ee9 + 126723c)
- Router: task class `founder_work` (T3, effort high). Every step of a founder's own work is classified founder_work;
  escalated questions stay `agent_step` + escalation (question-scoped, fresh context); standard classes unchanged. T3
  caches its prefix inside tool loops (`prefix`, as T2 did).
- v102: the critical tier's output room 8,000 → 16,000 tokens (same model and prices, stays verified; recorded by the
  migration, `updated_by migration:v102`). An `after` naming no operation of the agent's says it takes an operationId and
  names the latest operation on the subject (or that there is none).
- The instructions every routed step carries: the Fleet's most capable model; the premium standard (finish everything a
  customer receives or sees before it leaves — build, inspect, look at it as the customer will, fix every problem and
  warning affecting the customer, inspect again, refine, review against everything asked, deliver exactly those files;
  published and delivered products held to the same standard, corrections sent to every customer who has them); customer
  conduct (professional; say what was made or corrected and how it was verified; never ask a customer to test).
- Inspector: the unsaved-values warning says how to save them. escalate_question: an independent look in a fresh context.
- No delivery gate added (owner: "do not block anything").

## Evidence
| Item | Result |
|---|---|
| Pins | commit 126723ca12eef9a0eb4e7f1b5f3b51173ed97ce3 · build cee358c9b86cfb770a66c3c6caf33f1071f0ea889c112c73943cf6b9cca5b3a4 · lockfile 1df54e35… — VPS = local |
| Tests | R23 routing (founder_work T3), cognition routing, founder runtime / upgrade (12) / work continuity / step budget, v95 (+v102), v100, revision rehearsal 1–3, f2a autonomy + static audit (founder-facing text lint), qa-inspector-v3, v62 v67 v76 v82 v94 v96 v98 PG — pass. fleet-v68-wake-lessons-pg: 1 pre-existing failure, not fixed |
| Data rehearsal 101 → 102 | first attempt REFUSED by reconciliation (the migration appended a cognition_tier_set event; rollouts append only role grants) → event removed (126723c); PASSED 2026-10-20T04:11:19Z |
| Services rehearsal 101 → 102 | PASSED 2026-10-20T04:11:51Z |
| Install | 10:57–11:21Z: deployed 10:59:27Z (outage 47 s, reconciliation OK); founder upgrade rehearsal from d2a2e7a 27/27 (every founder step on Opus); revision rehearsal 14/14 in real founder units; Agent-1 upgrade 636f08a5-24db-4d4c-9b4a-c5add148b303; verify.sh VERIFIED 11:21:48Z |
| End state | both agents paused; the purchase proof unchanged (run ended 03:47Z by the owner's decision; £5 not refunded) |

## Not yet shown
That Agent-1 on Opus produces premium work unprompted is a hypothesis until a live run shows it. A new paid run is a
separate owner decision with its own terms.
