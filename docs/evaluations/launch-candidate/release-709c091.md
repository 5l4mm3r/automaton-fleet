# Release 709c091 — schema 76 → 77 (treasury integrity) · FROZEN, VPS-prepared, not deployed

Supersedes `release-a2b3745.md`: its verification found that money which left after a PayPal reading was counted as available
again, and that liquidity was per rail record rather than per PayPal account. Both fixed here (spec §31.2).

Production now (verified live 2026-10-14): a0e0ac0, schema 76, UI 0.19.0, agent toolchain installed; Agent-1 and Agent-2 paused on
b60e262; no public site (sales closed); 0 custody activations; real payments off; survival protection on; no launch boundary.
Master specification §31 holds the requirement-to-implementation matrix. Nothing here is authorised by this record.

## Identity and evidence
```
FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
FLEET_RUNTIME_COMMIT=709c0914136dd2278da5da40a59aeef824bcb4eb
FLEET_RUNTIME_BUILD_ID=583c33b28411d578790799c436e401bcf119f41de0862fdb83705042de55adaa
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
```
- VPS `~/rlc77b/pins.txt` = independent local build. UI unchanged: 0.19.0 `890f7b07…244e` (staged `~/rlc77b/ui-0.19.0-709c091.tgz`).
- Data rehearsal 76 → 77 **PASSED** 18:01:23Z; services + rollback rehearsal **PASSED** 18:01:49Z (valid to 2026-10-15 18:01Z).
- Tests (affected only): v77 7/7 (incl. money that left after a reading — settled payout, completed refund, card repayment, owner
  reimbursement — and two rail records of one account); custody-signer 8, treasury 10, v59 3, ledger 27, rail-readiness 11, spend-review v64 11, f2-capital 11,
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

### B. Owner inputs and provider setup (no money)
| Input | Why | How |
|---|---|---|
| **Go to deploy v77** | the liquidity gate must be live before any money-out | command 1 below |
| **Seller facts** (§31.8) | public site; required before Agent-1 can publish | `economy-public-site https://api.agentfleet.vip "<notice>"` |
| PayPal Developer Dashboard → Webhooks → event deliveries | the only place PayPal shows why nothing was delivered | owner looks; tell me what it shows |
| Capital policy | the v30 thresholds are defaults, never approved | approve the configuration in spec §31.9 (or amend it) — applied with `economy-capital-policy` at launch |
| Payouts on the live app | only for suppliers paid by PayPal Payouts | request in PayPal (provider approval) |
| Card on file | card bypass | `hub-broker-key` → `owner-identity-seal payment_card <file> <brokerPub> <out>` (install as broker user) |
| Identity facts / documents | standing authority | `owner-identity-seal <class> …` per fact; choose classes and documents |
| AI credit auto-reload | sustained operation | set in the provider console (human); receipts are recorded as they arrive |

### C. Controlled live proof (needs Agent-1 running)
- **Scope**: upgrade Agent-1 to 709c091 (Agent-2 stays paused on b60e262), resume it; it builds, reviews and publishes one product
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
- AI credit: $41.29 owner-funded (route `owner_card`) covers the proof window. Replenishment is **manual** (no automation, and the
  provider offers no purchase API): auto-reload on your card in the console, then confirm receipts and reimburse yourself as in
  spec §31.10.

### E. Final autonomous activation and launch (one session, in this order)
1. Preconditions: C verified; dispute / reversal residual risk accepted (they cannot be produced live); D done.
2. Money-out: custody signer file installed (`FLEET_CUSTODY_SIGNERS_FILE`, custody host, sudo); `REAL_PAYMENTS_ENABLED=true` in
   **custody.env only** + custody restart; `economy-custody-activate - - 720 "pilot"` (no maxima), later `- - ongoing`.
3. Card / identity: `owner-identity-autonomy on --card on --classes <…> "<statement>"`; `owner-identity-documents <…>`.
4. Capital policy (§31.9) and sweeps: `economy-sweep-policy '{"enabled":true}'` — an internal daily pass only. Paying sweeps or profit
   out to you is **not implemented** and no manual withdrawal can be recorded yet (§31.10): make no such transfers until designed.
5. **Launch boundary**: `economy-launch-boundary-record "<note>"` — immediately followed by:
6. `economy-protection off "launch"` (death on actual exhaustion); `economy-sales open` (lifts the preparation hold);
   `founder-cognition 01M3F50SH7PNX2E3GST13J52AS resume "launch"`. Agent-2 stays paused.

## Commands
1. Deploy v77: `bash ~/rlc77b/fleet-release.sh ~/rlc77b/pins.txt 76 77 0.19.0 ~/rlc77b/ui-0.19.0-709c091.tgz 890f7b078ca2106dbb6151126716162113a72ed7d60ea7f9c44d32b6af7b244e`
2. Agent-1 window: `sudo scripts/fleet-founders.sh upgrade-rehearsal <b60e262 full sha>` → `upgrade-preflight 01M3F50SH7PNX2E3GST13J52AS` →
   `upgrade-runtime 01M3F50SH7PNX2E3GST13J52AS` → `founder-cognition 01M3F50SH7PNX2E3GST13J52AS resume "<reason>"`; afterwards
   `founder-cognition 01M3F50SH7PNX2E3GST13J52AS pause "<reason>"`.
3. Proof: `economy-offer-proof <slug>`; checks: `hub-offers`, `hub-paypal`, `economy-capital-backing`, Fleet Command.

## Financial recovery
- Before any live money after deploy: `bash ~/rlc77b/fleet-rollout.sh revert ~/rlc77b/pins.txt 76 77 <reason>` (it dumps the
  post-cutover state and refuses to discard writes without `FLEET_REVERT_DISCARD_ACK`).
- After real money or provider data exists: **freeze and fix forward** — `economy-sales closed`, `economy-custody-deactivate`,
  `founder-cognition <id> pause`, then a corrective release. Never restore an older dump over live financial records.

## Remaining blockers
| Blocker | Cause | Resolution |
|---|---|---|
| v77 not deployed | owner go pending | command 1 |
| No public site | seller facts not supplied | §31.8 facts → `economy-public-site` |
| Webhook delivery never observed | not visible from the Fleet (PayPal side) | owner checks the dashboard delivery log; proof creates fresh events |
| No live agent sale / refund evidence | requires the proof | section C |
| Money-out keys absent | by design until launch | section E.2 (+ Payouts approval if needed) |
| Card / identity not sealed | owner facts | section B |
| Capital-policy thresholds unapproved | defaults since v30 | owner keeps or sets |
| Sweeps off; protection on | by design until launch | section E |
| External owner withdrawals / sweeps not implemented (no recorder) | owner decision on how a withdrawal draws on profit vs capital | design + implement after your decision; until then no such transfers |
| Automatic AI-credit replenishment not implemented | provider: console, cards only, no purchase API | manual steps §31.10 |
| Etsy not implemented; Gumroad not onboarded | channel work / owner onboarding | not launch blockers (own offer pages work) |
| Spec references "README §3" in CLAUDE.md | that section does not exist | recovery guidance lives in §31.7 / §13.3 (owner may correct CLAUDE.md) |
