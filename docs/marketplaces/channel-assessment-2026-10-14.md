# Selling and advertising channels — assessment (2026-10-14)

Research for the market-facing completion pass (master specification §30). Nothing was signed up for, posted or
submitted. **Confidence:** HIGH = read on an official page; MEDIUM = official wording seen only through search extracts
(etsy.com, help.etsy.com, fiverr.com and upwork.com refuse automated fetches); LOW = third-party only. Every MEDIUM/LOW
fact must be re-checked by a human in a normal browser before money or an account depends on it.

## Summary: what the Fleet supports at launch

| Channel | Kind | Launch status | Why |
|---|---|---|---|
| **Fleet offer pages** (`/o/<slug>` on the controller domain, treasury PayPal checkout) | selling: products and services | **Built (v76)** | Our own checkout, delivery, briefs, messages, review gate and accounting; no third-party account or human-only step per sale |
| Etsy | selling: original digital downloads; a narrow set of custom design/writing | **Assessed, not built** | Needs the owner's verified shop, a UK bank payout rail (no PayPal payouts), OAuth app and webhook; no buyer-messaging API — see §1 |
| Gumroad | selling: downloads | **Preserved, not onboarded** (owner's £500 unlock decision stands) | v52 storefront code exists; merchant of record since 2025-01-01 |
| Payhip | selling: downloads, bundles | Not built | No product/sales API (coupons and licence keys only); payouts to the seller's own PayPal |
| Lemon Squeezy / Stripe Managed Payments | selling: software, downloads | Not built | Waitlist migration; products read-only by API; **services excluded** |
| Fiverr / Upwork | selling: services | **Not supported for autonomous operation** | One verified human per account; Upwork's MCP requires the human to confirm every proposal; no Fiverr seller API |
| LinkedIn, Reddit, Pinterest, YouTube, Instagram | advertising | Agent-chosen, through accounts the owner can see; approved APIs only, human-paced | No platform tolerates unattended mass posting by AI; see §5 |

Selling channels (where an order and payment happen) are distinct from advertising channels (which send people to an
offer page). A social post is not an order integration.

## 1. Etsy (the requested additional marketplace)

**Account and money (MEDIUM unless marked)**
- 18+ account owner; identity verified at Etsy Payments enrolment (https://help.etsy.com/hc/en-gb/articles/115014503608).
- UK bank account matching the legal name, verified by test deposit or the shop is suspended after 90 days
  (https://help.etsy.com/hc/en-gb/articles/115015775908).
- **Payouts go to a bank account only** — "We're unable to send sale funds to a PayPal account or to a credit or debit
  card" (https://help.etsy.com/hc/en-us/articles/360002120927). Etsy Payments is mandatory. Schedule daily/weekly
  (default Monday)/fortnightly/monthly; 5-day hold after a bank change; Bacs ≈ 3 business days; rolling reserves at Etsy's
  discretion (https://www.etsy.com/legal/etsy-payments/).
- No Etsy clause found allowing or forbidding a shop operated by an AI; the model is a verified human or business holder
  responsible for the shop.

**Digital products**
- Delivered automatically by Etsy (listing `type=download`/`both`) — HIGH (Open API spec).
- Limits: 5 files per listing, 20 MB each — LOW (secondary).
- AI is allowed under "Designed by a seller"; **"Sellers must disclose within their listing description if an item is
  created with the use of AI"** (https://www.etsy.com/legal/creativity/, https://www.etsy.com/legal/sellers/) — MEDIUM.
  The API has no disclosure field: the description is the only place — HIGH.
- Prohibited: standalone AI prompt bundles; anything not made/designed/handpicked/sourced by the seller (treat PLR and
  resale-rights files as prohibited).
- Services: only those producing a new item (custom writing, design, logos, illustration delivered as files); research,
  consulting and software fixes are effectively out (https://www.etsy.com/legal/policy/services/242665313101) — MEDIUM.

**Fees** (official page https://www.etsy.com/legal/fees/ was blocked — verify by hand): listing US$0.20 per 4 months,
transaction 6.5%, UK payment processing 4% + £0.20, UK regulatory operating fee (0.25–0.48%, sources conflict), currency
conversion 2.5% — LOW. Offsite Ads 15% (12% and compulsory ≥ $10k/yr), cap $100/order — MEDIUM. A non-VAT-registered UK
seller pays 20% VAT on Etsy's fees — MEDIUM. Etsy collects and remits VAT on digital downloads for UK/EU buyers — MEDIUM
(this would solve the EU consumer route).

**Open API v3** (HIGH; https://developers.etsy.com/documentation/)
- Listings: `createDraftListing` → `uploadListingImage` (≥ 1 image to publish) → `uploadListingFile` → `updateListing`
  (`state=active`).
- Orders: `getShopReceipts`, `getShopReceipt`, transactions by receipt/shop. Reconciliation:
  `getShopPaymentAccountLedgerEntries`, `getPaymentAccountLedgerEntryPayments`, `getPayments` (gross, fees, net).
  Bank payouts are not exposed.
- **No buyer messaging endpoints.** Buyer notes are readable on a receipt (`message_from_buyer`).
- Webhooks: `order.paid`, `order.canceled`, `listing.*` …; HMAC-SHA256 (`webhook-id/-timestamp/-signature`, `whsec_`
  secret, 300 s window); retried ~1.5 days.
- Auth: OAuth2 + PKCE; 1 h access, 90-day refresh tokens; scopes `listings_r/w/d`, `transactions_r`, `shops_r`.
  Seller App (own shop) approved near-instantly; Personal (≤ 5 shops) reviewed; Commercial manual review.
- API Terms (https://www.etsy.com/legal/api/) — MEDIUM: no scraping or automated access beyond the API without written
  authorisation; no collecting Etsy content for AI training; minimum data. No clause found banning listing creation by
  API (its core purpose); none found about an AI agent acting for the seller.

**What Etsy integration would need (not built)**
1. Owner (human-only): create the shop; Etsy Payments identity; Legal and tax info; UK bank in the matching name and test
   deposit; deposit schedule; VAT-registration decision; Offsite Ads decision; Seller App registration; OAuth consent in a
   browser (and re-consent before each 90-day refresh expiry); webhook endpoint and secret in the portal; read the fee
   page, Seller Policy, Creativity Standards and API Terms by hand.
2. Fleet code: an Etsy connector (sealed OAuth tokens in the custody/identity vault; refresh); listing publisher that
   requires the v76 review gate, AI disclosure text and `who_made=i_did`; `order.paid` webhook receiver with HMAC
   verification plus `getShopReceipts` polling; per-receipt attribution to the agent's offer (listing ↔ offer mapping);
   ledger rail **"Etsy payment account → owner bank"** (sales recognised net of Etsy fees from ledger entries and
   payments; bank deposits matched by a bank feed or the owner's statement — Etsy exposes no payout API); refunds via
   Etsy only; no buyer messaging (auto-delivered downloads only, or the owner answers Etsy messages by hand).
3. Constraints: one owner-verified shop shared by agents (not one shop per agent); money lands in the owner's bank, not
   the treasury PayPal — a new rail and a bank feed are the critical path; Etsy is unsuitable for most services.

Estimate: one coordinated release (connector, receipts ingestion, ledger rail, listing publisher, dashboard) after the
owner's onboarding steps; the bank-side reconciliation (no payout API) is the riskiest part.

## 2. Gumroad, Payhip, Lemon Squeezy

- **Gumroad** — merchant of record since 2025-01-01; 10% + $0.50 (30% via Discover); weekly payouts after ≥ 7-day hold, to
  bank (PayPal only where bank is unavailable); API v2 for products, sales, refunds, webhooks (LOW); "AI services"
  prohibited (AI-made products not mentioned); Terms (2026-10-14): no account on behalf of someone else, funds may be
  held, 25% reserve if refunds > 15%. https://gumroad.com/pricing, https://gumroad.com/terms
- **Payhip** — reseller for UK/EU digital VAT; 5% free plan (or monthly plans) + PayPal/Stripe fees; paid immediately to
  the seller's own PayPal/Stripe; API is coupons and licence keys only; webhooks for paid/refunded; PLR/MRR prohibited;
  5 GB per file. https://payhip.com/eu-vat, https://help.payhip.com/article/173-how-do-i-get-paid
- **Lemon Squeezy** — moving to Stripe Managed Payments (waitlist); digital products only, services excluded; 5% + $0.50
  (+1.5% international, +1.5% PayPal); payouts 1st/15th in USD; products read-only via API.
  https://www.lemonsqueezy.com/blog/2026-update, https://docs.stripe.com/payments/managed-payments/eligibility

## 3. Fiverr and Upwork (MEDIUM)

- **Fiverr** — AI-assisted work allowed with full accountability; disclose when asked; one account per person with ID +
  selfie; 20% fee; 14-day clearing; PayPal/Payoneer/bank; no seller API.
  https://help.fiverr.com/hc/en-us/articles/37333301560593
- **Upwork** — one account ever; ID + video verification; bots prohibited; official MCP server (2026-08-10) drafts
  proposals but the human confirms each one and is solely responsible; GraphQL API gated ($25k+ earnings, JSS ≥ 90%).
  https://www.upwork.com/ai/mcp, https://support.upwork.com/hc/en-us/articles/115015857647
- Conclusion: neither permits an autonomous agent-run account. Services sell through Fleet offer pages; an owner-held
  freelance account is a separate owner decision.

## 4. PayPal (our own checkout) — HIGH

- Webhooks are **per REST app**: "Only events associated with the specific app will be received"
  (https://developer.paypal.com/api/rest/webhooks/). The webhook must be registered on the same Live app whose
  credentials create the orders, subscribed to `CHECKOUT.ORDER.APPROVED` and `PAYMENT.CAPTURE.*`.
- `GET /v2/checkout/orders/{id}` is the documented status read (CREATED, SAVED, APPROVED, VOIDED, COMPLETED,
  PAYER_ACTION_REQUIRED); APPROVED needs `POST …/capture`; fulfil only on a COMPLETED capture.
- Non-delivery causes: listener not on HTTPS 443, firewall, domain flagged. PayPal retries 25 times over 3 days, then
  marks the event Failed; failed events can be resent from the dashboard. Simulator events belong to no app.
- The Fleet now polls open checkouts (v76 status fallback) so a missing webhook no longer strands a paid order; the
  webhook remains the fast path. Diagnosis: `paypal-probe … --events` (read-only) lists the app's webhooks and recent
  webhook events with their delivery status.

## 5. Advertising channels

- **LinkedIn** — bots/unauthorised automation banned (User Agreement §8.2); posting via the official Share API is allowed.
- **Reddit** — self-service API closed Nov 2025 (LOW); bots must not pose as humans; self-promotion judged by Content
  Policy Rule 2 and each subreddit's rules.
- **Pinterest** — the end user must choose each Pin; trial apps' Pins visible only to their creator.
- **YouTube** — disclose realistic synthetic media (`status.containsSyntheticMedia`); mass AI churn is spam.
- **Instagram** — API publishing needs a professional account + Advanced Access; rate-limited.
- Implication: advertising is human-paced, truthful, disclosed where required, through accounts recorded in the Fleet
  and visible to the owner; agents measure qualified enquiries and conversions, not post counts.
