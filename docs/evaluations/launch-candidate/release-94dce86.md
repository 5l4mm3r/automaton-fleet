# Release 94dce86 (code only: schema 94 → 94; UI 0.26.2 unchanged) — then Agent-1's runtime upgrade; ends paused

Production before it: 85486f5 (schema 94, UI 0.26.2), deployed 2026-10-18 15:57:52Z (release-85486f5.md).

## Contents
- **The founder upgrade rehearsal follows work continuity** (8962ca1).
  - The scripted founder closes the routed walk at its one reconsideration turn: it reads the guide, journals, and
    declares hibernation.
  - It is no longer expected to make a paid slim wake-up on an unchanged state.
  - New check: **zero model calls over three thinking slots of unchanged hibernation, then a Fleet Control notice wakes
    it**.
- **A turn that ends by declaring its wait condition waits at once** (94dce86).
  - Before, only a sleep-only turn could hibernate. A working turn ending in `sleep{wakeOn}` cost one extra paid turn
    (found by the local full rehearsal: "1 call over 8 heartbeats of unchanged waiting").
  - Test: work continuity 8.
- After the rollback, the previous runtime honours a declared hibernation too; the rehearsal gives it an event.

## Evidence
| | |
|---|---|
| Commit | 94dce86f43898d98a596b2457a47fa43335c238f |
| Build ID | 85289692803ba9a0acf8f0b1088023011719dccfe15299877d13ecce3c43bfdf (VPS = local) |
| UI | 0.26.2, unchanged (`ui-0.26.2-316b27b.tgz` sha 77ce19a4…) |
| **Full founder upgrade rehearsal from f2a1784** (real founder processes, local) | **PASSED: every check**, including upgrade, rollback and re-upgrade, identity / memory / workspace / books, routed tiers and escalation, consequential-action tiers, zero calls in unchanged hibernation, notice wake, v5 tools, rollback after v5 use, no credential in logs |
| Data rehearsal 94 → 94 | PASSED 2026-10-18 16:30:49Z: wouldApply []; 894 journals; 3077 events preserved; ledger verifies; rollback restores 94 with the same head |
| Services rehearsal 94 → 94 | (pending) |
| Suites | work continuity 10/10; r41.1, routing, conversation, f2a autonomy, live-01, step budget 99/99 |

## Diagnosis: every failed rehearsal check and its cause
| Run | Failed check | Detail (log) | Cause | Class |
|---|---|---|---|---|
| VPS, 85486f5 (15:58–16:20Z) | routed: a bare wake-up after a sleep-only turn uses the slim packet | "no slim wake-up observed" | The rehearsal expected a PAID wake-up on an unchanged state; work continuity removes it by design | **obsolete expectation** (test updated: zero calls are now required instead) |
| VPS, 85486f5 | R41.1 / v6: guide read, journal written, hibernation declared | "tools ok: none; journal 0 entries; wake condition absent" | The scripted founder did its closing actions only at that paid slim wake-up, so they never ran | **consequence of the obsolete expectation** (scripted founder now closes at its reconsideration turn) |
| VPS, 85486f5 | rollback after v5 use: journal kept byte for byte | "journal missing" | No journal had been written (the previous row) | **consequence** |
| local 1 (after 8962ca1) | work continuity: no model call while nothing changes | "1 call(s) over 8 heartbeat(s) of unchanged waiting" | A working turn that ended in `sleep{wakeOn}` did not hibernate: the old rule allowed hibernation only after a sleep-only turn, so one extra paid turn followed | **real bug** — fixed in 94dce86 (`declaredHere`), unit test work-continuity 8 |
| local 2 (after the fix) | rollback after v5 use: the previous runtime keeps working | "no turn observed (0 v4 steps after the rollback)" | The previous runtime correctly restores the persisted declared hibernation and waits for an event | **correct behaviour** — the rehearsal now gives it an event (a Fleet Control notice). The check still requires the old runtime to live on the new state, its journal byte for byte and its goals |
| local 3 (94dce86) | — | all checks pass | — | — |

No protection was removed:
- The slim-packet check was replaced by a STRONGER one: zero calls over three slots, then a wake on an event.
- Every identity, credential, workspace, memory, ledger, rollback and routing check is unchanged.

## What the final candidate proves (and where)
| Guarantee | Evidence |
|---|---|
| Upgrade, rollback and re-upgrade from Agent-1's actual runtime f2a1784, with identity, credential, state, memory, workspace and books preserved | full founder rehearsal from f2a1784 (local 3; the installer reruns it on the host from the release's own code) |
| Continuation across a cutoff and a restart | work-continuity 1a |
| No duplicate completed external actions; retries and revisions still possible | work-continuity 1b, 1c |
| Zero inference calls during unchanged waiting | work-continuity 3; founder rehearsal "work continuity" check (real processes) |
| Immediate waiting after a declared sleep, even when that turn also did work | work-continuity 8; founder rehearsal (local 1 found the bug, local 3 passes) |
| Waking on the relevant event or deadline (message, notice, finished job, review time) | work-continuity 3, 8; v94-pg 2; founder rehearsal notice wake |
| Fleet Control notice text reaching the agent (once, in full; queued when space is short) | work-continuity 3, 6; v94-pg 1–2 |
| Essentials survive packet fitting; an impossible packet makes no model call and raises AGENT_CANNOT_THINK | work-continuity 5, 6, 7; v94-pg 5 |
| Run budget before provider requests (any payer, in flight, worst case, end time) | v94-pg 4 |
| Persisted state stays compatible with the old runtime | founder rehearsal "rollback after v5 use" |

## Why a new release is required
94dce86 holds rehearsal-only changes (8962ca1) **and** a runtime change (`declaredHere` in `mind.ts`).
- The founder upgrade rehearsal runs from the INSTALLED release's code (`/opt/automaton-fleet/current/scripts/fleet-founders.sh`).
- A founder can only be upgraded to the approved runtime.
- Upgrading Agent-1 to the existing 85486f5 would therefore mean rehearsing with 85486f5's obsolete rehearsal code (it fails by design) and installing the extra-paid-turn bug.

So 94dce86 is installed as a code-only release (schema 94 → 94: no migration, no restore) and Agent-1 is upgraded to it.

## Install (owner): `ssh -t agentfleet-vps 'bash ~/rlc99/install-fix.sh'`
The steps: a baseline → the code-only release → a founder upgrade rehearsal from f2a1784 → Agent-1's preflight →
Agent-1's runtime upgrade (rollback: `fleet-founders.sh rollback-runtime <agentId> <upgradeId> <reason>`) → both agents
paused. It has no resume step.
