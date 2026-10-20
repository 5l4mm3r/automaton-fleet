# Launch completion package (2026-10-20) — the finite remainder

State: production 597acc1 (schema 107); Agent-1 on 2b7b490 PAUSED; Agent-2 b60e262 PAUSED; sales closed; no refund
authority, payout activation or card authority live. Completed proofs are reused, never repeated (C1–C5; C6 refund leg —
launch-readiness §1 C).

## A. Release for approval: v108 (controller only; Agent-1 unchanged)

| # | Repair | Owner instruction | Evidence |
|---|---|---|---|
| 1 | **Supported customer geography, enforced**: the owner's list of countries the treasury checkout does not sell to (seeded: the EU-27 — EU consumer digital sales only through a merchant of record, none connected); the buyer chooses their country before paying (offer page and order page); a listed country is refused before any payment; after payment a PayPal payer country that is listed, or differs from the stated one, holds delivery (automatic and `order.deliver`) and tells the agent and the owner; `economy-sales-geography <CC,…|none> <reason>` changes the list | playbook decisions / Field Guide v2: "Worldwide"; "EU consumer digital sales go through a merchant-of-record marketplace"; 2026-10-19: "Explain and enforce the supported customer geography" | fleet-v108-completion-pg (geography); v82 / v79 page tests; real-browser journeys v96 / v97 / v98 with the country step |
| 2 | **Order conversations close**: no new buyer messages after a full refund, 7 days after the agent resolved the request with nothing new, or at 10 buyer messages; requests already made stay owed; the page keeps receipt and downloads and names fleet.treasury@proton.me | 2026-10-20: "the ai needs to log off after customer satisfaction is met so it doesnt double down as a free ai chat!"; chosen "Refund or 7 days", "After the refund test" | fleet-v108-completion-pg (conversations) |
| 3 | **Customer email**: a buyer's emailed reply to an order mail (its message, delivery or confirmation thread), or the buyer's own mail routed to the agent of exactly one open order of theirs, joins that order's thread as a buyer message (same wake, obligation and limits; quoted history removed); only from the order's buyer address; never once closed | 2026-10-19: buyers see the shared address and "<agent name> - …"; 2026-10-20: "this conversation is via email and not on the receipt page" | fleet-v108-completion-pg (email: thread reply joins; another sender does not; closed does not) |
| 4 | **Spreadsheet values saved before public sale**: a product is not sold publicly while a spreadsheet in its passing review saves formulas without their values (cached_values must pass) — the agent sees the reason (saleBlock) | 2026-10-20: "resolve the saved-formula-values issue before selling that workbook publicly" | fleet-v108-completion-pg (sale block) |

Regression kept: the 2p booking failure (fleet-v96-refund-authority-pg, v106/v107 case at production's figures).

## B. Live proofs still to run (each its own approval; paid AI within a stated ceiling)

| # | Proof | Terms to approve |
|---|---|---|
| B1 | **Workbook correction**: Agent-1 corrects and re-inspects its own tracker (cached_values pass) and republishes — its own work; after v108 its offer shows the sale block's reason. No instruction from the owner or me | a bounded run (ceiling to approve), sales closed; success = a review of the current files with cached_values pass, displayed dates and rendering pass |
| B2 | **Customer email, live**: the owner (as buyer, on the existing refunded order or a new enquiry — no purchase) replies to Agent-1's email; the reply appears on the thread; Agent-1 answers by email | in the same bounded run as B1; no purchase; the existing order is closed (refunded), so the live check uses an enquiry or the next real order |
| B3 | **One card purchase** (C7): a purchase Agent-1 itself needs, at most £5, on owner-paid card 1: reservation, Fleet Control review, browser fill, your 3-D Secure if asked, then the statement match | card authority on for the proof only (`owner-identity-autonomy on --card on --card-max 500 --card-daily 500`), switched off at the end (it has no expiry of its own); spend breaker NOT tripped; paid search per B4 decision; stop at the first completed or failed card charge, or the AI ceiling; prepared as its own script on approval of these terms |

## C. Owner decisions and records (no code)

| # | Item |
|---|---|
| C1 | **Seller address**: re-save your legal seller details from your verified documents in Fleet HQ → Seller (step-up). The stored address (saved by you 10-17 18:56) contains "Albemarie"; the street is Albemarle Street |
| C2 | **Reconcile post-refund PayPal evidence before funding**: wait for PayPal's balance reading and Transaction Search row for refund 841606… (both pending at 22:00Z; the 522p readings predate the refund). Expected available ≈ 22p (+ any fee PayPal returns); owed to you 811p |
| C3 | **Funding / refund cash** (after C2): free cash is negative while you are owed more than the treasury holds — under the normal rules every customer refund waits. Decide: reimburse yourself, add funding, or a standing rule like v106 for ordinary refunds |
| C4 | End the proof's claim-wait record: `economy-owner-claim-wait-end 1186e00e-52bf-424b-b5c5-51b599eeae80` |

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
