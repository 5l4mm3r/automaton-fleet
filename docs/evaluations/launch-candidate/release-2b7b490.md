# Release 2b7b490 (schema 104 → 105; UI 0.26.2 unchanged) + Agent-1 runtime 014f6d4 → 2b7b490 — INSTALLED 2026-10-20 19:31Z

Platform-calculated quotes and invoices; currency-aware money checks on customer text and on delivered documents' extracted
text (owner, 2026-10-20: financial-output repairs).

| Item | Result |
|---|---|
| Pins | commit 2b7b4902ad87c408391478ec7ac96f3392a6bead · build 43a7092d50ee237120b057dd10866a81be67459d2ff9ab166f8ac748776e8d7a · lockfile 1df54e35… — VPS = local |
| Content | v105: fleet_price_lines (items, discounts, fees, exclusive/inclusive tax; half-up to the ISO minor unit), quote with items (FLEET_PRICE_MISMATCH), pricing on the order, order.invoice (text + PDF), money.currencies, money.price; money.ts: ISO codes/symbols/words, minor units, ambiguous $, marked approximations; delivered PDF/DOCX/text checked before staging, extraction limits stated per file |
| Tests | money checks 11 (incl. a wrong calculation in a real PDF and DOCX refused through the delivery path; invoice PDF); v100 PG 8 (the checker passes PostgreSQL's own pricing/invoice text); v76/v85/v94–v98/cognition suites pass |
| Rehearsals 104 → 105 | data PASSED 18:57:18Z; services PASSED 18:57:48Z |
| Install | release deployed 19:09:52Z (outage 19:08:58–19:09:44Z); founder upgrade rehearsal 27/27, revision rehearsal 14/14; Agent-1 upgrade 198a61c3-9a57-4ea7-b0b6-83415c0051a3; install done 19:31:37Z; verify VERIFIED 19:37:38Z; both agents paused |

Not checked (launch-readiness, "Money in customer-facing output"): channel posts, storefront text, browser actions; arithmetic
implied in prose; figures without a currency; OCR. Not "every figure checked".
