# Release e1c51e2 (schema 94 → 95; UI 0.26.2 unchanged) — DEPLOYED 2026-10-19 00:56:08Z; Agent-1 upgraded; verified

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
3. **e1c51e2 — the owner's four gaps closed** (supersedes e78ec63, which was built and rehearsed but not deployed):
   a send with no Sent copy is never resent automatically (uncertain; a late copy resolves it; the owner is asked once
   after 30 minutes); every browser submission is compare-and-set in a live session too (navigation and typing carry
   none); resolving an uncertain outcome takes evidence (the agent: only "happened", from a recorded observation
   showing a marker the submission carried; "not happened": only the owner, stating what they checked —
   `fleet operation-resolve`, `fleet operations-uncertain`); an uncertain message blocks its address; code proposals
   are never failed after lost answers. Envelope spending tested end to end (one PayPal payout per order).
4. **c76d7e0** — request bodies and stdin decoded as UTF-8 streams (the fake providers and two eval readers corrupted a
   character split across chunks; found by the founder rehearsal's intermittent cache check).

## Evidence
| | |
|---|---|
| Commit | e1c51e28a70a6d482887f32838524dec1885e71b (pushed to fleet-origin fleet/final-v2.5) |
| Build ID | 8c6042d9db9ee0b0bb522771a713bf130636827c53705b6590562d6fdfca03b7 (VPS = local, both at e1c51e2 exactly); lockfile 1df54e35… unchanged |
| Tests (targeted) | Typecheck clean. 44 affected PostgreSQL suites pass on the final code, including fleet-v95-durable-operations-pg (13: late and missing Sent copies, owner resolution, the cross-address block, the browser evidence rules, strict in-session submissions) and the custody envelope test (one payout per order); 97 unit tests in the touched modules; founder upgrade rehearsal with real processes 3/3 |
| Full founder rehearsal (real processes, local) from 32634bf | PASSED (11/11; the eea1932-only check skipped) |
| Data rehearsal 94 → 95 (VPS) | PASSED 2026-10-18 23:27:29Z (migrate-check applies exactly [95] and rolls back; reconciliation OK; ledger verifies; re-run a no-op; the dump restores schema 94 with the same ledger head). Live untouched |
| Services rehearsal 94 → 95 (VPS) | PASSED 2026-10-19 00:41:34Z: the running 32634bf refuses schema 95 (so a rollback restores the database); the candidate controller, Operator API and dashboard are ready on schema 95; ledger verifies with the head unchanged and no reservation or birth; the rollback restores schema 94 with an identical ledger head and 32634bf runs again. Production untouched |

## Before approval, the owner should know
- What `after` costs: nothing when the agent passes it from the previous result (every result carries it); about
  2p when it omits it (one refused call — no model call — and one repeated model step in the same turn; attempt 2's
  in-turn steps cost 1–3p). It arises only for a further operation on a subject that already has one.
- The register changes how a further operation is asked for. The same request again is answered from the record. A
  different operation on a subject that already has one needs `after` = the latest operation id (results and refusals
  name it). Examples: a second refund on an order, a second order to one vendor, a second listing on one channel.
  This costs at most one extra tool call when the agent omits it. Replies and the steps of one browser session need
  no `after`.
- After the upgrade, Agent-1's first resume costs one turn (the runtime-upgrade line).
- Nothing activates money or outward actions: sales, custody, card authority and outward releases stay as they are
  (all closed), and both agents stay paused.

## Install (owner-run, on approval; ends with BOTH AGENTS PAUSED; no paid work)
- `ssh -t agentfleet-vps 'bash ~/rlc103/install-fix.sh'`.
  - The same evidence gate, guards and continuation as 32634bf: both rehearsals of THIS commit passed less than 24 h
    ago, the UI checksum, both agents paused, permissions closed, the four safety flags false.
  - Steps: release 94 → 95 (fleet-release.sh), records equal the baseline, the founder upgrade rehearsal from 32634bf
    on the host, then the Agent-1 preflight and runtime upgrade (rollback id recorded). Agent-2 is untouched (b60e262).
  - The log is complete when it returns.
- Then `ssh -t agentfleet-vps 'bash ~/rlc103/verify-install.sh'`. Read-only; it checks schema 95, the register and its
  guard, the dispatcher's and the spend API's recording, the card-fill index, the payout write-ahead, mail
  reconciliation and pull-request adoption in the installed build.
- The rehearsals are valid for 24 h (until 2026-10-19 23:27Z); after that, rehearse again.

## Installed (owner approval 2026-10-19; owner-run)
| | |
|---|---|
| Install | `~/rlc103/install-fix.sh`, 00:54:24–01:06:52Z: evidence gate and guards passed (both rehearsals of e1c51e2 < 24 h; both agents paused; outward releases 0, card authority off, no custody activation; safety flags false); baseline `~/rlc91/baseline-pre-e1c51e2-005424-20261019T005424Z` (5028 dump entries) |
| Release 94 → 95 | outage 00:55:16–00:56:01Z (45 s); cutover reconciliation OK (3180 events preserved); readyz 200 on schema 95; `production_deployed` recorded; root UI 0.26.2 |
| Records | ledger = baseline; pauses and fuses = baseline |
| Agent-1 | founder upgrade rehearsal on the host 27/27 (living founders untouched); preflight ok; runtime 32634bf → e1c51e2, upgrade **4b0b5421-c399-4f25-9ac4-0346ff588d88** (rollback: `sudo /opt/automaton-fleet/current/scripts/fleet-founders.sh rollback-runtime 01M3F50SH7PNX2E3GST13J52AS 4b0b5421-c399-4f25-9ac4-0346ff588d88 <reason>`) |
| Agent-2 | untouched, b60e262, paused |
| Verify | `~/rlc103/verify-install.sh` (01:2xZ): VERIFIED — the running process works from releases/e1c51e2; every v95 durable-operation check, the attempt-2 corrections, the run-budget gate; both agents paused; nothing open; ledger verifies (921 journals); no model call |
| Operator API | approved = pinned = Operator API release = e1c51e2 / 8c6042d9…; schema 95; four safety flags false; cap 2, DEVELOPMENT, replication off |

## Measured attempt 3 (owner-approved 2026-10-19: 130p ceiling, 70p before, £2 total)
- 01:23:48Z started (`fleet-measured-attempt.sh start 130 70 200`, from the installed release). Agent-1 woke once for the
  runtime-upgrade line: 2 model calls, **15p** ($0.2012; 51,887 input tokens, 0 from the cache, 245 output). This is
  this run's measured cold start, not a fixed price: a later wake costs what its model, input size, output and caching
  make it. The estimate given before the run (a few pence) was wrong: it assumed a cached prefix.
- 01:24Z its note: "Offer live; no orders or enquiries; sales closed fleet-wide. Waiting." No further call, search,
  operation, refusal or outward action.
- 01:54Z the watchdog paused it and ended the run budget with the label "STALLED". **Corrected classification: waiting,
  not a failure.** The intended offer (uk-landlord-compliance-tracker-england-g-a9ddde) was already published on a passing
  review; with sales closed there was no customer work, so the attempt had nothing to produce and should not have
  started. It exposed no work-loop failure.
- Cumulative 85p of the £2 allowance (provisional until matched with Anthropic usage); £1.15 left. Both agents paused.
- Script corrected (next release; the installed copy keeps the old label): `start` refuses when the intended offer is
  already published ("nothing to create … the next useful event is a customer order"); idle beside a published offer while
  waiting is reported as "WAITING, NOT A FAILURE". Tests: fleet-measured-attempt-script 8/8.
- Next: no further product-creation attempt. The purchase proof (launch-readiness §2) is prepared for approval.

