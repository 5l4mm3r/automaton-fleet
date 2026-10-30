# External operations: one workflow recommendation and a finite completion proposal

Written 2026-10-30, replacing the earlier map on this branch (which wrongly said the remaining blockers were not code, and recommended a channel on payout convenience). Local only: nothing here is deployed, posted, sent or spent.

**Status of the evidence:** market facts below are from public web sources read in an engineering session, mostly vendors. No customer has been asked anything. Demand is a hypothesis until the test in section 5 passes. All costs marked *estimate* are unmeasured.

## 1. Recommendation

**Sell a fixed-price accessibility pre-audit (about £149) to UK limited companies with online stores that sell into the EU, found and contacted directly by the agent, each first email carrying real findings from that company's own site.**

| | A. Accessibility pre-audit | B. MTD record-keeping kit | C. Catalogue data clean-up |
|---|---|---|---|
| Customer problem | Stores selling into the EU must meet the Accessibility Act; agency audits are priced for larger budgets | Sole traders over £30,000 join MTD in April 2027 and must keep digital records | Stores have broken product data, feed and import errors |
| Demand evidence | Enforcement is real and recent, but no evidence yet that this buyer pays £149 | Large cohort (HMRC est. 970,000 at the second stage), low readiness | Real gigs and bids exist, thin price data |
| Competition | Agencies at €2,000-€5,000+ for an audit; free scanners below | Free recognised bridging exists; heavy vendor marketing | Apps at $9-10 a month; bids of $90-150 |
| Achievable value | Good, but partial: see limits below | Low: a template against free tools | High and fully checkable |
| Margin, one sale (*estimate*) | £134.78-£141.98 after fee and AI | About £17.20 | About £116 before AI |
| Customer access | **Direct:** cold email to companies is allowed under PECR; each site is public and the proof is tailored | **Weak:** sole traders are individual subscribers, so no cold email; SEO or marketplace only, and slow | Direct is possible; marketplaces need a verified human |
| Main risk | False assurance, and a sole trader's personal liability | Low sales; accountancy-service rules if tailored | Price race to the bottom |

**Why A:** it is the only one combining a high enough price, a customer the agent may lawfully reach itself, and a first contact that proves capability. **Fallback: C,** which reuses the same outreach and fulfilment; B is rejected. The landlord tracker stays an execution test.

**Limits that must be stated to buyers:**
- It is not a conformance audit or certificate. Automated tools miss many issues (Deque's own study: 57% of issues found, by volume), and the agent has no real screen-reader testing. The FTC's $1m accessiBe order shows the danger of overclaiming.
- **Microenterprises are exempt for services:** under 10 staff and up to €2m turnover. Targets must be above that, or the honest answer is "you may not need this".
- First wave is UK companies only. Other EU countries' email rules are stricter and unchecked.

## 2. Seller and payout: what is known

- **Seller:** recorded as an individual sole trader with a virtual-office address (owner decision, 17 Oct). I could not re-read the live record today.
- **Bank:** the earlier "no bank account" was wrong. On 17 Oct the owner declined a *separate* sole-trader account and uses a personal debit card. This workflow needs no bank fact: buyers pay through the PayPal treasury rail, already active and proven receiving real money.
- **Sole trader means unlimited personal liability** for a wrong report: an insurance decision for the owner.

## 3. Smallest implementation for this workflow

| Stage | What exists | Evidence | Gap to build |
|---|---|---|---|
| Find, contact | `lead.add`, `mail.send {outreach}`, lawful basis, suppression, opt-out | Local tests | **Site scan op** (pinned axe-core in the browser worker, public pages, read-only, rate-limited) |
| Ingestion | Enquiry form wakes the agent; replies reach its mailbox | Local tests | **A reply from a known lead opens one durable obligation.** Today it depends on the agent noticing |
| Obligation | Orders carry obligations (v100) | Local tests | Covered by the line above |
| Quote and payment | `enquiry.quote`, PayPal checkout | **Real money** at £1 and £5, not at this price | Scoped release; sales are closed today |
| Fulfilment | Browser, PDF tools, review record | Local tests | **Report template** with the limits above; 10-page scope |
| Delivery | `order.deliver` | **Real money** | None |
| Messaging | `order.thread`, `order.message`, close rule | Real proof order; rule local | None |
| Refund | `order.refund` through custody, coverage checks | **Real money** (£5) | None. Refund authority stays as is |
| Reconciliation | PayPal capture records; Treasury Watch v123 | Live on earlier versions; Watch on fake provider | **Install Treasury Watch** |
| Routing | Fleet Command | Migrated database, section 6 | **Route the 29 unrouted events** |

Build size: four changes, plus the release. This route does not need the v124 external-order tools, because orders are native. v124 stays for any channel an agent chooses later.

**Owner's ruling needed:** the buyer's brief and pay page would be served by the Fleet under the agent's brand. Customer, acquisition and fulfilment are all outside; only the payment step runs on our infrastructure. If that breaks the rule that the Fleet site is not a storefront, the alternative is PayPal invoicing through custody, which is new, unproven code.

**Human-only steps:** read and accept the liability wording and buyer terms; insurance decision; choose and buy a sending domain (DNS is the owner's) and confirm the mail provider allows this outreach, since shared Proton sending is unchecked; check whether an ICO registration fee applies; take over any CAPTCHA; approve each release, the budget and the first wave.

## 4. v124 checked against the intended workflow

| Question | Finding |
|---|---|
| Does a real channel event create the order automatically? | **Etsy only,** by polling a connected shop. On every other channel the agent must discover and enter it |
| Recording versus doing | **Fixed in this pass.** The tools only record. The agent's word is a `delivery_reported` or `refund_reported` report: the order stays owed and the sale record is unchanged |
| Evidence for completion | **Fixed:** gateway read, a finished browser action of the agent's on that platform since the order opened, or owner confirmation. A browser action shows a page was witnessed; nothing parses it to prove delivery, so the action ID is kept for review |
| Cancelling | **Fixed:** an order with a sale on record cannot be closed on the agent's word |
| Idempotency | Tested at database level: repeated reads create one order and one event. Concurrent inserts are refused by the unique key and replayed on the next poll, by reading, not by test |
| Restart | Cursor is saved after the records and re-reads a 2-day overlap. Replay tested at function level, not with a real worker restart |
| Buyer messages | **Not built for any outside platform.** Only the first brief is captured, labelled as untrusted data |
| Platform money versus cash | **Fixed:** sale figures are labelled `platform_record_not_cash` |

**Open defects, not fixed because Etsy is not chosen:** Etsy receipts read 100 with no paging, and the cursor still advances, so a busy window could lose orders. The Etsy client never sends delivery or refund state, and our earlier reading says screen-scraping is not allowed there, so an Etsy order could only complete by owner confirmation.

## 5. Finite proposal

| Step | Scope | Done when | Authority needed |
|---|---|---|---|
| 1 | Four builds in section 3, tests, review | Targeted tests pass, independent review done | Build only |
| 2 | Measure cost on 5 public sites with no contact | Real AI cost per prospect and report known | Separate budget |
| 3 | Release, install Watch, upgrade one agent | Group A style checks pass | Owner, release |
| 4 | Agent-1 contacts 100 UK companies | **Pass:** at least 5 interested replies and 1 paid order in 14 days. **Stop:** 3 complaints, any regulator or platform warning, or spend limit | Owner, budget and outreach |
| 5 | Fulfil, deliver, reconcile unaided | Payment visible in the Watch, report delivered, no owner briefing | Inside step 4 |
| 6 | Decide: continue, try C, or stop | Written result | Owner |

Budget (*estimate, to be replaced by step 2*): 100 prospects at $0.20-$0.50 is $20-$50, and one order is $3-$12. That is a new budget and cannot come from the remaining test allowance. Per sale at 1% conversion: £16-£40 of AI, so margin stays positive if estimates hold. FX assumed at $1 = £0.80, unverified.

## 6. Contradictions resolved

**Event routing (read from a fully migrated local database).** Of 452 emitted types, the 85 the static test flagged split in two: 56 are routed and the test is stale; **29 really do fall to AUDIT_ONLY**, the default, and so never reach Fleet Command's priority feed. They include `paypal_refund_unresolved`, `operation_uncertain`, `card_dispute_opened`, `channel_payout_rejected`, `message_check_stalled`. Some have a separate notification (`OPERATION_UNCERTAIN`, `CARD_DISPUTES_OPEN`); I did not check all 29. All v124 events route correctly. The static test remains failing on purpose until this is fixed.

**Custody privileges.** The test expected 27 functions; the database has 35. The extra 8 all came with v98 (PayPal order recovery) and are already in production. Each requires the custody role, none posts to the ledger, and each writes only its declared tables. They return a vault pointer rather than a PayPal secret. One note: two pass the buyer's order access token to custody, as the PayPal return token: a buyer-page token, narrow, and noted for review. Only after this review was the test's list updated.

**AI credit** (computed by code; last read earlier today, not re-read):

| Figure | Amount |
|---|---|
| Authorised total, never reset | $3.00 |
| **Consumed** | $1.511769 |
| **Remaining authorised** | **$1.488231** |
| Free now | $0.552369 |
| One Opus call, temporary reservation (returned, less cost) | about $0.74 |

The earlier "$2.25" was not expected spend: it was $1.50 of intended spend plus the reservation, and spending all of it would have used $3.011769, over the ceiling. Inside the ceiling, the correct move is to raise free credit to exactly $1.488231 (shrinking holds by $0.935862). Calls then stop once free is below $0.74, so at least $0.748231 is usable before a refusal and the $3.00 cannot be exceeded. No paid research is needed for this recommendation, and none is proposed.

## Sources

- Enforcement and scope: [Statutus](https://statutus.ch/en/guides/european-accessibility-act-enforcement-so-far/), [Atyantik](https://atyantik.com/blog/european-accessibility-act-enforcement/), [Level Access](https://www.levelaccess.com/compliance-overview/european-accessibility-act-eaa/), [Bird & Bird](https://cm.twobirds.com/en/insights/2026/france/accessibilit-numrique--ce-qui-change-pour-les-sites-e-commerce-depuis-juin-2025). Vendor sources; check primary records before relying on them
- Prices: [Kolonell](https://kolonell.com/en/blog/european-accessibility-act-website-compliance-cost-berlin-2026) (vendor)
- Limits: [Deque](https://www.deque.com/blog/automated-testing-study-identifies-57-percent-of-digital-accessibility-issues), [FTC order summary](https://www.mondaq.com/unitedstates/advertising-marketing-branding/1568116/ftc-finds-website-overlay-tool-failed-to-deliver-accessibility-promises)
- MTD: [Which?](https://www.which.co.uk/news/article/making-tax-digital-4-questions-answered-aUYig4e2qboX), [IPSE](https://ipse.co.uk/articles/sole-traders-tax-change-april-2026), [Anna](https://anna.money/blog/guides/mtd-bridging-software/) (vendor), [GOV.UK AML registration](https://www.gov.uk/money-laundering-regulations-accountancy-service-provider-registration)
- Catalogue: [Freelancer](https://www.freelancer.de/projects/data-entry/shopify-store-pricing-listing-overhaul), [FeedCue](https://apps.shopify.com/feedcue)
- Email: [ICO, business-to-business marketing](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/business-to-business-marketing/). The Data (Use and Access) Act 2025 may have changed details; unchecked
