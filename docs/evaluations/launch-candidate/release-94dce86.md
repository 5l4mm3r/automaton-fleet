# Release 94dce86 (code only: schema 94 → 94; UI 0.26.2 unchanged) — DEPLOYED 2026-10-18 17:21:23Z; Agent-1 upgraded 17:39Z; both paused

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
| Services rehearsal 94 → 94 | PASSED 2026-10-18 16:58:18Z: candidate controller, Operator API and dashboard ready on schema 94; ledger verifies, head unchanged, no reservation or birth; the previous release 85486f5 refused on the candidate-approved copy; code-only rollback re-approves 85486f5 without a restore and keeps every candidate-era write; production untouched |
| Valid until | 2026-10-19 16:30Z (the data rehearsal; cutover requires one under 24 h) |
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
The installer refuses to run unless the staged pins are 94dce86 / 85289692…, both rehearsals of it passed less than 24 h
ago, the UI checksum matches, both agents are paused, every proof permission and run budget is closed, the safety flags
are false, the schema is 94 and Agent-2 is on b60e262. Re-running it after a failure continues from the failed step: the
release is skipped when current = 94dce86, and the upgrade is skipped when Agent-1 is on 94dce86. Afterwards,
`bash ~/rlc99/verify-install.sh` checks the wiring read-only, with no model call. It proves installation, not productive
behaviour.
The steps: a baseline → the code-only release → a founder upgrade rehearsal from f2a1784 → Agent-1's preflight →
Agent-1's runtime upgrade (rollback: `fleet-founders.sh rollback-runtime <agentId> <upgradeId> <reason>`) → both agents
paused. It has no resume step.

## Installed (owner-run, two passes of `~/rlc99/install-fix.sh`)
1. **17:19:28Z.**
   - Evidence gate, guards and baseline `~/rlc91/baseline-pre-94dce86-171929-…` (5028 dump entries).
   - Release: outage 17:20:29–17:21:15Z (46 s); reconciliation OK (3076 events preserved); **DEPLOYED 17:21:23Z**.
   - Ledger = baseline; pauses and fuses = baseline.
   - The founder upgrade rehearsal ran from the new release's code (17:21–17:33Z) and PASSED: final report `pass: true`,
     27/27 checks, living founders untouched. "Work continuity: 0 calls over 8 heartbeats of unchanged waiting; woke on
     the notice."
   - **The installer's result reader then crashed and stopped the install** (both agents paused, Agent-1 not upgraded).
     - Expression: `"ok" in o` (installer Python line 6), on log line 390 `            63445`. An indented number from
       the rehearsal's final multi-line JSON report parsed as the integer 63445; the log holds 16 such ints and 5
       strings.
     - A reader failure, not a failed rehearsal.
     - Fix: `rehearsal-verdict.py` parses only the final report and accepts it only if `pass` is true, the checks list
       is non-empty and all ok, and living founders are untouched.
     - Tested on the server against the real log (accepted) and against 8 malformed or failed variants (all rejected):
       pass false, a failed check, no checks, a non-object check, no pass, a truncated report, no report, founders
       touched.
2. **17:39:02Z (continuation).**
   - Fresh baseline `…-173902-…`.
   - Release skipped (current = 94dce86); records = baseline.
   - The passed rehearsal of this installed release was reused after the strict reader re-checked it: 27/27, pass
     true, untouched.
   - Preflight ok. **Agent-1 upgrade `5a6a3def-8ef0-428b-800d-2f041b5899dd`, outcome `verified`**. Rollback:
     `sudo /opt/automaton-fleet/current/scripts/fleet-founders.sh rollback-runtime 01M3F50SH7PNX2E3GST13J52AS 5a6a3def-8ef0-428b-800d-2f041b5899dd <reason>`.
   - End state: Agent-1 on 94dce86 (registry and unit pin), Agent-2 on b60e262 untouched, **both paused**, no outward
     release, card authority off, custody off, sales closed, ledger verifies (894 journals).
3. **Verifier** (`~/rlc99/verify-install.sh`, read-only, no model call): VERIFIED, all checks:
   - Agent-1's registry entry, unit pin, running process cwd and runtime report;
   - work continuity, no timed re-check, 16 steps, declared-wait, essentials in packet fitting, packet_unfit fault,
     notices and carry in the build;
   - the run budget before any reservation in both request paths; AGENT_CANNOT_THINK; attention notices;
   - the safety state.

   It proves installation and wiring, not productive behaviour: that is the measured attempt (launch-readiness §2b).
