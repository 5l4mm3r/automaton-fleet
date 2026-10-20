# Release 8bd8a3e (schema 102 → 103; UI 0.26.2 unchanged) + Agent-1 runtime 126723c → 8bd8a3e — refunds an agent can complete honestly; the proof's bounded rerun; INSTALLED 2026-10-20 12:09Z

**Why (owner, 2026-10-20):** a bounded continuation on the existing paid order — the outstanding correction with no new buyer
message and no repair by hand, then Agent-1's own refund of the buyer, confirmed to the buyer only after PayPal verifies
it; the owner's own refund kept separate.

## Gaps found while preparing it (fixed)
| Gap | Effect | Fix |
|---|---|---|
| PayPal's refund outcome woke no agent | Agent-1 could not confirm a refund after PayPal without paid polling | v103: a completed / failed refund of the agent's changes eventsDigest and is in recentEvents; its own request is not news |
| The refund note and the wallet refund description said refunds wait for "money-out" | untrue since v96 (refunds leave under an owner-granted refund authority); Agent-1 could have told the buyer a refund was impossible | both now say: refund authority; woken by PayPal's outcome; confirm only then |
| The proof script had no bounded rerun on an ended run, and the owner's refund command needed a running watchdog to open its window | no way to continue on revised terms; `proof.sh refund` alone would leave the refund set aside | `rerun <ceiling> <hours>`, `owner-refund` (separate), new stops |

## Evidence
| Item | Result |
|---|---|
| Pins | commit 8bd8a3e6f56da95680ab1af5a7e860ec01de05ce · build 5b7832976af6b3b040f067d78a508cb7a3347364d8e7bab5602ef9f3d3d5a234 · lockfile 1df54e35… — VPS = local |
| Tests | v96 refund authority (+v103: outcome wakes, own request does not, truthful note), proof script (10: rerun guards/terms, rerun success needs Agent-1's own refund and its confirmation after PayPal, new stops, owner-refund), v94 v95 v100 v76 v67 PG, f2a autonomy + static audit, work continuity — pass; v68 1 pre-existing failure |
| Strict success SQL on production (read-only) | the 03:29 corrected delivery does NOT meet the rerun's success (cached_values warn: 1,194 unsaved values); the earlier proof's definition unchanged |
| Data / services rehearsals 102 → 103 | PASSED 11:45:06Z / 11:45:39Z |
| Install | 11:46–12:09Z; founder upgrade rehearsal 27/27; revision rehearsal 14/14 (real units); Agent-1 upgrade 174e6578-45cf-4f77-acb2-c87e5b6781ee; verify VERIFIED 12:09:44Z |
| State after | both agents paused; proof run ended; no refund authority; custody refund switch off; no payout signer; sales closed; Agent-1 spendable 9528p |

## Checks unchanged by "no new blocks"
No inspection, review, exact-file delivery, refund-authority, custody, sandbox or permission check was removed or weakened
in f010dd4 … 8bd8a3e (diff audited). The founder upgrade rehearsal's action-boundary check was restated: a founder's steps
already run at the critical tier, so it now requires that small and major spends are linked to critical-tier cognition
(the database rule that a major spend needs critical-tier cognition is unchanged).
