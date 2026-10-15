# Release a712be1 — schema 78 → 81 (v79 business operator + v80 acquisition channels + v81 launch & channels in the dashboard) · ONE APPROVAL PACKAGE, VPS-prepared, not deployed

**This is the one deployment path from production.** Production is at schema 78; this candidate applies v79, v80 and v81 in one release. `7c35383` (release-7c35383.md, the consolidated v79+v80 candidate) and `96016c9` (release-96016c9.md, v79) are preserved unchanged as fallbacks; neither needs to be deployed first.

**Production now (unchanged):**
- 31ffef8, schema 78, UI 0.19.0 (deployed 2026-10-15 13:53Z).
- Agent-1 and Agent-2 paused on b60e262.
- Seller not set; no public site; sales closed.
- Custody inactive; real payments off; survival protection on; sizing `fixed`; no launch boundary.

Nothing here is authorised by this record. Nothing has been deployed, published or resumed.

## What a712be1 adds to 7c35383 (the demonstrated gap)
The seller facts, the public site, channel connections and controlled-proof releases existed only as command-line operations. They now have a dashboard page, **Launch & channels** (UI 0.20.0, schema v81 — v80 is not edited):

| Dashboard path | What it shows / does | Confirmation |
|---|---|---|
| Launch & channels → *Where the launch stands* | Seller set? Public site? Active API connections? Sales open or closed | read |
| → *1 · Legal seller (you)* | Legal form, legal name, trading name, postal address, VAT, company number, registered office; the storefronts the agents created | passkey or password + TOTP step-up |
| → *2 · Public site* | The https origin for offer and order pages (setting it does not open sales) | step-up |
| → *3 · Channel connections* | Every channel an agent recorded: rules recorded, provider account / shop, check status and error, live items, payouts awaiting your bank evidence; **Connect** and **Disconnect**; the host OAuth instructions | Connect: step-up; Disconnect: one click (no step-up; reconnect to undo) |
| → *4 · Controlled-proof releases* | Active and ended releases with scope and expiry; **Release** (scope as JSON, an Etsy-listing example filled in) with the warning *public at once*; **Hold now** | Release: step-up; Hold: plain |
| → *5 · Discovery* | Last IndexNow notification, API jobs in the last 24 h | read |
| → *What stays with you* | The standing external dependencies, worded as below | read |

Not on the page, deliberately:
- **Opening sales.** This is the launch switch, part of final activation (`economy-sales open`).
- **The OAuth exchange.** It runs on the host as the gateway user, so no provider token passes through the dashboard.

## Identity and evidence
```
FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
FLEET_RUNTIME_COMMIT=a712be1f8766da3385c4538c89124453f8c3e159
FLEET_RUNTIME_BUILD_ID=366dabe7067aa798fc7c5ce5f9aa8f7c2d31fd627741c13c1bfebf469b9b07f1
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
UI 0.20.0: ui-0.20.0-a712be1.tgz  sha256 fd05dd6c9c599a87d2edfb423ea032ee0048941f13b6dd824c6cbf8c8d438212  (52 files, LIVE build)
```
- **Builds.** VPS `~/rlc81/pins.txt` equals the independent local build. The UI tarball is a clean-clone reproducible build of a712be1, staged as `~/rlc81/ui-0.20.0-a712be1.tgz` with the same hash.
- **Data rehearsal 78 → 81: PASSED** 2026-10-15 17:42:38Z:
  - wouldApply [79, 80, 81];
  - reconciliation OK: 812 journals; 3036 events preserved;
  - the ledger verifies;
  - a re-run is a no-op;
  - the rollback dump restores 78 with the same ledger head.
- **Services + rollback rehearsal: PASSED** 17:54:09Z:
  - 31ffef8 refuses schema 81;
  - the candidate controller, Operator API and dashboard are ready on 81;
  - Fleet Command and history are clean (0 copies);
  - the ledger head is unchanged; no reservation or birth;
  - rollback restores 78, and 31ffef8 is ready again;
  - production PIDs unchanged.
- **Valid until** 2026-10-16 17:42Z (re-run both rehearsals after that).
- **Tests, new for v81:**
  - v81 PG 4/4: step-up bound to the exact arguments; release / hold; connect / disconnect; once sales are open, API work runs with no release;
  - browser e2e 15/15 in real Chrome with a virtual passkey: the seller saved through the page with a step-up; no CSP violations;
  - UI contract (the UI's sensitive / write op lists = the backend's);
  - dashboard gateway 9/9; v80 channels 7/7; migration paths 2/2;
  - founder upgrade b60e262 → a712be1: 11/11 (1 skipped);
  - tsc (root and UI), eslint, UI simulation test.
- **Reused unchanged from 7c35383** (v81 does not touch these paths): discovery 3/3, browser 12/12, v79 8/8, v76 / v67 / v78, the 15 outward-operation suites, routing 25/25.

## The one deployment path (your go)
```
bash ~/rlc81/fleet-release.sh ~/rlc81/pins.txt 78 81 0.20.0 ~/rlc81/ui-0.20.0-a712be1.tgz fd05dd6c9c599a87d2edfb423ea032ee0048941f13b6dd824c6cbf8c8d438212
```
- One cutover from production's schema 78. Do not deploy 96016c9 or 7c35383 first.
- Agents stay paused. Everyone is held: sales closed, no seller, no site.
- **Rollback**, only before any live money or provider data exists:
  `bash ~/rlc81/fleet-rollout.sh revert ~/rlc81/pins.txt 78 81 <reason>`.
  The UI returns to 0.19.0.
- **After real money or provider data exists: freeze and fix forward.**
  1. `economy-sales closed`
  2. `economy-outward <agentId> hold`
  3. `economy-channel-disconnect <channelId>`
  4. `founder-cognition <id> pause`
  5. Then a corrective release.

---

# A. Scoped preparation proof vs ongoing autonomous operation

| | **Scoped proof** (now → launch) | **Ongoing autonomous operation** (after launch) |
|---|---|---|
| State | Sales closed; preparation hold on | You ran `economy-sales open` at final activation |
| What the agent may do outward | Only what a release names: actions, accounts, origins, mail recipients, channels and API operations; at most 72 h | Everything outward, on any channel it chooses, within each platform's rules: listing, posting, outreach, API jobs on connected accounts |
| Your involvement | You write each release (dashboard *Release*, or `economy-outward … release`). It ends by expiry or *Hold now* | **None per action, none per period.** No release is consulted or needed. Nothing expires and nothing needs renewing in the Fleet |
| Spending | Never part of a release | The normal automated spend review (hold only on credible evidence) |
| Public effect | **Anything published under a release is public at once** on that platform | Public |
| Evidence | v80 7/7, browser 12/12 | v81 test 4: after sales open, `etsy.listing.create` / `activate` queue with no release present |

The only things that recur after launch are the **external** dependencies in section C. They come from the platforms, not from the Fleet.

# B. Onboarding paths (dashboard → Launch & channels; CLI equivalents in brackets)

| Step | Dashboard path | Confirmation | CLI |
|---|---|---|---|
| Legal seller facts | *1 · Legal seller (you)* → Save the seller facts | step-up | `economy-seller-set '<json>'` |
| Public site | *2 · Public site* → Set the public site (`https://api.agentfleet.vip`) | step-up | `economy-public-site <url>` |
| Authorise an API app | *3 · Channel connections* → "How to authorise an app" (host steps, shown on the page) | sudo shell on host | `node dist/fleet/channels/main.js oauth-url …` / `oauth-exchange …` |
| Connect an agent's channel | *3* → Connect a channel's API account (channel, provider, vault name, account, shop) | step-up | `economy-channel-connect <channelId> <etsy\|pinterest> <vault:…> <account> [shopId]` |
| Watch a connection | *3*: status *waiting for check* → *Active* (or *Failed* with the reason) | read | `hub-channel-api` |
| Disconnect | *3* → Disconnect | one click (no step-up) | `economy-channel-disconnect <channelId>` |
| Controlled proof | *4 · Controlled-proof releases* → Release / Hold now | step-up / plain | `economy-outward <agentId> release '<scope>' <note>` / `hold` / `list` |
| Payouts awaiting your bank evidence | *3*: count per channel | — | `economy-channel-payout-bank` / `-transfer` / `-decide` |
| Open sales (launch) | **not on the dashboard** | — | `economy-sales open` (final activation, step E9) |

An agent must first record a channel, with that platform's rules, before it can be connected. The channel IDs appear on the page.

# C. External dependencies, stated plainly

1. **Etsy buyer messages need a person, for as long as Etsy is used.** Etsy has no messaging API, and its terms direct automation to the API, so the Fleet will not automate the Etsy website. Buyers' messages in the Etsy shop must be read and answered by you, or by someone you appoint.
   - The agent can draft replies for you to paste.
   - Digital downloads are delivered by Etsy automatically, so routine orders need no message.
   - On the Fleet's own offer pages and by email, the agent handles buyers itself.
2. **Etsy payouts go to your bank.** Each payout becomes the agent's cash only after you record:
   1. the bank line (`economy-channel-payout-bank`);
   2. the transfer into the treasury PayPal (`-transfer`; several payouts can share one transfer).

   The page counts payouts awaiting you.
3. **API token continuity: provisional.** The gateway refreshes tokens itself.
   - Etsy refresh tokens last 90 days; Pinterest's about a year.
   - If the provider issues a new refresh token on each refresh, nothing recurs. This is verified at the first live refresh.
   - If it does not, the connection fails its check (P2 alert) and you re-authorise once per period.
4. **Pinterest Standard access.** Pins are visible only to their creator until Pinterest approves the app (your video submission).
5. **Identity checks only you can pass:**
   - Etsy's seller verification (ID + selfie);
   - Pinterest business account and developer app;
   - optional Search Console / Bing Webmaster domain verification (a DNS record).

# D. Approval package — each step and the authorisation it needs

### D1. Deploy (your go): the command above.

### D2. Host installation (sudo; your go), before any real browsing or API publishing
1. **Browser network isolation:**
   1. `sudo bash ~/rlc81/fleet-browser-isolation.sh plan`
   2. `… apply`
   3. `… verify`, which must print `ISOLATION VERIFIED`.
2. **Channel gateway:**
   1. `sudo bash ~/rlc81/fleet-channels-setup.sh install` (plan)
   2. `… install --apply` (OS user, `fleet_channels` role with chx_* only, `channels.env`, one `pg_hba` line with reload only, the unit)
   3. `… check`
3. **Agent toolchain:** `fleet-agent-tools.sh install` / `verify` (lock a2d5c9f11557).

### D3. Your onboarding inputs (no money, nothing published): section B
- Seller facts and public site: any time after D1.
- Etsy / Pinterest accounts, apps and connections: when you choose. Recommended order: own pages + email; then Etsy; Pinterest after Standard access.

### D4. Real-provider proofs, separate from everything above
Each needs Agent-1 upgraded and resumed (your word) plus a release you write. Stop when verified, on failure, or at 48 h. Agent-2 stays paused.

| Proof | Needs | Verifies (only provable live) |
|---|---|---|
| P1 Preparation under the hold | `fleet-founders.sh upgrade-rehearsal / upgrade-preflight / upgrade-runtime 01M3F50SH7PNX2E3GST13J52AS` → `founder-cognition … resume` | The agent researches, records venture and channels with rules, builds, and publishes privately. Nothing outward |
| P2a One Etsy listing | Etsy connected (D3) + release `{"actions":["channel_api"],"channels":["<Etsy channelId>"],"apiOps":["etsy.listing.create","etsy.listing.image","etsy.listing.file","etsy.listing.activate"],"expiresHours":24}` | Real Etsy token scopes response shape; listing create → file → activate; AI disclosure; **public at once** |
| P2b One Pin | Pinterest connected + release naming the Pinterest channel and `pinterest.pin.create` | Pinterest account field; Pin creation (private until Standard access) |
| P2c One outreach email | Release `{"actions":["mail"],"mailTo":["<recipient>"],…}` | Lawful outreach with opt-out |
| P3 Payment | `economy-offer-proof <slug>`; you pay, receive, refund | PayPal checkout end to end |
| Later, live only | The first Etsy payout, the first token refresh, the first IndexNow ping after sales open | Etsy ledger `DISBURSE*` mapping; refresh-token rotation; IndexNow acceptance |

### D5. External approvals (third parties: outside the Fleet and outside your control)
- Etsy: shop opening and identity verification; Etsy's review of the API app (time provisional).
- Pinterest: Trial access, then Standard access (video review).
- PayPal: the treasury account and rail (existing; money out still off).
- Optional: search-engine domain verification.

### D6. Final activation and launch (one session; release-12c9f67.md §E, unchanged)
1. Custody signer.
2. `REAL_PAYMENTS_ENABLED=true` in custody.env only.
3. `economy-custody-activate`.
4. Card and identity authority.
5. Capital policy contextual.
6. Sweeps on.
7. Launch boundary.
8. `economy-protection off`.
9. **`economy-sales open`**: from here, operation needs no releases (section A).
10. Resume Agent-1. Agent-2 stays paused.

## Decisions for you
- **Go for D1.** Valid until 2026-10-16 17:42Z.
- Which channels to onboard first.
- Paid providers (image generation, web-search API): not added.
- Channels outside the set (LinkedIn, X, Meta, Reddit): each needs its own approval or plan.
- Gumroad's £500 unlock.

