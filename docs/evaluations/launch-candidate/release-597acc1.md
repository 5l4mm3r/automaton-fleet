# Release 597acc1 (schema 106 → 107; controller-only HOTFIX during the live proof rerun) — INSTALLED 2026-10-20 21:28Z

**Human-approved accounting repair, disclosed.** PayPal completed Agent-1's £5 refund of the proof order at ~21:16Z, but
recording it failed every custody pass: `FLEET_LEDGER_NEGATIVE: account fleet:treasury:unallocated would be -2`. v106 let
custody SEND the refund from cash committed to the owner's claim; the booking (cx_paypal_refund_record, v76) still took the
whole refund from fleet:treasury:unallocated (498p in the books; PayPal's other 24p is held for the owner in
fleet:treasury:owner_reimbursable). Retries used the same PayPal-Request-Id (no second refund). The owner approved the fix
("Yes, fix and install now"). v107: for that refund only (owner-proof order, live owner claim decision), the part unallocated
cannot cover comes from owner_reimbursable; fleet:owner:payable unchanged.

| Item | Result |
|---|---|
| Pins | commit 597acc1be56c451065ca4d42e458c0883756e492 · build e8dc7b60d4adc76f7f7d55e12a04ac8c674ce406567322229b497ef005062b1e · lockfile 1df54e35… |
| Regression test | fleet-v96-refund-authority-pg (v106/v107 case): unallocated drained to 498p, the owner-proof refund completes; unallocated → 0, owner_reimbursable −2, owner payable unchanged |
| Rehearsals 106 → 107 | data PASSED 21:25:29Z; services PASSED 21:26:02Z |
| Install | hotfix script (Agent-1 left running per the owner's instruction; refund authority and custody switch untouched); deployed 21:28:00Z (outage 21:27:05–21:27:51Z); ledger verifies; privilege audit clean |
| Outcome | refund recorded completed 21:27:48Z (PayPal 841606…); journal D owner capital 500 / C unallocated 498 / C owner_reimbursable 2 |

Also (script only, 0b8d19e): the proof's acceptance counts the correction from the buyer's report (the evidenced sequence),
judged by its own inspection record; strict per-file checks unchanged.
