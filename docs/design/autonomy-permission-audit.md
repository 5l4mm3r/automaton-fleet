# Autonomy / permission-gate audit (2026-10-02; schema v33, production v32 → v33 in R31)

Target: agents discover → decide → act → spend → build → sell → earn → reinvest → pivot → survive/fail; the owner is
not an operational manager; FleetController is bank / custodian / security / Treasury / shared-capital authority, never
a commercial manager. A blocked dependency blocks only the affected action.

Test for every restriction: does it prevent credential theft, fraud, replay, unauthorised access, corrupted accounting
or systemic failure (keep / re-scope), or does it only stop an agent taking a commercial risk with its own legitimate
capital (remove)?

## Matrix

| # | Gate | Location | Behaviour before | Risk to the experiment | Class | Fix | Test |
|---|---|---|---|---|---|---|---|
| 1 | Synthetic 25 % tax reserve without a tax profile | v29 `fleet_tax_for_sale`, `fleet_tax_policy` | every sale moved 25 % of net into a restricted reserve | removed survival capital with no real obligation | REMOVE | v33: 0 without a profile; CHECK pins 0; setter refuses; true-up releases | money-pg "v33: no legal entity…", static audit, sim |
| 2 | Legal entity required for a rail; rail matching requires entity equality | v29 `fleet_payment_rails.legal_entity_id NOT NULL`, `fleet_rail_match` | no rail without a company; no auto-assignment without one | conventional-business precondition | REMOVE | v33: entity optional; matched only when both name one | money-pg v33 test, sim (no entity, rails assigned) |
| 3 | Simulation premise: owner sets entity + tax profile before play | autonomy sim | game assumed a company | wrong model | REMOVE | sim runs with none | sim 6/6 |
| 4 | Controller own-capital sizing ("survival headroom", partial approval) | v30/v31 `fleet_experiment_evaluate` | resized founder budgets | commercial control | REMOVED (v31 fix) | custody-only | R24 constitution test |
| 5 | Owner resizing own-capital experiments | v24 `fleet_experiment_decide` | partial approval by owner | owner as commercial manager | RE-SCOPED (v31) | legacy WATCH resolve only, approve-in-full or reject | R24 test |
| 6 | Amount threshold deciding when withdrawal security applies | v10 strong-auth threshold | small owner withdrawals unconfirmed | security keyed to amount | REMOVED (v31) | confirmation for every withdrawal | launch test |
| 7 | R24 commercial evidence gate on own capital | v24/v30 | WATCH on evidence | commercial veto | REMOVED (v31) | evidence = information | R24 tests |
| 8 | Future children un-payable (runtime-held keys) | base `svc_activate` + v32 custody | child identity = runtime key → agent_held_key → never issued | only Founder 1 could ever transact | AUTOMATE | v33: keyless controller-custody identity at activation; runtime wallet recorded; self-approval + duplicate guards extended | phase2 (keyless, guard), phase6 dry-run, phase3 e2e |
| 9 | Vendor payees require owner enrolment | v10 destinations | owner enrolment + 3-day cooldown | owner approves every vendor | AUTOMATED (v29) | agent self-registers; controller validates format, scope, internal-counterparty, category, failsafe rate | money-pg vendor test, sim |
| 10 | Payment rail per venture | v29 `fleet_rail_resolve` | — | — | AUTOMATED | auto-assignment; a later rail answers the dependency | money-pg, sim |
| 11 | Provider account / KYC (e.g. Gumroad) | v29 rail requirement → dependency | one action-scoped dependency | — | KEEP (genuine KYC), scoped to one action | — | sim: A earns throughout with the dependency pending |
| 12 | Owner requests | v26 `fleet_owner_requests` | ordinary decisions could wait on owner (pre-v26) | owner as manager | RE-SCOPED (v26) | open = action-scoped exception only (CHECK) | f2a tests |
| 13 | Identity facts (`request_identity_fact`) | v11 | owner approves a legal-identity claim for a named workflow | — | KEEP (non-delegable legal identity), action-scoped | — | f2a |
| 14 | No live custody signer | v32 issuance | payment waits (`FLEET_NO_CUSTODY_SIGNER`) | — | RE-SCOPED: blocks that payment only | — | custody-signer-pg failure isolation |
| 15 | Credential revoked / missing | v32 `cx_credential_use` | payment fails closed | — | KEEP (security), scoped to that rail's payments | — | custody-signer-pg |
| 16 | Foreign currency | v29 settlement | settlement unattributed (`FX required`) | — | KEEP (ledger integrity), scoped to that settlement | — | money-pg orphan test |
| 17 | Crypto / credits destinations never through custody; destination reference must be the enrolled one | v32 | refused | — | KEEP (anti-fraud; owner's no-crypto rule) | — | custody-signer-pg |
| 18 | Self-keyed agents never paid by custody | v32 | refused | — | KEEP (key custody) | — | custody-signer-pg |
| 19 | Owner/Treasury withdrawal destinations (enrolment, cooldown, activation code, strong confirmation) | v10/v31 | owner action for owner money | — | KEEP (anti-fraud on owner money; not agent commerce) | — | ledger, launch tests |
| 20 | Fleet/shared capital | v30 capital engine, envelopes | controller decides; envelope rules | — | KEEP (Fleet lending authority) | — | capital-pg, sim |
| 21 | Infrastructure failsafes: cognition 754p/day + 20 turns/h per founder (~25× normal burn), research 300/day, vendors 20/day, records/opportunities/ventures ceilings | v13/v18/v28 policy | refuse beyond a runaway ceiling | could act as a budget if shown or tight | KEEP as runaway protection; never founder-facing | — | f2a "quota availability is never a reason", static audit |
| 22 | Spend circuit breaker | v27 | relative signals, unset | — | KEEP (anomaly/fraud), no nominal amounts | — | money-pg breaker test |
| 23 | Hold / freeze / kill switches / research pause | v8–v18 | incident controls | — | KEEP (security emergency) | — | phase tests |
| 24 | Runtime approval, founder runtime upgrades, schema migration | v6/v23 + runbook | owner/engineer-initiated | — | KEEP (supply-chain integrity); not a recurring operation | — | rehearsal tests |
| 25 | Replication, Genesis, population cap 50 | constitution | off | — | KEEP (constitutional) | — | doctor |
| 26 | Live-money activation (custody pin, rails not-live, REAL_PAYMENTS) | v10/v29 | pinned off | — | KEEP (final activation) | — | ledger, privilege audit |
| 27 | Operator API proposals | v9 | operators never approve; Tier-3 → owner | — | KEEP (security) | — | operator tests |
| 28 | TLS renewal | host | certbot timer + pre/post/deploy hooks | — | AUTOMATED (verified on the VPS) | — | — |

## Engineering / host permission path

Agent operation needs no human: wakes, cognition, research, settlement polling, the reaper, challenges, custody
attestation and certificate renewal are all unattended. Human touchpoints are engineering only: Claude Code's
permission classifier on production writes, the operator's SSH key, and the owner's choice to deploy. Narrow persistent
capability, not broad disabling: a root-owned release wrapper (the existing `scripts/fleet-*` steps, exact arguments)
with a single sudoers rule and one matching Claude Code allow rule would remove per-command prompts for routine,
rehearsed deploys. That is an `/etc` change and needs the owner's approval; it is recommended, not applied.

## Genuinely human-only actions

Provider accounts and KYC (e.g. PayPal, Gumroad), placing a provider credential in the custody vault, real-world
tax/legal obligations once real earnings create them, the live-money activation (`AUTHORIZE LIVE FINANCIAL
ACTIVATION`), and deploy approvals while the engineering interface requires them.
