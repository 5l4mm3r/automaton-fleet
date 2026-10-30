# External operations: where we are and the route to the goal

Written 2026-10-30. Branch `fleet/external-ops` (uncommitted, not deployed). Scope: an agent running a real business on outside channels, with the Fleet site only as the owner's control room.

## The goal, as a test

An agent finds an offer with real demand, sells it on an outside channel under its own brand, delivers it, answers and refunds buyers, and the money reaches a location the books can see. It repeats this at a net profit without the owner briefing or unblocking it. Test orders never count as demand.

## What is proven, and how

| Capability | Evidence level |
|---|---|
| Fleet's own checkout, delivery and refund | Real money (£1, £5, refund), on earlier versions |
| Treasury Watch (v123) | Tests on a fake provider; one code confirmed by a real row. Built and side-installed, **not installed** |
| Etsy and Pinterest API jobs, listing gate | Fake servers only. **Never run against a real account** |
| External orders (v124, new) | Local PostgreSQL tests only. Records only; moves no money |
| Browser accounts and channel gateway | Local tests only |
| External sale, delivery, buyer contact, payout | **Never happened.** Production has had no channels, connections or real external orders |
| Agent earning without help | **Never happened** |

## The route, worked back from the goal

| # | Step | Needs | Who |
|---|---|---|---|
| 7 | Repeat sales at a net profit, unattended | Everything below | Agent |
| 6 | First real external sale, delivered, and its payout traced to a known location | Steps 1-5 | Agent, then watch |
| 5 | One live listing on one channel | Scoped release naming the channel and ops | Owner approves |
| 4 | Offer chosen on evidence | Agent-1's proposal; research is incomplete | Agent, owner decides |
| 3 | One channel account, with its payout route checked | Identity and terms are the owner's; a person must read the terms | Owner |
| 2 | Money safety | Backed-spending decisions A, B, C; Treasury Watch installed; payout rows linked before money out | Owner decides, engineer builds |
| 1 | Release with v123 + v124, agents upgraded | Group A approval; v124 tools reach agents only with a runtime upgrade | Owner approves |
| 0 | Decide research: check sources, or stop | Further Agent-1 run needs more free credit | Owner |

**Channel recommendation: Payhip first, once a person confirms its terms.** It pays through PayPal directly, which fits having no bank account. Our only reading of its terms is dated 2018, so this is unverified.
Etsy pays out to a bank on our 15 Oct reading, which conflicts with having none. Fiverr and Upwork allow one verified human per account. Gumroad stays deferred until a wallet reaches £500. Lemon Squeezy needs government ID, and UK eligibility is unconfirmed.
Etsy, Fiverr and Upwork pages refused automated fetch, so these readings must not be treated as current.

## Built in this pass

- **v124 external orders:** a sale made elsewhere becomes a tracked order (received, in progress, delivered, refund needed, refunded, cancelled), opened by the agent or by a provider sale.
- **Agent tools:** `external_orders`, `open_external_order`, `update_external_order`, `deliver_external_order`, `refund_external_order`.
- **Buyer text** is labelled as data, not instructions. A refund the agent cannot complete alerts the owner.
- **Non-GBP channel payouts** raise an alert and are not booked.
- **Etsy receipts** carry a buyer reference and order brief, never a name or address.
- **Stale tests repaired** (v80 channels, storefront, research) through the real publish route, with a new assertion that a changed channel forces a fresh capability check.

## Not built, and why

| Gap | Why it waits |
|---|---|
| Delivery, messaging and refund through a channel's API | Differs per channel; pick the channel first. Browser route exists but is unproven |
| Connectors (`identity/main.ts:200` is empty), image generation, GitHub App | Each needs an owner account or credential |
| Etsy fee recording, physical or non-download listings | Only if Etsy is chosen |
| Backed-spending gate and breaker repair | Economic policy; needs the owner's decision first |
| Linking payout rows in Treasury Watch | Needed before money out, which is off |
| Solving CAPTCHAs | Not planned; detection stays and a person takes over |

## Tools that would help (none installed, none verified)

| Tool | Use | Note |
|---|---|---|
| External uptime check (for example Healthchecks.io) | Alert if the controller dies, since its own alerts die with it | Small, independent of the VPS |
| An image generation API | Listing images | Needs a key and a cost limit |
| Channel's own official API or webhooks | Sales without browser work | Check per channel |
| Claude Code `/security-review`, `/code-review` | On v124 before release | Available now |

More plugins would not move the goal: the blockers are a chosen offer, a real account and a payout route.
