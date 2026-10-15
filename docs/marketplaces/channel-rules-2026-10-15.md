# Channel rules for the intended workflow — checked 2026-10-15

## What v79 provides, and what it does not claim
- **What it provides:** general browser capabilities, tested on representative interfaces. These are the four kinds of site in `fleet-browser-pg`:
  - classic sign-up and login forms;
  - a listing editor with uploads, an embedded editor, dialogs, downloads and popups;
  - a JavaScript profile wizard;
  - a social post composer.
- **What it does not claim:** that any channel works, or that a given platform permits an agent to operate it. Each platform's own terms decide that, per workflow.

## How to read this (corrected 2026-10-15)
- **Two different things:**
  - a **human-owned account using permitted AI assistance** (a person runs the account; AI helps draft and prepare);
  - **automated account operation** (software, including an AI agent, performs the account's actions).

  A platform can allow the first and prohibit the second. Its terms decide each separately.
- **Silence is not permission.** Where a platform's terms do not address automated posting or operation, the finding is
  "not established": the agent does not operate it automatically until the platform confirms (an official API whose terms cover
  the use, or written confirmation).
- **Provisional findings.** A finding based on secondary sources, or on terms I could not read directly, is marked
  PROVISIONAL. Labels such as "closed to agents" are replaced by the precise finding.

## The three questions asked of each platform
1. **Permitted assistance.** Can AI help a human run the account: drafting listings, posts and replies; preparing images; analysing results?
2. **Account ownership.** Who must own the account? A real, identified person? One account per person? Is a business account required? Is there a live identity check?
3. **Automated operation.** May software operate the account without a human doing each action?
   - Through the platform's API only?
   - Or also by scripting the website, which is what the Fleet's browser worker does?

## Intended workflow (agent side)
- Create or operate the seller or brand account.
- Publish listings, service ads and posts.
- Answer messages.
- Read the account's own results.

## Findings (sources and dates below; re-verify before relying on them)

| Platform | Permitted assistance | Account ownership | Automated operation through the browser | Route that fits the rules |
|---|---|---|---|---|
| **LinkedIn** | AI-assisted content: LinkedIn offers its own generative features (§3.6) | One account per person, in their **real name**; no accounts "on behalf of others"; no sharing (§2.1, §2.2, §8.1(3), §8.2(1)) | **Prohibited.** Bots or unauthorised automated methods to access the service, add contacts, or to "create, comment on, like, share, or re-share posts" (§8.2(13)); software, scripts, crawlers and browser add-ons for scraping (§8.2(2)) | The agent drafts and the owner posts (assistance), or an official LinkedIn API product under the owner's company page (platform integration; not built) |
| **X** | Content assistance is ordinary use | One account per person (standard terms; not re-quoted here) | **Prohibited outside the API:** "non-API automation", including scripting the website, risks permanent suspension (Help Center automation rules; Developer Agreement) | X API under the Automation Rules (consent before automated replies / DMs, honour opt-outs, no bulk actions). Platform integration; not built |
| **Instagram / Facebook (Meta)** | Content assistance is ordinary use | Authentic accounts; commercial use through Pages / professional accounts | **Restricted:** no creating accounts or collecting information "in unauthorized ways" or in an automated way without permission (Instagram terms); Meta terms §3.2.3 and its Automated Data Collection Terms bar automated data collection, logged in or not. **APIs are the only allowed programmatic access** (Meta developer documentation) | Meta Graph API for a business account the owner holds (publishing, messages). Platform integration; not built |
| **Pinterest** | Content assistance is ordinary use; developer guidelines list "apps that automate the creation of content" as acceptable | Accurate information; **a business account is required for commercial use** (§2(a), §2(c)) | Browser automation: **not permitted** ("automated means (without our express prior permission)", §2(a)). API: permitted through an approved app. The developer guidelines **restrict** "features that enable end users to automatically initiate actions without specifically considering each action", and scheduled Pins must each be chosen by the end user, so **fully autonomous publishing is PROVISIONAL** until Pinterest approves Standard access for an app that discloses it | Pinterest API v5 (Trial: Pins visible only to their creator; Standard: public, after a video review of the OAuth flow). Platform integration; prepared in v80; Standard-access review decides |
| **Etsy** | A human-owned shop may sell AI-assisted designs: Creativity Standards place them under "Designed by", with **AI use disclosed in the listing** (PROVISIONAL: secondary sources; the official page returned only its introduction). Prompt bundles alone are prohibited | **Seller identity verification:** government ID **plus a selfie** (Persona) for sellers outside the EEA/UK. EEA sellers confirm their shop information. A human-only step for the owner | **Browser automation: not permitted as found** (Terms of Use §6 C: no crawling, scraping or spidering without permission; automation goes to the API — PROVISIONAL, the page refused automated fetching). **API operation of the owner's own shop: the Open API's purpose** (official developer docs: OAuth 2.0 + PKCE, `listings_w`; draft listing → files → images → activate; read receipts and ledger). No buyer-messaging API | Etsy Open API v3 for the owner's own shop (a "seller app"; app approval by Etsy). Platform integration; prepared in v80. The shop is opened by the owner (identity check). Payouts go to a bank (the `owner_bank` route) |
| **Gumtree (UK)** | A human-owned account may use AI to prepare ads (ordinary use) | 18+; KYC for payment / delivery services; business sellers may be charged | **Not established.** Scraping is prohibited ("any robot, spider, scraper or other automated means to access Gumtree and collect content"; no bypassing access controls); the terms read are **silent on automated posting, which is not permission**. No public posting API found | No automated operation unless Gumtree confirms in writing; otherwise assistance only |
| **Reddit** | A human-owned account may use AI assistance (subject to each community's rules) | Per its User Agreement (not read directly) | **PROVISIONAL** (secondary source dated 2026-07; Reddit's own pages refused fetching): scraping requires Reddit's consent; bots operate through the Data API under its terms; commercial use needs a separate agreement | Not established until Reddit's own terms are read; not in the recommended set |
| **Fiverr / Upwork** | A human freelancer's own account may use AI tools in the work, within each platform's rules on AI and disclosure (not re-read) | **One identity-verified human per account** (Fiverr: government ID, its Community Standards forbid fake identities and multiple accounts; Upwork: one account, ID / video checks — **PROVISIONAL**, secondary source) | **Not permitted as found:** the account must be the verified person's own; an AI agent operating it would misrepresent who performs the account's actions. No seller-operation API | Human-owned use with AI assistance only; not an autonomous channel |
| **Gumroad** | n/a | The owner's account (Stripe identity check for payouts) | Through the Fleet's own gateway (API) | Built (v52); owner onboarding; the £500 unlock |
| **The Fleet's own offer pages** | n/a | The legal seller (owner) + the agent's brand | The Fleet's own system | Built and deployed (v76–v78) |
| **Email outreach** (the routing mailbox) | n/a | The legal seller's identity in every message | The Fleet's own mailbox; lawful-basis rules (v79) | Built (v79); held until release |

## What this means for the operator
1. **Where the browser is permitted.** The general browser is the right tool for:
   - sites whose terms permit automated operation, or don't prohibit it, with the rule recorded;
   - the agent's own pages;
   - suppliers' and tools' dashboards the agent uses as a customer;
   - research reading where crawling is permitted;
   - rendering and preparing assets.

   On the major platforms above, operating the account through scripted browsing is prohibited or restricted. The agent must not do it.
2. **Three lawful routes on those platforms:**
   - **(a) Official API** under an account the owner holds. This is platform-specific integration work, added per platform only on demonstrated need.
   - **(b) Assistance.** The agent prepares listings, posts, images and replies; a human posts them. The owner's time is the cost.
   - **(c) Choose another channel.**
3. **Account ownership.** Etsy, LinkedIn and others require the owner as the identified account holder. A live selfie or ID check is human-only. The agent can then operate only through the route the platform permits for that account, (a) or (b).
4. **Enforcement in the Fleet.** `business add_channel` refuses to make a third-party channel `active` without the rules recorded (`rulesSource` + `rulesSummary`). The Charter and Field Guide tell the agent not to operate where terms forbid automation. This document's findings are in the agent library (capability status, bf-channels). The Fleet does not hard-code a platform deny-list: the platform's current terms decide, and the agent records them.

## Sources (fetched or searched 2026-10-15)
- LinkedIn User Agreement — https://www.linkedin.com/legal/user-agreement (fetched)
- Gumtree Terms of Use — https://www.gumtree.com/termsofuse (fetched)
- Pinterest Terms of Service — https://policy.pinterest.com/en/terms-of-service (fetched)
- X Developer Agreement / guidelines — https://docs.x.com/developer-guidelines ; platform usage guidelines — https://developer.x.com/en/developer-terms/policy/platform-usage-guidelines ; Automation Rules (help.x.com, translated versions seen)
- Meta Automated Data Collection — https://developers.facebook.com/documentation/development/terms-and-policies/automated-data-collection ; Meta terms §3.2.3 (via ConductAtlas record https://conductatlas.com/platform/meta/meta-terms-of-service/automated-data-collection-restrictions/)
- Instagram Terms of Use (Help Center) — https://help.instagram.com/581066165581870 , https://help.instagram.com/740480200552298 (wording via secondary copies)
- Etsy Terms of Use — https://www.etsy.com/legal/terms-of-use (refused automated fetch; §6 C wording via search results); Etsy identity verification (Persona) — https://help.etsy.com/hc/en-us/articles/22504854625815-Identity-Verification-with-Persona-on-Etsy
- Reddit — https://redditinc.com/policies (refused fetch); secondary summary https://vorplabs.com/agent-tools/reddit-data-api
- Fiverr Community Standards — https://help.fiverr.com/hc/en-us/articles/32242973123985-Our-Community-Standards ; Fiverr identity verification — https://help.fiverr.com/hc/en-us/articles/13127850435345-Verify-your-identity ; Upwork (secondary) https://www.comparitech.com/blog/information-security/upwork-gig-economy-identity-fraud

**Not verified from the platform's own page:** Etsy's §6 C exact wording, Reddit's User Agreement wording, and Upwork's one-account clause. Each is marked above. Re-check before acting on them.
