# Master completion checklist (one list for all packages; updated 2026-10-16)

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

## 2. Implementation remaining

**P1 (finish before freezing):**
- a dedicated PayPal limitation alert (no PayPal API signal today);
- rehearse the release.

**P2: treasury (provider-independent first, simulated adapter labelled as such):**
1. Money locations in one ledger: a bank-account rail, a bank cash asset and an in-transit account. A PayPal ↔ bank transfer
   moves the same money and never creates capital or revenue.
2. Balance observations with their age; stale or unverified balances are never spendable; a P1 alert on drift.
3. Account-level reservation before a card hold (bank balance − open holds − unsettled), under a lock, plus a per-location
   check so a PayPal hold blocks only PayPal-paid actions.
4. Charge lifecycle: authorised / settled / declined / reversed / partially captured, FX, fees, descriptor, external id,
   venture. No booking at maximum without evidence.
5. Provider evidence import (CSV first, then the read adapter): matcher plus an unmatched queue. An agent's statement alone
   books nothing.
6. Refunds linked to charges; dispute state; PayPal refund and dispute obligations kept as liabilities.
7. SCA "awaiting owner approval" state with a phone alert and timeout.
8. Starling read-only adapter (polling), simulated until you connect it.
9. The existing owner-card clearing path stays unchanged; PayPal stays first (O17).

**P3: agent capabilities:**
- capability check before quoting;
- justified capability request;
- .pptx as a real deliverable (inspector, review, rendering);
- toolchain additions (matplotlib, OCR, EPUB);
- support-burden and AI-cost attribution per order and venture;
- web-search and image-generation adapters with setup screens (not connected);
- the software-maintenance prerequisites (scoped repository grant, build sandbox).

## 3. Your setup and provider choices (only the indispensable ones)

| Choice | Recommendation | Cost |
|---|---|---|
| Phone push | Pushover (account + app; app token and user key) | $4.99 once per platform |
| Outside monitor | Healthchecks.io (heartbeat and backup checks) + UptimeRobot (HTTPS check), both to Pushover | free (UptimeRobot's free tier: check its terms for your use) |
| Off-site backup | Backblaze B2, EU, Object Lock 30 days, bucket-scoped key; you keep the restic password offline | pennies a month at this size |
| Bank/card rail | Starling sole-trader account first (read-only API; 3DS in your app); a limited company only if you later want Revolut / Airwallex | £0 a month |
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

**P1: UI 0.21.1 + schema v83 + host files.** Contents:
- the mobile fix;
- phone push (queue, sender, Phone alerts panel);
- the operations watch;
- heartbeat and `OnFailure`;
- backup / drill scripts and units;
- the edge change;
- capability guidance v9.

It is built on P0 (v82), so it deploys after bbfb24a, or with it as one 81 → 83 cutover (your choice). After freezing it
needs its own rehearsals.

**bbfb24a (P0) stays frozen and ready.** Its rehearsals are valid until **2026-10-17 16:46Z** (production unchanged since:
a712be1, schema 81).
