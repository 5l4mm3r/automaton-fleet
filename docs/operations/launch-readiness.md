# Launch readiness — the one checklist (Agent-1 first; Agent-2 stays paused)

State 2026-10-17. Production: 8b39928, schema 91, UI 0.24.0 (deployed 12:23:38Z; release-8b39928.md). "Blocker" = launch cannot be called ready until it is done. "Limit" = recorded,
does not block. Optional improvements are listed at the end and never delay the decision.

## 1. Checklist
| # | Requirement | Evidence so far | Owner / provider action | Status |
|---|---|---|---|---|
| 1 | Release installed, identities match, records preserved | **1743b33 (schema 93, UI 0.26.0) deployed 2026-10-17 19:36:45Z**, after 7f674e0 (92) and 8b39928 (91, 12:23:38Z) and f2a1784 (02:02:15Z): ledger head 849 / 723c7ea3… and 812 journals unchanged both times, events kept, approved = pinned = Operator API; full baseline dumps | — | Done |
| 2 | Agent-1 runtime + tools | f2a1784 (founder-v10, toolset-6, field guide v2.2, inspector fleet-qa-2); agent-tools-2 current (32 wheels, verified); sandbox self-test ok (network denied, state unreadable); state identical; paused, fuse 754 / 20 | — | Done |
| 3 | Agent-2 preserved | b60e262, paused, fuse 3000 / 60, untouched | — | Done |
| 4 | Edge (mobile rate-limit fix) | installed 13:16Z (nginx -t first, reload, backup `automaton-fleet-edge.conf.pre-v91-…`); login 200, unauthenticated read 401 | — | Done |
| 4b | Proof 1: Fleet HQ on the owner's phone | 2026-10-17 ~16:10Z: password + authenticator sign-in on the owner's phone, switching to the authenticator app and back — signed in first time; the edge refused 0 requests (limited log: 0 today) (**proof 1: LIVE**) | phone model / OS version not recorded | Done |
| 5 | Phone push | keys 13:57Z; test delivered 14:07:31Z, confirmed 14:08:32Z; **alarm drills (v92)**: drill 2 sent 18:48:46Z at priority 2, acknowledged in Fleet HQ 18:49:56Z, alarm cancelled at Pushover 18:50:01Z; drill 1 (18:47:36Z) cancelled at 18:48:41Z when its notification was deleted; unanswered → unresolved proven by tests (v84, v92) (**proof 2: LIVE**) | — | Done |
| 6 | Heartbeat, unit-failure alerts, outside checks | Healthchecks `fleet-heartbeat` (5 min / grace 10) connected 14:17Z; OnFailure hooks on 14 units; outage drill: heartbeat stopped after the 14:51:43Z ping, check went down and **Pushover rang with the Emergency alert** (~15:07Z), acknowledged; heartbeat restored 15:07:15Z `ok` (**proof 3: LIVE**). Email alert also delivered | UptimeRobot HTTPS checks (optional, recommended) | Done (UptimeRobot optional) |
| 7 | Encrypted off-site backup + isolated restore | Backblaze B2 (EU, Object Lock) + restic connected; first attempt FAILED (pg_dump could not write into the root-only staging dir; `connect.sh` printed a false success) — fixed (repo 9f78fae: dumps stream through root; strict `connect.sh`), repaired on the host without touching the repository or its keys: backup 15:47:48Z ok (schema 91, 22 MB database, 9 trees) and restore drill 15:48:01Z ok (snapshot d7a66108 into a disposable scratch database: schema 91, ledger verifies, 812 journals; 40 sample files byte-identical); nothing left behind; nightly 02:30Z + monthly drill timers on (**proof 4: LIVE**) | later: a full rebuild on a disposable VM. Escrow DONE 2026-10-17: restic password + custody, cognition, identity agent / owner key files in the owner's password manager, fingerprints on paper (owner to shred the temporary local copy) | Done |
| 8 | Service isolation on the real host | 2026-10-17 13:40Z: code / build / proxy see `/etc/automaton-fleet` empty; `fleet-isolation-check.sh` (a4e972c: explicit dependencies, public pins against a name / value schema) PASSED for 19 running units after the public certificate and the tunnel id file became 0600; canary test caught all 4 planted cases and removed them; 0 failed units; ledger, agents, registry and safety flags = post-v91 baseline | — | Done |
| 9 | Bank account + feed | owner decision 2026-10-17: **no separate bank account**; the owner's existing debit card is used as an owner-paid card (card clearing: reserved from the agent's cash, charged to the owner's card, owed to the owner). Bank feed installed, unused. Funding goes to the PayPal treasury (backing live there). Bank-rail proofs (7, 10) are replaced by one card purchase reconciled from the owner's card statement | — | Not needed (owner decision) |
| 10 | Card for purchases | card slot 1 = owner-paid ("credit" mode, the v48 card-clearing path), fallback OFF; the owner adds the card in Money & identity → Your card (sealed in the browser to the identity broker) | standing card authority at activation; proof purchase under the proof authorisation | Done: card 1 re-saved 2026-10-18 11:47:56Z, installed by the broker 11:48:03Z, shown as a masked label (brand, last four, name, exp 12/27; v93), expiry stored (end of 12/2027). The broker keeps the whole card including the CVC, sealed in its owner vault (0600, its own user), to fill checkouts; never in the database, Fleet HQ, logs or any agent's view. Saving it authorises nothing |
| 11 | Search + images | **search: Brave connected 2026-10-18 12:13:55Z** (key root 0600; gateway started `search: brave`, 1 ¢ charged per search; DNS stub allowed); **images: not connected by owner decision 2026-10-18** (Claude is the agents' cognition; OpenAI would only generate images — agents use the bundled graphics tools and are told images are not connected) | first live search in Proof A step 1; images later via `connect.sh media image` if a product needs them | Search done; images not offered |
| 12 | Software maintenance | code / build / proxy installed and running (not configured); toolchains python3, node 22.23.3, npm 10.9.9 | GitHub App (id, slug, key) → `connect.sh code`; your own repository as the customer: snapshot, failing then passing build, PR, uninstall | **Blocker** only if software maintenance is offered at launch; else not offered (labelled) |
| 13 | Legal seller + public site | 2026-10-17 18:56–18:57Z: seller = individual (sole trader), legal name and a virtual-office address (geographic, not a PO box) set by the owner; public site `https://api.agentfleet.vip`; sales CLOSED; each page's "sold by" line built from the seller record (v78), agents trade under their own brands | — | Done |
| 14 | Mail: Proton sending, receiving, per-agent / per-venture routing | Bridge live; 26 messages received; owner notifications sent; mailbox routes built, 0 created yet | none (Agent-1 creates its brand mailbox during the proof) | Proven in proof 5 |
| 15 | Payment receiving | PayPal rail active, £1 receiving test passed (2026-10-10) | — | Done |
| 16 | Money out (refunds; later payouts) | custody built; execution OFF | your explicit word: custody activation (Fleet HQ, step-up) before the refund proof | **Blocker** for the refund proof |
| 17 | Financial invariants | one ledger across locations; transfers never create money; holds only from fresh free cash under lock; shortfall recorded, grants nothing; evidence kept on booking failure; fallback off; media / AI attributed to the agent; Fleet Control allocation; net-profit sweep — all tested (v66, v86, v88, v90, v91) | — | Done (simulated providers; live in proofs 7–8, 10) |
| 18 | Controlled proofs (§2) | proofs 1–4 LIVE (phone, push + alarm drill, outside monitor, backup + restore); Proof A / B not started | §2 authorisation + your go | **Blocker** |

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
| 3. Production and substantive review | the inspector passes the exact files (formulas recalculate, no errors, rendered pages checked, spelling, the brief's acceptance criteria); no generated image (images not connected) |
| 4. A **private** offer (not public: sales stay closed) | an order page for the owner only |
| 5. The owner's purchase (PayPal, **£5**) | consent recorded; payment verified from PayPal; booked as the owner's own proof purchase (v76 `owner_proof`: owner capital, never Agent-1's revenue — an owner can never buy survival for an agent); the order and delivery path is the same as a customer's |
| 6. Delivery | the buyer's mail from the brand's routing address + the order page download; files open and match what was inspected |
| 7. Support + revision | the owner replies to the delivery mail with one change request; the agent answers from the brand address and delivers a revised file |
| 8. Refund (full) | executed through PayPal by custody; returned once as `owner_proof_return` (owner capital back; PayPal's fee booked there too); ledger verifies; no duplicate entry; Agent-1's revenue untouched |

### Proof B — one card purchase (owner-paid card 1)
A small purchase the agent needs for Proof A's product (e.g. a stock photo, font or icon licence), **at most £5**, on a
merchant that takes cards: reserved from Agent-1's cash, Fleet Control review, the browser fills card 1, any 3-D Secure
approval is yours in your bank's app (the agent waits), then the charge is matched on the weekly card statement and owed
to you. Stop if the merchant needs anything beyond card + email.

### Authorisation requested (once, for both proofs)
| Item | Exact setting | Ends |
|---|---|---|
| Resume Agent-1 | daily fuse 754 unchanged; hourly cap 20 → 600 (owner, 2026-10-18, during the proof) | paused again when the proofs end, on a material failure, or after 72 h |
| Outward release (proof only, not launch) | actions: browser (the purchase merchant's origin only), mail (to the owner's address only), account_register (that merchant) | expires after 72 h |
| Custody (money out) | max £5.00 per instruction, £5.00 a day, for 72 h — the refund only | expires |
| Card authority | identity autonomy ON with card, max £5 per charge, £5 a day | reset to the launch setting at activation |
| Media | Brave only (free monthly credit), 1 ¢ per search charged to Agent-1; images not connected | stays connected |

### Budget (a ceiling, reported as used)
| Kind | Expected | Ceiling |
|---|---|---|
| Refundable principal: your proof purchase | £5.00 (refunded in step 8) | £5.00 |
| Fees consumed: PayPal's fee on it (not returned) | ≈ £0.45 | ≈ £0.50 |
| Card purchase (Proof B) | the item's price | £5.00 |
| AI (Agent-1's own work; pre-launch test cost) | a few £ | fuse: 754 a day (≤ £7.54) × 3 days |
| Search | < $0.30 | 1 ¢ / search |
| Subscriptions | Pushover $4.99 once (only to keep it after the trial) | — |

Run (owner, own terminal; `~/rlc93/proof.sh`, every step logged to `~/rlc93/proof.log`): `start` (custody, card authority, mail release, a 72 h auto-stop timer, then resume Agent-1; guards: release 1743b33, safety flags false, Agent-2 paused, sales closed) → `scope https://<shop>` when Agent-1 names the purchase shop (expiry kept) → `buy <slug>` (≤ £5) → `stop` at the end or on a material failure (pause, release ended, card authority OFF, custody OFF). Revenue attributed to an agent is proven only by a real customer after sales open.

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
10. Resume Agent-1 (daily fuse 754; hourly cap 600 — owner 2026-10-18: the 20-an-hour cap blocked every turn, customer replies included, and stalled the proof after 7 minutes; the cap only catches a runaway, the loop guard and the daily fuse do the rest). Agent-2 stays paused (it also needs its own
    runtime upgrade before any future resume).

### Proof log (live)
- 2026-10-18 12:26Z started (proof.sh). 12:30 first live Brave search (1p, matches). 12:30:54 Agent-1 closed the owner's turn with no reply.
- 12:36–12:47 stalled at the 20-an-hour cap → owner raised it to 600 (12:47:53Z).
- 12:48–12:55 **defect: a status-only loop.** Each minute a working turn (storefront + offer status, list_files, exec) that never ends in a plain sleep, so the runtime never backs off: about 6p a minute with no progress. Cause: Agent-1 was still waiting on the Gumroad channel (owner request 62cbe1b7, approved 09-26 as "the owner will open Gumroad"); Gumroad was deferred on 10-10, but Agent-1 was never told its channel is its own Fleet offer page. **Paused 12:55:29Z** (proof.sh pause; windows open). Fix: the owner tells Agent-1 that Gumroad is deferred and the offer page is its channel, then proof.sh resume. Runtime follow-up (founder runtime, after the proof): a turn of only status reads counts as idle for the backoff.
- Owner, 2026-10-18: **"the agents should be automated — the chat is for emergencies only"**, and **"reference codes must be titled"**. Fix (owner-run `proof.sh unblock`): a Fleet Control notice, not an owner message, tells Agent-1 that Gumroad is deferred and that its offer page is its channel; resolved dependencies are immutable, so the notice is the record. Next release (after the proof): (1) when an owner decision supersedes an approved dependency, Fleet Control tells the agent automatically; (2) Fleet HQ shows every reference with its title, e.g. "List the landlord compliance tracker on Gumroad (62cbe1b7)", in conversations, Fleet Command and notifications; agents are told to name records by title; (3) the status-only turn counts as idle.

- 13:07–13:11 the Fleet Control notice was delivered but not read: notices reached the wake digest, never the agent's
  task. A second loop ran; Agent-1 was paused at 13:11:15Z. **Cause (log):** every turn was cut off at the runtime's
  4-step default with an empty closing note, so the next turn re-oriented. 71efd95 (16 steps, a note, a "repeat" rule)
  was reviewed by the owner and **withdrawn without being deployed**: the repeat rule only relabelled turns that had
  already been paid for, the note carried no results, and its script resumed Agent-1 automatically.
- **Costs, Fleet-recorded and PROVISIONAL until matched with Anthropic's usage export.** 2026-10-18: 62 calls, all
  claude-sonnet-5-5 (tier T2), each with Anthropic's message id: **$1.8162**, charged £1.36. That is 57 calls of
  Agent-1's own work ($1.5407, £1.16) and 5 owner-conversation calls paid by the treasury ($0.2756, £0.20). Tokens: 534k
  input, 11k output, 1.90M cache reads, 102k cache writes (the loop resent its context). Fleet Control: 0 review calls.
  The per-call list is exported for matching. Anything in the Anthropic export that is not on it (by message id) did
  not come through the Fleet's cognition path. It must be identified from the export itself (key, time, model), not
  assumed.
- 316b27b (v94, UI 0.26.2) prepared and pushed against the owner's acceptance conditions (release-316b27b.md).
  `~/rlc95/install-fix.sh` installs it and upgrades Agent-1, then ends with both agents paused; it has no resume step.
  It is not installed yet (a separate owner decision).

### 2b. Proposed measured live attempt (after the repair is installed; separately authorised; not started)
| | |
|---|---|
| Task | Agent-1, without owner coaching: ONE product under its own brand, passed by the inspector, published as a private offer (sales closed). No purchase, refund, card, mail or account work. Stage 2 (the £5 purchase, revision and refund) comes only after this passes |
| Before it | The owner's existing decision (Gumroad deferred, 10-10) recorded as superseding Agent-1's Gumroad request (`owner-request-supersede`, one command). Fleet Control's notice reaches Agent-1 in its first turn |
| AI ceiling | **£2.00 for the run alone**, with its own run budget (`cognition-run start <Agent-1> 200 6 …`) and no relation to the day's earlier spending or the daily reset. It covers every model call logged for Agent-1 from the run's start: its own work and any treasury-paid conversation turn. Fleet Control reviews are billed separately; none are expected without spending, and any that occur are reported |
| Enforcement | Before every request: the run's cost + requests in flight + this request's worst case must fit £2.00. A refusal costs nothing. The daily fuse (754p) still applies on top |
| Time limit | 6 hours (the run's end time; requests after it are refused) |
| Automatic stop | Primary: the controller's run budget and end time; the runtime's waiting gate (no call after two stalls until something changes). Secondary: a watchdog every 5 minutes pauses Agent-1 when the run is spent or ended, after 3 stalls in a row, or after 30 minutes of waiting with no product |
| Baseline | The run's start time and Agent-1's call count and cost at that moment, recorded in the report |
| Report (plain English) | what was produced; the inspector's checks; the useful actions and the repeated ones; elapsed and model time; the provider cost (Fleet-recorded per call, provisional until matched) and the cost per completed task |
| Pass | an inspected product and a private offer within £2.00 and 6 hours, with no calls in unchanged waiting after a stall. Passing tests or a successful deploy is not success |
| Pilot only | the run budget and the 6 hours are this trial's limits, not standing business limits |

Cost-efficiency proposals (no production change without its own approval; see cost-comparison-2026-10-18.md):
1. Cache the conversation inside a tool loop (`prefix+tail`, already in the provider). Today about 60% of each call
   was uncached input. Measure it with a small scripted A/B of two identical 4-step turns per policy (≈ $0.25).
2. A 1-hour cache for the fixed 34k-token prefix, only if the A/B shows the re-caching after gaps costs more than it.
3. A review of the toolset-6 tool definitions (≈ 30k tokens on every call) to remove repeated text, without removing any
   capability.
4. Models unchanged: Sonnet 5.5 for ordinary steps, Opus 5.5 for escalated and consequential steps, Haiku 4.5 for
   routine chores. Check T3's configured cache-read price against Anthropic's Opus price (accounting only).

## 6. Optional later (never delays launch)
Unit files listing individual secret files could hide the whole directory (isolation is checked on the host either way);
a dedicated PayPal limitation alert; a PayPal deposit that fills an open shortfall first (bank deposits do); JavaScript
builds proven; per-provider statement automation.
