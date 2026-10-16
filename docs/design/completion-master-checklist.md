# Master completion checklist (one list for all packages; updated 2026-10-16 evening)

**Packages:**
- **P0:** bbfb24a, frozen. Recovery, consent, helper jobs, capability guidance v8.
- **P1:** mobile access, phone push, monitoring, backup and recovery.
- **P2:** multi-location treasury and the bank/card integration.
- **P3:** agent capabilities.

**State words:** built · installed · connected · enabled · live-proven. Nothing is called launch-ready because it compiles or
passes against a simulated provider.

**Connections between packages** (checked so the releases are not disconnected parts):
- P1's alerts carry P2's provider failures (`OPS_PAYMENT_ATTENTION`, later per bank rail) and P3's capability requests.
- P1's backup covers the state P2 and P3 add (new tables are in the database dump).
- P3's capability check reads P1/P2 states (money-out, channels) so agents never quote what cannot be delivered or refunded.

## 1. Completed and evidenced (in the repository; NOT deployed)

| Item | Package | Evidence |
|---|---|---|
| Sign-in recovery, host recovery ends old access, buyer consent on own routes, helper purposes, capability guidance v8 | P0 | release-bbfb24a.md; rehearsals passed 16:46:39Z / 17:16:53Z |
| **Mobile defect found and fixed:** an app switch fired about 48 reads at once and tripped the edge limit (903 refusals in the edge log). Now one paced refresh with busy-retry. Compact header on phones | P1 (UI 0.21.1) | `fleet-mobile-dashboard-e2e-pg` (emulated iPhone: sign-in, deck, app-switch replay, 10 admin pages, phone alerts), `fleet-codex-client-busy` |
| Edge: 429 + Retry-After, a separate static-file allowance, refusals logged with the real client address | P1 | `deploy/nginx/automaton-fleet-edge.conf`; nginx -t syntax ok on the server (temp copy) |
| Phone push (v83): devices, a queue per notification and device, severity, retries and backoff, rate limit, permanent failure, alarm cancel on acknowledge, test plus "I received it", lock-screen-safe content, own role and unit | P1 | `fleet-v83-push-pg` (simulated Pushover) |
| Hourly operations watch: health FAIL → RED, payment trouble → AMBER, overdue paid order → RED, low AI credit → AMBER; once a day | P1 | `fleet-v83-push-pg` (AI credit, degraded rail); `fleet-v76-market-fulfilment-pg` (a paid service order 6 days past capture with a 5-day turnaround → one RED `ORDER_OVERDUE`) |
| Heartbeat to the outside monitor; `OnFailure` drop-in | P1 | `fleet-backup-heartbeat` (fake monitor) |
| Encrypted off-site backups (restic): init / run / drill; key material excluded; failures reach the monitor | P1 | `fleet-backup-heartbeat` (real restic 0.17.3 + PostgreSQL) |
| Capability guidance v9 (no bare .pptx promise) | P1 | `fleet-v67-foundation-pg` assertion |
| Research: push, monitoring and backup providers; UK bank/card providers; workflow → capability map | P1/P2/P3 | `docs/operations/*`, `bank-debit-card-requirements.md` §8, `agent-capability-map-2026-10-16.md` |
| Pushover limits documented (retry every 72 s, expiry 1 h; Pushover allows at most 3 h and 50 repeats); an alarm that expired unanswered, a failed push or one waiting > 15 min stays listed as **unresolved** until acknowledged (v84) | P1 follow-up (751e0c8) | `fleet-v83-push-pg` (v84 cases); `monitoring-and-alerts.md` |
| Recovery drill restores sample workspace / product files (up to 40, checksummed) as well as schema and ledger; separate key-recovery procedure (which secret restores what, where each copy lives) | P1 follow-up (751e0c8) | `fleet-backup-heartbeat` (real restic); `backup-and-recovery.md` key table |
| 3-D Secure statement corrected: frictionless / supported recurring / challenge that needs you — never bypassed; bank comparison against the full autonomous-spending and reconciliation workflow, conditional on seller eligibility | P2 research (751e0c8) | `bank-debit-card-requirements.md` §8.1, §8.2 |
| **P3 core (v85, runtime founder-v10):** justified capability requests (reason, evidence, what it holds up, urgency); .pptx as a real deliverable (inspector fleet-qa-2: structure, alt text, overflow, placeholders, rendering + OCR when installed; EPUB checks); toolchain agent-tools-2 (matplotlib, EPUB, OCR bindings); media gateway with Brave Search and OpenAI Images adapters, per-agent daily caps; Capabilities panel | P3 (57d41b4) | `fleet-v85-capabilities-pg`, `fleet-v85-founder-tools`, `fleet-qa-inspector-v2`, `fleet-qa-inspector` (simulated providers; real renderer / OCR binaries not installed) |
| **Capability checks name the work (v87):** publishing an offer or quoting an enquiry needs a check, in 7 days, that NAMES it, finds every deliverable (format + needs: search, images, render, OCR, refunds, card, mailbox) ready against the runtime's own probe, covers the offer's files, and whose fingerprint (the Fleet's states + the agent's runtime commit) still matches. A generic check, a stale one, or one taken before a provider dropped or the runtime changed is refused | P3 (v87) | `fleet-v87-media-capabilities-pg` (generic refused, uncovered PDF, render missing, library missing, provider dropped, runtime changed, > 7 days); `fleet-v85-founder-tools` (runtime passes target + deliverables) |
| **Paid media (v87):** the requesting agent pays: the most a job can cost is reserved first (no cash → no job; no cost limit → no job); settled once at its ACTUAL cost (image tokens at the owner's prices / a search's flat price / the limit, labelled), rest returned, owed to the owner (provider on the owner's card, like AI credit); beyond the limit a Fleet expense + alert; provider error releases it; gateway stopped → cost UNKNOWN, reservation kept until the owner resolves it; provider statements post the difference; mission work names the mission (its beneficiaries pay at its end, v35) | P3 (v87) | `fleet-v87-media-capabilities-pg`, `fleet-v85-capabilities-pg` |
| **P2 (v86, corrected):** money locations in one ledger; transfers are the same money and complete only on evidence they are THAT transfer (reference in the bank line, or PayPal's withdrawal record + the bank line naming PayPal; never an equal amount alone — negative case tested); owner deposit = owner funding once; stale = nothing spendable; debit mode (hold fits the bank under lock; declaration books nothing; bank settlement books, no card payable); a used hold with no bank record after 7 days is OVERDUE (still reserved, alerted), released only on the bank's evidence or your stated check, and a late charge is still booked (never spendable twice); disputes; full refunds; venture on each charge; whole-treasury reconciliation (incomplete while any location is stale); 3-D Secure challenge → RED alert (founder-v10 only); statement import; **bank feed service** (unit + setup script; read-only tokens only; Starling host only) | P2 (c0998ce + 11c3456) | `fleet-v86-locations-pg`, `fleet-v86-bankfeed-service-pg`, `fleet-bank-statement`, `fleet-location-feed`; regressions in `bank-debit-card-requirements.md` §9 |
| **Defect found in frozen P1:** the push (and media) unit would not run when installed (its own credentials directory refused; a missing key file fails the unit). Fixed with `SetCredential=` fallbacks; regression test | P1 fix (11c3456) | `release-f47ee1c.md` §6; `fleet-location-feed` › systemd credentials |
| **v88: money that has left is always on the books.** A bank line is recorded even when booking fails (kept with its error, alerted, retried; statement imports row by row). An unfunded card charge (debit or owner card) is the agent's debt plus a visible negative shortfall, filled first by later money (repayments, funding, refunds); the agent's card is frozen meanwhile. On death the debt is written off and any shortfall stays visible. Media overruns are the agent's (cash, then debt) | P2 / P3 (fleet/final-v2.5) | `fleet-v88-shortfall-pg` (the reproduced 05cbe4e rejection, replay, freeze / thaw, funding, refund, estate, forced booking failure + retry, owner-card path), `fleet-v87-media-capabilities-pg` |
| **v89: software maintenance on demonstrated scope.** Customer consent on their own page (exact repository; wording kept). Scoped access through the Fleet GitHub App (one repository per token, only the permissions needed; a new fleet/ branch + pull request only). An isolated build environment (no credentials; Landlock sandbox with one port, the registry-only egress proxy). PR-only recovery after a passing build of exactly that patch. Quoting needs active access + a passing baseline for THAT enquiry. Guidance corrected | P3 (fleet/final-v2.5) | `fleet-v89-code-maintenance-pg` (simulated GitHub, real sandboxed builds), `fleet-v89-code-units`, `fleet-v89-public-repo-consent`, runtime tool in `fleet-v85-founder-tools` |
| **v90: several cards, reversed chargebacks, PayPal limitation, unit economics.** Up to three card slots (credit, or debit on its own bank; priority; the browser fills the hold's card). A provisional dispute credit taken back puts the charge up again. PayPal's own failure codes about our account mark the PayPal location limited. AI cost per order / venture comes from the calls that acted on it, with support burden | P2 / P3 (fleet/final-v2.5) | `fleet-v90-cards-reversals-economics-pg`, `fleet-identity-autonomy-pg` (slot-2 fill) |
| **Defect found in the credentials fix:** an empty `SetCredential=` is invalid systemd syntax, so the 05cbe4e push / media units still exit 243 without keys. Fixed with a non-empty placeholder, checked with `systemd-analyze verify` | P1 fix (fleet/final-v2.5) | `fleet-location-feed` › systemd credentials; release-f47ee1c.md §6 |

## 2. Implementation remaining

**P1:**
- frozen as f47ee1c, rehearsals passed (release-f47ee1c.md);
- its push unit needs the fix in the next package (§1);
- open item: a dedicated PayPal limitation alert (PayPal gives no API signal today).

**Implementation gaps:** none known in the planned scope after `fleet/final-v2.5` (v88 – v90). Limits that stay by design:
- AI-cost attribution starts with v90's records (earlier calls are general);
- the PayPal limitation signal works from PayPal's failure codes, because PayPal has no limitation API;
- builds can use only the toolchains the host provides (python3 today).

**Host installation (each your go; sudo):**
1. The release (81 → 90 + UI 0.22.0).
2. Agent toolchain agent-tools-2, then Agent-1's runtime upgrade (paused).
3. Edge file.
4. Push.
5. Heartbeat and `OnFailure`.
6. Backups (restic).
7. Bank feed.
8. Media gateway.
9. Code gateway, build environment and egress proxy (`fleet-code-setup.sh`).
10. Office renderer and OCR (`fleet-office-tools-setup.sh`).
11. Optional: `nodejs` for JavaScript builds.

**Provider onboarding (your accounts):**
- Pushover;
- Healthchecks.io and UptimeRobot;
- Backblaze B2 and the restic escrow password;
- the bank account (subject to seller eligibility), its read-only token and who approves 3-D Secure;
- Brave Search and OpenAI Images, with their cost settings;
- the Fleet GitHub App (id, slug, private key);
- the legal seller and public site;
- money out (custody execution), for refunds.

## 3. Your setup and provider choices (only the indispensable ones)

| Choice | Recommendation | Cost |
|---|---|---|
| Phone push | Pushover (account + app; app token and user key) | $4.99 once per platform |
| Outside monitor | Healthchecks.io (heartbeat and backup checks) + UptimeRobot (HTTPS check), both to Pushover | free (UptimeRobot's free tier: check its terms for your use) |
| Off-site backup | Backblaze B2, EU, Object Lock 30 days, bucket-scoped key; you keep the restic password offline | pennies a month at this size |
| Bank/card rail | Conditional on seller eligibility: Starling sole-trader account first (read-only API; 3DS in your app); a limited company only if you later want Revolut / Airwallex (`bank-debit-card-requirements.md` §8.2) | £0 a month |
| Web search / images (optional) | Brave Search API; OpenAI Images (`docs/operations/media-providers.md`) | Brave $5 per 1,000 searches ($5 free monthly); images priced per token |
| Your phone | which phone and OS version (the live bundle needs iOS Safari 16.4+) | — |

Media cost settings once a provider is chosen:
- `FLEET_MEDIA_SEARCH_COST_CENTS`;
- `FLEET_MEDIA_IMAGE_COST_CENTS` (the per-image limit);
- `FLEET_MEDIA_IMAGE_TOKEN_PRICES`.

Also needed:
- each deploy and host installation (sudo);
- the bank account's ledger ownership (R8);
- float size;
- who approves 3DS.

## 4. Live proof remaining (nothing is live-proven yet)

1. **Phone:** the dashboard opened and used on your actual phone after the 0.21.1 deploy. Emulation passed, which is not a
   real-device test.
2. **Push:** a test pressed "I received it" on your phone. Then a real alert that rang and was cancelled by acknowledgement.
3. **Outside monitor:** the heartbeat stopped for 15 minutes rings your phone; a failed unit is reported.
4. **Backup:** a production backup and a production drill. Later, a full rebuild rehearsed on a disposable VM.
5. **Agent-1 controlled proof** (Agent-2 stays paused):
   1. preparation: research → product → inspection and review → private offer;
   2. purchase: your proof purchase, at most £50, with consent recorded;
   3. delivery;
   4. support message and revision;
   5. refund (needs PayPal money-out).
6. **Spending, separately:** an amount and purpose you name in advance; reconciled to provider evidence.
7. **Bank rail** (after P2):
   - a funding transfer matched on evidence;
   - one purchase with 3DS;
   - one decline;
   - one refund;
   - the whole treasury reconciled with zero drift.

   With statement imports only, card spending is **not autonomous**: purchases book when you import. Live autonomy needs
   the bank feed connected.
8. **Paid media:** one real search and one real image charged at their actual cost, then a provider statement that
   reconciles to zero.
9. **Software maintenance:** one of your own repositories as the "customer":
   - consent and install the app;
   - snapshot;
   - a failing, then passing build;
   - a pull request you review and close;
   - access ended by uninstalling.
10. **Card slots:** a second card filled on a real checkout under its own hold (with the bank rail, item 7).

## 5. Next releasable package

**P1 is frozen as f47ee1c** (UI 0.21.1 + schema v83 + host files: the mobile fix, phone push, the operations watch,
heartbeat and `OnFailure`, backup / drill, the edge change, capability guidance v9). Rehearsals passed 18:28:59Z /
19:16:57Z, valid until **2026-10-17 18:28Z**. It deploys after bbfb24a, or with it as one 81 → 83 cutover (your choice).

**bbfb24a (P0) stays frozen and ready.** Its rehearsals are valid until **2026-10-17 16:46Z** (production unchanged since:
a712be1, schema 81).

**05cbe4e (v84 – v87) is frozen and rehearsed, but must NOT be deployed as the money-handling release** (the shortfall
blocker; release-05cbe4e.md §5).

**Next to freeze: `fleet/final-v2.5` (v84 – v90 + UI 0.22.0):**
- **Contents:** everything in 05cbe4e, plus the shortfall fix, agent-attributed media, software maintenance on
  demonstrated scope, several cards, reversed chargebacks, the PayPal limitation signal, unit economics and the systemd
  credential fixes.
- **Then:** its own rehearsals (81 → 90).
- **Still separate:** the host installations and every live proof. Nothing is connected or funded by deploying it.
