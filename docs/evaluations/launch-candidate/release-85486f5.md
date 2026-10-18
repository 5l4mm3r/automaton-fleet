# Release 85486f5 (schema 93 → 94; UI 0.26.0 → 0.26.2) — DEPLOYED 2026-10-18 15:57:52Z; Agent-1's upgrade stopped safely

Contents: as release-f72a479.md, plus packet fitting that never drops essentials and the v94 `AGENT_CANNOT_THINK` alert.
Builds: VPS = local, build ID a041b4bf5617c5ae84f7ce10332dc6d2af9111b4157c353625cbcf89a29b3e1c. Data rehearsal 93 → 94 PASSED
15:44:41Z. The services rehearsal had not finished when the install was run (it then refused, correctly: "already the
candidate").

## The install (owner-run `~/rlc97/install-fix.sh`, 15:55:53Z)
- Baseline `~/rlc91/baseline-pre-v94-20261018T155553Z` (5003 dump entries).
- Outage 15:56:53–15:57:39Z (46 s). Reconciliation OK (3044 events preserved). DEPLOYED 15:57:52Z: schema 94, root UI
  0.26.2. Ledger = baseline; both agents paused; fuses unchanged.
- **Step 3, the founder upgrade rehearsal, FAILED; the script stopped with "INSTALL NOT COMPLETE — both agents remain
  paused" (16:20:32Z).** Agent-1 was not upgraded and stays on f2a1784. Both living founders were untouched (the
  rehearsal report).
  - Cause: the rehearsal still expected the R23.1 paid "slim wake-up" on an unchanged state, which work continuity
    removes by design (3 checks failed for that reason).
  - Fixed in 8962ca1 and 94dce86 (release-94dce86.md).
