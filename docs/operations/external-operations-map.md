# External operations: readiness, one channel's feasibility, smallest pilot

Written 2026-10-30. Objective: an agent operates an external business; the owner handles account verification and exceptional decisions, not routine proposals or messages. Local only: nothing here is deployed, connected, posted or spent.

**Engineering readiness and customer demand are separate questions.** This document can raise the first. Only real customers can answer the second, and none has been asked.

## 0. External-order tracking: what now holds

**A claim is not an outcome.** The agent's word and a captured browser page are claims. Only a provider read or the owner's confirmation completes an order, closes its obligation or changes its sale record. Two independent reviews drove this: the first showed a page reading "awaiting dispatch" passing as delivered.

- **Providers:** no client sends delivery or refund state yet, so a provider read is proven only with injected test data. On a channel with no such read, orders stay owed until the owner confirms. A chosen channel must supply that read or have no discrete orders.
- **Known limits:** a reference written in some other form ("receipt 8841") stays a visible second order rather than merging. Repeating the same refund amount does not alert again. Etsy reads no more than 100 receipts and drops unparseable ones; that stays Etsy-only work.

## 1. Channel feasibility: Apify Store

**Assessed against its own documentation** because its pages can be read; Upwork, Fiverr and Etsy refuse automated reading. Apify is not selected and no account exists. Upwork's documented connection needs a person to confirm each write (search excerpt), which fails the objective, so it is dropped unless its unread API terms say otherwise.

Apify Store is a marketplace of paid automation tools ("Actors"). Users run them; Apify collects payment and pays the creator.

| Action | Status | Source |
|---|---|---|
| Create an Actor, upload source, build | **Runs unattended by API** | API reference: `POST /v2/actors`, `/versions`, `/builds` |
| Set title, categories, pay-per-event pricing, `isPublic` | **API documented.** Whether this alone satisfies the Store checklist is **unknown** | `PUT /v2/actors/:id`; publish page describes the checklist as Console steps |
| Customer buys and receives output | **Runs without us**: a run is the delivery | Pay-per-event docs |
| Run outcome and results | **Runs unattended**: run endpoints, webhooks | API reference, webhook events |
| Charging | **Runs unattended**: the Actor's own code charges events | Pay-per-event docs |
| Account creation | **Owner only**: "Personal Accounts must be created by humans", bots barred | General Terms 4.1.1 |
| Identity (KYC), tax, payout details, accepting Store terms | **Owner only**, once, plus "ongoing" verification. No payouts before it | Store Terms 10.1 |
| Monthly invoice | **No routine action**: auto-approved on the 14th unless disputed | Monthly payouts page |
| Compensation or monetary refund | **Owner, exceptional**: support chat, no API found; goes through Apify's staff | Compensation page |
| Issues from users | Delivered to the **account's email**; must be addressed within 14 days. **API to read or answer: unknown** | Store Terms 8.1 |
| Earnings or invoices by API | **Unknown.** Only Console is documented; monthly usage endpoints exist for consumption | Payouts page, API index |
| An automated process using the owner's own token | **Unknown and decisive.** Terms bar a "third party" using the account and do not address automation | General Terms 4.2 |
| AI-written Actors | No rule found either way. "You may create and publish an Actor of any kind"; you must be able to support it | Store Terms 2.2.4.1, 4.3 |

**Money:** Apify keeps 20%, minus platform usage for pay-per-event. Payout minimum $20 for PayPal, days 21-25 of the month (the payouts page also names Wise; the Terms do not). Merchant of record is not stated. Who paid is not stated to be visible to the creator. **This fits the treasury PayPal rail without a bank fact.** Czech law. Apify may unpublish without notice.

**Security note:** scoped tokens "cannot create or modify Actors" (search excerpt of Apify's docs), so publishing needs a full-account token. It must stay in the channel gateway, never reach the agent.

**Unsupported or absent:** discrete orders. Usage-based sales have no per-order record to complete, so external orders apply here only to issues and compensation.

**The one owner request is at the end of this document.** It settles whether this channel is usable.

## 2. Conditional build for this channel (only if selected)

Not built. Connector and client for Apify in the channel gateway; publish and read ops; issues mail routed to the agent's obligations; earnings read from the owner's monthly figure unless an API exists; PayPal payout claim through the existing `treasury_paypal` route, linked in Treasury Watch. Etsy paging and fees stay Etsy-only and are not prerequisites.

## 3. Smallest pilot that advances the goal

If the owner request clears, one agent publishes one usage-priced Actor it chose on evidence, with no owner involvement in routine work.

- **Proves (engineering):** publish unattended, a real outside user's run, an issue answered through email, a real payout reaching PayPal and reconciled.
- **Does not prove:** that anyone wants it. A pass on engineering with no users is a demand failure, not a success.
- **Stop:** any platform warning, any repeated failure, or the separately approved limit.
- **Budget and allowance:** not requested here; needs a separate proposal with real measured costs.
- Compute and third-party AI costs fall on the creator under pay-per-event, so pricing must cover them.

## Sources

[Publishing](https://docs.apify.com/platform/actors/publishing), [publish steps](https://docs.apify.com/platform/actors/publishing/publish), [monetisation](https://docs.apify.com/platform/actors/publishing/monetize), [pay per event](https://docs.apify.com/platform/actors/publishing/monetize/pay-per-event), [monthly payouts](https://docs.apify.com/actors/monetize/monthly-payouts), [compensation](https://docs.apify.com/actors/monetize/compensation-requests), [API](https://docs.apify.com/api/v2), [webhooks](https://docs.apify.com/platform/integrations/webhooks), [API integration](https://docs.apify.com/integrations/api), [Store terms](https://docs.apify.com/legal/store-publishing-terms-and-conditions), [General terms](https://docs.apify.com/legal/general-terms-and-conditions), [Acceptable use](https://docs.apify.com/legal/acceptable-use-policy).
