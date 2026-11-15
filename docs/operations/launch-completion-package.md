# Launch completion package (2026-10-20) — the finite remainder

State: production 597acc1 (schema 107); Agent-1 on 2b7b490 PAUSED; Agent-2 b60e262 PAUSED; sales closed; no refund
authority, payout activation or card authority live. Completed proofs are reused, never repeated (C1–C5; C6 refund leg —
launch-readiness §1 C).

## A. Release for approval: v108 + Agent-1's guidance (one install)

| # | Repair | Owner instruction | Evidence |
|---|---|---|---|
| 1 | **Customer geography**: the buyer's country is recorded before payment (offer page and order page), PayPal's payer country with it; the owner's exclusion list is EMPTY; a country the owner lists later (`economy-sales-geography`) is refused before payment and a paid order from it held. Agents are told (fleet-capability-status v15; Field Guide "the treasury checkout sells worldwide, EU consumers included") | 2026-10-20: "Worldwide, no exclusions" (the owner accepts the VAT obligations on digital sales; "the country step still records it") | fleet-v108-completion-pg (geography; v15 load); v82 / v79 page tests; real-browser journeys v96 / v97 / v98 |
| 2 | **Order conversations close**: after a full refund, 7 days after the agent resolved the request with nothing new, or at 10 buyer messages; requests already made stay owed | 2026-10-20: "the ai needs to log off after customer satisfaction is met…"; "Refund or 7 days", "After the refund test" | fleet-v108-completion-pg |
| 3 | **Customer email**: a buyer's emailed reply joins the order's thread (buyer's address only; quoted history removed; not once closed) | 2026-10-19 support decision; 2026-10-20 "this conversation is via email" | fleet-v108-completion-pg |
| 4 | **Spreadsheet values before public sale** (cached_values must pass); Fleet Control tells the agent of an offer it blocks, once, at the install | 2026-10-20: "resolve the saved-formula-values issue before selling that workbook publicly" | fleet-v108-completion-pg |
| 5 | **One pre-launch card purchase** — the gate was `fleet_outward_refusal` (v80): every card request refused while sales are closed, and a release could never name spending. Now a release may name `card` for ONE purchase: one merchant origin and account, the merchant's name, at most 500p, ≤ 24 h, with the browser fill. Everything else is the existing card path (card authority + caps, Fleet Control's review, the reservation against Agent-1's own cash, the statement match) | 2026-10-20: "Keep public sales closed … include the smallest necessary change in the pending completion candidate" | fleet-v108-completion-pg (card release: one purchase, merchant, amount, expiry); v80 / v79 release tests updated to the new rule |

Run script for B (`scripts/fleet-launch-checks.sh`, tested in fleet-launch-checks-script): `checks` and `card`, each starting from a
paused Agent-1 with sales closed, and stopping itself at its outcome (Agent-1 paused, run ended, release ended, card authority off).

## B. Live checks after the install (each its own approval; paid AI within its ceiling)

| # | Check | Command | Success |
|---|---|---|---|
| B1+B2 | **Workbook + customer email** (one run): Agent-1 works on its blocked offer on its own (Fleet Control's notice); the owner writes to fleet.treasury@proton.me with subject "Agent-1 - …" from their address; Agent-1 may mail that address only | `bash ~/launch-checks.sh checks <ceilingPence> <hours> <ownerEmail>` | Agent-1's own new passing review (cached_values, displayed dates, rendering pass; no sale block) and its reply SENT to the owner's address after the owner's mail |
| B3 | **One card purchase** at an agreed merchant (Agent-1 proposes a useful purchase; the owner agrees the merchant and its account): card authority on with the cap, the one-merchant release, the run | `bash ~/launch-checks.sh card <ceilingPence> <hours> <maxPence ≤ 500> <accountId> <https://merchant> <merchant name>` | the card used once at that merchant, reserved from Agent-1's cash, charged; then the statement match (`economy-card-charge` once) — one expense, no duplicate |

## C. Owner decisions and records (no code)

| # | Item |
|---|---|
| C0 | **Geography decided** (2026-10-20): worldwide, no exclusions — implemented in A1 |
| C1 | **Seller address**: re-save your legal seller details from your verified documents in Fleet HQ → Seller (step-up). The stored address (saved by you 10-17 18:56) contains "Albemarie"; the street is Albemarle Street |
| C2 | **Reconcile post-refund PayPal evidence before funding**: wait for PayPal's balance reading and Transaction Search row for refund 841606… (both pending at 22:00Z; the 522p readings predate the refund). Expected available ≈ 22p (+ any fee PayPal returns); owed to you 811p. PayPal's own confirmation is in: the refund API answered COMPLETED (841606…) and PayPal's refund webhook recorded 500p |
| C3 | **Funding / refund cash** (after C2): free cash is negative while you are owed more than the treasury holds — under the normal rules every customer refund waits. Decide: reimburse yourself, add funding, or a standing rule like v106 for ordinary refunds |
| C4 | DONE 2026-10-20 22:26Z: the proof's claim-wait record ended (nothing temporary from the refund test is live) |

## D. Activation (last, each its own approval)

1. Capital backing recalculated (£200 unbacked) on reconciled figures.
2. Launch boundary; Agent-1 survival protection live.
3. Contextual capital sizing (uses each agent's history where it exists; no mandatory track record — a new agent gets evidence-backed capital, fleet-v77) and the net-profit sweep with its bands.
4. Standing refund authority (per refund / 24 h / expiry) and custody refunds on.
5. Standing identity authority and card authority (card 1 owner-paid, fallback off).
6. Ongoing budgets: Agent-1's AI fuses, Fleet Control's daily AI budget, paid search (restarts the media service, stopped since 20:26Z).
7. Open sales; resume Agent-1 only; Agent-2 verified paused.

## Known limits (recorded; not blockers)

Money checks do not cover channel posts or browser actions; a closed order's email still reaches the agent as mail (it no
longer creates an obligation or a buyer message); fleet-refunds-v59 still expects refund-note wording replaced in v103.
