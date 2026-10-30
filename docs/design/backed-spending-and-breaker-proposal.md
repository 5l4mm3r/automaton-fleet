# Proposal: backed-spending gate and a breaker that stops commitments, not obligations

**Status: proposal only. Nothing here is implemented or part of Treasury Watch (9e9ebe9).** It changes economic policy, so it needs the owner's decision. **It must be resolved before autonomous outgoing spending.** It would be its own migration, tests and release.

## The problems

1. **Spending approvals rest on book balances.** Today the two wallets hold £189.43 of book money and £200.00 of capital is unbacked, against £2.72 of real PayPal cash. A card request or an order reservation can pass against money that does not exist. Only payout issue and refund dispatch check PayPal.
2. **The card pays first.** In `credit` mode the charge lands on the owner's card; the Fleet then owes the owner. An unbacked approval is therefore the owner's money at risk.
3. **The breaker is narrower than it looks.** Tripped, it stops order creation and envelope spend only. An order already reserved still issues, and card, capital, AI and Fleet Control paths ignore it.

## The principle

| Kind | Examples | Rule |
|---|---|---|
| **New commitment** | A new card request or authorisation, order, envelope spend, capital allocation, or discretionary AI work | Needs backed money; stopped by the breaker |
| **Existing obligation** | A customer refund; delivery of what was paid for; answering a paying customer; a chargeback or reversal; repaying the owner what is already owed; settling a charge that already happened | **Never blocked by the breaker or the backing gate** |
| **Observation** | Ingestion, reconciliation, alerts, Treasury Watch | Always runs |

An obligation can still fail for a real reason: PayPal may not hold the money. That is then reported and stays owed. It is not refused as policy.

## 1. Backed-spending gate

**New function:** `fleet_backed_free_minor()` =

`PayPal available (fresh reading only) − money already committed against that cash − owner's set-aside − open reserves for known customer obligations`

It returns NULL (unknown) when the reading is stale, the books don't reconcile, or another money location prevents comparison. It builds on `fleet_treasury_liquidity`, which already handles commitments and staleness. Unknown refuses a new commitment, with a reason naming the fact.

| Gate | Change |
|---|---|
| `fleet_econ_card_request`, `fleet_econ_card_authorize` (credit mode) | Refuse above backed free money, or when unknown |
| Own-capital order, at reservation | Same |
| `fleet_econ_envelope_spend` | Same |
| `fleet_capital_decide`, `fixed` sizing | Size within backed free money (`contextual` already is) |
| Fleet Control AI, discretionary owner conversations | Reserve against backed free money |
| Agent cognition | **Decision B** |
| Payout issue, refund dispatch | No change: they already read PayPal |

**A known gap it would close:** `freeMinor` is account-wide. One agent's payout can use cash backing another's wallet. The backed figure should subtract other agents' backed balances once any wallet is backed.

**Not changed:** the agents' wallet figures, the £200 unbacked capital, survival measures and replication figures. An agent with an unbacked wallet keeps its book balance; it just can't spend real money beyond what is backed. **That is a real behaviour change:** with today's figures, every card purchase over the backed amount is refused until real money arrives.

## 2. Breaker

| Path | Today, tripped | Proposed, tripped |
|---|---|---|
| Order creation, envelope spend | Stopped | Stopped |
| Reserved order at issue | **Not stopped** | Stopped, stays reserved, released on expiry; revalidated on reset |
| Card request, card authorisation | **Not stopped** | Stopped |
| Capital allocation | **Not stopped** | Stopped |
| Discretionary Fleet Control and owner-conversation calls | **Not stopped** | **Decision C** |
| Refund dispatch (with its authority) | Not stopped | **Not stopped** |
| Booking a charge that already happened, card settlement, chargeback, reversal | Not stopped | **Not stopped** |
| Automatic delivery of a paid order | Not stopped | **Not stopped** |
| An agent answering a paying customer | Not stopped | **Not stopped** while that customer is owed |
| Repaying the owner | Owner's action | Owner's action |
| Ingestion, reconciliation, Treasury Watch | Not stopped | **Not stopped** |

A refund still needs its existing authority and PayPal cash. The breaker adds no new way to refuse it.

## 3. Tests the repair must include

- An unbacked wallet with £89.43 of book money and 22p of backed cash: a £5 card request is refused, naming the backed figure, and the wallet is unchanged.
- The same after a £10 top-up: allowed, and exact-limit cases at both sides.
- Stale reading, unreconciled books, another location active: refused as unknown; a refund is unaffected.
- Breaker tripped: each new-commitment path refused; each obligation path succeeds, including a refund with an authority and a delivery.
- Breaker tripped with a reserved order: not issued; not lost; a reset revalidates it.
- Concurrent requests cannot both spend the last backed pound.
- Reversal leaving a shortfall: backed free money falls immediately.

## 4. Decisions for the owner

- **A. Scope:** adopt the gate on all listed paths (recommended), or cards and orders first?
- **B. Agent cognition:** agents think on API credit, not PayPal cash, but the charge is against their book money. Recommended: **leave cognition out of this gate**, because it is paid from credit already bought and the daily fuse bounds it. The alternative stops unbacked agents thinking at all.
- **C. Fleet Control under a tripped breaker:** recommended: **stop spend-review calls** (nothing to review while commitments are stopped), and **keep message checks** that serve a customer.
