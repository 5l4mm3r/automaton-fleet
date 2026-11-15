# Release f890144 — schema 81 → 82 + UI 0.21.0 (sign-in recovery, buyer consent on every own purchase route, recorded helper jobs, specialist desks, idle roaming) · CANDIDATE, NOT DEPLOYED

**Status:** frozen candidate. Commits 9fd3b73 (feature) and f890144 (fix found by the founder-upgrade rehearsal) are pushed
to fleet-origin `fleet/final-v2.4`.

Nothing was deployed, nothing spent, sales were not opened and no agent was resumed. The owner's instruction of 2026-10-16
authorised commit and push only.

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
| **Document and test the recovery when normal factors are lost** | Runbook in `docs/admin-access.md` with the verified production command; host recovery tested end to end | host recovery 7/7 |
| Standing authority remains; ask only for genuinely new owner decisions | Checked, unchanged. The doctrine says "Never ask the owner for ordinary business decisions"; `record_external_dependency` accepts only human identity, KYC, legal signature, constitutional change or a non-delegable credential. After sales open, connected-channel API work needs no release (v81). | spec §34.5 |
| **Buyer consent for immediate digital delivery, on all supported purchase routes, with confirmation** | Every route the Fleet runs itself asks and records. A durable confirmation is sent. Etsy and Gumroad are stated as platform checkouts. | §2 |
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
| **Etsy** (owner's shop; Etsy's checkout) | **not recordable.** Etsy's checkout has no consent box and the Fleet must not automate the website. Buyers keep the 14-day right to cancel a download. | Etsy's receipt | owner decision §6 |
| **Gumroad** (merchant of record; locked until £500 per agent) | Gumroad's checkout, under Gumroad's terms | Gumroad's | verify before unlock §6 |
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
FLEET_RUNTIME_COMMIT=f890144ebc55b349c628b147137ba938c96c3075
FLEET_RUNTIME_BUILD_ID=b114eba574bf3f42b055ae91cdfe72d97f14dfc7f2a2d379c841532eaf467ba5   (independent local build)
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
UI 0.21.0: ui-0.21.0-f890144.tgz  sha256 57ffba56c42e6bd0773de1c2c52617d0c3fc9003d3e89aca3784bbba9969c77f  (52 files, LIVE build;
           clean-clone builds of 9fd3b73 and f890144 byte-identical)
```

- **Builds.** VPS `~/rlc82/pins.txt` (commit f890144, build `b114eba5…7ba5`, lockfile `1df54e35…a2c1`) equals the
  independent local build. The UI tarball is staged as `~/rlc82/ui-0.21.0-f890144.tgz` with the same hash.
- **Data rehearsal 81 → 82: PASSED** 2026-10-16 13:00:46Z, on a restored copy of production:
  - migrate-check wouldApply [82];
  - reconciliation OK: 812 journals; 2984 events preserved, none purged;
  - the ledger verifies;
  - a re-run is a no-op;
  - the rollback dump restores 81 with the same ledger head;
  - live untouched.
- **Services + rollback rehearsal: PASSED** 2026-10-16 13:17:02Z:
  - a712be1 refuses schema 82 (rollback must restore the database);
  - on 82 the candidate controller (all readiness checks), Operator API and dashboard are ready (login 200, signed-out 401);
  - Fleet Command and history are clean (0 copies);
  - the ledger head is unchanged; no reservation or birth;
  - rollback restores 81 with an identical ledger head, and a712be1 is ready again;
  - production PIDs unchanged.
- **Superseded:** 9fd3b73's data rehearsal also passed (12:42:24Z). The founder-upgrade rehearsal then found the trigger
  privilege bug, fixed in f890144; its artifacts are kept as `~/rlc82/*-9fd3b73.*`.
- **Valid until** 2026-10-17 13:00Z. Re-run both rehearsals after that.

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
3. **Founder runtime upgrade.** Purposes are recorded only after it. Agents stay paused.
   `sudo /opt/automaton-fleet/current/scripts/fleet-founders.sh upgrade-runtime <agentId>` (owner gate).
   - Rehearsed locally: b60e262 → tree 11/11.
   - Rollback: `fleet-founders.sh rollback-runtime <agentId> <upgradeId> <reason>`.

**What the deploy does not change:** agents stay paused and keep their AI fuses (754p/20h, 3000p/60h). Sales stay closed;
seller, site, rails, sweep, replication, capital, custody and permissions are untouched; the four flags stay false; cap 2.

## 6. Decisions for the owner
1. **Go for deploy** (§5), when the server rehearsals below are valid.
2. **Etsy digital downloads.** The Fleet cannot record consent on Etsy's checkout, so Etsy buyers keep the 14-day right to
   cancel a download. Either:
   - accept that, and refund on request within 14 days; or
   - sell downloads only on the own pages, using Etsy for physical or other items.
3. **Gumroad** (still locked). Before unlock, confirm how Gumroad records UK/EU buyers' consent, as merchant of record.
4. **Host recovery behaviour** (tested as it is today):
   - it does not end sessions already signed in;
   - it does not cancel recovery codes.

   The runbook says to use Sign out elsewhere and create new codes. Making the host authenticator reset also end every
   session is a small change, if wanted.
5. **Founder runtime upgrade** (§5 step 3): when to run it.

## 7. Tests (focused; no full suite)
| Area | Result |
|---|---|
| v82 sign-in recovery (server + client) | 6/6 |
| v82 host recovery (lost factors; owner-only; audit) | 7/7 |
| v82 consent, confirmations, helper jobs, privilege audit | 6/6 |
| v82 public consent pages (unit) | 3/3 |
| Browser e2e: real Chrome, virtual passkey, LIVE export (recovery codes, Forgot password, Lost authenticator, a desk waking from a recorded job, Launch & channels, no CSP violations) | 17/17 |
| UI: crew, roam, hub, command centre | 119 |
| Cognition routing + R23 mind (purpose required; helper record; tier unchanged) | 48 |
| Founder runtime upgrade b60e262 → tree (real processes) | 11/11 (1 skipped) |
| v43 sign-in (unchanged routes) | 17/17 |
| v76 market 9/9, v76 demonstrations 3/3, v56 delivery 7/7, PayPal custody worker, v53, v57, v58, v59, v51, v61, v68, v77, PayPal treasury, lifecycle | all pass |
| v78 / v79 / v80 | 21/21 |
| v81 + launch guide | 24/24 |
| UI contract + migration paths (old schemas → 82 clean) | 32/32 |
| Cognition routing PG, v62 conversations, v70 AI credit | 19/19 |
| Typecheck (root, UI), eslint (changed UI files) | clean |

**Pre-existing, not caused here:** two R41.1 assertions expect field guide v2.1, but the field guide is v2.2 (unchanged
since 7c35383).
