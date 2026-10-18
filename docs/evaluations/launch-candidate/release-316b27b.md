# Release 316b27b (schema 93 → 94; UI 0.26.0 → 0.26.2) — install ends with both agents paused

Production before it: 1743b33, schema 93, UI 0.26.0. It supersedes 71efd95, which was withdrawn and never deployed.
Scope: the execution defects of the §2 proof run of 2026-10-18 (launch-readiness.md, "Proof log"), measured against the
owner's acceptance conditions. Nothing else.

## What it fixes, and how each acceptance condition is met
| Condition (owner, 2026-10-18) | Implementation | Evidence |
|---|---|---|
| Continuation keeps actual tool results and pending work across a cutoff and a restart, without repeating completed external actions | `founder/continuity.ts`: a cut-off turn writes `mind-carry.json`. It holds each call, its result excerpt, the calls not yet run and the plan, bounded to 6 KB. The next working turn's task opens with "CONTINUE YOUR UNFINISHED WORK". An identical repeat of a completed external or paid call is not executed (`FLEET_ALREADY_DONE`). Reads and external actions are classified from the tools' own operation table; an unknown operation counts as external | work-continuity 1a (cutoff, restart, consumption), 1b (no repeat; a different action runs) |
| Unchanged waiting causes zero inference. Messages, policy changes, tool completion and due deadlines wake it; unrelated events do not | After a stall: one assessment turn (`STALL_LINE`). A second stall, or a declared hibernation, WAITS on the wake digest with no timed re-check. The wait survives restarts. Wakes come from v94 notices, supersessions and finished jobs (`eventsDigest`), owner messages and the founder's `reviewAt`. Ledger cash, which moves with every AI posting, is not a wake signal | work-continuity 3: 40 unchanged slots, 0 calls; a cash change, 0; a restart, 0; a notice, an owner message, a finished job and a review time each wake it. v94-pg 2: a finished job changes the digest; a queued one does not |
| Progress recognises useful research and intermediate work, not just writes or new arguments | A successful call whose result is new for that tool and those arguments. Timestamps, ages and the loop guard's "unchanged" marker are ignored. Failures and sleep never count | work-continuity 2: a re-read is not progress; a changed file, a changed status, a new search and a write are. In the mind, the proof run's loop is not progress, and a changed status is |
| Superseded approvals stay auditable; the current decision reaches the agent | v94 `fleet_owner_request_supersessions` (append-only; UPDATE, DELETE and TRUNCATE refused) and `fleet_admin_owner_request_supersede`: resolved requests only, once; the request never changes. Fleet Control tells the agent. `supersededBy` appears in the agent's list (its task shows "SUPERSEDED by the owner's current decision"), in the Fleet HQ thread, and through the CLI `owner-request-supersede` | v94-pg 1; work-continuity 4 |
| Fleet Control notices enter the agent's working context without owner chat | v94 `attention.notices`: the text of up to 5 notices from the last 14 days. The runtime shows each unseen notice once, in the next working turn | work-continuity 3 (shown once); v94-pg 2 |
| Costs reported as provisional until matched with provider usage | Every Fleet call is logged with Anthropic's message id, model, tokens, cache and USD. The 2026-10-18 export is in the proof log | — |

Where the stall rule acts relative to the Anthropic request: a stalled turn has already been sent and paid for. It is
charged, and it stays in the record. The wait stops the NEXT requests: no call is made until something relevant
changes. The only paid turn on unchanged state is the single assessment after the first stall.

## Identity and rehearsals
| | |
|---|---|
| Commit | 316b27b60cfbd007a0a8dc9b66e4c4410bcb3fc6 |
| Build ID | cb0e9a9eb84ae8aa7f8f2246cf88b6235e8bd07732d6d9b70dca5603a0923455 (VPS = local) |
| Lockfile | 1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1 (unchanged) |
| UI | 0.26.2, `~/rlc95/ui-0.26.2-316b27b.tgz` sha 77ce19a4e06814b93705b5ae96c705185c91271ce335e95f1341b854f9f0585d (52 files, two clean builds identical) |
| Data rehearsal 93 → 94 | PASSED 2026-10-18 14:12:41Z: wouldApply [94]; 894 journals; 3044 events preserved; ledger verifies; re-run no-op; rollback restores 93 with the same head |
| Services rehearsal | (pending) |

Tests: work continuity 5/5 (4 fail with continuity off; the supersession display is always on); v94 2/2; step budget
2/2; reference titles 2/2. Founder suites 158/158. Migration paths, live contract and static audit 21/21. f2a-pg,
live-01-pg and v93 20/20 (the dependency-reader family now lists the supersede function). Command centre 63/63. Root
and UI typecheck and lint clean. All of these use scripted cognition. Whether the real agent completes work at an
acceptable cost is the live proof's question (launch-readiness §2b).

## Install (separate owner decision; no resume)
First `ssh -t agentfleet-vps 'bash ~/rlc93/proof.sh stop "proof ended: execution defects; fix in preparation"'`, then
`ssh -t agentfleet-vps 'bash ~/rlc95/install-fix.sh'`. The script refuses to run while any old proof permission is
open. It ends `== INSTALL DONE … BOTH AGENTS PAUSED`. Expect one heartbeat alert during the cutover.
