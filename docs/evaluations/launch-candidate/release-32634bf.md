# Release 32634bf (code only: schema 94 → 94; UI 0.26.2 unchanged) — DEPLOYED 2026-10-18 18:41:06Z; Agent-1 upgraded; both paused

Production before it: 94dce86, schema 94; Agent-1 on 94dce86 (release-94dce86.md).

## Why: measured attempt 1 (2026-10-18 17:41:51Z → stopped 17:48:35Z, 48p, 18 calls, 0 searches)
Agent-1, unprompted:
- packaged its landlord compliance tracker;
- caught an uncovered promise in its own review, fixed it, and passed the review;
- created a £5 offer (draft).

It could not publish because of two runtime defects:
1. **The loop guard blocked a legitimate retry.** Publishing was refused (`FLEET_CAPABILITY_CHECK_REQUIRED`). Agent-1
   ran the capability check, and every retry was then refused as `FLEET_DUPLICATE_FAILED_ACTION` ("nothing it depends on
   has changed"), because only LOCAL tools bumped the guard's state.
   - Fix (0141bca): the toolbox tells the guard whether a call changed state — any successful call that is not a read
     (`isReadOnlyCall`), controller-side changes included.
   - An identical retry with only reads in between is still refused.
2. **The reason was lost.** An offer edit broke `fleet_offers_title_check` (a title over 120 characters). The
   controller sent the database message as `reason`, but the toolbox's `ownerRefusal` kept only the code, so the agent
   saw a bare `FLEET_REQUEST_FAILED`.
   - Fix (0141bca): the refusal keeps the reason (bounded).
   - The controller maps check / length / not-null violations to `FLEET_BAD_REQUEST` naming the rule.

Also (32634bf), from the local founder rehearsal from 94dce86: the rolled-back 94dce86 runtime is alive and v5-capable,
and it appended a journal entry. The "kept byte for byte" check now requires the v5-written journal to be an exact
prefix (nothing restored over it), and the check names every failed condition.

## Evidence
| | |
|---|---|
| Commit | 32634bfe7f9062a6484da713e985612acd80e694 |
| Build ID | ddd3799dbbabd3a96c9a37e1279c1a657f01650059f5e3306395ab89d3bd8365 (VPS = local, both at 32634bf exactly) |
| UI | 0.26.2 unchanged (`ui-0.26.2-316b27b.tgz`, sha 77ce19a4…) |
| Tests | retry-after-fix 3/3 (all 3 fail on the attempt's code); founder suites 158/158; work continuity and step budget 12/12; cognition, d31 hardening, f2 economy 53/53; cognition-anthropic, static audit, live contract 36/36 |
| Full founder rehearsal (real processes, local) | PASSED from 94dce86 (Agent-1's runtime) and from f2a1784 |
| Data rehearsal 94 → 94 | PASSED 2026-10-18 17:57:44Z (914 journals) |
| Services rehearsal 94 → 94 | PASSED 2026-10-18 18:21:55Z: code-only rollback re-approves 94dce86, every candidate-era write kept; production untouched |
| Valid until | 2026-10-19 17:57Z |

## Install (owner)
- `ssh -t agentfleet-vps 'bash ~/rlc100/install-fix.sh'`. The same gate, guards and continuation as 94dce86. It upgrades
  Agent-1 from 94dce86 and ends with BOTH AGENTS PAUSED.
- Then `ssh -t agentfleet-vps 'bash ~/rlc100/verify-install.sh'`. Read-only; it also checks the loop-guard, refusal-reason
  and rule-naming fixes in the build.
- The measured attempt again only on the owner's separate approval: `~/rlc100/attempt.sh start` (the same terms).

## Installed (owner-run `~/rlc100/install-fix.sh`, 18:39:18Z)
- Baseline `~/rlc91/baseline-pre-32634bf-183919-…` (5028 dump entries).
- Release: outage ≈ 46 s, reconciliation OK (3135 events preserved). **DEPLOYED 18:41:06Z**. Ledger, pauses and fuses
  = baseline.
- Founder upgrade rehearsal from 94dce86 on the host: 27/27, pass true, living founders untouched.
- Preflight ok. **Agent-1 upgrade `92936bfb-5444-4349-bdf2-c2f82d08ea0b`, outcome `verified`**.
- End state 18:51:51Z: Agent-1 on 32634bf, Agent-2 on b60e262, both paused, no outward release, card authority off,
  custody off, ledger verifies (914 journals). The read-only verifier passes, including the new loop-guard, refusal-reason
  and rule-naming checks.
- **The final "INSTALL DONE" line is missing from the screen and the log.** Every end-state check had passed: they all
  run before that final `state` block, and any failure stops with "INSTALL NOT COMPLETE". The last line was lost
  because the output goes through `exec > >(tee …)`: the process-substituted `tee` can be cut off when the script exits
  and the SSH session closes. Future installers wait for `tee` before exiting.
