# External operations: readiness and the Apify decision

Written 2026-10-30. Objective: an agent operates an external business; the owner handles account verification and exceptional decisions, not routine proposals or messages. Local only: nothing here is deployed, connected, posted or spent.

**Engineering readiness and customer demand are separate questions.** This document can raise the first. Only real customers can answer the second, and none has been asked.

## 0. External-order tracking: what now holds

**A claim is not an outcome.** The agent's word and a captured browser page are claims. Only a provider read or the owner's confirmation completes an order, closes its obligation or changes its sale record. Two independent reviews drove this: the first showed a page reading "awaiting dispatch" passing as delivered.

- **Providers:** no client sends delivery or refund state yet, so a provider read is proven only with injected test data. On a channel with no such read, orders stay owed until the owner confirms. A chosen channel must supply that read or have no discrete orders.
- **Known limits:** a reference written in some other form ("receipt 8841") stays a visible second order rather than merging. Repeating the same refund amount does not alert again. Etsy reads no more than 100 receipts and drops unparseable ones; that stays Etsy-only work.

## 1. Apify Store: feasibility decision

**Decision: BLOCKED on the named answers in section 1.6.** Apify is a candidate, not a verified route. While waiting: no connector, no other platform, agents paused, paid calls off. Legal, pricing and plan statements here are findings from Apify's pages, not independently verified. Nothing was created, called with an account, published or spent; no mock was needed, because Apify's own API specification answers the endpoint questions. It would also make the first business a developer-tool business sold to technical buyers.

Evidence: [OpenAPI specification](https://docs.apify.com/api/openapi.json) version v2-2026-10-29 (141 paths, searched by code), official `apify-client` 2.25.0 and `apify-cli` 1.11.0 packages (read, not run), and official documentation.

### 1.1 Operations

| Need | Status | Evidence |
|---|---|---|
| Create, upload source, build | **Documented API** | `POST /v2/actors`, `/versions`, `/builds` |
| Publish | **Documented API**: set `isPublic`, `title`, `categories`. The publish guide also lists Console steps; whether the API enforces them is untested | `PUT /v2/actors/{id}` |
| Update, roll back a release | **Documented API**: new version and build, move `taggedBuilds` | same |
| Set pricing | **API field exists** (`pricingInfos`); the setup guide describes Console. Payout details must exist first (`cannot-monetize-without-payout-billing-info`) | spec, set-up guide |
| Withdraw | `isDeprecated` documented. Unpublish can be refused: `cannot-unpublish-paid-actor`, conditions undocumented | spec |
| Usage and health | **Documented API**: total users, 7/30/90-day users, review count and rating, 30-day public run status counts, excluding the owner's runs | `ActorStats` |
| Own account consumption and cap | **Documented API** | `/v2/users/me/usage/monthly`, `/limits` |
| **Customer issues** | **No public API.** No path in the spec, none in the client | Only error codes such as `issue-not-found` mention them, implying private endpoints |
| **Earnings, payouts, invoices** | **No public API** | Same. Console, with JSON export described for analytics |
| Reviews | Count and rating only; text in Store page | `ActorStats`, reviews guide |
| Who a customer is, or a customer's own failed run | **Not documented as visible**. Aggregates and "shared debug runs" only | monetise guide |

**Assumptions, not documented:** that the API publish path passes without Console steps; that an issue email carries the full text.

### 1.2 How unattended support would work

| Step | Route | Status |
|---|---|---|
| Learn of an issue | Email to the account's address (Store Terms 8.1), read by the Fleet's mailbox | Documented; content unknown |
| Learn of breakage | Daily tests, then email and Console; run-status counts by API | Documented |
| Record it | Inbound mail opens one durable obligation, as untrusted text | **Must be built** |
| Fix | Agent patches, builds, tests, moves the tag | Documented |
| **Reply to the user** | **No documented software route.** Only the Console Issues tab | **The break** |
| Compensation or money back | Support chat, by a person, then the creator tells the user | Exception, owner |
| Apify's own requests | 3 business days | Must alert the owner at P1 |

**A publishing API does not make an autonomous business.** Store Terms 8.1 can be met by fixing or updating within 14 days, but customers, ratings and the quality score expect answers, and compensation requires telling the user. Without a software reply route, the owner pastes routine replies, which fails the objective. Automating the Console with the owner's login needs Apify's answer first, and a sign-in check could defeat it.

### 1.3 Who is responsible

The contract for an Actor is between **the creator and the user; Apify "is not a party"** (Standard Actor Contract; Store Terms 4.1). So the owner, as sole trader, is the supplier. That contract caps liability at USD 100 where law allows, under Czech law, and consumer rights may not be excludable. If an Actor includes an AI system, the creator warrants AI Act compliance. Merchant of record and tax treatment are not stated.

### 1.4 Credentials

- **Publishing needs an unscoped, whole-account token:** "We do not allow scoped tokens to create or modify Actors." Organisation tokens are also full. Whether a limited role could publish is unread.
- **What the token can do:** delete Actors, change limits, read account data. **It has no payout route in the public API**, so the token alone has no documented way to redirect money.
- **Containment:** token only in the channel gateway's vault, never in an agent or sandbox; an allow-list of exact operations and fields (no delete, no limits, no `actorPermissionLevel`, no secrets in source); exact-account check before any job; rotation by the owner. All Fleet-side and all unbuilt.

### 1.5 Costs and failure

| | Fact |
|---|---|
| Plans | Free $0 with $5 usage a month; Creator $1 a month with one-time $500 usage over 6 months, "limits Apify Store to universal Actors" (term unexplained); Starter $19 |
| Formula | Profit = 0.8 × revenue − platform costs; negative profit set to $0 for the month |
| Payout | $20 minimum on PayPal, so at least $25 of revenue with zero platform cost; forfeited if unclaimed for 12 months |
| Creator bears | Third-party costs such as AI APIs; test usage on prepaid. Overage: invoiced on paid plans, blocked on Free |
| Upkeep | Apify suggests about 2 hours a week. Fleet AI cost **estimated** at $2.16-$17.32 a month (10-20 calls a week at $0.05-$0.20), to be measured, inside the existing ceiling only if separately approved |

**Failure containment:** bad release: roll back the tag. Failing: "under maintenance" after more than half of daily tests fail over 3 days; payouts stop while faulty; removal possible after 30 days with no reimbursement. Bad price: one change a month, 14 days' notice, cannot be cancelled, so first pricing is the owner's. Runaway customer run: user's cap, enforced by Apify, per run. Unlawful or prohibited Actor: removed without notice, on the owner's single account. **Hard limit: one owner account, so a violation by one agent hits everything on it.**

### 1.6 What is blocking: questions only Apify can answer

Sent by the owner to https://apify.com/contact:

1. **Automation.** May software I run use my own account's API token to create, publish and update my Actors with no person approving each action, given General Terms 4.1.1 and 4.2? May an AI agent write and maintain them, and must that be disclosed?
2. **Issues.** Is there a supported way for software to read and reply to Actor Issues? If not, may automated software use the Console Issues tab with my login? Does the notification email include the full text?
3. **Seller.** Given the Standard Actor Contract, who is merchant of record for charges, who issues tax invoices, and what must a UK sole trader do about VAT?
4. **Plan.** Can a Free or Creator account publish and earn from a public Actor, and what is a "universal Actor"?
5. **Statements.** What supported way is there to retrieve earnings, fees, adjustments and payout statements, by API or by export? I must be able to tell cash received in PayPal apart from revenue earned and money still owed.

Apify can explain its contractual and billing role; its answer does not settle the owner's tax obligations.

| Answers | Result |
|---|---|
| Q1 no | **Infeasible** |
| Q1 yes, Q2 no route | **Infeasible for an unattended business.** Only a supervised pilot, labelled as such, if the owner chooses |
| Q1 yes, Q2 a route, Q5 no statement route | **Blocked:** PayPal confirms cash received but cannot establish sales, fees or amounts still owed |
| Q1 yes, Q2 a route, Q5 a route | **Feasible to build**, once Q3 and Q4 are understood |

## 1.7 Repair before any next activation: engineering access

Recorded 30 Oct 2026 (VM clock). Not fixed. Both must work before any agent or inference is switched on, so that the engineer can watch and stop a run.

- **Operator read refused:** `FLEET_OP_STALE`, request timestamp outside +/-30 s. This VM's clock was 47577 seconds behind a web server's date at the time of recording. Repair the clock (host change, owner approval). The `+/-30 s` replay check must not be widened or bypassed.
- **Direct production reads refused** by this session's permission classifier ("Production Reads"). Restore an approved read route for the owner to choose; do not work around it.
- **Until then:** the last state read here is 13:43:21 UTC on 30 Oct 2026; Admin HQ is the only current evidence. Holds stay unchanged while the agents are paused.

## 2. Exact remaining scope, only if section 1.6 clears

1. `apify` provider in the channel gateway: client, exact-account check, operation and field allow-list, migration. Tested against a free mock built from the OpenAPI spec.
2. Publish, update and rollback jobs through existing review and capability gates, with an Actor as the offer.
3. Inbound Apify mail opens a durable obligation; a P1 alert for Apify's own requests; the reply route Apify names.
4. Health read from `ActorStats`, raising obligations and alerts.
5. Apify as a `treasury_paypal` counterparty, with the receipt linked in Treasury Watch and cash counted on arrival; plus reading the statement route Apify names (section 1.6, question 5), keeping earned, fees, adjustments, owed and received apart.
6. Usage read and owner-set cap.
7. Agent tool text and Field Guide note; release, one agent's runtime upgrade, Treasury Watch install.

Not needed: Etsy paging, per-order evidence for sales (kept for issues and compensation), new dashboards.

**Human-only:** account, KYC, tax, payout details, Store terms, first pricing, compensation requests.

## 3. Demand, separate

Nothing here shows anyone would pay. Before any commercial Actor is built: name a specific customer problem, and show credible existing usage or purchasing. Apify's `/v2/store` lists Actors with usage statistics and declares no authentication, which is a free place to look, not proof of revenue. **No customers without meaningful exposure to suitable buyers is inconclusive**, not a demand failure. This replaces my earlier wording.

## Sources

[API specification](https://docs.apify.com/api/openapi.json), [API tokens](https://docs.apify.com/platform/integrations/api), [publish](https://docs.apify.com/actors/publishing/publish.md), [set up monetization](https://docs.apify.com/actors/monetize/set-up-monetization.md), [pricing and costs](https://docs.apify.com/actors/monetize/pricing-and-costs.md), [monthly payouts](https://docs.apify.com/actors/monetize/monthly-payouts), [compensation](https://docs.apify.com/actors/monetize/compensation-requests.md), [testing](https://docs.apify.com/actors/publishing/test.md), [actors in Store](https://docs.apify.com/actors/running/actors-in-store.md), [agent skills](https://docs.apify.com/agents/skills.md), [pricing](https://apify.com/pricing), [Store Publishing Terms](https://docs.apify.com/legal/store-publishing-terms-and-conditions), [Standard Actor Contract](https://docs.apify.com/legal/standard-actor-contract), [General Terms](https://docs.apify.com/legal/general-terms-and-conditions), [Acceptable Use](https://docs.apify.com/legal/acceptable-use-policy).
