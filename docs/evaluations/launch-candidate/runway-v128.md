# Runway and required files (v128, prepared 9 Nov 2026; NOT DEPLOYED)

**Why:** SHEET-1 (9 Nov, `automaton-fleet-v25/docs/evaluations/launch-candidate/sheet-sample/SAMPLE.md`) failed on the
missing delivery note. The workbook was correct. Diagnosis (read-only, Agent-1's own turn log): from 15:53:36 every model
call was refused `FLEET_COGNITION_CREDITS_EXHAUSTED` with $0.795588, then $0.75788, of the $4 cap free. A call reserves its
worst case first (`costBoundMicro`: about $0.78 there, 11.7× the average actual call of $0.0648424), so 18.9% of the cap
could never be used. Agent-1 was mid-work, and nothing had told it the end was near.

**What changes** (information only: no check, reservation rule or limit changes):
1. **Schema v128:** `api_cognition_status.runway` (the founder's own free status read) carries `creditFreeMicro`
   (the provider's balance minus open holds; null for a local provider), `dailyLeftMicro` and the open `run`
   (ceiling, spend and in-flight, end time). The function is `fleet_cognition_runway`.
2. **Gateway:** each routed call returns its `reserve` (the USD µ¢ the credit check used, and the accounting µ¢).
3. **Runtime** (`founder/runway.ts`, `mind.ts`):
   - **Runway line in the packet:** "about N more steps before your model calls are refused (the X is the limit) …".
     It is shown while a run is open, or when a limit admits ≤ 60 steps. N is counted the way FleetController checks:
     a step runs only while its whole reservation is covered.
   - **Finish now:** at ≤ 8 steps, or ≤ 10 minutes of the run left, a FINISH NOW line names any missing required file.
     It is shown once per turn, in the packet or between steps (on the free status read, at most every 10 s).
   - With SHEET-1's rates, FINISH NOW comes with about $1.25 free, about 8 steps before the first refusal.
4. **Required files:** an owner task line `Required files: a, b` (workspace-relative; no absolute paths, `..`,
   symlinks or empty files; at most 10). Each file is shown as written (with its size) or MISSING. A `sleep` while one
   is missing is answered `FLEET_TASK_INCOMPLETE` once per turn, and a second sleep stops. The loop guard never records
   that reminder as a failed call; tests found that the identical second sleep had been blocked.

**Not done (on purpose):**
- **The stop timer does not react to credit refusals.** They are free and recorded nowhere in the database, so an
  exact rule would need a new column. The cost of the 15-minute idle stop is wall-clock time only.
- **The worst-case reservation is unchanged** (owner, 10-20: a run never spends more than its cap).
- **For the next acceptance test, the run's cap hold should leave the intended spend plus one reservation**
  (about $0.80 at SHEET-1's packet size), and the task should carry a `Required files:` line.

**Security:** `creditFreeMicro` shows each founder the shared provider credit free (one fleet-wide figure; it was
already implied by refusals). It authorises nothing. Required-file paths are confined to the workspace (real path
checked, links refused).

**Tests** (local, 9 Nov):
- **New:** `fleet-founder-runway.test.ts` (10, including the SHEET-1 replay and a fit test under Agent-1's packet pressure) and `fleet-v128-runway-pg.test.ts` (3, PostgreSQL 16).
- **Existing:** 14 founder and gateway suites, 198 tests; 5 PostgreSQL suites, 25 tests. All pass. `tsc --noEmit` is clean.

**Release:** needs the owner's approval. Schema 127 → 128, a controller and founder runtime upgrade (controller-restart
preflight). Both agents stay paused.
