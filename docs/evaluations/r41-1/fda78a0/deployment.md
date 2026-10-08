# R41.1 `fda78a0` — production deployment (2026-10-08)

Run by the owner on the VPS, stage by stage. Each stage was checked read-only (Operator API, VPS files and logs) before
the next. Live money, owner sweeps, replication, the dry-run child, the cap (2) and the mode (DEVELOPMENT) were never
touched, and were confirmed unchanged after every stage.

## Status

| | Controller | Agent 2 (`01M4C4NXT786Q4E9725N5A15KV`) | Founder 1 (`01M3F50SH7PNX2E3GST13J52AS`) |
|---|---|---|---|
| Code complete | yes | yes | yes |
| Rehearsed | yes (production copy, 45→45) | yes (on-host, from `136c4bd`) | yes (on-host, from `94f09a7`) |
| Deployed | **yes**, 10:53Z | **yes**, 11:30Z (from `136c4bd`) | **yes**, 11:42Z (from `94f09a7`) |
| Behaviourally verified | yes (below) | **partly**; see the table below | **partly**; see the table below |

Observed live, by behaviour:

| Behaviour | Agent 2 | Founder 1 |
|---|---|---|
| Served doctrine founder-v5 (no `FLEET_DOCTRINE_INCOMPATIBLE`) | **verified live** | **verified live** |
| Routed turns charged to its own ledger account | **verified live** (4 turns, 11¢) | **verified live** (1 turn, 5¢) |
| Tool execution, 0 refusals | **verified live**: `sleep` ×4, `browser` ×2 | **verified live**: `sleep` ×1 |
| The brokered `browser` tool through the isolated worker | **verified live** (2 calls ok) | not used yet |
| Declared hibernation (`wakeOn` + persisted `reviewAt`) | **verified live** | **verified live** |
| Scheduled slim wake (idle backoff, state unchanged), then re-hibernation | **verified live** (11:34Z → 11:37Z; again by 11:51Z) | **verified live** (3 slim wakes by 11:52:59Z) |
| Event-triggered full wake (a meaningful change produces the full packet) | **not observed live**: rehearsal- and test-proven | **not observed live**: rehearsal- and test-proven |
| `field_guide` / `field_journal` use | not used yet | not used yet |
| Journal persistence (`field-journal.jsonl` written and kept across turns) | **open**: test- and rehearsal-proven, awaiting live verification | **open**: the same |
| Identity, credential, memory, workspace, ledger preserved through the upgrade | **verified live** | **verified live** |

- **Two kinds of wake.**
  - The scheduled slim wake is the idle backoff. After a sleep-only turn, the founder skips 1, 2, 4 … up to 32
    thinking slots. If nothing it watches has changed, the next turn gets the slim packet.
  - An event-triggered full wake happens when a meaningful change is detected: memory, workspace, economy,
    capabilities or dependency status, a sale, or a due review. The founder then gets the full packet.
  - Only the first has been seen live (Agent 2).
- **Event detection is not immediate.** The existing idle skip (`MAX_IDLE_SKIP` = 32 slots) predates R41.1 and was not
  changed by it. At the current cadence a slot is 60 s (30 s heartbeat × `FLEET_FOUNDER_THINK_EVERY=2`), so an event
  can wait up to about 32 minutes before the next thinking slot runs. The event is then seen and gets the full packet:
  it is delayed, never suppressed. Detection guarantees a full packet; it does not guarantee immediate delivery.
- **Journal persistence** is proven by tests (`fleet-r41-1-continuation.test.ts`: window, archive, index, `lessons`/`resolve`)
  and by both on-host rehearsals. In each rehearsal an entry was written and kept byte for byte
  through a rollback and a second upgrade. It is awaiting live verification: neither founder has chosen to journal.
  Study, journaling and hibernation are the agents' own decisions. No entry is forced, no activity quota is imposed,
  and voluntary waiting is not treated as a defect. Live verification comes from legitimate activity. The owner
  upgraded Founder 1 without waiting for it.

## 1. Controller cutover (10:52:36–10:53:37Z)

`fleet-rollout.sh cutover ~/r411-pins.txt 45 45`:
- verified build `451c91a8…` installed;
- outage 10:53:19–10:53:37Z (18 s);
- pre-cutover dump `~/automaton_fleet-v45-pre-v45-20261008T105319Z.dump` (sha `a865b6a26ca4a66c`);
- migrate-check: nothing to apply (45→45);
- reconciliation OK: 724 events before, 724 preserved.

Operator API afterwards:
- the approved, pinned and Operator API release is `fda78a0`, build `451c91a8…`, schema 45, readiness all ok;
- both founders were still alive on their own runtimes and heartbeating.

Rollback point: `/etc/automaton-fleet/runtime.env.pre-fda78a0`, `releases/136c4bd`, the dump above.

The first attempt sent from Claude Code's `!` prompt never ran: `ssh -t` with `sudo` needs a real terminal. Nothing
changed. All later stages were run from the owner's own terminal.

## 2. Browser worker (10:56Z)

`fleet-browser-setup.sh install --zip ~/r411/chs.zip`, first as a plan, then with `--apply`:
- 40 apt packages installed;
- zip sha256 verified; Chrome for Testing headless shell 153.0.8010.12 found every library it needs;
- user `automaton-fleet-browser` (uid 983) created, in its own group only;
- `fleet_browser(_login)` roles created and `bx_*` granted;
- `browser.env` written, root:automaton-fleet-browser 0640;
- unit enabled; `browser_selftest_ok` seen;
- `fleet:audit-privileges` passed. It covers the browser roles once provisioned (`privileges.ts:157-188`).

`check`: every line present.

Read-only observation:
- the worker runs as `automaton-fleet-browser` with no supplementary groups, pinned binary, `NRestarts=0`;
- the controller, Operator API, identity service and dashboard stayed active.

Host note: the VPS has a pending kernel (6.8.0-142; it runs 6.8.0-136). Do not reboot during this rollout.

## 3. On-host upgrade rehearsals (11:03–11:20Z)

`fleet-founders.sh upgrade-rehearsal` from `136c4bd` and from `94f09a7`: **both `"pass": true`, 27/27 checks.**

Coverage:
- refused unapproved target;
- aborted on state change;
- fail-closed mis-pin with automatic rollback;
- same founder (id, Genesis, credential, ledger);
- byte-identical state;
- the routed tiers;
- **v5 served (9 v5 / 0 v4 steps), `field_guide` + `field_journal` run, a journal entry written, a wake condition declared**;
- **rollback after v5 use keeps the journal, goals and memory byte for byte, then upgrade again**;
- no credential in any record.

Production before = after on both runs: population 2, cap 2, ledger head 653, Genesis off. Both living founders kept
their pids.

## 4. Agent 2 upgrade (11:30:28Z) — upgrade `ec8c3804-4b58-41ea-90ab-cf7a7f4ff3fb`

Baseline (`upgrade-status`, `memory-report`, 11:29Z):
- on `136c4bd`, no upgrades yet;
- 1 current fact, 1 superseded, fact store parses ok.

Preflight: `preflight_ok`, 13 state files.

`upgrade-runtime`: **verified**; pid 603677 → 638935, same uid 62577; downtime 1915 ms; 1 challenge passed.

| | Before = after |
|---|---|
| identity | `c9f0bf7e…` |
| credential | `076be6eb…` |
| state | `07592794…`, 13 files; diff identical, 0 lost / changed / added |
| ledger | cash 9876, expense 124, 64 journals, last seq 654 |

## 5. Agent 2 live verification (`agent-live-check.py`, read-only; two runs, 11:3xZ)

| Requirement | Result |
|---|---|
| v5 delivery | **Proven.** It called `sleep` with `wakeOn` and `reviewAt`. Those arguments exist only in the founder-v5 `sleep` (`types.ts:446`; v4 `:242` has `reason` only), which the controller offers only when serving founder-v5 (`toolsForDoctrine`, `types.ts:452`). Controller log: 0 `FLEET_DOCTRINE_INCOMPATIBLE`; founder log: 0 errors. |
| Tool execution | **Proven.** 4 routed turns, 6 tool calls (`sleep` ×4, `browser` ×2), 0 refusals, 11¢ charged. The two `browser` calls are the first live use of the newly classified, brokered tool. |
| Journal persistence | **Open**: test- and rehearsal-proven, awaiting live verification. No `field-journal.jsonl`: the founder has not chosen to journal. |
| Hibernation / waking | **Hibernation and a scheduled slim wake verified live.** It hibernated at 11:34:12Z (wake condition declared, review 2026-10-15), woke at its idle-backoff slot at 11:37:15Z on the slim packet (state unchanged; 1¢), and hibernated again (review 2026-10-15T12:00Z). **An event-triggered full wake has not been observed live.** |
| Identity, memory, accounting | **Preserved.** `founder.json`, the 4 memory files and the 5 workspace files are unchanged since 2026-10-07 (byte-identical at the upgrade). Charges post to the same ledger account (`ledger_journal_posted` 11:31Z, 11:32Z, 11:37Z, 11:42Z). |

## 6. Founder 1 upgrade (11:42:19Z) — upgrade `c5938bf8-272a-4648-b205-1b57e95fc331`

Baseline (11:39Z):
- on `94f09a7` with 8 earlier verified upgrades, all keeping identity `d8a8beb4…`;
- 14 facts in the legacy format (no `facts-ledger.json`, as in the R27 observation baseline);
- `facts.ts` is identical in `94f09a7` and `fda78a0`.

Preflight: `preflight_ok`, 26 state files.

`upgrade-runtime`: **verified**; pid 563415 → 640162, same uid 65037; downtime 1875 ms; 1 challenge passed.

| | Before = after |
|---|---|
| identity | `d8a8beb4…` |
| credential | `f25654ba…` |
| state | `854bee38…`, 26 files; diff identical, 0 lost / changed / added |
| ledger | cash 8977, expense 1023, 552 journals, last seq 655 |

Live check (since 11:42:19Z):

| Requirement | Result |
|---|---|
| v5 delivery | **Proven**, the same way: `sleep` with `wakeOn` + `reviewAt` (2026-10-10T09:00Z). 0 doctrine refusals, 0 errors. |
| Tool execution | 1 routed turn, 1 tool call (`sleep`), 0 refusals, 5¢. |
| Journal persistence | Not yet live (see above). |
| Hibernation / waking | Hibernation declared (wake condition + review 2026-10-10T09:00Z); no wake of either kind observed yet at check time. |
| Identity, memory, accounting | **Preserved.** `founder.json` (2026-09-26), `facts.json` (2026-09-30), `goals.json`, `mind-history.json` and all 19 workspace files keep their dates. The ledger is identical at the upgrade, and the first charge (11:42:53Z) posts to the same account. |

## Operational review (read-only, 11:49–11:55Z)

**Health.** Both agents and the controller are on `fda78a0` (build `451c91a8…`); approved = pinned = Operator API release.
Heartbeats were 15–25 s old. These services are active with 0 restarts: controller, Operator API, dashboard, identity,
custody, fetcher, browser worker, and both founders. No failed units. Schema 45, cap 2, DEVELOPMENT, all four safety
flags false.

**What each founder is waiting for.** Source: `agent-wait-review.py` (this directory; read-only DB transaction plus
state files). Agent-written text is quoted as data.

| | Founder 1 | Agent 2 |
|---|---|---|
| Open goal | g1 "Identify one low-capital digital product with demand evidence and a sales channel the owner can enable" | g1 "Execute first-niche: build the template … and create a marketplace account" |
| Venture | `landlord-compliance-tracker`, selected, channel `gumroad` | `uk-sa-template`, selected, channel `storefront` |
| Dependency | `62cbe1b7` kyc, **pending since 2026-09-26**: list the tracker on Gumroad (seller account needs a human identity/KYC) | `6178c7bb` kyc, **pending since 2026-10-07**: open a Gumroad storefront (rail requirement `storefront`/`gumroad` in status `dependency`) |
| Declared wake | "Gumroad dependency resolved or owner reply" | "external dependency 6178c7bb resolved" |
| Review time | 2026-10-10T09:00Z | 2026-10-15T12:00Z |
| Review time persisted | yes: `mind-continuity.json`, re-read every turn and after a restart | yes, the same |
| Goal-level v5 marks (`blockedBy`/`awaiting`/`reviewAt`) | none (goal predates v5) | none |

**Findings.**
- **No resolved dependency is leaving either founder stuck.** Both dependencies are still pending owner decisions,
  and both declared wake conditions name exactly those dependencies. A dependency status change is part of the wake
  digest (`mind.ts:473`, `dep:<id>:<status>`), so a decision produces a full packet at the founder's next thinking slot (up to about 32 minutes later; see
  above).
- **Concrete operational blocker: there is no payment rail.** `fleet_payment_rails` is empty fleet-wide, and the
  only sales channel either founder has chosen needs a Gumroad seller account behind owner KYC. Every revenue path
  therefore waits on an owner action. The founders' waiting is their own, reasoned judgement and not a defect:
  dependencies scope only the one action, and both founders still have research, `browser`, `fleet_services` and
  workspace tools.
- **Not unnecessarily blocked by the system.** No capability demand or refusal is outstanding, there are no payment
  orders, and no tool was refused after the upgrade.
- Neither founder has used the v5 goal marks or the journal yet. That is their choice, and nothing here prompts it.
- The owner requests `62cbe1b7` and `6178c7bb` were **not answered or altered** by this review.

## Final fleet state (Operator API, after stage 6)

- Controller: approved = pinned = Operator API release = `fda78a0` (build `451c91a8…`), schema 45, readiness ok.
- Agents: Founder 1 and Agent 2 both on `fda78a0`.
- Registry: cap 2, living 2, DEVELOPMENT, replication off.
- `REAL_PAYMENTS_ENABLED`, `OWNER_SWEEP_ENABLED`, `REAL_REPLICATION_ENABLED`, `FLEET_DRY_RUN_CHILD`: false.
- Mail/SMS: dormant.

## Test suites (unchanged by deployment; NOT fully green)

- `pnpm test:security`: 1379 pass / **1 fail**.
- `pnpm test:financial`: 753 pass / **1 fail**.

Both failures predate this work and have the same cause: the F2 static audit and F2-A v27 (cases 1, 2, 5) flag the
R39 `payment_order_awaiting_owner` event.

## Rollback (unchanged; see README)

- A founder:
  - `sudo scripts/fleet-founders.sh rollback-runtime 01M4C4NXT786Q4E9725N5A15KV ec8c3804-4b58-41ea-90ab-cf7a7f4ff3fb <reason>`
  - `sudo scripts/fleet-founders.sh rollback-runtime 01M3F50SH7PNX2E3GST13J52AS c5938bf8-272a-4648-b205-1b57e95fc331 <reason>`
- The controller, in this order:
  1. both founders first;
  2. `sudo systemctl disable --now automaton-fleet-browser`;
  3. `bash scripts/fleet-rollout.sh revert ~/r411-pins.txt 45 45 <reason>`. This is code-only: no database restore, and
     every post-cutover write is reconciled.

## Follow-up

- Observe, do not provoke: re-run the live check when legitimate activity supplies the evidence (an event wake or a
  first journal entry):
  `sudo python3 ~/agent-live-check.py <agentId> "<since>"`. The script is in this directory, sha256 `216634a7…`.
  When `field-journal.jsonl` appears and survives later turns, mark journal persistence verified.
- Reboot for the pending kernel at a quiet time, then confirm all units return (founders, browser, controller).
