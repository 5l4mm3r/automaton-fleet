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
