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
| 9 | Bank account + feed | feed service installed and running (no token: statement imports only); v91 backing deployed | Starling sole trader (eligibility: UK resident 18+, sole trader, Starling's checks); add location in Fleet HQ; read-only token → `connect.sh bank <id>`; who approves 3-D Secure (you, in the Starling app) | **Blocker** for card spending and bank funding; PayPal-only launch possible without it (then card purchases book only by statement import) |
| 10 | Card for purchases | card slots, holds, fallback OFF by default, tested | add the card to the owner vault (Fleet HQ → Identity → payment card), slot 1 debit on the bank location; fallback stays off | **Blocker** for purchases |
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

## 2. Proof budget: a CEILING, reported as actually used (prices checked 2026-10-17)
The smallest meaningful set; nothing is spent without your go, each proof stops once it has shown its result.
| Kind | Item | Expected | Ceiling |
|---|---|---|---|
| Refundable principal | your proof purchase (comes back in the refund proof) | £5 | £50 |
| Fees (consumed) | PayPal's fee on it, not returned on refund (≈ 2.9 % + 30p) | ≈ £0.45 | ≈ £1.75 |
| Fees (consumed) | Pushover: free 30-day trial during the proofs; $4.99 once per platform to keep it | $0 now | $4.99 |
| Fees (consumed) | Healthchecks.io Hobbyist, UptimeRobot Free (commercial use allowed), Backblaze B2 (first 10 GB free) | £0 | £0 |
| AI / tool usage (consumed) | Agent-1's AI in the proof window: what it actually uses, likely part of one day's fuse | a few £ | fuse 754 a day (≤ £7.54) |
| AI / tool usage (consumed) | one search (inside Brave's $5 free monthly credit) | $0 | $0.005 |
| AI / tool usage (consumed) | one image (gpt-image-2.5-flare: text input $5, image output $30 per million tokens) | ≈ $0.03–0.13 | $0.20 (gateway limit) |
| Prepaid credit (mostly unused, stays usable 1 year, non-refundable) | OpenAI minimum top-up | $5 | $5 |
| Separate spend | one small item you name, with its purpose | your amount | your amount |

Image billing: the gateway only generates from a text prompt (no image input), so input tokens are text ($5) and output
tokens are image ($30); the first proof image's usage breakdown confirms it. Next build (not this frozen release): refuse
or flag any job whose usage reports image-input tokens.

One authorisation covers it: these purchases, the resume of **Agent-1 only** for the proof window, and custody
activation for the refund. Nothing else is opened: no sales to the public, no replication, Agent-2 paused.

## 3. Proof order (the existing list)
1. Fleet HQ on your phone, including switching to the authenticator app and back. 2. Push: test, "I received it", a real
alert acknowledged; an unanswered one listed as unresolved. 3. Heartbeat stopped 15 min → phone rings; a failed unit
reported. 4. Backup + drill (scratch database + sample files; live data untouched). 5. Agent-1: demand research → offer
→ production and substantive review (checks test the buyer's requested outcome) → private offer → your purchase (≤ £50,
consent recorded) → delivery → support message + revision → refund. 6. The separate spend, reconciled to the provider's
evidence. 7. Bank: a transfer matched on evidence, one 3-D Secure purchase, one decline, one refund, the whole treasury
reconciled with zero difference. 8. One search + one image charged at actual cost; the provider's usage reconciles.
9. Software maintenance on your own repository (if offered). 10. A card slot filled on a real checkout under its own hold.

## 4. Funding / backing requirement
Live at 2026-10-17 02:02Z: books cash £200.67; PayPal holds £0.67; **£200.00 of capital (the two £100 wallets) is
recorded without money**. Recompute (`capital_backing` in Fleet HQ) immediately before depositing; proofs change it.
Supported destinations: **the PayPal treasury** (then "back the existing capital" on that PayPal transaction — live now)
or **the bank location** (after v91 and the bank connection: "My deposit" on the settled line — any shortfall first,
then the capital, the rest new owner funding). Either is one ledger; a bank deposit does not need to pass through PayPal.

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
   holds only on credible evidence); card slot 1 debit on the bank; fallback OFF.
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
