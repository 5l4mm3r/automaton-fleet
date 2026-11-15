# Release e1f02aa (schema 98 → 99; UI 0.26.2 unchanged) — "processing" after PayPal's return; NOT INSTALLED

**Why (owner, 2026-10-19 after the proof payment):** PayPal returned the buyer ~18:38; custody saw the approval at 18:38:30 and
captured at 18:38:32, but the page the buyer landed on still said "Not paid yet" with the Pay button (that state does not refresh).

**Change:** PayPal's return (its order id + PayerID, current order only, open checkout only) is recorded by `svc_order_returned`
as a pay request: custody reads the order within seconds and captures it once PayPal reports APPROVED. The page says
"Processing your payment — please don't pay again" (no Pay button, refreshing every 3 s). A return without approval goes back
to the payment step; the return alone is never payment. The approved / capture-pending states use the same wording.

| Item | Result |
|---|---|
| Pins | commit e1f02aa42d12bd50c02096496fc7298219e679cc · build abc1ce25d243cd5cec649adde0f8a649a93ca73873b50392df2c868a56da791f · lockfile 1df54e35… — VPS = local |
| Tests | fleet-v98-paypal-lifecycle-pg (10: + PayPal's return → processing → captured; a return without approval; a foreign order id), fleet-v97-checkout-journey-pg (Chrome, new wording), public consent, page grants, static audit, v96 routes, migration paths |
| Data rehearsal 98 → 99 | PASSED 2026-10-19T18:47:16Z |
| Services rehearsal 98 → 99 | PASSED 2026-10-19T18:47:46Z (rollback to daa8b5a) |
| Install | `ssh -t agentfleet-vps 'bash ~/rlc110/install.sh'` then `bash ~/rlc110/verify.sh` (read-only) |

daa8b5a (v98) was installed 2026-10-19 18:36:15Z; the proof order was paid through it (fresh PayPal order 2 after the old one was
retired on verified evidence; captured 18:38:32; delivered 18:39).
