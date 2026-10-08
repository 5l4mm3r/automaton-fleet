# Gumroad revenue integration: design (revision 2, 2026-10-08)

**Status: a design for review. Nothing is built or deployed.**
- Production is unchanged.
- No account, product, rail, credential, receipt connector or dependency decision was created, stored or made.
- No money moved.
- Baseline: deployed `fda78a0`, schema head **v45** (`src/fleet/postgres/migrations.ts:57`). The proposed migrations
  start at **v46**.
- Supersedes revision 1 (`cef41ad`). Readiness context: `docs/evaluations/r41-1/fda78a0/gumroad-readiness.md`.

**Constraints this design keeps**
- Gumroad is the founders' **current choice** of channel, not a fleet restriction. A blocked action blocks only that
  action.
- Opportunities and own-capital decisions stay agent-determined. No study, journaling, activity quota, opportunity
  weight or fixed spend-approval threshold is added.
- R41.1's live observations are still open. Journal persistence and an event-triggered full wake await legitimate
  activity. Event detection can be delayed by up to about 32 minutes by the existing idle skip.
- `REAL_PAYMENTS_ENABLED`, `OWNER_SWEEP_ENABLED`, `REAL_REPLICATION_ENABLED` and `FLEET_DRY_RUN_CHILD` stay
  **false**. Live external spending stays disabled. Cap 2 and DEVELOPMENT mode are unchanged.

## Change summary (relative to cef41ad)

1. **Settlement is automatic by design.** Owner confirmation of each payout was a permanent gate; it is replaced by a
   read-only **receipt connector** on the fleet treasury account. Owner attestation remains only as an explicitly
   labelled, time-limited **pilot fallback** (§4.5).
2. **Five money states,** plus a rule that bank receipt is not agent capital unless it lands in a registered
   **fleet-treasury destination** (§4).
3. **Currency corrected from the source.**
   - Payout transaction rows are **USD**.
   - A UK bank payout is reported in the **payout currency**.
   - Gumroad itself omits the balancing row for non-USD payouts.
   - So the GBP allocation per sale **cannot be derived exactly**. It is a stated convention with completeness tests,
     and anything else is quarantined (§5).
4. **Tax corrected:** the API `price` **excludes** Gumroad-collected tax (B) (§5.1).
5. **Receive-only security model added** as its own capability. It traces every outgoing path, with enforcement and
   tests. Provider scope enforcement was **checked in Gumroad's code**, not assumed (§6).
6. **Isolation added:** per-operation ownership checks, and crash-safe product creation with no orphans (§7).
7. **Readiness capabilities split** into six independently evidenced capabilities. Each pending request's
   satisfaction and its required disclosure are defined, with no deadlock (§8).
8. **New ledger classes:** fleet-scoped `provider_suspense` for quarantined real money, and agent-scoped
   `agent_provider_payable` for post-settlement reversals. Plus revenue and receipt **claims** against double credit
   across retries, ingestion, manual recording and later owner funding (§5.6).
9. **Stages renumbered,** with the first stage runnable locally without owner decisions (§10, §13). Rollback hardened
   so that a downgrade can never silently drop provider evidence or liabilities (§11).

---

## 1. Sources and how facts are marked

- **(A)** Published Gumroad text, read from the repository files that publish it: Terms ("Last Updated September
  14, 2026"), the help centre, API docs and the Ping page. Repository: `antiwork/gumroad` at commit
  `6d535ea88e2c3b7d2983c011d5716e0416739b1f` (2026-10-08).
  - `app/views/home/terms.html.erb` → https://gumroad.com/terms
  - `app/views/help_center/articles/contents/_N-*.html.erb` → https://gumroad.com/help/article/N-…
  - `app/javascript/components/ApiDocumentation/**` → https://gumroad.com/api
  - `app/javascript/pages/Public/Ping.tsx` → https://gumroad.com/ping
- **(B)** Inferred from Gumroad's application code at the same commit. Not a published guarantee; may change.
- **(F)** Fleet code at `fda78a0`. `pN` = `src/fleet/postgres/migrations-phaseN.ts`.

**Fact register.** Facts used below, with their basis:

| # | Fact | Basis |
|---|---|---|
| F1 | "You may not share your Account or password with anyone"; no account "on behalf of someone other than yourself"; more than one account only "for genuinely separate brands or businesses" | A, Terms §4.4 |
| F2 | "Regardless of listed currency, all transactions through the Services will settle in USD" | A, Terms §9 |
| F3 | Gumroad is merchant of record for indirect tax; prices are "exclusive of any applicable Indirect Tax" | A, Terms §6.2, §10.7; `_121`, `_10` |
| F4 | Sale `price` / `gumroad_fee` are "in USD cents" | A, `Ping.tsx` |
| F5 | API `price` = `price_cents`, which **excludes** Gumroad-collected tax: charge = `price_cents + gumroad_tax_cents (+ shipping)` | B, `app/models/purchase.rb:1023, 4718-4722` |
| F6 | Payout JSON `amount` = `amount_cents / 100` in the **payout's** `currency`; for a Stripe payout, `currency = payout_currency` | B, `app/models/payment.rb:396-407`; `app/business/payments/payouts/processor/stripe/stripe_payout_processor.rb:330-420` (assignments at +73, +84). The published example shows `"currency": "EUR"` (A, `Payouts.tsx`) |
| F7 | Payout `transactions` rows (type, date, purchase_id, taxes, shipping, sale_price, gumroad_fees, net_total) are built from USD purchase amounts. The balancing "Technical Adjustment" is added **only for USD payouts**: "We don't include non-usd payments here since the currency mismatch…" | B, `app/services/exports/payouts/api.rb`, `…/base.rb:27-170` |
| F8 | Row types include sale, Full/Partial Refund (with retained fee), Chargeback, Credit, Refund fee written off, Failed Refund Fee Returned/Retained, affiliate credit, Payout Fee, Technical Adjustment, and PayPal/Stripe-Connect summaries | B, `…/base.rb:50-170, 218-330` |
| F9 | `include_sales` gives `sales[]`, `refunded_sales[]`, `disputed_sales[]` ids per payout | A, `Payouts.tsx`; B, `payment.rb:409-413` |
| F10 | Conversion to the local payout currency happens "at the time of sale, not at the time of the payout"; ≥7-day hold; $100 minimum until verified, $10 after | A, `_13` |
| F11 | Refunds need balance; a negative balance may be debited from the bank; chargeback = full refund plus processing fees, platform fee returned; reserve of 25% for 90 days above a 15% refund rate | A, `_47`, `_269`, `_134`; Terms §7, §11.3 |
| F12 | Ping and resource subscriptions are **unsigned**; "treat a ping as a trigger … read the sale back through the API, and reconcile periodically"; ordering not guaranteed; dedupe on `sale_id` + `resource_name` | A, `Ping.tsx`, `ResourceSubscriptions.tsx` |
| F13 | Every v2 scope check also accepts the legacy `account` scope | B, `app/controllers/api/v2/base_controller.rb:7-9` |
| F14 | Refund needs `refund_sales`, `edit_sales` or `account`; sales reads need `view_sales`; payouts endpoints need `view_payouts` and are **index / show / upcoming only**; product, file and offer writes need `edit_products` | B, `sales_controller.rb:5-8`, `payouts_controller.rb:6-67`, `links_controller.rb:43`, `files_controller.rb:4` |
| F15 | A self-generated token gets the application's scopes, and applications default to **all public scopes including `account` and `edit_sales`**. An OAuth authorisation request can ask for fewer | B, `app/models/oauth_application.rb:15, 70-74, 121-122`; `config/initializers/doorkeeper.rb:9-11, 41-42`. A, `_280`: the token exchange returns `scope` |
| F16 | `/oauth/token/info` is routed (Doorkeeper default) | B, `config/routes.rb:43-47` |
| F17 | No sandbox. A test purchase is buying your own product while logged in, with the "Test card". It is not in `GET /sales` and not paid out; a ping with `test: true` is sent. Real-card self-purchase "appears exactly the same as money laundering" | A, `_62`, `_281`; B, `purchase.rb` |
| F18 | Linked "New Gumroad" accounts can "copy your existing payout setup". Each gets a **new** Stripe Connect account; identity verification is owner-only | A, `_252`, `_326`; B, `app/services/user/create_brand_account_service.rb:20` |
| F19 | File upload: presign → PUT parts → complete → attach by `files[][url]`; URLs are S3 presigned | A, `Files.tsx`; B, `files_controller.rb:23-83` |
| F20 | `POST /v2/products` publishes unless "email address is not confirmed or no payout method is set up", in which case it saves a draft with a `warning` | A, `Products.tsx:420-428` |

**Unresolved** (none blocks stage G1; each has a safe default below)
- U1: whether a linked account's new Connect account needs its own ID verification.
- U2: the exact GBP `amount` and `currency` strings the API returns for a UK bank payout. F6 is B-only.
- U3: the S3 host names in presigned URLs.
- U4: the Stripe statement descriptor on a Gumroad bank credit.
- U5: whether `brand_accounts` is enabled for the owner's account.
- U6: whether any dashboard automation is acceptable. The design avoids needing it.

---

## 2. Account arrangement (proposal)

**Proposed: one owner seller account, used only through a fleet broker.** Recorded as an owner decision (§12).

| | One shared account behind the broker | Linked account per venture |
|---|---|---|
| Terms (F1) | One account operated by its holder through an API the holder authorised | Needs genuinely separate brands; owner's judgement |
| Isolation between agents | **The broker enforces it** (§7). Agents never hold a token | The account boundary enforces it, but agents must still never hold a token, so the broker is needed anyway |
| Payouts | One balance and threshold; per-purchase allocation from payout rows (F7, F9) | One Connect account, balance and threshold per venture (F18). Each small venture waits for its own $100 |
| Human verification | One account holder (F18, owner-only) | **U1 unresolved**: possibly once per Connect account |
| Attribution | The broker's product mapping (§7.2) | `seller_id` |
| Failure blast radius | One token: the broker's scopes and op allowlist limit it (§6) | One token per account |
| Products cannot be moved between accounts (A, `_252`) | Choose before publishing | Choose before publishing |

**Account linking, payout reuse and human verification are separate questions:**
- **Linking:** "New Gumroad" where offered, otherwise support (A). Feature-flagged (B, U5).
- **Payout reuse:** copies the payout setup (A). The bank account is reset to unverified, and a **new** Connect
  account is created (B).
- **Human verification:** Stripe asks "after a certain amount of time has passed and sales accrued" (A, `_13`).
  Owner-only (A, `_326`). **No source supports "KYC happens only once"** across linked accounts. That claim is
  withdrawn.

---

## 3. Components

| Unit | Role |
|---|---|
| `automaton-fleet-gumroad` (new) | Holds the Gumroad token in its own vault. Executes allowlisted Gumroad calls (§6.3) from a job queue. Polls sales and payouts. Own OS user, own DB role `fleet_provider` with `gx_*` functions only, no inbound port. |
| `automaton-fleet-bankfeed` (new, receipt connector) | Holds a **read-only** bank-data credential for the fleet-treasury account. Reads incoming and outgoing transactions. Own OS user, own DB role `fleet_bankfeed` with `rx_*` functions only, no inbound port. **No payment-initiation scope ever.** |
| Controller (existing) | Agent operations `storefront.*` (capability `planning`): queues gateway jobs, enforces ownership, serves memo views. Never sees a token. |
| Owner CLI (existing `fleet:admin`) | Rails, destinations, verification, assignments, pilot fallback, quarantine resolution. |

- Separate units keep two independent secrets (the selling token and the bank-read credential) apart from each
  other and from the controller.
- The controller cannot read any vault today (F: the custody path is inaccessible in the controller unit, and the
  identity broker vault is separate).
- **Why not reuse the identity broker or the fetcher:** the broker holds the owner's identity vault, and the fetcher
  cannot carry authorization headers (F, `research/fetcher.ts:1-16`).
- **Polling, not webhooks, in phase 1.**
  - The gateway lists `GET /v2/sales?after=<watermark − 2 days>` and `GET /v2/payouts?include_upcoming=true` every
    5–10 minutes, and reconciles fully every day.
  - Webhooks are unsigned triggers (F12). They would need a new public route on the edge, which is new exposure and a
    separate owner decision.

---

## 4. Money states, settlement and autonomy

### 4.1 Five states

| State | Evidence that it is reached | Recorded as | Agent-spendable |
|---|---|---|---|
| **S1 verified sale** | `GET /v2/sales/:id` read back by the gateway, never from a ping (F12) | `fleet_provider_sales` memo (USD) | no |
| **S2 provider balance (unsettled)** | verified, not yet in a payout; includes held, reserved and withheld amounts (F10, F11) | memo state `in_balance` / `held` | no |
| **S3 payout reported sent** | `GET /v2/payouts/:id`, status `completed`, plus membership (F9) and rows (F7) | `fleet_provider_payouts` memo | no |
| **S4 money received** | **trusted receipt evidence** (4.3) that the payout's amount arrived in a registered destination | `fleet_settlement_receipts` | no |
| **S5 accessible capital** | S4 in a destination of kind **`fleet_treasury`**, plus a complete allocation (§5) | ledger: agent shares to `agent_cash`; unallocated remainder to `provider_suspense` | yes, the allocated shares only, through the existing `LEAST(cash, equity)` rule (p11:353-387; p42 restate) |

### 4.2 Destinations: owner bank receipt is not agent capital

**Why this matters.** In the fleet's books, agent cash is backed by the treasury:
- owner money enters as `owner_funding` (D `treasury_cash` / C `owner_capital`, p10:177);
- it reaches an agent as `genesis_allocation` (D `agent_cash` / C `treasury_cash`, p11:262);
- `external_revenue` credits `agent_cash` **with no treasury leg** (p10:189). That is truthful only if the money is
  really in the fleet's custody.

**The design.**
- New table `fleet_settlement_destinations`:
  - `kind` is `fleet_treasury` or `owner_external`;
  - a masked bank reference that is matched against the payout's `bank_account_visual` (A, `Payouts.tsx`);
  - a legal entity;
  - the bank-feed credential reference.
- **Only an S4 receipt into a `fleet_treasury` destination can reach S5.**
- A receipt into an `owner_external` account stays at S4 as "received, held by owner". It becomes S5 only when the
  bank feed sees the matching inbound transfer into the fleet-treasury account. That posts `provider_receipt_transfer`
  and **claims** both the original receipt and the transfer (§5.6).
- Owner funding of the same money is refused, so it cannot be funded twice.

### 4.3 Trusted receipt evidence and the connector

- **Evidence:** a bank-feed transaction on the destination account, read by `automaton-fleet-bankfeed` through a
  read-only account-information consent the owner grants to a regulated provider (owner decision, §12).
- **Stored per receipt:**
  - the bank transaction id;
  - booking date;
  - amount and currency;
  - counterparty descriptor;
  - `payload_sha256`;
  - the connector's fetch time.
- **Matching** (`rx_receipt_match`, automatic). Exactly one candidate must satisfy **all** of:
  - same currency as the payout;
  - amount equal to the payout amount (an exact minor-unit match);
  - booking date within [`processed_at`, `processed_at` + 7 business days];
  - not already claimed;
  - a descriptor that matches the destination's configured pattern (U4: set by the owner from the first real
    receipt, then fixed).
- **Outcomes:**
  - none, or more than one, candidate → `receipt_unmatched` / `receipt_ambiguous`. The payout stays at S3 and
    reconcile raises a WARN, and then a FAIL after 14 days;
  - a debit matching a negative provider balance → a **negative receipt** (§5.5).
- **No owner step is needed in steady state.** Reconciliation runs on every poll.

### 4.4 Allocation and backing at S5

At S5, a single journal set is posted per payout receipt, idempotent on the receipt claim:
- **Agents' shares:** `provider_revenue_receipt` per agent: D `agent_cash` (net share), D `agent_fees` (fee share),
  C `agent_revenue` (gross share). This is the same shape as `venture_sale` (p29:222); the treasury account now really
  holds the money.
- **Unallocated or quarantined part:** `provider_receipt_suspense`: D `treasury_cash` / C `provider_suspense`.
  - New fleet-scoped class, credit-normal, non-spendable.
  - Real money in the treasury account that belongs to no agent yet.
- **Later resolution of a quarantined part:** `provider_suspense_allocation`: D `provider_suspense` / C
  `treasury_cash`, and D `agent_cash` / C `agent_revenue`.
- **Conservation:** for every receipt, Σ agent net shares + suspense = the receipt amount exactly, in minor units.

### 4.5 Pilot fallback: owner attestation, explicitly labelled

Used only if the bank-feed connector is not yet available when the live pilot starts.

- `fleet:admin storefront-receipt-attest <payout> <amount> <currency> <booked-on>` records an S4 receipt with
  `evidence_kind = 'owner_attested'`. It never records a bank transaction id.
- **It credits `agent_cash` only while an explicit pilot authorisation is active.** That authorisation is the row
  `fleet_pilot_authorisations(kind 'receipt_attestation', expires_at ≤ 30 days, granted_by)`, written by its own owner
  command.
- It also credits cash only if the amount equals the provider-reported payout exactly. Otherwise the whole amount
  goes to `provider_suspense`.
- Attested amounts carry provenance `owner_attested` in `fleet_revenue_provenance`. They are shown as
  "attested, not independently verified" to founders and in the dashboard.
- Unattested or mismatched amounts stay non-spendable.
- **Removing the fallback:**
  1. deploy the bank-feed connector;
  2. run three consecutive payouts matched automatically, with the attestations agreeing;
  3. then `storefront-receipt-attest` refuses once a `fleet_treasury` destination has an active bank-feed credential,
     and the pilot authorisation cannot be renewed (enforced in SQL).

---

## 5. Currency and accounting

### 5.1 Units and sources

| Amount | Source | Unit / currency | Basis |
|---|---|---|---|
| Sale price, Gumroad fee | `GET /v2/sales/:id` `price`, `gumroad_fee` | USD minor units | F4, F2 |
| Listing currency | sale `currency` | ISO code, informational only | B |
| Tax | `tax_cents`, `tax_label` | memo only; Gumroad is merchant of record, so tax is excluded from revenue | F3, F5 |
| Payout amount | `GET /v2/payouts/:id` `amount`, `currency` | the **payout currency** as reported (GBP expected for a UK bank, U2) | F6 |
| Payout rows | `include_transactions` | **USD**, decimal strings converted to integer minor units with an exact decimal parse | F7 |
| Receipt | bank feed | the destination account's currency, minor units | §4.3 |

**Rules for amounts**
- **No conversion happens in the fleet.** The GBP that reaches the ledger is always the **received** amount.
- The `price` field must not be treated as including tax (F5).
- Unknown currencies, unparsable amounts and missing fields → the payout is **quarantined**. Nothing is posted to
  agents.

### 5.2 Payout membership and completeness (pre-allocation checks, all required)

1. Every `sales[]` / `refunded_sales[]` / `disputed_sales[]` id and every row's `purchase_id` resolves to an S1 memo
   row.
2. Every row type is in the known set (F8). Each row type has a handling rule (5.4).
3. **USD payout:** Σ row `net_total` must equal `amount` exactly. Gumroad adds a "Technical Adjustment" row for USD
   payouts; it is treated as an unattributed row (5.4).
4. **Non-USD payout:** the implied rate `amount / Σ net_total` must lie within ±3% of `fleet_fx_latest('USD', <payout
   currency>)` (p21:194-198).
   - This is a **sanity bound only**. It is never used to convert.
   - The ±3% figure is an accounting tolerance, not a spend threshold. It is adjustable only by a reviewed migration.
5. Σ row net > 0, or the payout is negative (5.5).

If any check fails, the **whole** payout goes to `provider_suspense` when it is received. Reconcile shows the reason.

### 5.3 Allocation convention for a non-USD payout

- **Why a convention is needed.** Gumroad converts each sale "at the time of sale" (F10). It does not expose the
  per-sale local amounts in the API, and it omits the balancing row for non-USD payouts (F7). So **a per-sale GBP
  figure cannot be derived from the published data.**
- **The rule.** For agent *a*:
  `share_a = R × N_a / N`
  - R = received amount in minor units;
  - N_a = Σ USD net of agent *a*'s rows (signed);
  - N = Σ USD net of all attributed rows.
  - Rounding: largest remainder, deterministic order by agent id; Σ shares = R exactly.
- **What it implies.** It is exact in total and approximate per agent, by the FX movement between the sale dates in
  one payout. The method is stated to founders ("allocated pro rata in USD net").
- Fee and gross shares use the same ratio over `gumroad_fees` and `sale_price`.
- **USD payouts** allocate exactly, by row.

### 5.4 Row handling

| Row | Handling |
|---|---|
| Sale | + to the purchase's agent |
| Full / Partial Refund | − to the purchase's agent. Includes the retained fee, so the fee is not returned (A, `_66`) |
| Chargeback | − to the purchase's agent; the platform fee is returned (A, `_134`) |
| Credit with a purchase, e.g. dispute won | + to the purchase's agent |
| Refund fee written off, Failed Refund Fee Returned/Retained | ± to the purchase's agent |
| Affiliate credit | − to the purchase's agent (no affiliates are planned) |
| Payout Fee | split across agents with positive shares, pro rata. Stated rule |
| Credit without a purchase, Technical Adjustment, PayPal/Connect summary rows, unknown types | quarantine: the matching amount goes to `provider_suspense` until the owner resolves it with `storefront-suspense-allocate`, which records an event and needs a reason |

### 5.5 Partial payouts, reserves, withheld funds and negatives

- **Partial payouts, reserves, holds, skipped payout days:** membership comes only from F9 and rows. Verified sales
  that are not in a payout stay S2 (`held` when Gumroad reports a reserve or review). They are never posted.
- **A negative share for one agent within a payout:** it is netted inside the allocation.
  - If an agent's share is < 0, post `provider_clawback`: D `agent_revenue` / C `agent_cash`, up to its cash.
  - The remainder goes to D `agent_revenue` / C **`agent_provider_payable`**. This is a new agent-scoped liability,
    included as an obligation in equity (p42 restate). It lowers expensePurchasingCapacity without touching other
    agents.
  - It is repaid first from that agent's next positive shares.
- **A negative balance debited from the bank (F11):** the bank feed sees the debit and it becomes a **negative
  receipt**. It is allocated by the same rules to the owning agents' cash, and to payables where cash is short. An
  unattributable part goes D `provider_suspense` (C `treasury_cash`). If `provider_suspense` cannot absorb it, it is
  posted as `fleet_expense` with reason `provider_debit_unattributed`.
- **Books stay balanced:** every journal is balanced by the existing rules check (p10:272-287). Per receipt:
  Σ agent cash deltas + Σ payable deltas + suspense delta = the signed receipt.

### 5.6 Double-credit protection

New table `fleet_revenue_claims (claim_key PRIMARY KEY, kind, journal_id, created_at)`. It is immutable and is the
single unique namespace:

| Claimer | Claim key |
|---|---|
| provider payout settlement | `gumroad:<user_id>:payout:<payout_id>` |
| bank receipt | `bank:<destination_id>:txn:<bank_txn_id>` |
| owner attestation | `gumroad:<user_id>:payout:<payout_id>` (the same key, so attestation and the feed cannot both post) |
| transfer from `owner_external` into the treasury | `bank:<treasury_dest>:txn:<id>` and the original receipt key |
| manual `ledger-record-revenue` | new required `--claims <key>` when the counterparty hash matches any active storefront destination or provider account; refused if the key is taken |
| `ledger-record-funding` (owner capital) | refused if its external ref or bank transaction id is a claimed receipt key. Reconcile also flags owner funding within ±3 days and the same amount as an unclaimed matched receipt (`FUNDING_MATCHES_PROVIDER_RECEIPT`, WARN) |

**Retries.**
- Gateway and connector writes are idempotent on (account, sale id, kind), (payout id) and (bank transaction id).
- The same key with a different `payload_sha256` emits `provider_conflict` and changes nothing, as with
  `svc_settlement_ingest` today (p29:783-790).
- Ledger journals use idem keys derived from claim keys, and the (kind, external_ref) uniqueness index (p10:243).

### 5.7 Test, sandbox and simulated activity

- Test purchases are absent from `GET /sales` and never paid out (F17). A `test: true` ping is ignored. In phase 1
  there is no ping receiver anyway.
- New `fleet_economic_model.simulated_settlement_allowed boolean NOT NULL DEFAULT false`.
  - When it is false, `svc_settlement_ingest`, `fleet_settlement_post` and every new posting function refuse rails in
    `simulated` or `sandbox` mode.
  - Today a simulated rail can post to `agent_cash` (p29:716-767).
  - Throwaway registries set it to true for the existing F2 simulation tests. The privilege audit fails if it is true
    on a registry that has a `live_receive` rail or a `fleet_treasury` destination.

---

## 6. Receive-only security boundary (new capability `live_receive`)

### 6.1 Every outgoing path, and why `live_receive` cannot reach it

| Outgoing path | Where (F) | Why `live_receive` cannot authorise it | New enforcement |
|---|---|---|---|
| Payment-instruction issue | p32:239-280 | Selects `mode = 'live'` and capability `payouts` or `bank_transfer`, with a fresh signer attestation (p32:266-274) | CHECK: `live_receive` capabilities ⊆ {storefront, receive_payments, marketplace_listing}; test |
| Custody signer attestation | `cx_attest_signer` p32:158-185 | Needs `payouts` or `bank_transfer` in both the rail and the credential scope (:174-176) | Credential CHECK: provider `gumroad` scope ⊆ {edit_products, view_sales, view_payouts}; bank-feed scope ⊆ {read_accounts, read_transactions} |
| Custody execution | `custody_execution_enabled` CHECK (p10:40); executor env check (`treasury/custody.ts:36`) | Unchanged, pinned false | none; audit re-asserted |
| Payment-order owner route | retired (p27:20-50) | Unchanged | none |
| Provider payout initiation | `adapters.ts:54-57, 113-116` (spend gate, then disabled) | The Gumroad payouts API has **no initiation endpoint** (F14). The gateway allowlist has none | Allowlist test |
| Provider refunds | `PUT /v2/sales/:id/refund` | Needs `refund_sales`, `edit_sales` or `account` (F13, F14). The token is requested without them, and the gateway **verifies the granted scopes** and refuses to run if any of `account`, `edit_sales`, `refund_sales`, `edit_emails`, `edit_profile` is present (6.2). Path not in the allowlist | Startup scope check; allowlist test |
| Transfers / funding moves | `fund_child`, `transfer_credits` (`fleet/policy.ts:170-186`); `fleet_safe_transfer_amount` (p29:940) | Agent-internal ledger only; unchanged; they draw on `agent_cash`, which only S5 credits | none |
| Owner sweeps | `OWNER_SWEEP_ENABLED` is a no-op (`index.ts:374-376`); sweeps are the DB row `fleet_sweep_policy.enabled` | Unchanged; revenue raises net profit, but sweeps stay disabled | Audit asserts `fleet_sweep_policy.enabled = false` |
| Bank payment initiation | none exists | Bank-feed consent is account-information only | Connector refuses any scope outside read; test |
| `REAL_PAYMENTS_ENABLED` | spend gate (`spend-gate.ts:63-85`), signers, PayPal live | Stays false; `live_receive` never reads it, and **observing a payout is not initiating one** | Audit: both new units refuse to start if any of the four flags is true (same pattern as `operator/main.ts:46`) |

`mode <> 'live'` (p29:366) is kept as it is. `live_receive` is a distinct mode with its own CHECK, its own audit
entries and its own tests. It is not a loophole in the old pin.

### 6.2 Least-privilege credentials, verified rather than assumed

**Gumroad token**
- Obtained **only via the OAuth authorisation flow** with `scope=edit_products view_sales view_payouts`. A
  self-generated token carries all public scopes, including `account` and `edit_sales` (F15).
- At onboarding and at every gateway start, the granted scopes must equal that set exactly. They are taken from the
  token response (A) and `/oauth/token/info` (B, F16). Any extra scope means the gateway refuses, and the rail's
  `account_access` check is marked `failed`.
- **What these scopes still allow:** `edit_products` permits product, offer-code, variant, file and refund-policy
  writes (F14). The **allowlist** below, not the scope, confines the gateway to its needs.

**Bank-feed credential**
- An account-information consent only, for the treasury account only. Its scope is recorded and checked the same way.

### 6.3 Gateway operation allowlist (code and test; deny by default)

| Op | Method and path | Precondition |
|---|---|---|
| verify account | `GET /v2/user` | none |
| create product | `POST /v2/products`, always `draft=true` and `custom_permalink=f<job>` | job is owned by the caller's venture |
| update product | `PUT /v2/products/:id` | product mapped to the caller's venture; never `files`, `rich_content` or `tags` with an omission (full-replace semantics, A) |
| publish / unpublish | `PUT /v2/products/:id/enable` / `disable` | mapped |
| delete | `DELETE /v2/products/:id` | mapped **and** `state = 'draft_creating'` or `'draft'` only (crash recovery) |
| files | `POST /v2/files/presign`, `/complete`, `/abort`; `PUT` to the returned part URLs | upload owned by the job; part host must match the presign response host and an `*.amazonaws.com` S3 pattern (U3: pinned after the first presign) |
| read sales | `GET /v2/sales` (`after`, `page_key`), `GET /v2/sales/:id` | none (the gateway reads all; the controller filters per agent) |
| read payouts | `GET /v2/payouts`, `/:id`, `/upcoming` with `include_sales`, `include_transactions` | none |
| list products | `GET /v2/products` | for crash recovery and orphan reconcile only |

**Everything else is refused:** refunds, revoke access, resend receipt, emails, offer codes, custom fields, profile,
pages, resource subscriptions and any non-`api.gumroad.com` host except the pinned upload host.

---

## 7. Account and product isolation

### 7.1 What agents never get

- A Gumroad token, an owner dashboard session, or a browser credential fill on a Gumroad origin.
- The browser refuses `account.register` and `account.create` with platform or origin `gumroad.com` / `*.gumroad.com`,
  and refuses credential fills there, with `FLEET_PROVIDER_VIA_GATEWAY`. Public read-only browsing is unchanged.

### 7.2 Ownership on every operation

- `fleet_provider_products(provider_account, product_id UNIQUE, venture_id, agent_id, state, created_job, permalink,
  file_refs)`.
  - `state` runs: draft_creating → draft → published → unpublished → deleted.
  - `agent_id` and `venture_id` are immutable except through `fleet_admin_storefront_product_reassign`, an owner
    command that records an event and needs a reason. Agents cannot reassign.
- **Every `storefront.*` op** resolves the caller to (agent, venture) and refuses with `FLEET_CREDENTIAL_SCOPE`
  unless the product, upload or job maps to that venture. This includes reads: `storefront.sales` returns only memo
  rows of the caller's mapped products.
- **Uploads:** `fleet_provider_uploads(job, venture, agent, key, upload_id, state)`. A file is attachable only to a
  product of the same venture.
- **Products the gateway did not create** (for example made by hand in the dashboard): mapped to no one. Their sales
  are unattributed (quarantined at S5) until the owner assigns them with `storefront-product-assign`. The gateway
  never mutates them.

### 7.3 Crash-safe product creation

1. The controller inserts the job and a product row in `draft_creating` with permalink `f<job-id-12>`. Nothing has
   happened externally yet.
2. The gateway calls `POST /v2/products` with `draft=true` and that `custom_permalink`.
   - If it gets an id, it records the id and moves to `draft`.
   - On timeout or crash, it lists `GET /v2/products` for the permalink: if found, it adopts it; if not, it retries
     once and then fails the job.
3. Files: presign → parts → complete → attach. On failure, abort, and the product stays a draft.
4. Publish only on the agent's explicit `storefront.product.publish`. The response must have no `warning` (F20).
   Otherwise the product stays a draft and `storefront_publication` is marked failed (§8).
5. **Orphan reconcile.** A daily `GET /v2/products` comparison raises:
   - `PROVIDER_ORPHAN_PRODUCT`: on the account, not mapped;
   - `PROVIDER_MISSING_PRODUCT`: mapped, not on the account.
   Drafts stuck in `draft_creating` for more than 1 hour are deleted by the gateway (allowlisted only for that state).

---

## 8. Truthful dependency readiness

### 8.1 The two stored requests and the current lifecycle (F)

- **62cbe1b7** (Founder 1):
  - kind `kyc`;
  - action "List the landlord compliance tracker on Gumroad (a Gumroad seller account needs a human identity/KYC)";
  - title "Owner request: enrol a Gumroad channel for zero-capex digital products";
  - created 2026-09-26, goal `g1`;
  - imported from a legacy knowledge proposal and re-scoped by id (p26:22, 33-36, 131-133);
  - **no rail requirement.**
- **6178c7bb** (Agent 2):
  - kind `kyc`;
  - action "Open a gumroad account (storefront) for venture uk-sa-template";
  - title "Payment rail required: gumroad / storefront";
  - created 2026-10-07 by `fleet_rail_resolve` (p29:461-472) for requirement `storefront`/`gumroad`.
- **Lifecycle:**
  - `pending` → one terminal status only (p26:50-63);
  - `owner-request-decide` grants nothing (p25:143-150);
  - `fleet_admin_rail_add` inserts **active** by default and answers matching dependencies at once (p29:356, 479-496),
    because `fleet_rail_match` needs only `status = 'active'` (p33:74).

### 8.2 Capabilities, each with its own evidence

Stored in `fleet_rail_capability_checks(rail, capability, status unverified|verified|failed|expired, evidence jsonb,
evidence_kind, verified_at, expires_at)`. Written only by owner and gateway functions.

| Capability | Meaning | Evidence | Needs a real sale or payout? |
|---|---|---|---|
| `account_access` | the gateway reaches the registered account with exactly the allowed scopes | `GET /v2/user` `user_id` matches the registered account; scope check (6.2) | no |
| `storefront_publication` | the gateway can publish for a venture | `account_access`; a draft create, attach and delete probe; the owner attests in the Gumroad dashboard that email is confirmed and a payout method is set (F20); kept only while each venture's first real publish comes back without a `warning`. A warning sets the capability to `failed` with the reason | **no** |
| `identity_verification` | Stripe verification is complete for payouts | owner attestation from Gumroad's payments page. **No API exposes it** (A: earnings and tax forms are US-only). The $10 vs $100 threshold is not observable by API either | no |
| `sale_ingestion` | verified sales are read back and attributed | the first real third-party sale reaches S1 and is attributed | **yes:** live pilot only |
| `payout_reconciliation` | payout membership and rows are complete and allocatable | the first real payout passes §5.2 | **yes:** live pilot |
| `receipt_verification` | S4 evidence by the bank feed | the first automatic receipt match (or the pilot fallback, labelled) | **yes:** live pilot |

### 8.3 Lifecycle changes

1. `fleet_admin_rail_add` inserts **`pending_setup`** and resolves nothing.
2. `fleet_rail_match(..., capability)` additionally requires that capability to be `verified` and unexpired on the
   rail.
3. A rail becomes `active` only when at least one capability is verified.
4. A dependency created by `fleet_rail_resolve` is answered only when the **requested** capability is verified.
   - The answer text is generated from the evidence: "Verified: storefront publication. Not yet verified: sale
     ingestion, payout reconciliation, receipt verification, identity verification (as applicable). Revenue is not
     spendable until it is received into the fleet treasury."
   - The fixed text "A compatible Fleet payment rail is now connected" (p29:455) is removed.
5. New `fleet_admin_dependency_answer_from_capability(request, rail, capability, actor)`:
   - for legacy requests such as 62cbe1b7, with no requirement;
   - refuses unless the capability is verified for a rail assigned to the request's agent's venture;
   - writes the same generated text. The owner never types the disclosure by hand.
6. New `fleet_admin_rail_assign(rail, venture, capability, actor)`, for Founder 1's venture, which has no
   requirement. Subject to the same verified-capability rule.
7. **Unresolved portions are preserved, not merged.** When a request is answered on `storefront_publication` while
   `identity_verification` is not verified, the same transaction records a **new** dependency:
   - kind `kyc`, idempotency `capability:<rail>:identity_verification:<agent>`;
   - action "Receive Gumroad payouts: Stripe identity verification of the account holder";
   - one per affected agent, within the existing limit of 5 open per agent (p29:463).
   Publishing is therefore never reported as completed KYC.

**No deadlock.** `storefront_publication` needs no sale or payout, so publication can happen first. Sales and payouts
then prove the later capabilities.

### 8.4 What satisfies each original request, and what the answer must disclose

- **6178c7bb:**
  - **Satisfied when:** `account_access` + `storefront_publication` are verified on a gumroad rail assigned to
    `uk-sa-template`.
  - **Answered:** automatically by the new lifecycle.
  - **The answer must disclose:** the verified list; the unverified list; "revenue is not spendable until received
    into the fleet treasury"; and the identity-verification dependency if it was created.
- **62cbe1b7:**
  - **Satisfied when:** the same two capabilities are verified for a rail assigned to `landlord-compliance-tracker`.
    That means the account exists under the owner's true identity, email is confirmed and a payout method is set.
    The "human identity/KYC" part is satisfied only to the extent `identity_verification` is verified.
  - **Answered:** by `fleet_admin_dependency_answer_from_capability`, with the same disclosures.
  - **If `identity_verification` is unverified,** it says so and creates the separate dependency (8.3.7).
- **Neither request is answered in this design task.**

---

## 9. Acceptance tests

**Tier 1: local fixtures and database tests.** No network; a fake Gumroad and a fake bank feed are built from the
documented payloads, with the B-only field shapes marked.

*Pending readiness*
1. A rail is created `pending_setup`; no requirement, assignment or dependency changes.
2. `owner-request-decide` alone assigns nothing.
3. A dependency is answered only when its requested capability is verified; the text lists exactly the verified and
   unverified capabilities.
4. A legacy request is answered only through `…answer_from_capability`, with a verified capability.
5. An unresolved identity verification creates the separate dependency.
6. `storefront_publication` becomes verified with no sale or payout.

*Receive-only enforcement*
7. `live_receive` with `payouts`, `refunds`, `card_spend` or `bank_transfer` is refused by CHECK.
8. `cx_attest_signer` refuses a `live_receive` rail.
9. Payment-instruction issue never selects it.
10. The gumroad credential scope CHECK refuses `payouts`.
11. The gateway refuses a token with `account` or `edit_sales`.
12. Allowlist: refund, resend receipt, emails, offer codes, resource subscriptions and foreign hosts are refused.
13. Both new units refuse to start if any of the four flags is true.
14. Audit fails on a tampered CHECK, or on `simulated_settlement_allowed = true` alongside a live destination.

*Ownership and isolation*
15. Agent A cannot read, update, attach to, publish, delete or see the sales of agent B's product or upload.
16. Reassignment is owner-only and records an event.
17. The browser refuses Gumroad credential fills and registration.
18. Crash at each step of 7.3 leaves exactly one mapped product, or none; no cross-venture attach; orphans flagged.

*Credential secrecy*
19. The token and bank credential never appear in logs, events, job rows, receipts, snapshots or errors.
20. Both are stdin-only at onboarding, and vault files are 0600 and owned by the unit.

*Duplicates, missed and reordered events*
21. Repeated polls, overlapping windows and a refund seen before its sale give exactly one memo row per (sale, kind).
22. A missed poll window is recovered by the daily reconcile.
23. A conflicting payload emits `provider_conflict` with no change.
24. Replay of a receipt, attestation or payout posts once (claims).

*Currency mismatches*
25. A non-USD payout with an implied rate outside ±3%, an unknown row type, an unresolved purchase id or an unknown
    currency is quarantined to `provider_suspense`; agent cash is unchanged.
26. A USD payout whose rows do not sum exactly is quarantined.

*Settlement reconciliation*
27. S1–S3 change no ledger balance.
28. S4 into `owner_external` posts nothing until the matching treasury transfer.
29. S5 conserves: Σ shares + suspense = the receipt exactly. Property test over random mixed two-agent payouts with
    fees, partial refunds, chargebacks, credits and payout fees.
30. Each agent's share differs from its exact USD-proportional value by at most one minor unit.
31. Owner funding with a claimed receipt reference is refused; the near-match warning fires.
32. Manual `ledger-record-revenue` without `--claims` against an active provider counterparty is refused.

*Post-settlement reversals*
33. A later chargeback or refund row gives a negative share: clawback up to cash, then `agent_provider_payable`, which
    reduces expensePurchasingCapacity and is repaid from the next share.
34. A negative bank debit is allocated the same way.
35. `dispute_won` restores the amount.

*Pilot fallback*
36. Attestation credits cash only within an active pilot authorisation and only on an exact match.
37. It is refused once an active bank-feed destination exists.
38. Provenance is `owner_attested`.

*Test isolation*
39. Simulated and sandbox rails cannot post while the flag is false.
40. Existing F2 simulation suites pass with the flag set on their throwaway registry.

*Release*
41. Migration v45 → v46 → … alone and from every earlier step (`fleet-f2-migration-paths-pg`).
42. Privilege audit clean.
43. `reconcile-compare`: no journal, balance, economics key or external-transaction change.
44. `test:security` / `test:financial` report the two pre-existing R39 failures as they are, and nothing new.

**Tier 2: provider test purchases** on the real account, explicitly authorised. **These cannot prove settlement.**
- `account_access` and `storefront_publication` probes.
- One logged-in "Test card" purchase: absent from `GET /sales`, nothing recorded.
- **Never a real-card self-purchase** (F17).

**Tier 3: live pilot,** under separate explicit owner authorisation, with real third-party buyers only.
- `sale_ingestion`: the first real sale reaches S1 and is attributed; founders see the non-spendable memo.
- `payout_reconciliation`: the first payout passes §5.2.
- `receipt_verification`: an automatic match. The labelled pilot fallback is used only if the connector is absent.
- The first S5 posting and a clean reconcile.
- A real refund handled by the owner in the dashboard: reflected in the next payout's allocation.

---

## 10. Implementation stages

| Stage | Modules and files | Schema and privileges | Checks | Acceptance |
|---|---|---|---|---|
| **G1 lifecycle and guards** (local; **no owner decisions needed**) | `src/fleet/postgres/migrations-phase46.ts`; `migrations.ts` (version 46); `privileges.ts` (audit entries); `hub/cli.ts` + `hub/admin.ts` (`economy-rail-verify`, `economy-rail-assign`, `dependency-answer-from-capability`); tests `fleet-f2-money-pg`, new `fleet-rail-readiness-pg` | v46: rails default `pending_setup`; `fleet_rail_capability_checks`; `fleet_rail_match` / `fleet_rail_resolve` verified-capability rule and generated text; `fleet_admin_rail_verify` / `_assign` / `dependency_answer_from_capability`; `live_receive` mode and scope CHECK; gumroad credential scope CHECK; `simulated_settlement_allowed` plus guards; `fleet_revenue_claims` plus the `ledger-record-revenue` / `-funding` claim rules | typecheck; targeted suites; `test:security` and `test:financial` serially; migration paths; audit | tests 1–14, 31–32, 39–44 |
| **G2 provider memo and accounting** (local) | `migrations-phase47.ts`; `src/fleet/storefront/allocation.ts` (pure); new `fleet-storefront-accounting-pg` | v47: `fleet_provider_accounts`, `_products`, `_uploads`, `_sales`, `_payouts`, `_payout_lines`; `fleet_settlement_destinations`, `fleet_settlement_receipts`; `fleet_pilot_authorisations`; classes `provider_suspense` (fleet) and `agent_provider_payable` (agent; equity obligation via the p42 restate; `fleet_ledger_open_agent` backfill as in p29:236-251); kinds `provider_revenue_receipt`, `provider_receipt_suspense`, `provider_suspense_allocation`, `provider_clawback`, `provider_receipt_transfer`; reconcile checks | as G1 | tests 21–30, 33–38 |
| **G3 gateway** (local, fake Gumroad) | `src/fleet/storefront/{gumroad-client,gateway,vault,main}.ts`; `deploy/systemd/automaton-fleet-gumroad.service`; `scripts/fleet-gumroad-setup.sh`; founder tools in `founder/toolbox.ts`, `cognition/types.ts` (`storefront.*`, capability `planning`, gated by the capability signature); browser policy in `identity/` | v48: role `fleet_provider(_login)` with `gx_*`; `svc_storefront_*` in `SERVICE_API_FUNCTIONS` (`migrations.ts:1201-1259`); audit role and writer maps | as G1 plus `release-script` tests | tests 11–12, 15–20 |
| **G4 receipt connector** (local, fake bank feed) | `src/fleet/settlement/bankfeed/{client,matcher,main}.ts`; `automaton-fleet-bankfeed.service`; setup script | v48 (same release): role `fleet_bankfeed(_login)` with `rx_*` | as G3 | tests 24, 28, 31, 34, 36–37 |
| **G5 release** (production, owner-approved) | `fleet-rollout.sh rehearse 45 48`, then `cutover … 45 48`; units installed dormant | none new | prod-copy rehearsal; `reconcile-compare` | no new journals, events or balances except role grants |
| **G6 onboarding** (owner) | Account setup on gumroad.com; OAuth onboarding; destination registration; rail `pending_setup`; capability probes | none | Tier 2 | `storefront_publication` verified; dependencies answered by the lifecycle |
| **G7 live pilot** (separate authorisation) | founders publish by their own choice | none | Tier 3 | `sale_ingestion`, `payout_reconciliation`, `receipt_verification` verified |

- **Schema numbering:** current head v45 → G1 v46, G2 v47, G3/G4 v48. G1–G4 can ship in one release (migrate applies
  versions in order).
- **Founder compatibility:** the storefront tools are new tools behind the capability signature. Runtimes on
  `fda78a0` are simply not offered them, the same pattern as the doctrine gate.

---

## 11. Release compatibility and rollback (write-preserving)

**Older components cannot misread newer data.** Every component refuses a schema other than its own exactly:
- `store.ts:512-516`
- `browser/main.ts:45`, `dashboard/main.ts:64`, `identity/main.ts:164`, `operator/main.ts:149`
- custody `CUSTODY_SCHEMA_VERSION`
- `doctor.ts:279-281`

An old controller therefore cannot run against v46+ and misinterpret provider rows or liabilities.

**Before any provider data exists** (no destination, rail, provider, receipt, claim or payable rows):
- the normal schema revert (`fleet-rollout.sh revert …`);
- the post-cutover dump is written first;
- `FLEET_REVERT_DISCARD_ACK` counts come from reconcile.

**After provider data exists, freeze and fix forward:**
1. `systemctl disable --now automaton-fleet-gumroad automaton-fleet-bankfeed`. No new reads or writes.
2. `economy-rail-status <rail> suspended`. No matching; evidence kept.
3. Agents' storefront tools answer `FLEET_CAPABILITY_NOT_CONFIGURED` ("only this action is unavailable").
4. Correct in a forward migration. Ledger corrections are reversing journals only, never a restore.

**New guard in `fleet-rollout.sh revert`.** A revert to a schema below 46 refuses whenever any of these exist:
- `fleet_provider_*`, `fleet_settlement_receipts`, `fleet_revenue_claims` or `fleet_rail_capability_checks` rows;
- a non-zero `provider_suspense` or `agent_provider_payable` balance.

It refuses **even with `FLEET_REVERT_DISCARD_ACK`**, unless `FLEET_REVERT_PROVIDER_EXPORT=<file>` names a verified
export of those rows and balances written by the same run. A downgrade can never silently drop settlement evidence or
liabilities.

**Code-only revert within v46+** (same schema) keeps the database, as today.

---

## 12. Minimum owner decisions before account setup

1. **Arrangement:** one shared seller account behind the broker (proposed, §2), or linked accounts per venture.
   Products cannot move between accounts later.
2. **Seller identity:** individual or company. The registration data must be true (F1). A business's bank must be in
   its country of registration (A, `_13`).
3. **Payout destination:** whether Gumroad pays out into an account that will be registered as the **fleet treasury**
   (recommended), or into an owner account (then each payout reaches agents only after a transfer into the treasury
   account, §4.2).
4. **Account email:** an owner-controlled mailbox used by no agent.
5. **Listing currency:** GBP or USD. Settlement is USD either way (F2), and the payout is in the local currency.

Not needed before account setup, but needed before G6 or G7: the bank-feed provider; whether to run the pilot with
the attestation fallback.

**Standing rules, not decisions:**
- never buy your own product with a real card (F17);
- refunds and dispute responses are handled by the owner in the dashboard in phase 1;
- no secrets or identity documents in chat. Onboarding is stdin and browser only, on the owner's terminal.

---

## 13. First implementation stage that can proceed locally now: G1

G1 needs none of the decisions in §12. It changes only the lifecycle and guards, all inside the fleet:
- pending rails;
- verified-capability matching and generated disclosures;
- the legacy-request answer path;
- the `live_receive` and credential-scope CHECKs;
- the simulated-settlement guard;
- revenue claims;
- the audit.

**Effect on production once deployed:** none. There are no rails, destinations or provider rows. The one behavioural
change is that a future `economy-rail-add` would no longer answer 6178c7bb falsely.

**Acceptance:** tests 1–14, 31–32 and 39–44, plus clean migration paths, audit and `reconcile-compare`. The two
pre-existing R39 audit failures are reported as they are.
