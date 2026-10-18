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

## Install (owner): `ssh -t agentfleet-vps 'bash ~/rlc99/install-fix.sh'`
The steps: a baseline → the code-only release → a founder upgrade rehearsal from f2a1784 → Agent-1's preflight →
Agent-1's runtime upgrade (rollback: `fleet-founders.sh rollback-runtime <agentId> <upgradeId> <reason>`) → both agents
paused. It has no resume step.
