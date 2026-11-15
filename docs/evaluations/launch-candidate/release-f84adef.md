# Release f84adef — FROZEN candidate, VPS-prepared: schema 75 → 76 + UI 0.19.0 + founder-v7

Status: **PREPARED — VPS build equals the local build; data and service/rollback rehearsals PASSED; toolchain trial PASSED on
the production kernel; live state read (read-only). Not deployed.** Production unchanged: 1945915 / schema 75 / UI 0.18.0; cap
2, DEVELOPMENT; REAL_REPLICATION / REAL_PAYMENTS / OWNER_SWEEP / DRY_RUN_CHILD false, remote listen true; both agents paused
on b60e262. Supersedes `release-d978ee6.md` (its content stands except where amended here). Nothing is authorised here.

## Pins — VPS `~/rlc76/pins.txt` = independent local build
```
FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
FLEET_RUNTIME_COMMIT=f84adef873b686a9e384800bd8c7710b97d105eb
FLEET_RUNTIME_BUILD_ID=f816fc8e8d3bfbbca0b97f2a497e4e2dff70698681dcd49805d2fbf9ee3f7751
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
```
UI `~/rlc76/ui-0.19.0-f84adef.tgz` sha256 `890f7b078ca2106dbb6151126716162113a72ed7d60ea7f9c44d32b6af7b244e` (verified on the VPS; byte-
identical to every clean build since 6ad4bd7). Release scripts in `~/rlc76` copied from the commit, unchanged since `~/rlc75`.

## Changes since d978ee6 (f84adef)
- **Proof refunds follow what PayPal actually takes.** A refund webhook's returned fee (gross − `seller_payable_breakdown.net_amount`)
  is evidence (as Search's T1108 is; the larger counts once); for a proof the fee return may give back the capture fee (derived
  exactly from the capture journal) and posts D treasury / C owner capital. Restated from the latest definitions: evidence (v59),
  reconcile (v58), return (v57).
- **Preparation hold.** While the public site is set and sales are not open, outward agent operations are refused
  (FLEET_PREPARATION_HOLD): mail.send, sms.send, phone.provision, browser.act, account.create / operate / register, storefront
  publishing, card.request. Reading, research, building, reviewing and publishing (not public) continue.

## VPS evidence (2026-10-14)
| Step | Result |
|---|---|
| Build (`~/rlc76/build.log`) | `f816fc8e…7751` / `1df54e35…` = local build |
| Data rehearsal 75 → 76 (`rehearse.log`, 16:00:54–16:01:12Z) | PASSED: restore row counts identical; wouldApply [76]; reconciliation OK (812 journals; 3060 events preserved; only role-grant events appended); ledger verifies; re-run no-op; rollback dump restores 75 with the same ledger head; live untouched |
| Services + rollback rehearsal (`upgrade-rehearsal.log`, 16:01:19–16:01:44Z) | PASSED: 1945915 refuses schema 76; candidate controller / Operator API / dashboard ready on 76; reads invent nothing; ledger head 849 unchanged; rollback restores 75; 1945915 ready again; production PIDs untouched |
| Toolchain trial (`tools-install.log`, user prefix, no sudo) | 22 wheels, every sha256 verified; lock `8d67c301…04a2` = local; verify ok, 22 modules import. Tree digest differs from the dev install **only** in `bin/fleet-python` (it embeds its own prefix); the other 4,255 files are byte-identical. Production prefix: `/usr/local/lib/automaton-fleet-tools/8d67c30121df` |
| Sandbox on the production kernel (`sandbox-trial.log`) | kernel 6.8.0-136, LSM includes landlock; sandbox active, parent directory read denied; the three sale-ready builds ran inside it; inspector: all 4 deliverables PASS with no warnings, acceptance cases included |
| Public routing | edge: SNI `admin.agentfleet.vip` → dashboard; everything else → controller 127.0.0.1:8443 (TLS passthrough, PROXY protocol, IPv4 :443); no path filtering. Today `/o/…`, `/order/…`, `/enquiry/…` → 404, `/healthz` → 200 |
| Custody return URL | already `https://api.agentfleet.vip/v1/paypal/return` (cancel: `/v1/paypal/cancel`); v76 sends each buyer to `/order/<token>` on that origin — **no settings change needed** |
| Founder upgrade rehearsal on the VPS | not runnable before deployment (it runs from the installed release); local b60e262 → candidate 11/11 |

## Live state (read-only, 2026-10-14 ~16:05Z)
- **Treasury and backing**: PayPal £0.67 (total = available, 15:19Z); books £200.67; **unbacked £200.00**; difference 0; owner
  payable £0. Wallets Agent-1 £100.00, Agent-2 £100.00 (virtual, unbacked).
- **AI credit**: one owner-funded lot (owner card), **$41.29 remaining**, unused since 2026-10-12 (agents paused); policy
  owner_card; auto-reload not recorded; nothing tops up automatically.
- **Rail** b71b3f3c: live, **active**, capabilities receive_payments, refunds, payouts (payouts not usable: money-out off).
- **Webhook**: app webhook `4JR443408B058674D` → GET **200**, URL ours, all required events subscribed (the 10-10 404 is gone).
  PayPal generated the £1 test's events (10-10 17:43, 19:58; webhook set 17:07), but **no delivery ever reached the controller**
  (0 verified in the inbox; controller and edge logs show no PayPal POST). Delivery is **unverified**; the resend test below decides it.
- **Transaction Search**: a live row was recorded (10-10 21:53, the £1 test, fee 33p) — the reporting permission works. The probe's
  last-hour window answers 404 (inference: an empty recent window; verified by the proof refund).
- Survival protection ON; custody execution off; launch boundary not recorded; fuses Agent-1 754p / 20 h, Agent-2 3000p / 60 h.

## Proof accounting (verified locally, `fleet-v76-market-fulfilment-pg`)
£15.00 proof, PayPal fee £0.60: capture → owner capital +£14.40, treasury +£14.40. Refund (webhook) → −£15.00 / −£15.00. Fee
given back £0.40 (webhook gross − net) → +£0.40 / +£0.40. Same refund and fee again from Transaction Search → nothing. **Net:
owner capital −£0.20 = exactly the fee PayPal retained; treasury moved by exactly what PayPal debited.** Reversal after a full
refund posts nothing; nothing ever posts to the agent. Availability: a proof is owner capital, never held as the agent's pending
cash; backing compares PayPal's total with the books, so capture and refund move both equally (difference stays 0 while PayPal
holds funds); with money-out off nothing can spend it. Live check after the proof: Balances (total / available) vs books.

**Pre-existing, agent sales (for your review, not changed):** v58 caps a fee return at fees clawed back later, so the capture fee
PayPal returns on a refund of an *agent's* sale is never credited back: that agent's books under-state the treasury by the
returned fee (visible as a backing difference). Fixing it changes agent accounting — your decision.

## Activation settings mapped to the intended autonomous model
| Model capability | Mechanism | Now | Receive-only launch | Full autonomous operation |
|---|---|---|---|---|
| Receive payments into the treasury | rail receive_payments, custody worker, return URL | ready | ✓ | ✓ |
| Detect purchase / refund / dispute / reversal | webhook delivery; Transaction Search; status polling (purchases) | webhook configured, delivery unverified; TS works | purchase + refund verified live | all four (dispute / reversal: webhook only) |
| Publish real work, sell it | toolchain; founder-v7; public site + seller notice; `economy-sales open` | none yet | ✓ | ✓ |
| Act outward (mail, web actions, accounts, outreach) | preparation hold lifts when sales open | — | ✓ (at launch) | ✓ |
| Pay suppliers, ads, refunds, payouts | REAL_PAYMENTS_ENABLED=true; PayPal Payouts approval; custody signer attested; `economy-custody-activate` | off | ✗ | **required** |
| Card where PayPal is not accepted | card on file; standing card authority; `card.request` | off | ✗ | required (last resort) |
| Sign up and verify with your identity | standing identity authority (live) | off | ✗ | required for new platforms |
| Autonomous spending, automated review | v64 review, Fleet Control model (T2) | in place | n/a (nothing can be paid) | ✓ |
| Sweep on net profit | `economy-sweep-policy` | off | ✗ (no profit yet) | required |
| Exhaustion is death | survival protection | ON | your decision | model: OFF eventually |
| More channels | Gumroad per agent at £500; Etsy not built; EU consumer route undecided | deferred | ✗ | later / decision |
| Scale | cap 2, DEVELOPMENT, replication off | unchanged | unchanged | later, separate approval |
**Receive-only is not full launch**: agents could sell and deliver but not pay for anything (ads, tools, suppliers, refunds).

## Two different limits (unchanged)
AI runaway fuses (`founder-cognition --daily-budget / --turns-per-hour`; 754p / 20 h and 3000p / 60 h) stop a malfunctioning loop
from burning provider credit; they are not allowances. Economic spending caps limit money leaving the treasury; no money leaves
while payments and custody execution are off; when money-out is enabled, `economy-custody-activate <maxInstructionMinor>
<maxDailyMinor> <hours> <reason>` sets them (your 2026-10-11 decision removed fixed agent caps; these are the custody guardrails).

## Validation (this round; affected only)
v76 7/7 · demonstrations 3/3 · foundation 4/4 · v57 6/6 · v58 4/4 · v59 3/3 · custody worker 7/7 (fee-return evidence) ·
treasury 10/10 · comms 5/5 · browser 6/6 (hold does not touch them) · migration paths 2/2 · tsc clean. Founder runtime unchanged
since d978ee6 (local founder rehearsal 11/11 stands). All money / buyer evidence is simulated until the proof.
