# Decision: marketplace route or direct-service route

Written 2026-10-30. Decision document only. Nothing here is approved, built, sent or spent. It withdraws the earlier recommendation of the accessibility business.

**How far to trust this:** no customer has been asked anything on any route. All economics are scenarios built on assumptions, computed by code. **Read directly:** ICO pages. **Search excerpts only, because the pages refuse automated reading:** Etsy, Upwork, Fiverr. A person must read those before anyone relies on them.

## 1. Recommendation

- **Marketplace (matches the stated objective):** small fixed-price spreadsheet and catalogue data clean-up jobs on **Upwork**, through its official AI-agent connection, with the owner as the verified account holder confirming each proposal and message. Conditional on section 4.
- **Alternative:** the accessibility pre-audit by direct outreach. A different business from the pilot asked for, and not recommended now.
- **Not a demand winner.** Upwork ranks first on platform fit and because demand can be seen in posted jobs before anything is built. Nobody has yet counted those jobs.

**The real cost:** Upwork's connection requires a person to confirm every proposal and message, and offers are accepted on its site. That conflicts with the 15 Oct "no per-post approval" decision and is not unattended operation. No marketplace I checked gives a verified route to full autonomy.

## 2. The two routes

| | **A. Upwork, data clean-up** | **B. Direct outreach, accessibility** |
|---|---|---|
| Acquisition | Agent searches posted jobs, drafts proposals. Connects (paid credits) spent on confirm | Agent finds UK companies, scans public pages, cold emails |
| Order intake | Contract starts when the owner accepts on upwork.com | Enquiry form, then quote. An emailed "yes" creates no durable obligation today |
| Delivery | Through Upwork's workroom; agent access unverified | Fleet's `order.deliver` |
| Messaging | Drafted, owner confirms; inbound read access unverified | Email and order thread |
| Payment | Upwork escrow; payout route to PayPal or bank unverified | PayPal treasury rail on a Fleet-served page |
| Refunds | Through Upwork; agent access unverified | `order.refund`, existing authority |
| Owner work | Account, identity, tax, each confirm, accepting offers. About 65-265 minutes per job in the scenarios | Terms, liability, insurance, domain and DNS, reviewer, release, first wave |
| Who holds the risk | Platform dispute rules; lower-stakes work | Owner personally, for a wrong report |

**Smallest build, A** (provisional until the connection's tools are read):
1. Connector in the channel gateway, with the token vaulted.
2. Drafts routed through the existing owner-request path, no new dashboard.
3. Contract and message reads opening v124 orders with provider evidence, if readable.
4. Upwork balance and withdrawal as a platform record, cash booked on arrival.
5. The section 6 fixes.

**Smallest build, B:**
1. Pinned site-scan operation.
2. A reply from a known lead opens one obligation.
3. Report template stating the limits.
4. A real human review step.
5. Install Treasury Watch.
6. The section 6 fixes.

**What existing tests do not prove.** The £1 and £5 tests proved checkout, file delivery and a refund for a file product. They do not prove tailored audit quality, email support, outreach, this price, or any route above. Neither route has been run.

## 3. Accessibility, separated honestly

| Kind of evidence | What exists |
|---|---|
| **Demonstrated buyer demand** | **None found.** No evidence that any UK company buys a limited pre-audit at any price. No independent willingness-to-pay data |
| Regulatory pressure | Real but early: reported Carrefour ruling (Caen, June 2026), Dutch and Swedish regulator activity, German warning letters. Mostly vendor reporting. No UK-specific enforcement found. These target larger stores in the reports found; nothing shows small UK stores under pressure |
| Vendor pricing | Agency estimates of €2,000-€5,000. Those are sellers' figures for a fuller service, and do not show what a limited report can charge |
| Need | Vendor audits show widespread failures. Failure is not the same as willingness to pay |

**Competence limits:** no real screen-reader or keyboard-with-assistive-technology testing; automated tools miss many issues (Deque's own figure is 57% of issues by volume); the agent cannot judge whether a company is exempt; no accessibility expert in the loop. Without human review, a report can only be a partial list. The FTC's $1m order against accessiBe shows the danger of overclaiming.

**Full economics per sale at £149** (all inputs assumed):

| | Good case | Middle | Poor |
|---|---|---|---|
| Conversion, cost per prospect | 2%, $0.20 | 1%, $0.50 | 0.2%, $0.50 |
| PayPal fee (2.9% + 30p, unverified) | £4.62 | £4.62 | £4.62 |
| Acquisition AI | £8.00 | £40.00 | £200.00 |
| Fulfilment AI | £2.40 | £9.60 | £9.60 |
| Support AI | £0.40 | £1.60 | £1.60 |
| Human review | £0 (unsafe) | £40.00 | £40.00 |
| Refunds (5%, 10%, 20%) | £7.45 | £14.90 | £29.80 |
| **Net per sale** | **£126.13** | **£38.28** | **−£136.62** |

Excluded: insurance (unpriced, could exceed early margin), owner time, sending domain. Break-even at middle costs is about 0.5% conversion at $0.50 a prospect. The conversion rates are invented; nothing supports them. FX assumed $1 = £0.80.

**Upwork at £120 a job, same method** (10% fee and Connects at 15 × $0.15 are from memory, unverified; win rates invented):

| | Good | Middle | Poor |
|---|---|---|---|
| Win rate, proposals per job | 10%, 10 | 5%, 20 | 2%, 50 |
| **Net per job** | **£82.00** | **£48.00** | **−£27.60** |
| Owner minutes per job | 65 | 115 | 265 |

Neither table shows a viable business. They show which assumptions matter: win or conversion rate.

## 4. Legal and platform claims, rechecked

| Claim | Status | Source |
|---|---|---|
| Cold email to UK companies needs no consent, but identity and a valid opt-out are required | **Verified, with a warning.** The B2B page says "this guidance is under review" because of the 2025 Act | ICO, read directly |
| Sole traders are protected like individuals; if unsure, treat as individual | Verified | ICO, read directly |
| Named employee addresses are personal data, so UK GDPR still applies | Search excerpt of ICO | ICO |
| Enforcement raised to UK GDPR level (£17.5m cited) | Direction verified; the figure is from an excerpt | ICO |
| Other countries' email rules | **Not researched** | |
| **Outreach is not authorised by any of this**, and legal advice has not been taken | | |
| Etsy: "Bot-generated listings without any human involvement aren't allowed"; can remove the shop | **Prohibited** for autonomous listing. Excerpt, dated 22 Oct 2026. **This is new and hits our Etsy path** | Etsy, unread in full |
| Etsy: AI use must be disclosed; instructions buyers rely on must be your own work; digital items made or designed by the seller | Excerpt. Whether a spreadsheet template counts is **ambiguous** | Etsy, unread in full |
| Etsy: 6.5% + 4% + 20p + 15p listing + 0.48%; deposits to a bank account | Excerpt; UK sell page may be old | Etsy, unread in full |
| Etsy API: refund or buyer messages | **Unverified.** Nothing found either way | |
| Fiverr: no bots or automation software on the site; multiple accounts barred | **Prohibited** for an agent-run route. Excerpt | Fiverr, unread in full |
| Upwork: official freelancer AI connection; writes need confirmation; bots otherwise restricted | Excerpt, August 2026 announcement | Upwork, unread in full |
| Upwork: may an AI do the work under a person's account; disclosure; one-person rule; delivery access; withdrawal to PayPal | **Unverified. These decide route A** | API and MCP Terms not found |

**Etsy is second on the marketplace side:** official API and automatic digital delivery, but it needs a human behind each listing, has no verified route for buyer messages or refunds, and pays to a bank. About £9.73 net on a £12 item after fees and 5% refunds, with demand unmeasured.

## 5. Why accessibility does not clearly outrank data clean-up

I withdraw that ranking. It rested mainly on price.

| Test | Accessibility | Data clean-up | Better |
|---|---|---|---|
| Observed demand | Pressure, no buyers seen | Posted gigs and bids, few and not counted | Clean-up, weakly |
| Output can be fully checked | No | Yes: files validate against rules | Clean-up |
| Agent competence | Partial, needs a human | Good on current tools; untested on real jobs | Clean-up |
| Harm if wrong | Liability, false assurance | Bad file, fixable | Clean-up |
| Fits marketplace objective | No | Yes | Clean-up |
| Price per job | £149 possible, unproven | $90-150 bids seen | Accessibility, unproven |
| Competition | Free scanners, agencies | Apps at $9-10 a month, low bids | Neither |
| Own access to customers | Direct, legally sensitive | Platform-mediated | Depends |

**Uncertainty:** apps and low bids could make clean-up unprofitable, and I have seen very few prices. A count of real job posts could overturn this.

## 6. Security and reliability findings (separate from the business choice)

### 6.1 The 29 unrouted events, by impact

Function-level check: only `repo_access_active` alerts in its own function; `operation_uncertain` alerts elsewhere for email only; card disputes have a separate sweep.

| Priority | Events | Why |
|---|---|---|
| **1. Fix first (3)** | `paypal_refund_unresolved`, `operation_uncertain`, `message_check_stalled` | A customer's refund or message, or an outside action, has an unknown outcome and may reach only the audit log |
| **2. Should reach the owner (10)** | `card_dispute_opened`, `card_dispute_resolved`, `channel_payout_rejected`, `treasury_shortfall_covered`, `money_location_transfer`, `money_location_transfer_arrived`, `card_hold_released_verified`, `browser_credential_pending`, `repo_access_requested`, `owner_request_superseded` | Money position changes, or something is waiting on a person |
| **3. Audit-only is acceptable (16)** | `inference_profile_set`, `order_correction_withdrawn`, `message_check_decided`, `public_site_set`, `browser_credential_confirmed`, `channel_added`, `money_location_added`, `money_location_status`, `money_location_card`, `repo_access_consented`, `repo_access_active`, `code_job_done`, `repo_access_revoked`, `card_slot_set`, `operation_replayed`, `operation_resolved` | Owner's own action, or a routine record. To be named explicitly so the default stops hiding new events |

### 6.2 Evidence for delivery and refund completion

Committed v124 is better but **not sufficient**:
- A browser action is not tied to the order. One action could complete many orders. It should have to show the order's reference and count once.
- Browser evidence is unusable where a platform bars automation, so evidence must be set per channel.
- Refund-after-delivery has no open obligation: delivery closes it, and a later `refund_needed` does not reopen it. **This is a defect** in the commit.
- `refund_reported` raises an event but no owner notification.
- Owner confirmation exists only as a database function, with no owner route.
- No client sends delivery or refund state, so the provider route is untested with any real client.

### 6.3 Restart and concurrency in external orders

- **Duplicate orders:** an agent entering `8841` and the gateway reading `etsy-receipt-8841` create two orders for one sale.
- **Silent loss:** the poll ignores `ok: false` from a sale record, then advances the cursor, so a rejected or mid-poll inactive record is not retried.
- **Blocked poll:** a provider state that throws, such as a refund above gross, stops the poll before the cursor moves, so every later receipt waits indefinitely.
- **Paging:** Etsy reads 100 receipts with no paging and advances the cursor anyway.
- **Untested:** a real worker restart, and two writers on one reference. By reading, the unique key leaves one order and the loser gets a raw error.

## 7. Credit, unchanged

$3.00 authorised; $1.511769 consumed; **$1.488231 remaining**, from a reading earlier today. No paid call is proposed here.

## Sources

- ICO: [email marketing rules](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-direct-marketing-using-electronic-mail/how-do-we-comply-with-the-pecr-electronic-mail-marketing-rules/), [B2B marketing](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/business-to-business-marketing/), [2025 Act summary](https://ico.org.uk/about-the-ico/what-we-do/legislation-we-cover/data-use-and-access-act-2025/the-data-use-and-access-act-2025-duaa-summary-of-the-changes/privacy-and-electronic-communications/), [schedules](https://ico.org.uk/about-the-ico/what-we-do/legislation-we-cover/data-use-and-access-act-2025/the-data-use-and-access-act-2025-duaa-summary-of-the-changes/schedules/)
- Etsy: [AI updates](https://www.etsy.com/seller-handbook/article/1522733284810), [Creativity Standards](https://www.etsy.com/legal/creativity), [Seller Policy](https://www.etsy.com/legal/sellers/), [API Terms](https://www.etsy.com/legal/api/), [UK selling](https://www.etsy.com/uk/sell), [Payments](https://www.etsy.com/uk/payments)
- Fiverr: [Terms](https://www.fiverr.com/legal-portal/legal-terms/terms-of-service), [Community Standards](https://help.fiverr.com/hc/en-us/articles/32242973123985-Our-Community-Standards)
- Upwork: [MCP](https://www.upwork.com/ai/mcp), [MCP support](https://support.upwork.com/hc/en-us/articles/55446516654611-How-to-use-Upwork-with-AI-agents-through-MCP), [bots and automation](https://support.upwork.com/hc/en-us/articles/43342677368467-Use-bots-and-other-automation-properly), [announcement](https://investors.upwork.com/news-releases/news-release-details/upwork-talent-now-everywhere-ai-works)
- Accessibility (mostly vendors): [Statutus](https://statutus.ch/en/guides/european-accessibility-act-enforcement-so-far/), [Atyantik](https://atyantik.com/blog/european-accessibility-act-enforcement/), [Kolonell](https://kolonell.com/en/blog/european-accessibility-act-website-compliance-cost-berlin-2026), [Deque](https://www.deque.com/blog/automated-testing-study-identifies-57-percent-of-digital-accessibility-issues), [FTC summary](https://www.mondaq.com/unitedstates/advertising-marketing-branding/1568116/ftc-finds-website-overlay-tool-failed-to-deliver-accessibility-promises)
- Clean-up prices (thin): [Freelancer](https://www.freelancer.de/projects/data-entry/shopify-store-pricing-listing-overhaul), [FeedCue](https://apps.shopify.com/feedcue), [Fiverr gig](https://fiverr.com/viethpham/clean-and-optimize-your-shopify-or-bigcommerce-product-data)
