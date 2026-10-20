# Release d2a2e7a (schema 101, code only; UI 0.26.2 unchanged) + Agent-1 runtime cb23033 → d2a2e7a — repair A completed; NOT INSTALLED

**Why:** 785ffb0 (release-785ffb0.md) is deployed; its revision rehearsal in real founder units passed phases 1–3 and
recalculated, inspected and rendered the corrected workbook inside the unit, but the corrected delivery was refused
FLEET_OPERATION_EXISTS, so the install stopped before Agent-1.

## Change
- The wallet `deliver` description: a corrected file on a delivered order is `resendReason` **with `after`** (the
  operationId of the order's latest delivery, from its result or the refusal) — the v95 rule, unchanged; Agent-1 would
  have been refused the same way. Test: fleet-v100-customer-obligations (description).
- The revision rehearsal's scripted model resends a refused delivery with `after` (as it did a message) and does not
  recalculate again when the revised file exists (that replaced the reviewed bytes).

## Evidence
| Item | Result |
|---|---|
| Pins | commit d2a2e7af5ce18a7287405d833dcbfd578eee01fc · build 6c1ce19877c5759562e55e4ad211fa96a0f57090fec9087f12549e0a3b2f67f2 · lockfile 1df54e35… — VPS = local |
| Tests | fleet-v100-customer-obligations (7), fleet-v100-revision-rehearsal (phases 1–3), fleet-v76-market-fulfilment-pg (resend with after) — pass |
| Data rehearsal 101 → 101 | PASSED 2026-10-20T02:33:06Z — live untouched |
| Services rehearsal 101 → 101 | PASSED 2026-10-20T02:33:41Z — production untouched (rollback to 785ffb0) |
| Founder upgrade rehearsal from cb23033; revision rehearsal (all four phases, real units) | run by install step 3; the install stops before Agent-1's upgrade unless both pass |

## Install (owner-run)
`ssh -t agentfleet-vps 'bash ~/rlc116/install.sh'` then `bash ~/rlc116/verify.sh`. Ends with both agents paused and the
purchase proof unchanged. Continuation (separate approval): `bash ~/rlc106/proof.sh continue` — the same run budget
(97.33p left), ends 2026-10-20 14:33:50Z.
