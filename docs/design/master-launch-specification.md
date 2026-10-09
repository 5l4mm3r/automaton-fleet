# Automaton Fleet — Master Launch Specification (revision 3)

Status: AUTHORITATIVE for the launch candidate (2026-10-08). It supersedes revision 1 (commit f4695f6) and earlier design
notes where they conflict. The Gumroad design (`gumroad-revenue-integration.md`) remains the detailed reference for the
storefront and settlement; its G3/G4 stages are now built (v52).

**Revision 3 (2026-10-09)** records two owner decisions made on 2026-10-08 after revision 2:
- O15: PayPal Business as an individual;
- O16: the credit card, repaid weekly.

It adds schema v53 (the weekly card statement, the owner's receiving test) and UI 0.11.0.

Revision 3 also adds O17 (2026-10-09: PayPal first, the card by request) and schema v54. Nothing else changes.

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
| O9 | Shared capital is spent only under a recorded Fleet Control allocation, never per-transaction owner approval. | Completion handoff |
| O10 | The dynamic net-profit sweep, with temporary reductions that expire and revert. No fixed own-capital thresholds, no synthetic tax deductions, no £100/order or £50/day owner thresholds. | Earlier and completion handoffs |
| O11 | Document submission under the standing authority is wanted. Only genuine human-verification steps stay with the owner. | Completion handoff |
| O12 | Gumroad is one channel. 62cbe1b7 and 6178c7bb stay pending until their requirements are evidenced. | Completion handoff |
| O13 | Initial setup and live activation are separate from ordinary autonomous operation. There are no routine renewals and no recurring transaction approvals merely as a precaution. | Completion handoff |
| O14 | No forced journaling or action, no permanent opportunity weights, no compulsory study, no arbitrary business-model restrictions. | Earlier handoffs |
| O15 | The treasury PayPal stays the owner's own account — **upgraded to Business as an individual**. This is an experiment, not a company: no company, VAT or business-admin gates (live API keys and selling need a Business account; an individual one is enough). | Owner, 2026-10-08 evening |
| O17 | **PayPal first; the card is the last option.** An agent asks Fleet Control for the card only when PayPal truly cannot pay, within its own wallet. Fleet Control approves up to £100; above that the owner decides and funds the card from the treasury first. This replaces the earlier "no £100/order owner threshold" note (O10) for card use only. | Owner, 2026-10-09 |
| O16 | The card on file is the owner's **credit card**. Charges are taken from the treasury (agent wallets / allocations) at once. A **weekly card statement** lists the charges and the amount owed; the owner moves that amount from the treasury PayPal to the card and marks it paid. | Owner, 2026-10-08 evening |

### 1.2 Implementation choices (reviewable)

| # | Choice | Why |
|---|---|---|
| C1 | Agent wallets are partitions of treasury cash (`agent_cash`). Envelopes hold allocated Fleet capital separately (`agent_envelope_cash`). | Keeps own money and Fleet money distinct (O8, O9). |
| C2 | **Four keys** release money out: an owner activation, a verified live PayPal rail, a fresh custody-signer attestation, and `REAL_PAYMENTS_ENABLED=true` in custody only. | Separates setup from operation (O13) without weakening custody. |
| C3 | An activation is either **pilot** (expires, at most 90 days) or **ongoing** (no expiry; ends only when the owner ends it). Both keep per-payment and 24 h maxima as treasury risk limits. | O13: once ongoing is chosen, nothing needs renewing. |
| C4 | Before the card can be filled, a hold reserves its maximum from the agent's own spendable capital or an envelope. A statement larger than the hold is **advanced against the agent's payable** (a debt that lowers its equity), never written off as a fleet expense. | O2 + O7 + no automatic overdraft: the card really was charged, so the liability is real and belongs to the agent. |
| C5 | A card receipt is settled either **applied to the card balance** (it reduced what the fleet owes the card) or **transferred** (it reached the owner). The owner's choice of return or withdrawal is kept either way. | O2, without double-counting the card liability. |
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
   - Up to `owner_review_above_minor` (default 10000 = £100), Fleet Control approves at once. Above it the request waits
     for the owner (P1), who funds the card from the treasury first and approves with the transfer reference.
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
- card use, with per-charge and fleet-wide 24 h maxima;
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

## 11. Dashboard (UI 0.11.0; v53 adds the weekly statement and the receiving test)

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

1. **Deploy** 45 → 54 (§13). The gateway installs dormant (no token).
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
   1. a pilot custody activation with small maxima;
   2. the custody signer file;
   3. `REAL_PAYMENTS_ENABLED=true` in **custody.env only**;
   4. after a clean pilot, an **ongoing** activation (no renewals).
9. **Sweeps** (optional): enable the sweep policy.

---

## 13. Deployment and recovery

### 13.1 Compatibility

- Every component refuses any schema but its own. Production runs schema 45 with fda78a0.
- v46–v54 only **add**: new tables and columns, restated functions, and new or replaced constraints on tables with no
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
2. Run `fleet-rollout.sh rehearse <pins> 45 54` on the production copy. Expect:
   - a clean audit;
   - a verified ledger;
   - no journal or balance change;
   - no agent exhausted.
3. Run `fleet-release.sh … 45 54`. It writes one `production_deployed` event and promotes UI 0.11.0.
4. Upgrade the founders: Agent 2 first, then Founder 1.

### 13.3 Recovery (correct terms)

- **Preferred: fix forward.** A code fix on schema 54 needs no restore and loses nothing.
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
| Correct recovery terminology and plan | §13.3 | IMPLEMENTED (documentation) |

---

## 15. Genuine external dependencies

1. **The card.** The owner's credit card (O16): its number on file, and the weekly repayment (bank → card).
2. **PayPal.**
   - the treasury account upgraded to Business as an individual (O15);
   - a Live REST app, with Payouts approval;
   - a webhook subscription;
   - real readiness probes;
   - account holds and reserves are under PayPal's control.
3. **Proton.** Mail Bridge on the host (interactive sign-in), and a paid Proton plan for the shared address.
4. **Twilio.** Only if SMS or numbers are wanted: an account, plus the UK regulatory bundle.
5. **Gumroad.**
   - a seller account in the owner's true identity;
   - an OAuth application;
   - email confirmed and a payout method set;
   - Stripe identity verification (owner-only);
   - a choice of payouts to PayPal (preferred; matched automatically) or to a bank.
6. **Bank feed.** A read-only account-information provider, needed only if Gumroad pays out to a bank.
7. **Live API shapes.**
   - Gumroad: fields marked "B" in the Gumroad design are verified only by the first real probe and pilot.
   - PayPal: verified only by the first real capture and payout.
