# Completion matrix — the one authoritative baseline (2026-10-21)

Built from the master specification (MLS), the R41.1 acceptance matrix (AM), the launch checklist (LR) and the completion
package (LCP), reconciled with production and the latest candidate. Where they conflict, the owner's latest explicit decision
wins (conflicts resolved at the end). **OWNER** = the owner's decision (quoted, dated); **IMPL** = an implementation choice.

Production: a0bbf4e (schema 108) being installed 2026-10-20 23:19Z (Agent-1 2b7b490 → a0bbf4e). Next candidate: v109 (local,
618406d+). Agent-2 b60e262 paused throughout. Completed live evidence reused, never repeated: C1–C5 (phone sign-in, alarm
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
| Refund reconciled with fresh PayPal evidence | owner record | refund API COMPLETED + webhook 500p; balance 522p at 22:29Z (reporting lag); Search no row | **ext** | re-check PayPal; owner checks the account |
| Funding / refund cash (free cash negative while owed 811p) | **owner** | LCP C3 | owner | decide after reconciliation |
| Capital backing (£200 unbacked) | OWNER 2026-10-17 | economy-capital-backing | owner | activation D1 |
| Contextual capital; new agents need no history; partial funding; temporary sweep reductions | OWNER O8 / agreed | fleet-v77 sizing tests | done (live default fixed) | activation D3 |
| Net-profit sweep, adaptive bands | OWNER O10 | implemented, disabled | owner | activation D3 |
| Test-cost write-off | OWNER 2026-10-13 | separate decision | owner | only if wanted |

## C. Budgets and provider execution
| Requirement | Decided by | Where / evidence | Status | Remaining action |
|---|---|---|---|---|
| Model reservations = true cost bound (full request + output); overruns visible; run ends at the next unfit request | OWNER 2026-10-20 | costBoundMicro; v104 | done | — |
| Fleet Control spends nothing until its budget is set | IMPL (owner sets value) | A7, fleet-spend-review-v64-pg; budget unset | done | set at D6 |
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
| Buyer email joins the right order; obligations; replies by email | OWNER 2026-10-19/20 | v108 (fleet-v108-completion-pg) | done (tests) | **live** B1+B2 |
| Closed conversations (refund / 7 days / 10 msgs) on page AND email; closed-order mail kept for the owner | OWNER 2026-10-20 "Refund or 7 days"; 2026-10-21 "preserve them for owner review" | page: v108; email: **v109** | gap → fixed in v109 | install v109 |
| No cross-customer disclosure via subject / agent name / thread | IMPL | v108/v109 tests (other sender, stranger naming the agent) | done | — |
| Geography: worldwide, no exclusions; country recorded | OWNER 2026-10-20 | v108; capability status v15, Field Guide | done | tax: see dependencies |
| Seller legal details from verified records | OWNER | stored address "Albemarie" (owner, 10-17) | owner | re-save in HQ (C1) |

## E. Product quality
| Requirement | Decided by | Where / evidence | Status | Remaining action |
|---|---|---|---|---|
| Inspector in the real unit (LibreOffice, recalculation, displayed dates, rendering) | OWNER Repair A | R1, revision rehearsal 14/14 | done | — |
| Saved formula values: not a clean pass (any delivery or publication) | OWNER 2026-10-21 | public sale: v108; every review: **v109** | gap → fixed in v109 | install v109 |
| Money acceptance cases with independent expected results | IMPL | expected_results warning; money checks | done | — |
| Inspected checksum = published = delivered bytes | IMPL | review gate | done | — |
| The tracker's own defect fixed by Agent-1 | OWNER 2026-10-20 | sale block + notice | **live** | B1 |

## F. Card and protected identity
| Requirement | Decided by | Where / evidence | Status | Remaining action |
|---|---|---|---|---|
| Card = payment bypass, owner-paid card 1, reserved from agent cash, clearing liability, statement match once | OWNER O2/O16/O17/O19 | v48–v58, v88 | done (simulated) | **live** B3 |
| Receipts: return-or-withdrawal choice each time | OWNER 2026-10-08 | v58 | done | — |
| Fills never disclosure; no decrypted values to models/logs | OWNER O4 | broker vault | done | — |
| One pre-launch purchase (merchant, ≤ £5, expiry, cleanup); merchant account path; agent proposal path | OWNER 2026-10-20/21 | v108 release; **v109** account_register + capability status v16 | done in v109 | install v109; B3 |
| Standing identity + card authority at launch | OWNER O4/O11; 2026-10-11 "uncapped" | settings | owner | activation D5 |

## G. Lifecycle, visibility, recovery
| Requirement | Decided by | Where / evidence | Status | Remaining action |
|---|---|---|---|---|
| Cap 2; replication off; Agent-2 paused | invariant | verify scripts | done | — |
| Estates on death; credentials revoked | OWNER O7 | v51/v57 tests | done | — |
| Owner visibility: accounts, credentials, actions, liabilities, faults, uncertain ops | OWNER | HQ pages, events | done | — |
| Local freeze ≠ provider cancellation | OWNER O5 | v49 | done | — |
| Deploy/rollback preserves history (fix forward) | IMPL | rollout reconciliation; rehearsals every release | done | — |
| Backup + restore, monitoring, alerts | IMPL | LIVE 2026-10-17 | done | — |

## External dependencies (named, with evidence)
- **PayPal reporting lag** on the refund (balance 522p at 22:29Z; Search no row) — re-check; the owner's own PayPal activity view.
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
