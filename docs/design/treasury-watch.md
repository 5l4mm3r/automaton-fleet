# Treasury Watch (schema v123)

Owner instruction, 2026-10-30: the running Fleet detects and explains treasury movements without the owner reporting each one.
Status: built and tested locally. **Not deployed.** Auto-booking is off until the owner switches it on.

## 1. How it works

```
PayPal ── custody only (credential stays there) ──► fleet_paypal_transactions
   Search every 15 min, 72 h overlap, all pages      │ evidence: payer present / is self, reference, instrument
   Balances hourly · 31-day backfill slice daily     ▼
                                     svc_treasury_watch_tick (controller, every 5 min, no model call)
                                       ├ fleet_treasury_movements + append-only history
                                       ├ owner_funding journal (only by the rule in §3)
                                       ├ fleet_event → Fleet Command · fleet_notify → email / phone
                                       └ fleet_treasury_position → HQ, operator read, Fleet Control
```

It runs inside the controller. It needs no Claude session, and a restart resumes it: every step can be repeated.

## 2. What is known about PayPal, kept separate

| Fact | Field in `providerSync` |
|---|---|
| Last successful request | `search.lastOkAt`, `search.ageMinutes` |
| How far PayPal's data reaches | `search.reportedUpTo` (PayPal's `last_refreshed_datetime`) |
| Balance data as of | `balances.refreshedAt`, `balances.asOf` |
| Last transaction taken in | `lastTransactionIngestedAt` |
| Failed, rejected or incomplete reads | `search.lastHttp`, `lastErrorName`, `dropped`, `refused`, `truncated`, `pagesRead` vs `totalPages` |
| Webhooks | `webhooks.configured`, `receivedEver`, `delivering` (never "working" because configured) |

`state` is one of: `no_rail`, `never_read`, `failing`, `stale` (no good read for 2 h), `rows_lost`, `provider_data_stale` (PayPal's own data older than 6 h), `backfill_stale`, `reconciliation_open`, `needs_review`, `unmatched_receipts`, `current`.

**PayPal's documentation:** "It takes a maximum of three hours for executed transactions to appear" and the same for balances. Measured on this rail: 1 h 55, 2 h 13, 2 h 33, 3 h 34. Its docs do not define `last_refreshed_datetime`; treating it as a reach is an inference from observed behaviour (the trace of 30 Oct). Detection is therefore **not instant**.

## 3. The auto-booking policy (exact)

A movement is booked by itself as owner funding (D `fleet:treasury:unallocated`, C `fleet:owner:capital`, kind `owner_funding`) only when **all** of these hold (`fleet_treasury_topup_check`):

1. The owner has switched it on, naming the rail (`economy-treasury-watch-policy on <railId>`). Off by default.
2. The row is on that rail, and started at or after the moment it was switched on. It never reaches back.
3. PayPal's code is in the policy: default `T0300` ("Bank deposit to PayPal account"), `T0700` ("General credit card deposit"). The owner may add only `T0303`.
4. PayPal's status is `S`.
5. GBP (the accounting currency), positive net, no positive fee, net at most £500.00 (policy).
6. No checkout link and no attribution.
7. Custody supplied evidence, and PayPal names either no payer or this same account (compared with the balance report's account id).
8. It refers to no other transaction, and no other transaction refers to it.
9. No equal amount left within an hour (a card funding a purchase looks like a deposit).
10. No transfer of that amount is on its way, and the reference is unclaimed. The id does not appear under another code.
11. It was first seen at least 30 minutes ago, so a paired leg can arrive.
12. PayPal's balance, read after the transaction, exceeds what the books expect by at least the net, and its available balance covers the net.

**Failing 11 or 12** means it waits (`awaiting_evidence`), up to 24 h, then asks for a look. **Failing any other** means `needs_review`: nothing is booked, and an alert says what to do. Optional instrument fields are recorded when PayPal gives them and are never required.

**Provenance assumption:** rule 7 cannot prove who pressed "Add money". It relies on this being the owner-operated account, where the owner is the only person signed in. Someone else signed in to it could top it up, and that would book as owner funding: that is account compromise, and it does not create spendable money PayPal does not hold.

**Not funding, ever:** a card being added, a positive row with any other code, a payment from anyone, or an email.

**One booking only.** The manual route (`stage2-proof.sh fund`) and the watch use the same kind and reference, `paypal:<rail8>:<txn>`, and the ledger's unique index refuses a second one.

### Reversal

| Evidence | What happens |
|---|---|
| The row goes to `V` (or `D`) and was booked | Undone once with `owner_funding_returned` |
| A debit in `T1100/T1104/T1106/T1201/T1203/T0600` names the funded id, for the same gross | Undone once |
| Same, for a different amount | `reversal_review`: nothing automatic; alert |
| A reversal with no link | `needs_review`: alert |
| Reversed before booking | Nothing was booked; recorded |

`owner_funding_returned`: D `fleet:owner:capital` for the net; C unallocated up to what it holds; C `fleet:treasury:shortfall` for the rest. Agents' wallets are not touched. The shortfall stays visible, raises a RED alert and is filled first by later money (`fleet_treasury_shortfall_settle`). A fee PayPal keeps on a reversal is not assumed: it shows as a balance difference.

## 4. Coverage

| Movement | Handling | Status |
|---|---|---|
| Sale capture (checkout) | Linked; accounted by the existing capture path | Verified live (£1, £5) |
| Sale refund `T1107` | Linked; existing reconciliation | Verified live (£5) |
| Sale reversal `T1106/T1201`, return `T1202`, chargeback fee `T0106`, fee return `T1108/T1109`, dispute hold `T1110/T1111` | Linked; existing reconciliation | Fake provider only |
| Other debit on a sale | Linked as unclassified; existing owner classification | Fake provider only |
| Top-up `T0700` | Rule above | Code verified live on 30 Oct (the £2.50); auto-booking on fake provider only |
| Top-up `T0300` | Rule above | Fake provider only; PayPal describes it as a bank deposit |
| Other funding `T03xx`, `T0701` | `needs_review` | Fake provider only |
| Incoming payment from someone `T00xx`, no checkout | `needs_review` | Fake provider only |
| Withdrawal `T04xx` | `needs_review` unless linked to a recorded transfer or owner withdrawal | Fake provider only |
| Money-location transfer | `recorded` when its evidence names the row | Fake provider only |
| Outgoing payment `T00xx`, unlinked refund, fee, conversion `T02xx`, transfer `T20xx`, unknown code | `needs_review` | Fake provider only |
| Holds and releases `T1105`, `T15xx`, `T21xx` | `held`: nothing booked; alert | Fake provider only |
| Display-only `T98xx` | No accounting | Fake provider only |
| Status `P`, `D`, `V` | State machine above | Fake provider only. PayPal's page also lists no `F`; any other status is `needs_review` |

**Known limits**
- **Fleet-initiated payouts, card repayments and owner reimbursements** appear as `needs_review` debits, because nothing links their PayPal rows yet. Money out is off today. This must be linked before it is turned on, or every payout will alert.
- **Captures appear in movements when Search reports them**, hours later. The order itself updates sooner through the existing status polling.
- **Non-balance-affecting records** are not read. Search's default is balance-affecting only.
- **Backfill:** one 31-day slice a day re-reads the last 93 days. Nothing older is re-read, a slice over 20 pages reports `truncated`, and PayPal may still omit a row. The balance comparison is the backstop: an unexplained difference is raised after 6 h.
- **If the controller is down**, its alerts stop too. External uptime monitoring is a separate matter.
- **Multiple money locations:** with a non-PayPal location active, the books cannot be compared with PayPal alone, so rule 12 sends top-ups to review.

## 5. Webhooks: what is established

- **Delivery rules** (PayPal): a 2xx is required; up to 25 retries over 3 days; "Only events associated with the specific app will be received".
- **Nothing covers a top-up:** no event name on PayPal's list covers adding money or a personal payment. Webhooks cannot replace polling here.
- **Our record:** `fleet_paypal_webhook_inbox` has held no row, ever, and deletion is refused. So at least the 10 and 19 Oct captures produced no recorded delivery. The 10 Oct one came before the owner re-sealed the matching app's keys; the 19 Oct one did not.
- **Unexplained:** the probe's `--events` found no events, but only looked back 7 days, after those payments. v123 adds `--events-days N` to look further. PayPal does not document how long it keeps them.
- **Correction:** earlier records saying the 20 Oct refund was seen "by webhook" were wrong. The `webhook` value in `fleet_paypal_clawback_evidence.source` means "not Transaction Search".
- **Not tried:** a live delivery test needs separate approval. The simulator's mock events belong to no app and can't verify by postback.

## 6. Reconciliation and spending

The position now keeps these apart: PayPal cash, restricted by PayPal, reported but not in any balance, book allocations (unallocated, reserved, set aside, wallets), unbacked capital, what is owed to the owner, and API credit (USD, never added to GBP).

**Fleet Control** receives `fleet_treasury_control_facts()` with each spend review, read fresh at claim. It is context: a null means unknown, and neither that nor a low figure alone is grounds to hold. No decision rule changed.

### Spending gates that still rest on book balances: proposal only, nothing changed

| Gate | Decides from | Real cash checked? |
|---|---|---|
| Card request, card authorisation in `credit` mode | Agent's book cash / survival equity | No |
| Own-capital order at reservation | Book `agent_cash` | At payout issue only |
| Envelope spend | Envelope position | At payout issue only |
| Capital allocation, `fixed` sizing (default) | `fleet:treasury:unallocated` | No |
| Fleet Control AI, owner conversations | `fleet:treasury:unallocated` plus API credit | No |
| Cognition | Agent's book cash plus API credit | No |
| Payout issue, refund dispatch | PayPal free cash | **Yes**, but account-wide: it does not subtract other agents' money |

Today two wallets hold £200.00 of unbacked capital, so a card request can pass against money PayPal does not hold.

**Smallest correction (needs the owner's decision):** make `fleet_econ_card_request` also refuse when the amount exceeds `fleet_treasury_position().treasury` backing for that agent, or when reconciliation is not `reconciled`, starting with cards because the owner's own card pays first. It changes economic policy, so it is not done here.

**Breaker gap, for the same decision:** the spend breaker stops order creation and envelope spend only. It does not stop an already reserved order at issue, or card, capital, cognition, Fleet Control or refund paths.

## 7. Who sees what

| Reader | Route | Works without a session? |
|---|---|---|
| Owner, persistent | Email (classes `AMBER`, `RED`) and phone push for the same notifications, deduplicated by movement or by day | Yes |
| Owner, on demand | Fleet Command overview and Treasury page: "Treasury Watch" | Yes |
| Fleet Control | The facts above, with each review | Yes |
| Engineer, during a session | `fleet_treasury_watch` (read-only; `ops.read.treasury`; `bridge_claude` only; never ChatGPT; no PayPal credential). Facts only, and it notifies no one | No: retrieved only while a session asks |

`ops.read.treasury` needs a principal holding it. Scopes are immutable, so this means enrolling a new principal and key (owner step).

## 8. Alerts

| Code | Class | When | Deduplicated |
|---|---|---|---|
| `TREASURY_FUNDING_RECEIVED` | AMBER | A top-up was booked | Per movement |
| `TREASURY_OUTGOING` | AMBER | Material money out (default £5.00), already explained | Per movement |
| `TREASURY_NEEDS_REVIEW` | AMBER | Unknown, ambiguous or held movement; states the action | Per movement and status |
| `TREASURY_SYNC_PROBLEM` | AMBER | Search failing, stale or losing rows; PayPal's data old; backfill stopped | Per state per day |
| `TREASURY_BALANCE_UNEXPLAINED` | AMBER | PayPal and the books differ for over 6 h | Per day |
| `TREASURY_INGESTION_FAILED` | AMBER | A row could not be processed (it retries) | Per row per day |
| `TREASURY_FUNDING_REVERSED` | RED | A booked deposit was reversed, or left a shortfall | Per movement |
