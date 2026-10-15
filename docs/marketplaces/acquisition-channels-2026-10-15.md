# The smallest practical channel set for the autonomous acquisition loop — 2026-10-15

## Goal
The goal is an agent that finds buyers on its own, without the owner posting for it. The channels must cover the whole acquisition loop:
1. Discovery: people find the offer.
2. Demand capture: people already searching to buy.
3. Visual reach: they see it where they browse.
4. Direct reach: business buyers for services.
5. Conversion: payment and delivery.

Each channel is operated only by a method its platform permits, through:
- an official API, under an account the owner holds;
- the Fleet's own systems;
- lawful email.

Platform facts are from `channel-rules-2026-10-15.md`, which marks secondary sources PROVISIONAL.

## The recommended set: four complementary channels

| # | Channel | Role in the loop | Permitted operating method | Account / API access needed | Costs | Integration — built in v80 / still missing |
|---|---|---|---|---|---|---|
| 1 | **The Fleet's own offer pages + search discovery** | Conversion hub for every channel (checkout, briefs, delivery, attribution); organic search discovery | The Fleet's own site: agents publish through the offer tools; search engines read the sitemap / structured data; IndexNow notifies participating engines (Bing, Yandex, Naver, Seznam — PROVISIONAL list; Google does not participate) | None beyond what exists. Optional, owner: verify the domain in Google Search Console / Bing Webmaster Tools (free; DNS record) | £0 beyond PayPal's fee per sale (existing) | **Built (v80):** sitemap.xml + robots.txt (sales open only), schema.org Product / Offer + Open Graph on offer pages, IndexNow notifications (sent by the channel gateway; the controller has no egress). **Missing:** nothing to operate; Search Console verification is optional and owner-side |
| 2 | **Etsy** (digital downloads) | Demand capture: buyers already searching a marketplace with built-in traffic | **Official API on the owner's own shop** (Open API v3: draft listing → files → images → activate; receipts and ledger read). Browser automation of Etsy is **not** used (its terms point automation to the API). AI-assisted designs disclosed (Creativity Standards; the gateway adds the disclosure) | Owner: opens the Etsy shop and passes Etsy's identity verification (government ID + selfie: human-only); creates an Etsy app for the own shop (keystring + shared secret; Etsy reviews apps — time PROVISIONAL); authorises it (OAuth + PKCE) with exactly `listings_r listings_w shops_r transactions_r`. Etsy pays out to the owner's bank | PROVISIONAL (secondary sources): listing fee about $0.20 per listing / 4 months; 6.5 % transaction fee; UK payment processing about 4 % + £0.20; a small regulatory operating fee; Offsite Ads 15 % (12 % above $10k/yr, then mandatory) only on sales they bring; a possible one-time shop set-up fee (shown at registration). API access: free | **Built (v80):** Etsy connector in the channel gateway (create / update / image / file / activate / deactivate; receipts → sale memos; payout ledger → payout claims on the owner's bank-evidence chain); the owner's OAuth onboarding; account + scope check before any job. **Missing:** buyer messages (Etsy has no messaging API; browser automation is not permitted): Etsy's own messages stay with the owner (the agent can draft answers); the payout ledger-entry type mapping (`DISBURSE*`) is verified on the first live payout |
| 3 | **Pinterest** (business account) | Visual discovery feeding both 1 and 2 (Pins link to offer pages via `channel_link` or to Etsy listings) | **Official API** (v5) on the owner's business account: boards, Pins (image + link + alt text). Browser automation is **not** used. PROVISIONAL: the developer guidelines restrict letting end users "automatically initiate actions without specifically considering each action" and require each scheduled Pin to be chosen — the agent composes and chooses each Pin individually, and the app's Standard-access review (a video of the OAuth flow and the integration) is where Pinterest decides whether that operation is acceptable | Owner: a Pinterest **business** account (commercial use requires it); a developer app (Trial access: Pins visible only to their creator — usable to rehearse; Standard access: public, after the video review); authorises it with exactly `boards:read boards:write pins:read pins:write user_accounts:read` | £0 (organic). Paid promotion later through the Ads API (spending: launch only) | **Built (v80):** Pinterest connector (create board, create Pin; business-account and scope check). **Missing:** Standard access (Pinterest's review; owner submits); Pin analytics read-back (next) |
| 4 | **B2B email outreach** (the venture's routing address) | Direct reach for services (studios, small firms) — the one channel that finds buyers who are not searching | The Fleet's own mailbox; UK PECR: corporate subscribers on legitimate interest; individuals / sole traders only with consent or an existing purchase; one recipient per message; legal seller + opt-out appended; opt-outs fleet-wide (v79) | None new (the shared Proton mailbox and the agent's routing address exist) | £0 marginal (existing mailbox plan); a 500 / day failsafe | **Built (v79).** **Missing:** none to operate; deliverability depends on the shared domain's reputation — keep volumes modest |

**Why these four.** Together they cover discovery (1, 3), existing demand (2), direct reach (4) and conversion (1). Each is operated through a route its platform permits, and agents publish on all four without the owner posting anything. The owner is needed only to:
- **open accounts** where the law or the platform needs the owner's identity;
- **authorise each API once;**
- **complete the payout evidence** for Etsy's bank payouts.

## Considered and not in the set (now)

| Channel | Why not now | What it would take |
|---|---|---|
| LinkedIn | Scripted operation prohibited; posting to a company page needs LinkedIn's partner-approved Community Management API | LinkedIn partner approval (uncertain); a company page |
| X | Non-API automation prohibited; the API is paid (tier pricing not verified here) | X API plan (cost); Automation Rules compliance |
| Instagram / Facebook | Publishing only through the Graph API for professional accounts with Meta app review and business verification | Meta app review + business verification |
| Reddit | Reddit's own terms not read (PROVISIONAL); commercial use needs an agreement; communities restrict self-promotion | Reddit's Data API terms + an agreement |
| Gumtree | Automated posting not established (silence is not permission); no posting API | Gumtree's written confirmation |
| Gumroad | Built (v52) and suits EU consumer digital sales (merchant of record) | Owner onboarding; the £500 wallet unlock (owner decision) |
| Fiverr / Upwork | One identity-verified human per account; autonomous operation not permitted | — (human-owned use only) |

## Order of activation
1. **Own pages:** live as soon as sales open. Discovery is automatic.
2. **Email:** under a scoped release, then at launch.
3. **Etsy:**
   1. The owner opens the shop and authorises the app.
   2. Under a release that names the Etsy channel and its operations, the agent drafts one listing.
   3. It uploads the image and file and activates the listing. Activation is public at once.
4. **Pinterest:** Trial access first; Pins stay private until Standard access.
