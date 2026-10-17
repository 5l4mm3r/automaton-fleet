# Launch readiness — the one checklist (Agent-1 first; Agent-2 stays paused)

State 2026-10-17. Production: 8b39928, schema 91, UI 0.24.0 (deployed 12:23:38Z; release-8b39928.md). "Blocker" = launch cannot be called ready until it is done. "Limit" = recorded,
does not block. Optional improvements are listed at the end and never delay the decision.

## 1. Checklist
| # | Requirement | Evidence so far | Owner / provider action | Status |
|---|---|---|---|---|
| 1 | Release installed, identities match, records preserved | 8b39928 (schema 91, UI 0.24.0) deployed 12:23:38Z after f2a1784 (02:02:15Z): ledger head 849 / 723c7ea3… and 812 journals unchanged both times, events kept, approved = pinned = Operator API; full baseline dumps | — | Done |
| 2 | Agent-1 runtime + tools | f2a1784 (founder-v10, toolset-6, field guide v2.2, inspector fleet-qa-2); agent-tools-2 current (32 wheels, verified); sandbox self-test ok (network denied, state unreadable); state identical; paused, fuse 754 / 20 | — | Done |
| 3 | Agent-2 preserved | b60e262, paused, fuse 3000 / 60, untouched | — | Done |
| 4 | Edge (mobile rate-limit fix) | installed 13:16Z (nginx -t first, reload, backup `automaton-fleet-edge.conf.pre-v91-…`); login 200, unauthenticated read 401 | — | Done |
| 4b | Proof 1: Fleet HQ on the owner's phone | 2026-10-17 ~16:10Z: password + authenticator sign-in on the owner's phone, switching to the authenticator app and back — signed in first time; the edge refused 0 requests (limited log: 0 today) (**proof 1: LIVE**) | phone model / OS version not recorded | Done |
| 5 | Phone push | keys 13:57Z; test delivered 14:07:31Z, confirmed 14:08:32Z; **alarm drills (v92)**: drill 2 sent 18:48:46Z at priority 2, acknowledged in Fleet HQ 18:49:56Z, alarm cancelled at Pushover 18:50:01Z; drill 1 (18:47:36Z) cancelled at 18:48:41Z when its notification was deleted; unanswered → unresolved proven by tests (v84, v92) (**proof 2: LIVE**) | — | Done |
| 6 | Heartbeat, unit-failure alerts, outside checks | Healthchecks `fleet-heartbeat` (5 min / grace 10) connected 14:17Z; OnFailure hooks on 14 units; outage drill: heartbeat stopped after the 14:51:43Z ping, check went down and **Pushover rang with the Emergency alert** (~15:07Z), acknowledged; heartbeat restored 15:07:15Z `ok` (**proof 3: LIVE**). Email alert also delivered | UptimeRobot HTTPS checks (optional, recommended) | Done (UptimeRobot optional) |
| 7 | Encrypted off-site backup + isolated restore | Backblaze B2 (EU, Object Lock) + restic connected; first attempt FAILED (pg_dump could not write into the root-only staging dir; `connect.sh` printed a false success) — fixed (repo 9f78fae: dumps stream through root; strict `connect.sh`), repaired on the host without touching the repository or its keys: backup 15:47:48Z ok (schema 91, 22 MB database, 9 trees) and restore drill 15:48:01Z ok (snapshot d7a66108 into a disposable scratch database: schema 91, ledger verifies, 812 journals; 40 sample files byte-identical); nothing left behind; nightly 02:30Z + monthly drill timers on (**proof 4: LIVE**) | later: a full rebuild on a disposable VM. Escrow DONE 2026-10-17: restic password + custody, cognition, identity agent / owner key files in the owner's password manager, fingerprints on paper (owner to shred the temporary local copy) | Done |
| 8 | Service isolation on the real host | 2026-10-17 13:40Z: code / build / proxy see `/etc/automaton-fleet` empty; `fleet-isolation-check.sh` (a4e972c: explicit dependencies, public pins against a name / value schema) PASSED for 19 running units after the public certificate and the tunnel id file became 0600; canary test caught all 4 planted cases and removed them; 0 failed units; ledger, agents, registry and safety flags = post-v91 baseline | — | Done |
| 9 | Bank account + feed | owner decision 2026-10-17: **no separate bank account**; the owner's existing debit card is used as an owner-paid card (card clearing: reserved from the agent's cash, charged to the owner's card, owed to the owner). Bank feed installed, unused. Funding goes to the PayPal treasury (backing live there). Bank-rail proofs (7, 10) are replaced by one card purchase reconciled from the owner's card statement | — | Not needed (owner decision) |
| 10 | Card for purchases | card slot 1 = owner-paid ("credit" mode, the v48 card-clearing path), fallback OFF; the owner adds the card in Money & identity → Your card (sealed in the browser to the identity broker) | add card 1; standing card authority at activation; proof purchase under the proof authorisation | **Blocker** until the card is added |
| 11 | Search + images | gateway installed, running not configured | Brave Search API key (card on file, $5 free monthly credit); OpenAI project key with prepaid credit (min $5); `connect.sh media search` / `media image` (model gpt-image-2.5-flare: gpt-image-1 shuts down 2026-10-23) | **Blocker** for graphics beyond the bundled tools; one search + one image proof |
| 12 | Software maintenance | code / build / proxy installed and running (not configured); toolchains python3, node 22.23.3, npm 10.9.9 | GitHub App (id, slug, key) → `connect.sh code`; your own repository as the customer: snapshot, failing then passing build, PR, uninstall | **Blocker** only if software maintenance is offered at launch; else not offered (labelled) |
| 13 | Legal seller + public site | 2026-10-17 18:56–18:57Z: seller = individual (sole trader), legal name and a virtual-office address (geographic, not a PO box) set by the owner; public site `https://api.agentfleet.vip`; sales CLOSED; each page's "sold by" line built from the seller record (v78), agents trade under their own brands | — | Done |
| 14 | Mail: Proton sending, receiving, per-agent / per-venture routing | Bridge live; 26 messages received; owner notifications sent; mailbox routes built, 0 created yet | none (Agent-1 creates its brand mailbox during the proof) | Proven in proof 5 |
| 15 | Payment receiving | PayPal rail active, £1 receiving test passed (2026-10-10) | — | Done |
| 16 | Money out (refunds; later payouts) | custody built; execution OFF | your explicit word: custody activation (Fleet HQ, step-up) before the refund proof | **Blocker** for the refund proof |
| 17 | Financial invariants | one ledger across locations; transfers never create money; holds only from fresh free cash under lock; shortfall recorded, grants nothing; evidence kept on booking failure; fallback off; media / AI attributed to the agent; Fleet Control allocation; net-profit sweep — all tested (v66, v86, v88, v90, v91) | — | Done (simulated providers; live in proofs 7–8, 10) |
| 18 | Proofs 1–10 (§3) | none live yet | §2 budget + your go | **Blocker** |

Limits (do not block): `/etc` readable inside builds apart from the Fleet's directory; a running build finishes (≤ 30 min)
after access ends; Node / npm installed but JavaScript builds are not proven (Python is); graphics without the image
provider are what the bundled tools make (Pillow, reportlab); AI-cost attribution starts at v90; the PayPal limitation
signal comes only from PayPal's failure codes; proof purchases are tests, not demand or profitability.

## 2. The controlled proofs: one plan, one authorisation (Agent-1 only; Agent-2 stays paused)
Live already: proof 1 (phone), 2 (push + alarm drill), 3 (outside monitor), 4 (backup + restore). Bank-rail proofs are
not needed (owner decision 2026-10-17: no separate bank account). Software maintenance is **not offered at launch**
unless the GitHub App is set up (then proof 9 is added; until then the capability check refuses quoting it).

### Proof A — the operating loop (one workflow)
| Step | Acceptance |
|---|---|
| 1. Demand research with web_search (Brave) | sources recorded; a buyer problem with evidence; search cost charged to Agent-1 at its actual price |
| 2. A brand and one supported product (spreadsheet / document / template / course pack) | the agent's own venture and brand; capability check names the offer and every deliverable ready |
| 3. Production and substantive review | the inspector passes the exact files (formulas recalculate, no errors, rendered pages checked, spelling, the brief's acceptance criteria); one image from generate_image if the product uses one (actual token cost) |
| 4. A **private** offer (not public: sales stay closed) | an order page for the owner only |
| 5. The owner's purchase (PayPal, **£5**) | consent recorded; payment verified from PayPal; revenue attributed to Agent-1 net of PayPal's fee |
| 6. Delivery | the buyer's mail from the brand's routing address + the order page download; files open and match what was inspected |
| 7. Support + revision | the owner replies to the delivery mail with one change request; the agent answers from the brand address and delivers a revised file |
| 8. Refund (full) | executed through PayPal by custody; revenue reversed once; ledger verifies; no duplicate revenue or expense |

### Proof B — one card purchase (owner-paid card 1)
A small purchase the agent needs for Proof A's product (e.g. a stock photo, font or icon licence), **at most £5**, on a
merchant that takes cards: reserved from Agent-1's cash, Fleet Control review, the browser fills card 1, any 3-D Secure
approval is yours in your bank's app (the agent waits), then the charge is matched on the weekly card statement and owed
to you. Stop if the merchant needs anything beyond card + email.

### Authorisation requested (once, for both proofs)
| Item | Exact setting | Ends |
|---|---|---|
| Resume Agent-1 | fuse unchanged (754 a day, 20 turns an hour) | paused again when the proofs end, on a material failure, or after 72 h |
| Outward release (proof only, not launch) | actions: browser (the purchase merchant's origin only), mail (to the owner's address only), account_register (that merchant) | expires after 72 h |
| Custody (money out) | max £5.00 per instruction, £5.00 a day, for 72 h — the refund only | expires |
| Card authority | identity autonomy ON with card, max £5 per charge, £5 a day | reset to the launch setting at activation |
| Media | Brave key (free monthly credit) and OpenAI $5 prepaid credit, gateway caps 1 ¢ / search and 20 ¢ / image | stay connected |

### Budget (a ceiling, reported as used)
| Kind | Expected | Ceiling |
|---|---|---|
| Refundable principal: your proof purchase | £5.00 (refunded in step 8) | £5.00 |
| Fees consumed: PayPal's fee on it (not returned) | ≈ £0.45 | ≈ £0.50 |
| Card purchase (Proof B) | the item's price | £5.00 |
| AI (Agent-1's own work; pre-launch test cost) | a few £ | fuse: 754 a day (≤ £7.54) × 3 days |
| Search / images | < $0.30 | gateway caps |
| Prepaid credit (mostly unused) | OpenAI $5 | $5 |
| Subscriptions | Pushover $4.99 once (only to keep it after the trial) | — |

Stop conditions: all steps accepted; or a step fails materially (Agent-1 is paused, the defect fixed and re-verified, the
proof resumed only inside this authorisation); or 72 h pass. Cleanup: the release and custody windows expire by
themselves; the private offer is withdrawn; the card authority returns to OFF until activation.

## 4. Funding / backing requirement
Live at 2026-10-17 02:02Z: books cash £200.67; PayPal holds £0.67; **£200.00 of capital (the two £100 wallets) is
recorded without money**. Recompute (`capital_backing` in Fleet HQ) immediately before depositing; proofs change it.
Supported destination: **the PayPal treasury** (then "back the existing capital" on that PayPal transaction — live now).
The bank route (v91, "My deposit") stays available if a dedicated bank account is ever added; the owner chose not to
(2026-10-17). Agent-2's paused £100 wallet stays in the books: the requirement covers both wallets.

## 5. Activation sequence for Agent-1 (after §1 passes; each numbered step is its own owner instruction)
1. Recompute and back the capital (§4).
2. **Separate financial instruction:** the pre-launch test-cost write-off (v74), run once more only if you instruct it (it
   posts journals: proof-window AI costs become the Fleet's, nothing owed).
3. Record the launch boundary (once, immutable; pausing / resuming never moves it).
4. Survival: protection is ON fleet-wide (v55). Your rule — death on actual wallet exhaustion, no automatic rescue —
   applies to Agent-1 by setting **Agent-1 to "live"**; Agent-2 stays protected while paused.
5. Capital: Fleet Control allocation is on (reserve 50 %, a request ≤ 10 % of the treasury, exposure ≤ 25 %); switch
   sizing from `fixed` (live today) to the agreed **`contextual`**: Fleet Control lends only what the treasury can actually
   release; the opportunity's evidence still decides.
6. Sweep: turn the net-profit sweep policy ON (off today; bands 10 % – 20 % by population, 45 % mature, never above 70 %;
   always on net profit).
7. Standing authority: identity autonomy ON with the card (uncapped by your 2026-10-11 decision; Fleet Control review
   holds only on credible evidence); card slot 1 = your owner-paid card (card clearing), fallback OFF.
8. **Ongoing outward operation = opening sales** (`fleet_admin_sales_set(true)`, a deliberate command-line step). The
   proof's outward release is scoped and expiring and is NOT the launch setting. Opening sales is fleet-wide: Agent-2's
   pause is then what keeps it from acting, so it stays paused. Agent-1 chooses its channels; a platform's own onboarding
   blocks only that channel.
9. Money out stays active for refunds; payouts / fee withdrawals only by your separate decision.
10. Resume Agent-1 (fuse 754 a day, 20 turns an hour, unless you set others). Agent-2 stays paused (it also needs its own
    runtime upgrade before any future resume).

## 6. Optional later (never delays launch)
Unit files listing individual secret files could hide the whole directory (isolation is checked on the host either way);
a dedicated PayPal limitation alert; a PayPal deposit that fills an open shortfall first (bank deposits do); JavaScript
builds proven; per-provider statement automation.
