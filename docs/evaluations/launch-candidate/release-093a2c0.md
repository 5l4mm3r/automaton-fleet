# Release 093a2c0 (schema 103, code only; UI 0.26.2 unchanged) + Agent-1 runtime 8bd8a3e → 093a2c0 — money checks, cost-bounded reservations, the bounded rerun; STAGED, NOT INSTALLED

**Why (owner, 2026-10-20):** "500p + 101p equals 601p, not 701p"; customer-facing arithmetic must not rest on model
arithmetic; the run's all-inclusive maximum (600p) must hold through the enforcement and posting code; excluded spending
prevented before it executes.

## Verified from the code and production data (read-only)
| Item | Finding |
|---|---|
| Usage ceiling | hard cap on charges: a call is charged min(its reservation, its cost); the run check counts charged + in flight + this reservation (`fleet_cognition_run_refusal`); one call in flight per agent (agent row lock; FLEET_COGNITION_BUSY); provider deadline ≤ 240 s < the 5-min stale window |
| Economic cost (before this release) | the credit drawn — the basis of the tax/fee — is the provider's cost, not the charge: the proof's 62 calls drew 193.7822p and were charged 192.1332p (4 calls cost more than they reserved). The reservation counted the prompt at ~4 chars/token and the tools by name only |
| Fix | a reservation is a true upper bound (every request byte as a token incl. full tool definitions, images at the provider maximum, 2,000 framing tokens, dearer of input / cache-write price, plus the whole output allowance) → cost ≤ reservation → drawn = charged ≤ ceiling |
| Rounding | cumulative, not per call: usage accrual (carry now 0.2147p) and tax/fee accrual per lot and payer (carry now 0.9163p), whole pence posted, remainder carried |
| Credit lots | one open lot (owner-funded, $35.75 left; ratio 20.0048%); a 499p run draws ≈ $6.6 |
| 499p run | usage ≤ 499p; tax/fee economic ≤ 99.8240p, posted ≤ floor(0.9163 + 99.8240) = 100p; wallet postings ≤ 599p; ALL-INCLUSIVE ≤ 599p ≤ 600p |
| Independent reviews | routed calls (`ports.infer`): reserved, charged and counted inside the ceiling; only non-model inspection is free |
| Funding | PayPal 522p (67p £1 test net + 455p proof net); owed to the owner 496p; free 26p; run's added liability ≤ 599p; refund 500p → needed free 1,099p → deposit 1,073p (the start guard's own functions) |
| Transaction Search | HTTP 200 at 12:49:28Z, token scope transactionSearch — the earlier 403 is resolved |

## Change
- money.ts + toolbox: written calculations, itemised totals and labelled totals in customer-facing text checked before
  sending against exact arithmetic and the record (FLEET_AMOUNT_MISMATCH).
- Inspector: `expected_results` warning for a spreadsheet with formulas and no acceptance case; cases guidance (tolerance
  0 for money, expected values computed with exec).
- Routed gateway: `costBoundMicro` reservation.
- Hub: `economy-spend-breaker <trip|reset>`.
- Proof rerun: `[allInMaxPence]`; trips the spend circuit breaker (purchases rejected before any reservation) and resets
  it on stop if it tripped it; stops if it is reset, or when less than 125p (one Opus step's reservation) is left.

## Evidence
| Item | Result |
|---|---|
| Pins | commit 093a2c03f258e8865e9a6f4d5dadb67a8f175cb6 · build a361451d181e4394ddcdf2f5526d95e754cac0c4203e0b415496d5618c07710c · lockfile 1df54e35… — VPS = local |
| Tests | fleet-money-checks 6, proof script 14, ledger breaker, cognition routing / R23 / routing-pg / v62 / v82 / v94 / qa-inspector-v3 / v76 / f2a / static audit / v100 / revision rehearsal / r24 (177), hub 11 — pass. Pre-existing, not fixed: fleet-v68-wake-lessons-pg 1; fleet-ledger "migrates to v10 … privilege audit" (fails on the committed code too) |
| Data / services rehearsals 103 → 103 | PASSED 13:17:48Z / 13:18:25Z |
| Kit | ~/rlc119 (install.sh, verify.sh, proof.sh) — for the owner's approval |

## Limits
Free text is checked only where money is written as a calculation, an itemised list with a total, or a labelled total; not
amounts in words or other currencies, implied arithmetic, or file contents; channel posts and browser actions are not
checked. Spreadsheets: recalculation and acceptance cases (a warning, not a block, when none). The reservation is
conservative (≈ 100p per Opus step): at least 374p of a 499p ceiling is usable.
