# Gumroad revenue integration: implementation plan (review draft, 2026-10-08)

This is a planning document. Production is unchanged. No account, product, rail, credential or request was created,
published, registered, stored or resolved. The deployed baseline is `fda78a0` (schema 45). The readiness findings
it builds on are in `docs/evaluations/r41-1/fda78a0/gumroad-readiness.md`.

**Sources.** Gumroad is open source (`antiwork/gumroad`, commit `6d535ea8`, 2026-10-08). Every claim below is tagged:

- **(A)** Published text: the Terms ("Last Updated September 14, 2026", binding existing accounts from 14 Oct 2026),
  the help centre, the API docs, or the Ping page. Read from the repository files that publish them:
  - `app/views/home/terms.html.erb` → gumroad.com/terms
  - `app/views/help_center/articles/contents/_N-*` → gumroad.com/help/article/N-…
  - `app/javascript/components/ApiDocumentation/**` → gumroad.com/api
  - `app/javascript/pages/Public/Ping.tsx` → gumroad.com/ping
- **(B)** Behaviour inferred from Gumroad's application code. It can change without notice.
- **(F)** Fleet code at `fda78a0`. `pN` = `src/fleet/postgres/migrations-phaseN.ts`.

Gumroad is the founders' **current choice** of channel, not a fleet restriction.
- This plan imposes no opportunity weights, quotas, compulsory study or journal entries, and no new own-capital
  approval thresholds.
- Journaling and hibernation stay voluntary.
- Live journal persistence and an event-triggered full wake are still awaiting observation.
- Event detection can still be delayed by up to about 32 minutes by the idle skip.

---

## 1. Design questions

### 1.1 Separate seller accounts, or one shared account behind a broker

**Facts**

- **Sharing an account (A):** "You may not share your Account or password with anyone" and "You are responsible for
  all activities that occur under your Account" (Terms §4.4).
- **Who may hold an account (A):** "You agree not to create an Account … on behalf of someone other than yourself"
  (§4.4).
- **More than one account (A):** "You may hold more than one Account for genuinely separate brands or businesses"
  (§4.4).
- **Linked accounts (A):** "If you see New Gumroad … you must create it there, so your accounts stay linked … It can
  copy your existing payout setup" (`_252`).
- **What a linked account really is (B):**
  - it is a **separate user**, with the creator added as an *admin team member*;
  - it gets a **new Stripe Connect account**: "We deliberately create a NEW Connect account instead of pointing both
    Gumroad accounts at the same one" (`app/services/user/create_brand_account_service.rb:20`);
  - each account therefore has its **own balance, payout threshold and payouts**;
  - the feature sits behind the flag `:brand_accounts`, so not every account has it.
- **API scopes (A):** account-wide (`edit_products`, `view_sales`, `view_payouts`, `edit_sales`, `account`, …). There
  is no per-product scope (`Scopes.tsx`).
- **Team roles (A):** they cannot be limited to products (`_326`). An admin can mint a seller-owned token (B).
- **Automation (A):**
  - The API and Gumroad's CLI are endorsed for agents: the CLI is "built for humans and AI agents alike" (API docs,
    CommandLine). Help articles suggest "Your own AI agent, such as Claude Code…" (`_353`, `_124`).
  - The Terms forbid "automated software … to 'scrape' or download data from any web pages" and to "access, 'scrape,'
    'crawl' or 'spider' any pages" (§14(e), (xiii)).
  - Login uses reCAPTCHA "to tell humans and bots apart" (`_292`).
  - Nothing explicitly permits browser automation of the dashboard. It is **unsettled and a risk**.

**Comparison**

| | One shared owner account + fleet broker | One linked account per venture |
|---|---|---|
| Terms fit | One account, used by its holder through the API the holder authorised | Needs "genuinely separate brands"; ventures by one owner arguably qualify, which is the owner's judgement |
| Isolation between agents | **The broker enforces it.** Agents never hold the token; every operation is checked against a product → venture → agent mapping | The account boundary enforces it, **but only if** agents still never hold the token. Otherwise the same broker is needed anyway |
| Payouts | One balance, one $100 threshold (until verified), one payout stream. **Per-sale allocation is possible:** `GET /payouts/:id?include_transactions=true` lists each purchase's sale price, fees, taxes and net (A) | One Connect account and threshold per venture: small ventures wait longer to reach a payout |
| KYC | One account holder: "identity verification is owner-only" (`_326`, A) | Whether each new Connect account needs its own ID verification is **not settled** (see 1.2) |
| Attribution | Needs the ownership mapping. The broker writes it at creation; products made by hand in the dashboard are unattributed until the owner assigns them | `seller_id` identifies the venture |
| Public storefront | Both ventures' products appear on one profile | Separate profiles |
| Products cannot be moved between accounts (A, `_252`) | Choose before publishing | Choose before publishing |

**Recommendation: one owner seller account, accessed only through a fleet broker (the "Gumroad gateway").**

- Separate accounts are **not** necessary for isolation. Isolation comes from agents never holding the token, and
  that has to be true under either arrangement.
- The shared account avoids:
  - the feature-flagged linking;
  - an unsettled per-account KYC question;
  - a payout threshold per venture.
- Per-sale allocation of each payout is available through the API.
- **No agent drives the Gumroad dashboard.** The `browser` worker is refused credential fills and account
  registration on Gumroad origins. Public pages stay readable for research, as before. This keeps clear of the
  account-sharing and automation clauses.
- **When to revisit:** a venture needs its own brand or profile, or the owner wants separate tax or business
  identities. Then add a linked account as a second rail; the broker design does not change.

### 1.2 Account linking, payout reuse and KYC, checked separately

- **Linking:** must use "New Gumroad" where it is offered; otherwise ask support (`_252`, A). It is feature-flagged
  (B).
- **Payout reuse:** "can copy your existing payout setup, so you do not have to go through payments onboarding again"
  (`_252`, A).
  - The code copies compliance info, currency, PayPal address and bank account (B).
  - The copied bank account is reset to unverified, and a **new** Connect account is created (B).
- **KYC:**
  - Stripe "requires additional information to verify the identity of the account holder after a certain amount of
    time has passed and sales accrued" (`_13`, A).
  - Minimum payout is $100 until verified and $10 after (`_13`, A).
  - **Correction to the earlier assessment:** "KYC happens only once" across linked accounts is **not** supported by
    any authoritative source. Whether a linked account's new Connect account needs its own ID document is
    **unsettled**.
  - With one shared account the question does not arise.
- **Ownership transfer:** needs Gumroad's written consent, and "the new owner will need to complete identity
  verification" (`_252`, A).

### 1.3 Which API operations exist (A unless marked)

| Need | Endpoint | Notes |
|---|---|---|
| Create a product | `POST /v2/products` (`edit_products` or `account`) | `name`, `price` (minor units), `price_currency_type`, `draft`/`published`, `description`, `files[]`, … Published by default, **but "if publishing is blocked (… email address is not confirmed or no payout method is set up), the product is saved as a draft and the response includes a `warning`"** |
| Update a product | `PUT /v2/products/:id` | `files`, `tags` and `rich_content` are **full replacements** ("any file you omit is deleted") |
| Publish / unpublish | `PUT /v2/products/:id/enable` / `disable` | The create page also says "POST …/enable"; docs are inconsistent |
| Delete | `DELETE /v2/products/:id` | Permanent |
| File delivery | `POST /v2/files/presign` → `PUT` each part → `POST /v2/files/complete` ("Don't retry this call") → attach with `files[][url]` | End-to-end supported, up to 20 GB. Keep the canonical `file_url`; reads return signed URLs |
| Read sales | `GET /v2/sales` (`after`, `before`, `product_id`, `page_key`), `GET /v2/sales/:id` (`view_sales`) | See 2.3 for what the fields mean |
| Refund | `PUT /v2/sales/:id/refund` (`edit_sales`) | `amount_cents` in the sale's listed currency; repeated partial refunds allowed; needs enough balance |
| Payouts | `GET /v2/payouts`, `GET /v2/payouts/:id`, `GET /v2/payouts/upcoming` (`view_payouts`) | `include_sales` (sale, refunded and disputed ids) and `include_transactions` (per purchase: sale price, gumroad fees, taxes, net, negative rows for refunds/chargebacks); `status` payable/completed/pending/failed |
| Webhooks | `PUT/GET/DELETE /v2/resource_subscriptions`: `sale`, `refund`, `dispute`, `dispute_won`, … | **Unsigned.** "treat a ping as a trigger rather than as data … read the sale back through the API, and reconcile periodically" |
| Seller identity | `GET /v2/user` | `user_id` equals `seller_id` in sales and pings (B) |
| Earnings, tax forms | `GET /v2/earnings`, `/tax_forms` | **US sellers only.** Not usable for a UK seller |
| Sandbox | none | Test purchase = buying your own product while logged in, with a "Test card" (`_62`). Not in `GET /sales`, never paid out (B), but a ping is sent with `test: true` |

**Not automatable, or not to be automated, and the alternative:**

- **Account creation, email confirmation, payout and bank settings, Stripe identity documents, and creating the API
  application.** These are owner-only, on gumroad.com.
- **Real-card purchases of your own products.** Never do this. It "appears exactly the same as money laundering … may
  be automatically suspended" (`_62`, `_281`). The live pilot needs real third-party buyers.
- **Refunds.** The API exists, but it moves buyers' money and needs `edit_sales`. Phase 1 keeps refunds **owner-only
  in the Gumroad dashboard**: agents may request one, and the gateway's token has no `edit_sales`. The ledger follows
  refunds from payout data either way.
- **Disputes.** Responding to a chargeback happens in the Gumroad dashboard (`_134`); it is owner-only.

---

## 2. Architecture

### 2.1 Components

1. **Gumroad gateway** (new unit `automaton-fleet-gumroad`):
   - its own OS user and its own database role `fleet_provider` / `fleet_provider_login`, with `gx_*` functions only;
   - a vault in its 0700 `StateDirectory`;
   - outbound HTTPS to `api.gumroad.com` only, through an in-code host allowlist; **no inbound endpoint in phase 1**.
   - Why a new unit: the controller cannot read any vault and has no egress allowlist (F). The identity broker holds
     the owner's identity vault and should not also hold the selling token. The pattern is the browser worker's
     (`automaton-fleet-browser`, `fleet_browser`, `bx_*`).
2. **Polling first, webhooks optional later.**
   - The gateway lists `GET /v2/sales?after=<watermark − 2 days>` every 5–10 minutes and does a full reconciliation
     daily.
   - Pings and resource subscriptions are unsigned triggers. They would need a new public route on the edge, which
     is new network exposure and an owner decision. Polling alone meets the trust model, so phase 1 has no inbound
     route.
3. **Agent operations** (controller → gateway job queue, like the browser's `bx_*` queue):
   - `storefront.product.create`, `.update`, `.publish`, `.unpublish` and `.file.attach`;
   - `storefront.sales` (read own sales, memo);
   - `storefront.refund.request` (files a request to the owner; executes nothing).
   - All are capability `planning`, consistent with how R41.1 classified the browser tool. None spends fleet money.
4. **Ownership mapping:**
   - The gateway writes `fleet_provider_products` **only** for products it created for a calling agent's venture.
   - Every later operation checks that (provider account, product id) maps to the caller's venture.
   - Unmapped products, for example made by hand in the dashboard, produce **unattributed** sales until the owner
     assigns them (`fleet:admin storefront-product-assign`, which records an event).
5. **Files:**
   - The founder runtime reads the file from its own workspace and sends it through the controller to the gateway,
     which runs presign → parts → complete → attach.
   - Phase 1 caps files at 25 MB.
   - The gateway never reads founder state directories.
6. **Browser policy:**
   - `browser` refuses credential fills, `account.register` and `account.create` on `gumroad.com` and its
     subdomains, with a new refusal code `FLEET_PROVIDER_VIA_GATEWAY`.
   - Read-only public browsing is unchanged.

### 2.2 How money moves through states

The design is **cash-basis**: nothing reaches `agent_cash` before money is actually received.

| State | Where it is recorded | In the GBP ledger? | Spendable? |
|---|---|---|---|
| **Verified sale** | read back by `GET /v2/sales/:id`, never from a ping | memo row `fleet_provider_sales`, in **USD** | no |
| **In provider balance** | sale older than the 7-day hold, or included in `GET /payouts/upcoming` | memo state `in_balance` | no |
| **In payout** | `GET /payouts/:id` with `include_transactions`, status pending or payable | memo `fleet_provider_payouts` plus allocation rows | no |
| **Received** | payout `completed` **and** the owner confirms it **arrived in the destination account**: payout id, GBP amount and date, via `storefront-payout-confirm` | posts now | — |
| **Spendable capital** | the allocated GBP net credited to `agent_cash` by `provider_payout_settlement` | yes | yes, through the existing `LEAST(cash, equity)` rule (p11:353-387, p42 restate) |

- **No receivable class is added to the ledger.** The ledger has one currency, GBP (p21:36, :55-66). Gumroad settles
  in USD (Terms §9, A). The GBP figure is only known at payout.
- **What founders see:** the wallet and economy brief gain a memo line, "pending external revenue: USD x (not
  spendable) / in payout: USD y".
- **Wakes:** a change in that memo is a wake signal, so a verified sale gives a full packet at the next thinking
  slot.

### 2.3 Accounting rules

- **Currency.**
  - Sale `price` and `gumroad_fee` are **USD cents** whatever the listing currency. Ping says "in USD cents" (A). The
    sale's `currency` field is the *listing* currency (B).
  - Payouts to a UK bank are in GBP, "converted … at the time of sale, not at the time of the payout" (`_13`, A).
  - The fleet never converts revenue itself. It allocates the **actual GBP payout amount** across agents.
- **Allocation of one payout.**
  - For each transaction row (purchase id, sale price, gumroad fees, taxes, net), look up purchase → product → venture
    → agent through `fleet_provider_products`.
  - Each agent's GBP share = `payout_gbp × agent_net_usd / payout_net_usd`. Use largest-remainder rounding so the
    shares sum exactly.
  - Unattributed rows hold the payout `unallocated` until the owner assigns the product. No partial posting.
- **Fees.** `gumroad_fees` per row, in the same proportion: D `agent_fees`. Gross = net + fees in GBP terms.
- **Taxes collected by the platform.**
  - Gumroad is merchant of record: "Gumroad will be treated as the seller … for purposes of any relevant Indirect
    Tax" (§6.2, A). Prices are "exclusive of any applicable Indirect Tax" (§10.7, A).
  - Tax is **excluded** from revenue and kept only as a memo (`taxes` per row).
  - Whether `price` includes `tax_cents` is **unsettled** (B). The allocation uses the payout's per-row `net` and
    `gumroad_fees`, which does not depend on it.
  - Allocation also checks Σ net against the payout amount, within FX tolerance, before posting.
- **Refunds, partial refunds, chargebacks, disputes.**
  - Before payout, they reduce the memo; Gumroad nets them out.
  - After a payout, they appear as **negative transaction rows in a later payout** (A, payouts docs; `_269`).
  - They are allocated to the original sale's agent through the same mapping:
    - **if the agent's share of that payout stays ≥ 0:** it is simply smaller;
    - **if it goes below 0:** post `provider_clawback`: D `agent_revenue` / C `agent_cash`, up to the agent's
      available cash. Any remainder goes to a new liability class **`agent_provider_payable`** (C), which reduces
      equity and therefore spendable capacity. It is repaid automatically from that agent's next payout shares.
  - `dispute_won` credits come back as positive rows and are allocated the same way.
  - If the provider balance goes negative, "Our payment processor may debit your bank account" (`_269`, A). The
    owner records that through the same confirm path as a negative payout.
- **Test, sandbox and simulated activity.**
  - Test purchases are absent from `GET /sales` and never paid out (B). A `test: true` ping is ignored (B).
  - New database guard: `svc_settlement_ingest` and every provider posting function **refuse rails in `simulated` or
    `sandbox` mode** unless `fleet_economic_model.simulated_settlement_allowed` is true.
    - That flag defaults to false, is set only by throwaway registries for tests and rehearsals, and is checked by
      the privilege audit on production.
    - Today a simulated rail posts real-looking `agent_cash` (p29:716-767); this guard closes that.
- **Manual and automated paths cannot both credit the same revenue.** New table `fleet_revenue_claims`, UNIQUE on
  (provider, provider_account, external_settlement_id):
  - `provider_payout_settlement` claims `gumroad:<user_id>:payout:<id>`;
  - `fleet_admin_record_external` (`ledger-record-revenue`) gains an optional `--claims gumroad:<user_id>:payout:<id>`;
    with it, the command claims the same key and refuses if that key is already claimed;
  - **while a `live_receive` gumroad rail is active, `ledger-record-revenue` refuses a counterparty hash of that rail's
    account unless `--claims` is given**;
  - reconcile gains a `REVENUE_CLAIM_ORPHANS` check: manual Gumroad revenue without a claim, or a claimed payout
    posted twice.

### 2.4 Readiness lifecycle (fixes the auto-resolution)

Today:
- `fleet_admin_rail_add` inserts with the default `status='active'` and **immediately resolves every open
  requirement**, answering their dependencies (p29:356, :479-496).
- `fleet_rail_match` requires `status='active'` (p33:74).

New lifecycle:

1. **Rails are created `pending_setup`.** `fleet_admin_rail_add` takes no status and never resolves requirements
   while the rail is `pending_setup`.
2. **New table `fleet_rail_capability_checks`:**
   - columns: rail, capability, status `unverified|verified|failed|expired`, evidence jsonb, `verified_at`,
     `verified_by`, `expires_at`;
   - written only by `fleet_admin_rail_verify` (owner) and `gx_rail_probe_result` (gateway).
3. **`fleet_rail_match` matches a capability only if** the rail is `active` **and** that capability's check is
   `verified` and unexpired.
4. **A rail becomes `active`** (`fleet_admin_rail_set_status`) only when at least one capability is verified. A
   requirement is answered only for a capability that is verified.
5. **Truthful answer text.** The fixed text "A compatible Fleet payment rail is now connected" is replaced by text
   built from the verified capabilities. For example: "Storefront publishing is available for this venture. Sales
   are recorded as pending external revenue and become spendable only after a Gumroad payout is received.
   Payouts have not yet been proven."

**What each capability means, and how it is verified**

| Capability | Meaning | Verification | Provable before the live pilot? |
|---|---|---|---|
| `storefront` | the gateway can publish a product for a venture | (a) the token is valid and `GET /v2/user` → `user_id` matches the registered account; (b) the owner attests email is confirmed and a payout method is set; (c) a probe: create the product as a **draft**, then delete it; (d) the venture's **first real publish** must come back without a `warning`. If it does not, the capability drops to `failed`, the venture is told exactly why, and the rail stops matching | yes; (d) on first use |
| `receive_payments` (sale ingestion) | verified sales are read back and recorded as memo | the gateway lists sales and reads them back; test purchases prove only the ping and trigger path, because they are not in `GET /sales` | **no.** The first real third-party sale proves it |
| `payouts` (settlement) | payouts are allocated and posted after confirmed receipt | `GET /payouts` read-back, then one allocated, owner-confirmed payout | **no.** The live pilot proves it |

**What truthfully satisfies each pending request** (neither is resolved in this plan)

- **6178c7bb** (Agent 2; "Open a gumroad account (storefront) for venture uk-sa-template"; rail requirement
  `storefront`/`gumroad`):
  - satisfied when a gumroad rail assigned to `uk-sa-template` has `storefront` **verified** per (a)–(c) above;
  - it is then answered automatically, with the truthful text, by the new lifecycle.
- **62cbe1b7** (Founder 1; "List the landlord compliance tracker on Gumroad (a Gumroad seller account needs a human
  identity/KYC)"; legacy request, no requirement):
  - satisfied when the owner's seller account exists under the owner's true identity, with email confirmed and a
    payout method set, **and** `storefront` is verified for a rail assigned to `landlord-compliance-tracker`;
  - Founder 1 has no requirement row, so the owner answers it by hand
    (`owner-request-decide 62cbe1b7 answered …`) with the same factual text;
  - the answer must state that Stripe identity verification may still be requested later for payouts, and that
    revenue is not spendable until a payout is received;
  - the owner may also choose to assign the rail to that venture directly. That needs a new
    `fleet_admin_rail_assign`, which records an event and is resolved by the same verified-capability rule.

### 2.5 The receive-only rail against the safety controls

- **New mode `live_receive`.** Existing CHECK `fleet_payment_rails_not_live CHECK (mode <> 'live')` (p29:366) is
  **kept as is**. Add:
  - `fleet_payment_rails_live_receive_scope CHECK (mode <> 'live_receive' OR (provider = 'gumroad' AND capabilities
    <@ ARRAY['storefront','receive_payments','marketplace_listing']))`. This excludes `payouts`, `refunds`,
    `card_spend` and `bank_transfer`.
  - The privilege audit (`privileges.ts:926-931`) also requires the new CHECK, and fails if any `live_receive` rail
    carries an outgoing capability.
- **Unchanged and still enforced:**
  - `REAL_PAYMENTS_ENABLED=false`: the spend gate, payouts and live signers (`config.ts:92`, `adapters.ts:54-57`);
  - `custody_execution_enabled` CHECK (p10:40);
  - payment-order execution pins (p32:242-274);
  - `OWNER_SWEEP_ENABLED` (a no-op, `index.ts:374-376`);
  - `REAL_REPLICATION_ENABLED`, `FLEET_DRY_RUN_CHILD`;
  - cap 2; mode DEVELOPMENT.
- **No outgoing path is added.** The gateway's token is requested via the OAuth flow with scopes `edit_products
  view_sales view_payouts` only. Self-generated tokens default to *every* public scope including `account` (B), so
  **use the OAuth flow, not "Generate access token"**. There is no `edit_sales`, so the gateway cannot issue refunds.
- **New permissions:**
  - DB role `fleet_provider(_login)` with `gx_*` functions only; added to the privilege-audit role maps and writer
    maps;
  - controller `svc_storefront_*` functions added to `SERVICE_API_FUNCTIONS` (migrations.ts:1201-1259);
  - owner `fleet_admin_*` functions run through the admin DSN, needing the `fleet_treasury` approver as for rails
    today (p29:485).
  - None of this grants or changes any spend, transfer or payout function.

---

## 3. Exact changes

### 3.1 Schema v46 (`migrations-phase46.ts`, additive; no backfill, no journal)

1. **`fleet_payment_rails`:**
   - add mode `live_receive` to the mode CHECK and the scope CHECK above;
   - change the default status to `pending_setup`;
   - `fleet_admin_rail_add`: insert as `pending_setup`, and resolve nothing while pending;
   - `fleet_admin_rail_set_status`: allow `pending_setup → active` only when a verified capability exists.
2. **`fleet_rail_capability_checks`** (above) plus `fleet_admin_rail_verify(rail, capability, evidence, actor)` and
   `gx_rail_probe_result(...)`.
3. **`fleet_rail_match` / `fleet_rail_resolve`:**
   - match on a verified capability;
   - build the answer text from verified capabilities;
   - add `fleet_admin_rail_assign(rail, venture, capability, actor)`.
4. **`fleet_provider_accounts`:** rail, provider, provider `user_id`, masked label.
5. **`fleet_provider_products`:** provider account, product id (unique), venture, agent, `created_via`
   `gateway|owner_assigned`, status, file refs. Immutable owner columns; reassignment is an owner function plus an
   event.
6. **`fleet_provider_sales`:** memo of each verified sale.
   - Columns: account, sale id (unique), product, venture/agent (nullable = unattributed), price and fee in USD,
     taxes, listing currency, flags (refunded, partially refunded, chargedback, disputed, dispute won), `read_at`,
     `payload_sha256`.
   - Status: `verified | in_balance | in_payout | settled | reversed`.
   - Only `gx_sales_upsert` writes it, from authenticated read-back.
7. **`fleet_provider_payouts`** and **`fleet_provider_payout_lines`:**
   - payout id, GBP amount and currency as reported, status, `processed_at`;
   - lines per purchase with net, fees, taxes and sign;
   - `confirmed_received_at` / `confirmed_by` / the confirmed GBP amount;
   - the allocation result.
8. **Ledger:**
   - class `agent_provider_payable` (agent scope, liability, credit-normal);
   - wired into `fleet_agent_economics` equity as an obligation (p42 restate), `fleet_agent_wallet` and
     `fleet_agent_value`;
   - `fleet_ledger_open_agent` extended, with the same backfill pattern as `agent_tax_reserve` (p29:236-251; no
     journal);
   - kinds: `provider_payout_settlement` (D agent_cash, D agent_fees, C agent_revenue; D agent_provider_payable when
     repaying), `provider_clawback` (D agent_revenue, C agent_cash / C agent_provider_payable);
   - allowed source `controller` (owner for corrections), provenance `external_customer_revenue`;
   - kinds and rules are append-only (p10:165), so this changes the economic-policy hash (p21:68-75). That is
     expected and recorded.
9. **`fleet_revenue_claims`** plus the `fleet_admin_record_external` claim parameter and the active-rail refusal.
10. **`fleet_economic_model.simulated_settlement_allowed boolean NOT NULL DEFAULT false`**, plus guards in
    `svc_settlement_ingest`, `fleet_settlement_post` and the new posting functions.
11. **Functions:**
    - owner: `fleet_admin_storefront_payout_confirm(payout, gbp_amount, received_on, actor)`, which allocates and
      posts in one transaction and refuses a mismatch beyond tolerance;
    - owner: `fleet_admin_storefront_product_assign`;
    - gateway: `gx_*` job claim and report, sales upsert, payout upsert, probe result;
    - controller: `svc_storefront_*` agent ops, dispatched like p37 browser ops.
12. **Reconcile:** `PROVIDER_UNATTRIBUTED_SALES` (WARN), `PROVIDER_PAYOUT_UNCONFIRMED` older than 14 days (WARN),
    `PROVIDER_PAYOUT_ALLOCATION` (Σ shares = confirmed amount; FAIL), `REVENUE_CLAIM_ORPHANS` (FAIL),
    `PROVIDER_PAYABLE_OUTSTANDING` (INFO).
13. **Privilege audit:** new role, writer maps and required triggers. The not-live and live_receive-scope checks.
    `simulated_settlement_allowed = false` on production.
14. **Dashboard:** read-only `hub` sections for storefront, pending revenue and payouts. No write ops in phase 1.

### 3.2 Code

- `src/fleet/storefront/` (new):
  - `gumroad-client.ts`: fetch with host allowlist; retries on 429/5xx; pagination with `page_key`;
  - `gateway.ts`: job loop, polling, reconciliation;
  - `vault.ts`: same pattern as `ProviderSecretVault`, `identity/vaults.ts:178-242`;
  - `main.ts`: the unit's entry point, plus a stdin-only `secret-set`;
  - `allocation.ts`: pure function, largest-remainder rounding.
- `deploy/systemd/automaton-fleet-gumroad.service` and `scripts/fleet-gumroad-setup.sh` (check / install / --apply,
  like `fleet-browser-setup.sh`).
- `src/fleet/founder/toolbox.ts` and `cognition/types.ts`: `storefront.*` tools (capability `planning`). Doctrine
  stays founder-v5; this is a tool addition, so the capability signature changes and founders get a full packet.
- `src/fleet/identity` (browser policy): `FLEET_PROVIDER_VIA_GATEWAY` on gumroad origins.
- `src/fleet/hub/cli.ts`: `economy-rail-verify`, `economy-rail-assign`, `storefront-payout-confirm`,
  `storefront-product-assign`, `storefront-status`.
- `src/fleet/treasury/ledger-cli.ts`: `--claims` for `ledger-record-revenue`.

### 3.3 Secure credential onboarding

No secret ever appears in chat, in the repository, or on a command line.

1. The owner, on gumroad.com: Settings → Advanced → create an application (redirect `http://127.0.0.1`).
2. On the VPS, as the owner: `sudo scripts/fleet-gumroad-setup.sh oauth-begin`.
   - It prints the authorise URL with `scope=edit_products view_sales view_payouts`.
   - The owner approves in their own browser and pastes the returned **code**. The code is single-use and
     short-lived; the access token itself never leaves the gateway.
   - The gateway exchanges the code (`POST /oauth/token`) and writes the token into its vault.
   - It prints only the fingerprint, the granted scopes and the `user_id`.
   - The client secret is read from stdin, never from argv.
3. `fleet:admin economy-credential-register gumroad vault:gumroad/main edit_products,view_sales,view_payouts …`,
   then `economy-rail-add gumroad shared storefront,receive_payments <masked> --mode live_receive`. The rail starts
   `pending_setup` and resolves nothing.
4. `economy-rail-verify <rail> storefront`. The probes run; the owner's attestation is recorded.
5. Revocation: revoke in Gumroad (this also deletes its resource subscriptions, B), plus `economy-rail-status
   revoked`. Assignments are released (p29:498-513).

---

## 4. Acceptance tests

**Local fixtures and database tests**, no network; a fake Gumroad HTTP server built from the documented payloads:

1. A rail is created `pending_setup` and **no requirement or dependency changes**. A dependency is answered only
   after its capability is verified, and its text names exactly the verified capabilities. Approving through
   `owner-request-decide` alone still assigns nothing.
2. `live_receive` refuses `payouts`, `refunds`, `card_spend` and `bank_transfer`. `mode <> 'live'` is still enforced.
   The audit fails on a tampered CHECK.
3. A ping is never data: posting a forged sale through the trigger path changes nothing until read back. A read-back
   for a `test` purchase, which is absent from `/sales`, is ignored.
4. Duplicate pings, retries, out-of-order refund-before-sale, and a missed notification recovered by polling: every
   case ends in exactly one memo row per (sale, kind) and **zero ledger postings**.
5. **No money before receipt:** verified sales and `completed` payouts leave `agent_cash` and expensePurchasingCapacity
   unchanged. Only `storefront-payout-confirm` posts.
6. Allocation: a mixed two-venture payout with fees, taxes, a partial refund and a chargeback row sums exactly to the
   confirmed GBP (property test with random rows). Rounding gives each agent no more than 1p.
7. A negative share beyond cash creates `agent_provider_payable`, which reduces expensePurchasingCapacity, and is
   repaid from the next payout. `dispute_won` restores it.
8. Unattributed products hold the whole payout (`unallocated`). The owner's assign plus confirm then posts.
9. Simulated or sandbox rail ingest is refused when `simulated_settlement_allowed=false`. Existing F2 simulation tests
   set the flag on their throwaway registry.
10. Double credit: `ledger-record-revenue --claims` and `provider_payout_settlement` on the same payout cannot both
    post. Manual revenue against an active gumroad rail without `--claims` is refused. The reconcile orphan check
    fires.
11. Ownership: agent A cannot update, publish, attach to or read sales of agent B's product
    (`FLEET_CREDENTIAL_SCOPE`). The browser refuses gumroad credential fills and registration.
12. The token never appears in logs, events, job rows, receipts or snapshots (same pattern as the existing
    credential-in-records check).
13. Privilege audit clean. Migration v45 → v46 alone and from every earlier step (`fleet-f2-migration-paths-pg`).
    `reconcile-compare` passes with no economics key, external transaction or journal change.

**Provider test purchases**, on the real account, explicitly authorised. They **cannot prove settlement**:

14. The `storefront` probe (draft create and delete) and the first real publish return no `warning`.
15. A logged-in test purchase with Gumroad's "Test card": a ping with `test: true` arrives if a subscription is
    configured. It is **absent** from `GET /sales` and is ignored. Nothing is recorded.

**Live pilot**, a separate explicit owner authorisation:

16. A real third-party sale: verified memo in the right venture, with the founder seeing the pending, not spendable,
    memo.
17. The first payout: allocation, the owner's receipt confirmation, `agent_cash` credited, and a clean reconcile.
18. A real refund, partial or full, by the owner in the dashboard: reflected in the next payout's allocation.

---

## 5. Migration and write-preserving rollback

**Order**
1. Ship v46 **dormant**: no gateway unit installed, no rails.
2. Rehearse on a production copy (`fleet-rollout.sh rehearse 45 46`). `reconcile-compare` requires no new events
   except role grants, unchanged balances and zero new journals.
3. Cut over (`fleet-rollout.sh cutover … 45 46`). Then install the gateway unit (`fleet-gumroad-setup.sh`), in the
   same pattern as the R41.1 browser worker.

**Rollback before any storefront data exists** (no rail, credential or provider rows): the standard schema revert
(`fleet-rollout.sh revert … 45 46`), with the post-cutover dump written first. Since no gumroad writes exist, the
`DISCARD_ACK` counts are the journals and events since the cutover, which reconcile shows.

**Rollback after storefront data exists:** **do not restore the database over it.** Older releases refuse newer
schemas (`store.ts:512-516`), so a schema revert would discard real sales memos and payouts. Instead, freeze and fix
forward:
1. `systemctl disable --now automaton-fleet-gumroad` (no new provider reads or writes).
2. `economy-rail-status <rail> suspended` (no matching; assignments kept).
3. Agents' storefront tools return `FLEET_CAPABILITY_NOT_CONFIGURED` ("only this action is unavailable").
4. Fix forward in a v47. Ledger postings are append-only. Any correction is a reversing journal through
   `ledger-reverse` (owner), never a restore.
5. A database restore stays possible only through `FLEET_REVERT_DISCARD_ACK` with the post-cutover dump preserved.
   That is the existing explicit-discard rule, never silent.

**Founder rollback** is unaffected. Founder runtimes on `fda78a0` simply lack the storefront tools. The new tools are
gated by the capability signature, so a v46 controller serves them only to runtimes that implement them, the same
pattern as the doctrine gate.

---

## 6. Stages

| Stage | Work | Gate |
|---|---|---|
| **G0** (owner, parallel) | Decisions below; create the seller account on gumroad.com; confirm email; payout method; Stripe verification when asked | none in the fleet |
| **G1** | v46 schema, lifecycle fix, simulated-settlement guard, claims, memo tables, allocation, ledger kinds and class, reconcile, audit; tests 1–13 | local suites; `test:security` / `test:financial` (the 2 pre-existing R39 failures reported as they are) |
| **G2** | Gateway unit, fake-Gumroad fixtures, agent tools, browser policy, setup script, onboarding CLI | tests 11–12; release-script tests |
| **G3** | Rehearsal on a production copy; then cutover 45 → 46 dormant | owner approval (production) |
| **G4** | Gateway install, OAuth onboarding, rail `pending_setup`, `storefront` verification; tests 14–15 | owner approval; **storefront verified → 6178c7bb auto-answered truthfully; owner answers 62cbe1b7** |
| **G5** | Live pilot: the founders publish by their own choice; the first real sale and payout; tests 16–18 | separate explicit owner authorisation; `receive_payments` and `payouts` verified only then |

---

## 7. Minimum owner decisions before account setup

1. **Arrangement:** one shared seller account behind the broker (recommended), or linked accounts per venture.
   Products cannot be moved between accounts later.
2. **Seller identity:** individual or a company. Registration data must be "true, accurate, current and complete"
   (§4.4). A business's bank must be in its country of registration (`_13`).
3. **Account email:** an owner-controlled mailbox that is not used by any agent. The owner's mail decision currently
   keeps fleet mail dormant.
4. **Listing currency:** GBP or USD. Settlement is USD either way, and the payout is GBP.
5. **Operation policy:** agents use the Gumroad API only through the broker and never the dashboard. Refunds and
   dispute responses stay owner-only in phase 1.
6. **Self-purchase rule:** test only with Gumroad's logged-in "Test card". **Never** buy your own product with a real
   card (`_62`, `_281`).

**Unsettled, to confirm with Gumroad support if needed:**
- whether a linked account's new Connect account needs its own ID verification;
- whether `price` includes tax;
- the `currency` and amount reported for a GBP payout in the API;
- whether any dashboard automation is acceptable. This plan avoids needing it.
