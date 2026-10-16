# A separate bank debit card for agent spending: integration requirements (prepared 2026-10-16; core BUILT in schema v86, not deployed, not connected)

**Status:** the core is built and tested against a simulated bank (schema v86; §9 lists what is built and what is not).
Nothing is deployed, no account is opened or connected, and the payment priority is unchanged. PayPal stays supported
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

### 8.1 Authenticating a purchase (3-D Secure / SCA): three different outcomes
Owners should not expect to approve every purchase, but nothing here bypasses authentication the card scheme requires.

1. **Frictionless.** The merchant sends EMV 3-D Secure data; the card issuer approves on its own risk assessment and nobody
   is asked. Common for familiar merchants, small amounts and consistent behaviour. Neither the Fleet nor the owner decides
   this; the issuer does each time.
2. **Exempt or out of scope:**
   - **merchant-initiated transactions** after one authenticated setup (subscriptions, renewals, metered SaaS billing): later
     charges are started by the merchant under the agreement and are usually not challenged;
   - **low-value** and **transaction-risk-analysis** exemptions requested by the merchant's payment provider (the issuer may
     still challenge);
   - **trusted beneficiaries:** a merchant the cardholder has whitelisted, where the issuer supports it (Revolut Business
     "trusted merchants").
3. **Challenged.** The issuer asks the cardholder: a push in the bank app (Starling, Revolut), or a one-time code by SMS or
   email (Airwallex). **This is the only case that needs the owner.**
   - The Fleet records it as "awaiting owner approval" (R7) with a phone alert and a timeout. The hold is never booked
     without evidence.
   - The Fleet never reads the cardholder's codes or app on the owner's behalf.

**Measured, not assumed.** Each charge records which of the three it was, where the provider's data shows it. So the owner
sees the real share of purchases that needed them, per merchant. A one-off setup approval for a subscription is expected;
repeated challenges at one merchant are a signal to change merchant or payment route, never to work around authentication.

**Other human steps (all providers):** opening the account and KYC; creating API credentials and any IP allow-list;
approving new payees or payments where the provider requires in-app approval; open-banking re-consent every 90 days, if
that route is used.

### 8.2 Against the complete autonomous-spending and reconciliation requirements (not read access alone)

| Requirement (R1–R9) | Starling (sole trader) | Revolut Business (Grow) | Airwallex (Explore) |
|---|---|---|---|
| Eligible for the legal seller as an individual sole trader | **yes** | registered business required; assume a limited company (UK sole trader unverified) | sole traders and companies (issuing for a UK sole trader: **verify with Airwallex**) |
| R1 available vs pending balance | yes (cleared / effective / pending) | one balance; pending from transactions | yes |
| R2 reservation enforced at the card network | **no**: Fleet-side holds only; card lock is the only control | per-card limits and merchant lists on agent cards (limits, not exact holds) | **yes: remote authorisation**: the Fleet approves or declines each authorisation in real time against its own hold (Airwallex must enable it) |
| A card per agent / per purchase | no API card creation | **virtual cards per agent or venture**, references copied to transactions | **virtual and single-use cards** |
| R3 authorisation → settlement, FX, fees, reversal, decline | yes (statuses, source amount, FX, settlement time) | yes (states; amount and billed amount; MCC) | yes (lifecycle: authorised → cleared / reversed / expired / declined) |
| R4 refunds linked to the charge | refund status on the feed (linking by matching) | `card_refund` type (linking by matching) | refunds linked by `lifecycle_id` |
| R5 reconciliation feed + missed-event recovery | signed webhooks (retries ~14 min) + polling `changesSince`; CSV export by API | webhooks + failed-events endpoint + `/transactions` backfill | HMAC webhooks, re-sendable; list endpoints |
| R6 attribution | by matching only (one card) | exact (card references) | exact (card per agent / purchase) |
| R7 challenges | owner's Starling app | owner's Revolut app; trusted merchants | SMS / email code to the cardholder |
| Supplier payments by bank transfer via API | to existing payees only, signed; may need review | PAY scope; drafts under approval rules need the app | available (not examined) |
| Overdraft / borrowing | none arranged; an unarranged negative balance is possible (the Fleet's drift check flags it) | — | — |
| Cost | £0/month | £35/month | £0 (or £19) /month |

**Conditional recommendation:**
- **If the legal seller stays an individual sole trader:**
  1. Airwallex, **if** it confirms issuing and remote authorisation for this seller. It is the only option where the Fleet's
     hold is enforced at the network (a single-use or per-agent card that cannot be overspent), with exact attribution.
  2. Otherwise **Starling**: read access, Fleet-side holds, attribution by matching, one shared card. Workable, but less
     autonomous: the Fleet cannot stop an over-hold charge at the network; it can only detect it and lock the card.
- **If a limited company is formed:** Airwallex as above, or Revolut Business Grow (per-agent virtual cards with references
  and limits) where its card controls suit better.
- **In every case:** PayPal stays supported and first (O17), with no automatic top-ups and no borrowing.

### 8.3 Ledger rule (owner direction 2026-10-16)
- Bank funds are **another treasury location** in the existing ledger. Agent wallets stay ledger sub-balances, attributed
  across locations.
- A **transfer** PayPal ↔ bank moves the same money: one location goes down, then (after it is in transit) the other goes
  up. It never creates capital or revenue.
- Money the **owner pays into the bank directly** is a capital contribution, recorded once with its bank reference, like
  any other owner funding.
- A location's balance is spendable only when the provider's evidence is fresh and matches the ledger. A held, stale or
  drifting location blocks spending from that location only.

### 8.4 Open owner choices for this rail
1. Legal form (sole trader now, or a limited company), then the provider: the conditional recommendation in 8.2.
2. Float size, and the top-up trigger. Top-ups stay manual: no automatic personal top-ups, no overdraft.
3. Token scopes: read-only (+ card lock); payments by API stay off unless separately approved.
4. Polling only, or webhooks as well (a new public route needs approval).
5. Who approves 3-D Secure challenges, how fast, and any trusted merchants.
6. Reconciliation cadence, and a sample CSV export.

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

## 9. Implementation status (schema v86, corrected 2026-10-16 evening; built, NOT deployed, NOT connected)

**State:** built and tested against a SIMULATED bank and a simulated Starling API. Nothing is deployed, no account is opened
or connected, no token exists.

**Tests:**
- `fleet-v86-locations-pg` (7 tests);
- `fleet-v86-bankfeed-service-pg` (the service end to end);
- `fleet-bank-statement`, `fleet-location-feed`;
- regressions: card v51 / v53 / v54, v58, v64, v77, PayPal treasury, push / operations watch, migration paths, live
  dashboard contract, privilege audit.

**How each requirement is met:**

| Requirement | How v86 does it |
|---|---|
| §8.3 one ledger, several locations | `fleet_money_locations`: the PayPal account (one per rail, automatic) and bank accounts. Treasury cash stays ONE ledger total; a location says where it is, from that provider's own evidence |
| Transfers are the same money | `location_transfer` records a transfer you made: **no journal**. The source's spendable cash drops at once. The destination's rises only when evidence shows **that** transfer arrived: (a) its reference in the bank line, or (b) PayPal's own withdrawal record (T0400, the same amount, not used by another transfer) **and** the bank line naming PayPal. Bank → PayPal: the bank's outgoing line with the reference, then PayPal's funding record (T0300). **An unrelated credit of the same amount never completes a transfer** (tested). Anything else goes to you: "this credit is transfer X" |
| Owner deposit into the bank | `location_contribution` on the bank line: owner funding, posted once against that line |
| R1 available-balance evidence | Balance readings (available, cleared, pending) with their age. Older than the location's limit (default 24 h) = stale = **nothing spendable there**. Debits seen after a reading are subtracted until the next reading |
| R2 reservation before a hold | With the card bound to a bank, a hold must fit that bank's fresh free cash (balance − Fleet holds the bank has not shown − transfers out − later debits), under the location's lock, on top of the agent's wallet check |
| R3 lifecycle, never booked at maximum | The agent's declaration books **nothing**; the bank's settled line books the bank's amount (FX kept), with **no card payable**. A decline or reversal releases the hold. After declaring, the agent can no longer void the hold |
| **Unresolved exposure** | A used hold (card filled or amount declared) the bank has not shown after 7 days is **OVERDUE, not gone**: still reserved, still counted against the bank's free cash, AMBER alert (and daily while any remain). It is released only on evidence: the bank's decline / reversal, or **your stated check** ("bank app: nothing pending; merchant cancelled"). If the merchant presents it after a release (**late settlement**, within 60 days), it is still booked, from the agent's cash, any shortfall an advance it repays, with an AMBER alert. The same money is never spendable twice. An unused hold expires at 24 h as before |
| R4 refunds and disputes | A card credit reduces the one booked charge it fits, to zero for a full refund. **Disputes:** you record one on a booked charge (nothing booked then). The bank's credit of that amount settles it (matched, or attributed by you), and the charge is reduced. Lost / withdrawn are recorded. AMBER after 30 days open |
| R5 reconciliation | Every bank line is matched or listed as unexplained (deposit / bank fee posted as a Fleet expense / explained). **Whole treasury:** each location's latest evidence (PayPal total, bank cleared) plus money in transit, against the books less unbacked capital. "Incomplete", never "reconciled", while any location is stale. AMBER `TREASURY_UNRECONCILED` when it differs by more than £1. Hourly alerts also cover stale, unexplained (> 24 h), drift, negative and limited |
| R6 attribution | Every debit charge carries agent, merchant, account, purpose and the **venture** of the merchant account |
| R7 3-D Secure (§8.1) | `card_declare` records frictionless / challenged / exempt. A challenge: the agent reports `card_awaiting_approval`, a RED `CARD_APPROVAL_NEEDED` goes to your phone, and the agent waits and never works around it. Only founder-v10 runtimes are offered the op |
| Limited / unavailable | Stops only that location (card holds on a limited bank are refused; a limited PayPal location has nothing spendable) |
| Evidence import | `economy-location-import`: Starling or generic exports. Ids come from content, so an overlapping re-export records nothing twice. `--balance` is what the bank's app shows now, never the statement's |
| **Bank feed service** | `location-feed-main` + `automaton-fleet-bankfeed.service` + `scripts/fleet-bankfeed-setup.sh` (check / install / set-token). Role `fleet_bankfeed` (rx_* only): API-fed bank locations only, never statement-only or PayPal ones. HTTPS to `api.starlingbank.com` only. A token with any non-read scope is refused before any data is read. Records lines, then the balance |
| Credit mode unchanged | With no bank bound, the owner-card path (v48–v64) is as before |

**Autonomy depends on the evidence path:**
- **With the bank feed** (connected, polling every 15 min), card purchases book from the bank's own record without you.
- **With statement imports only**, debit-card spending is **not autonomous**. A purchase books only after you import a
  statement. Until then its money stays reserved, and with a stale balance new card holds on that bank are refused.

**Added on branch `fleet/final-v2.5`** (v88 – v90; built and tested, not deployed):
- **Money that has left is always on the books (v88):**
  - a bank line is recorded even when booking fails (kept with its error, alerted, retried);
  - an unfunded charge is the agent's debt, plus a visible negative shortfall that later money fills first; nobody is
    funded;
  - statement imports go row by row.
- **Several cards (v90):** up to three card slots, each credit or debit on its own bank, with a priority and a status. A
  hold uses the card the agent names, else the first active card by priority, and the browser fills exactly that card.
- **No silent move to credit (v90):** if the first card cannot carry a hold (a debit card whose bank lacks the free cash),
  the hold is refused (FLEET_LOCATION_INSUFFICIENT). A later card stands in only if you marked it as a fallback
  (`economy-card-slot … --fallback`, or "Allow as fallback" in Money locations; off by default). A fallback purchase is
  still an ordinary purchase under the standing authority you already gave, with the same Fleet Control review.
- **A provisional chargeback reversed (v90):** the bank taking a dispute credit back puts the charge up again against the
  agent. It is matched when the bank names it, otherwise you attribute it.
- **A PayPal limitation signal (v90):**
  - PayPal's own failure codes about our account mark the PayPal location limited, so outflows wait (RED PAYPAL_LIMITED);
  - PayPal has no limitation API, so this works from evidence;
  - you re-activate the location when PayPal lifts it.

**Your choices before connecting** (§8.4):
- the bank and legal form;
- float size;
- read-only token scopes;
- who approves 3-D Secure and how fast.

Then `fleet-bankfeed-setup.sh install --apply` (sudo) and `set-token`. Then the controlled live proof (master checklist
§4 item 7).
