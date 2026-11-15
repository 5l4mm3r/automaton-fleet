# Release 12c9f67 — schema 76 → 77 (treasury integrity, owner withdrawals, contextual capital sizing) · **DEPLOYED 2026-10-15 11:50:26Z**

Supersedes `release-709c091.md` (and a2b3745). Adds: owner withdrawal records (profit distribution / capital return / reimbursement)
and opt-in contextual capital sizing from real lendable cash (spec §31.9, §31.10). Liquidity fixes of 709c091 included.

## Deployment (owner's typed authorisation, 2026-10-15: "deployment of the prepared 12c9f67 candidate only")
- `fleet-release.sh` 11:48:44Z → **DEPLOYED 11:50:26Z**; outage 11:49:34–11:50:18Z (44 s); one `production_deployed` event.
  Live: commit 12c9f67, build `8f358d76…0fb8be`, lockfile `1df54e35…a2c1`, schema **77**, UI 0.19.0 reused (unchanged, no switch).
- Rollback points: pre-migration dump `~/automaton_fleet-v76-pre-v77-20261015T114955Z.dump`, `runtime.env.pre-12c9f67`, release
  a0e0ac0; UI `dashboard.env.before-release-12c9f67-20261015T114844Z`.
- **Preservation** (per-table row count + content hash of all 271 tables before vs after, `~/rlc77c/{pre,post}-tables.txt`):
  identical except the expected: migration 77 (+3 ledger kinds, +6 rules, new empty `fleet_owner_withdrawal_records`, capital policy
  gained `sizing` = `fixed` — version 1 and timestamp unchanged, **contextual NOT applied**); runtime identity a0e0ac0 → 12c9f67;
  heartbeats / timestamps (agents, mail provider, notification and replication state, nonces, health challenges); +2 PayPal balance
  readings; Fleet Command +1 (deploy). Events: 27 temporary rows from 2026-10-08 10:56–11:49Z expired by 7-day retention; 18 added
  (role grants, runtime_approved, production_deployed, and the usual 2 heartbeat `api_auth_failed` refused across the outage —
  replay protection, as at every cutover). Ledger 812 journals unchanged.
- **State after**: Agent-1 / Agent-2 cognition paused (754p/20h, 3000p/60h unchanged) on b60e262; no public site (sales closed);
  0 custody activations; no signer file; `REAL_PAYMENTS_ENABLED` / `REAL_REPLICATION_ENABLED` / `OWNER_SWEEP_ENABLED` /
  `FLEET_DRY_RUN_CHILD` false, remote listen true; survival protection ON; sweep policy off; identity / card authority off; no
  launch boundary; cap 2, DEVELOPMENT. Readyz 200, public healthz 200, admin 200; all units active; no warnings in the logs.
- **v77 live** (read-only transaction): `fleet_treasury_liquidity` — PayPal £0.67 available (reading 11:50Z, fresh), nothing
  committed, free £0.67; `fleet_treasury_lendable` — £0.00 (agents' £200.00 exceeds real cash): nothing can be lent or paid out.

Before deployment (verified live 2026-10-14): a0e0ac0, schema 76, UI 0.19.0, agent toolchain installed; Agent-1 and Agent-2 paused on
b60e262; no public site (sales closed); 0 custody activations; real payments off; survival protection on; no launch boundary.
Master specification §31 holds the requirement-to-implementation matrix. Nothing here is authorised by this record.

## Identity and evidence
```
FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
FLEET_RUNTIME_COMMIT=12c9f6710b0f12a1045076b7b9eb7b0b4304302c
FLEET_RUNTIME_BUILD_ID=8f358d76c824a18698944f7cea152e1042b1e3a5beea38754064b48ac70fb8be
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
```
- VPS `~/rlc77c/pins.txt` = independent local build. UI unchanged: 0.19.0 `890f7b07…244e` (staged `~/rlc77c/ui-0.19.0-12c9f67.tgz`).
- Data rehearsal 76 → 77 **PASSED** 18:15:50Z; services + rollback rehearsal **PASSED** 18:16:16Z (valid to 2026-10-15 18:15Z).
- Tests (affected only): v77 9/9 (liquidity incl. money that left after a reading and two rail records of one account; owner
  withdrawals; contextual sizing); v66 5, v70 3, v71 5, f2-autonomy-sim 6; custody-signer 8, treasury 10, v59 3, ledger 27, rail-readiness 11, spend-review v64 11, f2-capital 11,
  f2a 8, f2-economy 12, f2-accounting 3, custody 15, custody worker 7, v76 8, migration paths 2; tsc clean.
- Unchanged since d978ee6 (evidence stands): founder runtime (local upgrade rehearsal b60e262 → candidate 11/11), toolchain and
  sandbox on the production kernel, demonstrations 3/3.

## What v77 completes
Real outflows bounded by available PayPal cash (was: ledger only); envelope spending reviewed like own capital (was: unreviewed);
the owner's AI-credit reimbursement can be recorded (was: no path). Details: §31.2, migration header.

## Ordered completion checklist
### A. Done with agents paused and no funding
1. a0e0ac0 deployed (v76 market loop, sales gate, preparation hold, proof accounting, refund-fee fixes), toolchain installed.
2. v77 built, frozen, rehearsed on the VPS (this record). Webhook subscription verified; reachability verified; Transaction Search
   access verified; custody return URL verified; every outflow path verified closed today.
3. **v77 deployed 2026-10-15 11:50:26Z** (section Deployment): liquidity gate, envelope review, withdrawal records live.

### B. Owner inputs and provider setup (no money)
| Input | Why | How |
|---|---|---|
| **Seller facts** (§31.8) | public site; required before Agent-1 can publish | `economy-public-site https://api.agentfleet.vip "<notice>"` |
| PayPal Developer Dashboard → Webhooks → event deliveries | the only place PayPal shows why nothing was delivered | owner looks; tell me what it shows |
| Capital policy | v30 fixed fractions are defaults, never approved | contextual sizing: `economy-capital-policy '{"sizing":"contextual"}'` at launch (spec §31.9) — no new percentages |
| Payouts on the live app | only for suppliers paid by PayPal Payouts | request in PayPal (provider approval) |
| Card on file | card bypass | `hub-broker-key` → `owner-identity-seal payment_card <file> <brokerPub> <out>` (install as broker user) |
| Identity facts / documents | standing authority | `owner-identity-seal <class> …` per fact; choose classes and documents |
| AI credit auto-reload | sustained operation | set in the provider console (human); receipts are recorded as they arrive |

### C. Controlled live proof (needs Agent-1 running)
- **Scope**: upgrade Agent-1 to 12c9f67 (Agent-2 stays paused on b60e262), resume it; it builds, reviews and publishes one product
  (not public: sales closed, outward actions held); you inspect it; `economy-offer-proof <slug>`, pay, receive it, refund it in PayPal.
- **Verifies**: purchase detection and capture (which channel); webhook delivery and signature verification (or its absence, with
  polling as the separate fallback); buyer email and download; refund + returned fee via webhook and via Search; owner capital down
  by exactly PayPal's retained fee; nothing booked to Agent-1.
- **Cost**: AI ≤ 754p/day (Agent-1's fuse), from the owner-funded credit ($41.29); PayPal's retained fee (≈ 20–35p). No treasury
  money: the proof is paid and refunded by you.
- **Stop**: pause Agent-1 when the proof is verified, on any failure, or at 48 h — and keep it paused unless launch follows at once.

### D. Treasury backing and AI credit
- Backing: £200 unbacked today. Nothing enforces backing; since v77 no real payout or refund can exceed available PayPal cash, so
  unbacked ledger money simply cannot leave. **Deposit £200 before money-out is activated**, then `economy-capital-back <railId>
  <txnId> <eventCode>`. Not needed for deployment or the proof.
- AI credit: $41.29 owner-funded (route `owner_card`) covers the proof window. Replenishment is **not Fleet automation**: the only
  supported route is the provider console's own auto-reload on a saved card (no purchase API). Remaining manual steps: confirm each
  observed receipt (`economy-ai-credit-confirm <receiptId> owner`), reimburse yourself in PayPal, record it (`economy-owner-withdrawal
  reimbursement <amount> <paypalTxnId>`). A treasury-funded route needs a card drawing on the treasury account (your decision; unverified).

### E. Final autonomous activation and launch (one session, in this order)
1. Preconditions: C verified; dispute / reversal residual risk accepted (they cannot be produced live); D done.
2. Money-out: custody signer file installed (`FLEET_CUSTODY_SIGNERS_FILE`, custody host, sudo); `REAL_PAYMENTS_ENABLED=true` in
   **custody.env only** + custody restart; `economy-custody-activate - - 720 "pilot"` (no maxima), later `- - ongoing`.
3. Card / identity: `owner-identity-autonomy on --card on --classes <…> "<statement>"`; `owner-identity-documents <…>`.
4. Capital: `economy-capital-policy '{"sizing":"contextual"}'`. Sweeps: `economy-sweep-policy '{"enabled":true}'` — an internal
   daily pass only; paying you is your own PayPal withdrawal, assessed and recorded with `economy-owner-withdrawal[-assess]` (§31.10).
5. **Launch boundary**: `economy-launch-boundary-record "<note>"` — immediately followed by:
6. `economy-protection off "launch"` (death on actual exhaustion); `economy-sales open` (lifts the preparation hold);
   `founder-cognition 01M3F50SH7PNX2E3GST13J52AS resume "launch"`. Agent-2 stays paused.

## Commands
1. Deploy v77: `bash ~/rlc77c/fleet-release.sh ~/rlc77c/pins.txt 76 77 0.19.0 ~/rlc77c/ui-0.19.0-12c9f67.tgz 890f7b078ca2106dbb6151126716162113a72ed7d60ea7f9c44d32b6af7b244e`
2. Agent-1 window: `sudo scripts/fleet-founders.sh upgrade-rehearsal <b60e262 full sha>` → `upgrade-preflight 01M3F50SH7PNX2E3GST13J52AS` →
   `upgrade-runtime 01M3F50SH7PNX2E3GST13J52AS` → `founder-cognition 01M3F50SH7PNX2E3GST13J52AS resume "<reason>"`; afterwards
   `founder-cognition 01M3F50SH7PNX2E3GST13J52AS pause "<reason>"`.
3. Proof: `economy-offer-proof <slug>`; checks: `hub-offers`, `hub-paypal`, `economy-capital-backing`, Fleet Command.

## Financial recovery
- Before any live money after deploy: `bash ~/rlc77c/fleet-rollout.sh revert ~/rlc77c/pins.txt 76 77 <reason>` (it dumps the
  post-cutover state and refuses to discard writes without `FLEET_REVERT_DISCARD_ACK`).
- After real money or provider data exists: **freeze and fix forward** — `economy-sales closed`, `economy-custody-deactivate`,
  `founder-cognition <id> pause`, then a corrective release. Never restore an older dump over live financial records.

## Remaining blockers
| Blocker | Cause | Resolution |
|---|---|---|
| No public site | seller facts not supplied | §31.8 facts → `economy-public-site` |
| Webhook delivery never observed | not visible from the Fleet (PayPal side) | owner checks the dashboard delivery log; proof creates fresh events |
| No live agent sale / refund evidence | requires the proof | section C |
| Money-out keys absent | by design until launch | section E.2 (+ Payouts approval if needed) |
| Card / identity not sealed | owner facts | section B |
| Capital sizing still `fixed` (v30 defaults, never approved) | contextual is opt-in | section E.4 at launch |
| Sweeps off; protection on | by design until launch | section E |
| Automatic payment of sweeps / profit to the owner not implemented | by design: custody pays only agents; Payouts cannot pay the account itself | manual PayPal withdrawal, recorded (v77) |
| Automatic AI-credit replenishment not implemented | provider: console, cards only, no purchase API | manual steps §31.10 |
| Etsy not implemented; Gumroad not onboarded | channel work / owner onboarding | not launch blockers (own offer pages work) |
| Spec references "README §3" in CLAUDE.md | that section does not exist | recovery guidance lives in §31.7 / §13.3 (owner may correct CLAUDE.md) |
