# Release 1b487eb — schema 81 → 82 + UI 0.21.0 (sign-in recovery, buyer consent on every own purchase route, recorded helper jobs, specialist desks, idle roaming) · CANDIDATE, NOT DEPLOYED

**Status:** frozen candidate; supersedes f890144 (release-f890144.md). Commits 9fd3b73 (feature), f890144 (fix found by
the founder-upgrade rehearsal) and 1b487eb (the owner's corrections below) are pushed to fleet-origin `fleet/final-v2.4`.

Nothing was deployed, nothing spent, sales were not opened and no agent was resumed.

## 0. What 1b487eb corrects (owner review of the f890144 package, 2026-10-16)
| Point | Before | Now |
|---|---|---|
| Host recovery left the old access in place | The two host commands did not end signed-in sessions or cancel recovery codes. The runbook relied on the owner remembering Sign out elsewhere and new codes. | Each command, as part of the same operation, signs out every session, cancels every unused recovery code, cancels an unfinished authenticator replacement and cancels earlier unused set-up links. Keeping sessions or codes needs `--keep-sessions` / `--keep-recovery-codes`; the choice is printed, logged (`host_recovery_access_ended`) and raises a RED notification. Any other option is refused and changes nothing. A set-up link now also raises `ADMIN_ENROLLMENT_LINK_ISSUED`. |
| Etsy / Gumroad consent stated as settled | "Etsy: not recordable, buyers keep 14 days; choose refunds or no Etsy downloads." | **Unresolved platform evidence** (§2). Not a forced choice; evidence to collect before first use. |
| "All tests pass" with two failing Field Guide tests | Two R41.1 assertions pinned Field Guide v2.1. | The guide went to v2.2 on purpose in f98e347 (agent-chosen channels). Pins updated, and the v2.2 CHANNELS text is now asserted too. No behaviour check removed. R41.1 29/29. |

UI 0.21.0 is unchanged (no `codex-dashboard` file differs from f890144), so the staged tarball and its hash still apply.

**Production now:** a712be1, schema 81, UI 0.20.1.
- Both agents are paused, on runtime b60e262.
- Sales are closed; there is no seller and no public site.
- The four safety flags are false; cap 2.

## 1. What the owner asked, and where it is

| Owner decision (2026-10-16) | Delivered | Evidence |
|---|---|---|
| Idle awake agents may wander rooms and corridors; cosmetic movement never changes the recorded task | UI 0.21.0. Agents stroll on a seeded schedule, avoiding Quarters, Estate, desks and intakes, labelled "idle · strolling". Placement, activity, timers, room counts and data orbs are unchanged. | UI roam 8 tests; browser e2e |
| Sleepers in the dorms; owner pause and agent sleep kept distinct | Unchanged and preserved: own bunk; ⏸ owner pause / ☾ reported hibernation | existing hub tests |
| Specialist helpers at assigned workstations, asleep until needed | Desks: researchers (Library), marketers (Marketing), producers (Venture/Dev), support (Comms), reviewers and the critical-tier advisor (Fleet Command). Asleep is only a picture. | UI crew tests; e2e "a specialist wakes…" |
| Wake the relevant specialists; several may work together | One desk per concurrent job of that purpose, assigned by job id; lit while running and 25 s after | UI crew tests |
| Animations from real helper activity; no continuously running session; reuse existing helper calls | Existing calls reused: `routine_task`, `escalate_question`, `independent_review`, QA inspection, Fleet Control reviews. No persistent crew, hiring cost or separate memory. | §3 |
| **Record each helper's actual purpose and start/end state instead of guessing from the room** | `fleet_helper_jobs`: kind, stated purpose, start, end, and state (running → finished / failed / ended). Filled by triggers on the reservation and the result. A chore must state its purpose. Desks take their role only from it. | v82 consent+helpers 6/6; routing 48; founder upgrade 11/11 |
| Station stays behind login | Unchanged | — |
| "Forgot password?", authenticated password change, lost-device recovery; never silently bypass verification | v82 recovery codes plus two sign-in-page flows, each needing two factors and never giving a session. Change password (signed in) is unchanged. | v82 recovery 6/6; e2e recovery |
| **Document and test the recovery when normal factors are lost** | Runbook in `docs/admin-access.md` with the verified production command; host recovery tested end to end; it ends the old access by itself (§0) | host recovery 6/6 + clean-up 4/4 |
| Standing authority remains; ask only for genuinely new owner decisions | Checked, unchanged. The doctrine says "Never ask the owner for ordinary business decisions"; `record_external_dependency` accepts only human identity, KYC, legal signature, constitutional change or a non-delegable credential. After sales open, connected-channel API work needs no release (v81). | spec §34.5 |
| **Buyer consent for immediate digital delivery, on all supported purchase routes, with confirmation** | Every route the Fleet runs itself asks and records. A durable confirmation is sent. Etsy and Gumroad: unresolved platform evidence. | §2 |
| **Launch & channels plain-English redesign** | **Done and live:** UI 0.20.1 (0a8fe64), deployed 2026-10-15 21:25:57Z. Carried unchanged in 0.21.0. | §4 |

## 2. Buyer consent and confirmation per route (CCR 2013 regs 36/37)

**The wording**
- Versioned and immutable (`fleet_buyer_consent_wordings`, version `2026-10-16.v1`, `src/fleet/storefront/consent.ts`).
- Two separate, unticked, required boxes.
- Each order records version, time and hashed origin. A recorded consent never changes.
- Without it: no payment link, no download (the file route refuses too) and no email attachment.

| Route | Consent | Durable confirmation | Test |
|---|---|---|---|
| Offer page (product) | with the purchase: `svc_offer_buy(slug, origin, consent)`. A purchase without both ticks never reaches the registry. | the automatic delivery email repeats it | v82 consent 2; public pages 3/3 |
| Quoted service | order page, before the PayPal link | "Order confirmation" email once paid (scope, due date, consent, page, seller) | v76 market 9/9 |
| Agent's own checkout (`paypal.checkout`) | **new:** every such order has an order page; the agent is told to give the buyer the page. No agent read carries the raw PayPal link of a checkout with a page. | "Order confirmation" email | v82 consent 5; custody worker; v56 7/7 |
| Owner's proof purchase | order page | confirmation when the buyer confirms after an earlier delivery (that email could not carry it) | v82 consent 3–4 |
| **Etsy** (owner's shop; Etsy's checkout) | **Unresolved: platform evidence not established.** The checkout is Etsy's page, so the Fleet cannot add its boxes there. The Fleet uses Etsy only through the official API. What Etsy's checkout itself shows and records for UK/EU download buyers, and so their cancellation position, is not established either way. | Etsy's receipt | evidence to collect (§6) |
| **Gumroad** (merchant of record; locked until £500 per agent) | **Unresolved: platform evidence not established.** Gumroad's checkout, under its terms as merchant of record (verified 2026-10-12 for EU/UK VAT only). | Gumroad's | evidence to collect before unlock (§6) |
| Orders created before v82 without a page | none | — | delivered as before; buyer keeps the right |

## 3. Helper jobs: recorded, not guessed

**What the agent states with each helper call (founder runtime, this commit).**
- `routine_task` requires a `purpose`: research, marketing, production or customer_support. A chore without one is refused,
  and nothing is sent.
- Routes carry `helper: { kind, purpose }`. It is validated against a closed set and is never a routing input: the tier is
  unchanged, which is tested.
- Escalations record `decision`. Independent reviews record `quality_review`, and are known while they run.

**What the controller records (schema v82).**
- `fleet_helper_jobs`:
  - **opened** when the call is reserved, from its route snapshot;
  - **closed** by the call's result (finished / failed);
  - **ended** at commit when a reservation ends with no result.
- Route-proven kinds: a question is a decision; `evidence_relevance` is Fleet Control's evidence check.
- A chore from an older runtime records **no purpose** and is shown as such. It wakes no desk and is counted, never guessed.
- The triggers run as the schema owner (`SECURITY DEFINER`, fixed search_path). They write only that table, from the
  triggering row. This is the fix in f890144: the founder-upgrade rehearsal found "permission denied" otherwise.

**The dashboard read.** `helpers` returns the last 10 minutes plus anything running, from:
- helper jobs;
- QA inspections;
- Fleet Control spend reviews;
- older-runtime independent reviews, when cited.

It carries classes, purposes, states and times only: never prompts, content, models or digests (tested).

**Takes effect on agents only with their runtime upgrade.** Both agents run b60e262. Their chores carry no purpose until
the owner upgrades them (§5 step 3). The controller accepts both: the field is optional on the wire.

## 4. Launch & channels (status the owner asked for)

**Status:** delivered as UI 0.20.1. Commit 0a8fe64; deployed 2026-10-15 21:25:57Z with `fleet-ui-deploy.sh`; tarball
`dc0648ac…a6d1`.

**What it is:** a guided, plain-English set-up:
- a status line and next step;
- Business details with field help and a notice preview;
- Connected platforms;
- Agent preparation;
- Launch readiness by sales route;
- live proofs shown as "Not tracked — operator verification required".

**This release:** the code is unchanged and carried in 0.21.0.

**Focused checks, re-run today:**
- launch guide unit 17/17;
- v81 launch dashboard 7/7;
- browser e2e Launch case (in 17/17).

**Open item:** the owner's signed-in view of it on production. Only the owner can sign in there.

## 5. Identity, evidence and the one deployment path

```
FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
FLEET_RUNTIME_COMMIT=1b487eb6b4bc1604471c015a378b15b6f3e6ce4b
FLEET_RUNTIME_BUILD_ID=c23778a49d882caf4d60ae834b61eea0f542e4379df9cfbc1f56d8d3c9f62376   (VPS build = independent local build)
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
UI 0.21.0: ui-0.21.0-f890144.tgz  sha256 57ffba56c42e6bd0773de1c2c52617d0c3fc9003d3e89aca3784bbba9969c77f  (52 files, LIVE build;
           clean-clone builds of 9fd3b73 and f890144 byte-identical; no codex-dashboard file changed in 1b487eb)
```

- **Builds.** VPS `~/rlc82/pins.txt` (commit 1b487eb, build `c23778a4…2376`, lockfile `1df54e35…a2c1`) equals the
  independent local build. The UI tarball staged as `~/rlc82/ui-0.21.0-f890144.tgz` still has the same hash (re-checked).
- **Data rehearsal 81 → 82: PASSED** 2026-10-16 15:28:02Z, on a restored copy of production:
  - migrate-check wouldApply [82];
  - reconciliation OK: 812 journals; 2967 events preserved, none purged;
  - the ledger verifies;
  - a re-run is a no-op;
  - the rollback dump restores 81 with the same ledger head;
  - live untouched.
- **Services + rollback rehearsal: PASSED** 2026-10-16 16:17:00Z:
  - a712be1 refuses schema 82 (rollback must restore the database);
  - on 82 the candidate controller (all readiness checks, privileges included), Operator API and dashboard are ready
    (login 200, signed-out 401);
  - Fleet Command and history are clean (0 copies);
  - the ledger head is unchanged; no reservation or birth;
  - rollback restores 81 with an identical ledger head, and a712be1 is ready again;
  - production PIDs unchanged (1066933, 1066959, 1077293).
- **Superseded:** f890144 (rehearsals passed 13:00:46Z / 13:17:02Z; artifacts kept as `~/rlc82/*-f890144.*`) and 9fd3b73
  (`~/rlc82/*-9fd3b73.*`).
- **Founder runtime upgrade rehearsal** (local, b60e262 → tree, real processes): 11/11 (1 skipped) at f890144. Not
  re-run: 1b487eb changes only the host recovery SQL and CLI, which the founder runtime does not use.
- **Valid until** 2026-10-17 15:28Z. Re-run both rehearsals after that.

**Deploy** (owner's go; one cutover from production's schema 81):
```
bash ~/rlc82/fleet-release.sh ~/rlc82/pins.txt 81 82 0.21.0 ~/rlc82/ui-0.21.0-f890144.tgz 57ffba56c42e6bd0773de1c2c52617d0c3fc9003d3e89aca3784bbba9969c77f
```

**Rollback**, only before any live money or provider data exists:
`bash ~/rlc82/fleet-rollout.sh revert ~/rlc82/pins.txt 81 82 <reason>`. The UI returns to 0.20.1. After that point,
freeze and fix forward as in release-a712be1.md.

**After deploy, in order** (each is its own go):
1. **Create recovery codes:** Security → Sign-in methods → Create recovery codes. Save them offline.
2. **Optional check:** "Forgot password?" and "Lost your authenticator?" appear on the sign-in page.
3. **Founder runtime upgrade**, right after the deploy (the owner's stated order). Purposes are recorded only after it.
   Both agents stay paused throughout; the upgrade does not resume them.
   `sudo /opt/automaton-fleet/current/scripts/fleet-founders.sh upgrade-runtime 01M3F50SH7PNX2E3GST13J52AS` (Agent-1)
   `sudo /opt/automaton-fleet/current/scripts/fleet-founders.sh upgrade-runtime 01M4C4NXT786Q4E9725N5A15KV` (Agent-2)
   - Rehearsed locally: b60e262 → tree 11/11 (1 skipped), at f890144 (see above).
   - Rollback: `fleet-founders.sh rollback-runtime <agentId> <upgradeId> <reason>`.

**What the deploy does not change:** agents stay paused and keep their AI fuses (754p/20h, 3000p/60h). Sales stay closed;
seller, site, rails, sweep, replication, capital, custody and permissions are untouched; the four flags stay false; cap 2.

## 6. Decisions for the owner, and evidence still to collect
1. **Go for deploy** (§5), while the server rehearsals are valid.
2. **Founder runtime upgrade** (§5 step 3): right after the deploy, agents kept paused. It needs the same explicit go
   (it runs as root on the host). The new helper behaviour does not reach agents still on b60e262.
3. **Evidence to collect (not decisions yet).** Neither is in use today: no Etsy shop is connected and Gumroad is locked.
   - **Etsy, before the first Etsy digital listing:** Etsy's official documentation on digital downloads and cancellation
     for UK/EU buyers, and a controlled test purchase recording exactly what Etsy's checkout shows and what its receipt
     records. The Fleet's position follows from that evidence.
   - **Gumroad, before unlock:** Gumroad's official account of how, as merchant of record, it handles the buyer's consent
     and the withdrawal right for digital products.

## What this package proves, and what it does not
It proves release preparation: the candidate builds identically twice, migrates a copy of production cleanly and rolls
back, and its changed behaviour passes focused tests. It does **not** prove successful autonomous trading. Readiness to
trade still depends on:
- the seller and site set-up (Launch & channels: legal seller details, public site, connected rails);
- a controlled demonstration covering research, production, payment, delivery and support.

## 7. Tests (focused; no full suite)
| Area | Result |
|---|---|
| v82 sign-in recovery (server + client) | 6/6 |
| v82 host recovery (lost factors; owner-only; audit) | 6/6 |
| v82 host recovery clean-up (sessions, codes, pending replacement, earlier links; explicit keep; RED; typo refused) | 4/4 (new) |
| v82 consent, confirmations, helper jobs, privilege audit | 6/6 |
| v82 public consent pages (unit) | 3/3 |
| Browser e2e: real Chrome, virtual passkey, LIVE export (recovery codes, Forgot password, Lost authenticator, a desk waking from a recorded job, Launch & channels, no CSP violations) | 17/17 |
| UI: crew, roam, hub, command centre | 119 |
| Cognition routing + R23 mind (purpose required; helper record; tier unchanged) | 48 |
| Founder runtime upgrade b60e262 → tree (real processes) | 11/11 (1 skipped) |
| v43 sign-in (unchanged routes) | 17/17 (re-run on 1b487eb) |
| R41.1 continuation (Field Guide v2.2 pins + CHANNELS text) | 29/29 |
| v76 market 9/9, v76 demonstrations 3/3, v56 delivery 7/7, PayPal custody worker, v53, v57, v58, v59, v51, v61, v68, v77, PayPal treasury, lifecycle | all pass |
| v78 / v79 / v80 | 21/21 |
| v81 + launch guide | 24/24 |
| UI contract + migration paths (old schemas → 82 clean) | 32/32 |
| Cognition routing PG, v62 conversations, v70 AI credit | 19/19 |
| Typecheck (root, UI), eslint (changed UI files) | clean |

**Re-run on 1b487eb** (code touched by the corrections; batches of at most three PostgreSQL files): host recovery 6/6 and
clean-up 4/4, v82 recovery 6/6, v43 17/17, dashboard 9/9, v82 consent + helpers (privilege audit) 6/6, browser e2e 17/17,
live contract 13/13, migration paths 2/2 (old schemas → 82 clean), R41.1 29/29, typecheck clean. The other rows are from
f890144. The corrections touch none of their code: the host recovery SQL and CLI only, plus documents and tests.

**Failures:** none in the suites above. (The two Field Guide failures listed for f890144 were stale version pins, corrected
in 1b487eb.)
