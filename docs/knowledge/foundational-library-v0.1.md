# Draft foundational library for the fleet's founder agents (v0.1, 2026-10-08)

**How this was checked.** I read official pages directly where they would load: Stripe UK pricing, the PayPal UK merchant fees page (last updated 1 Oct 2026), Payhip pricing, Lemon Squeezy pricing, the Gumroad pricing and prohibited-products pages, the gov.uk VAT page for digital services, and the ICO's PECR email page. Etsy's fee page and Ko-fi's pricing page blocked the fetch (HTTP 403). Gumroad's help-centre articles loaded empty (the pages are rendered by JavaScript). For those three I used search-result snippets from the official domains and lower-confidence secondary sources, and each affected fact is marked below.

**Confidence labels used in "Facts that change":**
- **VERIFIED**: read on the official page today.
- **SNIPPET**: taken from a search-result snippet on the official domain.
- **SECONDARY**: taken from a third-party write-up.
- **UNVERIFIED**: not confirmed; verify before relying.

Every changeable fact has lastChecked: 2026-10-08.

## Four findings that matter most for the fleet

1. **Gumroad's prohibited list covers more than expected.** Its /prohibited page includes "Services", "Consulting firms", "AI services" and "Reselling private label rights products". So documentation services, done-for-you work and AI-powered tools cannot be sold on Gumroad. Agents should sell those through Stripe Payment Links, PayPal invoicing, Lemon Squeezy or Payhip.
2. **Lemon Squeezy's role is changing.** Stripe bought it in 2024. Since January 2026, Stripe's own merchant-of-record product, "Stripe Managed Payments", is being moved into the Stripe API. It costs the same 5% + 50¢ (secondary source). A new seller should decide carefully whether to set up on Lemon Squeezy now.
3. **UK sellers have no EU VAT threshold.** A UK seller selling automatically delivered digital products to EU consumers owes EU VAT from the first sale, unless a merchant of record or marketplace takes on the VAT. That means Gumroad, Lemon Squeezy, Etsy, or Payhip (which says it collects and remits UK/EU VAT). With plain Stripe or PayPal links, the seller owns all of the VAT work. The library should push agents toward merchant-of-record channels for sales to EU consumers.
4. **Fake reviews have been a "banned practice" under the DMCC Act since April 2025.** Concealed incentivised reviews are included. The CMA can now fine directly. This is a hard rule for agents, not a matter of style.

---

## Category 1: Finding demand and validating ideas

### demand-search-signals
**Title:** Read demand from search and autocomplete before building

**Body:** Before making anything, collect evidence that people are already looking for it. Sources:
- Google autocomplete, "People also ask" and related searches
- Marketplace search suggestions on Etsy and Gumroad Discover
- Free keyword tools
- Questions that keep recurring in forums

Strong signals:
- Specific, problem-shaped queries with buying intent, such as "invoice template for UK sole trader", rather than broad topics like "templates".
- Several existing paid products, which shows people pay.
- Weak or out-of-date competitors.

Write down the query, where you saw it, and a rough volume or competition note in the experiment log. Drop ideas with no searches and no paid competitors. Treat "no competitors" as a warning sign, not an opportunity. Spend no more than about one working session on this per idea.

**Facts that change:** none. This is a general method.

**Sources:**
- https://developers.google.com/search/docs/fundamentals/seo-starter-guide (Google docs: generally CC BY 4.0 text. Paraphrase with attribution.)

### demand-marketplace-bestsellers
**Title:** Mine marketplace bestsellers and reviews for gaps

**Body:** Open the top 20 listings for your target query on Etsy, Gumroad Discover or Payhip. For each, record:
- price
- review count, and its age if visible
- format
- what buyers praise and what they complain about

Three- and four-star reviews tell you the most, because they show unmet needs such as "wish it had a UK version" or "hard to edit on mobile". Pick a niche where demand is proven (many reviews) and a specific weakness is repeated. Then position your product directly against that weakness.

Never copy listing text, images or files. Record only the facts and your own observations.

**Facts that change:** marketplace search and ranking behaviour changes often. UNVERIFIED as to current ranking factors.

**Sources:**
- https://help.etsy.com/hc/en-us/articles/360024112614 (platform help page: facts paraphrased, link only)

### validate-presell-smoke-test
**Title:** Pre-sell or smoke-test before full production

**Body:** Cheapest test first:
1. A landing page or listing that describes the product, with a real price and a "buy" or "join waitlist" button.
2. A preview (sample page or screenshot) that you actually made.

Pre-selling is lawful only if the listing honestly states the delivery date and you refund promptly if you don't deliver. Never take payment for something you cannot deliver.

Set success thresholds in advance, for example "3 pre-orders or 30 waitlist sign-ups from 300 targeted visitors within 14 days". If you miss the threshold, change one variable (headline, price or audience) once. Then stop.

Waitlist emails need consent for marketing (see email-list-pecr-gdpr).

**Facts that change:** some platforms restrict pre-orders or non-delivered products. Check the platform's terms (UNVERIFIED for each platform).

**Sources:**
- https://www.gov.uk/online-and-distance-selling-for-businesses (UK government: Open Government Licence v3.0. Paraphrase with attribution.)

### validate-define-experiment
**Title:** Run every idea as a bounded experiment

**Body:** Every idea gets an experiment record before you spend anything:
- hypothesis (who will buy what, at what price, and why)
- cost cap in money and hours
- time box (7–21 days)
- leading metric (visits, add-to-cart, email sign-ups)
- success threshold
- kill condition

Only one primary variable changes per iteration. At the deadline, record the outcome as continue, pivot or stop, and say why. Unbounded "keep tweaking" is the most common way to burn runway. Write down what you learned even when the experiment fails, because the next agent can reuse it.

**Facts that change:** none.

**Sources:** internal method; no external source needed.

---

## Category 2: Product formats, pricing and positioning

### format-templates-spreadsheets
**Title:** Templates and spreadsheets: sell an outcome, not a file

**Body:** The formats that sell best solve a recurring, painful admin job: budgets, invoices, trackers, planners, checklists and SOPs. Name the outcome in the title, for example "Track UK self-employed expenses in 10 minutes a week".

Deliver:
- the file in common formats (Google Sheets copy link, Excel, sometimes Numbers)
- a one-page quick-start
- an example filled with clearly fictional data

Test every formula and lock or protect the formula cells. Localise for the audience (UK tax-year dates, £, date format). Do not give tax, legal or financial advice inside the template (see legal-no-regulated-advice); give tools and point to official guidance.

**Facts that change:** none.

**Sources:**
- https://www.gov.uk/self-employed-records (UK government: OGL v3.0. Paraphrase with attribution. Useful for UK-accurate structure only.)

### format-notion-digital-planners-printables
**Title:** Notion templates, printables and planners

**Body:**
- **Notion templates:** deliver a duplicate link, include setup steps, and say which Notion plan is needed.
- **Printables:** provide A4 and US Letter PDFs and say exactly what is included (page count, sizes).
- **Digital planners:** state which apps are compatible.

Show real screenshots of the actual product; do not use mock-ups that misrepresent it. These markets are crowded, so win on a narrow audience ("planner for UK nursing students on placement") rather than on generic aesthetics. If AI tools were used to make images or text, disclose it where the platform requires (Etsy does) and check that the output does not copy a protected work.

**Facts that change:**
- Etsy AI-disclosure requirement. SNIPPET. Verify at https://www.etsy.com/legal/creativity/
- Notion template-sharing features. UNVERIFIED.

**Sources:**
- https://www.etsy.com/legal/creativity/ (platform policy: paraphrase, link only)
- https://www.etsy.com/seller-handbook/article/1275449912004 (platform page: paraphrase, link only)

### format-guides-ebooks
**Title:** Guides and e-books: specific, short, current

**Body:** Sell narrow "how to do X" guides (10–40 pages) that are faster than piecing together free information. Lead with a table of contents and a free sample chapter. Date-stamp the content and say which jurisdiction it applies to, for example "UK, checked October 2026". Avoid get-rich-quick or income-claim framing: card networks and Stripe restrict it, and it risks misleading-advertising rules.

Guides that are mainly AI-generated must still be accurate, original in structure and fact-checked. Low-value bulk e-books harm reputation and break marketplace rules. Health, legal and financial topics need extra care (see legal-no-regulated-advice).

**Facts that change:** Stripe's "get rich quick" prohibition. SNIPPET. Verify at https://stripe.com/legal/restricted-businesses

**Sources:**
- https://stripe.com/legal/restricted-businesses (platform policy: paraphrase, link only)

### format-micro-saas-tools
**Title:** Small tools and micro-SaaS: higher value, higher obligations

**Body:** Small web tools, calculators, scripts and add-ons can sell as one-off licences or subscriptions. Before you build:
- Confirm the channel allows software or "AI services". Gumroad prohibits "AI services" and "Services".
- Plan for support, uptime and data protection. Any personal data you store makes you a UK GDPR controller.
- Subscriptions bring extra duties: clear renewal terms and easy cancellation. The DMCC subscription regime is expected in spring 2027.

Start with a one-off-price version, or a free tool with a paid upgrade. Never collect more data than the tool needs.

**Facts that change:**
- Gumroad prohibited list: VERIFIED at https://gumroad.com/prohibited
- Subscription regime commencement, "spring 2027": SNIPPET from gov.uk. Verify at https://www.gov.uk/government/consultations/consultation-on-the-implementation-of-the-new-subscription-contracts-regime

**Sources:**
- https://gumroad.com/prohibited (platform page: paraphrase, link only)
- gov.uk subscription consultation response, URL as above (OGL v3.0)

### format-services-productised
**Title:** Productised services (documentation, setup, audits)

**Body:** Package a service as a fixed scope, a fixed price and a fixed turnaround, for example "Write your README and contributor guide: £79, 3 working days, 1 revision". Write down exactly what is included and excluded.

Under UK distance-selling rules, consumers have a 14-day cancellation right for services. If they expressly ask you to start sooner and then cancel, they pay a proportionate amount for work already done.

Gumroad prohibits services. Use Stripe Payment Links, PayPal invoices or another channel that permits them. Never offer regulated services such as legal advice, financial advice or reserved legal activities.

**Facts that change:**
- Gumroad "Services" prohibition. VERIFIED 2026-10-08.
- Services cancellation rules. Verify at https://www.legislation.gov.uk/uksi/2013/3134

**Sources:**
- https://www.legislation.gov.uk/uksi/2013/3134 (legislation.gov.uk: OGL v3.0, Crown copyright. Paraphrase with attribution.)
- https://gumroad.com/prohibited (platform page: link only)

### pricing-anchors-and-tiers
**Title:** Price on value; use tiers and anchors honestly

**Body:**
- Set the price from the buyer's value (time or money saved) and from competitor prices, not from your cost.
- Typical ranges: small digital templates £3–£15, deeper toolkits £15–£49, productised services £50+.
- Offer up to three tiers (basic, standard, plus bundle). The middle tier is usually the target.
- Fixed per-sale fees (£0.20–£0.50) swamp very low prices. Check the net after fees (see econ-fee-impact) before you choose a price under £5.
- Run sales and "was" prices only against a price you genuinely charged before. Fake reference prices and false urgency ("only 2 left" for a digital file) are misleading.

**Facts that change:** none. Platform fees: see the channel entries.

**Sources:**
- https://www.asa.org.uk/advice-online/misleading-advertising.html (ASA/CAP: copyright ASA. Paraphrase, link only.)
- CMA207 Unfair commercial practices guidance: https://assets.publishing.service.gov.uk/media/686666f2e4184a43f9785c0e/CMA207_Unfair_commercial_practices_guidance.pdf (OGL v3.0)

### pricing-bundles-upsells
**Title:** Bundles, upsells and order bumps

**Body:** Bundles of related items ("complete freelancer admin kit") raise the average order value and do well on marketplaces. State exactly what is in a bundle and say if it overlaps products the buyer may already own. After a purchase, offer one relevant upgrade or complementary item, not a chain of offers. Never pre-tick paid add-ons: UK law requires the consumer's express consent to extra payments. Track the attach rate; if under about 5% of buyers take the upsell after 50 orders, change or drop it.

**Facts that change:** the ban on pre-ticked boxes (Consumer Contracts Regulations reg. 40). Verify at https://www.legislation.gov.uk/uksi/2013/3134/regulation/40

**Sources:** legislation.gov.uk (OGL v3.0)

### positioning-niche
**Title:** Positioning: narrow audience, concrete promise

**Body:** Use this format: "For [specific audience] who [specific situation], this [format] helps [outcome] in [time/effort]." A narrow audience lowers competition, sharpens the copy and makes it obvious where to find customers. Every claim must be true and checkable; promised outcomes must be achievable for a typical buyer. Avoid "guaranteed income" or medical, financial or legal promises. Re-test positioning before changing the product: often the product is fine and the message is wrong.

**Facts that change:** none.

**Sources:**
- https://www.asa.org.uk/advice-online/substantiation.html (ASA/CAP: paraphrase, link only)

### policy-refunds
**Title:** Write a clear, lawful refund policy

**Body:** Publish the refund policy before purchase.

For downloadable digital content, UK consumers lose the 14-day cancellation right once download starts, but only if both of these happened before supply:
- they gave express consent to immediate supply
- they acknowledged that they lose the right to cancel

You still owe Consumer Rights Act remedies: digital content must be of satisfactory quality, fit for purpose and as described. Faulty content means repair or replacement, then a price reduction or refund.

A voluntary "no-questions 14-day refund" builds trust and reduces chargebacks. Decide per product whether you can afford it. Never say "no refunds under any circumstances", because statutory rights cannot be excluded.

**Facts that change:**
- CCR regs 36–37 and the CRA 2015 digital content rules. Verify at https://www.legislation.gov.uk/uksi/2013/3134 and https://www.legislation.gov.uk/ukpga/2015/15/part/1/chapter/3

**Sources:** legislation.gov.uk (OGL v3.0); https://www.gov.uk/online-and-distance-selling-for-businesses (OGL v3.0)

---

## Category 3: Sales channels and platform facts

These are CHANGEABLE PLATFORM FACTS. Before relying on any of them, re-check the "verify at" page, then record the date and amount used in the experiment log.

### channel-gumroad
**Title:** Gumroad: merchant of record, simple, but restrictive on categories

**Body:** Good for downloadable products (templates, guides, printables, courses) sold through your own links.
- Gumroad has been merchant of record since 1 January 2025. It handles sales tax and VAT worldwide, which removes the UK and EU VAT burden.
- Fees are high, and sales from its Discover marketplace cost much more.
- It prohibits "Services", "Consulting firms", "AI services", reselling private-label-rights products, "Deceptive marketing practices" and more. Read the prohibited list before you list.
- Payouts are weekly, with holding periods and minimums. Budget for a cash-flow delay of a week or more.

**Facts that change** (lastChecked 2026-10-08):
- Direct sales fee 10% + $0.50; Discover sales 30%. VERIFIED on gumroad.com/pricing, which says processing is included.
- A help snippet mentions 5% + $0.50 once monthly sales pass $20k, and an older snippet says card processing is extra. Conflicting: UNVERIFIED.
- Merchant of record from 2025-01-01. VERIFIED.
- Payout: weekly (Fridays), at least a 7-day hold. SNIPPET. Minimum $10 vs $100 conflicts between snippets: UNVERIFIED.
- Prohibited list. VERIFIED.
- KYC: identity and payout verification is required. Details UNVERIFIED.
- Verify at https://gumroad.com/pricing, https://gumroad.com/help/article/66-gumroads-fees, https://gumroad.com/help/article/13-getting-paid and https://gumroad.com/prohibited

**Sources:** the Gumroad pages above (platform pages: facts paraphrased, no copying, link only)

### channel-etsy-digital
**Title:** Etsy digital downloads: built-in traffic, strict originality rules

**Body:** Etsy brings buyers searching for printables, planners and templates.
- Digital items must be designed by the seller ("Designed by a seller").
- AI-assisted items made from your own prompts are allowed but must be disclosed in the listing. Selling AI prompt bundles is prohibited.
- Etsy collects and remits VAT on automatically downloaded digital items for UK buyers (and others), so the UK below-threshold exemption does not help you there.
- Fees stack up: listing, transaction, processing, a regulatory fee and possibly Offsite Ads. Model the net before pricing.
- New UK sellers must verify their bank account. Funds are typically held for about 14 days at first, then deposited on a schedule (weekly on Monday by default).

**Facts that change** (lastChecked 2026-10-08). The fee page returned HTTP 403, so all fees are SECONDARY unless marked:
- Listing fee $0.20 per listing.
- Transaction fee 6.5% of the order total.
- UK Etsy Payments processing 4% + £0.20.
- Regulatory operating fee for UK sellers: sources give 0.48% or 0.32%. UNVERIFIED.
- Offsite Ads 12% or 15% of the attributed order, capped at $100.
- Currency conversion 2.5%.
- VAT charged on Etsy's own fees.
- Payout (14-day new-seller hold, weekly default) and bank verification. SNIPPET from help.etsy.com.
- Digital VAT collection. SNIPPET.
- AI disclosure. SNIPPET.
- Verify at https://www.etsy.com/legal/fees/, https://help.etsy.com/hc/en-gb/articles/115015587567, https://www.etsy.com/legal/creativity/ and https://help.etsy.com/hc/en-us/articles/360046998234

**Sources:** the Etsy pages above (platform: paraphrase, link only)

### channel-payhip
**Title:** Payhip: low fees, collects UK and EU VAT, paid straight to PayPal or Stripe

**Body:** A storefront for digital downloads, courses and memberships.
- The free plan charges a percentage per sale; paid plans lower or remove it.
- PayPal or Stripe processing fees apply on top.
- Payhip says it collects and remits EU and UK VAT automatically. Confirm how it handles that legally before you depend on it.
- Money goes directly to your connected PayPal or Stripe account. Stripe pays out daily by default, after an initial pending period for new accounts.
- Allowed content follows Payhip's terms plus PayPal's and Stripe's restricted lists.

**Facts that change** (lastChecked 2026-10-08):
- Plans: Free $0/month with a 5% fee; Plus $29/month with 2%; Pro $99/month with 0%. VERIFIED on payhip.com/pricing.
- Processor fees extra. VERIFIED.
- UK and EU VAT collected and remitted. VERIFIED that Payhip claims this; whether it is legally the merchant of record is UNVERIFIED.
- Payout timing. SNIPPET from help.payhip.com.
- Verify at https://payhip.com/pricing and https://help.payhip.com/article/65-connecting-your-stripe-account

**Sources:** Payhip pages (platform: paraphrase, link only)

### channel-lemon-squeezy
**Title:** Lemon Squeezy: merchant of record for software and digital products, now part of Stripe

**Body:** Lemon Squeezy is merchant of record and handles global sales tax and VAT. It suits software licences, SaaS subscriptions and digital products.
- Fee is a percentage plus a fixed amount, with possible extra fees on international sales.
- Payouts go out twice monthly, after a 13-day hold and above a minimum.
- Stores need approval or activation, so expect review of your product and identity.
- Stripe has owned it since 2024. Since 2026 Stripe has offered "Stripe Managed Payments", a merchant-of-record option at the same headline price that works with Stripe Checkout and Payment Links. Compare both before committing; migration risk is real.

**Facts that change** (lastChecked 2026-10-08):
- Fee 5% + 50¢; "small additional fees" on international sales; no monthly fee; merchant of record. VERIFIED on lemonsqueezy.com/pricing.
- Payouts on the 14th and 28th after a 13-day hold; $50 minimum. SNIPPET from docs.lemonsqueezy.com.
- Stripe Managed Payments details (5% + $0.50, Checkout and Payment Links only). SECONDARY.
- KYC and store activation requirements. UNVERIFIED.
- Verify at https://www.lemonsqueezy.com/pricing, https://docs.lemonsqueezy.com/help/getting-started/getting-paid and https://docs.stripe.com (search "Managed Payments")

**Sources:** Lemon Squeezy and Stripe pages (platform: paraphrase, link only)

### channel-ko-fi
**Title:** Ko-fi: creator shop and tips; payments go directly to you

**Body:** Ko-fi suits creator-style audiences (tips, small shop items, memberships, commissions).
- It never holds funds: payments go directly to your PayPal or Stripe account, and their fees apply.
- The free plan charges a service fee on shop, membership and commission sales.
- Ko-fi Gold (a monthly subscription) removes platform fees. It is worth it only when monthly sales are high enough; work out the break-even point.
- Ko-fi is not a merchant of record, so VAT and consumer-law duties stay with the seller.

**Facts that change** (lastChecked 2026-10-08). Pricing page returned HTTP 403:
- 5% fee on shop, membership and commission sales on the free plan. SNIPPET and SECONDARY.
- Tips: 0% on the free plan per some sources. Conflicting: UNVERIFIED.
- Gold price: $12/month in recent sources ($6–8 historically). UNVERIFIED.
- Verify at https://help.ko-fi.com/hc/en-us/articles/360002506494-Does-Ko-fi-take-a-fee and https://ko-fi.com/gold

**Sources:** Ko-fi help (platform: paraphrase, link only)

### channel-paypal-links-invoicing
**Title:** PayPal payment links and invoices (UK business account)

**Body:** Useful for productised services and direct sales to buyers who prefer PayPal.
- Commercial transactions on a UK business account cost a percentage plus a fixed fee per currency. Cross-border payments add a surcharge.
- Invoices are charged at commercial rates.
- PayPal is not a merchant of record: VAT, consumer law and your own terms are the seller's job.
- Get a business account in the operator-approved legal identity. Expect KYC and possible holds or reserves on new or high-risk accounts.
- PayPal's Acceptable Use Policy applies.

**Facts that change** (lastChecked 2026-10-08):
- 2.9% + £0.30 domestic.
- +1.29% for EEA payments, +1.99% for other markets.
- Tiered rates as low as 2.1% above £8,000 a month, on request.
- All the above VERIFIED on paypal.com/uk (page "last updated 1 October 2026").
- Holds and reserves: UNVERIFIED.
- Verify at https://www.paypal.com/uk/webapps/mpp/merchant-fees and https://www.paypal.com/uk/legalhub/acceptableuse-full

**Sources:** PayPal UK pages (platform: paraphrase, link only)

### channel-stripe-payment-links
**Title:** Stripe Payment Links: cheapest processing, seller does all compliance

**Body:** No-code checkout links for one-off or recurring payments. Processing costs are lowest for UK cards.
- Stripe is not merchant of record unless you use Managed Payments. With plain links, UK VAT, EU VAT (no threshold for UK sellers), consumer terms and refunds are all on you.
- Activation requires business and identity KYC.
- The first payout usually comes about 7 days after the first payment, longer in some industries. Later UK payouts follow your schedule.
- Read the Prohibited and Restricted Businesses list. "Get rich quick" offers and misleading claims are prohibited.

**Facts that change** (lastChecked 2026-10-08):
- UK standard cards 1.5% + 20p; premium UK cards 2.8% + 20p.
- EEA cards 2.5% + 20p; non-EEA cards 3.15% + 20p as read today. Earlier public figures said 3.25%, so re-verify.
- +2% currency conversion.
- No extra fee for Payment Links; custom domain £10/month.
- All the above VERIFIED on stripe.com/gb/pricing.
- First payout about 7 days. SNIPPET.
- Verify at https://stripe.com/gb/pricing, https://support.stripe.com/questions/waiting-period-for-first-payout-on-stripe and https://stripe.com/legal/restricted-businesses

**Sources:** Stripe pages (platform: paraphrase, link only)

### channel-choose
**Title:** Choosing a channel: a decision checklist

**Body:** Choose by product type and who carries compliance.

| Product | Channel |
|---|---|
| Downloadable product, buyers worldwide | A merchant of record (Gumroad, Lemon Squeezy or Stripe Managed Payments) or Etsy, which handle VAT |
| Discovery needed | Etsy (search traffic), or Gumroad Discover at a 30% fee |
| Services | Stripe or PayPal links (Gumroad prohibits services) |
| Creator audience | Ko-fi or Payhip |

Check four things in this order:
1. Is the item permitted?
2. Who handles VAT and consumer obligations?
3. What is the net margin after fees at your price?
4. How long until cash arrives (payout hold and schedule)?

Do not open more than one account on the same platform, and never open a new one to get around a suspension or ban (platforms treat it as ban evasion). Open accounts only where you will actually sell; every account you open is logged in your footprint and the owner can freeze it.

**Facts that change:** see the individual channel entries.

**Sources:** as per the channel entries.

---

## Category 4: Customer acquisition without paid ads

### acq-seo-basics
**Title:** SEO basics for product and content pages

**Body:**
- One page per clear search intent. Use the buyer's words in the title, the H1 and the first paragraph.
- Write descriptive, honest product copy and add an FAQ that answers real questions.
- Use fast pages, descriptive image alt text and internal links.
- Earn links with genuinely useful free resources.

Do not mass-produce thin or AI-spun pages. Google's spam policies name "scaled content abuse" (many low-value pages, AI-generated or not, made to manipulate rankings) and can de-rank or remove a site. Quality and originality beat volume. Measure impressions and clicks in Search Console.

**Facts that change:** Google spam policies, updated periodically (e.g. the site reputation policy in August 2026). Verify at https://developers.google.com/search/docs/essentials/spam-policies

**Sources:**
- Google Search Central (content generally CC BY 4.0, code Apache 2.0. Paraphrase with attribution.)
- https://developers.google.com/search/docs/fundamentals/using-gen-ai-content

### acq-content-marketing
**Title:** Content marketing: give away the "what", sell the "done-for-you"

**Body:** Publish free, genuinely useful material (short guides, checklists, worked examples) on the problem your product solves, then link to the product as the faster option. Each piece targets one question your audience asks. Repurpose one core piece into several formats (article, thread, short video script) by hand-adapting it, not by posting duplicates. Track which pieces lead to email sign-ups or sales; stop producing types that convert nothing after about 10 attempts. Label sponsored or affiliate content clearly.

**Facts that change:** none.

**Sources:**
- https://www.asa.org.uk/advice-online/recognising-ads-brand-owned-and-paid-social-media.html (ASA/CAP: paraphrase, link only)

### acq-communities-reddit
**Title:** Communities and Reddit: participate first, promote rarely

**Body:** Reddit's own guidance is roughly "fine to be a Redditor with a website, not a website with a Reddit account". Its long-standing heuristic is that most of your activity (often given as 9:1) should not be self-promotion.
- Each subreddit has its own rules and many ban self-promotion completely. Read the sidebar and rules before posting.
- Disclose that you made the product. Never use multiple accounts, vote manipulation or undisclosed shilling.
- Agents posting on community platforms must follow the platform's rules on automated or bot accounts and must not pretend to be a human customer.
- Prefer answering questions helpfully; link only when it directly answers the question and the rules allow it.

**Facts that change:** Reddit's spam and self-promotion guidance and API/bot rules. UNVERIFIED: reddit.com could not be fetched; the content came via secondary sources. Verify at https://support.reddithelp.com (search "spam" and "self-promotion") and https://redditinc.com/policies

**Sources:** Reddit help and policies (platform: paraphrase, link only)

### acq-email-pecr-gdpr
**Title:** Email lists in the UK: consent (PECR) and UK GDPR

**Body:**
- You may not send marketing email to individuals without their specific consent. The exception is the "soft opt-in": an existing customer who bought, or negotiated to buy, from you and was offered a clear opt-out when you collected their details. Marketing to them must be about your similar products, with an opt-out in every message.
- Never buy, rent or scrape lists.
- Identify yourself, give a valid contact or unsubscribe address, and act on opt-outs promptly.
- Keep consent records (when, where, what wording).
- Use double opt-in and a privacy notice.

The ICO notes this guidance is under review because of the Data (Use and Access) Act 2025.

**Facts that change:**
- The rules in the guidance: VERIFIED on the ICO page, which notes it is "under review".
- DUAA 2025 changes, including higher PECR fines: UNVERIFIED.
- Verify at https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/electronic-and-telephone-marketing/electronic-mail-marketing/

**Sources:** ICO (most ICO content is OGL v3.0. Paraphrase with attribution.)

### acq-social-automation-rules
**Title:** Social platforms: automation and spam rules

**Body:**
- Automated posting is allowed on some platforms only within their rules.
- X's automation rules forbid spam; automated posting about trending topics to manipulate them; duplicate or near-duplicate posts across one or several accounts; and automated unsolicited mentions, replies or DMs.
- Authenticity rules ban fake or mass-registered accounts and artificial amplification.
- If an account is automated, use the platform's bot or automated-account label where one exists.

One account per agent identity, approved by the operator. Write posts for humans. Never automate engagement (likes, follows, replies) to inflate reach.

**Facts that change:** X automation and authenticity policies. SNIPPET. Verify at https://help.x.com/en/rules-and-policies/x-automation and https://help.x.com/en/rules-and-policies/authenticity. Check each other platform's equivalent (Meta, LinkedIn, TikTok, Pinterest): UNVERIFIED.

**Sources:** X Help Center (platform: paraphrase, link only)

### acq-marketplace-listing-optimisation
**Title:** Marketplace listing quality

**Body:**
- Title: buyer's search phrase plus format plus audience.
- First image: shows the actual product clearly.
- Description: the problem it solves, exactly what is included, compatibility, how delivery works, the refund terms, and an AI-use disclosure where required.
- Use all available tags with real search phrases.

Price within the observed range unless you have a clear differentiator. Answer questions fast and respond professionally to reviews. Never ask for "5-star only" reviews or offer incentives for positive ones.

**Facts that change:** Etsy listing and AI-disclosure rules. SNIPPET. Verify at https://www.etsy.com/legal/creativity/

**Sources:** Etsy policy (link only); CMA208 (OGL v3.0)

---

## Category 5: Delivery and customer service

### delivery-digital-goods
**Title:** Reliable delivery of digital goods

**Body:** Use automatic delivery through the platform: an instant download or an emailed link. It is reliable and counts as an "electronically supplied service" for VAT (manually emailed PDFs are treated differently).
- Test the full purchase-to-download flow on a fresh account before launch and after every file change.
- Version your files and keep a changelog.
- Confirm in the checkout flow that the buyer gave the immediate-supply consent and acknowledgement (see legal-digital-content-cancellation).
- Make sure links don't expire too fast, and offer re-sends.
- Keep the files in your own store too, not only on the platform.

**Facts that change:** none of note.

**Sources:**
- https://www.gov.uk/guidance/the-vat-rules-if-you-supply-digital-services-to-private-consumers (OGL v3.0)

### support-customer-service
**Title:** Customer support: fast, human-quality, honest

**Body:**
- Publish a support contact and a response-time target (e.g. one working day).
- Use templates for common issues (can't download, wrong format, how to edit) but personalise every reply.
- Resolve quickly: re-send, fix, give a partial refund or a full refund.
- Log every ticket and look for patterns; fix the product or description that causes repeat questions.
- UK law requires your identity and geographic address in pre-contract information.
- If a customer sincerely asks whether they're talking to an AI, say truthfully that you are (see ethics-ai-disclosure).
- Escalate threats, legal claims and data-subject requests to the operator.

**Facts that change:** none.

**Sources:**
- https://www.legislation.gov.uk/uksi/2013/3134/schedule/2 (OGL v3.0)

### support-chargebacks
**Title:** Avoiding and handling chargebacks

**Body:** Chargebacks cost a fee plus the sale amount, and they hurt account standing. Prevent them:
- Use a recognisable billing descriptor.
- Describe the product accurately.
- Deliver instantly.
- Keep the consent-to-immediate-supply evidence.
- Refund promptly when someone asks; a refund is cheaper than a dispute.

If a dispute arrives, respond within the processor's deadline with evidence: product description, delivery and download logs, consent record and communications. A high dispute rate can freeze accounts. Merchant-of-record platforms handle disputes but may pass on fees.

**Facts that change:** chargeback fees and deadlines per processor. UNVERIFIED. Verify at https://stripe.com/gb/pricing and https://www.paypal.com/uk/webapps/mpp/merchant-fees

**Sources:** Stripe and PayPal pages (link only)

---

## Category 6: UK legal and compliance basics

(This section is general orientation, not legal advice. Escalate edge cases to the operator.)

### legal-digital-content-cancellation
**Title:** 14-day cancellation and the digital-content waiver (CCR 2013)

**Body:** Distance contracts generally carry a 14-day cancellation right. For digital content not on a tangible medium, the right ends once supply begins, but only if, before supply:
1. the consumer gave express consent to supply starting within the cancellation period, and
2. acknowledged they will lose the right to cancel, and
3. you confirm this on a durable medium (e.g. the confirmation email).

Implement this as an unticked checkbox at checkout plus wording in the receipt. Without it, the buyer can cancel within 14 days even after downloading. Services follow different rules (see format-services-productised).

**Facts that change:** CCR regs 36–37. Verify at https://www.legislation.gov.uk/uksi/2013/3134 and https://www.gov.uk/online-and-distance-selling-for-businesses

**Sources:** legislation.gov.uk and gov.uk (OGL v3.0. Paraphrase with attribution.)

### legal-consumer-rights-digital
**Title:** Consumer Rights Act 2015: quality of digital content

**Body:** Digital content sold to UK consumers must be of satisfactory quality, fit for any purpose made known, and as described. What you say in listings becomes part of the contract. If the content is faulty, the consumer is entitled to repair or replacement, then a price reduction or refund, and to compensation if your content damages their device or other content through lack of reasonable care. These rights cannot be excluded by your terms. Describe compatibility and limitations honestly to avoid disputes.

**Facts that change:** CRA 2015 Part 1, Chapter 3. Verify at https://www.legislation.gov.uk/ukpga/2015/15/part/1/chapter/3

**Sources:** legislation.gov.uk (OGL v3.0)

### legal-trader-information
**Title:** Mandatory seller information and terms

**Body:** Before purchase, give consumers:
- your identity (trading name)
- a geographic address and contact details
- the main characteristics of the product
- the total price including taxes
- payment and delivery arrangements
- cancellation rights or their loss
- digital-content functionality and compatibility

Online, the E-Commerce Regulations 2002 also require trader identity and contact details to be easily accessible. Publish terms, a refund policy and a privacy notice. Agents use the operator-approved legal identity and address, never invented ones.

**Facts that change:** verify at https://www.legislation.gov.uk/uksi/2013/3134/schedule/2 and https://www.legislation.gov.uk/uksi/2002/2013

**Sources:** legislation.gov.uk (OGL v3.0)

### legal-vat-digital
**Title:** VAT on digital products: UK and EU

**Body:**
- **UK:** you must register for VAT when taxable turnover goes over £90,000 in any 12 months, or is expected to within the next 30 days.
- **Electronically supplied services** (automatically delivered: e-books, software, templates by auto-download) to consumers are taxed where the consumer lives.
- **EU consumers:** a UK seller has no EU threshold. You must register for the non-Union OSS scheme in one EU member state, or register in each country where you sell.
- **Platforms:** when a platform controls the charge, delivery or terms, it is usually treated as the supplier for VAT. Merchant-of-record platforms (Gumroad, Lemon Squeezy, Stripe Managed Payments) and Etsy collect the VAT.

Recommendation: route sales to EU consumers through a merchant of record or marketplace. Get tax decisions approved by the operator.

**Facts that change:**
- £90,000 threshold (since 1 April 2024). VERIFIED (gov.uk snippet).
- Digital-services guidance (page last updated 28 March 2022). VERIFIED.
- EU non-Union OSS. Verify on the EU side as well.
- Verify at https://www.gov.uk/register-for-vat, https://www.gov.uk/guidance/the-vat-rules-if-you-supply-digital-services-to-private-consumers and https://vat-one-stop-shop.ec.europa.eu (EU content: © European Union, reuse allowed with attribution under Commission Decision 2011/833/EU)

**Sources:** gov.uk (OGL v3.0); EU OSS portal

### legal-income-tax-registration
**Title:** Income tax and HMRC registration basics

**Body:** Trading income generally needs reporting to HMRC.
- The £1,000 trading allowance covers small gross trading income.
- Above it, register for Self Assessment, or account through a company if the operator runs one.
- Keep records of every sale, fee, refund and expense from day one. Platform reports (Etsy and others report UK sellers' income to HMRC under the digital platform reporting rules) will be cross-checked.

The legal entity and tax status are operator decisions. Agents record the data and never make filings themselves.

**Facts that change:** trading allowance and platform reporting rules. UNVERIFIED in this session. Verify at https://www.gov.uk/guidance/tax-free-allowances-on-property-and-trading-income and https://www.gov.uk/guidance/reporting-rules-for-digital-platforms. Etsy's reporting page: https://help.etsy.com/hc/en-us/articles/17795509361431

**Sources:** gov.uk (OGL v3.0); Etsy (link only)

### legal-uk-gdpr-basics
**Title:** UK GDPR basics for customer data

**Body:** You are a data controller for customer names, emails and payment metadata you hold.
- Collect only what you need and have a lawful basis: contract for fulfilment; consent or soft opt-in for marketing.
- Publish a privacy notice: who you are, what you collect, why, how long you keep it, and people's rights.
- Keep data secure; use processors under proper terms (platforms, email tools).
- Answer access or deletion requests within one month (escalate them to the operator).
- Report serious breaches to the ICO within 72 hours.
- Most organisations that process personal data must pay the ICO data protection fee (tier 1, micro organisations, is £52) unless exempt. Use the ICO self-assessment.

**Facts that change:** fee tiers (£52, £78, £3,763 from 2025). SNIPPET from ico.org.uk and gov.uk. Verify at https://ico.org.uk/for-organisations/data-protection-fee/ and https://ico.org.uk/for-organisations/advice-for-small-organisations/

**Sources:** ICO (OGL v3.0); legislation.gov.uk SI 2025/63 (OGL)

### legal-advertising-cap-code
**Title:** Advertising standards: the CAP Code basics

**Body:** The CAP Code covers non-broadcast marketing, including your own website and social posts.
- Marketing must not mislead, including by leaving things out or by exaggerating.
- Before publishing an objective claim ("saves 5 hours a week", "best-selling"), you must hold evidence for it.
- Ads must be obviously identifiable as ads; label affiliate, sponsored and incentivised content.
- Price claims (sales, "was" prices, "free") must be genuine.
- Testimonials must be real and you need permission to use them.

The ASA can rule against you publicly, and platforms may act on rulings.

**Facts that change:** CAP Code updates. Verify at https://www.asa.org.uk/codes-and-rulings/advertising-codes/non-broadcast-code.html

**Sources:** ASA/CAP (copyright ASA/CAP: paraphrase only, link only, no reproduction of code text)

### legal-no-regulated-advice
**Title:** Don't give regulated advice

**Body:** Do not sell personalised legal, financial or investment, tax, medical or mental-health advice.
- Investment and financial content may also be a financial promotion under FSMA s.21 and needs FCA authorisation or approval.
- Some legal activities are reserved under the Legal Services Act 2007.
- Medical claims carry ASA, CAP and MHRA risk.

Safe pattern: general educational information plus tools (trackers, templates, checklists), clearly labelled "general information, not advice". Link to official sources (gov.uk, NHS, MoneyHelper) and point buyers to a qualified professional. Never promise financial outcomes.

**Facts that change:** FCA financial promotion rules. UNVERIFIED this session. Verify at https://www.fca.org.uk/firms/financial-promotions-adverts and https://www.legislation.gov.uk/ukpga/2007/29/part/3

**Sources:** FCA (FCA website terms: paraphrase, link only); legislation.gov.uk (OGL)

### legal-ip-copyright-trademark
**Title:** Copyright, trademarks and AI-generated content

**Body:**
- Sell only material you created or have a licence to sell commercially. Check licence terms for fonts, images, icons and templates.
- Don't use brand names or logos in ways that suggest endorsement (e.g. "Official Notion template", Disney characters). Describing compatibility, such as "for Notion", is usually acceptable when done factually.
- Gumroad prohibits reselling private-label-rights products and copyrighted media. Etsy requires digital items to be designed by the seller.
- AI output can reproduce protected material, so review it for similarity.
- Under UK law, the protection for wholly computer-generated works (CDPA s.9(3)) is proposed for removal. Assume pure AI output may have weak or no copyright protection, and add real human creative contribution.
- Respond to takedown notices promptly; escalate to the operator.

**Facts that change:** UK AI copyright policy (government report 2026; s.9(3) removal proposed). SNIPPET. Verify at https://www.gov.uk/government/publications/report-and-impact-assessment-on-copyright-and-artificial-intelligence and https://www.gov.uk/government/consultations/copyright-and-artificial-intelligence

**Sources:** gov.uk (OGL v3.0); Gumroad and Etsy policies (link only)

### legal-reviews-dmcc
**Title:** Reviews law (DMCC Act 2024)

**Body:** Since April 2025 these are banned practices, automatically unfair:
- writing, commissioning or offering fake reviews
- publishing incentivised reviews without clearly saying so
- presenting reviews misleadingly, e.g. hiding negative ones or showing distorted star averages

If you publish reviews, you must take reasonable steps to prevent fake and concealed-incentive reviews. The CMA can now fine directly, up to 10% of global turnover. Asking real customers for honest reviews is fine; tying a reward to a positive review is not.

**Facts that change:** CMA208 guidance (4 April 2025). SNIPPET from gov.uk. Verify at https://assets.publishing.service.gov.uk/media/67eeb64fe9c76fa33048c790/CMA208_-_Fake_reviews_guidance.pdf

**Sources:** CMA and gov.uk (OGL v3.0)

### legal-subscriptions
**Title:** Subscriptions and auto-renewals

**Body:** If you sell subscriptions:
- State the price, billing frequency, renewal terms and how to cancel before purchase.
- Make cancellation as easy as signing up.
- Send renewal reminders.

The DMCC Act's subscription regime (pre-contract information, reminder notices, cooling-off notices, easy exit) is expected to start in spring 2027. Build to it now, because it is already good practice and it avoids "subscription trap" findings under unfair-practices rules.

**Facts that change:** start date "spring 2027". SNIPPET from gov.uk (government response of 2 April 2026). Verify at https://www.gov.uk/government/consultations/consultation-on-the-implementation-of-the-new-subscription-contracts-regime

**Sources:** gov.uk (OGL v3.0)

---

## Category 7: Unit economics and survival

### econ-fee-impact
**Title:** Calculate net per sale before choosing price and channel

**Body:** Net = price − VAT (if the platform deducts it) − platform % − fixed fee − processing − currency conversion − expected refunds. The fixed fee dominates at low prices.

Worked examples on a £5 sale:
- Gumroad direct (10% + $0.50, about £0.37): about £4.13 net, or 17% in fees.
- Stripe link, UK card: £5 − (1.5% + 20p) = £4.73, but you handle VAT yourself.
- Etsy (listing $0.20 + 6.5% + 4% + £0.20 + regulatory fee): about £4.13 or less, before Offsite Ads and VAT.

If fees are over 20% of price, raise the price, bundle items, or change channel.

**Facts that change:** all fee rates. See the channel entries; re-verify before calculating. FX rates vary.

**Sources:** see the channel entries.

### econ-experiment-budget-runway
**Title:** Runway and cost per experiment

**Body:**
- Runway = available protected cash ÷ monthly burn (compute, subscriptions, platform plans, domain).
- Fix a cost cap per experiment (money and agent-hours). Never run more experiments in parallel than runway allows if all of them fail.
- Prefer zero-fixed-cost channels until there are sales, i.e. pay-per-sale over monthly plans. Upgrade to a paid plan only when its break-even is met consistently. Examples: Payhip Plus at $29/month beats the free plan above about $1,000/month in sales; Ko-fi Gold beats the free plan when monthly sales exceed 20× its monthly fee.
- Capital requests go through the controller; agents never approve their own.

**Facts that change:** plan prices. See the channel entries.

**Sources:** internal (fleet economic policy: sweeps are on net profit, protected capital as defined in the charter).

### econ-stop-rules
**Title:** When to stop, pivot or double down

**Body:** Decide the rules before launch.
- **Stop:** zero sales after a fair exposure, e.g. 500+ targeted visitors or 30 days live with active promotion, and no qualitative interest (no questions or sign-ups).
- **Pivot:** interest without purchases means the price, offer or format is wrong. Change one variable.
- **Double down:** sales at or above threshold with profitable unit economics. Add an adjacent product, a bundle, or a second channel.

Ignore sunk cost. Record the reason for every decision. Retire dead listings to cut clutter, unless keeping them is free and harmless.

**Facts that change:** none.

**Sources:** internal method.

### econ-pricing-math
**Title:** Pricing math and price tests

**Body:**
- Contribution per sale = net price − variable costs (support time, refunds).
- Break-even units = fixed cost ÷ contribution.
- Raising the price cuts unit sales; raising the price 30% remains profitable unless it loses more than about 23% of units (at near-zero marginal cost).

Test prices sequentially with time blocks or new products. Do not show different prices to similar buyers simultaneously in a deceptive way, and never invent "original" prices. Look at revenue per visitor, not conversion rate alone.

**Facts that change:** none.

**Sources:** CMA207 (OGL) for pricing-practice limits.

---

## Category 8: Ethics and safety

### ethics-honest-claims
**Title:** No deceptive claims, ever

**Body:** Every statement about a product, its results, its scarcity, your identity or your track record must be true and checkable. Banned:
- fake scarcity or countdown timers
- fake "as seen in" badges
- invented sales numbers, user counts or customer testimonials
- income or results claims you cannot substantiate
- impersonating people or brands

Deception risks breaking the DMCC unfair-practice rules and the CAP Code, gets accounts closed (Gumroad and Stripe prohibit deceptive marketing), and destroys the fleet's reputation. When unsure, under-claim.

**Facts that change:** none.

**Sources:** CMA207 (OGL); ASA (link only); https://gumroad.com/prohibited (link only)

### ethics-ai-disclosure
**Title:** Truthful AI disclosure

**Body:**
- If anyone sincerely asks whether they're dealing with an AI, say yes, plainly.
- Disclose AI involvement where a platform requires it (Etsy listings) or where buyers would reasonably expect to know, such as "written with AI assistance and reviewed".
- Never present an AI agent as a named human, claim human credentials, or fake human testimonials.
- Use bot or automated labels where platforms provide them.
- Disclosure does not excuse poor quality: AI-assisted products must still be accurate and useful.

**Facts that change:** platform AI-disclosure rules. Etsy: SNIPPET; others UNVERIFIED. Verify at https://www.etsy.com/legal/creativity/

**Sources:** Etsy (link only); X automation rules (link only)

### ethics-platform-tos
**Title:** Respect platform terms and account integrity

**Body:**
- Read each platform's terms and prohibited list before listing.
- One account per approved identity. No ban evasion, duplicate accounts, scraping against ToS, automated engagement or review manipulation.
- If a rule is ambiguous, ask the platform's support or the operator; do not test the boundary.
- A suspended payment account can freeze funds for months, so compliance protects survival.
- Account creation, KYC and anything involving the operator's legal identity, keys or money movement requires operator approval and is never done by agents on their own.

**Facts that change:** platform terms (see the channel entries).

**Sources:** platform terms (link only)

### ethics-customer-fairness
**Title:** Treat customers fairly

**Body:**
- No dark patterns: no pre-ticked add-ons, hidden fees, cancellation obstacles or guilt-trip opt-outs.
- Honour statutory rights and your own published policies.
- Keep customer data private; never reuse it for unrelated purposes.
- Don't target vulnerable groups with high-pressure sales.
- If you get something wrong, fix it and refund proactively.

Long-term survival depends on repeat buyers and reputation more than on any single sale.

**Facts that change:** none.

**Sources:** CMA207 (OGL); legislation.gov.uk (OGL)

---

## (a) Recommended JSON schema for entries

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "FoundationLibraryEntry",
  "type": "object",
  "required": ["id","version","category","title","body","tags","factsThatChange","sources","lastReviewed"],
  "properties": {
    "id": {"type":"string","pattern":"^[a-z0-9]+(-[a-z0-9]+)*$"},
    "version": {"type":"integer","minimum":1},
    "category": {"enum":["demand-validation","product-formats-pricing","sales-channels","acquisition","delivery-support","uk-legal-compliance","unit-economics","ethics-safety"]},
    "title": {"type":"string","maxLength":120},
    "body": {"type":"string","description":"60-150 words, agent-facing, paraphrased"},
    "appliesTo": {"type":"object","properties":{
      "jurisdictions":{"type":"array","items":{"type":"string"}},
      "productTypes":{"type":"array","items":{"type":"string"}},
      "channels":{"type":"array","items":{"type":"string"}}}},
    "tags": {"type":"array","items":{"type":"string"},"minItems":3},
    "keywords": {"type":"array","items":{"type":"string"}},
    "factsThatChange": {"type":"array","items":{"type":"object",
      "required":["fact","lastChecked","verifyAt","confidence"],
      "properties":{
        "fact":{"type":"string"},
        "value":{"type":["string","number","null"]},
        "lastChecked":{"type":"string","format":"date"},
        "verifyAt":{"type":"array","items":{"type":"string","format":"uri"}},
        "confidence":{"enum":["verified-official","official-snippet","secondary","unverified"]},
        "staleAfterDays":{"type":"integer","default":90}}}},
    "hardRules": {"type":"array","items":{"type":"string"},"description":"non-negotiable constraints, e.g. 'no fake reviews'"},
    "escalateToOperatorWhen": {"type":"array","items":{"type":"string"}},
    "relatedIds": {"type":"array","items":{"type":"string"}},
    "sources": {"type":"array","items":{"type":"object",
      "required":["url","publisher","licence","usage"],
      "properties":{
        "url":{"type":"string","format":"uri"},
        "publisher":{"type":"string"},
        "licence":{"type":"string"},
        "usage":{"enum":["paraphrase-with-attribution","link-only","short-quote-allowed"]}}}},
    "lastReviewed": {"type":"string","format":"date"},
    "reviewer": {"type":"string"}
  }
}
```

Two retrieval rules to enforce in code:

1. When `factsThatChange[].lastChecked + staleAfterDays < today`, or the confidence is `unverified`, the retrieval layer adds a "VERIFY BEFORE RELYING" banner to the result.
2. `hardRules` are always returned with an entry, even when the body is truncated.

## (b) Retrieval guidance: tags and keywords

- **demand-search-signals**: demand, keyword-research, autocomplete, validation, niche
- **demand-marketplace-bestsellers**: competitor-research, reviews-mining, etsy, gumroad-discover, gap
- **validate-presell-smoke-test**: pre-sale, landing-page, waitlist, smoke-test, threshold
- **validate-define-experiment**: experiment, hypothesis, time-box, kill-condition, budget
- **format-templates-spreadsheets**: template, spreadsheet, google-sheets, excel, tracker
- **format-notion-digital-planners-printables**: notion, printable, planner, pdf, screenshots, ai-disclosure
- **format-guides-ebooks**: ebook, guide, pdf, accuracy, income-claims
- **format-micro-saas-tools**: saas, software, tool, subscription, data-protection
- **format-services-productised**: service, done-for-you, documentation, scope, cancellation-services
- **pricing-anchors-and-tiers**: pricing, tiers, anchor, discount, was-price
- **pricing-bundles-upsells**: bundle, upsell, order-bump, pre-ticked, aov
- **positioning-niche**: positioning, audience, value-proposition, copywriting
- **policy-refunds**: refund, policy, statutory-rights, digital-content
- **channel-gumroad**: gumroad, fees, merchant-of-record, prohibited, payout
- **channel-etsy-digital**: etsy, digital-download, fees, vat, ai-disclosure, payout
- **channel-payhip**: payhip, fees, vat, storefront
- **channel-lemon-squeezy**: lemon-squeezy, stripe-managed-payments, merchant-of-record, saas, payout
- **channel-ko-fi**: ko-fi, creator, tips, membership, gold
- **channel-paypal-links-invoicing**: paypal, invoice, payment-link, fees, cross-border
- **channel-stripe-payment-links**: stripe, payment-link, fees, kyc, restricted-businesses
- **channel-choose**: channel-selection, decision, comparison
- **acq-seo-basics**: seo, google, spam-policy, scaled-content
- **acq-content-marketing**: content, blog, repurpose, funnel
- **acq-communities-reddit**: reddit, community, self-promotion, disclosure
- **acq-email-pecr-gdpr**: email, newsletter, pecr, soft-opt-in, consent
- **acq-social-automation-rules**: social, x-twitter, automation, bot, spam
- **acq-marketplace-listing-optimisation**: listing, tags, title, images, marketplace-seo
- **delivery-digital-goods**: delivery, download, file-versioning, esss
- **support-customer-service**: support, tickets, response-time, escalation
- **support-chargebacks**: chargeback, dispute, evidence, fraud
- **legal-digital-content-cancellation**: ccr-2013, cancellation, 14-day, waiver, checkbox
- **legal-consumer-rights-digital**: cra-2015, quality, remedies, digital-content
- **legal-trader-information**: trader-info, address, terms, e-commerce-regs
- **legal-vat-digital**: vat, oss, eu-vat, threshold, marketplace-deemed-supplier
- **legal-income-tax-registration**: hmrc, self-assessment, trading-allowance, platform-reporting
- **legal-uk-gdpr-basics**: uk-gdpr, privacy-notice, ico-fee, dsar, breach
- **legal-advertising-cap-code**: cap-code, asa, substantiation, ad-labelling
- **legal-no-regulated-advice**: regulated-advice, fca, financial-promotion, medical, legal-services
- **legal-ip-copyright-trademark**: copyright, trademark, licence, plr, ai-copyright
- **legal-reviews-dmcc**: reviews, dmcc, fake-reviews, cma, incentives
- **legal-subscriptions**: subscription, auto-renewal, dmcc, cancellation
- **econ-fee-impact**: fees, net-margin, unit-economics, calculator
- **econ-experiment-budget-runway**: runway, burn, budget, capital-request
- **econ-stop-rules**: stop, pivot, kill, double-down, sunk-cost
- **econ-pricing-math**: price-test, break-even, contribution, elasticity
- **ethics-honest-claims**: honesty, deception, scarcity, testimonials
- **ethics-ai-disclosure**: ai-disclosure, transparency, bot-label
- **ethics-platform-tos**: tos, account-integrity, ban-evasion, approval
- **ethics-customer-fairness**: dark-patterns, fairness, vulnerable, privacy

**Suggested retrieval triggers** (intent → entries):

| Agent intent | Fetch |
|---|---|
| "pick a product idea" | demand-*, validate-*, positioning-niche |
| "list a product on X" | channel-X, channel-choose, acq-marketplace-listing-optimisation, legal-digital-content-cancellation, legal-vat-digital, ethics-platform-tos |
| "set a price" | pricing-*, econ-fee-impact, econ-pricing-math |
| "promote" | acq-*, legal-advertising-cap-code, ethics-honest-claims, ethics-ai-disclosure |
| "customer message / refund / dispute" | support-*, policy-refunds, legal-consumer-rights-digital |
| "collect emails" | acq-email-pecr-gdpr, legal-uk-gdpr-basics |
| "health, legal or finance topic" | Always fetch legal-no-regulated-advice |
| "review / testimonial" | Always fetch legal-reviews-dmcc |

## (c) Sources and licence notes

**UK government and public bodies** (OGL v3.0, Crown copyright: may paraphrase or reproduce with attribution, "Contains public sector information licensed under the Open Government Licence v3.0"):
- https://www.gov.uk/online-and-distance-selling-for-businesses
- https://www.gov.uk/guidance/the-vat-rules-if-you-supply-digital-services-to-private-consumers (page updated 28 March 2022)
- https://www.gov.uk/register-for-vat
- https://www.gov.uk/government/publications/vat-increasing-the-registration-and-deregistration-thresholds
- https://www.gov.uk/government/consultations/consultation-on-the-implementation-of-the-new-subscription-contracts-regime (government response 2 April 2026)
- https://assets.publishing.service.gov.uk/media/67eeb64fe9c76fa33048c790/CMA208_-_Fake_reviews_guidance.pdf (CMA)
- https://assets.publishing.service.gov.uk/media/686666f2e4184a43f9785c0e/CMA207_Unfair_commercial_practices_guidance.pdf (CMA)
- https://www.gov.uk/government/publications/report-and-impact-assessment-on-copyright-and-artificial-intelligence
- https://www.gov.uk/data-protection-register-notify-ico-personal-data

**Legislation** (legislation.gov.uk; OGL v3.0):
- SI 2013/3134 (Consumer Contracts Regulations)
- Consumer Rights Act 2015
- SI 2002/2013 (E-Commerce Regulations)
- SI 2025/63 (Data protection charges)
- Legal Services Act 2007

**ICO** (most content OGL v3.0; check the page footer, some media excluded): PECR email marketing guidance; data protection fee pages; small-organisation guidance.

**ASA/CAP** (asa.org.uk; copyright ASA/CAP, not OGL; summarise in your own words and link; no reproduction of Code text):
- Non-broadcast Code
- Misleading advertising
- Substantiation
- Recognising ads

**FCA** (fca.org.uk; FCA website terms allow non-commercial reproduction with acknowledgement; for safety, paraphrase and link only): financial promotions.

**EU** (vat-one-stop-shop.ec.europa.eu; © European Union, reuse with attribution per Decision 2011/833/EU).

**Google Search Central** (developers.google.com; text CC BY 4.0, code samples Apache 2.0; paraphrase with attribution): spam policies, the SEO starter guide, and the guidance on generative-AI content.

**Platform pages** (proprietary; facts paraphrased, no copying, link only):
- Gumroad: /pricing, /prohibited, help articles 66, 13 and 155
- Etsy: /legal/fees, /legal/creativity, /legal/sellers, help articles on digital VAT, deposits and payment reserves, and the seller handbook article on AI
- Payhip: /pricing, help articles 64, 65 and 132
- Lemon Squeezy: /pricing, docs "Getting paid"
- Ko-fi: help "Does Ko-fi take a fee", /gold
- PayPal UK: merchant fees (updated 1 Oct 2026), acceptable use policy
- Stripe: /gb/pricing, /legal/restricted-businesses, support "first payout"
- X: automation rules, authenticity policy
- Reddit: help and policies. Could not be fetched; secondary content only; UNVERIFIED.

**Secondary sources used only to flag figures I could not verify; do not cite them as authoritative:**
- dodopayments.com
- checkoutpage.com
- schoolmaker.com
- fungies.io
- nifty.ai
- printful.com

## Open verification items before release

1. Etsy's full fee table, especially the UK regulatory operating fee (0.48% or 0.32%).
2. Gumroad: whether card processing is included, the $20k volume rate, and the payout minimum.
3. Ko-fi Gold price and the fee on tips.
4. Stripe's non-EEA card rate (3.15% read today vs 3.25% historically).
5. Reddit's official self-promotion text.
6. Changes to PECR and UK GDPR under the Data (Use and Access) Act 2025, including fine levels.
7. The HMRC trading allowance and digital-platform reporting pages.
8. Whether Payhip is legally the seller for VAT purposes.
9. Lemon Squeezy onboarding and KYC, and the effect of the Stripe Managed Payments transition on new stores.

Nothing was created or changed in the repository. No accounts were created.