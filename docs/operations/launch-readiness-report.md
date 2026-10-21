# Launch-readiness report (2026-10-21 01:00Z)

Not a claim of 100 % reliability: a connected, tested operating loop with the remaining live evidence and owner decisions
named. Detail per requirement: docs/operations/completion-matrix.md.

## Production (verified 00:51:04Z, 51 read-only checks)
Controller **7ab848d** (schema 109) · Agent-1 **a0bbf4e** (paused; rollback upgrade 667cf5b9…) · Agent-2 b60e262 (paused) ·
UI 0.26.2 · sales CLOSED · card authority OFF · no outward release, refund authority or payout activation · spend breaker
not tripped · paid search (media gateway) stopped · ledger verifies · privilege audit clean.

Incident 2026-10-21 00:37Z: the first v109 cutover failed with "No space left on device" (84 retained releases filled the
72 GB disk) and rolled itself back before any outage. With the owner's approval 78 releases and 79 stage copies were
deleted (kept: a0bbf4e, b60e262, 597acc1, 2b7b490, 98d46c6, 7ab848d); 49 GB free; the retry installed cleanly. Prevention:
fleet-release.sh refuses below 4 GB free; fleet-release-prune.sh (repo, next kit).

## Modules
| Module | State | Remaining |
|---|---|---|
| A. Agent execution, autonomy, survival | done (live for one order: publish, deliver, answer, refund) | survival "live" at activation |
| B. Treasury, wallets, capital, sweeps | done; the £5 refund **reconciled** (capture 6JF13918S8462694B; refund 841606975U696002C: API, webhook, Search T1107; balance 522p → 22p; backing difference 0) | funding decision; capital backing; sweep and contextual sizing at activation |
| C. Budgets and provider execution | done (cost-bounded reservations; Fleet Control budget unset = no spend; card caps + one-purchase release) | budgets at activation |
| D. Purchase, fulfilment, support | done (checkout, consent, country step, delivery, closed conversations on page and email, buyer email joins the order) | live email check; seller address re-save |
| E. Quality | done (real-unit inspection; unsaved values never pass) | Agent-1 fixes its own tracker (live check) |
| F. Card and identity | done in code (pre-launch exception installed, PG-tested, migration-rehearsed) | Agent-1's merchant proposal → card check |
| G. Lifecycle, visibility, recovery | done (backups, restore, monitoring; disk alert fired) | prune after releases |

## Proposed: the workbook + email check (NOT approved by this report)
`bash ~/launch-checks.sh checks 300 6 <your email>` — one run of Agent-1, sales closed:
- **Scope.** Agent-1's offer is **paused** (since 2026-10-20 21:03Z: it changed the files; its passing review d06474be… no
  longer covers them; the current Landlord_Compliance_Tracker.xlsx f45c3d00… saves 1,194 formulas without values). Agent-1
  works on it on its own; success needs ITS new review to pass (cached_values, displayed dates, rendering pass — v109 refuses
  otherwise) and the offer republished with no sale block. The email leg: you write to fleet.treasury@proton.me with the
  subject "Agent-1 - …"; Agent-1 may mail your address only (a release for mail to it, expiring with the run); success
  needs your mail routed to Agent-1 and its reply sent after it.
- **Excluded by authorisation, not by a watchdog**: purchases (spend circuit breaker tripped), paid search (media stopped),
  card (authority off), every other outward action (no release), sales (closed).
- **Maximum (computed from the credit lots)**: 300p model usage + 61p acquisition tax/fee = **361p**; Fleet Control 0p
  (budget unset); purchases 0p. The run budget is a hard ceiling; the watchdog stops the run at success or its end.

## Pending: the card proof (NOT requested yet)
Needs Agent-1's own merchant proposal first (capabilities op request — capability status v16 tells it how). It uses the
**rehearsed pre-launch exception**: the release action `card` (v108) with the merchant-account path (v109) — installed and
verified in production, tested in PostgreSQL and in the disposable migration rehearsals, never yet exercised live.
**Authority**: your owner-only release (economy-outward, approver fleet_treasury) naming ONE purchase at ONE merchant (origin
+ account or registration there, ≤ £5, ≤ 24 h) plus your standing card authority switched on with the same cap
(owner-identity-autonomy) — both set by `launch-checks.sh card` on your approval and switched off at its first outcome.
The database enforces the one purchase, merchant, amount and expiry; the card caps enforce per-charge/day; the reservation
comes from Agent-1's own cash (9,213p; 450p = 4.9 % < the 25 % review threshold, so no Fleet Control AI review is
expected). Maximum: 200p usage + 41p tax/fee + ≤ 500p card = **741p**.

## Remaining blockers and owner decisions
1. The workbook + email check (approval; 361p).
2. Agent-1's merchant proposal, then the card check (approval; 741p).
3. Seller address: re-save "Albemarle Street" in Fleet HQ → Seller (step-up).
4. Funding: PayPal 22p, owed to you 811p → free cash −789p (every ordinary refund would wait).

## Activation package (after 1–4; each its own approval)
1. Reconciled funding and capital backing (£200 unbacked); treatment of the 811p owed to you.
2. Agent-1 AI fuses; Fleet Control daily AI budget; paid search (restart the media gateway).
3. Standing refund authority (custody refunds on); standing identity and card authority.
4. Contextual capital (history where it exists; none required) and the net-profit sweep.
5. Launch boundary; Agent-1 survival live.
6. Supported sales: Fleet offer pages + treasury PayPal checkout, worldwide; customer-facing seller details.
7. Open sales; resume Agent-1 only. Agent-2 stays paused; replication off.
