# Gumroad readiness for the founders' selected sales channels (assessment, 2026-10-08)

This is a read-only assessment. Nothing was created, published, registered, resolved or moved. The code references are
the deployed `fda78a0` (`git diff fda78a0 HEAD -- src` is empty).

Gumroad facts come from Gumroad's own open-source application, `antiwork/gumroad` at commit `6d535ea8` (2026-10-08).
It is the source of the help centre and the API pages:
- `app/views/help_center/articles/contents/_<n>-….html.erb`, published at `https://gumroad.com/help/article/<n>-…`;
- `app/javascript/components/ApiDocumentation/…`, published at `https://gumroad.com/api`;
- `app/javascript/pages/Public/Ping.tsx`, published at `https://gumroad.com/ping`.

Gumroad is the founders' **current choice** of channel, not a fleet restriction. A blocked storefront action blocks
only that action. Journaling, study and hibernation stay voluntary. Live journal persistence and an event-triggered
full wake are still **awaiting observation**. Event detection can still be delayed by up to about 32 minutes by the
idle skip.

## Bottom line

- **Neither pending request can truthfully be resolved today.**
- **The fleet has no Gumroad integration.** It has no Gumroad API client, no sale notification endpoint, no product
  to venture mapping, and no "unsettled" ledger state.
- **The one command that would resolve 6178c7bb automatically would resolve it falsely.** That command registers a
  rail. The rail would have to be labelled `simulated` or `sandbox`, because `live` is blocked by a database
  constraint (`phase29.ts:366`). Gumroad describes no sandbox. And no sale would ever reach the ledger.
- **REAL_PAYMENTS_ENABLED is not what blocks incoming revenue.** It gates outgoing payments and payouts only. What
  blocks incoming revenue is missing code, plus the `mode <> 'live'` constraint.
- **The owner can do the Gumroad-side setup now, entirely on gumroad.com.** That covers creating accounts,
  confirming email, and entering payout and identity details. It changes nothing in the fleet.

## 1. What each request actually requires

### Gumroad's requirements (confirmed, official sources)

**1. An account and publishing.**
- `POST /v2/products` creates a product. It is published immediately unless the account cannot publish yet:
  > If publishing is blocked (for example, your email address is not confirmed or no payout method is set up), the
  > product is saved as a draft
  (`ApiDocumentation/Endpoints/Products.tsx:420-428`)
- So a **confirmed email address and a payout method** are prerequisites for a listing to go live. Creating the
  product needs the `edit_products` or `account` scope.

**2. Payout method and identity.**
- Payout settings need a full legal name and a physical address.
- Payouts go to a local bank account in its local currency. The UK is supported, in GBP.
- "If you sell as a business, your bank account must be in the country where your business is registered."
- Identity verification (KYC) is Stripe's: it "requires additional information to verify the identity of the account
  holder after a certain amount of time has passed and sales accrued". ID and address documents are uploaded to
  Gumroad/Stripe.
- Source: `_13-getting-paid`.
- So **KYC is a payout requirement that can arrive after the first sales**, not necessarily a precondition for
  listing.

**3. Payout readiness.**
- Minimum payout: $100 before verification, $10 after (local minimums can be higher).
- Weekly, monthly and quarterly schedules hold each sale at least 7 days.
- Payouts skip while the account is under review. "None of the money is lost."
- Sources: `_13-getting-paid`, `_281-payout-delays`.

**4. Fees, refunds and chargebacks.**
- Fees: 10% + $0.50 per direct sale, plus card processing of 2.9% + $0.30. Discover marketplace sales: a flat 30%
  (`_66-gumroads-fees`).
- On a refund, Gumroad's own fee is returned and the processing part is kept (`_66`).
- A refund needs enough balance to cover it (`_47-how-to-refund-a-customer`).
- On a chargeback, "you are responsible for covering both the refunded amount and any payment processing fees".
  Gumroad returns its platform fee, and a won dispute comes back as a balance credit (`_134`, `_269`).

**5. Notifications.**
- The Ping (`Ping.tsx`) is unsigned. Delivery order is not guaranteed, and retries stop after about 1 hour.
- Gumroad's own guidance: "treat a ping as a trigger rather than as data: take sale_id, read the sale back through the
  API, and reconcile periodically".
- Resource subscriptions cover `sale`, `refund`, `dispute`, `dispute_won`, `cancellation` and the subscription
  events. They need `view_sales` (`ResourceSubscriptions.tsx:13-14`).
- Sales come from `GET /v2/sales` and `GET /v2/sales/:id`. Each sale includes `product_id`, `price`, `gumroad_fee`,
  `refunded`, `partially_refunded`, `chargedback`, `disputed` and `dispute_won` (`Sales.tsx`).
- Payouts come from `GET /v2/payouts` (`Payouts.tsx`).
- Test purchases are flagged `test`. The docs describe **no sandbox environment**.

### 62cbe1b7 (Founder 1, `landlord-compliance-tracker`, channel `gumroad`)

- **Recorded action:** "List the landlord compliance tracker on Gumroad (a Gumroad seller account needs a human
  identity/KYC)". It is kind `kyc`, imported from a legacy knowledge proposal (`phase26.ts:22, 33-36, 131-133`).
- **Not linked to any rail requirement.** Founder 1 has no `fleet_rail_requirements` row, as the read-only review
  showed.
- **Deciding it has no side effects.** `fleet:admin owner-request-decide` changes only the row and emits
  `owner_request_decided`. In the function's own words: "it grants no capability, account, money or permission"
  (`phase25.ts:143-150`).
- **What would truthfully satisfy it:**
  - a Gumroad seller account under a human identity, with email confirmed and a payout method, so that a listing can
    publish;
  - a sanctioned way for Founder 1's listing to be published on that account;
  - a working path for its sales to reach Founder 1's books (§3).
- Account creation and KYC are owner-side. Publishing and the sales path are missing work.

### 6178c7bb (Agent 2, `uk-sa-template`, channel `storefront`)

- **Created by** `fleet_rail_resolve` when Agent 2 called `rail.require` (capability `storefront`, provider
  `gumroad`) and no rail matched (`phase29.ts:459-472`). Title: "Payment rail required: gumroad / storefront".
- **What resolves it:** registering an **active** rail with provider `gumroad` and capability `storefront`. Then
  `fleet_admin_rail_add` loops over every open or `dependency` requirement fleet-wide, assigns the rail, and answers
  the linked dependency "A compatible Fleet payment rail is now connected" (`phase29.ts:444-458`, `:479-497`).
- **Approving it through `owner-request-decide` assigns nothing.** The requirement stays in `dependency`
  (`phase29.ts:442-443`).
- **Truthfully,** it can be resolved only when that rail is backed by a real, connected Gumroad account **and** the
  fleet can ingest and settle that account's sales correctly. Neither exists, so registering the rail now would tell
  Agent 2 something false.

## 2. Shared owner account or separate accounts

**What Gumroad supports (confirmed)**
- **Several accounts per person**, "for separate brands or businesses". Each needs a unique email address.
- They should be created through "New Gumroad" so they are linked, and a new one "can copy your existing payout
  setup, so you do not have to go through payments onboarding again". They can pay out to the same bank account.
- Hiding the connection between accounts is not allowed.
- **Products cannot be transferred between accounts.**
- Source: `_252-multiple-accounts`.
- **Teams** add people to one account with roles. The Products role is full access to all products (`_326`).
- **API scopes are account-wide** (`Scopes.tsx`: `edit_products`, `view_sales`, `view_payouts`, `account`, …).
  There is no per-product scope.
- **Collaborators** split a product's proceeds with another account at most 50%, and each collaborator must have its
  own account with payment settings (`_341`).

**What the fleet models (implemented)**
- A `shared` rail serves many ventures (`max_ventures`). A `dedicated` rail serves one (`phase29.ts:345-369`,
  `:384-394`).
- The design intends one fleet-level storefront identity set up once by the owner
  (`docs/design/f2-autonomous-economy.md:34`, `:266-280`).
- Attribution on a shared rail uses the venture id the adapter reports, accepted only with a live assignment;
  otherwise the sale is `unattributed` (`phase29.ts:792-800`).
- Credentials are a `vault:` reference brokered per call, never shown to the agent (`phase29.ts:249-268`,
  `payments/credential-broker.ts:1-11, 62-88`).

**What is missing**
- A product to venture mapping. The only attribution key in code is PayPal's `custom_field`
  (`payments/adapters.ts:100`).
- A controller-side vault wiring for rail credentials.

**Consequences (owner decision)**

| | One shared owner account | One linked account per venture |
|---|---|---|
| KYC | once | once; linked accounts can copy the payout setup |
| Attribution | needs a `product_id` → venture mapping (missing) | the account itself identifies the venture (`seller_id`, or a dedicated rail) |
| Credential isolation | one account-wide token: any agent holding it could edit or read **every** venture's products and sales | each token reaches only its own venture's account |
| Fleet model | `shared` rail | `dedicated` rail per venture |
| Moving a product later | impossible (no transfer) | impossible (no transfer) |

- **Recommendation: one linked account per venture**, with dedicated rails. Gumroad's token scopes are account-wide,
  so per-venture accounts give real isolation between agents, and attribution then needs no new mapping.
- A shared account is workable only if agents never hold its token, meaning all publishing goes through a controller
  adapter, and the mapping is built.
- Either way the accounts are the owner's, under the owner's identity.

## 3. From publication to usable capital

| Step | Implemented | Missing |
|---|---|---|
| Publish a product | `ProviderAdapter.createListing` interface only (`payments/types.ts:30-44`). Simulated adapter returns a fake URL (`adapters.ts:48-52`). | A Gumroad adapter (`POST /v2/products`, enable). No agent op calls `createListing`. An agent could drive gumroad.com with `browser`, but nothing would record the product as the venture's. |
| Sale notification | Polling core `syncRail` (`adapters.ts:135-147`), used **only in tests** | A Gumroad Ping or resource-subscription receiver, or a sales poller. There is no provider-callback route in `service/server.ts`. |
| Verification | Format checks; trust is the controller's service role (`phase29.ts:770-781`) | Re-fetching every sale by `sale_id` via `GET /v2/sales/:id`, as Gumroad itself advises. Ping is unsigned. |
| Idempotency | `UNIQUE(rail_id, external_id, kind)`; replay is a no-op; a conflict emits `settlement_conflict` (`phase29.ts:697, 782-790`) | Dedup on `sale_id` + `resource_name` (Gumroad: a refund shares the sale's `sale_id`). The existing `kind` covers sale and refund. |
| Ledger | `venture_sale`: D `agent_cash` net, D `agent_fees` fee, C `agent_revenue` gross (`phase29.ts:217-222, 716-767`); optional tax reserve | an **unsettled / awaiting-payout** class (see below) |
| Fees | Fee recorded per sale | Gumroad's own fee comes back on a refund; the processing fee does not. Today a refund debits the full gross and **does not reverse any fee** (`phase29.ts:743-758`). |
| Refunds | `kind='refund'` (`phase29.ts:743-758`); fails if the agent's cash is too low (`:811-818`) | Partial refunds, and the fee split above |
| Disputes / chargebacks | **none**: `kind IN ('sale','refund')` (`phase29.ts:681`) | `dispute`, `chargeback`, `dispute_won` kinds and holds |
| Currency | Ingest refuses non-GBP sales: accounting currency `GBP` (`phase21.ts:36`, `phase29.ts:798`) | FX handling, or GBP-priced products |
| Payout to usable capital | none | Reconciling `GET /v2/payouts` against settled sales; **releasing** funds only when Gumroad has actually paid out into a custody-held account |
| Mode guard | none: ingest does not check the rail's `mode` | Refusing to credit cash from `simulated`/`sandbox` rails, or any rail without verified provenance |

**Spendability: a confirmed gap.** A settled sale's net is credited straight to `agent_cash`
(`phase29.ts:726-728`), and spending capacity is `LEAST(cash, equity)` (`phase11.ts:353-382`). Gumroad holds each sale
at least 7 days and may reverse it by refund or chargeback, so this would let **unsettled external balances become
spendable funds**. Nothing reads `last_settlement_at` as a gate. **This must be fixed before any real sale is
ingested:** a receivable or "unsettled" class, released to `agent_cash` only on a reconciled payout. Today the only
other path is the owner's manual, owner-attested `ledger-record-revenue` (`treasury/ledger-cli.ts:14, 131-139` →
`fleet_admin_record_external`, `phase11.ts:316`). It credits `agent_cash` at once and does not itself check that the
money has landed. It is truthful only if the owner records revenue **after** the Gumroad payout has actually arrived.

## 4. What the controls actually gate

| Operation | Gate | Works with the flags false? |
|---|---|---|
| Owner creates Gumroad accounts, confirms email, enters payout and KYC details on gumroad.com | none in the fleet (outside the system) | yes |
| Register a credential reference (`economy-credential-register`) or a rail (`economy-rail-add`) | `fleet_treasury` approver; rails `mode <> 'live'` **CHECK** (`phase29.ts:298-308, 366, 479-497`) | yes, but only as `simulated`/`sandbox` |
| Publish a product | nothing implemented and no flag (`adapters.ts:48, 108`) | not applicable |
| Record an incoming sale (`svc_settlement_ingest`, `ledger-record-revenue`) | **no flag** (`f2-autonomous-economy.md:1495`) | yes, so the spendability gap applies now |
| Outgoing payment orders | reservation in SQL; **execution** blocked by `custody_execution_enabled` CHECK (`phase10.ts:40`) and the env check in `executeApprovedSpend` | reservation only |
| Payouts initiated by the fleet | `REAL_PAYMENTS_ENABLED` spend gate, then `FLEET_CUSTODY_EXECUTION_DISABLED` (`adapters.ts:54-57, 113-116`) | no. Gumroad's own payouts to the owner's bank need nothing from the fleet. |

- **REAL_PAYMENTS_ENABLED** (`config.ts:10, 92`) gates outgoing spending: x402, Conway, ERC-8004, `fund_child` and
  `transfer_credits`, `executeApprovedSpend`, live PayPal construction, payouts and live signers. Custody, the
  Operator API and the founder runtime **refuse to start** when it is true (`custody/main.ts:51`,
  `operator/main.ts:46`, `founder/runtime.ts:75`).
  - So custody cannot execute live in this build in any configuration, which matches `f2-autonomous-economy.md:1178-1182`.
  - **Receiving revenue does not share this gate.**
- **OWNER_SWEEP_ENABLED** is a no-op ("not implemented; ignoring", `index.ts:374-376`). Sweeps are the database row
  `fleet_sweep_policy.enabled`.
- **REAL_REPLICATION_ENABLED** and **FLEET_DRY_RUN_CHILD** have no payment effect.

## 5. Ordered checklist

**What already works**
- **Agents:** they choose ventures, build products in their workspaces, and record dependencies. Agent 2 has a
  storefront requirement on file.
- **Rail model:** shared and dedicated rails, brokered credential references, and automatic assignment and
  dependency answering once a rail is added.
- **Owner bookkeeping:** manual, owner-attested recording of revenue (`ledger-record-revenue`). Use it only after a payout has actually landed.
- **Gumroad side:** the owner can set up the accounts on gumroad.com today.

**Owner decisions (no fleet change)**
1. **Account arrangement:** one linked Gumroad account per venture (recommended, §2) or one shared account.
2. **Seller identity:** individual or business. A business needs its bank in its country of registration. Record it
   later as a `fleet_legal_entities` row (`economy-entity-add`).
3. **Agent operation of the account:** whether founders may publish to the owner's account directly through the
   `browser` worker, or only through a controller adapter. Check Gumroad's Terms of Service for automated operation
   of an account. This assessment does not settle it.
4. **Product currency:** price in GBP, or approve FX work (the ingest refuses non-GBP).

**Owner actions on gumroad.com (never in chat; this resolves nothing yet)**
5. Create the account or accounts, linked through "New Gumroad". Confirm each email address.
6. Enter the payout method and legal details in Gumroad's payment settings. Complete Stripe identity verification
   **on Gumroad/Stripe** when asked. ID documents, bank details, passwords and API tokens **never** go into chat, the
   repository, or the fleet database.

**Missing work (an engineering stage to scope; not started)**
7. A Gumroad adapter:
   - authenticate with an owner-created API application (`_280-create-application-api`), its token stored in the
     custody or identity vault and referenced as `vault:…`;
   - sales and payouts read-back; product create and enable.
8. A receiver: resource subscriptions or Ping treated as triggers only, each sale re-fetched by id, plus periodic
   reconciliation.
9. A product to venture mapping, or dedicated rails.
10. **Ledger: an unsettled/receivable state, released only on a reconciled payout.** Also: refund fee semantics,
    dispute and chargeback kinds, and a rail-mode guard at ingest.
11. A reviewed migration, separate from REAL_PAYMENTS_ENABLED, that allows a **receive-only live** rail mode for
    Gumroad. Outgoing execution stays pinned off. Tests and a production-copy rehearsal are required.
12. Owner tooling: a decide-and-connect path, and a dashboard or Operator API view of rails and dependencies.

**Then: register and verify**
13. `economy-credential-register gumroad vault:gumroad/<venture> view_sales,view_payouts[,edit_products] …`, then
    `economy-entity-add`, then `economy-rail-add gumroad dedicated storefront,receive_payments,refunds <masked> …`.
    The rail auto-assigns and answers **6178c7bb**. Founder 1 must call `rail.require` itself (62cbe1b7 has no
    requirement), and its legacy request is then answered by the owner with the facts.
14. **Readiness check, before either request is resolved:**
    - a real `test` purchase of each product, re-fetched by API, lands **unsettled** in the right venture;
    - a refund reverses it with Gumroad's fee semantics;
    - the reconciliation report is clean;
    - funds become `agent_cash` only after the matching Gumroad payout appears in `GET /v2/payouts`.

**When each request can truthfully be resolved**
- **6178c7bb:** at step 13, and only after steps 7–11 are deployed and step 14 has passed.
- **62cbe1b7:** at the same point, for Founder 1's listing. If the owner instead lists the product manually and
  records revenue only after a payout lands (`ledger-record-revenue`), the answer must say exactly that, so Founder 1
  is not told a self-service storefront exists.

## Smallest next action for the owner

**Decide the account arrangement** (item 1, recommended: one linked Gumroad account per venture), and optionally
**begin items 5–6 on gumroad.com yourself**. Do not register a rail, and do not decide either request, until steps
7–14 are done: registering a rail now would answer 6178c7bb falsely.
