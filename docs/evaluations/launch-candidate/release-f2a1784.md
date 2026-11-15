# Release f2a1784 (fleet/final-v2.5): schema 81 → 90 + UI 0.23.0 · CANDIDATE, NOT DEPLOYED

**Status:** frozen candidate, staged in `~/rlc90` on the VPS. It replaces 05cbe4e (81 → 87 + UI 0.22.0) as the
money-handling release: 05cbe4e must not be deployed (release-05cbe4e.md §5). It contains everything in bbfb24a (P0, v82),
f47ee1c (P1, v83) and 05cbe4e (v84 – v87), plus v88 – v90 and the systemd credential fixes.

Nothing was deployed, installed, connected, enabled or funded. No account was opened, no subscription bought, no agent
resumed. Agent-1 is the first intended trading agent; Agent-2 stays paused.

## 1. Contents beyond 05cbe4e
| Schema | What | State |
|---|---|---|
| v88 | Money that has left is always on the books: a bank line is recorded even when booking fails (kept with its error, RED alert, retried; imports row by row); an unfunded card charge is the agent's debt plus a visible negative **treasury shortfall**; the agent's card frozen meanwhile; media overruns are the agent's (cash, then debt) | built, tested |
| v89 | Software maintenance on demonstrated scope: customer consent on their own page, the Fleet GitHub App (one repository per token, least permissions, new `fleet/` branch + pull request only), the isolated build environment and its registry-only egress proxy, quoting only with active access + a passing baseline for THAT enquiry | built, tested against a SIMULATED GitHub, real sandboxed builds; no app, not installed |
| v90 | Up to three cards (credit, or debit on its own bank; priority; **fallback off by default**); a provisional chargeback credit reversed by the bank; PayPal's own failure codes mark the PayPal location limited; unit economics (revenue, **direct and allocated** AI cost, support burden per order / venture); queued code work fails when access ends; media statements in UTC days | built, tested |
| Units | push / media / code: non-empty `SetCredential=…:unset` placeholders (05cbe4e's empty ones were invalid systemd syntax); code / build / build-proxy hide all of `/etc/automaton-fleet` | verified with `systemd-analyze verify`; the hiding is proven per unit at installation |
| UI 0.23.0 | Money locations (shortfall, booking errors, cards + fallback, reversals, transfers, overdue holds, disputes), card slots 1 – 3, Capabilities, Code access, Unit economics | e2e desktop + emulated iPhone |

## 2. Identity and rehearsals
```
FLEET_RUNTIME_COMMIT=f2a17843f9073040192eaa37cdf7630e2b7fdfc7
FLEET_RUNTIME_BUILD_ID=5ddf7bb66e53df2f808290e0351ecc6c739517865f625e16802c2a2545a5e2b2   (VPS build = independent local build)
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
UI 0.23.0: ui-0.23.0-f2a1784.tgz  sha256 565a9b262c4a4c86fdfcfd7797cd2820a9fffb3fd8a826bb46ce74ecf5fd6f31  (52 files; two clean builds identical; staged in ~/rlc90, sha checked there)
```
- **Data rehearsal 81 → 90: PASSED** 2026-10-16 23:25:40Z, on a restored copy of production:
  - wouldApply [82 … 90];
  - 1 new account at zero (the treasury shortfall);
  - 812 journals; 2922 events preserved, none purged;
  - the ledger verifies;
  - a re-run is a no-op;
  - rollback restores 81 with the same ledger head;
  - live untouched.
- **Services + rollback rehearsal: PASSED** 2026-10-17 00:17:01Z:
  - a712be1 refuses schema 90;
  - on 90 the candidate controller (all readiness checks, privileges included), Operator API and dashboard are ready;
  - Fleet Command and history are clean: 54 feed rows, no housekeeping, no hidden-permanent events;
  - ledger head unchanged; no reservation or birth;
  - rollback restores 81, and a712be1 is ready again;
  - production PIDs unchanged (1066933 1066959 1077293).
- **Valid until** 2026-10-17 23:25Z, while production stays unchanged (a712be1, schema 81).

## 3. The four questions, answered from the code

### 3.1 Automatic shortfall coverage versus Fleet Control allocation
- **A shortfall** is money that has already left the bank (an unfunded card charge) with no partition holding it. It is
  recorded at once, never rejected:
  - the agent owes it (`agent_provider_payable`, repaid first from its next receipts);
  - the books show a negative `fleet:treasury:shortfall`, inside the capital-backing books, so books against money stays
    true;
  - the agent's card is frozen (FLEET_CARD_SHORTFALL), and a daily RED TREASURY_SHORTFALL alert runs while it is open.
- **Automatic coverage** (`fleet_treasury_shortfall_settle`, run after each bank match and by the operations watch) moves
  only **unallocated treasury cash** into the shortfall. That is money no agent, envelope or protected partition holds:
  the agent's repayment, an owner deposit, a refund that came back.
  - It never takes from an agent's wallet, an envelope, runway, obligations, growth capital or contingency.
  - It gives no one anything. It corrects the books: that cash was already gone.
- **Fleet Control allocation** (genesis allocations, capital requests, envelopes) gives an agent spendable money. It is
  a decision, never automatic, and it can only allocate from unallocated cash.
  - So an open shortfall reduces what Fleet Control can allocate.
  - Nothing is allocated to cover it. Nothing lends to the agent, and no partition is borrowed from.
- **Your consequence:** a deposit made while a shortfall is open fills the shortfall first. Only the remainder becomes
  allocatable.

### 3.2 Debit-to-credit fallback under the existing standing authority
- A hold uses the card the agent names. Otherwise it uses the first active card by priority.
- If that card cannot carry the hold (a debit card whose bank lacks fresh free cash), the hold is **refused**
  (FLEET_LOCATION_INSUFFICIENT). A purchase never moves to credit on its own.
- A later card stands in only if **you marked it as a fallback**. That is off by default and set per card:
  `economy-card-slot … --fallback`, or "Allow as fallback" in Money locations (with a confirm).
- **A fallback purchase is an ordinary purchase under the standing authority you already gave** (autonomous spending
  with Fleet Control review, 2026-10-11). It is reviewed the same way, and it is reserved from the agent's own cash
  first. A credit card adds no spending power; it changes only which external instrument pays:
  - **debit:** your bank pays now;
  - **credit:** your card pays, and you are owed it (card clearing).
- **What enabling it means:** while the bank is short, purchases continue on your credit card.

### 3.3 Unit economics: direct cost versus allocation estimate
| Figure | Meaning | Kind |
|---|---|---|
| `revenueMinor` | paid / partially refunded order amounts | measured |
| `aiDirectMinor` | AI calls whose tool calls acted on that one order / venture only | **direct cost (measured)** |
| `aiAllocatedMinor` | an equal share of AI calls that acted on several things | **allocation estimate** (the equal split is an assumption) |
| `aiCostMinor` | direct + allocated | partly estimated |
| `generalAiCostMinor` | AI calls that acted on no order or venture (research, planning, housekeeping) | **unattributed**: not spread anywhere |
| buyer / agent messages, deliveries, revisions, days open | support burden per order | counted |
- Records start with v90. Earlier AI calls are general.
- A venture's figures include the costs of its orders.
- Card and media spend are already per venture / order in the ledger (v86 / v87). This table covers AI cost and support
  burden.

### 3.4 Customer-code isolation and access revocation: the evidence
**Tested** (`fleet-v89-code-maintenance-pg`, real Landlock builds on the development VM; `fleet-v89-code-units`):
- **Consent:** the customer types the exact repository on their own page, and the wording they saw is kept. Access is
  active only when the Fleet app's installation grants THAT repository.
- **Scoped tokens:** one repository per token, read-only for snapshots, contents + pull-request write for proposals.
- **What the gateway can write:** only a new `fleet/<id>` ref (create only) and a pull request to the consented branch.
  It never updates a branch, merges or deletes, and it is refused before any call otherwise.
- **Proposals:** a proposal needs a passing build of exactly that patch (a one-byte change needs its own build).
- **A build command that tries to read secrets gets nothing:**
  - its environment holds no credential variable and none of the worker's;
  - reading the worker's own `/proc/<pid>/environ` is refused;
  - a world-readable file outside its directory is refused.
- **Network:** no TCP port at all without the proxy; with it, only the proxy's port. The proxy tunnels only to
  allow-listed registries on 443.
- **Access ends:**
  - after its agreed days, at the operations watch;
  - on uninstall / repository removal, at the gateway's next pass;
  - on the owner's revoke, at once.
  - Queued snapshots and builds then fail unrun (v90 fixed builds staying queued). Nothing new can be asked for, and the
    quoting gate closes.
- **Roles:** the gateway and the build environment reach only their own functions. The privilege audit is clean.

**Stated limits:**
- `/etc` is readable inside a build (toolchains need it). The Fleet's configuration is hidden by each unit, and any other
  secret under `/etc` relies on its file permissions.
- A build already running when access ends finishes (at most 30 minutes).
- The unit-level hiding of `/etc/automaton-fleet` could not be shown on the development VM (its user manager applies no
  mount namespaces). `fleet-code-setup.sh install --apply` proves it for each running unit and stops if any unit can see
  the directory.

## 4. Deploy (your go), then host steps (each its own go)
1. `bash ~/rlc90/fleet-release.sh ~/rlc90/pins.txt 81 90 0.23.0 ~/rlc90/ui-0.23.0-f2a1784.tgz 565a9b262c4a4c86fdfcfd7797cd2820a9fffb3fd8a826bb46ce74ecf5fd6f31`.
   Rollback before live money: `bash ~/rlc90/fleet-rollout.sh revert ~/rlc90/pins.txt 81 90 <reason>`.
   This replaces bbfb24a, f47ee1c and 05cbe4e (it contains all three).
2. Agent-1's runtime upgrade, kept paused. First install agent-tools-2 (`fleet-agent-tools.sh`), then
   `sudo …/fleet-founders.sh upgrade-runtime 01M3F50SH7PNX2E3GST13J52AS`. Agent-2 is not upgraded and stays paused.
3. The P1 host steps (release-f47ee1c.md §3), using this release's unit files.
4. When you choose them:
   - bank feed;
   - media;
   - code maintenance (`fleet-code-setup.sh`, after creating the GitHub App);
   - office renderer and OCR.

## 5. Tests (focused; all passing at f2a1784)
| Suite | Result |
|---|---|
| `fleet-v88-shortfall-pg` (the reproduced 05cbe4e rejection, replay, freeze / thaw, funding, refund, estate, booking failure + retry, owner-card path) | 5/5 |
| `fleet-v89-code-maintenance-pg` (consent, scoped tokens, sandboxed builds, PR-only, gate, revoke, **secret / env / network probes, expiry with queued work**), `fleet-v89-code-units` (patch applier, egress proxy, JWT, fail-closed starts, unit files), `fleet-v89-public-repo-consent` | 5/5, 6/6, 2/2 |
| `fleet-v90-cards-reversals-economics-pg` (cards incl. **refusal without fallback** and fallback when marked; reversal; PayPal limitation; **direct / allocated**), `fleet-identity-autonomy-pg` (slot-2 fill) | 4/4, 9/9 |
| `fleet-v86-locations-pg`, `fleet-v86-bankfeed-service-pg`, `fleet-location-feed`, `fleet-bank-statement`, `fleet-v87-media-capabilities-pg`, `fleet-v85-capabilities-pg` | 7/7, 2/2, 6/6, 3/3, 4/4, 5/5 |
| `fleet-v76-market-fulfilment-pg`, `fleet-v83-push-pg`, founder tools v76 / v85, live dashboard contract, static audit | 9/9, 8/8, 7/7 + 7/7, 13/13, 6/6 |
| Dashboard e2e (desktop 17, emulated iPhone 4) | 21/21 |
| Before these corrections, the whole v2.5 regression set ran in batches (unit batch 152/152); the two failures it found (media statement date in BST, a library version pin) are fixed above | passing |

## 6. One remaining-work list

**Implementation gaps:** none known in the planned scope. Limits that stay by design:
- AI-cost attribution starts with v90;
- the PayPal limitation signal works from PayPal's failure codes (PayPal has no limitation API);
- builds use the host's toolchains (python3 today; Node needs the OS package);
- the `/etc` and running-build limits in §3.4.

**Host installation (each your go; sudo):**
1. This release.
2. agent-tools-2, then Agent-1's runtime upgrade (paused).
3. Edge file.
4. Push.
5. Heartbeat and `OnFailure`.
6. restic and the backup / drill timers.
7. Bank feed.
8. Media gateway.
9. Code gateway, build environment and proxy (+ optionally `nodejs`).
10. Office renderer and OCR.

**Provider onboarding (your accounts; no purchase authorised here):**
1. Pushover.
2. Healthchecks.io and UptimeRobot.
3. Backblaze B2 + the restic escrow password.
4. Your bank account (subject to seller eligibility), a read-only token, and who approves 3-D Secure.
5. Brave Search and OpenAI Images.
6. The Fleet's GitHub App.
7. The legal seller and public site.
8. Money out (custody execution), for refunds.

**Live proof (in order; Agent-1 only):**
1. The dashboard on your phone.
2. A push you confirm received.
3. The monitor rings.
4. A backup and drill.
5. Agent-1's controlled proof (≤ £50): purchase, delivery, support, refund.
6. A spending proof you name.
7. The bank rail: a transfer matched on evidence, a 3-D Secure purchase, a decline, a refund, zero reconciliation drift.
8. A second card on a real checkout under its own hold.
9. One paid search and one image at actual cost, then a statement that reconciles.
10. Code maintenance on your own repository: consent, install, snapshot, a failing then passing build, a pull request you
    close, then access ended by uninstalling.

## 7. Not proven (be exact)
- Every provider path ran against a simulated provider: bank, PayPal limitation codes, search, images and GitHub. No key,
  token or account exists for any of them.
- Until the bank feed is connected, debit-card purchases book only when you import a statement.
- Not installed: the renderer and OCR, the code services, and Node inside builds.

## 8. Deployed 2026-10-17 (owner's go)
- **Preservation baseline** 02:00:00Z (`~/rlc90/baseline-pre-20261017T020000Z`, read-only; full database dump sha 4fc52264…):
  schema 81, ledger head 849 / 723c7ea3…, 812 journals, verify true, 2922 events; both agents paused (Agent-1 754 / 20 per
  hour, Agent-2 3000 / 60), both on b60e262.
- **Release** `fleet-release.sh … 81 90 0.23.0`: started 02:00:26Z, outage 02:01:18–02:02:04Z (46 s), DEPLOYED 02:02:15Z,
  `production_deployed` recorded. Reconciliation OK (2922 events preserved). Pre-migration dump
  `~/automaton_fleet-v81-pre-v90-20261017T020138Z.dump`. After: schema 90, ledger head and journals identical, verify
  true; approved = pinned = Operator API release = f2a1784 / 5ddf7bb6…; agents unchanged and paused.
- **agent-tools-2**: lock 8655a172a2ea… installed at `/usr/local/lib/automaton-fleet-tools/8655a172a2ea` (32 wheels, tree
  e585205d…, verify ok); `current` switched from a2d5c9f11557 (kept; rollback = point `current` back).
- **Agent-1 runtime upgrade** b60e262 → f2a1784: upgrade 99707948-105a-4829-bfa4-6522e97b7daf, downtime 2.2 s, challenge
  passed, state identical (26 files), backup `/var/lib/automaton-fleet-upgrades/99707948…`. Still paused, fuse unchanged.
  Agent-2 not touched (b60e262, paused). The founder upgrade rehearsal was not re-run (owner: no further rehearsals).
- **Remaining host steps** (edge file, push, heartbeat units, restic + backup units, bank feed, media, code services with
  the real-host `/etc/automaton-fleet` hiding proof, office renderer + OCR, nodejs + npm): one checked script,
  `~/rlc90/host-install.sh`, run by the owner (the session's automatic permission check refused host changes made by the
  assistant). Provider connections: `~/rlc90/connect.sh push|heartbeat|backup|bank|media|code`, run in the owner's terminal.
- **Fix forward from here:** once real provider data or money is recorded, a restore of the pre-migration dump would
  discard it; freeze and fix forward instead.
