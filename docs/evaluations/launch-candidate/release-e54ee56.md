# Release e54ee56 — schema 72 → 73 (one-time historical AI-credit acquisition cost; CLI routing), UI 0.17.1 unchanged

Status: **DEPLOYED 2026-10-12 20:32:13Z** and the correction **APPLIED once at 20:32:31Z** (owner instruction: "You are
authorised to deploy this correction while both agents remain paused, with live flags and activation settings unchanged").
Both agents paused on b60e262; no reimbursement, no money moved, no spending activated.

## Pins (VPS build `~/rlc73/build.log`; an independent local build is identical)
```
FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
FLEET_RUNTIME_COMMIT=e54ee56e2a1e97ab0dcb0493d2e50d64b494025c
FLEET_RUNTIME_BUILD_ID=a86aa31bb5ea6f7e9ade8e63ce64456e9124933d467565f2c2ee2a2d12c5e4fb
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
```
UI `~/rlc73/ui-0.17.1-e54ee56.tgz` sha256 `c4e97e15…1160` (the live 0.17.1; UI sources unchanged since d63a595).

## Contents
- v73 (spec §28): the tax share of AI charges made before the AI-credit lots, once, by original attribution, posted by v72's
  cost pass from the opening pool's accrual (owner-funded → owed to the owner); unreliable attribution reported, never posted.
- CLI: the v66 – v72 capital-backing / AI-credit commands are routed from `fleet:admin` (a2d94cd), plus
  `economy-ai-credit-historical-preview` / `-cost`; a test fails on any unrouted handler.

## Validation (focused; unaffected validation reused)
v73 4/4 (refusals before evidence / opening / with non-reproducing figures; preview by payer with the unattributable
listed; agent bears its share, owed to the owner, pre-tax expense not recognised again; once; settlement does not re-price);
v69 3/3, v70 3/3, v71 5/5, v72 5/5, event routing 13/13, hub CLI 5/5, migration paths 2/2; tsc clean. Release tooling
unchanged since d63a595 (its tests reused).

## Rehearsal (20:30:02 – 20:30:25Z) PASSED; deployment 20:30:32 – 20:32:13Z (outage 20:31:23 – 20:32:06Z)
wouldApply [73]; reconciliation OK (2467 events preserved, 807 journals); ledger verifies; re-run no-op; rollback proof.
UI reused, already served (no switch, no restart). Agents' identity, ledger fingerprints and cash identical before/after.

## Historical correction (applied 20:32:31Z, actor operator:ubuntu)
Evidence: receipts $20 + $4 tax and $50 + $10 tax → credit 7000, charged 8400 USD cents (ratio 1.2; reproduces the opening
pool's recorded acquisition cost). Scope: every AI-charge journal before the lots (801; together the £18.24 of the v69 opening).

| Payer (original attribution) | Journals | Pre-tax base | Tax share | Posted | Carried with the opening pool |
|---|---|---|---|---|---|
| Agent-1 (01M3F50S…) | 643 | £13.59 | 271.8p | £2.71 | 0.8p |
| Agent-2 (01M4C4NX…) | 157 | £4.64 | 92.8p | £0.92 | 0.8p |
| Treasury (Fleet Control review) | 1 | £0.01 | 0.2p | £0.00 | 0.2p |

Unattributed: none. Attribution evidence: every agent journal's postings, agent and cognition record agree and every call
is Anthropic (847 cognition records, all Anthropic); the review's evidence is the controller's own Anthropic consumption.
Not part of the base (not recognised Fleet expense, so no tax share): the owner's evaluation / diagnostic runs (five
adjustments, $4.63, recorded as "not founder expense"); the sub-penny pre-tax remainders the agents' accrual never charged
(0.68p and 0.96p). A second application returns the first run (verified).

## After
- Wallets: Agent-1 cash £83.70 (was £86.41), Agent-2 £94.44 (was £95.36); both paused.
- Owner payable **£21.87** (£18.24 opening + £3.63 historical tax); nothing reimbursed.
- Capital backing: virtual capital £200.00, backed £0.00, **unbacked £200.00**; books cash £200.67 = PayPal £0.67 +
  £200.00 recorded capital; difference £0.00. Ledger verifies (809 journals).
- Survival protection on; custody activations 0; cap 2/2 DEVELOPMENT; all live flags false.
