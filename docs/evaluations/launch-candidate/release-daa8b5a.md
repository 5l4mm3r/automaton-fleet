# Release daa8b5a (schema 97 → 98; UI 0.26.2 unchanged) — the PayPal order lifecycle; NOT INSTALLED

**Live finding (2026-10-19, read-only):** the proof order's PayPal link (created 11:05Z, live rail, `www.paypal.com`) reached a
PayPal error page when pressed after 17:16Z. Custody's 89 status reads of the order ended in HTTP 404; no approval, capture,
webhook or balance movement was recorded (none of these alone is proof of non-payment; Transaction Search could not confirm it:
its last answer was a 403 and nothing was recorded since 10 Oct). The Fleet did not record PayPal debug ids. Order, consent,
proof budget (200p, expiry 2026-10-20 14:33Z) and spending untouched.

**Repair (daa8b5a, migrations-phase98.ts):**
- Two lifetimes: the Fleet order stays payable until its own expiry; a PayPal link goes to the buyer directly only while PayPal
  confirmed it within 60 min. Otherwise Pay (`POST /order/<token>/pay`, same-origin) asks custody first, which within seconds
  REUSES the PayPal order PayPal still reports payable, captures an approved one, or RETIRES it and creates a fresh one for the
  same checkout. Installing creates no PayPal order.
- Every PayPal order is kept (`fleet_paypal_provider_orders`, immutable history with HTTP status, PayPal status, error name and
  debug id — never a token, credential or approval link). Creation is claimed under the checkout's lock: one live order per
  checkout, retries reuse the PayPal-Request-Id (`order:<checkout>`, then `order:<checkout>:<n>`); unanswered claims become
  `create_unknown` (reconciled; their link was never shown). Every attempt keeps the invoice id `fleet:<checkout>`.
- Retirement needs: two RESOURCE_NOT_FOUND answers with their own debug ids; the same credential and environment that created
  the order (credential predating it, still bound); a successful control read of a captured order of that credential (live: the
  10 Oct receiving test); no sign of approval or payment. Otherwise nothing is retired — reconciled, the buyer told to try again
  with PayPal's reference; the owner may retire it (`economy-paypal-order-retire`, recorded).
- Retired orders are watched 30 days: a late approval is never captured (reconciled, P1); a late capture is booked only if the
  checkout has none, else held as a duplicate (P1). No automatic refund: refunds need refund authority.
- Reconciliation without Transaction Search: its outcome (HTTP status, name, debug id) and whether the token carries the
  Transaction Search scope are recorded (`fleet_paypal_sync_status`); captured orders are audited through the Orders API the
  credential already uses (captures and refunds booked once via the existing evidence paths). No credential broadened.
- Owner: `hub-paypal-reconciliation`, `economy-paypal-reconciliation-resolve`, `economy-paypal-order-retire`.

| Item | Result |
|---|---|
| Pins | commit daa8b5a4f4e4b2a9d5d9938bd56327f9568fc611 · build 6f1d95e0c04d569df44b6d21edd64cf193be26bbbb6ec165414f55ca1086c4de · lockfile 1df54e35… — VPS = local |
| Tests | fleet-v98-paypal-lifecycle-pg (9, incl. real Chrome); regressions green: custody worker, owner receiving test, refunds v59, refund authority v96, durable operations v95, v76 market, v82 consent, v97 journey (Chrome) + contents, migration paths, static audit, page grants, probe, proof script, clawback v57, f2 launch, rail readiness, v94, dashboard e2e |
| Data rehearsal 97 → 98 | PASSED 2026-10-19T18:29:51Z (row counts identical; reconciliation OK; ledger verifies; re-run no-op; rollback restores 97) |
| Services rehearsal 97 → 98 | PASSED 2026-10-19T18:30:37Z (candidate services on 98; rollback to 3679078 proven) |
| Backfill (read-only preview on live) | proof order → provider order 1, open, legacy; 10 Oct receiving test → captured (the control); same live credential, predating both |
| Install | `ssh -t agentfleet-vps 'bash ~/rlc109/install.sh'` (owner-run; guards incl. no requested checkout) then `bash ~/rlc109/verify.sh` (read-only; never presses Pay) |
| Rollback | before money moves on 98: `fleet-rollout.sh revert ~/rlc109/pins.txt 97 98 <reason>`; after: fix forward |
