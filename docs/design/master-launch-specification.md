# Automaton Fleet — Master Launch Specification (revision 3)

Status: AUTHORITATIVE for the launch candidate (2026-10-08). It supersedes revision 1 (commit f4695f6) and earlier design
notes where they conflict. The Gumroad design (`gumroad-revenue-integration.md`) remains the detailed reference for the
storefront and settlement; its G3/G4 stages are now built (v52).

**Revision 3 (2026-10-09)** records two owner decisions made on 2026-10-08 after revision 2:
- O15: PayPal Business as an individual;
- O16: the credit card, repaid weekly.

It adds schema v53 (the weekly card statement, the owner's receiving test) and UI 0.11.0.

Revision 3 also adds O17 (2026-10-09: PayPal first, the card by request) and schema v54, and O18 (the survival protection
switch, schema v55).

**Revision 4 (2026-10-09 evening)** records the owner's exact words for O17 / O18 (§1.3) and adds schema v56: customer orders
and delivery, the storefront path over HTTP, truthful account creation, estates for the newer money states, refunds caught by
Transaction Search, isolated reaper passes and stricter scrubbing (§16). No owner decision changes.

**Revision 5 (2026-10-11)** records owner decision **O19** — autonomous agent spending with automated Fleet Control review
(schema v64; detailed in `autonomous-spending-review.md`). It supersedes the owner step in O9 / O13 / O17 (the £100 card
gate) and the maxima in C3 / §8 / §12, which become optional owner levers, unset by default.

**Scope of authority.** The owner authorized local implementation, validation, commit and push of a reviewed candidate.
Not authorized yet, and not done:
- production migration or deployment;
- enabling any live flag (the four safety switches stay false);
- spending real money;
- submitting documents to real providers;
- answering 62cbe1b7 / 6178c7bb without evidence;
- raising the cap or creating agents.

Every activation in §12 is a separate, explicitly authorized step.

**Status vocabulary** (used here and in every report):

| Status | Meaning |
|---|---|
| IMPLEMENTED | Code exists in the repository |
| LOCALLY VERIFIED | Tests pass against a local PostgreSQL registry (fake providers where a provider is involved) |
| REHEARSED | Exercised end to end on a disposable production copy (`fleet-rollout.sh rehearse`) |
| DEPLOYED | Running on the production VPS |
| LIVE VERIFIED | Observed working against real providers with real money or documents |

Nothing in this candidate is REHEARSED, DEPLOYED or LIVE VERIFIED.

---

## 1. Owner decisions and implementation choices

This section separates the two. An implementation choice is not presented as owner-approved; each can be changed by a
reviewed migration without re-opening an owner decision.

### 1.1 Owner decisions (2026-10-08)

| # | Decision | Source |
|---|---|---|
| O1 | The treasury is the owner's PayPal Business account. Agent wallets are ledger balances backed by it. | Handoff answers |
| O2 | The owner's card is a payment bypass, not extra agent capital. Charges are deducted from the agent (and/or the treasury), the card is repaid from the treasury, and money reaching the card becomes an admin invoice to return (minus the sweep) or keep as a withdrawal. Everything is logged. | Handoff answers; completion handoff ("explicitly authorized") |
| O3 | A treasury transaction list per agent, with a filter, contribution and health. No third-party accounting software. | Handoff answers |
| O4 | "Let agents have authority to use everything and tick the click approval — my delay shouldn't put the agents' lives at risk." Decrypted values are never shown to agents; every use is logged. | Handoff answers |
| O5 | A per-agent footprint, every step clickable, freeze links, email/password visible to the owner. | Handoff answers |
| O6 | Mail is one Proton shared mailbox, one alias per agent. | Handoff answers |
| O7 | Agents must earn to survive. **Wallet exhaustion means death**, not dormancy awaiting rescue. No automatic overdraft or bailout. | Completion handoff |
| O8 | Fleet Control is the bank: it decides capital requests automatically from evidence, economics, downside, commitments and treasury health; new agents need no profit history; it does not approve ordinary commercial decisions. | Completion handoff |
| O9 | Shared capital is spent only under a recorded Fleet Control allocation, never per-transaction owner approval. (O17's card exception, §1.3, was retired by O19: Fleet Control decides every properly funded card request.) | Completion handoff |
| O10 | The dynamic net-profit sweep, with temporary reductions that expire and revert. No fixed own-capital thresholds, no synthetic tax deductions, no £100/order or £50/day owner thresholds. | Earlier and completion handoffs |
| O11 | Document submission under the standing authority is wanted. Only genuine human-verification steps stay with the owner. | Completion handoff |
| O12 | Gumroad is one channel. 62cbe1b7 and 6178c7bb stay pending until their requirements are evidenced. | Completion handoff |
| O13 | Initial setup and live activation are separate from ordinary autonomous operation. There are no routine renewals and no recurring transaction approvals merely as a precaution. **Exception (O17, card only; retired by O19 on 2026-10-11):** a card request above £100 waits for the owner, who funds the card from the treasury first. Ordinary agent spending (PayPal payouts, envelope spend, own-capital decisions) has no owner approval and no £100 threshold. | Completion handoff |
| O14 | No forced journaling or action, no permanent opportunity weights, no compulsory study, no arbitrary business-model restrictions. | Earlier handoffs |
| O15 | The treasury PayPal stays the owner's own account — **upgraded to Business as an individual**. This is an experiment, not a company: no company, VAT or business-admin gates (live API keys and selling need a Business account; an individual one is enough). | Owner, 2026-10-08 evening |
| O18 | **Survival protection switch.** A fleet-wide owner fail-safe over "exhaustion is death": ON by default (from the cutover) — an exhausted agent is reported, not ended — until the owner goes live; shown on every dashboard page, hideable in Settings. **A setup safeguard, not the operating model:** the intended live model is O7 — actual wallet exhaustion means death. Protection is turned off ("Live") by the owner once the accounts are linked. | Owner, 2026-10-09 |
| O17 | **PayPal first; the card is the last option.** *(The £100 owner step below is superseded by O19.)* An agent asks Fleet Control for the card only when PayPal truly cannot pay, within its own wallet. Fleet Control approves up to £100; above that the owner decides and funds the card from the treasury first. This replaces the earlier "no £100/order owner threshold" note (O10) for card use only. | Owner, 2026-10-09 |
| O16 | The card on file is the owner's **credit card**. Charges are taken from the treasury (agent wallets / allocations) at once. A **weekly card statement** lists the charges and the amount owed; the owner moves that amount from the treasury PayPal to the card and marks it paid. | Owner, 2026-10-08 evening |
| O19 | **Autonomous spending, automated oversight** (2026-10-11): "run it uncapped and see how much of the leash we need to tighten". No fixed caps, wallet-percentage permission thresholds, minimum-runway rules or routine owner approvals; the £100 card gate is retired for properly funded purchases. Material or suspicious commitments get a prompt automated Fleet Control review before irreversible execution — not an owner queue; only that action is held, and only on credible evidence (risk substantially outweighing the opportunity, fraud, an invalid payment, insufficient funds). Uncertainty is not grounds to block. Reviews are treasury-paid overhead. Initial owner activation and standing authority stay. | Owner, 2026-10-11 |

### 1.3 The owner's own words (verbatim, from the session record) and their exact scope

**O17 — the card and its £100 threshold** (owner, 2026-10-09, 10:07Z; earlier the same morning: "card limits is to be weighed up
against the agents wallet, its not an open cash pool - its the last option otherwise they use their fleet.treasury paypal
accounts", and "cap is limited to the agents wallet, if wallet is higher than the requested card spendature then ill withdraw
funds from treasury/agents wallet so the card can be used"):

> "for spendatures, yes - its only if paypal is truly not available then it can reuqest to fleet control to use the card where
> fleet control will submit that to me if its more than 100gbp where ill have to withdraw from treasury before the card can be
> used - so to prevent the delay, prioritise paypal unless its the only way to proceed with a survival opportunity which then
> ill be happy to assist them with thier survival and withdraw from treasury so they can use the encrypted card"

Scope as built (v54), and nothing wider:
- it applies **only to use of the owner's card**, and only when PayPal cannot pay;
- the amount must be within the agent's own wallet (or its envelope) — the card is never an open pool;
- up to £100 Fleet Control approves at once; above £100 the owner decides and funds the card from the treasury first;
- it is **not** extended to ordinary agent spending: PayPal payouts, envelope spend and own-capital decisions have no owner
  approval and no £100 threshold (O9, O10, O13 unchanged).

**O18 — the survival protection switch and deferred founder upgrades** (owner, 2026-10-09, 10:54Z):

> "push - just update admin.agentfleet.vip - dont set agents in motion as they will die - i need to link the account and we can
> have a live toggle on and off feature that will protect agents dying with the users control which should be visible on all
> pages but not an eye sore - but visible enough to be a fail safe if the user chooses to use it"

Scope as built (v55):
- a fleet-wide owner toggle, ON from the migration (an exhausted agent is reported, not ended), shown in the header of every
  page and hideable in Settings; per-agent overrides added at the owner's request in the same session;
- the founders are **not** upgraded at cutover ("dont set agents in motion"); they stay on fda78a0 until the owner says the
  accounts are linked;
- **setup protection is not the operating model.** The intended live model is O7: actual wallet exhaustion means death. The
  owner switches protection to "Live" when the accounts are linked; from then the reaper ends an exhausted agent.

### 1.2 Implementation choices (reviewable)

| # | Choice | Why |
|---|---|---|
| C1 | Agent wallets are partitions of treasury cash (`agent_cash`). Envelopes hold allocated Fleet capital separately (`agent_envelope_cash`). | Keeps own money and Fleet money distinct (O8, O9). |
| C2 | **Four keys** release money out: an owner activation, a verified live PayPal rail, a fresh custody-signer attestation, and `REAL_PAYMENTS_ENABLED=true` in custody only. | Separates setup from operation (O13) without weakening custody. |
| C3 | An activation is either **pilot** (expires, at most 90 days) or **ongoing** (no expiry; ends only when the owner ends it). Maxima per payment and per 24 h are **optional** since v64 (O19): unset = no maximum; the owner may set them as a leash. | O13: once ongoing is chosen, nothing needs renewing. |
| C4 | Before the card can be filled, a hold reserves its maximum from the agent's own spendable capital or an envelope. A statement larger than the hold is **advanced against the agent's payable** (a debt that lowers its equity), never written off as a fleet expense. | O2 + O7 + no automatic overdraft: the card really was charged, so the liability is real and belongs to the agent. |
| C5 | A card receipt is settled either **applied to the card balance** (it reduced what the fleet owes the card) or **transferred** (it reached the owner). The owner's choice of return or withdrawal is kept either way. **v57:** on a return the swept share stays in the treasury (`fleet:treasury:unallocated`) unless the owner explicitly keeps it (an owner withdrawal; refused for card_balance). See §17. | O2, without double-counting the card liability; the existing internal sweep policy. |
| C6 | A completed PayPal capture is revenue at once, but its cash is **held** (`agent_cash_pending`) until Transaction Search shows status S and the latest Balances reading covers it. | "Distinguish captures, held funds and available capital." PayPal publishes no per-transaction availability flag we rely on. |
| C7 | One **authoritative wallet measure** (§6.1); death at the next lifecycle pass. A never-funded agent is not "exhausted". An owner hold pauses the pass for that agent. | O7. The hold is an existing, explicit owner action, not an automatic rescue. |
| C8 | When the agent's own runway (inference plus commitments) is shorter than the plan's payback, an approval comes with bounded terms (`RUNWAY_SHORTER_THAN_PAYBACK`). | O8 ("commitments"). The test is relative to the agent's own figures, not a fixed threshold. |
| C9 | Sweep-reduction requests are decided at once. A request is granted, bounded by the capital policy's existing reinvestment reduction and envelope term, when there is after-tax profit to retain and an active venture; otherwise it is declined with a reason. | O8, O10. |
| C10 | Knowledge revision 2: a **hard rule** must name its basis (law, regulator code, or a platform's own terms). Everything else is a recommendation. | O14; "distinguish sourced requirements from recommendations". |
| C11 | Gumroad payouts into the PayPal treasury are matched from PayPal's own records. Bank-directed payouts use a bank feed (provider not yet chosen) or the labelled pilot attestation. | "Do not require an external bank transfer merely because an earlier design used a bank destination." |
| C12 | Agents cannot register accounts on, or have credentials filled into, gumroad.com; the storefront is operated only through the gateway. | One owner seller account behind a broker (Gumroad design §2). |
| C13 | Proton and Twilio secrets can be sealed from the dashboard to the identity broker, which starts the provider without a restart. | O6: credentials are an onboarding dependency, not a reason to omit the integration. |
| C14 | No buyer PII from Gumroad sales is stored in the registry; agents see sale ids, amounts and states. | Data minimisation. Customer contact stays inside the agent's own operations. |

---

## 2. Invariants (unchanged)

1. **Safety switches.** The four (`REAL_PAYMENTS_ENABLED`, `REAL_REPLICATION_ENABLED`, `OWNER_SWEEP_ENABLED`,
   `FLEET_DRY_RUN_CHILD`) stay false in production and are read only by host processes. Custody accepts
   `REAL_PAYMENTS_ENABLED` as key 4 but still refuses the other two. The storefront gateway refuses to start with any of
   the four on.
2. **Fleet limits.** Cap 2, DEVELOPMENT mode, replication off, no new agents.
3. **Sweep.** The sweep is on net profit only. Protected capital is obligations, runway, approved growth capital and
   contingency.
4. **What agents never do or see.** They never approve their own capital. They never see:
   - a decrypted owner fact, document, card number or bank detail;
   - a PayPal or Gumroad secret;
   - a database or controller credential.
5. **Money integrity.** Owner funding is never revenue. One external settlement credits once (canonical claims).
6. **Agent freedom.** No live evidence is fabricated. Agents are not forced to journal or act.
7. **Runtime security.** Runtime pinning, replay protection and credential scoping are untouched.
8. **PayPal access.** PayPal is reached only through its REST API with the owner's app credentials, never by automating
   paypal.com.

---

## 3. The operating model

- **Agents** are born knowing they must earn to survive. They choose opportunities, build, market, deliver, take payment
  and spend their own capital. Unchanged:
  - their contextual opportunity ranking;
  - hibernation, with a stated reason and a wake condition;
  - action-scoped dependencies.
- **Fleet Control is the bank.** It lends Fleet capital through envelopes, decided automatically by `fleet_capital_decide`
  (deterministic, versioned, no owner branch). The possible outcomes:
  - **REJECT** — negative expected value;
  - **DEFER** — not enough evidence or liquidity;
  - **PARTIAL_APPROVE** — a first tranche plus milestones;
  - **APPROVE_WITH_LIMITS** — low confidence, a weak record, or runway shorter than payback;
  - **APPROVE** — otherwise.

  A new agent is judged on its stated confidence; a track record only calibrates later decisions. Fleet Control also
  adjusts sweeps (envelope reinvestment reductions, and temporary reductions decided at once). It does not approve
  ordinary commercial decisions, and there is no automatic overdraft or rescue.
- **How treasury interests are protected:**
  - concentration and liquidity bounds relative to the treasury;
  - envelope stop-loss;
  - the net-profit sweep;
  - card and refund debts that lower the debtor agent's equity.

---

## 4. Treasury, wallets and capital

- **Wallets.**
  - `agent_cash` is a partition of treasury money.
  - Spendable = `max(0, min(cash, survival equity))`.
  - Every debit locks the agent's accounts in a fixed order. Card reservation and booking lock cash, reserved, envelope
    and payable together.
- **Shared capital.**
  - It reaches an agent only through an envelope created by a recorded capital decision.
  - A card hold may draw on an envelope (`envelopeId`), within its available capital and single-exposure bound.
  - An envelope's position counts card reservations and charges as well as payment orders.
- **Sweeps.**
  - The rate is dynamic and net-profit only: population band, maturity and surplus.
  - From it, subtract the larger of the envelope reduction and any active temporary reduction.
  - Reductions expire and revert (recorded).
  - Card-receipt sweep shares are recorded as the agent's contribution, so the daily sweep never takes them twice.

---

## 5. Card bypass (O2)

### 5.1 The card product — owner dependency

**Verified 2026-10-08: UK PayPal Credit is unusable for the bypass.**
- It is a cardless credit line inside the PayPal wallet, with no card number.
- It works only at PayPal checkout.
- The bypass fills a card form on a merchant's site, so it needs a card number. PayPal Credit could only be used by
  operating paypal.com, which the fleet never does.

The bypass works with any card that has a number:

| Card | How charges are paid | Repayment |
|---|---|---|
| PayPal Business Debit Mastercard | From the PayPal balance (the treasury), at once | None needed: record each charge's PayPal transaction as its repayment reference. Refunds go back to the card or the PayPal balance; settle them as "applied to the card balance". |
| A credit card (any issuer) | Charged to the card | The owner repays the issuer from the treasury and records each repayment. No API repays a card. |

**Owner decision O16 (2026-10-08): a credit card.**

**Weekly statement (v53).** `fleet_card_statements` holds one statement per scheduled time:
- **Schedule:** `fleet_card_statement_policy`, default Monday 09:00 Europe/London. The reaper's `svc_card_statement_tick`
  issues it; the owner can also issue one at any time.
- **Contents:** an immutable snapshot of the charges booked in the period, and the amount owed, which is the whole
  `card_payable` at issue.
- **Paying:** "Mark as paid" (`fleet_admin_card_statement_paid`) records the v48 card repayment of that amount (never
  more than is owed now) with the owner's transfer reference.
- **Supersession:** a newer statement supersedes an unpaid older one, and only the newest can be paid.
- **Quiet weeks:** nothing charged and nothing owed issues nothing.

PayPal cannot pay a credit card directly, so the owner withdraws to the bank and pays the card from there.

### 5.2 Flow

0. **Request (v54, O17).** PayPal first. `card.request` names the merchant account and site, the amount,
   `paypalUnavailable` (`card_only_merchant` | `paypal_needs_login` | `payee_no_paypal` | `payouts_unavailable`) and the
   purpose.
   - `payouts_unavailable` is refused while the treasury can pay out (`FLEET_PAYPAL_FIRST`).
   - The agent's own spendable capital (or the named envelope) must cover the whole amount.
   - **v64 (O19):** Fleet Control decides every properly funded request. A routine request is approved at once; a material
     or suspicious one is `pending_review` until the automated review clears or holds it (a hold declines only that
     request, with its reason and evidence). `owner_review_above_minor` is retired (inert). *(v54–v63: up to £100 Fleet
     Control approved at once; above it the request waited for the owner, who funded the card first — such requests
     are still decided by the owner.)*
   - A hold needs an approved request on the same account, site and envelope, for no more than the approved amount; it
     uses the request up.
   - Booking a pre-funded charge records the owner's transfer as that charge's card repayment, once.
   - Unused requests expire (default 48 h once approved; 72 h awaiting the owner).
1. **Hold.** `card.authorize` takes the account (the merchant site), a maximum, and optionally an envelope.
   - Requires the standing authority and a card on file.
   - **Reserves** the maximum from the agent's own spendable capital, or from the envelope. If neither covers it, the hold
     is refused (`FLEET_INSUFFICIENT_FUNDS` / `FLEET_ENVELOPE_EXHAUSTED`).
   - Wallet and owner card limits, and excluded origins, apply.
2. **Fill.** `owner_card` fill steps are served only on that origin, while the hold is open. Each fill is logged.
3. **Declare.** The charge is booked from the reservation and the rest is released. If the agent never declares, the
   reaper books a used hold at its maximum and voids an unused one.
4. **Statement correction (owner).**
   - Larger: the difference comes from the agent's cash, then its envelope, then is advanced against its payable (P1
     event).
   - Smaller: the difference gives back the advance still owed, then the envelope, then cash.
   - Expense is booked once; `card_payable` and `card_cash_reserve` move by the same amount.
5. **Repayment (owner records it).** `card_payable` and `card_cash_reserve` both go down.
6. **Money reaching the card** (a refund or a genuine payout) creates an owner invoice.
   - It is settled as return or withdrawal, either applied to the card balance or transferred.
   - The suggested sweep is the dynamic rate on net profit only (zero for refunds).

A credit card generally cannot receive customer payments, and the dashboard says so. Agents take payments through PayPal
checkouts or Gumroad.

---

## 6. Survival and death (O7)

### 6.1 The authoritative wallet measure (`fleet_agent_wallet_measure`)

- **Spendable** = max(0, min(cash, survival equity)).
- **Survival equity** = cash + recoverable reservations + recoverable assets + escrow + own card holds − protected
  principal − approved obligations − payables.
- **Own money held** (counts as the agent's):
  - own-funded card holds;
  - own-funded payments in progress (reserved or executing orders);
  - PayPal captures awaiting availability;
  - PayPal captures reported PENDING;
  - money paid to the owner's card and invoiced.
- **Does not count:**
  - open or approved checkouts (prospective sales);
  - provider sales not yet received (memo);
  - Fleet envelope capital.
- **Exhausted** = all three hold:
  - the agent was funded at some point;
  - min(cash + own holds, equity) = 0;
  - none of its own money is held.

### 6.2 The lifecycle pass

The reaper passes run in this order:
1. card holds;
2. PayPal availability;
3. Gumroad-in-PayPal matching;
4. exhaustion;
5. sweep-reduction expiry.

At the exhaustion pass, each exhausted active agent is re-checked under its row and account locks. It then:
- dies with cause `insolvent` (P1 event `agent_wallet_exhausted`);
- has its credentials revoked;
- goes through the estate flow, which returns principal, cash and assets.

A receipt or allocation that commits first keeps the agent alive; one that arrives after death belongs to the estate.
There is no grace period and no bailout. An owner hold pauses the pass for that agent.

### 6.3 What agents see

Every turn's survival observation carries the wallet measure and the rule in plain words. This is information, not a gate.
`wallet survival` returns the same. v50's dormancy is retired; its setter answers `FLEET_RETIRED`.

---

## 7. Receiving and reconciliation

### 7.1 PayPal (the treasury)

| State | Evidence | Ledger |
|---|---|---|
| Prospective | Checkout open or approved | Nothing |
| Captured, held | Capture COMPLETED (verified webhook, capture response, or Transaction Search) | Revenue and fee; cash held in `agent_cash_pending` |
| Captured, pending at PayPal | Capture PENDING | Nothing yet; counts as own money held |
| Available capital | Transaction Search status S **and** the latest Balances reading (≤ 26 h old) covers the release | `paypal_funds_available`; payables are repaid first |
| Refund / reversal / dispute fee | Verified event | From the held money, then cash, then an advance against the payable |

- Money with no checkout is never revenue, unless the owner attributes it or it matches a Gumroad payout (§7.2).
- The treasury list shows the evidence and the real-cash effect of each journal; it does not prove settlement.
- `fleet_money_states()` reports each state separately, plus PayPal's withheld balance.

### 7.2 Gumroad (G3/G4, v52)

- **Gateway** — `automaton-fleet-gumroad`: role `fleet_provider`, gx_* functions only, no listener.
  - It holds the token in its own vault, written by `oauth-exchange` from stdin, with exactly
    `edit_products view_sales view_payouts`.
  - Every start re-checks the exact user and scopes (`account_access`); a wider token is refused.
  - A deny-by-default allowlist confines it to products, files, sales and payouts.
- **Agent operations** — `storefront.*`, bound to the agent's venture:
  - create a draft, and update it;
  - attach files, taken from the agent's workspace by its toolbox (the full file list is sent each time);
  - publish — a provider warning keeps the product a draft and marks `storefront_publication` failed;
  - unpublish, delete drafts, read sales and job status.

  One agent never sees another agent's products.
- **Crash-safe creation.** The permalink is fixed before creation. If the creation response is lost, the gateway adopts
  the product by that permalink. A daily reconcile flags orphaned and missing products.
- **Sales and payouts.** Both are read back from the API into memo records that never move money. The first attributed
  sale proves `sale_ingestion`.
- **Receipt evidence:**
  - **PayPal treasury destination.** The payout is matched from custody's Transaction Search records. It needs exactly one
    completed payout, status S, and a covering balance. It then posts as received (S5) and proves
    `receipt_verification` and `payout_reconciliation`.
  - **Bank destination.** A bank-feed connector reads it: role `fleet_bankfeed`, rx_* functions only, read scopes only,
    behind a provider-neutral client interface. **The account-information provider is an owner choice still to make;**
    until then the labelled pilot attestation remains.
- **No direct agent use.** Agents cannot register or fill credentials on gumroad.com (`FLEET_PROVIDER_VIA_GATEWAY`).
- **Dependencies 62cbe1b7 and 6178c7bb stay pending.**
  - They are answered only by verified readiness: `account_access` + `storefront_publication` on a rail assigned to the
    venture.
  - The answer carries the generated disclosure.
  - This happens only after real onboarding.

---

## 8. Identity, documents, footprint and freeze (O4, O5, O11)

### Standing authority

`fleet_identity_autonomy` (default off) holds:
- the fact classes agents may have filled;
- the document classes agents may have uploaded (`document_classes`: passport, driving licence, ID document, proof of
  address);
- card use, with optional per-charge and fleet-wide 24 h maxima (v64, O19: unset = no maximum);
- excluded origins.

Every change is history.

### Fills and uploads, never disclosure

1. The worker asks for a value on the session's pinned origin.
2. The registry checks the authority, origin, class, freeze state and, for the card, an open hold.
3. The broker seals the value to the worker's one-time key. A document is sent as `{contentType, dataB64}`, at most 8 MB.
4. The worker fills the value, or sets the document into the page's own file input from memory.
   - Nothing is written to disk and no screenshots are taken.
   - Snapshots redact filled values.
   - The agent never receives the value.
5. Each use writes a `fleet_identity_uses` row and an `owner_identity_used` event.

### Human-only steps stay human

These are marked `human_action_required` for that one action:
- live selfie or video liveness checks;
- CAPTCHAs;
- fresh signatures;
- in-person verification.

Known examples:
- Stripe's identity verification behind a Gumroad payout (owner-only, per Gumroad's help centre);
- any provider asking for a live selfie or video;
- opening a bank or PayPal account.

The authority never permits a false declaration; the knowledge library states this as law (Fraud Act 2006 s.2).

### Footprint

- accounts, with their origin as the open-site link;
- credential reveal (step-up, logged) and status;
- mail aliases;
- a clickable timeline of browser actions, identity uses, card charges and account events.

### Freeze

Freeze stops all local use:
- no credential, owner value, document or session is served;
- queued and waiting identity jobs stop, and new ones are refused;
- the agent cannot change the account's status.

It does **not** close or cancel the account at the provider. The result and the dashboard say so, and point to the
provider link and the revealed credentials.

---

## 9. Communication (O6)

### Mail

- **Shared mailbox:** Proton Mail Bridge on the Fleet host.
- **Per-agent routing:** each agent has aliases (`base+tag@domain`). Inbound routing is deterministic: alias, then
  conversation, then a pending verification. Outbound mail goes From the shared address, with the agent's alias as
  Reply-To.
- **Onboarding** (three owner steps):
  1. Install Bridge on the host and sign in once. This is Proton's own interactive login.
  2. Export Bridge's certificate.
  3. In the dashboard, enter the address, Bridge's generated login and the certificate. They are sealed to the broker,
     which then starts mail.
- **Dashboard status:** connection health, alias count and upload status.

### SMS

- The Twilio adapter is unchanged: live quote, cost-checked number, per-message charging.
- Its API key can also be sealed from the dashboard.
- Whether to rent numbers is the agents' own economic decision. Proton does not provide SMS.
- **Dependency:** a Twilio account, with UK regulatory bundle approval if UK numbers are wanted.

---

## 10. Knowledge and customer data (O14)

### Foundational library (49 entries), revision 2 (v51)

- Every hard rule names its basis: Law, Regulator code or Platform terms. Process advice moved to `recommendations`.
- **Removed:**
  - the invented fleet-wide "one account per platform" rule. Each platform's own account policy applies; ban evasion and
    manipulation stay prohibited because the platforms prohibit them;
  - "account creation / KYC needs operator approval" (superseded by O4);
  - the legal ban on tax and mental-health advice. These are not reserved activities, so this is now a recommendation.
- Retrieval is on request only. Nothing is injected into turns, and there is no compulsory study.

### Customer data

- Shared lessons are scrubbed of e-mails, phones, card and bank numbers, sort codes and postcodes.
- Private customer records stay in the responsible agent's own state, for its invoices and operations.

---

## 11. Dashboard (UI 0.12.0; v53 adds the weekly statement and the receiving test, v54 card requests, v55 the survival switch)

**Treasury**
- health;
- money by state;
- survival — every agent's wallet measure;
- transactions per agent;
- card clearing — repayment, and invoices settled by method;
- PayPal;
- custody activation (pilot or ongoing) and wallet limits;
- Gumroad storefront — readiness, probe, products.

**Money & identity**
1. PayPal credentials, sealed to custody;
2. the card;
3. bank details, facts and **documents** (file upload, sealed in the browser);
4. the standing authority — facts, **documents**, card;
5. **mail and SMS** — Bridge login and certificate, Twilio key, connection status.

**Agent**
- the footprint, with freeze and its note on provider-side closure.

---

## 12. Activation

Each step needs explicit owner authorization; none has been done.

1. **Deploy** 45 → 59 (§13). The gateway installs dormant (no token).
2. **PayPal:**
   1. create a Live REST app and request Payouts;
   2. seal its credentials in the dashboard;
   3. register the credential and the rail (`--mode live`);
   4. subscribe the webhook and record its id;
   5. run the readiness checks, using real probes.
3. **Receive first.** Pay one small real checkout yourself and watch it go captured → held → available.
4. **Card.** Confirm the product (§5.1), upload it, and set the standing authority with conservative maxima.
5. **Facts and documents.** Upload them and choose the document classes agents may use.
6. **Mail.** Install Bridge, sign in, and seal its login.
7. **Gumroad** (optional, separately):
   1. create the OAuth app and run `oauth-url` / `oauth-exchange`;
   2. register the provider account;
   3. run the probe and attest `storefront_publication`;
   4. assign the rail to ventures;
   5. link the PayPal treasury destination.
8. **Money out:**
   1. a pilot custody activation (maxima optional since v64 / O19; unset = no maximum — Fleet Control reviews material
      or suspicious commitments instead, `autonomous-spending-review.md`);
   2. the custody signer file;
   3. `REAL_PAYMENTS_ENABLED=true` in **custody.env only**;
   4. after a clean pilot, an **ongoing** activation (no renewals).
9. **Sweeps** (optional): enable the sweep policy.

---

## 13. Deployment and recovery

### 13.1 Compatibility

- Every component refuses any schema but its own. Production runs schema 45 with fda78a0.
- v46–v59 only **add**: new tables and columns, restated functions, and new or replaced constraints on tables with no
  production rows yet.
- **Behaviour changes for the two living agents after deploy:**
  - exhaustion is death;
  - PayPal money is held until available;
  - card holds reserve funds first.
- The rehearsal confirms both agents are funded and not exhausted before cutover.
- Founders on fda78a0 keep working against v52. The new tools (`storefront`, `wallet survival`, document upload) arrive
  with a founder runtime upgrade.

### 13.2 Deploy

1. Build on the VPS; take the pins from the build output.
2. Run `fleet-rollout.sh rehearse <pins> 45 59` on the production copy. Expect:
   - a clean audit;
   - a verified ledger;
   - no journal or balance change;
   - no agent exhausted.
3. Run `fleet-release.sh … 45 59`. It writes one `production_deployed` event and promotes UI 0.12.0.
4. Upgrade the founders — **not at cutover** (owner, 2026-10-09): only once the owner says the accounts are linked; Agent 2
   first, then Founder 1.

### 13.3 Recovery (correct terms)

- **Preferred: fix forward.** A code fix on schema 58 needs no restore and loses nothing.
- **A schema revert to 45 does not preserve newer writes in the running system.** `fleet-rollout.sh revert`:
  1. exports every post-cutover row and journal as **recovery evidence** (`*-post-cutover-*.dump`);
  2. refuses to continue until those are reconciled and acknowledged (`FLEET_REVERT_DISCARD_ACK=<journals>:<events>`);
  3. restores the pre-migration dump.

  Anything that must survive — owner funding, PayPal receipts, card records — is then **re-entered** from that evidence,
  with the same references (claims keep it single). After the revert, the system holds only what was re-entered.
- **After provider data exists, do not revert. Freeze and fix forward:**
  - disable the gumroad unit and custody's PayPal worker;
  - suspend the rails;
  - correct with reversing journals in a forward migration.

  `revert` refuses to go below v46 when provider rows exist, unless a verified provider export from the same run is named.
- **New services:**
  - the gateway and any bank-feed unit: disable first; their vaults keep the token;
  - the broker's provider vault: kept;
  - custody's sealed credentials: kept as registry ciphertext.
- **Agent state.** Workspaces, memory and journals live on the host and are untouched by schema steps. To roll back a
  founder runtime, use `fleet-founders.sh rollback-runtime`.
- **Deaths are permanent.** A revert does not resurrect a dead agent.

---

## 14. Requirement → implementation matrix

| Requirement | Where | Status |
|---|---|---|
| Spec separates owner decisions from implementation choices | §1 | IMPLEMENTED |
| PayPal treasury; wallets as backed ledger balances | v48, §4 | IMPLEMENTED, LOCALLY VERIFIED (fake PayPal) |
| Atomic balances and commitments; shared capital only via a recorded allocation | ledger locks, envelopes, card reservations (v51) | IMPLEMENTED, LOCALLY VERIFIED |
| Automatic capital decisions; no history required; commitments considered | `fleet_capital_decide` (v30 + v51) | IMPLEMENTED, LOCALLY VERIFIED |
| Dynamic sweep; temporary reductions with expiry, decided automatically | v30, v50, v51 | IMPLEMENTED, LOCALLY VERIFIED |
| Card bypass: reserve first, liability once, repayment tracked, invoice choice | v48 + v51 | IMPLEMENTED, LOCALLY VERIFIED |
| Card product and mechanisms verified | §5.1 | PayPal Credit UK verified unusable; owner chose a credit card (O16) |
| Weekly card statement, "Mark as paid" | v53 (§5.1) | IMPLEMENTED, LOCALLY VERIFIED |
| Survival protection switch (on by default; owner-only; header + Settings) | v55 (`fleet_survival_protection`, `SurvivalSwitch`) | IMPLEMENTED, LOCALLY VERIFIED |
| PayPal first; card by request (≤ £100 Fleet Control, above: owner, card pre-funded and repaid once) | v54 (`card.request`, `fleet_card_requests`) | IMPLEMENTED, LOCALLY VERIFIED |
| Owner receiving test (owner capital, never revenue) | v53, `economy-paypal-test`, Treasury → Receiving test | IMPLEMENTED, LOCALLY VERIFIED (fake PayPal) |
| Proton Bridge host setup | `scripts/fleet-proton-bridge-setup.sh` | IMPLEMENTED (syntax-checked; runs only on the host with sudo) |
| Standing authority with document upload; values never reach agents | v49 + v51, broker, browser `upload` | IMPLEMENTED, LOCALLY VERIFIED (no real provider) |
| Human-only steps identified | §8 | IMPLEMENTED |
| Exhaustion is death; authoritative measure; held money vs prospective sales | v51 (§6) | IMPLEMENTED, LOCALLY VERIFIED |
| Accurate survival observations before exhaustion | survival observation + `wallet survival` | IMPLEMENTED, LOCALLY VERIFIED |
| Revenue loop: attribution, duplicates, refunds, fees, chargebacks, liabilities | v47, v48, v51, v52 | IMPLEMENTED, LOCALLY VERIFIED |
| PayPal availability evidence; money states distinguished | v51 (§7.1) | IMPLEMENTED, LOCALLY VERIFIED |
| Gumroad G3 gateway | v52 + `src/fleet/storefront/*` + unit + setup script | IMPLEMENTED, LOCALLY VERIFIED (fake Gumroad) |
| Gumroad G4 receipt evidence | PayPal match (v52); bank-feed interface (`src/fleet/settlement/bankfeed.ts`) | PayPal path LOCALLY VERIFIED; bank feed IMPLEMENTED as an interface, **provider not chosen** |
| 62cbe1b7 / 6178c7bb stay pending | unchanged | PENDING, by design |
| Proton per-agent aliases, isolated routing, dashboard setup and status | v41 + v51 + broker hot activation + UI | IMPLEMENTED, LOCALLY VERIFIED; Bridge is a host dependency |
| SMS adapter preserved and visible | v41 + dashboard | IMPLEMENTED; a Twilio account is a dependency |
| Footprint; freeze stops local use; provider-side closure distinguished | v49 + v51 | IMPLEMENTED, LOCALLY VERIFIED |
| Knowledge: no invented rules; sourced vs recommended | revision 2 (v51) | IMPLEMENTED, LOCALLY VERIFIED |
| Activation: pilot vs ongoing; no routine renewals | v51 (§12) | IMPLEMENTED, LOCALLY VERIFIED |
| O19 autonomous spending: no caps or owner gates; contextual flags; automated Fleet Control review (hold only on credible evidence, uncertainty clears); bounded reviewer failure (stays pending, never approved); treasury-paid reviews; revalidation before execution | v64 + `src/fleet/spend/review.ts` | IMPLEMENTED, LOCALLY VERIFIED (scripted model provider); not deployed; agents see the new tool text after a founder runtime upgrade |
| Correct recovery terminology and plan | §13.3 | IMPLEMENTED (documentation) |
| Storefront product operations reach the registry over HTTP (controller allow-list of the three-part ops; workspace files beyond 32 kB) | v56 + `src/fleet/service/server.ts` | IMPLEMENTED, LOCALLY VERIFIED (founder toolbox → client → HTTP → database) |
| Customer orders: agent-isolated, buyer from PayPal's order record, payment only on PayPal's evidence, refunds reach the order | v56 (`fleet_customer_orders`, `cx_paypal_buyer_*`) | IMPLEMENTED, LOCALLY VERIFIED (fake PayPal) |
| Delivery of digital orders by mail with attachments; delivered only on provider acceptance; retries; duplicate protection | v56 + identity broker + Proton adapter | IMPLEMENTED, LOCALLY VERIFIED (simulated shared mailbox) |
| Service orders fulfilled only with evidence | v56 `order.fulfil` | IMPLEMENTED, LOCALLY VERIFIED |
| account.create truthful without a connector | v56 (`fleet_identity_connectors`) | IMPLEMENTED, LOCALLY VERIFIED |
| Estates settle the v48+ money states (held money, holds, payables, late money) | v56 | IMPLEMENTED, LOCALLY VERIFIED |
| Refunds missed by webhooks posted from Transaction Search (shortfall only); reversals raised | v56 | IMPLEMENTED, LOCALLY VERIFIED (fake PayPal) |
| Dashboard: orders; Gumroad sales, payouts and settlement | UI (MoneyPanels) | IMPLEMENTED (typecheck/lint/build) |
| Refunds / reversals / chargebacks / fees posted once from webhook + Transaction Search evidence; returns credited once | v57 (§17.1) | IMPLEMENTED, LOCALLY VERIFIED (fake PayPal) |
| Disputes, PayPal holds and unclassified debits held back from spendable (exposure), never a death on their own; ambiguity to the owner | v57 (§17.1) | IMPLEMENTED, LOCALLY VERIFIED |
| A returned card receipt's swept share goes where the owner chooses each time (treasury, or owner as a labelled withdrawal) | v57 + v58 (§17.2) | IMPLEMENTED, LOCALLY VERIFIED |
| One chargeback under several codes is one loss, never beyond the principal; one exposure per sale | v58 (§18) | IMPLEMENTED, LOCALLY VERIFIED (fake PayPal) |
| Card credit: pre-funded money not charged is recorded and pays the next charges | v58 (§18) | IMPLEMENTED, LOCALLY VERIFIED |
| No payment taken for a file the Fleet cannot deliver; undeliverable orders and unknown buyers raised with the recovery path | v58 (§18) | IMPLEMENTED, LOCALLY VERIFIED |
| Refunds initiated by the Fleet (agent's own sale or the owner): PayPal capture refund through custody, within what is refundable, idempotent, posted once from PayPal's evidence | v59 (§19) | IMPLEMENTED, LOCALLY VERIFIED (fake PayPal) |

---

## 15. Genuine external dependencies

1. **The card.** The owner's credit card (O16): its number on file, and the weekly repayment (bank → card).
2. **PayPal.**
   - the treasury account upgraded to Business as an individual (O15) — **done 2026-10-09** (account type only, not API
     readiness);
   - a Live REST app, with Payouts approval;
   - a webhook subscription;
   - real readiness probes;
   - account holds and reserves are under PayPal's control.
3. **Proton.** Mail Bridge on the host (interactive sign-in), and a paid Proton plan for the shared address. Order delivery and
   every agent e-mail depend on it: without Bridge, `order.deliver` answers `FLEET_CAPABILITY_NOT_CONFIGURED` and the order
   waits.
4. **Twilio.** Only if SMS or numbers are wanted: an account, plus the UK regulatory bundle.
5. **Gumroad.**
   - a seller account in the owner's true identity;
   - an OAuth application;
   - email confirmed and a payout method set;
   - Stripe identity verification (owner-only);
   - a choice of payouts to PayPal (preferred; matched automatically) or to a bank. **Whether this owner's Gumroad account can
     pay out to PayPal is not yet checked** (it depends on Gumroad's current payout methods for the account's country); if it
     cannot, Gumroad payouts need the bank-feed provider or the labelled pilot attestation.
6. **Bank feed.** A read-only account-information provider, needed only if Gumroad pays out to a bank.
7. **Live API shapes.**
   - Gumroad: fields marked "B" in the Gumroad design are verified only by the first real probe and pilot.
   - PayPal: verified only by the first real capture and payout.

---

## 16. Schema v56 (revision 4)

- **Orders.** `paypal.checkout` takes `fulfilment` (`digital_file` | `service`) and creates the agent's order. Payment follows
  PayPal's evidence (captured → paid; refund / reversal → refunded). Custody reads the buyer (payer e-mail, name, country)
  from PayPal's order record after capture (`cx_paypal_buyer_work` / `cx_paypal_buyer_record`).
- **Privacy.** Only the agent's own `order.list` shows the buyer; the owner's dashboard masks it; no event carries it; shared
  knowledge is scrubbed of e-mails, phones, cards, bank numbers and postcodes in any letter case.
- **Delivery.** `order.deliver` mails 1–5 workspace files (15 MB together) to the buyer from the shared address through the
  broker's ordinary `mail.send` job. The order becomes `delivered` only when the provider accepted the message. A failed send
  is retried by the reaper (15 min, 1 h, 4 h, 16 h; five attempts), one message at a time, never after a full refund.
  Duplicates are refused (an active delivery, or an already delivered order without `resendReason`).
- **Service orders.** `order.fulfil` needs a sent message to the buyer or a note of what was delivered.
- **Transport.** The controller allows the storefront's three-part op names by an explicit list; a proven session may send a
  body of up to 21 MB to `/v1/economy`; `api_economy` allows file-carrying ops a 21 MB argument (others keep 32 kB).
- **Accounts.** `account.create` answers `FLEET_NO_CONNECTOR` at once unless the broker has published a connector for that
  platform (none ships); the tool text points to `register_account` + browser.
- **Estates.** Settlement waits for held PayPal money, pending captures and open card holds; repays the payable from cash;
  writes off the rest against the treasury's advance (`estate_payable_writeoff`); money reaching a settled estate later goes
  to the treasury.
- **Refunds.** Transaction Search posts a refund (T1107) no webhook reported, for the shortfall only; a reversal or
  chargeback seen only there is raised (P1 `paypal_reversal_seen`). A REVERSED webhook linking "up" to its capture is matched.
- **Reaper.** Each lifecycle pass is isolated; a failed pass is reported; a failed sweep run is retried.
- The two items left open here are closed by v57 (§17).

---

## 17. Schema v57 — clawbacks from evidence; the card receipt's sweep (revision 4)

### 17.1 Refunds, reversals, chargebacks, dispute holds and fees

- **Evidence, not events.** Each source records what it saw for a sale: webhooks (`PAYMENT.CAPTURE.REFUNDED` / `REVERSED`, by
  PayPal's resource id) and Transaction Search (by transaction id and code: T1107 refund; T1106 / T1201 reversal or
  chargeback; T1202 chargeback reversed; T0106 chargeback fee; T1108 fee reversed; T1110 / T1111 dispute hold / release).
- **Posted once.** Per sale and group, what must have been posted is the larger of the two sources' totals (the same money
  reported by both counts once), plus the owner's classifications; only the difference from what is posted is posted
  (`fleet_paypal_clawback_reconcile`, deterministic keys). Money given back (a chargeback won, a fee reversed) is credited
  once, repaying the agent's payable first. Clawbacks posted before v57 are counted as posted.
- **Exposure, never overstated spending.** An open, lost-but-not-yet-reversed or unresolved dispute, PayPal's dispute hold,
  and a debit under a code the Fleet does not classify are **exposure**: deducted from survival equity (so spendable falls),
  and shown as the agent's own money held (`paypalDisputedMinor`), so a dispute alone never ends an agent. Exposure ends
  when the reversal is posted, the dispute is won, PayPal releases the hold, or the owner classifies the debit.
- **Ambiguity goes to the owner.** A dispute PayPal closes without a plain outcome is `unresolved` (P1) until the owner
  resolves it (`economy-paypal-dispute-resolve`, dashboard); an unclassified debit (P1) until the owner classifies it
  (`economy-paypal-debit-classify`). Custody cannot overturn the owner's resolution, and a final outcome is not reopened.
- **Setup:** subscribe the webhook also to `CUSTOMER.DISPUTE.CREATED`, `UPDATED`, `RESOLVED`.
- **Verified only against a fake PayPal:** the dispute payload fields, the code list and whether T1106 and T1201 can both
  appear for one chargeback (if they do, the reversal would be over-deducted — conservative, never overstated); checked at
  first live use.

### 17.2 Where a card receipt's swept share goes

The owner's recorded words (2026-10-08): "When money is paid to the card, an invoice goes to the admin to transfer the
amount, minus sweep, back to the treasury"; and (same day) "Apply the existing sweep/accounting policy without duplicate
revenue or duplicate sweeps". The existing policy makes the sweep an internal contribution that stays in the treasury
(`OWNER_SWEEP_ENABLED` stays false), so the owner's choice between the two is unresolved; v58 therefore asks it each time (no default):

| Settlement | Owner transfers | Agent credited | Swept share goes to |
|---|---|---|---|
| Return, transferred, sweep to the treasury (owner's choice) | the full amount | amount − share | the treasury (`fleet:treasury:unallocated`; `fleet:profit` credited) |
| Return, transferred, sweep kept by the owner (owner's choice) | amount − share | amount − share | the owner — booked as an owner withdrawal, labelled |
| Return, applied to the card balance | nothing (the card owes less) | amount − share | the treasury ("kept by me" refused) |
| Withdrawal | nothing | nothing (its contribution) | the owner — an owner withdrawal of the whole amount |

v48–v56 booked the share of every return as an owner withdrawal; no production rows exist (schema 45).

---

## 18. Schema v58 — closing corrections (revision 4)

- **Principal caps.** Per sale, refunds are capped at the gross, reversals at what refunds left, money given back at what
  was taken. One chargeback that Transaction Search reports as both T1106 and T1201 (and the webhook as REVERSED) is
  therefore one loss; the excess is reported (P3 `paypal_evidence_over_principal`), never posted. Fees are separate costs.
- **One exposure per sale.** The larger of (disputed or held principal not yet reversed) and (unclassified debits), capped
  at the principal still in the books, less what PayPal still holds back anyway. A posted reversal is the confirmed loss and
  ends the exposure for it. Exposure lowers what the agent can spend; its own money held is shown unchanged in the wallet
  measure (`ownFundsMinor`), so a hold never reads as money gone and never ends an agent by itself.
- **Card credit.** A pre-funded card request charged for less, or expired unused, leaves its transfer as card credit
  (`fleet:card:credit`, out of treasury cash); it pays the next charges automatically; `economy-card-credit-return` /
  the dashboard record moving it back.
- **Swept share.** No default destination (see §17.2).
- **Fulfilment honesty.** `paypal.checkout` with `fulfilment: digital_file` answers `FLEET_FULFILMENT_UNAVAILABLE` while mail
  is not configured (sell the file on the storefront, which delivers, or as a service). A delivery that gives up after five
  attempts, or a buyer PayPal never reveals (twelve lookups), raises P1 `order_needs_owner` with the recovery path (deliver
  another way, or refund the order — `wallet refund` / Orders → Refund, v59).
- **Send status.** A mail job the broker cannot hand to a provider is recorded as failed on its message, so a delivery is
  retried instead of waiting as "queued"; a retry that raises waits an hour without using an attempt.
- **Dashboard step-up list.** The v57 dispute / debit decisions and the v58 card-credit return are in `dash_call`'s
  sensitive list (v57 had dispatched them without listing them, so the gateway refused them).
- **First large file of a fresh session.** The client proves the session with a small read and sends the file once more.

---

## 19. Schema v59 — refunds initiated by the Fleet (revision 4)

PayPal supports full and partial refunds of a capture (Payments v2 `POST /v2/payments/captures/{capture_id}/refund`). Earlier
revisions treated refunds as manual; that was an implementation gap, not an owner decision.

- **Who:** the agent that made the sale (`wallet refund {orderId, amountMinor?, reason}`), or the owner (dashboard Orders →
  Refund with step-up; `economy-order-refund <orderId> <amountMinor|all> <reason>`). No other agent can refund it.
- **How much:** at most what the buyer paid, less refunds and reversals already posted (plus money PayPal gave back), less
  refunds in flight. Default: all of it. Refused otherwise (`FLEET_REFUND_EXCEEDS_REFUNDABLE`).
- **At once:** the amount stops being spendable (exposure), so it cannot also be spent.
- **Sending:** custody sends it under the same money-out authority as payouts — a live owner custody activation and, for a
  live rail, `REAL_PAYMENTS_ENABLED` in custody — with one `PayPal-Request-Id` per request, so a retry is the same refund.
  Before money-out is activated a request waits (and says so); the rail must carry the `refunds` capability.
- **Accounting, once:** PayPal's answer (the refund id) is recorded as the same evidence PayPal's `PAYMENT.CAPTURE.REFUNDED`
  webhook gives, and its Transaction Search row is reconciled by the v57/v58 rules — whichever arrives first posts it,
  the others post nothing. The order shows the refund; the agent's wallet and estate follow.
- **Outcomes:** completed → posted; pending → completed by PayPal's webhook / Search; refused (4xx) → the request fails, the
  reserve is released (P2 `order_refund_failed`); unknown (5xx / timeout) → sent again after ten minutes with the same id.
- **Not covered:** Gumroad sales are refunded in Gumroad (the gateway's token deliberately has no refund scope).


---

## 20. Schema v65, Charter v6, Field Guide v2 (revision 6, 2026-10-12)

Consolidated with v64 into one 63 → 65 candidate (`docs/evaluations/launch-candidate/launch-checklist-v65.md`). Not deployed.

- **Advertising review (contextual, no fixed gate).** An ad commitment (payee category `advertising`, or a card charge at
  an ad platform's origin) raises the review signal `advertising_beyond_experiment` only when the agent has not been
  profitable over 60 days and the commitment plus its 30-day ad spend exceeds `ad_experiment_bp` (default 5 %) of its
  available funds. The signal asks Fleet Control to weigh campaign evidence, aggregate commitment, profitability, downside
  and runway; it is not a cap, and it holds only on credible evidence (O19). The 2.5–5 % range is guidance in the Field Guide.
- **Shared-lesson review.** Fleet Control reviews each knowledge proposal against the promotion rule (repeated evidence,
  reliable sources or a generalisable mechanism; nothing unlawful, deceptive, personal or secret; no duplicates) and promotes
  or rejects it with a reason (`promoted_by = 'fleet_control'`). The proposal is fenced as untrusted text. Failures back off;
  after the policy's attempts the proposal is visibly stalled (P1 `knowledge_review_stalled`) — never decided by default.
  Costs are treasury overhead (`knowledge_review_charge`). The owner's CLI review still works.
- **Gumroad unlock.** Per agent, the first time its wallet reaches £500, permanently (`fleet_channel_unlocks`, immutable;
  P3 `channel_unlocked`). Before that `fleet_storefront_enqueue` refuses with `FLEET_STOREFRONT_LOCKED`.
- **Business project folders.** `fleet_admin_business_folders(agent)`: wallet and peak, unlocks, one folder per venture
  (financials, accounts with credential ids and kinds only, mail, products, orders, payees) and general records. Values only
  through the existing protected owner reveal; nothing secret is read into the folder, a model input or a log.
- **Charter v6 and attested toolsets.** Doctrine `founder-v6` (charter v5 + edits B1–B6: one steady, wallet-conscious standard;
  no reports or journaling rituals). The controller serves `founder-v6` only to a runtime whose pinned release tree contains the
  `doctrine-v6` marker; otherwise `FLEET_DOCTRINE_INCOMPATIBLE`. Tools follow the doctrine: toolset-1 (v5 runtimes) withholds
  `fleet_capital spend_reviews` and `field_guide all`, which those runtimes cannot execute; toolset-2 (v6) offers both.
- **Field Guide v2.0** (founder runtime): 18 sections; venture types as contextual choices; ads as small experiments that scale
  on evidence; refunds within customer rights and provider rules; regulated activities follow their real authorisation
  requirements; accurate memory model (no claim of permanent model learning); sealed owner details only within standing
  authority; human-only blockers escalated with priority matched to urgency.

## 21. Schema v66 — backing the existing capital (revision 6, 2026-10-12)

- The first agents' capital (2 × £100) was recorded before any money moved (`owner-authorized-virtual:` owner funding); their
  AI costs were paid from the owner's prepaid provider credit, outside the GBP ledger (v21). The books therefore hold cash
  the treasury does not: **unbacked = virtual owner capital − provider-paid charges (inference, owner conversation, Fleet
  Control reviews) − backed**, never below zero (£181.76 on 2026-10-12).
- `fleet_admin_capital_back` (owner; dashboard step-up `capital_back`; CLI `economy-capital-back`): a completed PayPal deposit
  in the books' currency backs that capital. The backed part posts nothing (the money is already in the books); any part
  beyond the unbacked amount is ordinary owner funding (one journal, same key). The transaction closes as
  `capital_backing`; its key `paypal:txn:<id>` can never be recorded again (funding, attribution, a second backing). Backings
  are append-only history; P3 `capital_backed`.
- `fleet_capital_backing()` / dashboard *Capital backing*: virtual, provider-paid, backed, unbacked, cash in the books, the
  latest verified PayPal balance and the difference (PayPal − (books − unbacked); 0 = reconciled). After full backing,
  further provider-paid AI costs show as a positive difference (PayPal holds money the books no longer count): repaying the
  owner's provider credit from the treasury is not modelled.
- The owner-prepaid AI credit connection is closed by v69 (§24, reimbursable).

## 22. Schema v67 — the business foundation and prompt wake-ups (revision 6, 2026-10-12)

- **One authoritative business source.** `docs/knowledge/business-foundation-v1.md` (owner text §3–§23 integrated with the
  Field Guide v2 doctrine it overlapped, plus cash and settlement states, AI-cost attribution and failure fuses, net-profit
  sweeps, fraud, untrusted content, delivery commitments and evidence-based stop/pivot/scale) generates 32
  `business-foundation` entries and one dated `fleet-status` entry (`fleet-capability-status`, facts stale after 14 days; the
  Gumroad £500 / EU-route question labelled UNRESOLVED). Stable ids, cross-references, dated primary sources, examples
  labelled HYPOTHETICAL. §1 and §2 (owner text, 2026-10-12) open the reading path.
- **Reading (instructed, not tracked).** Charter v6 and the Field Guide instruct agents to read the whole foundation once (at
  birth and when its version changes) through `knowledge.library {path: "foundation", part}` — whole entries in order,
  ≤ 7 000 characters per part — to keep a short summary with `remember_fact`, and to retrieve sections afterwards. The
  runtime does not record whether an agent did so: this is instructed behaviour, not guaranteed execution. Reading is never
  described as permanent learning.
- **Field Guide v2.1** keeps Fleet operating orientation; its business doctrine sections (survival cycle, tactics, venture
  types, customers/ads, refunds, scams) are pointers to the library, so each rule is maintained once. Runtime change.
- **Wake-ups.** `fleet_agent_attention.eventsDigest` covers inbound mail, card requests, spend reviews, Fleet Control notices,
  lesson reviews and disputes; the v67 founder runtime adds it to its wake digest, so these wake a hibernating agent within
  one thinking slot (previously up to the 24 h safety re-check). The owner's pause is unchanged: a paused agent wakes for
  nothing; changes are seen on the first slot after resume.
- Retiring promoted lessons: closed by v68 (§23).

## 23. Schema v68 — correcting promoted lessons; telling a woken agent what happened (revision 6, 2026-10-12)

- **Supersession through the lesson-review path.** Fleet Control's reviewer sees the current shared lessons with their ids and,
  when it promotes a correction, names the lessons it replaces (`supersedes`). Promoted lessons stay immutable; an
  append-only `fleet_knowledge_supersessions` row records old → new with the reason (P3 `knowledge_superseded`). Current =
  not superseded. `read_knowledge` returns the latest current lessons (each with what it replaced) and the recently retired
  ones with their replacement, so the agent sees a correction without rereading anything; a supersession wakes every agent
  (it may have copied the old lesson into its own notes). The owner's CLI review does not supersede.
- **What woke you.** `fleet_agent_attention.recentEvents` (14 days, ≤ 20): kind, id, status, time and the retrieving tool for
  inbound mail, card requests, spend reviews, lesson reviews, superseded lessons and disputes — no subjects or bodies. The
  runtime adds one line to the wake packet with the events since its last turn. Verified through the real event paths
  (broker mail, a spend review opened and decided, an owner card decision, a PayPal dispute, a lesson review and a
  supersession).
- Ships as one coordinated release with v66 and v67 (65 → 68) plus the founder runtime upgrade.

## 24. Schema v69 — owner-funded AI credit is reimbursable (owner decision, 2026-10-12)

- Every AI charge (inference, owner conversation, spend review, lesson review — all five posting paths, including the legacy
  unrouted one) also posts D `fleet:treasury:owner_reimbursable` (a treasury-cash partition, never allocatable) / C
  `fleet:owner:payable` (liability `owner_payable`): the money stays in the treasury and is owed to the owner. The expense is
  recognised once, at use; purchases stay USD provider events (never expensed, no GBP asset, no revaluation — the owner is
  owed the GBP cost charged at each call's controlled rate).
- One opening journal (`ai_credit_owner_payable_opening`) brings in the AI costs charged before v69 (production: 1,824p). The
  owner records it once after the cutover (`economy-ai-credit-opening` or the Capital backing panel, step-up): a migration
  never posts a journal, and the rollout refuses one that moves the ledger head.
- v66 backing: AI costs no longer reduce what must be backed; unbacked = capital recorded without money − backed (production:
  £200.00 once the opening is recorded; £181.76 before it), and the backing view shows the owner payable (£18.24).
- Not included: paying the owner back (a separate, authorised owner withdrawal from the reimbursable partition).
- Scope: owner-funded credit is the initial-setup model; treasury-funded AI credit is §25 (v70).

## 25. Schema v70 — AI provider credit by funding source (2026-10-12; in code, not deployed)

- Lots by source: owner (recorded purchases, positive adjustments, the opening balance) and treasury (recorded only with the
  treasury PayPal account's completed GBP debit as evidence — one purchase per transaction and per provider receipt — booked
  D `fleet:ai_credits` / C treasury cash). Every provider-credit consumption event draws lots oldest first (a trigger, so
  every AI charge path is covered without restating it).
- Treasury-drawn consumption is reclassified minutely (lifecycle pass `svc_ai_credit_settle`): D owner payable / C
  owner-reimbursable partition and D treasury unallocated / C `fleet:ai_credits`, at the charge's controlled rate, in whole
  pence, bounded by what charges have posted. A used-up lot's GBP cost against consumption is posted as
  `ai_credit_cost_settlement` (FX); a negative adjustment on a treasury lot is `ai_credit_unexplained_usage` at cost.
- Invariants: the expense is recognised once (at charge; purchases never expensed); the owner payable equals owner-funded use;
  the asset returns to zero when a lot is used up. The capital-backing identity is unaffected (a purchase lowers books cash and
  PayPal by the same amount).
- Not automatic: purchases and the provider's auto-reload happen at the provider (card per its official help; PayPal not
  confirmed) and are recorded by the owner. The capability entry v2 (agents on the event-waking runtime; AI cost wording)
  loads with v70.

## 26. Schema v71 — AI-credit purchases: provisional observations, verified promotion (2026-10-12; in code, not deployed)

- The provider exposes no credit-balance, purchase or auto-reload interface (Admin API: usage and cost only; unavailable to
  individual accounts). Two signals are observed: provider receipts e-mailed to a Fleet mailbox (`fleet_ai_credit_receipts`,
  one per receipt number; unauthenticated) and treasury PayPal debits with their counterparty (custody requests `payer_info`;
  `cx_paypal_txn_counterparty`). Both are provisional: no credit, lot, owner liability or estimated amount.
- Promotion (`fleet_ai_credit_promote`) needs evidence linking purchase, amount and funding source: automatically on the
  treasury route only for an unambiguous one-receipt ↔ one-debit match (counterparty, window, implied rate are aids), in
  either order, once; otherwise reconciliation (P2 `ai_credit_reconcile`). The owner confirms (`fleet_admin_ai_credit_confirm`,
  owner-funded or naming the treasury debit) or rejects. The owner_card route always needs confirmation.
- Usage beyond confirmed credit is an unallocated draw (owed to the owner by default) absorbed oldest first by the next
  confirmed purchase (`fleet_ai_credit_absorptions`); a treasury purchase reclassifies exactly that usage.
- No automatic purchasing in the Fleet; the provider's auto-reload is the purchasing mechanism; the AI gate reads confirmed
  credit only. Capability entry v3: agents' own AI work costs their wallets; owner-conversation turns cost the treasury.

## 27. Schema v72 — AI-credit acquisition cost allocated by consumption (owner option (a), 2026-10-12; not deployed)

- Each lot carries its acquisition cost from evidence: a receipt-promoted lot takes the receipt's total (tax / fees) against
  the credit bought; other lots (the opening pool, manual purchases) take it only when the owner records it from their
  receipts (`fleet_admin_ai_credit_lot_cost`). No rate is assumed.
- The minutely settlement prices each consumption draw's share ((total − credit) / credit × its GBP value) and posts it to the
  caller: the responsible agent for autonomous work (agent expense / agent cash); the treasury for owner-conversation turns and
  Fleet Control reviews (Fleet expense). Funding side by lot: owner-funded → owed to the owner; treasury-funded → the prepaid
  asset (its settlement then keeps only the FX difference). One recognition per cost component.
- Console reconciliation (`fleet_admin_ai_credit_balance_reconcile`): more credit than recorded is over-recorded usage,
  restored to the lots it was drawn from (newest first; before v70 the opening pool); less is drawn as an adjustment;
  anything unplaceable is reported (P2), never given a funding source. A generic positive adjustment no longer creates an
  owner lot. Library: capability status v4 and bf-ai-costs v2 tell agents their AI cost includes the tax share.

## 28. Schema v73 — one-time historical acquisition-cost correction (owner instruction, 2026-10-12)
v72 prices the tax / fees only on consumption drawn from a lot. AI charges made before the lots existed (the calls the v69
opening owes to the owner at the pre-tax price) had no tax share. `fleet_admin_ai_credit_historical_cost <provider> <credit>
<total> <evidence>` recognises it once:
- rate: the opening pool's evidenced ratio (receipts' total vs credit), which must reproduce the acquisition cost already
  recorded on that lot; refused before the lot's cost and before the v69 opening;
- base: each historical AI-charge journal's recognised pre-tax expense; the pre-tax charge is never recognised again;
- payer: the original attribution — agent inference → that agent (postings, agent and its cognition records agree, and the
  call is the lot's provider); Fleet Control reviews and treasury-paid owner turns → the treasury (cognition records, or
  for a review the controller's own consumption of that provider within the hour before it). Anything else is reported
  (`unattributed`, plus a P2 `ai_credit_reconcile` reason `historical_unattributed`), never posted;
- posting: each share joins the opening pool's per-payer accrual and v72's cost pass posts whole pence (D payer expense /
  C payer cash; D treasury owner-reimbursable / C owner payable), remainders carried as for any draw;
- once: `fleet_ai_credit_historical_costs` (one row per corrected journal) and `fleet_ai_credit_historical_runs` (a single
  row); a second call returns the first run. `fleet_ai_credit_historical_preview` is read-only.
- Also: the v66 – v72 capital-backing and AI-credit commands are routed from `fleet:admin` (they had handlers but no route).

## 29. Schema v74 — pre-launch test costs written off; explicit launch boundary (owner decisions, 2026-10-13)
"Agents don't owe me anything for testing fees"; the £21.87 AI-credit payable is waived as contributed capital; future
reimbursement stays separate from fee withdrawals; an explicit launch boundary rather than "any resume".
- Launch boundary: `economy-launch-boundary-record <note>` (owner, once, immutable; P2 event). Pausing or resuming an agent
  never sets or moves it.
- `economy-ai-credit-test-period-writeoff` covers the AI-cost journals recorded before the boundary (before now while none
  is recorded), each journal at most once (it may run again before launch; never past the boundary): agents' AI cost →
  Fleet expense (D agent cash / C agent expense; D Fleet expense / C treasury unallocated — recognised once, moved); the
  owner payable those journals created → contributed capital (D owner payable / C owner capital) with the held cash
  released (D treasury unallocated / C owner-reimbursable); sub-penny tax carried for that usage waived (recorded).
  `economy-ai-credit-test-period-preview` is read-only. The capital to back is unchanged.
- After the boundary: owner-funded AI credit is owed to the owner as used (v69) and reimbursed only by its own authorised
  owner payment — never netted against fee withdrawals; agents bear their own work (v72).

## 30. Schema v76 — the market-facing loop (owner brief, 2026-10-14; in code, not deployed)
Owner brief: agents must be able to sell real work — offers, more than one skill, demand research, channels, a production
toolchain, a fulfilment loop with a quality gate, and the knowledge to use them — in one release. Header of
`src/fleet/postgres/migrations-phase76.ts` is the authoritative summary; this section records the decisions.
- **Payment detection without the webhook.** Custody reads every open checkout's status (`GET /v2/checkout/orders/{id}`,
  backed off; `cx_paypal_status_*`): APPROVED → captured, COMPLETED → read back, VOIDED → failed, each through the same
  duplicate-safe capture record. The webhook remains the fast path (it is still 404 on the live app — owner fix pending).
- **Offers** (`fleet_offers`, `fleet_offer_files`): products and services with customer, deliverables, price, turnaround,
  revisions, terms and an optional capacity. Publishing needs evidence, never a claim: a product publishes on a passing
  review of exactly its files; a service on a passing review of a real work sample. Changing a published product's files
  pauses it until a review of the new files republishes it. Publishing also needs the public site set
  (`economy-public-site <origin> <seller notice>`, owner), a receiving rail and the agent's mailbox.
- **Public pages** (`src/fleet/service/public-pages.ts`, served by the controller through validating service-role `svc_*`
  functions): `/o/<slug>`, buy → a fresh checkout and `/order/<token>` (PayPal returns there), service briefs with up to 3
  reference files → `/enquiry/<token>`. 256-bit bearer tokens, per-origin rate limits, same-origin POSTs, strict CSP,
  files as downloads with nosniff; every page says an AI agent produces and fulfils the work.
- **Enquiries and messages**: one thread per enquiry / order; a buyer's brief or message wakes the agent (attention digest);
  the agent clarifies, quotes (a checkout of the quoted price, capacity respected) or declines. A buyer's file reaches the
  agent's workspace under a safe name as untrusted data — the model gets the path, never the bytes.
- **The review gate** (`fleet_artifact_reviews`, immutable): the files' SHA-256s, the inspector's report run by the runtime
  in the sandbox (`fleet-qa-1`, `src/fleet/founder/qa/inspector.ts`, report validated by the registry against the same
  files), 3..30 criteria checked against the brief, an optional independent model review (a real routed call of the agent,
  checked in its cognition log, within 6 hours), verdict. A pass needs no automated failure, every criterion met and no
  failed independent review. A model's approval alone is never the gate.
- **Delivery**: needs a passing review of exactly the delivered bytes against the current requirements (a buyer message
  after the review makes it stale). Up to 10 files (15 MB each, 60 MB together, staged one per call); attached when they fit
  in 15 MB, otherwise a link; downloadable from the order page for 30 days. A paid product is delivered automatically from
  its reviewed files (`svc_offer_tick`).
- **Toolchain** (b9d39d3): 22 hash-pinned wheels (`toolchain/agent-tools.lock.json`; XLSX, DOCX, PDF, images, recalculation,
  spelling) installed by `scripts/fleet-agent-tools.sh` (fail-closed digests, tree digest) under
  `/usr/local/lib/automaton-fleet-tools/<lock12>`; exposed read+execute to the exec sandbox only (Landlock).
- **Founder-v7** (Charter v7, toolset-3): tools `offer`, `customers`, `deliverable` (inspect / review / reviews) and
  `independent_review`, classified `planning` (no new authority; the database dispatch enforces every op). Reaches agents
  only through a founder runtime upgrade.
- **Knowledge**: business foundation v2 (`docs/knowledge/business-foundation-v2.md`; initial market focus, several offers,
  demonstrated capability, quality procedures, channels, the fulfilment loop; capability status v5). Channels:
  `docs/marketplaces/channel-assessment-2026-10-14.md` (Etsy assessed, not built; Gumroad still deferred).
- **Owner view**: UI 0.19.0 Offers panel (dashboard reads `offers`, `customer_enquiries`); `hub-offers`, `hub-enquiries`.
- Nothing in v76 moves money on its own, changes a live flag or grants authority. Payment, revenue and fulfilment stay
  distinct.

| Requirement | Where | Status |
|---|---|---|
| Payment detected without the webhook (status reads, duplicate-safe) | v76 `cx_paypal_status_*`, custody worker | IMPLEMENTED, LOCALLY VERIFIED (fake PayPal) |
| Offers publish only on evidence; changed files pause a product | v76 `offer.*` | IMPLEMENTED, LOCALLY VERIFIED |
| Public offer / order / enquiry pages, isolated per buyer token | `public-pages.ts`, `svc_*` | IMPLEMENTED, LOCALLY VERIFIED |
| Briefs with files, clarify / quote / decline, capacity, revisions | v76 `enquiry.*`, `order.message` | IMPLEMENTED, LOCALLY VERIFIED |
| Review gate bound to the exact bytes and the inspector's report | v76 `review.record`, `fleet-qa-1` | IMPLEMENTED, LOCALLY VERIFIED (real inspector, sandboxed) |
| Staged / link delivery, 30-day downloads, automatic product delivery | v76 `order.stage_file`, `order.deliver`, `svc_offer_tick` | IMPLEMENTED, LOCALLY VERIFIED (simulated shared mailbox) |
| End to end: agent builds a workbook, a defect is caught, the fix is reviewed, published, bought, delivered byte-identical | `fleet-v76-e2e-spreadsheet-pg.test.ts` | LOCALLY VERIFIED (simulated buyer; fake PayPal) |
| Founder-v7 tools advertised and classified (no unclassified tool) | `cognition/types.ts`, `capabilities.ts`, drift guard | IMPLEMENTED, LOCALLY VERIFIED |
| Pinned production toolchain for agents | `toolchain/`, `scripts/fleet-agent-tools.sh` | IMPLEMENTED, dev install verified; **host install pending (sudo)** |
| Business foundation v2 loaded; reading path | v76 + knowledge build | IMPLEMENTED, LOCALLY VERIFIED |
| Owner view of offers and enquiries | UI 0.19.0, hub commands | IMPLEMENTED (typecheck/lint/build pending in the release pass) |

Remaining before release: VPS build matching the local build, rehearsal 75 → 76, founder runtime upgrade rehearsal to v7,
toolchain host install, public-site origin and seller notice set by the owner, and the edge route for `/o/`, `/order/`,
`/enquiry/` verified on the public origin.
