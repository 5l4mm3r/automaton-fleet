# Release 96016c9 — schema 78 → 79 (the autonomous business operator) · CANDIDATE, VPS-prepared, not deployed
Supersedes the f98e347 candidate (release-f98e347.md). Same schema number: v79 was never deployed, and it now carries the five closing points below.

**Production now:**
- 31ffef8, schema 78, UI 0.19.0.
- Agent-1 and Agent-2 paused on b60e262.
- Seller not set; no public site; sales closed.
- Custody inactive; real payments off; survival protection on; sizing `fixed`; no launch boundary.

Nothing here is authorised by this record.

## Identity and evidence
```
FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
FLEET_RUNTIME_COMMIT=96016c9cb0090e210cb46d543058f7a34015cc01
FLEET_RUNTIME_BUILD_ID=5464d83ce28560c91b6de92d157870ed8e802e4011dd95ad262a1f40e8c29390
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
```
- VPS `~/rlc79b/pins.txt` = the independent local build. UI 0.19.0 `890f7b07…244e`, reused.
- **Data rehearsal 78 → 79: PASSED** 15:40:47Z (`~/rlc79b/rehearse.log`):
  - wouldApply [79];
  - reconciliation OK: 812 journals; 3042 events preserved;
  - the ledger verifies;
  - a re-run is a no-op;
  - the rollback dump restores 78 with the same ledger head.
- **Services + rollback rehearsal: PASSED** 15:53:57Z (`upgrade-rehearsal.log`):
  - 31ffef8 refuses schema 79;
  - the candidate controller, Operator API and dashboard are ready on 79;
  - Fleet Command and history are clean (0 copies);
  - the ledger head is unchanged;
  - rollback restores 78 and 31ffef8.
- **Valid until** 2026-10-16 15:40Z.

**Tests** (affected only). Earlier passing evidence for parts that did not change since f98e347 (vision, public pages, custody worker) is reused.

| Suite | Result |
|---|---|
| v79 business operator (hold default, channels, attribution, leads / obligations, outreach, payout evidence chain) | 8/8 |
| Browser, real Chrome (four interface kinds + account continuity) | 11/11 |
| v76 market + v67 foundation | 21/21 |
| 15 PostgreSQL suites that exercise outward operations (they now release their founders through the owner's command) | 139/139 |
| Units (vision / tools, founder tools, public pages, static audit) | 19/19 |
| Founder upgrade b60e262 → 96016c9 + migration paths | 13/13 (1 skipped: specific to an older base) |
| Isolation script `selftest` | passed |
| tsc | clean |

## The five closing points

| # | Point | What changed | Evidence |
|---|---|---|---|
| 1 | Restricted by default | Outward actions are held whenever sales are closed, with or without a public site (v76 held them only once a site was set). Exits are yours: open sales, or `economy-outward <agentId> release <why>` for a controlled proof (nothing public); `hold` ends it. Under the hold the agent still reads and renders in the browser, researches, builds, reviews, publishes privately, keeps its records and fulfils orders, including your proof purchase. | v79 test "preparation hold is the default"; spec §32.5 |
| 2 | Platform coverage qualified | The claim is now "general browser capabilities tested on representative interfaces". Each platform's own terms were checked for permitted assistance, account ownership and automated operation (`docs/marketplaces/channel-rules-2026-10-15.md`): **LinkedIn and X prohibit scripted operation**; Instagram / Facebook, Pinterest and Etsy restrict automation to their APIs (none built); Etsy and LinkedIn need you as the identified account holder (Etsy: ID + selfie); Gumtree bars scraping, and its terms are silent on automated posting; Fiverr / Upwork are closed. There the agent prepares content for you or picks another channel. Library, Charter v8 and Field Guide updated. | spec §32.6 |
| 3 | Account continuity | A browser session is temporary; the account is durable (records + vault credentials). After a worker restart the agent opens a new session and logs in from the vault: password + authenticator code (key captured at setup), or an emailed one-time code; it never sees either. Human-only: CAPTCHAs and new-device challenges, live ID / selfie checks, passkeys / security keys, app push approvals, SMS codes, QR-only authenticator keys. Persistent cookies are not built (every session logs in again). | browser test "account continuity" (real Chrome); spec §32.7 |
| 4 | Payout evidence | Marketplace payout reference (unique per channel) → your bank statement line (unique; equal to the payout) → your treasury transfer (one PayPal credit = exactly the payouts it carries). Each payout's revenue posts once; the credit is attributed once and can never also back capital. Payouts paid into the treasury PayPal keep the automatic, unambiguous match. | v79 payout test; spec §32.8 |
| 5 | Browser network isolation | `scripts/fleet-browser-isolation.sh` + drop-in `20-no-loopback.conf`: PostgreSQL over its existing unix socket (one `pg_hba` line + reload, no PostgreSQL restart), loopback denied to the whole unit. Focused verification probes every loopback service on v4 / v6 under the unit's own policy. Must run before any real browsing. | `selftest` + local probe run; host evidence comes from `apply` / `verify` (needs your go) |

## One consolidated package (each step needs the authorisation named)

### 1. Deploy v79 (your go to deploy)
`bash ~/rlc79b/fleet-release.sh ~/rlc79b/pins.txt 78 79 0.19.0 ~/rlc79b/ui-0.19.0-96016c9.tgz 890f7b078ca2106dbb6151126716162113a72ed7d60ea7f9c44d32b6af7b244e`
- The agents stay paused and the hold now applies to everyone.
- Rollback before live money: `bash ~/rlc79b/fleet-rollout.sh revert ~/rlc79b/pins.txt 78 79 <reason>`.

### 2. Host installation (sudo; your go), in this order, before any real browsing
1. **Browser network isolation** (`~/rlc79b/fleet-browser-isolation.sh`; the drop-in is staged beside it under `deploy/`):
   1. `sudo bash ~/rlc79b/fleet-browser-isolation.sh plan` (read-only).
   2. `sudo bash ~/rlc79b/fleet-browser-isolation.sh apply`. It backs up, adds the `pg_hba` line, reloads, runs a socket probe, switches `browser.env`, installs the drop-in, restarts the browser unit, then verifies.
   3. `sudo bash ~/rlc79b/fleet-browser-isolation.sh verify`. It must print `== ISOLATION VERIFIED`: effective policy allows no address and denies `127.0.0.0/8` and `::1/128`; no loopback port open (5432, 6379, 8443, 8787, 8788, 8790; v4 and v6); public internet OK; `bx_ping` over the socket; the worker's Chromium self-test after the restart.
   - Rollback: `… rollback`.
2. **Agent toolchain** (decks):
   1. `P=$(scripts/fleet-agent-tools.sh prefix)`. This gives `/usr/local/lib/automaton-fleet-tools/a2d5c9f11557`.
   2. `sudo scripts/fleet-agent-tools.sh install "$P"`
   3. `sudo … verify "$P"`
   4. `sudo ln -sfn "$P" /usr/local/lib/automaton-fleet-tools/current`
   - The old prefix is the rollback.

### 3. Your inputs (no money)
- `economy-seller-set '<json>'`, then `economy-public-site https://api.agentfleet.vip`. Sales stay closed.
- The PayPal webhook delivery log.
- Later, only for launch: card and identity seals; AI credit auto-reload.

### 4. Controlled proof (Agent-1 only; Agent-2 stays paused; stop when verified, on any failure, or at 48 h; re-pause)
- **P1. Preparation under the hold** (your word to upgrade and resume Agent-1):
  1. `sudo scripts/fleet-founders.sh upgrade-rehearsal b60e262bf7393e0ea2cca3b491199987f830cb3b`
  2. `upgrade-preflight 01M3F50SH7PNX2E3GST13J52AS`
  3. `upgrade-runtime 01M3F50SH7PNX2E3GST13J52AS`
  4. `founder-cognition 01M3F50SH7PNX2E3GST13J52AS resume "<reason>"`

  Agent-1 researches, records an opportunity with its economics, creates its venture identity and routing address, and records the channels it would use with their rules. It builds the product, renders its graphics and looks at them, then reviews and publishes privately. Nothing outward happens. You inspect with `hub-offers` and `hub-business`.
- **P2. Account creation and posting** (your explicit authorisation of public account creation and posting):
  1. `economy-outward 01M3F50SH7PNX2E3GST13J52AS release "<scope>"`. Sales stay closed.
  2. Agent-1 creates accounts only where the platform's terms permit agent operation; on the restricted platforms it prepares content for you instead.
  3. Afterwards `economy-outward … hold`.
  - No paid advertising and no spending (money-out stays off).
- **P3. Payment proof:** `economy-offer-proof <slug>`, pay, receive, refund. You authorise the payment.

### 5. Final activation (one session; release-12c9f67.md §E)
1. Custody signer.
2. `REAL_PAYMENTS_ENABLED=true` in custody.env only.
3. `economy-custody-activate …`.
4. Card and identity authority.
5. `economy-capital-policy '{"sizing":"contextual"}'`.
6. Sweeps on.
7. Launch boundary.
8. Protection off.
9. `economy-sales open`.
10. Resume Agent-1.

Agent-2 stays paused.

### Decisions for you (flagged, not changed)
- Gumroad's £500 wallet unlock (your decision).
- Whether to build official API integrations for the platforms that permit automation only through them (each needs an account you hold).
- Image generation and a web-search API (paid providers; not added).
