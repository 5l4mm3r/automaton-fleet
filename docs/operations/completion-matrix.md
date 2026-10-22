# Completion matrix — the one authoritative baseline (2026-10-21)

Built from the master specification (MLS), the R41.1 acceptance matrix (AM), the launch checklist (LR) and the completion
package (LCP), reconciled with production and the latest candidate. Where they conflict, the owner's latest explicit decision
wins (conflicts resolved at the end). **OWNER** = the owner's decision (quoted, dated); **IMPL** = an implementation choice.

Production (2026-10-21 00:51Z, verified): controller **7ab848d, schema 109**; Agent-1 pinned to **a0bbf4e** (installed 2026-10-20
23:43Z, upgrade 667cf5b9…); UI 0.26.2; sales CLOSED; card authority off; no release or refund authority live. Agent-2 b60e262 paused throughout. Completed live evidence reused, never repeated: C1–C5 (phone sign-in, alarm
drill, outside monitor, backup + isolated restore, private publishing) and the C6 refund leg (Agent-1 refunded the owner's
£5 itself; the booking needed the human-approved v107 repair — disclosed).

Status: **done** (implemented + test or live evidence) · **gap** (implementation missing) · **ext** (external dependency) ·
**owner** (owner decision or action) · **live** (needs live evidence after install).

## A. Agent execution, autonomy, survival
| Requirement | Decided by | Where / evidence | Status | Remaining action |
|---|---|---|---|---|
| Autonomous operator loop (research → offer → build → inspect → publish → sell → deliver → support → funds) | OWNER 2026-10-15 "autonomous business operator" | v79 tests; live: private publishing (C5), delivery + refund (C6) | done (live for one order) | sales opening |
| Every founder step on Opus, effort high | OWNER 2026-10-20 "Opus for … customer facing" | v102 router founder_work; verify checks | done | — |
| Context keeps essential messages, notices, obligations; slim packets | IMPL | fleet-founder-work-continuity, r41-1 | done | — |
| Actionable refusals; platform faults owner-visible (AGENT_TOOL_FAULT) | OWNER 2026-10-19 Repair A | v100 R2 tests; mind-report refusals | done | — |
| Continuity across interrupted turns, restarts, upgrades; upgrade wake | IMPL | e1c51e2; founder upgrade/revision rehearsals (real units) | done | — |
| Event wake; zero-call waiting; bounded repeated failures | IMPL | v67/v68, d2a2e7a; 8× same refusal stops proofs | done | — |
| Buyer obligations visible until resolved; no sleep while a buyer waits | OWNER 2026-10-19 | v100 obligations-pg; live C6 | done | — |
| Death = wallet exhaustion; one measure; no grace periods; pending captures not owned | OWNER O7 | fleet-completion-v51-pg (A8) | done | — |
| Survival protection → live at launch | OWNER O18 | setting | owner | activation D2 |

## B. Treasury, wallets, capital, sweeps
| Requirement | Decided by | Where / evidence | Status | Remaining action |
|---|---|---|---|---|
| Treasury = owner PayPal; wallets = ledger partitions | OWNER O1/O15 | £1 test, C6 | done | — |
| Atomic reservations, fixed lock order, concurrent workers | IMPL | v96 "two custody workers", v95 durable ops, v66–v91 | done | — |
| Durable duplicate protection; uncertain outcomes held | IMPL | v95 (14 tests); C6 retries reused the PayPal-Request-Id | done | — |
| Integer money, explicit rounding; platform-calculated quotes/invoices; customer money checks | OWNER 2026-10-20 | v105 (money checks 11, v100 PG) | done | channel/browser text not checked (recorded limit) |
| Liquidity gate on every real outflow | IMPL | v77 | done | — |
| AI cost = usage + credit acquisition tax/fee; owner-funded credit reimbursable | OWNER 2026-10-12 | v69–v73; live journals | done | — |
| Proof refund booked as owner capital, once | IMPL | C6 + v107 regression (fleet-v96 refund suite) | done | — |
| Refund reconciled with fresh PayPal evidence | owner record | capture 6JF13918S8462694B (T0006 +500p); refund 841606975U696002C: API COMPLETED, webhook 500p, Search T1107 −500p (fee 0); balance 522p → **22p** (00:50:36Z, after a reporting lag); one refund journal; capital-backing difference **0** | **done** | owner may confirm in PayPal Activity (refund details / funding source) |
| Funding / refund cash: PayPal 22p, owed to the owner 811p → free cash −789p (every ordinary refund would wait) | **owner** | treasury liquidity, 00:50Z | owner | activation: reimburse, add funding, or a standing rule |
| Capital backing (£200 unbacked) | OWNER 2026-10-17 | economy-capital-backing | owner | activation D1 |
| Contextual capital; new agents need no history; partial funding; temporary sweep reductions | OWNER O8 / agreed | fleet-v77 sizing tests | done (live default fixed) | activation D3 |
| Net-profit sweep, adaptive bands | OWNER O10 | implemented, disabled | owner | activation D3 |
| Test-cost write-off | OWNER 2026-10-13 | separate decision | owner | only if wanted |

## C. Budgets and provider execution
| Requirement | Decided by | Where / evidence | Status | Remaining action |
|---|---|---|---|---|
| Model reservations = true cost bound (full request + output); overruns visible; run ends at the next unfit request | OWNER 2026-10-20 | costBoundMicro; v104 | done | — |
| Fleet Control spends nothing until its budget is set; a triggered review then BLOCKS (pending, never approved) | IMPL (owner sets value) | A7, fleet-spend-review-v64-pg; budget unset; v110 adds clear | done | card proof: a bounded review budget set and cleared by launch-checks; launch value at D6 |
| Paid search charged to the agent, reserved first | IMPL | media gateway (stopped) | done | restart at D6 |
| Purchases: reservation + contextual review (no caps) | OWNER O19 | v64/v77/v88 | done | — |
| Card proof: authorisation prevents (caps, one-purchase release), watchdog only cleans up | OWNER 2026-10-20 | v108 card release; launch-checks tests | done | live B3 |
| Per-run all-in maxima shown separately | OWNER 2026-10-20 | LCP B terms | done | approve terms |

## D. Customer purchase, fulfilment, support
| Requirement | Decided by | Where / evidence | Status | Remaining action |
|---|---|---|---|---|
| Offer/order pages as service role; official PayPal checkout; consent; states | OWNER 2026-10-16 (consent) | v96–v99 tests, browser journeys; live C6 | done | — |
| Replacing unusable PayPal orders without double capture | IMPL | v98 lifecycle (10) | done | — |
| Reviewed bytes = delivered bytes | IMPL | review gate; C6 checksum f45c3d00… matched | done | — |
| Buyer email joins the right order; obligations; replies by email | OWNER 2026-10-19/20 | v108 (fleet-v108-completion-pg) | done (tests) | **live** B1+B2 after v110 |
| Closed conversations (refund / 7 days / 10 msgs) on page AND email; closed-order mail kept for the owner, per conversation | OWNER 2026-10-20 "Refund or 7 days"; 2026-10-21 "preserve them for owner review"; 2026-10-21 "Closing one order should not prevent that customer from contacting Agent-1 about a new enquiry" | page: v108; email: v109 (address-wide: a defect) → v110 e151095 (thread-linked or ambiguous → owner; new enquiry → agent; tests) | done (repo; rehearsed) | install v110 |
| No cross-customer disclosure via subject / agent name / thread | IMPL | v108/v109 tests (other sender, stranger naming the agent) | done | — |
| Geography: worldwide, no exclusions; country recorded | OWNER 2026-10-20 | v108; capability status v15, Field Guide | done | tax: see dependencies |
| Seller legal details from verified records | OWNER | stored address "Albemarie" (owner, 10-17) | owner | re-save in HQ (C1) |

## E. Product quality
| Requirement | Decided by | Where / evidence | Status | Remaining action |
|---|---|---|---|---|
| Inspector in the real unit (LibreOffice, recalculation, displayed dates, rendering) | OWNER Repair A | R1, revision rehearsal 14/14 | done | — |
| Saved formula values: not a clean pass (any delivery or publication) | OWNER 2026-10-21 | public sale: v108; every review: v109 (installed) | done | — |
| Money acceptance cases with independent expected results | IMPL | expected_results warning; money checks | done | — |
| Inspected checksum = published = delivered bytes | IMPL | review gate | done | — |
| The tracker's own defect fixed by Agent-1 | OWNER 2026-10-20 | offer PAUSED since 2026-10-20 21:03Z (Agent-1 changed its files; review d06474be… no longer covers them; current xlsx f45c3d00… has unsaved values) | **live** | workbook/email check (361p) |

## F. Card and protected identity
| Requirement | Decided by | Where / evidence | Status | Remaining action |
|---|---|---|---|---|
| Card = payment bypass, owner-paid card 1, reserved from agent cash, clearing liability, statement match once | OWNER O2/O16/O17/O19 | v48–v58, v88 | done (simulated) | **live** B3 |
| Receipts: return-or-withdrawal choice each time | OWNER 2026-10-08 | v58 | done | — |
| Fills never disclosure; no decrypted values to models/logs | OWNER O4 | broker vault | done | — |
| One pre-launch purchase (merchant, ≤ £5, expiry, cleanup); merchant account path; agent proposal path | OWNER 2026-10-20/21 | v108 release action `card`; v109 account_register + capability status v16 (installed; PG-tested, migration-rehearsed, not yet exercised live) | done (code) | Agent-1's merchant proposal, then the card check (741p; at the 500p ceiling: 542 bp share → routine, no review) |
| Standing identity + card authority at launch | OWNER O4/O11; 2026-10-11 "uncapped" | settings | owner | activation D5 |

## G. Lifecycle, visibility, recovery
| Requirement | Decided by | Where / evidence | Status | Remaining action |
|---|---|---|---|---|
| Cap 2; replication off; Agent-2 paused | invariant | verify scripts | done | — |
| Estates on death; credentials revoked | OWNER O7 | v51/v57 tests | done | — |
| Owner visibility: accounts, credentials, actions, liabilities, faults, uncertain ops | OWNER | HQ pages, events | done | — |
| Local freeze ≠ provider cancellation | OWNER O5 | v49 | done | — |
| Deploy/rollback preserves history (fix forward) | IMPL | rollout reconciliation; rehearsals every release | done | — |
| Backup + restore, monitoring, alerts | IMPL | LIVE 2026-10-17; the heartbeat flagged disk ≥ 90 % from 2026-10-20 and failed at 100 % (alerted) | done | — |
| Release retention (2026-10-21 incident: 84 releases filled the 72 GB disk; v109's first cutover failed "No space left on device", rolled itself back, nothing changed) | IMPL | 78 old releases + 79 stage copies deleted with the owner's approval (49 GB free); fleet-release.sh now refuses below 4 GB free; scripts/fleet-release-prune.sh (dry run default; keeps current, pinned, newest N — fleet-release-script, fleet-release-prune tests + rollback targets (controller OLD=, agents' latest upgrade from_commit), fail-closed --apply | done (repo; staged ~/fleet-release-prune.sh; production dry run: 0 to prune) | owner step after each release: dry run, check keep list, --apply. Agent-2's rollback build 973e0c1 deleted in the cleanup — restored and verified 2026-10-21 |

## External dependencies (named, with evidence)
- **PayPal reporting lag** (resolved 00:50Z): the balance and Transaction Search lagged the refund by ~3.5 h; reconciliation
  waits for them by design.
- **EU/UK VAT on digital sales** — the owner accepted the obligations (2026-10-20); recording the buyer's country is
  evidence, not compliance: registration/filing (e.g. EU OSS) is the owner's, outside the Fleet.
- **PayPal webhook** for refunds was observed live (500p on 841606…); webhook for payments: not relied on (status polling).
- **Browser loopback isolation** (MLS §32.9) — a host step needing sudo and the owner's go; not a launch blocker for
  supported channels.
- Deferred / unconnected (never blockers): Etsy, Pinterest, Gumroad, SMS, image generation, software maintenance, bank feed,
  EU merchant of record, UptimeRobot.

## Conflicts resolved (owner's latest decision wins)
1. EU sales: "worldwide, EU included" (2026-10-20) supersedes "no digital sales to EU consumers" (LR §1 D) — corrected.
2. Geography build: v108, not "v97" (LR A10) — corrected.
3. Card "uncapped" (LR §5) is the standing authority at launch; the pre-launch proof is one purchase ≤ £5 (temporary).
4. Production identity: the LR §1 A header (cb23033, v96) is history; current state is this file's header.
5. The MLS "nothing deployed" banner (rev 3, 2026-10-08) is superseded by the release records.

## 2026-10-22 — runtime reliability pass (repo only; uncommitted; NOT built, rehearsed or installed)
Against the launch handoff of 2026-10-22 (§6B, §10). Production unchanged: 3387596 still NOT installed (its rehearsals are
> 24 h old; re-rehearsing makes paid model calls and needs the owner's approval). These changes stack on 3387596 and would
replace it as the next Agent-1 runtime candidate.

| Requirement (handoff) | Change | Proof (fails on a1fd2c8, passes now) | Status |
|---|---|---|---|
| §6B every exit path keeps working state | a turn stopped by a refused/failed model call (run budget, run ended, provider error) carries its record (`stopCode`), progress memory, wake declaration and stall count | work-continuity 1f | done (repo) |
| §6B restart/deploy | SIGTERM reaches the turn; it stops between steps with its record carried (`FLEET_RUNTIME_STOPPING`) | work-continuity 1g | done (repo); a step already in a model call can still be killed by TimeoutStopSec=20s |
| §6B events not lost | the events cursor does not advance past events shown to a turn that died; past 8 unseen events the rest are counted by kind; a full list says older ones may exist | work-continuity 1f; events-overflow (5) | done (repo); a per-event acknowledgement table is NOT built |
| §6B repeated semantic actions | temporary paths and pids no longer make a result "new" (checksums still do); the 3rd identical result (across turns, persisted) gets a platform change-tactic note | work-continuity 1h, 1i | done (repo) |
| §6B bounded output | a cut tool result says how much was cut and how to read the rest | events-overflow (cut) | done (repo) |
| §10 just-in-time retrieval | `read_knowledge` takes query / category / limit (deterministic ranking within the latest 50 current lessons) | knowledge-successor-pg | done (repo) |
| §10 successor acceptance | a fresh agent B finds agent A's promoted lesson by its own question through its toolbox and the real controller function | knowledge-successor-pg | done (repo) |
| v68 suite failing since v96 | test setup sets Fleet Control's test budget (the code was right) | v68-wake-lessons-pg 7/7 | done |

Open, needing owner decisions (economic policy — not implemented): exact wallet-zero death measure; survival protection
(on by default: exhaustion is indefinite dormancy today); treasury-paid owner conversation turns for an exhausted agent;
cognition reservations purged after 5 min leave late usage unbooked and charges are capped at the reservation; customer
obligations of a dead agent have no formal hand-over; journal lessons tagged candidate_fleet are not harvested at death;
unset Fleet Control budget leaves lesson proposals waiting with no notice to the proposer.

## 2026-10-22 — v111 cognition settlement integrity (repo only; NOT built, rehearsed or installed)
Launch review 2026-10-22 §1 ("Five minutes may expire permission to start work; it cannot make already incurred costs disappear").

| Defect | Reproduced on v110 (43790e2, ephemeral PG) | v111 | Proof |
|---|---|---|---|
| Reservation > 5 min old DELETED by the next authorisation; the late result → FLEET_COGNITION_NOT_AUTHORIZED: no log row, no charge, no provider-credit consumption | yes (cash unchanged, consumption 0, no log row) | kept as an unresolved hold (`expired_at`): held against the agent's cash/equity and provider credit, P1 `cognition_reservation_unresolved`; the late result settles it by request id exactly once | fleet-v111-cognition-settlement-pg 1 |
| Recording any call deleted EVERY reservation of the agent | yes | only that request's reservation; table re-keyed by request_id; one LIVE reservation per agent enforced by a partial unique index | v111 1 |
| Cost above the reservation charged only up to it; excess booked to no one | yes: 16,000,000 ledger-µ cost, 1,000,000 charged, 15,000,000 unbooked | excess recorded as a cost exception (P1); that agent's further paid calls refused (`FLEET_COGNITION_COST_EXCEPTION`) until the owner allocates it (agent or treasury; one journal, rounded up) | v111 2 |
| A result that never comes | — | owner resolves from provider evidence: `economy-cognition-resolve <req> billed|not_billed <evidence>`; billed = settled at the reservation as an estimate, once | v111 3, 4 |
| Late settlement after the agent's cash moved would fail the write (non-negative cash) and lose the record | — | charged as far as cash allows; the rest is an `uncollectable` exception | code path; not yet a dedicated test |
| v62's treasury-paid copy (`fleet_cognition_authorize_treasury`) had the same purge | — | same expiry rule | v111 suite + conversations-v62-pg |

Regression: 10 cognition / AI-credit / conversation suites, 109 tests pass; privilege audit clean; tsc clean.

**Production history (read-only query, 2026-10-22 ~23:5xZ, schema 110):** 5 overruns, all Agent-1, all T2, all reserved at a flat
8p before v104's true cost bound (applied 2026-10-20 17:15Z); none in the 119 provider-priced calls since. Excess (SQL):
fdf03fc6 299,847 · 34135575 339,329 · a9af7460 452,562 · a23949ec 393,321 · d9121ac0 463,735 ledger-µ (GBP; FX 0.749889)
= **1,948,794 ledger-µ ≈ 1.95p**, absorbed by owner-funded provider credit with no owner-payable leg. Allocation is the
owner's: per-row rounding up = 5p; aggregate rounding up = 2p; or record as fleet expense. Nothing posted.
No open reservations and no helper job ended without a result: no purged late result is visible in the database; non-helper
calls can only be checked against the provider console (not done).

Added 2026-10-23 (review: "resolve outstanding holds before enabling death"):
- An agent-paid model call not yet settled (live or an unresolved hold) counts as the agent's own money still held
  (`modelCallsUnsettledMinor`): the agent is not exhausted while it is open; its estate refuses to settle (FLEET_ESTATE_PENDING).
- **Third leak found by the new death test:** v13's `fleet_agents_cognition_stop` DELETED every reservation of an agent at
  its end, so a bill arriving after death was lost and the estate settled without it (reproduced: estate settled, 10,000
  minor units of cash to the treasury, the hold gone). Now the reservations stop being live but stay as holds.
- New tests (asserting amounts): a hold blocks exactly its amount and its release charges nothing; two late results and the
  owner's resolution in parallel → one log row, one charge, the newer live call untouched; a late charge after death lands on
  the estate's cash, then the estate settles. v111 suite 8/8; 14 lifecycle/estate/cognition suites, 138 tests pass.
Open: automatic reconciliation from provider evidence (owner resolution is the fallback, not the routine); the death measure
is still the owner's decision.
