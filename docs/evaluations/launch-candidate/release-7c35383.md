# Release 7c35383 — schema 78 → 80 (v79 business operator + v80 acquisition channels) · CANDIDATE, VPS-prepared, not deployed
`96016c9` (release-96016c9.md, schema 79) stays the prepared package, unchanged. This candidate applies v79 **and** v80 from production's schema 78. It can also follow 96016c9 (79 → 80).

**Production now:**
- 31ffef8, schema 78, UI 0.19.0.
- Agent-1 and Agent-2 paused on b60e262.
- Seller not set; no public site; sales closed.
- Custody inactive; real payments off; survival protection on; sizing `fixed`; no launch boundary.

Nothing here is authorised by this record.

## Identity and evidence
```
FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
FLEET_RUNTIME_COMMIT=7c353831a4a7fa336fc660d5e47859ad52365e63
FLEET_RUNTIME_BUILD_ID=c44e873e1c0dba4e314e774b2357c7bc79692548dc0221e3ed341061bda5dfe5
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
```
- VPS `~/rlc80/pins.txt` = the independent local build. UI 0.19.0 `890f7b07…244e`, reused.
- **Data rehearsal 78 → 80: PASSED** 16:40:14Z:
  - wouldApply [79, 80];
  - reconciliation OK: 812 journals; 3038 events preserved;
  - the ledger verifies;
  - a re-run is a no-op;
  - the rollback dump restores 78 with the same ledger head.
- **Services + rollback rehearsal: PASSED** 16:54:04Z:
  - 31ffef8 refuses schema 80;
  - the candidate controller, Operator API and dashboard are ready on 80;
  - Fleet Command and history are clean (0 copies);
  - the ledger head is unchanged;
  - rollback restores 78.
- **Valid until** 2026-10-16 16:40Z.
- **Tests** (affected; unchanged evidence reused):
  - v80 channels 7/7 (fake Etsy / Pinterest);
  - discovery units 3/3;
  - browser 12/12 (real Chrome: scoped release + account continuity + four interface kinds);
  - v79 8/8;
  - v76 market, v67, v78;
  - 15 suites that exercise outward operations, now on a launched test registry;
  - routing 25/25 and the units;
  - migration paths;
  - founder upgrade b60e262 → 7c35383: 11/11 (1 skipped);
  - tsc clean.
- **Not exercised against the real providers:** Etsy, Pinterest and IndexNow calls are fake-tested only. The first live call verifies the Etsy payout ledger-entry type, the token-scopes response and Pinterest's account field.

## What changed since 96016c9
1. **A release is a specific, expiring authorisation of external actions:**
   - It names its actions, accounts, origins, mail recipients and channels / API operations, and lasts at most 72 h. Spending is never part of a release.
   - **Anything the agent publishes within it is public at once.** Closed sales keep only the Fleet's own offer pages private.
   - Enforced by the dispatcher and by the browser worker (outward steps only on the released origins).
2. **Search discovery** of the own offer pages: sitemap and robots (sales open only), structured data, and IndexNow notifications from the channel gateway.
3. **The channel gateway:** official APIs on owner-connected accounts.
   - **Etsy:** the owner's shop. Draft → image → file → activate; receipts become sale memos; payouts become claims on the bank evidence chain; AI disclosure added.
   - **Pinterest:** the owner's business account. Boards and Pins.
   - The exact account and scopes are checked before any job runs.
4. **Corrected platform findings:**
   - Findings from secondary sources are marked provisional.
   - Human-owned accounts using permitted AI assistance are distinguished from automated operation.
   - Silence in a platform's terms is not permission.
   - The smallest practical channel set: own pages + discovery, Etsy, Pinterest, B2B email (`docs/marketplaces/acquisition-channels-2026-10-15.md`).

## Consolidated package (each step needs the authorisation named)

### 1. Deploy (your go)
Either 96016c9 first (79), then this, or this alone:

`bash ~/rlc80/fleet-release.sh ~/rlc80/pins.txt 78 80 0.19.0 ~/rlc80/ui-0.19.0-7c35383.tgz 890f7b078ca2106dbb6151126716162113a72ed7d60ea7f9c44d32b6af7b244e`

- Agents stay paused; everyone is held.
- Rollback before live money: `bash ~/rlc80/fleet-rollout.sh revert ~/rlc80/pins.txt 78 80 <reason>`.

### 2. Host installation (sudo; your go), before any real browsing or API publishing
1. **Browser network isolation:**
   1. `sudo bash ~/rlc80/fleet-browser-isolation.sh plan`
   2. `… apply`
   3. `… verify` (must print `ISOLATION VERIFIED`).
2. **Channel gateway** (staged as `~/rlc80/fleet-channels-setup.sh`; the unit is under `~/rlc80/deploy/`):
   1. `sudo bash ~/rlc80/fleet-channels-setup.sh install` (plan).
   2. `… install --apply`. This creates the OS user, the `fleet_channels` role (chx_* only), `channels.env` (socket URL), one `pg_hba` line (reload only), the grant and audit, and the unit (no loopback, no private ranges).
   - `… check` afterwards.
3. **Agent toolchain** (decks): `fleet-agent-tools.sh install` / `verify` and the `current` link (lock a2d5c9f11557).

### 3. Your inputs and onboarding (no money; no publishing)
1. `economy-seller-set '<json>'`, then `economy-public-site https://api.agentfleet.vip`. Sales stay closed.
2. **Etsy** (when you choose):
   1. Open the shop and pass Etsy's identity check (ID + selfie: yours).
   2. Create an Etsy app for your own shop.
   3. Register the redirect `https://api.agentfleet.vip/oauth/callback`.
   4. As the gateway user, run `node dist/fleet/channels/main.js oauth-url etsy <keystring> <redirect>`.
   5. Approve in the browser.
   6. Run `oauth-exchange etsy vault:etsy/<name>`. Its stdin is `{clientId, clientSecret, code, state, redirectUri}`, taken from the callback page.
   7. Run `economy-channel-connect <agent's Etsy channelId> etsy vault:etsy/<name> <userId> <shopId>`.
   - The agent must first have recorded the channel with Etsy's rules.
3. **Pinterest:**
   1. A business account and a developer app (Trial access first).
   2. The same `oauth-url` / `oauth-exchange` / `economy-channel-connect` steps.
   3. Standard access (your video submission) makes Pins public.
4. **Optional:** verify the domain in Google Search Console / Bing Webmaster Tools.

### 4. Controlled proof (Agent-1 only; Agent-2 stays paused; stop when verified, on failure, or at 48 h)
- **P1. Preparation under the hold** (your word to upgrade and resume Agent-1):
  - `upgrade-rehearsal` / `upgrade-preflight` / `upgrade-runtime` for 01M3F50SH7PNX2E3GST13J52AS, then `founder-cognition … resume`.
  - The agent researches, records its venture and channels (with rules), builds, renders and reviews, and publishes privately. Nothing outward happens.
- **P2. Named external actions** (your explicit authorisation, written as the scope). For example, one Etsy listing:

  `economy-outward 01M3F50SH7PNX2E3GST13J52AS release '{"actions":["channel_api"],"channels":["<Etsy channelId>"],"apiOps":["etsy.listing.create","etsy.listing.image","etsy.listing.file","etsy.listing.activate"],"expiresHours":24}' "proof: one Etsy listing"`

  Activation is public at once on Etsy. For a Pin, name the Pinterest channel and `pinterest.pin.create`. For outreach, `"actions":["mail"],"mailTo":[…]`. End with `economy-outward … hold`. No spending.
- **P3. Payment proof:** `economy-offer-proof <slug>`, pay, receive, refund (you pay).

### 5. Final activation (one session; release-12c9f67.md §E)
1. Custody signer.
2. `REAL_PAYMENTS_ENABLED=true` in custody.env only.
3. `economy-custody-activate`.
4. Card and identity authority.
5. Capital policy contextual.
6. Sweeps on.
7. Launch boundary.
8. Protection off.
9. `economy-sales open`.
10. Resume Agent-1.

Agent-2 stays paused.

### Decisions for you
- **Which channels to onboard first.** Recommended: own pages + email at once; Etsy next; Pinterest after Standard access.
- **Gumroad's £500 unlock.**
- **Paid providers:** image generation and a web-search API (not added).
- **Others not in the set:** LinkedIn, X, Meta and Reddit, each needing its own approval or plan.
