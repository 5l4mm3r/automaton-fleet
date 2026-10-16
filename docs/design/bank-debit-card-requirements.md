# A separate bank debit card for agent spending: integration requirements (prepared 2026-10-16, not built)

**Status:** requirements only. Nothing here is implemented, and the payment priority is unchanged. PayPal stays supported
and stays first (O17). The card standing authority stays off. No card is recommended for "card first" until the work below
is built and proven.

**Why this exists.** The owner was advised to give the Fleet a card on a separate bank account rather than relying on
PayPal, because PayPal can hold funds. A card only **spends**; it cannot receive customer payments. So it can protect the
spending side from a PayPal hold, but not the receiving side.

**The rule this document applies:** stored card details are not a payment integration. A card is a usable rail only when
the Fleet can do all of the following:
- know there is money behind it;
- reserve that money before a purchase;
- see what the bank actually charged;
- handle refunds;
- reconcile every bank line against its own books;
- attribute each charge to an agent, venture and purpose.

## 1. What exists today (the credit-card "bypass", v48–v64)

| Step | Today | Evidence the Fleet has |
|---|---|---|
| Card on file | One card only (`payment_card` owner identity class, sealed). No type, issuer, account or currency is recorded. | none about the account behind it |
| Request | `card.request`: merchant, amount, `paypalUnavailable`, purpose. Spendable cash must cover it. **Nothing is reserved yet.** | the agent's ledger wallet |
| Review | Fleet Control approves a routine request at once; a material or suspicious one waits for the automated review (v64). | |
| Hold | `card.authorize` reserves the maximum from the agent's wallet or envelope (ledger only); the hold must be declared within 24 h. | the ledger, not the bank |
| Fill | The browser receives the card fields only for a held charge on that exact site; every fill is logged. | |
| Amount | **The agent declares it** (`card.declare`), with no receipt, order id or currency (`migrations-phase49.ts:424`). If the card was filled but nothing was declared, the reaper **books the hold maximum** (`migrations-phase51.ts:567`). The owner corrects it from the issuer's statement by hand. | agent claim; owner typing |
| Booking | Expense → `card_payable`: a credit-card liability inside treasury cash (`migrations-phase48.ts:62`). | |
| Statement | Weekly, built from the Fleet's own bookings (v53). It is not the issuer's statement. | |
| Repayment / refunds | Typed by the owner. A refund cannot be linked to the charge it reverses (`fleet_card_receipts` has no `charge_id`). | owner typing |
| 3-D Secure / SCA | Classified as human-only (spec §22). Nothing detects or waits for it. | none |

## 2. Requirements for a bank debit card

### R1. Available-balance evidence
- A bank-account rail and a ledger **cash asset** for it, separate from the PayPal treasury, plus an **in-transit** account
  for money withdrawn from PayPal that has not yet arrived at the bank.
- **Balance observations** with their age: owner-entered, CSV import, or a provider feed. A hold refuses when the latest
  evidence is older than a set limit.
- **A consistency check:** the ledger's bank balance, less open holds and unsettled charges, is compared with the observed
  balance. A difference raises a P1 (on the pattern of `CARD_RESERVE_MISMATCH`).

### R2. Reservations
- **An account-level check when the hold is taken**, under a lock: observed balance − open holds − unsettled charges must
  be at least the hold. The agent's wallet check is not enough, because ledger wallets can include unbacked capital (£200
  today).
- A hold that cannot be covered is refused with "awaiting funding". It is never sent to the merchant.

### R3. Authorisation and settlement
The charge record must carry the lifecycle authorised → settled, or declined / reversed / partially captured. It must also
hold:
- the original currency and amount, the FX rate and any foreign-transaction fee;
- the merchant descriptor, the bank's transaction id and the settlement date.

Changed behaviour:
- **A declined or unanswered attempt is never booked as spend.** The book-at-maximum rule is replaced, for this rail, by
  "awaiting evidence" until the bank line arrives or the hold is released.
- An amount above the hold is not advanced from the treasury. It raises a P1.

### R4. Refunds
- A refund is linked to the charge it reverses, and capped per charge (partial refunds included).
- A debit refund is booked to the bank asset and back to the agent: no owner invoice, and no "applied to the card balance".
- An **issuer dispute or chargeback** state, for a charge the owner disputes with the bank.

### R5. Reconciliation
- A **bank transaction table**, filled by importing the bank's CSV (owner upload, parsed on the controller to a strict
  schema; duplicates refused by transaction id), or later by a feed.
- A **deterministic matcher** on descriptor, amount (with FX tolerance) and date window, against holds and charges.
- An **unmatched queue** for the owner:
  - bank lines nobody declared;
  - declared charges that never appear;
  - fees.
- The weekly v53 statement becomes a **reconciliation report** for this rail (matched, unmatched, balance drift). "Amount
  owed / mark paid" has no meaning for a debit card.

### R6. Attribution
- Every request, hold, charge, refund and bank line carries the agent, the **venture**, the card request, the **purpose**
  and the **rail or card** used.
- With one card shared by several agents, attribution of bank lines comes only from matching, so R5 is mandatory. A card
  product that issues a separate card number per agent or per purchase (to verify with a provider) would make it exact.

### R7. Strong Customer Authentication (3-D Secure)
- UK and EU online card payments commonly ask for approval in the cardholder's banking app. That is human-only: an agent
  purchase can stop halfway.
- **Required behaviour:**
  - a browser step outcome of "awaiting owner approval";
  - a P1 notification to the owner;
  - a bounded timeout;
  - the hold released, or kept "awaiting evidence", never booked without evidence.
- **Consequence for autonomy:** with a plain bank card, card spending is only partly autonomous. Whether a given product
  supports exemptions or approval without the owner's phone must be verified with the provider. This is the same for
  credit and debit cards.

### R8. Accounting model (an owner and architecture decision)
- **Funding:** treasury → in transit (when the PayPal withdrawal is evidenced) → bank asset (when the bank credit is
  imported).
- **A charge:** agent expense against the agent's reserved cash, settled from the bank asset. No payable.
- **Owner decision needed:** is the bank account the Fleet's money (treasury) or owner money held for the Fleet? Economic
  policy changes need review (CLAUDE.md).

### R9. Several cards
- The single `payment_card` slot becomes one card per rail, with its type (credit or debit) recorded.
- Holds and fills name the rail. The existing credit-card path keeps working unchanged.

## 3. What is reused unchanged
- requests and Fleet Control review (v54, v64);
- the standing authority and the fill path (browser fields only for a held charge on that site; every use logged);
- the hold from the agent's wallet or envelope;
- freezes and the footprint;
- events and notifications.

## 4. Options to compare (provider facts to verify before choosing)

| | Plain bank debit card + CSV import | Card product with an API and webhooks |
|---|---|---|
| Balance evidence | owner-entered or CSV; stale between imports | possibly an API balance (verify) |
| Authorisations and declines | seen only after posting; declines invisible | possibly real-time events (verify) |
| Per-agent control | Fleet-side holds only; one shared number | possibly a card number per agent or purchase, with limits (verify) |
| SCA | owner's banking app | product-dependent (verify) |
| Work | import parser, matcher, owner queue | an adapter as its own service with signed webhooks, plus the import as a fallback |

## 5. Ordered work items (none started)
1. Decision record: the bank account's ownership in the books, the funding policy (float, top-up trigger), and PayPal stays
   first.
2. Rail, bank asset and in-transit accounts; funding-transfer command matched to the PayPal withdrawal.
3. Balance observations and the consistency check (R1).
4. Several cards with a type (R9).
5. Account-level hold check (R2).
6. Charge lifecycle, currency and FX, descriptor and transaction id, venture; no book-at-maximum for this rail (R3, R6).
7. CSV import, matcher, unmatched queue; reconciliation report replaces the statement for this rail (R5).
8. Refund linkage, per-charge caps, dispute state (R4).
9. SCA: an "awaiting owner approval" outcome, notification and timeout (R7).
10. v77 liquidity terms: debit charges no longer count as money still to leave PayPal; transfers in flight do.
11. Optional, later: an issuer API adapter, after its features are verified.

## 6. Owner inputs
- the bank and card product, and whether it offers CSV export, an API or an open-banking feed;
- a bank account used only by the Fleet;
- the funding policy and float;
- how SCA approvals will be handled for this card;
- a sample CSV export and descriptor formats;
- one small test purchase to confirm settlement and FX behaviour;
- who reconciles, and how often;
- the accounting decision in item 1.

Sealing the card and turning on `--card on` stay the owner's own steps. They are not part of this work.

## 7. Live proofs before "card first" is even considered
1. A funded transfer, PayPal → bank, matched end to end.
2. One small purchase with a stated amount and purpose: hold → (SCA) → charge → bank line imported → matched → booked to the
   agent and venture.
3. One declined attempt: nothing booked; the hold released.
4. One merchant refund: linked to its charge and booked back.
5. One reconciliation report with zero drift.

## 8. Provider research and recommendation (2026-10-16, official documentation; nothing opened or bought)

**Scope.** Two different things are compared and never merged:
- **managing a card through an API** (create, freeze, set limits, read transactions);
- **authorising a merchant purchase** (the cardholder's 3-D Secure / SCA step).

| | Starling (sole trader) | Revolut Business | Airwallex | Monzo Business | Wise Business |
|---|---|---|---|---|---|
| UK individual / sole trader | yes (UK resident, 18+) | terms require a registered business; assume a limited company (unverified for UK sole traders) | yes | — | — |
| API cost / plan | free; scoped personal access token (no expiry), 5 req/s, 1,000/day; sandbox | Grow plan £35/month or above; JWT, 40-minute access token plus refresh | Explore plan £0; 30-minute token | own-account only; business accounts not documented | UK tokens cannot read statements or fund transfers |
| Balances | cleared, effective and pending | one balance (no pending split) | yes | yes | limited |
| Card transactions | statuses PENDING → SETTLED / DECLINED / REVERSED / REFUNDED; source amount, FX rate, fees, merchant, settlement time | pending / completed / declined / failed / reverted; card payment / refund / chargeback; MCC; amount and billed amount | AUTHORIZED → CLEARED, or REVERSED / EXPIRED / DECLINED; refunds linked by `lifecycle_id` | authorised vs settled; decline reason | — |
| Webhooks | signed (RSA); retries 2/4/8 minutes then stop; recover by polling `changesSince` | signed; failed-events endpoint; backfill from `/transactions` | HMAC; events can be re-sent | `transaction.created`, unsigned | — |
| **Managing cards via API** | lock / unlock and channel controls only; no card creation; no spending limits | **virtual cards per agent**, per-card limits, merchant/MCC lists, references copied to transactions | virtual and **single-use** cards, limits, MCC lists, **remote authorisation** (the Fleet allows or declines each charge in real time; enabled by Airwallex) | none | partner only |
| **Authorising a purchase (3DS)** | **owner's Starling app** (push or code) | **owner's Revolut app**; "trusted merchants" skip 3DS | **one-time code to the cardholder by SMS or email** | in-app | — |
| Overdraft | none arranged; an unarranged negative balance is possible (late or offline charges) | — | — | — | — |
| Export fallback | CSV feed export through the API | app export (unverified) | web app | app | app |

**Where a human stays unavoidable, at every provider checked:**
1. Opening the account, KYC and liveness checks: the owner.
2. **3-D Secure for online card purchases: the cardholder (the owner), in the bank's app or with an SMS / email code.**
   No provider documents programmatic or delegated 3DS. Reading Airwallex's emailed codes automatically is technically
   possible but would hand the cardholder's authentication factor to software; it is **not** recommended.
3. Creating the API token, and any IP allow-list.
4. New payees and outbound payments through the API (where offered), which usually need in-app approval.
5. Open-banking consents, if that read route were used: re-confirm every 90 days.

Ways to see 3DS less often, without bypassing it:
- Revolut's trusted merchants;
- merchant-requested exemptions (low value, transaction-risk analysis, follow-on subscription charges).

Each prompt that does appear becomes the R7 "awaiting owner approval" state, with a P1 phone alert.

**Recommendation.**

*Phase 1: Starling, sole-trader account* (eligible for an individual today, £0 a month, no arranged overdraft, the best
documented read data). The Fleet's side:
- a **read-only** adapter in its own service: balance, feed and CSV-export scopes, optionally card lock as a kill switch,
  **no payment scopes**;
- **polling first** (about every 2 minutes, within the daily limit), which needs no new public endpoint. Signed webhooks
  later, if a public route is approved; polling stays as the safety net;
- Fleet-side holds (R2) and attribution by matching (R5/R6) on transaction id, amount, source amount, merchant and date;
- 3DS approved by the owner in the Starling app (R7).

*Phase 2, only if exact per-agent attribution or network-level limits become necessary:*
- **Revolut Business Grow** (a virtual card per agent, with references; likely needs a limited company); or
- **Airwallex** (single-use cards and remote authorisation, so a Fleet hold is enforced at the card network). 3DS still
  goes to the owner.

**Open owner choices for this rail:**
1. Provider and legal form: Starling now as a sole trader, or a limited company for Revolut / Airwallex.
2. Whether the bank balance is Fleet treasury or owner money held for the Fleet (R8; an economic-policy review).
3. Float size and top-up trigger. Top-ups from PayPal stay **manual**: no automatic personal top-ups, no overdraft.
4. Token scopes: read-only, or also card lock.
5. Polling only, or webhooks as well (a new public route needs approval).
6. Who approves 3DS and how fast, plus the timeout and any trusted merchants.
7. Reconciliation cadence, and a sample CSV export.

**What continues during a PayPal hold or limitation:**
- Bank-funded card spending continues, within the bank balance. Nothing PayPal holds becomes spendable.
- PayPal-paid actions are blocked and alerted (`RAILS_DEGRADED` / `OPS_PAYMENT_ATTENTION`).
- Refund and dispute obligations on PayPal sales **remain**. They are owed whether or not funds were moved out, and the
  Fleet keeps them as liabilities. Moving money out of PayPal does not remove PayPal's right to recover refunds or
  chargebacks from the account.

Evidence: Starling developer docs and OpenAPI, sole-trader page, fee schedule, 3DS page; Revolut Business OpenAPI
(revolut-engineering), business terms, fees, 3DS help; Airwallex issuing (lifecycle, remote authorisation, controls, 3DS,
webhooks, tokens, UK pricing); Monzo and Wise API docs; TrueLayer connection docs. All checked 2026-10-16. Links:
`docs/design/provider-research-2026-10-16.md`.
