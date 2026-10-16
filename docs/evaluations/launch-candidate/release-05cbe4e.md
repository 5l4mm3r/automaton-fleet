# Release 05cbe4e (packages P2 + P3, with the P1 follow-ups): schema 81 → 87 + UI 0.22.0 · CANDIDATE, NOT DEPLOYED — DO NOT DEPLOY AS THE MONEY-HANDLING RELEASE

> **Launch blocker found after the freeze (§5.1):** an unfunded late or larger card charge is rejected by the books
> instead of recorded. The corrected candidate is being built on branch `fleet/final-v2.5` (schema v88). This package's
> rehearsals passed and its evidence is kept, but it is superseded for money handling.

**Status:** frozen candidate (`docs/design/completion-master-checklist.md`).
- It contains everything in bbfb24a (P0, v82) and f47ee1c (P1, v83), plus v84–v87 and UI 0.22.0.
- Both earlier packages stay frozen and separately deployable (`~/rlc82`, `~/rlc83`). This one is staged in `~/rlc87`.

Nothing was deployed, installed, connected, enabled or funded. No account was opened, no subscription bought, no agent
resumed. Agent-1 launches first; Agent-2 stays paused.

## 1. Contents
| Area | What | State |
|---|---|---|
| P1 follow-ups (v84) | unresolved push alerts stay visible; Pushover limits; recovery drill with sample files; key-recovery procedure | built, tested |
| P1 defect fix | the push and media units now start without keys ("not configured") and accept their own credentials (`SetCredential=` fallbacks); f47ee1c's push unit would not have run (release-f47ee1c.md §6) | built, tested (unit-file and startup checks); not installed |
| P2 (v86) | money locations in one ledger; transfers complete only on evidence they are THAT transfer; owner deposits; debit-card holds against the bank's fresh evidence; overdue holds stay reserved; release only on evidence; late settlement booked; disputes; venture per charge; whole-treasury reconciliation; statement import; bank feed service (read-only) | built, tested against a SIMULATED bank and Starling; no account, no token, not installed |
| P3 (v85, v87) | capability checks that name the offer / enquiry and its deliverables (and go stale when a provider or the runtime changes); .pptx deliverable and inspector fleet-qa-2; toolchain agent-tools-2; paid search / images reserved from the agent and charged at actual cost (owed to the owner), statements, unknown-cost resolution | built, tested against SIMULATED providers; no provider key; renderer and OCR not installed |
| Agent runtime | founder-v10 (toolset-6): capabilities, web_search, generate_image, card_awaiting_approval | built; Agent-1's upgrade is a separate step after the controller cutover |
| Library | capability status v11 (checks name the work; paid media; the debit card as built, not connected) | built |

## 2. Identity and rehearsals
```
FLEET_RUNTIME_COMMIT=05cbe4eeb74e8014b9c85553e77c600355ef181a
FLEET_RUNTIME_BUILD_ID=328bf6071fe55b2269df52fbd5b29deb1ad1c552ad468b4c17b6b4d5a2185366   (VPS build = independent local build)
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
UI 0.22.0: ui-0.22.0-05cbe4e.tgz  sha256 46218e6d73c6baba1961e88f5862d5d9539af27501647bf47bf0f03b34284324  (52 files; two clean builds identical)
```
- **Data rehearsal 81 → 87: PASSED** 2026-10-16 21:44:46Z, on a restored copy of production:
  - wouldApply [82 … 87];
  - 812 journals; 2947 events preserved, none purged;
  - the ledger verifies;
  - a re-run is a no-op;
  - rollback restores 81 with the same ledger head;
  - live untouched.
- **Services + rollback rehearsal: PASSED** 2026-10-16 22:17:00Z:
  - a712be1 refuses schema 87;
  - on 87 the candidate controller (all readiness checks, privileges included), Operator API and dashboard are ready;
  - Fleet Command and history are clean: 54 feed rows, no housekeeping, no hidden-permanent events;
  - ledger head unchanged; no reservation or birth;
  - rollback restores 81, and a712be1 is ready again;
  - production PIDs unchanged (1066933 1066959 1077293).
- **Valid until** 2026-10-17 21:44Z. Production has not changed since (a712be1, schema 81).

## 3. Deploy (your go), then host steps (each its own go)
1. `bash ~/rlc87/fleet-release.sh ~/rlc87/pins.txt 81 87 0.22.0 ~/rlc87/ui-0.22.0-05cbe4e.tgz 46218e6d73c6baba1961e88f5862d5d9539af27501647bf47bf0f03b34284324`.
   Rollback before live money: `bash ~/rlc87/fleet-rollout.sh revert ~/rlc87/pins.txt 81 87 <reason>`.
   This replaces deploying bbfb24a or f47ee1c separately (it contains both).
2. Agent-1's runtime upgrade, kept paused. First install the agent toolchain agent-tools-2 (`fleet-agent-tools.sh`; lock
   `8655a172…`). Then `sudo …/fleet-founders.sh upgrade-runtime 01M3F50SH7PNX2E3GST13J52AS`. Agent-2 is not upgraded and
   stays paused.
3. The P1 host steps as in release-f47ee1c.md §3 (edge file, push, monitor, backups), using this release's unit files.
4. When you choose them:
   - the bank feed (`fleet-bankfeed-setup.sh install --apply`, then `set-token`);
   - media (`fleet-media-setup.sh`, the cost settings in media-providers.md);
   - the office renderer and OCR (`fleet-office-tools-setup.sh install --apply`; an OS package install).

## 4. Tests (focused; all passing at 05cbe4e)
| Suite | Result |
|---|---|
| `fleet-v86-locations-pg` (transfers on evidence incl. the negative case, overdue / release / late settlement, disputes, venture, reconciliation, role isolation) | 7/7 |
| `fleet-v86-bankfeed-service-pg`, `fleet-location-feed` (service, read-only scopes, host lock, systemd credentials), `fleet-bank-statement` | 2/2, 6/6, 3/3 |
| `fleet-v87-media-capabilities-pg` (reservation, actual cost, overrun, error, unknown cost, statements, missions; the targeted gate incl. stale fingerprint and runtime change) | 4/4 |
| `fleet-v85-capabilities-pg`, `fleet-v85-founder-tools` | 5/5, 6/6 |
| Regressions: card v51 / v53 / v54, v58, v64, v77, PayPal treasury, v83 push, v76 market + demonstrations, v82 consent, v67 foundation, migration paths, live dashboard contract, static audit, cognition, R41.1 | all passing |
| Dashboard e2e (desktop 17, emulated iPhone 4) | 21/21 |

## 5. Shortfalls are recorded, never funded (checked against the code at 05cbe4e)

**No overdraft, rescue or new spending authority exists in this package.** Every new commitment needs real cash first:
- a card hold reserves from the agent's own cash (or a Fleet-approved envelope), and in debit mode must also fit the bank's
  fresh free cash;
- a media job reserves its maximum from the agent's own cash;
- a refusal is final. Nothing tops a wallet up, nothing lends, and no partition becomes spendable because another is short.

The two cases where actual cost can exceed what was reserved record a liability for money already gone:

| Case | How it is booked | Effect on spending |
|---|---|---|
| **Late or larger card charge** (the bank takes more than the reservation, or presents a charge after a release) | The existing v51 card path: the reservation first, then the agent's remaining cash, then the rest as an **advance**: `agent_provider_payable` C (the agent's debt), `fleet:provider:advances` D, `fleet:treasury:unallocated` C. The bank already paid the merchant; the advance records that the treasury's books carried it. The debt is repaid first from the agent's next receipts | The agent's cash is zero afterwards and every new hold or job needs cash, so the advance grants nothing further. It is alerted (CARD_LATE_SETTLEMENT) and visible as a payable |
| **Media cost above the job's limit** | The agent is charged its reservation, no more. The excess is a Fleet expense owed to you: `fleet:expense` D / `fleet:owner:payable` C, with an AMBER MEDIA_COST_OVERRUN. No cash moves | None: the agent gains no cash or credit, and the provider's real charge is on the books |

**Mismatches with your rules, found while checking (not changed in this candidate):**
1. **An unrecordable shortfall.** If a late or larger card charge exceeds the agent's cash **and** the treasury has no
   unallocated cash, posting the advance raises `FLEET_LEDGER_NEGATIVE`. That cash partition can never go negative. The
   whole bank line is then rejected: not booked, not listed as unexplained. The feed retries and fails every pass, and a
   statement import containing it fails as a whole. Reproduced with a throwaway test on 05cbe4e: zero rows recorded.
   - **Effect:** a real external liability would sit outside the books. This contradicts "actual liabilities must be
     recorded".
   - **Fix (separate branch):** record the line regardless and book the uncovered part to an explicit
     **unfunded-shortfall** liability (owed by the agent, not paid from any partition). Raise a RED alert and freeze the
     agent's card until you decide. Which partition, if any, finally carries it is your decision.
   - **The same limit exists in the credit-card path since v51:** the advance needs unallocated cash there too.
2. **Media overrun is borne by the Fleet.** Your rule is that agent-benefiting work is paid by the agent; the excess here
   is a Fleet expense. The alternative is charging the excess to the agent as a debt, like the card advance. Both record
   the real cost; the choice is yours.
3. **Software maintenance is not unavailable today.** Capability status says its prerequisites are not built, but the
   reading library still lists "software fixes and maintenance" among the digital services agents may offer, and no
   gate stops a service offer for it. Making it unsellable until its prerequisites exist needs a library correction and
   a capability-check gate (separate branch).

## 6. One remaining-work list

**Implementation gaps (code; a separate branch, rehearsed on its own):**
1. Unfunded card shortfall recorded and frozen, never rejected (§5.1). It affects the debit and credit card paths.
2. Software maintenance unavailable to sell until its prerequisites exist (§5.3). The prerequisites themselves are not
   built:
   - a scoped repository grant;
   - a build sandbox.
3. Several cards, one per bank or card account (R9). Today one card binds to one bank location.
4. A provisional chargeback credit that the bank reverses later: not modelled. The reversal appears as an unexplained
   bank line, and the dispute stays "won".
5. Support burden and AI cost per order and venture. AI cost is attributed per agent only, and support time per order is
   not measured.
6. A PayPal limitation signal (you mark the PayPal location limited; PayPal gives no API signal).
7. If you choose it: media overrun charged to the agent (§5.2).

**Host installation (each your go; sudo):**
1. The release itself (`fleet-release.sh`, 81 → 87 + UI 0.22.0).
2. Agent toolchain agent-tools-2, then Agent-1's runtime upgrade (paused).
3. Edge file.
4. Push unit (this release's file, not f47ee1c's).
5. Heartbeat and `OnFailure`. Install the secret files first: these units fail loudly without them.
6. restic and the backup / drill timers.
7. Bank feed.
8. Media gateway.
9. Office renderer and OCR (OS packages).

**Provider onboarding (your accounts; no purchase is authorised here):**
1. Pushover.
2. Healthchecks.io and UptimeRobot.
3. Backblaze B2 (EU, Object Lock), plus the restic escrow password.
4. Your bank account (subject to seller eligibility), a read-only token, and who approves 3-D Secure.
5. Brave Search and OpenAI Images, with their cost settings.
6. The legal seller and public site (from earlier packages).
7. Money out (custody execution), for refunds.

**Live proof (in order; Agent-1 only, Agent-2 stays paused):**
1. The dashboard on your phone.
2. A push you confirm received.
3. The monitor rings when the heartbeat stops.
4. A production backup and drill.
5. Agent-1's controlled proof: preparation, purchase (≤ £50), delivery, support, refund.
6. A spending proof with an amount and purpose you name.
7. The bank rail:
   - a transfer matched on evidence;
   - a 3-D Secure purchase;
   - a decline;
   - a refund;
   - zero drift in the whole-treasury reconciliation.
8. One paid search and one image charged at actual cost, then a statement that reconciles.

## 7. Not proven (be exact)
- **Simulated only:** no bank account, bank token, search or image key, or Pushover key exists. Every provider path ran
  against a simulated provider.
- **Statement imports only are not autonomous:** until the bank feed is connected, debit-card purchases book only when you
  import a statement.
- **Not installed:** the renderer and OCR (the check reports them as not installed).
- **Still open:** §6 (the one list).
