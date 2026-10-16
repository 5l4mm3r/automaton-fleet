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
| **P3 core (v85, runtime founder-v10):** capability check before quoting / publishing (enforced: offer.publish and enquiry.quote need a check in the last 7 days); justified capability requests (reason, evidence, what it holds up, urgency); .pptx as a real deliverable (inspector fleet-qa-2: structure, alt text, overflow, placeholders, rendering + OCR when installed; EPUB checks); toolchain agent-tools-2 (matplotlib, EPUB, OCR bindings); media gateway with Brave Search and OpenAI Images adapters, per-agent daily caps and recorded cost; Capabilities panel | P3 (57d41b4) | `fleet-v85-capabilities-pg`, `fleet-v85-founder-tools`, `fleet-qa-inspector-v2`, `fleet-qa-inspector` (simulated providers; real renderer / OCR binaries not installed) |
| **P2 core (v86):** money locations in one ledger (PayPal + bank); transfers are the same money (no journal; source drops at once, destination on the bank's evidence; plain statement credits match, oldest first); owner deposit into the bank = owner funding once; evidence age (stale = nothing spendable); debit mode: hold fits the bank's free cash under lock, declaration books nothing, bank settlement books with no card payable, decline releases, refund reduces, no evidence in 7 days releases (never booked at maximum); 3-D Secure challenge → RED `CARD_APPROVAL_NEEDED` (founder-v10 only); unexplained lines queue (deposit / fee / explained); hourly alerts for stale, unexplained, drift, negative, limited; statement CSV import (Starling + generic; replays record nothing); read-only Starling adapter (refuses any non-read scope); Money locations panel | P2 (this commit) | `fleet-v86-locations-pg`, `fleet-bank-statement`, `fleet-location-feed`; regressions listed in `bank-debit-card-requirements.md` §9 |

## 2. Implementation remaining

**P1:** frozen as f47ee1c; rehearsals passed (release-f47ee1c.md). Open item: a dedicated PayPal limitation alert (no
PayPal API signal today).

**P2: treasury** — core built in v86 (above). Remaining:
1. The bank feed's service (entry point, unit, setup script) — the adapter exists; nothing runs it yet.
2. A whole-treasury reconciliation: location balances plus transfers in transit against the ledger's treasury cash.
3. Disputes / chargebacks on bank-card charges.
4. Several cards (R9) and per-charge venture attribution.
5. Freezing v86 into a package and rehearsing it (it sits on v85; see §5).

**P3: agent capabilities** — core built in v85 (above). Remaining:
- support-burden and AI-cost attribution per order and venture;
- media cost booked to agent wallets (needs your decision: the same funding question as AI credit; today recorded and
  shown, not booked);
- the software-maintenance prerequisites (scoped repository grant, build sandbox) — assessed in the capability map, not
  built; maintenance is not banned;
- the office renderer and Tesseract binaries on the server (an OS package install: needs your approval), so .pptx / .docx
  rendering and OCR checks run there and not only where installed.

## 3. Your setup and provider choices (only the indispensable ones)

| Choice | Recommendation | Cost |
|---|---|---|
| Phone push | Pushover (account + app; app token and user key) | $4.99 once per platform |
| Outside monitor | Healthchecks.io (heartbeat and backup checks) + UptimeRobot (HTTPS check), both to Pushover | free (UptimeRobot's free tier: check its terms for your use) |
| Off-site backup | Backblaze B2, EU, Object Lock 30 days, bucket-scoped key; you keep the restic password offline | pennies a month at this size |
| Bank/card rail | Conditional on seller eligibility: Starling sole-trader account first (read-only API; 3DS in your app); a limited company only if you later want Revolut / Airwallex (`bank-debit-card-requirements.md` §8.2) | £0 a month |
| Web search / images (optional) | Brave Search API; OpenAI Images (`docs/operations/media-providers.md`) | Brave $5 per 1,000 searches ($5 free monthly); images priced per token |
| Your phone | which phone and OS version (the live bundle needs iOS Safari 16.4+) | — |

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
7. **Bank rail** (after P2): funding transfer matched, one purchase with 3DS, one decline, one refund, reconciliation with
   zero drift.

## 5. Next releasable package

**P1 is frozen as f47ee1c** (UI 0.21.1 + schema v83 + host files: the mobile fix, phone push, the operations watch,
heartbeat and `OnFailure`, backup / drill, the edge change, capability guidance v9). Rehearsals passed 18:28:59Z /
19:16:57Z, valid until **2026-10-17 18:28Z**. It deploys after bbfb24a, or with it as one 81 → 83 cutover (your choice).

**bbfb24a (P0) stays frozen and ready.** Its rehearsals are valid until **2026-10-17 16:46Z** (production unchanged since:
a712be1, schema 81).

**Next to freeze: v84 – v86 (P1 follow-ups, P3 core, P2 core) with UI 0.22.0**, on top of f47ee1c. It carries the agent
runtime founder-v10, so after the controller cutover Agent-1's runtime is upgraded while it stays paused (Agent-2 stays
paused on its current runtime). Before freezing: the remaining P2 item 1 (feed service) can wait for your bank choice; the
package is releasable without it (bank locations then take statement imports only).
