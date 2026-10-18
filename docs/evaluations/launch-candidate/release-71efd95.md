# Release 71efd95 (schema 93 → 93, code only; UI 0.26.0 → 0.26.1)

Production before it: 1743b33, schema 93, UI 0.26.0 (release-1743b33.md). Scope: the defects found in the §2 proof run of
2026-10-18 (launch-readiness.md, "Proof log"). Nothing else.

## Contents
- **Founder runtime: a turn can finish work.** Agent-1 looped from 12:30Z to 13:11Z. Each turn spent its 4 steps
  re-orienting (storefront status, list_files, list_files, read_file) and ended without a closing note. The next turn
  re-oriented again: about 6p a minute, with no progress, no reply to the owner, and the Fleet Control notice unread.
  - The runtime now passes `FOUNDER_STEPS_PER_TURN` = 16. The constructor default stays 4 for tests.
  - A turn that used every step leaves a continuation note for the next turn.
  - A turn whose calls (tool + arguments) had all been made in the previous turn rests like a sleep (the idle backoff;
    the event probe still wakes it on any change).
- **UI 0.26.1: reference codes have titles** (owner, 2026-10-18). In the conversation, a code an agent writes (a full
  id or its 8-character prefix) is shown with the title of the record it names from that agent's thread: requests and
  card requests. For example, "62cbe1b7" becomes "“Enrol a Gumroad channel for zero-capex digital products” (62cbe1b7)".

## Identity and rehearsals
| | |
|---|---|
| Commit | 71efd95f04ad44ab342bda3069a67e1f2c890ca5 |
| Build ID | bcdbea107a1131617d9429a6b428eb085978366cb4660c21769195d5fd8e46f6 (VPS = local) |
| Lockfile | 1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1 (unchanged) |
| UI | 0.26.1, `~/rlc94/ui-0.26.1-71efd95.tgz` sha cb55b35cea616ee290baab5f3904d68c564f2203b0068dc55ca5d0297cdb9a68 (52 files, two clean builds identical) |
| Data rehearsal 93 → 93 | PASSED 2026-10-18 13:20:22Z: wouldApply []; 894 journals; 3045 events preserved; ledger verifies; re-run no-op; rollback restores 93 with the same head |
| Services rehearsal | (pending) |

Tests: founder step budget 3/3 (all 3 fail on the previous code); reference titles 2/2. Founder suites unchanged:
r41.1 continuation, cognition routing, founder conversation (62); f2a autonomy, live-01, own capital (45); r23 cognition,
fresh-02 observability and retention (51). Root and UI typecheck clean.

## Deploy, then Agent-1's runtime (owner's instruction 2026-10-18: "FIX IT")
1. `bash ~/rlc94/fleet-release.sh ~/rlc94/pins.txt 93 93 0.26.1 ~/rlc94/ui-0.26.1-71efd95.tgz cb55b35cea616ee290baab5f3904d68c564f2203b0068dc55ca5d0297cdb9a68`
2. `sudo fleet-founders.sh upgrade-rehearsal f2a17843f9073040192eaa37cdf7630e2b7fdfc7`, then `upgrade-preflight` and
   `upgrade-runtime 01M3F50SH7PNX2E3GST13J52AS`. Rollback: `rollback-runtime <agentId> <upgradeId> <reason>`.
3. `bash ~/rlc94/proof.sh resume`, inside the proof window. Agent-2 stays paused and is not upgraded.
