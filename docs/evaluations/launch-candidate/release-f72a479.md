# Release f72a479 (schema 93 → 94; UI 0.26.0 → 0.26.2) — install ends with both agents paused

Production before it: 1743b33, schema 93, UI 0.26.0. It supersedes 316b27b and 71efd95, neither of which was installed.
Scope: the execution and cost-control repair of the owner's handoff of 2026-10-18. Cost evidence:
cost-comparison-2026-10-18.md.

## Acceptance → implementation → evidence
| Owner condition | Implementation | Evidence (scripted cognition / PostgreSQL) |
|---|---|---|
| Actual results, unfinished actions and pending jobs survive a cutoff and a restart | A cut-off turn writes `mind-carry.json`: each call and its result excerpt (job ids and statuses included), the calls not yet run, and its plan. The next working turn's task opens with it | continuity 1a (a restart, the real result text, "Requested but not run yet", consumed when finished) |
| Completed external actions are not duplicated; legitimate retries and revisions stay possible | An identical repeat of a SUCCESSFUL external or paid action in the continuation is not executed. A failed one can be retried; a revised one (other arguments) runs | continuity 1b and 1c |
| Current decisions and Fleet Control notices reach the agent without owner chat | v94 `attention.notices`: the text, shown once. v94 supersession: `supersededBy` in the agent's dependency list and task | continuity 3 and 4; v94 1–2 |
| Superseded approvals stay auditable | Append-only supersession; the request row never changes; UPDATE, DELETE and TRUNCATE are refused | v94 1 |
| Waiting after a stall makes no further model calls, apart from the documented reconsideration | One assessment turn after the first stall (`STALL_LINE`). After that, no call until the wake digest changes, an owner message arrives or a review time comes; this survives restarts | continuity 3: 40 unchanged slots → 0 calls; a restart → 0 |
| Relevant messages, job completions, changed dependencies and due deadlines wake the agent | Wake digest: v94 notices, supersessions and finished jobs; dependency statuses; owner messages; reviewAt | continuity 3; v94 2 |
| Unrelated events and the agent's own routine accounting do not restart stalled work | The wake digest reads none of the ledger fields that AI charges or their settlement move | continuity 3 (a cash change → 0 calls); **v94 3: three real inference charges and the settlement change no wake field** |
| Progress recognises research and intermediate work; a meaningless write or a changed argument does not count by itself | Information counts by its RESULT, whatever the arguments. A write counts for new content, unless the turn only rewrote the previous turn's targets. A successful external action counts. Recorded conclusions (facts, decisions) count once | continuity 2 (counter loop, reworded search, real iteration, a fact recorded once) |
| An oversized turn must not stop the agent thinking (found in the evidence: 7,278 refused turns, 2026-10-02 → 10-07) | The task is composed at reduction levels and rebuilt instead of refused; remembered facts are dropped only at the last level | continuity 5 at Agent-1's real memory and workspace scale (on the old code: 0 calls) |
| A run-specific AI ceiling, enforced before requests, counting in-flight work and retries | v94 `fleet_cognition_run_budgets` and `cognition-run`. Before every routed and conversation request: the run's cost (every logged call since it started, any payer) + requests in flight + this request's worst case must fit, and the end time must not have passed. Refusals happen before the provider, cost nothing, and are "wait" codes | v94 4 |

Where each control acts relative to the Anthropic request:
- The run budget, the daily fuse and the waiting gate act **before** a request.
- The stall test judges a turn that has **already** been paid for. Its cost stays charged to the agent; what it prevents is the next calls.

## Identity and rehearsals
| | |
|---|---|
| Commit | f72a479e552434fa39fb2e62d333fbd0500ea1b7 |
| Build ID | b846fc1ba73afdbb401d40f0413508ae67278784aa06445c8d17f33f36361011 (VPS = local) |
| Lockfile | 1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1 (unchanged) |
| UI | 0.26.2 (unchanged since 316b27b; the rebuild is byte-identical): `~/rlc96/ui-0.26.2-316b27b.tgz` sha 77ce19a4e06814b93705b5ae96c705185c91271ce335e95f1341b854f9f0585d |
| Data rehearsal 93 → 94 | PASSED 2026-10-18 14:53:45Z: wouldApply [94]; 894 journals; 3040 events preserved; ledger verifies; re-run no-op; rollback restores 93 with the same head |
| Services rehearsal | (pending) |

Tests: work continuity 7/7; v94 4/4; step budget 2/2; reference titles 2/2. Founder suites 158/158. Migration paths,
live contract and static audit 21/21. f2a-pg, live-01-pg and v93 20/20. Routing-pg, v72 and command centre 76/76.
These prove the mechanisms. Useful autonomous work at an evidenced cost is the live attempt's question.

## Install (separate owner decision; no resume)
1. `ssh -t agentfleet-vps 'bash ~/rlc93/proof.sh stop "proof ended: execution defects; fix in preparation"'`
2. `ssh -t agentfleet-vps 'bash ~/rlc96/install-fix.sh'`. It refuses while an old proof permission is open, and ends
   `== INSTALL DONE … BOTH AGENTS PAUSED`. Expect one heartbeat alert during the cutover.
