# Turn compaction and the finish-now countdown (prepared 10 Nov 2026; NOT DEPLOYED)

**Why:** ACC-1 (9 Nov, `automaton-fleet-v25/docs/evaluations/launch-candidate/acceptance-1/RESULT.md`) failed with no
deliverable, although Agent-1's figures matched the answer key exactly. The causes, read-only from its own turn log:
- **Every working turn (1–10) ended `FLEET_TURN_CONTEXT_BUDGET`** after 6–8 steps (`mind.ts` `MAX_REQUEST_BYTES` 40 KB).
  Each next turn re-oriented from a fresh packet, and roughly half of a $4.06 run went on re-reading. The credit ran out
  at 20:21:33, one step before the workbook writer.
- **The runway reached ~2 steps without a "finish now".** The between-step status read runs at most every 10 s, while
  steps were 1–3 s apart. The count also used the last call's reservation and the 20-call average, and both grow as a
  turn's conversation grows: it showed ~5 steps when 2 could run.

**What changes** (runtime only: `founder/mind.ts`, `founder/runway.ts`. No schema, no controller, no check, no
reservation rule, no limit):
1. **Compaction instead of ending** (`compactTurn`). At the size budget, each tool result older than the last 2 steps is
   shortened to its first 300 characters, with a platform note and the untrusted-data marker kept. Older tool-call
   arguments are elided and older replies bounded. The packet and every reply stay, and the turn goes on. The request
   stays within the same 40 KB, so a step's worst-case reservation does not grow. Signed thinking is bound to the exact
   prefix, so every thinking block is dropped when a compaction changes it (as at a tier change). The turn still ends
   `FLEET_TURN_CONTEXT_BUDGET` when nothing older is left to shorten (one step larger than the budget), and is carried as before.
   Logged as `compacted: {results, bytesBefore, bytesAfter}`; counted in `routing.compactions`.
2. **Finish-now countdown.** The last runway view (the packet's, or the latest between-step read) is counted down by the
   steps taken since, at every step. At ≤ 8 the founder is told once, naming any missing required file. A failed status
   read is logged (`runwayRead: "status unavailable"`).
3. **A cautious runway count.** It uses the largest recent reservation and the dearer of the 20-call and the last-5-call
   cost share. With the ACC-1 figures before call #68 it gives ≤ 2 steps, not ~5.

**Tests** (10 Nov):
- **New `fleet-founder-turn-compaction.test.ts`: 7/7 pass.** On 42a3be8's code 5 of the 7 fail: compaction, thinking,
  countdown and runway count. The 2 that pass there are the unchanged size stop and the short-conversation case.
- **25 founder / cognition files:** all pass apart from 4 tests in `fleet-cognition-anthropic.test.ts`. Those fail in
  their database setup (`FLEET_INFERENCE_LOCAL_ONLY` from the test database's inference profile), identically on
  42a3be8's code. Pre-existing, unrelated.
- **Existing size-stop tests (1d, 1d-full, r23 `budgetStops`) pass unchanged**: their steps exceed the budget on their own.
- `npx tsc --noEmit` clean.

**Not changed, noted:**
- **The reservation itself.** Every request byte is counted at the dearest input price, plus the whole output allowance.
  Shrinking it is an economic-enforcement change and needs the owner's decision. Its input: the production T3 tier's
  prices and output/thinking allowance.
- **The ~64 s gap between turns.** It costs time, not money.
