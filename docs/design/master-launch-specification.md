# Automaton Fleet — Master Launch Specification

Status: AUTHORITATIVE for the launch candidate (2026-10-08). It supersedes earlier design notes where they conflict.
It does not replace the Gumroad design (`gumroad-revenue-integration.md`, G1/G2 built). It sets that work in the
whole system.

Scope of authority (owner, 2026-10-08):
- **Authorized:** local implementation, validation, commit and push of a reviewed candidate.
- **Not authorized:**
  - production migration;
  - enabling any live flag;
  - spending real funds;
  - submitting identity documents;
  - resolving 62cbe1b7 / 6178c7bb without evidence;
  - raising the cap or creating agents.
- Every activation in §11 is a separate, explicitly authorized step.

Status vocabulary, used everywhere in this document and in the final report:

| Status | Meaning |
|---|---|
| IMPLEMENTED | Code exists in the repository. |
| LOCALLY VERIFIED | Tests pass against a local PostgreSQL registry. |
| REHEARSED | Exercised end to end on a disposable copy (the rollout rehearsal). |
| DEPLOYED | Running on the production VPS. |
| LIVE VERIFIED | Observed working against real providers with real money or documents. |

---

## 1. What exists (production fda78a0, schema 45) and what the candidate adds

| Area | Production today | Candidate |
|---|---|---|
| Founder loop | Founder loop runs. Idle backoff is up to 32 slots and blind to events. | **Event probe** (9a866d3): a resting founder wakes at the next slot when its state changes. |
| Economy ops | ~90 `api_economy` ops: opportunity, venture, capital, identity, browser, projects… | Additions: PayPal checkout ops, card-fill ops, wallet limits visible. |
| Money out | Impossible. Two CHECK pins, no instruction issuer, and the custody flag contradiction. | Four-key activation (§4.4), a scheduled issuer, and the contradiction fixed. Default OFF. |
| Card / checkout | Absent. | Owner card as a **bypass** with a clearing liability (§5). |
| Money in | Manual owner revenue only. G1/G2 Gumroad schema is local (v46/v47). | PayPal treasury receiving: Orders v2, verified webhooks, Transaction Search reconciliation (§4). |
| Treasury view | 30-day totals only. | Per-transaction treasury list with agent attribution, per-agent filter and health (§6). |
| Identity | Owner vault exists. No connector, no browser fill of owner facts. | Agent **standing authority** to fill owner facts and card into forms, never visible to the agent. Every use logged, plus a footprint with freeze links (§7). |
| Email | Proton shared mailbox code is dormant. | One alias per agent, shown in the agent tab with credentials (§7.4). |
| Lifecycle | Reaper death only. No insolvency rule. Sweeps unscheduled. | Insolvency → dormancy → death with estate. Sweeps scheduled when enabled. Temporary sweep reductions with expiry (§8). |
| Knowledge | Fleet-wide economic notes with no PII guard. | The 52-entry library with staleness rules, PII scrubbing on shared lessons, and customer-data isolation (§9). |
| Dashboard | No onboarding for rails or credentials. | Onboarding for PayPal app credentials, card, bank and ID (sealed). Treasury list. Agent accounts / footprint / mail tab (§10). |

---

## 2. Invariants (never changed by this candidate)

1. The safety switches stay false and are read only by host processes:
   - `REAL_PAYMENTS_ENABLED`
   - `REAL_REPLICATION_ENABLED`
   - `OWNER_SWEEP_ENABLED`
   - `FLEET_DRY_RUN_CHILD`

   No SQL reads them.
2. Cap 2, DEVELOPMENT mode, replication off, no new agents.
3. The sweep is computed on **net profit**, never gross. Protected capital is obligations, runway, approved growth
   capital and contingency. Sweep rates are dynamic, and temporary reductions expire and revert. There are no fixed
   fleet-wide scoring weights, no work quotas, no own-capital thresholds, and no £100/order or £50/day owner
   thresholds.
4. Agents never approve their own capital and never see:
   - a decrypted owner fact, card number, bank detail or PayPal secret;
   - a database or controller credential.
5. Owner funding is never revenue. Card receipts kept by the owner are owner withdrawals, never agent expense.
6. Agents are not forced to journal or act. No live evidence is fabricated.
7. Runtime pinning (commit, build ID, lockfile SHA), replay protection and credential scoping are untouched.
8. **PayPal is reached only through its REST API with the owner's app credentials.** No process ever logs into
   paypal.com. The PayPal user agreement restricts robots on its site and the disclosure of passwords.

---

## 3. Owner decisions (2026-10-08)

| # | Decision | How it is realised |
|---|---|---|
| D1 | The treasury is the owner's PayPal Business account. Agent wallets are ledger sub-balances with per-agent limits. Top-ups are Fleet Control allocations. | `agent_cash` remains a partition of treasury cash. `fleet_agent_wallet_limits` adds a per-instruction and a rolling 24 h cap per agent, set by Fleet Control (owner). Top-ups are existing allocations. |
| D2 | The PayPal credit card is a **bypass**, not a source of spending. The amount is deducted from the agent (and/or treasury). The card is then repaid from the treasury. Card receipts produce an admin invoice to return the amount minus sweep, or to record a permanent withdrawal. Everything is logged. | Card-clearing ledger (§5). **PayPal offers no API to repay a PayPal Credit card**, so repayment is a tracked owner task: the dashboard shows what is outstanding and the owner records each repayment. |
| D3 | A treasury transaction list attributed per agent, with a filter, showing contribution and overall health. No third-party accounting. | `fleet_treasury_transactions` view plus `fleet_treasury_health()` (§6). |
| D4 | "Let agents have authority to use everything… my delay shouldn't put the agents' lives at risk." | A standing owner authority (`fleet_identity_autonomy`) lets agents request fills of owner facts and the card into **pinned-origin forms only**. Values are sealed to the browser worker and never reach the agent. Every use is logged with an event and a footprint entry. Revocable at any moment. |
| D5 | Footprint per agent, every step clickable, with a "freeze link" to the provider holding email and password, so the owner can cancel or close the account. | `fleet_agent_footprint` view plus a dashboard tab. The freeze link opens the account's origin, and the owner reveals the credentials through the existing step-up reveal path. |
| D6 | Email: Proton shared mailbox, one alias per agent, credentials visible in the agent tab. | v41 routing addresses. The agent tab shows the alias and the shared mailbox access entry (owner reveal). Dormant until the owner sets up Bridge (§11). |

---

## 4. PayPal treasury rail

### 4.1 What PayPal supports (official documentation, checked 2026-10-08)

**Supported**
- **Auth:** OAuth2 client credentials, token lifetime about 9 h.
- **Receiving:** Orders v2 (create → buyer approves → capture); Invoicing v2 (guest card payment); Payment Links.
- **Webhooks:**
  - Signed, with verification by postback (`/v1/notifications/verify-webhook-signature`).
  - Retried up to 25 times over 3 days.
- **Transaction Search:**
  - Lag up to 3 h; 31-day windows.
  - `transaction_id` is not globally unique, so the key is (transaction_id, event code, date).
- **Balances API.**
- **Payouts:**
  - Needs PayPal approval for the account.
  - Fee 2%, capped at £10 domestic.
  - `sender_batch_id` is idempotent for 30 days.
- **Refunds:** the original fee is kept (UK). Dispute fee £12, chargeback £14.

**NOT supported**
- Paying another merchant's checkout by API.
- A card vault usable at arbitrary merchants.
- Repaying a PayPal Credit card.
- Withdrawing to a bank or card.
- Any automation of paypal.com itself.

### 4.2 Process boundary
- **Controller.** Holds no PayPal secret. It receives webhooks on `POST /v1/webhooks/paypal` (public, size-limited,
  rate-limited) and stores them **unverified** in `fleet_paypal_webhook_inbox` (deduplicated by PayPal event id).
- **Custody executor.** The only holder of the PayPal app credential (custody vault, or sealed onboarding, §10.2). It:
  1. verifies each inbox event by postback;
  2. creates checkout orders that agents requested;
  3. captures approved orders;
  4. reconciles captures, refunds, reversals and fees against Transaction Search;
  5. posts treasury receipts;
  6. executes payouts.

  Every call is audited per credential (`cx_credential_use`).

### 4.3 Receiving (agent → customer → treasury)
1. **Agent request.** The agent calls `paypal.checkout` with: venture, description, amount, currency, and optional
   return URL.
2. **Row created.** A row is added to `fleet_paypal_checkouts` with status `requested`.
3. **Order creation.** Custody creates the order with:
   - `custom_id = <checkout id>`;
   - `invoice_id = fleet:<checkout id>`;
   - the treasury as payee.

   It records the approval link. The checkout becomes `open`, and the agent reads the link (`paypal.checkout_status`).
4. **Buyer approval.** On `CHECKOUT.ORDER.APPROVED` (verified), custody captures. Captures are idempotent through
   `PayPal-Request-Id = capture:<checkout id>`.
5. **Capture completed.** On `PAYMENT.CAPTURE.COMPLETED`, or a reconciliation match in Transaction Search, custody
   records a **PayPal receipt** keyed by `paypal:<capture id>`. It is attributed through the checkout to the agent
   and venture, and posts:
   - D agent_cash (net)
   - D agent_fees (PayPal fee)
   - C agent_revenue (gross)

   The claim key is in `fleet_revenue_claims`.
6. **Refunds and reversals.**
   - `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED` and disputes post a **paypal clawback**: from agent cash
     first, with any shortfall advanced by the treasury against the agent's payable (G2 classes).
   - A UK refund does not return the fee.
   - Dispute and chargeback fees are agent fees.
7. **Unattributed money.** Money with no checkout (for example a direct send to the treasury) is never revenue and is not
   posted anywhere: it stays an unmatched PayPal transaction (reported by reconciliation and on the dashboard) until the
   owner records it as owner funding or an agent's revenue with its reference, or closes it as not revenue.

### 4.4 Spending (treasury → payee) and the four-key activation
Payouts pay PayPal email payees through the existing signer. Instructions are issued by the reaper
(`svc_issue_due_instructions`) for every reserved order. An instruction is issued only when **all four keys** hold:

1. **Registry activation.** `fleet_custody_activation` holds an active owner activation that names:
   - a per-instruction maximum;
   - a rolling 24 h maximum;
   - an expiry.

   This replaces the v10 CHECK pin: `custody_execution_enabled` is now derived from an unexpired activation and can
   be turned on by nothing else.
2. **Live rail.** A **verified live rail**: provider `paypal`, mode `live`, every G1 readiness check for `payouts`
   verified and unexpired. The v29 "never live" pin becomes "live only for paypal, and only after readiness".
3. **Signer attestation.** A fresh custody signer attestation in live mode.
4. **Host switch.** `REAL_PAYMENTS_ENABLED=true` in the **custody executor's** environment.
   - Fix: custody previously refused to start with that flag on while live signers required it, so live custody could
     never run.
   - Now the custody executor accepts `REAL_PAYMENTS_ENABLED`; it still refuses `REAL_REPLICATION_ENABLED` and
     `OWNER_SWEEP_ENABLED`.
   - The controller's flag stays false.

The agent's wallet limits (D1) and the activation limits are checked when an instruction is issued.

### 4.5 Reconciliation
Custody pulls Transaction Search in 24 h windows with an overlap of 3 h or more. It upserts
`fleet_paypal_transactions` (keyed by transaction id, event code and date) and matches each one to a receipt, a
payout or a card repayment. The Balances API reading is recorded as `fleet_paypal_balance_observations`.

`fleet_paypal_reconcile()` reports:
- PayPal transactions with no ledger match;
- ledger receipts with no PayPal match after 6 h;
- the gap between the PayPal balance and the ledger treasury total, net of the card liability and items in flight.

---

## 5. Card bypass and card clearing (D2)

The owner's card is used only where a checkout or provider accepts nothing else. It is **not** a source of money.

| Event | Ledger (new kinds) | Notes |
|---|---|---|
| Card charge (agent fill, §7) | `card_charge`: D agent_expense (a) / C agent_cash (a); D fleet_expense (t) / C treasury_cash (t), where t is the shortfall the treasury covers; D card_cash_reserve (Y) / C card_payable (Y) | Y = the charged amount the agent declares, corrected when the owner confirms the statement amount. The cash stays in the treasury, earmarked for repayment. |
| Charge correction | `card_charge_adjust` (same lines, signed difference) | From the statement. |
| Owner repays the card (PayPal UI "Make a Payment" or Direct Debit) | `card_repayment`: D card_payable / C card_cash_reserve | Recorded by the owner with a statement reference. Not automatable: no API exists. |
| Money arrives on the card (refund or incoming payment) | `card_receipt`: D card_receipt_receivable / C agent_revenue (or a refund reversal of agent_expense) | Creates an **owner invoice**: return the amount minus the sweep share to the treasury. |
| Owner returns it | `card_receipt_return`: D agent_cash (Z − s) + D treasury_cash (s, swept as a profit contribution with D agent_contributions / C fleet_profit) / C card_receipt_receivable (Z) | Sweep s = the current dynamic sweep rate × the receipt's profit share, never more than net profit. |
| Owner keeps it | `card_receipt_withdrawal`: D owner_withdrawals / C card_receipt_receivable | A permanent owner withdrawal, logged. The agent's revenue still counts. |

- Outstanding repayment (`card_payable`) and open invoices appear in the treasury health and the dashboard.
- A card charge refuses when the agent's spendable cash plus the allowed treasury share is below the amount, or when
  identity autonomy or card fill is off.

---

## 6. Treasury transactions and health (D3)

**`fleet_treasury_transactions`** is a view over ledger journals. It has one row per journal, with:
- time, kind, direction (in / out / internal);
- agent (attributed), venture;
- gross, fee and net (cents);
- external reference;
- contribution flag.

It is filterable by agent and readable by the dashboard (`treasury_transactions`) and the hub CLI.

**`fleet_treasury_health()`** reports:
- treasury cash: unallocated, agent partitions, reserved;
- card payable and open card invoices;
- provider suspense;
- 30-day inflow, outflow and net;
- contributions per agent;
- runway (cash ÷ 30-day net burn);
- PayPal reconciliation status.

---

## 7. Identity, accounts, footprint and freeze (D4–D6)

### 7.1 Standing authority
`fleet_identity_autonomy` is a single owner row:
- enabled;
- the allowed classes;
- card allowed;
- per-use and 24 h card maxima;
- origins excluded.

It is set from the dashboard (step-up). **Default: disabled.** The owner turns it on during onboarding.

### 7.2 Owner facts and card fill
New browser fill kinds:
- `owner_fact` (class: legal_name, date_of_birth, residential_address, contact_email, contact_phone, tax_identifier,
  bank_account_owner);
- `owner_card` (number, expiry, cvc, holder; the card is a new owner vault class, `payment_card`).

Rules:
- The broker releases the value **sealed to the browser worker's one-time key**, for the session's pinned origin
  only, never to the agent.
- Each release writes `fleet_identity_uses` (agent, class, origin, account, session, time) and a `fleet_event`
  (`owner_identity_used`).
- A card fill also opens a **card charge hold**: the agent must report the amount within 24 h. Otherwise the
  declared maximum is charged to clearing, and the owner corrects it from the statement.
- Document uploads (ID image, proof of address) need a browser file-upload action. **Not in this candidate:** KYC
  document submission stays an owner action. This keeps "do not submit identity documents" true.

### 7.3 Footprint and freeze links
`fleet_agent_footprint(agent)` merges these into one timeline:
- accounts registered;
- browser sessions and actions (origin, step, outcome);
- identity uses;
- card charges;
- mail aliases.

Each account row carries a **freeze link**: the account's pinned origin (login or settings URL) plus a reveal handle.
The dashboard opens the origin in a new tab. "Reveal" shows the email and password through the existing step-up reveal
(sealed to the admin's ephemeral key, logged in `reveal_log`). An optional **freeze** action:
- marks the account `frozen` in the fleet;
- revokes the agent's use of its credential;
- records the event.

Closing the account at the provider remains the owner's click.

### 7.4 Mail
Proton shared mailbox, one routing alias per agent (v41 `mail_assign`). The agent tab shows:
- the alias;
- the mailbox access entry (reveal);
- the mail feed.

Dormant until the owner sets up Proton Bridge and `FLEET_MAIL_PROVIDER` (§11).

### 7.5 Legacy plaintext facts
`api_identity_fact` has refused every release since schema v34 (`FLEET_IDENTITY_BROKERED`): no owner value ever reaches an
agent. Agents use fills instead.

---

## 8. Operating loop and lifecycle

- **Wake.** Event probe (built). `wakeOn` remains descriptive.
- **Survival burn.** Inference plus active commitments plus phone rental, over 7 days.
- **Insolvency.** An agent whose survival equity is ≤ 0, with no pending receipt, no open envelope and no answered
  dependency in flight:
  1. becomes **dormant** (cognition refused, heartbeats continue, the owner is notified as P1);
  2. after a 72 h grace period with no change, the reaper moves it to `terminating` with cause `insolvent`;
  3. the existing estate flow then runs.

  Any receipt, allocation or owner hold cancels dormancy. This is a rule, not a quota.
- **Sweeps.** The reaper runs `svc_sweep_run` and `svc_tax_true_up` once a day **only when** `fleet_sweep_policy.enabled`
  (default false; enabling it is an activation step, §11).
- **Temporary sweep reductions.** `fleet_sweep_reductions` rows: agent, basis points, reason, start, expiry, decided_by.
  `fleet_sweep_compute` applies the largest active reduction. Expiry reverts automatically and is recorded.
  Requestable by the agent (`sweep.reduction_request`), decided by Fleet Control (owner or deterministic policy).
- **Replication and owner sweeps.** Still gated separately by three switches and the cap. Unchanged.

---

## 9. Knowledge library and customer data

- **Library.** `fleet_knowledge_library`: the 49 researched entries (8 categories), versioned, built from
  `docs/knowledge/foundational-library-v0.1.md` by `scripts/knowledge-library-build.mjs` and seeded by schema v50. Each entry carries:
  - `facts_that_change` with `verify_at` and `stale_after_days`;
  - `hard_rules`;
  - sources with licence.

  Retrieval (`economic_knowledge op library`) is by keyword or category, top-k. It **always** returns matching hard
  rules, and adds a "VERIFY BEFORE RELYING" banner when the entry is stale or unverified. Nothing is injected per turn.
- **Shared lessons.** `knowledge.record` and proposals pass `fleet_scrub_pii()`, which rejects or masks:
  - emails, phone numbers, postcodes and card-like numbers;
  - IBANs and sort codes;
  - street lines.

  The agent's own facts are untouched.
- **Customer data.** It stays in the agent's own state directory (per-OS-user isolation). The registry stores only
  counterparty hashes. Shared knowledge never contains customer identifiers.

---

## 10. Dashboard

### 10.1 Pages
- **Treasury:** the transaction list with an agent filter, health, card clearing and invoices, and reconciliation.
- **Agent → Accounts & footprint:** a timeline, freeze links, reveal and mail alias.
- **Onboarding (Settings → Money & identity):**
  1. PayPal app credentials (sealed, §10.2);
  2. rail registration and readiness checks;
  3. the card (owner vault `payment_card`, sealed in the browser);
  4. bank details (`bank_account_owner`);
  5. ID facts and documents (existing sealed upload);
  6. standing authority (§7.1);
  7. revocation and replacement of each item.

### 10.2 Sealing PayPal credentials to custody
The custody executor publishes an X25519 public key, attested like the broker key (`fleet_custody_keys`). The dashboard:
- seals `clientId:clientSecret` in the browser;
- the registry stores only the ciphertext (`fleet_custody_sealed_credentials`);
- custody unseals it into memory.

Revocation marks the credential revoked and custody drops it. The file vault remains an alternative.

---

## 11. Activation steps (each needs explicit owner authorization; nothing here is done by the candidate)

1. Deploy the candidate (schema v45 → head) with `scripts/fleet-release.sh`. Founders upgrade later.
2. Create a PayPal REST app (Live) in the owner's Business account. Request Payouts access.
3. Onboard credentials, card, bank and ID in the dashboard. Set the standing authority.
4. Register the PayPal rail. Run readiness checks (account access, sale ingestion, payout reconciliation).
5. Subscribe the PayPal webhook to `https://api.agentfleet.vip/v1/webhooks/paypal`. Record the webhook id.
6. Receive first, with `REAL_PAYMENTS_ENABLED` still false. Checkout and receipt need no money out.
7. Grant the registry activation (limits and expiry), then set `REAL_PAYMENTS_ENABLED=true` for **custody only**.
8. Proton: set up Bridge and `FLEET_MAIL_PROVIDER`, and assign aliases.
9. Optional, separately: enable the sweep policy.

Gumroad dependencies 62cbe1b7 and 6178c7bb are answered only by readiness evidence on an assigned rail. A PayPal
receiving rail can answer a "receive payments" requirement once its checks are verified.

## 12. Deferred, explicitly

- Gumroad G3 (gateway roles, storefront tools) and G4 (bank feed).
- Browser file upload and KYC document submission.
- Platform connectors.
- Persistent browser sessions.
- Replication activation.
- Operator API treasury scope.

---

## 13. Implementation status (launch candidate)

| Item | Where | Status |
|---|---|---|
| Event probe (wake on change within one slot) | `founder/mind.ts` (9a866d3) | IMPLEMENTED, LOCALLY VERIFIED |
| Four-key custody activation; live = PayPal treasury only; issuer in the reaper; wallet limits | schema v48, `service/server.ts`, `custody/main.ts` | IMPLEMENTED, LOCALLY VERIFIED |
| Custody start contradiction fixed (REAL_PAYMENTS_ENABLED is key 4, not a refusal) | `custody/main.ts`, `custody/signers.ts` | IMPLEMENTED, LOCALLY VERIFIED |
| PayPal receiving: checkouts, verified webhooks, capture, refunds, Transaction Search, balances | schema v48, `custody/paypal-treasury.ts`, `POST /v1/webhooks/paypal` | IMPLEMENTED, LOCALLY VERIFIED (fake PayPal API) |
| Card clearing: charges, statement confirmation, repayment record, receipts → invoice → return / withdrawal | schema v48 | IMPLEMENTED, LOCALLY VERIFIED |
| Treasury transaction list (per agent), treasury health, reconciliation findings | schema v48, dashboard Treasury | IMPLEMENTED, LOCALLY VERIFIED |
| Standing identity authority; owner-fact and card fills; card holds; use log | schema v49, `identity/broker.ts`, `browser/worker.ts` | IMPLEMENTED, LOCALLY VERIFIED (database + broker field extraction; no real website) |
| Footprint with freeze links and reveal; account freeze / unfreeze | schema v49, dashboard agent profile | IMPLEMENTED, LOCALLY VERIFIED |
| PayPal credentials sealed to custody from the dashboard; webhook ids on rails | schema v49, `custody/sealed-vault.ts`, dashboard Money & identity | IMPLEMENTED, LOCALLY VERIFIED |
| Insolvency dormancy (death only under an owner grace); commitment-aware burn | schema v50, reaper | IMPLEMENTED, LOCALLY VERIFIED |
| Daily net-profit sweep and tax true-up (only while the sweep policy is enabled) | reaper | IMPLEMENTED (policy remains disabled) |
| Temporary sweep reductions (request → grant → expiry) | schema v50 | IMPLEMENTED, LOCALLY VERIFIED |
| Foundational knowledge library with hard rules and stale banners | schema v50, `knowledge.library` | IMPLEMENTED, LOCALLY VERIFIED |
| PII scrubbing of shared knowledge and proposals | schema v50 | IMPLEMENTED, LOCALLY VERIFIED |
| Dashboard 0.9.0: Treasury panels, Money & identity onboarding, agent footprint | `codex-dashboard` | IMPLEMENTED, built (LIVE export), contract-tested |
| Proton per-agent aliases | v41 (existing) + footprint display | IMPLEMENTED earlier; DORMANT until Bridge is set up |
| Gumroad G3 / G4 | — | NOT BUILT (deferred, §12) |

Nothing here is REHEARSED, DEPLOYED or LIVE VERIFIED until the activation steps in §11 are authorized and run.
